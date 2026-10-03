// Host half · Wolfx 大陆源（cenc_eew / cenc_eqlist）：拉取 / 去重 / 缓存 / 读取位置，依赖 ./poller.js 的
// createFetchText（REST 兜底取数）。传输是 WebSocket 常连，连上后发纯文本指令 `query_<id>` 取回
// 最后一条数据（发 JSON 无响应）；cenc_eqlist 是覆盖约 20 天的 50 条整表，须逐条展开成 entry。
// 事件年龄门槛（EEW 10 分钟、速报 6 小时）是安全措施：连上会回放旧预警，直接播报即误报。

import { createFetchText } from './poller.js'

export const CENC_EEW_ID = 'cenc_eew'
export const CENC_EQLIST_ID = 'cenc_eqlist'

/** WebSocket 端点（免 key）。REST 快照 `https://api.wolfx.jp/<id>.json` 与数据帧同结构，是 wss:// 被掐断时的兜底通道。 */
export const WOLFX_WS_BASE = 'wss://ws-api.wolfx.jp/'
export const WOLFX_REST_BASE = 'https://api.wolfx.jp/'

/** REST 兜底轮询周期：只在 WS 未连接时跑，与重连间隔共用 tick；WS 连上后不再请求 REST。 */
export const DEFAULT_REST_POLL_MS = 60 * 1000

/** 超过它没收到任何消息即判连接已死：连接假死时不产生任何事件。上游心跳实测 60.0 秒一次。 */
export const DEFAULT_HEARTBEAT_TIMEOUT_MS = 120 * 1000

/** 心跳检查周期：心跳 60 秒一次，30 秒查一次即可（最坏多花 30 秒发现连接假死）。 */
export const DEFAULT_HEARTBEAT_CHECK_MS = 30 * 1000

/** 建连超时监控：15 秒还没 open 就放弃重连。 */
export const DEFAULT_CONNECT_TIMEOUT_MS = 15 * 1000

/** 重连间隔逐次延长：1s → 2s → … → 60s 封顶（不能对上游死循环猛敲）。 */
export const DEFAULT_RECONNECT_BASE_MS = 1000
export const DEFAULT_RECONNECT_MAX_MS = 60 * 1000

/** 固定长度缓冲的容量（条数）：够 Client 断连一段时间后补齐，又不至于把内存吃满。 */
export const DEFAULT_MAX_ENTRIES = 120

/** 固定长度缓冲的字节预算（与 poller 的 `DEFAULT_MAX_BUFFER_BYTES` 同级同值）：只看条数时内存没有硬上界；
 * 淘汰从最旧的开始、与条数淘汰共用 `dropped`，于是 `truncated` 语义自动生效。 */
export const DEFAULT_MAX_BUFFER_BYTES = 8 * 1024 * 1024

/** 字符串的 UTF-8 字节数（Host 是 Node，有 Buffer）。 */
const byteLengthOf = (s) => {
  const str = String(s === undefined || s === null ? '' : s)
  return typeof Buffer !== 'undefined' ? Buffer.byteLength(str, 'utf8') : str.length
}

/** dedupe 键的记忆时长（与 poller 一致）。 */
export const DEFAULT_SEEN_TTL_MS = 24 * 60 * 60 * 1000

/**
 * `cenc_eqlist` 的 dedupe 记忆时长：必须长于整表覆盖窗口（约 20 天），否则表里那些老条目
 * 每来一帧都会被当成新候选、被年龄门槛挡下并计入 `ageSkipped`（一个不表达事实、只随时间增长的读数）。
 */
export const EQLIST_SEEN_TTL_MS = 30 * 24 * 60 * 60 * 1000

/** 无人使用时的重探间隔（与 poller 的 IDLE_RETRY_MS 同义）。 */
export const IDLE_RETRY_MS = 5 * 1000

/** 速报的"中继是否还在转发"阈值（48 小时）：速报每天都有数据，超时即判停更；
 * 它探的是中继而不是灾害——连接正常但上游停更的形态靠连接检测发现不了。 */
export const DEFAULT_EQLIST_STALE_MS = 48 * 60 * 60 * 1000

/** 事件年龄门槛：超过它的事件**记为已见但不进缓冲**（预警 10 分钟、速报 6 小时）。 */
export const MAX_EVENT_AGE_MS = {
  [CENC_EEW_ID]: 10 * 60 * 1000,
  [CENC_EQLIST_ID]: 6 * 60 * 60 * 1000,
}

