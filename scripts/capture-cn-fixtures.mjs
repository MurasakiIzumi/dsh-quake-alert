#!/usr/bin/env node
// dsh-quake-alert · 大陆源 fixture 抓取脚本（开发用，不入发行包）
//
// 作用：把 Wolfx 的大陆源（`cenc_eew` / `cenc_eqlist`）的**真实结构**抓成 samples/cn/ 下的
//       fixture。DESIGN 11.4 的落地：大陆 EEW 稀疏（门槛约 M4.0，数天一次），开发时不能等一个
//       真实事件来验证，所以用 Wolfx 自带的回放能力取结构。
//
// 两条取数路径，用途不同（两条都实测可用，2026-09-19）：
//   1. REST 快照 `https://api.wolfx.jp/<id>.json` —— 拿"最后一条 EEW / 整张速报列表"的稳定快照，
//      适合做**黄金样本**（字段齐全、可反复回放）。本脚本默认走这条。
//   2. WebSocket `wss://ws-api.wolfx.jp/<id>` + 纯文本指令 `query_<id>`（**不是** JSON）
//      —— 拿到的结构与推送完全一致（带 `{"type":"cenc_eew",…}` 包裹），适合核对"推送包裹形态"。
//      注意：指令是纯文本 `query_cenceew` / `query_cenceqlist`；发 JSON 不会有任何响应（实测）。
//
// 用法：
//   node scripts/capture-cn-fixtures.mjs            # 抓 REST 快照写入 samples/cn/
//   node scripts/capture-cn-fixtures.mjs --ws       # 改用 WebSocket query 指令抓（含推送包裹）
//   node scripts/capture-cn-fixtures.mjs --dry      # 只打印，不写盘
//
// 边界：只抓结构、不做判断。抓到的东西可能与上一版一模一样（EEW 数天不变）——这是正常的，
//       fixture 本来就是"结构样本"而不是"新闻"。差异请用 git diff 看。

import { writeFileSync, mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const OUT_DIR = path.join(ROOT, 'samples', 'cn')
const USE_WS = process.argv.includes('--ws')
const DRY = process.argv.includes('--dry')
const TIMEOUT_MS = 20000

/** REST 快照。 */
async function fetchRest(id) {
  const res = await fetch('https://api.wolfx.jp/' + id + '.json', {
    signal: AbortSignal.timeout(TIMEOUT_MS),
  })
  if (!res.ok) throw new Error('HTTP ' + res.status)
  const text = await res.text()
  return JSON.parse(text)
}

/** WebSocket + 纯文本 query 指令（拿到的是推送包裹形态）。 */
function fetchWs(id) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket('wss://ws-api.wolfx.jp/' + id)
    const timer = setTimeout(() => { try { ws.close() } catch {} ; reject(new Error('等待 ' + id + ' 首包超时')) }, TIMEOUT_MS)
    const done = (v) => { clearTimeout(timer); try { ws.close() } catch {} ; resolve(v) }
    ws.onopen = () => ws.send('query_' + id)
    ws.onmessage = (e) => {
      let o = null
      try { o = JSON.parse(String(e.data)) } catch { return }
      // 心跳先到（约 60 秒一次），跳过；等到真正的数据包再收工
      if (o && o.type && o.type !== 'heartbeat') done(o)
    }
    ws.onerror = () => { clearTimeout(timer); reject(new Error('WebSocket 连接失败')) }
  })
}

const TARGETS = [
  { id: 'cenc_eew', file: 'cenc-eew-last.json', note: '地震预警：最后一条（ReportNum 多报）' },
  { id: 'cenc_eqlist', file: 'cenc-eqlist-last.json', note: '地震速报：最新 50 条整表 + md5' },
]

if (!DRY) mkdirSync(OUT_DIR, { recursive: true })

for (const t of TARGETS) {
  try {
    const data = USE_WS ? await fetchWs(t.id) : await fetchRest(t.id)
    const text = JSON.stringify(data, null, 2) + '\n'
    console.log('✓ ' + t.id + '（' + t.note + '）' + text.length + ' 字节')
    if (DRY) {
      console.log(text.slice(0, 400))
    } else {
      writeFileSync(path.join(OUT_DIR, t.file), text, 'utf8')
      console.log('  → samples/cn/' + t.file)
    }
  } catch (err) {
    console.error('✗ ' + t.id + ' 抓取失败：' + ((err && err.message) || err))
    console.error('  提示：先确认本机能连 api.wolfx.jp；大陆网络下的可达性见 TROUBLESHOOTING.zh.md')
    process.exitCode = 1
  }
}
