// ============================================================================
// dsh-quake-alert · client/src/12e-overseas-poll.js
//
// 作用：海外气象源（美国 NWS / 加拿大 ECCC）的**取数器**——按关注点查询外部 REST，
//       逐条交给解析契约，命中门槛的交给主链。设计与实测依据见 DESIGN 4.7。
// 依赖：02-storage（own）、03-settings-bridge（currentCfg）、05d（契约包装）、
//       05g（健康）、07-store（读当前状态）、11-pipeline（handleAlert）。
//
// 为什么是 Client 直连、而不是像 JMA / nmc 那样走 Host（DESIGN 4.7.1）：
//   ① 两个源都返回 `Access-Control-Allow-Origin: *`，浏览器可直连；
//   ② **只有"按关注点查询"才可用**——全量分别是 1.2GB/天（NWS）与 144MB/天（ECCC），
//      而 Host 的既有纪律是"不知道 Client 配置、靠 idleMs 自然停下"，它拿不到关注点；
//   ③ NWS 官方"必须带 User-Agent 标识应用"实测不阻断浏览器（带 Chrome UA 与不带 UA 都 200）。
//
// 两个源的取数语义**刻意不统一**（DESIGN 4.7.2），因为它们的能力本来就不同：
//   · NWS 只支持按点查（`?point=`），它返回的是"该点所在县 / 区划"的预警，**不做半径扩张**。
//     所以半径 ≥ 25km 时补 4 个方位采样点——注意这是**近似**（100km 内可能有十几个县），
//     设置页文案必须如实说明。半径 < 25km 只查中心点：NWS 的县通常比它大，采样点会落进同一个县。
//   · ECCC 的 OGC API 支持 `bbox`，于是半径**直接参与**查询；语义是"与这个矩形相交"（比圆略宽），
//     方向是多报不漏报（DESIGN 3.2），可以接受。
//
// 三个共同的纪律（与 12b / 12c / 12-websocket 一致）：
//   · **每轮读一次配置**（getCfg）：关注点变了下一轮就生效，不需要重建取数器；
//   · **串行请求**：对上游礼貌（DESIGN 4.2 对 JMA 定的口径，这里沿用）；
//   · **排新定时器前先清旧的**（0.5.4 对 12b 的修正）：少这一行就意味着以后谁改了一处控制流
//     就多一条自续的轮询链。
//
// 一个刻意的取舍（DESIGN 4.7.7 第 2 条）：`staleAfterMs` 是 null，本模块**不判停更**，
// 因为按点 / 框查询天然可能是空响应。活性只由"请求是否成功"表达。
// ============================================================================

import { currentCfg } from './03-settings-bridge.js'
import { parseNwsAlertResult, parseEcccAlertResult, failResult } from './05d-source-contracts.js'
import { noteParseResult, noteSourceSuccess, noteFreshness, effectiveStatusOf } from './05g-source-health.js'
import { NWS_EVENT_WHITELIST, OVERSEAS_BROADCAST_MIN_RANK } from './05h-overseas-parsers.js'
import { store } from './07-store.js'
import { handleAlert } from './11-pipeline.js'

/** NWS 的洪水类查询端点（全量 `/alerts/active` 1.67MB 不可用，见文件头）。 */
export const NWS_ALERTS_BASE = 'https://api.weather.gov/alerts/active'
/** ECCC 的预警集合（OGC API - Features）。 */
export const ECCC_ALERTS_BASE = 'https://api.weather.gc.ca/collections/weather-alerts/items'
/**
 * NWS 的 `?event=` 白名单参数——**从 05h 的白名单派生**，不再手抄一份（0.6.1 review）。
 *
 * 为什么必须派生：这个参数是**发给上游的服务端过滤**。将来往白名单里加一类（例如新出现的
 * 洪水类产品）而忘了同步这里，上游不会报错、只是永远不返回那一类；客户端白名单也不会因为
 * "缺了它"而报 schema / empty —— 整条链路静默漏报（DESIGN 3.2 最反对的形态）。
 * 派生成同一个集合之后，"加灾种"这件事只剩一处可改。
 */
export const NWS_EVENT_QUERY = Object.keys(NWS_EVENT_WHITELIST).join(',')

