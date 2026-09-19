// ============================================================================
// dsh-quake-alert · client/src/05d-source-contracts.js
//
// 作用：**解析契约**与**每源校验约定**（0.4.1 的交付物之一，对应 DESIGN 4.5 与 11.1）。
// 内容：① 统一的解析返回形态 { ok, alert } | { ok:false, kind:'empty'|'schema'|'value', detail }
//       ② 五个源各自填写的内容：必需字段清单与类型（schema 判据）、源时区、
//          新鲜度阈值（stale 判据）、empty 判据
//       ③ 与契约配套的健康状态记录（schema-error 的进入 / 恢复 / 手动重试）
// 依赖：01-constants、02-storage、05/05b/05c（各源的解析器）、07-store（状态上报）。
//
// 三层划分（DESIGN 11.1）：本文件是**约定层**——解析失败的返回形态与"UI 如何表示数据格式异常"，
// 随源走，所以在 0.4.1 一次补齐已有 5 源；**机制层**（健康数据结构、探针调度、CI 契约测试）
// 集中在 0.5.3，届时本文件的判定函数就是它的输入。
//
// 三类失败的语义与处置（DESIGN 4.5）：
//   empty  —— 源正常，当前没有与本插件相关的数据。**不计失败**、不显示异常。
//   schema —— 结构不符（字段缺失 / 类型错误 / 顶层不是预期结构）。计入健康状态、停止播报该源。
//   value  —— 结构正确但值客观不可能（坐标越界、时间在 100 年后等）。同上，但只查硬边界。
// 核心原则：解析层严格，匹配层宽松。结构不符时任何"智能猜测"都可能把垃圾数据变成误报。
// ============================================================================

import { isPlainObject } from './02-storage.js'
import { cnTimeToIso } from './01-constants.js'
import { parse } from './05-parser.js'
import { parseJma } from './05b-jma-parser.js'
import { parseEmsc, parseUsgsFeature, parseNoaaCap } from './05c-global-parsers.js'
import { parseCencEew, parseCencEqlistItem, cencEqlistItems, cencEqlistMd5Of } from './05e-cn-parsers.js'
import { store } from './07-store.js'

// ---------------------------------------------------------------- 返回形态
/** 解析成功。 */
export const okResult = (alert) => ({ ok: true, alert })
/** 解析失败 / 无关。kind ∈ 'empty' | 'schema' | 'value'。 */
export const failResult = (kind, detail) => ({ ok: false, kind, detail: String(detail || '') })

const numOf = (v) => {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null
  const s = String(v === undefined || v === null ? '' : v).trim()
  if (!s) return null
  const n = Number(s)
  return Number.isFinite(n) ? n : null
}
const timeMsOf = (v) => {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null
  const t = Date.parse(String(v === undefined || v === null ? '' : v))
  return Number.isFinite(t) ? t : null
}
/** 时间戳是否客观不可能：1970 年以前、或 100 年以后（DESIGN 4.5 的 value 判据）。
 *  **缺失 / 不可解析不算"不可能"**——存在性由各源的 schema 判据负责。传 null 时若返回 true，
 *  会让"没给时间"的地震情报整条被丢掉（parseQuake 本来容忍缺 time，只让 eventKey 留空）。 */
const timeIsImpossible = (ms, now) => {
  if (typeof ms !== 'number' || !Number.isFinite(ms)) return false
  return ms < 0 || ms > (now || Date.now()) + 100 * 365 * 24 * 3600 * 1000
}

// ---------------------------------------------------------------- 每源约定
/**
 * 五个源的校验约定（0.4.1 补齐）。字段含义：
 *   required    —— 必需字段与类型（schema 判据）。缺一个即判 schema，**不猜、不兜底**。
 *   timezone    —— 源时区。契约要求解析器把时间转成**带偏移**的 ISO 8601（DESIGN 第 4 节）。
 *   staleAfterMs—— 新鲜度阈值（stale 判据）；null = 这条链路不适用，理由写在 staleReason。
 *   empty       —— 什么形态算"源正常但当前无数据"（不计失败）。
 *   tolerant    —— 可选：**明确不判 schema** 的字段范围。它与 required 是一对——required 只该列
 *                  实现里真的会拦下的字段，否则契约就变成"比实现严"的文档，后来者按它写测试会
 *                  误判"某字段必需"（0.5.1 修正）。
 *   pollMs      —— 传输层的轮询 / 推送周期（诊断文档引用）。
 */
