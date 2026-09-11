// dsh-quake-alert 解析器/匹配引擎同步回归测试（不依赖浏览器）
// 用法：node tests/sync-test.cjs
// 原理：stub window.__ModuleLoader__ 加载 client/client.js，取 exports.__test 的纯函数，
//       用 samples/ 的真实消息 JSON 验证 parse + matchAlert 行为。
'use strict'
const fs = require('fs')
const path = require('path')
const vm = require('vm')
const { pathToFileURL } = require('node:url')

const ROOT = path.join(__dirname, '..')

// ---- 浏览器环境 stub ----
// 每次调用都新建沙箱并重新执行 client.js；seedStorage 注入被污染的 localStorage，
// opts.window / opts.setTimeout 用于替换浏览器对象（例如注入假的 WebSocket）
const CLIENT_CODE = fs.readFileSync(path.join(ROOT, 'client', 'client.js'), 'utf8')
function loadClientEx(seedStorage, opts) {
  const o = opts || {}
  const memStore = new Map(Object.entries(seedStorage || {}))
  const windowStub = Object.assign({
    localStorage: {
      getItem: (k) => (memStore.has(k) ? memStore.get(k) : null),
      setItem: (k, v) => memStore.set(k, String(v)),
      removeItem: (k) => memStore.delete(k),
    },
    AudioContext: undefined,
    WebSocket: undefined,
    Notification: undefined,
    document: undefined,
    addEventListener() {},
    removeEventListener() {},
  }, o.window || {})
  const sandbox = {
    window: windowStub,
    console,
    setTimeout: o.setTimeout || setTimeout,
    clearTimeout: o.clearTimeout || clearTimeout,
  }
  // client.js 的 handleRaw 用裸 `document` 判断页面可见性（浏览器里就是 window.document），
  // 注入 document 的用例需要把它同时挂到沙箱全局，否则永远走「后台」分支。
  if (windowStub.document) sandbox.document = windowStub.document
  sandbox.window.window = sandbox.window
  windowStub.__ModuleLoader__ = {
    load: ({ id, factory }) => {
      const reactStub = {} // parse/match 不渲染 React，解构出的 hooks 为 undefined 无碍
      sandbox.__exports = factory((req) => (req === 'react' ? reactStub : undefined))
    },
  }
  vm.createContext(sandbox)
  vm.runInContext(CLIENT_CODE, sandbox, { filename: 'client.js' })
  return { exports: sandbox.__exports, storage: memStore }
}
function loadClient(seedStorage) { return loadClientEx(seedStorage).exports }

const T = loadClient().__test
if (!T) { console.error('FAIL: __test 未导出'); process.exit(1) }
const { EEW_AREA_EXPECT, TSUNAMI_AREA_EXPECT } = require('./area-tables.cjs')

// ---- 断言工具 ----
let pass = 0
let fail = 0
function assert(cond, msg) {
  if (cond) { pass += 1; console.log('  ✓ ' + msg) }
  else { fail += 1; console.error('  ✗ ' + msg) }
}
function readSample(name) {
  return JSON.parse(fs.readFileSync(path.join(ROOT, 'samples', name), 'utf8'))
}
const quakeDetail = readSample('quake-kumamoto-detailscale-20260907.json')
const quakeSpeed = readSample('quake-kumamoto-scaleprompt-20260907.json')
const eew = readSample('eew-ibaraki-m6.7-20260823.json')
const tsunami = readSample('tsunami-fukushima-spec-example.json')

console.log('== 解析器：551 各地震度 ==')
{
  const a = T.parse(quakeDetail)
  assert(a && a.kind === 'quake', '551 → kind=quake')
  assert(a && a.maxScale === 30, '551 maxScale=30')
  assert(a && a.headline.indexOf('熊本県熊本地方') !== -1, 'headline 含震源名')
  assert(a && a.regions.length === 12, 'regions=12（抽样 points）')
  assert(a && a.regions[0].pref === '熊本県' && a.regions[0].scale === 30, 'region 携带 pref/scale')
}
console.log('== 解析器：551 震度速报（区域观测点） ==')
{
  const a = T.parse(quakeSpeed)
  assert(a && a.kind === 'quake' && a.kindLabel.indexOf('震度速报') !== -1, '速报 kindLabel 正确')
  assert(a && a.regions[0] && a.regions[0].area === '熊本県天草・芦北', '速报区域名保留')
}
console.log('== 解析器：556 EEW（pref 简写归一为全称） ==')
{
  const a = T.parse(eew)
  assert(a && a.kind === 'eew', '556 → kind=eew')
  assert(a && a.severity === 'red', 'EEW severity=red')
  assert(a && a.maxScale === 50, 'EEW 最大预测震度=50（5强）')
  assert(a && a.regions[0].pref === '茨城県', 'EEW pref 从 name 提取为全称（非简写"茨城"）')
  assert(a && a.regions.some((r) => r.pref === '東京都'), '東京都２３区 → pref=東京都')
  assert(a && a.hypo.magnitude === 6.7, '震源 M6.7')
}
console.log('== 解析器：552 海啸 ==')
{
  const a = T.parse(tsunami)
  assert(a && a.kind === 'tsunami' && a.kindLabel === '海啸警报', 'Warning → 海啸警报')
  assert(a && a.severity === 'red', '海啸警报 severity=red')
  assert(a && a.regions[0].pref === '福島県' && a.regions[0].grade === 'Warning', '海啸 region pref/grade')
  assert(a && a.regions[1].pref === '青森県', '青森県太平洋沿岸 → 青森県')
}
console.log('== 解析器：WebSocket 推送字段 _id（非 history 的 id） ==')
{
  const wsStyle = Object.assign({}, eew)
  delete wsStyle.id
  wsStyle._id = 'ws-anon-id-001'
  const a = T.parse(wsStyle)
  assert(a && a.id === 'ws-anon-id-001', '从 _id 提取 id（沙箱/WS 推送格式）')
  const noId = Object.assign({}, eew)
  delete noId.id
  delete noId._id
  assert(T.parse(noId).id === '', '无 id/_id 时回退为空串')
}
console.log('== 匹配引擎：地震 ==')
{
  const cfgBase = { disasters: { earthquake: true, tsunami: true }, dedupe: { windowMinutes: 10 } }
  const cfg = (watch, qs) => ({ ...cfgBase, watch: { prefectures: watch }, thresholds: { quakeScale: qs, eewScale: 45, tsunamiGrade: 'Watch' }, notify: {} })
  assert(T.matchAlert(T.parse(quakeDetail), cfg(['熊本県'], 40)).hit === false, '熊本 max震度3(30) < 阈值震度4(40) → 不提醒')
  assert(T.matchAlert(T.parse(quakeDetail), cfg(['熊本県'], 30)).hit === true, '阈值震度3(30) 且关注熊本 → 提醒')
  assert(T.matchAlert(T.parse(quakeDetail), cfg(['東京都'], 30)).hit === false, '关注东京，熊本地震 → 不提醒')
  assert(T.matchAlert(T.parse(quakeDetail), cfg([], 30)).hit === true, '未选地区(=全日本) → 提醒')
  assert(T.matchAlert(T.parse(quakeDetail), cfg(['長崎県'], 20)).hit === true, '观测点含长崎(20)且阈值2 → 提醒')
}
console.log('== 匹配引擎：EEW ==')
{
  const cfgBase = { disasters: { earthquake: true, tsunami: true }, dedupe: { windowMinutes: 10 } }
  const cfg = (watch, es) => ({ ...cfgBase, watch: { prefectures: watch }, thresholds: { quakeScale: 30, eewScale: es, tsunamiGrade: 'Watch' }, notify: {} })
  assert(T.matchAlert(T.parse(eew), cfg(['茨城県'], 50)).hit === true, '关注茨城，EEW预测5强(50)≥阈值50 → 提醒')
  assert(T.matchAlert(T.parse(eew), cfg(['東京都'], 50)).hit === true, '关注东京，23区预测5弱~5强(45-50) → 提醒')
  assert(T.matchAlert(T.parse(eew), cfg(['北海道'], 50)).hit === false, '关注北海道 → 不提醒')
  assert(T.matchAlert(T.parse(eew), cfg(['茨城県'], 55)).hit === false, 'EEW最大50 < 阈值6弱(55) → 不提醒')
}
console.log('== 匹配引擎：海啸 ==')
{
  const cfgBase = { disasters: { earthquake: true, tsunami: true }, dedupe: { windowMinutes: 10 } }
  const cfg = (watch, tg) => ({ ...cfgBase, watch: { prefectures: watch }, thresholds: { quakeScale: 30, eewScale: 45, tsunamiGrade: tg }, notify: {} })
  assert(T.matchAlert(T.parse(tsunami), cfg(['福島県'], 'Watch')).hit === true, '关注福岛，注意报起 → 提醒(福岛Warning)')
  assert(T.matchAlert(T.parse(tsunami), cfg(['福島県'], 'Warning')).hit === true, '警报起 → 提醒')
  assert(T.matchAlert(T.parse(tsunami), cfg(['福島県'], 'MajorWarning')).hit === false, '仅大海啸警报 → 福岛Warning不提醒')
  assert(T.matchAlert(T.parse(tsunami), cfg(['青森県'], 'Watch')).hit === true, '关注青森，青森注意报命中')
  assert(T.matchAlert(T.parse(tsunami), cfg(['北海道'], 'Watch')).hit === false, '关注北海道 → 不提醒')
}

