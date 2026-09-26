// ============================================================================
// dsh-quake-alert · client/src/04-city-table.js
//
// 作用：市区町村表与「观测点 addr → 市町村」归一。
// 内容：表的注入与规整（setCityTable/citiesOfPref/pruneUnknownCities）、
//       地名假名归一（normKana）与规范写法反查（canonicalCityOf）、
//       从 Host 只读路由拉表（loadCityTable）、写法变体展开（cityAliases）、
//       前缀索引（buildAddrIndex）与查询（lookupAddrCity）。
// 依赖：01-constants、02-storage、03-settings-bridge（pruneUnknownCities 会写配置）。
// 要点：気象庁/P2PQuake 的观测点名用短名与消歧写法（大阪北区茶屋町、福島伊達市、
//       渡島北斗市），必须先归一到市町村全称再比对，否则会大面积漏报；
//       河川区域表与 JMA 电文还可能与本表假名写法不同（南アルプス市 / 南あるぷす市），
//       所以「比对」与「反查」一律经 normKana，显示仍用本表写法。
// ============================================================================

import { PREF_SET } from './01-constants.js'
import { isPlainObject, own } from './02-storage.js'
import { currentCfg, applyCfg } from './03-settings-bridge.js'
import { store } from './07-store.js'

// ---------- 市区町村表（0.2.0）：Host 路由提供，Client 拉一次并缓存 ----------
// 全国约 1700+ 个市町村，体积不适合内联进 client bundle。Host 侧在
// /dsh-quake-alert/areas 返回 { prefectures: { "<都道府県>": ["市町村全称", ...] } }。
// 拉取失败时表保持为空，功能退化为「只能按都道府县关注」——不影响 M1 的任何行为。
const AREAS_PATH = '/dsh-quake-alert/areas'
let cityTable = null
let cityTableState = 'idle' // idle | loading | ready | failed
let cityNameSet = null // 全部市町村名（校验配置用）
let cityPrefIndex = null // Map<归一市町村名, { name: 规范写法, prefs: 都道府県[] }>：JMA 电文只给市町村名，要反查所属县
let riverAreas = null // Map<河川予報区域コード, { name, cities }>：指定河川洪水予報用

// ---------- 地名假名归一 ----------
// 気象庁的不同数据源对同一个市町村写法不一致，实测三类（0.3.2）：
//   ① 小写法不同：総務省コード表「金け崎町 / 六ゖ所村」↔ 河川区域 CSV「金ケ崎町 / 六ヶ所村」
//   ② 假名种类不同：総務省コード表「南あるぷす市」↔ 河川区域 CSV「南アルプス市」
//   ③ 旧写法：P2PQuake 观测点「龍ケ崎市」↔ 本表「龍け崎市」
// 归一步骤：先「平假名 → 片假名」（け→ケ、ゖ→ヶ），再把「ケ → ヶ」（小写化）。
// 两步都要：只做第一步的话「ケ」与「ヶ」会变得不相等，反而破坏既有的ケ/ヶ 等价。
// 结果只用于比较与反查，绝不用于显示——界面上一律用本表的规范写法。
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
  // 索引键走假名归一：外部写法（河川区域表 / JMA 电文）与本表写法不同时也要能查到
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
/** 市町村名 → 所属都道府県（写法差异已归一；重名时返回多个；表未加载或未收录时返回空数组）。 */
const prefsOfCity = (name) => {
  if (!cityPrefIndex) return []
  const hit = cityPrefIndex.get(normKana(name))
  return hit ? hit.prefs.slice() : []
}
/**
 * 市町村名 → 本表里的规范写法（写法差异已归一；表未加载或未收录时返回空字符串）。
 *
 * 为什么需要：用户勾选的市町村名来自本表（citiesOfPref），而 JMA 电文、河川区域表给的是
 * 外部写法。把外部写法直接写进 region.city，再与用户勾选的名字比对（indexOf）就会漏报；
 * 所以比对前先取规范名。表未加载时返回空串，调用方回退用原写法（宁可多报绝不漏报）。
 */
