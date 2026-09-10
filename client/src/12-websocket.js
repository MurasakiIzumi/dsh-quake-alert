// ============================================================================
// dsh-quake-alert · client/src/12-websocket.js
//
// 作用：P2PQuake WebSocket 连接管理。
// 内容：连接/断开状态机、指数退避重连（1s→60s 封顶）、数据源切换（正式/沙箱）、
//       消息转交主链。
// 依赖：01-constants、02-storage（读数据源）、11-pipeline（handleRaw）。
// 背景：P2PQuake 约每 10 分钟强制断线，重连是常态路径而非异常。
// ============================================================================

import { WS_URL, SANDBOX_URL, RECONNECT_BASE, RECONNECT_MAX } from './01-constants.js'
import { currentCfg } from './03-settings-bridge.js'
import { store } from './07-store.js'
import { handleRaw } from './11-pipeline.js'

// ---------- WebSocket 客户端 ----------
function createWsClient() {
  let ws = null
  let timer = null
  let stopped = false
  let retries = 0
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
      const openDetail = url.indexOf('sandbox') !== -1
        ? '沙箱源：回放 2023 年历史（约30秒/条）'
        : '已连接 P2PQuake（约每 10 分钟自动重连）'
      store.push({ status: 'open', retries: 0, detail: openDetail })
    }
    ws.onmessage = (ev) => {
      try {
        const raw = JSON.parse(String(ev.data))
        handleRaw(raw, currentCfg())
      } catch (err) { /* 单条解析失败不影响连接 */ }
    }
    ws.onerror = () => { /* onclose 统一处理 */ }
    ws.onclose = () => scheduleReconnect()
  }
  const teardown = () => {
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

export { createWsClient, activeClient, setActiveClient }
