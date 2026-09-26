// ============================================================================
// dsh-quake-alert · client/src/13-ui-settings.js
//
// 作用：设置页面板（设置 → 灾害预警）的全部 UI。
// 内容：连接状态与数据源、关注地区（都道府县 + 市区町村搜索多选）、
//       三类阈值、通知与声音（含音量防抖落盘）、静默时段、免责声明、最近预警记录。
// 依赖：01-constants、02-storage、03-settings-bridge、04-city-table、07-store、08-audio、09-notify。
// 约定：所有写入都经 applyCfg，保证内存/镜像/Host 三处一致。
// ============================================================================

import { h, useState, useEffect, useRef, PREFECTURES, SCALE_OPTIONS, TSUNAMI_OPTIONS, GLOBAL_MAG_OPTIONS, CN_REPORT_MAG_OPTIONS, RADIUS_PRESETS, DEFAULT_PLACE_RADIUS_KM, MIN_PLACE_RADIUS_KM, MAX_PLACE_RADIUS_KM, HISTORY_MAX, HISTORY_KEY, MAX_WATCH_CITIES, MAX_WATCH_PLACES, LANGUAGE_OPTIONS, formatIssuedLocal } from './01-constants.js'
import { saveJSON, own } from './02-storage.js'
import { currentCfg, applyCfg, settingsSync } from './03-settings-bridge.js'
import { citiesOfPref, cityTableState, cnProvinces, cnCitiesOf, cnPlaceOf, worldCountriesOf, countryPackOf, loadCountryCities } from './04-city-table.js'
import { cnStreamRegistry } from './12c-cn-stream.js'
import { copyDiagSnapshot } from './16-diag.js'
import { parseJma, buildTestTelegram, TEST_SCENARIOS } from './05b-jma-parser.js'
import { TEST_GEO_SCENARIOS, buildTestGlobalMessage, parseTestGlobalMessage } from './05c-global-parsers.js'
import { store } from './07-store.js'
import { playSound, unlockAudio, audioState } from './08-audio.js'
import { showToast, showSystemNotification, notificationPermission, requestNotificationPermission } from './09-notify.js'
import { handleAlert } from './11-pipeline.js'
import { activeClient } from './12-websocket.js'
import { feedStatsOf } from './12b-feed-poll.js'
import { overseasStatsOf } from './12e-overseas-poll.js'
import { broadcastHistoryCleared } from './10-dedupe.js'
import { retrySource } from './05g-source-health.js'

// ---------- 设置页 UI ----------
// 连接状态 → 颜色 / 文案（设置页与侧边栏状态指示共用）
function statusMetaOf(status, retries) {
  return {
    idle: { color: '#7c8494', text: '未启动' },
    connecting: { color: '#d9a406', text: '连接中…' },
    open: { color: '#4ade80', text: '已连接' },
    reconnecting: { color: '#d9a406', text: '重连中（第 ' + retries + ' 次）' },
    closed: { color: '#e5484d', text: '已停止' },
    // 0.4.1：轮询源与"消息处理失败"也需要自己的状态。此前只有 WebSocket 的五个状态，
    // 于是上游被墙 / 路由 500 / 主链抛错时界面上与"没有新闻"完全不可区分。
    unreachable: { color: '#e5484d', text: '无法连接' },
    degraded: { color: '#d9a406', text: '链路降级' },
    stale: { color: '#8b8f98', text: '数据已过期' },
    'schema-error': { color: '#3b82f6', text: '数据格式异常' },
    disabled: { color: '#7c8494', text: '已关闭' },
  }[status] || { color: '#7c8494', text: String(status) }
}
// 配置存储位置的人话说明（settings.yaml / 进程内 / localStorage）
function settingsSyncLabel() {
  return {
    host: '保存在本机（settings.yaml）',
    memory: '只保存在这个浏览器里',
    local: '浏览器本地存储',
  }[settingsSync] || String(settingsSync)
}
// 历史条目「类型」行显示的 P2PQuake code。气象电文不在此表里（它不是 P2PQuake 来源），
// 索引一律经 own()，避免外部数据里的 'constructor' 之类的键命中原型链。
const P2P_KIND_CODE = { quake: 551, eew: 556, tsunami: 552 }
/** alert.code → 来源标注（全球源、JMA 电文与大陆源没有 P2PQuake 的 code）。 */
const SOURCE_CODE_TEXT = {
  emsc: 'EMSC', usgs: 'USGS', noaa: 'NOAA CAP', jma: 'JMA 电文',
  cenc_eew: 'CENC 预警', cenc_eqlist: 'CENC 速报',
  // 0.5.2：大陆气象预警的发布主体是各级气象台、由中央气象台汇总。标成「JMA 电文」会让
  // 一条云南暴雨预警看起来来自日本气象厅（同 SOURCE_CODE_TEXT 存在的理由）。
  nmc_alarm: '中央气象台',
  // 0.6.0：海外气象源。机构名不能省——一条多伦多的降雨预警被标成「JMA 电文」是同一类错误，
  // 而 ECCC 的许可（End-use Licence v2.1.1）本身就要求署名。
  nws_alerts: 'NWS', eccc_alerts: 'ECCC',
}
/**
 * 历史条目「类型」行的来源标注。
 *
 * 0.4.1：优先用 alert.code，而不是 kind。全球地震（EMSC / USGS）的 kind 也是 'quake'，
 * 只看 kind 会把它们标成「code 551」（P2PQuake 的震度速报）——与 0.3.2 修过的
 * "气象条目被标成 code 551"是同一类错误。
 * 0.4.2 补两处兜底：① 数值 code 经 `strOr` 变成字符串后也能显示成 `code N`；
 * ② **旧历史**（0.4.1 之前写入）没有 code 字段，用 id 前缀（emsc: / usgs: / noaa:）认出来源。
 */
function p2pCodeTextOf(kind, code, id) {
  const codeStr = String(code === undefined || code === null ? '' : code)
  const byCode = own(SOURCE_CODE_TEXT, codeStr)
  if (byCode) return byCode
  if (/^\d{3}$/.test(codeStr)) return 'code ' + codeStr
  const idStr = String(id === undefined || id === null ? '' : id)
  if (idStr.indexOf('emsc:') === 0) return 'EMSC'
  if (idStr.indexOf('usgs:') === 0) return 'USGS'
  if (idStr.indexOf('noaa:') === 0) return 'NOAA CAP'
  if (idStr.indexOf('cenc:') === 0) return 'CENC 大陆'
  // 0.5.2：大陆气象源（新的历史条目走 code，这里兜住"更早写入的"这条路径）
  if (idStr.indexOf('nmc:') === 0) return '中央气象台'
  // 0.6.0：海外气象源同理（`code` 缺失的历史条目靠 id 前缀认出来源）
  if (idStr.indexOf('nws:') === 0) return 'NWS'
  if (idStr.indexOf('eccc:') === 0) return 'ECCC'
  const c = own(P2P_KIND_CODE, kind)
  if (c) return 'code ' + c
  // 兜底：气象（kind='weather'）在 0.5.2 之前只有日本这一个来源。现在有了大陆气象源，
  // 所以这里的兜底必须注明它是**日方**的，而不是把两者混起来（大陆那条在上面的 id / code 分支已拦下）。
  return kind === 'weather' ? 'JMA 电文' : '—'
}
// 灾种配色：气象灾害此前没有键，历史条目一律落到灰色兜底，与另外三类不一致
const KIND_COLORS = { eew: '#e5484d', quake: '#3b82f6', tsunami: '#f76b15', weather: '#8b5cf6' }
const kindColorOf = (kind) => own(KIND_COLORS, kind) || '#7c8494'
/**
 * 下拉框的自绘箭头（data URI）。
 *
 * 为什么不用浏览器的原生箭头（0.8.1 修）：原生化箭头的**水平位置由浏览器决定**，而我们的
 * 下拉带 `min-width: 180px`——当选项文字比这短时（例如语言下拉只有"简体中文"），框比内容宽，
 * 箭头看上去就落在框中段而不是贴着右边缘（用户报告："下箭头不贴在框的右边而在中间"）。
 * 自绘的箭头位置由 `background-position` 固定，框多宽都贴右 8px；顺带也让各平台长相一致。
 */
const SELECT_ARROW = "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='6'%3E%3Cpath d='M1 1l4 4 4-4' fill='none' stroke='%236b7280' stroke-width='1.6' stroke-linecap='round'/%3E%3C/svg%3E\")"
const s = {
  section: (title, ...children) => h('div', { style: { padding: '14px 16px', borderBottom: '1px solid rgba(148,163,184,0.14)' } },
    h('div', { style: { fontWeight: 700, fontSize: 13, marginBottom: 10, color: '#dfe3e8' } }, title), ...children),
  label: (text) => h('div', { style: { color: '#9aa0a6', fontSize: 12, marginBottom: 4 } }, text),
  row: (...children) => h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', margin: '4px 0' } }, ...children),
  checkbox: (checked, onChange, text) => h('label', { style: { display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, cursor: 'pointer', color: '#dfe3e8' } },
    h('input', { type: 'checkbox', checked, onChange: (e) => onChange(e.target.checked) }), text),
  // `label`（第 5 参）渲染成 `aria-label`（0.5.4）。此前每个下拉旁边只有一个视觉上的 div
  // 文字，两者在 DOM 里没有任何关联——读屏软件念到的是"组合框"，用户无法知道哪个是震度阈值。
  // 全库此前只有历史条目与状态点两处 aria 属性（CHANGELOG 记过），而 DESIGN 从未把无障碍
  // 记为"有意不做"，所以这是遗漏而不是取舍。
  // `extra`（第 6 参）：调用方追加的样式（例如语言下拉要 `flex: 1` 撑满一行）。
  // 合并顺序有讲究（0.8.2 review）：自绘箭头的三项**写在 `extra` 之后**。`background` 是简写，
  // 调用方只要带上它就会把 `backgroundImage` 一起清掉、而且不报任何错（0.8.1 修过一次同一个坑），
  // 所以关键样式最后落，任何 extra 都盖不掉。
  select: (value, options, onChange, textOf, label, extra) => h('select', {
    value, onChange: (e) => onChange(e.target.value),
    'aria-label': label || undefined,
    style: Object.assign({
      // 用 `backgroundColor` 而不是 `background`：后者是简写，会把下面的 backgroundImage 一起清掉
      backgroundColor: '#ffffff', color: '#1a1a1a', border: '1px solid #6b7280', borderRadius: 6,
      // 右侧留 26px 给箭头（自绘的，位置由 backgroundPosition 定）
      padding: '4px 26px 4px 8px', fontSize: 12, minWidth: 180,
      appearance: 'none', WebkitAppearance: 'none', MozAppearance: 'none',
    }, extra || {}, {
      backgroundImage: SELECT_ARROW, backgroundRepeat: 'no-repeat',
      backgroundPosition: 'right 8px center', backgroundSize: '10px 6px',
    }),
  }, options.map((o) => h('option', {
    key: String(o.v !== undefined ? o.v : o.g), value: String(o.v !== undefined ? o.v : o.g),
    style: { background: '#ffffff', color: '#1a1a1a' },
  }, textOf(o)))),
  btn: (text, onClick, extra) => h('button', {
    onClick,
    style: Object.assign({ background: 'rgba(148,163,184,0.12)', color: 'inherit', border: '1px solid rgba(148,163,184,0.35)', borderRadius: 6, padding: '5px 12px', cursor: 'pointer', fontSize: 12 }, extra || {}),
  }, text),
}

/**
 * 折叠的次要说明（原生 `<details>`）。
 *
 * 0.8.1 起设置页只把**一句判据**留在主视野里，解释、边界与许可署名收进这里。
 * 此前它们平铺在选项旁边，一条就能占三五行——结果是"要找的开关被埋在说明里"，
 * 而真正需要这些细节的人（排查、合规核对）反而不介意多点一次。
 *
 * 信息一条都没少：`<details>` 的内容始终在 DOM 里（可搜索、可读屏、可复制），
 * 只是默认不占地方。用原生元素而不是 useState，是因为不必维护展开状态，
 * 而且浏览器自带键盘可达与"展开 / 收起"的语义。
 */
