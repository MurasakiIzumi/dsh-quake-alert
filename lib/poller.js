// Host half · 电文轮询器：定时拉取上游 feed、只对新 entry 拉详情、按序放进固定长度缓冲，并把增量交给
// snapshot(since)。依赖注入的 fetchText / now / parseFeed 使测试无需联网与定时器；解析电文、判断
// 灾种、匹配关注地区都不在这一层。轮询放在 Host 是因为 Host 是每台机器一个进程，多标签页 /
// 多窗口天然只会有一次外部请求（気象庁要求「一度取得したファイルを再度取得しない」）。

/** JMA 高頻度フィード・随時（毎分更新，掲載直近の入電）。 */
export const DEFAULT_FEED_URL = 'https://www.data.jma.go.jp/developer/xml/feed/extra.xml'

/** 轮询间隔：跟上源的更新周期即可（源毎分更新）。 */
export const DEFAULT_INTERVAL_MS = 60 * 1000

/** 固定长度缓冲的容量：够 Client 断连一段时间后补齐，又不至于把内存吃满（一条详情数 KB～数十 KB）。 */
export const DEFAULT_MAX_ENTRIES = 120

/** 固定长度缓冲的**字节预算**：条数管"够不够 Client 补齐"，字节管"总内存有确定的上界"，两个约束都要。 */
export const DEFAULT_MAX_BUFFER_BYTES = 8 * 1024 * 1024

/** entry id 的记忆时长：feed 会滚动，超过这个时长的 id 不再需要记住。 */
export const DEFAULT_SEEN_TTL_MS = 24 * 60 * 60 * 1000

/** 单次外部请求的超时：没有它，对端半挂起会让一轮轮询永远不返回，整条链路静默停摆。 */
export const DEFAULT_TIMEOUT_MS = 20 * 1000

/** 单份响应体的字节上限 512KB：实际响应都在几十 KB〜200KB，异常大的说明源或链路出了问题。 */
export const DEFAULT_MAX_BODY_BYTES = 512 * 1024

/**
 * 首次启动的时钟容差：entry 发布时间晚于「进程启动时刻 - 这个容差」就算新电文。只适合**滚动型**
 * feed（JMA extra.xml）；对**活动列表型**源（NOAA 是"当前生效事件列表"、USGS 是 24 小时窗口摘要）
 * 必须由调用方传更大的 backfillMs。
 */
export const DEFAULT_START_TOLERANCE_MS = 2 * 60 * 1000

/** 详情抓取失败的额外重试次数：失败的请求并没有"取得"，重试不违反気象庁的规则，而记成已见会永久漏报。 */
export const DEFAULT_MAX_DETAIL_RETRIES = 2

/** 失败路径的重试间隔上限：失败按 2 的幂放大到它封顶，**一轮成功立刻回到 intervalMs**。 */
export const DEFAULT_MAX_BACKOFF_MS = 10 * 60 * 1000

/** 被"按需轮询"跳过时的重试间隔（空跑不产生外部请求）：首轮 pollOnce 必定被跳过，用它尽快等到首个读者。 */
export const IDLE_RETRY_MS = 5 * 1000

// ---------------------------------------------------------------- Atom 解析
// 只需要 entry 的 id / title / updated 三个字段；每处先 indexOf 一次闭合标签：`<x>([\s\S]*?)</x>`
// 在没有闭合标签时是 O(n²) 回溯，一次 indexOf 把最坏情况拉回 O(n)。
function decodeXmlText(s) {
  const str = String(s)
  const noCdata = str.indexOf(']]>') === -1 ? str : str.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
  return noCdata
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
}
function tagText(block, name) {
  const s = String(block)
  const close = '</' + name + '>'
  if (s.indexOf(close) === -1) return ''
  const m = new RegExp('<' + name + '[^>]*>([\\s\\S]*?)' + close).exec(s)
  return m ? decodeXmlText(m[1]).trim() : ''
}

/**
 * 从 Atom feed 里取出 entry 列表（按 feed 原顺序）；detailUrl 与 id 相同（JMA 的 entry <id> 本身
 * 就是详情电文地址，这一点与 NOAA 不同）。
 * @param {string} xml
 * @returns {{ id: string, title: string, updated: string, detailUrl: string }[]}
 */