console.log('== 区域名归一：EEW 全量区域名（気象庁 188 个） ==')
{
  const bad = []
  for (const name of Object.keys(EEW_AREA_EXPECT)) {
    const got = T.prefsOfArea(name).slice().sort()
    const want = EEW_AREA_EXPECT[name].slice().sort()
    if (got.join(',') !== want.join(',')) bad.push(name + ' 期望 ' + want.join('/') + ' 实得 ' + (got.join('/') || '空'))
  }
  const total = Object.keys(EEW_AREA_EXPECT).length
  assert(bad.length === 0, total + ' 个 EEW 区域名全部归一正确' + (bad.length ? '（失败 ' + bad.length + ' 个：' + bad.slice(0, 5).join(' | ') + '）' : ''))
}
console.log('== 区域名归一：海啸全量予報区（気象庁 66 个） ==')
{
  const bad = []
  for (const name of Object.keys(TSUNAMI_AREA_EXPECT)) {
    const got = T.prefsOfArea(name).slice().sort()
    const want = TSUNAMI_AREA_EXPECT[name].slice().sort()
    if (got.join(',') !== want.join(',')) bad.push(name + ' 期望 ' + want.join('/') + ' 实得 ' + (got.join('/') || '空'))
  }
  const total = Object.keys(TSUNAMI_AREA_EXPECT).length
  assert(bad.length === 0, total + ' 个津波予報区全部归一正确' + (bad.length ? '（失败 ' + bad.length + ' 个：' + bad.slice(0, 5).join(' | ') + '）' : ''))
}
console.log('== 回归：本轮修复的漏报场景 ==')
{
  const cfg = (watch, tg) => ({ disasters: { earthquake: true, tsunami: true }, dedupe: { windowMinutes: 10 }, watch: { prefectures: watch }, thresholds: { quakeScale: 40, eewScale: 45, tsunamiGrade: tg || 'Watch' }, notify: {} })
  // 1) 京都府曾被正则截断为「京都」，与关注列表永不相等
  assert(T.prefsOfArea('京都府').join() === '京都府', '京都府 → 京都府（不再截断为 京都）')
  assert(T.prefsOfArea('京都府南部').join() === '京都府', '京都府南部 → 京都府')
  // 2) 東京湾内湾等 17 个不含县名的海啸予報区曾完全无法归一
  const tw = T.parse({ code: 552, id: 't-tw', cancelled: false, issue: { time: 'x' }, areas: [{ grade: 'MajorWarning', name: '東京湾内湾', maxHeight: { description: '３ｍ' } }] })
  assert(T.matchAlert(tw, cfg(['東京都'])).hit === true, '東京湾内湾 大海啸警报 → 关注東京都命中')
  assert(T.matchAlert(tw, cfg(['千葉県'])).hit === true, '東京湾内湾 → 关注千葉県命中')
  assert(T.matchAlert(tw, cfg(['神奈川県'])).hit === true, '東京湾内湾 → 关注神奈川県命中')
  const izu = T.parse({ code: 552, id: 't-izu', cancelled: false, issue: { time: 'x' }, areas: [{ grade: 'Warning', name: '伊豆諸島' }] })
  assert(T.matchAlert(izu, cfg(['東京都'])).hit === true, '伊豆諸島 → 关注東京都命中')
  // 3) 北海道 EEW 区域名是地方名，曾无法归一
  const hk = T.parse({ code: 556, id: 'e-hk', cancelled: false, issue: { time: 'x' }, earthquake: { hypocenter: { name: '上川地方北部', magnitude: 5.5 } }, areas: [{ pref: '北海道道北', name: '上川地方北部', scaleFrom: 45, scaleTo: 45 }] })
  assert(T.matchAlert(hk, cfg(['北海道'])).hit === true, '上川地方北部 EEW → 关注北海道命中')
  const ok = T.parse({ code: 556, id: 'e-ok', cancelled: false, issue: { time: 'x' }, earthquake: { hypocenter: { name: '宮古島近海', magnitude: 6 } }, areas: [{ pref: '宮古島', name: '沖縄県宮古島', scaleFrom: 45, scaleTo: 45 }] })
  assert(T.matchAlert(ok, cfg(['沖縄県'])).hit === true, '沖縄県宮古島 EEW → 关注沖縄県命中')
  // 4) 跨县区域展开为多条 region
  const ar = T.parse({ code: 552, id: 't-ar', cancelled: false, issue: { time: 'x' }, areas: [{ grade: 'Warning', name: '有明・八代海' }] })
  assert(ar.regions.length === 4, '有明・八代海 展开为 4 条 region（福岡/佐賀/長崎/熊本）')
  assert(['福岡県', '佐賀県', '長崎県', '熊本県'].every((p) => ar.regions.some((r) => r.pref === p)), '四个县都在 regions 中')
  assert(T.matchAlert(ar, cfg(['熊本県'])).hit === true, '有明・八代海 → 关注熊本県命中')
  // 5) 未识别区域名不再静默：未命中原因里明确提示
  const unk = T.parse({ code: 552, id: 't-unk', cancelled: false, issue: { time: 'x' }, areas: [{ grade: 'Warning', name: '謎の海域' }] })
  const m = T.matchAlert(unk, cfg(['東京都']))
  assert(m.hit === false && m.reason.indexOf('未能识别') !== -1, '未识别区域名在未命中原因中明确提示')
  assert(T.matchAlert(unk, cfg([])).hit === true, '全日本模式（未选地区）下未识别区域仍可提醒')
}

console.log('== 存储健壮性：localStorage 被污染时插件仍能加载 ==')
{
  const cases = [
    ['history 为对象', { 'dsh.quakeAlert.history': '{"oops":1}' }],
    ['history 为数字', { 'dsh.quakeAlert.history': '123' }],
    ['history 为字符串', { 'dsh.quakeAlert.history': '"a-string"' }],
    ['history 为 null', { 'dsh.quakeAlert.history': 'null' }],
    ['history 含 null 元素', { 'dsh.quakeAlert.history': '[null,{"key":"k","label":"x"},7]' }],
    ['history 非法 JSON', { 'dsh.quakeAlert.history': '{oops' }],
    ['cfg 为数组', { 'dsh.quakeAlert.v1': '[1,2,3]' }],
    ['cfg 非法 JSON', { 'dsh.quakeAlert.v1': '{bad' }],
  ]
  for (const [name, seed] of cases) {
    let ex = null
    let err = ''
    try { ex = loadClient(seed) } catch (e) { err = e.message }
    assert(ex !== null, name + ' → 插件仍能加载' + (ex ? '' : '（' + err + '）'))
    if (ex) {
      const h = ex.__test.loadHistory()
      assert(Array.isArray(h) && h.every((e) => e && typeof e === 'object'), name + ' → 历史记录被规整为对象数组')
    }
  }
}
console.log('== 存储健壮性：配置字段被污染时逐项退回默认值 ==')
{
  const dirty = JSON.stringify({
    version: 1,
    source: 123,
    watch: 'not-an-object',
    disasters: null,
    thresholds: { quakeScale: 'big', eewScale: null, tsunamiGrade: 'constructor' },
    notify: { volume: 'loud', sound: 'yes' },
    dedupe: { windowMinutes: -5 },
  })
  const cfg = loadClient({ 'dsh.quakeAlert.v1': dirty }).__test.loadCfg()
  assert(Array.isArray(cfg.watch.prefectures) && cfg.watch.prefectures.length === 0, 'watch 污染 → prefectures 为空数组')
  assert(cfg.source === 'prod', 'source 污染 → 回退 prod')
  assert(cfg.disasters.earthquake === true && cfg.disasters.tsunami === true, 'disasters 污染 → 回退 true')
  assert(cfg.thresholds.quakeScale === 40 && cfg.thresholds.eewScale === 45, 'thresholds 污染 → 回退默认震度')
  assert(cfg.thresholds.tsunamiGrade === 'Watch', 'tsunamiGrade=constructor → 回退 Watch（不命中原型链）')
  assert(cfg.notify.volume === 0.7 && cfg.notify.sound === true, 'notify 污染 → 回退默认')
  assert(cfg.dedupe.windowMinutes === 1, 'dedupe 负数 → 规整到最小 1 分钟')
}
{
  const cfg = loadClient({
    'dsh.quakeAlert.v1': JSON.stringify({ version: 1, notify: { volume: 5 }, thresholds: { quakeScale: 999 }, dedupe: { windowMinutes: 99999 } }),
  }).__test.loadCfg()
  assert(cfg.notify.volume === 1, 'volume 越界 → clamp 到 1')
  assert(cfg.thresholds.quakeScale === 70, '震度越界 → clamp 到 70')
  assert(cfg.dedupe.windowMinutes === 1440, '去重窗口越界 → clamp 到 1440')
}
{
  const cfg = loadClient({
    'dsh.quakeAlert.v1': JSON.stringify({ version: 1, watch: { prefectures: ['東京都', '不存在的県', 123, null, '東京都'] } }),
  }).__test.loadCfg()
  assert(cfg.watch.prefectures.join() === '東京都', '非法县名与重复项被过滤，仅保留合法县')
  assert(cfg.notify.volume === 0.7 && cfg.dedupe.windowMinutes === 10, '缺字段 → 默认值补齐')
}
{
  const t = loadClient().__test
  const a = t.loadCfg()
  const b = t.loadCfg()
  a.watch.prefectures.push('東京都')
  a.notify.volume = 0
  assert(b.watch.prefectures.length === 0 && b.notify.volume === 0.7, '默认配置每次返回全新对象（改动不污染后续读取）')
}
console.log('== 原型链污染：外部数据里的 constructor/toString 键 ==')
{
  assert(T.prefsOfArea('constructor').length === 0, '区域名 constructor → 归一为空（不再返回 Object 函数）')
  assert(T.prefsOfArea('toString').length === 0, '区域名 toString → 归一为空')
  const evil = T.parse({ code: 552, id: 't-evil', cancelled: false, issue: { time: 'x' }, areas: [{ grade: 'constructor', name: 'constructor' }] })
  assert(evil && evil.kind === 'tsunami' && evil.regions.length === 1, '恶意 grade/name 的消息解析不抛错')
  const q = T.parse({ code: 551, id: 'q-evil', cancelled: false, issue: { type: 'constructor', time: 'x' }, earthquake: { maxScale: 50, hypocenter: {} }, points: [] })
  assert(q && q.kindLabel === '地震情报', '551 issue.type=constructor → 回退默认标签')
}

console.log('== 历史记录：内存与写盘都保留 30 条 ==')
{
  const { exports: ex, storage } = loadClientEx({})
  const t = ex.__test
  for (let i = 0; i < 35; i++) {
    t.addEvent({ id: 'id-' + i, kind: 'quake', label: '测试', severity: 'info', issued: 't', headline: 'h', hit: true })
  }
  assert(t.store.events.length === t.HISTORY_MAX, '内存保留 ' + t.HISTORY_MAX + ' 条')
  const saved = JSON.parse(storage.get('dsh.quakeAlert.history'))
  assert(Array.isArray(saved) && saved.length === t.HISTORY_MAX, '写盘同样保存 ' + t.HISTORY_MAX + ' 条（此前只存 20 条，刷新后掉一半）')
}
console.log('== 音量：0 原样保留，不被默认值顶掉 ==')
{
  const cfg = loadClient({ 'dsh.quakeAlert.v1': JSON.stringify({ version: 1, notify: { volume: 0 } }) }).__test.loadCfg()
  assert(cfg.notify.volume === 0, 'volume=0 保留（滑块不再回弹显示 70%）')
}
console.log('== 重连：计数从第 1 次开始，restart 重置退避 ==')
{
  const sockets = []
  class FakeWS {
    constructor(url) { this.url = url; sockets.push(this) }
    close() {}
  }
  const { exports: ex } = loadClientEx({}, { window: { WebSocket: FakeWS } })
  const t = ex.__test
  const client = t.createWsClient()
  client.start()
  assert(sockets.length === 1 && t.store.status === 'connecting', 'start() 建立连接并进入 connecting')
  sockets[0].onclose()
  assert(t.store.retries === 1 && t.store.status === 'reconnecting', '首次断开 → 重连计数为 1（不再显示「第 0 次」）')
  assert(t.store.detail.indexOf('第 1 次') !== -1, '状态文案显示「第 1 次」')
  sockets[0].onclose()
  assert(t.store.retries === 2, '连续断开 → 计数递增')
  client.restart()
  assert(t.store.retries === 0, 'restart() 重置退避计数（切数据源后不再等满 60s）')
  assert(sockets.length === 2, 'restart() 重新建立连接')
  client.stop()
  assert(t.store.status === 'closed', 'stop() 后状态为 closed')
}

