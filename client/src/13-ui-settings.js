// ============================================================================
// dsh-quake-alert · client/src/13-ui-settings.js
//
// 作用：设置页面板（设置 → 灾害预警）的全部 UI。
// 内容：连接状态与数据源、关注地区（都道府县 + 市区町村搜索多选）、
//       三类阈值、通知与声音（含音量防抖落盘）、静默时段、免责声明、最近预警记录。
// 依赖：01-constants、02-storage、03-settings-bridge、04-city-table、07-store、08-audio、09-notify。
// 约定：所有写入都经 applyCfg，保证内存/镜像/Host 三处一致。
// ============================================================================

import { h, useState, useEffect, useRef, PREFECTURES, SCALE_OPTIONS, TSUNAMI_OPTIONS, HISTORY_MAX, HISTORY_KEY, MAX_WATCH_CITIES, STORAGE_KEY } from './01-constants.js'
import { saveJSON } from './02-storage.js'
import { currentCfg, applyCfg, settingsSync, reloadFromLocal } from './03-settings-bridge.js'
import { citiesOfPref, cityTableState, loadCityTable } from './04-city-table.js'
import { parseJma, buildTestTelegram, TEST_SCENARIOS } from './05b-jma-parser.js'
import { store } from './07-store.js'
import { playSound, unlockAudio } from './08-audio.js'
import { showToast, showSystemNotification, notificationPermission, requestNotificationPermission } from './09-notify.js'
import { handleAlert } from './11-pipeline.js'
import { activeClient } from './12-websocket.js'

