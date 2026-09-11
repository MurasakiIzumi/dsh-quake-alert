#!/usr/bin/env node
// dsh-quake-alert · client/src 跨模块引用检查
//
// 作用：ESM 化之后，跨模块引用一旦写错，只会在**运行时**抛 ReferenceError（打包器不会
//       报错）。这个脚本把这类错误提前到构建/检查阶段，检查两件事：
//       ① 正文里出现的「其它文件导出的名字」是否都已在 import 列表中（漏 import）；
//       ② 正文里「被赋值却没有声明」的标识符——ESM 里给本文件未声明、也未 import 的名字
//          赋值一定是错的：拆分前它可能是同作用域的模块私有变量（单文件时代），拆分后
//          就成了自由变量，打包进 'use strict' 的 bundle 会直接抛 ReferenceError。
//          0.2.1 拆分时 client/src/13-ui-settings.js 的 `runtimeCfg = loadCfg()` 正是这一类。
//
// 用法：node scripts/check-imports.mjs   （并入 pnpm check）

import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'client', 'src')
const files = readdirSync(SRC).filter((f) => f.endsWith('.js')).sort()

/**
 * 去掉注释与字符串字面量：它们里面的词不算「使用」。
 *
 * 用状态机逐字符扫描，而不是一串 replace 正则——正则版在这里会翻车：
 * `decode()` 里的 `.replace(/&#39;/g, "'")` 是「双引号包着单引号」，
 * 单引号正则 `/'(?:[^'\\]|\\.)*'/` 会从那里一路吃到很远的下一处单引号，
 * 后面整个文件的字符串边界全部错位，于是 XML 里的 `version="1.0"`、
 * `codeType="…"` 都被当成「未声明赋值」误报。
 */
function stripNoise(code) {
  let out = ''
  let i = 0
  const n = code.length
  while (i < n) {
    const c = code[i]
    const c2 = code[i + 1]
    if (c === '/' && c2 === '*') {
      const end = code.indexOf('*/', i + 2)
      i = end === -1 ? n : end + 2
      out += ' '
      continue
    }
    if (c === '/' && c2 === '/') {
      const end = code.indexOf('\n', i + 2)
      i = end === -1 ? n : end
      out += ' '
      continue
    }
    if (c === '"' || c === "'" || c === '`') {
      const quote = c
      i += 1
      while (i < n) {
        if (code[i] === '\\') { i += 2; continue }
        if (code[i] === quote) { i += 1; break }
        i += 1
      }
      out += quote === '`' ? '``' : "''"
      continue
    }
    out += c
    i += 1
  }
  return out
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

/** 允许被赋值的平台/宿主全局（ESM 严格模式下赋值给未声明的名字会抛 ReferenceError，
 *  这些名字由宿主或语言提供，不属于本检查的范围）。 */
const GLOBALS = new Set([
  'window', 'document', 'self', 'top', 'parent', 'frames', 'globalThis', 'console', 'navigator',
  'location', 'history', 'localStorage', 'sessionStorage', 'performance', 'crypto',
  'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'queueMicrotask',
  'requestAnimationFrame', 'cancelAnimationFrame', 'getComputedStyle', 'matchMedia',
  'Math', 'JSON', 'Object', 'Array', 'String', 'Number', 'Boolean', 'Date', 'Set', 'Map',
  'WeakMap', 'WeakSet', 'Promise', 'RegExp', 'Error', 'TypeError', 'RangeError', 'Symbol',
  'Intl', 'Proxy', 'Reflect', 'Function', 'isNaN', 'parseInt', 'parseFloat', 'undefined',
  'NaN', 'Infinity', 'encodeURIComponent', 'decodeURIComponent', 'encodeURI', 'decodeURI',
  'TextDecoder', 'TextEncoder', 'AbortController', 'URL', 'URLSearchParams', 'Notification',
  'AudioContext', 'fetch', 'require', 'module', 'exports', 'arguments', 'React',
])

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

  // ② 未声明赋值：`name = ...` 中的 name 既不是本文件声明、也不是 import、也不是已知全局。
  //    ESM 严格模式下这行必然抛 ReferenceError（打包器不会报错），是模块化拆分最容易留下的坑。
  //    这里只查裸赋值；`a.b = x`（属性赋值）与 `+=` 这类复合赋值不在检查范围。
  const badAssign = new Set()
  for (const m of body.matchAll(/(?<![\w$.])([A-Za-z_$][\w$]*)\s*(?<![=!<>])=(?!=)/g)) {
    const n = m[1]
    if (local.has(n) || imported.has(n) || owner.has(n) || GLOBALS.has(n)) continue
    badAssign.add(n)
  }
  if (badAssign.size) {
    problems += badAssign.size
    console.error('✗ ' + f + ' 赋值未声明：' + [...badAssign].join('、') +
      '（本文件没有声明它，也没有从别处 import —— 拆分后它已不是同作用域变量）')
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
