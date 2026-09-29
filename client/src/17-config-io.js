// ============================================================================
// dsh-quake-alert · client/src/17-config-io.js
// 作用：配置的导出 / 导入 / 撤销。
// 内容：导出文件格式与版本、导入校验、导入前自动备份、撤销上次导入、文件下载与读取。
// 依赖：01-constants、02-storage（规整与存取）、03-settings-bridge（读写配置的唯一入口）。
// 语义（对外契约）：
//   · 只导出配置本身（关注点、阈值、语言、数据源、静默时段……）；历史与源健康记录**不进文件**。
//   · **导入是整体替换**，不是合并，所以导入前**自动把当前配置备份一份**，并给出「撤销上次导入」出口。
//   · **格式版本是唯一的契约**：文件里不写插件版本；`formatVersion` 高于本版能读的就**拒绝**。
//   · 校验失败一律返回**错误码**（不是拼好的中文句子）：文案由 UI 层按当前界面语言翻。
// ============================================================================

import { normalizeCfg, isPlainObject, loadJSON, saveJSON } from './02-storage.js'
import { currentCfg, applyCfg } from './03-settings-bridge.js'

/** 文件标识：导入时用它区分"这是本插件的配置文件"与"随手拖进来的其它 JSON"。 */
const CONFIG_FORMAT = 'dsh-quake-alert/config'
/** 格式版本。结构变化时 +1；导入端对更高的版本直接拒绝（见文件头）。 */
const CONFIG_FORMAT_VERSION = 1
/** 导入前自动备份的存放位置（与配置本身同一个 localStorage，便于一键撤销）。 */
const CONFIG_BACKUP_KEY = 'dsh.quakeAlert.backup'

/** 导出文件名：带日期，便于用户区分多次导出。 */
function configFileName(now) {
  const d = now instanceof Date ? now : new Date()
  const pad = (n) => String(n).padStart(2, '0')
  return 'quake-alert-config-' + d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate()) + '.json'
}

/** 生成导出文件内容（缩进过的 JSON）。cfg 省略时取当前生效的配置；now 用于测试注入时间。 */
function buildConfigExport(cfg, now) {
  const at = now instanceof Date ? now : new Date()
  return JSON.stringify({
    format: CONFIG_FORMAT,
    formatVersion: CONFIG_FORMAT_VERSION,
    exportedAt: at.toISOString(),
    config: normalizeCfg(cfg || currentCfg()),
  }, null, 2)
}

/** 解析并校验一份导入文本。**不做任何写入**（纯函数）。
 *  @returns {{ok:true,cfg:object,formatVersion:number,warnings:object}|{ok:false,error:string,detail?:string}}
 *  error 取值：`json`（不是 JSON）/ `shape`（结构不符）/ `format`（其它应用）/ `version`（非法）/ `newer`（版本更高） */
function parseConfigImport(text) {
  // 去掉 BOM：记事本、PowerShell 的 `Out-File -Encoding utf8` 都会加上，而 JSON.parse 会因此在首字符上抛。
  const raw = String(text === undefined || text === null ? '' : text).replace(/^\uFEFF/, '')
  if (!raw.trim()) return { ok: false, error: 'shape' }
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch (err) {
    return { ok: false, error: 'json', detail: String((err && err.message) || err) }
  }
  if (!isPlainObject(parsed)) return { ok: false, error: 'shape' }
  if (parsed.format !== CONFIG_FORMAT) return { ok: false, error: 'format', detail: String(parsed.format === undefined ? '' : parsed.format) }
  const v = parsed.formatVersion
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 1) return { ok: false, error: 'version' }
  if (v > CONFIG_FORMAT_VERSION) return { ok: false, error: 'newer', detail: String(v) }
  if (!isPlainObject(parsed.config)) return { ok: false, error: 'shape' }
  // 规整出错也返回错误码：畸形配置（字段是转不成字符串的对象）会在规整里抛，抛出去 UI 那条 .then 链上没人接得住。
  let cfg
  // 关注点检查清单：规整流程会**静默**丢弃坐标非法的关注点、把超上限的市町村截断，这里把清单
  // 交出去，由界面如实说明少了什么。字段必须与 normalizePlaces / normalizeCities 写入的一致
  // （漏一个字段就是 `undefined + n = NaN`，界面上的 `> 0` 判定恒假 → 提示永不出现）。
  const audit = { total: 0, dropped: 0, radiusFixed: 0, citiesDropped: 0 }
  try {
    cfg = normalizeCfg(parsed.config, audit)
  } catch (err) {
    return { ok: false, error: 'shape', detail: String((err && err.message) || err) }
  }
  return { ok: true, cfg, formatVersion: v, warnings: audit }
}

