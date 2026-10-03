// ============================================================================
// dsh-quake-alert · client/src/12-websocket.js
// 作用：P2PQuake WebSocket 连接管理（状态机、重连间隔递增、数据源切换、建连超时监控、连接假死检测、断线补拉、转交主链）。
// 依赖：00-i18n、01-constants、02-storage、03-settings-bridge、05g-source-health、11-pipeline。
// ============================================================================

import { WS_URL, SANDBOX_URL, RECONNECT_BASE, RECONNECT_MAX, p2pTimeToIso } from './01-constants.js'
import { currentCfg } from './03-settings-bridge.js'
import { publishStatus } from './05g-source-health.js'
import { handleRaw } from './11-pipeline.js'
import { onResume } from './12f-resume.js'
import { t } from './00-i18n.js'

/** 建连超时监控：连接假死时浏览器既不给 onopen 也不给 onclose，没有它状态点会永远停在「连接中…」。 */
const CONNECT_TIMEOUT_MS = 15 * 1000

/** 连接假死检测：NAT / 代理静默断开时浏览器不触发 onclose，状态点常绿却收不到推送；正常时 lastActivityAt
 *  会被 onclose → 重连 → onopen 不断刷新，所以 20 分钟无活动即判死。 */
const STALE_AFTER_MS = 20 * 60 * 1000
const STALE_CHECK_MS = 60 * 1000

/**
 * 恢复可见 / 焦点时，距上次活动超过它即按「这条连接已经没在转」处理（见 onResumeEvent）。
 * 取 12 分钟的依据是**服务端自己的节奏**：P2PQuake 约每 10 分钟强制断线一次、重连是常态路径，所以
 * 正常情况下 `lastActivityAt` 不会被拉开到 10 分钟以上——超过 12 分钟只可能是这条连接真的死了
 * （休眠 / 锁屏期间 TCP 被掐，而半开连接不会触发任何事件）。取小了会把"切走一会儿再回来"误判成故障。
 */
const RESUME_RECONNECT_MS = 12 * 60 * 1000

/** 断线补拉：P2PQuake 的 WS **没有回放**，断线窗口里的 551 / 552 / 556 永久丢失，而 EEW 的有效窗口只有几十秒。
 *  官方 REST `/v2/history` 返回与 WS 同一套 JSON，补拉后走同一条主链（按 id 去重）；只在重连时补，窗口 2 分钟，
 *  时间认不出的条目不补但计入 backfillSkipped。 */
export const P2P_HISTORY_URL = 'https://api.p2pquake.net/v2/history'
export const P2P_HISTORY_CODES = [551, 552, 556]
export const P2P_HISTORY_WINDOW_MS = 2 * 60 * 1000
export const P2P_HISTORY_LIMIT = 20
/** 两次补拉之间的最小间隔（重连最密 1 秒一次，避免把 REST 打成洪水）。 */
export const P2P_HISTORY_MIN_GAP_MS = 5 * 1000

// ---------- WebSocket 客户端（P2PQuake：约每 10 分钟强制断线，重连是常态路径） ----------
/**
 * @param {object} [opts] 不传即 P2PQuake（日本链路）；urlOf 默认在正式源 / 沙箱源之间切换，staleAfterMs = 0
 *   关闭「久无数据」检测；sourceId / label / openDetail 供状态上报用；onRaw 是消息处理入口。
 */
