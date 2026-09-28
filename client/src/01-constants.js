// ============================================================================
// dsh-quake-alert · client/src/01-constants.js
// 全仓库唯一的常量与默认配置来源：震度档位、海啸等级、47 都道府县表、DEFAULT_CFG、存储 key、
// 重连参数、历史上限等。依赖 00-i18n、00d-texts-regions。新的共享常量放这里。
// ============================================================================

// ---------- 依赖 ----------
import React from 'react'
import { LANGS, LANGUAGE_LABELS, getLanguage } from './00-i18n.js'
import { PREF_EN, PREF_HANT } from './00d-texts-regions.js'
const h = React.createElement
const { useState, useEffect, useRef } = React

// ---------- 常量 ----------
const WS_URL = 'wss://api.p2pquake.net/v2/ws'
const SANDBOX_URL = 'wss://api-realtime-sandbox.p2pquake.net/v2/ws'
const EMSC_WS_URL = 'wss://www.seismicportal.eu/standing_order/websocket'
const STORAGE_KEY = 'dsh.quakeAlert.v1'
const HISTORY_KEY = 'dsh.quakeAlert.history'
// 源健康记录：**唯一**一处跨刷新保留的运行时状态，存「某个源的解析在什么时候因为什么失败了」。 连接状态不在这里：重启即重新建连，旧值没有意义。
const HEALTH_KEY = 'dsh.quakeAlert.health'
const ALERTED_KEY = 'dsh.quakeAlert.alerted'
const HISTORY_MAX = 30 // 「最近预警」保留条数（内存与设置页展示）
// 「最近预警」的时间上限，与 HISTORY_MAX 条数上限同时生效、取更严格的
const HISTORY_MAX_AGE_MS = 5 * 24 * 60 * 60 * 1000
const MAX_WATCH_CITIES = 300 // 关注市区町村上限（防止配置与 UI 被撑爆）
const MAX_WATCH_PLACES = 20
const RECONNECT_BASE = 1000 // 重连间隔递增的起点 1s
const RECONNECT_MAX = 60000 // 封顶 60s

const SCALE_TEXT = {
  10: '震度1', 20: '震度2', 30: '震度3', 40: '震度4',
  45: '震度5弱', 46: '震度5弱以上', 50: '震度5强', 55: '震度6弱',
  60: '震度6强', 70: '震度7',
}
// 用户可选的最低震度档位（值 = P2PQuake scale）。labelKey 由渲染时的取词函数解析成各语言文案。
const SCALE_OPTIONS = [
  { v: 10, labelKey: 'scaleOpt.10' }, { v: 20, labelKey: 'scaleOpt.20' }, { v: 30, labelKey: 'scaleOpt.30' },
  { v: 40, labelKey: 'scaleOpt.40' }, { v: 45, labelKey: 'scaleOpt.45' }, { v: 50, labelKey: 'scaleOpt.50' },
  { v: 55, labelKey: 'scaleOpt.55' }, { v: 60, labelKey: 'scaleOpt.60' }, { v: 70, labelKey: 'scaleOpt.70' },
]
const TSUNAMI_RANK = { Watch: 1, Warning: 2, MajorWarning: 3 }
const TSUNAMI_GRADE_TEXT = { Watch: '津波注意报', Warning: '海啸警报', MajorWarning: '大海啸警报' }
const TSUNAMI_OPTIONS = [
  { g: 'Watch', labelKey: 'tsunamiOpt.Watch' },
  { g: 'Warning', labelKey: 'tsunamiOpt.Warning' },
  { g: 'MajorWarning', labelKey: 'tsunamiOpt.MajorWarning' },
]
// 全球源（EMSC / USGS）的最低震级档位，默认取 M4.5
const GLOBAL_MAG_OPTIONS = [
  { v: 3, labelKey: 'magOpt.3' }, { v: 3.5, labelKey: 'magOpt.3.5' }, { v: 4, labelKey: 'magOpt.4' },
  { v: 4.5, labelKey: 'magOpt.4.5' }, { v: 5, labelKey: 'magOpt.5' }, { v: 5.5, labelKey: 'magOpt.5.5' },
  { v: 6, labelKey: 'magOpt.6' }, { v: 6.5, labelKey: 'magOpt.6.5' }, { v: 7, labelKey: 'magOpt.7' },
]
// 大陆速报（cenc_eqlist）的独立门槛：速报覆盖低到 M2.5，不与预警共用
const CN_REPORT_MAG_OPTIONS = [
  { v: 3.5, labelKey: 'magOpt.3.5' }, { v: 4, labelKey: 'magOpt.4' },
  { v: 4.5, labelKey: 'magOpt.4.5' }, { v: 5, labelKey: 'magOpt.5' },
  { v: 5.5, labelKey: 'magOpt.5.5' }, { v: 6, labelKey: 'magOpt.6' },
]

