// ============================================================================
// dsh-quake-alert · client/src/12-websocket.js
//
// 作用：P2PQuake WebSocket 连接管理。
// 内容：连接/断开状态机、指数退避重连（1s→60s 封顶）、数据源切换（正式/沙箱）、
//       建连超时看门狗、「久无数据」的半开连接检测（主动重连）、消息转交主链。
// 依赖：00-i18n（默认的连接说明文案）、01-constants、02-storage（读数据源）、11-pipeline（handleRaw）。
// 背景：P2PQuake 约每 10 分钟强制断线，重连是常态路径而非异常。
// ============================================================================

import { WS_URL, SANDBOX_URL, RECONNECT_BASE, RECONNECT_MAX, p2pTimeToIso } from './01-constants.js'
import { currentCfg } from './03-settings-bridge.js'
import { publishStatus } from './05g-source-health.js'
import { handleRaw } from './11-pipeline.js'
import { t } from './00-i18n.js'

/**
 * 建连看门狗（0.3.3）：浏览器在"连不上又不断开"的半开状态下不会给任何事件——既没有 onopen
 * 也没有 onclose。没有这个看门狗，状态点会永远停在「连接中…」并且不会有任何重连。
 * 下面的久无数据检测以 onopen 为基准，覆盖不到建连这一段；两者互补。
 */
const CONNECT_TIMEOUT_MS = 15 * 1000

/**
 * 半开连接检测（0.3.2）：NAT / 代理静默断开时 TCP 已经不通，但浏览器**不会**触发 onclose，
 * 于是状态点一直是绿色的「已连接」，实际一条推送都收不到——对预警产品这是最危险的失效模式
 * （用户以为自己在被保护）。P2PQuake 约每 10 分钟强制断线一次，正常情况下 lastActivityAt
 * 会被 onclose → 重连 → onopen 不断刷新，所以 20 分钟毫无活动只可能是连接真的死了。
 */
const STALE_AFTER_MS = 20 * 60 * 1000
const STALE_CHECK_MS = 60 * 1000

/**
 * 断线补拉（0.9.4 / C5）。
 *
 * P2PQuake 的 WS **没有回放**：断线窗口（退避 1–60 秒，加上网络中断本身可能是几分钟）里发出去的
 * 551 / 552 / 556 就此永久丢失——而 EEW 的有效窗口只有几十秒，等价于漏报。
 * 官方 REST `/v2/history` 返回的正是**与 WS 推送同一套 JSON**，所以补拉之后走同一条主链：
 * 消息级去重按 id 生效，与直播流重叠的部分不会二次响铃（跨标签页认领也照旧）。
 *
 * 三条边界：
 *   · **只在重连时补**。首次连接没有"缺口"可言——用户刚打开页面时把几小时前的旧警报当新闻
 *     刷屏，是这套系统明确不做的。
 *   · 窗口取 2 分钟，与 Host 侧 JMA 轮询器的冷启动容差同一个量级与理由：覆盖常见的网络抖动与
 *     休眠唤醒，又不把真正过期的电文当实时警报播出去。
 *   · 时间认不出的条目不补（补拉是恢复路径，宁可少补一条也不播一条说不清时间的旧消息），
 *     但会计数（`backfillSkipped`）——它是可见的。
 */
export const P2P_HISTORY_URL = 'https://api.p2pquake.net/v2/history'
export const P2P_HISTORY_CODES = [551, 552, 556]
export const P2P_HISTORY_WINDOW_MS = 2 * 60 * 1000
export const P2P_HISTORY_LIMIT = 20
/** 两次补拉之间的最小间隔：重连可能连续发生（退避最密 1 秒一次），别把 REST 打成洪水。 */
export const P2P_HISTORY_MIN_GAP_MS = 5 * 1000

// ---------- WebSocket 客户端 ----------
/**
 * @param {object} [opts] 不传即 P2PQuake（日本链路），行为与 0.3.x 完全一致。
 * @param {string} [opts.sourceId] 状态汇报用的源标识（多源聚合，见 07-store 的 pushSource）
 * @param {string} [opts.label] 状态文案里的源名
 * @param {() => string} [opts.urlOf] 当前应连的地址（P2PQuake 会在正式源 / 沙箱源之间切换）
 * @param {number} [opts.staleAfterMs] 「久无数据」判据；0 = 关闭（消息稀疏的源必须关掉）
 * @param {(url: string) => string} [opts.openDetail] 连上后的状态文案
 * @param {(raw: object, cfg: object) => void} [opts.onRaw] 消息处理入口
 */