const canonicalCityOf = (name) => {
  if (!cityPrefIndex) return ''
  const hit = cityPrefIndex.get(normKana(name))
  return hit ? hit.name : ''
}

/**
 * 河川予報区域表（0.3.0-a 由 scripts/build-areas.mjs 生成，Host 随 /areas 一起下发）。
 * 指定河川洪水予報的电文区域是河川名（「天塩川」），必须先映射到市町村才能与用户关注比对。
 */
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

// ---------- 中国行政区划表（0.5.0）：Host 随 /areas 一起下发 ----------
// 与市区町村表同一理由：省 34 + 地级 384 共约 21KB，不内联进 client bundle。
// 用途是设置页的三级级联（中国 → 省 → 地级市）与**关注点坐标填充**：
// 大陆源（cenc_eew / cenc_eqlist）是坐标 + 半径匹配（DESIGN 8.3），
// 让用户手填经纬度不现实，由这张表按所选城市给出坐标。
// 表由 scripts/build-cn-areas.mjs 从 GeoNames 生成（含 TW/HK/MO），头部记着已知取舍。
let cnAreas = null // [{ code, name, aliases, lat, lon, cities:[{name,aliases,lat,lon}] }]
/**
 * 别名的规整：只留**有意义**的候选。
 *
 * 丢掉单字别名（"丽"这类会匹配到半个中国）与和显示名重复的项；上限 8 条，因为候选是长尾的
 * （个别条目有几十个历史名 / 罗马字音译），而匹配是**最长命中**，砍掉短名不影响建制全名。
 * 缺失 `aliases` 字段（Host 未升级 / 手写的旧数据）时返回空数组——**别名是增强，不是前提**。
 */
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
/**
 * 注入并规整行政区划表。**逐字段校验**：表来自 Host 的 JSON，与 localStorage 一样属于
 * "不可信的输入"——一个坏条目会让级联渲染出幽灵选项，或把用户带到错误的坐标上
 *（后者在预警产品里是"该响的地方没响"）。规整失败的整体拒绝，不做部分接受。
 */
function setCnAreas(list) {
  if (!Array.isArray(list)) return false
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
    // 没有下级的省级项在级联里是死路：直接丢弃，避免用户选中后按钮没反应
    if (cities.length === 0) continue
    seenProv.add(name)
    out.push({ code: typeof p.code === 'string' ? p.code : '', name, aliases: normAliases(p.aliases, name), lat: p.lat, lon: p.lon, cities })
  }
  if (out.length === 0) return false
  cnAreas = out
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
/**
 * 「省 + 市 + 半径」→ 一个关注点（表里查不到时返回 null）。
 *
 * 抽成纯函数是为了能直接断言级联的产物：用户点「添加」之后配置里到底会多出什么，
 * 比"界面上出现了两个下拉框"重要得多。名称取「省·市」以免两个省的"城区"撞名。
 *
 * `origin: 'cn'`（0.8.0 / DESIGN 9.3）：**关注点的来源分支**——用户在哪个国家的分支下加的
 * 点，那个国家的源就是该点的权威源（3.4 的跨源归并据此判断，诊断里也要能看到）。
 * 它只做标注，**不限制匹配范围**：一个坐标点对所有坐标型源（EMSC / USGS / NOAA）依然有效
 * （DESIGN 9.3 的"不锁死机制"：差异只能来自源本身，不能人为裁剪用户能关注哪里）。
 */
function cnPlaceOf(province, city, radiusKm) {
  if (!cnAreas) return null
  const p = cnAreas.find((x) => x.name === province)
  if (!p) return null
  const c = p.cities.find((x) => x.name === city)
  if (!c) return null
  const r = Number(radiusKm)
  if (!Number.isFinite(r) || r < 1 || r > 2000) return null
  return { name: province + '·' + city, lat: c.lat, lon: c.lon, radiusKm: r, origin: 'cn' }
}

