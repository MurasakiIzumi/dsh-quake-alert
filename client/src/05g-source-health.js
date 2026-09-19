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

import { HEALTH_KEY } from './01-constants.js'
import { loadJSON, saveJSON, isPlainObject } from './02-storage.js'
import { store } from './07-store.js'

/**
 * 同一失败原因在窗口内累计这么多条 → 升级成源级蓝点。
 *
 * 取 5 的依据：速报整表 50 条里坏 1〜2 条是常态（个别条目字段缺失），5 条以上同因更像是
 * "上游改了一个字段名"这类真问题；而窗口取 10 分钟，与 `dedupe.windowMinutes` 同一量级，
 * 让"同一轮里的连续坏条目"能被累计起来。
 */
export const SCHEMA_ESCALATE_COUNT = 5
export const SCHEMA_ESCALATE_WINDOW_MS = 10 * 60 * 1000

/**
 * 连续失败这么多条（**不看原因**）→ 同样升级。
 *
 * 这条兜的是"坏法不重样"：上游把结构改得面目全非时，每条失败的原因字符串可能都不同
 * （不同字段先被检查到），按原因计数永远到不了阈值。10 条这个量级对任何源都只有
 * "结构性失败"才可能达到（正常波动不会连续 10 条全坏）。
 */
export const SCHEMA_ESCALATE_CONSECUTIVE = 10

/**
 * 蓝点的存活上限：超过它没有复现就自动清除（并记一次自愈）。
 *
 * 24 小时：足够长到"用户第二天打开还在"（那时插件更新可能已经发布），又足够短到不会让
 * 一条判错的蓝点永久挂在界面上。稀疏源（`cenc_eew` 数天一条）正是靠它恢复。
 */
export const HEALTH_TTL_MS = 24 * 60 * 60 * 1000

// ---------------------------------------------------------------- 存储
/** 内存里的健康记录：id → { data, fresh, counters, consecutiveFail } */
const health = new Map()

function ensure(id) {
  let r = health.get(id)
  if (!r) {
    r = {
      data: null, // { errorKey, kind, detail, at, firstAt, count, escalated }
      fresh: { dataTime: 0, stale: false, staleSince: 0 },
      counters: { ok: 0, schema: 0, value: 0, empty: 0 },
      consecutiveFail: 0,
    }
    health.set(id, r)
  }
  return r
}

/** 落盘。只写 data 一层（理由见文件头），没有异常的源不占空间。 */
function persist() {
  const out = {}
  for (const [id, r] of health) {
    if (!r.data) continue
    const d = r.data
    out[id] = {
      errorKey: d.errorKey, kind: d.kind, detail: d.detail,
      at: d.at, firstAt: d.firstAt, escalated: d.escalated === true,
    }
  }
  saveJSON(HEALTH_KEY, out)
}

/**
 * 从 localStorage 恢复（模块加载时自动调一次）。过期的直接丢掉——TTL 在**读取**时也要判，
 * 否则关掉浏览器三天再打开会看到一个早已过期的蓝点。
 * @returns {number} 恢复了几条
 */
export function loadHealth(now) {
  const t = now === undefined ? Date.now() : now
  const raw = loadJSON(HEALTH_KEY, null)
  if (!isPlainObject(raw)) return 0
  let n = 0
  for (const id of Object.keys(raw)) {
    const d = raw[id]
    if (!isPlainObject(d)) continue
    if (typeof d.errorKey !== 'string' || !d.errorKey) continue
    if (!Number.isFinite(d.at) || t - d.at > HEALTH_TTL_MS) continue
    const r = ensure(id)
    r.data = {
      errorKey: d.errorKey,
      kind: typeof d.kind === 'string' ? d.kind : 'schema',
      detail: typeof d.detail === 'string' ? d.detail : '',
      at: d.at,
      firstAt: Number.isFinite(d.firstAt) ? d.firstAt : d.at,
      count: 1, // 计数不跨刷新累计：它是"这一轮里坏了多少条"，跨会话没有意义
      escalated: d.escalated === true,
    }
    n += 1
  }
  return n
}

// ---------------------------------------------------------------- 数据层（解析失败）
/**
 * 清掉 data 层（成功解析 / empty / TTL 自愈都走这里）。
 * 只有**确实从异常恢复了**才上报——否则每条成功的数据都会触发一次设置页重渲。
 */
function clearData(sourceId, detail, t) {
  const r = health.get(sourceId)
  if (!r || !r.data) return false
  const wasEscalated = r.data.escalated === true
  r.data = null
  r.consecutiveFail = 0
  persist()
  if (wasEscalated) store.pushSource(sourceId, { status: 'open', detail })
  return true
}

/**
 * 记录一次解析结果。返回 true 表示"这条数据不可用，调用方不应继续处理它"
 * —— 注意这与"是否点亮蓝点"**已经解耦**（0.5.3）：单条坏数据不该让整个源变蓝。
 *
 * empty 仍然算"结构是好的"（源正常地给出了这一条，只是与本插件无关），所以它会清掉蓝点
 * ——这条语义沿用 0.4.2，JMA 的常态就是 empty。
 */
