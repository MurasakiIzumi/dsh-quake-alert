// Host half of dsh-quake-alert.
//
// M1 时 Host 只是一只空壳：实时链路、解析、匹配、通知、配置存储全在 Client。
// M2（0.2.0）起 Host 承担两件事：
//   1) 注册 settings namespace `quake-alert`（schemastery schema）——配置由 DSH 的
//      settings 服务持久化到机器的 settings.yaml，Client 经 `ctx.settingsScope` 读写。
//      M1 的 localStorage 保留为「无 settings 提供方 / 非 loopback 页面」时的回退与镜像。
//   2) 向 Client 提供市区町村静态表（体积大，不塞进 client bundle）。
// 0.3.0（b）起再加一件：
//   3) 轮询気象庁的电文 feed 并把增量交给 Client（见 poller.js）。放 Host 是为了让
//      每台机器只有一个外部请求者——気象庁明文要求不得重复获取同一文件。
//
// 注意：settings 是**可选**依赖——服务不存在时插件必须照常工作（回退 localStorage），
// 因此用 `ctx.inject(['settings'], cb)` 而不是模块级 `export const inject`。

import z from '@deepseek-ai/schemastery'
import { CITIES_BY_PREF } from './data/cities.js'
import { RIVER_AREAS } from './data/river-areas.js'
import { createPoller, DEFAULT_FEED_URL } from './poller.js'
import { USGS_FEED_URL, NOAA_FEED_URL, parseUsgsEntries, parseNoaaEntries, usgsFeedGeneratedAt } from './global-sources.js'
import { createWolfxSource, CENC_EEW_ID, CENC_EQLIST_ID } from './wolfx-source.js'
import { CN_AREAS } from './data/cn-areas.js'

/**
 * JMA feed 自身的更新时间（根元素的 `<updated>`，带偏移的 ISO）。
 * 用途与 usgsFeedGeneratedAt 相同：判断"上游还在更新吗"，而不是"我们收到多少条"。
 */
function jmaFeedUpdatedAt(xml) {
  const m = /<updated>([^<]*)<\/updated>/.exec(String(xml || ''))
  return m ? Date.parse(m[1]) : NaN
}

export const name = 'dsh-quake-alert'

/** Client 拉取市区町村表的只读路由。 */
export const AREAS_PATH = '/dsh-quake-alert/areas'

/** Client 拉取 JMA 电文增量的只读路由（`?since=<游标>`）。 */
export const FEED_PATH = '/dsh-quake-alert/feed'

/**
 * 大陆源的 **SSE 推送**路由（`?source=cenc_eew|cenc_eqlist`）。
 *
 * 与 /feed 的关系：/feed 是"轮询取增量"，这条是"Host 主动推"。两个都留着，不是重复——
 * ① 延迟：EEW 的价值在秒级，15 秒一次的轮询等于把预警变成事后通知；SSE 是 ≈0 延迟。
 * ② 降级：某些网络下 WS 会被中间设备重置而普通 HTTPS 仍然通（DESIGN 11.5），
 *    届时 Client 只要不订阅这条、改回轮询 /feed 就行——**降级通道天然存在，不需要另写一份**。 
 */
export const STREAM_PATH = '/dsh-quake-alert/stream'

/** SSE 心跳注释帧的间隔。防的是中间设备（代理 / 反代）把闲置的长连接掐掉。 */
export const SSE_KEEPALIVE_MS = 15 * 1000

/** Settings namespace owned by this plugin（小写 + 连字符，符合 settings 服务文法）. */
export const SETTINGS_NAMESPACE = 'quake-alert'

/** 震度档位（P2PQuake scale 数值），与 Client 侧 SCALE_OPTIONS 对齐. */
export const SCALE_VALUES = [10, 20, 30, 40, 45, 50, 55, 60, 70]

/** 海啸等级，与 Client 侧 TSUNAMI_OPTIONS 对齐. */
export const TSUNAMI_GRADES = ['Watch', 'Warning', 'MajorWarning']

/**
 * `/feed` 单次最多返回的条目数。正常增量是 0～几条；这个上限只用来兜住"有人拿 since=0
 * 把整个环缓冲一次要走"的情况（本路由无来源校验，不能当成无成本的大响应源）。
 */
export const MAX_FEED_ENTRIES = 50

