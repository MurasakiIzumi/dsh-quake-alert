// ============================================================================
// dsh-quake-alert · client/src/12e-overseas-poll.js — 海外气象源（美国 NWS / 加拿大 ECCC）的取数器：
// 按关注点查询外部 REST，逐条交给解析契约，命中门槛的交给主链；每轮读一次配置、串行请求，
// `staleAfterMs` 为 null 故不判停更。依赖 02-storage、03-settings-bridge、05d、05g、07-store、11-pipeline。
// ============================================================================

import { t } from './00-i18n.js'
import { currentCfg } from './03-settings-bridge.js'
import { parseNwsAlertResult, parseEcccAlertResult, failResult } from './05d-source-contracts.js'
import { noteParseResult, noteSourceSuccess, noteFreshness, effectiveStatusOf } from './05g-source-health.js'
import { NWS_EVENT_WHITELIST, OVERSEAS_BROADCAST_MIN_RANK } from './05h-overseas-parsers.js'
import { store } from './07-store.js'
import { handleAlert } from './11-pipeline.js'

/** NWS 的洪水类查询端点（全量 `/alerts/active` 1.67MB 不可用）。 */
export const NWS_ALERTS_BASE = 'https://api.weather.gov/alerts/active'
/** ECCC 的预警集合（OGC API - Features）。 */
export const ECCC_ALERTS_BASE = 'https://api.weather.gc.ca/collections/weather-alerts/items'
/**
 * NWS 的 `?event=` 白名单参数——从 05h 的白名单派生（同一个集合）。它是发给上游的服务端过滤：
 * 漏同步不会报错，只是那一类永远不返回（静默漏报）。
 */
export const NWS_EVENT_QUERY = Object.keys(NWS_EVENT_WHITELIST).join(',')

export const NWS_POLL_MS = 120 * 1000
export const ECCC_POLL_MS = 300 * 1000
/** 首轮延迟：错开启动窗口，也让设置页先渲染出来。 */
export const OVERSEAS_FIRST_DELAY_MS = 4000
/** 单次请求超时（Client 侧统一 10 秒）。 */
export const OVERSEAS_TIMEOUT_MS = 10 * 1000
/** 单次响应体上限。ECCC 的 bbox 查询在预警密集时实测可到 200KB（几何 + 双语正文）。 */
export const OVERSEAS_MAX_BODY_CHARS = 512 * 1024
/** 半径小于它时只查中心点：NWS 的县通常比它大，采样点会落进同一个县，白花请求。 */
export const MIN_SAMPLE_RADIUS_KM = 25
/** 每轮请求数上限：20 个关注点 × 5 个采样点 = 100，串行跑完会超过一轮的间隔。 */
export const MAX_REQUESTS_PER_ROUND = 40
/** 时效门槛：首轮（或距上次成功超过 GATE_RESET）时，只播报发布在这么久以内的条目。 */
export const OVERSEAS_FRESH_GATE_MS = 6 * 60 * 60 * 1000
/** 距上次成功超过这么久，就重新按"首轮"处理（页面休眠恢复后不该把几小时前的当新警报）。 */
export const OVERSEAS_GATE_RESET_MS = 30 * 60 * 1000
/**
 * HTTP 400 之后的冷却期：冷却期内跳过该 URL，到期自动重试一次（400 也可能是我们的参数被上游拒绝）。
 */
export const UNCOVERED_TTL_MS = 60 * 60 * 1000
/** 整轮全部失败时，重试间隔逐次延长的起点与上限。 */
export const OVERSEAS_MIN_BACKOFF_MS = 1000
export const OVERSEAS_MAX_BACKOFF_MS = 60 * 1000

/**
 * 海外源的计数快照（供设置页的状态区块与诊断快照读取）：轮次 / 请求数 / 未覆盖 / 时效门槛。
 */
export const overseasStatsOf = {}

/** 覆盖范围包围盒：盒外的关注点不产生请求。NWS 对覆盖外的点回 400，由 pollOnce 的 `uncovered`
 *  分类捕获；盒内重叠（美加边境）会让同一个点查两个源。含波多黎各与美属维尔京群岛、关岛与
 *  北马里亚纳、美属萨摩亚（都是 NWS 的正式预报区）。 */
