// ============================================================================
// dsh-quake-alert · client/src/02-storage.js
//
// 作用：浏览器侧存储层——localStorage 读写与配置归一化。
// 内容：JSON 安全读写、isPlainObject/numOr/boolOr/timeOr 等类型守卫、
//       normalizeCfg（任何脏输入都归一成一份合法配置）、loadCfg/saveCfg、
//       历史记录的字段规整（normalizeHistoryEntry / loadHistory）。
// 依赖：01-constants。
// ============================================================================

import { PREF_SET, PREFECTURES, TSUNAMI_OPTIONS, DEFAULT_CFG, STORAGE_KEY, HISTORY_KEY, HISTORY_MAX, MAX_WATCH_PLACES } from './01-constants.js'

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
    // code：区分来源用（'emsc'/'usgs'/'noaa'/'jma'/551…）。只看 kind 会把全球地震
    // （kind 也是 'quake'）标成「code 551」——与 0.3.2 修过的"气象条目被标成 code 551"同类。
    // 旧历史条目没有这个字段 → 空串，展示层回退到 kind 映射。
    code: strOr(e.code, ''),
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
// 每次都返回全新对象：避免调用方改动嵌套字段时污染 DEFAULT_CFG 常量。
// 由 DEFAULT_CFG **深拷贝派生**（而不是手抄字段清单）：freshCfg 是 settingsOpsFor 判断
// "某字段是否等于默认值"的唯一基准，手抄的话以后给 DEFAULT_CFG 加字段而漏改这里，
// 新字段会被永久判为"非默认"，永远写进 settings.yaml 而永不 unset。
const cloneCfg = (v) => (Array.isArray(v)
  ? v.map(cloneCfg)
  : (isPlainObject(v) ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, cloneCfg(x)])) : v))
