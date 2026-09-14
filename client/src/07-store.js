// ============================================================================
// dsh-quake-alert · client/src/07-store.js
//
// 作用：全局 store——连接状态 + 最近预警，供设置页与状态指示订阅。
// 内容：store 对象（status/retries/detail/received/events + 订阅）、
//       addEvent（写入历史并落盘，key 唯一化）。
// 依赖：01-constants、02-storage。
// 注意：store.push({}) 是各 UI 的重渲染信号，改变它会影响所有订阅方。
// ============================================================================

import { HISTORY_MAX, HISTORY_KEY } from './01-constants.js'
import { loadHistory, saveJSON, isPlainObject, normalizeHistoryEntry } from './02-storage.js'

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
    Object.assign(this, patch)
    this.listeners.forEach((fn) => fn())
  },
  /** 某个连接源汇报自己的状态；主状态由 recomputeStatus 聚合得出。 */
  pushSource(id, patch) {
    const cur = this.sources[id] || { label: id, status: 'idle', retries: 0, detail: '' }
    this.sources[id] = Object.assign({}, cur, patch)
    this.recomputeStatus()
    this.push({})
  },
  /** 插件停用 / 重建时把源清空，避免残留的旧状态把新会话显示成"已连接"。 */
  clearSources() {
    this.sources = {}
    this.received = 0 // 推送计数也归零：否则重载后徽标会带着上一代的数字继续涨
    this.recomputeStatus()
    this.push({})
  },
  recomputeStatus() {
    const list = Object.keys(this.sources).map((k) => this.sources[k])
    if (list.length === 0) {
      this.status = 'idle'; this.retries = 0; this.detail = ''
      return
    }
    // disabled（用户关掉了某个灾种）不参与聚合：它不该把整体拉成"异常"，
    // 但全部源都关掉时要如实显示成"已关闭"而不是"未启动"。
    const active = list.filter((x) => x.status !== 'disabled')
    if (active.length === 0) {
      this.status = 'disabled'; this.retries = 0
      this.detail = list.map((x) => (x.label || '') + '：已关闭').join(' · ')
      return
    }
    const pick = (s) => active.filter((x) => x.status === s)[0]
    // 红优先：任一链路停了 / 不可达，整体就不是"正常"；其次蓝（数据格式异常，用户处理不了）、
    // 黄（连接中 / 重连 / 降级）、中灰（数据过期），最后才是绿。
    // 0.4.1 起 feed 源（JMA / USGS / NOAA）也上报状态——此前只有 WebSocket 源参与聚合，
    // 于是气象 / 全球轮询链路整体死掉时侧边栏仍然是绿的（用户以为在被保护）。
    const chosen = pick('closed') || pick('unreachable') || pick('schema-error') ||
      pick('reconnecting') || pick('connecting') || pick('degraded') || pick('stale') ||
      pick('open') || active[0]
    this.status = chosen.status
    this.retries = typeof chosen.retries === 'number' ? chosen.retries : 0
    // 详情优先列异常源（全部正常时才列全部）：源多了以后逐条列会挤爆悬停提示
    const bad = active.filter((x) => x.status !== 'open')
    this.detail = (bad.length ? bad : active)
      .map((x) => (x.label || '') + '：' + (x.detail || x.status)).join(' · ')
  },
  subscribe(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn) },
}
let anonSeq = 0 // 兜底：无 id 消息用递增匿名 key，避免空 id 互相覆盖
function addEvent(ev) {
  const hasId = ev && ev.id && ev.id !== ''
  const key = hasId ? ev.id : ('anon-' + (++anonSeq))
  // 统一过一遍字段规整：写入侧也保证历史里不会出现对象/数组字段
  const item = normalizeHistoryEntry(Object.assign({}, ev, { key }), 0)
  store.events = [item].concat(store.events.filter((e) => e.key !== key)).slice(0, HISTORY_MAX)
  saveJSON(HISTORY_KEY, store.events.slice(0, HISTORY_MAX))
  store.push({})
}


export { store, addEvent }
