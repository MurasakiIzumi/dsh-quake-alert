#!/usr/bin/env node
// dsh-quake-alert · 河川予報区域表构建脚本
//
// 作用：把気象庁公开的「指定河川洪水予報区域と市区町村に関するCSVファイル」加工成
//       lib/data/river-areas.js，供 Client 侧把洪水电文的「河川予報区域」映射到市町村。
//
// 为什么需要它：指定河川洪水予報的电文区域是**河川名**（「天塩川」「十勝川水系芽室川」），
// 用户不可能关注这种名字；而泥石流电文的区域本身就是市町村。所以洪水必须先经本表
// 映射到市町村，才能复用现有的 watch.cities 匹配。
//
// 来源（运行期不联网，只有构建时需要网络）：
//   https://www.jma.go.jp/jma/kishou/know/bosai/keiho-update2026/tech-info/index.html
//   → zip/20260527_river-areainfo.zip
//   内含两份 UTF-8 CSV（国管理河川 / 都道府県管理河川），列结构：
//     予報区域名, 予報区域コード, 市町村名1, 市町村コード1, 市町村名2, 市区町村コード2, …
//   本文件为上述数据的加工产物（合并两份 CSV、去重、以区域代码为主键）。
//   気象庁のコンテンツは政府標準利用規約に準拠（出典明記のうえで利用可）。
//
// 零依赖：zip 解压用 Node 内置 zlib（读取器见 scripts/lib/zip.mjs），不引入 unzip / xlsx 依赖，
//         与 build-client.mjs、check-imports.mjs 的手写工具脚本传统一致。
//
// 用法：
//   node scripts/build-areas.mjs                  # 联网取源 → 生成 lib/data/river-areas.js
//   node scripts/build-areas.mjs --check          # 只校验产物是否与当前源一致（不写盘）
//   node scripts/build-areas.mjs --from <zip路径>  # 用本地 zip（离线 / 回归测试用）

import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { unzip } from './lib/zip.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const OUT = path.join(ROOT, 'lib', 'data', 'river-areas.js')
const SOURCE_URL = 'https://www.jma.go.jp/jma/kishou/know/bosai/keiho-update2026/tech-info/zip/20260527_river-areainfo.zip'
const CHECK_ONLY = process.argv.includes('--check')
const fromIdx = process.argv.indexOf('--from')
const FROM_ZIP = fromIdx === -1 ? null : process.argv[fromIdx + 1]

// ---------------------------------------------------------------- CSV → 区域条目
// 表头形如 `#(2026年5月27日時点) 予報区域名, 予報区域コード, …`，取括号内的时点。
function parseRiverCsv(text, fileName) {
  const lines = text.split(/\r?\n/).filter((l) => l.trim() !== '')
  const header = lines[0] || ''
  const dated = (/\(([^)]+)\)/.exec(header) || [])[1] || ''
  const areas = []
  const problems = []
  lines.slice(1).forEach((line, i) => {
    const cells = line.split(',').map((s) => s.trim())
    const name = cells[0]
    const code = cells[1]
    if (!name || !code) { problems.push(fileName + ' 第 ' + (i + 2) + ' 行：区域名或代码为空'); return }
    const rest = cells.slice(2).filter((c) => c !== '')
    if (rest.length % 2 !== 0) { problems.push(fileName + ' 第 ' + (i + 2) + ' 行：市町村名/代码不成对'); return }
    const cities = []
    const cityCodes = []
    for (let k = 0; k < rest.length; k += 2) { cities.push(rest[k]); cityCodes.push(rest[k + 1]) }
    if (cities.length === 0) { problems.push(fileName + ' 第 ' + (i + 2) + ' 行：没有对应市町村'); return }
    areas.push({ code, name, cities, cityCodes })
  })
  return { dated, areas, problems }
}

// ---------------------------------------------------------------- 组装模型
function buildModel(zipBuf) {
  const files = unzip(zipBuf).filter((f) => f.name.toLowerCase().endsWith('.csv'))
  if (files.length === 0) throw new Error('zip 内没有 CSV')
  const byCode = new Map()
  const problems = []
  let dated = ''
  let citySlots = 0
  for (const f of files) {
    const parsed = parseRiverCsv(f.data.toString('utf8'), f.name)
    problems.push(...parsed.problems)
    if (parsed.dated && !dated) dated = parsed.dated
    for (const a of parsed.areas) {
      // 区域代码是主键：国管理与都道府県管理之间存在重名（如「荒川」）
      const prev = byCode.get(a.code)
      if (prev) {
        if (prev.name !== a.name) problems.push('区域代码重复且名称不一致：' + a.code)
        for (const c of a.cities) if (prev.cities.indexOf(c) === -1) prev.cities.push(c)
        for (const c of a.cityCodes) if (prev.cityCodes.indexOf(c) === -1) prev.cityCodes.push(c)
        continue
      }
      byCode.set(a.code, a)
      citySlots += a.cities.length
    }
  }
  const areas = [...byCode.values()].sort((a, b) => (a.code < b.code ? -1 : a.code > b.code ? 1 : 0))
  const citySet = new Set()
  const cityCodeSet = new Set()
  for (const a of areas) {
    for (const c of a.cities) citySet.add(c)
    for (const c of a.cityCodes) cityCodeSet.add(c)
  }
  // 区域代码 12 位、市町村代码 7 位（实测：区域 810101000100 / 市町村 0122000）
  const badAreaCode = areas.map((a) => a.code).filter((c) => !/^\d{12}$/.test(c))
  if (badAreaCode.length) problems.push('区域代码不是 12 位数字：' + badAreaCode.slice(0, 5).join(','))
  const badCityCode = [...cityCodeSet].filter((c) => !/^\d{7}$/.test(c))
  if (badCityCode.length) problems.push('市町村代码不是 7 位数字：' + badCityCode.slice(0, 5).join(','))
  return {
    sourceUrl: SOURCE_URL,
    dated,
    files: files.map((f) => f.name),
    areas,
    stats: { areas: areas.length, cities: citySet.size, cityCodes: cityCodeSet.size, citySlots },
    problems,
  }
}

