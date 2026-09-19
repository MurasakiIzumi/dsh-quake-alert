// ============================================================================
// dsh-quake-alert · client/src/05e-cn-parsers.js
//
// 作用：把 Wolfx 转播的中国大陆地震源解析成与日本源 / 全球源同一套内部模型（Alert）。
// 内容：`cenc_eew`（中国地震预警，秒级抢发）与 `cenc_eqlist`（中国地震速报，分钟级确认 / 补报）。
// 依赖：01-constants（cnTimeToIso）、02-storage（isPlainObject）、05c-global-parsers（severityOfMagnitude、geoEventKey）。
//
// 为什么与全球源同路径而不是与日本源同路径（DESIGN 8.2 / 8.5）：
//   · 大陆源**没有分区烈度表**——官方渠道是小程序 / OS 内置，第三方中继只给震中坐标 + 震级。
//     所以只能走 `locator:'point'`（坐标 + 半径），与 EMSC / USGS 完全同一条匹配路径，
//     也因此**不需要中国行政区划表**。这是数据源能力的客观差异，不是功能裁剪。
//
// 实测字段（samples/cn/，2026-09-18 真实数据）与踩过的坑：
//   · `cenc_eew` 全部字段只有 10 个（加 WS 包裹的 type 共 11 个），数值都是 **number**。
//   · `cenc_eqlist` 是一整张 50 条的**列表**（No1…No50 + md5），而且**所有字段都是字符串**
//     （"magnitude":"3.7"、"latitude":"41.14"）——同一个上游的两种序列化风格，不能假定其一。
//   · `MaxIntensity`（EEW，实测 5.8/5.9 连续小数）与 `intensity`（速报，实测 3…8 整数）是
//     **中国地震烈度**（GB/T 17742-2020），不是日本震度、也不是震级。它是**震中附近的最大值**，
//     不是用户所在地的烈度 —— **只入库、不上 UI**，否则会被读成后者的承诺。
//   · `cenc_eqlist` 里**混有境外地震**（实测福克斯群岛 M6.5、印尼爪哇岛 M6.5、南桑威奇群岛 M6.2、
//     台湾花莲县…）。所以它会与全球链路（EMSC / USGS）撞车——靠 geoEventKey 同一把钥匙归并。
//   · 两个源的 **EventID 格式互不相干**：EEW 是 `202609182050.0001`，速报是 `CD.20260918205536.056`。
//     同一场地震（实测四川甘孜州新龙县：EEW 20:50:23 M4.2 / 速报 20:50:24 M3.2）两边 ID 毫无关系，
//     所以**归并只能靠「发震时刻 + 震中」**，绝不能靠 ID。这正是 geoEventKey 的用武之地。
//   · **无取消 / 最终报标志**（既无 isCancel 也无 isFinal）。现有「取消只在此前提醒过时补一条」的
//     链路对大陆源**失效**——这是安全相关的缺口，UI 必须如实说明（DESIGN 8.3 / 10.2），
//     代码里不得假装能处理：cancelled 恒为 false。
// ============================================================================

import { cnTimeToIso } from './01-constants.js'
import { isPlainObject } from './02-storage.js'
import { severityOfMagnitude, geoEventKey } from './05c-global-parsers.js'

/**
 * 字符串或数字 → 有限数值；空串 / 垃圾值 / 缺失一律 null。
 * **不能用 Number('')**——它等于 0，会把"没有震级"变成"震级 0"（震级 0 会让阈值闸门放行一个
 * 根本不知道多大的事件，在大陆速报这种每条都要判阈值的链路上就是误报）。
 * 速报整表字段全是字符串，所以这个转换是必需的而不是防御性的。
 */
function numOrNull(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null
  const s = String(v === undefined || v === null ? '' : v).trim()
  if (!s) return null
  const n = Number(s)
  return Number.isFinite(n) ? n : null
}

/** 人名可读的震级文案：未知时给 M—，绝不显示 "Mnull"。 */
function magText(mag) {
  return 'M' + (mag === null ? '—' : mag)
}

/** 震中名 + 深度 的公共 headline 片段。 */
function placeText(name, depthKm) {
  return (name ? ' · ' + name : '') + (depthKm === null ? '' : ' · 深 ' + Math.round(depthKm) + 'km')
}

/**
 * 大陆地震预警（`cenc_eew`）→ Alert。
 *
 * @param {object} raw WS 推送包（含 `type:'cenc_eew'`）或 REST 快照（无 type）——**两种都接受**：
 *   实测 REST 与 WS 的差别就是多一个 type 字段，其余 10 个字段完全一致。
 * @returns {object|null} 结构不对时返回 null（由契约层的 schema 判据负责分类）
 */
