// ============================================================================
// dsh-quake-alert · client/src/05-parser.js
// 作用：P2PQuake 原始消息（code 551/552/556）→ 统一 Alert：字段映射、区域名对齐 prefsOfArea、
//       跨县区域展开、震度/海啸文案与 headline 组装。依赖 01-constants、02-storage、00-i18n。

import { PREFECTURES, TSUNAMI_RANK, normalizePref, p2pTimeToIso } from './01-constants.js'
import { own } from './02-storage.js'
import { t } from './00-i18n.js'

// ---------- 解析器：P2PQuake code → Alert ----------
// Alert 字段：id/code/kind/kindLabel/severity/issued/headline/maxScale/hypo/geo/cancelled/raw，
// 加 regions:[{pref, area, scale?, grade?}]、eventKey（归并同一地震的多次发布）、strength（判强度升级）。

// 电文里的震中坐标 → { lat, lon }；缺一个 / 越界 / 非有限数一律返回 null（半个坐标会让跨源归并把
// 两场不相关的地震并成一个，属漏报方向）。只服务跨源事件归并（±2 分钟 + 50km，见 10-dedupe）：
// **不设 locator:'point'**，否则 06-matcher 按"震中距 ≤ 半径"匹配，漏掉震中远而本地震度达阈值的。
function geoOfHypo(hypo) {
  const lat = hypo ? hypo.latitude : null
  const lon = hypo ? hypo.longitude : null
  if (typeof lat !== 'number' || typeof lon !== 'number') return null
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return null
  return { lat, lon }
}
// 区域名 → 都道府县全称。551 的 points[].pref 本身是县全称（偶有「京都」这类简写，由 normalizePref 统一为全称）；
// 556/552 的 areas[].name 是「区域名」，一部分不含都道府县名（北海道用地方名、东京都用岛屿名、海啸予報区用海域名），不映射就会静默漏报。
const AREA_PREF = {
  '伊豆大島': ['東京都'], '新島': ['東京都'], '神津島': ['東京都'],
  '三宅島': ['東京都'], '八丈島': ['東京都'], '小笠原': ['東京都'],
  'オホーツク海沿岸': ['北海道'],
  '陸奥湾': ['青森県'],
  '東京湾内湾': ['千葉県', '東京都', '神奈川県'],
  '伊豆諸島': ['東京都'],
  '小笠原諸島': ['東京都'],
  '相模湾・三浦半島': ['神奈川県'],
  '佐渡': ['新潟県'],
  '伊勢・三河湾': ['愛知県', '三重県'],
  '淡路島南部': ['兵庫県'],
  '隠岐': ['島根県'],
  '有明・八代海': ['福岡県', '佐賀県', '長崎県', '熊本県'],
  '壱岐・対馬': ['長崎県'],
  '種子島・屋久島地方': ['鹿児島県'],
  '奄美群島・トカラ列島': ['鹿児島県'],
  '沖縄本島地方': ['沖縄県'],
  '大東島地方': ['沖縄県'],
  '宮古島・八重山地方': ['沖縄県'],
}
// 556 的 areas[].pref 是府県予報区名（简写："茨城"/"東京"/"北海道道北"…），仅作区域名对不上时的兜底。
const FORECAST_PREF = {
  '伊豆諸島': ['東京都'], '小笠原': ['東京都'], '奄美群島': ['鹿児島県'],
  '沖縄本島': ['沖縄県'], '大東島': ['沖縄県'], '宮古島': ['沖縄県'], '八重山': ['沖縄県'],
}
// 北海道在 EEW 中按地方名划分区域（石狩地方北部…），名称里没有「北海道」
const HOKKAIDO_AREA_PREFIX = [
  '石狩地方', '後志地方', '空知地方', '渡島地方', '檜山地方', '胆振地方', '日高地方',
  '上川地方', '留萌地方', '宗谷地方', '網走地方', '北見地方', '紋別地方', '十勝地方',
  '釧路地方', '根室地方',
]
// 县名按长度降序：保证「京都府」先于「京都」被匹配（否则京都府会被截成京都）
const PREF_BY_LENGTH = PREFECTURES.map((p) => p.jp).sort((a, b) => b.length - a.length)
const startsWith = (s, p) => s.lastIndexOf(p, 0) === 0
// 字典查找一律用 own()（见 02-storage）：外部键会命中原型链，AREA_PREF['constructor'] 会让 .slice() 抛错。

