// ============================================================================
// dsh-quake-alert · client/src/15-entry.js
//
// 作用：插件入口——apply 与单测钩子。
// 内容：音效解锁监听、跨标签页通道、settings 绑定、市区町村表拉取、WebSocket 启停、
//       设置页与状态指示两个 slot 的注册、exports.__test 导出面。
// 依赖：全部前置文件。
// 生命周期：所有副作用都包在 ctx.effect 内，插件停用即回收。
// ============================================================================

import { h, HISTORY_MAX, PREFECTURES, DEFAULT_CFG, STORAGE_KEY, EMSC_WS_URL, normalizePref, prefOfCode, prefCodeOf, p2pTimeToIso, issuedToDate, formatIssuedLocal, P2P_TIME_RE } from './01-constants.js'
import { loadCfg, normalizeCfg, normalizePlaces, loadHistory, normalizeHistoryEntry, inQuietHours } from './02-storage.js'
import { SETTINGS_NS, MIGRATED_KEY, cfgToSection, sectionToCfg, currentCfg, applyCfg, settingsOpsFor, bindSettingsScope, settingsState, resetSettings, reloadFromLocal } from './03-settings-bridge.js'
import { setCityTable, citiesOfPref, prefsOfCity, canonicalCityOf, normKana, setRiverAreas, riverAreaCities, cityAliases, lookupAddrCity, buildAddrIndex, pruneUnknownCities, loadCityTable, abortCityTableLoad, cityTableState, resetCityTable } from './04-city-table.js'
import { parse, parseQuake, parseEew, parseTsunami, prefsOfArea, regionsOfArea, AREA_PREF, sevColor } from './05-parser.js'
import { parseJma, buildTestTelegram, TEST_SCENARIOS, maxLevelIn as jmaMaxLevelIn, itemsOf as jmaItemsOf } from './05b-jma-parser.js'
import { parseEmsc, parseUsgsFeature, parseUsgsFeed, parseNoaaCap, severityOfMagnitude, geoEventKey, TEST_GEO_SCENARIOS, buildTestGlobalMessage, parseTestGlobalMessage } from './05c-global-parsers.js'
import { parseEpspResult, parseEmscResult, parseUsgsResult, parseNoaaResult, parseJmaResult, failResult, SOURCE_CONTRACTS, noteParseResult, noteSourceSuccess, retrySource, sourceHealthOf, effectiveStatusOf, resetSourceHealth } from './05d-source-contracts.js'
import { matchAlert, matchPointAlert, distanceKm, validGeo } from './06-matcher.js'
import { store, addEvent } from './07-store.js'
import { unlockAudio, playSound, soundKindOf, audioState } from './08-audio.js'
import { isDuplicate, isEventRepeat, isStrengthUpgrade, forgetEvent, claimAlertForTab, cancelKeyOf, ensureAlertChannel, closeAlertChannel, broadcastHistoryCleared } from './10-dedupe.js'
import { handleRaw, handleCancelled, handleAlert, updateWeatherHint, alertTitleOf, watchlessPoint, hitSeverityOf } from './11-pipeline.js'
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

  // 跨标签页去重通道：必须在插件加载时就开始监听，否则会错过其它标签页的广播。
  // 0.4.1 把它连同关闭一起放进 effect：原来 ensure 在外、close 在内，两代 fiber 会共享
  // 同一条通道，停用 → 启用时旧 fiber 的 close 会把新 fiber 依赖的通道关掉。
  // effect 体在 apply 时**同步执行**，所以"加载时就建立"的语义没有变。
  ctx.effect(() => {
    ensureAlertChannel()
    return () => { closeAlertChannel() }
  }, 'dsh-quake-alert: tab channel')

  // 插件（重新）装载时清空上一代的源状态：clearSources 此前定义了却没有任何调用点，
  // 与它自己的注释"插件停用 / 重建时把源清空"不符，残留状态会把新会话显示成"已连接"。
  store.clearSources()

  // 机器级持久化：settings 服务可用时，配置交给 DSH 的 settings.yaml（Host 侧同名 namespace）。
  // 服务缺席（或页面非 loopback）时保持 localStorage 路径，插件照常工作。
  if (typeof ctx.inject === 'function') {
    ctx.inject(['settingsScope'], (settingsCtx) => {
      let unbind = null
      try {
        unbind = bindSettingsScope(settingsCtx.settingsScope.bind({ namespace: SETTINGS_NS }))
      } catch (err) { /* bind 失败 → 继续用 localStorage */ }
      // 订阅必须随 fiber 释放（0.4.1）：否则同一页面内停用 → 启用 N 次会累积 N 个订阅，
      // 此后 Host 的每一次配置变更都会触发 N 次写盘与 N 次重渲。
      if (typeof unbind === 'function' && typeof ctx.effect === 'function') {
        ctx.effect(() => () => { try { unbind() } catch (err) { /* 忽略 */ } }, 'dsh-quake-alert: settings unbind')
      }
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
  //
  // onRaw 走解析契约（0.4.1）：结构不符 / 值不可能 → 计入数据健康并**不播报**（蓝点），
  // 与本插件无关的消息（其他 code）判为 empty、静静跳过。
  const client = createWsClient({
    onRaw: (raw, cfg) => {
      const res = parseEpspResult(raw)
      if (noteParseResult('p2pquake', res)) return
      if (!res.ok) return
      noteSourceSuccess('p2pquake')
      handleAlert(res.alert, cfg)
    },
  })
  setActiveClient(client)
  ctx.effect(() => {
    client.start()
    return () => {
      try { client.stop() } catch (err) {}
      // 置空：否则设置页里那个 80ms 后触发的 restart()（切换数据源）还能复活一个
      // 已经没有任何 fiber 归属的 socket，它会继续上报状态并（经 handleAlert）响铃。
      setActiveClient(null)
    }
  }, 'dsh-quake-alert: ws client')

  /** 轮询源的状态上报：把每个源的连接 / 失败情况送进 store，参与整体状态聚合（0.4.1）。 */
  const feedStatus = (sourceId) => (patch) => store.pushSource(sourceId, patch)
  const feedError = (name) => (err) => {
    try { console.warn('[dsh-quake-alert] ' + name + ' 增量拉取失败：' + String((err && err.message) || err)) } catch (e) {}
  }

  // 気象庁电文增量（0.3.0）：Host 侧负责轮询与去重，这里只拉本地增量并交给主链。
  const feed = createFeedClient({
    id: 'jma',
    label: '気象庁',
    onStatus: feedStatus('jma'),
    onError: feedError('jma'),
  })
  // 全球地震（USGS，0.4.0）：Host 轮询 GeoJSON（单级），Client 只拉本地增量。
  // 与 EMSC 是互补关系——EMSC 是实时推送，USGS 目录更完整、还带修订版（updated 刷新）。
  // 两者的同类地震靠 geoEventKey 归并，不会重复提醒。
  const usgsFeed = createFeedClient({
    id: 'usgs',
    label: 'USGS',
    path: FEED_PATH + '?source=usgs',
    cursorKey: FEED_CURSOR_KEY + '.usgs',
    enabled: (cfg) => (cfg.disasters || {}).earthquake !== false,
    onStatus: feedStatus('usgs'),
    onError: feedError('usgs'),
    apply: (entry, cfg) => {
      let feature
      try { feature = JSON.parse(entry && entry.xml) } catch (err) {
        noteParseResult('usgs', failResult('schema', 'Host 载荷不是合法 JSON'))
        return false
      }
      const res = parseUsgsResult(feature)
      if (noteParseResult('usgs', res)) return false
      if (!res.ok) return false
      noteSourceSuccess('usgs')
      handleAlert(res.alert, cfg)
      return true
    },
  })
  // 海啸（NOAA，0.4.0）：Host 拉事件列表再取 CAP 详情，Client 解析 CAP。
  const noaaFeed = createFeedClient({
    id: 'noaa',
    label: 'NOAA',
    path: FEED_PATH + '?source=noaa',
    cursorKey: FEED_CURSOR_KEY + '.noaa',
    intervalMs: 5 * 60 * 1000,
    enabled: (cfg) => (cfg.disasters || {}).tsunami !== false,
    onStatus: feedStatus('noaa'),
    onError: feedError('noaa'),
    apply: (entry, cfg) => {
      const res = parseNoaaResult(entry && entry.xml, { id: entry && entry.id })
      if (noteParseResult('noaa', res)) return false
      if (!res.ok) return false
      noteSourceSuccess('noaa')
      handleAlert(res.alert, cfg)
      return true
    },
  })
  const feeds = [feed, usgsFeed, noaaFeed]
  ctx.effect(() => {
    for (const f of feeds) f.start()
    return () => { for (const f of feeds) { try { f.stop() } catch (err) {} } }
  }, 'dsh-quake-alert: feed clients')

  // 全球地震（0.4.0）：EMSC 的 WebSocket，复用与 P2PQuake 同一套连接管理（退避、建连看门狗、
  // 生命周期归还 fiber）。「久无数据」判据从 0（关闭）改为 3 小时（0.4.1 修正）：
  // 关掉之后就没有任何半开检测了——半开正是"没有 onclose"，而建连看门狗在 onopen 之后
  // 就被撤销，连接可以永久停在绿色上（用户以为在被保护），与 DESIGN 5.1「两种静默失效
  // 必须主动检测」冲突。3 小时远大于正常推送间隔（全球 M4+ 平均约 30 分钟一条，不会误判），
  // 又能兜住真正的半开；页面从冻结中恢复时会重置计时（见 12-websocket 的 visibilitychange）。
  const emsc = createWsClient({
    sourceId: 'emsc',
    label: 'EMSC',
    urlOf: () => EMSC_WS_URL,
    staleAfterMs: 3 * 60 * 60 * 1000,
    openDetail: () => '已连接 EMSC（全球地震实时推送）',
    onRaw: (raw, cfg) => {
      const res = parseEmscResult(raw)
      if (noteParseResult('emsc', res)) return
      if (!res.ok) return
      noteSourceSuccess('emsc')
      handleAlert(res.alert, cfg)
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
export const __test = { parse, parseQuake, parseEew, parseTsunami, parseJma, parseEmsc, parseUsgsFeature, parseUsgsFeed, parseNoaaCap, severityOfMagnitude, geoEventKey, TEST_GEO_SCENARIOS, buildTestGlobalMessage, parseTestGlobalMessage, feedStatsOf, watchlessPoint, buildTestTelegram, TEST_SCENARIOS, jmaMaxLevelIn, jmaItemsOf, matchAlert, matchPointAlert, distanceKm, validGeo, normalizePlaces, soundKindOf, playSound, sevColor, p2pCodeTextOf, kindColorOf, alertTitleOf, prefsOfArea, regionsOfArea, AREA_PREF, loadCfg, normalizeCfg, loadHistory, normalizeHistoryEntry, addEvent, handleRaw, handleCancelled, handleAlert, updateWeatherHint, hitSeverityOf, createFeedClient, FEED_PATH, FEED_POLL_MS, FEED_CURSOR_KEY, FEED_TAIL, inQuietHours, isDuplicate, isEventRepeat, isStrengthUpgrade, forgetEvent, claimAlertForTab, cancelKeyOf, ensureAlertChannel, broadcastHistoryCleared, createWsClient, store, HISTORY_MAX, PREFECTURES, DEFAULT_CFG, currentCfg, applyCfg, reloadFromLocal, bindSettingsScope, settingsOpsFor, cfgToSection, sectionToCfg, SETTINGS_NS, settingsState, resetSettings, setCityTable, citiesOfPref, prefsOfCity, canonicalCityOf, normKana, setRiverAreas, riverAreaCities, cityAliases, lookupAddrCity, buildAddrIndex, normalizePref, prefOfCode, prefCodeOf, pruneUnknownCities, loadCityTable, abortCityTableLoad, cityTableState: () => cityTableState, resetCityTable, p2pTimeToIso, issuedToDate, formatIssuedLocal, audioState, SOURCE_CONTRACTS, parseEpspResult, parseEmscResult, parseUsgsResult, parseNoaaResult, parseJmaResult, failResult, noteParseResult, noteSourceSuccess, retrySource, sourceHealthOf, effectiveStatusOf, resetSourceHealth, P2P_TIME_RE, MIGRATED_KEY }

// activeClient 是 12-websocket 的模块级 let：给 12 用的赋值出口（跨模块不能写 imported binding）
// 由 12-websocket 提供 setter；这里仅保留引用以便阅读