export const SOURCE_CONTRACTS = {
  p2pquake: {
    label: 'P2PQuake',
    region: 'jp',
    disasters: ['quake', 'eew', 'tsunami'],
    transport: 'ws',
    url: 'wss://api.p2pquake.net/v2/ws',
    pollMs: null,
    timezone: 'Asia/Tokyo（+09:00）—— issue.time / earthquake.time / areas[].arrivalTime 都是裸 JST，由 p2pTimeToIso 补偏移',
    required: [
      'code：必须是 551 / 552 / 556 之一',
      '551：id（或 _id）string、issue.time string、earthquake.time string、earthquake.maxScale number、points[]（每项 pref string / addr string / scale number）',
      '552：id string、areas[]（每项 name string、grade ∈ {MajorWarning, Warning, Watch}）',
      '556：id string、issue.eventId string、earthquake.hypocenter object、areas[]（每项 name string、scaleTo number）',
    ],
    empty: 'code 不是 551/552/556（P2PQuake 还会推火山、其他情报等与本插件无关的消息）',
    staleAfterMs: null,
    staleReason: '推送源没有"数据新鲜度"概念：日本可能数小时没有有感地震。活性由连接层负责' +
      '（建连看门狗 15 秒 + 半开检测 20 分钟，见 12-websocket）。',
  },
  jma: {
    label: '気象庁 防災情報XML',
    region: 'jp',
    disasters: ['weather'],
    transport: 'feed',
    url: 'https://www.data.jma.go.jp/developer/xml/feed/extra.xml',
    pollMs: 60 * 1000,
    timezone: 'Asia/Tokyo（+09:00）—— Head/ReportDateTime 带 +09:00；Control/DateTime 是 UTC（Z）。' +
      '两者都带偏移，解析器优先取 ReportDateTime',
    required: [
      '<Report> 根元素',
      'Control/Title 或 Head/Title（至少一个非空）',
      'Head/ReportDateTime 或 Control/DateTime（发布时间）',
      '至少一个 <Item>，其 <Kind> 能给出 Name 或 Status',
      '区域：<Area> 下的 <Name> 或 <Code>（codeType 或码位数决定粒度）',
    ],
    empty: '警戒レベル 0 且不是解除的电文：天气预报、府県気象情報、火山、观测资料，以及"只有注意報 /' +
      ' なし"的警报电文（L1〜L2 按设计既不播报也不进历史，所以归入 empty 而不是失败）',
    staleAfterMs: 3 * 60 * 60 * 1000,
    staleReason: 'feed 每分钟更新（掲載直近の入電）。但"我们没有相关电文"是常态（只有天气预报时也正常），' +
      '所以阈值不查"我们收到多少条"，只查 feed 自身的最新 <updated>：超过 3 小时说明上游停更。',
  },
  emsc: {
    label: 'EMSC',
    region: 'global',
    disasters: ['quake'],
    transport: 'ws',
    url: 'wss://www.seismicportal.eu/standing_order/websocket',
    pollMs: null,
    timezone: 'UTC（properties.time 形如 2026-09-12T02:15:12.43Z，自带偏移，无需转换）',
    required: [
      '顶层 { action, data }（data 是 GeoJSON Feature，不是 FeatureCollection）',
      'data.properties object：mag number、time string、flynn_region string',
      'data.properties.lat/lon number，或 data.geometry.coordinates[0..1]',
    ],
    empty: 'action === "delete"（事件被撤回），或 properties.evtype 不是 "ke"（非地震事件，如爆炸）',
    staleAfterMs: null,
    staleReason: '全球 M4+ 平均约 30 分钟一条，稀疏是常态，不能用消息间隔判死。活性由连接层负责' +
      '（建连看门狗 15 秒 + 3 小时无消息的半开检测，见 15-entry 的 staleAfterMs）。',
  },
  usgs: {
    label: 'USGS',
    region: 'global',
    disasters: ['quake'],
    transport: 'feed',
    url: 'https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/2.5_day.geojson',
    pollMs: 120 * 1000,
    timezone: 'UTC（properties.time/updated 是 epoch 毫秒，经 toIso 转成带 Z 的 ISO）',
    required: [
      '顶层 GeoJSON：features[] 数组',
      '每个 feature：id string、geometry.coordinates = [经度, 纬度, 深度km]',
      'properties object：mag number、time number、updated number',
      '顶层 metadata.generated number（feed 生成时刻，用于 stale 判定）',
    ],
    empty: 'features 为空数组（该窗口内没有 M2.5+ 事件，罕见但正常）',
    staleAfterMs: 30 * 60 * 1000,
    staleReason: 'USGS 摘要 feed 每 5 分钟重新生成，metadata.generated 是它的生成时刻；' +
      '超过 30 分钟说明上游停更或我们拿到的是缓存。',
  },
  noaa: {
    label: 'NOAA tsunami.gov',
    region: 'global',
    disasters: ['tsunami'],
    transport: 'feed',
    url: 'https://www.tsunami.gov/events/xml/PHEBAtom.xml',
    pollMs: 5 * 60 * 1000,
    timezone: 'UTC（CAP <sent> 形如 2026-08-22T08:30:40-00:00，自带偏移）',
    required: [
      '事件列表：<entry> + <link rel="related" title="CapXML document" href>',
      'CAP 电文：<alert> 根、<identifier>、<info>（event / sent）',
      '区域：<area><circle> 或 info/parameter 里的 EventLatLon',
    ],
    empty: 'msgType === "Test"（演练电文）；或事件列表为空（大多数时候没有海啸）',
    staleAfterMs: null,
    staleReason: '事件列表只在有海啸时才有内容，"列表为空"是绝大多数时间的正常形态，不能据此判 stale。',
  },
  // ---- 中国大陆源（0.5.0）----
  // 与其它源的两处结构性差异，写在契约里而不是埋在解析器里：
  //   ① 传输是 **Host 单点常连**（Wolfx 限 5–7 连接/IP），不是 Client 直连——见 DESIGN 5.3。
  //   ② cenc_eqlist 的字段**全是字符串**，而 cenc_eew 的字段是 number；两个源来自同一上游，
  //      所以不能按"同一家的风格"写解析，只能按实测样本写。
  cenc_eew: {
    label: 'Wolfx CENC 地震预警',
    region: 'cn',
    disasters: ['eew'],
    transport: 'ws',
    url: 'wss://ws-api.wolfx.jp/cenc_eew（REST 快照 https://api.wolfx.jp/cenc_eew.json）',
    pollMs: null,
    timezone: 'Asia/Shanghai（+08:00，无夏令时）—— OriginTime / ReportTime 是裸北京时间，由 cnTimeToIso 补偏移',
    required: [
      '接收两种形态：WS 推送包（含 type:"cenc_eew"）与 REST 快照（无 type）',
      'ID string 非空（消息唯一键，Alert 的 id 取 cenc: 前缀）',
      'Latitude / Longitude 为数值，且落在合法范围内',
      'Magnitude 为数值（缺它这条预警就没有阈值可判 → 判 schema）',
      'OriginTime 为可解析的北京时间串，且不是客观不可能的时刻',
    ],
    tolerant: 'Depth / ReportNum / MaxIntensity / HypoCenter / ReportTime 缺失或类型不对**不判 schema**' +
      '——沿用 0.4.2 对 551 观测点定的同一口径（"存在则类型必须正确"，缺失容忍）：' +
      '整条丢弃在预警产品里的代价是漏报。取不到值时解析器给 null / 空串，文案退化成 M— / 无地名。' +
      '（0.5.1 修正：此前 required 把这几项也写成必需，与实现的校验范围不符。）',
    empty: '10 个字段一个都没有（只有 type 包裹或空对象）——源正常但当前没有预警。' +
      '**这条未实测**：Wolfx 总是回最后一条预警（哪怕已过数天），从未见过"无预警"的返回形态，' +
      '样本不足以确认。保守取此判据，是因为判反了会点亮一个用户根本处理不了的蓝点（DESIGN 4.5 的配色语义）。',
    staleAfterMs: null,
    staleReason: '预警稀疏（实测门槛约 M4.0，数天一次），"很久没消息"是常态，不能据此判死。' +
      '活性由连接层负责（心跳实测精确 60 秒、200 秒内无服务端强断，超 120 秒无消息即重连）。' +
      '中继是否存活由 cenc_eqlist 探（它每天都有数据）——这也是两个源都要接的原因之一。',
  },
  cenc_eqlist: {
    label: 'Wolfx CENC 地震速报',
    region: 'cn',
    disasters: ['quake'],
    transport: 'ws',
    url: 'wss://ws-api.wolfx.jp/cenc_eqlist（REST 快照 https://api.wolfx.jp/cenc_eqlist.json）',
    pollMs: null,
    timezone: 'Asia/Shanghai（+08:00，无夏令时）—— time / ReportTime 是裸北京时间，由 cnTimeToIso 补偏移',
    required: [
      '整表载荷：No1…NoN（数值序，No1 最新）+ md5',
      '每项：EventID string 非空',
      '每项：latitude / longitude 为数字字符串或数值，且落在合法范围内',
      '每项：magnitude 为数字字符串或数值（缺它这条速报就没有阈值可判）',
      '每项：time 为可解析的北京时间串，且不是客观不可能的时刻',
    ],
    tolerant: 'placeName / location / depth / intensity / ReportTime / type 缺失或类型不对**不判 schema**' +
      '（同上：保留一条真实地震比丢弃它重要）。地名取 placeName 优先、location 兜底，都没有则留空。' +
      '注意本判据是**逐项**的——线上由 Host 把整表拆成逐条 entry，整表级的"全坏"由 Host 侧判（见 wolfx-source）。',
    empty: '整表里一个 NoN 都没有——源正常但当前没有速报数据',
    staleAfterMs: 48 * 60 * 60 * 1000,
    staleReason: '**本插件唯一真正有意义的新鲜度阈值，而且它探的是中继不是灾害**：速报每天都有数据，' +
      '所以"超过 48 小时没有新批次"即判中继异常（fj_eew 那种连接正常但停更 4 个月的形态，' +
      '靠连接检测完全发现不了）。实测发布 lag 209–1643 秒，阈值不能贴着 lag 取留出余量。',
  },
}