console.log('== 事件级去重：同一地震的多报只提醒一次 ==')
{
  const t = loadClientEx({}).exports.__test
  const cfg = {
    watch: { prefectures: [] },
    disasters: { earthquake: true, tsunami: true },
    thresholds: { quakeScale: 40, eewScale: 45, tsunamiGrade: 'Watch' },
    notify: { sound: false, system: false, volume: 0.7 },
    dedupe: { windowMinutes: 10 },
  }
  const quake = (id, time, maxScale, type) => ({
    code: 551, id, issue: { type, time: '2026/09/07 23:25:00' },
    earthquake: { time, maxScale, hypocenter: { name: '熊本県熊本地方', magnitude: 5 } },
    points: [{ pref: '熊本県', addr: '熊本市', scale: maxScale }],
  })
  t.handleRaw(quake('q1', '2026/09/07 23:21:00', 50, 'ScalePrompt'), cfg)
  assert(t.store.events[0].hit === true && !t.store.events[0].suppressed, '震度速报 → 提醒')
  t.handleRaw(quake('q2', '2026/09/07 23:21:00', 50, 'DetailScale'), cfg)
  assert(t.store.events[0].suppressed === true, '同一地震的各地震度（同强度）→ 只记历史不提醒')
  assert(t.store.events[0].suppressedReason.indexOf('同一地震') !== -1, '说明指出是同一地震的后续发布')
  t.handleRaw(quake('q3', '2026/09/07 23:21:00', 60, 'DetailScale'), cfg)
  assert(!t.store.events[0].suppressed, '强度升级 50 → 60 → 再次提醒')
  t.handleRaw(quake('q4', '2026/09/07 23:30:00', 50, 'DetailScale'), cfg)
  assert(!t.store.events[0].suppressed, '另一起地震（发生时刻不同）→ 正常提醒')
}
console.log('== 事件级去重：EEW 多报（eventId + serial） ==')
{
  const t = loadClientEx({}).exports.__test
  const cfg = {
    watch: { prefectures: [] },
    disasters: { earthquake: true, tsunami: true },
    thresholds: { quakeScale: 40, eewScale: 45, tsunamiGrade: 'Watch' },
    notify: { sound: false, system: false, volume: 0.7 },
    dedupe: { windowMinutes: 10 },
  }
  const eew = (id, eventId, serial, scaleTo) => ({
    code: 556, id, cancelled: false,
    issue: { time: '2026/09/09 00:00:00', eventId, serial },
    earthquake: { hypocenter: { name: '茨城県南部', magnitude: 6.7 } },
    areas: [{ pref: '茨城', name: '茨城県南部', scaleFrom: scaleTo, scaleTo }],
  })
  t.handleRaw(eew('e1', 'EV1', '1', 45), cfg)
  assert(!t.store.events[0].suppressed, 'EEW 第 1 报 → 提醒')
  t.handleRaw(eew('e2', 'EV1', '2', 45), cfg)
  assert(t.store.events[0].suppressed === true, 'EEW 第 2 报（同强度）→ 未重复提醒')
  t.handleRaw(eew('e3', 'EV1', '3', 55), cfg)
  assert(!t.store.events[0].suppressed, 'EEW 第 3 报（震度升级）→ 再次提醒')
  t.handleRaw(eew('e4', 'EV2', '1', 45), cfg)
  assert(!t.store.events[0].suppressed, '不同 eventId（另一起地震）→ 正常提醒')
}
console.log('== 跨标签页去重：同一预警只由一个标签页播报 ==')
{
  const channels = []
  class FakeBC {
    constructor(name) { this.name = name; this.onmessage = null; channels.push(this) }
    postMessage(data) {
      channels.forEach((c) => { if (c !== this && c.name === this.name && c.onmessage) c.onmessage({ data }) })
    }
    close() {}
  }
  const a = loadClientEx({}, { window: { BroadcastChannel: FakeBC } }).exports.__test
  const b = loadClientEx({}, { window: { BroadcastChannel: FakeBC } }).exports.__test
  a.ensureAlertChannel() // 模拟两个标签页都已加载插件（apply 时建立监听）
  b.ensureAlertChannel()
  assert(a.claimAlertForTab('evt-1') === true, '标签页 A 首次播报 → 允许')
  assert(b.claimAlertForTab('evt-1') === false, '标签页 B 收到广播 → 拒绝（不重复响铃）')
  assert(a.claimAlertForTab('evt-2') === true && b.claimAlertForTab('evt-2') === false, '新预警同样只由 A 播报')
  const solo = loadClientEx({}).exports.__test
  assert(solo.claimAlertForTab('evt-3') === true, '不支持 BroadcastChannel 时退化为各自提醒，不抛错')
}
console.log('== 震源情报（无 points）给出明确说明 ==')
{
  const t = loadClient().__test
  const cfg = { watch: { prefectures: ['東京都'] }, disasters: { earthquake: true, tsunami: true }, thresholds: { quakeScale: 40, eewScale: 45, tsunamiGrade: 'Watch' }, notify: {}, dedupe: { windowMinutes: 10 } }
  const dest = {
    code: 551, id: 'd1', issue: { type: 'Destination', time: 't' },
    earthquake: { time: 't', maxScale: -1, hypocenter: { name: '福島県沖', magnitude: 6.2 } },
    points: [],
  }
  const m = t.matchAlert(t.parse(dest), cfg)
  assert(m.hit === false && m.reason.indexOf('震源情报') !== -1, '未命中原因说明「震源情报，无震度数据，无法按阈值判定」')
}

console.log('== 震度信息进入 headline（阈值就是按震度设的） ==')
{
  const q = T.parse(quakeDetail)
  assert(q.headline.indexOf('最大震度3') !== -1, '551 headline 含「最大震度3」')
  const e = T.parse(eew)
  assert(e.headline.indexOf('预测最大震度5强') !== -1, '556 headline 含「预测最大震度5强」')
  const dest = T.parse({
    code: 551, id: 'd2', issue: { type: 'Destination', time: 't' },
    earthquake: { time: 't', maxScale: -1, hypocenter: { name: '福島県沖', magnitude: 6.2 } }, points: [],
  })
  assert(dest.headline.indexOf('震度') === -1, '无震度的震源情报不追加「最大震度未公布」这类噪音')
}
console.log('== 配置版本不同不再清空用户配置 ==')
{
  const stored = JSON.stringify({
    version: 999, source: 'sandbox', watch: { prefectures: ['東京都', '京都府'] },
    thresholds: { quakeScale: 55, eewScale: 50, tsunamiGrade: 'Warning' },
    notify: { sound: false, system: true, volume: 0.3 }, dedupe: { windowMinutes: 30 },
  })
  const { exports: ex, storage } = loadClientEx({ 'dsh.quakeAlert.v1': stored })
  const cfg = ex.__test.loadCfg()
  assert(cfg.watch.prefectures.join() === '東京都,京都府', '版本 999 → 关注地区保留')
  assert(cfg.thresholds.quakeScale === 55 && cfg.thresholds.tsunamiGrade === 'Warning', '阈值保留')
  assert(cfg.source === 'sandbox' && cfg.notify.volume === 0.3, '数据源与音量保留')
  assert(JSON.parse(storage.get('dsh.quakeAlert.v1')).version === 1, '写回当前版本号（迁移而非清空）')
}
console.log('== 历史字段被污染成对象也不崩渲染层 ==')
{
  const dirty = JSON.stringify([
    { key: 'a', label: { oops: 1 }, headline: { bad: true }, issued: {}, pref: [], suppressedReason: {}, hit: true },
    { label: 'ok', headline: 42, issued: null, hit: false },
  ])
  const h = loadClientEx({ 'dsh.quakeAlert.history': dirty }).exports.__test.loadHistory()
  assert(h.length === 2, '两条脏记录都被保留')
  const flat = h.every((e) => ['label', 'headline', 'issued', 'pref', 'suppressedReason'].every((k) => typeof e[k] === 'string'))
  assert(flat, '渲染用字段全部规整为字符串（React 不会再收到对象/数组）')
  assert(h[0].hit === true && h[1].hit === false, 'hit 规整为布尔')
  assert(h[1].key === 'legacy-1', '缺 key 的旧记录补上稳定兜底键')
}
console.log('== EEW 取消 / 海啸解除在「此前提醒过」时补提醒 ==')
{
  const t = loadClientEx({}).exports.__test
  const cfg = {
    watch: { prefectures: [] }, disasters: { earthquake: true, tsunami: true },
    thresholds: { quakeScale: 40, eewScale: 45, tsunamiGrade: 'Watch' },
    notify: { sound: false, system: false, volume: 0.7 }, dedupe: { windowMinutes: 10 },
  }
  const eewMsg = (id, cancelled, scaleTo, eventId) => ({
    code: 556, id, cancelled, issue: { time: 't', eventId: eventId || 'EV-C1', serial: '1' },
    earthquake: { hypocenter: { name: '茨城県南部', magnitude: 6.7 } },
    areas: cancelled ? [] : [{ pref: '茨城', name: '茨城県南部', scaleFrom: scaleTo, scaleTo }],
  })
  t.handleRaw(eewMsg('c1', false, 50), cfg)
  assert(t.store.events[0].hit === true && !t.store.events[0].suppressed, 'EEW 警报 → 提醒')
  t.handleRaw(eewMsg('c2', true, 0), cfg)
  assert(t.store.events[0].hit === true && t.store.events[0].headline.indexOf('取消') !== -1, '同一事件随后取消 → 补一条取消提醒')
  t.handleRaw(eewMsg('c3', true, 0), cfg)
  assert(t.store.events[0].hit === false, '重复的取消消息不再提醒')
  t.handleRaw(eewMsg('c4', true, 0, 'EV-C2'), cfg)
  assert(t.store.events[0].hit === false && t.store.events[0].headline.indexOf('此前未提醒过') !== -1, '未提醒过的事件取消 → 只记历史，不打扰')
  t.handleRaw(tsunami, cfg)
  assert(t.store.events[0].hit === true, '海啸警报 → 提醒')
  t.handleRaw(Object.assign({}, tsunami, { id: 't-clear', cancelled: true, areas: [] }), cfg)
  assert(t.store.events[0].hit === true && t.store.events[0].headline.indexOf('解除') !== -1, '海啸解除 → 补一条解除提醒')
}
console.log('== 通知行为：前台只 toast / 后台系统通知 ==')
{
  function stubDom(visibility) {
    const toasts = []
    const notes = []
    const doc = {
      visibilityState: visibility,
      body: { appendChild(el) { toasts.push(el); el.parentNode = this }, removeChild() {} },
      createElement: () => ({ style: {}, appendChild() {}, addEventListener() {}, parentNode: null, textContent: '' }),
    }
    class FakeNotification { constructor(title, opts) { notes.push({ title, opts }) } static permission = 'granted' }
    return { win: { document: doc, Notification: FakeNotification }, toasts, notes }
  }
  const raw = readSample('ws-sandbox-20230905-fukushima.json')
  const cfg = {
    watch: { prefectures: ['福島県'] }, disasters: { earthquake: true, tsunami: true },
    thresholds: { quakeScale: 10, eewScale: 45, tsunamiGrade: 'Watch' },
    notify: { sound: false, system: true, volume: 0.7 }, dedupe: { windowMinutes: 10 },
  }
  const fg = stubDom('visible')
  loadClientEx({}, { window: fg.win }).exports.__test.handleRaw(raw, cfg)
  assert(fg.toasts.length === 1 && fg.notes.length === 0, '页面可见 → 只弹 toast，不再同时发系统通知')
  const bg = stubDom('hidden')
  loadClientEx({}, { window: bg.win }).exports.__test.handleRaw(raw, cfg)
  assert(bg.toasts.length === 0 && bg.notes.length === 1, '页面后台 → 只发系统通知')
}
console.log('== 跨标签页：广播同步事件键，取消消息也能补提醒 ==')
{
  const channels = []
  class FakeBC {
    constructor(name) { this.name = name; this.onmessage = null; channels.push(this) }
    postMessage(data) { channels.forEach((c) => { if (c !== this && c.name === this.name && c.onmessage) c.onmessage({ data }) }) }
    close() {}
  }
  const a = loadClientEx({}, { window: { BroadcastChannel: FakeBC } }).exports.__test
  const b = loadClientEx({}, { window: { BroadcastChannel: FakeBC } }).exports.__test
  a.ensureAlertChannel()
  b.ensureAlertChannel()
  const cfg = {
    watch: { prefectures: [] }, disasters: { earthquake: true, tsunami: true },
    thresholds: { quakeScale: 40, eewScale: 45, tsunamiGrade: 'Watch' },
    notify: { sound: false, system: false, volume: 0.7 }, dedupe: { windowMinutes: 10 },
  }
  const mk = (id, cancelled) => ({
    code: 556, id, cancelled, issue: { time: 't', eventId: 'EV-TAB', serial: '1' },
    earthquake: { hypocenter: { name: '茨城県南部', magnitude: 6.7 } },
    areas: cancelled ? [] : [{ pref: '茨城', name: '茨城県南部', scaleFrom: 50, scaleTo: 50 }],
  })
  a.handleRaw(mk('tab-1', false), cfg)
  assert(a.store.events[0].hit === true && !a.store.events[0].suppressed, '标签页 A 播报警报')
  b.handleRaw(mk('tab-1', false), cfg)
  assert(b.store.events[0].suppressed === true, '标签页 B 同一条消息被跨页去重')
  b.handleRaw(mk('tab-2', true), cfg)
  assert(b.store.events[0].hit === true && b.store.events[0].headline.indexOf('取消') !== -1, 'B 经广播拿到事件键，收到取消也能补提醒')
}
console.log('== toast 颜色按命中区域强度，而非全日本最大值 ==')
{
  const t = loadClientEx({}).exports.__test
  const cfg = {
    watch: { prefectures: ['熊本県'] }, disasters: { earthquake: true, tsunami: true },
    thresholds: { quakeScale: 20, eewScale: 45, tsunamiGrade: 'Watch' },
    notify: { sound: false, system: false, volume: 0.7 }, dedupe: { windowMinutes: 10 },
  }
  t.handleRaw({
    code: 551, id: 'sev-1', issue: { type: 'DetailScale', time: 't' },
    earthquake: { time: 't', maxScale: 60, hypocenter: { name: '熊本県熊本地方', magnitude: 5 } },
    points: [{ pref: '熊本県', addr: '熊本市', scale: 20 }, { pref: '福岡県', addr: '福岡市', scale: 60 }],
  }, cfg)
  assert(t.store.events[0].severity === 'info', '命中熊本（震度2）→ severity=info，而不是全日本最大 6弱 的 red')
  // EEW 即使预测震度刚过阈值，也必须保持 red（警报本质，不能因为达标而降级）
  const cfgEew = Object.assign({}, cfg, { watch: { prefectures: ['茨城県'] } })
  t.handleRaw({
    code: 556, id: 'sev-eew', cancelled: false, issue: { time: 't', eventId: 'EV-SEV', serial: '1' },
    earthquake: { hypocenter: { name: '茨城県南部', magnitude: 6 } },
    areas: [{ pref: '茨城', name: '茨城県南部', scaleFrom: 45, scaleTo: 45 }],
  }, cfgEew)
  assert(t.store.events[0].severity === 'red', 'EEW 命中（预测5弱）→ severity 仍为 red')
  const cfgTsu = Object.assign({}, cfg, { watch: { prefectures: ['福島県'] } })
  t.handleRaw({
    code: 552, id: 'sev-tsu', cancelled: false, issue: { time: 't' },
    areas: [{ grade: 'Watch', name: '福島県' }],
  }, cfgTsu)
  assert(t.store.events[0].severity === 'orange', '海啸注意报 → severity=orange')
}
console.log('== 沙箱真实推送样本纳入回归 ==')
{
  const raw = readSample('ws-sandbox-20230905-fukushima.json')
  const a = T.parse(raw)
  assert(a && a.code === 551 && a.regions[0].pref === '福島県', '沙箱实测样本（福島県沖 M4.0）解析出福島県')
  const m = T.matchAlert(a, {
    watch: { prefectures: ['福島県'] }, disasters: { earthquake: true, tsunami: true },
    thresholds: { quakeScale: 10, eewScale: 45, tsunamiGrade: 'Watch' }, notify: {}, dedupe: { windowMinutes: 10 },
  })
  assert(m.hit === true, '关注福島県时该样本命中')
}

