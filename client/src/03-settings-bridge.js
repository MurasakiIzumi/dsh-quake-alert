// ============================================================================
// dsh-quake-alert · client/src/03-settings-bridge.js
// 机器级持久化桥：把配置交给 DSH Host settings（settings.yaml），localStorage 作回退与镜像。
// 含 currentCfg / applyCfg / settingsOpsFor / pushCfgToHost / bindSettingsScope / reloadFromLocal。
// 没有 settings 服务 / 页面非 loopback / Host 不持久化时，整条链路退化为纯 localStorage。
// ============================================================================

import { DEFAULT_CFG } from './01-constants.js'
import { isPlainObject, normalizeCfg, loadCfg, saveCfg, freshCfg, loadJSON, saveJSON } from './02-storage.js'
import { setLanguage, getLanguage } from './00-i18n.js'
import { store } from './07-store.js'

// ---------- 机器级持久化：Host 存储为主，localStorage 为回退与镜像 ----------
// 本模块只认一个**形状**（两代宿主都提供它），不关心它来自哪个服务：DSH 0.1.6 及以前是
// `ctx.settingsScope.bind({ namespace })` 返回的 scope，0.1.7 起是 `ctx.configForms.get('quake-alert')`
// 返回的 ConfigForm。两边同名同义：`getSnapshot()` / `subscribe(fn)` / `mutate(ops)`，快照字段
// `status / value / user / writable / mode` 一一对应。分派在 15-entry.js。scope 快照是**同步**可读的，
// 所以内部读取（重连、handleRaw）仍然同步；写入先更新内存与 localStorage 镜像，再异步推给 Host。
const SETTINGS_NS = 'quake-alert'
/** 「本地配置已迁移到 Host」写在本地的标记：迁移只能发生一次，见 bindSettingsScope。 */
const MIGRATED_KEY = 'dsh.quakeAlert.hostMigrated'
let runtimeCfg = null // 内存中的当前配置
let settingsScope = null // bind 成功后的 scope handle
let settingsSync = 'local' // local（无 Host）| host（写入 settings.yaml）| memory（Host 不持久化）

