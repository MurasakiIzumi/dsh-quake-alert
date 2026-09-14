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
 * 持久化配置的 schema。
 *
 * 字段与 Client 侧 DEFAULT_CFG 一一对应：schema 默认值即「用户从未改过」时的解析值，
 * 用户层只记录真正被改写的字段。这里只做类型/范围校验；白名单过滤（例如只保留 47 个
 * 真实县名）仍在 Client 侧做，因为那是用户可见的纠错行为，而不是存储契约。
 */
export const QuakeAlertSettingsSchema = z.object({
  source: z.union(['prod', 'sandbox']).default('prod'),
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
  // 0.4.0 起是**三个源各一个轮询器**，共用同一条 /feed 路由（`?source=` 分派）：
  //   · jma  —— 気象庁 防災情報XML，两级（Atom → 详情电文），每分钟
  //   · usgs —— 全球地震 GeoJSON，**单级**（一次请求拿到全部字段），每 2 分钟
  //   · noaa —— 太平洋海啸警报中心的 CAP 电文，两级（事件列表 → CAP），每 5 分钟
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
    /**
     * 跨站 GET 防护（0.4.1）。
     *
     * 这两条路由没有来源校验（dsh 的 webServer 本身不校验，host 可配 0.0.0.0），而 /feed 有一个
     * **不需要读响应就能触发**的副作用：markRead() 会让按需轮询继续。任意网页只要放一个
     * `<img src="http://<host>:3080/dsh-quake-alert/feed?source=jma">`，就能把三个源的轮询
     * 永久压住，绕过"每台机器只有一个外部请求者"这条设计前提——对気象庁而言是封 IP 风险，
     * 一旦被封就是全量漏报。
     *
     * 浏览器会为跨站请求带上 `sec-fetch-site: cross-site`（Chrome 76+ / Firefox 90+ / Safari 16.4+），
     * 而 DSH 页面自身的同源 fetch 是 `same-origin`。只在**明确标记**为跨站时拒绝：没有这个头
     * （老浏览器、curl、测试注入的假 req）一律照常。
     */
    const isCrossSite = (req) => {
      const headers = (req && req.headers) || {}
      return String(headers['sec-fetch-site'] || '').toLowerCase() === 'cross-site'
    }
    const denyCrossSite = (res) => {
      res.writeHead(403, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ error: 'cross-site request rejected' }))
    }

    webCtx.effect(() => webCtx.webServer.register({
      kind: 'exact',
      path: AREAS_PATH,
      handler: (req, res) => {
        if (isCrossSite(req)) return denyCrossSite(res)
        let body = null
        try {
          body = JSON.stringify({ prefectures: CITIES_BY_PREF, riverAreas: RIVER_AREAS })
        } catch (err) {
          // 错误细节只进日志，不回给调用方（这条路由没有鉴权）
          try { console.warn('[dsh-quake-alert] /areas 序列化失败：' + String((err && err.message) || err)) } catch (e) {}
          res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' })
          res.end(JSON.stringify({ error: 'internal error' }))
          return
        }
        res.writeHead(200, {
          'content-type': 'application/json; charset=utf-8',
          // 不用长缓存：两张表都会随插件升级变化（补条目 / 改写法），长缓存会让修复延迟
          // 一天才生效。单次响应约 80KB，且只在页面加载时拉一次，回环开销可忽略。
          'cache-control': 'no-cache',
        })
        res.end(body)
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
        let body = null
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
          body = JSON.stringify(payload)
        } catch (err) {
          try { console.warn('[dsh-quake-alert] /feed 处理失败：' + String((err && err.message) || err)) } catch (e) {}
          if (!res.headersSent) {
            res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' })
            res.end(JSON.stringify({ error: 'internal error' }))
          } else { res.end() }
          return
        }
        res.writeHead(200, {
          'content-type': 'application/json; charset=utf-8',
          'cache-control': 'no-store',
        })
        res.end(body)
      },
    }), 'dsh-quake-alert: /feed route')
  })
}
