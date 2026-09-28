#!/usr/bin/env node
// dsh-quake-alert · 中国行政区划表（省 → 地级市，带坐标）构建脚本
//
// 作用：把 GeoNames 的 CN / TW / HK / MO dump 加工成 lib/data/cn-areas.js，供设置页
//       「国家 → 一级行政区 → 市」级联与关注点坐标填充使用（大陆源是坐标 + 半径匹配）。
//       只做省 + 地级市两级：气象源的预警标题自带完整机构链（省 + 市 + 县），县一级不在本表内。
//       aliases 是该条目在 alternatenames 里的其余中文候选，只参与匹配、不进 UI。
// 来源（只有构建时联网；CC BY 4.0，出典明記で利用可）：GeoNames dump 的 ADM1 / ADM2 条目；
//       zip 解压用 Node 内置 zlib（scripts/lib/zip.mjs）。
//
// 用法：
//   node scripts/build-cn-areas.mjs                 # 联网取源 → 生成 lib/data/cn-areas.js
//   node scripts/build-cn-areas.mjs --check         # 只校验产物是否与当前源一致（不写入文件）
//   node scripts/build-cn-areas.mjs --from <目录>    # 用本地已下载的 zip（离线 / 回归测试用）

import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
// dump 读取与按列解析来自 scripts/lib/geonames.mjs：与 build-world-cities.mjs 共用同一套解析器。
import { createGeoReader, isCjk, parseGeonames } from './lib/geonames.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const OUT = path.join(ROOT, 'lib', 'data', 'cn-areas.js')
const BASE = 'https://download.geonames.org/export/dump/'
const CHECK_ONLY = process.argv.includes('--check')
const fromIdx = process.argv.indexOf('--from')
const FROM_DIR = fromIdx === -1 ? null : process.argv[fromIdx + 1]

const COUNTRIES = ['CN', 'TW', 'HK', 'MO']

// ---------------------------------------------------------------- 取值工具
const { readSource, txtOf } = createGeoReader({ fromDir: FROM_DIR })
/**
 * 中文名候选的层级相关优先级：省级表把 `省/自治区/特别行政区` 排最高；市级表反过来把 `省` 压到最低
 *（一个"市"的候选里出现"省"几乎必然是旧名），并把日文变体（県）排除。
 */
const PROVINCE_RANK = [
  [/特别行政区$/, 10], [/省$/, 9], [/自治区$/, 8], [/市$/, 7],
  [/自治州$/, 5], [/地区$/, 3], [/盟$/, 3],
]
const CITY_RANK = [
  [/市$/, 9], [/自治州$/, 8], [/盟$/, 7], [/地区$/, 6],
  [/自治县$/, 5], [/[县縣]$/, 5], [/[区區]$/, 4], [/省$/, 1],
]
function rankOf(name, table) {
  for (const [re, r] of table) if (re.test(name)) return r
  return 2 // 没有行政区后缀的短名（如「成都」「雲林」）：能接受，但排在完整建制名之后
}
/** 候选是否**是中文**：日文特有的字形（県）不算——中文区划名里不会出现它。 */
const isChineseName = (s) => !/県/.test(s)
/**
 * 从 alternatenames 挑中文名：按建制后缀优先级，同级取更长的一个；没有纯中文候选时返回空串
 *（由调用方记为"问题"，不回退成罗马字名——罗马字混进中文界面更容易让人误选）。
 * @param {string} alternates GeoNames 的 alternatenames 字段（逗号分隔）
 * @param {'province'|'city'} level
 */
function pickChineseName(alternates, level) {
  const table = level === 'province' ? PROVINCE_RANK : CITY_RANK
  const all = String(alternates || '').split(',').filter(isCjk)
  const prefer = all.filter(isChineseName)
  const zh = prefer.length ? prefer : all // 极端情况：只有日文变体，那就只能用它
  if (zh.length === 0) return ''
  zh.sort((a, b) => (rankOf(b, table) - rankOf(a, table)) || (b.length - a.length))
  return zh[0] || ''
}

/**
 * 同一记录在 GeoNames 里的全部中文候选（去掉与显示名重复的），只供匹配用；与 pickChineseName 同源同批，
 * 否则「显示的名字」与「能匹配上的名字」会脱节（显示名可能挑到旧名，气象台写的是自己的建制名）。
 * 上限 MAX_ALIASES：候选数量是长尾的，匹配是最长命中，砍掉的短名不会让完整建制名失效。
 * @param {string} alternates
 * @param {string} displayName pickChineseName 的结果（从别名里排除）
 * @param {'province'|'city'} level
 */
