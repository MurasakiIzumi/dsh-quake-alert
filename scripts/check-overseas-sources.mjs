#!/usr/bin/env node
// dsh-quake-alert · 0.6.0 海外气象源候选复现探针（开发 / 决策用，不入发行包）
//
// 用途：把 DESIGN 4.6「海外气象灾害：候选源调研」里的每一条实测数字**用一条命令复现**。
// 那一节的全部结论（只有美国 NWS 三项达标、MeteoAlarm 与插件范围错位、GDACS 粒度不可用）
// 都写成了具体数字——这个脚本就是那些数字的来源，避免它们变成"某个会话里说过的话"。
//
// 四个源各回答三件事：
//   ① 可达吗、免 key 吗、**浏览器能不能直连**（CORS）——最后一条直接决定 Host 还是 Client 取数；
//   ② 灾种分布是什么、与本插件（地震 / 海啸 / 泥石流 / 洪水）有多少交集；
//   ③ 体积与请求量落在哪个量级（决定是"拉全量后在 Client 过滤"还是"按关注点查询"）。
//
// 这不是运行时的健康检查，也不是 CI 的一部分：它依赖四个外部服务，形态与
// `check-wolfx-live.mjs` / `check-cn-e2e.mjs` 一致——**改海外源相关设计前后手动跑一次**。
//
// 用法：
//   node scripts/check-overseas-sources.mjs                    # 四个源全查
//   node scripts/check-overseas-sources.mjs --source=nws
//   node scripts/check-overseas-sources.mjs --point=29.7604,-95.3698   # 覆盖 NWS 的采样点
//   node scripts/check-overseas-sources.mjs --countries=germany,france,italy
//
// 退出码：0 = 四个源都探测完成（**网络不可达不算失败**，与 check-contracts.mjs 同口径——
// 调研脚本不该因为一次网络抖动就红）；1 = 某个源**可达但结构不符**（上游改版，4.6 的结论要复核）。
//
// 证据等级：这里给的是**单次快照**。灾种分布受季节影响（北半球秋季的洪水明显少于夏季），
// 所以"某源当前没有某灾种"只能当作"未被证实"，不能当作"没有"——4.6.3 的 ECCC 就是这种情形。

const UA = '(dsh-quake-alert 0.6.0 research)'
const TIMEOUT_MS = 25000

const argv = process.argv.slice(2)
const argOf = (name, dflt) => {
  const hit = argv.find((a) => a.startsWith('--' + name + '='))
  return hit ? hit.split('=').slice(1).join('=') : dflt
}
const wantSource = argOf('source', 'all')
const wantPoint = argOf('point', '29.7604,-95.3698')
const wantCountries = argOf('countries', 'germany,france,italy,spain,netherlands,belgium,poland,sweden,norway,finland,ireland,portugal,greece,switzerland,austria,denmark,croatia,romania,hungary,czechia')

const problems = []
const notes = []

function bytes(n) { return n < 1024 ? n + 'B' : (n / 1024).toFixed(n < 102400 ? 1 : 0) + 'KB' }
function topN(obj, n) {
  return Object.entries(obj).sort((a, b) => b[1] - a[1]).slice(0, n).map(([k, v]) => k + '×' + v).join('  ')
}

/**
 * 一次 GET，返回 { status, headers, text, ms } 或抛错。
 * 刻意不做重试：调研要的是"这台机器此刻看到的是什么"，重试会把"慢"掩盖成"正常"。
 */
async function get(url, extraHeaders = {}) {
  const t0 = Date.now()
  const res = await fetch(url, { headers: { 'User-Agent': UA, ...extraHeaders }, signal: AbortSignal.timeout(TIMEOUT_MS) })
  const text = await res.text()
  return { status: res.status, headers: res.headers, text, ms: Date.now() - t0 }
}

