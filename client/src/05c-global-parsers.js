// ============================================================================
// dsh-quake-alert · client/src/05c-global-parsers.js
// 作用：三个全球源 → 与日本源同套 Alert：EMSC standing_order WebSocket（顶层 { action, data }，data 是
//       GeoJSON **Feature** 而非 FeatureCollection）、USGS summary feed、NOAA tsunami.gov 的 CAP 1.2。
// 依赖：02-storage（isPlainObject）、00-i18n（t）。
// 契约：全球源只给「震中坐标 + 震级」，没有都道府县 / 市町村 → locator:'point'、regions 恒为空数组，匹配交给
//       06-matcher 的 matchPointAlert（Haversine 距离）；震级阈值是独立旋钮 thresholds.globalMagnitude（与
//       日本的震度不可换算）。EMSC 的区域字段叫 flynn_region、time 是 ISO 字符串、lat/lon 在 properties 里；
//       USGS 的 geometry.coordinates = [lon, lat, depthKm]、time/updated 是 epoch 毫秒；NOAA 的 circle 是
//       "lat,lon 半径"，震级与震中另有 parameter（EventPreliminaryMagnitude / EventLatLon）。
// ============================================================================

import { isPlainObject } from './02-storage.js'
import { t } from './00-i18n.js'

// 取第一个可用数值（全球源的坐标 / 震级可能同时存在于两三个地方，按优先级回退），经 toNumOrNull 规整，
// 所以**数字字符串也算**（CAP 的 parameter 全是字符串）：只认 typeof number 会让 magnitude 变 null、震级门槛被整个跳过。
function firstNumber(...vals) {
  for (const v of vals) {
    const n = toNumOrNull(v)
    if (n !== null) return n
  }
  return null
}
// 字符串 → 数值；空串与垃圾值一律给 null。不能用 Number('')——它等于 0，会把"没有震级"变成"震级 0"。
function toNumOrNull(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null
  const s = String(v === undefined || v === null ? '' : v).trim()
  if (!s) return null
  const n = Number(s)
  return Number.isFinite(n) ? n : null
}
function decodeXml(s) {
  return String(s)
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&')
}
/** 单个标签的文本（取首个匹配；CAP 的 info/area 都是单层，够用）。 */
function tagText(scope, name) {
  const m = new RegExp('<' + name + '(?:\\s[^>]*)?>([\\s\\S]*?)</' + name + '>').exec(String(scope))
  return m ? decodeXml(m[1]).trim() : ''
}

// 震级 → severity，与日本源按震度分级（10..70）是两套独立边界：M7 以上是需跨区域响应的大地震，
// M6 以上可能造成局部破坏，M5 以上普遍有感。
function severityOfMagnitude(mag) {
  if (typeof mag !== 'number' || !Number.isFinite(mag)) return 'info'
  if (mag >= 7) return 'red'
  if (mag >= 6) return 'orange'
  if (mag >= 5) return 'yellow'
  return 'info'
}

// 事件键里的「发震时刻（分钟）」必须先**换算到 UTC** 再取分钟：各源给的 ISO 偏移不同（EMSC 是 `…Z`、
// USGS 经 toIso 也是 `…Z`，大陆源是 `+08:00`），直接切字符串前 16 位会让同一场地震落进相隔 8 小时的
// 两个桶，键永远不相等、跨源归并失效，同一场地震响两次。无法解析时返回 null（见 geoEventKey）。
function minuteKeyOf(timeIso) {
  const s = String(timeIso === undefined || timeIso === null ? '' : timeIso)
  // 局部变量不叫 `t`（那是 00-i18n 的取词函数，遮蔽了本函数里的 t('key') 会去调 Date.parse）
  const ms = Date.parse(s)
  if (!Number.isFinite(ms)) return null
  return new Date(ms).toISOString().slice(0, 16)
}

