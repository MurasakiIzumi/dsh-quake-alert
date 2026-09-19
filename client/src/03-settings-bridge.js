// ============================================================================
// dsh-quake-alert · client/src/03-settings-bridge.js
//
// 作用：机器级持久化桥——把配置交给 DSH 的 Host settings（settings.yaml）。
// 内容：内存镜像 currentCfg、写入入口 applyCfg、差异计算 settingsOpsFor、
//       异步推送 pushCfgToHost、首次迁移与降级 bindSettingsScope、
//       本地镜像回读 reloadFromLocal（其它标签页改配置后），
//       以及 Host section ⇄ 本地配置的转换（cfgToSection / sectionToCfg）。
// 依赖：01-constants、02-storage（07-store 的 store.push 在运行时才用到）。
// 降级：没有 settings 服务 / 页面非 loopback / Host 不持久化时自动退回 localStorage。
// ============================================================================

import { DEFAULT_CFG } from './01-constants.js'
import { isPlainObject, normalizeCfg, loadCfg, saveCfg, freshCfg, loadJSON, saveJSON } from './02-storage.js'
import { store } from './07-store.js'

// ---------- 机器级持久化（0.2.0）：Host settings 为主，localStorage 为回退与镜像 ----------
// Host 半边注册了同名 namespace（lib/index.js 的 QuakeAlertSettingsSchema）。Client 经
// `ctx.settingsScope.bind({ namespace })` 读写它：scope 快照是**同步**可读的，所以内部读取
// （WebSocket 重连、handleRaw）仍然同步；写入先更新内存与 localStorage 镜像，再异步推给
// Host。没有 settings 服务、页面非 loopback、或 Host 只做进程内存储时，整条链路自动退化为
// M1 的 localStorage 行为。
const SETTINGS_NS = 'quake-alert'
/** 「本地配置已迁移到 Host」的落盘标记：迁移只能发生一次，见 bindSettingsScope。 */
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
  return normalizeCfg(Object.assign({ version: DEFAULT_CFG.version }, isPlainObject(section) ? section : {}))
}
// 同步读取入口：保持 M1 的同步语义，调用方无需感知 Host 的存在
function currentCfg() {
  if (runtimeCfg === null) runtimeCfg = loadCfg()
  return runtimeCfg
}
// 本地镜像被**其它 DSH 标签页**改写后（storage 事件），把 localStorage 重新读回内存副本。
// 跨模块不能直接给本模块私有的 runtimeCfg 赋值：拆分前它同处一个作用域，拆分后就成了
// 自由变量，打包进 'use strict' 的 bundle 会抛 ReferenceError（0.2.1 拆分时漏改过一处），
// 所以这里给出显式入口。
function reloadFromLocal() {
  runtimeCfg = loadCfg()
  return runtimeCfg
}
// 写入入口：内存立即生效 → localStorage 镜像 → Host（可用时异步持久化）
function applyCfg(cfg) {
  // 写入路径也归一（0.4.1）：此前只有读取路径（loadCfg / sectionToCfg）归一，于是
  // 「坐标相同的关注点自动合并」「name 截断到 30 字」这类不变量在内存与 localStorage 里
  // 都不成立——同一次会话里重复添加同一个点会真的存两份，直到下次加载才被悄悄合并。
  runtimeCfg = saveCfg(normalizeCfg(cfg))
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
/**
 * 把配置推给 Host。返回 `scope.mutate()` 的 pending（没有真正发出写请求时返回 null），
 * 调用方据此判断"Host 是否确认接收"——迁移标记要靠它，见 bindSettingsScope。
 */
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
// 绑定 Host settings。三种来源的优先关系：
//   ① Host 用户层已有内容 → 以 Host 为准（机器级配置是 source of truth）
//   ② Host 为空、本地已有非默认配置 → 一次性把本地配置迁移到 Host
//   ③ Host 不可用 → 保持 localStorage（settingsSync 停留在 local / memory）
/**
 * 迁移的尝试上限（0.5.4）。Host 持续拒绝写入时（revision 冲突等），不设上限会变成
 * "每来一次 sync 就写一次"的循环；用尽之后保留本地镜像、交由用户下一次改配置时经
 * `applyCfg` 直接写入 Host。
 */
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
      // 迁移**只能发生一次**，而且这个"一次"必须落盘（0.4.1 修正）。原来只在本次 bind 里记
      // 一个局部标志，于是每次重载页面 / Host settings 重建都会重新判断，结果是"用户显式清空
      // Host"会被本地镜像静默恢复——Host 作为 source of truth 的优先级被本地反超
      // （实测可复现：清空 Host 后重新 bind，Host 又变回 {quakeScale:55}）。
      const local = loadCfg()
      if (JSON.stringify(cfgToSection(local)) !== JSON.stringify(cfgToSection(freshCfg()))) {
        if (migrateAttempts >= MIGRATE_MAX_ATTEMPTS) {
          // 重试用尽：**不落标记、也不用 Host 的空值覆盖本地镜像**——那等于把用户配置丢掉。
          // 本地镜像保持原样，用户下一次改配置会经 applyCfg 直接写进 Host。
          store.push({})
          return
        }
        migrateAttempts += 1
        runtimeCfg = saveCfg(local)
        const pending = pushCfgToHost(runtimeCfg)
        // **等 Host 真的接收之后再落"已认领"标记**。两点都不能省（0.5.4）：
        //  ① 先落标记再写的话，写入失败（磁盘 / 权限 / 瞬时冲突）会让本地配置既没进 Host、
        //     又因为标记而不再重试，随后被 Host 的空值覆盖——永久且静默地丢配置；
        //  ② **不能把 `pending` 的 resolve 当成功**：平台的 mutate 在 Host 拒绝时（`!response.ok`）
        //     也是 resolve（它内部 recover 并重新推送）。所以 settle 之后回读一次：迁移的字段
        //     确实出现在 Host 用户层里，才算迁移完成；否则不落标记，下一次 sync 重试。
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
      // 本地就是默认值：Host 为空与本地等价，直接认领
      saveJSON(MIGRATED_KEY, 1)
    } else if (!claimed) {
      // 走到这里说明"以 Host 为准"（Host 用户层已有内容）。**认领标记也必须在这一条路径上落**
      // （0.5.4）：此前它只在"Host 为空 + 本地非默认"那条分支里写，于是"首次 bind 时 Host 已非空"
      //（第二个浏览器 / 另一台配置 / 手写过 settings.yaml——settings.yaml 是机器级共享的）
      // 永远不落标记。此后 Host 一旦变空（用户在别处恢复默认），本浏览器会把**过期**的本地镜像
      // 重新迁回 Host，静默复活旧配置。实测：fresh localStorage + Host 非空 → 标记未落；
      // 再把 Host 置空 → 本地旧值被写回 Host。
      saveJSON(MIGRATED_KEY, 1)
    }
    const next = sectionToCfg(snap.value)
    runtimeCfg = saveCfg(next) // localStorage 保持为镜像：Host 掉线时仍能工作
    store.push({})
  }
  let disposer = null
  try { disposer = scope.subscribe(sync) } catch (err) { /* 订阅失败只是失去实时同步 */ }
  sync()
  // 返回解除函数（0.4.1）：调用方要把它注册进 ctx.effect，否则同一页面内停用 → 启用 N 次
  // 会累积 N 个订阅，此后 Host 每一次配置变更都会触发 N 次写盘与 N 次重渲。
  return () => {
    try { if (typeof disposer === 'function') disposer() } catch (err) { /* 忽略 */ }
    if (settingsScope === scope) settingsScope = null
  }
}


// 供单测钩子与 UI 读取：模块作用域的私有状态不直接对外暴露写入口
const settingsState = () => ({ sync: settingsSync, bound: settingsScope !== null, runtime: runtimeCfg })
const resetSettings = () => { runtimeCfg = null; settingsScope = null; settingsSync = 'local' }

export { SETTINGS_NS, MIGRATED_KEY, cfgToSection, sectionToCfg, currentCfg, applyCfg, settingsOpsFor, pushCfgToHost, bindSettingsScope, settingsSync, settingsState, resetSettings, reloadFromLocal }
