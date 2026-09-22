// ============================================================================
// dsh-quake-alert · client/src/05h-overseas-parsers.js
//
// 作用：把**海外气象源**（美国 NWS、加拿大 ECCC）的预警解析成与日本源 / 全球源 /
// 大陆源同一套内部模型（Alert）。设计与实测依据见 DESIGN 4.7。
// 内容：`nws_alerts`——NWS 的洪水类预警（8 种 event）；`eccc_alerts`——ECCC 的
//       降雨 / 洪水 / 风暴潮类 warning。
// 依赖：02-storage（isPlainObject / own）。
//
// 与其它源的结构性差异（都是实测决定的）：
//
// ① **`locator: 'overseas'`**（新值）。取数器是**按关注点查询**的（NWS 用 `?point=`、
//    ECCC 用 `?bbox=`），也就是"这条预警属于哪个关注点"在**取数时就已经确定**，
//    由取数器通过 opts.place 传进来（记成 alert.originPlace）。匹配层因此不做距离计算
//    ——这与全球地震源（`locator:'point'`，靠震中坐标算距离）是两种形态。
//
// ② **NWS 的播报门槛按 `event` 名，不按 severity**。实测：`Flood Watch` 的 severity 也是
//    `Severe`（与 `Flood Warning` 同级），而 `Coastal Flood Watch` 是 `Moderate`
//    ——severity 区分不了"警告"与"警戒"。而 NWS 的 event 名本身有层级
//    （Warning = 正在或即将发生 / Watch = 条件有利 / Advisory = 轻微 / Statement = 说明），
//    所以门槛取 `Warning` 结尾（见 NWS_EVENT_WHITELIST 的 rank）。
//
// ③ **ECCC 只接 `alert_type === 'warning'`**。advisory 按 ECCC 自己的定义是
//    「generally not considered hazardous」，霜冻 / 雾 / 高温都在里面——实测当前 116 条
//    里 114 条是 frost advisory，不排除它这个源就是噪声源。
//
// ④ **ECCC 的白名单按 `alert_name_en` 关键词，不按 CAP 的 `<event>`**。
//    实测：CAP **XML 归档**里法语办公室（CWUL 魁北克）的 `<event>` 是法语 `"gel"`，
//    但 OGC API 通道（我们走的就是这条）给的是固定英文 `alert_name_en`（`"frost advisory"`）
//    与双语字段，**没有语言变体问题**；API 里也没有 CAP 的 `eventCode`（只有三字母
//    `alert_code`，其码表无官方枚举），所以白名单只能落在英文名上。
//    ECCC 的降雨类当前季节**没有样本**（DESIGN 4.6.3 的缺口），这份白名单**未被证实**，
//    因此白名单外的新类型判 `empty`（向前兼容）而不是 schema：旧 Client 静默跳过，
//    不会点亮一个用户处理不了的蓝点（与 nmc 的 empty 判据同一手法）。
//
// ⑤ **事件键（eventKey）按"事件链"取，不是按消息取**。两个源的 id 语义不同：
//    · NWS 的 CAP identifier 实测形如 `urn:oid:2.49.0.1.840.0.<40hex>.<serial>.<version>`，
//      而 Update / Cancel 会**换一条新的 identifier**（2026-09-22 实测过去 7 天 500 条：
//      11 个多消息事件组里 **0 组**是"同一 serial 只递增 version"，Cancel 的 identifier
//      与它引用的原消息连 40 位 hash 都不同）。
//      → 所以事件键**必须用 CAP 的 `references`**（指向被取代的原消息），见 nwsEventKeyOf。
//    · ECCC 的 API **没有稳定的 alert id**（只有 `alert_code` + `feature_id`），
//      → 事件键 = 码 + 区域 + **发布日**：同一天内的更新同键（不重复响），跨天的新过程换键。
//    消息级 id 仍保留完整信息（含版本 / 发布时刻），供"同一条消息重复到达"去重。
//
// 两条共同的已知缺口（UI 与文档必须如实说明）：
//   · **没有可靠的"解除"表达**。NWS 有 `messageType: 'Cancel'`（可用）；ECCC 的
//     `status_en` 实测有 `ended` 与 `continued`，但一条刚发布的霜冻也是 `ended`
//     ——含义未证实，所以 ECCC 的 cancelled **恒为 false**（宁可多说一次，不假装能处理）。
//   · **上游停更看不见**：两个源都是"按点 / 框查询"，空响应是常态，契约里 `staleAfterMs`
//     只能是 null（DESIGN 4.7.7 第 2 条）。
// ============================================================================

