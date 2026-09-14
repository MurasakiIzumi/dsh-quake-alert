// ============================================================================
// dsh-quake-alert · client/src/10-dedupe.js
//
// 作用：三层去重与「已提醒事件」记忆。
// 内容：消息 id 去重（防重连重放）、事件键去重（同一地震的多次发布，强度升级穿透）、
//       跨标签页认领（BroadcastChannel + 事件键同步）、已提醒事件集合（取消提醒用）。
// 依赖：01-constants、07-store（通道建立时机在 15-entry 的 apply 里）、06-matcher（坐标型近似归并）。
// 注意：通道监听必须在插件加载时就建立，否则会错过其它标签页的广播。
// ============================================================================

import { validGeo, distanceKm } from './06-matcher.js'

// ---------- 去重 ----------
// 三层：① 消息 id（防重连重放）② 事件键（同一地震的多次发布）③ 跨标签页（多开 DSH 页面）
//
// 时钟回拨（NTP 校正 / 用户改时间 / 休眠唤醒后的时钟修正）的处理：把记录时间**夹到 now**，
// 而不是删除。删掉等于一次性清空三层去重记忆——本该被窗口抑制的重复消息会重新播报，
// alertedEvents 清空还会让随后的解除找不到"此前提醒过的事件"（少一条有用的解除提示）。
const seen = new Map() // id -> ts
function isDuplicate(id, windowMinutes) {
  if (!id) return false
  const now = Date.now()
  const win = Math.max(1, windowMinutes || 10) * 60 * 1000
  for (const [k, v] of seen) {
    if (v > now) { seen.set(k, now); continue }
    if (now - v > win) seen.delete(k)
  }
  if (seen.has(id)) return true
  seen.set(id, now)
  return false
}
// 同一次地震会连发「震度速报 → 震源情报 → 各地震度」或 EEW 多报（serial 递增）。
// 这些消息 id 各不相同，但共享事件键；只有强度升级时才再提醒一次，避免连续响铃。
//
// 坐标型（全球源）另存发震时刻与震中：eventKey 是「分钟 + 0.1 度」的字符串指纹，
// 而源的定位会在 0.05〜0.1 度之间浮动、发震时刻也会差几十秒——任一处跨过量化边界，
// 同一场地震就会算出不同的键，于是 EMSC 与 USGS 各响一次（README 承诺"只提醒一次"）。
// 所以键未命中时再按「±2 分钟 + 50km」找一次。
const GEO_NEAR_MS = 2 * 60 * 1000
const GEO_NEAR_KM = 50
const eventSeen = new Map() // eventKey -> { ts, strength, at, geo }
function issuedMsOf(alert) {
  const t = Date.parse(String((alert && alert.issued) || ''))
  return Number.isFinite(t) ? t : null
}
/**
 * 找"这一条可能对应的先前事件记录"。
 *
 * 两级：先看**精确事件键**；未命中时再看**坐标近似**（±2 分钟 + 50km）。
 *
 * `allowSameSource` 决定近似那一级要不要排除同源：
 *   · `isEventRepeat` 传 false —— 它要回答"这条是不是另一条源对同一场地震的重复播报"，
 *     而同源不会用两个 id 报同一事件（同源修订复用同一个 id）。同源的两次不同地震
 *     （例如相隔 40 秒、相距 7km 的主震与余震）被归并就是漏报。
 *   · `isStrengthUpgrade` 传 true —— 它只在**消息 id 已经重复**时才被求值（handleAlert 里的
 *     `&&` 短路），也就是说调用方已经确定"这是同一条消息的又一次到达"，此时同源的坐标近似
 *     也必须认（EMSC 的修订版会挪坐标 / 跨分钟，键就变了）。
 */
function findPrevEvent(alert, allowSameSource) {
  const prev = eventSeen.get(alert.eventKey)
  if (prev) return prev
  if (alert.locator !== 'point' || !validGeo(alert.geo)) return null
  const at = issuedMsOf(alert)
  if (at === null) return null
  if (String(alert.eventKey || '').indexOf('test:') === 0) return null // 测试消息每次都是独立演示
  const source = String(alert.source || '')
  for (const v of eventSeen.values()) {
    if (!v.geo || typeof v.at !== 'number') continue
    if (!allowSameSource && source && v.source && v.source === source) continue
    if (Math.abs(v.at - at) <= GEO_NEAR_MS && distanceKm(alert.geo.lat, alert.geo.lon, v.geo.lat, v.geo.lon) <= GEO_NEAR_KM) {
      return v
    }
  }
  return null
}

