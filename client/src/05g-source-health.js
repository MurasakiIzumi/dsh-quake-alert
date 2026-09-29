// ============================================================================
// dsh-quake-alert · client/src/05g-source-health.js
//
// 作用：**机制层**——统一的源健康记录：data / fresh 两层的存储与合成、逐条计数的升级阈值、
//       蓝点的跨刷新持久化与 TTL 自愈。
// 依赖：01-constants（HEALTH_KEY）、02-storage（loadJSON / saveJSON / isPlainObject）、07-store。
// 分工：05d 是**约定层**（字段契约与失败分类），本文件是**机制层**（失败怎么存、何时升级成源级
// 异常、何时消失）。调用方仍调 `noteParseResult` 等函数，但 import 来自这里。
//
// 三件事是本文件存在的理由：① 单条失败不立即点亮蓝点——同一失败原因 10 分钟窗口内累计 ≥5 条、
// 或连续失败 ≥10 条才升级（线上是逐条 entry，实测整表 50 条里坏 1〜2 条是常态）；② 蓝点带 24 小时
// TTL，不復现就自动清除；③ data 层写入本地存储，页面刷新后蓝点仍在——"要等插件更新"与刷新页面无关。
//
// 明确不做：连接状态（conn）不持久化、也不在这里判定，由各传输层上报；新鲜度（fresh）只存"最后
// 数据时间"，判定交给自检，阈值只从契约来。
// ============================================================================

import { HEALTH_KEY } from './01-constants.js'
import { loadJSON, saveJSON, isPlainObject } from './02-storage.js'
import { SOURCE_CONTRACTS } from './05d-source-contracts.js'
import { store } from './07-store.js'

/** 同一失败原因在窗口内累计这么多条 → 升级成源级蓝点。取 5：整表 50 条里坏 1〜2 条是常态。 */
export const SCHEMA_ESCALATE_COUNT = 5
export const SCHEMA_ESCALATE_WINDOW_MS = 10 * 60 * 1000

/** 连续失败这么多条（**不看原因**）→ 同样升级。兜"坏法不重样"：结构改得面目全非时每条失败的原因
 *  字符串都不同，按原因计数到不了阈值。 */
export const SCHEMA_ESCALATE_CONSECUTIVE = 10

/** 蓝点的存活上限：超过它没有复现就自动清除。24 小时足够"用户第二天打开还在"，又不会永久挂着。 */
export const HEALTH_TTL_MS = 24 * 60 * 60 * 1000

// ---------------------------------------------------------------- 存储
/** 内存里的健康记录：id → { data, fresh, counters, consecutiveFail } */
const health = new Map()

function ensure(id) {
  let r = health.get(id)
  if (!r) {
    r = {
      data: null, // { errorKey, kind, subject, detail, at, firstAt, count, escalated }
      fresh: { dataTime: 0, stale: false, staleSince: 0 },
      counters: { ok: 0, schema: 0, value: 0, empty: 0 },
      consecutiveFail: 0,
    }
    health.set(id, r)
  }
  return r
}

/** 写入本地存储。只写 data 一层，没有异常的源不占空间。 */
function persist() {
  const out = {}
  for (const [id, r] of health) {
    if (!r.data) continue
    const d = r.data
    out[id] = {
      errorKey: d.errorKey, kind: d.kind, subject: d.subject, detail: d.detail,
      at: d.at, firstAt: d.firstAt, escalated: d.escalated === true,
    }
  }
  saveJSON(HEALTH_KEY, out)
}

/** 从 localStorage 恢复（模块加载时自动调一次）。过期的直接丢掉——TTL 在**读取**时也要判，
 *  否则关掉浏览器三天再打开会看到一个早已过期的蓝点。 @returns {number} 恢复了几条 */
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
      subject: typeof d.subject === 'string' ? d.subject : '',
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
/** 连接层基线：清掉数据健康之后，展示状态该回到哪一个连接状态。store 里存的是**合成结果**，所以先
 *  看它是不是由数据层投出来的（`schema-error` / `stale`）——是就按 `open` 计，否则沿用当前值。 */
function connBaseOf(sourceId) {
  const cur = (store.sources && store.sources[sourceId]) || {}
  const s = cur.status
  return (s === 'schema-error' || s === 'stale' || !s) ? 'open' : s
}

/** 清掉 data 层（成功解析 / empty / TTL 自愈都走这里）。只有**确实从异常恢复了**才上报——否则
 *  每条成功的数据都会触发一次设置页重渲。 */