import { isPlainObject, own } from './02-storage.js'

/** NWS 的 `event` → 内部灾种与播报档位。白名单是**精确匹配**（见文件头 ②）。 */
const NWS_EVENT_WHITELIST = {
  'Flood Warning': { kind: 'flood', text: '洪水', rank: 3 },
  'Flash Flood Warning': { kind: 'flashFlood', text: '山洪', rank: 3 },
  'Coastal Flood Warning': { kind: 'coastalFlood', text: '沿海洪水', rank: 3 },
  'Flood Watch': { kind: 'flood', text: '洪水警戒', rank: 1 },
  'Flood Advisory': { kind: 'flood', text: '洪水注意', rank: 1 },
  'Coastal Flood Watch': { kind: 'coastalFlood', text: '沿海洪水警戒', rank: 1 },
  'Coastal Flood Advisory': { kind: 'coastalFlood', text: '沿海洪水注意', rank: 1 },
  'Coastal Flood Statement': { kind: 'coastalFlood', text: '沿海洪水说明', rank: 1 },
}
/** NWS 的 severity → 配色（忠实映射，不拔高；与 nmc 的"四色即等级"同一口径）。 */
const NWS_SEVERITY = { Extreme: 'red', Severe: 'orange', Moderate: 'yellow', Minor: 'info' }
/** NWS 的 severity → 强度序（用于"同一事件的后续发布是否升级"）。 */
const NWS_SEV_RANK = { Extreme: 4, Severe: 3, Moderate: 2, Minor: 1 }

/** ECCC 的 `risk_colour_en` → 配色。ECCC 的三色与 nmc 的四色同源，可直接对应。 */
const ECCC_COLOUR_SEVERITY = { red: 'red', orange: 'orange', yellow: 'yellow' }
/** ECCC 的三色 → 强度序。**没有 info 档**：只有 warning 进来，而黄色 warning 按 ECCC 的
 *  定义已经是"hazardous weather may cause damage, disruption, or health impacts"。 */
const ECCC_COLOUR_RANK = { red: 4, orange: 3, yellow: 2 }

/** ECCC 的灾种白名单：**先看排除名单，再看包含名单**（见文件头 ④）。 */
const ECCC_EXCLUDE = /frost|fog|freez|snow|blizzard|ice\b|icing|wind|gale|heat|cold|thunderstorm|tornado|hurricane|tropical|air quality|humidex|visibility/i
const ECCC_INCLUDE = /rain|flood|surge|hydrolog|water|precipitation/i

/**
 * ECCC 的英文名 → 中文灾种标签。
 * **按名称关键词映射，不查未知的三字母码表**——`alert_code` 的取值没有官方枚举，
 * 猜码正是 4.6.3 踩过的坑（把 `CFW` 当成洪水，实际是 storm surge warning）。
 */
function ecccKindTextOf(nameEn) {
  const s = String(nameEn || '')
  if (/storm surge|surge/i.test(s)) return '风暴潮预警'
  if (/flash flood/i.test(s)) return '山洪预警'
  if (/flood/i.test(s)) return '洪水预警'
  if (/rain|precipitation/i.test(s)) return '降雨预警'
  if (/hydrolog|water/i.test(s)) return '水文预警'
  return '气象预警'
}

