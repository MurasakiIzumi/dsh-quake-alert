// Host half · Wolfx 大陆源（0.5.0）
//
// 职责（与 poller.js / global-sources.js 同一条界线）：**拉取 / 去重 / 缓存 / 游标**。
// 不懂业务——不判断灾种、不算震级阈值、不匹配关注地区，那些仍在 Client 侧（05e-cn-parsers.js）。
//
// 为什么大陆源必须走 Host 而不是像 P2PQuake 那样 Client 直连（DESIGN 5.3）：
//   Wolfx 限制约 **5–7 条连接 / IP（全局，不分端点）**，而每个浏览器标签页都会独立建连。
//   照搬 Client 直连的话，单标签页就要占 2 条（cenc_eew + cenc_eqlist），开第二个标签页即触顶，
//   且**被拒的连接不会报错**——只是静默连不上。Host 是每台机器唯一的进程，放这里就与标签页数量
//   彻底脱钩（2 条离上限很远）。
//
// 与 poller 的三处结构性差异（都是实测决定的，见 DESIGN 4.3 / 8.3）：
//   ① 传输是 **WebSocket 常连**而不是定时轮询。理由不是"省请求"而是**延迟**：EEW 的价值在秒级，
//      15 秒一次的轮询等于把预警变成事后通知。
//   ② 连上后要发一条**纯文本**指令 `query_<id>` 取回最后一条数据。实测发 JSON 不会有任何响应。
//      这是 Wolfx 自带的"回放"能力，也是断线期间唯一能补消息的手段（WS 没有 Last-Event-ID 之外
//      的服务端补拉能力，P2PQuake 那条链路的同类缺口见 DESIGN 11.6 第 2 条）。
//   ③ 两个源的性格完全不同：`cenc_eew` 稀疏（实测门槛约 M4.0，数天一次）、`cenc_eqlist` 是一张
//      50 条、覆盖约 20 天的整表。所以整表要**逐条**展开成 entry（按 EventID 去重），
//      而不是把整表当成一条 entry 反复重放。
//
// 事件年龄上限（`maxEventAgeMs`）是**安全相关**的，不是优化：
//   `cenc_eew` 在连上时会回放**最后一条**预警——实测它可能已经过去数天。把一条几天前的 EEW
//   当成实时警报播出去是纯粹的误报，比漏报更伤信任。所以按**发震时刻**设年龄闸门：
//   预警 10 分钟、速报 6 小时（速报本身就是分钟级确认与补报，窗口宽一些才有意义）。
//   注意这与 poller 的"进程启动时刻"判据根本不同：那两个源是滚动 feed，发布时间就是灾害时间；
//   而这两个源会**主动回放旧数据**，"进程启动之后"在这里不是有意义的边界。
//
// 可测性：socket 工厂、时钟、定时器都可注入，测试不需要联网、不需要等心跳。

import { createFetchText } from './poller.js'

export const CENC_EEW_ID = 'cenc_eew'
export const CENC_EQLIST_ID = 'cenc_eqlist'

/**
 * WebSocket 端点（免 key）。
 *
 * REST 快照 `https://api.wolfx.jp/<id>.json` 是同结构的降级通道——**0.9.4 起它才真的存在**：
 * 这条注释与 lib/index.js 的说明此前描述的是一条从未实现的路径（REST 常量只被测试与排障脚本
 * 引用），而 wss:// 被中间设备掐断时，两个大陆源会静默停摆、状态还是绿的。现在 REST 兜底真的
 * 在跑（见 createWolfxSource 的 pollRest）。
 */
export const WOLFX_WS_BASE = 'wss://ws-api.wolfx.jp/'
export const WOLFX_REST_BASE = 'https://api.wolfx.jp/'

/**
 * REST 兜底轮询周期（0.9.4）：只在 **WS 未连接**时跑，且与重连退避共用一个 tick，
 * 不额外拉一条定时器链。60 秒的取法：速报整表覆盖约 20 天、真正变化是分钟级，
 * 而 EEW 快照本来就常是旧的（有 10 分钟年龄闸门兜底），所以它探的是"中继还活着吗"，
 * 不需要比 WS 的心跳更密。WS 一旦连上就不再请求 REST——那是重复流量。
 */
export const DEFAULT_REST_POLL_MS = 60 * 1000

/**
 * 心跳实测精确 60.0 秒（两次独立观测），200 秒内无服务端强断。超过 120 秒没动静即判连接已死：
 * 浏览器 / Node 的 WebSocket 在半开连接上**不会**给出任何事件，用户看到的是"一切正常"。
 */
export const DEFAULT_HEARTBEAT_TIMEOUT_MS = 120 * 1000

/** 心跳检查的周期：心跳 60 秒一次，30 秒查一次即可（最坏多花 30 秒发现半开连接）。 */
export const DEFAULT_HEARTBEAT_CHECK_MS = 30 * 1000

/** 建连看门狗：15 秒还没 open 就放弃重连（照 P2PQuake 那条链路的取值）。 */
export const DEFAULT_CONNECT_TIMEOUT_MS = 15 * 1000

/** 重连退避：实测出现过并发建连失败，不能死循环猛敲。 */
export const DEFAULT_RECONNECT_BASE_MS = 1000
export const DEFAULT_RECONNECT_MAX_MS = 60 * 1000

/** 环缓冲容量：够 Client 断连一段时间后补齐，又不至于把内存吃满。 */
export const DEFAULT_MAX_ENTRIES = 120

/** dedupe 键的记忆时长（与 poller 一致）。 */
export const DEFAULT_SEEN_TTL_MS = 24 * 60 * 60 * 1000

