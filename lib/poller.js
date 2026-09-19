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

/**
 * 环缓冲的**字节预算**（0.5.3）。
 *
 * 只按条数限容是不够的（DESIGN 11.6 第 5 条）：单条响应上限是 512KB，120 条最坏就是 60MB
 * 常驻，而实际形态差得很远（JMA 电文约 100KB、nmc.cn 详情页 46KB、USGS 的 GeoJSON 约 200KB）。
 * 条数管的是"够不够 Client 补齐"，字节管的是"总内存有确定的上界"——两个约束都要。
 *
 * 8MB 的取法：JMA（约 100KB/条）会被它收到约 80 条，仍然覆盖 80 分钟量级的断线，而内存
 * 有上界。淘汰从最旧的开始，与条数淘汰共用 `dropped`，所以 `truncated` 的语义自动跟着生效
 * （Client 会知道中间有缺口，而不是以为补齐了）。
 */
export const DEFAULT_MAX_BUFFER_BYTES = 8 * 1024 * 1024

/** entry id 的记忆时长：feed 会滚动，超过这个时长的 id 不再需要记住。 */
export const DEFAULT_SEEN_TTL_MS = 24 * 60 * 60 * 1000

/** 单次外部请求的超时：没有它，对端半挂起会让一轮轮询永远不返回，整条链路静默停摆。 */
export const DEFAULT_TIMEOUT_MS = 20 * 1000

/**
 * 单份响应体的上限（字节）：feed 与详情电文实际都在几十 KB〜200KB（实测 JMA extra.xml 约 100KB、
 * USGS 2.5_day.geojson 约 200KB），异常大的响应视为链路故障。取 512KB：既给正常波动留足余量，
 * 又让「被串改成超大响应」时无论内存还是正则解析的代价都有界。
 */
export const DEFAULT_MAX_BODY_BYTES = 512 * 1024

/**
 * 冷启动的时钟容差：entry 的发布时间只要晚于「进程启动时刻 - 这个容差」就算新电文。
 * 用意是吸收"启动瞬间"的边界——电文在 Host 启动前一分钟发布、但第一次轮询还没轮到它时，
 * 不该被当成几小时前的历史丢掉。取 2 分钟：重启时最多补播最近两分钟的电文（通常 0～1 条），
 * 既不会刷屏，也不会因为几秒的时钟抖动漏报。
 *
 * 注意这个值只适合**滚动型** feed（JMA extra.xml：只列最近入電，条目年龄 ≈ 灾害年龄）。
 * 对**活动列表型**源（NOAA 是"当前生效事件列表"、USGS 是 24 小时窗口摘要）必须由调用方
 * 传更大的 backfillMs，否则一条发布 20 分钟、仍然生效的海啸警报会在冷启动时被当历史
 * 永久丢弃，且不会自愈（见 lib/index.js 里三个源的配置）。
 */
export const DEFAULT_START_TOLERANCE_MS = 2 * 60 * 1000

/**
 * 详情抓取失败的额外重试次数。
 *
 * 気象庁的规则是「**一度取得した**ファイルを再度取得しない」——抓取失败并没有"取得"，
 * 所以重试不违反该要求；反过来，把失败也记为已见会让一次瞬时故障（超时、连接被重置，
 * 在大陆网络下是常态）变成该条警报的永久漏报，因为 extra.xml 是滚动 feed，同一个 id
 * 不会再出现。所以失败按 key 计数、有限次重试，超过上限才放弃并计入 detailDropped。
 */
export const DEFAULT_MAX_DETAIL_RETRIES = 2

/**
 * 被"按需轮询"跳过时的重试间隔。
 *
 * 首轮 pollOnce 必定被跳过（还没有人读过 /feed，lastReadAt 为 0），而 Client 首次读通常在
 * 插件装载后约 3 秒。若跳过也按完整 interval 排下一次，Host 在启动后要等整整一个 interval
 * （JMA 60s / USGS 120s / NOAA 300s）才第一次真正拉源——启动窗口里发布的警报会晚一个周期
 * 才被看到。改用短退避轮询"有没有人开始用"，空转不产生任何外部请求。
 *
 * 0.5.4：**只用于"还没人来读"的启动窗口**。连续 idleMs 无人读之后不再自续（见 schedule），
 * 由 `markRead()` 唤醒——否则这条 5 秒链会一直自续到进程退出，`idleSkips` 每小时 +720，
 * 而它会以「节流跳过 N 次」的形式显示在设置页里（一个随空闲时长线性增长、不表达任何事实的读数）。
 */
export const IDLE_RETRY_MS = 5 * 1000

