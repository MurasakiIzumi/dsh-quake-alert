// ============================================================================
// dsh-quake-alert · client/src/10-dedupe.js
// 作用：三层去重（消息 id 防重放、事件键合并同一地震的多次发布、跨标签页抢占）与「已提醒事件」记忆。
// 依赖：01-constants、07-store（通道建立时机在 15-entry 的 apply 里）、06-matcher（坐标型近似归并）。
// 通道监听必须在插件加载时就建立，否则会错过其它标签页的广播。
// ============================================================================

import { validGeo, distanceKm } from './06-matcher.js'
import { t } from './00-i18n.js'
import { HISTORY_KEY, ALERTED_KEY } from './01-constants.js'
import { saveJSON, loadJSON, own } from './02-storage.js'
import { store } from './07-store.js'
import { sourceLabelOf } from './00f-source-labels.js'

// ---------- 去重 ----------
// 时钟回拨（NTP 校正 / 用户改时间 / 休眠唤醒）时把记录时间夹到 now，而不是删除：删掉等于一次性
// 清空去重记忆，本该被窗口抑制的重复消息会重新播报。
const seen = new Map() // id -> { ts, win }
function isDuplicate(id, windowMinutes) {
  if (!id) return false
  const now = Date.now()
  const win = Math.max(1, windowMinutes || 10) * 60 * 1000
  for (const [k, v] of seen) {
    // 清理要用**这条记录自己的窗口**，不是本次调用的窗口——本次的窗口可能属于另一个源 / 另一段设置
    const ts = typeof v === 'object' && v !== null ? v.ts : v
    const own = (typeof v === 'object' && v !== null && typeof v.win === 'number') ? v.win : win
    if (ts > now) { seen.set(k, { ts: now, win: own }); continue }
    if (now - ts > own) seen.delete(k)
  }
  const prev = seen.get(id)
  if (prev) {
    // 命中即刷新时间戳：窗口语义是"这段时间内见过就算重复"，不是"首次见到起算"
    const own = typeof prev.win === 'number' ? prev.win : win
    seen.set(id, { ts: now, win: own })
    return true
  }
  seen.set(id, { ts: now, win })
  return false
}
// 同一次地震会连发「震度速报 → 震源情报 → 各地震度」或 EEW 多报（serial 递增）：消息 id 各不相同，
// 但共享事件键；只有强度升级时才再提醒一次。
//
// 坐标型源另存发震时刻与震中：eventKey 是「分钟 + 0.1 度」的指纹，而源的定位与发震时刻都会浮动，
// 任一处跨过量化边界就会算出不同的键（EMSC 与 USGS 因此各响一次）——所以键未命中时再按
// 「±2 分钟 + 50km」找一次。
const GEO_NEAR_MS = 2 * 60 * 1000
const GEO_NEAR_KM = 50
/** 强度是否可用于比较：只有有限数值才算数。 */
const isFiniteStrength = (v) => typeof v === 'number' && Number.isFinite(v)
const eventSeen = new Map() // eventKey -> { ts, strength, at, geo, source, win, kind, test }
function issuedMsOf(alert) {
  // 局部变量不叫 `t`（那是 00-i18n 的取词函数）
  const ms = Date.parse(String((alert && alert.issued) || ''))
  return Number.isFinite(ms) ? ms : null
}
/**
 * 找"这一条可能对应的先前事件记录"：先查精确事件键，未命中再按「±2 分钟 + 50km」找。
 * `allowSameSource` 决定近似那一级要不要排除同源：isEventRepeat 传 false（同源修订复用同一个消息
 * id，同源两次不同地震被归并就是漏报），isStrengthUpgrade 传 true（调用方已确定是同一条消息的再次
 * 到达）。判据是「有没有可用震中」而不是「locator 是不是 point」：日本源（551 / 556）也带 geo 并参与
 * 事件归并，但仍走行政区匹配。
 */
