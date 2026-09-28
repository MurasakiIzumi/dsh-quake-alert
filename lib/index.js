// Host half of dsh-quake-alert: serves the region tables and runs the feed pollers behind
// /feed and /stream, and holds the `quake-alert` settings namespace. Depends on
// @deepseek-ai/schemastery, ./data/*, ./poller.js, ./global-sources.js, ./wolfx-source.js,
// ./nmc-source.js. settings 是可选依赖，注入用 `ctx.inject(['settings'], cb)`。

import z from '@deepseek-ai/schemastery'
import { CITIES_BY_PREF } from './data/cities.js'
import { RIVER_AREAS } from './data/river-areas.js'
import { createPoller, DEFAULT_FEED_URL } from './poller.js'
import { USGS_FEED_URL, NOAA_FEED_URL, parseUsgsEntries, parseNoaaEntries, usgsFeedGeneratedAt } from './global-sources.js'
import { createWolfxSource, CENC_EEW_ID, CENC_EQLIST_ID } from './wolfx-source.js'
import { createNmcSource } from './nmc-source.js'
import { CN_AREAS } from './data/cn-areas.js'
import { WORLD_COUNTRIES, WORLD_CITIES_BY_COUNTRY } from './data/world-cities.js'

/** JMA feed 自身的更新时间（根元素的 `<updated>`，带偏移的 ISO），解析不出时为 NaN。 */
function jmaFeedUpdatedAt(xml) {
  const m = /<updated>([^<]*)<\/updated>/.exec(String(xml || ''))
  return m ? Date.parse(m[1]) : NaN
}

export const name = 'dsh-quake-alert'

/** Client 拉取市区町村表的只读路由。 */
export const AREAS_PATH = '/dsh-quake-alert/areas'

/** Client 拉取 JMA 电文增量的只读路由（`?since=<读取位置>`）。 */
export const FEED_PATH = '/dsh-quake-alert/feed'

/**
 * 大陆源的 **SSE 推送**路由（`?source=cenc_eew|cenc_eqlist`）。
 * 与 /feed 的关系：/feed 是"轮询取增量"，这条是"Host 主动推"；SSE 延迟 ≈0，且 WS 被中间
 * 设备重置时 Client 只要不订阅这条、改回轮询 /feed 即可完成降级。
 */
export const STREAM_PATH = '/dsh-quake-alert/stream'

/** SSE 心跳注释帧的间隔。防的是中间设备（代理 / 反代）把闲置的长连接掐掉。 */
export const SSE_KEEPALIVE_MS = 15 * 1000

/** `/stream` 允许的**连续写入积压帧数**上限：`res.write` 连续返回 false 到这个次数就断流，让 Client 带 Last-Event-ID 重连并由缓冲补齐。 */
export const MAX_SSE_BACKPRESSURE = 200

// Host 侧各源的停更阈值：Host 与 Client 分开构建，Host 不能 import Client 的 `SOURCE_CONTRACTS`，
// 所以这里保留一份，两边一致性由回归断言守护（契约侧是 `SOURCE_CONTRACTS[*].staleAfterMs`，
// nmc.cn 的是 `lib/nmc-source.js` 的 `NMC_STALE_MS`）。
export const JMA_STALE_MS = 3 * 60 * 60 * 1000
export const USGS_STALE_MS = 30 * 60 * 1000

/** Settings namespace owned by this plugin（小写 + 连字符，符合 settings 服务文法）. */
export const SETTINGS_NAMESPACE = 'quake-alert'

/** 震度档位（P2PQuake scale 数值），与 Client 侧 SCALE_OPTIONS 对齐. */
export const SCALE_VALUES = [10, 20, 30, 40, 45, 50, 55, 60, 70]

/** 海啸等级，与 Client 侧 TSUNAMI_OPTIONS 对齐. */
export const TSUNAMI_GRADES = ['Watch', 'Warning', 'MajorWarning']

// `/feed` 单次最多返回的条目数与**字节预算**（后者：只限条数兜不住 50 条最坏约 5MB 的响应体，
// 且 `JSON.stringify` 会让 Host 内存再翻一倍）。两者同一语义——截断即置 `more`，
// Client 用最后一条实际返回的 seq 续拉，不会漏报。
export const MAX_FEED_ENTRIES = 50
export const MAX_FEED_BYTES = 1024 * 1024

/**
 * 就地截断过大的增量响应并置 `more`；至少保留一条，截断不会造成漏报。
 *
 * @param {{ entries?: unknown[] }} payload
 * @param {number} [max] 条数上限
 * @param {number} [maxBytes] 字节上限（0 = 不限）
 * @returns {object} 同一个 payload 对象
 */
