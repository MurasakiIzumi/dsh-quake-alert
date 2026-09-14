// ============================================================================
// dsh-quake-alert · client/src/11-pipeline.js
//
// 作用：主链——收到一条原始消息后的完整处理顺序。
// 内容：handleRaw（解析 → 去重 → 匹配 → 静默时段 → 跨标签页 → 通知 → 历史）、
//       handleCancelled（取消 / 解除提醒，仅对已提醒过的事件）。
// 依赖：05-parser、06-matcher、07-store、08-audio、09-notify、10-dedupe、01-constants。
// 重要：这是唯一把各层串起来的地方，改动前先读 06-matcher 的放行规则。
// ============================================================================

import { PREFECTURES } from './01-constants.js'
import { inQuietHours } from './02-storage.js'
import { parse, severityOfScale, sevColor } from './05-parser.js'
import { matchAlert, regionInWeatherWatch, validGeo } from './06-matcher.js'
import { addEvent, store } from './07-store.js'
import { playSound, playAlertSound } from './08-audio.js'
import { showToast, showSystemNotification } from './09-notify.js'
import { isDuplicate, isEventRepeat, isStrengthUpgrade, forgetEvent, claimAlertForTab, cancelKeyOf, rememberAlerted, wasRecentlyAlerted, alertedEvents } from './10-dedupe.js'

/**
 * 气象灾害的**事件窗口**（分钟）。
 *
 * 气象灾害是持续过程：同一官署同一灾种会在数小时内反复发布（更新、扩区、维持），
 * 而这些更新的强度通常不变。事件键已按「官署 + 灾种」归并（见 05b 的 eventKey），
 * 若还用默认的 10 分钟窗口，窗口一过每一条更新都会被当成新事件重新响铃。
 * 取 3 小时：窗口内强度未升级只记历史，升级（L3→L4、注意報→危険警報）仍会提醒；
 * 解除时会 forgetEvent 清掉记忆，所以"解除后再次发布"不会被吞掉。
 */
const WEATHER_EVENT_WINDOW_MINUTES = 180

// ---------- 主链：收到消息 ----------
// 区域文案：府県予報区级的条目里 area 与 pref 常是同一个名字（「東京都」+「東京都」），
// 直接拼接会显示成「東京都東京都」。
function areaLabelOf(region) {
  const name = region.city || region.area || ''
  if (!name) return region.pref || ''
  if (!region.pref || name === region.pref || name.indexOf(region.pref) === 0) return name
  return region.pref + name
}

/**
 * 系统通知 / 页内 toast 的标题。抽成纯函数是为了能直接断言文案——
 * 旧写法把「地震情报 · 」与「各地震度」分开拼，非「各地」分支会留下一个悬空的分隔符。
 */
function alertTitleOf(alert) {
  if (!alert) return '灾害预警'
  // kindLabel 本身已区分「地震速报·震度速报」「地震情报·各地震度」等，不需要再拼后缀
  if (alert.kind === 'eew') return '⚠ 紧急地震速报（警报）'
  if (alert.kind === 'quake') return '🌐 ' + alert.kindLabel
  if (alert.kind === 'tsunami') return '🌊 ' + alert.kindLabel
  if (alert.kind === 'weather') return '🌧 ' + alert.kindLabel
  return '灾害预警'
}

/**
 * 命中之后的 severity：决定通知配色，也决定静默时段能否穿透。
 *
 * 日本地震按**命中区域的实际强度**判定（关注县的震度低时颜色不该是红，而 headline 里的
 * 最大震度可能来自别的县）；EEW 恒为 red（警报本质，不能因为预测震度刚好到阈值就降级）；
 * 海啸 / 气象用解析层算好的 severity。
 *
 * 全球源（`locator === 'point'`）必须单独处理：它们没有震度，`maxScale` 恒为 -1，
 * 若沿用震度的路径，一场 M7.4 会被算成 `info`（信息蓝）——既显示不出严重性，
 * 也会在静默时段被当成"非红色等级"静默掉（用户开了红色穿透也收不到）。所以坐标型地震
 * 直接用解析层按震级判定的 `severity`（severityOfMagnitude）。
 */
