// ============================================================================
// dsh-quake-alert · client/src/16-diag.js
// 作用：**只读诊断快照**——把 Client 侧的实时状态压成一份 JSON：聚合状态、逐源状态与数据健康、
//       增量计数、大陆源的链路模式、关注点摘要、最近几条历史、投递面。
// 依赖：03-settings-bridge、05g-source-health、07-store、08-audio、09-notify、10-dedupe、
//       12b-feed-poll、12c-cn-stream、12e-overseas-poll。
// 三条纪律（对外契约）：① **只读**——不改状态、不发请求；② **永不抛错**——每个片段各自 try/catch，
//       异常进 `warnings` 一并返回；③ **只放可 JSON 化的叶子字段**——活对象必须逐字段取，不能直接 stringify。
// ============================================================================

import { currentCfg, settingsSync } from './03-settings-bridge.js'
import { sourceHealthOf } from './05g-source-health.js'
import { store } from './07-store.js'
import { authorityStatsOf } from './10-dedupe.js'
import { feedStatsOf } from './12b-feed-poll.js'
import { overseasStatsOf } from './12e-overseas-poll.js'
import { audioState } from './08-audio.js'
import { notificationPermission } from './09-notify.js'
import { cnStreamRegistry } from './12c-cn-stream.js'

/** 快照格式版本（与插件版本无关）。**加字段就提号**：读快照的一方据此知道"这份快照有哪些键"，
 *  缺键 = 来自更早的版本，而不是"这一项没配"。 */
export const DIAG_SNAPSHOT_VERSION = 4

const str = (v) => String(v === undefined || v === null ? '' : v)
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null)

/** 每个片段各自捕获异常，异常写进 warnings：一个会抛错的诊断工具在真出事时最没用。 */
function safe(fn, fallback, warnings, label) {
  try {
    return fn()
  } catch (err) {
    warnings.push(label + '：' + str((err && err.message) || err))
    return fallback
  }
}

/** 来源标注：让读快照的一方知道这条状态是哪条链路报的，不用去猜字段顺序。 */
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

/** 海外源（12e）：Client 直连的 REST 轮询，字段语义与 feed / streams 两张表不同。`rejected` 是被上游
 *  HTTP 400 拒绝的请求数，**不代表"这个点不在覆盖范围"**（也可能是参数被拒）；`ageSkipped` 是被年龄门槛
 *  拦下、本来会播报的条数（只进历史不响铃）；`gated` 是进入首轮 / 休眠恢复状态的次数。 */
