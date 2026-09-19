// ============================================================================
// dsh-quake-alert · client/src/13-ui-settings.js
//
// 作用：设置页面板（设置 → 灾害预警）的全部 UI。
// 内容：连接状态与数据源、关注地区（都道府县 + 市区町村搜索多选）、
//       三类阈值、通知与声音（含音量防抖落盘）、静默时段、免责声明、最近预警记录。
// 依赖：01-constants、02-storage、03-settings-bridge、04-city-table、07-store、08-audio、09-notify。
// 约定：所有写入都经 applyCfg，保证内存/镜像/Host 三处一致。
// ============================================================================

import { h, useState, useEffect, useRef, PREFECTURES, SCALE_OPTIONS, TSUNAMI_OPTIONS, GLOBAL_MAG_OPTIONS, CN_REPORT_MAG_OPTIONS, RADIUS_PRESETS, DEFAULT_PLACE_RADIUS_KM, MIN_PLACE_RADIUS_KM, MAX_PLACE_RADIUS_KM, HISTORY_MAX, HISTORY_KEY, MAX_WATCH_CITIES, MAX_WATCH_PLACES, formatIssuedLocal } from './01-constants.js'
import { saveJSON, own } from './02-storage.js'
import { currentCfg, applyCfg, settingsSync } from './03-settings-bridge.js'
import { citiesOfPref, cityTableState, loadCityTable, cnProvinces, cnCitiesOf, cnPlaceOf } from './04-city-table.js'
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
import { broadcastHistoryCleared } from './10-dedupe.js'
import { retrySource } from './05d-source-contracts.js'

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
    host: '机器级 settings.yaml（DSH settings 服务）',
    memory: '仅本浏览器（当前页面不支持 Host 持久化）',
    local: '浏览器 localStorage',
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
  const c = own(P2P_KIND_CODE, kind)
  if (c) return 'code ' + c
  // 兜底：气象（kind='weather'）在 0.5.2 之前只有日本这一个来源。现在有了大陆气象源，
  // 所以这里的兜底必须注明它是**日方**的，而不是把两者混起来（大陆那条在上面的 id / code 分支已拦下）。
  return kind === 'weather' ? 'JMA 电文' : '—'
}
// 灾种配色：气象灾害此前没有键，历史条目一律落到灰色兜底，与另外三类不一致
const KIND_COLORS = { eew: '#e5484d', quake: '#3b82f6', tsunami: '#f76b15', weather: '#8b5cf6' }
const kindColorOf = (kind) => own(KIND_COLORS, kind) || '#7c8494'
const s = {
  section: (title, ...children) => h('div', { style: { padding: '14px 16px', borderBottom: '1px solid rgba(148,163,184,0.14)' } },
    h('div', { style: { fontWeight: 700, fontSize: 13, marginBottom: 10, color: '#dfe3e8' } }, title), ...children),
  label: (text) => h('div', { style: { color: '#9aa0a6', fontSize: 12, marginBottom: 4 } }, text),
  row: (...children) => h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', margin: '4px 0' } }, ...children),
  checkbox: (checked, onChange, text) => h('label', { style: { display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, cursor: 'pointer', color: '#dfe3e8' } },
    h('input', { type: 'checkbox', checked, onChange: (e) => onChange(e.target.checked) }), text),
  select: (value, options, onChange, textOf) => h('select', {
    value, onChange: (e) => onChange(e.target.value),
    style: { background: '#ffffff', color: '#1a1a1a', border: '1px solid #6b7280', borderRadius: 6, padding: '4px 8px', fontSize: 12, minWidth: 180 },
  }, options.map((o) => h('option', {
    key: String(o.v !== undefined ? o.v : o.g), value: String(o.v !== undefined ? o.v : o.g),
    style: { background: '#ffffff', color: '#1a1a1a' },
  }, textOf(o)))),
  btn: (text, onClick, extra) => h('button', {
    onClick,
    style: Object.assign({ background: 'rgba(148,163,184,0.12)', color: 'inherit', border: '1px solid rgba(148,163,184,0.35)', borderRadius: 6, padding: '5px 12px', cursor: 'pointer', fontSize: 12 }, extra || {}),
  }, text),
}

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
}
/**
 * 源状态区块里的源顺序与分组。**一处维护**：此前同样的列表在三个地方各写一遍
 * （状态行、增量计数行、重试按钮），加一个源要改三处——漏掉任何一处就变成
 * "某个源坏了但界面上看不见"，而"让失败可见"正是这个区块存在的全部理由。
 */
