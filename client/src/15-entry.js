// ============================================================================
// dsh-quake-alert · client/src/15-entry.js
//
// 作用：插件入口——apply 与单测钩子。
// 内容：音效解锁监听、跨标签页通道、settings 绑定、市区町村表拉取、WebSocket 启停、
//       设置页与状态指示两个 slot 的注册、exports.__test 导出面。
// 依赖：全部前置文件。
// 生命周期：所有副作用都包在 ctx.effect 内，插件停用即回收。
// ============================================================================

import { h, HISTORY_MAX, PREFECTURES, DEFAULT_CFG, STORAGE_KEY, EMSC_WS_URL, normalizePref, prefOfCode, prefCodeOf } from './01-constants.js'
import { loadCfg, normalizeCfg, normalizePlaces, loadHistory, normalizeHistoryEntry, inQuietHours } from './02-storage.js'
import { SETTINGS_NS, cfgToSection, sectionToCfg, currentCfg, applyCfg, settingsOpsFor, bindSettingsScope, settingsState, resetSettings, reloadFromLocal } from './03-settings-bridge.js'
import { setCityTable, citiesOfPref, prefsOfCity, canonicalCityOf, normKana, setRiverAreas, riverAreaCities, cityAliases, lookupAddrCity, buildAddrIndex, pruneUnknownCities, loadCityTable, abortCityTableLoad, cityTableState, resetCityTable } from './04-city-table.js'
import { parse, parseQuake, parseEew, parseTsunami, prefsOfArea, regionsOfArea, AREA_PREF, sevColor } from './05-parser.js'
import { parseJma, buildTestTelegram, TEST_SCENARIOS, maxLevelIn as jmaMaxLevelIn, itemsOf as jmaItemsOf } from './05b-jma-parser.js'
import { parseEmsc, parseUsgsFeature, parseUsgsFeed, parseNoaaCap, severityOfMagnitude, geoEventKey, TEST_GEO_SCENARIOS, buildTestGlobalMessage, parseTestGlobalMessage } from './05c-global-parsers.js'
import { matchAlert, matchPointAlert, distanceKm, validGeo } from './06-matcher.js'
import { store, addEvent } from './07-store.js'
import { unlockAudio, playSound, soundKindOf } from './08-audio.js'
import { isDuplicate, isEventRepeat, claimAlertForTab, ensureAlertChannel, closeAlertChannel } from './10-dedupe.js'
import { handleRaw, handleCancelled, handleAlert, updateWeatherHint, alertTitleOf, watchlessPoint } from './11-pipeline.js'
import { createWsClient, setActiveClient } from './12-websocket.js'
import { createFeedClient, feedStatsOf, FEED_PATH, FEED_POLL_MS, FEED_CURSOR_KEY, FEED_TAIL } from './12b-feed-poll.js'
import { SettingsPanel, p2pCodeTextOf, kindColorOf } from './13-ui-settings.js'
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

  // 跨标签页配置同步（0.3.2）：storage 事件只在「别的标签页写入」时触发。监听必须常驻——
  // 原先写在设置页组件里，于是没打开设置页的标签页不会跟随，会一直按旧配置提醒。
  // 回读走 03 的显式入口（跨模块不能直接给它的模块私有 runtimeCfg 赋值），再 store.push()
  // 让设置页与状态指示一起刷新。
  ctx.effect(() => {
    const onStorage = (e) => {
      if (!e || e.key === null || e.key === STORAGE_KEY) {
        reloadFromLocal()
        store.push({})
      }
    }
    window.addEventListener('storage', onStorage)
    return () => window.removeEventListener('storage', onStorage)
  }, 'dsh-quake-alert: cross-tab config')

  // 市区町村表：Host 路由提供，拉一次缓存。失败只影响市级细化，不影响任何提醒。
  // 放进 effect：拉取是异步的，若插件在飞行中被停用，要中止请求并停止写 store / 配置。
  ctx.effect(() => {
    loadCityTable()
    return () => { try { abortCityTableLoad() } catch (err) {} }
  }, 'dsh-quake-alert: city table')

  // WebSocket 常驻连接（与设置页是否打开无关）。
  // start() 必须写在 effect 内：若同一 apply 后面的注册抛错，连接也要随 fiber 一起收掉，
  // 否则会留下一条没有清理器的 socket，直到用户刷新页面。
  const client = createWsClient()
  setActiveClient(client)
  ctx.effect(() => {
    client.start()
    return () => { try { client.stop() } catch (err) {} }
  }, 'dsh-quake-alert: ws client')

  // 気象庁电文增量（0.3.0）：Host 侧负责轮询与去重，这里只拉本地增量并交给主链。
  const feed = createFeedClient()
  // 全球地震（USGS，0.4.0）：Host 轮询 GeoJSON（单级），Client 只拉本地增量。
  // 与 EMSC 是互补关系——EMSC 是实时推送，USGS 目录更完整、还带修订版（updated 刷新）。
  // 两者的同类地震靠 geoEventKey 归并，不会重复提醒。
  const usgsFeed = createFeedClient({
    id: 'usgs',
    path: FEED_PATH + '?source=usgs',
    cursorKey: FEED_CURSOR_KEY + '.usgs',
    enabled: (cfg) => (cfg.disasters || {}).earthquake !== false,
    apply: (entry, cfg) => {
      let feature
      try { feature = JSON.parse(entry && entry.xml) } catch (err) { return false }
      const alert = parseUsgsFeature(feature)
      if (!alert) return false
      handleAlert(alert, cfg)
      return true
    },
  })
  // 海啸（NOAA，0.4.0）：Host 拉事件列表再取 CAP 详情，Client 解析 CAP。
  const noaaFeed = createFeedClient({
    id: 'noaa',
    path: FEED_PATH + '?source=noaa',
    cursorKey: FEED_CURSOR_KEY + '.noaa',
    intervalMs: 5 * 60 * 1000,
    enabled: (cfg) => (cfg.disasters || {}).tsunami !== false,
    apply: (entry, cfg) => {
      const alert = parseNoaaCap(entry && entry.xml, { id: entry && entry.id })
      if (!alert) return false
      handleAlert(alert, cfg)
      return true
    },
  })
  const feeds = [feed, usgsFeed, noaaFeed]
  ctx.effect(() => {
    for (const f of feeds) f.start()
    return () => { for (const f of feeds) { try { f.stop() } catch (err) {} } }
  }, 'dsh-quake-alert: feed clients')

  // 全球地震（0.4.0）：EMSC 的 WebSocket，复用与 P2PQuake 同一套连接管理（退避、建连看门狗、
  // 生命周期归还 fiber）。但**关掉「久无数据」检测**（staleAfterMs=0）：全球 M4+ 大约每 30 分钟
  // 才有一次推送，拿消息间隔判断连接死活会把一条完全正常的连接反复掐断重连。真正的断开
  // 浏览器会给 onclose，建连看门狗也仍然生效，所以这两种静默失效并没有被放过。
  const emsc = createWsClient({
    sourceId: 'emsc',
    label: 'EMSC',
    urlOf: () => EMSC_WS_URL,
    staleAfterMs: 0,
    openDetail: () => '已连接 EMSC（全球地震实时推送）',
    onRaw: (raw, cfg) => {
      const alert = parseEmsc(raw)
      if (alert) handleAlert(alert, cfg)
    },
  })
  ctx.effect(() => {
    emsc.start()
    return () => { try { emsc.stop() } catch (err) {} }
  }, 'dsh-quake-alert: EMSC ws client')

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
export const __test = { parse, parseQuake, parseEew, parseTsunami, parseJma, parseEmsc, parseUsgsFeature, parseUsgsFeed, parseNoaaCap, severityOfMagnitude, geoEventKey, TEST_GEO_SCENARIOS, buildTestGlobalMessage, parseTestGlobalMessage, feedStatsOf, watchlessPoint, buildTestTelegram, TEST_SCENARIOS, jmaMaxLevelIn, jmaItemsOf, matchAlert, matchPointAlert, distanceKm, validGeo, normalizePlaces, soundKindOf, playSound, sevColor, p2pCodeTextOf, kindColorOf, alertTitleOf, prefsOfArea, regionsOfArea, AREA_PREF, loadCfg, normalizeCfg, loadHistory, normalizeHistoryEntry, addEvent, handleRaw, handleCancelled, handleAlert, updateWeatherHint, createFeedClient, FEED_PATH, FEED_POLL_MS, FEED_CURSOR_KEY, FEED_TAIL, inQuietHours, isDuplicate, isEventRepeat, claimAlertForTab, ensureAlertChannel, createWsClient, store, HISTORY_MAX, PREFECTURES, DEFAULT_CFG, currentCfg, applyCfg, reloadFromLocal, bindSettingsScope, settingsOpsFor, cfgToSection, sectionToCfg, SETTINGS_NS, settingsState, resetSettings, setCityTable, citiesOfPref, prefsOfCity, canonicalCityOf, normKana, setRiverAreas, riverAreaCities, cityAliases, lookupAddrCity, buildAddrIndex, normalizePref, prefOfCode, prefCodeOf, pruneUnknownCities, loadCityTable, abortCityTableLoad, cityTableState: () => cityTableState, resetCityTable }

// activeClient 是 12-websocket 的模块级 let：给 12 用的赋值出口（跨模块不能写 imported binding）
// 由 12-websocket 提供 setter；这里仅保留引用以便阅读