// ---------------------------------------------------------------- Atom 解析
// 只需要 entry 的 id / title / updated 三个字段；详情电文不在这一层解析。
//
// 为什么每处都先 indexOf 一次闭合标签：`<x>([\s\S]*?)</x>` 这种惰性量词在**没有闭合标签**时
// 会对每个起始位置一路回溯到串尾，复杂度是 O(n²)。实测 parseAtomEntries 处理「只有开标签」
// 的输入时每翻倍耗时 ×4（112KB 已 184ms），而上限是 2MB——上游被截断（GFW RST 很常见）或返回
// HTML 拦截页时就可能把 Host 的事件循环冻结几十秒。一次 indexOf 把这种最坏情况拉回 O(n)。
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
 * 从 Atom feed 里取出 entry 列表（按 feed 原顺序，通常是最新在前）。
 * detailUrl 与 id 相同：JMA 的 entry <id> 本身就是详情电文地址（这一点与 NOAA 不同）。
 * @param {string} xml
 * @returns {{ id: string, title: string, updated: string, detailUrl: string }[]}
 */
export function parseAtomEntries(xml) {
  const s = String(xml)
  if (s.indexOf('</entry>') === -1) {
    // 没有闭合 entry 有三种情况，**必须区分**（否则"被拦截 / 被截断"与"上游没有新闻"在 UI 上同形，
    // 0.4.1 新加的 parseFeed 抛错路径也就等于没生效——实测 JMA 与 NOAA 都走默认 Atom 解析）：
    //   ① 正常的空 feed（有 <feed> 根、没有 entry）→ 空数组（empty）
    //   ② 被拦截成 HTML / 上游改版 → 抛错 → pollOnce 计入 errors
    //   ③ 响应被截断（有 <entry 却没有 </entry>）→ 抛错
    if (s.indexOf('<entry') !== -1) throw new Error('Atom feed 被截断：有 <entry> 没有 </entry>')
    if (s.indexOf('<feed') === -1) throw new Error('不是 Atom feed（可能是拦截页或错误页）')
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
    // 先看 content-length：声明就超限时根本不必把 body 读进内存。`res.text()` 会把整个响应
    // 缓冲下来（之后再用 Buffer.byteLength 比较只能减少环缓冲的占用，保护不了峰值内存）。
    // chunked 响应没有这个头，仍由下面的实测字节数兜底。
    if (maxBodyBytes > 0 && res.headers && typeof res.headers.get === 'function') {
      const declared = Number(res.headers.get('content-length'))
      if (Number.isFinite(declared) && declared > maxBodyBytes) {
        throw new Error('响应体声明过大 ' + declared + ' > ' + maxBodyBytes + '：' + url)
      }
    }
    const text = await res.text()
    if (maxBodyBytes > 0) {
      const bytes = typeof Buffer !== 'undefined' ? Buffer.byteLength(text, 'utf8') : text.length
      if (bytes > maxBodyBytes) throw new Error('响应体过大 ' + bytes + ' > ' + maxBodyBytes + '：' + url)
    }
    return text
  }
}

