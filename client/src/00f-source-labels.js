// ============================================================================
// dsh-quake-alert · client/src/00f-source-labels.js
//
// 作用：源 id ↔ 文案 key 的**单一映射**，以及"显示时求值"的两个取词助手。
// 内容：SOURCE_LABEL_KEYS、STATUS_TEXT_KEYS、sourceLabelOf、statusTextOf。
// 依赖：00-i18n。
//
// 为什么要有这个文件：
//   · 源名此前在 13-ui-settings 的 `SOURCE_LABELS` 里写一份，而 15-entry 又通过
//     `createFeedClient({ label })` 往 store 里塞了另一份（那份是中文字面量，进的是
//     侧边栏悬停提示与诊断快照）。本地化之后两处必须给同一个答案，所以映射只有这一份。
//   · 状态码（`open` / `schema-error` …）的文字由 13 的 `statusMetaOf` 提供，而 07-store
//     拼状态摘要时也需要它。映射放这里，两边都从这里取。
//
// **取词必须在调用时求值**：`t()` 读的是"当前语言"，而当前语言由 `loadCfg` / `applyCfg`
// 设置。模块级写 `const X = t('...')` 会在模块加载那一刻求值——那时配置还没读，
// 于是常量被固化成默认语言，用户切语言后它不会变（界面表现是"一半跟着切、一半不切"）。
// 所以这里导出的是**函数**，不是常量对象。
// ============================================================================

import { t } from './00-i18n.js'

/** 源 id → 显示名 key。新增源时这里加一项（13 的 SOURCE_ORDER 是另一件事：那是排列顺序）。 */
const SOURCE_LABEL_KEYS = {
  p2pquake: 'settings.sourceLabels.p2pquake',
  emsc: 'settings.sourceLabels.emsc',
  cenc_eew: 'settings.sourceLabels.cencEew',
  cenc_eqlist: 'settings.sourceLabels.cencEqlist',
  jma: 'settings.sourceLabels.jma',
  usgs: 'settings.sourceLabels.usgs',
  noaa: 'settings.sourceLabels.noaa',
  nmc_alarm: 'settings.sourceLabels.nmc',
  nws_alerts: 'settings.sourceLabels.nws',
  eccc_alerts: 'settings.sourceLabels.eccc',
}

/** 连接状态码 → 文案 key（与 13 的 `statusMetaOf` 用同一批 key）。 */
const STATUS_TEXT_KEYS = {
  idle: 'settings.status.idle',
  connecting: 'settings.status.connecting',
  open: 'settings.status.open',
  reconnecting: 'settings.status.reconnecting',
  closed: 'settings.status.closed',
  unreachable: 'settings.status.unreachable',
  degraded: 'settings.status.degraded',
  stale: 'settings.status.stale',
  'schema-error': 'settings.status.schemaError',
  disabled: 'settings.status.disabled',
}

/** 源 id → 当前语言下的显示名。认不出的 id 原样返回（宁可显示 id，也不要显示空白）。 */
function sourceLabelOf(id) {
  const raw = String(id === undefined || id === null ? '' : id)
  // hasOwnProperty：`SOURCE_LABEL_KEYS['constructor']` 会命中原型链拿到一个函数（同 00-i18n 的 t）
  const key = Object.prototype.hasOwnProperty.call(SOURCE_LABEL_KEYS, raw) ? SOURCE_LABEL_KEYS[raw] : ''
  return key ? t(key) : raw
}

/** 状态码 → 当前语言下的文字。`retries` 只被 reconnecting 用到（"重连中（第 N 次）"）。 */
function statusTextOf(status, retries) {
  const code = String(status === undefined || status === null ? '' : status)
  const key = Object.prototype.hasOwnProperty.call(STATUS_TEXT_KEYS, code) ? STATUS_TEXT_KEYS[code] : ''
  if (!key) return t('settings.status.raw', { status: code })
  if (code === 'reconnecting') return t(key, { n: typeof retries === 'number' && Number.isFinite(retries) ? retries : 0 })
  return t(key)
}

export { SOURCE_LABEL_KEYS, STATUS_TEXT_KEYS, sourceLabelOf, statusTextOf }
