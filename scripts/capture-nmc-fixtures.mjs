#!/usr/bin/env node
// dsh-quake-alert · 大陆气象源 fixture 抓取脚本（开发用，不入发行包）
//
// 作用：把 nmc.cn（中央气象台）的**真实结构**抓成 samples/nmc/ 下的 fixture，供回归测试在
//       不联网的情况下回放。与 capture-cn-fixtures.mjs 同一套路（DESIGN 11.4）。
//
// 抓两样东西，用途不同：
//   1. `alarm-list.json` —— 列表响应**裁剪到本插件接的两个灾种**（暴雨 / 地质灾害）。
//      完整响应 65KB 里 76% 是雷电 / 大风 / 高温（本插件不接），全量存下来只会让 fixture
//      变成"每天都不一样的大文件"，而测试要的恰恰是**稳定可比**的那部分结构。
//   2. `detail-<灾种>-<等级>.html` —— 详情页**完整**保存。它是 HTML（46KB），解析靠
//      lib/nmc-source.js 的 extractAlarmText，裁剪就验不到真实的页面结构了。
//      每个灾种 × 等级最多留一份（样本里暴雨只有蓝 / 黄 / 橙 / 红各若干）。
//
// 用法：
//   node scripts/capture-nmc-fixtures.mjs          # 抓取并写入 samples/nmc/
//   node scripts/capture-nmc-fixtures.mjs --dry    # 只打印摘要，不写盘
//
// 边界：只抓结构、不做判断。列表是"当前生效集合"，两次抓取的内容必然不同（预警随时发布 /
//      过期），所以 fixture 的 diff 天然是噪音，别把它当成"回归失败"。真正要固定的结构
//      是**字段形态**，那由 tests/sync-test.cjs 的断言来钉。

import { writeFileSync, mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const OUT_DIR = path.join(ROOT, 'samples', 'nmc')
const DRY = process.argv.includes('--dry')
const TIMEOUT_MS = 25000

const LIST_URL = 'https://www.nmc.cn/rest/findAlarm?pageNo=1&pageSize=500'
const DETAIL_BASE = 'https://www.nmc.cn/publish/alarm/'
// 与 lib/nmc-source.js 的 NMC_KINDS 对齐（脚本不 import 它：scripts/ 不入发行包，
// 反向依赖 lib/ 会让"抓样本"这件事被实现细节绑住；不一致时下面的摘要会打印出陌生的灾种码）
const KIND_BY_CODE = { 2: 'rainstorm', 21: 'geology' }
const LEVEL_BY_CODE = { 1: 'red', 2: 'orange', 3: 'yellow', 4: 'blue' }

const HEADERS = {
  'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
  // 站点没声明 API，带上 Referer 表明来源页面（与浏览器访问同形）
  referer: 'https://www.nmc.cn/publish/alarm.html',
}

async function getText(url) {
  const res = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(TIMEOUT_MS) })
  if (!res.ok) throw new Error('HTTP ' + res.status + ' ' + url)
  return res.text()
}

function codesOf(pic) {
  const m = /\/p(\d{4})(\d{3})\.(?:png|gif|jpg)/i.exec(String(pic || ''))
  if (!m) return null
  return { kindCode: Number(m[1]), levelCode: Number(m[2]) }
}

if (!DRY) mkdirSync(OUT_DIR, { recursive: true })

let listJson
try {
  listJson = JSON.parse(await getText(LIST_URL))
} catch (err) {
  console.error('✗ 列表抓取失败：' + ((err && err.message) || err))
  console.error('  提示：先确认本机能连 www.nmc.cn；大陆网络下的可达性见 TROUBLESHOOTING.zh.md')
  process.exit(1)
}

const all = (listJson && listJson.data && listJson.data.page && listJson.data.page.list) || []
if (!Array.isArray(all) || all.length === 0) {
  console.error('✗ 列表里没有条目（结构变了？）：' + JSON.stringify(listJson).slice(0, 200))
  process.exit(1)
}

const kept = []
const byLevel = new Map() // 灾种×等级 → 第一条（用于挑详情样本）
for (const it of all) {
  const codes = codesOf(it.pic)
  if (!codes) continue
  const kind = KIND_BY_CODE[codes.kindCode]
  if (!kind) continue
  const level = LEVEL_BY_CODE[codes.levelCode]
  if (!level) continue
  kept.push({
    alertid: String(it.alertid || ''),
    issuetime: String(it.issuetime || ''),
    title: String(it.title || ''),
    url: String(it.url || ''),
    pic: String(it.pic || ''),
  })
  const key = kind + '-' + level
  if (!byLevel.has(key)) byLevel.set(key, { kind, level, alertid: String(it.alertid || '') })
}

// 裁剪后的列表：与真实响应**同形**（同样的 data.page.list 路径），只是 list 里只剩接的灾种。
// 保持同形是有意的——解析器（lib/nmc-source.js 的 parseNmcList）读的就是这个路径，
// 若 fixture 换一套结构，测的就不是线上那条路径了。
const trimmed = {
  msg: listJson.msg,
  code: listJson.code,
  data: {
    page: {
      pageNo: listJson.data.page.pageNo,
      pageSize: listJson.data.page.pageSize,
      count: listJson.data.page.count,
      totalPage: listJson.data.page.totalPage,
      list: kept,
    },
  },
  // 记下"完整列表里有多少条、我们留了多少条"，让样本自己说明裁剪比例（省得下次再数）
  _note: '裁剪自 ' + LIST_URL + '：完整列表 ' + all.length + ' 条，本插件接的两类共 ' + kept.length + ' 条',
}
const listText = JSON.stringify(trimmed, null, 2) + '\n'
console.log('✓ 列表：完整 ' + all.length + ' 条 → 保留 ' + kept.length + ' 条（' + listText.length + ' 字节）')
if (DRY) console.log(listText.slice(0, 600))
else {
  writeFileSync(path.join(OUT_DIR, 'alarm-list.json'), listText, 'utf8')
  console.log('  → samples/nmc/alarm-list.json')
}

for (const key of Array.from(byLevel.keys()).sort()) {
  const t = byLevel.get(key)
  const file = 'detail-' + t.kind + '-' + t.level + '.html'
  try {
    const html = await getText(DETAIL_BASE + encodeURIComponent(t.alertid) + '.html')
    console.log('✓ 详情 ' + key + '（' + t.alertid + '）' + html.length + ' 字节')
    if (DRY) console.log('  ' + html.slice(0, 200).replace(/\s+/g, ' '))
    else {
      writeFileSync(path.join(OUT_DIR, file), html, 'utf8')
      console.log('  → samples/nmc/' + file)
    }
  } catch (err) {
    console.error('✗ 详情 ' + key + ' 抓取失败：' + ((err && err.message) || err))
    process.exitCode = 1
  }
}

if (byLevel.size === 0) {
  console.error('✗ 完整列表里没有本插件接的灾种——检查 KIND_BY_CODE 是否与 lib/nmc-source.js 一致')
  process.exitCode = 1
}
