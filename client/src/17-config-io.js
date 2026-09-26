// ============================================================================
// dsh-quake-alert · client/src/17-config-io.js
//
// 作用：配置的导出 / 导入 / 撤销（0.9.0，DESIGN 11.1 的第二半）。
// 内容：导出文件格式与版本、导入校验、导入前自动备份、撤销上次导入、文件下载与读取。
// 依赖：01-constants、02-storage（归一与存取）、03-settings-bridge（读写配置的唯一入口）。
//
// 定稿的语义（0.9.0 开工前拍定，写在 DESIGN 11.11）：
//   · **只导出配置本身**：关注点、阈值、语言、数据源、静默时段……与 0.8.2 的配置契约
//     一一对应。历史（履历）与源健康记录**不进文件**——前者含源侧原文、换机器后未必对应
//     得上；后者是会话内的时效数据，导过去基本没用。
//   · **导入是整体替换**，不是合并：语义最直白、可预测。所以导入前**自动把当前配置备份一份**
//     （同一个 localStorage 里），并给出「撤销上次导入」这个出口——否则备份就是个没人用的文件。
//   · **格式版本是唯一的契约**：文件里不写插件版本（那会诱使调用方按版本号做分支，而真正
//     要判断的是结构是否兼容）。`formatVersion` 高于本版能读的就**拒绝**，而不是尽力解析
//     ——半个配置比没有配置更危险。
//   · 校验失败一律返回**错误码**（不是拼好的中文句子）：文案由 UI 层按当前界面语言翻，
//     否则导入失败提示会固定成中文（本地化在这里最容易漏）。
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

/**
 * 生成导出文件内容（缩进过的 JSON）。
 * @param {object} [cfg] 要导出的配置；省略时取当前生效的配置。
 * @param {Date} [now] 用于测试注入时间。
 */
function buildConfigExport(cfg, now) {
  const at = now instanceof Date ? now : new Date()
  return JSON.stringify({
    format: CONFIG_FORMAT,
    formatVersion: CONFIG_FORMAT_VERSION,
    exportedAt: at.toISOString(),
    config: normalizeCfg(cfg || currentCfg()),
  }, null, 2)
}

/**
 * 解析并校验一份导入文本。**不做任何写入**（纯函数，便于直接断言各种坏输入）。
 * @returns {{ok:true,cfg:object,formatVersion:number}|{ok:false,error:string,detail?:string}}
 *   error 取值：`json`（不是 JSON）/ `shape`（不是本插件配置的结构）/
 *   `format`（其它应用的 JSON）/ `version`（版本号缺失或非法）/ `newer`（版本高于本版能读的）
 */
function parseConfigImport(text) {
  // 去掉 BOM：JSON 规范不允许它，但记事本、PowerShell 的 `Out-File -Encoding utf8` 之类都会加上，
  // 而 `JSON.parse` 会因此在第一个字符上抛——对用户表现为"我导出后一个字没改，它却说不是有效的
  // JSON"。只差这一个 replace。
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
  // 归一必须与"返回错误码"同一口径：畸形配置（例如某个字段是 `{toString: null, valueOf: null}`
  // 这种**转不成字符串**的对象）会在归一里抛。让它抛出去的话，UI 那条 `.then` 链上没人接得住
  // ——用户点「导入」之后界面毫无反应，而这是最难归因的一类失败（11.8 教训 4）。
  let cfg
  try {
    cfg = normalizeCfg(parsed.config)
  } catch (err) {
    return { ok: false, error: 'shape', detail: String((err && err.message) || err) }
  }
  return { ok: true, cfg, formatVersion: v }
}

/**
 * 把当前配置备份到 localStorage（覆盖上一次备份）。
 *
 * **返回备份时间；写不进去时返回空字符串**——返回值不是"操作成功"的同义词。`saveJSON` 是
 * 静默失败的（`try { setItem } catch {}`），而这份备份是"导入还能回滚"的**全部依据**：写不进去
 * 却照样返回时间戳，界面就会显示「撤销上次导入」，用户点下去才发现没有备份，而那时他原来的
 * 配置已经被替换掉了。所以写后**回读校验**，确认它真的落了盘。
 */
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
  return { at: String(b.at || ''), cfg: normalizeCfg(b.config) }
}

function clearConfigBackup() {
  try {
    if (typeof window !== 'undefined' && window.localStorage) window.localStorage.removeItem(CONFIG_BACKUP_KEY)
  } catch (err) { /* 存储不可用时忽略：清不掉备份不影响正确性 */ }
}

/**
 * 导入：**先备份当前配置，再整体替换**。校验失败时**什么都不写**（连备份都不做）。
 * @returns {{ok:true,cfg:object,backupAt:string}|{ok:false,error:string,detail?:string}}
 */
function importConfig(text, now) {
  const parsed = parseConfigImport(text)
  if (!parsed.ok) return parsed
  const backupAt = backupCurrentConfig(now)
  // 备份不成功就**不导入**：定稿承诺的是"导入后随时能撤销"，而做不到这一点时，"整体替换成
  // 另一份配置"是不可逆的破坏性操作。宁可这次导入失败并如实说明，也不要在没有退路的情况下替换。
  if (!backupAt) return { ok: false, error: 'backup-failed' }
  const next = applyCfg(parsed.cfg)
  return { ok: true, cfg: next, backupAt }
}

/** 撤销上次导入：把备份写回去。备份会被保留（可以反复撤），由 clearConfigBackup 单独清。 */
function undoConfigImport() {
  const b = loadConfigBackup()
  if (!b) return { ok: false, error: 'no-backup' }
  applyCfg(b.cfg)
  return { ok: true, at: b.at }
}

/**
 * 触发浏览器下载。**返回是否成功**——沙箱 iframe 里 `URL.createObjectURL` 可能不可用，
 * 那种情况下 UI 要退回"把文本显示出来让用户自己复制"（同诊断快照的处理）。
 */
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