// 对齐区域名，返回它可能覆盖的全部都道府县（海啸「有明・八代海」等跨多个县）
function prefsOfArea(name, forecastPref) {
  const s = String(name || '')
  const exact = own(AREA_PREF, s)
  if (exact) return exact.slice()
  if (HOKKAIDO_AREA_PREFIX.some((p) => startsWith(s, p))) return ['北海道']
  for (const p of PREF_BY_LENGTH) if (startsWith(s, p)) return [p]
  const hint = String(forecastPref || '')
  if (hint) {
    const hit = own(FORECAST_PREF, hint)
    if (hit) return hit.slice()
    for (const p of PREF_BY_LENGTH) if (startsWith(hint, p)) return [p]
    for (const p of PREF_BY_LENGTH) if (startsWith(p, hint)) return [p]
  }
  return []
}
// 把一个区域展开成 region 条目；跨县区域展开为多条，对不上时 pref='' 并标记
function regionsOfArea(name, forecastPref, value, valueKey) {
  const area = name || ''
  const prefs = prefsOfArea(area, forecastPref)
  if (prefs.length === 0) {
    const region = { pref: '', area, prefUnknown: true }
    region[valueKey] = value
    return [region]
  }
  return prefs.map((p) => {
    const region = { pref: p, area }
    region[valueKey] = value
    return region
  })
}
// 震度 / 海啸等级文字：按界面语言取词；取不到该档位的键时退回数字形态（别在这里写死中文）。
const scaleText = (v) => {
  const key = 'scale.' + v
  const own1 = (typeof v === 'number') ? t(key) : ''
  if (own1 && own1 !== key) return own1
  if (typeof v === 'number' && v > 0) return t('scale.number', { n: Math.floor(v / 10) })
  return t('scale.unknown')
}
// 震度后缀：只在有效震度（>0）时追加；震度是用户判断严重性的关键信息（阈值也按震度设），必须出现在
// headline 里。prefix 例：'最大' → 「最大震度3」。prefix 与 scaleText 之间不留空格（英文靠 scaleText 自带空格）。
const scaleSuffix = (v, prefix) => (typeof v === 'number' && v > 0 ? ' · ' + prefix + scaleText(v) : '')
// severity → 颜色。'yellow'（默认阈值 40 下最常见的命中，震度4）必须显式处理，否则落到默认的"信息蓝"。
const sevColor = (s) => (
  s === 'red' ? '#e8565b'
    : (s === 'orange' ? '#f76b15'
      : (s === 'yellow' ? '#d9a406' : '#3b82f6'))
)
const severityOfScale = (v) => {
  if (typeof v !== 'number' || v <= 0) return 'info'
  if (v >= 55) return 'red'
  if (v >= 45) return 'orange'
  if (v >= 40) return 'yellow'
  return 'info'
}

function parseQuake(raw) {
  const type = (raw.issue && raw.issue.type) || ''
  // 分类名是我们给起的（不是电文原文）→ 按界面语言取词
  const labelMap = {
    ScalePrompt: 'kind.quakeScale', Destination: 'kind.quakeHypo', ScaleAndDestination: 'kind.quakeScaleHypo',
    DetailScale: 'kind.quakeDetail', Foreign: 'kind.quakeForeign', Other: 'kind.quakeInfo',
  }
  const labelKeyOf = () => own(labelMap, type) || 'kind.quakeInfo'
  const eq = raw.earthquake || {}
  const hypo = eq.hypocenter || {}
  const pts = raw.points || []
  const hasHypo = typeof hypo.name === 'string' && hypo.name !== ''
  // 有震源名时用模板拼（`震源 {name} · M{mag}`）；震源名与机构名是上游原文，原样透传。
  const headBase = hasHypo
    ? t('kind.quakeHeadline', { name: hypo.name, mag: (typeof hypo.magnitude === 'number' ? hypo.magnitude : '—') })
    : t(labelKeyOf())
  const headline = headBase + scaleSuffix(eq.maxScale, t('scale.prefixMax'))
  return {
    id: String(raw.id || raw._id || ''), code: 551, kind: 'quake',
    kindLabel: t(labelKeyOf()),
    severity: severityOfScale(eq.maxScale),
    // 时间统一转成带偏移的 ISO 8601。P2PQuake 给的是裸 JST（"2026/09/07 23:25:14"），不补偏移
    // 在其它时区会差 1 小时且无标注；旧历史数据没有偏移，由 formatIssuedLocal 按 JST 解释。
    issued: p2pTimeToIso((raw.issue && raw.issue.time) || raw.time || ''),
    headline,
    maxScale: typeof eq.maxScale === 'number' ? eq.maxScale : -1,
    // 事件级去重键：同一次地震的速报 / 震源 / 详报共享 earthquake.time（551 没有 issue.eventId）
    eventKey: eq.time ? 'quake:' + eq.time : '',
    strength: typeof eq.maxScale === 'number' ? eq.maxScale : -1,
    hypo: { name: hypo.name || '', magnitude: typeof hypo.magnitude === 'number' ? hypo.magnitude : null },
    // 震中坐标：只给跨源事件归并用，不参与匹配（见 geoOfHypo）
    geo: geoOfHypo(hypo),
    regions: pts.map((p) => ({
      pref: normalizePref(p.pref),
      area: p.addr || '',
      scale: typeof p.scale === 'number' ? p.scale : -1,
      // isArea=true 是区域名（无法对应到具体市区町村），false/缺省才是观测点，可做市级收窄。
      cityKnown: p.isArea !== true,
    })),
    cancelled: false,
    raw,
  }
}