export function capFeedEntries(payload, max, maxBytes) {
  const limit = max === undefined ? MAX_FEED_ENTRIES : max
  const byteLimit = maxBytes === undefined ? MAX_FEED_BYTES : maxBytes
  if (!payload || !Array.isArray(payload.entries)) return payload
  if (payload.entries.length > limit) {
    payload.entries = payload.entries.slice(0, limit)
    payload.more = true
  }
  if (byteLimit > 0) {
    const bytesOf = (e) => {
      const s = e && typeof e.xml === 'string' ? e.xml : ''
      return typeof Buffer !== 'undefined' ? Buffer.byteLength(s, 'utf8') : s.length
    }
    let total = 0
    let keep = 0
    for (const e of payload.entries) {
      total += bytesOf(e)
      if (keep > 0 && total > byteLimit) break
      keep += 1
    }
    if (keep < payload.entries.length) {
      payload.entries = payload.entries.slice(0, Math.max(1, keep))
      payload.more = true
    }
  }
  return payload
}

/**
 * 跨站 GET 防护。这几条路由没有来源校验（webServer 本身不校验，host 可配 0.0.0.0），而 `/feed`
 * 有一个**不需要读响应就能触发**的副作用（markRead() 会让按需轮询继续），`/stream` 则会让 Host
 * 保持与 Wolfx 的长连接。只在明确带 `sec-fetch-site: cross-site` 时拒绝。
 */
export function isCrossSite(req) {
  const headers = (req && req.headers) || {}
  return String(headers['sec-fetch-site'] || '').toLowerCase() === 'cross-site'
}

/** 跨站拒绝的统一响应体（不回任何内部细节：这些路由没有鉴权）。 */
export function denyCrossSite(res) {
  res.writeHead(403, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify({ error: 'cross-site request rejected' }))
}

/**
 * 把一个事件序列化成 SSE 帧（纯函数）。按行遍历是因为 SSE 规范要求数据的每一行都带 `data: `
 * 前缀（载荷换成多行文本时不做这一步会静默坏掉）；帧以空行结束。
 */
export function sseFrame(event, data, id) {
  let out = ''
  if (id !== undefined && id !== null) out += 'id: ' + String(id) + '\n'
  if (event) out += 'event: ' + String(event) + '\n'
  const text = JSON.stringify(data === undefined ? null : data)
  for (const line of String(text).split('\n')) out += 'data: ' + line + '\n'
  return out + '\n'
}

/**
 * 建 `/stream` 的处理函数工厂（依赖全部注入，测试用一个假源即可覆盖全部分支）。
 * @param {object} opts
 * @param {Record<string, object>} opts.sources 源表（需有 snapshot / subscribe / markRead）
 * @param {(req: object) => boolean} opts.isCrossSite
 * @param {(res: object) => void} opts.denyCrossSite
 * @param {number} [opts.keepAliveMs] · {Function} [opts.setInterval] · {Function} [opts.clearInterval]
 * @returns {Function} `(req, res)` handler，另挂 `closeAll()` 断掉在飞的流
 */
