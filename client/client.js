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
function loadCfg() {
  const stored = loadJSON(STORAGE_KEY, null)
  if (!stored || typeof stored !== 'object' || stored.version !== DEFAULT_CFG.version) {
    saveJSON(STORAGE_KEY, DEFAULT_CFG)
    return DEFAULT_CFG
  }
  // 浅合并缺省，保证新字段有默认值
  return {
    ...DEFAULT_CFG,
    ...stored,
    watch: { ...DEFAULT_CFG.watch, ...(stored.watch || {}) },
    disasters: { ...DEFAULT_CFG.disasters, ...(stored.disasters || {}) },
    thresholds: { ...DEFAULT_CFG.thresholds, ...(stored.thresholds || {}) },
    notify: { ...DEFAULT_CFG.notify, ...(stored.notify || {}) },
    dedupe: { ...DEFAULT_CFG.dedupe, ...(stored.dedupe || {}) },
  }
}
function saveCfg(cfg) {
  const next = { ...cfg, version: DEFAULT_CFG.version }
  saveJSON(STORAGE_KEY, next)
  return next
}

// ---------- 解析器：P2PQuake code → Alert ----------
// Alert = { id, code, kind, kindLabel, severity, issued, headline, second,
//           regions:[{pref, area, scale?, grade?}], cancelled }
function prefOfName(name) {
  const s = String(name || '')
  const m = /^(.+?[都道府県])/.exec(s)
  return m ? m[1] : s
}
const unique = (arr) => Array.from(new Set(arr.filter(Boolean)))
const scaleText = (v) => SCALE_TEXT[v] || (typeof v === 'number' && v > 0 ? '震度' + Math.floor(v / 10) : '未公布')
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
    : (labelMap[type] || '地震情报')
  const second = '最大震度 ' + scaleText(eq.maxScale)
  return {
    id: String(raw.id || raw._id || ''), code: 551, kind: 'quake',
    kindLabel: labelMap[type] || '地震情报',
    severity: severityOfScale(eq.maxScale),
    issued: (raw.issue && raw.issue.time) || raw.time || '',
    headline, second,
    maxScale: typeof eq.maxScale === 'number' ? eq.maxScale : -1,
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
    hypo: { name: hypo.name || '', magnitude: typeof hypo.magnitude === 'number' ? hypo.magnitude : null },
    regions: areas.map((a) => ({ pref: prefOfName(a.name), area: a.name || '', scale: typeof a.scaleTo === 'number' ? a.scaleTo : -1 })),
    cancelled,
    raw,
  }
}

