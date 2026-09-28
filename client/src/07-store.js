// ============================================================================
// dsh-quake-alert · client/src/07-store.js
// 全局 store：连接状态 + 最近预警，供设置页与状态指示订阅。含 store 对象与 addEvent。
// store.push({}) 是各 UI 的重渲染信号，改变它会影响所有订阅方。
// ============================================================================

import { HISTORY_MAX, HISTORY_MAX_AGE_MS, HISTORY_KEY } from './01-constants.js'
import { loadHistory, saveJSON, isPlainObject, normalizeHistoryEntry, withinHistoryAge } from './02-storage.js'
import { t } from './00-i18n.js'
import { sourceLabelOf, statusTextOf } from './00f-source-labels.js'

const store = {
  status: 'idle', // idle | connecting | open | reconnecting | closed（多源聚合结果）
  retries: 0,
  detail: '',
  sources: {}, // { [id]: { label, status, retries, detail } }
  received: 0, // 收到并成功解析的推送条数（诊断用）
  events: loadHistory(), // 最近预警 [{kind,label,severity,issued,headline,pref}]
  weatherHint: null, // 气象警报的「静默提示」（L3 命中关注地区时只记一笔）：{ level, area, pref, at } | null
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
    // 源名要按语言现取（`sourceLabelOf(id)`），不能沿用 `sources[id].label`——那是建连那一刻的语言
    const ids = Object.keys(this.sources)
    if (ids.length === 0) {
      this.status = 'idle'; this.retries = 0; this.detail = ''
      return
    }
    const activeIds = ids.filter((id) => this.sources[id].status !== 'disabled')
    if (activeIds.length === 0) {
      this.status = 'disabled'; this.retries = 0
      this.detail = ids.map((id) => t('status.sourceDisabled', { name: sourceLabelOf(id) })).join(' · ')
      return
    }
    const pick = (s) => activeIds.filter((id) => this.sources[id].status === s)[0]
    // 主状态优先级：红（停了 / 不可达）→ 蓝（数据格式异常）→ 黄（连接中 / 重连 / 降级）→ 灰（过期）→ 绿
    const chosenId = pick('closed') || pick('unreachable') || pick('schema-error') ||
      pick('reconnecting') || pick('connecting') || pick('degraded') || pick('stale') ||
      pick('open') || activeIds[0]
    const chosen = this.sources[chosenId]
    this.status = chosen.status
    this.retries = typeof chosen.retries === 'number' ? chosen.retries : 0
    // 没有具体原因时退回**状态文字**，裸状态码是给开发看的
    const badIds = activeIds.filter((id) => this.sources[id].status !== 'open')
    this.detail = (badIds.length ? badIds : activeIds)
      .map((id) => {
        const s = this.sources[id]
        return t('status.sourceDetail', {
          name: sourceLabelOf(id),
          detail: s.detail || statusTextOf(s.status, s.retries),
        })
      }).join(' · ')
  },
  subscribe(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn) },
}
let anonSeq = 0 // 无 id 消息用递增匿名 key，避免空 id 互相覆盖
function addEvent(ev) {
  const hasId = ev && ev.id && ev.id !== ''
  const key = hasId ? ev.id : ('anon-' + (++anonSeq))
  // 写入时刻：历史保留的「过去 5 天」以它为准（见 withinHistoryAge）；有限值可注入以便测试
  const now = (ev && typeof ev.at === 'number' && Number.isFinite(ev.at) && ev.at > 0) ? ev.at : Date.now()
  const item = normalizeHistoryEntry(Object.assign({}, ev, { key, at: now }), 0)
  // 条数与**时间**两个上限同时生效
  const fresh = store.events.filter((e) => withinHistoryAge(e, now))
  store.events = [item].concat(fresh.filter((e) => e.key !== key)).slice(0, HISTORY_MAX)
  saveJSON(HISTORY_KEY, store.events.slice(0, HISTORY_MAX))
  store.push({})
}


export { store, addEvent }
