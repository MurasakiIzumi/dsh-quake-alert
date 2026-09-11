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
const store = {
  status: 'idle', // idle | connecting | open | reconnecting | closed
  retries: 0,
  detail: '',
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
