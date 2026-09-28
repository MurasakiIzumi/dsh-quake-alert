// ============================================================================
// dsh-quake-alert · client/src/04-city-table.js
// 市区町村表与「观测点 addr → 市町村」的对应：表的注入与规整、假名写法对齐、规范写法反查、拉表与查询。
// 要点：気象庁/P2PQuake 的观测点名用短名与消歧写法，必须先统一到市町村全称再比对；假名写法不
// 同时一律经 normKana 比对与反查，显示仍用本表写法。
// ============================================================================

import { PREF_SET } from './01-constants.js'
import { isPlainObject, own } from './02-storage.js'
import { currentCfg, applyCfg } from './03-settings-bridge.js'
import { store } from './07-store.js'

// ---------- 市区町村表：Host 路由提供，Client 拉一次并缓存 ----------
// /dsh-quake-alert/areas 返回 { prefectures: {...} }（全国 1700+ 条，不内联进 bundle）。
const AREAS_PATH = '/dsh-quake-alert/areas'
let cityTable = null
let cityTableState = 'idle' // idle | loading | ready | failed
let cityNameSet = null // 全部市町村名（校验配置用）
let cityPrefIndex = null // Map<统一后的市町村名, { name: 规范写法, prefs: 都道府県[] }>：JMA 电文只给市町村名，要反查所属县
let riverAreas = null // Map<河川予報区域コード, { name, cities }>：指定河川洪水予報用

// ---------- 地名假名写法对齐 ----------
// 不同数据源对同一市町村的写法不一致（金け崎町 ↔ 金ケ崎町、南あるぷす市 ↔ 南アルプス市）。
// 对齐步骤：先「平假名 → 片假名」，再把「ケ → ヶ」——两步都要。结果只用于比较与反查。
const KANA_HIRA_MIN = 0x3041
const KANA_HIRA_MAX = 0x3096
const KANA_KE_RE = /\u30b1/g
function normKana(input) {
  const s = String(input === undefined || input === null ? '' : input)
  let out = ''
  for (const ch of s) {
    const c = ch.codePointAt(0)
    out += (c >= KANA_HIRA_MIN && c <= KANA_HIRA_MAX) ? String.fromCodePoint(c + 0x60) : ch
  }
  return out.replace(KANA_KE_RE, '\u30f6')
}

function setCityTable(table) {
  if (!isPlainObject(table)) return false
  const clean = {}
  const names = new Set()
  for (const pref of Object.keys(table)) {
    if (!PREF_SET.has(pref)) continue
    const list = table[pref]
    if (!Array.isArray(list)) continue
    const uniq = Array.from(new Set(list.filter((c) => typeof c === 'string' && c.length > 0 && c.length <= 30)))
    if (uniq.length === 0) continue
    clean[pref] = uniq
    for (const c of uniq) names.add(c)
  }
  if (Object.keys(clean).length === 0) return false
  cityTable = clean
  cityNameSet = names
  // 索引键走假名写法对齐：外部写法（河川区域表 / JMA 电文）与本表写法不同时也要能查到
  cityPrefIndex = new Map()
  for (const pref of Object.keys(clean)) {
    for (const c of clean[pref]) {
      const key = normKana(c)
      const hit = cityPrefIndex.get(key)
      if (hit) { if (hit.prefs.indexOf(pref) === -1) hit.prefs.push(pref) }
      else cityPrefIndex.set(key, { name: c, prefs: [pref] })
    }
  }
  buildAddrIndex()
  cityTableState = 'ready'
  return true
}
const citiesOfPref = (pref) => (cityTable && own(cityTable, pref)) || []
/** 市町村名 → 所属都道府県（写法差异已对齐；重名时返回多个；表未加载或未收录时返回空数组）。 */
const prefsOfCity = (name) => {
  if (!cityPrefIndex) return []
  const hit = cityPrefIndex.get(normKana(name))
  return hit ? hit.prefs.slice() : []
}
/** 市町村名 → 本表里的规范写法（表未加载或未收录时返回空字符串）。JMA 电文、河川区域表给的是
 *  外部写法，直接与用户勾选名比对会漏报，所以比对前先取规范名。 */
