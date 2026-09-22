#!/usr/bin/env node
// dsh-quake-alert · 海外气象源 fixture 抓取（0.6.0）
//
// 用途：把美国 NWS 与加拿大 ECCC 的**真实响应**存进 `samples/`，作为解析器与回归断言的输入。
// 形态遵循 samples/nmc/ 的既有做法（0.5.2）：**裁剪但保持与真实响应同形**——
// 只删掉与本插件无关的条目，不重排字段、不改类型，否则测的就不是线上那条路径了。
//
// 为什么必须抓真实数据而不是手写 fixture：这两个源的字段名与枚举值（NWS 的 `event` 分类、
// ECCC 的 `alert_code` / `eventCode` / 双语）都不是猜得出来的，而解析器的白名单必须建立在
// 实测值域上（DESIGN 4.5「解析层严格，宁可失败也不猜」）。
//
// 用法：
//   node scripts/capture-overseas-fixtures.mjs            # 两个源都抓
//   node scripts/capture-overseas-fixtures.mjs --source=nws
//   node scripts/capture-overseas-fixtures.mjs --point=29.7604,-95.3698
//
// 退出码：0 = 抓取完成（网络不可达**不算失败**，与其它排障脚本同口径）；1 = 拿到响应但结构不符。
//
// 已知限制（不要在下一轮当成新发现）：ECCC 的灾种分布**随季节变化**，当前（北半球秋季）
// 活跃集里只有霜冻 / 风 / 风暴潮，**没有降雨类** —— 也就是说「ECCC 的降雨预警长什么样」
// 这份 fixture 回答不了，只能等它真实出现（DESIGN 4.6.3 / 4.7 已如实登记这个缺口）。

import { writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')
const UA = '(dsh-quake-alert 0.6.0 fixture capture)'

const argv = process.argv.slice(2)
const argOf = (n, d) => { const h = argv.find((a) => a.startsWith('--' + n + '=')); return h ? h.split('=').slice(1).join('=') : d }
const want = argOf('source', 'all')
const point = argOf('point', '29.7604,-95.3698')

/** 本插件接的 NWS 事件类型（洪水 / 山洪 / 沿海洪水）。白名单要**精确**，见 DESIGN 4.7。 */
const NWS_EVENTS = [
  'Flood Warning', 'Flash Flood Warning', 'Flood Advisory', 'Flood Watch',
  'Coastal Flood Warning', 'Coastal Flood Watch', 'Coastal Flood Advisory', 'Coastal Flood Statement',
]

function write(rel, text) {
  const p = join(ROOT, rel)
  mkdirSync(dirname(p), { recursive: true })
  writeFileSync(p, text, 'utf8')
  console.log('  写入 ' + rel + '（' + text.length + ' 字节）')
}

async function get(url) {
  const r = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(30000) })
  return { status: r.status, text: await r.text() }
}

// ---------------------------------------------------------------------------
// 美国 NWS：两个 fixture——① 洪水类列表（解析器的真实输入）② 按点的查询（0.6.0 的取数形态）
// ---------------------------------------------------------------------------
async function captureNws() {
  console.log('=== NWS ===')
  const q = '?event=' + NWS_EVENTS.map((e) => encodeURIComponent(e)).join(',')
  const r = await get('https://api.weather.gov/alerts/active' + q)
  if (r.status !== 200) { console.log('  列表：HTTP ' + r.status + '（跳过）'); return }
  let j
  try { j = JSON.parse(r.text) } catch (e) { console.log('  列表不是 JSON（可能被拦截）'); process.exitCode = 1; return }
  if (!Array.isArray(j.features)) { console.log('  列表缺少 features 数组'); process.exitCode = 1; return }
  console.log('  列表：' + j.features.length + ' 条 / ' + r.text.length + ' 字节')
  // 裁剪：每个 event 类型最多留 1 条（保证覆盖所有接进来的类型），其余删掉。
  // **保留完整的 properties 与 geometry**——正文（description / instruction）是解析目标。
  const seen = new Set()
  const kept = []
  for (const f of j.features) {
    const ev = f.properties && f.properties.event
    if (seen.has(ev)) continue
    seen.add(ev)
    kept.push(f)
  }
  const sample = { ...j, features: kept }
  write('samples/nws/nws-flood-alerts.geojson', JSON.stringify(sample, null, 1))
  console.log('  裁剪后保留类型：' + kept.map((f) => f.properties.event).join(' / '))

  const p = await get('https://api.weather.gov/alerts/active?point=' + encodeURIComponent(point))
  if (p.status === 200) {
    try { JSON.parse(p.text); write('samples/nws/nws-point-alerts.geojson', p.text) } catch (e) { console.log('  point 响应不是 JSON') }
  }
}

// ---------------------------------------------------------------------------
// 加拿大 ECCC：每种 alert_code 各留 1 条，**保留 geometry**（它 100% 带 Polygon，是匹配的输入）
// ---------------------------------------------------------------------------
async function captureEccc() {
  console.log('=== ECCC ===')
  const r = await get('https://api.weather.gc.ca/collections/weather-alerts/items?f=json&limit=200')
  if (r.status !== 200) { console.log('  HTTP ' + r.status + '（跳过）'); return }
  let j
  try { j = JSON.parse(r.text) } catch (e) { console.log('  不是 JSON'); process.exitCode = 1; return }
  if (!Array.isArray(j.features)) { console.log('  缺少 features 数组'); process.exitCode = 1; return }
  console.log('  ' + j.features.length + ' 条 / ' + r.text.length + ' 字节')
  const byCode = {}
  for (const f of j.features) {
    const c = f.properties && f.properties.alert_code
    if (!byCode[c]) byCode[c] = f
  }
  const sample = { ...j, features: Object.values(byCode) }
  write('samples/eccc/eccc-alerts.geojson', JSON.stringify(sample, null, 1))
  console.log('  裁剪后保留类型：' + Object.keys(byCode).map((c) => c + '→' + byCode[c].properties.alert_name_en).join(' / '))
  console.log('  ⚠ 当前季节没有降雨类：ECCC 的 rainfall 预警形态**未被本 fixture 覆盖**（DESIGN 4.6.3 已登记）')
}

console.log('dsh-quake-alert · 海外气象源 fixture 抓取\n')
if (want === 'all' || want === 'nws') await captureNws()
if (want === 'all' || want === 'eccc') await captureEccc()
console.log('\n完成。注意：样本是**单次快照**，灾种分布随季节变化。')
