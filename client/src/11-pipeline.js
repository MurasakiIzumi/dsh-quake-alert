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
import { matchAlert, regionInWeatherWatch } from './06-matcher.js'
import { addEvent, store } from './07-store.js'
import { playSound, playAlertSound } from './08-audio.js'
import { showToast, showSystemNotification } from './09-notify.js'
import { isDuplicate, isEventRepeat, claimAlertForTab, cancelKeyOf, rememberAlerted, wasRecentlyAlerted, alertedEvents } from './10-dedupe.js'

// ---------- 主链：收到消息 ----------
// 区域文案：府県予報区级的条目里 area 与 pref 常是同一个名字（「東京都」+「東京都」），
// 直接拼接会显示成「東京都東京都」。
function areaLabelOf(region) {
  const name = region.city || region.area || ''
  if (!name) return region.pref || ''
  if (!region.pref || name === region.pref || name.indexOf(region.pref) === 0) return name
  return region.pref + name
}

// 气象警报的「静默提示」：只在"命中关注地区、但未达 L4 所以没有播报"时留一笔，
// 由侧边栏状态点的悬停提示与设置页显示。
// 注意 L4 以上**必须清掉**它：那时已经真正播报过，再挂着这条（文案是"未达 L4，未播报"）
// 就与事实自相矛盾——这是加测试按钮后暴露出来的问题。
function updateWeatherHint(alert, cfg) {
  if (alert.kind !== 'weather' || alert.cancelled) return
  if ((cfg.disasters || {}).weather === false) return
  if (alert.level !== 3) {
    if (store.weatherHint) store.push({ weatherHint: null })
    return
  }
  const hit = alert.regions.find((r) => regionInWeatherWatch(r, cfg.watch || {}))
  if (!hit) return
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
  if (!wasRecentlyAlerted(alert, cfg.dedupe.windowMinutes)) {
    addEvent({
      id: alert.id, kind: alert.kind, label: alert.kindLabel, severity: alert.severity,
      issued: alert.issued, headline: alert.headline + '（未命中：取消 / 解除消息，且此前未提醒过该事件）', hit: false,
    })
    return
  }
  // 取消 / 解除消息不穿透静默（它不是紧急警报，静默期间只记历史）
  if (inQuietHours(cfg)) {
    addEvent({
      id: alert.id, kind: alert.kind, label: alert.kindLabel, severity: alert.severity,
      issued: alert.issued, headline: alert.headline, hit: true,
      suppressed: true,
      suppressedReason: '静默时段 ' + cfg.quietHours.start + '–' + cfg.quietHours.end + '（取消 / 解除不穿透）',
    })
    return
  }
  alertedEvents.delete(cancelKeyOf(alert)) // 同一条取消只提醒一次
  if (!claimAlertForTab('cancel:' + (alert.id || cancelKeyOf(alert)), '')) {
    addEvent({
      id: alert.id, kind: alert.kind, label: alert.kindLabel, severity: alert.severity,
      issued: alert.issued, headline: alert.headline, hit: true,
      suppressed: true, suppressedReason: '其它 DSH 标签页已提醒',
    })
    return
  }
  addEvent({
    id: alert.id, kind: alert.kind, label: alert.kindLabel, severity: alert.severity,
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
function handleAlert(alert, cfg, opts) {
  const options = opts || {}
  store.received += 1
  if (isDuplicate(alert.id, cfg.dedupe.windowMinutes)) {
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
    // 不打扰：仅在设置页历史记录里记为"未命中"，便于用户核对配置
    addEvent({
      id: alert.id, kind: alert.kind, label: alert.kindLabel, severity: alert.severity,
      issued: alert.issued, headline: alert.headline + '（未命中：' + m.reason + '）', hit: false,
    })
    return { notified: false, reason: 'not-hit', detail: m.reason }
  }
  const hitPref = m.region ? m.region.pref : ''
  // 严重度：地震按「命中区域的实际强度」判定（关注县震度低时颜色不该是红）；
  // EEW 恒为 red（警报本质，不能因为预测震度刚好到阈值就降级成橙色）；
  // 海啸用自身等级（MajorWarning / Warning → red，Watch → orange）。
  const hitSeverity = alert.kind === 'quake'
    ? severityOfScale(m.region && typeof m.region.scale === 'number' ? m.region.scale : alert.maxScale)
    : alert.severity
  // 同一次地震的后续发布（速报 → 震源 → 各地震度、或 EEW 多报）强度未升级 → 只更新历史，不再响铃
  if (isEventRepeat(alert, cfg.dedupe.windowMinutes)) {
    addEvent({
      id: alert.id, kind: alert.kind, label: alert.kindLabel, severity: hitSeverity,
      issued: alert.issued, headline: alert.headline, hit: true, pref: hitPref,
      suppressed: true, suppressedReason: '同一地震的后续发布（强度未升级）',
    })
    return { notified: false, reason: 'event-repeat', detail: '同一事件的后续发布，强度未升级' }
  }
  // 静默时段：命中但不响铃、不弹通知，只记历史。红色等级（EEW、大海啸警报）默认可穿透。
  if (!options.skipQuietHours && inQuietHours(cfg) && !(hitSeverity === 'red' && cfg.quietHours.breakForSevere !== false)) {
    addEvent({
      id: alert.id, kind: alert.kind, label: alert.kindLabel, severity: hitSeverity,
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
      id: alert.id, kind: alert.kind, label: alert.kindLabel, severity: hitSeverity,
      issued: alert.issued, headline: alert.headline, hit: true, pref: hitPref,
      suppressed: true, suppressedReason: '其它 DSH 标签页已提醒',
    })
    return { notified: false, reason: 'other-tab', detail: '其它 DSH 标签页已提醒同一条' }
  }
  const prefZh = (PREFECTURES.find((p) => p.jp === hitPref) || {}).zh || hitPref
  const title = {
    eew: '⚠ 紧急地震速报（警报）',
    quake: '🌐 地震情报 · ' + (alert.kindLabel.indexOf('各地') !== -1 ? '各地震度' : ''),
    tsunami: '🌊 ' + alert.kindLabel,
    weather: '🌧 ' + alert.kindLabel,
  }[alert.kind] || '灾害预警'
  const bodyLines = [alert.headline]
  if (hitPref) bodyLines.push('命中关注地区：' + prefZh + (prefZh !== hitPref ? '（' + hitPref + '）' : ''))
  if (alert.kind === 'tsunami') bodyLines.push('请立即远离海岸与河口')
  if (alert.kind === 'weather') bodyLines.push('请确认所在市町村的避难信息')
  bodyLines.push('—— 仅供参考，请以气象厅官方发布为准')
  addEvent({
    id: alert.id, kind: alert.kind, label: alert.kindLabel, severity: hitSeverity,
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


export { handleCancelled, handleRaw, handleAlert, updateWeatherHint }