// ---------------------------------------------------------------- Result 包装
// 每个包装函数先把"结构不符 / 值不可能"挡在解析器之前，再调用**真实解析器**（单一实现，
// 不复制业务逻辑）。这样既得到契约要求的失败分类，又保证线上链路与测试走同一段代码。

/** P2PQuake（551/552/556）。 */
export function parseEpspResult(raw) {
  if (!isPlainObject(raw)) return failResult('schema', '顶层不是对象')
  const code = raw.code
  if (code !== 551 && code !== 552 && code !== 556) {
    return failResult('empty', 'code=' + String(code) + ' 不属于本插件的灾种')
  }
  const id = raw.id || raw._id
  if (typeof id !== 'string' || !id) return failResult('schema', '缺少 id/_id')
  const issueTime = raw.issue && raw.issue.time
  if (typeof issueTime !== 'string' || !issueTime) return failResult('schema', '缺少 issue.time')
  if (code === 551) {
    const eq = raw.earthquake
    if (!isPlainObject(eq)) return failResult('schema', '551 缺少 earthquake')
    if (typeof eq.maxScale !== 'number') return failResult('schema', '551 缺少 earthquake.maxScale（number）')
    if (!Array.isArray(raw.points)) return failResult('schema', '551 缺少 points 数组')
    for (const p of raw.points) {
      if (!isPlainObject(p)) return failResult('schema', '551 的 points[] 含非对象项')
      // 逐项只查"**存在则类型正确**"（0.4.2 放宽）：单个观测点缺 scale / 缺 pref 不该让整条
      // 警报消失——其他观测点是好的，而整条丢弃在预警产品里的代价是漏报。
      // 真正要挡的是"结构型错误"（points 不是数组、项不是对象、字段类型明显不对）。
      if (p.scale !== undefined && p.scale !== null && typeof p.scale !== 'number') {
        return failResult('schema', '551 的 points[].scale 类型不是 number')
      }
      if (p.pref !== undefined && p.pref !== null && typeof p.pref !== 'string') {
        return failResult('schema', '551 的 points[].pref 类型不是 string')
      }
      if (p.addr !== undefined && p.addr !== null && typeof p.addr !== 'string') {
        return failResult('schema', '551 的 points[].addr 类型不是 string')
      }
    }
    if (timeIsImpossible(timeMsOf(eq.time))) return failResult('value', '551 的 earthquake.time 客观不可能：' + String(eq.time))
  }
  if (code === 552) {
    if (!Array.isArray(raw.areas)) return failResult('schema', '552 缺少 areas 数组')
    for (const a of raw.areas) {
      if (!isPlainObject(a)) return failResult('schema', '552 的 areas[] 含非对象项')
      if (a.grade !== undefined && a.grade !== null && typeof a.grade !== 'string') {
        return failResult('schema', '552 的 areas[].grade 不是字符串')
      }
    }
  }
  if (code === 556) {
    const eq = raw.earthquake
    if (!isPlainObject(eq)) return failResult('schema', '556 缺少 earthquake')
    if (!isPlainObject(eq.hypocenter)) return failResult('schema', '556 缺少 earthquake.hypocenter')
    if (!Array.isArray(raw.areas)) return failResult('schema', '556 缺少 areas 数组')
    for (const a of raw.areas) {
      if (!isPlainObject(a)) return failResult('schema', '556 的 areas[] 含非对象项')
      if (typeof a.name !== 'string' || !a.name) return failResult('schema', '556 的 areas[].name 缺失')
      if (a.scaleTo !== undefined && a.scaleTo !== null && typeof a.scaleTo !== 'number') {
        return failResult('schema', '556 的 areas[].scaleTo 不是 number')
      }
    }
  }
  const alert = parse(raw)
  if (!alert) return failResult('schema', '解析器未能归一（结构通过校验但映射失败）')
  return okResult(alert)
}

