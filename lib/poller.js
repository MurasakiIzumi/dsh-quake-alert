// Host half · JMA 电文轮询器（0.3.0-b）
//
// 职责（严格限定在这一层）：
//   ① 定时拉取 JMA 的 Atom feed（高頻度フィード・随時，毎分更新）
//   ② 只对**新的** entry 拉详情电文；拉过的 entry id 永不重拉
//      —— 気象庁明文要求「一度取得したファイルを再度取得しない」，违反会被封 IP
//   ③ 把详情电文原文按序放进环缓冲，维护一个单调递增的游标
//   ④ 通过 snapshot(since) 把增量交给 Client（走本地只读路由，无外部请求）
//
// 明确不做：解析电文、判断灾种与警戒レベル、匹配关注地区。那是 Client 的事
// （保持"实时逻辑在 Client"的定位，也让回归测试继续在单进程里跑）。
//
// 为什么轮询放在 Host（方案 C3）：DSH 的 Host 是每台机器一个进程，多标签页 / 多窗口
// 天然只会有一次外部请求。若放在 Client，N 个标签页就是对同一文件取 N 次。
//
// 可测性：fetch 与时钟都可注入，测试不需要联网、不需要等定时器（直接 await pollOnce()）。

/** JMA 高頻度フィード・随時（毎分更新，掲載直近の入電）。 */
export const DEFAULT_FEED_URL = 'https://www.data.jma.go.jp/developer/xml/feed/extra.xml'

/** 轮询间隔：跟上源的更新周期即可（源毎分更新）。 */
export const DEFAULT_INTERVAL_MS = 60 * 1000

/** 环缓冲容量：够 Client 断连一段时间后补齐，又不至于把内存吃满（一条详情数 KB～数十 KB）。 */
export const DEFAULT_MAX_ENTRIES = 120

/** entry id 的记忆时长：feed 会滚动，超过这个时长的 id 不再需要记住。 */
export const DEFAULT_SEEN_TTL_MS = 24 * 60 * 60 * 1000

// ---------------------------------------------------------------- Atom 解析
// 只需要 entry 的 id / title / updated 三个字段；详情电文不在这一层解析。
function decodeXmlText(s) {
  return String(s)
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
}
function tagText(block, name) {
  const m = new RegExp('<' + name + '[^>]*>([\\s\\S]*?)</' + name + '>').exec(block)
  return m ? decodeXmlText(m[1]).trim() : ''
}

/**
 * 从 Atom feed 里取出 entry 列表（按 feed 原顺序，通常是最新在前）。
 * @param {string} xml
 * @returns {{ id: string, title: string, updated: string }[]}
 */
export function parseAtomEntries(xml) {
  const blocks = String(xml).match(/<entry>[\s\S]*?<\/entry>/g) || []
  const out = []
  for (const b of blocks) {
    const id = tagText(b, 'id')
    if (!id) continue
    out.push({ id, title: tagText(b, 'title'), updated: tagText(b, 'updated') })
  }
  return out
}

// ---------------------------------------------------------------- 轮询器
/**
 * @param {object} opts
 * @param {string} [opts.feedUrl]
 * @param {number} [opts.intervalMs]
 * @param {number} [opts.maxEntries] 环缓冲容量
 * @param {number} [opts.seenTtlMs]
 * @param {number} [opts.backfillMs] 冷启动时仍要处理的"最近 N 毫秒"（默认 0 = 历史全部只记游标）
 * @param {number} [opts.idleMs] 无人读取超过这个时长就跳过轮询（0 = 不跳过；生产由 lib/index.js 设为 10 分钟）
 * @param {number} [opts.firstDelayMs] 启动后首轮延迟（默认 1.5s，给插件装载让路）
 * @param {(url: string) => Promise<string>} [opts.fetchText] 注入点（测试用）
 * @param {() => number} [opts.now] 注入点（测试用）
 * @param {(err: Error) => void} [opts.onError]
 */