console.log('== 静默时段：时间判定（含跨午夜） ==')
{
  const t = loadClient().__test
  const cfg = (start, end, enabled, breakForSevere) => ({
    quietHours: { enabled: enabled !== false, start, end, breakForSevere: breakForSevere !== false },
  })
  const at = (h, m) => new Date(2026, 8, 10, h, m, 0)
  assert(t.inQuietHours(cfg('23:00', '07:00'), at(23, 30)) === true, '跨午夜 23:30 → 静默中')
  assert(t.inQuietHours(cfg('23:00', '07:00'), at(6, 59)) === true, '跨午夜 06:59 → 静默中')
  assert(t.inQuietHours(cfg('23:00', '07:00'), at(7, 0)) === false, '跨午夜 07:00 → 静默结束（右开区间）')
  assert(t.inQuietHours(cfg('23:00', '07:00'), at(22, 59)) === false, '跨午夜 22:59 → 尚未进入')
  assert(t.inQuietHours(cfg('09:00', '17:00'), at(12, 0)) === true, '普通区间 12:00 → 静默中')
  assert(t.inQuietHours(cfg('09:00', '17:00'), at(18, 0)) === false, '普通区间 18:00 → 不在静默')
  assert(t.inQuietHours(cfg('09:00', '09:00'), at(9, 0)) === false, 'start === end → 视为不静默')
  assert(t.inQuietHours(cfg('23:00', '07:00', false), at(23, 30)) === false, '未启用 → 不静默')
  assert(t.inQuietHours(cfg('bad', '07:00'), at(23, 30)) === false, '非法时间 → 不静默')
}
console.log('== 静默时段：命中不响铃 / 红色等级穿透 ==')
{
  const t = loadClientEx({}).exports.__test
  const base = {
    watch: { prefectures: [] }, disasters: { earthquake: true, tsunami: true },
    thresholds: { quakeScale: 40, eewScale: 45, tsunamiGrade: 'Watch' },
    notify: { sound: false, system: false, volume: 0.7 }, dedupe: { windowMinutes: 10 },
  }
  const quietAll = { enabled: true, start: '00:00', end: '23:59', breakForSevere: true }
  t.handleRaw({
    code: 551, id: 'qh-1', issue: { type: 'DetailScale', time: 't' },
    earthquake: { time: 'qh-t1', maxScale: 40, hypocenter: { name: '熊本県熊本地方', magnitude: 4 } },
    points: [{ pref: '熊本県', addr: '熊本市', scale: 40 }],
  }, Object.assign({}, base, { quietHours: quietAll }))
  assert(t.store.events[0].suppressed === true && t.store.events[0].suppressedReason.indexOf('静默时段') !== -1,
    '静默时段内命中（yellow）→ 只记历史并标注静默')
  const eewMsg = (id, eventId) => ({
    code: 556, id, cancelled: false, issue: { time: 't', eventId, serial: '1' },
    earthquake: { hypocenter: { name: '茨城県南部', magnitude: 6.7 } },
    areas: [{ pref: '茨城', name: '茨城県南部', scaleFrom: 50, scaleTo: 50 }],
  })
  t.handleRaw(eewMsg('qh-2', 'EV-QH1'), Object.assign({}, base, { quietHours: quietAll }))
  assert(t.store.events[0].suppressed !== true && t.store.events[0].hit === true, '静默时段内 EEW（red）→ 仍提醒（默认穿透）')
  t.handleRaw(eewMsg('qh-3', 'EV-QH2'), Object.assign({}, base, {
    quietHours: Object.assign({}, quietAll, { breakForSevere: false }),
  }))
  assert(t.store.events[0].suppressed === true, '关闭红色等级穿透 → EEW 也被静默')
}
console.log('== 静默时段：取消 / 解除不穿透 ==')
{
  const t = loadClientEx({}).exports.__test
  const base = {
    watch: { prefectures: [] }, disasters: { earthquake: true, tsunami: true },
    thresholds: { quakeScale: 40, eewScale: 45, tsunamiGrade: 'Watch' },
    notify: { sound: false, system: false, volume: 0.7 }, dedupe: { windowMinutes: 10 },
  }
  const open = { enabled: false, start: '23:00', end: '07:00', breakForSevere: true }
  const quietAll = { enabled: true, start: '00:00', end: '23:59', breakForSevere: true }
  const eewMsg = (id, cancelled) => ({
    code: 556, id, cancelled, issue: { time: 't', eventId: 'EV-QC', serial: '1' },
    earthquake: { hypocenter: { name: '茨城県南部', magnitude: 6.7 } },
    areas: cancelled ? [] : [{ pref: '茨城', name: '茨城県南部', scaleFrom: 50, scaleTo: 50 }],
  })
  t.handleRaw(eewMsg('qc-1', false), Object.assign({}, base, { quietHours: open }))
  assert(t.store.events[0].hit === true && !t.store.events[0].suppressed, '非静默时段 EEW → 提醒')
  t.handleRaw(eewMsg('qc-2', true), Object.assign({}, base, { quietHours: quietAll }))
  assert(t.store.events[0].suppressed === true && t.store.events[0].suppressedReason.indexOf('取消 / 解除不穿透') !== -1,
    '静默时段内的取消消息 → 只记历史，不打扰')
}
console.log('== 静默时段：配置校验 ==')
{
  const dirty = JSON.stringify({ version: 1, quietHours: { enabled: 'yes', start: '25:99', end: 7, breakForSevere: 'nope' } })
  const cfg = loadClient({ 'dsh.quakeAlert.v1': dirty }).__test.loadCfg()
  assert(cfg.quietHours.enabled === false, 'enabled 非布尔 → 回退 false')
  assert(cfg.quietHours.start === '23:00' && cfg.quietHours.end === '07:00', '非法时间 → 回退默认')
  assert(cfg.quietHours.breakForSevere === true, 'breakForSevere 非布尔 → 回退 true')
  const kept = loadClient({
    'dsh.quakeAlert.v1': JSON.stringify({ version: 1, quietHours: { enabled: true, start: '1:30', end: '6:45', breakForSevere: false } }),
  }).__test.loadCfg()
  assert(kept.quietHours.enabled === true && kept.quietHours.start === '1:30' && kept.quietHours.end === '6:45' && kept.quietHours.breakForSevere === false,
    '合法的 1 位小时写法保留')
  assert(loadClient({ 'dsh.quakeAlert.v1': JSON.stringify({ version: 1 }) }).__test.loadCfg().quietHours.enabled === false,
    '旧配置（无 quietHours 字段）→ 补默认值，不影响其它字段')
}

console.log('== 市区町村匹配：551 观测点按市收窄，区域级条目放行 ==')
{
  const t = loadClient().__test
  t.setCityTable({ '福島県': ['白河市', '郡山市'] }) // 市级匹配需要表就位
  const cfg = (cities, prefs) => ({
    watch: { prefectures: prefs || [], cities: cities || [] },
    disasters: { earthquake: true, tsunami: true },
    thresholds: { quakeScale: 10, eewScale: 45, tsunamiGrade: 'Watch' },
    notify: {}, dedupe: { windowMinutes: 10 },
  })
  const point = { // 观测点级（isArea: false）→ 可做市级收窄
    code: 551, id: 'c-1', issue: { type: 'DetailScale', time: 't' },
    earthquake: { time: 'ct-1', maxScale: 30, hypocenter: { name: '福島県沖', magnitude: 4 } },
    points: [{ pref: '福島県', addr: '白河市新白河', isArea: false, scale: 30 }],
  }
  const area = { // 区域级（isArea: true）→ 对应不到市町村
    code: 551, id: 'c-2', issue: { type: 'ScalePrompt', time: 't' },
    earthquake: { time: 'ct-2', maxScale: 30, hypocenter: { name: '福島県沖', magnitude: 4 } },
    points: [{ pref: '福島県', addr: '福島県中通り', isArea: true, scale: 30 }],
  }
  const a1 = t.parse(point)
  const a2 = t.parse(area)
  assert(a1.regions[0].cityKnown === true && a2.regions[0].cityKnown === false, 'parser 用 isArea 标记 cityKnown')
  assert(t.matchAlert(a1, cfg(['白河市'], ['福島県'])).hit === true, '选中白河市 → 白河市新白河 命中')
  assert(t.matchAlert(a1, cfg(['郡山市'], ['福島県'])).hit === false, '选中郡山市 → 白河市新白河 不命中')
  assert(t.matchAlert(a1, cfg(['郡山市'], ['福島県'])).reason.indexOf('市区町村') !== -1, '未命中原因说明已按市区町村收窄')
  assert(t.matchAlert(a1, cfg([], ['福島県'])).hit === true, '未选市区町村 → 县级粒度照常命中')
  assert(t.matchAlert(a1, cfg(['白河市'], [])).hit === true, '全日本 + 选市 → 市级收窄同样生效')
  assert(t.matchAlert(a2, cfg(['郡山市'], ['福島県'])).hit === true, '区域级条目（isArea）无法对应市町村 → 放行，不漏报')
  assert(t.matchAlert(t.parse(eew), cfg(['架空市'], ['茨城県'])).hit === true, 'EEW 是区域级数据 → 市级选择不收窄，不漏报')
  assert(t.matchAlert(t.parse(tsunami), cfg(['架空市'], ['福島県'])).hit === true, '海啸是予報区级数据 → 市级选择不收窄，不漏报')
}

