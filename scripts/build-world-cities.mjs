#!/usr/bin/env node
// dsh-quake-alert · 全球主要城市表（按国家分包）构建脚本
//
// 作用：把 GeoNames 的 cities15000 dump（人口 > 1.5 万的城镇）加工成 lib/data/world-cities.js，
//       供设置页「其他国家 / 地区」分支的城市列表使用（全球源与海外气象源都是坐标 + 半径匹配）。
//       收录门槛是人口 10 万（约 4000 条）；日本与中国（含台港澳）有专门分支，不进本表。
//       按国家分包：展开某国时才经只读路由（/areas?country=XX）拉那一包。
// 来源（只有构建时联网；CC BY 4.0，出典明記で利用可）：GeoNames 的 cities15000.zip 与 admin1CodesASCII.txt。
//
// 用法：
//   node scripts/build-world-cities.mjs                # 联网取源 → 生成 lib/data/world-cities.js
//   node scripts/build-world-cities.mjs --check         # 只校验产物是否与当前源一致（不写入文件）
//   node scripts/build-world-cities.mjs --from <目录>    # 用本地已下载的文件（离线 / 回归用）

import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { createGeoReader, latinCityNameOf, parseGeonames } from './lib/geonames.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const OUT = path.join(ROOT, 'lib', 'data', 'world-cities.js')
const CHECK_ONLY = process.argv.includes('--check')
const fromIdx = process.argv.indexOf('--from')
const FROM_DIR = fromIdx === -1 ? null : process.argv[fromIdx + 1]

/** 收录门槛：人口 10 万以上。 */
const MIN_POP = 100000
/** 已有专门分支的国家 / 地区（见文件头）。 */
const OWN_BRANCH = new Set(['JP', 'CN', 'TW', 'HK', 'MO'])
/** 城市名长度上限：GeoNames 里有个别超长名（含括号注释），截断以免撑坏列表布局。 */
const NAME_MAX = 20

/** 界面语言的四种（与 client/src/00-i18n.js 的 LANGS 同一批）。 */
const LANGS = ['zh-CN', 'zh-TW', 'ja', 'en']
/** 国家 / 地区名交给 ICU（Node 自带 full-icu 数据），四种界面语言各一份（与 client/src/00-i18n.js 的 LANGS 同一批）。 */
const regionNames = {}
for (const lang of LANGS) {
  try { regionNames[lang] = new Intl.DisplayNames([lang], { type: 'region' }) } catch (err) { regionNames[lang] = null }
}
function countryNamesOf(cc, fallback) {
  const out = {}
  for (const lang of LANGS) {
    let n = ''
    const dn = regionNames[lang]
    if (dn) {
      try {
        const got = dn.of(cc)
        if (got && got !== cc) n = got
      } catch (err) { /* 非标准码（如 XK）：退回已有名字 */ }
    }
    out[lang] = n || fallback || String(cc)
  }
  return out
}

/**
 * 城市名：统一取拉丁字母名（`latinCityNameOf`，见 scripts/lib/geonames.mjs）——同一张表里不混简繁与
 * 日汉字；按界面语言本地化需要 GeoNames 带语言标签的候选（`alternateNamesV2`），本表不依赖它。
 */
const cityNameOf = (row) => latinCityNameOf(row)

/** admin1CodesASCII.txt（`US.CA\tCalifornia\tCalifornia\t5332921`）→ { 'US.CA': 'California' } */
function parseAdmin1(text) {
  const map = new Map()
  for (const line of String(text).split('\n')) {
    if (!line) continue
    const c = line.split('\t')
    if (c.length < 2 || !c[0]) continue
    map.set(c[0], c[1])
  }
  return map
}

const round2 = (v) => (Number.isFinite(v) ? Math.round(v * 100) / 100 : 0)