// ---------------------------------------------------------------------------
// ① 美国 NWS —— 4.6.1
// ---------------------------------------------------------------------------
async function probeNws() {
  console.log('=== 美国 NWS `api.weather.gov`（DESIGN 4.6.1）===')
  // 洪水 / 山洪 / 泥石流类。NWS **没有**独立的 debris flow 事件类型，它写在 Flash Flood 的正文里。
  const FLOOD_RE = /flood|debris flow|landslide|hydrolog/i
  let all
  try {
    all = await get('https://api.weather.gov/alerts/active')
  } catch (err) {
    console.log('  ✗ 不可达：' + String(err.message || err))
    console.log('    → 归类 unreachable。本机连不上 api.weather.gov；4.6.1 的结论需要在可达的网络上复核。')
    notes.push('NWS 不可达（不计失败）')
    return
  }
  if (all.status !== 200) { problems.push('NWS /alerts/active HTTP ' + all.status); console.log('  ✗ HTTP ' + all.status); return }
  let json
  try { json = JSON.parse(all.text) } catch (err) { problems.push('NWS 全量不是合法 JSON'); console.log('  ✗ 返回不是 JSON（可能是拦截页）'); return }
  // 顶层形状判据（0.6.1 review）：缺了它，`{oops:1}` 会被当成"0 条"走完整个函数，
  // 输出"本插件关心的洪水类：0 条"、`problems` 为空、脚本 exit 0 —— 而"上游改版"与
  // "这一刻确实没有预警"在这份输出里完全同形，本脚本唯一的自动化职责就静默失效了。
  if (!json || !Array.isArray(json.features)) {
    problems.push('NWS /alerts/active 缺少 features 数组（结构变了）')
    console.log('  ✗ 缺少 features 数组（上游结构变了，契约要复核）')
    return
  }
  const feats = json.features
  const byEvent = {}
  let noGeom = 0
  let noZones = 0
  for (const f of feats) {
    const p = f.properties || {}
    byEvent[p.event] = (byEvent[p.event] || 0) + 1
    if (!f.geometry) noGeom += 1
    if (!(p.affectedZones || []).length) noZones += 1
  }
  const floods = feats.filter((f) => FLOOD_RE.test((f.properties || {}).event || ''))
  const floodGeom = floods.filter((f) => f.geometry).length
  const floodSev = {}
  for (const f of floods) floodSev[f.properties.severity] = (floodSev[f.properties.severity] || 0) + 1
  const durs = floods
    .map((f) => (Date.parse(f.properties.expires) - Date.parse(f.properties.effective)) / 60000)
    .filter(Number.isFinite).sort((a, b) => a - b)

  console.log('  可达：' + all.status + ' · ' + bytes(all.text.length) + ' · ' + all.ms + 'ms · ' + feats.length + ' 条')
  console.log('  灾种（前 8）：' + topN(byEvent, 8))
  console.log('  本插件关心的洪水类：' + floods.length + ' 条 · severity ' + JSON.stringify(floodSev))
  if (durs.length) console.log('  洪水类有效期：中位 ' + durs[Math.floor(durs.length / 2)] + ' 分钟 · 最短 ' + durs[0] + ' · 最长 ' + durs[durs.length - 1])
  console.log('  空间：无 geometry ' + noGeom + '/' + feats.length + '（洪水类 ' + floodGeom + '/' + floods.length + '）· 无 affectedZones ' + noZones)
  console.log('  噪声：Test Message ' + (byEvent['Test Message'] || 0) + ' 条（须过滤）')

  // CORS：这一条决定 Client 能不能直连（4.6.5 的架构结论）
  try {
    const cors = await get('https://api.weather.gov/alerts/active?point=' + wantPoint, { Origin: 'http://127.0.0.1:3080' })
    const acao = cors.headers.get('access-control-allow-origin')
    console.log('  CORS：' + (acao ? 'ACAO=' + acao + ' → **Client 可直连**' : '无 ACAO → 必须走 Host'))
    console.log('  `?point=' + wantPoint + '`：' + bytes(cors.text.length) + ' · ' + cors.ms + 'ms')
  } catch (err) { console.log('  CORS 探测失败：' + String(err.message || err)) }

  // 体积对照与多值 area 的真实行为（`?area=A&area=B` 只取最后一个，必须用逗号）
  for (const q of ['?severity=Severe,Extreme', '?event=Flood%20Warning,Flash%20Flood%20Warning', '?area=CA', '?area=CA,TX', '?area=CA&area=TX']) {
    try {
      const r = await get('https://api.weather.gov/alerts/active' + q)
      let n = '?'
      try { n = JSON.parse(r.text).features.length } catch (err) { n = 'n/a' }
      console.log('    ' + q.padEnd(48) + ' → ' + bytes(r.text.length).padStart(7) + ' · ' + n + ' 条')
    } catch (err) { console.log('    ' + q + ' → 失败 ' + String(err.message || err)) }
  }
  console.log('  → 全量 1.72MB 量级 × 高频轮询不可用；`?point=` 才是可用形态（见 4.6.5 第 1 条）。')
}

