// ============================================================================
// dsh-quake-alert · client/src/05h-overseas-parsers.js
//
// 作用：把**海外气象源**（美国 NWS、加拿大 ECCC）的预警解析成内部模型（Alert）。
// 内容：`nws_alerts`——NWS 的洪水类预警（8 种 event）；`eccc_alerts`——ECCC 的降雨 / 洪水 / 风暴潮 warning。
// 依赖：02-storage（isPlainObject / own）、00-i18n（t）。
//
// 与其它源的结构性差异：
// ① **`locator: 'overseas'`**：取数器是**按关注点查询**的（NWS 用 `?point=`、ECCC 用 `?bbox=`），
//    "这条预警属于哪个关注点"在取数时已确定，由取数器通过 opts.place 传进来（记成 alert.originPlace），
//    匹配层因此不做距离计算——与全球地震源（`locator:'point'`）是两种形态。
// ② **NWS 的播报门槛按 `event` 名，不按 severity**：实测 `Flood Watch` 的 severity 也是 `Severe`，
//    区分不了"警告"与"警戒"；而 event 名本身有层级，所以门槛取 `Warning` 结尾（见白名单的 rank）。
// ③ **ECCC 只接 `alert_type === 'warning'`**：advisory 按 ECCC 的定义是「generally not considered
//    hazardous」（实测 116 条里 114 条是 frost advisory）。
// ④ **ECCC 的白名单按 `alert_name_en` 关键词，不按 CAP 的 `<event>`**：CAP XML 归档里法语办公室的
//    `<event>` 是法语，而 OGC API 通道（我们走的这条）给的是固定英文名，没有语言变体问题；API 里也
//    没有 CAP 的 eventCode（只有三字母 `alert_code`，其码表无官方枚举）。降雨类当前季节**没有样本**，
//    这份白名单**未被证实** → 白名单外的新类型判 `empty`（向前兼容）。
// ⑤ **事件键按"事件链"取，不是按消息取**：NWS 的 CAP identifier 在 Update / Cancel 时会换一条新的
//    → 键落在 **VTEC 的事件追踪号**上（见 nwsEventKeyOf）；ECCC 没有稳定的 alert id → 事件键 =
//    码 + 区域 + **发布日**：同一天内的更新同键，跨天的新过程换键。
//
// 两条共同的已知缺口：**ECCC 没有可靠的"解除"表达**（`status_en` 的 ended 连刚发布的霜冻都有，
// 含义未证实，所以 cancelled 恒为 false；NWS 有 CAP 的 Cancel 可用）；**上游停更看不见**（按点 /
// 框查询的空响应是常态，`staleAfterMs` 只能 null）。
// ============================================================================

import { isPlainObject, own } from './02-storage.js'
import { t } from './00-i18n.js'

/** NWS 的 `event` → 内部灾种与播报档位。白名单是**精确匹配**。 */
const NWS_EVENT_WHITELIST = {
  'Flood Warning': { kind: 'flood', text: 'kind.nwsFlood', rank: 3 },
  'Flash Flood Warning': { kind: 'flashFlood', text: 'kind.nwsFlashFlood', rank: 3 },
  'Coastal Flood Warning': { kind: 'coastalFlood', text: 'kind.nwsCoastalFlood', rank: 3 },
  'Flood Watch': { kind: 'flood', text: 'kind.nwsFloodWatch', rank: 1 },
  'Flood Advisory': { kind: 'flood', text: 'kind.nwsFloodAdvisory', rank: 1 },
  'Coastal Flood Watch': { kind: 'coastalFlood', text: 'kind.nwsCoastalWatch', rank: 1 },
  'Coastal Flood Advisory': { kind: 'coastalFlood', text: 'kind.nwsCoastalAdvisory', rank: 1 },
  'Coastal Flood Statement': { kind: 'coastalFlood', text: 'kind.nwsCoastalStatement', rank: 1 },
}
/** NWS 的 severity → 配色（忠实映射，不拔高）。 */
const NWS_SEVERITY = { Extreme: 'red', Severe: 'orange', Moderate: 'yellow', Minor: 'info' }
/** NWS 的 severity → 强度序（用于"同一事件的后续发布是否升级"）。 */
const NWS_SEV_RANK = { Extreme: 4, Severe: 3, Moderate: 2, Minor: 1 }

/** ECCC 的 `risk_colour_en` → 配色（三色与 nmc 的四色同源，可直接对应）。 */
const ECCC_COLOUR_SEVERITY = { red: 'red', orange: 'orange', yellow: 'yellow' }
/** ECCC 的三色 → 强度序。**没有 info 档**：只有 warning 进来，黄色 warning 按 ECCC 的定义已经
 *  属于 hazardous。 */
