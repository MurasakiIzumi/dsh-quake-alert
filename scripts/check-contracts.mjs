#!/usr/bin/env node
// dsh-quake-alert · CI 契约测试（0.5.3 / DESIGN 11.9 E）
//
// 用法：
//   node scripts/check-contracts.mjs              # 真实拉取每个源（需要网络）
//   node scripts/check-contracts.mjs --offline    # 只用 samples/ 的快照，不联网
//   node scripts/check-contracts.mjs --json       # 结果打成 JSON（给 CI / 工具读）
//
// ---------------------------------------------------------------------------
// 这个脚本在验什么、为什么是这个形态
//
// 契约（`SOURCE_CONTRACTS[*].required`）是**自然语言描述**——"551：id string、issue.time
// string、earthquake.maxScale number"这种句子没法机器校验。所以契约测试的正确形态不是
// "读契约、比对字符串"，而是**端到端**：把**真实的上游数据**原样交给解析器，看它还认不认。
// 上游改字段名 / 改类型 / 改单位时，解析器会当场返回 `schema` / `value`——那是契约漂移，
// 也正是这个脚本存在的全部理由。
//
// 它是**唯一能在上游改版当天发现问题**的入口：本插件其余全部测试都基于 `samples/` 的快照，
// 而上游改版时快照不会变（DESIGN 11.9 E）。
//
// ---------------------------------------------------------------------------
// 判定与退出码（三条规则，都是有意的取舍）
//
//   · `ok`      → 通过。
//   · `empty`   → **也算通过**。"源正常，但当前没有与本插件相关的数据"是合法形态
//               （P2PQuake 会推火山消息、JMA 大量电文是天气预报、NOAA 通常没有海啸、
//               EMSC 会推非地震事件），把它判成失败会让 CI 长期红着、然后被人忽略。
//   · `schema` / `value` → **契约漂移**，退出码 1，并打印解析器的 detail 与该源契约里的
//               `required` 原文，供人对照"是哪个字段变了"。
//
//   · 网络不可达 / 超时 / 上游返回非预期状态码 → **不算失败**（记 `unreachable`，不影响退出码）。
//     理由：CI 的网络会抖动，而"抖动"不是任何人能处理的事；只有"上游改版"才值得让人打开
//     这个日志。把两者混在一起，结果是网络一抖就红、然后所有人学会无视这个 job。
//
//   · `--offline` 模式下**只接受 `ok`**：样本是刻意挑的"有效数据"，一个都解析不出 Alert
//     说明脚本自身坏了（取数函数写错、fixture 名写错、解析入口写错），不是上游的问题。
//     这是脚本的自检——DESIGN 11.9 F 明确要求"脚本本身不能只会说通过"。
//
// ---------------------------------------------------------------------------
// 两个刻意的实现选择
//
// 1. **不 import `lib/` 的任何东西，全部自包含。** 契约测试要**独立**于实现：如果复用
//    Host 的取数 / 转换代码，实现与契约一起漂移时两边会同时"通过"。所以这里的 Atom 解析、
//    图标编码映射、时间转换都是就地写的最小实现，并在注释里标明它对应 lib/ 里的哪一处
//    ——两边不一致时，测试会以"没有可检查的条目"或"构造出的载荷解析失败"的形式暴露出来。
//
// 2. **零依赖、全部串行。** 只用 Node 内置（vm / fs / path / fetch），
//    所以 CI 上不需要 `pnpm install`；串行是因为这是对五个上游的礼貌问题（DESIGN 4.2）。
//
// ---------------------------------------------------------------------------
// 一个**已知边界**（写在这里，避免下一轮当成新发现）
//
// `empty`（"源正常但当前没有与本插件相关的数据"）与"结构变了、解析器认不出来"在解析器层面
// **可能同形**：JMA 的电文若把 `<Kind><Name>` 的语义换掉，解析器会判"无警戒レベル" → empty，
// 而在线模式下 empty 是**通过**的——这类漂移会被绿灯盖住。
// 断开它需要在契约里对关键字段做显式断言（那超出 DESIGN 11.9 E 的范围），所以脚本能做的只有
// **把每条的 detail 原样打印出来**：人扫一眼就能分清"这 10 条真的是天气预报 / 注意报"还是
// "全都认不出来了"。这是有意的取舍，不是遗漏。

import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadClient, CLIENT_PATH } from './lib/load-client.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const OFFLINE = process.argv.includes('--offline')
const AS_JSON = process.argv.includes('--json')

/** 单源超时。20 秒与 Host 侧外部请求的超时一致（DESIGN 4.2 的通用约束）。 */
const TIMEOUT_MS = 20000

/**
 * 请求头。带上 UA 与 Referer：nmc.cn 会拒没有来源页的请求，而"被拒"会被归到 unreachable
 * （不算失败）——那会让这个源长期"看不见"，所以这里按浏览器访问的同形去取。
 */
const HEADERS = {
  'user-agent': 'Mozilla/5.0 (compatible; dsh-quake-alert-contract-check)',
  referer: 'https://www.nmc.cn/publish/alarm.html',
}