function createWsClient(opts) {
  const o = opts || {}
  const sourceId = o.sourceId || 'p2pquake'
  const label = o.label || 'P2PQuake'
  const staleAfterMs = o.staleAfterMs === undefined ? STALE_AFTER_MS : o.staleAfterMs
  const staleCheckMs = o.staleCheckMs === undefined ? STALE_CHECK_MS : o.staleCheckMs
  const connectTimeoutMs = o.connectTimeoutMs === undefined ? CONNECT_TIMEOUT_MS : o.connectTimeoutMs
  const urlOf = o.urlOf || (() => (currentCfg().source === 'sandbox' ? SANDBOX_URL : WS_URL))
  // 默认连接说明**在调用时取词**（0.9.3）：写死在模块里的中文会让英文 / 繁体界面在「来源状态」
  // 与侧边栏悬停提示里露出一整句中文。取词放在函数体里，切语言后由 recomputeStatus 重算。
  const openDetailOf = o.openDetail || ((url) => (url.indexOf('sandbox') !== -1
    ? t('source.p2pSandbox')
    : t('source.p2pConnected')))
  const onRaw = o.onRaw || ((raw, cfg) => handleRaw(raw, cfg))
  // 上报经 publishStatus 合成（0.5.4）：本层只知道**连接**状态，而展示状态还要叠加
  // 数据健康（蓝点）与停更。此前直接 pushSource，于是"一次常态断线"（P2PQuake 约每 10 分钟
  // 必发生一次）就会把一条 schema-error 蓝点冲成 reconnecting，而上游其实一直在坏——
  // 用户看到的是"链路在重连"，看不到"数据我们读不懂"（两者要采取的行动完全不同）。
  const report = (patch) => publishStatus(sourceId, Object.assign({ label }, patch))
  let ws = null
  let timer = null
  let staleTimer = null
  let connectTimer = null
  let stopped = false
  let retries = 0
  let lastActivityAt = 0 // 最近一次 onopen / onmessage 的时刻
  let processFails = 0 // 连续的消息处理失败次数（0.4.1：主链异常必须可见）
  let visibilityBound = false

  /**
   * 页面从冻结 / 休眠中恢复时刷新活动时刻（0.4.1）。
   *
   * 后台标签页被冻结、系统休眠期间，消息事件根本不会被派发；恢复后如果立刻用「20 分钟无活动」
   * 判死，就会把一条本来健康的连接拆掉重连（P2PQuake 没有回放，冻结期间缓冲里的 551/556
   * 就此永久丢失——EEW 的有效窗口只有几十秒，等价漏报）。恢复可见时给一个完整的新窗口。
   */
  function onVisibilityChange() {
    if (stopped) return
    const doc = typeof document !== 'undefined' ? document : null
    if (!doc || doc.visibilityState !== 'visible') return
    if (!ws || ws.readyState !== 1) return
    lastActivityAt = Date.now()
    armStaleWatch()
  }
  function bindVisibility() {
    const doc = typeof document !== 'undefined' ? document : null
    if (!doc || visibilityBound || typeof doc.addEventListener !== 'function') return
    doc.addEventListener('visibilitychange', onVisibilityChange)
    visibilityBound = true
  }
  function unbindVisibility() {
    const doc = typeof document !== 'undefined' ? document : null
    if (!doc || !visibilityBound || typeof doc.removeEventListener !== 'function') return
    doc.removeEventListener('visibilitychange', onVisibilityChange)
    visibilityBound = false
  }

  function stopStaleWatch() {
    if (staleTimer) { clearTimeout(staleTimer); staleTimer = null }
  }
  function clearConnectWatch() {
    if (connectTimer) { clearTimeout(connectTimer); connectTimer = null }
  }
  /** 建连阶段排一个超时：到点还没动静就放弃这条连接，按退避重来。 */
  function armConnectWatch(target) {
    clearConnectWatch()
    if (stopped || !(connectTimeoutMs > 0)) return
    connectTimer = setTimeout(() => {
      connectTimer = null
      if (stopped || ws !== target) return // 已经换过连接 / 已清理，忽略这次
      // 先关掉这条卡住的连接：否则 1 秒后 connect() 只是覆盖 ws 引用，旧 socket 无人回收
      teardown()
      scheduleReconnect('connect timeout (no response)')
    }, connectTimeoutMs)
    if (connectTimer && typeof connectTimer.unref === 'function') connectTimer.unref()
  }
  /** 排下一次「是否久无数据」的检查；检测关闭（staleAfterMs <= 0）时不排。 */
  function armStaleWatch() {
    stopStaleWatch()
    if (stopped || !(staleAfterMs > 0) || !(staleCheckMs > 0)) return
    staleTimer = setTimeout(() => {
      staleTimer = null
      if (stopped) return
      if (lastActivityAt && Date.now() - lastActivityAt > staleAfterMs) {
        // 这条连接确实已经死了，不必再等退避：立刻换一条，onopen 会刷新 lastActivityAt
        report({ status: 'reconnecting', retries, detail: 'stale link · reconnecting' })
        teardown()
        connect()
        return
      }
      armStaleWatch()
    }, staleCheckMs)
    if (staleTimer && typeof staleTimer.unref === 'function') staleTimer.unref()
  }

  /** @param {string} [reason] 断开原因，写进状态文案（onclose 时留空用默认文案）。 */
  const scheduleReconnect = (reason) => {
    if (stopped) return
    retries += 1 // 从「第 1 次」开始计数，退避序列 1s → 2s → 4s → … → 60s 封顶
    report({
      status: 'reconnecting',
      retries,
      detail: (reason || 'disconnected') + ' · retry ' + retries,
    })
    const delay = Math.min(RECONNECT_MAX, RECONNECT_BASE * Math.pow(2, retries - 1))
    timer = setTimeout(connect, delay)
  }
  let everOpened = false
  let lastBackfillAt = 0
  /** 补拉的计数（诊断 / 测试用）：试了几次、补进几条、因时间过期跳过几条、失败几次。 */
  const backfillStats = { attempts: 0, fed: 0, skipped: 0, errors: 0, lastAt: 0, lastDetail: '' }
  /** 一条历史消息的时间（毫秒）。P2PQuake 的 `time` 与 551/556 的 issue / earthquake.time 都试。 */
  function historyTimeMs(raw) {
    const cands = [
      raw && raw.time,
      raw && raw.issue && raw.issue.time,
      raw && raw.earthquake && raw.earthquake.time,
    ]
    for (const c of cands) {
      const iso = p2pTimeToIso(String(c === undefined || c === null ? '' : c))
      // 局部变量不叫 `t`（那是 00-i18n 的取词函数，遮蔽了本函数里的 t('key') 会去调 Date.parse）
      const ms = Date.parse(iso)
      if (Number.isFinite(ms)) return ms
    }
    return NaN
  }
  const fetchJson = o.fetchJson || ((url) => window.fetch(url).then((res) => {
    if (!res || !res.ok) throw new Error('HTTP ' + (res ? res.status : '?'))
    return res.json()
  }))
  /**
   * 重连后补拉断线窗口里的消息（见文件头 P2P_HISTORY_* 的说明）。**逐条**交给主链：
   * 一条坏数据不该让整次补拉白做，而且主链自己就是按条去重的。
   */
  function backfillAfterGap() {
    if (stopped) return
    const now = Date.now()
    if (lastBackfillAt && now - lastBackfillAt < P2P_HISTORY_MIN_GAP_MS) return
    lastBackfillAt = now
    backfillStats.attempts += 1
    const url = P2P_HISTORY_URL + P2P_HISTORY_CODES.map((c) => '&codes=' + c).join('') + '&limit=' + P2P_HISTORY_LIMIT
    Promise.resolve()
      .then(() => fetchJson(url))
      .then((list) => {
        if (stopped || !Array.isArray(list)) return
        // 由旧到新交给主链：这样后到的（更新的）消息不会先被处理
        const rows = list.map((raw) => ({ raw, t: historyTimeMs(raw) }))
          .filter((r) => r.raw && typeof r.raw === 'object')
          .sort((a, b) => (Number.isFinite(a.t) ? a.t : 0) - (Number.isFinite(b.t) ? b.t : 0))
        for (const r of rows) {
          if (stopped) return
          if (!Number.isFinite(r.t) || (now - r.t) > P2P_HISTORY_WINDOW_MS) {
            backfillStats.skipped += 1
            continue
          }
          try {
            onRaw(r.raw, currentCfg())
            backfillStats.fed += 1
          } catch (err) { backfillStats.errors += 1; backfillStats.lastDetail = String((err && err.message) || err) }
        }
        backfillStats.lastAt = Date.now()
      })
      .catch((err) => {
        // 补拉失败**不改变连接状态**：它只是一条恢复路径，把它算成"源不可达"会让状态点无谓变红
        backfillStats.errors += 1
        backfillStats.lastDetail = String((err && err.message) || err)
      })
  }
  const connect = () => {
    if (stopped) return
    const url = urlOf()
    report({ status: 'connecting', retries, detail: 'connecting · ' + url })
    try { ws = new window.WebSocket(url) } catch (err) {
      scheduleReconnect()
      return
    }
    armConnectWatch(ws)
    ws.onopen = () => {
      clearConnectWatch()
      retries = 0
      processFails = 0
      lastActivityAt = Date.now()
      armStaleWatch()
      report({ status: 'open', retries: 0, detail: openDetailOf(url) })
      // 0.9.4（C5）：**重连**时补拉断线窗口里的消息（首次连接没有缺口）。见 backfillAfterGap。
      const isReconnect = everOpened
      everOpened = true
      if (isReconnect) backfillAfterGap()
    }
    ws.onmessage = (ev) => {
      lastActivityAt = Date.now()
      let raw
      try { raw = JSON.parse(String(ev.data)) } catch (err) { return } // 单条 JSON 坏掉不影响连接
      // 主链**必须单独 try**（0.4.1）。此前 JSON.parse 与 onRaw 共用一个空 catch，
      // 于是 parse / match / handleAlert 里任何确定性异常都被吞掉：socket 正常、状态常绿、
      // 零提醒、无计数——这是比断线更难发现的静默失效（断线至少会变红）。
      try {
        onRaw(raw, currentCfg())
        // 恢复：连续失败之后只要有一条处理成功，就要把状态改回 open（0.4.2）。
        // 原先只在 onopen 时复位，于是 **一次** 主链异常就会让侧边栏永久停在"链路降级"——
        // 用户看到一个错误的黄点，比不显示更糟。
        if (processFails > 0) {
          processFails = 0
          report({ status: 'open', retries, detail: openDetailOf(url) })
        }
      } catch (err) {
        processFails += 1
        report({
          status: 'degraded',
          retries,
          detail: 'processing failed x' + processFails + ': ' + String((err && err.message) || err),
        })
      }
    }
    ws.onerror = () => { /* onclose 统一处理 */ }
    ws.onclose = () => {
      clearConnectWatch()
      stopStaleWatch() // stale 链必须随这条 socket 结束，否则它会脱离连接继续存活
      scheduleReconnect()
    }
  }
  const teardown = () => {
    stopStaleWatch()
    clearConnectWatch()
    if (timer) { clearTimeout(timer); timer = null }
    if (ws) { try { ws.onclose = null; ws.close() } catch (err) {} ws = null }
  }
  return {
    start() {
      // start 必须是 stop 的逆操作（0.5.4）：原来只有 restart() 清 `stopped`，于是
      // "stop 之后再 start"会静默地什么都不做（connect() 第一行就是 `if (stopped) return`）。
      // 当前唯一调用点是入口的一次 start（重配走 restart），所以不是活缺陷——
      // 但 start/stop 与 restart 的语义不对称，任何后来的"重新 start"都会被静默吞掉。
      stopped = false
      retries = 0
      processFails = 0
      bindVisibility()
      connect()
    },
    stop() {
      stopped = true
      teardown()
      unbindVisibility()
      report({ status: 'closed', retries, detail: 'stopped (plugin disabled)' })
    },
    backfillStatsOf() { return Object.assign({}, backfillStats) },
    restart() {
      stopped = false
      retries = 0 // 切数据源后立即从 1s 退避重新开始，而不是沿用上一条连接的退避进度
      processFails = 0
      bindVisibility() // stop() 会解绑；restart 之后这条 socket 同样需要"恢复可见时重置 stale 计时"
      teardown()
      connect()
    },
  }
}

let activeClient = null


// entry 需要把新建的 client 记到模块级 activeClient：跨模块不能写 imported binding
const setActiveClient = (c) => { activeClient = c }

export { createWsClient, activeClient, setActiveClient, CONNECT_TIMEOUT_MS, STALE_AFTER_MS, STALE_CHECK_MS }