// Host section ⇄ 本地配置：version 是本地存储的结构版本概念，不属于 Host schema
function cfgToSection(cfg) {
  const out = {}
  for (const key of Object.keys(cfg)) if (key !== 'version') out[key] = cfg[key]
  return out
}
function sectionToCfg(section) {
  try {
    return normalizeCfg(Object.assign({ version: DEFAULT_CFG.version }, isPlainObject(section) ? section : {}))
  } catch (err) {
    // 与 loadCfg 同理：Host 下发的 section 也是外部输入（settings.yaml / profile 都能手写），
    // 规整的过程抛错不该让调用方的渲染期炸掉。
    try { console.warn('[dsh-quake-alert] Host section 归一化失败，本次改用默认配置：' + String((err && err.message) || err)) } catch (e) { /* 忽略 */ }
    return freshCfg()
  }
}
// 同步读取入口：调用方无需感知 Host 的存在
function currentCfg() {
  if (runtimeCfg === null) runtimeCfg = loadCfg()
  return runtimeCfg
}
// 本地镜像被**其它 DSH 标签页**改写后（storage 事件），把 localStorage 重新读回内存副本。
// 跨模块不能直接给本模块私有的 runtimeCfg 赋值（打包进 'use strict' 的 bundle 会抛 ReferenceError）。
/** 语言变化后，**由语言派生出来的文本**要重算，并让订阅者重渲染：`store.detail` 是 `recomputeStatus` 拼好的字符串（源名 + 状态文字），而状态点只订阅 store，不通知就不会重渲染。 */
function syncDerivedTextAfterLanguageChange() {
  try {
    store.recomputeStatus()
    store.push({})
  } catch (err) {
    // store 不可用（单测里很常见）时忽略：语言本身已经生效，这里只是让派生文本跟上。
  }
}
function reloadFromLocal() {
  const prevLang = getLanguage()
  runtimeCfg = loadCfg()
  if (getLanguage() !== prevLang) syncDerivedTextAfterLanguageChange()
  return runtimeCfg
}
// 写入入口：内存立即生效 → localStorage 镜像 → Host（可用时异步持久化）
function applyCfg(cfg) {
  const prevLang = getLanguage()
  // 写入路径也要规整，否则「坐标相同的关注点自动合并」「name 截断到 30 字」这类不变量在内存与 localStorage 里都不成立——同一次会话里重复添加同一个点会真的存两份。
  runtimeCfg = saveCfg(normalizeCfg(cfg))
  // 语言在**写入路径**也要生效：设置页切换语言走的就是这里，语言不在此刻落到 i18n 的当前值， 界面会等下一次配置加载才切换。
  setLanguage(runtimeCfg.language)
  if (getLanguage() !== prevLang) syncDerivedTextAfterLanguageChange()
  pushCfgToHost(runtimeCfg)
  return runtimeCfg
}
// 只提交与默认值不同的字段；等于默认值的字段用 unset 交还 schema 默认层， 这样 settings.yaml 里只留下用户真正改过的东西。
function settingsOpsFor(cfg) {
  const cur = cfgToSection(cfg)
  const def = cfgToSection(freshCfg())
  const ops = []
  const walk = (node, base, path) => {
    for (const key of Object.keys(node)) {
      const p = path.concat(key)
      const cv = node[key]
      const bv = base[key]
      if (isPlainObject(cv) && isPlainObject(bv)) { walk(cv, bv, p); continue }
      if (JSON.stringify(cv) === JSON.stringify(bv)) ops.push({ op: 'unset', path: p })
      else ops.push({ op: 'set', path: p, value: cv })
    }
  }
  walk(cur, def, [])
  return ops
}
/** 把配置推给 Host。返回 `scope.mutate()` 的 pending（没有真正发出写请求时返回 null）， 调用方据此判断"Host 是否确认接收"——迁移标记要靠它，见 bindSettingsScope。 */
function pushCfgToHost(cfg) {
  const scope = settingsScope
  if (!scope || settingsSync !== 'host') return null
  try {
    const snap = scope.getSnapshot()
    if (!snap || snap.status !== 'ready' || snap.writable !== true || snap.mode !== 'host') return null
    const ops = settingsOpsFor(cfg)
    if (ops.length === 0) return null
    const pending = scope.mutate(ops)
    if (pending && typeof pending.catch === 'function') pending.catch(() => { /* 写失败不回滚本地 */ })
    return (pending && typeof pending.then === 'function') ? pending : null
  } catch (err) { return null }
}
// 绑定 Host settings。三种来源的优先关系：① Host 用户层已有内容 → 以 Host 为准（机器级配置是 source of truth）；② Host 为空、本地已有非默认配置 → 一次性迁移到 Host；
// ③ Host 不可用 → 保持 localStorage。
/** 迁移的尝试上限。Host 持续拒绝写入时（revision 冲突等）不设上限会变成"每来一次 sync 就写一次" 的循环；用尽之后保留本地镜像，用户下一次改配置时经 applyCfg 直接写进 Host。 */
const MIGRATE_MAX_ATTEMPTS = 3

