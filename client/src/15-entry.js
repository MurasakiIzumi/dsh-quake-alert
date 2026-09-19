// ============================================================================
// dsh-quake-alert · client/src/15-entry.js
//
// 作用：插件入口——apply 与单测钩子。
// 内容：音效解锁监听、跨标签页通道、settings 绑定、市区町村表拉取、WebSocket 启停、
//       设置页与状态指示两个 slot 的注册、exports.__test 导出面。
// 依赖：全部前置文件。
// 生命周期：所有副作用都包在 ctx.effect 内，插件停用即回收。
// ============================================================================

import { h, HISTORY_MAX, PREFECTURES, DEFAULT_CFG, STORAGE_KEY, EMSC_WS_URL, normalizePref, prefOfCode, prefCodeOf, p2pTimeToIso, cnTimeToIso, CN_TIME_RE, CN_REPORT_MAG_OPTIONS, RADIUS_PRESETS, DEFAULT_PLACE_RADIUS_KM, MIN_PLACE_RADIUS_KM, MAX_PLACE_RADIUS_KM, issuedToDate, formatIssuedLocal, P2P_TIME_RE } from './01-constants.js'
import { loadCfg, normalizeCfg, normalizePlaces, loadHistory, normalizeHistoryEntry, inQuietHours } from './02-storage.js'
import { SETTINGS_NS, MIGRATED_KEY, cfgToSection, sectionToCfg, currentCfg, applyCfg, settingsOpsFor, bindSettingsScope, settingsState, resetSettings, reloadFromLocal } from './03-settings-bridge.js'
import { setCityTable, citiesOfPref, prefsOfCity, canonicalCityOf, normKana, setRiverAreas, riverAreaCities, cityAliases, lookupAddrCity, buildAddrIndex, pruneUnknownCities, loadCityTable, abortCityTableLoad, cityTableState, resetCityTable, setCnAreas, cnProvinces, cnCitiesOf, cnPlaceOf, cnAreaOf, normAliases } from './04-city-table.js'
import { parse, parseQuake, parseEew, parseTsunami, prefsOfArea, regionsOfArea, AREA_PREF, sevColor } from './05-parser.js'
import { parseJma, buildTestTelegram, TEST_SCENARIOS, maxLevelIn as jmaMaxLevelIn, itemsOf as jmaItemsOf, noticeAreaLevels, applyNoticeLevels, regionKindOf } from './05b-jma-parser.js'
import { parseEmsc, parseUsgsFeature, parseUsgsFeed, parseNoaaCap, severityOfMagnitude, geoEventKey, TEST_GEO_SCENARIOS, buildTestGlobalMessage, parseTestGlobalMessage } from './05c-global-parsers.js'
import { parseEpspResult, parseEmscResult, parseUsgsResult, parseNoaaResult, parseJmaResult, parseCencEewResult, parseCencEqlistItemResult, parseCencEqlistResult, parseNmcAlarmResult, failResult, SOURCE_CONTRACTS } from './05d-source-contracts.js'
// 0.5.3：健康状态（机制层）与契约（约定层）现在是两个模块，调用方分别 import。
import { noteParseResult, noteSourceSuccess, retrySource, sourceHealthOf, effectiveStatusOf, resetSourceHealth, resetConnHealth, pruneHealth, noteFreshness, noteStale, loadHealth, SCHEMA_ESCALATE_COUNT, SCHEMA_ESCALATE_CONSECUTIVE, SCHEMA_ESCALATE_WINDOW_MS, HEALTH_TTL_MS } from './05g-source-health.js'
import { parseCencEew, parseCencEqlist, parseCencEqlistItem, cencEqlistItems, cencEqlistMd5Of } from './05e-cn-parsers.js'
import { parseNmcAlarm, orgOf, NMC_KIND_TEXT, NMC_LEVEL_TEXT, NMC_LEVEL_RANK, NMC_BROADCAST_MIN_RANK } from './05f-nmc-parsers.js'
import { matchAlert, matchPointAlert, matchCnAreaAlert, cnPlaceParts, distanceKm, validGeo } from './06-matcher.js'
import { store, addEvent } from './07-store.js'
import { unlockAudio, playSound, soundKindOf, audioState } from './08-audio.js'
import { isDuplicate, isEventRepeat, isStrengthUpgrade, weakenEvent, forgetEvent, claimAlertForTab, cancelKeyOf, rememberAlerted, wasRecentlyAlerted, ensureAlertChannel, closeAlertChannel, broadcastHistoryCleared } from './10-dedupe.js'
import { handleRaw, handleCancelled, handleAlert, updateWeatherHint, alertTitleOf, watchlessPoint, hitSeverityOf, cnProductName, authorityOf, disclaimerOf } from './11-pipeline.js'
import { createWsClient, setActiveClient } from './12-websocket.js'
import { createFeedClient, feedStatsOf, FEED_PATH, FEED_POLL_MS, FEED_CURSOR_KEY, FEED_TAIL } from './12b-feed-poll.js'
import { createCnStream, cnStreamRegistry, STREAM_PATH, CN_CURSOR_KEY } from './12c-cn-stream.js'
import { createHealthProbe, PROBE_INTERVAL_MS, staleAfterOf } from './12d-health-probe.js'
import { SettingsPanel, p2pCodeTextOf, kindColorOf, SOURCE_ORDER, SOURCE_LABELS, SOURCE_CODE_TEXT, statusMetaOf } from './13-ui-settings.js'
import { StatusIndicator } from './14-ui-status.js'
import { buildDiagSnapshot, copyDiagSnapshot, DIAG_SNAPSHOT_VERSION } from './16-diag.js'

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

  // 插件（重新）装载时清空上一代的**连接**状态：clearSources 此前定义了却没有任何调用点，
  // 与它自己的注释"插件停用 / 重建时把源清空"不符，残留状态会把新会话显示成"已连接"。
  //
  // 0.5.3 起**不再清数据健康**（原先是 resetSourceHealth）：那一层已经落了盘，而它表达的是
  // "上游改了字段、要等插件更新"——这件事与用户刷新页面 / 重新启用插件无关，清掉等于让蓝点
  // 永远没人看见（DESIGN 11.9 A）。连接与新鲜度才是"重启即无意义"的那两层。
  store.clearSources()
  resetConnHealth()

  // 健康探针（0.5.3 / DESIGN 11.9 B）：按**契约里的阈值**判定各源的数据新鲜度，并驱动蓝点的
  // TTL 自愈。把它放进 effect 是因为它有一个定时器——定时器归 fiber，停用即回收。
  // 阈值只从 SOURCE_CONTRACTS 来，这是机制层的全部意义（此前那个字段整个代码库里没人读）。
  ctx.effect(() => {
    const probe = createHealthProbe()
    probe.start()
    return () => { try { probe.stop() } catch (err) { /* 已停 */ } }
  }, 'dsh-quake-alert: health probe')

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
  // 大陆气象灾害（0.5.2）：中央气象台汇总的预警信号（暴雨 + 地质灾害），走 Host 的 `/feed` **轮询**。
  // 为什么不是像 cenc 那样用 SSE：气象预警是"提前数十分钟到数小时发布"的警戒级信息，与 JMA 同一
  // 性质——DESIGN 5.2 的 `/feed` + 15 秒本地拉取本来就是为这类信息设计的，延迟最坏 120+15 秒。
  // 两个灾种各有开关，但**共用一个 Host 源**（同一个端点、同一份响应），所以只要有一个开着就继续拉。
  const nmcFeed = createFeedClient({
    id: 'nmc_alarm',
    label: '中央气象台',
    path: FEED_PATH + '?source=nmc_alarm',
    cursorKey: FEED_CURSOR_KEY + '.nmc_alarm',
    enabled: (cfg) => {
      const d = cfg.disasters || {}
      return d.cnRainstorm !== false || d.cnGeology !== false
    },
    onStatus: feedStatus('nmc_alarm'),
    onError: feedError('nmc_alarm'),
    apply: (entry, cfg) => {
      let raw
      try {
        raw = JSON.parse(entry && entry.xml)
      } catch (err) {
        noteParseResult('nmc_alarm', failResult('schema', 'Host 载荷不是合法 JSON'))
        return false
      }
      const res = parseNmcAlarmResult(raw)
      if (noteParseResult('nmc_alarm', res)) return false
      if (!res.ok) return false
      noteSourceSuccess('nmc_alarm')
      handleAlert(res.alert, cfg)
      return true
    },
  })
  const feeds = [feed, usgsFeed, noaaFeed, nmcFeed]
  ctx.effect(() => {
    for (const f of feeds) f.start()
    return () => { for (const f of feeds) { try { f.stop() } catch (err) {} } }
  }, 'dsh-quake-alert: feed clients')

  // 大陆源（0.5.0）：Wolfx 的 cenc_eew（预警）+ cenc_eqlist（速报），走 Host 的 **SSE 推送**。
  // 为什么不是像上面几行那样用轮询：EEW 的价值在秒级，15 秒一轮等于把预警变成事后通知。
  // 为什么还留降级：某些网络下长连接会被中间设备掐掉，而普通 HTTPS 轮询仍然通（DESIGN 11.5）；
  // 12c 在"能证明这条路走不通"时会自动切到 `?source=` 轮询并把降级状态**说出来**。
  // 两者都跟「地震」开关：预警与速报都是地震，DESIGN 8.4 只给速报单独一个**震级门槛**，不给单独开关。
  const cencApply = (sourceId, parseEntry) => (entry, cfg) => {
    let raw
    try {
      raw = JSON.parse(entry && entry.xml)
    } catch (err) {
      noteParseResult(sourceId, failResult('schema', 'Host 载荷不是合法 JSON'))
      return false
    }
    const res = parseEntry(raw)
    if (noteParseResult(sourceId, res)) return false
    if (!res.ok) return false
    noteSourceSuccess(sourceId)
    handleAlert(res.alert, cfg)
    return true
  }
  const cnEnabled = (cfg) => (cfg.disasters || {}).earthquake !== false
  const cencEew = createCnStream({
    id: 'cenc_eew',
    label: '大陆地震预警',
    enabled: cnEnabled,
    onStatus: feedStatus('cenc_eew'),
    onError: feedError('cenc_eew'),
    apply: cencApply('cenc_eew', parseCencEewResult),
  })
  const cencEqlist = createCnStream({
    id: 'cenc_eqlist',
    label: '大陆地震速报',
    enabled: cnEnabled,
    onStatus: feedStatus('cenc_eqlist'),
    onError: feedError('cenc_eqlist'),
    apply: cencApply('cenc_eqlist', parseCencEqlistItemResult),
  })
  ctx.effect(() => {
    cencEew.start()
    cencEqlist.start()
    return () => { for (const c of [cencEew, cencEqlist]) { try { c.stop() } catch (err) {} } }
  }, 'dsh-quake-alert: cn streams')

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
export const __test = {
  // 0.5.3：机制层（统一健康记录 + 探针 + 升级阈值）
  createHealthProbe, staleAfterOf, PROBE_INTERVAL_MS,
  resetConnHealth, pruneHealth, noteFreshness, noteStale, loadHealth,
  SCHEMA_ESCALATE_COUNT, SCHEMA_ESCALATE_CONSECUTIVE, SCHEMA_ESCALATE_WINDOW_MS, HEALTH_TTL_MS,
  // 0.5.2：大陆气象源（nmc.cn）—— 解析层 / 契约 / 行政区层级匹配
  parseNmcAlarm, orgOf, parseNmcAlarmResult, matchCnAreaAlert, cnPlaceParts, cnAreaOf, normAliases,
  NMC_KIND_TEXT, NMC_LEVEL_TEXT, NMC_LEVEL_RANK, NMC_BROADCAST_MIN_RANK,
  parse, parseQuake, parseEew, parseTsunami, parseJma, parseEmsc, parseUsgsFeature, parseUsgsFeed, parseNoaaCap, severityOfMagnitude, geoEventKey, TEST_GEO_SCENARIOS, buildTestGlobalMessage, parseTestGlobalMessage, feedStatsOf, watchlessPoint, buildTestTelegram, TEST_SCENARIOS, jmaMaxLevelIn, jmaItemsOf, noticeAreaLevels, applyNoticeLevels, regionKindOf, matchAlert, matchPointAlert, distanceKm, validGeo, normalizePlaces, soundKindOf, playSound, sevColor, p2pCodeTextOf, kindColorOf, alertTitleOf, prefsOfArea, regionsOfArea, AREA_PREF, loadCfg, normalizeCfg, loadHistory, normalizeHistoryEntry, addEvent, handleRaw, handleCancelled, handleAlert, updateWeatherHint, hitSeverityOf, createFeedClient, FEED_PATH, FEED_POLL_MS, FEED_CURSOR_KEY, FEED_TAIL, createCnStream, cnStreamRegistry, STREAM_PATH, CN_CURSOR_KEY, cnProductName, authorityOf, disclaimerOf, SOURCE_ORDER, SOURCE_LABELS, SOURCE_CODE_TEXT, SettingsPanel, statusMetaOf, buildDiagSnapshot, copyDiagSnapshot, DIAG_SNAPSHOT_VERSION, inQuietHours, isDuplicate, isEventRepeat, isStrengthUpgrade, weakenEvent, forgetEvent, claimAlertForTab, cancelKeyOf, rememberAlerted, wasRecentlyAlerted, ensureAlertChannel, broadcastHistoryCleared, createWsClient, store, HISTORY_MAX, PREFECTURES, DEFAULT_CFG, currentCfg, applyCfg, reloadFromLocal, bindSettingsScope, settingsOpsFor, cfgToSection, sectionToCfg, SETTINGS_NS, settingsState, resetSettings, setCityTable, citiesOfPref, prefsOfCity, canonicalCityOf, normKana, setRiverAreas, riverAreaCities, cityAliases, lookupAddrCity, buildAddrIndex, normalizePref, prefOfCode, prefCodeOf, pruneUnknownCities, loadCityTable, abortCityTableLoad, cityTableState: () => cityTableState, resetCityTable, setCnAreas, cnProvinces, cnCitiesOf, cnPlaceOf, RADIUS_PRESETS, DEFAULT_PLACE_RADIUS_KM, MIN_PLACE_RADIUS_KM, MAX_PLACE_RADIUS_KM, p2pTimeToIso, cnTimeToIso, CN_TIME_RE, CN_REPORT_MAG_OPTIONS, issuedToDate, formatIssuedLocal, audioState, SOURCE_CONTRACTS, parseEpspResult, parseEmscResult, parseUsgsResult, parseNoaaResult, parseJmaResult, parseCencEewResult, parseCencEqlistItemResult, parseCencEqlistResult, parseCencEew, parseCencEqlist, parseCencEqlistItem, cencEqlistItems, cencEqlistMd5Of, failResult, noteParseResult, noteSourceSuccess, retrySource, sourceHealthOf, effectiveStatusOf, resetSourceHealth, P2P_TIME_RE, MIGRATED_KEY }

// activeClient 是 12-websocket 的模块级 let：给 12 用的赋值出口（跨模块不能写 imported binding）
// 由 12-websocket 提供 setter；这里仅保留引用以便阅读
