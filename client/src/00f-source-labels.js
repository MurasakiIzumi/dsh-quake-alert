// ============================================================================
// dsh-quake-alert · client/src/00f-source-labels.js
//
// 作用：源 id ↔ 文案 key 的单一映射（SOURCE_LABEL_KEYS、STATUS_TEXT_KEYS），
//       以及「显示时求值」的两个取词助手 sourceLabelOf / statusTextOf。
// 依赖：00-i18n。
//
// 这两个映射各有一份：13-ui-settings 的源名表 / statusMetaOf 与 07-store 的状态摘要
// 必须给同一个答案，所以都从这里取。
// **取词必须在调用时求值**：`t()` 读的是当前语言，而当前语言由 `loadCfg` / `applyCfg` 设置。
// 模块级写 `const X = t('...')` 会固化成默认语言，用户切语言后它不会变，所以这里导出函数。
// ============================================================================

import { t } from './00-i18n.js'

/** 源 id → 显示名 key。新增源时这里加一项（13 的 SOURCE_ORDER 是排列顺序，另一件事）。 */
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
  // hasOwnProperty：直接取 `SOURCE_LABEL_KEYS['constructor']` 会命中原型链（同 00-i18n 的 t）
  const key = Object.prototype.hasOwnProperty.call(SOURCE_LABEL_KEYS, raw) ? SOURCE_LABEL_KEYS[raw] : ''
  return key ? t(key) : raw
}

/** 状态码 → 当前语言下的文字。`retries` 只被 reconnecting 用到。 */
function statusTextOf(status, retries) {
  const code = String(status === undefined || status === null ? '' : status)
  const key = Object.prototype.hasOwnProperty.call(STATUS_TEXT_KEYS, code) ? STATUS_TEXT_KEYS[code] : ''
  if (!key) return t('settings.status.raw', { status: code })
  if (code === 'reconnecting') return t(key, { n: typeof retries === 'number' && Number.isFinite(retries) ? retries : 0 })
  return t(key)
}

export { SOURCE_LABEL_KEYS, STATUS_TEXT_KEYS, sourceLabelOf, statusTextOf }