function isEventRepeat(alert, windowMinutes) {
  if (!alert.eventKey) return false
  const now = Date.now()
  const win = Math.max(1, windowMinutes || 10) * 60 * 1000
  for (const [k, v] of eventSeen) {
    if (v.ts > now) { v.ts = now; continue }
    if (now - v.ts > win) eventSeen.delete(k)
  }
  const prev = findPrevEvent(alert, false)
  if (prev && alert.strength <= prev.strength) return true
  const at = issuedMsOf(alert)
  const geo = (alert.locator === 'point' && validGeo(alert.geo)) ? { lat: alert.geo.lat, lon: alert.geo.lon } : null
  eventSeen.set(alert.eventKey, { ts: now, strength: alert.strength, at, geo, source: String(alert.source || '') })
  return false
}

/**
 * 让事件键的强度**回落**（降级电文调用），返回是否真的降了。
 *
 * 气象电文会"降级"：L4 → L3 → L2 是同一次灾害过程的强度回落，本身不该播报（L3 以下本来就不播报），
 * 但必须让记忆里的 strength 跟着降下来。否则"降级之后再次升级"会被判成"强度未升级的重复发布"
 * 而永久静默——这是 0.4.1 把发布时刻从事件键里去掉之后**新引入**的漏报
 * （实测：L4 播报 → L3 降级 → 再升回 L4，返回 event-repeat）。
 * 只在强度**确实更低**时下调，所以"关注地区未命中"这类 not-hit 不会误降（强度没变）。
 */
function weakenEvent(alert) {
  if (!alert || !alert.eventKey) return false
  const prev = eventSeen.get(alert.eventKey)
  if (!prev || typeof alert.strength !== 'number') return false
  if (alert.strength < prev.strength) { prev.strength = alert.strength; return true }
  return false
}
/**
 * 只读探测：同一个事件键此前见过、且这一条的强度更高吗？
 *
 * 为什么需要：消息级去重（isDuplicate，按 alert.id）排在事件级去重（isEventRepeat）之前，
 * 而**同一个消息 id 完全可能携带升级后的内容**——全球源就是这个形态：
 *   · EMSC 对同一事件的修订复用同一个 unid（`action: 'update'`）
 *   · USGS 的同一个 feature id 在震级复核后会刷新 properties.updated
 * 若只按 id 一律挡掉，震级上修（M5.2 → M6.4）永远不会再提醒——那是漏报，
 * 而"同一场地震只响一次"的本意是"重复的同一强度不要连响"，不是"修订版一律静默"。
 *
 * 本函数**不修改任何状态**（登记由 isEventRepeat 负责），只回答"该不该让消息级去重放行"。
 * 放行后仍会走 isEventRepeat 的正常判定：强度确实升级才播报，未升级依旧只记历史。
 * 时钟回拨（ts > now）按"未见过"处理，与 isEventRepeat 的清理判据保持一致。
 */
function isStrengthUpgrade(alert) {
  if (!alert || !alert.eventKey) return false
  // 必须走 findPrevEvent（含坐标近似）：本函数只在**消息 id 已重复**时被求值，也就是调用方
  // 已经确定"同一条消息又来了"。而源在修订时会把坐标挪过 0.1° 桶、或让发震时刻跨分钟 ——
  // 精确键随之改变，只查精确键就会把"震级上修"误判成"重复发布"而静默
  // （实测 EMSC 同一 unid M5.0 → M6.4 跨分钟修订 → duplicate）。这是 0.4.1 声称修好、
  // 实际只在键逐字相同时成立的那条。
  const prev = findPrevEvent(alert, true)
  if (!prev) return false
  if (prev.ts > Date.now()) return false
  return alert.strength > prev.strength
}
/**
 * 忘掉一个事件键。
 *
 * 解除 / 取消应当调用它：那表示这次灾害过程已经结束，之后再发布同一个键
 * （同一官署 + 同一灾种）是**新事件**，必须能重新播报。不这么做的话，
 * 长事件窗口（气象 3 小时）会把"解除后再次发布"当成重复而静默——那是漏报。
 */
function forgetEvent(eventKey) {
  if (eventKey) eventSeen.delete(eventKey)
}
// 已实际提醒过的事件（eventKey → ts）。
// 取消 / 解除消息只在「此前确实提醒过同一事件」时才补一条：既避免「没收到警报却收到取消」的困惑，
// 也让用户知道已经发出的警报作废（EEW 取消 / 海啸解除本身是有用信息，不该静默）。
const ALERTED_MAX_MS = 1440 * 60 * 1000
const alertedEvents = new Map()
/**
 * 取消 / 解除的匹配键。
 *
 * **不留 kind 兜底**：事件键为空的 alert（例如某些解析不出区域的电文）若退化成 kind，
 * 任意一条海啸解除都会匹配上"此前提醒过的任意海啸事件"，播出一条假解除——假安全比不提醒更危险。
 * 空键直接返回空串，rememberAlerted / wasRecentlyAlerted 会跳过它（该事件无法被取消，安全侧）。
 */
