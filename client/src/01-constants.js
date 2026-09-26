// ============================================================================
// dsh-quake-alert · client/src/01-constants.js
//
// 作用：唯一的常量与默认配置来源（React 依赖也在这里引入）。
// 内容：震度文案与档位、海啸等级与排序、47 都道府县表、简写→全称映射、
//       默认配置 DEFAULT_CFG、存储 key、重连参数、历史上限等全部共享常量。
// 依赖：00-i18n（语言清单与显示名）。
// 新增常量请优先放这里，避免散落到各功能文件里。
// ============================================================================

// ---------- 依赖 ----------
import React from 'react'
import { LANGS, LANGUAGE_LABELS, getLanguage } from './00-i18n.js'
import { PREF_EN } from './00d-texts-regions.js'
const h = React.createElement
const { useState, useEffect, useRef } = React

// ---------- 常量 ----------
const WS_URL = 'wss://api.p2pquake.net/v2/ws'
const SANDBOX_URL = 'wss://api-realtime-sandbox.p2pquake.net/v2/ws'
// 全球地震（0.4.0）：EMSC 的实时推送通道。它是少数提供 WebSocket 的全球地震源
// （USGS / GDACS 都只有轮询），因此在全球链路上复用与 P2PQuake 相同的连接管理。
const EMSC_WS_URL = 'wss://www.seismicportal.eu/standing_order/websocket'
const STORAGE_KEY = 'dsh.quakeAlert.v1'
const HISTORY_KEY = 'dsh.quakeAlert.history'
// 源健康记录（0.5.3）：**唯一**一处跨刷新保留的运行时状态。它存的是"某个源的解析在什么时候
// 因为什么失败了"——蓝点是"用户处理不了、等插件更新"的信号，刷新页面就消失会让它没人看见
// （DESIGN 11.9 A）。连接状态不在这里：重启即重新建连，旧值没有意义。
const HEALTH_KEY = 'dsh.quakeAlert.health'
const HISTORY_MAX = 30 // 「最近预警」保留条数（内存与设置页展示）
const MAX_WATCH_CITIES = 300 // 关注市区町村上限（防止配置与 UI 被撑爆）
// 全球关注点上限：每个点带名字、经纬度与半径，几十个点就足够覆盖"我住哪、家人在哪"，
// 再多说明用法不对（那是一张地图，不是一份关注列表）。
const MAX_WATCH_PLACES = 20
const RECONNECT_BASE = 1000 // 指数退避起点 1s
const RECONNECT_MAX = 60000 // 封顶 60s

const SCALE_TEXT = {
  10: '震度1', 20: '震度2', 30: '震度3', 40: '震度4',
  45: '震度5弱', 46: '震度5弱以上', 50: '震度5强', 55: '震度6弱',
  60: '震度6强', 70: '震度7',
}
// 用户可选的最低震度档位（值 = P2PQuake scale 数值）。
// 选项的**文字**搬去了 `00e-texts-units.js`（三语），这里只留「值 → 文案 key」：下拉在渲染时
// 取词，而模块级常量里的文字会在加载那一刻被固化（切语言就不跟着变）。
const SCALE_OPTIONS = [
  { v: 10, labelKey: 'scaleOpt.10' }, { v: 20, labelKey: 'scaleOpt.20' }, { v: 30, labelKey: 'scaleOpt.30' },
  { v: 40, labelKey: 'scaleOpt.40' }, { v: 45, labelKey: 'scaleOpt.45' }, { v: 50, labelKey: 'scaleOpt.50' },
  { v: 55, labelKey: 'scaleOpt.55' }, { v: 60, labelKey: 'scaleOpt.60' }, { v: 70, labelKey: 'scaleOpt.70' },
]
const TSUNAMI_RANK = { Watch: 1, Warning: 2, MajorWarning: 3 }
const TSUNAMI_GRADE_TEXT = { Watch: '津波注意报', Warning: '海啸警报', MajorWarning: '大海啸警报' }
const TSUNAMI_OPTIONS = [
  { g: 'Watch', labelKey: 'tsunamiOpt.Watch' },
  { g: 'Warning', labelKey: 'tsunamiOpt.Warning' },
  { g: 'MajorWarning', labelKey: 'tsunamiOpt.MajorWarning' },
]
// 全球源（EMSC / USGS）的最低震级。全球目录里 M2.5+ 每天近百条，而用户真正关心的是
// "我这附近有没有明显晃动"——M4.5 是全球速报的常用门槛，默认取它。
const GLOBAL_MAG_OPTIONS = [
  { v: 3, labelKey: 'magOpt.3' }, { v: 3.5, labelKey: 'magOpt.3.5' }, { v: 4, labelKey: 'magOpt.4' },
  { v: 4.5, labelKey: 'magOpt.4.5' }, { v: 5, labelKey: 'magOpt.5' }, { v: 5.5, labelKey: 'magOpt.5.5' },
  { v: 6, labelKey: 'magOpt.6' }, { v: 6.5, labelKey: 'magOpt.6.5' }, { v: 7, labelKey: 'magOpt.7' },
]
// 大陆**地震速报**（cenc_eqlist）的最低震级。与预警分开的原因见 DESIGN 8.4：速报覆盖低到 M2.5，
// 用预警阈值播报会被小震频繁打扰；而它又是 EEW 稀少时的唯一补报通道，所以两把旋钮而不是一把。
// 档位比 GLOBAL_MAG_OPTIONS 少一档低值（M3.0）——大陆速报的取舍区间在 3.5–6.0。
const CN_REPORT_MAG_OPTIONS = [
  { v: 3.5, labelKey: 'magOpt.3.5' }, { v: 4, labelKey: 'magOpt.4' },
  { v: 4.5, labelKey: 'magOpt.4.5' }, { v: 5, labelKey: 'magOpt.5' },
  { v: 5.5, labelKey: 'magOpt.5.5' }, { v: 6, labelKey: 'magOpt.6' },
]

