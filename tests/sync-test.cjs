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
  // ⑥ 没有 Host 时一切照旧
  {
    const t = loadClientEx({}).exports.__test
    let err = ''
    try { t.applyCfg(Object.assign({}, t.currentCfg(), { source: 'sandbox' })) } catch (e) { err = e.message }
    assert(err === '', '没有 Host 时 applyCfg 不抛错')
    assert(t.currentCfg().source === 'sandbox', '没有 Host 时配置仍即时生效')
  }
  // ⑦ scope 异常不拖垮插件
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
    assert(routes.length === 1 && routes[0].path === '/dsh-quake-alert/areas', 'Host apply 注册了 /dsh-quake-alert/areas 路由')
    let status = 0
    let body = ''
    routes[0].handler({}, { writeHead(s) { status = s }, end(b) { body = b } })
    const parsed = JSON.parse(body)
    assert(status === 200, '路由返回 200')
    assert(parsed.prefectures && Object.keys(parsed.prefectures).length === 47, '路由返回 47 个县的市町村表')
    assert(parsed.prefectures['福島県'].indexOf('白河市') !== -1, '路由返回的表含白河市')
  } catch (e) {
    assert(false, '真实市区町村表 / Host 路由验证失败：' + e.message)
  }

  console.log('\n结果: ' + pass + ' 通过, ' + fail + ' 失败')
  process.exit(fail === 0 ? 0 : 1)
})()