/** 気象庁 防災情報XML。 */
export function parseJmaResult(xml, entry) {
  const text = String(xml === undefined || xml === null ? '' : xml)
  if (!text) return failResult('schema', '电文为空')
  if (text.indexOf('<Report') === -1) {
    // extra.xml 的详情地址偶尔会返回错误页 / 拦截页（HTTP 200 的 HTML），那种情况是 schema
    if (/^\s*<(!doctype|html)/i.test(text) || text.indexOf('<html') !== -1) {
      return failResult('schema', '返回的是 HTML 而不是 XML 电文（可能被拦截或地址失效）')
    }
    return failResult('schema', '不是防災情報XML（缺少 <Report> 根元素）')
  }
  const alert = parseJma(text, entry)
  if (!alert) return failResult('empty', '与本插件无关的电文（无警戒レベル、且不是解除）')
  return okResult(alert)
}

/** EMSC standing_order。 */
export function parseEmscResult(raw) {
  if (!isPlainObject(raw)) return failResult('schema', '顶层不是对象')
  if (raw.action === 'delete') return failResult('empty', '事件撤回通知（action=delete）')
  const d = raw.data
  if (!isPlainObject(d)) return failResult('schema', '缺少 data 对象')
  const p = d.properties
  if (!isPlainObject(p)) return failResult('schema', '缺少 data.properties')
  const coords = (d.geometry && Array.isArray(d.geometry.coordinates)) ? d.geometry.coordinates : []
  const lat = numOf(p.lat !== undefined ? p.lat : coords[1])
  const lon = numOf(p.lon !== undefined ? p.lon : coords[0])
  if (lat === null || lon === null) return failResult('schema', '缺少震中坐标（properties.lat/lon 与 geometry.coordinates 都没有）')
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return failResult('value', '震中坐标越界：' + lat + ',' + lon)
  if (numOf(p.mag) === null) return failResult('schema', '缺少 properties.mag（number）')
  const t = timeMsOf(p.time)
  if (t === null) return failResult('schema', '缺少 properties.time（可解析的时间）')
  if (timeIsImpossible(t)) return failResult('value', '发震时刻客观不可能：' + String(p.time))
  if (p.evtype !== undefined && String(p.evtype) !== 'ke') {
    return failResult('empty', '非地震事件（evtype=' + String(p.evtype) + '）')
  }
  const alert = parseEmsc(raw)
  if (!alert) return failResult('schema', '解析器未能归一（结构通过校验但映射失败）')
  return okResult(alert)
}

