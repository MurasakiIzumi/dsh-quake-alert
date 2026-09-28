// dsh-quake-alert · 删除无人消费的 i18n 键
// 只扫 FILES 列的 00e-texts-units.js / 00a-texts-core.js，删除 DEAD 清单里的键（每种语言各一份）。
// 00g-texts-events.js 里有同名的活键（scale.* / tsunami.*，由 05-parser 取词），本脚本碰不到它；
// 新增待删键时只加 00a / 00e 的，别把 00g 的活键写进来。
// 用法：node scripts/prune-dead-i18n.mjs（幂等：删过就报"没有可删除的键"）

import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const FILES = [
  path.join(ROOT, 'client', 'src', '00e-texts-units.js'),
  path.join(ROOT, 'client', 'src', '00a-texts-core.js'),
]
// 键名与所在文件（用精确的 `'key':` 前缀匹配，避免误伤同名前缀的其它键）
const DEAD = [
  ['scale.10', '00e'], ['scale.20', '00e'], ['scale.30', '00e'], ['scale.40', '00e'],
  ['scale.45', '00e'], ['scale.46', '00e'], ['scale.50', '00e'], ['scale.55', '00e'],
  ['scale.60', '00e'], ['scale.70', '00e'],
  ['tsunami.Watch', '00e'], ['tsunami.Warning', '00e'], ['tsunami.MajorWarning', '00e'],
  ['source.jma', '00a'], ['source.nmc', '00a'],
]

let removed = 0
for (const file of FILES) {
  const tag = file.indexOf('00e-') !== -1 ? '00e' : '00a'
  const keys = DEAD.filter(([, t]) => t === tag).map(([k]) => k)
  if (keys.length === 0) continue
  let src = readFileSync(file, 'utf8')
  for (const key of keys) {
    // 匹配 `'key': '...'` 以及它后面可选的逗号与空白（同一行里可能挤着多个键）
    const re = new RegExp("\\s*'" + key.replace(/\./g, '\\.') + "':\\s*'(?:[^'\\\\]|\\\\.)*',?", 'g')
    const before = src
    src = src.replace(re, (m) => (m.trimStart().startsWith("'") && m.trimEnd().endsWith(',') ? '' : ''))
    if (src !== before) removed += 1
  }
  // 清理被删空的尾巴：形如 `,\n  }` 或 `{\n  },` 的空对象残留交给语法检查兜底
  src = src.replace(/,\s*\n(\s*)\}/g, '\n$1}')
  writeFileSync(file, src)
}
if (removed === 0) {
  console.log('没有可删除的键（表已是清理过的状态）')
  process.exit(0)
}
console.log('已移除 ' + removed + ' 条键的定义（每种语言各一份）。接下来跑 node scripts/check-imports.mjs 复核语言表是否仍对齐。')
