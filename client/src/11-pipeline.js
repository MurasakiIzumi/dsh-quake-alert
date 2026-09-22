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
import { inQuietHours, own } from './02-storage.js'
import { parse, severityOfScale, sevColor } from './05-parser.js'
import { matchAlert, regionInWeatherWatch, validGeo } from './06-matcher.js'
import { addEvent, store } from './07-store.js'
import { playSound, playAlertSound } from './08-audio.js'
import { showToast, showSystemNotification } from './09-notify.js'
import { isDuplicate, isEventRepeat, isStrengthUpgrade, weakenEvent, forgetEvent, claimAlertForTab, cancelKeyOf, rememberAlerted, wasRecentlyAlerted, alertedEvents } from './10-dedupe.js'

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
 * 大陆源的产品名。日本源与大陆源虽然都叫"地震预警 / 速报"，却是**两家不同机构的不同产品**：
 * 気象庁的是「緊急地震速報」，中国地震台网的是「地震预警」。把日方名称套到大陆源上，
 * 用户会以为收到了日本气象厅的速报——在预警类产品里这是会误导行动的错误。
 */
function cnProductName(alert) {
  if (!alert) return ''
  if (alert.source === 'cenc_eew') return '大陆地震预警'
  if (alert.source === 'cenc_eqlist') return '大陆地震速报'
  return ''
}

/**
 * 通知文案里的「官方发布」指哪家机构。
 *
 * 各源的主管机构完全不同。此前文案里硬编码了「气象厅」，于是希腊的一场 USGS 地震、
 * 四川的一场 CENC 预警都会让用户"以气象厅官方发布为准"——免责声明里出现错误机构，
 * 会直接削弱这份声明本身的可信度。这里按源给出机构名，认不出时退化成中性表述。
 */
const AUTHORITY_BY_SOURCE = {
  emsc: '欧洲-地中海地震中心（EMSC）',
  usgs: '美国地质调查局（USGS）',
  noaa: '太平洋海啸警报中心（NOAA）',
  cenc_eew: '中国地震台网（CENC）',
  cenc_eqlist: '中国地震台网（CENC）',
  // 0.5.2：大陆气象预警的发布主体是**各级气象台**，汇总在中央气象台（中国气象局）的网站上。
  // 免责声明里点名"中央气象台（中国气象局）"而不是泛泛的"气象厅"——后者是日本的机构，
  // 出现在一条云南暴雨预警的免责声明里会直接削弱这份声明的可信度（同上一段的理由）。
  nmc_alarm: '中央气象台（中国气象局）',
  // 0.6.1：海外气象源。不登记的话，一条美国洪水预警的免责声明会退化成泛泛的
  // 「请以官方发布为准」——用户看不出该找哪家机构（与上面 nmc 的理由相同）。
  nws_alerts: '美国国家气象局（NWS）',
  eccc_alerts: '加拿大环境与气候变化部（ECCC）',
  jma: '気象庁',
}
function authorityOf(alert) {
  if (!alert) return ''
  const bySource = own(AUTHORITY_BY_SOURCE, String(alert.source || ''))
  if (bySource) return bySource
  const byCode = own(AUTHORITY_BY_SOURCE, String(alert.code === undefined ? '' : alert.code))
  if (byCode) return byCode
  // P2PQuake 的 551 / 552 / 556 都是转播気象庁的信息（它们只有数字 code，没有 source）
  if (alert.code === 551 || alert.code === 552 || alert.code === 556) return '気象庁'
  return ''
}
/** 「仅供参考」那一行。机构已知时点名，未知时用中性表述（不硬编码日本气象厅）。 */
function disclaimerOf(alert) {
  const a = authorityOf(alert)
  return a ? '—— 仅供参考，请以' + a + '官方发布为准' : '—— 仅供参考，请以官方发布为准'
}