const SOURCE_ORDER = ['p2pquake', 'emsc', 'cenc_eew', 'cenc_eqlist', 'jma', 'usgs', 'noaa', 'nmc_alarm']
/** 走 `/feed` 增量计数的源（feedStatsOf 有快照）。大陆地震源走 SSE，另有自己的计数与链路模式。 */
const FEED_STAT_ORDER = ['jma', 'usgs', 'noaa', 'nmc_alarm']
/** 走 SSE 的源（0.5.0）：状态从 cnStreamRegistry 实时读。 */
const STREAM_ORDER = ['cenc_eew', 'cenc_eqlist']
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

function SettingsPanel() {
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
    setCfg((c) => ({ ...c, watch: { ...c.watch, places: (c.watch.places || []).concat([{ name, lat, lon, radiusKm }]) } }))
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
          watch: { ...cf.watch, places: (cf.watch.places || []).concat([{ name: '我的位置', lat, lon, radiusKm: cnPick.radiusKm }]) },
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
          ? '行政区划表加载失败 —— 可以改用下面的「其他地区」手填坐标（可重启 dsh web 重试）'
          : '正在加载行政区划表…')
    }
    const cities = cnCitiesOf(cnPick.province)
    const provOptions = [{ v: '', label: '请选择省份 / 直辖市 / 特别行政区' }]
      .concat(provinces.map((p) => ({ v: p.name, label: p.name })))
    const cityOptions = (cities.length ? cities : [{ name: '' }]).map((c) => ({ v: c.name, label: c.name || '（先选省份）' }))
    return h('div', null,
      h('div', { style: { display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' } },
        s.select(cnPick.province, provOptions, pickProvince, (o) => o.label),
        s.select(cnPick.city, cityOptions, (v) => { setCnPick((p) => ({ ...p, city: v })); setCnMsg('') }, (o) => o.label),
      ),
      h('div', { style: { marginTop: 6 } },
        radiusControl(cnPick.radiusKm, (v) => setCnPick((p) => ({ ...p, radiusKm: v })), 'cn-radius')),
      h('div', { style: { marginTop: 8, display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' } },
        s.btn('添加这个城市', addCnPlace),
        s.btn('用我的位置', addMyLocationPlace, { fontSize: 11 }),
      ),
      cnMsg ? h('div', { style: { fontSize: 11, color: '#93c5fd', marginTop: 6 } }, cnMsg) : null,
    )
  }
  // 全球源状态（0.4.0）：用户看不出"链路到底在不在拉"，这是最常见的困惑来源——
  // 尤其全球地震本来就不频繁。feedStatsOf 不经过 store（见 12b 的注释），
  // 所以由 SourceStatusBlock 自己每 5 秒重读（见文件下方）。
  // 市区町村选择器：数据表到位后，为每个已关注的县提供「搜索 + 多选」
  const cityPicker = () => {
    if (cityTableState === 'failed') {
      return h('div', { style: { fontSize: 11, color: '#d9a406', marginTop: 10 } },
        '市区町村表加载失败 —— 当前仅支持按都道府县关注（可重启 dsh web 重试）')
    }
    if (cfg.watch.prefectures.length === 0) {
      return h('div', { style: { fontSize: 11, color: '#9aa0a6', marginTop: 10 } },
        '先选择都道府县，再可选地细化到市区町村')
    }
    if (cityTableState !== 'ready') {
      return h('div', { style: { fontSize: 11, color: '#9aa0a6', marginTop: 10 } }, '正在加载市区町村表…')
    }
    return h('div', { style: { marginTop: 10 } },
      h('div', { style: { fontSize: 11, color: '#9aa0a6', marginBottom: 4 } },
        '可选细化到市区町村（不选 = 该县全境）。只有地震情报的观测点有市町村粒度；EEW 与海啸是区域级，仍按县判定。'),
      cfg.watch.prefectures.map((pref) => {
        const list = citiesOfPref(pref)
        if (list.length === 0) return null
        const q = cityQuery[pref] || ''
        const shown = q ? list.filter((c) => c.indexOf(q) !== -1) : list
        const sel = list.filter((c) => cfg.watch.cities.indexOf(c) !== -1).length
        return h('div', { key: pref, style: { border: '1px solid rgba(148,163,184,0.18)', borderRadius: 6, padding: '6px 8px', margin: '6px 0' } },
          h('div', { style: { fontSize: 12, color: '#dfe3e8', marginBottom: 4 } },
            pref + '：' + (sel === 0 ? '全境（未细化）' : '已选 ' + sel + ' 个市町村')),
          h('input', {
            type: 'text', value: q, placeholder: '搜索 ' + pref + ' 的市町村…',
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
              ? h('span', { style: { fontSize: 11, color: '#9aa0a6' } }, '…共 ' + shown.length + ' 个，请用搜索缩小范围')
              : null),
        )
      }),
    )
  }
  // 灾害类型（0.3.0）：三个开关并列。气象灾害的操作边界写死在 L4，不给阈值旋钮——
  // L1/L2 的正确行动不是桌面弹窗，L3 面向老年人；L4（避難指示级）才真正涉及人身财产损失。
  // 因此这里只有"开 / 关"，没有第三档（DESIGN 10.3）。
  const sectionDisasters = () => s.section('灾害类型',
    s.row(
      s.checkbox(cfg.disasters.earthquake !== false,
        (v) => setCfg((c) => ({ ...c, disasters: { ...c.disasters, earthquake: v } })), '地震 / 紧急地震速报'),
      s.checkbox(cfg.disasters.tsunami !== false,
        (v) => setCfg((c) => ({ ...c, disasters: { ...c.disasters, tsunami: v } })), '海啸'),
      s.checkbox(cfg.disasters.weather !== false,
        (v) => setCfg((c) => ({ ...c, disasters: { ...c.disasters, weather: v } })), '气象灾害'),
    ),
    h('div', { style: { fontSize: 11, color: '#9aa0a6', marginTop: 6, lineHeight: 1.6 } },
      '气象灾害＝泥石流 / 洪水 / 大雨 / 高潮 等。只播报警戒レベル4 以上（相当于日本的「避难指示」级：' +
      '土砂災害警戒情報、氾濫危険情報、大雨特別警報…）；L1〜L3 仍然解析并记入下方「最近预警记录」，只是不响铃、不弹通知。'),
    // 中国大陆气象灾害（0.5.2）：**两个灾种分开**。它们来自同一个源（中央气象台汇总的
    // 预警信号列表），但产出差别很大——暴雨的橙 / 红常年可见，而地质灾害实测全是黄色
    // （达不到播报门槛，只在历史里留痕）。合成一个开关会让"我只想要暴雨"的用户找不到出口。
    h('div', { style: { fontSize: 12, color: '#9aa0a6', marginTop: 12, marginBottom: 2 } },
      '中国大陆气象灾害（中央气象台汇总各级气象台发布）'),
    s.row(
      s.checkbox(cfg.disasters.cnRainstorm !== false,
        (v) => setCfg((c) => ({ ...c, disasters: { ...c.disasters, cnRainstorm: v } })), '暴雨预警'),
      s.checkbox(cfg.disasters.cnGeology !== false,
        (v) => setCfg((c) => ({ ...c, disasters: { ...c.disasters, cnGeology: v } })), '地质灾害预警'),
    ),
    h('div', { style: { fontSize: 11, color: '#9aa0a6', marginTop: 4, lineHeight: 1.6 } },
      // 注意：这是**界面文本**（React 文本节点），不是 markdown——写 `**粗体**` 会在页面上
      // 原样渲染出星号。强调靠语序，不靠标记。
      '只接暴雨与地质灾害两类（雷电 / 大风 / 高温等其余灾种不接，否则会被每天几十条刷屏）。' +
      '只播报橙色及以上；黄色 / 蓝色仍然记录在下方「最近预警记录」里，只是不响铃、不弹通知' +
      '（因此静默时段默认也不会放行橙色——它只在红色时穿透）。' +
      '匹配按行政区层级：在「中国大陆」里选到的省 / 市才算关注点，自由填写的坐标点不参与；' +
      '机构名只报出省级（如海南省直辖县）时会按整个省放行，宁可多报一次也不漏报。' +
      '与大陆地震源一样，这批数据没有「解除」标志——预警到期会直接从这个列表里消失，' +
      '所以"没收到取消"不等于"警报仍然有效"。'),
    store.weatherHint
      ? h('div', { style: { fontSize: 11, color: '#d9a406', marginTop: 4 } },
          '当前：' + (store.weatherHint.label || '') +
          ' 有 L' + store.weatherHint.level + ' 气象警报（未达 L4，未播报）')
      : null,
    // 无灾情时也能验证整条链路：用本地构造的电文走完 解析 → 匹配 → 播报 → 历史，
    // 不产生任何外部请求。每次点击轮换一种场景，覆盖级别落点与区域粒度的不同分支。
    // 区域取关注列表首项，保证一定命中（否则点了没反应会让人以为坏了）。
    s.row(s.btn('发送测试气象警报（轮换场景）', () => {
      const pref = (cfg.watch.prefectures && cfg.watch.prefectures[0]) || '東京都'
      const sc = TEST_SCENARIOS[weatherTestSeq % TEST_SCENARIOS.length]
      const ms = Date.now()
      const city = citiesOfPref(pref)[0] || '' // 市町村级场景用真实市町村名
      const alert = parseJma(buildTestTelegram(pref, ms, sc.key, city), { id: 'test-weather-' + ms })
      setWeatherTestSeq(weatherTestSeq + 1)
      if (!alert) { setWeatherTestMsg('测试电文解析失败 —— 请把这个情况反馈给开发者'); return }
      const res = handleAlert(alert, currentCfg(), { skipQuietHours: true })
      // 提示按**实际结果**生成，不写死"应看到弹窗"——开关关闭 / 未达 L4 / 静默 / 其它标签页
      // 已提醒时，实际就是不会响，提示必须如实说明，否则会让人以为插件坏了。
      const outcome = res && res.notified
        ? ' —— 已播报：应看到提示音与弹窗'
        : ' —— 未播报（' + ((res && res.detail) || '未知原因') + '），只会记入下方「最近预警记录」'
      setWeatherTestMsg('已发送：' + sc.label + '（' + pref + ' / 警戒レベル' + alert.level + '，' + sc.note + '）' + outcome)
    })),
    h('div', { style: { fontSize: 11, color: '#9aa0a6', marginTop: 4, lineHeight: 1.6 } },
      '测试电文在本地构造，不发任何网络请求，可反复点击。场景依次为：' +
      TEST_SCENARIOS.map((x) => x.label).join(' / ') +
      '。其中 L3 那条刻意不会响铃——用来演示 L1〜L3 的处理方式。'),
    weatherTestMsg
      ? h('div', { style: { color: '#93c5fd', fontSize: 11, marginTop: 4 } }, weatherTestMsg)
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
  const dot = h('span', { style: { display: 'inline-block', width: 10, height: 10, borderRadius: '50%', background: statusMeta.color, marginRight: 8 } })

  const permText = {
    granted: '通知权限：已授权',
    denied: '通知权限：被拒绝（请在浏览器站点设置中允许）',
    default: '通知权限：未授权 — 点下方「测试系统通知」授权',
    unsupported: '当前浏览器不支持系统通知',
  }[perm] || ''

  return h('div', { style: { fontFamily: 'system-ui, sans-serif', fontSize: 13, color: '#dfe3e8' } },
    // 连接状态 + 数据源（测试切换）
    s.section('连接状态',
      h('div', { style: { display: 'flex', alignItems: 'center', gap: 6, marginBottom: 8 } },
        dot,
        h('span', { style: { fontWeight: 600 } }, statusMeta.text),
        h('span', { style: { color: '#9aa0a6', fontSize: 11 } }, store.detail || ''),
        store.received > 0
          ? h('span', { style: { color: '#4ade80', fontSize: 11, border: '1px solid rgba(74,222,128,0.4)', borderRadius: 10, padding: '0 6px' } },
              '已收到 ' + store.received + ' 条推送')
          : null),
      s.label('数据源'),
      s.row(
        s.select(cfg.source, [
          { v: 'prod', label: '正式：P2PQuake 实时推送' },
          { v: 'sandbox', label: '沙箱：回放 2023 年历史（约30秒/条，测试用）' },
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
        }, (o) => o.label),
      ),
      h('div', { style: { fontSize: 11, color: '#9aa0a6', marginTop: 6 } },
        '配置存储：' + settingsSyncLabel()),
    ),

    // 关注地区
    // 关注地区按**国家 / 地区**分组（DESIGN 9 的"三级级联"：国家/地区 → 一级行政区 → 市/町村）。
    // 为什么不做成一个统一的下拉级联组件：日本这一路是 47 个都道府县 + 1917 个市区町村的两级多选，
    // 中国这一路是省 → 地级市，两者的**选择语义不同**（日本源按行政区名匹配，大陆源按坐标 + 半径）。
    // 硬塞进同一个控件只会让两边都变得难用；这里保证的是**用户视角的三级结构一致**。
    s.section('① 日本：都道府县 / 市区町村',
      h('div', { style: { fontSize: 11, color: '#9aa0a6', marginBottom: 8 } },
        cfg.watch.prefectures.length === 0
          ? '未选择 → 将提醒全日本（按下方阈值过滤）。建议选择你所在/关注的地区以减少打扰。'
          : '已关注 ' + cfg.watch.prefectures.length + ' 个地区'),
      h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 5 } },
        PREFECTURES.map((p) => {
          const on = cfg.watch.prefectures.indexOf(p.jp) !== -1
          return h('button', {
            key: p.jp,
            onClick: () => togglePref(p.jp),
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
    ),

    // 灾害类型（0.3.0）
    sectionDisasters(),

    // 中国大陆（0.5.0）：省 → 地级市 → 半径。大陆源是坐标型，所以选完城市即得到坐标。
    s.section('② 中国大陆：省 / 地级市',
      h('div', { style: { fontSize: 11, color: '#9aa0a6', marginBottom: 8, lineHeight: 1.6 } },
        '中国地震台网的预警与速报按「震中坐标 + 半径」判定（大陆源没有分区烈度），' +
        '所以这里选城市即可，不需要知道经纬度。表里的坐标是**行政区中心点**——' +
        '面积特别大的州 / 市（如甘孜州、哈尔滨市）离城区可差一百多公里，住在边缘时请把半径调大，' +
        '或用「用我的位置」。'),
      // 无取消机制是**安全相关**的缺口：DESIGN 8.3 / 10.2 明确要求 UI 如实说明，不得假装能处理。
      // 不写这一句的话，用户"没收到取消"会自然读成"警报仍然有效"，而真实原因是这一路数据
      // 根本没有取消 / 最终报字段（日本 EEW 与海啸有那条链路，大陆源没有）。
      h('div', { style: { fontSize: 11, color: '#d9a406', marginBottom: 8, lineHeight: 1.6 } },
        '⚠ 这一路数据**没有取消 / 最终报标志**：此前播报过的预警若被上游撤销或修订，' +
        '插件不会补一条「已作废」（日本 EEW / 海啸有这条链路，大陆源没有）。' +
        '收到大陆预警后，请以中国地震台网（CENC）官方发布为准。'),
      cnCascade(),
    ),

    // 全球关注点（0.4.0）：全球源是坐标型，关注表达是「位置 + 半径」
    s.section('③ 其他地区：坐标 + 半径',
      h('div', { style: { fontSize: 11, color: '#9aa0a6', marginBottom: 8 } },
        (cfg.watch.places || []).length === 0
          ? '未设置时，全球源（EMSC / USGS 地震、NOAA 海啸）的消息不会打扰你。添加你所在或关心的位置即可生效，不需要重启。' +
            '这里填的坐标与「② 中国大陆」加进来的城市是**同一份列表**。'
          : '已设置 ' + cfg.watch.places.length + ' 个位置：震中落在半径内才提醒。日本的地震 / 海啸不受这里影响，仍按上面的都道府县判定。'),
      ...(cfg.watch.places || []).map((p, i) => h('div', {
        key: 'place-' + i,
        style: { display: 'flex', alignItems: 'center', gap: 8, margin: '4px 0', fontSize: 12 },
      },
        h('span', { style: { flex: 1 } },
          p.name + ' · ' + Number(p.lat).toFixed(3) + ', ' + Number(p.lon).toFixed(3) + ' · 半径 ' + p.radiusKm + ' km'),
        s.btn('删除', () => removePlace(i)),
      )),
      h('div', { style: { display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'flex-end', marginTop: 8 } },
        placeField('名称', 'name', '如 东京 / 家', 120),
        placeField('纬度', 'lat', '35.6812', 90),
        placeField('经度', 'lon', '139.7671', 90),
        s.btn('添加关注点', addPlace),
        s.btn('用当前位置', useMyLocation),
      ),
      h('div', { style: { marginTop: 6 } },
        radiusControl(Number(placeDraft.radiusKm) || DEFAULT_PLACE_RADIUS_KM,
          (v) => setPlaceDraft((d) => ({ ...d, radiusKm: String(v) })), 'place-radius')),
      placeMsg ? h('div', { style: { fontSize: 11, color: '#93c5fd', marginTop: 6 } }, placeMsg) : null,
      // 全球源的地震不是随时都有，没法"等一条"来验证链路 —— 与气象链路一样给一个本地测试按钮。
      // 构造的是**源格式原文**（EMSC / USGS / NOAA 各一种），因此解析器与匹配引擎都被真实走过。
      h('div', { style: { marginTop: 10, borderTop: '1px solid rgba(148,163,184,0.18)', paddingTop: 8 } },
        s.row(s.btn('发送测试全球警报（轮换场景）', () => {
          const places = cfg.watch.places || []
          if (places.length === 0) { setGeTestMsg('请先添加一个全球关注点 —— 测试消息需要一个位置来放震中'); return }
          const sc = TEST_GEO_SCENARIOS[geTestSeq % TEST_GEO_SCENARIOS.length]
          const ms = Date.now()
          const msg = buildTestGlobalMessage(places[0], ms, sc.key)
          setGeTestSeq(geTestSeq + 1)
          const alert = parseTestGlobalMessage(msg)
          if (!alert) { setGeTestMsg('测试消息解析失败 —— 请把这个情况反馈给开发者'); return }
          const res = handleAlert(alert, currentCfg(), { skipQuietHours: true })
          // 提示按**实际结果**生成：开关关闭 / 半径外 / 静默 / 其它标签页已提醒时就是不会响，
          // 必须如实说明，否则用户会以为插件坏了
          const outcome = res && res.notified
            ? ' —— 已播报：应看到提示音与弹窗'
            : ' —— 未播报（' + ((res && res.detail) || '未知原因') + '），只会记入下方「最近预警记录」'
          setGeTestMsg('已发送：' + sc.label + '（' + sc.note + '）' + outcome)
        })),
        h('div', { style: { fontSize: 11, color: '#9aa0a6', marginTop: 4, lineHeight: 1.6 } },
          '测试消息在本地构造（EMSC / USGS / NOAA 三种源格式轮换），不发任何网络请求，可反复点击。场景依次为：' +
          TEST_GEO_SCENARIOS.map((x) => x.label).join(' / ') +
          '。最后一条刻意落在半径之外——用来演示半径是怎么起作用的。'),
        geTestMsg ? h('div', { style: { color: '#93c5fd', fontSize: 11, marginTop: 4 } }, geTestMsg) : null,
      ),
      h(SourceStatusBlock, { key: 'source-status' }),
    ),

    // 阈值
    s.section('提醒阈值',
      s.label('地震（实测震度最低值）'),
      s.row(s.select(cfg.thresholds.quakeScale, SCALE_OPTIONS, (v) => setCfg((c) => ({ ...c, thresholds: { ...c.thresholds, quakeScale: Number(v) } })), (o) => o.label)),
      s.label('紧急地震速报（预测震度最低值）'),
      s.row(s.select(cfg.thresholds.eewScale, SCALE_OPTIONS, (v) => setCfg((c) => ({ ...c, thresholds: { ...c.thresholds, eewScale: Number(v) } })), (o) => o.label)),
      s.label('海啸'),
      s.row(s.select(cfg.thresholds.tsunamiGrade, TSUNAMI_OPTIONS, (v) => setCfg((c) => ({ ...c, thresholds: { ...c.thresholds, tsunamiGrade: v } })), (o) => o.label)),
      s.label('全球地震（最低震级，EMSC / USGS）'),
      s.row(s.select(cfg.thresholds.globalMagnitude, GLOBAL_MAG_OPTIONS, (v) => setCfg((c) => ({ ...c, thresholds: { ...c.thresholds, globalMagnitude: Number(v) } })), (o) => o.label)),
      h('div', { style: { fontSize: 11, color: '#9aa0a6' } },
        '全球源给的是震级、日本源给的是震度，两者不可换算，所以是两个独立旋钮。'),
      s.label('大陆地震速报（最低震级，中国地震台网速报）'),
      s.row(s.select(cfg.thresholds.cnReportMagnitude, CN_REPORT_MAG_OPTIONS, (v) => setCfg((c) => ({ ...c, thresholds: { ...c.thresholds, cnReportMagnitude: Number(v) } })), (o) => o.label)),
      h('div', { style: { fontSize: 11, color: '#9aa0a6' } },
        '速报覆盖低到 M2.5 且每天都有数据，所以门槛与上面的预警分开，避免小震刷屏；' +
        '大陆地震预警与全球源共用「全球地震」那个门槛。'),
    ),

    // 大陆源的链路选择（0.5.0）。这是一个**出口**：自动降级判不出的那几种网络
    //（能连上、偶尔漏、整体像坏的）需要一个手动开关，否则用户只能重装或等更新。
    s.section('大陆源链路',
      s.label('取数方式（中国地震台网预警 / 速报）'),
      s.row(s.select(cfg.cnTransport || 'auto', [
        { v: 'auto', label: '自动：SSE 推送优先，走不通自动降级为轮询' },
        { v: 'poll', label: '强制轮询（每 15 秒一次）' },
      ], (v) => setCfg((c) => ({ ...c, cnTransport: v })), (o) => o.label)),
      h('div', { style: { fontSize: 11, color: '#9aa0a6', marginTop: 4, lineHeight: 1.6 } },
        'SSE 推送的延迟是秒级，轮询最坏 15 秒——大陆预警抢的是这几秒，所以默认用推送。' +
        '只有在推送被网络中间设备反复掐断、而普通请求仍然正常时，才需要强制轮询。' +
        '当前实际走在哪条路上，看上面的「源状态」。'),
    ),

    // 通知与声音
    s.section('通知与声音',
      s.row(
        s.checkbox(cfg.notify.sound !== false, (v) => setCfg((c) => ({ ...c, notify: { ...c.notify, sound: v } })), '提示音'),
        s.checkbox(cfg.notify.system !== false, (v) => setCfg((c) => ({ ...c, notify: { ...c.notify, system: v } })), '系统通知'),
      ),
      s.row(s.label('音量'), h('input', {
        type: 'range', min: 0, max: 100,
        value: Math.round(volShown * 100),
        onChange: (e) => onVolumeInput(Number(e.target.value) / 100),
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
            '⚠ 提示音尚未解锁：浏览器要求先有一次页面交互才能出声——点一下页面任意位置即可。')
        : (audioState() === 'unavailable'
          ? h('div', { style: { color: '#9aa0a6', fontSize: 11, marginTop: 4 } }, '当前环境不支持 Web Audio，提示音不可用。')
          : null),
      testMsg ? h('div', { style: { color: '#93c5fd', fontSize: 11, marginTop: 4 } }, testMsg) : null,
    ),

    // 静默时段（0.2.0）
    s.section('静默时段',
      s.row(s.checkbox(cfg.quietHours.enabled, (v) => setCfg((c) => ({ ...c, quietHours: { ...c.quietHours, enabled: v } })), '启用静默时段')),
      s.row(
        s.label('开始'),
        h('input', {
          type: 'time', value: cfg.quietHours.start,
          onChange: (e) => setCfg((c) => ({ ...c, quietHours: { ...c.quietHours, start: e.target.value || c.quietHours.start } })),
          style: { background: '#ffffff', color: '#1a1a1a', border: '1px solid #6b7280', borderRadius: 6, padding: '4px 8px', fontSize: 12 },
        }),
        s.label('结束'),
        h('input', {
          type: 'time', value: cfg.quietHours.end,
          onChange: (e) => setCfg((c) => ({ ...c, quietHours: { ...c.quietHours, end: e.target.value || c.quietHours.end } })),
          style: { background: '#ffffff', color: '#1a1a1a', border: '1px solid #6b7280', borderRadius: 6, padding: '4px 8px', fontSize: 12 },
        }),
      ),
      s.row(s.checkbox(cfg.quietHours.breakForSevere, (v) => setCfg((c) => ({ ...c, quietHours: { ...c.quietHours, breakForSevere: v } })), '红色等级（EEW / 大海啸警报）仍提醒')),
      h('div', { style: { fontSize: 11, color: '#9aa0a6', marginTop: 6 } },
        '按浏览器本地时间判定；开始时间晚于结束时间表示跨午夜（如 23:00–07:00）。静默期间命中的预警仍会记入下方「最近预警记录」，只是不响铃、不弹通知。'),
    ),

    // 诊断快照（0.5.0）：DESIGN 11.3 的交付物——让"运行时自己说话"。
    // 界面上只做两件事：生成、以及**在剪贴板不可用时把文本显示出来**（沙箱 iframe 里
    // navigator.clipboard 常常不可用，而"复制不了"不该成为诊断的第一步就卡住）。
    s.section('诊断',
      h('div', { style: { fontSize: 11, color: '#9aa0a6', marginBottom: 6, lineHeight: 1.6 } },
        '把这份快照贴给你的 AI 助手（配合 TROUBLESHOOTING.zh.md），它就能看到逐源状态、' +
        '数据格式异常的原因、大陆源当前走哪条链路、以及最近几条记录为什么没有响铃。'),
      s.row(s.btn('生成诊断快照', () => {
        copyDiagSnapshot().then((r) => setDiag({
          text: r.text,
          msg: r.ok ? '已复制到剪贴板。' : ('剪贴板不可用' + (r.error ? '（' + r.error + '）' : '') + '，请手动全选下面的文本复制。'),
        })).catch((err) => setDiag({ text: '', msg: '生成失败：' + String((err && err.message) || err) }))
      })),
      h('div', { style: { fontSize: 11, color: '#d9a406', marginTop: 4 } },
        '⚠ 快照含你的关注地区名称与坐标——诊断"为什么没命中"必须要有它。分享前请自行确认。'),
      diag ? h('div', { style: { color: '#93c5fd', fontSize: 11, marginTop: 4 } }, diag.msg) : null,
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
    ),

    // 免责
    s.section('免责声明', h('div', { style: { color: '#9aa0a6', fontSize: 11, lineHeight: 1.6 } },
      '预警数据由 P2PQuake 转播、日本气象厅公开 XML 电文、EMSC / USGS / NOAA，' +
      '以及 Wolfx 转播的中国地震台网（CENC）信息提供，均非官方直接推送；' +
      '紧急地震速报（EEW）与大陆地震预警等内容与配信品质无保证。' +
      '本插件提醒仅供参考，避险请以当地主管机构（日本气象厅 気象庁 / 中国地震台网 CENC / 美国 USGS・NOAA 等）官方发布为准。' +
      '插件仅在 DSH 页面开启时工作。')),

    // 最近预警（点击条目展开详情；多条时可滚动）
    s.section('最近预警记录（' + store.events.length + ' 条）',
      h('div', { style: { fontSize: 11, color: '#9aa0a6', marginBottom: 6 } },
        '记录匹配链路上处理过的消息（含未达阈值、未提醒的灰色记录），点条目展开完整内容。'),
      store.events.length === 0
        ? h('div', { style: { color: '#9aa0a6', fontSize: 12, padding: '4px 0' } }, '暂无记录 —— 收到真实预警或测试消息后显示')
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
    ),
  )
}


export { statusMetaOf, SettingsPanel, p2pCodeTextOf, kindColorOf, P2P_KIND_CODE, KIND_COLORS, SOURCE_ORDER, SOURCE_LABELS, SOURCE_CODE_TEXT }
