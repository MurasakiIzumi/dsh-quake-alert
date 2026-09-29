// ============================================================================
// dsh-quake-alert · client/src/11-pipeline.js
//
// 作用：主链——收到一条原始消息后的完整处理顺序（解析 → 去重 → 匹配 → 静默时段 →
//       跨标签页抢占 → 通知 → 历史）；handleCancelled 处理取消 / 解除（仅对已提醒过的事件）。
// 依赖：05-parser、06-matcher、07-store、08-audio、09-notify、10-dedupe、01-constants、00-i18n。
// ============================================================================

import { PREFECTURES, prefLabelOf } from './01-constants.js'
import { t } from './00-i18n.js'
import { inQuietHours, own } from './02-storage.js'
import { parse, severityOfScale, sevColor } from './05-parser.js'
import { matchAlert, regionInWeatherWatch, validGeo } from './06-matcher.js'
import { addEvent, store } from './07-store.js'
import { playSound, playAlertSound, soundAllowedFor } from './08-audio.js'
import { showToast, showSystemNotification } from './09-notify.js'
import { isDuplicate, isEventRepeat, isStrengthUpgrade, weakenEvent, forgetEvent, forgetAlerted, claimAlertForTab, cancelKeyOf, rememberAlerted, wasRecentlyAlerted, crossSourceCopyOf, noteAuthoritySuppressed } from './10-dedupe.js'

/**
 * 气象灾害的**事件窗口**（分钟）：同一官署同一灾种在此窗口内的后续电文只记历史，强度升级仍提醒。
 * 气象灾害是持续过程、多次发布的强度通常不变，默认 10 分钟窗口会让每条更新重新响铃。
 * 与 10-dedupe 的 `ALERTED_MAX_MS`（24 小时，判"这条解除是否对应提醒过的事件"）不是同一个窗口。
 */
const WEATHER_EVENT_WINDOW_MINUTES = 180

// ---------- 主链：收到消息 ----------
// 区域文案：府県予報区级条目的 area 与 pref 常同名，直接拼接会显示成「東京都東京都」。
function areaLabelOf(region) {
  const name = region.city || region.area || ''
  if (!name) return region.pref || ''
  if (!region.pref || name === region.pref || name.indexOf(region.pref) === 0) return name
  return region.pref + name
}

/** 大陆源的产品名：日本源与大陆源是两家机构的不同产品（緊急地震速報 / 地震预警），名称不可互套。 */
function cnProductName(alert) {
  if (!alert) return ''
  if (alert.source === 'cenc_eew') return t('product.cnEew')
  if (alert.source === 'cenc_eqlist') return t('product.cnEqlist')
  return ''
}

/**
 * 通知文案里的「官方发布」指哪家机构：各源主管机构完全不同，认不出时退化成中性表述。
 * 值存文案表的 key 而不是名字本身——机构归属与语言无关，名字要随界面语言走（00a-texts-core.js）。
 */
const AUTHORITY_BY_SOURCE = {
  emsc: 'authority.emsc',
  usgs: 'authority.usgs',
  noaa: 'authority.noaa',
  cenc_eew: 'authority.cenc',
  cenc_eqlist: 'authority.cenc',
  // 大陆气象预警的发布主体是各级气象台，汇总在中央气象台（中国气象局）的网站上。
  nmc_alarm: 'authority.cma',
  // 海外气象源（美国 NWS / 加拿大 ECCC）。
  nws_alerts: 'authority.nws',
  eccc_alerts: 'authority.eccc',
  jma: 'authority.jma',
}
function authorityOf(alert) {
  if (!alert) return ''
  const bySource = own(AUTHORITY_BY_SOURCE, String(alert.source || ''))
  if (bySource) return t(bySource)
  const byCode = own(AUTHORITY_BY_SOURCE, String(alert.code === undefined ? '' : alert.code))
  if (byCode) return t(byCode)
  // P2PQuake 的 551 / 552 / 556 都是转播気象庁的信息（只有数字 code，没有 source）
  if (alert.code === 551 || alert.code === 552 || alert.code === 556) return t('authority.jma')
  return ''
}
/** 「仅供参考」那一行：机构已知时点名，未知时用中性表述。 */
function disclaimerOf(alert) {
  const a = authorityOf(alert)
  return a ? t('disclaimer.named', { authority: a }) : t('disclaimer.generic')
}