export function parseAtomEntries(xml) {
  const s = String(xml)
  if (s.indexOf('</entry>') === -1) {
    // 没有闭合 entry 的三种情况必须区分，否则"被拦截 / 被截断"与"上游没有新闻"在 UI 上同形：
    // ① 正常的空 feed（有 <feed> 根）→ 空数组；② 被拦截成 HTML / 上游改版 → 抛错；③ 响应被截断 → 抛错。
    if (s.indexOf('<entry') !== -1) throw new Error('truncated Atom feed: <entry> without </entry>')
    if (s.indexOf('<feed') === -1) throw new Error('not an Atom feed (blocked page or error page?)')
    return [] // 正常空 feed：直接判定为空，也避免 O(n²) 回溯
  }
  const blocks = s.match(/<entry>[\s\S]*?<\/entry>/g) || []
  const out = []
  for (const b of blocks) {
    const id = tagText(b, 'id')
    if (!id) continue
    out.push({ id, title: tagText(b, 'title'), updated: tagText(b, 'updated'), detailUrl: id })
  }
  return out
}

/** 默认的外部抓取实现：超时是必需的——对端半挂起时 fetch 会一直挂着、整条轮询静默停摆。 */
export function createFetchText(opts = {}) {
  const timeoutMs = opts.timeoutMs === undefined ? DEFAULT_TIMEOUT_MS : opts.timeoutMs
  const maxBodyBytes = opts.maxBodyBytes === undefined ? DEFAULT_MAX_BODY_BYTES : opts.maxBodyBytes

  /** 读 body，并在**解压后**的字节数超限时立刻停止读取；没有 body 流的环境退回 res.text()。 */
  async function readLimited(res, url) {
    const stream = res && res.body
    if (!(maxBodyBytes > 0) || !stream || typeof stream.getReader !== 'function') {
      const text = await res.text()
      if (maxBodyBytes > 0) {
        const bytes = typeof Buffer !== 'undefined' ? Buffer.byteLength(text, 'utf8') : text.length
        if (bytes > maxBodyBytes) throw new Error('body too large (' + bytes + ' > ' + maxBodyBytes + '): ' + url)
      }
      return text
    }
    const reader = stream.getReader()
    const dec = typeof TextDecoder !== 'undefined' ? new TextDecoder('utf-8') : null
    let out = ''
    let total = 0
    try {
      for (;;) {
        const step = await reader.read()
        if (!step || step.done) break
        const chunk = step.value
        total += chunk && typeof chunk.byteLength === 'number' ? chunk.byteLength : 0
        if (total > maxBodyBytes) {
          try { await reader.cancel() } catch (err) { /* 取消失败不影响判定 */ }
          throw new Error('body too large (' + total + ' > ' + maxBodyBytes + '): ' + url)
        }
        out += dec ? dec.decode(chunk, { stream: true }) : String(chunk)
      }
      if (dec) out += dec.decode()
    } finally {
      try { reader.releaseLock() } catch (err) { /* 已释放 */ }
    }
    return out
  }

  return async (url, init) => {
    const timeoutSignal = (timeoutMs > 0 && typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function')
      ? AbortSignal.timeout(timeoutMs)
      : undefined
    // 两个信号都必须带上（漏掉超时会让对端挂起拖停整条轮询，漏掉外部则 stop() 形同虚设）；
    // AbortSignal.any 不可用时优先保外部信号。
    const external = init && init.signal
    let signal = timeoutSignal
    if (external) {
      signal = (timeoutSignal && typeof AbortSignal.any === 'function')
        ? AbortSignal.any([external, timeoutSignal])
        : external
    }
    const res = await fetch(url, { redirect: 'follow', signal })
    if (!res.ok) throw new Error('HTTP ' + res.status + ' ' + url)
    // 先看 content-length：声明就超限时不必把 body 读进内存（chunked 响应没有这个头，由
    // readLimited 的实测字节数兜底）。
    if (maxBodyBytes > 0 && res.headers && typeof res.headers.get === 'function') {
      const declared = Number(res.headers.get('content-length'))
      if (Number.isFinite(declared) && declared > maxBodyBytes) {
        throw new Error('declared body too large (' + declared + ' > ' + maxBodyBytes + '): ' + url)
      }
    }
    return readLimited(res, url)
  }
}

// ---------------------------------------------------------------- 轮询器
/** 字符串的 UTF-8 字节数。Host 是 Node（有 Buffer）；没有时退回字符数——只是估值，不致命。 */
const byteLengthOf = (s) => {
  const str = String(s === undefined || s === null ? '' : s)
  return typeof Buffer !== 'undefined' ? Buffer.byteLength(str, 'utf8') : str.length
}
/**
 * 建一个轮询器：start/stop/pollOnce/pollSerial/markRead/snapshot/stats。
 * @param {object} opts
 * @param {string} [opts.feedUrl] · {number} [opts.intervalMs]
 * @param {(text: string) => object[]} [opts.parseFeed] feed 原文 → entry[]：全球源形态不同
 *   （USGS 是 GeoJSON、NOAA 的详情地址在 <link> 里），所以解析器可注入。
 * @param {boolean} [opts.singleStage] true = 整源都不需要二次请求（USGS 的 entry 自带正文）。
 * @param {(entry: object) => boolean} [opts.needDetail] 逐条决定要不要拉详情（默认全都拉）。
 * @param {(entry: object, text: string) => string} [opts.detailTransform] 详情原文 → 入库载荷；
 *   抛错按详情抓取失败处理。
 * @param {number} [opts.maxDetailRetries] 详情抓取失败的额外重试次数（默认 2 = 最多尝试 3 次）。
 * @param {(entry: object) => string} [opts.dedupeKeyOf] entry → 「已处理过」的去重键（默认 entry.id）。
 *   单级源必须覆盖它：USGS 的修订复用同一个 feature id、只刷新 properties.updated，按 id 去重会让
 *   修订版连缓冲都进不去；键取 `id@updated` 即可。两级源的详情 URL 本身就随修订变化，不需要。
 * @param {number} [opts.maxEntries] 固定长度缓冲的容量 · {number} [opts.maxBufferBytes] 字节预算（0 = 不限）
 * @param {number} [opts.seenTtlMs]
 * @param {number} [opts.backfillMs] 首次启动时额外回看多久（默认 0 = 只处理启动之后发布的电文）
 * @param {number} [opts.idleMs] 无人读取超过这个时长就跳过轮询（0 = 不跳过）
 * @param {number} [opts.firstDelayMs] 启动后首轮延迟（默认 1.5s，给插件装载让路）
 * @param {(text: string) => number} [opts.feedTimeOf] feed 原文 → 「上游数据时间」（epoch 毫秒），
 *   拿不到时返回 NaN。
 * @param {number} [opts.feedStaleMs] 上游数据时间距今超过它即标 `stats.stale`（0 = 不检测）
 * @param {number} [opts.timeoutMs] 单次外部请求超时（0 = 不超时）· {number} [opts.maxBodyBytes] 响应体上限
 * @param {number} [opts.maxBackoffMs] 连续失败时的重试间隔上限（0 = 不延长；默认 10 分钟）
 * @param {number} [opts.startedAt] 进程启动时刻（默认取创建时的 now()，测试可注入）
 * @param {number} [opts.startToleranceMs] 首次启动的时钟容差（默认 2 分钟）
 * @param {(url: string, init?: { signal?: AbortSignal }) => Promise<string>} [opts.fetchText] 注入点
 *   （测试用），第二个入参是外部中止信号（stop() 中止在飞请求）。
 * @param {() => number} [opts.now] 注入点（测试用）
 * @param {(err: Error) => void} [opts.onError]
 */
export function createPoller(opts = {}) {
  const feedUrl = opts.feedUrl || DEFAULT_FEED_URL
  const parseFeed = opts.parseFeed || parseAtomEntries
  const singleStage = opts.singleStage === true
  const needDetail = opts.needDetail || null
  const detailTransform = opts.detailTransform || null
  const dedupeKeyOf = opts.dedupeKeyOf || ((e) => String(e && e.id))
  const maxDetailRetries = opts.maxDetailRetries === undefined ? DEFAULT_MAX_DETAIL_RETRIES : opts.maxDetailRetries
  const feedTimeOf = opts.feedTimeOf || null
  const feedStaleMs = opts.feedStaleMs || 0
  const intervalMs = opts.intervalMs || DEFAULT_INTERVAL_MS
  const maxEntries = opts.maxEntries || DEFAULT_MAX_ENTRIES
  const maxBufferBytes = opts.maxBufferBytes === undefined ? DEFAULT_MAX_BUFFER_BYTES : opts.maxBufferBytes
  const seenTtlMs = opts.seenTtlMs || DEFAULT_SEEN_TTL_MS
  const backfillMs = opts.backfillMs || 0
  const idleMs = opts.idleMs || 0
  const firstDelayMs = opts.firstDelayMs === undefined ? 1500 : opts.firstDelayMs
  const timeoutMs = opts.timeoutMs === undefined ? DEFAULT_TIMEOUT_MS : opts.timeoutMs
  const maxBodyBytes = opts.maxBodyBytes === undefined ? DEFAULT_MAX_BODY_BYTES : opts.maxBodyBytes
  const maxBackoffMs = opts.maxBackoffMs === undefined ? DEFAULT_MAX_BACKOFF_MS : opts.maxBackoffMs
  const startToleranceMs = opts.startToleranceMs === undefined ? DEFAULT_START_TOLERANCE_MS : opts.startToleranceMs
  const now = opts.now || (() => Date.now())
  // 进程启动时刻：首次启动时用它划"历史 / 新电文"的界（见 isFreshEnough）
  const startedAt = opts.startedAt === undefined ? now() : opts.startedAt
  const onError = opts.onError || (() => {})
  const fetchText = opts.fetchText || createFetchText({ timeoutMs, maxBodyBytes })

  // 去重键 -> { t: 首次见到的时间, fails: 详情抓取失败次数 }
  // 存对象而不是裸时间戳，是为了让"抓取失败的 entry"能被有界重试而不是立刻放弃（见 pollOnce）。
  const seen = new Map()
  const buffer = [] // [{ seq, id, title, updated, xml, bytes }] 按 seq 升序
  let bufferBytes = 0 // 缓冲里所有 entry 的 UTF-8 字节合计（0.5.3 的字节预算用）
  // 读取位置起点用当前时间戳，而不是 0：读取位置是**跨进程**递增的，Host 重启后从新的 now() 起算，天然
  // 大于上一个进程给出的任何读取位置，Client 手里那个持久化的读取位置在重启后依然可用。时钟回拨会让 cursor
  // 倒退，那种情况由 reset 捕获（按 0 补齐）。
  let cursor = now()
  let dropped = 0 // 被缓冲淘汰的条数：判断 truncated 需要它，seq 不再从 1 连续编号
  let coldStarted = false
  let running = false
  let timer = null
  let inFlight = null
  // 本轮外部请求的中止句柄：stop() 用它中止在飞的请求。
  let activeAbort = null
  // 连续失败的轮数：只用于延长失败路径的重试间隔，任何一轮成功即清零。
  let failStreak = 0
  let lastReadAt = 0 // 上一次有人经 /feed 取增量的时间（按需轮询用）
  const stats = {
    polls: 0, feedEntries: 0, detailsFetched: 0, errors: 0, idleSkips: 0,
    coldStartedAt: 0, lastPollAt: 0, lastAdded: 0, detailDropped: 0, lastError: '',
    // 详情抓不到、但用 entry 自带的回退载荷入了库的条数（nmc.cn 的橙 / 红档）。
    // 与 detailDropped 分开计数：那是"真的没进缓冲"，这是"进了但内容少一段说明"。
    detailFallback: 0,
    // 上游停更检测（feedTimeOf + feedStaleMs）：stale 为真表示"源在响应，但数据是旧的"
    feedTime: 0, stale: false, staleSince: 0,
  }

  function pruneSeen(t) {
    for (const [k, v] of seen) if (t - v.t > seenTtlMs) seen.delete(k)
  }
  /** 记一条 entry 为「已处理完」：TTL 内不再拉取。key 由 dedupeKeyOf 决定。 */
  function markSeen(key, t) { seen.set(key, { t, fails: 0 }) }
  function pushEntry(entry, xml) {
    cursor += 1
    const bytes = byteLengthOf(xml)
    buffer.push({ seq: cursor, id: entry.id, title: entry.title, updated: entry.updated, xml, bytes })
    bufferBytes += bytes
    // 条数与字节两个约束分别淘汰，共用 dropped 计数：条数管"够不够补齐"，字节管"内存有上界"。
    while (buffer.length > maxEntries) { bufferBytes -= buffer[0].bytes; buffer.splice(0, 1); dropped += 1 }
    // `length > 1`：单条就超预算时也留一条——那一条正是用户要看的数据，全清掉等于"什么都没收到"。
    while (maxBufferBytes > 0 && bufferBytes > maxBufferBytes && buffer.length > 1) {
      bufferBytes -= buffer[0].bytes; buffer.splice(0, 1); dropped += 1
    }
  }
  /** 首次启动时"这条该不该处理"：判据是 entry 发布时间与**进程启动时刻**（外加 backfillMs 回看窗口）。 */
  function isFreshEnough(entry) {
    const ts = Date.parse(entry.updated)
    if (!Number.isFinite(ts)) return false // 发布时间不可解析：当历史，不冒险播报
    return ts >= startedAt - startToleranceMs - (backfillMs > 0 ? backfillMs : 0)
  }

  /**
   * 跑一轮。第一次调用走首次启动分支：feed 里**进程启动之前**就存在的 entry 只记为已见、不产事件。
   * @returns {Promise<{ added: number, coldStart: boolean, feedEntries: number }>}
   */
  async function pollOnce() {
    const ctrl = typeof AbortController === 'function' ? new AbortController() : null
    activeAbort = ctrl
    try {
      return await pollOnceInner(ctrl ? ctrl.signal : undefined)
    } finally {
      if (activeAbort === ctrl) activeAbort = null
    }
  }

  /**
   * 失败路径的下一轮间隔：成功时就是 intervalMs，失败按 2 的幂放大到 maxBackoffMs 封顶（幂次上限
   * 6 只是防止 failStreak 累积后算出 Infinity）。
   */
  function nextDelayMs() {
    if (failStreak <= 0 || !(maxBackoffMs > 0)) return intervalMs
    const grown = intervalMs * Math.pow(2, Math.min(failStreak, 6))
    return Math.min(Math.max(grown, intervalMs), Math.max(maxBackoffMs, intervalMs))
  }

  async function pollOnceInner(signal) {
    const t = now()
    // 按需轮询：没人经 /feed 取增量就不必拉，这同时实现了"气象灾害开关关闭时不产生外部请求"。
    if (idleMs > 0 && (!lastReadAt || t - lastReadAt > idleMs)) {
      stats.idleSkips += 1
      return { added: 0, coldStart: false, feedEntries: 0, skipped: true }
    }
    stats.polls += 1
    stats.lastPollAt = t
    let feedXml
    try {
      feedXml = await fetchText(feedUrl, signal ? { signal } : undefined)
    } catch (err) {
      // stop() 中止在飞请求：这不是源的故障，不记 error、不累加失败计数。
      if (signal && signal.aborted) return { added: 0, coldStart: false, feedEntries: 0, aborted: true }
      stats.errors += 1
      stats.lastError = 'feed fetch failed: ' + String((err && err.message) || err)
      failStreak += 1
      onError(err)
      return { added: 0, coldStart: false, feedEntries: 0, failed: true }
    }
    let entries
    try {
      entries = parseFeed(feedXml)
    } catch (err) {
      // feed 结构不符（被拦截成 HTML、上游改版、响应被截断）：**必须与"没有数据"分开**，
      // 否则用户在 /feed?stats=1 上看到的是"源正常、只是没有新消息"。
      stats.errors += 1
      stats.lastError = 'feed parse failed: ' + String((err && err.message) || err)
      failStreak += 1
      onError(err)
      return { added: 0, coldStart: false, feedEntries: 0, parseFailed: true, failed: true }
    }
    if (!Array.isArray(entries)) {
      stats.errors += 1
      stats.lastError = 'feed parser returned no array'
      failStreak += 1
      return { added: 0, coldStart: false, feedEntries: 0, parseFailed: true, failed: true }
    }
    failStreak = 0
    stats.feedEntries = entries.length
    // 上游停更检测：查的是**源自己的数据时间**（USGS 的 metadata.generated / JMA feed 的
    // <updated>），而不是"我们收到多少条"——没有相关电文是常态，不能据此判故障。
    if (feedTimeOf && feedStaleMs > 0) {
      let ft = NaN
      try { ft = Number(feedTimeOf(feedXml)) } catch (err) { ft = NaN }
      stats.feedTime = Number.isFinite(ft) ? ft : 0
      const stale = Number.isFinite(ft) && ft > 0 && (t - ft > feedStaleMs)
      if (stale && !stats.stale) stats.staleSince = t
      if (!stale) stats.staleSince = 0
      stats.stale = stale
    }
    pruneSeen(t)

    const isCold = !coldStarted
    const fresh = []
    for (const e of entries) {
      const key = dedupeKeyOf(e)
      const prev = seen.get(key)
      // fails>0 且未超上限 = 上一轮详情抓取失败、这一轮该重试；其余（处理完 / 已放弃）跳过。
      const retryable = !!prev && prev.fails > 0 && prev.fails <= maxDetailRetries
      if (prev && !retryable) continue
      if (isCold && !isFreshEnough(e)) {
        markSeen(key, t) // 历史：只记已见，不拉详情、不产事件
        continue
      }
      fresh.push(e)
    }
    coldStarted = true
    if (isCold) stats.coldStartedAt = t

    // feed 通常最新在前；按 updated 升序处理，让缓冲里的顺序与时间一致
    fresh.reverse()
    let added = 0
    for (const e of fresh) {
      const key = dedupeKeyOf(e)
      // entry 自带的回退载荷：单级源（USGS）就是正文本身；nmc.cn 是列表字段拼出的 JSON，
      // 详情抓取失败时也用它（见下面的 catch）——详情页是"锦上添花"。
      const fallback = String(e.payload === undefined || e.payload === null ? '' : e.payload)
      try {
        // 「这一条要不要第二次请求」有两个来源：singleStage 是**整源**都不需要；needDetail 是**逐条**。
        const wantDetail = !singleStage && (needDetail === null || needDetail(e) === true)
        if (!wantDetail) {
          // 正文为空 = 源这一次没有给内容（empty，非故障）：记为已见、不重试。
          if (!fallback) { markSeen(key, now()); continue }
          pushEntry(e, fallback)
        } else {
          const raw = await fetchText(e.detailUrl || e.id, signal ? { signal } : undefined)
          stats.detailsFetched += 1
          pushEntry(e, detailTransform ? detailTransform(e, raw) : raw)
        }
        added += 1
        markSeen(key, now())
      } catch (err) {
        // stop() 中止在飞请求：这一轮不再往下处理，也不把"被我们自己中止"记成源的故障。
        if (signal && signal.aborted) break
        stats.errors += 1
        stats.lastError = String((err && err.message) || err)
        onError(err)
        // **抓取失败不等于「这个文件已取得」**：失败的请求什么都没取得，重试不违反気象庁的规则，
        // 而把失败记为已见会让一次瞬时故障（超时 / 连接被重置 / 5xx）变成该条警报的永久漏报
        // （extra.xml 是滚动 feed，同一个 id 不会再出现）。所以按 key 有界重试。
        const prev = seen.get(key)
        const fails = ((prev && prev.fails) || 0) + 1
        if (maxDetailRetries <= 0 || fails > maxDetailRetries) {
          // 重试用尽**不等于这条警报不存在**：列表字段拼出的 payload 与详情同形，用它入库即可，
          // 少的是"防御指南"那一段正文，而不是这条预警本身。
          if (fallback) {
            stats.detailFallback += 1
            pushEntry(e, fallback)
            added += 1
          } else {
            stats.detailDropped += 1
          }
          markSeen(key, now())
        } else {
          seen.set(key, { t: prev ? prev.t : now(), fails })
        }
      }
    }
    stats.lastAdded = added
    return { added, coldStart: isCold, feedEntries: entries.length }
  }

  /** 串行化：定时器与手动触发不会并发跑同一轮。 */
  function pollSerial() {
    if (inFlight) return inFlight
    inFlight = pollOnce().finally(() => { inFlight = null })
    return inFlight
  }

  function schedule(delay) {
    if (!running) return
    // 防御：先清掉可能残留的旧定时器再排新的，保证只有一条自续链（stop → start 之间若有一轮
    // 正在飞，它结束时仍会排 timer，不先清就会留下两条链，等于把上游请求速率翻倍）。
    if (timer) { clearTimeout(timer); timer = null }
    timer = setTimeout(async () => {
      timer = null
      let skipped = false
      try {
        const r = await pollSerial()
        skipped = !!(r && r.skipped)
      } catch (err) { onError(err) }
      // skipped 只可能来自"按需轮询"分支，也就是确实连续 idleMs 没人读：这时**停链**，
      // 唤醒交给 markRead()（/feed 路由每次被访问时调用）。
      if (skipped) return
      schedule(nextDelayMs())
    }, delay)
    // 不要让轮询定时器把 DSH 进程钉住
    if (timer && typeof timer.unref === 'function') timer.unref()
  }

  return {
    feedUrl,
    intervalMs,
    start() {
      if (running) return
      running = true
      schedule(firstDelayMs)
    },
    stop() {
      running = false
      if (timer) { clearTimeout(timer); timer = null }
      // 还要中止**在飞**的那一轮，否则最坏情况是 120 条详情各自等满 20s 超时继续跑完。
      if (activeAbort) { try { activeAbort.abort() } catch (err) { /* 已经中止过 */ } }
    },
    pollOnce,
    pollSerial,
    /**
     * 标记"有人在用"：/feed 路由每次被访问时调用。连续 idleMs 无人读之后 schedule 会停链，所以这里
     * 还承担**唤醒**（`!timer` 只在停链或一轮正在飞时为真，不会排出第二条链）。
     */
    markRead() {
      lastReadAt = now()
      if (running && !timer) schedule(IDLE_RETRY_MS)
    },
    /**
     * 取增量：返回 seq > since 的条目（含详情电文原文）。
     *
     * `opts.tail`：Client 首次启动、本地还没有读取位置时用——只回当前读取位置、不回任何条目。
     * `since > cursor`：Client 手里的读取位置比 Host 当前的还大（Host 重启过或时钟回拨），此时把 from
     * 按 0 处理并置 `reset`，让 Client 一轮就把缓冲补齐；否则 Client 会永远卡在一个比 Host 大的
     * 读取位置上（`entries` 恒空、`truncated` 也不为真）。
     * @param {number} [since]
     * @param {{ tail?: boolean }} [opts]
     */
    snapshot(since, opts) {
      if (opts && opts.tail === true) {
        return { cursor, entries: [], truncated: false, reset: false, tail: true, frozen: !running }
      }
      const asked = Number.isFinite(since) ? since : 0
      const reset = asked > cursor
      const from = reset ? 0 : asked
      const entries = buffer.filter((b) => b.seq > from)
      // 缓冲里最旧的条目 seq 大于 from+1，说明中间那些已经被缓冲淘汰、给不出来了。seq 从时间戳
      // 起算、不连续，所以必须再要求"确实发生过淘汰"（dropped > 0），否则 from=0 会被误判成有缺口。
      const oldest = buffer.length ? buffer[0].seq : cursor + 1
      const truncated = dropped > 0 && buffer.length > 0 && from < oldest - 1
      return { cursor, entries, truncated, reset, tail: false, frozen: !running }
    },
    stats() {
      return Object.assign({}, stats, { bufferSize: buffer.length, bufferBytes, seenSize: seen.size, cursor, dropped })
    },
  }
}