/**
 * `cenc_eqlist` 的 dedupe 记忆时长（0.9.4 / P3-36）：**必须长于整表的覆盖窗口**。
 *
 * 速报整表覆盖约 20 天，而此前的 TTL 是通用的 24 小时：表里那些 20 天内、24 小时外的老条目
 * 每来一帧都会被重新当成"新候选"，然后被年龄闸门挡下并计入 `ageSkipped`——于是那个计数
 * **在没有新事件时也持续增长**，看起来像"一直在丢数据"（与刚修掉的 idleSkips 是同一形态：
 * 一个不表达任何事实、只随时间线性增长的读数）。取 30 天：略大于表窗口，老条目在 TTL 内
 * 会被正确计入 `dupSkipped`（"见过，跳过"），而不是"被年龄闸门丢掉"。
 */
export const EQLIST_SEEN_TTL_MS = 30 * 24 * 60 * 60 * 1000

/** 无人使用时的重探间隔（与 poller 的 IDLE_RETRY_MS 同义）。 */
export const IDLE_RETRY_MS = 5 * 1000

/**
 * 速报的"中继是否还在转发"阈值（48 小时）。速报每天都有数据，所以**这是本插件唯一真正有意义
 * 的新鲜度判据**，而且它探的是中继而不是灾害：连接正常但上游停更（`fj_eew` 实测停更 4 个月）
 * 那种形态，靠连接检测完全发现不了。
 */
export const DEFAULT_EQLIST_STALE_MS = 48 * 60 * 60 * 1000

/**
 * 事件年龄闸门：超过它的事件**记为已见但不进缓冲**（不打扰用户）。
 * 取值理由见文件头——预警 10 分钟（几十分钟前的 EEW 没有行动价值，播出去是误报）、
 * 速报 6 小时（分钟级确认与补报，窗口宽一些才有意义）。
 */
export const MAX_EVENT_AGE_MS = {
  [CENC_EEW_ID]: 10 * 60 * 1000,
  [CENC_EQLIST_ID]: 6 * 60 * 60 * 1000,
}

/** 每个源的默认参数。 */
export const WOLFX_SOURCES = {
  [CENC_EEW_ID]: {
    label: 'CENC EEW',
    /**
     * 回放指令。**不是** `query_` + 源 id 拼出来的：实测的指令是 `query_cenceew`
     * （把 id 里的下划线去掉），`query_cenc_eew` 不会有任何响应。拼字符串看着"自然"，
     * 错起来却完全静默——连上就再没有数据，而连接状态是绿的。所以按源显式写死。
     */
    queryCommand: 'query_cenceew',
    maxEventAgeMs: MAX_EVENT_AGE_MS[CENC_EEW_ID],
    // 预警稀疏（数天一次）→ 不给新鲜度阈值：判断"是不是停更"由速报负责
    staleAfterMs: 0,
  },
  [CENC_EQLIST_ID]: {
    label: 'CENC eqlist',
    queryCommand: 'query_cenceqlist',
    maxEventAgeMs: MAX_EVENT_AGE_MS[CENC_EQLIST_ID],
    staleAfterMs: DEFAULT_EQLIST_STALE_MS,
  },
}

/**
 * 大陆源的裸北京时间 → 带 +08:00 偏移的 ISO 8601。
 *
 * 为什么在 Host 侧**再写一份**（Client 侧已有 cnTimeToIso）：两侧是不同的 bundle
 * （lib/ 与 client/ 没有共享模块，client 侧由 rollup 打成单文件），为这一行转换引入共享构建
 * 步骤不值得。两处的正则与偏移必须一起改——client 侧的那份在 `client/src/01-constants.js`。
 * 认不出时原样返回（**绝不丢信息**）。
 */
export function cnTimeToIso(raw) {
  const s = String(raw === undefined || raw === null ? '' : raw).trim()
  if (!s) return ''
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?$/.exec(s)
  if (!m) return s
  const ms = m[7] ? m[7].padEnd(3, '0').slice(0, 3) : ''
  return m[1] + '-' + m[2] + '-' + m[3] + 'T' + m[4] + ':' + m[5] + ':' + m[6] +
    (ms ? '.' + ms : '') + '+08:00'
}

/** 数值或数字字符串 → 有限数值；空 / 垃圾 → null（速报整表字段**全是字符串**）。 */
function numOrNull(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null
  const s = String(v === undefined || v === null ? '' : v).trim()
  if (!s) return null
  const n = Number(s)
  return Number.isFinite(n) ? n : null
}

/**
 * `cenc_eew` 一帧（WS 推送包，含 `type`）→ entry；结构不对返回 null。
 *
 * 去重键取 `ID@ReportNum`（**不是** ID）：实测同一场地震会多次发布（样本里是 ReportNum=2），
 * 修订版必须能进缓冲——按 ID 去重会把震级上修永远挡在门外，那是漏报。
 * 与 USGS 的 `id@updated` 是同一条理由。
 */
export function cencEewEntry(raw) {
  if (!raw || typeof raw !== 'object') return null
  const id = String(raw.ID === undefined || raw.ID === null ? '' : raw.ID).trim()
  if (!id) return null
  const lat = numOrNull(raw.Latitude)
  const lon = numOrNull(raw.Longitude)
  if (lat === null || lon === null) return null
  const originIso = cnTimeToIso(raw.OriginTime)
  const eventMs = Date.parse(originIso)
  const mag = numOrNull(raw.Magnitude)
  const place = String(raw.HypoCenter === undefined || raw.HypoCenter === null ? '' : raw.HypoCenter).trim()
  const reportNum = numOrNull(raw.ReportNum)
  return {
    id: 'cenc:' + id,
    dedupeKey: id + '@' + (reportNum === null ? '*' : reportNum),
    title: 'M' + (mag === null ? '—' : mag) + (place ? ' · ' + place : ''),
    updated: Number.isFinite(eventMs) ? new Date(eventMs).toISOString() : originIso,
    eventMs: Number.isFinite(eventMs) ? eventMs : null,
    payload: JSON.stringify(raw),
  }
}

