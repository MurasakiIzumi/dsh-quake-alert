// dsh-quake-alert · 删除无人消费的 i18n 键（0.9.4 / P3-43）
//
// 背景：一份只读审查报告点出 17 条键没有任何消费者。逐条核实后分两类处理：
//  · `configIo.copied` / `configIo.copyFailed`：**不删**——配置页的"复制"功能当时不存在，
//    0.9.4 把它做出来了（导出回退路径上的复制按钮），这两个键现在有消费者；
//  · 其余 15 条**删掉**（每种语言各 15 条）：
//      `scale.*`（10 条）—— 活的那份是 01-constants 的 `SCALE_TEXT`（05-parser 用它拼 headline）；
//      `tsunami.*`（3 条）—— 活的那份是 `TSUNAMI_GRADE_TEXT`；
//      `source.jma` / `source.nmc` —— 活的取词方案是 `settings.sourceLabels.*`（00f）。
//    留着它们的坏处不是"多占几行"：下一个人会以为改这里能让界面跟着变，而实际没有任何路径读它。
//
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