// ---------- 全球主要城市表（0.8.0 / DESIGN 9.4：按国家分包，展开某国时才拉） ----------
// 为什么不内联：整表 5224 条城市约 375KB 源码。用户只会关注一两个国家，所以 Host 按
// `?country=XX` **分包下发**，这里按需拉取并缓存——同一国家只拉一次。
let worldCountries = null // [{ code, name, count }]，随 /areas 一次性拿到（约 160 条）
const worldCityPacks = new Map() // code -> { state: 'loading'|'ready'|'failed', cities, error }
function setWorldCountries(list) {
  if (!Array.isArray(list)) return false
  const out = []
  const seen = new Set()
  for (const c of list) {
    if (!isPlainObject(c)) continue
    const code = typeof c.code === 'string' ? c.code.trim().toUpperCase() : ''
    const name = typeof c.name === 'string' ? c.name.trim() : ''
    if (!code || !name || seen.has(code)) continue
    seen.add(code)
    out.push({ code, name, count: Number(c.count) || 0 })
  }
  if (out.length === 0) return false
  worldCountries = out
  return true
}
const worldCountriesOf = () => (worldCountries ? worldCountries.slice() : [])
const countryPackOf = (code) => worldCityPacks.get(String(code === undefined || code === null ? '' : code).trim().toUpperCase()) || null
/**
 * 拉某个国家的城市包。
 *
 * 同一国家的并发调用共用同一条在途请求（Map 里先落 `loading`）。三种失败要能分开说，
 * 因为出路不同：`failed`（拉不到 → 重试 / 重启 dsh web）、`error: 'not-covered'`
 *（Host 明确答 404：这个国家不在表里 → 用手填坐标）、以及正常但为空。
 */
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

/**
 * 发布机构名 → 行政区归属（0.5.2，大陆气象源用）。
 *
 * 输入是气象台的机构名（`气象台` 后缀已去掉或未去掉都可以），例如
 * `云南省丽江市宁蒗彝族自治县气象台`。输出 `{ province, city, matched }`。
 *
 * 三条规则，全部由 238 条真实样本定出来（见 DESIGN 8.5 的实测记录）：
 *  ① **省名必须出现在机构名的开头**，取最长命中。不能改成"全局搜索"：省别名里有
 *     「海南」，而青海省的机构名是「青海省海南藏族自治州共和县气象台」——全局搜会把
 *     一条青海的预警归到海南省，那是最难查的一类错误（名字看着对、地方错了几百公里）。
 *     实测 238 条**全部**以省名开头，所以这个约束不损失覆盖。
 *  ② 市级在**省名之后的那一段**里找最长命中，用 `aliases`（GeoNames 的全部中文候选）而不是
 *     只认显示名——实测显示名会挑到旧名（「毕节地区」对应气象台的「毕节市」、
 *     「思茅市」对应「普洱市」），只认显示名会让这些预警退化成"仅省"。
 *  ③ 市级找不到时，若该省下**只有一个可选条目**（直辖市 / 港澳），就用它：
 *     「上海市浦东新区气象台」的省名之后不含"上海市"，但上海市的关注点确实该响。
 *     其余情况返回 `city: ''`——由调用方走**省级兜底**（宁可多报，绝不漏报，DESIGN 8.5）。
 *
 * @param {unknown} org 机构名
 * @returns {{ province: string, city: string, matched: boolean }|null} 表未加载时返回 null
 */
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