/** `cenc_eqlist` 整表的 `No1…NoN` 按**数值序**（字典序会把 No10 排到 No2 前面）。 */
function eqlistItemKeys(raw) {
  return Object.keys(raw)
    .map((k) => { const m = /^No(\d+)$/.exec(k); return m ? { k, n: Number(m[1]) } : null })
    .filter(Boolean)
    .sort((a, b) => a.n - b.n)
    .map((e) => e.k)
}

/**
 * `cenc_eqlist` 一帧（整表）→ 逐条的 entry[]。
 *
 * 为什么要展开成逐条而不是把整表当一条：整表覆盖约 20 天，同一批里绝大多数是**已经推过的**
 * 老事件。整表一条 entry 靠 md5 去重的话，只要新增一条就会把 50 条全部重推一遍，
 * Client 侧要去重 50 次、历史里还会重复。逐条按 `EventID@ReportTime` 去重则只有真正变了的
 * 那几条会进缓冲。
 *
 * `EventID@ReportTime`（而不是裸 EventID）：与上面的 EEW 同理——修订版要能进来。
 * 实测 EventID 形如 `CD.20260918223231.903`，由发震时刻派生，修订时不变。
 */
export function cencEqlistEntries(raw) {
  return cencEqlistScan(raw).entries
}

/**
 * 与 `cencEqlistEntries` 同一套判据，但**把丢弃的条数带出来**（0.9.4 / P2-13）。
 *
 * 逐条失败的形态是"上游把某几个字段改名"：45/50 条仍然解析得出来，于是
 * `handleDataFrame` 里"整表全坏"那条判据永远不触发，`errors` / `schemaSkipped` / `lastError`
 * 全都不动——5 条真实地震凭空消失而界面依旧绿色"已连接"。有了这个计数，那 5 条就至少是
 * **可见**的（stats.itemSkipped），而不是与"这批没有新地震"同形。
 * @returns {{ entries: object[], skipped: number, itemCount: number }}
 */
export function cencEqlistScan(raw) {
  if (!raw || typeof raw !== 'object') return { entries: [], skipped: 0, itemCount: 0 }
  const out = []
  let skipped = 0
  const keys = eqlistItemKeys(raw)
  for (const k of keys) {
    const item = raw[k]
    if (!item || typeof item !== 'object') { skipped += 1; continue }
    const eventId = String(item.EventID === undefined || item.EventID === null ? '' : item.EventID).trim()
    if (!eventId) { skipped += 1; continue }
    if (numOrNull(item.latitude) === null || numOrNull(item.longitude) === null) { skipped += 1; continue }
    const originIso = cnTimeToIso(item.time)
    const eventMs = Date.parse(originIso)
    const mag = numOrNull(item.magnitude)
    const place = String(
      (item.placeName === undefined || item.placeName === null ? '' : item.placeName) ||
      (item.location === undefined || item.location === null ? '' : item.location)
    ).trim()
    const reportTime = String(item.ReportTime === undefined || item.ReportTime === null ? '' : item.ReportTime).trim()
    out.push({
      id: 'cenc:' + eventId,
      dedupeKey: eventId + '@' + reportTime,
      title: 'M' + (mag === null ? '—' : mag) + (place ? ' · ' + place : ''),
      updated: Number.isFinite(eventMs) ? new Date(eventMs).toISOString() : originIso,
      eventMs: Number.isFinite(eventMs) ? eventMs : null,
      payload: JSON.stringify(item),
    })
  }
  return { entries: out, skipped, itemCount: keys.length }
}

/** 取整表的变更指纹（`md5`）。用途是**短路**：整表没变就不必逐条比对 50 次。 */
export function cencEqlistMd5(raw) {
  if (!raw || typeof raw !== 'object') return ''
  return typeof raw.md5 === 'string' ? raw.md5.trim() : ''
}

/**
 * 一个 Wolfx 源（一条 WS 常连 + 一个环缓冲 + 一组订阅者）。
 *
 * @param {object} opts
 * @param {string} opts.id `cenc_eew` | `cenc_eqlist`
 * @param {string} [opts.wsUrl] 默认 `wss://ws-api.wolfx.jp/<id>`
 * @param {number} [opts.maxEntries] 环缓冲容量
 * @param {number} [opts.seenTtlMs] 去重键记忆时长
 * @param {number} [opts.maxEventAgeMs] 事件年龄闸门（超过则记已见、不进缓冲）
 * @param {number} [opts.staleAfterMs] 数据停更阈值（0 = 不判）
 * @param {number} [opts.idleMs] 无人使用超过它就不保持连接（0 = 一直保持）
 * @param {number} [opts.heartbeatTimeoutMs]
 * @param {number} [opts.heartbeatCheckMs] 心跳检查周期
 * @param {number} [opts.connectTimeoutMs]
 * @param {number} [opts.firstDelayMs] 启动后首次建连延迟
 * @param {() => object} [opts.createSocket] 注入点：返回一个浏览器风格 WebSocket
 *   （onopen/onmessage/onclose/onerror/send/close）。默认用 Node 内置的全局 WebSocket。
 * @param {() => number} [opts.now] 注入点
 * @param {(fn: Function, ms: number) => any} [opts.setTimer] 注入点
 * @param {(t: any) => void} [opts.clearTimer] 注入点
 * @param {(err: Error) => void} [opts.onError]
 * @param {string} [opts.restUrl] REST 兜底快照地址（默认 `https://api.wolfx.jp/<id>.json`）
 * @param {number} [opts.restPollMs] REST 兜底的轮询周期（默认 60s；0 = 退化为每个重连 tick 一次）
 * @param {boolean} [opts.restEnabled] 关掉 REST 兜底（默认开；无 fetch 的环境自动关）
 * @param {(url: string, init?: object) => Promise<string>} [opts.fetchText] REST 取数注入点（测试用）
 */
