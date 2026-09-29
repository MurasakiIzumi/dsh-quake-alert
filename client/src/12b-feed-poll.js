// ============================================================================
// dsh-quake-alert · client/src/12b-feed-poll.js
// 作用：从 Host 的只读路由拉気象庁 / 全球源的电文增量，解析成 Alert 后交给主链（handleAlert，与 P2PQuake 的
//       551/552/556 汇到同一条链）；含读取位置生命周期、增量应用、失败容错、启停、诊断计数。
// 依赖：02-storage（读取位置写入本地存储）、03-settings-bridge、05b/05d（解析契约）、05g（健康）、07-store、11-pipeline。
// ============================================================================

import { loadJSON, saveJSON } from './02-storage.js'
import { currentCfg } from './03-settings-bridge.js'
import { parseJma } from './05b-jma-parser.js'
import { parseJmaResult } from './05d-source-contracts.js'
import { noteParseResult, noteSourceSuccess, effectiveStatusOf, noteFreshness } from './05g-source-health.js'
import { store } from './07-store.js'
import { handleAlert } from './11-pipeline.js'

/** Host 侧的电文增量路由（与 lib/index.js 的 FEED_PATH 对应）。只从回环地址取增量：Host 是每台机器唯一的
 *  外部请求者（気象庁要求「一度取得したファイルを再度取得しない」，多标签页不会放大请求）。 */
export const FEED_PATH = '/dsh-quake-alert/feed'
/** 本地拉取间隔：Host 每 60s 拉一次源，这里 15s 拉一次本地缓存，端到端最坏约 75s。 */
export const FEED_POLL_MS = 15 * 1000
/** 启动后首轮延迟：给插件装载、城市表与 host 侧首轮轮询让路。 */
export const FEED_FIRST_DELAY_MS = 3000
/** 读取位置在 localStorage 里的键。 */
export const FEED_CURSOR_KEY = 'dsh.quakeAlert.feedCursor'
/** 首次启动的特殊标记值：还没有读取位置 → 用 tail 语义对齐位置而不是重放历史。 */
export const FEED_TAIL = 'tail'
/** 各源最近一次轮询结果的**只读快照**（id → stats）。放模块级对象而不是 store：每轮都 push 会让设置页与侧边栏反复重渲。 */
export const feedStatsOf = {}
/** 本地路由的单次请求超时：Host 卡住时不能让 inFlight 一直占着、把整条轮询拖停。 */
export const FEED_FETCH_TIMEOUT_MS = 10 * 1000

/** 读回已持久化的读取位置；任何格式不合法的数据（非数字 / NaN / 负数）一律当作"没有记录"。 */
function loadFeedCursor(key) {
  const v = loadJSON(key || FEED_CURSOR_KEY, null)
  return (typeof v === 'number' && Number.isFinite(v) && v >= 0) ? Math.floor(v) : null
}
function saveFeedCursor(v, key) {
  if (typeof v === 'number' && Number.isFinite(v) && v >= 0) saveJSON(key || FEED_CURSOR_KEY, Math.floor(v))
}

