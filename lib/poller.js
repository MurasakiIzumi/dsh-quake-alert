// Host half · JMA 电文轮询器（0.3.0-b）
//
// 职责（严格限定在这一层）：
//   ① 定时拉取 JMA 的 Atom feed（高頻度フィード・随時，毎分更新）
//   ② 只对**新的** entry 拉详情电文；拉过的 entry id 永不重拉
//      —— 気象庁明文要求「一度取得したファイルを再度取得しない」，违反会被封 IP
//   ③ 把详情电文原文按序放进环缓冲，维护一个单调递增的游标
//   ④ 通过 snapshot(since) 把增量交给 Client（走本地只读路由，无外部请求）
//   ⑤ 外部请求带超时与响应体上限；冷启动只丢「进程启动之前」的历史，启动之后发布的照常处理
//      （0.3.2：没有超时会让对端挂起把整条轮询拖停；把启动后发布的也当历史会静默漏报）
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

/** 单次外部请求的超时：没有它，对端半挂起会让一轮轮询永远不返回，整条链路静默停摆。 */
export const DEFAULT_TIMEOUT_MS = 20 * 1000

/** 单份响应体的上限（字节）：feed 与详情电文都是几 KB～几十 KB，异常大的响应视为链路故障。 */
export const DEFAULT_MAX_BODY_BYTES = 2 * 1024 * 1024

/**
 * 冷启动的时钟容差：entry 的发布时间只要晚于「进程启动时刻 - 这个容差」就算新电文。
 * 用意是吸收"启动瞬间"的边界——电文在 Host 启动前一分钟发布、但第一次轮询还没轮到它时，
 * 不该被当成几小时前的历史丢掉。取 2 分钟：重启时最多补播最近两分钟的电文（通常 0～1 条），
 * 既不会刷屏，也不会因为几秒的时钟抖动漏报。
 */
export const DEFAULT_START_TOLERANCE_MS = 2 * 60 * 1000

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

/**
 * 默认的外部抓取实现（抽出来是为了能被单测直接验证超时 / 体积上限）。
 *
 * 超时是必需的：对端半挂起时 fetch 会一直挂着，inFlight 不释放、schedule 的 await 不返回，
 * 整条轮询静默停摆，而且连 errors 计数都不增加（看起来像"没有新消息"）。
 * 体积上限是防御性的：异常大的响应说明源或链路出了问题，宁可让这一轮失败也不把内存吃满。
 */