console.log('== 市区町村表：注入 / 归一 / 配置清理 ==')
{
  const t = loadClientEx({}).exports.__test
  assert(t.cityTableState() === 'idle', '初始状态 idle')
  assert(t.setCityTable({ '福島県': ['白河市', '郡山市'], '架空県': ['X市'], '東京都': [1, null, '千代田区', '千代田区'] }) === true,
    '注入表成功（非法县名 / 非字符串 / 重复项被过滤）')
  assert(t.cityTableState() === 'ready', '注入后状态 ready')
  assert(t.citiesOfPref('福島県').join() === '白河市,郡山市', '按县取市町村')
  assert(t.citiesOfPref('架空県').length === 0, '不存在的县名被丢弃')
  assert(t.citiesOfPref('東京都').join() === '千代田区', '非字符串与重复项被过滤')
  assert(t.setCityTable(null) === false && t.setCityTable({}) === false, '空表 / 非法入参被拒绝')
  const t2 = loadClientEx({
    'dsh.quakeAlert.v1': JSON.stringify({ version: 1, watch: { prefectures: ['福島県'], cities: ['白河市', '架空市'] } }),
  }).exports.__test
  t2.setCityTable({ '福島県': ['白河市', '郡山市'] })
  t2.pruneUnknownCities()
  assert(t2.currentCfg().watch.cities.join() === '白河市', '表到位后清掉配置里不存在的市町村名')
  assert(t2.currentCfg().watch.prefectures.join() === '福島県', '清理市町村不影响都道府县')
}
console.log('== 市级匹配：addr 归一（短名 / 消歧 / 支庁名 / 仮名表记） ==')
{
  const t = loadClient().__test
  t.setCityTable({
    '福島県': ['福島市', '郡山市', '白河市', '伊達市'],
    '東京都': ['千代田区', '新宿区'],
    '大阪府': ['大阪市北区', '大阪市中央区'],
    '北海道': ['北斗市', '日高町', '龍ヶ崎市'],
    '熊本県': ['熊本市南区', '熊本市北区'],
    '沖縄県': ['宮古島市'],
    '岩手県': ['宮古市'],
  })
  const look = (a) => t.lookupAddrCity(a)
  assert(look('白河市新白河') === '白河市', '全称前缀：白河市新白河 → 白河市')
  assert(look('大阪北区茶屋町') === '大阪市北区', '政令市短名：大阪北区茶屋町 → 大阪市北区')
  assert(look('東京千代田区大手町') === '千代田区', '特别区带县短名：東京千代田区大手町 → 千代田区')
  assert(look('福島伊達市') === '伊達市', '重名消歧：福島伊達市 → 伊達市')
  assert(look('渡島北斗市') === '北斗市', '北海道支庁名：渡島北斗市 → 北斗市')
  assert(look('日高地方日高町') === '日高町', '北海道支庁名 + 地方：日高地方日高町 → 日高町')
  assert(look('熊本南区城南町') === '熊本市南区', '政令市短名：熊本南区城南町 → 熊本市南区')
  assert(look('宮古市区界') === '宮古市', '宮古市区界 → 岩手県宮古市（不与宮古島市撞车）')
  assert(look('宮古島市城辺福北') === '宮古島市', '宮古島市城辺福北 → 宮古島市')
  assert(look('龍ケ崎市') === '龍ヶ崎市', '仮名表记差异：龍ケ崎市 → 龍ヶ崎市')
  assert(look('新千歳空港') === null, '机场观测点归一不到市町村 → null（调用方放行）')
  assert(look('熊本県天草・芦北') === null, '区域名归一不到市町村 → null')
}
console.log('== 县级匹配：551 的 pref 简写归一（此前的静默漏报） ==')
{
  const t = loadClient().__test
  assert(t.normalizePref('京都') === '京都府', '「京都」→「京都府」')
  assert(t.normalizePref('東京') === '東京都', '「東京」→「東京都」')
  assert(t.normalizePref('茨城県') === '茨城県', '全称原样返回')
  assert(t.normalizePref('北海道') === '北海道', '北海道原样返回')
  assert(t.normalizePref('') === '' && t.normalizePref(null) === '', '空值返回空串')
  const a = t.parse({
    code: 551, id: 'k-1', issue: { type: 'DetailScale', time: 't' },
    earthquake: { time: 'kt-1', maxScale: 30, hypocenter: { name: '京都府南部', magnitude: 4 } },
    points: [{ pref: '京都', addr: '京都上京区薗ノ内町', isArea: false, scale: 30 }],
  })
  assert(a.regions[0].pref === '京都府', '解析后 region.pref 已是全称')
  const cfg = {
    watch: { prefectures: ['京都府'], cities: [] }, disasters: { earthquake: true, tsunami: true },
    thresholds: { quakeScale: 10, eewScale: 45, tsunamiGrade: 'Watch' }, notify: {}, dedupe: { windowMinutes: 10 },
  }
  assert(t.matchAlert(a, cfg).hit === true, '关注「京都府」能命中 pref 写作「京都」的消息（此前静默漏报）')
}

console.log('== 机器级持久化：Host settings 桥 ==')
{
  // 与 Host schema（lib/index.js）解析结果同形的完整 section
  const hostValue = () => JSON.parse(JSON.stringify({
    source: 'prod', watch: { prefectures: [], cities: [] },
    disasters: { earthquake: true, tsunami: true },
    thresholds: { quakeScale: 40, eewScale: 45, tsunamiGrade: 'Watch' },
    notify: { sound: true, system: true, volume: 0.7 },
    dedupe: { windowMinutes: 10 },
    quietHours: { enabled: false, start: '23:00', end: '07:00', breakForSevere: true },
  }))
  function fakeScope(state) {
    const listeners = []
    const writes = []
    const snap = Object.assign({
      status: 'ready', value: hostValue(), base: {}, user: {}, revision: 1, writable: true, mode: 'host',
    }, state || {})
    return {
      snap,
      writes,
      getSnapshot: () => snap,
      subscribe(fn) { listeners.push(fn); return () => {} },
      mutate(ops) { writes.push(ops); return Promise.resolve() },
    }
  }
  const localCfg = JSON.stringify({ version: 1, watch: { prefectures: ['東京都'] }, thresholds: { quakeScale: 55 } })
  const pathOf = (o) => o.path.join('.')

  // ① Host 用户层为空 + 本地已有非默认配置 → 一次性迁移
  {
    const t = loadClientEx({ 'dsh.quakeAlert.v1': localCfg }).exports.__test
    const scope = fakeScope()
    t.bindSettingsScope(scope)
    const ops = scope.writes[0] || []
    const setPrefs = ops.find((o) => o.op === 'set' && pathOf(o) === 'watch.prefectures')
    const setScale = ops.find((o) => o.op === 'set' && pathOf(o) === 'thresholds.quakeScale')
    const unsetDefault = ops.find((o) => o.op === 'unset' && pathOf(o) === 'notify.volume')
    assert(t.settingsState().sync === 'host', 'Host 可用 → host 模式')
    assert(setPrefs && setPrefs.value.join() === '東京都', '本地关注地区迁移到 Host（set watch.prefectures）')
    assert(setScale && setScale.value === 55, '本地阈值迁移到 Host（set thresholds.quakeScale）')
    assert(!!unsetDefault, '等于默认值的字段用 unset 交还 schema 默认层')
    assert(t.currentCfg().watch.prefectures.join() === '東京都', '迁移后内存配置仍是本地值')
  }
  // ② Host 用户层已有内容 → 以 Host 为准，且不回写
  {
    const t = loadClientEx({ 'dsh.quakeAlert.v1': localCfg }).exports.__test
    const host = hostValue()
    host.thresholds.quakeScale = 30
    host.watch.prefectures = ['熊本県']
    const scope = fakeScope({ value: host, user: { thresholds: { quakeScale: 30 }, watch: { prefectures: ['熊本県'] } } })
    t.bindSettingsScope(scope)
    assert(t.currentCfg().thresholds.quakeScale === 30, 'Host 有用户层 → 以 Host 为准（覆盖本地 55）')
    assert(t.currentCfg().watch.prefectures.join() === '熊本県', 'Host 的关注地区生效')
    assert(scope.writes.length === 0, '以 Host 为准时不回写 Host')
  }
  // ③ Host 不可用 → 保持 localStorage
  {
    const t = loadClientEx({ 'dsh.quakeAlert.v1': localCfg }).exports.__test
    const scope = fakeScope({ status: 'unavailable', value: undefined })
    t.bindSettingsScope(scope)
    assert(t.settingsState().sync === 'local', 'Host 不可用 → local 模式')
    assert(t.currentCfg().watch.prefectures.join() === '東京都', '仍读 localStorage 配置')
    assert(scope.writes.length === 0, '不回写不可用的 Host')
  }
  // ④ 页面不支持 Host 持久化（memory 模式）→ 只读不写
  {
    const t = loadClientEx({}).exports.__test
    const scope = fakeScope({ mode: 'memory', writable: false })
    t.bindSettingsScope(scope)
    assert(t.settingsState().sync === 'memory', 'Host 只做进程内存储 → memory 模式')
    assert(scope.writes.length === 0, 'memory 模式不写 Host')
  }
  // ⑤ 写入路径：applyCfg 立即生效并推给 Host
  {
    const t = loadClientEx({}).exports.__test
    const scope = fakeScope()
    t.bindSettingsScope(scope)
    scope.writes.length = 0
    const cur = t.currentCfg()
    t.applyCfg(Object.assign({}, cur, { thresholds: Object.assign({}, cur.thresholds, { quakeScale: 60 }) }))
    const ops = scope.writes[0] || []
    const set = ops.find((o) => o.op === 'set' && pathOf(o) === 'thresholds.quakeScale')
    assert(set && set.value === 60, 'applyCfg 把改动推给 Host（set thresholds.quakeScale）')
    assert(t.currentCfg().thresholds.quakeScale === 60, 'applyCfg 内存立即生效（连接重连等同步读取可见）')
  }
  // ⑥ 音量草稿兜底（设置页卸载时补写）：必须经 applyCfg，saveCfg 只写镜像会丢改动
  {
    const t = loadClientEx({}).exports.__test
    const scope = fakeScope()
    t.bindSettingsScope(scope)
    scope.writes.length = 0
    const cur = t.currentCfg()
    t.applyCfg(Object.assign({}, cur, { notify: Object.assign({}, cur.notify, { volume: 0.2 }) }))
    const ops = scope.writes[0] || []
    const vol = ops.find((o) => o.op === 'set' && pathOf(o) === 'notify.volume')
    assert(!!vol && vol.value === 0.2, '音量兜底落盘经 applyCfg → 同时推给 Host（saveCfg 不推）')
    assert(t.currentCfg().notify.volume === 0.2, '音量兜底同时更新内存副本（下一次同步不会被 Host 旧值顶回）')
  }
  // ⑦ 跨标签页同步：reloadFromLocal 回读本地镜像（0.2.1 曾在这里跨模块给 runtimeCfg 赋值）
  {
    const seed = JSON.stringify({ version: 1, watch: { prefectures: ['東京都'] }, notify: { volume: 0.4 } })
    const loaded = loadClientEx({ 'dsh.quakeAlert.v1': seed })
    const t = loaded.exports.__test
    assert(t.currentCfg().watch.prefectures.join() === '東京都', '初始内存配置来自本地镜像')
    // 模拟「另一个 DSH 标签页」直接改写存储（storage 事件只在本页之外的写入时触发）
    loaded.storage.set('dsh.quakeAlert.v1', JSON.stringify({ version: 1, watch: { prefectures: ['熊本県'] }, notify: { volume: 0.4 } }))
    const reloaded = t.reloadFromLocal()
    assert(reloaded.watch.prefectures.join() === '熊本県', 'reloadFromLocal 回读其它标签页写入的配置')
    assert(t.currentCfg().watch.prefectures.join() === '熊本県', '内存副本同步更新（UI 据此重渲染）')
    assert(typeof t.reloadFromLocal === 'function', '回读入口已导出（跨模块只能走显式入口，不能直接赋值）')
  }
  // ⑧ 没有 Host 时一切照旧
  {
    const t = loadClientEx({}).exports.__test
    let err = ''
    try { t.applyCfg(Object.assign({}, t.currentCfg(), { source: 'sandbox' })) } catch (e) { err = e.message }
    assert(err === '', '没有 Host 时 applyCfg 不抛错')
    assert(t.currentCfg().source === 'sandbox', '没有 Host 时配置仍即时生效')
  }
  // ⑨ scope 异常不拖垮插件
  {
    const t = loadClientEx({}).exports.__test
    let err = ''
    try { t.bindSettingsScope({ getSnapshot() { throw new Error('boom') }, subscribe() { return () => {} } }) } catch (e) { err = e.message }
    assert(err === '', 'scope 异常时 bindSettingsScope 不抛错')
    assert(t.currentCfg().source === 'prod', '异常后仍可读取本地配置')
  }
}