export const NWS_POLL_MS = 120 * 1000
export const ECCC_POLL_MS = 300 * 1000
/** 首轮延迟：错开启动窗口，也让设置页先渲染出来（与 12b 的 FEED_FIRST_DELAY_MS 同取向）。 */
export const OVERSEAS_FIRST_DELAY_MS = 4000
/** 单次请求超时（Client 侧统一 10 秒，DESIGN 4.2）。 */
export const OVERSEAS_TIMEOUT_MS = 10 * 1000
/** 单次响应体上限。ECCC 的 bbox 查询在预警密集时实测可到 200KB（几何 + 双语正文），512KB 有余量。 */
export const OVERSEAS_MAX_BODY_CHARS = 512 * 1024
/** 半径小于它时只查中心点（见文件头：采样点会落进同一个县，白花请求）。 */
export const MIN_SAMPLE_RADIUS_KM = 25
/** 每轮请求数上限：20 个关注点 × 5 个采样点 = 100，串行跑完会超过一轮的间隔。 */
export const MAX_REQUESTS_PER_ROUND = 40
/** 年龄闸门：首轮（或距上次成功超过 GATE_RESET）时，只播报发布在这么久以内的条目。 */
export const OVERSEAS_FRESH_GATE_MS = 6 * 60 * 60 * 1000
/** 距上次成功超过这么久，就重新按"首轮"处理（页面休眠恢复后不该把几小时前的当新警报）。 */
export const OVERSEAS_GATE_RESET_MS = 30 * 60 * 1000
/**
 * HTTP 400 之后的冷却期（0.6.0 review A-2）。**不永久拉黑**：400 也可能表示"我们的参数被上游
 * 拒绝"（event 名改了、中间设备改写、WAF），一次误判不该让某个点在本会话里永远查不到。
 * 冷却期内跳过该 URL，到期后自动重试一次。
 */
export const UNCOVERED_TTL_MS = 60 * 60 * 1000
/** 整轮全部失败时的退避起点与上限（DESIGN 4.7.2 对轮询源的通用约束）。 */
export const OVERSEAS_MIN_BACKOFF_MS = 1000
export const OVERSEAS_MAX_BACKOFF_MS = 60 * 1000

/**
 * 海外源的计数快照（供设置页的状态区块与诊断快照读取）。
 *
 * 与 12b 的 `feedStatsOf` **分成两张表**：那张表的字段是"增量 / 游标 / Host 计数"，
 * 语义与这里的"轮次 / 请求数 / 未覆盖 / 年龄闸门"完全不同——混在一张表里会让渲染代码
 * 靠 `if (f.host)` 之类的形状判断去猜来源（0.5.4 修过的那类问题）。两张表各自由自己的
 * 渲染分支读，互不干扰。
 */
export const overseasStatsOf = {}

/**
 * 覆盖范围包围盒。**宁可宽一点也不精确**：盒外的关注点不产生请求（用户没配那个国家就不查），
 * 盒内重叠（美加边境）会让同一个点查两个源——多一次请求，NWS 对覆盖外的点回 400，
 * 由 pollOnce 的 `uncovered` 分类兜住（不会显示成故障）。
 *
 * 0.6.1 review 补上三个**海外领地**（此前只有本土 / 阿拉斯加 / 夏威夷）：波多黎各与美属维尔京群岛、
 * 关岛与北马里亚纳、美属萨摩亚都是 NWS 的正式预报区（各有 WFO），但原先全部落在盒外 →
 * 配了圣胡安的用户会看到「未设置美国关注点」，而那个点明明就在设置页的列表里。
 */
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

// 采样点 / bbox 的坐标夹取（0.6.1 review）：半径最大 2000km 时，高纬度的方位点会算出
// `lon < -180`（安克雷奇 → -186 之类）。那样的 URL 会被上游回 400，于是我们自己生成的
// 非法参数被归类成"被上游拒绝"——诊断会把错误指向对方。夹到合法范围即可（方位点略微
// 偏离本意，但不会凭空多查一个错误的位置）。
const clampLat = (v) => Math.max(-90, Math.min(90, v))
const clampLon = (v) => Math.max(-180, Math.min(180, v))