export function createFetchText(opts = {}) {
  const timeoutMs = opts.timeoutMs === undefined ? DEFAULT_TIMEOUT_MS : opts.timeoutMs
  const maxBodyBytes = opts.maxBodyBytes === undefined ? DEFAULT_MAX_BODY_BYTES : opts.maxBodyBytes
  return async (url) => {
    const signal = (timeoutMs > 0 && typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function')
      ? AbortSignal.timeout(timeoutMs)
      : undefined
    const res = await fetch(url, { redirect: 'follow', signal })
    if (!res.ok) throw new Error('HTTP ' + res.status + ' ' + url)
    const text = await res.text()
    if (maxBodyBytes > 0) {
      const bytes = typeof Buffer !== 'undefined' ? Buffer.byteLength(text, 'utf8') : text.length
      if (bytes > maxBodyBytes) throw new Error('响应体过大 ' + bytes + ' > ' + maxBodyBytes + '：' + url)
    }
    return text
  }
}

// ---------------------------------------------------------------- 轮询器
/**
 * @param {object} opts
 * @param {string} [opts.feedUrl]
 * @param {number} [opts.intervalMs]
 * @param {number} [opts.maxEntries] 环缓冲容量
 * @param {number} [opts.seenTtlMs]
 * @param {number} [opts.backfillMs] 冷启动时额外回看多久（默认 0 = 只处理**进程启动之后**发布的电文）
 * @param {number} [opts.idleMs] 无人读取超过这个时长就跳过轮询（0 = 不跳过；生产由 lib/index.js 设为 10 分钟）
 * @param {number} [opts.firstDelayMs] 启动后首轮延迟（默认 1.5s，给插件装载让路）
 * @param {number} [opts.timeoutMs] 单次外部请求超时（0 = 不超时；默认 20s）
 * @param {number} [opts.maxBodyBytes] 单份响应体上限（0 = 不限；默认 2MB）
 * @param {number} [opts.startedAt] 进程启动时刻（默认取创建时的 now()，测试可注入）
 * @param {number} [opts.startToleranceMs] 冷启动的时钟容差（默认 2 分钟，见 DEFAULT_START_TOLERANCE_MS）
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
  const timeoutMs = opts.timeoutMs === undefined ? DEFAULT_TIMEOUT_MS : opts.timeoutMs
  const maxBodyBytes = opts.maxBodyBytes === undefined ? DEFAULT_MAX_BODY_BYTES : opts.maxBodyBytes
  const startToleranceMs = opts.startToleranceMs === undefined ? DEFAULT_START_TOLERANCE_MS : opts.startToleranceMs
  const now = opts.now || (() => Date.now())
  // 进程启动时刻：冷启动时用它划"历史 / 新电文"的界（见 isFreshEnough）
  const startedAt = opts.startedAt === undefined ? now() : opts.startedAt
  const onError = opts.onError || (() => {})
  const fetchText = opts.fetchText || createFetchText({ timeoutMs, maxBodyBytes })

  const seen = new Map() // entry id -> 首次见到的时间
  const buffer = [] // [{ seq, id, title, updated, xml }] 按 seq 升序
  // 0.3.2：游标起点用当前时间戳，而不是 0。游标是**跨进程**递增的：Host 重启后从新的
  // now() 起算，天然大于上一个进程给出的任何游标。这样 Client 手里那个持久化游标在重启后
  // 依然可用——既不会撞车（旧游标 > 新 cursor 时靠下面的 reset 兜底），也不会出现
  // 「旧游标 <= 新 cursor 但缓冲前段没拿过」的漏报。若从 0 重新计数，重启后 Client 要么
  // 永久卡住（entries 恒空），要么把重启后积累的条目当成历史重放。
  // 时钟回拨（NTP 校正 / 用户改时间）会让 cursor 倒退，那种情况由 reset 兜住（按 0 补齐）。
  let cursor = now()
  let dropped = 0 // 被环缓冲淘汰的条数：判断 truncated 需要它，seq 不再从 1 连续编号
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
    if (buffer.length > maxEntries) dropped += buffer.splice(0, buffer.length - maxEntries).length
  }
  /**
   * 冷启动时"这条该不该处理"。
   *
   * 判据是 entry 的发布时间与**进程启动时刻**比较，而不是与"首次轮询时刻"比较：
   * 真正的冷启动发生在 Host 启动之后约 1 分钟（首轮 pollOnce 先被按需轮询 skip 掉，
   * 要等 Client 首次读 /feed 才 markRead），如果按"冷启动这一轮看到的一切都算历史"处理，
   * 那一分钟里发布的真实警报会被永久记为已见、永不处理——静默漏报。
   * backfillMs 是额外的回看窗口（默认 0 = 只看启动之后）。
   */
  function isFreshEnough(entry) {
    const ts = Date.parse(entry.updated)
    if (!Number.isFinite(ts)) return false // 发布时间不可解析：当历史，不冒险播报
    return ts >= startedAt - startToleranceMs - (backfillMs > 0 ? backfillMs : 0)
  }

  /**
   * 跑一轮。首次调用是"冷启动"：feed 里**进程启动之前**就存在的 entry 只记为已见、不产事件，
   * 避免把 feed 里的历史（实测可达 10 小时）当新闻刷屏；启动之后发布的仍然照常处理。
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
      if (isCold && !isFreshEnough(e)) {
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
     *
     * `opts.tail`（0.3.2）：Client **首次**启动、本地还没有游标时用——只回当前游标，
     * 不回任何条目。冷启动回填历史等于把几小时前的旧警报当新闻刷屏，所以首次对齐位置而不是重放。
     *
     * `since > cursor`（0.3.2）：说明 Host 进程重启过（游标从 0 重新计数）。此时把 from 直接
     * 按 0 处理并置 `reset`，让 Client 一轮就把重启后缓冲里的条目补齐并对齐游标；否则 Client
     * 会永远卡在一个比 Host 大的游标上——`entries` 恒空、`truncated` 也不会为真——静默失联。
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
      // 缓冲里最旧的条目 seq 大于 from+1，说明中间那些已经被环缓冲淘汰、给不出来了。
      // seq 从时间戳起算、不连续，所以必须再要求"确实发生过淘汰"（dropped > 0），
      // 否则 from=0 会被误判成有缺口。
      const oldest = buffer.length ? buffer[0].seq : cursor + 1
      const truncated = dropped > 0 && buffer.length > 0 && from < oldest - 1
      return { cursor, entries, truncated, reset, tail: false, frozen: !running }
    },
    stats() {
      return Object.assign({}, stats, { bufferSize: buffer.length, seenSize: seen.size, cursor, dropped })
    },
  }
}
