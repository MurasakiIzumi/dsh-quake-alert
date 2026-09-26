// ============================================================================
// dsh-quake-alert · client/src/12c-cn-stream.js
//
// 作用：消费大陆源（Wolfx cenc_eew / cenc_eqlist）的 **SSE 推送**，解析成 Alert 后交给主链
//       ——与 P2PQuake 的 551/552/556、気象庁的电文汇到同一个 handleAlert。
// 内容：EventSource 生命周期、断线补齐（Last-Event-ID）、游标持久化、
//       **降级到轮询**（EventSource 不可用 / 连不上 / 连上但不推流）。
// 依赖：02-storage（游标落盘）、03-settings-bridge（currentCfg）、05d（解析契约与健康状态）、
//       11-pipeline（handleAlert）、12b-feed-poll（降级用的轮询客户端）。
//
// 为什么用 SSE 而不是复用 12b 的轮询：EEW 的价值在秒级。轮询是 15 秒一轮，
// 等于把"预警"变成"事后通知"——那正是这个源存在的理由（DESIGN 5.3 的三方案比较）。
//
// 为什么必须自带降级（而不是留给设计里的"降级开关"）：
//   EventSource 是浏览器原生能力，但它**可能被中间设备掐掉**（代理缓冲流式响应、重置长连接），
//   而 `/feed?source=cenc_eew` 那条普通 HTTPS 轮询往往仍然通（DESIGN 11.5）。没有自动降级的话，
//   这些网络下的用户会**静默地只收到轮询源、永远收不到大陆预警**——正是本插件最不能接受的失败形态。
//   所以这里的口径是：只要能证明"SSE 这条链路走不通"，就自动切到轮询，并且**把降级这件事说出来**
//   （状态上报成 degraded），用户与 AI 都看得见。
//   手动开关（用户强制选轮询）与只读诊断快照是 0.5.0 的后续增量。
// ============================================================================

import { loadJSON, saveJSON } from './02-storage.js'
import { currentCfg } from './03-settings-bridge.js'
import { failResult } from './05d-source-contracts.js'
import { noteParseResult, effectiveStatusOf, noteFreshness } from './05g-source-health.js'
import { store } from './07-store.js'
import { handleAlert } from './11-pipeline.js'
import { createFeedClient, FEED_PATH, FEED_CURSOR_KEY } from './12b-feed-poll.js'

/** Host 侧的 SSE 路由（与 lib/index.js 的 STREAM_PATH 对应）。 */
export const STREAM_PATH = '/dsh-quake-alert/stream'
/** 每个源自己的游标键前缀（与 12b 的 FEED_CURSOR_KEY 同域、风格一致）。 */
export const CN_CURSOR_KEY = 'dsh.quakeAlert.streamCursor'
/**
 * 连上之后多久没收到首帧 `sync` 就判定"这条流不通"。
 * 首帧是 Host 立刻写出的，正常情况几十毫秒就到；8 秒足够覆盖慢机器，
 * 又远小于"用户会以为插件坏了"的心理阈值。
 */
export const SSE_PROBE_MS = 8000
/** 连续失败到这个次数就降级到轮询。取 3：容忍一次网络抖动与一次 Host 重启。 */
export const SSE_MAX_FAILS = 3
/** 降级/停用期间的重探间隔：用户重新打开灾种开关后要能回来。 */
export const CN_RECHECK_MS = 5000

/** 读回持久化游标；任何脏数据一律当作"没有记录"。 */
function loadCursorOf(key) {
  const v = loadJSON(key, null)
  return (typeof v === 'number' && Number.isFinite(v) && v >= 0) ? Math.floor(v) : null
}
function saveCursorOf(key, v) {
  if (typeof v === 'number' && Number.isFinite(v) && v >= 0) saveJSON(key, Math.floor(v))
}