const canonicalCityOf = (name) => {
  if (!cityPrefIndex) return ''
  const hit = cityPrefIndex.get(normKana(name))
  return hit ? hit.name : ''
}

/** 河川予報区域表（scripts/build-areas.mjs 生成，Host 随 /areas 下发）。指定河川洪水予報的电文
 *  区域是河川名（「天塩川」），必须先映射到市町村才能与用户关注比对。 */
function setRiverAreas(list) {
  if (!Array.isArray(list)) return false
  const idx = new Map()
  for (const a of list) {
    if (!a || typeof a.code !== 'string' || !Array.isArray(a.cities)) continue
    idx.set(a.code, { name: typeof a.name === 'string' ? a.name : '', cities: a.cities.filter((c) => typeof c === 'string' && c) })
  }
  if (idx.size === 0) return false
  riverAreas = idx
  return true
}
/** 河川予報区域コード → 覆盖的市町村名列表（未收录时返回空数组）。 */
const riverAreaCities = (code) => {
  if (!riverAreas) return []
  const hit = riverAreas.get(String(code || ''))
  return hit ? hit.cities.slice() : []
}

// ---------- 中国行政区划表：Host 随 /areas 一起下发 ----------
// 省 34 + 地级 384 共约 21KB。设置页的三级级联与**关注点坐标填充**都用它（大陆源是坐标 + 半径匹配）。
let cnAreas = null // [{ code, name, aliases, lat, lon, cities:[{name,aliases,lat,lon}] }]
/** 大陆行政区划表的加载结果：空串 = 还没失败，非空 = 失败原因。设置页据此区分"加载中"与"失败"。 */
let cnAreasFailed = ''
/** 别名的规整：丢掉单字别名（"丽"这类会匹配到半个中国）与和显示名重复的项，上限 8 条（匹配是
 *  **最长命中**，砍掉短名不影响建制全名）。缺失 `aliases` 字段时返回空数组——别名是增强，不是前提。 */
function normAliases(list, name) {
  if (!Array.isArray(list)) return []
  const out = []
  const seen = new Set()
  for (const a of list) {
    if (typeof a !== 'string') continue
    const s = a.trim()
    if (!s || s === name || s.length < 2 || seen.has(s)) continue
    seen.add(s)
    out.push(s)
    if (out.length >= 8) break
  }
  return out
}
/** 注入并规整行政区划表。**逐字段校验**：表来自 Host 的 JSON，与 localStorage 一样属于不可信输入
 *  ——一个坏条目会让级联渲染出幽灵选项，或把用户带到错误的坐标上。整体规整失败就整体拒绝。 */
function setCnAreas(list) {
  if (!Array.isArray(list)) { cnAreasFailed = '响应里没有 cnAreas'; return false }
  const out = []
  const seenProv = new Set()
  for (const p of list) {
    if (!isPlainObject(p)) continue
    const name = typeof p.name === 'string' ? p.name.trim() : ''
    if (!name || seenProv.has(name)) continue
    if (!validLatLon(p.lat, p.lon)) continue
    const cities = []
    const seenCity = new Set()
    for (const c of (Array.isArray(p.cities) ? p.cities : [])) {
      if (!isPlainObject(c)) continue
      const cn2 = typeof c.name === 'string' ? c.name.trim() : ''
      if (!cn2 || seenCity.has(cn2)) continue
      if (!validLatLon(c.lat, c.lon)) continue
      seenCity.add(cn2)
      cities.push({ name: cn2, aliases: normAliases(c.aliases, cn2), lat: c.lat, lon: c.lon })
    }
    // 没有下级的省级项在级联里是死路：直接丢弃
    if (cities.length === 0) continue
    seenProv.add(name)
    out.push({ code: typeof p.code === 'string' ? p.code : '', name, aliases: normAliases(p.aliases, name), lat: p.lat, lon: p.lon, cities })
  }
  if (out.length === 0) { cnAreasFailed = 'cnAreas 里没有可用的省份'; return false }
  cnAreas = out
  cnAreasFailed = ''
  return true
}
function validLatLon(lat, lon) {
  return typeof lat === 'number' && Number.isFinite(lat) && Math.abs(lat) <= 90 &&
    typeof lon === 'number' && Number.isFinite(lon) && Math.abs(lon) <= 180
}
/** 省级列表（表未加载时返回空数组）。 */
const cnProvinces = () => (cnAreas ? cnAreas.slice() : [])
/** 某个省下的地级市列表（未收录时返回空数组）。 */
const cnCitiesOf = (province) => {
  if (!cnAreas) return []
  const hit = cnAreas.find((p) => p.name === province)
  return hit ? hit.cities.slice() : []
}
/** 「省 + 市 + 半径」→ 一个关注点（表里查不到时返回 null）。名称取「省·市」以免两个省的"城区"撞名；
 *  `origin: 'cn'` 是**来源分支**，只做标注、**不限制匹配范围**：坐标点对所有坐标型源依然有效。 */
