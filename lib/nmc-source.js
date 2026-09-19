// Host half · 中央气象台（nmc.cn）预警轮询源（0.5.2）
//
// 职责（与 poller.js 的 JMA 源同一层，不越界）：
//   ① 定时拉取「预警信号」列表（`GET /rest/findAlarm`，一次返回**当前全部生效预警**）
//   ② 只把**本插件范围内的灾种**（暴雨 / 地质灾害）拆成逐条 entry，其余灾种**不进缓冲**
//   ③ 达到播报门槛（橙色及以上）的条目再拉一次详情页，把正文一起交给 Client
//   ④ 这些条目的原文 / JSON 放进环缓冲，维护单调游标（由 poller.js 提供）
//
// 明确不做：判断"该不该提醒"、匹配行政区、决定文案。那是 Client 的事
// （保持"实时逻辑在 Client"的定位，也让回归测试继续在单进程里跑）。
//
// ---------------------------------------------------------------------------
// 为什么是 nmc.cn（DESIGN 4.1 已定，0.5.2 落地）
//   `nmc.cn` 是中央气象台的官方网站，预警信号由**各级气象台**发布后汇总到这里。
//   它是公开、无需 key 的 JSON 接口，且**粒度到县**——「云南省丽江市宁蒗彝族自治县气象台
//   发布地质灾害黄色预警信号」。这正是默认的那两个灾种（地质灾害 / 暴雨）唯一可用的源。
//
// ---------------------------------------------------------------------------
// 实测（2026-09-19，`samples/nmc/`）
//   · 列表：`{msg, code, data:{page:{pageNo,pageSize,count,totalPage,list:[…]}, stat}}`。
//     每条只有 5 个字段：`alertid` / `issuetime` / `title` / `url` / `pic`。
//     **没有正文、没有区划代码、没有经纬度**——所以匹配只能靠 title 里的机构名（见 8.5），
//     正文要另拉详情页。
//   · `alertid` 形如 `53072441600000_20260919030245`：前 6 位恰好是**行政区划代码**
//     （530724 = 云南省丽江市宁蒗彝族自治县），中间 8 位固定 `41600000`，后面是发布时间。
//     本版本**不用它**（用户的关注点表来自 GeoNames，两边没有共同主键，见 DESIGN 9.1），
//     但它的存在说明"层级"在这条链路上是可靠的：实测 238 条里 0 条解析不出省份。
//   · `pic` 形如 `…/alarm/p0021003.png`：`p` + 4 位灾种码 + 3 位等级码。实测
//     `0002`=暴雨、`0021`=地质灾害、`0012`=雷电、`0007`=大风、`0003`=高温、`0005`=大雾、
//     `0004`=寒潮、`0011`=道路结冰、`0015`=雷雨大风、`0000`=其它、`0010`=沙尘暴(未实测)。
//     等级 `001`=红 `002`=橙 `003`=黄 `004`=蓝。
//     **灾种与等级以 pic 的编码为准，不靠 title 的中文匹配**——`title` 是给人读的，
//     它的措辞会随上游改（"预警信号" / "预警"两种都在样本里出现过），而图标文件名是程序契约。
//   · 时间是**北京时间**的裸串 `2026/09/19 12:31`（斜杠、无秒）——与 Wolfx 的 `2026-09-18 20:50:23`
//     又不一样（DESIGN 4.5 记过这个坑：三种源三种写法）。这里当场补 `+08:00` 变成 ISO，
//     因为**冷启动判据要拿它和进程启动时刻比**，而裸串交给 Date.parse 会按本机时区解释
//     （本机若是 JST 就整整差一小时，边界上的预警会被误判成历史而永久丢弃）。
//   · 列表是**当前生效集合**，不是事件流：一条预警只在其有效期内出现，过期即从列表消失。
//     所以"新增"只能靠 alertid 集合对比，且**没有"解除"电文**（与大陆地震源同类缺口）。
//     实测 238 条覆盖约 24 小时。
//   · robots.txt 是 404（站点未声明爬虫协议）。相应地本源取最保守的姿态：单点（Host）、
//     低频（120 秒）、不重拉已取得的详情、遵守响应体上限，与 JMA / Wolfx 同一套自律标准。
//
// ---------------------------------------------------------------------------
// 为什么详情只拉橙 / 红
//   DESIGN 8.4 定「播报门槛统一定为橙色及以上，蓝 / 黄只入历史」。蓝 / 黄占样本的 94%
//   （238 条里 224 条），逐条拉 46KB 的详情页既无必要也不礼貌；而它们的 title 已经足够
//   作为历史条目与诊断信息。橙 / 红才是会响铃的那一档，正文（影响乡镇、防御指引）对
//   收到提醒的人有实际价值。