/**
 * @param {object} opts
 * @param {string} opts.id 源标识（`cenc_eew` / `cenc_eqlist`）
 * @param {string} [opts.label] 状态文案里的源名
 * @param {string} [opts.path] SSE 路由（含 `?source=`）
 * @param {(entry: object, cfg: object) => boolean} [opts.apply] 逐条应用（15-entry 注入解析契约）
 * @param {(cfg: object) => boolean} [opts.enabled] 该源当前是否需要消费（按灾种开关判断）
 * @param {(patch: object) => void} [opts.onStatus] 状态上报
 * @param {(err: Error) => void} [opts.onError]
 * @param {(url: string) => object} [opts.createEventSource] 注入点（测试用）
 * @param {() => object} [opts.createFallback] 降级客户端工厂（测试用；默认建一个 12b 的轮询客户端）
 * @param {() => object} [opts.getCfg]
 * @param {() => object} [opts.loadCursor] / @param {(v: number) => void} [opts.saveCursor]
 * @param {number} [opts.probeMs] / @param {number} [opts.maxFails]
 */
export function createCnStream(opts = {}) {
  const id = opts.id
  const label = opts.label || id
  const path = opts.path || (STREAM_PATH + '?source=' + id)
  const cursorKey = opts.cursorKey || (CN_CURSOR_KEY + '.' + id)
  const getCfg = opts.getCfg || currentCfg
  const onError = opts.onError || (() => {})
  const onStatus = opts.onStatus || (() => {})
  const apply = opts.apply || (() => false)
  const enabled = opts.enabled || (() => true)
  const probeMs = opts.probeMs === undefined ? SSE_PROBE_MS : opts.probeMs
  const maxFails = opts.maxFails === undefined ? SSE_MAX_FAILS : opts.maxFails
  const loadCursor = opts.loadCursor || (() => loadCursorOf(cursorKey))
  const saveCursor = opts.saveCursor || ((v) => saveCursorOf(cursorKey, v))
  const createEventSource = opts.createEventSource
    || ((url) => new window.EventSource(url))
  // 定时器注入点：探针超时与周期检查都靠它，测试要能确定性地推进（不真等 8 秒 / 5 秒）
  const setTimer = opts.setTimer || ((fn, ms) => setTimeout(fn, ms))
  const clearTimer = opts.clearTimer || ((timer) => clearTimeout(timer))
  // 降级工厂：默认按 12b 的轮询客户端建一个（`?source=` 分派，Host 侧早就支持）。
  // createFeedClient 也可注入：这样"降级客户端拿了哪个游标键"能被直接断言——那正是
  // "降级期间静默漏掉一段条目"的成因，光看 mode 有没有变成 poll 是测不出来的。
  const makeFeedClient = opts.createFeedClient || createFeedClient
  const createFallback = opts.createFallback || (() => makeFeedClient({
    id,
    label,
    path: FEED_PATH + '?source=' + id,
    // 与 SSE 用**同一个**游标键：两侧的 seq 都来自 Host 同一个源的游标，所以降级时能无缝接续。
    // 用各自独立的键（原先的 FEED_CURSOR_KEY）会让轮询从 `since=tail` 起步，SSE 挂掉到降级生效
    // 之间 Host 缓冲里的条目被静默跳过——那是一个真实的漏报窗口。
    cursorKey: CN_CURSOR_KEY + '.' + id,
    enabled,
    // 不是 onStatus：降级态下轮询侧的 "open" 会把"已降级"盖掉，必须合成一条（见 fallbackStatus）。
    onStatus: fallbackStatus,
    onError,
    apply,
  }))

  let since = null
  try {
    const stored = loadCursor()
    if (typeof stored === 'number' && Number.isFinite(stored) && stored >= 0) since = Math.floor(stored)
  } catch (err) { /* 读盘失败按首次启动处理 */ }

  let running = false
  let source = null // EventSource 实例
  let probeTimer = null
  let tickTimer = null
  let fallbackClient = null
  let mode = 'idle' // idle | sse | poll | disabled
  let consecutiveFails = 0
  let sawSyncThisConn = false
  let lastStatusKey = ''
  let inFallback = false
  /** 当前的轮询是"用户选的"还是"自动降级来的"——只有前者能自动升回 SSE。 */
  let fallbackManual = false
  const stats = {
    mode: 'idle', connections: 0, syncs: 0, received: 0, applied: 0, errors: 0,
    sseErrors: 0, probeTimeouts: 0, fallbacks: 0, fallbackManual: false, truncated: 0, resets: 0,
    // stale（源可达但数据是旧的）：由 Host 的 sync / status 帧告知，Client 自己判不出来
    // ——"没有新 entry"与"这几天确实没有地震"在本地长得一模一样。
    stale: false, dataTime: 0,
    lastAt: 0, lastEventAt: 0, cursor: 0, frozen: false, lastDetail: '',
  }

  /** 用户在设置页选了「强制轮询」（`cnTransport: 'poll'`）？默认 'auto'。 */
  const wantPoll = (cfg) => String((cfg && cfg.cnTransport) || 'auto') === 'poll'

  const cursorNow = () => (since === null ? 0 : since)
  // 注册到表里（实时读取，见 cnStreamRegistry 的说明）
  cnStreamRegistry[id] = {
    stats: () => Object.assign({}, stats, { running, hasCursor: since !== null, fallbackActive: inFallback }),
    mode: () => mode,
  }
  /**
   * @param {number} next
   * @param {boolean} [force] Host 明确说"游标重置过"（它重启 / 时钟回拨）时**必须允许回退**，
   *   否则本地游标永远卡在一个比 Host 大的值上，之后每次重连都触发 reset + 全量重放。
   *   12b 的轮询路径有等价的自愈（`regressed`），SSE 这条此前缺失（0.5.1 review 的 D 类残留）。
   */
  function setCursor(next, force) {
    if (!(typeof next === 'number' && Number.isFinite(next) && next >= 0)) return
    const v = Math.floor(next)
    if (v === since) return
    // 游标只前进：SSE 的补发与实况可能交错到达，回退会让"断线补齐"重复投递
    if (!force && since !== null && v < since) return
    since = v
    stats.cursor = v
    try { saveCursor(v) } catch (err) { /* 隐私模式等写盘失败：本次仍以内存游标工作 */ }
  }

  /**
   * 状态上报。`k` 是去重键，**不取 detail**：detail 里含"已收到 N 条"这类单调计数，
   * 用它做键会每轮都判定为"变化"→ 设置页反复重渲。
   * 但键也不能只取 status：降级（degraded）与"出错但正在自动重连"是同一个 status，
   * 却是完全不同的两件事——后者能自己恢复，前者意味着链路已经变了、必须让用户知道。
   * 所以由调用方给一个稳定的**语义**键，默认退回 status。
   */
  function reportStatus(patch, k) {
    stats.lastDetail = String(patch.detail || '')
    const eff = effectiveStatusOf(id, patch.status, patch.detail)
    const key = k || eff.status
    // 除自己的去重键，还要比 **store 里当前实际的状态**（0.5.4）：探针（12d）、健康层（05g）
    // 与 WS 连接层会写同一个源；若它们刚把展示状态改成别的值，而这里因为"自己的键没变"就
    // 不上报，那个被覆盖的状态会永久留在界面上（12b 侧同款修正，理由见 12b-feed-poll.js）。
    const cur = ((store.sources || {})[id] || {}).status
    if (key === lastStatusKey && cur === eff.status) return
    lastStatusKey = key
    try { onStatus(Object.assign({ label }, eff)) } catch (err) { /* UI 回调异常不影响链路 */ }
  }

  /**
   * 降级态下，轮询客户端（12b）的上报要经过这一层再出去。
   *
   * 为什么必须包一层：12b 的客户端有**自己独立的**状态去重键（初值空），所以降级之后它第一次
   * 成功轮询就会报一条 `open`——"轮询这条路通了"本身是真的，但它会把 12c 刚报出去的
   * "已降级为轮询"整条覆盖掉：聚合状态回绿、侧边栏悬停详情里只剩正常源。而 DESIGN 11.5 要求
   * 降级**必须让用户看见**（它意味着延迟从秒级变成最长 15 秒）。
   * 处理方式是把两者**合并成一条**：状态取"降级"（或用户手动选择），细节把轮询侧的信息附上。
   * 键带上轮询侧的状态，这样它自己从 open 变 degraded / schema-error 时仍会重新上报。
   */
  function fallbackStatus(patch) {
    if (!inFallback) return
    const p = patch || {}
    reportStatus({
      status: fallbackManual ? 'disabled' : 'degraded',
      detail: (fallbackManual ? '已按设置选择轮询' : 'SSE 推送不可用 → 已降级为轮询') +
        '（延迟最长 15 秒）' + (p.detail ? ' · ' + String(p.detail) : ''),
    }, 'fallback:' + String(p.status || ''))
  }

  function closeSource() {
    if (probeTimer) { clearTimer(probeTimer); probeTimer = null }
    const s = source
    source = null
    if (s) {
      try { s.onerror = null; s.onmessage = null } catch (err) { /* 忽略 */ }
      try { s.close() } catch (err) { /* 已关闭 */ }
    }
  }

  /**
   * 切到轮询。
   * @param {string} reason 人话原因（会出现在状态里，所以要说清是"哪条链路不行了"）
   * @param {boolean} [manual] true = 用户在设置页选了「强制轮询」，false/缺省 = 自动降级。
   *   区别只在能不能自动升回 SSE：自动降级不再升回（链路既然证明过不通，反复试探只是抖动），
   *   而**手动**选择是可以撤销的——用户改回「自动」就该回到 SSE。
   */
  function activateFallback(reason, manual) {
    if (inFallback) return
    // **先建客户端，成功之后才置位**（0.5.4）。原来的顺序是 `inFallback = true` → `mode='poll'`
    // → `closeSource()` → 建客户端，而建失败时直接 return：于是 inFallback 锁死、SSE 已关、
    // fallbackClient 仍是 null，tick 的四条分支没有一条能再建起链路（只有刷新页面），
    // 而设置页与诊断显示的是"已降级为轮询"——用户以为在被保护，实际一条预警都收不到。
    // 这恰是本文件头写明的、最不能接受的那种形态。
    let client = null
    try {
      client = createFallback()
    } catch (err) {
      onError(err)
      // 回滚到 idle 并如实上报。此后：用户显式选了「强制轮询」时 tick 会每 5 秒重试一次；
      // 自动降级来的（wantPoll 为假）不再重试——SSE 已经证明不通、轮询客户端又建不起来，
      // 此时显示"无法连接"就是全部能做的，继续静默地假装已降级才是错的。
      inFallback = false
      fallbackManual = false
      mode = 'idle'
      stats.mode = mode
      reportStatus({ status: 'unreachable', detail: '降级到轮询时建立客户端失败：' + String((err && err.message) || err) })
      return
    }
    inFallback = true
    fallbackManual = manual === true
    stats.fallbacks += 1
    stats.fallbackManual = fallbackManual
    mode = 'poll'
    stats.mode = mode
    closeSource()
    fallbackClient = client
    try { fallbackClient.start() } catch (err) { onError(err) }
    // 降级必须**说出来**：否则用户看到"一切正常"却收不到预警（本插件最不能接受的形态）。
    // 去重键显式给 'fallback'：进入降级之前刚上报过 degraded（"出错、正在重连"）是同一个
    // status，若按 status 去重，这条"已降级"会被自己的上一条吃掉——而降级是不能被静默的。
    reportStatus({
      status: fallbackManual ? 'disabled' : 'degraded',
      detail: (fallbackManual ? '已按设置选择轮询' : 'SSE 推送不可用（' + reason + '）→ 已降级为轮询') +
        '（延迟从秒级变为最长 15 秒）',
    }, 'fallback')
  }

  /** 从轮询升回 SSE（只有**手动**选的轮询会被自动升回）。 */
  function leaveFallback() {
    if (!inFallback) return
    inFallback = false
    fallbackManual = false
    if (fallbackClient) { try { fallbackClient.stop() } catch (err) { /* 忽略 */ } }
    fallbackClient = null
    mode = 'idle'
    stats.mode = mode
    consecutiveFails = 0
    connectSse()
  }

  /**
   * 单一的周期检查（每 5 秒）。用**一个**定时器同时管三个方向，因为它们会互相打架：
   *   · 灾种开关被关掉 → 主动断开 SSE（不再读 `/stream`，Host 侧十分钟后自然断开与 Wolfx 的连接）
   *   · 灾种开关又打开 → 恢复消费
   *   · 设置页的「链路」选择变了 → 强制轮询 ↔ 自动（手动选择的可以撤销，自动降级的不再升回）
   * 分成多个定时器容易写出"关掉之后再也回不来"这种半途状态。
   */
  function scheduleTick() {
    if (!running) return
    if (tickTimer) { clearTimer(tickTimer); tickTimer = null }
    tickTimer = setTimer(() => {
      tickTimer = null
      if (!running) return
      // 整段兜错：这个 tick 是**唯一**的恢复链（灾种开关往返、手动 / 自动链路切换都靠它），
      // 一次抛错就会让它不再 self-reschedule，之后所有恢复都失效。12b 的等价处（schedule）
      // 也包了 try/catch。reschedule 放在 catch 之外，保证无论成败都会重排。
      try {
        const cfg = getCfg()
        const on = enabled(cfg)
        if (!on) {
          if (mode !== 'disabled') enterDisabled()
        } else if (mode === 'disabled') {
          consecutiveFails = 0
          // 恢复消费时**同样要先看用户的链路选择**：选了「强制轮询」就不该先建一条 SSE
          //（那既白占一条 Wolfx 连接，又会在 8 秒探针超时后谎报一次"连上但不推流"）。
          // 这与 start() 里"一开始就不建 SSE"是同一个不变量。
          if (wantPoll(cfg)) activateFallback('设置里选择了强制轮询', true)
          else connectSse()
        } else if (wantPoll(cfg)) {
          // 用户选了「强制轮询」。**已经在轮询（自动降级来的）时也要认下这个选择**：
          // 否则 fallbackManual 永远是 false，用户之后改回「自动」时下面那条 leaveFallback
          // 分支不成立 → 永久停在轮询，只能刷新页面才回得去。
          if (!inFallback) activateFallback('设置里选择了强制轮询', true)
          else if (!fallbackManual) {
            fallbackManual = true
            stats.fallbackManual = true
            reportStatus({ status: 'disabled', detail: '已按设置选择轮询（延迟最长 15 秒）' }, 'fallback:manual')
          }
        } else if (inFallback && fallbackManual) {
          // 用户改回「自动」：手动选的轮询要能撤销。自动降级的不升回——那条链路已经证明过不通。
          leaveFallback()
        }
      } catch (err) { onError(err) }
      scheduleTick()
    }, CN_RECHECK_MS)
    if (tickTimer && typeof tickTimer.unref === 'function') tickTimer.unref()
  }

  function connectSse() {
    if (!running || source) return
    sawSyncThisConn = false
    stats.connections += 1
    const url = path + (path.indexOf('?') === -1 ? '?' : '&') +
      // 页面首次建立连接时带上持久化游标：刷新 / 重开标签页都能补齐断线期间的事件。
      // 之后浏览器自动重连时会带 `Last-Event-ID`，Host 优先用它（更准）。
      'since=' + (since === null ? 'tail' : since)
    let es
    try {
      es = createEventSource(url)
    } catch (err) {
      onError(err)
      consecutiveFails += 1
      reportStatus({ status: 'unreachable', detail: 'EventSource 建立失败：' + String((err && err.message) || err) })
      return activateFallback('EventSource 建立失败')
    }
    if (!es || typeof es.addEventListener !== 'function') {
      consecutiveFails += 1
      reportStatus({ status: 'unreachable', detail: '当前环境没有可用的 EventSource' })
      return activateFallback('当前环境不支持 EventSource')
    }
    source = es
    mode = 'sse'
    stats.mode = mode
    /**
     * sync 帧算出的告警（增量缺口 / 游标重置 / Host 侧未在运行）。
     *
     * **必须留到 status 帧继续带上**：store.pushSource 是整体替换 status + detail 的，而 status 帧
     * 每 15 秒就来一次；若它只报"已连接"，这三条"有消息被跳过""Host 那边没在跑"的告警会在 15 秒后
     * 自己消失——而它们的条件其实仍然成立。（键相同则不会重新上报，所以正常的降级/恢复去重不受影响。）
     */
    let connWarn = []
    const onSync = (ev) => {
      if (source !== es) return
      sawSyncThisConn = true
      consecutiveFails = 0
      stats.syncs += 1
      stats.lastAt = Date.now()
      let d = null
      try { d = JSON.parse(String(ev && ev.data)) } catch (err) { d = null }
      if (d && d.truncated) stats.truncated += 1
      if (d && d.reset) stats.resets += 1
      stats.frozen = !!(d && d.frozen)
      stats.stale = !!(d && d.stale)
      if (d && Number.isFinite(d.dataTime)) stats.dataTime = d.dataTime
      // 0.5.3（DESIGN 11.9 B）：同一个数据时间也交给探针——探针按**契约里的阈值**判，
      // 而 Host 这一侧继续按它自己的常量判（它能分辨"中继停更"与"数据陈旧"，比我们准）。
      // 两者用的是同一个数值，一致性由回归断言钉住，不靠"记得同时改两处"。
      if (d && Number.isFinite(d.dataTime) && d.dataTime > 0) noteFreshness(id, d.dataTime)
      // Host 明确说重置过（它重启 / 时钟回拨）→ **允许游标回退**并对齐到它的当前位置，
      // 否则本地游标卡在比 Host 大的值上，每次重连都会 reset + 全量重放。
      // 没有补发条目 = 已经在线，游标就是 Host 的当前位置 → 同样对齐，
      // 这样刷新页面不会重复拉一段已经消费过的增量。
      if (d && d.reset && Number.isFinite(d.cursor)) setCursor(d.cursor, true)
      else if (d && Number.isFinite(d.cursor) && (!d.replayed || d.replayed === 0)) setCursor(d.cursor)
      const warn = []
      if (d && d.truncated) warn.push('有增量缺口（Host 环缓冲已淘汰旧条目）')
      if (d && d.reset) warn.push('Host 游标重置过')
      if (d && d.frozen) warn.push('Host 侧该源未在运行')
      connWarn = warn
      // stale 有**自己的状态**（中灰「数据已过期」），不折叠进 degraded：它表示"源在响应、
      // 但给的是旧数据"，与"链路有故障"是两类。口径与 12b 的轮询路径一致。
      reportStatus({
        status: stats.stale ? 'stale' : (warn.length ? 'degraded' : 'open'),
        detail: 'SSE 已连接' + (d ? '（补发 ' + (d.replayed || 0) + ' 条）' : '') +
          ' · 已收到 ' + stats.received + ' 条' +
          (stats.stale ? ' · 上游数据已过期（中继停更）' : '') +
          (warn.length ? ' · ' + warn.join('；') : ''),
      })
    }
    /**
     * Host 的周期状态帧（每 15 秒，兼作 SSE keep-alive）。
     *
     * 它存在的唯一理由是**停更**：停更的形态就是"不再有新 entry"，只看 entry 的话状态会永远
     * 停在连接那一刻；而 48 小时的停更探针是 cenc_eqlist 这个源存在的意义之一（见契约里的
     * staleReason）。Host 不推这一帧的话，默认（SSE）路径下这件事在界面上完全不可见——
     * 只有降级到轮询之后才读得到 /feed 的 stats。
     */
    const onStatusFrame = (ev) => {
      if (source !== es) return
      let d = null
      try { d = JSON.parse(String(ev && ev.data)) } catch (err) { d = null }
      if (!d || typeof d !== 'object') return
      stats.stale = d.stale === true
      if (Number.isFinite(d.dataTime)) stats.dataTime = d.dataTime
      if (Number.isFinite(d.dataTime) && d.dataTime > 0) noteFreshness(id, d.dataTime)
      // 有意**不更新** stats.lastAt：它表示"最近一条数据"，而状态帧每 15 秒必到一次，
      // 更新它会让设置页永远显示"最近数据 0 秒前"，恰好把"其实很久没有数据了"盖掉。
      // 状态里同时带上 sync 那一刻算出的 connected 告警（见 connWarn）：只报"已连接"会把
      // 增量缺口 / 游标重置 / Host 未运行这三条在 15 秒后抹掉，而它们的条件仍然成立。
      reportStatus({
        status: stats.stale ? 'stale' : (connWarn.length ? 'degraded' : 'open'),
        detail: 'SSE 已连接 · 已收到 ' + stats.received + ' 条' +
          (stats.stale ? ' · 上游数据已过期（中继停更）' : '') +
          (connWarn.length ? ' · ' + connWarn.join('；') : ''),
      })
    }
    const onEntry = (ev) => {
      if (source !== es) return
      // 收到真实数据即证明这条链路是通的（0.5.4）：这个计数同时被"连续 N 次没收到首帧"的
      // 降级判定使用，而它此前只在 `sync` 帧归零。于是一条已经健康跑了很久的连接上零星累积的
      // error 会留在计数里，下一次"连上但没首帧"的第一跳就可能直接 ≥ maxFails ——
      // 降级理由写成"连续 N 次未收到首帧"，而实际只失败了一次。
      consecutiveFails = 0
      stats.lastAt = Date.now()
      stats.lastEventAt = Date.now()
      let entry = null
      try { entry = JSON.parse(String(ev && ev.data)) } catch (err) { entry = null }
      if (!entry || typeof entry !== 'object') {
        stats.errors += 1
        noteParseResult(id, failResult('schema', 'SSE 帧不是合法 JSON'))
        return
      }
      stats.received += 1
      if (Number.isFinite(entry.seq)) setCursor(entry.seq)
      try {
        if (apply(entry, getCfg())) stats.applied += 1
      } catch (err) {
        // 单条事件解析失败不能影响后续条目，也不能让游标停住
        stats.errors += 1
        onError(err)
      }
    }
    const onErrorEv = (ev) => {
      if (source !== es) return
      stats.sseErrors += 1
      stats.errors += 1
      consecutiveFails += 1
      // EventSource 自己会按 readyState 重连；这里只负责"什么时候判定这条路走不通"。
      // 已经收到过 sync 的连接再出错，多半是网络抖动或 Host 重启，交给浏览器重连；
      // 一次 sync 都没收到就说明这条流从来没通过。
      reportStatus({
        status: 'degraded',
        detail: 'SSE 连接中断（第 ' + consecutiveFails + ' 次）' + (sawSyncThisConn ? '，正在自动重连' : ''),
      })
      if (!sawSyncThisConn && consecutiveFails >= maxFails) activateFallback('连续 ' + consecutiveFails + ' 次未收到首帧')
    }
    try {
      es.addEventListener('sync', onSync)
      es.addEventListener('entry', onEntry)
      es.addEventListener('error', onErrorEv)
    } catch (err) { /* 极简实现可能不支持命名事件，下面由 probe 兜住 */ }
    // status 与上面分开注册：它是最可有可无的一帧（少了它只是看不到"停更"这一种状态），
    // 不该因为某个实现不认这个事件名而把 sync / entry 的注册一起带走。
    try { es.addEventListener('status', onStatusFrame) } catch (err) { /* 忽略 */ }
    // 首帧探针：连上但**不推流**（代理把流缓冲住了）与"连不上"是两回事，
    // 而 onerror 未必会来。没有这个探针，用户会停在"SSE 已连接"却永远收不到预警。
    if (probeMs > 0) {
      probeTimer = setTimer(() => {
        probeTimer = null
        if (!running || source !== es || sawSyncThisConn) return
        stats.probeTimeouts += 1
        consecutiveFails += 1
        closeSource()
        reportStatus({ status: 'degraded', detail: 'SSE 连上但 ' + probeMs + 'ms 内没有收到任何数据（可能被代理缓冲）' })
        if (consecutiveFails >= maxFails) activateFallback('连上但不推流')
        else connectSse()
      }, probeMs)
      // 与 tickTimer 一致地 unref：这个 8 秒探针不该把 Node 侧的测试进程拖住。
      if (probeTimer && typeof probeTimer.unref === 'function') probeTimer.unref()
    }
  }

  function enterDisabled(patch) {
    mode = 'disabled'
    stats.mode = mode
    closeSource()
    // 停用轮询降级端：它在跑的话也会一直拉
    if (fallbackClient) { try { fallbackClient.stop() } catch (err) { /* 忽略 */ } fallbackClient = null }
    inFallback = false
    reportStatus(patch || { status: 'disabled', detail: '灾种开关已关闭' })
    // 关掉灾种开关 → 不再读 `/feed` 与 `/stream` → Host 侧 10 分钟后自然断开与 Wolfx 的连接
  }

  return {
    id,
    label,
    path,
    start() {
      if (running) return
      running = true
      stats.cursor = cursorNow()
      scheduleTick()
      const cfg = getCfg()
      if (!enabled(cfg)) { enterDisabled(); return }
      // 用户选了「强制轮询」→ 一开始就不建 SSE（也不必先连一次再切，那会白占一条 Wolfx 连接）
      if (wantPoll(cfg)) { activateFallback('设置里选择了强制轮询', true); return }
      connectSse()
    },
    stop() {
      running = false
      closeSource()
      if (tickTimer) { clearTimer(tickTimer); tickTimer = null }
      if (fallbackClient) { try { fallbackClient.stop() } catch (err) { /* 忽略 */ } }
      fallbackClient = null
      inFallback = false
      fallbackManual = false
      mode = 'idle'
      stats.mode = mode
    },
    /** 测试与诊断：当前处于哪条链路。 */
    modeOf() { return mode },
    /** 测试与诊断：当前轮询是用户选的还是自动降级来的。 */
    fallbackIsManual() { return fallbackManual },
    stats() {
      return Object.assign({}, stats, {
        running, hasCursor: since !== null, fallbackActive: inFallback, fallbackManual,
      })
    },
    cursor() { return cursorNow() },
    hasCursor() { return since !== null },
  }
}

/**
 * 大陆源客户端的注册表（id → { stats, mode }），供设置页与诊断快照**实时**读取。
 *
 * 为什么不做成"每隔 N 秒把 stats 拷进一个普通对象"：设置页与其它的源状态块已经是
 * "按需读实时计数"的形态（见 12b 的 feedStatsOf 说明），拷贝出来的快照会滞后一轮，
 * 而这里恰恰要靠计数判断"是不是根本没在收数据"。
 */
export const cnStreamRegistry = {}