function cnPlaceOf(province, city, radiusKm) {
  if (!cnAreas) return null
  const p = cnAreas.find((x) => x.name === province)
  if (!p) return null
  const c = p.cities.find((x) => x.name === city)
  if (!c) return null
  const r = Number(radiusKm)
  if (!Number.isFinite(r) || r < 1 || r > 2000) return null
  // province / city 显式落在关注点上，matcher 不再从「省·市」这个名字反推；名字是给人看的标签
  return { name: province + '·' + city, lat: c.lat, lon: c.lon, radiusKm: r, origin: 'cn', province, city }
}

// ---------- 全球主要城市表：按国家分包，展开某国时才拉 ----------
// 整表 5224 条城市约 375KB 源码。Host 按 `?country=XX` **分包下发**，这里按需拉取并缓存。
let worldCountries = null // [{ code, count, names: { 'zh-CN', 'zh-TW', ja, en } }]
const worldCityPacks = new Map() // code -> { state: 'loading'|'ready'|'failed', cities, error }
/** 界面语言清单（与 00-i18n 的 LANGS 同一批）：国家名的四条名字就按这个顺序兜底。 */
const COUNTRY_NAME_LANGS = ['zh-CN', 'zh-TW', 'ja', 'en']
/** 国家名的本地化四条：取词时按当前语言解析，认不出该语言时逐级退回（zh-CN → en → code），
 *  最坏情况显示 ISO 码而不是空白。 */
function setWorldCountries(list) {
  if (!Array.isArray(list)) return false
  const out = []
  const seen = new Set()
  for (const c of list) {
    if (!isPlainObject(c)) continue
    const code = typeof c.code === 'string' ? c.code.trim().toUpperCase() : ''
    if (!code || seen.has(code)) continue
    const names = {}
    let any = false
    for (const lang of COUNTRY_NAME_LANGS) {
      const v = isPlainObject(c.names) ? c.names[lang] : undefined
      if (typeof v === 'string' && v.trim()) { names[lang] = v.trim(); any = true }
    }
    // 旧 Host（或别处塞进来的）只给 `name`：当作默认语言那一份，照常可用
    if (!any && typeof c.name === 'string' && c.name.trim()) { names['zh-CN'] = c.name.trim(); any = true }
    if (!any) continue
    seen.add(code)
    out.push({ code, names, count: Number(c.count) || 0 })
  }
  if (out.length === 0) return false
  worldCountries = out
  return true
}
/** 取某个国家在当前语言下的名字（认不出就逐级退回，最后退回 ISO 码）。 */
function countryNameOf(entry, lang) {
  if (!entry || !isPlainObject(entry.names)) return ''
  const want = String(lang || '')
  return entry.names[want] || entry.names['zh-CN'] || entry.names.en || entry.code || ''
}
const worldCountriesOf = () => (worldCountries ? worldCountries.map((c) => Object.assign({}, c)) : [])
const countryPackOf = (code) => worldCityPacks.get(String(code === undefined || code === null ? '' : code).trim().toUpperCase()) || null
/** 拉某个国家的城市包。同一国家的并发调用共用同一条在途请求（Map 里先落 `loading`）。三种失败要能
 *  分开说，因为出路不同：`failed`（拉不到 → 重试）、`error: 'not-covered'`（Host 答 404：这个国家不在
 *  表里 → 用手填坐标）、以及正常但为空。 */
