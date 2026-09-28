#!/usr/bin/env node
// dsh-quake-alert · 河川予報区域表构建脚本
// 作用：把気象庁「指定河川洪水予報区域と市区町村に関するCSVファイル」加工成 lib/data/river-areas.js，
//       供 Client 把洪水电文的河川名区域映射到市町村；源 zip 内含两份 UTF-8 CSV（国管理 / 都道府県管理），
//       列为「予報区域名, 予報区域コード, 市町村名1, 市町村コード1, …」，产物按区域代码合并去重。
//       気象庁内容は政府標準利用規約に準拠（出典明記のうえで利用可）。
//
// 用法：
//   node scripts/build-areas.mjs                  # 联网取源 → 生成 lib/data/river-areas.js
//   node scripts/build-areas.mjs --check          # 只校验产物是否与当前源一致（退出码 1 = 陈旧或源有问题，不写入文件）
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

// ---------------------------------------------------------------- CSV → 区域条目（表头 `#(时间) 予報区域名, 予報区域コード, …`，时间取括号内）
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
  lines.push('// 本文件由 scripts/build-areas.mjs 生成，请勿手改（改脚本后重跑 `pnpm build:areas`）。')
  lines.push('// 来源：気象庁「指定河川洪水予報区域と市区町村に関するCSVファイル」（源文件 ' + model.dated + '）')
  lines.push('//   ' + model.sourceUrl)
  lines.push('//   内含：' + model.files.map((f) => path.basename(f)).join(' / '))
  lines.push('// 用途：洪水电文的区域是河川名，匹配前先经本表映射到市町村，再与 watch.cities 比对（泥石流电文不经本表）。')
  lines.push('// 主键是 code：国管理河川与都道府県管理河川之间存在重名（例如「荒川」）。')
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
  const res = await fetch(SOURCE_URL, {
    redirect: 'follow',
    signal: typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function'
      ? AbortSignal.timeout(120 * 1000)
      : undefined,
  })
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
  '（源文件 ' + model.dated + '）')

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