/** 网络层的失败：超时 / 连不上 / 非 2xx。**只有它**会被归成 `unreachable`（不算失败）。 */
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

// ---------------------------------------------------------------- 就地的最小解析
// 本节全部对应 lib/ 里的某一处（注释标明）。**故意不 import**：见文件头第 1 条。

/**
 * Atom feed 的前 N 个 `<entry>` 的 `<id>`。
 * 对应 lib/poller.js 的 parseAtomEntries（JMA 的 `<id>` 本身就是详情电文地址）。
 */
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
 * NOAA 事件列表里第一条 CAP 电文的地址。
 * 对应 lib/global-sources.js 的 parseNoaaEntries：CAP 地址在 `<link rel="related"
 * title="CapXML document" href>` 上，而 `<id>` 是 urn:uuid（**不是**详情地址）。
 * 属性顺序不保证，所以先按 title/rel 找那个 `<link>`，再取它的 href。
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
 * 北京时间裸串 → 带 +08:00 的 ISO。对应 lib/nmc-source.js 的 nmcTimeToIso。
 * 契约层要的载荷里 `issued` 是这个形态（Host 转换后就长这样）。
 */
function nmcTimeToIso(raw) {
  const m = /^(\d{4})[/-](\d{1,2})[/-](\d{1,2})[ T](\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(String(raw || '').trim())
  if (!m) return ''
  const p = (s) => String(s).padStart(2, '0')
  return m[1] + '-' + p(m[2]) + '-' + p(m[3]) + 'T' + p(m[4]) + ':' + m[5] + ':' + (m[6] || '00') + '+08:00'
}

/**
 * nmc.cn 的预警列表 → 本插件会转发的条目。
 *
 * 与 lib/nmc-source.js 的对应关系（就地写一份的理由见文件头）：
 *   · `NMC_KINDS = { 2: 'rainstorm', 21: 'geology' }` ↔ 那里的 `NMC_KINDS`
 *   · `NMC_LEVELS` 的 1..4 ↔ 那里的 `NMC_LEVELS`（红 / 橙 / 黄 / 蓝）
 *   · `pic` 的文件名格式 `p` + 4 位灾种码 + 3 位等级码 ↔ 那里的 `nmcCodesOf`
 * 两边不一致的后果**被离线模式守护**：`samples/nmc/alarm-list.json` 里是 24 条能被过滤出来的
 * 条目，所以无论哪一边的编码映射改了，离线跑都会从 24 条变成 0 条 → empty → 而离线**不允许**
 * empty → 退出码 1。在线模式下它只表现为 empty（合法形态，会通过），所以真正拦住这个重复的
 * 是离线那一半——这也是"就地重复一份"可以接受的原因。
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

// ---------------------------------------------------------------- 八个源的取数
// 每个源给出两件事：离线从哪个 fixture 取、在线从哪里取；两者都返回**解析器的入参数组**。
// 返回数组 = 逐条检查（nmc 的列表天然是多条）；返回空数组 = 上游这一次没有可检查的数据。

const SOURCES = [
  {
    id: 'p2pquake',
    parser: 'parseEpspResult',
    offline: () => [{ label: 'samples/eew-ibaraki-m6.7-20260823.json', args: [readJson('eew-ibaraki-m6.7-20260823.json')] }],
    online: async () => {
      // 用 **history REST** 而不是 WS（0.5.3 调整，理由是实测）：
      //   · WS 是"有地震才推"，而日本数小时没有有感地震是常态——20 秒窗口里收到业务消息
      //     属于例外。实测两次运行：一次恰好收到 `code 555`（火山），一次直接超时。那样这个源
      //     的在线检查**基本永远验不到结构**，而"验到结构"恰恰是这个脚本存在的理由。
      //   · history 给的是同一份电文的副本（同结构），随时都有内容，且不占长连接。
      // 参数形式是**重复键** `codes=551&codes=556`：逗号形式（`codes=551,556`）实测返回
      // 400 `extra keys found`——整串被当成一个未知键。
      const list = JSON.parse(await getText('https://api.p2pquake.net/v2/history?codes=551&codes=556&limit=1'))
      const first = Array.isArray(list) ? list[0] : null
      // 最近一条 551/556 都没有（EEW 与震度速报都稀疏）→ 上层记 empty，这是合法形态
      if (!first) return []
      return [{ label: 'code ' + first.code, args: [first] }]
    },
  },
  {
    id: 'jma',
    parser: 'parseJmaResult',
    offline: () => [{ label: 'samples/jma-vpww55-heavyrain.xml', args: [readText('jma-vpww55-heavyrain.xml'), { id: 'contract-test' }] }],
    online: async () => {
      const feed = await getText('https://www.data.jma.go.jp/developer/xml/feed/extra.xml')
      // 取**前十条**而不是只取最新一条：extra.xml 里大量电文与本插件无关（天气预报、
      // 府県気象情報、注意報），只看第一条大概率得到 empty —— 那等于什么都没验到。
      // 取 10 条之后，输出里会写明"这 10 条里最高到了 警戒レベル几"，于是"无灾害时段确实
      // 没有警报级电文"这件事是**可见的**，而不是靠人去猜（0.5.3 按 review 意见从 3 提到 10）。
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
      // 同理改用 REST（WS 的稀疏性与上面 P2PQuake 完全一样：全球 M4+ 平均约 30 分钟一条）。
      //
      // **为什么要包装成 `{ action, data }`**：EMSC 的解析器吃的是 WS `standing_order` 的包裹，
      // 而 FDSN 返回的是**裸的 GeoJSON FeatureCollection**。包装成同形之后再喂进去，验的仍然
      // 是真实数据：契约关心的那几个字段（`properties.mag` / `time` / `flynn_region` /
      // `evtype` / `lat` / `lon`）在 FDSN 与 WS 里**是同一份**——同一个机构的同一个事件模型
      //（实测 FDSN 的 properties 带 `evtype:"ke"`、`flynn_region`、`lat`/`lon`、`mag`、`time`）。
      // 反过来说：若将来两者分叉，包装层不会掩盖差异——差异会以 schema 失败的形式暴露出来。
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
      // 事件列表为空是**绝大多数时间的正常形态**（没有海啸），返回空数组由上层记 empty。
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
      // 线上接的是**逐条** entry（Host 已把整表拆开），所以契约也在逐条这一层验。
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
]

// ---------------------------------------------------------------- 判定
/**
 * 跑一个源，返回
 * `{ id, parser, status, detail, cases: [{ label, kind, detail }], required }`。
 *
 * status ∈ 'ok' | 'empty' | 'drift' | 'unreachable' | 'fixture'
 *   （离线模式下的取数抛错一律记 'fixture'——不联网时它只可能是 fixture 的问题）
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
    // 在线时取数抛错但**不是**网络问题：那是上游结构变了（例如 nmc 的 data.page.list 不见了）。
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
      // 顺带记下**警戒レベル**（只有 > 0 才记：气象源的 `level` 恒为 0，那不是一个"级别"）。
      // 有了它，输出里才能写"这 10 条里最高到了 L几"——JMA 的 feed 里绝大多数电文与本插件
      // 无关，光说一句 empty 会让人以为脚本没干活（0.5.3 按 review 意见加的）。
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

// ---------------------------------------------------------------- 输出
const STATUS_TAG = {
  ok: 'ok',
  empty: 'empty',
  drift: 'DRIFT',
  unreachable: 'skip',
  fixture: 'FIXTURE',
}

/** 该状态在本模式下算不算失败。两条规则见文件头的"判定与退出码"。 */
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
    // 通过时也带一句"解析出了什么"：一屏光秃秃的 [ok] 等于什么都没说，而"它真的读到数据了吗"
    // 恰恰是这个脚本最该回答的问题。
    const firstOk = s.cases.filter((c) => c.kind === 'ok')[0]
    // 摘要优先取**第一条解析成功**的那条：多条的源（JMA 的 10 条里混着天气预报与注意报）
    // 若照搬第一条，整行会显示成"与本插件无关的电文"却挂着 [ok] 标签——自相矛盾。
    const summary = s.detail || (firstOk ? firstOk.detail : (s.cases.length ? s.cases[0].detail : ''))
    // 多条的源再补两个数：解析出几条、最高到了 警戒レベル几。
    // 后者的用处是把"这一轮确实没有警报级电文"变成**可见的事实**（JMA 的常见形态），
    // 而不是让人从一堆 empty 里去猜是"没有"还是"认不出来"。
    const bits = []
    if (s.cases.length > 1) bits.push(s.cases.filter((c) => c.kind === 'ok').length + '/' + s.cases.length + ' 条解析出 Alert')
    const levels = s.cases.filter((c) => typeof c.level === 'number').map((c) => c.level)
    if (levels.length) bits.push('最高 警戒レベル' + Math.max.apply(null, levels))
    console.log(head + summary + (count ? '（' + count + '）' : '') + (bits.length ? '　— ' + bits.join('；') : ''))
    // 逐条明细只在"不是全通过"时打印：全通过时 8 个源 × 24 条会把有用的信息埋掉
    if (s.status !== 'ok' && s.status !== 'unreachable' && s.cases.length) {
      for (const c of s.cases) {
        if (c.kind === 'ok') continue
        console.log('           └ ' + c.label + ' → ' + c.kind + '：' + c.detail)
      }
    }
    // 契约漂移时把该源的 required **原样**打出来供人对照（它是自然语言，机器校验不了）
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

// ---------------------------------------------------------------- main
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

  // 覆盖性自检：契约里每一个源都必须有对应的取数方式。漏了就是"新增源不进 CI"，
  // 而那种漏法不会有任何症状——直到那个源悄悄坏掉。
  const uncovered = Object.keys(contracts).filter((id) => !SOURCES.some((s) => s.id === id))
  const extra = SOURCES.filter((s) => !Object.prototype.hasOwnProperty.call(contracts, s.id)).map((s) => s.id)

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

  // 覆盖性缺陷也算失败：它意味着有源永远不会被检查
  const bad = report.failures.length > 0 || uncovered.length > 0 || extra.length > 0
  process.exit(bad ? 1 : 0)
}

await main()
