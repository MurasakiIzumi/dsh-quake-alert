// ============================================================================
// dsh-quake-alert · client/src/02-storage.js
//
// 作用：浏览器侧存储层——localStorage 读写与配置归一化。
// 内容：JSON 安全读写、isPlainObject/numOr/boolOr/timeOr 等类型守卫、
//       normalizeCfg（任何脏输入都归一成一份合法配置）、loadCfg/saveCfg、
//       历史记录的字段规整（normalizeHistoryEntry / loadHistory）。
// 依赖：01-constants。
// ============================================================================

import { PREF_SET, PREFECTURES, TSUNAMI_OPTIONS, DEFAULT_CFG, STORAGE_KEY, HISTORY_KEY, HISTORY_MAX } from './01-constants.js'

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
// 「HH:MM」时间字符串校验（允许 1 位小时，如 "7:05"）
const TIME_RE = /^([01]?\d|2[0-3]):([0-5]\d)$/
const timeOr = (v, fallback) => (typeof v === 'string' && TIME_RE.test(v.trim()) ? v.trim() : fallback)
const minutesOfTime = (v) => {
  const m = TIME_RE.exec(String(v === undefined || v === null ? '' : v).trim())
  return m ? Number(m[1]) * 60 + Number(m[2]) : null
}
// 静默时段判定。start > end 表示跨午夜（23:00–07:00）；start === end 视为「不静默」。
// now 可注入，便于回归测试覆盖边界而不依赖运行时刻。
function inQuietHours(cfg, now) {
  const q = cfg && cfg.quietHours
  if (!q || q.enabled !== true) return false
  const start = minutesOfTime(q.start)
  const end = minutesOfTime(q.end)
  if (start === null || end === null || start === end) return false
  const d = now || new Date()
  const cur = d.getHours() * 60 + d.getMinutes()
  return start < end ? (cur >= start && cur < end) : (cur >= start || cur < end)
}

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
// 历史记录必须是「对象数组」，且每个字段必须是渲染层能直接交给 React 的基本类型：
// 元素为 null 会抛错；字段是对象/数组则会让 React 抛「Objects are not valid as a React child」。
const strOr = (v, fallback) => (typeof v === 'string' ? v : (typeof v === 'number' || typeof v === 'boolean' ? String(v) : fallback))
function normalizeHistoryEntry(e, i) {
  const key = strOr(e.key, '') || strOr(e.id, '')
  return {
    key: key || 'legacy-' + i, // 早期版本可能没有 key，补一个稳定兜底键，保证 React key 与去重都可用
    id: strOr(e.id, ''),
    kind: strOr(e.kind, ''),
    label: strOr(e.label, ''),
    severity: strOr(e.severity, ''),
    issued: strOr(e.issued, ''),
    headline: strOr(e.headline, ''),
    pref: strOr(e.pref, ''),
    hit: e.hit === true,
    suppressed: e.suppressed === true,
    suppressedReason: strOr(e.suppressedReason, ''),
  }
}
function loadHistory() {
  const v = loadJSON(HISTORY_KEY, null)
  if (!Array.isArray(v)) return []
  return v.filter((e) => isPlainObject(e)).slice(0, HISTORY_MAX).map(normalizeHistoryEntry)
}
// 每次都返回全新对象：避免调用方改动嵌套字段时污染 DEFAULT_CFG 常量
const freshCfg = () => ({
  version: DEFAULT_CFG.version,
  source: DEFAULT_CFG.source,
  watch: { prefectures: [], cities: [] },
  disasters: { ...DEFAULT_CFG.disasters },
  thresholds: { ...DEFAULT_CFG.thresholds },
  notify: { ...DEFAULT_CFG.notify },
  dedupe: { ...DEFAULT_CFG.dedupe },
  quietHours: { ...DEFAULT_CFG.quietHours },
})
// 逐字段校验 + 回退默认值：任何形状的输入都归一成一份合法配置
function normalizeCfg(stored) {
  const w = isPlainObject(stored.watch) ? stored.watch : {}
  const d = isPlainObject(stored.disasters) ? stored.disasters : {}
  const t = isPlainObject(stored.thresholds) ? stored.thresholds : {}
  const n = isPlainObject(stored.notify) ? stored.notify : {}
  const de = isPlainObject(stored.dedupe) ? stored.dedupe : {}
  const qh = isPlainObject(stored.quietHours) ? stored.quietHours : {}
  return {
    version: DEFAULT_CFG.version,
    source: stored.source === 'sandbox' ? 'sandbox' : 'prod',
    watch: {
      // 只保留 47 县中确实存在的名字，避免脏数据在设置页渲染出幽灵按钮
      prefectures: Array.isArray(w.prefectures)
        ? Array.from(new Set(w.prefectures.filter((p) => typeof p === 'string' && PREF_SET.has(p))))
        : [],
      // 市区町村：这里只保证类型、去重与规模；名字是否真实存在由数据表加载后校验
      cities: Array.isArray(w.cities)
        ? Array.from(new Set(w.cities.filter((c) => typeof c === 'string' && c.length > 0 && c.length <= 30))).slice(0, 300)
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
    quietHours: {
      enabled: boolOr(qh.enabled, DEFAULT_CFG.quietHours.enabled),
      start: timeOr(qh.start, DEFAULT_CFG.quietHours.start),
      end: timeOr(qh.end, DEFAULT_CFG.quietHours.end),
      breakForSevere: boolOr(qh.breakForSevere, DEFAULT_CFG.quietHours.breakForSevere),
    },
  }
}
function loadCfg() {
  const stored = loadJSON(STORAGE_KEY, null)
  if (!isPlainObject(stored)) {
    const fresh = freshCfg()
    saveJSON(STORAGE_KEY, fresh)
    return fresh
  }
  const cfg = normalizeCfg(stored)
  // 版本不同（插件升级 / 用户手改）时不再直接清空：按当前 schema 归一保留可识别字段，再写回当前版本号。
  // 旧实现会在这里 saveJSON(默认值)，一次版本号变化就会静默丢掉用户选好的关注地区与阈值。
  if (stored.version !== DEFAULT_CFG.version) saveJSON(STORAGE_KEY, cfg)
  return cfg
}
function saveCfg(cfg) {
  const next = { ...cfg, version: DEFAULT_CFG.version }
  saveJSON(STORAGE_KEY, next)
  return next
}


// 安全字典查找：外部数据里的 'constructor'/'toString' 等键会命中原型链，
// 例如 AREA_PREF['constructor'] 会返回 Object 构造函数并让 .slice() 抛错。
// （原在 05-parser，因被 city-table / parser / matcher 共用而移到这里）
const own = (map, key) => (Object.prototype.hasOwnProperty.call(map, key) ? map[key] : undefined)

export { own, isPlainObject, numOr, boolOr, timeOr, minutesOfTime, inQuietHours, loadJSON, saveJSON, normalizeHistoryEntry, loadHistory, freshCfg, normalizeCfg, loadCfg, saveCfg }