/**
 * 截断过大的增量响应，并标记还有后续。Client 见到 `more` 会改用**最后一条实际返回的 seq**
 * 推进游标（而不是直接跳到 cursor），下一轮继续补齐，所以截断不会造成漏报。
 * 抽成纯函数是为了能单测——这条路由没有来源校验，这里是唯一限制"一次能拿走多少"的地方。
 *
 * @param {{ entries?: unknown[] }} payload
 * @param {number} [max]
 */
export function capFeedEntries(payload, max) {
  const limit = max === undefined ? MAX_FEED_ENTRIES : max
  if (!payload || !Array.isArray(payload.entries) || payload.entries.length <= limit) return payload
  payload.entries = payload.entries.slice(0, limit)
  payload.more = true
  return payload
}

/**
 * 跨站 GET 防护（0.4.1，0.5.0 起提到模块级以便直接测试）。
 *
 * 这几条路由没有来源校验（dsh 的 webServer 本身不校验，host 可配 0.0.0.0），而 `/feed` 有一个
 * **不需要读响应就能触发**的副作用：markRead() 会让按需轮询继续。任意网页只要放一个
 * `<img src="http://<host>:3080/dsh-quake-alert/feed?source=jma">`，就能把各源的轮询
 * 永久压住，绕过"每台机器只有一个外部请求者"这条设计前提——对気象庁是封 IP 风险，
 * 一旦被封就是全量漏报；`/stream` 更直接，它会让 Host 保持与 Wolfx 的长连接。
 *
 * 浏览器会为跨站请求带上 `sec-fetch-site: cross-site`（Chrome 76+ / Firefox 90+ / Safari 16.4+），
 * 而 DSH 页面自身的同源 fetch 是 `same-origin`。只在**明确标记**为跨站时拒绝：没有这个头
 * （老浏览器、curl、测试注入的假 req）一律照常。
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
 * 把一个事件序列化成 SSE 帧（**纯函数**，便于单测）。
 *
 * SSE 规范要求数据的每一行都带 `data: ` 前缀——JSON.stringify 的结果不含裸换行，所以实际只有
 * 一行，但这里仍按行遍历：将来载荷换成多行文本（例如原始电文）时，不做这一步会静默坏掉
 * （第二行起会被当作新字段解析）。帧以空行结束。
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
 * `/stream` 的处理函数工厂（**抽出来是为了能单测**）。
 *
 * 直接内联在 apply 里的话，"订阅 → 首帧 sync → 补发环缓冲 → 实况推送 → 断开清理"这条链路
 * 就只能靠真连一次 Wolfx 来验证，而测试不该联网。这里把**依赖（源表、跨站判定、定时器）**
 * 全部注入，测试用一个假源即可覆盖全部分支。
 *
 * @param {object} opts
 * @param {Record<string, object>} opts.sources 源表（需有 snapshot / subscribe / markRead）
 * @param {(req: object) => boolean} opts.isCrossSite
 * @param {(res: object) => void} opts.denyCrossSite
 * @param {number} [opts.keepAliveMs]
 * @param {Function} [opts.setInterval]
 * @param {Function} [opts.clearInterval]
 */