/** USGS summary feed 的单个 Feature。 */
export function parseUsgsResult(feature) {
  if (!isPlainObject(feature)) return failResult('schema', '不是 GeoJSON Feature 对象')
  const p = feature.properties
  if (!isPlainObject(p)) return failResult('schema', '缺少 feature.properties')
  const coords = (isPlainObject(feature.geometry) && Array.isArray(feature.geometry.coordinates))
    ? feature.geometry.coordinates : []
  const lon = numOf(coords[0] !== undefined ? coords[0] : p.lon)
  const lat = numOf(coords[1] !== undefined ? coords[1] : p.lat)
  if (lat === null || lon === null) return failResult('schema', '缺少 geometry.coordinates / properties.lat,lon')
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return failResult('value', '震中坐标越界：' + lat + ',' + lon)
  if (numOf(p.mag) === null) return failResult('schema', '缺少 properties.mag（number）')
  const t = timeMsOf(p.time)
  if (t === null) return failResult('schema', '缺少 properties.time（epoch 毫秒或可解析的时间）')
  if (timeIsImpossible(t)) return failResult('value', '发震时刻客观不可能：' + String(p.time))
  const alert = parseUsgsFeature(feature)
  if (!alert) return failResult('schema', '解析器未能归一（结构通过校验但映射失败）')
  return okResult(alert)
}

