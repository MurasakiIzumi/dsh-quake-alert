#!/usr/bin/env node
// dsh-quake-alert · client/src 跨模块引用检查
//
// 扫 client/src/*.js，检查：① 正文用到的「其它文件的导出名」是否都已在 import 列表里；
// ② 是否有给本文件未声明、也未 import 的名字赋值（这类错误只在运行时抛 ReferenceError）；
// ③ 导出重名与 `t` 遮蔽；④ 状态层出现中文字面量；⑤ `t('literal.key')` 的 key 是否在 i18n 表。
//
// 用法：node scripts/check-imports.mjs   （并入 pnpm check）
// 退出码：0 = 全部通过；1 = 有任一检查报错（逐条打印到 stderr）。

import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { TABLES, LANGS } from '../client/src/00-i18n.js'

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'client', 'src')
const files = readdirSync(SRC).filter((f) => f.endsWith('.js')).sort()

/**
 * 去掉注释与字符串字面量：它们里面的词不算「使用」。用状态机逐字符扫描：正则版会被
 * `&#39;` 这类「双引号包着单引号」的写法带偏，之后整个文件的边界错位。
 */
function stripNoise(code) {
  let out = ''
  let i = 0
  const n = code.length
  /** 吞掉一段字符串（i 指向引号本身），内容换成一对其引号占位。 */
  const skipQuoted = () => {
    const quote = code[i]
    i += 1
    while (i < n) {
      if (code[i] === '\\') { i += 2; continue }
      if (code[i] === quote) { i += 1; break }
      i += 1
    }
    out += quote === '`' ? '``' : "''"
  }
  /**
   * 模板串（i 指向开引号之后）。字面部分抹掉，`${…}` 插值体按普通代码扫描
   * ——插值里的漏 import / 裸赋值同样要检出来。
   */
  const scanTemplate = () => {
    while (i < n) {
      const c = code[i]
      if (c === '\\') { i += 2; continue }
      if (c === '`') { i += 1; return }
      if (c === '$' && code[i + 1] === '{') {
        i += 2
        out += ' + ( '
        scanBraced(1)
        out += ' ) + '
        continue
      }
      i += 1
    }
  }
  /** 读到与 depth 匹配的 `}` 为止（i 指向 `}` 之后）；嵌套的模板与字符串照常处理。 */
  const scanBraced = (depth) => {
    while (i < n) {
      const c = code[i]
      const c2 = code[i + 1]
      if (c === '\\') { i += 2; continue }
      if (c === '{') { depth += 1; out += c; i += 1; continue }
      if (c === '}') { depth -= 1; i += 1; out += ' } '; if (depth === 0) return; continue }
      if (c === '`') { i += 1; scanTemplate(); continue }
      if (c === '"' || c === "'") { skipQuoted(); continue }
      if (c === '/' && c2 === '*') { const end = code.indexOf('*/', i + 2); i = end === -1 ? n : end + 2; out += ' '; continue }
      if (c === '/' && c2 === '/') { const end = code.indexOf('\n', i + 2); i = end === -1 ? n : end; out += ' '; continue }
      out += c
      i += 1
    }
  }
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
    if (c === '`') { i += 1; scanTemplate(); out += '``'; continue }
    if (c === '"' || c === "'") { skipQuoted(); continue }
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

/** 名字 → 定义它的文件（重名时保留首个；重名本身由下面的 dupes 报出）。 */
const owner = new Map()
const dupes = []
for (const [f, names] of exportsByFile) {
  for (const n of names) {
    if (owner.has(n)) dupes.push(n + '（' + owner.get(n) + ' 与 ' + f + '）')
    else owner.set(n, f)
  }
}

/** 允许被赋值的平台 / 语言内置全局：它们不属于本检查的范围。 */
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
    // (?<!\.) 排除属性访问；(?!\s*:) 排除对象字面量的键。代价：三元 `? :` 写法会漏检。
    if (new RegExp('(?<!\\.)\\b' + name + '\\b(?!\\s*:)').test(body)) missing.push(name + '（定义于 ' + defFile + '）')
  }
  if (missing.length) {
    problems += missing.length
    console.error('✗ ' + f + ' 缺少 import：' + missing.join('、'))
  }

  // ② 未声明赋值：`name = ...` 中的 name 既不是本文件声明、也不是 import、也不是已知全局；
  //    `a.b = x`（属性赋值）与 `+=` 这类复合赋值不在检查范围。
  const badAssign = new Set()
  for (const m of body.matchAll(/(?<![\w$.])([A-Za-z_$][\w$]*)\s*(?<![=!<>])=(?!=)/g)) {
    const n = m[1]
    // 本文件的声明由 local 覆盖（`export const x` 也能被声明正则匹配）；
    // 不额外放行 owner.has(n)：某文件导出过这个名字，与「本文件是否 import 了它」无关。
    if (local.has(n) || imported.has(n) || GLOBALS.has(n)) continue
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

// ③ `t` 被局部变量遮蔽：文件既 `import { t } from './00-i18n.js'`，又声明了同名的局部 `t`，
// 该文件里的 `t('key')` 就会用到局部值而不是文案表。这条守卫专门拦这种遮蔽。
for (const f of files) {
  const src = readFileSync(path.join(SRC, f), 'utf8')
  const body = stripComments(src)
  const importsT = /import\s*\{[^}]*\bt\b[^}]*\}\s*from\s*'\.\/00-i18n\.js'/.test(body)
  if (!importsT) continue
  // 只认"声明式遮蔽"（`const t = …` / `function t(`）：`x.t = …` 之类不算。
  const declared = /(?:const|let|var)\s+t\s*=/.test(body) || /\bfunction\s+t\s*\(/.test(body)
  if (declared) {
    problems += 1
    console.error('✗ `t` 被局部变量遮蔽：' + f + '（它 import 了 00-i18n 的 t，又声明了同名的局部变量；' +
      "本文件里的 t('key') 会用到局部值）")
  }
}