// 跨源事件键：同一场地震 EMSC 与 USGS 都会推，两边机构、编号、震级都可能不同，但「发震时刻（分钟）+
// 震中（0.1 度 ≈ 11km）」是一致的，用它把两个全球源的同一次地震归并成一个事件。跨分钟边界（两边测定的
// 发震时刻差过一分钟）时归并会失败——宁可多响一次，不漏报。大陆源（cenc_eew / cenc_eqlist）走同一把钥匙：
// 它们的 **EventID 与 EEW 格式完全不同**（EEW 是 `b4kybfnuqayyy` 这类随机串，速报是 `CD.20260918205536.056`），归并只能靠时间 + 震中。
// 0.1° 桶的字符串化。**必须把 "-0.0" 统一成 "0.0"**：`(-0.02).toFixed(1)` 得 "-0.0" 而 `(0.02).toFixed(1)`
// 得 "0.0"，赤道与本初子午线两侧的震中会落进两个不同的桶，事件键永远不相等 → 跨源归并失败、同一场地震响两次。
function oneDp(n) {
  if (typeof n !== 'number' || !Number.isFinite(n)) return '?'
  const s = n.toFixed(1)
  return s === '-0.0' ? '0.0' : s
}

// 时间不可解析时的事件键序号，**只增不减**：两段时间不可解析的事件永远不会得到同一个键（见 geoEventKey）。
let unknownTimeSeq = 0

function geoEventKey(timeIso, lat, lon) {
  const min = minuteKeyOf(timeIso)
  // 时间不可解析时**不能**退回 `String(timeIso).slice(0, 16)`：空串会切片成空串，键退化成 `geo:@30.9,99.9`，
  // 该震中之后**所有**事件共用这一个键，后续地震全部被判重复而静默（漏报）。给一个不可能与其它事件相同的键。
  const at = min === null ? ('!t' + (++unknownTimeSeq)) : min
  return 'geo:' + at + '@' + oneDp(lat) + ',' + oneDp(lon)
}

/** epoch 毫秒或 ISO 字符串 → ISO 字符串（USGS 给毫秒，EMSC 给字符串，统一到后者）。 */
function toIso(v) {
  if (typeof v === 'number' && Number.isFinite(v)) {
    const d = new Date(v)
    return Number.isFinite(d.getTime()) ? d.toISOString() : ''
  }
  return typeof v === 'string' ? v : ''
}

// EMSC standing_order WebSocket 消息 → Alert。消息形如 { action: 'create'|'update'|'delete', data: Feature }；
// 非地震事件（爆炸等）由 properties.evtype 区分，实测 'ke' = known earthquake。
function parseEmsc(raw) {
  if (!isPlainObject(raw)) return null
  const d = isPlainObject(raw.data) ? raw.data : null
  const p = d && isPlainObject(d.properties) ? d.properties : null
  if (!p) return null
  const coords = (d.geometry && Array.isArray(d.geometry.coordinates)) ? d.geometry.coordinates : []
  const lon = firstNumber(p.lon, coords[0])
  const lat = firstNumber(p.lat, coords[1])
  const depth = firstNumber(p.depth, coords[2])
  const mag = firstNumber(p.mag, null)
  const region = String(p.flynn_region || '').trim()
  const time = toIso(p.time)
  const unid = String(p.unid || p.source_id || d.id || '').trim()
  const headline = 'M' + (mag === null ? '—' : mag) + (region ? ' · ' + region : '') +
    (depth === null ? '' : t('kind.depthSuffix', { depth: Math.round(depth) }))
  return {
    id: 'emsc:' + (unid || (lat + ',' + lon + ',' + time)),
    code: 'emsc',
    kind: 'quake',
    kindLabel: t('kind.globalEmsc'),
    source: 'emsc',
    locator: 'point',
    severity: severityOfMagnitude(mag),
    issued: time,
    headline,
    maxScale: -1,
    level: 0,
    geo: { lat, lon, depthKm: depth },
    magnitude: mag,
    magType: String(p.magtype || ''),
    hypo: { name: region, magnitude: mag },
    regions: [],
    eventKey: geoEventKey(time, lat, lon),
    strength: mag === null ? 0 : mag,
    cancelled: false,
    raw,
  }
}

