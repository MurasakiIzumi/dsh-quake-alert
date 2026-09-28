// ============================================================================
// dsh-quake-alert · client/src/05d-source-contracts.js
//
// 作用：**解析契约**与**每源校验约定**——统一返回形态 + 每源的 schema / stale / empty 判据。
// 依赖：01-constants、02-storage、05/05b/05c（各源的解析器）、07-store（状态上报）。
// 健康记录（存 / 升级阈值 / 自愈）在 05g-source-health.js，自检调度在 12d-health-probe.js。
//
// 三类失败：empty 源正常但无相关数据（不计失败）；schema 结构不符；value 值客观不可能。
// 后两类计入健康状态并停止播报该源。解析层严格，匹配层宽松。
// ============================================================================

import { isPlainObject, own } from './02-storage.js'
import { cnTimeToIso } from './01-constants.js'
import { parse } from './05-parser.js'
import { parseJma } from './05b-jma-parser.js'
import { parseEmsc, parseUsgsFeature, parseNoaaCap } from './05c-global-parsers.js'
import { parseCencEew, parseCencEqlistItem, cencEqlistItems, cencEqlistMd5Of } from './05e-cn-parsers.js'
import { parseNmcAlarm, orgOf, NMC_KIND_TEXT, NMC_LEVEL_TEXT } from './05f-nmc-parsers.js'
import { parseNwsAlert, parseEcccAlert, NWS_EVENT_WHITELIST, ECCC_INCLUDE, ECCC_EXCLUDE, ECCC_COLOUR_SEVERITY } from './05h-overseas-parsers.js'

/** 解析成功。 */
export const okResult = (alert) => ({ ok: true, alert })
/** 解析失败 / 无关。kind ∈ 'empty' | 'schema' | 'value'。 */
export const failResult = (kind, detail) => ({ ok: false, kind, detail: String(detail || '') })

const numOf = (v) => {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null
  const s = String(v === undefined || v === null ? '' : v).trim()
  if (!s) return null
  const n = Number(s)
  return Number.isFinite(n) ? n : null
}
const timeMsOf = (v) => {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null
  const t = Date.parse(String(v === undefined || v === null ? '' : v))
  return Number.isFinite(t) ? t : null
}
/** 时间戳是否客观不可能：1970 年以前、或 100 年以后。
 *  缺失 / 不可解析不算"不可能"——存在性由各源的 schema 判据负责。 */
const timeIsImpossible = (ms, now) => {
  if (typeof ms !== 'number' || !Number.isFinite(ms)) return false
  return ms < 0 || ms > (now || Date.now()) + 100 * 365 * 24 * 3600 * 1000
}

/**
 * 每源校验约定。字段含义：
 *   required    —— 必需字段与类型（schema 判据）。缺一个即判 schema，不猜、不兜底。
 *   timezone    —— 源时区。解析器把时间转成带偏移的 ISO 8601。
 *   staleAfterMs—— 新鲜度阈值（stale 判据）；null = 不适用，理由在 staleReason。
 *   empty       —— 什么形态算"源正常但当前无数据"（不计失败）。
 *   tolerant    —— 明确**不判 schema** 的字段范围；与 required 互补，required 只列实现真会拦下的字段。
 *   pollMs      —— 传输层的轮询 / 推送周期。
 */
