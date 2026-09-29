// ============================================================================
// dsh-quake-alert · client/src/02-storage.js
// 浏览器侧存储层：localStorage 读写、类型守卫（isPlainObject / numOr / boolOr / timeOr）、
// 配置规整 normalizeCfg、loadCfg / saveCfg、历史记录规整。
// 依赖 01-constants、00-i18n。读到的内容一律做类型校验，任何异常退回默认值。
// ============================================================================

import { PREF_SET, PREFECTURES, TSUNAMI_OPTIONS, SCALE_OPTIONS, DEFAULT_CFG, STORAGE_KEY, HISTORY_KEY, HISTORY_MAX, HISTORY_MAX_AGE_MS, MAX_WATCH_PLACES, MAX_WATCH_CITIES, LEGACY_PLACE_RADIUS_KM, MIN_PLACE_RADIUS_KM, MAX_PLACE_RADIUS_KM } from './01-constants.js'
import { resolveLang, setLanguage } from './00-i18n.js'

// ---------- 存储（localStorage） ----------
const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)
/** 历史条目是否还在「过去 5 天」里。判据是记录的**写入时刻**（`at`），不是电文的发布时刻
 *（占位的是已经躺在列表里的记录，计时从落笔开始）；老记录没有 `at` 时退回按 `issued` 判一次，
 *  两者都认不出时**保留**（不因为缺字段删用户的数据）。 */
export function withinHistoryAge(e, now) {
  // `at > 0` 才算"有写入时刻"：规整时会给老条目补 `at: 0`（表示不知道），那一支要退回 issued
  const written = (e && typeof e.at === 'number' && Number.isFinite(e.at) && e.at > 0) ? e.at : NaN
  if (Number.isFinite(written)) return (now - written) <= HISTORY_MAX_AGE_MS
  const issued = Date.parse(String((e && e.issued) || ''))
  if (Number.isFinite(issued)) return (now - issued) <= HISTORY_MAX_AGE_MS
  return true
}
/** 数值规整：夹取到 [min,max]，类型不符时回退 fallback。**数字字符串也当数值**（`"100"` → 100）， 否则把数字写成字符串的配置会让 `radiusKm: "100"` 静默退回兜底的 300 km，反而放大半径。 */
function numOr(v, fallback, min, max) {
  let n = v
  if (typeof n === 'string' && n.trim() !== '') n = Number(n)
  if (typeof n !== 'number' || !Number.isFinite(n)) return fallback
  if (typeof min === 'number' && n < min) return min
  if (typeof max === 'number' && n > max) return max
  return n
}
const boolOr = (v, fallback) => (typeof v === 'boolean' ? v : fallback)
// 「HH:MM」时间字符串校验（允许 1 位小时，如 "7:05"）
const TIME_RE = /^([01]?\d|2[0-3]):([0-5]\d)$/
const timeOr = (v, fallback) => (typeof v === 'string' && TIME_RE.test(v.trim()) ? v.trim() : fallback)
const minutesOfTime = (v) => {
  const m = TIME_RE.exec(String(v === undefined || v === null ? '' : v).trim())
  return m ? Number(m[1]) * 60 + Number(m[2]) : null
}
// 静默时段判定：start > end 表示跨午夜（23:00–07:00），start === end 视为「不静默」。 now 可注入，便于测试覆盖边界而不依赖运行时刻。
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
// 历史记录必须是「对象数组」，且每个字段都必须是渲染层能直接交给 React 的基本类型： 元素为 null 会抛错，字段是对象/数组会让 React 抛「Objects are not valid as a React child」。
const strOr = (v, fallback) => (typeof v === 'string' ? v : (typeof v === 'number' || typeof v === 'boolean' ? String(v) : fallback))
// 历史条目里 `detail` 正文的保留上限。正文是解析层给的官方长文（NWS 的 description + instruction、 ECCC 的正文 + 署名），单条可达数 KB； 历史最多 30 条且写进 localStorage，
// 不截断会撑爆配额， 而超配额时 saveJSON 是**静默失败**的，整份历史会停止写入本地存储。
const HISTORY_DETAIL_MAX = 1200
function normalizeHistoryEntry(e, i) {
  const key = strOr(e.key, '') || strOr(e.id, '')
  return {
    key: key || 'legacy-' + i, // 早期版本可能没有 key，补一个稳定兜底键，保证 React key 与去重都可用
    id: strOr(e.id, ''),
    // code 是来源标识（'emsc'/'usgs'/'noaa'/'jma'/551…）：只看 kind 会把全球地震 （kind 也是 'quake'）标成「code 551」。旧条目没有它 → 空串，展示层回退到 kind 映射。
    code: strOr(e.code, ''),
    kind: strOr(e.kind, ''),
    label: strOr(e.label, ''),
    severity: strOr(e.severity, ''),
    issued: strOr(e.issued, ''),
    headline: strOr(e.headline, ''),
    detail: strOr(e.detail, '').slice(0, HISTORY_DETAIL_MAX),
    pref: strOr(e.pref, ''),
    hit: e.hit === true,
    suppressed: e.suppressed === true,
    suppressedReason: strOr(e.suppressedReason, ''),
    // 写入时刻：历史保留的「过去 5 天」以它为准（见 withinHistoryAge）；老条目 → 0 表示不知道
    at: (typeof e.at === 'number' && Number.isFinite(e.at)) ? e.at : 0,
  }
}
function loadHistory(nowMs) {
  const v = loadJSON(HISTORY_KEY, null)
  if (!Array.isArray(v)) return []
  const now = typeof nowMs === 'number' && Number.isFinite(nowMs) ? nowMs : Date.now()
  return v
    .filter((e) => isPlainObject(e) && withinHistoryAge(e, now))
    .slice(0, HISTORY_MAX)
    .map(normalizeHistoryEntry)
}
// 每次都返回全新对象，避免调用方改动嵌套字段时污染 DEFAULT_CFG；深拷贝派生而不是手抄字段清单， 因为 freshCfg 是 settingsOpsFor 判断「某字段是否等于默认值」的唯一基准（漏抄的字段永不 unset）。
const cloneCfg = (v) => (Array.isArray(v)
  ? v.map(cloneCfg)
  : (isPlainObject(v) ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, cloneCfg(x)])) : v))