// ---------------------------------------------------------------------------
// ② 欧洲 MeteoAlarm —— 4.6.2
// ---------------------------------------------------------------------------
async function probeMeteoAlarm() {
  console.log('\n=== 欧洲 MeteoAlarm（DESIGN 4.6.2）===')
  // 先确认"有没有全欧汇总 feed"——这决定是 1 个请求还是 30+ 个
  for (const u of ['https://feeds.meteoalarm.org/feeds/meteoalarm-legacy-atom-europe', 'https://feeds.meteoalarm.org/feeds/meteoalarm-legacy-rss-europe']) {
    try {
      const r = await get(u)
      const entries = (r.text.match(/<entry\b/g) || []).length + (r.text.match(/<item\b/g) || []).length
      console.log('  ' + u.replace('https://feeds.meteoalarm.org/feeds/', '') + ' → HTTP ' + r.status + ' · ' + bytes(r.text.length) + ' · ' + entries + ' 条')
    } catch (err) { console.log('  ' + u + ' → 失败 ' + String(err.message || err)) }
  }
  console.log('  → 以上若为 404 / 空壳，则**没有全欧汇总端点**，覆盖欧洲必须逐国订阅。')

  const countries = wantCountries.split(',').map((s) => s.trim()).filter(Boolean)
  const evAll = {}
  const sevAll = {}
  let total = 0
  for (const c of countries) {
    try {
      const r = await get('https://feeds.meteoalarm.org/feeds/meteoalarm-legacy-atom-' + c)
      const evs = {}
      for (const m of r.text.matchAll(/<cap:event>([^<]*)<\/cap:event>/g)) { evs[m[1]] = (evs[m[1]] || 0) + 1; evAll[m[1]] = (evAll[m[1]] || 0) + 1 }
      for (const m of r.text.matchAll(/<cap:severity>([^<]*)<\/cap:severity>/g)) sevAll[m[1]] = (sevAll[m[1]] || 0) + 1
      const n = (r.text.match(/<entry\b/g) || []).length
      total += n
      console.log('    ' + c.padEnd(14) + bytes(r.text.length).padStart(8) + ' · ' + String(n).padStart(3) + ' 条 · ' + (topN(evs, 3) || '（空）'))
    } catch (err) { console.log('    ' + c.padEnd(14) + ' 失败 ' + String(err.message || err)) }
  }
  console.log('  ' + countries.length + ' 国合计：' + total + ' 条 · severity ' + JSON.stringify(sevAll))
  console.log('  灾种合计（前 8）：' + topN(evAll, 8))
  const wind = Object.entries(evAll).filter(([k]) => /wind|gale|gust/i.test(k)).reduce((s, [, v]) => s + v, 0)
  const flood = Object.entries(evAll).filter(([k]) => /flood/i.test(k)).reduce((s, [, v]) => s + v, 0)
  console.log('  其中 wind 类 ' + wind + ' 条 · flood 类 ' + flood + ' 条 → 与插件范围的交集')
  const severe = sevAll.Severe || 0
  console.log('  Severe ' + severe + ' 条 → 按 DESIGN 3.2 的误报密度判据衡量信噪比')

  // CORS 与（需授权的）OGC EDR：这两条决定接入形态
  try {
    const r = await get('https://feeds.meteoalarm.org/feeds/meteoalarm-legacy-atom-italy', { Origin: 'http://127.0.0.1:3080' })
    const acao = r.headers.get('access-control-allow-origin')
    console.log('  CORS：' + (acao ? 'ACAO=' + acao : '无 ACAO → **必须走 Host 代理**（feed 没有 CORS 头）'))
  } catch (err) { console.log('  CORS 探测失败：' + String(err.message || err)) }
  try {
    const r = await get('https://api.meteoalarm.org/edr/v1/collections/warnings/locations/48.2,16.37')
    console.log('  OGC EDR 坐标查询（locations）：HTTP ' + r.status + ' ' + r.text.slice(0, 60).replace(/\s+/g, ' ') +
      (r.status === 401 ? ' → **需要授权**：最好的那条路（按坐标取预警）要申请账号' : ''))
  } catch (err) { console.log('  OGC EDR 探测失败：' + String(err.message || err)) }
}

