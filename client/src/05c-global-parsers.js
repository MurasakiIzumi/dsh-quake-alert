// ============================================================================
// dsh-quake-alert · client/src/05c-global-parsers.js
//
// 作用：把三个全球源的消息解析成与日本源同一套内部模型（Alert）。
// 内容：EMSC standing_order WebSocket（GeoJSON Feature）、USGS summary feed
//       （FeatureCollection）、NOAA tsunami.gov 的 CAP 1.2 电文。
// 依赖：02-storage（isPlainObject）。
//
// 与日本源的差别，也是本文件引入的新字段：
//   · 全球源只给「震中坐标 + 震级」，没有都道府县 / 市町村 → `locator: 'point'`、
//     `regions` 恒为空数组，匹配交给 06-matcher 的 matchPointAlert 用 Haversine 距离完成。
//   · 震级（M）与日本的震度是两套不可换算的体系，所以阈值也是独立旋钮
//     （thresholds.globalMagnitude），而不是复用 quakeScale。
//
// 字段差异全部来自实测样本（见 samples/global/），踩过的坑写在各自函数上方：
//   · EMSC：顶层 { action, data }，data 是 GeoJSON **Feature**（不是 FeatureCollection）；
//     区域字段叫 flynn_region（没有 region）；time 是 ISO8601 字符串；lat/lon 在 properties 里。
//   · USGS：FeatureCollection；geometry.coordinates = [lon, lat, depthKm]；time/updated 是 epoch 毫秒。
//   · NOAA CAP：alert > info > area > circle "lat,lon 半径"；震级与位置同时也在 info 的
//     parameter 里（EventPreliminaryMagnitude / EventLatLon）。
// ============================================================================

import { isPlainObject } from './02-storage.js'

/** 取第一个可用数值（全球源的坐标/震级可能同时存在于两三个地方，按优先级回退）。
 *  经 toNumOrNull 归一，所以**数字字符串也算**：源侧类型并不稳定（CAP 的 parameter 里全是字符串，
 * 而 EMSC/USGS 某次改版也可能把 mag 序列化成 "5.6"）。只认 typeof number 的话，
 * `magnitude` 会变成 null → 震级闸门被整个跳过 → 低于阈值的地震照常响铃（误报）。 */
function firstNumber(...vals) {
  for (const v of vals) {
    const n = toNumOrNull(v)
    if (n !== null) return n
  }
  return null
}
/** 字符串（CAP 的 parameter 里全是字符串）→ 数值；空串与垃圾值一律给 null。
 *  注意不能用 Number('')——它等于 0，会把"没有震级"变成"震级 0"。 */
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

/**
 * 震级 → severity。日本源按震度分级（10..70），全球源只有震级，所以这里单独一套边界。
 * 取值依据：M7 以上是「需要跨区域响应」的大地震，M6 以上可能造成局部破坏，
 * M5 以上普遍有感——与 EMSC/USGS 的公众提示口径一致。
 */
function severityOfMagnitude(mag) {
  if (typeof mag !== 'number' || !Number.isFinite(mag)) return 'info'
  if (mag >= 7) return 'red'
  if (mag >= 6) return 'orange'
  if (mag >= 5) return 'yellow'
  return 'info'
}

/**
 * 事件键里的「发震时刻（分钟）」必须先**归一到 UTC**再取分钟。
 *
 * 各源给的 ISO 字符串偏移不同：EMSC 是 `…Z`、USGS 经 toIso 也是 `…Z`，而 0.5.0 新接的大陆源是
 * `+08:00`。直接切字符串前 16 位的话，同一场地震在两边会落进**相隔 8 小时**的两个桶里——
 * 键永远不相等，跨源归并彻底失效，同一场地震响两次（实测样本里 cenc_eqlist 含境外地震，
 * 福克斯群岛 M6.5 这类事件 USGS / EMSC 也会推，所以这条路径是走得到的，不是理论问题）。
 *
 * 无法解析时退回原串切片：宁可归并失败多响一次，也不能为了一致性把消息丢掉。
 */