export const SOURCE_CONTRACTS = {
  p2pquake: {
    label: 'P2PQuake',
    region: 'jp',
    disasters: ['quake', 'eew', 'tsunami'],
    transport: 'ws',
    url: 'wss://api.p2pquake.net/v2/ws',
    pollMs: null,
    timezone: 'Asia/Tokyo（+09:00）—— issue.time / earthquake.time / areas[].arrivalTime 都是裸 JST，由 p2pTimeToIso 补偏移',
    required: [
      'code：必须是 551 / 552 / 556 之一（其它 code 判 empty，不算故障）',
      '每条都要：id（或 _id）string、issue.time string',
      '551：earthquake 是对象、earthquake.maxScale 是 number、points 是数组，且 points[] 每一项是对象；' +
      'scale / pref / addr **只在存在时**要求类型正确（0.4.2 起有意放宽：单个观测点缺字段' +
      '不该让整条警报消失，预警产品里丢整条的代价是漏报）',
      '552：areas 是数组、每项是对象，grade **只在存在时**要求是字符串——**不查枚举**：' +
      '未知等级按 rank 0 处理、正文照原样显示（与解析器 areas.map 里的 `|| "—"` 一致）',
      '556：earthquake 与 earthquake.hypocenter 是对象、areas 是数组且每项必须有非空 name；' +
      'scaleTo **只在存在时**要求是 number',
      '时间是"客观不可能"检查（越界判 value），**缺 earthquake.time 不判 schema**：' +
      '它只喂事件归并键（`quake:` + eq.time），缺了就退化成不做事件级去重，警报本身照发',
    ],
    empty: 'code 不是 551/552/556（P2PQuake 还会推火山、其他情报等与本插件无关的消息）',
    staleAfterMs: null,
    staleReason: '推送源没有"数据新鲜度"概念：日本可能数小时没有有感地震。活性由连接层负责' +
      '（建连超时监控 15 秒 + 连接假死检测 20 分钟，见 12-websocket）。',
  },
  jma: {
    label: '気象庁 防災情報XML',
    region: 'jp',
    disasters: ['weather'],
    transport: 'feed',
    url: 'https://www.data.jma.go.jp/developer/xml/feed/extra.xml',
    pollMs: 60 * 1000,
    timezone: 'Asia/Tokyo（+09:00）—— Head/ReportDateTime 带 +09:00；Control/DateTime 是 UTC（Z）。' +
      '两者都带偏移，解析器优先取 ReportDateTime',
    required: [
      '电文非空',
      '不是 HTML（返回 `<!DOCTYPE html>` / `<html` 判 schema：拦截页或地址失效最常见）',
      '<Report> 根元素（防災情報XML 的标志）',
    ],
    tolerant: '电文结构本身（Item / Kind、Area / Name / Code、ReportDateTime、Control/Title）' +
      '**不作 schema 判据**：缺 Items、缺 Area、只有注意報或"なし"的电文一律归 empty，' +
      '由匹配层的 cannotJudge 决定要不要留痕。',
    empty: '警戒レベル 0 且不是解除的电文：天气预报、府県気象情報、火山、观测资料，以及"只有注意報 /' +
      ' なし"的警报电文（L1〜L2 按设计既不播报也不进历史，所以归入 empty 而不是失败）',
    staleAfterMs: 3 * 60 * 60 * 1000,
    staleReason: 'feed 每分钟更新（掲載直近の入電）。但"我们没有相关电文"是常态（只有天气预报时也正常），' +
      '所以阈值不查"我们收到多少条"，只查 feed 自身的最新 <updated>：超过 3 小时说明上游停更。',
  },
  emsc: {
    label: 'EMSC',
    region: 'global',
    disasters: ['quake'],
    transport: 'ws',
    url: 'wss://www.seismicportal.eu/standing_order/websocket',
    pollMs: null,
    timezone: 'UTC（properties.time 形如 2026-09-12T02:15:12.43Z，自带偏移，无需转换）',
    required: [
      '顶层 { action, data }（data 是 GeoJSON Feature，不是 FeatureCollection）',
      'data.properties object：mag number、time string',
      'data.properties.lat/lon number，或 data.geometry.coordinates[0..1]',
    ],
    tolerant: 'properties.flynn_region（地名）缺失**不判 schema**：解析器用 String(p.flynn_region||\'\') ' +
      '取空串，正文退化成没有地名的形态而不是丢整条。required 只列实现真的会拦下的字段（0.5.1 定）。',
    empty: 'action === "delete"（事件被撤回），或 properties.evtype 不是 "ke"（非地震事件，如爆炸）',
    staleAfterMs: null,
    staleReason: '全球 M4+ 平均约 30 分钟一条，稀疏是常态，不能用消息间隔判死。活性由连接层负责' +
      '（建连超时监控 15 秒 + 3 小时无消息的连接假死检测，见 15-entry 的 staleAfterMs）。',
  },
  usgs: {
    label: 'USGS',
    region: 'global',
    disasters: ['quake'],
    transport: 'feed',
    url: 'https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/2.5_day.geojson',
    pollMs: 120 * 1000,
    timezone: 'UTC（properties.time/updated 是 epoch 毫秒，经 toIso 转成带 Z 的 ISO）',
    required: [
      '顶层 GeoJSON：features[] 数组（**Host 侧校验**：lib/global-sources.js 的 parseUsgsEntries）',
      '每个 feature：properties 是对象、mag 是 number、time 是 number（epoch 毫秒或可解析的时间）',
      '震中坐标：geometry.coordinates[0..1] **或** properties.lat/lon（解析器两条都认，' +
      '此前写成"必须 geometry.coordinates"是比实现严的声明）',
      '坐标不越界（越界判 value，与"缺坐标判 schema"是两种不同的结论）',
    ],
    tolerant: 'feature.id（缺失时解析器按 properties.code / 坐标兜底出稳定 id）与 properties.updated' +
      '（当前实现不读它，修订版靠 properties.time + 坐标近似归并）——两者缺失都不判 schema。' +
      '另：`metadata.generated` 是**停更判据的输入而不是 schema 判据**——缺了它只意味着"新鲜度未知"' +
      '（usgsFeedGeneratedAt 返回 NaN，停更检测不触发），不会把这一帧判成故障。',
    empty: 'features 为空数组（该窗口内没有 M2.5+ 事件，罕见但正常）',
    staleAfterMs: 30 * 60 * 1000,
    staleReason: 'USGS 摘要 feed 每 5 分钟重新生成，metadata.generated 是它的生成时刻；' +
      '超过 30 分钟说明上游停更或我们拿到的是缓存。',
  },
  noaa: {
    label: 'NOAA tsunami.gov',
    region: 'global',
    disasters: ['tsunami'],
    transport: 'feed',
    url: 'https://www.tsunami.gov/events/xml/PHEBAtom.xml',
    pollMs: 5 * 60 * 1000,
    timezone: 'UTC（CAP <sent> 形如 2026-08-22T08:30:40-00:00，自带偏移）',
    required: [
      '事件列表：<entry> + <link rel="related" title="CapXML document" href>',
      'CAP 电文：<alert> 根、<identifier>、<info>（event / sent）',
    ],
    tolerant: '区域（<area><circle> 或 info/parameter 里的 EventLatLon）缺失**不判 schema**：' +
      'alert.geo 取 {lat:null,lon:null}，行动提示退化成"无坐标"形态而不是丢整条。',
    empty: 'msgType === "Test"（演练电文）；或事件列表为空（大多数时候没有海啸）',
    staleAfterMs: null,
    staleReason: '事件列表只在有海啸时才有内容，"列表为空"是绝大多数时间的正常形态，不能据此判 stale。',
  },
  // ---- 中国大陆源 ----
  // 两处结构性差异：① 传输是 **Host 单点常连**（Wolfx 限 5–7 连接/IP），不是 Client 直连。
  // ② cenc_eqlist 的字段**全是字符串**，cenc_eew 的字段是 number，同一上游两种序列化风格。
  cenc_eew: {
    label: 'Wolfx CENC EEW',
    region: 'cn',
    disasters: ['eew'],
    transport: 'ws',
    url: 'wss://ws-api.wolfx.jp/cenc_eew（REST 快照 https://api.wolfx.jp/cenc_eew.json）',
    pollMs: null,
    timezone: 'Asia/Shanghai（+08:00，无夏令时）—— OriginTime / ReportTime 是裸北京时间，由 cnTimeToIso 补偏移',
    required: [
      '接收两种形态：WS 推送包（含 type:"cenc_eew"）与 REST 快照（无 type）',
      'ID string 非空（消息唯一键，Alert 的 id 取 cenc: 前缀）',
      'Latitude / Longitude 为数值，且落在合法范围内',
      'Magnitude 为数值（缺它这条预警就没有阈值可判 → 判 schema）',
      'OriginTime 为可解析的北京时间串，且不是客观不可能的时刻',
    ],
    tolerant: 'Depth / ReportNum / MaxIntensity / HypoCenter / ReportTime 缺失或类型不对**不判 schema**' +
      '——沿用 0.4.2 对 551 观测点定的同一口径（"存在则类型必须正确"，缺失容忍）：' +
      '整条丢弃在预警产品里的代价是漏报。取不到值时解析器给 null / 空串，文案退化成 M— / 无地名。' +
      '（0.5.1 修正：此前 required 把这几项也写成必需，与实现的校验范围不符。）',
    empty: '10 个字段一个都没有（只有 type 包裹或空对象）——源正常但当前没有预警。' +
      '**这条未实测**：Wolfx 总是回最后一条预警（哪怕已过数天），从未见过"无预警"的返回形态，' +
      '样本不足以确认。保守取此判据，是因为判反了会点亮一个用户根本处理不了的蓝点（DESIGN 4.5 的配色语义）。',
    staleAfterMs: null,
    staleReason: '预警稀疏（实测门槛约 M4.0，数天一次），"很久没消息"是常态，不能据此判死。' +
      '活性由连接层负责（心跳实测精确 60 秒、200 秒内无服务端强断，超 120 秒无消息即重连）。' +
      '中继是否存活由 cenc_eqlist 探（它每天都有数据）——这也是两个源都要接的原因之一。',
  },
  cenc_eqlist: {
    label: 'Wolfx CENC eqlist',
    region: 'cn',
    disasters: ['quake'],
    transport: 'ws',
    url: 'wss://ws-api.wolfx.jp/cenc_eqlist（REST 快照 https://api.wolfx.jp/cenc_eqlist.json）',
    pollMs: null,
    timezone: 'Asia/Shanghai（+08:00，无夏令时）—— time / ReportTime 是裸北京时间，由 cnTimeToIso 补偏移',
    required: [
      '整表载荷：No1…NoN（数值序，No1 最新）；**md5 不是判据**——它只作诊断读数与' +
      '（P3-31 之前）的整表短路，缺了照常逐条比对',
      '每项：EventID string 非空',
      '每项：latitude / longitude 为数字字符串或数值，且落在合法范围内',
      '每项：magnitude 为数字字符串或数值（缺它这条速报就没有阈值可判）',
      '每项：time 为可解析的北京时间串，且不是客观不可能的时刻',
    ],
    tolerant: 'placeName / location / depth / intensity / ReportTime / type 缺失或类型不对**不判 schema**' +
      '（同上：保留一条真实地震比丢弃它重要）。地名取 placeName 优先、location 兜底，都没有则留空。' +
      '注意本判据是**逐项**的——线上由 Host 把整表拆成逐条 entry，整表级的"全坏"由 Host 侧判（见 wolfx-source）。',
    empty: '整表里一个 NoN 都没有——源正常但当前没有速报数据',
    staleAfterMs: 48 * 60 * 60 * 1000,
    staleReason: '**本插件唯一真正有意义的新鲜度阈值，而且它探的是中继不是灾害**：速报每天都有数据，' +
      '所以"超过 48 小时没有新批次"即判中继异常（fj_eew 那种连接正常但停更 4 个月的形态，' +
      '靠连接检测完全发现不了）。实测发布 lag 209–1643 秒，阈值不能贴着 lag 取留出余量。',
  },
  // ---- 中国大陆气象源 ----
  // 一条 Host 源（`nmc_alarm`）承载**两个灾种**（暴雨 / 地质灾害）：两者来自同一个
  // `rest/findAlarm` 响应、只有 `pic` 编码不同，所以是一条契约。匹配走**行政区层级**
  // （locator:'area'），因此"title 能解析出机构名"是**必需字段**——解析不出就归不了属。
  nmc_alarm: {
    label: 'CMA warning signals (nmc.cn)',
    region: 'cn',
    disasters: ['weather'],
    transport: 'feed',
    url: 'https://www.nmc.cn/rest/findAlarm（详情页 https://www.nmc.cn/publish/alarm/<alertid>.html）',
    pollMs: 120 * 1000,
    timezone: 'Asia/Shanghai（+08:00，无夏令时）—— issuetime 是裸北京时间，且写法与 Wolfx 不同' +
      '（`2026/09/19 12:31`：斜杠分隔、无秒）。Host 侧补偏移后以带偏移的 ISO 下发，' +
      '所以 Client 这里拿到的时间已经可以直接 Date.parse。',
    required: [
      'alertid string 非空（每条预警的唯一键，Host 用它去重与拼详情 URL）',
      'kind 是 string；`{rainstorm, geology}` 之外的取值判 **empty 而不是 schema**' +
      '（0.9.4 / C2：实现里走的是 `own(NMC_KIND_TEXT, kind)` 判空，说明这两种之外只是"不在我们范围内"，' +
      '不是源坏了——此前写在 required 里会让人以为要判故障）',
      'level ∈ {red, orange, yellow, blue}（Host 从 pic 的等级码译出）',
      'title string 非空，且形如「…气象台发布…预警信号」——**匹配完全依赖它**，解析不出机构名即判 schema',
      'issued 可解析的 ISO 时间（Host 已补 +08:00）',
    ],
    tolerant: 'detail（详情页正文）缺失或为空**不判 schema**：只有橙色及以上才会拉详情（DESIGN 8.4），' +
      '蓝 / 黄的正文本来就是空的，而详情抓取失败也只会让文案少一段说明——' +
      '为了一段附属文字丢掉一条真实预警是漏报方向。',
    empty: 'kind 是字符串但**不在本插件范围内**——这是**向前兼容**的兜底而不是当下会发生的形态：' +
      'Host 已经按灾种过滤（实测雷电 / 大风 / 高温占 76%，原样转发会把历史刷满），' +
      '所以正常收到的条目一定是暴雨或地质灾害。判 empty 而不是 schema，是为了将来 Host 若改为' +
      '转发全部灾种时，旧 Client 静默跳过而不是点亮一个用户处理不了的蓝点。',
    staleAfterMs: 3 * 60 * 60 * 1000,
    staleReason: '判据是**列表里最新一条的发布时间**（不是"我们收到多少条"）：全国范围的预警是连续' +
      '不断的（实测 238 条覆盖约 24 小时），所以"3 小时没有任何新预警"只可能是上游停更或我们' +
      '拿到缓存。与 JMA 同档；实测 40 分钟窗口里新增 11 条、相邻两次新增的最长间隔只有 10 分钟，' +
      '余量近 20 倍。',
  },
  // 海外气象源：两条都是 **Client 直连的 REST 轮询**（CORS 实测允许），且都是**按关注点查询**
  // （NWS 按点、ECCC 按 bbox）——locator 是 'overseas'（命中在取数时已发生，匹配层不算距离）、
  // staleAfterMs 只能是 null（空响应是常态）、时间语义相反（NWS 自带偏移、ECCC 是 UTC Z）。
  nws_alerts: {
    label: 'NWS alerts (api.weather.gov)',
    region: 'us',
    disasters: ['weather'],
    transport: 'rest',
    url: 'https://api.weather.gov/alerts/active?point=<lat>,<lon>' +
      '（半径 ≥ 25km 时另查 4 个方位采样点，见 DESIGN 4.7.2；全量 /alerts/active 1.67MB 不可用）',
    pollMs: 120 * 1000,
    timezone: '**响应自带偏移**（`2026-09-22T06:51:00-04:00`，随州与夏令时变化）——不换算，直接 Date.parse。' +
      '这是本插件第一个"时刻完整"的源：JMA / nmc / Wolfx 给的都是裸本地时间、必须补偏移，NWS 不是。',
    required: [
      'properties 是对象（一条 CAP 电文）',
      'properties.event string 且**精确命中 8 类洪水白名单**（未命中判 empty，见下）',
      // 实现会退回 GeoJSON 外层的 `id`（实测是 URL，解析器会剥掉前缀），所以"properties.id 必需"
      // 是比实现更严的声明——后来者按它写测试会误判某个字段必需。
      '`properties.id` 或 GeoJSON 外层的 `id` 至少有一个非空（去重与消息级 id 的基础）',
      'properties.sent 可解析的 ISO 时间（带偏移）',
    ],
    tolerant: 'severity 缺失或不在 {Extreme,Severe,Moderate,Minor} 内 → 退回 info，**不判 schema**：' +
      '宁可让一条真实洪水预警少一个颜色，也不要因为上游少给一个枚举值就整源停播（漏报方向）。' +
      'headline / areaDesc / description / instruction / geocode / ends / senderName 缺失一律不判 schema。' +
      '**事件键（eventKey）取 `parameters.VTEC` 的事件追踪号** `<office>.<phenom>.<sig>.<ETN>`' +
      '（`/O.<ACTION>.KRLX.FA.W.0137.….` → `KRLX.FA.W.0137`，ACTION 段刻意剔除：它随' +
      ' NEW→EXT→CON→CAN 变化）；VTEC 缺失或解析不出时退回 CAP 的 `references`（取 `sent` 最早的一条）、' +
      '再退回自身 identifier——**三级兜底都不判 schema**。' +
      '`properties.eventCode` 是对象（`{SAME:[…],NationalWeatherService:[…]}`）且实测 `Flood Warning` 的 ' +
      'SAME 给的是 `FLS`——它只作诊断，**不参与任何判据**。',
    empty: '`properties.event` 不在白名单——它是**向前兼容的兜底**而不是异常：全量 359 条里海事通告占' +
      '三分之二（Small Craft Advisory 202 条、Gale Warning 34 条），非本插件灾种（Air Quality / Frost / ' +
      'Wind / Test Message）也在其中。另外 `features: []`（该点当前没有预警）同样是正常形态。' +
      '两类都判 empty 而不是 schema，是为了不点亮一个用户处理不了的蓝点。',
    staleAfterMs: null,
    staleReason: '**按点查询的响应天然可能是空的**：美国绝大多数坐标绝大多数时候没有洪水预警，' +
      '"这一轮没数据"与"上游停更"完全同形，据此判 stale 会把正常状态反复报成故障。' +
      '活性交给连接层（请求是否成功）。代价要如实说：**"服务在但数据不更新"这种停更本插件看不见**，' +
      '能发现的只有 schema 判据能抓到的结构改版（DESIGN 4.7.7 第 2 条）。',
  },
  eccc_alerts: {
    label: 'ECCC alerts (api.weather.gc.ca)',
    region: 'ca',
    disasters: ['weather'],
    transport: 'rest',
    url: 'https://api.weather.gc.ca/collections/weather-alerts/items?f=json&bbox=<minLon>,<minLat>,<maxLon>,<maxLat>' +
      '（bbox = 关注点坐标 ± radiusKm，OGC API 的矩形查询）',
    pollMs: 300 * 1000,
    timezone: '**UTC**（`2026-09-22T08:47:21.957Z`）——不需要补偏移，直接 Date.parse。',
    required: [
      'properties 是对象',
      'alert_type === "warning"（advisory 判 empty，见下）',
      'alert_name_en 命中灾种白名单（未命中判 empty，见下）',
      'alert_code string 非空（ECCC 的三字母码，只作诊断与事件键）',
      'publication_datetime 可解析的 ISO 时间',
      'risk_colour_en ∈ {yellow, orange, red}——**颜色是 ECCC 2025 改版后的核心等级信息**，' +
      '缺失或越界说明上游结构变了，判 schema 让用户看见',
    ],
    tolerant: 'alert_text_en 为空 → detail 只留署名行，**不判 schema**（正文是"该怎么做"的说明，' +
      '它的缺失不该让一条真实预警消失）。feature_id / province / confidence_en / impact_en / status_en ' +
      '缺失一律不判 schema——**事件键会在 feature_id 缺失时退回区域名**（见 05h 的 ecccEventKeyOf；' +
      '两个都缺时会退到 province，这时同省同码同日期的两条不同 warning 会算出同一个事件键而被' +
      '当成"后续发布"——已知的边界，等真实样本出现再校准）。' +
      '**事件键按 UTC 发布日分桶**（`eccc:<code>:<areaKey>:<YYYY-MM-DD>`）：同一天内的更新同键、' +
      '不重复响铃；跨 UTC 日界的持续过程会换键，最多多响一次（保守方向）。',
    empty: '两类都判 empty（向前兼容，不点亮蓝点）：① `alert_type !== "warning"`——ECCC 的 advisory 按官方' +
      '定义是「generally not considered hazardous」，实测当前 116 条里 114 条是 frost advisory；' +
      '② `alert_name_en` 不在白名单（风 / 高温 / 雷暴 / 雾…）。' +
      '**注意白名单的证据等级**：ECCC 的码表没有官方枚举，而当前季节没有降雨类样本，' +
      '白名单是按名称关键词收的（`' + String(ECCC_INCLUDE) + '`，并排除 `' + String(ECCC_EXCLUDE) + '`），' +
      '**是本设计里唯一未经实测证实的部分**——首批真实降雨预警到达后要回头校准（DESIGN 4.7.5）。',
    staleAfterMs: null,
    staleReason: '与 NWS 同因：bbox 查询在"这个范围当前没有本插件范围内的预警"时返回空数组，' +
      '与"上游停更"同形。另外 ECCC 的 **CAP 归档只有当天、历史不可得**（实测跨 3 天取样全部失败），' +
      '所以也无法用"上一次见到数据是什么时候"来判停更。',
  },
}

