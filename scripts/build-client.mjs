#!/usr/bin/env node
// dsh-quake-alert · client bundle 构建脚本（rollup）
// 作用：把 client/src/*.js（标准 ESM，显式 import/export）打包成单文件 client/client.js。
//       DSH 客户端 bundle 是扁平模块图（一个 bundle = 一个模块节点），包内多文件 import 不被支持。
//       react 标记为 external：产物保留 require("react")，由 banner 注入的 factory 参数满足。
//
// 用法：
//   node scripts/build-client.mjs           # 生成 client/client.js
//   node scripts/build-client.mjs --check   # 只校验是否为最新（陈旧时退出码 1，不写入文件）

import { rollup } from 'rollup'
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const ENTRY = path.join(ROOT, 'client', 'src', '15-entry.js')
const OUT = path.join(ROOT, 'client', 'client.js')
const CHECK_ONLY = process.argv.includes('--check')

/** DSH 客户端模块加载器外壳 + 生成物说明（banner 会原样放在产物最前面）。 */
const BANNER = `window.__ModuleLoader__.load({ id: "dsh-quake-alert", factory: (require) => {
var module = { exports: {} }; var exports = module.exports;

/**
 * dsh-quake-alert client bundle —— 由 scripts/build-client.mjs (rollup) 从 client/src/*.js 打包生成。
 * 请勿直接编辑本文件：改 client/src/ 下的 ESM 模块（每个文件头部写了职责与依赖），再运行 pnpm build。
 * 灾害预警：DSH 使用期间经 P2PQuake WebSocket 接收日本地震 / 海啸信息，按「关注地区 + 震度 / 海啸阈值」
 * 命中后页内 toast、页面后台系统通知与提示音（设置 → 灾害预警）；数据由 P2PQuake 转播，仅供参考。
 */
`

const FOOTER = `
return module.exports;
} });
`

const warnings = []
const bundle = await rollup({
  input: ENTRY,
  external: ['react'],
  onwarn(warning) {
    // 循环依赖在 ESM 里会悄悄降级成 undefined，这里显式升级为构建失败
    if (warning.code === 'CIRCULAR_DEPENDENCY') {
      console.error('构建失败：检测到循环依赖 —— ' + warning.message)
      process.exit(1)
    }
    warnings.push(warning.code + ': ' + warning.message)
  },
})

const { output } = await bundle.generate({
  format: 'cjs',
  exports: 'named',
  banner: BANNER,
  footer: FOOTER,
})
await bundle.close()

const code = output[0].code
for (const w of warnings) console.warn('rollup 警告：' + w)

if (CHECK_ONLY) {
  let current = ''
  try { current = readFileSync(OUT, 'utf8') } catch { /* 不存在视为陈旧 */ }
  if (current === code) {
    console.log('client bundle 已是最新（' + code.length + ' 字节）。')
    process.exit(0)
  }
  console.error('client bundle 已陈旧：请运行 node scripts/build-client.mjs')
  process.exit(1)
}

writeFileSync(OUT, code, 'utf8')
console.log('已用 rollup 打包 client/client.js（' + code.length + ' 字节）')