const ECCC_COLOUR_RANK = { red: 4, orange: 3, yellow: 2 }

/** ECCC 的灾种白名单：**先看排除名单，再看包含名单**。 */
const ECCC_EXCLUDE = /frost|fog|freez|snow|blizzard|ice\b|icing|wind|gale|heat|cold|thunderstorm|tornado|hurricane|tropical|air quality|humidex|visibility/i
const ECCC_INCLUDE = /rain|flood|surge|hydrolog|water|precipitation/i

/** ECCC 的英文名 → 中文灾种标签。**按名称关键词映射，不查三字母码表**——`alert_code` 没有官方
 *  枚举，猜码踩过坑（把 `CFW` 当成洪水，实际是 storm surge warning）。 */
function ecccKindTextOf(nameEn) {
  const s = String(nameEn || '')
  if (/storm surge|surge/i.test(s)) return t('kind.caStormSurge')
  if (/flash flood/i.test(s)) return t('kind.caFlashFlood')
  if (/flood/i.test(s)) return t('kind.caFlood')
  if (/rain|precipitation/i.test(s)) return t('kind.caRain')
  if (/hydrolog|water/i.test(s)) return t('kind.caHydrology')
  return t('kind.caWeather')
}

/** 播报门槛（两个源共用）：`overseasRank >= 3` 才打扰用户；未达档位的也不进历史。 */
export const OVERSEAS_BROADCAST_MIN_RANK = 3

/** NWS 的 event → **当前界面语言**的灾种名（供 UI / 测试使用）。**必须是函数**：写成模块级常量会在
 *  加载时求值，把语言冻在那一刻（切语言后不跟着变）。 */
export function nwsKindTextOf(ev) {
  const rule = own(NWS_EVENT_WHITELIST, String(ev || ''))
  return rule ? t(rule.text) : ''
}
/** 整张表（按当前语言求值）。 */
export const nwsKindTextMap = () => Object.fromEntries(
  Object.entries(NWS_EVENT_WHITELIST).map(([ev, v]) => [ev, t(v.text)]),
)

/**
 * NWS 的 **VTEC 事件追踪键**：`<office>.<phenom>.<significance>.<ETN>`。VTEC 段位是
 * `/O.<ACTION>.<OFFICE>.<PHENOM>.<SIG>.<ETN>.<BEGIN>-<END>/`；**ACTION 之外的四段跨版本稳定**
 * （同一次洪水从 `NEW` → `EXT` → `CON` → `CAN` 只改 ACTION），所以键必须剔除 ACTION。
 *
 * @param {unknown} vtecList `properties.parameters.VTEC`（字符串数组）
 * @returns {string} 解析不出来时返回 ''（调用方退到兜底）
 */
function nwsVtecKeyOf(vtecList) {
  if (!Array.isArray(vtecList)) return ''
  for (const raw of vtecList) {
    // 不在行首锚定：实测存在一条字符串里带多段 VTEC 的产品，取第一段即可。
    // ETN 段放宽到 `\d{4,6}`：NWS 规范写 4 位，但实测出现过 5 位（`/O.NEW.KRLX.FA.W.01370.…/`），
    // 写死 4 位会让整段失配，调用方就退回 references 兜底（每次 Update 各得一键 → 重复响铃）。
    // 放宽是上界，不会把两个不同事件并成一个（ETN 仍要求 ≥4 位数字）。
    const m = /\/O\.[A-Z]{3}\.([A-Z0-9]{4})\.([A-Z]{2})\.([A-Z])\.(\d{4,6})\./.exec(String(raw || ''))
    if (m) return m[1] + '.' + m[2] + '.' + m[3] + '.' + m[4]
  }
  return ''
}

/**
 * NWS 的事件键。**首选 VTEC 的事件追踪号**。
 *
 * 不能用 CAP 的 `references`：它指向**被本条取代的那条消息**，而 NWS 实测是**逐版串联**的链
 * （每条只引用紧邻的上一版），"取 sent 最早的一条"**只能回溯一步**，算出的键每版都不同 → 同一场
 * 洪水随每次 Update 重复响铃。兜底顺序（**都不判 schema**）：① VTEC 追踪号；② references 里
 * `sent` 最早的一条（保留给没有 VTEC 的海事 / 特殊电文）；③ 自身 identifier。后两者去掉末尾版本段。
 */