export function createStreamHandler(opts) {
  const sources = opts.sources || {}
  // 默认就用真实实现（而不是 `() => false`）：忘了注入时也不该静默丢掉跨站防护，
  // 这条路由会让 Host 保持与 Wolfx 的长连接。
  const isCrossSiteFn = opts.isCrossSite || isCrossSite
  const denyCrossSiteFn = opts.denyCrossSite || denyCrossSite
  const keepAliveMs = opts.keepAliveMs === undefined ? SSE_KEEPALIVE_MS : opts.keepAliveMs
  const setIntervalFn = opts.setInterval || ((fn, ms) => setInterval(fn, ms))
  const clearIntervalFn = opts.clearInterval || ((t) => clearInterval(t))

  return function streamHandler(req, res) {
    if (isCrossSiteFn(req)) return denyCrossSiteFn(res)
    let unsub = null
    let keepAlive = null
    let closed = false
    const cleanup = () => {
      if (closed) return
      closed = true
      if (unsub) { try { unsub() } catch (e) { /* 已移除 */ } unsub = null }
      if (keepAlive) { clearIntervalFn(keepAlive); keepAlive = null }
    }
    /** 写一帧；客户端已断开时 write 会抛，必须吞掉——否则异常会落回 webServer 的 handler。 */
    const write = (event, data, id) => {
      if (closed || res.writableEnded) return
      try { res.write(sseFrame(event, data, id)) } catch (err) { cleanup() }
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
      // 否则流式响应会被缓冲成"攒够一批才发"，延迟优化白做。
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
      })
      // 游标来源的优先级：Last-Event-ID（浏览器重连自动带，最准）> `?since=`（页面首次建立连接时
      // 带上 localStorage 里持久化的游标）> tail（什么都没有 → 只对齐位置不重放历史，
      // 免得把几小时前的旧警报当新闻刷屏）。
      //
      // 注意 `Number(null)` 与 `Number('')` **都是 0** —— 缺失的 since 会被误当成"从 0 取"，
      // 等于一次吐出整个环缓冲。必须先把空值显式排掉再看数字（/feed 那条路由踩过同一个坑）。
      const lastEventId = Number((req.headers && req.headers['last-event-id']) || 0)
      const rawSince = url.searchParams.get('since')
      const trimmedSince = rawSince === null ? null : String(rawSince).trim()
      const sinceParam = (trimmedSince === null || trimmedSince === '') ? null : Number(trimmedSince)
      const useSince = (Number.isFinite(lastEventId) && lastEventId > 0)
        ? lastEventId
        : (sinceParam !== null && Number.isFinite(sinceParam) && sinceParam >= 0 ? sinceParam : null)
      const snap = useSince === null ? src.snapshot(0, { tail: true }) : src.snapshot(useSince, {})
      // 首帧把游标与缓冲状态告诉 Client：诊断要用，也让它判断要不要改走 /feed 补齐。
      write('sync', {
        source: wanted, cursor: snap.cursor, reset: snap.reset,
        truncated: snap.truncated, frozen: snap.frozen, replayed: snap.entries.length,
      })
      // 断线补齐：中间那段推送靠环缓冲补回。没有它就会出现"明明发生过预警但历史里没有"。
      for (const e of snap.entries) write('entry', e, e.seq)
      src.markRead()
      unsub = src.subscribe((entry) => write('entry', entry, entry.seq))
      keepAlive = setIntervalFn(() => {
        if (closed || res.writableEnded) return
        try { res.write(': ka\n\n') } catch (err) { cleanup() }
      }, keepAliveMs)
      if (keepAlive && typeof keepAlive.unref === 'function') keepAlive.unref()
      if (typeof res.on === 'function') {
        res.on('close', cleanup)
        res.on('error', cleanup)
      }
    } catch (err) {
      cleanup()
      try { console.warn('[dsh-quake-alert] /stream 处理失败：' + String((err && err.message) || err)) } catch (e) {}
      if (!res.headersSent) {
        res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify({ error: 'internal error' }))
      } else { try { res.end() } catch (e) { /* 连接已断 */ } }
    }
  }
}

/**
 * 持久化配置的 schema。
 *
 * 字段与 Client 侧 DEFAULT_CFG 一一对应：schema 默认值即「用户从未改过」时的解析值，
 * 用户层只记录真正被改写的字段。这里只做类型/范围校验；白名单过滤（例如只保留 47 个
 * 真实县名）仍在 Client 侧做，因为那是用户可见的纠错行为，而不是存储契约。
 */