const US_BOXES = [
  { minLat: 24, maxLat: 50, minLon: -125, maxLon: -66 }, // 本土
  { minLat: 51, maxLat: 72, minLon: -170, maxLon: -129 }, // 阿拉斯加
  { minLat: 18, maxLat: 23, minLon: -161, maxLon: -154 }, // 夏威夷
  { minLat: 17, maxLat: 19, minLon: -68, maxLon: -64 }, // 波多黎各 / 美属维尔京群岛
  { minLat: 13, maxLat: 21, minLon: 144, maxLon: 146 }, // 关岛 / 北马里亚纳
  { minLat: -15, maxLat: -13, minLon: -171, maxLon: -169 }, // 美属萨摩亚
]
const CA_BOX = { minLat: 41, maxLat: 84, minLon: -141, maxLon: -52 }

/** 1 纬度的公里数（地球平均半径口径，与 06-matcher 的 distanceKm 同一量级即可）。 */
const KM_PER_DEG = 111

const inBox = (p, b) => p.lat >= b.minLat && p.lat <= b.maxLat && p.lon >= b.minLon && p.lon <= b.maxLon

/** 关注点里落在给定包围盒内的那些（配置不合法的一律跳过，不猜）。 */
function placesInBoxes(cfg, boxes) {
  const out = []
  for (const p of ((cfg.watch || {}).places || [])) {
    if (!p || typeof p.lat !== 'number' || typeof p.lon !== 'number') continue
    if (!Number.isFinite(p.lat) || !Number.isFinite(p.lon)) continue
    if (boxes.some((b) => inBox(p, b))) out.push(p)
  }
  return out
}

/** 经度方向的度数：高纬度处同样的公里数对应更多经度，除以 cos 是必须的（否则 bbox 会偏窄）。 */
function lonDegreesOf(km, lat) {
  const c = Math.cos((Math.max(-89.9, Math.min(89.9, lat)) * Math.PI) / 180)
  return km / (KM_PER_DEG * Math.max(0.05, c))
}

// 采样点 / bbox 的坐标夹取：半径 2000km 时高纬度的方位点会算出 `lon < -180`，那样的 URL 会被上游回 400。
const clampLat = (v) => Math.max(-90, Math.min(90, v))
const clampLon = (v) => Math.max(-180, Math.min(180, v))

/** ECCC 的 bbox：坐标 ± 半径（经度按纬度修正）。NWS 不支持 bbox，只按点查（`?point=`）。 */
export function ecccBboxOf(place) {
  const dLat = Number(place.radiusKm || 0) / KM_PER_DEG
  const dLon = lonDegreesOf(Number(place.radiusKm || 0), place.lat)
  const f = (n) => Number(n.toFixed(4))
  return [
    f(clampLon(place.lon - dLon)), f(clampLat(place.lat - dLat)),
    f(clampLon(place.lon + dLon)), f(clampLat(place.lat + dLat)),
  ].join(',')
}

/** NWS 的采样点：中心 + （半径够大时）四个方位。返回 `[lat, lon]` 数组。 */
export function nwsSamplePoints(place) {
  const pts = [[place.lat, place.lon]]
  const r = Number(place.radiusKm || 0)
  if (!(r >= MIN_SAMPLE_RADIUS_KM)) return pts
  const dLat = r / KM_PER_DEG
  const dLon = lonDegreesOf(r, place.lat)
  pts.push([clampLat(place.lat + dLat), place.lon])
  pts.push([clampLat(place.lat - dLat), place.lon])
  pts.push([place.lat, clampLon(place.lon + dLon)])
  pts.push([place.lat, clampLon(place.lon - dLon)])
  return pts
}

