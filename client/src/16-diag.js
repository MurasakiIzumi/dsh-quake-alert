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

import { currentCfg, settingsSync } from './03-settings-bridge.js'
import { sourceHealthOf } from './05g-source-health.js'
import { store } from './07-store.js'
import { feedStatsOf } from './12b-feed-poll.js'
import { overseasStatsOf } from './12e-overseas-poll.js'
import { cnStreamRegistry } from './12c-cn-stream.js'

/** 快照格式版本（与插件版本无关，见文件头）。 */
export const DIAG_SNAPSHOT_VERSION = 1

const str = (v) => String(v === undefined || v === null ? '' : v)
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null)

/** 每个片段都各自兜错：诊断工具在任何状态下都必须能产出东西。 */
function safe(fn, fallback, warnings, label) {
  try {
    return fn()
  } catch (err) {
    warnings.push(label + '：' + str((err && err.message) || err))
    return fallback
  }
}

/** 来源标注：让 AI 知道这条状态是哪条链路报的，不用去猜字段顺序。 */
function sourceRows() {
  const out = {}
  const srcs = (store && store.sources) || {}
  for (const id of Object.keys(srcs)) {
    const s = srcs[id] || {}
    out[id] = { label: str(s.label), status: str(s.status), retries: num(s.retries), detail: str(s.detail) }
  }
  return out
}

/** 增量源的计数（12b）：只留诊断用得上的字段，host 那段原样带上（它就是 Host 的健康计数）。 */
function feedRows() {
  const out = {}
  for (const id of Object.keys(feedStatsOf)) {
    const f = feedStatsOf[id] || {}
    out[id] = {
      polls: num(f.polls), received: num(f.received), applied: num(f.applied),
      errors: num(f.errors), truncated: num(f.truncated), resets: num(f.resets),
      tailSync: num(f.tailSync), morePages: num(f.morePages),
      lastAt: f.lastAt ? new Date(f.lastAt).toISOString() : null,
      cursor: num(f.cursor), running: f.running === true,
      host: f.host || null,
    }
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
  const out = {}
  for (const id of Object.keys(overseasStatsOf)) {
    const o = overseasStatsOf[id] || {}
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
    }
  }
  return out
}

/** 大陆源（12c）：**链路模式是这里最要紧的一列**——降级意味着延迟从秒级变成最长 15 秒。 */
function streamRows() {
  const out = {}
  for (const id of Object.keys(cnStreamRegistry)) {
    const reg = cnStreamRegistry[id]
    const s = safe(() => reg.stats(), {}, [], 'stream:' + id) || {}
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
    }
  }
  return out
}

/** 关注点摘要。**坐标是有意保留的**：匹配失败通常就要靠"震中距最近关注点多少公里"来判，
 *  去掉坐标等于把最有用的那一列删了。用户是主动粘贴这份快照的，界面上也写明了含坐标。 */
function watchSummary(cfg) {
  const w = (cfg && cfg.watch) || {}
  const places = Array.isArray(w.places) ? w.places : []
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
  const evs = (store && Array.isArray(store.events)) ? store.events : []
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
  const out = { visibility: 'unknown', online: null, hasEventSource: false, hasBroadcastChannel: false }
  try {
    if (typeof document !== 'undefined' && document && typeof document.visibilityState === 'string') {
      out.visibility = document.visibilityState
    }
  } catch (err) { /* 忽略 */ }
  try {
    if (typeof navigator !== 'undefined' && navigator && typeof navigator.onLine === 'boolean') out.online = navigator.onLine
  } catch (err) { /* 忽略 */ }
  try {
    out.hasEventSource = typeof window !== 'undefined' && typeof window.EventSource === 'function'
    out.hasBroadcastChannel = typeof window !== 'undefined' && typeof window.BroadcastChannel === 'function'
  } catch (err) { /* 忽略 */ }
  return out
}

/**
 * 生成诊断快照。
 * @param {number} [now] 注入点（测试用）
 * @returns {object} 可直接 JSON.stringify 的纯数据对象
 */
export function buildDiagSnapshot(now) {
  const warnings = []
  const cfg = safe(() => currentCfg() || {}, {}, warnings, 'cfg') || {}
  const t = (typeof now === 'number' && Number.isFinite(now)) ? now : Date.now()
  const cfgThresholds = (cfg && cfg.thresholds) || {}
  const cfgDisasters = (cfg && cfg.disasters) || {}
  const cfgNotify = (cfg && cfg.notify) || {}
  const cfgDedupe = (cfg && cfg.dedupe) || {}
  const cfgQuiet = (cfg && cfg.quietHours) || {}
  const thresholds = {}
  for (const k of Object.keys(cfgThresholds)) thresholds[k] = cfgThresholds[k]
  const disasters = {}
  for (const k of Object.keys(cfgDisasters)) disasters[k] = cfgDisasters[k]
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
export async function copyDiagSnapshot(now) {
  const text = safe(() => JSON.stringify(buildDiagSnapshot(now), null, 2), '{}', [], 'stringify')
  try {
    if (typeof navigator !== 'undefined' && navigator && navigator.clipboard &&
        typeof navigator.clipboard.writeText === 'function') {
      await navigator.clipboard.writeText(text)
      return { ok: true, text }
    }
  } catch (err) {
    return { ok: false, text, error: str((err && err.message) || err) }
  }
  return { ok: false, text }
}