async function loadCountryCities(code) {
  const cc = String(code === undefined || code === null ? '' : code).trim().toUpperCase()
  if (!cc) return null
  const cur = worldCityPacks.get(cc)
  if (cur && (cur.state === 'ready' || cur.state === 'loading')) return cur
  worldCityPacks.set(cc, { state: 'loading', cities: [], error: '' })
  store.push({})
  try {
    if (typeof window === 'undefined' || typeof window.fetch !== 'function') throw new Error('当前环境不支持 fetch')
    const res = await window.fetch(AREAS_PATH + '?country=' + encodeURIComponent(cc), { headers: { accept: 'application/json' } })
    if (res && res.status === 404) {
      worldCityPacks.set(cc, { state: 'ready', cities: [], error: 'not-covered' })
      store.push({})
      return worldCityPacks.get(cc)
    }
    if (!res || !res.ok) throw new Error('HTTP ' + (res ? res.status : '?'))
    const data = await res.json()
    const cities = (Array.isArray(data && data.cities) ? data.cities : [])
      .filter((c) => isPlainObject(c) && typeof c.name === 'string' && validLatLon(c.lat, c.lon))
      .map((c) => ({ name: c.name, admin: typeof c.admin === 'string' ? c.admin : '', lat: c.lat, lon: c.lon }))
    worldCityPacks.set(cc, { state: 'ready', cities, error: '' })
  } catch (err) {
    worldCityPacks.set(cc, { state: 'failed', cities: [], error: String((err && err.message) || err) })
  }
  store.push({})
  return worldCityPacks.get(cc)
}
/** 测试钩子：清掉国家清单与已缓存的包。 */
function resetWorldCities() {
  worldCountries = null
  worldCityPacks.clear()
}

/** 发布机构名 → 行政区归属（大陆气象源用）：输入气象台的机构名（`气象台` 后缀去没去掉都可以），
 *  输出 `{ province, city, matched }`。三条规则：① **省名必须出现在机构名的开头**并取最长命中——
 *  不能全局搜索，省别名里有「海南」，而青海省的机构名是「青海省海南藏族自治州共和县气象台」，
 *  全局搜会把一条青海的预警归到海南省；② 市级在**省名之后的那一段**里找最长命中，用 `aliases`
 *  而不是只认显示名（显示名会挑到旧名，「毕节地区」对应气象台的「毕节市」）；③ 市级找不到时，
 *  若该省下**只有一个可选条目**（直辖市 / 港澳）就用它，否则返回 `city: ''` 由调用方走省级兜底。
 *  @returns {{ province: string, city: string, matched: boolean }|null} 表未加载时返回 null */
function cnAreaOf(org) {
  if (!cnAreas || cnAreas.length === 0) return null
  const s = String(org === undefined || org === null ? '' : org).trim()
  if (!s) return { province: '', city: '', matched: false }
  let prov = null
  let plen = 0
  for (const p of cnAreas) {
    for (const n of [p.name].concat(p.aliases || [])) {
      if (n.length > plen && s.startsWith(n)) { prov = p; plen = n.length }
    }
  }
  if (!prov) return { province: '', city: '', matched: false }
  const rest = s.slice(plen)
  let city = null
  let clen = 0
  for (const c of prov.cities) {
    for (const n of [c.name].concat(c.aliases || [])) {
      if (n.length > clen && rest.indexOf(n) !== -1) { city = c; clen = n.length }
    }
  }
  if (!city && prov.cities.length === 1) city = prov.cities[0]
  return { province: prov.name, city: city ? city.name : '', matched: true }
}

