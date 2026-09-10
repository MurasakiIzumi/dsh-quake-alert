// ============================================================================
// dsh-quake-alert · client/src/15-entry.js
//
// 作用：插件入口——apply 与单测钩子。
// 内容：音效解锁监听、跨标签页通道、settings 绑定、市区町村表拉取、WebSocket 启停、
//       设置页与状态指示两个 slot 的注册、exports.__test 导出面。
// 依赖：全部前置文件。
// 生命周期：所有副作用都包在 ctx.effect 内，插件停用即回收。
// ============================================================================

import { h, HISTORY_MAX, PREFECTURES, DEFAULT_CFG, normalizePref } from './01-constants.js'
import { loadCfg, normalizeCfg, loadHistory, normalizeHistoryEntry, inQuietHours } from './02-storage.js'
import { SETTINGS_NS, cfgToSection, sectionToCfg, currentCfg, applyCfg, settingsOpsFor, bindSettingsScope, settingsState, resetSettings } from './03-settings-bridge.js'
import { setCityTable, citiesOfPref, cityAliases, lookupAddrCity, buildAddrIndex, pruneUnknownCities, loadCityTable, cityTableState, resetCityTable } from './04-city-table.js'
import { parse, parseQuake, parseEew, parseTsunami, prefsOfArea, regionsOfArea, AREA_PREF } from './05-parser.js'
import { matchAlert } from './06-matcher.js'
import { store, addEvent } from './07-store.js'
import { unlockAudio } from './08-audio.js'
import { isDuplicate, isEventRepeat, claimAlertForTab, ensureAlertChannel, closeAlertChannel } from './10-dedupe.js'
import { handleRaw, handleCancelled } from './11-pipeline.js'
import { createWsClient, setActiveClient } from './12-websocket.js'
import { SettingsPanel } from './13-ui-settings.js'
import { StatusIndicator } from './14-ui-status.js'

// ---------- 插件入口 ----------
export const name = 'dsh-quake-alert'
export const inject = ['slots']
export function apply(ctx) {
  // 音效解锁：首次用户手势创建/恢复 AudioContext（自动播放策略标准解法）
  ctx.effect(() => {
    const unlock = () => { try { unlockAudio() } catch (err) {} }
    window.addEventListener('pointerdown', unlock, { passive: true })
    window.addEventListener('keydown', unlock, { passive: true })
    return () => {
      window.removeEventListener('pointerdown', unlock)
      window.removeEventListener('keydown', unlock)
    }
  }, 'dsh-quake-alert: audio unlock')

  // 跨标签页去重通道：必须在插件加载时就开始监听，否则会错过其它标签页的广播
  ensureAlertChannel()
  ctx.effect(() => () => {
    closeAlertChannel()
  }, 'dsh-quake-alert: tab channel')

  // 机器级持久化：settings 服务可用时，配置交给 DSH 的 settings.yaml（Host 侧同名 namespace）。
  // 服务缺席（或页面非 loopback）时保持 localStorage 路径，插件照常工作。
  if (typeof ctx.inject === 'function') {
    ctx.inject(['settingsScope'], (settingsCtx) => {
      try {
        bindSettingsScope(settingsCtx.settingsScope.bind({ namespace: SETTINGS_NS }))
      } catch (err) { /* bind 失败 → 继续用 localStorage */ }
    })
  }

  // 市区町村表：Host 路由提供，拉一次缓存。失败只影响市级细化，不影响任何提醒。
  loadCityTable()

  // WebSocket 常驻连接（与设置页是否打开无关）。
  // start() 必须写在 effect 内：若同一 apply 后面的注册抛错，连接也要随 fiber 一起收掉，
  // 否则会留下一条没有清理器的 socket，直到用户刷新页面。
  const client = createWsClient()
  setActiveClient(client)
  ctx.effect(() => {
    client.start()
    return () => { try { client.stop() } catch (err) {} }
  }, 'dsh-quake-alert: ws client')

  // 设置页：设置 → 灾害预警
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'quake-alert',
    order: 60,
    label: () => '灾害预警',
  }, (props) => h(SettingsPanel, { close: props ? props.close : undefined })))

  // 侧边栏底部状态指示（绿/黄/红圆点，悬停显示详情）
  ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
    name: 'sidebar.footer.action',
    id: 'quake-alert-status',
    order: 50,
    label: () => '灾害预警',
  }, (props) => h(StatusIndicator, props || {})))
}

// 单测钩子（客户端宿主忽略额外导出）
export const __test = { parse, parseQuake, parseEew, parseTsunami, matchAlert, prefsOfArea, regionsOfArea, AREA_PREF, loadCfg, normalizeCfg, loadHistory, normalizeHistoryEntry, addEvent, handleRaw, handleCancelled, inQuietHours, isDuplicate, isEventRepeat, claimAlertForTab, ensureAlertChannel, createWsClient, store, HISTORY_MAX, PREFECTURES, DEFAULT_CFG, currentCfg, applyCfg, bindSettingsScope, settingsOpsFor, cfgToSection, sectionToCfg, SETTINGS_NS, settingsState, resetSettings, setCityTable, citiesOfPref, cityAliases, lookupAddrCity, buildAddrIndex, normalizePref, pruneUnknownCities, loadCityTable, cityTableState: () => cityTableState, resetCityTable }

// activeClient 是 12-websocket 的模块级 let：给 12 用的赋值出口（跨模块不能写 imported binding）
// 由 12-websocket 提供 setter；这里仅保留引用以便阅读