const cancelKeyOf = (alert) => (alert && alert.eventKey) || ''
function rememberAlerted(alert) {
  const key = cancelKeyOf(alert)
  if (!key) return
  const now = Date.now()
  for (const [k, v] of alertedEvents) {
    if (v > now) { alertedEvents.set(k, now); continue }
    if (now - v > ALERTED_MAX_MS) alertedEvents.delete(k)
  }
  alertedEvents.set(key, now)
}
/**
 * 取消 / 解除消息是否有"此前确实提醒过的同一事件"。
 *
 * 窗口必须与 alertedEvents 的保留期（24 小时）一致，**不能**用 dedupe.windowMinutes（默认 10 分钟）：
 * 解除必然晚于发布——实测 2026-09-07 東京都「大雨特別警報」13:57 发布、19:01 解除，相隔 5 小时。
 * 旧实现在 10 分钟后就把记忆清掉，于是 0.1.3 加入的解除链路从未真正生效：用户收到警报后
 * 永远收不到「已解除」。
 */
function wasRecentlyAlerted(alert) {
  const key = cancelKeyOf(alert)
  if (!key) return false
  const v = alertedEvents.get(key)
  if (typeof v !== 'number') return false
  const now = Date.now()
  if (v > now || now - v > ALERTED_MAX_MS) { alertedEvents.delete(key); return false }
  return true
}
// 多开 DSH 页面时每个标签页都会收到同一条推送；用 BroadcastChannel 协商，只让一个标签页播报。
// 通道必须在插件加载时就建立监听（见 apply），否则后加载的标签页会错过先到的广播。
// 不支持 BroadcastChannel 时退化为「各标签页各自提醒」，不影响正确性。
//
// TTL 从 5 秒改到 10 分钟（0.4.1）：5 秒只覆盖"几乎同时"的情形，而真正会重复播报的是
// **先被冻结、后恢复**的标签页——冻结期间另一个标签页已经播报过，恢复后它才拉到同一批
// entry（或收到同一条 WS 推送），此时 5 秒窗口早已过期，于是又响一次。10 分钟与消息级
// 去重窗口一致：同一 alert.id 本来就不该在 10 分钟内被合法地播报两次。
const TAB_DEDUPE_MS = 10 * 60 * 1000
const tabAlerted = new Map() // key -> ts
let alertChannel = null
function ensureAlertChannel() {
  if (alertChannel !== null || typeof window === 'undefined' || typeof window.BroadcastChannel !== 'function') return alertChannel
  try {
    alertChannel = new window.BroadcastChannel('dsh-quake-alert')
    alertChannel.onmessage = (ev) => {
      const d = ev && ev.data
      if (!d) return
      // 另一个标签页清空了历史 → 本标签页也要清（否则它的下一次 addEvent 会把整份记录写回磁盘）
      if (d.type === 'history-cleared') { alertedEvents.clear(); return }
      if (d.type !== 'alerted' || !d.key) return
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
  for (const [k, v] of tabAlerted) {
    if (v > now) { tabAlerted.set(k, now); continue }
    if (now - v > TAB_DEDUPE_MS) tabAlerted.delete(k)
  }
  if (tabAlerted.has(key)) return false
  tabAlerted.set(key, now)
  if (ensureAlertChannel()) {
    try { alertChannel.postMessage({ type: 'alerted', key, eventKey: eventKey || '' }) } catch (err) { /* 通道已关闭等忽略 */ }
  }
  return true
}
/** 广播「历史已清空」，让其它标签页同步清掉内存副本（见 13-ui-settings 的清空按钮）。 */
function broadcastHistoryCleared() {
  if (ensureAlertChannel()) {
    try { alertChannel.postMessage({ type: 'history-cleared' }) } catch (err) { /* 忽略 */ }
  }
}


// 通道关闭：原来由 entry 的 effect 直接读模块级 alertChannel，改成显式出口
function closeAlertChannel() {
  try { if (alertChannel) { alertChannel.close(); alertChannel = null } } catch (err) { /* 忽略 */ }
}

export { isDuplicate, isEventRepeat, isStrengthUpgrade, weakenEvent, forgetEvent, ensureAlertChannel, closeAlertChannel, claimAlertForTab, broadcastHistoryCleared, cancelKeyOf, rememberAlerted, wasRecentlyAlerted, alertedEvents }
