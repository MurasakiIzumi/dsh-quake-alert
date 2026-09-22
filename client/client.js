window.__ModuleLoader__.load({ id: "dsh-quake-alert", factory: (require) => {
var module = { exports: {} }; var exports = module.exports;

/**
 * dsh-quake-alert client bundle —— 由 scripts/build-client.mjs (rollup) 从 client/src/*.js 打包生成。
 * 请勿直接编辑本文件：改 client/src/ 下的 ESM 模块（每个文件头部写了职责与依赖），再运行 pnpm build。
 *
 * 灾害预警：DSH 使用期间，P2PQuake WebSocket 实时推送日本地震 / 海啸信息，
 * 按「关注都道府县 / 市区町村 + 震度 / 海啸等级阈值」匹配命中后提醒：
 *   - 页面可见 → 页内 toast；页面后台 → 系统通知；命中时播放合成提示音
 *   - 设置页：设置 → 灾害预警（关注地区 / 阈值 / 音量 / 静默时段 / 测试）
 *   - 配置：Host settings（settings.yaml）为主，localStorage 为镜像与回退
 *   - 免责：数据由 P2PQuake 转播，EEW 等仅供参考，请以气象厅官方发布为准
 *
 * DSH 客户端 bundle 必须是单文件（扁平模块图：一个 bundle = 一个模块节点）。
 */

'use strict';

var React = require('react');

// ============================================================================
// dsh-quake-alert · client/src/01-constants.js
//
// 作用：唯一的常量与默认配置来源（React 依赖也在这里引入）。
// 内容：震度文案与档位、海啸等级与排序、47 都道府县表、简写→全称映射、
//       默认配置 DEFAULT_CFG、存储 key、重连参数、历史上限等全部共享常量。
// 依赖：无（本文件必须最先拼接）。
// 新增常量请优先放这里，避免散落到各功能文件里。
// ============================================================================

const h = React.createElement;
const { useState, useEffect, useRef } = React;

// ---------- 常量 ----------
const WS_URL = 'wss://api.p2pquake.net/v2/ws';
const SANDBOX_URL = 'wss://api-realtime-sandbox.p2pquake.net/v2/ws';
// 全球地震（0.4.0）：EMSC 的实时推送通道。它是少数提供 WebSocket 的全球地震源
// （USGS / GDACS 都只有轮询），因此在全球链路上复用与 P2PQuake 相同的连接管理。
const EMSC_WS_URL = 'wss://www.seismicportal.eu/standing_order/websocket';
const STORAGE_KEY = 'dsh.quakeAlert.v1';
const HISTORY_KEY = 'dsh.quakeAlert.history';
// 源健康记录（0.5.3）：**唯一**一处跨刷新保留的运行时状态。它存的是"某个源的解析在什么时候
// 因为什么失败了"——蓝点是"用户处理不了、等插件更新"的信号，刷新页面就消失会让它没人看见
// （DESIGN 11.9 A）。连接状态不在这里：重启即重新建连，旧值没有意义。
const HEALTH_KEY = 'dsh.quakeAlert.health';
const HISTORY_MAX = 30; // 「最近预警」保留条数（内存与设置页展示）
const MAX_WATCH_CITIES = 300; // 关注市区町村上限（防止配置与 UI 被撑爆）
// 全球关注点上限：每个点带名字、经纬度与半径，几十个点就足够覆盖"我住哪、家人在哪"，
// 再多说明用法不对（那是一张地图，不是一份关注列表）。
const MAX_WATCH_PLACES = 20;
const RECONNECT_BASE = 1000; // 指数退避起点 1s
const RECONNECT_MAX = 60000; // 封顶 60s

const SCALE_TEXT = {
  10: '震度1', 20: '震度2', 30: '震度3', 40: '震度4',
  45: '震度5弱', 46: '震度5弱以上', 50: '震度5强', 55: '震度6弱',
  60: '震度6强', 70: '震度7',
};
// 用户可选的最低震度档位（值 = P2PQuake scale 数值）
const SCALE_OPTIONS = [
  { v: 10, label: '震度1 以上' }, { v: 20, label: '震度2 以上' }, { v: 30, label: '震度3 以上' },
  { v: 40, label: '震度4 以上' }, { v: 45, label: '震度5弱 以上' }, { v: 50, label: '震度5强 以上' },
  { v: 55, label: '震度6弱 以上' }, { v: 60, label: '震度6强 以上' }, { v: 70, label: '震度7' },
];
const TSUNAMI_RANK = { Watch: 1, Warning: 2, MajorWarning: 3 };
const TSUNAMI_GRADE_TEXT = { Watch: '津波注意报', Warning: '海啸警报', MajorWarning: '大海啸警报' };
const TSUNAMI_OPTIONS = [
  { g: 'Watch', label: '注意报及以上' }, { g: 'Warning', label: '警报及以上' }, { g: 'MajorWarning', label: '仅大海啸警报' },
];
// 全球源（EMSC / USGS）的最低震级。全球目录里 M2.5+ 每天近百条，而用户真正关心的是
// "我这附近有没有明显晃动"——M4.5 是全球速报的常用门槛，默认取它。
const GLOBAL_MAG_OPTIONS = [
  { v: 3, label: 'M3.0 以上' }, { v: 3.5, label: 'M3.5 以上' }, { v: 4, label: 'M4.0 以上' },
  { v: 4.5, label: 'M4.5 以上（默认）' }, { v: 5, label: 'M5.0 以上' }, { v: 5.5, label: 'M5.5 以上' },
  { v: 6, label: 'M6.0 以上' }, { v: 6.5, label: 'M6.5 以上' }, { v: 7, label: 'M7.0 以上' },
];
// 大陆**地震速报**（cenc_eqlist）的最低震级。与预警分开的原因见 DESIGN 8.4：速报覆盖低到 M2.5，
// 用预警阈值播报会被小震频繁打扰；而它又是 EEW 稀少时的唯一补报通道，所以两把旋钮而不是一把。
// 档位比 GLOBAL_MAG_OPTIONS 少一档低值（M3.0）——大陆速报的取舍区间在 3.5–6.0。
const CN_REPORT_MAG_OPTIONS = [
  { v: 3.5, label: 'M3.5 以上' }, { v: 4, label: 'M4.0 以上' },
  { v: 4.5, label: 'M4.5 以上（默认）' }, { v: 5, label: 'M5.0 以上' },
  { v: 5.5, label: 'M5.5 以上' }, { v: 6, label: 'M6.0 以上' },
];

// ---------- 关注点半径（0.5.0 / DESIGN 9.2） ----------
// 用语义标签而不是裸数字：普通用户不必理解"公里"，想精确控制的人有「自定义」这个出口。
// 「本市及周边 100km」是**新建关注点**的默认值（旧值 300km 是为震中距设计的，
// 套在城市上会把邻省地震也算进来）。既有配置里的 radiusKm 一律不动——
// 静默把用户配好的半径从 300 改成 100 会让提醒变窄，那是漏报方向的变化。
const RADIUS_PRESETS = [
  { v: 30, label: '仅本地（约 30 km）' },
  { v: 100, label: '本市及周边（约 100 km，默认）' },
  { v: 300, label: '较大范围（约 300 km）' },
];
/** 新建关注点的默认半径（既有配置不动，见上）。 */
const DEFAULT_PLACE_RADIUS_KM = 100;
/** 半径上下限，与 Host schema / normalizeCfg 的 1–2000 保持一致。 */
const MIN_PLACE_RADIUS_KM = 1;
const MAX_PLACE_RADIUS_KM = 2000;

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
].map(([jp, zh]) => ({ jp, zh }));
const PREF_SET = new Set(PREFECTURES.map((p) => p.jp));
// 都道府県コード → 都道府県名。PREFECTURES 的顺序就是 JIS 码 01..47（01 北海道 … 47 沖縄県），
// 気象庁电文里的区域码前两位正是都道府県码：细分区 宗谷北部=011011、市町村 北九州市=4010000。
// 判县因此优先用 code 而不是名称——名称有 25 例同名跨县（伊達市 北海道/福島県、川崎町 宮城県/福岡県…），
// 且已改制的旧名会把历史电文里的区域认到别的县（福岡県「那珂川町」曾落到栃木県那珂川町）。
const PREF_BY_CODE = {};
PREFECTURES.forEach((p, i) => { PREF_BY_CODE[String(i + 1).padStart(2, '0')] = p.jp; });
/** 区域码 → 都道府県名（取前两位；认不出返回空字符串）。 */
function prefOfCode(code) {
  const s = String(code === undefined || code === null ? '' : code).trim();
  if (!/^\d{4,}$/.test(s)) return ''
  const hit = PREF_BY_CODE[s.slice(0, 2)];
  return hit || ''
}
/** 都道府県名 → 2 位都道府県码（认不出返回空字符串）。测试电文按关注地区构造时用。 */
function prefCodeOf(pref) {
  const i = PREFECTURES.findIndex((p) => p.jp === pref);
  return i === -1 ? '' : String(i + 1).padStart(2, '0')
}
// 都道府県简写 → 全称：551 的 points[].pref 通常是全称，但实测直播数据里出现过「京都」
// 这类简写，不归一就会与用户勾选的「京都府」永不相等（静默漏报）。
const PREF_SHORT = {};
for (const p of PREFECTURES) {
  const short = p.jp.replace(/[都道府県]$/, '');
  if (short !== p.jp && !Object.prototype.hasOwnProperty.call(PREF_SHORT, short)) PREF_SHORT[short] = p.jp;
}
function normalizePref(raw) {
  const s = String(raw === undefined || raw === null ? '' : raw).trim();
  if (!s || PREF_SET.has(s)) return s
  return Object.prototype.hasOwnProperty.call(PREF_SHORT, s) ? PREF_SHORT[s] : s
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
const P2P_TZ_OFFSET = '+09:00';
const P2P_TIME_RE = /^(\d{4})\/(\d{2})\/(\d{2})[ T](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?$/;
/** P2PQuake 的裸 JST 时间串 → 带 +09:00 偏移的 ISO 8601；认不出时**原样返回**（绝不丢信息）。 */
function p2pTimeToIso(raw) {
  const s = String(raw === undefined || raw === null ? '' : raw).trim();
  if (!s) return ''
  const m = P2P_TIME_RE.exec(s);
  if (!m) return s
  const ms = m[7] ? m[7].padEnd(3, '0').slice(0, 3) : '';
  return m[1] + '-' + m[2] + '-' + m[3] + 'T' + m[4] + ':' + m[5] + ':' + m[6] +
    (ms ? '.' + ms : '') + P2P_TZ_OFFSET
}
// ---------- 大陆源：中国标准时间（CST，UTC+8，无夏令时） ----------
// Wolfx 的 `cenc_eew` / `cenc_eqlist` 给的是裸北京时间，形如 `2026-09-18 20:50:23`——与 P2PQuake
// 的 `2023/09/05 06:16:32` **只有分隔符不同**，光看字符串完全无法区分是 JST 还是 CST（DESIGN 4.5）。
// 所以同样由解析器补偏移，UI 只按本地时区渲染。中国全境单一时区、无夏令时，偏移恒为 +08:00。
const CN_TZ_OFFSET = '+08:00';
const CN_TIME_RE = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?$/;
/** 大陆源的裸北京时间串 → 带 +08:00 偏移的 ISO 8601；认不出时**原样返回**（绝不丢信息）。 */
function cnTimeToIso(raw) {
  const s = String(raw === undefined || raw === null ? '' : raw).trim();
  if (!s) return ''
  const m = CN_TIME_RE.exec(s);
  if (!m) return s
  const ms = m[7] ? m[7].padEnd(3, '0').slice(0, 3) : '';
  return m[1] + '-' + m[2] + '-' + m[3] + 'T' + m[4] + ':' + m[5] + ':' + m[6] +
    (ms ? '.' + ms : '') + CN_TZ_OFFSET
}
/** 时间串 → Date：裸 JST（P2PQuake）/ 裸北京时间（Wolfx）分别按各自偏移解释，其余交给 Date。
 *  两个源的时间串**看起来只差分隔符**，所以这里是按各自的正则分别补偏移，不能只判一种。
 *  漏掉大陆源那一支会让历史详情里的时间差 1 小时（且没有任何标注）。 */
function issuedToDate(raw) {
  const s = String(raw === undefined || raw === null ? '' : raw).trim();
  if (!s) return null
  const d = new Date(P2P_TIME_RE.test(s) ? p2pTimeToIso(s) : (CN_TIME_RE.test(s) ? cnTimeToIso(s) : s));
  return Number.isFinite(d.getTime()) ? d : null
}
/** 时间串 → 本地时区文案（历史详情用）；无法解析时原样返回，不把原文弄丢。 */
function formatIssuedLocal(raw) {
  const d = issuedToDate(raw);
  if (!d) return String(raw === undefined || raw === null ? '' : raw)
  try {
    return new Intl.DateTimeFormat(undefined, {
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
    }).format(d)
  } catch (err) { return d.toISOString() }
}

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
};

// ============================================================================
// dsh-quake-alert · client/src/02-storage.js
//
// 作用：浏览器侧存储层——localStorage 读写与配置归一化。
// 内容：JSON 安全读写、isPlainObject/numOr/boolOr/timeOr 等类型守卫、
//       normalizeCfg（任何脏输入都归一成一份合法配置）、loadCfg/saveCfg、
//       历史记录的字段规整（normalizeHistoryEntry / loadHistory）。
// 依赖：01-constants。
// ============================================================================


// ---------- 存储（localStorage） ----------
// 读入的数据可能被旧版本、其它脚本或用户手工改坏。所有读入都做类型校验，
// 任何异常都退回默认值——一条脏数据绝不能把整个插件拖崩（曾因 history 非数组
// 触发 loadJSON(...).slice is not a function，导致模块加载失败、设置页与连接全部消失）。
const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const numOr = (v, fallback, min, max) => {
  if (typeof v !== 'number' || !Number.isFinite(v)) return fallback
  if (typeof min === 'number' && v < min) return min
  if (typeof max === 'number' && v > max) return max
  return v
};
const boolOr = (v, fallback) => (typeof v === 'boolean' ? v : fallback);
// 「HH:MM」时间字符串校验（允许 1 位小时，如 "7:05"）
const TIME_RE = /^([01]?\d|2[0-3]):([0-5]\d)$/;
const timeOr = (v, fallback) => (typeof v === 'string' && TIME_RE.test(v.trim()) ? v.trim() : fallback);
const minutesOfTime = (v) => {
  const m = TIME_RE.exec(String(v === undefined || v === null ? '' : v).trim());
  return m ? Number(m[1]) * 60 + Number(m[2]) : null
};
// 静默时段判定。start > end 表示跨午夜（23:00–07:00）；start === end 视为「不静默」。
// now 可注入，便于回归测试覆盖边界而不依赖运行时刻。
function inQuietHours(cfg, now) {
  const q = cfg && cfg.quietHours;
  if (!q || q.enabled !== true) return false
  const start = minutesOfTime(q.start);
  const end = minutesOfTime(q.end);
  if (start === null || end === null || start === end) return false
  const d = now || new Date();
  const cur = d.getHours() * 60 + d.getMinutes();
  return start < end ? (cur >= start && cur < end) : (cur >= start || cur < end)
}

function loadJSON(key, fallback) {
  try {
    const s = window.localStorage.getItem(key);
    if (!s) return fallback
    const v = JSON.parse(s);
    return v === null || v === undefined ? fallback : v
  } catch (err) {
    return fallback
  }
}
function saveJSON(key, value) {
  try { window.localStorage.setItem(key, JSON.stringify(value)); } catch (err) { /* 容量/隐私模式忽略 */ }
}
// 历史记录必须是「对象数组」，且每个字段必须是渲染层能直接交给 React 的基本类型：
// 元素为 null 会抛错；字段是对象/数组则会让 React 抛「Objects are not valid as a React child」。
const strOr = (v, fallback) => (typeof v === 'string' ? v : (typeof v === 'number' || typeof v === 'boolean' ? String(v) : fallback));
function normalizeHistoryEntry(e, i) {
  const key = strOr(e.key, '') || strOr(e.id, '');
  return {
    key: key || 'legacy-' + i, // 早期版本可能没有 key，补一个稳定兜底键，保证 React key 与去重都可用
    id: strOr(e.id, ''),
    // code：区分来源用（'emsc'/'usgs'/'noaa'/'jma'/551…）。只看 kind 会把全球地震
    // （kind 也是 'quake'）标成「code 551」——与 0.3.2 修过的"气象条目被标成 code 551"同类。
    // 旧历史条目没有这个字段 → 空串，展示层回退到 kind 映射。
    code: strOr(e.code, ''),
    kind: strOr(e.kind, ''),
    label: strOr(e.label, ''),
    severity: strOr(e.severity, ''),
    issued: strOr(e.issued, ''),
    headline: strOr(e.headline, ''),
    pref: strOr(e.pref, ''),
    hit: e.hit === true,
    suppressed: e.suppressed === true,
    suppressedReason: strOr(e.suppressedReason, ''),
  }
}
function loadHistory() {
  const v = loadJSON(HISTORY_KEY, null);
  if (!Array.isArray(v)) return []
  return v.filter((e) => isPlainObject(e)).slice(0, HISTORY_MAX).map(normalizeHistoryEntry)
}
// 每次都返回全新对象：避免调用方改动嵌套字段时污染 DEFAULT_CFG 常量。
// 由 DEFAULT_CFG **深拷贝派生**（而不是手抄字段清单）：freshCfg 是 settingsOpsFor 判断
// "某字段是否等于默认值"的唯一基准，手抄的话以后给 DEFAULT_CFG 加字段而漏改这里，
// 新字段会被永久判为"非默认"，永远写进 settings.yaml 而永不 unset。
const cloneCfg = (v) => (Array.isArray(v)
  ? v.map(cloneCfg)
  : (isPlainObject(v) ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, cloneCfg(x)])) : v));
const freshCfg = () => cloneCfg(DEFAULT_CFG);
// 全球关注点：[{ name, lat, lon, radiusKm }]。坐标必须落在合法范围——脏数据里的 NaN 或
// 越界值会让距离计算得出无意义的结果，表现为"看起来配好了却永远不提醒"（静默漏报）。
// 半径夹在 1–2000 km；同一个点重复添加是常见操作，按经纬度（三位小数）去重。
function normalizePlaces(list) {
  const out = [];
  const seen = new Set();
  for (const p of list) {
    if (!isPlainObject(p)) continue
    // 用显式范围判断而不是 numOr：numOr 对越界值是**夹取**，而经纬度越界意味着这份数据本身
    // 是坏的（例如把半径填进了纬度列）。夹到边界会造出一个"看起来合法"的错误关注点。
    const lat = (typeof p.lat === 'number' && Number.isFinite(p.lat) && Math.abs(p.lat) <= 90) ? p.lat : null;
    const lon = (typeof p.lon === 'number' && Number.isFinite(p.lon) && Math.abs(p.lon) <= 180) ? p.lon : null;
    if (lat === null || lon === null) continue
    const key = lat.toFixed(3) + ',' + lon.toFixed(3);
    if (seen.has(key)) continue
    seen.add(key);
    out.push({
      name: strOr(p.name, '').slice(0, 30).trim() || (lat.toFixed(2) + ', ' + lon.toFixed(2)),
      lat,
      lon,
      radiusKm: numOr(p.radiusKm, 300, 1, 2000),
    });
    if (out.length >= MAX_WATCH_PLACES) break
  }
  return out
}
// 逐字段校验 + 回退默认值：任何形状的输入都归一成一份合法配置
function normalizeCfg(input) {
  // 兜底：调用方（loadCfg / sectionToCfg / applyCfg）都保证传对象，但归一化函数自己不该因为
  // 传进 null/undefined 就抛错——它的契约是"任何脏输入都能归一成一份合法配置"。
  const stored = isPlainObject(input) ? input : {};
  const w = isPlainObject(stored.watch) ? stored.watch : {};
  const d = isPlainObject(stored.disasters) ? stored.disasters : {};
  const t = isPlainObject(stored.thresholds) ? stored.thresholds : {};
  const n = isPlainObject(stored.notify) ? stored.notify : {};
  const de = isPlainObject(stored.dedupe) ? stored.dedupe : {};
  const qh = isPlainObject(stored.quietHours) ? stored.quietHours : {};
  return {
    version: DEFAULT_CFG.version,
    source: stored.source === 'sandbox' ? 'sandbox' : 'prod',
    // 大陆源的链路选择（0.5.0）：白名单，只认 'poll'，其余一律回 'auto'。
    // 用白名单而不是"非 poll 即 auto"的等价写法，是为了让将来加第三种取值时不会静默错位。
    cnTransport: stored.cnTransport === 'poll' ? 'poll' : 'auto',
    watch: {
      // 只保留 47 县中确实存在的名字，避免脏数据在设置页渲染出幽灵按钮
      prefectures: Array.isArray(w.prefectures)
        ? Array.from(new Set(w.prefectures.filter((p) => typeof p === 'string' && PREF_SET.has(p))))
        : [],
      // 市区町村：这里只保证类型、去重与规模；名字是否真实存在由数据表加载后校验
      cities: Array.isArray(w.cities)
        ? Array.from(new Set(w.cities.filter((c) => typeof c === 'string' && c.length > 0 && c.length <= 30))).slice(0, 300)
        : [],
      // 全球关注点（0.4.0 新增）。旧配置没有这个字段 → 归一成空数组，不影响日本模式
      places: Array.isArray(w.places) ? normalizePlaces(w.places) : [],
    },
    disasters: {
      earthquake: boolOr(d.earthquake, DEFAULT_CFG.disasters.earthquake),
      tsunami: boolOr(d.tsunami, DEFAULT_CFG.disasters.tsunami),
      // 0.3.0 新增。旧配置没有这个字段 → 取默认值 true，不会被清空或误关
      weather: boolOr(d.weather, DEFAULT_CFG.disasters.weather),
      // 大陆气象灾害的两类（0.5.2）。同样必须在这里同步——漏掉就会被 applyCfg 静默丢弃，
      // 表现是"用户关掉了暴雨提醒，刷新后又自己开了"。
      cnRainstorm: boolOr(d.cnRainstorm, DEFAULT_CFG.disasters.cnRainstorm),
      cnGeology: boolOr(d.cnGeology, DEFAULT_CFG.disasters.cnGeology),
      // 海外气象灾害（0.6.0）。同上：**必须在这里同步**，否则用户关掉之后刷新又自己开了。
      overseasWeather: boolOr(d.overseasWeather, DEFAULT_CFG.disasters.overseasWeather),
    },
    thresholds: {
      quakeScale: numOr(t.quakeScale, DEFAULT_CFG.thresholds.quakeScale, 0, 70),
      eewScale: numOr(t.eewScale, DEFAULT_CFG.thresholds.eewScale, 0, 70),
      // 白名单校验，同时避免 'constructor' 之类的原型链键被当成合法等级
      tsunamiGrade: TSUNAMI_OPTIONS.some((o) => o.g === t.tsunamiGrade)
        ? t.tsunamiGrade
        : DEFAULT_CFG.thresholds.tsunamiGrade,
      // 全球源的最低震级（0.4.0）。0 是有意义的取值（来者不拒），所以下界是 0 而不是 1
      globalMagnitude: numOr(t.globalMagnitude, DEFAULT_CFG.thresholds.globalMagnitude, 0, 10),
      // 大陆速报的独立门槛（0.5.0）。新增字段必须在这里同步，否则 applyCfg 会**静默丢弃**它
      // ——这正是 DESIGN 11.6 第 10 条那个"有保护的残留"：忘了同步时回归断言会失败。
      cnReportMagnitude: numOr(t.cnReportMagnitude, DEFAULT_CFG.thresholds.cnReportMagnitude, 0, 10),
    },
    notify: {
      sound: boolOr(n.sound, DEFAULT_CFG.notify.sound),
      system: boolOr(n.system, DEFAULT_CFG.notify.system),
      volume: numOr(n.volume, DEFAULT_CFG.notify.volume, 0, 1),
    },
    dedupe: {
      windowMinutes: numOr(de.windowMinutes, DEFAULT_CFG.dedupe.windowMinutes, 1, 1440),
    },
    quietHours: {
      enabled: boolOr(qh.enabled, DEFAULT_CFG.quietHours.enabled),
      start: timeOr(qh.start, DEFAULT_CFG.quietHours.start),
      end: timeOr(qh.end, DEFAULT_CFG.quietHours.end),
      breakForSevere: boolOr(qh.breakForSevere, DEFAULT_CFG.quietHours.breakForSevere),
    },
  }
}
function loadCfg() {
  const stored = loadJSON(STORAGE_KEY, null);
  if (!isPlainObject(stored)) {
    const fresh = freshCfg();
    saveJSON(STORAGE_KEY, fresh);
    return fresh
  }
  const cfg = normalizeCfg(stored);
  // 版本不同（插件升级 / 用户手改）时不再直接清空：按当前 schema 归一保留可识别字段，再写回当前版本号。
  // 旧实现会在这里 saveJSON(默认值)，一次版本号变化就会静默丢掉用户选好的关注地区与阈值。
  if (stored.version !== DEFAULT_CFG.version) saveJSON(STORAGE_KEY, cfg);
  return cfg
}
function saveCfg(cfg) {
  const next = { ...cfg, version: DEFAULT_CFG.version };
  saveJSON(STORAGE_KEY, next);
  return next
}


// 安全字典查找：外部数据里的 'constructor'/'toString' 等键会命中原型链，
// 例如 AREA_PREF['constructor'] 会返回 Object 构造函数并让 .slice() 抛错。
// （原在 05-parser，因被 city-table / parser / matcher 共用而移到这里）
const own = (map, key) => (Object.prototype.hasOwnProperty.call(map, key) ? map[key] : undefined);

// ============================================================================
// dsh-quake-alert · client/src/07-store.js
//
// 作用：全局 store——连接状态 + 最近预警，供设置页与状态指示订阅。
// 内容：store 对象（status/retries/detail/received/events + 订阅）、
//       addEvent（写入历史并落盘，key 唯一化）。
// 依赖：01-constants、02-storage。
// 注意：store.push({}) 是各 UI 的重渲染信号，改变它会影响所有订阅方。
// ============================================================================


// ---------- 全局 store：连接状态 + 最近预警（设置页订阅） ----------
// 0.4.0 起「连接状态」是**多源聚合**的：日本链路是 P2PQuake WebSocket，全球链路是 EMSC
// WebSocket，将来还会有 Host 侧轮询的源。每个源各自汇报，主状态按
// 「任一源红 → 红；否则任一源黄 → 黄；否则绿」聚合——只要有一条链路断了就不该显示成一切正常。
const store = {
  status: 'idle', // idle | connecting | open | reconnecting | closed（多源聚合结果）
  retries: 0,
  detail: '',
  sources: {}, // { [id]: { label, status, retries, detail } }
  received: 0, // 收到并成功解析的推送条数（诊断用）
  events: loadHistory(), // 最近预警 [{kind,label,severity,issued,headline,pref}]
  // 气象警报的「静默提示」（0.3.0）：L3 命中关注地区时只记一笔，由侧边栏状态点的悬停提示
  // 显示出来，不弹窗、不响铃——弥补 L4 起播报带来的提前量损失（DESIGN 10.3）
  weatherHint: null, // { level, area, pref, at } | null
  listeners: new Set(),
  push(patch) {
    Object.assign(this, patch);
    this.listeners.forEach((fn) => fn());
  },
  /** 某个连接源汇报自己的状态；主状态由 recomputeStatus 聚合得出。 */
  pushSource(id, patch) {
    const cur = this.sources[id] || { label: id, status: 'idle', retries: 0, detail: '' };
    this.sources[id] = Object.assign({}, cur, patch);
    this.recomputeStatus();
    this.push({});
  },
  /** 插件停用 / 重建时把源清空，避免残留的旧状态把新会话显示成"已连接"。 */
  clearSources() {
    this.sources = {};
    this.received = 0; // 推送计数也归零：否则重载后徽标会带着上一代的数字继续涨
    this.recomputeStatus();
    this.push({});
  },
  recomputeStatus() {
    const list = Object.keys(this.sources).map((k) => this.sources[k]);
    if (list.length === 0) {
      this.status = 'idle'; this.retries = 0; this.detail = '';
      return
    }
    // disabled（用户关掉了某个灾种）不参与聚合：它不该把整体拉成"异常"，
    // 但全部源都关掉时要如实显示成"已关闭"而不是"未启动"。
    const active = list.filter((x) => x.status !== 'disabled');
    if (active.length === 0) {
      this.status = 'disabled'; this.retries = 0;
      this.detail = list.map((x) => (x.label || '') + '：已关闭').join(' · ');
      return
    }
    const pick = (s) => active.filter((x) => x.status === s)[0];
    // 红优先：任一链路停了 / 不可达，整体就不是"正常"；其次蓝（数据格式异常，用户处理不了）、
    // 黄（连接中 / 重连 / 降级）、中灰（数据过期），最后才是绿。
    // 0.4.1 起 feed 源（JMA / USGS / NOAA）也上报状态——此前只有 WebSocket 源参与聚合，
    // 于是气象 / 全球轮询链路整体死掉时侧边栏仍然是绿的（用户以为在被保护）。
    const chosen = pick('closed') || pick('unreachable') || pick('schema-error') ||
      pick('reconnecting') || pick('connecting') || pick('degraded') || pick('stale') ||
      pick('open') || active[0];
    this.status = chosen.status;
    this.retries = typeof chosen.retries === 'number' ? chosen.retries : 0;
    // 详情优先列异常源（全部正常时才列全部）：源多了以后逐条列会挤爆悬停提示
    const bad = active.filter((x) => x.status !== 'open');
    this.detail = (bad.length ? bad : active)
      .map((x) => (x.label || '') + '：' + (x.detail || x.status)).join(' · ');
  },
  subscribe(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn) },
};
let anonSeq = 0; // 兜底：无 id 消息用递增匿名 key，避免空 id 互相覆盖
function addEvent(ev) {
  const hasId = ev && ev.id && ev.id !== '';
  const key = hasId ? ev.id : ('anon-' + (++anonSeq));
  // 统一过一遍字段规整：写入侧也保证历史里不会出现对象/数组字段
  const item = normalizeHistoryEntry(Object.assign({}, ev, { key }), 0);
  store.events = [item].concat(store.events.filter((e) => e.key !== key)).slice(0, HISTORY_MAX);
  saveJSON(HISTORY_KEY, store.events.slice(0, HISTORY_MAX));
  store.push({});
}

// ============================================================================
// dsh-quake-alert · client/src/03-settings-bridge.js
//
// 作用：机器级持久化桥——把配置交给 DSH 的 Host settings（settings.yaml）。
// 内容：内存镜像 currentCfg、写入入口 applyCfg、差异计算 settingsOpsFor、
//       异步推送 pushCfgToHost、首次迁移与降级 bindSettingsScope、
//       本地镜像回读 reloadFromLocal（其它标签页改配置后），
//       以及 Host section ⇄ 本地配置的转换（cfgToSection / sectionToCfg）。
// 依赖：01-constants、02-storage（07-store 的 store.push 在运行时才用到）。
// 降级：没有 settings 服务 / 页面非 loopback / Host 不持久化时自动退回 localStorage。
// ============================================================================


// ---------- 机器级持久化（0.2.0）：Host settings 为主，localStorage 为回退与镜像 ----------
// Host 半边注册了同名 namespace（lib/index.js 的 QuakeAlertSettingsSchema）。Client 经
// `ctx.settingsScope.bind({ namespace })` 读写它：scope 快照是**同步**可读的，所以内部读取
// （WebSocket 重连、handleRaw）仍然同步；写入先更新内存与 localStorage 镜像，再异步推给
// Host。没有 settings 服务、页面非 loopback、或 Host 只做进程内存储时，整条链路自动退化为
// M1 的 localStorage 行为。
const SETTINGS_NS = 'quake-alert';
/** 「本地配置已迁移到 Host」的落盘标记：迁移只能发生一次，见 bindSettingsScope。 */
const MIGRATED_KEY = 'dsh.quakeAlert.hostMigrated';
let runtimeCfg = null; // 内存中的当前配置
let settingsScope = null; // bind 成功后的 scope handle
let settingsSync = 'local'; // local（无 Host）| host（写入 settings.yaml）| memory（Host 不持久化）

// Host section ⇄ 本地配置：version 是本地存储的结构版本概念，不属于 Host schema
function cfgToSection(cfg) {
  const out = {};
  for (const key of Object.keys(cfg)) if (key !== 'version') out[key] = cfg[key];
  return out
}
function sectionToCfg(section) {
  return normalizeCfg(Object.assign({ version: DEFAULT_CFG.version }, isPlainObject(section) ? section : {}))
}
// 同步读取入口：保持 M1 的同步语义，调用方无需感知 Host 的存在
function currentCfg() {
  if (runtimeCfg === null) runtimeCfg = loadCfg();
  return runtimeCfg
}
// 本地镜像被**其它 DSH 标签页**改写后（storage 事件），把 localStorage 重新读回内存副本。
// 跨模块不能直接给本模块私有的 runtimeCfg 赋值：拆分前它同处一个作用域，拆分后就成了
// 自由变量，打包进 'use strict' 的 bundle 会抛 ReferenceError（0.2.1 拆分时漏改过一处），
// 所以这里给出显式入口。
function reloadFromLocal() {
  runtimeCfg = loadCfg();
  return runtimeCfg
}
// 写入入口：内存立即生效 → localStorage 镜像 → Host（可用时异步持久化）
function applyCfg(cfg) {
  // 写入路径也归一（0.4.1）：此前只有读取路径（loadCfg / sectionToCfg）归一，于是
  // 「坐标相同的关注点自动合并」「name 截断到 30 字」这类不变量在内存与 localStorage 里
  // 都不成立——同一次会话里重复添加同一个点会真的存两份，直到下次加载才被悄悄合并。
  runtimeCfg = saveCfg(normalizeCfg(cfg));
  pushCfgToHost(runtimeCfg);
  return runtimeCfg
}
// 只提交与默认值不同的字段；等于默认值的字段用 unset 交还 schema 默认层，
// 这样 settings.yaml 里只留下用户真正改过的东西。
function settingsOpsFor(cfg) {
  const cur = cfgToSection(cfg);
  const def = cfgToSection(freshCfg());
  const ops = [];
  const walk = (node, base, path) => {
    for (const key of Object.keys(node)) {
      const p = path.concat(key);
      const cv = node[key];
      const bv = base[key];
      if (isPlainObject(cv) && isPlainObject(bv)) { walk(cv, bv, p); continue }
      if (JSON.stringify(cv) === JSON.stringify(bv)) ops.push({ op: 'unset', path: p });
      else ops.push({ op: 'set', path: p, value: cv });
    }
  };
  walk(cur, def, []);
  return ops
}
/**
 * 把配置推给 Host。返回 `scope.mutate()` 的 pending（没有真正发出写请求时返回 null），
 * 调用方据此判断"Host 是否确认接收"——迁移标记要靠它，见 bindSettingsScope。
 */
function pushCfgToHost(cfg) {
  const scope = settingsScope;
  if (!scope || settingsSync !== 'host') return null
  try {
    const snap = scope.getSnapshot();
    if (!snap || snap.status !== 'ready' || snap.writable !== true || snap.mode !== 'host') return null
    const ops = settingsOpsFor(cfg);
    if (ops.length === 0) return null
    const pending = scope.mutate(ops);
    if (pending && typeof pending.catch === 'function') pending.catch(() => { /* 写失败不回滚本地 */ });
    return (pending && typeof pending.then === 'function') ? pending : null
  } catch (err) { return null }
}
// 绑定 Host settings。三种来源的优先关系：
//   ① Host 用户层已有内容 → 以 Host 为准（机器级配置是 source of truth）
//   ② Host 为空、本地已有非默认配置 → 一次性把本地配置迁移到 Host
//   ③ Host 不可用 → 保持 localStorage（settingsSync 停留在 local / memory）
/**
 * 迁移的尝试上限（0.5.4）。Host 持续拒绝写入时（revision 冲突等），不设上限会变成
 * "每来一次 sync 就写一次"的循环；用尽之后保留本地镜像、交由用户下一次改配置时经
 * `applyCfg` 直接写入 Host。
 */
const MIGRATE_MAX_ATTEMPTS = 3;

function bindSettingsScope(scope) {
  settingsScope = scope;
  let migrateAttempts = 0;
  const sync = () => {
    let snap = null;
    try { snap = scope.getSnapshot(); } catch (err) { return }
    if (!snap || snap.status !== 'ready' || snap.value === undefined) { settingsSync = 'local'; store.push({}); return }
    if (snap.mode !== 'host' || snap.writable !== true) { settingsSync = 'memory'; store.push({}); return }
    settingsSync = 'host';
    const user = isPlainObject(snap.user) ? snap.user : {};
    const claimed = loadJSON(MIGRATED_KEY, null) === 1;
    if (Object.keys(user).length === 0 && !claimed) {
      // 迁移**只能发生一次**，而且这个"一次"必须落盘（0.4.1 修正）。原来只在本次 bind 里记
      // 一个局部标志，于是每次重载页面 / Host settings 重建都会重新判断，结果是"用户显式清空
      // Host"会被本地镜像静默恢复——Host 作为 source of truth 的优先级被本地反超
      // （实测可复现：清空 Host 后重新 bind，Host 又变回 {quakeScale:55}）。
      const local = loadCfg();
      if (JSON.stringify(cfgToSection(local)) !== JSON.stringify(cfgToSection(freshCfg()))) {
        if (migrateAttempts >= MIGRATE_MAX_ATTEMPTS) {
          // 重试用尽：**不落标记、也不用 Host 的空值覆盖本地镜像**——那等于把用户配置丢掉。
          // 本地镜像保持原样，用户下一次改配置会经 applyCfg 直接写进 Host。
          store.push({});
          return
        }
        migrateAttempts += 1;
        runtimeCfg = saveCfg(local);
        const pending = pushCfgToHost(runtimeCfg);
        // **等 Host 真的接收之后再落"已认领"标记**。两点都不能省（0.5.4）：
        //  ① 先落标记再写的话，写入失败（磁盘 / 权限 / 瞬时冲突）会让本地配置既没进 Host、
        //     又因为标记而不再重试，随后被 Host 的空值覆盖——永久且静默地丢配置；
        //  ② **不能把 `pending` 的 resolve 当成功**：平台的 mutate 在 Host 拒绝时（`!response.ok`）
        //     也是 resolve（它内部 recover 并重新推送）。所以 settle 之后回读一次：迁移的字段
        //     确实出现在 Host 用户层里，才算迁移完成；否则不落标记，下一次 sync 重试。
        if (pending) {
          pending.then(() => {
            let landed = false;
            try {
              const after = scope.getSnapshot();
              landed = !!(after && after.status === 'ready' && isPlainObject(after.user) && Object.keys(after.user).length > 0);
            } catch (err) { landed = false; }
            if (!landed) return
            try { saveJSON(MIGRATED_KEY, 1); } catch (err) { /* 忽略 */ }
          }).catch(() => { /* 写失败：不落标记，下次重试 */ });
        }
        store.push({});
        return
      }
      // 本地就是默认值：Host 为空与本地等价，直接认领
      saveJSON(MIGRATED_KEY, 1);
    } else if (!claimed) {
      // 走到这里说明"以 Host 为准"（Host 用户层已有内容）。**认领标记也必须在这一条路径上落**
      // （0.5.4）：此前它只在"Host 为空 + 本地非默认"那条分支里写，于是"首次 bind 时 Host 已非空"
      //（第二个浏览器 / 另一台配置 / 手写过 settings.yaml——settings.yaml 是机器级共享的）
      // 永远不落标记。此后 Host 一旦变空（用户在别处恢复默认），本浏览器会把**过期**的本地镜像
      // 重新迁回 Host，静默复活旧配置。实测：fresh localStorage + Host 非空 → 标记未落；
      // 再把 Host 置空 → 本地旧值被写回 Host。
      saveJSON(MIGRATED_KEY, 1);
    }
    const next = sectionToCfg(snap.value);
    runtimeCfg = saveCfg(next); // localStorage 保持为镜像：Host 掉线时仍能工作
    store.push({});
  };
  let disposer = null;
  try { disposer = scope.subscribe(sync); } catch (err) { /* 订阅失败只是失去实时同步 */ }
  sync();
  // 返回解除函数（0.4.1）：调用方要把它注册进 ctx.effect，否则同一页面内停用 → 启用 N 次
  // 会累积 N 个订阅，此后 Host 每一次配置变更都会触发 N 次写盘与 N 次重渲。
  return () => {
    try { if (typeof disposer === 'function') disposer(); } catch (err) { /* 忽略 */ }
    if (settingsScope === scope) settingsScope = null;
  }
}


// 供单测钩子与 UI 读取：模块作用域的私有状态不直接对外暴露写入口
const settingsState = () => ({ sync: settingsSync, bound: settingsScope !== null, runtime: runtimeCfg });
const resetSettings = () => { runtimeCfg = null; settingsScope = null; settingsSync = 'local'; };

// ============================================================================
// dsh-quake-alert · client/src/04-city-table.js
//
// 作用：市区町村表与「观测点 addr → 市町村」归一。
// 内容：表的注入与规整（setCityTable/citiesOfPref/pruneUnknownCities）、
//       地名假名归一（normKana）与规范写法反查（canonicalCityOf）、
//       从 Host 只读路由拉表（loadCityTable）、写法变体展开（cityAliases）、
//       前缀索引（buildAddrIndex）与查询（lookupAddrCity）。
// 依赖：01-constants、02-storage、03-settings-bridge（pruneUnknownCities 会写配置）。
// 要点：気象庁/P2PQuake 的观测点名用短名与消歧写法（大阪北区茶屋町、福島伊達市、
//       渡島北斗市），必须先归一到市町村全称再比对，否则会大面积漏报；
//       河川区域表与 JMA 电文还可能与本表假名写法不同（南アルプス市 / 南あるぷす市），
//       所以「比对」与「反查」一律经 normKana，显示仍用本表写法。
// ============================================================================


// ---------- 市区町村表（0.2.0）：Host 路由提供，Client 拉一次并缓存 ----------
// 全国约 1700+ 个市町村，体积不适合内联进 client bundle。Host 侧在
// /dsh-quake-alert/areas 返回 { prefectures: { "<都道府県>": ["市町村全称", ...] } }。
// 拉取失败时表保持为空，功能退化为「只能按都道府县关注」——不影响 M1 的任何行为。
const AREAS_PATH = '/dsh-quake-alert/areas';
let cityTable = null;
let cityTableState = 'idle'; // idle | loading | ready | failed
let cityNameSet = null; // 全部市町村名（校验配置用）
let cityPrefIndex = null; // Map<归一市町村名, { name: 规范写法, prefs: 都道府県[] }>：JMA 电文只给市町村名，要反查所属县
let riverAreas = null; // Map<河川予報区域コード, { name, cities }>：指定河川洪水予報用

// ---------- 地名假名归一 ----------
// 気象庁的不同数据源对同一个市町村写法不一致，实测三类（0.3.2）：
//   ① 小写法不同：総務省コード表「金け崎町 / 六ゖ所村」↔ 河川区域 CSV「金ケ崎町 / 六ヶ所村」
//   ② 假名种类不同：総務省コード表「南あるぷす市」↔ 河川区域 CSV「南アルプス市」
//   ③ 旧写法：P2PQuake 观测点「龍ケ崎市」↔ 本表「龍け崎市」
// 归一步骤：先「平假名 → 片假名」（け→ケ、ゖ→ヶ），再把「ケ → ヶ」（小写化）。
// 两步都要：只做第一步的话「ケ」与「ヶ」会变得不相等，反而破坏既有的ケ/ヶ 等价。
// 结果只用于比较与反查，绝不用于显示——界面上一律用本表的规范写法。
const KANA_HIRA_MIN = 0x3041;
const KANA_HIRA_MAX = 0x3096;
const KANA_KE_RE = /\u30b1/g;
function normKana(input) {
  const s = String(input === undefined || input === null ? '' : input);
  let out = '';
  for (const ch of s) {
    const c = ch.codePointAt(0);
    out += (c >= KANA_HIRA_MIN && c <= KANA_HIRA_MAX) ? String.fromCodePoint(c + 0x60) : ch;
  }
  return out.replace(KANA_KE_RE, '\u30f6')
}

function setCityTable(table) {
  if (!isPlainObject(table)) return false
  const clean = {};
  const names = new Set();
  for (const pref of Object.keys(table)) {
    if (!PREF_SET.has(pref)) continue
    const list = table[pref];
    if (!Array.isArray(list)) continue
    const uniq = Array.from(new Set(list.filter((c) => typeof c === 'string' && c.length > 0 && c.length <= 30)));
    if (uniq.length === 0) continue
    clean[pref] = uniq;
    for (const c of uniq) names.add(c);
  }
  if (Object.keys(clean).length === 0) return false
  cityTable = clean;
  cityNameSet = names;
  // 索引键走假名归一：外部写法（河川区域表 / JMA 电文）与本表写法不同时也要能查到
  cityPrefIndex = new Map();
  for (const pref of Object.keys(clean)) {
    for (const c of clean[pref]) {
      const key = normKana(c);
      const hit = cityPrefIndex.get(key);
      if (hit) { if (hit.prefs.indexOf(pref) === -1) hit.prefs.push(pref); }
      else cityPrefIndex.set(key, { name: c, prefs: [pref] });
    }
  }
  buildAddrIndex();
  cityTableState = 'ready';
  return true
}
const citiesOfPref = (pref) => (cityTable && own(cityTable, pref)) || [];
/** 市町村名 → 所属都道府県（写法差异已归一；重名时返回多个；表未加载或未收录时返回空数组）。 */
const prefsOfCity = (name) => {
  if (!cityPrefIndex) return []
  const hit = cityPrefIndex.get(normKana(name));
  return hit ? hit.prefs.slice() : []
};
/**
 * 市町村名 → 本表里的规范写法（写法差异已归一；表未加载或未收录时返回空字符串）。
 *
 * 为什么需要：用户勾选的市町村名来自本表（citiesOfPref），而 JMA 电文、河川区域表给的是
 * 外部写法。把外部写法直接写进 region.city，再与用户勾选的名字比对（indexOf）就会漏报；
 * 所以比对前先取规范名。表未加载时返回空串，调用方回退用原写法（宁可多报绝不漏报）。
 */
const canonicalCityOf = (name) => {
  if (!cityPrefIndex) return ''
  const hit = cityPrefIndex.get(normKana(name));
  return hit ? hit.name : ''
};

/**
 * 河川予報区域表（0.3.0-a 由 scripts/build-areas.mjs 生成，Host 随 /areas 一起下发）。
 * 指定河川洪水予報的电文区域是河川名（「天塩川」），必须先映射到市町村才能与用户关注比对。
 */
function setRiverAreas(list) {
  if (!Array.isArray(list)) return false
  const idx = new Map();
  for (const a of list) {
    if (!a || typeof a.code !== 'string' || !Array.isArray(a.cities)) continue
    idx.set(a.code, { name: typeof a.name === 'string' ? a.name : '', cities: a.cities.filter((c) => typeof c === 'string' && c) });
  }
  if (idx.size === 0) return false
  riverAreas = idx;
  return true
}
/** 河川予報区域コード → 覆盖的市町村名列表（未收录时返回空数组）。 */
const riverAreaCities = (code) => {
  if (!riverAreas) return []
  const hit = riverAreas.get(String(code || ''));
  return hit ? hit.cities.slice() : []
};

// ---------- 中国行政区划表（0.5.0）：Host 随 /areas 一起下发 ----------
// 与市区町村表同一理由：省 34 + 地级 384 共约 21KB，不内联进 client bundle。
// 用途是设置页的三级级联（中国 → 省 → 地级市）与**关注点坐标填充**：
// 大陆源（cenc_eew / cenc_eqlist）是坐标 + 半径匹配（DESIGN 8.3），
// 让用户手填经纬度不现实，由这张表按所选城市给出坐标。
// 表由 scripts/build-cn-areas.mjs 从 GeoNames 生成（含 TW/HK/MO），头部记着已知取舍。
let cnAreas = null; // [{ code, name, aliases, lat, lon, cities:[{name,aliases,lat,lon}] }]
/**
 * 别名的规整：只留**有意义**的候选。
 *
 * 丢掉单字别名（"丽"这类会匹配到半个中国）与和显示名重复的项；上限 8 条，因为候选是长尾的
 * （个别条目有几十个历史名 / 罗马字音译），而匹配是**最长命中**，砍掉短名不影响建制全名。
 * 缺失 `aliases` 字段（Host 未升级 / 手写的旧数据）时返回空数组——**别名是增强，不是前提**。
 */
function normAliases(list, name) {
  if (!Array.isArray(list)) return []
  const out = [];
  const seen = new Set();
  for (const a of list) {
    if (typeof a !== 'string') continue
    const s = a.trim();
    if (!s || s === name || s.length < 2 || seen.has(s)) continue
    seen.add(s);
    out.push(s);
    if (out.length >= 8) break
  }
  return out
}
/**
 * 注入并规整行政区划表。**逐字段校验**：表来自 Host 的 JSON，与 localStorage 一样属于
 * "不可信的输入"——一个坏条目会让级联渲染出幽灵选项，或把用户带到错误的坐标上
 *（后者在预警产品里是"该响的地方没响"）。规整失败的整体拒绝，不做部分接受。
 */
function setCnAreas(list) {
  if (!Array.isArray(list)) return false
  const out = [];
  const seenProv = new Set();
  for (const p of list) {
    if (!isPlainObject(p)) continue
    const name = typeof p.name === 'string' ? p.name.trim() : '';
    if (!name || seenProv.has(name)) continue
    if (!validLatLon(p.lat, p.lon)) continue
    const cities = [];
    const seenCity = new Set();
    for (const c of (Array.isArray(p.cities) ? p.cities : [])) {
      if (!isPlainObject(c)) continue
      const cn2 = typeof c.name === 'string' ? c.name.trim() : '';
      if (!cn2 || seenCity.has(cn2)) continue
      if (!validLatLon(c.lat, c.lon)) continue
      seenCity.add(cn2);
      cities.push({ name: cn2, aliases: normAliases(c.aliases, cn2), lat: c.lat, lon: c.lon });
    }
    // 没有下级的省级项在级联里是死路：直接丢弃，避免用户选中后按钮没反应
    if (cities.length === 0) continue
    seenProv.add(name);
    out.push({ code: typeof p.code === 'string' ? p.code : '', name, aliases: normAliases(p.aliases, name), lat: p.lat, lon: p.lon, cities });
  }
  if (out.length === 0) return false
  cnAreas = out;
  return true
}
function validLatLon(lat, lon) {
  return typeof lat === 'number' && Number.isFinite(lat) && Math.abs(lat) <= 90 &&
    typeof lon === 'number' && Number.isFinite(lon) && Math.abs(lon) <= 180
}
/** 省级列表（表未加载时返回空数组）。 */
const cnProvinces = () => (cnAreas ? cnAreas.slice() : []);
/** 某个省下的地级市列表（未收录时返回空数组）。 */
const cnCitiesOf = (province) => {
  if (!cnAreas) return []
  const hit = cnAreas.find((p) => p.name === province);
  return hit ? hit.cities.slice() : []
};
/**
 * 「省 + 市 + 半径」→ 一个关注点（表里查不到时返回 null）。
 *
 * 抽成纯函数是为了能直接断言级联的产物：用户点「添加」之后配置里到底会多出什么，
 * 比"界面上出现了两个下拉框"重要得多。名称取「省·市」以免两个省的"城区"撞名。
 */
function cnPlaceOf(province, city, radiusKm) {
  if (!cnAreas) return null
  const p = cnAreas.find((x) => x.name === province);
  if (!p) return null
  const c = p.cities.find((x) => x.name === city);
  if (!c) return null
  const r = Number(radiusKm);
  if (!Number.isFinite(r) || r < 1 || r > 2000) return null
  return { name: province + '·' + city, lat: c.lat, lon: c.lon, radiusKm: r }
}

/**
 * 发布机构名 → 行政区归属（0.5.2，大陆气象源用）。
 *
 * 输入是气象台的机构名（`气象台` 后缀已去掉或未去掉都可以），例如
 * `云南省丽江市宁蒗彝族自治县气象台`。输出 `{ province, city, matched }`。
 *
 * 三条规则，全部由 238 条真实样本定出来（见 DESIGN 8.5 的实测记录）：
 *  ① **省名必须出现在机构名的开头**，取最长命中。不能改成"全局搜索"：省别名里有
 *     「海南」，而青海省的机构名是「青海省海南藏族自治州共和县气象台」——全局搜会把
 *     一条青海的预警归到海南省，那是最难查的一类错误（名字看着对、地方错了几百公里）。
 *     实测 238 条**全部**以省名开头，所以这个约束不损失覆盖。
 *  ② 市级在**省名之后的那一段**里找最长命中，用 `aliases`（GeoNames 的全部中文候选）而不是
 *     只认显示名——实测显示名会挑到旧名（「毕节地区」对应气象台的「毕节市」、
 *     「思茅市」对应「普洱市」），只认显示名会让这些预警退化成"仅省"。
 *  ③ 市级找不到时，若该省下**只有一个可选条目**（直辖市 / 港澳），就用它：
 *     「上海市浦东新区气象台」的省名之后不含"上海市"，但上海市的关注点确实该响。
 *     其余情况返回 `city: ''`——由调用方走**省级兜底**（宁可多报，绝不漏报，DESIGN 8.5）。
 *
 * @param {unknown} org 机构名
 * @returns {{ province: string, city: string, matched: boolean }|null} 表未加载时返回 null
 */
function cnAreaOf(org) {
  if (!cnAreas || cnAreas.length === 0) return null
  const s = String(org === undefined || org === null ? '' : org).trim();
  if (!s) return { province: '', city: '', matched: false }
  let prov = null;
  let plen = 0;
  for (const p of cnAreas) {
    for (const n of [p.name].concat(p.aliases || [])) {
      if (n.length > plen && s.startsWith(n)) { prov = p; plen = n.length; }
    }
  }
  if (!prov) return { province: '', city: '', matched: false }
  const rest = s.slice(plen);
  let city = null;
  let clen = 0;
  for (const c of prov.cities) {
    for (const n of [c.name].concat(c.aliases || [])) {
      if (n.length > clen && rest.indexOf(n) !== -1) { city = c; clen = n.length; }
    }
  }
  if (!city && prov.cities.length === 1) city = prov.cities[0];
  return { province: prov.name, city: city ? city.name : '', matched: true }
}

// ---------- addr → 市町村归一 ----------
// 気象庁 / P2PQuake 的观测点名（551 的 points[].addr）与市町村全称有一批写法差异，
// 匹配前先把 addr 归一到它所属的市町村全称；归一不了的（机场、区域名、未收录点）返回 null，
// 调用方据此放行——宁可多提醒一次，也绝不因为写法差异漏报。
//
// 已覆盖的差异（均来自实测的直播 addr）：
//   ① 政令市短名：大阪北区茶屋町       ← 大阪市北区
//   ② 特别区加县短名：東京千代田区大手町 ← 千代田区
//   ③ 重名消歧前缀：福島伊達市          ← 伊達市（福島県）
//   ④ 北海道支庁名：渡島北斗市 / 日高地方日高町 ← 北斗市 / 日高町
//   ⑤ 仮名表记：龍ケ崎市 ↔ 龍け崎市（归一函数见文件上方 normKana：平假名→片假名 + ケ→ヶ）
const HOKKAIDO_BRANCHES = [
  '石狩', '後志', '空知', '渡島', '檜山', '胆振', '日高', '上川', '留萌', '宗谷',
  '網走', '北見', '紋別', '十勝', '釧路', '根室',
];
// 展开一个市町村全称的全部书写变体
function cityAliases(city, pref) {
  const out = [city];
  const m = /^(.+市)(.+区)$/.exec(city);
  if (m) out.push(m[1].slice(0, -1) + m[2]);
  else if (/区$/.test(city)) out.push('東京' + city);
  if (pref) {
    const short = String(pref).replace(/[都道府県]$/, '');
    if (short && short !== pref) out.push(short + city);
  }
  if (pref === '北海道') {
    for (const b of HOKKAIDO_BRANCHES) { out.push(b + city); out.push(b + '地方' + city); }
  }
  return out
}
let addrAliasIndex = null; // Map<归一后的别名, 市町村全称>
let addrAliasMax = 0;
function buildAddrIndex() {
  const idx = new Map();
  let max = 0;
  if (cityTable) {
    for (const pref of Object.keys(cityTable)) {
      for (const city of cityTable[pref]) {
        for (const alias of cityAliases(city, pref)) {
          const a = normKana(alias);
          if (!idx.has(a)) idx.set(a, city);
          if (a.length > max) max = a.length;
        }
      }
    }
  }
  addrAliasIndex = idx;
  addrAliasMax = max;
}
// addr → 市町村全称（最长前缀命中）；无法归一返回 null
function lookupAddrCity(area) {
  if (!addrAliasIndex || addrAliasIndex.size === 0) return null
  const a = normKana(area);
  for (let len = Math.min(addrAliasMax, a.length); len >= 2; len--) {
    const hit = addrAliasIndex.get(a.slice(0, len));
    if (hit) return hit
  }
  return null
}
// 配置里可能残留表里不存在的市町村名（手工改过配置 / 数据表更新）→ 表到位后清掉
function pruneUnknownCities() {
  if (!cityNameSet) return
  const cur = currentCfg();
  const kept = cur.watch.cities.filter((c) => cityNameSet.has(c));
  if (kept.length === cur.watch.cities.length) return
  applyCfg(Object.assign({}, cur, { watch: Object.assign({}, cur.watch, { cities: kept }) }));
}
let cityTableAbort = null; // 在途请求的取消器（插件卸载时用）
async function loadCityTable() {
  if (cityTableState === 'loading' || cityTableState === 'ready') return cityTableState
  if (typeof window === 'undefined' || typeof window.fetch !== 'function') { cityTableState = 'failed'; return cityTableState }
  cityTableState = 'loading';
  store.push({});
  // 经 window 取 AbortController：浏览器里就是它，沙箱测试也只需注入 window 上的实现
  const AC = (typeof window !== 'undefined' && window) ? window.AbortController : undefined;
  cityTableAbort = typeof AC === 'function' ? new AC() : null;
  try {
    const init = { headers: { accept: 'application/json' } };
    if (cityTableAbort) init.signal = cityTableAbort.signal;
    const res = await window.fetch(AREAS_PATH, init);
    if (!res || !res.ok) throw new Error('HTTP ' + (res ? res.status : '?'))
    const data = await res.json();
    const payload = isPlainObject(data) && isPlainObject(data.prefectures) ? data.prefectures : data;
    if (!setCityTable(payload)) throw new Error('payload 不含市町村表')
    // 0.3.0：河川予報区域表随同一份响应下发；缺失只影响洪水，不影响泥石流与既有功能
    if (isPlainObject(data) && Array.isArray(data.riverAreas)) setRiverAreas(data.riverAreas);
    // 0.5.0：中国行政区划表（省 → 地级市 + 坐标），供设置页的三级级联。
    // 缺失只影响大陆源的"选城市"这条路径（仍可手填坐标），不影响日本链路与既有功能。
    if (isPlainObject(data) && Array.isArray(data.cnAreas)) setCnAreas(data.cnAreas);
    pruneUnknownCities();
  } catch (err) {
    // 插件卸载造成的中止不算"失败"：下次装载应当能重试
    const aborted = !!(cityTableAbort && cityTableAbort.signal && cityTableAbort.signal.aborted);
    cityTableState = aborted ? 'idle' : 'failed';
  }
  cityTableAbort = null;
  store.push({});
  return cityTableState
}
/** 插件卸载时调用：中止在途请求，免得卸载之后还去写 store / 用户配置。 */
function abortCityTableLoad() {
  if (cityTableAbort) {
    try { cityTableAbort.abort(); } catch (err) { /* 已结束等忽略 */ }
    // 故意不在这里置空：loadCityTable 的 catch 要靠它的 signal 区分「被中止」与「真失败」，
    // 置空由 loadCityTable 收尾时统一做（abort 幂等，重复调用无害）。
  }
}


// 供单测钩子重置表状态
const resetCityTable = () => {
  abortCityTableLoad();
  cityTable = null; cityNameSet = null; cityTableState = 'idle';
  addrAliasIndex = null; addrAliasMax = 0; cityPrefIndex = null; riverAreas = null;
  cnAreas = null;
};

// ============================================================================
// dsh-quake-alert · client/src/05-parser.js
//
// 作用：把 P2PQuake 的原始消息解析成统一 Alert（适配器层）。
// 内容：code 551/552/556 的字段映射、区域名归一 prefsOfArea（显式表 → 47 县前缀 →
//       府県予報区兜底）、跨县区域展开、震度/海啸文案、headline 组装。
// 依赖：01-constants、02-storage（归一化相关工具）。
// 注意：551 的 points[].pref 实测存在「京都」这类简写，已在常量层归一为全称。
// ============================================================================


// ---------- 解析器：P2PQuake code → Alert ----------
// Alert = { id, code, kind, kindLabel, severity, issued, headline, maxScale, hypo,
//           regions:[{pref, area, scale?, grade?}], cancelled, eventKey, strength }
//           eventKey 归并同一地震的多次发布，strength 用于强度升级判定
// 区域名 → 都道府县全称。
// 551 的 points[].pref 本身就是县全称，可直接用；但 556 的 areas[].name 与 552 的
// areas[].name 是「区域名」，其中一部分不含都道府县名（北海道用地方名、东京都用岛屿名、
// 海啸予報区用海域/群岛名），必须显式映射，否则关注对应县的用户会静默漏报。
// 数据来源：気象庁「緊急地震速報や震度情報で用いる区域の名称」区域名一覧、
//          「津波予報区について」境界一覧（全 66 区）。
const AREA_PREF = {
  // —— 紧急地震速报区域名：东京都岛屿（名称不含「東京」）——
  '伊豆大島': ['東京都'], '新島': ['東京都'], '神津島': ['東京都'],
  '三宅島': ['東京都'], '八丈島': ['東京都'], '小笠原': ['東京都'],
  // —— 海啸予報区：名称不含都道府县（66 区中的 17 个）——
  'オホーツク海沿岸': ['北海道'],
  '陸奥湾': ['青森県'],
  '東京湾内湾': ['千葉県', '東京都', '神奈川県'],
  '伊豆諸島': ['東京都'],
  '小笠原諸島': ['東京都'],
  '相模湾・三浦半島': ['神奈川県'],
  '佐渡': ['新潟県'],
  '伊勢・三河湾': ['愛知県', '三重県'],
  '淡路島南部': ['兵庫県'],
  '隠岐': ['島根県'],
  '有明・八代海': ['福岡県', '佐賀県', '長崎県', '熊本県'],
  '壱岐・対馬': ['長崎県'],
  '種子島・屋久島地方': ['鹿児島県'],
  '奄美群島・トカラ列島': ['鹿児島県'],
  '沖縄本島地方': ['沖縄県'],
  '大東島地方': ['沖縄県'],
  '宮古島・八重山地方': ['沖縄県'],
};
// 556 的 areas[].pref 是府県予報区名（简写："茨城"/"東京"/"北海道道北"/"宮古島"…），
// 仅作为区域名归一失败时的兜底。
const FORECAST_PREF = {
  '伊豆諸島': ['東京都'], '小笠原': ['東京都'], '奄美群島': ['鹿児島県'],
  '沖縄本島': ['沖縄県'], '大東島': ['沖縄県'], '宮古島': ['沖縄県'], '八重山': ['沖縄県'],
};
// 北海道在 EEW 中按地方名划分区域（石狩地方北部…），名称里没有「北海道」
const HOKKAIDO_AREA_PREFIX = [
  '石狩地方', '後志地方', '空知地方', '渡島地方', '檜山地方', '胆振地方', '日高地方',
  '上川地方', '留萌地方', '宗谷地方', '網走地方', '北見地方', '紋別地方', '十勝地方',
  '釧路地方', '根室地方',
];
// 县名按长度降序：保证「京都府」先于「京都」被匹配（否则京都府会被截成京都）
const PREF_BY_LENGTH = PREFECTURES.map((p) => p.jp).sort((a, b) => b.length - a.length);
const startsWith = (s, p) => s.lastIndexOf(p, 0) === 0;
// 安全字典查找 own() 见 02-storage：外部数据里的 'constructor' / 'toString' 等键会命中原型链，
// 例如 AREA_PREF['constructor'] 会返回 Object 构造函数并让 .slice() 抛错。

// 归一区域名，返回它可能覆盖的全部都道府县（海啸「有明・八代海」等跨多个县）
function prefsOfArea(name, forecastPref) {
  const s = String(name || '');
  const exact = own(AREA_PREF, s);
  if (exact) return exact.slice()
  if (HOKKAIDO_AREA_PREFIX.some((p) => startsWith(s, p))) return ['北海道']
  for (const p of PREF_BY_LENGTH) if (startsWith(s, p)) return [p]
  const hint = String(forecastPref || '');
  if (hint) {
    const hit = own(FORECAST_PREF, hint);
    if (hit) return hit.slice()
    for (const p of PREF_BY_LENGTH) if (startsWith(hint, p)) return [p]
    for (const p of PREF_BY_LENGTH) if (startsWith(p, hint)) return [p]
  }
  return []
}
// 把一个区域展开成 region 条目；跨县区域展开为多条，无法归一时 pref='' 并标记
function regionsOfArea(name, forecastPref, value, valueKey) {
  const area = name || '';
  const prefs = prefsOfArea(area, forecastPref);
  if (prefs.length === 0) {
    const region = { pref: '', area, prefUnknown: true };
    region[valueKey] = value;
    return [region]
  }
  return prefs.map((p) => {
    const region = { pref: p, area };
    region[valueKey] = value;
    return region
  })
}
const scaleText = (v) => own(SCALE_TEXT, v) || (typeof v === 'number' && v > 0 ? '震度' + Math.floor(v / 10) : '未公布');
// 震度后缀：只在有效震度时追加，避免「最大震度未公布」这类噪音。
// 震度是用户判断严重性的关键信息（阈值也是按震度设的），必须出现在 headline 里。
// prefix 例：'最大' → 「最大震度3」；'预测最大' → 「预测最大震度5强」。
const scaleSuffix = (v, prefix) => (typeof v === 'number' && v > 0 ? ' · ' + prefix + scaleText(v) : '');
// severity → 颜色。'yellow' 必须显式处理：默认阈值 40 下最常见的命中（震度4）就是它，
// 落到默认分支会显示成"信息蓝"，与「中等严重度」的语义不符。
const sevColor = (s) => (
  s === 'red' ? '#e5484d'
    : (s === 'orange' ? '#f76b15'
      : (s === 'yellow' ? '#d9a406' : '#3b82f6'))
);
const severityOfScale = (v) => {
  if (typeof v !== 'number' || v <= 0) return 'info'
  if (v >= 55) return 'red'
  if (v >= 45) return 'orange'
  if (v >= 40) return 'yellow'
  return 'info'
};

function parseQuake(raw) {
  const type = (raw.issue && raw.issue.type) || '';
  const labelMap = {
    ScalePrompt: '地震速报·震度速报', Destination: '地震情报·震源', ScaleAndDestination: '地震情报·震源与震度',
    DetailScale: '地震情报·各地震度', Foreign: '地震情报·远地地震', Other: '地震情报',
  };
  const eq = raw.earthquake || {};
  const hypo = eq.hypocenter || {};
  const pts = raw.points || [];
  const hasHypo = typeof hypo.name === 'string' && hypo.name !== '';
  const headBase = hasHypo
    ? '震源 ' + hypo.name + ' · M' + (typeof hypo.magnitude === 'number' ? hypo.magnitude : '—')
    : (own(labelMap, type) || '地震情报');
  const headline = headBase + scaleSuffix(eq.maxScale, '最大');
  return {
    id: String(raw.id || raw._id || ''), code: 551, kind: 'quake',
    kindLabel: own(labelMap, type) || '地震情报',
    severity: severityOfScale(eq.maxScale),
    // 时间统一转成**带偏移**的 ISO 8601（源时区见 DESIGN 第 4 节 / 05d 的 SOURCE_CONTRACTS）。
    // P2PQuake 的时间是裸 JST（"2026/09/07 23:25:14"），不补偏移的话大陆浏览器上会显示成
    // 一个差 1 小时、且没有任何标注的时间；旧历史数据没有偏移，由 formatIssuedLocal 按 JST 解释。
    issued: p2pTimeToIso((raw.issue && raw.issue.time) || raw.time || ''),
    headline,
    maxScale: typeof eq.maxScale === 'number' ? eq.maxScale : -1,
    // 事件级去重键：同一次地震的速报 / 震源 / 详报共享 earthquake.time（551 没有 issue.eventId）
    eventKey: eq.time ? 'quake:' + eq.time : '',
    strength: typeof eq.maxScale === 'number' ? eq.maxScale : -1,
    hypo: { name: hypo.name || '', magnitude: typeof hypo.magnitude === 'number' ? hypo.magnitude : null },
    regions: pts.map((p) => ({
      pref: normalizePref(p.pref),
      area: p.addr || '',
      scale: typeof p.scale === 'number' ? p.scale : -1,
      // isArea=true 的条目是区域名（如「熊本県天草・芦北」），无法对应到具体市区町村；
      // false/缺省才是观测点（如「白河市新白河」），可以做市级收窄。
      cityKnown: p.isArea !== true,
    })),
    cancelled: false,
    raw,
  }
}

function parseEew(raw) {
  const cancelled = raw.cancelled === true;
  const eq = raw.earthquake || {};
  const hypo = eq.hypocenter || {};
  const areas = raw.areas || [];
  const maxTo = areas.reduce((m, a) => (typeof a.scaleTo === 'number' && a.scaleTo > m ? a.scaleTo : m), -1);
  return {
    id: String(raw.id || raw._id || ''), code: 556, kind: 'eew',
    kindLabel: cancelled ? 'EEW·已取消' : '紧急地震速报（警报）',
    severity: cancelled ? 'info' : 'red',
    issued: p2pTimeToIso((raw.issue && raw.issue.time) || raw.time || ''),
    headline: cancelled ? '本警报已取消' : '震源 ' + (hypo.name || '—') + ' · M' + (typeof hypo.magnitude === 'number' ? hypo.magnitude : '—') + scaleSuffix(maxTo, '预测最大'),
    maxScale: maxTo,
    // EEW 的多报共享 issue.eventId（serial 递增），用它做事件级去重
    eventKey: (raw.issue && raw.issue.eventId) ? 'eew:' + raw.issue.eventId : '',
    strength: maxTo,
    hypo: { name: hypo.name || '', magnitude: typeof hypo.magnitude === 'number' ? hypo.magnitude : null },
    regions: areas.flatMap((a) => regionsOfArea(a.name, a.pref, typeof a.scaleTo === 'number' ? a.scaleTo : -1, 'scale')),
    cancelled,
    raw,
  }
}

function parseTsunami(raw) {
  const cancelled = raw.cancelled === true;
  const areas = raw.areas || [];
  const lines = areas.map((a) => {
    const hgt = a.maxHeight && a.maxHeight.description ? ' 高' + a.maxHeight.description : '';
    return (a.name || '—') + '：' + (own(TSUNAMI_GRADE_TEXT, a.grade) || a.grade || '—') + hgt
  });
  const worst = areas.reduce((m, a) => Math.max(m, own(TSUNAMI_RANK, a.grade) || 0), 0);
  const anyWarning = worst >= 2;
  return {
    id: String(raw.id || raw._id || ''), code: 552, kind: 'tsunami',
    kindLabel: cancelled ? '海啸·已解除' : (worst >= 3 ? '大海啸警报' : (anyWarning ? '海啸警报' : '海啸注意报')),
    severity: cancelled ? 'info' : (worst >= 2 ? 'red' : 'orange'),
    issued: p2pTimeToIso((raw.issue && raw.issue.time) || raw.time || ''),
    headline: cancelled ? '海啸预报已解除' : lines.join('；'),
    maxScale: worst,
    // 海啸预报没有可归并的事件 id（issue 只有 source/time/type），但**绝不能留空**：
    // cancelKeyOf 会退回 kind（'tsunami'），于是任意海域的解除都被当成"此前提醒过的事件"，
    // 播出一条与用户无关的「海啸预报已解除 …此前发出的警报已作废」——海啸域的**假安全**
    // 是最危险的误报。用「预报区名集合」当事件键：只有针对同一批预报区的发布与解除
    // 才归并为同一个事件（区域不一致时匹配不上 → 不提示，安全侧）。
    eventKey: areas.length ? 'tsunami:' + areas.map((a) => String(a.name || '')).sort().join(',') : '',
    strength: worst,
    regions: areas.flatMap((a) => regionsOfArea(a.name, a.pref, a.grade || '', 'grade')),
    cancelled,
    raw,
  }
}

function parse(raw) {
  if (!raw || typeof raw !== 'object') return null
  if (raw.code === 556) return parseEew(raw)
  if (raw.code === 552) return parseTsunami(raw)
  if (raw.code === 551) return parseQuake(raw)
  return null
}

// ============================================================================
// dsh-quake-alert · client/src/05b-jma-parser.js
//
// 作用：把気象庁防災情報XML 的电文解析成与 P2PQuake 同一套内部模型（Alert），
//       让 551/552/556 之外的气象警报（泥石流 / 洪水 / 大雨 / 高潮…）能走同一条主链。
// 内容：Report 结构提取、警戒レベル判定、区域展开（市町村 / 河川予報区域 / 府県予報区）、
//       中文灾害标签、解除判定、事件键。
// 依赖：01-constants、02-storage（own）、04-city-table（市町村反查 / 河川区域表）、
//       05-parser（prefsOfArea）。
//
// 关键事实（均来自 JMA 官方样本实测，样本见 samples/jma-*.xml）：
//   · 警戒レベル写在 <Kind><Name> 里（「レベル４大雨危険警報」「レベル２土砂災害注意報」），
//     或写在 <Head><Headline><Text> 里（「【警戒レベル２相当情報［洪水］】」）——是读出来的，不是推算的。
//   · 指定河川洪水予報（VXKO）的 Kind 名称不带数字（「氾濫注意情報」「氾濫危険情報」），
//     等级要按名称映射；它的区域是**河川予報区域**（12 位代码），必须先经 river-areas 表
//     映射到市町村才能与用户关注比对。
//   · 土砂災害警戒情報（VXWW50）本身就是警戒レベル4 相当，Kind 只有 警戒 / 解除 / なし。
//   · 解除与发布共用同一条电文类型，靠 <Kind> 的 Status / Condition 区分。
// ============================================================================


const LEVEL_DIGITS = { '１': 1, '２': 2, '３': 3, '４': 4, '５': 5, '1': 1, '2': 2, '3': 3, '4': 4, '5': 5 };
// 指定河川洪水予報：Kind 名称 → 警戒レベル（新体系的四个等级）
const FLOOD_KIND_LEVEL = {
  '氾濫注意情報': 2, '氾濫注意報': 2,
  '氾濫警報': 3,
  '氾濫危険情報': 4,
  '氾濫発生情報': 5,
};
// 解除 / 无内容：这些 Kind 不代表"正在发布某种警报"
const INACTIVE_KIND = /^(解除|なし|発表警報・注意報はなし)$/;

/**
 * 旧格式电文的 Kind 名称 → 警戒レベル（0.4.0 修复漏报）。
 *
 * R06 新格式把级别写在名称里（「レベル４大雨危険警報」），旧格式只写名称
 * （「大雨特別警報」「大雨警報」「大雨注意報」）。此前 levelOf() 只认「レベルＮ」字样，
 * 于是**不带级别数字的旧格式电文被整体丢弃**（parseJma 返回 null）——包括最高级别的特别警报。
 * 实测证据（2026-09-07 東京都「大雨特別警報」，见 samples/jma-vpww53-tokyo-special-20260907.xml）：
 * 同一事件的三条电文 VPWW53 / VPWW54 / VPNO50 全部返回 null，插件该事件完全静默；
 * 而同一时刻的 R06 电文只有「その他注意報 / 暴風 / 波浪」，不含这条特别警报。
 * 也就是说：旧格式不是"迟早会被 R06 覆盖的副本"，它是部分时刻唯一的内容载体。
 *
 * 语义依据：気象庁的警报体系里 特別警報 > 危険警報(=L4) > 警報(=L3) > 注意報(=L2)。
 * 注意報级（2）**刻意不返回**：同一次发布往往同时以 VPWW53 与（Ｈ２７）两份副本出现，
 * 把 L2 也抬升等于让历史被同一份注意報的两份副本刷屏；而 L2 本就不播报。
 * R06 的「レベル２」仍照旧解析入历史，行为不变。
 */
function legacyKindLevel(name) {
  const s = String(name || '');
  if (!s) return 0
  if (/特別警報/.test(s)) return 5
  if (/危険警報/.test(s)) return 4
  if (/警報/.test(s) && !/注意報/.test(s)) return 3
  return 0
}
/**
 * **地区级**级别：与 legacyKindLevel 的唯一差别是注意報给出 2（而不是 0）。
 *
 * 为什么必须拆成两个函数：电文级不能把「注意報」抬成 2——同一次发布常有 VPWW53 与（Ｈ２７）
 * 两份副本，抬升会让历史被同一份注意報刷屏（而 L2 本来就不播报）；但地区级必须给出 2，
 * 否则该地区会**回退到电文最大值**：一条含危険警報（L4）的电文里，只到「大雨注意報」的
 * 西脇市会被播成「警戒レベル4（避难指示级）」——实测 2026-09-14 兵庫県就是这样，
 * 同一电文里姫路市是 L4 危険警報、相生市是 L3 大雨警報、西脇市是 L2 大雨注意報。
 */
function regionKindLevel(name) {
  const s = String(name || '');
  if (!s) return 0
  if (/特別警報/.test(s)) return 5
  if (/危険警報/.test(s)) return 4
  if (/注意報/.test(s)) return 2
  if (/警報/.test(s)) return 3
  return 0
}
/** 解除 / 无内容：这些 Kind 不代表"正在发布某种警报"（Name 与 Status 任一命中即算）。 */
const isInactiveItem = (it) => !!it && (INACTIVE_KIND.test(it.kindName) || INACTIVE_KIND.test(it.status));
/** 单个 Item（一条电文里的一个区域块）的警戒レベル：名称里的「レベルＮ」优先，其次河川等级映射与名称语义。 */
function itemLevelOf(it) {
  return Math.max(
    maxLevelIn(it.kindName),
    own(FLOOD_KIND_LEVEL, it.kindName) || 0,
    regionKindLevel(it.kindName),
  )
}
// 电文标题 → 中文标签（M3 才做 i18n，这里与既有 kindLabel 一样先硬编码中文）。
// **特别警报不在这个表里**：它不能只看标题，理由见 kindLabelOf（那是一个真实的文案缺陷）。
const KIND_LABELS = [
  [/土砂災害警戒情報/, '泥石流警戒情报'],
  [/指定河川洪水予報/, '洪水预报'],
  [/（大雨）|[（(]浸水/, '大雨警报'],
  [/（土砂）/, '泥石流警报'],
  [/（洪水）/, '洪水警报'],
  [/（高潮）/, '风暴潮警报'],
  [/（暴風）/, '暴风警报'],
  [/（波浪）/, '海浪警报'],
  [/（雷）/, '雷击警报'],
  [/（濃霧）/, '浓雾警报'],
  [/（乾燥）/, '干燥警报'],
  [/（なだれ）/, '雪崩警报'],
];

// ---------- 最小 XML 取值工具（与 05-parser 的正则风格一致，不引依赖） ----------
const decode = (s) => String(s)
  .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
function block(scope, tagName) {
  const m = new RegExp('<' + tagName + '(?:\\s[^>]*)?>([\\s\\S]*?)</' + tagName + '>').exec(scope);
  return m ? m[1] : ''
}
function tag(scope, tagName) {
  const m = new RegExp('<' + tagName + '(?:\\s[^>]*)?>([\\s\\S]*?)</' + tagName + '>').exec(scope);
  return m ? decode(m[1]).trim() : ''
}
// 文本里出现的最大警戒レベル（全角 / 半角数字都认）
function maxLevelIn(text) {
  let max = 0;
  for (const m of String(text).matchAll(/レベル\s*([１-５1-5])/g)) {
    const n = own(LEVEL_DIGITS, m[1]) || 0;
    if (n > max) max = n;
  }
  return max
}

// ---------- 电文拆分 ----------
// 取值时用 (?:^|\s) 防止 codeType 被 type 的规则误命中。
const attrOf = (attrs, name) => {
  const m = new RegExp('(?:^|\\s)' + name + '="([^"]*)"').exec(String(attrs || ''));
  return m ? m[1] : ''
};

/**
 * 区域类型判定：优先看 codeType，缺失或不可辨时按**代码位数**兜底。
 * 实测位数：市町村 7 位（北九州市 4010000）／府県予報区・細分区域 6 位（宗谷地方 011000）／
 * 河川予報区域 12 位（天塩川 810101000100）。
 * 这条兜底是必需的：気象庁在 Body 的 <Warning> 里常把区域写成**裸 <Area>**（不带
 * <Areas codeType="..."> 包裹），VXWW50 就是这样——只认 codeType 会一个区域都取不到，
 * 表现为"解析成功但 regions 为空"，等于静默漏报。
 */
function regionKindOf(codeType, code) {
  const ct = String(codeType || '');
  if (/市町村/.test(ct)) return 'city'
  if (/予報区域/.test(ct)) return 'river'
  if (/府県予報区|細分区域/.test(ct)) return 'pref'
  // 显式给出 codeType 但不在上面的集合里 → 判**未知**，不再退回按码位数猜（0.4.2）。
  // 放宽 <Area> 匹配之后会摄入 `水位観測所` 这类非行政区域，位数兜底会把码长恰好 6/7 位的
  // 它们变成幻影的府県予報区 / 市町村区域。位数兜底只服务于"根本没给 codeType"的裸 <Area>
  // （实测 VXWW50 的 Body 就是这种形态）。
  if (ct) return ''
  const c = String(code || '');
  if (/^\d{12}$/.test(c)) return 'river'
  if (/^\d{7}$/.test(c)) return 'city'
  if (/^\d{6}$/.test(c)) return 'pref'
  return ''
}

/**
 * 提取电文里的 (Kind, 区域) 条目。
 * 按 <Warning type="…"> / <Information type="…"> 容器切块，块内 Item 继承该 type 作为 codeType；
 * 容器内的 <Areas codeType="…"> 优先，没有则退回 Item 里的裸 <Area>。
 * 传入**全文**（而不是只传 Body）：市町村清单常只出现在 Head 的 <Information> 里。
 */
function itemsOf(scope) {
  const out = [];
  const containers = [];
  for (const m of String(scope).matchAll(/<(Warning|Information)([^>]*)>([\s\S]*?)<\/\1>/g)) {
    containers.push({ type: attrOf(m[2], 'type'), body: m[3] });
  }
  if (containers.length === 0) containers.push({ type: '', body: String(scope) });
  // 宽松的 <Area> 匹配（0.4.1）：原写法要求 `<Area>` 后紧跟 `<Name>` 再 `<Code>`，
  // 于是 ①带属性的 `<Area codeType="…">`（实测 jma-vxko-flood.xml 里就有）、
  // ②Name/Code 之间插了其它子元素、③只有 Name 没有 Code 的条目，都会被**静默丢弃**。
  // 表现是"解析成功但 regions 为空"——而 regions 为空就直接不播报，等于静默漏报。
  // 改为按块取、块内各自取值；codeType 先看 <Area> 自身的属性，再退回容器/外层。
  const AREA = /<Area(\s[^>]*)?>([\s\S]*?)<\/Area>/g;
  const areasIn = (blockText, fallbackType) => {
    const list = [];
    for (const a of String(blockText).matchAll(AREA)) {
      const name = tag(a[2], 'Name');
      const code = tag(a[2], 'Code');
      if (!name && !code) continue
      list.push({ codeType: attrOf(a[1], 'codeType') || fallbackType, name, code });
    }
    return list
  };
  for (const c of containers) {
    for (const im of c.body.matchAll(/<Item>([\s\S]*?)<\/Item>/g)) {
      const raw = im[1];
      const kindBlock = block(raw, 'Kind');
      const item = {
        codeType: c.type,
        kindName: tag(kindBlock, 'Name'),
        kindCode: tag(kindBlock, 'Code'),
        status: tag(kindBlock, 'Status') || tag(kindBlock, 'Condition'),
        areas: [],
      };
      const wrapped = [...raw.matchAll(/<Areas([^>]*)>([\s\S]*?)<\/Areas>/g)];
      if (wrapped.length) {
        for (const am of wrapped) {
          const ct = attrOf(am[1], 'codeType') || c.type;
          for (const a of areasIn(am[2], ct)) item.areas.push(a);
        }
      } else {
        for (const a of areasIn(raw, c.type)) item.areas.push(a);
      }
      out.push(item);
    }
  }
  return out
}

/**
 * 判定电文整体的警戒レベル：取自 Kind 名称、Headline 文本、标题，三者取最大。
 * 指定河川洪水予報另按 Kind 名称映射；土砂災害警戒情報固定为 4（它本身就是 L4 相当）。
 */
function levelOf({ title, headTitle, headlineText, notice, items, inactiveScope }) {
  let level = 0;
  for (const it of items) {
    // 用 isInactiveItem（Name **或** Status 任一命中即算解除）：只看 Name 会把
    // "Status=解除、Name 仍是灾种名"的条目算进级别，让解除电文的文案出现「警戒レベル3」。
    if (isInactiveItem(it)) continue
    // 电文级**刻意不含注意報的 2**：同一次发布常有 VPWW53 与（Ｈ２７）两份副本，
    // 把 L2 也抬升等于让历史被同一份注意報刷屏（而 L2 本来就不播报）。逐区级别另算（见 itemLevelOf）。
    const inName = maxLevelIn(it.kindName);
    if (inName > level) level = inName;
    const mapped = own(FLOOD_KIND_LEVEL, it.kindName) || 0;
    if (mapped > level) level = mapped;
    const legacy = legacyKindLevel(it.kindName);
    if (legacy > level) level = legacy;
  }
  // 除标题与主文之外还必须读 **<Body><Notice>**：Ｒ０６ 的総合副本（VPWW53/54）把多灾种
  // 多级别合并成一条电文，Kind 只写灾种名（「大雨警報」），地区级级别只出现在 Notice 里：
  //   ［危険警報・氾濫特別警報の発表状況］〈レベル４大雨危険警報〉姫路市　たつの市　多可町＊
  // 实测 2026-09-14 兵庫県：不读 Notice 时整条被判成 L3，一条真实存在的 L4 危険警報完全不播报。
  for (const s of [headlineText, notice, headTitle, title]) {
    const n = maxLevelIn(s);
    if (n > level) level = n;
  }
  // 有些电文只在主文里写〈危険警報（大雨、土砂災害）〉而不带「レベルＮ」字样。
  // 「危険警報」在気象庁体系里固定是 L4 相当，所以按语义兜底 —— 但**必须要求它出现在〈…〉条目里**。
  //
  // 0.4.2 修正：Notice 的栏目名固定写作「［危険警報・氾濫特別警報の発表状況］」，没有内容时正文是
  // 「なし」。用裸 `/危険警報/` 匹配会把**每一条**带这个 Notice 的电文都抬成 L4 ——
  // 实测 live：同一发布的総合副本被判 level=4（文案/配色夸大成"避难指示级"），
  // 而 Ｒ０６ 的大雨分灾种副本只有 level=2。要求 `〈…危険警報` 就把"栏目名"排除掉了。
  const dangerItem = /〈[^〉]*危険警報/.test(String(headlineText || '') + ' ' + String(notice || ''));
  if (level < 4 && dangerItem) level = 4;
  if (level === 0 && /土砂災害警戒情報/.test(title)) level = 4;
  // 「気象特別警報報知」是气象厅为特別警報专发的最高优先级报知电文；正常情况它的 Kind 名称
  // 就是「大雨特別警報」（已被上面的映射接住），这里只是 Kind 缺失时的兜底。
  // 必须排除"整条电文都是解除"的情况：解除报知的 Kind 是「解除」（循环里被 continue 跳过），
  // 若不排除，标题兜底会把一条解除消息抬成 L5，headline 会显示成「警戒レベル5（已解除）」。
  // 判定必须与 cancelled 用同一个口径（只看 Body 副本，见 parseJma）：
  // JMA 常把解除写在 <Status> 里而 Name 为空，且 Head 的摘要副本根本没有 Status。
  const scope = inactiveScope || items;
  const allInactive = scope.length > 0 && scope.every(isInactiveItem);
  if (level === 0 && !allInactive && /気象特別警報報知/.test(title)) level = 5;
  return level
}

/**
 * 从 <Body><Notice> 里解析「级别 → 地区名列表」。
 *
 * 格式（实测 2026-09-14 兵庫県 VPWW53）：`〈レベル４大雨危険警報〉姫路市　たつの市　多可町＊`
 * ——全角空格分隔，`＊` 表示"此外还有"（列表不完整）。所以这里只做**精确提升**：
 * 列出的地区提升到该级别，没列出的仍按自己的 Kind 判定（R06 分灾种副本通常同时存在，
 * 它带精确的逐区级别，会照常播报那些地区）。解析不出来就返回空表，调用方回退电文级别。
 */
function noticeAreaLevels(notice) {
  const text = String(notice || '');
  if (!text || text.indexOf('レベル') === -1) return []
  const out = [];
  const push = (digit, listText) => {
    const level = own(LEVEL_DIGITS, digit) || 0;
    if (level <= 0) return
    const names = String(listText)
      .split(/[\s\u3000、,，]+/)
      // 去掉尾随的省略标记：**半角的 `*` 也会粘在最后一个地区名上**（只排除全角 `＊`
      // 会让"只列一个市町村"的 Notice 把那个唯一的 L4 城市漏掉 → 整条 L4 电文不播报）。
      .map((s) => s.replace(/[*＊※…]+$/g, '').trim())
      .filter(Boolean);
    if (names.length) out.push({ level, names });
  };
  // 形态 A：〈レベル４大雨危険警報〉姫路市　たつの市　多可町＊
  //  `[^〉\n]{0,40}〉` 把"级别标记到 〉"限在同一行、限长 40 字：原来的 `[^〉]*` 会跨段一直吃到
  //  后面某段的 `〉`，把级别错配到别的市町村（实测构造：正文先出现「レベル4」、之后才有另一个
  //  〈…〉时，后一段的地区被抬成 L4，而真正的 L4 地区保持 L3 —— 误报与漏报同时发生）。
  // 地区列表用 `[\s\S]{0,300}?` + 前瞻到 `〈` / `］` / 结尾：允许跨行，但不会吞进下一段。
  for (const m of text.matchAll(/レベル\s*([１-５1-5])[^〉\n]{0,40}〉([\s\S]{0,300}?)(?=〈|］|$)/g)) push(m[1], m[2]);
  // 形态 B：［警戒レベル４相当情報の発表状況］\n姫路市　たつの市 —— 级别写在**栏目名**里，
  // 地区列表紧随其后（指定河川洪水予報的主文就是这种写法）。
  for (const m of text.matchAll(/［[^］\n]*レベル\s*([１-５1-5])[^］]*］([\s\S]{0,300}?)(?=〈|［|$)/g)) push(m[1], m[2]);
  return out
}
/** 把 Notice 里的地区级级别套到 regions 上（名称经假名归一比较写法差异）。只在更高时提升。 */
function applyNoticeLevels(regions, notice) {
  const pairs = noticeAreaLevels(notice);
  if (pairs.length === 0) return regions
  for (const r of regions) {
    const own1 = normKana(r.city || '');
    const own2 = normKana(r.area || '');
    for (const p of pairs) {
      let hit = false;
      for (const n of p.names) {
        const k = normKana(n);
        if ((own1 && own1 === k) || (own2 && own2 === k)) { hit = true; break }
      }
      if (hit && p.level > (r.level || 0)) r.level = p.level;
    }
  }
  return regions
}

/**
 * 区域展开：一律归到「都道府県 + 市町村」两层，查不到归属县就标记 prefUnknown（放行）。
 *
 * 市町村名必须换成**本表的规范写法**（canonicalCityOf）再放进 region.city：用户勾选的
 * 市町村名来自市区町村表，而电文与河川区域表给的是外部写法（「南アルプス市」vs 本表
 * 「南あるぷす市」、「金ケ崎町」vs「金け崎町」），直接比对会漏报。取不到规范名时回退原写法。
 */
function regionsOf(items, notice) {
  const out = [];
  const at = new Map(); // 区域键 → out 下标：同一区域重复出现时保留更高的级别
  const push = (region, level) => {
    const key = region.pref + '|' + (region.city || '') + '|' + region.area;
    const idx = at.get(key);
    if (idx !== undefined) {
      if (level > (out[idx].level || 0)) out[idx].level = level;
      return
    }
    at.set(key, out.length);
    out.push(level > 0 ? Object.assign({ level }, region) : region);
  };
  for (const it of items) {
    if (isInactiveItem(it)) continue
    // 逐区级别：由这条 Item 自己的 Kind 决定。**不能用电文最大值**——同一次发布里
    // 姫路市可以是 L4 危険警報、相生市 L3 大雨警報、西脇市 L2 大雨注意報（2026-09-14 兵庫県）。
    const lv = itemLevelOf(it);
    for (const a of it.areas) {
      const kind = regionKindOf(a.codeType, a.code);
      if (kind === 'city' || kind === 'pref') {
        const city = kind === 'city' ? (canonicalCityOf(a.name) || a.name) : '';
        // 判县优先用区域码前两位（准确），名称反查只在前者不可用时兜底
        const byCode = prefOfCode(a.code);
        if (byCode) {
          push({ pref: byCode, area: a.name, city }, lv);
          continue
        }
        const prefs = kind === 'city' ? prefsOfCity(a.name) : prefsOfArea(a.name);
        if (prefs.length === 0) push({ pref: '', area: a.name, city, prefUnknown: true }, lv);
        else for (const p of prefs) push({ pref: p, area: a.name, city }, lv);
      } else if (kind === 'river') {
        // 河川予報区域码是 12 位，前两位与都道府県无关，只能查 river-areas 表
        const cities = riverAreaCities(a.code);
        if (cities.length === 0) push({ pref: '', area: a.name, city: '', prefUnknown: true }, lv);
        else {
          for (const raw of cities) {
            const c = canonicalCityOf(raw) || raw;
            const prefs = prefsOfCity(c);
            if (prefs.length === 0) push({ pref: '', area: a.name, city: c, prefUnknown: true }, lv);
            else for (const p of prefs) push({ pref: p, area: a.name, city: c }, lv);
          }
        }
      }
      // 判不出类型的条目（水位観測所等）一律忽略
    }
  }
  // <Body><Notice> 是総合副本里唯一的地区级级别来源（见 noticeAreaLevels）
  return applyNoticeLevels(out, notice)
}

/**
 * 电文标题 → 中文标签。**特别警报必须结合级别判**（0.5.4）。
 *
 * 「気象特別警報・警報・注意報」是 VPWW53 的**产品名**（総括副本），它只说明"这份电文覆盖
 * 特別警報／警報／注意報三类"，与这一条里到底有没有特別警報无关——实测 2026-09-14 兵庫県的
 * 同名产品名承载的是「危険警報（大雨・土砂災害）」（L4），而特別警報是気象庁的**最高级别**
 * （L5，命を守る行動）。只看标题就会把一条 L4 显示成「气象特别警报」，把官方等级说高一级
 *（与 0.4.2 修过的"文案夸大成避难指示级"同形，方向相反）。反过来 VPWW54 的
 *「気象警報・注意報（Ｈ２７）」在 L5 时只会显示成「气象警报」，是低估。
 * 所以这一族（SUMMARY_TITLE 里的四种产品名）按**级别**取标签；带灾种名的分灾种副本
 *（（大雨）／（土砂）…）仍按标题。
 */
function kindLabelOf(title, level) {
  const t = String(title || '');
  // ① 先按**灾种**匹配：带灾种名的副本（（大雨）／（土砂）／指定河川洪水予報…）给出的是具体
  // 灾种，比"气象警报"这种概括标签有信息量，所以它们的优先级高于下面的汇总族。
  for (const [re, label] of KIND_LABELS) if (re.test(t)) return label
  // ② 汇总族（SUMMARY_TITLE 的四种产品名）与概括名「気象警報・注意報」本身不含灾种 → 按级别取。
  if (SUMMARY_TITLE.test(t) || /気象警報・注意報/.test(t)) {
    return (typeof level === 'number' && level >= 5) ? '气象特别警报' : '气象警报'
  }
  return t || '气象警报'
}

/**
 * 汇总型电文：同一次发布会有 2〜3 份**不同格式的副本**同时出现在 feed 里
 * （实测 2026-09-07 東京都特別警報：VPWW53「気象特別警報・警報・注意報」、
 * VPWW54「気象警報・注意報（Ｈ２７）」、VPNO50「気象特別警報報知」，时间戳 13:57:52〜54）。
 * 它们的 title / headTitle 各不相同，而気象警報・注意報 的 EventID 又是空的——
 * 若沿用「标题」做事件键，同一条警报会被当成三个事件、连响三次铃。
 */
const SUMMARY_TITLE = /気象特別警報・警報・注意報|気象警報・注意報（Ｈ２７）|気象警報・注意報（Ｒ０６）|気象特別警報報知/;
// 灾种关键词（顺序 = 优先级无关，按最高级别的 Kind 名称匹配具体灾种）
const HAZARD_KEYS = [
  [/大雨|浸水/, '大雨'], [/土砂/, '土砂'], [/洪水|氾濫/, '洪水'], [/高潮/, '高潮'],
  [/暴風/, '暴風'], [/波浪/, '波浪'], [/雷/, '雷'], [/濃霧/, '濃霧'],
  [/乾燥/, '乾燥'], [/なだれ/, 'なだれ'], [/大雪|着雪/, '大雪'],
];
/** 取级别最高的那条 Kind 名称，再从中提取灾种——副本之间只要最高级条目相同就会得到同一个键。 */
function hazardKeyOf(items, fallbackText) {
  let name = '';
  let best = -1;
  for (const it of items) {
    if (isInactiveItem(it)) continue
    const lv = itemLevelOf(it);
    if (lv > best) { best = lv; name = it.kindName; }
  }
  for (const [re, key] of HAZARD_KEYS) if (re.test(name)) return key
  if (name) return name
  // Kind 里没有任何灾种信息（解除报知只写「解除」）→ 退回主文里认灾种。
  // 这是解除电文能与发布电文算出同一个键的前提之一（另一个是键里不含发布时刻）。
  for (const [re, key] of HAZARD_KEYS) if (re.test(String(fallbackText || ''))) return key
  return '气象'
}

/**
 * 解析一条 JMA 电文。返回 null 表示这条电文与本插件无关（天气预报、地震火山、观测资料等）。
 * @param {string} xml 详情电文原文
 * @param {{ id?: string }} [entry] Host 侧 feed 条目（用于给 Alert 一个稳定 id）
 * @returns {object|null} Alert
 */
function parseJma(xml, entry) {
  // 先剥掉 XML 注释（0.4.2）：注释里完全可能出现 `<Body>` / `<Notice>` / 「レベル４」这类字样
  // （我们自己的回归 fixture 就写过），而 block()/tag() 的正则只认标签、不认注释——
  // 于是 block(text,'Body') 会从注释内部开始，notice 变成"注释文本 + 末尾真正的 Notice"。
  // 注释在 XML 语义里不参与文档结构，先去掉最省事也最正确。
  // indexOf 早退：未闭合的 `<!--` 会让惰性量词退化成 O(n²) 回溯。
  let text = String(xml || '');
  if (text.indexOf('<!--') !== -1 && text.indexOf('-->') !== -1) text = text.replace(/<!--[\s\S]*?-->/g, '');
  if (!text || text.indexOf('<Report') === -1) return null
  const control = block(text, 'Control');
  const head = block(text, 'Head');
  const body = block(text, 'Body');

  const title = tag(control, 'Title') || tag(head, 'Title');
  const headTitle = tag(head, 'Title');
  const headlineText = tag(block(head, 'Headline'), 'Text');
  // <Body><Notice>：Ｒ０６ 総合副本里唯一的地区级级别来源（见 levelOf / noticeAreaLevels）
  const notice = tag(body, 'Notice');
  const reportTime = tag(head, 'ReportDateTime') || tag(control, 'DateTime');
  const eventId = tag(head, 'EventID');
  // 用**全文**提取条目：市町村清单常只出现在 Head 的 <Information> 里（Body 的 <Warning>
  // 反而只有摘要），只看 Body 会取不到区域。重复条目由 regionsOf 去重兜住。
  const items = itemsOf(text);
  // 解除判定只看 **Body** 副本（0.4.2）：Head 的 <Information> 摘要项通常**没有 <Status>**
  // （实测 live 电文：Head 的 Kind 只有 Name/Code/Condition，Body 的 Kind 才有 Status），
  // 而 every() 是跨两份副本聚合的——Head 里那条同名 Item 会把"Status=解除"稀释成"发布"，
  // 于是真实的解除电文被当成一次新发布。Body 缺失时退回全部 items（兼容只给 Head 的构造电文）。
  const bodyItems = itemsOf(body);
  const inactiveScope = bodyItems.length > 0 ? bodyItems : items;

  const level = levelOf({ title, headTitle, headlineText, notice, items, inactiveScope });
  const cancelled = inactiveScope.length > 0 && inactiveScope.every(isInactiveItem);
  // 没有级别又不是解除 → 与预警无关（天气预报、观测资料等），交给调用方丢弃
  if (level === 0 && !cancelled) return null

  const regions = cancelled ? [] : regionsOf(items, notice);
  // 解除电文若展开不出区域，至少保留一个空区域条目，让事件键与提示仍可工作
  const kindLabel = kindLabelOf(title, level);
  const first = String(headlineText || '').split(/[。\n]/)[0].trim();
  const levelText = level > 0 ? '（警戒レベル' + level + '）' : '';
  const headline = (kindLabel + levelText + (first ? ' · ' + first : '')).slice(0, 180);
  // 事件键：优先 EventID，其次 Head 标题。汇总型电文（同时存在多份格式副本）改用**内容指纹**
  // ——「灾种 + 編集官署名コード」——否则同一条警报会因副本标题不同而被当成三个事件、连响三次。
  //
  // 指纹里**刻意不含发布时刻**。原因有两层，都是实测出来的：
  //   ① 同一次发布的副本会跨分钟：2026-09-14 兵庫県，Ｒ０６ 分灾种副本（VPWW55/56）在 11:30:33，
  //      総合副本（VPWW53/54）在 11:31:10——按分钟切片后两者永远算不出同一个键；
  //   ② 更致命的是**解除**：解除报知的发布时间必然晚于发布（实测相差 5 小时），
  //      指纹含时刻就注定让解除与发布算出不同的键，handleCancelled 于是永远找不到"此前提醒过的事件"，
  //      0.1.3 加入的解除链路实际从未生效。去掉时刻后，同一官署 + 同一灾种在事件窗口内共用一个键，
  //      重复与升级由去重层判定（strength 升级仍会再次提醒，解除时清掉该键，见 10-dedupe）。
  //
  // 官署名碼取电文 id 的后缀（編集官署名コード：130000=気象庁、280000=神戸地方気象台…），
  // 而不是 regions[0]：解除电文的 regions 恒为空，用 regions 同样会让两边算不出同一个键。
  //
  // **取不到后缀时退回 <EditorialOffice> 文本，绝不留空**（0.4.2）：留空会让所有官署的同一灾种
  // 共用一个键（实测 entry.id 为 `vxww50` 这类不含 6 位后缀的形态时，兵庫与東京的电文都算出
  // `jma:summary:大雨:`），一次发布会被当成另一次发布的重复而静默。真实 feed 的 id 带后缀，
  // 但"源改文件名格式"不该变成静默漏报。
  const idSuffix = /([0-9]{6})\.xml$/.exec(String((entry && entry.id) || ''));
  const officeKey = (idSuffix ? idSuffix[1] : '') ||
    tag(control, 'EditorialOffice') || tag(control, 'PublishingOffice') || 'unknown';
  const eventKey = SUMMARY_TITLE.test(title)
    ? 'jma:summary:' + hazardKeyOf(items, headlineText) + ':' + officeKey
    : 'jma:' + (eventId || headTitle || title);

  return {
    id: (entry && entry.id) || eventId || title,
    code: 'jma',
    kind: 'weather',
    kindLabel: cancelled ? kindLabel + '（已解除）' : kindLabel,
    severity: level >= 4 ? 'red' : (level === 3 ? 'orange' : (level === 2 ? 'yellow' : 'info')),
    issued: reportTime,
    headline,
    level,
    maxScale: level,
    hypo: { name: '', magnitude: null },
    regions: regions.length ? regions : [],
    eventKey,
    strength: level,
    cancelled,
    raw: { title, headTitle, eventId, infoType: tag(head, 'InfoType'), serial: tag(head, 'Serial') },
  }
}

/**
 * 测试电文场景。按顺序轮换，覆盖链路上不同的分支：
 *   · 级别落点不同：Kind 名称里（大雨 / 高潮 / L3 土砂）／电文标题本身即 L4（土砂災害警戒情報）／
 *     Headline 主文里（指定河川洪水予報）
 *   · 区域粒度不同：市町村级 / 府県予報区级
 *   · 边界两侧：L4（播报）与 L3（不播报，只记历史与侧边栏提示）
 */
const TEST_SCENARIOS = [
  { key: 'landslide', label: '泥石流警戒情报', note: '市町村级 / 电文本身即 L4' },
  { key: 'flood', label: '指定河川洪水予報（氾濫危険情報）', note: '级别写在主文里' },
  { key: 'heavyrain', label: '大雨危険警報', note: '级别写在 Kind 名称里' },
  { key: 'stormsurge', label: '高潮危険警報', note: '级别写在 Kind 名称里' },
  { key: 'landslide-l3', label: '泥石流警報（警戒レベル3）', note: '未达 L4：不播报' },
];

function testXml(o) {
  const stamp = new Date(o.ms).toISOString();
  return '<?xml version="1.0" encoding="UTF-8"?>' +
    '<Report xmlns="http://xml.kishou.go.jp/jmaxml1/">' +
    '<Control><Title>' + o.controlTitle + '</Title><DateTime>' + stamp + '</DateTime>' +
    '<Status>通常</Status><EditorialOffice>QuakeAlert テスト</EditorialOffice></Control>' +
    '<Head xmlns="http://xml.kishou.go.jp/jmaxml1/informationBasis1/">' +
    '<Title>' + o.headTitle + '</Title><ReportDateTime>' + stamp + '</ReportDateTime>' +
    '<EventID>' + o.eventId + '</EventID><InfoType>発表</InfoType><Serial>' + o.ms + '</Serial>' +
    '<Headline><Text>' + o.headlineText + '</Text>' +
    '<Information type="' + o.infoType + '"><Item>' +
    '<Kind><Name>' + o.kindName + '</Name><Code>' + o.kindCode + '</Code><Status>発表</Status></Kind>' +
    '<Areas codeType="' + o.codeType + '">' +
    '<Area><Name>' + o.areaName + '</Name><Code>' + o.areaCode + '</Code></Area>' +
    '</Areas></Item></Information></Headline></Head><Body/></Report>'
}

/**
 * 构造一条**测试用**电文（不联网、不经过 Host 轮询）——设置页的「发送测试气象警报」
 * 按钮用它走完整链路，让用户在无灾情时也能确认提醒与音效长什么样。
 *
 * 区域挂在"用户关注的第一个都道府县"下：若写死一个县，关注别处的用户点下去会被匹配挡掉、
 * 什么都不发生，反而以为插件坏了；用关注列表首项才能保证走通。没选任何县（全日本模式）时
 * 退回東京都。判县只看区域码前两位，所以这里用县码拼出的码就足够。
 *
 * id 与 EventID 都带时间戳与场景名：否则第二条会被消息级去重挡住，或被事件级去重当成
 * "强度未升级的重复发布"而只记历史、不播报——连点两次就没反应了。
 *
 * @param {string} pref 都道府县名（关注列表首项）
 * @param {number} nowMs 时间戳
 * @param {string} [key] TEST_SCENARIOS 里的 key，默认 landslide
 * @param {string} [cityName] 市町村级场景用的市町村名（表未加载时可省略，退回县名）
 */
function buildTestTelegram(pref, nowMs, key, cityName) {
  const p = pref || '東京都';
  const pc = prefCodeOf(p) || '13';
  const ms = nowMs || Date.now();
  const scenario = key || 'landslide';
  const eventId = 'QUAKEALERT-TEST-' + scenario + '-' + ms;
  const base = { ms, eventId };
  const city = cityName || '';
  if (scenario === 'flood') {
    return testXml(Object.assign(base, {
      controlTitle: '指定河川洪水予報',
      headTitle: p + '指定河川洪水予報（テスト）',
      headlineText: '【警戒レベル４相当情報［洪水］】' + p + 'のテスト川では、氾濫危険水位に到達しています' +
        '（这是一条测试警报，不是真实灾情）。',
      infoType: '指定河川洪水予報',
      kindName: '氾濫危険情報', kindCode: '40',
      codeType: '気象情報／府県予報区・細分区域等',
      areaName: p, areaCode: pc + '0000',
    }))
  }
  if (scenario === 'heavyrain' || scenario === 'stormsurge') {
    const isSurge = scenario === 'stormsurge';
    const kind = isSurge ? '高潮危険警報' : '大雨危険警報';
    const field = isSurge ? '高潮' : '大雨';
    return testXml(Object.assign(base, {
      controlTitle: '気象警報・注意報（Ｒ０６）（' + field + '）',
      headTitle: p + field + '警報・注意報（テスト）',
      headlineText: p + 'にレベル４' + kind + 'を発表しています（这是一条测试警报，不是真实灾情）。',
      infoType: '気象警報・注意報（府県予報区等）',
      kindName: 'レベル４' + kind, kindCode: isSurge ? '48' : '43',
      codeType: '気象情報／府県予報区・細分区域等',
      areaName: p, areaCode: pc + '0000',
    }))
  }
  if (scenario === 'landslide-l3') {
    return testXml(Object.assign(base, {
      controlTitle: '気象警報・注意報（Ｒ０６）（土砂）',
      headTitle: p + '土砂災害警報・注意報（テスト）',
      headlineText: p + 'にレベル３土砂災害警報を発表しています（这是一条测试警报，不是真实灾情）。',
      infoType: '気象警報・注意報（府県予報区等）',
      kindName: 'レベル３土砂災害警報', kindCode: '03',
      codeType: '気象情報／府県予報区・細分区域等',
      areaName: p, areaCode: pc + '0000',
    }))
  }
  // 默认：土砂災害警戒情報（电文本身就是警戒レベル4 相当，区域是市町村）
  return testXml(Object.assign(base, {
    controlTitle: '土砂災害警戒情報',
    headTitle: p + '土砂災害警戒情報（テスト）',
    headlineText: '【警戒レベル４相当情報［土砂災害］】' + p + city +
      'では、土砂災害が発生するおそれが高まっています（这是一条测试警报，不是真实灾情）。',
    infoType: '土砂災害警戒情報',
    kindName: '警戒', kindCode: '3',
    codeType: '気象・地震・火山情報／市町村等',
    areaName: city || p, areaCode: pc + '00000',
  }))
}

// ============================================================================
// dsh-quake-alert · client/src/05c-global-parsers.js
//
// 作用：把三个全球源的消息解析成与日本源同一套内部模型（Alert）。
// 内容：EMSC standing_order WebSocket（GeoJSON Feature）、USGS summary feed
//       （FeatureCollection）、NOAA tsunami.gov 的 CAP 1.2 电文。
// 依赖：02-storage（isPlainObject）。
//
// 与日本源的差别，也是本文件引入的新字段：
//   · 全球源只给「震中坐标 + 震级」，没有都道府县 / 市町村 → `locator: 'point'`、
//     `regions` 恒为空数组，匹配交给 06-matcher 的 matchPointAlert 用 Haversine 距离完成。
//   · 震级（M）与日本的震度是两套不可换算的体系，所以阈值也是独立旋钮
//     （thresholds.globalMagnitude），而不是复用 quakeScale。
//
// 字段差异全部来自实测样本（见 samples/global/），踩过的坑写在各自函数上方：
//   · EMSC：顶层 { action, data }，data 是 GeoJSON **Feature**（不是 FeatureCollection）；
//     区域字段叫 flynn_region（没有 region）；time 是 ISO8601 字符串；lat/lon 在 properties 里。
//   · USGS：FeatureCollection；geometry.coordinates = [lon, lat, depthKm]；time/updated 是 epoch 毫秒。
//   · NOAA CAP：alert > info > area > circle "lat,lon 半径"；震级与位置同时也在 info 的
//     parameter 里（EventPreliminaryMagnitude / EventLatLon）。
// ============================================================================


/** 取第一个可用数值（全球源的坐标/震级可能同时存在于两三个地方，按优先级回退）。
 *  经 toNumOrNull 归一，所以**数字字符串也算**：源侧类型并不稳定（CAP 的 parameter 里全是字符串，
 * 而 EMSC/USGS 某次改版也可能把 mag 序列化成 "5.6"）。只认 typeof number 的话，
 * `magnitude` 会变成 null → 震级闸门被整个跳过 → 低于阈值的地震照常响铃（误报）。 */
function firstNumber(...vals) {
  for (const v of vals) {
    const n = toNumOrNull(v);
    if (n !== null) return n
  }
  return null
}
/** 字符串（CAP 的 parameter 里全是字符串）→ 数值；空串与垃圾值一律给 null。
 *  注意不能用 Number('')——它等于 0，会把"没有震级"变成"震级 0"。 */
function toNumOrNull(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null
  const s = String(v === undefined || v === null ? '' : v).trim();
  if (!s) return null
  const n = Number(s);
  return Number.isFinite(n) ? n : null
}
function decodeXml(s) {
  return String(s)
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&')
}
/** 单个标签的文本（取首个匹配；CAP 的 info/area 都是单层，够用）。 */
function tagText(scope, name) {
  const m = new RegExp('<' + name + '(?:\\s[^>]*)?>([\\s\\S]*?)</' + name + '>').exec(String(scope));
  return m ? decodeXml(m[1]).trim() : ''
}

/**
 * 震级 → severity。日本源按震度分级（10..70），全球源只有震级，所以这里单独一套边界。
 * 取值依据：M7 以上是「需要跨区域响应」的大地震，M6 以上可能造成局部破坏，
 * M5 以上普遍有感——与 EMSC/USGS 的公众提示口径一致。
 */
function severityOfMagnitude(mag) {
  if (typeof mag !== 'number' || !Number.isFinite(mag)) return 'info'
  if (mag >= 7) return 'red'
  if (mag >= 6) return 'orange'
  if (mag >= 5) return 'yellow'
  return 'info'
}

/**
 * 事件键里的「发震时刻（分钟）」必须先**归一到 UTC**再取分钟。
 *
 * 各源给的 ISO 字符串偏移不同：EMSC 是 `…Z`、USGS 经 toIso 也是 `…Z`，而 0.5.0 新接的大陆源是
 * `+08:00`。直接切字符串前 16 位的话，同一场地震在两边会落进**相隔 8 小时**的两个桶里——
 * 键永远不相等，跨源归并彻底失效，同一场地震响两次（实测样本里 cenc_eqlist 含境外地震，
 * 福克斯群岛 M6.5 这类事件 USGS / EMSC 也会推，所以这条路径是走得到的，不是理论问题）。
 *
 * 无法解析时退回原串切片：宁可归并失败多响一次，也不能为了一致性把消息丢掉。
 */
function minuteKeyOf(timeIso) {
  const s = String(timeIso === undefined || timeIso === null ? '' : timeIso);
  const t = Date.parse(s);
  if (!Number.isFinite(t)) return s.slice(0, 16)
  return new Date(t).toISOString().slice(0, 16)
}

/**
 * 跨源事件键：同一场地震 EMSC 与 USGS 都会推，两边机构、编号、震级都可能不同，
 * 但「发震时刻（分钟）+ 震中（0.1 度 ≈ 11km）」是一致的。用它把两个全球源的同一次地震
 * 归并成一个事件，避免同一场地震因为接了第二个源而响两次。
 * 代价：跨分钟边界（两边测定的发震时刻差过一分钟）时归并会失败——宁可多响一次，不漏报。
 * 0.5.0 起大陆源（cenc_eew / cenc_eqlist）也走同一把钥匙：它们的 **EventID 与 EEW 完全不同格式**
 * （EEW 是 `b4kybfnuqayyy` 这类随机串，速报是 `CD.20260918205536.056`；0.5.4 按样本修正，
 * 此处原写 EEW 是 `202609182050.0001`），归并只能靠时间 + 震中。
 */
/**
 * 0.1° 桶的字符串化。**必须把 "-0.0" 归一成 "0.0"**：`(-0.02).toFixed(1)` 得到 "-0.0"，
 * 而 `(0.02).toFixed(1)` 得到 "0.0" —— 赤道与本初子午线两侧的震中会落进两个不同的桶，
 * 事件键永远不相等 → 跨源归并失败、同一场地震响两次。近似归并（±2 分钟 + 50km）通常还能
 * 兜住，所以它表现为概率性重复而不是稳定故障（0.5.1 修）。
 */
function oneDp(n) {
  if (typeof n !== 'number' || !Number.isFinite(n)) return '?'
  const s = n.toFixed(1);
  return s === '-0.0' ? '0.0' : s
}

function geoEventKey(timeIso, lat, lon) {
  const min = minuteKeyOf(timeIso);
  return 'geo:' + min + '@' + oneDp(lat) + ',' + oneDp(lon)
}

/** epoch 毫秒或 ISO 字符串 → ISO 字符串（USGS 给毫秒，EMSC 给字符串，统一到后者）。 */
function toIso(v) {
  if (typeof v === 'number' && Number.isFinite(v)) {
    const d = new Date(v);
    return Number.isFinite(d.getTime()) ? d.toISOString() : ''
  }
  return typeof v === 'string' ? v : ''
}

/**
 * EMSC standing_order WebSocket 消息 → Alert。
 * 消息形如 { action: 'create'|'update'|'delete', data: Feature }；非地震事件（爆炸等）由
 * properties.evtype 区分，实测 'ke' = known earthquake。
 */
function parseEmsc(raw) {
  if (!isPlainObject(raw)) return null
  const d = isPlainObject(raw.data) ? raw.data : null;
  const p = d && isPlainObject(d.properties) ? d.properties : null;
  if (!p) return null
  const coords = (d.geometry && Array.isArray(d.geometry.coordinates)) ? d.geometry.coordinates : [];
  const lon = firstNumber(p.lon, coords[0]);
  const lat = firstNumber(p.lat, coords[1]);
  const depth = firstNumber(p.depth, coords[2]);
  const mag = firstNumber(p.mag, null);
  const region = String(p.flynn_region || '').trim();
  const time = toIso(p.time);
  const unid = String(p.unid || p.source_id || d.id || '').trim();
  const headline = 'M' + (mag === null ? '—' : mag) + (region ? ' · ' + region : '') +
    (depth === null ? '' : ' · 深 ' + Math.round(depth) + 'km');
  return {
    id: 'emsc:' + (unid || (lat + ',' + lon + ',' + time)),
    code: 'emsc',
    kind: 'quake',
    kindLabel: '全球地震（EMSC）',
    source: 'emsc',
    locator: 'point',
    severity: severityOfMagnitude(mag),
    issued: time,
    headline,
    maxScale: -1,
    level: 0,
    geo: { lat, lon, depthKm: depth },
    magnitude: mag,
    magType: String(p.magtype || ''),
    hypo: { name: region, magnitude: mag },
    regions: [],
    eventKey: geoEventKey(time, lat, lon),
    strength: mag === null ? 0 : mag,
    cancelled: false,
    raw,
  }
}

/** USGS summary feed 的单个 Feature → Alert。coordinates 顺序是 [经度, 纬度, 深度 km]。 */
function parseUsgsFeature(f) {
  if (!isPlainObject(f)) return null
  const p = isPlainObject(f.properties) ? f.properties : null;
  if (!p) return null
  const coords = (isPlainObject(f.geometry) && Array.isArray(f.geometry.coordinates)) ? f.geometry.coordinates : [];
  const lon = firstNumber(coords[0], p.lon);
  const lat = firstNumber(coords[1], p.lat);
  const depth = firstNumber(coords[2], null);
  const mag = firstNumber(p.mag, null);
  const place = String(p.place || '').trim();
  const time = toIso(p.time);
  const headline = 'M' + (mag === null ? '—' : mag) + (place ? ' · ' + place : '') +
    (depth === null ? '' : ' · 深 ' + Math.round(depth) + 'km');
  return {
    id: 'usgs:' + String(f.id || p.code || (lat + ',' + lon + ',' + time)),
    code: 'usgs',
    kind: 'quake',
    kindLabel: '全球地震（USGS）',
    source: 'usgs',
    locator: 'point',
    severity: severityOfMagnitude(mag),
    issued: time,
    headline,
    maxScale: -1,
    level: 0,
    geo: { lat, lon, depthKm: depth },
    magnitude: mag,
    magType: String(p.magType || ''),
    // USGS 的 alert 字段（green/yellow/orange/red）是 PAGER 的损失评估，11 条实测里全是 null；
    // 这里不做映射，severity 统一按震级判定，避免"两个源对同一地震给出不同颜色"。
    hypo: { name: place, magnitude: mag },
    regions: [],
    eventKey: geoEventKey(time, lat, lon),
    strength: mag === null ? 0 : mag,
    cancelled: false,
    raw: f,
  }
}

/** USGS summary feed（FeatureCollection）→ Alert[]。 */
function parseUsgsFeed(json) {
  const feats = (isPlainObject(json) && Array.isArray(json.features)) ? json.features : [];
  return feats.map(parseUsgsFeature).filter(Boolean)
}

// NOAA tsunami.gov 的事件分级。CAP 的 <severity>（Minor/Moderate/…）对海啸不够具体，
// 真正决定行动的是 <event> 名称，实测样本是 "Tsunami Information"（Minor）。
// 第三项是**等级**，与日本 552 的 TSUNAMI_RANK（Watch=1/Warning=2/MajorWarning=3）同一把尺，
// 由 matchPointAlert 用 thresholds.tsunamiGrade 做闸门。
// 「Tsunami Information」= 0：它在语义上低于日本的「津波注意報」，是"没有破坏性海啸"的信息类
// 电文——按 1 处理会让它在半径内直接响铃（全球海啸无法用等级收敛）。
const NOAA_EVENT_RULES = [
  [/Tsunami Warning/i, '大海啸警报（NOAA）', 3, 'red'],
  [/Tsunami Advisory/i, '海啸注意报（NOAA）', 2, 'orange'],
  [/Tsunami Watch/i, '海啸注意报（NOAA）', 2, 'orange'],
  [/Tsunami Information/i, '海啸信息（NOAA）', 0, 'info'],
];

/**
 * NOAA tsunami.gov 的 CAP 1.2 电文 → Alert。
 * 结构：alert > info > area > circle（"纬度,经度 半径"），震级与震中另有 parameter 备份。
 * msgType=Cancel 表示解除——走与日本源相同的取消 / 解除链路。
 * @param {string} xml CAP 原文
 * @param {{ id?: string }} [entry] 事件列表里的条目（用于给 Alert 一个稳定 id）
 */
function parseNoaaCap(xml, entry) {
  const text = String(xml || '');
  if (text.indexOf('<alert') === -1) return null
  const identifier = tagText(text, 'identifier');
  if (!identifier) return null
  const msgType = tagText(text, 'msgType');
  const event = tagText(text, 'event');
  const sent = tagText(text, 'sent');
  const capHeadline = tagText(text, 'headline');
  const areaDesc = tagText(text, 'areaDesc');
  // parameter 是成对出现的 valueName / value，可能有多个，逐个收进字典
  const params = {};
  for (const m of text.matchAll(/<parameter>([\s\S]*?)<\/parameter>/g)) {
    const n = tagText(m[1], 'valueName');
    if (n) params[n] = tagText(m[1], 'value');
  }
  // 震中优先取 area 的 circle（"纬,经 半径"），它才是配信覆盖范围；EventLatLon 只是备份。
  // CAP 允许一个 info 下**多个 <area>**，各有自己的 circle——全部收集。
  // 只看第一个 circle 会让其余海域的沿海用户漏报，而多区域海啸恰恰是最常见的形态。
  const geoList = [];
  for (const m of text.matchAll(/<circle>([\s\S]*?)<\/circle>/g)) {
    const cm = /^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)/.exec(m[1]);
    if (cm) geoList.push({ lat: Number(cm[1]), lon: Number(cm[2]) });
  }
  if (geoList.length === 0) {
    const em = /^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)/.exec(String(params.EventLatLon || ''));
    if (em) geoList.push({ lat: Number(em[1]), lon: Number(em[2]) });
  }
  const geo = geoList.length ? geoList[0] : { lat: null, lon: null };
  const mag = toNumOrNull(params.EventPreliminaryMagnitude);
  const rule = NOAA_EVENT_RULES.find(([re]) => re.test(event)) ||
    [/./, '海啸信息（NOAA）', 0, 'info'];
  const cancelled = msgType === 'Cancel';
  const origin = String(params.EventOriginTime || sent || '');
  const eventName = String(params.EventLocationName || areaDesc || '').trim();
  const headline = (capHeadline || event || 'NOAA 海啸信息') + (eventName ? ' · ' + eventName : '') +
    (mag === null ? '' : ' · 前震 M' + mag);
  // identifier 形如 PHEB-1-26234000，中间的数字是消息版本号——同一事件的多版要归并成一个键
  const eventKey = 'noaa:' + identifier.replace(/-\d+-/, '-');
  return {
    id: 'noaa:' + (identifier || (entry && entry.id) || eventKey),
    code: 'noaa',
    kind: 'tsunami',
    kindLabel: cancelled ? rule[1] + '（已解除）' : rule[1],
    source: 'noaa',
    locator: 'point',
    severity: cancelled ? 'info' : rule[3],
    issued: sent || origin,
    headline,
    maxScale: rule[2],
    // 与日本 552 的等级共用同一把尺，供 matchPointAlert 做 tsunamiGrade 闸门
    tsunamiRank: rule[2],
    level: 0,
    geo,
    // 多区域电文的全部圆心（matchPointAlert 对任一点命中即算命中）；geo 保留第一个以兼容旧调用方
    geoList,
    magnitude: mag,
    magType: String(params.EventPreliminaryMagnitudeType || ''),
    hypo: { name: eventName, magnitude: mag },
    regions: [],
    eventKey,
    strength: rule[2],
    cancelled,
    raw: { identifier, msgType, event, sent, areaDesc, params },
  }
}


/**
 * 测试场景（0.4.0）。全球源的地震不是随时都有，用户没法"等一条"来验证链路——
 * 日本气象链路早有「发送测试气象警报」按钮，这里补上对应的东西。
 *
 * 与气象按钮同样的做法：**构造源格式的原文**（EMSC 的 WebSocket 帧、USGS 的 GeoJSON feature、
 * NOAA 的 CAP 电文），再交给真正的解析器与匹配引擎。因此点一次就同时验证了
 * 「解析器 → 坐标匹配 → 通知 → 历史」整条链路，而且不发任何网络请求。
 *
 * 四个场景覆盖两个维度：三个源各自的解析路径，以及"半径内命中 / 半径外不命中"。
 */
const TEST_GEO_SCENARIOS = [
  { key: 'emsc', label: 'EMSC 地震（震中就在关注点）', note: 'M6.2', source: 'emsc' },
  { key: 'usgs', label: 'USGS 地震（约 80km 外）', note: 'M5.6 · 近处，小半径也可能不命中', source: 'usgs' },
  { key: 'noaa', label: 'NOAA 海啸注意报', note: 'Tsunami Advisory', source: 'noaa' },
  // 半径是可配的（1–2000km，新建默认 100km），所以这里**不能承诺"一定不命中"**：
  // 旧的「超出默认 300km 半径，刻意不命中」既是 0.4.0 的旧默认值（0.5.0 起新建默认 100km），
  // 也把半径 ≥556km 的用户引向相反的事实——那条测试会真的响铃（0.5.4 修正文案）。
  { key: 'emsc-far', label: 'EMSC 远地地震（约 550km 外）', note: 'M7.0 · 用于演示半径：半径 < 550km 时不命中', source: 'emsc' },
];

// 纬度偏移 1 度约 111km；夹在 ±89.5 以内，避免极端位置把纬度推到界外
const shiftLat = (lat, deg) => Math.max(-89.5, Math.min(89.5, lat + deg));

function capTestXml(identifier, event, headline, name, lat, lon, mag, stamp) {
  return '<?xml version="1.0" encoding="UTF-8"?>' +
    '<alert xmlns="urn:oasis:names:tc:emergency:cap:1.2">' +
    '<identifier>' + identifier + '</identifier><sender>quakealert-test</sender>' +
    '<sent>' + stamp + '</sent><status>Actual</status><msgType>Alert</msgType>' +
    '<info><category>Geo</category><event>' + event + '</event>' +
    '<severity>Moderate</severity><urgency>Expected</urgency><certainty>Likely</certainty>' +
    '<headline>' + headline + '</headline>' +
    '<parameter><valueName>EventLocationName</valueName><value>' + name + '</value></parameter>' +
    '<parameter><valueName>EventPreliminaryMagnitude</valueName><value>' + mag + '</value></parameter>' +
    '<area><areaDesc>' + name + '</areaDesc><circle>' + lat + ',' + lon + ' 0.0</circle></area>' +
    '</info></alert>'
}

/**
 * 按场景构造一条**测试用**的源原文。
 * @param {{name?: string, lat: number, lon: number}} place 用户的第一个全球关注点
 * @param {number} nowMs 时间戳（id 里带上它，连点两次不会被消息级去重吞掉）
 * @param {string} key TEST_GEO_SCENARIOS 里的 key
 * @returns {{ source: string, payload: object|string, label: string, note: string }}
 */
function buildTestGlobalMessage(place, nowMs, key) {
  const ms = nowMs || Date.now();
  const p = place || {};
  const lat = (typeof p.lat === 'number' && Number.isFinite(p.lat)) ? p.lat : 0;
  const lon = (typeof p.lon === 'number' && Number.isFinite(p.lon)) ? p.lon : 0;
  const name = String(p.name || '关注点');
  const stamp = new Date(ms).toISOString();
  const scenario = TEST_GEO_SCENARIOS.filter((s) => s.key === key)[0] || TEST_GEO_SCENARIOS[0];

  if (scenario.key === 'usgs') {
    const shifted = shiftLat(lat, 0.7); // 约 78km
    return {
      source: 'usgs',
      label: scenario.label,
      note: scenario.note,
      payload: {
        type: 'FeatureCollection',
        features: [{
          type: 'Feature',
          id: 'QUAKEALERT-TEST-usgs-' + ms,
          geometry: { type: 'Point', coordinates: [lon, shifted, 25] },
          properties: {
            mag: 5.6, place: name + ' 附近（测试）', time: ms, updated: ms,
            magType: 'mww', tsunami: 0, alert: null, title: 'M 5.6 - QuakeAlert test',
          },
        }],
      },
    }
  }
  if (scenario.key === 'noaa') {
    return {
      source: 'noaa',
      label: scenario.label,
      note: scenario.note,
      payload: capTestXml('QUAKEALERT-TEST-NOAA-' + ms, 'Tsunami Advisory', 'TEST TSUNAMI ADVISORY',
        name, lat, lon, 7.1, stamp),
    }
  }
  const far = scenario.key === 'emsc-far';
  const shifted = far ? shiftLat(lat, 5) : lat; // 5 度约 555km
  const mag = far ? 7.0 : 6.2;
  return {
    source: 'emsc',
    label: scenario.label,
    note: scenario.note,
    payload: {
      action: 'update',
      data: {
        type: 'Feature',
        id: 'QUAKEALERT-TEST-' + scenario.key + '-' + ms,
        geometry: { type: 'Point', coordinates: [lon, shifted, 10] },
        properties: {
          source_id: 'test', unid: 'QUAKEALERT-TEST-' + scenario.key + '-' + ms,
          source_catalog: 'QuakeAlert-TEST', auth: 'QuakeAlert',
          time: stamp, lastupdate: stamp,
          flynn_region: name + ' 附近（测试）',
          lat: shifted, lon, depth: 10,
          mag, magtype: 'mw', evtype: 'ke',
        },
      },
    },
  }
}

/** 测试消息 → Alert：按 source 走对应的真实解析器（与线上链路完全同一条代码路径）。 */
function parseTestGlobalMessage(msg) {
  if (!msg) return null
  let alert = null;
  if (msg.source === 'usgs') {
    const json = typeof msg.payload === 'string' ? JSON.parse(msg.payload) : msg.payload;
    const feats = (json && json.features) || [];
    alert = feats.length ? parseUsgsFeature(feats[0]) : null;
  } else if (msg.source === 'noaa') {
    alert = parseNoaaCap(String(msg.payload), { id: 'test-noaa' });
  } else {
    alert = parseEmsc(msg.payload);
  }
  if (!alert) return null
  // 测试消息的事件键必须每次不同，否则第二次点击会被判成"同一场地震的重复发布"而静默——
  // 用户会以为按钮坏了。生产的事件键按「分钟 + 震中」归并（那是为了让同一场地震只响一次），
  // 连点两次必然落在同一分钟；这里换成带毫秒的 id，语义也成立：每次点击本来就是一次独立演示。
  alert.eventKey = 'test:' + alert.id;
  return alert
}

// ============================================================================
// dsh-quake-alert · client/src/05e-cn-parsers.js
//
// 作用：把 Wolfx 转播的中国大陆地震源解析成与日本源 / 全球源同一套内部模型（Alert）。
// 内容：`cenc_eew`（中国地震预警，秒级抢发）与 `cenc_eqlist`（中国地震速报，分钟级确认 / 补报）。
// 依赖：01-constants（cnTimeToIso）、02-storage（isPlainObject）、05c-global-parsers（severityOfMagnitude、geoEventKey）。
//
// 为什么与全球源同路径而不是与日本源同路径（DESIGN 8.2 / 8.5）：
//   · 大陆源**没有分区烈度表**——官方渠道是小程序 / OS 内置，第三方中继只给震中坐标 + 震级。
//     所以只能走 `locator:'point'`（坐标 + 半径），与 EMSC / USGS 完全同一条匹配路径，
//     也因此**不需要中国行政区划表**。这是数据源能力的客观差异，不是功能裁剪。
//
// 实测字段（samples/cn/，2026-09-18 真实数据）与踩过的坑：
//   · `cenc_eew` 全部字段只有 10 个（加 WS 包裹的 type 共 11 个），数值都是 **number**。
//   · `cenc_eqlist` 是一整张 50 条的**列表**（No1…No50 + md5），而且**所有字段都是字符串**
//     （"magnitude":"3.7"、"latitude":"41.14"）——同一个上游的两种序列化风格，不能假定其一。
//   · `MaxIntensity`（EEW，实测 5.8/5.9 连续小数）与 `intensity`（速报，实测 3…8 整数）是
//     **中国地震烈度**（GB/T 17742-2020），不是日本震度、也不是震级。它是**震中附近的最大值**，
//     不是用户所在地的烈度 —— **只入库、不上 UI**，否则会被读成后者的承诺。
//   · `cenc_eqlist` 里**混有境外地震**（实测福克斯群岛 M6.5、印尼爪哇岛 M6.5、南桑威奇群岛 M6.2、
//     台湾花莲县…）。所以它会与全球链路（EMSC / USGS）撞车——靠 geoEventKey 同一把钥匙归并。
//   · 两个源的 **EventID 格式互不相干**：EEW 是随机串（仓库样本 `samples/cn/cenc-eew-last.json`
//     实测 `b4kybfnuqayyy`），速报是 `CD.20260918205536.056` 这类带时刻的编号。
//     （0.5.4 修正：此处原写 EEW 是 `202609182050.0001`，与样本不符。）
//     同一场地震（实测四川甘孜州新龙县：EEW 20:50:23 M4.2 / 速报 20:50:24 M3.2）两边 ID 毫无关系，
//     所以**归并只能靠「发震时刻 + 震中」**，绝不能靠 ID。这正是 geoEventKey 的用武之地。
//   · **无取消 / 最终报标志**（既无 isCancel 也无 isFinal）。现有「取消只在此前提醒过时补一条」的
//     链路对大陆源**失效**——这是安全相关的缺口，UI 必须如实说明（DESIGN 8.3 / 10.2），
//     代码里不得假装能处理：cancelled 恒为 false。
// ============================================================================


/**
 * 字符串或数字 → 有限数值；空串 / 垃圾值 / 缺失一律 null。
 * **不能用 Number('')**——它等于 0，会把"没有震级"变成"震级 0"（震级 0 会让阈值闸门放行一个
 * 根本不知道多大的事件，在大陆速报这种每条都要判阈值的链路上就是误报）。
 * 速报整表字段全是字符串，所以这个转换是必需的而不是防御性的。
 */
function numOrNull(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null
  const s = String(v === undefined || v === null ? '' : v).trim();
  if (!s) return null
  const n = Number(s);
  return Number.isFinite(n) ? n : null
}

/** 人名可读的震级文案：未知时给 M—，绝不显示 "Mnull"。 */
function magText(mag) {
  return 'M' + (mag === null ? '—' : mag)
}

/** 震中名 + 深度 的公共 headline 片段。 */
function placeText(name, depthKm) {
  return (name ? ' · ' + name : '') + (depthKm === null ? '' : ' · 深 ' + Math.round(depthKm) + 'km')
}

/**
 * 大陆地震预警（`cenc_eew`）→ Alert。
 *
 * @param {object} raw WS 推送包（含 `type:'cenc_eew'`）或 REST 快照（无 type）——**两种都接受**：
 *   实测 REST 与 WS 的差别就是多一个 type 字段，其余 10 个字段完全一致。
 * @returns {object|null} 结构不对时返回 null（由契约层的 schema 判据负责分类）
 */
function parseCencEew(raw) {
  if (!isPlainObject(raw)) return null
  const id = String(raw.ID === undefined || raw.ID === null ? '' : raw.ID).trim();
  if (!id) return null
  const lat = numOrNull(raw.Latitude);
  const lon = numOrNull(raw.Longitude);
  if (lat === null || lon === null) return null
  const mag = numOrNull(raw.Magnitude);
  const depth = numOrNull(raw.Depth);
  const place = String(raw.HypoCenter === undefined || raw.HypoCenter === null ? '' : raw.HypoCenter).trim();
  // OriginTime 是发震时刻，ReportTime 是发布时刻。实测两者**完全相同**——这是上游的填充习惯，
  // **不能据此判定它"不是实时预警"**（DESIGN 8.3）。事件键用 OriginTime（与其它源同一口径）。
  const originIso = cnTimeToIso(raw.OriginTime);
  const reportIso = cnTimeToIso(raw.ReportTime);
  const reportNum = numOrNull(raw.ReportNum);
  const headline = magText(mag) + placeText(place, depth) +
    (reportNum !== null && reportNum > 1 ? '（第 ' + reportNum + ' 报）' : '');
  return {
    // id 前缀 cenc: ——与速报的 EventID 是两套命名空间，实测不会撞（EEW 是 b4kybfnuqayyy 这类）
    id: 'cenc:' + id,
    code: 'cenc_eew',
    kind: 'eew',
    kindLabel: '大陆地震预警（CENC）',
    source: 'cenc_eew',
    // 无分区烈度 → 坐标 + 半径匹配（DESIGN 8.3）；
    // 震级闸门共用 thresholds.globalMagnitude（DESIGN 8.4：它不是速报，与预警同档）
    locator: 'point',
    speedReport: false,
    // **恒 red，与日本 556 同口径**（DESIGN 2 节：「EEW → red（警报本质）」）。severity 决定两件事：
    // 通知配色，以及**静默时段能否穿透**（只有 red 穿透）。按震级分档会让一场 M4.2 的预警在夜间
    // 被静默掉（severityOfMagnitude 给 info），而同配置下的日本 EEW 照常穿透——那是漏报方向。
    // 速报（分钟级确认，不是警报）仍按震级分档。
    severity: 'red',
    issued: originIso,
    reportTime: reportIso,
    headline,
    maxScale: -1,
    level: 0,
    geo: { lat, lon, depthKm: depth },
    magnitude: mag,
    magType: '',
    hypo: { name: place, magnitude: mag },
    regions: [],
    eventKey: geoEventKey(originIso, lat, lon),
    strength: mag === null ? 0 : mag,
    // 中国地震烈度（震中附近最大值）：只入库、不上 UI。详见文件头。
    intensity: numOrNull(raw.MaxIntensity),
    reportNum,
    cancelled: false, // 大陆源不提供取消 / 最终报标志——见文件头，不得假装能处理
    raw,
  }
}

/**
 * 速报整表里的单项（`NoN`）→ Alert。
 * 所有字段都是字符串（实测）；`location` 与 `placeName` 实测总是一样，取 placeName 优先、location 回退。
 */
function parseCencEqlistItem(item) {
  if (!isPlainObject(item)) return null
  const eventId = String(item.EventID === undefined || item.EventID === null ? '' : item.EventID).trim();
  if (!eventId) return null
  const lat = numOrNull(item.latitude);
  const lon = numOrNull(item.longitude);
  if (lat === null || lon === null) return null
  const mag = numOrNull(item.magnitude);
  const depth = numOrNull(item.depth);
  const place = String(
    (item.placeName === undefined || item.placeName === null ? '' : item.placeName) ||
    (item.location === undefined || item.location === null ? '' : item.location)
  ).trim();
  // time 是发震时刻，ReportTime 是发布时刻。实测 lag 209–1643 秒（DESIGN 8.3 记为 240–1608）。
  const originIso = cnTimeToIso(item.time);
  const reportIso = cnTimeToIso(item.ReportTime);
  const headline = magText(mag) + placeText(place, depth);
  return {
    id: 'cenc:' + eventId,
    code: 'cenc_eqlist',
    kind: 'quake',
    kindLabel: '大陆地震速报（CENC）',
    source: 'cenc_eqlist',
    locator: 'point',
    // 速报不是预警：它管分钟级确认与补报，用**独立**的震级门槛（thresholds.cnReportMagnitude），
    // 否则会被 M2.5–M3.8 的小震频繁打扰（DESIGN 8.4）。
    speedReport: true,
    severity: severityOfMagnitude(mag),
    issued: originIso,
    reportTime: reportIso,
    headline,
    maxScale: -1,
    level: 0,
    geo: { lat, lon, depthKm: depth },
    magnitude: mag,
    magType: '',
    hypo: { name: place, magnitude: mag },
    regions: [],
    eventKey: geoEventKey(originIso, lat, lon),
    strength: mag === null ? 0 : mag,
    intensity: numOrNull(item.intensity), // 中国地震烈度（整数档）：只入库、不上 UI
    // 实测全是 "reviewed"。不认识的取值**不丢弃**——它仍然是同一场真实地震，
    // 丢弃等于漏报；原样带上供诊断，是否收窄由将来的实测决定（那时才知道有哪些取值）。
    reportType: String(item.type === undefined || item.type === null ? '' : item.type).trim(),
    cancelled: false,
    raw: item,
  }
}

/**
 * 速报整表 → 按 `No1…NoN` **数值序**（不是字典序，否则 No10 会排到 No2 前面）的条目数组。
 * 实测 No1 是最新一条。非 `NoN` 键（type / md5）原样跳过。
 * @param {object} json WS / REST 的整表载荷
 * @returns {object[]} 原始条目（未解析），供逐条过契约
 */
function cencEqlistItems(json) {
  if (!isPlainObject(json)) return []
  const keys = Object.keys(json)
    .map((k) => { const m = /^No(\d+)$/.exec(k); return m ? { k, n: Number(m[1]) } : null })
    .filter(Boolean)
    .sort((a, b) => a.n - b.n);
  return keys.map((e) => json[e.k]).filter(isPlainObject)
}

/** 速报整表的变更指纹。实测存在；缺失时返回空串（**不**据此判 schema——见契约层的说明）。 */
function cencEqlistMd5Of(json) {
  if (!isPlainObject(json)) return ''
  const v = json.md5;
  return typeof v === 'string' ? v.trim() : ''
}

/** 速报整表 → Alert[]（逐条解析，坏条目跳过而不是整表作废）。 */
function parseCencEqlist(json) {
  return cencEqlistItems(json).map(parseCencEqlistItem).filter(Boolean)
}

// ============================================================================
// dsh-quake-alert · client/src/05f-nmc-parsers.js
//
// 作用：把 Host 转来的 nmc.cn 预警（JSON）解析成与日本源 / 全球源同一套内部模型（Alert）。
// 内容：`nmc_alarm`——中央气象台汇总的**暴雨**与**地质灾害**预警信号。
// 依赖：02-storage（isPlainObject）、04-city-table（cnAreaOf）。
//
// 与其它源的三处结构性差异（都是实测决定的，不是风格选择）：
//
// ① **匹配走行政区层级，不走半径**（DESIGN 8.5）。
//    预警的粒度到县（「云南省丽江市宁蒗彝族自治县气象台发布地质灾害黄色预警信号」），
//    而设置页只让用户选到地级市。所以 locator 是 `'area'`：把机构名解析成「省 + 市」，
//    再与用户关注的市比对。**不用半径**——"选丽江市 + 100km"会漏掉辖下较远的县，
//    而漏报正是这套系统最不想要的（DESIGN 8.5 明确否决了"县名换坐标 + 半径"）。
//
// ② **机构名自带完整层级链，不需要县表**。
//    0.5.0 曾预留"省 → 市 → 县"三级表（2900 条）用于"从县名向上找地级市"。开工前实测
//    238 条真实预警：**每一条的机构名都以省名开头**，226 条能直接定位到地级市，剩下 12 条
//    是海南省直辖县 / 上海市辖区（本就不属于任何地级市，县表也救不了）。所以县表不建，
//    改由 04-city-table 的 cnAreaOf 在「省 + 市」这一层做最长匹配（DESIGN 8.5 已按实测更正）。
//
// ③ **等级与灾种只认图标编码，不认中文**。
//    Host 已经把 `pic` 的编码解成 `kind` / `level` 两个词（见 lib/nmc-source.js），
//    这一层不做任何中文匹配——`title` 的措辞会随上游改（样本里"预警信号"与"预警"两种都有），
//    而图标文件名是程序契约。
//
// 三条已知缺口（与大陆地震源同类，UI 与文档必须如实说明，代码里不得假装能处理）：
//   · **没有"解除"电文**。列表是"当前生效集合"，预警过期就从列表消失，我们看不到"解除"这个
//     动作，因此 cancelled 恒为 false——"没收到取消"不等于"警报仍然有效"。
//   · **没有取消 / 最终报标志**。
//   · **机构名可能带错字**。实测「黑龙江省齐哈尔市克山县气象台」（少了"齐"）——市名对不上时
//     按省级兜底放行（见 06-matcher），而不是丢弃这条预警。
// ============================================================================


/** 灾种标识 → 中文（与 Host 的 NMC_KINDS 值域对齐）。 */
const NMC_KIND_TEXT = { rainstorm: '暴雨', geology: '地质灾害' };
/** 等级 → 中文（与图标编码 `001`..`004` 的对应关系见 lib/nmc-source.js）。 */
const NMC_LEVEL_TEXT = { red: '红色', orange: '橙色', yellow: '黄色', blue: '蓝色' };
/**
 * 等级 → severity（DESIGN 2 节的配色语义）：红 → red、橙 → orange、黄 → yellow、蓝 → info。
 *
 * **忠实映射，不做"警报恒 red"那种拔高**（0.5.1 对 `cenc_eew` 的修正不适用这里）：
 * 那条修正是因为日本 EEW 本身就是警报、按震级分档纯属把警报降级；而气象预警的四个颜色
 * **本身就是等级**，拔高橙色会让"橙色"这个用户能看见的官方等级失去意义。
 * 后果要如实写进文档：静默时段（默认只放行 red）**不会**放行橙色预警——夜里发布的橙色
 * 暴雨预警只在历史里留痕。这是取舍，不是遗漏。
 */
const NMC_LEVEL_SEVERITY = { red: 'red', orange: 'orange', yellow: 'yellow', blue: 'info' };
/** 等级序（越大越重），与 Host 的 NMC_LEVEL_RANK 一致。 */
const NMC_LEVEL_RANK = { red: 4, orange: 3, yellow: 2, blue: 1 };
/** 播报门槛：橙色及以上（DESIGN 8.4）。低于它的条目仍然解析、仍然进历史，只是不打扰。 */
const NMC_BROADCAST_MIN_RANK = 3;

/**
 * 从 `title` 里取出发布机构名（`…气象台发布…`）。
 * 认不出返回空串——那说明上游换了措辞，届时由契约层的 schema 判据兜住（见 05d）。
 * @param {unknown} title
 */
function orgOf(title) {
  const m = /^(.*?(?:气象台|气象局|预警中心))发布/.exec(String(title === undefined || title === null ? '' : title));
  return m ? m[1] : ''
}

/**
 * nmc.cn 预警（Host 的 JSON 载荷）→ Alert。
 *
 * **结构不符返回 null**（由契约层分类成 schema / empty），而不是在这里抛错或编一个空对象：
 * 后者会让"上游改版"在 UI 上长成"这条预警没有内容"。
 *
 * @param {object} raw `{ alertid, title, issued, kind, level, detail }`
 * @returns {object|null}
 */
function parseNmcAlarm(raw) {
  if (!isPlainObject(raw)) return null
  const alertid = String(raw.alertid === undefined || raw.alertid === null ? '' : raw.alertid).trim();
  if (!alertid) return null
  const kind = typeof raw.kind === 'string' && own(NMC_KIND_TEXT, raw.kind) ? raw.kind : '';
  if (!kind) return null
  const level = typeof raw.level === 'string' && own(NMC_LEVEL_TEXT, raw.level) ? raw.level : '';
  if (!level) return null
  const issued = String(raw.issued === undefined || raw.issued === null ? '' : raw.issued).trim();
  const title = String(raw.title === undefined || raw.title === null ? '' : raw.title).trim();
  const detail = String(raw.detail === undefined || raw.detail === null ? '' : raw.detail).trim();
  const org = orgOf(title);
  const area = org ? cnAreaOf(org) : null;
  // 机构名去掉表示发布主体的后缀即"发布地"：「云南省丽江市宁蒗彝族自治县气象台」→ 该县。
  const place = org.replace(/(?:气象台|气象局|预警中心)$/, '');
  // 查表一律走 own()（0.5.4）：上面两处白名单已经限定了取值，但这里同样是"外部数据当键"，
  // 直查会让 'constructor' 这类键命中原型链返回函数对象（severity 变成函数、headline 里
  // 嵌进函数源码）。契约层（05d）已同步改成 own()，两处是同一个约定。
  const rank = own(NMC_LEVEL_RANK, level) || 0;
  const kindText = own(NMC_KIND_TEXT, kind);
  return {
    // 前缀 nmc: ——与其它源的 id 命名空间分开（alertid 是纯数字串，不加前缀会与
    // P2PQuake 的数字 eventId 撞在同一个集合里，去重表可以按 id 建索引）。
    id: 'nmc:' + alertid,
    code: 'nmc_alarm',
    // kind 复用 'weather'：它是气象灾害，与日本气象电文共用"进历史 / 配色 / 文案"的整条链路。
    // 真正区分两者的是 locator（'area' = 走行政区层级匹配，见 06-matcher）。
    kind: 'weather',
    kindLabel: '大陆' + kindText + '预警（中央气象台）',
    source: 'nmc_alarm',
    locator: 'area',
    severity: own(NMC_LEVEL_SEVERITY, level),
    issued,
    reportTime: issued,
    // 文案用**发布地 + 灾种 + 等级**，不用行政区表里的名字：表里的名字是 GeoNames 的显示名，
    // 实测会挑到旧名（「思茅市」而气象台写「普洱市」），照搬会让用户对不上号。
    headline: (place ? place + ' · ' : '') + kindText + own(NMC_LEVEL_TEXT, level) + '预警',
    maxScale: -1,
    level: 0,
    // regions 是日本源的概念（都道府县 + 市町村）。大陆源不用它——归属放在 cnArea 里，
    // 留空数组是为了让 06-matcher 的"未携带可判定区域"分支不会误伤（那条分支只看 regions）。
    regions: [],
    // 事件键取 alertid：nmc.cn 的 alertid 是**每条预警唯一**的，升级（黄→橙）会换新的 alertid
    // ——那正是应该再响一次的情形。所以这里不做"同机构同灾种归并"：那会把升级吞掉，
    // 而升级恰恰是用户最需要知道的那一次（与 DESIGN 11.7 第 6 条对日本官署的取舍不同：
    // 那边是同一官署管多县导致的**误归并**，这边的键本来就是唯一的）。
    eventKey: 'nmc:' + alertid,
    strength: rank,
    // 行政区归属：city 为空 = 只能定位到省（省直辖县 / 省台发布），由 matcher 走省级兜底。
    cnArea: {
      org,
      province: area ? area.province : '',
      city: area ? area.city : '',
      resolved: !!(area && area.matched),
    },
    cnKind: kind,
    cnLevel: level,
    cnRank: rank,
    detail,
    cancelled: false, // 列表里没有"解除"这种形态——见文件头，不得假装能处理
    raw,
  }
}

// ============================================================================
// dsh-quake-alert · client/src/05h-overseas-parsers.js
//
// 作用：把**海外气象源**（美国 NWS、加拿大 ECCC）的预警解析成与日本源 / 全球源 /
// 大陆源同一套内部模型（Alert）。设计与实测依据见 DESIGN 4.7。
// 内容：`nws_alerts`——NWS 的洪水类预警（8 种 event）；`eccc_alerts`——ECCC 的
//       降雨 / 洪水 / 风暴潮类 warning。
// 依赖：02-storage（isPlainObject / own）。
//
// 与其它源的结构性差异（都是实测决定的）：
//
// ① **`locator: 'overseas'`**（新值）。取数器是**按关注点查询**的（NWS 用 `?point=`、
//    ECCC 用 `?bbox=`），也就是"这条预警属于哪个关注点"在**取数时就已经确定**，
//    由取数器通过 opts.place 传进来（记成 alert.originPlace）。匹配层因此不做距离计算
//    ——这与全球地震源（`locator:'point'`，靠震中坐标算距离）是两种形态。
//
// ② **NWS 的播报门槛按 `event` 名，不按 severity**。实测：`Flood Watch` 的 severity 也是
//    `Severe`（与 `Flood Warning` 同级），而 `Coastal Flood Watch` 是 `Moderate`
//    ——severity 区分不了"警告"与"警戒"。而 NWS 的 event 名本身有层级
//    （Warning = 正在或即将发生 / Watch = 条件有利 / Advisory = 轻微 / Statement = 说明），
//    所以门槛取 `Warning` 结尾（见 NWS_EVENT_WHITELIST 的 rank）。
//
// ③ **ECCC 只接 `alert_type === 'warning'`**。advisory 按 ECCC 自己的定义是
//    「generally not considered hazardous」，霜冻 / 雾 / 高温都在里面——实测当前 116 条
//    里 114 条是 frost advisory，不排除它这个源就是噪声源。
//
// ④ **ECCC 的白名单按 `alert_name_en` 关键词，不按 CAP 的 `<event>`**。
//    实测：CAP **XML 归档**里法语办公室（CWUL 魁北克）的 `<event>` 是法语 `"gel"`，
//    但 OGC API 通道（我们走的就是这条）给的是固定英文 `alert_name_en`（`"frost advisory"`）
//    与双语字段，**没有语言变体问题**；API 里也没有 CAP 的 `eventCode`（只有三字母
//    `alert_code`，其码表无官方枚举），所以白名单只能落在英文名上。
//    ECCC 的降雨类当前季节**没有样本**（DESIGN 4.6.3 的缺口），这份白名单**未被证实**，
//    因此白名单外的新类型判 `empty`（向前兼容）而不是 schema：旧 Client 静默跳过，
//    不会点亮一个用户处理不了的蓝点（与 nmc 的 empty 判据同一手法）。
//
// ⑤ **事件键（eventKey）按"事件链"取，不是按消息取**。两个源的 id 语义不同：
//    · NWS 的 CAP identifier 实测形如 `urn:oid:2.49.0.1.840.0.<40hex>.<serial>.<version>`，
//      而 Update / Cancel 会**换一条新的 identifier**（2026-09-22 实测过去 7 天 500 条：
//      11 个多消息事件组里 **0 组**是"同一 serial 只递增 version"，Cancel 的 identifier
//      与它引用的原消息连 40 位 hash 都不同）。
//      → 所以事件键**必须用 CAP 的 `references`**（指向被取代的原消息），见 nwsEventKeyOf。
//    · ECCC 的 API **没有稳定的 alert id**（只有 `alert_code` + `feature_id`），
//      → 事件键 = 码 + 区域 + **发布日**：同一天内的更新同键（不重复响），跨天的新过程换键。
//    消息级 id 仍保留完整信息（含版本 / 发布时刻），供"同一条消息重复到达"去重。
//
// 两条共同的已知缺口（UI 与文档必须如实说明）：
//   · **没有可靠的"解除"表达**。NWS 有 `messageType: 'Cancel'`（可用）；ECCC 的
//     `status_en` 实测有 `ended` 与 `continued`，但一条刚发布的霜冻也是 `ended`
//     ——含义未证实，所以 ECCC 的 cancelled **恒为 false**（宁可多说一次，不假装能处理）。
//   · **上游停更看不见**：两个源都是"按点 / 框查询"，空响应是常态，契约里 `staleAfterMs`
//     只能是 null（DESIGN 4.7.7 第 2 条）。
// ============================================================================


/** NWS 的 `event` → 内部灾种与播报档位。白名单是**精确匹配**（见文件头 ②）。 */
const NWS_EVENT_WHITELIST = {
  'Flood Warning': { kind: 'flood', text: '洪水', rank: 3 },
  'Flash Flood Warning': { kind: 'flashFlood', text: '山洪', rank: 3 },
  'Coastal Flood Warning': { kind: 'coastalFlood', text: '沿海洪水', rank: 3 },
  'Flood Watch': { kind: 'flood', text: '洪水警戒', rank: 1 },
  'Flood Advisory': { kind: 'flood', text: '洪水注意', rank: 1 },
  'Coastal Flood Watch': { kind: 'coastalFlood', text: '沿海洪水警戒', rank: 1 },
  'Coastal Flood Advisory': { kind: 'coastalFlood', text: '沿海洪水注意', rank: 1 },
  'Coastal Flood Statement': { kind: 'coastalFlood', text: '沿海洪水说明', rank: 1 },
};
/** NWS 的 severity → 配色（忠实映射，不拔高；与 nmc 的"四色即等级"同一口径）。 */
const NWS_SEVERITY = { Extreme: 'red', Severe: 'orange', Moderate: 'yellow', Minor: 'info' };
/** NWS 的 severity → 强度序（用于"同一事件的后续发布是否升级"）。 */
const NWS_SEV_RANK = { Extreme: 4, Severe: 3, Moderate: 2, Minor: 1 };

/** ECCC 的 `risk_colour_en` → 配色。ECCC 的三色与 nmc 的四色同源，可直接对应。 */
const ECCC_COLOUR_SEVERITY = { red: 'red', orange: 'orange', yellow: 'yellow' };
/** ECCC 的三色 → 强度序。**没有 info 档**：只有 warning 进来，而黄色 warning 按 ECCC 的
 *  定义已经是"hazardous weather may cause damage, disruption, or health impacts"。 */
const ECCC_COLOUR_RANK = { red: 4, orange: 3, yellow: 2 };

/** ECCC 的灾种白名单：**先看排除名单，再看包含名单**（见文件头 ④）。 */
const ECCC_EXCLUDE = /frost|fog|freez|snow|blizzard|ice\b|icing|wind|gale|heat|cold|thunderstorm|tornado|hurricane|tropical|air quality|humidex|visibility/i;
const ECCC_INCLUDE = /rain|flood|surge|hydrolog|water|precipitation/i;

/**
 * ECCC 的英文名 → 中文灾种标签。
 * **按名称关键词映射，不查未知的三字母码表**——`alert_code` 的取值没有官方枚举，
 * 猜码正是 4.6.3 踩过的坑（把 `CFW` 当成洪水，实际是 storm surge warning）。
 */
function ecccKindTextOf(nameEn) {
  const s = String(nameEn || '');
  if (/storm surge|surge/i.test(s)) return '风暴潮预警'
  if (/flash flood/i.test(s)) return '山洪预警'
  if (/flood/i.test(s)) return '洪水预警'
  if (/rain|precipitation/i.test(s)) return '降雨预警'
  if (/hydrolog|water/i.test(s)) return '水文预警'
  return '气象预警'
}

/** 播报门槛（两个源共用）：`overseasRank >= 3` 才打扰用户，否则只进历史。 */
const OVERSEAS_BROADCAST_MIN_RANK = 3;

/** NWS 的 `event` → 中文（供 UI / 测试使用）。 */
const NWS_KIND_TEXT = Object.fromEntries(
  Object.entries(NWS_EVENT_WHITELIST).map(([ev, v]) => [ev, v.text]),
);

/**
 * NWS 的事件键。**必须优先用 CAP 的 `references`**（0.6.0 review 修正）。
 *
 * 实测（2026-09-22，过去 7 天的 500 条 Flood / Flash Flood / Coastal Flood 电文）：
 * **11 个多消息事件组里 0 组是"同一 serial 只递增 version"**，而 Cancel 消息的 identifier
 * 与它 `references` 的那条原消息**连 40 位 hash 都不同**（例：Cancel `a27ba9d7…` 引用
 * `d17b28bf…`）。所以"去掉末尾版本段"这条规则**关联不上原警报**：
 * 播报时记下的键是原 Alert 的，Cancel 到达时算出的是另一个键 → `wasRecentlyAlerted` 恒为假
 * → 用户永远收不到"此前播报的警报已作废"（与 nmc 的缺口一模一样，而当时的设计正好相反地
 * 宣称"NWS 有真正的取消语义"）。
 *
 * 正确做法就是 CAP 语义本身：Update / Cancel 的 `<references>` 指向**被它取代的消息**。
 * 取其中 `sent` 最早的一条作为事件链的根（并列时按 identifier 字典序，保证确定性），
 * 再去掉末尾的 `.<version>` —— 最后这一步是兜底：万一某条 references 只指向上一版
 * （而不是原始那条），去版本段之后仍与更早的版本同键。
 * 没有 references 的（就是原始 Alert）用自身 identifier。
 */
function nwsEventKeyOf(id, references) {
  const refs = Array.isArray(references) ? references : [];
  let best = null;
  for (const r of refs) {
    if (!r || typeof r.identifier !== 'string' || !r.identifier) continue
    const t = Number.isFinite(Date.parse(r.sent)) ? Date.parse(r.sent) : Number.POSITIVE_INFINITY;
    if (!best || t < best.t || (t === best.t && String(r.identifier) < String(best.id))) {
      best = { t, id: r.identifier };
    }
  }
  const base = best ? best.id : id;
  return 'nws:' + String(base).replace(/\.[0-9]+$/, '')
}

/** ECCC 的事件键：码 + 区域 + 发布日（同一天内的更新同键）。 */
function ecccEventKeyOf(code, areaKey, published) {
  const day = String(published).slice(0, 10);
  return 'eccc:' + code + ':' + areaKey + ':' + day
}

/**
 * NWS 的预警体（一条 GeoJSON feature）→ Alert。
 *
 * @param {object} feature `{ id, type, geometry, properties }`
 * @param {{ place?: object }} [opts] `place` 是取数器查这条时用的关注点（记成 originPlace）
 * @returns {object|null} 结构不符或不在白名单时返回 null（由契约层分类成 schema / empty）
 */
function parseNwsAlert(feature, opts) {
  if (!isPlainObject(feature)) return null
  const p = feature.properties;
  if (!isPlainObject(p)) return null
  const event = typeof p.event === 'string' ? p.event : '';
  const rule = own(NWS_EVENT_WHITELIST, event);
  if (!rule) return null
  // id 优先取 properties.id（CAP identifier）；缺了才退回外层 id。两者都缺就没法做去重，
  // 判 null 由契约层归成 schema（见契约的 required）。
  const rawId = String(p.id || feature.id || '').trim();
  if (!rawId) return null
  // GeoJSON 外层的 `feature.id` 是**完整 URL**（`https://api.weather.gov/alerts/urn:oid:…`）。
  // 抽出 `urn:oid:` 段再用（0.6.0 review 修正）：否则事件键里带着 URL 前缀，末尾版本段的
  // 归并（以及取消消息的 references 匹配）都会失效——同一场洪水会随每次更新重复响铃。
  const idMatch = /(urn:oid:[\s\S]+)$/.exec(rawId);
  const id = idMatch ? idMatch[1] : rawId;
  const sent = typeof p.sent === 'string' ? p.sent : '';
  if (!sent || !Number.isFinite(Date.parse(sent))) return null
  const sev = typeof p.severity === 'string' && own(NWS_SEVERITY, p.severity) ? p.severity : '';
  const areaDesc = String(p.areaDesc || '').trim();
  const headline = String(p.headline || '').trim();
  // 正文原样保留：NWS 没有"不得改写"的条款，但改写官方正文对任何源都不合适，
  // 而 instruction 是"该怎么做"——截断它才是真的危险。
  const description = String(p.description || '').trim();
  const instruction = String(p.instruction || '').trim();
  const detail = [description, instruction].filter(Boolean).join('\n\n');
  const place = opts && isPlainObject(opts.place) ? opts.place : null;
  return {
    id: 'nws:' + id,
    code: 'nws_alerts',
    // kind 复用 'weather'：与日本气象电文 / 大陆气象预警共用"进历史 / 配色 / 文案"整条链路。
    // 真正区分三者的是 locator（overseas / area / regions）。
    kind: 'weather',
    kindLabel: '美国' + rule.text + '（' + (String(p.senderName || '').trim() || 'NWS') + '）',
    source: 'nws_alerts',
    locator: 'overseas',
    severity: sev ? own(NWS_SEVERITY, sev) : 'info',
    issued: sent,
    reportTime: sent,
    headline: headline || (rule.text + (areaDesc ? ' · ' + areaDesc : '')),
    maxScale: -1,
    level: 0,
    regions: [],
    eventKey: nwsEventKeyOf(id, p.references),
    strength: (sev && own(NWS_SEV_RANK, sev)) || 0,
    // 海外源特有：这条预警属于哪个关注点（取数时确定），以及供 UI / 诊断用的原始标签。
    originPlace: place,
    overseas: {
      country: 'us',
      event,
      // NWS 的 eventCode 是对象（`{SAME:['FLW'], NationalWeatherService:['FLW']}`），
      // **不能当白名单键**（实测 Flood Warning 的 SAME 给的是 FLS）。这里只留一份供诊断。
      eventCode: isPlainObject(p.eventCode) ? p.eventCode : null,
      areaDesc,
      messageType: String(p.messageType || ''),
      senderName: String(p.senderName || ''),
      ends: String(p.ends || p.expires || ''),
      ugc: isPlainObject(p.geocode) && Array.isArray(p.geocode.UGC) ? p.geocode.UGC : [],
    },
    // 播报档位：Warning 类 = 3，Watch / Advisory / Statement = 1（见文件头 ②）。
    overseasRank: rule.rank,
    nwsEvent: event,
    detail,
    // NWS 有真正的取消语义（CAP 的 messageType），这条比 nmc 强。
    cancelled: String(p.messageType || '') === 'Cancel',
    raw: feature,
  }
}

/**
 * ECCC 的预警体（一条 GeoJSON feature）→ Alert。
 *
 * @param {object} feature `{ type, geometry, properties }`
 * @param {{ place?: object }} [opts]
 * @returns {object|null} 结构不符 / 不是 warning / 不在白名单时返回 null
 */
function parseEcccAlert(feature, opts) {
  if (!isPlainObject(feature)) return null
  const p = feature.properties;
  if (!isPlainObject(p)) return null
  const alertType = typeof p.alert_type === 'string' ? p.alert_type : '';
  if (alertType !== 'warning') return null
  const code = typeof p.alert_code === 'string' ? p.alert_code.trim() : '';
  const nameEn = typeof p.alert_name_en === 'string' ? p.alert_name_en.trim() : '';
  // 白名单：先排除、再包含。ECCC_EXCLUDE 里有 wind、ECCC_INCLUDE 里有 surge——
  // "storm surge warning" 两边都不冲突，但把顺序写死能避免将来加词时互相打架。
  if (!nameEn || ECCC_EXCLUDE.test(nameEn) || !ECCC_INCLUDE.test(nameEn)) return null
  if (!code) return null
  const published = typeof p.publication_datetime === 'string' ? p.publication_datetime : '';
  if (!published || !Number.isFinite(Date.parse(published))) return null
  const colour = typeof p.risk_colour_en === 'string' ? p.risk_colour_en.toLowerCase() : '';
  if (!own(ECCC_COLOUR_SEVERITY, colour)) return null
  const area = String(p.feature_name_en || '').trim();
  const text = String(p.alert_text_en || '').trim();
  const province = String(p.province || '').trim();
  const place = opts && isPlainObject(opts.place) ? opts.place : null;
  const textZh = ecccKindTextOf(nameEn);
  // 区域键：feature_id 优先（稳定），缺了退回区域名（见文件头 ⑤ 的事件键说明）。
  const areaKey = String(p.feature_id || area || province || 'unknown');
  // 署名是 ECCC 许可（End-use Licence v2.1.1）的硬要求，且正文**不得改写**
  // ——所以正文原样保留，署名作为末行一起进历史与通知。
  const ATTRIBUTION = 'Data Source: Environment and Climate Change Canada';
  return {
    id: 'eccc:' + code + ':' + areaKey + ':' + published,
    code: 'eccc_alerts',
    kind: 'weather',
    kindLabel: '加拿大' + textZh + '（ECCC）',
    source: 'eccc_alerts',
    locator: 'overseas',
    severity: own(ECCC_COLOUR_SEVERITY, colour),
    issued: published,
    reportTime: published,
    headline: textZh + (area ? ' · ' + area : '') + (province ? '（' + province + '）' : ''),
    maxScale: -1,
    level: 0,
    regions: [],
    eventKey: ecccEventKeyOf(code, areaKey, published),
    strength: own(ECCC_COLOUR_RANK, colour) || 0,
    originPlace: place,
    overseas: {
      country: 'ca',
      alertCode: code,
      nameEn,
      colour,
      province,
      area,
      statusEn: String(p.status_en || ''),
      confidence: String(p.confidence_en || ''),
      impact: String(p.impact_en || ''),
      expiry: String(p.expiration_datetime || ''),
      validity: String(p.validity_datetime || ''),
      attribution: ATTRIBUTION,
    },
    overseasRank: 3,
    ecccCode: code,
    detail: text ? text + '\n\n' + ATTRIBUTION : ATTRIBUTION,
    // ECCC 的 `status_en` 实测有 ended / continued，但一条刚发布的霜冻也是 `ended`
    // ——含义未证实，所以**不据此判取消**（DESIGN 4.7.7 第 6 条）。宁可多说一次。
    cancelled: false,
    raw: feature,
  }
}

// ============================================================================
// dsh-quake-alert · client/src/05d-source-contracts.js
//
// 作用：**解析契约**与**每源校验约定**（0.4.1 的交付物之一，对应 DESIGN 4.5 与 11.1）。
// 内容：① 统一的解析返回形态 { ok, alert } | { ok:false, kind:'empty'|'schema'|'value', detail }
//       ② 五个源各自填写的内容：必需字段清单与类型（schema 判据）、源时区、
//          新鲜度阈值（stale 判据）、empty 判据
//       ③ 健康状态记录**已迁出**（0.5.3）：存 / 升级阈值 / 自愈在 05g-source-health.js，
//          探针调度在 12d-health-probe.js。本文件从此只做"约定"这一层。
// 依赖：01-constants、02-storage、05/05b/05c（各源的解析器）、07-store（状态上报）。
//
// 三层划分（DESIGN 11.1）：本文件是**约定层**——解析失败的返回形态与"UI 如何表示数据格式异常"，
// 随源走，所以 0.4.1 一次补齐已有 5 源、0.5.0 / 0.5.2 随新源同步制作。
// **机制层**（健康数据结构、升级阈值、探针调度、CI 契约测试）已在 0.5.3 落地到
// `05g-source-health.js`（存与升级 / 自愈）与 `12d-health-probe.js`（探针）；本文件末尾只
// re-export 那几个入口，让调用方不必改 import 来源。
//
// 三类失败的语义与处置（DESIGN 4.5）：
//   empty  —— 源正常，当前没有与本插件相关的数据。**不计失败**、不显示异常。
//   schema —— 结构不符（字段缺失 / 类型错误 / 顶层不是预期结构）。计入健康状态、停止播报该源。
//   value  —— 结构正确但值客观不可能（坐标越界、时间在 100 年后等）。同上，但只查硬边界。
// 核心原则：解析层严格，匹配层宽松。结构不符时任何"智能猜测"都可能把垃圾数据变成误报。
// ============================================================================


// ---------------------------------------------------------------- 返回形态
/** 解析成功。 */
const okResult = (alert) => ({ ok: true, alert });
/** 解析失败 / 无关。kind ∈ 'empty' | 'schema' | 'value'。 */
const failResult = (kind, detail) => ({ ok: false, kind, detail: String(detail || '') });

const numOf = (v) => {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null
  const s = String(v === undefined || v === null ? '' : v).trim();
  if (!s) return null
  const n = Number(s);
  return Number.isFinite(n) ? n : null
};
const timeMsOf = (v) => {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null
  const t = Date.parse(String(v === undefined || v === null ? '' : v));
  return Number.isFinite(t) ? t : null
};
/** 时间戳是否客观不可能：1970 年以前、或 100 年以后（DESIGN 4.5 的 value 判据）。
 *  **缺失 / 不可解析不算"不可能"**——存在性由各源的 schema 判据负责。传 null 时若返回 true，
 *  会让"没给时间"的地震情报整条被丢掉（parseQuake 本来容忍缺 time，只让 eventKey 留空）。 */
const timeIsImpossible = (ms, now) => {
  if (typeof ms !== 'number' || !Number.isFinite(ms)) return false
  return ms < 0 || ms > (Date.now()) + 100 * 365 * 24 * 3600 * 1000
};

// ---------------------------------------------------------------- 每源约定
/**
 * 五个源的校验约定（0.4.1 补齐）。字段含义：
 *   required    —— 必需字段与类型（schema 判据）。缺一个即判 schema，**不猜、不兜底**。
 *   timezone    —— 源时区。契约要求解析器把时间转成**带偏移**的 ISO 8601（DESIGN 第 4 节）。
 *   staleAfterMs—— 新鲜度阈值（stale 判据）；null = 这条链路不适用，理由写在 staleReason。
 *   empty       —— 什么形态算"源正常但当前无数据"（不计失败）。
 *   tolerant    —— 可选：**明确不判 schema** 的字段范围。它与 required 是一对——required 只该列
 *                  实现里真的会拦下的字段，否则契约就变成"比实现严"的文档，后来者按它写测试会
 *                  误判"某字段必需"（0.5.1 修正）。
 *   pollMs      —— 传输层的轮询 / 推送周期（诊断文档引用）。
 */
const SOURCE_CONTRACTS = {
  p2pquake: {
    label: 'P2PQuake',
    region: 'jp',
    disasters: ['quake', 'eew', 'tsunami'],
    transport: 'ws',
    url: 'wss://api.p2pquake.net/v2/ws',
    pollMs: null,
    timezone: 'Asia/Tokyo（+09:00）—— issue.time / earthquake.time / areas[].arrivalTime 都是裸 JST，由 p2pTimeToIso 补偏移',
    required: [
      'code：必须是 551 / 552 / 556 之一',
      '551：id（或 _id）string、issue.time string、earthquake.time string、earthquake.maxScale number、points[]（每项 pref string / addr string / scale number）',
      '552：id string、areas[]（每项 name string、grade ∈ {MajorWarning, Warning, Watch}）',
      '556：id string、issue.eventId string、earthquake.hypocenter object、areas[]（每项 name string、scaleTo number）',
    ],
    empty: 'code 不是 551/552/556（P2PQuake 还会推火山、其他情报等与本插件无关的消息）',
    staleAfterMs: null,
    staleReason: '推送源没有"数据新鲜度"概念：日本可能数小时没有有感地震。活性由连接层负责' +
      '（建连看门狗 15 秒 + 半开检测 20 分钟，见 12-websocket）。',
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
      '<Report> 根元素',
      'Control/Title 或 Head/Title（至少一个非空）',
      'Head/ReportDateTime 或 Control/DateTime（发布时间）',
      '至少一个 <Item>，其 <Kind> 能给出 Name 或 Status',
      '区域：<Area> 下的 <Name> 或 <Code>（codeType 或码位数决定粒度）',
    ],
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
      'data.properties object：mag number、time string、flynn_region string',
      'data.properties.lat/lon number，或 data.geometry.coordinates[0..1]',
    ],
    empty: 'action === "delete"（事件被撤回），或 properties.evtype 不是 "ke"（非地震事件，如爆炸）',
    staleAfterMs: null,
    staleReason: '全球 M4+ 平均约 30 分钟一条，稀疏是常态，不能用消息间隔判死。活性由连接层负责' +
      '（建连看门狗 15 秒 + 3 小时无消息的半开检测，见 15-entry 的 staleAfterMs）。',
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
      '顶层 GeoJSON：features[] 数组',
      '每个 feature：id string、geometry.coordinates = [经度, 纬度, 深度km]',
      'properties object：mag number、time number、updated number',
      '顶层 metadata.generated number（feed 生成时刻，用于 stale 判定）',
    ],
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
      '区域：<area><circle> 或 info/parameter 里的 EventLatLon',
    ],
    empty: 'msgType === "Test"（演练电文）；或事件列表为空（大多数时候没有海啸）',
    staleAfterMs: null,
    staleReason: '事件列表只在有海啸时才有内容，"列表为空"是绝大多数时间的正常形态，不能据此判 stale。',
  },
  // ---- 中国大陆源（0.5.0）----
  // 与其它源的两处结构性差异，写在契约里而不是埋在解析器里：
  //   ① 传输是 **Host 单点常连**（Wolfx 限 5–7 连接/IP），不是 Client 直连——见 DESIGN 5.3。
  //   ② cenc_eqlist 的字段**全是字符串**，而 cenc_eew 的字段是 number；两个源来自同一上游，
  //      所以不能按"同一家的风格"写解析，只能按实测样本写。
  cenc_eew: {
    label: 'Wolfx CENC 地震预警',
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
    label: 'Wolfx CENC 地震速报',
    region: 'cn',
    disasters: ['quake'],
    transport: 'ws',
    url: 'wss://ws-api.wolfx.jp/cenc_eqlist（REST 快照 https://api.wolfx.jp/cenc_eqlist.json）',
    pollMs: null,
    timezone: 'Asia/Shanghai（+08:00，无夏令时）—— time / ReportTime 是裸北京时间，由 cnTimeToIso 补偏移',
    required: [
      '整表载荷：No1…NoN（数值序，No1 最新）+ md5',
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
  // ---- 中国大陆气象源（0.5.2）----
  // 一条 Host 源（`nmc_alarm`）承载**两个灾种**（暴雨 / 地质灾害）。契约按"一个端点 + 一种载荷"
  // 划分，而这两个灾种来自同一个 `rest/findAlarm` 响应、只有 `pic` 编码不同，所以是一条契约。
  // 与其它源的差异：匹配走**行政区层级**（locator:'area'），因此"title 能解析出机构名"是
  // **必需字段**——解析不出就等于这条预警无法归属，而不是"少了一个可选字段"。
  nmc_alarm: {
    label: '中央气象台预警信号（nmc.cn）',
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
      'kind ∈ {rainstorm, geology}（Host 从 pic 的灾种码译出）',
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
  // 海外气象源（0.6.0，DESIGN 4.7）。两条都是 **Client 直连的 REST 轮询**（CORS 实测允许），
  // 而且都是**按关注点查询**（NWS 按点、ECCC 按 bbox）——这一点决定了它们与其它源的三处不同：
  //   · locator 是 'overseas'（命中在取数时就已发生，匹配层不算距离）；
  //   · staleAfterMs 只能是 null（空响应是常态，判不出上游停更）；
  //   · 时间语义相反（NWS 自带偏移、ECCC 是 UTC `Z`，都不需要补本地时区）。
  nws_alerts: {
    label: '美国国家气象局预警（api.weather.gov）',
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
      'properties.id string 非空（CAP identifier，去重与事件键的基础）',
      'properties.sent 可解析的 ISO 时间（带偏移）',
    ],
    tolerant: 'severity 缺失或不在 {Extreme,Severe,Moderate,Minor} 内 → 退回 info，**不判 schema**：' +
      '宁可让一条真实洪水预警少一个颜色，也不要因为上游少给一个枚举值就整源停播（漏报方向）。' +
      'headline / areaDesc / description / instruction / geocode / ends / senderName 缺失一律不判 schema。' +
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
    label: '加拿大环境与气候变化部预警（api.weather.gc.ca）',
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
      '缺失一律不判 schema——**事件键会在 feature_id 缺失时退回区域名**（见 05h 的 ecccEventKeyOf）。',
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
};

// ---------------------------------------------------------------- Result 包装
// 每个包装函数先把"结构不符 / 值不可能"挡在解析器之前，再调用**真实解析器**（单一实现，
// 不复制业务逻辑）。这样既得到契约要求的失败分类，又保证线上链路与测试走同一段代码。

/** P2PQuake（551/552/556）。 */
function parseEpspResult(raw) {
  if (!isPlainObject(raw)) return failResult('schema', '顶层不是对象')
  const code = raw.code;
  if (code !== 551 && code !== 552 && code !== 556) {
    return failResult('empty', 'code=' + String(code) + ' 不属于本插件的灾种')
  }
  const id = raw.id || raw._id;
  if (typeof id !== 'string' || !id) return failResult('schema', '缺少 id/_id')
  const issueTime = raw.issue && raw.issue.time;
  if (typeof issueTime !== 'string' || !issueTime) return failResult('schema', '缺少 issue.time')
  if (code === 551) {
    const eq = raw.earthquake;
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
    const eq = raw.earthquake;
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
  const alert = parse(raw);
  if (!alert) return failResult('schema', '解析器未能归一（结构通过校验但映射失败）')
  return okResult(alert)
}

/** 気象庁 防災情報XML。 */
function parseJmaResult(xml, entry) {
  const text = String(xml === undefined || xml === null ? '' : xml);
  if (!text) return failResult('schema', '电文为空')
  if (text.indexOf('<Report') === -1) {
    // extra.xml 的详情地址偶尔会返回错误页 / 拦截页（HTTP 200 的 HTML），那种情况是 schema
    if (/^\s*<(!doctype|html)/i.test(text) || text.indexOf('<html') !== -1) {
      return failResult('schema', '返回的是 HTML 而不是 XML 电文（可能被拦截或地址失效）')
    }
    return failResult('schema', '不是防災情報XML（缺少 <Report> 根元素）')
  }
  const alert = parseJma(text, entry);
  if (!alert) return failResult('empty', '与本插件无关的电文（无警戒レベル、且不是解除）')
  return okResult(alert)
}

/** EMSC standing_order。 */
function parseEmscResult(raw) {
  if (!isPlainObject(raw)) return failResult('schema', '顶层不是对象')
  if (raw.action === 'delete') return failResult('empty', '事件撤回通知（action=delete）')
  const d = raw.data;
  if (!isPlainObject(d)) return failResult('schema', '缺少 data 对象')
  const p = d.properties;
  if (!isPlainObject(p)) return failResult('schema', '缺少 data.properties')
  const coords = (d.geometry && Array.isArray(d.geometry.coordinates)) ? d.geometry.coordinates : [];
  const lat = numOf(p.lat !== undefined ? p.lat : coords[1]);
  const lon = numOf(p.lon !== undefined ? p.lon : coords[0]);
  if (lat === null || lon === null) return failResult('schema', '缺少震中坐标（properties.lat/lon 与 geometry.coordinates 都没有）')
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return failResult('value', '震中坐标越界：' + lat + ',' + lon)
  if (numOf(p.mag) === null) return failResult('schema', '缺少 properties.mag（number）')
  const t = timeMsOf(p.time);
  if (t === null) return failResult('schema', '缺少 properties.time（可解析的时间）')
  if (timeIsImpossible(t)) return failResult('value', '发震时刻客观不可能：' + String(p.time))
  if (p.evtype !== undefined && String(p.evtype) !== 'ke') {
    return failResult('empty', '非地震事件（evtype=' + String(p.evtype) + '）')
  }
  const alert = parseEmsc(raw);
  if (!alert) return failResult('schema', '解析器未能归一（结构通过校验但映射失败）')
  return okResult(alert)
}

/** USGS summary feed 的单个 Feature。 */
function parseUsgsResult(feature) {
  if (!isPlainObject(feature)) return failResult('schema', '不是 GeoJSON Feature 对象')
  const p = feature.properties;
  if (!isPlainObject(p)) return failResult('schema', '缺少 feature.properties')
  const coords = (isPlainObject(feature.geometry) && Array.isArray(feature.geometry.coordinates))
    ? feature.geometry.coordinates : [];
  const lon = numOf(coords[0] !== undefined ? coords[0] : p.lon);
  const lat = numOf(coords[1] !== undefined ? coords[1] : p.lat);
  if (lat === null || lon === null) return failResult('schema', '缺少 geometry.coordinates / properties.lat,lon')
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return failResult('value', '震中坐标越界：' + lat + ',' + lon)
  if (numOf(p.mag) === null) return failResult('schema', '缺少 properties.mag（number）')
  const t = timeMsOf(p.time);
  if (t === null) return failResult('schema', '缺少 properties.time（epoch 毫秒或可解析的时间）')
  if (timeIsImpossible(t)) return failResult('value', '发震时刻客观不可能：' + String(p.time))
  const alert = parseUsgsFeature(feature);
  if (!alert) return failResult('schema', '解析器未能归一（结构通过校验但映射失败）')
  return okResult(alert)
}

/** NOAA tsunami.gov 的 CAP 1.2 电文。 */
function parseNoaaResult(xml, entry) {
  const text = String(xml === undefined || xml === null ? '' : xml);
  if (!text) return failResult('schema', 'CAP 电文为空')
  if (text.indexOf('<alert') === -1) {
    if (text.indexOf('<html') !== -1 || /^\s*<(!doctype|html)/i.test(text)) {
      return failResult('schema', '返回的是 HTML 而不是 CAP 电文（可能被拦截或地址失效）')
    }
    return failResult('schema', '不是 CAP 电文（缺少 <alert> 根元素）')
  }
  const msgType = (/<msgType>([^<]*)<\/msgType>/.exec(text) || [])[1] || '';
  if (String(msgType).trim() === 'Test') return failResult('empty', '演练电文（msgType=Test）')
  const alert = parseNoaaCap(text, entry);
  if (!alert) return failResult('schema', '缺少 <identifier> 或解析器未能归一')
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
function parseCencEewResult(raw) {
  if (!isPlainObject(raw)) return failResult('schema', '顶层不是对象')
  if (raw.type !== undefined && String(raw.type) !== 'cenc_eew') {
    return failResult('schema', 'type 不是 cenc_eew（收到 ' + String(raw.type) + '）')
  }
  // empty 判据：10 个字段一个都没有。理由与证据等级见 SOURCE_CONTRACTS.cenc_eew.empty。
  const fields = ['ID', 'EventID', 'OriginTime', 'ReportTime', 'Latitude', 'Longitude', 'Magnitude', 'Depth', 'MaxIntensity', 'HypoCenter'];
  const hasAny = fields.some((k) => {
    const v = raw[k];
    return v !== undefined && v !== null && String(v) !== ''
  });
  if (!hasAny) return failResult('empty', '载荷里没有任何预警字段（源正常但当前没有预警）')
  const id = raw.ID;
  if (typeof id !== 'string' || !id.trim()) return failResult('schema', '缺少 ID（string）')
  const lat = numOf(raw.Latitude);
  const lon = numOf(raw.Longitude);
  if (lat === null || lon === null) return failResult('schema', '缺少 Latitude / Longitude（数值）')
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return failResult('value', '震中坐标越界：' + lat + ',' + lon)
  if (numOf(raw.Magnitude) === null) return failResult('schema', '缺少 Magnitude（数值）')
  const t = timeMsOf(cnTimeToIso(raw.OriginTime));
  if (t === null) return failResult('schema', '缺少 OriginTime（可解析的北京时间）')
  if (timeIsImpossible(t)) return failResult('value', '发震时刻客观不可能：' + String(raw.OriginTime))
  const alert = parseCencEew(raw);
  if (!alert) return failResult('schema', '解析器未能归一（结构通过校验但映射失败）')
  return okResult(alert)
}

/**
 * 速报整表里的单项（`NoN`）。逐条过契约，便于定位"哪一项坏了"。
 * 注意：单项失败**不等于整表坏**——批量语义见 parseCencEqlistResult。
 */
function parseCencEqlistItemResult(item) {
  if (!isPlainObject(item)) return failResult('schema', '速报项不是对象')
  const eventId = item.EventID;
  if (typeof eventId !== 'string' || !eventId.trim()) return failResult('schema', '缺少 EventID（string）')
  const lat = numOf(item.latitude);
  const lon = numOf(item.longitude);
  if (lat === null || lon === null) return failResult('schema', '缺少 latitude / longitude（数字字符串或数值）')
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return failResult('value', '震中坐标越界：' + lat + ',' + lon)
  if (numOf(item.magnitude) === null) return failResult('schema', '缺少 magnitude（数字字符串或数值）')
  const t = timeMsOf(cnTimeToIso(item.time));
  if (t === null) return failResult('schema', '缺少 time（可解析的北京时间）')
  if (timeIsImpossible(t)) return failResult('value', '发震时刻客观不可能：' + String(item.time))
  const alert = parseCencEqlistItem(item);
  if (!alert) return failResult('schema', '解析器未能归一（结构通过校验但映射失败）')
  return okResult(alert)
}

/**
 * 速报整表 → 批量结果 `{ ok, alerts, dropped, md5 }`。
 *
 * **为什么批量与单项分开判**：整表 50 条，一条缺坐标就让整表作废等于漏掉另外 49 条真实地震
 * ——0.4.2 已经就 551 的观测点定过同一口径（"存在则类型必须正确"，缺失容忍）。
 * 所以：坏条目**逐条丢弃并计数**（`dropped`，不是静默），只有**一条都没解析出来**才判整表 schema。
 * 整表一条都没有则判 empty——源正常但当前没有速报数据。
 */
function parseCencEqlistResult(json) {
  if (!isPlainObject(json)) return failResult('schema', '顶层不是对象')
  if (json.type !== undefined && String(json.type) !== 'cenc_eqlist') {
    return failResult('schema', 'type 不是 cenc_eqlist（收到 ' + String(json.type) + '）')
  }
  const items = cencEqlistItems(json);
  if (items.length === 0) return failResult('empty', '整表里没有 NoN 条目（源正常但当前没有速报数据）')
  const alerts = [];
  let dropped = 0;
  let firstDetail = '';
  for (const it of items) {
    const res = parseCencEqlistItemResult(it);
    if (res.ok) { alerts.push(res.alert); continue }
    if (res.kind === 'empty') continue
    dropped++;
    if (!firstDetail) firstDetail = res.kind + '：' + res.detail;
  }
  if (alerts.length === 0) {
    return failResult('schema', '整表 ' + items.length + ' 条全部无法解析（' + firstDetail + '）')
  }
  return { ok: true, alerts, dropped, md5: cencEqlistMd5Of(json), total: items.length }
}

/**
 * 中央气象台预警（`nmc_alarm`）。
 *
 * 与其它源的两处判据差异（都由"匹配依赖机构名"这一条推出）：
 *   · `title` 里**必须**能解析出机构名——解析不出就等于这条预警无法归属（DESIGN 8.5），
 *     宁可点亮蓝点让用户知道"数据格式变了"，也不要静默播报一条不知道发给谁的预警。
 *   · 灾种不在本插件范围内时判 **empty 而不是 schema**：Host 已按灾种过滤，正常收不到这类
 *     条目；判 empty 是为了让"Host 将来转发更多灾种"这件事对旧 Client 是静默跳过。
 */
function parseNmcAlarmResult(raw) {
  if (!isPlainObject(raw)) return failResult('schema', '顶层不是对象')
  const alertid = String(raw.alertid === undefined || raw.alertid === null ? '' : raw.alertid).trim();
  if (!alertid) return failResult('schema', '缺少 alertid（string）')
  if (typeof raw.kind !== 'string' || !raw.kind) return failResult('schema', '缺少 kind（string）')
  // 查表一律走 own()（0.5.4）：`NMC_KIND_TEXT['constructor']` 会命中原型链返回 Object 构造函数
  // （truthy），于是 `kind: 'constructor'` 这样的脏数据会**绕过 empty / schema 判据**被放行，
  // 一路带进 Alert 的 kindLabel / severity（实测能得到「大陆function Object()…预警」这种文案）。
  // 契约层存在的意义就是"Host 的 JSON 属于不可信输入"，所以这里不能直查。
  if (!own(NMC_KIND_TEXT, raw.kind)) return failResult('empty', '灾种不在本插件范围内：' + raw.kind)
  if (typeof raw.level !== 'string' || !own(NMC_LEVEL_TEXT, raw.level)) {
    return failResult('schema', '缺少或无法识别的 level：' + String(raw.level))
  }
  const title = String(raw.title === undefined || raw.title === null ? '' : raw.title).trim();
  if (!title) return failResult('schema', '缺少 title（string）')
  if (!orgOf(title)) return failResult('schema', 'title 里解析不出发布机构（形如「…气象台发布…」）')
  const t = timeMsOf(raw.issued);
  if (t === null) return failResult('schema', '缺少 issued（可解析的 ISO 时间）')
  if (timeIsImpossible(t)) return failResult('value', '发布时间客观不可能：' + String(raw.issued))
  const alert = parseNmcAlarm(raw);
  if (!alert) return failResult('schema', '解析器未能归一（结构通过校验但映射失败）')
  return okResult(alert)
}

/**
 * 美国 NWS 洪水类预警（`nws_alerts`）。
 *
 * `opts.place` 是取数器查这条时用的关注点——它让匹配层不必再算距离（DESIGN 4.7.3）。
 * 判据顺序与其它源一致：先把"不在范围内"与"结构不符"分开，再交给解析器（单一实现）。
 */
function parseNwsAlertResult(raw, opts) {
  if (!isPlainObject(raw)) return failResult('schema', '顶层不是对象')
  const p = raw.properties;
  if (!isPlainObject(p)) return failResult('schema', '缺少 properties（对象）')
  const event = typeof p.event === 'string' ? p.event : '';
  // 走 own()：`event: 'constructor'` 这类键直查会命中原型链返回函数对象（truthy），
  // 于是脏数据绕过白名单被放行（与 0.5.4 修的 nmc 查表是同一个坑）。
  if (!own(NWS_EVENT_WHITELIST, event)) {
    return failResult('empty', '事件类型不在本插件范围内：' + (event || '(空)'))
  }
  const id = String(p.id === undefined || p.id === null ? (raw.id || '') : p.id).trim();
  if (!id) return failResult('schema', '缺少 properties.id（CAP identifier）')
  const t = timeMsOf(p.sent);
  if (t === null) return failResult('schema', '缺少或无法解析 properties.sent（ISO 时间）')
  if (timeIsImpossible(t)) return failResult('value', '发布时间客观不可能：' + String(p.sent))
  const alert = parseNwsAlert(raw, opts);
  if (!alert) return failResult('schema', '解析器未能归一（结构通过校验但映射失败）')
  return okResult(alert)
}

/**
 * 加拿大 ECCC 预警（`eccc_alerts`）。
 *
 * 两道过滤器都在契约层做（与解析器里的同一份名单），这样"不在范围内"这件事在
 * **进入解析器之前**就有明确的归类，而不是靠解析器返回 null 再反推是 schema 还是 empty。
 */
function parseEcccAlertResult(raw, opts) {
  if (!isPlainObject(raw)) return failResult('schema', '顶层不是对象')
  const p = raw.properties;
  if (!isPlainObject(p)) return failResult('schema', '缺少 properties（对象）')
  const type = typeof p.alert_type === 'string' ? p.alert_type : '';
  if (type !== 'warning') {
    return failResult('empty', 'ECCC 的 ' + (type || '(空类型)') + ' 不在本插件接的范围内（advisory 按官方定义是非危险天气）')
  }
  const nameEn = typeof p.alert_name_en === 'string' ? p.alert_name_en.trim() : '';
  if (!nameEn) return failResult('schema', '缺少 alert_name_en（string）')
  // 先排除、再包含——与 05h 里的顺序一致（那边是解析器的最后一道）。
  if (ECCC_EXCLUDE.test(nameEn) || !ECCC_INCLUDE.test(nameEn)) {
    return failResult('empty', '灾种不在本插件范围内：' + nameEn)
  }
  const code = typeof p.alert_code === 'string' ? p.alert_code.trim() : '';
  if (!code) return failResult('schema', '缺少 alert_code（string）')
  const t = timeMsOf(p.publication_datetime);
  if (t === null) return failResult('schema', '缺少或无法解析 publication_datetime')
  if (timeIsImpossible(t)) return failResult('value', '发布时间客观不可能：' + String(p.publication_datetime))
  const colour = typeof p.risk_colour_en === 'string' ? p.risk_colour_en.toLowerCase() : '';
  if (!own(ECCC_COLOUR_SEVERITY, colour)) {
    return failResult('schema', 'risk_colour_en 缺失或越界：' + String(p.risk_colour_en))
  }
  const alert = parseEcccAlert(raw, opts);
  if (!alert) return failResult('schema', '解析器未能归一（结构通过校验但映射失败）')
  return okResult(alert)
}

// ---------------------------------------------------------------- 健康状态（机制层）
// 0.5.3：实现已在 **05g-source-health.js**（DESIGN 11.1 的"约定层 / 机制层"划分），调用方
// 直接从那里 import。**不要在本文件 re-export**：同一个导出名出现两个来源会被
// `scripts/check-imports.mjs` 直接判失败（它就是这么设计的），而且会让"契约"与"机制"重新
// 混在一起——那正是 0.5.3 要修的东西（见 DESIGN 11.9）。

// ============================================================================
// dsh-quake-alert · client/src/05g-source-health.js
//
// 作用：**机制层**——统一的源健康记录（0.5.3 / DESIGN 11.9）。
// 内容：三层模型（conn / data / fresh）中 data 与 fresh 两层的存储与合成、
//       逐条计数的升级阈值、蓝点的跨刷新持久化与 TTL 自愈。
// 依赖：01-constants（HEALTH_KEY）、02-storage（loadJSON / saveJSON / isPlainObject）、
//       07-store（把状态变化报给 UI）。
//
// 与 05d 的分工（DESIGN 11.1 的"约定层 / 机制层"）：
//   · 05d 是**约定层**：每个源的字段契约、失败分类（empty / schema / value）怎么判。
//   · 本文件是**机制层**：这些失败**怎么存、什么时候升级成源级异常、什么时候消失**。
//   调用方（15-entry / 12b / 12c）仍然调 `noteParseResult` 等函数，但 import 的来源是这里。
//
// ---------------------------------------------------------------------------
// 为什么需要它（三条证据，都不是推测；详见 DESIGN 11.9）
//
// ① 升级阈值：此前**每一条**解析失败都立即把源标成 schema-error（蓝点）+ 一个按了也没用的
//    「重试」。而线上的形态是逐条 entry（Host 已把整表拆开），所以上游**一条**脏数据就会
//    点亮蓝点。实测速报整表 50 条里坏 1〜2 条是常态（字段缺失），"整表全坏"才是几百条连坏。
//    现在：同一失败原因在 10 分钟窗口内累计 ≥5 条、或连续失败 ≥10 条，才升级。
// ② 蓝点的生命周期：升级后只靠"下一次成功解析"或 empty 分支清除。`cenc_eew` 实测数天才有
//    一条数据，而它的 empty 判据（10 个字段全空）与 Host"无 ID 不转发"互斥 —— 于是一条判错的
//    蓝点可以挂数天（DESIGN 11.7 第 2 条）。现在蓝点带 24 小时 TTL：不復现就自动清除并记一次
//    自愈。**判据本身不改**（改了会引入别的误判），让生命周期来兜。
// ③ 跨刷新：此前这份记录是纯内存的，页面刷新即丢（DESIGN 11.6 第 7 条）。现在 data 一层落盘，
//    页面重载后蓝点仍在 —— 它表达的"要等插件更新"这件事与刷新页面无关。
//
// 明确不做：连接状态（conn）不持久化、也不在这里判定，它由各传输层上报（重启即重新建连，
// 旧值没有意义）；新鲜度（fresh）只存"最后数据时间"，判定交给探针（12d），阈值只从契约来。
// ============================================================================


/**
 * 同一失败原因在窗口内累计这么多条 → 升级成源级蓝点。
 *
 * 取 5 的依据：速报整表 50 条里坏 1〜2 条是常态（个别条目字段缺失），5 条以上同因更像是
 * "上游改了一个字段名"这类真问题；而窗口取 10 分钟，与 `dedupe.windowMinutes` 同一量级，
 * 让"同一轮里的连续坏条目"能被累计起来。
 */
const SCHEMA_ESCALATE_COUNT = 5;
const SCHEMA_ESCALATE_WINDOW_MS = 10 * 60 * 1000;

/**
 * 连续失败这么多条（**不看原因**）→ 同样升级。
 *
 * 这条兜的是"坏法不重样"：上游把结构改得面目全非时，每条失败的原因字符串可能都不同
 * （不同字段先被检查到），按原因计数永远到不了阈值。10 条这个量级对任何源都只有
 * "结构性失败"才可能达到（正常波动不会连续 10 条全坏）。
 */
const SCHEMA_ESCALATE_CONSECUTIVE = 10;

/**
 * 蓝点的存活上限：超过它没有复现就自动清除（并记一次自愈）。
 *
 * 24 小时：足够长到"用户第二天打开还在"（那时插件更新可能已经发布），又足够短到不会让
 * 一条判错的蓝点永久挂在界面上。稀疏源（`cenc_eew` 数天一条）正是靠它恢复。
 */
const HEALTH_TTL_MS = 24 * 60 * 60 * 1000;

// ---------------------------------------------------------------- 存储
/** 内存里的健康记录：id → { data, fresh, counters, consecutiveFail } */
const health = new Map();

function ensure(id) {
  let r = health.get(id);
  if (!r) {
    r = {
      data: null, // { errorKey, kind, detail, at, firstAt, count, escalated }
      fresh: { dataTime: 0, stale: false, staleSince: 0 },
      counters: { ok: 0, schema: 0, value: 0, empty: 0 },
      consecutiveFail: 0,
    };
    health.set(id, r);
  }
  return r
}

/** 落盘。只写 data 一层（理由见文件头），没有异常的源不占空间。 */
function persist() {
  const out = {};
  for (const [id, r] of health) {
    if (!r.data) continue
    const d = r.data;
    out[id] = {
      errorKey: d.errorKey, kind: d.kind, detail: d.detail,
      at: d.at, firstAt: d.firstAt, escalated: d.escalated === true,
    };
  }
  saveJSON(HEALTH_KEY, out);
}

/**
 * 从 localStorage 恢复（模块加载时自动调一次）。过期的直接丢掉——TTL 在**读取**时也要判，
 * 否则关掉浏览器三天再打开会看到一个早已过期的蓝点。
 * @returns {number} 恢复了几条
 */
function loadHealth(now) {
  const t = now === undefined ? Date.now() : now;
  const raw = loadJSON(HEALTH_KEY, null);
  if (!isPlainObject(raw)) return 0
  let n = 0;
  for (const id of Object.keys(raw)) {
    const d = raw[id];
    if (!isPlainObject(d)) continue
    if (typeof d.errorKey !== 'string' || !d.errorKey) continue
    if (!Number.isFinite(d.at) || t - d.at > HEALTH_TTL_MS) continue
    const r = ensure(id);
    r.data = {
      errorKey: d.errorKey,
      kind: typeof d.kind === 'string' ? d.kind : 'schema',
      detail: typeof d.detail === 'string' ? d.detail : '',
      at: d.at,
      firstAt: Number.isFinite(d.firstAt) ? d.firstAt : d.at,
      count: 1, // 计数不跨刷新累计：它是"这一轮里坏了多少条"，跨会话没有意义
      escalated: d.escalated === true,
    };
    n += 1;
  }
  return n
}

// ---------------------------------------------------------------- 数据层（解析失败）
/**
 * 连接层基线：清掉数据健康之后，展示状态该回到哪一个连接状态。
 *
 * store 里存的是**合成结果**，所以先看它是不是由数据层投出来的（`schema-error` / `stale`）——
 * 是就说明连接层本身没有更好的信息，按 `open` 计；否则**沿用**当前值，否则会把
 * `reconnecting` / `degraded` / `disabled` 这些真实的连接状态抹成绿色。
 */
function connBaseOf(sourceId) {
  const cur = (store.sources && store.sources[sourceId]) || {};
  const s = cur.status;
  return (s === 'schema-error' || s === 'stale' || !s) ? 'open' : s
}

/**
 * 清掉 data 层（成功解析 / empty / TTL 自愈都走这里）。
 * 只有**确实从异常恢复了**才上报——否则每条成功的数据都会触发一次设置页重渲。
 */
function clearData(sourceId, detail, t) {
  const r = health.get(sourceId);
  if (!r || !r.data) return false
  const wasEscalated = r.data.escalated === true;
  r.data = null;
  r.consecutiveFail = 0;
  persist();
  // 走 publishStatus 而不是直接 pushSource：清掉蓝点之后该显示什么，得由合成规则决定——
  // 若这个源此刻正停更（fresh.stale），展示状态应当是「数据已过期」而不是「已连接」。
  if (wasEscalated) publishStatus(sourceId, { status: connBaseOf(sourceId), detail });
  return true
}

/**
 * 记录一次解析结果。返回 true 表示"这条数据不可用，调用方不应继续处理它"
 * —— 注意这与"是否点亮蓝点"**已经解耦**（0.5.3）：单条坏数据不该让整个源变蓝。
 *
 * empty 仍然算"结构是好的"（源正常地给出了这一条，只是与本插件无关），所以它会清掉蓝点
 * ——这条语义沿用 0.4.2，JMA 的常态就是 empty。
 */
function noteParseResult(sourceId, res, now) {
  if (!res || res.ok) return false
  const t = now === undefined ? Date.now() : now;
  const r = ensure(sourceId);
  const kind = res.kind === 'value' ? 'value' : (res.kind === 'empty' ? 'empty' : 'schema');
  if (kind === 'empty') {
    r.counters.empty += 1;
    clearData(sourceId, '数据格式已恢复正常');
    return false
  }
  r.counters[kind] += 1;
  r.consecutiveFail += 1;
  const key = kind + '|' + String(res.detail || '');
  const prev = r.data;
  const sameReason = !!prev && prev.errorKey === key && (t - prev.firstAt) <= SCHEMA_ESCALATE_WINDOW_MS;
  const count = sameReason ? prev.count + 1 : 1;
  const firstAt = sameReason ? prev.firstAt : t;
  // 一旦升级就保持（同一条异常挂着的期间不该忽蓝忽绿）；它只由成功 / empty / TTL 清除。
  const escalated = (prev && prev.escalated === true) ||
    count >= SCHEMA_ESCALATE_COUNT ||
    r.consecutiveFail >= SCHEMA_ESCALATE_CONSECUTIVE;
  const wasEscalated = !!(prev && prev.escalated === true);
  r.data = { errorKey: key, kind, detail: String(res.detail || ''), at: t, firstAt, count, escalated: !!escalated };
  if (escalated && !wasEscalated) {
    try {
      console.warn('[dsh-quake-alert] ' + sourceId + ' 连续解析失败（' + kind + '，' + count + ' 条）：' + res.detail);
    } catch (e) { /* 忽略 */ }
    persist();
    publishStatus(sourceId, { status: connBaseOf(sourceId), detail: kind + '：' + res.detail });
  }
  return true
}

/** 解析成功。清掉蓝点（若此前有），并累加成功计数。 */
function noteSourceSuccess(sourceId, now) {
  const r = ensure(sourceId);
  r.counters.ok += 1;
  return clearData(sourceId, '数据格式已恢复正常')
}

/**
 * TTL 自愈：由探针定期调用（模块自己不排定时器——定时器归 fiber，见 12d）。
 * @returns {number} 这一轮自愈了几个源
 */
function pruneHealth(now) {
  const t = now === undefined ? Date.now() : now;
  let healed = 0;
  for (const [id, r] of health) {
    if (!r.data) continue
    if (t - r.data.at <= HEALTH_TTL_MS) continue
    const wasEscalated = r.data.escalated === true;
    r.data = null;
    r.consecutiveFail = 0;
    healed += 1;
    if (wasEscalated) {
      publishStatus(id, { status: connBaseOf(id), detail: '数据格式异常已超过 24 小时没有复现，自动恢复' });
    }
  }
  if (healed) persist();
  return healed
}

// ---------------------------------------------------------------- 新鲜度层
/**
 * 上报"我最后一次拿到数据的时刻"（epoch 毫秒）。**判定不在这里**——阈值只从契约来，
 * 由探针（12d）统一算。各源只管上报事实。
 */
function noteFreshness(sourceId, dataTime) {
  const r = ensure(sourceId);
  if (typeof dataTime === 'number' && Number.isFinite(dataTime) && dataTime > 0) r.fresh.dataTime = dataTime;
  return Object.assign({}, r.fresh)
}

/** 探针写入判定结果。`staleSince` 只在"从未停更变成停更"的那一刻记一次。 */
function noteStale(sourceId, stale, now) {
  const t = now === undefined ? Date.now() : now;
  const r = ensure(sourceId);
  const next = stale === true;
  if (next && !r.fresh.stale) r.fresh.staleSince = t;
  if (!next) r.fresh.staleSince = 0;
  r.fresh.stale = next;
  return Object.assign({}, r.fresh)
}

// ---------------------------------------------------------------- 读取
function snapshot(r) {
  return {
    data: r.data ? Object.assign({}, r.data) : null,
    fresh: Object.assign({}, r.fresh),
    counters: Object.assign({}, r.counters),
    consecutiveFail: r.consecutiveFail,
  }
}

/** 单个源的记录；传 undefined 取全部（诊断快照用）。沿用既有的 API 名，减少调用方改动面。 */
function sourceHealthOf(sourceId) {
  if (sourceId !== undefined) {
    const r = health.get(sourceId);
    return r ? snapshot(r) : null
  }
  const all = {};
  for (const [k, v] of health) all[k] = snapshot(v);
  return all
}

/**
 * 把"数据健康"叠加到连接状态上。优先级：数据格式异常（用户处理不了）> 停更（中灰）> 连接状态。
 *
 * 0.5.3 起**多了一层 stale**：此前 stale 由各源自己 pushSource 上报（12b 直通 Host 的
 * `stats.stale`、12c 直通 SSE 的 status 帧），于是"谁在判"和"阈值在哪"都散着。现在统一由
 * 探针按契约判定并写进这里，各源只上报 dataTime。
 */
function effectiveStatusOf(sourceId, connStatus, detail) {
  const r = health.get(sourceId);
  if (r && r.data && r.data.escalated) return { status: 'schema-error', detail: r.data.kind + '：' + r.data.detail }
  if (r && r.fresh && r.fresh.stale) return { status: 'stale', detail: detail || '上游数据已过期' }
  return { status: connStatus, detail }
}

/**
 * **统一的状态发布入口**（0.5.4）——任何要写 `store.sources` 的层都从这里走。
 *
 * 为什么必须统一：`store.pushSource` 是**整体替换** status + detail 的，而界面上那个状态是
 * **合成**出来的（见 `effectiveStatusOf`：蓝点 > 停更 > 连接）。此前只有 12b / 12c 两个出口
 * 走了合成，探针（12d）、健康层自身（本文件）与 12-websocket 都是直接写 store，于是后写的
 * 那个会把前者的结论整个抹掉。实测两条路径都真实可达：
 *   · 探针在「数据已过期 → 恢复」翻转时写 `open`，把一条 schema-error 蓝点永久刷成绿色
 *     （12b 的去重键认定"自己的 eff 没变"，此后每一轮都不再上报）；
 *   · P2PQuake 约每 10 分钟一次的**常态断线**写 `reconnecting`，同样把蓝点冲掉。
 * 而 `sourceHealthOf()` 里 escalated 仍然是 true —— 也就是 DESIGN 11.9 A 那句
 * 「schema-error 优先于连接状态」被绕过，「上游改了字段、要等插件更新」这个用户处理不了的
 * 信号从界面上消失（设置页那个「重试」按钮也跟着消失）。
 *
 * 合成规则只有 `effectiveStatusOf` 一处，这里只负责"合成 + 写 store"。
 *
 * @param {string} sourceId
 * @param {object} patch 至少给 status 与 detail 之一；其余字段（label / retries…）原样透传
 * @returns {{status: string, detail: string}} 本次合成出的展示状态（调用方可用它做去重键）
 */
function publishStatus(sourceId, patch) {
  const p = Object.assign({}, patch);
  // 探针（12d）与健康层（本文件）手里没有中文源名，而 07-store.pushSource 的兜底是**裸 id**。
  // 不补的话，"刷新页面后立刻重发蓝点"（`republishDataHealth`）与"探针翻停更"这两条路径
  // 会让侧边栏的悬停详情显示成「usgs：上游数据已过期…」。store 里已有 label 就沿用，
  // 否则退到契约里的 label（同一份声明，比 id 可读），最后才是 id。
  if (p.label === undefined) {
    const cur = (store.sources && store.sources[sourceId]) || {};
    const declared = SOURCE_CONTRACTS[sourceId];
    p.label = cur.label || (declared && declared.label) || sourceId;
  }
  const eff = effectiveStatusOf(sourceId, p.status, p.detail);
  p.status = eff.status;
  p.detail = eff.detail;
  store.pushSource(sourceId, p);
  return eff
}

/**
 * 把已经升级的数据健康记录重新发布到 store——插件装载时调用。
 *
 * 刷新页面后 store 是空的，而蓝点存在 localStorage 里（DESIGN 11.9 A）。不重发的话，
 * 要等该源下一次上报（feed 源首轮 3 秒 + 15 秒一轮）才显示出来，而「上游改了字段」这件事
 * 与用户刷新页面毫无关系——"蓝点跨刷新存活"这条承诺应当是**立刻**成立，而不是十几秒后。
 */
function republishDataHealth() {
  for (const [id, r] of health) {
    if (!r.data || !r.data.escalated) continue
    publishStatus(id, { status: 'open' });
  }
}

/** 手动重试（DESIGN 5.4）：清掉异常标记，等下一批数据自证。 */
function retrySource(sourceId, now) {
  const r = ensure(sourceId);
  r.data = null;
  r.consecutiveFail = 0;
  persist();
  publishStatus(sourceId, { status: connBaseOf(sourceId), detail: '已手动重试，等待下一批数据' });
  return true
}

/**
 * 插件（重新）装载时重置**连接与新鲜度**两层。
 *
 * 刻意**不清 data 层**：它已经从 localStorage 恢复，而"上游改了字段、等插件更新"这件事与
 * 用户刷新页面 / 重新启用插件无关。0.5.2 之前这里清掉全部，理由是"避免上一代残留"——那是
 * data 还不持久化时的判断，现在持久化本身就是设计（DESIGN 11.9 A）。
 */
function resetConnHealth() {
  for (const [, r] of health) {
    r.fresh = { dataTime: 0, stale: false, staleSince: 0 };
    r.consecutiveFail = 0;
  }
}

/** 测试钩子：清空全部（含持久化）——模块级 Map 会跨用例存活。 */
function resetSourceHealth() {
  health.clear();
  saveJSON(HEALTH_KEY, {});
}

// 模块加载时恢复一次：页面刷新后蓝点仍在（loadClient 在测试里新建沙箱时会重新执行到这里，
// 所以"跨刷新存活"这条能力可以被直接断言）。
loadHealth();

// ============================================================================
// dsh-quake-alert · client/src/06-matcher.js
//
// 作用：匹配引擎——决定一条 Alert 是否该提醒用户。
// 内容：regionInWatch（县级 + 市级收窄）、阈值判定（震度/海啸等级）、
//       missReason（未命中原因，含未识别区域名与市级收窄提示）。
// 依赖：01-constants、04-city-table（lookupAddrCity）。
// 放行规则：区域级数据与归一不到市町村的观测点一律放行，宁可多报绝不漏报。
// ============================================================================


// ---------- 匹配引擎 ----------
// 关注地区匹配：县级始终生效（watch.prefectures 为空 = 全日本）；市级只在数据本身有
// 市区町村粒度时收窄——即 551 的观测点条目（isArea=false，addr 形如「白河市新白河」）。
// 两类情况一律放行，宁可多提醒也绝不漏报：
//   ① 区域级数据：isArea=true 的区域名、556 的区域名、552 的津波予報区名都对应不到市町村；
//   ② addr 归一不到任何市町村：机场观测点（新千歳空港）、未收录写法等。
function regionInWatch(region, watch, cityLevel, anyResolvedPref) {
  const list = watch && watch.prefectures;
  const cities = (watch && watch.cities) || [];
  // region.pref 为空 = 归属县未能识别。这里**不能简单地一律放行**（0.4.2 修正）：
  // 552/556 走的是 cityLevel=false，县级过滤是**唯一**的收窄手段，一律放行会让一条含
  // "未收录预报区名"的海啸电文提醒**所有关注列表非空的用户**（海啸域的误报最伤信任）。
  // 口径：同一条消息里只要**有**区域能归到县，归不到的条目不参与县级过滤（不因它命中）；
  // 只有当整条消息的区域**全都**归不到县时，才为了不漏报而放行（DESIGN 3.2 的"边界情况让步"）。
  if (list && list.length > 0) {
    if (region.pref) {
      if (list.indexOf(region.pref) === -1) return false
    } else if (anyResolvedPref) {
      return false
    }
  }
  if (!cityLevel || cities.length === 0) return true
  if (region.cityKnown === false) return true
  const addrCity = lookupAddrCity(region.area);
  if (!addrCity) return true
  return cities.indexOf(addrCity) !== -1
}

// 气象警报（泥石流 / 洪水 / 大雨 / 高潮…）的关注地区匹配。
// 与 551 不同，JMA 电文的区域在解析阶段就已经归到「县 + 市町村」，不需要再做 addr 归一；
// 两类一律放行，宁可多报绝不漏报：
//   ① pref 为空（区域码认不出县、或名称反查不到）——无法判定，放行；
//   ② 区域级条目（city 为空，如「宗谷地方」「○○川上流」）——对应不到市町村，放行。
// 市町村比对走 normKana 归一等价：电文/河川区域表的假名写法可能与本表不同
// （「金ケ崎町」vs「金け崎町」、「南アルプス市」vs「南あるぷす市」），
// 直接 indexOf 会让勾选了该市町村的用户漏报。
function regionInWeatherWatch(region, watch) {
  const list = (watch && watch.prefectures) || [];
  const cities = (watch && watch.cities) || [];
  if (list.length > 0 && region.pref && list.indexOf(region.pref) === -1) return false
  if (cities.length === 0) return true
  if (!region.city) return true
  const target = normKana(region.city);
  return cities.some((c) => normKana(c) === target)
}

// ---------- 坐标匹配（全球源：EMSC / USGS / NOAA CAP） ----------
// 全球源给的是「震中坐标 + 震级」，没有日本那样的都道府县 / 市町村。用户的关注表达因此是
// 「我所在的位置 + 可接受半径」，由这里做球面距离判定（Haversine，误差 <0.5%）。
// 与行政区匹配同一条原则：宁可多报绝不漏报；但坐标缺失时**不猜**——如实说明无法判定，
// 而不是默默放行（放行会让"配错了关注点"看起来像"根本没有地震"）。
const EARTH_RADIUS_KM = 6371;
function distanceKm(lat1, lon1, lat2, lon2) {
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.pow(Math.sin(dLat / 2), 2) +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.pow(Math.sin(dLon / 2), 2);
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(a)))
}
/** 坐标是否可用于计算：数值、有限、且在合法范围内（-200 这类"未知"哨兵值会被挡下）。 */
function validGeo(geo) {
  return !!geo && typeof geo.lat === 'number' && Number.isFinite(geo.lat) &&
    typeof geo.lon === 'number' && Number.isFinite(geo.lon) &&
    Math.abs(geo.lat) <= 90 && Math.abs(geo.lon) <= 180
}
/**
 * 坐标型警报的匹配：震中落在任一关注点的半径内即命中。
 * 震级阈值单独判断（globalMagnitude）——全球源给出的是震级，与日本的震度不可换算，
 * 用一个独立旋钮比"假装能换算"诚实。
 * @returns {{ hit: boolean, reason: string, place?: object, distanceKm?: number }}
 */
function matchPointAlert(alert, cfg) {
  const places = (cfg.watch && cfg.watch.places) || [];
  if (places.length === 0) {
    return { hit: false, reason: '未设置全球关注点（设置 → 灾害预警 → 全球关注点）' }
  }
  // 多区域电文（CAP 允许一个 info 下多个 <area><circle>）：任一圆心落在半径内即算命中。
  // 只看第一个 circle 会让其余海域的沿海用户漏报——多区域海啸恰恰是最常见形态。
  const pts = (Array.isArray(alert.geoList) && alert.geoList.length ? alert.geoList : [alert.geo]).filter(validGeo);
  if (pts.length === 0) {
    return { hit: false, reason: '本条消息未携带可用坐标，无法判定震中距' }
  }
  // 海啸的**等级闸门**同样适用于全球源（0.4.1）。NOAA CAP 的 <event> 决定等级
  // （Warning=3 / Advisory・Watch=2 / Information=0，见 05c 的 NOAA_EVENT_RULES），
  // 与日本 552 的 tsunamiGrade 共用同一把尺。此前这条闸门只作用于日本源，于是
  // 「Tsunami Information」（气象机构明确表示无破坏性海啸的信息）也会在半径内响铃——
  // 全球海啸完全无法用等级收敛，而海啸的误报会直接摧毁用户对整条链路的信任。
  if (alert.kind === 'tsunami') {
    const rank = typeof alert.tsunamiRank === 'number'
      ? alert.tsunamiRank
      : (typeof alert.maxScale === 'number' ? alert.maxScale : 0);
    const minRank = own(TSUNAMI_RANK, (cfg.thresholds || {}).tsunamiGrade) || 1;
    if (rank < minRank) {
      return { hit: false, reason: '海啸等级未达阈值（本条 ' + rank + ' < ' + minRank + '）' }
    }
  }
  // 震级门槛分两把（0.5.0）：坐标型**预警**（EMSC / USGS / cenc_eew）用 globalMagnitude，
  // 大陆**速报**（cenc_eqlist，alert.speedReport）用独立的 cnReportMagnitude——速报覆盖低到
  // M2.5 且每天都有数据，用预警门槛播报会被小震频繁打扰（DESIGN 8.4）。
  const th = cfg.thresholds || {};
  const minMag = alert.speedReport ? th.cnReportMagnitude : th.globalMagnitude;
  const magName = alert.speedReport ? '速报震级阈值' : '全球震级阈值';
  const mag = typeof alert.magnitude === 'number' && Number.isFinite(alert.magnitude) ? alert.magnitude : null;
  // 震级阈值只作用于地震。海啸的严重性由它自己的等级决定（上面的闸门），
  // 不该被"引发它的那次地震有多大"过滤掉：NOAA 电文里那个前震震级只是参考值，而且用同一个
  // 阈值卡海啸是危险的——用户把全球阈值调到 M7.0 时，一场 M6.7 引发的海啸警报会被静默丢掉，
  // 而海啸恰恰是这里最不能漏的一类。
  const quakeLike = alert.kind === 'quake' || alert.kind === 'eew';
  if (quakeLike && mag !== null && typeof minMag === 'number' && mag < minMag) {
    return { hit: false, reason: 'M' + mag + ' 低于' + magName + ' M' + minMag }
  }
  let nearest = null;
  for (const g of pts) {
    for (const p of places) {
      const d = distanceKm(g.lat, g.lon, p.lat, p.lon);
      if (!nearest || d < nearest.d) nearest = { p, d };
      if (d <= p.radiusKm) {
        return {
          hit: true,
          reason: (mag === null ? '' : 'M' + mag + ' · ') + '距 ' + p.name + ' 约 ' + Math.round(d) +
            ' km（半径 ' + p.radiusKm + ' km）',
          place: p,
          distanceKm: d,
        }
      }
    }
  }
  return {
    hit: false,
    reason: '震中距最近的关注点（' + nearest.p.name + '）约 ' + Math.round(nearest.d) +
      ' km，超过设定半径 ' + nearest.p.radiusKm + ' km',
  }
}

// 未命中原因：若存在未能识别归属县的区域名，明确提示，避免用户误以为链路故障
function missReason(alert, watch, base) {  const list = watch && watch.prefectures;
  const cities = (watch && watch.cities) || [];
  let reason = base;
  if (list && list.length > 0) {
    const unknown = alert.regions.filter((r) => !r.pref).length;
    if (unknown > 0) reason = base + '（另有 ' + unknown + ' 个区域名未能识别归属县）';
  }
  if (cities.length > 0) reason += '（已按所选 ' + cities.length + ' 个市区町村收窄）';
  return reason
}

// ---------- 行政区层级匹配（大陆气象源，0.5.2 / DESIGN 8.5） ----------
/**
 * 关注点名字 → 行政区对。设置页「中国大陆」加进来的点由 04-city-table 的 cnPlaceOf 生成，
 * 名字固定是「省·市」（用 U+00B7 分隔，以免两个省的"城区"撞名）。
 * 不含分隔符的点（手填坐标、全球关注点）返回 null——**行政区层级匹配不适用于它们**，
 * 忽略而不是报错：同一个 places 列表同时服务坐标型源（地震）与行政型源（气象）。
 */
function cnPlaceParts(name) {
  const s = String(name === undefined || name === null ? '' : name).trim();
  const i = s.indexOf('·');
  if (i <= 0 || i === s.length - 1) return null
  return { province: s.slice(0, i), city: s.slice(i + 1) }
}

/** 等级中文（与 05f 的 NMC_LEVEL_TEXT 同源；这里只需要拼 reason，不复制映射表会更好，
 *  但 06 不该依赖解析层——所以就地写一份最小的，并靠回归断言钉住两边一致。 */
const NMC_LEVEL_ZH = { red: '红色', orange: '橙色', yellow: '黄色', blue: '蓝色' };

/**
 * 大陆气象预警的匹配。规则按优先级排，每一条都对应一个"用户会问为什么"的场景：
 *
 *  ① 灾种开关（DESIGN 8.4 把它们拆成两个：暴雨的橙 / 红常年可见，地质灾害实测全是黄色）。
 *  ② 播报门槛：**橙色及以上**才打扰，黄 / 蓝只入历史。不满足时 reason 要说清是"等级不够"，
 *     而不是含糊的"未命中"——否则用户会把"这条预警我收到了但没响"读成故障。
 *  ③ 归属：市能对上就用市；市对不上（省直辖县 / 省台发布 / 机构名错字）时**按省放行**；
 *     连省都认不出（国家级机构等）也放行。后两条都是 DESIGN 3.2 / 8.5 的"宁可多报绝不漏报"
 *     ——一次漏报的代价远大于一次多报。
 */
function matchCnAreaAlert(alert, cfg) {
  const d = cfg.disasters || {};
  if (alert.cnKind === 'geology') {
    if (d.cnGeology === false) return { hit: false, reason: '大陆地质灾害提醒已关闭' }
  } else if (d.cnRainstorm === false) {
    return { hit: false, reason: '大陆暴雨提醒已关闭' }
  }
  if (alert.cancelled) return { hit: false, reason: '解除消息不提醒' }
  const levelZh = NMC_LEVEL_ZH[alert.cnLevel] || String(alert.cnLevel || '');
  const what = (alert.cnKind === 'geology' ? '地质灾害' : '暴雨') + levelZh + '预警';
  const rank = typeof alert.cnRank === 'number' ? alert.cnRank : 0;
  if (rank < 3) {
    return { hit: false, reason: what + '（未达橙色，仅记录）' }
  }
  const places = (cfg.watch && cfg.watch.places) || [];
  const cnPlaces = [];
  for (const p of places) {
    const parts = cnPlaceParts(p && p.name);
    if (parts) cnPlaces.push({ place: p, province: parts.province, city: parts.city });
  }
  if (cnPlaces.length === 0) {
    // 与坐标型源同一条原则：没有关注点就明确说明怎么加，**不静默**——
    // "配错了关注点"看起来像"根本没有预警"是这套系统最该避免的误解之一。
    // `noWatch` 让 11-pipeline 能把这一类和"命中了但不在列表里"区分开（前者不进历史，0.5.4）。
    return {
      hit: false,
      noWatch: true,
      reason: '未设置中国大陆关注点（设置 → 灾害预警 → 中国大陆 → 选省与城市）',
    }
  }
  const area = alert.cnArea || {};
  const province = String(area.province || '');
  const city = String(area.city || '');
  if (city) {
    const hit = cnPlaces.find((p) => p.province === province && p.city === city);
    if (hit) {
      return { hit: true, reason: what + ' · 命中关注点 ' + hit.province + '·' + hit.city, place: hit.place }
    }
    return {
      hit: false,
      reason: what + '（' + province + '·' + city + '）不在关注列表里',
    }
  }
  // 市级归属未知：省内有任何一个关注点就放行，并在 reason 里如实说明只定位到省。
  // 实测这一类的来源是海南省直辖县（乐东 / 昌江 / 琼中…）、上海市辖区，以及上游的机构名错字
  //（「黑龙江省齐哈尔市克山县」少了"齐"）——它们都是真实预警，丢掉就是漏报。
  const sameProv = cnPlaces.filter((p) => !province || p.province === province);
  if (sameProv.length > 0) {
    return {
      hit: true,
      reason: what + ' · ' + (province ? '仅能定位到 ' + province + '（' + (area.org || '发布机构未给出市级）') + '）' : '未能定位到省份，按全国放行'),
      place: sameProv[0].place,
    }
  }
  return { hit: false, reason: what + ' · 归属未识别（' + (area.org || '机构名未知') + '）' }
}

/**
 * 海外气象源（0.6.0）的命中判定：**查询即匹配**（DESIGN 4.7.3）。
 *
 * 与 matchPointAlert 的根本差别：那边的语义是"震中距 ≤ 半径"，坐标在**电文里**；
 * 这边的语义是"这条预警属于用户关注的哪个点"，归属在**取数时就确定了**
 * （取数器按关注点查 NWS 的 `?point=` / ECCC 的 `?bbox=`），所以这里不算距离——
 * 算也没有意义：NWS 返回的是"该点所在县 / 区划"的预警，一个县没有"距关注点多少公里"。
 *
 * 剩下的三个判定都是"用户看不见的漏报"防线：
 *   ① 关注点被删了（用户改配置后取数器要下一轮才生效）→ 如实说明，不当成命中；
 *   ② 档位不够（NWS 的 Watch / Advisory / Statement）→ 只记历史，不打扰；
 *   ③ 取数器没记归属（理论上不该发生）→ 不猜，明确说"无法判定"。
 */
function matchOverseasAlert(alert, cfg) {
  const d = cfg.disasters || {};
  if (d.overseasWeather === false) return { hit: false, reason: '海外气象提醒已关闭' }
  if (alert.cancelled) return { hit: false, reason: '取消消息不提醒' }
  const places = (cfg.watch && cfg.watch.places) || [];
  if (places.length === 0) {
    return {
      hit: false,
      noWatch: true,
      reason: '未设置海外关注点（设置 → 灾害预警 → ③ 其他地区：坐标 + 半径）',
    }
  }
  const origin = alert.originPlace;
  if (!origin) return { hit: false, reason: '这条海外预警未携带来源关注点，无法判定' }
  // 关注点还在不在：按"名字 + 坐标"比对（用户只改半径时仍是同一个点，命中判定不变）。
  const still = places.some((p) => p && p.name === origin.name && p.lat === origin.lat && p.lon === origin.lon);
  if (!still) {
    return { hit: false, reason: '来源关注点「' + (origin.name || '未命名') + '」已不在关注列表里' }
  }
  const rank = typeof alert.overseasRank === 'number' ? alert.overseasRank : 0;
  if (rank < OVERSEAS_BROADCAST_MIN_RANK) {
    return {
      hit: false,
      reason: (alert.headline || '海外气象预警') + '（未达播报档位，仅记录）',
    }
  }
  return {
    hit: true,
    reason: '命中关注点「' + (origin.name || '未命名') + '」· ' + (alert.headline || ''),
    place: origin,
  }
}

function matchAlert(alert, cfg) {
  const w = cfg.watch || {};
  const t = cfg.thresholds || {};
  // 这条消息里是否存在**能归到县**的区域：决定"归不到县的区域"要不要放行（见 regionInWatch）
  const anyPref = (alert.regions || []).some((r) => !!r.pref);
  if (alert.kind === 'eew' || alert.kind === 'quake') {
    if ((cfg.disasters || {}).earthquake === false) return { hit: false, reason: '地震提醒已关闭' }
    if (alert.cancelled) return { hit: false, reason: '取消消息不提醒' }
    // 全球源（EMSC / USGS）只有震中坐标、没有行政区区域 → 走坐标匹配
    if (alert.locator === 'point') return matchPointAlert(alert, cfg)
    // 551 的「震源情报 / 远地地震」没有 points，无从按震度判定——明确说明，避免用户误以为链路故障
    if (alert.regions.length === 0) {
      return {
        hit: false,
        reason: alert.kind === 'eew'
          ? '本条 EEW 未携带区域数据，无法按阈值判定'
          : '本条为震源情报，无震度数据，无法按阈值判定',
      }
    }
    const threshold = alert.kind === 'eew' ? t.eewScale : t.quakeScale;
    const hitRegion = alert.regions.find((r) => regionInWatch(r, w, alert.kind === 'quake', anyPref) && typeof r.scale === 'number' && r.scale >= threshold);
    return hitRegion
      ? { hit: true, reason: alert.kind === 'eew' ? 'EEW 预测震度达标' : '观测震度达标', region: hitRegion }
      : { hit: false, reason: missReason(alert, w, '关注地区未命中或强度低于阈值') }
  }
  if (alert.kind === 'tsunami') {
    if ((cfg.disasters || {}).tsunami === false) return { hit: false, reason: '海啸提醒已关闭' }
    if (alert.cancelled) return { hit: false, reason: '解除消息不提醒' }
    // NOAA CAP 的海啸同样是坐标型（CAP 里给的是 circle / polygon，不是日本的津波予報区）
    if (alert.locator === 'point') return matchPointAlert(alert, cfg)
    if (alert.regions.length === 0) return { hit: false, reason: '本条没有海啸预报区数据' }
    const minRank = own(TSUNAMI_RANK, t.tsunamiGrade) || 1;
    const hitRegion = alert.regions.find((r) => regionInWatch(r, w, false, anyPref) && (own(TSUNAMI_RANK, r.grade) || 0) >= minRank);
    return hitRegion
      ? { hit: true, reason: '海啸等级达标', region: hitRegion }
      : { hit: false, reason: missReason(alert, w, '关注地区未命中或等级低于阈值') }
  }
  if (alert.kind === 'weather') {
    // 海外气象源（0.6.0）走**查询即匹配**：取数器是按关注点查的（NWS 按点、ECCC 按 bbox），
    // "这条属于哪个关注点"在取数时就已经确定，所以这里不做距离计算，只做归属与档位判定。
    if (alert.locator === 'overseas') return matchOverseasAlert(alert, cfg)
    // 大陆气象源（0.5.2）走**行政区层级**匹配，与日本电文那套（都道府县 + 市町村名）是两套
    // 规则：那边的粒度是市町村、兜底是"区域级条目放行"；这边的粒度是地级市、兜底是"省级放行"，
    // 而且多一道**等级门槛**（DESIGN 8.4：橙色及以上才播报）。
    if (alert.locator === 'area') return matchCnAreaAlert(alert, cfg)
    if ((cfg.disasters || {}).weather === false) return { hit: false, reason: '气象灾害提醒已关闭' }
    if (alert.cancelled) return { hit: false, reason: '解除消息不提醒' }
    if (alert.regions.length === 0) return { hit: false, reason: '本条电文未携带可判定的区域' }
    // 播报边界写死在 L4：L1〜L3 仍然解析、仍然进历史（灰色条目），只是不打扰。
    // 依据见 DESIGN 10.3——L3 是「高齢者等避難」，与 DSH 用户群不匹配；L4 才是避难指示级。
    //
    // **闸门必须看命中地区自己的级别**，不能看电文最大值：同一条 VPWW55 里姫路市是
    // L4 大雨危険警報、相生市是 L3 大雨警報、西脇市是 L2 大雨注意報（2026-09-14 兵庫県实测）。
    // 用电文最大值会把只到 L2 的地区播成「警戒レベル4（避难指示级）」——内容夸大，
    // 而且让「市级收窄」彻底失去意义。region.level 缺失时（老对象 / 类型未识别）回退电文级别。
    const lvOf = (r) => (typeof r.level === 'number' ? r.level : alert.level);
    const hitRegion = alert.regions.find((r) => regionInWeatherWatch(r, w) && lvOf(r) >= 4);
    if (!hitRegion) {
      const anyL4 = alert.regions.some((r) => lvOf(r) >= 4);
      return {
        hit: false,
        reason: missReason(alert, w, anyL4
          ? '关注地区未命中，或命中地区未达 L4'
          : '警戒レベル' + (alert.level || '—') + '（未达 L4，仅记录）'),
      }
    }
    return {
      hit: true,
      reason: '警戒レベル' + lvOf(hitRegion) + '（' + (hitRegion.city || hitRegion.area) + '）',
      region: hitRegion,
    }
  }
  return { hit: false, reason: '不支持的 code' }
}

// ============================================================================
// dsh-quake-alert · client/src/08-audio.js
//
// 作用：提示音合成（Web Audio，零音频文件）。
// 内容：AudioContext 懒创建与用户手势解锁、四种音色（地震/EEW/海啸/取消）、
//       按灾害类型选音色并播放。
// 依赖：01-constants。
// 浏览器策略：AudioContext 需要一次用户交互才能出声，故有 unlock 逻辑。
// ============================================================================

// ---------- 音频（Web Audio 合成，零文件） ----------
let audioCtx = null;
function ensureAudio() {
  if (audioCtx === null && typeof window !== 'undefined') {
    const Ctor = window.AudioContext || window.webkitAudioContext;
    if (Ctor) { try { audioCtx = new Ctor(); } catch (err) { audioCtx = null; } }
  }
  return audioCtx
}
function unlockAudio() {
  const ctx = ensureAudio();
  if (ctx && ctx.state === 'suspended') ctx.resume().catch(() => {});
}
/**
 * 当前音频可用状态（0.4.1）：'running' | 'suspended' | 'unavailable'。
 *
 * 为什么需要它：浏览器要求 AudioContext 必须先有一次用户交互才能出声，而**页面可见时
 * 通知路径只用页内 toast（不发系统通知）**。于是"打开 DSH 后从未点击过页面"的用户
 * 在设置里看到「提示音：开」，实际一条声音都听不到，且没有任何地方能发现这件事——
 * 这是纯静默失效。设置页据此显式提示"提示音尚未解锁"。
 */
function audioState() {
  // 注意：**不能调用 ensureAudio()**（0.4.2）。设置页在渲染时会读这个函数，而 ensureAudio 会
  // 真的 new 一个 AudioContext —— 于是"只是打开设置页"就创建了音频上下文（浏览器控制台会报
  // "AudioContext was not allowed to start"），也破坏了"只在用户手势里创建"的设计。
  // 未创建同样属于"未解锁"，直接按 suspended 回答。
  if (typeof window !== 'undefined' && !(window.AudioContext || window.webkitAudioContext)) return 'unavailable'
  if (audioCtx === null) return 'suspended'
  return audioCtx.state === 'running' ? 'running' : 'suspended'
}
// 音色描述：notes 列表（freq Hz / start s / dur s / type）
const SOUNDS = {
  eew: { notes: [
    { freq: 932, start: 0, dur: 0.12, type: 'square' },
    { freq: 932, start: 0.22, dur: 0.12, type: 'square' },
    { freq: 1244, start: 0.44, dur: 0.5, type: 'square' },
  ] },
  tsunami: { notes: [
    { freq: 196, start: 0, dur: 0.9, type: 'sawtooth' },
    { freq: 147, start: 0.7, dur: 1.1, type: 'sawtooth' },
  ] },
  quake: { notes: [
    { freq: 659, start: 0, dur: 0.18, type: 'sine' },
    { freq: 880, start: 0.2, dur: 0.3, type: 'sine' },
  ] },
  // 气象警报（泥石流 / 洪水 / 大雨 / 高潮）：下行三音 + triangle 波形。
  // 与地震（上行双音 sine）、EEW（急促方波）、海啸（低频长音 sawtooth）都区分开——
  // 气象灾害与地震的应对方式不同，不该共用一个音色。
  weather: { notes: [
    { freq: 587, start: 0, dur: 0.22, type: 'triangle' },
    { freq: 494, start: 0.26, dur: 0.22, type: 'triangle' },
    { freq: 392, start: 0.52, dur: 0.6, type: 'triangle' },
  ] },
  // 取消 / 解除：下行音，与「警报」区分开
  cancel: { notes: [
    { freq: 880, start: 0, dur: 0.16, type: 'sine' },
    { freq: 659, start: 0.18, dur: 0.34, type: 'sine' },
  ] },
  test: { notes: [
    { freq: 784, start: 0, dur: 0.16, type: 'sine' },
    { freq: 1046, start: 0.18, dur: 0.3, type: 'sine' },
  ] },
};
function playSound(kind, volume) {
  const preset = SOUNDS[kind] || SOUNDS.test;
  const ctx = ensureAudio();
  if (!ctx) return
  const vol = typeof volume === 'number' && volume >= 0 && volume <= 1 ? volume : 0.7;
  const doPlay = () => {
    const master = ctx.createGain();
    master.gain.value = vol * 0.5;
    master.connect(ctx.destination);
    const t0 = ctx.currentTime;
    const nodes = []; // 这次播放创建的所有节点，播完统一断开
    let endAt = 0;
    for (const n of preset.notes) {
      const osc = ctx.createOscillator();
      const g = ctx.createGain();
      osc.type = n.type || 'sine';
      osc.frequency.value = n.freq;
      const start = t0 + n.start;
      g.gain.setValueAtTime(0.0001, start);
      g.gain.exponentialRampToValueAtTime(1, start + 0.02);
      g.gain.setValueAtTime(1, start + n.dur - 0.08);
      g.gain.exponentialRampToValueAtTime(0.0001, start + n.dur);
      osc.connect(g); g.connect(master);
      osc.start(start); osc.stop(start + n.dur + 0.05);
      nodes.push(osc, g);
      if (n.start + n.dur > endAt) endAt = n.start + n.dur;
    }
    // 播完断开：osc.stop() 只是停止发声，节点仍挂在 destination 上；
    // 每次警报都新建 2～3 个节点，长期运行会一直累积（disconnect 后交给 GC）。
    setTimeout(() => {
      for (const node of nodes) { try { node.disconnect(); } catch (err) { /* 已断开等忽略 */ } }
      try { master.disconnect(); } catch (err) { /* 忽略 */ }
    }, Math.ceil((endAt + 0.3) * 1000));
  };
  if (ctx.state === 'suspended') ctx.resume().then(() => { if (ctx.state === 'running') doPlay(); }).catch(() => {});
  else doPlay();
}
/** 按灾害类型选音色（抽成纯函数，便于断言"气象不再沿用地震音"）。 */
function soundKindOf(alert) {
  if (!alert) return 'test'
  if (alert.kind === 'eew') return 'eew'
  if (alert.kind === 'tsunami') return alert.maxScale >= 3 ? 'tsunami' : 'quake'
  if (alert.kind === 'weather') return 'weather'
  return 'quake'
}
function playAlertSound(alert, volume) {
  playSound(soundKindOf(alert), volume);
}

// ============================================================================
// dsh-quake-alert · client/src/10-dedupe.js
//
// 作用：三层去重与「已提醒事件」记忆。
// 内容：消息 id 去重（防重连重放）、事件键去重（同一地震的多次发布，强度升级穿透）、
//       跨标签页认领（BroadcastChannel + 事件键同步）、已提醒事件集合（取消提醒用）。
// 依赖：01-constants、07-store（通道建立时机在 15-entry 的 apply 里）、06-matcher（坐标型近似归并）。
// 注意：通道监听必须在插件加载时就建立，否则会错过其它标签页的广播。
// ============================================================================


// ---------- 去重 ----------
// 三层：① 消息 id（防重连重放）② 事件键（同一地震的多次发布）③ 跨标签页（多开 DSH 页面）
//
// 时钟回拨（NTP 校正 / 用户改时间 / 休眠唤醒后的时钟修正）的处理：把记录时间**夹到 now**，
// 而不是删除。删掉等于一次性清空三层去重记忆——本该被窗口抑制的重复消息会重新播报，
// alertedEvents 清空还会让随后的解除找不到"此前提醒过的事件"（少一条有用的解除提示）。
const seen = new Map(); // id -> ts
function isDuplicate(id, windowMinutes) {
  if (!id) return false
  const now = Date.now();
  const win = Math.max(1, windowMinutes || 10) * 60 * 1000;
  for (const [k, v] of seen) {
    if (v > now) { seen.set(k, now); continue }
    if (now - v > win) seen.delete(k);
  }
  if (seen.has(id)) return true
  seen.set(id, now);
  return false
}
// 同一次地震会连发「震度速报 → 震源情报 → 各地震度」或 EEW 多报（serial 递增）。
// 这些消息 id 各不相同，但共享事件键；只有强度升级时才再提醒一次，避免连续响铃。
//
// 坐标型（全球源）另存发震时刻与震中：eventKey 是「分钟 + 0.1 度」的字符串指纹，
// 而源的定位会在 0.05〜0.1 度之间浮动、发震时刻也会差几十秒——任一处跨过量化边界，
// 同一场地震就会算出不同的键，于是 EMSC 与 USGS 各响一次（README 承诺"只提醒一次"）。
// 所以键未命中时再按「±2 分钟 + 50km」找一次。
const GEO_NEAR_MS = 2 * 60 * 1000;
const GEO_NEAR_KM = 50;
const eventSeen = new Map(); // eventKey -> { ts, strength, at, geo }
function issuedMsOf(alert) {
  const t = Date.parse(String((alert && alert.issued) || ''));
  return Number.isFinite(t) ? t : null
}
/**
 * 找"这一条可能对应的先前事件记录"。
 *
 * 两级：先看**精确事件键**；未命中时再看**坐标近似**（±2 分钟 + 50km）。
 *
 * `allowSameSource` 决定近似那一级要不要排除同源：
 *   · `isEventRepeat` 传 false —— 它要回答"这条是不是另一条源对同一场地震的重复播报"，
 *     而同源不会用两个 id 报同一事件（同源修订复用同一个 id）。同源的两次不同地震
 *     （例如相隔 40 秒、相距 7km 的主震与余震）被归并就是漏报。
 *   · `isStrengthUpgrade` 传 true —— 它只在**消息 id 已经重复**时才被求值（handleAlert 里的
 *     `&&` 短路），也就是说调用方已经确定"这是同一条消息的又一次到达"，此时同源的坐标近似
 *     也必须认（EMSC 的修订版会挪坐标 / 跨分钟，键就变了）。
 */
function findPrevEvent(alert, allowSameSource) {
  const prev = eventSeen.get(alert.eventKey);
  if (prev) return prev
  if (alert.locator !== 'point' || !validGeo(alert.geo)) return null
  const at = issuedMsOf(alert);
  if (at === null) return null
  if (String(alert.eventKey || '').indexOf('test:') === 0) return null // 测试消息每次都是独立演示
  const source = String(alert.source || '');
  for (const v of eventSeen.values()) {
    if (!v.geo || typeof v.at !== 'number') continue
    if (!allowSameSource && source && v.source && v.source === source) continue
    if (Math.abs(v.at - at) <= GEO_NEAR_MS && distanceKm(alert.geo.lat, alert.geo.lon, v.geo.lat, v.geo.lon) <= GEO_NEAR_KM) {
      return v
    }
  }
  return null
}

/**
 * @param {number} [nowMs] 注入点（测试用）。`Date.now()` 不可注入时，"窗口是否过期"这类跨时间
 *   行为只能靠读码验证——而这正是 0.5.1 review 漏掉 D 类残留的原因之一（见 CHANGELOG）。
 */
function isEventRepeat(alert, windowMinutes, nowMs) {
  if (!alert.eventKey) return false
  const now = (typeof nowMs === 'number' && Number.isFinite(nowMs)) ? nowMs : Date.now();
  const win = Math.max(1, windowMinutes || 10) * 60 * 1000;
  for (const [k, v] of eventSeen) {
    if (v.ts > now) { v.ts = now; continue }
    // 清理要用**这条记录自己的窗口**，而不是本次调用的窗口。此前用的是本次的 `win`，
    // 于是一条按 3 小时窗口记住的气象事件，会被 10 分钟后任意一条"命中"地震带着的
    // 10 分钟窗口清掉——随后 L4 的更新就被判成新事件，重复响铃（0.5.1 review 的 D 类残留）。
    // 旧记录没有 win 字段时退回本次调用的窗口，行为与修复前一致（不会突然留得更久）。
    const own = typeof v.win === 'number' ? v.win : win;
    if (now - v.ts > own) eventSeen.delete(k);
  }
  const prev = findPrevEvent(alert, false);
  if (prev && alert.strength <= prev.strength) return true
  const at = issuedMsOf(alert);
  const geo = (alert.locator === 'point' && validGeo(alert.geo)) ? { lat: alert.geo.lat, lon: alert.geo.lon } : null;
  eventSeen.set(alert.eventKey, { ts: now, strength: alert.strength, at, geo, source: String(alert.source || ''), win });
  return false
}

/**
 * 让事件键的强度**回落**（降级电文调用），返回是否真的降了。
 *
 * 气象电文会"降级"：L4 → L3 → L2 是同一次灾害过程的强度回落，本身不该播报（L3 以下本来就不播报），
 * 但必须让记忆里的 strength 跟着降下来。否则"降级之后再次升级"会被判成"强度未升级的重复发布"
 * 而永久静默——这是 0.4.1 把发布时刻从事件键里去掉之后**新引入**的漏报
 * （实测：L4 播报 → L3 降级 → 再升回 L4，返回 event-repeat）。
 * 只在强度**确实更低**时下调，所以"关注地区未命中"这类 not-hit 不会误降（强度没变）。
 */
function weakenEvent(alert) {
  if (!alert || !alert.eventKey) return false
  const prev = eventSeen.get(alert.eventKey);
  if (!prev || typeof alert.strength !== 'number') return false
  if (alert.strength < prev.strength) { prev.strength = alert.strength; return true }
  return false
}
/**
 * 只读探测：同一个事件键此前见过、且这一条的强度更高吗？
 *
 * 为什么需要：消息级去重（isDuplicate，按 alert.id）排在事件级去重（isEventRepeat）之前，
 * 而**同一个消息 id 完全可能携带升级后的内容**——全球源就是这个形态：
 *   · EMSC 对同一事件的修订复用同一个 unid（`action: 'update'`）
 *   · USGS 的同一个 feature id 在震级复核后会刷新 properties.updated
 * 若只按 id 一律挡掉，震级上修（M5.2 → M6.4）永远不会再提醒——那是漏报，
 * 而"同一场地震只响一次"的本意是"重复的同一强度不要连响"，不是"修订版一律静默"。
 *
 * 本函数**不修改任何状态**（登记由 isEventRepeat 负责），只回答"该不该让消息级去重放行"。
 * 放行后仍会走 isEventRepeat 的正常判定：强度确实升级才播报，未升级依旧只记历史。
 * 时钟回拨（ts > now）按"未见过"处理，与 isEventRepeat 的清理判据保持一致。
 */
function isStrengthUpgrade(alert) {
  if (!alert || !alert.eventKey) return false
  // 必须走 findPrevEvent（含坐标近似）：本函数只在**消息 id 已重复**时被求值，也就是调用方
  // 已经确定"同一条消息又来了"。而源在修订时会把坐标挪过 0.1° 桶、或让发震时刻跨分钟 ——
  // 精确键随之改变，只查精确键就会把"震级上修"误判成"重复发布"而静默
  // （实测 EMSC 同一 unid M5.0 → M6.4 跨分钟修订 → duplicate）。这是 0.4.1 声称修好、
  // 实际只在键逐字相同时成立的那条。
  const prev = findPrevEvent(alert, true);
  if (!prev) return false
  if (prev.ts > Date.now()) return false
  return alert.strength > prev.strength
}
/**
 * 忘掉一个事件键。
 *
 * 解除 / 取消应当调用它：那表示这次灾害过程已经结束，之后再发布同一个键
 * （同一官署 + 同一灾种）是**新事件**，必须能重新播报。不这么做的话，
 * 长事件窗口（气象 3 小时）会把"解除后再次发布"当成重复而静默——那是漏报。
 */
function forgetEvent(eventKey) {
  if (eventKey) eventSeen.delete(eventKey);
}
// 已实际提醒过的事件（eventKey → ts）。
// 取消 / 解除消息只在「此前确实提醒过同一事件」时才补一条：既避免「没收到警报却收到取消」的困惑，
// 也让用户知道已经发出的警报作废（EEW 取消 / 海啸解除本身是有用信息，不该静默）。
const ALERTED_MAX_MS = 1440 * 60 * 1000;
const alertedEvents = new Map();
/**
 * 取消 / 解除的匹配键。
 *
 * **不留 kind 兜底**：事件键为空的 alert（例如某些解析不出区域的电文）若退化成 kind，
 * 任意一条海啸解除都会匹配上"此前提醒过的任意海啸事件"，播出一条假解除——假安全比不提醒更危险。
 * 空键直接返回空串，rememberAlerted / wasRecentlyAlerted 会跳过它（该事件无法被取消，安全侧）。
 */
const cancelKeyOf = (alert) => (alert && alert.eventKey) || '';
function rememberAlerted(alert) {
  const key = cancelKeyOf(alert);
  if (!key) return
  const now = Date.now();
  for (const [k, v] of alertedEvents) {
    if (v > now) { alertedEvents.set(k, now); continue }
    if (now - v > ALERTED_MAX_MS) alertedEvents.delete(k);
  }
  alertedEvents.set(key, now);
}
/**
 * 取消 / 解除消息是否有"此前确实提醒过的同一事件"。
 *
 * 窗口必须与 alertedEvents 的保留期（24 小时）一致，**不能**用 dedupe.windowMinutes（默认 10 分钟）：
 * 解除必然晚于发布——实测 2026-09-07 東京都「大雨特別警報」13:57 发布、19:01 解除，相隔 5 小时。
 * 旧实现在 10 分钟后就把记忆清掉，于是 0.1.3 加入的解除链路从未真正生效：用户收到警报后
 * 永远收不到「已解除」。
 */
function wasRecentlyAlerted(alert) {
  const key = cancelKeyOf(alert);
  if (!key) return false
  const v = alertedEvents.get(key);
  if (typeof v !== 'number') return false
  const now = Date.now();
  if (v > now || now - v > ALERTED_MAX_MS) { alertedEvents.delete(key); return false }
  return true
}
// 多开 DSH 页面时每个标签页都会收到同一条推送；用 BroadcastChannel 协商，只让一个标签页播报。
// 通道必须在插件加载时就建立监听（见 apply），否则后加载的标签页会错过先到的广播。
// 不支持 BroadcastChannel 时退化为「各标签页各自提醒」，不影响正确性。
//
// TTL 从 5 秒改到 10 分钟（0.4.1）：5 秒只覆盖"几乎同时"的情形，而真正会重复播报的是
// **先被冻结、后恢复**的标签页——冻结期间另一个标签页已经播报过，恢复后它才拉到同一批
// entry（或收到同一条 WS 推送），此时 5 秒窗口早已过期，于是又响一次。10 分钟与消息级
// 去重窗口一致：同一 alert.id 本来就不该在 10 分钟内被合法地播报两次。
const TAB_DEDUPE_MS = 10 * 60 * 1000;
const tabAlerted = new Map(); // key -> ts
let alertChannel = null;
function ensureAlertChannel() {
  if (alertChannel !== null || typeof window === 'undefined' || typeof window.BroadcastChannel !== 'function') return alertChannel
  try {
    alertChannel = new window.BroadcastChannel('dsh-quake-alert');
    alertChannel.onmessage = (ev) => {
      const d = ev && ev.data;
      if (!d) return
      // 另一个标签页清空了历史 → 本标签页也要清（否则它的下一次 addEvent 会把整份记录写回磁盘）
      if (d.type === 'history-cleared') {
        alertedEvents.clear();
        // **内存副本与磁盘都要清**（0.5.4）：此前只清了 alertedEvents，于是本标签页的历史列表
        // 仍然显示着那些条目，而下一次 addEvent 会把它们（连同新条目）重新写回 localStorage
        // ——发起清空的那个标签页一刷新又看到了。「清空记录」若出于隐私动机，这就是实际的泄漏面。
        store.push({ events: [] });
        try { saveJSON(HISTORY_KEY, []); } catch (err) { /* 写盘失败：内存已清，下次 addEvent 会覆盖 */ }
        return
      }
      if (d.type !== 'alerted' || !d.key) return
      tabAlerted.set(String(d.key), Date.now());
      // 顺带同步事件键：其它标签页此前提醒过的事件，本标签页在收到取消消息时也要知道
      if (d.eventKey) alertedEvents.set(String(d.eventKey), Date.now());
    };
  } catch (err) { alertChannel = null; }
  return alertChannel
}
function claimAlertForTab(key, eventKey) {
  if (!key) return true
  const now = Date.now();
  for (const [k, v] of tabAlerted) {
    if (v > now) { tabAlerted.set(k, now); continue }
    if (now - v > TAB_DEDUPE_MS) tabAlerted.delete(k);
  }
  if (tabAlerted.has(key)) return false
  tabAlerted.set(key, now);
  if (ensureAlertChannel()) {
    try { alertChannel.postMessage({ type: 'alerted', key, eventKey: eventKey || '' }); } catch (err) { /* 通道已关闭等忽略 */ }
  }
  return true
}
/** 广播「历史已清空」，让其它标签页同步清掉内存副本（见 13-ui-settings 的清空按钮）。 */
function broadcastHistoryCleared() {
  if (ensureAlertChannel()) {
    try { alertChannel.postMessage({ type: 'history-cleared' }); } catch (err) { /* 忽略 */ }
  }
}


// 通道关闭：原来由 entry 的 effect 直接读模块级 alertChannel，改成显式出口
function closeAlertChannel() {
  try { if (alertChannel) { alertChannel.close(); alertChannel = null; } } catch (err) { /* 忽略 */ }
}

// ============================================================================
// dsh-quake-alert · client/src/09-notify.js
//
// 作用：用户可见提醒的两种呈现——系统通知与页面内 toast。
// 内容：通知能力与权限判定、请求权限、系统通知发送、toast 渲染与自动消失。
// 依赖：01-constants。
// 约定：页面可见时只用 toast，后台才用系统通知（系统通知不可用时回退 toast）。
// ============================================================================

// ---------- 通知：系统通知 + toast ----------
function notificationSupported() { return typeof window !== 'undefined' && typeof window.Notification === 'function' }
function notificationPermission() {
  if (!notificationSupported()) return 'unsupported'
  return window.Notification.permission
}
function requestNotificationPermission() {
  if (!notificationSupported()) return Promise.resolve('unsupported')
  try { return Promise.resolve(window.Notification.requestPermission()) } catch (err) { return Promise.resolve('denied') }
}
function showSystemNotification(opts) {
  if (!notificationSupported() || window.Notification.permission !== 'granted') return false
  try {
    // eslint-disable-next-line no-new
    new window.Notification(opts.title, {
      body: opts.body || '',
      tag: opts.tag || 'quake-alert',
      icon: opts.icon,
      silent: Boolean(opts.silent),
    });
    return true
  } catch (err) { return false }
}
let toastSeq = 0;
function showToast(opts) {
  try {
    if (!window.document || !window.document.body) return
    const doc = window.document;
    const el = doc.createElement('div');
    const id = 'quake-alert-toast-' + (++toastSeq);
    el.id = id;
    // role=alert（0.5.4）：页面可见时**只用 toast**（见 11-pipeline），而这正是读屏用户
    // 唯一能收到警报的通道——没有 live region 语义，它就完全感知不到。
    // 用 typeof 守卫：非浏览器的 DOM stub（回归测试）不一定实现 setAttribute。
    if (typeof el.setAttribute === 'function') el.setAttribute('role', 'alert');
    const color = opts.color || '#e5484d';
    const style = el.style;
    style.position = 'fixed';
    style.top = '16px';
    style.right = '16px';
    style.zIndex = '2000'; // 高于 DSH 前端自身的层级（最高约 1100），但不再用 2^31-1 压住一切
    style.maxWidth = '340px';
    style.background = 'rgba(24,25,30,0.97)';
    style.color = '#e8e8ea';
    style.border = '1px solid ' + color;
    style.borderLeft = '4px solid ' + color;
    style.borderRadius = '10px';
    style.padding = '10px 14px';
    style.font = '13px/1.5 system-ui, sans-serif';
    style.boxShadow = '0 6px 24px rgba(0,0,0,0.45)';
    style.cursor = 'pointer';
    style.opacity = '0';
    style.transition = 'opacity .18s ease';
    const title = doc.createElement('div');
    title.style.fontWeight = '700';
    title.style.color = color;
    title.textContent = opts.title || '';
    const body = doc.createElement('div');
    body.style.marginTop = '3px';
    body.style.whiteSpace = 'pre-wrap';
    body.style.wordBreak = 'break-word';
    body.textContent = opts.body || '';
    el.appendChild(title); el.appendChild(body);
    el.addEventListener('click', () => { try { doc.body.removeChild(el); } catch (err) {} });
    doc.body.appendChild(el);
    requestAnimationFrame(() => { el.style.opacity = '1'; });
    const ttl = opts.ttlMs || 8000;
    setTimeout(() => {
      el.style.opacity = '0';
      setTimeout(() => { try { if (el.parentNode) el.parentNode.removeChild(el); } catch (err) {} }, 220);
    }, ttl);
  } catch (err) { /* DOM 不可用忽略 */ }
}

// ============================================================================
// dsh-quake-alert · client/src/11-pipeline.js
//
// 作用：主链——收到一条原始消息后的完整处理顺序。
// 内容：handleRaw（解析 → 去重 → 匹配 → 静默时段 → 跨标签页 → 通知 → 历史）、
//       handleCancelled（取消 / 解除提醒，仅对已提醒过的事件）。
// 依赖：05-parser、06-matcher、07-store、08-audio、09-notify、10-dedupe、01-constants。
// 重要：这是唯一把各层串起来的地方，改动前先读 06-matcher 的放行规则。
// ============================================================================


/**
 * 气象灾害的**事件窗口**（分钟）。
 *
 * 气象灾害是持续过程：同一官署同一灾种会在数小时内反复发布（更新、扩区、维持），
 * 而这些更新的强度通常不变。事件键已按「官署 + 灾种」归并（见 05b 的 eventKey），
 * 若还用默认的 10 分钟窗口，窗口一过每一条更新都会被当成新事件重新响铃。
 * 取 3 小时：窗口内强度未升级只记历史，升级（L3→L4、注意報→危険警報）仍会提醒；
 * 解除时会 forgetEvent 清掉记忆，所以"解除后再次发布"不会被吞掉。
 */
const WEATHER_EVENT_WINDOW_MINUTES = 180;

// ---------- 主链：收到消息 ----------
// 区域文案：府県予報区级的条目里 area 与 pref 常是同一个名字（「東京都」+「東京都」），
// 直接拼接会显示成「東京都東京都」。
function areaLabelOf(region) {
  const name = region.city || region.area || '';
  if (!name) return region.pref || ''
  if (!region.pref || name === region.pref || name.indexOf(region.pref) === 0) return name
  return region.pref + name
}

/**
 * 大陆源的产品名。日本源与大陆源虽然都叫"地震预警 / 速报"，却是**两家不同机构的不同产品**：
 * 気象庁的是「緊急地震速報」，中国地震台网的是「地震预警」。把日方名称套到大陆源上，
 * 用户会以为收到了日本气象厅的速报——在预警类产品里这是会误导行动的错误。
 */
function cnProductName(alert) {
  if (!alert) return ''
  if (alert.source === 'cenc_eew') return '大陆地震预警'
  if (alert.source === 'cenc_eqlist') return '大陆地震速报'
  return ''
}

/**
 * 通知文案里的「官方发布」指哪家机构。
 *
 * 各源的主管机构完全不同。此前文案里硬编码了「气象厅」，于是希腊的一场 USGS 地震、
 * 四川的一场 CENC 预警都会让用户"以气象厅官方发布为准"——免责声明里出现错误机构，
 * 会直接削弱这份声明本身的可信度。这里按源给出机构名，认不出时退化成中性表述。
 */
const AUTHORITY_BY_SOURCE = {
  emsc: '欧洲-地中海地震中心（EMSC）',
  usgs: '美国地质调查局（USGS）',
  noaa: '太平洋海啸警报中心（NOAA）',
  cenc_eew: '中国地震台网（CENC）',
  cenc_eqlist: '中国地震台网（CENC）',
  // 0.5.2：大陆气象预警的发布主体是**各级气象台**，汇总在中央气象台（中国气象局）的网站上。
  // 免责声明里点名"中央气象台（中国气象局）"而不是泛泛的"气象厅"——后者是日本的机构，
  // 出现在一条云南暴雨预警的免责声明里会直接削弱这份声明的可信度（同上一段的理由）。
  nmc_alarm: '中央气象台（中国气象局）',
  jma: '気象庁',
};
function authorityOf(alert) {
  if (!alert) return ''
  const bySource = own(AUTHORITY_BY_SOURCE, String(alert.source || ''));
  if (bySource) return bySource
  const byCode = own(AUTHORITY_BY_SOURCE, String(alert.code === undefined ? '' : alert.code));
  if (byCode) return byCode
  // P2PQuake 的 551 / 552 / 556 都是转播気象庁的信息（它们只有数字 code，没有 source）
  if (alert.code === 551 || alert.code === 552 || alert.code === 556) return '気象庁'
  return ''
}
/** 「仅供参考」那一行。机构已知时点名，未知时用中性表述（不硬编码日本气象厅）。 */
function disclaimerOf(alert) {
  const a = authorityOf(alert);
  return a ? '—— 仅供参考，请以' + a + '官方发布为准' : '—— 仅供参考，请以官方发布为准'
}

/**
 * 系统通知 / 页内 toast 的标题。抽成纯函数是为了能直接断言文案——
 * 旧写法把「地震情报 · 」与「各地震度」分开拼，非「各地」分支会留下一个悬空的分隔符。
 */
function alertTitleOf(alert) {
  if (!alert) return '灾害预警'
  // kindLabel 本身已区分「地震速报·震度速报」「地震情报·各地震度」等，不需要再拼后缀
  if (alert.kind === 'eew') return '⚠ ' + (cnProductName(alert) || '紧急地震速报（警报）')
  if (alert.kind === 'quake') return '🌐 ' + alert.kindLabel
  if (alert.kind === 'tsunami') return '🌊 ' + alert.kindLabel
  if (alert.kind === 'weather') return '🌧 ' + alert.kindLabel
  return '灾害预警'
}

/**
 * 命中之后的 severity：决定通知配色，也决定静默时段能否穿透。
 *
 * 日本地震按**命中区域的实际强度**判定（关注县的震度低时颜色不该是红，而 headline 里的
 * 最大震度可能来自别的县）；EEW 恒为 red（警报本质，不能因为预测震度刚好到阈值就降级）；
 * 海啸 / 气象用解析层算好的 severity。
 *
 * 全球源（`locator === 'point'`）必须单独处理：它们没有震度，`maxScale` 恒为 -1，
 * 若沿用震度的路径，一场 M7.4 会被算成 `info`（信息蓝）——既显示不出严重性，
 * 也会在静默时段被当成"非红色等级"静默掉（用户开了红色穿透也收不到）。所以坐标型地震
 * 直接用解析层按震级判定的 `severity`（severityOfMagnitude）。
 */
function hitSeverityOf(alert, m) {
  if (!alert || alert.kind !== 'quake') return alert ? alert.severity : 'info'
  if (alert.locator === 'point') return alert.severity
  const scale = (m && m.region && typeof m.region.scale === 'number') ? m.region.scale : alert.maxScale;
  return severityOfScale(scale)
}

// 气象警报的「静默提示」：只在"命中关注地区、但未达 L4 所以没有播报"时留一笔，
// 由侧边栏状态点的悬停提示与设置页显示。
// 注意 L4 以上**必须清掉**它：那时已经真正播报过，再挂着这条（文案是"未达 L4，未播报"）
// 就与事实自相矛盾——这是加测试按钮后暴露出来的问题。
function updateWeatherHint(alert, cfg) {
  if (alert.kind !== 'weather' || alert.cancelled) return
  // 只对**日本气象电文**生效（0.5.4）：大陆气象源（nmc_alarm，`locator === 'area'`）的
  // `regions` 恒为空数组（归属在 cnArea 里），于是这里的 `hit` 恒为 undefined，
  // 每一条大陆预警都会走到下面的"清空提示"分支，把日本电文刚留下的
  // 「L3 正在升级、未达 L4」抹成 null——两家机构、两个地区的两件事，不该互相清。
  // 0.6.0 review：**海外气象源（`locator === 'overseas'`）是同一个形态的更严重版本**——
  // 它的 `regions` 同样恒为空（05h），而它每 2 分钟就可能来一条（NWS 的 Watch/Advisory 也在其中），
  // 于是侧边栏那条日本 L3 提示会被一条美国预警反复抹掉。两条路径一起排除。
  if (alert.locator === 'area' || alert.locator === 'overseas') return
  if ((cfg.disasters || {}).weather === false) return
  const w = cfg.watch || {};
  const lvOf = (r) => (typeof r.level === 'number' ? r.level : alert.level);
  // 只看**关注地区自己的级别**：整条电文最大是 L4 时关注地区可能只有 L3（提示要保留），
  // 反之命中地区已达 L4（已真正播报）就该清掉——否则「未达 L4，未播报」的文案会与事实矛盾。
  const hit = alert.regions.find((r) => regionInWeatherWatch(r, w) && lvOf(r) === 3);
  const hitL4 = alert.regions.some((r) => regionInWeatherWatch(r, w) && lvOf(r) >= 4);
  if (!hit || hitL4) {
    if (store.weatherHint) store.push({ weatherHint: null });
    return
  }
  store.push({
    weatherHint: { level: 3, label: areaLabelOf(hit), at: Date.now() },
  });
}

// 取消 / 解除消息：仅当此前提醒过同一事件时才补一条「已取消」，否则只记历史（避免打扰）。
function handleCancelled(alert, cfg) {
  if (alert.kind !== 'eew' && alert.kind !== 'tsunami' && alert.kind !== 'weather') return
  const disasters = cfg.disasters || {};
  if (alert.kind === 'eew' && disasters.earthquake === false) return
  if (alert.kind === 'tsunami' && disasters.tsunami === false) return
  if (alert.kind === 'weather' && disasters.weather === false) return
  if (!wasRecentlyAlerted(alert)) {
    addEvent({
      id: alert.id, code: alert.code, kind: alert.kind, label: alert.kindLabel, severity: alert.severity,
      issued: alert.issued, headline: alert.headline + '（未命中：取消 / 解除消息，且此前未提醒过该事件）', hit: false,
    });
    return
  }
  // 取消 / 解除消息不穿透静默（它不是紧急警报，静默期间只记历史）
  if (inQuietHours(cfg)) {
    addEvent({
      id: alert.id, code: alert.code, kind: alert.kind, label: alert.kindLabel, severity: alert.severity,
      issued: alert.issued, headline: alert.headline, hit: true,
      suppressed: true,
      suppressedReason: '静默时段 ' + cfg.quietHours.start + '–' + cfg.quietHours.end + '（取消 / 解除不穿透）',
    });
    return
  }
  alertedEvents.delete(cancelKeyOf(alert)); // 同一条取消只提醒一次
  // 灾害过程已结束：忘掉事件键，这样"解除之后再次发布"会被当成新事件而不是重复（见 10-dedupe）
  forgetEvent(cancelKeyOf(alert));
  if (!claimAlertForTab('cancel:' + (alert.id || cancelKeyOf(alert)), '')) {
    addEvent({
      id: alert.id, code: alert.code, kind: alert.kind, label: alert.kindLabel, severity: alert.severity,
      issued: alert.issued, headline: alert.headline, hit: true,
      suppressed: true, suppressedReason: '其它 DSH 标签页已提醒',
    });
    return
  }
  addEvent({
    id: alert.id, code: alert.code, kind: alert.kind, label: alert.kindLabel, severity: alert.severity,
    issued: alert.issued, headline: alert.headline, hit: true,
  });
  const title = alert.kind === 'eew'
    ? '✅ ' + (cnProductName(alert) || '紧急地震速报') + '已取消'
    : (alert.kind === 'tsunami' ? '✅ 海啸预报已解除' : '✅ ' + alert.kindLabel);
  const body = alert.headline + '\n此前发出的警报已作废。\n' + disclaimerOf(alert);
  if (cfg.notify.sound !== false) playSound('cancel', cfg.notify.volume);
  const pageVisible = typeof document !== 'undefined' && document.visibilityState === 'visible';
  if (pageVisible) {
    showToast({ title, body, color: '#4ade80' });
  } else if (cfg.notify.system) {
    const ok = showSystemNotification({ title, body, tag: 'quake-alert-cancel-' + alert.id, silent: true });
    if (!ok) showToast({ title, body, color: '#4ade80', ttlMs: 20000 });
  }
}

function handleRaw(raw, cfg) {
  const alert = parse(raw);
  if (!alert) return
  handleAlert(alert, cfg);
}

/**
 * 处理一条已归一为 Alert 的消息——P2PQuake 的 551/552/556 与気象庁的电文最后都汇到这里，
 * 保证去重 / 匹配 / 静默 / 跨标签页 / 通知 / 历史这六步对两者完全一致。
 * @param {{ skipQuietHours?: boolean }} [opts] 仅供设置页的「发送测试气象警报」使用：
 *   测试的语义是"验证提醒链路"，不该被静默时段悄悄吞掉，否则用户会以为插件坏了。
 * @returns {{ notified: boolean, reason?: string, detail?: string }} 如实回报这一步到底做没做播报，
 *   以及没播报的原因——设置页的测试按钮据此给出准确提示，而不是写死一句"应看到弹窗"。
 */
/**
 * 全球源（坐标型）在用户**没有配置任何「全球关注点」**时整条丢弃，连历史都不记。
 * 理由：EMSC 实测每天推送几十条 M3.8+ 的全球地震。若按"未命中"记入历史，历史列表会被
 * 与用户毫无关系的远地地震刷屏，真正该看见的提醒反而被挤掉。配置了关注点后立即生效
 * （不需要重连或重启），状态点与设置页会提示"全球源已连接但未设置关注点"。
 */
function watchlessPoint(alert, cfg) {
  if (!alert || alert.locator !== 'point') return false
  const places = (cfg.watch && cfg.watch.places) || [];
  return places.length === 0
}

function handleAlert(alert, cfg, opts) {
  const options = opts || {};
  if (watchlessPoint(alert, cfg)) {
    return { notified: false, reason: 'no-watch-point', detail: '全球源消息，但未设置全球关注点' }
  }
  // 诊断计数：用 push 带出去，让设置页的"已收到 N 条推送"立刻反映（直接自增不会触发重渲，
  // 徽标会滞后到下一次 push；而 clearSources 时会归零，不再跨代累积）。
  store.push({ received: store.received + 1 });
  // 消息级去重按 alert.id。**但强度升级要放行**：全球源的修订版复用同一个 id
  // （EMSC 的 unid / USGS 的 feature id），一律挡掉会让震级上修永远不再提醒。
  // 放行后由下面的 isEventRepeat 判定"确实升级才播报"，未升级仍只记历史。
  if (isDuplicate(alert.id, cfg.dedupe.windowMinutes) && !isStrengthUpgrade(alert)) {
    return { notified: false, reason: 'duplicate', detail: '同一条消息刚处理过（去重窗口内）' }
  }
  if (alert.cancelled) {
    handleCancelled(alert, cfg);
    return { notified: false, reason: 'cancelled', detail: '这是取消 / 解除消息' }
  }
  const m = matchAlert(alert, cfg);
  if (!m.hit) {
    // 气象警报：即使不播报（L3 及以下），也把"正在升级"留给侧边栏 tooltip
    updateWeatherHint(alert, cfg);
    // 气象的**降级**（L4 → L3 → L2）要记进事件键：否则"降级之后再次升级"会被当成
    // 强度未升级的重复发布而永久静默（见 10-dedupe 的 weakenEvent）。
    // 只在强度确实更低时下调，所以"关注地区未命中"这类 not-hit 不会有副作用。
    if (alert.kind === 'weather') weakenEvent(alert);
    // 全球源（坐标型）的"未命中"通常不进历史：USGS 的 24 小时目录有近百条 M2.5+，
    // 逐条记"未命中"会把历史列表刷满与用户无关的地震，真正该看的提醒反而被挤掉。
    // **但「坐标缺失」是例外**——那不是"离得远"，而是"根本没法判定"。DESIGN 3.1 要求
    // 这种情况不猜、如实说明；若也丢进 /dev/null，用户看到的就是"根本没有地震"，
    // 与"未设置关注点"（更早由 watchlessPoint 拦下，有意不回历史）是完全不同的两件事。
    //
    // 0.5.4：`m.noWatch`（**未配置**关注点，命中概率恒为 0）同样不进历史。大陆气象源
    // （nmc_alarm）走行政区匹配，不在 watchlessPoint 的覆盖范围内，而它默认就在拉——
    // 一条都没配大陆关注点的用户，每天会有几十条「未命中：未设置中国大陆关注点」挤进
    // HISTORY_MAX=30 的「最近预警」，真正的地震 / 海啸提醒被挤出去。这与坐标型源那条
    // 「真正的提醒会被刷掉」是同一个失败形态（DESIGN 3.2 对 point 源已定过这个口径）。
    // 与坐标型的差别是**不整条丢弃**：设置页与诊断仍需要"有预警、但你没配关注点"这个信息。
    if (!m.noWatch && (alert.locator !== 'point' || !validGeo(alert.geo))) {
      addEvent({
        id: alert.id, code: alert.code, kind: alert.kind, label: alert.kindLabel, severity: alert.severity,
        issued: alert.issued, headline: alert.headline + '（未命中：' + m.reason + '）', hit: false,
      });
    }
    return { notified: false, reason: 'not-hit', detail: m.reason }
  }
  const hitPref = m.region ? m.region.pref : '';
  // 严重度见 hitSeverityOf 的注释（全球点型地震此前被算成 info，静默穿透因此失效）
  const hitSeverity = hitSeverityOf(alert, m);
  // 跨会话重放**探测**（0.4.2）：Host 重启后会按冷启动回看窗口（USGS 6 小时 / NOAA 24 小时）把
  // 缓冲里的事件重新投递，而 Client 的消息级 / 事件级去重都是 10 分钟的内存窗口——页面没刷新时
  // 早已过期，同一场地震会被再报一次。`alertedEvents`（"真正播报过"的记忆）保留 24 小时，
  // 正好用来挡这种重放。
  // **必须在这里先算**：isEventRepeat 会把 strength 更新成本次的值，之后 isStrengthUpgrade 就
  // 永远是 false。也不能直接在这里就抑制——同一会话内的"后续发布"（震度速报 → 各地震度）
  // 应该由 isEventRepeat 归类为更准确的"同一地震的后续发布"，而不是笼统的"重放"。
  const looksReplayed = wasRecentlyAlerted(alert) && !isStrengthUpgrade(alert);
  // 同一次地震的后续发布（速报 → 震源 → 各地震度、或 EEW 多报）强度未升级 → 只更新历史，不再响铃。
  // 气象灾害用更长的事件窗口（见 WEATHER_EVENT_WINDOW_MINUTES 的说明）。
  const repeatWindow = alert.kind === 'weather'
    ? Math.max(cfg.dedupe.windowMinutes || 10, WEATHER_EVENT_WINDOW_MINUTES)
    : cfg.dedupe.windowMinutes;
  if (isEventRepeat(alert, repeatWindow)) {
    addEvent({
      id: alert.id, code: alert.code, kind: alert.kind, label: alert.kindLabel, severity: hitSeverity,
      issued: alert.issued, headline: alert.headline, hit: true, pref: hitPref,
      suppressed: true, suppressedReason: '同一地震的后续发布（强度未升级）',
    });
    return { notified: false, reason: 'event-repeat', detail: '同一事件的后续发布，强度未升级' }
  }
  // 事件级去重没拦下、但记忆说"这个事件在 24 小时内已经真正播报过" → 判为跨会话重放
  // （Host 重启按回看窗口重投），只记历史不响铃。
  //
  // 0.5.4 修正**文案**：`looksReplayed` 的判据是 24 小时的已提醒记忆，它覆盖的不只是
  // Host 回看窗口的重投，还包括"同一官署同一灾种在 3 小时事件窗口之后、24 小时之内等强度的
  // 第二次独立发布"（气象事件尤其如此）。旧文案把原因写成"Host 重启 / 重连后的重放"，
  // 会让排查的人去翻 Host 重启日志，而真正生效的是长期事件记忆。行为方向是安全的
  // （不重复响铃），所以只改措辞、不改判据。
  if (looksReplayed) {
    addEvent({
      id: alert.id, code: alert.code, kind: alert.kind, label: alert.kindLabel, severity: hitSeverity,
      issued: alert.issued, headline: alert.headline, hit: true, pref: hitPref,
      suppressed: true, suppressedReason: '同一事件在最近 24 小时内已提醒过（等强度，不重复响铃）',
    });
    return { notified: false, reason: 'replayed', detail: '该事件在最近 24 小时内已经提醒过，本次只记历史' }
  }
  // 打开页面时才发现的老预警（0.6.0 的年龄闸门，DESIGN 4.7.6）：**仍然命中、仍然进历史**，
  // 但不响铃、不弹通知——海外气象源是**按关注点查询**的，页面一打开就会把当前生效的预警全拉回来，
  // 其中可能有几小时前发布、仍在生效的洪水预警（有效期实测中位 12.6 小时）。把那些当"刚刚发生"
  // 播报是纯粹的打扰；整条丢掉又会让用户看不到"就在打开页面前发布的那一条"。
  // 与"静默时段"分开成两条 reason：那个是用户自己设的时段，这个是数据本身发布得早。
  //
  // **位置有讲究**（0.6.0 review 修正）：必须放在 `isEventRepeat` **之后**。放在它之前会绕过
  // 事件级记忆的更新——同一条老预警每过一轮消息级去重窗口（10 分钟）就会再进一次历史，
  // 30 条的历史列表会被同一条老预警占满、真正的提醒被挤出去（正是 11.10 第 4 条那个形态）。
  // 放在后面时：第一次到达由本分支记历史，而 isEventRepeat 已经把事件写进记忆，
  // 后续轮次会被判成"同一事件的后续发布"，不再重复进历史。
  if (options.staleOnArrival) {
    const hours = typeof options.staleOnArrival === 'number' ? options.staleOnArrival : 0;
    // **同时记进"已提醒过"的 24 小时记忆**（0.6.0 review B-4）：只靠 `isEventRepeat` 的事件窗口
    // （气象 3 小时）不够——窗口一过，同一条仍在生效的老预警会被判成新事件、在开着的页面里响铃
    //（洪水有效期中位 12.6 小时 → 一天可能响 3〜4 次，而用户刚被告知"只记历史，不打扰"）。
    // 记进这条记忆之后，后面的 `looksReplayed` 分支会把它拦住。
    rememberAlerted(alert);
    addEvent({
      id: alert.id, code: alert.code, kind: alert.kind, label: alert.kindLabel, severity: hitSeverity,
      issued: alert.issued, headline: alert.headline, hit: true, pref: hitPref,
      suppressed: true,
      suppressedReason: '打开页面时该预警已发布约 ' + hours + ' 小时（只记历史，不打扰）',
    });
    return { notified: false, reason: 'stale-on-arrival', detail: '发布较早，仅记录' }
  }
  // 静默时段：命中但不响铃、不弹通知，只记历史。红色等级（EEW、大海啸警报）默认可穿透。
  if (!options.skipQuietHours && inQuietHours(cfg) && !(hitSeverity === 'red' && cfg.quietHours.breakForSevere !== false)) {
    addEvent({
      id: alert.id, code: alert.code, kind: alert.kind, label: alert.kindLabel, severity: hitSeverity,
      issued: alert.issued, headline: alert.headline, hit: true, pref: hitPref,
      suppressed: true,
      suppressedReason: '静默时段 ' + cfg.quietHours.start + '–' + cfg.quietHours.end +
        (hitSeverity === 'red' ? '（未开启红色等级穿透）' : ''),
    });
    return { notified: false, reason: 'quiet-hours', detail: '当前处于静默时段' }
  }
  // 其它 DSH 标签页已经播报过同一条消息 → 本标签页静默，避免多个页面同时响铃。
  // 用消息 id 而不是事件键：多标签页收到的是同一条消息，而同一事件的不同消息（如强度升级）不应被拦。
  if (!claimAlertForTab(alert.id, cancelKeyOf(alert))) {
    addEvent({
      id: alert.id, code: alert.code, kind: alert.kind, label: alert.kindLabel, severity: hitSeverity,
      issued: alert.issued, headline: alert.headline, hit: true, pref: hitPref,
      suppressed: true, suppressedReason: '其它 DSH 标签页已提醒',
    });
    return { notified: false, reason: 'other-tab', detail: '其它 DSH 标签页已提醒同一条' }
  }
  const prefZh = (PREFECTURES.find((p) => p.jp === hitPref) || {}).zh || hitPref;
  const title = alertTitleOf(alert);
  const bodyLines = [alert.headline];
  if (hitPref) bodyLines.push('命中关注地区：' + prefZh + (prefZh !== hitPref ? '（' + hitPref + '）' : ''));
  // 全球源没有行政区，命中依据是「距某个关注点多少公里」——把距离说出来，
  // 用户才能判断这条提醒是否可信（半径是自己设的）
  else if (m.place) bodyLines.push('命中关注点：' + m.place.name + '（距震中约 ' + Math.round(m.distanceKm) + ' km）');
  if (alert.kind === 'tsunami') bodyLines.push('请立即远离海岸与河口');
  if (alert.kind === 'weather') bodyLines.push('请确认所在市町村的避难信息');
  bodyLines.push(disclaimerOf(alert));
  addEvent({
    id: alert.id, code: alert.code, kind: alert.kind, label: alert.kindLabel, severity: hitSeverity,
    issued: alert.issued, headline: alert.headline, hit: true, pref: hitPref,
  });
  updateWeatherHint(alert, cfg);
  const vol = cfg.notify.volume;
  if (cfg.notify.sound !== false) playAlertSound(alert, vol);
  const pageVisible = typeof document !== 'undefined' && document.visibilityState === 'visible';
  const body = bodyLines.join('\n');
  if (pageVisible) {
    // 页面可见时只用页内 toast（DESIGN 第 7 节：可见 → toast，后台 → 系统通知）
    showToast({ title, body, color: sevColor(hitSeverity) });
  } else if (cfg.notify.system) {
    const ok = showSystemNotification({ title, body, tag: 'quake-alert-' + alert.id, silent: true });
    if (!ok) showToast({ title, body, color: sevColor(hitSeverity), ttlMs: 20000 });
  }
  rememberAlerted(alert);
  return { notified: true }
}

// ============================================================================
// dsh-quake-alert · client/src/12-websocket.js
//
// 作用：P2PQuake WebSocket 连接管理。
// 内容：连接/断开状态机、指数退避重连（1s→60s 封顶）、数据源切换（正式/沙箱）、
//       建连超时看门狗、「久无数据」的半开连接检测（主动重连）、消息转交主链。
// 依赖：01-constants、02-storage（读数据源）、11-pipeline（handleRaw）。
// 背景：P2PQuake 约每 10 分钟强制断线，重连是常态路径而非异常。
// ============================================================================


/**
 * 建连看门狗（0.3.3）：浏览器在"连不上又不断开"的半开状态下不会给任何事件——既没有 onopen
 * 也没有 onclose。没有这个看门狗，状态点会永远停在「连接中…」并且不会有任何重连。
 * 下面的久无数据检测以 onopen 为基准，覆盖不到建连这一段；两者互补。
 */
const CONNECT_TIMEOUT_MS = 15 * 1000;

/**
 * 半开连接检测（0.3.2）：NAT / 代理静默断开时 TCP 已经不通，但浏览器**不会**触发 onclose，
 * 于是状态点一直是绿色的「已连接」，实际一条推送都收不到——对预警产品这是最危险的失效模式
 * （用户以为自己在被保护）。P2PQuake 约每 10 分钟强制断线一次，正常情况下 lastActivityAt
 * 会被 onclose → 重连 → onopen 不断刷新，所以 20 分钟毫无活动只可能是连接真的死了。
 */
const STALE_AFTER_MS = 20 * 60 * 1000;
const STALE_CHECK_MS = 60 * 1000;

// ---------- WebSocket 客户端 ----------
/**
 * @param {object} [opts] 不传即 P2PQuake（日本链路），行为与 0.3.x 完全一致。
 * @param {string} [opts.sourceId] 状态汇报用的源标识（多源聚合，见 07-store 的 pushSource）
 * @param {string} [opts.label] 状态文案里的源名
 * @param {() => string} [opts.urlOf] 当前应连的地址（P2PQuake 会在正式源 / 沙箱源之间切换）
 * @param {number} [opts.staleAfterMs] 「久无数据」判据；0 = 关闭（消息稀疏的源必须关掉）
 * @param {(url: string) => string} [opts.openDetail] 连上后的状态文案
 * @param {(raw: object, cfg: object) => void} [opts.onRaw] 消息处理入口
 */
function createWsClient(opts) {
  const o = opts || {};
  const sourceId = o.sourceId || 'p2pquake';
  const label = o.label || 'P2PQuake';
  const staleAfterMs = o.staleAfterMs === undefined ? STALE_AFTER_MS : o.staleAfterMs;
  const staleCheckMs = o.staleCheckMs === undefined ? STALE_CHECK_MS : o.staleCheckMs;
  const connectTimeoutMs = o.connectTimeoutMs === undefined ? CONNECT_TIMEOUT_MS : o.connectTimeoutMs;
  const urlOf = o.urlOf || (() => (currentCfg().source === 'sandbox' ? SANDBOX_URL : WS_URL));
  const openDetailOf = o.openDetail || ((url) => (url.indexOf('sandbox') !== -1
    ? '沙箱源：回放 2023 年历史（约30秒/条）'
    : '已连接 P2PQuake（约每 10 分钟自动重连）'));
  const onRaw = o.onRaw || ((raw, cfg) => handleRaw(raw, cfg));
  // 上报经 publishStatus 合成（0.5.4）：本层只知道**连接**状态，而展示状态还要叠加
  // 数据健康（蓝点）与停更。此前直接 pushSource，于是"一次常态断线"（P2PQuake 约每 10 分钟
  // 必发生一次）就会把一条 schema-error 蓝点冲成 reconnecting，而上游其实一直在坏——
  // 用户看到的是"链路在重连"，看不到"数据我们读不懂"（两者要采取的行动完全不同）。
  const report = (patch) => publishStatus(sourceId, Object.assign({ label }, patch));
  let ws = null;
  let timer = null;
  let staleTimer = null;
  let connectTimer = null;
  let stopped = false;
  let retries = 0;
  let lastActivityAt = 0; // 最近一次 onopen / onmessage 的时刻
  let processFails = 0; // 连续的消息处理失败次数（0.4.1：主链异常必须可见）
  let visibilityBound = false;

  /**
   * 页面从冻结 / 休眠中恢复时刷新活动时刻（0.4.1）。
   *
   * 后台标签页被冻结、系统休眠期间，消息事件根本不会被派发；恢复后如果立刻用「20 分钟无活动」
   * 判死，就会把一条本来健康的连接拆掉重连（P2PQuake 没有回放，冻结期间缓冲里的 551/556
   * 就此永久丢失——EEW 的有效窗口只有几十秒，等价漏报）。恢复可见时给一个完整的新窗口。
   */
  function onVisibilityChange() {
    if (stopped) return
    const doc = typeof document !== 'undefined' ? document : null;
    if (!doc || doc.visibilityState !== 'visible') return
    if (!ws || ws.readyState !== 1) return
    lastActivityAt = Date.now();
    armStaleWatch();
  }
  function bindVisibility() {
    const doc = typeof document !== 'undefined' ? document : null;
    if (!doc || visibilityBound || typeof doc.addEventListener !== 'function') return
    doc.addEventListener('visibilitychange', onVisibilityChange);
    visibilityBound = true;
  }
  function unbindVisibility() {
    const doc = typeof document !== 'undefined' ? document : null;
    if (!doc || !visibilityBound || typeof doc.removeEventListener !== 'function') return
    doc.removeEventListener('visibilitychange', onVisibilityChange);
    visibilityBound = false;
  }

  function stopStaleWatch() {
    if (staleTimer) { clearTimeout(staleTimer); staleTimer = null; }
  }
  function clearConnectWatch() {
    if (connectTimer) { clearTimeout(connectTimer); connectTimer = null; }
  }
  /** 建连阶段排一个超时：到点还没动静就放弃这条连接，按退避重来。 */
  function armConnectWatch(target) {
    clearConnectWatch();
    if (stopped || !(connectTimeoutMs > 0)) return
    connectTimer = setTimeout(() => {
      connectTimer = null;
      if (stopped || ws !== target) return // 已经换过连接 / 已清理，忽略这次
      // 先关掉这条卡住的连接：否则 1 秒后 connect() 只是覆盖 ws 引用，旧 socket 无人回收
      teardown();
      scheduleReconnect('连接超时（建连无响应）');
    }, connectTimeoutMs);
    if (connectTimer && typeof connectTimer.unref === 'function') connectTimer.unref();
  }
  /** 排下一次「是否久无数据」的检查；检测关闭（staleAfterMs <= 0）时不排。 */
  function armStaleWatch() {
    stopStaleWatch();
    if (stopped || !(staleAfterMs > 0) || !(staleCheckMs > 0)) return
    staleTimer = setTimeout(() => {
      staleTimer = null;
      if (stopped) return
      if (lastActivityAt && Date.now() - lastActivityAt > staleAfterMs) {
        // 这条连接确实已经死了，不必再等退避：立刻换一条，onopen 会刷新 lastActivityAt
        report({ status: 'reconnecting', retries, detail: '久无数据（疑似连接已断开），正在重连' });
        teardown();
        connect();
        return
      }
      armStaleWatch();
    }, staleCheckMs);
    if (staleTimer && typeof staleTimer.unref === 'function') staleTimer.unref();
  }

  /** @param {string} [reason] 断开原因，写进状态文案（onclose 时留空用默认文案）。 */
  const scheduleReconnect = (reason) => {
    if (stopped) return
    retries += 1; // 从「第 1 次」开始计数，退避序列 1s → 2s → 4s → … → 60s 封顶
    report({
      status: 'reconnecting',
      retries,
      detail: (reason || '连接断开') + '，正在重连（第 ' + retries + ' 次）',
    });
    const delay = Math.min(RECONNECT_MAX, RECONNECT_BASE * Math.pow(2, retries - 1));
    timer = setTimeout(connect, delay);
  };
  const connect = () => {
    if (stopped) return
    const url = urlOf();
    report({ status: 'connecting', retries, detail: '正在连接 ' + url });
    try { ws = new window.WebSocket(url); } catch (err) {
      scheduleReconnect();
      return
    }
    armConnectWatch(ws);
    ws.onopen = () => {
      clearConnectWatch();
      retries = 0;
      processFails = 0;
      lastActivityAt = Date.now();
      armStaleWatch();
      report({ status: 'open', retries: 0, detail: openDetailOf(url) });
    };
    ws.onmessage = (ev) => {
      lastActivityAt = Date.now();
      let raw;
      try { raw = JSON.parse(String(ev.data)); } catch (err) { return } // 单条 JSON 坏掉不影响连接
      // 主链**必须单独 try**（0.4.1）。此前 JSON.parse 与 onRaw 共用一个空 catch，
      // 于是 parse / match / handleAlert 里任何确定性异常都被吞掉：socket 正常、状态常绿、
      // 零提醒、无计数——这是比断线更难发现的静默失效（断线至少会变红）。
      try {
        onRaw(raw, currentCfg());
        // 恢复：连续失败之后只要有一条处理成功，就要把状态改回 open（0.4.2）。
        // 原先只在 onopen 时复位，于是 **一次** 主链异常就会让侧边栏永久停在"链路降级"——
        // 用户看到一个错误的黄点，比不显示更糟。
        if (processFails > 0) {
          processFails = 0;
          report({ status: 'open', retries, detail: openDetailOf(url) });
        }
      } catch (err) {
        processFails += 1;
        report({
          status: 'degraded',
          retries,
          detail: '消息处理连续失败 ' + processFails + ' 次：' + String((err && err.message) || err),
        });
      }
    };
    ws.onerror = () => { /* onclose 统一处理 */ };
    ws.onclose = () => {
      clearConnectWatch();
      stopStaleWatch(); // stale 链必须随这条 socket 结束，否则它会脱离连接继续存活
      scheduleReconnect();
    };
  };
  const teardown = () => {
    stopStaleWatch();
    clearConnectWatch();
    if (timer) { clearTimeout(timer); timer = null; }
    if (ws) { try { ws.onclose = null; ws.close(); } catch (err) {} ws = null; }
  };
  return {
    start() {
      // start 必须是 stop 的逆操作（0.5.4）：原来只有 restart() 清 `stopped`，于是
      // "stop 之后再 start"会静默地什么都不做（connect() 第一行就是 `if (stopped) return`）。
      // 当前唯一调用点是入口的一次 start（重配走 restart），所以不是活缺陷——
      // 但 start/stop 与 restart 的语义不对称，任何后来的"重新 start"都会被静默吞掉。
      stopped = false;
      retries = 0;
      processFails = 0;
      bindVisibility();
      connect();
    },
    stop() {
      stopped = true;
      teardown();
      unbindVisibility();
      report({ status: 'closed', retries, detail: '已停止（插件停用）' });
    },
    restart() {
      stopped = false;
      retries = 0; // 切数据源后立即从 1s 退避重新开始，而不是沿用上一条连接的退避进度
      processFails = 0;
      bindVisibility(); // stop() 会解绑；restart 之后这条 socket 同样需要"恢复可见时重置 stale 计时"
      teardown();
      connect();
    },
  }
}

let activeClient = null;


// entry 需要把新建的 client 记到模块级 activeClient：跨模块不能写 imported binding
const setActiveClient = (c) => { activeClient = c; };

// ============================================================================
// dsh-quake-alert · client/src/12b-feed-poll.js
//
// 作用：从 Host 的只读路由拉気象庁电文增量，解析成 Alert 后交给主链
//       ——与 P2PQuake 的 551/552/556 汇到同一个 handleAlert。
// 内容：游标生命周期（持久化 / 首次对齐 / Host 重启恢复）、增量应用、失败容错、
//       启停、诊断计数。
// 依赖：02-storage（游标落盘）、03-settings-bridge（currentCfg）、
//       05b-jma-parser（parseJma）、11-pipeline（handleAlert）。
//
// 为什么拉本地而不是浏览器直连気象庁：Host 是每台机器唯一的外部请求者，多标签页 / 多窗口
// 不会放大请求——気象庁明文要求「一度取得したファイルを再度取得しない」，违反会被封 IP。
// 这里只从回环地址取增量，没有外部成本。
//
// 游标语义（0.3.2 起三种）：
//   · `?since=N`     —— 返回 seq > N 的条目；Host 环缓冲淘汰旧条目时带 truncated，表示中间
//                       有缺口，此时仍然应用已有条目（宁可少报几条，也不要卡住不再前进）。
//   · `?since=tail`  —— **首次启动**（本地还没有游标）只要当前位置、不要历史。若首次就用 0，
//                       刷新页面会把 Host 缓冲里几小时前的旧警报当新闻重放（响铃 + 弹窗）。
//   · 响应 `reset`   —— Host 进程重启后游标从 0 重新计数，此时 Client 手里那个更大的游标会让
//                       `entries` 永远为空（连 truncated 都不为真）→ 静默失联。Host 检出
//                       `since > cursor` 后按 0 补齐并置 reset，Client 据此对齐游标。
// 游标落盘后，刷新 / 新开标签页都从上次的位置继续，不会再重放。
// ============================================================================


/** Host 侧的电文增量路由（与 lib/index.js 的 FEED_PATH 对应）。 */
const FEED_PATH = '/dsh-quake-alert/feed';
/** 本地拉取间隔：Host 每 60s 拉一次源，这里 15s 拉一次本地缓存，端到端最坏约 75s。 */
const FEED_POLL_MS = 15 * 1000;
/** 启动后首轮延迟：给插件装载、城市表与 host 侧首轮轮询让路。 */
const FEED_FIRST_DELAY_MS = 3000;
/** 游标在 localStorage 里的键（与 history / 配置同域，风格一致）。 */
const FEED_CURSOR_KEY = 'dsh.quakeAlert.feedCursor';
/** 首次启动的哨兵：还没有游标 → 用 tail 语义对齐位置而不是重放历史。 */
const FEED_TAIL = 'tail';
/**
 * 各源最近一次轮询结果的**只读快照**（id → stats）。放在模块级对象而不是 store：
 * 轮询每 15 秒一轮，若每轮都 store.push，设置页与侧边栏会被无意义地反复重渲。
 * 设置页自己定时读它（见 13-ui-settings 的「全球源状态」）。
 */
const feedStatsOf = {};
/** 本地路由的单次请求超时：Host 卡住时不能让 inFlight 一直占着、把整条轮询拖停。 */
const FEED_FETCH_TIMEOUT_MS = 10 * 1000;

/** 读回持久化游标；任何脏数据（非数字 / NaN / 负数）一律当作"没有记录"。 */
function loadFeedCursor(key) {
  const v = loadJSON(key, null);
  return (typeof v === 'number' && Number.isFinite(v) && v >= 0) ? Math.floor(v) : null
}
function saveFeedCursor(v, key) {
  if (typeof v === 'number' && Number.isFinite(v) && v >= 0) saveJSON(key, Math.floor(v));
}

async function defaultFetchJson(url, signal) {
  const AS = (typeof window !== 'undefined' && window) ? window.AbortSignal : undefined;
  const timeout = (AS && typeof AS.timeout === 'function') ? AS.timeout(FEED_FETCH_TIMEOUT_MS) : undefined;
  // 组合「请求超时」与「插件停用时中止」两个信号。AbortSignal.any 不可用时退回超时信号
  // （那一轮仍可能跑完，但下面的 stopped 检查会拦住它的 apply）。
  let sig = timeout;
  try {
    if (signal && timeout && AS && typeof AS.any === 'function') sig = AS.any([signal, timeout]);
    else if (signal) sig = signal;
  } catch (err) { sig = timeout; }
  const res = await window.fetch(url, { headers: { accept: 'application/json' }, signal: sig });
  if (!res || !res.ok) throw new Error('HTTP ' + (res ? res.status : '?'))
  return res.json()
}

/**
 * @param {object} [opts]
 * @param {string} [opts.id] 源标识（诊断用）
 * @param {string} [opts.path] Host 增量路由；全球源用 `?source=usgs` 这类分派参数
 * @param {string} [opts.cursorKey] 该源自己的游标存储键——多源共用一条键会互相顶掉游标
 * @param {(cfg: object) => boolean} [opts.enabled] 该源当前是否需要拉取（按灾种开关判断）
 * @param {number} [opts.intervalMs]
 * @param {number} [opts.firstDelayMs]
 * @param {(url: string) => Promise<object>} [opts.fetchJson] 注入点（测试用）
 * @param {(patch: object) => void} [opts.onStatus] 状态上报（0.4.1）：把本源的连接 / 失败情况
 *   送进 store，参与整体状态聚合。没有它的话轮询链路整体死掉时侧边栏仍然是绿的。
 * @param {string} [opts.label] 状态文案里的源名
 * @param {(entry: object, cfg: object) => boolean} [opts.apply] 注入点（测试用）
 * @param {() => object} [opts.getCfg] 注入点（测试用）
 * @param {() => (number|null)} [opts.loadCursor] 注入点（测试用；默认读 localStorage）
 * @param {(v: number) => void} [opts.saveCursor] 注入点（测试用；默认写 localStorage）
 * @param {(err: Error) => void} [opts.onError]
 */
function createFeedClient(opts = {}) {
  const id = opts.id || 'jma';
  const label = opts.label || id;
  const path = opts.path || FEED_PATH;
  const cursorKey = opts.cursorKey || FEED_CURSOR_KEY;
  const intervalMs = opts.intervalMs || FEED_POLL_MS;
  const firstDelayMs = opts.firstDelayMs === undefined ? FEED_FIRST_DELAY_MS : opts.firstDelayMs;
  const fetchJson = opts.fetchJson || defaultFetchJson;
  const getCfg = opts.getCfg || currentCfg;
  const onError = opts.onError || (() => {});
  const onStatus = opts.onStatus || (() => {});
  // 该源此轮要不要拉：气象源跟 weather 开关，全球地震跟 earthquake 开关，海啸跟 tsunami 开关。
  // 关掉之后 Client 不再拉增量，Host 侧对应的轮询器也会因 idle 自然停下。
  const enabled = opts.enabled || ((cfg) => (cfg.disasters || {}).weather !== false);
  const loadCursor = opts.loadCursor || (() => loadFeedCursor(cursorKey));
  const saveCursor = opts.saveCursor || ((v) => saveFeedCursor(v, cursorKey));
  const apply = opts.apply || ((entry, cfg) => {
    // 走解析契约（0.4.1）：schema / value 失败会计入数据健康并**不播报**，
    // empty（与本插件无关的电文）只是静静地跳过。
    const res = parseJmaResult(entry && entry.xml, { id: entry && entry.id });
    if (noteParseResult(id, res)) return false
    if (!res.ok) return false
    noteSourceSuccess(id);
    handleAlert(res.alert, cfg);
    return true
  });

  // null = 本浏览器还没有游标（首次启动）→ 首轮用 tail 对齐，不重放 Host 缓冲里的历史
  let since = null;
  try {
    const stored = loadCursor();
    if (typeof stored === 'number' && Number.isFinite(stored) && stored >= 0) since = Math.floor(stored);
  } catch (err) { /* 读盘失败按首次启动处理 */ }
  let timer = null;
  let running = false;
  let stopped = false; // 插件停用：在途轮询的响应回来后不该再 apply
  let inFlight = null;
  let abortCtl = null;
  let lastStatusKey = '';
  // Host 的 errors / detailDropped 是**进程内累计**计数（永不归零）。要判断"这一轮又失败了"
  // 必须看增量——直接判"非 0 就告警"会让一次瞬时失败之后该源永久停在"链路降级"（0.4.2 修正）。
  let lastHostErrors = 0;
  let lastHostDropped = 0;
  const stats = { polls: 0, received: 0, applied: 0, errors: 0, truncated: 0, tailSync: 0, resets: 0, morePages: 0, lastAt: 0, cursor: 0, host: null };

  /** 状态上报：只在**变化**时送出去（轮询每 15 秒一轮，每轮都 push 会让设置页反复重渲）。
   *  经过 effectiveStatusOf 合并"数据格式异常"——那是蓝点，优先级高于连接状态：
   *  连接好着呢、只是数据我们读不懂，这个状态不该被下一轮"拉取成功"覆盖掉。 */
  function reportStatus(patch) {
    const eff = effectiveStatusOf(id, patch.status, patch.detail);
    // key **只取状态**：detail 里含"已收到 N 条增量""Host 轮询 N 次"这类单调计数，
    // 用它做 key 会让每轮都判定为"变化"→ 每 15 秒整页重渲一次（正是拆 SourceStatusBlock
    // 想避免的事）。数字本身由 SourceStatusBlock 每 5 秒直接从 feedStatsOf 读，不依赖这里。
    //
    // 除自己上一轮报出的状态，还要比 **store 里当前实际的状态**（0.5.4）：探针（12d）、
    // 健康层（05g）与 WS 连接层（12-websocket）也会写同一个源。若它们刚把展示状态改成别的值，
    // 而这里因为"自己的 eff 没变"就不上报，那个被覆盖的状态会**永久**留在界面上
    //（实测：一条蓝点被探针的"数据已恢复"刷成绿色之后，此后再也不自愈）。
    const cur = ((store.sources || {})[id] || {}).status;
    if (eff.status === lastStatusKey && cur === eff.status) return
    lastStatusKey = eff.status;
    try { onStatus(Object.assign({ label }, eff)); } catch (err) { /* UI 回调异常不影响轮询 */ }
  }

  /** 推进游标并落盘（值没变就不写，15s 一次的轮询不必每次都碰 localStorage）。 */
  function setCursor(next) {
    if (!(typeof next === 'number' && Number.isFinite(next) && next >= 0)) return
    const v = Math.floor(next);
    if (v === since) return
    since = v;
    try { saveCursor(v); } catch (err) { /* 隐私模式等写盘失败：本次仍以内存游标工作 */ }
  }
  const cursorNow = () => (since === null ? 0 : since);

  async function pollOnce() {
    stats.polls += 1;
    // 该源的灾种开关关闭时不必拉增量（Host 侧随后也会据此停轮询）。状态如实上报为「已关闭」，
    // 这样聚合状态不会因为"用户主动关掉了"而显示成异常。
    if (!enabled(getCfg())) {
      reportStatus({ status: 'disabled', detail: '灾种开关已关闭' });
      return { applied: 0, cursor: cursorNow(), skipped: true }
    }
    let data;
    // 自持取消器（0.4.1）：插件停用时要能中止在途请求，否则响应回来后仍会 apply
    // → handleAlert → 响铃 / 弹窗 / 写历史（用户以为已经关掉了插件）。
    abortCtl = (typeof window !== 'undefined' && window && typeof window.AbortController === 'function')
      ? new window.AbortController()
      : null;
    try {
      // path 可能自带查询串（全球源用 `?source=usgs` 分派），所以要按需选分隔符。
      // stats=1（0.4.1）：把 Host 侧的健康计数一并取回（errors / detailDropped / lastPollAt /
      // idleSkips / bufferSize）。此前 Client 从不带它，于是「上游被墙 / 被限流」与「上游没有新闻」
      // 在界面上完全不可区分——设置页的「最近拉取 2 秒前」说的只是**本地路由**的拉取时刻。
      const sep = path.indexOf('?') === -1 ? '?' : '&';
      data = await fetchJson(
        path + sep + 'since=' + (since === null ? FEED_TAIL : since) + '&stats=1',
        abortCtl ? abortCtl.signal : undefined,
      );
    } catch (err) {
      // 用户主动停用（abort）不是"源不可达"：不上报 unreachable、不计失败、不写失败日志。
      // 否则停用插件会在侧边栏留下一个红点；重载时旧 fiber 的这次上报还会把新会话短暂染红。
      if (stopped) return { applied: 0, cursor: cursorNow(), aborted: true }
      stats.errors += 1;
      onError(err);
      reportStatus({ status: 'unreachable', detail: 'Host 增量路由请求失败：' + String((err && err.message) || err) });
      return { applied: 0, cursor: cursorNow() }
    } finally {
      abortCtl = null;
    }
    stats.lastAt = Date.now();
    // Host 回显的源必须与请求的一致：Host 比 Client 旧（或参数被改写）时会把 jma 的原文
    // 交给 noaa 的解析器，解析必然失败、而游标仍在推进——那些条目被永久跳过且表面正常。
    if (data && data.source && data.source !== id) {
      const err = new Error('源不匹配：请求 ' + id + '，Host 返回 ' + data.source);
      stats.errors += 1;
      onError(err);
      reportStatus({ status: 'unreachable', detail: err.message });
      return { applied: 0, cursor: cursorNow() }
    }
    if (data && data.stats) stats.host = data.stats;
    // 0.5.3（DESIGN 11.9 B）：把**源自己的数据时间**交给探针，阈值由探针从契约里取——
    // 这里只上报事实，不判 stale。
    //
    // 取 Host 的 `feedTime`（poller 从源自己的 <updated> / metadata.generated / 列表最新一条
    // 算出来的），**不是**"我们收到条目的时刻"：JMA 可能几小时只有天气预报（没有与本插件相关
    // 的电文），用收到时刻会把那种完全正常的情况判成停更。这也是契约里写明"判据不是我们收到
    // 多少条"的原因。
    if (data && data.stats && Number.isFinite(data.stats.feedTime) && data.stats.feedTime > 0) {
      noteFreshness(id, data.stats.feedTime);
    }
    // 首次对齐：Host 只回当前位置。不应用任何条目（即使响应里意外带了也不应用），
    // 否则"刷新页面"又变成了重放历史。
    if (data && data.tail === true) {
      stats.tailSync += 1;
      setCursor(data.cursor);
      stats.cursor = cursorNow();
      reportStatus({ status: 'open', detail: '已对齐当前位置 · ' + hostDetail() });
      return { applied: 0, cursor: cursorNow(), tail: true }
    }
    // 本地还没有游标、响应却没带 tail 标记 → 对面是不认 `since=tail` 的旧版 Host
    // （它按 0 把整个环缓冲吐了回来）。这是一次全新会话，取它的游标对齐即可，
    // 不能把这些历史当增量播一遍——否则"只刷新页面、不重启 Host"的升级路径会重放一次。
    // 纯 0.3.2 环境下 tail 请求必定带回 tail 标记，这个分支不会触发。
    if (since === null) {
      stats.tailSync += 1;
      if (data && Number.isFinite(data.cursor)) setCursor(data.cursor);
      stats.cursor = cursorNow();
      return { applied: 0, cursor: cursorNow(), tail: true, legacyHost: true }
    }
    const entries = Array.isArray(data && data.entries) ? data.entries : [];
    if (data && data.truncated) stats.truncated += 1;
    let applied = 0;
    let lastSeenSeq = null;
    for (const e of entries) {
      if (stopped) break // 插件已停用：剩下的条目不再处理
      stats.received += 1;
      try {
        if (apply(e, getCfg())) applied += 1;
      } catch (err) {
        // 单条电文解析失败不能影响后续条目，也不能让游标停住
        stats.errors += 1;
        onError(err);
      }
      if (e && Number.isFinite(e.seq)) lastSeenSeq = e.seq;
    }
    stats.applied += applied;
    let reset = false;
    if (data && Number.isFinite(data.cursor)) {
      // Host 重启过 → 它给的游标一定比 Client 手里的小（两侧同源，正常情况不会倒退）。
      // 以 `data.cursor < since` 为准而不是只看 reset 标记：Host 漏标记时也必须自愈，
      // 否则 Client 会卡在一个比 Host 大的游标上、entries 恒空且 truncated 不为真——静默失联。
      const regressed = since !== null && data.cursor < since;
      if (data.reset === true || regressed) {
        reset = true;
        stats.resets += 1;
      }
      // Host 会用 MAX_FEED_ENTRIES 截断大响应（本轮只给前 N 条）。此时不能直接跳到
      // data.cursor，否则那 N 条之后的条目会被静默跳过；改用**最后一条实际返回的 seq**
      // 推进，下一轮接着取。正常增量路径 entries 很短，等价于 data.cursor。
      const last = entries.length ? entries[entries.length - 1] : null;
      // 被停用打断时（stopped）只能用**已经处理到的那条**推进：直接跳到整批末条会把没处理的
      // 条目连同游标一起跳过，下次回来也补不回来（永久漏报）。一条都没处理就原地不动。
      const next = stopped
        ? (lastSeenSeq !== null ? lastSeenSeq : cursorNow())
        : (last && Number.isFinite(last.seq) ? last.seq : data.cursor);
      if (data.more === true) stats.morePages += 1;
      setCursor(next);
    }
    stats.cursor = cursorNow();
    // 增量缺口与游标重置必须**让用户看得见**：被跳过的条目是静默漏报，
    // 只进诊断计数的话用户会以为"该收到的都收到了"。
    // Host 的 errors / detailDropped 是累计计数，所以一律看**增量**（见 lastHostErrors 的说明）。
    const host = stats.host || {};
    const hostErrors = Number(host.errors) || 0;
    const hostDropped = Number(host.detailDropped) || 0;
    const errDelta = Math.max(0, hostErrors - lastHostErrors);
    const dropDelta = Math.max(0, hostDropped - lastHostDropped);
    lastHostErrors = hostErrors;
    lastHostDropped = hostDropped;
    const warn = [];
    if (data && data.truncated) warn.push('有增量缺口（Host 环缓冲已淘汰旧条目）');
    if (reset) warn.push('Host 游标重置过');
    if (errDelta) warn.push('Host 侧新增失败 ' + errDelta + ' 次');
    if (dropDelta) warn.push('Host 侧新增放弃详情 ' + dropDelta + ' 条');
    // stale 有**自己的状态**（中灰「数据已过期」），不折叠进 degraded：它表示"源在响应、
    // 但给的是旧数据"，与"链路有故障"是两类，DESIGN 的六态里也是分开的。
    reportStatus({
      status: host.stale ? 'stale' : (warn.length ? 'degraded' : 'open'),
      detail: '已收到 ' + stats.received + ' 条增量 · ' + hostDetail() +
        (host.stale ? ' · 上游数据已过期（源在响应，但数据是旧的）' : '') +
        (warn.length ? ' · ' + warn.join('；') : ''),
    });
    return { applied, cursor: cursorNow(), truncated: !!(data && data.truncated), reset, more: !!(data && data.more) }
  }

  /** 状态文案里的 Host 侧摘要：只在本源当前有问题时才值得占位置（正常时保持简短）。 */
  function hostDetail() {
    const h = stats.host;
    if (!h) return '最近拉取 ' + new Date(stats.lastAt).toLocaleTimeString()
    const errs = Number(h.errors) || 0;
    const idle = Number(h.idleSkips) || 0;
    return 'Host 轮询 ' + (Number(h.polls) || 0) + ' 次' + (errs ? '，失败 ' + errs + ' 次' : '') +
      (idle ? '，节流跳过 ' + idle + ' 次' : '')
  }

  function pollSerial() {
    if (inFlight) return inFlight
    inFlight = pollOnce().finally(() => {
      inFlight = null;
      // 给设置页的「全球源状态」留一份快照（不触发 store 重渲）
      feedStatsOf[id] = Object.assign({}, stats, { running });
    });
    return inFlight
  }

  function schedule(delay) {
    if (!running) return
    // 与其他定时器一致的纪律（0.5.4）：排新的之前先清旧的。当前控制流（回调里先 timer=null
    // 再递归，且 pollSerial 有 inFlight 守卫）保证不会双排，但少这一行就意味着"以后谁改了
    // 一处控制流，就多一条各自自续的轮询链"（= 上游请求速率翻倍）。
    if (timer) { clearTimeout(timer); timer = null; }
    timer = setTimeout(async () => {
      timer = null;
      // 灾种开关的判断放在 pollOnce 里：那里会如实上报「已关闭」状态（不产生任何网络请求），
      // 这样聚合状态不会因为"用户主动关掉了"而显示成异常。
      try { await pollSerial(); } catch (err) { onError(err); }
      schedule(intervalMs);
    }, delay);
  }

  return {
    id,
    path,
    cursorKey,
    start() {
      if (running) return
      stopped = false;
      running = true;
      schedule(firstDelayMs);
    },
    stop() {
      stopped = true;
      running = false;
      if (timer) { clearTimeout(timer); timer = null; }
      // 中止在途请求：插件停用后回来的响应不该再 apply（响铃 / 弹窗 / 写历史）
      if (abortCtl) { try { abortCtl.abort(); } catch (err) { /* 已结束等忽略 */ } abortCtl = null; }
    },
    pollOnce,
    pollSerial,
    stats() { return Object.assign({}, stats, { running }) },
    /** 测试与诊断用：当前游标（尚未对齐时为 0）。 */
    cursor() { return cursorNow() },
    /** 测试与诊断用：本客户端是否还没有游标（首轮会走 tail 对齐）。 */
    hasCursor() { return since !== null },
  }
}

// ============================================================================
// dsh-quake-alert · client/src/12c-cn-stream.js
//
// 作用：消费大陆源（Wolfx cenc_eew / cenc_eqlist）的 **SSE 推送**，解析成 Alert 后交给主链
//       ——与 P2PQuake 的 551/552/556、気象庁的电文汇到同一个 handleAlert。
// 内容：EventSource 生命周期、断线补齐（Last-Event-ID）、游标持久化、
//       **降级到轮询**（EventSource 不可用 / 连不上 / 连上但不推流）。
// 依赖：02-storage（游标落盘）、03-settings-bridge（currentCfg）、05d（解析契约与健康状态）、
//       11-pipeline（handleAlert）、12b-feed-poll（降级用的轮询客户端）。
//
// 为什么用 SSE 而不是复用 12b 的轮询：EEW 的价值在秒级。轮询是 15 秒一轮，
// 等于把"预警"变成"事后通知"——那正是这个源存在的理由（DESIGN 5.3 的三方案比较）。
//
// 为什么必须自带降级（而不是留给设计里的"降级开关"）：
//   EventSource 是浏览器原生能力，但它**可能被中间设备掐掉**（代理缓冲流式响应、重置长连接），
//   而 `/feed?source=cenc_eew` 那条普通 HTTPS 轮询往往仍然通（DESIGN 11.5）。没有自动降级的话，
//   这些网络下的用户会**静默地只收到轮询源、永远收不到大陆预警**——正是本插件最不能接受的失败形态。
//   所以这里的口径是：只要能证明"SSE 这条链路走不通"，就自动切到轮询，并且**把降级这件事说出来**
//   （状态上报成 degraded），用户与 AI 都看得见。
//   手动开关（用户强制选轮询）与只读诊断快照是 0.5.0 的后续增量。
// ============================================================================


/** Host 侧的 SSE 路由（与 lib/index.js 的 STREAM_PATH 对应）。 */
const STREAM_PATH = '/dsh-quake-alert/stream';
/** 每个源自己的游标键前缀（与 12b 的 FEED_CURSOR_KEY 同域、风格一致）。 */
const CN_CURSOR_KEY = 'dsh.quakeAlert.streamCursor';
/**
 * 连上之后多久没收到首帧 `sync` 就判定"这条流不通"。
 * 首帧是 Host 立刻写出的，正常情况几十毫秒就到；8 秒足够覆盖慢机器，
 * 又远小于"用户会以为插件坏了"的心理阈值。
 */
const SSE_PROBE_MS = 8000;
/** 连续失败到这个次数就降级到轮询。取 3：容忍一次网络抖动与一次 Host 重启。 */
const SSE_MAX_FAILS = 3;
/** 降级/停用期间的重探间隔：用户重新打开灾种开关后要能回来。 */
const CN_RECHECK_MS = 5000;

/** 读回持久化游标；任何脏数据一律当作"没有记录"。 */
function loadCursorOf(key) {
  const v = loadJSON(key, null);
  return (typeof v === 'number' && Number.isFinite(v) && v >= 0) ? Math.floor(v) : null
}
function saveCursorOf(key, v) {
  if (typeof v === 'number' && Number.isFinite(v) && v >= 0) saveJSON(key, Math.floor(v));
}

/**
 * @param {object} opts
 * @param {string} opts.id 源标识（`cenc_eew` / `cenc_eqlist`）
 * @param {string} [opts.label] 状态文案里的源名
 * @param {string} [opts.path] SSE 路由（含 `?source=`）
 * @param {(entry: object, cfg: object) => boolean} [opts.apply] 逐条应用（15-entry 注入解析契约）
 * @param {(cfg: object) => boolean} [opts.enabled] 该源当前是否需要消费（按灾种开关判断）
 * @param {(patch: object) => void} [opts.onStatus] 状态上报
 * @param {(err: Error) => void} [opts.onError]
 * @param {(url: string) => object} [opts.createEventSource] 注入点（测试用）
 * @param {() => object} [opts.createFallback] 降级客户端工厂（测试用；默认建一个 12b 的轮询客户端）
 * @param {() => object} [opts.getCfg]
 * @param {() => object} [opts.loadCursor] / @param {(v: number) => void} [opts.saveCursor]
 * @param {number} [opts.probeMs] / @param {number} [opts.maxFails]
 */
function createCnStream(opts = {}) {
  const id = opts.id;
  const label = opts.label || id;
  const path = opts.path || (STREAM_PATH + '?source=' + id);
  const cursorKey = opts.cursorKey || (CN_CURSOR_KEY + '.' + id);
  const getCfg = opts.getCfg || currentCfg;
  const onError = opts.onError || (() => {});
  const onStatus = opts.onStatus || (() => {});
  const apply = opts.apply || (() => false);
  const enabled = opts.enabled || (() => true);
  const probeMs = opts.probeMs === undefined ? SSE_PROBE_MS : opts.probeMs;
  const maxFails = opts.maxFails === undefined ? SSE_MAX_FAILS : opts.maxFails;
  const loadCursor = opts.loadCursor || (() => loadCursorOf(cursorKey));
  const saveCursor = opts.saveCursor || ((v) => saveCursorOf(cursorKey, v));
  const createEventSource = opts.createEventSource
    || ((url) => new window.EventSource(url));
  // 定时器注入点：探针超时与周期检查都靠它，测试要能确定性地推进（不真等 8 秒 / 5 秒）
  const setTimer = opts.setTimer || ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = opts.clearTimer || ((t) => clearTimeout(t));
  // 降级工厂：默认按 12b 的轮询客户端建一个（`?source=` 分派，Host 侧早就支持）。
  // createFeedClient 也可注入：这样"降级客户端拿了哪个游标键"能被直接断言——那正是
  // "降级期间静默漏掉一段条目"的成因，光看 mode 有没有变成 poll 是测不出来的。
  const makeFeedClient = opts.createFeedClient || createFeedClient;
  const createFallback = opts.createFallback || (() => makeFeedClient({
    id,
    label,
    path: FEED_PATH + '?source=' + id,
    // 与 SSE 用**同一个**游标键：两侧的 seq 都来自 Host 同一个源的游标，所以降级时能无缝接续。
    // 用各自独立的键（原先的 FEED_CURSOR_KEY）会让轮询从 `since=tail` 起步，SSE 挂掉到降级生效
    // 之间 Host 缓冲里的条目被静默跳过——那是一个真实的漏报窗口。
    cursorKey: CN_CURSOR_KEY + '.' + id,
    enabled,
    // 不是 onStatus：降级态下轮询侧的 "open" 会把"已降级"盖掉，必须合成一条（见 fallbackStatus）。
    onStatus: fallbackStatus,
    onError,
    apply,
  }));

  let since = null;
  try {
    const stored = loadCursor();
    if (typeof stored === 'number' && Number.isFinite(stored) && stored >= 0) since = Math.floor(stored);
  } catch (err) { /* 读盘失败按首次启动处理 */ }

  let running = false;
  let source = null; // EventSource 实例
  let probeTimer = null;
  let tickTimer = null;
  let fallbackClient = null;
  let mode = 'idle'; // idle | sse | poll | disabled
  let consecutiveFails = 0;
  let sawSyncThisConn = false;
  let lastStatusKey = '';
  let inFallback = false;
  /** 当前的轮询是"用户选的"还是"自动降级来的"——只有前者能自动升回 SSE。 */
  let fallbackManual = false;
  const stats = {
    mode: 'idle', connections: 0, syncs: 0, received: 0, applied: 0, errors: 0,
    sseErrors: 0, probeTimeouts: 0, fallbacks: 0, fallbackManual: false, truncated: 0, resets: 0,
    // stale（源可达但数据是旧的）：由 Host 的 sync / status 帧告知，Client 自己判不出来
    // ——"没有新 entry"与"这几天确实没有地震"在本地长得一模一样。
    stale: false, dataTime: 0,
    lastAt: 0, lastEventAt: 0, cursor: 0, frozen: false, lastDetail: '',
  };

  /** 用户在设置页选了「强制轮询」（`cnTransport: 'poll'`）？默认 'auto'。 */
  const wantPoll = (cfg) => String((cfg && cfg.cnTransport) || 'auto') === 'poll';

  const cursorNow = () => (since === null ? 0 : since);
  // 注册到表里（实时读取，见 cnStreamRegistry 的说明）
  cnStreamRegistry[id] = {
    stats: () => Object.assign({}, stats, { running, hasCursor: since !== null, fallbackActive: inFallback }),
    mode: () => mode,
  };
  /**
   * @param {number} next
   * @param {boolean} [force] Host 明确说"游标重置过"（它重启 / 时钟回拨）时**必须允许回退**，
   *   否则本地游标永远卡在一个比 Host 大的值上，之后每次重连都触发 reset + 全量重放。
   *   12b 的轮询路径有等价的自愈（`regressed`），SSE 这条此前缺失（0.5.1 review 的 D 类残留）。
   */
  function setCursor(next, force) {
    if (!(typeof next === 'number' && Number.isFinite(next) && next >= 0)) return
    const v = Math.floor(next);
    if (v === since) return
    // 游标只前进：SSE 的补发与实况可能交错到达，回退会让"断线补齐"重复投递
    if (!force && since !== null && v < since) return
    since = v;
    stats.cursor = v;
    try { saveCursor(v); } catch (err) { /* 隐私模式等写盘失败：本次仍以内存游标工作 */ }
  }

  /**
   * 状态上报。`k` 是去重键，**不取 detail**：detail 里含"已收到 N 条"这类单调计数，
   * 用它做键会每轮都判定为"变化"→ 设置页反复重渲。
   * 但键也不能只取 status：降级（degraded）与"出错但正在自动重连"是同一个 status，
   * 却是完全不同的两件事——后者能自己恢复，前者意味着链路已经变了、必须让用户知道。
   * 所以由调用方给一个稳定的**语义**键，默认退回 status。
   */
  function reportStatus(patch, k) {
    stats.lastDetail = String(patch.detail || '');
    const eff = effectiveStatusOf(id, patch.status, patch.detail);
    const key = k || eff.status;
    // 除自己的去重键，还要比 **store 里当前实际的状态**（0.5.4）：探针（12d）、健康层（05g）
    // 与 WS 连接层会写同一个源；若它们刚把展示状态改成别的值，而这里因为"自己的键没变"就
    // 不上报，那个被覆盖的状态会永久留在界面上（12b 侧同款修正，理由见 12b-feed-poll.js）。
    const cur = ((store.sources || {})[id] || {}).status;
    if (key === lastStatusKey && cur === eff.status) return
    lastStatusKey = key;
    try { onStatus(Object.assign({ label }, eff)); } catch (err) { /* UI 回调异常不影响链路 */ }
  }

  /**
   * 降级态下，轮询客户端（12b）的上报要经过这一层再出去。
   *
   * 为什么必须包一层：12b 的客户端有**自己独立的**状态去重键（初值空），所以降级之后它第一次
   * 成功轮询就会报一条 `open`——"轮询这条路通了"本身是真的，但它会把 12c 刚报出去的
   * "已降级为轮询"整条覆盖掉：聚合状态回绿、侧边栏悬停详情里只剩正常源。而 DESIGN 11.5 要求
   * 降级**必须让用户看见**（它意味着延迟从秒级变成最长 15 秒）。
   * 处理方式是把两者**合并成一条**：状态取"降级"（或用户手动选择），细节把轮询侧的信息附上。
   * 键带上轮询侧的状态，这样它自己从 open 变 degraded / schema-error 时仍会重新上报。
   */
  function fallbackStatus(patch) {
    if (!inFallback) return
    const p = patch || {};
    reportStatus({
      status: fallbackManual ? 'disabled' : 'degraded',
      detail: (fallbackManual ? '已按设置选择轮询' : 'SSE 推送不可用 → 已降级为轮询') +
        '（延迟最长 15 秒）' + (p.detail ? ' · ' + String(p.detail) : ''),
    }, 'fallback:' + String(p.status || ''));
  }

  function closeSource() {
    if (probeTimer) { clearTimer(probeTimer); probeTimer = null; }
    const s = source;
    source = null;
    if (s) {
      try { s.onerror = null; s.onmessage = null; } catch (err) { /* 忽略 */ }
      try { s.close(); } catch (err) { /* 已关闭 */ }
    }
  }

  /**
   * 切到轮询。
   * @param {string} reason 人话原因（会出现在状态里，所以要说清是"哪条链路不行了"）
   * @param {boolean} [manual] true = 用户在设置页选了「强制轮询」，false/缺省 = 自动降级。
   *   区别只在能不能自动升回 SSE：自动降级不再升回（链路既然证明过不通，反复试探只是抖动），
   *   而**手动**选择是可以撤销的——用户改回「自动」就该回到 SSE。
   */
  function activateFallback(reason, manual) {
    if (inFallback) return
    // **先建客户端，成功之后才置位**（0.5.4）。原来的顺序是 `inFallback = true` → `mode='poll'`
    // → `closeSource()` → 建客户端，而建失败时直接 return：于是 inFallback 锁死、SSE 已关、
    // fallbackClient 仍是 null，tick 的四条分支没有一条能再建起链路（只有刷新页面），
    // 而设置页与诊断显示的是"已降级为轮询"——用户以为在被保护，实际一条预警都收不到。
    // 这恰是本文件头写明的、最不能接受的那种形态。
    let client = null;
    try {
      client = createFallback();
    } catch (err) {
      onError(err);
      // 回滚到 idle 并如实上报。此后：用户显式选了「强制轮询」时 tick 会每 5 秒重试一次；
      // 自动降级来的（wantPoll 为假）不再重试——SSE 已经证明不通、轮询客户端又建不起来，
      // 此时显示"无法连接"就是全部能做的，继续静默地假装已降级才是错的。
      inFallback = false;
      fallbackManual = false;
      mode = 'idle';
      stats.mode = mode;
      reportStatus({ status: 'unreachable', detail: '降级到轮询时建立客户端失败：' + String((err && err.message) || err) });
      return
    }
    inFallback = true;
    fallbackManual = manual === true;
    stats.fallbacks += 1;
    stats.fallbackManual = fallbackManual;
    mode = 'poll';
    stats.mode = mode;
    closeSource();
    fallbackClient = client;
    try { fallbackClient.start(); } catch (err) { onError(err); }
    // 降级必须**说出来**：否则用户看到"一切正常"却收不到预警（本插件最不能接受的形态）。
    // 去重键显式给 'fallback'：进入降级之前刚上报过 degraded（"出错、正在重连"）是同一个
    // status，若按 status 去重，这条"已降级"会被自己的上一条吃掉——而降级是不能被静默的。
    reportStatus({
      status: fallbackManual ? 'disabled' : 'degraded',
      detail: (fallbackManual ? '已按设置选择轮询' : 'SSE 推送不可用（' + reason + '）→ 已降级为轮询') +
        '（延迟从秒级变为最长 15 秒）',
    }, 'fallback');
  }

  /** 从轮询升回 SSE（只有**手动**选的轮询会被自动升回）。 */
  function leaveFallback() {
    if (!inFallback) return
    inFallback = false;
    fallbackManual = false;
    if (fallbackClient) { try { fallbackClient.stop(); } catch (err) { /* 忽略 */ } }
    fallbackClient = null;
    mode = 'idle';
    stats.mode = mode;
    consecutiveFails = 0;
    connectSse();
  }

  /**
   * 单一的周期检查（每 5 秒）。用**一个**定时器同时管三个方向，因为它们会互相打架：
   *   · 灾种开关被关掉 → 主动断开 SSE（不再读 `/stream`，Host 侧十分钟后自然断开与 Wolfx 的连接）
   *   · 灾种开关又打开 → 恢复消费
   *   · 设置页的「链路」选择变了 → 强制轮询 ↔ 自动（手动选择的可以撤销，自动降级的不再升回）
   * 分成多个定时器容易写出"关掉之后再也回不来"这种半途状态。
   */
  function scheduleTick() {
    if (!running) return
    if (tickTimer) { clearTimer(tickTimer); tickTimer = null; }
    tickTimer = setTimer(() => {
      tickTimer = null;
      if (!running) return
      // 整段兜错：这个 tick 是**唯一**的恢复链（灾种开关往返、手动 / 自动链路切换都靠它），
      // 一次抛错就会让它不再 self-reschedule，之后所有恢复都失效。12b 的等价处（schedule）
      // 也包了 try/catch。reschedule 放在 catch 之外，保证无论成败都会重排。
      try {
        const cfg = getCfg();
        const on = enabled(cfg);
        if (!on) {
          if (mode !== 'disabled') enterDisabled();
        } else if (mode === 'disabled') {
          consecutiveFails = 0;
          // 恢复消费时**同样要先看用户的链路选择**：选了「强制轮询」就不该先建一条 SSE
          //（那既白占一条 Wolfx 连接，又会在 8 秒探针超时后谎报一次"连上但不推流"）。
          // 这与 start() 里"一开始就不建 SSE"是同一个不变量。
          if (wantPoll(cfg)) activateFallback('设置里选择了强制轮询', true);
          else connectSse();
        } else if (wantPoll(cfg)) {
          // 用户选了「强制轮询」。**已经在轮询（自动降级来的）时也要认下这个选择**：
          // 否则 fallbackManual 永远是 false，用户之后改回「自动」时下面那条 leaveFallback
          // 分支不成立 → 永久停在轮询，只能刷新页面才回得去。
          if (!inFallback) activateFallback('设置里选择了强制轮询', true);
          else if (!fallbackManual) {
            fallbackManual = true;
            stats.fallbackManual = true;
            reportStatus({ status: 'disabled', detail: '已按设置选择轮询（延迟最长 15 秒）' }, 'fallback:manual');
          }
        } else if (inFallback && fallbackManual) {
          // 用户改回「自动」：手动选的轮询要能撤销。自动降级的不升回——那条链路已经证明过不通。
          leaveFallback();
        }
      } catch (err) { onError(err); }
      scheduleTick();
    }, CN_RECHECK_MS);
    if (tickTimer && typeof tickTimer.unref === 'function') tickTimer.unref();
  }

  function connectSse() {
    if (!running || source) return
    sawSyncThisConn = false;
    stats.connections += 1;
    const url = path + (path.indexOf('?') === -1 ? '?' : '&') +
      // 页面首次建立连接时带上持久化游标：刷新 / 重开标签页都能补齐断线期间的事件。
      // 之后浏览器自动重连时会带 `Last-Event-ID`，Host 优先用它（更准）。
      'since=' + (since === null ? 'tail' : since);
    let es;
    try {
      es = createEventSource(url);
    } catch (err) {
      onError(err);
      consecutiveFails += 1;
      reportStatus({ status: 'unreachable', detail: 'EventSource 建立失败：' + String((err && err.message) || err) });
      return activateFallback('EventSource 建立失败')
    }
    if (!es || typeof es.addEventListener !== 'function') {
      consecutiveFails += 1;
      reportStatus({ status: 'unreachable', detail: '当前环境没有可用的 EventSource' });
      return activateFallback('当前环境不支持 EventSource')
    }
    source = es;
    mode = 'sse';
    stats.mode = mode;
    /**
     * sync 帧算出的告警（增量缺口 / 游标重置 / Host 侧未在运行）。
     *
     * **必须留到 status 帧继续带上**：store.pushSource 是整体替换 status + detail 的，而 status 帧
     * 每 15 秒就来一次；若它只报"已连接"，这三条"有消息被跳过""Host 那边没在跑"的告警会在 15 秒后
     * 自己消失——而它们的条件其实仍然成立。（键相同则不会重新上报，所以正常的降级/恢复去重不受影响。）
     */
    let connWarn = [];
    const onSync = (ev) => {
      if (source !== es) return
      sawSyncThisConn = true;
      consecutiveFails = 0;
      stats.syncs += 1;
      stats.lastAt = Date.now();
      let d = null;
      try { d = JSON.parse(String(ev && ev.data)); } catch (err) { d = null; }
      if (d && d.truncated) stats.truncated += 1;
      if (d && d.reset) stats.resets += 1;
      stats.frozen = !!(d && d.frozen);
      stats.stale = !!(d && d.stale);
      if (d && Number.isFinite(d.dataTime)) stats.dataTime = d.dataTime;
      // 0.5.3（DESIGN 11.9 B）：同一个数据时间也交给探针——探针按**契约里的阈值**判，
      // 而 Host 这一侧继续按它自己的常量判（它能分辨"中继停更"与"数据陈旧"，比我们准）。
      // 两者用的是同一个数值，一致性由回归断言钉住，不靠"记得同时改两处"。
      if (d && Number.isFinite(d.dataTime) && d.dataTime > 0) noteFreshness(id, d.dataTime);
      // Host 明确说重置过（它重启 / 时钟回拨）→ **允许游标回退**并对齐到它的当前位置，
      // 否则本地游标卡在比 Host 大的值上，每次重连都会 reset + 全量重放。
      // 没有补发条目 = 已经在线，游标就是 Host 的当前位置 → 同样对齐，
      // 这样刷新页面不会重复拉一段已经消费过的增量。
      if (d && d.reset && Number.isFinite(d.cursor)) setCursor(d.cursor, true);
      else if (d && Number.isFinite(d.cursor) && (!d.replayed || d.replayed === 0)) setCursor(d.cursor);
      const warn = [];
      if (d && d.truncated) warn.push('有增量缺口（Host 环缓冲已淘汰旧条目）');
      if (d && d.reset) warn.push('Host 游标重置过');
      if (d && d.frozen) warn.push('Host 侧该源未在运行');
      connWarn = warn;
      // stale 有**自己的状态**（中灰「数据已过期」），不折叠进 degraded：它表示"源在响应、
      // 但给的是旧数据"，与"链路有故障"是两类。口径与 12b 的轮询路径一致。
      reportStatus({
        status: stats.stale ? 'stale' : (warn.length ? 'degraded' : 'open'),
        detail: 'SSE 已连接' + (d ? '（补发 ' + (d.replayed || 0) + ' 条）' : '') +
          ' · 已收到 ' + stats.received + ' 条' +
          (stats.stale ? ' · 上游数据已过期（中继停更）' : '') +
          (warn.length ? ' · ' + warn.join('；') : ''),
      });
    };
    /**
     * Host 的周期状态帧（每 15 秒，兼作 SSE keep-alive）。
     *
     * 它存在的唯一理由是**停更**：停更的形态就是"不再有新 entry"，只看 entry 的话状态会永远
     * 停在连接那一刻；而 48 小时的停更探针是 cenc_eqlist 这个源存在的意义之一（见契约里的
     * staleReason）。Host 不推这一帧的话，默认（SSE）路径下这件事在界面上完全不可见——
     * 只有降级到轮询之后才读得到 /feed 的 stats。
     */
    const onStatusFrame = (ev) => {
      if (source !== es) return
      let d = null;
      try { d = JSON.parse(String(ev && ev.data)); } catch (err) { d = null; }
      if (!d || typeof d !== 'object') return
      stats.stale = d.stale === true;
      if (Number.isFinite(d.dataTime)) stats.dataTime = d.dataTime;
      if (Number.isFinite(d.dataTime) && d.dataTime > 0) noteFreshness(id, d.dataTime);
      // 有意**不更新** stats.lastAt：它表示"最近一条数据"，而状态帧每 15 秒必到一次，
      // 更新它会让设置页永远显示"最近数据 0 秒前"，恰好把"其实很久没有数据了"盖掉。
      // 状态里同时带上 sync 那一刻算出的 connected 告警（见 connWarn）：只报"已连接"会把
      // 增量缺口 / 游标重置 / Host 未运行这三条在 15 秒后抹掉，而它们的条件仍然成立。
      reportStatus({
        status: stats.stale ? 'stale' : (connWarn.length ? 'degraded' : 'open'),
        detail: 'SSE 已连接 · 已收到 ' + stats.received + ' 条' +
          (stats.stale ? ' · 上游数据已过期（中继停更）' : '') +
          (connWarn.length ? ' · ' + connWarn.join('；') : ''),
      });
    };
    const onEntry = (ev) => {
      if (source !== es) return
      // 收到真实数据即证明这条链路是通的（0.5.4）：这个计数同时被"连续 N 次没收到首帧"的
      // 降级判定使用，而它此前只在 `sync` 帧归零。于是一条已经健康跑了很久的连接上零星累积的
      // error 会留在计数里，下一次"连上但没首帧"的第一跳就可能直接 ≥ maxFails ——
      // 降级理由写成"连续 N 次未收到首帧"，而实际只失败了一次。
      consecutiveFails = 0;
      stats.lastAt = Date.now();
      stats.lastEventAt = Date.now();
      let entry = null;
      try { entry = JSON.parse(String(ev && ev.data)); } catch (err) { entry = null; }
      if (!entry || typeof entry !== 'object') {
        stats.errors += 1;
        noteParseResult(id, failResult('schema', 'SSE 帧不是合法 JSON'));
        return
      }
      stats.received += 1;
      if (Number.isFinite(entry.seq)) setCursor(entry.seq);
      try {
        if (apply(entry, getCfg())) stats.applied += 1;
      } catch (err) {
        // 单条事件解析失败不能影响后续条目，也不能让游标停住
        stats.errors += 1;
        onError(err);
      }
    };
    const onErrorEv = (ev) => {
      if (source !== es) return
      stats.sseErrors += 1;
      stats.errors += 1;
      consecutiveFails += 1;
      // EventSource 自己会按 readyState 重连；这里只负责"什么时候判定这条路走不通"。
      // 已经收到过 sync 的连接再出错，多半是网络抖动或 Host 重启，交给浏览器重连；
      // 一次 sync 都没收到就说明这条流从来没通过。
      reportStatus({
        status: 'degraded',
        detail: 'SSE 连接中断（第 ' + consecutiveFails + ' 次）' + (sawSyncThisConn ? '，正在自动重连' : ''),
      });
      if (!sawSyncThisConn && consecutiveFails >= maxFails) activateFallback('连续 ' + consecutiveFails + ' 次未收到首帧');
    };
    try {
      es.addEventListener('sync', onSync);
      es.addEventListener('entry', onEntry);
      es.addEventListener('error', onErrorEv);
    } catch (err) { /* 极简实现可能不支持命名事件，下面由 probe 兜住 */ }
    // status 与上面分开注册：它是最可有可无的一帧（少了它只是看不到"停更"这一种状态），
    // 不该因为某个实现不认这个事件名而把 sync / entry 的注册一起带走。
    try { es.addEventListener('status', onStatusFrame); } catch (err) { /* 忽略 */ }
    // 首帧探针：连上但**不推流**（代理把流缓冲住了）与"连不上"是两回事，
    // 而 onerror 未必会来。没有这个探针，用户会停在"SSE 已连接"却永远收不到预警。
    if (probeMs > 0) {
      probeTimer = setTimer(() => {
        probeTimer = null;
        if (!running || source !== es || sawSyncThisConn) return
        stats.probeTimeouts += 1;
        consecutiveFails += 1;
        closeSource();
        reportStatus({ status: 'degraded', detail: 'SSE 连上但 ' + probeMs + 'ms 内没有收到任何数据（可能被代理缓冲）' });
        if (consecutiveFails >= maxFails) activateFallback('连上但不推流');
        else connectSse();
      }, probeMs);
      // 与 tickTimer 一致地 unref：这个 8 秒探针不该把 Node 侧的测试进程拖住。
      if (probeTimer && typeof probeTimer.unref === 'function') probeTimer.unref();
    }
  }

  function enterDisabled(patch) {
    mode = 'disabled';
    stats.mode = mode;
    closeSource();
    // 停用轮询降级端：它在跑的话也会一直拉
    if (fallbackClient) { try { fallbackClient.stop(); } catch (err) { /* 忽略 */ } fallbackClient = null; }
    inFallback = false;
    reportStatus({ status: 'disabled', detail: '灾种开关已关闭' });
    // 关掉灾种开关 → 不再读 `/feed` 与 `/stream` → Host 侧 10 分钟后自然断开与 Wolfx 的连接
  }

  return {
    id,
    label,
    path,
    start() {
      if (running) return
      running = true;
      stats.cursor = cursorNow();
      scheduleTick();
      const cfg = getCfg();
      if (!enabled(cfg)) { enterDisabled(); return }
      // 用户选了「强制轮询」→ 一开始就不建 SSE（也不必先连一次再切，那会白占一条 Wolfx 连接）
      if (wantPoll(cfg)) { activateFallback('设置里选择了强制轮询', true); return }
      connectSse();
    },
    stop() {
      running = false;
      closeSource();
      if (tickTimer) { clearTimer(tickTimer); tickTimer = null; }
      if (fallbackClient) { try { fallbackClient.stop(); } catch (err) { /* 忽略 */ } }
      fallbackClient = null;
      inFallback = false;
      fallbackManual = false;
      mode = 'idle';
      stats.mode = mode;
    },
    /** 测试与诊断：当前处于哪条链路。 */
    modeOf() { return mode },
    /** 测试与诊断：当前轮询是用户选的还是自动降级来的。 */
    fallbackIsManual() { return fallbackManual },
    stats() {
      return Object.assign({}, stats, {
        running, hasCursor: since !== null, fallbackActive: inFallback, fallbackManual,
      })
    },
    cursor() { return cursorNow() },
    hasCursor() { return since !== null },
  }
}

/**
 * 大陆源客户端的注册表（id → { stats, mode }），供设置页与诊断快照**实时**读取。
 *
 * 为什么不做成"每隔 N 秒把 stats 拷进一个普通对象"：设置页与其它的源状态块已经是
 * "按需读实时计数"的形态（见 12b 的 feedStatsOf 说明），拷贝出来的快照会滞后一轮，
 * 而这里恰恰要靠计数判断"是不是根本没在收数据"。
 */
const cnStreamRegistry = {};

// ============================================================================
// dsh-quake-alert · client/src/12d-health-probe.js
//
// 作用：**机制层**的探针调度（0.5.3 / DESIGN 11.9 B）。
// 内容：一个定时器，按 `SOURCE_CONTRACTS[*].staleAfterMs` 判定每个源的新鲜度，
//       并顺带驱动蓝点的 TTL 自愈（`pruneHealth`）。
// 依赖：05d（契约声明）、05g（健康记录）、07-store（状态上报）。
//
// ---------------------------------------------------------------------------
// 这个文件存在的唯一理由：**让契约里的阈值从"文档"变成"开关"**。
//
// 0.5.3 开工前 grep 的结论：`SOURCE_CONTRACTS[*].staleAfterMs`（8 个源）在整个代码库里
// **没有任何读取点**。阈值实际散在四处硬编码 —— lib/index.js 的 feedStaleMs（jma 3h /
// usgs 30min / nmc 3h）、lib/wolfx-source.js 的 preset（速报 48h）、15-entry 传给
// 12-websocket 的 staleAfterMs（emsc 3h）、以及 12c 对 SSE status 帧的直通。
// 后果是：改契约里的数字，行为一点不变；而"某个源的阈值到底是多少"要翻四个文件才对得上。
//
// 现在：**探针是唯一的判定者，契约是唯一的阈值来源**。各源只上报"我最后一次拿到数据的
// 时刻"（`noteFreshness`），不再自己判 stale。
//
// ---------------------------------------------------------------------------
// 两个刻意的例外（不统一是为了不把事情做坏）
//
// ① **`staleAfterMs: null` 的源不判**（P2PQuake / EMSC / cenc_eew）。推送源没有"数据新鲜度"
//    这个概念——日本可能数小时没有有感地震，而连接是好的。它们的活性由连接层负责
//    （建连看门狗 + 半开检测），契约里的 `staleReason` 已经写明了这一点。探针读到 null 就跳过。
// ② **Host 侧保留自己的常量**。`lib/` 不能 import Client 的契约（两个半边是分开构建的），
//    所以 Host 的 `feedStaleMs` 仍然存在。两边的一致性由**回归断言**守护
//    （`SOURCE_CONTRACTS[src].staleAfterMs === Host 侧同名常量`），而不是靠"记得同时改两处"。
//
// 明确不做：不在探针里发起任何外部请求。它只读已经存在的数据时间——源到不了的时候，
// "最后数据时间"自然就旧了，不需要另外去探（多一条外部请求路径就多一个要处理的失败形态）。
// ============================================================================


/**
 * 探针周期。30 秒的依据：最短的阈值是 USGS 的 30 分钟，30 秒的分辨率足以让"刚过期"和
 * "过期半小时"在 UI 上的差别不值得更细；而它足够轻（只遍历 8 条记录、不发请求）。
 */
const PROBE_INTERVAL_MS = 30 * 1000;

/**
 * 取某个源的新鲜度阈值（毫秒）；`null` / 非正数表示"这条链路不判新鲜度"。
 *
 * 抽成导出函数是为了让"声明生效"这件事可以被直接断言：测试里把契约的字段改成 1 分钟，
 * 探针的行为必须跟着变——那就证明阈值真的来自契约，而不是某个硬编码。
 * @param {string} sourceId
 */
function staleAfterOf(sourceId) {
  const c = SOURCE_CONTRACTS[sourceId];
  if (!c) return 0
  const v = c.staleAfterMs;
  return (typeof v === 'number' && Number.isFinite(v) && v > 0) ? v : 0
}

/** 毫秒 → 中文可读（诊断与状态行用）。 */
function humanMinutes(ms) {
  const m = Math.round(ms / 60000);
  if (m < 60) return m + ' 分钟'
  return (Math.round(m / 6) / 10) + ' 小时'
}

/**
 * 建一个探针。定时器与 pushSource 都可注入（测试用假时钟直接调 `tick()`，不等真实定时器）。
 *
 * @param {object} [opts]
 * @param {() => number} [opts.now]
 * @param {number} [opts.intervalMs]
 * @param {(fn: Function, ms: number) => any} [opts.setTimer]
 * @param {(t: any) => void} [opts.clearTimer]
 * @param {(id: string, patch: object) => void} [opts.pushSource] 注入点（测试用）。**默认不走它**：
 *   生产路径必须经 `publishStatus` 合成（见下），注入时保持"原样推送"以便断言原始 patch。
 */
function createHealthProbe(opts = {}) {
  const now = opts.now || (() => Date.now());
  const intervalMs = opts.intervalMs === undefined ? PROBE_INTERVAL_MS : opts.intervalMs;
  const setTimer = opts.setTimer || ((fn, ms) => setInterval(fn, ms));
  const clearTimer = opts.clearTimer || ((t) => clearInterval(t));
  // 默认经 publishStatus（0.5.4）：探针报的是**新鲜度**这一层，而展示状态要把它与连接层、
  // 数据健康层合成。此前直接 pushSource，于是"数据已恢复更新"这一句会把一条 schema-error
  // 蓝点整个刷掉，而 health 里 escalated 仍为 true —— 用户再也看不到"上游改版"的信号。
  const push = opts.pushSource || ((id, patch) => publishStatus(id, patch));
  let timer = null;

  /**
   * 跑一轮：先做 TTL 自愈，再逐源判新鲜度。
   *
   * `dataTime` 从未上报（值为 0）时**不判**——"不知道数据什么时候来的"不等于"数据是旧的"，
   * 把它当成 stale 会在每个源刚启动的头几秒里闪一片中灰。
   */
  function tick() {
    const t = now();
    pruneHealth(t);
    for (const id of Object.keys(SOURCE_CONTRACTS)) {
      const after = staleAfterOf(id);
      if (after <= 0) continue
      const rec = sourceHealthOf(id);
      const dataTime = rec && rec.fresh && Number.isFinite(rec.fresh.dataTime) ? rec.fresh.dataTime : 0;
      if (!(dataTime > 0)) continue
      const stale = (t - dataTime) > after;
      const was = !!(rec && rec.fresh && rec.fresh.stale);
      noteStale(id, stale, t);
      if (stale !== was) {
        // 只在**翻转**的那一刻上报：状态没变时每次 push 都会让设置页与状态点重渲一遍。
        // 恢复时给的是 `open`，而源自己的连接状态可能是 reconnecting —— 那由源的下一次
        // 上报（feed 源 15 秒一轮）纠正。用 05g 记录的连接状态去猜反而会引入两份真相。
        push(id, stale
          ? { status: 'stale', detail: '上游数据已过期（超过 ' + humanMinutes(after) + ' 没有新数据）' }
          : { status: 'open', detail: '数据已恢复更新' });
      }
    }
    return t
  }

  return {
    intervalMs,
    tick,
    start() {
      if (timer) return
      timer = setTimer(tick, intervalMs);
      if (timer && typeof timer.unref === 'function') timer.unref();
    },
    stop() {
      if (timer) { clearTimer(timer); timer = null; }
    },
  }
}

// ============================================================================
// dsh-quake-alert · client/src/12e-overseas-poll.js
//
// 作用：海外气象源（美国 NWS / 加拿大 ECCC）的**取数器**——按关注点查询外部 REST，
//       逐条交给解析契约，命中门槛的交给主链。设计与实测依据见 DESIGN 4.7。
// 依赖：02-storage（own）、03-settings-bridge（currentCfg）、05d（契约包装）、
//       05g（健康）、07-store（读当前状态）、11-pipeline（handleAlert）。
//
// 为什么是 Client 直连、而不是像 JMA / nmc 那样走 Host（DESIGN 4.7.1）：
//   ① 两个源都返回 `Access-Control-Allow-Origin: *`，浏览器可直连；
//   ② **只有"按关注点查询"才可用**——全量分别是 1.2GB/天（NWS）与 144MB/天（ECCC），
//      而 Host 的既有纪律是"不知道 Client 配置、靠 idleMs 自然停下"，它拿不到关注点；
//   ③ NWS 官方"必须带 User-Agent 标识应用"实测不阻断浏览器（带 Chrome UA 与不带 UA 都 200）。
//
// 两个源的取数语义**刻意不统一**（DESIGN 4.7.2），因为它们的能力本来就不同：
//   · NWS 只支持按点查（`?point=`），它返回的是"该点所在县 / 区划"的预警，**不做半径扩张**。
//     所以半径 ≥ 25km 时补 4 个方位采样点——注意这是**近似**（100km 内可能有十几个县），
//     设置页文案必须如实说明。半径 < 25km 只查中心点：NWS 的县通常比它大，采样点会落进同一个县。
//   · ECCC 的 OGC API 支持 `bbox`，于是半径**直接参与**查询；语义是"与这个矩形相交"（比圆略宽），
//     方向是多报不漏报（DESIGN 3.2），可以接受。
//
// 三个共同的纪律（与 12b / 12c / 12-websocket 一致）：
//   · **每轮读一次配置**（getCfg）：关注点变了下一轮就生效，不需要重建取数器；
//   · **串行请求**：对上游礼貌（DESIGN 4.2 对 JMA 定的口径，这里沿用）；
//   · **排新定时器前先清旧的**（0.5.4 对 12b 的修正）：少这一行就意味着以后谁改了一处控制流
//     就多一条自续的轮询链。
//
// 一个刻意的取舍（DESIGN 4.7.7 第 2 条）：`staleAfterMs` 是 null，本模块**不判停更**，
// 因为按点 / 框查询天然可能是空响应。活性只由"请求是否成功"表达。
// ============================================================================


/** NWS 的洪水类查询端点（全量 `/alerts/active` 1.67MB 不可用，见文件头）。 */
const NWS_ALERTS_BASE = 'https://api.weather.gov/alerts/active';
/** ECCC 的预警集合（OGC API - Features）。 */
const ECCC_ALERTS_BASE = 'https://api.weather.gc.ca/collections/weather-alerts/items';
/** NWS 的 `?event=` 白名单参数（与 05h 的 NWS_EVENT_WHITELIST 同源，但这里必须显式列出——
 *  Host / Client 是两个半边，而 NWS 的过滤在**服务端**做，能省掉三分之二的海事通告）。 */
const NWS_EVENT_QUERY = [
  'Flood Warning', 'Flash Flood Warning', 'Coastal Flood Warning',
  'Flood Watch', 'Flood Advisory', 'Coastal Flood Watch', 'Coastal Flood Advisory', 'Coastal Flood Statement',
].join(',');

const NWS_POLL_MS = 120 * 1000;
const ECCC_POLL_MS = 300 * 1000;
/** 首轮延迟：错开启动窗口，也让设置页先渲染出来（与 12b 的 FEED_FIRST_DELAY_MS 同取向）。 */
const OVERSEAS_FIRST_DELAY_MS = 4000;
/** 单次请求超时（Client 侧统一 10 秒，DESIGN 4.2）。 */
const OVERSEAS_TIMEOUT_MS = 10 * 1000;
/** 单次响应体上限。ECCC 的 bbox 查询在预警密集时实测可到 200KB（几何 + 双语正文），512KB 有余量。 */
const OVERSEAS_MAX_BODY_CHARS = 512 * 1024;
/** 半径小于它时只查中心点（见文件头：采样点会落进同一个县，白花请求）。 */
const MIN_SAMPLE_RADIUS_KM = 25;
/** 每轮请求数上限：20 个关注点 × 5 个采样点 = 100，串行跑完会超过一轮的间隔。 */
const MAX_REQUESTS_PER_ROUND = 40;
/** 年龄闸门：首轮（或距上次成功超过 GATE_RESET）时，只播报发布在这么久以内的条目。 */
const OVERSEAS_FRESH_GATE_MS = 6 * 60 * 60 * 1000;
/** 距上次成功超过这么久，就重新按"首轮"处理（页面休眠恢复后不该把几小时前的当新警报）。 */
const OVERSEAS_GATE_RESET_MS = 30 * 60 * 1000;
/**
 * HTTP 400 之后的冷却期（0.6.0 review A-2）。**不永久拉黑**：400 也可能表示"我们的参数被上游
 * 拒绝"（event 名改了、中间设备改写、WAF），一次误判不该让某个点在本会话里永远查不到。
 * 冷却期内跳过该 URL，到期后自动重试一次。
 */
const UNCOVERED_TTL_MS = 60 * 60 * 1000;
/** 整轮全部失败时的退避起点与上限（DESIGN 4.7.2 对轮询源的通用约束）。 */
const OVERSEAS_MIN_BACKOFF_MS = 1000;
const OVERSEAS_MAX_BACKOFF_MS = 60 * 1000;

/**
 * 海外源的计数快照（供设置页的状态区块与诊断快照读取）。
 *
 * 与 12b 的 `feedStatsOf` **分成两张表**：那张表的字段是"增量 / 游标 / Host 计数"，
 * 语义与这里的"轮次 / 请求数 / 未覆盖 / 年龄闸门"完全不同——混在一张表里会让渲染代码
 * 靠 `if (f.host)` 之类的形状判断去猜来源（0.5.4 修过的那类问题）。两张表各自由自己的
 * 渲染分支读，互不干扰。
 */
const overseasStatsOf = {};

/**
 * 覆盖范围包围盒。**宁可宽一点也不精确**：盒外的关注点不产生请求（用户没配那个国家就不查），
 * 盒内重叠（美加边境）会让同一个点查两个源——多一次请求，NWS 对覆盖外的点回 400，
 * 由 pollOnce 的 `uncovered` 分类兜住（不会显示成故障）。
 */
const US_BOXES = [
  { minLat: 24, maxLat: 50, minLon: -125, maxLon: -66 }, // 本土
  { minLat: 51, maxLat: 72, minLon: -170, maxLon: -129 }, // 阿拉斯加
  { minLat: 18, maxLat: 23, minLon: -161, maxLon: -154 }, // 夏威夷
];
const CA_BOX = { minLat: 41, maxLat: 84, minLon: -141, maxLon: -52 };

/** 1 纬度的公里数（地球平均半径口径，与 06-matcher 的 distanceKm 同一量级即可）。 */
const KM_PER_DEG = 111;

const inBox = (p, b) => p.lat >= b.minLat && p.lat <= b.maxLat && p.lon >= b.minLon && p.lon <= b.maxLon;

/** 关注点里落在给定包围盒内的那些（配置不合法的一律跳过，不猜）。 */
function placesInBoxes(cfg, boxes) {
  const out = [];
  for (const p of ((cfg.watch || {}).places || [])) {
    if (!p || typeof p.lat !== 'number' || typeof p.lon !== 'number') continue
    if (!Number.isFinite(p.lat) || !Number.isFinite(p.lon)) continue
    if (boxes.some((b) => inBox(p, b))) out.push(p);
  }
  return out
}

/** 经度方向的度数：高纬度处同样的公里数对应更多经度，除以 cos 是必须的（否则 bbox 会偏窄）。 */
function lonDegreesOf(km, lat) {
  const c = Math.cos((Math.max(-89.9, Math.min(89.9, lat)) * Math.PI) / 180);
  return km / (KM_PER_DEG * Math.max(0.05, c))
}

/** ECCC 的 bbox：坐标 ± 半径（经度按纬度修正）。 */
function ecccBboxOf(place) {
  const dLat = Number(place.radiusKm || 0) / KM_PER_DEG;
  const dLon = lonDegreesOf(Number(place.radiusKm || 0), place.lat);
  const f = (n) => Number(n.toFixed(4));
  return [f(place.lon - dLon), f(place.lat - dLat), f(place.lon + dLon), f(place.lat + dLat)].join(',')
}

/** NWS 的采样点：中心 + （半径够大时）四个方位。返回 `[lat, lon]` 数组。 */
function nwsSamplePoints(place) {
  const pts = [[place.lat, place.lon]];
  const r = Number(place.radiusKm || 0);
  if (!(r >= MIN_SAMPLE_RADIUS_KM)) return pts
  const dLat = r / KM_PER_DEG;
  const dLon = lonDegreesOf(r, place.lat);
  pts.push([place.lat + dLat, place.lon]);
  pts.push([place.lat - dLat, place.lon]);
  pts.push([place.lat, place.lon + dLon]);
  pts.push([place.lat, place.lon - dLon]);
  return pts
}

/** 默认取数：Node / 浏览器通用的 fetch，带超时与 Accept。 */
async function defaultFetchText(url, ctx) {
  const signal = ctx && ctx.signal;
  const work = (async () => {
    const res = await fetch(url, { signal, headers: { Accept: 'application/json' } });
    if (!res.ok) {
      // 带上状态码：NWS 对"覆盖范围之外"的坐标返回 400（实测多伦多 / 温哥华 / 伦敦都是），
      // 那与"网络不通"是两回事，见 pollOnce 里的分类。
      const err = new Error('HTTP ' + res.status);
      err.status = res.status;
      // 400 的响应体自带原因（NWS 是 `Invalid Parameter` + parameterErrors）——**只留给诊断**，
      // 不参与任何判据（按错误文本做分支就是"猜"，DESIGN 4.5 明确反对）。
      if (res.status === 400) {
        try { err.bodyHint = String(await res.text()).slice(0, 200); } catch (e) { /* 读不到就算了 */ }
      }
      throw err
    }
    return await res.text()
  })();
  if (signal) return await work
  // 没有 AbortController 时用 Promise.race 兜住超时（0.6.0 review C-7）：否则单次请求可以永久
  // 挂住，而下一轮只在上一轮结束之后才排 → 整条轮询链会静默停摆、状态还保持绿色。
  // （无法真正取消那个 fetch，但至少让失败可见、让下一轮照常排。）
  return await Promise.race([
    work,
    new Promise((_, reject) => {
      setTimeout(() => reject(new Error('请求超时（本环境没有 AbortController）')), OVERSEAS_TIMEOUT_MS);
    }),
  ])
}

/** 会话内的"覆盖外"标记以 **URL 本身**为键：坐标或半径一变，旧标记自然失效，不必手动清理。 */

/**
 * 通用海外取数器。与 12b 的 createFeedClient **接口同形**（start / stop / pollOnce / pollSerial /
 * stats），差别只在"数据从哪来"：那边是 Host 的增量游标，这边是按关注点的外部查询。
 *
 * @param {object} opts
 *   id / label / intervalMs / firstDelayMs / enabled / getCfg
 *   placesFor(cfg) -> place[]          该国关注点
 *   urlsFor(place, cfg) -> string[]    该关注点的查询 URL（NWS 多个采样点、ECCC 一个 bbox）
 *   parseOne(feature, place) -> result 契约包装（05d）
 *   onStatus(patch) / onError(err) / fetchText(url, ctx)
 */
function createOverseasSource(opts = {}) {
  const id = opts.id || 'overseas';
  const label = opts.label || id;
  const regionText = opts.regionText || '';
  const intervalMs = opts.intervalMs || NWS_POLL_MS;
  const firstDelayMs = opts.firstDelayMs === undefined ? OVERSEAS_FIRST_DELAY_MS : opts.firstDelayMs;
  const getCfg = opts.getCfg || currentCfg;
  const fetchText = opts.fetchText || defaultFetchText;
  const onError = opts.onError || (() => {});
  const onStatus = opts.onStatus || (() => {});
  const enabled = opts.enabled || ((cfg) => (cfg.disasters || {}).overseasWeather !== false);
  const placesFor = opts.placesFor || (() => []);
  const urlsFor = opts.urlsFor || (() => []);
  const parseOne = opts.parseOne || (() => ({ ok: false, kind: 'schema', detail: '未配置解析器' }));
  // 交给主链的出口做成可注入：默认就是 11-pipeline 的 handleAlert，测试注入 spy 之后
  // 就能只验"取数器交出了什么"，而不必把整条通知链（音频 / 通知 / toast）拖进单测。
  const onAlert = opts.onAlert || handleAlert;

  let timer = null;
  let running = false;
  let stopped = false;
  let inFlight = null;
  let abortCtl = null;
  let lastStatusKey = '';
  let lastSuccessAt = 0;
  let lastError = '';
  /** 整轮全部失败时的退避（0 = 没有退避，用正常间隔）。 */
  let backoffMs = 0;
  const stats = {
    polls: 0, requests: 0, received: 0, applied: 0, errors: 0,
    ageSkipped: 0, throttledLast: 0, throttledTotal: 0, gated: 0, rejected: 0, lastAt: 0, lastDataAt: 0,
  };
  // 会话内记住"这些 URL 暂时别查"（键 = URL，值 = 可以再试的时刻）。0.6.0 review A-2：
  // 原来是永久拉黑，一次误判（上游改参数名 / WAF 回 400）就让那个点在本会话里永远查不到；
  // 现在带 TTL，到点自动重试一次。
  const uncovered = new Map();

  /**
   * 状态上报：只在**变化**时送出，且除自己上一轮的值还比 **store 里的当前值**
   * （0.5.4 的修正：探针 / 健康层也会写同一个源，只比自己会把别人的状态永久盖住）。
   */
  function reportStatus(patch) {
    const eff = effectiveStatusOf(id, patch.status, patch.detail);
    const cur = ((store.sources || {})[id] || {});
    // 去重键 = **status + detail**（0.6.0 review 修正）。此前只比 status，于是"同一状态下的
    // 语义变化"永远推不出去：用户刚加了一个关注点，状态仍是 open，而 detail 从
    // 「未设置美国关注点（设置 → …）」变成了「已查询」——旧文案会一直挂在设置页上，
    // 用户以为没配成功（这正是 0.5.4「信号被覆盖」那一类）。
    // 代价是 **detail 里不能放单调计数**：那会让每轮都判定为变化、整页反复重渲。
    // 所以计数一律不进 detail，由 13-ui 的 OVERSEAS_STAT_ORDER 从 stats 直接读。
    const key = eff.status + '|' + String(eff.detail || '');
    if (key === lastStatusKey && cur.status === eff.status && String(cur.detail || '') === String(eff.detail || '')) return
    lastStatusKey = key;
    // 与 12b 同形：**由调用方（15-entry 的 feedStatus）落库**，本模块不直接写 store
    // ——两处都写会让同一个状态在一轮里被 publish 两次，也会让"谁写的"变得不可追。
    try { onStatus(Object.assign({ label }, eff)); } catch (err) { /* UI 回调异常不影响轮询 */ }
  }

  async function pollOnce() {
    if (stopped) return { applied: 0, aborted: true }
    const cfg = getCfg();
    stats.lastAt = Date.now();
    if (!enabled(cfg)) {
      reportStatus({ status: 'disabled', detail: '海外气象提醒已关闭' });
      return { applied: 0, disabled: true }
    }
    const places = placesFor(cfg);
    if (places.length === 0) {
      // 与坐标型源同一条原则（06-matcher 的 noWatch）：**不静默**——"配错了关注点"看起来像
      // "根本没有预警"是这套系统最该避免的误解。这里不产生任何网络请求。
      reportStatus({
        status: 'open',
        detail: '未设置' + regionText + '关注点（设置 → 灾害预警 → ③ 其他地区：坐标 + 半径）',
      });
      return { applied: 0, noPlaces: true }
    }
    // 请求清单（0.6.0 review 修正）：**先保证每个关注点都被查一次，再补采样点**。
    // 此前是按关注点顺序平铺后整段截断——10 个关注点 × 5 个采样点 = 50 > 上限 40 时，
    // 排在后面的两个关注点**每一轮都被截断、永远查不到**，而用户看不出任何异常
    //（这正是 3.2 最反对的"静默漏报"）。现在：
    //   · 每个关注点的第一个 URL（NWS 的中心点 / ECCC 的 bbox）无条件排上；
    //   · 剩下的额度才按顺序补方位采样点。
    // 关注点上限是 20（MAX_WATCH_PLACES），远小于请求上限，所以正常配置下**不会再丢关注点**；
    // 万一真的超出，`skippedPlaces` 会如实计数并写进状态（不静默）。
    const now = Date.now();
    // 暂时被上游拒绝的 URL 先跳过（TTL 到期后会自动重试一次，见下面 400 分支）
    const groups = places
      .map((p) => ({ place: p, urls: (urlsFor(p, cfg) || []).filter((u) => !(uncovered.get(u) > now)) }))
      .filter((g) => Array.isArray(g.urls) && g.urls.length > 0);
    const reqs = [];
    for (const g of groups) reqs.push({ place: g.place, url: g.urls[0] });
    const coreCount = reqs.length;
    // 剩余额度补方位采样点，**起点按轮次轮转**（0.6.0 review B-2）：固定顺序会让排在后面的
    // 关注点每一轮都只拿到中心点（实测 10 个点时尾部两点永远只有 1 个采样点，等效半径退化成
    // "那一个县"）。轮转之后长期看每个点都能轮到方位采样。
    const offset = groups.length > 0 ? (stats.polls % groups.length) : 0;
    const rotated = groups.slice(offset).concat(groups.slice(0, offset));
    for (const g of rotated) {
      for (let i = 1; i < g.urls.length; i += 1) {
        if (reqs.length >= MAX_REQUESTS_PER_ROUND) break
        reqs.push({ place: g.place, url: g.urls[i] });
      }
      if (reqs.length >= MAX_REQUESTS_PER_ROUND) break
    }
    const capped = reqs.slice(0, MAX_REQUESTS_PER_ROUND);
    // 被截断的采样点数要按"本该有多少"算，而不是用 reqs.length——补采样点时就已经 break 在
    // 上限上了，剩下的采样点根本没进 reqs（用 reqs.length 会永远算出 0，设置页那一行就成了摆设）。
    const wantSamples = groups.reduce((n, g) => n + Math.max(0, g.urls.length - 1), 0);
    const gotSamples = Math.max(0, capped.length - Math.min(coreCount, capped.length));
    const skippedPlaces = Math.max(0, coreCount - capped.length);
    const skippedSamples = Math.max(0, wantSamples - gotSamples);
    // 两个计数分开（0.6.0 review B-6）：`Last` 是本轮值（设置页看当下）、`Total` 是累计
    // （诊断里看趋势）——此前只有一个覆盖式的值，会出现"忽有忽无、也不知道累计跳了多少"。
    stats.throttledLast = skippedPlaces + skippedSamples;
    stats.throttledTotal += stats.throttledLast;

    // 年龄闸门（DESIGN 4.7.6）：首轮或"距上次成功超过 30 分钟"（页面休眠恢复）时，
    // 只把发布在 6 小时以内的条目当新警报播；更早的仍进历史，但不打扰。
    const gated = (now - lastSuccessAt) > OVERSEAS_GATE_RESET_MS;
    if (gated) stats.gated += 1;

    stats.polls += 1;
    stats.requests += capped.length;
    let okCount = 0;
    let failCount = 0;
    let applied = 0;
    let rejectedNow = 0;
    let newestDataAt = 0;
    // 同一条预警可能被多个采样点查到（中心点与方位点落进同一个县）→ 一轮内只处理一次。
    const seen = new Set();
    for (const item of capped) {
      if (stopped) break
      abortCtl = typeof AbortController === 'function' ? new AbortController() : null;
      const timerId = abortCtl ? setTimeout(() => { try { abortCtl.abort(); } catch (e) {} }, OVERSEAS_TIMEOUT_MS) : null;
      try {
        const text = await fetchText(item.url, { signal: abortCtl ? abortCtl.signal : undefined });
        if (typeof text !== 'string') throw new Error('取数器没有返回文本')
        if (text.length > OVERSEAS_MAX_BODY_CHARS) {
          throw new Error('响应体过大（' + text.length + ' 字符 > 上限 ' + OVERSEAS_MAX_BODY_CHARS + '）')
        }
        let json;
        try {
          json = JSON.parse(text);
        } catch (err) {
          throw new Error('响应不是合法 JSON（可能是拦截页或上游改版）')
        }
        const feats = json && Array.isArray(json.features) ? json.features : null;
        if (!feats) {
          // 顶层结构不符 = **契约漂移**，不是链路故障（0.6.0 review 修正）。按 DESIGN 4.5 的六态
          // 语义它该点亮**蓝点**（用户处理不了、等插件更新），而不是红点（让用户去折腾自己的网络）。
          // 此前这里只抛普通 Error，于是整轮被归成 unreachable —— 与 check-contracts 把同一个
          // 条件判成"结构变了"的结论自相矛盾。
          noteParseResult(id, failResult('schema', '响应缺少 features 数组（结构不符，可能是上游改版或拦截页）'));
          throw new Error('响应缺少 features 数组（结构不符）')
        }
        okCount += 1;
        stats.received += feats.length;
        for (const feature of feats) {
          // **单条各自兜错**（0.6.0 review B-3）：此前整个 features 循环与 fetch 共用一个 try，
          // 一条 entry 的解析 / 主链异常会被记成"这个请求失败"，还会静默丢掉该响应里剩下的条目
          //（12b 的既有纪律正是"单条失败不阻断其余条目"，见其 apply 循环）。
          let res = null;
          try {
            res = parseOne(feature, item.place);
          } catch (parseErr) {
            stats.errors += 1;
            lastError = '单条解析抛错：' + String((parseErr && parseErr.message) || parseErr);
            continue
          }
          // 契约分类：empty（不在本插件范围 / 该点无预警）不计失败，schema / value 计入健康。
          if (noteParseResult(id, res)) continue
          if (!res.ok) continue
          const alert = res.alert;
          if (seen.has(alert.id)) continue
          seen.add(alert.id);
          noteSourceSuccess(id);
          const issued = Date.parse(alert.issued);
          if (Number.isFinite(issued) && issued > newestDataAt) newestDataAt = issued;
          const stale = gated && Number.isFinite(issued) && (now - issued) > OVERSEAS_FRESH_GATE_MS;
          if (stale) stats.ageSkipped += 1;
          // 过老的条目仍然交给主链，但带 staleOnArrival：主链会走"命中 + 只记历史"的那条分支
          // （与"跨会话重放"同形）。丢掉它会让用户看不到"就在打开页面前刚发布的洪水预警"。
          try {
            onAlert(alert, cfg, stale ? { staleOnArrival: Math.round((now - issued) / 3600000) } : undefined);
          } catch (alertErr) {
            stats.errors += 1;
            lastError = '主链处理抛错：' + String((alertErr && alertErr.message) || alertErr);
            continue
          }
          applied += 1;
        }
      } catch (err) {
        // **用户主动停用不是故障**（0.6.0 review A-1，照搬 12b 的既有守卫）：stop() 会 abort
        // 在途请求，于是 catch 会收到一个 AbortError。若照常累加，停用插件就会在侧边栏留下
        // 一个红点、并往诊断里写一条 "The user aborted a request."——而重载时旧 fiber 的这次
        // 上报还会把新会话短暂染红。这里直接返回，让本轮当作"被中止"处理。
        if (stopped) return { applied, aborted: true }
        // 400 = "这个坐标不在我的服务范围内"（NWS 实测对加拿大 / 英国的点都这么答）。
        // 这是**参数问题，不是链路故障**：按 DESIGN 4.5 的状态语义，把它显示成红色"不可达"
        // 会让一个多伦多用户以为插件坏了（实际是"你关注的地方没有这个源"）。
        // 三个约束（0.6.0 review A-2）：
        //   ① **不替上游断言原因**——400 也可能是"我们的参数被拒"（上游改了 event 名、
        //      中间设备改写、WAF），文案只说"被上游拒绝（HTTP 400）"，并把响应体前 160 字
        //      留在诊断里供人判断，不写"这个点不在覆盖范围"这种我们无法证实的话；
        //   ② **拉黑带 TTL**——记的是"这个 URL 暂时别查"，1 小时后自动重试一次，
        //      避免一次误判让某个点在本会话里永远查不到；
        //   ③ **按请求（URL）记，不是按关注点**：NWS 的"覆盖外"是逐点的，一个美加边境的点的
        //      中心点可能 400，而它的四个方位点里有落在美国境内、本该查得到的。
        if (err && err.status === 400) {
          stats.rejected += 1;
          rejectedNow += 1;
          uncovered.set(item.url, now + UNCOVERED_TTL_MS);
          if (!lastError) lastError = 'HTTP 400（' + String(err.bodyHint || '').slice(0, 160) + '）';
          // 400 也是"上游有响应"，同样算一次成功接触：否则只配了覆盖外坐标的用户
          // `lastSuccessAt` 永远不更新、年龄闸门恒处于"首轮"。
          lastSuccessAt = Date.now();
          continue
        }
        failCount += 1;
        stats.errors += 1;
        lastError = String((err && err.message) || err);
        onError(err);
      } finally {
        if (timerId) clearTimeout(timerId);
        abortCtl = null;
      }
    }
    if (newestDataAt) {
      stats.lastDataAt = newestDataAt;
      // 上报"最后一次拿到数据的时刻"：契约里这条源的 staleAfterMs 是 null（探针不判），
      // 但诊断快照与排障要看得到它。
      noteFreshness(id, newestDataAt);
    }
    // 停用之后不再写状态（0.6.0 review A-1）：否则"用户主动关掉插件"会在侧边栏留下红点，
    // 诊断里也会多一条 "The user aborted a request."
    if (stopped) return { applied, aborted: true }
    // 成功一轮就清掉上次的失败文案（0.6.0 review B-6）：否则一次瞬时 500 会永远挂在诊断里。
    if (okCount > 0 && failCount === 0) lastError = '';
    // 状态分类（DESIGN 4.5 的六态语义）：
    //   · 有响应且没有失败 → open
    //   · 有响应但也有失败 → degraded（部分链路有问题，但仍在工作）
    //   · 全部失败 → unreachable（红色：环境问题，用户或许能处理）
    //   · 全部被 400 拒绝 → **仍然是 open**（400 是参数问题，不是链路故障，见上面的分档）
    if (okCount > 0 && failCount === 0) {
      lastSuccessAt = Date.now();
      // detail 只放**非单调**的语义信息（0.6.0 review 修正 + B-1）：它进了上报去重键，
      // 含单调计数会让每轮都判为"变化"、设置页反复重渲。但也**不能留空**——空 detail 会让
      // 侧边栏悬停与设置页顶部回退成裸状态词（出现「NWS：open」这种英文）。"已按 N 个关注点
      // 查询"里的 N 只在用户改配置时变，正是想推出去的语义变化；计数由设置页的
      // OVERSEAS_STAT_ORDER 从 stats 直接读。
      const notes = [];
      if (skippedPlaces) notes.push('关注点过多，本轮只查了 ' + capped.length + ' 个');
      else if (skippedSamples) notes.push('采样点超出每轮上限，本轮只查了部分方位点');
      if (rejectedNow) notes.push(rejectedNow + ' 个请求被上游拒绝（HTTP 400）');
      if (notes.length === 0) notes.push('已按 ' + places.length + ' 个关注点查询');
      reportStatus({ status: 'open', detail: notes.join(' · ') });
    } else if (okCount > 0) {
      lastSuccessAt = Date.now();
      reportStatus({ status: 'degraded', detail: failCount + '/' + capped.length + ' 个请求失败：' + lastError });
    } else if (failCount > 0) {
      reportStatus({ status: 'unreachable', detail: '全部请求失败：' + lastError });
    } else if (rejectedNow > 0) {
      // 不替上游断言原因（0.6.0 review A-2）：400 也可能是"我们的参数被拒"，
      // 文案只说被拒绝 + 多久后重试，响应体前 160 字在诊断里。
      reportStatus({
        status: 'open',
        detail: rejectedNow + ' 个请求被上游拒绝（HTTP 400，' + Math.round(UNCOVERED_TTL_MS / 60000) + ' 分钟后重试）',
      });
    }
    stats.applied += applied;
    return {
      applied, requests: capped.length, failed: failCount,
      throttled: stats.throttledLast, rejected: rejectedNow,
    }
  }

  function pollSerial() {
    if (inFlight) return inFlight
    inFlight = pollOnce().finally(() => {
      inFlight = null;
      // 给设置页的「源状态」与诊断快照留一份快照（与 12b 对 feedStatsOf 的做法一致：
      // 不触发 store 重渲，渲染侧每 5 秒自己读一次）。
      overseasStatsOf[id] = Object.assign({}, stats, { running, lastError });
    });
    return inFlight
  }

  function schedule(delay) {
    if (!running) return
    // 排新的之前先清旧的（0.5.4 对 12b 的修正，这里同纪律）
    if (timer) { clearTimeout(timer); timer = null; }
    timer = setTimeout(async () => {
      timer = null;
      let res = null;
      try { res = await pollSerial(); } catch (err) { onError(err); }
      // 失败退避（0.6.0 review B-5）：DESIGN 4.7.2 承诺过"失败退避 1s→60s"，此前实现里没有——
      // 上游 5xx / 429 时仍按原节奏继续打。整轮全部失败才退避，成功即回到正常间隔。
      const allFailed = !!(res && res.requests > 0 && res.failed === res.requests);
      if (allFailed) backoffMs = backoffMs ? Math.min(backoffMs * 2, OVERSEAS_MAX_BACKOFF_MS) : OVERSEAS_MIN_BACKOFF_MS;
      else backoffMs = 0;
      schedule(backoffMs || intervalMs);
    }, delay);
  }

  return {
    id,
    label,
    start() {
      if (running) return
      stopped = false;
      running = true;
      backoffMs = 0;
      schedule(firstDelayMs);
    },
    stop() {
      stopped = true;
      running = false;
      if (timer) { clearTimeout(timer); timer = null; }
      // 中止在途请求：插件停用后回来的响应不该再进主链（响铃 / 弹窗 / 写历史）
      if (abortCtl) { try { abortCtl.abort(); } catch (err) { /* 已结束等忽略 */ } abortCtl = null; }
      // 停用后也刷新一次快照（0.6.0 review B-6）：否则诊断里 `running` 会一直停在 true。
      overseasStatsOf[id] = Object.assign({}, stats, { running: false, lastError });
    },
    pollOnce,
    pollSerial,
    stats() {
      return Object.assign({}, stats, { running, lastError })
    },
    /** 测试与诊断用：把"上次成功"归零，模拟页面刚打开。 */
    resetGate() { lastSuccessAt = 0; },
  }
}

/** 美国 NWS 的取数器（洪水 / 山洪 / 沿海洪水）。 */
function createNwsSource(opts = {}) {
  return createOverseasSource(Object.assign({
    id: 'nws_alerts',
    label: 'NWS',
    regionText: '美国',
    intervalMs: NWS_POLL_MS,
    placesFor: (cfg) => placesInBoxes(cfg, US_BOXES),
    urlsFor: (place) => nwsSamplePoints(place).map((pt) =>
      urlOfLocal(NWS_ALERTS_BASE, { point: pt[0].toFixed(4) + ',' + pt[1].toFixed(4), event: NWS_EVENT_QUERY })),
    parseOne: (feature, place) => parseNwsAlertResult(feature, { place }),
  }, opts))
}

/** 加拿大 ECCC 的取数器（降雨 / 洪水 / 风暴潮 warning）。 */
function createEcccSource(opts = {}) {
  return createOverseasSource(Object.assign({
    id: 'eccc_alerts',
    label: 'ECCC',
    regionText: '加拿大',
    intervalMs: ECCC_POLL_MS,
    placesFor: (cfg) => placesInBoxes(cfg, [CA_BOX]),
    urlsFor: (place) => [urlOfLocal(ECCC_ALERTS_BASE, { f: 'json', limit: '200', bbox: ecccBboxOf(place) })],
    parseOne: (feature, place) => parseEcccAlertResult(feature, { place }),
  }, opts))
}

/** URL 里的值只做最小转义：**保留逗号**。NWS 的 `point=lat,lon` 与 ECCC 的 `bbox=a,b,c,d`
 *  都靠逗号分隔，转成 `%2C` 之后 URL 在排障日志里几乎没法读；两个源都接受裸逗号（实测）。 */
function encodeValue(v) {
  return encodeURIComponent(v).replace(/%2C/g, ',')
}

/** 模块级 URL 拼装（两个 profile 共用；createOverseasSource 内部不再各写一份）。 */
function urlOfLocal(base, params) {
  const qs = Object.keys(params).map((k) => k + '=' + encodeValue(params[k])).join('&');
  return base + '?' + qs
}

// ============================================================================
// dsh-quake-alert · client/src/16-diag.js
//
// 作用：**只读诊断快照**（DESIGN 11.3 的交付物之一）。
// 内容：把 Client 侧的实时状态压成一份 JSON——聚合状态、逐源状态与数据健康、增量计数、
//       大陆源的链路模式、关注点摘要、最近几条历史。
// 依赖：03-settings-bridge、05d-source-contracts、07-store、12b-feed-poll、12c-cn-stream。
//
// 为什么需要它：`TROUBLESHOOTING.zh.md` 的读者是 **AI**，而 AI 只能看到用户粘贴给它的东西。
// Host 侧的 `/feed?stats=1` 已经能读，但"浏览器这一半到底收到了什么、卡在哪一步"此前
// 完全在界面里、靠人肉描述——而人肉描述恰恰是最不可靠的一环（"没响"可能是没收到、
// 可能是解析失败、可能是没命中关注点、可能是被静默时段吞掉，四种原因在用户叙述里长得一样）。
//
// 三条纪律：
//   ① **只读**：不修改任何状态、不发任何请求。诊断本身不能改变被诊断的东西。
//   ② **永不抛错**：每个片段各自 try/catch。一个会抛错的诊断工具在真出事时最没用。
//   ③ **只放可 JSON 化的叶子字段**：store / registry / cfg 都是活对象，直接 JSON.stringify
//      会拖出整个模块图（也能成环）。逐字段取。
//
// 关于版本号：快照里**不含插件版本**——本项目的版本号只在 package.json / CHANGELOG /
// README 三处（见约定），把它复制进 client bundle 会多出一个会漂移的位置。
// `snapshot` 是这份**快照格式**的版本，用来判断字段含义。
// ============================================================================


/** 快照格式版本（与插件版本无关，见文件头）。 */
const DIAG_SNAPSHOT_VERSION = 1;

const str = (v) => String(v === undefined || v === null ? '' : v);
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** 每个片段都各自兜错：诊断工具在任何状态下都必须能产出东西。 */
function safe(fn, fallback, warnings, label) {
  try {
    return fn()
  } catch (err) {
    warnings.push(label + '：' + str((err && err.message) || err));
    return fallback
  }
}

/** 来源标注：让 AI 知道这条状态是哪条链路报的，不用去猜字段顺序。 */
function sourceRows() {
  const out = {};
  const srcs = (store && store.sources) || {};
  for (const id of Object.keys(srcs)) {
    const s = srcs[id] || {};
    out[id] = { label: str(s.label), status: str(s.status), retries: num(s.retries), detail: str(s.detail) };
  }
  return out
}

/** 增量源的计数（12b）：只留诊断用得上的字段，host 那段原样带上（它就是 Host 的健康计数）。 */
function feedRows() {
  const out = {};
  for (const id of Object.keys(feedStatsOf)) {
    const f = feedStatsOf[id] || {};
    out[id] = {
      polls: num(f.polls), received: num(f.received), applied: num(f.applied),
      errors: num(f.errors), truncated: num(f.truncated), resets: num(f.resets),
      tailSync: num(f.tailSync), morePages: num(f.morePages),
      lastAt: f.lastAt ? new Date(f.lastAt).toISOString() : null,
      cursor: num(f.cursor), running: f.running === true,
      host: f.host || null,
    };
  }
  return out
}

/**
 * 海外源（12e，0.6.0）：Client 直连的 REST 轮询。
 *
 * 三个字段是这个形态**独有**的，也是排障时最先要看的：
 *   · `uncovered` —— NWS 对"覆盖范围之外"的坐标回 400（实测多伦多 / 温哥华 / 伦敦），
 *     它不是故障；数字涨说明有人的关注点不在这个源的服务范围内。
 *   · `ageSkipped` —— 被年龄闸门拦下的条数（打开页面时已发布超过 6 小时的那些，
 *     只进历史不响铃）。它解释"为什么我看到预警但没响"。
 *   · `gated` —— 这个源进入过几次"首轮 / 休眠恢复"状态（每次进入都会重新按 6 小时判）。
 */
function overseasRows() {
  const out = {};
  for (const id of Object.keys(overseasStatsOf)) {
    const o = overseasStatsOf[id] || {};
    out[id] = {
      polls: num(o.polls), requests: num(o.requests), received: num(o.received), applied: num(o.applied),
      errors: num(o.errors),
      // `rejected` = 被上游用 HTTP 400 拒绝的请求数（**不代表"这个点不在覆盖范围"**，
      // 也可能是我们的参数被拒；响应体前 160 字在 lastError 里）。
      rejected: num(o.rejected),
      ageSkipped: num(o.ageSkipped),
      // 两个 throttle 计数分开：Last 是本轮、Total 是累计（0.6.0 review B-6）
      throttledLast: num(o.throttledLast), throttledTotal: num(o.throttledTotal), gated: num(o.gated),
      lastAt: o.lastAt ? new Date(o.lastAt).toISOString() : null,
      lastDataAt: o.lastDataAt ? new Date(o.lastDataAt).toISOString() : null,
      running: o.running === true,
      lastError: str(o.lastError),
    };
  }
  return out
}

/** 大陆源（12c）：**链路模式是这里最要紧的一列**——降级意味着延迟从秒级变成最长 15 秒。 */
function streamRows() {
  const out = {};
  for (const id of Object.keys(cnStreamRegistry)) {
    const reg = cnStreamRegistry[id];
    const s = safe(() => reg.stats(), {}, [], 'stream:' + id) || {};
    out[id] = {
      mode: safe(() => reg.mode(), 'unknown', [], 'mode:' + id),
      connections: num(s.connections), syncs: num(s.syncs),
      received: num(s.received), applied: num(s.applied),
      errors: num(s.errors), sseErrors: num(s.sseErrors), probeTimeouts: num(s.probeTimeouts),
      fallbacks: num(s.fallbacks), truncated: num(s.truncated), resets: num(s.resets),
      lastAt: s.lastAt ? new Date(s.lastAt).toISOString() : null,
      lastEventAt: s.lastEventAt ? new Date(s.lastEventAt).toISOString() : null,
      cursor: num(s.cursor), frozen: s.frozen === true,
      // stale 由 Host 的 sync / status 帧告知（Client 自己判不出"没有数据"与"没有地震"）
      stale: s.stale === true,
      dataTime: s.dataTime ? new Date(s.dataTime).toISOString() : null,
      running: s.running === true, fallbackActive: s.fallbackActive === true,
      lastDetail: str(s.lastDetail),
    };
  }
  return out
}

/** 关注点摘要。**坐标是有意保留的**：匹配失败通常就要靠"震中距最近关注点多少公里"来判，
 *  去掉坐标等于把最有用的那一列删了。用户是主动粘贴这份快照的，界面上也写明了含坐标。 */
function watchSummary(cfg) {
  const w = (cfg && cfg.watch) || {};
  const places = Array.isArray(w.places) ? w.places : [];
  return {
    prefectures: Array.isArray(w.prefectures) ? w.prefectures.slice(0, 50) : [],
    citiesCount: Array.isArray(w.cities) ? w.cities.length : 0,
    cities: Array.isArray(w.cities) ? w.cities.slice(0, 30) : [],
    places: places.slice(0, 20).map((p) => ({
      name: str(p && p.name), lat: num(p && p.lat), lon: num(p && p.lon), radiusKm: num(p && p.radiusKm),
    })),
    placesCount: places.length,
  }
}

/** 最近几条历史：只留判定"到底播报没播报、为什么没播报"所需的字段。 */
function historySummary() {
  const evs = (store && Array.isArray(store.events)) ? store.events : [];
  return {
    count: evs.length,
    recent: evs.slice(0, 5).map((e) => ({
      kind: str(e && e.kind), label: str(e && e.label), severity: str(e && e.severity),
      issued: str(e && e.issued), hit: e && e.hit === true,
      suppressed: e && e.suppressed === true, suppressedReason: str(e && e.suppressedReason),
      headline: str(e && e.headline).slice(0, 120),
    })),
  }
}

/** 页面环境：有些故障只在后台标签页或离线时出现。 */
function pageEnv() {
  const out = { visibility: 'unknown', online: null, hasEventSource: false, hasBroadcastChannel: false };
  try {
    if (typeof document !== 'undefined' && document && typeof document.visibilityState === 'string') {
      out.visibility = document.visibilityState;
    }
  } catch (err) { /* 忽略 */ }
  try {
    if (typeof navigator !== 'undefined' && navigator && typeof navigator.onLine === 'boolean') out.online = navigator.onLine;
  } catch (err) { /* 忽略 */ }
  try {
    out.hasEventSource = typeof window !== 'undefined' && typeof window.EventSource === 'function';
    out.hasBroadcastChannel = typeof window !== 'undefined' && typeof window.BroadcastChannel === 'function';
  } catch (err) { /* 忽略 */ }
  return out
}

/**
 * 生成诊断快照。
 * @param {number} [now] 注入点（测试用）
 * @returns {object} 可直接 JSON.stringify 的纯数据对象
 */
function buildDiagSnapshot(now) {
  const warnings = [];
  const cfg = safe(() => currentCfg() || {}, {}, warnings, 'cfg') || {};
  const t = (typeof now === 'number' && Number.isFinite(now)) ? now : Date.now();
  const cfgThresholds = (cfg && cfg.thresholds) || {};
  const cfgDisasters = (cfg && cfg.disasters) || {};
  const cfgNotify = (cfg && cfg.notify) || {};
  const cfgDedupe = (cfg && cfg.dedupe) || {};
  const cfgQuiet = (cfg && cfg.quietHours) || {};
  const thresholds = {};
  for (const k of Object.keys(cfgThresholds)) thresholds[k] = cfgThresholds[k];
  const disasters = {};
  for (const k of Object.keys(cfgDisasters)) disasters[k] = cfgDisasters[k];
  return {
    snapshot: DIAG_SNAPSHOT_VERSION,
    at: new Date(t).toISOString(),
    page: safe(pageEnv, {}, warnings, 'page'),
    aggregate: safe(() => ({
      status: str(store.status), retries: num(store.retries), detail: str(store.detail),
      received: num(store.received),
      weatherHint: store.weatherHint
        ? { level: num(store.weatherHint.level), label: str(store.weatherHint.label), at: num(store.weatherHint.at) }
        : null,
    }), {}, warnings, 'aggregate'),
    config: safe(() => ({
      settingsStorage: str(settingsSync), // host（settings.yaml）| local | memory
      source: str(cfg.source),
      disasters,
      thresholds,
      notify: { sound: cfgNotify.sound !== false, system: cfgNotify.system !== false, volume: num(cfgNotify.volume) },
      dedupe: { windowMinutes: num(cfgDedupe.windowMinutes) },
      quietHours: {
        enabled: cfgQuiet.enabled === true, start: str(cfgQuiet.start), end: str(cfgQuiet.end),
        breakForSevere: cfgQuiet.breakForSevere !== false,
      },
      cnTransport: str(cfg.cnTransport) || 'auto', // 'auto'（默认，SSE 可自动降级）| 'poll'（用户强制轮询）
      watch: safe(() => watchSummary(cfg), {}, warnings, 'watch'),
    }), {}, warnings, 'config'),
    sources: safe(sourceRows, {}, warnings, 'sources'),
    // 数据健康：schema-error 的**原因**在这里（蓝点的解释）
    dataHealth: safe(() => sourceHealthOf() || {}, {}, warnings, 'health'),
    feed: safe(feedRows, {}, warnings, 'feed'),
    streams: safe(streamRows, {}, warnings, 'streams'),
    // 海外源（0.6.0）：Client 直连的 REST 轮询。与 feed / streams 并列而不是塞进任一张表
    // ——它们的字段语义不同（见 overseasRows 的注释）。
    overseas: safe(overseasRows, {}, warnings, 'overseas'),
    history: safe(historySummary, {}, warnings, 'history'),
    // 生成过程中被兜住的异常：诊断工具自身的失败也要可见，不能假装一切正常
    warnings,
  }
}

/**
 * 复制诊断快照到剪贴板。剪贴板不可用（沙箱 iframe / 权限被拒）时**不抛错**，
 * 而是把文本交回调用方去显示成可手动复制的文本框——诊断的第一步不该卡在复制上。
 * @returns {Promise<{ ok: boolean, text: string, error?: string }>}
 */
async function copyDiagSnapshot(now) {
  const text = safe(() => JSON.stringify(buildDiagSnapshot(now), null, 2), '{}', [], 'stringify');
  try {
    if (typeof navigator !== 'undefined' && navigator && navigator.clipboard &&
        typeof navigator.clipboard.writeText === 'function') {
      await navigator.clipboard.writeText(text);
      return { ok: true, text }
    }
  } catch (err) {
    return { ok: false, text, error: str((err && err.message) || err) }
  }
  return { ok: false, text }
}

// ============================================================================
// dsh-quake-alert · client/src/13-ui-settings.js
//
// 作用：设置页面板（设置 → 灾害预警）的全部 UI。
// 内容：连接状态与数据源、关注地区（都道府县 + 市区町村搜索多选）、
//       三类阈值、通知与声音（含音量防抖落盘）、静默时段、免责声明、最近预警记录。
// 依赖：01-constants、02-storage、03-settings-bridge、04-city-table、07-store、08-audio、09-notify。
// 约定：所有写入都经 applyCfg，保证内存/镜像/Host 三处一致。
// ============================================================================


// ---------- 设置页 UI ----------
// 连接状态 → 颜色 / 文案（设置页与侧边栏状态指示共用）
function statusMetaOf(status, retries) {
  return {
    idle: { color: '#7c8494', text: '未启动' },
    connecting: { color: '#d9a406', text: '连接中…' },
    open: { color: '#4ade80', text: '已连接' },
    reconnecting: { color: '#d9a406', text: '重连中（第 ' + retries + ' 次）' },
    closed: { color: '#e5484d', text: '已停止' },
    // 0.4.1：轮询源与"消息处理失败"也需要自己的状态。此前只有 WebSocket 的五个状态，
    // 于是上游被墙 / 路由 500 / 主链抛错时界面上与"没有新闻"完全不可区分。
    unreachable: { color: '#e5484d', text: '无法连接' },
    degraded: { color: '#d9a406', text: '链路降级' },
    stale: { color: '#8b8f98', text: '数据已过期' },
    'schema-error': { color: '#3b82f6', text: '数据格式异常' },
    disabled: { color: '#7c8494', text: '已关闭' },
  }[status] || { color: '#7c8494', text: String(status) }
}
// 配置存储位置的人话说明（settings.yaml / 进程内 / localStorage）
function settingsSyncLabel() {
  return {
    host: '机器级 settings.yaml（DSH settings 服务）',
    memory: '仅本浏览器（当前页面不支持 Host 持久化）',
    local: '浏览器 localStorage',
  }[settingsSync] || String(settingsSync)
}
// 历史条目「类型」行显示的 P2PQuake code。气象电文不在此表里（它不是 P2PQuake 来源），
// 索引一律经 own()，避免外部数据里的 'constructor' 之类的键命中原型链。
const P2P_KIND_CODE = { quake: 551, eew: 556, tsunami: 552 };
/** alert.code → 来源标注（全球源、JMA 电文与大陆源没有 P2PQuake 的 code）。 */
const SOURCE_CODE_TEXT = {
  emsc: 'EMSC', usgs: 'USGS', noaa: 'NOAA CAP', jma: 'JMA 电文',
  cenc_eew: 'CENC 预警', cenc_eqlist: 'CENC 速报',
  // 0.5.2：大陆气象预警的发布主体是各级气象台、由中央气象台汇总。标成「JMA 电文」会让
  // 一条云南暴雨预警看起来来自日本气象厅（同 SOURCE_CODE_TEXT 存在的理由）。
  nmc_alarm: '中央气象台',
  // 0.6.0：海外气象源。机构名不能省——一条多伦多的降雨预警被标成「JMA 电文」是同一类错误，
  // 而 ECCC 的许可（End-use Licence v2.1.1）本身就要求署名。
  nws_alerts: 'NWS', eccc_alerts: 'ECCC',
};
/**
 * 历史条目「类型」行的来源标注。
 *
 * 0.4.1：优先用 alert.code，而不是 kind。全球地震（EMSC / USGS）的 kind 也是 'quake'，
 * 只看 kind 会把它们标成「code 551」（P2PQuake 的震度速报）——与 0.3.2 修过的
 * "气象条目被标成 code 551"是同一类错误。
 * 0.4.2 补两处兜底：① 数值 code 经 `strOr` 变成字符串后也能显示成 `code N`；
 * ② **旧历史**（0.4.1 之前写入）没有 code 字段，用 id 前缀（emsc: / usgs: / noaa:）认出来源。
 */
function p2pCodeTextOf(kind, code, id) {
  const codeStr = String(code === undefined || code === null ? '' : code);
  const byCode = own(SOURCE_CODE_TEXT, codeStr);
  if (byCode) return byCode
  if (/^\d{3}$/.test(codeStr)) return 'code ' + codeStr
  const idStr = String(id === undefined || id === null ? '' : id);
  if (idStr.indexOf('emsc:') === 0) return 'EMSC'
  if (idStr.indexOf('usgs:') === 0) return 'USGS'
  if (idStr.indexOf('noaa:') === 0) return 'NOAA CAP'
  if (idStr.indexOf('cenc:') === 0) return 'CENC 大陆'
  // 0.5.2：大陆气象源（新的历史条目走 code，这里兜住"更早写入的"这条路径）
  if (idStr.indexOf('nmc:') === 0) return '中央气象台'
  // 0.6.0：海外气象源同理（`code` 缺失的历史条目靠 id 前缀认出来源）
  if (idStr.indexOf('nws:') === 0) return 'NWS'
  if (idStr.indexOf('eccc:') === 0) return 'ECCC'
  const c = own(P2P_KIND_CODE, kind);
  if (c) return 'code ' + c
  // 兜底：气象（kind='weather'）在 0.5.2 之前只有日本这一个来源。现在有了大陆气象源，
  // 所以这里的兜底必须注明它是**日方**的，而不是把两者混起来（大陆那条在上面的 id / code 分支已拦下）。
  return kind === 'weather' ? 'JMA 电文' : '—'
}
// 灾种配色：气象灾害此前没有键，历史条目一律落到灰色兜底，与另外三类不一致
const KIND_COLORS = { eew: '#e5484d', quake: '#3b82f6', tsunami: '#f76b15', weather: '#8b5cf6' };
const kindColorOf = (kind) => own(KIND_COLORS, kind) || '#7c8494';
const s = {
  section: (title, ...children) => h('div', { style: { padding: '14px 16px', borderBottom: '1px solid rgba(148,163,184,0.14)' } },
    h('div', { style: { fontWeight: 700, fontSize: 13, marginBottom: 10, color: '#dfe3e8' } }, title), ...children),
  label: (text) => h('div', { style: { color: '#9aa0a6', fontSize: 12, marginBottom: 4 } }, text),
  row: (...children) => h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', margin: '4px 0' } }, ...children),
  checkbox: (checked, onChange, text) => h('label', { style: { display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, cursor: 'pointer', color: '#dfe3e8' } },
    h('input', { type: 'checkbox', checked, onChange: (e) => onChange(e.target.checked) }), text),
  // `label`（第 5 参）渲染成 `aria-label`（0.5.4）。此前每个下拉旁边只有一个视觉上的 div
  // 文字，两者在 DOM 里没有任何关联——读屏软件念到的是"组合框"，用户无法知道哪个是震度阈值。
  // 全库此前只有历史条目与状态点两处 aria 属性（CHANGELOG 记过），而 DESIGN 从未把无障碍
  // 记为"有意不做"，所以这是遗漏而不是取舍。
  select: (value, options, onChange, textOf, label) => h('select', {
    value, onChange: (e) => onChange(e.target.value),
    'aria-label': label || undefined,
    style: { background: '#ffffff', color: '#1a1a1a', border: '1px solid #6b7280', borderRadius: 6, padding: '4px 8px', fontSize: 12, minWidth: 180 },
  }, options.map((o) => h('option', {
    key: String(o.v !== undefined ? o.v : o.g), value: String(o.v !== undefined ? o.v : o.g),
    style: { background: '#ffffff', color: '#1a1a1a' },
  }, textOf(o)))),
  btn: (text, onClick, extra) => h('button', {
    onClick,
    style: Object.assign({ background: 'rgba(148,163,184,0.12)', color: 'inherit', border: '1px solid rgba(148,163,184,0.35)', borderRadius: 6, padding: '5px 12px', cursor: 'pointer', fontSize: 12 }, extra || {}),
  }, text),
};

/** 轮询源的中文标签（状态区块与详情共用）。 */
const SOURCE_LABELS = {
  p2pquake: 'P2PQuake（日本地震 / EEW / 海啸，实时推送）',
  emsc: 'EMSC（全球地震，实时推送）',
  cenc_eew: '大陆地震预警（CENC，SSE 推送）',
  cenc_eqlist: '大陆地震速报（CENC，SSE 推送）',
  jma: '気象庁（气象灾害，Host 轮询）',
  usgs: 'USGS（全球地震目录，Host 轮询）',
  noaa: 'NOAA（海啸 CAP，Host 轮询）',
  nmc_alarm: '中央气象台（大陆暴雨 / 地质灾害预警，Host 轮询）',
  // 0.6.0：两个海外源都是 **Client 直连的 REST 轮询**（CORS 实测允许），不走 Host。
  nws_alerts: 'NWS（美国洪水 / 山洪 / 沿海洪水，Client 直连）',
  eccc_alerts: 'ECCC（加拿大降雨 / 风暴潮预警，Client 直连）',
};
/**
 * 源状态区块里的源顺序与分组。**一处维护**：此前同样的列表在三个地方各写一遍
 * （状态行、增量计数行、重试按钮），加一个源要改三处——漏掉任何一处就变成
 * "某个源坏了但界面上看不见"，而"让失败可见"正是这个区块存在的全部理由。
 */
const SOURCE_ORDER = ['p2pquake', 'emsc', 'cenc_eew', 'cenc_eqlist', 'jma', 'usgs', 'noaa', 'nmc_alarm', 'nws_alerts', 'eccc_alerts'];
/** 走 `/feed` 增量计数的源（feedStatsOf 有快照）。大陆地震源走 SSE，另有自己的计数与链路模式。 */
const FEED_STAT_ORDER = ['jma', 'usgs', 'noaa', 'nmc_alarm'];
/** 走 SSE 的源（0.5.0）：状态从 cnStreamRegistry 实时读。 */
const STREAM_ORDER = ['cenc_eew', 'cenc_eqlist'];
/**
 * 海外源（0.6.0）：Client 直连的 REST 轮询，计数从 `overseasStatsOf` 实时读。
 * 单独一张表而不是并进 FEED_STAT_ORDER——那边的字段是"增量 / 游标 / Host 计数"，
 * 语义不同，混在一起就得靠形状判断猜来源。
 */
const OVERSEAS_STAT_ORDER = ['nws_alerts', 'eccc_alerts'];
/**
 * 源状态区块（0.4.1）。
 *
 * 拆成独立组件的理由：它显示"最近拉取 N 秒前"，需要自己走时钟；而此前这段逻辑挂在
 * 设置页主组件里，5 秒一次的 setState 会**重建整个设置页**——关注县较多时那意味着
 * 每次最多 47×200 个市町村按钮一起重建，输入明显卡顿。现在只有这一小块重渲。
 *
 * 内容也扩了：除本地的增量 / 失败计数，还显示 Host 侧的失败与放弃数（来自 /feed?stats=1）。
 * 只显示本地计数的话，「上游被墙」与「上游没有新闻」仍然不可区分。
 */
function SourceStatusBlock() {
  const [, setTick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setTick((x) => x + 1), 5000);
    return () => clearInterval(t)
  }, []);
  // 订阅 store：源的连接 / 数据状态变化要立刻反映（不必等那 5 秒的时钟）
  useEffect(() => store.subscribe(() => setTick((x) => x + 1)), []);
  const rows = [];
  const sources = store.sources || {};
  for (const id of SOURCE_ORDER) {
    const st = sources[id];
    if (!st) continue
    const meta = statusMetaOf(st.status, st.retries);
    rows.push((st.label || SOURCE_LABELS[id] || id) + '：' + meta.text + (st.detail ? ' · ' + st.detail : ''));
  }
  for (const id of FEED_STAT_ORDER) {
    const f = feedStatsOf[id];
    const st = sources[id];
    if (!f) {
      if (!st) rows.push((SOURCE_LABELS[id] || id) + '：尚未拉取');
      continue
    }
    const host = f.host || {};
    const ago = f.lastAt ? Math.max(0, Math.round((Date.now() - f.lastAt) / 1000)) + ' 秒前' : '—';
    rows.push((SOURCE_LABELS[id] || id) + '：已收到 ' + f.received + ' 条增量' +
      (f.errors ? '，本地失败 ' + f.errors + ' 次' : '') +
      (f.truncated ? '，增量缺口 ' + f.truncated + ' 次' : '') +
      (f.resets ? '，游标重置 ' + f.resets + ' 次' : '') +
      (Number(host.errors) ? '，Host 失败 ' + host.errors + ' 次' : '') +
      (Number(host.detailDropped) ? '，Host 放弃详情 ' + host.detailDropped + ' 条' : '') +
      ' · 最近拉取 ' + ago);
  }
  // 海外源（0.6.0）：按关注点查询外部 REST。显示"查了几轮 / 发了多少请求 / 收到几条"，
  // 以及两个只有这个形态才有的计数：**过老只记历史**（年龄闸门）与**不在覆盖范围**
  // （NWS 对覆盖外的坐标回 400——那不是故障，见 12e 的说明）。
  for (const id of OVERSEAS_STAT_ORDER) {
    const o = overseasStatsOf[id];
    const st = sources[id];
    if (!o) {
      if (!st) rows.push((SOURCE_LABELS[id] || id) + '：尚未查询');
      continue
    }
    const ago = o.lastAt ? Math.max(0, Math.round((Date.now() - o.lastAt) / 1000)) + ' 秒前' : '—';
    rows.push((SOURCE_LABELS[id] || id) + '：已查询 ' + (o.polls || 0) + ' 轮 · 请求 ' + (o.requests || 0) +
      ' 次 · 收到 ' + (o.received || 0) + ' 条' +
      (o.applied ? '，交给主链 ' + o.applied + ' 条' : '') +
      (o.ageSkipped ? '，过老只记历史 ' + o.ageSkipped + ' 条' : '') +
      (o.rejected ? '，被上游拒绝 ' + o.rejected + ' 次' : '') +
      (o.throttledLast ? '，本轮超上限跳过 ' + o.throttledLast + ' 个请求' : '') +
      (o.errors ? '，失败 ' + o.errors + ' 次' : '') +
      ' · 最近查询 ' + ago);
  }
  // 大陆源（0.5.0）：走 SSE，状态从注册表**实时**读。**链路模式必须显示出来**——
  // 降级到轮询意味着延迟从秒级变成最长 15 秒，用户有权知道自己在哪条路上。
  for (const id of STREAM_ORDER) {
    const reg = cnStreamRegistry[id];
    const st = sources[id];
    if (!reg) {
      if (!st) rows.push((SOURCE_LABELS[id] || id) + '：尚未启动');
      continue
    }
    const c = reg.stats();
    const modeText = c.mode === 'sse' ? 'SSE 推送'
      : (c.mode === 'poll' ? '已降级为轮询'
        : (c.mode === 'disabled' ? '已关闭（「地震」开关关掉了）' : '未连接'));
    const ago = c.lastAt ? Math.max(0, Math.round((Date.now() - c.lastAt) / 1000)) + ' 秒前' : '—';
    rows.push((SOURCE_LABELS[id] || id) + '：' + modeText +
      ' · 已收到 ' + c.received + ' 条' +
      (c.applied ? '，已播报 ' + c.applied : '') +
      (c.errors ? '，失败 ' + c.errors + ' 次' : '') +
      (c.fallbacks ? '，降级 ' + c.fallbacks + ' 次' : '') +
      (c.probeTimeouts ? '，无首帧 ' + c.probeTimeouts + ' 次' : '') +
      (c.truncated ? '，增量缺口 ' + c.truncated + ' 次' : '') +
      (c.resets ? '，游标重置 ' + c.resets + ' 次' : '') +
      ' · 最近数据 ' + ago);
  }
  if (rows.length === 0) return null
  // 数据格式异常（schema-error）：按 DESIGN 5.4 提供**手动重试**——源改版后字段可能又回来了，
  // 用户不该为了清掉一个蓝点去重装插件。
  const retryRows = SOURCE_ORDER
    .filter((id) => sources[id] && sources[id].status === 'schema-error')
    .map((id) => h('div', { key: 'retry-' + id, style: { marginTop: 4 } },
      s.btn('重试 ' + (sources[id].label || SOURCE_LABELS[id] || id) + ' 的数据解析', () => retrySource(id))));
  return h('div', { style: { marginTop: 10, fontSize: 11, color: '#9aa0a6', lineHeight: 1.7 } },
    h('div', { style: { marginBottom: 2 } }, '源状态'),
    rows.map((t, i) => h('div', { key: 'feedstat-' + i }, t)),
    retryRows)
}

function SettingsPanel() {
  const [cfg, setCfgState] = useState(() => currentCfg());
  const [, setTick] = useState(0);
  const [perm, setPerm] = useState(() => notificationPermission());
  const [testMsg, setTestMsg] = useState('');
  const [expanded, setExpanded] = useState(null);
  const [cityQuery, setCityQuery] = useState({}); // 每个县的市町村搜索词
  const [weatherTestMsg, setWeatherTestMsg] = useState(''); // 「发送测试气象警报」的结果提示
  const [weatherTestSeq, setWeatherTestSeq] = useState(0); // 测试场景轮换游标
  // 全球关注点的输入草稿与反馈（0.4.0）：校验失败必须给出文字原因，不能静默吞掉用户输入
  // 半径默认值 0.5.0 起是 100（DESIGN 9.2）；**既有配置里的 radiusKm 不动**，只影响新建。
  const [placeDraft, setPlaceDraft] = useState({ name: '', lat: '', lon: '', radiusKm: String(DEFAULT_PLACE_RADIUS_KM) });
  const [placeMsg, setPlaceMsg] = useState('');
  // 中国大陆的三级级联（0.5.0）：省 → 地级市 → 半径。选完给出**表里的坐标**，
  // 用户不需要知道经纬度（大陆源是坐标 + 半径匹配，见 DESIGN 8.3）。
  const [cnPick, setCnPick] = useState({ province: '', city: '', radiusKm: DEFAULT_PLACE_RADIUS_KM });
  const [cnMsg, setCnMsg] = useState('');
  // 全球链路的测试（0.4.0）：场景轮换游标与结果提示
  const [geTestSeq, setGeTestSeq] = useState(0);
  const [geTestMsg, setGeTestMsg] = useState('');
  // 诊断快照（0.5.0）：{ text, msg } | null
  const [diag, setDiag] = useState(null);
  // 「源状态」区块里的相对时间要自己走 —— 见 SourceStatusBlock（独立组件，避免每 5 秒
  // 重渲整个设置页，尤其是关注县较多时那几千个市町村按钮）
  // 音量滑块：拖动期间只改本地草稿，停手 300ms 后才落盘（避免每移动 1px 写一次 localStorage）
  const [volDraft, setVolDraft] = useState(null);
  const volTimer = useRef(null);
  const volPending = useRef(null); // 尚未落盘的草稿值：卸载时补写，拖完立刻关设置页也不丢改动
  const restartTimer = useRef(null); // 切换数据源后的重启延时（见下方）
  // store 变化（新预警、Host 配置同步）都要重新读一次当前配置
  useEffect(() => store.subscribe(() => { setTick((t) => t + 1); setCfgState(currentCfg()); }), []);
  useEffect(() => () => {
    if (volTimer.current) { clearTimeout(volTimer.current); volTimer.current = null; }
    if (restartTimer.current) { clearTimeout(restartTimer.current); restartTimer.current = null; }
    const v = volPending.current;
    if (v !== null) {
      volPending.current = null;
      // 卸载中不能 setState，只补写盘。必须经 applyCfg 而不是 saveCfg：
      // saveCfg 只写 localStorage 镜像，不改内存也不推 Host —— 有 Host settings 时
      // 下次同步会被 Host 的旧值覆盖回来，音量改动照样丢（0.2.0 声称修过这个场景）。
      const cur = currentCfg();
      applyCfg({ ...cur, notify: { ...cur.notify, volume: v } });
    }
  }, []);
  // 其它 DSH 标签页改了配置 → 由 15-entry 的常驻 storage 监听统一回读并 store.push()，
  // 本组件通过下面的 store.subscribe 跟随。监听放在这里（组件内）的话，只有设置页打开着
  // 才同步；没打开设置页的标签页会一直按旧配置提醒。

  // 立即基于最新配置计算（内存 + localStorage 镜像 + Host），再 setState
  const setCfg = (fn) => { const next = applyCfg(fn(currentCfg())); setCfgState(next); };
  const togglePref = (jp) => setCfg((c) => {
    const cur = c.watch.prefectures;
    const removing = cur.indexOf(jp) !== -1;
    const next = removing ? cur.filter((p) => p !== jp) : cur.concat(jp);
    // 取消关注某个县时，同时清掉它下面已选的市町村（避免留下永远不生效的条目）
    const cities = removing
      ? c.watch.cities.filter((city) => citiesOfPref(jp).indexOf(city) === -1)
      : c.watch.cities;
    return { ...c, watch: { ...c.watch, prefectures: next, cities } }
  });
  const toggleCity = (city) => setCfg((c) => {
    const cur = c.watch.cities;
    let next = cur.indexOf(city) === -1 ? cur.concat(city) : cur.filter((x) => x !== city);
    if (next.length > MAX_WATCH_CITIES) next = next.slice(0, MAX_WATCH_CITIES);
    return { ...c, watch: { ...c.watch, cities: next } }
  });

  // ---------- 全球关注点（0.4.0）----------
  // 全球源给的是震中坐标，没有都道府县，所以关注表达是「位置 + 半径」。
  // 校验放在这里而不是只靠 normalizeCfg：用户需要看到"为什么没加上"，静默吞掉输入最糟。
  const addPlace = () => {
    const places = cfg.watch.places || [];
    const lat = Number(String(placeDraft.lat).trim());
    const lon = Number(String(placeDraft.lon).trim());
    const radiusKm = Number(String(placeDraft.radiusKm).trim());
    if (String(placeDraft.lat).trim() === '' || !Number.isFinite(lat) || Math.abs(lat) > 90) {
      setPlaceMsg('纬度需要是 -90 ~ 90 之间的数字'); return
    }
    if (String(placeDraft.lon).trim() === '' || !Number.isFinite(lon) || Math.abs(lon) > 180) {
      setPlaceMsg('经度需要是 -180 ~ 180 之间的数字'); return
    }
    if (!Number.isFinite(radiusKm) || radiusKm < 1 || radiusKm > 2000) {
      setPlaceMsg('半径需要是 1 ~ 2000 km 之间的数字'); return
    }
    if (places.length >= MAX_WATCH_PLACES) {
      setPlaceMsg('最多 ' + MAX_WATCH_PLACES + ' 个关注点'); return
    }
    const name = String(placeDraft.name || '').trim() || (lat.toFixed(2) + ', ' + lon.toFixed(2));
    setCfg((c) => ({ ...c, watch: { ...c.watch, places: (c.watch.places || []).concat([{ name, lat, lon, radiusKm }]) } }));
    setPlaceDraft({ name: '', lat: '', lon: '', radiusKm: String(radiusKm) });
    setPlaceMsg('已添加「' + name + '」（坐标相同的重复点会被自动合并）');
  };
  const removePlace = (idx) => setCfg((c) => ({
    ...c, watch: { ...c.watch, places: (c.watch.places || []).filter((_, i) => i !== idx) },
  }));
  const useMyLocation = () => {
    const geo = (typeof navigator !== 'undefined') ? navigator.geolocation : null;
    if (!geo || typeof geo.getCurrentPosition !== 'function') { setPlaceMsg('当前浏览器不支持定位，请手动填写坐标'); return }
    setPlaceMsg('正在获取当前位置…');
    geo.getCurrentPosition(
      (pos) => {
        const c = pos && pos.coords;
        if (!c) { setPlaceMsg('定位失败：没有返回坐标'); return }
        setPlaceDraft((d) => ({
          ...d,
          name: d.name || '我的位置',
          lat: String(c.latitude.toFixed(4)),
          lon: String(c.longitude.toFixed(4)),
        }));
        setPlaceMsg('已填入当前位置，确认半径后点「添加关注点」');
      },
      (err) => setPlaceMsg('定位失败：' + ((err && err.message) || '被拒绝或不可用')),
      { timeout: 10000 },
    );
  };
  /** 定位并**直接添加**一个关注点（大陆级联里的用法：半径已经在级联里选好了，
   *  再让用户去另一个表单点一次「添加」是多余的一步）。 */
  const addMyLocationPlace = () => {
    const geo = (typeof navigator !== 'undefined') ? navigator.geolocation : null;
    if (!geo || typeof geo.getCurrentPosition !== 'function') { setCnMsg('当前浏览器不支持定位，请选择省份与城市'); return }
    setCnMsg('正在获取当前位置…');
    geo.getCurrentPosition(
      (pos) => {
        const c = pos && pos.coords;
        if (!c) { setCnMsg('定位失败：没有返回坐标'); return }
        const lat = Math.round(c.latitude * 100) / 100;
        const lon = Math.round(c.longitude * 100) / 100;
        if ((cfg.watch.places || []).length >= MAX_WATCH_PLACES) { setCnMsg('最多 ' + MAX_WATCH_PLACES + ' 个关注点'); return }
        setCfg((cf) => ({
          ...cf,
          watch: { ...cf.watch, places: (cf.watch.places || []).concat([{ name: '我的位置', lat, lon, radiusKm: cnPick.radiusKm }]) },
        }));
        // 台式机的定位靠 WiFi / IP 库，可能不准 —— 如实说，别让用户以为这就是精确位置
        setCnMsg('已添加「我的位置」（' + lat + ', ' + lon + '，半径 ' + cnPick.radiusKm +
          ' km）。定位可能不精确，请确认坐标或改用手动选择城市。');
      },
      (err) => setCnMsg('定位失败：' + ((err && err.message) || '被拒绝或不可用') + '（也可以手动选择省份与城市）'),
      { timeout: 10000 },
    );
  };

  /** 关注点输入框（受控）：四个字段共用一份草稿。 */
  const placeField = (label, key, placeholder, width) => h('label', {
    style: { display: 'flex', flexDirection: 'column', gap: 2, fontSize: 11, color: '#9aa0a6' },
  }, label, h('input', {
    type: 'text',
    value: placeDraft[key],
    placeholder,
    onChange: (e) => setPlaceDraft((d) => Object.assign({}, d, { [key]: e.target.value })),
    style: {
      width, boxSizing: 'border-box', background: '#ffffff', color: '#1a1a1a',
      border: '1px solid #6b7280', borderRadius: 6, padding: '3px 6px', fontSize: 12,
    },
  }));

  // ---------- 半径控件（0.5.0 / DESIGN 9.2）----------
  /** 当前值是否正好是某个语义档。 */
  const isRadiusPreset = (km) => RADIUS_PRESETS.some((o) => o.v === Number(km));
  /**
   * 半径选择：三档**语义标签** + 一个始终可见的数字输入。
   *
   * 为什么两者都要：普通用户不必理解"公里"，语义档就够；而"想精确控制的人有出口"
   * 是 DESIGN 9.2 的硬要求——把数字藏进"自定义…"分支会让改一次半径多两步。
   * 数字框是真实值，下拉只是快捷键；填了 150 这种非档位值时下拉自动显示「自定义」。
   */
  const radiusControl = (km, onChange, key) => h('div', {
    key: key || 'radius',
    style: { display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, color: '#9aa0a6', flexWrap: 'wrap' },
  },
    h('span', null, '半径'),
    s.select(isRadiusPreset(km) ? Number(km) : 'custom',
      RADIUS_PRESETS.concat([{ v: 'custom', label: '自定义…' }]),
      (v) => { if (v !== 'custom') onChange(Number(v)); },
      (o) => o.label),
    h('input', {
      type: 'number', min: MIN_PLACE_RADIUS_KM, max: MAX_PLACE_RADIUS_KM, value: km,
      onChange: (e) => {
        const raw = String(e.target.value).trim();
        if (raw === '') return // 输入中间态（全删）不写进配置，等用户填完
        const v = Number(raw);
        if (!Number.isFinite(v)) return
        onChange(Math.min(MAX_PLACE_RADIUS_KM, Math.max(MIN_PLACE_RADIUS_KM, Math.round(v))));
      },
      style: {
        width: 68, boxSizing: 'border-box', background: '#ffffff', color: '#1a1a1a',
        border: '1px solid #6b7280', borderRadius: 6, padding: '3px 6px', fontSize: 12,
      },
    }),
    h('span', null, 'km'),
  );

  // ---------- 中国大陆的三级级联（0.5.0）----------
  const provinces = cnProvinces();
  /** 选了省之后，市默认落在第一个上——否则用户会以为"选了省但没反应"。 */
  const pickProvince = (province) => {
    const cities = cnCitiesOf(province);
    setCnPick((p) => ({ ...p, province, city: cities.length ? cities[0].name : '' }));
    setCnMsg('');
  };
  const addCnPlace = () => {
    const p = cnPlaceOf(cnPick.province, cnPick.city, cnPick.radiusKm);
    if (!p) { setCnMsg('请先选择省份与城市（行政区划表未加载时请重启 dsh web）'); return }
    if ((cfg.watch.places || []).length >= MAX_WATCH_PLACES) { setCnMsg('最多 ' + MAX_WATCH_PLACES + ' 个关注点'); return }
    if ((cfg.watch.places || []).some((x) => x.name === p.name)) { setCnMsg('「' + p.name + '」已经在关注列表里了'); return }
    setCfg((c) => ({ ...c, watch: { ...c.watch, places: (c.watch.places || []).concat([p]) } }));
    setCnMsg('已添加「' + p.name + '」（' + p.lat + ', ' + p.lon + '，半径 ' + p.radiusKm + ' km）');
  };
  /** 国家 / 地区级联的第一级（中国）——省的选项。 */
  const cnCascade = () => {
    if (provinces.length === 0) {
      return h('div', { style: { fontSize: 11, color: cityTableState === 'failed' ? '#d9a406' : '#9aa0a6', marginTop: 6 } },
        cityTableState === 'failed'
          ? '行政区划表加载失败 —— 可以改用下面的「其他地区」手填坐标（可重启 dsh web 重试）'
          : '正在加载行政区划表…')
    }
    const cities = cnCitiesOf(cnPick.province);
    const provOptions = [{ v: '', label: '请选择省份 / 直辖市 / 特别行政区' }]
      .concat(provinces.map((p) => ({ v: p.name, label: p.name })));
    const cityOptions = (cities.length ? cities : [{ name: '' }]).map((c) => ({ v: c.name, label: c.name || '（先选省份）' }));
    return h('div', null,
      h('div', { style: { display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' } },
        s.select(cnPick.province, provOptions, pickProvince, (o) => o.label, '一级行政区（省 / 自治区 / 直辖市）'),
        s.select(cnPick.city, cityOptions, (v) => { setCnPick((p) => ({ ...p, city: v })); setCnMsg(''); }, (o) => o.label, '城市'),
      ),
      h('div', { style: { marginTop: 6 } },
        radiusControl(cnPick.radiusKm, (v) => setCnPick((p) => ({ ...p, radiusKm: v })), 'cn-radius')),
      h('div', { style: { marginTop: 8, display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' } },
        s.btn('添加这个城市', addCnPlace),
        s.btn('用我的位置', addMyLocationPlace, { fontSize: 11 }),
      ),
      cnMsg ? h('div', { role: 'status', style: { fontSize: 11, color: '#93c5fd', marginTop: 6 } }, cnMsg) : null,
    )
  };
  // 全球源状态（0.4.0）：用户看不出"链路到底在不在拉"，这是最常见的困惑来源——
  // 尤其全球地震本来就不频繁。feedStatsOf 不经过 store（见 12b 的注释），
  // 所以由 SourceStatusBlock 自己每 5 秒重读（见文件下方）。
  // 市区町村选择器：数据表到位后，为每个已关注的县提供「搜索 + 多选」
  const cityPicker = () => {
    if (cityTableState === 'failed') {
      return h('div', { style: { fontSize: 11, color: '#d9a406', marginTop: 10 } },
        '市区町村表加载失败 —— 当前仅支持按都道府县关注（可重启 dsh web 重试）')
    }
    if (cfg.watch.prefectures.length === 0) {
      return h('div', { style: { fontSize: 11, color: '#9aa0a6', marginTop: 10 } },
        '先选择都道府县，再可选地细化到市区町村')
    }
    if (cityTableState !== 'ready') {
      return h('div', { style: { fontSize: 11, color: '#9aa0a6', marginTop: 10 } }, '正在加载市区町村表…')
    }
    return h('div', { style: { marginTop: 10 } },
      h('div', { style: { fontSize: 11, color: '#9aa0a6', marginBottom: 4 } },
        '可选细化到市区町村（不选 = 该县全境）。只有地震情报的观测点有市町村粒度；EEW 与海啸是区域级，仍按县判定。'),
      cfg.watch.prefectures.map((pref) => {
        const list = citiesOfPref(pref);
        if (list.length === 0) return null
        const q = cityQuery[pref] || '';
        const shown = q ? list.filter((c) => c.indexOf(q) !== -1) : list;
        const sel = list.filter((c) => cfg.watch.cities.indexOf(c) !== -1).length;
        return h('div', { key: pref, style: { border: '1px solid rgba(148,163,184,0.18)', borderRadius: 6, padding: '6px 8px', margin: '6px 0' } },
          h('div', { style: { fontSize: 12, color: '#dfe3e8', marginBottom: 4 } },
            pref + '：' + (sel === 0 ? '全境（未细化）' : '已选 ' + sel + ' 个市町村')),
          h('input', {
            type: 'text', value: q, placeholder: '搜索 ' + pref + ' 的市町村…',
            'aria-label': '搜索 ' + pref + ' 的市町村',
            onChange: (e) => setCityQuery((prev) => Object.assign({}, prev, { [pref]: e.target.value })),
            style: { width: '100%', boxSizing: 'border-box', background: '#ffffff', color: '#1a1a1a', border: '1px solid #6b7280', borderRadius: 6, padding: '3px 8px', fontSize: 12, marginBottom: 5 },
          }),
          h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 4, maxHeight: 150, overflowY: 'auto' } },
            shown.slice(0, 200).map((city) => {
              const on = cfg.watch.cities.indexOf(city) !== -1;
              return h('button', {
                key: city, onClick: () => toggleCity(city),
                style: {
                  fontSize: 11, padding: '2px 8px', borderRadius: 11, cursor: 'pointer',
                  border: '1px solid ' + (on ? '#3b82f6' : 'rgba(148,163,184,0.3)'),
                  background: on ? 'rgba(59,130,246,0.18)' : 'transparent',
                  color: on ? '#93c5fd' : '#9aa0a6',
                },
              }, city)
            }),
            shown.length > 200
              ? h('span', { style: { fontSize: 11, color: '#9aa0a6' } }, '…共 ' + shown.length + ' 个，请用搜索缩小范围')
              : null),
        )
      }),
    )
  };
  // 灾害类型（0.3.0）：三个开关并列。气象灾害的操作边界写死在 L4，不给阈值旋钮——
  // L1/L2 的正确行动不是桌面弹窗，L3 面向老年人；L4（避難指示级）才真正涉及人身财产损失。
  // 因此这里只有"开 / 关"，没有第三档（DESIGN 10.3）。
  const sectionDisasters = () => s.section('灾害类型',
    s.row(
      s.checkbox(cfg.disasters.earthquake !== false,
        (v) => setCfg((c) => ({ ...c, disasters: { ...c.disasters, earthquake: v } })), '地震 / 紧急地震速报'),
      s.checkbox(cfg.disasters.tsunami !== false,
        (v) => setCfg((c) => ({ ...c, disasters: { ...c.disasters, tsunami: v } })), '海啸'),
      s.checkbox(cfg.disasters.weather !== false,
        (v) => setCfg((c) => ({ ...c, disasters: { ...c.disasters, weather: v } })), '气象灾害'),
    ),
    h('div', { style: { fontSize: 11, color: '#9aa0a6', marginTop: 6, lineHeight: 1.6 } },
      '气象灾害＝泥石流 / 洪水 / 大雨 / 高潮 等。只播报警戒レベル4 以上（相当于日本的「避难指示」级：' +
      '土砂災害警戒情報、氾濫危険情報、大雨特別警報…）；L1〜L3 仍然解析并记入下方「最近预警记录」，只是不响铃、不弹通知。'),
    // 中国大陆气象灾害（0.5.2）：**两个灾种分开**。它们来自同一个源（中央气象台汇总的
    // 预警信号列表），但产出差别很大——暴雨的橙 / 红常年可见，而地质灾害实测全是黄色
    // （达不到播报门槛，只在历史里留痕）。合成一个开关会让"我只想要暴雨"的用户找不到出口。
    h('div', { style: { fontSize: 12, color: '#9aa0a6', marginTop: 12, marginBottom: 2 } },
      '中国大陆气象灾害（中央气象台汇总各级气象台发布）'),
    s.row(
      s.checkbox(cfg.disasters.cnRainstorm !== false,
        (v) => setCfg((c) => ({ ...c, disasters: { ...c.disasters, cnRainstorm: v } })), '暴雨预警'),
      s.checkbox(cfg.disasters.cnGeology !== false,
        (v) => setCfg((c) => ({ ...c, disasters: { ...c.disasters, cnGeology: v } })), '地质灾害预警'),
    ),
    h('div', { style: { fontSize: 11, color: '#9aa0a6', marginTop: 4, lineHeight: 1.6 } },
      // 注意：这是**界面文本**（React 文本节点），不是 markdown——写 `**粗体**` 会在页面上
      // 原样渲染出星号。强调靠语序，不靠标记。
      '只接暴雨与地质灾害两类（雷电 / 大风 / 高温等其余灾种不接，否则会被每天几十条刷屏）。' +
      '只播报橙色及以上；黄色 / 蓝色仍然记录在下方「最近预警记录」里，只是不响铃、不弹通知' +
      '（因此静默时段默认也不会放行橙色——它只在红色时穿透）。' +
      '匹配按行政区层级：在「中国大陆」里选到的省 / 市才算关注点，自由填写的坐标点不参与；' +
      '机构名只报出省级（如海南省直辖县）时会按整个省放行，宁可多报一次也不漏报。' +
      '与大陆地震源一样，这批数据没有「解除」标志——预警到期会直接从这个列表里消失，' +
      '所以"没收到取消"不等于"警报仍然有效"。'),
    store.weatherHint
      ? h('div', { style: { fontSize: 11, color: '#d9a406', marginTop: 4 } },
          '当前：' + (store.weatherHint.label || '') +
          ' 有 L' + store.weatherHint.level + ' 气象警报（未达 L4，未播报）')
      : null,
    // 海外气象灾害（0.6.0）：美国 NWS + 加拿大 ECCC。
    // **一个开关覆盖两个源**——与上面大陆那两个灾种不同：那一对是"同一个端点、产出差别极大"
    // （暴雨常年可见、地质灾害全是黄色），而这两个源是各自独立的，各按关注点生效：
    // 只配美国坐标就只收到美国预警，不需要再加一个开关（DESIGN 4.7.6）。
    h('div', { style: { fontSize: 12, color: '#9aa0a6', marginTop: 12, marginBottom: 2 } },
      '海外气象灾害（美国 NWS / 加拿大 ECCC）'),
    s.row(
      s.checkbox(cfg.disasters.overseasWeather !== false,
        (v) => setCfg((c) => ({ ...c, disasters: { ...c.disasters, overseasWeather: v } })),
        '洪水 / 山洪 / 降雨 / 风暴潮预警'),
    ),
    h('div', { style: { fontSize: 11, color: '#9aa0a6', marginTop: 4, lineHeight: 1.6 } },
      '关注点在「③ 其他地区：坐标 + 半径」里配。美国源按 NWS 的县 / 区划判定——' +
      '半径 ≥ 25km 时会在中心点之外补查 4 个方位点，所以半径对它是近似（不保证覆盖半径内的所有县）；' +
      '加拿大源把半径换算成一个矩形范围向 ECCC 查询，凡与该范围相交的预警都算命中。' +
      '美国只播报 Flood / Flash Flood / Coastal Flood Warning，Watch、Advisory、Statement 只记入历史；' +
      '加拿大只接 warning 类的降雨 / 洪水 / 风暴潮（霜冻、雾、大风等既非危险天气、也不在本插件灾种内）。' +
      '打开页面时若某条预警已发布超过 6 小时，只记入历史、不响铃。' +
      '数据来源：美国国家气象局（NWS）；加拿大环境与气候变化部（ECCC，Data Source: Environment and Climate Change Canada）。'),
    // 无灾情时也能验证整条链路：用本地构造的电文走完 解析 → 匹配 → 播报 → 历史，
    // 不产生任何外部请求。每次点击轮换一种场景，覆盖级别落点与区域粒度的不同分支。
    // 区域取关注列表首项，保证一定命中（否则点了没反应会让人以为坏了）。
    s.row(s.btn('发送测试气象警报（轮换场景）', () => {
      const pref = (cfg.watch.prefectures && cfg.watch.prefectures[0]) || '東京都';
      const sc = TEST_SCENARIOS[weatherTestSeq % TEST_SCENARIOS.length];
      const ms = Date.now();
      const city = citiesOfPref(pref)[0] || ''; // 市町村级场景用真实市町村名
      const alert = parseJma(buildTestTelegram(pref, ms, sc.key, city), { id: 'test-weather-' + ms });
      setWeatherTestSeq(weatherTestSeq + 1);
      if (!alert) { setWeatherTestMsg('测试电文解析失败 —— 请把这个情况反馈给开发者'); return }
      // 事件键改成**每次都不同**（0.5.4），否则同一场景第二次就静默：汇总型电文的事件键是
      // 「灾种 + 官署」（刻意不含发布时刻，见 05b 的说明），于是连点两次会算出同一个键，
      // 被 `isEventRepeat` 判成"同一事件的后续发布（强度未升级）"而只记历史——与按钮文案
      // "可反复点击"直接矛盾。全球链路早就显式改写过事件键（05c 的 parseTestGlobalMessage），
      // 气象这条漏了。语义上也成立：每次点击本来就是一次独立的演示。
      alert.eventKey = 'test-weather:' + ms + ':' + sc.key;
      const res = handleAlert(alert, currentCfg(), { skipQuietHours: true });
      // 提示按**实际结果**生成，不写死"应看到弹窗"——开关关闭 / 未达 L4 / 静默 / 其它标签页
      // 已提醒时，实际就是不会响，提示必须如实说明，否则会让人以为插件坏了。
      const outcome = res && res.notified
        ? ' —— 已播报：应看到提示音与弹窗'
        : ' —— 未播报（' + ((res && res.detail) || '未知原因') + '），只会记入下方「最近预警记录」';
      setWeatherTestMsg('已发送：' + sc.label + '（' + pref + ' / 警戒レベル' + alert.level + '，' + sc.note + '）' + outcome);
    })),
    h('div', { style: { fontSize: 11, color: '#9aa0a6', marginTop: 4, lineHeight: 1.6 } },
      '测试电文在本地构造，不发任何网络请求，可反复点击。场景依次为：' +
      TEST_SCENARIOS.map((x) => x.label).join(' / ') +
      '。其中 L3 那条刻意不会响铃——用来演示 L1〜L3 的处理方式。'),
    weatherTestMsg
      ? h('div', { role: 'status', style: { color: '#93c5fd', fontSize: 11, marginTop: 4 } }, weatherTestMsg)
      : null,
  );
  const flushVolume = () => {
    if (volTimer.current) { clearTimeout(volTimer.current); volTimer.current = null; }
    const v = volPending.current;
    if (v === null) return
    volPending.current = null;
    setVolDraft(null);
    setCfg((c) => ({ ...c, notify: { ...c.notify, volume: v } }));
  };
  const onVolumeInput = (v) => {
    volPending.current = v;
    setVolDraft(v);
    if (volTimer.current) clearTimeout(volTimer.current);
    volTimer.current = setTimeout(flushVolume, 300);
  };
  const volShown = volDraft === null ? cfg.notify.volume : volDraft;

  const statusMeta = statusMetaOf(store.status, store.retries);
  const dot = h('span', { style: { display: 'inline-block', width: 10, height: 10, borderRadius: '50%', background: statusMeta.color, marginRight: 8 } });

  const permText = {
    granted: '通知权限：已授权',
    denied: '通知权限：被拒绝（请在浏览器站点设置中允许）',
    default: '通知权限：未授权 — 点下方「测试系统通知」授权',
    unsupported: '当前浏览器不支持系统通知',
  }[perm] || '';

  return h('div', { style: { fontFamily: 'system-ui, sans-serif', fontSize: 13, color: '#dfe3e8' } },
    // 连接状态 + 数据源（测试切换）
    s.section('连接状态',
      h('div', { style: { display: 'flex', alignItems: 'center', gap: 6, marginBottom: 8 } },
        dot,
        h('span', { style: { fontWeight: 600 } }, statusMeta.text),
        h('span', { style: { color: '#9aa0a6', fontSize: 11 } }, store.detail || ''),
        store.received > 0
          ? h('span', { style: { color: '#4ade80', fontSize: 11, border: '1px solid rgba(74,222,128,0.4)', borderRadius: 10, padding: '0 6px' } },
              '已收到 ' + store.received + ' 条推送')
          : null),
      s.label('数据源'),
      s.row(
        s.select(cfg.source, [
          { v: 'prod', label: '正式：P2PQuake 实时推送' },
          { v: 'sandbox', label: '沙箱：回放 2023 年历史（约30秒/条，测试用）' },
        ], (v) => {
          setCfg((c) => ({ ...c, source: v }));
          // 延时用 ref 保存并在卸载时清理：否则"切换数据源后 80ms 内离开设置页 / 停用插件"
          // 会在到点时复活一个已经没有任何 fiber 归属的 socket（它会继续上报状态并经
          // handleAlert 响铃），直到用户刷新页面。执行前再复查一次 activeClient。
          if (restartTimer.current) clearTimeout(restartTimer.current);
          restartTimer.current = setTimeout(() => {
            restartTimer.current = null;
            const c = activeClient; // 模块级 live binding：插件停用时已被置为 null
            if (c) { try { c.restart(); } catch (err) { /* 忽略 */ } }
          }, 80);
        }, (o) => o.label, '数据源'),
      ),
      h('div', { style: { fontSize: 11, color: '#9aa0a6', marginTop: 6 } },
        '配置存储：' + settingsSyncLabel()),
    ),

    // 关注地区
    // 关注地区按**国家 / 地区**分组（DESIGN 9 的"三级级联"：国家/地区 → 一级行政区 → 市/町村）。
    // 为什么不做成一个统一的下拉级联组件：日本这一路是 47 个都道府县 + 1917 个市区町村的两级多选，
    // 中国这一路是省 → 地级市，两者的**选择语义不同**（日本源按行政区名匹配，大陆源按坐标 + 半径）。
    // 硬塞进同一个控件只会让两边都变得难用；这里保证的是**用户视角的三级结构一致**。
    s.section('① 日本：都道府县 / 市区町村',
      h('div', { style: { fontSize: 11, color: '#9aa0a6', marginBottom: 8 } },
        cfg.watch.prefectures.length === 0
          ? '未选择 → 将提醒全日本（按下方阈值过滤）。建议选择你所在/关注的地区以减少打扰。'
          : '已关注 ' + cfg.watch.prefectures.length + ' 个地区'),
      h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 5 } },
        PREFECTURES.map((p) => {
          const on = cfg.watch.prefectures.indexOf(p.jp) !== -1;
          return h('button', {
            key: p.jp,
            onClick: () => togglePref(p.jp),
            style: {
              fontSize: 11, padding: '2px 9px', borderRadius: 12, cursor: 'pointer',
              border: '1px solid ' + (on ? '#3b82f6' : 'rgba(148,163,184,0.3)'),
              background: on ? 'rgba(59,130,246,0.18)' : 'transparent',
              color: on ? '#93c5fd' : '#9aa0a6',
            },
          }, p.zh)
        }),
      ),
      cityPicker(),
    ),

    // 灾害类型（0.3.0）
    sectionDisasters(),

    // 中国大陆（0.5.0）：省 → 地级市 → 半径。大陆源是坐标型，所以选完城市即得到坐标。
    s.section('② 中国大陆：省 / 地级市',
      h('div', { style: { fontSize: 11, color: '#9aa0a6', marginBottom: 8, lineHeight: 1.6 } },
        '中国地震台网的预警与速报按「震中坐标 + 半径」判定（大陆源没有分区烈度），' +
        '所以这里选城市即可，不需要知道经纬度。表里的坐标是**行政区中心点**——' +
        '面积特别大的州 / 市（如甘孜州、哈尔滨市）离城区可差一百多公里，住在边缘时请把半径调大，' +
        '或用「用我的位置」。'),
      // 无取消机制是**安全相关**的缺口：DESIGN 8.3 / 10.2 明确要求 UI 如实说明，不得假装能处理。
      // 不写这一句的话，用户"没收到取消"会自然读成"警报仍然有效"，而真实原因是这一路数据
      // 根本没有取消 / 最终报字段（日本 EEW 与海啸有那条链路，大陆源没有）。
      h('div', { style: { fontSize: 11, color: '#d9a406', marginBottom: 8, lineHeight: 1.6 } },
        '⚠ 这一路数据**没有取消 / 最终报标志**：此前播报过的预警若被上游撤销或修订，' +
        '插件不会补一条「已作废」（日本 EEW / 海啸有这条链路，大陆源没有）。' +
        '收到大陆预警后，请以中国地震台网（CENC）官方发布为准。'),
      cnCascade(),
    ),

    // 全球关注点（0.4.0）：全球源是坐标型，关注表达是「位置 + 半径」
    s.section('③ 其他地区：坐标 + 半径',
      h('div', { style: { fontSize: 11, color: '#9aa0a6', marginBottom: 8 } },
        (cfg.watch.places || []).length === 0
          ? '未设置时，全球源（EMSC / USGS 地震、NOAA 海啸）与海外气象源（美国 NWS、加拿大 ECCC）的消息不会打扰你。' +
            '添加你所在或关心的位置即可生效，不需要重启。' +
            '这里填的坐标与「② 中国大陆」加进来的城市是同一份列表。'
          : '已设置 ' + cfg.watch.places.length + ' 个位置：震中落在半径内才提醒。日本的地震 / 海啸不受这里影响，仍按上面的都道府县判定。'),
      ...(cfg.watch.places || []).map((p, i) => h('div', {
        key: 'place-' + i,
        style: { display: 'flex', alignItems: 'center', gap: 8, margin: '4px 0', fontSize: 12 },
      },
        h('span', { style: { flex: 1 } },
          p.name + ' · ' + Number(p.lat).toFixed(3) + ', ' + Number(p.lon).toFixed(3) + ' · 半径 ' + p.radiusKm + ' km'),
        s.btn('删除', () => removePlace(i)),
      )),
      h('div', { style: { display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'flex-end', marginTop: 8 } },
        placeField('名称', 'name', '如 东京 / 家', 120),
        placeField('纬度', 'lat', '35.6812', 90),
        placeField('经度', 'lon', '139.7671', 90),
        s.btn('添加关注点', addPlace),
        s.btn('用当前位置', useMyLocation),
      ),
      h('div', { style: { marginTop: 6 } },
        radiusControl(Number(placeDraft.radiusKm) || DEFAULT_PLACE_RADIUS_KM,
          (v) => setPlaceDraft((d) => ({ ...d, radiusKm: String(v) })), 'place-radius')),
      placeMsg ? h('div', { role: 'status', style: { fontSize: 11, color: '#93c5fd', marginTop: 6 } }, placeMsg) : null,
      // 全球源的地震不是随时都有，没法"等一条"来验证链路 —— 与气象链路一样给一个本地测试按钮。
      // 构造的是**源格式原文**（EMSC / USGS / NOAA 各一种），因此解析器与匹配引擎都被真实走过。
      h('div', { style: { marginTop: 10, borderTop: '1px solid rgba(148,163,184,0.18)', paddingTop: 8 } },
        s.row(s.btn('发送测试全球警报（轮换场景）', () => {
          const places = cfg.watch.places || [];
          if (places.length === 0) { setGeTestMsg('请先添加一个全球关注点 —— 测试消息需要一个位置来放震中'); return }
          const sc = TEST_GEO_SCENARIOS[geTestSeq % TEST_GEO_SCENARIOS.length];
          const ms = Date.now();
          const msg = buildTestGlobalMessage(places[0], ms, sc.key);
          setGeTestSeq(geTestSeq + 1);
          const alert = parseTestGlobalMessage(msg);
          if (!alert) { setGeTestMsg('测试消息解析失败 —— 请把这个情况反馈给开发者'); return }
          const res = handleAlert(alert, currentCfg(), { skipQuietHours: true });
          // 提示按**实际结果**生成：开关关闭 / 半径外 / 静默 / 其它标签页已提醒时就是不会响，
          // 必须如实说明，否则用户会以为插件坏了
          const outcome = res && res.notified
            ? ' —— 已播报：应看到提示音与弹窗'
            : ' —— 未播报（' + ((res && res.detail) || '未知原因') + '），只会记入下方「最近预警记录」';
          setGeTestMsg('已发送：' + sc.label + '（' + sc.note + '）' + outcome);
        })),
        h('div', { style: { fontSize: 11, color: '#9aa0a6', marginTop: 4, lineHeight: 1.6 } },
          '测试消息在本地构造（EMSC / USGS / NOAA 三种源格式轮换），不发任何网络请求，可反复点击。场景依次为：' +
          TEST_GEO_SCENARIOS.map((x) => x.label).join(' / ') +
          '。最后一条约 550km 外——半径小于这个距离时不命中，大于命中：用来演示半径是怎么起作用的。'),
        geTestMsg ? h('div', { role: 'status', style: { color: '#93c5fd', fontSize: 11, marginTop: 4 } }, geTestMsg) : null,
      ),
      h(SourceStatusBlock, { key: 'source-status' }),
    ),

    // 阈值
    s.section('提醒阈值',
      s.label('地震（实测震度最低值）'),
      s.row(s.select(cfg.thresholds.quakeScale, SCALE_OPTIONS, (v) => setCfg((c) => ({ ...c, thresholds: { ...c.thresholds, quakeScale: Number(v) } })), (o) => o.label, '地震（实测震度最低值）')),
      s.label('紧急地震速报（预测震度最低值）'),
      s.row(s.select(cfg.thresholds.eewScale, SCALE_OPTIONS, (v) => setCfg((c) => ({ ...c, thresholds: { ...c.thresholds, eewScale: Number(v) } })), (o) => o.label, '紧急地震速报（预测震度最低值）')),
      s.label('海啸'),
      s.row(s.select(cfg.thresholds.tsunamiGrade, TSUNAMI_OPTIONS, (v) => setCfg((c) => ({ ...c, thresholds: { ...c.thresholds, tsunamiGrade: v } })), (o) => o.label, '海啸等级')),
      s.label('全球地震（最低震级，EMSC / USGS）'),
      s.row(s.select(cfg.thresholds.globalMagnitude, GLOBAL_MAG_OPTIONS, (v) => setCfg((c) => ({ ...c, thresholds: { ...c.thresholds, globalMagnitude: Number(v) } })), (o) => o.label, '全球地震（最低震级）')),
      h('div', { style: { fontSize: 11, color: '#9aa0a6' } },
        '全球源给的是震级、日本源给的是震度，两者不可换算，所以是两个独立旋钮。'),
      s.label('大陆地震速报（最低震级，中国地震台网速报）'),
      s.row(s.select(cfg.thresholds.cnReportMagnitude, CN_REPORT_MAG_OPTIONS, (v) => setCfg((c) => ({ ...c, thresholds: { ...c.thresholds, cnReportMagnitude: Number(v) } })), (o) => o.label, '大陆地震速报（最低震级）')),
      h('div', { style: { fontSize: 11, color: '#9aa0a6' } },
        '速报覆盖低到 M2.5 且每天都有数据，所以门槛与上面的预警分开，避免小震刷屏；' +
        '大陆地震预警与全球源共用「全球地震」那个门槛。'),
    ),

    // 大陆源的链路选择（0.5.0）。这是一个**出口**：自动降级判不出的那几种网络
    //（能连上、偶尔漏、整体像坏的）需要一个手动开关，否则用户只能重装或等更新。
    s.section('大陆源链路',
      s.label('取数方式（中国地震台网预警 / 速报）'),
      s.row(s.select(cfg.cnTransport || 'auto', [
        { v: 'auto', label: '自动：SSE 推送优先，走不通自动降级为轮询' },
        { v: 'poll', label: '强制轮询（每 15 秒一次）' },
      ], (v) => setCfg((c) => ({ ...c, cnTransport: v })), (o) => o.label, '大陆源取数方式')),
      h('div', { style: { fontSize: 11, color: '#9aa0a6', marginTop: 4, lineHeight: 1.6 } },
        'SSE 推送的延迟是秒级，轮询最坏 15 秒——大陆预警抢的是这几秒，所以默认用推送。' +
        '只有在推送被网络中间设备反复掐断、而普通请求仍然正常时，才需要强制轮询。' +
        '当前实际走在哪条路上，看上面的「源状态」。'),
    ),

    // 通知与声音
    s.section('通知与声音',
      s.row(
        s.checkbox(cfg.notify.sound !== false, (v) => setCfg((c) => ({ ...c, notify: { ...c.notify, sound: v } })), '提示音'),
        s.checkbox(cfg.notify.system !== false, (v) => setCfg((c) => ({ ...c, notify: { ...c.notify, system: v } })), '系统通知'),
      ),
      s.row(s.label('音量'), h('input', {
        type: 'range', min: 0, max: 100,
        value: Math.round(volShown * 100),
        onChange: (e) => onVolumeInput(Number(e.target.value) / 100),
        'aria-label': '音量',
        style: { flex: 1, minWidth: 120 },
      }), h('span', { style: { color: '#9aa0a6', fontSize: 11, width: 34 } }, Math.round(volShown * 100) + '%')),
      s.row(
        // 试听本身就是用户手势：顺手解锁音频并刷新状态提示（否则"尚未解锁"的警告会一直挂着）
        s.btn('试听地震音', () => { unlockAudio(); setTick((t) => t + 1); playSound('quake', volShown); }),
        s.btn('试听 EEW 音', () => { unlockAudio(); setTick((t) => t + 1); playSound('eew', volShown); }),
        s.btn('试听海啸音', () => { unlockAudio(); setTick((t) => t + 1); playSound('tsunami', volShown); }),
        s.btn('试听气象音', () => { unlockAudio(); setTick((t) => t + 1); playSound('weather', volShown); }),
      ),
      s.row(
        s.btn('测试系统通知', () => {
          unlockAudio();
          const send = () => {
            const ok = showSystemNotification({ title: 'QuakeAlert 测试', body: '这是一条测试系统通知。', tag: 'quake-test', silent: true });
            setTestMsg(ok ? '已发送测试通知，请查看系统通知中心' : '测试通知发送失败');
          };
          if (perm === 'unsupported') { setTestMsg('当前浏览器不支持系统通知，无法测试'); return }
          if (perm === 'denied') { setTestMsg('通知权限已被拒绝 —— 请在浏览器站点设置中允许后重试'); return }
          if (perm === 'default') {
            requestNotificationPermission().then((p) => {
              setPerm(p);
              if (p === 'granted') send();
              else setTestMsg('未获得通知权限（浏览器未授权）');
            });
            return
          }
          send();
        }),
        s.btn('测试 Toast', () => showToast({ title: 'QuakeAlert 测试', body: '页面内弹窗工作正常。', color: '#4ade80', ttlMs: 4000 })),
      ),
      h('div', { style: { color: '#9aa0a6', fontSize: 11, marginTop: 6 } }, permText),
      // 提示音未解锁时必须**显式告知**：页面可见时通知路径只用页内 toast（不发系统通知），
      // 于是"打开 DSH 后从未点过页面"的用户在设置里看到「提示音：开」，实际上一条声音都听不到。
      audioState() === 'suspended'
        ? h('div', { style: { color: '#d9a406', fontSize: 11, marginTop: 4 } },
            '⚠ 提示音尚未解锁：浏览器要求先有一次页面交互才能出声——点一下页面任意位置即可。')
        : (audioState() === 'unavailable'
          ? h('div', { style: { color: '#9aa0a6', fontSize: 11, marginTop: 4 } }, '当前环境不支持 Web Audio，提示音不可用。')
          : null),
      testMsg ? h('div', { role: 'status', style: { color: '#93c5fd', fontSize: 11, marginTop: 4 } }, testMsg) : null,
    ),

    // 静默时段（0.2.0）
    s.section('静默时段',
      s.row(s.checkbox(cfg.quietHours.enabled, (v) => setCfg((c) => ({ ...c, quietHours: { ...c.quietHours, enabled: v } })), '启用静默时段')),
      s.row(
        s.label('开始'),
        h('input', {
          type: 'time', value: cfg.quietHours.start,
          'aria-label': '静默时段开始时间',
          onChange: (e) => setCfg((c) => ({ ...c, quietHours: { ...c.quietHours, start: e.target.value || c.quietHours.start } })),
          style: { background: '#ffffff', color: '#1a1a1a', border: '1px solid #6b7280', borderRadius: 6, padding: '4px 8px', fontSize: 12 },
        }),
        s.label('结束'),
        h('input', {
          type: 'time', value: cfg.quietHours.end,
          'aria-label': '静默时段结束时间',
          onChange: (e) => setCfg((c) => ({ ...c, quietHours: { ...c.quietHours, end: e.target.value || c.quietHours.end } })),
          style: { background: '#ffffff', color: '#1a1a1a', border: '1px solid #6b7280', borderRadius: 6, padding: '4px 8px', fontSize: 12 },
        }),
      ),
      s.row(s.checkbox(cfg.quietHours.breakForSevere, (v) => setCfg((c) => ({ ...c, quietHours: { ...c.quietHours, breakForSevere: v } })), '红色等级仍提醒（EEW / 海啸警报 / 震度6弱以上的地震 / L4 以上气象警报）')),
      h('div', { style: { fontSize: 11, color: '#9aa0a6', marginTop: 6 } },
        '按浏览器本地时间判定；开始时间晚于结束时间表示跨午夜（如 23:00–07:00）。静默期间命中的预警仍会记入下方「最近预警记录」，只是不响铃、不弹通知。'),
    ),

    // 诊断快照（0.5.0）：DESIGN 11.3 的交付物——让"运行时自己说话"。
    // 界面上只做两件事：生成、以及**在剪贴板不可用时把文本显示出来**（沙箱 iframe 里
    // navigator.clipboard 常常不可用，而"复制不了"不该成为诊断的第一步就卡住）。
    s.section('诊断',
      h('div', { style: { fontSize: 11, color: '#9aa0a6', marginBottom: 6, lineHeight: 1.6 } },
        '把这份快照贴给你的 AI 助手（配合 TROUBLESHOOTING.zh.md），它就能看到逐源状态、' +
        '数据格式异常的原因、大陆源当前走哪条链路、以及最近几条记录为什么没有响铃。'),
      s.row(s.btn('生成诊断快照', () => {
        copyDiagSnapshot().then((r) => setDiag({
          text: r.text,
          msg: r.ok ? '已复制到剪贴板。' : ('剪贴板不可用' + (r.error ? '（' + r.error + '）' : '') + '，请手动全选下面的文本复制。'),
        })).catch((err) => setDiag({ text: '', msg: '生成失败：' + String((err && err.message) || err) }));
      })),
      h('div', { style: { fontSize: 11, color: '#d9a406', marginTop: 4 } },
        '⚠ 快照含你的关注地区名称与坐标——诊断"为什么没命中"必须要有它。分享前请自行确认。'),
      diag ? h('div', { role: 'status', style: { color: '#93c5fd', fontSize: 11, marginTop: 4 } }, diag.msg) : null,
      diag && diag.text
        ? h('textarea', {
            readOnly: true, value: diag.text, rows: 10,
            onFocus: (e) => { try { e.target.select(); } catch (err) { /* 忽略 */ } },
            style: {
              width: '100%', boxSizing: 'border-box', marginTop: 6, fontSize: 11,
              fontFamily: 'ui-monospace, monospace', background: '#ffffff', color: '#1a1a1a',
              border: '1px solid #6b7280', borderRadius: 6, padding: 8,
            },
          })
        : null,
    ),

    // 免责
    s.section('免责声明', h('div', { style: { color: '#9aa0a6', fontSize: 11, lineHeight: 1.6 } },
      '预警数据由 P2PQuake 转播、日本气象厅公开 XML 电文、EMSC / USGS / NOAA，' +
      '美国国家气象局（NWS）与加拿大环境与气候变化部（ECCC）的公开接口（浏览器直连），' +
      '以及 Wolfx 转播的中国地震台网（CENC）信息提供，均非官方直接推送；' +
      '紧急地震速报（EEW）与大陆地震预警等内容与配信品质无保证。' +
      '本插件提醒仅供参考，避险请以当地主管机构（日本气象厅 気象庁 / 中国地震台网 CENC / ' +
      '美国 NWS・USGS・NOAA / 加拿大 ECCC 等）官方发布为准。' +
      '插件仅在 DSH 页面开启时工作。')),

    // 最近预警（点击条目展开详情；多条时可滚动）
    s.section('最近预警记录（' + store.events.length + ' 条）',
      h('div', { style: { fontSize: 11, color: '#9aa0a6', marginBottom: 6 } },
        '记录匹配链路上处理过的消息（含未达阈值、未提醒的灰色记录），点条目展开完整内容。'),
      store.events.length === 0
        ? h('div', { style: { color: '#9aa0a6', fontSize: 12, padding: '4px 0' } }, '暂无记录 —— 收到真实预警或测试消息后显示')
        : h('div', { style: { maxHeight: 300, overflowY: 'auto', paddingRight: 4 } },
            store.events.slice(0, HISTORY_MAX).map((e, i) => {
              const itemKey = e.key || e.id || i;
              const open = expanded === itemKey;
              const toggle = () => setExpanded(open ? null : itemKey);
              const head = String(e.headline || '');
              const muted = e.hit === false || e.suppressed === true;
              const statusText = e.hit === false
                ? '未触发提醒'
                : (e.suppressed ? '未重复提醒' : (e.pref ? '命中 ' + e.pref : '已提醒'));
              // 气象电文来自気象庁防災情報XML，没有 P2PQuake 的 code：旧写法对 weather 落进
              // 最后的 else 分支，展开详情时会把泥石流 / 洪水电文标成「code 551」（地震速报）。
              const codeText = p2pCodeTextOf(e.kind, e.code, e.id);
              return h('div', {
                key: itemKey,
                // 可键盘操作（0.4.1）：详情是用户核对"插件到底看到了什么"的唯一入口，
                // 只在 onClick 上可用等于把键盘 / 读屏用户挡在门外。
                role: 'button',
                tabIndex: 0,
                'aria-expanded': open,
                onClick: toggle,
                onKeyDown: (ev) => {
                  if (ev.key === 'Enter' || ev.key === ' ' || ev.key === 'Spacebar') { ev.preventDefault(); toggle(); }
                },
                title: open ? '点击收起（回车 / 空格同样可用）' : '点击展开详情（回车 / 空格同样可用）',
                style: Object.assign({
                  cursor: 'pointer',
                  borderLeft: '3px solid ' + kindColorOf(e.kind),
                  background: open
                    ? (muted ? 'rgba(148,163,184,0.16)' : 'rgba(59,130,246,0.22)')
                    : (muted ? 'rgba(148,163,184,0.05)' : 'rgba(148,163,184,0.09)'),
                  borderRadius: 6, padding: '6px 10px', margin: '5px 0',
                }, open ? { boxShadow: 'inset 0 0 0 1px rgba(148,163,184,0.55)' } : null),
              },
                h('div', { style: { display: 'flex', gap: 8, alignItems: 'center' } },
                  h('span', { style: { fontWeight: 700, fontSize: 12, color: kindColorOf(e.kind) } }, String(e.label || '')),
                  h('span', { style: { fontSize: 11, border: '1px solid ' + (muted ? '#8b8f98' : '#4ade80'), color: muted ? '#8b8f98' : '#4ade80', borderRadius: 8, padding: '0 6px' } }, statusText),
                  h('span', { style: { color: '#9aa0a6', fontSize: 11, marginLeft: 'auto', whiteSpace: 'nowrap' } }, open ? '▲ 收起' : '▼ 展开')),
                !open
                  ? h('div', { style: { fontSize: 12, color: '#c8ccd4', marginTop: 3, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' } }, head)
                  : h('div', { style: { fontSize: 12, marginTop: 6 } },
                      h('div', { style: { display: 'flex', gap: 6 } },
                        h('span', { style: { color: '#9aa0a6', width: 44 } }, '类型'),
                        h('span', { style: { color: '#e6e6e8' } }, String(e.label || '') + '（' + codeText + '）')),
                      h('div', { style: { display: 'flex', gap: 6, marginTop: 2 } },
                        h('span', { style: { color: '#9aa0a6', width: 44 } }, '时间'),
                        // 按**本地时区**渲染（DESIGN 第 4 节）：解析层存的是带偏移的 ISO 8601，
                        // 直接显示原文会让大陆用户看到一个差 1 小时且无标注的 JST 时间。
                        h('span', { style: { color: '#e6e6e8' } }, formatIssuedLocal(e.issued) || '—')),
                      e.pref ? h('div', { style: { display: 'flex', gap: 6, marginTop: 2 } },
                        h('span', { style: { color: '#9aa0a6', width: 44 } }, '命中'),
                        h('span', { style: { color: '#e6e6e8' } }, String(e.pref))) : null,
                      e.suppressedReason ? h('div', { style: { display: 'flex', gap: 6, marginTop: 2 } },
                        h('span', { style: { color: '#9aa0a6', width: 44 } }, '说明'),
                        h('span', { style: { color: '#e6e6e8' } }, String(e.suppressedReason))) : null,
                      h('div', { style: { display: 'flex', gap: 6, marginTop: 2 } },
                        h('span', { style: { color: '#9aa0a6', width: 44 } }, '内容'),
                        h('span', { style: { color: '#e6e6e8', flex: 1, wordBreak: 'break-all' } }, head)),
                    ),
              )
            }),
          ),
      s.row(s.btn('清空记录', () => {
        store.push({ events: [] });
        saveJSON(HISTORY_KEY, []);
        // 还要广播：其它标签页的内存副本不清的话，它们下一次 addEvent 会把整份记录（含刚被
        // 清掉的条目）重新写回磁盘——用户以为清空了，实际只是本标签页看不见（若清空的动机
        // 是隐私，这就是实际的信息泄露面）。
        broadcastHistoryCleared();
      })),
    ),
  )
}

// ============================================================================
// dsh-quake-alert · client/src/14-ui-status.js
//
// 作用：侧边栏底部的连接状态指示（DESIGN 第 6 节）。
// 内容：状态圆点（绿=已连接 / 黄=连接或重连中 / 红=已停止）+ 悬停详情 + 无障碍标签。
// 依赖：01-constants、07-store。
// ============================================================================


// ---------- 侧边栏状态指示（DESIGN 第 6 节：连接状态显示在插件图标与设置页） ----------
function StatusIndicator(props) {
  const [, setTick] = useState(0);
  useEffect(() => store.subscribe(() => setTick((t) => t + 1)), []);
  const meta = statusMetaOf(store.status, store.retries);
  const wide = Boolean(props && props.wide);
  // disabled（用户关掉了某个灾种 / 全部关掉）用**空心**圆点表示，与 stale / 未启动 的实心灰区分开
  // （DESIGN 5 节的六态表格）。轮廓是边框而非填充，深色主题下也不会消失。
  const dotStyle = store.status === 'disabled'
    ? { display: 'inline-block', width: 8, height: 8, borderRadius: '50%', background: 'transparent', border: '1.5px solid ' + meta.color, flex: '0 0 auto' }
    : { display: 'inline-block', width: 8, height: 8, borderRadius: '50%', background: meta.color, flex: '0 0 auto' };
  // 气象警报的「静默提示」（0.3.0）：只有"命中关注地区但未达 L4、没有播报"时才存在
  // （L4 以上播报后会清掉，否则这里会与事实矛盾）。不改颜色、不弹窗、不响铃。
  const hint = store.weatherHint;
  const hintText = hint && typeof hint.level === 'number'
    ? ' · 气象警报 L' + hint.level + (hint.label ? '（' + hint.label + '）' : '')
    : '';
  return h('div', {
    role: 'status',
    'aria-label': '灾害预警：' + meta.text + hintText,
    title: '灾害预警：' + meta.text + (store.detail ? ' · ' + store.detail : '') + hintText,
    style: { display: 'flex', alignItems: 'center', gap: 6, padding: wide ? '4px 8px' : '4px', fontSize: 12, color: 'inherit', cursor: 'default' },
  },
    h('span', { style: dotStyle }),
    wide ? h('span', { style: { whiteSpace: 'nowrap' } }, '灾害预警') : null)
}

// ============================================================================
// dsh-quake-alert · client/src/15-entry.js
//
// 作用：插件入口——apply 与单测钩子。
// 内容：音效解锁监听、跨标签页通道、settings 绑定、市区町村表拉取、WebSocket 启停、
//       设置页与状态指示两个 slot 的注册、exports.__test 导出面。
// 依赖：全部前置文件。
// 生命周期：所有副作用都包在 ctx.effect 内，插件停用即回收。
// ============================================================================


// ---------- 插件入口 ----------
const name = 'dsh-quake-alert';
const inject = ['slots'];
function apply(ctx) {
  // 音效解锁：首次用户手势创建/恢复 AudioContext（自动播放策略标准解法）
  ctx.effect(() => {
    const unlock = () => { try { unlockAudio(); } catch (err) {} };
    window.addEventListener('pointerdown', unlock, { passive: true });
    window.addEventListener('keydown', unlock, { passive: true });
    return () => {
      window.removeEventListener('pointerdown', unlock);
      window.removeEventListener('keydown', unlock);
    }
  }, 'dsh-quake-alert: audio unlock');

  // 跨标签页去重通道：必须在插件加载时就开始监听，否则会错过其它标签页的广播。
  // 0.4.1 把它连同关闭一起放进 effect：原来 ensure 在外、close 在内，两代 fiber 会共享
  // 同一条通道，停用 → 启用时旧 fiber 的 close 会把新 fiber 依赖的通道关掉。
  // effect 体在 apply 时**同步执行**，所以"加载时就建立"的语义没有变。
  ctx.effect(() => {
    ensureAlertChannel();
    return () => { closeAlertChannel(); }
  }, 'dsh-quake-alert: tab channel');

  // 插件（重新）装载时清空上一代的**连接**状态：clearSources 此前定义了却没有任何调用点，
  // 与它自己的注释"插件停用 / 重建时把源清空"不符，残留状态会把新会话显示成"已连接"。
  //
  // 0.5.3 起**不再清数据健康**（原先是 resetSourceHealth）：那一层已经落了盘，而它表达的是
  // "上游改了字段、要等插件更新"——这件事与用户刷新页面 / 重新启用插件无关，清掉等于让蓝点
  // 永远没人看见（DESIGN 11.9 A）。连接与新鲜度才是"重启即无意义"的那两层。
  store.clearSources();
  resetConnHealth();
  // 立刻把已升级的数据健康重新发布出来（0.5.4）：store 刚被清空，而蓝点存在 localStorage 里。
  // 不重发的话要等该源下一次上报（feed 首轮 3 秒 + 15 秒一轮）才显示，而"上游改了字段"这件事
  // 与刷新页面无关——DESIGN 11.9 A 的"蓝点跨刷新存活"应当是立刻成立，而不是十几秒后。
  republishDataHealth();

  // 健康探针（0.5.3 / DESIGN 11.9 B）：按**契约里的阈值**判定各源的数据新鲜度，并驱动蓝点的
  // TTL 自愈。把它放进 effect 是因为它有一个定时器——定时器归 fiber，停用即回收。
  // 阈值只从 SOURCE_CONTRACTS 来，这是机制层的全部意义（此前那个字段整个代码库里没人读）。
  ctx.effect(() => {
    const probe = createHealthProbe();
    probe.start();
    return () => { try { probe.stop(); } catch (err) { /* 已停 */ } }
  }, 'dsh-quake-alert: health probe');

  // 机器级持久化：settings 服务可用时，配置交给 DSH 的 settings.yaml（Host 侧同名 namespace）。
  // 服务缺席（或页面非 loopback）时保持 localStorage 路径，插件照常工作。
  if (typeof ctx.inject === 'function') {
    ctx.inject(['settingsScope'], (settingsCtx) => {
      let unbind = null;
      try {
        unbind = bindSettingsScope(settingsCtx.settingsScope.bind({ namespace: SETTINGS_NS }));
      } catch (err) { /* bind 失败 → 继续用 localStorage */ }
      // 订阅必须随 fiber 释放（0.4.1）：否则同一页面内停用 → 启用 N 次会累积 N 个订阅，
      // 此后 Host 的每一次配置变更都会触发 N 次写盘与 N 次重渲。
      if (typeof unbind === 'function' && typeof ctx.effect === 'function') {
        ctx.effect(() => () => { try { unbind(); } catch (err) { /* 忽略 */ } }, 'dsh-quake-alert: settings unbind');
      }
    });
  }

  // 跨标签页配置同步（0.3.2）：storage 事件只在「别的标签页写入」时触发。监听必须常驻——
  // 原先写在设置页组件里，于是没打开设置页的标签页不会跟随，会一直按旧配置提醒。
  // 回读走 03 的显式入口（跨模块不能直接给它的模块私有 runtimeCfg 赋值），再 store.push()
  // 让设置页与状态指示一起刷新。
  ctx.effect(() => {
    const onStorage = (e) => {
      if (!e || e.key === null || e.key === STORAGE_KEY) {
        reloadFromLocal();
        store.push({});
      }
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage)
  }, 'dsh-quake-alert: cross-tab config');

  // 市区町村表：Host 路由提供，拉一次缓存。失败只影响市级细化，不影响任何提醒。
  // 放进 effect：拉取是异步的，若插件在飞行中被停用，要中止请求并停止写 store / 配置。
  ctx.effect(() => {
    loadCityTable();
    return () => { try { abortCityTableLoad(); } catch (err) {} }
  }, 'dsh-quake-alert: city table');

  // WebSocket 常驻连接（与设置页是否打开无关）。
  // start() 必须写在 effect 内：若同一 apply 后面的注册抛错，连接也要随 fiber 一起收掉，
  // 否则会留下一条没有清理器的 socket，直到用户刷新页面。
  //
  // onRaw 走解析契约（0.4.1）：结构不符 / 值不可能 → 计入数据健康并**不播报**（蓝点），
  // 与本插件无关的消息（其他 code）判为 empty、静静跳过。
  const client = createWsClient({
    onRaw: (raw, cfg) => {
      const res = parseEpspResult(raw);
      if (noteParseResult('p2pquake', res)) return
      if (!res.ok) return
      noteSourceSuccess('p2pquake');
      handleAlert(res.alert, cfg);
    },
  });
  setActiveClient(client);
  ctx.effect(() => {
    client.start();
    return () => {
      try { client.stop(); } catch (err) {}
      // 置空：否则设置页里那个 80ms 后触发的 restart()（切换数据源）还能复活一个
      // 已经没有任何 fiber 归属的 socket，它会继续上报状态并（经 handleAlert）响铃。
      setActiveClient(null);
    }
  }, 'dsh-quake-alert: ws client');

  /** 轮询源的状态上报：把每个源的连接 / 失败情况送进 store，参与整体状态聚合（0.4.1）。
   *  经 publishStatus 合成（0.5.4）——12b 自己也算了一遍 effectiveStatusOf（它要用结果做去重键），
   *  这里再过一次是幂等的，但保证了"写 store 的每一处都走同一个合成规则"。 */
  const feedStatus = (sourceId) => (patch) => publishStatus(sourceId, patch);
  const feedError = (name) => (err) => {
    // 措辞用"请求失败"而不是"增量拉取失败"（0.6.0 review C-5）：海外源是按点 / 按框查询，
    // 没有"增量"这个概念，日志里出现"增量拉取失败"会把人引到错误的排查方向。
    try { console.warn('[dsh-quake-alert] ' + name + ' 请求失败：' + String((err && err.message) || err)); } catch (e) {}
  };

  // 気象庁电文增量（0.3.0）：Host 侧负责轮询与去重，这里只拉本地增量并交给主链。
  const feed = createFeedClient({
    id: 'jma',
    label: '気象庁',
    onStatus: feedStatus('jma'),
    onError: feedError('jma'),
  });
  // 全球地震（USGS，0.4.0）：Host 轮询 GeoJSON（单级），Client 只拉本地增量。
  // 与 EMSC 是互补关系——EMSC 是实时推送，USGS 目录更完整、还带修订版（updated 刷新）。
  // 两者的同类地震靠 geoEventKey 归并，不会重复提醒。
  const usgsFeed = createFeedClient({
    id: 'usgs',
    label: 'USGS',
    path: FEED_PATH + '?source=usgs',
    cursorKey: FEED_CURSOR_KEY + '.usgs',
    enabled: (cfg) => (cfg.disasters || {}).earthquake !== false,
    onStatus: feedStatus('usgs'),
    onError: feedError('usgs'),
    apply: (entry, cfg) => {
      let feature;
      try { feature = JSON.parse(entry && entry.xml); } catch (err) {
        noteParseResult('usgs', failResult('schema', 'Host 载荷不是合法 JSON'));
        return false
      }
      const res = parseUsgsResult(feature);
      if (noteParseResult('usgs', res)) return false
      if (!res.ok) return false
      noteSourceSuccess('usgs');
      handleAlert(res.alert, cfg);
      return true
    },
  });
  // 海啸（NOAA，0.4.0）：Host 拉事件列表再取 CAP 详情，Client 解析 CAP。
  const noaaFeed = createFeedClient({
    id: 'noaa',
    label: 'NOAA',
    path: FEED_PATH + '?source=noaa',
    cursorKey: FEED_CURSOR_KEY + '.noaa',
    intervalMs: 5 * 60 * 1000,
    enabled: (cfg) => (cfg.disasters || {}).tsunami !== false,
    onStatus: feedStatus('noaa'),
    onError: feedError('noaa'),
    apply: (entry, cfg) => {
      const res = parseNoaaResult(entry && entry.xml, { id: entry && entry.id });
      if (noteParseResult('noaa', res)) return false
      if (!res.ok) return false
      noteSourceSuccess('noaa');
      handleAlert(res.alert, cfg);
      return true
    },
  });
  // 大陆气象灾害（0.5.2）：中央气象台汇总的预警信号（暴雨 + 地质灾害），走 Host 的 `/feed` **轮询**。
  // 为什么不是像 cenc 那样用 SSE：气象预警是"提前数十分钟到数小时发布"的警戒级信息，与 JMA 同一
  // 性质——DESIGN 5.2 的 `/feed` + 15 秒本地拉取本来就是为这类信息设计的，延迟最坏 120+15 秒。
  // 两个灾种各有开关，但**共用一个 Host 源**（同一个端点、同一份响应），所以只要有一个开着就继续拉。
  const nmcFeed = createFeedClient({
    id: 'nmc_alarm',
    label: '中央气象台',
    path: FEED_PATH + '?source=nmc_alarm',
    cursorKey: FEED_CURSOR_KEY + '.nmc_alarm',
    enabled: (cfg) => {
      const d = cfg.disasters || {};
      return d.cnRainstorm !== false || d.cnGeology !== false
    },
    onStatus: feedStatus('nmc_alarm'),
    onError: feedError('nmc_alarm'),
    apply: (entry, cfg) => {
      let raw;
      try {
        raw = JSON.parse(entry && entry.xml);
      } catch (err) {
        noteParseResult('nmc_alarm', failResult('schema', 'Host 载荷不是合法 JSON'));
        return false
      }
      const res = parseNmcAlarmResult(raw);
      if (noteParseResult('nmc_alarm', res)) return false
      if (!res.ok) return false
      noteSourceSuccess('nmc_alarm');
      handleAlert(res.alert, cfg);
      return true
    },
  });
  const feeds = [feed, usgsFeed, noaaFeed, nmcFeed];
  ctx.effect(() => {
    for (const f of feeds) f.start();
    return () => { for (const f of feeds) { try { f.stop(); } catch (err) {} } }
  }, 'dsh-quake-alert: feed clients');

  // 大陆源（0.5.0）：Wolfx 的 cenc_eew（预警）+ cenc_eqlist（速报），走 Host 的 **SSE 推送**。
  // 为什么不是像上面几行那样用轮询：EEW 的价值在秒级，15 秒一轮等于把预警变成事后通知。
  // 为什么还留降级：某些网络下长连接会被中间设备掐掉，而普通 HTTPS 轮询仍然通（DESIGN 11.5）；
  // 12c 在"能证明这条路走不通"时会自动切到 `?source=` 轮询并把降级状态**说出来**。
  // 两者都跟「地震」开关：预警与速报都是地震，DESIGN 8.4 只给速报单独一个**震级门槛**，不给单独开关。
  const cencApply = (sourceId, parseEntry) => (entry, cfg) => {
    let raw;
    try {
      raw = JSON.parse(entry && entry.xml);
    } catch (err) {
      noteParseResult(sourceId, failResult('schema', 'Host 载荷不是合法 JSON'));
      return false
    }
    const res = parseEntry(raw);
    if (noteParseResult(sourceId, res)) return false
    if (!res.ok) return false
    noteSourceSuccess(sourceId);
    handleAlert(res.alert, cfg);
    return true
  };
  const cnEnabled = (cfg) => (cfg.disasters || {}).earthquake !== false;
  const cencEew = createCnStream({
    id: 'cenc_eew',
    label: '大陆地震预警',
    enabled: cnEnabled,
    onStatus: feedStatus('cenc_eew'),
    onError: feedError('cenc_eew'),
    apply: cencApply('cenc_eew', parseCencEewResult),
  });
  const cencEqlist = createCnStream({
    id: 'cenc_eqlist',
    label: '大陆地震速报',
    enabled: cnEnabled,
    onStatus: feedStatus('cenc_eqlist'),
    onError: feedError('cenc_eqlist'),
    apply: cencApply('cenc_eqlist', parseCencEqlistItemResult),
  });
  ctx.effect(() => {
    cencEew.start();
    cencEqlist.start();
    return () => { for (const c of [cencEew, cencEqlist]) { try { c.stop(); } catch (err) {} } }
  }, 'dsh-quake-alert: cn streams');

  // 海外气象（0.6.0）：美国 NWS 与加拿大 ECCC，**Client 直连的外部 REST**（CORS 实测允许）。
  // 与其它源的形态差别写在 12e 的文件头：按关注点查询、不判停更、年龄闸门在首轮生效。
  // 两个源各自只对"落在对应国家包围盒内的关注点"发请求——没配那个国家的用户一个请求都不产生，
  // 所以不需要额外的开关，灾种开关（overseasWeather）关掉时连请求都不发（12e 的 enabled 判定）。
  const nwsSource = createNwsSource({
    onStatus: feedStatus('nws_alerts'),
    onError: feedError('nws_alerts'),
  });
  const ecccSource = createEcccSource({
    onStatus: feedStatus('eccc_alerts'),
    onError: feedError('eccc_alerts'),
  });
  ctx.effect(() => {
    // 清掉上一代的计数快照（0.6.0 review C-4）：`overseasStatsOf` 是模块级的，插件重建后
    // 到首个轮询完成前，设置页与诊断会显示上一代的数字与 `running: true`。
    for (const k of Object.keys(overseasStatsOf)) delete overseasStatsOf[k];
    nwsSource.start();
    ecccSource.start();
    return () => { for (const s of [nwsSource, ecccSource]) { try { s.stop(); } catch (err) {} } }
  }, 'dsh-quake-alert: overseas pollers');

  // 全球地震（0.4.0）：EMSC 的 WebSocket，复用与 P2PQuake 同一套连接管理（退避、建连看门狗、
  // 生命周期归还 fiber）。「久无数据」判据从 0（关闭）改为 3 小时（0.4.1 修正）：
  // 关掉之后就没有任何半开检测了——半开正是"没有 onclose"，而建连看门狗在 onopen 之后
  // 就被撤销，连接可以永久停在绿色上（用户以为在被保护），与 DESIGN 5.1「两种静默失效
  // 必须主动检测」冲突。3 小时远大于正常推送间隔（全球 M4+ 平均约 30 分钟一条，不会误判），
  // 又能兜住真正的半开；页面从冻结中恢复时会重置计时（见 12-websocket 的 visibilitychange）。
  const emsc = createWsClient({
    sourceId: 'emsc',
    label: 'EMSC',
    urlOf: () => EMSC_WS_URL,
    staleAfterMs: 3 * 60 * 60 * 1000,
    openDetail: () => '已连接 EMSC（全球地震实时推送）',
    onRaw: (raw, cfg) => {
      const res = parseEmscResult(raw);
      if (noteParseResult('emsc', res)) return
      if (!res.ok) return
      noteSourceSuccess('emsc');
      handleAlert(res.alert, cfg);
    },
  });
  ctx.effect(() => {
    emsc.start();
    return () => { try { emsc.stop(); } catch (err) {} }
  }, 'dsh-quake-alert: EMSC ws client');

  // 设置页：设置 → 灾害预警
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'quake-alert',
    order: 60,
    label: () => '灾害预警',
  }, (props) => h(SettingsPanel, { close: props ? props.close : undefined })));

  // 侧边栏底部状态指示（绿/黄/红圆点，悬停显示详情）
  ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
    name: 'sidebar.footer.action',
    id: 'quake-alert-status',
    order: 50,
    label: () => '灾害预警',
  }, (props) => h(StatusIndicator, props || {})));
}

// 单测钩子（客户端宿主忽略额外导出）
const __test = {
  // 0.5.3：机制层（统一健康记录 + 探针 + 升级阈值）
  createHealthProbe, staleAfterOf, PROBE_INTERVAL_MS,
  resetConnHealth, pruneHealth, noteFreshness, noteStale, loadHealth, publishStatus, republishDataHealth,
  SCHEMA_ESCALATE_COUNT, SCHEMA_ESCALATE_CONSECUTIVE, SCHEMA_ESCALATE_WINDOW_MS, HEALTH_TTL_MS,
  // 0.5.2：大陆气象源（nmc.cn）—— 解析层 / 契约 / 行政区层级匹配
  parseNmcAlarm, orgOf, parseNmcAlarmResult, matchCnAreaAlert, cnPlaceParts, cnAreaOf, normAliases,
  NMC_KIND_TEXT, NMC_LEVEL_TEXT, NMC_LEVEL_RANK, NMC_BROADCAST_MIN_RANK,
  // 0.6.0：海外气象源（美国 NWS / 加拿大 ECCC）—— 解析层 / 契约 / 事件键 / 白名单
  parseNwsAlert, parseEcccAlert, parseNwsAlertResult, parseEcccAlertResult,
  ecccKindTextOf, nwsEventKeyOf, ecccEventKeyOf, NWS_EVENT_WHITELIST, NWS_KIND_TEXT,
  NWS_SEVERITY, NWS_SEV_RANK, ECCC_COLOUR_SEVERITY, ECCC_COLOUR_RANK, ECCC_INCLUDE, ECCC_EXCLUDE,
  OVERSEAS_BROADCAST_MIN_RANK,
  // 0.6.0：取数器与匹配（按关注点查询 / 查询即匹配 / 年龄闸门）
  createNwsSource, createEcccSource, nwsSamplePoints, ecccBboxOf, placesInBoxes, matchOverseasAlert,
  NWS_ALERTS_BASE, ECCC_ALERTS_BASE, NWS_EVENT_QUERY,
  MIN_SAMPLE_RADIUS_KM, MAX_REQUESTS_PER_ROUND, OVERSEAS_FRESH_GATE_MS, OVERSEAS_GATE_RESET_MS,
  UNCOVERED_TTL_MS, OVERSEAS_MIN_BACKOFF_MS, OVERSEAS_MAX_BACKOFF_MS,
  overseasStatsOf,
  parse, parseQuake, parseEew, parseTsunami, parseJma, parseEmsc, parseUsgsFeature, parseUsgsFeed, parseNoaaCap, severityOfMagnitude, geoEventKey, TEST_GEO_SCENARIOS, buildTestGlobalMessage, parseTestGlobalMessage, feedStatsOf, watchlessPoint, buildTestTelegram, TEST_SCENARIOS, jmaMaxLevelIn: maxLevelIn, jmaItemsOf: itemsOf, noticeAreaLevels, applyNoticeLevels, regionKindOf, matchAlert, matchPointAlert, distanceKm, validGeo, normalizePlaces, soundKindOf, playSound, sevColor, p2pCodeTextOf, kindColorOf, alertTitleOf, prefsOfArea, regionsOfArea, AREA_PREF, loadCfg, normalizeCfg, loadHistory, normalizeHistoryEntry, addEvent, handleRaw, handleCancelled, handleAlert, updateWeatherHint, hitSeverityOf, createFeedClient, FEED_PATH, FEED_POLL_MS, FEED_CURSOR_KEY, FEED_TAIL, createCnStream, cnStreamRegistry, STREAM_PATH, CN_CURSOR_KEY, cnProductName, authorityOf, disclaimerOf, SOURCE_ORDER, SOURCE_LABELS, SOURCE_CODE_TEXT, SettingsPanel, statusMetaOf, buildDiagSnapshot, copyDiagSnapshot, DIAG_SNAPSHOT_VERSION, inQuietHours, isDuplicate, isEventRepeat, isStrengthUpgrade, weakenEvent, forgetEvent, claimAlertForTab, cancelKeyOf, rememberAlerted, wasRecentlyAlerted, ensureAlertChannel, broadcastHistoryCleared, createWsClient, store, HISTORY_MAX, PREFECTURES, DEFAULT_CFG, currentCfg, applyCfg, reloadFromLocal, bindSettingsScope, settingsOpsFor, cfgToSection, sectionToCfg, SETTINGS_NS, settingsState, resetSettings, setCityTable, citiesOfPref, prefsOfCity, canonicalCityOf, normKana, setRiverAreas, riverAreaCities, cityAliases, lookupAddrCity, buildAddrIndex, normalizePref, prefOfCode, prefCodeOf, pruneUnknownCities, loadCityTable, abortCityTableLoad, cityTableState: () => cityTableState, resetCityTable, setCnAreas, cnProvinces, cnCitiesOf, cnPlaceOf, RADIUS_PRESETS, DEFAULT_PLACE_RADIUS_KM, MIN_PLACE_RADIUS_KM, MAX_PLACE_RADIUS_KM, p2pTimeToIso, cnTimeToIso, CN_TIME_RE, CN_REPORT_MAG_OPTIONS, issuedToDate, formatIssuedLocal, audioState, SOURCE_CONTRACTS, parseEpspResult, parseEmscResult, parseUsgsResult, parseNoaaResult, parseJmaResult, parseCencEewResult, parseCencEqlistItemResult, parseCencEqlistResult, parseCencEew, parseCencEqlist, parseCencEqlistItem, cencEqlistItems, cencEqlistMd5Of, failResult, noteParseResult, noteSourceSuccess, retrySource, sourceHealthOf, effectiveStatusOf, resetSourceHealth, P2P_TIME_RE, MIGRATED_KEY };

// activeClient 是 12-websocket 的模块级 let：给 12 用的赋值出口（跨模块不能写 imported binding）
// 由 12-websocket 提供 setter；这里仅保留引用以便阅读

exports.__test = __test;
exports.apply = apply;
exports.inject = inject;
exports.name = name;

return module.exports;
} });