// ④ 状态 / 诊断层（连接、重连间隔递增、停更、解析失败…）写死简短英文，不许出现中文字面量；
// 电文与提醒面的文案仍走 i18n 四语。
const STATUS_LAYER = ['12-websocket.js', '12b-feed-poll.js', '12c-cn-stream.js', '12d-health-probe.js',
  '12e-overseas-poll.js', '05g-source-health.js']
for (const f of STATUS_LAYER) {
  if (files.indexOf(f) === -1) continue
  const body = stripComments(readFileSync(path.join(SRC, f), 'utf8'))
  const hit = /[\u4e00-\u9fff]/.test(body)
  if (hit) {
    problems += 1
    console.error('✗ 状态层出现中文字面量：' + f +
      '（这一层按 0.9.4 的决定写简短英文；提醒面 / 电文文案才走 i18n）')
  }
}

// ⑤ 正文里 `t('some.key')` 的字面量 key 必须存在于文案表（`TABLES` 的第一语言）。只查字面量：
// `t(variable)`、`t('scale.' + v)` 这类动态拼接不在范围内，也不做反向检查。
const i18nKeys = new Set(Object.keys(TABLES[LANGS[0]]))

/**
 * 只去掉注释、**保留字符串内容**（与 `stripNoise` 相反：那个连字符串一起清空，
 * 而这里要找的正是字符串里的 i18n key）。不剥注释就会把注释里写的 key 当成一次真实引用。
 */
function stripComments(code) {
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
      out += c
      i += 1
      while (i < n) {
        if (code[i] === '\\') { out += code[i] + (code[i + 1] || ''); i += 2; continue }
        out += code[i]
        if (code[i] === quote) { i += 1; break }
        i += 1
      }
      continue
    }
    out += c
    i += 1
  }
  return out
}

const unknownKeys = new Map()
for (const f of files) {
  const text = stripComments(readFileSync(path.join(SRC, f), 'utf8'))
  for (const m of text.matchAll(/(^|[^\w$.])t\s*\(\s*['"`]([^'"`]+)['"`](\s*\+)?/g)) {
    if (m[3]) continue
    if (!i18nKeys.has(m[2])) {
      if (!unknownKeys.has(m[2])) unknownKeys.set(m[2], [])
      unknownKeys.get(m[2]).push(f)
    }
  }
}
if (unknownKeys.size) {
  problems += unknownKeys.size
  for (const [key, where] of unknownKeys) {
    console.error('✗ i18n key 不存在：' + key + '（被 ' + [...new Set(where)].join('、') + ' 引用）')
  }
}

if (problems) {
  console.error('\n检查失败：' + problems + ' 处跨模块引用问题')
  process.exit(1)
}
console.log('跨模块引用检查通过（' + files.length + ' 个模块 / ' + owner.size + ' 个导出名 / ' +
  i18nKeys.size + ' 条 i18n key）')