/** NOAA tsunami.gov 的 CAP 1.2 电文。 */
export function parseNoaaResult(xml, entry) {
  const text = String(xml === undefined || xml === null ? '' : xml)
  if (!text) return failResult('schema', 'CAP 电文为空')
  if (text.indexOf('<alert') === -1) {
    if (text.indexOf('<html') !== -1 || /^\s*<(!doctype|html)/i.test(text)) {
      return failResult('schema', '返回的是 HTML 而不是 CAP 电文（可能被拦截或地址失效）')
    }
    return failResult('schema', '不是 CAP 电文（缺少 <alert> 根元素）')
  }
  const msgType = (/<msgType>([^<]*)<\/msgType>/.exec(text) || [])[1] || ''
  if (String(msgType).trim() === 'Test') return failResult('empty', '演练电文（msgType=Test）')
  const alert = parseNoaaCap(text, entry)
  if (!alert) return failResult('schema', '缺少 <identifier> 或解析器未能归一')
  if (alert.geoList && alert.geoList.length) {
    for (const g of alert.geoList) {
      if (Math.abs(g.lat) > 90 || Math.abs(g.lon) > 180) return failResult('value', 'circle 坐标越界：' + g.lat + ',' + g.lon)
    }
  }
  return okResult(alert)
}

/**
 * Wolfx 大陆地震预警（`cenc_eew`）。
 *
 * 时间判据用 `cnTimeToIso` 之后的串去解析：裸的 `2026-09-18 20:50:23` 交给 `Date.parse` 会按
 * **本机时区**解释，而它其实是北京时间——那样"客观不可能"这条判据就带上了本机时区的偏差。
 */
