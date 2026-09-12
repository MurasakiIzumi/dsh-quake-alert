// ============================================================================
// dsh-quake-alert · client/src/12-websocket.js
//
// 作用：P2PQuake WebSocket 连接管理。
// 内容：连接/断开状态机、指数退避重连（1s→60s 封顶）、数据源切换（正式/沙箱）、
//       「久无数据」的半开连接检测（主动重连）、消息转交主链。
// 依赖：01-constants、02-storage（读数据源）、11-pipeline（handleRaw）。
// 背景：P2PQuake 约每 10 分钟强制断线，重连是常态路径而非异常。
// ============================================================================

import { WS_URL, SANDBOX_URL, RECONNECT_BASE, RECONNECT_MAX } from './01-constants.js'
import { currentCfg } from './03-settings-bridge.js'
import { store } from './07-store.js'
import { handleRaw } from './11-pipeline.js'

// 半开连接检测：NAT / 代理静默断开时 TCP 已经不通，但浏览器**不会**触发 onclose，
// 于是状态点一直是绿色的「已连接」，实际一条推送都收不到——对预警产品这是最危险的失效模式
// （用户以为自己在被保护）。P2PQuake 约每 10 分钟强制断线一次，正常情况下 lastActivityAt
// 会被 onclose → 重连 → onopen 不断刷新，所以 20 分钟毫无活动只可能是连接真的死了。
const STALE_AFTER_MS = 20 * 60 * 1000
const STALE_CHECK_MS = 60 * 1000

// ---------- WebSocket 客户端 ----------
function createWsClient(opts) {
  const o = opts || {}
  const staleAfterMs = o.staleAfterMs === undefined ? STALE_AFTER_MS : o.staleAfterMs
  const staleCheckMs = o.staleCheckMs === undefined ? STALE_CHECK_MS : o.staleCheckMs
  let ws = null
  let timer = null
  let staleTimer = null
  let stopped = false
  let retries = 0
  let lastActivityAt = 0 // 最近一次 onopen / onmessage 的时刻

  function stopStaleWatch() {
    if (staleTimer) { clearTimeout(staleTimer); staleTimer = null }
  }
  /** 排下一次「是否久无数据」的检查；检测关闭（staleAfterMs <= 0）时不排。 */
  function armStaleWatch() {
    stopStaleWatch()
    if (stopped || !(staleAfterMs > 0) || !(staleCheckMs > 0)) return
    staleTimer = setTimeout(() => {
      staleTimer = null
      if (stopped) return
      if (lastActivityAt && Date.now() - lastActivityAt > staleAfterMs) {
        store.push({ status: 'reconnecting', retries, detail: '久无数据（疑似连接已断开），正在重连' })
        teardown()
        connect()
        return
      }
      armStaleWatch()
    }, staleCheckMs)
    if (staleTimer && typeof staleTimer.unref === 'function') staleTimer.unref()
  }

  const scheduleReconnect = () => {
    if (stopped) return
    retries += 1 // 从「第 1 次」开始计数，退避序列 1s → 2s → 4s → … → 60s 封顶
    store.push({ status: 'reconnecting', retries, detail: '连接断开，正在重连（第 ' + retries + ' 次）' })
    const delay = Math.min(RECONNECT_MAX, RECONNECT_BASE * Math.pow(2, retries - 1))
    timer = setTimeout(connect, delay)
  }
  const connect = () => {
    if (stopped) return
    const url = currentCfg().source === 'sandbox' ? SANDBOX_URL : WS_URL
    store.push({ status: 'connecting', retries, detail: '正在连接 ' + url })
    try { ws = new window.WebSocket(url) } catch (err) {
      scheduleReconnect()
      return
    }
    ws.onopen = () => {
      retries = 0
      lastActivityAt = Date.now()
      armStaleWatch()
      const openDetail = url.indexOf('sandbox') !== -1
        ? '沙箱源：回放 2023 年历史（约30秒/条）'
        : '已连接 P2PQuake（约每 10 分钟自动重连）'
      store.push({ status: 'open', retries: 0, detail: openDetail })
    }
    ws.onmessage = (ev) => {
      lastActivityAt = Date.now()
      try {
        const raw = JSON.parse(String(ev.data))
        handleRaw(raw, currentCfg())
      } catch (err) { /* 单条解析失败不影响连接 */ }
    }
    ws.onerror = () => { /* onclose 统一处理 */ }
    ws.onclose = () => scheduleReconnect()
  }
  const teardown = () => {
    stopStaleWatch()
    if (timer) { clearTimeout(timer); timer = null }
    if (ws) { try { ws.onclose = null; ws.close() } catch (err) {} ws = null }
  }
  return {
    start() { connect() },
    stop() {
      stopped = true
      teardown()
      store.push({ status: 'closed', retries, detail: '已停止（插件停用）' })
    },
    restart() {
      stopped = false
      retries = 0 // 切数据源后立即从 1s 退避重新开始，而不是沿用上一条连接的退避进度
      teardown()
      connect()
    },
  }
}

let activeClient = null


// entry 需要把新建的 client 记到模块级 activeClient：跨模块不能写 imported binding
const setActiveClient = (c) => { activeClient = c }

export { createWsClient, activeClient, setActiveClient, STALE_AFTER_MS, STALE_CHECK_MS }