// ---------------------------------------------------------------- Result 包装
// 包装函数先把"结构不符 / 值不可能"挡在解析器之前，再调用真实解析器（单一实现）。

/**
 * P2PQuake（551/552/556）。
 *
 * 运行时调用点是 15-entry.js 里 P2PQuake 的 onRaw（每帧一次），调用后立刻记入数据健康：
 * schema / value 失败会升级成界面蓝点，不是被丢掉。
 */
export function parseEpspResult(raw) {
  if (!isPlainObject(raw)) return failResult('schema', '顶层不是对象')
  const code = raw.code
  if (code !== 551 && code !== 552 && code !== 556) {
    return failResult('empty', 'code=' + String(code) + ' 不属于本插件的灾种')
  }
  const id = raw.id || raw._id
  if (typeof id !== 'string' || !id) return failResult('schema', '缺少 id/_id')
  const issueTime = raw.issue && raw.issue.time
  if (typeof issueTime !== 'string' || !issueTime) return failResult('schema', '缺少 issue.time')
  if (code === 551) {
    const eq = raw.earthquake
    if (!isPlainObject(eq)) return failResult('schema', '551 缺少 earthquake')
    if (typeof eq.maxScale !== 'number') return failResult('schema', '551 缺少 earthquake.maxScale（number）')
    if (!Array.isArray(raw.points)) return failResult('schema', '551 缺少 points 数组')
    for (const p of raw.points) {
      if (!isPlainObject(p)) return failResult('schema', '551 的 points[] 含非对象项')
      // 逐项只查"**存在则类型正确**"（0.4.2 放宽）：单个观测点缺 scale / 缺 pref 不该让整条
      // 警报消失——其他观测点是好的，而整条丢弃在预警产品里的代价是漏报。
      // 真正要挡的是"结构型错误"（points 不是数组、项不是对象、字段类型明显不对）。
      if (p.scale !== undefined && p.scale !== null && typeof p.scale !== 'number') {
        return failResult('schema', '551 的 points[].scale 类型不是 number')
      }
      if (p.pref !== undefined && p.pref !== null && typeof p.pref !== 'string') {
        return failResult('schema', '551 的 points[].pref 类型不是 string')
      }
      if (p.addr !== undefined && p.addr !== null && typeof p.addr !== 'string') {
        return failResult('schema', '551 的 points[].addr 类型不是 string')
      }
    }
    if (timeIsImpossible(timeMsOf(eq.time))) return failResult('value', '551 的 earthquake.time 客观不可能：' + String(eq.time))
  }
  if (code === 552) {
    if (!Array.isArray(raw.areas)) return failResult('schema', '552 缺少 areas 数组')
    for (const a of raw.areas) {
      if (!isPlainObject(a)) return failResult('schema', '552 的 areas[] 含非对象项')
      if (a.grade !== undefined && a.grade !== null && typeof a.grade !== 'string') {
        return failResult('schema', '552 的 areas[].grade 不是字符串')
      }
    }
  }
  if (code === 556) {
    const eq = raw.earthquake
    if (!isPlainObject(eq)) return failResult('schema', '556 缺少 earthquake')
    if (!isPlainObject(eq.hypocenter)) return failResult('schema', '556 缺少 earthquake.hypocenter')
    if (!Array.isArray(raw.areas)) return failResult('schema', '556 缺少 areas 数组')
    for (const a of raw.areas) {
      if (!isPlainObject(a)) return failResult('schema', '556 的 areas[] 含非对象项')
      if (typeof a.name !== 'string' || !a.name) return failResult('schema', '556 的 areas[].name 缺失')
      if (a.scaleTo !== undefined && a.scaleTo !== null && typeof a.scaleTo !== 'number') {
        return failResult('schema', '556 的 areas[].scaleTo 不是 number')
      }
    }
  }
  const alert = parse(raw)
  if (!alert) return failResult('schema', '解析器未能生成 Alert（结构通过校验但字段映射失败）')
  return okResult(alert)
}