function clearData(sourceId, detail, t) {
  const r = health.get(sourceId)
  if (!r || !r.data) return false
  const wasEscalated = r.data.escalated === true
  r.data = null
  r.consecutiveFail = 0
  persist()
  // 走 publishStatus 而不是直接 pushSource：清掉蓝点之后该显示什么得由合成规则决定——若这个源
  // 此刻正停更，展示状态应当是「数据已过期」而不是「已连接」。
  if (wasEscalated) publishStatus(sourceId, { status: connBaseOf(sourceId), detail })
  return true
}

/**
 * 这次"恢复"能不能清掉记下的失败：只有**同一种数据**（subject 相同）才算恢复。
 * 失败记录没写种类（旧版本留下的记录，或认不出种类）时按原样清掉——不把蓝点无谓地挂满 24 小时。
 */
function recovered(r, subject) {
  if (!r || !r.data) return false
  if (!r.data.subject) return true
  return r.data.subject === String(subject || '')
}

/**
 * 记录一次解析结果。返回 true = "这条数据不可用，调用方不应继续处理它"——与"是否点亮蓝点"**解耦**：
 * 单条坏数据不该让整个源变蓝。
 *
 * `opts.subject` 是**数据种类**（P2P 的电文 code：551 / 552 / 556；nmc 的灾种：rainstorm /
 * geology）：同一个源里不同种类的结构各自独立，种类 A 正常不能证明种类 B 没改版。它进 `errorKey`
 * （不同种类不共享计数）并决定一次成功能不能清掉蓝点（见 recovered）——否则 551 照常到达就会一直清掉
 * 556 的结构告警，而 EEW 那条链路已经悄悄不响了。**JMA 不传**：它的 schema 失败只发生在整份载荷级，
 * 那时取不到电文种类（登记在 DESIGN 11.9）。
 *
 * empty 仍算"结构是好的"，**默认**清掉蓝点（JMA 的常态就是 empty）。两种例外：① 逐条上报
 * （`opts.perItem`）时 empty 只计数、不清 data 层——empty 只说明"**这一条**无关"，不能证明同批次
 * 此前那条 schema 失败已恢复；批量取数（12e 一轮查 N 个关注点）里立即 clearData 会连**其它条目**
 * 的失败计数一起清掉；② 种类对不上时不清。
 */
export function noteParseResult(sourceId, res, now, opts) {
  if (!res || res.ok) return false
  const t = now === undefined ? Date.now() : now
  const r = ensure(sourceId)
  const kind = res.kind === 'value' ? 'value' : (res.kind === 'empty' ? 'empty' : 'schema')
  const subject = String((opts && opts.subject) || '')
  if (kind === 'empty') {
    r.counters.empty += 1
    if (!(opts && opts.perItem) && recovered(r, subject)) clearData(sourceId, 'schema recovered')
    return false
  }
  r.counters[kind] += 1
  r.consecutiveFail += 1
  // 种类进 errorKey：两种电文各自坏法不同时，它们的计数不该互相覆盖、也不该互相续上。
  const key = kind + '|' + subject + '|' + String(res.detail || '')
  const prev = r.data
  const sameReason = !!prev && prev.errorKey === key && (t - prev.firstAt) <= SCHEMA_ESCALATE_WINDOW_MS
  const count = sameReason ? prev.count + 1 : 1
  const firstAt = sameReason ? prev.firstAt : t
  // 一旦升级就保持（同一条异常挂着的期间不该忽蓝忽绿）；它只由成功 / empty / TTL 清除。
  const escalated = (prev && prev.escalated === true) ||
    count >= SCHEMA_ESCALATE_COUNT ||
    r.consecutiveFail >= SCHEMA_ESCALATE_CONSECUTIVE
  const wasEscalated = !!(prev && prev.escalated === true)
  r.data = { errorKey: key, kind, subject, detail: String(res.detail || ''), at: t, firstAt, count, escalated: !!escalated }
  if (escalated && !wasEscalated) {
    try {
      console.warn('[dsh-quake-alert] ' + sourceId + ' repeated parse failures (' + kind + ', ' + count + '): ' + res.detail)
    } catch (e) { /* 忽略 */ }
    persist()
    publishStatus(sourceId, { status: connBaseOf(sourceId), detail: kind + ': ' + res.detail })
  }
  return true
}

/**
 * 解析成功。累加成功计数，并清掉蓝点（若此前有）。
 *
 * 两种"不清"的例外，都由 opts 表达：① `perItem`（逐条上报）——同轮其它条目可能正失败着，一条成功
 * 不能证明结构已恢复，清蓝点收敛到轮末的轮级判定（12e 一轮 = 一批请求）；② `subject` 与记下的失败
 * 种类不同——种类 A 的正常数据不能证明种类 B 没改版（见 recovered）。
 */
