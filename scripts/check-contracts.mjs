#!/usr/bin/env node
// dsh-quake-alert · 上游数据契约检查
//
// 把**真实的上游数据**原样交给 client bundle 里的解析器，看它还认不认。上游改字段名 / 改类型 /
// 改单位时解析器会返回 `schema` / `value`，那就是契约漂移；其余测试都基于 `samples/` 快照，
// 所以这是唯一能在上游改版当天发现问题的入口。
// 用法：
//   node scripts/check-contracts.mjs              # 真实拉取每个源（需要网络）
//   node scripts/check-contracts.mjs --offline    # 只用 samples/ 的快照，不联网
//   node scripts/check-contracts.mjs --json       # 结果打成 JSON（给 CI / 工具读）
//
// 退出码：0 = 通过；1 = 有源不通过。判定规则：
//   · empty → **也算通过**。"源正常，但当前没有与本插件相关的数据"是合法形态：P2PQuake 会推
//     火山消息、JMA 大量电文是天气预报、NOAA 通常没有海啸、EMSC 会推非地震事件。
//   · schema / value（= 契约漂移）→ 失败；同时打印解析器的 detail 与该源 `required` 原文。
//   · 网络不可达 / 超时 / 非预期状态码 → 记 `unreachable`，**不算失败**。
//   · --offline 下只接受 ok：样本是刻意挑的有效数据，解析不出 Alert 说明脚本自身坏了；
//     离线取数抛错记 `fixture`，同样算失败。
//
// 边界：`empty` 与"结构变了、解析器认不出来"在解析器层面可能同形（JMA 的 `<Kind><Name>` 语义被换掉
// → 判"无警戒レベル" → empty，而 empty 是通过的）；脚本只能把每条 detail 原样打印出来。

import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadClient, CLIENT_PATH } from './lib/load-client.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const OFFLINE = process.argv.includes('--offline')
const AS_JSON = process.argv.includes('--json')

/** 单源超时，与 Host 侧外部请求的超时一致。 */
const TIMEOUT_MS = 20000

/**
 * 请求头带 UA 与 Referer：nmc.cn 会拒没有来源页的请求，而"被拒"会被归到 unreachable，源就看不见了。
 */
const HEADERS = {
  'user-agent': 'Mozilla/5.0 (compatible; dsh-quake-alert-contract-check)',
  referer: 'https://www.nmc.cn/publish/alarm.html',
}

/** 网络层的失败：超时 / 连不上 / 非 2xx，只有它会被归成 `unreachable`（不算失败）。 */
class Unreachable extends Error {}

const samplePath = (rel) => path.join(ROOT, 'samples', rel)
function readText(rel) { return readFileSync(samplePath(rel), 'utf8') }
function readJson(rel) { return JSON.parse(readText(rel)) }

async function getText(url) {
  let res
  try {
    res = await fetch(url, { headers: HEADERS, redirect: 'follow', signal: AbortSignal.timeout(TIMEOUT_MS) })
  } catch (err) {
    throw new Unreachable('请求失败：' + String((err && err.message) || err))
  }
  if (!res.ok) throw new Unreachable('HTTP ' + res.status + ' ' + url)
  return res.text()
}

// 就地的最小解析：本节每一处都对应 lib/ 里的同名实现（注释标明）；刻意不 import lib/，以便独立于实现。

/** Atom feed 的前 N 个 `<entry>` 的 `<id>`；对应 lib/poller.js 的 parseAtomEntries（JMA 的 `<id>` 就是详情电文地址）。 */
function atomEntryIds(xml, limit) {
  const blocks = String(xml).match(/<entry>[\s\S]*?<\/entry>/g) || []
  const out = []
  for (const b of blocks) {
    const m = /<id>([^<]*)<\/id>/.exec(b)
    if (m && m[1].trim()) out.push(m[1].trim())
    if (out.length >= limit) break
  }
  return out
}

/**
 * NOAA 事件列表里第一条 CAP 电文的地址。对应 lib/global-sources.js 的 parseNoaaEntries：
 * CAP 地址在 `<link rel="related" title="CapXML document" href>` 上，而 `<id>` 是 urn:uuid。
 * 属性顺序不保证，先按 title/rel 找那个 `<link>`，再取它的 href。
 */