export const WOLFX_SOURCES = {
  [CENC_EEW_ID]: {
    label: 'CENC EEW',
    /**
     * 回放指令。**不是** `query_` + 源 id 拼出来的：实测 `query_cenceew` 才有效，
     * `query_cenc_eew` 不会有任何响应（拼错完全静默：连上没有数据，而连接状态是绿的）。
     */
    queryCommand: 'query_cenceew',
    maxEventAgeMs: MAX_EVENT_AGE_MS[CENC_EEW_ID],
    // 预警稀疏（数天一次）→ 不给新鲜度阈值：判"是不是停更"由速报负责。
    // dataTime 对两个源都会更新，所以速报那条停更自检事实上覆盖同一中继的两个源。
    staleAfterMs: 0,
  },
  [CENC_EQLIST_ID]: {
    label: 'CENC eqlist',
    queryCommand: 'query_cenceqlist',
    maxEventAgeMs: MAX_EVENT_AGE_MS[CENC_EQLIST_ID],
    staleAfterMs: DEFAULT_EQLIST_STALE_MS,
  },
}

/** 大陆源的裸北京时间 → 带 +08:00 偏移的 ISO 8601；认不出时原样返回（**绝不丢信息**）。
 * Client 侧另有一份同形实现（client/src/01-constants.js），两处的正则与偏移必须一起改。 */
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

/** `cenc_eew` 一帧（WS 推送包，含 `type`）→ entry；结构不对返回 null。
 * 去重键取 `ID@ReportNum`（**不是** ID）：同一场地震会多次发布，按 ID 去重会把修订版挡在门外。 */
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

/** `cenc_eqlist` 一帧（整表）→ 逐条的 entry[]：整表覆盖约 20 天，逐条按 `EventID@ReportTime` 去重
 * （EventID 由发震时刻派生、修订时不变），只有真正变化的条目进缓冲。 */
export function cencEqlistEntries(raw) {
  return cencEqlistScan(raw).entries
}

/**
 * 与 `cencEqlistEntries` 同一套判据，但把丢弃的条数带出来（stats.itemSkipped）：
 * 个别条目字段改名时"整表全坏"那条判据不触发，几条真实地震会静默消失。
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

/** 取整表的变更指纹（`md5`）。只作为观测读数，不作为"整表没变"的判定条件（见 handleDataFrame）。 */
export function cencEqlistMd5(raw) {
  if (!raw || typeof raw !== 'object') return ''
  return typeof raw.md5 === 'string' ? raw.md5.trim() : ''
}

/**
 * 一个 Wolfx 源（一条 WS 常连 + 一个固定长度缓冲 + 一组订阅者）；`opts.id` 为 `cenc_eew` | `cenc_eqlist`。
 * 选项：`wsUrl` `maxEntries` `maxBufferBytes` `seenTtlMs` `maxEventAgeMs` `staleAfterMs` `idleMs`
 * `heartbeatTimeoutMs` `heartbeatCheckMs` `connectTimeoutMs` `firstDelayMs` `restUrl` `restPollMs`
 * `restEnabled`；注入口：`createSocket`（默认 Node 内置全局 WebSocket）`now` `setTimer` `clearTimer` `onError` `fetchText`。
 */