function parseEew(raw) {
  const cancelled = raw.cancelled === true
  const eq = raw.earthquake || {}
  const hypo = eq.hypocenter || {}
  const areas = raw.areas || []
  const maxTo = areas.reduce((m, a) => (typeof a.scaleTo === 'number' && a.scaleTo > m ? a.scaleTo : m), -1)
  return {
    id: String(raw.id || raw._id || ''), code: 556, kind: 'eew',
    kindLabel: cancelled ? t('kind.eewCancelled') : t('kind.eewWarning'),
    severity: cancelled ? 'info' : 'red',
    issued: p2pTimeToIso((raw.issue && raw.issue.time) || raw.time || ''),
    headline: cancelled
      ? t('kind.eewCancelledHeadline')
      : t('kind.quakeHeadline', { name: (hypo.name || t('kind.areaUnknown')), mag: (typeof hypo.magnitude === 'number' ? hypo.magnitude : '—') }) +
        scaleSuffix(maxTo, t('scale.prefixEewMax')),
    maxScale: maxTo,
    // EEW 的多报共享 issue.eventId（serial 递增），用它做事件级去重
    eventKey: (raw.issue && raw.issue.eventId) ? 'eew:' + raw.issue.eventId : '',
    strength: maxTo,
    hypo: { name: hypo.name || '', magnitude: typeof hypo.magnitude === 'number' ? hypo.magnitude : null },
    // 震中坐标：同 551（见 geoOfHypo）。EEW 是日本这一路最先播出的来源，跨源归并最依赖它带坐标。
    geo: geoOfHypo(hypo),
    regions: areas.flatMap((a) => regionsOfArea(a.name, a.pref, typeof a.scaleTo === 'number' ? a.scaleTo : -1, 'scale')),
    cancelled,
    raw,
  }
}

function parseTsunami(raw) {
  const cancelled = raw.cancelled === true
  const areas = raw.areas || []
  // 两侧分隔符与「高さ」前缀是我们拼的，走模板（`{area}：{grade}{height}`）；预报区名与浪高描述是电文原文。
  const gradeKeyOf = (grade) => {
    const k = 'tsunami.' + grade
    const got = grade ? t(k) : ''
    return (got && got !== k) ? got : (grade || t('kind.areaUnknown'))
  }
  const lines = areas.map((a) => t('kind.tsunamiLine', {
    area: a.name || t('kind.areaUnknown'),
    grade: gradeKeyOf(a.grade),
    height: (a.maxHeight && a.maxHeight.description) ? t('kind.tsunamiHeight', { height: a.maxHeight.description }) : '',
  }))
  const worst = areas.reduce((m, a) => Math.max(m, own(TSUNAMI_RANK, a.grade) || 0), 0)
  const anyWarning = worst >= 2
  return {
    id: String(raw.id || raw._id || ''), code: 552, kind: 'tsunami',
    kindLabel: cancelled
      ? t('kind.tsunamiCancelled')
      : (worst >= 3 ? t('kind.tsunamiMajor') : (anyWarning ? t('kind.tsunamiWarning') : t('kind.tsunamiAdvisory'))),
    severity: cancelled ? 'info' : (worst >= 2 ? 'red' : 'orange'),
    issued: p2pTimeToIso((raw.issue && raw.issue.time) || raw.time || ''),
    headline: cancelled ? t('kind.tsunamiCleared') : lines.join('；'),
    maxScale: worst,
    // 事件键用「预报区名集合」。海啸预报没有可归并的 id（issue 只有 source/time/type），绝不能留空：
    // cancelKeyOf 会退回 kind（'tsunami'），任意海域的解除都被当成"此前提醒过的事件"，播出一条无关的
    // 「海啸预报已解除」（海啸域的假安全）。区域不一致时匹配不上 → 不提示（安全侧）。
    eventKey: areas.length ? 'tsunami:' + areas.map((a) => String(a.name || '')).sort().join(',') : '',
    strength: worst,
    regions: areas.flatMap((a) => regionsOfArea(a.name, a.pref, a.grade || '', 'grade')),
    cancelled,
    raw,
  }
}

function parse(raw) {
  if (!raw || typeof raw !== 'object') return null
  if (raw.code === 556) return parseEew(raw)
  if (raw.code === 552) return parseTsunami(raw)
  if (raw.code === 551) return parseQuake(raw)
  return null
}


export { AREA_PREF, prefsOfArea, regionsOfArea, scaleText, scaleSuffix, sevColor, severityOfScale, geoOfHypo, parseQuake, parseEew, parseTsunami, parse }