/** USGS summary feed 的单个 Feature → Alert。coordinates 顺序是 [经度, 纬度, 深度 km]。 */
function parseUsgsFeature(f) {
  if (!isPlainObject(f)) return null
  const p = isPlainObject(f.properties) ? f.properties : null
  if (!p) return null
  const coords = (isPlainObject(f.geometry) && Array.isArray(f.geometry.coordinates)) ? f.geometry.coordinates : []
  const lon = firstNumber(coords[0], p.lon)
  const lat = firstNumber(coords[1], p.lat)
  // 坐标不完整时**不造事件对象**：null 组合会让不同地震的 id 撞在一起（`usgs:null,null,<time>`），并进历史与诊断。
  if (typeof lat !== 'number' || !Number.isFinite(lat) ||
      typeof lon !== 'number' || !Number.isFinite(lon)) return null
  const depth = firstNumber(coords[2], null)
  const mag = firstNumber(p.mag, null)
  const place = String(p.place || '').trim()
  const time = toIso(p.time)
  const headline = 'M' + (mag === null ? '—' : mag) + (place ? ' · ' + place : '') +
    (depth === null ? '' : t('kind.depthSuffix', { depth: Math.round(depth) }))
  return {
    id: 'usgs:' + String(f.id || p.code || (lat + ',' + lon + ',' + time)),
    code: 'usgs',
    kind: 'quake',
    kindLabel: t('kind.globalUsgs'),
    source: 'usgs',
    locator: 'point',
    severity: severityOfMagnitude(mag),
    issued: time,
    headline,
    maxScale: -1,
    level: 0,
    geo: { lat, lon, depthKm: depth },
    magnitude: mag,
    magType: String(p.magType || ''),
    // USGS 的 alert 字段（green/yellow/orange/red）是 PAGER 的损失评估，实测全为 null：不做映射，severity 统一按震级判，避免两个源对同一地震给出不同颜色。
    hypo: { name: place, magnitude: mag },
    regions: [],
    eventKey: geoEventKey(time, lat, lon),
    strength: mag === null ? 0 : mag,
    cancelled: false,
    raw: f,
  }
}

// NOAA tsunami.gov 的事件分级。CAP 的 <severity>（Minor/Moderate/…）对海啸不够具体，真正决定行动的是
// <event> 名称。第三项是**等级**，与日本 552 的 TSUNAMI_RANK（Watch=1/Warning=2/MajorWarning=3）同一把尺，
// 由 matchPointAlert 用 thresholds.tsunamiGrade 做门槛；第四项是颜色。**等级与标签必须同口径**：Advisory /
// Watch 的等级是 2（对应日本的「海啸警報」档，NOAA 的官方定义是"对近水的人有危险"），标签不能写成「注意报」。
// 「Tsunami Information」= 0：语义上低于日本的「津波注意報」，按 1 处理会让它在半径内直接响铃。
// event 名是**受控词表**（CAP 里由发布机构填写），所以**整串锚定**匹配（大小写与多余空格先统一）：子串匹配会把
// "Not a Tsunami Warning" / "Tsunami Warning Cancellation" 抬到最高档 3（误报方向）。未识别的 event 用如实
// 标签落历史，等级仍是 0（不会响铃，但能看出上游加了新 event 名）。
const NOAA_EVENT_RULES = [
  [/^tsunami warning$/, 'kind.noaaMajorWarning', 3, 'red'],
  [/^tsunami advisory$/, 'kind.noaaWarning', 2, 'orange'],
  [/^tsunami watch$/, 'kind.noaaWarning', 2, 'orange'],
  [/^tsunami information( statement)?$/, 'kind.noaaInfo', 0, 'info'],
]