export function createWolfxSource(opts = {}) {
  const id = String(opts.id || CENC_EEW_ID)
  const preset = WOLFX_SOURCES[id] || WOLFX_SOURCES[CENC_EEW_ID]
  const wsUrl = opts.wsUrl || (WOLFX_WS_BASE + id)
  const maxEntries = opts.maxEntries === undefined ? DEFAULT_MAX_ENTRIES : opts.maxEntries
  const maxBufferBytes = opts.maxBufferBytes === undefined ? DEFAULT_MAX_BUFFER_BYTES : opts.maxBufferBytes
  // 速报整表的覆盖窗口约 20 天 → 去重记忆必须比它长（见 EQLIST_SEEN_TTL_MS）；这里直接比 id。
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
  // REST 兜底的默认取数复用 poller 的 createFetchText：超时与响应体上限都是现成的。
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
  const buffer = [] // [{ seq, id, title, updated, xml, bytes }] 按 seq 升序
  let bufferBytes = 0 // 缓冲里所有 entry 的 UTF-8 字节合计（字节预算用，与 poller 同形）
  const subscribers = new Set()
  // 读取位置起点用时间戳：跨进程单调，Host 重启后 Client 手里持久化的读取位置不会永久卡住或重放。
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
  // 因"无人使用"而主动断开（区别于**正在等待重连间隔**）：markRead 只在它置位时才立刻建连。
  let idlePaused = false
  const stats = {
    connects: 0, reconnects: 0, messages: 0, frames: 0, errors: 0, idleSkips: 0,
    // lastError 表示「**当前**这条故障」。它进每 15 秒一帧的 SSE status 帧，Client 只要看到非空就合成
    // 「链路降级」，所以必须与 clearLastError() 成对——只写不清会把黄灯永久钉在界面上。
    lastError: '', lastErrorAt: 0,
    // 结构观测（个别条目字段缺失 / 事件时间认不出）**不进 lastError**：它们在上游是常态，不是故障，
    // 混进去的后果就是"永远有一条降级理由"。留一份原文供 /feed?stats=1 与诊断查看。
    lastSchemaNote: '',
    lastOpenAt: 0, lastMessageAt: 0, lastPollAt: 0, lastCloseCode: 0,
    lastAdded: 0, lastFrames: 0,
    staleSkipped: 0, ageSkipped: 0, dupSkipped: 0, schemaSkipped: 0,
    // 逐条解析失败：与 schemaSkipped（整表 / 整帧全坏）区分开——上游改几个字段名时大部分条目
    // 仍然解析得出来，"整表全坏"那条判据不触发，这个计数让消失的那几条可见。
    itemSkipped: 0,
    // 指纹说"整表没变"、逐条去重却收下了新条目：上游改表忘刷 md5 的可观测形态。
    md5StaleFrames: 0,
    // REST 兜底读数：restPolls / restFetched 分开记，排障时能区分"没试过"与"试了但拿不到"。
    restPolls: 0, restFetched: 0, restLastError: '',
    // 上游停更检测（探的是中继，见 DEFAULT_EQLIST_STALE_MS）
    dataTime: 0, stale: false, staleSince: 0,
    // 事件时间无法解析的条数：年龄门槛对"时间认不出"是放行的，上游改了时间格式时那道门槛会被
    // 整体绕过；放行语义不变，这个读数让走不可判定路径的条数可见。
    unparseableTime: 0,
  }

  /**
   * 记下「当前这条故障」并打时间戳。判据是**"现在还不正常"**，不是"曾经出过错"——所以每一次恢复
   * （onopen 成功、一整帧正常解析）都要配一次 clearLastError()。
   */
  function noteError(msg) {
    stats.lastError = String(msg)
    stats.lastErrorAt = now()
  }

  /**
   * 故障已经过去。**每个"恢复"的判据都必须调用它**：lastError 会随 status 帧进界面，而长休眠唤醒后
   * 心跳必然超时一次（`checkHeartbeat`），那条文案若留着，中继早已重连正常、界面却一直显示「链路降级」。
   */
  function clearLastError() {
    if (!stats.lastError && !stats.lastErrorAt) return
    stats.lastError = ''
    stats.lastErrorAt = 0
  }

  function pruneSeen(t) {
    for (const [k, v] of seen) if (t - v.t > seenTtlMs) seen.delete(k)
  }

  /**
   * 停更判定：用最新事件的时刻（stats.dataTime）按当前时间重算，不能"收到帧时算一次存起来"——
   * 连接还在但不转发数据、或一直转发同一张旧表这两种停更形态都不产生内容有变化的新帧。
   * 调用点：每个数据帧（含被 md5 标记为未变的帧）与每 30 秒一次的 housekeeping。
   */
  function refreshStale(t) {
    if (!(staleAfterMs > 0) || !(stats.dataTime > 0)) return
    const stale = (t - stats.dataTime) > staleAfterMs
    if (stale && !stats.stale) stats.staleSince = t
    if (!stale) stats.staleSince = 0
    stats.stale = stale
  }

  function isIdle(t) {
    // 有活跃订阅者 = 明确有人在看；只凭 lastReadAt（订阅那一刻刷新一次）会把正在推流的连接掐掉。
    if (subscribers.size > 0) return false
    return idleMs > 0 && (!lastReadAt || t - lastReadAt > idleMs)
  }

  /**
   * REST 兜底：`WOLFX_REST_BASE + <id> + '.json'` 是与 WS 数据帧**同结构**的快照，所以走同一个
   * handleDataFrame，不另写一份解析。只在 WS 未连接时跑，且与重连间隔共用 tick。
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
          noteError(stats.restLastError)
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
          noteError(String((err && err.message) || err))
          onError(err)
        }
      })
      .catch((err) => {
        restInFlight = null
        restAbort = null
        // 被自己中止（stop()）不算源故障。
        if (err && err.name === 'AbortError' && !running) return
        stats.errors += 1
        stats.restLastError = 'REST 兜底失败：' + String((err && err.message) || err)
        noteError(stats.restLastError)
        onError(err)
      })
  }

  function pushEntry(e) {
    cursor += 1
    const bytes = byteLengthOf(e.payload)
    const entry = { seq: cursor, id: e.id, title: e.title, updated: e.updated, xml: e.payload, bytes }
    buffer.push(entry)
    bufferBytes += bytes
    // 条数管"够不够补齐"，字节管"内存有上界"；两个约束分别淘汰、共用 dropped 计数。
    while (buffer.length > maxEntries) { bufferBytes -= buffer[0].bytes; buffer.splice(0, 1); dropped += 1 }
    // `length > 1`：单条就超预算时也留一条——那一条正是用户要看的数据，全清掉等于"什么都没收到"。
    while (maxBufferBytes > 0 && bufferBytes > maxBufferBytes && buffer.length > 1) {
      bufferBytes -= buffer[0].bytes; buffer.splice(0, 1); dropped += 1
    }
    for (const fn of subscribers) {
      try { fn(entry) } catch (err) { onError(err) }
    }
    return entry
  }

  /**
   * 一批候选 entry 的统一处理：年龄门槛 → 去重 → 入缓冲。
   * @returns {number} 真正入缓冲的条数
   */
  function accept(candidates, t) {
    let added = 0
    for (const e of candidates) {
      if (seen.has(e.dedupeKey)) { stats.dupSkipped += 1; continue }
      // 年龄门槛：超过 maxEventAgeMs 的事件记为已见但不进缓冲，这是"连上就回放旧数据"的安全阀。
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
   * 结构不符要计入 errors：源改版与"没有地震"在 UI 上必须不同形。
   */
  function handleDataFrame(raw, t, origin) {
    // frames 只统计 **WS 数据帧**：REST 兜底属于另一条通道，混在一起会让
    // "connected-but-silent"（连上了但一个数据帧都没有）这个归类失效。
    if (origin !== 'rest') stats.frames += 1
    // 去重键表按 TTL 清理：键随"每个新事件 + 每个修订版"增长，不清理就是无界增长。
    pruneSeen(t)
    // 速报整表用 scan 版本：它把逐条被丢弃的条数带出来（见 stats.itemSkipped）。
    const scan = isEqlist ? cencEqlistScan(raw) : null
    const candidates = isEqlist ? scan.entries : [cencEewEntry(raw)].filter(Boolean)
    // 事件时间认不出：EEW 的年龄门槛只看 eventMs，而 isEventFreshEnough 对 null 放行（不替用户
    // 决定），上游改一次时间格式就会整体绕过门槛。此处保持放行（全部拒绝等于漏报），只计数。
    if (!isEqlist && candidates.length > 0 && typeof candidates[0].eventMs !== 'number') {
      stats.unparseableTime += 1
      stats.lastSchemaNote = id + ' 事件时间无法解析：年龄门槛无法判定，已按"不替用户决定"放行'
    }
    if (scan && scan.skipped > 0) {
      stats.itemSkipped += scan.skipped
      // 只记事实与计数，**不**升级成 errors：个别条目字段缺失在上游是常态。同理也**不进 lastError**
      // ——那一条会被 status 帧当成"当前故障"推到界面，混进去就等于给黄灯一条永不消失的理由。
      stats.lastSchemaNote = id + ' 整表 ' + scan.itemCount + ' 条中有 ' + scan.skipped + ' 条无法解析（字段改名 / 缺坐标）'
    }
    if (candidates.length === 0) {
      if (isEqlist) {
        // 空表是**正常**形态（当前没有速报数据），但"**有** NoN 项却一条都解析不出来"是字段改名 /
        // 类型变化，与空表必须不同形（否则界面绿色"已连接"却一条都收不到）。
        const itemCount = scan.itemCount
        if (itemCount > 0) {
          stats.errors += 1
          stats.schemaSkipped += 1
          noteError(id + ' 整表 ' + itemCount + ' 条全部无法解析（字段改名 / 类型变化）')
          onError(new Error(stats.lastError))
          return
        }
        // 空表同样是"结构没变、链路在正常转"的证据，与成功解析一帧等价：清掉上一条故障。
        clearLastError()
        stats.lastFrames = 0
        stats.lastAdded = 0
        return
      }
      stats.errors += 1
      stats.schemaSkipped += 1
      noteError(id + ' 帧结构不符（缺少 ID / 坐标）')
      onError(new Error(stats.lastError))
      return
    }
    let md5Unchanged = false
    if (isEqlist) {
      const md5 = cencEqlistMd5(raw)
      // md5 是**上游自己给的**，只作为观测读数：它改了表却忘了刷指纹时，整帧跳过会让真实地震
      // 消失，所以这里照常逐条比对，用逐条去重（seen）得出"有没有新东西"。
      md5Unchanged = !!(md5 && md5 === lastEqlistMd5)
      if (md5) lastEqlistMd5 = md5
    }
    stats.lastFrames = candidates.length
    // 数据时间取**所有解析出来的候选**里的最新事件时刻，而不是真正入缓冲的那些：首次启动时整表
    // 最新一条可能被年龄门槛挡下，若只统计入缓冲的条目，下面的停更判定永远不会触发。
    for (const e of candidates) {
      if (typeof e.eventMs === 'number' && e.eventMs > stats.dataTime) stats.dataTime = e.eventMs
    }
    const added = accept(candidates, t)
    stats.lastAdded = added
    // 这一帧解析成功了 → 上一条「当前故障」已经过去。长休眠唤醒后的心跳超时正是走这条路径被清掉的。
    clearLastError()
    // 指纹说"没变"、逐条去重却真的收下了新条目 —— 上游改表没刷 md5 的确切形态，留一个可数读数。
    if (md5Unchanged && added > 0) stats.md5StaleFrames += 1
    // 停更判定用最新事件的时刻探中继（速报每天都有数据，"很久没有新事件"就是异常）。
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
   * 心跳超时监控的调度。用**递归 timeout** 而不是 setInterval：连接被替换 / 停用后必须能干净地
   * 不再排下一条，而 setInterval 在被清掉前可能已经排进了队列。
   */
  function scheduleHeartbeatCheck(s) {
    if (hbTimer) { clearTimer(hbTimer); hbTimer = null }
    // 这个定时器驱动的是 housekeeping：除心跳外还有"没人用就断开"与"中继是否停更"两件事，
    // 都不该被关掉心跳检测顺带关掉，所以不在这里按 heartbeatTimeoutMs 提前返回。
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
    // 先清再排：避免留下两条各自自续的链（等于把上游请求速率翻倍）。
    if (reconnectTimer) { clearTimer(reconnectTimer); reconnectTimer = null }
    reconnectTimer = setTimer(() => {
      reconnectTimer = null
      const t = now()
      if (isIdle(t)) {
        // **停链**：空闲后不再自续，否则留下一条每 5 秒空跑、让 idleSkips 无界增长的定时器链。
        // 唤醒交给 markRead()。
        stats.idleSkips += 1
        idlePaused = true
        return
      }
      // WS 连不上时让 REST 兜底把数据拿回来；挂在这个 tick 上，空闲停链时它也一起停。
      pollRest(t)
      connect()
    }, delay)
    if (reconnectTimer && typeof reconnectTimer.unref === 'function') reconnectTimer.unref()
  }

  /** 重连间隔逐次延长：1s → 2s → … → 60s 封顶（与 Client 侧 WS 同一套参数）。 */
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
      noteError('建立 WebSocket 失败：' + String((err && err.message) || err))
      onError(err)
      attempts += 1
      scheduleNext(backoffMs())
      return
    }
    if (!s) {
      stats.errors += 1
      noteError('当前运行环境没有 WebSocket（需要 Node 22+ 的内置实现）')
      onError(new Error(stats.lastError))
      attempts += 1
      scheduleNext(backoffMs())
      return
    }
    socket = s
    stats.connects += 1
    // 建连超时监控：15 秒还没 open 就放弃；没有它，连接假死会让状态永远停在"连接中"。
    if (connectTimeoutMs > 0) {
      watchdogTimer = setTimer(() => {
        watchdogTimer = null
        if (!connected && socket === s) {
          stats.errors += 1
          noteError('建连超时（' + connectTimeoutMs + 'ms 内没有 open）')
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
      // 连接恢复 = 建连失败 / 心跳超时 / 断线这条链路的故障已经过去。REST 兜底只在 WS 不通时才跑，
      // 它的旧文案同样不该活到 WS 恢复之后。
      clearLastError()
      stats.restLastError = ''
      // 纯文本指令取回最后一条数据（发 JSON 不会有任何响应）；指令名取自预设表，不做字符串拼接。
      try { s.send(queryCommand) } catch (err) {
        stats.errors += 1
        noteError('发送 query 指令失败：' + String((err && err.message) || err))
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
        noteError(id + ' 帧不是合法 JSON')
        onError(err)
        return
      }
      if (!raw || typeof raw !== 'object') return
      if (raw.type === 'heartbeat') return
      try {
        handleDataFrame(raw, t)
      } catch (err) {
        stats.errors += 1
        noteError(String((err && err.message) || err))
        onError(err)
      }
    }
    s.onerror = () => {
      if (socket !== s) return
      stats.errors += 1
      noteError('WebSocket 连接错误')
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

  /** 心跳超时监控：超过 heartbeatTimeoutMs 没有任何消息即判连接已死，主动断开重连。 */
  function checkHeartbeat() {
    if (!running) return
    if (heartbeatTimeoutMs > 0 && connected && lastMessageAt &&
        (now() - lastMessageAt) > heartbeatTimeoutMs) {
      stats.errors += 1
      noteError('超过 ' + heartbeatTimeoutMs + 'ms 没有收到任何消息（心跳实测 60 秒一次）→ 判定连接已死')
      onError(new Error(id + ' 心跳超时'))
      stats.reconnects += 1
      closeSocket()
      attempts += 1
      scheduleNext(backoffMs())
    }
  }

  /**
   * 连接期间的例行检查，由心跳定时器驱动（每 30 秒一次）：先判"还有人在用吗"（没人用就**主动断开**，
   * 不为无人看管的页面白占 Wolfx 的连接配额），再判心跳。
   */
  function housekeeping() {
    if (!running) return
    const t = now()
    // 停更自检挂在例行检查上：停更的形态之一是"连接还在但没有新帧"，那种情况下没有数据帧来触发判定。
    refreshStale(t)
    if (isIdle(t)) {
      stats.idleSkips += 1
      idlePaused = true
      // 有意**不写 lastError**：空闲断开是正常行为，写进去会让排障脚本把它当成一次故障打印。
      // closeSocket() 会连同心跳定时器一起停掉，所以这里不再自续；唤醒交给 markRead()。
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
      // lastReadAt 保持 0 → 首次 tick 必定被判为 idle，于是页面没人看时不建连。
      scheduleNext(firstDelayMs)
    },
    stop() {
      running = false
      // 与 poller 的 stop 不同：这里真的把在飞连接断掉，否则插件停用后仍会对 Wolfx 保持连接。
      if (reconnectTimer) { clearTimer(reconnectTimer); reconnectTimer = null }
      // REST 兜底的请求同样要在飞即断：一次 20 秒超时的挂起请求不该活过停用。
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
      // 只在"因为无人使用而主动断开"时才立刻建连。不能对所有 socket 缺失都这么做：正在等待重连间隔的
      // 重连会被每一次 /feed 的 markRead 重置为 0，重连间隔就被压平成 /feed 的轮询周期。
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
    /** 取增量（与 poller.snapshot 同一契约，`/feed?source=<id>` 直接可用；Client 不订阅 SSE 时就是纯 HTTP 轮询）。 */
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
        bufferSize: buffer.length, bufferBytes, maxBufferBytes, seenSize: seen.size, cursor, dropped,
        connected, running, subscribers: subscribers.size, eventAgeLimitMs: maxEventAgeMs,
        restUrl, restEnabled,
      })
    },
  }
}

/** 判定：`eventMs` 距 `t` 超过 `maxAgeMs` 即判"不值得播报"（回放旧 EEW 不该播报）；
 * 时间不可解析或 `maxAgeMs` 非正时返回 true。 */
export function isEventFreshEnough(eventMs, t, maxAgeMs) {
  if (typeof eventMs !== 'number' || !Number.isFinite(eventMs)) return true // 时间不可解析：不替用户决定
  if (!(maxAgeMs > 0)) return true
  return (t - eventMs) <= maxAgeMs
}