const fold = (summary, ...children) => h('details', { style: { marginTop: 6 } },
  h('summary', { style: { fontSize: 11, color: '#8b93a1', cursor: 'pointer', width: 'fit-content' } }, summary),
  h('div', {
    style: {
      fontSize: 11, color: '#9aa0a6', lineHeight: 1.7, marginTop: 5, paddingLeft: 10,
      borderLeft: '2px solid rgba(148,163,184,0.2)',
    },
  }, ...children))

/** 轮询源的中文标签（状态区块与详情共用）。 */
const SOURCE_LABELS = {
  p2pquake: 'P2PQuake（日本地震 / EEW / 海啸，实时推送）',
  emsc: 'EMSC（全球地震，实时推送）',
  cenc_eew: '大陆地震预警（CENC，SSE 推送）',
  cenc_eqlist: '大陆地震速报（CENC，SSE 推送）',
  jma: '気象庁（气象灾害，Host 轮询）',
  usgs: 'USGS（全球地震目录，Host 轮询）',
  noaa: 'NOAA（海啸 CAP，Host 轮询）',
  nmc_alarm: '中央气象台（大陆暴雨 / 地质灾害预警，Host 轮询）',
  // 0.6.0：两个海外源都是 **Client 直连的 REST 轮询**（CORS 实测允许），不走 Host。
  nws_alerts: 'NWS（美国洪水 / 山洪 / 沿海洪水，Client 直连）',
  eccc_alerts: 'ECCC（加拿大降雨 / 风暴潮预警，Client 直连）',
}
/**
 * 源状态区块里的源顺序与分组。**一处维护**：此前同样的列表在三个地方各写一遍
 * （状态行、增量计数行、重试按钮），加一个源要改三处——漏掉任何一处就变成
 * "某个源坏了但界面上看不见"，而"让失败可见"正是这个区块存在的全部理由。
 */
const SOURCE_ORDER = ['p2pquake', 'emsc', 'cenc_eew', 'cenc_eqlist', 'jma', 'usgs', 'noaa', 'nmc_alarm', 'nws_alerts', 'eccc_alerts']
/** 走 `/feed` 增量计数的源（feedStatsOf 有快照）。大陆地震源走 SSE，另有自己的计数与链路模式。 */
const FEED_STAT_ORDER = ['jma', 'usgs', 'noaa', 'nmc_alarm']
/** 走 SSE 的源（0.5.0）：状态从 cnStreamRegistry 实时读。 */
const STREAM_ORDER = ['cenc_eew', 'cenc_eqlist']
/**
 * 海外源（0.6.0）：Client 直连的 REST 轮询，计数从 `overseasStatsOf` 实时读。
 * 单独一张表而不是并进 FEED_STAT_ORDER——那边的字段是"增量 / 游标 / Host 计数"，
 * 语义不同，混在一起就得靠形状判断猜来源。
 */
const OVERSEAS_STAT_ORDER = ['nws_alerts', 'eccc_alerts']
/**
 * 源状态区块（0.4.1）。
 *
 * 拆成独立组件的理由：它显示"最近拉取 N 秒前"，需要自己走时钟；而此前这段逻辑挂在
 * 设置页主组件里，5 秒一次的 setState 会**重建整个设置页**——关注县较多时那意味着
 * 每次最多 47×200 个市町村按钮一起重建，输入明显卡顿。现在只有这一小块重渲。
 *
 * 内容也扩了：除本地的增量 / 失败计数，还显示 Host 侧的失败与放弃数（来自 /feed?stats=1）。
 * 只显示本地计数的话，「上游被墙」与「上游没有新闻」仍然不可区分。
 */
function SourceStatusBlock() {
  const [, setTick] = useState(0)
  useEffect(() => {
    const t = setInterval(() => setTick((x) => x + 1), 5000)
    return () => clearInterval(t)
  }, [])
  // 订阅 store：源的连接 / 数据状态变化要立刻反映（不必等那 5 秒的时钟）
  useEffect(() => store.subscribe(() => setTick((x) => x + 1)), [])
  const rows = []
  const sources = store.sources || {}
  for (const id of SOURCE_ORDER) {
    const st = sources[id]
    if (!st) continue
    const meta = statusMetaOf(st.status, st.retries)
    rows.push((st.label || SOURCE_LABELS[id] || id) + '：' + meta.text + (st.detail ? ' · ' + st.detail : ''))
  }
  for (const id of FEED_STAT_ORDER) {
    const f = feedStatsOf[id]
    const st = sources[id]
    if (!f) {
      if (!st) rows.push((SOURCE_LABELS[id] || id) + '：尚未拉取')
      continue
    }
    const host = f.host || {}
    const ago = f.lastAt ? Math.max(0, Math.round((Date.now() - f.lastAt) / 1000)) + ' 秒前' : '—'
    rows.push((SOURCE_LABELS[id] || id) + '：已收到 ' + f.received + ' 条增量' +
      (f.errors ? '，本地失败 ' + f.errors + ' 次' : '') +
      (f.truncated ? '，增量缺口 ' + f.truncated + ' 次' : '') +
      (f.resets ? '，游标重置 ' + f.resets + ' 次' : '') +
      (Number(host.errors) ? '，Host 失败 ' + host.errors + ' 次' : '') +
      (Number(host.detailDropped) ? '，Host 放弃详情 ' + host.detailDropped + ' 条' : '') +
      ' · 最近拉取 ' + ago)
  }
  // 海外源（0.6.0）：按关注点查询外部 REST。显示"查了几轮 / 发了多少请求 / 收到多少响应条目"，
  // 以及几个只有这个形态才有的计数：**过老只记历史**（年龄闸门）、**被上游拒绝**（HTTP 400，
  // 不替上游断言"这个点不在覆盖范围"）、**被分页上限截断的轮数**（ECCC 的 limit=200）。
  for (const id of OVERSEAS_STAT_ORDER) {
    const o = overseasStatsOf[id]
    const st = sources[id]
    if (!o) {
      if (!st) rows.push((SOURCE_LABELS[id] || id) + '：尚未查询')
      continue
    }
    const ago = o.lastAt ? Math.max(0, Math.round((Date.now() - o.lastAt) / 1000)) + ' 秒前' : '—'
    // 「响应条目」而不是「收到 N 条」（0.6.1 review）：NWS 是按点的 5 个采样点各查一次，
    // 同一批预警会被重复计入，写成"收到 35 条"会让用户以为收到了 35 条不同预警。
    rows.push((SOURCE_LABELS[id] || id) + '：已查询 ' + (o.polls || 0) + ' 轮 · 请求 ' + (o.requests || 0) +
      ' 次 · 响应条目 ' + (o.received || 0) +
      (o.applied ? '，交给主链 ' + o.applied + ' 条' : '') +
      (o.ageSkipped ? '，过老只记历史 ' + o.ageSkipped + ' 条' : '') +
      (o.rejected ? '，被上游拒绝 ' + o.rejected + ' 次' : '') +
      (o.truncated ? '，上游结果被分页上限截断 ' + o.truncated + ' 轮' : '') +
      (o.throttledLast ? '，本轮超上限跳过 ' + o.throttledLast + ' 个请求' : '') +
      (o.errors ? '，失败 ' + o.errors + ' 次' : '') +
      ' · 最近查询 ' + ago)
  }
  // 大陆源（0.5.0）：走 SSE，状态从注册表**实时**读。**链路模式必须显示出来**——
  // 降级到轮询意味着延迟从秒级变成最长 15 秒，用户有权知道自己在哪条路上。
  for (const id of STREAM_ORDER) {
    const reg = cnStreamRegistry[id]
    const st = sources[id]
    if (!reg) {
      if (!st) rows.push((SOURCE_LABELS[id] || id) + '：尚未启动')
      continue
    }
    const c = reg.stats()
    const modeText = c.mode === 'sse' ? 'SSE 推送'
      : (c.mode === 'poll' ? '已降级为轮询'
        : (c.mode === 'disabled' ? '已关闭（「地震」开关关掉了）' : '未连接'))
    const ago = c.lastAt ? Math.max(0, Math.round((Date.now() - c.lastAt) / 1000)) + ' 秒前' : '—'
    rows.push((SOURCE_LABELS[id] || id) + '：' + modeText +
      ' · 已收到 ' + c.received + ' 条' +
      (c.applied ? '，已播报 ' + c.applied : '') +
      (c.errors ? '，失败 ' + c.errors + ' 次' : '') +
      (c.fallbacks ? '，降级 ' + c.fallbacks + ' 次' : '') +
      (c.probeTimeouts ? '，无首帧 ' + c.probeTimeouts + ' 次' : '') +
      (c.truncated ? '，增量缺口 ' + c.truncated + ' 次' : '') +
      (c.resets ? '，游标重置 ' + c.resets + ' 次' : '') +
      ' · 最近数据 ' + ago)
  }
  if (rows.length === 0) return null
  // 数据格式异常（schema-error）：按 DESIGN 5.4 提供**手动重试**——源改版后字段可能又回来了，
  // 用户不该为了清掉一个蓝点去重装插件。
  const retryRows = SOURCE_ORDER
    .filter((id) => sources[id] && sources[id].status === 'schema-error')
    .map((id) => h('div', { key: 'retry-' + id, style: { marginTop: 4 } },
      s.btn('重试 ' + (sources[id].label || SOURCE_LABELS[id] || id) + ' 的数据解析', () => retrySource(id))))
  return h('div', { style: { marginTop: 10, fontSize: 11, color: '#9aa0a6', lineHeight: 1.7 } },
    h('div', { style: { marginBottom: 2 } }, '源状态'),
    rows.map((t, i) => h('div', { key: 'feedstat-' + i }, t)),
    retryRows)
}

/**
 * 设置页默认落在哪个「国家 / 地区」分支下（0.8.0 / DESIGN 9.3）。
 *
 * **由现有配置推断，而不是固定日本**：已经配了中国或海外关注点的用户打开设置页时，
 * 应当直接看到自己在用的那个分支——否则会先看到"日本：未选择"，以为配置丢了。
 * 优先级与 9.3 的展示顺序一致（日本 → 中国 → 其他国家）；三边都空时落在日本
 * （它是默认链路，也是"未选择 = 提醒全日本"唯一有含义的分支）。
 */
function inferRegionTab(cfg) {
  const w = (cfg && cfg.watch) || {}
  const places = Array.isArray(w.places) ? w.places : []
  if (Array.isArray(w.prefectures) && w.prefectures.length > 0) return 'jp'
  if (places.some((p) => p && p.origin === 'cn')) return 'cn'
  if (places.length > 0) return 'global'
  return 'jp'
}
/** 一级「国家 / 地区」的三个分支（0.8.0 / DESIGN 9.3：第一级收成一个唯一的选择器）。 */
const REGION_TABS = [
  { v: 'jp', label: '日本', icon: '🇯🇵' },
  { v: 'cn', label: '中国大陆', icon: '🇨🇳' },
  { v: 'global', label: '其他国家 / 地区', icon: '🌐' },
]
/**
 * 设置页的选项卡（0.8.1）。
 *
 * 九个区块串成一列时，"只想看一眼履历"要滚过全部设置——包括关注地区里那几千个市町村按钮。
 * 分页依据是**用户要做什么**，不是代码结构：
 *   · 地区 —— 我在乎哪里（配置一次，偶尔改）
 *   · 灾害 —— 哪些灾种、多强才提醒（配置一次）
 *   · 通知 —— 怎么提醒、什么时候别提醒（偶尔改）
 *   · 履历 —— 刚才发生了什么（最常回来的一页）
 *   · 其他 —— 链路、诊断、免责（排障时才来）
 * 每页只渲染自己能看到的区块，所以未选中的页连 DOM 都不产生。
 */