// ---------- 关注点半径 ----------
const RADIUS_PRESETS = [
  { v: 30, labelKey: 'radius.30' },
  { v: 100, labelKey: 'radius.100' },
  { v: 300, labelKey: 'radius.300' },
]
// 新建关注点的默认半径；既有配置里的 radiusKm 一律不动
const DEFAULT_PLACE_RADIUS_KM = 100
// 关注点缺 radiusKm 或值非法时的兜底：取比默认值宽的 300，避免收窄用户已配好的监控范围
const LEGACY_PLACE_RADIUS_KM = 300
const MIN_PLACE_RADIUS_KM = 1
const MAX_PLACE_RADIUS_KM = 2000

// 日本 47 都道府县：jp 为匹配用日文全称（P2PQuake pref 格式），zh 为界面显示
const PREFECTURES = [
  ['北海道', '北海道'], ['青森県', '青森'], ['岩手県', '岩手'], ['宮城県', '宫城'],
  ['秋田県', '秋田'], ['山形県', '山形'], ['福島県', '福岛'], ['茨城県', '茨城'],
  ['栃木県', '栃木'], ['群馬県', '群马'], ['埼玉県', '埼玉'], ['千葉県', '千叶'],
  ['東京都', '东京'], ['神奈川県', '神奈川'], ['新潟県', '新潟'], ['富山県', '富山'],
  ['石川県', '石川'], ['福井県', '福井'], ['山梨県', '山梨'], ['長野県', '长野'],
  ['岐阜県', '岐阜'], ['静岡県', '静冈'], ['愛知県', '爱知'], ['三重県', '三重'],
  ['滋賀県', '滋贺'], ['京都府', '京都'], ['大阪府', '大阪'], ['兵庫県', '兵库'],
  ['奈良県', '奈良'], ['和歌山県', '和歌山'], ['鳥取県', '鸟取'], ['島根県', '岛根'],
  ['岡山県', '冈山'], ['広島県', '广岛'], ['山口県', '山口'], ['徳島県', '德岛'],
  ['香川県', '香川'], ['愛媛県', '爱媛'], ['高知県', '高知'], ['福岡県', '福冈'],
  ['佐賀県', '佐贺'], ['長崎県', '长崎'], ['熊本県', '熊本'], ['大分県', '大分'],
  ['宮崎県', '宫崎'], ['鹿児島県', '鹿儿岛'], ['沖縄県', '冲绳'],
].map(([jp, zh]) => ({ jp, zh }))
const PREF_SET = new Set(PREFECTURES.map((p) => p.jp))
// PREFECTURES 的顺序就是 JIS 码 01..47，而気象庁电文的区域码前两位正是都道府県码。 判县优先用 code 而不是名称：名称有 25 例同名跨县（伊達市 北海道/福島県），已改制的旧名也会认错。
const PREF_BY_CODE = {}
PREFECTURES.forEach((p, i) => { PREF_BY_CODE[String(i + 1).padStart(2, '0')] = p.jp })
/** 区域码 → 都道府県名（取前两位；认不出返回空字符串）。 */
function prefOfCode(code) {
  const s = String(code === undefined || code === null ? '' : code).trim()
  if (!/^\d{4,}$/.test(s)) return ''
  const hit = PREF_BY_CODE[s.slice(0, 2)]
  return hit || ''
}
/** 都道府県名 → 2 位都道府県码（认不出返回空字符串）。 */
function prefCodeOf(pref) {
  const i = PREFECTURES.findIndex((p) => p.jp === pref)
  return i === -1 ? '' : String(i + 1).padStart(2, '0')
}
// 都道府県简写 → 全称：源里的 pref 多半是全称，但出现过「京都」这类简写，不统一成全称就会与用户 勾选的「京都府」永不相等（静默漏报）。只削 県 / 都 / 府——「北海道」本身就是全称。
const PREF_SHORT = {}
for (const p of PREFECTURES) {
  const short = p.jp.replace(/[都府県]$/, '')
  if (short !== p.jp && !Object.prototype.hasOwnProperty.call(PREF_SHORT, short)) PREF_SHORT[short] = p.jp
}
function normalizePref(raw) {
  const s = String(raw === undefined || raw === null ? '' : raw).trim()
  if (!s || PREF_SET.has(s)) return s
  return Object.prototype.hasOwnProperty.call(PREF_SHORT, s) ? PREF_SHORT[s] : s
}