function parseCencEew(raw) {
  if (!isPlainObject(raw)) return null
  const id = String(raw.ID === undefined || raw.ID === null ? '' : raw.ID).trim()
  if (!id) return null
  const lat = numOrNull(raw.Latitude)
  const lon = numOrNull(raw.Longitude)
  if (lat === null || lon === null) return null
  const mag = numOrNull(raw.Magnitude)
  const depth = numOrNull(raw.Depth)
  const place = String(raw.HypoCenter === undefined || raw.HypoCenter === null ? '' : raw.HypoCenter).trim()
  // OriginTime 是发震时刻，ReportTime 是发布时刻。实测两者**完全相同**——这是上游的填充习惯，
  // **不能据此判定它"不是实时预警"**（DESIGN 8.3）。事件键用 OriginTime（与其它源同一口径）。
  const originIso = cnTimeToIso(raw.OriginTime)
  const reportIso = cnTimeToIso(raw.ReportTime)
  const reportNum = numOrNull(raw.ReportNum)
  const headline = magText(mag) + placeText(place, depth) +
    (reportNum !== null && reportNum > 1 ? '（第 ' + reportNum + ' 报）' : '')
  return {
    // id 前缀 cenc: ——与速报的 EventID 是两套命名空间，实测不会撞（EEW 是 b4kybfnuqayyy 这类）
    id: 'cenc:' + id,
    code: 'cenc_eew',
    kind: 'eew',
    kindLabel: '大陆地震预警（CENC）',
    source: 'cenc_eew',
    // 无分区烈度 → 坐标 + 半径匹配（DESIGN 8.3）；
    // 震级闸门共用 thresholds.globalMagnitude（DESIGN 8.4：它不是速报，与预警同档）
    locator: 'point',
    speedReport: false,
    severity: severityOfMagnitude(mag),
    issued: originIso,
    reportTime: reportIso,
    headline,
    maxScale: -1,
    level: 0,
    geo: { lat, lon, depthKm: depth },
    magnitude: mag,
    magType: '',
    hypo: { name: place, magnitude: mag },
    regions: [],
    eventKey: geoEventKey(originIso, lat, lon),
    strength: mag === null ? 0 : mag,
    // 中国地震烈度（震中附近最大值）：只入库、不上 UI。详见文件头。
    intensity: numOrNull(raw.MaxIntensity),
    reportNum,
    cancelled: false, // 大陆源不提供取消 / 最终报标志——见文件头，不得假装能处理
    raw,
  }
}

/**
 * 速报整表里的单项（`NoN`）→ Alert。
 * 所有字段都是字符串（实测）；`location` 与 `placeName` 实测总是一样，取 placeName 优先、location 回退。
 */
function parseCencEqlistItem(item) {
  if (!isPlainObject(item)) return null
  const eventId = String(item.EventID === undefined || item.EventID === null ? '' : item.EventID).trim()
  if (!eventId) return null
  const lat = numOrNull(item.latitude)
  const lon = numOrNull(item.longitude)
  if (lat === null || lon === null) return null
  const mag = numOrNull(item.magnitude)
  const depth = numOrNull(item.depth)
  const place = String(
    (item.placeName === undefined || item.placeName === null ? '' : item.placeName) ||
    (item.location === undefined || item.location === null ? '' : item.location)
  ).trim()
  // time 是发震时刻，ReportTime 是发布时刻。实测 lag 209–1643 秒（DESIGN 8.3 记为 240–1608）。
  const originIso = cnTimeToIso(item.time)
  const reportIso = cnTimeToIso(item.ReportTime)
  const headline = magText(mag) + placeText(place, depth)
  return {
    id: 'cenc:' + eventId,
    code: 'cenc_eqlist',
    kind: 'quake',
    kindLabel: '大陆地震速报（CENC）',
    source: 'cenc_eqlist',
    locator: 'point',
    // 速报不是预警：它管分钟级确认与补报，用**独立**的震级门槛（thresholds.cnReportMagnitude），
    // 否则会被 M2.5–M3.8 的小震频繁打扰（DESIGN 8.4）。
    speedReport: true,
    severity: severityOfMagnitude(mag),
    issued: originIso,
    reportTime: reportIso,
    headline,
    maxScale: -1,
    level: 0,
    geo: { lat, lon, depthKm: depth },
    magnitude: mag,
    magType: '',
    hypo: { name: place, magnitude: mag },
    regions: [],
    eventKey: geoEventKey(originIso, lat, lon),
    strength: mag === null ? 0 : mag,
    intensity: numOrNull(item.intensity), // 中国地震烈度（整数档）：只入库、不上 UI
    // 实测全是 "reviewed"。不认识的取值**不丢弃**——它仍然是同一场真实地震，
    // 丢弃等于漏报；原样带上供诊断，是否收窄由将来的实测决定（那时才知道有哪些取值）。
    reportType: String(item.type === undefined || item.type === null ? '' : item.type).trim(),
    cancelled: false,
    raw: item,
  }
}

/**
 * 速报整表 → 按 `No1…NoN` **数值序**（不是字典序，否则 No10 会排到 No2 前面）的条目数组。
 * 实测 No1 是最新一条。非 `NoN` 键（type / md5）原样跳过。
 * @param {object} json WS / REST 的整表载荷
 * @returns {object[]} 原始条目（未解析），供逐条过契约
 */
function cencEqlistItems(json) {
  if (!isPlainObject(json)) return []
  const keys = Object.keys(json)
    .map((k) => { const m = /^No(\d+)$/.exec(k); return m ? { k, n: Number(m[1]) } : null })
    .filter(Boolean)
    .sort((a, b) => a.n - b.n)
  return keys.map((e) => json[e.k]).filter(isPlainObject)
}

/** 速报整表的变更指纹。实测存在；缺失时返回空串（**不**据此判 schema——见契约层的说明）。 */
function cencEqlistMd5Of(json) {
  if (!isPlainObject(json)) return ''
  const v = json.md5
  return typeof v === 'string' ? v.trim() : ''
}

/** 速报整表 → Alert[]（逐条解析，坏条目跳过而不是整表作废）。 */
function parseCencEqlist(json) {
  return cencEqlistItems(json).map(parseCencEqlistItem).filter(Boolean)
}

export { parseCencEew, parseCencEqlistItem, parseCencEqlist, cencEqlistItems, cencEqlistMd5Of, numOrNull }
