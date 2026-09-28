// Host half · 中央气象台（nmc.cn）预警轮询源：定时拉 `GET /rest/findAlarm`（一次返回当前全部生效
// 预警），只把暴雨 / 地质灾害拆成逐条 entry，橙色及以上再拉详情页并把正文交给 Client，其余灾种不进缓冲。
// 列表每条只有 alertid / issuetime / title / url / pic（没有正文、区划代码、经纬度），时间是北京时间
// 裸串；列表是当前生效集合而非事件流，没有"解除"电文。依赖 ./poller.js 的 createPoller。

import { createPoller } from './poller.js'

/** 预警列表端点。`pageSize` 取 500 是实测的上限（一次给完当前全部生效预警）。 */
export const NMC_LIST_URL = 'https://www.nmc.cn/rest/findAlarm?pageNo=1&pageSize=500'

/** 详情页前缀：`<alertid>.html`，正文在 `#alarmtext` 里。 */
export const NMC_DETAIL_BASE = 'https://www.nmc.cn/publish/alarm/'

/**
 * 本插件接的灾种：键是 `pic` 里 4 位灾种码经 `Number()` 后的值（2 = 暴雨、21 = 地质灾害）。
 * 不接的灾种不进缓冲——列表一次给全部预警，原样转发会让用户的历史被雷电 / 大风 / 高温刷满。
 */
export const NMC_KINDS = { 2: 'rainstorm', 21: 'geology' }

/** 等级码 → 等级名（`pic` 里 001=红 002=橙 003=黄 004=蓝）。 */
export const NMC_LEVELS = { 1: 'red', 2: 'orange', 3: 'yellow', 4: 'blue' }

/** 等级序（越大越重），用于播报门槛与"拉不拉详情"。 */
export const NMC_LEVEL_RANK = { red: 4, orange: 3, yellow: 2, blue: 1 }

/** 拉详情的门槛：橙色（3）及以上。 */
export const NMC_DETAIL_MIN_RANK = 3

/** 轮询间隔：气象预警是警戒级信息，两分钟的延迟对时效没有影响，而请求量减半。 */
export const NMC_INTERVAL_MS = 120 * 1000

/** 首次启动回看：列表是"当前生效集合"，启动时列表里已有 24 小时内的预警。 */
export const NMC_BACKFILL_MS = 30 * 60 * 1000

/**
 * 上游停更阈值：列表里**最新一条的发布时间**距今超过它即判 `stale`。
 * 判据用 issuetime 而不是"收到多少条"——全国范围的预警连续不断，3 小时没有任何新预警
 * 只可能是上游停更或我们拿到了缓存。
 */
export const NMC_STALE_MS = 3 * 60 * 60 * 1000

/** 北京时间裸串：实测是 `2026/09/19 12:31`（斜杠分隔、无秒），连字符写法一并容忍。 */
const NMC_TIME_RE = /^(\d{4})[/-](\d{1,2})[/-](\d{1,2})[ T](\d{1,2}):(\d{2})(?::(\d{2}))?$/

const pad2 = (s) => String(s).padStart(2, '0')

/**
 * 列表里的裸北京时间 → 带 `+08:00` 的 ISO 8601；认不出时返回空串（**不猜**）。
 * 空串只会让首次启动判据把该条当历史，而塞 `new Date()` 会让时间损坏的预警每次重启都重播。
 * @param {unknown} raw
 */
export function nmcTimeToIso(raw) {
  const s = String(raw === undefined || raw === null ? '' : raw).trim()
  if (!s) return ''
  const m = NMC_TIME_RE.exec(s)
  if (!m) return ''
  return m[1] + '-' + pad2(m[2]) + '-' + pad2(m[3]) + 'T' + pad2(m[4]) + ':' + m[5] + ':' + (m[6] || '00') + '+08:00'
}

/** 同上，但要 epoch 毫秒（stale 判定与首次启动判据用）；认不出返回 NaN。 */
export function nmcTimeMs(raw) {
  const iso = nmcTimeToIso(raw)
  if (!iso) return NaN
  const t = Date.parse(iso)
  return Number.isFinite(t) ? t : NaN
}

/**
 * `pic` 的文件名 → `{ kindCode, levelCode }`；认不出返回 null。灾种与等级只认这里的编码，
 * 不靠 title 的中文匹配（title 的措辞会随上游改）。
 * @param {unknown} pic
 */
export function nmcCodesOf(pic) {
  const m = /\/p(\d{4})(\d{3})\.(?:png|gif|jpg)/i.exec(String(pic === undefined || pic === null ? '' : pic))
  if (!m) return null
  return { kindCode: Number(m[1]), levelCode: Number(m[2]) }
}

/**
 * 列表响应 → 逐条 entry（只含本插件接的灾种）。**结构不符必须抛错**（被拦截成 HTML、上游改版、
 * 响应被截断都长成"这一次没有预警"，两者同形就等于把悄悄失灵藏起来）；**单条**缺 `alertid` /
 * `pic` / 时间时只跳过它。
 * @returns {{ id: string, title: string, updated: string, detailUrl: string, kind: string, level: string, payload: string, detailNeeded: boolean }[]}
 */