function nwsEventKeyOf(id, references, vtecList) {
  const vtec = nwsVtecKeyOf(vtecList)
  if (vtec) return 'nws:' + vtec
  const refs = Array.isArray(references) ? references : []
  let best = null
  for (const r of refs) {
    if (!r || typeof r.identifier !== 'string' || !r.identifier) continue
    // 局部变量不叫 `t`（那是 00-i18n 的取词函数）
    const sentMs = Number.isFinite(Date.parse(r.sent)) ? Date.parse(r.sent) : Number.POSITIVE_INFINITY
    if (!best || sentMs < best.sentMs || (sentMs === best.sentMs && String(r.identifier) < String(best.id))) {
      best = { sentMs, id: r.identifier }
    }
  }
  const base = best ? best.id : id
  return 'nws:' + String(base).replace(/\.[0-9]+$/, '')
}

/** ECCC 的事件键：码 + 区域 + 发布日（同一天内的更新同键）。 */
function ecccEventKeyOf(code, areaKey, published) {
  const day = String(published).slice(0, 10)
  return 'eccc:' + code + ':' + areaKey + ':' + day
}

/**
 * NWS 的预警体（一条 GeoJSON feature）→ Alert。
 * @param {{ place?: object }} [opts] `place` 是取数器查这条时用的关注点（记成 originPlace）
 * @returns {object|null} 结构不符或不在白名单时返回 null（由契约层分类成 schema / empty）
 */
function parseNwsAlert(feature, opts) {
  if (!isPlainObject(feature)) return null
  const p = feature.properties
  if (!isPlainObject(p)) return null
  const event = typeof p.event === 'string' ? p.event : ''
  const rule = own(NWS_EVENT_WHITELIST, event)
  if (!rule) return null
  // id 优先取 properties.id（CAP identifier），缺了才退回外层 id；两者都缺就设法去重，判 null。
  const rawId = String(p.id || feature.id || '').trim()
  if (!rawId) return null
  // GeoJSON 外层的 `feature.id` 是**完整 URL**（`https://api.weather.gov/alerts/urn:oid:…`），抽出
  // `urn:oid:` 段再用：否则事件键带着 URL 前缀，末尾版本段的归并与取消消息的匹配都会失效。
  const idMatch = /(urn:oid:[\s\S]+)$/.exec(rawId)
  const id = idMatch ? idMatch[1] : rawId
  const sent = typeof p.sent === 'string' ? p.sent : ''
  if (!sent || !Number.isFinite(Date.parse(sent))) return null
  const sev = typeof p.severity === 'string' && own(NWS_SEVERITY, p.severity) ? p.severity : ''
  const areaDesc = String(p.areaDesc || '').trim()
  const headline = String(p.headline || '').trim()
  // 正文原样保留：改写官方正文对任何源都不合适，而 instruction 是"该怎么做"——截断它才危险。
  const description = String(p.description || '').trim()
  const instruction = String(p.instruction || '').trim()
  const detail = [description, instruction].filter(Boolean).join('\n\n')
  const place = opts && isPlainObject(opts.place) ? opts.place : null
  const vtecList = isPlainObject(p.parameters) ? own(p.parameters, 'VTEC') : null
  const vtecKey = nwsVtecKeyOf(vtecList)
  return {
    id: 'nws:' + id,
    code: 'nws_alerts',
    // kind 复用 'weather'：与日本气象电文 / 大陆气象预警共用整条链路；真正区分三者的是 locator。
    kind: 'weather',
    kindLabel: t('kind.usHazard', { hazard: t(rule.text) }) + '（' + (String(p.senderName || '').trim() || 'NWS') + '）',
    source: 'nws_alerts',
    locator: 'overseas',
    severity: sev ? own(NWS_SEVERITY, sev) : 'info',
    issued: sent,
    reportTime: sent,
    headline: headline || (rule.text + (areaDesc ? ' · ' + areaDesc : '')),
    maxScale: -1,
    level: 0,
    regions: [],
    eventKey: nwsEventKeyOf(id, p.references, vtecList),
    strength: (sev && own(NWS_SEV_RANK, sev)) || 0,
    // 海外源特有：这条预警属于哪个关注点（取数时确定）。
    originPlace: place,
    overseas: {
      country: 'us',
      event,
      // NWS 的 eventCode 是对象（`{SAME:['FLW'],…}`），**不能当白名单键**（Flood Warning 的 SAME
      // 实测给的是 FLS）。这里只留一份供诊断。
      eventCode: isPlainObject(p.eventCode) ? p.eventCode : null,
      areaDesc,
      messageType: String(p.messageType || ''),
      senderName: String(p.senderName || ''),
      ends: String(p.ends || p.expires || ''),
      ugc: isPlainObject(p.geocode) && Array.isArray(p.geocode.UGC) ? p.geocode.UGC : [],
      // 事件键的来源（供诊断核对"这条属于哪一次事件"）。
      vtecKey,
    },
    // 播报档位：Warning 类 = 3，Watch / Advisory / Statement = 1（见文件头 ②）。
    overseasRank: rule.rank,
    nwsEvent: event,
    detail,
    // NWS 有真正的取消语义（CAP messageType）。
    cancelled: String(p.messageType || '') === 'Cancel',
    raw: feature,
  }
}

