#!/usr/bin/env node
// dsh-quake-alert · 全球主要城市表（按国家分包）构建脚本
//
// 作用：把 GeoNames 的 cities15000 dump（人口 > 1.5 万的城镇）加工成 lib/data/world-cities.js，
//       供设置页「其他国家 / 地区」分支的城市列表使用。
//
// 为什么需要它（DESIGN 9.4）：全球源（EMSC / USGS）与海外气象源（美国 NWS / 加拿大 ECCC）都是
// 「坐标 + 半径」匹配，而让用户手填经纬度是不现实的——尤其当他想关注的其实是"我住的城市"。
// 日本有都道府县表、中国有省 / 地级市表，其他国家此前只有手填坐标这一条路。
//
// 为什么门槛是人口 10 万：DESIGN 9.4 定的。完整做到"县 / 区"会到十万量级（不可行），
// 而全球人口 10 万以上的城镇约 4000 条——足以覆盖"我住哪、家人在哪"。
//
// 为什么**按国家分包**：整表约 240KB（JS 源码）。用户只会关注一两个国家，一次全下发对设置页
// 是明显浪费，所以复用同一条只读路由（/areas?country=XX），展开某国时才拉那一包。
//
// 挑选规则（与 build-cn-areas 的中文建制名规则**不同**，所以两边没有共用挑选函数）：
//   · 城市名：**统一取 asciiname（拉丁字母名）**。0.9.4（PD-3）之前是"alternatenames 里的纯汉字
//     候选优先（取最短的一个）"，结果同一张表里简繁与日汉字混用；按界面语言本地化需要带语言
//     标签的候选（GeoNames 的 alternateNamesV2，另一个大得多的下载），做不到就统一用拉丁文
//     ——用户选定的备选做法，也是唯一不依赖额外数据源的做法。数据已按此重生成（见 cityNameOf）。
//     与中国行政区表的差别也在这里：那边"没有中文名"要记为问题（必须用中文建制名）。
//   · admin1（一级行政区）名取自 admin1CodesASCII.txt，唯一用途是**区分同国内的同名城市**
//     （美国有多个同名城市），列表里显示成「城市（州）」。
//
// **有专门分支的国家不进这张表**：日本走都道府县、中国（含台港澳）走省 / 地级市。
// 混进来会让"其他国家 / 地区"分支里冒出日本城市，与它自己的分支重复、且匹配语义也不同。
//
// 来源（只有构建时联网；CC BY 4.0，出典明記で利用可）：
//   https://download.geonames.org/export/dump/cities15000.zip
//   https://download.geonames.org/export/dump/admin1CodesASCII.txt
//
// 用法：
//   node scripts/build-world-cities.mjs                # 联网取源 → 生成 lib/data/world-cities.js
//   node scripts/build-world-cities.mjs --check         # 只校验产物是否与当前源一致（不写盘）
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

/** 收录门槛（DESIGN 9.4）。 */
const MIN_POP = 100000
/** 已有专门分支的国家 / 地区（见文件头）。 */
const OWN_BRANCH = new Set(['JP', 'CN', 'TW', 'HK', 'MO'])
/** 城市名长度上限：GeoNames 里有个别超长名（含括号注释），截断以免撑坏列表布局。 */
const NAME_MAX = 20