/** 都道府県的**显示名**（随界面语言变）：日文用原名，简体用 PREFECTURES[].zh，繁体用 PREF_HANT， 英文用 PREF_EN；`jp` 那一栏是匹配用的形状，显示不能复用它。认不出的原样返回。 */
function prefLabelOf(pref) {
  const s = String(pref === undefined || pref === null ? '' : pref).trim()
  if (!s) return ''
  const hit = PREFECTURES.find((p) => p.jp === s)
  if (!hit) return s
  const lang = getLanguage()
  if (lang === 'ja') return hit.jp
  if (lang === 'en') return PREF_EN[hit.jp] || hit.jp
  // 繁体缺项时回退到**日文原名**，与 en 分支同形：回退到 `hit.zh` 会在繁体界面里混进简体字形
  if (lang === 'zh-TW') return PREF_HANT[hit.jp] || hit.jp
  return hit.zh
}

// ---------- 时间：源时区 → 带偏移的 ISO 8601 ----------
// P2PQuake 与 Wolfx 给的时间串**自己不带时区**，解析器负责补成带偏移的 ISO 8601，UI 只按本地
// 时区渲染；其余源本身是绝对时间（JMA 带 +09:00、USGS 是 epoch 毫秒、EMSC 带 Z、NOAA 的 <sent>
// 带偏移）。历史里带不了偏移的旧数据一律按 JST 解释。
const P2P_TZ_OFFSET = '+09:00'
const P2P_TIME_RE = /^(\d{4})\/(\d{2})\/(\d{2})[ T](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?$/
/** P2PQuake 的裸 JST 时间串 → 带 +09:00 偏移的 ISO 8601；认不出时**原样返回**（绝不丢信息）。 */
function p2pTimeToIso(raw) {
  const s = String(raw === undefined || raw === null ? '' : raw).trim()
  if (!s) return ''
  const m = P2P_TIME_RE.exec(s)
  if (!m) return s
  const ms = m[7] ? m[7].padEnd(3, '0').slice(0, 3) : ''
  return m[1] + '-' + m[2] + '-' + m[3] + 'T' + m[4] + ':' + m[5] + ':' + m[6] +
    (ms ? '.' + ms : '') + P2P_TZ_OFFSET
}
// Wolfx 的 cenc_eew / cenc_eqlist 给的是裸北京时间，与中国全境单一时区、无夏令时，偏移恒为 +08:00
const CN_TZ_OFFSET = '+08:00'
const CN_TIME_RE = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?$/
/** 大陆源的裸北京时间串 → 带 +08:00 偏移的 ISO 8601；认不出时**原样返回**（绝不丢信息）。 */
function cnTimeToIso(raw) {
  const s = String(raw === undefined || raw === null ? '' : raw).trim()
  if (!s) return ''
  const m = CN_TIME_RE.exec(s)
  if (!m) return s
  const ms = m[7] ? m[7].padEnd(3, '0').slice(0, 3) : ''
  return m[1] + '-' + m[2] + '-' + m[3] + 'T' + m[4] + ':' + m[5] + ':' + m[6] +
    (ms ? '.' + ms : '') + CN_TZ_OFFSET
}
/** 时间串 → Date。JST 串与北京串看起来只差分隔符，所以按各自的正则分别补偏移，不能只判一种。 */
function issuedToDate(raw) {
  const s = String(raw === undefined || raw === null ? '' : raw).trim()
  if (!s) return null
  const d = new Date(P2P_TIME_RE.test(s) ? p2pTimeToIso(s) : (CN_TIME_RE.test(s) ? cnTimeToIso(s) : s))
  return Number.isFinite(d.getTime()) ? d : null
}
/** 时间串 → 本地时区文案（历史详情用）；无法解析时原样返回，不把原文弄丢。 */
function formatIssuedLocal(raw) {
  const d = issuedToDate(raw)
  if (!d) return String(raw === undefined || raw === null ? '' : raw)
  try {
    return new Intl.DateTimeFormat(undefined, {
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
    }).format(d)
  } catch (err) { return d.toISOString() }
}

// ---------- 界面语言 ----------
// 选项从 00-i18n 的语言清单派生：加一种语言只改 00-i18n 与文案表，配置契约一行都不用动
const LANGUAGE_OPTIONS = LANGS.map((v) => ({ v, label: LANGUAGE_LABELS[v] }))

const DEFAULT_CFG = {
  version: 1,
  source: 'prod', // prod | sandbox（沙箱回放 2023 年历史，约30秒/条，测试用）
  // auto = SSE 优先、走不通自动降级为轮询；poll = 用户强制轮询
  cnTransport: 'auto',
  // 两种关注模式并存，互不影响（日本用户不用配 places，全球用户不用配 prefectures）： · 行政区（prefectures / cities）——日本源用，粒度到市区町村 · 坐标点（places）——全球源用，判定「震中距 ≤ radiusKm」
  watch: { prefectures: [], cities: [], places: [] },
  disasters: { earthquake: true, tsunami: true, weather: true, cnRainstorm: true, cnGeology: true, overseasWeather: true }, // weather = 日本气象灾害（泥石流 / 洪水 / 大雨 / 高潮…），固定 L4 以上播报；cnRainstorm / cnGeology = 中国大陆气象灾害（0.5.2），固定橙色以上播报；overseasWeather = 海外气象灾害（0.6.0，美国 NWS + 加拿大 ECCC），一个开关覆盖两个"按关注点生效"的源
  // globalMagnitude：全球源（EMSC / USGS）的最低震级；cnReportMagnitude：大陆速报的独立门槛 （大陆地震预警与全球源共用 globalMagnitude——同样是"只有震级、没有分区烈度"的坐标型源）
  thresholds: {
    quakeScale: 40, eewScale: 45, tsunamiGrade: 'Watch',
    globalMagnitude: 4.5, cnReportMagnitude: 4.5,
  },
  notify: { sound: true, system: true, volume: 0.7, soundQuake: true, soundTsunami: true, soundWeather: true },
  dedupe: { windowMinutes: 10 },
  // 静默时段：按浏览器本地时间判定；跨午夜用 start > end 表示（如 23:00–07:00）
  quietHours: { enabled: false, start: '23:00', end: '07:00', breakForSevere: true },
  // 界面语言。**必须留在末尾**：Host schema 的字段顺序要与此一致——"Host 默认值与 Client DEFAULT_CFG 完全一致"的断言是 JSON.stringify 全量比较，顺序不同就会红。
  language: 'zh-CN',
}


export { React, h, useState, useEffect, useRef, WS_URL, SANDBOX_URL, EMSC_WS_URL, STORAGE_KEY, HISTORY_KEY, HEALTH_KEY, ALERTED_KEY, HISTORY_MAX, HISTORY_MAX_AGE_MS, MAX_WATCH_CITIES, MAX_WATCH_PLACES, RECONNECT_BASE, RECONNECT_MAX, SCALE_TEXT, SCALE_OPTIONS, TSUNAMI_RANK, TSUNAMI_GRADE_TEXT, TSUNAMI_OPTIONS, GLOBAL_MAG_OPTIONS, CN_REPORT_MAG_OPTIONS, RADIUS_PRESETS, DEFAULT_PLACE_RADIUS_KM, MIN_PLACE_RADIUS_KM, MAX_PLACE_RADIUS_KM, LEGACY_PLACE_RADIUS_KM, LANGUAGE_OPTIONS, PREFECTURES, PREF_SET, PREF_SHORT, PREF_BY_CODE, prefOfCode, prefCodeOf, normalizePref, prefLabelOf, P2P_TZ_OFFSET, P2P_TIME_RE, p2pTimeToIso, CN_TZ_OFFSET, CN_TIME_RE, cnTimeToIso, issuedToDate, formatIssuedLocal, DEFAULT_CFG }
