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

import { SOURCE_CONTRACTS } from './05d-source-contracts.js'
import { sourceHealthOf, noteStale, pruneHealth, publishStatus } from './05g-source-health.js'

/**
 * 探针周期。30 秒的依据：最短的阈值是 USGS 的 30 分钟，30 秒的分辨率足以让"刚过期"和
 * "过期半小时"在 UI 上的差别不值得更细；而它足够轻（只遍历 8 条记录、不发请求）。
 */
export const PROBE_INTERVAL_MS = 30 * 1000

/**
 * 取某个源的新鲜度阈值（毫秒）；`null` / 非正数表示"这条链路不判新鲜度"。
 *
 * 抽成导出函数是为了让"声明生效"这件事可以被直接断言：测试里把契约的字段改成 1 分钟，
 * 探针的行为必须跟着变——那就证明阈值真的来自契约，而不是某个硬编码。
 * @param {string} sourceId
 */
export function staleAfterOf(sourceId) {
  const c = SOURCE_CONTRACTS[sourceId]
  if (!c) return 0
  const v = c.staleAfterMs
  return (typeof v === 'number' && Number.isFinite(v) && v > 0) ? v : 0
}

/** 毫秒 → 中文可读（诊断与状态行用）。 */
function humanMinutes(ms) {
  const m = Math.round(ms / 60000)
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
export function createHealthProbe(opts = {}) {
  const now = opts.now || (() => Date.now())
  const intervalMs = opts.intervalMs === undefined ? PROBE_INTERVAL_MS : opts.intervalMs
  const setTimer = opts.setTimer || ((fn, ms) => setInterval(fn, ms))
  const clearTimer = opts.clearTimer || ((t) => clearInterval(t))
  // 默认经 publishStatus（0.5.4）：探针报的是**新鲜度**这一层，而展示状态要把它与连接层、
  // 数据健康层合成。此前直接 pushSource，于是"数据已恢复更新"这一句会把一条 schema-error
  // 蓝点整个刷掉，而 health 里 escalated 仍为 true —— 用户再也看不到"上游改版"的信号。
  const push = opts.pushSource || ((id, patch) => publishStatus(id, patch))
  let timer = null

  /**
   * 跑一轮：先做 TTL 自愈，再逐源判新鲜度。
   *
   * `dataTime` 从未上报（值为 0）时**不判**——"不知道数据什么时候来的"不等于"数据是旧的"，
   * 把它当成 stale 会在每个源刚启动的头几秒里闪一片中灰。
   */
  function tick() {
    const t = now()
    pruneHealth(t)
    for (const id of Object.keys(SOURCE_CONTRACTS)) {
      const after = staleAfterOf(id)
      if (after <= 0) continue
      const rec = sourceHealthOf(id)
      const dataTime = rec && rec.fresh && Number.isFinite(rec.fresh.dataTime) ? rec.fresh.dataTime : 0
      if (!(dataTime > 0)) continue
      const stale = (t - dataTime) > after
      const was = !!(rec && rec.fresh && rec.fresh.stale)
      noteStale(id, stale, t)
      if (stale !== was) {
        // 只在**翻转**的那一刻上报：状态没变时每次 push 都会让设置页与状态点重渲一遍。
        // 恢复时给的是 `open`，而源自己的连接状态可能是 reconnecting —— 那由源的下一次
        // 上报（feed 源 15 秒一轮）纠正。用 05g 记录的连接状态去猜反而会引入两份真相。
        push(id, stale
          ? { status: 'stale', detail: '上游数据已过期（超过 ' + humanMinutes(after) + ' 没有新数据）' }
          : { status: 'open', detail: '数据已恢复更新' })
      }
    }
    return t
  }

  return {
    intervalMs,
    tick,
    start() {
      if (timer) return
      timer = setTimer(tick, intervalMs)
      if (timer && typeof timer.unref === 'function') timer.unref()
    },
    stop() {
      if (timer) { clearTimer(timer); timer = null }
    },
  }
}