export function createStreamHandler(opts) {
  const sources = opts.sources || {}
  // 默认用真实实现（而不是 `() => false`）：忘了注入时也不该静默丢掉跨站防护。live = 这条
  // handler 名下**在飞**的流，见 closeAll。
  const isCrossSiteFn = opts.isCrossSite || isCrossSite
  const denyCrossSiteFn = opts.denyCrossSite || denyCrossSite
  const keepAliveMs = opts.keepAliveMs === undefined ? SSE_KEEPALIVE_MS : opts.keepAliveMs
  const setIntervalFn = opts.setInterval || ((fn, ms) => setInterval(fn, ms))
  const clearIntervalFn = opts.clearInterval || ((t) => clearInterval(t))

  const live = new Set()

  const streamHandler = function (req, res) {
    if (isCrossSiteFn(req)) return denyCrossSiteFn(res)
    // 只接受 GET / HEAD（宿主不会代做这件事）。假 req（测试注入的件）没有 method → 放行。
    const httpMethod = (req && req.method) ? String(req.method).toUpperCase() : ''
    if (httpMethod && httpMethod !== 'GET' && httpMethod !== 'HEAD') {
      res.writeHead(405, { 'content-type': 'application/json; charset=utf-8', allow: 'GET, HEAD' })
      res.end(JSON.stringify({ error: 'method not allowed' }))
      return
    }
    live.add(res)
    let unsub = null
    let keepAlive = null
    let closed = false
    let backpressure = 0
    const cleanup = () => {
      if (closed) return
      closed = true
      live.delete(res)
      if (unsub) { try { unsub() } catch (e) { /* 已移除 */ } unsub = null }
      if (keepAlive) { clearIntervalFn(keepAlive); keepAlive = null }
      // 断流必须**真的把连接断掉**：只做"停止写"会让写不进去、读不动的连接假死驻留
      // （不 end 也不 destroy → `close` 永不触发 → 客户端收不到 disconnect）。两种失败都吞掉。
      try { if (!res.writableEnded) res.end() } catch (e) { /* 已断 */ }
      if (typeof res.destroy === 'function') { try { res.destroy() } catch (e) { /* 已断 */ } }
    }
    /**
     * 写一帧；客户端已断开时 write 会抛，必须吞掉（否则异常会落回 webServer 的 handler）。
     * `res.write` 返回 false 表示内核缓冲已满：计数、连续超过 MAX_SSE_BACKPRESSURE 就断流
     * （不丢帧——丢帧会让 Client 的 seq 出现无法察觉的空洞）；`drain` 到了就归零。
     */
    const write = (event, data, id) => {
      if (closed || res.writableEnded) return
      try {
        if (res.write(sseFrame(event, data, id)) === false) {
          backpressure += 1
          if (backpressure > MAX_SSE_BACKPRESSURE) cleanup()
        } else if (backpressure !== 0) {
          backpressure = 0
        }
      } catch (err) { cleanup() }
    }
    try {
      const url = new URL((req && req.url) || '/', 'http://127.0.0.1')
      const wanted = String(url.searchParams.get('source') || '').trim()
      if (!Object.prototype.hasOwnProperty.call(sources, wanted)) {
        res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify({ error: 'unknown source' }))
        return
      }
      const src = sources[wanted]
      // 压缩必须被跳过：dsh-host-webserver 对 `text/event-stream` 显式不做 gzip（lib 源码可查），
      // 否则流式响应会被缓冲成"攒够一批才发"。
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
      })
      // 读取位置的来源优先级：Last-Event-ID（浏览器重连自动带）> `?since=`（首次建连时带持久化的读取位置）
      // > tail（什么都没有 → 只对齐位置不重放历史）。注意 `Number(null)` 与 `Number('')` **都是 0**
      // —— 缺失的 since 会被误当成"从 0 取"、等于一次吐出整个缓冲，必须先把空值显式排掉。
      const lastEventId = Number((req.headers && req.headers['last-event-id']) || 0)
      const rawSince = url.searchParams.get('since')
      const trimmedSince = rawSince === null ? null : String(rawSince).trim()
      const sinceParam = (trimmedSince === null || trimmedSince === '') ? null : Number(trimmedSince)
      const useSince = (Number.isFinite(lastEventId) && lastEventId > 0)
        ? lastEventId
        : (sinceParam !== null && Number.isFinite(sinceParam) && sinceParam >= 0 ? sinceParam : null)
      const snap = useSince === null ? src.snapshot(0, { tail: true }) : src.snapshot(useSince, {})
      /**
       * 源的健康摘要（第一条 sync 帧与周期 status 帧共用）。注入的源可能没有 stats()、也可能自己抛错
       * ——诊断字段缺失不该把整条流弄断，所以整段捕获异常。
       */
      const statusPayload = () => {
        let st = null
        try { st = (typeof src.stats === 'function') ? src.stats() : null } catch (err) { st = null }
        const out = {
          source: wanted,
          cursor: (st && Number.isFinite(st.cursor)) ? st.cursor : snap.cursor,
          stale: !!(st && st.stale),
          dataTime: (st && typeof st.dataTime === 'number' && st.dataTime > 0) ? st.dataTime : null,
        }
        // SSE 路径下 Client **不轮询 /feed**，所以这几个"判定是不是真的还在连"的小字段必须跟着
        // 这一帧走（stats 本体仍然只在 /feed?stats=1 里）。
        if (st) {
          if (typeof st.connected === 'boolean') out.connected = st.connected
          const le = String(st.lastError || '') || String(st.restLastError || '')
          if (le) out.lastError = le
          if (Number.isFinite(st.itemSkipped) && st.itemSkipped > 0) out.itemSkipped = st.itemSkipped
          if (Number.isFinite(st.unparseableTime) && st.unparseableTime > 0) out.unparseableTime = st.unparseableTime
        }
        return out
      }
      const first = statusPayload()
      // 开头的 sync 帧把读取位置、缓冲状态与数据健康一起告诉 Client：诊断要用，也让它判断要不要改走 /feed 补齐。
      write('sync', {
        source: wanted, cursor: snap.cursor, reset: snap.reset,
        truncated: snap.truncated, frozen: snap.frozen, replayed: snap.entries.length,
        stale: first.stale, dataTime: first.dataTime,
      })
      // 断线补齐：客户端在此之前断开的话，之后装的订阅与心跳就再也没人能清掉（cleanup 有幂等守卫），
      // 所以每一步之后都要重新看一眼 closed。
      for (const e of snap.entries) {
        if (closed) return
        write('entry', e, e.seq)
      }
      if (closed) return
      src.markRead()
      unsub = src.subscribe((entry) => write('entry', entry, entry.seq))
      keepAlive = setIntervalFn(() => {
        if (closed || res.writableEnded) return
        // 这一帧有两个作用：① 防中间设备把闲置的长连接掐掉；② 把**停更状态**推给 Client——
        // 停更的形态恰恰是"不再有新帧"，只看 sync / entry 的话状态会停在连接那一刻。
        try { res.write(sseFrame('status', statusPayload())) } catch (err) { cleanup() }
      }, keepAliveMs)
      if (keepAlive && typeof keepAlive.unref === 'function') keepAlive.unref()
      if (typeof res.on === 'function') {
        res.on('close', cleanup)
        res.on('error', cleanup)
        // 写入积压计数归零（见 write 的说明）：drain 一到就把计数清掉，别让偶发的两次慢读累积成断流
        res.on('drain', () => { backpressure = 0 })
      }
      // 极端时序：上面这些刚装好、客户端就在这期间断了，此时 cleanup 才能真正清掉它们。
      if (closed) cleanup()
    } catch (err) {
      cleanup()
      try { console.warn('[dsh-quake-alert] /stream 处理失败：' + String((err && err.message) || err)) } catch (e) {}
      if (!res.headersSent) {
        res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify({ error: 'internal error' }))
      } else { try { res.end() } catch (e) { /* 连接已断 */ } }
    }
  }
  /**
   * 关掉这条 handler 名下**所有在飞**的流（与 cleanup 同一套收尾动作）。`webServer.register()`
   * 返回的 disposer 只删路由表里那一项、不碰已建立的连接，少了这一层，停用 / 重载插件后旧 fiber
   * 留下的每条流仍在推数据，而 wolfx 的 `isIdle()` 永远不成立。
   */
  streamHandler.closeAll = () => {
    for (const r of Array.from(live)) {
      try { if (!r.writableEnded) r.end() } catch (e) { /* 已断 */ }
      try { if (typeof r.destroy === 'function') r.destroy() } catch (e) { /* 已断 */ }
    }
    live.clear()
  }
  return streamHandler
}

