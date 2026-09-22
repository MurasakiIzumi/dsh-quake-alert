#!/usr/bin/env node
// dsh-quake-alert · 海外气象源 fixture 抓取（0.6.0；0.6.1 追加两条事件链）
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

import { writeFileSync, readFileSync, mkdirSync } from 'node:fs'
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

/**
 * 白名单自检（0.6.2）：上面那份名单是**手抄的第二份**（`client/src` 的 ESM 依赖 `react`，
 * Node 下 import 不进来）。往 05h 的白名单里加一类洪水产品却忘了同步这里时，抓取本身不会报错——
 * 它只是永远抓不回那一类的样本，于是新类型**没有任何回归断点**。这里用读源码文本的方式比对。
 */
function assertWhitelistInSync() {
  const src = readFileSync(join(ROOT, 'client', 'src', '05h-overseas-parsers.js'), 'utf8')
  const inSource = [...src.matchAll(/^\s*'([^']+)':\s*\{\s*kind:/gm)].map((m) => m[1]).sort()
  const mine = [...NWS_EVENTS].sort()
  if (inSource.length === 0) {
    console.log('  ✗ 白名单自检：没能从 client/src/05h 里解析出白名单（正则与实现脱节了？）')
    process.exitCode = 1
    return false
  }
  if (inSource.join('|') !== mine.join('|')) {
    console.log('  ✗ 抓取名单与 client/src/05h 的白名单不一致：')
    console.log('     client/src/05h =', inSource.join(' / '))
    console.log('     本脚本         =', mine.join(' / '))
    process.exitCode = 1
    return false
  }
  console.log('  白名单自检：' + mine.length + ' 类与 client/src/05h 一致')
  return true
}

/** 从一条 properties 里取 VTEC 的事件追踪号（与 05h 的 nwsVtecKeyOf 同一规则，用于**校验**）。 */
function vtecOf(props) {
  const list = (props && props.parameters && props.parameters.VTEC) || []
  for (const raw of (Array.isArray(list) ? list : [])) {
    const m = /\/O\.[A-Z]{3}\.([A-Z0-9]{4})\.([A-Z]{2})\.([A-Z])\.(\d{4})\./.exec(String(raw || ''))
    if (m) return m[1] + '.' + m[2] + '.' + m[3] + '.' + m[4]
  }
  return ''
}

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
  if (!assertWhitelistInSync()) return
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
  // numberMatched / numberReturned 要跟着**裁剪后**的条数走（0.6.2）：它们原本留的是全量数字，
  // 于是 fixture 与"裁剪但保持与真实响应同形"的自我声明冲突——any 拿它当响应体的用例都会
  // 恒判"被分页截断"（假警报）。
  const sample = Object.assign({}, j, {
    features: kept,
    numberMatched: kept.length,
    numberReturned: kept.length,
  })
  write('samples/nws/nws-flood-alerts.geojson', JSON.stringify(sample, null, 1))
  console.log('  裁剪后保留类型：' + kept.map((f) => f.properties.event).join(' / '))

  const p = await get('https://api.weather.gov/alerts/active?point=' + encodeURIComponent(point))
  if (p.status === 200) {
    try { JSON.parse(p.text); write('samples/nws/nws-point-alerts.geojson', p.text) } catch (e) { console.log('  point 响应不是 JSON') }
  }

  await captureNwsEventChains(j)
}

/**
 * 两条**事件链** fixture（0.6.1）。存在的理由：0.6.0 的事件键算法是用"同一 serial 递增 version"
 * 的**合成**样本验证的，而实测的链是**逐版串联**的（每条只 `references` 紧邻的上一版）——
 * 合成样本永远发现不了那件事，真实链一抓就露。所以这两条 fixture 是**证据**，不是装饰：
 *   ① 同一次洪水预警的连续两版：identifier / sent 都不同，**VTEC 追踪号相同**；
 *   ② 一条 Cancel + 它 `references` 的那条警报：VTEC 只有 ACTION 段不同（EXT/CON → CAN）。
 * 任何一条重新抓都要能重现"同键"这个结论，否则说明上游换了事件标识的语义（DESIGN 4.7.4）。
 */