/** 気象庁 防災情報XML。 */
export function parseJmaResult(xml, entry) {
  const text = String(xml === undefined || xml === null ? '' : xml)
  if (!text) return failResult('schema', '电文为空')
  if (text.indexOf('<Report') === -1) {
    if (/^\s*<(!doctype|html)/i.test(text) || text.indexOf('<html') !== -1) {
      return failResult('schema', '返回的是 HTML 而不是 XML 电文（可能被拦截或地址失效）')
    }
    return failResult('schema', '不是防災情報XML（缺少 <Report> 根元素）')
  }
  const alert = parseJma(text, entry)
  if (!alert) return failResult('empty', '与本插件无关的电文（无警戒レベル、且不是解除）')
  return okResult(alert)
}

/** EMSC standing_order。 */
export function parseEmscResult(raw) {
  if (!isPlainObject(raw)) return failResult('schema', '顶层不是对象')
  if (raw.action === 'delete') return failResult('empty', '事件撤回通知（action=delete）')
  const d = raw.data
  if (!isPlainObject(d)) return failResult('schema', '缺少 data 对象')
  const p = d.properties
  if (!isPlainObject(p)) return failResult('schema', '缺少 data.properties')
  const coords = (d.geometry && Array.isArray(d.geometry.coordinates)) ? d.geometry.coordinates : []
  const lat = numOf(p.lat !== undefined ? p.lat : coords[1])
  const lon = numOf(p.lon !== undefined ? p.lon : coords[0])
  if (lat === null || lon === null) return failResult('schema', '缺少震中坐标（properties.lat/lon 与 geometry.coordinates 都没有）')
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return failResult('value', '震中坐标越界：' + lat + ',' + lon)
  if (numOf(p.mag) === null) return failResult('schema', '缺少 properties.mag（number）')
  const t = timeMsOf(p.time)
  if (t === null) return failResult('schema', '缺少 properties.time（可解析的时间）')
  if (timeIsImpossible(t)) return failResult('value', '发震时刻客观不可能：' + String(p.time))
  if (p.evtype !== undefined && String(p.evtype) !== 'ke') {
    return failResult('empty', '非地震事件（evtype=' + String(p.evtype) + '）')
  }
  const alert = parseEmsc(raw)
  if (!alert) return failResult('schema', '解析器未能生成 Alert（结构通过校验但字段映射失败）')
  return okResult(alert)
}