/** 默认取数：Node / 浏览器通用的 fetch，带超时与 Accept。 */
async function defaultFetchText(url, ctx) {
  const signal = ctx && ctx.signal
  const timeoutMs = ctx && typeof ctx.timeoutMs === 'number' ? ctx.timeoutMs : OVERSEAS_TIMEOUT_MS
  const work = (async () => {
    const res = await fetch(url, { signal, headers: { Accept: 'application/json' } })
    if (!res.ok) {
      // 带上状态码：NWS 对覆盖范围之外的坐标返回 400，那与"网络不通"是两回事（见 pollOnce）。
      const err = new Error('HTTP ' + res.status)
      err.status = res.status
      // 400 的响应体自带原因（NWS 是 `Invalid Parameter` + parameterErrors），只留给诊断、不参与判据。
      if (res.status === 400) {
        try { err.bodyHint = String(await res.text()).slice(0, 160) } catch (e) { /* 读不到就算了 */ }
      }
      throw err
    }
    // 按流读取并在超限处立刻停：`await res.text()` 之后才比长度时整个响应体已进内存，上限只
    // 保护了后续 JSON.parse 的代价。比的是字符数，而流按字节计——取字节数偏保守（宁可早停）。
    const stream = res.body
    const dec = typeof TextDecoder !== 'undefined' ? new TextDecoder('utf-8') : null
    // 没有 TextDecoder 就只能 `String(chunk)`（字节数组的逗号串），解出来一定是坏 JSON，故退化。
    if (dec && stream && typeof stream.getReader === 'function') {
      const reader = stream.getReader()
      let out = ''
      let total = 0
      try {
        for (;;) {
          const step = await reader.read()
          if (!step || step.done) break
          const chunk = step.value
          total += chunk && typeof chunk.byteLength === 'number' ? chunk.byteLength : 0
          if (total > OVERSEAS_MAX_BODY_CHARS) {
            try { await reader.cancel() } catch (e) { /* 取消失败不影响判定 */ }
            throw new Error('body too large (' + total + ' > ' + OVERSEAS_MAX_BODY_CHARS + ' bytes)')
          }
          out += dec.decode(chunk, { stream: true })
        }
        out += dec.decode()
      } finally {
        try { reader.releaseLock() } catch (e) { /* 已释放 */ }
      }
      return out
    }
    return await res.text()
  })()
  if (signal) return await work
  // 没有 AbortController 时用 Promise.race 实现超时保护：否则单次请求可以永久挂住，下一轮不再排，
  // 整条轮询链静默停摆、状态还保持绿色。
  return await Promise.race([
    work,
    new Promise((_, reject) => {
      setTimeout(() => reject(new Error(t('source.noAbortController'))), timeoutMs)
    }),
  ])
}

/**
 * 通用海外取数器，与 12b 的 createFeedClient 接口同形（start / stop / pollOnce / pollSerial / stats）。
 * @param {object} opts 另有 id / label / intervalMs / firstDelayMs / enabled / getCfg / placesFor(cfg)
 *   -> place[]（该国关注点）/ urlsFor(place, cfg) -> string[]（该点的查询 URL，NWS 多个采样点、
 *   ECCC 一个 bbox）/ parseOne(feature, place) -> result / onStatus(patch) / onError(err) / fetchText(url, ctx)
 */
