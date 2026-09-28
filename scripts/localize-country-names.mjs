// dsh-quake-alert · 国家 / 地区名改成本地化四条
// 就地重写 lib/data/world-cities.js：把 WORLD_COUNTRIES 的 name 换成 names: { zh-CN, zh-TW, ja, en }。
// 名字由 ICU（Node 自带 full-icu）的 Intl.DisplayNames 算出，不是手抄的对照表；城市名不在范围内。
// 用法：node scripts/localize-country-names.mjs（幂等：已是四条就报"无需改动"）

import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const FILE = path.join(ROOT, 'lib', 'data', 'world-cities.js')
/** 与 client/src/00-i18n.js 的 LANGS 同一批（客户端四种界面语言）。 */
const LANGS = ['zh-CN', 'zh-TW', 'ja', 'en']

let src = readFileSync(FILE, 'utf8')
const start = src.indexOf('export const WORLD_COUNTRIES = [')
// 数组以单独一行的 `]` 收尾（文件里没有写分号）
const end = src.indexOf('\n]', start)
if (start === -1 || end === -1) {
  console.error('✗ 找不到 WORLD_COUNTRIES 数组（文件结构变了？）')
  process.exit(1)
}
const block = src.slice(start, end)
const rows = [...block.matchAll(/\{ code: "([A-Z]{2})", name: "([^"]*)", count: (\d+) \}/g)]
if (rows.length === 0) {
  console.log('没有可改动的条目（数据已是本地化四条）')
  process.exit(0)
}

const display = {}
for (const lang of LANGS) {
  try { display[lang] = new Intl.DisplayNames([lang], { type: 'region' }) } catch (err) { display[lang] = null }
}
function nameIn(lang, code, fallback) {
  const dn = display[lang]
  if (dn) {
    try {
      const n = dn.of(code)
      if (n && n !== code) return n
    } catch (err) { /* 非标准码（XK 之类）：退回已有名字 */ }
  }
  return fallback
}

const lines = rows.map(([, code, zh, count]) => {
  const names = {}
  for (const lang of LANGS) names[lang] = nameIn(lang, code, zh)
  return '  { code: "' + code + '", count: ' + count + ', names: ' + JSON.stringify(names) + ' },'
})
const next = 'export const WORLD_COUNTRIES = [\n' + lines.join('\n')
src = src.slice(0, start) + next + src.slice(end)
writeFileSync(FILE, src)
console.log('已把 ' + rows.length + ' 个国家 / 地区改为本地化四条（' + LANGS.join(' / ') + '）。')
console.log('接下来跑 node tests/sync-test.cjs 复核。')