function findPrevEvent(alert, allowSameSource) {
  const prev = eventSeen.get(alert.eventKey)
  if (prev) return prev
  if (!validGeo(alert.geo)) return null
  const at = issuedMsOf(alert)
  if (at === null) return null
  if (String(alert.eventKey || '').indexOf('test:') === 0) return null // 测试消息每次都是独立演示
  const source = sourceIdOf(alert)
  for (const v of eventSeen.values()) {
    if (!v.geo || typeof v.at !== 'number') continue
    if (!allowSameSource && source && v.source && v.source === source) continue
    // 候选也要过滤：灾种不同、或对方是演示消息，就不该算"同一事件的副本"（否则跨源不比 strength，
    // 一条海啸警报可能被附近的地震记录压成静默）
    if (v.test) continue
    if (v.kind && alert.kind && v.kind !== alert.kind) continue
    if (Math.abs(v.at - at) <= GEO_NEAR_MS && distanceKm(alert.geo.lat, alert.geo.lon, v.geo.lat, v.geo.lon) <= GEO_NEAR_KM) {
      return v
    }
  }
  return null
}

/**
 * 事件键级去重：同一条事件键此前见过且强度未升级 → 判重复。
 * @param {number} [nowMs] 注入点（测试用）：`Date.now()` 不可注入时跨时间行为无法测试。
 */
function isEventRepeat(alert, windowMinutes, nowMs) {
  if (!alert.eventKey) return false
  const now = (typeof nowMs === 'number' && Number.isFinite(nowMs)) ? nowMs : Date.now()
  const win = Math.max(1, windowMinutes || 10) * 60 * 1000
  for (const [k, v] of eventSeen) {
    if (v.ts > now) { v.ts = now; continue }
    // 清理要用**这条记录自己的窗口**，不是本次调用的窗口：否则按 3 小时窗口记住的气象事件会被
    // 10 分钟后任意一条命中地震带着的 10 分钟窗口清掉，随后的更新就被判成新事件而重复响铃。
    // 旧记录没有 win 字段时退回本次调用的窗口。
    const own = typeof v.win === 'number' ? v.win : win
    if (now - v.ts > own) eventSeen.delete(k)
  }
  const prev = findPrevEvent(alert, false)
  // 强度必须是有限数值才参与比较（缺失时 undefined <= x 恒为 false，这条消息永远不被判重复）；
  // 方向与全项目一致：说不清是不是升级 → 放行。
  if (prev && isFiniteStrength(alert.strength) && alert.strength <= prev.strength) return true
  const at = issuedMsOf(alert)
  const geo = validGeo(alert.geo) ? { lat: alert.geo.lat, lon: alert.geo.lon } : null
  // kind / test 一并存下来：findPrevEvent 的近似那一级靠它们过滤候选
  eventSeen.set(alert.eventKey, {
    ts: now,
    // strength 只在是有限数值时覆盖记忆：缺字段的那条若把 undefined 写进去，之后真正的震级上修
    // （`6.4 > undefined` 恒 false）就会被判成"重复发布"而静默。
    strength: isFiniteStrength(alert.strength)
      ? alert.strength
      : (prev && isFiniteStrength(prev.strength) ? prev.strength : alert.strength),
    at,
    geo,
    source: sourceIdOf(alert),
    win,
    kind: String(alert.kind || ''),
    test: String(alert.eventKey || '').indexOf('test:') === 0,
  })
  return false
}

// ---------- 跨源优先源 ----------
// 日本源（551 / 552 / 556）的解析器不设 `source` 字段（历来靠数字 code 认源），故在这里按 code 补。
const SOURCE_BY_CODE = { 551: 'p2pquake', 552: 'p2pquake', 556: 'p2pquake' }
function sourceIdOf(alert) {
  if (!alert) return ''
  const s = String(alert.source || '')
  if (s) return s
  const code = (alert.code === undefined || alert.code === null) ? '' : String(alert.code)
  return own(SOURCE_BY_CODE, code) || ''
}
/**
 * 源的权威序（数字越小越"本地权威"）：1 日本 P2PQuake、2 大陆预警 cenc_eew、3 大陆速报
 * cenc_eqlist、4 USGS / EMSC、5 NOAA。它不决定谁先播（先到者播是时序决定的，低优先级源先播、
 * 高优先级源后到也不补播），只服务诊断文案。
 */