function bindSettingsScope(scope) {
  settingsScope = scope
  let migrateAttempts = 0
  const sync = () => {
    let snap = null
    try { snap = scope.getSnapshot() } catch (err) { return }
    if (!snap || snap.status !== 'ready' || snap.value === undefined) { settingsSync = 'local'; store.push({}); return }
    if (snap.mode !== 'host' || snap.writable !== true) { settingsSync = 'memory'; store.push({}); return }
    settingsSync = 'host'
    const user = isPlainObject(snap.user) ? snap.user : {}
    const claimed = loadJSON(MIGRATED_KEY, null) === 1
    if (Object.keys(user).length === 0 && !claimed) {
      // 迁移**只能发生一次**，而且这个"一次"必须写入本地存储：只在本次 bind 里记局部标志的话，每次重载 页面都会重新判断，"用户显式清空 Host"会被本地镜像静默恢复。
      const local = loadCfg()
      if (JSON.stringify(cfgToSection(local)) !== JSON.stringify(cfgToSection(freshCfg()))) {
        if (migrateAttempts >= MIGRATE_MAX_ATTEMPTS) {
          // 重试用尽：**不落标记、也不用 Host 的空值覆盖本地镜像**（那等于丢掉用户配置）， 用户下一次改配置会经 applyCfg 直接写进 Host。
          store.push({})
          return
        }
        migrateAttempts += 1
        runtimeCfg = saveCfg(local)
        const pending = pushCfgToHost(runtimeCfg)
        // **等 Host 真的接收之后再落"已完成迁移"标记**：先落标记再写的话，写入失败会让本地配置既没进
        // Host、又因为标记而不再重试，随后被 Host 的空值覆盖；也不能把 `pending` 的 resolve 当成功
        //（平台的 mutate 在 Host 拒绝时也是 resolve），所以 settle 之后回读一次才算完成。
        if (pending) {
          pending.then(() => {
            let landed = false
            try {
              const after = scope.getSnapshot()
              landed = !!(after && after.status === 'ready' && isPlainObject(after.user) && Object.keys(after.user).length > 0)
            } catch (err) { landed = false }
            if (!landed) return
            try { saveJSON(MIGRATED_KEY, 1) } catch (err) { /* 忽略 */ }
          }).catch(() => { /* 写失败：不落标记，下次重试 */ })
        }
        store.push({})
        return
      }
      // 本地就是默认值：Host 为空与本地等价，直接标记为已处理
      saveJSON(MIGRATED_KEY, 1)
    } else if (!claimed) {
      // **这个标记也要在这一条路径上写**：只在上一条分支里写的话，"首次 bind 时 Host 已非空" （第二个浏览器 / 手写过 settings.yaml）就永远不落标记，此后 Host 一旦变空，
      // 本浏览器会把 **过期**的本地镜像重新迁回 Host，静默复活旧配置。
      saveJSON(MIGRATED_KEY, 1)
    }
    const next = sectionToCfg(snap.value)
    runtimeCfg = saveCfg(next) // localStorage 保持为镜像：Host 掉线时仍能工作
    // **语言也必须在这条路径上落地**：Host 是优先源而 `loadCfg` 读的是 localStorage 镜像，这条路径上 runtimeCfg 已是 Host 的值，界面却仍停在启动时的语言，且不会自愈（sync 是"值没变就不重算"的幂等路径）。
    if (getLanguage() !== runtimeCfg.language) {
      setLanguage(runtimeCfg.language)
      syncDerivedTextAfterLanguageChange()
    }
    store.push({})
  }
  let disposer = null
  try { disposer = scope.subscribe(sync) } catch (err) { /* 订阅失败只是失去实时同步 */ }
  sync()
  // 返回解除函数：调用方要把它注册进 ctx.effect，否则同一页面内停用 → 启用 N 次会累积 N 个订阅。
  return () => {
    try { if (typeof disposer === 'function') disposer() } catch (err) { /* 忽略 */ }
    if (settingsScope === scope) settingsScope = null
  }
}


const settingsState = () => ({ sync: settingsSync, bound: settingsScope !== null, runtime: runtimeCfg })
const resetSettings = () => { runtimeCfg = null; settingsScope = null; settingsSync = 'local' }

export { SETTINGS_NS, MIGRATED_KEY, cfgToSection, sectionToCfg, currentCfg, applyCfg, settingsOpsFor, pushCfgToHost, bindSettingsScope, settingsSync, settingsState, resetSettings, reloadFromLocal }