// ---------- 设置页 UI ----------
// 连接状态 → 颜色 / 文案（设置页与侧边栏状态指示共用）
function statusMetaOf(status, retries) {
  return {
    idle: { color: '#7c8494', text: '未启动' },
    connecting: { color: '#d9a406', text: '连接中…' },
    open: { color: '#4ade80', text: '已连接' },
    reconnecting: { color: '#d9a406', text: '重连中（第 ' + retries + ' 次）' },
    closed: { color: '#e5484d', text: '已停止' },
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
const s = {
  section: (title, ...children) => h('div', { style: { padding: '14px 16px', borderBottom: '1px solid rgba(148,163,184,0.14)' } },
    h('div', { style: { fontWeight: 700, fontSize: 13, marginBottom: 10, color: '#dfe3e8' } }, title), ...children),
  label: (text) => h('div', { style: { color: '#9aa0a6', fontSize: 12, marginBottom: 4 } }, text),
  row: (...children) => h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', margin: '4px 0' } }, ...children),
  checkbox: (checked, onChange, text, color) => h('label', { style: { display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, cursor: 'pointer', color: '#dfe3e8' } },
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

function SettingsPanel() {
  const [cfg, setCfgState] = useState(() => currentCfg())
  const [, setTick] = useState(0)
  const [perm, setPerm] = useState(() => notificationPermission())
  const [testMsg, setTestMsg] = useState('')
  const [expanded, setExpanded] = useState(null)
  const [cityQuery, setCityQuery] = useState({}) // 每个县的市町村搜索词
  const [weatherTestMsg, setWeatherTestMsg] = useState('') // 「发送测试气象警报」的结果提示
  const [weatherTestSeq, setWeatherTestSeq] = useState(0) // 测试场景轮换游标
  // 音量滑块：拖动期间只改本地草稿，停手 300ms 后才落盘（避免每移动 1px 写一次 localStorage）
  const [volDraft, setVolDraft] = useState(null)
  const volTimer = useRef(null)
  const volPending = useRef(null) // 尚未落盘的草稿值：卸载时补写，拖完立刻关设置页也不丢改动
  // store 变化（新预警、Host 配置同步）都要重新读一次当前配置
  useEffect(() => store.subscribe(() => { setTick((t) => t + 1); setCfgState(currentCfg()) }), [])
  useEffect(() => () => {
    if (volTimer.current) { clearTimeout(volTimer.current); volTimer.current = null }
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
  // 其它 DSH 标签页改了配置 → 本页跟随（storage 事件只在「别的标签页」写入时触发）。
  // 回读走 03 的显式入口：跨模块不能直接给它的模块私有 runtimeCfg 赋值（0.2.1 拆分后
  // 那行成了自由变量，在 'use strict' 的 bundle 里抛 ReferenceError，同步静默失效）。
  useEffect(() => {
    const onStorage = (e) => {
      if (!e || e.key === STORAGE_KEY) setCfgState(reloadFromLocal())
    }
    window.addEventListener('storage', onStorage)
    return () => window.removeEventListener('storage', onStorage)
  }, [])

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

  const kindColor = { eew: '#e5484d', quake: '#3b82f6', tsunami: '#f76b15' }
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
          if (activeClient) setTimeout(() => { try { activeClient.restart() } catch (err) {} }, 80)
        }, (o) => o.label),
      ),
      h('div', { style: { fontSize: 11, color: '#9aa0a6', marginTop: 6 } },
        '配置存储：' + settingsSyncLabel()),
    ),

    // 关注地区
    s.section('关注地区（都道府县 / 市区町村）',
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

    // 阈值
    s.section('提醒阈值',
      s.label('地震（实测震度最低值）'),
      s.row(s.select(cfg.thresholds.quakeScale, SCALE_OPTIONS, (v) => setCfg((c) => ({ ...c, thresholds: { ...c.thresholds, quakeScale: Number(v) } })), (o) => o.label)),
      s.label('紧急地震速报（预测震度最低值）'),
      s.row(s.select(cfg.thresholds.eewScale, SCALE_OPTIONS, (v) => setCfg((c) => ({ ...c, thresholds: { ...c.thresholds, eewScale: Number(v) } })), (o) => o.label)),
      s.label('海啸'),
      s.row(s.select(cfg.thresholds.tsunamiGrade, TSUNAMI_OPTIONS, (v) => setCfg((c) => ({ ...c, thresholds: { ...c.thresholds, tsunamiGrade: v } })), (o) => o.label)),
    ),

    // 通知与声音
    s.section('通知与声音',
      s.row(
        s.checkbox(cfg.notify.sound !== false, (v) => setCfg((c) => ({ ...c, notify: { ...c.notify, sound: v } })), '提示音', '#dfe3e8'),
        s.checkbox(cfg.notify.system !== false, (v) => setCfg((c) => ({ ...c, notify: { ...c.notify, system: v } })), '系统通知', '#dfe3e8'),
      ),
      s.row(s.label('音量'), h('input', {
        type: 'range', min: 0, max: 100,
        value: Math.round(volShown * 100),
        onChange: (e) => onVolumeInput(Number(e.target.value) / 100),
        style: { flex: 1, minWidth: 120 },
      }), h('span', { style: { color: '#9aa0a6', fontSize: 11, width: 34 } }, Math.round(volShown * 100) + '%')),
      s.row(
        s.btn('试听地震音', () => playSound('quake', volShown)),
        s.btn('试听 EEW 音', () => playSound('eew', volShown)),
        s.btn('试听海啸音', () => playSound('tsunami', volShown)),
        s.btn('试听气象音', () => playSound('weather', volShown)),
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

    // 免责
    s.section('免责声明', h('div', { style: { color: '#9aa0a6', fontSize: 11, lineHeight: 1.6 } },
      '预警数据由 P2PQuake 转播（非官方直接数据源），EEW 紧急地震速报等内容与配信品质无保证。' +
      '本插件提醒仅供参考，请务必以日本气象厅（気象庁）官方发布为准。插件仅在 DSH 页面开启时工作。')),

    // 最近预警（点击条目展开详情；多条时可滚动）
    s.section('最近预警记录（' + store.events.length + ' 条）',
      h('div', { style: { fontSize: 11, color: '#9aa0a6', marginBottom: 6 } },
        '记录匹配链路上处理过的消息（含未达阈值、未提醒的灰色记录），点条目展开完整内容。'),
      store.events.length === 0
        ? h('div', { style: { color: '#9aa0a6', fontSize: 12, padding: '4px 0' } }, '暂无记录 —— 收到真实预警或测试消息后显示')
        : h('div', { style: { maxHeight: 300, overflowY: 'auto', paddingRight: 4 } },
            store.events.slice(0, HISTORY_MAX).map((e, i) => {
              const open = expanded === (e.key || e.id || i)
              const head = String(e.headline || '')
              const muted = e.hit === false || e.suppressed === true
              const statusText = e.hit === false
                ? '未触发提醒'
                : (e.suppressed ? '未重复提醒' : (e.pref ? '命中 ' + e.pref : '已提醒'))
              const codeNum = e.kind === 'eew' ? 556 : (e.kind === 'tsunami' ? 552 : 551)
              return h('div', {
                key: e.key || e.id || i,
                onClick: () => setExpanded(open ? null : (e.key || e.id || i)),
                title: open ? '点击收起' : '点击展开详情',
                style: Object.assign({
                  cursor: 'pointer',
                  borderLeft: '3px solid ' + (kindColor[e.kind] || '#7c8494'),
                  background: open
                    ? (muted ? 'rgba(148,163,184,0.16)' : 'rgba(59,130,246,0.22)')
                    : (muted ? 'rgba(148,163,184,0.05)' : 'rgba(148,163,184,0.09)'),
                  borderRadius: 6, padding: '6px 10px', margin: '5px 0',
                }, open ? { boxShadow: 'inset 0 0 0 1px rgba(148,163,184,0.55)' } : null),
              },
                h('div', { style: { display: 'flex', gap: 8, alignItems: 'center' } },
                  h('span', { style: { fontWeight: 700, fontSize: 12, color: kindColor[e.kind] || '#dfe3e8' } }, String(e.label || '')),
                  h('span', { style: { fontSize: 11, border: '1px solid ' + (muted ? '#8b8f98' : '#4ade80'), color: muted ? '#8b8f98' : '#4ade80', borderRadius: 8, padding: '0 6px' } }, statusText),
                  h('span', { style: { color: '#9aa0a6', fontSize: 11, marginLeft: 'auto', whiteSpace: 'nowrap' } }, open ? '▲ 收起' : '▼ 展开')),
                !open
                  ? h('div', { style: { fontSize: 12, color: '#c8ccd4', marginTop: 3, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' } }, head)
                  : h('div', { style: { fontSize: 12, marginTop: 6 } },
                      h('div', { style: { display: 'flex', gap: 6 } },
                        h('span', { style: { color: '#9aa0a6', width: 44 } }, '类型'),
                        h('span', { style: { color: '#e6e6e8' } }, String(e.label || '') + '（code ' + codeNum + '）')),
                      h('div', { style: { display: 'flex', gap: 6, marginTop: 2 } },
                        h('span', { style: { color: '#9aa0a6', width: 44 } }, '时间'),
                        h('span', { style: { color: '#e6e6e8' } }, String(e.issued || '—'))),
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
      s.row(s.btn('清空记录', () => { store.events = []; saveJSON(HISTORY_KEY, []); store.push({}) })),
    ),
  )
}


export { statusMetaOf, SettingsPanel }