export function parseCencEewResult(raw) {
  if (!isPlainObject(raw)) return failResult('schema', '顶层不是对象')
  if (raw.type !== undefined && String(raw.type) !== 'cenc_eew') {
    return failResult('schema', 'type 不是 cenc_eew（收到 ' + String(raw.type) + '）')
  }
  // empty 判据：10 个字段一个都没有。理由与证据等级见 SOURCE_CONTRACTS.cenc_eew.empty。
  const fields = ['ID', 'EventID', 'OriginTime', 'ReportTime', 'Latitude', 'Longitude', 'Magnitude', 'Depth', 'MaxIntensity', 'HypoCenter']
  const hasAny = fields.some((k) => {
    const v = raw[k]
    return v !== undefined && v !== null && String(v) !== ''
  })
  if (!hasAny) return failResult('empty', '载荷里没有任何预警字段（源正常但当前没有预警）')
  const id = raw.ID
  if (typeof id !== 'string' || !id.trim()) return failResult('schema', '缺少 ID（string）')
  const lat = numOf(raw.Latitude)
  const lon = numOf(raw.Longitude)
  if (lat === null || lon === null) return failResult('schema', '缺少 Latitude / Longitude（数值）')
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return failResult('value', '震中坐标越界：' + lat + ',' + lon)
  if (numOf(raw.Magnitude) === null) return failResult('schema', '缺少 Magnitude（数值）')
  const t = timeMsOf(cnTimeToIso(raw.OriginTime))
  if (t === null) return failResult('schema', '缺少 OriginTime（可解析的北京时间）')
  if (timeIsImpossible(t)) return failResult('value', '发震时刻客观不可能：' + String(raw.OriginTime))
  const alert = parseCencEew(raw)
  if (!alert) return failResult('schema', '解析器未能归一（结构通过校验但映射失败）')
  return okResult(alert)
}

/**
 * 速报整表里的单项（`NoN`）。逐条过契约，便于定位"哪一项坏了"。
 * 注意：单项失败**不等于整表坏**——批量语义见 parseCencEqlistResult。
 */
export function parseCencEqlistItemResult(item) {
  if (!isPlainObject(item)) return failResult('schema', '速报项不是对象')
  const eventId = item.EventID
  if (typeof eventId !== 'string' || !eventId.trim()) return failResult('schema', '缺少 EventID（string）')
  const lat = numOf(item.latitude)
  const lon = numOf(item.longitude)
  if (lat === null || lon === null) return failResult('schema', '缺少 latitude / longitude（数字字符串或数值）')
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return failResult('value', '震中坐标越界：' + lat + ',' + lon)
  if (numOf(item.magnitude) === null) return failResult('schema', '缺少 magnitude（数字字符串或数值）')
  const t = timeMsOf(cnTimeToIso(item.time))
  if (t === null) return failResult('schema', '缺少 time（可解析的北京时间）')
  if (timeIsImpossible(t)) return failResult('value', '发震时刻客观不可能：' + String(item.time))
  const alert = parseCencEqlistItem(item)
  if (!alert) return failResult('schema', '解析器未能归一（结构通过校验但映射失败）')
  return okResult(alert)
}

/**
 * 速报整表 → 批量结果 `{ ok, alerts, dropped, md5 }`。
 *
 * **为什么批量与单项分开判**：整表 50 条，一条缺坐标就让整表作废等于漏掉另外 49 条真实地震
 * ——0.4.2 已经就 551 的观测点定过同一口径（"存在则类型必须正确"，缺失容忍）。
 * 所以：坏条目**逐条丢弃并计数**（`dropped`，不是静默），只有**一条都没解析出来**才判整表 schema。
 * 整表一条都没有则判 empty——源正常但当前没有速报数据。
 */
export function parseCencEqlistResult(json) {
  if (!isPlainObject(json)) return failResult('schema', '顶层不是对象')
  if (json.type !== undefined && String(json.type) !== 'cenc_eqlist') {
    return failResult('schema', 'type 不是 cenc_eqlist（收到 ' + String(json.type) + '）')
  }
  const items = cencEqlistItems(json)
  if (items.length === 0) return failResult('empty', '整表里没有 NoN 条目（源正常但当前没有速报数据）')
  const alerts = []
  let dropped = 0
  let firstDetail = ''
  for (const it of items) {
    const res = parseCencEqlistItemResult(it)
    if (res.ok) { alerts.push(res.alert); continue }
    if (res.kind === 'empty') continue
    dropped++
    if (!firstDetail) firstDetail = res.kind + '：' + res.detail
  }
  if (alerts.length === 0) {
    return failResult('schema', '整表 ' + items.length + ' 条全部无法解析（' + firstDetail + '）')
  }
  return { ok: true, alerts, dropped, md5: cencEqlistMd5Of(json), total: items.length }
}