export function createPoller(opts = {}) {
  const feedUrl = opts.feedUrl || DEFAULT_FEED_URL
  const intervalMs = opts.intervalMs || DEFAULT_INTERVAL_MS
  const maxEntries = opts.maxEntries || DEFAULT_MAX_ENTRIES
  const seenTtlMs = opts.seenTtlMs || DEFAULT_SEEN_TTL_MS
  const backfillMs = opts.backfillMs || 0
  const idleMs = opts.idleMs || 0
  const firstDelayMs = opts.firstDelayMs === undefined ? 1500 : opts.firstDelayMs
  const now = opts.now || (() => Date.now())
  const onError = opts.onError || (() => {})
  const fetchText = opts.fetchText || (async (url) => {
    const res = await fetch(url, { redirect: 'follow' })
    if (!res.ok) throw new Error('HTTP ' + res.status + ' ' + url)
    return res.text()
  })

  const seen = new Map() // entry id -> 首次见到的时间
  const buffer = [] // [{ seq, id, title, updated, xml }] 按 seq 升序
  let cursor = 0
  let coldStarted = false
  let running = false
  let timer = null
  let inFlight = null
  let lastReadAt = 0 // 上一次有人经 /feed 取增量的时间（按需轮询用）
  const stats = {
    polls: 0, feedEntries: 0, detailsFetched: 0, errors: 0, idleSkips: 0,
    coldStartedAt: 0, lastPollAt: 0, lastAdded: 0,
  }

  function pruneSeen(t) {
    for (const [k, v] of seen) if (t - v > seenTtlMs) seen.delete(k)
  }
  function pushEntry(entry, xml) {
    cursor += 1
    buffer.push({ seq: cursor, id: entry.id, title: entry.title, updated: entry.updated, xml })
    if (buffer.length > maxEntries) buffer.splice(0, buffer.length - maxEntries)
  }
  /** 冷启动回填窗口：只在显式配置 backfillMs 时才处理"启动前刚发布"的那一小段。 */
  function withinBackfill(entry, t) {
    if (!(backfillMs > 0)) return false
    const ts = Date.parse(entry.updated)
    if (!Number.isFinite(ts)) return false
    return t - ts <= backfillMs
  }

  /**
   * 跑一轮。首次调用是"冷启动"：把当前 feed 里的 entry 全部记为已见但不产事件，
   * 避免把 feed 里的历史（实测可达 10 小时）当新闻刷屏。
   * @returns {Promise<{ added: number, coldStart: boolean, feedEntries: number }>}
   */
  async function pollOnce() {
    const t = now()
    // 按需轮询：没人经 /feed 取增量就不必拉。这同时实现了"气象灾害开关关闭时不产生外部请求"——
    // Client 关闭后不再拉取，Host 在 idleMs 之后自然停下，无需把 Client 配置读到 Host 侧。
    if (idleMs > 0 && (!lastReadAt || t - lastReadAt > idleMs)) {
      stats.idleSkips += 1
      return { added: 0, coldStart: false, feedEntries: 0, skipped: true }
    }
    stats.polls += 1
    stats.lastPollAt = t
    let feedXml
    try {
      feedXml = await fetchText(feedUrl)
    } catch (err) {
      stats.errors += 1
      onError(err)
      return { added: 0, coldStart: false, feedEntries: 0 }
    }
    const entries = parseAtomEntries(feedXml)
    stats.feedEntries = entries.length
    pruneSeen(t)

    const isCold = !coldStarted
    const fresh = []
    for (const e of entries) {
      if (seen.has(e.id)) continue
      if (isCold && !withinBackfill(e, t)) {
        seen.set(e.id, t) // 历史：只记已见，不拉详情、不产事件
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
      try {
        const xml = await fetchText(e.id)
        stats.detailsFetched += 1
        pushEntry(e, xml)
        added += 1
      } catch (err) {
        stats.errors += 1
        onError(err)
      }
      // 成功或失败都记为已见：失败的 entry 不再重试，避免对同一个坏 URL 反复请求
      // （気象庁明文要求不重复获取同一文件，宁可漏一条也不骚扰源站）
      seen.set(e.id, now())
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
    timer = setTimeout(async () => {
      timer = null
      try { await pollSerial() } catch (err) { onError(err) }
      schedule(intervalMs)
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
    },
    pollOnce,
    pollSerial,
    /** 标记"有人在用"：/feed 路由每次被访问时调用，按需轮询据此决定是否继续拉源。 */
    markRead() { lastReadAt = now() },
    /**
     * 取增量：返回 seq > since 的条目（含详情电文原文）。
     * @param {number} [since]
     */
    snapshot(since) {
      const from = Number.isFinite(since) ? since : 0
      const entries = buffer.filter((b) => b.seq > from)
      // 缓冲里最旧的条目 seq 大于 from+1，说明中间那些已经被环缓冲淘汰、给不出来了
      const oldest = buffer.length ? buffer[0].seq : cursor + 1
      const truncated = buffer.length > 0 && from < oldest - 1
      return { cursor, entries, truncated, frozen: !running }
    },
    stats() { return Object.assign({}, stats, { bufferSize: buffer.length, seenSize: seen.size, cursor }) },
  }
}