// ---------- addr → 市町村归一 ----------
// 気象庁 / P2PQuake 的观测点名（551 的 points[].addr）与市町村全称有一批写法差异，
// 匹配前先把 addr 归一到它所属的市町村全称；归一不了的（机场、区域名、未收录点）返回 null，
// 调用方据此放行——宁可多提醒一次，也绝不因为写法差异漏报。
//
// 已覆盖的差异（均来自实测的直播 addr）：
//   ① 政令市短名：大阪北区茶屋町       ← 大阪市北区
//   ② 特别区加县短名：東京千代田区大手町 ← 千代田区
//   ③ 重名消歧前缀：福島伊達市          ← 伊達市（福島県）
//   ④ 北海道支庁名：渡島北斗市 / 日高地方日高町 ← 北斗市 / 日高町
//   ⑤ 仮名表记：龍ケ崎市 ↔ 龍け崎市（归一函数见文件上方 normKana：平假名→片假名 + ケ→ヶ）
const HOKKAIDO_BRANCHES = [
  '石狩', '後志', '空知', '渡島', '檜山', '胆振', '日高', '上川', '留萌', '宗谷',
  '網走', '北見', '紋別', '十勝', '釧路', '根室',
]
// 展开一个市町村全称的全部书写变体
function cityAliases(city, pref) {
  const out = [city]
  const m = /^(.+市)(.+区)$/.exec(city)
  if (m) out.push(m[1].slice(0, -1) + m[2])
  else if (/区$/.test(city)) out.push('東京' + city)
  if (pref) {
    const short = String(pref).replace(/[都道府県]$/, '')
    if (short && short !== pref) out.push(short + city)
  }
  if (pref === '北海道') {
    for (const b of HOKKAIDO_BRANCHES) { out.push(b + city); out.push(b + '地方' + city) }
  }
  return out
}
let addrAliasIndex = null // Map<归一后的别名, 市町村全称>
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
// addr → 市町村全称（最长前缀命中）；无法归一返回 null
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
let cityTableAbort = null // 在途请求的取消器（插件卸载时用）
async function loadCityTable() {
  if (cityTableState === 'loading' || cityTableState === 'ready') return cityTableState
  if (typeof window === 'undefined' || typeof window.fetch !== 'function') { cityTableState = 'failed'; return cityTableState }
  cityTableState = 'loading'
  store.push({})
  // 经 window 取 AbortController：浏览器里就是它，沙箱测试也只需注入 window 上的实现
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
    // 0.3.0：河川予報区域表随同一份响应下发；缺失只影响洪水，不影响泥石流与既有功能
    if (isPlainObject(data) && Array.isArray(data.riverAreas)) setRiverAreas(data.riverAreas)
    // 0.5.0：中国行政区划表（省 → 地级市 + 坐标），供设置页的三级级联。
    // 缺失只影响大陆源的"选城市"这条路径（仍可手填坐标），不影响日本链路与既有功能。
    if (isPlainObject(data) && Array.isArray(data.cnAreas)) setCnAreas(data.cnAreas)
    // 0.8.0：全球国家清单（城市本体按 `?country=` 分包另取，见 loadCountryCities）。
    // 缺失只影响「其他国家 / 地区」分支的城市列表，手填坐标那条路照常可用。
    if (isPlainObject(data) && Array.isArray(data.worldCountries)) setWorldCountries(data.worldCountries)
    pruneUnknownCities()
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
    // 故意不在这里置空：loadCityTable 的 catch 要靠它的 signal 区分「被中止」与「真失败」，
    // 置空由 loadCityTable 收尾时统一做（abort 幂等，重复调用无害）。
  }
}


// 供单测钩子重置表状态
const resetCityTable = () => {
  abortCityTableLoad()
  cityTable = null; cityNameSet = null; cityTableState = 'idle'
  addrAliasIndex = null; addrAliasMax = 0; cityPrefIndex = null; riverAreas = null
  cnAreas = null
}

export { AREAS_PATH, setCityTable, citiesOfPref, prefsOfCity, canonicalCityOf, normKana, setRiverAreas, riverAreaCities, cityAliases, buildAddrIndex, lookupAddrCity, pruneUnknownCities, loadCityTable, abortCityTableLoad, cityTableState, resetCityTable, setCnAreas, cnProvinces, cnCitiesOf, cnPlaceOf, cnAreaOf, normAliases, setWorldCountries, worldCountriesOf, countryPackOf, loadCountryCities, resetWorldCities }