async function captureNwsEventChains(activeJson) {
  const feats = (activeJson && activeJson.features) || []
  const upd = feats.find((f) => f && f.properties && /Warning$/.test(f.properties.event) &&
    f.properties.messageType === 'Update' && (f.properties.references || []).length > 0)
  if (!upd) {
    console.log('  事件链：当前活跃集里没有带 references 的 Warning 类，跳过（下次再抓）')
  } else {
    const prev = await getAlertJson(upd.properties.references[0].identifier)
    if (!prev) {
      // 静默跳过一次抓取看起来和成功一样（0.6.2）：明说，且**不写盘**——半成品 fixture 比没有更糟。
      console.log('  事件链：被引用的上一版拉取失败，跳过（不写盘）')
    } else if (!vtecOf(prev.properties) || vtecOf(prev.properties) !== vtecOf(upd.properties)) {
      // 写盘**之前**验证（0.6.2）：note 里断言"两版 VTEC 追踪号相同"，而上游若改了事件标识的
      // 语义，这里必须当场失败，而不是把一条自相矛盾的"证据"提交进仓库（回归用例会红，
      // 但 fixture 已经被覆盖了）。
      console.log('  ✗ 事件链的两版 VTEC 追踪号不同（prev=' + (vtecOf(prev.properties) || '(无)') +
        ' upd=' + (vtecOf(upd.properties) || '(无)') + '）——不写盘，请复核事件键的来源')
      process.exitCode = 1
    } else {
      write('samples/nws/nws-event-chain.geojson', JSON.stringify({
        type: 'FeatureCollection',
        note: '真实的 NWS 事件链：同一次洪水预警的两个连续版本（都是 Update）。两版的 VTEC 追踪号' +
          '（<office>.<phenom>.<sig>.<ETN>）相同，而 CAP identifier / sent / ends 每次都不同 —— ' +
          '事件键必须落在 VTEC 上（用 references 只能回溯一步，见 05h 的 nwsEventKeyOf）。',
        features: [prev, upd],
      }, null, 2) + '\n')
      console.log('  事件链：' + upd.properties.event + ' · ' + vtecOf(upd.properties) +
        '（两版同键，已校验）')
    }
  }

  const r = await get('https://api.weather.gov/alerts?message_type=cancel&event=' +
    encodeURIComponent('Flood Warning') +
    '&start=' + encodeURIComponent(new Date(Date.now() - 7 * 864e5).toISOString()) +
    '&end=' + encodeURIComponent(new Date().toISOString()) + '&limit=5')
  if (r.status !== 200) { console.log('  Cancel 列表：HTTP ' + r.status + '（跳过）'); return }
  let cj
  try { cj = JSON.parse(r.text) } catch (e) { console.log('  Cancel 列表不是 JSON'); return }
  const can = (cj.features || []).find((f) => (f.properties.references || []).length > 0)
  if (!can) { console.log('  Cancel 列表里没有可用样本，跳过'); return }
  const orig = await getAlertJson(can.properties.references[0].identifier)
  if (!orig) { console.log('  被取消的消息拉取失败，跳过'); return }
  write('samples/nws/nws-cancel-chain.geojson', JSON.stringify({
    type: 'FeatureCollection',
    note: '真实的 NWS 取消链路：Cancel 与它取消的那条警报。两者的 VTEC 追踪号相同（ACTION 段' +
      '从 EXT/NEW 变成 CAN），CAP identifier 则完全不同 —— 用 VTEC 做事件键，' +
      'wasRecentlyAlerted 才能认出"此前播报过的警报已作废"。',
    features: [orig, can],
  }, null, 2) + '\n')
  console.log('  Cancel 链：' + JSON.stringify((can.properties.parameters || {}).VTEC || null))
}

async function getAlertJson(id) {
  const r = await get('https://api.weather.gov/alerts/' + encodeURIComponent(id))
  if (r.status !== 200) return null
  try {
    const j = JSON.parse(r.text)
    return j && j.properties ? j : null
  } catch (e) { return null }
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
  const sample = Object.assign({}, j, {
    features: Object.values(byCode),
    numberMatched: Object.keys(byCode).length,
    numberReturned: Object.keys(byCode).length,
  })
  write('samples/eccc/eccc-alerts.geojson', JSON.stringify(sample, null, 1))
  console.log('  裁剪后保留类型：' + Object.keys(byCode).map((c) => c + '→' + byCode[c].properties.alert_name_en).join(' / '))
  console.log('  ⚠ 当前季节没有降雨类：ECCC 的 rainfall 预警形态**未被本 fixture 覆盖**（DESIGN 4.6.3 已登记）')
}

console.log('dsh-quake-alert · 海外气象源 fixture 抓取\n')
if (want === 'all' || want === 'nws') await captureNws()
if (want === 'all' || want === 'eccc') await captureEccc()
console.log('\n完成。注意：样本是**单次快照**，灾种分布随季节变化。')