const freshCfg = () => cloneCfg(DEFAULT_CFG)
// 全球关注点：[{ name, lat, lon, radiusKm, origin }]。经纬度只接受合法范围——格式不合法的数据里的 NaN 或越界值 会让距离计算得出无意义的结果，表现为"看起来配好了却永远不提醒"。半径夹在 1–2000 km； 按经纬度（三位小数）去重。
/** 关注点的**来源分支**：jp / cn / global，回答"这个点是在哪个国家的分支下加的"。消费者：跨源归并 判断优先源、大陆气象（行政区层级）匹配挑出大陆关注点、诊断快照。老配置没有这个字段，
 *   缺失时按 **名称形状推导**（设置页「中国大陆」级联产出的名字恒为「省·市」，见 04-city-table 的 cnPlaceOf）， 其余为 'global'。 */
const PLACE_ORIGINS = { jp: true, cn: true, global: true }
function placeOriginOf(p, name) {
  const raw = String((p && p.origin) || '')
  if (own(PLACE_ORIGINS, raw)) return raw
  return String(name || '').indexOf('·') > 0 ? 'cn' : 'global'
}
/** @param {{ total?: number, dropped?: number, radiusFixed?: number, citiesDropped?: number }} [audit] 可选的**检查清单**： 本函数的契约是静默丢弃非法条目（
 *   对 localStorage 里的数据是对的），但"导入一份配置"时需要 如实说明少了什么，传了 audit 就记下"总共几条 / 丢了几条 / 几条的半径不是数值"。 */