/**
 * 气象预警的**行动提示**，按机构分岔：日本气象电文 → 市町村级的避难信息（日本の避難情報）；
 * 大陆气象预警 → 各级气象台发布的防御指引（没有"市町村"这个行政层级）；
 * 海外气象（NWS / ECCC）→ 当地官方发布的避难与撤离指引；认不出来源退回中性表述（action.generic）。
 */
function weatherActionHintOf(alert) {
  if (!alert) return t('action.generic')
  if (alert.locator === 'overseas') return t('action.overseas')
  if (alert.locator === 'area') return t('action.cnArea')
  return t('action.jp')
}

/** 系统通知 / 页内 toast 的标题。 */
function alertTitleOf(alert) {
  if (!alert) return t('app.name')
  // kindLabel 已含灾种与「（警报）」等级，不另拼后缀；分级是安全信息，不可省略。
  if (alert.kind === 'eew') return '⚠ ' + (cnProductName(alert) || t('product.jpEew'))
  if (alert.kind === 'quake') return '🌐 ' + alert.kindLabel
  if (alert.kind === 'tsunami') return '🌊 ' + alert.kindLabel
  if (alert.kind === 'weather') return '🌧 ' + alert.kindLabel
  return t('app.name')
}

/**
 * 命中之后的 severity：决定通知配色，也决定静默时段能否穿透。
 * 日本地震按命中区域的震度判定（非 headline 里的最大震度），EEW 恒为 red，海啸 / 气象用解析层算好的值。
 * 坐标型全球源（`locator === 'point'`）的 `maxScale` 恒为 -1，必须用解析层按震级判定的 `severity`，
 * 否则强震会被算成 `info`，既显示不出严重性、也会被静默时段当成非红色等级吞掉。
 */
function hitSeverityOf(alert, m) {
  if (!alert || alert.kind !== 'quake') return alert ? alert.severity : 'info'
  if (alert.locator === 'point') return alert.severity
  const scale = (m && m.region && typeof m.region.scale === 'number') ? m.region.scale : alert.maxScale
  return severityOfScale(scale)
}

// 气象警报的「静默提示」：命中关注地区、但未达 L4 所以没有播报时留一笔，供侧边栏悬停提示与设置页显示。
// 命中地区已达 L4（已真正播报）时必须清掉，否则「未达 L4，未播报」的文案与事实矛盾。
// 只对日本气象电文生效：大陆源（`locator === 'area'`）与海外源（`locator === 'overseas'`）的
// `regions` 不是"关注地区自己的级别"，它们（**包括它们的解除**）动不了日本电文留下的那一笔。
function updateWeatherHint(alert, cfg) {
  if (alert.kind !== 'weather') return
  // 这道来源守卫要排在解除分支**之前**：NWS 的 Cancel 是 `kind:'weather'` + `locator:'overseas'`
  // + `cancelled:true`，排在后面时一条与日本无关的海外取消会抹掉日本电文的提示。
  if (alert.locator === 'area' || alert.locator === 'overseas') return
  // 解除电文先把提示清掉再返回：解除的 regions 是空数组，走下面的判定只会落到"不涉及关注地区"。
  if (alert.cancelled) {
    if (store.weatherHint) store.push({ weatherHint: null })
    return
  }
  if ((cfg.disasters || {}).weather === false) return
  const w = cfg.watch || {}
  const lvOf = (r) => (typeof r.level === 'number' ? r.level : alert.level)
  // 这条电文**根本不涉及**关注地区时什么都别动（例如用户只关注東京都，而这条只报了北海道）：
  // 它不是"关注地区的警报解除了"，清掉会抹掉一条仍然有效的提示。JMA 气象电文频繁、多数都不涉及
  // 某一位用户关注的县，混进下面那条清空判据会让提示长期显示不出来。
  if (!alert.regions.some((r) => regionInWeatherWatch(r, w))) return
  // 只看**关注地区自己的级别**：整条电文最大 L4 时关注地区可能只有 L3（提示要保留），
  // 反之命中地区已达 L4（已播报）就该清掉。
  const hit = alert.regions.find((r) => regionInWeatherWatch(r, w) && lvOf(r) === 3)
  const hitL4 = alert.regions.some((r) => regionInWeatherWatch(r, w) && lvOf(r) >= 4)
  if (!hit || hitL4) {
    if (store.weatherHint) store.push({ weatherHint: null })
    return
  }
  store.push({
    weatherHint: { level: 3, label: areaLabelOf(hit), at: Date.now() },
  })
}