/**
 * ECCC 的预警体（一条 GeoJSON feature）→ Alert。
 * @param {{ place?: object }} [opts]
 * @returns {object|null} 结构不符 / 不是 warning / 不在白名单时返回 null
 */
function parseEcccAlert(feature, opts) {
  if (!isPlainObject(feature)) return null
  const p = feature.properties
  if (!isPlainObject(p)) return null
  const alertType = typeof p.alert_type === 'string' ? p.alert_type : ''
  if (alertType !== 'warning') return null
  const code = typeof p.alert_code === 'string' ? p.alert_code.trim() : ''
  const nameEn = typeof p.alert_name_en === 'string' ? p.alert_name_en.trim() : ''
  // 白名单：先排除、再包含——顺序写死能避免将来加词时互相打架（"storm surge warning" 两边都不冲突）。
  if (!nameEn || ECCC_EXCLUDE.test(nameEn) || !ECCC_INCLUDE.test(nameEn)) return null
  if (!code) return null
  const published = typeof p.publication_datetime === 'string' ? p.publication_datetime : ''
  if (!published || !Number.isFinite(Date.parse(published))) return null
  const colour = typeof p.risk_colour_en === 'string' ? p.risk_colour_en.toLowerCase() : ''
  if (!own(ECCC_COLOUR_SEVERITY, colour)) return null
  const area = String(p.feature_name_en || '').trim()
  const text = String(p.alert_text_en || '').trim()
  const province = String(p.province || '').trim()
  const place = opts && isPlainObject(opts.place) ? opts.place : null
  const textZh = ecccKindTextOf(nameEn)
  // 区域键：feature_id 优先（稳定），缺了退回区域名。
  const areaKey = String(p.feature_id || area || province || 'unknown')
  // 署名是 ECCC 许可（End-use Licence v2.1.1）的硬要求，正文**不得改写**——所以正文原样保留，
  // 署名作为末行一起进历史与通知。
  const ATTRIBUTION = 'Data Source: Environment and Climate Change Canada'
  return {
    id: 'eccc:' + code + ':' + areaKey + ':' + published,
    code: 'eccc_alerts',
    kind: 'weather',
    kindLabel: t('kind.caHazard', { hazard: textZh }) + '（ECCC）',
    source: 'eccc_alerts',
    locator: 'overseas',
    severity: own(ECCC_COLOUR_SEVERITY, colour),
    issued: published,
    reportTime: published,
    headline: textZh + (area ? ' · ' + area : '') + (province ? '（' + province + '）' : ''),
    maxScale: -1,
    level: 0,
    regions: [],
    eventKey: ecccEventKeyOf(code, areaKey, published),
    strength: own(ECCC_COLOUR_RANK, colour) || 0,
    originPlace: place,
    overseas: {
      country: 'ca',
      alertCode: code,
      nameEn,
      colour,
      province,
      area,
      statusEn: String(p.status_en || ''),
      confidence: String(p.confidence_en || ''),
      impact: String(p.impact_en || ''),
      expiry: String(p.expiration_datetime || ''),
      validity: String(p.validity_datetime || ''),
      attribution: ATTRIBUTION,
    },
    overseasRank: 3,
    ecccCode: code,
    detail: text ? text + '\n\n' + ATTRIBUTION : ATTRIBUTION,
    // ECCC 的 `status_en` 实测有 ended / continued，但一条刚发布的霜冻也是 `ended`——含义未证实，
    // 所以**不据此判取消**，宁可多说一次。
    cancelled: false,
    raw: feature,
  }
}

export {
  parseNwsAlert, parseEcccAlert, ecccKindTextOf, nwsEventKeyOf, nwsVtecKeyOf, ecccEventKeyOf,
  NWS_EVENT_WHITELIST, NWS_SEVERITY, NWS_SEV_RANK,
  ECCC_COLOUR_SEVERITY, ECCC_COLOUR_RANK, ECCC_INCLUDE, ECCC_EXCLUDE,
}