const freshCfg = () => cloneCfg(DEFAULT_CFG)
// 全球关注点：[{ name, lat, lon, radiusKm }]。坐标必须落在合法范围——脏数据里的 NaN 或
// 越界值会让距离计算得出无意义的结果，表现为"看起来配好了却永远不提醒"（静默漏报）。
// 半径夹在 1–2000 km；同一个点重复添加是常见操作，按经纬度（三位小数）去重。
function normalizePlaces(list) {
  const out = []
  const seen = new Set()
  for (const p of list) {
    if (!isPlainObject(p)) continue
    // 用显式范围判断而不是 numOr：numOr 对越界值是**夹取**，而经纬度越界意味着这份数据本身
    // 是坏的（例如把半径填进了纬度列）。夹到边界会造出一个"看起来合法"的错误关注点。
    const lat = (typeof p.lat === 'number' && Number.isFinite(p.lat) && Math.abs(p.lat) <= 90) ? p.lat : null
    const lon = (typeof p.lon === 'number' && Number.isFinite(p.lon) && Math.abs(p.lon) <= 180) ? p.lon : null
    if (lat === null || lon === null) continue
    const key = lat.toFixed(3) + ',' + lon.toFixed(3)
    if (seen.has(key)) continue
    seen.add(key)
    out.push({
      name: strOr(p.name, '').slice(0, 30).trim() || (lat.toFixed(2) + ', ' + lon.toFixed(2)),
      lat,
      lon,
      radiusKm: numOr(p.radiusKm, 300, 1, 2000),
    })
    if (out.length >= MAX_WATCH_PLACES) break
  }
  return out
}
// 逐字段校验 + 回退默认值：任何形状的输入都归一成一份合法配置
function normalizeCfg(input) {
  // 兜底：调用方（loadCfg / sectionToCfg / applyCfg）都保证传对象，但归一化函数自己不该因为
  // 传进 null/undefined 就抛错——它的契约是"任何脏输入都能归一成一份合法配置"。
  const stored = isPlainObject(input) ? input : {}
  const w = isPlainObject(stored.watch) ? stored.watch : {}
  const d = isPlainObject(stored.disasters) ? stored.disasters : {}
  const t = isPlainObject(stored.thresholds) ? stored.thresholds : {}
  const n = isPlainObject(stored.notify) ? stored.notify : {}
  const de = isPlainObject(stored.dedupe) ? stored.dedupe : {}
  const qh = isPlainObject(stored.quietHours) ? stored.quietHours : {}
  return {
    version: DEFAULT_CFG.version,
    source: stored.source === 'sandbox' ? 'sandbox' : 'prod',
    // 大陆源的链路选择（0.5.0）：白名单，只认 'poll'，其余一律回 'auto'。
    // 用白名单而不是"非 poll 即 auto"的等价写法，是为了让将来加第三种取值时不会静默错位。
    cnTransport: stored.cnTransport === 'poll' ? 'poll' : 'auto',
    watch: {
      // 只保留 47 县中确实存在的名字，避免脏数据在设置页渲染出幽灵按钮
      prefectures: Array.isArray(w.prefectures)
        ? Array.from(new Set(w.prefectures.filter((p) => typeof p === 'string' && PREF_SET.has(p))))
        : [],
      // 市区町村：这里只保证类型、去重与规模；名字是否真实存在由数据表加载后校验
      cities: Array.isArray(w.cities)
        ? Array.from(new Set(w.cities.filter((c) => typeof c === 'string' && c.length > 0 && c.length <= 30))).slice(0, 300)
        : [],
      // 全球关注点（0.4.0 新增）。旧配置没有这个字段 → 归一成空数组，不影响日本模式
      places: Array.isArray(w.places) ? normalizePlaces(w.places) : [],
    },
    disasters: {
      earthquake: boolOr(d.earthquake, DEFAULT_CFG.disasters.earthquake),
      tsunami: boolOr(d.tsunami, DEFAULT_CFG.disasters.tsunami),
      // 0.3.0 新增。旧配置没有这个字段 → 取默认值 true，不会被清空或误关
      weather: boolOr(d.weather, DEFAULT_CFG.disasters.weather),
      // 大陆气象灾害的两类（0.5.2）。同样必须在这里同步——漏掉就会被 applyCfg 静默丢弃，
      // 表现是"用户关掉了暴雨提醒，刷新后又自己开了"。
      cnRainstorm: boolOr(d.cnRainstorm, DEFAULT_CFG.disasters.cnRainstorm),
      cnGeology: boolOr(d.cnGeology, DEFAULT_CFG.disasters.cnGeology),
      // 海外气象灾害（0.6.0）。同上：**必须在这里同步**，否则用户关掉之后刷新又自己开了。
      overseasWeather: boolOr(d.overseasWeather, DEFAULT_CFG.disasters.overseasWeather),
    },
    thresholds: {
      quakeScale: numOr(t.quakeScale, DEFAULT_CFG.thresholds.quakeScale, 0, 70),
      eewScale: numOr(t.eewScale, DEFAULT_CFG.thresholds.eewScale, 0, 70),
      // 白名单校验，同时避免 'constructor' 之类的原型链键被当成合法等级
      tsunamiGrade: TSUNAMI_OPTIONS.some((o) => o.g === t.tsunamiGrade)
        ? t.tsunamiGrade
        : DEFAULT_CFG.thresholds.tsunamiGrade,
      // 全球源的最低震级（0.4.0）。0 是有意义的取值（来者不拒），所以下界是 0 而不是 1
      globalMagnitude: numOr(t.globalMagnitude, DEFAULT_CFG.thresholds.globalMagnitude, 0, 10),
      // 大陆速报的独立门槛（0.5.0）。新增字段必须在这里同步，否则 applyCfg 会**静默丢弃**它
      // ——这正是 DESIGN 11.6 第 10 条那个"有保护的残留"：忘了同步时回归断言会失败。
      cnReportMagnitude: numOr(t.cnReportMagnitude, DEFAULT_CFG.thresholds.cnReportMagnitude, 0, 10),
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

export { own, isPlainObject, numOr, boolOr, timeOr, minutesOfTime, inQuietHours, loadJSON, saveJSON, normalizeHistoryEntry, loadHistory, freshCfg, normalizePlaces, normalizeCfg, loadCfg, saveCfg }
