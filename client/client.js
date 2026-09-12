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

const DEFAULT_CFG = {
  version: 1,
  source: 'prod', // prod | sandbox（沙箱回放 2023 年历史，约30秒/条，测试用）
  // 两种关注模式并存：
  //   · 行政区（prefectures / cities）——日本源（P2PQuake、気象庁）用，粒度到市区町村
  //   · 坐标点（places）——全球源（EMSC / USGS / NOAA）用，判定方式是「震中距 ≤ radiusKm」
  // 两者互不影响：日本用户不用配 places，全球用户不用配 prefectures。
  watch: { prefectures: [], cities: [], places: [] },
  disasters: { earthquake: true, tsunami: true, weather: true }, // weather = 气象灾害（泥石流 / 洪水 / 大雨 / 高潮…），固定 L4 以上播报
  // globalMagnitude：全球源（EMSC / USGS）的最低震级。日本源用的是震度（quakeScale），
  // 全球源只有震级——实测 EMSC 会推 M3.8 级别的事件，若沿用"来什么报什么"会明显吵闹。
  thresholds: { quakeScale: 40, eewScale: 45, tsunamiGrade: 'Watch', globalMagnitude: 4.5 },
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
// 每次都返回全新对象：避免调用方改动嵌套字段时污染 DEFAULT_CFG 常量
const freshCfg = () => ({
  version: DEFAULT_CFG.version,
  source: DEFAULT_CFG.source,
  watch: { prefectures: [], cities: [], places: [] },
  disasters: { ...DEFAULT_CFG.disasters },
  thresholds: { ...DEFAULT_CFG.thresholds },
  notify: { ...DEFAULT_CFG.notify },
  dedupe: { ...DEFAULT_CFG.dedupe },
  quietHours: { ...DEFAULT_CFG.quietHours },
});
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
function normalizeCfg(stored) {  const w = isPlainObject(stored.watch) ? stored.watch : {};
  const d = isPlainObject(stored.disasters) ? stored.disasters : {};
  const t = isPlainObject(stored.thresholds) ? stored.thresholds : {};
  const n = isPlainObject(stored.notify) ? stored.notify : {};
  const de = isPlainObject(stored.dedupe) ? stored.dedupe : {};
  const qh = isPlainObject(stored.quietHours) ? stored.quietHours : {};
  return {
    version: DEFAULT_CFG.version,
    source: stored.source === 'sandbox' ? 'sandbox' : 'prod',
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
    this.recomputeStatus();
    this.push({});
  },
  recomputeStatus() {
    const list = Object.keys(this.sources).map((k) => this.sources[k]);
    if (list.length === 0) {
      this.status = 'idle'; this.retries = 0; this.detail = '';
      return
    }
    const pick = (s) => list.filter((x) => x.status === s)[0];
    // 红优先：任一链路停了 / 断了，整体就不是"正常"
    const chosen = pick('closed') || pick('reconnecting') || pick('connecting') || pick('open') || list[0];
    this.status = chosen.status;
    this.retries = typeof chosen.retries === 'number' ? chosen.retries : 0;
    this.detail = list.map((x) => (x.label || '') + '：' + (x.detail || x.status)).join(' · ');
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
  runtimeCfg = saveCfg(cfg);
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
function pushCfgToHost(cfg) {
  const scope = settingsScope;
  if (!scope || settingsSync !== 'host') return
  try {
    const snap = scope.getSnapshot();
    if (!snap || snap.status !== 'ready' || snap.writable !== true || snap.mode !== 'host') return
    const ops = settingsOpsFor(cfg);
    if (ops.length === 0) return
    const pending = scope.mutate(ops);
    if (pending && typeof pending.catch === 'function') pending.catch(() => { /* 写失败不回滚本地 */ });
  } catch (err) { /* 通道异常时本地配置仍然生效 */ }
}
// 绑定 Host settings。三种来源的优先关系：
//   ① Host 用户层已有内容 → 以 Host 为准（机器级配置是 source of truth）
//   ② Host 为空、本地已有非默认配置 → 一次性把本地配置迁移到 Host
//   ③ Host 不可用 → 保持 localStorage（settingsSync 停留在 local / memory）
function bindSettingsScope(scope) {
  settingsScope = scope;
  let migrated = false;
  const sync = () => {
    let snap = null;
    try { snap = scope.getSnapshot(); } catch (err) { return }
    if (!snap || snap.status !== 'ready' || snap.value === undefined) { settingsSync = 'local'; store.push({}); return }
    if (snap.mode !== 'host' || snap.writable !== true) { settingsSync = 'memory'; store.push({}); return }
    settingsSync = 'host';
    const user = isPlainObject(snap.user) ? snap.user : {};
    if (Object.keys(user).length === 0 && !migrated) {
      migrated = true; // 只迁移一次：之后 Host 被清空是用户的显式操作，不该被本地又推回去
      const local = loadCfg();
      if (JSON.stringify(cfgToSection(local)) !== JSON.stringify(cfgToSection(freshCfg()))) {
        runtimeCfg = saveCfg(local);
        pushCfgToHost(runtimeCfg);
        store.push({});
        return
      }
    }
    const next = sectionToCfg(snap.value);
    runtimeCfg = saveCfg(next); // localStorage 保持为镜像：Host 掉线时仍能工作
    store.push({});
  };
  try { scope.subscribe(sync); } catch (err) { /* 订阅失败只是失去实时同步 */ }
  sync();
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
// 安全字典查找：外部数据里的 'constructor'/'toString' 等键会命中原型链，
// 例如 AREA_PREF['constructor'] 会返回 Object 构造函数并让 .slice() 抛错

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
    issued: (raw.issue && raw.issue.time) || raw.time || '',
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
    issued: (raw.issue && raw.issue.time) || raw.time || '',
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
    issued: (raw.issue && raw.issue.time) || raw.time || '',
    headline: cancelled ? '海啸预报已解除' : lines.join('；'),
    maxScale: worst,
    // 海啸预报没有可归并的事件 id（issue 只有 source/time/type），保持逐条判定
    eventKey: '',
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
 * 旧格式电文的 Kind 名称 → 警戒レベル（0.3.4 修复漏报）。
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
// 电文标题 → 中文标签（M3 才做 i18n，这里与既有 kindLabel 一样先硬编码中文）
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
  [/気象特別警報/, '气象特别警报'],
  [/気象警報・注意報/, '气象警报'],
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
  const AREA = /<Area>\s*<Name>([^<]*)<\/Name>\s*<Code>([^<]*)<\/Code>[\s\S]*?<\/Area>/g;
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
          for (const a of am[2].matchAll(AREA)) {
            item.areas.push({ codeType: ct, name: decode(a[1]).trim(), code: a[2].trim() });
          }
        }
      } else {
        for (const a of raw.matchAll(AREA)) {
          item.areas.push({ codeType: c.type, name: decode(a[1]).trim(), code: a[2].trim() });
        }
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
function levelOf({ title, headTitle, headlineText, items }) {
  let level = 0;
  for (const it of items) {
    if (INACTIVE_KIND.test(it.kindName)) continue
    const inName = maxLevelIn(it.kindName);
    if (inName > level) level = inName;
    const mapped = own(FLOOD_KIND_LEVEL, it.kindName) || 0;
    if (mapped > level) level = mapped;
    const legacy = legacyKindLevel(it.kindName);
    if (legacy > level) level = legacy;
  }
  for (const s of [headlineText, headTitle, title]) {
    const n = maxLevelIn(s);
    if (n > level) level = n;
  }
  if (level === 0 && /土砂災害警戒情報/.test(title)) level = 4;
  // 「気象特別警報報知」是气象厅为特別警報专发的最高优先级报知电文；正常情况它的 Kind 名称
  // 就是「大雨特別警報」（已被上面的映射接住），这里只是 Kind 缺失时的兜底。
  // 必须排除"整条电文都是解除"的情况：解除报知的 Kind 是「解除」（循环里被 continue 跳过），
  // 若不排除，标题兜底会把一条解除消息抬成 L5，headline 会显示成「警戒レベル5（已解除）」。
  const allInactive = items.length > 0 && items.every((it) => INACTIVE_KIND.test(it.kindName));
  if (level === 0 && !allInactive && /気象特別警報報知/.test(title)) level = 5;
  return level
}

/**
 * 区域展开：一律归到「都道府県 + 市町村」两层，查不到归属县就标记 prefUnknown（放行）。
 *
 * 市町村名必须换成**本表的规范写法**（canonicalCityOf）再放进 region.city：用户勾选的
 * 市町村名来自市区町村表，而电文与河川区域表给的是外部写法（「南アルプス市」vs 本表
 * 「南あるぷす市」、「金ケ崎町」vs「金け崎町」），直接比对会漏报。取不到规范名时回退原写法。
 */
function regionsOf(items) {
  const out = [];
  const seen = new Set();
  const push = (region) => {
    const key = region.pref + '|' + (region.city || '') + '|' + region.area;
    if (seen.has(key)) return
    seen.add(key);
    out.push(region);
  };
  for (const it of items) {
    if (INACTIVE_KIND.test(it.kindName) || INACTIVE_KIND.test(it.status)) continue
    for (const a of it.areas) {
      const kind = regionKindOf(a.codeType, a.code);
      if (kind === 'city' || kind === 'pref') {
        const city = kind === 'city' ? (canonicalCityOf(a.name) || a.name) : '';
        // 判县优先用区域码前两位（准确），名称反查只在前者不可用时兜底
        const byCode = prefOfCode(a.code);
        if (byCode) {
          push({ pref: byCode, area: a.name, city });
          continue
        }
        const prefs = kind === 'city' ? prefsOfCity(a.name) : prefsOfArea(a.name);
        if (prefs.length === 0) push({ pref: '', area: a.name, city, prefUnknown: true });
        else for (const p of prefs) push({ pref: p, area: a.name, city });
      } else if (kind === 'river') {
        // 河川予報区域码是 12 位，前两位与都道府県无关，只能查 river-areas 表
        const cities = riverAreaCities(a.code);
        if (cities.length === 0) push({ pref: '', area: a.name, city: '', prefUnknown: true });
        else {
          for (const raw of cities) {
            const c = canonicalCityOf(raw) || raw;
            const prefs = prefsOfCity(c);
            if (prefs.length === 0) push({ pref: '', area: a.name, city: c, prefUnknown: true });
            else for (const p of prefs) push({ pref: p, area: a.name, city: c });
          }
        }
      }
      // 判不出类型的条目（水位観測所等）一律忽略
    }
  }
  return out
}

function kindLabelOf(title) {
  for (const [re, label] of KIND_LABELS) if (re.test(title)) return label
  return title || '气象警报'
}

/**
 * 汇总型电文：同一次发布会有 2〜3 份**不同格式的副本**同时出现在 feed 里
 * （实测 2026-09-07 東京都特別警報：VPWW53「気象特別警報・警報・注意報」、
 * VPWW54「気象警報・注意報（Ｈ２７）」、VPNO50「気象特別警報報知」，时间戳 13:57:52〜54）。
 * 它们的 title / headTitle 各不相同，而気象警報・注意報 的 EventID 又是空的——
 * 若沿用「标题」做事件键，同一条警报会被当成三个事件、连响三次铃。
 */
const SUMMARY_TITLE = /気象特別警報・警報・注意報|気象警報・注意報（Ｈ２７）|気象特別警報報知/;
// 灾种关键词（顺序 = 优先级无关，按最高级别的 Kind 名称匹配具体灾种）
const HAZARD_KEYS = [
  [/大雨|浸水/, '大雨'], [/土砂/, '土砂'], [/洪水|氾濫/, '洪水'], [/高潮/, '高潮'],
  [/暴風/, '暴風'], [/波浪/, '波浪'], [/雷/, '雷'], [/濃霧/, '濃霧'],
  [/乾燥/, '乾燥'], [/なだれ/, 'なだれ'], [/大雪|着雪/, '大雪'],
];
/** 取级别最高的那条 Kind 名称，再从中提取灾种——副本之间只要最高级条目相同就会得到同一个键。 */
function hazardKeyOf(items) {
  let name = '';
  let best = -1;
  for (const it of items) {
    if (INACTIVE_KIND.test(it.kindName)) continue
    const lv = Math.max(legacyKindLevel(it.kindName), own(FLOOD_KIND_LEVEL, it.kindName) || 0, maxLevelIn(it.kindName));
    if (lv > best) { best = lv; name = it.kindName; }
  }
  for (const [re, key] of HAZARD_KEYS) if (re.test(name)) return key
  return name || '气象'
}

/**
 * 解析一条 JMA 电文。返回 null 表示这条电文与本插件无关（天气预报、地震火山、观测资料等）。
 * @param {string} xml 详情电文原文
 * @param {{ id?: string }} [entry] Host 侧 feed 条目（用于给 Alert 一个稳定 id）
 * @returns {object|null} Alert
 */
function parseJma(xml, entry) {
  const text = String(xml || '');
  if (!text || text.indexOf('<Report') === -1) return null
  const control = block(text, 'Control');
  const head = block(text, 'Head');

  const title = tag(control, 'Title') || tag(head, 'Title');
  const headTitle = tag(head, 'Title');
  const headlineText = tag(block(head, 'Headline'), 'Text');
  const eventId = tag(head, 'EventID');
  // 用**全文**提取条目：市町村清单常只出现在 Head 的 <Information> 里（Body 的 <Warning>
  // 反而只有摘要），只看 Body 会取不到区域。重复条目由 regionsOf 去重兜住。
  const items = itemsOf(text);

  const level = levelOf({ title, headTitle, headlineText, items });
  const cancelled = items.length > 0 &&
    items.every((it) => INACTIVE_KIND.test(it.kindName) || INACTIVE_KIND.test(it.status));
  // 没有级别又不是解除 → 与预警无关（天气预报、观测资料等），交给调用方丢弃
  if (level === 0 && !cancelled) return null

  const regions = cancelled ? [] : regionsOf(items);
  // 解除电文若展开不出区域，至少保留一个空区域条目，让事件键与提示仍可工作
  const kindLabel = kindLabelOf(title);
  const first = String(headlineText || '').split(/[。\n]/)[0].trim();
  const levelText = level > 0 ? '（警戒レベル' + level + '）' : '';
  const headline = (kindLabel + levelText + (first ? ' · ' + first : '')).slice(0, 180);
  // 事件键：优先 EventID，其次 Head 标题。汇总型电文（同时存在多份格式副本）改用**内容指纹**
  // ——「灾种 + 发布时刻(分钟) + 府县码」——否则同一条警报会因副本标题不同而被当成三个事件、连响三次。
  // 指纹里的府县码取电文 id 的后缀，而不是 regions[0]：解除电文的 regions 恒为空，
  // 用 regions 会让解除与发布算出不同的键，handleCancelled 就找不到"此前提醒过的事件"，
  // 解除提醒会静默丢失（与 0.1.3 加入的取消链路冲突）。
  const idSuffix = /([0-9]{6})\.xml$/.exec(String((entry && entry.id) || ''));
  const eventKey = SUMMARY_TITLE.test(title)
    ? 'jma:summary:' + hazardKeyOf(items) + ':' +
      String(tag(control, 'DateTime') || tag(head, 'ReportDateTime') || '').slice(0, 16) + ':' +
      (idSuffix ? idSuffix[1] : '')
    : 'jma:' + (eventId || headTitle || title);

  return {
    id: (entry && entry.id) || eventId || title,
    code: 'jma',
    kind: 'weather',
    kindLabel: cancelled ? kindLabel + '（已解除）' : kindLabel,
    severity: level >= 4 ? 'red' : (level === 3 ? 'orange' : (level === 2 ? 'yellow' : 'info')),
    issued: tag(head, 'ReportDateTime') || tag(control, 'DateTime'),
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


/** 取第一个有限数值（全球源的坐标/震级可能同时存在于两三个地方，按优先级回退）。 */
function firstNumber(...vals) {
  for (const v of vals) {
    if (typeof v === 'number' && Number.isFinite(v)) return v
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
 * 跨源事件键：同一场地震 EMSC 与 USGS 都会推，两边机构、编号、震级都可能不同，
 * 但「发震时刻（分钟）+ 震中（0.1 度 ≈ 11km）」是一致的。用它把两个全球源的同一次地震
 * 归并成一个事件，避免同一场地震因为接了第二个源而响两次。
 * 代价：跨分钟边界（两边测定的发震时刻差过一分钟）时归并会失败——宁可多响一次，不漏报。
 */
function geoEventKey(timeIso, lat, lon) {
  const min = String(timeIso || '').slice(0, 16); // 2026-09-12T02:15
  const la = (typeof lat === 'number' && Number.isFinite(lat)) ? lat.toFixed(1) : '?';
  const lo = (typeof lon === 'number' && Number.isFinite(lon)) ? lon.toFixed(1) : '?';
  return 'geo:' + min + '@' + la + ',' + lo
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
const NOAA_EVENT_RULES = [
  [/Tsunami Warning/i, '大海啸警报（NOAA）', 3, 'red'],
  [/Tsunami Advisory/i, '海啸注意报（NOAA）', 2, 'orange'],
  [/Tsunami Watch/i, '海啸注意报（NOAA）', 2, 'orange'],
  [/Tsunami Information/i, '海啸信息（NOAA）', 1, 'info'],
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
  // 震中优先取 area 的 circle（"纬,经 半径"），它才是配信覆盖范围；EventLatLon 是备份
  let lat = null;
  let lon = null;
  const circle = tagText(text, 'circle');
  const cm = /^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)/.exec(circle);
  if (cm) { lat = Number(cm[1]); lon = Number(cm[2]); }
  if (lat === null || lon === null) {
    const em = /^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)/.exec(String(params.EventLatLon || ''));
    if (em) { lat = Number(em[1]); lon = Number(em[2]); }
  }
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) { lat = null; lon = null; }
  const mag = toNumOrNull(params.EventPreliminaryMagnitude);
  const rule = NOAA_EVENT_RULES.find(([re]) => re.test(event)) ||
    [/./, '海啸信息（NOAA）', 1, 'info'];
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
    level: 0,
    geo: { lat, lon },
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
  { key: 'usgs', label: 'USGS 地震（约 80km 外）', note: 'M5.6 · 仍在默认半径内', source: 'usgs' },
  { key: 'noaa', label: 'NOAA 海啸注意报', note: 'Tsunami Advisory', source: 'noaa' },
  { key: 'emsc-far', label: 'EMSC 远地地震（约 550km 外）', note: 'M7.0 · 超出默认 300km 半径，刻意不命中', source: 'emsc' },
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
function regionInWatch(region, watch, cityLevel) {
  const list = watch && watch.prefectures;
  const cities = (watch && watch.cities) || [];
  if (list && list.length > 0 && list.indexOf(region.pref) === -1) return false
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
  if (!validGeo(alert.geo)) {
    return { hit: false, reason: '本条消息未携带可用坐标，无法判定震中距' }
  }
  const minMag = (cfg.thresholds || {}).globalMagnitude;
  const mag = typeof alert.magnitude === 'number' && Number.isFinite(alert.magnitude) ? alert.magnitude : null;
  // 震级阈值只作用于地震。海啸的严重性由它自己的等级决定（警报 / 注意报 / 信息），
  // 不该被"引发它的那次地震有多大"过滤掉：NOAA 电文里那个前震震级只是参考值，而且用同一个
  // 阈值卡海啸是危险的——用户把全球阈值调到 M7.0 时，一场 M6.7 引发的海啸警报会被静默丢掉，
  // 而海啸恰恰是这里最不能漏的一类。
  const quakeLike = alert.kind === 'quake' || alert.kind === 'eew';
  if (quakeLike && mag !== null && typeof minMag === 'number' && mag < minMag) {
    return { hit: false, reason: 'M' + mag + ' 低于全球震级阈值 M' + minMag }
  }
  let nearest = null;
  for (const p of places) {
    const d = distanceKm(alert.geo.lat, alert.geo.lon, p.lat, p.lon);
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

function matchAlert(alert, cfg) {
  const w = cfg.watch || {};
  const t = cfg.thresholds || {};
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
    const hitRegion = alert.regions.find((r) => regionInWatch(r, w, alert.kind === 'quake') && typeof r.scale === 'number' && r.scale >= threshold);
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
    const hitRegion = alert.regions.find((r) => regionInWatch(r, w, false) && (own(TSUNAMI_RANK, r.grade) || 0) >= minRank);
    return hitRegion
      ? { hit: true, reason: '海啸等级达标', region: hitRegion }
      : { hit: false, reason: missReason(alert, w, '关注地区未命中或等级低于阈值') }
  }
  if (alert.kind === 'weather') {
    if ((cfg.disasters || {}).weather === false) return { hit: false, reason: '气象灾害提醒已关闭' }
    if (alert.cancelled) return { hit: false, reason: '解除消息不提醒' }
    // 播报边界写死在 L4：L1〜L3 仍然解析、仍然进历史（灰色条目），只是不打扰。
    // 依据见 DESIGN 10.3——L3 是「高齢者等避難」，与 DSH 用户群不匹配；L4 才是避难指示级。
    if (!(typeof alert.level === 'number' && alert.level >= 4)) {
      return { hit: false, reason: '警戒レベル' + (alert.level || '—') + '（未达 L4，仅记录）' }
    }
    if (alert.regions.length === 0) return { hit: false, reason: '本条电文未携带可判定的区域' }
    const hitRegion = alert.regions.find((r) => regionInWeatherWatch(r, w));
    return hitRegion
      ? { hit: true, reason: '警戒レベル' + alert.level + '（' + (hitRegion.city || hitRegion.area) + '）', region: hitRegion }
      : { hit: false, reason: missReason(alert, w, '关注地区未命中') }
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
// 依赖：01-constants、07-store（通道建立时机在 15-entry 的 apply 里）。
// 注意：通道监听必须在插件加载时就建立，否则会错过其它标签页的广播。
// ============================================================================

// ---------- 去重 ----------
// 三层：① 消息 id（防重连重放）② 事件键（同一地震的多次发布）③ 跨标签页（多开 DSH 页面）
const seen = new Map(); // id -> ts
function isDuplicate(id, windowMinutes) {
  if (!id) return false
  const now = Date.now();
  const win = Math.max(1, windowMinutes || 10) * 60 * 1000;
  for (const [k, v] of seen) if (now - v > win || v > now) seen.delete(k);
  if (seen.has(id)) return true
  seen.set(id, now);
  return false
}
// 同一次地震会连发「震度速报 → 震源情报 → 各地震度」或 EEW 多报（serial 递增）。
// 这些消息 id 各不相同，但共享事件键；只有强度升级时才再提醒一次，避免连续响铃。
const eventSeen = new Map(); // eventKey -> { ts, strength }
function isEventRepeat(alert, windowMinutes) {
  if (!alert.eventKey) return false
  const now = Date.now();
  const win = Math.max(1, windowMinutes || 10) * 60 * 1000;
  for (const [k, v] of eventSeen) if (now - v.ts > win || v.ts > now) eventSeen.delete(k);
  const prev = eventSeen.get(alert.eventKey);
  if (prev && alert.strength <= prev.strength) return true
  eventSeen.set(alert.eventKey, { ts: now, strength: alert.strength });
  return false
}
// 已实际提醒过的事件（eventKey / kind → ts）。
// 取消 / 解除消息只在「此前确实提醒过同一事件」时才补一条：既避免「没收到警报却收到取消」的困惑，
// 也让用户知道已经发出的警报作废（EEW 取消 / 海啸解除本身是有用信息，不该静默）。
const ALERTED_MAX_MS = 1440 * 60 * 1000;
const alertedEvents = new Map();
const cancelKeyOf = (alert) => alert.eventKey || alert.kind;
function rememberAlerted(alert) {
  const now = Date.now();
  for (const [k, v] of alertedEvents) if (now - v > ALERTED_MAX_MS || v > now) alertedEvents.delete(k);
  alertedEvents.set(cancelKeyOf(alert), now);
}
function wasRecentlyAlerted(alert, windowMinutes) {
  const key = cancelKeyOf(alert);
  const v = alertedEvents.get(key);
  if (typeof v !== 'number') return false
  const now = Date.now();
  const win = Math.max(1, windowMinutes || 10) * 60 * 1000;
  if (v > now || now - v > win) { alertedEvents.delete(key); return false }
  return true
}
// 多开 DSH 页面时每个标签页都会收到同一条推送；用 BroadcastChannel 协商，只让一个标签页播报。
// 通道必须在插件加载时就建立监听（见 apply），否则后加载的标签页会错过先到的广播。
// 不支持 BroadcastChannel 时退化为「各标签页各自提醒」，不影响正确性。
const TAB_DEDUPE_MS = 5000;
const tabAlerted = new Map(); // key -> ts
let alertChannel = null;
function ensureAlertChannel() {
  if (alertChannel !== null || typeof window === 'undefined' || typeof window.BroadcastChannel !== 'function') return alertChannel
  try {
    alertChannel = new window.BroadcastChannel('dsh-quake-alert');
    alertChannel.onmessage = (ev) => {
      const d = ev && ev.data;
      if (!d || d.type !== 'alerted' || !d.key) return
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
  for (const [k, v] of tabAlerted) if (now - v > TAB_DEDUPE_MS || v > now) tabAlerted.delete(k);
  if (tabAlerted.has(key)) return false
  tabAlerted.set(key, now);
  if (ensureAlertChannel()) {
    try { alertChannel.postMessage({ type: 'alerted', key, eventKey: eventKey || '' }); } catch (err) { /* 通道已关闭等忽略 */ }
  }
  return true
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
 * 系统通知 / 页内 toast 的标题。抽成纯函数是为了能直接断言文案——
 * 旧写法把「地震情报 · 」与「各地震度」分开拼，非「各地」分支会留下一个悬空的分隔符。
 */
function alertTitleOf(alert) {
  if (!alert) return '灾害预警'
  // kindLabel 本身已区分「地震速报·震度速报」「地震情报·各地震度」等，不需要再拼后缀
  if (alert.kind === 'eew') return '⚠ 紧急地震速报（警报）'
  if (alert.kind === 'quake') return '🌐 ' + alert.kindLabel
  if (alert.kind === 'tsunami') return '🌊 ' + alert.kindLabel
  if (alert.kind === 'weather') return '🌧 ' + alert.kindLabel
  return '灾害预警'
}

// 气象警报的「静默提示」：只在"命中关注地区、但未达 L4 所以没有播报"时留一笔，
// 由侧边栏状态点的悬停提示与设置页显示。
// 注意 L4 以上**必须清掉**它：那时已经真正播报过，再挂着这条（文案是"未达 L4，未播报"）
// 就与事实自相矛盾——这是加测试按钮后暴露出来的问题。
function updateWeatherHint(alert, cfg) {
  if (alert.kind !== 'weather' || alert.cancelled) return
  if ((cfg.disasters || {}).weather === false) return
  if (alert.level !== 3) {
    if (store.weatherHint) store.push({ weatherHint: null });
    return
  }
  const hit = alert.regions.find((r) => regionInWeatherWatch(r, cfg.watch || {}));
  if (!hit) return
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
  if (!wasRecentlyAlerted(alert, cfg.dedupe.windowMinutes)) {
    addEvent({
      id: alert.id, kind: alert.kind, label: alert.kindLabel, severity: alert.severity,
      issued: alert.issued, headline: alert.headline + '（未命中：取消 / 解除消息，且此前未提醒过该事件）', hit: false,
    });
    return
  }
  // 取消 / 解除消息不穿透静默（它不是紧急警报，静默期间只记历史）
  if (inQuietHours(cfg)) {
    addEvent({
      id: alert.id, kind: alert.kind, label: alert.kindLabel, severity: alert.severity,
      issued: alert.issued, headline: alert.headline, hit: true,
      suppressed: true,
      suppressedReason: '静默时段 ' + cfg.quietHours.start + '–' + cfg.quietHours.end + '（取消 / 解除不穿透）',
    });
    return
  }
  alertedEvents.delete(cancelKeyOf(alert)); // 同一条取消只提醒一次
  if (!claimAlertForTab('cancel:' + (alert.id || cancelKeyOf(alert)), '')) {
    addEvent({
      id: alert.id, kind: alert.kind, label: alert.kindLabel, severity: alert.severity,
      issued: alert.issued, headline: alert.headline, hit: true,
      suppressed: true, suppressedReason: '其它 DSH 标签页已提醒',
    });
    return
  }
  addEvent({
    id: alert.id, kind: alert.kind, label: alert.kindLabel, severity: alert.severity,
    issued: alert.issued, headline: alert.headline, hit: true,
  });
  const title = alert.kind === 'eew' ? '✅ 紧急地震速报已取消'
    : (alert.kind === 'tsunami' ? '✅ 海啸预报已解除' : '✅ ' + alert.kindLabel);
  const body = alert.headline + '\n此前发出的警报已作废。\n—— 仅供参考，请以气象厅官方发布为准';
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
  store.received += 1;
  if (isDuplicate(alert.id, cfg.dedupe.windowMinutes)) {
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
    // 全球源（坐标型）的"未命中"不进历史：USGS 的 24 小时目录有近百条 M2.5+，
    // 逐条记"未命中"会把历史列表刷满与用户无关的地震，真正该看的提醒反而被挤掉。
    // 命中项仍然照常记录；设置页的源统计里能看到拉取与解析条数。
    if (alert.locator !== 'point') {
      addEvent({
        id: alert.id, kind: alert.kind, label: alert.kindLabel, severity: alert.severity,
        issued: alert.issued, headline: alert.headline + '（未命中：' + m.reason + '）', hit: false,
      });
    }
    return { notified: false, reason: 'not-hit', detail: m.reason }
  }
  const hitPref = m.region ? m.region.pref : '';
  // 严重度：地震按「命中区域的实际强度」判定（关注县震度低时颜色不该是红）；
  // EEW 恒为 red（警报本质，不能因为预测震度刚好到阈值就降级成橙色）；
  // 海啸用自身等级（MajorWarning / Warning → red，Watch → orange）。
  const hitSeverity = alert.kind === 'quake'
    ? severityOfScale(m.region && typeof m.region.scale === 'number' ? m.region.scale : alert.maxScale)
    : alert.severity;
  // 同一次地震的后续发布（速报 → 震源 → 各地震度、或 EEW 多报）强度未升级 → 只更新历史，不再响铃
  if (isEventRepeat(alert, cfg.dedupe.windowMinutes)) {
    addEvent({
      id: alert.id, kind: alert.kind, label: alert.kindLabel, severity: hitSeverity,
      issued: alert.issued, headline: alert.headline, hit: true, pref: hitPref,
      suppressed: true, suppressedReason: '同一地震的后续发布（强度未升级）',
    });
    return { notified: false, reason: 'event-repeat', detail: '同一事件的后续发布，强度未升级' }
  }
  // 静默时段：命中但不响铃、不弹通知，只记历史。红色等级（EEW、大海啸警报）默认可穿透。
  if (!options.skipQuietHours && inQuietHours(cfg) && !(hitSeverity === 'red' && cfg.quietHours.breakForSevere !== false)) {
    addEvent({
      id: alert.id, kind: alert.kind, label: alert.kindLabel, severity: hitSeverity,
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
      id: alert.id, kind: alert.kind, label: alert.kindLabel, severity: hitSeverity,
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
  bodyLines.push('—— 仅供参考，请以气象厅官方发布为准');
  addEvent({
    id: alert.id, kind: alert.kind, label: alert.kindLabel, severity: hitSeverity,
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
  const report = (patch) => store.pushSource(sourceId, Object.assign({ label }, patch));
  let ws = null;
  let timer = null;
  let staleTimer = null;
  let connectTimer = null;
  let stopped = false;
  let retries = 0;
  let lastActivityAt = 0; // 最近一次 onopen / onmessage 的时刻

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
      lastActivityAt = Date.now();
      armStaleWatch();
      report({ status: 'open', retries: 0, detail: openDetailOf(url) });
    };
    ws.onmessage = (ev) => {
      lastActivityAt = Date.now();
      try {
        const raw = JSON.parse(String(ev.data));
        onRaw(raw, currentCfg());
      } catch (err) { /* 单条解析失败不影响连接 */ }
    };
    ws.onerror = () => { /* onclose 统一处理 */ };
    ws.onclose = () => {
      clearConnectWatch();
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
    start() { connect(); },
    stop() {
      stopped = true;
      teardown();
      report({ status: 'closed', retries, detail: '已停止（插件停用）' });
    },
    restart() {
      stopped = false;
      retries = 0; // 切数据源后立即从 1s 退避重新开始，而不是沿用上一条连接的退避进度
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

async function defaultFetchJson(url) {
  const AS = (typeof window !== 'undefined' && window) ? window.AbortSignal : undefined;
  const signal = (AS && typeof AS.timeout === 'function') ? AS.timeout(FEED_FETCH_TIMEOUT_MS) : undefined;
  const res = await window.fetch(url, { headers: { accept: 'application/json' }, signal });
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
 * @param {(entry: object, cfg: object) => boolean} [opts.apply] 注入点（测试用）
 * @param {() => object} [opts.getCfg] 注入点（测试用）
 * @param {() => (number|null)} [opts.loadCursor] 注入点（测试用；默认读 localStorage）
 * @param {(v: number) => void} [opts.saveCursor] 注入点（测试用；默认写 localStorage）
 * @param {(err: Error) => void} [opts.onError]
 */
function createFeedClient(opts = {}) {
  const id = opts.id || 'jma';
  const path = opts.path || FEED_PATH;
  const cursorKey = opts.cursorKey || FEED_CURSOR_KEY;
  const intervalMs = opts.intervalMs || FEED_POLL_MS;
  const firstDelayMs = opts.firstDelayMs === undefined ? FEED_FIRST_DELAY_MS : opts.firstDelayMs;
  const fetchJson = opts.fetchJson || defaultFetchJson;
  const getCfg = opts.getCfg || currentCfg;
  const onError = opts.onError || (() => {});
  // 该源此轮要不要拉：气象源跟 weather 开关，全球地震跟 earthquake 开关，海啸跟 tsunami 开关。
  // 关掉之后 Client 不再拉增量，Host 侧对应的轮询器也会因 idle 自然停下。
  const enabled = opts.enabled || ((cfg) => (cfg.disasters || {}).weather !== false);
  const loadCursor = opts.loadCursor || (() => loadFeedCursor(cursorKey));
  const saveCursor = opts.saveCursor || ((v) => saveFeedCursor(v, cursorKey));
  const apply = opts.apply || ((entry, cfg) => {
    const alert = parseJma(entry && entry.xml, { id: entry && entry.id });
    if (!alert) return false
    handleAlert(alert, cfg);
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
  let inFlight = null;
  const stats = { polls: 0, received: 0, applied: 0, errors: 0, truncated: 0, tailSync: 0, resets: 0, morePages: 0, lastAt: 0, cursor: 0 };

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
    let data;
    try {
      // path 可能自带查询串（全球源用 `?source=usgs` 分派），所以要按需选分隔符
      const sep = path.indexOf('?') === -1 ? '?' : '&';
      data = await fetchJson(path + sep + 'since=' + (since === null ? FEED_TAIL : since));
    } catch (err) {
      stats.errors += 1;
      onError(err);
      return { applied: 0, cursor: cursorNow() }
    }
    stats.lastAt = Date.now();
    // 首次对齐：Host 只回当前位置。不应用任何条目（即使响应里意外带了也不应用），
    // 否则"刷新页面"又变成了重放历史。
    if (data && data.tail === true) {
      stats.tailSync += 1;
      setCursor(data.cursor);
      stats.cursor = cursorNow();
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
    for (const e of entries) {
      stats.received += 1;
      try {
        if (apply(e, getCfg())) applied += 1;
      } catch (err) {
        // 单条电文解析失败不能影响后续条目，也不能让游标停住
        stats.errors += 1;
        onError(err);
      }
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
      const next = last && Number.isFinite(last.seq) ? last.seq : data.cursor;
      if (data.more === true) stats.morePages += 1;
      setCursor(next);
    }
    stats.cursor = cursorNow();
    return { applied, cursor: cursorNow(), truncated: !!(data && data.truncated), reset, more: !!(data && data.more) }
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
    timer = setTimeout(async () => {
      timer = null;
      // 该源的灾种开关关闭时不必拉增量（Host 侧随后也会据此停轮询）
      if (enabled(getCfg())) {
        try { await pollSerial(); } catch (err) { onError(err); }
      }
      schedule(intervalMs);
    }, delay);
  }

  return {
    id,
    path,
    cursorKey,
    start() {
      if (running) return
      running = true;
      schedule(firstDelayMs);
    },
    stop() {
      running = false;
      if (timer) { clearTimeout(timer); timer = null; }
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
/** 历史条目「类型」行的来源标注：气象电文来自気象庁防災情報XML，没有 P2PQuake code。 */
function p2pCodeTextOf(kind) {
  const code = own(P2P_KIND_CODE, kind);
  if (code) return 'code ' + code
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
  select: (value, options, onChange, textOf) => h('select', {
    value, onChange: (e) => onChange(e.target.value),
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
  const [placeDraft, setPlaceDraft] = useState({ name: '', lat: '', lon: '', radiusKm: '300' });
  const [placeMsg, setPlaceMsg] = useState('');
  // 全球链路的测试（0.4.0）：场景轮换游标与结果提示
  const [geTestSeq, setGeTestSeq] = useState(0);
  const [geTestMsg, setGeTestMsg] = useState('');
  // 「全球源状态」里的相对时间要自己走（feedStatsOf 不经过 store，避免每 15 秒重渲整个设置页）
  const [, setFeedTick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setFeedTick((x) => x + 1), 5000);
    return () => clearInterval(t)
  }, []);
  // 音量滑块：拖动期间只改本地草稿，停手 300ms 后才落盘（避免每移动 1px 写一次 localStorage）
  const [volDraft, setVolDraft] = useState(null);
  const volTimer = useRef(null);
  const volPending = useRef(null); // 尚未落盘的草稿值：卸载时补写，拖完立刻关设置页也不丢改动
  // store 变化（新预警、Host 配置同步）都要重新读一次当前配置
  useEffect(() => store.subscribe(() => { setTick((t) => t + 1); setCfgState(currentCfg()); }), []);
  useEffect(() => () => {
    if (volTimer.current) { clearTimeout(volTimer.current); volTimer.current = null; }
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
  // 全球源状态（0.4.0）：用户看不出"链路到底在不在拉"，这是最常见的困惑来源——
  // 尤其全球地震本来就不频繁。feedStatsOf 不经过 store（见 12b 的注释），所以这里自己每 5 秒重读。
  const feedStatusBlock = () => {
    const rows = [];
    const emsc = (store.sources || {}).emsc;
    rows.push('EMSC（全球地震，实时推送）：' + (emsc
      ? statusMetaOf(emsc.status, emsc.retries).text + (emsc.detail ? ' · ' + emsc.detail : '')
      : '未启动'));
    const sourceLabel = {
      jma: '気象庁（气象灾害，Host 轮询）',
      usgs: 'USGS（全球地震目录，Host 轮询）',
      noaa: 'NOAA（海啸，Host 轮询）',
    };
    for (const id of ['jma', 'usgs', 'noaa']) {
      const st = feedStatsOf[id];
      if (!st) { rows.push(sourceLabel[id] + '：尚未拉取'); continue }
      const ago = st.lastAt ? Math.max(0, Math.round((Date.now() - st.lastAt) / 1000)) + ' 秒前' : '—';
      rows.push(sourceLabel[id] + '：已收到 ' + st.received + ' 条增量' +
        (st.errors ? '，' + st.errors + ' 次失败' : '') + ' · 最近拉取 ' + ago);
    }
    return h('div', { style: { marginTop: 10, fontSize: 11, color: '#9aa0a6', lineHeight: 1.7 } },
      h('div', { style: { marginBottom: 2 } }, '全球源状态'),
      rows.map((t, i) => h('div', { key: 'feedstat-' + i }, t)),
    )
  };
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
    store.weatherHint
      ? h('div', { style: { fontSize: 11, color: '#d9a406', marginTop: 4 } },
          '当前：' + (store.weatherHint.label || '') +
          ' 有 L' + store.weatherHint.level + ' 气象警报（未达 L4，未播报）')
      : null,
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
      ? h('div', { style: { color: '#93c5fd', fontSize: 11, marginTop: 4 } }, weatherTestMsg)
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
          if (activeClient) setTimeout(() => { try { activeClient.restart(); } catch (err) {} }, 80);
        }, (o) => o.label),
      ),
      h('div', { style: { fontSize: 11, color: '#9aa0a6', marginTop: 6 } },
        '配置存储：' + settingsSyncLabel()),
    ),

    // 关注地区
    s.section('关注地区（都道府县 / 市区町村）',
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

    // 全球关注点（0.4.0）：全球源是坐标型，关注表达是「位置 + 半径」
    s.section('全球关注点（坐标 + 半径）',
      h('div', { style: { fontSize: 11, color: '#9aa0a6', marginBottom: 8 } },
        (cfg.watch.places || []).length === 0
          ? '未设置时，全球源（EMSC / USGS 地震、NOAA 海啸）的消息不会打扰你。添加你所在或关心的位置即可生效，不需要重启。'
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
        placeField('半径 km', 'radiusKm', '300', 80),
        s.btn('添加关注点', addPlace),
        s.btn('用当前位置', useMyLocation),
      ),
      placeMsg ? h('div', { style: { fontSize: 11, color: '#93c5fd', marginTop: 6 } }, placeMsg) : null,
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
          '。最后一条刻意落在半径之外——用来演示半径是怎么起作用的。'),
        geTestMsg ? h('div', { style: { color: '#93c5fd', fontSize: 11, marginTop: 4 } }, geTestMsg) : null,
      ),
      feedStatusBlock(),
    ),

    // 阈值
    s.section('提醒阈值',
      s.label('地震（实测震度最低值）'),
      s.row(s.select(cfg.thresholds.quakeScale, SCALE_OPTIONS, (v) => setCfg((c) => ({ ...c, thresholds: { ...c.thresholds, quakeScale: Number(v) } })), (o) => o.label)),
      s.label('紧急地震速报（预测震度最低值）'),
      s.row(s.select(cfg.thresholds.eewScale, SCALE_OPTIONS, (v) => setCfg((c) => ({ ...c, thresholds: { ...c.thresholds, eewScale: Number(v) } })), (o) => o.label)),
      s.label('海啸'),
      s.row(s.select(cfg.thresholds.tsunamiGrade, TSUNAMI_OPTIONS, (v) => setCfg((c) => ({ ...c, thresholds: { ...c.thresholds, tsunamiGrade: v } })), (o) => o.label)),
      s.label('全球地震（最低震级，EMSC / USGS）'),
      s.row(s.select(cfg.thresholds.globalMagnitude, GLOBAL_MAG_OPTIONS, (v) => setCfg((c) => ({ ...c, thresholds: { ...c.thresholds, globalMagnitude: Number(v) } })), (o) => o.label)),
      h('div', { style: { fontSize: 11, color: '#9aa0a6' } },
        '全球源给的是震级、日本源给的是震度，两者不可换算，所以是两个独立旋钮。'),
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
        style: { flex: 1, minWidth: 120 },
      }), h('span', { style: { color: '#9aa0a6', fontSize: 11, width: 34 } }, Math.round(volShown * 100) + '%')),
      s.row(
        s.btn('试听地震音', () => playSound('quake', volShown)),
        s.btn('试听 EEW 音', () => playSound('eew', volShown)),
        s.btn('试听海啸音', () => playSound('tsunami', volShown)),
        s.btn('试听气象音', () => playSound('weather', volShown)),
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
      testMsg ? h('div', { style: { color: '#93c5fd', fontSize: 11, marginTop: 4 } }, testMsg) : null,
    ),

    // 静默时段（0.2.0）
    s.section('静默时段',
      s.row(s.checkbox(cfg.quietHours.enabled, (v) => setCfg((c) => ({ ...c, quietHours: { ...c.quietHours, enabled: v } })), '启用静默时段')),
      s.row(
        s.label('开始'),
        h('input', {
          type: 'time', value: cfg.quietHours.start,
          onChange: (e) => setCfg((c) => ({ ...c, quietHours: { ...c.quietHours, start: e.target.value || c.quietHours.start } })),
          style: { background: '#ffffff', color: '#1a1a1a', border: '1px solid #6b7280', borderRadius: 6, padding: '4px 8px', fontSize: 12 },
        }),
        s.label('结束'),
        h('input', {
          type: 'time', value: cfg.quietHours.end,
          onChange: (e) => setCfg((c) => ({ ...c, quietHours: { ...c.quietHours, end: e.target.value || c.quietHours.end } })),
          style: { background: '#ffffff', color: '#1a1a1a', border: '1px solid #6b7280', borderRadius: 6, padding: '4px 8px', fontSize: 12 },
        }),
      ),
      s.row(s.checkbox(cfg.quietHours.breakForSevere, (v) => setCfg((c) => ({ ...c, quietHours: { ...c.quietHours, breakForSevere: v } })), '红色等级（EEW / 大海啸警报）仍提醒')),
      h('div', { style: { fontSize: 11, color: '#9aa0a6', marginTop: 6 } },
        '按浏览器本地时间判定；开始时间晚于结束时间表示跨午夜（如 23:00–07:00）。静默期间命中的预警仍会记入下方「最近预警记录」，只是不响铃、不弹通知。'),
    ),

    // 免责
    s.section('免责声明', h('div', { style: { color: '#9aa0a6', fontSize: 11, lineHeight: 1.6 } },
      '预警数据由 P2PQuake 转播（非官方直接数据源），EEW 紧急地震速报等内容与配信品质无保证。' +
      '本插件提醒仅供参考，请务必以日本气象厅（気象庁）官方发布为准。插件仅在 DSH 页面开启时工作。')),

    // 最近预警（点击条目展开详情；多条时可滚动）
    s.section('最近预警记录（' + store.events.length + ' 条）',
      h('div', { style: { fontSize: 11, color: '#9aa0a6', marginBottom: 6 } },
        '记录匹配链路上处理过的消息（含未达阈值、未提醒的灰色记录），点条目展开完整内容。'),
      store.events.length === 0
        ? h('div', { style: { color: '#9aa0a6', fontSize: 12, padding: '4px 0' } }, '暂无记录 —— 收到真实预警或测试消息后显示')
        : h('div', { style: { maxHeight: 300, overflowY: 'auto', paddingRight: 4 } },
            store.events.slice(0, HISTORY_MAX).map((e, i) => {
              const open = expanded === (e.key || e.id || i);
              const head = String(e.headline || '');
              const muted = e.hit === false || e.suppressed === true;
              const statusText = e.hit === false
                ? '未触发提醒'
                : (e.suppressed ? '未重复提醒' : (e.pref ? '命中 ' + e.pref : '已提醒'));
              // 气象电文来自気象庁防災情報XML，没有 P2PQuake 的 code：旧写法对 weather 落进
              // 最后的 else 分支，展开详情时会把泥石流 / 洪水电文标成「code 551」（地震速报）。
              const codeText = p2pCodeTextOf(e.kind);
              return h('div', {
                key: e.key || e.id || i,
                onClick: () => setExpanded(open ? null : (e.key || e.id || i)),
                title: open ? '点击收起' : '点击展开详情',
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
                        h('span', { style: { color: '#e6e6e8' } }, String(e.issued || '—'))),
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
      s.row(s.btn('清空记录', () => { store.events = []; saveJSON(HISTORY_KEY, []); store.push({}); })),
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
    h('span', { style: { display: 'inline-block', width: 8, height: 8, borderRadius: '50%', background: meta.color, flex: '0 0 auto' } }),
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

  // 跨标签页去重通道：必须在插件加载时就开始监听，否则会错过其它标签页的广播
  ensureAlertChannel();
  ctx.effect(() => () => {
    closeAlertChannel();
  }, 'dsh-quake-alert: tab channel');

  // 机器级持久化：settings 服务可用时，配置交给 DSH 的 settings.yaml（Host 侧同名 namespace）。
  // 服务缺席（或页面非 loopback）时保持 localStorage 路径，插件照常工作。
  if (typeof ctx.inject === 'function') {
    ctx.inject(['settingsScope'], (settingsCtx) => {
      try {
        bindSettingsScope(settingsCtx.settingsScope.bind({ namespace: SETTINGS_NS }));
      } catch (err) { /* bind 失败 → 继续用 localStorage */ }
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
  const client = createWsClient();
  setActiveClient(client);
  ctx.effect(() => {
    client.start();
    return () => { try { client.stop(); } catch (err) {} }
  }, 'dsh-quake-alert: ws client');

  // 気象庁电文增量（0.3.0）：Host 侧负责轮询与去重，这里只拉本地增量并交给主链。
  const feed = createFeedClient();
  // 全球地震（USGS，0.4.0）：Host 轮询 GeoJSON（单级），Client 只拉本地增量。
  // 与 EMSC 是互补关系——EMSC 是实时推送，USGS 目录更完整、还带修订版（updated 刷新）。
  // 两者的同类地震靠 geoEventKey 归并，不会重复提醒。
  const usgsFeed = createFeedClient({
    id: 'usgs',
    path: FEED_PATH + '?source=usgs',
    cursorKey: FEED_CURSOR_KEY + '.usgs',
    enabled: (cfg) => (cfg.disasters || {}).earthquake !== false,
    apply: (entry, cfg) => {
      let feature;
      try { feature = JSON.parse(entry && entry.xml); } catch (err) { return false }
      const alert = parseUsgsFeature(feature);
      if (!alert) return false
      handleAlert(alert, cfg);
      return true
    },
  });
  // 海啸（NOAA，0.4.0）：Host 拉事件列表再取 CAP 详情，Client 解析 CAP。
  const noaaFeed = createFeedClient({
    id: 'noaa',
    path: FEED_PATH + '?source=noaa',
    cursorKey: FEED_CURSOR_KEY + '.noaa',
    intervalMs: 5 * 60 * 1000,
    enabled: (cfg) => (cfg.disasters || {}).tsunami !== false,
    apply: (entry, cfg) => {
      const alert = parseNoaaCap(entry && entry.xml, { id: entry && entry.id });
      if (!alert) return false
      handleAlert(alert, cfg);
      return true
    },
  });
  const feeds = [feed, usgsFeed, noaaFeed];
  ctx.effect(() => {
    for (const f of feeds) f.start();
    return () => { for (const f of feeds) { try { f.stop(); } catch (err) {} } }
  }, 'dsh-quake-alert: feed clients');

  // 全球地震（0.4.0）：EMSC 的 WebSocket，复用与 P2PQuake 同一套连接管理（退避、建连看门狗、
  // 生命周期归还 fiber）。但**关掉「久无数据」检测**（staleAfterMs=0）：全球 M4+ 大约每 30 分钟
  // 才有一次推送，拿消息间隔判断连接死活会把一条完全正常的连接反复掐断重连。真正的断开
  // 浏览器会给 onclose，建连看门狗也仍然生效，所以这两种静默失效并没有被放过。
  const emsc = createWsClient({
    sourceId: 'emsc',
    label: 'EMSC',
    urlOf: () => EMSC_WS_URL,
    staleAfterMs: 0,
    openDetail: () => '已连接 EMSC（全球地震实时推送）',
    onRaw: (raw, cfg) => {
      const alert = parseEmsc(raw);
      if (alert) handleAlert(alert, cfg);
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
const __test = { parse, parseQuake, parseEew, parseTsunami, parseJma, parseEmsc, parseUsgsFeature, parseUsgsFeed, parseNoaaCap, severityOfMagnitude, geoEventKey, TEST_GEO_SCENARIOS, buildTestGlobalMessage, parseTestGlobalMessage, feedStatsOf, watchlessPoint, buildTestTelegram, TEST_SCENARIOS, jmaMaxLevelIn: maxLevelIn, jmaItemsOf: itemsOf, matchAlert, matchPointAlert, distanceKm, validGeo, normalizePlaces, soundKindOf, playSound, sevColor, p2pCodeTextOf, kindColorOf, alertTitleOf, prefsOfArea, regionsOfArea, AREA_PREF, loadCfg, normalizeCfg, loadHistory, normalizeHistoryEntry, addEvent, handleRaw, handleCancelled, handleAlert, updateWeatherHint, createFeedClient, FEED_PATH, FEED_POLL_MS, FEED_CURSOR_KEY, FEED_TAIL, inQuietHours, isDuplicate, isEventRepeat, claimAlertForTab, ensureAlertChannel, createWsClient, store, HISTORY_MAX, PREFECTURES, DEFAULT_CFG, currentCfg, applyCfg, reloadFromLocal, bindSettingsScope, settingsOpsFor, cfgToSection, sectionToCfg, SETTINGS_NS, settingsState, resetSettings, setCityTable, citiesOfPref, prefsOfCity, canonicalCityOf, normKana, setRiverAreas, riverAreaCities, cityAliases, lookupAddrCity, buildAddrIndex, normalizePref, prefOfCode, prefCodeOf, pruneUnknownCities, loadCityTable, abortCityTableLoad, cityTableState: () => cityTableState, resetCityTable };

// activeClient 是 12-websocket 的模块级 let：给 12 用的赋值出口（跨模块不能写 imported binding）
// 由 12-websocket 提供 setter；这里仅保留引用以便阅读

exports.__test = __test;
exports.apply = apply;
exports.inject = inject;
exports.name = name;

return module.exports;
} });