// ---------------------------------------------------------------- 轮询器
/** 字符串的 UTF-8 字节数。Host 是 Node（有 Buffer）；没有时退回字符数——只是估值，不致命。 */
const byteLengthOf = (s) => {
  const str = String(s === undefined || s === null ? '' : s)
  return typeof Buffer !== 'undefined' ? Buffer.byteLength(str, 'utf8') : str.length
}
/**
 * @param {object} opts
 * @param {string} [opts.feedUrl]
 * @param {(text: string) => object[]} [opts.parseFeed] feed 原文 → entry[]（默认按 Atom 解析）。
 *   全球源形态不同（USGS 是 GeoJSON、NOAA 的详情地址在 <link> 里），所以解析器可注入。
 * @param {boolean} [opts.singleStage] true = entry 自带正文（USGS），跳过详情抓取。
 * @param {(entry: object) => boolean} [opts.needDetail] 逐条决定要不要拉详情（默认全都拉）。
 *   0.5.2 加，给 nmc.cn 用：气象预警只有橙色及以上才拉详情页，蓝 / 黄直接用 entry.payload
 *   ——它们占样本的 94%，逐条拉 46KB 的详情页既无必要也不礼貌（详见 lib/nmc-source.js）。
 *   与 singleStage 的关系：singleStage 是"整源都不需要"，needDetail 是"逐条"，两者都判为
 *   不需要时走 payload 分支。
 * @param {(entry: object, text: string) => string} [opts.detailTransform] 详情原文 → 入库载荷
 *   （默认原样）。0.5.2 加，给 nmc.cn 用：把 46KB 的详情页收敛成正文 + 条目字段的 JSON，
 *   否则环缓冲按条数计容会被整页 HTML 撑大（DESIGN 11.7 第 5 条）。抛错按详情抓取失败处理。
 * @param {number} [opts.maxDetailRetries] 详情抓取失败的额外重试次数（默认 2 = 最多尝试 3 次）。
 *   失败的 entry **不再**立刻记为已见——见 pollOnce 里的说明。
 * @param {(entry: object) => string} [opts.dedupeKeyOf] entry → 「已处理过」的去重键（默认 entry.id）。
 *   单级源必须覆盖它：USGS 对同一场地震的修订复用同一个 feature id，只刷新 properties.updated，
 *   而震级复核是**上修**（M5.2 → M6.4）。按 id 去重会让修订版连缓冲都进不去，
 *   所谓「用 updated 判断新旧」就成了空话——上修永远不会再提醒。所以键取 `id@updated`：
 *   版本没变仍只处理一次（满足気象庁「不重复获取同一文件」的同源诉求），版本变了才放行。
 *   两级源（JMA / NOAA）不需要：它们的详情 URL 本身就随修订变化。
 * @param {number} [opts.intervalMs]
 * @param {number} [opts.maxEntries] 环缓冲容量
 * @param {number} [opts.maxBufferBytes] 环缓冲的字节预算（0 = 不限；默认 8MB，见常量说明）
 * @param {number} [opts.seenTtlMs]
 * @param {number} [opts.backfillMs] 冷启动时额外回看多久（默认 0 = 只处理**进程启动之后**发布的电文）
 * @param {number} [opts.idleMs] 无人读取超过这个时长就跳过轮询（0 = 不跳过；生产由 lib/index.js 设为 10 分钟）
 * @param {number} [opts.firstDelayMs] 启动后首轮延迟（默认 1.5s，给插件装载让路）
 * @param {(text: string) => number} [opts.feedTimeOf] feed 原文 → 「上游数据时间」（epoch 毫秒）。
 *   配合 feedStaleMs 做**上游停更检测**：源还在响应、但我们拿到的是旧数据（缓存 / 上游停更），
 *   与"没有新闻"完全不同，必须能被看见。拿不到时返回 NaN（按"未知"处理，不误判）。
 * @param {number} [opts.feedStaleMs] 上游数据时间距今超过它即标 `stats.stale`（0 = 不检测）
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
  const startToleranceMs = opts.startToleranceMs === undefined ? DEFAULT_START_TOLERANCE_MS : opts.startToleranceMs
  const now = opts.now || (() => Date.now())
  // 进程启动时刻：冷启动时用它划"历史 / 新电文"的界（见 isFreshEnough）
  const startedAt = opts.startedAt === undefined ? now() : opts.startedAt
  const onError = opts.onError || (() => {})
  const fetchText = opts.fetchText || createFetchText({ timeoutMs, maxBodyBytes })

  // 去重键 -> { t: 首次见到的时间, fails: 详情抓取失败次数 }
  // 存对象而不是裸时间戳，是为了让"抓取失败的 entry"能被有界重试而不是立刻放弃（见 pollOnce）。
  const seen = new Map()
  const buffer = [] // [{ seq, id, title, updated, xml, bytes }] 按 seq 升序
  let bufferBytes = 0 // 缓冲里所有 entry 的 UTF-8 字节合计（0.5.3 的字节预算用）
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
    coldStartedAt: 0, lastPollAt: 0, lastAdded: 0, detailDropped: 0, lastError: '',
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
    // 两个约束分别淘汰，共用 dropped 计数（0.5.3 加的字节预算见 DEFAULT_MAX_BUFFER_BYTES）：
    // 条数管"够不够补齐"，字节管"内存有上界"。先按条数再按字节，顺序不影响结果。
    while (buffer.length > maxEntries) { bufferBytes -= buffer[0].bytes; buffer.splice(0, 1); dropped += 1 }
    // `length > 1`：单条就超预算时也留一条——那一条正是用户要看的数据，全清掉等于"什么都没收到"。
    while (maxBufferBytes > 0 && bufferBytes > maxBufferBytes && buffer.length > 1) {
      bufferBytes -= buffer[0].bytes; buffer.splice(0, 1); dropped += 1
    }
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
    let entries
    try {
      entries = parseFeed(feedXml)
    } catch (err) {
      // feed 结构不符（被拦截成 HTML、上游改版、响应被截断）：**必须与"没有数据"分开**。
      // 记 error 并落日志，否则用户在 /feed?stats=1 上看到的是"源正常、只是没有新消息"。
      stats.errors += 1
      stats.lastError = 'feed 解析失败：' + String((err && err.message) || err)
      onError(err)
      return { added: 0, coldStart: false, feedEntries: 0, parseFailed: true }
    }
    if (!Array.isArray(entries)) {
      stats.errors += 1
      stats.lastError = 'feed 解析器没有返回数组'
      return { added: 0, coldStart: false, feedEntries: 0, parseFailed: true }
    }
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
      try {
        // 「这一条要不要第二次请求」有两个来源：singleStage 是**整源**都不需要（USGS 的 entry
        // 自带正文）；needDetail 是**逐条**判断（nmc.cn 只对橙色及以上拉详情页）。
        const wantDetail = !singleStage && (needDetail === null || needDetail(e) === true)
        if (!wantDetail) {
          const payload = String(e.payload === undefined || e.payload === null ? '' : e.payload)
          // 正文为空 = 源这一次没有给内容（empty，非故障）：记为已见、不重试。
          if (!payload) { markSeen(key, now()); continue }
          pushEntry(e, payload)
        } else {
          const raw = await fetchText(e.detailUrl || e.id)
          stats.detailsFetched += 1
          pushEntry(e, detailTransform ? detailTransform(e, raw) : raw)
        }
        added += 1
        markSeen(key, now())
      } catch (err) {
        stats.errors += 1
        stats.lastError = String((err && err.message) || err)
        onError(err)
        // **抓取失败不等于「这个文件已取得」**。気象庁约束的是「一度取得したファイルを
        // 再度取得しない」，失败的请求什么都没取得，重试不违反它；而把失败也记为已见，
        // 一次瞬时故障（超时 / 连接被重置 / 5xx——大陆网络下是常态）就会让这条警报永久漏报：
        // extra.xml 是滚动 feed，同一个 id 不会再出现。所以按 key 有界重试：
        // 未超限时只累加 fails、不记已见，下一轮继续拉；超过上限才放弃并计入 detailDropped
        // （在 /feed?stats=1 与设置页可见），避免对真正坏掉的 URL 无限反复请求。
        const prev = seen.get(key)
        const fails = ((prev && prev.fails) || 0) + 1
        if (maxDetailRetries <= 0 || fails > maxDetailRetries) {
          stats.detailDropped += 1
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
    // 防御：清掉可能残留的旧定时器。stop() 也会清，但 stop → start 之间若有一轮正在飞，
    // 那一轮结束时仍会排下一个 timer 并覆盖这个变量，于是留下两条各自自续的链
    // （等于把上游请求速率翻倍——对 JMA 是合规风险）。这里先清再排，保证只有一条链。
    if (timer) { clearTimeout(timer); timer = null }
    timer = setTimeout(async () => {
      timer = null
      let skipped = false
      try {
        const r = await pollSerial()
        skipped = !!(r && r.skipped)
      } catch (err) { onError(err) }
      // skipped 只可能来自 pollOnce 的"按需轮询"分支，也就是"确实连续 idleMs 没人读"。
      // 这时**停链**（0.5.4）：继续按 IDLE_RETRY_MS 自续下去，就是一条永远不停、每 5 秒
      // 空转一轮的定时器链，而 `idleSkips` 会随之无界增长（每天 +17,280），并被 12b 渲染成
      // 「节流跳过 N 次」——那个数字既不表达故障也不表达用量。唤醒交给 markRead()
      // （/feed 路由每次被访问时调用），这也正是"按需轮询"该有的形态：没人用就真的不转。
      if (skipped) return
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
    /**
     * 标记"有人在用"：/feed 路由每次被访问时调用，按需轮询据此决定是否继续拉源。
     *
     * 0.5.4 起它还承担**唤醒**：连续 idleMs 无人读之后 schedule 会停链（见那里），
     * 于是"有人来读了"是恢复轮询的唯一信号。`!timer` 只在停链（或一轮正在飞）时为真，
     * 而 schedule 内部先清再排，所以这里不会排出第二条链。
     */
    markRead() {
      lastReadAt = now()
      if (running && !timer) schedule(IDLE_RETRY_MS)
    },
    /**
     * 取增量：返回 seq > since 的条目（含详情电文原文）。
     *
     * `opts.tail`（0.3.2）：Client **首次**启动、本地还没有游标时用——只回当前游标，
     * 不回任何条目。冷启动回填历史等于把几小时前的旧警报当新闻刷屏，所以首次对齐位置而不是重放。
     *
     * `since > cursor`（0.3.2）：说明 Client 手里的游标比 Host 当前的还大——Host 重启过
     * （新进程以启动时刻的时间戳重新起算，理论上更大，但旧进程跑得久时确实可能更大），
     * 或发生过时钟回拨。此时把 from 直接按 0 处理并置 `reset`，让 Client 一轮就把缓冲里的
     * 条目补齐并对齐游标；否则 Client 会永远卡在一个比 Host 大的游标上——`entries` 恒空、
     * `truncated` 也不会为真——静默失联。
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
      return Object.assign({}, stats, { bufferSize: buffer.length, bufferBytes, seenSize: seen.size, cursor, dropped })
    },
  }
}