async function defaultFetchJson(url, signal) {
  const AS = (typeof window !== 'undefined' && window) ? window.AbortSignal : undefined
  let timeout = (AS && typeof AS.timeout === 'function') ? AS.timeout(FEED_FETCH_TIMEOUT_MS) : undefined
  let timeoutTimer = null
  // `AbortSignal.timeout` 只有较新引擎才有（Chrome 103+ / Firefox 124+），缺失时超时保护会整条消失：挂死的
  // 请求让 inFlight 永不 settle、四源一起永久停摆。这里补一个自建 AbortController 的分支。
  if (!timeout && typeof AbortController === 'function') {
    const ctrl = new AbortController()
    timeoutTimer = setTimeout(() => { try { ctrl.abort() } catch (err) { /* 已中止 */ } }, FEED_FETCH_TIMEOUT_MS)
    timeout = ctrl.signal
  }
  /** 把「请求超时」与「插件停用时中止」合成**一个**信号：`AbortSignal.any` 在 Chrome 103-115 /
   *  Firefox 100-123 上没有，缺失时自建 AbortController 合并两个信号（任一触发即中止），
   *  只有这样才能真正掐断底层请求（12e 的 Promise.race 只是让 Promise 早点失败）。 */
  let sig = timeout
  const anyFn = (AS && typeof AS.any === 'function')
    ? AS.any
    : ((typeof AbortSignal !== 'undefined' && typeof AbortSignal.any === 'function') ? AbortSignal.any : null)
  try {
    if (signal && timeout) {
      if (anyFn) {
        sig = anyFn([signal, timeout])
      } else if (typeof AbortController === 'function') {
        const ctrl = new AbortController()
        if (signal.aborted || timeout.aborted) {
          ctrl.abort()
        } else {
          const onAbort = () => { try { ctrl.abort() } catch (err) { /* 已经中止过 */ } }
          signal.addEventListener('abort', onAbort, { once: true })
          timeout.addEventListener('abort', onAbort, { once: true })
        }
        sig = ctrl.signal
      } else {
        // 连 AbortController 都没有（很老的引擎）：只能保业务信号，超时退回 Promise.race 兜底
        sig = signal
      }
    } else if (signal) {
      sig = signal
    }
  } catch (err) { sig = timeout }
  const request = window.fetch(url, { headers: { accept: 'application/json' }, signal: sig })
    .then((res) => {
      if (!res || !res.ok) throw new Error('HTTP ' + (res ? res.status : '?'))
      return res.json()
    })
  // 兜底（只在"连 AbortController 都没有"的老引擎上生效）：让这一轮按时结束，避免轮询链永久停摆。
  try {
    if (!(typeof AbortController === 'function') && timeout) {
      let timer = null
      try {
        return await Promise.race([
          request,
          new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error('local timeout (' + FEED_FETCH_TIMEOUT_MS + 'ms): ' + url)), FEED_FETCH_TIMEOUT_MS)
          }),
        ])
      } finally {
        if (timer) clearTimeout(timer)
      }
    }
    return await request
  } finally {
    // 自建的超时定时器要在请求结束时清掉（成功 / 失败 / 被中止），否则会一直挂到超时点
    if (timeoutTimer) clearTimeout(timeoutTimer)
  }
}

/**
 * @param {object} [opts] 注入点（fetchJson / apply / getCfg / loadCursor / saveCursor / onError / onStatus）供测试替换。
 * @param {string} [opts.id] 源标识（诊断用）；[opts.label] 状态文案里的源名。
 * @param {string} [opts.path] Host 增量路由；全球源用 `?source=usgs` 这类分派参数。
 * @param {string} [opts.cursorKey] 该源自己的读取位置存储键——多源共用一条键会互相顶掉读取位置。
 * @param {(cfg: object) => boolean} [opts.enabled] 该源当前是否需要拉取（按灾种开关判断）。
 * @param {(patch: object) => void} [opts.onStatus] 状态上报：把本源的连接 / 失败情况送进 store 参与整体聚合。
 */