/**
 * 气象预警的**行动提示**：三家机构的处置口径不同，不能互相套用（0.6.2）。
 *
 * · 日本气象电文 → 市町村级的避难信息（日本の避難情報）
 * · 大陆气象预警 → 各级气象台发布的防御指引（没有"市町村"这个行政层级）
 * · 海外气象（NWS / ECCC）→ 当地官方发布的避难与撤离指引
 * 认定不出来源时退回**中性**表述，而不是默认套日本的制度（同 disclaimerOf 的取向）。
 */
function weatherActionHintOf(alert) {
  if (!alert) return '请关注当地官方发布的指引'
  if (alert.locator === 'overseas') return '请关注当地官方发布的避难与撤离指引'
  if (alert.locator === 'area') return '请关注当地气象台发布的防御指引'
  return '请确认所在市町村的避难信息'
}

/**
 * 系统通知 / 页内 toast 的标题。抽成纯函数是为了能直接断言文案——
 * 旧写法把「地震情报 · 」与「各地震度」分开拼，非「各地」分支会留下一个悬空的分隔符。
 */
function alertTitleOf(alert) {
  if (!alert) return '灾害预警'
  // kindLabel 本身已区分「地震速报·震度速报」「地震情报·各地震度」等，不需要再拼后缀
  if (alert.kind === 'eew') return '⚠ ' + (cnProductName(alert) || '紧急地震速报（警报）')
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
  // 只对**日本气象电文**生效（0.5.4）：大陆气象源（nmc_alarm，`locator === 'area'`）的
  // `regions` 恒为空数组（归属在 cnArea 里），于是这里的 `hit` 恒为 undefined，
  // 每一条大陆预警都会走到下面的"清空提示"分支，把日本电文刚留下的
  // 「L3 正在升级、未达 L4」抹成 null——两家机构、两个地区的两件事，不该互相清。
  // 0.6.0 review：**海外气象源（`locator === 'overseas'`）是同一个形态的更严重版本**——
  // 它的 `regions` 同样恒为空（05h），而它每 2 分钟就可能来一条（NWS 的 Watch/Advisory 也在其中），
  // 于是侧边栏那条日本 L3 提示会被一条美国预警反复抹掉。两条路径一起排除。
  if (alert.locator === 'area' || alert.locator === 'overseas') return
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
  // 历史条目带上解析层给出的正文（0.6.1 review）：NWS 的 description + instruction、ECCC 的
  // 正文 + 署名此前**没有任何消费者**——`addEvent` 会被 normalizeHistoryEntry 过滤掉未列出的
  // 字段，展开详情也只渲染 headline。而 instruction 恰恰是"该怎么做"，署名是 ECCC 许可
  //（End-use Licence v2.1.1）的硬要求。见 07-store / 02-storage 的 detail 字段。
  const pushEvent = (fields) => addEvent(Object.assign({ detail: alert.detail }, fields))
  if (alert.kind === 'eew' && disasters.earthquake === false) return
  if (alert.kind === 'tsunami' && disasters.tsunami === false) return
  // 气象的开关按**来源**分岔（0.6.1 review）：海外源由它自己的 `overseasWeather` 管
  // （见 12e 的 enabled 判定与 13-ui 的设置项）。此前统一看日本气象的 `weather`，
  // 于是"关掉日本气象、保留海外源"的用户收到过洪水播报，却永远收不到它的作废提醒——
  // 取消链路承诺的正是这一条（CHANGELOG 0.6.0「此前播报的警报已作废」）。
  if (alert.kind === 'weather') {
    const off = alert.locator === 'overseas' ? disasters.overseasWeather === false : disasters.weather === false
    if (off) return
  }
  if (!wasRecentlyAlerted(alert)) {
    pushEvent({
      id: alert.id, code: alert.code, kind: alert.kind, label: alert.kindLabel, severity: alert.severity,
      issued: alert.issued, headline: alert.headline + '（未命中：取消 / 解除消息，且此前未提醒过该事件）', hit: false,
    })
    return
  }
  // 取消 / 解除消息不穿透静默（它不是紧急警报，静默期间只记历史）
  if (inQuietHours(cfg)) {
    pushEvent({
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
    pushEvent({
      id: alert.id, code: alert.code, kind: alert.kind, label: alert.kindLabel, severity: alert.severity,
      issued: alert.issued, headline: alert.headline, hit: true,
      suppressed: true, suppressedReason: '其它 DSH 标签页已提醒',
    })
    return
  }
  pushEvent({
    id: alert.id, code: alert.code, kind: alert.kind, label: alert.kindLabel, severity: alert.severity,
    issued: alert.issued, headline: alert.headline, hit: true,
  })
  const title = alert.kind === 'eew'
    ? '✅ ' + (cnProductName(alert) || '紧急地震速报') + '已取消'
    : (alert.kind === 'tsunami' ? '✅ 海啸预报已解除' : '✅ ' + alert.kindLabel)
  const body = alert.headline + '\n此前发出的警报已作废。\n' + disclaimerOf(alert)
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
  // 历史条目统一带上解析层的正文（0.6.1 review，理由同 handleCancelled 里的说明）。
  const pushEvent = (fields) => addEvent(Object.assign({ detail: alert.detail }, fields))
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
  // 气象强度的**回落**要在命中与未命中两条路径上都写回事件记忆（0.6.1 review）。
  // 日本气象电文的命中闸门与强度是同一个 level（L4），回落必然走 !m.hit 分支，所以只在那里
  // 下调曾经是对的；而海外气象源的**档位**由 event 名（NWS）或颜色档（ECCC）决定、**强度**
  // 由 severity 决定——两条正交。于是"NWS 的 Flood Warning 从 Severe 降到 Moderate"仍然命中
  // （档位不变），记忆强度不会被下调；随后回升时 `isStrengthUpgrade` 判 false → 永久静默，
  // 正是 weakenEvent 注释里声明要防住的那条漏报。它只在强度确实更低时下调，所以对未命中
  // 路径（"关注地区未命中"）没有副作用。
  if (alert.kind === 'weather') weakenEvent(alert)
  if (!m.hit) {
    // 气象警报：即使不播报（L3 及以下），也把"正在升级"留给侧边栏 tooltip
    updateWeatherHint(alert, cfg)
    // 全球源（坐标型）的"未命中"通常不进历史：USGS 的 24 小时目录有近百条 M2.5+，
    // 逐条记"未命中"会把历史列表刷满与用户无关的地震，真正该看的提醒反而被挤掉。
    // **但「坐标缺失」是例外**——那不是"离得远"，而是"根本没法判定"。DESIGN 3.1 要求
    // 这种情况不猜、如实说明；若也丢进 /dev/null，用户看到的就是"根本没有地震"，
    // 与"未设置关注点"（更早由 watchlessPoint 拦下，有意不回历史）是完全不同的两件事。
    //
    // 0.5.4：`m.noWatch`（**未配置**关注点，命中概率恒为 0）同样不进历史。大陆气象源
    // （nmc_alarm）走行政区匹配，不在 watchlessPoint 的覆盖范围内，而它默认就在拉——
    // 一条都没配大陆关注点的用户，每天会有几十条「未命中：未设置中国大陆关注点」挤进
    // HISTORY_MAX=30 的「最近预警」，真正的地震 / 海啸提醒被挤出去。这与坐标型源那条
    // 「真正的提醒会被刷掉」是同一个失败形态（DESIGN 3.2 对 point 源已定过这个口径）。
    // 与坐标型的差别是**不整条丢弃**：设置页与诊断仍需要"有预警、但你没配关注点"这个信息。
    if (!m.noWatch && (alert.locator !== 'point' || !validGeo(alert.geo))) {
      pushEvent({
        id: alert.id, code: alert.code, kind: alert.kind, label: alert.kindLabel, severity: alert.severity,
        issued: alert.issued, headline: alert.headline + '（未命中：' + m.reason + '）', hit: false,
      })
    }
    return { notified: false, reason: 'not-hit', detail: m.reason }
  }
  const hitPref = m.region ? m.region.pref : ''
  // 严重度见 hitSeverityOf 的注释（全球点型地震此前被算成 info，静默穿透因此失效）
  const hitSeverity = hitSeverityOf(alert, m)
  // 跨会话重放**探测**（0.4.2）：Host 重启后会按冷启动回看窗口（USGS 6 小时 / NOAA 24 小时）把
  // 缓冲里的事件重新投递，而 Client 的消息级 / 事件级去重都是 10 分钟的内存窗口——页面没刷新时
  // 早已过期，同一场地震会被再报一次。`alertedEvents`（"真正播报过"的记忆）保留 24 小时，
  // 正好用来挡这种重放。
  // **必须在这里先算**：isEventRepeat 会把 strength 更新成本次的值，之后 isStrengthUpgrade 就
  // 永远是 false。也不能直接在这里就抑制——同一会话内的"后续发布"（震度速报 → 各地震度）
  // 应该由 isEventRepeat 归类为更准确的"同一地震的后续发布"，而不是笼统的"重放"。
  const looksReplayed = wasRecentlyAlerted(alert) && !isStrengthUpgrade(alert)
  // 同一次地震的后续发布（速报 → 震源 → 各地震度、或 EEW 多报）强度未升级 → 只更新历史，不再响铃。
  // 气象灾害用更长的事件窗口（见 WEATHER_EVENT_WINDOW_MINUTES 的说明）。
  const repeatWindow = alert.kind === 'weather'
    ? Math.max(cfg.dedupe.windowMinutes || 10, WEATHER_EVENT_WINDOW_MINUTES)
    : cfg.dedupe.windowMinutes
  if (isEventRepeat(alert, repeatWindow)) {
    pushEvent({
      id: alert.id, code: alert.code, kind: alert.kind, label: alert.kindLabel, severity: hitSeverity,
      issued: alert.issued, headline: alert.headline, hit: true, pref: hitPref,
      suppressed: true, suppressedReason: '同一地震的后续发布（强度未升级）',
    })
    return { notified: false, reason: 'event-repeat', detail: '同一事件的后续发布，强度未升级' }
  }
  // 事件级去重没拦下、但记忆说"这个事件在 24 小时内已经真正播报过" → 判为跨会话重放
  // （Host 重启按回看窗口重投），只记历史不响铃。
  //
  // 0.5.4 修正**文案**：`looksReplayed` 的判据是 24 小时的已提醒记忆，它覆盖的不只是
  // Host 回看窗口的重投，还包括"同一官署同一灾种在 3 小时事件窗口之后、24 小时之内等强度的
  // 第二次独立发布"（气象事件尤其如此）。旧文案把原因写成"Host 重启 / 重连后的重放"，
  // 会让排查的人去翻 Host 重启日志，而真正生效的是长期事件记忆。行为方向是安全的
  // （不重复响铃），所以只改措辞、不改判据。
  if (looksReplayed) {
    pushEvent({
      id: alert.id, code: alert.code, kind: alert.kind, label: alert.kindLabel, severity: hitSeverity,
      issued: alert.issued, headline: alert.headline, hit: true, pref: hitPref,
      suppressed: true, suppressedReason: '同一事件在最近 24 小时内已提醒过（等强度，不重复响铃）',
    })
    return { notified: false, reason: 'replayed', detail: '该事件在最近 24 小时内已经提醒过，本次只记历史' }
  }
  // 打开页面时才发现的老预警（0.6.0 的年龄闸门，DESIGN 4.7.6）：**仍然命中、仍然进历史**，
  // 但不响铃、不弹通知——海外气象源是**按关注点查询**的，页面一打开就会把当前生效的预警全拉回来，
  // 其中可能有几小时前发布、仍在生效的洪水预警（有效期实测中位 12.6 小时）。把那些当"刚刚发生"
  // 播报是纯粹的打扰；整条丢掉又会让用户看不到"就在打开页面前发布的那一条"。
  // 与"静默时段"分开成两条 reason：那个是用户自己设的时段，这个是数据本身发布得早。
  //
  // **位置有讲究**（0.6.0 review 修正）：必须放在 `isEventRepeat` **之后**。放在它之前会绕过
  // 事件级记忆的更新——同一条老预警每过一轮消息级去重窗口（10 分钟）就会再进一次历史，
  // 30 条的历史列表会被同一条老预警占满、真正的提醒被挤出去（正是 11.10 第 4 条那个形态）。
  // 放在后面时：第一次到达由本分支记历史，而 isEventRepeat 已经把事件写进记忆，
  // 后续轮次会被判成"同一事件的后续发布"，不再重复进历史。
  if (options.staleOnArrival) {
    const hours = typeof options.staleOnArrival === 'number' ? options.staleOnArrival : 0
    // **同时记进"已提醒过"的 24 小时记忆**（0.6.0 review B-4）：只靠 `isEventRepeat` 的事件窗口
    // （气象 3 小时）不够——窗口一过，同一条仍在生效的老预警会被判成新事件、在开着的页面里响铃
    //（洪水有效期中位 12.6 小时 → 一天可能响 3〜4 次，而用户刚被告知"只记历史，不打扰"）。
    // 记进这条记忆之后，后面的 `looksReplayed` 分支会把它拦住。
    rememberAlerted(alert)
    pushEvent({
      id: alert.id, code: alert.code, kind: alert.kind, label: alert.kindLabel, severity: hitSeverity,
      issued: alert.issued, headline: alert.headline, hit: true, pref: hitPref,
      suppressed: true,
      suppressedReason: '打开页面时该预警已发布约 ' + hours + ' 小时（只记历史，不打扰）',
    })
    return { notified: false, reason: 'stale-on-arrival', detail: '发布较早，仅记录' }
  }
  // 静默时段：命中但不响铃、不弹通知，只记历史。红色等级（EEW、大海啸警报）默认可穿透。
  if (!options.skipQuietHours && inQuietHours(cfg) && !(hitSeverity === 'red' && cfg.quietHours.breakForSevere !== false)) {
    pushEvent({
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
    pushEvent({
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
  // 用户才能判断这条提醒是否可信（半径是自己设的）。
  //
  // **判据是"有没有真实距离"，不是"是哪个源"**（0.6.1 写了前者的一半，0.6.2 补全）：
  // 只有坐标型源（`locator === 'point'`，见 matchPointAlert）会给出 `distanceKm`；
  // 海外气象（查询即匹配）与大陆气象（行政区层级）都只给关注点，于是它们落到下面那一支时
  // `Math.round(undefined)` 会拼出「距震中约 NaN km」，还把一场暴雨 / 洪水说成"震中"。
  // 0.6.1 只给 `locator === 'overseas'` 分了岔，**大陆源仍然带着这个错误文案上线**——
  // 现在按距离是否存在分岔，任何"没有距离的行政/查询型命中"都走同一支。
  else if (m.place && typeof m.distanceKm === 'number' && Number.isFinite(m.distanceKm)) {
    bodyLines.push('命中关注点：' + m.place.name + '（距震中约 ' + Math.round(m.distanceKm) + ' km）')
  } else if (m.place) {
    bodyLines.push('命中关注点：' + m.place.name + '（按该点所在地的官方预警判定）')
  }
  if (alert.kind === 'tsunami') bodyLines.push('请立即远离海岸与河口')
  // 行动提示按**机构**分岔（0.6.1 加海外那一支，0.6.2 补大陆那一支）：日本气象电文对应的是
  // 市町村级的避难信息，中国大陆的预警由各级气象台发布、处置口径不同，而美加的洪水预警由
  // 当地应急部门（county / 省）发布——把日本制度套到别处既找不到对应入口，也会误导行动。
  if (alert.kind === 'weather') bodyLines.push(weatherActionHintOf(alert))
  bodyLines.push(disclaimerOf(alert))
  pushEvent({
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


export { handleCancelled, handleRaw, handleAlert, updateWeatherHint, alertTitleOf, watchlessPoint, hitSeverityOf, cnProductName, authorityOf, disclaimerOf, weatherActionHintOf }