// ---------- 关注点半径（0.5.0 / DESIGN 9.2） ----------
// 用语义标签而不是裸数字：普通用户不必理解"公里"，想精确控制的人有「自定义」这个出口。
// 「本市及周边 100km」是**新建关注点**的默认值（旧值 300km 是为震中距设计的，
// 套在城市上会把邻省地震也算进来）。既有配置里的 radiusKm 一律不动——
// 静默把用户配好的半径从 300 改成 100 会让提醒变窄，那是漏报方向的变化。
const RADIUS_PRESETS = [
  { v: 30, labelKey: 'radius.30' },
  { v: 100, labelKey: 'radius.100' },
  { v: 300, labelKey: 'radius.300' },
]
/** 新建关注点的默认半径（既有配置不动，见上）。 */
const DEFAULT_PLACE_RADIUS_KM = 100
/** 半径上下限，与 Host schema / normalizeCfg 的 1–2000 保持一致。 */
const MIN_PLACE_RADIUS_KM = 1
const MAX_PLACE_RADIUS_KM = 2000

// 日本 47 都道府县：jp 为匹配用日文全称（P2PQuake pref 格式），zh 为界面显示
const PREFECTURES = [
  ['北海道', '北海道'], ['青森県', '青森'], ['岩手県', '岩手'], ['宮城県', '宫城'],
  ['秋田県', '秋田'], ['山形県', '山形'], ['福島県', '福岛'], ['茨城県', '茨城'],
  ['栃木県', '栃木'], ['群馬県', '群马'], ['埼玉県', '埼玉'], ['千葉県', '千叶'],
  ['東京都', '东京'], ['神奈川県', '神奈川'], ['新潟県', '新潟'], ['富山県', '富山'],
  ['石川県', '石川'], ['福井県', '福井'], ['山梨県', '山梨'], ['長野県', '长野'],
  ['岐阜県', '岐阜'], ['静岡県', '静冈'], ['愛知県', '爱知'], ['三重県', '三重'],
  ['滋賀県', '滋贺'], ['京都府', '京都'], ['大阪府', '大阪'], ['兵庫県', '兵库'],
  ['奈良県', '奈良'], ['和歌山県', '和歌山'], ['鳥取県', '鸟取'], ['島根県', '岛根'],
  ['岡山県', '冈山'], ['広島県', '广岛'], ['山口県', '山口'], ['徳島県', '德岛'],
  ['香川県', '香川'], ['愛媛県', '爱媛'], ['高知県', '高知'], ['福岡県', '福冈'],
  ['佐賀県', '佐贺'], ['長崎県', '长崎'], ['熊本県', '熊本'], ['大分県', '大分'],
  ['宮崎県', '宫崎'], ['鹿児島県', '鹿儿岛'], ['沖縄県', '冲绳'],
].map(([jp, zh]) => ({ jp, zh }))
const PREF_SET = new Set(PREFECTURES.map((p) => p.jp))
// 都道府県コード → 都道府県名。PREFECTURES 的顺序就是 JIS 码 01..47（01 北海道 … 47 沖縄県），
// 気象庁电文里的区域码前两位正是都道府県码：细分区 宗谷北部=011011、市町村 北九州市=4010000。
// 判县因此优先用 code 而不是名称——名称有 25 例同名跨县（伊達市 北海道/福島県、川崎町 宮城県/福岡県…），
// 且已改制的旧名会把历史电文里的区域认到别的县（福岡県「那珂川町」曾落到栃木県那珂川町）。
const PREF_BY_CODE = {}
PREFECTURES.forEach((p, i) => { PREF_BY_CODE[String(i + 1).padStart(2, '0')] = p.jp })
/** 区域码 → 都道府県名（取前两位；认不出返回空字符串）。 */
function prefOfCode(code) {
  const s = String(code === undefined || code === null ? '' : code).trim()
  if (!/^\d{4,}$/.test(s)) return ''
  const hit = PREF_BY_CODE[s.slice(0, 2)]
  return hit || ''
}
/** 都道府県名 → 2 位都道府県码（认不出返回空字符串）。测试电文按关注地区构造时用。 */
function prefCodeOf(pref) {
  const i = PREFECTURES.findIndex((p) => p.jp === pref)
  return i === -1 ? '' : String(i + 1).padStart(2, '0')
}
// 都道府県简写 → 全称：551 的 points[].pref 通常是全称，但实测直播数据里出现过「京都」
// 这类简写，不归一就会与用户勾选的「京都府」永不相等（静默漏报）。
const PREF_SHORT = {}
for (const p of PREFECTURES) {
  const short = p.jp.replace(/[都道府県]$/, '')
  if (short !== p.jp && !Object.prototype.hasOwnProperty.call(PREF_SHORT, short)) PREF_SHORT[short] = p.jp
}
function normalizePref(raw) {
  const s = String(raw === undefined || raw === null ? '' : raw).trim()
  if (!s || PREF_SET.has(s)) return s
  return Object.prototype.hasOwnProperty.call(PREF_SHORT, s) ? PREF_SHORT[s] : s
}