// ---------------------------------------------------------------- 生成产物源码
function renderModule(model) {
  const lines = []
  lines.push('// 河川予報区域 → 市町村（指定河川洪水予報の区域マッピング）。')
  lines.push('//')
  lines.push('// 本文件由 scripts/build-areas.mjs 生成，请勿手改（改脚本后重跑 `pnpm build:areas`）。')
  lines.push('//')
  lines.push('// 来源：気象庁「指定河川洪水予報区域と市区町村に関するCSVファイル」（底稿 ' + model.dated + '）')
  lines.push('//   ' + model.sourceUrl)
  lines.push('//   内含：' + model.files.map((f) => path.basename(f)).join(' / '))
  lines.push('//')
  lines.push('// 用途：指定河川洪水予報的电文区域是河川名（用户不会关注这种名字），')
  lines.push('//       匹配前先经本表映射到市町村，再与 watch.cities 比对；')
  lines.push('//       泥石流（土砂災害）电文的区域本身就是市町村，不需要本表。')
  lines.push('//')
  lines.push('// 主键是 code 而不是 name：国管理河川与都道府県管理河川之间存在重名（例如「荒川」）。')
  lines.push('//')
  lines.push('// 统计：' + model.stats.areas + ' 个区域 / ' + model.stats.cities + ' 个去重市町村 / ' +
    model.stats.citySlots + ' 个区域×市町村对')
  lines.push('')
  lines.push('export const RIVER_AREA_META = ' + JSON.stringify({
    sourceUrl: model.sourceUrl,
    sourceDatedAt: model.dated,
    areaCount: model.stats.areas,
    cityCount: model.stats.cities,
  }, null, 2))
  lines.push('')
  lines.push('/** @type {{ code: string, name: string, cities: string[] }[]} 按区域代码升序 */')
  lines.push('export const RIVER_AREAS = [')
  for (const a of model.areas) {
    lines.push('  { code: ' + JSON.stringify(a.code) + ', name: ' + JSON.stringify(a.name) +
      ', cities: ' + JSON.stringify(a.cities) + ' },')
  }
  lines.push(']')
  lines.push('')
  return lines.join('\n')
}

// ---------------------------------------------------------------- main
let zipBuf
if (FROM_ZIP) {
  zipBuf = readFileSync(FROM_ZIP)
  console.log('使用本地 zip：' + FROM_ZIP)
} else {
  const res = await fetch(SOURCE_URL, { redirect: 'follow' })
  if (!res.ok) {
    console.error('下载失败：HTTP ' + res.status + ' ' + SOURCE_URL)
    process.exit(1)
  }
  zipBuf = Buffer.from(await res.arrayBuffer())
  console.log('已下载源 zip：' + zipBuf.length + ' 字节')
}

const model = buildModel(zipBuf)
if (model.problems.length) {
  console.error('源数据有问题：')
  for (const p of model.problems.slice(0, 10)) console.error('  ✗ ' + p)
  if (model.problems.length > 10) console.error('  …共 ' + model.problems.length + ' 处')
  process.exit(1)
}
console.log('解析完成：' + model.stats.areas + ' 个区域 / ' + model.stats.cities + ' 个去重市町村' +
  '（底稿 ' + model.dated + '）')

const code = renderModule(model)
if (CHECK_ONLY) {
  let current = ''
  try { current = readFileSync(OUT, 'utf8') } catch (err) { /* 不存在视为陈旧 */ }
  if (current === code) {
    console.log('lib/data/river-areas.js 已是最新（' + code.length + ' 字符）')
    process.exit(0)
  }
  console.error('lib/data/river-areas.js 已陈旧：请运行 node scripts/build-areas.mjs')
  process.exit(1)
}
writeFileSync(OUT, code, 'utf8')
console.log('已生成 lib/data/river-areas.js（' + code.length + ' 字符）')