const SOURCE_RANK = { p2pquake: 1, cenc_eew: 2, cenc_eqlist: 3, usgs: 4, emsc: 4, noaa: 5 }
/**
 * 源的**机构**归属：跨源归并只在跨机构时成立。同机构（EEW → 速报）是同一份信息的演进，仍走
 * isEventRepeat（记历史、强度升级放行）；跨机构（日本台网 / USGS / EMSC）是同一件事的重复转述，
 * 才按优先源规则抑制。`p2pquake` 与 `jma` 同属気象庁（P2PQuake 只是转播渠道）。
 */
const SOURCE_AGENCY = {
  p2pquake: 'jma', jma: 'jma',
  cenc_eew: 'cenc', cenc_eqlist: 'cenc',
  usgs: 'usgs', emsc: 'emsc', noaa: 'noaa',
}
const agencyOf = (id) => {
  const key = String(id === undefined || id === null ? '' : id)
  const v = own(SOURCE_AGENCY, key)
  return v || key // 认不出的源用它自己当机构名：两个未知源只在 id 相同时才算同一机构
}
/** 参与跨源归并的灾种：只有地震类有"多个源报同一件事"的形态。 */
const CROSS_SOURCE_KINDS = { quake: true, eew: true, tsunami: true }
// 源显示名走 00f 的 settings.sourceLabels.*（四语的唯一映射）；认不出的源退回 id 本身。
const sourceNameOf = (id) => sourceLabelOf(id) || String(id || t('reason.sourceUnknown'))
const rankOfSource = (id) => {
  const v = own(SOURCE_RANK, String(id === undefined || id === null ? '' : id))
  return typeof v === 'number' ? v : 9
}
const sourceZhOf = (id) => sourceNameOf(id)

/**
 * 这条是不是**同一事件在另一个源上的副本**？只对地震类、且只对**跨机构**生效。
 * @returns {{source: string, mine: string, rank: number, mineRank: number}|null}
 *   `source` = 已经播报过的那个源（null = 不是跨源副本，交给 isEventRepeat）。
 *
 * 判据只有 findPrevEvent(alert, false) 一条路径（先精确事件键，再「±2 分钟 + 50km」，排除同源）。
 * **跨源不比 strength**：日本给的是震度、全球给的是震级，两者不可换算。
 */
function crossSourceCopyOf(alert) {
  if (!alert || !alert.eventKey) return null
  if (!own(CROSS_SOURCE_KINDS, String(alert.kind || ''))) return null
  if (String(alert.eventKey).indexOf('test:') === 0) return null // 测试消息每次都是独立演示
  const mine = sourceIdOf(alert)
  if (!mine) return null
  const prev = findPrevEvent(alert, false)
  if (!prev) return null
  const other = String(prev.source || '')
  if (!other || other === mine) return null
  if (agencyOf(other) === agencyOf(mine)) return null // 同机构：8.3 那条链路，交给 isEventRepeat
  return { source: other, mine, rank: rankOfSource(other), mineRank: rankOfSource(mine) }
}

/** 被优先源压掉的条数：被抑制的条目连历史都不进，所以计数必须另留一处供诊断读取。 */
const authorityStats = { suppressed: 0, bySource: {}, lastAt: 0, lastDetail: '' }
function noteAuthoritySuppressed(info, alert) {
  authorityStats.suppressed += 1
  const k = String(info.source || '')
  authorityStats.bySource[k] = (authorityStats.bySource[k] || 0) + 1
  authorityStats.lastAt = Date.now()
  authorityStats.lastDetail = t('reason.authoritySuppressed', { source: sourceZhOf(info.source), mine: sourceZhOf(info.mine) })
  return authorityStats.lastDetail
}
function authorityStatsOf() {
  return {
    suppressed: authorityStats.suppressed,
    bySource: Object.assign({}, authorityStats.bySource),
    lastAt: authorityStats.lastAt || null,
    lastDetail: authorityStats.lastDetail,
  }
}

