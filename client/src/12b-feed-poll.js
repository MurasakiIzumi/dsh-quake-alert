// ============================================================================
// dsh-quake-alert · client/src/12b-feed-poll.js
//
// 作用：从 Host 的只读路由拉気象庁电文增量，解析成 Alert 后交给主链
//       ——与 P2PQuake 的 551/552/556 汇到同一个 handleAlert。
// 内容：游标推进、增量应用、失败容错、启停、诊断计数。
// 依赖：03-settings-bridge（currentCfg）、05b-jma-parser（parseJma）、11-pipeline（handleAlert）。
//
// 为什么拉本地而不是浏览器直连気象庁：Host 是每台机器唯一的外部请求者，多标签页 / 多窗口
// 不会放大请求——気象庁明文要求「一度取得したファイルを再度取得しない」，违反会被封 IP。
// 这里只从回环地址取增量，没有外部成本。
//
// 游标语义：`?since=N` 返回 seq > N 的条目；Host 的环缓冲淘汰旧条目时会带 truncated，
// 表示中间有缺口——此时仍然应用已有的条目（宁可少报几条，也不要卡住不再前进）。
// ============================================================================

import { currentCfg } from './03-settings-bridge.js'
import { parseJma } from './05b-jma-parser.js'
import { handleAlert } from './11-pipeline.js'

/** Host 侧的电文增量路由（与 lib/index.js 的 FEED_PATH 对应）。 */
export const FEED_PATH = '/dsh-quake-alert/feed'
/** 本地拉取间隔：Host 每 60s 拉一次源，这里 15s 拉一次本地缓存，端到端最坏约 75s。 */
export const FEED_POLL_MS = 15 * 1000
/** 启动后首轮延迟：给插件装载、城市表与 host 侧首轮轮询让路。 */
export const FEED_FIRST_DELAY_MS = 3000

async function defaultFetchJson(url) {
  const res = await window.fetch(url, { headers: { accept: 'application/json' } })
  if (!res || !res.ok) throw new Error('HTTP ' + (res ? res.status : '?'))
  return res.json()
}

/**
 * @param {object} [opts]
 * @param {number} [opts.intervalMs]
 * @param {number} [opts.firstDelayMs]
 * @param {(url: string) => Promise<object>} [opts.fetchJson] 注入点（测试用）
 * @param {(entry: object, cfg: object) => boolean} [opts.apply] 注入点（测试用）
 * @param {() => object} [opts.getCfg] 注入点（测试用）
 * @param {(err: Error) => void} [opts.onError]
 */
export function createFeedClient(opts = {}) {
  const intervalMs = opts.intervalMs || FEED_POLL_MS
  const firstDelayMs = opts.firstDelayMs === undefined ? FEED_FIRST_DELAY_MS : opts.firstDelayMs
  const fetchJson = opts.fetchJson || defaultFetchJson
  const getCfg = opts.getCfg || currentCfg
  const onError = opts.onError || (() => {})
  const apply = opts.apply || ((entry, cfg) => {
    const alert = parseJma(entry && entry.xml, { id: entry && entry.id })
    if (!alert) return false
    handleAlert(alert, cfg)
    return true
  })

  let since = 0
  let timer = null
  let running = false
  let inFlight = null
  const stats = { polls: 0, received: 0, applied: 0, errors: 0, truncated: 0, lastAt: 0, cursor: 0 }

  async function pollOnce() {
    stats.polls += 1
    let data
    try {
      data = await fetchJson(FEED_PATH + '?since=' + since)
    } catch (err) {
      stats.errors += 1
      onError(err)
      return { applied: 0, cursor: since }
    }
    stats.lastAt = Date.now()
    const entries = Array.isArray(data && data.entries) ? data.entries : []
    if (data && data.truncated) stats.truncated += 1
    let applied = 0
    for (const e of entries) {
      stats.received += 1
      try {
        if (apply(e, getCfg())) applied += 1
      } catch (err) {
        // 单条电文解析失败不能影响后续条目，也不能让游标停住
        stats.errors += 1
        onError(err)
      }
    }
    stats.applied += applied
    if (data && Number.isFinite(data.cursor) && data.cursor >= since) since = data.cursor
    stats.cursor = since
    return { applied, cursor: since, truncated: !!(data && data.truncated) }
  }

  function pollSerial() {
    if (inFlight) return inFlight
    inFlight = pollOnce().finally(() => { inFlight = null })
    return inFlight
  }

  function schedule(delay) {
    if (!running) return
    timer = setTimeout(async () => {
      timer = null
      // 气象灾害关闭时不必拉增量（Host 侧随后也会据此停轮询）
      if ((getCfg().disasters || {}).weather !== false) {
        try { await pollSerial() } catch (err) { onError(err) }
      }
      schedule(intervalMs)
    }, delay)
  }

  return {
    start() {
      if (running) return
      running = true
      schedule(firstDelayMs)
    },
    stop() {
      running = false
      if (timer) { clearTimeout(timer); timer = null }
    },
    pollOnce,
    pollSerial,
    stats() { return Object.assign({}, stats, { running }) },
    /** 测试与诊断用：当前游标。 */
    cursor() { return since },
  }
}
