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
    // 0.3.2（P1）：河川予報区域表必须随同一份响应下发。此前它只生成不下发，Client 侧永远为空，
    // 洪水电文因此全部退化为"归不到市町村"而放行 —— 关注任何地区的用户都会收到无关县的警报。
    assert(Array.isArray(parsed.riverAreas) && parsed.riverAreas.length >= 300,
      '/areas 同时下发河川予報区域表（' + (parsed.riverAreas ? parsed.riverAreas.length : 0) + ' 个区域）')
    assert(parsed.riverAreas.every((a) => typeof a.code === 'string' && /^\d{12}$/.test(a.code) &&
      Array.isArray(a.cities) && a.cities.length > 0), 'riverAreas 结构可直接被 setRiverAreas 接受')

    // /feed：电文增量（apply 刚装载，轮询还没跑过 → 应为空快照）
    const feedRes = { status: 0, body: '' }
    const feedCall = (url) => feedRoute.handler({ url }, {
      writeHead(s) { feedRes.status = s },
      end(b) { feedRes.body = b },
    })
    feedCall('/dsh-quake-alert/feed?since=0&stats=1')
    const feedPayload = JSON.parse(feedRes.body)
    assert(feedRes.status === 200 && Number.isFinite(feedPayload.cursor) && feedPayload.cursor > 0 && Array.isArray(feedPayload.entries),
      '/feed 返回游标与增量数组（游标是时间戳基数，Host 重启后仍单调）')
    assert(feedPayload.stats && typeof feedPayload.stats.polls === 'number', '?stats=1 附带轮询统计（便于诊断）')
    feedCall('/dsh-quake-alert/feed?since=abc')
    assert(JSON.parse(feedRes.body).entries.length === 0, '非法 since 参数按 0 处理（不抛错）')
    feedCall('/dsh-quake-alert/feed')
    assert(JSON.parse(feedRes.body).cursor === feedPayload.cursor, '省略 since 时同样按 tail 处理（游标不变、不回历史）')
    // 0.3.2：Client 首次启动的 tail 语义，以及 Host 重启 / 时钟回拨的 reset 标记
    feedCall('/dsh-quake-alert/feed?since=tail')
    const tailPayload = JSON.parse(feedRes.body)
    assert(tailPayload.tail === true && tailPayload.entries.length === 0 && tailPayload.cursor === feedPayload.cursor,
      '?since=tail 只回当前位置、不回条目（Client 首次启动用）')
    feedCall('/dsh-quake-alert/feed?since=' + (feedPayload.cursor + 1))
    assert(JSON.parse(feedRes.body).reset === true, 'since > cursor（Host 重启 / 时钟回拨）→ reset 标记')
    // 非法游标一律按 tail：若按 0 处理，等于让任何请求者一次把整个环缓冲拿走
    feedCall('/dsh-quake-alert/feed?since=1e999')
    assert(JSON.parse(feedRes.body).tail === true, 'Infinity（1e999）按 tail 处理，不吐出全部缓冲')
    feedCall('/dsh-quake-alert/feed?since=-1')
    assert(JSON.parse(feedRes.body).tail === true, '负数 since 同样按 tail 处理')
    // Number('') 与 Number('   ') 都是 0：空串必须显式排掉，否则 ?since= 会被当成"从 0 取"
    feedCall('/dsh-quake-alert/feed?since=')
    assert(JSON.parse(feedRes.body).tail === true, '空 since 按 tail 处理（不被 Number("") = 0 蒙混过去）')
    feedCall('/dsh-quake-alert/feed?since=%20')
    assert(JSON.parse(feedRes.body).tail === true, '纯空白 since 同样按 tail 处理')

    // 单次响应条目上限（本路由无来源校验，这是唯一限制"一次能拿走多少"的地方）
    const { capFeedEntries, MAX_FEED_ENTRIES } = mod
    const bigPayload = { cursor: 500, entries: Array.from({ length: MAX_FEED_ENTRIES + 3 }, (_, i) => ({ seq: i + 1, id: 'e' + i })) }
    capFeedEntries(bigPayload)
    assert(bigPayload.entries.length === MAX_FEED_ENTRIES && bigPayload.more === true,
      '过大的增量被截断为 ' + MAX_FEED_ENTRIES + ' 条并标记 more')
    const smallPayload = { cursor: 2, entries: [{ seq: 1, id: 'a' }] }
    capFeedEntries(smallPayload)
    assert(smallPayload.more === undefined && smallPayload.entries.length === 1, '正常增量不受截断影响')
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
    const { createPoller, parseAtomEntries, createFetchText } = await import(pathToFileURL(path.join(ROOT, 'lib', 'poller.js')).href)
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
    const p1Base = p1.snapshot(0).cursor // 0.3.2：游标以时间戳为起点，断言一律基于这个基数
    assert(p1.snapshot(0).entries.length === 0 && p1Base >= T0, '冷启动后缓冲为空、游标停在起点（时间戳基数）')

    // ③ 增量：只为新 entry 拉详情，已见过的绝不重拉
    clock += 60 * 1000
    feedXml = atom([entry(3, '2026-09-11T12:01:00Z'), entry(2, '2026-09-11T11:30:00Z'), entry(1, '2026-09-11T11:00:00Z')])
    const r2 = await p1.pollOnce()
    assert(r2.added === 1, '新一轮只处理新 entry（+1）')
    assert(f1.calls.filter((u) => u === 'detail-3').length === 1, '为新 entry 拉了一次详情')
    assert(f1.calls.filter((u) => u === 'detail-1' || u === 'detail-2').length === 0,
      '冷启动时已见过的 entry 永不重拉（気象庁「不重复获取同一文件」）')
    const snap1 = p1.snapshot(0)
    assert(snap1.cursor === p1Base + 1 && snap1.entries.length === 1 && snap1.entries[0].id === 'detail-3', '增量快照含新条目与其原文')

    // ④ feed 未变时只拉一次 feed，不碰详情
    const callsBefore = f1.calls.length
    const r3 = await p1.pollOnce()
    assert(r3.added === 0 && f1.calls.length === callsBefore + 1, 'feed 无变化时只拉 feed 本身')

    // ⑤ since 游标：只返回更新的条目
    clock += 60 * 1000
    feedXml = atom([entry(4, '2026-09-11T12:02:00Z'), entry(3, '2026-09-11T12:01:00Z')])
    await p1.pollOnce()
    assert(p1.snapshot(p1Base + 1).entries.length === 1 && p1.snapshot(p1Base + 1).entries[0].id === 'detail-4',
      'since=上一条游标 → 只返回更新的条目')
    assert(p1.snapshot(p1Base + 2).entries.length === 0, 'since=最新游标 → 返回空')
    assert(p1.snapshot(0).truncated === false, '没发生淘汰时不标记截断')

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
    const ringBase = pRing.snapshot(0).cursor
    for (const n of [41, 42]) {
      clock += 60 * 1000
      feedRotate = atom([entry(n, new Date(clock).toISOString()), entry(n - 1, new Date(clock - 60000).toISOString())])
      await pRing.pollOnce()
    }
    const snapRing = pRing.snapshot(0)
    assert(snapRing.cursor === ringBase + 2, '游标只统计真正入缓冲的条目（冷启动不计）')
    assert(snapRing.entries.length === 1 && snapRing.entries[0].id === 'detail-42', '环缓冲按 maxEntries 淘汰最旧的')
    assert(pRing.snapshot(0).truncated === true, '有条目被淘汰后从头拉取 → 标记 truncated')
    assert(pRing.snapshot(ringBase + 2).truncated === false, '游标正好等于最新 → 不标记截断')

    // ⑧ feed 拉取失败：记 error、不抛、游标不动
    const f4 = fakeFetch({})
    const p6 = createPoller({ feedUrl: FEED, fetchText: f4.fn, now: () => clock })
    const r8 = await p6.pollOnce()
    assert(r8.added === 0 && p6.stats().errors === 1 && p6.snapshot(0).cursor >= T0 && p6.snapshot(0).entries.length === 0,
      'feed 失败时记 error、不产事件、游标停在起点')

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
    // entry 取"进程启动之前"的时间：这一节只验证按需轮询本身。
    // 「启动之后发布的电文在冷启动时仍要处理」另有断言（见 0.3.2 的冷启动窗口一节）。
    const f6 = fakeFetch({ [FEED]: () => atom([entry(50, new Date(clock - 60 * 60 * 1000).toISOString())]) })
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

    // ⑬ 0.3.2：snapshot 的 tail / reset 语义（Client 游标生命周期的 Host 半边）
    let clock13 = T0
    const f13 = fakeFetch({ [FEED]: () => atom([entry(1, new Date(clock13).toISOString())]), 'detail-1': '<Report/>' })
    const p8 = createPoller({ feedUrl: FEED, fetchText: f13.fn, now: () => clock13, backfillMs: 60 * 60 * 1000, idleMs: 0 })
    await p8.pollOnce()
    assert(p8.snapshot(0).entries.length === 1, '（前置）缓冲里已有 1 条')
    const base8 = p8.snapshot(0).cursor
    assert(base8 > 0 && base8 >= T0, '游标以时间戳为起点（跨进程单调，Host 重启后不会与旧游标撞车）')
    const tailSnap = p8.snapshot(0, { tail: true })
    assert(tailSnap.tail === true && tailSnap.entries.length === 0 && tailSnap.cursor === base8,
      'snapshot(tail) 只回当前位置、不回任何条目')
    const resetSnap = p8.snapshot(base8 + 1)
    assert(resetSnap.reset === true && resetSnap.entries.length === 1,
      'since > cursor（时钟回拨等异常）→ reset 且按 0 补齐缓冲')
    assert(p8.snapshot(base8).reset === false && p8.snapshot(0).tail === false,
      'reset 只在游标倒退时为真，普通请求不带 reset / tail 标记')
    assert(p8.snapshot(0).truncated === false && resetSnap.truncated === false,
      '没发生过淘汰时不报 truncated（seq 从时间戳起算，不能拿 seq 连续编号的假设去比）')

    // ⑭ 真淘汰：maxEntries=2 却拉到 3 条 → 缺口要被报出来
    let clock14 = T0
    const feed14 = () => atom([1, 2, 3].map((n) => entry(n, new Date(clock14 + n * 1000).toISOString())))
    const f14 = fakeFetch({ [FEED]: feed14, 'detail-1': '<Report/>', 'detail-2': '<Report/>', 'detail-3': '<Report/>' })
    const p9 = createPoller({ feedUrl: FEED, fetchText: f14.fn, now: () => clock14, backfillMs: 60 * 60 * 1000, idleMs: 0, maxEntries: 2 })
    await p9.pollOnce()
    const base9 = p9.snapshot(0).cursor - 2
    assert(p9.snapshot(0).entries.length === 2 && p9.snapshot(0).truncated === true,
      '环缓冲淘汰后 truncated 仍能正确报出（dropped > 0 且 from 落在缺口里）')
    assert(p9.snapshot(base9 + 2).truncated === false, '从缺口之后取值不再报 truncated')

    // ⑮ 0.3.2：冷启动只丢「进程启动之前」的历史，启动之后发布的照常处理。
    //     真正的冷启动发生在 Host 启动约 1 分钟后（首轮被按需轮询 skip，要等 Client 首次读 /feed），
    //     旧实现把那一轮看到的一切都当历史 → 启动后新发布的真实警报被永久记为已见。
    const f15 = fakeFetch({
      [FEED]: () => atom([
        entry(60, new Date(T0 - 60 * 60 * 1000).toISOString()),
        entry(61, new Date(T0 + 90 * 1000).toISOString()),
      ]),
      'detail-60': '<Report/>', 'detail-61': '<Report/>',
    })
    const p15 = createPoller({ feedUrl: FEED, fetchText: f15.fn, now: () => T0 + 90 * 1000, startedAt: T0 })
    const r15 = await p15.pollOnce()
    assert(r15.added === 1 && p15.snapshot(0).entries[0].id === 'detail-61',
      '冷启动：进程启动之后发布的电文照常处理（旧实现会当历史永久丢掉）')
    assert(f15.calls.indexOf('detail-60') === -1, '冷启动：启动之前的历史仍然只记已见、不拉详情')

    // ⑮' 时钟容差：启动前 1 分钟发布的仍在窗口内（避免启动瞬间的边界丢失），
    //     启动前 10 分钟的历史仍然跳过（不刷屏）
    const f15b = fakeFetch({ [FEED]: () => atom([entry(62, new Date(T0 - 60 * 1000).toISOString())]), 'detail-62': '<Report/>' })
    const p15b = createPoller({ feedUrl: FEED, fetchText: f15b.fn, now: () => T0, startedAt: T0 })
    assert((await p15b.pollOnce()).added === 1, '启动前 1 分钟发布的电文仍在容差内 → 处理')
    const f15c = fakeFetch({ [FEED]: () => atom([entry(63, new Date(T0 - 10 * 60 * 1000).toISOString())]), 'detail-63': '<Report/>' })
    const p15c = createPoller({ feedUrl: FEED, fetchText: f15c.fn, now: () => T0, startedAt: T0 })
    assert((await p15c.pollOnce()).added === 0, '启动前 10 分钟的历史仍然跳过（容差没有放大成刷屏）')

    // ⑯ 0.3.2：默认抓取实现的超时信号与响应体上限
    const realFetch = globalThis.fetch
    let seenInit = null
    globalThis.fetch = async (url, init) => {
      seenInit = init
      return { ok: true, status: 200, text: async () => 'x'.repeat(64) }
    }
    try {
      const ft = createFetchText({ maxBodyBytes: 10, timeoutMs: 1234 })
      let msg = ''
      try { await ft('https://example.test/big') } catch (e) { msg = e.message }
      assert(msg.indexOf('过大') !== -1, '响应体超过上限 → 抛错（不把内存吃满）')
      assert(seenInit && seenInit.signal !== undefined, '默认请求带上超时信号（对端挂起不会把轮询拖停）')
      const ft2 = createFetchText({ maxBodyBytes: 1024, timeoutMs: 1234 })
      assert((await ft2('https://example.test/ok')) === 'x'.repeat(64), '上限内的响应正常返回')
      globalThis.fetch = async () => ({ ok: false, status: 503, text: async () => '' })
      let msg2 = ''
      try { await ft2('https://example.test/bad') } catch (e) { msg2 = e.message }
      assert(msg2.indexOf('503') !== -1, '非 2xx 仍然抛错（原有行为不变）')
    } finally {
      globalThis.fetch = realFetch
    }
  } catch (e) {
    assert(false, 'Host 轮询器验证失败：' + e.message)
  }

  console.log('== 0.4.0：Host 侧全球源（USGS 单级 / NOAA 两级）==')
  try {
    const pollerMod = await import(pathToFileURL(path.join(ROOT, 'lib', 'poller.js')).href)
    const gs = await import(pathToFileURL(path.join(ROOT, 'lib', 'global-sources.js')).href)
    const { createPoller } = pollerMod
    const { parseUsgsEntries, parseNoaaEntries, USGS_FEED_URL, NOAA_FEED_URL } = gs

    // ① USGS：GeoJSON → entry（单级，entry 自带 payload）
    const usgsText = fs.readFileSync(path.join(ROOT, 'samples', 'global', 'usgs-all-hour.geojson'), 'utf8')
    const usgsEntries = parseUsgsEntries(usgsText)
    assert(usgsEntries.length >= 3, 'USGS feed → 解析出 ' + usgsEntries.length + ' 条 entry')
    assert(usgsEntries.every((e) => e.id && e.payload && e.updated), 'USGS entry 自带 id / payload / updated')
    assert(parseUsgsEntries('not json').length === 0 && parseUsgsEntries('{}').length === 0,
      'USGS → 非 JSON / 空对象返回空数组')
    assert(USGS_FEED_URL.indexOf('earthquake.usgs.gov') !== -1, 'USGS feed 常量指向官方域名')

    const callsU = []
    const clockU = Date.parse('2026-09-12T03:00:00Z')
    const pUsgs = createPoller({
      feedUrl: USGS_FEED_URL, parseFeed: parseUsgsEntries, singleStage: true,
      fetchText: async (url) => { callsU.push(url); return usgsText },
      now: () => clockU, idleMs: 0, startedAt: clockU - 25 * 3600 * 1000,
    })
    await pUsgs.pollOnce()
    assert(callsU.length === 1, 'USGS 单级源只请求 1 次（不拉详情）')
    const snapU = pUsgs.snapshot(0)
    assert(snapU.entries.length === usgsEntries.length, 'USGS 条目全部进入环缓冲')
    assert(snapU.entries[0].xml.indexOf('"mag"') !== -1, 'USGS 缓冲里存的是 feature 的 JSON 正文')
    assert(pUsgs.stats().detailsFetched === 0, 'USGS 不增加详情抓取计数')

    // ② NOAA：Atom → entry（详情 URL 在 link 里，不是 urn:uuid 形式的 id）
    const noaaText = fs.readFileSync(path.join(ROOT, 'samples', 'global', 'noaa-pheb-atom.xml'), 'utf8')
    const noaaEntries = parseNoaaEntries(noaaText)
    assert(noaaEntries.length === 1, 'NOAA 事件列表 → 1 条 entry')
    assert(noaaEntries[0].detailUrl.indexOf('PHEBCAP.xml') !== -1,
      'NOAA → 详情 URL 取自 link[title=CapXML document]（entry 的 id 是 urn:uuid，不是地址）')
    assert(noaaEntries[0].id === noaaEntries[0].detailUrl, 'NOAA → 去重键用详情 URL（修订即换 URL，符合不重拉原则）')
    assert(parseNoaaEntries('<feed></feed>').length === 0, 'NOAA → 空 feed 返回空数组')
    assert(parseNoaaEntries('<entry><title>x</title><id>urn:uuid:1</id></entry>').length === 0,
      'NOAA → 没有 CAP 链接的条目被跳过')

    const callsN = []
    const clockN = Date.parse('2026-08-22T09:00:00Z')
    const pNoaa = createPoller({
      feedUrl: NOAA_FEED_URL, parseFeed: parseNoaaEntries,
      fetchText: async (url) => { callsN.push(url); return url.indexOf('Atom') !== -1 ? noaaText : '<alert>cap</alert>' },
      now: () => clockN, idleMs: 0, startedAt: clockN - 3600 * 1000,
    })
    await pNoaa.pollOnce()
    assert(callsN.length === 2, 'NOAA 两级源请求 2 次（事件列表 + CAP 详情）')
    assert(pNoaa.snapshot(0).entries[0].xml === '<alert>cap</alert>', 'NOAA 缓冲里存的是 CAP 原文')
    assert(NOAA_FEED_URL.indexOf('tsunami.gov') !== -1, 'NOAA feed 常量指向 tsunami.gov')

    // ③ 多源并存：各源独立缓冲，互不影响（一个源被限流不能拖住另一个）
    assert(pUsgs.snapshot(0).entries.length !== pNoaa.snapshot(0).entries.length ||
      pUsgs.snapshot(0).cursor !== pNoaa.snapshot(0).cursor, '两个源的缓冲 / 游标互相独立')
    const hostMod = await import(pathToFileURL(path.join(ROOT, 'lib', 'index.js')).href)
    assert(hostMod.FEED_PATH === '/dsh-quake-alert/feed', 'FEED_PATH 未变（旧版 Client 不带 source 参数仍可用）')
    assert(typeof hostMod.apply === 'function', 'lib/index.js 仍导出 apply')
  } catch (err) {
    assert(false, 'Host 全球源验证失败：' + err.message)
  }

  console.log('== 0.4.0：/feed 多源分派（不触网）==')
  try {
    const hostMod = await import(pathToFileURL(path.join(ROOT, 'lib', 'index.js')).href)
    const routes = []
    // 假 ctx：顶层 effect（poller.start）**故意不执行**，否则轮询器会在测试里真的发外部请求；
    // webServer 的 effect 必须执行，路由才注册得上。
    const fakeCtx = {
      effect() { return () => {} },
      inject(names, cb) {
        if (names.indexOf('settings') !== -1) cb({ settings: { register() {} } })
        else if (names.indexOf('webServer') !== -1) {
          cb({ effect(fn) { fn() }, webServer: { register(r) { routes.push(r) } } })
        }
      },
    }
    hostMod.apply(fakeCtx)
    const feedRoute = routes.filter((r) => r.path === hostMod.FEED_PATH)[0]
    assert(!!feedRoute, 'apply 注册了 /feed 路由')
    assert(!!routes.filter((r) => r.path === hostMod.AREAS_PATH)[0], 'apply 注册了 /areas 路由')

    const call = (query) => {
      let body = ''
      feedRoute.handler({ url: '/dsh-quake-alert/feed' + query }, { writeHead() {}, end(s) { body = s } })
      return JSON.parse(body)
    }
    assert(call('?since=tail').source === 'jma', '不带 source 参数 → 默认 jma（旧版 Client 仍兼容）')
    assert(call('?since=tail').tail === true, 'since=tail → 只对齐位置、不回历史')
    assert(call('?source=usgs&since=tail').source === 'usgs', '?source=usgs 分派到 USGS 轮询器')
    assert(call('?source=noaa&since=tail').source === 'noaa', '?source=noaa 分派到 NOAA 轮询器')
    assert(call('?source=constructor&since=tail').source === 'jma',
      '原型链键（constructor）退回默认源，不发生 TypeError')
    assert(call('?source=%3BDROP&since=tail').source === 'jma', '未知 source 退回默认源')
    const empty = call('?source=usgs&since=0')
    assert(Array.isArray(empty.entries) && empty.reset === false, '各源在未启动时也能安全返回空增量')
  } catch (err) {
    assert(false, '/feed 分派验证失败：' + err.message)
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

  console.log('== 0.3.4：旧格式 / 报知电文的级别识别（特別警報漏报修复）==')
  try {
    const citiesMod = await import(pathToFileURL(path.join(ROOT, 'lib', 'data', 'cities.js')).href)
    const t = loadClient().__test
    t.setCityTable(citiesMod.CITIES_BY_PREF)
    const jma = (n) => fs.readFileSync(path.join(ROOT, 'samples', n), 'utf8')
    const cfg = () => ({
      watch: { prefectures: [], cities: [] },
      disasters: { earthquake: true, tsunami: true, weather: true },
      thresholds: {}, dedupe: { windowMinutes: 10 }, notify: {}, quietHours: { enabled: false },
    })

    // 2026-09-07 東京都「大雨特別警報」的三份格式副本 + 一条解除报知（均为真实电文）
    const s53 = t.parseJma(jma('jma-vpww53-tokyo-special-20260907.xml'), { id: 'https://x/20260907135754_0_VPWW53_130000.xml' })
    const s54 = t.parseJma(jma('jma-vpww54-tokyo-special-20260907.xml'), { id: 'https://x/20260907135754_0_VPWW54_130000.xml' })
    const s50 = t.parseJma(jma('jma-vpno50-tokyo-special-20260907.xml'), { id: 'https://x/20260907135752_0_VPNO50_130000.xml' })
    assert(s53 && s53.level === 5 && s53.severity === 'red',
      'VPWW53 旧格式「大雨特別警報」→ L5 / red（修复前整体丢弃、该事件完全静默）')
    assert(s54 && s54.level === 5, 'VPWW54（Ｈ２７）同一警报 → L5')
    assert(s50 && s50.level === 5, 'VPNO50 気象特別警報報知 → L5')
    assert(s53.regions.some((r) => r.pref === '東京都'), '特別警報展开出東京都（市町村按区域码前两位判县）')
    assert(t.matchAlert(s53, cfg()).hit === true, 'L5 特別警報 → 命中播报')
    assert(s53.eventKey === s54.eventKey && s54.eventKey === s50.eventKey,
      '三份格式副本归并为同一事件键（否则同一条警报连响三次）')
    assert(t.isEventRepeat(s53, 10) === false && t.isEventRepeat(s54, 10) === true && t.isEventRepeat(s50, 10) === true,
      '副本先后到达时只有第一条播报，其余按同事件重复只记历史')

    const cxl = t.parseJma(jma('jma-vpno50-tokyo-cancel-20260907.xml'), { id: 'https://x/20260907190104_0_VPNO50_130000.xml' })
    assert(cxl && cxl.cancelled === true && cxl.level === 0,
      'VPNO50 解除报知 → cancelled=true 且 level=0（不被「気象特別警報報知」标题兜底误抬成 L5）')
    assert(cxl.kindLabel.indexOf('已解除') !== -1, '解除报知 → 标签标注已解除')

    const legacyXml = (kindName, text) => '<?xml version="1.0"?><Report><Control>' +
      '<Title>気象特別警報・警報・注意報</Title><DateTime>2026-09-12T00:00:00Z</DateTime></Control>' +
      '<Head xmlns="http://xml.kishou.go.jp/jmaxml1/informationBasis1/">' +
      '<Title>東京都' + (text || '') + '</Title><ReportDateTime>2026-09-12T09:00:00+09:00</ReportDateTime>' +
      '<Headline><Text>' + (text || '東京都では、大雨に警戒してください。') + '</Text>' +
      '<Information type="気象警報・注意報（府県予報区等）"><Item>' +
      '<Kind><Name>' + kindName + '</Name><Code>03</Code><Status>発表</Status></Kind>' +
      '<Areas codeType="気象情報／府県予報区・細分区域等"><Area><Name>東京都</Name><Code>130000</Code></Area></Areas>' +
      '</Item></Information></Headline></Head><Body/></Report>'
    const l3 = t.parseJma(legacyXml('大雨警報'), { id: 'https://x/20260912000000_0_VPWW53_130000.xml' })
    assert(l3 && l3.level === 3,
      '旧格式「大雨警報」→ L3（此前同样被整体丢弃，L3 入历史与侧边栏提示因此缺失）')
    assert(t.parseJma(legacyXml('大雨注意報'), { id: 'https://x/20260912000001_0_VPWW53_130000.xml' }) === null,
      '旧格式「大雨注意報」→ 仍不产生 Alert（同一份注意報有 VPWW53 / Ｈ２７ 两份副本，抬升会把历史刷屏）')
  } catch (e) {
    assert(false, '旧格式电文解析验证失败：' + e.message)
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

  console.log('== 0.4.0：全球源的坐标匹配（震中距 + 震级阈值）==')
  try {
    const t = loadClient().__test
    const cfgWith = (places, mag) => ({
      watch: { prefectures: [], cities: [], places },
      disasters: { earthquake: true, tsunami: true, weather: true },
      thresholds: { globalMagnitude: mag === undefined ? 4.5 : mag },
      dedupe: { windowMinutes: 10 }, notify: {}, quietHours: { enabled: false },
    })
    const tokyo = { name: '东京', lat: 35.6812, lon: 139.7671, radiusKm: 300 }

    // ① Haversine：用已知城市对校验量级（东京—大阪约 400km，东京—札幌约 830km）
    const dOsaka = t.distanceKm(35.6812, 139.7671, 34.6937, 135.5023)
    assert(Math.abs(dOsaka - 400) < 25, '东京→大阪距离约 400km（实测 ' + Math.round(dOsaka) + 'km）')
    const dSapporo = t.distanceKm(35.6812, 139.7671, 43.0618, 141.3545)
    assert(Math.abs(dSapporo - 830) < 40, '东京→札幌距离约 830km（实测 ' + Math.round(dSapporo) + 'km）')
    assert(t.distanceKm(35.6812, 139.7671, 35.6812, 139.7671) === 0, '同点距离为 0')

    // ② 坐标合法性：-200 是 P2PQuake/部分源表示「未知」的哨兵值，必须挡下
    assert(t.validGeo({ lat: -200, lon: -200 }) === false, '哨兵坐标 -200 判为不可用')
    assert(t.validGeo({ lat: NaN, lon: 139 }) === false, 'NaN 判为不可用')
    assert(t.validGeo({ lat: 91, lon: 0 }) === false, '越界纬度判为不可用')
    assert(t.validGeo({ lat: 35.68, lon: 139.77 }) === true, '正常坐标判为可用')

    const point = (lat, lon, mag) => ({
      id: 'emsc-1', code: 'emsc', kind: 'quake', kindLabel: '地震（EMSC）', severity: 'orange',
      issued: '', headline: '', maxScale: -1, level: 0, locator: 'point', source: 'emsc',
      geo: { lat, lon }, magnitude: mag, hypo: { name: '', magnitude: mag },
      regions: [], eventKey: '', strength: mag, cancelled: false,
    })

    // ③ 半径内命中 / 半径外不命中 / 震级不足
    const near = point(35.0, 140.0, 5.2) // 距东京约 90km
    const m1 = t.matchPointAlert(near, cfgWith([tokyo]))
    assert(m1.hit === true && m1.place.name === '东京' && m1.distanceKm < tokyo.radiusKm,
      '震中在关注点半径内 → 命中（距东京 ' + Math.round(m1.distanceKm) + 'km）')
    const far = point(43.0618, 141.3545, 6.0) // 札幌，距东京约 830km
    const m2 = t.matchPointAlert(far, cfgWith([tokyo]))
    assert(m2.hit === false && m2.reason.indexOf('超过设定半径') !== -1, '震中在半径外 → 不命中，原因写明超出半径')
    const weak = point(35.0, 140.0, 4.4)
    const m3 = t.matchPointAlert(weak, cfgWith([tokyo]))
    assert(m3.hit === false && m3.reason.indexOf('低于全球震级阈值') !== -1, '震级低于阈值 → 不命中')
    assert(t.matchPointAlert(point(35.0, 140.0, 4.5), cfgWith([tokyo])).hit === true, '震级恰好等于阈值 → 命中')

    // ④ 没配关注点 / 坐标缺失：如实说明，不能默默放行（那会让"配错了"看起来像"没有地震"）
    const m4 = t.matchPointAlert(near, cfgWith([]))
    assert(m4.hit === false && m4.reason.indexOf('未设置全球关注点') !== -1, '未设置全球关注点 → 不命中并提示去哪配')
    const m5 = t.matchPointAlert(Object.assign({}, near, { geo: null }), cfgWith([tokyo]))
    assert(m5.hit === false && m5.reason.indexOf('未携带可用坐标') !== -1, '坐标缺失 → 不命中并说明原因')

    // ⑤ 多关注点：任一命中即可，且报出最近的那个
    const osaka = { name: '大阪', lat: 34.6937, lon: 135.5023, radiusKm: 100 }
    const m6 = t.matchPointAlert(point(34.7, 135.5, 5.0), cfgWith([tokyo, osaka]))
    assert(m6.hit === true && m6.place.name === '大阪', '多个关注点时任一点命中即提醒')

    // ⑥ matchAlert 应按 locator 分派：point 型走坐标，area 型仍走行政区
    const pointCfg = cfgWith([tokyo])
    assert(t.matchAlert(point(35.0, 140.0, 5.5), pointCfg).hit === true, 'matchAlert → point 型地震走坐标匹配')
    const quakeArea = loadClient().__test.parse(JSON.parse(fs.readFileSync(
      path.join(ROOT, 'samples', 'quake-kumamoto-detailscale-20260907.json'), 'utf8')))
    assert(t.matchAlert(quakeArea, pointCfg).hit === false,
      'matchAlert → 日本行政区型地震不受全球关注点影响（未关注熊本県）')
    const jpCfg = cfgWith([])
    jpCfg.watch.prefectures = ['熊本県']
    jpCfg.thresholds.quakeScale = 30 // 样本最大震度3；行政区模式的阈值是震度，与全球震级是两套旋钮
    assert(t.matchAlert(quakeArea, jpCfg).hit === true, 'matchAlert → 行政区模式仍然照旧工作（震度阈值那套）')

    // ⑦ places 归一化：脏数据不能进配置，重复点合并，半径夹取，数量封顶
    const dirty = [
      { name: '东京', lat: 35.6812, lon: 139.7671, radiusKm: 300 },
      { name: '重复的东京', lat: 35.6812, lon: 139.7671, radiusKm: 500 },
      { name: '缺索引', lat: 'abc', lon: 139 },
      { name: '越界', lat: 99, lon: 200 },
      null, 'oops',
      { name: '', lat: 34.69, lon: 135.5, radiusKm: 99999 },
    ]
    const places = t.normalizePlaces(dirty)
    assert(places.length === 2, '脏数据被过滤、重复点合并（7 项 → 2 项）')
    assert(places[0].name === '东京' && places[1].name === '34.69, 135.50', '缺名字时用坐标生成默认名')
    assert(places[1].radiusKm === 2000, '半径超上限被夹到 2000km')
    assert(t.normalizePlaces(new Array(30).fill(0).map((_, i) => ({ lat: i, lon: 0, radiusKm: 100 }))).length === 20,
      '关注点数量封顶 20 个')
  } catch (e) {
    assert(false, '坐标匹配验证失败：' + e.message)
  }

  console.log('== 0.4.0：全球源解析（EMSC / USGS / NOAA CAP）==')
  try {
    const t = loadClient().__test
    const gf = (n) => fs.readFileSync(path.join(ROOT, 'samples', 'global', n), 'utf8')

    // ① EMSC：顶层 { action, data }，data 是 GeoJSON **Feature**（不是 FeatureCollection）
    const e = t.parseEmsc(JSON.parse(gf('emsc-ws-sample.json')))
    assert(e && e.kind === 'quake' && e.source === 'emsc' && e.locator === 'point', 'EMSC → 坐标型地震 Alert')
    assert(e.geo.lat === 37.9921 && e.geo.lon === 22.2789, 'EMSC → 从 properties.lat/lon 取到震中')
    assert(e.magnitude === 3.3 && e.magType === 'ml', 'EMSC → 震级 3.3 / 震级类型 ml')
    assert(e.regions.length === 0, 'EMSC → 没有行政区区域（flynn_region 只作显示）')
    assert(e.headline.indexOf('SOUTHERN GREECE') !== -1, 'EMSC → headline 用 flynn_region（该源没有 region 字段）')
    assert(e.eventKey === 'geo:2026-09-12T02:15@38.0,22.3', 'EMSC → 跨源事件键 = 分钟 + 震中（0.1 度）')
    assert(t.parseEmsc({ action: 'delete' }) === null, 'EMSC → 没有 data 的消息返回 null')
    assert(t.parseEmsc(null) === null && t.parseEmsc('x') === null, 'EMSC → 脏输入不抛错')

    // ② USGS：FeatureCollection，geometry.coordinates = [经度, 纬度, 深度km]
    const us = t.parseUsgsFeed(JSON.parse(gf('usgs-all-hour.geojson')))
    assert(us.length >= 3, 'USGS → 解析出 ' + us.length + ' 条事件')
    const u0 = us[0]
    assert(u0.kind === 'quake' && u0.source === 'usgs' && u0.locator === 'point', 'USGS → 坐标型地震 Alert')
    assert(Math.abs(u0.geo.lat) <= 90 && Math.abs(u0.geo.lon) <= 180 && typeof u0.geo.lat === 'number',
      'USGS → 经纬度没写反（coordinates 顺序是 lon,lat）')
    assert(u0.issued.indexOf('T') !== -1 && u0.issued.indexOf('Z') !== -1, 'USGS → epoch 毫秒已转成 ISO 字符串')
    assert(us.every((a) => a.regions.length === 0), 'USGS → 全部没有行政区区域')
    assert(t.parseUsgsFeed({}).length === 0 && t.parseUsgsFeed(null).length === 0, 'USGS → 空 / 脏输入返回空数组')

    // 两个全球源对同一场地震 → 同一个事件键（否则接了第二个源就会响两次）
    const sameTime = '2026-09-12T02:15:12.43Z'
    const emscTwin = t.parseEmsc({ data: { properties: { mag: 3.3, lat: 37.99, lon: 22.27, time: sameTime } } })
    const usgsTwin = t.parseUsgsFeature({ id: 'x', geometry: { coordinates: [22.28, 37.99, 10] }, properties: { mag: 3.4, time: Date.parse(sameTime) } })
    assert(emscTwin.eventKey === usgsTwin.eventKey, 'EMSC 与 USGS 对同一场地震给出同一个事件键（跨源归并）')

    // ③ NOAA CAP：海啸；位置在 area.circle（"纬,经 半径"），震级在 parameter 里
    const n = t.parseNoaaCap(gf('noaa-pheb-cap.xml'), { id: 'e1' })
    assert(n && n.kind === 'tsunami' && n.source === 'noaa' && n.locator === 'point', 'NOAA CAP → 坐标型海啸 Alert')
    assert(n.cancelled === false, 'NOAA CAP → msgType=Alert 不是解除')
    assert(n.geo.lat === -60.481 && n.geo.lon === -47.185, 'NOAA CAP → 从 area.circle 取到震中')
    assert(n.magnitude === 6.7 && n.magType === 'Mwp', 'NOAA CAP → 从 parameter 取到前震震级与类型')
    assert(n.eventKey === 'noaa:PHEB-26234000', 'NOAA CAP → 事件键去掉消息版本号（同一事件多版归并）')
    assert(n.kindLabel.indexOf('海啸信息') !== -1 && n.severity === 'info',
      'NOAA CAP → Tsunami Information 映射为海啸信息 / info（不是警报）')
    const cancelCap = '<?xml version="1.0"?><alert><identifier>PHEB-2-26234000</identifier>' +
      '<msgType>Cancel</msgType><info><event>Tsunami Warning</event><headline>PTWC TSUNAMI WARNING</headline>' +
      '<area><areaDesc>COASTAL AREAS</areaDesc><circle>10.5,20.5 0.0</circle></area></info></alert>'
    const nc = t.parseNoaaCap(cancelCap, {})
    assert(nc && nc.cancelled === true && nc.kindLabel.indexOf('已解除') !== -1, 'NOAA CAP → msgType=Cancel 判为解除、标签标注已解除')
    assert(nc.eventKey === 'noaa:PHEB-26234000', 'NOAA CAP → 解除与发布归并到同一个事件键（取消链路才找得到原事件）')
    assert(t.parseNoaaCap('not xml', {}) === null, 'NOAA CAP → 非 CAP 文本返回 null')
    assert(t.parseUsgsFeed([{ properties: { mag: 5 } }]).length === 0, 'USGS → 非 FeatureCollection 输入返回空数组')

    // ④ 端到端：全球源 Alert 走坐标匹配，震级阈值独立于日本的震度阈值
    const gcfg = {
      watch: { prefectures: [], cities: [], places: [{ name: '雅典', lat: 37.98, lon: 23.73, radiusKm: 500 }] },
      disasters: { earthquake: true, tsunami: true, weather: true },
      thresholds: { globalMagnitude: 3.0 }, dedupe: { windowMinutes: 10 }, notify: {}, quietHours: { enabled: false },
    }
    const dAthens = Math.round(t.distanceKm(37.9921, 22.2789, 37.98, 23.73))
    assert(t.matchAlert(e, gcfg).hit === true, '端到端：EMSC M3.3 命中雅典关注点（距 ' + dAthens + 'km）')
    const strict = JSON.parse(JSON.stringify(gcfg))
    strict.thresholds.globalMagnitude = 4.5
    assert(t.matchAlert(e, strict).hit === false, '端到端：M3.3 低于默认全球阈值 M4.5 → 不打扰')
    const tsunamiCfg = JSON.parse(JSON.stringify(gcfg))
    tsunamiCfg.watch.places = [{ name: ' Scotia 海', lat: -60.48, lon: -47.19, radiusKm: 300 }]
    assert(t.matchAlert(n, tsunamiCfg).hit === true, '端到端：NOAA 海啸信息命中 Scotia 海关注点')
    assert(t.matchAlert(n, JSON.parse(JSON.stringify(gcfg))).hit === false, '端到端：海啸没命中任何关注点 → 不提醒')
  } catch (err) {
    assert(false, '全球源解析验证失败：' + err.message)
  }

  console.log('== 0.4.0：多源连接状态与全球链路装配 ==')
  try {
    // ① 多源状态聚合：任一源异常，整体就不该显示成"一切正常"
    const sockets = []
    class FakeWS {
      constructor(url) { this.url = url; sockets.push(this) }
      close() {}
    }
    const ex = loadClientEx({}, { window: { WebSocket: FakeWS } }).exports
    const t = ex.__test
    const jp = t.createWsClient({ sourceId: 'p2pquake', label: 'P2PQuake' })
    jp.start()
    sockets[0].onopen()
    assert(t.store.sources.p2pquake.status === 'open', '日本源连上 → 该源状态 open')
    assert(t.store.status === 'open', '只有一个源时聚合状态 = open')

    const emscSeen = []
    const emsc = t.createWsClient({
      sourceId: 'emsc', label: 'EMSC',
      urlOf: () => 'wss://emsc.test/ws',
      staleAfterMs: 0,
      onRaw: (raw, cfg) => { const a = t.parseEmsc(raw); if (a) { emscSeen.push(a); t.handleAlert(a, cfg) } },
    })
    emsc.start()
    const emscSock = sockets[sockets.length - 1]
    assert(emscSock.url === 'wss://emsc.test/ws', '全球源使用注入的地址（与日本源各自独立连接）')
    emscSock.onopen()
    assert(t.store.status === 'open', '两个源都连上 → 聚合仍为 open')
    assert(t.store.detail.indexOf('EMSC') !== -1 && t.store.detail.indexOf('P2PQuake') !== -1,
      '聚合详情逐个列出源（悬停时能看出是哪条链路）')

    // 消息经注入的 onRaw 走完整链路（parseEmsc → handleAlert）
    const placesCfg = {
      watch: { prefectures: [], cities: [], places: [{ name: '雅典', lat: 37.98, lon: 23.73, radiusKm: 500 }] },
      disasters: { earthquake: true, tsunami: true, weather: true },
      thresholds: { globalMagnitude: 3 }, dedupe: { windowMinutes: 10 },
      notify: { sound: false, system: false, volume: 0 }, quietHours: { enabled: false },
    }
    ex.__test.applyCfg(placesCfg) // onRaw 内部读 currentCfg()
    emscSock.onmessage({ data: fs.readFileSync(path.join(ROOT, 'samples', 'global', 'emsc-ws-sample.json'), 'utf8') })
    assert(emscSeen.length === 1 && emscSeen[0].source === 'emsc', 'EMSC 推送经 parseEmsc 解析成 Alert')
    assert(t.store.events.length >= 1 && t.store.events[0].kind === 'quake', 'EMSC 命中关注点后写入历史')

    emscSock.onclose()
    assert(t.store.status === 'reconnecting', '全球源掉线 → 聚合转黄（不假装一切正常）')
    assert(t.store.sources.p2pquake.status === 'open', '掉线的只是 EMSC，日本源状态不受影响')
    emsc.stop(); jp.stop()
    assert(t.store.status === 'closed', '所有源停止 → 聚合状态为 closed')

    // ② 未配置全球关注点时，坐标型消息整条丢弃（连历史都不记）
    const t2 = loadClientEx({}, {}).exports.__test
    const emscAlert = t2.parseEmsc(JSON.parse(fs.readFileSync(path.join(ROOT, 'samples', 'global', 'emsc-ws-sample.json'), 'utf8')))
    const noPlaces = {
      watch: { prefectures: [], cities: [], places: [] },
      disasters: { earthquake: true, tsunami: true, weather: true },
      thresholds: { globalMagnitude: 3 }, dedupe: { windowMinutes: 10 },
      notify: { sound: false, system: false, volume: 0 }, quietHours: { enabled: false },
    }
    assert(t2.watchlessPoint(emscAlert, noPlaces) === true, '未配置关注点 → 坐标型消息判为应丢弃')
    assert(t2.watchlessPoint(t2.parse(JSON.parse(fs.readFileSync(
      path.join(ROOT, 'samples', 'quake-kumamoto-detailscale-20260907.json'), 'utf8'))), noPlaces) === false,
      '日本行政区型消息不受这条过滤影响')
    const before = t2.store.events.length
    const r = t2.handleAlert(emscAlert, noPlaces)
    assert(r.notified === false && r.reason === 'no-watch-point', 'handleAlert → 返回 no-watch-point')
    assert(t2.store.events.length === before, '未配置关注点时不写历史（否则历史会被全球地震刷屏）')
    assert(t2.store.received === 0, '未配置关注点时不计入接收计数')
    const withPlaces = JSON.parse(JSON.stringify(noPlaces))
    withPlaces.watch.places = [{ name: '雅典', lat: 37.98, lon: 23.73, radiusKm: 500 }]
    const r2 = t2.handleAlert(emscAlert, withPlaces)
    assert(r2.notified === true, '配置关注点后同一条消息立即命中（不需要重连或重启）')
    assert(t2.store.events.length === before + 1 && t2.store.events[0].headline.indexOf('SOUTHERN GREECE') !== -1,
      '命中后写入历史，标题来自全球源')
  } catch (err) {
    assert(false, '多源装配验证失败：' + err.message)
  }

  console.log('== 0.4.0：全球链路的本地测试消息 + 海啸不受震级阈值限制 ==')
  try {
    const t = loadClient().__test
    const place = { name: '测试点', lat: 35.6812, lon: 139.7671, radiusKm: 300 }
    const gcfg = (mag, radius) => ({
      watch: { prefectures: [], cities: [], places: [Object.assign({}, place, { radiusKm: radius === undefined ? 300 : radius })] },
      disasters: { earthquake: true, tsunami: true, weather: true },
      thresholds: { globalMagnitude: mag === undefined ? 4.5 : mag },
      dedupe: { windowMinutes: 10 }, notify: {}, quietHours: { enabled: false },
    })
    assert(t.TEST_GEO_SCENARIOS.length === 4, '测试场景 4 个（覆盖 EMSC / USGS / NOAA 与"半径外"）')

    // 每个场景都必须经**真实解析器**得到坐标型 Alert —— 这正是测试按钮的意义：
    // 它走的是与线上完全相同的代码路径，而不是直接构造一个 Alert 绕开解析器。
    const srcs = []
    for (const sc of t.TEST_GEO_SCENARIOS) {
      const msg = t.buildTestGlobalMessage(place, 1700000000000, sc.key)
      srcs.push(msg.source)
      const a = t.parseTestGlobalMessage(msg)
      assert(!!a && a.locator === 'point' && Number.isFinite(a.geo.lat) && Number.isFinite(a.geo.lon),
        '场景 ' + sc.key + ' → 经 ' + msg.source + ' 解析器得到坐标型 Alert')
    }
    assert(srcs.join(',') === 'emsc,usgs,noaa,emsc', '四个场景覆盖三个源（远地场景复用 EMSC 格式）')

    // 前三个在半径内命中，第四个刻意落在半径外
    for (const k of ['emsc', 'usgs', 'noaa']) {
      const a = t.parseTestGlobalMessage(t.buildTestGlobalMessage(place, 1700000000001, k))
      const m = t.matchAlert(a, gcfg())
      assert(m.hit === true, '场景 ' + k + ' → 命中（距 ' + Math.round(m.distanceKm) + 'km）')
    }
    const farMsg = t.parseTestGlobalMessage(t.buildTestGlobalMessage(place, 1700000000002, 'emsc-far'))
    const mFar = t.matchAlert(farMsg, gcfg())
    assert(mFar.hit === false && mFar.reason.indexOf('超过设定半径') !== -1, '远地场景 → 半径外不命中')
    assert(t.matchAlert(farMsg, gcfg(4.5, 1500)).hit === true,
      '把半径调到 1500km → 同一条远地消息命中（证明是半径在起作用，不是消息无效）')

    // 连点两次不会被去重吞掉，且**两次都会播报**——测试事件键必须每次不同，
    // 否则第二次会被判成"同一场地震的重复发布"而静默，用户会以为按钮坏了。
    const g1 = t.parseTestGlobalMessage(t.buildTestGlobalMessage(place, 1700000000010, 'emsc'))
    const g2 = t.parseTestGlobalMessage(t.buildTestGlobalMessage(place, 1700000000011, 'emsc'))
    assert(g1.id !== g2.id && g1.eventKey !== g2.eventKey, '两次点击的 id 与事件键都不同（不会被去重吞掉）')
    assert(t.isEventRepeat(g1, 10) === false && t.isEventRepeat(g2, 10) === false,
      '连点两次都能播报（不会被事件级去重判成重复发布）')

    // 海啸不受全球震级阈值限制（本次 0.4.0 修掉的隐患）：NOAA 电文里的前震震级只是参考值，
    // 用同一个阈值卡海啸，会让"把全球阈值调到 M9 的用户"连海啸警报一起静默掉。
    const noaaTest = t.parseTestGlobalMessage(t.buildTestGlobalMessage(place, 1700000000003, 'noaa'))
    assert(t.matchAlert(noaaTest, gcfg(9)).hit === true, '海啸不受 globalMagnitude 限制（阈值 M9.0 时仍命中）')
    const quakeTest = t.parseTestGlobalMessage(t.buildTestGlobalMessage(place, 1700000000004, 'emsc'))
    assert(t.matchAlert(quakeTest, gcfg(9)).hit === false, '地震仍然受 globalMagnitude 限制（阈值 M9.0 时不命中）')
    const realCap = t.parseNoaaCap(fs.readFileSync(path.join(ROOT, 'samples', 'global', 'noaa-pheb-cap.xml'), 'utf8'), { id: 'x' })
    const capCfg = gcfg(9)
    capCfg.watch.places = [{ name: 'Scotia', lat: -60.48, lon: -47.19, radiusKm: 300 }]
    assert(t.matchAlert(realCap, capCfg).hit === true, '真实 NOAA CAP 样本在 M9.0 阈值下仍命中')
  } catch (err) {
    assert(false, '全球测试消息验证失败：' + err.message)
  }

  console.log('== 0.3.0-c：Client 电文增量拉取（游标 / 容错 / 开关）==')
  try {
    const t = loadClient().__test
    // 显式注入游标存取：0.3.2 起游标会落盘，若用默认实现，c1 写进沙箱 localStorage 的值会串到
    // c2/c3，使它们的初始游标不再是 0 —— 用例之间不该通过存储隐式耦合。
    const noStore = { loadCursor: () => 0, saveCursor: () => {} }
    const calls = []
    let payload = { cursor: 0, entries: [] }
    const seen = []
    const c1 = t.createFeedClient(Object.assign({
      fetchJson: async (url) => { calls.push(url); return payload },
      apply: (e) => { seen.push(e.id); return true },
      getCfg: () => ({ disasters: { weather: true } }),
    }, noStore))
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
    const c2 = t.createFeedClient(Object.assign({
      fetchJson: async () => { if (fail) throw new Error('boom'); return { cursor: 1, entries: [] } },
      apply: () => true, getCfg: () => ({ disasters: { weather: true } }),
    }, noStore))
    const r2 = await c2.pollOnce()
    assert(r2.applied === 0 && c2.stats().errors === 1, 'Host 不可达 → 记 error、不抛')
    fail = false
    await c2.pollOnce()
    assert(c2.stats().errors === 1, '恢复后错误计数不再增长（errors=' + c2.stats().errors + '）')
    assert(c2.cursor() === 1, '恢复后游标推进到 Host 返回值（cursor=' + c2.cursor() + '）')

    // 单条失败不影响其余条目与游标
    const applied = []
    const c3 = t.createFeedClient(Object.assign({
      fetchJson: async () => ({ cursor: 3, entries: [{ id: 'ok' }, { id: 'bad' }, { id: 'ok2' }] }),
      apply: (e) => { if (e.id === 'bad') throw new Error('parse fail'); applied.push(e.id); return true },
      getCfg: () => ({ disasters: { weather: true } }),
    }, noStore))
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

  console.log('== 0.3.2：feed 游标持久化（P2）与 Host 重启恢复（P3）==')
  try {
    const t = loadClient().__test

    // ① 首次启动（本地没有游标）→ 用 tail 对齐位置，不把 Host 缓冲里的历史当新闻重放
    const firstUrls = []
    const firstSaved = []
    let appliedFirst = 0
    const c1 = t.createFeedClient({
      fetchJson: async (url) => { firstUrls.push(url); return { cursor: 7, entries: [{ id: 'old-1' }, { id: 'old-2' }], tail: true } },
      apply: () => { appliedFirst += 1; return true },
      loadCursor: () => null, saveCursor: (v) => firstSaved.push(v),
      getCfg: () => ({ disasters: { weather: true } }),
    })
    const r1 = await c1.pollOnce()
    assert(firstUrls[0].indexOf('since=tail') !== -1, '首次启动（无游标）→ 请求 since=tail')
    assert(appliedFirst === 0 && r1.applied === 0 && r1.tail === true, 'tail 响应不应用任何条目（响应里带了也不应用）')
    assert(c1.cursor() === 7 && firstSaved.join() === '7', 'tail 对齐后立即持久化游标')
    assert(c1.hasCursor() === true, 'tail 之后不再是"没有游标"状态')

    // ①' 旧版 Host（不认 since=tail）会把整个缓冲按 0 吐回来：只对齐游标，不重放
    const legacyApplied = []
    let legacyCursor = null
    const cLegacy = t.createFeedClient({
      fetchJson: async () => ({ cursor: 7, entries: [{ id: 'old-1' }, { id: 'old-2' }] }),
      apply: (e) => { legacyApplied.push(e.id); return true },
      loadCursor: () => null, saveCursor: (v) => { legacyCursor = v },
      getCfg: () => ({ disasters: { weather: true } }),
    })
    const rLegacy = await cLegacy.pollOnce()
    assert(legacyApplied.length === 0 && rLegacy.legacyHost === true && legacyCursor === 7,
      '旧版 Host（响应没有 tail 标记）也不重放历史：只取游标对齐')

    // ② 有持久化游标（刷新 / 新标签页）→ 直接从该游标拉增量
    const secondUrls = []
    let appliedSecond = 0
    const c2 = t.createFeedClient({
      fetchJson: async (url) => { secondUrls.push(url); return { cursor: 9, entries: [{ id: 'new-1' }] } },
      apply: () => { appliedSecond += 1; return true },
      loadCursor: () => 5, saveCursor: () => {},
      getCfg: () => ({ disasters: { weather: true } }),
    })
    await c2.pollOnce()
    assert(secondUrls[0].indexOf('since=5') !== -1, '有持久化游标 → 首次请求直接带该游标（不重放）')
    assert(appliedSecond === 1 && c2.cursor() === 9, '只应用游标之后的增量')

    // ③ 端到端复现 P2：同一个"浏览器"里两次页面加载共享一个游标（模拟刷新）
    let shared = null
    const pageSeen = []
    const openPage = () => t.createFeedClient({
      // 模拟真实 Host：tail 只回位置；否则只回 seq > since 的条目
      fetchJson: async (url) => {
        if (url.indexOf('since=tail') !== -1) return { cursor: 12, entries: [{ id: 'hist' }], tail: true }
        const m = /since=(\d+)/.exec(url)
        const since = m ? Number(m[1]) : 0
        return { cursor: 12, entries: since < 12 ? [{ id: 'hist' }] : [] }
      },
      apply: (e) => { pageSeen.push(e.id); return true },
      loadCursor: () => shared, saveCursor: (v) => { shared = v },
      getCfg: () => ({ disasters: { weather: true } }),
    })
    await openPage().pollOnce() // 页面 A：首次加载
    await openPage().pollOnce() // 页面 B：模拟刷新后的第二次加载
    assert(pageSeen.length === 0, '刷新页面不重放 Host 缓冲里的历史（P2：修复前会重放并再次响铃）')
    assert(shared === 12, '两次加载后游标仍是 12（没有因为重放而前进）')

    // ③' Host 截断（more）：游标必须停在「最后一条实际返回的 seq」，不能直接跳到 cursor，
    //     否则被截断掉的条目会被静默跳过
    const moreUrls = []
    const moreSaved = []
    const cMore = t.createFeedClient({
      fetchJson: async (url) => {
        moreUrls.push(url)
        const m = /since=(\d+)/.exec(url)
        const since = m ? Number(m[1]) : 0
        return since === 0
          ? { cursor: 12, entries: [{ id: 'a', seq: 3 }, { id: 'b', seq: 4 }], more: true }
          : { cursor: 12, entries: [{ id: 'c', seq: 12 }] }
      },
      apply: () => true,
      loadCursor: () => 0, saveCursor: (v) => moreSaved.push(v),
      getCfg: () => ({ disasters: { weather: true } }),
    })
    const rMore = await cMore.pollOnce()
    assert(cMore.cursor() === 4 && rMore.more === true,
      'Host 截断（more）→ 游标停在最后一条的 seq（不跳过没拿到的条目）')
    await cMore.pollOnce()
    assert(moreUrls[1].indexOf('since=4') !== -1 && cMore.cursor() === 12,
      '下一轮从截断处继续，最终追平 cursor')

    // ④ P3：Host 重启 → 游标回退 → 本轮补齐缓冲并对齐
    const p3Applied = []
    const p3Saved = []
    const c3 = t.createFeedClient({
      fetchJson: async () => ({ cursor: 2, entries: [{ id: 'a' }, { id: 'b' }], reset: true }),
      apply: (e) => { p3Applied.push(e.id); return true },
      loadCursor: () => 37, saveCursor: (v) => p3Saved.push(v),
      getCfg: () => ({ disasters: { weather: true } }),
    })
    const r3 = await c3.pollOnce()
    assert(p3Applied.join() === 'a,b', 'Host 重启（reset）→ 本轮应用缓冲里的条目')
    assert(c3.cursor() === 2 && p3Saved.join() === '2', 'reset 后游标对齐到 Host 当前值并持久化')
    assert(r3.reset === true && c3.stats().resets === 1, 'reset 如实计数（诊断可见）')

    // ⑤ 兜底：Host 没带 reset 标记但游标明显回退 → 同样自愈，不静默失联
    const c4 = t.createFeedClient({
      fetchJson: async () => ({ cursor: 1, entries: [] }),
      apply: () => true,
      loadCursor: () => 37, saveCursor: () => {},
      getCfg: () => ({ disasters: { weather: true } }),
    })
    const r4 = await c4.pollOnce()
    assert(r4.reset === true && c4.cursor() === 1, 'Host 未标记 reset 但游标回退 → 仍然自愈')

    // ⑥ 脏游标（字符串 / 负数 / null / 对象 / 数组）→ 当作无记录，用 tail（既不重放也不卡死）
    for (const dirty of ['abc', -5, null, undefined, {}, []]) {
      const dirtyUrls = []
      const c5 = loadClientEx({ 'dsh.quakeAlert.feedCursor': JSON.stringify(dirty) }).exports.__test.createFeedClient({
        fetchJson: async (url) => { dirtyUrls.push(url); return { cursor: 0, entries: [], tail: true } },
        apply: () => true,
        getCfg: () => ({ disasters: { weather: true } }),
      })
      await c5.pollOnce()
      assert(dirtyUrls[0].indexOf('since=tail') !== -1, '脏游标 ' + JSON.stringify(dirty) + ' → 当作无记录，用 tail')
    }

    // ⑦ 真实落盘：用默认的 loadCursor / saveCursor 走一遍 localStorage
    const s7 = loadClientEx()
    const c6 = s7.exports.__test.createFeedClient({
      fetchJson: async () => ({ cursor: 4, entries: [], tail: true }),
      apply: () => true,
      getCfg: () => ({ disasters: { weather: true } }),
    })
    await c6.pollOnce()
    assert(s7.storage.get(t.FEED_CURSOR_KEY) === '4', '游标真实写入 localStorage（键 ' + t.FEED_CURSOR_KEY + '）')

    const s8 = loadClientEx({ [t.FEED_CURSOR_KEY]: 4 })
    const reloadUrls = []
    const c7 = s8.exports.__test.createFeedClient({
      fetchJson: async (url) => { reloadUrls.push(url); return { cursor: 4, entries: [] } },
      apply: () => true,
      getCfg: () => ({ disasters: { weather: true } }),
    })
    await c7.pollOnce()
    assert(reloadUrls[0].indexOf('since=4') !== -1, '重新加载后从 localStorage 读回游标（刷新不重放）')
  } catch (e) {
    assert(false, 'feed 游标持久化验证失败：' + e.message)
  }

  console.log('== 0.3.2：河川区域表端到端装配（P1）与地名假名归一（P4）==')
  try {
    const citiesMod2 = await import(pathToFileURL(path.join(ROOT, 'lib', 'data', 'cities.js')).href)
    const riverMod2 = await import(pathToFileURL(path.join(ROOT, 'lib', 'data', 'river-areas.js')).href)

    // ① 端到端装配：模拟真实 Client —— 只经 /areas 的响应装载两张表，**不手工 setRiverAreas**。
    //    这正是此前缺失的一环：旧断言直接 import 数据表后调用 setRiverAreas，绕过了
    //    "Host 是否真的把表发下来"这个唯一的断点，所以 P1 逃过了 346 项回归。
    const hostMod = await import(pathToFileURL(path.join(ROOT, 'lib', 'index.js')).href)
    const routes2 = []
    hostMod.apply({
      effect(fn) { fn(); return () => {} },
      inject(names, cb) {
        if (names.indexOf('settings') !== -1) cb({ settings: { register: () => ({}) } })
        if (names.indexOf('webServer') !== -1) {
          cb({ effect(fn) { fn(); return () => {} }, webServer: { register: (r) => { routes2.push(r); return () => {} } } })
        }
      },
    })
    const areasRoute2 = routes2.find((r) => r.path === '/dsh-quake-alert/areas')
    let rawAreas = ''
    areasRoute2.handler({}, { writeHead() {}, end(b) { rawAreas = b } })
    const areasPayload = JSON.parse(rawAreas)
    assert(areasPayload.prefectures['東京都'].join() === citiesMod2.CITIES_BY_PREF['東京都'].join(),
      '/areas 下发的市町村表与 lib/data/cities.js 一致')
    const fetchedUrls = []
    const t2 = loadClientEx(undefined, {
      window: {
        fetch: async (url) => { fetchedUrls.push(url); return { ok: true, status: 200, json: async () => areasPayload } },
      },
    }).exports.__test
    const cityTableState2 = await t2.loadCityTable()
    assert(cityTableState2 === 'ready', 'Client 仅凭 /areas 响应即装载成功（端到端装配）')
    assert(fetchedUrls.length === 1 && fetchedUrls[0] === '/dsh-quake-alert/areas', '只请求一次 /areas')
    const meguro = riverMod2.RIVER_AREAS.find((a) => a.name === '目黒川')
    assert(t2.riverAreaCities(meguro.code).length === 2,
      '河川区域表随响应到位：目黒川 → ' + t2.riverAreaCities(meguro.code).join('/'))
    assert(t2.citiesOfPref('東京都').indexOf('目黒区') !== -1, '市区町村表同时到位（東京都含目黒区）')

    // ② 两表名称一致性（P4 根因）：河川表里每个市町村都要能反查到市区町村表的规范写法
    const unresolved = []
    const seenCity = new Set()
    for (const a of riverMod2.RIVER_AREAS) {
      for (const c of a.cities) {
        if (seenCity.has(c)) continue
        seenCity.add(c)
        if (!t2.canonicalCityOf(c)) unresolved.push(c)
      }
    }
    assert(unresolved.length === 0,
      '河川表的 ' + seenCity.size + ' 个市町村全部可归一到市区町村表（未收录：' + unresolved.join('/') + '）')

    // ③ 假名归一（P4）：小写法（け/ゖ ↔ ケ/ヶ）与假名种类（あるぷす ↔ アルプス）都要等价
    assert(t2.normKana('金け崎町') === t2.normKana('金ケ崎町') && t2.normKana('金ケ崎町') === '金ヶ崎町',
      'け / ケ / ヶ 归一到同一形式（金け崎町 ↔ 金ケ崎町）')
    assert(t2.normKana('南あるぷす市') === t2.normKana('南アルプス市'), '平假名 ↔ 片假名归一（南あるぷす市 ↔ 南アルプス市）')
    assert(t2.prefsOfCity('金ケ崎町').join() === '岩手県', '河川表写法也能反查到县（金ケ崎町 → 岩手県）')
    assert(t2.prefsOfCity('南アルプス市').join() === '山梨県', '假名种类不同也能反查到县（南アルプス市 → 山梨県）')
    assert(t2.canonicalCityOf('金ケ崎町') === '金け崎町' && t2.canonicalCityOf('南アルプス市') === '南あるぷす市',
      '规范名取市区町村表的写法（用于与用户勾选的名字比对）')

    // ④ 端到端匹配：真实 12 位河川区域码 + L4（氾濫危険情報）电文
    const vxkoXml = (code, name) => '<?xml version="1.0" encoding="UTF-8"?>' +
      '<Report xmlns="http://xml.kishou.go.jp/jmaxml1/"><Control><Title>指定河川洪水予報</Title>' +
      '<DateTime>2026-09-11T11:40:00Z</DateTime></Control>' +
      '<Head xmlns="http://xml.kishou.go.jp/jmaxml1/informationBasis1/"><Title>' + name + '氾濫危険情報</Title>' +
      '<ReportDateTime>2026-09-11T20:40:00+09:00</ReportDateTime><EventID>TEST-' + code + '</EventID>' +
      '<InfoType>発表</InfoType><Serial>1</Serial>' +
      '<Headline><Text>【警戒レベル４相当情報［洪水］】' + name + 'では、氾濫危険水位に到達しています</Text>' +
      '<Information type="指定河川洪水予報（予報区域）"><Item>' +
      '<Kind><Name>氾濫危険情報</Name><Code>40</Code><Condition>洪水警報（発表）</Condition></Kind>' +
      '<Areas codeType="指定河川洪水予報（予報区域）"><Area><Name>' + name + '</Name><Code>' + code + '</Code></Area></Areas>' +
      '</Item></Information></Headline></Head><Body/></Report>'
    const cfgOf = (prefs, cities) => ({
      watch: { prefectures: prefs, cities: cities || [] },
      disasters: { earthquake: true, tsunami: true, weather: true },
      thresholds: {}, dedupe: { windowMinutes: 10 }, notify: {}, quietHours: { enabled: false },
    })
    const flood = t2.parseJma(vxkoXml(meguro.code, meguro.name), { id: 'p1-verify' })
    assert(flood && flood.level === 4, '构造的 VXKO 电文解析为警戒レベル4')
    assert(flood.regions.every((r) => r.pref === '東京都' && !!r.city), '河川区域已归到東京都的市町村（不再 prefUnknown）')
    assert(t2.matchAlert(flood, cfgOf(['北海道'])).hit === false, '关注无关县（北海道）→ 不提醒（修复前会误报）')
    assert(t2.matchAlert(flood, cfgOf(['東京都'])).hit === true, '关注对应县（東京都）→ 提醒')
    assert(t2.matchAlert(flood, cfgOf(['東京都'], ['目黒区'])).hit === true, '市级收窄命中目黒区 → 提醒')
    assert(t2.matchAlert(flood, cfgOf(['東京都'], ['札幌市'])).hit === false, '市级收窄未命中 → 不提醒（修复前收窄完全失效）')

    // ⑤ 跨表假名差异的端到端匹配：河川表「金ケ崎町」vs 市区町村表「金け崎町」
    const kin = riverMod2.RIVER_AREAS.find((a) => a.cities.indexOf('金ケ崎町') !== -1)
    assert(!!kin, '河川表里有使用「金ケ崎町」写法的区域')
    const kinAlert = t2.parseJma(vxkoXml(kin.code, kin.name), { id: 'p4-verify' })
    assert(kinAlert.regions.some((r) => r.pref === '岩手県'), '「金ケ崎町」写法归到岩手県（修复前 pref 为空）')
    assert(t2.matchAlert(kinAlert, cfgOf(['岩手県'], ['金け崎町'])).hit === true,
      '用户勾选本表写法「金け崎町」时，河川表的「金ケ崎町」也命中（修复前漏报）')
    assert(t2.matchAlert(kinAlert, cfgOf(['東京都'])).hit === false, '金ケ崎町（岩手県）不因写法差异误命中東京都')
  } catch (e) {
    assert(false, '河川区域表端到端验证失败：' + e.message)
  }

  console.log('== 0.3.2：UI 文案与配色（气象 code / severity 配色 / 标题分隔符）==')
  try {
    const t = loadClient().__test

    // 气象电文的来源标注：此前一律落到 else 分支，展开详情会标成「code 551」（地震速报）
    assert(t.p2pCodeTextOf('weather') === 'JMA 电文', '气象条目显示「JMA 电文」而不是 code 551')
    assert(t.p2pCodeTextOf('quake') === 'code 551' && t.p2pCodeTextOf('eew') === 'code 556' &&
      t.p2pCodeTextOf('tsunami') === 'code 552', 'P2PQuake 三类仍显示各自的 code')
    assert(t.p2pCodeTextOf('constructor') === '—' && t.p2pCodeTextOf(undefined) === '—',
      '未知 kind 不命中原型链，显示占位符')

    // 灾种配色：气象此前没有键，历史条目一律落到灰色兜底
    assert(typeof t.kindColorOf('weather') === 'string' && t.kindColorOf('weather') !== t.kindColorOf('未知'),
      '气象条目有专属配色（不再落灰色兜底）')

    // severity → 颜色：yellow 是默认阈值 40 下最常见的命中档，不能落进"信息蓝"
    assert(t.sevColor('yellow') === '#d9a406', 'yellow 有独立配色（震度4 命中不再显示成信息蓝）')
    assert(t.sevColor('red') === '#e5484d' && t.sevColor('orange') === '#f76b15' && t.sevColor('info') === '#3b82f6',
      '其余档位配色不变')

    // 标题：旧写法在非「各地」分支会留下悬空的「 · 」
    assert(t.alertTitleOf({ kind: 'quake', kindLabel: '地震情报·各地震度' }) === '🌐 地震情报·各地震度',
      'quake 标题直接用 kindLabel（没有悬空分隔符）')
    assert(t.alertTitleOf({ kind: 'quake', kindLabel: '地震情报' }) === '🌐 地震情报', '非「各地」分支同样干净')
    assert(t.alertTitleOf({ kind: 'weather', kindLabel: '洪水预报' }) === '🌧 洪水预报', 'weather 标题不变')
    assert(t.alertTitleOf(null) === '灾害预警', '空输入有兜底标题')
  } catch (e) {
    assert(false, 'UI 文案与配色验证失败：' + e.message)
  }

  console.log('== 0.3.2：WebSocket 半开检测 / 音频节点回收 / 城市表请求可中止 ==')
  try {
    // P7-a：久无数据 → 主动重连（半开连接不会触发 onclose）
    const socketsA = []
    class FakeWSA {
      constructor(url) { this.url = url; socketsA.push(this) }
      close() {}
    }
    const exA = loadClientEx({}, { window: { WebSocket: FakeWSA } }).exports
    const cA = exA.__test.createWsClient({ staleAfterMs: 30, staleCheckMs: 10 })
    cA.start()
    socketsA[0].onopen()
    await new Promise((r) => setTimeout(r, 90))
    assert(socketsA.length === 2, '久无数据 → 主动重连（半开连接不会触发 onclose）')
    cA.stop()

    // P7-b：持续有消息时不误判
    const socketsB = []
    class FakeWSB {
      constructor(url) { this.url = url; socketsB.push(this) }
      close() {}
    }
    const exB = loadClientEx({}, { window: { WebSocket: FakeWSB } }).exports
    const cB = exB.__test.createWsClient({ staleAfterMs: 40, staleCheckMs: 10 })
    cB.start()
    socketsB[0].onopen()
    const keep = setInterval(() => socketsB[0].onmessage({ data: '{"code":551}' }), 10)
    await new Promise((r) => setTimeout(r, 90))
    clearInterval(keep)
    assert(socketsB.length === 1, '持续有消息时不误判为半开（不重连）')
    cB.stop()

    // P12：播完 disconnect，长期运行不再累积节点
    const audioNodes = []
    class FakeAudioContext {
      constructor() { this.state = 'running'; this.currentTime = 0; this.destination = {} }
      createGain() {
        const g = {
          gain: { value: 0, setValueAtTime() {}, exponentialRampToValueAtTime() {} },
          disconnected: false, connect() {}, disconnect() { g.disconnected = true },
        }
        audioNodes.push(g)
        return g
      }
      createOscillator() {
        const o = { type: '', frequency: { value: 0 }, disconnected: false, connect() {}, start() {}, stop() {}, disconnect() { o.disconnected = true } }
        audioNodes.push(o)
        return o
      }
      resume() { return Promise.resolve() }
    }
    const exC = loadClientEx({}, { window: { AudioContext: FakeAudioContext } }).exports
    exC.__test.playSound('quake', 0.5)
    await new Promise((r) => setTimeout(r, 900))
    assert(audioNodes.length > 0 && audioNodes.every((n) => n.disconnected === true),
      '播放结束后所有音频节点都被 disconnect（共 ' + audioNodes.length + ' 个）')

    // 跨标签页配置同步：监听必须常驻，不依赖设置页是否打开
    const listeners = {}
    const sD = loadClientEx({}, {
      window: {
        addEventListener: (type, fn) => { (listeners[type] = listeners[type] || []).push(fn) },
        removeEventListener: (type, fn) => { listeners[type] = (listeners[type] || []).filter((f) => f !== fn) },
      },
    })
    const effects = []
    sD.exports.apply({
      effect(fn) { effects.push(fn()); return () => {} },
      inject() {},
      slots: { inject() {}, register() {} },
    })
    assert((listeners.storage || []).length === 1, 'apply 时建立常驻 storage 监听（与设置页是否打开无关）')
    sD.storage.set('dsh.quakeAlert.v1', JSON.stringify({ version: 1, watch: { prefectures: ['大阪府'] } }))
    ;(listeners.storage || []).forEach((fn) => fn({ key: 'dsh.quakeAlert.v1' }))
    assert(sD.exports.__test.currentCfg().watch.prefectures.join() === '大阪府',
      '另一个标签页改了配置 → 本页 runtimeCfg 立即跟随')
    effects.forEach((fn) => { try { if (typeof fn === 'function') fn() } catch (err) { /* 清理失败忽略 */ } })

    // 城市表请求可中止：停用后不再应用数据
    let resolveFetch = null
    const sE = loadClientEx({}, {
      window: {
        AbortController,
        fetch: (url, init) => new Promise((resolve, reject) => {
          resolveFetch = resolve
          if (init && init.signal && init.signal.addEventListener) {
            init.signal.addEventListener('abort', () => reject(new Error('aborted')))
          }
        }),
      },
    })
    const tE = sE.exports.__test
    const pending = tE.loadCityTable()
    tE.abortCityTableLoad()
    resolveFetch({ ok: true, status: 200, json: async () => ({ prefectures: { '東京都': ['千代田区'] } }) })
    const stateE = await pending
    assert(stateE === 'idle' && tE.citiesOfPref('東京都').length === 0,
      '插件停用中止后不应用表数据，且状态回到 idle（下次可重试）')
  } catch (e) {
    assert(false, 'WebSocket / 音频 / 城市表验证失败：' + e.message)
  }

  console.log('== 0.3.3：WebSocket 建连看门狗 ==')
  try {
    // ① 建连阶段既无 onopen 也无 onclose（浏览器半开时不给任何事件）→ 超时后放弃并重连
    const socketsKA = []
    class FakeWSA {
      constructor(url) { this.url = url; socketsKA.push(this) }
      close() { this.closed = true }
    }
    const exKA = loadClientEx({}, { window: { WebSocket: FakeWSA } }).exports
    const tKA = exKA.__test
    const cKA = tKA.createWsClient({ connectTimeoutMs: 30 })
    cKA.start()
    await new Promise((r) => setTimeout(r, 90))
    assert(socketsKA[0].closed === true, '超时后立即关闭卡住的连接（不留下无人回收的 socket）')
    assert(tKA.store.detail.indexOf('连接超时') !== -1 && tKA.store.retries === 1, '状态文案写明「连接超时」并计入退避')
    await new Promise((r) => setTimeout(r, 1100)) // 退避 1s 后才真正重连
    assert(socketsKA.length === 2, '退避结束后重新发起连接（此前会永远卡在「连接中…」）')
    cKA.stop()

    // ② 正常 onopen → 看门狗解除
    const socketsKB = []
    class FakeWSB {
      constructor(url) { this.url = url; socketsKB.push(this) }
      close() {}
    }
    const exKB = loadClientEx({}, { window: { WebSocket: FakeWSB } }).exports
    const cKB = exKB.__test.createWsClient({ connectTimeoutMs: 30 })
    cKB.start()
    socketsKB[0].onopen()
    await new Promise((r) => setTimeout(r, 90))
    assert(socketsKB.length === 1 && exKB.__test.store.status === 'open', '正常建连后看门狗解除，不误触发重连')
    cKB.stop()

    // ③ onclose 先到 → 只按一次退避重连，看门狗不重复计数
    const socketsKC = []
    class FakeWSC {
      constructor(url) { this.url = url; socketsKC.push(this) }
      close() {}
    }
    const exKC = loadClientEx({}, { window: { WebSocket: FakeWSC } }).exports
    const cKC = exKC.__test.createWsClient({ connectTimeoutMs: 30 })
    cKC.start()
    socketsKC[0].onclose()
    await new Promise((r) => setTimeout(r, 90))
    assert(exKC.__test.store.retries === 1 && socketsKC.length === 1, 'onclose 先到 → 看门狗解除，不重复触发')
    cKC.stop()

    // ④ connectTimeoutMs=0 关闭看门狗（回到 0.3.2 行为）
    const socketsKD = []
    class FakeWSD {
      constructor(url) { this.url = url; socketsKD.push(this) }
      close() {}
    }
    const exKD = loadClientEx({}, { window: { WebSocket: FakeWSD } }).exports
    const cKD = exKD.__test.createWsClient({ connectTimeoutMs: 0 })
    cKD.start()
    await new Promise((r) => setTimeout(r, 90))
    assert(socketsKD.length === 1, 'connectTimeoutMs=0 可关掉看门狗')
    cKD.stop()
  } catch (e) {
    assert(false, '建连看门狗验证失败：' + e.message)
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

  console.log('== 0.3.1：设置页「发送测试气象警报」的轮换场景 ==')
  try {
    const citiesMod = await import(pathToFileURL(path.join(ROOT, 'lib', 'data', 'cities.js')).href)
    const t = loadClient().__test
    t.setCityTable(citiesMod.CITIES_BY_PREF)
    const mk = (key, pref, ms) => t.parseJma(t.buildTestTelegram(pref, ms, key, '千代田区'), { id: 'test-' + key + ms })
    assert(t.TEST_SCENARIOS.length === 5, '共 5 个轮换场景（' + t.TEST_SCENARIOS.map((s) => s.key).join('/') + '）')

    const l4 = mk('landslide', '東京都', 1700000000000)
    assert(l4 && l4.kind === 'weather' && l4.level === 4, '场景·泥石流警戒情报 → L4（电文标题本身就是 L4 相当）')
    assert(l4.kindLabel === '泥石流警戒情报' && l4.regions[0].city === '千代田区', '泥石流场景是市町村级，区域名取真实市町村')
    assert(l4.regions[0].pref === '東京都', '市町村级区域按码前两位归到東京都')
    const fl = mk('flood', '東京都', 1700000001000)
    assert(fl.level === 4 && fl.kindLabel === '洪水预报', '场景·洪水 → 由 Kind 名称（氾濫危険情報）映射出 L4')
    const hr = mk('heavyrain', '東京都', 1700000002000)
    assert(hr.level === 4 && hr.kindLabel === '大雨警报', '场景·大雨 → L4（级别写在 Kind 名称里）')
    const ss = mk('stormsurge', '東京都', 1700000003000)
    assert(ss.level === 4 && ss.kindLabel === '风暴潮警报', '场景·高潮 → L4')
    const l3 = mk('landslide-l3', '東京都', 1700000004000)
    assert(l3.level === 3 && l3.kindLabel === '泥石流警报', '场景·L3 土砂 → 级别 3（用于演示边界另一侧）')
    assert(mk('heavyrain', '大阪府', 1700000005000).regions[0].pref === '大阪府', '换县（大阪府＝27）同样正确归县')
    assert(mk('landslide', '東京都', 1700000006000).eventKey !== l4.eventKey, '不同时间戳的 eventKey 不同（连点两次不会被事件级去重吞掉）')
    assert(t.buildTestTelegram('架空県', 1700000007000, 'heavyrain').indexOf('130000') !== -1, '认不出的县名退回東京都的码（不生成坏电文）')

    // 音色：气象必须与地震 / 海啸分开
    assert(t.soundKindOf(l4) === 'weather', '气象警报使用独立音色 weather（此前沿用地震音）')
    assert(t.soundKindOf({ kind: 'eew' }) === 'eew' && t.soundKindOf({ kind: 'quake' }) === 'quake', '既有音色映射不变')
    assert(t.soundKindOf({ kind: 'tsunami', maxScale: 3 }) === 'tsunami' && t.soundKindOf({ kind: 'tsunami', maxScale: 1 }) === 'quake', '海啸音色分支不变')

    // 匹配与静默穿透
    const cfg = Object.assign({}, t.DEFAULT_CFG, { watch: { prefectures: ['東京都'], cities: [] } })
    assert(t.matchAlert(l4, cfg).hit === true, '测试电文能命中同县的关注设置')
    const cfgOther = Object.assign({}, t.DEFAULT_CFG, { watch: { prefectures: ['北海道'], cities: [] } })
    assert(t.matchAlert(l4, cfgOther).hit === false, '关注其它县时不会误命中（测试按钮取关注首项的理由）')
    assert(t.matchAlert(l3, cfg).hit === false, 'L3 场景不播报（hit=false）')
    const quiet = Object.assign({}, cfg, {
      quietHours: { enabled: true, start: '00:00', end: '23:59', breakForSevere: false },
    })
    t.handleAlert(l4, quiet, { skipQuietHours: true })
    assert(t.store.events[0].hit === true && t.store.events[0].suppressed !== true, 'skipQuietHours 下测试提醒不被静默吞掉')
    assert(String(t.store.events[0].label).indexOf('泥石流') !== -1, '测试提醒记入历史且标签正确')

    // 「静默提示」的语义：只在未播报（L3）时存在，L4 播报后必须清掉
    t.updateWeatherHint(l3, cfg)
    assert(t.store.weatherHint && t.store.weatherHint.level === 3, 'L3 命中 → 写入静默提示')
    assert(t.store.weatherHint.label === '東京都', '提示里的地区不再重复成「東京都東京都」')
    t.updateWeatherHint(l4, cfg)
    assert(t.store.weatherHint === null, 'L4 播报后清除静默提示（否则与「未达 L4，未播报」文案自相矛盾）')

    // handleAlert 如实回报结果：设置页的提示据此生成，不再写死"应看到弹窗"
    const off = Object.assign({}, cfg, { disasters: { earthquake: true, tsunami: true, weather: false } })
    const rOff = t.handleAlert(mk('heavyrain', '東京都', 1700000008000), off, { skipQuietHours: true })
    assert(rOff.notified === false && String(rOff.detail).indexOf('关闭') !== -1,
      '气象灾害开关关闭 → 返回未播报及原因（' + rOff.detail + '）')
    const rL3 = t.handleAlert(l3, cfg, { skipQuietHours: true })
    assert(rL3.notified === false && String(rL3.detail).indexOf('未达 L4') !== -1, 'L3 → 返回未播报及「未达 L4」原因')
    const rHit = t.handleAlert(mk('heavyrain', '東京都', 1700000009000), cfg, { skipQuietHours: true })
    assert(rHit.notified === true, '命中 L4 → 返回已播报')
    const rDup = t.handleAlert(mk('heavyrain', '東京都', 1700000009000), cfg, { skipQuietHours: true })
    assert(rDup.notified === false && rDup.reason === 'duplicate', '同一 id 再发 → 返回 duplicate（去重窗口内）')
  } catch (e) {
    assert(false, '测试电文验证失败：' + e.message)
  }

  console.log('\n结果: ' + pass + ' 通过, ' + fail + ' 失败')
  process.exit(fail === 0 ? 0 : 1)
})()
