window.__ModuleLoader__.load({ id: "dsh-quake-alert", factory: (require) => {
var module = { exports: {} }; var exports = module.exports;
'use strict'

/**
 * dsh-quake-alert client (M1)
 *
 * 灾害预警：用户使用 DSH 时，P2PQuake WebSocket 实时推送日本地震/海啸信息，
 * 按「关注都道府县 + 震度/海啸等级阈值」匹配命中后提醒：
 *   - 页面可见 → 右上角 toast + 提示音；页面后台 → 系统通知 + 提示音
 *   - 设置页：设置 → 灾害预警（关注地区/阈值/提示音/音量/测试），localStorage 持久化
 *   - 免责：数据为 P2PQuake 转播，EEW 等仅供参考，请以气象厅官方发布为准
 *
 * 单文件（DSH 模块加载器格式），无外部依赖。解析/匹配纯函数经 exports.__test 暴露。
 */

// ---------- 依赖 ----------
const React = require('react')
const h = React.createElement
const { useState, useEffect } = React

// ---------- 常量 ----------
const WS_URL = 'wss://api.p2pquake.net/v2/ws'
const SANDBOX_URL = 'wss://api-realtime-sandbox.p2pquake.net/v2/ws'
const STORAGE_KEY = 'dsh.quakeAlert.v1'
const HISTORY_KEY = 'dsh.quakeAlert.history'
const HISTORY_MAX = 30 // 「最近预警」保留条数（内存与设置页展示）
const RECONNECT_BASE = 1000 // 指数退避起点 1s
const RECONNECT_MAX = 60000 // 封顶 60s

const SCALE_TEXT = {
  10: '震度1', 20: '震度2', 30: '震度3', 40: '震度4',
  45: '震度5弱', 46: '震度5弱以上', 50: '震度5强', 55: '震度6弱',
  60: '震度6强', 70: '震度7',
}
// 用户可选的最低震度档位（值 = P2PQuake scale 数值）
const SCALE_OPTIONS = [
  { v: 10, label: '震度1 以上' }, { v: 20, label: '震度2 以上' }, { v: 30, label: '震度3 以上' },
  { v: 40, label: '震度4 以上' }, { v: 45, label: '震度5弱 以上' }, { v: 50, label: '震度5强 以上' },
  { v: 55, label: '震度6弱 以上' }, { v: 60, label: '震度6强 以上' }, { v: 70, label: '震度7' },
]
const TSUNAMI_RANK = { Watch: 1, Warning: 2, MajorWarning: 3 }
const TSUNAMI_GRADE_TEXT = { Watch: '津波注意报', Warning: '海啸警报', MajorWarning: '大海啸警报' }
const TSUNAMI_OPTIONS = [
  { g: 'Watch', label: '注意报及以上' }, { g: 'Warning', label: '警报及以上' }, { g: 'MajorWarning', label: '仅大海啸警报' },
]

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

const DEFAULT_CFG = {
  version: 1,
  source: 'prod', // prod | sandbox（沙箱回放 2023 年历史，约30秒/条，测试用）
  watch: { prefectures: [] }, // 空 = 关注全日本（阈值仍生效）
  disasters: { earthquake: true, tsunami: true },
  thresholds: { quakeScale: 40, eewScale: 45, tsunamiGrade: 'Watch' },
  notify: { sound: true, system: true, volume: 0.7 },
  dedupe: { windowMinutes: 10 },
}

// ---------- 存储（localStorage） ----------
// 读入的数据可能被旧版本、其它脚本或用户手工改坏。所有读入都做类型校验，
// 任何异常都退回默认值——一条脏数据绝不能把整个插件拖崩（曾因 history 非数组
// 触发 loadJSON(...).slice is not a function，导致模块加载失败、设置页与连接全部消失）。
const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)
const numOr = (v, fallback, min, max) => {
  if (typeof v !== 'number' || !Number.isFinite(v)) return fallback
  if (typeof min === 'number' && v < min) return min
  if (typeof max === 'number' && v > max) return max
  return v
}
const boolOr = (v, fallback) => (typeof v === 'boolean' ? v : fallback)

function loadJSON(key, fallback) {
  try {
    const s = window.localStorage.getItem(key)
    if (!s) return fallback
    const v = JSON.parse(s)
    return v === null || v === undefined ? fallback : v
  } catch (err) {
    return fallback
  }
}
function saveJSON(key, value) {
  try { window.localStorage.setItem(key, JSON.stringify(value)) } catch (err) { /* 容量/隐私模式忽略 */ }
}
// 历史记录必须是「对象数组」：渲染层会读 e.key / e.headline，元素为 null 会直接抛错
function loadHistory() {
  const v = loadJSON(HISTORY_KEY, null)
  if (!Array.isArray(v)) return []
  return v.filter((e) => isPlainObject(e)).slice(0, HISTORY_MAX)
}
// 每次都返回全新对象：避免调用方改动嵌套字段时污染 DEFAULT_CFG 常量
const freshCfg = () => ({
  version: DEFAULT_CFG.version,
  source: DEFAULT_CFG.source,
  watch: { prefectures: [] },
  disasters: { ...DEFAULT_CFG.disasters },
  thresholds: { ...DEFAULT_CFG.thresholds },
  notify: { ...DEFAULT_CFG.notify },
  dedupe: { ...DEFAULT_CFG.dedupe },
})
function loadCfg() {
  const stored = loadJSON(STORAGE_KEY, null)
  if (!isPlainObject(stored) || stored.version !== DEFAULT_CFG.version) {
    const fresh = freshCfg()
    saveJSON(STORAGE_KEY, fresh)
    return fresh
  }
  const w = isPlainObject(stored.watch) ? stored.watch : {}
  const d = isPlainObject(stored.disasters) ? stored.disasters : {}
  const t = isPlainObject(stored.thresholds) ? stored.thresholds : {}
  const n = isPlainObject(stored.notify) ? stored.notify : {}
  const de = isPlainObject(stored.dedupe) ? stored.dedupe : {}
  return {
    version: DEFAULT_CFG.version,
    source: stored.source === 'sandbox' ? 'sandbox' : 'prod',
    watch: {
      // 只保留 47 县中确实存在的名字，避免脏数据在设置页渲染出幽灵按钮
      prefectures: Array.isArray(w.prefectures)
        ? Array.from(new Set(w.prefectures.filter((p) => typeof p === 'string' && PREF_SET.has(p))))
        : [],
    },
    disasters: {
      earthquake: boolOr(d.earthquake, DEFAULT_CFG.disasters.earthquake),
      tsunami: boolOr(d.tsunami, DEFAULT_CFG.disasters.tsunami),
    },
    thresholds: {
      quakeScale: numOr(t.quakeScale, DEFAULT_CFG.thresholds.quakeScale, 0, 70),
      eewScale: numOr(t.eewScale, DEFAULT_CFG.thresholds.eewScale, 0, 70),
      // 白名单校验，同时避免 'constructor' 之类的原型链键被当成合法等级
      tsunamiGrade: TSUNAMI_OPTIONS.some((o) => o.g === t.tsunamiGrade)
        ? t.tsunamiGrade
        : DEFAULT_CFG.thresholds.tsunamiGrade,
    },
    notify: {
      sound: boolOr(n.sound, DEFAULT_CFG.notify.sound),
      system: boolOr(n.system, DEFAULT_CFG.notify.system),
      volume: numOr(n.volume, DEFAULT_CFG.notify.volume, 0, 1),
    },
    dedupe: {
      windowMinutes: numOr(de.windowMinutes, DEFAULT_CFG.dedupe.windowMinutes, 1, 1440),
    },
  }
}
function saveCfg(cfg) {
  const next = { ...cfg, version: DEFAULT_CFG.version }
  saveJSON(STORAGE_KEY, next)
  return next
}

// ---------- 解析器：P2PQuake code → Alert ----------
// Alert = { id, code, kind, kindLabel, severity, issued, headline, second,
//           regions:[{pref, area, scale?, grade?}], cancelled,
//           eventKey, strength }  // eventKey 归并同一地震的多次发布，strength 用于强度升级判定
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
// 安全字典查找：外部数据里的 'constructor'/'toString' 等键会命中原型链，
// 例如 AREA_PREF['constructor'] 会返回 Object 构造函数并让 .slice() 抛错
const own = (map, key) => (Object.prototype.hasOwnProperty.call(map, key) ? map[key] : undefined)

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
// 单值兼容包装：无法归一时保留原名
function prefOfName(name) {
  const list = prefsOfArea(name)
  return list.length ? list[0] : String(name || '')
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
const unique = (arr) => Array.from(new Set(arr.filter(Boolean)))
const scaleText = (v) => own(SCALE_TEXT, v) || (typeof v === 'number' && v > 0 ? '震度' + Math.floor(v / 10) : '未公布')
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
  const headline = hasHypo
    ? '震源 ' + hypo.name + ' · M' + (typeof hypo.magnitude === 'number' ? hypo.magnitude : '—')
    : (own(labelMap, type) || '地震情报')
  const second = '最大震度 ' + scaleText(eq.maxScale)
  return {
    id: String(raw.id || raw._id || ''), code: 551, kind: 'quake',
    kindLabel: own(labelMap, type) || '地震情报',
    severity: severityOfScale(eq.maxScale),
    issued: (raw.issue && raw.issue.time) || raw.time || '',
    headline, second,
    maxScale: typeof eq.maxScale === 'number' ? eq.maxScale : -1,
    // 事件级去重键：同一次地震的速报 / 震源 / 详报共享 earthquake.time（551 没有 issue.eventId）
    eventKey: eq.time ? 'quake:' + eq.time : '',
    strength: typeof eq.maxScale === 'number' ? eq.maxScale : -1,
    hypo: { name: hypo.name || '', magnitude: typeof hypo.magnitude === 'number' ? hypo.magnitude : null },
    regions: pts.map((p) => ({ pref: p.pref || '', area: p.addr || '', scale: typeof p.scale === 'number' ? p.scale : -1 })),
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
    issued: (raw.issue && raw.issue.time) || raw.time || '',
    headline: cancelled ? '本警报已取消' : '震源 ' + (hypo.name || '—') + ' · M' + (typeof hypo.magnitude === 'number' ? hypo.magnitude : '—'),
    second: cancelled ? '' : '预测最大震度 ' + scaleText(maxTo) + ' · 覆盖 ' + areas.length + ' 个区域',
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
    issued: (raw.issue && raw.issue.time) || raw.time || '',
    headline: cancelled ? '海啸预报已解除' : lines.join('；'),
    second: areas.length + ' 个海啸预报区',
    maxScale: worst,
    // 海啸预报没有可归并的事件 id（issue 只有 source/time/type），保持逐条判定
    eventKey: '',
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

// ---------- 匹配引擎 ----------
// watch.prefectures 为空 → 关注全日本
function regionInWatch(region, watch) {
  const list = watch && watch.prefectures
  if (!list || list.length === 0) return true
  return list.indexOf(region.pref) !== -1
}

// 未命中原因：若存在未能识别归属县的区域名，明确提示，避免用户误以为链路故障
function missReason(alert, watch, base) {
  const list = watch && watch.prefectures
  if (list && list.length > 0) {
    const unknown = alert.regions.filter((r) => !r.pref).length
    if (unknown > 0) return base + '（另有 ' + unknown + ' 个区域名未能识别归属县）'
  }
  return base
}

function matchAlert(alert, cfg) {
  const w = cfg.watch || {}
  const t = cfg.thresholds || {}
  if (alert.kind === 'eew' || alert.kind === 'quake') {
    if ((cfg.disasters || {}).earthquake === false) return { hit: false, reason: '地震提醒已关闭' }
    if (alert.cancelled) return { hit: false, reason: '取消消息不提醒' }
    // 551 的「震源情报 / 远地地震」没有 points，无从按震度判定——明确说明，避免用户误以为链路故障
    if (alert.regions.length === 0) return { hit: false, reason: '本条为震源情报，无震度数据，无法按阈值判定' }
    const threshold = alert.kind === 'eew' ? t.eewScale : t.quakeScale
    const hitRegion = alert.regions.find((r) => regionInWatch(r, w) && typeof r.scale === 'number' && r.scale >= threshold)
    return hitRegion
      ? { hit: true, reason: alert.kind === 'eew' ? 'EEW 预测震度达标' : '观测震度达标', region: hitRegion }
      : { hit: false, reason: missReason(alert, w, '关注地区未命中或强度低于阈值') }
  }
  if (alert.kind === 'tsunami') {
    if ((cfg.disasters || {}).tsunami === false) return { hit: false, reason: '海啸提醒已关闭' }
    if (alert.cancelled) return { hit: false, reason: '解除消息不提醒' }
    if (alert.regions.length === 0) return { hit: false, reason: '本条没有海啸预报区数据' }
    const minRank = own(TSUNAMI_RANK, t.tsunamiGrade) || 1
    const hitRegion = alert.regions.find((r) => regionInWatch(r, w) && (own(TSUNAMI_RANK, r.grade) || 0) >= minRank)
    return hitRegion
      ? { hit: true, reason: '海啸等级达标', region: hitRegion }
      : { hit: false, reason: missReason(alert, w, '关注地区未命中或等级低于阈值') }
  }
  return { hit: false, reason: '不支持的 code' }
}

// ---------- 全局 store：连接状态 + 最近预警（设置页订阅） ----------
const store = {
  status: 'idle', // idle | connecting | open | reconnecting | closed
  retries: 0,
  detail: '',
  received: 0, // 收到并成功解析的推送条数（诊断用）
  events: loadHistory(), // 最近预警 [{kind,label,severity,issued,headline,pref}]
  listeners: new Set(),
  push(patch) {
    Object.assign(this, patch)
    this.listeners.forEach((fn) => fn())
  },
  subscribe(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn) },
}
let anonSeq = 0 // 兜底：无 id 消息用递增匿名 key，避免空 id 互相覆盖
function addEvent(ev) {
  const hasId = ev && ev.id && ev.id !== ''
  const key = hasId ? ev.id : ('anon-' + (++anonSeq))
  const item = Object.assign({}, ev, { key })
  store.events = [item].concat(store.events.filter((e) => e.key !== key)).slice(0, HISTORY_MAX)
  saveJSON(HISTORY_KEY, store.events.slice(0, HISTORY_MAX))
  store.push({})
}

// ---------- 音频（Web Audio 合成，零文件） ----------
let audioCtx = null
function ensureAudio() {
  if (audioCtx === null && typeof window !== 'undefined') {
    const Ctor = window.AudioContext || window.webkitAudioContext
    if (Ctor) { try { audioCtx = new Ctor() } catch (err) { audioCtx = null } }
  }
  return audioCtx
}
function unlockAudio() {
  const ctx = ensureAudio()
  if (ctx && ctx.state === 'suspended') ctx.resume().catch(() => {})
}
// 音色描述：notes 列表（freq Hz / start s / dur s / type）
const SOUNDS = {
  eew: { notes: [
    { freq: 932, start: 0, dur: 0.12, type: 'square' },
    { freq: 932, start: 0.22, dur: 0.12, type: 'square' },
    { freq: 1244, start: 0.44, dur: 0.5, type: 'square' },
  ] },
  tsunami: { notes: [
    { freq: 196, start: 0, dur: 0.9, type: 'sawtooth' },
    { freq: 147, start: 0.7, dur: 1.1, type: 'sawtooth' },
  ] },
  quake: { notes: [
    { freq: 659, start: 0, dur: 0.18, type: 'sine' },
    { freq: 880, start: 0.2, dur: 0.3, type: 'sine' },
  ] },
  test: { notes: [
    { freq: 784, start: 0, dur: 0.16, type: 'sine' },
    { freq: 1046, start: 0.18, dur: 0.3, type: 'sine' },
  ] },
}
function playSound(kind, volume) {
  const preset = SOUNDS[kind] || SOUNDS.test
  const ctx = ensureAudio()
  if (!ctx) return
  const vol = typeof volume === 'number' && volume >= 0 && volume <= 1 ? volume : 0.7
  const doPlay = () => {
    const master = ctx.createGain()
    master.gain.value = vol * 0.5
    master.connect(ctx.destination)
    const t0 = ctx.currentTime
    for (const n of preset.notes) {
      const osc = ctx.createOscillator()
      const g = ctx.createGain()
      osc.type = n.type || 'sine'
      osc.frequency.value = n.freq
      const start = t0 + n.start
      g.gain.setValueAtTime(0.0001, start)
      g.gain.exponentialRampToValueAtTime(1, start + 0.02)
      g.gain.setValueAtTime(1, start + n.dur - 0.08)
      g.gain.exponentialRampToValueAtTime(0.0001, start + n.dur)
      osc.connect(g); g.connect(master)
      osc.start(start); osc.stop(start + n.dur + 0.05)
    }
  }
  if (ctx.state === 'suspended') ctx.resume().then(() => { if (ctx.state === 'running') doPlay() }).catch(() => {})
  else doPlay()
}
function playAlertSound(alert, volume) {
  const kind = alert.kind === 'eew' ? 'eew' : (alert.kind === 'tsunami' ? (alert.maxScale >= 3 ? 'tsunami' : 'quake') : 'quake')
  playSound(kind, volume)
}

// ---------- 通知：系统通知 + toast ----------
function notificationSupported() { return typeof window !== 'undefined' && typeof window.Notification === 'function' }
function notificationPermission() {
  if (!notificationSupported()) return 'unsupported'
  return window.Notification.permission
}
function requestNotificationPermission() {
  if (!notificationSupported()) return Promise.resolve('unsupported')
  try { return Promise.resolve(window.Notification.requestPermission()) } catch (err) { return Promise.resolve('denied') }
}
function showSystemNotification(opts) {
  if (!notificationSupported() || window.Notification.permission !== 'granted') return false
  try {
    // eslint-disable-next-line no-new
    new window.Notification(opts.title, {
      body: opts.body || '',
      tag: opts.tag || 'quake-alert',
      icon: opts.icon,
      silent: Boolean(opts.silent),
    })
    return true
  } catch (err) { return false }
}
let toastSeq = 0
function showToast(opts) {
  try {
    if (!window.document || !window.document.body) return
    const doc = window.document
    const el = doc.createElement('div')
    const id = 'quake-alert-toast-' + (++toastSeq)
    el.id = id
    const color = opts.color || '#e5484d'
    const style = el.style
    style.position = 'fixed'
    style.top = '16px'
    style.right = '16px'
    style.zIndex = '2000' // 高于 DSH 前端自身的层级（最高约 1100），但不再用 2^31-1 压住一切
    style.maxWidth = '340px'
    style.background = 'rgba(24,25,30,0.97)'
    style.color = '#e8e8ea'
    style.border = '1px solid ' + color
    style.borderLeft = '4px solid ' + color
    style.borderRadius = '10px'
    style.padding = '10px 14px'
    style.font = '13px/1.5 system-ui, sans-serif'
    style.boxShadow = '0 6px 24px rgba(0,0,0,0.45)'
    style.cursor = 'pointer'
    style.opacity = '0'
    style.transition = 'opacity .18s ease'
    const title = doc.createElement('div')
    title.style.fontWeight = '700'
    title.style.color = color
    title.textContent = opts.title || ''
    const body = doc.createElement('div')
    body.style.marginTop = '3px'
    body.style.whiteSpace = 'pre-wrap'
    body.style.wordBreak = 'break-word'
    body.textContent = opts.body || ''
    el.appendChild(title); el.appendChild(body)
    el.addEventListener('click', () => { try { doc.body.removeChild(el) } catch (err) {} })
    doc.body.appendChild(el)
    requestAnimationFrame(() => { el.style.opacity = '1' })
    const ttl = opts.ttlMs || 8000
    setTimeout(() => {
      el.style.opacity = '0'
      setTimeout(() => { try { if (el.parentNode) el.parentNode.removeChild(el) } catch (err) {} }, 220)
    }, ttl)
  } catch (err) { /* DOM 不可用忽略 */ }
}

// ---------- 去重 ----------
// 三层：① 消息 id（防重连重放）② 事件键（同一地震的多次发布）③ 跨标签页（多开 DSH 页面）
const seen = new Map() // id -> ts
function isDuplicate(id, windowMinutes) {
  if (!id) return false
  const now = Date.now()
  const win = Math.max(1, windowMinutes || 10) * 60 * 1000
  for (const [k, v] of seen) if (now - v > win) seen.delete(k)
  if (seen.has(id)) return true
  seen.set(id, now)
  return false
}
// 同一次地震会连发「震度速报 → 震源情报 → 各地震度」或 EEW 多报（serial 递增）。
// 这些消息 id 各不相同，但共享事件键；只有强度升级时才再提醒一次，避免连续响铃。
const eventSeen = new Map() // eventKey -> { ts, strength }
function isEventRepeat(alert, windowMinutes) {
  if (!alert.eventKey) return false
  const now = Date.now()
  const win = Math.max(1, windowMinutes || 10) * 60 * 1000
  for (const [k, v] of eventSeen) if (now - v.ts > win) eventSeen.delete(k)
  const prev = eventSeen.get(alert.eventKey)
  if (prev && alert.strength <= prev.strength) return true
  eventSeen.set(alert.eventKey, { ts: now, strength: alert.strength })
  return false
}
// 多开 DSH 页面时每个标签页都会收到同一条推送；用 BroadcastChannel 协商，只让一个标签页播报。
// 通道必须在插件加载时就建立监听（见 apply），否则后加载的标签页会错过先到的广播。
// 不支持 BroadcastChannel 时退化为「各标签页各自提醒」，不影响正确性。
const TAB_DEDUPE_MS = 5000
const tabAlerted = new Map() // key -> ts
let alertChannel = null
function ensureAlertChannel() {
  if (alertChannel !== null || typeof window === 'undefined' || typeof window.BroadcastChannel !== 'function') return alertChannel
  try {
    alertChannel = new window.BroadcastChannel('dsh-quake-alert')
    alertChannel.onmessage = (ev) => {
      const d = ev && ev.data
      if (d && d.type === 'alerted' && d.key) tabAlerted.set(String(d.key), Date.now())
    }
  } catch (err) { alertChannel = null }
  return alertChannel
}
function claimAlertForTab(key) {
  if (!key) return true
  const now = Date.now()
  for (const [k, v] of tabAlerted) if (now - v > TAB_DEDUPE_MS) tabAlerted.delete(k)
  if (tabAlerted.has(key)) return false
  tabAlerted.set(key, now)
  if (ensureAlertChannel()) {
    try { alertChannel.postMessage({ type: 'alerted', key }) } catch (err) { /* 通道已关闭等忽略 */ }
  }
  return true
}

// ---------- 主链：收到消息 ----------
function handleRaw(raw, cfg) {
  const alert = parse(raw)
  if (!alert) return
  store.received += 1
  if (isDuplicate(alert.id, cfg.dedupe.windowMinutes)) return
  const m = matchAlert(alert, cfg)
  if (!m.hit) {
    // 不打扰：仅在设置页历史记录里记为"未命中"，便于用户核对配置
    addEvent({
      id: alert.id, kind: alert.kind, label: alert.kindLabel, severity: alert.severity,
      issued: alert.issued, headline: alert.headline + '（未命中：' + m.reason + '）', hit: false,
    })
    return
  }
  const hitPref = m.region ? m.region.pref : ''
  // 同一次地震的后续发布（速报 → 震源 → 各地震度、或 EEW 多报）强度未升级 → 只更新历史，不再响铃
  if (isEventRepeat(alert, cfg.dedupe.windowMinutes)) {
    addEvent({
      id: alert.id, kind: alert.kind, label: alert.kindLabel, severity: alert.severity,
      issued: alert.issued, headline: alert.headline, hit: true, pref: hitPref,
      suppressed: true, suppressedReason: '同一地震的后续发布（强度未升级）',
    })
    return
  }
  // 其它 DSH 标签页已经播报过同一条消息 → 本标签页静默，避免多个页面同时响铃。
  // 用消息 id 而不是事件键：多标签页收到的是同一条消息，而同一事件的不同消息（如强度升级）不应被拦。
  if (!claimAlertForTab(alert.id)) {
    addEvent({
      id: alert.id, kind: alert.kind, label: alert.kindLabel, severity: alert.severity,
      issued: alert.issued, headline: alert.headline, hit: true, pref: hitPref,
      suppressed: true, suppressedReason: '其它 DSH 标签页已提醒',
    })
    return
  }
  const prefZh = (PREFECTURES.find((p) => p.jp === hitPref) || {}).zh || hitPref
  const title = {
    eew: '⚠ 紧急地震速报（警报）',
    quake: '🌐 地震情报 · ' + (alert.kindLabel.indexOf('各地') !== -1 ? '各地震度' : ''),
    tsunami: '🌊 ' + alert.kindLabel,
  }[alert.kind] || '灾害预警'
  const bodyLines = [alert.headline]
  if (hitPref) bodyLines.push('命中关注地区：' + prefZh + (prefZh !== hitPref ? '（' + hitPref + '）' : ''))
  if (alert.kind === 'tsunami') bodyLines.push('请立即远离海岸与河口')
  bodyLines.push('—— 仅供参考，请以气象厅官方发布为准')
  addEvent({
    id: alert.id, kind: alert.kind, label: alert.kindLabel, severity: alert.severity,
    issued: alert.issued, headline: alert.headline, hit: true, pref: hitPref,
  })
  const vol = cfg.notify.volume
  if (cfg.notify.sound !== false) playAlertSound(alert, vol)
  const pageVisible = typeof document !== 'undefined' && document.visibilityState === 'visible'
  const body = bodyLines.join('\n')
  if (pageVisible) {
    showToast({ title, body, color: alert.severity === 'red' ? '#e5484d' : (alert.severity === 'orange' ? '#f76b15' : '#3b82f6') })
    if (cfg.notify.system) {
      const ok = showSystemNotification({ title, body, tag: 'quake-alert-' + alert.id, silent: true })
      if (!ok) showToast({ title, body, color: '#f76b15', ttlMs: 20000 })
    }
  } else if (cfg.notify.system) {
    const ok = showSystemNotification({ title, body, tag: 'quake-alert-' + alert.id, silent: true })
    if (!ok) showToast({ title, body, color: '#f76b15', ttlMs: 20000 })
  }
}

// ---------- WebSocket 客户端 ----------
function createWsClient() {
  let ws = null
  let timer = null
  let stopped = false
  let retries = 0
  const scheduleReconnect = () => {
    if (stopped) return
    retries += 1 // 从「第 1 次」开始计数，退避序列 1s → 2s → 4s → … → 60s 封顶
    store.push({ status: 'reconnecting', retries, detail: '连接断开，正在重连（第 ' + retries + ' 次）' })
    const delay = Math.min(RECONNECT_MAX, RECONNECT_BASE * Math.pow(2, retries - 1))
    timer = setTimeout(connect, delay)
  }
  const connect = () => {
    if (stopped) return
    const url = loadCfg().source === 'sandbox' ? SANDBOX_URL : WS_URL
    store.push({ status: 'connecting', retries, detail: '正在连接 ' + url })
    try { ws = new window.WebSocket(url) } catch (err) {
      scheduleReconnect()
      return
    }
    ws.onopen = () => {
      retries = 0
      const openDetail = url.indexOf('sandbox') !== -1
        ? '沙箱源：回放 2023 年历史（约30秒/条）'
        : '已连接 P2PQuake（约每 10 分钟自动重连）'
      store.push({ status: 'open', retries: 0, detail: openDetail })
    }
    ws.onmessage = (ev) => {
      try {
        const raw = JSON.parse(String(ev.data))
        handleRaw(raw, loadCfg())
      } catch (err) { /* 单条解析失败不影响连接 */ }
    }
    ws.onerror = () => { /* onclose 统一处理 */ }
    ws.onclose = () => scheduleReconnect()
  }
  const teardown = () => {
    if (timer) { clearTimeout(timer); timer = null }
    if (ws) { try { ws.onclose = null; ws.close() } catch (err) {} ws = null }
  }
  return {
    start() { connect() },
    stop() {
      stopped = true
      teardown()
      store.push({ status: 'closed', retries, detail: '已停止（插件停用）' })
    },
    restart() {
      stopped = false
      retries = 0 // 切数据源后立即从 1s 退避重新开始，而不是沿用上一条连接的退避进度
      teardown()
      connect()
    },
  }
}

let activeClient = null

// ---------- 设置页 UI ----------
const s = {
  section: (title, ...children) => h('div', { style: { padding: '14px 16px', borderBottom: '1px solid rgba(148,163,184,0.14)' } },
    h('div', { style: { fontWeight: 700, fontSize: 13, marginBottom: 10, color: '#dfe3e8' } }, title), ...children),
  label: (text) => h('div', { style: { color: '#9aa0a6', fontSize: 12, marginBottom: 4 } }, text),
  row: (...children) => h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', margin: '4px 0' } }, ...children),
  checkbox: (checked, onChange, text, color) => h('label', { style: { display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, cursor: 'pointer', color: '#dfe3e8' } },
    h('input', { type: 'checkbox', checked, onChange: (e) => onChange(e.target.checked) }), text),
  select: (value, options, onChange, textOf) => h('select', {
    value, onChange: (e) => onChange(e.target.value),
    style: { background: '#ffffff', color: '#1a1a1a', border: '1px solid #6b7280', borderRadius: 6, padding: '4px 8px', fontSize: 12, minWidth: 180 },
  }, options.map((o) => h('option', {
    key: String(o.v !== undefined ? o.v : o.g), value: String(o.v !== undefined ? o.v : o.g),
    style: { background: '#ffffff', color: '#1a1a1a' },
  }, textOf(o)))),
  btn: (text, onClick, extra) => h('button', {
    onClick,
    style: Object.assign({ background: 'rgba(148,163,184,0.12)', color: 'inherit', border: '1px solid rgba(148,163,184,0.35)', borderRadius: 6, padding: '5px 12px', cursor: 'pointer', fontSize: 12 }, extra || {}),
  }, text),
}

function SettingsPanel() {
  const [cfg, setCfgState] = useState(() => loadCfg())
  const [, setTick] = useState(0)
  const [perm, setPerm] = useState(() => notificationPermission())
  const [testMsg, setTestMsg] = useState('')
  useEffect(() => store.subscribe(() => setTick((t) => t + 1)), [])
  const [expanded, setExpanded] = useState(null)

  // 立即基于最新持久配置计算并写盘，再 setState（避免 updater 内副作用时机不确定）
  const setCfg = (fn) => { const next = saveCfg(fn(loadCfg())); setCfgState(next) }
  const togglePref = (jp) => setCfg((c) => {
    const cur = c.watch.prefectures
    const next = cur.indexOf(jp) === -1 ? cur.concat(jp) : cur.filter((p) => p !== jp)
    return { ...c, watch: { ...c.watch, prefectures: next } }
  })

  const st = store.status
  const statusMeta = {
    idle: { color: '#7c8494', text: '未启动' },
    connecting: { color: '#d9a406', text: '连接中…' },
    open: { color: '#4ade80', text: '已连接' },
    reconnecting: { color: '#d9a406', text: '重连中（第 ' + store.retries + ' 次）' },
    closed: { color: '#e5484d', text: '已停止' },
  }[st] || { color: '#7c8494', text: st }
  const dot = h('span', { style: { display: 'inline-block', width: 10, height: 10, borderRadius: '50%', background: statusMeta.color, marginRight: 8 } })

  const kindColor = { eew: '#e5484d', quake: '#3b82f6', tsunami: '#f76b15' }
  const permText = {
    granted: '通知权限：已授权',
    denied: '通知权限：被拒绝（请在浏览器站点设置中允许）',
    default: '通知权限：未授权 — 点下方「测试系统通知」授权',
    unsupported: '当前浏览器不支持系统通知',
  }[perm] || ''

  return h('div', { style: { fontFamily: 'system-ui, sans-serif', fontSize: 13, color: '#dfe3e8' } },
    // 连接状态 + 数据源（测试切换）
    s.section('连接状态',
      h('div', { style: { display: 'flex', alignItems: 'center', gap: 6, marginBottom: 8 } },
        dot,
        h('span', { style: { fontWeight: 600 } }, statusMeta.text),
        h('span', { style: { color: '#9aa0a6', fontSize: 11 } }, store.detail || ''),
        store.received > 0
          ? h('span', { style: { color: '#4ade80', fontSize: 11, border: '1px solid rgba(74,222,128,0.4)', borderRadius: 10, padding: '0 6px' } },
              '已收到 ' + store.received + ' 条推送')
          : null),
      s.label('数据源'),
      s.row(
        s.select(cfg.source, [
          { v: 'prod', label: '正式：P2PQuake 实时推送' },
          { v: 'sandbox', label: '沙箱：回放 2023 年历史（约30秒/条，测试用）' },
        ], (v) => {
          setCfg((c) => ({ ...c, source: v }))
          if (activeClient) setTimeout(() => { try { activeClient.restart() } catch (err) {} }, 80)
        }, (o) => o.label),
      ),
    ),

    // 关注地区
    s.section('关注地区（都道府县）',
      h('div', { style: { fontSize: 11, color: '#9aa0a6', marginBottom: 8 } },
        cfg.watch.prefectures.length === 0
          ? '未选择 → 将提醒全日本（按下方阈值过滤）。建议选择你所在/关注的地区以减少打扰。'
          : '已关注 ' + cfg.watch.prefectures.length + ' 个地区'),
      h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 5 } },
        PREFECTURES.map((p) => {
          const on = cfg.watch.prefectures.indexOf(p.jp) !== -1
          return h('button', {
            key: p.jp,
            onClick: () => togglePref(p.jp),
            style: {
              fontSize: 11, padding: '2px 9px', borderRadius: 12, cursor: 'pointer',
              border: '1px solid ' + (on ? '#3b82f6' : 'rgba(148,163,184,0.3)'),
              background: on ? 'rgba(59,130,246,0.18)' : 'transparent',
              color: on ? '#93c5fd' : '#9aa0a6',
            },
          }, p.zh)
        }),
      ),
    ),

    // 阈值
    s.section('提醒阈值',
      s.label('地震（实测震度最低值）'),
      s.row(s.select(cfg.thresholds.quakeScale, SCALE_OPTIONS, (v) => setCfg((c) => ({ ...c, thresholds: { ...c.thresholds, quakeScale: Number(v) } })), (o) => o.label)),
      s.label('紧急地震速报（预测震度最低值）'),
      s.row(s.select(cfg.thresholds.eewScale, SCALE_OPTIONS, (v) => setCfg((c) => ({ ...c, thresholds: { ...c.thresholds, eewScale: Number(v) } })), (o) => o.label)),
      s.label('海啸'),
      s.row(s.select(cfg.thresholds.tsunamiGrade, TSUNAMI_OPTIONS, (v) => setCfg((c) => ({ ...c, thresholds: { ...c.thresholds, tsunamiGrade: v } })), (o) => o.label)),
    ),

    // 通知与声音
    s.section('通知与声音',
      s.row(
        s.checkbox(cfg.notify.sound !== false, (v) => setCfg((c) => ({ ...c, notify: { ...c.notify, sound: v } })), '提示音', '#dfe3e8'),
        s.checkbox(cfg.notify.system !== false, (v) => setCfg((c) => ({ ...c, notify: { ...c.notify, system: v } })), '系统通知', '#dfe3e8'),
      ),
      s.row(s.label('音量'), h('input', {
        type: 'range', min: 0, max: 100,
        value: Math.round(cfg.notify.volume * 100),
        onChange: (e) => setCfg((c) => ({ ...c, notify: { ...c.notify, volume: Number(e.target.value) / 100 } })),
        style: { flex: 1, minWidth: 120 },
      }), h('span', { style: { color: '#9aa0a6', fontSize: 11, width: 34 } }, Math.round(cfg.notify.volume * 100) + '%')),
      s.row(
        s.btn('试听地震音', () => playSound('quake', cfg.notify.volume)),
        s.btn('试听 EEW 音', () => playSound('eew', cfg.notify.volume)),
        s.btn('试听海啸音', () => playSound('tsunami', cfg.notify.volume)),
      ),
      s.row(
        s.btn('测试系统通知', () => {
          unlockAudio()
          const send = () => {
            const ok = showSystemNotification({ title: 'QuakeAlert 测试', body: '这是一条测试系统通知。', tag: 'quake-test', silent: true })
            setTestMsg(ok ? '已发送测试通知，请查看系统通知中心' : '测试通知发送失败')
          }
          if (perm === 'unsupported') { setTestMsg('当前浏览器不支持系统通知，无法测试'); return }
          if (perm === 'denied') { setTestMsg('通知权限已被拒绝 —— 请在浏览器站点设置中允许后重试'); return }
          if (perm === 'default') {
            requestNotificationPermission().then((p) => {
              setPerm(p)
              if (p === 'granted') send()
              else setTestMsg('未获得通知权限（浏览器未授权）')
            })
            return
          }
          send()
        }),
        s.btn('测试 Toast', () => showToast({ title: 'QuakeAlert 测试', body: '页面内弹窗工作正常。', color: '#4ade80', ttlMs: 4000 })),
      ),
      h('div', { style: { color: '#9aa0a6', fontSize: 11, marginTop: 6 } }, permText),
      testMsg ? h('div', { style: { color: '#93c5fd', fontSize: 11, marginTop: 4 } }, testMsg) : null,
    ),

    // 免责
    s.section('免责声明', h('div', { style: { color: '#9aa0a6', fontSize: 11, lineHeight: 1.6 } },
      '预警数据由 P2PQuake 转播（非官方直接数据源），EEW 紧急地震速报等内容与配信品质无保证。' +
      '本插件提醒仅供参考，请务必以日本气象厅（気象庁）官方发布为准。插件仅在 DSH 页面开启时工作。')),

    // 最近预警（点击条目展开详情；多条时可滚动）
    s.section('最近预警记录（' + store.events.length + ' 条）',
      h('div', { style: { fontSize: 11, color: '#9aa0a6', marginBottom: 6 } },
        '记录匹配链路上处理过的消息（含未达阈值、未提醒的灰色记录），点条目展开完整内容。'),
      store.events.length === 0
        ? h('div', { style: { color: '#9aa0a6', fontSize: 12, padding: '4px 0' } }, '暂无记录 —— 收到真实预警或测试消息后显示')
        : h('div', { style: { maxHeight: 300, overflowY: 'auto', paddingRight: 4 } },
            store.events.slice(0, HISTORY_MAX).map((e, i) => {
              const open = expanded === (e.key || e.id || i)
              const head = String(e.headline || '')
              const muted = e.hit === false || e.suppressed === true
              const statusText = e.hit === false
                ? '未触发提醒'
                : (e.suppressed ? '未重复提醒' : (e.pref ? '命中 ' + e.pref : '已提醒'))
              const codeNum = e.kind === 'eew' ? 556 : (e.kind === 'tsunami' ? 552 : 551)
              return h('div', {
                key: e.key || e.id || i,
                onClick: () => setExpanded(open ? null : (e.key || e.id || i)),
                title: open ? '点击收起' : '点击展开详情',
                style: Object.assign({
                  cursor: 'pointer',
                  borderLeft: '3px solid ' + (kindColor[e.kind] || '#7c8494'),
                  background: open
                    ? (muted ? 'rgba(148,163,184,0.16)' : 'rgba(59,130,246,0.22)')
                    : (muted ? 'rgba(148,163,184,0.05)' : 'rgba(148,163,184,0.09)'),
                  borderRadius: 6, padding: '6px 10px', margin: '5px 0',
                }, open ? { boxShadow: 'inset 0 0 0 1px rgba(148,163,184,0.55)' } : null),
              },
                h('div', { style: { display: 'flex', gap: 8, alignItems: 'center' } },
                  h('span', { style: { fontWeight: 700, fontSize: 12, color: kindColor[e.kind] || '#dfe3e8' } }, e.label || ''),
                  h('span', { style: { fontSize: 11, border: '1px solid ' + (muted ? '#8b8f98' : '#4ade80'), color: muted ? '#8b8f98' : '#4ade80', borderRadius: 8, padding: '0 6px' } }, statusText),
                  h('span', { style: { color: '#9aa0a6', fontSize: 11, marginLeft: 'auto', whiteSpace: 'nowrap' } }, open ? '▲ 收起' : '▼ 展开')),
                !open
                  ? h('div', { style: { fontSize: 12, color: '#c8ccd4', marginTop: 3, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' } }, head)
                  : h('div', { style: { fontSize: 12, marginTop: 6 } },
                      h('div', { style: { display: 'flex', gap: 6 } },
                        h('span', { style: { color: '#9aa0a6', width: 44 } }, '类型'),
                        h('span', { style: { color: '#e6e6e8' } }, (e.label || '') + '（code ' + codeNum + '）')),
                      h('div', { style: { display: 'flex', gap: 6, marginTop: 2 } },
                        h('span', { style: { color: '#9aa0a6', width: 44 } }, '时间'),
                        h('span', { style: { color: '#e6e6e8' } }, e.issued || '—')),
                      e.pref ? h('div', { style: { display: 'flex', gap: 6, marginTop: 2 } },
                        h('span', { style: { color: '#9aa0a6', width: 44 } }, '命中'),
                        h('span', { style: { color: '#e6e6e8' } }, e.pref)) : null,
                      e.suppressedReason ? h('div', { style: { display: 'flex', gap: 6, marginTop: 2 } },
                        h('span', { style: { color: '#9aa0a6', width: 44 } }, '说明'),
                        h('span', { style: { color: '#e6e6e8' } }, e.suppressedReason)) : null,
                      h('div', { style: { display: 'flex', gap: 6, marginTop: 2 } },
                        h('span', { style: { color: '#9aa0a6', width: 44 } }, '内容'),
                        h('span', { style: { color: '#e6e6e8', flex: 1, wordBreak: 'break-all' } }, head)),
                    ),
              )
            }),
          ),
      s.row(s.btn('清空记录', () => { store.events = []; saveJSON(HISTORY_KEY, []); store.push({}) })),
    ),
  )
}

// ---------- 插件入口 ----------
exports.name = 'dsh-quake-alert'
exports.inject = ['slots']
exports.apply = function apply(ctx) {
  // 音效解锁：首次用户手势创建/恢复 AudioContext（自动播放策略标准解法）
  ctx.effect(() => {
    const unlock = () => { try { unlockAudio() } catch (err) {} }
    window.addEventListener('pointerdown', unlock, { passive: true })
    window.addEventListener('keydown', unlock, { passive: true })
    return () => {
      window.removeEventListener('pointerdown', unlock)
      window.removeEventListener('keydown', unlock)
    }
  }, 'dsh-quake-alert: audio unlock')

  // 跨标签页去重通道：必须在插件加载时就开始监听，否则会错过其它标签页的广播
  ensureAlertChannel()
  ctx.effect(() => () => {
    try { if (alertChannel) { alertChannel.close(); alertChannel = null } } catch (err) { /* 忽略 */ }
  }, 'dsh-quake-alert: tab channel')

  // WebSocket 常驻连接（与设置页是否打开无关）
  const client = createWsClient()
  activeClient = client
  client.start()
  ctx.effect(() => () => { try { client.stop() } catch (err) {} }, 'dsh-quake-alert: ws client')

  // 设置页：设置 → 灾害预警
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'quake-alert',
    order: 60,
    label: () => '灾害预警',
  }, (props) => h(SettingsPanel, { close: props ? props.close : undefined })))
}

// 单测钩子（客户端宿主忽略额外导出）
exports.__test = { parse, parseQuake, parseEew, parseTsunami, matchAlert, prefOfName, prefsOfArea, regionsOfArea, AREA_PREF, loadCfg, loadHistory, addEvent, handleRaw, isDuplicate, isEventRepeat, claimAlertForTab, ensureAlertChannel, createWsClient, store, HISTORY_MAX, PREFECTURES, DEFAULT_CFG }

return module.exports;
} });
