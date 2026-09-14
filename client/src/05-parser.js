// ============================================================================
// dsh-quake-alert · client/src/05-parser.js
//
// 作用：把 P2PQuake 的原始消息解析成统一 Alert（适配器层）。
// 内容：code 551/552/556 的字段映射、区域名归一 prefsOfArea（显式表 → 47 县前缀 →
//       府県予報区兜底）、跨县区域展开、震度/海啸文案、headline 组装。
// 依赖：01-constants、02-storage（归一化相关工具）。
// 注意：551 的 points[].pref 实测存在「京都」这类简写，已在常量层归一为全称。
// ============================================================================

import { PREFECTURES, SCALE_TEXT, TSUNAMI_RANK, TSUNAMI_GRADE_TEXT, normalizePref, p2pTimeToIso } from './01-constants.js'
import { own } from './02-storage.js'

// ---------- 解析器：P2PQuake code → Alert ----------
// Alert = { id, code, kind, kindLabel, severity, issued, headline, maxScale, hypo,
//           regions:[{pref, area, scale?, grade?}], cancelled, eventKey, strength }
//           eventKey 归并同一地震的多次发布，strength 用于强度升级判定
// 区域名 → 都道府县全称。
// 551 的 points[].pref 本身就是县全称，可直接用；但 556 的 areas[].name 与 552 的
// areas[].name 是「区域名」，其中一部分不含都道府县名（北海道用地方名、东京都用岛屿名、
// 海啸予報区用海域/群岛名），必须显式映射，否则关注对应县的用户会静默漏报。
// 数据来源：気象庁「緊急地震速報や震度情報で用いる区域の名称」区域名一覧、
//          「津波予報区について」境界一覧（全 66 区）。
const AREA_PREF = {
  // —— 紧急地震速报区域名：东京都岛屿（名称不含「東京」）——
  '伊豆大島': ['東京都'], '新島': ['東京都'], '神津島': ['東京都'],
  '三宅島': ['東京都'], '八丈島': ['東京都'], '小笠原': ['東京都'],
  // —— 海啸予報区：名称不含都道府县（66 区中的 17 个）——
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
// 556 的 areas[].pref 是府県予報区名（简写："茨城"/"東京"/"北海道道北"/"宮古島"…），
// 仅作为区域名归一失败时的兜底。
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
// 安全字典查找 own() 见 02-storage：外部数据里的 'constructor' / 'toString' 等键会命中原型链，
// 例如 AREA_PREF['constructor'] 会返回 Object 构造函数并让 .slice() 抛错。

// 归一区域名，返回它可能覆盖的全部都道府县（海啸「有明・八代海」等跨多个县）
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
// 把一个区域展开成 region 条目；跨县区域展开为多条，无法归一时 pref='' 并标记
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
const scaleText = (v) => own(SCALE_TEXT, v) || (typeof v === 'number' && v > 0 ? '震度' + Math.floor(v / 10) : '未公布')
// 震度后缀：只在有效震度时追加，避免「最大震度未公布」这类噪音。
// 震度是用户判断严重性的关键信息（阈值也是按震度设的），必须出现在 headline 里。
// prefix 例：'最大' → 「最大震度3」；'预测最大' → 「预测最大震度5强」。
const scaleSuffix = (v, prefix) => (typeof v === 'number' && v > 0 ? ' · ' + prefix + scaleText(v) : '')
// severity → 颜色。'yellow' 必须显式处理：默认阈值 40 下最常见的命中（震度4）就是它，
// 落到默认分支会显示成"信息蓝"，与「中等严重度」的语义不符。
const sevColor = (s) => (
  s === 'red' ? '#e5484d'
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
  const labelMap = {
    ScalePrompt: '地震速报·震度速报', Destination: '地震情报·震源', ScaleAndDestination: '地震情报·震源与震度',
    DetailScale: '地震情报·各地震度', Foreign: '地震情报·远地地震', Other: '地震情报',
  }
  const eq = raw.earthquake || {}
  const hypo = eq.hypocenter || {}
  const pts = raw.points || []
  const hasHypo = typeof hypo.name === 'string' && hypo.name !== ''
  const headBase = hasHypo
    ? '震源 ' + hypo.name + ' · M' + (typeof hypo.magnitude === 'number' ? hypo.magnitude : '—')
    : (own(labelMap, type) || '地震情报')
  const headline = headBase + scaleSuffix(eq.maxScale, '最大')
  return {
    id: String(raw.id || raw._id || ''), code: 551, kind: 'quake',
    kindLabel: own(labelMap, type) || '地震情报',
    severity: severityOfScale(eq.maxScale),
    // 时间统一转成**带偏移**的 ISO 8601（源时区见 DESIGN 第 4 节 / 05d 的 SOURCE_CONTRACTS）。
    // P2PQuake 的时间是裸 JST（"2026/09/07 23:25:14"），不补偏移的话大陆浏览器上会显示成
    // 一个差 1 小时、且没有任何标注的时间；旧历史数据没有偏移，由 formatIssuedLocal 按 JST 解释。
    issued: p2pTimeToIso((raw.issue && raw.issue.time) || raw.time || ''),
    headline,
    maxScale: typeof eq.maxScale === 'number' ? eq.maxScale : -1,
    // 事件级去重键：同一次地震的速报 / 震源 / 详报共享 earthquake.time（551 没有 issue.eventId）
    eventKey: eq.time ? 'quake:' + eq.time : '',
    strength: typeof eq.maxScale === 'number' ? eq.maxScale : -1,
    hypo: { name: hypo.name || '', magnitude: typeof hypo.magnitude === 'number' ? hypo.magnitude : null },
    regions: pts.map((p) => ({
      pref: normalizePref(p.pref),
      area: p.addr || '',
      scale: typeof p.scale === 'number' ? p.scale : -1,
      // isArea=true 的条目是区域名（如「熊本県天草・芦北」），无法对应到具体市区町村；
      // false/缺省才是观测点（如「白河市新白河」），可以做市级收窄。
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
    kindLabel: cancelled ? 'EEW·已取消' : '紧急地震速报（警报）',
    severity: cancelled ? 'info' : 'red',
    issued: p2pTimeToIso((raw.issue && raw.issue.time) || raw.time || ''),
    headline: cancelled ? '本警报已取消' : '震源 ' + (hypo.name || '—') + ' · M' + (typeof hypo.magnitude === 'number' ? hypo.magnitude : '—') + scaleSuffix(maxTo, '预测最大'),
    maxScale: maxTo,
    // EEW 的多报共享 issue.eventId（serial 递增），用它做事件级去重
    eventKey: (raw.issue && raw.issue.eventId) ? 'eew:' + raw.issue.eventId : '',
    strength: maxTo,
    hypo: { name: hypo.name || '', magnitude: typeof hypo.magnitude === 'number' ? hypo.magnitude : null },
    regions: areas.flatMap((a) => regionsOfArea(a.name, a.pref, typeof a.scaleTo === 'number' ? a.scaleTo : -1, 'scale')),
    cancelled,
    raw,
  }
}

function parseTsunami(raw) {
  const cancelled = raw.cancelled === true
  const areas = raw.areas || []
  const lines = areas.map((a) => {
    const hgt = a.maxHeight && a.maxHeight.description ? ' 高' + a.maxHeight.description : ''
    return (a.name || '—') + '：' + (own(TSUNAMI_GRADE_TEXT, a.grade) || a.grade || '—') + hgt
  })
  const worst = areas.reduce((m, a) => Math.max(m, own(TSUNAMI_RANK, a.grade) || 0), 0)
  const anyWarning = worst >= 2
  return {
    id: String(raw.id || raw._id || ''), code: 552, kind: 'tsunami',
    kindLabel: cancelled ? '海啸·已解除' : (worst >= 3 ? '大海啸警报' : (anyWarning ? '海啸警报' : '海啸注意报')),
    severity: cancelled ? 'info' : (worst >= 2 ? 'red' : 'orange'),
    issued: p2pTimeToIso((raw.issue && raw.issue.time) || raw.time || ''),
    headline: cancelled ? '海啸预报已解除' : lines.join('；'),
    maxScale: worst,
    // 海啸预报没有可归并的事件 id（issue 只有 source/time/type），但**绝不能留空**：
    // cancelKeyOf 会退回 kind（'tsunami'），于是任意海域的解除都被当成"此前提醒过的事件"，
    // 播出一条与用户无关的「海啸预报已解除 …此前发出的警报已作废」——海啸域的**假安全**
    // 是最危险的误报。用「预报区名集合」当事件键：只有针对同一批预报区的发布与解除
    // 才归并为同一个事件（区域不一致时匹配不上 → 不提示，安全侧）。
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


export { AREA_PREF, prefsOfArea, regionsOfArea, scaleText, scaleSuffix, sevColor, severityOfScale, parseQuake, parseEew, parseTsunami, parse }