/**
 * 持久化配置的 schema，字段与 Client 侧 DEFAULT_CFG 一一对应：schema 默认值即「用户从未改过」
 * 时的解析值，用户层只记录真正被改写的字段。这里只做类型/范围校验，白名单过滤仍在 Client 侧做。
 *
 * `vol()` 是 DSH 0.1.7 起的 settings 契约：表单只编辑**标记为 volatile 的字段**，且只有 volatile
 * 字段变化时 loader 不重启插件条目，所以本插件的每个配置字段都要逐叶标记。漏标会让该字段从表单
 * 投影里消失（Client 读回的 `snap.value` 因此缺键，被规整回默认值），并且它永远写不进 profile
 * 配置——写入抛 `Config field "…" is not volatile` 并整批 ops 一起被拒（旧版 schemastery 没有
 * `.volatile()` 时此处退化为普通字段）。
 */
const vol = (schema) => (typeof schema.volatile === 'function' ? schema.volatile() : schema)

/**
 * 界面语言标识的**形状**（BCP 47 风格，与 `@deepseek-ai/dsh-client-locale` 的 `LOCALE_ID_PATTERN`
 * 同一形态）：`ja`、`en`、`zh-CN`、`zh-TW`、`pt-BR` 都合法。**允许首尾空白**——Client 的
 * `resolveLang` 先 trim() 再解析。这里不列白名单：能力清单在 Client 的 `LANGUAGE_OPTIONS`。
 */