export function createOverseasSource(opts = {}) {
  const id = opts.id || 'overseas'
  const label = opts.label || id
  const regionText = opts.regionText || ''
  const intervalMs = opts.intervalMs || NWS_POLL_MS
  const firstDelayMs = opts.firstDelayMs === undefined ? OVERSEAS_FIRST_DELAY_MS : opts.firstDelayMs
  const getCfg = opts.getCfg || currentCfg
  const fetchText = opts.fetchText || defaultFetchText
  const onError = opts.onError || (() => {})
  const onStatus = opts.onStatus || (() => {})
  const enabled = opts.enabled || ((cfg) => (cfg.disasters || {}).overseasWeather !== false)
  const placesFor = opts.placesFor || (() => [])
  const urlsFor = opts.urlsFor || (() => [])
  const parseOne = opts.parseOne || (() => ({ ok: false, kind: 'schema', detail: 'no parser configured' }))
  // 超时与 400 冷却期时长可注入，便于回归测试在毫秒级验这两条路径（`NaN` 也是 number 而
  // `setTimeout(fn, NaN)` 会立即触发，故用 Number.isFinite 判）。
  const timeoutMs = Number.isFinite(opts.timeoutMs) ? opts.timeoutMs : OVERSEAS_TIMEOUT_MS
  const uncoveredTtlMs = Number.isFinite(opts.uncoveredTtlMs) ? opts.uncoveredTtlMs : UNCOVERED_TTL_MS
  // 交给主链的出口可注入：默认是 11-pipeline 的 handleAlert，测试注入 spy 后只验取数器交出了什么。
  const onAlert = opts.onAlert || handleAlert

  let timer = null
  let running = false
  let stopped = false
  let inFlight = null
  let abortCtl = null
  let lastStatusKey = ''
  let lastSuccessAt = 0
  let lastError = ''
  /** 时效门槛上一轮是否处于激活状态（用于"只在进入时计数"，见 pollOnce 里的 gated）。 */
  let gateActive = false
  /** 整轮全部失败时的重试间隔递增量（0 = 不递增，用正常间隔）。 */
  let backoffMs = 0
  const stats = {
    polls: 0, requests: 0, received: 0, applied: 0, errors: 0,
    ageSkipped: 0, throttledLast: 0, throttledTotal: 0, gated: 0, rejected: 0,
    truncated: 0, lastAt: 0, lastDataAt: 0,
  }
  // 会话内记住"这些 URL 暂时别查"（键 = URL，值 = 可以再试的时刻），到期自动重试一次。
  const uncovered = new Map()

  /** 状态上报：只在变化时送出；除自己上一轮的值，还比 store 里的当前值（自检 / 健康层也写同一个源）。 */
  function reportStatus(patch) {
    const eff = effectiveStatusOf(id, patch.status, patch.detail)
    const cur = ((store.sources || {})[id] || {})
    // 去重键 = status + detail：只比 status 会让"同一状态下的语义变化"永远推不出去；代价是
    // detail 里不能放单调计数（那会让每轮都判为变化、整页重渲），计数由 13-ui 直接读 stats。
    const key = eff.status + '|' + String(eff.detail || '')
    if (key === lastStatusKey && cur.status === eff.status && String(cur.detail || '') === String(eff.detail || '')) return
    lastStatusKey = key
    // 与 12b 同形：由调用方（15-entry 的 feedStatus）统一写入，本模块不直接写 store（否则一轮 publish 两次）。
    try { onStatus(Object.assign({ label }, eff)) } catch (err) { /* UI 回调异常不影响轮询 */ }
  }

  async function pollOnce() {
    if (stopped) return { applied: 0, aborted: true }
    const cfg = getCfg()
    stats.lastAt = Date.now()
    if (!enabled(cfg)) {
      reportStatus({ status: 'disabled', detail: t('source.overseasDisabled') })
      return { applied: 0, disabled: true }
    }
    const places = placesFor(cfg)
    if (places.length === 0) {
      // 与坐标型源同一条原则（06-matcher 的 noWatch）：不静默——"配错了关注点"看起来像"根本
      // 没有预警"。这里不产生任何网络请求。是"配置里没有点"还是"有点但都在覆盖盒外"必须分开说。
      const anyPlaces = ((cfg.watch || {}).places || []).length > 0
      reportStatus({
        status: 'open',
        detail: (anyPlaces
          ? t('source.overseasNoneInCoverage', { region: regionText })
          : t('source.overseasNoPlaces', { region: regionText })) +
          t('source.settingsHint'),
      })
      return { applied: 0, noPlaces: true }
    }
    // 请求清单：先保证每个关注点都被查一次，再补采样点——按顺序平铺后整段截断会让排在后面的
    // 关注点每轮都被截断、永远查不到（静默漏报）。每个关注点的第一个 URL 无条件排上，剩下的
    // 额度才补方位采样点；真超出时 `skippedPlaces` 如实计数。
    const now = Date.now()
    // 暂时被上游拒绝的 URL 先跳过（TTL 到期后会自动重试一次，见下面 400 分支）
    const groups = places
      .map((p) => ({ place: p, urls: (urlsFor(p, cfg) || []).filter((u) => !(uncovered.get(u) > now)) }))
      .filter((g) => Array.isArray(g.urls) && g.urls.length > 0)
    const reqs = []
    for (const g of groups) reqs.push({ place: g.place, url: g.urls[0] })
    const coreCount = reqs.length
    // 补方位采样点的起点按轮次轮转：固定顺序会让排在后面的关注点每轮都只拿到中心点，等效半径退化成"那一个县"。
    const offset = groups.length > 0 ? (stats.polls % groups.length) : 0
    const rotated = groups.slice(offset).concat(groups.slice(0, offset))
    for (const g of rotated) {
      for (let i = 1; i < g.urls.length; i += 1) {
        if (reqs.length >= MAX_REQUESTS_PER_ROUND) break
        reqs.push({ place: g.place, url: g.urls[i] })
      }
      if (reqs.length >= MAX_REQUESTS_PER_ROUND) break
    }
    const capped = reqs.slice(0, MAX_REQUESTS_PER_ROUND)
    // 被截断的采样点数要按"本该有多少"算：补采样点时已 break 在上限上，剩下的没进 reqs。
    const wantSamples = groups.reduce((n, g) => n + Math.max(0, g.urls.length - 1), 0)
    const gotSamples = Math.max(0, capped.length - Math.min(coreCount, capped.length))
    const skippedPlaces = Math.max(0, coreCount - capped.length)
    const skippedSamples = Math.max(0, wantSamples - gotSamples)
    // `Last` 是本轮值（设置页看当下）、`Total` 是累计值（诊断里看趋势），两个计数分开。
    stats.throttledLast = skippedPlaces + skippedSamples
    stats.throttledTotal += stats.throttledLast

    // 时效门槛：首轮或"距上次成功超过 30 分钟"（页面休眠恢复）时，只把发布在 6 小时以内的当新警报。
    const gated = (now - lastSuccessAt) > OVERSEAS_GATE_RESET_MS
    // 只在进入门槛的那一刻计数：源持续不可达时 lastSuccessAt 一直不更新，否则每轮都会 +1。
    if (gated && !gateActive) stats.gated += 1
    gateActive = gated

    stats.polls += 1
    stats.requests += capped.length
    let okCount = 0
    let failCount = 0
    let applied = 0
    /** 本轮**逐条**解析失败数：它不进 `failCount`（那个只在请求级 catch 里加），轮末清蓝点必须看它，
     *  否则"一个响应里坏一条、其余正常"会被当成整轮健康。 */
    let itemFails = 0
    let rejectedNow = 0
    let newestDataAt = 0
    /** 本轮有多少个响应被 ECCC 的分页上限截断（轮末汇总成 stats.truncated，见下）。 */
    let truncatedNow = 0
    // 同一条预警可能被多个采样点查到（中心点与方位点落进同一个县）→ 一轮内只处理一次。
    const seen = new Set()
    for (const item of capped) {
      if (stopped) break
      // 超时标记：`AbortController.abort()` 的错误与"用户停用插件"在 fetch 层完全同形，只靠 `stopped` 区分不了。
      let timedOut = false
      abortCtl = typeof AbortController === 'function' ? new AbortController() : null
      const timerId = abortCtl
        ? setTimeout(() => { timedOut = true; try { abortCtl.abort() } catch (e) {} }, timeoutMs)
        : null
      try {
        const text = await fetchText(item.url, {
          signal: abortCtl ? abortCtl.signal : undefined,
          timeoutMs,
        })
        if (typeof text !== 'string') throw new Error('fetcher returned non-text')
        if (text.length > OVERSEAS_MAX_BODY_CHARS) {
          throw new Error('body too large (' + text.length + ' > ' + OVERSEAS_MAX_BODY_CHARS + ' chars)')
        }
        let json = null
        try {
          json = JSON.parse(text)
        } catch (err) {
          // HTTP 200 却不是 JSON（拦截页 / 上游改版）按 schema 上报，不按链路故障（否则同一份证据两个六态）。
          noteParseResult(id, failResult('schema', 'response is not JSON (blocked page or upstream change?)'))
          throw new Error('response is not JSON (blocked page or upstream change?)')
        }
        const feats = json && Array.isArray(json.features) ? json.features : null
        if (!feats) {
          // 顶层结构不符 = 契约漂移（蓝点：用户处理不了、等插件更新），不是链路故障（红点）。
          noteParseResult(id, failResult('schema', 'response lacks features[]'))
          throw new Error('response lacks features[]')
        }
        // 结构正确但空数组（NWS 按点查询的常态）交给轮末统一判定：逐响应上报 `empty` 会
        // `clearData`（清蓝点 + 归零连续失败计数），同轮其它 URL 的 schema 失败就被清零。
        if (typeof json.numberMatched === 'number' && json.numberMatched > feats.length) truncatedNow += 1
        okCount += 1
        stats.received += feats.length
        for (const feature of feats) {
          // 单条各自捕获异常：整个 features 循环与 fetch 共用一个 try，会让一条 entry 的解析 /
          // 主链异常被记成"这个请求失败"，还会静默丢掉该响应里剩下的条目。
          let res = null
          try {
            res = parseOne(feature, item.place)
          } catch (parseErr) {
            stats.errors += 1
            lastError = 'item parse threw: ' + String((parseErr && parseErr.message) || parseErr)
            continue
          }
          // 逐条上报一律传 `perItem`：只计数、不清蓝点——单条"不在范围内"或单条解析成功，都不能
          // 证明同轮其它条目的 schema 失败已恢复。清蓝点收敛到轮末的轮级判定。
          if (noteParseResult(id, res, undefined, { perItem: true })) { itemFails += 1; continue }
          if (!res.ok) continue
          const alert = res.alert
          if (seen.has(alert.id)) continue
          seen.add(alert.id)
          noteSourceSuccess(id, undefined, { perItem: true })
          const issued = Date.parse(alert.issued)
          if (Number.isFinite(issued) && issued > newestDataAt) newestDataAt = issued
          const stale = gated && Number.isFinite(issued) && (now - issued) > OVERSEAS_FRESH_GATE_MS
          // 只统计本来会被播报的那些：Watch / Advisory 由档位决定（`overseasRank < 3`）本来就
          // 不播报，算进"过老只记历史"会让设置页那个数字失去解释力。
          const rank = typeof alert.overseasRank === 'number' ? alert.overseasRank : 0
          if (stale && rank >= OVERSEAS_BROADCAST_MIN_RANK) stats.ageSkipped += 1
          // 过老的条目仍然交给主链（带 staleOnArrival，主链走"命中 + 只记历史"那条分支），
          // 丢掉它会让用户看不到"就在打开页面前刚发布的洪水预警"。
          try {
            onAlert(alert, cfg, stale ? { staleOnArrival: Math.round((now - issued) / 3600000) } : undefined)
          } catch (alertErr) {
            stats.errors += 1
            lastError = 'pipeline threw: ' + String((alertErr && alertErr.message) || alertErr)
            continue
          }
          applied += 1
        }
      } catch (err) {
        // 用户主动停用不是故障：stop() 会 abort 在途请求，照常累加会在侧边栏留下红点并往诊断里写中止信息。
        if (stopped) return { applied, aborted: true }
        // 400 = "这个坐标不在我的服务范围内"（NWS 实测对加拿大 / 英国的点都这么答）：参数问题、
        // 不是链路故障，显示成红色"不可达"会让用户以为插件坏了。① 不替上游断言原因（文案只说
        // "被上游拒绝（HTTP 400）"，响应体前 160 字留在诊断里）；② 拉黑带 TTL，1 小时后重试一次；
        // ③ 按请求（URL）记而不是按关注点——NWS 的覆盖外是逐点的。
        if (err && err.status === 400) {
          stats.rejected += 1
          rejectedNow += 1
          uncovered.set(item.url, now + uncoveredTtlMs)
          if (!lastError) lastError = 'HTTP 400（' + String(err.bodyHint || '').slice(0, 160) + '）'
          // 400 也是"上游有响应"，同样算一次成功接触：否则只配了覆盖外坐标的用户 lastSuccessAt
          // 永远不更新、时效门槛恒处于"首轮"。
          lastSuccessAt = Date.now()
          continue
        }
        failCount += 1
        stats.errors += 1
        // 超时自己标记过 → 给一条能读懂的原因（否则诊断里会写 "The user aborted a request."）。
        const timedOutNow = timedOut && !(err && err.status)
        lastError = timedOutNow
          ? 'timeout (' + Math.round(timeoutMs / 1000) + 's)'
          : String((err && err.message) || err)
        onError(timedOutNow ? new Error(lastError) : err)
      } finally {
        if (timerId) clearTimeout(timerId)
        abortCtl = null
      }
    }
    if (newestDataAt) {
      stats.lastDataAt = newestDataAt
      // 上报"最后一次拿到数据的时刻"：契约里这条源的 staleAfterMs 是 null（自检不判），
      // 但诊断快照与排障要看得到它。
      noteFreshness(id, newestDataAt)
    }
    // 轮末的两条轮级判定：① 分页截断按轮计数（按响应累加时 N 个关注点的一轮会 +N，与 UI 说法
    // 不符）；② 结构正常的空结果只在整轮无失败时才判"结构没问题"（05g 的 empty 语义，清蓝点）。
    if (truncatedNow) stats.truncated += 1
    // 清蓝点只在这个轮级判定里做，且要求**整轮没有任何失败**——请求级（`failCount`）与逐条
    // （`itemFails`）都算。逐条失败不进 `failCount`，漏掉 `itemFails` 时"一个响应里坏一条、其余
    // 正常"会被当成整轮健康：蓝点的两条升级路径双双不可达，界面一片绿而数据在静默丢弃。
    // 有内容按成功、整轮空按 empty（两者都表示结构没问题）。
    if (okCount > 0 && failCount === 0 && itemFails === 0) {
      if (applied === 0) noteParseResult(id, failResult('empty', 'ok structure, nothing in scope'))
      else noteSourceSuccess(id)
    }
    // 停用之后不再写状态，否则"用户主动关掉插件"会在侧边栏留下红点、诊断里多一条中止信息。
    if (stopped) return { applied, aborted: true }
    // 成功一轮就清掉上次的失败文案，否则一次瞬时 500 会永远挂在诊断里。
    if (okCount > 0 && failCount === 0) lastError = ''
    // 状态分类：有响应且无失败 → open；有响应也有失败 → degraded（仍在工作）；
    // 全部失败 → unreachable（红色，环境问题）；全部被 400 拒绝 → 仍是 open（参数问题）。
    if (okCount > 0 && failCount === 0) {
      lastSuccessAt = Date.now()
      // detail 只放非单调的语义信息（它进去重键），但也不能留空——空 detail 会让侧边栏悬停与
      // 设置页顶部回退成裸状态词。计数由设置页从 stats 直接读。
      const notes = []
      if (skippedPlaces) notes.push('too many watch points · queried ' + capped.length)
      else if (skippedSamples) notes.push('sample points capped')
      if (rejectedNow) notes.push('rejected x' + rejectedNow + ' (HTTP 400)')
      if (notes.length === 0) notes.push('queried ' + places.length + ' watch points')
      reportStatus({ status: 'open', detail: notes.join(' · ') })
    } else if (okCount > 0) {
      lastSuccessAt = Date.now()
      reportStatus({ status: 'degraded', detail: failCount + '/' + capped.length + ' requests failed: ' + lastError })
    } else if (failCount > 0) {
      reportStatus({ status: 'unreachable', detail: 'all requests failed: ' + lastError })
    } else if (rejectedNow > 0) {
      // 不替上游断言原因：400 也可能是"我们的参数被拒"，文案只说被拒绝 + 多久后重试。
      reportStatus({
        status: 'open',
        detail: 'rejected x' + rejectedNow + ' (HTTP 400) · retry in ' + Math.round(uncoveredTtlMs / 60000) + 'm',
      })
    }
    stats.applied += applied
    return {
      applied, requests: capped.length, failed: failCount,
      throttled: stats.throttledLast, rejected: rejectedNow,
    }
  }

  function pollSerial() {
    if (inFlight) return inFlight
    inFlight = pollOnce().finally(() => {
      inFlight = null
      // 给设置页的「源状态」与诊断快照留一份快照（不触发 store 重渲，渲染侧每 5 秒自己读）。
      overseasStatsOf[id] = Object.assign({}, stats, { running, lastError })
    })
    return inFlight
  }

  function schedule(delay) {
    if (!running) return
    // 排新的定时器之前先清旧的
    if (timer) { clearTimeout(timer); timer = null }
    timer = setTimeout(async () => {
      timer = null
      let res = null
      try { res = await pollSerial() } catch (err) { onError(err) }
      // 失败后的重试间隔递增：整轮全部失败才递增，成功即回正常间隔。递增必须加在正常间隔之上——上限
      // 60 秒而真实间隔是 120 / 300 秒，取 max 会让递增恒等于正常间隔（等于死代码）。
      const allFailed = !!(res && res.requests > 0 && res.failed === res.requests)
      if (allFailed) backoffMs = backoffMs ? Math.min(backoffMs * 2, OVERSEAS_MAX_BACKOFF_MS) : OVERSEAS_MIN_BACKOFF_MS
      else backoffMs = 0
      schedule(intervalMs + backoffMs)
    }, delay)
  }

  return {
    id,
    label,
    start() {
      if (running) return
      stopped = false
      running = true
      backoffMs = 0
      // 门槛标志也要复位：它记的是"上一轮门槛是否激活"，在门槛激活期间 stop() 之后重新开始
      // 会让"进入过几次门槛"少计一次。
      gateActive = false
      schedule(firstDelayMs)
    },
    stop() {
      stopped = true
      running = false
      if (timer) { clearTimeout(timer); timer = null }
      // 中止在途请求：插件停用后回来的响应不该再进主链（响铃 / 弹窗 / 写历史）
      if (abortCtl) { try { abortCtl.abort() } catch (err) { /* 已结束等忽略 */ } abortCtl = null }
      // 停用后也刷新一次快照，否则诊断里 `running` 会一直停在 true。
      overseasStatsOf[id] = Object.assign({}, stats, { running: false, lastError })
    },
    pollOnce,
    pollSerial,
    stats() {
      return Object.assign({}, stats, { running, lastError })
    },
    /** 测试与诊断用：把"上次成功"归零，模拟页面刚打开。 */
    resetGate() { lastSuccessAt = 0; gateActive = false },
  }
}