// 取消 / 解除消息：仅当此前提醒过同一事件时才补一条「已取消」，否则只记历史（避免打扰）。
function handleCancelled(alert, cfg) {
  if (alert.kind !== 'eew' && alert.kind !== 'tsunami' && alert.kind !== 'weather') return
  const disasters = cfg.disasters || {}
  // 历史条目带上解析层给出的正文（detail）：NWS 的 description + instruction、ECCC 的正文 + 署名
  // 都在其中，`addEvent` 会被 normalizeHistoryEntry 过滤掉未列出的字段（见 07-store / 02-storage）。
  const pushEvent = (fields) => addEvent(Object.assign({ detail: alert.detail }, fields))
  if (alert.kind === 'eew' && disasters.earthquake === false) return
  if (alert.kind === 'tsunami' && disasters.tsunami === false) return
  // 气象的开关按**来源**分岔：海外源由它自己的 `overseasWeather` 管（见 12e 与 13-ui 的设置项）。
  if (alert.kind === 'weather') {
    const off = alert.locator === 'overseas' ? disasters.overseasWeather === false : disasters.weather === false
    if (off) return
  }
  if (!wasRecentlyAlerted(alert)) {
    pushEvent({
      id: alert.id, code: alert.code, kind: alert.kind, label: alert.kindLabel, severity: alert.severity,
      issued: alert.issued, headline: alert.headline + t('hist.missSuffix', { reason: t('reason.cancelNoPriorAlert') }), hit: false,
    })
    return
  }
  // 取消 / 解除消息不穿透静默（它不是紧急警报，静默期间只记历史）
  if (inQuietHours(cfg)) {
    pushEvent({
      id: alert.id, code: alert.code, kind: alert.kind, label: alert.kindLabel, severity: alert.severity,
      issued: alert.issued, headline: alert.headline, hit: true,
      suppressed: true,
      suppressedReason: t('reason.cancelNoPierceQuiet', { start: cfg.quietHours.start, end: cfg.quietHours.end }),
    })
    return
  }
  // 用 forgetAlerted 从本地存储里删除而不是直接 delete，否则刷新后这条已被取消的事件又变成"提醒过"。
  forgetAlerted(alert) // 同一条取消只提醒一次
  // 灾害过程已结束：忘掉事件键，"解除之后再次发布"才会被当成新事件（见 10-dedupe）
  forgetEvent(cancelKeyOf(alert))
  if (!claimAlertForTab('cancel:' + (alert.id || cancelKeyOf(alert)), '')) {
    pushEvent({
      id: alert.id, code: alert.code, kind: alert.kind, label: alert.kindLabel, severity: alert.severity,
      issued: alert.issued, headline: alert.headline, hit: true,
      suppressed: true, suppressedReason: t('reason.otherTab'),
    })
    return
  }
  pushEvent({
    id: alert.id, code: alert.code, kind: alert.kind, label: alert.kindLabel, severity: alert.severity,
    issued: alert.issued, headline: alert.headline, hit: true,
  })
  const title = alert.kind === 'eew'
    ? '✅ ' + t('notify.cancelTitle', { product: cnProductName(alert) || t('product.jpEewShort') })
    : (alert.kind === 'tsunami' ? t('notify.tsunamiLifted') : '✅ ' + alert.kindLabel)
  const body = alert.headline + '\n' + t('notify.cancelBody') + '\n' + disclaimerOf(alert)
  if (cfg.notify.sound !== false) playSound('cancel', cfg.notify.volume)
  const pageVisible = typeof document !== 'undefined' && document.visibilityState === 'visible'
  if (pageVisible) {
    showToast({ title, body, color: '#4ade80' })
  } else if (cfg.notify.system) {
    const ok = showSystemNotification({ title, body, tag: 'quake-alert-cancel-' + alert.id, silent: true })
    if (!ok) showToast({ title, body, color: '#4ade80', ttlMs: 20000 })
  }
}