import { createPoller } from './poller.js'

/** 预警列表端点。`pageSize` 取 500 是实测的上限（一次给完当前全部生效预警，实测 238 条）。 */
export const NMC_LIST_URL = 'https://www.nmc.cn/rest/findAlarm?pageNo=1&pageSize=500'

/** 详情页前缀：`<alertid>.html`，正文在 `#alarmtext` 里。 */
export const NMC_DETAIL_BASE = 'https://www.nmc.cn/publish/alarm/'

/**
 * 本插件接的灾种（DESIGN 4.1 的表里只有这两行）。
 * 键是 `pic` 里的 4 位灾种码经 `Number()` 后的值。**不接的灾种不进缓冲**——列表一次给全部
 * 预警，若原样转发，用户的历史会被雷电 / 大风 / 高温刷满（实测它们占 76%）。
 */
export const NMC_KINDS = { 2: 'rainstorm', 21: 'geology' }

/** 等级码 → 等级名。 */
export const NMC_LEVELS = { 1: 'red', 2: 'orange', 3: 'yellow', 4: 'blue' }

/** 等级序（越大越重），用于播报门槛与"拉不拉详情"。 */
export const NMC_LEVEL_RANK = { red: 4, orange: 3, yellow: 2, blue: 1 }

/** 拉详情的门槛：橙色（3）及以上。理由见文件头。 */
export const NMC_DETAIL_MIN_RANK = 3

/**
 * 轮询间隔。取 120 秒而不是 JMA 的 60 秒：
 * 气象预警是"提前数十分钟到数小时发布"的警戒级信息（DESIGN 5.2 对同一类信息的定性），
 * 两分钟的延迟对时效没有影响，而请求量减半——这个站点没有开放 API 声明，
 * 自律标准应当比 JMA（有明确的更新周期）更保守。
 */
export const NMC_INTERVAL_MS = 120 * 1000

/** 冷启动回看：列表是"当前生效集合"，启动时列表里已有 24 小时内的预警。 */
export const NMC_BACKFILL_MS = 30 * 60 * 1000

/**
 * 上游停更阈值：列表里**最新一条的发布时间**距今超过它即判 `stale`。
 *
 * 判据用 issuetime 而不是"我们收到多少条"：全国范围的预警是连续不断的
 * （实测 238 条覆盖约 24 小时、最旧的也在 12 小时前），所以"3 小时没有任何新预警"
 * 只可能是上游停更或我们拿到了缓存——而"这几小时确实没有暴雨"不会让它成立。
 * 实测（2026-09-19，40 分钟窗口 / 每 60 秒一采样）：新增 11 条，**相邻两次新增的最长间隔
 * 只有 10 分钟**，所以 3 小时有近 20 倍余量；同时它又足够短，半天之内就能被发现。
 * （同一个窗口还量到"发布 → 出现在列表里"的滞后最大 19.5 分钟，那是冷启动回看取 30 分钟的依据。）
 */
export const NMC_STALE_MS = 3 * 60 * 60 * 1000

/**
 * 北京时间裸串：实测是 `2026/09/19 12:31`（**斜杠**分隔、无秒，月日时都补零）。
 * 连字符写法一并容忍：同一个站点不同接口给的时间格式并不统一（`rest/real/…` 是另一种），
 * 而认不出的代价是冷启动时把这条预警当历史丢掉——多认一种写法不会有任何坏处。
 */