// NOAA tsunami.gov 的 CAP 1.2 电文 → Alert。结构：alert > info > area > circle（"纬度,经度 半径"），
// 震级与震中另有 parameter 备份；msgType=Cancel 是解除，走与日本源相同的取消 / 解除链路。
// xml 是 CAP 原文；entry 是事件列表里的条目（用于给 Alert 一个稳定 id）。
function parseNoaaCap(xml, entry) {
  const text = String(xml || '')
  if (text.indexOf('<alert') === -1) return null
  const identifier = tagText(text, 'identifier')
  if (!identifier) return null
  const msgType = tagText(text, 'msgType')
  const event = tagText(text, 'event')
  const sent = tagText(text, 'sent')
  const capHeadline = tagText(text, 'headline')
  const areaDesc = tagText(text, 'areaDesc')
  // parameter 是成对出现的 valueName / value，可能有多个，逐个收进字典
  const params = {}
  for (const m of text.matchAll(/<parameter>([\s\S]*?)<\/parameter>/g)) {
    const n = tagText(m[1], 'valueName')
    if (n) params[n] = tagText(m[1], 'value')
  }
  // 震中优先取 area 的 circle（"纬,经 半径"），它才是配信覆盖范围，EventLatLon 只是备份。CAP 允许一个
  // info 下**多个 <area>**，各有自己的 circle——全部收集：只看第一个会让其余海域的沿海用户漏报。
  const geoList = []
  for (const m of text.matchAll(/<circle>([\s\S]*?)<\/circle>/g)) {
    const cm = /^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)/.exec(m[1])
    if (cm) geoList.push({ lat: Number(cm[1]), lon: Number(cm[2]) })
  }
  if (geoList.length === 0) {
    const em = /^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)/.exec(String(params.EventLatLon || ''))
    if (em) geoList.push({ lat: Number(em[1]), lon: Number(em[2]) })
  }
  const geo = geoList.length ? geoList[0] : { lat: null, lon: null }
  const mag = toNumOrNull(params.EventPreliminaryMagnitude)
  // 认不出时**如实标注**而不是冒充"海啸信息"：等级仍是 0（不会响铃），但历史里能看出上游加了新 event 名。
  const eventNorm = String(event || '').trim().toLowerCase().replace(/\s+/g, ' ')
  const matched = NOAA_EVENT_RULES.find(([re]) => re.test(eventNorm))
  // 匹配到时 rule[1] 是**文案 key**（要取词）；没匹配到时已经是取好词的句子，t() 对不存在的 key 原样回显，
  // 所以下面统一过一遍 t() 是安全的。
  const rule = matched || [null, t('kind.noaaUnrecognized', { event: String(event || '—').slice(0, 40) }), 0, 'info']
  const ruleLabel = t(rule[1])
  const cancelled = msgType === 'Cancel'
  const origin = String(params.EventOriginTime || sent || '')
  const eventName = String(params.EventLocationName || areaDesc || '').trim()
  const headline = (capHeadline || event || t('kind.noaaInfo')) + (eventName ? ' · ' + eventName : '') +
    (mag === null ? '' : t('kind.noaaForeshock', { mag: mag }))
  // identifier 形如 PHEB-1-26234000，中间的数字是消息版本号——同一事件的多版要归并成一个键
  const eventKey = 'noaa:' + identifier.replace(/-\d+-/, '-')
  return {
    id: 'noaa:' + (identifier || (entry && entry.id) || eventKey),
    code: 'noaa',
    kind: 'tsunami',
    kindLabel: cancelled ? ruleLabel + t('kind.cancelledSuffix') : ruleLabel,
    source: 'noaa',
    locator: 'point',
    severity: cancelled ? 'info' : rule[3],
    issued: sent || origin,
    headline,
    maxScale: rule[2],
    // 与日本 552 的等级共用同一把尺，供 matchPointAlert 做 tsunamiGrade 门槛
    tsunamiRank: rule[2],
    level: 0,
    geo,
    // 多区域电文的全部圆心（matchPointAlert 对任一点命中即算命中）；geo 保留第一个以兼容旧调用方
    geoList,
    magnitude: mag,
    magType: String(params.EventPreliminaryMagnitudeType || ''),
    hypo: { name: eventName, magnitude: mag },
    regions: [],
    eventKey,
    strength: rule[2],
    cancelled,
    raw: { identifier, msgType, event, sent, areaDesc, params },
  }
}


// 测试场景。全球源的地震不是随时都有，用户没法"等一条"来验证链路——与气象按钮同样的做法：**构造源格式的
// 原文**（EMSC 的 WebSocket 帧、USGS 的 GeoJSON feature、NOAA 的 CAP 电文）再交给真正的解析器与匹配引擎，
// 点一次就验证「解析器 → 坐标匹配 → 通知 → 历史」整条链路，且不发任何网络请求。
export const TEST_GEO_SCENARIOS = [
  { key: 'emsc', source: 'emsc' },
  { key: 'usgs', source: 'usgs' },
  { key: 'noaa', source: 'noaa' },
  // 半径是可配的（1–2000km，新建默认 100km），所以这里**不能承诺"一定不命中"**：半径 ≥556km 的用户会真的响铃。
  { key: 'emsc-far', source: 'emsc' },
]

// 纬度偏移 1 度约 111km；夹在 ±89.5 以内，避免极端位置把纬度推到界外
const shiftLat = (lat, deg) => Math.max(-89.5, Math.min(89.5, lat + deg))