/**
 * 让事件键的强度**回落**（降级电文调用），返回是否真的降了。气象电文的 L4 → L3 → L2 是同一次
 * 灾害过程的强度回落，但记忆里的 strength 必须跟着降，否则"降级之后再次升级"会被判成"强度未
 * 升级的重复发布"而永久静默。只在强度确实更低时下调。
 */
function weakenEvent(alert) {
  if (!alert || !alert.eventKey) return false
  const prev = eventSeen.get(alert.eventKey)
  if (!prev || typeof alert.strength !== 'number') return false
  if (alert.strength < prev.strength) { prev.strength = alert.strength; return true }
  return false
}
/**
 * 只读探测：同一个事件键此前见过、且这一条的强度更高吗？消息级去重（isDuplicate，按 alert.id）
 * 排在事件级去重之前，而同一个消息 id 可能携带升级后的内容——EMSC 修订复用同一个 unid、
 * USGS 震级复核后刷新 properties.updated。若只按 id 挡掉，震级上修（M5.2 → M6.4）永远不会再提醒。
 *
 * 本函数不修改任何状态（登记由 isEventRepeat 负责）。时钟回拨（ts > now）按"未见过"处理。
 */
function isStrengthUpgrade(alert) {
  if (!alert || !alert.eventKey) return false
  // 必须走 findPrevEvent（含坐标近似）：源修订会把坐标挪过 0.1° 桶、或让发震时刻跨分钟，
  // 精确键随之改变，只查精确键就会把"震级上修"误判成"重复发布"而静默
  const prev = findPrevEvent(alert, true)
  if (!prev) return false
  if (prev.ts > Date.now()) return false
  return alert.strength > prev.strength
}
/**
 * 忘掉一个事件键，解除 / 取消时调用：灾害过程已结束后再发布同一个键（同一官署 + 同一灾种）
 * 是新事件，必须能重新播报，否则长事件窗口（气象 3 小时）会把"解除后再次发布"当成重复而静默。
 */
function forgetEvent(eventKey) {
  if (eventKey) eventSeen.delete(eventKey)
}
// 已实际提醒过的事件（eventKey → ts），供取消 / 解除判断"此前是否确实提醒过同一事件"。
// 这份记忆与"事件级去重的窗口"（11-pipeline 的 WEATHER_EVENT_WINDOW_MINUTES，180 分钟）是两件事：
// 这里的 24 小时按"一条气象事件可能持续多久"取（实测发布到解除可相隔 5 小时）。
const ALERTED_MAX_MS = 1440 * 60 * 1000
const alertedEvents = new Map()
/**
 * 把"真正播报过的事件"写进 localStorage：Host 重启后会按首次启动回看窗口重新投递缓冲里的事件，
 * 而消息级去重只有 10 分钟、事件级只有 3 小时，不持久化就会重报。先清理再写入本地存储，只写有限数值。
 */
function persistAlerted() {
  const now = Date.now()
  const out = {}
  for (const [k, v] of alertedEvents) {
    if (typeof v !== 'number' || !Number.isFinite(v)) continue
    if (v > now) { alertedEvents.set(k, now); out[k] = now; continue }
    if (now - v > ALERTED_MAX_MS) { alertedEvents.delete(k); continue }
    out[k] = v
  }
  saveJSON(ALERTED_KEY, out)
}
/** 启动时读回：认不出的形状当"没有记忆"，过期条目直接丢掉。 */
function loadAlerted() {
  const raw = loadJSON(ALERTED_KEY, null)
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return
  const now = Date.now()
  for (const k of Object.keys(raw)) {
    const v = raw[k]
    if (typeof v !== 'number' || !Number.isFinite(v)) continue
    const ts = v > now ? now : v
    if (now - ts > ALERTED_MAX_MS) continue
    alertedEvents.set(k, ts)
  }
}
loadAlerted()
/**
 * 取消 / 解除的匹配键。不留 kind 兜底：事件键为空的 alert 若退化成 kind，任意一条海啸解除都会
 * 匹配上"此前提醒过的任意海啸事件"而播出一条假解除。空键返回空串，调用方会跳过它。
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
  persistAlerted()
}
/** 忘掉"此前提醒过"的某个事件；删除也要写入本地存储，否则刷新后那条已取消的事件又变回"提醒过"。 */
function forgetAlerted(alert) {
  const key = cancelKeyOf(alert)
  if (!key) return
  if (alertedEvents.delete(key)) persistAlerted()
}
/**
 * 清空**整份**"此前提醒过"的记忆（内存 + 磁盘）。只清内存或只清一半会让同一条解除在两个标签页
 * 上得出相反结论，任意一页刷新后记忆也会从 ALERTED_KEY 复活。
 */
