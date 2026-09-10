#!/usr/bin/env node
// dsh-quake-alert · client/src 跨模块引用检查
//
// 作用：ESM 化之后，某个模块引用了别的模块的导出却忘了 import，只会在**运行时**抛
//       ReferenceError（打包器不会报错）。这个脚本把这类错误提前到构建/检查阶段：
//       解析每个文件的 `export { ... }` 与 `import { ... } from '...'`，再检查正文里
//       出现的「其它文件导出的名字」是否都已在 import 列表中。
//
// 用法：node scripts/check-imports.mjs   （并入 pnpm check）

import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'client', 'src')
const files = readdirSync(SRC).filter((f) => f.endsWith('.js')).sort()

/** 去掉注释与字符串字面量：它们里面的词不算「使用」。 */
function stripNoise(code) {
  return code
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\/\/[^\n]*/g, ' ')
    .replace(/'(?:[^'\\]|\\.)*'/g, "''")
    .replace(/"(?:[^"\\]|\\.)*"/g, '""')
    .replace(/`(?:[^`\\]|\\.)*`/g, '``')
}

/** 每个文件的导出名（同时支持 `export { A, B }` 与 `export const/function A`）。 */
const exportsByFile = new Map()
for (const f of files) {
  const text = stripNoise(readFileSync(path.join(SRC, f), 'utf8'))
  const names = new Set()
  const block = /^export \{([^}]*)\}/m.exec(text)
  if (block) for (const n of block[1].split(',').map((s) => s.trim()).filter(Boolean)) names.add(n)
  for (const m of text.matchAll(/^export (?:const|let|function|class) ([A-Za-z_$][\w$]*)/gm)) names.add(m[1])
  if (names.size === 0) console.warn('警告：' + f + ' 没有 export')
  exportsByFile.set(f, [...names])
}

/** 名字 → 定义它的文件（重名时保留首个，重名本身也值得报出来）。 */
const owner = new Map()
const dupes = []
for (const [f, names] of exportsByFile) {
  for (const n of names) {
    if (owner.has(n)) dupes.push(n + '（' + owner.get(n) + ' 与 ' + f + '）')
    else owner.set(n, f)
  }
}

let problems = 0
for (const f of files) {
  const text = readFileSync(path.join(SRC, f), 'utf8')
  const imported = new Set()
  for (const m of text.matchAll(/^import \{([^}]*)\} from '([^']+)'/gm)) {
    for (const n of m[1].split(',').map((s) => s.trim()).filter(Boolean)) imported.add(n)
  }
  // 正文：去掉 import 行与注释/字符串，避免把它们算成「使用」
  const body = stripNoise(text.split('\n').filter((l) => !/^import /.test(l)).join('\n'))
  // 本文件内的局部声明（函数参数、局部 const/let、catch 绑定）不算「跨模块引用」
  const local = new Set()
  const addNames = (chunk) => {
    for (const part of String(chunk).split(',')) {
      const n = /^\s*(?:\.\.\.)?([A-Za-z_$][\w$]*)/.exec(part)
      if (n) local.add(n[1])
    }
  }
  for (const m of body.matchAll(/function\s*[\w$]*\s*\(([^)]*)\)/g)) addNames(m[1])
  for (const m of body.matchAll(/\(([^)]*)\)\s*=>/g)) addNames(m[1])
  for (const m of body.matchAll(/(?:^|[^\w$.])([A-Za-z_$][\w$]*)\s*=>/g)) local.add(m[1])
  for (const m of body.matchAll(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)/g)) local.add(m[1])
  for (const m of body.matchAll(/\b(?:const|let|var)\s*\{([^}]*)\}/g)) addNames(m[1])
  for (const m of body.matchAll(/\bfor\s*\(\s*(?:const|let|var)\s+([A-Za-z_$][\w$]*)/g)) local.add(m[1])
  for (const m of body.matchAll(/catch\s*\(\s*([A-Za-z_$][\w$]*)/g)) local.add(m[1])

  const missing = []
  for (const [name, defFile] of owner) {
    if (defFile === f || imported.has(name) || local.has(name)) continue
    // (?<!\.) 排除属性访问（JSON.parse、hypo.name 这类不算「使用」模块导出）
    if (new RegExp('(?<!\\.)\\b' + name + '\\b').test(body)) missing.push(name + '（定义于 ' + defFile + '）')
  }
  if (missing.length) {
    problems += missing.length
    console.error('✗ ' + f + ' 缺少 import：' + missing.join('、'))
  }
}

for (const d of dupes) {
  problems += 1
  console.error('✗ 导出重名：' + d)
}

if (problems) {
  console.error('\n检查失败：' + problems + ' 处跨模块引用问题')
  process.exit(1)
}
console.log('跨模块引用检查通过（' + files.length + ' 个模块 / ' + owner.size + ' 个导出名）')
