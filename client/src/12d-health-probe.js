// ============================================================================
// dsh-quake-alert · client/src/12d-health-probe.js
//
// 作用：机制层的自检调度——定时器按 `SOURCE_CONTRACTS[*].staleAfterMs` 判定各源新鲜度，并驱动
//       蓝点 TTL 自愈（`pruneHealth`）。契约是唯一阈值来源，源只上报最后取数时刻、自己不判 stale；
//       自检不发外部请求，只读已有的数据时间。
// 依赖：05d（契约声明）、05g（健康记录）、07-store（状态上报）。
// ============================================================================

import { SOURCE_CONTRACTS } from './05d-source-contracts.js'
import { sourceHealthOf, noteStale, pruneHealth, publishStatus } from './05g-source-health.js'
import { createGapDetector, onResume, RESUME_GAP_MS } from './12f-resume.js'

/** 自检周期。最短阈值是 USGS 的 30 分钟，30 秒分辨率够用，每轮只遍历 8 条记录、不发请求。 */
export const PROBE_INTERVAL_MS = 30 * 1000

/**
 * 取某个源的新鲜度阈值（毫秒）；`null` / 非正数表示这条链路不判新鲜度。`staleAfterMs: null` 的是推送源
 * （P2PQuake / EMSC / cenc_eew，活性由连接层负责）。Host 与 Client 分开构建，`lib/` 不能 import 本契约，
 * 故 Host 侧仍保留自己的 `feedStaleMs` 常量，两边一致性由回归断言守护。
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
  if (m < 60) return m + 'm'
  return (Math.round(m / 6) / 10) + 'h'
}

/**
 * 建一个自检器。定时器与 pushSource 都可注入（测试用假时钟直接调 `tick()`，不等真实定时器）。
 * @param {object} [opts] 另有 now / intervalMs / setTimer / clearTimer 可注入。
 * @param {(id: string, patch: object) => void} [opts.pushSource] 注入点（测试用）：注入时按原样
 *   推送以便断言原始 patch；生产路径必须经 `publishStatus` 合成新鲜度 / 连接层 / 数据健康层。
 * @param {(id: string) => boolean} [opts.sourceEnabled] 该源当前是否被用户开着。关掉的源不判
 *   stale：Client 不再拉它，dataTime 停在关掉前的值。默认全部视为开启。
 */
export function createHealthProbe(opts = {}) {
  const now = opts.now || (() => Date.now())
  const intervalMs = opts.intervalMs === undefined ? PROBE_INTERVAL_MS : opts.intervalMs
  const setTimer = opts.setTimer || ((fn, ms) => setInterval(fn, ms))
  const clearTimer = opts.clearTimer || ((t) => clearInterval(t))
  const sourceEnabled = opts.sourceEnabled || (() => true)
  // 默认经 publishStatus 合成展示状态（新鲜度 + 连接层 + 数据健康层）；直接 pushSource 会让
  // "数据已恢复更新"刷掉 schema-error 蓝点。
  const push = opts.pushSource || ((id, patch) => publishStatus(id, patch))
  let timer = null
  let offResume = null
  // 这一层也是「冻结恢复」的检出来源之一（周期 30 秒，所以阈值取周期的 3 倍：阈值必须明显大于自己的
  // 周期，否则每轮都会被算成一次跳变）。判出跳变时它会广播恢复，各链路据此重建 / 补取数。
  const gap = createGapDetector({ now, gapMs: Math.max(RESUME_GAP_MS, intervalMs * 3) })

  /**
   * 跑一轮：先做 TTL 自愈，再逐源判新鲜度。`dataTime` 从未上报（0）时不判——"不知道数据什么时候
   * 来的"不等于"数据是旧的"。返回本轮时刻。
   */
  function tick() {
    const t = now()
    // 先判冻结：恢复后的第一轮里各源的最后数据时间都还是冻结前的，照常判必然全判"停更"。判出跳变时
    // 这里只负责广播（各链路自己决定重建还是补取数），本轮照常判——数据确实旧了，如实说出去比瞒着好，
    // 而补取数的那一轮会让它很快翻回来。
    gap.tick()
    pruneHealth(t)
    for (const id of Object.keys(SOURCE_CONTRACTS)) {
      const after = staleAfterOf(id)
      if (after <= 0) continue
      // 源被用户关掉时不判新鲜度（Client 不再拉它，dataTime 停在关掉前的值）；先清掉可能残留的
      // stale，否则关闭那一刻的 stale 会一直挂到重开。
      if (!sourceEnabled(id)) {
        const recOff = sourceHealthOf(id)
        if (recOff && recOff.fresh && recOff.fresh.stale) {
          noteStale(id, false, t)
          push(id, { status: 'disabled', detail: 'disabled · hazard switch off' })
        }
        continue
      }
      const rec = sourceHealthOf(id)
      const dataTime = rec && rec.fresh && Number.isFinite(rec.fresh.dataTime) ? rec.fresh.dataTime : 0
      if (!(dataTime > 0)) continue
      const stale = (t - dataTime) > after
      const was = !!(rec && rec.fresh && rec.fresh.stale)
      noteStale(id, stale, t)
      if (stale !== was) {
        // 只在翻转的那一刻上报：状态没变时每次 push 都会让设置页与状态点重渲一遍。恢复时给的
        // 是 `open`，源自己的连接状态由源的下一次上报纠正。
        push(id, stale
          ? { status: 'stale', detail: 'stale · no new data for ' + humanMinutes(after) }
          : { status: 'open', detail: 'data fresh again' })
      }
    }
    return t
  }

  return {
    intervalMs,
    tick,
    start() {
      if (timer) return
      // 恢复时立刻补跑一轮：TTL 自愈与停更判定都该按"现在"算，不必再等一个整周期。
      if (!offResume) offResume = onResume(() => { if (timer) tick() })
      timer = setTimer(tick, intervalMs)
      if (timer && typeof timer.unref === 'function') timer.unref()
    },
    stop() {
      if (offResume) { offResume(); offResume = null }
      if (timer) { clearTimer(timer); timer = null }
    },
  }
}