const SETTINGS_TABS = [
  { v: 'region', label: '地区' },
  { v: 'disaster', label: '灾害' },
  { v: 'notify', label: '通知' },
  { v: 'history', label: '履历' },
  { v: 'misc', label: '其他' },
]

function SettingsPanel(props) {
  const [cfg, setCfgState] = useState(() => currentCfg())
  const [, setTick] = useState(0)
  const [perm, setPerm] = useState(() => notificationPermission())
  const [testMsg, setTestMsg] = useState('')
  const [expanded, setExpanded] = useState(null)
  const [cityQuery, setCityQuery] = useState({}) // 每个县的市町村搜索词
  const [weatherTestMsg, setWeatherTestMsg] = useState('') // 「发送测试气象警报」的结果提示
  const [weatherTestSeq, setWeatherTestSeq] = useState(0) // 测试场景轮换游标
  // 全球关注点的输入草稿与反馈（0.4.0）：校验失败必须给出文字原因，不能静默吞掉用户输入
  // 半径默认值 0.5.0 起是 100（DESIGN 9.2）；**既有配置里的 radiusKm 不动**，只影响新建。
  const [placeDraft, setPlaceDraft] = useState({ name: '', lat: '', lon: '', radiusKm: String(DEFAULT_PLACE_RADIUS_KM) })
  const [placeMsg, setPlaceMsg] = useState('')
  // 中国大陆的三级级联（0.5.0）：省 → 地级市 → 半径。选完给出**表里的坐标**，
  // 用户不需要知道经纬度（大陆源是坐标 + 半径匹配，见 DESIGN 8.3）。
  const [cnPick, setCnPick] = useState({ province: '', city: '', radiusKm: DEFAULT_PLACE_RADIUS_KM })
  const [cnMsg, setCnMsg] = useState('')
  // 全球链路的测试（0.4.0）：场景轮换游标与结果提示
  const [geTestSeq, setGeTestSeq] = useState(0)
  const [geTestMsg, setGeTestMsg] = useState('')
  // 诊断快照（0.5.0）：{ text, msg } | null
  const [diag, setDiag] = useState(null)
  // 「源状态」区块里的相对时间要自己走 —— 见 SourceStatusBlock（独立组件，避免每 5 秒
  // 重渲整个设置页，尤其是关注县较多时那几千个市町村按钮）
  // 音量滑块：拖动期间只改本地草稿，停手 300ms 后才落盘（避免每移动 1px 写一次 localStorage）
  const [volDraft, setVolDraft] = useState(null)
  // 选项卡（0.8.1）。默认「地区」——首次配置的起点。`props.initialTab` 只给回归测试用
  //（宿主按 `h(SettingsPanel, { close })` 渲染，不会传它）。
  const [tab, setTab] = useState(() => {
    const want = props && props.initialTab
    return SETTINGS_TABS.some((t) => t.v === want) ? want : 'region'
  })
  // 关注地区的当前分支（0.8.0 / DESIGN 9.3）：地址是"用户视角的一条路径"，不是三块并列。
  const [regionTab, setRegionTab] = useState(() => inferRegionTab(currentCfg()))
  // 「其他国家 / 地区」分支：所选国家与城市搜索词（城市表按国家分包，见 04-city-table）
  const [country, setCountry] = useState('')
  const [worldCityQuery, setWorldCityQuery] = useState('')
  const volTimer = useRef(null)
  const volPending = useRef(null) // 尚未落盘的草稿值：卸载时补写，拖完立刻关设置页也不丢改动
  const restartTimer = useRef(null) // 切换数据源后的重启延时（见下方）
  // store 变化（新预警、Host 配置同步）都要重新读一次当前配置
  useEffect(() => store.subscribe(() => { setTick((t) => t + 1); setCfgState(currentCfg()) }), [])
  useEffect(() => () => {
    if (volTimer.current) { clearTimeout(volTimer.current); volTimer.current = null }
    if (restartTimer.current) { clearTimeout(restartTimer.current); restartTimer.current = null }
    const v = volPending.current
    if (v !== null) {
      volPending.current = null
      // 卸载中不能 setState，只补写盘。必须经 applyCfg 而不是 saveCfg：
      // saveCfg 只写 localStorage 镜像，不改内存也不推 Host —— 有 Host settings 时
      // 下次同步会被 Host 的旧值覆盖回来，音量改动照样丢（0.2.0 声称修过这个场景）。
      const cur = currentCfg()
      applyCfg({ ...cur, notify: { ...cur.notify, volume: v } })
    }
  }, [])
  // 其它 DSH 标签页改了配置 → 由 15-entry 的常驻 storage 监听统一回读并 store.push()，
  // 本组件通过下面的 store.subscribe 跟随。监听放在这里（组件内）的话，只有设置页打开着
  // 才同步；没打开设置页的标签页会一直按旧配置提醒。

  // 立即基于最新配置计算（内存 + localStorage 镜像 + Host），再 setState
  const setCfg = (fn) => { const next = applyCfg(fn(currentCfg())); setCfgState(next) }
  const togglePref = (jp) => setCfg((c) => {
    const cur = c.watch.prefectures
    const removing = cur.indexOf(jp) !== -1
    const next = removing ? cur.filter((p) => p !== jp) : cur.concat(jp)
    // 取消关注某个县时，同时清掉它下面已选的市町村（避免留下永远不生效的条目）
    const cities = removing
      ? c.watch.cities.filter((city) => citiesOfPref(jp).indexOf(city) === -1)
      : c.watch.cities
    return { ...c, watch: { ...c.watch, prefectures: next, cities } }
  })
  const toggleCity = (city) => setCfg((c) => {
    const cur = c.watch.cities
    let next = cur.indexOf(city) === -1 ? cur.concat(city) : cur.filter((x) => x !== city)
    if (next.length > MAX_WATCH_CITIES) next = next.slice(0, MAX_WATCH_CITIES)
    return { ...c, watch: { ...c.watch, cities: next } }
  })

  // ---------- 全球关注点（0.4.0）----------
  // 全球源给的是震中坐标，没有都道府县，所以关注表达是「位置 + 半径」。
  // 校验放在这里而不是只靠 normalizeCfg：用户需要看到"为什么没加上"，静默吞掉输入最糟。
  const addPlace = () => {
    const places = cfg.watch.places || []
    const lat = Number(String(placeDraft.lat).trim())
    const lon = Number(String(placeDraft.lon).trim())
    const radiusKm = Number(String(placeDraft.radiusKm).trim())
    if (String(placeDraft.lat).trim() === '' || !Number.isFinite(lat) || Math.abs(lat) > 90) {
      setPlaceMsg('纬度需要是 -90 ~ 90 之间的数字'); return
    }
    if (String(placeDraft.lon).trim() === '' || !Number.isFinite(lon) || Math.abs(lon) > 180) {
      setPlaceMsg('经度需要是 -180 ~ 180 之间的数字'); return
    }
    if (!Number.isFinite(radiusKm) || radiusKm < 1 || radiusKm > 2000) {
      setPlaceMsg('半径需要是 1 ~ 2000 km 之间的数字'); return
    }
    if (places.length >= MAX_WATCH_PLACES) {
      setPlaceMsg('最多 ' + MAX_WATCH_PLACES + ' 个关注点'); return
    }
    const name = String(placeDraft.name || '').trim() || (lat.toFixed(2) + ', ' + lon.toFixed(2))
    // origin（0.8.0 / DESIGN 9.3）：手填坐标与「用我的位置」都归 'global' 分支——这个表单
    // 不限定国家，而 origin 只做标注（不影响匹配范围），写一个猜出来的国家名反而是错的。
    setCfg((c) => ({ ...c, watch: { ...c.watch, places: (c.watch.places || []).concat([{ name, lat, lon, radiusKm, origin: 'global' }]) } }))
    setPlaceDraft({ name: '', lat: '', lon: '', radiusKm: String(radiusKm) })
    setPlaceMsg('已添加「' + name + '」（坐标相同的重复点会被自动合并）')
  }
  const removePlace = (idx) => setCfg((c) => ({
    ...c, watch: { ...c.watch, places: (c.watch.places || []).filter((_, i) => i !== idx) },
  }))
  const useMyLocation = () => {
    const geo = (typeof navigator !== 'undefined') ? navigator.geolocation : null
    if (!geo || typeof geo.getCurrentPosition !== 'function') { setPlaceMsg('当前浏览器不支持定位，请手动填写坐标'); return }
    setPlaceMsg('正在获取当前位置…')
    geo.getCurrentPosition(
      (pos) => {
        const c = pos && pos.coords
        if (!c) { setPlaceMsg('定位失败：没有返回坐标'); return }
        setPlaceDraft((d) => ({
          ...d,
          name: d.name || '我的位置',
          lat: String(c.latitude.toFixed(4)),
          lon: String(c.longitude.toFixed(4)),
        }))
        setPlaceMsg('已填入当前位置，确认半径后点「添加关注点」')
      },
      (err) => setPlaceMsg('定位失败：' + ((err && err.message) || '被拒绝或不可用')),
      { timeout: 10000 },
    )
  }
  /** 定位并**直接添加**一个关注点（大陆级联里的用法：半径已经在级联里选好了，
   *  再让用户去另一个表单点一次「添加」是多余的一步）。 */
  const addMyLocationPlace = () => {
    const geo = (typeof navigator !== 'undefined') ? navigator.geolocation : null
    if (!geo || typeof geo.getCurrentPosition !== 'function') { setCnMsg('当前浏览器不支持定位，请选择省份与城市'); return }
    setCnMsg('正在获取当前位置…')
    geo.getCurrentPosition(
      (pos) => {
        const c = pos && pos.coords
        if (!c) { setCnMsg('定位失败：没有返回坐标'); return }
        const lat = Math.round(c.latitude * 100) / 100
        const lon = Math.round(c.longitude * 100) / 100
        if ((cfg.watch.places || []).length >= MAX_WATCH_PLACES) { setCnMsg('最多 ' + MAX_WATCH_PLACES + ' 个关注点'); return }
        setCfg((cf) => ({
          ...cf,
          watch: { ...cf.watch, places: (cf.watch.places || []).concat([{ name: '我的位置', lat, lon, radiusKm: cnPick.radiusKm, origin: 'global' }]) },
        }))
        // 台式机的定位靠 WiFi / IP 库，可能不准 —— 如实说，别让用户以为这就是精确位置
        setCnMsg('已添加「我的位置」（' + lat + ', ' + lon + '，半径 ' + cnPick.radiusKm +
          ' km）。定位可能不精确，请确认坐标或改用手动选择城市。')
      },
      (err) => setCnMsg('定位失败：' + ((err && err.message) || '被拒绝或不可用') + '（也可以手动选择省份与城市）'),
      { timeout: 10000 },
    )
  }

  /** 关注点输入框（受控）：四个字段共用一份草稿。 */
  const placeField = (label, key, placeholder, width) => h('label', {
    style: { display: 'flex', flexDirection: 'column', gap: 2, fontSize: 11, color: '#9aa0a6' },
  }, label, h('input', {
    type: 'text',
    value: placeDraft[key],
    placeholder,
    onChange: (e) => setPlaceDraft((d) => Object.assign({}, d, { [key]: e.target.value })),
    style: {
      width, boxSizing: 'border-box', background: '#ffffff', color: '#1a1a1a',
      border: '1px solid #6b7280', borderRadius: 6, padding: '3px 6px', fontSize: 12,
    },
  }))

  // ---------- 半径控件（0.5.0 / DESIGN 9.2）----------
  /** 当前值是否正好是某个语义档。 */
  const isRadiusPreset = (km) => RADIUS_PRESETS.some((o) => o.v === Number(km))
  /**
   * 半径选择：三档**语义标签** + 一个始终可见的数字输入。
   *
   * 为什么两者都要：普通用户不必理解"公里"，语义档就够；而"想精确控制的人有出口"
   * 是 DESIGN 9.2 的硬要求——把数字藏进"自定义…"分支会让改一次半径多两步。
   * 数字框是真实值，下拉只是快捷键；填了 150 这种非档位值时下拉自动显示「自定义」。
   */
  const radiusControl = (km, onChange, key) => h('div', {
    key: key || 'radius',
    style: { display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, color: '#9aa0a6', flexWrap: 'wrap' },
  },
    h('span', null, '半径'),
    s.select(isRadiusPreset(km) ? Number(km) : 'custom',
      RADIUS_PRESETS.concat([{ v: 'custom', label: '自定义…' }]),
      (v) => { if (v !== 'custom') onChange(Number(v)) },
      (o) => o.label),
    h('input', {
      type: 'number', min: MIN_PLACE_RADIUS_KM, max: MAX_PLACE_RADIUS_KM, value: km,
      onChange: (e) => {
        const raw = String(e.target.value).trim()
        if (raw === '') return // 输入中间态（全删）不写进配置，等用户填完
        const v = Number(raw)
        if (!Number.isFinite(v)) return
        onChange(Math.min(MAX_PLACE_RADIUS_KM, Math.max(MIN_PLACE_RADIUS_KM, Math.round(v))))
      },
      style: {
        width: 68, boxSizing: 'border-box', background: '#ffffff', color: '#1a1a1a',
        border: '1px solid #6b7280', borderRadius: 6, padding: '3px 6px', fontSize: 12,
      },
    }),
    h('span', null, 'km'),
  )

  // ---------- 中国大陆的三级级联（0.5.0）----------
  const provinces = cnProvinces()
  /** 选了省之后，市默认落在第一个上——否则用户会以为"选了省但没反应"。 */
  const pickProvince = (province) => {
    const cities = cnCitiesOf(province)
    setCnPick((p) => ({ ...p, province, city: cities.length ? cities[0].name : '' }))
    setCnMsg('')
  }
  const addCnPlace = () => {
    const p = cnPlaceOf(cnPick.province, cnPick.city, cnPick.radiusKm)
    if (!p) { setCnMsg('请先选择省份与城市（行政区划表未加载时请重启 dsh web）'); return }
    if ((cfg.watch.places || []).length >= MAX_WATCH_PLACES) { setCnMsg('最多 ' + MAX_WATCH_PLACES + ' 个关注点'); return }
    if ((cfg.watch.places || []).some((x) => x.name === p.name)) { setCnMsg('「' + p.name + '」已经在关注列表里了'); return }
    setCfg((c) => ({ ...c, watch: { ...c.watch, places: (c.watch.places || []).concat([p]) } }))
    setCnMsg('已添加「' + p.name + '」（' + p.lat + ', ' + p.lon + '，半径 ' + p.radiusKm + ' km）')
  }
  /** 国家 / 地区级联的第一级（中国）——省的选项。 */
  const cnCascade = () => {
    if (provinces.length === 0) {
      return h('div', { style: { fontSize: 11, color: cityTableState === 'failed' ? '#d9a406' : '#9aa0a6', marginTop: 6 } },
        cityTableState === 'failed'
          ? '行政区划数据加载失败，可以改用「其他国家 / 地区」手动填坐标'
          : '正在加载…')
    }
    const cities = cnCitiesOf(cnPick.province)
    const provOptions = [{ v: '', label: '请选择省份 / 直辖市 / 特别行政区' }]
      .concat(provinces.map((p) => ({ v: p.name, label: p.name })))
    const cityOptions = (cities.length ? cities : [{ name: '' }]).map((c) => ({ v: c.name, label: c.name || '（先选省份）' }))
    return h('div', null,
      h('div', { style: { display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' } },
        s.select(cnPick.province, provOptions, pickProvince, (o) => o.label, '一级行政区（省 / 自治区 / 直辖市）'),
        s.select(cnPick.city, cityOptions, (v) => { setCnPick((p) => ({ ...p, city: v })); setCnMsg('') }, (o) => o.label, '城市'),
      ),
      h('div', { style: { marginTop: 6 } },
        radiusControl(cnPick.radiusKm, (v) => setCnPick((p) => ({ ...p, radiusKm: v })), 'cn-radius')),
      h('div', { style: { marginTop: 8, display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' } },
        s.btn('添加这个城市', addCnPlace),
        s.btn('用我的位置', addMyLocationPlace, { fontSize: 11 }),
      ),
      cnMsg ? h('div', { role: 'status', style: { fontSize: 11, color: '#93c5fd', marginTop: 6 } }, cnMsg) : null,
    )
  }
  // 全球源状态（0.4.0）：用户看不出"链路到底在不在拉"，这是最常见的困惑来源——
  // 尤其全球地震本来就不频繁。feedStatsOf 不经过 store（见 12b 的注释），
  // 所以由 SourceStatusBlock 自己每 5 秒重读（见文件下方）。
  // 市区町村选择器：数据表到位后，为每个已关注的县提供「搜索 + 多选」
  const cityPicker = () => {
    if (cityTableState === 'failed') {
      return h('div', { style: { fontSize: 11, color: '#d9a406', marginTop: 10 } },
        '市区町村列表加载失败，只能按都道府县关注')
    }
    if (cfg.watch.prefectures.length === 0) {
      return h('div', { style: { fontSize: 11, color: '#9aa0a6', marginTop: 10 } }, '先选都道府县')
    }
    if (cityTableState !== 'ready') {
      return h('div', { style: { fontSize: 11, color: '#9aa0a6', marginTop: 10 } }, '正在加载…')
    }
    return h('div', { style: { marginTop: 10 } },
      h('div', { style: { fontSize: 11, color: '#9aa0a6', marginBottom: 4 } },
        '不选就是全县。EEW 和海啸只到县一级。'),
      cfg.watch.prefectures.map((pref) => {
        const list = citiesOfPref(pref)
        if (list.length === 0) return null
        const q = cityQuery[pref] || ''
        const shown = q ? list.filter((c) => c.indexOf(q) !== -1) : list
        const sel = list.filter((c) => cfg.watch.cities.indexOf(c) !== -1).length
        return h('div', { key: pref, style: { border: '1px solid rgba(148,163,184,0.18)', borderRadius: 6, padding: '6px 8px', margin: '6px 0' } },
          h('div', { style: { fontSize: 12, color: '#dfe3e8', marginBottom: 4 } },
            pref + '：' + (sel === 0 ? '全县' : '已选 ' + sel + ' 个')),
          h('input', {
            type: 'text', value: q, placeholder: '搜索 ' + pref + ' 的市町村…',
            'aria-label': '搜索 ' + pref + ' 的市町村',
            onChange: (e) => setCityQuery((prev) => Object.assign({}, prev, { [pref]: e.target.value })),
            style: { width: '100%', boxSizing: 'border-box', background: '#ffffff', color: '#1a1a1a', border: '1px solid #6b7280', borderRadius: 6, padding: '3px 8px', fontSize: 12, marginBottom: 5 },
          }),
          h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 4, maxHeight: 150, overflowY: 'auto' } },
            shown.slice(0, 200).map((city) => {
              const on = cfg.watch.cities.indexOf(city) !== -1
              return h('button', {
                key: city, onClick: () => toggleCity(city),
                style: {
                  fontSize: 11, padding: '2px 8px', borderRadius: 11, cursor: 'pointer',
                  border: '1px solid ' + (on ? '#3b82f6' : 'rgba(148,163,184,0.3)'),
                  background: on ? 'rgba(59,130,246,0.18)' : 'transparent',
                  color: on ? '#93c5fd' : '#9aa0a6',
                },
              }, city)
            }),
            shown.length > 200
              ? h('span', { style: { fontSize: 11, color: '#9aa0a6' } }, '…共 ' + shown.length + ' 个，请输入关键词')
              : null),
        )
      }),
    )
  }
  // ---------- 关注地区的统合（0.8.0 / DESIGN 9.3）----------
  // 第一级从三个平铺区块收成一个**唯一的「国家 / 地区」选择器**，选中后只展开该国自己的
  // 下级控件；代码里仍是三条各自合适的实现（"统合 UI，不统合模型"）：
  //   · 日本     → 都道府县 + 市区町村（源按行政区名匹配，判据是"该地区观测到的震度"）
  //   · 中国大陆 → 省 + 地级市 + 半径（源按"震中坐标 + 半径"匹配）
  //   · 其他国家 → 坐标 + 半径（同坐标型；9.4 的城市表接入后这里多一条城市列表）
  // 硬把日本改成坐标匹配会让"震中 150km 外、本地却到震度 5 弱"的地震漏掉——那是把日本这一路
  // **降级**（9.3 明确否决）。所以数据模型一个字段都不动，只统合用户看到的路径。
  const prefZhOf = (jp) => (PREFECTURES.find((p) => p.jp === jp) || {}).zh || jp
  /** 按来源分支筛关注点（`origin` 见 02-storage 的 placeOriginOf）。 */
  const placesOfOrigin = (origin) => (cfg.watch.places || [])
    .filter((p) => (origin === 'cn' ? (p && p.origin === 'cn') : (p && p.origin !== 'cn')))
  /** 唯一的「国家 / 地区」选择器（三个分支各自带已关注计数）。 */
  const regionTabs = () => h('div', { style: { display: 'flex', gap: 6, flexWrap: 'wrap' } },
    REGION_TABS.map((t) => {
      const n = t.v === 'jp' ? (cfg.watch.prefectures || []).length : placesOfOrigin(t.v).length
      const on = regionTab === t.v
      return h('button', {
        key: t.v,
        onClick: () => setRegionTab(t.v),
        'aria-pressed': on ? 'true' : 'false',
        style: {
          fontSize: 12, padding: '5px 12px', borderRadius: 8, cursor: 'pointer',
          border: '1px solid ' + (on ? '#3b82f6' : 'rgba(148,163,184,0.3)'),
          background: on ? 'rgba(59,130,246,0.18)' : 'transparent',
          color: on ? '#93c5fd' : '#9aa0a6',
        },
      }, t.icon + ' ' + t.label + (n > 0 ? '（' + n + '）' : ''))
    }))

  /**
   * 已关注地区的**统一列表**（按来源分支分组）。
   *
   * 这是"统合 UI，不统合模型"真正的落点：配置里仍是 prefectures / cities / places 三份数据，
   * 但用户看到的是一份"我关注了哪里"的清单——此前要滚过三个区块、把三处内容在脑子里拼起来
   * 才知道自己到底关注了什么。
   */
  const watchList = () => {
    const w = cfg.watch || {}
    const places = w.places || []
    const jpRows = (w.prefectures || []).map((pref) => {
      const cities = (w.cities || []).filter((c) => citiesOfPref(pref).indexOf(c) !== -1)
      return h('div', { key: 'wl-jp-' + pref, style: { display: 'flex', alignItems: 'center', gap: 8, margin: '3px 0', fontSize: 12 } },
        h('span', { style: { flex: 1 } },
          '🇯🇵 ' + prefZhOf(pref) + (prefZhOf(pref) !== pref ? '（' + pref + '）' : '') + ' · ' +
          (cities.length ? '已细化 ' + cities.length + ' 个市区町村' : '全境')),
        s.btn('移除', () => togglePref(pref)))
    })
    const placeRow = (p, i, icon) => h('div', { key: 'wl-place-' + i, style: { display: 'flex', alignItems: 'center', gap: 8, margin: '3px 0', fontSize: 12 } },
      h('span', { style: { flex: 1 } },
        icon + ' ' + p.name + ' · ' + Number(p.lat).toFixed(3) + ', ' + Number(p.lon).toFixed(3) +
        ' · 半径 ' + p.radiusKm + ' km'),
      s.btn('移除', () => removePlace(i)))
    const cnRows = []
    const glRows = []
    places.forEach((p, i) => {
      if (p && p.origin === 'cn') cnRows.push(placeRow(p, i, '🇨🇳'))
      else glRows.push(placeRow(p, i, '🌐'))
    })
    const group = (title, rows, empty) => h('div', { style: { marginTop: 8 } },
      h('div', { style: { fontSize: 11, color: '#9aa0a6', marginBottom: 2 } }, title),
      rows.length ? rows : h('div', { style: { fontSize: 11, color: '#6b7280' } }, empty))
    const total = (w.prefectures || []).length + places.length
    return h('div', { style: { marginTop: 12, borderTop: '1px solid rgba(148,163,184,0.18)', paddingTop: 8 } },
      h('div', { style: { fontSize: 12, fontWeight: 700, color: '#dfe3e8' } }, '已关注（' + total + '）'),
      total === 0
        ? h('div', { style: { fontSize: 11, color: '#d9a406', marginTop: 4 } }, '还没有添加地区')
        : null,
      group('日本（按行政区）', jpRows, '未选择：全日本都会提醒'),
      group('中国大陆（按行政区、坐标）', cnRows, '还没有添加'),
      group('其他国家 / 地区（按坐标、半径）', glRows, '还没有添加'),
    )
  }

  /** 日本分支：都道府县 + 市区町村细化（交互与 0.5.0 完全一致）。 */
  const jpBranch = () => h('div', null,
    h('div', { style: { fontSize: 11, color: '#9aa0a6', marginBottom: 8 } },
      cfg.watch.prefectures.length === 0
        ? '不选的话，全日本的地震都会提醒'
        : '已选 ' + cfg.watch.prefectures.length + ' 个地区'),
    h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 5 } },
      PREFECTURES.map((p) => {
        const on = cfg.watch.prefectures.indexOf(p.jp) !== -1
        return h('button', {
          key: p.jp,
          onClick: () => togglePref(p.jp),
          'aria-pressed': on ? 'true' : 'false',
          style: {
            fontSize: 11, padding: '2px 9px', borderRadius: 12, cursor: 'pointer',
            border: '1px solid ' + (on ? '#3b82f6' : 'rgba(148,163,184,0.3)'),
            background: on ? 'rgba(59,130,246,0.18)' : 'transparent',
            color: on ? '#93c5fd' : '#9aa0a6',
          },
        }, p.zh)
      }),
    ),
    cityPicker(),
  )

  /** 中国大陆分支：省 → 地级市 → 半径（交互与 0.5.0 完全一致，说明文字随分支走）。 */
  const cnBranch = () => h('div', null,
    h('div', { style: { fontSize: 11, color: '#9aa0a6', marginBottom: 8 } },
      '选城市就会用市中心的坐标。面积大的州、市，把半径调大一些。'),
    // 无取消机制是**安全相关**的缺口（DESIGN 8.3 / 10.2 要求 UI 如实说明，不得假装能处理）：
    // 主视野只留这一行结论，完整边界收进折叠——信息不删，只是不再占地方。
    h('div', { style: { fontSize: 11, color: '#d9a406', marginBottom: 8 } },
      '⚠ 预警被撤销或修改时不会另行通知。以中国地震台网发布为准。'),
    cnCascade(),
    fold('数据来源的局限',
      h('div', null, '没有取消或最终报标志：预警被上游撤销或修改时，不会补一条"已作废"。日本的地震速报和海啸有这条链路，大陆源没有。'),
      h('div', null, '表里的坐标是行政区中心点，不是市政府所在地。面积大的州市（比如甘孜州、哈尔滨市）离城区可能差一百多公里。'),
      h('div', null, '大陆预警请以中国地震台网（CENC）发布为准。')),
  )

  /** 从城市表点选一个城市 → 关注点（origin: 'global'，半径取上面那个共用旋钮）。 */
  const addCityPlace = (c) => {
    const places = cfg.watch.places || []
    if (places.length >= MAX_WATCH_PLACES) { setPlaceMsg('最多 ' + MAX_WATCH_PLACES + ' 个关注点'); return }
    // 按**坐标**判重（与 normalizePlaces 的去重口径一致）：否则同一个城市点两次会出现两行
    if (places.some((p) => p && Math.abs(p.lat - c.lat) < 0.02 && Math.abs(p.lon - c.lon) < 0.02)) {
      setPlaceMsg('「' + c.name + '」已经在关注列表里了'); return
    }
    const radiusKm = Number(placeDraft.radiusKm) || DEFAULT_PLACE_RADIUS_KM
    setCfg((cf) => ({ ...cf, watch: { ...cf.watch, places: (cf.watch.places || []).concat([
      { name: c.name, lat: c.lat, lon: c.lon, radiusKm, origin: 'global' },
    ]) } }))
    setPlaceMsg('已添加「' + c.name + '」（' + c.lat + ', ' + c.lon + '，半径 ' + radiusKm + ' km）')
  }

  /** 其他国家 / 地区分支：先按国家选城市（9.4 的城市表），再给手填坐标这个出口。 */
  const globalBranch = () => {
    const hint = { fontSize: 11, color: '#9aa0a6', lineHeight: 1.6 }
    const countries = worldCountriesOf()
    const pack = country ? countryPackOf(country) : null
    const cityList = (pack && pack.state === 'ready') ? pack.cities : []
    const q = worldCityQuery.trim()
    const shown = q
      ? cityList.filter((c) => c.name.indexOf(q) !== -1 ||
          (c.admin && c.admin.toLowerCase().indexOf(q.toLowerCase()) !== -1))
      : cityList
    const cityBlock = () => {
      if (!country) {
        return h('div', { style: Object.assign({}, hint, { marginTop: 8 }) },
          countries.length ? '先选国家，再点城市。' : '正在加载…')
      }
      if (!pack || pack.state === 'loading') {
        return h('div', { style: Object.assign({}, hint, { marginTop: 8 }) }, '正在加载…')
      }
      if (pack.state === 'failed') {
        return h('div', { style: Object.assign({}, hint, { marginTop: 8, color: '#d9a406' }) },
          '城市列表加载失败，可以手动填坐标，或重启 dsh web 再试。')
      }
      if (pack.error === 'not-covered' || cityList.length === 0) {
        return h('div', { style: Object.assign({}, hint, { marginTop: 8 }) },
          '没有这个国家的城市列表（只收人口 10 万以上的城镇）。请用下面的坐标输入。')
      }
      return h('div', { style: { marginTop: 8 } },
        h('input', {
          type: 'text', value: worldCityQuery, placeholder: '搜索城市（共 ' + cityList.length + ' 个）',
          'aria-label': '搜索城市',
          onChange: (e) => setWorldCityQuery(e.target.value),
          style: {
            width: '100%', boxSizing: 'border-box', background: '#ffffff', color: '#1a1a1a',
            border: '1px solid #6b7280', borderRadius: 6, padding: '3px 8px', fontSize: 12,
          },
        }),
        h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 4, maxHeight: 170, overflowY: 'auto', marginTop: 6 } },
          shown.slice(0, 200).map((c) => {
            const label = c.admin ? c.name + '（' + c.admin + '）' : c.name
            return h('button', {
              key: c.name + '@' + c.lat + ',' + c.lon,
              onClick: () => addCityPlace(c),
              title: '添加 ' + label,
              style: {
                fontSize: 11, padding: '2px 9px', borderRadius: 11, cursor: 'pointer',
                border: '1px solid rgba(148,163,184,0.3)', background: 'transparent', color: '#9aa0a6',
              },
            }, label)
          }),
          shown.length > 200
            ? h('span', { style: hint }, '…共 ' + shown.length + ' 个，请输入关键词')
            : null),
      )
    }
    return h('div', null,
      h('div', { style: Object.assign({}, hint, { marginBottom: 8 }) },
        '按位置和半径匹配。不影响日本的地震、海啸。'),
      s.label('国家 / 地区'),
      s.row(s.select(country,
        [{ v: '', label: countries.length ? '请选择国家 / 地区' : '正在加载国家 / 地区列表…' }]
          .concat(countries.map((c) => ({ v: c.code, label: c.name + '（' + c.count + ' 个城市）' }))),
        (v) => { setCountry(v); setWorldCityQuery(''); if (v) loadCountryCities(v) },
        (o) => o.label, '国家 / 地区')),
      // 半径是**共用**的一个旋钮：城市点选与手填坐标都按它新建关注点。
      // 两处各放一个会让人以为"半径分两种"，而匹配层只认每个关注点自己的 radiusKm。
      h('div', { style: { marginTop: 6 } },
        radiusControl(Number(placeDraft.radiusKm) || DEFAULT_PLACE_RADIUS_KM,
          (v) => setPlaceDraft((d) => ({ ...d, radiusKm: String(v) })), 'place-radius')),
      cityBlock(),
      h('div', { style: { marginTop: 12, borderTop: '1px solid rgba(148,163,184,0.18)', paddingTop: 10 } },
        h('div', { style: Object.assign({}, hint, { marginBottom: 6 }) }, '也可以直接填坐标：'),
        h('div', { style: { display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'flex-end' } },
          placeField('名称', 'name', '如 东京 / 家', 120),
          placeField('纬度', 'lat', '35.6812', 90),
          placeField('经度', 'lon', '139.7671', 90),
          s.btn('添加关注点', addPlace),
          s.btn('用当前位置', useMyLocation)),
      ),
      placeMsg ? h('div', { role: 'status', style: { fontSize: 11, color: '#93c5fd', marginTop: 6 } }, placeMsg) : null,
    )
  }

  const sectionWatch = () => s.section('关注地区',
    regionTabs(),
    h('div', { style: { marginTop: 10 } },
      regionTab === 'jp' ? jpBranch() : (regionTab === 'cn' ? cnBranch() : globalBranch())),
    watchList(),
  )

  // ---------- 灾害类型与阈值（0.8.0 合并成按灾种的一张表）----------
  // 0.7.0 及以前，开关在「灾害类型」、阈值在几屏之外的「提醒阈值」——用户想调海啸的强弱，
  // 得在两个区块之间来回对照自己刚才开的是哪一个。0.8.0 把两者并成一张表：**一行就是一个灾种**，
  // 它自己的开关与阈值并排。
  //
  // 开关的**共享关系如实呈现**（`disasters.earthquake` 一个字段管四行地震），不伪造四个开关：
  // 那个字段从 0.1.0 起就在配置里，拆开会让老配置的语义漂移；用户的心智也是"要不要地震提醒"，
  // 而不是"要不要日本实测震度"。
  /** 一行：灾种名 + 口径说明 | 开关 + 阈值。 */
  const disasterRow = (label, note, control) => h('div', {
    style: { display: 'flex', alignItems: 'flex-start', gap: 10, padding: '6px 0', borderBottom: '1px solid rgba(148,163,184,0.10)' },
  },
    h('div', { style: { flex: 1, minWidth: 170 } },
      h('div', { style: { fontSize: 12, color: '#e6e6e8' } }, label),
      note ? h('div', { style: { fontSize: 11, color: '#9aa0a6', lineHeight: 1.5, marginTop: 2 } }, note) : null),
    h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', paddingTop: 2 } },
      (Array.isArray(control) ? control : [control]).filter(Boolean)))
  const switchOf = (key, text) => s.checkbox(cfg.disasters[key] !== false,
    (v) => setCfg((c) => ({ ...c, disasters: { ...c.disasters, [key]: v } })), text)
  const thSelect = (key, options, asNumber, label) => s.select(cfg.thresholds[key], options,
    (v) => setCfg((c) => ({ ...c, thresholds: { ...c.thresholds, [key]: asNumber ? Number(v) : v } })),
    (o) => o.label, label)
  /** 分组的标题行：一个开关管这一组的若干行（共享关系写在标题里，别让人以为漏了开关）。 */
  const disasterGroup = (title, switchKey, switchText, extra) => h('div', {
    style: { display: 'flex', alignItems: 'center', gap: 10, margin: '14px 0 2px', flexWrap: 'wrap' },
  },
    h('div', { style: { fontSize: 12, fontWeight: 700, color: '#93c5fd', flex: 1, minWidth: 150 } }, title),
    switchKey ? switchOf(switchKey, switchText || '提醒') : null,
    extra || null)
  /** 播报门槛（不可调）。写成只读文字而不是置灰的下拉——置灰的下拉会让人以为能调。 */
  const fixedGate = (text) => h('span', { style: { fontSize: 11, color: '#9aa0a6' } }, text)

  const sectionDisasters = () => s.section('灾害类型与阈值',
    // 一行就够。原来那句"开关 = 要不要提醒，阈值 = 多强才提醒"是在解释自己的界面——
    // 开关和下拉就摆在眼前，用户不需要有人告诉他这是什么（0.8.1 去 AI 味时删掉）。
    h('div', { style: { fontSize: 11, color: '#9aa0a6', marginBottom: 4 } },
      '关闭后仍会记录，只是不提示。'),

    // —— 地震：日本 / 全球 / 大陆共用 disasters.earthquake 这一个开关 ——
    disasterGroup('地震', 'earthquake', '提醒'),
    disasterRow('日本 · 实测震度', '本地观测到的震度', [thSelect('quakeScale', SCALE_OPTIONS, true, '日本地震（实测震度最低值）')]),
    disasterRow('日本 · 紧急地震速报（EEW）', '预测的震度', [thSelect('eewScale', SCALE_OPTIONS, true, '紧急地震速报（预测震度最低值）')]),
    disasterRow('全球 / 大陆地震预警', '震中到关注点的距离', [thSelect('globalMagnitude', GLOBAL_MAG_OPTIONS, true, '全球与大陆地震预警（最低震级）')]),
    disasterRow('大陆地震速报（CENC 编目）', '台网编目，每天都有', [thSelect('cnReportMagnitude', CN_REPORT_MAG_OPTIONS, true, '大陆地震速报（最低震级）')]),
    fold('震度和震级为什么分开设置',
      h('div', null, '日本给的是震度，全球和大陆给的是震级，两者不能换算。'),
      h('div', null, '大陆速报从 M2.5 起就有数据、每天都很多，所以门槛单独设，免得小震一直响。')),

    // —— 海啸：日本 552 与 NOAA CAP 共用等级闸门 ——
    disasterGroup('海啸', 'tsunami', '提醒'),
    // 0.8.2 review：note 要写清全球源看的是**关注点**（`places`），不是日本那 47 个都道府县。
    // 0.8.1 瘦身时把这句删了，只留"按预警等级"——只配了日本县级关注的用户会以为这一行已经
    // 覆盖 NOAA 海啸，实际匹配走的是「其他国家 / 地区」里的关注点半径。
    disasterRow('日本 · 全球（NOAA）', '全球源按关注点半径判定', [thSelect('tsunamiGrade', TSUNAMI_OPTIONS, false, '海啸等级')]),

    // —— 气象：三家的门槛都固定在该机构真正代表危险的那一档 ——
    // L1/L2 要求的动作不是桌面弹窗能承载的，L3 面向老年人；L4（避難指示级）才真正涉及人身财产
    // 损失，所以这里只有"开 / 关"、没有阈值（DESIGN 10.3）。
    disasterGroup('气象 · 日本（気象庁）', 'weather', '提醒'),
    disasterRow('泥石流 / 洪水 / 大雨 / 高潮', '危险级别才播报', [fixedGate('警戒4级以上')]),

    // 中国大陆气象灾害（0.5.2）：**两个灾种分开**。它们来自同一个源（中央气象台汇总的
    // 预警信号列表），但产出差别很大——暴雨的橙 / 红常年可见，而地质灾害实测全是黄色
    // （达不到播报门槛，只在历史里留痕）。合成一个开关会让"我只想要暴雨"的用户找不到出口。
    disasterGroup('气象 · 中国大陆（中央气象台）', null, null,
      [switchOf('cnRainstorm', '暴雨预警'), switchOf('cnGeology', '地质灾害预警')]),
    disasterRow('暴雨 / 地质灾害', '橙色以上才播报', [fixedGate('橙色以上')]),

    // 海外气象灾害（0.6.0）：美国 NWS + 加拿大 ECCC。一个开关覆盖两个源（各自按关注点生效）。
    disasterGroup('气象 · 海外（美国 NWS / 加拿大 ECCC）', 'overseasWeather', '提醒'),
    disasterRow('洪水 / 山洪 / 降雨 / 风暴潮', '警告级才播报', [fixedGate('警告级（美）· 黄色以上（加）')]),

    // 长解释（安全相关 + 许可署名）收进折叠：一条都不能删，只是不再占主视野。
    fold('各数据源的取舍',
      h('div', { style: { fontWeight: 600, color: '#c8ccd4' } }, '中国大陆气象'),
      h('div', null, '只接暴雨和地质灾害两类。雷电、大风、高温等不接，否则每天几十条会刷屏。'),
      h('div', null, '橙色以上才播报；黄色和蓝色会记进「履历」，但不响铃也不弹通知（免打扰时段也不放行橙色，只有红色能穿透）。'),
      h('div', null, '匹配按行政区：只有在中国大陆分支里选的省、市才算关注点，手填的坐标不参与。机构名只到省级时（比如海南省直辖县）按全省放行，宁可多报也不漏报。'),
      h('div', null, '这批数据没有取消或最终报标志：预警到期就直接从列表里消失，所以没收到取消不代表警报仍然有效。'),
      h('div', { style: { fontWeight: 600, color: '#c8ccd4', marginTop: 4 } }, '海外气象'),
      h('div', null, '关注点在「地区」页的「其他国家 / 地区」里配。美国按县和区划判定，半径 25km 以上时会额外查中心点周围的几个方向，所以半径只是近似、不保证覆盖半径内的所有县；加拿大把半径换算成矩形范围去查，与之相交的预警都算命中。'),
      h('div', null, '美国只播报 Flood / Flash Flood / Coastal Flood Warning，Watch、Advisory、Statement 只记录。'),
      // 措辞订正（0.6.1 review）：ECCC 的 wind warning 确实是 warning（只有霜冻 / 雾是 advisory）
      // ——它被排除是因为**不在本插件的灾种范围内**，不是因为它不危险。
      h('div', null, '加拿大只接 warning 类的降雨、洪水、风暴潮。霜冻和雾属于 ECCC 的 advisory（官方定义就是"非危险天气"）；大风、高温、雷暴虽然是 warning，但不在本插件的灾种范围内。'),
      h('div', null, '打开页面时，如果某条预警已经发布超过 6 小时，只记录不响铃；页面休眠超过 30 分钟再恢复时也按这条处理。'),
      h('div', null, '数据来源：美国国家气象局（NWS）；加拿大环境与气候变化部（ECCC，Data Source: Environment and Climate Change Canada）。')),
    store.weatherHint
      ? h('div', { style: { fontSize: 11, color: '#d9a406', marginTop: 6 } },
          (store.weatherHint.label || '') + ' 有 L' + store.weatherHint.level + ' 气象警报（未达播报级别）')
      : null,
  )
  const flushVolume = () => {
    if (volTimer.current) { clearTimeout(volTimer.current); volTimer.current = null }
    const v = volPending.current
    if (v === null) return
    volPending.current = null
    setVolDraft(null)
    setCfg((c) => ({ ...c, notify: { ...c.notify, volume: v } }))
  }
  const onVolumeInput = (v) => {
    volPending.current = v
    setVolDraft(v)
    if (volTimer.current) clearTimeout(volTimer.current)
    volTimer.current = setTimeout(flushVolume, 300)
  }
  const volShown = volDraft === null ? cfg.notify.volume : volDraft

  const statusMeta = statusMetaOf(store.status, store.retries)
  // 状态圆点。**不带外边距**：用到它的两处（常驻状态条、其他页）都是 flex + gap 排的。
  const dot = h('span', { style: { display: 'inline-block', width: 10, height: 10, borderRadius: '50%', background: statusMeta.color, flexShrink: 0 } })

  const permText = {
    granted: '通知权限：已授权',
    denied: '通知权限：已被拒绝，请在浏览器站点设置里允许',
    default: '通知权限：未授权，点「测试系统通知」授权',
    unsupported: '当前浏览器不支持系统通知',
  }[perm] || ''

  // ---------- 选项卡（0.8.1）----------
  // 九个区块串成一列时，"只想看一眼履历"要滚过全部设置——包括关注地区里那几千个市町村按钮。
  // 按用途分页后每页**只渲染自己能看到的区块**（未选中的页不产生 DOM），"滚到底"这件事直接消失。
  //
  // 分页依据是"用户要做什么"，不是代码结构：地区（我在乎哪里）/ 灾害（哪些灾种、多强）/
  // 通知（怎么响、什么时候别响）/ 履历（刚才发生了什么）/ 其他（链路、诊断、免责）。
  /** 选项卡角标：只有真的有内容时才显示数字，免得三个空数字占视线。 */
  const tabBadgeOf = (v) => {
    if (v === 'region') {
      const n = (cfg.watch.prefectures || []).length + (cfg.watch.places || []).length
      return n > 0 ? ' ' + n : ''
    }
    if (v === 'history') return store.events.length > 0 ? ' ' + store.events.length : ''
    return ''
  }
  const tabBar = () => h('div', {
    style: { display: 'flex', gap: 2, flexWrap: 'wrap', borderBottom: '1px solid rgba(148,163,184,0.18)' },
  }, SETTINGS_TABS.map((t) => {
    const on = tab === t.v
    return h('button', {
      key: t.v,
      onClick: () => setTab(t.v),
      // `aria-current` 而不是 `aria-pressed`：这是"当前显示哪一页"，不是开关。
      // 没有用 role="tablist"/"tab" 是因为那套 ARIA 还要求方向键导航与 tabpanel 关联，
      // 只加一半会让读屏软件给出错误的交互预期（错误的 ARIA 比没有更糟）。
      'aria-current': on ? 'true' : undefined,
      style: {
        fontSize: 12, padding: '7px 13px', cursor: 'pointer', background: 'transparent',
        border: 'none', borderBottom: '2px solid ' + (on ? '#3b82f6' : 'transparent'),
        color: on ? '#e6e6e8' : '#9aa0a6', fontWeight: on ? 600 : 400,
      },
    }, t.label + tabBadgeOf(t.v))
  }))

  /**
   * 常驻状态条（**在选项卡之外**，0.8.1）。
   *
   * 只回答两个问题：通不通、收到多少条。此前这里还跟着一行 `store.detail`（"已连接 EMSC
   * （全球地震实时推送）"之类），而同一批逐源信息在「其他」页的「源状态」里**一字不差地**
   * 躺着——同一件事写两遍，既占地方，又让人以为那是两套东西。细节留给那一页。
   */
  const statusStrip = () => h('div', {
    style: {
      display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap',
      padding: '8px 16px', borderBottom: '1px solid rgba(148,163,184,0.14)', fontSize: 12,
    },
  },
    dot,
    h('span', { style: { fontWeight: 600 } }, statusMeta.text),
    store.received > 0
      ? h('span', { style: { color: '#9aa0a6' } }, '已收到 ' + store.received + ' 条推送')
      : null,
    // 告诉用户"更细的在哪"，但已经在那一页时就不必再说。
    // 颜色用 #9aa0a6 而不是更暗的灰（0.8.2 review）：11px 小字在深色底上要过 AA 4.5:1，
    // 原 #6b7280 只有约 3.4:1，和其余次要文字同一档更稳（也让整页少一种灰）。
    tab === 'misc' ? null : h('span', { style: { color: '#9aa0a6', fontSize: 11, marginLeft: 'auto' } }, '详情在「其他」里'))

  /**
   * 界面语言（0.8.1 先立选项，本地化在 0.9.0）。
   *
   * 现在只有简体中文——所以它暂时"选了也不会有变化"。**为什么还是先做出来**：配置字段、
   * 归一化白名单、Host schema 与 UI 这一整条链路先立起来，0.9.0 写语言包时只要往
   * `LANGUAGE_OPTIONS` 里加项、再补文案表，不必回头改配置契约（改契约要迁移用户配置）。
   * 界面上如实说明这一点，不做成"看起来能切、其实没反应"的假控件。
   */
  const sectionLanguage = () => s.section('语言 / Language',
    // `flex: 1`：这一行只有标签与一个短下拉（"简体中文"），不撑满的话右半边空着、
    // 加上箭头的位置，观感就像"控件没对齐"。撑满后箭头正好落在行右边缘。
    s.row(s.label('界面语言'), s.select(cfg.language, LANGUAGE_OPTIONS,
      (v) => setCfg((c) => ({ ...c, language: v })), (o) => o.label, '界面语言', { flex: 1 })),
    h('div', { style: { fontSize: 11, color: '#9aa0a6', marginTop: 4 } },
      '目前只有简体中文，其他语言在 0.9.0 加入。'),
  )

  /** 数据源与配置存储。数据源切换是"验证用"的，所以与其他排障面同页。 */
  const sectionSource = () => s.section('数据源',
    s.row(
      s.select(cfg.source, [
        { v: 'prod', label: '正式（实时推送）' },
        { v: 'sandbox', label: '沙箱（回放 2023 年数据，测试用）' },
      ], (v) => {
        setCfg((c) => ({ ...c, source: v }))
        // 延时用 ref 保存并在卸载时清理：否则"切换数据源后 80ms 内离开设置页 / 停用插件"
        // 会在到点时复活一个已经没有任何 fiber 归属的 socket（它会继续上报状态并经
        // handleAlert 响铃），直到用户刷新页面。执行前再复查一次 activeClient。
        if (restartTimer.current) clearTimeout(restartTimer.current)
        restartTimer.current = setTimeout(() => {
          restartTimer.current = null
          const c = activeClient // 模块级 live binding：插件停用时已被置为 null
          if (c) { try { c.restart() } catch (err) { /* 忽略 */ } }
        }, 80)
      }, (o) => o.label, '数据源'),
    ),
    h('div', { style: { fontSize: 11, color: '#9aa0a6', marginTop: 6 } },
      '配置：' + settingsSyncLabel()),
  )

  // 大陆源的链路选择（0.5.0）。这是一个**出口**：自动降级判不出的那几种网络
  //（能连上、偶尔漏、整体像坏的）需要一个手动开关，否则用户只能重装或等更新。
  const sectionCnTransport = () => s.section('大陆源链路',
    s.row(s.label('取数方式'), s.select(cfg.cnTransport || 'auto', [
      { v: 'auto', label: '自动（优先推送）' },
      { v: 'poll', label: '强制轮询（15 秒一次）' },
    ], (v) => setCfg((c) => ({ ...c, cnTransport: v })), (o) => o.label, '大陆源取数方式')),
    fold('什么时候需要改成强制轮询',
      h('div', null, 'SSE 推送的延迟是秒级，轮询最坏 15 秒——大陆预警抢的就是这几秒，所以默认用推送。'),
      h('div', null, '只有在推送被网络中间设备反复掐断、而普通请求仍然正常时，才需要强制轮询。当前实际走在哪条路上，看下方「源状态」。')),
  )

  const sectionNotify = () => s.section('通知与声音',
    s.row(
      s.checkbox(cfg.notify.sound !== false, (v) => setCfg((c) => ({ ...c, notify: { ...c.notify, sound: v } })), '提示音'),
      s.checkbox(cfg.notify.system !== false, (v) => setCfg((c) => ({ ...c, notify: { ...c.notify, system: v } })), '系统通知'),
    ),
    s.row(s.label('音量'), h('input', {
      type: 'range', min: 0, max: 100,
      value: Math.round(volShown * 100),
      onChange: (e) => onVolumeInput(Number(e.target.value) / 100),
      'aria-label': '音量',
      style: { flex: 1, minWidth: 120 },
    }), h('span', { style: { color: '#9aa0a6', fontSize: 11, width: 34 } }, Math.round(volShown * 100) + '%')),
    s.row(
      // 试听本身就是用户手势：顺手解锁音频并刷新状态提示（否则"尚未解锁"的警告会一直挂着）
      s.btn('试听地震音', () => { unlockAudio(); setTick((t) => t + 1); playSound('quake', volShown) }),
      s.btn('试听 EEW 音', () => { unlockAudio(); setTick((t) => t + 1); playSound('eew', volShown) }),
      s.btn('试听海啸音', () => { unlockAudio(); setTick((t) => t + 1); playSound('tsunami', volShown) }),
      s.btn('试听气象音', () => { unlockAudio(); setTick((t) => t + 1); playSound('weather', volShown) }),
    ),
    s.row(
      s.btn('测试系统通知', () => {
        unlockAudio()
        const send = () => {
          const ok = showSystemNotification({ title: 'QuakeAlert 测试', body: '这是一条测试系统通知。', tag: 'quake-test', silent: true })
          setTestMsg(ok ? '已发送测试通知，请查看系统通知中心' : '测试通知发送失败')
        }
        if (perm === 'unsupported') { setTestMsg('当前浏览器不支持系统通知，无法测试'); return }
        if (perm === 'denied') { setTestMsg('通知权限已被拒绝 —— 请在浏览器站点设置中允许后重试'); return }
        if (perm === 'default') {
          requestNotificationPermission().then((p) => {
            setPerm(p)
            if (p === 'granted') send()
            else setTestMsg('未获得通知权限（浏览器未授权）')
          })
          return
        }
        send()
      }),
      s.btn('测试 Toast', () => showToast({ title: 'QuakeAlert 测试', body: '页面内弹窗工作正常。', color: '#4ade80', ttlMs: 4000 })),
    ),
    h('div', { style: { color: '#9aa0a6', fontSize: 11, marginTop: 6 } }, permText),
    // 提示音未解锁时必须**显式告知**：页面可见时通知路径只用页内 toast（不发系统通知），
    // 于是"打开 DSH 后从未点过页面"的用户在设置里看到「提示音：开」，实际上一条声音都听不到。
    audioState() === 'suspended'
      ? h('div', { style: { color: '#d9a406', fontSize: 11, marginTop: 4 } },
          '⚠ 提示音还没解锁：点一下页面任意位置就好。')
      : (audioState() === 'unavailable'
        ? h('div', { style: { color: '#9aa0a6', fontSize: 11, marginTop: 4 } }, '当前环境不支持 Web Audio，提示音不可用。')
        : null),
    testMsg ? h('div', { role: 'status', style: { color: '#93c5fd', fontSize: 11, marginTop: 4 } }, testMsg) : null,
  )

  // 静默时段（0.2.0）
  const sectionQuiet = () => s.section('静默时段',
    s.row(s.checkbox(cfg.quietHours.enabled, (v) => setCfg((c) => ({ ...c, quietHours: { ...c.quietHours, enabled: v } })), '启用静默时段')),
    s.row(
      s.label('开始'),
      h('input', {
        type: 'time', value: cfg.quietHours.start,
        'aria-label': '静默时段开始时间',
        onChange: (e) => setCfg((c) => ({ ...c, quietHours: { ...c.quietHours, start: e.target.value || c.quietHours.start } })),
        style: { background: '#ffffff', color: '#1a1a1a', border: '1px solid #6b7280', borderRadius: 6, padding: '4px 8px', fontSize: 12 },
      }),
      s.label('结束'),
      h('input', {
        type: 'time', value: cfg.quietHours.end,
        'aria-label': '静默时段结束时间',
        onChange: (e) => setCfg((c) => ({ ...c, quietHours: { ...c.quietHours, end: e.target.value || c.quietHours.end } })),
        style: { background: '#ffffff', color: '#1a1a1a', border: '1px solid #6b7280', borderRadius: 6, padding: '4px 8px', fontSize: 12 },
      }),
    ),
    s.row(s.checkbox(cfg.quietHours.breakForSevere, (v) => setCfg((c) => ({ ...c, quietHours: { ...c.quietHours, breakForSevere: v } })), '紧急警报仍提醒（EEW、海啸警报、震度6弱以上、气象4级以上）')),
    h('div', { style: { fontSize: 11, color: '#9aa0a6', marginTop: 6 } },
      // 时区基准必须写出来（0.8.2 review 补回）：不写的话"23:00"是本地时间还是 JST 全靠猜，
      // 而这个判定用的是**浏览器本地时间**（inQuietHours），跨时区用户猜错就会在半夜被响铃。
      '按浏览器本地时间判定。跨夜时段写成 23:00–07:00。免打扰期间仍会记录。'),
  )

  // 测试与诊断（0.8.0 合并）：两类测试按钮都是"无灾情时验证整条链路"的入口，与源状态、
  // 诊断快照同属排障面——此前它们散在「灾害类型」与「其他地区」两个区块里，用户要确认
  // "这个源到底在不在拉"，得先滚到对应灾种那一节去找。
  const sectionDiagnostics = () => s.section('测试与诊断',
    h('div', { style: { fontSize: 11, color: '#9aa0a6', marginBottom: 6 } },
      '测试消息不会联网，用来确认提醒是否正常。'),
    // 气象链路：区域取关注列表首项，保证一定命中（否则点了没反应会让人以为坏了）。
    s.row(s.btn('发送测试气象警报', () => {
      const pref = (cfg.watch.prefectures && cfg.watch.prefectures[0]) || '東京都'
      const sc = TEST_SCENARIOS[weatherTestSeq % TEST_SCENARIOS.length]
      const ms = Date.now()
      const city = citiesOfPref(pref)[0] || '' // 市町村级场景用真实市町村名
      const alert = parseJma(buildTestTelegram(pref, ms, sc.key, city), { id: 'test-weather-' + ms })
      setWeatherTestSeq(weatherTestSeq + 1)
      if (!alert) { setWeatherTestMsg('测试消息解析失败，请把这个情况反馈给开发者'); return }
      // 事件键改成**每次都不同**（0.5.4），否则同一场景第二次就静默：汇总型电文的事件键是
      // 「灾种 + 官署」（刻意不含发布时刻，见 05b 的说明），于是连点两次会算出同一个键，
      // 被 `isEventRepeat` 判成"同一事件的后续发布（强度未升级）"而只记历史——与按钮文案
      // "可反复点击"直接矛盾。全球链路早就显式改写过事件键（05c 的 parseTestGlobalMessage），
      // 气象这条漏了。语义上也成立：每次点击本来就是一次独立的演示。
      alert.eventKey = 'test-weather:' + ms + ':' + sc.key
      const res = handleAlert(alert, currentCfg(), { skipQuietHours: true })
      // 提示按**实际结果**生成，不写死"应看到弹窗"——开关关闭 / 未达 L4 / 静默 / 其它标签页
      // 已提醒时，实际就是不会响，提示必须如实说明，否则会让人以为插件坏了。
      const outcome = res && res.notified
        ? ' —— 已播报：应看到提示音与弹窗'
        : ' —— 未播报（' + ((res && res.detail) || '未知原因') + '），只会记入「履历」'
      setWeatherTestMsg('已发送：' + sc.label + '（' + pref + ' / 警戒レベル' + alert.level + '，' + sc.note + '）' + outcome)
    })),
    h('div', { style: { fontSize: 11, color: '#9aa0a6', marginTop: 4 } },
      '每次点击换一个场景：' + TEST_SCENARIOS.map((x) => x.label).join(' / ') + '。'),
    weatherTestMsg
      ? h('div', { role: 'status', style: { color: '#93c5fd', fontSize: 11, marginTop: 4 } }, weatherTestMsg)
      : null,
    // 全球链路（0.4.0）：构造的是**源格式原文**（EMSC / USGS / NOAA 各一种），
    // 因此解析器与匹配引擎都被真实走过。
    s.row(s.btn('发送测试全球警报', () => {
      const places = cfg.watch.places || []
      if (places.length === 0) { setGeTestMsg('请先在「地区」里添加一个位置，测试消息需要一个震中'); return }
      const sc = TEST_GEO_SCENARIOS[geTestSeq % TEST_GEO_SCENARIOS.length]
      const ms = Date.now()
      const msg = buildTestGlobalMessage(places[0], ms, sc.key)
      setGeTestSeq(geTestSeq + 1)
      const alert = parseTestGlobalMessage(msg)
      if (!alert) { setGeTestMsg('测试消息解析失败，请把这个情况反馈给开发者'); return }
      const res = handleAlert(alert, currentCfg(), { skipQuietHours: true })
      // 提示按**实际结果**生成：开关关闭 / 半径外 / 静默 / 其它标签页已提醒时就是不会响，
      // 必须如实说明，否则用户会以为插件坏了
      const outcome = res && res.notified
        ? ' —— 已播报：应看到提示音与弹窗'
        : ' —— 未播报（' + ((res && res.detail) || '未知原因') + '），只会记入「履历」'
      setGeTestMsg('已发送：' + sc.label + '（' + sc.note + '）' + outcome)
    })),
    h('div', { style: { fontSize: 11, color: '#9aa0a6', marginTop: 4 } },
      '每次点击换一个场景：' + TEST_GEO_SCENARIOS.map((x) => x.label).join(' / ') +
      '。最后一条在约 550km 外，用来演示半径的作用。'),
    geTestMsg ? h('div', { role: 'status', style: { color: '#93c5fd', fontSize: 11, marginTop: 4 } }, geTestMsg) : null,
    // 源状态：逐源的连接 / 增量 / 失败计数。放在这里而不是某个地区区块下面——它回答的是
    // "哪条链路在动"，与关注了哪个国家无关。
    h(SourceStatusBlock, { key: 'source-status' }),
    // 诊断快照（0.5.0）：DESIGN 11.3 的交付物——让"运行时自己说话"。
    // 界面上只做两件事：生成、以及**在剪贴板不可用时把文本显示出来**（沙箱 iframe 里
    // navigator.clipboard 常常不可用，而"复制不了"不该成为诊断的第一步就卡住）。
    h('div', { style: { marginTop: 12, borderTop: '1px solid rgba(148,163,184,0.18)', paddingTop: 10 } },
      h('div', { style: { fontSize: 11, color: '#9aa0a6' } },
        '把快照发给 AI 助手，配合 TROUBLESHOOTING.zh.md 排查。')),
    s.row(s.btn('生成诊断快照', () => {
      copyDiagSnapshot().then((r) => setDiag({
        text: r.text,
        msg: r.ok ? '已复制到剪贴板。' : ('剪贴板不可用' + (r.error ? '（' + r.error + '）' : '') + '，请手动全选下面的文本复制。'),
      })).catch((err) => setDiag({ text: '', msg: '生成失败：' + String((err && err.message) || err) }))
    })),
    h('div', { style: { fontSize: 11, color: '#d9a406', marginTop: 4 } },
      '⚠ 包含你关注的地区和坐标，分享前请注意。'),
    diag ? h('div', { role: 'status', style: { color: '#93c5fd', fontSize: 11, marginTop: 4 } }, diag.msg) : null,
    diag && diag.text
      ? h('textarea', {
          readOnly: true, value: diag.text, rows: 10,
          onFocus: (e) => { try { e.target.select() } catch (err) { /* 忽略 */ } },
          style: {
            width: '100%', boxSizing: 'border-box', marginTop: 6, fontSize: 11,
            fontFamily: 'ui-monospace, monospace', background: '#ffffff', color: '#1a1a1a',
            border: '1px solid #6b7280', borderRadius: 6, padding: 8,
          },
        })
      : null,
  )

  // 免责（0.8.1）：核心一句留在主视野（它是安全相关声明），完整来源与免责收进折叠。
  const sectionDisclaimer = () => s.section('免责声明',
    h('div', { style: { color: '#9aa0a6', fontSize: 11 } },
      '仅供参考。避险请以当地官方发布为准。页面关闭后不会再提醒。'),
    fold('数据来源与完整声明',
      h('div', null, '预警数据由 P2PQuake 转播、日本气象厅公开 XML 电文、EMSC / USGS / NOAA，美国国家气象局（NWS）与加拿大环境与气候变化部（ECCC）的公开接口（浏览器直连），以及 Wolfx 转播的中国地震台网（CENC）信息提供，均非官方直接推送；紧急地震速报（EEW）与大陆地震预警等内容与配信品质无保证。'),
      h('div', null, '避险请以当地主管机构（日本气象厅 気象庁 / 中国地震台网 CENC / 美国 NWS・USGS・NOAA / 加拿大 ECCC 等）官方发布为准。')))

  // 最近预警（点击条目展开详情；多条时可滚动）
  const sectionHistory = () => s.section('预警记录（' + store.events.length + ' 条）',
    h('div', { style: { fontSize: 11, color: '#9aa0a6', marginBottom: 6 } },
      '没到阈值、没有提醒的记录也在里面。点开看详情。'),
    store.events.length === 0
      ? h('div', { style: { color: '#9aa0a6', fontSize: 12, padding: '4px 0' } }, '暂无记录')
      : h('div', { style: { maxHeight: 300, overflowY: 'auto', paddingRight: 4 } },
          store.events.slice(0, HISTORY_MAX).map((e, i) => {
            const itemKey = e.key || e.id || i
            const open = expanded === itemKey
            const toggle = () => setExpanded(open ? null : itemKey)
            const head = String(e.headline || '')
            const muted = e.hit === false || e.suppressed === true
            const statusText = e.hit === false
              ? '未触发提醒'
              : (e.suppressed ? '未重复提醒' : (e.pref ? '命中 ' + e.pref : '已提醒'))
            // 气象电文来自気象庁防災情報XML，没有 P2PQuake 的 code：旧写法对 weather 落进
            // 最后的 else 分支，展开详情时会把泥石流 / 洪水电文标成「code 551」（地震速报）。
            const codeText = p2pCodeTextOf(e.kind, e.code, e.id)
            return h('div', {
              key: itemKey,
              // 可键盘操作（0.4.1）：详情是用户核对"插件到底看到了什么"的唯一入口，
              // 只在 onClick 上可用等于把键盘 / 读屏用户挡在门外。
              role: 'button',
              tabIndex: 0,
              'aria-expanded': open,
              onClick: toggle,
              onKeyDown: (ev) => {
                if (ev.key === 'Enter' || ev.key === ' ' || ev.key === 'Spacebar') { ev.preventDefault(); toggle() }
              },
              title: open ? '点击收起（回车 / 空格同样可用）' : '点击展开详情（回车 / 空格同样可用）',
              style: Object.assign({
                cursor: 'pointer',
                borderLeft: '3px solid ' + kindColorOf(e.kind),
                background: open
                  ? (muted ? 'rgba(148,163,184,0.16)' : 'rgba(59,130,246,0.22)')
                  : (muted ? 'rgba(148,163,184,0.05)' : 'rgba(148,163,184,0.09)'),
                borderRadius: 6, padding: '6px 10px', margin: '5px 0',
              }, open ? { boxShadow: 'inset 0 0 0 1px rgba(148,163,184,0.55)' } : null),
            },
              h('div', { style: { display: 'flex', gap: 8, alignItems: 'center' } },
                h('span', { style: { fontWeight: 700, fontSize: 12, color: kindColorOf(e.kind) } }, String(e.label || '')),
                h('span', { style: { fontSize: 11, border: '1px solid ' + (muted ? '#8b8f98' : '#4ade80'), color: muted ? '#8b8f98' : '#4ade80', borderRadius: 8, padding: '0 6px' } }, statusText),
                h('span', { style: { color: '#9aa0a6', fontSize: 11, marginLeft: 'auto', whiteSpace: 'nowrap' } }, open ? '▲ 收起' : '▼ 展开')),
              !open
                ? h('div', { style: { fontSize: 12, color: '#c8ccd4', marginTop: 3, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' } }, head)
                : h('div', { style: { fontSize: 12, marginTop: 6 } },
                    h('div', { style: { display: 'flex', gap: 6 } },
                      h('span', { style: { color: '#9aa0a6', width: 44 } }, '类型'),
                      h('span', { style: { color: '#e6e6e8' } }, String(e.label || '') + '（' + codeText + '）')),
                    h('div', { style: { display: 'flex', gap: 6, marginTop: 2 } },
                      h('span', { style: { color: '#9aa0a6', width: 44 } }, '时间'),
                      // 按**本地时区**渲染（DESIGN 第 4 节）：解析层存的是带偏移的 ISO 8601，
                      // 直接显示原文会让大陆用户看到一个差 1 小时且无标注的 JST 时间。
                      h('span', { style: { color: '#e6e6e8' } }, formatIssuedLocal(e.issued) || '—')),
                    e.pref ? h('div', { style: { display: 'flex', gap: 6, marginTop: 2 } },
                      h('span', { style: { color: '#9aa0a6', width: 44 } }, '命中'),
                      h('span', { style: { color: '#e6e6e8' } }, String(e.pref))) : null,
                    e.suppressedReason ? h('div', { style: { display: 'flex', gap: 6, marginTop: 2 } },
                      h('span', { style: { color: '#9aa0a6', width: 44 } }, '说明'),
                      h('span', { style: { color: '#e6e6e8' } }, String(e.suppressedReason))) : null,
                    h('div', { style: { display: 'flex', gap: 6, marginTop: 2 } },
                      h('span', { style: { color: '#9aa0a6', width: 44 } }, '内容'),
                      h('span', { style: { color: '#e6e6e8', flex: 1, wordBreak: 'break-all' } }, head)),
                    // 官方正文（0.6.1）：NWS 的 description + instruction、ECCC 的正文 + 署名。
                    // 此前 alert.detail 在整条链路上**没有任何消费者**——用户看不到洪水预警里
                    // "该怎么做"那一段，ECCC 许可要求的署名也进不了界面（见 05h 的文件头）。
                    e.detail ? h('div', { style: { display: 'flex', gap: 6, marginTop: 4 } },
                      h('span', { style: { color: '#9aa0a6', width: 44, flexShrink: 0 } }, '正文'),
                      h('span', { style: { color: '#c8ccd4', flex: 1, whiteSpace: 'pre-wrap', wordBreak: 'break-word' } }, String(e.detail))) : null,
                  ),
            )
          }),
        ),
    s.row(s.btn('清空记录', () => {
      store.push({ events: [] })
      saveJSON(HISTORY_KEY, [])
      // 还要广播：其它标签页的内存副本不清的话，它们下一次 addEvent 会把整份记录（含刚被
      // 清掉的条目）重新写回磁盘——用户以为清空了，实际只是本标签页看不见（若清空的动机
      // 是隐私，这就是实际的信息泄露面）。
      broadcastHistoryCleared()
    })),
  )

  return h('div', { style: { fontFamily: 'system-ui, sans-serif', fontSize: 13, color: '#dfe3e8' } },
    statusStrip(),
    tabBar(),
    tab === 'region' ? sectionWatch() : null,
    tab === 'disaster' ? sectionDisasters() : null,
    tab === 'notify' ? h('div', null, sectionNotify(), sectionQuiet()) : null,
    tab === 'history' ? sectionHistory() : null,
    tab === 'misc' ? h('div', null, sectionSource(), sectionCnTransport(), sectionLanguage(), sectionDiagnostics(), sectionDisclaimer()) : null,
  )
}


export { statusMetaOf, SettingsPanel, p2pCodeTextOf, kindColorOf, P2P_KIND_CODE, KIND_COLORS, SOURCE_ORDER, SOURCE_LABELS, SOURCE_CODE_TEXT, SETTINGS_TABS }