// ---------- addr → 市町村对应 ----------
// 551 的 points[].addr 与市町村全称有一批写法差异（政令市短名、重名消歧前缀、北海道支庁名、仮名表记），
// 匹配前先统一到所属市町村全称；认不出的返回 null，调用方据此放行。
const HOKKAIDO_BRANCHES = [
  '石狩', '後志', '空知', '渡島', '檜山', '胆振', '日高', '上川', '留萌', '宗谷',
  '網走', '北見', '紋別', '十勝', '釧路', '根室',
]
function cityAliases(city, pref) {
  const out = [city]
  const m = /^(.+市)(.+区)$/.exec(city)
  if (m) out.push(m[1].slice(0, -1) + m[2])
  else if (/区$/.test(city)) out.push('東京' + city)
  if (pref) {
    // 只削 県 / 都 / 府：「北海道」削出来是「北海」，会给北海道的每个市町村造一条幻影别名
    const short = String(pref).replace(/[都府県]$/, '')
    if (short && short !== pref) out.push(short + city)
  }
  if (pref === '北海道') {
    for (const b of HOKKAIDO_BRANCHES) { out.push(b + city); out.push(b + '地方' + city) }
  }
  return out
}
let addrAliasIndex = null // Map<统一后的别名, 市町村全称>
let addrAliasMax = 0
function buildAddrIndex() {
  const idx = new Map()
  let max = 0
  if (cityTable) {
    for (const pref of Object.keys(cityTable)) {
      for (const city of cityTable[pref]) {
        for (const alias of cityAliases(city, pref)) {
          const a = normKana(alias)
          if (!idx.has(a)) idx.set(a, city)
          if (a.length > max) max = a.length
        }
      }
    }
  }
  addrAliasIndex = idx
  addrAliasMax = max
}
// addr → 市町村全称（最长前缀命中）；认不出返回 null
function lookupAddrCity(area) {
  if (!addrAliasIndex || addrAliasIndex.size === 0) return null
  const a = normKana(area)
  for (let len = Math.min(addrAliasMax, a.length); len >= 2; len--) {
    const hit = addrAliasIndex.get(a.slice(0, len))
    if (hit) return hit
  }
  return null
}
// 配置里可能残留表里不存在的市町村名（手工改过配置 / 数据表更新）→ 表到位后清掉
function pruneUnknownCities() {
  if (!cityNameSet) return
  const cur = currentCfg()
  const kept = cur.watch.cities.filter((c) => cityNameSet.has(c))
  if (kept.length === cur.watch.cities.length) return
  applyCfg(Object.assign({}, cur, { watch: Object.assign({}, cur.watch, { cities: kept }) }))
}
/** 清掉「所属都道府县已经不在关注列表里」的市町村。设置页取消关注某个县时的清理**依赖市町村表**
 *（表未就绪时 `citiesOfPref` 返回空数组，清理会悄悄失灵）；县归不出来且整条消息没有任何区域能归到县
 *  时会落到市级比对，残留条目仍可能多报一次，表就绪后补做这一次清理即可消除。两个保守边界：
 *  **关注列表为空 = 全日本**（不清）；归属认不出的条目保留。 */