function forgetAllAlerted() {
  alertedEvents.clear()
  try { saveJSON(ALERTED_KEY, {}) } catch (err) { /* 写入本地存储失败：内存已清，下一次写入会覆盖 */ }
}
/**
 * 取消 / 解除消息是否有"此前确实提醒过的同一事件"。窗口必须与 alertedEvents 的保留期（24 小时）
 * 一致，不能用 dedupe.windowMinutes（默认 10 分钟）：解除必然晚于发布（实测发布到解除相隔 5 小时）。
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
// 通道必须在插件加载时就建立监听，否则后加载的标签页会错过先到的广播；不支持 BroadcastChannel
// 时退化为「各标签页各自提醒」。
//
// TTL 取 10 分钟：真正会重复播报的是**先被冻结、后恢复**的标签页——恢复后它才拉到同一批 entry，
// 5 秒窗口早已过期；10 分钟与消息级去重窗口一致。
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
      if (d.type === 'history-cleared') {
        alertedEvents.clear()
        try { saveJSON(ALERTED_KEY, {}) } catch (err) { /* 写入本地存储失败：内存已清 */ }
        // **内存副本与磁盘都要清**：只清 alertedEvents 的话，本标签页的历史列表仍显示那些条目，
        // 下一次 addEvent 会把它们（连同新条目）重新写回 localStorage。
        store.push({ events: [] })
        try { saveJSON(HISTORY_KEY, []) } catch (err) { /* 写入本地存储失败：内存已清，下次 addEvent 会覆盖 */ }
        return
      }
      if (d.type !== 'alerted' || !d.key) return
      tabAlerted.set(String(d.key), Date.now())
      // 顺带同步事件键：其它标签页此前提醒过的事件，本标签页在收到取消消息时也要知道
      if (d.eventKey) alertedEvents.set(String(d.eventKey), Date.now())
    }
  } catch (err) { alertChannel = null }
  return alertChannel
}
/** 抢占这条提醒：已被本标签页抢占过则返回 false，抢占成功则广播给其它标签页。 */
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
/** 广播「历史已清空」，让其它标签页同步清掉内存副本与磁盘（见 13-ui-settings 的清空按钮）。 */
function broadcastHistoryCleared() {
  if (ensureAlertChannel()) {
    try { alertChannel.postMessage({ type: 'history-cleared' }) } catch (err) { /* 忽略 */ }
  }
}


// 通道关闭
function closeAlertChannel() {
  try { if (alertChannel) { alertChannel.close(); alertChannel = null } } catch (err) { /* 忽略 */ }
}

export { isDuplicate, isEventRepeat, isStrengthUpgrade, weakenEvent, forgetEvent, ensureAlertChannel, closeAlertChannel, claimAlertForTab, broadcastHistoryCleared, cancelKeyOf, rememberAlerted, forgetAlerted, forgetAllAlerted, wasRecentlyAlerted, sourceIdOf, crossSourceCopyOf, noteAuthoritySuppressed, authorityStatsOf, SOURCE_RANK, sourceNameOf, SOURCE_AGENCY, agencyOf, CROSS_SOURCE_KINDS, rankOfSource, sourceZhOf, alertedEvents }