function normalizePlaces(list, audit) {
  const out = []
  const seen = new Set()
  for (const p of list) {
    if (audit) audit.total += 1
    if (!isPlainObject(p)) { if (audit) audit.dropped += 1; continue }
    // 用显式范围判断而不是 numOr：numOr 对越界值是**夹取**，而经纬度越界意味着数据本身是坏的 （例如把半径填进了纬度列），夹到边界会造出一个"看起来合法"的错误关注点。
    const lat = (typeof p.lat === 'number' && Number.isFinite(p.lat) && Math.abs(p.lat) <= 90) ? p.lat : null
    const lon = (typeof p.lon === 'number' && Number.isFinite(p.lon) && Math.abs(p.lon) <= 180) ? p.lon : null
    if (lat === null || lon === null) { if (audit) audit.dropped += 1; continue }
    const key = lat.toFixed(3) + ',' + lon.toFixed(3)
    if (seen.has(key)) { if (audit) audit.dropped += 1; continue }
    seen.add(key)
    const name = strOr(p.name, '').slice(0, 30).trim() || (lat.toFixed(2) + ', ' + lon.toFixed(2))
    const origin = placeOriginOf(p, name)
    // 半径"不是数值"（缺失 / null / true / 乱字符串）时 numOr 会退回兜底值；数字字符串是合法的， 所以只在真正回退时记账。
    const radiusOk = (typeof p.radiusKm === 'number' && Number.isFinite(p.radiusKm)) ||
      (typeof p.radiusKm === 'string' && p.radiusKm.trim() !== '' && Number.isFinite(Number(p.radiusKm)))
    if (audit && !radiusOk) audit.radiusFixed += 1
    const entry = {
      name,
      lat,
      lon,
    // 半径走 01-constants 的统一常量，与设置页渲染档位、Host schema 的 1–2000 保持一致
    radiusKm: numOr(p.radiusKm, LEGACY_PLACE_RADIUS_KM, MIN_PLACE_RADIUS_KM, MAX_PLACE_RADIUS_KM),
      origin,
    }
    // 大陆关注点的省 / 市：显式落在 place 上，matcher 与诊断不再从「省·市」这个名字反推； 老配置只有名字，这里从名字拆一次并固化。
    if (origin === 'cn') {
      let province = strOr(p.province, '').slice(0, 20).trim()
      let city = strOr(p.city, '').slice(0, 20).trim()
      if (!province || !city) {
        const i = name.indexOf('·')
        if (i > 0 && i < name.length - 1) {
          if (!province) province = name.slice(0, i)
          if (!city) city = name.slice(i + 1)
        }
      }
      if (province && city) {
        entry.province = province
        entry.city = city
      }
    }
    out.push(entry)
    if (out.length >= MAX_WATCH_PLACES) break
  }
  return out
}
// 数值规整 + **吸附到最近的合法档位**：机器级配置可以被手工改成任意数字（`quakeScale: 42`），而界面
// 下拉里只有固定档位（严格枚举会让脏值注册失败），所以"就近对齐"放在 Client：先夹到 [min,max] 再吸附。
function snapOr(v, fallback, options, min, max) {
  const n = numOr(v, fallback, min, max)
  // 0 在这两个字段上有明确含义（"来者不拒"，匹配层是 `scale >= threshold`），而它不是档位表里的一项 ——按"最近档位"吸附会把它推到 10，等于**收窄**了用户的范围，所以保留它。
  if (n === 0) return 0
  const vals = (Array.isArray(options) ? options : [])
    .map((o) => (o && typeof o === 'object' ? o.v : o))
    .filter((x) => typeof x === 'number' && Number.isFinite(x))
  if (vals.length === 0) return n
  let best = vals[0]
  for (const o of vals) if (Math.abs(o - n) < Math.abs(best - n)) best = o
  return best
}

/** 关注市区町村列表的规整：只保类型、去重与长度上限（名字是否真实存在由数据表校验）。
 *  @param {object} [audit] 见 normalizePlaces：超出 MAX_WATCH_CITIES 被截断的条数记进 `audit.citiesDropped`。 */