// ---------------------------------------------------------------------------
// ③ 加拿大 ECCC —— 4.6.3
// ---------------------------------------------------------------------------
async function probeEccc() {
  console.log('\n=== 加拿大 ECCC `api.weather.gc.ca`（DESIGN 4.6.3）===')
  let r
  try {
    r = await get('https://api.weather.gc.ca/collections/weather-alerts/items?limit=200&f=json')
  } catch (err) {
    console.log('  ✗ 不可达：' + String(err.message || err)); notes.push('ECCC 不可达（不计失败）'); return
  }
  if (r.status !== 200) { problems.push('ECCC HTTP ' + r.status); console.log('  ✗ HTTP ' + r.status); return }
  let json
  try { json = JSON.parse(r.text) } catch (err) { problems.push('ECCC 返回不是合法 JSON'); console.log('  ✗ 不是 JSON'); return }
  if (!json || !Array.isArray(json.features)) {
    problems.push('ECCC 缺少 features 数组（结构变了）')
    console.log('  ✗ 缺少 features 数组（上游结构变了，契约要复核）')
    return
  }
  const feats = json.features
  const combos = {}
  let noGeom = 0
  for (const f of feats) {
    const p = f.properties || {}
    const k = String(p.alert_code) + ' → ' + String(p.alert_name_en) + '（' + p.alert_type + ' / ' + p.risk_colour_en + '）'
    combos[k] = (combos[k] || 0) + 1
    if (!f.geometry) noGeom += 1
  }
  console.log('  可达：' + r.status + ' · ' + bytes(r.text.length) + ' · ' + r.ms + 'ms · ' + feats.length + ' 条')
  console.log('  类型（code → 官方英文名）：')
  for (const [k, v] of Object.entries(combos).sort((a, b) => b[1] - a[1]).slice(0, 8)) console.log('    ' + String(v).padStart(4) + '× ' + k)
  console.log('  几何覆盖：' + (feats.length - noGeom) + '/' + feats.length + ' 带 Polygon（与 NWS 相反）')
  console.log('  ⚠ **读 `alert_name_en`，不要猜码**：实测 `CFW` = storm surge warning（风暴潮），不是洪水；')
  console.log('    而美国 SAME 码体系里 `CFW` = Coastal Flood Warning —— 两套体系不能互套（4.6.3 踩过一次）。')
  console.log('  ⚠ **语言变体**：CAP 归档里法语办公室（CWUL 魁北克）的 `<event>` 是 "gel"（`eventCode` 仍是 frost）')
  console.log('    → 解析要用 `eventCode` 或做双语映射，按英文名硬编码会漏掉魁北克。')
  console.log('  ⚠ **河川洪水预警不归 ECCC**：由省级机构发布（如 BC River Forecast Centre 的 flood watch/warning、')
  console.log('    多伦多由 TRCA 保护局），没有国家级统一 API。ECCC 提供的是气象预警 + 沿海（storm surge）。')
  console.log('  ⚠ **历史不可得**：CAP 归档 `dd.weather.gc.ca/today/alerts/cap/` 实测只有当天目录（3 天取样失败），')
  console.log('    所以"某灾种是否存在"只能靠长期观察，不能靠回溯查询。')
  console.log('  ⚠ 许可是**硬约束**：ECCC End-use Licence v2.1.1 允许再分发，但要求署名')
  console.log('    （"Data Source: Environment and Climate Change Canada"）且警报**不得改变内容或意图**')
  console.log('    → 归一化不能拔高等级（frost advisory 不许变成 warning）。')
  try {
    const cors = await get('https://api.weather.gc.ca/collections/weather-alerts/items?limit=1&f=json', { Origin: 'http://127.0.0.1:3080' })
    const acao = cors.headers.get('access-control-allow-origin')
    console.log('  CORS：' + (acao ? 'ACAO=' + acao + ' → **Client 可直连**' : '无 ACAO → 必须走 Host'))
  } catch (err) { console.log('  CORS 探测失败：' + String(err.message || err)) }
}