export function noteParseResult(sourceId, res, now) {
  if (!res || res.ok) return false
  const t = now === undefined ? Date.now() : now
  const r = ensure(sourceId)
  const kind = res.kind === 'value' ? 'value' : (res.kind === 'empty' ? 'empty' : 'schema')
  if (kind === 'empty') {
    r.counters.empty += 1
    clearData(sourceId, '数据格式已恢复正常', t)
    return false
  }
  r.counters[kind] += 1
  r.consecutiveFail += 1
  const key = kind + '|' + String(res.detail || '')
  const prev = r.data
  const sameReason = !!prev && prev.errorKey === key && (t - prev.firstAt) <= SCHEMA_ESCALATE_WINDOW_MS
  const count = sameReason ? prev.count + 1 : 1
  const firstAt = sameReason ? prev.firstAt : t
  // 一旦升级就保持（同一条异常挂着的期间不该忽蓝忽绿）；它只由成功 / empty / TTL 清除。
  const escalated = (prev && prev.escalated === true) ||
    count >= SCHEMA_ESCALATE_COUNT ||
    r.consecutiveFail >= SCHEMA_ESCALATE_CONSECUTIVE
  const wasEscalated = !!(prev && prev.escalated === true)
  r.data = { errorKey: key, kind, detail: String(res.detail || ''), at: t, firstAt, count, escalated: !!escalated }
  if (escalated && !wasEscalated) {
    try {
      console.warn('[dsh-quake-alert] ' + sourceId + ' 连续解析失败（' + kind + '，' + count + ' 条）：' + res.detail)
    } catch (e) { /* 忽略 */ }
    persist()
    store.pushSource(sourceId, { status: 'schema-error', detail: kind + '：' + res.detail })
  }
  return true
}

/** 解析成功。清掉蓝点（若此前有），并累加成功计数。 */
export function noteSourceSuccess(sourceId, now) {
  const t = now === undefined ? Date.now() : now
  const r = ensure(sourceId)
  r.counters.ok += 1
  return clearData(sourceId, '数据格式已恢复正常', t)
}

/**
 * TTL 自愈：由探针定期调用（模块自己不排定时器——定时器归 fiber，见 12d）。
 * @returns {number} 这一轮自愈了几个源
 */
export function pruneHealth(now) {
  const t = now === undefined ? Date.now() : now
  let healed = 0
  for (const [id, r] of health) {
    if (!r.data) continue
    if (t - r.data.at <= HEALTH_TTL_MS) continue
    const wasEscalated = r.data.escalated === true
    r.data = null
    r.consecutiveFail = 0
    healed += 1
    if (wasEscalated) {
      store.pushSource(id, { status: 'open', detail: '数据格式异常已超过 24 小时没有复现，自动恢复' })
    }
  }
  if (healed) persist()
  return healed
}

// ---------------------------------------------------------------- 新鲜度层
/**
 * 上报"我最后一次拿到数据的时刻"（epoch 毫秒）。**判定不在这里**——阈值只从契约来，
 * 由探针（12d）统一算。各源只管上报事实。
 */
export function noteFreshness(sourceId, dataTime) {
  const r = ensure(sourceId)
  if (typeof dataTime === 'number' && Number.isFinite(dataTime) && dataTime > 0) r.fresh.dataTime = dataTime
  return Object.assign({}, r.fresh)
}

/** 探针写入判定结果。`staleSince` 只在"从未停更变成停更"的那一刻记一次。 */
export function noteStale(sourceId, stale, now) {
  const t = now === undefined ? Date.now() : now
  const r = ensure(sourceId)
  const next = stale === true
  if (next && !r.fresh.stale) r.fresh.staleSince = t
  if (!next) r.fresh.staleSince = 0
  r.fresh.stale = next
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
export function sourceHealthOf(sourceId) {
  if (sourceId !== undefined) {
    const r = health.get(sourceId)
    return r ? snapshot(r) : null
  }
  const all = {}
  for (const [k, v] of health) all[k] = snapshot(v)
  return all
}

/**
 * 把"数据健康"叠加到连接状态上。优先级：数据格式异常（用户处理不了）> 停更（中灰）> 连接状态。
 *
 * 0.5.3 起**多了一层 stale**：此前 stale 由各源自己 pushSource 上报（12b 直通 Host 的
 * `stats.stale`、12c 直通 SSE 的 status 帧），于是"谁在判"和"阈值在哪"都散着。现在统一由
 * 探针按契约判定并写进这里，各源只上报 dataTime。
 */
export function effectiveStatusOf(sourceId, connStatus, detail) {
  const r = health.get(sourceId)
  if (r && r.data && r.data.escalated) return { status: 'schema-error', detail: r.data.kind + '：' + r.data.detail }
  if (r && r.fresh && r.fresh.stale) return { status: 'stale', detail: detail || '上游数据已过期' }
  return { status: connStatus, detail }
}

/** 手动重试（DESIGN 5.4）：清掉异常标记，等下一批数据自证。 */
export function retrySource(sourceId, now) {
  const t = now === undefined ? Date.now() : now
  const r = ensure(sourceId)
  r.data = null
  r.consecutiveFail = 0
  persist()
  store.pushSource(sourceId, { status: 'open', detail: '已手动重试，等待下一批数据' })
  return true
}

/**
 * 插件（重新）装载时重置**连接与新鲜度**两层。
 *
 * 刻意**不清 data 层**：它已经从 localStorage 恢复，而"上游改了字段、等插件更新"这件事与
 * 用户刷新页面 / 重新启用插件无关。0.5.2 之前这里清掉全部，理由是"避免上一代残留"——那是
 * data 还不持久化时的判断，现在持久化本身就是设计（DESIGN 11.9 A）。
 */
export function resetConnHealth() {
  for (const [, r] of health) {
    r.fresh = { dataTime: 0, stale: false, staleSince: 0 }
    r.consecutiveFail = 0
  }
}

/** 测试钩子：清空全部（含持久化）——模块级 Map 会跨用例存活。 */
export function resetSourceHealth() {
  health.clear()
  saveJSON(HEALTH_KEY, {})
}

// 模块加载时恢复一次：页面刷新后蓝点仍在（loadClient 在测试里新建沙箱时会重新执行到这里，
// 所以"跨刷新存活"这条能力可以被直接断言）。
loadHealth()