/** 播报门槛（两个源共用）：`overseasRank >= 3` 才打扰用户，否则只进历史。 */
export const OVERSEAS_BROADCAST_MIN_RANK = 3

/** NWS 的 `event` → 中文（供 UI / 测试使用）。 */
export const NWS_KIND_TEXT = Object.fromEntries(
  Object.entries(NWS_EVENT_WHITELIST).map(([ev, v]) => [ev, v.text]),
)

/**
 * NWS 的事件键。**必须优先用 CAP 的 `references`**（0.6.0 review 修正）。
 *
 * 实测（2026-09-22，过去 7 天的 500 条 Flood / Flash Flood / Coastal Flood 电文）：
 * **11 个多消息事件组里 0 组是"同一 serial 只递增 version"**，而 Cancel 消息的 identifier
 * 与它 `references` 的那条原消息**连 40 位 hash 都不同**（例：Cancel `a27ba9d7…` 引用
 * `d17b28bf…`）。所以"去掉末尾版本段"这条规则**关联不上原警报**：
 * 播报时记下的键是原 Alert 的，Cancel 到达时算出的是另一个键 → `wasRecentlyAlerted` 恒为假
 * → 用户永远收不到"此前播报的警报已作废"（与 nmc 的缺口一模一样，而当时的设计正好相反地
 * 宣称"NWS 有真正的取消语义"）。
 *
 * 正确做法就是 CAP 语义本身：Update / Cancel 的 `<references>` 指向**被它取代的消息**。
 * 取其中 `sent` 最早的一条作为事件链的根（并列时按 identifier 字典序，保证确定性），
 * 再去掉末尾的 `.<version>` —— 最后这一步是兜底：万一某条 references 只指向上一版
 * （而不是原始那条），去版本段之后仍与更早的版本同键。
 * 没有 references 的（就是原始 Alert）用自身 identifier。
 */
