// ============================================================================
// dsh-quake-alert · client/src/12f-resume.js
//
// 作用：**机制层**——识别「页面 / 进程被冻结过」并广播「已恢复」。三种触发源合起来才算完备：
//       ① document 的 visibilitychange；② window 的 focus / pageshow；③ **墙钟跳变**（gap 检测）。
//       只有 ①② 不够：系统休眠 / 锁屏时页面往往仍是 `visible`，一个事件都不来；只靠 ③ 又会漏掉
//       "浏览器把后台标签页冻住"这类不跨休眠、但同样让定时器停跳的冻结。
//
// 为什么必须有这一层：各链路判「还活着吗」用的都是**上次活动时刻与现在的差**（SSE 静默判死 45 秒、
// P2PQuake 假死检测 20 分钟、新鲜度自检按契约阈值）。这些判据都默认"定时器一直在跑"——冻结期间
// 定时器停跳，恢复后一算就是"很久没有活动"，于是一条健康的连接被判死、一条死掉的连接被当成活的。
// 恢复事件就是把这一刻告诉它们：**这是冻结，不是故障**。
// 依赖：无。刻意不 import 任何模块（否则容易成为循环依赖的源头）；doc / now 都可注入以便测试。
// ============================================================================

/**
 * 判定「被冻结过」的墙钟间隔。取 3 分钟的依据是**浏览器自己的行为**：隐藏 / 后台标签页的定时器会被
 * 节流（Chrome 最长约 1 分钟一次），拿"跳过了一轮"当冻结会把这个正常现象误判成恢复，于是每次切到
 * 后台都被当成死过一次。所以要"明显大于节流间隔"，而不是"大于自己的周期"。
 * 调用方可按自己的定时器周期覆盖，但阈值必须**大于浏览器的节流间隔**。
 */
export const RESUME_GAP_MS = 3 * 60 * 1000

/** 同一次恢复往往同时来好几个事件（visibilitychange → focus → pageshow），这个窗口内只广播一次。 */
export const RESUME_DEDUPE_MS = 1000

/**
 * 「恢复后立刻补一次取数」的门槛：距上次取数超过它才值得插一轮。切一次标签页（几秒～几十秒）没必要
 * 打上游，而休眠 / 锁屏一定远大于它——那正是该尽快把界面从「数据已过期」拉回来的时候。
 */
export const RESUME_POLL_GAP_MS = 60 * 1000

/** 最近一次判定为「恢复」的时刻与来源（0 / '' = 本次会话还没恢复过）。 */
let lastResumeAt = 0
let lastResumeCause = ''
const listeners = new Set()
let eventsBound = false

/**
 * 广播一次恢复。同一毫秒级的连发会被去重——订阅者的典型动作是重建连接，不该因为浏览器连发两个
 * 事件就建两次。
 * @param {number} [at] 恢复时刻（默认 `Date.now()`）
 * @param {'gap'|'event'} [cause] 来源：`gap` = 定时器确实停跳过（墙钟跳变），`event` = 只是浏览器事件。
 *   订阅者要区分两者——**事件本身很频繁**（切一次标签页就来一次），而"被冻结过"才是要换连接的理由。
 * @returns {boolean} 是否真的广播了（被去重则为 false）
 */
export function emitResume(at, cause) {
  const t = (typeof at === 'number' && Number.isFinite(at)) ? at : Date.now()
  if (lastResumeAt && (t - lastResumeAt) < RESUME_DEDUPE_MS) return false
  lastResumeAt = t
  lastResumeCause = cause === 'gap' ? 'gap' : 'event'
  // 复制一份再遍历：订阅者在回调里退订是正常写法，边遍历边改会让它后面的订阅者被跳过。
  for (const fn of Array.from(listeners)) {
    try { fn(t, lastResumeCause) } catch (err) { /* 一个订阅者抛错不该带走其它订阅者的恢复机会 */ }
  }
  return true
}

/** 订阅恢复事件；回调收到 `(时刻, 来源)`。返回取消订阅函数。 */
export function onResume(fn) {
  if (typeof fn !== 'function') return () => {}
  listeners.add(fn)
  return () => { listeners.delete(fn) }
}

/** 最近一次恢复的时刻（0 = 还没恢复过）。 */
export function lastResumeAtOf() { return lastResumeAt }

/** 最近一次恢复的来源：`'gap'`（定时器停跳过）或 `'event'`（浏览器事件）；空串 = 还没恢复过。 */
export function lastResumeCauseOf() { return lastResumeCause }

/** 现在是否处在「刚恢复」的宽限期内。给"恢复后第一轮该特殊对待"的调用方用。 */
export function resumedWithin(ms, nowMs) {
  if (!(ms > 0) || !lastResumeAt) return false
  const t = (typeof nowMs === 'number' && Number.isFinite(nowMs)) ? nowMs : Date.now()
  return (t - lastResumeAt) <= ms
}

/**
 * 建一个「墙钟跳变」检测器：每个定时器周期调一次 `tick()`，返回 true = **本轮是冻结后的第一轮**。
 * 每个调用方各持一个（各自的周期不同，共用一份"上次时刻"会让周期长的那个把周期短的误判成恢复）。
 * @param {object} [opts] `gapMs`（覆盖阈值）、`now`（假时钟注入）。
 */
export function createGapDetector(opts) {
  const o = opts || {}
  const now = o.now || (() => Date.now())
  const gapMs = (typeof o.gapMs === 'number' && o.gapMs > 0) ? o.gapMs : RESUME_GAP_MS
  let last = 0
  return {
    gapMs,
    tick() {
      const t = now()
      const gap = last ? (t - last) : 0 // 第一次 tick 没有可比的前值
      last = t
      if (gap > gapMs) { emitResume(t, 'gap'); return true }
      return false
    },
    /** 显式对齐基准（例如刚重建连接、不希望下一轮被算成跳变）。 */
    mark() { last = now() },
  }
}

/**
 * 绑定浏览器侧的恢复事件源（幂等）。`document` / `window` 可注入（测试用）。
 * @returns {boolean} 本次是否真的绑定了
 */
export function bindResumeEvents(opts) {
  const o = opts || {}
  if (eventsBound) return false
  const doc = o.document || (typeof document !== 'undefined' ? document : null)
  const win = o.window || (typeof window !== 'undefined' ? window : null)
  if (!doc && !win) return false
  const onVisible = () => {
    // 只在"回到前台"时广播：hidden 那一下不广播，否则各源会在页面正要被冻结时重建连接，
    // 白建一条马上就没人读的链路。
    if (doc && doc.visibilityState === 'hidden') return
    emitResume(undefined, 'event')
  }
  const onShow = () => emitResume(undefined, 'event')
  if (doc && typeof doc.addEventListener === 'function') {
    doc.addEventListener('visibilitychange', onVisible)
    doc.addEventListener('pageshow', onShow) // 从 bfcache 回来：不触发 visibilitychange
  }
  if (win && typeof win.addEventListener === 'function') win.addEventListener('focus', onShow)
  eventsBound = true
  return true
}

/** 测试钩子：清空订阅与状态（模块级变量会跨用例存活）。 */
export function resetResumeForTest() {
  listeners.clear()
  lastResumeAt = 0
  lastResumeCause = ''
  eventsBound = false
}

// 模块加载时绑一次：DSH 客户端 bundle 在页面里加载，这里就是"页面恢复"的唯一入口。
bindResumeEvents()
