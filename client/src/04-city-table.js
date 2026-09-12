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
}

export { AREAS_PATH, setCityTable, citiesOfPref, prefsOfCity, canonicalCityOf, normKana, setRiverAreas, riverAreaCities, cityAliases, buildAddrIndex, lookupAddrCity, pruneUnknownCities, loadCityTable, abortCityTableLoad, cityTableState, resetCityTable }
