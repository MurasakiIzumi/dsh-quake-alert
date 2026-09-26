#!/usr/bin/env node
// dsh-quake-alert · client bundle 构建脚本（rollup）
//
// 作用：把 client/src/*.js（标准 ESM，显式 import/export）打包成 DSH 要求的单文件客户端
//       bundle：client/client.js。
//
// 为什么必须打包成单文件：DSH 的客户端 bundle 是一个**模块节点**——宿主提供已构建的 bundle，
// 模块图是扁平的（一个 bundle 只依赖平台 seed 表与 dsh.client.external 声明的动态包），
// 包内多文件 import 不被支持。所以源码按功能分模块（可读性），构建时打包成单文件（运行期要求）。
//
// 为什么用 rollup：它是纯 JS 打包器，native 绑定经 napi 在进程内加载，不 spawn 子进程、
// 不需要平台二进制下载，任何执行环境（含受限沙箱、CI、Windows 杀软环境）都能构建。
//
// react 由 DSH 的 factory `require` 提供（平台 seed 表），因此标记为 external：
// 产物保留 require("react")，由 banner 注入的 factory 参数满足。
//
// 用法：
//   node scripts/build-client.mjs           # 生成 client/client.js
//   node scripts/build-client.mjs --check   # 只校验是否为最新（陈旧时退出码 1，不写盘）

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
 *
 * 灾害预警：DSH 使用期间，P2PQuake WebSocket 实时推送日本地震 / 海啸信息，
 * 按「关注都道府县 / 市区町村 + 震度 / 海啸等级阈值」匹配命中后提醒：
 *   - 页面可见 → 页内 toast；页面后台 → 系统通知；命中时播放合成提示音
 *   - 设置页：设置 → 灾害预警（关注地区 / 阈值 / 音量 / 静默时段 / 测试）
 *   - 配置：Host 机器级存储（DSH 0.1.7 起为 profile patch，0.1.6 及以前为 settings.yaml）
 *     为主，localStorage 为镜像与回退
 *   - 免责：数据由 P2PQuake 转播，EEW 等仅供参考，请以气象厅官方发布为准
 *
 * DSH 客户端 bundle 必须是单文件（扁平模块图：一个 bundle = 一个模块节点）。
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
    // 循环依赖在 ESM 里会静默降级成 undefined，这里显式升级为构建失败
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
