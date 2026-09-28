// ============================================================================
// dsh-quake-alert · client/src/09-notify.js
// 作用：用户可见提醒的两种呈现——系统通知与页面内 toast（能力与权限判定、发送、toast 渲染）。
// 依赖：01-constants。约定：页面可见时只用 toast，后台才用系统通知（系统通知不可用时回退 toast）。
// ============================================================================

function notificationSupported() { return typeof window !== 'undefined' && typeof window.Notification === 'function' }
function notificationPermission() {
  if (!notificationSupported()) return 'unsupported'
  return window.Notification.permission
}
function requestNotificationPermission() {
  if (!notificationSupported()) return Promise.resolve('unsupported')
  try {
    // 老实现的 `requestPermission` 是回调式：返回 `undefined` 并把结果交给回调。这里两种签名都接——
    // 返回 Promise 就直接用，否则轮询等回调（30 秒无回应按 'default' 收场，不假装成功）。
    let cbResult = ''
    const ret = window.Notification.requestPermission((res) => { cbResult = String(res || '') })
    if (ret && typeof ret.then === 'function') return ret
    return new Promise((resolve) => {
      let tries = 0
      const tick = () => {
        tries += 1
        if (cbResult) { resolve(cbResult); return }
        if (tries > 120) { resolve('default'); return } // 30 秒没有回应：当作"尚未决定"
        setTimeout(tick, 250)
      }
      tick()
    })
  } catch (err) { return Promise.resolve('denied') }
}
function showSystemNotification(opts) {
  if (!notificationSupported() || window.Notification.permission !== 'granted') return false
  try {
    // eslint-disable-next-line no-new
    new window.Notification(opts.title, {
      body: opts.body || '',
      tag: opts.tag || 'quake-alert',
      icon: opts.icon,
      silent: Boolean(opts.silent),
    })
    return true
  } catch (err) { return false }
}
let toastSeq = 0
// 当前屏上的 toast，共用一个纵向排列容器（自动堆叠）；超过 TOAST_MAX 条时收掉最旧的一条。
const TOAST_MAX = 3
let toastBox = null
const liveToasts = [] // [{ el, key }]
function ensureToastBox(doc) {
  if (toastBox && toastBox.parentNode) return toastBox
  const box = doc.createElement('div')
  const st = box.style
  st.position = 'fixed'
  st.top = '16px'
  st.right = '16px'
  // 高于 DSH 前端自身的层级（最高约 1100）
  st.zIndex = '2000'
  st.display = 'flex'
  st.flexDirection = 'column'
  st.gap = '8px'
  st.alignItems = 'flex-end'
  // 容器本身不挡点击，单条 toast 恢复 auto —— 否则空白的容器会盖住右下角一片界面
  st.pointerEvents = 'none'
  if (typeof box.setAttribute === 'function') box.setAttribute('aria-live', 'polite')
  doc.body.appendChild(box)
  toastBox = box
  return box
}
function dropToast(entry) {
  const i = liveToasts.indexOf(entry)
  if (i !== -1) liveToasts.splice(i, 1)
  try { if (entry.el && entry.el.parentNode) entry.el.parentNode.removeChild(entry.el) } catch (err) { /* 已移除 */ }
}
/** 渲染一条 toast 并在 ttl 后淡出移除；dropToast 从界面与 liveToasts 里摘掉一条。 */
function showToast(opts) {
  try {
    if (!window.document || !window.document.body) return
    const doc = window.document
    const color = opts.color || '#e5484d'
    const key = color + '|' + (opts.title || '') + '|' + (opts.body || '')
    // 同一条已经在屏上就不再叠一条；参数名不用 `t`（那是 i18n 取词函数名）
    if (liveToasts.some((live) => live.key === key)) return
    const box = ensureToastBox(doc)
    while (liveToasts.length >= TOAST_MAX) dropToast(liveToasts[0])
    const el = doc.createElement('div')
    const id = 'quake-alert-toast-' + (++toastSeq)
    el.id = id
    // role=alert：页面可见时只用 toast，读屏用户全靠这个 live region 收到警报
    if (typeof el.setAttribute === 'function') el.setAttribute('role', 'alert')
    const style = el.style
    style.pointerEvents = 'auto'
    style.maxWidth = '340px'
    style.background = 'rgba(24,25,30,0.97)'
    style.color = '#e8e8ea'
    style.border = '1px solid ' + color
    style.borderLeft = '4px solid ' + color
    style.borderRadius = '10px'
    style.padding = '10px 14px'
    style.font = '13px/1.5 system-ui, sans-serif'
    style.boxShadow = '0 6px 24px rgba(0,0,0,0.45)'
    style.cursor = 'pointer'
    style.opacity = '0'
    style.transition = 'opacity .18s ease'
    const title = doc.createElement('div')
    title.style.fontWeight = '700'
    title.style.color = color
    // 标题也要能换行，长标题（含区域名与震级）否则会溢出 340px
    title.style.wordBreak = 'break-word'
    title.textContent = opts.title || ''
    const body = doc.createElement('div')
    body.style.marginTop = '3px'
    body.style.whiteSpace = 'pre-wrap'
    body.style.wordBreak = 'break-word'
    body.textContent = opts.body || ''
    el.appendChild(title); el.appendChild(body)
    const entry = { el, key }
    el.addEventListener('click', () => { dropToast(entry) })
    box.appendChild(el)
    liveToasts.push(entry)
    requestAnimationFrame(() => { el.style.opacity = '1' })
    const ttl = opts.ttlMs || 8000
    setTimeout(() => {
      el.style.opacity = '0'
      setTimeout(() => dropToast(entry), 220)
    }, ttl)
  } catch (err) { /* DOM 不可用忽略 */ }
}


export { notificationSupported, notificationPermission, requestNotificationPermission, showSystemNotification, showToast }
