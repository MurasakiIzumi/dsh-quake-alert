// dsh-quake-alert 解析器/匹配引擎同步回归测试（不依赖浏览器）
// 用法：node tests/sync-test.cjs
// 原理：stub window.__ModuleLoader__ 加载 client/client.js，取 exports.__test 的纯函数，
//       用 samples/ 的真实消息 JSON 验证 parse + matchAlert 行为。
'use strict'
const fs = require('fs')
const path = require('path')
const vm = require('vm')

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

console.log('\n结果: ' + pass + ' 通过, ' + fail + ' 失败')
process.exit(fail === 0 ? 0 : 1)
