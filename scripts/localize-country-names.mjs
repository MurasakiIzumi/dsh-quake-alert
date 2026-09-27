// dsh-quake-alert · 国家 / 地区名改成本地化四条（0.9.4 / PD-3）
//
// 背景：`WORLD_COUNTRIES` 的 `name` 此前是**写死的中文**（生成脚本里 `Intl.DisplayNames(['zh-CN'])`），
// 于是把界面语言切成日本語 / English 时，国家下拉仍然是简体中文——设置页的其他部分都本地化了，
// 只有这一块没有。
//
// 为什么这份数据可以离线重算：名字的来源是 **ICU**（Node 自带 full-icu），不是我们手抄的对照表。
// 改成本地化四条之后，任何一种语言的名字都能用同一段代码重新算出来并逐条比对——这才是
// "证据可核验"而不是"作者凭印象抄了 664 个名字"。
//
// 城市名**不在本脚本范围内**：它取自 GeoNames `alternatenames` 里的 CJK 候选（简繁 / 日汉字混用），
// 要统一成拉丁文需要重跑 `build-world-cities.mjs`（要能连 download.geonames.org）。
//
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