export function createFeedClient(opts = {}) {
  const id = opts.id || 'jma'
  const label = opts.label || id
  const path = opts.path || FEED_PATH
  const cursorKey = opts.cursorKey || FEED_CURSOR_KEY
  const intervalMs = opts.intervalMs || FEED_POLL_MS
  const firstDelayMs = opts.firstDelayMs === undefined ? FEED_FIRST_DELAY_MS : opts.firstDelayMs
  const fetchJson = opts.fetchJson || defaultFetchJson
  const getCfg = opts.getCfg || currentCfg
  const onError = opts.onError || (() => {})
  const onStatus = opts.onStatus || (() => {})
  // 该源此轮要不要拉：气象源跟 weather 开关，全球地震跟 earthquake 开关，海啸跟 tsunami 开关。
  const enabled = opts.enabled || ((cfg) => (cfg.disasters || {}).weather !== false)
  const loadCursor = opts.loadCursor || (() => loadFeedCursor(cursorKey))
  const saveCursor = opts.saveCursor || ((v) => saveFeedCursor(v, cursorKey))
  const apply = opts.apply || ((entry, cfg) => {
    // 走解析契约：schema / value 失败会计入数据健康且**不播报**，empty（与本插件无关的电文）静静跳过。
    // 这里**不传 `subject`**：feed 是逐电文入队，但 JMA 的 schema 失败取不到电文种类——它只发生在
    // 整份载荷级（空响应 / 被拦截成 HTML / 缺 `<Report>`），那时 XML 里没有 `<Control><Title>` 可读；
    // 传一个恒为空串的 subject 只是白扫一遍正则，而空 subject 的失败本来就允许被任何成功清掉。
    // 由此留下的两个盲区（同源其它电文成功会清掉这条失败、电文种类漂移退化成 empty）记在 DESIGN 11.9。
    const res = parseJmaResult(entry && entry.xml, { id: entry && entry.id })
    if (noteParseResult(id, res)) return false
    if (!res.ok) return false
    noteSourceSuccess(id)
    handleAlert(res.alert, cfg)
    return true
  })

  // null = 本浏览器还没有读取位置（首次启动）→ 首轮用 tail 对齐，不重放 Host 缓冲里的历史。
  // 读取位置语义：`?since=N` 返回 seq > N 的条目（Host 的固定长度缓冲淘汰旧条目时带 truncated，有缺口仍照常应用）；
  // `?since=tail` 是首次启动只要当前位置；响应带 `reset` 表示 Host 重启后读取位置从 0 重算，据此对齐。
  let since = null
  try {
    const stored = loadCursor()
    if (typeof stored === 'number' && Number.isFinite(stored) && stored >= 0) since = Math.floor(stored)
  } catch (err) { /* 读取本地存储失败按首次启动处理 */ }
  let timer = null
  let running = false
  let stopped = false // 插件停用：在途轮询的响应回来后不该再 apply
  let inFlight = null
  let abortCtl = null
  let lastStatusKey = ''
  // Host 的 errors / detailDropped 是**进程内累计**计数（永不归零），判断"这一轮又失败了"必须看增量。
  let lastHostErrors = 0
  let lastHostDropped = 0
  const stats = { polls: 0, received: 0, applied: 0, errors: 0, truncated: 0, tailSync: 0, resets: 0, morePages: 0, lastAt: 0, cursor: 0, host: null }

  /** 状态上报：只在**状态**变化时送出（轮询每 15 秒一轮，每轮都 push 会让设置页反复重渲），并经
   *  effectiveStatusOf 合并"数据格式异常"（蓝点，优先级高于连接状态）。 */
  function reportStatus(patch) {
    const eff = effectiveStatusOf(id, patch.status, patch.detail)
    // key **只取状态**：detail 里含"已收到 N 条增量"这类单调计数，用它做 key 会让每轮都判定为"变化"。
    // 还要比 **store 里当前实际的状态**：自检（12d）、健康层（05g）与 WS 连接层也会写同一个源，若它们
    // 刚改过展示状态而这里不上报，那个状态会**永久**留在界面上。
    const cur = ((store.sources || {})[id] || {}).status
    if (eff.status === lastStatusKey && cur === eff.status) return
    lastStatusKey = eff.status
    try { onStatus(Object.assign({ label }, eff)) } catch (err) { /* UI 回调异常不影响轮询 */ }
  }

  /** 推进读取位置并写入本地存储（值没变就不写，15s 一次的轮询不必每次都碰 localStorage）。 */
  function setCursor(next) {
    if (!(typeof next === 'number' && Number.isFinite(next) && next >= 0)) return
    const v = Math.floor(next)
    if (v === since) return
    since = v
    try { saveCursor(v) } catch (err) { /* 隐私模式等写入本地存储失败：本次仍以内存里的读取位置工作 */ }
  }
  const cursorNow = () => (since === null ? 0 : since)

  async function pollOnce() {
    stats.polls += 1
    // 灾种开关关闭时不必拉增量（Host 侧随后也会据此停轮询）；状态如实上报为「已关闭」，聚合状态不会显示成异常。
    if (!enabled(getCfg())) {
      reportStatus({ status: 'disabled', detail: 'disabled · hazard switch off' })
      return { applied: 0, cursor: cursorNow(), skipped: true }
    }
    let data
    // 自持取消器：插件停用时要能中止在途请求，否则响应回来后仍会 apply → handleAlert → 响铃 / 弹窗 / 写历史。
    abortCtl = (typeof window !== 'undefined' && window && typeof window.AbortController === 'function')
      ? new window.AbortController()
      : null
    try {
      // path 可能自带查询串（全球源用 `?source=usgs` 分派），按需选分隔符；stats=1 把 Host 侧的健康计数一并取回。
      const sep = path.indexOf('?') === -1 ? '?' : '&'
      data = await fetchJson(
        path + sep + 'since=' + (since === null ? FEED_TAIL : since) + '&stats=1',
        abortCtl ? abortCtl.signal : undefined,
      )
    } catch (err) {
      // 用户主动停用（abort）不是"源不可达"：不上报 unreachable、不计失败，否则侧边栏会留下一个红点。
      if (stopped) return { applied: 0, cursor: cursorNow(), aborted: true }
      stats.errors += 1
      onError(err)
      reportStatus({ status: 'unreachable', detail: 'feed route failed: ' + String((err && err.message) || err) })
      return { applied: 0, cursor: cursorNow() }
    } finally {
      abortCtl = null
    }
    stats.lastAt = Date.now()
    // Host 回显的源必须与请求的一致：Host 比 Client 旧时会把 jma 的原文交给 noaa 的解析器，解析必失败，
    // 而读取位置仍在推进——那些条目被永久跳过且表面正常。
    if (data && data.source && data.source !== id) {
      const err = new Error('source mismatch: asked ' + id + ', host returned ' + data.source)
      stats.errors += 1
      onError(err)
      reportStatus({ status: 'unreachable', detail: err.message })
      return { applied: 0, cursor: cursorNow() }
    }
    if (data && data.stats) stats.host = data.stats
    // 把**源自己的数据时间**交给自检（阈值由自检从契约里取），这里只上报事实、不判 stale。取 Host 的
    // `feedTime`（源自 <updated> / metadata.generated / 列表最新一条），不是"我们收到条目的时刻"：JMA 可能
    // 几小时只有天气预报，用收到时刻会把那种正常情况判成停更。
    if (data && data.stats && Number.isFinite(data.stats.feedTime) && data.stats.feedTime > 0) {
      noteFreshness(id, data.stats.feedTime)
    }
    // 首次对齐：Host 只回当前位置，不应用任何条目（即使响应里意外带了也不应用），否则"刷新页面"又变成重放历史。
    if (data && data.tail === true) {
      stats.tailSync += 1
      setCursor(data.cursor)
      stats.cursor = cursorNow()
      reportStatus({ status: 'open', detail: 'aligned · ' + hostDetail() })
      return { applied: 0, cursor: cursorNow(), tail: true }
    }
    // 本地没有读取位置、响应却没带 tail 标记 → 对面是不认 `since=tail` 的旧版 Host（按 0 吐回整个固定长度缓冲）：
    // 取它的读取位置对齐即可，不能把这些历史当增量播一遍。
    if (since === null) {
      stats.tailSync += 1
      if (data && Number.isFinite(data.cursor)) setCursor(data.cursor)
      stats.cursor = cursorNow()
      return { applied: 0, cursor: cursorNow(), tail: true, legacyHost: true }
    }
    const entries = Array.isArray(data && data.entries) ? data.entries : []
    if (data && data.truncated) stats.truncated += 1
    let applied = 0
    let lastSeenSeq = null
    for (const e of entries) {
      if (stopped) break // 插件已停用：剩下的条目不再处理
      stats.received += 1
      try {
        if (apply(e, getCfg())) applied += 1
      } catch (err) {
        // 单条电文解析失败不能影响后续条目，也不能让读取位置停住
        stats.errors += 1
        onError(err)
      }
      if (e && Number.isFinite(e.seq)) lastSeenSeq = e.seq
    }
    stats.applied += applied
    let reset = false
    if (data && Number.isFinite(data.cursor)) {
      // Host 重启过 → 它给的读取位置一定比 Client 手里的小；以 `data.cursor < since` 为准而不是只看 reset 标记：
      // 漏标记时也必须自愈，否则 entries 恒空且 truncated 不为真——静默失联。
      const regressed = since !== null && data.cursor < since
      if (data.reset === true || regressed) {
        reset = true
        stats.resets += 1
      }
      // Host 会用 MAX_FEED_ENTRIES 截断大响应（本轮只给前 N 条），此时不能直接跳到 data.cursor（那 N 条之后的条目
      // 会被静默跳过），改用**最后一条实际返回的 seq** 推进。
      const last = entries.length ? entries[entries.length - 1] : null
      // 被停用打断时（stopped）只能用**已经处理到的那条**推进：跳到整批末条会把没处理的条目连读取位置一起跳过。
      const next = stopped
        ? (lastSeenSeq !== null ? lastSeenSeq : cursorNow())
        : (last && Number.isFinite(last.seq) ? last.seq : data.cursor)
      if (data.more === true) stats.morePages += 1
      setCursor(next)
    }
    stats.cursor = cursorNow()
    // 增量缺口与读取位置重置必须**让用户看得见**：被跳过的条目是静默漏报，只进诊断计数会被当成"都收到了"。
    // Host 的 errors / detailDropped 是累计计数，所以一律看增量。
    const host = stats.host || {}
    const hostErrors = Number(host.errors) || 0
    const hostDropped = Number(host.detailDropped) || 0
    const errDelta = Math.max(0, hostErrors - lastHostErrors)
    const dropDelta = Math.max(0, hostDropped - lastHostDropped)
    lastHostErrors = hostErrors
    lastHostDropped = hostDropped
    const warn = []
    if (data && data.truncated) warn.push('gap: host ring buffer evicted entries')
    if (reset) warn.push('host cursor reset')
    if (errDelta) warn.push('host fetch failures +' + errDelta)
    if (dropDelta) warn.push('host detail drops +' + dropDelta)
    // stale 有**自己的状态**（中灰「数据已过期」），不折叠进 degraded：它表示"源在响应、但给的是旧数据"。
    reportStatus({
      status: host.stale ? 'stale' : (warn.length ? 'degraded' : 'open'),
      detail: 'received ' + stats.received + ' increments · ' + hostDetail() +
        (host.stale ? ' · upstream data stale' : '') +
        (warn.length ? ' · ' + warn.join('；') : ''),
    })
    return { applied, cursor: cursorNow(), truncated: !!(data && data.truncated), reset, more: !!(data && data.more) }
  }

  /** 状态文案里的 Host 侧摘要：只在本源当前有问题时才值得占位置（正常时保持简短）。 */
  function hostDetail() {
    const h = stats.host
    if (!h) return 'last fetch ' + new Date(stats.lastAt).toLocaleTimeString()
    const errs = Number(h.errors) || 0
    const idle = Number(h.idleSkips) || 0
    return 'host polls ' + (Number(h.polls) || 0) + (errs ? ' · fails ' + errs : '') +
      (idle ? ' · idle ' + idle : '')
  }

  function pollSerial() {
    if (inFlight) return inFlight
    inFlight = pollOnce().finally(() => {
      inFlight = null
      // 给设置页的「全球源状态」留一份快照（不触发 store 重渲）
      feedStatsOf[id] = Object.assign({}, stats, { running })
    })
    return inFlight
  }

  function schedule(delay) {
    if (!running) return
    // 与其他定时器一致的纪律：排新的之前先清旧的，少这一行就意味着多一条自续的轮询链（上游请求速率翻倍）。
    if (timer) { clearTimeout(timer); timer = null }
    timer = setTimeout(async () => {
      timer = null
      // 灾种开关的判断放在 pollOnce 里：那里会如实上报「已关闭」状态（不产生任何网络请求）。
      try { await pollSerial() } catch (err) { onError(err) }
      schedule(intervalMs)
    }, delay)
  }

  return {
    id,
    path,
    cursorKey,
    start() {
      if (running) return
      stopped = false
      running = true
      schedule(firstDelayMs)
    },
    stop() {
      stopped = true
      running = false
      if (timer) { clearTimeout(timer); timer = null }
      // 中止在途请求：插件停用后回来的响应不该再 apply（响铃 / 弹窗 / 写历史）
      if (abortCtl) { try { abortCtl.abort() } catch (err) { /* 已结束等忽略 */ } abortCtl = null }
    },
    pollOnce,
    pollSerial,
    stats() { return Object.assign({}, stats, { running }) },
    /** 测试与诊断用：当前的读取位置（尚未对齐时为 0）。 */
    cursor() { return cursorNow() },
    /** 测试与诊断用：本客户端是否还没有读取位置（首轮会走 tail 对齐）。 */
    hasCursor() { return since !== null },
  }
}