// ---------------------------------------------------------------------------
// ④ GDACS —— 4.6.4（结论是否决，脚本只负责让否决有据可查）
// ---------------------------------------------------------------------------
async function probeGdacs() {
  console.log('\n=== GDACS（DESIGN 4.6.4，已否决）===')
  let r
  try {
    r = await get('https://www.gdacs.org/gdacsapi/api/events/geteventlist/SEARCH')
  } catch (err) { console.log('  ✗ 不可达：' + String(err.message || err)); notes.push('GDACS 不可达（不计失败）'); return }
  if (r.status !== 200) { problems.push('GDACS HTTP ' + r.status); console.log('  ✗ HTTP ' + r.status); return }
  let json
  try { json = JSON.parse(r.text) } catch (err) { problems.push('GDACS 返回不是合法 JSON'); console.log('  ✗ 不是 JSON'); return }
  if (!json || !Array.isArray(json.features)) {
    problems.push('GDACS 缺少 features 数组（结构变了）')
    console.log('  ✗ 缺少 features 数组（上游结构变了，契约要复核）')
    return
  }
  const feats = json.features
  const byType = {}
  for (const f of feats) byType[f.properties.eventtype] = (byType[f.properties.eventtype] || 0) + 1
  const NAMES = { EQ: '地震', FL: '洪水', TC: '台风', WF: '山火', DR: '干旱', VO: '火山' }
  console.log('  可达：' + r.status + ' · ' + bytes(r.text.length) + ' · ' + r.ms + 'ms · ' + feats.length + ' 条')
  console.log('  灾种：' + Object.entries(byType).map(([k, v]) => (NAMES[k] || k) + '×' + v).join('  '))
  const inScope = (byType.EQ || 0) + (byType.FL || 0)
  console.log('  与插件范围有交集的只有 ' + inScope + ' 条（' + NAMES.EQ + ' / ' + NAMES.FL + '），' +
    '其余（台风 / 山火 / 干旱 / 火山）不在范围内')
  const sample = feats.find((f) => f.properties.eventtype === 'FL')
  if (sample) console.log('  粒度样例：' + sample.properties.name + ' · country=' + sample.properties.country + ' → **国家 / 区域级**，按 3.2 判据不可用')
  // RSS 通道慢到不适合轮询（实测量级），顺带量一次
  try {
    const rss = await get('https://www.gdacs.org/xml/rss.xml')
    console.log('  RSS 通道：' + bytes(rss.text.length) + ' · **' + (rss.ms / 1000).toFixed(1) + 's**（慢）')
  } catch (err) { console.log('  RSS 探测失败：' + String(err.message || err)) }
}

// ---------------------------------------------------------------------------
const runAll = wantSource === 'all'
const jobs = []
if (runAll || wantSource === 'nws') jobs.push(['nws', probeNws])
if (runAll || wantSource === 'meteoalarm') jobs.push(['meteoalarm', probeMeteoAlarm])
if (runAll || wantSource === 'eccc') jobs.push(['eccc', probeEccc])
if (runAll || wantSource === 'gdacs') jobs.push(['gdacs', probeGdacs])
if (!jobs.length) {
  console.log('未知的 --source=' + wantSource + '（可选：all / nws / meteoalarm / eccc / gdacs）')
  process.exit(2)
}

console.log('dsh-quake-alert · 0.6.0 海外气象源候选探针')
console.log('本机出口 IP 的地理位置会影响可达性；下面的数字对应 DESIGN 4.6 的表格，可逐条对照。\n')
for (const [, fn] of jobs) {
  try { await fn() } catch (err) { problems.push(String((err && err.message) || err)); console.log('  探测抛错：' + String((err && err.message) || err)) }
}

console.log('\n--- 汇总 ---')
if (notes.length) console.log('未完成：' + notes.join('；') + '（网络原因不算失败）')
if (problems.length) {
  console.log('结构问题（上游可能已改版，DESIGN 4.6 的结论需要复核）：')
  for (const p of problems) console.log('  · ' + p)
  process.exit(1)
}
console.log('结论：四个源全部探测完成，结构与 DESIGN 4.6 记录的一致。')
console.log('提醒：这是单次快照，灾种分布受季节影响；"当前没有某灾种"只等于"未被证实"。')
process.exit(0)
