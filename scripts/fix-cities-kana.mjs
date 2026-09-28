// dsh-quake-alert · 一次性修复 lib/data/cities.js 里被打坏的市町村名
// 表里混有 U+3096「ゖ」、平假名 け / の 等错误写法，脚本只做精确字符串替换。
// 用法：node scripts/fix-cities-kana.mjs（幂等：已修过就报"没有可替换的条目"并退出 0）

import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const FILE = path.join(ROOT, 'lib', 'data', 'cities.js')

// 左侧是表里的错名，右侧是官方写法，逐条人工核对过：
//  · 有河川区域表可对照的（六ヶ所村 / 金ケ崎町 / 龍ケ崎市 等）以河川表为准；
//  · 其余按总务省「都道府県コード及び市区町村コード」的官方写法，注意 ケ 与 ヶ 是两种不同的字。
const FIXES = [
  ['外ゖ浜町', '外ヶ浜町'],
  ['鰺ゖ沢町', '鰺ヶ沢町'],
  ['六ゖ所村', '六ヶ所村'],
  ['金け崎町', '金ケ崎町'],
  ['七ゖ宿町', '七ヶ宿町'],
  ['七ゖ浜町', '七ヶ浜町'],
  ['龍け崎市', '龍ケ崎市'],
  ['鶴ゖ島市', '鶴ヶ島市'],
  ['鎌け谷市', '鎌ケ谷市'],
  ['袖け浦市', '袖ケ浦市'],
  ['青ゖ島村', '青ヶ島村'],
  ['茅ゖ崎市', '茅ヶ崎市'],
  ['横浜市保土け谷区', '横浜市保土ケ谷区'],
  ['南あるぷす市', '南アルプス市'],
  ['駒ゖ根市', '駒ヶ根市'],
  ['関け原町', '関ケ原町'],
  ['吉野ゖ里町', '吉野ヶ里町'],
  ['五ゖ瀬町', '五ヶ瀬町'],
  ['上の国町', '上ノ国町'],
  ['にせこ町', 'ニセコ町'],
  ['西の島町', '西ノ島町'],
  ['山の内町', '山ノ内町'],
]

let src = readFileSync(FILE, 'utf8')
let changed = 0
for (const [bad, good] of FIXES) {
  const needle = '"' + bad + '"'
  const count = src.split(needle).length - 1
  if (count === 0) continue
  if (count > 1) {
    console.error('✗ ' + bad + ' 出现 ' + count + ' 次，拒绝批量替换（请人工确认）')
    process.exit(1)
  }
  src = src.replace(needle, '"' + good + '"')
  changed += 1
  console.log('  ' + bad + ' → ' + good)
}
if (changed === 0) {
  console.log('没有可替换的条目（表已是修好的状态）')
  process.exit(0)
}
writeFileSync(FILE, src)
console.log('已修复 ' + changed + ' 条。接下来跑 node tests/sync-test.cjs 复核。')