const NMC_TIME_RE = /^(\d{4})[/-](\d{1,2})[/-](\d{1,2})[ T](\d{1,2}):(\d{2})(?::(\d{2}))?$/

const pad2 = (s) => String(s).padStart(2, '0')

/**
 * 列表里的裸北京时间 → 带 `+08:00` 的 ISO 8601；认不出时返回空串（**不猜**）。
 *
 * 返回空串的后果被刻意限制在冷启动这一条路径上（`isFreshEnough` 拿不到时间就判历史），
 * 因为它只在冷启动被读；正常轮询不看这个字段。反过来，若在这里塞 `new Date()`，
 * 一条发布时间损坏的预警会在每次 Host 重启时被当成"刚发布"重新播报。
 * @param {unknown} raw
 */
export function nmcTimeToIso(raw) {
  const s = String(raw === undefined || raw === null ? '' : raw).trim()
  if (!s) return ''
  const m = NMC_TIME_RE.exec(s)
  if (!m) return ''
  return m[1] + '-' + pad2(m[2]) + '-' + pad2(m[3]) + 'T' + pad2(m[4]) + ':' + m[5] + ':' + (m[6] || '00') + '+08:00'
}

/** 同上，但要 epoch 毫秒（stale 判定与冷启动判据用）；认不出返回 NaN。 */
export function nmcTimeMs(raw) {
  const iso = nmcTimeToIso(raw)
  if (!iso) return NaN
  const t = Date.parse(iso)
  return Number.isFinite(t) ? t : NaN
}

/**
 * `pic` 的文件名 → `{ kindCode, levelCode }`；认不出返回 null。
 * 抽成纯函数是因为"灾种与等级只认编码"这条约定必须有断言守着——它是本源唯一的分类依据。
 * @param {unknown} pic
 */
export function nmcCodesOf(pic) {
  const m = /\/p(\d{4})(\d{3})\.(?:png|gif|jpg)/i.exec(String(pic === undefined || pic === null ? '' : pic))
  if (!m) return null
  return { kindCode: Number(m[1]), levelCode: Number(m[2]) }
}

/**
 * 列表响应 → 逐条 entry（只含本插件接的灾种）。
 *
 * **结构不符必须抛错**，不能返回空数组：被拦截成 HTML、上游改版、响应被截断都长成
 * "这一次没有预警"，而后者是常态——两者同形就等于把静默失效藏起来（DESIGN 4.5）。
 * 与此相对，**单条**条目缺 `alertid` / `pic` / 时间时只跳过它：其余条目仍然是真实的预警。
 *
 * @param {string} text
 * @returns {{ id: string, title: string, updated: string, detailUrl: string,
 *             kind: string, level: string, payload: string, detailNeeded: boolean }[]}
 */
export function parseNmcList(text) {
  let json
  try {
    json = JSON.parse(String(text === undefined || text === null ? '' : text))
  } catch (err) {
    throw new Error('不是合法 JSON（可能是拦截页或错误页）')
  }
  const page = json && json.data && json.data.page
  const list = page && page.list
  if (!Array.isArray(list)) {
    throw new Error('响应缺少 data.page.list（可能是拦截页或上游改版）')
  }
  const out = []
  for (const it of list) {
    if (!it || typeof it !== 'object') continue
    const id = String(it.alertid === undefined || it.alertid === null ? '' : it.alertid).trim()
    if (!id) continue
    const codes = nmcCodesOf(it.pic)
    if (!codes) continue
    const kind = NMC_KINDS[codes.kindCode]
    if (!kind) continue // 不在范围内的灾种：**跳过不是故障**
    const level = NMC_LEVELS[codes.levelCode]
    if (!level) continue
    const issued = nmcTimeToIso(it.issuetime)
    const title = String(it.title === undefined || it.title === null ? '' : it.title).trim()
    const rec = {
      id,
      title,
      updated: issued,
      detailUrl: NMC_DETAIL_BASE + encodeURIComponent(id) + '.html',
      kind,
      level,
      detailNeeded: (NMC_LEVEL_RANK[level] || 0) >= NMC_DETAIL_MIN_RANK,
    }
    rec.payload = nmcPayload(rec, '')
    out.push(rec)
  }
  return out
}