function handleRaw(raw, cfg) {
  const alert = parse(raw)
  if (!alert) return
  handleAlert(alert, cfg)
}

/**
 * 处理一条已统一为 Alert 的消息——P2PQuake 的 551/552/556 与気象庁的电文都汇到这里，六步流程一致。
 * @param {{ skipQuietHours?: boolean }} [opts] 仅供设置页的「发送测试气象警报」用（测试不该被静默吞掉）。
 * @returns {{ notified: boolean, reason?: string, detail?: string }} 是否真的播报了，以及没播报的原因。
 */
/** 坐标型全球源在用户**没有配置任何「全球关注点」**时整条丢弃（连历史都不记），配好后立即生效。 */
function watchlessPoint(alert, cfg) {
  if (!alert || alert.locator !== 'point') return false
  const places = (cfg.watch && cfg.watch.places) || []
  return places.length === 0
}

function handleAlert(alert, cfg, opts) {
  const options = opts || {}
  // 历史条目统一带上解析层的正文（同 handleCancelled）。
  const pushEvent = (fields) => addEvent(Object.assign({ detail: alert.detail }, fields))
  if (watchlessPoint(alert, cfg)) {
    return { notified: false, reason: 'no-watch-point', detail: t('reason.noGlobalWatch') }
  }
  // received 计数用 push 带出去，设置页的"已收到 N 条推送"才会立刻反映（直接自增不会触发重渲）。
  store.push({ received: store.received + 1 })
  // 消息级去重按 alert.id，**但强度升级要放行**：全球源的修订版复用同一个 id（EMSC 的 unid /
  // USGS 的 feature id），一律挡掉会让震级上修永远不再提醒。`isDuplicate` 有登记副作用（见
  // 10-dedupe），只求值一次并留用；`upgrading` 还要供**跨标签页抢占**用：抢占记忆按消息 id 保留
  // 10 分钟，不绕开的话同 id 的修订版会被本标签页上一次的抢占挡下（震级上修被静默）。
  const dup = isDuplicate(alert.id, cfg.dedupe.windowMinutes)
  const upgrading = dup && isStrengthUpgrade(alert)
  if (dup && !upgrading) {
    return { notified: false, reason: 'duplicate', detail: t('reason.duplicateMessage') }
  }
  if (alert.cancelled) {
    handleCancelled(alert, cfg)
    // 解除也要清掉「未达播报级别」的静默提示：这个分支在两条 updateWeatherHint 调用点**之前**
    // 返回，不在这里补一次，气象 L3 的提示会在解除后永久挂着。
    updateWeatherHint(alert, cfg)
    return { notified: false, reason: 'cancelled', detail: t('reason.clearedIsNotAlert') }
  }
  const m = matchAlert(alert, cfg)
  // 气象强度的**回落**要在命中与未命中两条路径上都写回事件记忆：海外气象源的档位由 event 名
  // （NWS）或颜色档（ECCC）决定、强度由 severity 决定，两条正交，"命中但降级"也会发生。
  // 只对气象下调"已播报强度"，不推广到另外两个灾种：551 的「震源情报」`strength` 是 -1，
  // 而它与该地震的「各地震度」共用同一个事件键（都取自 `earthquake.time`），下调会让同一场地震的
  // 各地震度被 `isStrengthUpgrade` 判成"升级"再响一次；海啸（552）没有可归并的事件 id。
  if (alert.kind === 'weather') weakenEvent(alert)
  if (!m.hit) {
    // 气象警报：即使不播报（L3 及以下），也把"正在升级"留给侧边栏 tooltip
    updateWeatherHint(alert, cfg)
    // "没命中 / 未达档位"的条目一律不进历史（否则历史会被 L1〜L3 与 Watch/Advisory 占满）；
    // `m.noWatch`（未配置关注点，命中概率恒为 0）同样不进。
    // **但"判不了"必须留痕**：region 数据缺失、坐标缺失、震源情报无震度、海外源没有来源关注点
    // 不是"离得远"而是"根本没法判定"，matcher 用 `cannotJudge` 把这两类分开。
    if (!m.noWatch && m.cannotJudge === true) {
      pushEvent({
        id: alert.id, code: alert.code, kind: alert.kind, label: alert.kindLabel, severity: alert.severity,
        issued: alert.issued, headline: alert.headline + t('hist.missSuffix', { reason: m.reason }), hit: false,
      })
    }
    return { notified: false, reason: 'not-hit', detail: m.reason }
  }
  // 命中的提示必须在**任何抑制分支之前**更新：它只写在"真的播报出去"的路径末尾时，过老 / 静默
  // 时段 / 其它标签页 / 重放这些分支都会跳过它，侧边栏会停在"未播报"而历史里标着"已命中"。
  updateWeatherHint(alert, cfg)
  const hitPref = m.region ? m.region.pref : ''
  // 严重度见 hitSeverityOf 的注释
  const hitSeverity = hitSeverityOf(alert, m)
  // 跨会话重放**探测**：Host 重启后会按首次启动的回看窗口（USGS 6 小时 / NOAA 24 小时）重投缓冲里的事件，
  // 而 Client 的去重窗口只有 10 分钟；`alertedEvents`（"真正播报过"的记忆）保留 24 小时，正好挡它。
  // **必须在这里先算**：isEventRepeat 会把 strength 更新成本次的值，之后 isStrengthUpgrade 恒为 false；
  // 也不能就地抑制——同一会话内的后续发布（震度速报 → 各地震度）要由 isEventRepeat 归类。
  const looksReplayed = wasRecentlyAlerted(alert) && !isStrengthUpgrade(alert)
  // 同一次地震的后续发布（速报 → 震源 → 各地震度、或 EEW 多报）强度未升级 → 只更新历史，不再响铃。
  // 气象灾害用更长的事件窗口（见 WEATHER_EVENT_WINDOW_MINUTES）。
  const repeatWindow = alert.kind === 'weather'
    ? Math.max(cfg.dedupe.windowMinutes || 10, WEATHER_EVENT_WINDOW_MINUTES)
    : cfg.dedupe.windowMinutes
  // 跨源优先源：同一场地震被多个源报出时，只让**一个**源向用户播报。位置两条都不能挪：
  //   · **必须在 isEventRepeat 之前**——它是只读探测，而 isEventRepeat 会把这条事件写进记忆，
  //     写进去之后 findPrevEvent 找到的就是它自己，跨源判定永远不会成立。
  //   · **必须在 m.hit 之后**——只有"本来会播报"的副本才算被优先源压掉。
  // 被压掉的副本**不进历史**（多源重复会把 30 条的「最近预警」挤掉），但抑制必须留下计数与原因。
  const crossSource = crossSourceCopyOf(alert)
  if (crossSource) {
    return { notified: false, reason: 'authority-suppressed', detail: noteAuthoritySuppressed(crossSource, alert) }
  }
  if (isEventRepeat(alert, repeatWindow)) {
    pushEvent({
      id: alert.id, code: alert.code, kind: alert.kind, label: alert.kindLabel, severity: hitSeverity,
      issued: alert.issued, headline: alert.headline, hit: true, pref: hitPref,
      suppressed: true, suppressedReason: t('reason.eventRepeatSuppressed'),
    })
    return { notified: false, reason: 'event-repeat', detail: t('reason.eventRepeatDetail') }
  }
  // 事件级去重没拦下、但记忆说"这个事件在 24 小时内已经真正播报过" → 判为跨会话重放
  // （Host 重启按回看窗口重投），只记历史不响铃。该判据覆盖的不只是重投，还包括"同一官署同一
  // 灾种在事件窗口之后、24 小时之内等强度的第二次独立发布"，所以文案不写成"Host 重启后的重放"。
  if (looksReplayed) {
    pushEvent({
      id: alert.id, code: alert.code, kind: alert.kind, label: alert.kindLabel, severity: hitSeverity,
      issued: alert.issued, headline: alert.headline, hit: true, pref: hitPref,
      suppressed: true, suppressedReason: t('reason.replaySuppressed'),
    })
    return { notified: false, reason: 'replayed', detail: t('reason.replayDetail') }
  }
  // 打开页面时才发现的老预警（options.staleOnArrival，时效门槛）：**仍然命中、仍然进历史**，但不响铃、
  // 不弹通知——海外气象源按关注点查询，页面一打开就会把当前生效的（可能几小时前发布的）预警全拉回来。
  // **必须放在 `isEventRepeat` 之后**：放在它之前会绕过事件级记忆的更新，同一条老预警每过一轮消息级
  // 去重窗口（10 分钟）就再进一次历史，把 30 条的历史列表占满。
  if (options.staleOnArrival) {
    const hours = typeof options.staleOnArrival === 'number' ? options.staleOnArrival : 0
    // **同时记进"已提醒过"的 24 小时记忆**：只靠 isEventRepeat 的事件窗口（气象 3 小时）不够，
    // 窗口一过，同一条仍在生效的老预警会被判成新事件、在开着的页面里响铃；记进去之后由上面的
    // `looksReplayed` 分支拦住。
    rememberAlerted(alert)
    pushEvent({
      id: alert.id, code: alert.code, kind: alert.kind, label: alert.kindLabel, severity: hitSeverity,
      issued: alert.issued, headline: alert.headline, hit: true, pref: hitPref,
      suppressed: true,
      suppressedReason: t('reason.staleOnArrival', { hours: hours }),
    })
    return { notified: false, reason: 'stale-on-arrival', detail: t('reason.staleOnArrivalDetail') }
  }
  // 静默时段：命中但不响铃、不弹通知，只记历史。红色等级（EEW、大海啸警报）默认可穿透。
  if (!options.skipQuietHours && inQuietHours(cfg) && !(hitSeverity === 'red' && cfg.quietHours.breakForSevere !== false)) {
    pushEvent({
      id: alert.id, code: alert.code, kind: alert.kind, label: alert.kindLabel, severity: hitSeverity,
      issued: alert.issued, headline: alert.headline, hit: true, pref: hitPref,
      suppressed: true,
      suppressedReason: t('reason.quietHours', { start: cfg.quietHours.start, end: cfg.quietHours.end }) +
        (hitSeverity === 'red' ? t('reason.quietNoRedPierce') : ''),
    })
    return { notified: false, reason: 'quiet-hours', detail: t('reason.quietHoursDetail') }
  }
  // 其它 DSH 标签页已经播报过同一条消息 → 本标签页静默，避免多个页面同时响铃。抢占键用消息 id
  // 而不是事件键：多标签页收到的是同一条消息，而同一事件的不同消息（如强度升级）不应被拦。
  // **但同 id、更高强度的修订版必须绕开抢占**（`upgrading`），否则"震级上修"会被上一次同 id 的
  // 抢占（按消息 id 保留 10 分钟）抑制，成为一条静默的漏报。
  if (!upgrading && !claimAlertForTab(alert.id, cancelKeyOf(alert))) {
    pushEvent({
      id: alert.id, code: alert.code, kind: alert.kind, label: alert.kindLabel, severity: hitSeverity,
      issued: alert.issued, headline: alert.headline, hit: true, pref: hitPref,
      suppressed: true, suppressedReason: t('reason.otherTab'),
    })
    return { notified: false, reason: 'other-tab', detail: t('reason.otherTabDetail') }
  }
  // 县名走 prefLabelOf（随界面语言）：日文界面是「東京都」，中文界面「东京（東京都）」，
  // 英文界面「Tokyo (東京都)」。命中行的标签也跟着语言走，原名括号只在"显示名与原名不同"时出现。
  const prefLabel = prefLabelOf(hitPref)
  const title = alertTitleOf(alert)
  const bodyLines = [alert.headline]
  if (hitPref) {
    bodyLines.push(prefLabel !== hitPref
      ? t('notify.hitPrefNamed', { pref: prefLabel, jp: hitPref })
      : t('notify.hitPref', { pref: prefLabel }))
  }
  // 全球源没有行政区，命中依据是「距某个关注点多少公里」——半径由用户自己设，说出距离才可判断可信度。
  // **判据是"有没有真实距离"，不是"是哪个源"**：只有坐标型源（`locator === 'point'`，见 matchPointAlert）
  // 会给出 `distanceKm`；海外气象（查询即匹配）与大陆气象（行政区层级）都只给关注点，落到下面那一支
  // `Math.round(undefined)` 会拼出「距震中约 NaN km」，还把一场暴雨 / 洪水说成"震中"。
  else if (m.place && typeof m.distanceKm === 'number' && Number.isFinite(m.distanceKm)) {
    bodyLines.push(t('notify.hitPlaceDistance', { place: m.place.name, km: Math.round(m.distanceKm) }))
  } else if (m.place) {
    bodyLines.push(t('notify.hitPlaceOfficial', { place: m.place.name }))
  }
  if (alert.kind === 'tsunami') bodyLines.push(t('action.tsunami'))
  // 行动提示按**机构**分岔：日本气象电文对应市町村级的避难信息，大陆预警由各级气象台发布，
  // 美加的洪水预警由当地应急部门（county / 省）发布。
  if (alert.kind === 'weather') bodyLines.push(weatherActionHintOf(alert))
  bodyLines.push(disclaimerOf(alert))
  pushEvent({
    id: alert.id, code: alert.code, kind: alert.kind, label: alert.kindLabel, severity: hitSeverity,
    issued: alert.issued, headline: alert.headline, hit: true, pref: hitPref,
  })
  const vol = cfg.notify.volume
  // 总开关 + 分灾害开关（地震含 EEW / 海啸 / 气象），见 soundAllowedFor
  if (soundAllowedFor(cfg, alert)) playAlertSound(alert, vol)
  const pageVisible = typeof document !== 'undefined' && document.visibilityState === 'visible'
  const body = bodyLines.join('\n')
  if (pageVisible) {
    // 页面可见时只用页内 toast，后台才走系统通知
    showToast({ title, body, color: sevColor(hitSeverity) })
  } else if (cfg.notify.system) {
    const ok = showSystemNotification({ title, body, tag: 'quake-alert-' + alert.id, silent: true })
    if (!ok) showToast({ title, body, color: sevColor(hitSeverity), ttlMs: 20000 })
  }
  rememberAlerted(alert)
  return { notified: true }
}


export { WEATHER_EVENT_WINDOW_MINUTES, handleCancelled, handleRaw, handleAlert, updateWeatherHint, alertTitleOf, watchlessPoint, hitSeverityOf, cnProductName, authorityOf, disclaimerOf, weatherActionHintOf }