/** ECCC 的 bbox：坐标 ± 半径（经度按纬度修正）。 */
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
      // 带上状态码：NWS 对"覆盖范围之外"的坐标返回 400（实测多伦多 / 温哥华 / 伦敦都是），
      // 那与"网络不通"是两回事，见 pollOnce 里的分类。
      const err = new Error('HTTP ' + res.status)
      err.status = res.status
      // 400 的响应体自带原因（NWS 是 `Invalid Parameter` + parameterErrors）——**只留给诊断**，
      // 不参与任何判据（按错误文本做分支就是"猜"，DESIGN 4.5 明确反对）。
      // 截 160 字：与下面 catch 里展示时的切片长度一致（两处不一致会让读码的人以为丢了信息）。
      if (res.status === 400) {
        try { err.bodyHint = String(await res.text()).slice(0, 160) } catch (e) { /* 读不到就算了 */ }
      }
      throw err
    }
    return await res.text()
  })()
  if (signal) return await work
  // 没有 AbortController 时用 Promise.race 兜住超时（0.6.0 review C-7）：否则单次请求可以永久
  // 挂住，而下一轮只在上一轮结束之后才排 → 整条轮询链会静默停摆、状态还保持绿色。
  // （无法真正取消那个 fetch，但至少让失败可见、让下一轮照常排。）
  return await Promise.race([
    work,
    new Promise((_, reject) => {
      setTimeout(() => reject(new Error('请求超时（本环境没有 AbortController）')), timeoutMs)
    }),
  ])
}

/** 会话内的"覆盖外"标记以 **URL 本身**为键：坐标或半径一变，旧标记自然失效，不必手动清理。 */