/**
 * 都道府县的**显示名**（随界面语言变）。
 *
 * `PREFECTURES` 里的 `jp` 是**匹配用的**（P2PQuake 的 `pref` 就是这个形状，`PREF_SET` /
 * `PREF_SHORT` 都从它派生），所以显示不能复用它——`zh` 那一栏只是"中文界面用哪几个字"。
 * 这个函数负责挑出"给人看的那一份"：日文界面用原名，中文界面用中文名，英文界面用罗马字
 * （`PREF_EN`）。三国语言都不缺项时，三种语言下看到的名字是同一份数据的三种写法。
 *
 * 认不出的**原样返回**：调用方也会把源里的 `pref` 直接传进来，那里可能是简写或空值，
 * 不该被这里改写（简写归一由 normalizePref 负责，两件事分开）。
 */
function prefLabelOf(pref) {
  const s = String(pref === undefined || pref === null ? '' : pref).trim()
  if (!s) return ''
  const hit = PREFECTURES.find((p) => p.jp === s)
  if (!hit) return s
  const lang = getLanguage()
  if (lang === 'ja') return hit.jp
  if (lang === 'en') return PREF_EN[hit.jp] || hit.jp
  return hit.zh
}

// ---------- 时间：源时区 → 带偏移的 ISO 8601（DESIGN 第 4 节） ----------
// 各源给的时间字符串**自己不带时区信息**——P2PQuake 是 JST（"2023/09/05 06:16:32"），
// 单看字符串完全看不出这是哪里的本地时间。所以解析器负责把它转成带偏移的 ISO 8601
// （"2023-09-05T06:16:32+09:00"），UI 只按**本地时区**渲染（Intl.DateTimeFormat）。
// 不做这一步，大陆浏览器上会显示一个比本地时间早 1 小时、且没有任何标注的时间戳。
// 其余源本身就是绝对时间，无需转换：JMA 的 ReportDateTime 带 +09:00、USGS 是 epoch 毫秒、
// EMSC 的时间带 Z、NOAA CAP 的 <sent> 带偏移。
// 历史记录里的**旧数据**没有偏移（0.4.1 之前写入的），一律按 JST 解释——旧数据只可能来自
// P2PQuake 这一条链路（见 issuedToDate）。
const P2P_TZ_OFFSET = '+09:00'
const P2P_TIME_RE = /^(\d{4})\/(\d{2})\/(\d{2})[ T](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?$/
/** P2PQuake 的裸 JST 时间串 → 带 +09:00 偏移的 ISO 8601；认不出时**原样返回**（绝不丢信息）。 */
function p2pTimeToIso(raw) {
  const s = String(raw === undefined || raw === null ? '' : raw).trim()
  if (!s) return ''
  const m = P2P_TIME_RE.exec(s)
  if (!m) return s
  const ms = m[7] ? m[7].padEnd(3, '0').slice(0, 3) : ''
  return m[1] + '-' + m[2] + '-' + m[3] + 'T' + m[4] + ':' + m[5] + ':' + m[6] +
    (ms ? '.' + ms : '') + P2P_TZ_OFFSET
}
// ---------- 大陆源：中国标准时间（CST，UTC+8，无夏令时） ----------
// Wolfx 的 `cenc_eew` / `cenc_eqlist` 给的是裸北京时间，形如 `2026-09-18 20:50:23`——与 P2PQuake
// 的 `2023/09/05 06:16:32` **只有分隔符不同**，光看字符串完全无法区分是 JST 还是 CST（DESIGN 4.5）。
// 所以同样由解析器补偏移，UI 只按本地时区渲染。中国全境单一时区、无夏令时，偏移恒为 +08:00。
const CN_TZ_OFFSET = '+08:00'
const CN_TIME_RE = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?$/
/** 大陆源的裸北京时间串 → 带 +08:00 偏移的 ISO 8601；认不出时**原样返回**（绝不丢信息）。 */
function cnTimeToIso(raw) {
  const s = String(raw === undefined || raw === null ? '' : raw).trim()
  if (!s) return ''
  const m = CN_TIME_RE.exec(s)
  if (!m) return s
  const ms = m[7] ? m[7].padEnd(3, '0').slice(0, 3) : ''
  return m[1] + '-' + m[2] + '-' + m[3] + 'T' + m[4] + ':' + m[5] + ':' + m[6] +
    (ms ? '.' + ms : '') + CN_TZ_OFFSET
}
/** 时间串 → Date：裸 JST（P2PQuake）/ 裸北京时间（Wolfx）分别按各自偏移解释，其余交给 Date。
 *  两个源的时间串**看起来只差分隔符**，所以这里是按各自的正则分别补偏移，不能只判一种。
 *  漏掉大陆源那一支会让历史详情里的时间差 1 小时（且没有任何标注）。 */
function issuedToDate(raw) {
  const s = String(raw === undefined || raw === null ? '' : raw).trim()
  if (!s) return null
  const d = new Date(P2P_TIME_RE.test(s) ? p2pTimeToIso(s) : (CN_TIME_RE.test(s) ? cnTimeToIso(s) : s))
  return Number.isFinite(d.getTime()) ? d : null
}
/** 时间串 → 本地时区文案（历史详情用）；无法解析时原样返回，不把原文弄丢。 */
function formatIssuedLocal(raw) {
  const d = issuedToDate(raw)
  if (!d) return String(raw === undefined || raw === null ? '' : raw)
  try {
    return new Intl.DateTimeFormat(undefined, {
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
    }).format(d)
  } catch (err) { return d.toISOString() }
}

// ---------- 界面语言（0.8.1 立契约，0.9.0 由 00-i18n 提供） ----------
// 选项**从 00-i18n 的语言清单派生**，不在这里另写一份：加一种语言只改 00-i18n 的 LANGS
// 与 LANGUAGE_LABELS、再补一份文案表，配置契约（DEFAULT_CFG → normalizeCfg → Host schema）
// 一行都不用动。值用 BCP 47 的完整标识（zh-CN / ja / en），与三语 README 对齐。
const LANGUAGE_OPTIONS = LANGS.map((v) => ({ v, label: LANGUAGE_LABELS[v] }))

const DEFAULT_CFG = {
  version: 1,
  source: 'prod', // prod | sandbox（沙箱回放 2023 年历史，约30秒/条，测试用）
  // 大陆源的**链路选择**（0.5.0）：auto = SSE 优先、走不通自动降级为轮询；
  // poll = 用户强制轮询。给出口的理由见 DESIGN 11.5——某些网络下长连接会被中间设备掐掉，
  // 而"自动降级"判不出的那几种（能连上、偶尔漏、但整体像坏的）需要一个手动出口。
  cnTransport: 'auto',
  // 两种关注模式并存：
  //   · 行政区（prefectures / cities）——日本源（P2PQuake、気象庁）用，粒度到市区町村
  //   · 坐标点（places）——全球源（EMSC / USGS / NOAA）用，判定方式是「震中距 ≤ radiusKm」
  // 两者互不影响：日本用户不用配 places，全球用户不用配 prefectures。
  watch: { prefectures: [], cities: [], places: [] },
  disasters: { earthquake: true, tsunami: true, weather: true, cnRainstorm: true, cnGeology: true, overseasWeather: true }, // weather = 日本气象灾害（泥石流 / 洪水 / 大雨 / 高潮…），固定 L4 以上播报；cnRainstorm / cnGeology = 中国大陆气象灾害（0.5.2），固定橙色以上播报；overseasWeather = 海外气象灾害（0.6.0，美国 NWS + 加拿大 ECCC），一个开关覆盖两个"按关注点生效"的源
  // globalMagnitude：全球源（EMSC / USGS）的最低震级。日本源用的是震度（quakeScale），
  // 全球源只有震级——实测 EMSC 会推 M3.8 级别的事件，若沿用"来什么报什么"会明显吵闹。
  // cnReportMagnitude：大陆**速报**（cenc_eqlist）的独立震级门槛。大陆地震预警（cenc_eew）与
  // 全球源共用 globalMagnitude（DESIGN 8.4）——它同样是"只有震级、没有分区烈度"的坐标型源。
  thresholds: {
    quakeScale: 40, eewScale: 45, tsunamiGrade: 'Watch',
    globalMagnitude: 4.5, cnReportMagnitude: 4.5,
  },
  notify: { sound: true, system: true, volume: 0.7 },
  dedupe: { windowMinutes: 10 },
  // 静默时段（0.2.0）：按浏览器本地时间判定；跨午夜用 start > end 表示（如 23:00–07:00）
  quietHours: { enabled: false, start: '23:00', end: '07:00', breakForSevere: true },
  // 界面语言（0.8.1 先立字段，本地化在 0.9.0）。**放在末尾是有意的**：Host schema 的字段顺序
  // 也要跟着一致——那条"Host 默认值与 Client DEFAULT_CFG 完全一致"的断言是 JSON.stringify
  // 全量比较，顺序不同就会红。
  language: 'zh-CN',
}


export { React, h, useState, useEffect, useRef, WS_URL, SANDBOX_URL, EMSC_WS_URL, STORAGE_KEY, HISTORY_KEY, HEALTH_KEY, HISTORY_MAX, MAX_WATCH_CITIES, MAX_WATCH_PLACES, RECONNECT_BASE, RECONNECT_MAX, SCALE_TEXT, SCALE_OPTIONS, TSUNAMI_RANK, TSUNAMI_GRADE_TEXT, TSUNAMI_OPTIONS, GLOBAL_MAG_OPTIONS, CN_REPORT_MAG_OPTIONS, RADIUS_PRESETS, DEFAULT_PLACE_RADIUS_KM, MIN_PLACE_RADIUS_KM, MAX_PLACE_RADIUS_KM, LANGUAGE_OPTIONS, PREFECTURES, PREF_SET, PREF_SHORT, PREF_BY_CODE, prefOfCode, prefCodeOf, normalizePref, prefLabelOf, P2P_TZ_OFFSET, P2P_TIME_RE, p2pTimeToIso, CN_TZ_OFFSET, CN_TIME_RE, cnTimeToIso, issuedToDate, formatIssuedLocal, DEFAULT_CFG }