function hitSeverityOf(alert, m) {
  if (!alert || alert.kind !== 'quake') return alert ? alert.severity : 'info'
  if (alert.locator === 'point') return alert.severity
  const scale = (m && m.region && typeof m.region.scale === 'number') ? m.region.scale : alert.maxScale
  return severityOfScale(scale)
}

// 气象警报的「静默提示」：只在"命中关注地区、但未达 L4 所以没有播报"时留一笔，
// 由侧边栏状态点的悬停提示与设置页显示。
// 注意 L4 以上**必须清掉**它：那时已经真正播报过，再挂着这条（文案是"未达 L4，未播报"）
// 就与事实自相矛盾——这是加测试按钮后暴露出来的问题。
function updateWeatherHint(alert, cfg) {
  if (alert.kind !== 'weather' || alert.cancelled) return
  if ((cfg.disasters || {}).weather === false) return
  const w = cfg.watch || {}
  const lvOf = (r) => (typeof r.level === 'number' ? r.level : alert.level)
  // 只看**关注地区自己的级别**：整条电文最大是 L4 时关注地区可能只有 L3（提示要保留），
  // 反之命中地区已达 L4（已真正播报）就该清掉——否则「未达 L4，未播报」的文案会与事实矛盾。
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
  if (alert.kind === 'eew' && disasters.earthquake === false) return
  if (alert.kind === 'tsunami' && disasters.tsunami === false) return
  if (alert.kind === 'weather' && disasters.weather === false) return
  if (!wasRecentlyAlerted(alert)) {
    addEvent({
      id: alert.id, code: alert.code, kind: alert.kind, label: alert.kindLabel, severity: alert.severity,
      issued: alert.issued, headline: alert.headline + '（未命中：取消 / 解除消息，且此前未提醒过该事件）', hit: false,
    })
    return
  }
  // 取消 / 解除消息不穿透静默（它不是紧急警报，静默期间只记历史）
  if (inQuietHours(cfg)) {
    addEvent({
      id: alert.id, code: alert.code, kind: alert.kind, label: alert.kindLabel, severity: alert.severity,
      issued: alert.issued, headline: alert.headline, hit: true,
      suppressed: true,
      suppressedReason: '静默时段 ' + cfg.quietHours.start + '–' + cfg.quietHours.end + '（取消 / 解除不穿透）',
    })
    return
  }
  alertedEvents.delete(cancelKeyOf(alert)) // 同一条取消只提醒一次
  // 灾害过程已结束：忘掉事件键，这样"解除之后再次发布"会被当成新事件而不是重复（见 10-dedupe）
  forgetEvent(cancelKeyOf(alert))
  if (!claimAlertForTab('cancel:' + (alert.id || cancelKeyOf(alert)), '')) {
    addEvent({
      id: alert.id, code: alert.code, kind: alert.kind, label: alert.kindLabel, severity: alert.severity,
      issued: alert.issued, headline: alert.headline, hit: true,
      suppressed: true, suppressedReason: '其它 DSH 标签页已提醒',
    })
    return
  }
  addEvent({
    id: alert.id, code: alert.code, kind: alert.kind, label: alert.kindLabel, severity: alert.severity,
    issued: alert.issued, headline: alert.headline, hit: true,
  })
  const title = alert.kind === 'eew' ? '✅ 紧急地震速报已取消'
    : (alert.kind === 'tsunami' ? '✅ 海啸预报已解除' : '✅ ' + alert.kindLabel)
  const body = alert.headline + '\n此前发出的警报已作废。\n—— 仅供参考，请以气象厅官方发布为准'
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
 * 处理一条已归一为 Alert 的消息——P2PQuake 的 551/552/556 与気象庁的电文最后都汇到这里，
 * 保证去重 / 匹配 / 静默 / 跨标签页 / 通知 / 历史这六步对两者完全一致。
 * @param {{ skipQuietHours?: boolean }} [opts] 仅供设置页的「发送测试气象警报」使用：
 *   测试的语义是"验证提醒链路"，不该被静默时段悄悄吞掉，否则用户会以为插件坏了。
 * @returns {{ notified: boolean, reason?: string, detail?: string }} 如实回报这一步到底做没做播报，
 *   以及没播报的原因——设置页的测试按钮据此给出准确提示，而不是写死一句"应看到弹窗"。
 */
/**
 * 全球源（坐标型）在用户**没有配置任何「全球关注点」**时整条丢弃，连历史都不记。
 * 理由：EMSC 实测每天推送几十条 M3.8+ 的全球地震。若按"未命中"记入历史，历史列表会被
 * 与用户毫无关系的远地地震刷屏，真正该看见的提醒反而被挤掉。配置了关注点后立即生效
 * （不需要重连或重启），状态点与设置页会提示"全球源已连接但未设置关注点"。
 */
function watchlessPoint(alert, cfg) {
  if (!alert || alert.locator !== 'point') return false
  const places = (cfg.watch && cfg.watch.places) || []
  return places.length === 0
}

function handleAlert(alert, cfg, opts) {
  const options = opts || {}
  if (watchlessPoint(alert, cfg)) {
    return { notified: false, reason: 'no-watch-point', detail: '全球源消息，但未设置全球关注点' }
  }
  // 诊断计数：用 push 带出去，让设置页的"已收到 N 条推送"立刻反映（直接自增不会触发重渲，
  // 徽标会滞后到下一次 push；而 clearSources 时会归零，不再跨代累积）。
  store.push({ received: store.received + 1 })
  // 消息级去重按 alert.id。**但强度升级要放行**：全球源的修订版复用同一个 id
  // （EMSC 的 unid / USGS 的 feature id），一律挡掉会让震级上修永远不再提醒。
  // 放行后由下面的 isEventRepeat 判定"确实升级才播报"，未升级仍只记历史。
  if (isDuplicate(alert.id, cfg.dedupe.windowMinutes) && !isStrengthUpgrade(alert)) {
    return { notified: false, reason: 'duplicate', detail: '同一条消息刚处理过（去重窗口内）' }
  }
  if (alert.cancelled) {
    handleCancelled(alert, cfg)
    return { notified: false, reason: 'cancelled', detail: '这是取消 / 解除消息' }
  }
  const m = matchAlert(alert, cfg)
  if (!m.hit) {
    // 气象警报：即使不播报（L3 及以下），也把"正在升级"留给侧边栏 tooltip
    updateWeatherHint(alert, cfg)
    // 全球源（坐标型）的"未命中"通常不进历史：USGS 的 24 小时目录有近百条 M2.5+，
    // 逐条记"未命中"会把历史列表刷满与用户无关的地震，真正该看的提醒反而被挤掉。
    // **但「坐标缺失」是例外**——那不是"离得远"，而是"根本没法判定"。DESIGN 3.1 要求
    // 这种情况不猜、如实说明；若也丢进 /dev/null，用户看到的就是"根本没有地震"，
    // 与"未设置关注点"（更早由 watchlessPoint 拦下，有意不回历史）是完全不同的两件事。
    if (alert.locator !== 'point' || !validGeo(alert.geo)) {
      addEvent({
        id: alert.id, code: alert.code, kind: alert.kind, label: alert.kindLabel, severity: alert.severity,
        issued: alert.issued, headline: alert.headline + '（未命中：' + m.reason + '）', hit: false,
      })
    }
    return { notified: false, reason: 'not-hit', detail: m.reason }
  }
  const hitPref = m.region ? m.region.pref : ''
  // 严重度见 hitSeverityOf 的注释（全球点型地震此前被算成 info，静默穿透因此失效）
  const hitSeverity = hitSeverityOf(alert, m)
  // 同一次地震的后续发布（速报 → 震源 → 各地震度、或 EEW 多报）强度未升级 → 只更新历史，不再响铃。
  // 气象灾害用更长的事件窗口（见 WEATHER_EVENT_WINDOW_MINUTES 的说明）。
  const repeatWindow = alert.kind === 'weather'
    ? Math.max(cfg.dedupe.windowMinutes || 10, WEATHER_EVENT_WINDOW_MINUTES)
    : cfg.dedupe.windowMinutes
  if (isEventRepeat(alert, repeatWindow)) {
    addEvent({
      id: alert.id, code: alert.code, kind: alert.kind, label: alert.kindLabel, severity: hitSeverity,
      issued: alert.issued, headline: alert.headline, hit: true, pref: hitPref,
      suppressed: true, suppressedReason: '同一地震的后续发布（强度未升级）',
    })
    return { notified: false, reason: 'event-repeat', detail: '同一事件的后续发布，强度未升级' }
  }
  // 静默时段：命中但不响铃、不弹通知，只记历史。红色等级（EEW、大海啸警报）默认可穿透。
  if (!options.skipQuietHours && inQuietHours(cfg) && !(hitSeverity === 'red' && cfg.quietHours.breakForSevere !== false)) {
    addEvent({
      id: alert.id, code: alert.code, kind: alert.kind, label: alert.kindLabel, severity: hitSeverity,
      issued: alert.issued, headline: alert.headline, hit: true, pref: hitPref,
      suppressed: true,
      suppressedReason: '静默时段 ' + cfg.quietHours.start + '–' + cfg.quietHours.end +
        (hitSeverity === 'red' ? '（未开启红色等级穿透）' : ''),
    })
    return { notified: false, reason: 'quiet-hours', detail: '当前处于静默时段' }
  }
  // 其它 DSH 标签页已经播报过同一条消息 → 本标签页静默，避免多个页面同时响铃。
  // 用消息 id 而不是事件键：多标签页收到的是同一条消息，而同一事件的不同消息（如强度升级）不应被拦。
  if (!claimAlertForTab(alert.id, cancelKeyOf(alert))) {
    addEvent({
      id: alert.id, code: alert.code, kind: alert.kind, label: alert.kindLabel, severity: hitSeverity,
      issued: alert.issued, headline: alert.headline, hit: true, pref: hitPref,
      suppressed: true, suppressedReason: '其它 DSH 标签页已提醒',
    })
    return { notified: false, reason: 'other-tab', detail: '其它 DSH 标签页已提醒同一条' }
  }
  const prefZh = (PREFECTURES.find((p) => p.jp === hitPref) || {}).zh || hitPref
  const title = alertTitleOf(alert)
  const bodyLines = [alert.headline]
  if (hitPref) bodyLines.push('命中关注地区：' + prefZh + (prefZh !== hitPref ? '（' + hitPref + '）' : ''))
  // 全球源没有行政区，命中依据是「距某个关注点多少公里」——把距离说出来，
  // 用户才能判断这条提醒是否可信（半径是自己设的）
  else if (m.place) bodyLines.push('命中关注点：' + m.place.name + '（距震中约 ' + Math.round(m.distanceKm) + ' km）')
  if (alert.kind === 'tsunami') bodyLines.push('请立即远离海岸与河口')
  if (alert.kind === 'weather') bodyLines.push('请确认所在市町村的避难信息')
  bodyLines.push('—— 仅供参考，请以气象厅官方发布为准')
  addEvent({
    id: alert.id, code: alert.code, kind: alert.kind, label: alert.kindLabel, severity: hitSeverity,
    issued: alert.issued, headline: alert.headline, hit: true, pref: hitPref,
  })
  updateWeatherHint(alert, cfg)
  const vol = cfg.notify.volume
  if (cfg.notify.sound !== false) playAlertSound(alert, vol)
  const pageVisible = typeof document !== 'undefined' && document.visibilityState === 'visible'
  const body = bodyLines.join('\n')
  if (pageVisible) {
    // 页面可见时只用页内 toast（DESIGN 第 7 节：可见 → toast，后台 → 系统通知）
    showToast({ title, body, color: sevColor(hitSeverity) })
  } else if (cfg.notify.system) {
    const ok = showSystemNotification({ title, body, tag: 'quake-alert-' + alert.id, silent: true })
    if (!ok) showToast({ title, body, color: sevColor(hitSeverity), ttlMs: 20000 })
  }
  rememberAlerted(alert)
  return { notified: true }
}


export { handleCancelled, handleRaw, handleAlert, updateWeatherHint, alertTitleOf, watchlessPoint, hitSeverityOf }