const LANGUAGE_ID_PATTERN = /^\s*[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*\s*$/u

export const QuakeAlertSettingsSchema = z.object({
  source: vol(z.union(['prod', 'sandbox']).default('prod')),
  // 大陆源的链路选择：auto = SSE 优先、走不通自动降级；poll = 用户强制轮询。
  // 必须与 client/src/02-storage.js 的 normalizeCfg 同步（有测试守着）。
  cnTransport: vol(z.union(['auto', 'poll']).default('auto')),
  watch: z.object({
    // 空 = 关注全日本；两级粒度：都道府县 +（可选）市区町村
    prefectures: vol(z.array(z.string()).default([])),
    cities: vol(z.array(z.string()).default([])),
    // 全球关注点：坐标 + 半径。与日本行政区模式并存、互不影响。
    places: vol(z.array(z.object({
      name: z.string().default(''),
      lat: z.number().min(-90).max(90).default(0),
      lon: z.number().min(-180).max(180).default(0),
      radiusKm: z.number().min(1).max(2000).default(300),
      // 来源分支：jp / cn / global。**必须在 Host schema 里登记、且刻意不给 default**——未声明的键
      // 会被 schema 规整掉，于是 Client 读回来的 places 与内存副本永远不等、settingsOpsFor 会反复
      // 写回 Host；而 default('global') 会让 Client 按名称形状推导分支的旧关注点全被算成 global。
      origin: z.union(['jp', 'cn', 'global']),
      // 大陆关注点的省 / 市：行政区层级匹配的判据，不再是「名字里有没有 `·`」；登记与不给 default
      // 的理由与 origin 相同。
      province: z.string(),
      city: z.string(),
    })).default([])),
  }),
  disasters: z.object({
    earthquake: vol(z.boolean().default(true)),
    tsunami: vol(z.boolean().default(true)),
    // 气象灾害（泥石流 / 洪水 / 大雨 / 高潮…），固定警戒レベル4 以上播报
    weather: vol(z.boolean().default(true)),
    // 中国大陆气象灾害：**两类分开**（暴雨的橙 / 红常年可见，地质灾害实测全是黄色）。
    // 开关只影响**播报**，不影响 Host 拉取（Host 不知道 Client 配置，靠 idleMs 自然停下）。
    cnRainstorm: vol(z.boolean().default(true)),
    cnGeology: vol(z.boolean().default(true)),
    // 海外气象灾害（美国 NWS + 加拿大 ECCC）。一个开关覆盖两个源——两者都按关注点生效。
    overseasWeather: vol(z.boolean().default(true)),
  }),
  thresholds: z.object({
    quakeScale: vol(z.number().min(0).max(70).default(40)),
    eewScale: vol(z.number().min(0).max(70).default(45)),
    tsunamiGrade: vol(z.union(TSUNAMI_GRADES).default('Watch')),
    // 全球源的最低震级：EMSC / USGS 给的是震级，与日本的震度不可换算
    globalMagnitude: vol(z.number().min(0).max(10).default(4.5)),
    // 大陆速报（cenc_eqlist）的独立震级门槛：速报覆盖低到 M2.5，用预警门槛播报会被小震打扰。
    cnReportMagnitude: vol(z.number().min(0).max(10).default(4.5)),
  }),
  notify: z.object({
    sound: vol(z.boolean().default(true)),
    system: vol(z.boolean().default(true)),
    volume: vol(z.number().min(0).max(1).default(0.7)),
    // 分灾害音效开关：地震（含 EEW）/ 海啸 / 气象分开控制，与 Client 的 DEFAULT_CFG.notify 一一对应。
    soundQuake: vol(z.boolean().default(true)),
    soundTsunami: vol(z.boolean().default(true)),
    soundWeather: vol(z.boolean().default(true)),
  }),
  dedupe: z.object({
    windowMinutes: vol(z.number().min(1).max(1440).default(10)),
  }),
  quietHours: z.object({
    enabled: vol(z.boolean().default(false)),
    start: vol(z.string().default('23:00')),
    end: vol(z.string().default('07:00')),
    breakForSevere: vol(z.boolean().default(true)),
  }),
  // 界面语言。**必须是最后一个**："两侧默认值完全一致"那条断言是 JSON.stringify 全量比较，
  // Host schema 的字段顺序要与 Client 的 DEFAULT_CFG 一致。只校验形状、不枚举：白名单留在
  // Client 的 `LANGUAGE_OPTIONS`，认不出的语言在那里回默认。
  language: vol(z.string().pattern(LANGUAGE_ID_PATTERN).default('zh-CN')),
})

/**
 * Loader 读取的**插件配置 schema**：导出名必须是 `Config`，宿主按这个名字取 schema，命名空间就是
 * 本插件在 profile 里的条目 id（`quake-alert`）。与 `QuakeAlertSettingsSchema` 是同一个对象。
 */
export const Config = QuakeAlertSettingsSchema

/**
 * 把本插件的配置接到宿主的 settings 服务上（**两代 API 的分派**）：旧宿主用
 * `settings.register(ns, schema)` 注册命名空间；新宿主 register 被移除，表单从插件导出的
 * `Config` schema 派生，自带配置页面的插件改为调用 `settings.configure({ auto: false }, ctx.fiber)`。
 * @param settingsCtx - 承载 settings 服务的子上下文（优先用它自己的 effect）。
 * @param hostCtx - 外层 Host 上下文（取 ctx.fiber，并在子上下文没有 effect 时兜底）。
 * @returns 'configure' | 'register' | 'none' | 'configure-failed' | 'register-failed'（供回归断言）
 */
export function applySettingsService(settingsCtx, hostCtx) {
  const settings = settingsCtx && settingsCtx.settings
  if (!settings) return 'none'
  const effectCall = (settingsCtx && typeof settingsCtx.effect === 'function')
    ? (fn) => settingsCtx.effect(fn)
    : ((hostCtx && typeof hostCtx.effect === 'function') ? (fn) => hostCtx.effect(fn) : null)
  if (typeof settings.configure === 'function') {
    try {
      const owner = hostCtx ? hostCtx.fiber : undefined
      if (effectCall) effectCall(() => settings.configure({ auto: false }, owner))
      else settings.configure({ auto: false }, owner)
      return 'configure'
    } catch (err) {
      try { console.warn('[dsh-quake-alert] settings.configure 调用失败（不影响插件运行）：' + String((err && err.message) || err)) } catch (e) { /* 忽略 */ }
      return 'configure-failed'
    }
  }
  if (typeof settings.register !== 'function') {
    // 两代 API 都不在：如实记一条，插件照常工作（配置退回浏览器 localStorage）。
    try {
      console.warn('[dsh-quake-alert] settings 服务既没有 configure 也没有 register：本次改用 localStorage（宿主版本与插件不匹配）')
    } catch (e) { /* 忽略 */ }
    return 'none'
  }
  try {
    settings.register(SETTINGS_NAMESPACE, QuakeAlertSettingsSchema)
    return 'register'
  } catch (err) {
    // 旧路径容错：schema 不做类型强转，settings.yaml 里一个手写的 `notify: { volume: "0.5" }`
    // （字符串）或 `tsunamiGrade: "Bogus"` 就会让 register 抛错、命名空间因此根本没注册——客户端
    // 看到 status='unavailable' 并静默退回 localStorage。捕获它并留下一条能查的日志。
    try {
      console.warn('[dsh-quake-alert] settings namespace 注册失败（settings.yaml 的 quake-alert 段可能有类型不符的值，本次改用 localStorage）：' + String((err && err.message) || err))
    } catch (e) { /* 忽略 */ }
    return 'register-failed'
  }
}

/**
 * 插件入口：把配置接到宿主的 settings 服务，启动各源（轮询器 / WebSocket 常连），并注册
 * /areas、/feed、/stream 三条只读路由。缺少 settings 或 webServer 服务时插件照常工作
 * （localStorage / 仅都道府县）。
 * @param ctx - 可获取可选 settings 与 webServer 服务的 Host 上下文。
 * @param config - 本插件的 Loader 配置（宿主按导出的 `Config` schema 解析）。Host 半边**不使用**
 *   配置值——配置是 Client 的输入，Host 只让机器级持久化生效。
 */
export function apply(ctx, config) {
  // 配置的机器级持久化：接上宿主的 settings 服务（两代 API 的分派见 applySettingsService）。
  ctx.inject(['settings'], (settingsCtx) => { applySettingsService(settingsCtx, ctx) })

  // 电文轮询器：Host 是每台机器唯一的外部请求者。idleMs：10 分钟没有任何 /feed 读取就停拉，
  // Client 侧关掉某个灾种后不再拉增量、Host 随之自然停下，不需要把 Client 的配置读到 Host 侧。
  // 每源一个实例，共用同一条 /feed 路由（`?source=` 分派），各有自己的缓冲与读取位置、互不影响；
  // 外部请求失败统一走 onPollError 落一行警告，配合 /feed?stats=1 的计数把悄悄失灵变成可见的。
  const onPollError = (err) => {
    try { console.warn('[dsh-quake-alert] 轮询失败：' + String((err && err.message) || err)) } catch (e) { /* 忽略 */ }
  }

  const pollers = {
    jma: createPoller({
      feedUrl: DEFAULT_FEED_URL,
      // 上游停更检测：判据是 feed 自身的 <updated>，不是"我们解析出多少条相关电文"——
      // 只有天气预报时也是正常的。
      feedTimeOf: jmaFeedUpdatedAt,
      feedStaleMs: JMA_STALE_MS,
      intervalMs: 60 * 1000,
      idleMs: 10 * 60 * 1000,
      onError: onPollError,
    }),
    usgs: createPoller({
      feedUrl: USGS_FEED_URL,
      parseFeed: parseUsgsEntries,
      singleStage: true,
      // 修订版要能进缓冲（见 poller.js 的 dedupeKeyOf 说明）：USGS 对同一场地震只换
      // properties.updated，震级复核往往上修；按 id 去重会让上修永远不再提醒。
      dedupeKeyOf: (e) => String(e && e.id) + '@' + String(e && e.updated),
      // 首次启动回看：USGS 是 **24 小时窗口摘要**，只按"进程启动之后"判定的话，一条 6 小时前
      // 发生、updated 不再变化的 M7 会在重启 Host 后被永久错过。
      backfillMs: 6 * 60 * 60 * 1000,
      // 上游停更检测：USGS 摘要 feed 每 5 分钟重新生成（metadata.generated），超过 30 分钟
      // 说明上游停更或拿到的是缓存。
      feedTimeOf: usgsFeedGeneratedAt,
      feedStaleMs: USGS_STALE_MS,
      intervalMs: 120 * 1000,
      idleMs: 10 * 60 * 1000,
      onError: onPollError,
    }),
    noaa: createPoller({
      feedUrl: NOAA_FEED_URL,
      parseFeed: parseNoaaEntries,
      // 首次启动回看：NOAA 的 PHEBAtom.xml 是「当前生效事件列表」，一条仍在生效的海啸警报发报
      // 时刻可能是几小时前；只认启动之后的电文会让刚装插件 / 刚重启 Host 的用户错过它。
      backfillMs: 24 * 60 * 60 * 1000,
      intervalMs: 5 * 60 * 1000,
      idleMs: 30 * 60 * 1000,
      onError: onPollError,
    }),
    // nmc.cn：中央气象台的「预警信号」列表，一次返回**当前全部生效预警**，Host 侧拆成本插件
    // 范围内的两条灾种（暴雨 / 地质灾害）后逐条入缓冲，走轮询而不是 SSE（"提前数十分钟到数小时
    // 发布"的警戒级信息）。各参数的理由见 lib/nmc-source.js 头部。
    nmc_alarm: createNmcSource({ onError: onPollError }),
  }
  // 大陆源：Wolfx 的两条 **WebSocket 常连**，与上面三个轮询器**接口同形**
  // （start/stop/snapshot/stats/markRead），所以直接并进同一个 pollers 表。WS 不可达时的 HTTP
  // 轮询降级通道在 lib/wolfx-source.js 的 pollRest（Host 直取 `https://api.wolfx.jp/<id>.json`
  // 快照），不是这条路由——路由只是把缓冲交给页面。单独留引用是因为 SSE 路由要用 subscribe()。
  const wolfxSources = {
    [CENC_EEW_ID]: createWolfxSource({ id: CENC_EEW_ID, onError: onPollError }),
    [CENC_EQLIST_ID]: createWolfxSource({ id: CENC_EQLIST_ID, onError: onPollError }),
  }
  Object.assign(pollers, wolfxSources)
  ctx.effect(() => {
    for (const p of Object.values(pollers)) p.start()
    return () => { for (const p of Object.values(pollers)) p.stop() }
  }, 'dsh-quake-alert: feed pollers')

  // 市区町村表体积大（全国约 1900 条），不内联进 client bundle，改由 Host 提供只读 JSON；
  // 同一份响应里必须带上**河川予報区域表**：指定河川洪水予報的电文区域是河川名与 12 位区域码，
  // Client 要先经这张表映射到市町村才能与用户的关注地区比对，缺了它所有洪水电文都会被放行。
  ctx.inject(['webServer'], (webCtx) => {
    webCtx.effect(() => webCtx.webServer.register({
      kind: 'exact',
      path: AREAS_PATH,
      handler: (req, res) => {
        if (isCrossSite(req)) return denyCrossSite(res)
        // writeHead / end 也放在 try 内：客户端中途断开时 end() 会抛 ERR_STREAM_WRITE_AFTER_END，
        // 落在 try 外就会抛回 webServer 的 handler；捕获之后 `headersSent` 判断才有意义。
        try {
          const url = new URL((req && req.url) || '/', 'http://127.0.0.1')
          // 全球城市表**按国家分包**：展开某国时才拉那一包（`?country=US`）；不带参数时给国家清单
          // （约 160 条），供国家 / 地区选择器渲染。
          const rawCountry = url.searchParams.get('country')
          const country = rawCountry === null ? '' : rawCountry.trim().toUpperCase()
          if (country) {
            const cities = Object.prototype.hasOwnProperty.call(WORLD_CITIES_BY_COUNTRY, country)
              ? WORLD_CITIES_BY_COUNTRY[country] : null
            if (!cities) {
              // 认不出的国家码 → 404，**不**回空数组：那会让"这个国家没被收录"与"客户端把国家码
              // 写错了"在界面上长得一模一样。
              res.writeHead(404, { 'content-type': 'application/json; charset=utf-8' })
              res.end(JSON.stringify({ error: 'unknown country' }))
              return
            }
            res.writeHead(200, {
              'content-type': 'application/json; charset=utf-8',
              'cache-control': 'no-cache',
            })
            res.end(JSON.stringify({ country, cities }))
            return
          }
          // cnAreas：中国行政区划表（省 34 → 地级 384 + 坐标），供设置页的三级级联。
          // worldCountries：国家清单（约 160 条），城市本体按 `?country=` 分包另取。
          const body = JSON.stringify({
            prefectures: CITIES_BY_PREF, riverAreas: RIVER_AREAS, cnAreas: CN_AREAS,
            worldCountries: WORLD_COUNTRIES,
          })
          res.writeHead(200, {
            'content-type': 'application/json; charset=utf-8',
            // 不用长缓存：两张表都会随插件升级变化，长缓存会让修复延迟一天才生效。
            'cache-control': 'no-cache',
          })
          res.end(body)
        } catch (err) {
          // 错误细节只进日志，不回给调用方（这条路由没有鉴权）
          try { console.warn('[dsh-quake-alert] /areas 响应失败：' + String((err && err.message) || err)) } catch (e) {}
          if (!res.headersSent) {
            res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' })
            res.end(JSON.stringify({ error: 'internal error' }))
          } else { try { res.end() } catch (e) { /* 连接已断 */ } }
        }
      },
    }), 'dsh-quake-alert: /areas route')

    // 电文增量：Client 每 15s 拉一次本地只读路由（回环，无外部请求），返回 seq > since 的条目
    // （含详情电文原文）；解析仍在 Client 侧。两种特殊语义：`since=tail` = 首次只要当前位置不要
    // 历史；`since > 当前读取位置` = Host 重启过，返回 reset 且按 0 补齐缓冲；`since` 缺失或非法时
    // 一律按 tail 处理，**不**按 0（= 把整个缓冲吐出去）。
    webCtx.effect(() => webCtx.webServer.register({
      kind: 'exact',
      path: FEED_PATH,
      handler: (req, res) => {
        if (isCrossSite(req)) return denyCrossSite(res)
        try {
          const url = new URL((req && req.url) || '/', 'http://127.0.0.1')
          // 源分派：缺失时才默认 jma。用自有属性查找，避免 ?source=constructor 命中原型链。
          // **显式给了但认不出 → 400，不静默退回 jma**：静默兜底会让 Client 拿到另一个源的原文
          // 去解析，解析必然失败、而读取位置仍在推进，那些条目被永久跳过。
          const rawSource = url.searchParams.get('source')
          const wanted = rawSource === null ? 'jma' : rawSource.trim()
          if (!Object.prototype.hasOwnProperty.call(pollers, wanted)) {
            res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' })
            res.end(JSON.stringify({ error: 'unknown source' }))
            return
          }
          const source = wanted
          const poller = pollers[source]
          const rawSince = url.searchParams.get('since')
          // Number('') 与 Number('   ') 都是 0——空串不是合法的读取位置，必须显式排掉，
          // 否则 `?since=` 会被当成"从 0 取"，等于把整个缓冲吐出去。
          const trimmed = rawSince === null ? null : rawSince.trim()
          const parsed = (trimmed === null || trimmed === '') ? NaN : Number(trimmed)
          // 合法的读取位置 = 有限且非负的数字；'tail'、缺失、空串、'abc'、'1e999'、负数都走 tail
          const sinceOk = Number.isFinite(parsed) && parsed >= 0
          const tail = rawSince === 'tail' || !sinceOk
          const payload = poller.snapshot(sinceOk ? parsed : 0, { tail })
          poller.markRead() // 有人在用 → 按需轮询继续
          payload.source = source
          capFeedEntries(payload)
          if (url.searchParams.get('stats') === '1') payload.stats = poller.stats()
          // 先序列化再发头：序列化失败时头还没发出去，能回一个真正的 500；writeHead / end 也在
          // try 内——客户端中途断开时 end() 会抛 ERR_STREAM_WRITE_AFTER_END。
          const body = JSON.stringify(payload)
          res.writeHead(200, {
            'content-type': 'application/json; charset=utf-8',
            'cache-control': 'no-store',
          })
          res.end(body)
        } catch (err) {
          try { console.warn('[dsh-quake-alert] /feed 处理失败：' + String((err && err.message) || err)) } catch (e) {}
          if (!res.headersSent) {
            res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' })
            res.end(JSON.stringify({ error: 'internal error' }))
          } else { try { res.end() } catch (e) { /* 连接已断 */ } }
        }
      },
    }), 'dsh-quake-alert: /feed route')

    // ---- 大陆源的 SSE 推送 ----
    // /feed 那条轮询路由**保留**——它既是降级通道，也是 SSE 不可用时的兜底。handler 实例提到
    // effect 外面，好让清理时能**先断掉在飞的流**再注销路由。
    const streamHandler = createStreamHandler({ sources: wolfxSources, isCrossSite, denyCrossSite })
    webCtx.effect(() => {
      // webServer 服务重挂时这个回调可能重跑，而"重复注册同一条路由即抛"（宿主的行为），不能让它
      // 把整个 apply 抛崩。失败只告警：路由不在时 Client 会自动降级到 /feed 轮询。
      let disposeRoute = null
      try {
        disposeRoute = webCtx.webServer.register({
          kind: 'exact',
          path: STREAM_PATH,
          handler: streamHandler,
        })
      } catch (err) {
        try { console.warn('[dsh-quake-alert] /stream 路由注册失败（可能已注册过）：' + String((err && err.message) || err)) } catch (e) { /* 忽略 */ }
      }
      return () => {
        try { streamHandler.closeAll() } catch (err) { /* 已关 */ }
        try { if (typeof disposeRoute === 'function') disposeRoute() } catch (err) { /* 已注销 */ }
      }
    }, 'dsh-quake-alert: /stream route')
  })
}