/** 美国 NWS 的取数器（洪水 / 山洪 / 沿海洪水）。 */
export function createNwsSource(opts = {}) {
  return createOverseasSource(Object.assign({
    id: 'nws_alerts',
    label: 'NWS',
    regionText: 'United States',
    intervalMs: NWS_POLL_MS,
    placesFor: (cfg) => placesInBoxes(cfg, US_BOXES),
    urlsFor: (place) => nwsSamplePoints(place).map((pt) =>
      urlOfLocal(NWS_ALERTS_BASE, { point: pt[0].toFixed(4) + ',' + pt[1].toFixed(4), event: NWS_EVENT_QUERY })),
    parseOne: (feature, place) => parseNwsAlertResult(feature, { place }),
  }, opts))
}

/** 加拿大 ECCC 的取数器（降雨 / 洪水 / 风暴潮 warning）。 */
export function createEcccSource(opts = {}) {
  return createOverseasSource(Object.assign({
    id: 'eccc_alerts',
    label: 'ECCC',
    regionText: 'Canada',
    intervalMs: ECCC_POLL_MS,
    placesFor: (cfg) => placesInBoxes(cfg, [CA_BOX]),
    urlsFor: (place) => [urlOfLocal(ECCC_ALERTS_BASE, { f: 'json', limit: '200', bbox: ecccBboxOf(place) })],
    parseOne: (feature, place) => parseEcccAlertResult(feature, { place }),
  }, opts))
}

/** URL 里的值只做最小转义：保留逗号（`point=lat,lon` 与 `bbox=a,b,c,d` 都靠逗号分隔，
 *  两个源都接受裸逗号，转成 `%2C` 之后 URL 在排障日志里几乎没法读）。 */
function encodeValue(v) {
  return encodeURIComponent(v).replace(/%2C/g, ',')
}

/** 模块级 URL 拼装（两个 profile 共用）。 */
function urlOfLocal(base, params) {
  const qs = Object.keys(params).map((k) => k + '=' + encodeValue(params[k])).join('&')
  return base + '?' + qs
}

export { placesInBoxes, US_BOXES, CA_BOX, defaultFetchText }
