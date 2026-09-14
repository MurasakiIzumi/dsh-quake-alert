// ============================================================================
// dsh-quake-alert · client/src/12b-feed-poll.js
//
// 作用：从 Host 的只读路由拉気象庁电文增量，解析成 Alert 后交给主链
//       ——与 P2PQuake 的 551/552/556 汇到同一个 handleAlert。
// 内容：游标生命周期（持久化 / 首次对齐 / Host 重启恢复）、增量应用、失败容错、
//       启停、诊断计数。
// 依赖：02-storage（游标落盘）、03-settings-bridge（currentCfg）、
//       05b-jma-parser（parseJma）、11-pipeline（handleAlert）。
//
// 为什么拉本地而不是浏览器直连気象庁：Host 是每台机器唯一的外部请求者，多标签页 / 多窗口
// 不会放大请求——気象庁明文要求「一度取得したファイルを再度取得しない」，违反会被封 IP。
// 这里只从回环地址取增量，没有外部成本。
//
// 游标语义（0.3.2 起三种）：
//   · `?since=N`     —— 返回 seq > N 的条目；Host 环缓冲淘汰旧条目时带 truncated，表示中间
//                       有缺口，此时仍然应用已有条目（宁可少报几条，也不要卡住不再前进）。
//   · `?since=tail`  —— **首次启动**（本地还没有游标）只要当前位置、不要历史。若首次就用 0，
//                       刷新页面会把 Host 缓冲里几小时前的旧警报当新闻重放（响铃 + 弹窗）。
//   · 响应 `reset`   —— Host 进程重启后游标从 0 重新计数，此时 Client 手里那个更大的游标会让
//                       `entries` 永远为空（连 truncated 都不为真）→ 静默失联。Host 检出
//                       `since > cursor` 后按 0 补齐并置 reset，Client 据此对齐游标。
// 游标落盘后，刷新 / 新开标签页都从上次的位置继续，不会再重放。
// ============================================================================

import { loadJSON, saveJSON } from './02-storage.js'
import { currentCfg } from './03-settings-bridge.js'
import { parseJma } from './05b-jma-parser.js'
import { parseJmaResult, noteParseResult, noteSourceSuccess, effectiveStatusOf } from './05d-source-contracts.js'
import { handleAlert } from './11-pipeline.js'

/** Host 侧的电文增量路由（与 lib/index.js 的 FEED_PATH 对应）。 */
export const FEED_PATH = '/dsh-quake-alert/feed'
/** 本地拉取间隔：Host 每 60s 拉一次源，这里 15s 拉一次本地缓存，端到端最坏约 75s。 */
export const FEED_POLL_MS = 15 * 1000
/** 启动后首轮延迟：给插件装载、城市表与 host 侧首轮轮询让路。 */
export const FEED_FIRST_DELAY_MS = 3000
/** 游标在 localStorage 里的键（与 history / 配置同域，风格一致）。 */
export const FEED_CURSOR_KEY = 'dsh.quakeAlert.feedCursor'
/** 首次启动的哨兵：还没有游标 → 用 tail 语义对齐位置而不是重放历史。 */
export const FEED_TAIL = 'tail'
/**
 * 各源最近一次轮询结果的**只读快照**（id → stats）。放在模块级对象而不是 store：
 * 轮询每 15 秒一轮，若每轮都 store.push，设置页与侧边栏会被无意义地反复重渲。
 * 设置页自己定时读它（见 13-ui-settings 的「全球源状态」）。
 */
export const feedStatsOf = {}
/** 本地路由的单次请求超时：Host 卡住时不能让 inFlight 一直占着、把整条轮询拖停。 */
export const FEED_FETCH_TIMEOUT_MS = 10 * 1000

/** 读回持久化游标；任何脏数据（非数字 / NaN / 负数）一律当作"没有记录"。 */
function loadFeedCursor(key) {
  const v = loadJSON(key || FEED_CURSOR_KEY, null)
  return (typeof v === 'number' && Number.isFinite(v) && v >= 0) ? Math.floor(v) : null
}
function saveFeedCursor(v, key) {
  if (typeof v === 'number' && Number.isFinite(v) && v >= 0) saveJSON(key || FEED_CURSOR_KEY, Math.floor(v))
}