export const QuakeAlertSettingsSchema = z.object({
  source: z.union(['prod', 'sandbox']).default('prod'),
  // 大陆源的链路选择（0.5.0）：auto = SSE 优先、走不通自动降级；poll = 用户强制轮询。
  // 同样必须与 client/src/02-storage.js 的 normalizeCfg 同步（有测试守着）。
  cnTransport: z.union(['auto', 'poll']).default('auto'),
  watch: z.object({
    // 空 = 关注全日本；两级粒度：都道府县 +（可选）市区町村
    prefectures: z.array(z.string()).default([]),
    cities: z.array(z.string()).default([]),
    // 全球关注点（0.4.0）：坐标 + 半径。与日本行政区模式并存、互不影响。
    // 这里只做类型与范围校验；"同一个点被重复添加"之类的规整由 Client 的 normalizePlaces 负责。
    places: z.array(z.object({
      name: z.string().default(''),
      lat: z.number().min(-90).max(90).default(0),
      lon: z.number().min(-180).max(180).default(0),
      radiusKm: z.number().min(1).max(2000).default(300),
    })).default([]),
  }),
  disasters: z.object({
    earthquake: z.boolean().default(true),
    tsunami: z.boolean().default(true),
    // 0.3.0：气象灾害（泥石流 / 洪水 / 大雨 / 高潮…），固定警戒レベル4 以上播报
    weather: z.boolean().default(true),
  }),
  thresholds: z.object({
    quakeScale: z.number().min(0).max(70).default(40),
    eewScale: z.number().min(0).max(70).default(45),
    tsunamiGrade: z.union(TSUNAMI_GRADES).default('Watch'),
    // 全球源的最低震级（0.4.0）：EMSC / USGS 给的是震级，与日本的震度不可换算
    globalMagnitude: z.number().min(0).max(10).default(4.5),
    // 大陆速报（cenc_eqlist，0.5.0）的独立震级门槛。与 globalMagnitude 分开是设计要求
    // （DESIGN 8.4）：速报覆盖低到 M2.5，用预警门槛播报会被小震打扰。
    // 注意：这里必须与 client/src/02-storage.js 的 normalizeCfg 同步新增——
    // 测试「Host schema 默认值与 Client DEFAULT_CFG 完全一致」就是这对字段的守卫。
    cnReportMagnitude: z.number().min(0).max(10).default(4.5),
  }),
  notify: z.object({
    sound: z.boolean().default(true),
    system: z.boolean().default(true),
    volume: z.number().min(0).max(1).default(0.7),
  }),
  dedupe: z.object({
    windowMinutes: z.number().min(1).max(1440).default(10),
  }),
  quietHours: z.object({
    enabled: z.boolean().default(false),
    start: z.string().default('23:00'),
    end: z.string().default('07:00'),
    breakForSevere: z.boolean().default(true),
  }),
})

/**
 * Register the durable settings namespace when a settings provider is composed,
 * and serve the municipality table to the browser half.
 * Without either service the plugin keeps working (localStorage / prefecture-only).
 *
 * @param ctx - Host context that may acquire the optional settings and webServer services.
 */