// ---------------------------------------------------------------- 健康状态
/**
 * 数据健康记录（sourceId → 最近一次解析失败）。
 *
 * 与连接状态**分开保存**、由 effectiveStatusOf 合并：连接正常但数据格式变了是完全不同的一类
 * 故障（用户处理不了，只能等插件更新），DESIGN 把两者分成蓝 / 红两色就是为了让用户不去白折腾网络。
 * 「同一失败原因只记一次日志」也在这里实现——高频源（JMA 每分钟）否则会把控制台刷屏。
 */
const health = new Map()

/**
 * 记录一次解析结果。返回 true 表示"该源当前处于数据异常状态，调用方不应继续处理这条数据"。
 * empty 不算故障（源正常但没有与本插件相关的数据）。
 */
export function noteParseResult(sourceId, res) {
  if (!res || res.ok) return false
  if (res.kind === 'empty') {
    // empty 表示"源正常地给出了这一条，只是与本插件无关"——它同样证明**结构是好的**，
    // 所以要把之前可能留下的 schema-error 清掉。否则一条坏电文会让蓝点（+ 重试按钮）
    // 挂几个小时甚至几天：JMA 的常态就是 empty（天气预报、只有注意報的电文）。
    noteSourceSuccess(sourceId)
    return false
  }
  const key = res.kind + '|' + res.detail
  const prev = health.get(sourceId)
  if (!prev || prev.errorKey !== key) {
    health.set(sourceId, { errorKey: key, kind: res.kind, detail: res.detail, at: Date.now() })
    try { console.warn('[dsh-quake-alert] ' + sourceId + ' 解析失败（' + res.kind + '）：' + res.detail) } catch (e) { /* 忽略 */ }
    // 上报也放在这个分支里：源整体变坏时一轮可能有几十条 entry 都失败，
    // 每条都 pushSource 会把设置页重渲几十次。"同一失败原因只记一次"要同时约束日志与上报。
    store.pushSource(sourceId, { status: 'schema-error', detail: res.kind + '：' + res.detail })
  }
  return true
}

/** 解析成功：从"数据格式异常"恢复时上报一次（连接层不会替我们清掉蓝点）。 */
export function noteSourceSuccess(sourceId) {
  const prev = health.get(sourceId)
  if (!prev || !prev.errorKey) return false
  health.delete(sourceId)
  store.pushSource(sourceId, { status: 'open', detail: '数据格式已恢复正常' })
  return true
}

/** 手动重试（DESIGN 5.4：schema-error 状态下提供手动重试）。清掉异常标记，等下一批数据自证。 */
export function retrySource(sourceId) {
  health.delete(sourceId)
  store.pushSource(sourceId, { status: 'open', detail: '已手动重试，等待下一批数据' })
}

/** 当前的数据健康快照（诊断 / 测试用）。 */
export function sourceHealthOf(sourceId) {
  const h = sourceId === undefined ? null : health.get(sourceId)
  if (sourceId !== undefined) return h ? Object.assign({}, h) : null
  const all = {}
  for (const [k, v] of health) all[k] = Object.assign({}, v)
  return all
}

/** 把"数据健康"叠加到连接状态上：数据格式异常优先显示（蓝），它才是用户真正处理不了的那个。 */
export function effectiveStatusOf(sourceId, connStatus, detail) {
  const h = health.get(sourceId)
  if (h && h.errorKey) return { status: 'schema-error', detail: h.kind + '：' + h.detail }
  return { status: connStatus, detail }
}

/** 测试钩子：清空健康记录（模块级 Map 会跨用例存活）。 */
export function resetSourceHealth() { health.clear() }