function minuteKeyOf(timeIso) {
  const s = String(timeIso === undefined || timeIso === null ? '' : timeIso)
  const t = Date.parse(s)
  if (!Number.isFinite(t)) return s.slice(0, 16)
  return new Date(t).toISOString().slice(0, 16)
}

/**
 * 跨源事件键：同一场地震 EMSC 与 USGS 都会推，两边机构、编号、震级都可能不同，
 * 但「发震时刻（分钟）+ 震中（0.1 度 ≈ 11km）」是一致的。用它把两个全球源的同一次地震
 * 归并成一个事件，避免同一场地震因为接了第二个源而响两次。
 * 代价：跨分钟边界（两边测定的发震时刻差过一分钟）时归并会失败——宁可多响一次，不漏报。
 * 0.5.0 起大陆源（cenc_eew / cenc_eqlist）也走同一把钥匙：它们的 **EventID 与 EEW 完全不同格式**
 * （`202609182050.0001` vs `CD.20260918205536.056`），归并只能靠时间 + 震中。
 */
/**
 * 0.1° 桶的字符串化。**必须把 "-0.0" 归一成 "0.0"**：`(-0.02).toFixed(1)` 得到 "-0.0"，
 * 而 `(0.02).toFixed(1)` 得到 "0.0" —— 赤道与本初子午线两侧的震中会落进两个不同的桶，
 * 事件键永远不相等 → 跨源归并失败、同一场地震响两次。近似归并（±2 分钟 + 50km）通常还能
 * 兜住，所以它表现为概率性重复而不是稳定故障（0.5.1 修）。
 */
function oneDp(n) {
  if (typeof n !== 'number' || !Number.isFinite(n)) return '?'
  const s = n.toFixed(1)
  return s === '-0.0' ? '0.0' : s
}

function geoEventKey(timeIso, lat, lon) {
  const min = minuteKeyOf(timeIso)
  return 'geo:' + min + '@' + oneDp(lat) + ',' + oneDp(lon)
}

/** epoch 毫秒或 ISO 字符串 → ISO 字符串（USGS 给毫秒，EMSC 给字符串，统一到后者）。 */
function toIso(v) {
  if (typeof v === 'number' && Number.isFinite(v)) {
    const d = new Date(v)
    return Number.isFinite(d.getTime()) ? d.toISOString() : ''
  }
  return typeof v === 'string' ? v : ''
}

/**
 * EMSC standing_order WebSocket 消息 → Alert。
 * 消息形如 { action: 'create'|'update'|'delete', data: Feature }；非地震事件（爆炸等）由
 * properties.evtype 区分，实测 'ke' = known earthquake。
 */
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
    (depth === null ? '' : ' · 深 ' + Math.round(depth) + 'km')
  return {
    id: 'emsc:' + (unid || (lat + ',' + lon + ',' + time)),
    code: 'emsc',
    kind: 'quake',
    kindLabel: '全球地震（EMSC）',
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
  const depth = firstNumber(coords[2], null)
  const mag = firstNumber(p.mag, null)
  const place = String(p.place || '').trim()
  const time = toIso(p.time)
  const headline = 'M' + (mag === null ? '—' : mag) + (place ? ' · ' + place : '') +
    (depth === null ? '' : ' · 深 ' + Math.round(depth) + 'km')
  return {
    id: 'usgs:' + String(f.id || p.code || (lat + ',' + lon + ',' + time)),
    code: 'usgs',
    kind: 'quake',
    kindLabel: '全球地震（USGS）',
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
    // USGS 的 alert 字段（green/yellow/orange/red）是 PAGER 的损失评估，11 条实测里全是 null；
    // 这里不做映射，severity 统一按震级判定，避免"两个源对同一地震给出不同颜色"。
    hypo: { name: place, magnitude: mag },
    regions: [],
    eventKey: geoEventKey(time, lat, lon),
    strength: mag === null ? 0 : mag,
    cancelled: false,
    raw: f,
  }
}

