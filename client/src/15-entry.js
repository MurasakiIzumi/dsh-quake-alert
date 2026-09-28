// ============================================================================
// dsh-quake-alert · client/src/15-entry.js
// 作用：插件入口——apply 与单测钩子。注册音效解锁、跨标签页通道、settings 绑定、市区町村表、
//       各源客户端的启停、设置页与状态指示两个 slot，并导出 exports.__test。
// 依赖：全部前置文件。所有副作用都包在 ctx.effect 内，插件停用即回收。
// ============================================================================

import { requestNotificationPermission } from './09-notify.js'
import { h, HISTORY_MAX, HISTORY_MAX_AGE_MS, LEGACY_PLACE_RADIUS_KM, PREFECTURES, prefLabelOf, DEFAULT_CFG, STORAGE_KEY, EMSC_WS_URL, normalizePref, prefOfCode, prefCodeOf, p2pTimeToIso, cnTimeToIso, CN_TIME_RE, CN_REPORT_MAG_OPTIONS, RADIUS_PRESETS, SCALE_OPTIONS, TSUNAMI_OPTIONS, GLOBAL_MAG_OPTIONS, DEFAULT_PLACE_RADIUS_KM, MIN_PLACE_RADIUS_KM, MAX_PLACE_RADIUS_KM, LANGUAGE_OPTIONS, issuedToDate, formatIssuedLocal, P2P_TIME_RE } from './01-constants.js'
import { PREF_EN, PREF_HANT } from './00d-texts-regions.js'
import { LANGS, DEFAULT_LANGUAGE, LANGUAGE_LABELS, resolveLang, setLanguage, getLanguage, t, tableOf } from './00-i18n.js'
import { loadCfg, normalizeCfg, normalizePlaces, loadHistory, normalizeHistoryEntry, withinHistoryAge, inQuietHours, placeOriginOf, PLACE_ORIGINS } from './02-storage.js'
import { SETTINGS_NS, MIGRATED_KEY, cfgToSection, sectionToCfg, currentCfg, applyCfg, settingsOpsFor, bindSettingsScope, settingsState, resetSettings, reloadFromLocal } from './03-settings-bridge.js'
import { setCityTable, citiesOfPref, prefsOfCity, canonicalCityOf, normKana, setRiverAreas, riverAreaCities, cityAliases, lookupAddrCity, buildAddrIndex, pruneUnknownCities, pruneCitiesOfUnwatchedPrefs, loadCityTable, retryCityTable, abortCityTableLoad, cityTableState, resetCityTable, setCnAreas, cnAreasStateOf, cnProvinces, cnCitiesOf, cnPlaceOf, cnAreaOf, normAliases, setWorldCountries, worldCountriesOf, countryNameOf, countryPackOf, loadCountryCities, resetWorldCities } from './04-city-table.js'
import { parse, parseQuake, parseEew, parseTsunami, prefsOfArea, regionsOfArea, AREA_PREF, sevColor, geoOfHypo } from './05-parser.js'
import { parseJma, buildTestTelegram, TEST_SCENARIOS, maxLevelIn as jmaMaxLevelIn, itemsOf as jmaItemsOf, noticeAreaLevels, applyNoticeLevels, regionKindOf } from './05b-jma-parser.js'
import { parseEmsc, parseUsgsFeature, parseNoaaCap, severityOfMagnitude, geoEventKey, TEST_GEO_SCENARIOS, buildTestGlobalMessage, parseTestGlobalMessage } from './05c-global-parsers.js'
import { parseEpspResult, parseEmscResult, parseUsgsResult, parseNoaaResult, parseJmaResult, parseCencEewResult, parseCencEqlistItemResult, parseCencEqlistResult, parseNmcAlarmResult, parseNwsAlertResult, parseEcccAlertResult, failResult, SOURCE_CONTRACTS } from './05d-source-contracts.js'
import { noteParseResult, noteSourceSuccess, retrySource, sourceHealthOf, effectiveStatusOf, resetSourceHealth, resetConnHealth, pruneHealth, noteFreshness, noteStale, loadHealth, publishStatus, republishDataHealth, SCHEMA_ESCALATE_COUNT, SCHEMA_ESCALATE_CONSECUTIVE, SCHEMA_ESCALATE_WINDOW_MS, HEALTH_TTL_MS } from './05g-source-health.js'
import { parseCencEew, parseCencEqlist, parseCencEqlistItem, cencEqlistItems, cencEqlistMd5Of } from './05e-cn-parsers.js'
import { parseNmcAlarm, orgOf, NMC_KIND_TEXT, NMC_LEVEL_TEXT, NMC_LEVEL_RANK, NMC_BROADCAST_MIN_RANK } from './05f-nmc-parsers.js'
import { parseNwsAlert, parseEcccAlert, ecccKindTextOf, nwsEventKeyOf, nwsVtecKeyOf, ecccEventKeyOf, NWS_EVENT_WHITELIST, nwsKindTextOf, nwsKindTextMap, NWS_SEVERITY, NWS_SEV_RANK, ECCC_COLOUR_SEVERITY, ECCC_COLOUR_RANK, ECCC_INCLUDE, ECCC_EXCLUDE, OVERSEAS_BROADCAST_MIN_RANK } from './05h-overseas-parsers.js'
import { matchAlert, matchPointAlert, matchCnAreaAlert, matchOverseasAlert, cnPlaceParts, cnWatchPlaces, distanceKm, validGeo } from './06-matcher.js'
import { store, addEvent } from './07-store.js'
import { unlockAudio, playSound, soundKindOf, soundAllowedFor, audioState } from './08-audio.js'
import { isDuplicate, isEventRepeat, isStrengthUpgrade, weakenEvent, forgetEvent, forgetAllAlerted, claimAlertForTab, cancelKeyOf, rememberAlerted, wasRecentlyAlerted, ensureAlertChannel, closeAlertChannel, broadcastHistoryCleared, sourceIdOf, crossSourceCopyOf, noteAuthoritySuppressed, authorityStatsOf, SOURCE_RANK, sourceNameOf, SOURCE_AGENCY, agencyOf, CROSS_SOURCE_KINDS, rankOfSource, sourceZhOf, alertedEvents } from './10-dedupe.js'
import { WEATHER_EVENT_WINDOW_MINUTES, handleRaw, handleCancelled, handleAlert, updateWeatherHint, alertTitleOf, watchlessPoint, hitSeverityOf, cnProductName, authorityOf, disclaimerOf, weatherActionHintOf } from './11-pipeline.js'
import { createWsClient, setActiveClient } from './12-websocket.js'
import { createFeedClient, feedStatsOf, FEED_PATH, FEED_POLL_MS, FEED_CURSOR_KEY, FEED_TAIL } from './12b-feed-poll.js'
import { createCnStream, cnStreamRegistry, STREAM_PATH, CN_CURSOR_KEY } from './12c-cn-stream.js'
import { createHealthProbe, PROBE_INTERVAL_MS, staleAfterOf } from './12d-health-probe.js'
import { createNwsSource, createEcccSource, overseasStatsOf, nwsSamplePoints, ecccBboxOf, placesInBoxes, US_BOXES, CA_BOX, defaultFetchText, NWS_ALERTS_BASE, ECCC_ALERTS_BASE, NWS_EVENT_QUERY, MIN_SAMPLE_RADIUS_KM, MAX_REQUESTS_PER_ROUND, OVERSEAS_FRESH_GATE_MS, OVERSEAS_GATE_RESET_MS, UNCOVERED_TTL_MS, OVERSEAS_MIN_BACKOFF_MS, OVERSEAS_MAX_BACKOFF_MS } from './12e-overseas-poll.js'
import { SettingsPanel, p2pCodeTextOf, kindColorOf, SOURCE_ORDER, SOURCE_CODE_TEXT, statusMetaOf } from './13-ui-settings.js'
import { sourceLabelOf } from './00f-source-labels.js'
import { buildConfigExport, parseConfigImport, importConfig, undoConfigImport, loadConfigBackup, configFileName, CONFIG_FORMAT, CONFIG_FORMAT_VERSION } from './17-config-io.js'
import { StatusIndicator } from './14-ui-status.js'
import { buildDiagSnapshot, copyDiagSnapshot, DIAG_SNAPSHOT_VERSION } from './16-diag.js'

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
  // ensure 与 close 同处一个 effect（effect 体在 apply 时**同步执行**），两代 fiber 不能共享同一条通道。
  ctx.effect(() => {
    ensureAlertChannel()
    return () => { closeAlertChannel() }
  }, 'dsh-quake-alert: tab channel')

  // 插件（重新）装载时清空上一代的**连接**状态：残留状态会把新会话显示成"已连接"。
  // 数据健康不清（已写入本地存储，表达的是"上游改了字段、要等插件更新"，与刷新页面 / 重新启用无关）。
  store.clearSources()
  resetConnHealth()
  // 立刻重新发布已升级的数据健康：store 刚被清空而蓝点存在 localStorage 里，不重发要等该源下一轮上报才显示。
  republishDataHealth()

  // 健康自检：按 SOURCE_CONTRACTS 里的阈值判定各源的数据新鲜度并驱动蓝点 TTL 自愈。放进 effect
  // 是因为它有定时器（定时器归 fiber）。sourceEnabled 是「这个源现在开着吗」的唯一映射：关掉的源不判 stale。
  const sourceEnabled = (id) => {
    const d = (currentCfg().disasters) || {}
    if (id === 'jma') return d.weather !== false
    if (id === 'usgs' || id === 'cenc_eew' || id === 'cenc_eqlist') return d.earthquake !== false
    if (id === 'noaa') return d.tsunami !== false
    if (id === 'nmc_alarm') return d.cnRainstorm !== false || d.cnGeology !== false
    if (id === 'nws_alerts' || id === 'eccc_alerts') return d.overseasWeather !== false
    return true
  }
  ctx.effect(() => {
    const probe = createHealthProbe({ sourceEnabled })
    probe.start()
    return () => { try { probe.stop() } catch (err) { /* 已停 */ } }
  }, 'dsh-quake-alert: health probe')

  // 机器级持久化：settings 服务可用时配置交给 DSH 的机器级存储，服务缺席（或页面非 loopback）时保持 localStorage。
  // 两代宿主的读写入口是两个不同的服务（03-settings-bridge 只认"快照 + 写入"）：旧宿主走 settingsScope.bind({ namespace })，
  // 新宿主走 configForms.get(entryId)；两者都 ctx.inject 等待，先到者胜（bound 守卫）。
  if (typeof ctx.inject === 'function') {
    let bound = false
    const bindHostSettings = (resolveScope, label) => {
      if (bound) return
      let unbind = null
      try {
        const scope = resolveScope()
        if (!scope) return
        unbind = bindSettingsScope(scope)
        bound = true
      } catch (err) { /* bind 失败 → 继续用 localStorage */ }
      // 订阅必须随 fiber 释放：否则同一页面内停用 → 启用 N 次会累积 N 个订阅，此后 Host 每次配置变更都触发 N 次写入本地存储与重渲。
      if (bound && typeof unbind === 'function' && typeof ctx.effect === 'function') {
        ctx.effect(() => () => { try { unbind() } catch (err) { /* 忽略 */ } }, 'dsh-quake-alert: ' + label + ' unbind')
      }
    }
    // 命名空间就是本插件在 profile 里的条目 id（与 cordis.patch.yml 的 `- id:` 一致），与 Host 侧 Config schema 同名。
    ctx.inject(['configForms'], (settingsCtx) => {
      const forms = settingsCtx.configForms
      if (!forms || typeof forms.get !== 'function') return
      bindHostSettings(() => forms.get(SETTINGS_NS), 'configForms')
    })
    // 旧宿主回退路径：新宿主下这个服务永远不出现，回调不会执行。
    ctx.inject(['settingsScope'], (settingsCtx) => {
      const scope = settingsCtx.settingsScope
      if (!scope || typeof scope.bind !== 'function') return
      bindHostSettings(() => scope.bind({ namespace: SETTINGS_NS }), 'settingsScope')
    })
  }

  // 跨标签页配置同步：storage 事件只在「别的标签页写入」时触发，监听必须常驻（写在设置页组件里会让没打开
  // 设置页的标签页不跟随）。回读走 03 的显式入口（跨模块不能直接给它私有的 runtimeCfg 赋值），再 store.push()。
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

  // 市区町村表：Host 路由提供，拉一次缓存；失败只影响市级细化，不影响任何提醒。放进 effect 以便飞行中停用时中止请求。
  ctx.effect(() => {
    loadCityTable()
    return () => { try { abortCityTableLoad() } catch (err) {} }
  }, 'dsh-quake-alert: city table')

  // WebSocket 常驻连接（与设置页是否打开无关）。start() 必须写在 effect 内：若同一 apply 后面的注册抛错，连接也要
  // 随 fiber 收掉，否则会留下没有清理器的 socket。onRaw 走解析契约：结构不符 / 值不可能 → 计入数据健康且**不播报**；
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
      // 置空：否则设置页里 80ms 后触发的 restart() 还能复活一个已无 fiber 归属的 socket，它会继续上报状态并响铃。
      setActiveClient(null)
    }
  }, 'dsh-quake-alert: ws client')

  /** 轮询源的状态上报：把每个源的连接 / 失败情况经 publishStatus 合成后送进 store（12b 自己也用结果做去重键）。 */
  const feedStatus = (sourceId) => (patch) => publishStatus(sourceId, patch)
  const feedError = (name) => (err) => {
    try { console.warn('[dsh-quake-alert] ' + name + ' 请求失败：' + String((err && err.message) || err)) } catch (e) {}
  }

  // 気象庁电文增量：Host 侧负责轮询与去重，这里只拉本地增量并交给主链。
  const feed = createFeedClient({
    id: 'jma',
    label: '気象庁',
    onStatus: feedStatus('jma'),
    onError: feedError('jma'),
  })
  // 全球地震（USGS）：Host 轮询 GeoJSON，Client 只拉本地增量。与 EMSC 互补（EMSC 是实时推送，USGS
  // 目录更完整、还带修订版），两者的同类地震靠 geoEventKey 归并，不会重复提醒。
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
  // 海啸（NOAA）：Host 拉事件列表再取 CAP 详情，Client 解析 CAP。
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
  // 大陆气象灾害（CMA）：中央气象台汇总的预警信号（暴雨 + 地质灾害），走 Host 的 `/feed` **轮询**，
  // 延迟最坏 120+15 秒。两个灾种各有开关，但**共用一个 Host 源**（同端点、同响应），只要有一个开着就继续拉。
  const nmcFeed = createFeedClient({
    id: 'nmc_alarm',
    label: 'CMA',
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

  // 大陆源：Wolfx 的 cenc_eew（预警）+ cenc_eqlist（速报），走 Host 的 **SSE 推送**（EEW 的价值在秒级）；
  // 12c 在"能证明长连接走不通"时自动切到 `?source=` 轮询并把降级状态说出来。两者都跟「地震」开关，只有速报另有**震级门槛**。
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
    label: 'CENC EEW',
    enabled: cnEnabled,
    onStatus: feedStatus('cenc_eew'),
    onError: feedError('cenc_eew'),
    apply: cencApply('cenc_eew', parseCencEewResult),
  })
  const cencEqlist = createCnStream({
    id: 'cenc_eqlist',
    label: 'CENC eqlist',
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

  // 海外气象：美国 NWS 与加拿大 ECCC，**Client 直连的外部 REST**（CORS 允许），按关注点查询、
  // 不判停更、年龄门槛在首轮生效。两个源各自只对"落在对应国家包围盒内的关注点"发请求，不需要
  // 额外开关；灾种开关（overseasWeather）关掉时连请求都不发。
  const nwsSource = createNwsSource({
    onStatus: feedStatus('nws_alerts'),
    onError: feedError('nws_alerts'),
  })
  const ecccSource = createEcccSource({
    onStatus: feedStatus('eccc_alerts'),
    onError: feedError('eccc_alerts'),
  })
  ctx.effect(() => {
    // 清掉上一代的计数快照：overseasStatsOf 与 feedStatsOf 都是模块级的，插件重建后到首个轮询
    // 完成前，设置页与诊断会显示上一代的数字与 `running: true`。
    for (const k of Object.keys(overseasStatsOf)) delete overseasStatsOf[k]
    for (const k of Object.keys(feedStatsOf)) delete feedStatsOf[k]
    nwsSource.start()
    ecccSource.start()
    return () => { for (const s of [nwsSource, ecccSource]) { try { s.stop() } catch (err) {} } }
  }, 'dsh-quake-alert: overseas pollers')

  // 全球地震：EMSC 的 WebSocket，复用与 P2PQuake 同一套连接管理（重试间隔递增、建连超时监控、生命周期归还 fiber）。
  // staleAfterMs 取 3 小时（远大于正常推送间隔）：建连超时监控在 onopen 后即撤销，没有它连接可以永久停在绿色上。
  const emsc = createWsClient({
    sourceId: 'emsc',
    label: 'EMSC',
    urlOf: () => EMSC_WS_URL,
    staleAfterMs: 3 * 60 * 60 * 1000,
    openDetail: () => t('status.emscConnected'),
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
    label: () => t('app.name'),
  }, (props) => h(SettingsPanel, { close: props ? props.close : undefined })))

  // 侧边栏底部状态指示（绿/黄/红圆点，悬停显示详情）
  ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
    name: 'sidebar.footer.action',
    id: 'quake-alert-status',
    order: 50,
    label: () => t('app.name'),
  }, (props) => h(StatusIndicator, props || {})))
}