/** USGS summary feed 的单个 Feature。 */
export function parseUsgsResult(feature) {
  if (!isPlainObject(feature)) return failResult('schema', '不是 GeoJSON Feature 对象')
  const p = feature.properties
  if (!isPlainObject(p)) return failResult('schema', '缺少 feature.properties')
  const coords = (isPlainObject(feature.geometry) && Array.isArray(feature.geometry.coordinates))
    ? feature.geometry.coordinates : []
  const lon = numOf(coords[0] !== undefined ? coords[0] : p.lon)
  const lat = numOf(coords[1] !== undefined ? coords[1] : p.lat)
  if (lat === null || lon === null) return failResult('schema', '缺少 geometry.coordinates / properties.lat,lon')
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return failResult('value', '震中坐标越界：' + lat + ',' + lon)
  if (numOf(p.mag) === null) return failResult('schema', '缺少 properties.mag（number）')
  const t = timeMsOf(p.time)
  if (t === null) return failResult('schema', '缺少 properties.time（epoch 毫秒或可解析的时间）')
  if (timeIsImpossible(t)) return failResult('value', '发震时刻客观不可能：' + String(p.time))
  const alert = parseUsgsFeature(feature)
  if (!alert) return failResult('schema', '解析器未能生成 Alert（结构通过校验但字段映射失败）')
  return okResult(alert)
}