async function defaultFetchJson(url, signal) {
  const AS = (typeof window !== 'undefined' && window) ? window.AbortSignal : undefined
  const timeout = (AS && typeof AS.timeout === 'function') ? AS.timeout(FEED_FETCH_TIMEOUT_MS) : undefined
  // 组合「请求超时」与「插件停用时中止」两个信号。AbortSignal.any 不可用时退回超时信号
  // （那一轮仍可能跑完，但下面的 stopped 检查会拦住它的 apply）。
  let sig = timeout
  try {
    if (signal && timeout && AS && typeof AS.any === 'function') sig = AS.any([signal, timeout])
    else if (signal) sig = signal
  } catch (err) { sig = timeout }
  const res = await window.fetch(url, { headers: { accept: 'application/json' }, signal: sig })
  if (!res || !res.ok) throw new Error('HTTP ' + (res ? res.status : '?'))
  return res.json()
}

/**
 * @param {object} [opts]
 * @param {string} [opts.id] 源标识（诊断用）
 * @param {string} [opts.path] Host 增量路由；全球源用 `?source=usgs` 这类分派参数
 * @param {string} [opts.cursorKey] 该源自己的游标存储键——多源共用一条键会互相顶掉游标
 * @param {(cfg: object) => boolean} [opts.enabled] 该源当前是否需要拉取（按灾种开关判断）
 * @param {number} [opts.intervalMs]
 * @param {number} [opts.firstDelayMs]
 * @param {(url: string) => Promise<object>} [opts.fetchJson] 注入点（测试用）
 * @param {(patch: object) => void} [opts.onStatus] 状态上报（0.4.1）：把本源的连接 / 失败情况
 *   送进 store，参与整体状态聚合。没有它的话轮询链路整体死掉时侧边栏仍然是绿的。
 * @param {string} [opts.label] 状态文案里的源名
 * @param {(entry: object, cfg: object) => boolean} [opts.apply] 注入点（测试用）
 * @param {() => object} [opts.getCfg] 注入点（测试用）
 * @param {() => (number|null)} [opts.loadCursor] 注入点（测试用；默认读 localStorage）
 * @param {(v: number) => void} [opts.saveCursor] 注入点（测试用；默认写 localStorage）
 * @param {(err: Error) => void} [opts.onError]
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
  // 关掉之后 Client 不再拉增量，Host 侧对应的轮询器也会因 idle 自然停下。
  const enabled = opts.enabled || ((cfg) => (cfg.disasters || {}).weather !== false)
  const loadCursor = opts.loadCursor || (() => loadFeedCursor(cursorKey))
  const saveCursor = opts.saveCursor || ((v) => saveFeedCursor(v, cursorKey))
  const apply = opts.apply || ((entry, cfg) => {
    // 走解析契约（0.4.1）：schema / value 失败会计入数据健康并**不播报**，
    // empty（与本插件无关的电文）只是静静地跳过。
    const res = parseJmaResult(entry && entry.xml, { id: entry && entry.id })
    if (noteParseResult(id, res)) return false
    if (!res.ok) return false
    noteSourceSuccess(id)
    handleAlert(res.alert, cfg)
    return true
  })

  // null = 本浏览器还没有游标（首次启动）→ 首轮用 tail 对齐，不重放 Host 缓冲里的历史
  let since = null
  try {
    const stored = loadCursor()
    if (typeof stored === 'number' && Number.isFinite(stored) && stored >= 0) since = Math.floor(stored)
  } catch (err) { /* 读盘失败按首次启动处理 */ }
  let timer = null
  let running = false
  let stopped = false // 插件停用：在途轮询的响应回来后不该再 apply
  let inFlight = null
  let abortCtl = null
  let lastStatusKey = ''
  // Host 的 errors / detailDropped 是**进程内累计**计数（永不归零）。要判断"这一轮又失败了"
  // 必须看增量——直接判"非 0 就告警"会让一次瞬时失败之后该源永久停在"链路降级"（0.4.2 修正）。
  let lastHostErrors = 0
  let lastHostDropped = 0
  const stats = { polls: 0, received: 0, applied: 0, errors: 0, truncated: 0, tailSync: 0, resets: 0, morePages: 0, lastAt: 0, cursor: 0, host: null }

  /** 状态上报：只在**变化**时送出去（轮询每 15 秒一轮，每轮都 push 会让设置页反复重渲）。
   *  经过 effectiveStatusOf 合并"数据格式异常"——那是蓝点，优先级高于连接状态：
   *  连接好着呢、只是数据我们读不懂，这个状态不该被下一轮"拉取成功"覆盖掉。 */
  function reportStatus(patch) {
    const eff = effectiveStatusOf(id, patch.status, patch.detail)
    // key **只取状态**：detail 里含"已收到 N 条增量""Host 轮询 N 次"这类单调计数，
    // 用它做 key 会让每轮都判定为"变化"→ 每 15 秒整页重渲一次（正是拆 SourceStatusBlock
    // 想避免的事）。数字本身由 SourceStatusBlock 每 5 秒直接从 feedStatsOf 读，不依赖这里。
    if (eff.status === lastStatusKey) return
    lastStatusKey = eff.status
    try { onStatus(Object.assign({ label }, eff)) } catch (err) { /* UI 回调异常不影响轮询 */ }
  }

  /** 推进游标并落盘（值没变就不写，15s 一次的轮询不必每次都碰 localStorage）。 */
  function setCursor(next) {
    if (!(typeof next === 'number' && Number.isFinite(next) && next >= 0)) return
    const v = Math.floor(next)
    if (v === since) return
    since = v
    try { saveCursor(v) } catch (err) { /* 隐私模式等写盘失败：本次仍以内存游标工作 */ }
  }
  const cursorNow = () => (since === null ? 0 : since)

  async function pollOnce() {
    stats.polls += 1
    // 该源的灾种开关关闭时不必拉增量（Host 侧随后也会据此停轮询）。状态如实上报为「已关闭」，
    // 这样聚合状态不会因为"用户主动关掉了"而显示成异常。
    if (!enabled(getCfg())) {
      reportStatus({ status: 'disabled', detail: '灾种开关已关闭' })
      return { applied: 0, cursor: cursorNow(), skipped: true }
    }
    let data
    // 自持取消器（0.4.1）：插件停用时要能中止在途请求，否则响应回来后仍会 apply
    // → handleAlert → 响铃 / 弹窗 / 写历史（用户以为已经关掉了插件）。
    abortCtl = (typeof window !== 'undefined' && window && typeof window.AbortController === 'function')
      ? new window.AbortController()
      : null
    try {
      // path 可能自带查询串（全球源用 `?source=usgs` 分派），所以要按需选分隔符。
      // stats=1（0.4.1）：把 Host 侧的健康计数一并取回（errors / detailDropped / lastPollAt /
      // idleSkips / bufferSize）。此前 Client 从不带它，于是「上游被墙 / 被限流」与「上游没有新闻」
      // 在界面上完全不可区分——设置页的「最近拉取 2 秒前」说的只是**本地路由**的拉取时刻。
      const sep = path.indexOf('?') === -1 ? '?' : '&'
      data = await fetchJson(
        path + sep + 'since=' + (since === null ? FEED_TAIL : since) + '&stats=1',
        abortCtl ? abortCtl.signal : undefined,
      )
    } catch (err) {
      // 用户主动停用（abort）不是"源不可达"：不上报 unreachable、不计失败、不写失败日志。
      // 否则停用插件会在侧边栏留下一个红点；重载时旧 fiber 的这次上报还会把新会话短暂染红。
      if (stopped) return { applied: 0, cursor: cursorNow(), aborted: true }
      stats.errors += 1
      onError(err)
      reportStatus({ status: 'unreachable', detail: 'Host 增量路由请求失败：' + String((err && err.message) || err) })
      return { applied: 0, cursor: cursorNow() }
    } finally {
      abortCtl = null
    }
    stats.lastAt = Date.now()
    // Host 回显的源必须与请求的一致：Host 比 Client 旧（或参数被改写）时会把 jma 的原文
    // 交给 noaa 的解析器，解析必然失败、而游标仍在推进——那些条目被永久跳过且表面正常。
    if (data && data.source && data.source !== id) {
      const err = new Error('源不匹配：请求 ' + id + '，Host 返回 ' + data.source)
      stats.errors += 1
      onError(err)
      reportStatus({ status: 'unreachable', detail: err.message })
      return { applied: 0, cursor: cursorNow() }
    }
    if (data && data.stats) stats.host = data.stats
    // 首次对齐：Host 只回当前位置。不应用任何条目（即使响应里意外带了也不应用），
    // 否则"刷新页面"又变成了重放历史。
    if (data && data.tail === true) {
      stats.tailSync += 1
      setCursor(data.cursor)
      stats.cursor = cursorNow()
      reportStatus({ status: 'open', detail: '已对齐当前位置 · ' + hostDetail() })
      return { applied: 0, cursor: cursorNow(), tail: true }
    }
    // 本地还没有游标、响应却没带 tail 标记 → 对面是不认 `since=tail` 的旧版 Host
    // （它按 0 把整个环缓冲吐了回来）。这是一次全新会话，取它的游标对齐即可，
    // 不能把这些历史当增量播一遍——否则"只刷新页面、不重启 Host"的升级路径会重放一次。
    // 纯 0.3.2 环境下 tail 请求必定带回 tail 标记，这个分支不会触发。
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
        // 单条电文解析失败不能影响后续条目，也不能让游标停住
        stats.errors += 1
        onError(err)
      }
      if (e && Number.isFinite(e.seq)) lastSeenSeq = e.seq
    }
    stats.applied += applied
    let reset = false
    if (data && Number.isFinite(data.cursor)) {
      // Host 重启过 → 它给的游标一定比 Client 手里的小（两侧同源，正常情况不会倒退）。
      // 以 `data.cursor < since` 为准而不是只看 reset 标记：Host 漏标记时也必须自愈，
      // 否则 Client 会卡在一个比 Host 大的游标上、entries 恒空且 truncated 不为真——静默失联。
      const regressed = since !== null && data.cursor < since
      if (data.reset === true || regressed) {
        reset = true
        stats.resets += 1
      }
      // Host 会用 MAX_FEED_ENTRIES 截断大响应（本轮只给前 N 条）。此时不能直接跳到
      // data.cursor，否则那 N 条之后的条目会被静默跳过；改用**最后一条实际返回的 seq**
      // 推进，下一轮接着取。正常增量路径 entries 很短，等价于 data.cursor。
      const last = entries.length ? entries[entries.length - 1] : null
      // 被停用打断时（stopped）只能用**已经处理到的那条**推进：直接跳到整批末条会把没处理的
      // 条目连同游标一起跳过，下次回来也补不回来（永久漏报）。一条都没处理就原地不动。
      const next = stopped
        ? (lastSeenSeq !== null ? lastSeenSeq : cursorNow())
        : (last && Number.isFinite(last.seq) ? last.seq : data.cursor)
      if (data.more === true) stats.morePages += 1
      setCursor(next)
    }
    stats.cursor = cursorNow()
    // 增量缺口与游标重置必须**让用户看得见**：被跳过的条目是静默漏报，
    // 只进诊断计数的话用户会以为"该收到的都收到了"。
    // Host 的 errors / detailDropped 是累计计数，所以一律看**增量**（见 lastHostErrors 的说明）。
    const host = stats.host || {}
    const hostErrors = Number(host.errors) || 0
    const hostDropped = Number(host.detailDropped) || 0
    const errDelta = Math.max(0, hostErrors - lastHostErrors)
    const dropDelta = Math.max(0, hostDropped - lastHostDropped)
    lastHostErrors = hostErrors
    lastHostDropped = hostDropped
    const warn = []
    if (data && data.truncated) warn.push('有增量缺口（Host 环缓冲已淘汰旧条目）')
    if (reset) warn.push('Host 游标重置过')
    if (errDelta) warn.push('Host 侧新增失败 ' + errDelta + ' 次')
    if (dropDelta) warn.push('Host 侧新增放弃详情 ' + dropDelta + ' 条')
    // stale 有**自己的状态**（中灰「数据已过期」），不折叠进 degraded：它表示"源在响应、
    // 但给的是旧数据"，与"链路有故障"是两类，DESIGN 的六态里也是分开的。
    reportStatus({
      status: host.stale ? 'stale' : (warn.length ? 'degraded' : 'open'),
      detail: '已收到 ' + stats.received + ' 条增量 · ' + hostDetail() +
        (host.stale ? ' · 上游数据已过期（源在响应，但数据是旧的）' : '') +
        (warn.length ? ' · ' + warn.join('；') : ''),
    })
    return { applied, cursor: cursorNow(), truncated: !!(data && data.truncated), reset, more: !!(data && data.more) }
  }

  /** 状态文案里的 Host 侧摘要：只在本源当前有问题时才值得占位置（正常时保持简短）。 */
  function hostDetail() {
    const h = stats.host
    if (!h) return '最近拉取 ' + new Date(stats.lastAt).toLocaleTimeString()
    const errs = Number(h.errors) || 0
    const idle = Number(h.idleSkips) || 0
    return 'Host 轮询 ' + (Number(h.polls) || 0) + ' 次' + (errs ? '，失败 ' + errs + ' 次' : '') +
      (idle ? '，节流跳过 ' + idle + ' 次' : '')
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
    timer = setTimeout(async () => {
      timer = null
      // 灾种开关的判断放在 pollOnce 里：那里会如实上报「已关闭」状态（不产生任何网络请求），
      // 这样聚合状态不会因为"用户主动关掉了"而显示成异常。
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
    /** 测试与诊断用：当前游标（尚未对齐时为 0）。 */
    cursor() { return cursorNow() },
    /** 测试与诊断用：本客户端是否还没有游标（首轮会走 tail 对齐）。 */
    hasCursor() { return since !== null },
  }
}