export function createWolfxSource(opts = {}) {
  const id = String(opts.id || CENC_EEW_ID)
  const preset = WOLFX_SOURCES[id] || WOLFX_SOURCES[CENC_EEW_ID]
  const wsUrl = opts.wsUrl || (WOLFX_WS_BASE + id)
  const maxEntries = opts.maxEntries === undefined ? DEFAULT_MAX_ENTRIES : opts.maxEntries
  // 速报整表的覆盖窗口约 20 天 → 去重记忆必须比它长（见 EQLIST_SEEN_TTL_MS）。
  // 这里直接比 id，是因为 `isEqlist` 的函数内声明在下面（顺序不影响语义，但别留两份同义变量）。
  const defaultSeenTtl = (id === CENC_EQLIST_ID) ? EQLIST_SEEN_TTL_MS : DEFAULT_SEEN_TTL_MS
  const seenTtlMs = opts.seenTtlMs === undefined ? defaultSeenTtl : opts.seenTtlMs
  const maxEventAgeMs = opts.maxEventAgeMs === undefined ? preset.maxEventAgeMs : opts.maxEventAgeMs
  const staleAfterMs = opts.staleAfterMs === undefined ? preset.staleAfterMs : opts.staleAfterMs
  const idleMs = opts.idleMs === undefined ? 10 * 60 * 1000 : opts.idleMs
  const heartbeatTimeoutMs = opts.heartbeatTimeoutMs === undefined
    ? DEFAULT_HEARTBEAT_TIMEOUT_MS : opts.heartbeatTimeoutMs
  const connectTimeoutMs = opts.connectTimeoutMs === undefined ? DEFAULT_CONNECT_TIMEOUT_MS : opts.connectTimeoutMs
  const firstDelayMs = opts.firstDelayMs === undefined ? 1500 : opts.firstDelayMs
  const now = opts.now || (() => Date.now())
  const setTimer = opts.setTimer || ((fn, ms) => setTimeout(fn, ms))
  const clearTimer = opts.clearTimer || ((t) => clearTimeout(t))
  const onError = opts.onError || (() => {})
  const createSocket = opts.createSocket || (() => new WebSocket(wsUrl))
  // REST 兜底（0.9.4）。默认取数实现复用 poller 的 createFetchText：超时与响应体上限都是现成的，
  // 不必在第二个地方再写一遍（写两遍就一定会有一遍忘了改）。
  const restUrl = opts.restUrl === undefined ? (WOLFX_REST_BASE + id + '.json') : String(opts.restUrl || '')
  const restPollMs = opts.restPollMs === undefined ? DEFAULT_REST_POLL_MS : opts.restPollMs
  const restEnabled = opts.restEnabled !== false && !!restUrl &&
    (typeof opts.fetchText === 'function' || typeof fetch === 'function')
  const fetchText = opts.fetchText || createFetchText({ timeoutMs: opts.restTimeoutMs })
  let lastRestPollAt = 0
  let restInFlight = null
  let restAbort = null

  const isEqlist = id === CENC_EQLIST_ID
  const queryCommand = opts.queryCommand || preset.queryCommand
  const seen = new Map() // dedupeKey -> 首次见到的时间
  const buffer = [] // [{ seq, id, title, updated, xml }] 按 seq 升序
  const subscribers = new Set()
  // 游标起点用时间戳（与 poller 同一理由）：跨进程单调，Host 重启后 Client 手里那个持久化游标
  // 不会因为"从 0 重新计数"而永久卡住或重放。
  let cursor = now()
  let dropped = 0
  let running = false
  let socket = null
  let reconnectTimer = null
  let watchdogTimer = null
  let hbTimer = null
  let attempts = 0
  let connected = false
  let lastReadAt = 0
  let lastMessageAt = 0
  let lastEqlistMd5 = ''
  // 因"无人使用"而主动断开（区别于**退避重连中**）。markRead 只在它置位时才立刻建连——
  // 否则每一次 /feed 的 markRead 都会把正在等待的退避重置为 0（见 markRead 的说明）。
  let idlePaused = false
  const stats = {
    connects: 0, reconnects: 0, messages: 0, frames: 0, errors: 0, idleSkips: 0,
    lastError: '', lastOpenAt: 0, lastMessageAt: 0, lastPollAt: 0, lastCloseCode: 0,
    lastAdded: 0, lastFrames: 0,
    staleSkipped: 0, ageSkipped: 0, dupSkipped: 0, schemaSkipped: 0,
    // 逐条解析失败（0.9.4 / P2-13）：与 schemaSkipped（整表/整帧全坏）区分开。
    // 上游改几个字段名时，45/50 条仍解析得出来，所以那一条判据永远不会触发——
    // 这 5 条真实地震就凭空消失了。有了这个计数，它至少是**可见**的。
    itemSkipped: 0,
    // 指纹说"整表没变"、逐条去重却收下了新条目（0.9.4 / P3-31）：上游改表忘刷 md5 的可观测形态
    md5StaleFrames: 0,
    // REST 兜底（0.9.4）：WS 未连接时用它探"中继还活着吗"。三个读数分开记，
    // 排障时要能区分"没试过"（restPolls=0）、"试了但拿不到"（restFetched<restPolls）
    // 与"拿到了"——连不上 WS 又拿不到 REST 就是网络层，与"最近没有地震"完全不同形。
    restPolls: 0, restFetched: 0, restLastError: '',
    // 上游停更检测（探的是中继，见 DEFAULT_EQLIST_STALE_MS）
    dataTime: 0, stale: false, staleSince: 0,
  }

  function pruneSeen(t) {
    for (const [k, v] of seen) if (t - v.t > seenTtlMs) seen.delete(k)
  }

  /**
   * 停更判定：用**最新事件的时刻**（stats.dataTime）去探中继。
   *
   * 它必须是**按当前时间重算**的，不能"收到帧时算一次就存起来"——因为"停更"的两种真实形态
   * 恰恰都不产生"内容有变化的新帧"：
   *   ① 连接还在、心跳照常，但中继不再转发任何数据帧 → handleDataFrame 根本不被调用；
   *   ② 中继一直转发**同一张旧表** → 上面那条 md5 短路会带着整段处理一起跳过。
   * 只在"帧内容有变化时"求值的话，这个探针在最需要它的这两种形态下都永远停在 false，
   * 而它正是这个源存在的意义之一（见 DEFAULT_EQLIST_STALE_MS 的说明）。
   * 所以调用点有三处：每个数据帧（含被 md5 短路的帧）、以及每 30 秒一次的 housekeeping。
   */
  function refreshStale(t) {
    if (!(staleAfterMs > 0) || !(stats.dataTime > 0)) return
    const stale = (t - stats.dataTime) > staleAfterMs
    if (stale && !stats.stale) stats.staleSince = t
    if (!stale) stats.staleSince = 0
    stats.stale = stale
  }

  function isIdle(t) {
    // 有活跃订阅者 = 明确有人在看。SSE 是长连接，`lastReadAt` 只在订阅那一刻刷新过一次，
    // 只凭它判断会在十分钟后把正在给用户推流的连接掐掉。
    if (subscribers.size > 0) return false
    return idleMs > 0 && (!lastReadAt || t - lastReadAt > idleMs)
  }

  /**
   * REST 兜底（0.9.4）：`WOLFX_REST_BASE + <id> + '.json'` 是与 WS 数据帧**同结构**的快照，
   * 所以它走同一个 handleDataFrame——不另写一份解析，也就不会与 WS 那份漂开。
   *
   * 为什么此前是空的：常量与 lib/index.js 的注释一直宣称"WS 不可达时的 HTTP 轮询降级通道"，
   * 但全仓没有任何 REST 取数代码，`/feed` 只是读内存环缓冲。于是 wss:// 被中间设备掐断时，
   * 两个大陆源静默停摆、状态还是绿的——这正是本插件最不能接受的形态。
   *
   * 只在 WS 未连接时跑，且与重连退避共用 tick：不额外拉定时器链，也不在 WS 健康时重复请求。
   */
  function pollRest(t) {
    if (!restEnabled || connected || restInFlight) return
    if (restPollMs > 0 && lastRestPollAt && (t - lastRestPollAt) < restPollMs) return
    lastRestPollAt = t
    stats.restPolls += 1
    restAbort = typeof AbortController === 'function' ? new AbortController() : null
    restInFlight = Promise.resolve()
      .then(() => fetchText(restUrl, restAbort ? { signal: restAbort.signal } : undefined))
      .then((text) => {
        restInFlight = null
        restAbort = null
        if (!running) return
        let raw
        try {
          raw = JSON.parse(String(text))
        } catch (err) {
          stats.errors += 1
          stats.restLastError = id + ' REST 快照不是合法 JSON'
          stats.lastError = stats.restLastError
          onError(err)
          return
        }
        if (!raw || typeof raw !== 'object') return
        stats.restFetched += 1
        stats.restLastError = ''
        stats.lastPollAt = now()
        try {
          handleDataFrame(raw, now(), 'rest')
        } catch (err) {
          stats.errors += 1
          stats.lastError = String((err && err.message) || err)
          onError(err)
        }
      })
      .catch((err) => {
        restInFlight = null
        restAbort = null
        // 被自己中止（stop()）不算源故障，与 poller 的处置一致。
        if (err && err.name === 'AbortError' && !running) return
        stats.errors += 1
        stats.restLastError = 'REST 兜底失败：' + String((err && err.message) || err)
        stats.lastError = stats.restLastError
        onError(err)
      })
  }

  function pushEntry(e) {
    cursor += 1
    const entry = { seq: cursor, id: e.id, title: e.title, updated: e.updated, xml: e.payload }
    buffer.push(entry)
    if (buffer.length > maxEntries) dropped += buffer.splice(0, buffer.length - maxEntries).length
    for (const fn of subscribers) {
      try { fn(entry) } catch (err) { onError(err) }
    }
    return entry
  }

  /**
   * 一批候选 entry 的统一处理：年龄闸门 → 去重 → 入缓冲。
   * @returns {number} 真正入缓冲的条数
   */
  function accept(candidates, t) {
    let added = 0
    for (const e of candidates) {
      if (seen.has(e.dedupeKey)) { stats.dupSkipped += 1; continue }
      // 年龄闸门：超过 maxEventAgeMs 的事件**记为已见但不进缓冲**。
      // 这是那个"连上就回放最后一条"的行为的安全阀（见文件头）。
      if (!isEventFreshEnough(e.eventMs, t, maxEventAgeMs)) {
        seen.set(e.dedupeKey, { t })
        stats.ageSkipped += 1
        continue
      }
      seen.set(e.dedupeKey, { t })
      pushEntry(e)
      added += 1
    }
    return added
  }

  /**
   * 处理一个**数据**帧（心跳已在上游过滤掉）。
   * 结构不符要**计入 errors**：源改版与"没有地震"在 UI 上必须不同形（DESIGN 4.5）。
   */
  function handleDataFrame(raw, t, origin) {
    // frames 只统计 **WS 数据帧**：REST 兜底属于另一条通道，混在一起会让
    // "connected-but-silent"（连上了但一个数据帧都没有）这个归类失效。
    if (origin !== 'rest') stats.frames += 1
    // 去重键表按 TTL 清理。**这件事必须有人做**：seen 的键随"每个新事件 + 每个修订版"增长，
    // 不清理就是无界增长（速报每天几条，年千级）。poller.js 是每轮调用，这里挂在数据帧上。
    pruneSeen(t)
    // 速报整表用 scan 版本：它把**逐条**被丢弃的条数带出来（0.9.4 / P2-13）。
    // 此前 50 条里有 5 条字段改名时，那 5 条真实地震凭空消失，而 errors / schemaSkipped /
    // lastError 全都不动（"整表全坏"那条判据不触发），界面依旧绿色"已连接"。
    const scan = isEqlist ? cencEqlistScan(raw) : null
    const candidates = isEqlist ? scan.entries : [cencEewEntry(raw)].filter(Boolean)
    if (scan && scan.skipped > 0) {
      stats.itemSkipped += scan.skipped
      // 只记事实与计数，**不**升级成 errors：个别条目字段缺失在上游是常态（历史表里有旧格式
      // 条目），把它当故障会让蓝点常年挂着。可见性由 itemSkipped 提供。
      stats.lastError = id + ' 整表 ' + scan.itemCount + ' 条中有 ' + scan.skipped + ' 条无法解析（字段改名 / 缺坐标）'
    }
    if (candidates.length === 0) {
      if (isEqlist) {
        // 速报空表是**正常**形态（当前没有速报数据），不算故障。
        // 但"**有** NoN 项却一条都解析不出来"完全是另一回事：字段改名 / 类型变化会让整表 50 条
        // 全被丢弃。它此前与空表**同形**——errors 不涨、dataTime 停在 0、stale 永远 false，
        // 于是用户看到绿色"已连接"却一条都收不到（DESIGN 4.5 要求"源改版与没有地震必须不同形"，
        // 这正是那类静默失效）。
        const itemCount = scan.itemCount
        if (itemCount > 0) {
          stats.errors += 1
          stats.schemaSkipped += 1
          stats.lastError = id + ' 整表 ' + itemCount + ' 条全部无法解析（字段改名 / 类型变化）'
          onError(new Error(stats.lastError))
          return
        }
        stats.lastFrames = 0
        stats.lastAdded = 0
        return
      }
      stats.errors += 1
      stats.schemaSkipped += 1
      stats.lastError = id + ' 帧结构不符（缺少 ID / 坐标）'
      onError(new Error(stats.lastError))
      return
    }
    let md5Unchanged = false
    if (isEqlist) {
      const md5 = cencEqlistMd5(raw)
      // 0.9.4（P3-31）：**md5 不再作为"整表没变"的闸门**，只作为一个观测读数。
      // 此前 md5 相同就整帧 return，而 md5 是**上游自己给的**：它改了表却忘了刷指纹时，
      // 整帧被跳过、lastAdded 归零，与"没有新地震"完全同形——真实地震就这么消失了。
      // 注释当时写的是"只做短路，不做正确性依赖"，可它恰恰把正确性押在了上游的指纹新鲜度上。
      // 现在照常逐条比对（50 条小对象的解析是微秒级，而每帧间隔约 60 秒），
      // 用逐条去重（seen）来得出"有没有新东西"——那是我们自己的判据。
      md5Unchanged = !!(md5 && md5 === lastEqlistMd5)
      if (md5) lastEqlistMd5 = md5
    }
    stats.lastFrames = candidates.length
    // 数据时间取**所有解析出来的候选**里的最新事件时刻，而不是"真正入缓冲的那些"。
    // 差别在冷启动这一种情形上：整表最新一条可能是 12 小时前（年龄闸门挡下、不入缓冲），
    // 但中继明明在正常转发——若只统计入缓冲的条目，dataTime 会一直是 0，
    // 下面那条"中继停更"的判定就永远不会触发，而它恰恰是这个源存在的意义之一。
    for (const e of candidates) {
      if (typeof e.eventMs === 'number' && e.eventMs > stats.dataTime) stats.dataTime = e.eventMs
    }
    const added = accept(candidates, t)
    stats.lastAdded = added
    // 0.9.4（P3-31）：指纹说"没变"、而逐条去重却**真的收下了新条目** —— 那就是"上游改表没刷 md5"
    // 的确切形态。0.9.4 之前这种帧会被整帧跳过（真实地震消失），现在它照常入库，并且这里留一个
    // 可数的读数，让那种上游行为是**可见**的（诊断里能看出"指纹不可信"）。
    if (md5Unchanged && added > 0) stats.md5StaleFrames += 1
    // 停更判定：用最新事件的时刻探中继（速报每天都有数据，所以"很久没有新事件"就是异常）。
    // 抽成函数是因为它同时要能被**每个数据帧**与 housekeeping 的 30 秒例行检查调用。
    refreshStale(t)
  }

  function closeSocket() {
    if (watchdogTimer) { clearTimer(watchdogTimer); watchdogTimer = null }
    if (hbTimer) { clearTimer(hbTimer); hbTimer = null }
    const s = socket
    socket = null
    connected = false
    if (s) {
      s.onopen = s.onmessage = s.onclose = s.onerror = null
      try { s.close() } catch (err) { /* 已断 */ }
    }
  }

  /**
   * 心跳看门狗的调度。用**递归 timeout** 而不是 setInterval：连接被替换 / 停用后必须能干净地
   * 不再排下一条，而 setInterval 在被清掉前可能已经排进了队列。
   */
  function scheduleHeartbeatCheck(s) {
    if (hbTimer) { clearTimer(hbTimer); hbTimer = null }
    // 这个定时器驱动的是 housekeeping，而 housekeeping 里除了心跳还有两件事与 heartbeatTimeoutMs
    // **无关**：① 没人用就断开（省 Wolfx 的连接配额）；② 中继是否停更（停更探针必须由时钟推动）。
    // 所以不在这里按 heartbeatTimeoutMs 提前返回——关掉心跳检测不该顺带把这两件事一起关掉。
    // checkHeartbeat 内部自己会判 heartbeatTimeoutMs。
    const tick = () => {
      hbTimer = null
      if (!running || socket !== s) return
      housekeeping()
      if (socket === s) scheduleHeartbeatCheck(s)
    }
    const ms = opts.heartbeatCheckMs === undefined ? DEFAULT_HEARTBEAT_CHECK_MS : opts.heartbeatCheckMs
    hbTimer = setTimer(tick, ms)
    if (hbTimer && typeof hbTimer.unref === 'function') hbTimer.unref()
  }

  function scheduleNext(delay) {
    if (!running) return
    // 先清再排：与 poller 的 schedule 同一防御——避免留下两条各自自续的链（等于把上游
    // 请求速率翻倍，对 Wolfx 是连接数风险）。
    if (reconnectTimer) { clearTimer(reconnectTimer); reconnectTimer = null }
    reconnectTimer = setTimer(() => {
      reconnectTimer = null
      const t = now()
      if (isIdle(t)) {
        // **停链**（与 poller 0.5.4 的修复同形）：空闲后不再自续 IDLE_RETRY_MS——那是一条
        // 永远不停、每 5 秒空转一轮的定时器链，而 idleSkips 会随之无界增长（每天 +17,280），
        // 并被 12b 渲染成「节流跳过 N 次」：既不表达故障也不表达用量。唤醒交给 markRead()。
        stats.idleSkips += 1
        idlePaused = true
        return
      }
      // WS 连不上时至少让 REST 兜底把数据拿回来（0.9.4）。放在这里而不是另开一条链：
      // 这个 tick 本来就是"重连退避的节拍"，空闲停链时它也一起停——没人用就不请求上游。
      pollRest(t)
      connect()
    }, delay)
    if (reconnectTimer && typeof reconnectTimer.unref === 'function') reconnectTimer.unref()
  }

  /** 退避：1s → 2s → … → 60s 封顶（与 Client 侧 WS 同一套参数）。 */
  function backoffMs() {
    const base = opts.reconnectBaseMs === undefined ? DEFAULT_RECONNECT_BASE_MS : opts.reconnectBaseMs
    const max = opts.reconnectMaxMs === undefined ? DEFAULT_RECONNECT_MAX_MS : opts.reconnectMaxMs
    return Math.min(max, base * Math.pow(2, Math.max(0, attempts - 1)))
  }

  function connect() {
    if (!running || socket) return
    idlePaused = false
    let s
    try {
      s = createSocket()
    } catch (err) {
      stats.errors += 1
      stats.lastError = '建立 WebSocket 失败：' + String((err && err.message) || err)
      onError(err)
      attempts += 1
      scheduleNext(backoffMs())
      return
    }
    if (!s) {
      stats.errors += 1
      stats.lastError = '当前运行环境没有 WebSocket（需要 Node 22+ 的内置实现）'
      onError(new Error(stats.lastError))
      attempts += 1
      scheduleNext(backoffMs())
      return
    }
    socket = s
    stats.connects += 1
    // 建连看门狗：15 秒还没 open 就放弃。没有它，一条半开的连接会让状态永远停在"连接中"，
    // 而且不会有任何事件把它推走。
    if (connectTimeoutMs > 0) {
      watchdogTimer = setTimer(() => {
        watchdogTimer = null
        if (!connected && socket === s) {
          stats.errors += 1
          stats.lastError = '建连超时（' + connectTimeoutMs + 'ms 内没有 open）'
          onError(new Error(stats.lastError))
          closeSocket()
          attempts += 1
          scheduleNext(backoffMs())
        }
      }, connectTimeoutMs)
      if (watchdogTimer && typeof watchdogTimer.unref === 'function') watchdogTimer.unref()
    }
    s.onopen = () => {
      if (socket !== s) return
      connected = true
      attempts = 0
      stats.lastOpenAt = now()
      lastMessageAt = now()
      if (watchdogTimer) { clearTimer(watchdogTimer); watchdogTimer = null }
      scheduleHeartbeatCheck(s)
      // 纯文本指令取回最后一条数据。**不是 JSON**——实测发 `{"type":"query_cenceew"}`
      // 不会有任何响应，只有纯文本指令才回数据；指令名取自预设表，不做字符串拼接。
      try { s.send(queryCommand) } catch (err) {
        stats.errors += 1
        stats.lastError = '发送 query 指令失败：' + String((err && err.message) || err)
        onError(err)
      }
    }
    s.onmessage = (ev) => {
      if (socket !== s) return
      const t = now()
      lastMessageAt = t
      stats.lastMessageAt = t
      stats.messages += 1
      stats.lastPollAt = t
      let raw
      try {
        raw = JSON.parse(String(ev && ev.data))
      } catch (err) {
        stats.errors += 1
        stats.lastError = id + ' 帧不是合法 JSON'
        onError(err)
        return
      }
      if (!raw || typeof raw !== 'object') return
      if (raw.type === 'heartbeat') return
      try {
        handleDataFrame(raw, t)
      } catch (err) {
        stats.errors += 1
        stats.lastError = String((err && err.message) || err)
        onError(err)
      }
    }
    s.onerror = () => {
      if (socket !== s) return
      stats.errors += 1
      stats.lastError = 'WebSocket 连接错误'
      onError(new Error(id + ' WebSocket 连接错误'))
    }
    s.onclose = (ev) => {
      if (socket !== s) return
      closeSocket()
      attempts += 1
      stats.reconnects += 1
      stats.lastCloseCode = (ev && ev.code) || 0
      scheduleNext(backoffMs())
    }
  }

  /** 心跳看门狗：超过 heartbeatTimeoutMs 没有任何消息即判连接已死，主动断开重连。 */
  function checkHeartbeat() {
    if (!running) return
    if (heartbeatTimeoutMs > 0 && connected && lastMessageAt &&
        (now() - lastMessageAt) > heartbeatTimeoutMs) {
      stats.errors += 1
      stats.lastError = '超过 ' + heartbeatTimeoutMs + 'ms 没有收到任何消息（心跳实测 60 秒一次）→ 判定连接已死'
      onError(new Error(id + ' 心跳超时'))
      stats.reconnects += 1
      closeSocket()
      attempts += 1
      scheduleNext(backoffMs())
    }
  }

  /**
   * 连接期间的例行检查，由心跳定时器驱动（每 30 秒一次）。
   * 顺序：先判"还有人在用吗"（没人用就**主动断开**，不为无人看管的页面白占 Wolfx 的连接配额），
   * 再判心跳。两件事共用一个定时器是因为它们都是"连接还健康吗"的一部分。
   */
  function housekeeping() {
    if (!running) return
    const t = now()
    // 停更探针挂在这个例行检查上：停更的形态之一就是"连接还在但不再有新帧"，那种情况下
    // 没有数据帧来触发判定，只能由时钟推动（见 refreshStale）。
    refreshStale(t)
    if (isIdle(t)) {
      stats.idleSkips += 1
      idlePaused = true
      // 有意**不写 lastError**：空闲断开是正常行为（没人看页面就不该占 Wolfx 的连接配额），
      // 写进去会让 check-wolfx-live.mjs 之类的排障脚本把它当成一次故障打印出来。
      // "发生过多少次"由 idleSkips 如实计数。
      // closeSocket() 会连同心跳定时器一起停掉，所以这里**不再自续**（否则留下一条每 5 秒空转的
      // 链——与 poller 0.5.4 修的同一形态）。唤醒交给 markRead()。
      closeSocket()
      return
    }
    checkHeartbeat()
  }

  return {
    id,
    wsUrl,
    start() {
      if (running) return
      running = true
      // lastReadAt 保持 0 → 首次 tick 必定被判为 idle，于是**页面没人看时不建连**。
      // 这与本插件"仅实时预警、页面关闭时不推送"的定位一致，也避免无谓地占用 Wolfx 的连接配额。
      scheduleNext(firstDelayMs)
    },
    stop() {
      running = false
      // 与 poller 的 stop 不同：这里**真的把在飞连接断掉**（DESIGN 11.6 第 4 条记的正是 Host
      // 轮询器的同类缺口）。WS 常连若无条件留着，插件停用后仍会对 Wolfx 保持连接。
      if (reconnectTimer) { clearTimer(reconnectTimer); reconnectTimer = null }
      // REST 兜底的请求同样要在飞即断（0.9.4）：一次 20 秒超时的挂起请求不该活过停用。
      if (restAbort) { try { restAbort.abort() } catch (err) { /* 已经中止过 */ } }
      closeSocket()
    },
    /** 测试与诊断：手动跑一次心跳检查（生产由定时器驱动）。 */
    checkHeartbeat,
    /** 测试与诊断：手动跑一次"还在被使用吗 + 心跳"检查（生产由定时器驱动）。 */
    housekeeping,
    /** 标记"有人在用"：SSE 订阅与 /feed 路由都会调用它，据此决定要不要保持连接。 */
    markRead() {
      lastReadAt = now()
      // 只在"因为无人使用而主动断开"时才立刻建连——别让刚打开页面的用户白等一个空闲重探周期。
      // **不能对所有 `!socket` 都这么做**：退避等待中的重连也会被每一次 /feed 的 markRead 重置为 0，
      // 于是退避被压平成 /feed 的轮询周期（15 秒）。而"上游连不上时不能死循环猛敲"正是退避的
      // 全部意义（DESIGN 5.3：实测出现过并发建连失败）。Host 的 /feed 每次请求都会调它。
      if (running && !socket && idlePaused) {
        idlePaused = false
        scheduleNext(0)
      }
    },
    /** SSE 订阅：每进一条 entry 回调一次；返回取消订阅函数。 */
    subscribe(fn) {
      subscribers.add(fn)
      return () => { subscribers.delete(fn) }
    },
    subscriberCount() { return subscribers.size },
    /**
     * 取增量（与 poller.snapshot 同一契约，所以 `/feed?source=<id>` 直接可用——
     * 这同时也是 WS→HTTP 轮询的**降级通道**：Client 不订阅 SSE 时就是纯轮询）。
     */
    snapshot(since, o) {
      if (o && o.tail === true) {
        return { cursor, entries: [], truncated: false, reset: false, tail: true, frozen: !running }
      }
      const asked = Number.isFinite(since) ? since : 0
      const reset = asked > cursor
      const from = reset ? 0 : asked
      const entries = buffer.filter((b) => b.seq > from)
      const oldest = buffer.length ? buffer[0].seq : cursor + 1
      const truncated = dropped > 0 && buffer.length > 0 && from < oldest - 1
      return { cursor, entries, truncated, reset, tail: false, frozen: !running }
    },
    stats() {
      return Object.assign({}, stats, {
        bufferSize: buffer.length, seenSize: seen.size, cursor, dropped,
        connected, running, subscribers: subscribers.size, eventAgeLimitMs: maxEventAgeMs,
        restUrl, restEnabled,
      })
    },
  }
}

/**
 * 一次性探针：按 `maxEventAgeMs` 判定"这条事件还值得播报吗"。
 * 抽出来是为了让"回放旧 EEW 不该播报"这条安全规则能被独立断言，而不必搭一整套 socket 假件。
 * @param {number} eventMs 事件时刻（epoch 毫秒）
 * @param {number} t 现在
 * @param {number} maxAgeMs
 */
export function isEventFreshEnough(eventMs, t, maxAgeMs) {
  if (typeof eventMs !== 'number' || !Number.isFinite(eventMs)) return true // 时间不可解析：不替用户决定
  if (!(maxAgeMs > 0)) return true
  return (t - eventMs) <= maxAgeMs
}