/** NOAA tsunami.gov 的 CAP 1.2 电文。 */
export function parseNoaaResult(xml, entry) {
  const text = String(xml === undefined || xml === null ? '' : xml)
  if (!text) return failResult('schema', 'CAP 电文为空')
  if (text.indexOf('<alert') === -1) {
    if (text.indexOf('<html') !== -1 || /^\s*<(!doctype|html)/i.test(text)) {
      return failResult('schema', '返回的是 HTML 而不是 CAP 电文（可能被拦截或地址失效）')
    }
    return failResult('schema', '不是 CAP 电文（缺少 <alert> 根元素）')
  }
  const msgType = (/<msgType>([^<]*)<\/msgType>/.exec(text) || [])[1] || ''
  if (String(msgType).trim() === 'Test') return failResult('empty', '演练电文（msgType=Test）')
  const alert = parseNoaaCap(text, entry)
  if (!alert) return failResult('schema', '缺少 <identifier> 或解析器未能生成 Alert')
  if (alert.geoList && alert.geoList.length) {
    for (const g of alert.geoList) {
      if (Math.abs(g.lat) > 90 || Math.abs(g.lon) > 180) return failResult('value', 'circle 坐标越界：' + g.lat + ',' + g.lon)
    }
  }
  return okResult(alert)
}