/** USGS summary feed（FeatureCollection）→ Alert[]。 */
function parseUsgsFeed(json) {
  const feats = (isPlainObject(json) && Array.isArray(json.features)) ? json.features : []
  return feats.map(parseUsgsFeature).filter(Boolean)
}

// NOAA tsunami.gov 的事件分级。CAP 的 <severity>（Minor/Moderate/…）对海啸不够具体，
// 真正决定行动的是 <event> 名称，实测样本是 "Tsunami Information"（Minor）。
// 第三项是**等级**，与日本 552 的 TSUNAMI_RANK（Watch=1/Warning=2/MajorWarning=3）同一把尺，
// 由 matchPointAlert 用 thresholds.tsunamiGrade 做闸门。
// 「Tsunami Information」= 0：它在语义上低于日本的「津波注意報」，是"没有破坏性海啸"的信息类
// 电文——按 1 处理会让它在半径内直接响铃（全球海啸无法用等级收敛）。
const NOAA_EVENT_RULES = [
  [/Tsunami Warning/i, '大海啸警报（NOAA）', 3, 'red'],
  [/Tsunami Advisory/i, '海啸注意报（NOAA）', 2, 'orange'],
  [/Tsunami Watch/i, '海啸注意报（NOAA）', 2, 'orange'],
  [/Tsunami Information/i, '海啸信息（NOAA）', 0, 'info'],
]