function aliasesOf(alternates, displayName, level) {
  const table = level === 'province' ? PROVINCE_RANK : CITY_RANK
  const all = String(alternates || '').split(',').filter(isCjk).filter(isChineseName)
  const seen = new Set()
  const out = []
  for (const n of all) {
    if (n === displayName || n.length < 2 || seen.has(n)) continue
    seen.add(n)
    out.push(n)
  }
  out.sort((a, b) => (rankOf(b, table) - rankOf(a, table)) || (b.length - a.length))
  return out.slice(0, MAX_ALIASES)
}
/** 别名上限：见 aliasesOf 的说明。 */
const MAX_ALIASES = 8

// ---------------------------------------------------------------- 组装
/** 取一个国家的地理条目，切成 ADM1（省级）与 ADM2（地级）。 */
function admOf(rows) {
  const adm1 = []
  const adm2 = []
  for (const r of rows) {
    if (r.feature === 'ADM1') adm1.push(r)
    else if (r.feature === 'ADM2') adm2.push(r)
  }
  return { adm1, adm2 }
}

function build() {
  const problems = []
  const provinces = []
  return (async () => {
    // CN：ADM1 = 省级，ADM2 = 地级
    const cnEntries = await readSource('CN.zip')
    const cn = admOf(parseGeonames(txtOf(cnEntries, 'CN')))
    const byAdmin1 = new Map()
    for (const c of cn.adm2) {
      if (!byAdmin1.has(c.admin1)) byAdmin1.set(c.admin1, [])
      byAdmin1.get(c.admin1).push(c)
    }
    for (const p of cn.adm1) {
      const pname = pickChineseName(p.alternates, 'province')
      if (!pname) { problems.push('省级条目没有中文名：' + p.name); continue }
      const cities = []
      for (const c of (byAdmin1.get(p.admin1) || [])) {
        const cname = pickChineseName(c.alternates, 'city')
        if (!cname) { problems.push('地级条目没有中文名：' + c.name + '（' + pname + '）'); continue }
        if (cname === pname) continue // 直辖市：ADM2 与 ADM1 同名，避免级联里出现两个"北京市"
        cities.push({
          name: cname, aliases: aliasesOf(c.alternates, cname, 'city'),
          lat: round2(c.lat), lon: round2(c.lon),
        })
      }
      // 直辖市 / 没有地级条目的省：把省自己作为一个可选项，别名取该省级条目的候选。
      if (cities.length === 0) {
        cities.push({
          name: pname, aliases: aliasesOf(p.alternates, pname, 'province'),
          lat: round2(p.lat), lon: round2(p.lon),
        })
      }
      cities.sort((a, b) => a.name.localeCompare(b.name, 'zh'))
      provinces.push({
        code: 'CN.' + p.admin1, name: pname, aliases: aliasesOf(p.alternates, pname, 'province'),
        lat: round2(p.lat), lon: round2(p.lon), cities,
      })
    }

    // TW / HK / MO：GeoNames 里没有"省"这一层 → 各自合成一个省级条目。台湾把 ADM2 的 22 个县市
    //   当作可选城市（金门 / 连江在 GeoNames 里挂在「福建省」下，这里一并归到「台湾」）。
    {
      const tw = admOf(parseGeonames(txtOf(await readSource('TW.zip'), 'TW')))
      const cities = []
      for (const c of tw.adm2) {
        const cname = pickChineseName(c.alternates, 'city')
        if (!cname) { problems.push('台湾的 ADM2 没有中文名：' + c.name); continue }
        cities.push({
          name: cname, aliases: aliasesOf(c.alternates, cname, 'city'),
          lat: round2(c.lat), lon: round2(c.lon),
        })
      }
      if (cities.length === 0) problems.push('台湾没有任何可用条目')
      else {
        cities.sort((a, b) => a.name.localeCompare(b.name, 'zh'))
        const c = centroid(cities)
        // 条目是合成的，别名写在这里：气象台会写「台湾省」或繁体「臺灣」，两种都要能匹配上。
        provinces.push({ code: 'TW', name: '台湾', aliases: ['臺灣', '台灣'], lat: c.lat, lon: c.lon, cities })
      }
    }

    // 香港 / 澳门：GeoNames 里只有区 / 堂区（18 / 8 条，其中 8 条无中文名），两个特别行政区本身
    //   就是一个点，坐标取这些下级条目的中心点；名称写在这里（dump 里没有"领土本身"这个条目）。
    for (const terr of [{ cc: 'HK', name: '香港' }, { cc: 'MO', name: '澳门' }]) {
      const rows = admOf(parseGeonames(txtOf(await readSource(terr.cc + '.zip'), terr.cc)))
      const pts = rows.adm1.map((r) => ({ lat: r.lat, lon: r.lon }))
      if (pts.length === 0) { problems.push(terr.cc + ' 没有任何条目'); continue }
      const c = centroid(pts)
      provinces.push({
        code: terr.cc, name: terr.name, aliases: [], lat: c.lat, lon: c.lon,
        cities: [{ name: terr.name, aliases: [], lat: c.lat, lon: c.lon }],
      })
    }

    provinces.sort((a, b) => a.code.localeCompare(b.code))
    const cityCount = provinces.reduce((n, p) => n + p.cities.length, 0)
    return { provinces, problems, cityCount }
  })()
}

