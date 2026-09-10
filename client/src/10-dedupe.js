// ============================================================================
// dsh-quake-alert · client/src/10-dedupe.js
//
// 作用：三层去重与「已提醒事件」记忆。
// 内容：消息 id 去重（防重连重放）、事件键去重（同一地震的多次发布，强度升级穿透）、
//       跨标签页认领（BroadcastChannel + 事件键同步）、已提醒事件集合（取消提醒用）。
// 依赖：01-constants、07-store（通道建立时机在 15-entry 的 apply 里）。
// 注意：通道监听必须在插件加载时就建立，否则会错过其它标签页的广播。
// ============================================================================

// ---------- 去重 ----------
// 三层：① 消息 id（防重连重放）② 事件键（同一地震的多次发布）③ 跨标签页（多开 DSH 页面）
const seen = new Map() // id -> ts
function isDuplicate(id, windowMinutes) {
  if (!id) return false
  const now = Date.now()
  const win = Math.max(1, windowMinutes || 10) * 60 * 1000
  for (const [k, v] of seen) if (now - v > win || v > now) seen.delete(k)
  if (seen.has(id)) return true
  seen.set(id, now)
  return false
}
// 同一次地震会连发「震度速报 → 震源情报 → 各地震度」或 EEW 多报（serial 递增）。
// 这些消息 id 各不相同，但共享事件键；只有强度升级时才再提醒一次，避免连续响铃。
const eventSeen = new Map() // eventKey -> { ts, strength }
function isEventRepeat(alert, windowMinutes) {
  if (!alert.eventKey) return false
  const now = Date.now()
  const win = Math.max(1, windowMinutes || 10) * 60 * 1000
  for (const [k, v] of eventSeen) if (now - v.ts > win || v.ts > now) eventSeen.delete(k)
  const prev = eventSeen.get(alert.eventKey)
  if (prev && alert.strength <= prev.strength) return true
  eventSeen.set(alert.eventKey, { ts: now, strength: alert.strength })
  return false
}
// 已实际提醒过的事件（eventKey / kind → ts）。
// 取消 / 解除消息只在「此前确实提醒过同一事件」时才补一条：既避免「没收到警报却收到取消」的困惑，
// 也让用户知道已经发出的警报作废（EEW 取消 / 海啸解除本身是有用信息，不该静默）。
const ALERTED_MAX_MS = 1440 * 60 * 1000
const alertedEvents = new Map()
const cancelKeyOf = (alert) => alert.eventKey || alert.kind
function rememberAlerted(alert) {
  const now = Date.now()
  for (const [k, v] of alertedEvents) if (now - v > ALERTED_MAX_MS || v > now) alertedEvents.delete(k)
  alertedEvents.set(cancelKeyOf(alert), now)
}
function wasRecentlyAlerted(alert, windowMinutes) {
  const key = cancelKeyOf(alert)
  const v = alertedEvents.get(key)
  if (typeof v !== 'number') return false
  const now = Date.now()
  const win = Math.max(1, windowMinutes || 10) * 60 * 1000
  if (v > now || now - v > win) { alertedEvents.delete(key); return false }
  return true
}
// 多开 DSH 页面时每个标签页都会收到同一条推送；用 BroadcastChannel 协商，只让一个标签页播报。
// 通道必须在插件加载时就建立监听（见 apply），否则后加载的标签页会错过先到的广播。
// 不支持 BroadcastChannel 时退化为「各标签页各自提醒」，不影响正确性。
const TAB_DEDUPE_MS = 5000
const tabAlerted = new Map() // key -> ts
let alertChannel = null
function ensureAlertChannel() {
  if (alertChannel !== null || typeof window === 'undefined' || typeof window.BroadcastChannel !== 'function') return alertChannel
  try {
    alertChannel = new window.BroadcastChannel('dsh-quake-alert')
    alertChannel.onmessage = (ev) => {
      const d = ev && ev.data
      if (!d || d.type !== 'alerted' || !d.key) return
      tabAlerted.set(String(d.key), Date.now())
      // 顺带同步事件键：其它标签页此前提醒过的事件，本标签页在收到取消消息时也要知道
      if (d.eventKey) alertedEvents.set(String(d.eventKey), Date.now())
    }
  } catch (err) { alertChannel = null }
  return alertChannel
}
function claimAlertForTab(key, eventKey) {
  if (!key) return true
  const now = Date.now()
  for (const [k, v] of tabAlerted) if (now - v > TAB_DEDUPE_MS || v > now) tabAlerted.delete(k)
  if (tabAlerted.has(key)) return false
  tabAlerted.set(key, now)
  if (ensureAlertChannel()) {
    try { alertChannel.postMessage({ type: 'alerted', key, eventKey: eventKey || '' }) } catch (err) { /* 通道已关闭等忽略 */ }
  }
  return true
}


// 通道关闭：原来由 entry 的 effect 直接读模块级 alertChannel，改成显式出口
function closeAlertChannel() {
  try { if (alertChannel) { alertChannel.close(); alertChannel = null } } catch (err) { /* 忽略 */ }
}

export { isDuplicate, isEventRepeat, ensureAlertChannel, closeAlertChannel, claimAlertForTab, cancelKeyOf, rememberAlerted, wasRecentlyAlerted, alertedEvents }