export function noteSourceSuccess(sourceId, now, opts) {
  const t = now === undefined ? Date.now() : now
  const r = ensure(sourceId)
  r.counters.ok += 1
  if (opts && opts.perItem) return false
  if (!recovered(r, opts && opts.subject)) return false
  return clearData(sourceId, 'schema recovered')
}

/** TTL 自愈：由自检定期调用（模块自己不排定时器，定时器归 fiber）。 @returns {number} 自愈了几个源 */
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
      publishStatus(id, { status: connBaseOf(id), detail: 'schema error not seen for 24h · auto-recovered' })
    }
  }
  if (healed) persist()
  return healed
}

// ---------------------------------------------------------------- 新鲜度层
/** 上报"我最后一次拿到数据的时刻"（epoch 毫秒）。**判定不在这里**——阈值只从契约来，由自检统一算。 */
export function noteFreshness(sourceId, dataTime) {
  const r = ensure(sourceId)
  if (typeof dataTime === 'number' && Number.isFinite(dataTime) && dataTime > 0) r.fresh.dataTime = dataTime
  return Object.assign({}, r.fresh)
}

/** 自检写入判定结果。`staleSince` 只在"从未停更变成停更"的那一刻记一次。 */
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

/** 单个源的记录；传 undefined 取全部（诊断快照用）。 */
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
 */
export function effectiveStatusOf(sourceId, connStatus, detail) {
  // 用户**主动关掉**的源优先于一切健康判定：否则蓝点与 stale 会覆盖 disabled，把"我把这个灾种关了"
  // 改写成"数据格式异常 / 上游停更"。
  if (connStatus === 'disabled') return { status: 'disabled', detail }
  const r = health.get(sourceId)
  if (r && r.data && r.data.escalated) return { status: 'schema-error', detail: r.data.kind + ': ' + r.data.detail }
  if (r && r.fresh && r.fresh.stale) return { status: 'stale', detail: detail || 'upstream data stale' }
  return { status: connStatus, detail }
}

/**
 * **统一的状态发布入口**——任何要写 `store.sources` 的层都从这里走。
 *
 * `store.pushSource` 是**整体替换** status + detail 的，而展示状态是**合成**出来的（见
 * `effectiveStatusOf`）。其它层直接写 store 会把合成结论抹掉：自检把"停更"翻回"恢复"时写 `open` 会永久
 * 刷绿一条 schema-error 蓝点，P2PQuake 常态断线写 `reconnecting` 同样冲掉蓝点。
 *
 * @param {string} sourceId
 * @param {object} patch 至少给 status 与 detail 之一；其余字段（label / retries…）原样透传
 * @returns {{status: string, detail: string}} 本次合成出的展示状态（调用方可用它做去重键）
 */
export function publishStatus(sourceId, patch) {
  const p = Object.assign({}, patch)
  // 07-store.pushSource 的兜底是**裸 id**，不补 label 的话侧边栏详情会显示成「usgs：上游数据已过期…」。
  // store 里已有 label 就沿用，否则退到契约里的 label，最后才是 id。
  if (p.label === undefined) {
    const cur = (store.sources && store.sources[sourceId]) || {}
    const declared = SOURCE_CONTRACTS[sourceId]
    p.label = cur.label || (declared && declared.label) || sourceId
  }
  const eff = effectiveStatusOf(sourceId, p.status, p.detail)
  p.status = eff.status
  p.detail = eff.detail
  store.pushSource(sourceId, p)
  return eff
}

/** 把已经升级的数据健康记录重新发布到 store——插件装载时调用。刷新页面后 store 是空的而蓝点存在
 *  localStorage 里，不重发就要等该源下一次上报才显示，而"蓝点跨刷新存活"应当是**立刻**成立。 */
export function republishDataHealth() {
  for (const [id, r] of health) {
    if (!r.data || !r.data.escalated) continue
    publishStatus(id, { status: 'open' })
  }
}

/** 手动重试：清掉异常标记，等下一批数据自证。 */
export function retrySource(sourceId, now) {
  const t = now === undefined ? Date.now() : now
  const r = ensure(sourceId)
  r.data = null
  r.consecutiveFail = 0
  persist()
  publishStatus(sourceId, { status: connBaseOf(sourceId), detail: 'manual retry · awaiting next batch' })
  return true
}

/**
 * 插件（重新）装载时重置**连接与新鲜度**两层。刻意**不清 data 层**：它已从 localStorage 恢复，
 * 而"上游改了字段、等插件更新"与用户刷新页面 / 重新启用插件无关。
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

// 模块加载时恢复一次：页面刷新后蓝点仍在。
loadHealth()