;(async () => {
  console.log('== Host settings schema 与 Client 默认值一致 ==')
  try {
    const mod = await import(pathToFileURL(path.join(ROOT, 'lib', 'index.js')).href)
    const hostDefault = mod.QuakeAlertSettingsSchema({})
    const clientDefault = T.cfgToSection(T.DEFAULT_CFG)
    assert(JSON.stringify(hostDefault) === JSON.stringify(clientDefault), 'Host schema 默认值与 Client DEFAULT_CFG 完全一致')
    assert(mod.SETTINGS_NAMESPACE === T.SETTINGS_NS, '两侧 namespace 名称一致（' + mod.SETTINGS_NAMESPACE + '）')
    let rejectedScale = false
    try { mod.QuakeAlertSettingsSchema({ thresholds: { quakeScale: 999 } }) } catch (e) { rejectedScale = true }
    assert(rejectedScale, 'Host schema 拒绝越界震度')
    let rejectedSource = false
    try { mod.QuakeAlertSettingsSchema({ source: 'bogus' }) } catch (e) { rejectedSource = true }
    assert(rejectedSource, 'Host schema 拒绝非法数据源')
    const withCities = mod.QuakeAlertSettingsSchema({ watch: { cities: ['白河市'] } })
    assert(withCities.watch.cities.join() === '白河市', 'Host schema 接受市区町村列表')
  } catch (e) {
    assert(false, 'Host schema 加载失败：' + e.message)
  }

  console.log('== 真实市区町村表与 Host /areas 路由 ==')
  try {
    const cities = await import(pathToFileURL(path.join(ROOT, 'lib', 'data', 'cities.js')).href)
    const table = cities.CITIES_BY_PREF
    const prefs = Object.keys(table)
    const total = prefs.reduce((n, p) => n + table[p].length, 0)
    assert(prefs.length === 47, '真实表覆盖 47 个都道府县')
    assert(total >= 1700 && total <= 2100, '真实表条目数在合理区间（' + total + '）')
    const bad = prefs.filter((p) => !Array.isArray(table[p]) || table[p].length === 0 || table[p].some((c) => typeof c !== 'string' || !c))
    assert(bad.length === 0, '每个县都有非空数组且元素均为非空字符串')
    assert(table['大阪府'].indexOf('大阪市北区') !== -1, '政令指定都市按区提供（大阪市北区）')
    assert(table['沖縄県'].indexOf('北谷町') !== -1 && table['沖縄県'].indexOf('中頭郡北谷町') === -1, '郡名按気象庁写法省略（北谷町，而非中頭郡北谷町）')
    assert(table['高知県'].indexOf('梼原町') !== -1, '郡省略同样覆盖高知県梼原町')
    const t = loadClient().__test
    assert(t.setCityTable(table) === true, '真实表可被 Client 注入')
    assert(t.lookupAddrCity('白河市新白河') === '白河市', '沙箱样本 addr → 白河市')
    assert(t.lookupAddrCity('宮古島市城辺福北') === '宮古島市', '真实观测点 addr → 宮古島市')
    assert(t.lookupAddrCity('大阪北区茶屋町') === '大阪市北区', '真实观测点短名 → 大阪市北区')
    assert(t.lookupAddrCity('東京千代田区大手町') === '千代田区', '真实观测点 → 千代田区')
    const liveAddrs = ['白河市新白河', '宮古島市城辺福北', '大阪北区茶屋町', '仙台宮城野区苦竹', '熊本南区城南町',
      '神戸東灘区住吉東町', '京都上京区薗ノ内町', '東京千代田区大手町', '成田市名古屋', '宮古市区界']
    const missed = liveAddrs.filter((addr) => t.lookupAddrCity(addr) === null)
    assert(missed.length === 0, '实测直播 addr 全部可归一（未命中：' + missed.join('/') + '）')
    assert(t.citiesOfPref('架空県').length === 0, '不存在的县仍返回空')

    // Host 侧：假 ctx 走一遍 apply，检查路由输出
    const mod = await import(pathToFileURL(path.join(ROOT, 'lib', 'index.js')).href)
    const routes = []
    const registered = []
    const fakeCtx = {
      // 顶层 effect：0.3.0-b 起 apply 用它管理轮询器的启停
      effect(fn) { fn(); return () => {} },
      inject(names, cb) {
        if (names.indexOf('settings') !== -1) {
          cb({ settings: { register: (ns, schema) => { registered.push({ ns, schema }); return {} } } })
        }
        if (names.indexOf('webServer') !== -1) {
          cb({
            effect(fn) { fn(); return () => {} },
            webServer: { register: (r) => { routes.push(r); return () => {} } },
          })
        }
      },
    }
    mod.apply(fakeCtx)
    assert(registered.length === 1 && registered[0].ns === 'quake-alert', 'Host apply 注册了 settings namespace')
    assert(routes.length === 2, 'Host apply 注册了 2 条只读路由（/areas 与 /feed）')
    const areasRoute = routes.find((r) => r.path === '/dsh-quake-alert/areas')
    const feedRoute = routes.find((r) => r.path === '/dsh-quake-alert/feed')
    assert(!!areasRoute && !!feedRoute, '路由分别是 /areas 与 /feed')
    let status = 0
    let body = ''
    areasRoute.handler({}, { writeHead(s) { status = s }, end(b) { body = b } })
    const parsed = JSON.parse(body)
    assert(status === 200, '/areas 返回 200')
    assert(parsed.prefectures && Object.keys(parsed.prefectures).length === 47, '路由返回 47 个县的市町村表')
    assert(parsed.prefectures['福島県'].indexOf('白河市') !== -1, '路由返回的表含白河市')

    // /feed：电文增量（apply 刚装载，轮询还没跑过 → 应为空快照）
    const feedRes = { status: 0, body: '' }
    const feedCall = (url) => feedRoute.handler({ url }, {
      writeHead(s) { feedRes.status = s },
      end(b) { feedRes.body = b },
    })
    feedCall('/dsh-quake-alert/feed?since=0&stats=1')
    const feedPayload = JSON.parse(feedRes.body)
    assert(feedRes.status === 200 && feedPayload.cursor === 0 && Array.isArray(feedPayload.entries),
      '/feed 返回游标与增量数组')
    assert(feedPayload.stats && typeof feedPayload.stats.polls === 'number', '?stats=1 附带轮询统计（便于诊断）')
    feedCall('/dsh-quake-alert/feed?since=abc')
    assert(JSON.parse(feedRes.body).entries.length === 0, '非法 since 参数按 0 处理（不抛错）')
    feedCall('/dsh-quake-alert/feed')
    assert(JSON.parse(feedRes.body).cursor === 0, '省略 since 时按 0 处理')
  } catch (e) {
    assert(false, '真实市区町村表 / Host 路由验证失败：' + e.message)
  }

  console.log('== 0.3.0-a：河川予報区域表（指定河川洪水予報 → 市町村）==')
  try {
    const river = await import(pathToFileURL(path.join(ROOT, 'lib', 'data', 'river-areas.js')).href)
    const areas = river.RIVER_AREAS
    const meta = river.RIVER_AREA_META
    assert(Array.isArray(areas) && areas.length >= 300, '区域表已生成且规模合理（' + areas.length + '）')
    assert(meta.areaCount === areas.length, 'META.areaCount 与数组长度一致')
    assert(areas.every((a) => /^\d{12}$/.test(a.code)), '区域代码均为 12 位数字')
    assert(areas.every((a) => typeof a.name === 'string' && a.name !== ''), '区域名非空')
    assert(areas.every((a) => Array.isArray(a.cities) && a.cities.length > 0), '每个区域至少对应一个市町村')
    assert(areas.every((a) => a.cities.every((c) => typeof c === 'string' && c !== '')), '市町村名均为非空字符串')
    const codes = new Set(areas.map((a) => a.code))
    assert(codes.size === areas.length, '区域代码唯一（可作主键）')
    const citySet = new Set()
    for (const a of areas) for (const c of a.cities) citySet.add(c)
    assert(citySet.size === meta.cityCount, '去重市町村数与 META 一致（' + citySet.size + '）')
    // 重名实证：同名河川存在于多个区域代码下 —— 这正是主键必须是 code 而不是 name 的原因
    const arakawa = areas.filter((a) => a.name === '荒川')
    assert(arakawa.length >= 2 && new Set(arakawa.map((a) => a.code)).size === arakawa.length,
      '同名区域（荒川）对应多个不同代码 → 主键用 code（' + arakawa.length + ' 个）')
    const ten = areas.find((a) => a.name === '天塩川')
    assert(!!ten && ten.cities.indexOf('士別市') !== -1, '天塩川 → 可反查到市町村（士別市）')
  } catch (e) {
    assert(false, '河川区域表验证失败：' + e.message)
  }

  console.log('== zip 读取器（scripts/lib/zip.mjs：构建脚本与未来的 xlsx 共用）==')
  try {
    const { unzip } = await import(pathToFileURL(path.join(ROOT, 'scripts', 'lib', 'zip.mjs')).href)
    const zlib = require('node:zlib')
    // 手工构造最小 zip：覆盖 store / deflate 两条路径与日文 UTF-8 文件名
    const buildZip = (name, content, deflate) => {
      const nameBuf = Buffer.from(name, 'utf8')
      const raw = Buffer.from(content, 'utf8')
      const data = deflate ? zlib.deflateRawSync(raw) : raw
      const method = deflate ? 8 : 0
      const local = Buffer.alloc(30)
      local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x800, 6)
      local.writeUInt16LE(method, 8)
      local.writeUInt32LE(data.length, 18); local.writeUInt32LE(raw.length, 22)
      local.writeUInt16LE(nameBuf.length, 26)
      const central = Buffer.alloc(46)
      central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6)
      central.writeUInt16LE(0x800, 8); central.writeUInt16LE(method, 10)
      central.writeUInt32LE(data.length, 20); central.writeUInt32LE(raw.length, 24)
      central.writeUInt16LE(nameBuf.length, 28)
      const cdOffset = local.length + nameBuf.length + data.length
      const eocd = Buffer.alloc(22)
      eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(1, 8); eocd.writeUInt16LE(1, 10)
      eocd.writeUInt32LE(central.length + nameBuf.length, 12); eocd.writeUInt32LE(cdOffset, 16)
      return Buffer.concat([local, nameBuf, data, central, nameBuf, eocd])
    }
    const stored = unzip(buildZip('区域,名.csv', 'a,b\n1,2\n', false))
    assert(stored.length === 1 && stored[0].data.toString('utf8') === 'a,b\n1,2\n', 'store 路径解出内容正确')
    assert(stored[0].name === '区域,名.csv', 'UTF-8 文件名（含日文与逗号）正确解码')
    const deflated = unzip(buildZip('x.csv', 'hello 世界'.repeat(50), true))
    assert(deflated[0].data.toString('utf8') === 'hello 世界'.repeat(50), 'deflate 路径解出内容正确')
    let threw = false
    try { unzip(Buffer.from('not a zip at all')) } catch (err) { threw = true }
    assert(threw, '非 zip 输入抛出明确错误（不静默返回空）')
  } catch (e) {
    assert(false, 'zip 读取器验证失败：' + e.message)
  }

  console.log('== 0.3.0-b：Host 电文轮询器（冷启动 / 去重 / 增量 / 环缓冲）==')
  try {
    const { createPoller, parseAtomEntries } = await import(pathToFileURL(path.join(ROOT, 'lib', 'poller.js')).href)
    const FEED = 'https://example.test/feed.xml'
    const atom = (list) => '<?xml version="1.0"?><feed>' + list.map((e) =>
      '<entry><title>' + e.title + '</title><id>' + e.id + '</id><updated>' + e.updated + '</updated></entry>').join('') + '</feed>'
    const entry = (n, iso) => ({ id: 'detail-' + n, title: '电文' + n, updated: iso })
    const fakeFetch = (routes) => {
      const calls = []
      return {
        calls,
        fn: async (url) => {
          calls.push(url)
          if (!(url in routes)) throw new Error('unknown url ' + url)
          const v = routes[url]
          return typeof v === 'function' ? v() : v
        },
      }
    }
    const T0 = Date.parse('2026-09-11T12:00:00Z')

    // ① Atom 解析（只需要 id/title/updated）
    const parsed = parseAtomEntries(atom([entry(1, '2026-09-11T11:00:00Z'), { id: 'x', title: '', updated: '' }]))
    assert(parsed.length === 2 && parsed[0].id === 'detail-1' && parsed[0].title === '电文1', 'Atom 解析出 id/title/updated')
    assert(parseAtomEntries('<feed></feed>').length === 0, '空 feed 返回空数组')
    assert(parseAtomEntries('<entry><title>无 id</title></entry>').length === 0, '缺 id 的 entry 被跳过')

    // ② 冷启动：把 feed 里的历史全部记为已见，但不拉详情、不产事件
    let feedXml = atom([entry(1, '2026-09-11T11:00:00Z'), entry(2, '2026-09-11T11:30:00Z')])
    let clock = T0
    const f1 = fakeFetch({ [FEED]: () => feedXml, 'detail-1': '<Report/>', 'detail-2': '<Report/>', 'detail-3': '<Report/>', 'detail-4': '<Report/>' })
    const p1 = createPoller({ feedUrl: FEED, fetchText: f1.fn, now: () => clock })
    const r1 = await p1.pollOnce()
    assert(r1.coldStart === true && r1.added === 0, '冷启动不产生事件（不把 feed 里的历史当新闻）')
    assert(f1.calls.length === 1 && f1.calls[0] === FEED, '冷启动只拉 feed，不拉任何详情')
    assert(p1.snapshot(0).entries.length === 0 && p1.snapshot(0).cursor === 0, '冷启动后缓冲为空、游标为 0')

    // ③ 增量：只为新 entry 拉详情，已见过的绝不重拉
    clock += 60 * 1000
    feedXml = atom([entry(3, '2026-09-11T12:01:00Z'), entry(2, '2026-09-11T11:30:00Z'), entry(1, '2026-09-11T11:00:00Z')])
    const r2 = await p1.pollOnce()
    assert(r2.added === 1, '新一轮只处理新 entry（+1）')
    assert(f1.calls.filter((u) => u === 'detail-3').length === 1, '为新 entry 拉了一次详情')
    assert(f1.calls.filter((u) => u === 'detail-1' || u === 'detail-2').length === 0,
      '冷启动时已见过的 entry 永不重拉（気象庁「不重复获取同一文件」）')
    const snap1 = p1.snapshot(0)
    assert(snap1.cursor === 1 && snap1.entries.length === 1 && snap1.entries[0].id === 'detail-3', '增量快照含新条目与其原文')

    // ④ feed 未变时只拉一次 feed，不碰详情
    const callsBefore = f1.calls.length
    const r3 = await p1.pollOnce()
    assert(r3.added === 0 && f1.calls.length === callsBefore + 1, 'feed 无变化时只拉 feed 本身')

    // ⑤ since 游标：只返回更新的条目
    clock += 60 * 1000
    feedXml = atom([entry(4, '2026-09-11T12:02:00Z'), entry(3, '2026-09-11T12:01:00Z')])
    await p1.pollOnce()
    assert(p1.snapshot(1).entries.length === 1 && p1.snapshot(1).entries[0].id === 'detail-4', 'since=1 → 只返回 seq>1 的条目')
    assert(p1.snapshot(2).entries.length === 0, 'since=最新游标 → 返回空')
    assert(p1.snapshot(0).truncated === false, '游标在缓冲范围内 → 不标记截断')

    // ⑥ 详情拉取失败：不产事件、记 error，且不再重试（避免对坏 URL 反复请求）
    clock += 60 * 1000
    const feedFail = atom([entry(7, new Date(clock).toISOString())])
    const f2 = fakeFetch({ [FEED]: () => feedFail }) // detail-7 未登记 → 详情请求抛错
    const pFail = createPoller({
      feedUrl: FEED, fetchText: f2.fn, now: () => clock,
      backfillMs: 5 * 60 * 1000, // 让冷启动也处理它，才能走到详情失败这条路径
    })
    const r6 = await pFail.pollOnce()
    assert(r6.added === 0 && pFail.stats().errors === 1, '详情拉取失败 → 不产事件、记 error')
    const tried = f2.calls.filter((u) => u === 'detail-7').length
    clock += 60 * 1000
    await pFail.pollOnce()
    assert(tried === 1 && f2.calls.filter((u) => u === 'detail-7').length === 1, '失败的 entry 不再重试')

    // ⑦ 环缓冲上限：连续入 3 条、容量 1 → 只留最后 1 条，且更旧的游标标记截断
    clock += 60 * 1000
    let feedRotate = atom([entry(40, new Date(clock).toISOString())])
    const routes7 = { [FEED]: () => feedRotate, 'detail-41': '<Report/>', 'detail-42': '<Report/>' }
    const f3 = fakeFetch(routes7)
    const pRing = createPoller({ feedUrl: FEED, fetchText: f3.fn, now: () => clock, maxEntries: 1 })
    await pRing.pollOnce() // 冷启动：detail-40 记为已见
    for (const n of [41, 42]) {
      clock += 60 * 1000
      feedRotate = atom([entry(n, new Date(clock).toISOString()), entry(n - 1, new Date(clock - 60000).toISOString())])
      await pRing.pollOnce()
    }
    const snapRing = pRing.snapshot(0)
    assert(snapRing.cursor === 2, '游标只统计真正入缓冲的条目（冷启动不计）')
    assert(snapRing.entries.length === 1 && snapRing.entries[0].id === 'detail-42', '环缓冲按 maxEntries 淘汰最旧的')
    assert(pRing.snapshot(0).truncated === true, '有条目被淘汰后从头拉取 → 标记 truncated')
    assert(pRing.snapshot(2).truncated === false, '游标正好等于最新 → 不标记截断')

    // ⑧ feed 拉取失败：记 error、不抛、游标不动
    const f4 = fakeFetch({})
    const p6 = createPoller({ feedUrl: FEED, fetchText: f4.fn, now: () => clock })
    const r8 = await p6.pollOnce()
    assert(r8.added === 0 && p6.stats().errors === 1 && p6.snapshot(0).cursor === 0, 'feed 失败时记 error、不产事件、游标不动')

    // ⑨ 回填窗口：显式配置时才处理"启动前刚发布"的那一段
    clock = T0
    const f5 = fakeFetch({
      [FEED]: () => atom([entry(30, new Date(T0 - 2 * 60 * 1000).toISOString()), entry(31, new Date(T0 - 60 * 60 * 1000).toISOString())]),
      'detail-30': '<Report/>', 'detail-31': '<Report/>',
    })
    const p7 = createPoller({ feedUrl: FEED, fetchText: f5.fn, now: () => clock, backfillMs: 5 * 60 * 1000 })
    const r9 = await p7.pollOnce()
    assert(r9.added === 1 && p7.snapshot(0).entries[0].id === 'detail-30',
      'backfillMs 窗口内的 entry 仍处理，窗口外的（1 小时前）跳过')

    // ⑪ 按需轮询：没人经 /feed 读取就不拉源（气象灾害关闭时 Client 不再拉 → Host 自然停下）
    clock = T0
    const f6 = fakeFetch({ [FEED]: () => atom([entry(50, new Date(clock).toISOString())]) })
    const pIdle = createPoller({ feedUrl: FEED, fetchText: f6.fn, now: () => clock, idleMs: 10 * 60 * 1000 })
    const rIdle = await pIdle.pollOnce()
    assert(rIdle.skipped === true && f6.calls.length === 0, '无人读取时跳过轮询（不产生任何外部请求）')
    pIdle.markRead()
    clock += 60 * 1000
    const rWake = await pIdle.pollOnce()
    assert(rWake.skipped !== true && f6.calls.length === 1, 'markRead 之后恢复正常轮询')
    clock += 11 * 60 * 1000
    const rIdle2 = await pIdle.pollOnce()
    assert(rIdle2.skipped === true && pIdle.stats().idleSkips === 2, '超过 idleMs 无人读 → 再次跳过')

    // ⑫ 启停：stop 后 snapshot 标记 frozen
    p7.start()
    assert(p7.snapshot(0).frozen === false, 'start 后状态为运行中')
    p7.stop()
    assert(p7.snapshot(0).frozen === true, 'stop 后 snapshot 标记 frozen')
  } catch (e) {
    assert(false, 'Host 轮询器验证失败：' + e.message)
  }

  console.log('== 0.3.0-c：JMA 电文解析（泥石流 / 洪水 / 大雨 / 高潮）==')
  try {
    const riverMod = await import(pathToFileURL(path.join(ROOT, 'lib', 'data', 'river-areas.js')).href)
    const citiesMod = await import(pathToFileURL(path.join(ROOT, 'lib', 'data', 'cities.js')).href)
    const t = loadClient().__test
    t.setCityTable(citiesMod.CITIES_BY_PREF)
    t.setRiverAreas(riverMod.RIVER_AREAS)
    const jma = (n) => fs.readFileSync(path.join(ROOT, 'samples', n), 'utf8')

    // ① 土砂災害警戒情報（VXWW50）：电文本身就是 L4 相当，区域全是市町村
    const w = t.parseJma(jma('jma-vxww50-landslide.xml'), { id: 'vxww50' })
    assert(w && w.kind === 'weather', 'VXWW50 → kind=weather')
    assert(w.level === 4, 'VXWW50 → 警戒レベル4（电文本身即 L4 相当）')
    assert(w.kindLabel === '泥石流警戒情报', 'VXWW50 → 中文标签为泥石流警戒情报')
    assert(w.severity === 'red' && w.cancelled === false, 'VXWW50 → severity=red、非解除')
    assert(w.regions.length >= 20, 'VXWW50 → 展开出 ' + w.regions.length + ' 个市町村（裸 <Area> 也能取到）')
    assert(w.regions.every((r) => r.pref === '福岡県' && r.city), 'VXWW50 → 全部归到福岡県的市町村（按 code 前两位判县）')
    assert(w.eventKey.indexOf('福岡県土砂災害警戒情報') !== -1, 'VXWW50 → 事件键取自 EventID')

    // ② 指定河川洪水予報（VXKO）：区域是河川予報区域（12 位码），级别写在 Headline 主文里
    const f = t.parseJma(jma('jma-vxko-flood.xml'), { id: 'vxko' })
    assert(f && f.level === 2, 'VXKO → 从「警戒レベル２相当情報」读出级别')
    assert(f.kindLabel === '洪水预报', 'VXKO → 中文标签为洪水预报')
    assert(f.regions.length >= 1 && f.regions.some((r) => r.prefUnknown),
      'VXKO → 样本用占位码认不出归属时标记 prefUnknown（放行而不是漏报）')

    // ③ 新体系分灾种电文（Ｒ０６）：级别写在 <Kind><Name> 里
    const s = t.parseJma(jma('jma-vpww56-landslide.xml'), { id: 'vpww56' })
    assert(s && s.level === 4 && s.kindLabel === '泥石流警报', 'VPWW56（土砂）→ L4 / 泥石流警报')
    const hr = t.parseJma(jma('jma-vpww55-heavyrain.xml'), { id: 'vpww55' })
    assert(hr && hr.level === 4 && hr.kindLabel === '大雨警报', 'VPWW55（大雨）→ L4 / 大雨警报')
    const ss = t.parseJma(jma('jma-vpww57-stormsurge.xml'), { id: 'vpww57' })
    assert(ss && ss.level === 4 && ss.kindLabel === '风暴潮警报', 'VPWW57（高潮）→ L4 / 风暴潮警报')
    assert(s.regions.some((r) => r.pref === '北海道'), '细分区域（宗谷北部）按 code 前两位归到北海道')
    assert(s.regions.every((r) => r.pref), 'VPWW56 → 没有 prefUnknown（细分区全部识别）')

    // ④ 与预警无关的电文（天气预报等）不进主链
    const nothing = t.parseJma('<?xml version="1.0"?><Report><Control><Title>府県天気予報</Title></Control>' +
      '<Head><Title>東京都府県天気予報</Title></Head><Body><Item><Kind><Name>天気概況</Name><Code>1</Code></Kind>' +
      '<Area><Name>東京地方</Name><Code>130010</Code></Area></Item></Body></Report>', { id: 'x' })
    assert(nothing === null, '无警戒级别的电文（天气预报）→ null')

    // ⑤ 解除电文复用既有的取消 / 解除链路
    const cancelXml = '<?xml version="1.0"?><Report><Control><Title>土砂災害警戒情報</Title></Control>' +
      '<Head><Title>福岡県土砂災害警戒情報</Title><EventID>福岡県土砂災害警戒情報</EventID>' +
      '<ReportDateTime>2026-09-11T10:00:00+09:00</ReportDateTime><Headline><Text>解除</Text>' +
      '<Information type="土砂災害警戒情報"><Item><Kind><Name>解除</Name><Code>1</Code><Status>解除</Status></Kind>' +
      '<Areas codeType="気象・地震・火山情報／市町村等"><Area><Name>北九州市</Name><Code>4010000</Code></Area></Areas>' +
      '</Item></Information></Headline></Head><Body/></Report>'
    const cxl = t.parseJma(cancelXml, { id: 'vxww50-cancel' })
    assert(cxl && cxl.cancelled === true, '解除电文 → cancelled=true')
    assert(cxl.kindLabel.indexOf('已解除') !== -1 && cxl.regions.length === 0, '解除电文 → 标签标注已解除、不展开区域')
  } catch (e) {
    assert(false, 'JMA 解析验证失败：' + e.message)
  }

  console.log('== 0.3.0-c：气象警报的匹配与播报边界（L4 起）==')
  try {
    const riverMod = await import(pathToFileURL(path.join(ROOT, 'lib', 'data', 'river-areas.js')).href)
    const citiesMod = await import(pathToFileURL(path.join(ROOT, 'lib', 'data', 'cities.js')).href)
    const t = loadClient().__test
    t.setCityTable(citiesMod.CITIES_BY_PREF)
    t.setRiverAreas(riverMod.RIVER_AREAS)
    const alert = t.parseJma(fs.readFileSync(path.join(ROOT, 'samples', 'jma-vxww50-landslide.xml'), 'utf8'), { id: 'v' })
    const base = () => ({
      watch: { prefectures: [], cities: [] },
      disasters: { earthquake: true, tsunami: true, weather: true },
      thresholds: {}, dedupe: { windowMinutes: 10 }, notify: {}, quietHours: { enabled: false },
    })
    assert(t.matchAlert(alert, base()).hit === true, 'L4 + 全日本模式 → 提醒')
    const off = base(); off.disasters.weather = false
    assert(t.matchAlert(alert, off).hit === false, '气象灾害开关关闭 → 不提醒')
    const other = base(); other.watch.prefectures = ['東京都']
    assert(t.matchAlert(alert, other).hit === false, '关注县不匹配 → 不提醒')
    const hitPref = base(); hitPref.watch.prefectures = ['福岡県']
    assert(t.matchAlert(alert, hitPref).hit === true, '关注福岡県 → 提醒')
    const c1 = base(); c1.watch = { prefectures: ['福岡県'], cities: ['北九州市'] }
    assert(t.matchAlert(alert, c1).hit === true, '市级收窄命中北九州市 → 提醒')
    const c2 = base(); c2.watch = { prefectures: ['福岡県'], cities: ['札幌市'] }
    assert(t.matchAlert(alert, c2).hit === false, '市级收窄未命中 → 不提醒')
    const l3 = Object.assign({}, alert, { level: 3, strength: 3 })
    const m3 = t.matchAlert(l3, base())
    assert(m3.hit === false && m3.reason.indexOf('未达 L4') !== -1, 'L3 → 不播报，原因写明未达 L4')
    // 区域级条目（city 为空）在市级收窄下必须放行——宁可多报
    const prefOnly = base(); prefOnly.watch = { prefectures: ['北海道'], cities: ['札幌市'] }
    const sAlert = t.parseJma(fs.readFileSync(path.join(ROOT, 'samples', 'jma-vpww56-landslide.xml'), 'utf8'), { id: 's' })
    assert(t.matchAlert(sAlert, prefOnly).hit === true, '区域级条目（宗谷地方）在市町村收窄下放行 → 提醒')
  } catch (e) {
    assert(false, '气象警报匹配验证失败：' + e.message)
  }

  console.log('== 0.3.0-c：Client 电文增量拉取（游标 / 容错 / 开关）==')
  try {
    const t = loadClient().__test
    const calls = []
    let payload = { cursor: 0, entries: [] }
    const seen = []
    const c1 = t.createFeedClient({
      fetchJson: async (url) => { calls.push(url); return payload },
      apply: (e) => { seen.push(e.id); return true },
      getCfg: () => ({ disasters: { weather: true } }),
    })
    payload = { cursor: 2, entries: [{ id: 'e1' }, { id: 'e2' }] }
    const r1 = await c1.pollOnce()
    assert(r1.applied === 2 && seen.join() === 'e1,e2', '增量按序应用')
    assert(c1.cursor() === 2, '游标推进到 Host 返回值')
    payload = { cursor: 3, entries: [{ id: 'e3' }], truncated: true }
    await c1.pollOnce()
    assert(calls[1].indexOf('since=2') !== -1, '后续请求带上游标（?since=2）')
    assert(c1.stats().truncated === 1, 'truncated 如实计数（有缺口仍继续前进）')

    // Host 不可达：记 error、不抛
    let fail = true
    const c2 = t.createFeedClient({
      fetchJson: async () => { if (fail) throw new Error('boom'); return { cursor: 1, entries: [] } },
      apply: () => true, getCfg: () => ({ disasters: { weather: true } }),
    })
    const r2 = await c2.pollOnce()
    assert(r2.applied === 0 && c2.stats().errors === 1, 'Host 不可达 → 记 error、不抛')
    fail = false
    await c2.pollOnce()
    assert(c2.stats().errors === 1 && c2.cursor() === 1, '恢复后正常推进，错误计数不再增长')

    // 单条失败不影响其余条目与游标
    const applied = []
    const c3 = t.createFeedClient({
      fetchJson: async () => ({ cursor: 3, entries: [{ id: 'ok' }, { id: 'bad' }, { id: 'ok2' }] }),
      apply: (e) => { if (e.id === 'bad') throw new Error('parse fail'); applied.push(e.id); return true },
      getCfg: () => ({ disasters: { weather: true } }),
    })
    const r3 = await c3.pollOnce()
    assert(r3.applied === 2 && applied.join() === 'ok,ok2', '单条失败不影响其余条目')
    assert(c3.cursor() === 3 && c3.stats().errors === 1, '单条失败不阻断游标前进')

    // 气象灾害关闭时不发起本地拉取
    let fetched = 0
    const c4 = t.createFeedClient({
      firstDelayMs: 0, intervalMs: 10,
      fetchJson: async () => { fetched += 1; return { cursor: 0, entries: [] } },
      getCfg: () => ({ disasters: { weather: false } }),
    })
    c4.start()
    await new Promise((resolve) => setTimeout(resolve, 60))
    c4.stop()
    assert(fetched === 0, '气象灾害关闭时不拉取（Host 侧随后也会据此停轮询）')
  } catch (e) {
    assert(false, 'Client 增量拉取验证失败：' + e.message)
  }

  console.log('== 0.3.0-c：气象灾害配置字段 ==')
  {
    const dirty = loadClient({
      'dsh.quakeAlert.v1': JSON.stringify({ version: 1, disasters: { earthquake: false, weather: 'yes' } }),
    }).__test.loadCfg()
    assert(dirty.disasters.weather === true, 'weather 类型不符 → 回退默认 true')
    assert(dirty.disasters.earthquake === false, '同组其它字段不受影响')
    const legacy = loadClient({ 'dsh.quakeAlert.v1': JSON.stringify({ version: 1 }) }).__test.loadCfg()
    assert(legacy.disasters.weather === true, '旧配置缺 weather 字段 → 取默认值（不误关）')
  }

  console.log('\n结果: ' + pass + ' 通过, ' + fail + ' 失败')
  process.exit(fail === 0 ? 0 : 1)
})()