/**
 * 交给 Client 的载荷（JSON 字符串）。**统一一种形态**：无论有没有抓到详情，都是这个对象，
 * 免得 Client 要先判断"这条是 JSON 还是 HTML"——那种分叉最终一定会有一条路径没被断言覆盖。
 * @param {object} rec parseNmcList 产出的记录
 * @param {string} detail 详情页正文（未抓或抓失败时为空串）
 */
export function nmcPayload(rec, detail) {
  return JSON.stringify({
    alertid: rec.id,
    title: rec.title,
    issued: rec.updated,
    kind: rec.kind,
    level: rec.level,
    detail: String(detail || ''),
  })
}

/**
 * 详情页 HTML → 正文纯文本（`#alarmtext` 里的内容）。
 *
 * 这一层只做**传输层规范化**（把一个已知容器的文本取出来），不判断灾种 / 等级 / 归属——
 * 那些仍然是 Client 的事。放在 Host 是因为：正文进了环缓冲就不再需要保留 46KB 的整页 HTML
 * （实测详情页 46KB，而正文约 200 字），而环缓冲的容量是按**条数**算的（DESIGN 11.7 第 5 条）。
 *
 * 提取失败返回空串：正文缺失只让文案少一段说明，不该让这条预警作废。
 * @param {unknown} html
 */
export function extractAlarmText(html) {
  const s = String(html === undefined || html === null ? '' : html)
  const at = s.indexOf('id=alarmtext')
  if (at === -1) return ''
  const open = s.indexOf('>', at)
  if (open === -1) return ''
  const close = s.indexOf('</div>', open)
  if (close === -1) return ''
  return decodeEntities(s.slice(open + 1, close).replace(/<[^>]*>/g, ''))
    .replace(/\s+/g, ' ')
    .trim()
}

/** HTML 实体解码（只处理正文里会出现的这几个；`&amp;` 必须最后做，否则 `&amp;lt;` 会被解成 `<`）。 */
function decodeEntities(s) {
  return String(s)
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
}

/**
 * 列表响应 → 「上游数据时间」（epoch 毫秒）。`list` 按时间倒序，第一条即最新。
 * 空的 / 不可解析的列表返回 NaN（按"未知"处理，**不**据此判 stale——没有预警与停更是两回事）。
 * @param {unknown} text
 */
export function nmcFeedTime(text) {
  try {
    const json = JSON.parse(String(text === undefined || text === null ? '' : text))
    const list = json && json.data && json.data.page && json.data.page.list
    if (!Array.isArray(list) || list.length === 0) return NaN
    return nmcTimeMs(list[0].issuetime)
  } catch (err) {
    return NaN
  }
}

/**
 * 建一个 nmc.cn 轮询源。与 JMA / USGS / NOAA 三源**接口同形**
 * （start / stop / snapshot / stats / markRead），所以直接并进 lib/index.js 的 pollers 表，
 * `/feed?source=nmc_alarm` 开箱可用。
 *
 * @param {object} [opts] 透传给 createPoller（测试注入 fetchText / now 等）
 */
export function createNmcSource(opts = {}) {
  return createPoller(Object.assign({
    feedUrl: NMC_LIST_URL,
    parseFeed: parseNmcList,
    // 只有橙 / 红才拉详情（文件头有理由）。蓝 / 黄用 parseNmcList 已经组装好的 payload。
    needDetail: (e) => !!e && e.detailNeeded === true,
    // 详情页面 → 正文，再与条目字段一起组装成统一的 JSON 载荷。
    detailTransform: (e, text) => nmcPayload(e, extractAlarmText(text)),
    feedTimeOf: nmcFeedTime,
    feedStaleMs: NMC_STALE_MS,
    backfillMs: NMC_BACKFILL_MS,
    intervalMs: NMC_INTERVAL_MS,
    idleMs: 10 * 60 * 1000,
  }, opts))
}