/** 一组点的中心（算术平均）。用平均而不是取第一条：取第一条会让「香港」落在某一个区上。 */
function centroid(pts) {
  const n = pts.length || 1
  const sum = pts.reduce((a, p) => ({ lat: a.lat + p.lat, lon: a.lon + p.lon }), { lat: 0, lon: 0 })
  return { lat: round2(sum.lat / n), lon: round2(sum.lon / n) }
}

const round2 = (v) => (Number.isFinite(v) ? Math.round(v * 100) / 100 : 0)

// ---------------------------------------------------------------- 产物
/** 别名字段：为空时整段省略，免得产物里塞满 `aliases: []`（读起来全是噪音）。 */
function aliasField(list) {
  return (Array.isArray(list) && list.length) ? ' aliases: ' + JSON.stringify(list) + ',' : ''
}

function render(provinces) {
  const lines = []
  lines.push('// 中国行政区划表（省 → 地级市，带坐标 + 匹配别名）——由 scripts/build-cn-areas.mjs 生成，请勿直接编辑。')
  lines.push('// 来源：GeoNames（CC BY 4.0）的 CN / TW / HK / MO dump 中的 ADM1 / ADM2 条目。')
  lines.push('// 坐标是行政区中心点（不是市政府驻地），用于「关注点 + 半径」匹配；更精确的位置由设置页的「用我的位置」提供。')
  lines.push('// 范围：省 / 特别行政区（' + provinces.length + '）+ 地级行政区（' + provinces.reduce((n, p) => n + p.cities.length, 0) + '）。县一级不在本表内：气象源的预警标题自带完整机构链')
  lines.push('//（省 + 市 + 县），不需要靠县名向上反查地级市。')
  lines.push('// aliases：同一记录的其余中文候选，只参与匹配、不进 UI——显示名只挑一个候选，气象台写的是自己的建制名')
  lines.push('//（如 GeoNames 挑到旧名「毕节地区」而 nmc.cn 写「毕节市」），只按显示名匹配会判成归属不明。')
  lines.push('// 已知精度取舍：中文名可能滞后（新旧名并存时按「当前建制后缀」优先级挑：市 > 自治州 > 盟 > 地区）；')
  lines.push('// 台湾的县市沿用 GeoNames 的写法，简繁混排（澎湖县 / 雲林縣）。')
  lines.push('')
  lines.push('export const CN_AREAS = [')
  for (const p of provinces) {
    lines.push('  { code: ' + JSON.stringify(p.code) + ', name: ' + JSON.stringify(p.name) + ',' +
      aliasField(p.aliases) + ' lat: ' + p.lat + ', lon: ' + p.lon + ', cities: [')
    for (const c of p.cities) {
      lines.push('    { name: ' + JSON.stringify(c.name) + ',' + aliasField(c.aliases) +
        ' lat: ' + c.lat + ', lon: ' + c.lon + ' },')
    }
    lines.push('  ] },')
  }
  lines.push(']')
  lines.push('')
  return lines.join('\n')
}

// ---------------------------------------------------------------- main
const { provinces, problems, cityCount } = await build()
if (problems.length) {
  console.error('构建中发现 ' + problems.length + ' 处问题：')
  for (const p of problems.slice(0, 20)) console.error('  · ' + p)
  if (problems.length > 20) console.error('  … 其余 ' + (problems.length - 20) + ' 条省略')
}
const code = render(provinces)
console.log('省级行政区 ' + provinces.length + '，地级行政区 ' + cityCount + '，产物 ' + code.length + ' 字符')

if (CHECK_ONLY) {
  let cur = ''
  try { cur = readFileSync(OUT, 'utf8') } catch { /* 不存在视为陈旧 */ }
  if (cur === code) { console.log('lib/data/cn-areas.js 已是最新。'); process.exit(problems.length ? 1 : 0) }
  console.error('lib/data/cn-areas.js 已陈旧：请运行 node scripts/build-cn-areas.mjs')
  process.exit(1)
}
writeFileSync(OUT, code, 'utf8')
console.log('已写入 lib/data/cn-areas.js')
process.exit(problems.length ? 1 : 0)