async function build() {
  const problems = []
  const { readSource, txtOf } = createGeoReader({ fromDir: FROM_DIR })
  const rows = parseGeonames(txtOf(await readSource('cities15000.zip'), 'cities15000'))
  const admin1 = parseAdmin1(await readSource('admin1CodesASCII.txt'))

  const byCountry = new Map()
  let belowMin = 0
  let ownBranch = 0
  let noName = 0
  for (const r of rows) {
    if (r.pop < MIN_POP) { belowMin += 1; continue }
    if (!r.cc || OWN_BRANCH.has(r.cc)) { ownBranch += 1; continue }
    if (!Number.isFinite(r.lat) || !Number.isFinite(r.lon)) { problems.push('坐标非法：' + r.name + '（' + r.cc + '）'); continue }
    const name = cityNameOf(r).slice(0, NAME_MAX)
    if (!name) { noName += 1; continue }
    if (!byCountry.has(r.cc)) byCountry.set(r.cc, [])
    byCountry.get(r.cc).push({
      name,
      admin: admin1.get(r.cc + '.' + r.admin1) || '',
      lat: round2(r.lat),
      lon: round2(r.lon),
      pop: r.pop,
    })
  }

  const countries = []
  const packs = {}
  for (const [cc, list] of byCountry) {
    // 人口降序：列表顶部就是该国最知名的城市，用户不必翻几百条找"纽约"
    list.sort((a, b) => (b.pop - a.pop) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    // 同国内同名（不同一级行政区）的两条：把行政区附到名字后面，否则列表里两条一模一样、没法选对。
    const dup = new Map()
    for (const c of list) dup.set(c.name, (dup.get(c.name) || 0) + 1)
    for (const c of list) {
      if (dup.get(c.name) > 1 && c.admin) c.name = (c.name + '（' + c.admin + '）').slice(0, NAME_MAX + 24)
      delete c.pop // 人口只用于排序，不下发
    }
    packs[cc] = list
    countries.push({ code: cc, names: countryNamesOf(cc), count: list.length })
  }
  // 排序用默认语言那一份名字（数据里是本地化四条 `names`，没有单数的 `name` 字段）；顺序只决定
  // 数据文件里各国的排列，设置页会按当前语言重排。
  const sortName = (c) => String((c.names && c.names['zh-CN']) || c.code)
  countries.sort((a, b) => sortName(a).localeCompare(sortName(b), 'zh') || a.code.localeCompare(b.code))
  return { countries, packs, problems, stats: { belowMin, ownBranch, noName } }
}

function render(countries, packs) {
  const total = countries.reduce((n, c) => n + c.count, 0)
  const lines = []
  lines.push('// 全球主要城市表（人口 > 10 万，按国家分包）——由 scripts/build-world-cities.mjs 生成，请勿直接编辑。')
  lines.push('// 来源：GeoNames cities15000 dump（CC BY 4.0）+ admin1CodesASCII.txt 的一级行政区名。')
  lines.push('// 坐标是 GeoNames 给出的城市点位（不是行政区中心点），用于「关注点 + 半径」匹配。')
  lines.push('// 覆盖：' + countries.length + ' 个国家 / 地区、' + total + ' 个城市。不包含日本与中国（含台港澳）：那两个地区在设置页里有自己的')
  lines.push('// 分支与匹配语义（日本按行政区名、中国按省 / 地级市）。')
  lines.push('// 城市名统一拉丁（取 GeoNames 的 asciiname，缺失时退回 name），规则在 scripts/lib/geonames.mjs 的')
  lines.push('// latinCityNameOf；同国内重名的城市把一级行政区用全角括号附在后面（Springfield（Illinois））。')
  lines.push('// 国家 / 地区名是本地化的四条（由 ICU 算出）。admin 只用于展示与区分，不参与匹配：匹配永远是「坐标 + 半径」。')
  lines.push('')
  lines.push('/** 国家 / 地区清单（供设置页的国家选择器；count = 该国城市数）。 */')
  lines.push('export const WORLD_COUNTRIES = [')
  for (const c of countries) {
    lines.push('  { code: ' + JSON.stringify(c.code) + ', count: ' + c.count + ', names: ' + JSON.stringify(c.names) + ' },')
  }
  lines.push(']')
  lines.push('')
  lines.push('/** 按国家分包的城市表（`/areas?country=XX` 只下发其中一包）。 */')
  lines.push('export const WORLD_CITIES_BY_COUNTRY = {')
  for (const c of countries) {
    lines.push('  ' + JSON.stringify(c.code) + ': [')
    for (const city of packs[c.code]) {
      lines.push('    { name: ' + JSON.stringify(city.name) +
        (city.admin ? ', admin: ' + JSON.stringify(city.admin) : '') +
        ', lat: ' + city.lat + ', lon: ' + city.lon + ' },')
    }
    lines.push('  ],')
  }
  lines.push('}')
  lines.push('')
  return lines.join('\n')
}

// ---------------------------------------------------------------- main
const { countries, packs, problems, stats } = await build()
if (problems.length) {
  console.error('构建中发现 ' + problems.length + ' 处问题：')
  for (const p of problems.slice(0, 20)) console.error('  · ' + p)
  if (problems.length > 20) console.error('  … 其余 ' + (problems.length - 20) + ' 条省略')
}
const code = render(countries, packs)
const total = countries.reduce((n, c) => n + c.count, 0)
console.log('国家 / 地区 ' + countries.length + '，城市 ' + total + '，产物 ' + code.length + ' 字符' +
  '（低于门槛 ' + stats.belowMin + '，属专门分支 ' + stats.ownBranch + '，无名 ' + stats.noName + '）')

if (CHECK_ONLY) {
  let cur = ''
  try { cur = readFileSync(OUT, 'utf8') } catch { /* 不存在视为陈旧 */ }
  if (cur === code) { console.log('lib/data/world-cities.js 已是最新。'); process.exit(problems.length ? 1 : 0) }
  console.error('lib/data/world-cities.js 已陈旧：请运行 node scripts/build-world-cities.mjs')
  process.exit(1)
}
writeFileSync(OUT, code, 'utf8')
console.log('已写入 lib/data/world-cities.js')
process.exit(problems.length ? 1 : 0)
