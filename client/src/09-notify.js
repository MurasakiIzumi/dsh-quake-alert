// ============================================================================
// dsh-quake-alert · client/src/09-notify.js
//
// 作用：用户可见提醒的两种呈现——系统通知与页面内 toast。
// 内容：通知能力与权限判定、请求权限、系统通知发送、toast 渲染与自动消失。
// 依赖：01-constants。
// 约定：页面可见时只用 toast，后台才用系统通知（系统通知不可用时回退 toast）。
// ============================================================================

// ---------- 通知：系统通知 + toast ----------
function notificationSupported() { return typeof window !== 'undefined' && typeof window.Notification === 'function' }
function notificationPermission() {
  if (!notificationSupported()) return 'unsupported'
  return window.Notification.permission
}
function requestNotificationPermission() {
  if (!notificationSupported()) return Promise.resolve('unsupported')
  try { return Promise.resolve(window.Notification.requestPermission()) } catch (err) { return Promise.resolve('denied') }
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
function showToast(opts) {
  try {
    if (!window.document || !window.document.body) return
    const doc = window.document
    const el = doc.createElement('div')
    const id = 'quake-alert-toast-' + (++toastSeq)
    el.id = id
    // role=alert（0.5.4）：页面可见时**只用 toast**（见 11-pipeline），而这正是读屏用户
    // 唯一能收到警报的通道——没有 live region 语义，它就完全感知不到。
    // 用 typeof 守卫：非浏览器的 DOM stub（回归测试）不一定实现 setAttribute。
    if (typeof el.setAttribute === 'function') el.setAttribute('role', 'alert')
    const color = opts.color || '#e5484d'
    const style = el.style
    style.position = 'fixed'
    style.top = '16px'
    style.right = '16px'
    style.zIndex = '2000' // 高于 DSH 前端自身的层级（最高约 1100），但不再用 2^31-1 压住一切
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
    title.textContent = opts.title || ''
    const body = doc.createElement('div')
    body.style.marginTop = '3px'
    body.style.whiteSpace = 'pre-wrap'
    body.style.wordBreak = 'break-word'
    body.textContent = opts.body || ''
    el.appendChild(title); el.appendChild(body)
    el.addEventListener('click', () => { try { doc.body.removeChild(el) } catch (err) {} })
    doc.body.appendChild(el)
    requestAnimationFrame(() => { el.style.opacity = '1' })
    const ttl = opts.ttlMs || 8000
    setTimeout(() => {
      el.style.opacity = '0'
      setTimeout(() => { try { if (el.parentNode) el.parentNode.removeChild(el) } catch (err) {} }, 220)
    }, ttl)
  } catch (err) { /* DOM 不可用忽略 */ }
}


export { notificationSupported, notificationPermission, requestNotificationPermission, showSystemNotification, showToast }