/**
 * Wolfx 大陆地震预警（`cenc_eew`）。
 *
 * 时间判据用 `cnTimeToIso` 之后的串去解析：裸的 `2026-09-18 20:50:23` 交给 `Date.parse` 会按
 * **本机时区**解释，而它其实是北京时间——那样"客观不可能"这条判据就带上了本机时区的偏差。
 */
export function parseCencEewResult(raw) {
  if (!isPlainObject(raw)) return failResult('schema', '顶层不是对象')
  if (raw.type !== undefined && String(raw.type) !== 'cenc_eew') {
    return failResult('schema', 'type 不是 cenc_eew（收到 ' + String(raw.type) + '）')
  }
  // empty 判据：10 个字段一个都没有。理由见 SOURCE_CONTRACTS.cenc_eew.empty。
  const fields = ['ID', 'EventID', 'OriginTime', 'ReportTime', 'Latitude', 'Longitude', 'Magnitude', 'Depth', 'MaxIntensity', 'HypoCenter']
  const hasAny = fields.some((k) => {
    const v = raw[k]
    return v !== undefined && v !== null && String(v) !== ''
  })
  if (!hasAny) return failResult('empty', '载荷里没有任何预警字段（源正常但当前没有预警）')
  const id = raw.ID
  if (typeof id !== 'string' || !id.trim()) return failResult('schema', '缺少 ID（string）')
  const lat = numOf(raw.Latitude)
  const lon = numOf(raw.Longitude)
  if (lat === null || lon === null) return failResult('schema', '缺少 Latitude / Longitude（数值）')
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return failResult('value', '震中坐标越界：' + lat + ',' + lon)
  if (numOf(raw.Magnitude) === null) return failResult('schema', '缺少 Magnitude（数值）')
  const t = timeMsOf(cnTimeToIso(raw.OriginTime))
  if (t === null) return failResult('schema', '缺少 OriginTime（可解析的北京时间）')
  if (timeIsImpossible(t)) return failResult('value', '发震时刻客观不可能：' + String(raw.OriginTime))
  const alert = parseCencEew(raw)
  if (!alert) return failResult('schema', '解析器未能生成 Alert（结构通过校验但字段映射失败）')
  return okResult(alert)
}

/**
 * 速报整表里的单项（`NoN`）。逐条过契约，便于定位"哪一项坏了"。
 * 注意：单项失败**不等于整表坏**——批量语义见 parseCencEqlistResult。
 */
export function parseCencEqlistItemResult(item) {
  if (!isPlainObject(item)) return failResult('schema', '速报项不是对象')
  const eventId = item.EventID
  if (typeof eventId !== 'string' || !eventId.trim()) return failResult('schema', '缺少 EventID（string）')
  const lat = numOf(item.latitude)
  const lon = numOf(item.longitude)
  if (lat === null || lon === null) return failResult('schema', '缺少 latitude / longitude（数字字符串或数值）')
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return failResult('value', '震中坐标越界：' + lat + ',' + lon)
  if (numOf(item.magnitude) === null) return failResult('schema', '缺少 magnitude（数字字符串或数值）')
  const t = timeMsOf(cnTimeToIso(item.time))
  if (t === null) return failResult('schema', '缺少 time（可解析的北京时间）')
  if (timeIsImpossible(t)) return failResult('value', '发震时刻客观不可能：' + String(item.time))
  const alert = parseCencEqlistItem(item)
  if (!alert) return failResult('schema', '解析器未能生成 Alert（结构通过校验但字段映射失败）')
  return okResult(alert)
}

/**
 * 速报整表 → 批量结果 `{ ok, alerts, dropped, md5 }`。
 *
 * 坏的条目逐条丢弃并计数（`dropped`，不是静默），只有一条都没解析出来才判整表 schema——
 * 一条缺坐标就让整表作废等于漏掉其余真实地震。整表一条都没有则判 empty。
 */
export function parseCencEqlistResult(json) {
  if (!isPlainObject(json)) return failResult('schema', '顶层不是对象')
  if (json.type !== undefined && String(json.type) !== 'cenc_eqlist') {
    return failResult('schema', 'type 不是 cenc_eqlist（收到 ' + String(json.type) + '）')
  }
  const items = cencEqlistItems(json)
  if (items.length === 0) return failResult('empty', '整表里没有 NoN 条目（源正常但当前没有速报数据）')
  const alerts = []
  let dropped = 0
  let firstDetail = ''
  for (const it of items) {
    const res = parseCencEqlistItemResult(it)
    if (res.ok) { alerts.push(res.alert); continue }
    if (res.kind === 'empty') continue
    dropped++
    if (!firstDetail) firstDetail = res.kind + '：' + res.detail
  }
  if (alerts.length === 0) {
    return failResult('schema', '整表 ' + items.length + ' 条全部无法解析（' + firstDetail + '）')
  }
  return { ok: true, alerts, dropped, md5: cencEqlistMd5Of(json), total: items.length }
}

/**
 * 中央气象台预警（`nmc_alarm`）。
 *
 * `title` 里**必须**能解析出机构名——匹配依赖它。灾种不在范围内时判 empty 而不是 schema：
 * Host 已按灾种过滤，正常收不到，判 empty 使"Host 将来转发更多灾种"对旧 Client 是静默跳过。
 */