/**
 * NOAA tsunami.gov 的 CAP 1.2 电文 → Alert。
 * 结构：alert > info > area > circle（"纬度,经度 半径"），震级与震中另有 parameter 备份。
 * msgType=Cancel 表示解除——走与日本源相同的取消 / 解除链路。
 * @param {string} xml CAP 原文
 * @param {{ id?: string }} [entry] 事件列表里的条目（用于给 Alert 一个稳定 id）
 */
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
  // 震中优先取 area 的 circle（"纬,经 半径"），它才是配信覆盖范围；EventLatLon 只是备份。
  // CAP 允许一个 info 下**多个 <area>**，各有自己的 circle——全部收集。
  // 只看第一个 circle 会让其余海域的沿海用户漏报，而多区域海啸恰恰是最常见的形态。
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
  const rule = NOAA_EVENT_RULES.find(([re]) => re.test(event)) ||
    [/./, '海啸信息（NOAA）', 0, 'info']
  const cancelled = msgType === 'Cancel'
  const origin = String(params.EventOriginTime || sent || '')
  const eventName = String(params.EventLocationName || areaDesc || '').trim()
  const headline = (capHeadline || event || 'NOAA 海啸信息') + (eventName ? ' · ' + eventName : '') +
    (mag === null ? '' : ' · 前震 M' + mag)
  // identifier 形如 PHEB-1-26234000，中间的数字是消息版本号——同一事件的多版要归并成一个键
  const eventKey = 'noaa:' + identifier.replace(/-\d+-/, '-')
  return {
    id: 'noaa:' + (identifier || (entry && entry.id) || eventKey),
    code: 'noaa',
    kind: 'tsunami',
    kindLabel: cancelled ? rule[1] + '（已解除）' : rule[1],
    source: 'noaa',
    locator: 'point',
    severity: cancelled ? 'info' : rule[3],
    issued: sent || origin,
    headline,
    maxScale: rule[2],
    // 与日本 552 的等级共用同一把尺，供 matchPointAlert 做 tsunamiGrade 闸门
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


/**
 * 测试场景（0.4.0）。全球源的地震不是随时都有，用户没法"等一条"来验证链路——
 * 日本气象链路早有「发送测试气象警报」按钮，这里补上对应的东西。
 *
 * 与气象按钮同样的做法：**构造源格式的原文**（EMSC 的 WebSocket 帧、USGS 的 GeoJSON feature、
 * NOAA 的 CAP 电文），再交给真正的解析器与匹配引擎。因此点一次就同时验证了
 * 「解析器 → 坐标匹配 → 通知 → 历史」整条链路，而且不发任何网络请求。
 *
 * 四个场景覆盖两个维度：三个源各自的解析路径，以及"半径内命中 / 半径外不命中"。
 */
export const TEST_GEO_SCENARIOS = [
  { key: 'emsc', label: 'EMSC 地震（震中就在关注点）', note: 'M6.2', source: 'emsc' },
  { key: 'usgs', label: 'USGS 地震（约 80km 外）', note: 'M5.6 · 仍在默认半径内', source: 'usgs' },
  { key: 'noaa', label: 'NOAA 海啸注意报', note: 'Tsunami Advisory', source: 'noaa' },
  { key: 'emsc-far', label: 'EMSC 远地地震（约 550km 外）', note: 'M7.0 · 超出默认 300km 半径，刻意不命中', source: 'emsc' },
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

/**
 * 按场景构造一条**测试用**的源原文。
 * @param {{name?: string, lat: number, lon: number}} place 用户的第一个全球关注点
 * @param {number} nowMs 时间戳（id 里带上它，连点两次不会被消息级去重吞掉）
 * @param {string} key TEST_GEO_SCENARIOS 里的 key
 * @returns {{ source: string, payload: object|string, label: string, note: string }}
 */
export function buildTestGlobalMessage(place, nowMs, key) {
  const ms = nowMs || Date.now()
  const p = place || {}
  const lat = (typeof p.lat === 'number' && Number.isFinite(p.lat)) ? p.lat : 0
  const lon = (typeof p.lon === 'number' && Number.isFinite(p.lon)) ? p.lon : 0
  const name = String(p.name || '关注点')
  const stamp = new Date(ms).toISOString()
  const scenario = TEST_GEO_SCENARIOS.filter((s) => s.key === key)[0] || TEST_GEO_SCENARIOS[0]

  if (scenario.key === 'usgs') {
    const shifted = shiftLat(lat, 0.7) // 约 78km
    return {
      source: 'usgs',
      label: scenario.label,
      note: scenario.note,
      payload: {
        type: 'FeatureCollection',
        features: [{
          type: 'Feature',
          id: 'QUAKEALERT-TEST-usgs-' + ms,
          geometry: { type: 'Point', coordinates: [lon, shifted, 25] },
          properties: {
            mag: 5.6, place: name + ' 附近（测试）', time: ms, updated: ms,
            magType: 'mww', tsunami: 0, alert: null, title: 'M 5.6 - QuakeAlert test',
          },
        }],
      },
    }
  }
  if (scenario.key === 'noaa') {
    return {
      source: 'noaa',
      label: scenario.label,
      note: scenario.note,
      payload: capTestXml('QUAKEALERT-TEST-NOAA-' + ms, 'Tsunami Advisory', 'TEST TSUNAMI ADVISORY',
        name, lat, lon, 7.1, stamp),
    }
  }
  const far = scenario.key === 'emsc-far'
  const shifted = far ? shiftLat(lat, 5) : lat // 5 度约 555km
  const mag = far ? 7.0 : 6.2
  return {
    source: 'emsc',
    label: scenario.label,
    note: scenario.note,
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
          flynn_region: name + ' 附近（测试）',
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
  // 测试消息的事件键必须每次不同，否则第二次点击会被判成"同一场地震的重复发布"而静默——
  // 用户会以为按钮坏了。生产的事件键按「分钟 + 震中」归并（那是为了让同一场地震只响一次），
  // 连点两次必然落在同一分钟；这里换成带毫秒的 id，语义也成立：每次点击本来就是一次独立演示。
  alert.eventKey = 'test:' + alert.id
  return alert
}


export { parseEmsc, parseUsgsFeature, parseUsgsFeed, parseNoaaCap, severityOfMagnitude, geoEventKey, toIso }
