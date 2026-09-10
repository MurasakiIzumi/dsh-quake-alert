// ============================================================================
// dsh-quake-alert · client/src/03-settings-bridge.js
//
// 作用：机器级持久化桥——把配置交给 DSH 的 Host settings（settings.yaml）。
// 内容：内存镜像 currentCfg、写入入口 applyCfg、差异计算 settingsOpsFor、
//       异步推送 pushCfgToHost、首次迁移与降级 bindSettingsScope，
//       以及 Host section ⇄ 本地配置的转换（cfgToSection / sectionToCfg）。
// 依赖：01-constants、02-storage（07-store 的 store.push 在运行时才用到）。
// 降级：没有 settings 服务 / 页面非 loopback / Host 不持久化时自动退回 localStorage。
// ============================================================================

import { DEFAULT_CFG } from './01-constants.js'
import { isPlainObject, normalizeCfg, loadCfg, saveCfg, freshCfg } from './02-storage.js'
import { store } from './07-store.js'

// ---------- 机器级持久化（0.2.0）：Host settings 为主，localStorage 为回退与镜像 ----------
// Host 半边注册了同名 namespace（lib/index.js 的 QuakeAlertSettingsSchema）。Client 经
// `ctx.settingsScope.bind({ namespace })` 读写它：scope 快照是**同步**可读的，所以内部读取
// （WebSocket 重连、handleRaw）仍然同步；写入先更新内存与 localStorage 镜像，再异步推给
// Host。没有 settings 服务、页面非 loopback、或 Host 只做进程内存储时，整条链路自动退化为
// M1 的 localStorage 行为。
const SETTINGS_NS = 'quake-alert'
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
  return normalizeCfg(Object.assign({ version: DEFAULT_CFG.version }, isPlainObject(section) ? section : {}))
}
// 同步读取入口：保持 M1 的同步语义，调用方无需感知 Host 的存在
function currentCfg() {
  if (runtimeCfg === null) runtimeCfg = loadCfg()
  return runtimeCfg
}
// 写入入口：内存立即生效 → localStorage 镜像 → Host（可用时异步持久化）
function applyCfg(cfg) {
  runtimeCfg = saveCfg(cfg)
  pushCfgToHost(runtimeCfg)
  return runtimeCfg
}
// 只提交与默认值不同的字段；等于默认值的字段用 unset 交还 schema 默认层，
// 这样 settings.yaml 里只留下用户真正改过的东西。
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
function pushCfgToHost(cfg) {
  const scope = settingsScope
  if (!scope || settingsSync !== 'host') return
  try {
    const snap = scope.getSnapshot()
    if (!snap || snap.status !== 'ready' || snap.writable !== true || snap.mode !== 'host') return
    const ops = settingsOpsFor(cfg)
    if (ops.length === 0) return
    const pending = scope.mutate(ops)
    if (pending && typeof pending.catch === 'function') pending.catch(() => { /* 写失败不回滚本地 */ })
  } catch (err) { /* 通道异常时本地配置仍然生效 */ }
}
// 绑定 Host settings。三种来源的优先关系：
//   ① Host 用户层已有内容 → 以 Host 为准（机器级配置是 source of truth）
//   ② Host 为空、本地已有非默认配置 → 一次性把本地配置迁移到 Host
//   ③ Host 不可用 → 保持 localStorage（settingsSync 停留在 local / memory）
function bindSettingsScope(scope) {
  settingsScope = scope
  let migrated = false
  const sync = () => {
    let snap = null
    try { snap = scope.getSnapshot() } catch (err) { return }
    if (!snap || snap.status !== 'ready' || snap.value === undefined) { settingsSync = 'local'; store.push({}); return }
    if (snap.mode !== 'host' || snap.writable !== true) { settingsSync = 'memory'; store.push({}); return }
    settingsSync = 'host'
    const user = isPlainObject(snap.user) ? snap.user : {}
    if (Object.keys(user).length === 0 && !migrated) {
      migrated = true // 只迁移一次：之后 Host 被清空是用户的显式操作，不该被本地又推回去
      const local = loadCfg()
      if (JSON.stringify(cfgToSection(local)) !== JSON.stringify(cfgToSection(freshCfg()))) {
        runtimeCfg = saveCfg(local)
        pushCfgToHost(runtimeCfg)
        store.push({})
        return
      }
    }
    const next = sectionToCfg(snap.value)
    runtimeCfg = saveCfg(next) // localStorage 保持为镜像：Host 掉线时仍能工作
    store.push({})
  }
  try { scope.subscribe(sync) } catch (err) { /* 订阅失败只是失去实时同步 */ }
  sync()
}


// 供单测钩子与 UI 读取：模块作用域的私有状态不直接对外暴露写入口
const settingsState = () => ({ sync: settingsSync, bound: settingsScope !== null, runtime: runtimeCfg })
const resetSettings = () => { runtimeCfg = null; settingsScope = null; settingsSync = 'local' }

export { SETTINGS_NS, cfgToSection, sectionToCfg, currentCfg, applyCfg, settingsOpsFor, pushCfgToHost, bindSettingsScope, settingsSync, settingsState, resetSettings }