export function parseNmcList(text) {
  let json
  try {
    json = JSON.parse(String(text === undefined || text === null ? '' : text))
  } catch (err) {
    throw new Error('not valid JSON (blocked page or error page?)')
  }
  const page = json && json.data && json.data.page
  const list = page && page.list
  if (!Array.isArray(list)) {
    throw new Error('response lacks data.page.list (blocked page or upstream change?)')
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
 * 交给 Client 的载荷（JSON 字符串）。**统一一种形态**：无论有没有抓到详情都是这个对象，
 * 免得 Client 要先判断"这条是 JSON 还是 HTML"。
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
 * 详情页 HTML → 正文纯文本（`#alarmtext` 里的内容）。**取全部 `id=alarmtext` 块**，不是只取第一个
 * ——实测 5 份真实详情页里 4 份存在第二个块（"防御指南：…"）。只做传输层规范化，不判断灾种 /
 * 等级 / 归属；提取失败返回空串（正文缺失不该让这条预警作废）。
 * @param {unknown} html
 */
export function extractAlarmText(html) {
  const s = String(html === undefined || html === null ? '' : html)
  const parts = []
  let from = 0
  for (;;) {
    const at = s.indexOf('id=alarmtext', from)
    if (at === -1) break
    const open = s.indexOf('>', at)
    if (open === -1) break
    const close = s.indexOf('</div>', open)
    if (close === -1) break
    const txt = decodeEntities(s.slice(open + 1, close).replace(/<[^>]*>/g, ''))
      .replace(/[ \t]+/g, ' ')
      .trim()
    if (txt) parts.push(txt)
    from = close + 1
  }
  // 用换行分隔：正文与防御指南是两段不同的话（详情按 pre-wrap 渲染，换行会保留）。
  return parts.join('\n')
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
 * 列表响应 → 「上游数据时间」（epoch 毫秒），取**最新的一条**而不是假定 list[0] 最新。
 * 空的 / 不可解析的列表返回 NaN（按"未知"处理，**不**据此判 stale——没有预警与停更是两回事）。
 * @param {unknown} text
 */
export function nmcFeedTime(text) {
  try {
    const json = JSON.parse(String(text === undefined || text === null ? '' : text))
    const list = json && json.data && json.data.page && json.data.page.list
    if (!Array.isArray(list) || list.length === 0) return NaN
    let best = NaN
    for (const it of list) {
      const ms = nmcTimeMs(it && it.issuetime)
      if (Number.isFinite(ms) && (!Number.isFinite(best) || ms > best)) best = ms
    }
    return best
  } catch (err) {
    return NaN
  }
}

/**
 * 列表的分页信息：`NMC_LIST_URL` 把 `pageSize=500` 写死在 URL 里，生效预警一旦超过 500 条，
 * 列表尾部（最久未解除的那批）会静默消失，在界面上与"已解除"同形。这里只如实报出
 * `listCount` / `count` / `totalPage`，不擅自翻页。
 * @param {unknown} text 列表响应原文
 */
export function nmcPageInfoOf(text) {
  const info = { listCount: 0, count: 0, totalPage: 0, pageSize: 500, truncated: false }
  try {
    const json = JSON.parse(String(text === undefined || text === null ? '' : text))
    const page = json && json.data && json.data.page
    if (!page || !Array.isArray(page.list)) return info
    info.listCount = page.list.length
    info.count = typeof page.count === 'number' ? page.count : 0
    info.totalPage = typeof page.totalPage === 'number' ? page.totalPage : 0
    // 截断的两种表现：上游说还有更多页，或上游给的总数大于这一页拿到的条数
    info.truncated = info.totalPage > 1 || (info.count > 0 && info.count > info.listCount)
  } catch (err) { /* 认不出就当没有分页信息 */ }
  return info
}

/**
 * 建一个 nmc.cn 轮询源。与 JMA / USGS / NOAA 三源接口同形（start / stop / snapshot / stats / markRead），
 * 直接并进 lib/index.js 的 pollers 表，`/feed?source=nmc_alarm` 开箱可用；`stats()` 里另带
 * listCount / count / totalPage / listTruncated 四项分页读数。`opts` 透传给 createPoller。
 */
export function createNmcSource(opts = {}) {
  let pageInfo = { listCount: 0, count: 0, totalPage: 0, truncated: false }
  const src = createPoller(Object.assign({
    feedUrl: NMC_LIST_URL,
    parseFeed: (text) => {
      pageInfo = nmcPageInfoOf(text)
      return parseNmcList(text)
    },
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
  return Object.assign({}, src, {
    stats() {
      return Object.assign({}, src.stats(), {
        listCount: pageInfo.listCount,
        count: pageInfo.count,
        totalPage: pageInfo.totalPage,
        listTruncated: pageInfo.truncated === true,
      })
    },
  })
}