function overseasRows() {
  const out = {}
  for (const id of Object.keys(overseasStatsOf)) {
    const o = overseasStatsOf[id] || {}
    out[id] = {
      polls: num(o.polls), requests: num(o.requests), received: num(o.received), applied: num(o.applied),
      errors: num(o.errors),
      // 被上游用 HTTP 400 拒绝的请求数（**不代表"这个点不在覆盖范围"**，响应体前 160 字在 lastError 里）
      rejected: num(o.rejected),
      ageSkipped: num(o.ageSkipped),
      // 上游条目数超过每次请求上限、被我们截断的轮数（ECCC 的 limit=200）
      truncated: num(o.truncated),
      // 两个 throttle 计数分开：Last 是本轮、Total 是累计
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
function streamRows(warnings) {
  const out = {}
  const warn = Array.isArray(warnings) ? warnings : []
  for (const id of Object.keys(cnStreamRegistry)) {
    const reg = cnStreamRegistry[id]
    const s = safe(() => reg.stats(), {}, warn, 'stream:' + id) || {}
    out[id] = {
      mode: safe(() => reg.mode(), 'unknown', warn, 'mode:' + id),
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

/** 关注点摘要。**坐标是有意保留的**：匹配失败通常就要靠"震中距最近关注点多少公里"来判。 */
function watchSummary(cfg) {
  const w = (cfg && cfg.watch) || {}
  const places = Array.isArray(w.places) ? w.places : []
  return {
    prefectures: Array.isArray(w.prefectures) ? w.prefectures.slice(0, 50) : [],
    citiesCount: Array.isArray(w.cities) ? w.cities.length : 0,
    cities: Array.isArray(w.cities) ? w.cities.slice(0, 30) : [],
    places: places.slice(0, 20).map((p) => ({
      name: str(p && p.name), lat: num(p && p.lat), lon: num(p && p.lon), radiusKm: num(p && p.radiusKm),
      // 来源分支（jp / cn / global）：决定"这个关注点归哪个源"；优先源判错时第一个要核的就是它。
      origin: str(p && p.origin) || 'global',
      // 大陆关注点的省 / 市：行政区层级匹配读它而不从名字反推。非大陆点不写这两个键，免得快照里多出空字段。
      ...(str(p && p.origin) === 'cn' ? { province: str(p && p.province), city: str(p && p.city) } : {}),
    })),
    placesCount: places.length,
  }
}

/** 跨源优先源：被优先源压掉的条数。被抑制的条目连历史都不进，这一段是它们的**唯一**痕迹；
 *  `bySource` 按**已播报的那个源**分组，能回答"是不是 USGS 总在抢在日本源前面"。 */
function authorityRow() {
  const a = authorityStatsOf()
  const bySource = {}
  const src = (a && a.bySource) || {}
  for (const k of Object.keys(src)) bySource[k] = num(src[k])
  return {
    suppressed: num(a && a.suppressed),
    bySource,
    lastAt: (a && a.lastAt) ? new Date(a.lastAt).toISOString() : null,
    lastDetail: str(a && a.lastDetail),
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

/** 生成诊断快照。@param {number} [now] 注入点（测试用）
 *  @returns {object} 可直接 JSON.stringify 的纯数据对象；被捕获的异常在 `warnings` 里 */
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
      // 界面语言：**规整后的生效值，不是持久层原值**（cfg 来自 currentCfg()，一定过 normalizeCfg），
      // 所以它只能回答"界面现在按哪个语言渲染"。
      language: str(cfg.language),
      watch: safe(() => watchSummary(cfg), {}, warnings, 'watch'),
    }), {}, warnings, 'config'),
    sources: safe(sourceRows, {}, warnings, 'sources'),
    // 数据健康：schema-error 的**原因**在这里（蓝点的解释）
    dataHealth: safe(() => sourceHealthOf() || {}, {}, warnings, 'health'),
    feed: safe(feedRows, {}, warnings, 'feed'),
    streams: safe(() => streamRows(warnings), {}, warnings, 'streams'),
    // 海外源：Client 直连的 REST 轮询，与 feed / streams 并列（字段语义不同，见 overseasRows）。
    overseas: safe(overseasRows, {}, warnings, 'overseas'),
    // 跨源优先源：被压掉的跨源副本条数——那些条目不进历史，这里是它们唯一的痕迹。
    authority: safe(authorityRow, {}, warnings, 'authority'),
    history: safe(historySummary, {}, warnings, 'history'),
    // 投递面：音频未解锁（用户从未点过页面）与系统通知权限被拒都**无法从 config 推导**——
    // config.notify.system 是"用户想不想要"，这里是"浏览器允不允许 / 解锁没解锁"。
    delivery: safe(() => ({
      audio: str(audioState()),
      notificationPermission: str(notificationPermission()),
    }), {}, warnings, 'delivery'),
    // 生成过程中被捕获的异常：诊断工具自身的失败也要可见，不能假装一切正常
    warnings,
  }
}

/** 复制诊断快照到剪贴板。剪贴板不可用（沙箱 iframe / 权限被拒）时**不抛错**，而是把文本交回调用方去显示成可手动复制的文本框。
 *  @returns {Promise<{ ok: boolean, text: string, warning?: string, error?: string }>} */
export async function copyDiagSnapshot(now) {
  const warnings = []
  const text = safe(() => JSON.stringify(buildDiagSnapshot(now), null, 2), '{}', warnings, 'stringify')
  try {
    if (typeof navigator !== 'undefined' && navigator && navigator.clipboard &&
        typeof navigator.clipboard.writeText === 'function') {
      await navigator.clipboard.writeText(text)
      // 快照生成时被捕获的异常要**跟着结果回给界面**：复制确实成功了，所以不能报 ok:false；
      // 但也绝不能只说"已复制"——用户以为手里是一份完整诊断，而里面其实少了几个片段。
      return warnings.length
        ? { ok: true, text, warning: warnings.join('；') }
        : { ok: true, text }
    }
  } catch (err) {
    return { ok: false, text, error: str((err && err.message) || err) }
  }
  return { ok: false, text }
}