function nwsEventKeyOf(id, references) {
  const refs = Array.isArray(references) ? references : []
  let best = null
  for (const r of refs) {
    if (!r || typeof r.identifier !== 'string' || !r.identifier) continue
    const t = Number.isFinite(Date.parse(r.sent)) ? Date.parse(r.sent) : Number.POSITIVE_INFINITY
    if (!best || t < best.t || (t === best.t && String(r.identifier) < String(best.id))) {
      best = { t, id: r.identifier }
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
 *
 * @param {object} feature `{ id, type, geometry, properties }`
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
  // id 优先取 properties.id（CAP identifier）；缺了才退回外层 id。两者都缺就没法做去重，
  // 判 null 由契约层归成 schema（见契约的 required）。
  const rawId = String(p.id || feature.id || '').trim()
  if (!rawId) return null
  // GeoJSON 外层的 `feature.id` 是**完整 URL**（`https://api.weather.gov/alerts/urn:oid:…`）。
  // 抽出 `urn:oid:` 段再用（0.6.0 review 修正）：否则事件键里带着 URL 前缀，末尾版本段的
  // 归并（以及取消消息的 references 匹配）都会失效——同一场洪水会随每次更新重复响铃。
  const idMatch = /(urn:oid:[\s\S]+)$/.exec(rawId)
  const id = idMatch ? idMatch[1] : rawId
  const sent = typeof p.sent === 'string' ? p.sent : ''
  if (!sent || !Number.isFinite(Date.parse(sent))) return null
  const sev = typeof p.severity === 'string' && own(NWS_SEVERITY, p.severity) ? p.severity : ''
  const areaDesc = String(p.areaDesc || '').trim()
  const headline = String(p.headline || '').trim()
  // 正文原样保留：NWS 没有"不得改写"的条款，但改写官方正文对任何源都不合适，
  // 而 instruction 是"该怎么做"——截断它才是真的危险。
  const description = String(p.description || '').trim()
  const instruction = String(p.instruction || '').trim()
  const detail = [description, instruction].filter(Boolean).join('\n\n')
  const place = opts && isPlainObject(opts.place) ? opts.place : null
  return {
    id: 'nws:' + id,
    code: 'nws_alerts',
    // kind 复用 'weather'：与日本气象电文 / 大陆气象预警共用"进历史 / 配色 / 文案"整条链路。
    // 真正区分三者的是 locator（overseas / area / regions）。
    kind: 'weather',
    kindLabel: '美国' + rule.text + '（' + (String(p.senderName || '').trim() || 'NWS') + '）',
    source: 'nws_alerts',
    locator: 'overseas',
    severity: sev ? own(NWS_SEVERITY, sev) : 'info',
    issued: sent,
    reportTime: sent,
    headline: headline || (rule.text + (areaDesc ? ' · ' + areaDesc : '')),
    maxScale: -1,
    level: 0,
    regions: [],
    eventKey: nwsEventKeyOf(id, p.references),
    strength: (sev && own(NWS_SEV_RANK, sev)) || 0,
    // 海外源特有：这条预警属于哪个关注点（取数时确定），以及供 UI / 诊断用的原始标签。
    originPlace: place,
    overseas: {
      country: 'us',
      event,
      // NWS 的 eventCode 是对象（`{SAME:['FLW'], NationalWeatherService:['FLW']}`），
      // **不能当白名单键**（实测 Flood Warning 的 SAME 给的是 FLS）。这里只留一份供诊断。
      eventCode: isPlainObject(p.eventCode) ? p.eventCode : null,
      areaDesc,
      messageType: String(p.messageType || ''),
      senderName: String(p.senderName || ''),
      ends: String(p.ends || p.expires || ''),
      ugc: isPlainObject(p.geocode) && Array.isArray(p.geocode.UGC) ? p.geocode.UGC : [],
    },
    // 播报档位：Warning 类 = 3，Watch / Advisory / Statement = 1（见文件头 ②）。
    overseasRank: rule.rank,
    nwsEvent: event,
    detail,
    // NWS 有真正的取消语义（CAP 的 messageType），这条比 nmc 强。
    cancelled: String(p.messageType || '') === 'Cancel',
    raw: feature,
  }
}

/**
 * ECCC 的预警体（一条 GeoJSON feature）→ Alert。
 *
 * @param {object} feature `{ type, geometry, properties }`
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
  // 白名单：先排除、再包含。ECCC_EXCLUDE 里有 wind、ECCC_INCLUDE 里有 surge——
  // "storm surge warning" 两边都不冲突，但把顺序写死能避免将来加词时互相打架。
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
  // 区域键：feature_id 优先（稳定），缺了退回区域名（见文件头 ⑤ 的事件键说明）。
  const areaKey = String(p.feature_id || area || province || 'unknown')
  // 署名是 ECCC 许可（End-use Licence v2.1.1）的硬要求，且正文**不得改写**
  // ——所以正文原样保留，署名作为末行一起进历史与通知。
  const ATTRIBUTION = 'Data Source: Environment and Climate Change Canada'
  return {
    id: 'eccc:' + code + ':' + areaKey + ':' + published,
    code: 'eccc_alerts',
    kind: 'weather',
    kindLabel: '加拿大' + textZh + '（ECCC）',
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
    // ECCC 的 `status_en` 实测有 ended / continued，但一条刚发布的霜冻也是 `ended`
    // ——含义未证实，所以**不据此判取消**（DESIGN 4.7.7 第 6 条）。宁可多说一次。
    cancelled: false,
    raw: feature,
  }
}

export {
  parseNwsAlert, parseEcccAlert, ecccKindTextOf, nwsEventKeyOf, ecccEventKeyOf,
  NWS_EVENT_WHITELIST, NWS_SEVERITY, NWS_SEV_RANK,
  ECCC_COLOUR_SEVERITY, ECCC_COLOUR_RANK, ECCC_INCLUDE, ECCC_EXCLUDE,
}