/** 把当前配置备份到 localStorage（覆盖上一次备份）。**返回备份时间；写不进去时返回空字符串**——
 *  saveJSON 是静默失败的，而这份备份是"导入还能回滚"的**全部依据**，所以写后**回读校验**、确认真的写进了本地存储。 */
function backupCurrentConfig(now) {
  const at = now instanceof Date ? now : new Date()
  const payload = { at: at.toISOString(), config: normalizeCfg(currentCfg()) }
  saveJSON(CONFIG_BACKUP_KEY, payload)
  const back = loadConfigBackup()
  return back && back.at === payload.at ? payload.at : ''
}

/** 读回备份。没有备份、或备份结构不可用时返回 null（不抛错：界面只需知道"能不能撤销"）。 */
function loadConfigBackup() {
  const b = loadJSON(CONFIG_BACKUP_KEY, null)
  if (!isPlainObject(b) || !isPlainObject(b.config)) return null
  let cfg
  try {
    cfg = normalizeCfg(b.config)
  } catch (err) {
    // 备份同样是外部输入（用户能在 localStorage 里改），规整时可能抛；调用方在渲染期，按"没有可撤销的备份"处理。
    try { console.warn('[dsh-quake-alert] 备份配置归一化失败，视为无备份：' + String((err && err.message) || err)) } catch (e) { /* 忽略 */ }
    return null
  }
  return { at: String(b.at || ''), cfg }
}

function clearConfigBackup() {
  try {
    if (typeof window !== 'undefined' && window.localStorage) window.localStorage.removeItem(CONFIG_BACKUP_KEY)
  } catch (err) { /* 存储不可用时忽略：清不掉备份不影响正确性 */ }
}

/** 导入：**先备份当前配置，再整体替换**；校验失败时**什么都不写**（连备份都不做）。
 *  @returns {{ok:true,cfg:object,backupAt:string}|{ok:false,error:string,detail?:string}} */
function importConfig(text, now) {
  const parsed = parseConfigImport(text)
  if (!parsed.ok) return parsed
  const backupAt = backupCurrentConfig(now)
  // 备份不成功就**不导入**：没有退路时"整体替换成另一份配置"是不可逆的破坏性操作。
  if (!backupAt) return { ok: false, error: 'backup-failed' }
  const next = applyCfg(parsed.cfg)
  return { ok: true, cfg: next, backupAt, warnings: parsed.warnings }
}

/** 撤销上次导入：把备份写回去，**然后清掉备份**——一次性撤销，撤销成功即清掉快照、按钮随之消失。 */
function undoConfigImport() {
  const b = loadConfigBackup()
  if (!b) return { ok: false, error: 'no-backup' }
  applyCfg(b.cfg)
  clearConfigBackup()
  return { ok: true, at: b.at }
}

/** 触发浏览器下载。**返回是否成功**——沙箱 iframe 里 `URL.createObjectURL` 可能不可用，
 *  那种情况下 UI 要退回"把文本显示出来让用户自己复制"（同诊断快照的处理）。 */
function downloadConfigFile(text, filename) {
  try {
    if (typeof document === 'undefined' || typeof URL === 'undefined' || typeof URL.createObjectURL !== 'function') return false
    const blob = new Blob([String(text)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = String(filename || configFileName())
    if (document.body && typeof document.body.appendChild === 'function') {
      document.body.appendChild(a)
      a.click()
      if (typeof a.remove === 'function') a.remove()
      else if (typeof document.body.removeChild === 'function') document.body.removeChild(a)
    } else {
      a.click()
    }
    setTimeout(() => { try { URL.revokeObjectURL(url) } catch (err) { /* 忽略 */ } }, 1000)
    return true
  } catch (err) { return false }
}

/** 读文件为文本。优先用 `File.text()`（现代浏览器），否则退回 FileReader。 */
function readConfigFile(file) {
  if (!file) return Promise.resolve({ ok: false, error: 'no-file' })
  if (typeof file.text === 'function') {
    return file.text().then((s) => ({ ok: true, text: String(s) }), (err) => ({ ok: false, error: 'read', detail: String((err && err.message) || err) }))
  }
  return new Promise((resolve) => {
    try {
      const fr = new FileReader()
      fr.onload = () => resolve({ ok: true, text: String(fr.result === undefined || fr.result === null ? '' : fr.result) })
      fr.onerror = () => resolve({ ok: false, error: 'read' })
      fr.readAsText(file)
    } catch (err) {
      resolve({ ok: false, error: 'read', detail: String((err && err.message) || err) })
    }
  })
}

export {
  CONFIG_FORMAT, CONFIG_FORMAT_VERSION, CONFIG_BACKUP_KEY,
  configFileName, buildConfigExport, parseConfigImport,
  backupCurrentConfig, loadConfigBackup, clearConfigBackup,
  importConfig, undoConfigImport, downloadConfigFile, readConfigFile,
}