function firstNoaaCapUrl(xml) {
  const blocks = String(xml).match(/<entry>[\s\S]*?<\/entry>/g) || []
  for (const b of blocks) {
    for (const link of (b.match(/<link[^>]*>/g) || [])) {
      if (/CapXML/i.test(link) || /rel=["']?related/i.test(link)) {
        const h = /href=["']?([^"'\s>]+)/i.exec(link)
        if (h) return h[1]
      }
    }
  }
  return ''
}

/**
 * 北京时间裸串 → 带 +08:00 的 ISO。对应 lib/nmc-source.js 的 nmcTimeToIso；
 * 契约层要的载荷里 `issued` 就是这个形态。
 */
function nmcTimeToIso(raw) {
  const m = /^(\d{4})[/-](\d{1,2})[/-](\d{1,2})[ T](\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(String(raw || '').trim())
  if (!m) return ''
  const p = (s) => String(s).padStart(2, '0')
  return m[1] + '-' + p(m[2]) + '-' + p(m[3]) + 'T' + p(m[4]) + ':' + m[5] + ':' + (m[6] || '00') + '+08:00'
}

/**
 * nmc.cn 的预警列表 → 本插件会转发的条目，对应 lib/nmc-source.js 的 NMC_KINDS / NMC_LEVELS / nmcCodesOf。
 * 判定规则：`pic` 文件名是 `p` + 4 位灾种码 + 3 位等级码，两位都在表里才保留。
 */
const NMC_KINDS = { 2: 'rainstorm', 21: 'geology' }
const NMC_LEVELS = { 1: 'red', 2: 'orange', 3: 'yellow', 4: 'blue' }
function nmcRows(json) {
  const list = json && json.data && json.data.page && json.data.page.list
  if (!Array.isArray(list)) throw new Error('响应缺少 data.page.list（结构变了？）')
  const rows = []
  for (const it of list) {
    if (!it || typeof it !== 'object') continue
    const m = /\/p(\d{4})(\d{3})\./i.exec(String(it.pic === undefined || it.pic === null ? '' : it.pic))
    if (!m) continue
    const kind = NMC_KINDS[Number(m[1])]
    const level = NMC_LEVELS[Number(m[2])]
    if (!kind || !level) continue
    rows.push({
      alertid: String(it.alertid || ''),
      title: String(it.title || ''),
      issued: nmcTimeToIso(it.issuetime),
      kind,
      level,
      detail: '',
    })
  }
  return rows
}

// 十个源的取数：每个源给出离线从哪个 fixture 取、在线从哪里取，两者都返回**解析器的入参数组**；
// 返回数组 = 逐条检查，空数组 = 上游这次没有可检查的数据（上层记 empty）。

/**
 * NWS 的 event 白名单，与 client/src/05h-overseas-parsers.js 的 NWS_EVENT_WHITELIST 同源，就地写一份。
 */
const NWS_EVENT_FILTER_LIST = [
  'Flood Warning', 'Flash Flood Warning', 'Coastal Flood Warning',
  'Flood Watch', 'Flood Advisory', 'Coastal Flood Watch', 'Coastal Flood Advisory', 'Coastal Flood Statement',
]
const NWS_EVENT_FILTER = NWS_EVENT_FILTER_LIST.join(',')

/**
 * NWS 白名单自检：用正则从 client/src/05h 源码文本里提取白名单，与本脚本就地写的那份比对。
 * 加洪水产品却忘了同步这里时在线 `?event=` 查询会悄悄变窄（empty 也算通过，漏查无症状）。
 */
function assertWhitelistInSync() {
  const src = readFileSync(path.join(ROOT, 'client', 'src', '05h-overseas-parsers.js'), 'utf8')
  const inSource = [...src.matchAll(/^\s*'([^']+)':\s*\{\s*kind:/gm)].map((m) => m[1]).sort()
  const mine = [...NWS_EVENT_FILTER_LIST].sort()
  if (inSource.length === 0) {
    console.log('  ✗ NWS 白名单自检：没能从 client/src/05h 解析出白名单（正则与实现脱节了？）')
    process.exitCode = 1
    return false
  }
  if (inSource.join('|') !== mine.join('|')) {
    console.log('  ✗ NWS 白名单不一致（在线 ?event= 查询会漏查）：')
    console.log('     client/src/05h =', inSource.join(' / '))
    console.log('     本脚本         =', mine.join(' / '))
    process.exitCode = 1
    return false
  }
  console.log('  NWS 白名单自检：' + mine.length + ' 类与 client/src/05h 一致')
  return true
}

const SOURCES = [
  {
    id: 'p2pquake',
    parser: 'parseEpspResult',
    offline: () => [{ label: 'samples/eew-ibaraki-m6.7-20260823.json', args: [readJson('eew-ibaraki-m6.7-20260823.json')] }],
    online: async () => {
      // 用 history REST 而非 WS：WS 是"有地震才推"，20 秒窗口里常常没有业务消息，那样验不到结构；
      // history 给的是同一份电文的副本（同结构），随时都有内容。参数形式是重复键
      // `codes=551&codes=556`（逗号形式实测返回 400）；三种 code 各拉一条，552 才会被覆盖到。
      const out = []
      for (const code of [551, 552, 556]) {
        const list = JSON.parse(await getText('https://api.p2pquake.net/v2/history?codes=' + code + '&limit=1'))
        const first = Array.isArray(list) ? list[0] : null
        // 该 code 没有历史（EEW 与海啸都稀疏）→ 跳过，上层按"没有可检查的数据"记 empty。
        if (first) out.push({ label: 'code ' + first.code, args: [first] })
      }
      return out
    },
  },
  {
    id: 'jma',
    parser: 'parseJmaResult',
    offline: () => [{ label: 'samples/jma-vpww55-heavyrain.xml', args: [readText('jma-vpww55-heavyrain.xml'), { id: 'contract-test' }] }],
    online: async () => {
      const feed = await getText('https://www.data.jma.go.jp/developer/xml/feed/extra.xml')
      // 取前十条而不是只取最新一条：extra.xml 里大量电文与本插件无关（天气预报、府県気象情報、注意報），
      // 只看第一条大概率得到 empty；十条的输出会写明最高到了 警戒レベル几。
      const ids = atomEntryIds(feed, 10)
      if (ids.length === 0) return []
      const out = []
      for (const id of ids) {
        out.push({ label: id, args: [await getText(id), { id }] })
      }
      return out
    },
  },
  {
    id: 'emsc',
    parser: 'parseEmscResult',
    offline: () => [{ label: 'samples/global/emsc-ws-sample.json', args: [readJson('global/emsc-ws-sample.json')] }],
    online: async () => {
      // EMSC 解析器吃的是 WS `standing_order` 的包裹，而 FDSN 返回裸的 GeoJSON FeatureCollection，
      // 所以包装成 `{ action, data }`；契约关心的字段（`properties.mag` / `time` / `flynn_region` /
      // `evtype` / `lat` / `lon`）在两者里是同一份。
      const json = JSON.parse(await getText('https://www.seismicportal.eu/fdsnws/event/1/query?format=json&limit=1'))
      const f = json && Array.isArray(json.features) ? json.features[0] : null
      if (!f) return []
      return [{ label: 'FDSN ' + String(f.id || 'features[0]'), args: [{ action: 'create', data: f }] }]
    },
  },
  {
    id: 'usgs',
    parser: 'parseUsgsResult',
    offline: () => [{ label: 'samples/global/usgs-all-hour.geojson → features[0]', args: [readJson('global/usgs-all-hour.geojson').features[0]] }],
    online: async () => {
      const json = JSON.parse(await getText('https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/2.5_day.geojson'))
      const f = json && Array.isArray(json.features) ? json.features[0] : null
      if (!f) return []
      return [{ label: String(f.id || 'features[0]'), args: [f] }]
    },
  },
  {
    id: 'noaa',
    parser: 'parseNoaaResult',
    offline: () => [{ label: 'samples/global/noaa-pheb-cap.xml', args: [readText('global/noaa-pheb-cap.xml'), { id: 'contract-test' }] }],
    online: async () => {
      const feed = await getText('https://www.tsunami.gov/events/xml/PHEBAtom.xml')
      const url = firstNoaaCapUrl(feed)
      // 事件列表为空是绝大多数时间的正常形态（没有海啸），返回空数组由上层记 empty。
      if (!url) return []
      return [{ label: url, args: [await getText(url), { id: 'contract-test' }] }]
    },
  },
  {
    id: 'cenc_eew',
    parser: 'parseCencEewResult',
    offline: () => [{ label: 'samples/cn/cenc-eew-last.json', args: [readJson('cn/cenc-eew-last.json')] }],
    online: async () => [{ label: 'api.wolfx.jp/cenc_eew.json', args: [JSON.parse(await getText('https://api.wolfx.jp/cenc_eew.json'))] }],
  },
  {
    id: 'cenc_eqlist',
    parser: 'parseCencEqlistItemResult',
    offline: () => [{ label: 'samples/cn/cenc-eqlist-last.json → No1', args: [readJson('cn/cenc-eqlist-last.json').No1] }],
    online: async () => {
      const json = JSON.parse(await getText('https://api.wolfx.jp/cenc_eqlist.json'))
      // 线上接的是逐条 entry（Host 已把整表拆开），契约也在逐条这一层验。
      if (!json || !json.No1) return []
      return [{ label: 'No1', args: [json.No1] }]
    },
  },
  {
    id: 'nmc_alarm',
    parser: 'parseNmcAlarmResult',
    offline: () => nmcRows(readJson('nmc/alarm-list.json')).map((r) => ({ label: r.alertid, args: [r] })),
    online: async () => {
      const json = JSON.parse(await getText('https://www.nmc.cn/rest/findAlarm?pageNo=1&pageSize=500'))
      return nmcRows(json).map((r) => ({ label: r.alertid, args: [r] }))
    },
  },
  // 海外气象源：NWS 与 ECCC 都是 Client 直连的 REST（CORS 允许），运行时按关注点查（NWS `?point=`、
  // ECCC `bbox=`）；这里在线取数用更宽的查询，否则当前没有预警时会长期显示 empty。
  {
    id: 'nws_alerts',
    parser: 'parseNwsAlertResult',
    offline: () => readJson('nws/nws-flood-alerts.geojson').features
      .map((f) => ({ label: String(f.properties && f.properties.event), args: [f] })),
    online: async () => {
      const json = JSON.parse(await getText(
        'https://api.weather.gov/alerts/active?event=' + encodeURIComponent(NWS_EVENT_FILTER)))
      if (!json || !Array.isArray(json.features)) throw new Error('缺少 features 数组（结构变了）')
      return json.features.map((f) => ({ label: String(f.properties && f.properties.event), args: [f] }))
    },
  },
  {
    id: 'eccc_alerts',
    parser: 'parseEcccAlertResult',
    offline: () => {
      // --offline 的规则是"样本必须解析出 Alert"，所以只喂白名单内的那一条（frost advisory 与
      // wind warning 本来就该判 empty，那属于回归测试的职责）；不绑定具体灾种，按关键词挑。
      const feats = readJson('eccc/eccc-alerts.geojson').features || []
      const f = feats.find((x) => {
        const p = (x && x.properties) || {}
        if (p.alert_type !== 'warning') return false
        const name = String(p.alert_name_en || '')
        return /rain|flood|surge|hydrolog|water/i.test(name) && !/frost|fog|freez|wind|heat|snow|ice/i.test(name)
      })
      return f ? [{ label: 'samples/eccc/ → ' + String(f.properties.alert_name_en), args: [f] }] : []
    },
    online: async () => {
      // ECCC 的 API 没有灾种过滤参数（白名单在 Client 侧做），所以在线拉全国范围再看能认多少；
      // 绝大多数是 frost advisory（判 empty 正常），只有风暴潮 / 降雨类出现时才算强验证。
      const json = JSON.parse(await getText(
        'https://api.weather.gc.ca/collections/weather-alerts/items?f=json&limit=200&bbox=-141,41,-52,84'))
      if (!json || !Array.isArray(json.features)) throw new Error('缺少 features 数组（结构变了）')
      return json.features.map((f) => ({ label: String(f.properties && f.properties.alert_code), args: [f] }))
    },
  },
]

// 判定
/**
 * 跑一个源，返回 `{ id, parser, status, detail, cases: [{ label, kind, detail }], required }`。
 * status ∈ 'ok' | 'empty' | 'drift' | 'unreachable' | 'fixture'
 * （离线模式下的取数抛错一律记 'fixture'——不联网时它只可能是 fixture 的问题）
 */
async function checkSource(src, contracts, client) {
  const required = (contracts[src.id] && contracts[src.id].required) || []
  const base = { id: src.id, parser: src.parser, required }
  let cases
  try {
    cases = OFFLINE ? src.offline() : await src.online()
  } catch (err) {
    if (err instanceof Unreachable) {
      return Object.assign(base, { status: 'unreachable', detail: err.message, cases: [] })
    }
    if (OFFLINE) {
      return Object.assign(base, { status: 'fixture', detail: String((err && err.message) || err), cases: [] })
    }
    // 在线时取数抛错但不是网络问题：那是上游结构变了（例如 nmc 的 data.page.list 不见了）。
    return Object.assign(base, { status: 'drift', detail: '取数失败：' + String((err && err.message) || err), cases: [] })
  }
  if (!Array.isArray(cases) || cases.length === 0) {
    return Object.assign(base, {
      status: 'empty',
      detail: src.id === 'noaa' ? '事件列表为空（绝大多数时间的正常形态：没有海啸）' : '上游这一次没有可检查的数据',
      cases: [],
    })
  }
  const results = []
  let sawOk = false
  let sawEmpty = false
  let drift = null
  for (const c of cases) {
    let res
    try {
      res = client.__test[src.parser].apply(null, c.args)
    } catch (err) {
      res = { ok: false, kind: 'schema', detail: '解析器抛错：' + String((err && err.message) || err) }
    }
    if (!res || typeof res !== 'object') {
      res = { ok: false, kind: 'schema', detail: '解析器没有返回结果对象（返回形态变了）' }
    }
    if (res.ok) {
      sawOk = true
      // 顺带记下警戒レベル，只有 > 0 才记：气象源的 `level` 恒为 0，那不是一个"级别"。
      // 有了它，输出里才能写"这些条目里最高到了 L几"。
      const lv = (res.alert && typeof res.alert.level === 'number' && res.alert.level > 0) ? res.alert.level : null
      results.push({
        label: c.label, kind: 'ok', level: lv,
        detail: res.alert && res.alert.headline ? res.alert.headline : '',
      })
    } else if (res.kind === 'empty') {
      sawEmpty = true
      results.push({ label: c.label, kind: 'empty', detail: String(res.detail || '') })
    } else {
      if (!drift) drift = { label: c.label, kind: String(res.kind || 'schema'), detail: String(res.detail || '') }
      results.push({ label: c.label, kind: String(res.kind || 'schema'), detail: String(res.detail || '') })
    }
  }
  let status = 'ok'
  let detail = ''
  if (drift) {
    status = 'drift'
    detail = drift.kind + '：' + drift.detail
  } else if (!sawOk) {
    status = 'empty'
    detail = sawEmpty ? '全部条目都判为 empty（源正常但当前没有与本插件相关的数据）' : ''
  }
  return Object.assign(base, { status, detail, cases: results })
}

// 输出
const STATUS_TAG = {
  ok: 'ok',
  empty: 'empty',
  drift: 'DRIFT',
  unreachable: 'skip',
  fixture: 'FIXTURE',
}

/** 该状态在本模式下算不算失败，规则见文件头"退出码"。 */
function isFailure(status) {
  if (OFFLINE) return status !== 'ok' // 样本是刻意挑的有效数据：empty / drift / fixture 都是脚本自身的问题
  return status === 'drift' // 在线：只有"上游改版"值得让人处理
}

function printHuman(report) {
  console.log('== dsh-quake-alert 契约检查（' + (OFFLINE ? '--offline：只用 samples/ 快照，不联网' : '在线：真实拉取每个源') + '）==')
  console.log('   client bundle：' + path.relative(ROOT, CLIENT_PATH) + '（已提交的构建产物）')
  console.log('')
  for (const s of report.sources) {
    const tag = '[' + (STATUS_TAG[s.status] || s.status) + ']'
    const head = tag.padEnd(10) + s.id.padEnd(13) + s.parser.padEnd(28)
    const count = s.cases.length ? s.cases.length + ' 条' : ''
    // 摘要优先取**第一条解析成功**的那条，否则整行会显示成"与本插件无关的电文"却挂着 [ok] 标签。
    const firstOk = s.cases.filter((c) => c.kind === 'ok')[0]
    const summary = s.detail || (firstOk ? firstOk.detail : (s.cases.length ? s.cases[0].detail : ''))
    // 多条的源再补两个数：解析出几条、最高到了 警戒レベル几。
    const bits = []
    if (s.cases.length > 1) bits.push(s.cases.filter((c) => c.kind === 'ok').length + '/' + s.cases.length + ' 条解析出 Alert')
    const levels = s.cases.filter((c) => typeof c.level === 'number').map((c) => c.level)
    if (levels.length) bits.push('最高 警戒レベル' + Math.max.apply(null, levels))
    console.log(head + summary + (count ? '（' + count + '）' : '') + (bits.length ? '　— ' + bits.join('；') : ''))
    // 逐条明细只在"不是全通过"时打印，避免把有用信息埋掉。
    if (s.status !== 'ok' && s.status !== 'unreachable' && s.cases.length) {
      for (const c of s.cases) {
        if (c.kind === 'ok') continue
        console.log('           └ ' + c.label + ' → ' + c.kind + '：' + c.detail)
      }
    }
    // 契约漂移时把该源的 required 原样打出来供人对照（它是自然语言，机器校验不了）。
    if (s.status === 'drift' && s.required.length) {
      console.log('           └ SOURCE_CONTRACTS.' + s.id + '.required（契约原文，供对照）：')
      for (const r of s.required) console.log('             · ' + r)
    }
  }
  const fail = report.sources.filter((s) => isFailure(s.status)).length
  console.log('')
  console.log('结果：' + report.sources.length + ' 个源，' + (report.sources.length - fail) + ' 个通过，' + fail + ' 个失败' +
    (OFFLINE ? '（离线模式下样本必须全部解析出 Alert——这是脚本的自检）' : '（在线模式下只有契约漂移算失败）'))
  if (report.coverageWarning) console.log('⚠ ' + report.coverageWarning)
}

// main
async function main() {
  let client
  try {
    client = loadClient()
  } catch (err) {
    console.error('无法加载 client bundle：' + String((err && err.message) || err))
    process.exit(1)
  }
  const contracts = client.__test.SOURCE_CONTRACTS
  if (!contracts || typeof contracts !== 'object') {
    console.error('__test 里没有 SOURCE_CONTRACTS——契约定义没导出，这个脚本无从下手')
    process.exit(1)
  }

  // 覆盖性自检：契约里每一个源都必须有对应的取数方式，漏了就是"新增源不进 CI"。
  const uncovered = Object.keys(contracts).filter((id) => !SOURCES.some((s) => s.id === id))
  const extra = SOURCES.filter((s) => !Object.prototype.hasOwnProperty.call(contracts, s.id)).map((s) => s.id)

  // 手抄名单自检：第三份 NWS 白名单与 client/src/05h 必须一致，否则在线查询悄悄变窄。
  assertWhitelistInSync()

  const sources = []
  for (const src of SOURCES) {
    sources.push(await checkSource(src, contracts, client))
  }

  const report = {
    mode: OFFLINE ? 'offline' : 'online',
    checkedAt: new Date().toISOString(),
    clientBundle: path.relative(ROOT, CLIENT_PATH),
    sources,
    failures: sources.filter((s) => isFailure(s.status)).map((s) => s.id),
    coverageWarning: uncovered.length
      ? 'SOURCE_CONTRACTS 里有 ' + uncovered.length + ' 个源没有取数方式（新增源没进 CI）：' + uncovered.join(', ')
      : (extra.length ? 'SOURCES 里有契约不存在的源 id：' + extra.join(', ') : ''),
  }

  if (AS_JSON) console.log(JSON.stringify(report, null, 2))
  else printHuman(report)

  // 覆盖性缺陷也算失败：它意味着有源永远不会被检查。
  const bad = report.failures.length > 0 || uncovered.length > 0 || extra.length > 0
  process.exit(bad ? 1 : 0)
}

await main()