function createWsClient(opts) {
  const o = opts || {}
  const sourceId = o.sourceId || 'p2pquake'
  const label = o.label || 'P2PQuake'
  const staleAfterMs = o.staleAfterMs === undefined ? STALE_AFTER_MS : o.staleAfterMs
  const staleCheckMs = o.staleCheckMs === undefined ? STALE_CHECK_MS : o.staleCheckMs
  const connectTimeoutMs = o.connectTimeoutMs === undefined ? CONNECT_TIMEOUT_MS : o.connectTimeoutMs
  const urlOf = o.urlOf || (() => (currentCfg().source === 'sandbox' ? SANDBOX_URL : WS_URL))
  // 默认连接说明**在调用时取词**：写死在模块里的中文会让英文 / 繁体界面露出整句中文，切语言后重算。
  const openDetailOf = o.openDetail || ((url) => (url.indexOf('sandbox') !== -1
    ? t('source.p2pSandbox')
    : t('source.p2pConnected')))
  const onRaw = o.onRaw || ((raw, cfg) => handleRaw(raw, cfg))
  // 上报经 publishStatus 合成：本层只知道**连接**状态，展示状态还要叠加数据健康（蓝点）与停更。
  const report = (patch) => publishStatus(sourceId, Object.assign({ label }, patch))
  let ws = null
  let timer = null
  let staleTimer = null
  let connectTimer = null
  let stopped = false
  let retries = 0
  let lastActivityAt = 0 // 最近一次 onopen / onmessage 的时刻
  let processFails = 0 // 连续的消息处理失败次数（主链异常必须可见）
  // 恢复事件的订阅句柄。取代原先只绑 visibilitychange 的做法：系统休眠时页面往往仍是 visible，
  // 一个事件都不来；12f 把可见性 / 焦点 / pageshow 与墙钟跳变合起来判，才盖得住这个场景。
  let resumeBound = false
  let resumeOff = null

  /**
   * 页面从冻结 / 休眠中恢复。分两种情形，判据只有一个——**距上次活动隔了多久**：
   * ① 只隔了一小会儿（切标签页再切回来）：冻结期间消息事件不会被派发，不刷新计时会按「20 分钟无活动」
   *    拆掉一条健康连接（而 P2PQuake 没有回放，冻结期间的消息永久丢失）→ 刷新时刻即可。
   * ② 隔了很久（系统休眠 / 锁屏过夜）：那条 TCP 早被 NAT 或对端掐了，而半开连接**不会**触发任何事件，
   *    浏览器也不会为它给 onclose。此时把 lastActivityAt 刷成"现在"等于替一条僵尸连接续命，界面还会
   *    一直显示绿色——直接换一条：代价是一次握手，收益是确定的活性。
   */
  function onResumeEvent() {
    if (stopped) return
    if (!ws || ws.readyState !== 1) return
    if (lastActivityAt && (Date.now() - lastActivityAt) > RESUME_RECONNECT_MS) {
      report({ status: 'reconnecting', retries, detail: 'resumed after gap · reconnecting' })
      teardown()
      connect()
      return
    }
    lastActivityAt = Date.now()
    armStaleWatch()
  }
  function bindResumeWatch() {
    if (resumeBound || resumeOff) return
    resumeOff = onResume(onResumeEvent)
    resumeBound = true
  }
  function unbindResumeWatch() {
    if (resumeOff) { resumeOff(); resumeOff = null }
    resumeBound = false
  }

  function stopStaleWatch() {
    if (staleTimer) { clearTimeout(staleTimer); staleTimer = null }
  }
  function clearConnectWatch() {
    if (connectTimer) { clearTimeout(connectTimer); connectTimer = null }
  }
  /** 建连阶段排一个超时：到点还没动静就放弃这条连接，按递增的间隔重来。 */
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
        // 这条连接确实已经死了，不必再等下一次重试间隔：立刻换一条，onopen 会刷新 lastActivityAt
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
    retries += 1 // 从「第 1 次」开始计数，重连间隔依次为 1s → 2s → 4s → … → 60s 封顶
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
      // 局部变量不叫 `t`（那是 00-i18n 的取词函数，遮蔽后 t('key') 会变成 Date.parse）
      const ms = Date.parse(iso)
      if (Number.isFinite(ms)) return ms
    }
    return NaN
  }
  const fetchJson = o.fetchJson || ((url) => window.fetch(url).then((res) => {
    if (!res || !res.ok) throw new Error('HTTP ' + (res ? res.status : '?'))
    return res.json()
  }))
  /** 重连后补拉断线窗口里的消息（见文件头 P2P_HISTORY_*）。**逐条**交给主链：一条坏数据不该让整次补拉白做。 */
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
        // 补拉失败**不改变连接状态**：它只是一条恢复路径，算成"源不可达"会让状态点无谓变红
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
      // **重连**时补拉断线窗口里的消息（首次连接没有缺口），见 backfillAfterGap
      const isReconnect = everOpened
      everOpened = true
      if (isReconnect) backfillAfterGap()
    }
    ws.onmessage = (ev) => {
      lastActivityAt = Date.now()
      let raw
      try { raw = JSON.parse(String(ev.data)) } catch (err) { return } // 单条 JSON 坏掉不影响连接
      // 主链**必须单独 try**：与 JSON.parse 共用空 catch 会把 parse / match / handleAlert 的异常一起吞掉。
      try {
        onRaw(raw, currentCfg())
        // 恢复：连续失败后只要有一条处理成功就把状态改回 open，否则一次主链异常会让侧边栏永久停在"链路降级"。
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
      // start 是 stop 的逆操作：只有 restart() 清 `stopped` 时，"stop 之后再 start"会静默地什么都不做。
      stopped = false
      retries = 0
      processFails = 0
      bindResumeWatch()
      connect()
    },
    stop() {
      stopped = true
      teardown()
      unbindResumeWatch()
      report({ status: 'closed', retries, detail: 'stopped (plugin disabled)' })
    },
    backfillStatsOf() { return Object.assign({}, backfillStats) },
    restart() {
      stopped = false
      retries = 0 // 切数据源后立即从 1s 的间隔重新开始，而不是沿用上一条连接的递增进度
      processFails = 0
      bindResumeWatch() // stop() 会解绑；restart 之后这条 socket 同样需要"恢复可见时重置 stale 计时"
      teardown()
      connect()
    },
  }
}

let activeClient = null


// entry 需要把新建的 client 记到模块级 activeClient：跨模块不能写 imported binding
const setActiveClient = (c) => { activeClient = c }

export { createWsClient, activeClient, setActiveClient, CONNECT_TIMEOUT_MS, STALE_AFTER_MS, STALE_CHECK_MS }
