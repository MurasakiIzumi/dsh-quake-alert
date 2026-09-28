// ============================================================================
// dsh-quake-alert · client/src/05e-cn-parsers.js
//
// 作用：把 Wolfx 转播的中国大陆地震源（`cenc_eew` 预警 / `cenc_eqlist` 速报）解析成内部模型（Alert）。
// 依赖：01-constants（cnTimeToIso）、02-storage（isPlainObject）、05c-global-parsers（severityOfMagnitude、geoEventKey）。
//
// 大陆源没有分区烈度表（中继只给震中坐标 + 震级），所以走 `locator:'point'`，与 EMSC / USGS 同一条
// 匹配路径。实测字段：`cenc_eew` 10 个字段全是 number；`cenc_eqlist` 是 50 条整表（No1…No50 + md5）
// 且**所有字段都是字符串**。两源的 EventID 格式互不相干 → 归并只能靠「发震时刻 + 震中」（geoEventKey）。
//
// 取值域事实：`MaxIntensity`（EEW，实测连续小数 5.8）与 `intensity`（速报，实测整数 3…8）都是
// 中国地震烈度（GB/T 17742-2020），是震中附近的最大值、不是用户所在地的烈度——两条链路写进 Alert
// 的同一个 `intensity` 字段但**取值域不同**，下游若要按它分档必须先分裂字段名。
//
// 大陆源**没有取消 / 最终报标志**，cancelled 恒为 false，代码里不得假装能处理。
// ============================================================================

import { cnTimeToIso } from './01-constants.js'
import { isPlainObject } from './02-storage.js'
import { t } from './00-i18n.js'
import { severityOfMagnitude, geoEventKey } from './05c-global-parsers.js'

/** 字符串或数字 → 有限数值；空串 / 垃圾值 / 缺失一律 null。
 *  不能用 `Number('')`——它等于 0，会把"没有震级"变成"震级 0"并放行一个不知道多大的事件。 */
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
  return (name ? ' · ' + name : '') + (depthKm === null ? '' : t('kind.cencDepth', { depth: Math.round(depthKm) }))
}

/**
 * 大陆地震预警（`cenc_eew`）→ Alert。WS 推送包（含 `type`）与 REST 快照（无 type）都接受。
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
  // OriginTime 是发震时刻，ReportTime 是发布时刻（实测两者相同，是上游的填充习惯，不能据此判定
  // 它"不是实时预警"）。事件键用 OriginTime（与其它源同一口径）。
  const originIso = cnTimeToIso(raw.OriginTime)
  const reportIso = cnTimeToIso(raw.ReportTime)
  const reportNum = numOrNull(raw.ReportNum)
  const headline = magText(mag) + placeText(place, depth) +
    (reportNum !== null && reportNum > 1 ? t('kind.cencReportNo', { n: reportNum }) : '')
  return {
    // id 前缀 cenc: ——与速报的 EventID 是两套命名空间
    id: 'cenc:' + id,
    code: 'cenc_eew',
    kind: 'eew',
    kindLabel: t('kind.cencEew'),
    source: 'cenc_eew',
    // 无分区烈度 → 坐标 + 半径匹配；震级门槛共用 thresholds.globalMagnitude（与预警同档）
    locator: 'point',
    speedReport: false,
    // **恒 red，与日本 556 同口径**（EEW 本质是警报）。severity 决定配色与**静默时段能否穿透**
    // （只有 red 穿透）：按震级分档会让 M4.2 的预警在夜间被静默掉，那是漏报方向。
    severity: 'red',
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
    // 中国地震烈度（震中附近最大值，只入库、不上 UI）。**取值域**：EEW 的 `MaxIntensity` 是连续
    // 小数（5.8），与速报那条整数档共用同一个字段名——下游若要按它分档，先分裂字段（见文件头）。
    intensity: numOrNull(raw.MaxIntensity),
    reportNum,
    cancelled: false, // 大陆源不提供取消 / 最终报标志，不得假装能处理
    raw,
  }
}

/** 速报整表里的单项（`NoN`）→ Alert。所有字段都是字符串（实测）；地名取 placeName 优先。 */
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
  // time 是发震时刻，ReportTime 是发布时刻。实测 lag 209–1643 秒。
  const originIso = cnTimeToIso(item.time)
  const reportIso = cnTimeToIso(item.ReportTime)
  const headline = magText(mag) + placeText(place, depth)
  return {
    id: 'cenc:' + eventId,
    code: 'cenc_eqlist',
    kind: 'quake',
    kindLabel: t('kind.cencEqlist'),
    source: 'cenc_eqlist',
    locator: 'point',
    // 速报不是预警：用**独立**的震级门槛（thresholds.cnReportMagnitude），否则会被小震频繁打扰。
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
    // 中国地震烈度（整数档，只入库、不上 UI）：与上面 EEW 那条**同名不同域**（速报 3…8 整数）。
    intensity: numOrNull(item.intensity),
    // 实测全是 "reviewed"。不认识的取值**不丢弃**——它仍是同一场真实地震，原样带上供诊断。
    reportType: String(item.type === undefined || item.type === null ? '' : item.type).trim(),
    cancelled: false,
    raw: item,
  }
}

/**
 * 速报整表 → 按 `No1…NoN` **数值序**（不是字典序，否则 No10 会排到 No2 前面）；实测 No1 最新。
 * 非 `NoN` 键（type / md5）原样跳过。
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

/** 速报整表的变更指纹。实测存在；缺失时返回空串（**不**据此判 schema）。 */
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