function parseTsunami(raw) {
  const cancelled = raw.cancelled === true
  const areas = raw.areas || []
  const lines = areas.map((a) => {
    const hgt = a.maxHeight && a.maxHeight.description ? ' 高' + a.maxHeight.description : ''
    return (a.name || '—') + '：' + (TSUNAMI_GRADE_TEXT[a.grade] || a.grade || '—') + hgt
  })
  const worst = areas.reduce((m, a) => Math.max(m, TSUNAMI_RANK[a.grade] || 0), 0)
  const anyWarning = worst >= 2
  return {
    id: String(raw.id || raw._id || ''), code: 552, kind: 'tsunami',
    kindLabel: cancelled ? '海啸·已解除' : (worst >= 3 ? '大海啸警报' : (anyWarning ? '海啸警报' : '海啸注意报')),
    severity: cancelled ? 'info' : (worst >= 2 ? 'red' : 'orange'),
    issued: (raw.issue && raw.issue.time) || raw.time || '',
    headline: cancelled ? '海啸预报已解除' : lines.join('；'),
    second: areas.length + ' 个海啸预报区',
    maxScale: worst,
    regions: areas.map((a) => ({ pref: prefOfName(a.name), area: a.name || '', grade: a.grade || '' })),
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

function matchAlert(alert, cfg) {
  const w = cfg.watch || {}
  const t = cfg.thresholds || {}
  if (alert.kind === 'eew' || alert.kind === 'quake') {
    if ((cfg.disasters || {}).earthquake === false) return { hit: false, reason: '地震提醒已关闭' }
    if (alert.cancelled) return { hit: false, reason: '取消消息不提醒' }
    const threshold = alert.kind === 'eew' ? t.eewScale : t.quakeScale
    const hitRegion = alert.regions.find((r) => regionInWatch(r, w) && typeof r.scale === 'number' && r.scale >= threshold)
    return hitRegion
      ? { hit: true, reason: alert.kind === 'eew' ? 'EEW 预测震度达标' : '观测震度达标', region: hitRegion }
      : { hit: false, reason: '关注地区未命中或强度低于阈值' }
  }
  if (alert.kind === 'tsunami') {
    if ((cfg.disasters || {}).tsunami === false) return { hit: false, reason: '海啸提醒已关闭' }
    if (alert.cancelled) return { hit: false, reason: '解除消息不提醒' }
    const minRank = TSUNAMI_RANK[t.tsunamiGrade] || 1
    const hitRegion = alert.regions.find((r) => regionInWatch(r, w) && (TSUNAMI_RANK[r.grade] || 0) >= minRank)
    return hitRegion
      ? { hit: true, reason: '海啸等级达标', region: hitRegion }
      : { hit: false, reason: '关注地区未命中或等级低于阈值' }
  }
  return { hit: false, reason: '不支持的 code' }
}

// ---------- 全局 store：连接状态 + 最近预警（设置页订阅） ----------
const store = {
  status: 'idle', // idle | connecting | open | reconnecting | closed
  retries: 0,
  detail: '',
  received: 0, // 收到并成功解析的推送条数（诊断用）
  events: loadJSON(HISTORY_KEY, []).slice(0, 30), // 最近预警 [{kind,label,severity,issued,headline,pref}]
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
  store.events = [item].concat(store.events.filter((e) => e.key !== key)).slice(0, 30)
  saveJSON(HISTORY_KEY, store.events.slice(0, 20))
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
function notificationSupported() { return typeof window !== 'undefined' && 'Notification' in window }
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
    style.zIndex = '2147483000'
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

// ---------- 主链：收到消息 ----------
function handleRaw(raw, cfg) {
  const alert = parse(raw)
  if (!alert) return
  store.received += 1
  if (isDuplicate(alert.id, cfg.dedupe.windowMinutes)) return
  const m = matchAlert(alert, cfg)
  if (!m.hit) {
    // 不打扰：仅在设置页历史记录里记为"未命中"，便于用户核对配置
    if (alert.kind !== 'other') addEvent({
      id: alert.id, kind: alert.kind, label: alert.kindLabel, severity: alert.severity,
      issued: alert.issued, headline: alert.headline + '（未命中：' + m.reason + '）', hit: false,
    })
    return
  }
  const hitPref = m.region ? m.region.pref : ''
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
    store.push({ status: 'reconnecting', retries, detail: '连接断开，正在重连（第 ' + retries + ' 次）' })
    const delay = Math.min(RECONNECT_MAX, RECONNECT_BASE * Math.pow(2, retries))
    retries += 1
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
        value: Math.round((cfg.notify.volume || 0.7) * 100),
        onChange: (e) => setCfg((c) => ({ ...c, notify: { ...c.notify, volume: Number(e.target.value) / 100 } })),
        style: { flex: 1, minWidth: 120 },
      }), h('span', { style: { color: '#9aa0a6', fontSize: 11, width: 34 } }, Math.round((cfg.notify.volume || 0.7) * 100) + '%')),
      s.row(
        s.btn('试听地震音', () => playSound('quake', cfg.notify.volume)),
        s.btn('试听 EEW 音', () => playSound('eew', cfg.notify.volume)),
        s.btn('试听海啸音', () => playSound('tsunami', cfg.notify.volume)),
      ),
      s.row(
        s.btn('测试系统通知', () => {
          unlockAudio()
          if (perm === 'default' || perm === 'unsupported') {
            requestNotificationPermission().then((p) => { setPerm(p) })
            return
          }
          showSystemNotification({ title: 'QuakeAlert 测试', body: '这是一条测试系统通知。', tag: 'quake-test', silent: true })
        }),
        s.btn('测试 Toast', () => showToast({ title: 'QuakeAlert 测试', body: '页面内弹窗工作正常。', color: '#4ade80', ttlMs: 4000 })),
      ),
      h('div', { style: { color: '#9aa0a6', fontSize: 11, marginTop: 6 } }, permText),
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
            store.events.slice(0, 30).map((e, i) => {
              const open = expanded === (e.key || e.id || i)
              const head = String(e.headline || '')
              const statusText = e.hit === false ? '未触发提醒' : (e.pref ? '命中 ' + e.pref : '已提醒')
              const codeNum = e.kind === 'eew' ? 556 : (e.kind === 'tsunami' ? 552 : 551)
              return h('div', {
                key: e.key || e.id || i,
                onClick: () => setExpanded(open ? null : (e.key || e.id || i)),
                title: open ? '点击收起' : '点击展开详情',
                style: Object.assign({
                  cursor: 'pointer',
                  borderLeft: '3px solid ' + (kindColor[e.kind] || '#7c8494'),
                  background: open
                    ? (e.hit === false ? 'rgba(148,163,184,0.16)' : 'rgba(59,130,246,0.22)')
                    : (e.hit === false ? 'rgba(148,163,184,0.05)' : 'rgba(148,163,184,0.09)'),
                  borderRadius: 6, padding: '6px 10px', margin: '5px 0',
                }, open ? { boxShadow: 'inset 0 0 0 1px rgba(148,163,184,0.55)' } : null),
              },
                h('div', { style: { display: 'flex', gap: 8, alignItems: 'center' } },
                  h('span', { style: { fontWeight: 700, fontSize: 12, color: kindColor[e.kind] || '#dfe3e8' } }, e.label || ''),
                  h('span', { style: { fontSize: 11, border: '1px solid ' + (e.hit === false ? '#8b8f98' : '#4ade80'), color: e.hit === false ? '#8b8f98' : '#4ade80', borderRadius: 8, padding: '0 6px' } }, statusText),
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
exports.__test = { parse, parseQuake, parseEew, parseTsunami, matchAlert, prefOfName, PREFECTURES, DEFAULT_CFG }

return module.exports;
} });