function capTestXml(identifier, event, headline, name, lat, lon, mag, stamp) {
  return '<?xml version="1.0" encoding="UTF-8"?>' +
    '<alert xmlns="urn:oasis:names:tc:emergency:cap:1.2">' +
    '<identifier>' + identifier + '</identifier><sender>quakealert-test</sender>' +
    '<sent>' + stamp + '</sent><status>Actual</status><msgType>Alert</msgType>' +
    '<info><category>Geo</category><event>' + event + '</event>' +
    '<severity>Moderate</severity><urgency>Expected</urgency><certainty>Likely</certainty>' +
    '<headline>' + headline + '</headline>' +
    '<parameter><valueName>EventLocationName</valueName><value>' + name + '</value></parameter>' +
    '<parameter><valueName>EventPreliminaryMagnitude</valueName><value>' + mag + '</value></parameter>' +
    '<area><areaDesc>' + name + '</areaDesc><circle>' + lat + ',' + lon + ' 0.0</circle></area>' +
    '</info></alert>'
}

// 按场景构造一条**测试用**的源原文。
// @param place 用户的第一个全球关注点 { name?, lat, lon }；@param nowMs 时间戳（id 里带上它，连点两次不会被
// 消息级去重吞掉）；@param key TEST_GEO_SCENARIOS 里的 key。返回 { source, payload, label, note }。
export function buildTestGlobalMessage(place, nowMs, key) {
  const ms = nowMs || Date.now()
  const p = place || {}
  const lat = (typeof p.lat === 'number' && Number.isFinite(p.lat)) ? p.lat : 0
  const lon = (typeof p.lon === 'number' && Number.isFinite(p.lon)) ? p.lon : 0
  const name = String(p.name || 'watch point')
  const stamp = new Date(ms).toISOString()
  const scenario = TEST_GEO_SCENARIOS.filter((s) => s.key === key)[0] || TEST_GEO_SCENARIOS[0]

  if (scenario.key === 'usgs') {
    const shifted = shiftLat(lat, 0.7) // 约 78km
    return {
      source: 'usgs',
      payload: {
        type: 'FeatureCollection',
        features: [{
          type: 'Feature',
          id: 'QUAKEALERT-TEST-usgs-' + ms,
          geometry: { type: 'Point', coordinates: [lon, shifted, 25] },
          properties: {
            mag: 5.6, place: name + ' region (test)', time: ms, updated: ms,
            magType: 'mww', tsunami: 0, alert: null, title: 'M 5.6 - QuakeAlert test',
          },
        }],
      },
    }
  }
  if (scenario.key === 'noaa') {
    return {
      source: 'noaa',
      payload: capTestXml('QUAKEALERT-TEST-NOAA-' + ms, 'Tsunami Advisory', 'TEST TSUNAMI ADVISORY',
        name, lat, lon, 7.1, stamp),
    }
  }
  const far = scenario.key === 'emsc-far'
  const shifted = far ? shiftLat(lat, 5) : lat // 5 度约 555km
  const mag = far ? 7.0 : 6.2
  return {
    source: 'emsc',
    payload: {
      action: 'update',
      data: {
        type: 'Feature',
        id: 'QUAKEALERT-TEST-' + scenario.key + '-' + ms,
        geometry: { type: 'Point', coordinates: [lon, shifted, 10] },
        properties: {
          source_id: 'test', unid: 'QUAKEALERT-TEST-' + scenario.key + '-' + ms,
          source_catalog: 'QuakeAlert-TEST', auth: 'QuakeAlert',
          time: stamp, lastupdate: stamp,
          flynn_region: name + ' region (test)',
          lat: shifted, lon, depth: 10,
          mag, magtype: 'mw', evtype: 'ke',
        },
      },
    },
  }
}

/** 测试消息 → Alert：按 source 走对应的真实解析器（与线上链路完全同一条代码路径）。 */
export function parseTestGlobalMessage(msg) {
  if (!msg) return null
  let alert = null
  if (msg.source === 'usgs') {
    const json = typeof msg.payload === 'string' ? JSON.parse(msg.payload) : msg.payload
    const feats = (json && json.features) || []
    alert = feats.length ? parseUsgsFeature(feats[0]) : null
  } else if (msg.source === 'noaa') {
    alert = parseNoaaCap(String(msg.payload), { id: 'test-noaa' })
  } else {
    alert = parseEmsc(msg.payload)
  }
  if (!alert) return null
  // 测试消息的事件键必须每次不同，否则第二次点击会被判成"同一场地震的重复发布"而静默（用户会以为按钮坏了）。
  // 生产的事件键按「分钟 + 震中」归并，连点两次必然落在同一分钟；这里换成带毫秒的 id。
  alert.eventKey = 'test:' + alert.id
  return alert
}


export { parseEmsc, parseUsgsFeature, parseNoaaCap, severityOfMagnitude, geoEventKey, toIso }