function pruneCitiesOfUnwatchedPrefs() {
  if (!cityPrefIndex) return
  const cur = currentCfg()
  const watched = (cur.watch && cur.watch.prefectures) || []
  if (watched.length === 0) return
  const cities = (cur.watch && cur.watch.cities) || []
  const kept = cities.filter((c) => {
    const prefs = prefsOfCity(c)
    if (prefs.length === 0) return true
    return prefs.some((p) => watched.indexOf(p) !== -1)
  })
  if (kept.length === cities.length) return
  applyCfg(Object.assign({}, cur, { watch: Object.assign({}, cur.watch, { cities: kept }) }))
}
let cityTableAbort = null // 在途请求的取消器（插件卸载时用）
async function loadCityTable() {
  if (cityTableState === 'loading' || cityTableState === 'ready') return cityTableState
  if (typeof window === 'undefined' || typeof window.fetch !== 'function') { cityTableState = 'failed'; return cityTableState }
  cityTableState = 'loading'
  store.push({})
  const AC = (typeof window !== 'undefined' && window) ? window.AbortController : undefined
  cityTableAbort = typeof AC === 'function' ? new AC() : null
  try {
    const init = { headers: { accept: 'application/json' } }
    if (cityTableAbort) init.signal = cityTableAbort.signal
    const res = await window.fetch(AREAS_PATH, init)
    if (!res || !res.ok) throw new Error('HTTP ' + (res ? res.status : '?'))
    const data = await res.json()
    const payload = isPlainObject(data) && isPlainObject(data.prefectures) ? data.prefectures : data
    if (!setCityTable(payload)) throw new Error('payload 不含市町村表')
    // 河川予報区域表随同一份响应下发；缺失只影响洪水，不影响既有功能
    if (isPlainObject(data) && Array.isArray(data.riverAreas)) setRiverAreas(data.riverAreas)
    // 中国行政区划表供设置页的三级级联；缺失只影响大陆源的"选城市"路径，被拒时记原因以便显示重试
    if (isPlainObject(data) && Array.isArray(data.cnAreas)) setCnAreas(data.cnAreas)
    else cnAreasFailed = '响应里没有 cnAreas'
    // 全球国家清单（城市本体按 `?country=` 分包另取）；缺失只影响「其他国家 / 地区」分支的城市列表
    if (isPlainObject(data) && Array.isArray(data.worldCountries)) setWorldCountries(data.worldCountries)
    pruneUnknownCities()
    // 再把"所属县已不在关注列表里"的市町村清掉（见该函数说明）
    pruneCitiesOfUnwatchedPrefs()
  } catch (err) {
    // 插件卸载造成的中止不算"失败"：下次装载应当能重试
    const aborted = !!(cityTableAbort && cityTableAbort.signal && cityTableAbort.signal.aborted)
    cityTableState = aborted ? 'idle' : 'failed'
  }
  cityTableAbort = null
  store.push({})
  return cityTableState
}
/** 插件卸载时调用：中止在途请求，免得卸载之后还去写 store / 用户配置。 */
function abortCityTableLoad() {
  if (cityTableAbort) {
    try { cityTableAbort.abort() } catch (err) { /* 已结束等忽略 */ }
    // 故意不在这里置空：loadCityTable 的 catch 要靠它的 signal 区分「被中止」与「真失败」
  }
}

/** 重试加载行政区划表，供设置页的「重试」按钮使用：`loadCityTable` 的守卫会把 `loading` / `ready`
 *  挡回去，而唯一的调用点是 15-entry 的 `ctx.effect`（只在插件装载时执行一次），一次瞬时失败就会让
 *  整场会话失去市町村表（市级收窄失效 → 多报、设置页选不出市町村、prune 不再运行）。 */
async function retryCityTable() {
  if (cityTableState === 'loading') return cityTableState
  cityTableState = 'idle'
  cnAreasFailed = ''
  return loadCityTable()
}


// 供测试钩子重置表状态
const resetCityTable = () => {
  abortCityTableLoad()
  cityTable = null; cityNameSet = null; cityTableState = 'idle'
  addrAliasIndex = null; addrAliasMax = 0; cityPrefIndex = null; riverAreas = null
  cnAreas = null
  cnAreasFailed = ''
}

/** 大陆表的状态：'idle' | 'ready' | 'failed'。设置页据此区分"加载中"与"失败"。 */
const cnAreasStateOf = () => (cnAreas ? 'ready' : (cnAreasFailed ? 'failed' : 'idle'))

export { AREAS_PATH, setCityTable, citiesOfPref, prefsOfCity, canonicalCityOf, normKana, setRiverAreas, riverAreaCities, cityAliases, buildAddrIndex, lookupAddrCity, pruneUnknownCities, pruneCitiesOfUnwatchedPrefs, loadCityTable, retryCityTable, abortCityTableLoad, cityTableState, resetCityTable, setCnAreas, cnAreasStateOf, cnProvinces, cnCitiesOf, cnPlaceOf, cnAreaOf, normAliases, setWorldCountries, worldCountriesOf, countryNameOf, countryPackOf, loadCountryCities, resetWorldCities }