/** 界面语言的四种（与 client/src/00-i18n.js 的 LANGS 同一批）。 */
const LANGS = ['zh-CN', 'zh-TW', 'ja', 'en']
/**
 * 国家 / 地区名交给 ICU（Node 自带 full-icu 数据），**四种语言各一份**，不手抄对照表。
 *
 * 0.9.4（PD-3）：此前只算 `zh-CN` 一份并写死进数据，于是把界面语言切成日本語 / English 时，
 * 国家下拉仍然是简体中文——设置页其他部分都本地化了，只有这一块没有。
 */
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
 * 城市名：**统一取拉丁字母名**（`latinCityNameOf`，见 scripts/lib/geonames.mjs 的说明）。
 *
 * 0.9.4（PD-3，产品决策）：此前是"alternatenames 里的 CJK 候选优先（取最短的一个）"，
 * 结果是同一张表里简繁与日汉字混用。按界面语言本地化需要带语言标签的候选（`alternateNamesV2`，
 * 另一个大得多的下载），做不到就统一用拉丁文——这是用户选定的备选做法，也是唯一不依赖额外
 * 数据源的做法。
 *
 * 数据已经按这条规则重生成过：`lib/data/world-cities.js` 现在 5224 条城市名里**一个汉字都没有**
 * （Rome / Milan / New York City …），国家名仍是本地化四条。命令：
 * `node scripts/build-world-cities.mjs --from <放着 cities15000.zip 与 admin1CodesASCII.txt 的目录>`
 * （联网时省略 `--from`，脚本自己下载）。
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
    // 同国内同名（不同一级行政区）的两条：把行政区附到名字后面。
    // 不做这一步的话，列表里会出现两条一模一样的「斯普林菲尔德」，用户没法选对。
    const dup = new Map()
    for (const c of list) dup.set(c.name, (dup.get(c.name) || 0) + 1)
    for (const c of list) {
      if (dup.get(c.name) > 1 && c.admin) c.name = (c.name + '（' + c.admin + '）').slice(0, NAME_MAX + 24)
      delete c.pop // 人口只用于排序，不下发
    }
    packs[cc] = list
    countries.push({ code: cc, names: countryNamesOf(cc), count: list.length })
  }
  // 排序按**默认语言那一份**名字（数据里是本地化四条 `names`，没有单数的 `name` 字段）。
  // 0.9.4 修订：改成本地化四条时漏改了这里（`a.name` 变成 undefined），而这个脚本当时因为
  // 网络不可达一直没跑过——所以运行时才炸。设置页会按当前语言重排（见 countryNameOf 的用法），
  // 这里的顺序只决定数据文件里各国的排列，取 zh-CN 是为了与既有审阅习惯一致。
  const sortName = (c) => String((c.names && c.names['zh-CN']) || c.code)
  countries.sort((a, b) => sortName(a).localeCompare(sortName(b), 'zh') || a.code.localeCompare(b.code))
  return { countries, packs, problems, stats: { belowMin, ownBranch, noName } }
}

function render(countries, packs) {
  const total = countries.reduce((n, c) => n + c.count, 0)
  const lines = []
  lines.push('// 全球主要城市表（人口 > 10 万，按国家分包）——由 scripts/build-world-cities.mjs 生成，请勿直接编辑。')
  lines.push('//')
  lines.push('// 来源：GeoNames cities15000 dump（CC BY 4.0）+ admin1CodesASCII.txt 的一级行政区名。')
  lines.push('// 坐标是 GeoNames 给出的城市点位（不是行政区中心点），用于「关注点 + 半径」匹配。')
  lines.push('//')
  lines.push('// 覆盖：' + countries.length + ' 个国家 / 地区、' + total + ' 个城市。')
  lines.push('// **不包含日本与中国（含台港澳）**——那两个地区在设置页里有自己的分支与匹配语义')
  lines.push('//（日本按行政区名、中国按省 / 地级市），混进来既重复又会让匹配口径含糊。')
  lines.push('//')
  lines.push('// 城市名：**统一拉丁**（0.9.4 / PD-3）——取 GeoNames 的 asciiname，缺失时退回 name。')
  lines.push('// 规则在 scripts/lib/geonames.mjs 的 latinCityNameOf；此处原先写的是"alternatenames 里的中文')
  lines.push('// 候选优先"，那条路已废弃（CJK 候选简繁与日汉字混用——罗马写作「羅馬」而它的一级行政区是')
  lines.push('// 拉丁文的 Lazio；真要本地化需要 GeoNames 带语言标签的 alternateNamesV2，是另一个大得多的下载）。')
  lines.push('// 同一个国家内重名的城市会把一级行政区用**全角括号**附在后面（Springfield（Illinois）），')
  lines.push('// 否则列表里两条一模一样的名字无法区分。国家 / 地区名则是本地化的四条（由 ICU 算出）。')
  lines.push('//')
  lines.push('// admin 只用于**展示与区分**，不参与匹配：匹配永远是「坐标 + 半径」。')
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