// 单测钩子（客户端宿主忽略额外导出）
export const __test = {
  // 本地化机制（语言清单 / BCP 47 回退链 / 取词 / 文案表）
  LANGS, DEFAULT_LANGUAGE, LANGUAGE_LABELS, resolveLang, setLanguage, getLanguage, t, tableOf,
  // 配置导出导入（格式标识 / 校验 / 导入前备份 / 撤销）
  buildConfigExport, parseConfigImport, importConfig, undoConfigImport, loadConfigBackup, configFileName,
  CONFIG_FORMAT, CONFIG_FORMAT_VERSION,
  // 机制层（统一健康记录 + 自检 + 升级阈值）
  createHealthProbe, staleAfterOf, PROBE_INTERVAL_MS,
  resetConnHealth, pruneHealth, noteFreshness, noteStale, loadHealth, publishStatus, republishDataHealth,
  SCHEMA_ESCALATE_COUNT, SCHEMA_ESCALATE_CONSECUTIVE, SCHEMA_ESCALATE_WINDOW_MS, HEALTH_TTL_MS,
  // 大陆气象源（nmc.cn）：解析层 / 契约 / 行政区层级匹配
  parseNmcAlarm, orgOf, parseNmcAlarmResult, matchCnAreaAlert, cnPlaceParts, cnWatchPlaces, cnAreaOf, normAliases,
  NMC_KIND_TEXT, NMC_LEVEL_TEXT, NMC_LEVEL_RANK, NMC_BROADCAST_MIN_RANK,
  // 海外气象源（美国 NWS / 加拿大 ECCC）：解析层 / 契约 / 事件键 / 白名单；取数器按关注点查询、查询即匹配、年龄门槛
  parseNwsAlert, parseEcccAlert, parseNwsAlertResult, parseEcccAlertResult,
  ecccKindTextOf, nwsEventKeyOf, nwsVtecKeyOf, ecccEventKeyOf, NWS_EVENT_WHITELIST, nwsKindTextOf, nwsKindTextMap,
  NWS_SEVERITY, NWS_SEV_RANK, ECCC_COLOUR_SEVERITY, ECCC_COLOUR_RANK, ECCC_INCLUDE, ECCC_EXCLUDE,
  OVERSEAS_BROADCAST_MIN_RANK,
  createNwsSource, createEcccSource, nwsSamplePoints, ecccBboxOf, placesInBoxes, US_BOXES, CA_BOX, defaultFetchText, matchOverseasAlert,
  NWS_ALERTS_BASE, ECCC_ALERTS_BASE, NWS_EVENT_QUERY,
  MIN_SAMPLE_RADIUS_KM, MAX_REQUESTS_PER_ROUND, OVERSEAS_FRESH_GATE_MS, OVERSEAS_GATE_RESET_MS,
  UNCOVERED_TTL_MS, OVERSEAS_MIN_BACKOFF_MS, OVERSEAS_MAX_BACKOFF_MS,
  overseasStatsOf, defaultFetchText,
  parse, parseQuake, parseEew, parseTsunami, parseJma, parseEmsc, parseUsgsFeature, parseNoaaCap, severityOfMagnitude, geoEventKey, TEST_GEO_SCENARIOS, buildTestGlobalMessage, parseTestGlobalMessage, feedStatsOf, watchlessPoint, buildTestTelegram, TEST_SCENARIOS, jmaMaxLevelIn, jmaItemsOf, noticeAreaLevels, applyNoticeLevels, regionKindOf, matchAlert, matchPointAlert, distanceKm, validGeo, normalizePlaces, soundKindOf, soundAllowedFor, playSound, sevColor, p2pCodeTextOf, kindColorOf, alertTitleOf, prefsOfArea, regionsOfArea, AREA_PREF, loadCfg, normalizeCfg, loadHistory, normalizeHistoryEntry, addEvent, withinHistoryAge, handleRaw, handleCancelled, handleAlert, updateWeatherHint, WEATHER_EVENT_WINDOW_MINUTES, hitSeverityOf, createFeedClient, FEED_PATH, FEED_POLL_MS, FEED_CURSOR_KEY, FEED_TAIL, createCnStream, cnStreamRegistry, STREAM_PATH, CN_CURSOR_KEY, cnProductName, authorityOf, disclaimerOf, weatherActionHintOf, SOURCE_ORDER, sourceLabelOf, SOURCE_CODE_TEXT, SettingsPanel, statusMetaOf, buildDiagSnapshot, copyDiagSnapshot, DIAG_SNAPSHOT_VERSION, inQuietHours, placeOriginOf, PLACE_ORIGINS, geoOfHypo, sourceIdOf, crossSourceCopyOf, noteAuthoritySuppressed, authorityStatsOf, SOURCE_RANK, sourceNameOf, SOURCE_AGENCY, agencyOf, CROSS_SOURCE_KINDS, rankOfSource, sourceZhOf, alertedEvents, isDuplicate, isEventRepeat, isStrengthUpgrade, weakenEvent, forgetEvent, forgetAllAlerted, claimAlertForTab, cancelKeyOf, rememberAlerted, wasRecentlyAlerted, ensureAlertChannel, broadcastHistoryCleared, createWsClient, store, HISTORY_MAX, HISTORY_MAX_AGE_MS, LEGACY_PLACE_RADIUS_KM, requestNotificationPermission, PREFECTURES, prefLabelOf, PREF_EN, PREF_HANT, SCALE_OPTIONS, TSUNAMI_OPTIONS, GLOBAL_MAG_OPTIONS, DEFAULT_CFG, STORAGE_KEY, currentCfg, applyCfg, reloadFromLocal, bindSettingsScope, settingsOpsFor, cfgToSection, sectionToCfg, SETTINGS_NS, settingsState, resetSettings, setCityTable, citiesOfPref, prefsOfCity, canonicalCityOf, normKana, setRiverAreas, riverAreaCities, cityAliases, lookupAddrCity, buildAddrIndex, normalizePref, prefOfCode, prefCodeOf, pruneUnknownCities, pruneCitiesOfUnwatchedPrefs, loadCityTable, abortCityTableLoad, cityTableState: () => cityTableState, cnAreasStateOf, retryCityTable, resetCityTable, setCnAreas, cnProvinces, cnCitiesOf, cnPlaceOf, setWorldCountries, worldCountriesOf, countryNameOf, countryPackOf, loadCountryCities, resetWorldCities, RADIUS_PRESETS, DEFAULT_PLACE_RADIUS_KM, MIN_PLACE_RADIUS_KM, MAX_PLACE_RADIUS_KM, p2pTimeToIso, cnTimeToIso, CN_TIME_RE, CN_REPORT_MAG_OPTIONS, LANGUAGE_OPTIONS, issuedToDate, formatIssuedLocal, audioState, SOURCE_CONTRACTS, parseEpspResult, parseEmscResult, parseUsgsResult, parseNoaaResult, parseJmaResult, parseCencEewResult, parseCencEqlistItemResult, parseCencEqlistResult, parseCencEew, parseCencEqlist, parseCencEqlistItem, cencEqlistItems, cencEqlistMd5Of, failResult, noteParseResult, noteSourceSuccess, retrySource, sourceHealthOf, effectiveStatusOf, resetSourceHealth, P2P_TIME_RE, MIGRATED_KEY }