/**
 * 通用海外取数器。与 12b 的 createFeedClient **接口同形**（start / stop / pollOnce / pollSerial /
 * stats），差别只在"数据从哪来"：那边是 Host 的增量游标，这边是按关注点的外部查询。
 *
 * @param {object} opts
 *   id / label / intervalMs / firstDelayMs / enabled / getCfg
 *   placesFor(cfg) -> place[]          该国关注点
 *   urlsFor(place, cfg) -> string[]    该关注点的查询 URL（NWS 多个采样点、ECCC 一个 bbox）
 *   parseOne(feature, place) -> result 契约包装（05d）
 *   onStatus(patch) / onError(err) / fetchText(url, ctx)
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
  const parseOne = opts.parseOne || (() => ({ ok: false, kind: 'schema', detail: '未配置解析器' }))
  // 单次请求的超时可注入（0.6.1）：好让回归测试能在毫秒级验"超时"这条路径的文案与分类
  // ——否则它得真的等 10 秒（默认沙箱此前连 AbortController 都没有，这条路径从未被跑过）。
  // 用 Number.isFinite 而不是 typeof：`NaN` 也是 number，而 `setTimeout(fn, NaN)` 会**立即**触发
  //（0.6.2 review）。
  const timeoutMs = Number.isFinite(opts.timeoutMs) ? opts.timeoutMs : OVERSEAS_TIMEOUT_MS
  // 400 冷却期的时长可注入（0.6.1）：好让回归测试真的能走到"TTL 到期后自动重试"那一侧
  // ——此前只有常量自证（`UNCOVERED_TTL_MS > 0`），把实现改成永久拉黑也测不出来。
  const uncoveredTtlMs = Number.isFinite(opts.uncoveredTtlMs) ? opts.uncoveredTtlMs : UNCOVERED_TTL_MS
  // 交给主链的出口做成可注入：默认就是 11-pipeline 的 handleAlert，测试注入 spy 之后
  // 就能只验"取数器交出了什么"，而不必把整条通知链（音频 / 通知 / toast）拖进单测。
  const onAlert = opts.onAlert || handleAlert

  let timer = null
  let running = false
  let stopped = false
  let inFlight = null
  let abortCtl = null
  let lastStatusKey = ''
  let lastSuccessAt = 0
  let lastError = ''
  /** 年龄闸门上一轮是否处于激活状态（用于"只在进入时计数"，见 pollOnce 里的 gated）。 */
  let gateActive = false
  /** 整轮全部失败时的退避（0 = 没有退避，用正常间隔）。 */
  let backoffMs = 0
  const stats = {
    polls: 0, requests: 0, received: 0, applied: 0, errors: 0,
    ageSkipped: 0, throttledLast: 0, throttledTotal: 0, gated: 0, rejected: 0,
    truncated: 0, lastAt: 0, lastDataAt: 0,
  }
  // 会话内记住"这些 URL 暂时别查"（键 = URL，值 = 可以再试的时刻）。0.6.0 review A-2：
  // 原来是永久拉黑，一次误判（上游改参数名 / WAF 回 400）就让那个点在本会话里永远查不到；
  // 现在带 TTL，到点自动重试一次。
  const uncovered = new Map()

  /**
   * 状态上报：只在**变化**时送出，且除自己上一轮的值还比 **store 里的当前值**
   * （0.5.4 的修正：探针 / 健康层也会写同一个源，只比自己会把别人的状态永久盖住）。
   */
  function reportStatus(patch) {
    const eff = effectiveStatusOf(id, patch.status, patch.detail)
    const cur = ((store.sources || {})[id] || {})
    // 去重键 = **status + detail**（0.6.0 review 修正）。此前只比 status，于是"同一状态下的
    // 语义变化"永远推不出去：用户刚加了一个关注点，状态仍是 open，而 detail 从
    // 「未设置美国关注点（设置 → …）」变成了「已查询」——旧文案会一直挂在设置页上，
    // 用户以为没配成功（这正是 0.5.4「信号被覆盖」那一类）。
    // 代价是 **detail 里不能放单调计数**：那会让每轮都判定为变化、整页反复重渲。
    // 所以计数一律不进 detail，由 13-ui 的 OVERSEAS_STAT_ORDER 从 stats 直接读。
    const key = eff.status + '|' + String(eff.detail || '')
    if (key === lastStatusKey && cur.status === eff.status && String(cur.detail || '') === String(eff.detail || '')) return
    lastStatusKey = key
    // 与 12b 同形：**由调用方（15-entry 的 feedStatus）落库**，本模块不直接写 store
    // ——两处都写会让同一个状态在一轮里被 publish 两次，也会让"谁写的"变得不可追。
    try { onStatus(Object.assign({ label }, eff)) } catch (err) { /* UI 回调异常不影响轮询 */ }
  }

  async function pollOnce() {
    if (stopped) return { applied: 0, aborted: true }
    const cfg = getCfg()
    stats.lastAt = Date.now()
    if (!enabled(cfg)) {
      reportStatus({ status: 'disabled', detail: '海外气象提醒已关闭' })
      return { applied: 0, disabled: true }
    }
    const places = placesFor(cfg)
    if (places.length === 0) {
      // 与坐标型源同一条原则（06-matcher 的 noWatch）：**不静默**——"配错了关注点"看起来像
      // "根本没有预警"是这套系统最该避免的误解。这里不产生任何网络请求。
      //
      // 两种"0 个关注点"必须分开说（0.6.1 review）：是配置里根本没有点，还是**有**点但都落在
      // 本源的覆盖盒之外（关岛之类，或纯加拿大用户看美国源）？此前一律说"未设置"，
      // 而用户明明在设置页的列表里看得见那个点。
      const anyPlaces = ((cfg.watch || {}).places || []).length > 0
      reportStatus({
        status: 'open',
        detail: (anyPlaces ? '关注点都不在' + regionText + '源的覆盖范围内' : '未设置' + regionText + '关注点') +
          '（设置 → 灾害预警 → ③ 其他地区：坐标 + 半径）',
      })
      return { applied: 0, noPlaces: true }
    }
    // 请求清单（0.6.0 review 修正）：**先保证每个关注点都被查一次，再补采样点**。
    // 此前是按关注点顺序平铺后整段截断——10 个关注点 × 5 个采样点 = 50 > 上限 40 时，
    // 排在后面的两个关注点**每一轮都被截断、永远查不到**，而用户看不出任何异常
    //（这正是 3.2 最反对的"静默漏报"）。现在：
    //   · 每个关注点的第一个 URL（NWS 的中心点 / ECCC 的 bbox）无条件排上；
    //   · 剩下的额度才按顺序补方位采样点。
    // 关注点上限是 20（MAX_WATCH_PLACES），远小于请求上限，所以正常配置下**不会再丢关注点**；
    // 万一真的超出，`skippedPlaces` 会如实计数并写进状态（不静默）。
    const now = Date.now()
    // 暂时被上游拒绝的 URL 先跳过（TTL 到期后会自动重试一次，见下面 400 分支）
    const groups = places
      .map((p) => ({ place: p, urls: (urlsFor(p, cfg) || []).filter((u) => !(uncovered.get(u) > now)) }))
      .filter((g) => Array.isArray(g.urls) && g.urls.length > 0)
    const reqs = []
    for (const g of groups) reqs.push({ place: g.place, url: g.urls[0] })
    const coreCount = reqs.length
    // 剩余额度补方位采样点，**起点按轮次轮转**（0.6.0 review B-2）：固定顺序会让排在后面的
    // 关注点每一轮都只拿到中心点（实测 10 个点时尾部两点永远只有 1 个采样点，等效半径退化成
    // "那一个县"）。轮转之后长期看每个点都能轮到方位采样。
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
    // 被截断的采样点数要按"本该有多少"算，而不是用 reqs.length——补采样点时就已经 break 在
    // 上限上了，剩下的采样点根本没进 reqs（用 reqs.length 会永远算出 0，设置页那一行就成了摆设）。
    const wantSamples = groups.reduce((n, g) => n + Math.max(0, g.urls.length - 1), 0)
    const gotSamples = Math.max(0, capped.length - Math.min(coreCount, capped.length))
    const skippedPlaces = Math.max(0, coreCount - capped.length)
    const skippedSamples = Math.max(0, wantSamples - gotSamples)
    // 两个计数分开（0.6.0 review B-6）：`Last` 是本轮值（设置页看当下）、`Total` 是累计
    // （诊断里看趋势）——此前只有一个覆盖式的值，会出现"忽有忽无、也不知道累计跳了多少"。
    stats.throttledLast = skippedPlaces + skippedSamples
    stats.throttledTotal += stats.throttledLast

    // 年龄闸门（DESIGN 4.7.6）：首轮或"距上次成功超过 30 分钟"（页面休眠恢复）时，
    // 只把发布在 6 小时以内的条目当新警报播；更早的仍进历史，但不打扰。
    const gated = (now - lastSuccessAt) > OVERSEAS_GATE_RESET_MS
    // 只在**进入**闸门的那一刻计数（0.6.1 review）：此前统计的是"闸门处于激活状态的轮数"，
    // 而源持续不可达时 lastSuccessAt 一直不更新 → 每轮都 +1，诊断里会读成"进入过几百次首轮"。
    if (gated && !gateActive) stats.gated += 1
    gateActive = gated

    stats.polls += 1
    stats.requests += capped.length
    let okCount = 0
    let failCount = 0
    let applied = 0
    let rejectedNow = 0
    let newestDataAt = 0
    /** 本轮有多少个响应被 ECCC 的分页上限截断（轮末汇总成 stats.truncated，见下）。 */
    let truncatedNow = 0
    // 同一条预警可能被多个采样点查到（中心点与方位点落进同一个县）→ 一轮内只处理一次。
    const seen = new Set()
    for (const item of capped) {
      if (stopped) break
      // 超时标记（0.6.1 review）：`AbortController.abort()` 造成的错误与"用户停用插件"
      // 在 fetch 层完全同形（Chrome 的文案甚至是 "The user aborted a request."）。
      // 只靠 `stopped` 区分不了，于是真实超时会被诊断成"用户主动中止"——正是 A-1 想消灭的
      // 那条误导信息。这里自己记一笔，好在 catch 里给出正确的文案。
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
        if (typeof text !== 'string') throw new Error('取数器没有返回文本')
        if (text.length > OVERSEAS_MAX_BODY_CHARS) {
          throw new Error('响应体过大（' + text.length + ' 字符 > 上限 ' + OVERSEAS_MAX_BODY_CHARS + '）')
        }
        let json = null
        try {
          json = JSON.parse(text)
        } catch (err) {
          // 与下面"缺 features"同一类（0.6.1 review）：HTTP 200 却不是 JSON，最常见的原因是
          // 拦截页 / 上游改版。此前它按**链路故障**上报，于是同一份证据在同一个函数里得出两个
          // 相反的六态（蓝点 vs 红点）——而 JMA / NOAA 对"返回 HTML 而不是电文"一律判 schema。
          noteParseResult(id, failResult('schema', '响应不是合法 JSON（可能是拦截页或上游改版）'))
          throw new Error('响应不是合法 JSON（可能是拦截页或上游改版）')
        }
        const feats = json && Array.isArray(json.features) ? json.features : null
        if (!feats) {
          // 顶层结构不符 = **契约漂移**，不是链路故障（0.6.0 review 修正）。按 DESIGN 4.5 的六态
          // 语义它该点亮**蓝点**（用户处理不了、等插件更新），而不是红点（让用户去折腾自己的网络）。
          // 此前这里只抛普通 Error，于是整轮被归成 unreachable —— 与 check-contracts 把同一个
          // 条件判成"结构变了"的结论自相矛盾。
          noteParseResult(id, failResult('schema', '响应缺少 features 数组（结构不符，可能是上游改版或拦截页）'))
          throw new Error('响应缺少 features 数组（结构不符）')
        }
        // 结构正确但**空数组**（NWS 按点查询的常态）交给**轮末**统一判定（0.6.2 修正，见下）。
        // 0.6.1 曾在这里逐响应上报 `empty`，而 05g 的 empty 会 `clearData`（清蓝点 + 归零连续
        // 失败计数）——同一轮里只要有一条 URL 返回空数组，其它 URL 的同类 schema 失败就被清零：
        // 实测（每轮 1 个拦截页 + 4 个空响应 × 6 轮）schema 计数涨到 6 而 consecutiveFail 恒为 0，
        // **蓝点永不点亮**。局部改版 / 局部拦截于是变成静默漏报（DESIGN 3.2 最反对的形态）。
        if (typeof json.numberMatched === 'number' && json.numberMatched > feats.length) truncatedNow += 1
        okCount += 1
        stats.received += feats.length
        for (const feature of feats) {
          // **单条各自兜错**（0.6.0 review B-3）：此前整个 features 循环与 fetch 共用一个 try，
          // 一条 entry 的解析 / 主链异常会被记成"这个请求失败"，还会静默丢掉该响应里剩下的条目
          //（12b 的既有纪律正是"单条失败不阻断其余条目"，见其 apply 循环）。
          let res = null
          try {
            res = parseOne(feature, item.place)
          } catch (parseErr) {
            stats.errors += 1
            lastError = '单条解析抛错：' + String((parseErr && parseErr.message) || parseErr)
            continue
          }
          // 契约分类：empty（不在本插件范围 / 该点无预警）不计失败，schema / value 计入健康。
          if (noteParseResult(id, res)) continue
          if (!res.ok) continue
          const alert = res.alert
          if (seen.has(alert.id)) continue
          seen.add(alert.id)
          noteSourceSuccess(id)
          const issued = Date.parse(alert.issued)
          if (Number.isFinite(issued) && issued > newestDataAt) newestDataAt = issued
          const stale = gated && Number.isFinite(issued) && (now - issued) > OVERSEAS_FRESH_GATE_MS
          // 只统计**本来会被播报**的那些（0.6.1 review）：Watch / Advisory 由档位决定
          // （`overseasRank < 3`）本来就不播报，把它们算进"过老只记历史"会让设置页那个
          // 数字失去解释力（用户会以为有那么多条被闸门拦下了播报）。
          const rank = typeof alert.overseasRank === 'number' ? alert.overseasRank : 0
          if (stale && rank >= OVERSEAS_BROADCAST_MIN_RANK) stats.ageSkipped += 1
          // 过老的条目仍然交给主链，但带 staleOnArrival：主链会走"命中 + 只记历史"的那条分支
          // （与"跨会话重放"同形）。丢掉它会让用户看不到"就在打开页面前刚发布的洪水预警"。
          try {
            onAlert(alert, cfg, stale ? { staleOnArrival: Math.round((now - issued) / 3600000) } : undefined)
          } catch (alertErr) {
            stats.errors += 1
            lastError = '主链处理抛错：' + String((alertErr && alertErr.message) || alertErr)
            continue
          }
          applied += 1
        }
      } catch (err) {
        // **用户主动停用不是故障**（0.6.0 review A-1，照搬 12b 的既有守卫）：stop() 会 abort
        // 在途请求，于是 catch 会收到一个 AbortError。若照常累加，停用插件就会在侧边栏留下
        // 一个红点、并往诊断里写一条 "The user aborted a request."——而重载时旧 fiber 的这次
        // 上报还会把新会话短暂染红。这里直接返回，让本轮当作"被中止"处理。
        if (stopped) return { applied, aborted: true }
        // 400 = "这个坐标不在我的服务范围内"（NWS 实测对加拿大 / 英国的点都这么答）。
        // 这是**参数问题，不是链路故障**：按 DESIGN 4.5 的状态语义，把它显示成红色"不可达"
        // 会让一个多伦多用户以为插件坏了（实际是"你关注的地方没有这个源"）。
        // 三个约束（0.6.0 review A-2）：
        //   ① **不替上游断言原因**——400 也可能是"我们的参数被拒"（上游改了 event 名、
        //      中间设备改写、WAF），文案只说"被上游拒绝（HTTP 400）"，并把响应体前 160 字
        //      留在诊断里供人判断，不写"这个点不在覆盖范围"这种我们无法证实的话；
        //   ② **拉黑带 TTL**——记的是"这个 URL 暂时别查"，1 小时后自动重试一次，
        //      避免一次误判让某个点在本会话里永远查不到；
        //   ③ **按请求（URL）记，不是按关注点**：NWS 的"覆盖外"是逐点的，一个美加边境的点的
        //      中心点可能 400，而它的四个方位点里有落在美国境内、本该查得到的。
        if (err && err.status === 400) {
          stats.rejected += 1
          rejectedNow += 1
          uncovered.set(item.url, now + uncoveredTtlMs)
          if (!lastError) lastError = 'HTTP 400（' + String(err.bodyHint || '').slice(0, 160) + '）'
          // 400 也是"上游有响应"，同样算一次成功接触：否则只配了覆盖外坐标的用户
          // `lastSuccessAt` 永远不更新、年龄闸门恒处于"首轮"。
          lastSuccessAt = Date.now()
          continue
        }
        failCount += 1
        stats.errors += 1
        // 超时自己标记过 → 给一条能读懂的原因（否则诊断里会写 "The user aborted a request."）。
        const timedOutNow = timedOut && !(err && err.status)
        lastError = timedOutNow
          ? '请求超时（' + Math.round(timeoutMs / 1000) + ' 秒未响应）'
          : String((err && err.message) || err)
        onError(timedOutNow ? new Error(lastError) : err)
      } finally {
        if (timerId) clearTimeout(timerId)
        abortCtl = null
      }
    }
    if (newestDataAt) {
      stats.lastDataAt = newestDataAt
      // 上报"最后一次拿到数据的时刻"：契约里这条源的 staleAfterMs 是 null（探针不判），
      // 但诊断快照与排障要看得到它。
      noteFreshness(id, newestDataAt)
    }
    // 轮末的两条**轮级**判定（0.6.2 修正）。
    // ① 分页截断：按**轮**计数（此前按响应累加——加拿大用户有 N 个关注点时一轮会 +N，
    //    与 UI / 诊断里"多少轮被截断"的说法不符）。
    if (truncatedNow) stats.truncated += 1
    // ② 结构正常的空结果：**只有整轮一条失败都没有**时，才把这一轮判成"结构没问题"。
    //    这正是 05g 的 empty 语义（empty 也算结构是好的 → 清蓝点），但它必须以**轮**为单位：
    //    逐响应上报会让局部失败（5 个采样点里 1 个被拦截）永远升不了级，见上面的说明。
    //    `applied === 0` 时才需要它——有成功解析的条目时 `noteSourceSuccess` 已经清过蓝点。
    if (okCount > 0 && failCount === 0 && applied === 0) {
      noteParseResult(id, failResult('empty', '本轮响应结构正常，但没有本插件范围内的条目'))
    }
    // 停用之后不再写状态（0.6.0 review A-1）：否则"用户主动关掉插件"会在侧边栏留下红点，
    // 诊断里也会多一条 "The user aborted a request."
    if (stopped) return { applied, aborted: true }
    // 成功一轮就清掉上次的失败文案（0.6.0 review B-6）：否则一次瞬时 500 会永远挂在诊断里。
    if (okCount > 0 && failCount === 0) lastError = ''
    // 状态分类（DESIGN 4.5 的六态语义）：
    //   · 有响应且没有失败 → open
    //   · 有响应但也有失败 → degraded（部分链路有问题，但仍在工作）
    //   · 全部失败 → unreachable（红色：环境问题，用户或许能处理）
    //   · 全部被 400 拒绝 → **仍然是 open**（400 是参数问题，不是链路故障，见上面的分档）
    if (okCount > 0 && failCount === 0) {
      lastSuccessAt = Date.now()
      // detail 只放**非单调**的语义信息（0.6.0 review 修正 + B-1）：它进了上报去重键，
      // 含单调计数会让每轮都判为"变化"、设置页反复重渲。但也**不能留空**——空 detail 会让
      // 侧边栏悬停与设置页顶部回退成裸状态词（出现「NWS：open」这种英文）。"已按 N 个关注点
      // 查询"里的 N 只在用户改配置时变，正是想推出去的语义变化；计数由设置页的
      // OVERSEAS_STAT_ORDER 从 stats 直接读。
      const notes = []
      if (skippedPlaces) notes.push('关注点过多，本轮只查了 ' + capped.length + ' 个')
      else if (skippedSamples) notes.push('采样点超出每轮上限，本轮只查了部分方位点')
      if (rejectedNow) notes.push(rejectedNow + ' 个请求被上游拒绝（HTTP 400）')
      if (notes.length === 0) notes.push('已按 ' + places.length + ' 个关注点查询')
      reportStatus({ status: 'open', detail: notes.join(' · ') })
    } else if (okCount > 0) {
      lastSuccessAt = Date.now()
      reportStatus({ status: 'degraded', detail: failCount + '/' + capped.length + ' 个请求失败：' + lastError })
    } else if (failCount > 0) {
      reportStatus({ status: 'unreachable', detail: '全部请求失败：' + lastError })
    } else if (rejectedNow > 0) {
      // 不替上游断言原因（0.6.0 review A-2）：400 也可能是"我们的参数被拒"，
      // 文案只说被拒绝 + 多久后重试，响应体前 160 字在诊断里。
      reportStatus({
        status: 'open',
        detail: rejectedNow + ' 个请求被上游拒绝（HTTP 400，' + Math.round(uncoveredTtlMs / 60000) + ' 分钟后重试）',
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
      // 给设置页的「源状态」与诊断快照留一份快照（与 12b 对 feedStatsOf 的做法一致：
      // 不触发 store 重渲，渲染侧每 5 秒自己读一次）。
      overseasStatsOf[id] = Object.assign({}, stats, { running, lastError })
    })
    return inFlight
  }

  function schedule(delay) {
    if (!running) return
    // 排新的之前先清旧的（0.5.4 对 12b 的修正，这里同纪律）
    if (timer) { clearTimeout(timer); timer = null }
    timer = setTimeout(async () => {
      timer = null
      let res = null
      try { res = await pollSerial() } catch (err) { onError(err) }
      // 失败退避（0.6.0 review B-5；语义在 0.6.2 修正）：整轮全部失败才退避，成功即回正常间隔。
      // **必须加在正常间隔之上**：退避上限是 60 秒，而两个源的真实间隔是 120 / 300 秒——
      // 0.6.1 写成 `max(退避, 正常间隔)` 之后，在真实间隔下它恒等于正常间隔，退避阶梯成了
      // 死代码（0.6.0 承诺的"1s→60s 退避"实际不存在；两条退避用例注入的都是毫秒级间隔，
      // 永远发现不了）。现在失败时是 `正常间隔 + 退避`，对上游礼貌的方向不变、强度回来了。
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
      // 闸门标志也要复位（0.6.2 review）：它记的是"上一轮闸门是否激活"。若在闸门激活期间
      // stop()（或测试里 resetGate()）之后重新开始，闸门重新为真而标志仍是 true →
      // "进入过几次闸门"少计一次，正是本模块要修的那类"数字不可解释"。
      gateActive = false
      schedule(firstDelayMs)
    },
    stop() {
      stopped = true
      running = false
      if (timer) { clearTimeout(timer); timer = null }
      // 中止在途请求：插件停用后回来的响应不该再进主链（响铃 / 弹窗 / 写历史）
      if (abortCtl) { try { abortCtl.abort() } catch (err) { /* 已结束等忽略 */ } abortCtl = null }
      // 停用后也刷新一次快照（0.6.0 review B-6）：否则诊断里 `running` 会一直停在 true。
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
    regionText: '美国',
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
    regionText: '加拿大',
    intervalMs: ECCC_POLL_MS,
    placesFor: (cfg) => placesInBoxes(cfg, [CA_BOX]),
    urlsFor: (place) => [urlOfLocal(ECCC_ALERTS_BASE, { f: 'json', limit: '200', bbox: ecccBboxOf(place) })],
    parseOne: (feature, place) => parseEcccAlertResult(feature, { place }),
  }, opts))
}

/** URL 里的值只做最小转义：**保留逗号**。NWS 的 `point=lat,lon` 与 ECCC 的 `bbox=a,b,c,d`
 *  都靠逗号分隔，转成 `%2C` 之后 URL 在排障日志里几乎没法读；两个源都接受裸逗号（实测）。 */
function encodeValue(v) {
  return encodeURIComponent(v).replace(/%2C/g, ',')
}

/** 模块级 URL 拼装（两个 profile 共用；createOverseasSource 内部不再各写一份）。 */
function urlOfLocal(base, params) {
  const qs = Object.keys(params).map((k) => k + '=' + encodeValue(params[k])).join('&')
  return base + '?' + qs
}

export { placesInBoxes, US_BOXES, CA_BOX, defaultFetchText }
