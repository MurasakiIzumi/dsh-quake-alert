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
import { TABLES, LANGS } from '../client/src/00-i18n.js'

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
  /** 吞掉一段字符串（i 指向引号本身），并把内容换成一对引号占位。 */
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
   * 模板串（i 指向开引号之后）。**插值体按普通代码扫描**（0.9.4 / P3-48）。
   *
   * 此前整个模板串被清成 ` `` `——包括 `${…}` 里的内容，于是"插值里的漏 import / 裸赋值"
   * 全部漏检，而那正是这个脚本存在的理由（模板串在本项目的 UI 里到处都在用）。
   * 现在把插值体原样交给扫描，只把字面部分抹掉。
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
  /** 读到与 depth 匹配的 `}` 为止（i 指向 `}` 之后）。嵌套的模板与字符串照常处理。 */
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
    // (?<!\.) 排除属性访问（JSON.parse、hypo.name 这类不算「使用」模块导出）；
    // (?!\s*:) 排除对象字面量的键——`{ name: ... }` 里的 name 是键名不是引用。
    // 后者是 0.4.0 加坐标模型时暴露的误报：02-storage 的 normalizePlaces 返回
    // `{ name, lat, lon, radiusKm }`，而 15-entry 恰好导出了一个叫 name 的常量。
    // 取舍：三元 `cond ? name : other` 这种写法会漏检，本项目不使用该形式。
    if (new RegExp('(?<!\\.)\\b' + name + '\\b(?!\\s*:)').test(body)) missing.push(name + '（定义于 ' + defFile + '）')
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
    // 0.4.1：这里曾额外放行 owner.has(n)（"某文件导出过这个名字"），但它与"本文件是否 import 了
    // 它"无关，于是"给别处导出的名字裸赋值"整类被放过——那正是 0.2.1 的 `runtimeCfg = loadCfg()`
    // 那一类 bug（runtimeCfg 由 03-settings-bridge 导出，本文件裸赋值会通过检查，
    // 运行时在 'use strict' 的 bundle 里抛 ReferenceError）。本文件的声明已由 local 覆盖
    // （`export const x` 也能被声明正则匹配），所以去掉 owner 分支是纯收紧。
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

// ③ **`t` 被局部变量遮蔽**（0.9.4）：文件里既 `import { t } from './00-i18n.js'`，又在某个函数里
// 写 `const t = …`，那么该函数里的 `t('some.key')` 会去调用那个局部值——轻则 TypeError、重则
// 悄悄用错对象。这条在 0.9.4 引入解析层本地化时**真的踩了两次**（05b 的 `const t = String(title)`、
// 06-matcher 的 `const t = cfg.thresholds`），而且第一次是靠 `check-imports` 报"缺少 import：t"
// 才发现的——说明现有检查只能碰巧覆盖。这里显式拦下：**同一个文件里 `t` 不许既是 import 又是局部声明**。
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

// ④ **状态 / 诊断层不许再出现中文字面量**（0.9.4 的决定，用户拍板）：
// 这一层是机器状态（连接、退避、停更、解析失败…），散在六个文件里约 70 条；逐条做四语表要 280 条
// 条目，而它的读者是"看侧边栏、把诊断快照贴给作者"的人。所以这一层**写死简短英文**，
// 而**电文与提醒面的文案仍走 i18n 四语**（那是灾难发生时用户真正要读的字）。
// 这条守卫防的是"下次顺手又写一句中文进去"——那种回归不会有任何别的检查发现。
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

// ⑤ i18n key 引用一致性（0.9.0）：正文里 `t('some.key')` 的**字面量** key 必须在文案表里存在。
//
// 漏 key 时 t() 会回显 key 本身（设计如此：界面上出现 `settings.watch.title` 是一眼可见的
// 失败），但那个失败要等到用户打开那一页才看得见。设置页有 300+ 条 key，"引用了不存在的
// key"靠人眼核对不现实——放到这里就变成构建期失败。
//
// 只查字面量：`t(variable)`、`t('scale.' + v)` 这类动态拼接不在范围内（表里也可能有
// 只被动态拼出来、从不以字面量出现的 key，所以这里不做反向检查——那会全是误报）。
const i18nKeys = new Set(Object.keys(TABLES[LANGS[0]]))

/**
 * 只去掉注释、**保留字符串内容**（与上面的 `stripNoise` 相反：那个把字符串也清空，
 * 因为"字符串里出现的词算不算使用"对它是否定的，而这里要找的正是字符串里的 key）。
 *
 * 不剥注释的话，文件头那种"本文件里的文案一律走 `t('settings.*')`"的说明会被当成一次
 * 真实引用，报出一个根本不存在的 key——这正是这条检查第一次运行时报出来的东西。
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
  // 末尾的 `(\s*\+)?` 用来**排除字符串拼接**：`t('settings.diag.scenario.' + sc.key)` 这类动态 key
  // 只取到了前缀，并不是一个完整的 key，报出来是误报（0.9.1 加"测试场景名"表时就撞上了这个）。
  // 动态 key 的存在性由断言守（sync-test 里"每个测试场景都有文案"那条），不在这里查。
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