function normalizeCities(list, audit) {
  const out = Array.from(new Set(list.filter((c) => typeof c === 'string' && c.length > 0 && c.length <= 30)))
  if (out.length <= MAX_WATCH_CITIES) return out
  if (audit) audit.citiesDropped += out.length - MAX_WATCH_CITIES
  return out.slice(0, MAX_WATCH_CITIES)
}
// 逐字段校验 + 回退默认值：任何形状的输入都规整成一份合法配置。audit 见 normalizePlaces， 只有导入路径会传它。
function normalizeCfg(input, audit) {
  // 调用方都保证传对象，但本函数的契约是"任何脏输入都能规整"，不该因为传进 null/undefined 就抛错
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
    // 白名单校验：只认 'poll'，其余一律回 'auto'（将来加第三种取值时不会静默错位）
    cnTransport: stored.cnTransport === 'poll' ? 'poll' : 'auto',
    watch: {
      // 只保留 47 县中确实存在的名字，避免格式不合法的数据在设置页渲染出幽灵按钮
      prefectures: Array.isArray(w.prefectures)
        ? Array.from(new Set(w.prefectures.filter((p) => typeof p === 'string' && PREF_SET.has(p))))
        : [],
      // 市区町村：只保证类型、去重与规模（上限与设置页同一常量），名字是否存在由数据表校验
      cities: Array.isArray(w.cities) ? normalizeCities(w.cities, audit) : [],
      // 旧配置没有这个字段 → 统一成空数组
      places: Array.isArray(w.places) ? normalizePlaces(w.places, audit) : [],
    },
    disasters: {
      earthquake: boolOr(d.earthquake, DEFAULT_CFG.disasters.earthquake),
      tsunami: boolOr(d.tsunami, DEFAULT_CFG.disasters.tsunami),
      weather: boolOr(d.weather, DEFAULT_CFG.disasters.weather),
      // 以下三个**必须在这里同步**，漏掉就会被 applyCfg 静默丢弃， 表现是"用户关掉了这类提醒，刷新之后它又自己开了"。
      cnRainstorm: boolOr(d.cnRainstorm, DEFAULT_CFG.disasters.cnRainstorm),
      cnGeology: boolOr(d.cnGeology, DEFAULT_CFG.disasters.cnGeology),
      overseasWeather: boolOr(d.overseasWeather, DEFAULT_CFG.disasters.overseasWeather),
    },
    thresholds: {
      // 夹取之后吸附到界面上的合法档位（手改的 42 → 40），见 snapOr
      quakeScale: snapOr(t.quakeScale, DEFAULT_CFG.thresholds.quakeScale, SCALE_OPTIONS, 0, 70),
      eewScale: snapOr(t.eewScale, DEFAULT_CFG.thresholds.eewScale, SCALE_OPTIONS, 0, 70),
      // 白名单校验，同时避免 'constructor' 之类的原型链键被当成合法等级
      tsunamiGrade: TSUNAMI_OPTIONS.some((o) => o.g === t.tsunamiGrade)
        ? t.tsunamiGrade
        : DEFAULT_CFG.thresholds.tsunamiGrade,
      // 全球源的最低震级：0 是有意义的取值（来者不拒），所以下界是 0。**不吸附档位**——下拉里那些 M3〜M7 只是常用预设，M6.7 这样的自定义门槛是合法且有意义的，吸附会改掉用户的实际门槛。
      globalMagnitude: numOr(t.globalMagnitude, DEFAULT_CFG.thresholds.globalMagnitude, 0, 10),
      // 大陆速报的独立门槛。新增字段**必须在这里同步**，否则 applyCfg 会静默丢弃它。同上，不吸附。
      cnReportMagnitude: numOr(t.cnReportMagnitude, DEFAULT_CFG.thresholds.cnReportMagnitude, 0, 10),
    },
    notify: {
      sound: boolOr(n.sound, DEFAULT_CFG.notify.sound),
      system: boolOr(n.system, DEFAULT_CFG.notify.system),
      volume: numOr(n.volume, DEFAULT_CFG.notify.volume, 0, 1),
      // 分灾害音效开关：**必须在这里同步**，否则 applyCfg 会静默丢弃它们
      soundQuake: boolOr(n.soundQuake, DEFAULT_CFG.notify.soundQuake),
      soundTsunami: boolOr(n.soundTsunami, DEFAULT_CFG.notify.soundTsunami),
      soundWeather: boolOr(n.soundWeather, DEFAULT_CFG.notify.soundWeather),
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
    // 界面语言：走 BCP 47 惯例的逐级回退（精确匹配 → 中文按脚本 / 地区分流 → 其它主语言 → 默认语言）；认不出的一律落到默认语言，手改进来的无语言包代码不会把界面带进半本地化状态。
    language: resolveLang(stored.language),
  }
}
function loadCfg() {
  const stored = loadJSON(STORAGE_KEY, null)
  if (!isPlainObject(stored)) {
    const fresh = freshCfg()
    saveJSON(STORAGE_KEY, fresh)
    // 语言要在**任何界面文本被取用之前**生效：配置是启动最早读到的状态，而通知 / 状态条的文案 可能第一帧就渲染，所以设置语言与"读配置"绑在一起。
    setLanguage(fresh.language)
    return fresh
  }
  let cfg
  try {
    cfg = normalizeCfg(stored)
  } catch (err) {
    // 一条格式不合法的数据绝不能把整个插件拖崩。规整流程会调 i18n 取词，而某些字符串化不了的形状 （`{toString:null, valueOf:null}`，JSON / YAML 都造得出来） 会让 `String(v)` 抛 TypeError；
    // 调用方里有**渲染期**的（设置页 `useState(() => currentCfg())`），抛错 = 整页白屏。
    try { console.warn('[dsh-quake-alert] 配置归一化失败，本次改用默认配置：' + String((err && err.message) || err)) } catch (e) { /* 忽略 */ }
    const fresh = freshCfg()
    saveJSON(STORAGE_KEY, fresh)
    setLanguage(fresh.language)
    return fresh
  }
  // 版本不同（插件升级 / 用户手改）时按当前 schema 统一保留可识别字段，再写回当前版本号； 不能写回默认值——一次版本号变化就会静默丢掉用户选好的关注地区与阈值。
  if (stored.version !== DEFAULT_CFG.version) saveJSON(STORAGE_KEY, cfg)
  setLanguage(cfg.language)
  return cfg
}
function saveCfg(cfg) {
  const next = { ...cfg, version: DEFAULT_CFG.version }
  saveJSON(STORAGE_KEY, next)
  return next
}


// 安全字典查找：外部数据里的 'constructor'/'toString' 等键会命中原型链，例如 AREA_PREF['constructor'] 会返回 Object 构造函数并让 .slice() 抛错。04-city-table / 解析层共用。
const own = (map, key) => (Object.prototype.hasOwnProperty.call(map, key) ? map[key] : undefined)

export { own, isPlainObject, numOr, boolOr, timeOr, minutesOfTime, inQuietHours, loadJSON, saveJSON, normalizeHistoryEntry, loadHistory, freshCfg, PLACE_ORIGINS, placeOriginOf, normalizePlaces, normalizeCfg, loadCfg, saveCfg }