export function parseNmcAlarmResult(raw) {
  if (!isPlainObject(raw)) return failResult('schema', '顶层不是对象')
  const alertid = String(raw.alertid === undefined || raw.alertid === null ? '' : raw.alertid).trim()
  if (!alertid) return failResult('schema', '缺少 alertid（string）')
  if (typeof raw.kind !== 'string' || !raw.kind) return failResult('schema', '缺少 kind（string）')
  // 查表一律走 own()：`NMC_KIND_TEXT['constructor']` 会命中原型链返回 Object 构造函数（truthy），
  // 于是 `kind: 'constructor'` 这样的格式不合法的数据会绕过 empty / schema 判据被放行。Host 的 JSON 属于
  // 不可信输入，不能直查。
  if (!own(NMC_KIND_TEXT, raw.kind)) return failResult('empty', '灾种不在本插件范围内：' + raw.kind)
  if (typeof raw.level !== 'string' || !own(NMC_LEVEL_TEXT, raw.level)) {
    return failResult('schema', '缺少或无法识别的 level：' + String(raw.level))
  }
  const title = String(raw.title === undefined || raw.title === null ? '' : raw.title).trim()
  if (!title) return failResult('schema', '缺少 title（string）')
  if (!orgOf(title)) return failResult('schema', 'title 里解析不出发布机构（形如「…气象台发布…」）')
  const t = timeMsOf(raw.issued)
  if (t === null) return failResult('schema', '缺少 issued（可解析的 ISO 时间）')
  if (timeIsImpossible(t)) return failResult('value', '发布时间客观不可能：' + String(raw.issued))
  const alert = parseNmcAlarm(raw)
  if (!alert) return failResult('schema', '解析器未能生成 Alert（结构通过校验但字段映射失败）')
  return okResult(alert)
}

/**
 * 美国 NWS 洪水类预警（`nws_alerts`）。
 *
 * `opts.place` 是取数器查这条时用的关注点——它让匹配层不必再算距离。判据顺序：先把
 * "不在范围内"与"结构不符"分开，再交给解析器（单一实现）。
 */
export function parseNwsAlertResult(raw, opts) {
  if (!isPlainObject(raw)) return failResult('schema', '顶层不是对象')
  const p = raw.properties
  if (!isPlainObject(p)) return failResult('schema', '缺少 properties（对象）')
  const event = typeof p.event === 'string' ? p.event : ''
  // 走 own()：`event: 'constructor'` 这类键直查会命中原型链返回函数对象（truthy），
  // 于是格式不合法的数据绕过白名单被放行（与 nmc 查表是同一个坑）。
  if (!own(NWS_EVENT_WHITELIST, event)) {
    return failResult('empty', '事件类型不在本插件范围内：' + (event || '(空)'))
  }
  const id = String(p.id === undefined || p.id === null ? (raw.id || '') : p.id).trim()
  if (!id) return failResult('schema', '缺少 properties.id（CAP identifier）')
  const t = timeMsOf(p.sent)
  if (t === null) return failResult('schema', '缺少或无法解析 properties.sent（ISO 时间）')
  if (timeIsImpossible(t)) return failResult('value', '发布时间客观不可能：' + String(p.sent))
  const alert = parseNwsAlert(raw, opts)
  if (!alert) return failResult('schema', '解析器未能生成 Alert（结构通过校验但字段映射失败）')
  return okResult(alert)
}

/**
 * 加拿大 ECCC 预警（`eccc_alerts`）。
 *
 * 两道过滤器都在契约层做（与解析器里的同一份名单），让"不在范围内"在**进入解析器之前**就有
 * 明确归类，而不是靠解析器返回 null 再反推是 schema 还是 empty。
 */
export function parseEcccAlertResult(raw, opts) {
  if (!isPlainObject(raw)) return failResult('schema', '顶层不是对象')
  const p = raw.properties
  if (!isPlainObject(p)) return failResult('schema', '缺少 properties（对象）')
  const type = typeof p.alert_type === 'string' ? p.alert_type : ''
  if (type !== 'warning') {
    return failResult('empty', 'ECCC 的 ' + (type || '(空类型)') + ' 不在本插件接的范围内（advisory 按官方定义是非危险天气）')
  }
  const nameEn = typeof p.alert_name_en === 'string' ? p.alert_name_en.trim() : ''
  if (!nameEn) return failResult('schema', '缺少 alert_name_en（string）')
  // 先排除、再包含——与 05h 里的顺序一致。
  if (ECCC_EXCLUDE.test(nameEn) || !ECCC_INCLUDE.test(nameEn)) {
    return failResult('empty', '灾种不在本插件范围内：' + nameEn)
  }
  const code = typeof p.alert_code === 'string' ? p.alert_code.trim() : ''
  if (!code) return failResult('schema', '缺少 alert_code（string）')
  const t = timeMsOf(p.publication_datetime)
  if (t === null) return failResult('schema', '缺少或无法解析 publication_datetime')
  if (timeIsImpossible(t)) return failResult('value', '发布时间客观不可能：' + String(p.publication_datetime))
  const colour = typeof p.risk_colour_en === 'string' ? p.risk_colour_en.toLowerCase() : ''
  if (!own(ECCC_COLOUR_SEVERITY, colour)) {
    return failResult('schema', 'risk_colour_en 缺失或越界：' + String(p.risk_colour_en))
  }
  const alert = parseEcccAlert(raw, opts)
  if (!alert) return failResult('schema', '解析器未能生成 Alert（结构通过校验但字段映射失败）')
  return okResult(alert)
}