export function apply(ctx) {
  ctx.inject(['settings'], (settingsCtx) => {
    settingsCtx.settings.register(SETTINGS_NAMESPACE, QuakeAlertSettingsSchema)
  })

  // 电文轮询器（0.3.0-b）：Host 是每台机器唯一的外部请求者——多标签页 / 多窗口不会
  // 放大对気象庁的请求，满足官方「一度取得したファイルを再度取得しない」的要求。
  // idleMs：10 分钟没有任何 /feed 读取就停拉。Client 侧关闭「气象灾害」后不再拉增量，
  // Host 随之自然停下——不需要把 Client 的配置读到 Host 侧。
  //
  // 0.4.0 起是**每源一个实例**，共用同一条 /feed 路由（`?source=` 分派）：
  //   · jma  —— 気象庁 防災情報XML，两级（Atom → 详情电文），每分钟轮询
  //   · usgs —— 全球地震 GeoJSON，**单级**（一次请求拿到全部字段），每 2 分钟轮询
  //   · noaa —— 太平洋海啸警报中心的 CAP 电文，两级（事件列表 → CAP），每 5 分钟轮询
  //   · cenc_eew / cenc_eqlist（0.5.0）—— Wolfx 的大陆源，**WS 常连**（不是轮询，见 wolfx-source.js）
  // 频率取「源更新周期 / 使用条款 / 我们的需求」三者最小值；每个源都有自己的环缓冲与游标，
  // 互不影响（一个源被限流不会拖住另一个）。
  // 统一的错误出口（0.4.1）：此前三个轮询器都没传 onError，而 poller 的默认实现是空函数，
  // 于是外部请求失败连一行日志都没有——"上游挂了"和"上游没有新闻"在日志里完全一样。
  // 至少让它落一行警告，配合 /feed?stats=1 的计数把静默失效变成可见的。
  const onPollError = (err) => {
    try { console.warn('[dsh-quake-alert] 轮询失败：' + String((err && err.message) || err)) } catch (e) { /* 忽略 */ }
  }

  const pollers = {
    jma: createPoller({
      feedUrl: DEFAULT_FEED_URL,
      // 上游停更检测（0.4.1）：feed 每分钟更新，超过 3 小时没有更新说明上游出问题了。
      // 注意判据是 feed 自身的 <updated>，不是"我们解析出多少条相关电文"——只有天气预报时也正常。
      feedTimeOf: jmaFeedUpdatedAt,
      feedStaleMs: 3 * 60 * 60 * 1000,
      intervalMs: 60 * 1000,
      idleMs: 10 * 60 * 1000,
      onError: onPollError,
    }),
    usgs: createPoller({
      feedUrl: USGS_FEED_URL,
      parseFeed: parseUsgsEntries,
      singleStage: true,
      // 修订版要能进缓冲（见 poller.js 的 dedupeKeyOf 说明）：USGS 对同一场地震只换
      // properties.updated，震级复核往往上修。按 id 去重会让上修永远不再提醒——那是漏报。
      dedupeKeyOf: (e) => String(e && e.id) + '@' + String(e && e.updated),
      // 冷启动回看（0.4.1）：USGS 是 **24 小时窗口摘要**，不是"最近入電"。一条 6 小时前发生的
      // M7 仍在列表里，且它的 updated 不会随时间流逝而变化——只按"进程启动之后"判定的话，
      // 用户重启 Host 后就永久错过它（叠加 entry 去重，后续轮询也不会再给）。回看 6 小时：
      // 没配全球关注点的用户会在 Client 侧被 watchlessPoint 直接丢弃（不会刷屏），
      // 配了关注点的用户最多补几条真正命中半径的地震。
      backfillMs: 6 * 60 * 60 * 1000,
      // 上游停更检测：USGS 摘要 feed 每 5 分钟重新生成（metadata.generated），超过 30 分钟
      // 说明上游停更或拿到的是缓存——"链路在跑但数据是旧的"必须能被看见。
      feedTimeOf: usgsFeedGeneratedAt,
      feedStaleMs: 30 * 60 * 1000,
      intervalMs: 120 * 1000,
      idleMs: 10 * 60 * 1000,
      onError: onPollError,
    }),
    noaa: createPoller({
      feedUrl: NOAA_FEED_URL,
      parseFeed: parseNoaaEntries,
      // NOAA 的 PHEBAtom.xml 是「当前生效事件列表」：一条仍在生效的海啸警报，发报时刻可能是
      // 几小时前。冷启动只认启动之后的电文，会让刚装插件 / 刚重启 Host 的用户错过正在生效的
      // 警报，而且要等下一版报文（新 URL）才自愈。海啸稀少，回看 24 小时很便宜。
      backfillMs: 24 * 60 * 60 * 1000,
      intervalMs: 5 * 60 * 1000,
      idleMs: 30 * 60 * 1000,
      onError: onPollError,
    }),
  }
  // 大陆源（0.5.0）：Wolfx 的两条 **WebSocket 常连**。它们与上面三个轮询器**接口同形**
  // （start/stop/snapshot/stats/markRead），所以直接并进同一个 pollers 表——`/feed?source=cenc_eew`
  // 因此开箱可用，而那条路径正好就是 WS 不可达时的 HTTP 轮询降级通道。
  // 单独留一个引用，是因为 SSE 路由要用 subscribe()（轮询器没有这个概念）。
  // 频率与配额：Wolfx 限约 5–7 条连接 / IP，这里常驻 2 条，离上限很远。
  const wolfxSources = {
    [CENC_EEW_ID]: createWolfxSource({ id: CENC_EEW_ID, onError: onPollError }),
    [CENC_EQLIST_ID]: createWolfxSource({ id: CENC_EQLIST_ID, onError: onPollError }),
  }
  Object.assign(pollers, wolfxSources)
  ctx.effect(() => {
    for (const p of Object.values(pollers)) p.start()
    return () => { for (const p of Object.values(pollers)) p.stop() }
  }, 'dsh-quake-alert: feed pollers')

  // 市区町村表体积大（全国约 1900 条），不内联进 client bundle，改由 Host 提供只读 JSON。
  // 0.3.2：同一份响应里必须带上**河川予報区域表**。指定河川洪水予報的电文区域是河川名与
  // 12 位区域码，Client 要先经这张表映射到市町村才能与用户的关注地区比对；此前表只生成、
  // 从未下发，Client 侧永远为空 → 所有洪水电文都被判成"归不到市町村"而放行，关注任何
  // 地区的用户都会收到与自己无关的县的水害警报，市级收窄也完全失效。
  ctx.inject(['webServer'], (webCtx) => {
    webCtx.effect(() => webCtx.webServer.register({
      kind: 'exact',
      path: AREAS_PATH,
      handler: (req, res) => {
        if (isCrossSite(req)) return denyCrossSite(res)
        // writeHead / end 也放在 try 内（0.4.2）：客户端中途断开时 end() 会抛
        // ERR_STREAM_WRITE_AFTER_END，落在 try 外就会直接抛回 webServer 的 handler。
        // 兜住之后 `headersSent` 判断才有意义（已发头就只能结束，不能再写 500）。
        try {
          // cnAreas（0.5.0）：中国行政区划表（省 34 → 地级 384 + 坐标），供设置页的三级级联。
          // 与市区町村表同一理由不内联进 client bundle（约 21KB），也同一份响应下发——
          // 它们都只在页面加载时取一次。
          const body = JSON.stringify({ prefectures: CITIES_BY_PREF, riverAreas: RIVER_AREAS, cnAreas: CN_AREAS })
          res.writeHead(200, {
            'content-type': 'application/json; charset=utf-8',
            // 不用长缓存：两张表都会随插件升级变化（补条目 / 改写法），长缓存会让修复延迟
            // 一天才生效。单次响应约 80KB，且只在页面加载时拉一次，回环开销可忽略。
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

    // 电文增量：Client 每 15s 拉一次本地只读路由（回环，无外部请求）。
    // 返回 seq > since 的条目（含详情电文原文）；解析仍在 Client 侧。
    // 两种特殊语义（0.3.2）：`since=tail` = 首次只要当前位置不要历史；`since > 当前游标`
    // = Host 重启过，返回 reset 且按 0 补齐缓冲（否则 Client 会永远收不到增量）。
    // 另外：`since` 缺失或非法时一律按 tail 处理，**不**按 0（= 把整个环缓冲吐出去）。
    // 这条路由没有来源校验，所以把"一次能拿走多少"卡死在 MAX_FEED_ENTRIES，避免被当成
    // 无需鉴权的放大面；跨站 GET 由上面的 isCrossSite 拒绝（它的 markRead 副作用不需要读响应）。
    webCtx.effect(() => webCtx.webServer.register({
      kind: 'exact',
      path: FEED_PATH,
      handler: (req, res) => {
        if (isCrossSite(req)) return denyCrossSite(res)
        try {
          const url = new URL((req && req.url) || '/', 'http://127.0.0.1')
          // 源分派（0.4.0）：缺失时才默认 jma（保持与旧版 Client 的兼容）。用自有属性查找，
          // 避免 ?source=constructor 命中原型链后把 undefined 当 poller 用。
          // **显式给了但认不出 → 400，不静默退回 jma**（0.4.1）：静默兜底会让 Client
          // （例如把 source 写错大小写、或 Client 比 Host 新）拿到另一个源的原文去解析，
          // 解析必然失败、而游标仍在推进——那些条目被永久跳过，表面却一切正常。
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
          // Number('') 与 Number('   ') 都是 0——空串不是合法游标，必须显式排掉，
          // 否则 `?since=` 会被当成"从 0 取"，等于把整个环缓冲吐出去。
          const trimmed = rawSince === null ? null : rawSince.trim()
          const parsed = (trimmed === null || trimmed === '') ? NaN : Number(trimmed)
          // 合法游标 = 有限且非负的数字；'tail'、缺失、空串、'abc'、'1e999'、负数都走 tail
          const sinceOk = Number.isFinite(parsed) && parsed >= 0
          const tail = rawSince === 'tail' || !sinceOk
          const payload = poller.snapshot(sinceOk ? parsed : 0, { tail })
          poller.markRead() // 有人在用 → 按需轮询继续
          payload.source = source
          capFeedEntries(payload)
          if (url.searchParams.get('stats') === '1') payload.stats = poller.stats()
          // 先序列化再发头：序列化失败时头还没发出去，能回一个真正的 500。
          // 随后 writeHead / end 也在 try 内（0.4.2）——客户端中途断开时 end() 会抛
          // ERR_STREAM_WRITE_AFTER_END，落在 try 外就会直接抛回 webServer 的 handler。
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

    // ---- 大陆源的 SSE 推送（0.5.0）----
    // 为什么是 SSE（DESIGN 5.3 的三方案比较）：零新增依赖（Host 用原生 res.write，Client 用浏览器
    // 原生 EventSource）、延迟与长轮询相同（≈0），而且 DSH 官方的 HMR 就是这么实现的。
    // /feed 那条轮询路由**保留**——它既是降级通道，也是 SSE 不可用时的兜底。
    webCtx.effect(() => webCtx.webServer.register({
      kind: 'exact',
      path: STREAM_PATH,
      handler: createStreamHandler({ sources: wolfxSources, isCrossSite, denyCrossSite }),
    }), 'dsh-quake-alert: /stream route')
  })
}
