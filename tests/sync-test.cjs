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
    // 0.5.3：健康探针（12d）在 apply 里排一个 30 秒的 setInterval。沙箱此前没有这两个全局，
    // 于是"插件能不能装载"这件事本身就会失败。默认给真实实现即可——探针的 timer 带 unref，
    // 不会把测试进程钉住；要推进判定就用 createHealthProbe 注入假时钟直接调 tick()。
    setInterval: o.setInterval || setInterval,
    clearInterval: o.clearInterval || clearInterval,
  }
  // client.js 的 handleRaw 用裸 `document` 判断页面可见性（浏览器里就是 window.document），
  // 注入 document 的用例需要把它同时挂到沙箱全局，否则永远走「后台」分支。
  if (windowStub.document) sandbox.document = windowStub.document
  sandbox.window.window = sandbox.window
  windowStub.__ModuleLoader__ = {
    load: ({ id, factory }) => {
      // reactStub：默认是空对象（parse/match 不渲染 React）。需要**真的渲染** UI 的用例
      // 用 o.react 传一个极简实现进来——本项目的测试历来不渲染 UI，于是"设置页能不能渲染"
      // 从来没被守过（0.5.0 加了级联那块新 UI，一个拼错的 h(...) 会让整页白屏）。
      const reactStub = o.react || {}
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
  // 5) 未识别区域名（0.4.1 起**放行**）：原本被直接否决，与气象侧（regionInWeatherWatch
  //    有 region.pref && 保护）语义相反，也让"新设的观测点 / 未收录的预报区名"变成静默漏报。
  const unk = T.parse({ code: 552, id: 't-unk', cancelled: false, issue: { time: 'x' }, areas: [{ grade: 'Warning', name: '謎の海域' }] })
  assert(T.matchAlert(unk, cfg(['東京都'])).hit === true, '未识别区域名不再被否决（宁可多报绝不漏报）')
  assert(T.matchAlert(unk, cfg([])).hit === true, '全日本模式（未选地区）下未识别区域仍可提醒')
  // 「未能识别」的提示仍然保留：可识别区域未命中、且未识别区域的等级也没到阈值时
  const mixed = T.parse({
    code: 552, id: 't-mix', cancelled: false, issue: { time: 'x' },
    areas: [{ grade: 'Watch', name: '福島県' }, { grade: 'Watch', name: '謎の海域' }],
  })
  const mm = T.matchAlert(mixed, cfg(['東京都'], 'Warning'))
  assert(mm.hit === false && mm.reason.indexOf('未能识别') !== -1,
    '未命中原因里仍提示「另有 N 个区域名未能识别归属县」')
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
  // 0.4.1：552 的事件键改为「预报区名集合」（原来是空串 → cancelKeyOf 退化成 'tsunami'，
  // 任意海域的解除都会被当成"此前提醒过的事件"，播出一条假解除——海啸域的假安全）。
  // 解除电文会列出被解除的预报区，名字集合与发布一致时才算同一事件。
  const cleared = Object.assign({}, tsunami, {
    id: 't-clear',
    cancelled: true,
    areas: tsunami.areas.map((a) => Object.assign({}, a, { grade: null })),
  })
  t.handleRaw(cleared, cfg)
  assert(t.store.events[0].hit === true && t.store.events[0].headline.indexOf('解除') !== -1,
    '海啸解除（同一批预报区）→ 补一条解除提醒')
  t.handleRaw(Object.assign({}, tsunami, { id: 't-clear2', cancelled: true, areas: [] }), cfg)
  assert(t.store.events[0].hit === false && t.store.events[0].headline.indexOf('此前未提醒过') !== -1,
    '不带预报区的解除 → 只记历史（不退回按 kind 盲目匹配，否则会播报假解除）')
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
    assert(routes.length === 3, 'Host apply 注册了 3 条只读路由（/areas、/feed、/stream）')
    const areasRoute = routes.find((r) => r.path === '/dsh-quake-alert/areas')
    const feedRoute = routes.find((r) => r.path === '/dsh-quake-alert/feed')
    assert(!!areasRoute && !!feedRoute, '路由分别是 /areas 与 /feed')
    assert(!!routes.find((r) => r.path === mod.STREAM_PATH),
      '大陆源的 SSE 推送路由（/stream）已注册（0.5.0）')
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

    // ⑥ 详情拉取失败：不产事件、记 error，并**有界重试**（0.4.1 修正）
    //    旧实现把失败的 entry 也记为已见，于是一次瞬时故障（超时 / 连接被重置 / 5xx，
    //    大陆网络下是常态）就让这条警报永久漏报——extra.xml 是滚动 feed，同一 id 不会再出现。
    //    気象庁约束的是「一度**取得**したファイルを再度取得しない」，没取得就没有可复用之物。
    clock += 60 * 1000
    const feedFail = atom([entry(7, new Date(clock).toISOString())])
    const f2 = fakeFetch({ [FEED]: () => feedFail }) // detail-7 未登记 → 详情请求抛错
    const pFail = createPoller({
      feedUrl: FEED, fetchText: f2.fn, now: () => clock,
      backfillMs: 5 * 60 * 1000, maxDetailRetries: 2,
    })
    const r6 = await pFail.pollOnce()
    assert(r6.added === 0 && pFail.stats().errors === 1, '详情拉取失败 → 不产事件、记 error')
    assert(pFail.stats().detailDropped === 0, '首次失败不写 seen（下一轮还会重试）')
    clock += 60 * 1000
    await pFail.pollOnce()
    assert(f2.calls.filter((u) => u === 'detail-7').length === 2, '瞬时故障会重试（旧实现一次失败就永久漏报）')
    clock += 60 * 1000
    await pFail.pollOnce()
    assert(pFail.stats().detailDropped === 1, '超过重试上限后放弃，并计入 detailDropped（UI 可见）')
    const failTries = f2.calls.filter((u) => u === 'detail-7').length
    clock += 60 * 1000
    await pFail.pollOnce()
    assert(f2.calls.filter((u) => u === 'detail-7').length === failTries, '放弃之后不再重复请求同一个坏 URL')

    // ⑥b 单级源的修订版：USGS 复核震级上修是最常见的路径，必须能进缓冲
    clock += 60 * 1000
    let revUpdated = new Date(clock).toISOString()
    const revEntry = () => [{ id: 'us123', title: 'rev', updated: revUpdated, payload: 'body' }]
    const pRev = createPoller({
      feedUrl: 'https://example.test/usgs', fetchText: async () => 'x', now: () => clock,
      singleStage: true, idleMs: 0, backfillMs: 60 * 60 * 1000, dedupeKeyOf: (e) => e.id + '@' + e.updated,
      parseFeed: revEntry,
    })
    assert((await pRev.pollOnce()).added === 1, '单级源首版入缓冲')
    clock += 60 * 1000
    assert((await pRev.pollOnce()).added === 0, 'updated 未变 → 不重复入缓冲（同源不重复取）')
    revUpdated = new Date(clock).toISOString()
    assert((await pRev.pollOnce()).added === 1, 'updated 刷新 → 修订版重新入缓冲（震级上修不再被吞）')
    const pNoDedupe = createPoller({
      feedUrl: 'https://example.test/usgs', fetchText: async () => 'x', now: () => clock,
      singleStage: true, idleMs: 0, backfillMs: 60 * 60 * 1000, parseFeed: revEntry,
    })
    assert((await pNoDedupe.pollOnce()).added === 1, '（对照）按 entry id 去重时首版入缓冲')
    revUpdated = new Date(clock + 60 * 1000).toISOString()
    assert((await pNoDedupe.pollOnce()).added === 0, '（对照）按 entry id 去重：修订版被永久挡住（旧行为）')

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
    // 0.4.1：结构不符必须**抛错**（由 poller 计入 errors），不能与"没有数据"同形
    let usgsThrew = 0
    try { parseUsgsEntries('not json') } catch (err) { usgsThrew += 1 }
    try { parseUsgsEntries('{}') } catch (err) { usgsThrew += 1 }
    assert(usgsThrew === 2,
      'USGS feed 非 JSON / 缺 features → 抛错（此前返回 []，与"这一小时没有地震"完全同形）')
    assert(parseUsgsEntries('{"features":[]}').length === 0, 'USGS feed 结构正确但为空 → 空数组（empty，不是故障）')
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

    const callRaw = (query, headers) => {
      let body = ''
      let status = 0
      feedRoute.handler({ url: '/dsh-quake-alert/feed' + query, headers: headers || {} }, { writeHead(s) { status = s }, end(s) { body = s } })
      return { status, body: JSON.parse(body) }
    }
    const call = (query) => callRaw(query).body
    assert(call('?since=tail').source === 'jma', '不带 source 参数 → 默认 jma（旧版 Client 仍兼容）')
    assert(call('?since=tail').tail === true, 'since=tail → 只对齐位置、不回历史')
    assert(call('?source=usgs&since=tail').source === 'usgs', '?source=usgs 分派到 USGS 轮询器')
    assert(call('?source=noaa&since=tail').source === 'noaa', '?source=noaa 分派到 NOAA 轮询器')
    // 0.4.1：显式给了认不出的 source 必须 400，而不是静默退回 jma——静默兜底会让 Client
    // 拿到另一个源的原文去解析（必然失败）却照样推进游标，条目被永久跳过而表面一切正常。
    const badProto = callRaw('?source=constructor&since=tail')
    assert(badProto.status === 400 && badProto.body.error === 'unknown source',
      '原型链键（constructor）不再命中原型链，直接 400（不是 TypeError、也不再静默兜底）')
    const badUnknown = callRaw('?source=%3BDROP&since=tail')
    assert(badUnknown.status === 400, '未知 source → 400，不再静默退回 jma')
    assert(call('?source=%20noaa%20&since=tail').source === 'noaa', 'source 两侧空白被裁剪（" noaa " 仍可识别）')
    // 0.4.1：跨站 GET 会被拒绝。/feed 的 markRead 副作用不需要读响应就能触发，
    // 任意网页一个 <img> 就能把三个源的按需轮询永久压住（对気象庁是封 IP 风险）。
    const crossSite = callRaw('?source=jma&since=tail', { 'sec-fetch-site': 'cross-site' })
    assert(crossSite.status === 403, '跨站请求（sec-fetch-site: cross-site）被拒')
    assert(callRaw('?source=jma&since=tail', { 'sec-fetch-site': 'same-origin' }).status === 200,
      '同源请求（same-origin）放行')
    assert(callRaw('?source=jma&since=tail').status === 200, '没有 sec-fetch-site 头（老浏览器 / curl）照常放行')
    // stats=1：把 Host 侧健康计数暴露出来，客户端把它显示到「全球源状态」
    const withStats = call('?source=usgs&since=0&stats=1')
    assert(withStats.stats && typeof withStats.stats.errors === 'number' &&
      typeof withStats.stats.detailDropped === 'number' && typeof withStats.stats.idleSkips === 'number',
      '?stats=1 返回 Host 侧健康计数（errors / detailDropped / idleSkips）')
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
    // 0.4.1：NOAA 的「Tsunami Information」等级为 0，默认 tsunamiGrade=Watch(1) 之下不命中。
    // 它是"没有破坏性海啸"的信息类电文，在半径内响铃会直接摧毁用户对整条链路的信任。
    assert(t.matchAlert(n, tsunamiCfg).hit === false, '端到端：NOAA「海啸信息」不再响铃（等级低于 tsunamiGrade）')
    const nAdv = t.parseNoaaCap(
      fs.readFileSync(path.join(ROOT, 'samples', 'global', 'noaa-pheb-cap.xml'), 'utf8')
        .replace('<event>Tsunami Information</event>', '<event>Tsunami Advisory</event>'),
      { id: 'adv' })
    assert(t.matchAlert(nAdv, tsunamiCfg).hit === true, '端到端：Tsunami Advisory 命中 Scotia 海关注点')
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
    // 0.4.1：真实样本是「Tsunami Information」→ 等级 0，默认 tsunamiGrade=Watch 之下不响铃。
    // 「海啸不受震级阈值限制」这一点改由同一份 CAP 的 Advisory 版本验证（震级阈值仍为 M9.0）。
    assert(realCap.tsunamiRank === 0, 'NOAA Information → tsunamiRank=0（与日本 TSUNAMI_RANK 同一把尺）')
    assert(t.matchAlert(realCap, capCfg).hit === false, 'NOAA「海啸信息」不再命中（等级低于阈值）')
    const capAdv = t.parseNoaaCap(
      fs.readFileSync(path.join(ROOT, 'samples', 'global', 'noaa-pheb-cap.xml'), 'utf8')
        .replace('<event>Tsunami Information</event>', '<event>Tsunami Advisory</event>'),
      { id: 'adv' })
    assert(t.matchAlert(capAdv, capCfg).hit === true, '同一份 CAP 改成 Advisory → 在 M9.0 阈值下仍命中（海啸不受震级限制）')
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

  console.log('== 0.4.1：源时区与全局严重度 ==')
  try {
    const t = loadClient().__test
    // ① P2PQuake 的时间是裸 JST，解析层必须补上 +09:00 偏移（DESIGN 第 4 节）
    assert(t.p2pTimeToIso('2026/09/07 23:25:14') === '2026-09-07T23:25:14+09:00',
      'P2PQuake 裸 JST → 带 +09:00 偏移的 ISO 8601')
    assert(t.p2pTimeToIso('2026/09/08 00:03:16.886') === '2026-09-08T00:03:16.886+09:00', '毫秒被保留')
    assert(t.p2pTimeToIso('不是时间') === '不是时间', '认不出时原样返回（绝不丢信息）')
    assert(t.p2pTimeToIso('') === '', '空串 → 空串')
    const q = t.parse(readSample('quake-kumamoto-detailscale-20260907.json'))
    assert(q.issued.indexOf('+09:00') !== -1, '551 的 issued 带 +09:00（此前是裸 JST 字符串）')
    const e = t.parse(eew)
    assert(e.issued.indexOf('+09:00') !== -1, '556 的 issued 带 +09:00')
    // 旧历史数据没有偏移 → 按 JST 解释（DESIGN 334）
    assert(typeof t.formatIssuedLocal('2026/09/07 23:25:14') === 'string', '旧历史（裸 JST）也能格式化，不抛错')

    // ② 全球点型地震的严重度（0.4.0 的隐患）：maxScale 恒为 -1，若走震度路径会算成 info，
    //    既显示不出严重性、又让静默时段的红色穿透失效（一场 M7 被静默）。
    const prog = { prefectures: [], cities: [], places: [{ name: 'P', lat: 35.68, lon: 139.77, radiusKm: 300 }] }
    const m7 = { kind: 'quake', locator: 'point', severity: 'red', maxScale: -1, magnitude: 7.4, geo: { lat: 35.68, lon: 139.77 }, regions: [] }
    const m5 = Object.assign({}, m7, { severity: 'yellow', magnitude: 5.2 })
    assert(t.hitSeverityOf(m7, {}) === 'red', '点型 M7.4 → severity 取解析层的 red（不是 info）')
    assert(t.hitSeverityOf(m5, {}) === 'yellow', '点型 M5.2 → yellow')
    // 日本地震仍按命中区域的实测震度（德国 M7 不影响关注县的黄色）
    const jp = { kind: 'quake', locator: 'area', severity: 'red', maxScale: 70, magnitude: null }
    assert(t.hitSeverityOf(jp, { region: { scale: 40 } }) === 'yellow',
      '日本地震仍按命中区域震度判色（不因全日本最大值是 7 就标红）')
    assert(t.hitSeverityOf({ kind: 'eew', severity: 'red', maxScale: 45 }, { region: { scale: 45 } }) === 'red',
      'EEW 恒为 red')

    // ③ 同一消息 id 的强度升级要能穿透消息级去重（EMSC 的 unid / USGS 的 feature id 都是稳定的）
    const ev = { id: 'emsc-1', eventKey: 'geo:x', strength: 5.2, locator: 'point', issued: '2026-09-12T02:15:12Z', geo: { lat: 38, lon: 22.3 } }
    assert(t.isDuplicate(ev.id, 10) === false, '（前置）首次见到该 id')
    assert(t.isStrengthUpgrade(Object.assign({}, ev, { strength: 6.4 })) === false,
      '还没登记事件时不算升级（isStrengthUpgrade 只读）')
    t.isEventRepeat(ev, 10) // 登记 strength=5.2
    assert(t.isStrengthUpgrade(Object.assign({}, ev, { strength: 6.4 })) === true,
      'M5.2 → M6.4 判为强度升级 → 允许穿透消息级去重（否则震级上修永远不会再提醒）')
    assert(t.isStrengthUpgrade(ev) === false, '同强度不算升级')
    assert(t.isDuplicate(ev.id, 10) === true, '同一 id 第二次确实被消息级去重挡住（升级由调用方放行）')

    // ④ 坐标型的近似事件归并：跨源 / 修订会让「分钟 + 0.1 度」指纹换键
    const a1 = { id: 'e1', eventKey: 'geo:k1', strength: 5.0, locator: 'point', issued: '2026-09-13T10:00:00Z', geo: { lat: 10.1, lon: 100.2 } }
    const a2 = { id: 'u1', eventKey: 'geo:k2', strength: 5.0, locator: 'point', issued: '2026-09-13T10:00:30Z', geo: { lat: 10.15, lon: 100.25 } }
    assert(t.isEventRepeat(a1, 10) === false, '（前置）第一源播报')
    assert(t.isEventRepeat(a2, 10) === true,
      '另一个源对同一场地震（±2 分钟内、约 7km）换了个指纹 → 仍判为同一事件，不重复响铃')
    const a3 = Object.assign({}, a2, { eventKey: 'geo:k3', issued: '2026-09-13T12:30:00Z' })
    assert(t.isEventRepeat(a3, 10) === false, '时间差 2.5 小时 → 按新事件处理')

    // ④b 事件记忆按**各自**的窗口过期（0.5.1 修 D 类残留）
    // 此前清理用的是"本次调用的窗口"：一条按 3 小时窗口记住的气象事件，会被 10 分钟后任意一条
    // "命中"地震带着的 10 分钟窗口清掉，随后 L4 的更新被判成新事件 → 重复响铃。
    {
      const t0 = 1700000000000
      const wxA = {
        eventKey: 'jma:test-大雨:office-x', strength: 4, kind: 'weather', source: 'jma',
        issued: new Date(t0 - 60 * 1000).toISOString(),
      }
      assert(t.isEventRepeat(wxA, 180, t0) === false, '（前置）气象事件首次登记 → 不判重复')
      const q1 = {
        id: 'q1', eventKey: 'geo:2026-09-18T20:00@35.0,139.0', strength: 5, kind: 'quake',
        locator: 'point', source: 'usgs', issued: new Date(t0).toISOString(), geo: { lat: 35, lon: 139 },
      }
      t.isEventRepeat(q1, 10, t0 + 11 * 60 * 1000) // 11 分钟后的一条地震，走 10 分钟窗口
      assert(t.isEventRepeat(wxA, 180, t0 + 12 * 60 * 1000) === true,
        '气象事件按自己的 3 小时窗口记忆：10 分钟后的一条地震不得把它清掉（否则 L4 更新会重复响铃）')
      assert(t.isEventRepeat(wxA, 180, t0 + 4 * 60 * 60 * 1000) === false,
        '超过自己的 3 小时窗口后确实过期，按新事件处理')
    }

    // ⑤ 解析契约：empty / schema / value 三类的区分（DESIGN 4.5）
    const emptyCode = t.parseEpspResult({ code: 554, id: 'x' })
    assert(emptyCode.ok === false && emptyCode.kind === 'empty', 'P2PQuake 其他 code → empty（不计故障）')
    const badQuake = t.parseEpspResult({ code: 551, id: 'x', issue: { time: 't' }, earthquake: {}, points: [] })
    assert(badQuake.ok === false && badQuake.kind === 'schema', '551 缺 maxScale → schema')
    const badScale = t.parseEpspResult({
      code: 551, id: 'x', issue: { time: 't' },
      earthquake: { time: '9999/01/01 00:00:00', maxScale: 10 }, points: [],
    })
    assert(badScale.ok === false && badScale.kind === 'value', '551 的发布时间在 100 年后 → value')
    const okEew = t.parseEpspResult(eew)
    assert(okEew.ok === true && okEew.alert.kind === 'eew', '结构完整 → ok + alert')
    assert(t.parseJmaResult('<html>blocked</html>').kind === 'schema', 'JMA 拿到 HTML 拦截页 → schema')
    assert(t.parseJmaResult('<Report><Control><Title>天気予報</Title></Control></Report>').kind === 'empty',
      'JMA 与本插件无关的电文 → empty（不是故障）')
    assert(t.parseEmscResult({ action: 'delete', data: {} }).kind === 'empty', 'EMSC 撤回通知 → empty')
    assert(t.parseEmscResult({ action: 'update', data: {} }).kind === 'schema', 'EMSC 缺 properties → schema')
    assert(t.parseUsgsResult({ properties: { mag: 5 } }).kind === 'schema', 'USGS 缺坐标 → schema')
    assert(t.parseNoaaResult('<alert><msgType>Test</msgType></alert>').kind === 'empty', 'NOAA 演练电文 → empty')
    assert(t.parseNoaaResult('<html>nope</html>').kind === 'schema', 'NOAA 拿到 HTML → schema')

    // ⑥ 每源约定（四要素）必须齐全：字段清单、源时区、新鲜度阈值、empty 判据
    // cenc_eew / cenc_eqlist 是 0.5.0 新增（DESIGN 11.1：约定**必须与解析函数同时定下**）
    const ids = ['p2pquake', 'jma', 'emsc', 'usgs', 'noaa', 'cenc_eew', 'cenc_eqlist']
    const missing = ids.filter((id) => {
      const c = t.SOURCE_CONTRACTS[id]
      return !c || !c.label || !c.timezone || !Array.isArray(c.required) || c.required.length === 0 ||
        !c.empty || !('staleAfterMs' in c) || (!c.staleAfterMs && !c.staleReason)
    })
    assert(missing.length === 0, '七个源的校验约定齐全（必需字段 / 源时区 / 新鲜度阈值 / empty 判据）' +
      (missing.length ? '（缺：' + missing.join(',') + '）' : ''))

    // ⑦ 健康状态（0.5.3 机制化）：**单条失败不升级**、同因累计到阈值才进 schema-error、
    //    坏法不重样时按连续失败升级；empty 不进（且清掉异常）；恢复后回到 open。
    t.store.clearSources()
    t.resetSourceHealth()
    t.noteParseResult('usgs', t.failResult('schema', '缺 properties.mag'))
    assert(!t.store.sources.usgs || t.store.sources.usgs.status !== 'schema-error',
      '单条坏数据**不**点亮蓝点（线上是逐条 entry，一条脏数据不该让整个源变蓝——0.5.3 修的就是这个）')
    assert(t.sourceHealthOf('usgs').data && t.sourceHealthOf('usgs').data.count === 1,
      '但失败被记进了计数（诊断里看得见，不是静默吞掉）')
    for (let i = 1; i < t.SCHEMA_ESCALATE_COUNT; i++) {
      t.noteParseResult('usgs', t.failResult('schema', '缺 properties.mag'))
    }
    assert(t.store.sources.usgs.status === 'schema-error',
      '同一失败原因累计 ' + t.SCHEMA_ESCALATE_COUNT + ' 条 → 该源进入 schema-error')
    assert(t.sourceHealthOf('usgs').data.detail.indexOf('mag') !== -1, '失败原因可读（供排查文档引用）')
    assert(t.effectiveStatusOf('usgs', 'open', '连接正常').status === 'schema-error',
      '连接正常也不该掩盖数据格式异常（蓝点优先于绿灯）')
    // 0.4.2：empty 证明"结构是好的"，要清掉 schema-error——JMA 的常态就是 empty，
    // 否则一条坏电文会让蓝点挂到下一次成功解析为止。
    t.noteParseResult('usgs', t.failResult('empty', 'features 为空'))
    assert(t.sourceHealthOf('usgs').data === null && t.store.sources.usgs.status === 'open',
      'empty 清掉 schema-error（不再是"不覆盖已有异常"）')
    assert(t.noteSourceSuccess('usgs') === false, '已经恢复的源再报成功 → 无动作（不会重复上报）')
    assert(t.effectiveStatusOf('p2pquake', 'open', 'ok').status === 'open', '没有异常记录的源不受影响')
    // 第二条升级路径：**坏法不重样**（上游把结构改得面目全非时每条 detail 都不同，
    // 按原因计数永远到不了阈值）→ 由连续失败数兜住
    t.resetSourceHealth()
    t.store.clearSources()
    for (let i = 0; i < t.SCHEMA_ESCALATE_CONSECUTIVE; i++) {
      t.noteParseResult('jma', t.failResult('schema', '第 ' + i + ' 种坏法'))
    }
    assert(t.store.sources.jma.status === 'schema-error',
      '连续 ' + t.SCHEMA_ESCALATE_CONSECUTIVE + ' 条（原因各不相同）同样升级')
    t.store.clearSources()
    t.noteParseResult('emsc', t.failResult('schema', '缺 data'))
    t.retrySource('emsc')
    assert(t.sourceHealthOf('emsc').data === null && t.store.sources.emsc.status === 'open', '手动重试清掉异常标记')
    // ⑧ 0.4.1：Ｒ０６ 総合副本的「危険警報」与逐区级别（真实 live 电文的精简样本）
    const hyogo = fs.readFileSync(path.join(ROOT, 'samples', 'jma-vpww53-hyogo-danger-20260914.xml'), 'utf8')
    const h53 = t.parseJma(hyogo, { id: 'https://www.data.jma.go.jp/developer/xml/data/20260914113112_0_VPWW53_280000.xml' })
    assert(h53 && h53.level === 4,
      '総合副本的级别取自 <Body><Notice> 的「レベル４」（Kind 只写"大雨警報"，不读 Notice 会判成 L3）')
    assert(h53.headline.indexOf('警戒レベル4') !== -1, 'headline 标注警戒レベル4')
    const byCity = {}
    for (const r of h53.regions) byCity[r.city || r.area] = r.level
    assert(byCity['姫路市'] === 4, '姫路市在 Notice 的 L4 列表里 → region.level=4（即使它的 Kind 只是"大雨警報"）')
    assert(byCity['相生市'] === 3, '相生市的 Kind 是"大雨警報"→ region.level=3（不被电文最大值抬到 4）')
    assert(byCity['西脇市'] === 2, '西脇市的 Kind 是"大雨注意報"→ region.level=2（不被抬到 4）')
    const hyCfg = (cities) => ({
      watch: { prefectures: ['兵庫県'], cities: cities || [] },
      disasters: { weather: true }, thresholds: {}, dedupe: { windowMinutes: 10 }, notify: {}, quietHours: {},
    })
    assert(t.matchAlert(h53, hyCfg()).hit === true, '关注兵庫県 → 命中（姫路市 L4）')
    const onlyNishiwaki = t.matchAlert(h53, hyCfg(['西脇市']))
    assert(onlyNishiwaki.hit === false && onlyNishiwaki.reason.indexOf('未达 L4') !== -1,
      '只关注西脇市（L2）→ 不播报（逐区闸门生效，不被同县 L4 连坐）')
    // 事件键不含发布时刻：解除电文才能与发布电文算到同一个键（否则解除链路永远匹配不上）
    assert(h53.eventKey === 'jma:summary:大雨:280000',
      '総合副本的事件键 = 灾种 + 編集官署名コード（不含发布时刻，解除才能匹配上）')
    // 真实解除电文（気象庁样本）：Kind 全是「解除」、主文里也不含灾种词
    // → 灾种只能退化成中性的「气象」，键与发布的「大雨」不同 ⇒ 当前**不提示**解除。
    // 这不是同义反复，而是把"键推导依赖主文文案"这条机制限制固定下来（见 DESIGN 11.6 #3）。
    const cancelXml = fs.readFileSync(path.join(ROOT, 'samples', 'jma-vpno50-tokyo-cancel-20260907.xml'), 'utf8')
    const cancelAlert = t.parseJma(cancelXml, { id: 'https://x/20260907190104_0_VPNO50_130000.xml' })
    assert(cancelAlert && cancelAlert.cancelled === true, '真实解除报知 → cancelled=true（只看 Body 副本的 Status）')
    assert(cancelAlert.eventKey === 'jma:summary:气象:130000',
      '真实解除报知的灾种认不出（Kind 只有「解除」、主文无灾种词）→ 键与发布的不同，故不提示（DESIGN 11.6 #3）')
    // 对照：主文里认得出灾种时，解除与发布能算到同一个键
    const cancelSame = Object.assign({}, h53, { cancelled: true, level: 0, strength: 0, regions: [] })
    assert(t.cancelKeyOf(cancelSame) === h53.eventKey, '（对照）同一灾种的解除与发布共用同一个 cancelKeyOf 键')

    // ⑨ Host 侧：feed 结构不符必须计入 errors，不能与"源正常但当前无数据"同形
    const pollerMod = await import(pathToFileURL(path.join(ROOT, 'lib', 'poller.js')).href)
    const gsMod = await import(pathToFileURL(path.join(ROOT, 'lib', 'global-sources.js')).href)
    const t0 = Date.parse('2026-09-14T12:00:00Z')
    const badFeed = pollerMod.createPoller({
      feedUrl: 'https://example.test/usgs', parseFeed: gsMod.parseUsgsEntries, singleStage: true,
      idleMs: 0, now: () => t0, startedAt: t0,
      fetchText: async () => '<html>blocked</html>',
    })
    const rBad = await badFeed.pollOnce()
    assert(rBad.parseFailed === true && badFeed.stats().errors === 1,
      'Host：feed 被替换成 HTML / 改版 → 计入 errors（此前与"没有数据"同形）')
    assert(String(badFeed.stats().lastError).indexOf('解析失败') !== -1, 'Host：失败原因可读（供 TROUBLESHOOTING 引用）')
    const goodEmpty = pollerMod.createPoller({
      feedUrl: 'https://example.test/usgs', parseFeed: gsMod.parseUsgsEntries, singleStage: true,
      idleMs: 0, now: () => t0, startedAt: t0,
      fetchText: async () => '{"features":[]}',
    })
    const rGood = await goodEmpty.pollOnce()
    assert(rGood.parseFailed !== true && goodEmpty.stats().errors === 0 && goodEmpty.stats().feedEntries === 0,
      'Host：结构正确但为空 → 不算故障（empty 与 schema 必须分开）')
  } catch (e) {
    assert(false, '0.4.1 契约与时区验证失败：' + e.message)
  }

  console.log('== 0.4.2：对 0.4.1 修复的回归检查 ==')
  try {
    const t = loadClient().__test
    const wcfg = {
      watch: { prefectures: ['東京都'], cities: [], places: [] },
      disasters: { earthquake: true, tsunami: true, weather: true },
      thresholds: { quakeScale: 40, eewScale: 45, tsunamiGrade: 'Watch', globalMagnitude: 4.5 },
      notify: { sound: false, system: false, volume: 0 },
      dedupe: { windowMinutes: 10 },
      quietHours: { enabled: false, start: '23:00', end: '07:00', breakForSevere: true },
    }
    const mkWeather = (strength, level, id) => ({
      id: id || ('w-' + strength + '-' + level), code: 'jma', kind: 'weather', kindLabel: '大雨警報',
      severity: level >= 4 ? 'red' : 'orange', issued: '2026-09-14T12:00:00+09:00', headline: 'h',
      level, maxScale: level, hypo: {}, regions: [{ pref: '東京都', area: '東京都', city: '', level }],
      eventKey: 'jma:summary:大雨:130000', strength, cancelled: false,
    })
    // ① 气象「降级后再次升级」不该被静默（0.4.1 去掉事件键里的发布时刻后新引入的漏报）
    assert(t.handleAlert(mkWeather(4, 4, 'r1'), wcfg).notified === true, 'L4 首次 → 播报')
    assert(t.handleAlert(mkWeather(3, 3, 'r2'), wcfg).reason === 'not-hit', 'L3 降级 → 不播报（未达 L4）')
    assert(t.handleAlert(mkWeather(4, 4, 'r3'), wcfg).notified === true,
      '再次升回 L4 → 仍要播报（此前被判"强度未升级的重复发布"而静默）')
    // weakenEvent 只在确实更低时下调
    const w1 = { eventKey: 'wx', strength: 4 }
    assert(t.isEventRepeat(w1, 180) === false, '（前置）登记 strength=4')
    assert(t.weakenEvent({ eventKey: 'wx', strength: 3 }) === true, 'weakenEvent：3 < 4 → 下调')
    assert(t.weakenEvent({ eventKey: 'wx', strength: 4 }) === false, 'weakenEvent：同强度不下调')
    assert(t.weakenEvent({ eventKey: '不存在', strength: 1 }) === false, 'weakenEvent：没有记录时安全返回 false')

    // ② 官署名碼取不到时不能留空（否则不同官署的同一灾种共键 → 互相静默）
    const hyogoXml = fs.readFileSync(path.join(ROOT, 'samples', 'jma-vpww53-hyogo-danger-20260914.xml'), 'utf8')
    const tokyoXml = fs.readFileSync(path.join(ROOT, 'samples', 'jma-vpww55-heavyrain.xml'), 'utf8')
    const k1 = t.parseJma(hyogoXml, { id: 'no-suffix-1' }).eventKey
    const k2 = t.parseJma(tokyoXml, { id: 'no-suffix-2' }).eventKey
    assert(k1.indexOf('jma:summary:') === 0 && k1.split(':')[3] !== '',
      'id 不含 6 位后缀时，键里仍有官署标识（' + k1 + '）')
    assert(k1 !== k2, '不同气象台的同灾种电文不会共键（' + k1 + ' vs ' + k2 + '）')

    // ③ 551 单个观测点缺字段不该让整条警报消失
    const q551 = {
      code: 551, id: 'x', issue: { time: 't' },
      earthquake: { time: '2026/09/14 12:00:00', maxScale: 40 },
      points: [{ pref: '東京都', addr: '千代田区' }],
    }
    const r551 = t.parseEpspResult(q551)
    assert(r551.ok === true, '551 的 points 项缺 scale → 仍按可用数据处理（不再整条判 schema）')
    const bad551 = Object.assign({}, q551, { points: [{ pref: '東京都', addr: 'a', scale: '40' }] })
    assert(t.parseEpspResult(bad551).kind === 'schema', '字段类型明显不对（scale 是字符串）仍判 schema')

    // ④ 坐标型近似归并只在**跨源**之间生效（同源的主震/余震不该被吞）
    const s1 = { id: 's1', source: 'emsc', eventKey: 'geo:m1', strength: 5.0, locator: 'point', issued: '2026-09-21T10:00:00Z', geo: { lat: 30, lon: 130 } }
    const s2 = { id: 's2', source: 'emsc', eventKey: 'geo:m2', strength: 5.0, locator: 'point', issued: '2026-09-21T10:00:40Z', geo: { lat: 30.05, lon: 130.05 } }
    assert(t.isEventRepeat(s1, 10) === false, '（前置）同源第一条播报')
    assert(t.isEventRepeat(s2, 10) === false,
      '同源相隔 40 秒、相距 ~7km 的第二条消息 → 不算同一事件（可能是主震与余震，吞掉就是漏报）')
    const u1 = Object.assign({}, s1, { id: 'u1', source: 'usgs', eventKey: 'geo:m3' })
    const e1 = Object.assign({}, s1, { id: 'e1', source: 'emsc', eventKey: 'geo:m4', issued: '2026-09-21T11:00:00Z' })
    assert(t.isEventRepeat(e1, 10) === false, '（前置）EMSC 报一场地震')
    assert(t.isEventRepeat(u1, 10) === true, 'USGS 对同一场地震（±2 分钟、~7km）→ 跨源归并，不重复响铃')

    // ⑤ 配置字段漂移保护：normalizeCfg 必须覆盖 DEFAULT_CFG 的每一个字段
    //    （freshCfg 已改为从 DEFAULT_CFG 深拷贝派生，但 normalizeCfg 仍是手写的字段集；
    //     给它加断言，避免以后加字段时被 applyCfg 静默丢弃）
    const nc = t.normalizeCfg(t.DEFAULT_CFG)
    const lostTop = Object.keys(t.DEFAULT_CFG).filter((k) => !(k in nc))
    const lostNested = []
    for (const k of ['watch', 'disasters', 'thresholds', 'notify', 'dedupe', 'quietHours']) {
      for (const f of Object.keys(t.DEFAULT_CFG[k])) if (!(f in nc[k])) lostNested.push(k + '.' + f)
    }
    assert(lostTop.length === 0 && lostNested.length === 0,
      'normalizeCfg 覆盖 DEFAULT_CFG 的全部字段（顶层与嵌套都没有漂移）' +
      (lostTop.length || lostNested.length ? '（缺：' + lostTop.concat(lostNested).join(',') + '）' : ''))

    // ⑥ audioState 只回答状态，不为了回答而创建 AudioContext
    assert(t.audioState() === 'unavailable', '沙箱里没有 AudioContext 构造器 → audioState=unavailable（且不抛错）')

    // ⑧ 拦截页 / 被截断的 feed 必须抛错（否则"被拦"与"上游没有新闻"在 UI 上完全同形）
    const pollerMod2 = await import(pathToFileURL(path.join(ROOT, 'lib', 'poller.js')).href)
    const gsMod2 = await import(pathToFileURL(path.join(ROOT, 'lib', 'global-sources.js')).href)
    let feedThrew = 0
    try { pollerMod2.parseAtomEntries('<html><body>blocked</body></html>') } catch (err) { feedThrew += 1 }
    try { pollerMod2.parseAtomEntries('<feed><entry><id>x</id>') } catch (err) { feedThrew += 1 }
    assert(feedThrew === 2, 'Atom 解析：HTML 拦截页与被截断的 feed 都抛错（errors 才会增长）')
    assert(pollerMod2.parseAtomEntries('<feed></feed>').length === 0,
      '结构正确的空 feed → 空数组（empty，不是故障）')
    let noaaThrew = 0
    try { gsMod2.parseNoaaEntries('<html>nope</html>') } catch (err) { noaaThrew += 1 }
    try { gsMod2.parseNoaaEntries('<feed><entry>') } catch (err) { noaaThrew += 1 }
    assert(noaaThrew === 2, 'NOAA 事件列表：HTML 与被截断同样抛错（JMA 与 NOAA 此前都静默返回 []）')

    // ⑨ empty 要清掉之前的 schema-error（否则一条坏电文会让蓝点挂到下一次成功解析为止）。
    //    0.5.3 起"进入 schema-error"要多喂几条（单条不再升级）——这里用连续失败那条路径。
    t.store.clearSources()
    t.resetSourceHealth()
    for (let i = 0; i < t.SCHEMA_ESCALATE_CONSECUTIVE; i++) {
      t.noteParseResult('jma', t.failResult('schema', '结构不符'))
    }
    assert(t.store.sources.jma.status === 'schema-error', '（前置）进入 schema-error')
    t.noteParseResult('jma', t.failResult('empty', '天气预报，与本插件无关'))
    assert(t.sourceHealthOf('jma').data === null && t.store.sources.jma.status === 'open',
      'empty 证明结构是好的 → 清掉 schema-error（JMA 的常态就是 empty）')

    // ⑩ timeIsImpossible：时间**缺失**不是"客观不可能"（存在性由 schema 判据负责）
    const noTime551 = {
      code: 551, id: 't', issue: { time: '2026/09/14 12:00:00' },
      earthquake: { maxScale: 40 }, points: [{ pref: '東京都', addr: 'a', scale: 40 }],
    }
    assert(t.parseEpspResult(noTime551).ok === true, '551 缺 earthquake.time → 不再整条判 value')

    // ⑪ 跨会话重放的**判定条件**：wasRecentlyAlerted（24 小时记忆）且强度未升级。
    // 真正的"时间推进"（让 10 分钟的事件窗口过期、而 24 小时记忆仍在）在单进程测试里无法模拟，
    // 所以这里分别验证两个输入 + 组合语义；handleAlert 里那两条分支的顺序由注释与代码保证。
    t.store.events = []
    const repKey = 'jma:summary:大雨:REPLAY'
    const rep1 = Object.assign(mkWeather(4, 4, 'rp1'), { eventKey: repKey })
    assert(t.handleAlert(rep1, wcfg).notified === true, '（前置）事件首次播报')
    assert(t.wasRecentlyAlerted(rep1) === true, '播报后 24 小时记忆里就有这个事件键')
    const rep2 = Object.assign(mkWeather(4, 4, 'rp2'), { eventKey: repKey })
    assert(t.isStrengthUpgrade(rep2) === false, '同强度的再次投递 → 不算升级（会被重放抑制拦下）')
    const rep3 = Object.assign(mkWeather(5, 5, 'rp3'), { eventKey: repKey })
    assert(t.isStrengthUpgrade(rep3) === true, '强度上修的再次投递 → 算升级（重放抑制不会拦它）')
    assert(t.isDuplicate(rep1.id, 10) === true, '同一条消息（同 id）再来 → 消息级去重挡住')
    assert(t.parseEpspResult(readSample('quake-kumamoto-detailscale-20260907.json')).ok === true, '真实 551 → ok')
    assert(t.parseEpspResult(readSample('quake-kumamoto-scaleprompt-20260907.json')).ok === true, '真实 551（速报）→ ok')
    assert(t.parseEpspResult(readSample('eew-ibaraki-m6.7-20260823.json')).ok === true, '真实 556 → ok')
    assert(t.parseEpspResult(readSample('tsunami-fukushima-spec-example.json')).ok === true, '真实 552（规格示例）→ ok')
    assert(t.parseJmaResult(fs.readFileSync(path.join(ROOT, 'samples', 'jma-vxww50-landslide.xml'), 'utf8'), { id: 'x' }).ok === true,
      '真实 VXWW50（土砂災害警戒情報）→ ok')
    assert(t.parseJmaResult(fs.readFileSync(path.join(ROOT, 'samples', 'jma-vxko-flood.xml'), 'utf8'), { id: 'x' }).ok === true,
      '真实 VXKO（指定河川洪水予報）→ ok')
    assert(t.parseJmaResult(hyogoXml, { id: 'x' }).ok === true, '真实 VPWW53（危険警報）→ ok')
    const emscSample = JSON.parse(fs.readFileSync(path.join(ROOT, 'samples', 'global', 'emsc-ws-sample.json'), 'utf8'))
    assert(t.parseEmscResult(emscSample).ok === true, '真实 EMSC 帧 → ok')
    const usgsFeed = JSON.parse(fs.readFileSync(path.join(ROOT, 'samples', 'global', 'usgs-all-hour.geojson'), 'utf8'))
    const usgsBad = usgsFeed.features.filter((f) => !t.parseUsgsResult(f).ok)
    assert(usgsBad.length === 0, '真实 USGS 的 ' + usgsFeed.features.length + ' 条 feature 全部 → ok')
    const noaaCap = fs.readFileSync(path.join(ROOT, 'samples', 'global', 'noaa-pheb-cap.xml'), 'utf8')
    assert(t.parseNoaaResult(noaaCap, { id: 'x' }).ok === true, '真实 NOAA CAP → ok')

    // ⑫ pref='' 的口径（0.4.2 修正）：同一条消息里**有**区域能归县时，归不到的条目不参与
    //    县级过滤（否则一条含"未收录预报区名"的海啸会提醒所有关注列表非空的用户）；
    //    整条消息都归不到县时才放行（边界情况让步，避免整条静默）。
    const tcfg = (watch, grade) => ({
      disasters: { earthquake: true, tsunami: true }, dedupe: { windowMinutes: 10 },
      watch: { prefectures: watch }, thresholds: { quakeScale: 40, eewScale: 45, tsunamiGrade: grade || 'Watch' },
      notify: {}, quietHours: {},
    })
    const mixedUnknown = t.parse({
      code: 552, id: 't-mix2', cancelled: false, issue: { time: 'x' },
      areas: [{ grade: 'Warning', name: '福島県' }, { grade: 'MajorWarning', name: '謎の海域' }],
    })
    assert(t.matchAlert(mixedUnknown, tcfg(['東京都'])).hit === false,
      '有可归县区域且未命中时，未识别区域不放行（否则海啸会误报给所有关注列表非空的用户）')
    const allUnknown = t.parse({
      code: 552, id: 't-unk2', cancelled: false, issue: { time: 'x' },
      areas: [{ grade: 'MajorWarning', name: '謎の海域' }],
    })
    assert(t.matchAlert(allUnknown, tcfg(['東京都'])).hit === true,
      '整条消息的区域都归不到县 → 仍放行（边界情况让步，避免静默漏报）')

    // ⑬ Notice 解析的两处收紧
    const baseUrl = 'https://x/20260914113112_0_VPWW53_280000.xml'
    const oneCity = hyogoXml.replace('〈レベル４大雨危険警報〉姫路市　たつの市　多可町＊', '〈レベル４大雨危険警報〉姫路市*')
    const hOne = t.parseJma(oneCity, { id: baseUrl })
    assert((hOne.regions.find((r) => r.city === '姫路市') || {}).level === 4,
      '半角 * 的省略标记不粘在最后一个地区名上（唯一那个 L4 城市仍被提升）')
    const twoSeg = hyogoXml.replace(
      '〈レベル４大雨危険警報〉姫路市　たつの市　多可町＊',
      '［警戒レベル４相当情報の発表状況］\n姫路市　たつの市\n［氾濫注意情報の発表状況］\n〈氾濫注意情報〉西脇市＊')
    const hTwo = t.parseJma(twoSeg, { id: baseUrl })
    const cityLv = (a, city) => (a.regions.find((r) => r.city === city) || {}).level
    assert(cityLv(hTwo, '姫路市') === 4, '栏目名里的「レベル４」能把紧随其后的地区提到 L4')
    assert(cityLv(hTwo, '西脇市') === 2,
      '另一段的地区不被前面那段的级别吞掉（跨段量词会同时造成误报与漏报）')

    // ⑭ XML 注释不参与解析（否则注释里的标签与级别会污染 block/tag）
    const commented = '<Report><Control><Title>気象特別警報・警報・注意報</Title><EditorialOffice>测试台</EditorialOffice></Control>' +
      '<Head><Title>某県気象警報・注意報</Title><ReportDateTime>2026-09-14T20:31:00+09:00</ReportDateTime>' +
      '<Headline><Text>大雨警報を発表</Text><Information type="気象・地震・火山情報／市町村等"><Item>' +
      '<Kind><Name>大雨警報</Name><Code>03</Code></Kind>' +
      '<Areas codeType="気象・地震・火山情報／市町村等"><Area><Name>姫路市</Name><Code>2820100</Code></Area></Areas>' +
      '</Item></Information></Headline></Head>' +
      '<!-- <Body><Notice>〈レベル４大雨危険警報〉姫路市＊</Notice></Body> -->' +
      '<Body></Body></Report>'
    const hCmt = t.parseJma(commented, { id: baseUrl })
    assert(hCmt.level === 3, 'XML 注释里的「レベル４」不参与级别判定（解析前先剥注释）')

    // ⑮ 显式但不可识别的 codeType 不再按码位数猜成行政区域
    const gauge = commented.replace('</Item></Information>',
      '</Item><Item><Kind><Name>大雨警報</Name><Code>03</Code></Kind>' +
      '<Areas codeType="水位観測所"><Area><Name>某某観測所</Name><Code>123456</Code></Area></Areas>' +
      '</Item></Information>')
    const hGauge = t.parseJma(gauge, { id: baseUrl })
    assert(!hGauge.regions.some((r) => r.area === '某某観測所'),
      'codeType 显式但不是行政区域 → 忽略（位数兜底只服务于没给 codeType 的裸 <Area>）')

    // ⑯ 解除判定只看 Body 副本（Head 摘要没有 Status，会把"解除"稀释成"发布"）
    const canceled = hyogoXml.replace(/<Status>継続<\/Status>|<Status>発表<\/Status>/g, '<Status>解除</Status>')
    const hCancel = t.parseJma(canceled, { id: baseUrl })
    assert(hCancel && hCancel.cancelled === true, 'Body 的 Status 全是解除（Head 摘要无 Status）→ cancelled=true')
    const partial = hyogoXml.replace('<Status>継続</Status>', '<Status>解除</Status>')
    assert(t.parseJma(partial, { id: baseUrl }).cancelled === false,
      '只有部分条目是解除 → 不算整条解除（仍按发布处理）')
  } catch (e) {
    assert(false, '0.4.2 回归检查失败：' + e.message)
  }

  // ==========================================================================
  // 0.5.0：中国大陆地震源（Wolfx cenc_eew / cenc_eqlist）
  // 全部断言都由 samples/cn/ 下的**真实抓取样本**驱动（node scripts/capture-cn-fixtures.mjs --ws），
  // 不是照文档猜的结构。场景类用例按 DESIGN 11.4「场景靠构造」补在真实样本之上。
  // ==========================================================================
  try {
    const cn = (n) => JSON.parse(fs.readFileSync(path.join(ROOT, 'samples', 'cn', n), 'utf8'))
    const eewRaw = cn('cenc-eew-last.json')       // 真实：四川甘孜州新龙县 M4.2，ReportNum=2
    const listRaw = cn('cenc-eqlist-last.json')   // 真实：最新 50 条整表 + md5

    // ① 时间：两种"看起来只差分隔符"的裸本地时间必须各按各的偏移解释
    assert(T.cnTimeToIso('2026-09-18 20:50:23') === '2026-09-18T20:50:23+08:00',
      '大陆源的裸北京时间补 +08:00 偏移')
    assert(T.cnTimeToIso('2026-09-18T20:50:23') === '2026-09-18T20:50:23+08:00',
      'T 分隔符也认（两个源的形态都接受）')
    assert(T.cnTimeToIso('2023/09/05 06:16:32') === '2023/09/05 06:16:32',
      'P2PQuake 的斜杠格式**不**被大陆规则改写（两套正则必须互不相交）')
    assert(T.p2pTimeToIso('2026-09-18 20:50:23') === '2026-09-18 20:50:23',
      '反向同理：短横线格式不被 JST 规则改写')
    assert(T.cnTimeToIso('') === '' && T.cnTimeToIso(undefined) === '' && T.cnTimeToIso(null) === '',
      '空输入返回空串（不抛错、不造出 "Invalid Date"）')
    assert(T.cnTimeToIso('不是时间') === '不是时间', '认不出的串原样返回（绝不丢信息）')
    // 注意：不能用 `instanceof Date` —— client.js 跑在 vm 沙箱里，它有**自己的** Date 原型，
    // 宿主侧的 `Date` 对沙箱对象永远为假（这条本身也是个"测试写法"的坑）。
    const cnDate = T.issuedToDate('2026-09-18 20:50:23')
    assert(!!cnDate && cnDate.toISOString() === '2026-09-18T12:50:23.000Z',
      'issuedToDate 认得裸北京时间（差 1 小时的时间显示 bug 的根因就在这里）')

    // ② cenc_eew：真实样本（WS 形态，带 type 包裹）
    const eewRes = T.parseCencEewResult(eewRaw)
    assert(eewRes.ok === true, '真实 EEW 推送包 → 契约通过')
    const eewAlert = eewRes.alert
    assert(eewAlert.id === 'cenc:b4kybfnuqayyy', 'Alert id 取 cenc: 前缀 + ID')
    assert(eewAlert.kind === 'eew' && eewAlert.locator === 'point',
      '归类为 eew 且走坐标匹配（大陆源无分区烈度表）')
    assert(eewAlert.magnitude === 4.2 && Math.abs(eewAlert.geo.lat - 30.887) < 1e-9 &&
      Math.abs(eewAlert.geo.lon - 99.89) < 1e-9 && eewAlert.geo.depthKm === 14,
      '震级 / 震中 / 深度按实测字段映射')
    assert(eewAlert.issued === '2026-09-18T20:50:23+08:00',
      'OriginTime 转成带偏移的 ISO（事件键与显示都依赖它）')
    assert(eewAlert.reportNum === 2 && eewAlert.headline.indexOf('第 2 报') !== -1,
      'ReportNum 多报体现在文案里')
    assert(eewAlert.intensity === 5.8, '中国地震烈度（MaxIntensity）入库')
    assert(eewAlert.headline.indexOf('烈度') === -1,
      '烈度**不进文案**——它是震中附近最大值，不是用户所在地的烈度（DESIGN 8.3）')
    assert(eewAlert.cancelled === false,
      '大陆源没有取消 / 最终报标志 → cancelled 恒为 false（不得假装能处理）')
    assert(eewAlert.speedReport === false && eewAlert.code === 'cenc_eew', '预警不是速报')

    // ③ cenc_eew 的 REST 形态（无 type 包裹）与 WS 形态等价
    const restForm = Object.assign({}, eewRaw)
    delete restForm.type
    assert(T.parseCencEewResult(restForm).ok === true,
      'REST 快照（无 type）与 WS 推送包同样可解析——实测两者只差一个 type 字段')

    // ④ cenc_eew 的 schema / value / empty 三类判据
    const renamed = Object.assign({}, eewRaw)
    renamed.magnitude = renamed.Magnitude
    delete renamed.Magnitude
    assert(T.parseCencEewResult(renamed).kind === 'schema',
      '字段改名（Magnitude → magnitude）→ schema，不猜、不兜底')
    const noId = Object.assign({}, eewRaw); noId.ID = ''
    assert(T.parseCencEewResult(noId).kind === 'schema', '缺 ID → schema')
    const badCoord = Object.assign({}, eewRaw); badCoord.Latitude = 99
    assert(T.parseCencEewResult(badCoord).kind === 'value', '坐标越界 → value（结构对、值不可能）')
    const future = Object.assign({}, eewRaw); future.OriginTime = '2226-09-18 20:50:23'
    assert(T.parseCencEewResult(future).kind === 'value', '发震时刻在 100 年后 → value')
    assert(T.parseCencEewResult({ type: 'cenc_eew' }).kind === 'empty',
      '只有 type 包裹 → empty（源正常但当前没有预警，不计失败）')
    assert(T.parseCencEewResult({ type: 'cenc_eqlist', ID: 'x' }).kind === 'schema',
      'type 串源 → schema（防止两个源的载荷串台）')
    // cenc_eew 的 severity **恒 red**，与日本 556 同口径（DESIGN 2 节「EEW → red（警报本质）」）。
    // severity 决定通知配色，也决定**静默时段能否穿透**（只有 red 穿透）：按震级分档会让一场
    // M4.2 的大陆预警在夜间被静默掉，而同配置下的日本 EEW 照常穿透——那是漏报方向（0.5.1 修）。
    const cencEewAlert = T.parseCencEewResult(eewRaw).alert
    assert(cencEewAlert.magnitude < 5 && cencEewAlert.severity === 'red',
      '大陆预警 severity 恒 red —— 不因为实测样本只有 M4.2 就降级成 info')
    assert(T.hitSeverityOf(cencEewAlert, { region: null, place: null }) === 'red',
      '命中判定之后仍是 red（静默时段的红色穿透因此对它有效）')

    // ⑤ cenc_eqlist：真实整表 50 条
    const listRes = T.parseCencEqlistResult(listRaw)
    assert(listRes.ok === true && listRes.alerts.length === 50 && listRes.total === 50 && listRes.dropped === 0,
      '真实速报整表 50 条全部解析成功、零丢弃')
    assert(listRes.md5 === listRaw.md5 && listRes.md5.length === 32,
      'md5 指纹透出（"这批和上批一不一样"的判据）')
    const no1 = listRes.alerts[0]
    assert(no1.code === 'cenc_eqlist' && no1.speedReport === true && no1.kind === 'quake',
      '速报标记为 speedReport（阈值分档的依据）')
    assert(no1.magnitude === 3.7 && no1.geo.depthKm === 17 && no1.intensity === 5,
      '速报字段全是字符串 → 正确转成数值（magnitude/depth/intensity）')
    assert(no1.eventKey.indexOf('geo:2026-09-18T14:32@41.1,83.2') === 0,
      '速报的事件键把 +08:00 归一到 UTC（22:32 北京 → 14:32Z）')
    const overseas = listRes.alerts.find((a) => a.hypo.name === '福克斯群岛')
    assert(!!overseas && Math.abs(overseas.geo.lon + 171.4) < 1e-9 && overseas.magnitude === 6.5,
      '速报整表含境外地震且负经度正常解析（实测福克斯群岛 M6.5）')

    // ⑥ No 键必须是**数值序**（字典序会把 No10 排到 No2 前面）
    const mk = (id, mag) => ({ EventID: id, time: '2026-09-18 20:00:00', magnitude: String(mag), latitude: '30', longitude: '100' })
    const shuffled = { type: 'cenc_eqlist', No10: mk('C', 3), No2: mk('B', 3), No1: mk('A', 3) }
    assert(T.cencEqlistItems(shuffled).map((x) => x.EventID).join(',') === 'A,B,C',
      'No1…NoN 按数值序展开（字典序会让 No10 插到 No2 前面）')

    // ⑦ 一条坏条目不该让整表作废（0.4.2 对 551 观测点定过同一口径）
    const oneBad = JSON.parse(JSON.stringify(listRaw))
    oneBad.No7.latitude = ''
    const partialRes = T.parseCencEqlistResult(oneBad)
    assert(partialRes.ok === true && partialRes.alerts.length === 49 && partialRes.dropped === 1,
      '整表 50 条里 1 条坏 → 另外 49 条照常播报，丢弃数可见（不是静默）')
    assert(T.parseCencEqlistResult({ type: 'cenc_eqlist' }).kind === 'empty',
      '整表里一个 NoN 都没有 → empty')
    assert(T.parseCencEqlistResult({ type: 'cenc_eqlist', No1: { EventID: 'x' }, No2: { EventID: 'y' } }).kind === 'schema',
      '整表每一条都解析不出 → schema（源改版的信号）')

    // ⑧ 跨源归并：EEW 与速报对**同一场地震**（实测新龙县：EEW 20:50:23 M4.2 / 速报 20:50:24 M3.2）
    const eewXinlong = T.parseCencEew(eewRaw)
    const repXinlong = listRes.alerts.find((a) => a.hypo.name === '四川甘孜州新龙县' && a.magnitude === 3.2)
    assert(!!repXinlong, '（前置）速报里有同一场地震的那一条')
    assert(eewXinlong.eventKey === repXinlong.eventKey,
      '同一场地震：EEW 与速报归到**同一个事件键**（发震时刻差 1 秒、震中差 0.01°）')
    assert(eewXinlong.id !== repXinlong.id,
      '但两条消息 id 完全不同（EventID 是两套格式）——所以归并**只能**靠时间 + 震中')
    const usgsTwin = T.parseUsgsFeature({
      id: 'us6000twin',
      geometry: { coordinates: [-171.4, 52.85, 100] },
      properties: { mag: 6.5, time: Date.parse('2026-09-17T14:19:52Z'), place: 'Fox Islands' },
    })
    assert(overseas && usgsTwin.eventKey === overseas.eventKey,
      'CENC 速报与 USGS 对同一场境外地震 → 同一个事件键（UTC 归一，否则会差 8 小时永远不归并）')
    assert(T.geoEventKey('2026-09-17T22:19:52+08:00', 52.85, -171.4) ===
      T.geoEventKey('2026-09-17T14:19:52Z', 52.85, -171.4),
      'geoEventKey 自身对两种偏移给出同一把钥匙（回归：此前直接切字符串，永久失效）')
    assert(T.geoEventKey('乱码', 1, 2) === 'geo:乱码@1.0,2.0',
      '时间不可解析时退回原串切片，不抛错、不丢消息')

    // ⑨ 阈值分档：速报走 cnReportMagnitude，预警走 globalMagnitude
    const placeXinlong = {
      watch: { prefectures: [], cities: [], places: [{ name: '新龙', lat: 30.887, lon: 99.89, radiusKm: 100 }] },
      disasters: { earthquake: true, tsunami: true, weather: true },
      thresholds: { globalMagnitude: 3, cnReportMagnitude: 6, quakeScale: 40, eewScale: 45, tsunamiGrade: 'Watch' },
      dedupe: { windowMinutes: 10 },
    }
    const repHit = T.matchAlert(repXinlong, placeXinlong)
    assert(repHit.hit === false && repHit.reason.indexOf('速报震级阈值') !== -1,
      '速报 M3.2 用速报门槛 M6 → 不命中（证明它**没有**走 globalMagnitude M3）')
    const eewHit = T.matchAlert(eewXinlong, placeXinlong)
    assert(eewHit.hit === true && eewHit.reason.indexOf('距 新龙') !== -1,
      '同一条关注点下预警 M4.2 用全球门槛 M3 → 命中（两把旋钮互不干扰）')
    const tight = JSON.parse(JSON.stringify(placeXinlong))
    tight.thresholds.globalMagnitude = 4.5
    assert(T.matchAlert(eewXinlong, tight).hit === false, '预警门槛提到 M4.5 → 同一条不再命中')
    const loose = JSON.parse(JSON.stringify(placeXinlong))
    loose.thresholds.cnReportMagnitude = 3
    assert(T.matchAlert(repXinlong, loose).hit === true, '速报门槛放到 M3 → 速报命中')
    const far = JSON.parse(JSON.stringify(placeXinlong))
    far.watch.places = [{ name: '远处', lat: 20, lon: 90, radiusKm: 100 }]
    const farHit = T.matchAlert(eewXinlong, far)
    assert(farHit.hit === false && farHit.reason.indexOf('超过设定半径') !== -1,
      '震中在半径外 → 不命中，且理由里给出实际距离')
    const noPlace = JSON.parse(JSON.stringify(placeXinlong))
    noPlace.watch.places = []
    assert(T.matchAlert(eewXinlong, noPlace).hit === false && T.matchAlert(eewXinlong, noPlace).reason.indexOf('未设置') !== -1,
      '没有关注点 → 明确说明"未设置全球关注点"，而不是静默丢弃')

    // ⑩ 配置字段（DESIGN 11.6 第 10 条：加字段必须同时改 DEFAULT_CFG 与 normalizeCfg）
    assert(T.DEFAULT_CFG.thresholds.cnReportMagnitude === 4.5, '速报门槛默认 M4.5')
    assert(T.normalizeCfg({}).thresholds.cnReportMagnitude === 4.5, '缺字段 → 回退默认值')
    assert(T.normalizeCfg({ thresholds: { cnReportMagnitude: 7 } }).thresholds.cnReportMagnitude === 7,
      '已配置的值被保留（旧配置不会被清空）')
    assert(T.normalizeCfg({ thresholds: { cnReportMagnitude: 99 } }).thresholds.cnReportMagnitude === 10,
      '越界值夹取到上界')
    assert(T.normalizeCfg({ thresholds: { cnReportMagnitude: 'abc' } }).thresholds.cnReportMagnitude === 4.5,
      '垃圾值回退默认值')
    assert(T.CN_REPORT_MAG_OPTIONS.some((o) => o.v === 4.5),
      '设置页的速报门槛档位里有默认值（否则 UI 显示不出当前档）')

    // ⑪ 契约的 empty 判据必须"看起来就诚实"：未实测的样本情况写清楚了
    assert(T.SOURCE_CONTRACTS.cenc_eew.empty.indexOf('未实测') !== -1,
      'cenc_eew 的 empty 判据标注了证据等级（样本不足，不掩饰）')
    assert(T.SOURCE_CONTRACTS.cenc_eqlist.staleAfterMs === 48 * 60 * 60 * 1000,
      '速报的 48 小时新鲜度阈值是中继探针（唯一真正有意义的一条）')
    assert(T.SOURCE_CONTRACTS.cenc_eew.staleAfterMs === null,
      '预警本身不给新鲜度阈值（稀疏是常态，不能据此判死）')
  } catch (e) {
    assert(false, '0.5.0 大陆源检查失败：' + e.message)
  }

  // ==========================================================================
  // 0.5.0：大陆源的 Host 半边（WS 常连 / 环缓冲 / 去重 / 年龄闸门 / SSE）
  // 全部用注入的假 socket 与假定时器，不联网、不等真实心跳。
  // ==========================================================================
  try {
    const wx = await import(pathToFileURL(path.join(ROOT, 'lib', 'wolfx-source.js')).href)
    const host = await import(pathToFileURL(path.join(ROOT, 'lib', 'index.js')).href)
    const cnSample = (n) => JSON.parse(fs.readFileSync(path.join(ROOT, 'samples', 'cn', n), 'utf8'))

    // ---- 可推进的假时钟 + 假定时器队列 ----
    function makeSched(clock) {
      const q = new Map()
      let id = 0
      const api = {
        set(fn, ms) { const k = ++id; q.set(k, { fn, at: clock.t + (Number(ms) || 0) }); return k },
        clear(k) { q.delete(k) },
        size() { return q.size },
        runDue() {
          for (let guard = 0; guard < 500; guard++) {
            let best = null
            for (const [k, v] of q) if (v.at <= clock.t && (!best || v.at < best.v.at)) best = { k, v }
            if (!best) return
            q.delete(best.k)
            best.v.fn()
          }
        },
        advance(ms) { clock.t += ms; api.runDue() },
      }
      return api
    }
    function makeSocket() {
      const s = { sent: [], closed: false, failNext: false, send(m) { s.sent.push(m) }, close() { s.closed = true } }
      return s
    }
    /**
     * 建一个源 + 一批假件。
     * @param {string} id
     * @param {object} [options] 覆盖默认的"确定性"参数
     * @param {number} [startT] 假时钟起点。默认取速报样本里最新那条的发布时间附近；
     *   **预警的用例必须传更早的时刻**——真实 EEW 样本的发震时刻是 12:50Z，
     *   而预警的年龄闸门只有 10 分钟，起点不对会被闸门（正确地）挡掉。
     */
    function harness(id, options, startT) {
      const clock = { t: startT === undefined ? Date.parse('2026-09-18T14:40:00Z') : startT } // 北京 22:40
      const sched = makeSched(clock)
      const sockets = []
      const events = []
      const src = wx.createWolfxSource(Object.assign({
        id,
        now: () => clock.t,
        setTimer: (fn, ms) => sched.set(fn, ms),
        clearTimer: (k) => sched.clear(k),
        createSocket: () => { const s = makeSocket(); sockets.push(s); return s },
        idleMs: 0,
        firstDelayMs: 0,
        connectTimeoutMs: 0,
        heartbeatTimeoutMs: 0,
        onError: (e) => events.push(String(e && e.message)),
      }, options || {}))
      return { clock, sched, sockets, events, src }
    }
    /** 真实 EEW 样本的发震时刻（= 北京 20:50:23）。 */
    const EEW_ORIGIN_MS = Date.parse('2026-09-18T12:50:23Z')

    // ① 纯函数：帧 → entry（真实样本驱动）
    const eewRaw = cnSample('cenc-eew-last.json')
    const listRaw = cnSample('cenc-eqlist-last.json')
    const eewEntry = wx.cencEewEntry(eewRaw)
    assert(!!eewEntry && eewEntry.id === 'cenc:b4kybfnuqayyy' && eewEntry.dedupeKey === 'b4kybfnuqayyy@2',
      'EEW 帧 → entry，去重键是 ID@ReportNum（修订版必须能进缓冲）')
    assert(JSON.parse(eewEntry.payload).Magnitude === 4.2, 'entry.payload 是原始 JSON（Host 不改字段）')
    assert(eewEntry.updated === '2026-09-18T12:50:23.000Z',
      'updated 归一到 UTC（Host 侧与 Client 侧各自持有一份 +08:00 转换，见模块注释）')
    assert(wx.cencEewEntry({ type: 'cenc_eew' }) === null, '缺 ID / 坐标的帧 → null（不造空 entry）')
    const listEntries = wx.cencEqlistEntries(listRaw)
    assert(listEntries.length === 50 && listEntries[0].id === 'cenc:CD.20260918223231.903',
      '速报整表 → 50 条**逐条** entry（整表当一条会把 50 条老事件反复重推）')
    assert(listEntries[0].dedupeKey === 'CD.20260918223231.903@2026-09-18 22:37:38',
      '速报去重键是 EventID@ReportTime（修订版要能进来，与 USGS 的 id@updated 同一理由）')
    assert(wx.cencEqlistEntries({ No1: { EventID: 'x' } }).length === 0, '缺坐标的速报项被跳过')
    assert(wx.cencEqlistMd5(listRaw).length === 32, '整表 md5 指纹可读（只做短路用）')

    // ② 年龄闸门是"回放旧 EEW"的安全阀
    const nowMs = Date.parse('2026-09-18T14:40:00Z')
    assert(wx.isEventFreshEnough(nowMs - 60 * 1000, nowMs, 10 * 60 * 1000) === true, '1 分钟前的 EEW → 值得播报')
    assert(wx.isEventFreshEnough(nowMs - 3 * 24 * 3600 * 1000, nowMs, 10 * 60 * 1000) === false,
      '3 天前的 EEW → 不播报（连上时 Wolfx 会回放最后一条，可能已过去数天）')
    assert(wx.isEventFreshEnough(NaN, nowMs, 10 * 60 * 1000) === true,
      '时间不可解析时不替用户决定（不因缺时间丢掉消息）')

    // ③ 端到端（假 socket）：建连 → query 指令 → 收帧 → 入缓冲
    {
      const h = harness('cenc_eew', {}, EEW_ORIGIN_MS + 2 * 60 * 1000)
      h.src.start()
      h.sched.advance(0)
      assert(h.sockets.length === 1, 'start 后首次 tick 建连')
      const s = h.sockets[0]
      s.onopen()
      assert(s.sent[0] === 'query_cenceew',
        '连上后发**纯文本** query 指令，且指令名取自预设表（实测是 query_cenceew，' +
        '拼成 query_cenc_eew 不会有任何响应——错了却完全静默）')
      const got = []
      const unsub = h.src.subscribe((e) => got.push(e))
      s.onmessage({ data: JSON.stringify(eewRaw) })
      assert(got.length === 1 && got[0].xml.indexOf('b4kybfnuqayyy') !== -1, '订阅者立刻收到新 entry')
      const snap = h.src.snapshot(0)
      assert(snap.entries.length === 1 && snap.cursor > 0 && snap.reset === false,
        'entry 进了环缓冲（/feed 与 SSE 共用它）')
      assert(h.src.snapshot(0, { tail: true }).entries.length === 0, 'tail 只对齐位置、不回放')
      // 同一条再推：不去重就会让 Client 重复处理（且历史里重复）
      s.onmessage({ data: JSON.stringify(eewRaw) })
      assert(h.src.snapshot(0).entries.length === 1, '同一条（同 ReportNum）不重复入缓冲')
      // 修订版：ReportNum 递增必须能进来（按 ID 去重会把震级上修永久挡住 = 漏报）
      const rev = JSON.parse(JSON.stringify(eewRaw)); rev.ReportNum = 3; rev.Magnitude = 5.1
      s.onmessage({ data: JSON.stringify(rev) })
      assert(h.src.snapshot(0).entries.length === 2, '第 3 报（ReportNum 递增）能进缓冲')
      // 心跳不算数据帧
      const before = h.src.snapshot(0).entries.length
      s.onmessage({ data: JSON.stringify({ type: 'heartbeat', ver: 24, id: 'x', timestamp: 1 }) })
      assert(h.src.snapshot(0).entries.length === before, '心跳帧不产生 entry')
      // 结构不符 → 计入 errors（源改版与"没有地震"必须不同形）
      const errBefore = h.src.stats().errors
      s.onmessage({ data: JSON.stringify({ type: 'cenc_eew' }) })
      assert(h.src.stats().errors === errBefore + 1 && h.src.stats().schemaSkipped === 1,
        '结构不符的帧计入 errors（蓝点语义）')
      s.onmessage({ data: 'not json' })
      assert(h.src.stats().errors === errBefore + 2, '非 JSON 帧计入 errors')
      s.onmessage({ data: '123' })
      assert(h.src.stats().errors === errBefore + 2, '合法 JSON 但不是对象 → 静默跳过（不误算故障）')
      unsub()
      s.onmessage({ data: JSON.stringify(rev) })
      got.length = 0
      s.onmessage({ data: JSON.stringify(rev) })
      assert(got.length === 0, '取消订阅后不再回调')
      s.onclose({ code: 1006 })
      assert(h.sockets.length === 1 && h.sched.size() >= 1, '断线后安排重连（退避）')
      h.sched.advance(1000)
      assert(h.sockets.length === 2, '退避 1 秒后重新建连')
      assert(h.sockets[0].closed === true, '旧 socket 被真正关闭')
      // stop() 必须真的断开——不能像 Host 轮询器那样把在飞连接留着
      const cur = h.sockets[1]
      h.src.stop()
      assert(cur.closed === true, 'stop() 真的断开了在飞连接（DESIGN 11.6 第 4 条的同类缺口不重演）')
      const n = h.sockets.length
      h.sched.advance(10 * 60 * 1000)
      assert(h.sockets.length === n, 'stop 之后不再重连')
    }

    // ④ 年龄闸门 + 整表逐条去重（真实速报整表：50 条横跨约 20 天）
    {
      const h = harness('cenc_eqlist')
      h.src.markRead()
      h.src.start()
      h.sched.advance(0)
      const s = h.sockets[0]
      s.onopen()
      assert(s.sent[0] === 'query_cenceqlist', '速报用 query_cenceqlist 指令')
      s.onmessage({ data: JSON.stringify(listRaw) })
      const st = h.src.stats()
      assert(h.src.snapshot(0).entries.length === 3,
        '冷启动只放行 6 小时内的事件（北京 22:32/20:50/20:09 三条），其余 47 条记已见不入缓冲')
      assert(st.ageSkipped === 47 && st.lastAdded === 3, '被年龄闸门挡下的条数可见（不是静默丢弃）')
      assert(h.src.snapshot(0).entries[0].id === 'cenc:CD.20260918223231.903', '缓冲里第一条是最新的那条')
      // md5 短路：整表没变 → 一条都不再比对
      s.onmessage({ data: JSON.stringify(listRaw) })
      assert(h.src.snapshot(0).entries.length === 3 && h.src.stats().lastAdded === 0,
        '整表 md5 未变 → 直接短路（省掉 50 次逐条比对）')
      // 只改一条：只有那一条进来（证明"逐条"而不是"整表重推"）
      const changed = JSON.parse(JSON.stringify(listRaw))
      changed.No1.ReportTime = '2026-09-18 22:45:00'
      changed.md5 = 'ffffffffffffffffffffffffffffffff'
      s.onmessage({ data: JSON.stringify(changed) })
      assert(h.src.snapshot(0).entries.length === 4 && h.src.stats().lastAdded === 1,
        '一处修订 → 只推那一条（整表当一条 entry 会重推 50 条）')
      // md5 缺失也不能漏：指纹只是短路，不是正确性依赖
      const noMd5 = JSON.parse(JSON.stringify(listRaw))
      delete noMd5.md5
      noMd5.No2.ReportTime = '2026-09-18 22:46:00'
      s.onmessage({ data: JSON.stringify(noMd5) })
      assert(h.src.stats().lastAdded === 1, 'md5 缺失时照常逐条去重（指纹不可用不会造成漏报）')
      // 停更判定探的是中继：整表最新事件距今超过 48 小时 → stale。
      // 这里的年龄闸门**保持默认（6 小时）**，因为要同时验证那个易错点：
      // 被年龄闸门挡下的条目也必须更新 dataTime，否则冷启动时这条探针永远不会触发
      // （独立复验真实数据时发现的：原实现只在条目入缓冲时更新 dataTime）。
      const clock2 = { t: Date.parse('2026-09-21T00:00:00Z') }
      const sched2 = makeSched(clock2)
      const sockets2 = []
      const src2 = wx.createWolfxSource({
        id: 'cenc_eqlist', now: () => clock2.t,
        setTimer: (f, m) => sched2.set(f, m), clearTimer: (k) => sched2.clear(k),
        createSocket: () => { const x = makeSocket(); sockets2.push(x); return x },
        idleMs: 0, firstDelayMs: 0, connectTimeoutMs: 0, heartbeatTimeoutMs: 0,
      })
      src2.markRead(); src2.start(); sched2.advance(0)
      sockets2[0].onopen()
      sockets2[0].onmessage({ data: JSON.stringify(listRaw) })
      assert(src2.stats().stale === true, '整表最新事件距今超 48 小时 → 判定中继停更（只有速报能做这个探针）')
      assert(src2.stats().ageSkipped === 50 && src2.snapshot(0).entries.length === 0,
        '同一批数据全部被年龄闸门挡下（2 天前的速报没有播报价值）')
      assert(src2.stats().dataTime === Date.parse('2026-09-18T14:32:31Z'),
        '被挡下的条目仍要更新 dataTime —— 否则冷启动时"中继停更"永远不会被发现')
      const freshList = JSON.parse(JSON.stringify(listRaw))
      freshList.No1.time = '2026-09-20 23:30:00'
      freshList.No1.ReportTime = '2026-09-20 23:35:00'
      freshList.md5 = 'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee'
      sockets2[0].onmessage({ data: JSON.stringify(freshList) })
      assert(src2.stats().stale === false && src2.stats().staleSince === 0,
        '有新鲜数据后 stale 复位（否则蓝点会永久挂着）')
      // 真正落在 6 小时窗口内的事件必须进缓冲（闸门只挡旧的，不挡新的）。
      // 北京 09-21 02:30 = 18:30Z，距 09-21 00:00Z 是 5.5 小时，在窗口内。
      const liveList = JSON.parse(JSON.stringify(listRaw))
      liveList.No1.time = '2026-09-21 02:30:00'
      liveList.No1.ReportTime = '2026-09-21 02:35:00'
      liveList.No1.EventID = 'CD.20260921023000.001'
      liveList.md5 = 'dddddddddddddddddddddddddddddddd'
      sockets2[0].onmessage({ data: JSON.stringify(liveList) })
      assert(src2.snapshot(0).entries.length === 1 && src2.stats().lastAdded === 1,
        '窗口内的新事件照常进缓冲（闸门是"时效闸门"，不是"一律不推"）')
    }

    // ④b 停更探针必须由**时钟**推动，不能只在"内容有变化的帧"上求值（0.5.1 修）
    // 中继停更的两种真实形态都不产生"有变化的新帧"：① 转发同一张旧表（被 md5 短路）；
    // ② 干脆不再推数据帧。只在收帧时算一次的话，这个探针在最需要它的时候永远停在 false。
    {
      // ① md5 未变（中继一直转发同一张旧表）
      const clock3 = { t: Date.parse('2026-09-18T15:32:31Z') } // 距表内最新事件 1 小时
      const sched3 = makeSched(clock3)
      const sockets3 = []
      const src3 = wx.createWolfxSource({
        id: 'cenc_eqlist', now: () => clock3.t,
        setTimer: (f, m) => sched3.set(f, m), clearTimer: (k) => sched3.clear(k),
        createSocket: () => { const x = makeSocket(); sockets3.push(x); return x },
        idleMs: 0, firstDelayMs: 0, connectTimeoutMs: 0, heartbeatTimeoutMs: 0,
      })
      src3.markRead(); src3.start(); sched3.advance(0)
      sockets3[0].onopen()
      sockets3[0].onmessage({ data: JSON.stringify(listRaw) })
      assert(src3.stats().stale === false, '（前置）距最新事件 1 小时 → 不判停更')
      clock3.t += 50 * 60 * 60 * 1000
      sockets3[0].onmessage({ data: JSON.stringify(listRaw) }) // 同一帧：md5 相同 → 走短路分支
      assert(src3.stats().stale === true && src3.stats().staleSince > 0,
        '整表 md5 未变但时钟走过 50 小时 → 仍要判停更（md5 短路只该省掉逐条比对，不能连探针一起跳过）')

      // ② 中继不再推任何数据帧（"连得上但停更 4 个月"那种形态）：只能靠例行检查推动
      const clock4 = { t: Date.parse('2026-09-18T15:32:31Z') }
      const sched4 = makeSched(clock4)
      const sockets4 = []
      const src4 = wx.createWolfxSource({
        id: 'cenc_eqlist', now: () => clock4.t,
        setTimer: (f, m) => sched4.set(f, m), clearTimer: (k) => sched4.clear(k),
        createSocket: () => { const x = makeSocket(); sockets4.push(x); return x },
        idleMs: 0, firstDelayMs: 0, connectTimeoutMs: 0, heartbeatTimeoutMs: 0,
      })
      src4.markRead(); src4.start(); sched4.advance(0)
      sockets4[0].onopen()
      sockets4[0].onmessage({ data: JSON.stringify(listRaw) })
      assert(src4.stats().stale === false, '（前置）不 stale')
      clock4.t += 50 * 60 * 60 * 1000
      src4.housekeeping() // 心跳定时器驱动的例行检查（这里手动跑一次，不真等 30 秒）
      assert(src4.stats().stale === true,
        '中继不再推任何帧时，停更由例行检查（时钟）推动 —— 心跳检查关掉也不该把它一起关掉')
    }

    // ④c 静默失效与速率约束（0.5.1 修）
    {
      // 整表"有 NoN 项却一条都解析不出来"必须与"空表"**不同形**（DESIGN 4.5）：字段改名会让
      // 整表 50 条全被丢弃，而它此前 errors 不涨、dataTime 停在 0，用户看到绿色"已连接"
      // 却一条都收不到 —— 正是最不该静默的那一类失败。
      const h = harness('cenc_eqlist')
      h.src.markRead(); h.src.start(); h.sched.advance(0)
      const s = h.sockets[0]
      s.onopen()
      const renamed = JSON.parse(JSON.stringify(listRaw))
      for (const k of Object.keys(renamed)) {
        if (/^No\d+$/.test(k)) { renamed[k].Latitude = renamed[k].latitude; delete renamed[k].latitude }
      }
      const errBefore = h.src.stats().errors
      s.onmessage({ data: JSON.stringify(renamed) })
      assert(h.src.stats().errors === errBefore + 1 && h.src.stats().schemaSkipped === 1,
        '整表有 NoN 项但全部解析失败 → 计入 errors（与"空表是正常的"必须不同形）')
      // 对照：真正的空表仍走"正常但没数据"，不计失败
      const err2 = h.src.stats().errors
      s.onmessage({ data: JSON.stringify({ type: 'cenc_eqlist' }) })
      assert(h.src.stats().errors === err2, '空表仍不计失败（源正常但当前没有速报数据）')
      h.src.stop()

      // pruneSeen 必须真的被调用：TTL 是"记忆时长"而不是装饰（poller 每轮清一次）
      const h2 = harness('cenc_eqlist', { seenTtlMs: 1000 })
      h2.src.markRead(); h2.src.start(); h2.sched.advance(0)
      const s2 = h2.sockets[0]
      s2.onopen()
      s2.onmessage({ data: JSON.stringify(listRaw) })
      const added1 = h2.src.stats().lastAdded
      assert(added1 === 3, '（前置）冷启动放行窗口内的 3 条')
      s2.onmessage({ data: JSON.stringify(listRaw) })
      assert(h2.src.stats().lastAdded === 0, '（前置）md5 未变 → 短路，无新增')
      h2.clock.t += 100 * 1000 // 远超 1 秒的 TTL
      const changed = JSON.parse(JSON.stringify(listRaw))
      changed.md5 = 'zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz' // 绕过 md5 短路，逼它逐条比对
      s2.onmessage({ data: JSON.stringify(changed) })
      assert(h2.src.stats().lastAdded === added1,
        '去重键过了 TTL 之后重新入缓冲（pruneSeen 真的被调用，seenTtlMs 不是假选项）')
      h2.src.stop()

      // markRead 不能把正在等待的退避重置为 0：/feed 每 15 秒调一次它，否则"上游连不上时
      // 不能死循环猛敲"（DESIGN 5.3）这条约束会被压平成 15 秒。
      const h3 = harness('cenc_eew')
      h3.src.markRead(); h3.src.start(); h3.sched.advance(0)
      h3.sockets[0].onopen()
      h3.sockets[0].onclose({ code: 1006 }) // 断开 → 排 1 秒退避
      const n3 = h3.sockets.length
      h3.clock.t += 500 // 退避还没到点
      h3.src.markRead() // 模拟 /feed 的一次读取
      h3.sched.advance(0)
      assert(h3.sockets.length === n3, 'markRead 不取消正在等待的退避（否则退避被压平成 /feed 周期）')
      h3.sched.advance(600)
      assert(h3.sockets.length === n3 + 1, '退避到点后照常重连')
      h3.src.stop()

      // 空闲断开是正常行为，不该被写成 lastError（排障脚本会把它当故障打印）
      const h4 = harness('cenc_eqlist', { idleMs: 60 * 1000 })
      h4.src.markRead(); h4.src.start(); h4.sched.advance(0)
      h4.sockets[0].onopen()
      h4.clock.t += 120 * 1000
      h4.src.housekeeping()
      assert(h4.src.stats().idleSkips >= 1 && h4.src.stats().lastError === '',
        '空闲断开只计 idleSkips，不写 lastError（它不是故障）')
      h4.src.stop()
    }

    // ⑤ 心跳看门狗 + 空闲断开
    {
      const h = harness('cenc_eew', { heartbeatTimeoutMs: 120 * 1000, heartbeatCheckMs: 30 * 1000 })
      h.src.markRead()
      h.src.start()
      h.sched.advance(0)
      h.sockets[0].onopen()
      h.sched.advance(30 * 1000)
      assert(h.sockets.length === 1, '每 30 秒心跳一次、有消息时不断连')
      h.sockets[0].onmessage({ data: JSON.stringify({ type: 'heartbeat' }) })
      h.sched.advance(150 * 1000)
      assert(h.sockets[0].closed === true, '超过 120 秒没有任何消息 → 判定连接已死并主动断开（半开连接不会给事件）')
      h.sched.advance(1000) // 退避 1 秒后才重连
      assert(h.sockets.length === 2, '断开后按退避重连')
      assert(h.events.some((m) => m.indexOf('心跳超时') !== -1), '心跳超时落一条可读的错误（供诊断文档引用）')

      // 空闲：没人读就**不建连**，有人读时立刻补上
      const idle = harness('cenc_eew', { idleMs: 10 * 60 * 1000 })
      idle.src.start()
      idle.sched.advance(0)
      assert(idle.sockets.length === 0, '没有任何人读 → 不建连（不为无人看管的页面白占 Wolfx 配额）')
      assert(idle.src.stats().idleSkips === 1, '空闲跳过被计数（可见）')
      idle.src.markRead()
      idle.sched.advance(0)
      assert(idle.sockets.length === 1, '有人读之后立刻建连（不让刚打开页面的用户白等）')
      // 有活跃订阅者时不算空闲——否则十分钟后会把正在推流的连接掐掉。
      // 心跳超时设成 1 小时，让这条用例只考察"空闲判定"这一件事。
      const idle2 = harness('cenc_eew', { idleMs: 60 * 1000, heartbeatTimeoutMs: 60 * 60 * 1000, heartbeatCheckMs: 30 * 1000 })
      idle2.src.start()
      idle2.src.markRead()
      idle2.sched.advance(0)
      idle2.sockets[0].onopen()
      idle2.src.subscribe(() => {})
      idle2.sched.advance(10 * 60 * 1000)
      assert(idle2.sockets.length === 1 && idle2.sockets[0].closed === false,
        '有活跃订阅者时不当成空闲（SSE 长连接只在订阅那一刻刷新过 lastReadAt）')
      // 对照组：同样的参数、同样的时长，但没有订阅者 → 必须断开（证明上一条不是因为"从不断开"）
      const idle3 = harness('cenc_eew', { idleMs: 60 * 1000, heartbeatTimeoutMs: 60 * 60 * 1000, heartbeatCheckMs: 30 * 1000 })
      idle3.src.start()
      idle3.src.markRead()
      idle3.sched.advance(0)
      idle3.sockets[0].onopen()
      idle3.sched.advance(10 * 60 * 1000)
      assert(idle3.sockets[0].closed === true,
        '（对照）没有订阅者时同样时长会主动断开——不为无人看管的页面白占 Wolfx 的连接配额')
    }

    // ⑥ 建连看门狗：15 秒没 open → 放弃重连（否则状态永远停在"连接中"）
    {
      const h = harness('cenc_eew', { connectTimeoutMs: 15 * 1000 })
      h.src.markRead()
      h.src.start()
      h.sched.advance(0)
      assert(h.sockets.length === 1 && h.sockets[0].closed === false, '（前置）已发起连接')
      h.sched.advance(16 * 1000)
      assert(h.sockets[0].closed === true, '建连超时 → 关闭半开连接')
      h.sched.advance(1000)
      assert(h.sockets.length === 2, '建连超时后按退避重连')
      assert(h.events.some((m) => m.indexOf('建连超时') !== -1), '建连超时落一条可读的错误')
    }

    // ⑦ SSE 帧格式（纯函数）
    assert(host.sseFrame('entry', { a: 1 }, 7) === 'id: 7\nevent: entry\ndata: {"a":1}\n\n',
      'SSE 帧：id + event + data + 空行结束')
    assert(host.sseFrame('', 'x').indexOf('event:') === -1, '没有事件名时不写 event 行')
    assert(host.sseFrame('x', 'a\nb') === 'event: x\ndata: "a\\nb"\n\n',
      'JSON 里的换行是转义的，不会把帧结构撑破')

    // ⑧ /stream 路由：首帧 sync → 补发环缓冲 → 实况推送 → 断开清理
    {
      function fakeRes() {
        return {
          status: 0, headers: null, frames: [], writableEnded: false, headersSent: false,
          writeHead(s, h) { this.status = s; this.headers = h; this.headersSent = true },
          write(b) { this.frames.push(b) },
          end() { this.writableEnded = true },
          on(ev, fn) { if (ev === 'close') this.onClose = fn },
        }
      }
      const src = {
        reads: 0, snaps: [], subs: [],
        markRead() { this.reads++ },
        snapshot(since, o) {
          this.snaps.push([since, !!o && o.tail === true])
          if (o && o.tail) return { cursor: 100, entries: [], truncated: false, reset: false, frozen: false }
          return {
            cursor: 100, reset: false, truncated: false, frozen: false,
            entries: [{ seq: 99, id: 'cenc:x', title: 't', updated: '', xml: '{"a":1}' }],
          }
        },
        subscribe(fn) { this.subs.push(fn); return () => { this.subs = this.subs.filter((f) => f !== fn) } },
      }
      const handler = host.createStreamHandler({
        sources: { cenc_eew: src },
        keepAliveMs: 1000,
        setInterval: () => 1,
        clearInterval: () => {},
      })
      const res = fakeRes()
      // 带 since → 走"补发环缓冲"那条分支（tail 分支由后面 src4 的断言单独覆盖）
      handler({ url: '/dsh-quake-alert/stream?source=cenc_eew&since=50', headers: {} }, res)
      assert(res.status === 200 && res.headers['content-type'].indexOf('text/event-stream') === 0,
        '/stream 返回 200 + text/event-stream（该类型在 dsh-host-webserver 里被显式跳过压缩）')
      assert(res.frames[0].indexOf('event: sync') === 0 && res.frames[0].indexOf('"cursor":100') !== -1,
        '首帧是 sync（告诉 Client 游标与缓冲状态，供诊断与判断要不要改走 /feed）')
      assert(res.frames[0].indexOf('"stale":false') !== -1 && res.frames[0].indexOf('"dataTime":null') !== -1,
        'sync 首帧带上数据健康（这个假源没有 stats()，按"不 stale"兜底——诊断字段缺失不该把整条流弄断）')
      assert(res.frames[1].indexOf('id: 99') === 0 && res.frames[1].indexOf('event: entry') !== -1,
        '随后按 seq 补发环缓冲里的条目（断线补齐，靠 id: 让浏览器重连时带回）')
      assert(src.reads === 1 && src.subs.length === 1, '订阅会 markRead（保持 WS 存活）并挂上订阅者')
      src.subs[0]({ seq: 101, id: 'cenc:y', title: 't2', updated: '', xml: '{"b":2}' })
      assert(res.frames.length === 3 && res.frames[2].indexOf('id: 101') === 0, '实况 entry 立刻推给订阅者')
      // 页面关闭 → 必须清掉订阅与心跳，否则 Host 会一直为已关闭的页面推流
      res.onClose()
      const n = res.frames.length
      src.subs.length = 0
      assert(src.subs.length === 0, '断开后订阅被清掉')
      assert(res.frames.length === n, '断开后不再写帧')

      // Last-Event-ID 优先于 ?since=（重连时浏览器自动带上，比页面首次那次的游标新）
      const src2 = Object.assign({}, src, { snaps: [], reads: 0, subs: [] })
      const h2 = host.createStreamHandler({ sources: { cenc_eew: src2 }, setInterval: () => 1, clearInterval: () => {} })
      const r2 = fakeRes()
      h2({ url: '/dsh-quake-alert/stream?source=cenc_eew&since=42', headers: { 'last-event-id': '55' } }, r2)
      assert(src2.snaps[0][0] === 55 && src2.snaps[0][1] === false, 'Last-Event-ID 优先（55 > 42）')
      const src3 = Object.assign({}, src, { snaps: [], reads: 0, subs: [] })
      const h3 = host.createStreamHandler({ sources: { cenc_eew: src3 }, setInterval: () => 1, clearInterval: () => {} })
      const r3 = fakeRes()
      h3({ url: '/dsh-quake-alert/stream?source=cenc_eew&since=42', headers: {} }, r3)
      assert(src3.snaps[0][0] === 42, '没有 Last-Event-ID 时用页面带来的持久化游标')
      const src4 = Object.assign({}, src, { snaps: [], reads: 0, subs: [] })
      const h4 = host.createStreamHandler({ sources: { cenc_eew: src4 }, setInterval: () => 1, clearInterval: () => {} })
      const r4 = fakeRes()
      h4({ url: '/dsh-quake-alert/stream?source=cenc_eew', headers: {} }, r4)
      assert(src4.snaps[0][1] === true, '什么游标都没有 → tail（不把几小时前的旧警报当新闻重放）')

      // 参数校验与跨站防护
      const bad = fakeRes()
      handler({ url: '/dsh-quake-alert/stream?source=constructor', headers: {} }, bad)
      assert(bad.status === 400, '未知源（含原型链键 constructor）→ 400，不静默退回某个源')
      const noSrc = fakeRes()
      handler({ url: '/dsh-quake-alert/stream', headers: {} }, noSrc)
      assert(noSrc.status === 400, '缺 source → 400（/stream 没有默认源）')
      const h5 = host.createStreamHandler({ sources: { cenc_eew: src }, isCrossSite: () => true })
      const cs = fakeRes()
      h5({ url: '/dsh-quake-alert/stream?source=cenc_eew', headers: {} }, cs)
      assert(cs.status === 403, '跨站请求被拒绝（这条路由有保持外部连接的副作用）')

      // keep-alive 帧同时承载**停更状态**（0.5.0 的 48 小时停更探针在默认路径上的可见性）。
      // 停更的形态就是"不再有新 entry"，只看 sync / entry 的话状态会永远停在连接那一刻；
      // 而"源可达但数据是旧的"与"这几天确实没有地震"在 Client 侧长得一模一样，只能由 Host 判。
      const tickers = []
      const srcS = {
        markRead() {},
        snapshot() { return { cursor: 7, entries: [], truncated: false, reset: false, frozen: false } },
        subscribe() { return () => {} },
        stats() { return { cursor: 7, stale: true, dataTime: 1700000000000 } },
      }
      const hS = host.createStreamHandler({
        sources: { cenc_eqlist: srcS },
        keepAliveMs: 1000,
        setInterval: (fn) => { tickers.push(fn); return tickers.length },
        clearInterval: () => {},
      })
      const rS = fakeRes()
      hS({ url: '/dsh-quake-alert/stream?source=cenc_eqlist', headers: {} }, rS)
      assert(rS.frames[0].indexOf('"stale":true') !== -1 && rS.frames[0].indexOf('"dataTime":1700000000000') !== -1,
        'sync 首帧把 Host 判定的 stale / dataTime 带给 Client')
      assert(tickers.length === 1, 'keep-alive 定时器已排上')
      tickers[0]()
      const ka = rS.frames[rS.frames.length - 1]
      assert(ka.indexOf('event: status') === 0 && ka.indexOf('"stale":true') !== -1,
        '周期 status 帧兼作 keep-alive：停更状态必须由 Host 推，否则 SSE 路径下它在界面上永远不可见')
    }

    // ⑨ 两个源都进了同一张 pollers 表 → /feed?source=cenc_* 天然可用（这就是 WS→HTTP 降级通道）
    assert(wx.WOLFX_SOURCES.cenc_eew.staleAfterMs === 0 && wx.WOLFX_SOURCES.cenc_eqlist.staleAfterMs === 48 * 3600 * 1000,
      '契约：预警不给新鲜度阈值（稀疏是常态）、速报 48 小时（探中继）')
    assert(wx.MAX_EVENT_AGE_MS.cenc_eew === 10 * 60 * 1000 && wx.MAX_EVENT_AGE_MS.cenc_eqlist === 6 * 3600 * 1000,
      '契约：事件年龄闸门 预警 10 分钟 / 速报 6 小时')
    assert(wx.WOLFX_WS_BASE === 'wss://ws-api.wolfx.jp/' && wx.WOLFX_REST_BASE === 'https://api.wolfx.jp/',
      'WS 与 REST 两个端点都记在常量里（REST 是降级通道）')
  } catch (e) {
    assert(false, '0.5.0 Host 半边检查失败：' + e.message + '\n' + (e && e.stack ? e.stack.split('\n').slice(1, 3).join('\n') : ''))
  }

  // ==========================================================================
  // 0.5.0：大陆源的 Client 半边（SSE 消费 / 降级 / 贯通主链 / 文案）
  // EventSource 与定时器全部注入，不联网、不真等 8 秒探针。
  // ==========================================================================
  try {
    const eewRaw = JSON.parse(fs.readFileSync(path.join(ROOT, 'samples', 'cn', 'cenc-eew-last.json'), 'utf8'))
    const listRaw = JSON.parse(fs.readFileSync(path.join(ROOT, 'samples', 'cn', 'cenc-eqlist-last.json'), 'utf8'))

    function makeSched2(clock) {
      const q = new Map()
      let id = 0
      const api = {
        set(fn, ms) { const k = ++id; q.set(k, { fn, at: clock.t + (Number(ms) || 0) }); return k },
        clear(k) { q.delete(k) },
        runDue() {
          for (let guard = 0; guard < 500; guard++) {
            let best = null
            for (const [k, v] of q) if (v.at <= clock.t && (!best || v.at < best.v.at)) best = { k, v }
            if (!best) return
            q.delete(best.k)
            best.v.fn()
          }
        },
        advance(ms) { clock.t += ms; api.runDue() },
      }
      return api
    }
    function fakeES(url) {
      const es = {
        url: url, listeners: {}, closed: false,
        addEventListener(type, fn) { (es.listeners[type] = es.listeners[type] || []).push(fn) },
        close() { es.closed = true },
        emit(type, data, id) {
          for (const fn of (es.listeners[type] || []).slice()) {
            fn({ data: data === undefined ? undefined : JSON.stringify(data), lastEventId: id === undefined ? '' : String(id) })
          }
        },
        emitRaw(type, raw) { for (const fn of (es.listeners[type] || []).slice()) fn({ data: raw }) },
      }
      return es
    }
    /** 建一个 SSE 客户端 + 假件。 */
    function cnHarness(opts2) {
      const clock = { t: 1000000 }
      const sched = makeSched2(clock)
      const o = opts2 || {}
      const created = []
      const fallbacks = []
      const statuses = []
      const saved = []
      let cfg = o.cfg || { disasters: { earthquake: true, tsunami: true, weather: true } }
      const client = T.createCnStream(Object.assign({
        id: 'cenc_eew',
        createEventSource: (url) => { const es = fakeES(url); created.push(es); return es },
        setTimer: (fn, ms) => sched.set(fn, ms),
        clearTimer: (k) => sched.clear(k),
        getCfg: () => cfg,
        enabled: (c) => (c.disasters || {}).earthquake !== false,
        loadCursor: () => (o.cursor === undefined ? null : o.cursor),
        saveCursor: (v) => saved.push(v),
        apply: o.apply || (() => true),
        onStatus: (p) => statuses.push(p),
        onError: () => {},
        createFallback: () => {
          const f = { starts: 0, stops: 0, start() { f.starts += 1; fallbacks.push('start') }, stop() { f.stops += 1; fallbacks.push('stop') } }
          return f
        },
      }, o.over || {}))
      return { clock, sched, created, fallbacks, statuses, saved, client, setCfg: (c) => { cfg = c }, getCfgRef: () => cfg }
    }

    // ① 基本链路：建连 → 首帧 sync → entry → 游标前进并落盘
    {
      const h = cnHarness({})
      h.client.start()
      assert(h.created.length === 1 && h.client.modeOf() === 'sse', '启动后建立 SSE 连接')
      assert(h.created[0].url.indexOf('source=cenc_eew') !== -1,
        'SSE URL 带 source 分派（与 Host 的 /stream?source= 对应）')
      assert(h.created[0].url.indexOf('since=tail') !== -1,
        '首次没有游标 → since=tail（只对齐位置，不把 Host 缓冲里的旧警报当新闻重放）')
      h.created[0].emit('sync', { source: 'cenc_eew', cursor: 500, reset: false, truncated: false, frozen: false, replayed: 0 })
      assert(h.client.cursor() === 500 && h.saved.indexOf(500) !== -1,
        '没有补发条目 → 游标对齐到 Host 当前位置并落盘')
      assert(h.statuses.some((p) => p.status === 'open'), '首帧到达 → 上报 open（侧边栏不再是灰的）')
      h.created[0].emit('entry', { seq: 501, id: 'cenc:x', xml: '{"a":1}' })
      assert(h.client.cursor() === 501, '游标跟着 entry 的 seq 前进')
      assert(h.saved[h.saved.length - 1] === 501, '每条 entry 都推进落盘的游标')
      // 回退保护：SSE 的补发与实况可能交错到达
      h.created[0].emit('entry', { seq: 400, id: 'cenc:y', xml: '{}' })
      assert(h.client.cursor() === 501, '游标只前进（回退会让"断线补齐"重复投递）')
      // 坏帧：计入数据健康，但不影响后续条目
      h.created[0].emitRaw('entry', 'not json')
      assert(!!T.sourceHealthOf('cenc_eew'), 'SSE 帧不是合法 JSON → 计入数据健康（蓝点语义）')
      T.resetSourceHealth()
      h.created[0].emit('entry', { seq: 502, id: 'cenc:z', xml: '{}' })
      assert(h.client.cursor() === 502, '坏帧之后照常继续处理（不让游标停住）')
      // status 帧（Host 每 15 秒推一次，兼作 keep-alive）：停更只能由 Host 告知 ——
      // "源可达但数据是旧的"与"这几天确实没有地震"在 Client 侧长得一模一样。
      const nStatus = h.statuses.length
      h.created[0].emit('status', { source: 'cenc_eew', cursor: 502, stale: true, dataTime: 1700000000000 })
      assert(h.statuses.length === nStatus + 1 && h.statuses[h.statuses.length - 1].status === 'stale',
        'Host 的 status 帧说停更 → 上报 stale（中灰「数据已过期」，不折叠进 degraded）')
      assert(h.client.stats().stale === true, 'stale 进入 stats（诊断快照与源状态行要能读到）')
      h.created[0].emit('status', { source: 'cenc_eew', cursor: 503, stale: false, dataTime: 0 })
      assert(h.statuses[h.statuses.length - 1].status === 'open', '恢复新鲜 → 回到 open（中灰点不会永久挂着）')
      // status 帧不能顶替"最近一条数据"的时刻，否则设置页会一直显示"最近数据 0 秒前"，
      // 恰好把"其实很久没有数据了"盖掉
      const lastAtBefore = h.client.stats().lastAt
      h.created[0].emit('status', { source: 'cenc_eew', stale: false })
      assert(h.client.stats().lastAt === lastAtBefore, 'status 帧不更新 lastAt（它表示"最近一条数据"）')
      h.client.stop()
      assert(h.created[0].closed === true, 'stop() 关掉在飞的 EventSource')

      // 首帧 sync 就带 stale 时也要认（连接那一刻上游已经是旧的）
      const h2 = cnHarness({})
      h2.client.start()
      h2.created[0].emit('sync', {
        source: 'cenc_eew', cursor: 9, reset: false, truncated: false, frozen: false, replayed: 0,
        stale: true, dataTime: 1700000000000,
      })
      assert(h2.statuses.some((p) => p.status === 'stale'), 'sync 首帧带 stale → 直接上报 stale')
      h2.client.stop()
    }

    // ①b 状态帧不得抹掉 sync 的告警；降级客户端必须与 SSE 共用游标键（0.5.1 修）
    {
      // store.pushSource 是整体替换 status + detail 的，而 status 帧每 15 秒就来一次：
      // 若它只报"已连接"，sync 那一刻报出的"增量缺口 / 游标重置 / Host 未运行"会在 15 秒后
      // 自己消失——而它们的条件其实仍然成立。
      const h = cnHarness({})
      h.client.start()
      h.created[0].emit('sync', {
        source: 'cenc_eew', cursor: 5, reset: true, truncated: true, frozen: true, replayed: 3, stale: false,
      })
      const lastOf = (x) => x.statuses[x.statuses.length - 1]
      assert(lastOf(h).status === 'degraded' && lastOf(h).detail.indexOf('增量缺口') !== -1,
        'sync 的告警先上报（增量缺口 / 游标重置 / Host 未运行）')
      h.created[0].emit('status', { source: 'cenc_eew', cursor: 6, stale: false, dataTime: 0 })
      assert(lastOf(h).status === 'degraded' && lastOf(h).detail.indexOf('增量缺口') !== -1,
        'status 帧不得把 sync 的告警抹成"已连接"（条件仍然成立）')
      h.client.stop()

      // 降级客户端必须继承 SSE 的游标：否则降级瞬间从 `since=tail` 起步，
      // SSE 挂掉到降级生效之间 Host 缓冲里的条目会被静默跳过（真实的漏报窗口）。
      const captured = []
      const h2 = cnHarness({ cursor: 501, over: {
        // 覆盖掉 harness 默认的假 createFallback，逼它走 12c 的**默认降级工厂**
        //（游标键就在那条路径上，用假工厂测不到）
        createFallback: undefined,
        createFeedClient: (o) => { captured.push(o); return { start() {}, stop() {} } },
      } })
      h2.client.start()
      h2.created[0].emitRaw('error', '')
      h2.created[0].emitRaw('error', '')
      h2.created[0].emitRaw('error', '')
      assert(h2.client.modeOf() === 'poll' && captured.length === 1, '连续拿不到首帧 → 降级并建立轮询客户端')
      assert(captured[0].cursorKey === T.CN_CURSOR_KEY + '.cenc_eew',
        '降级客户端与 SSE 共用同一个游标键（否则降级期间会静默跳过一段条目）')
      h2.client.stop()
    }

    // ①c Host 说"游标重置过"时必须允许回退（0.5.1 修 D 类残留）
    {
      const h = cnHarness({ cursor: 900 })
      h.client.start()
      assert(h.client.cursor() === 900, '（前置）从持久化游标起步')
      h.created[0].emit('sync', {
        source: 'cenc_eew', cursor: 300, reset: true, truncated: false, frozen: false, replayed: 0, stale: false,
      })
      assert(h.client.cursor() === 300,
        'Host 明确 reset → 游标回退到它的当前位置（否则本地卡在更大的值上，每次重连都全量重放）')
      // 没有 reset 时仍然只前进——防止把"回退保护"一起改坏
      h.created[0].emit('entry', { seq: 200, id: 'cenc:old', xml: '{}' })
      assert(h.client.cursor() === 300, '没有 reset 时游标仍然只前进（回退会让"断线补齐"重复投递）')
      h.client.stop()
    }

    // ② 页面刷新：从持久化游标续传，不重放
    {
      const h = cnHarness({ cursor: 501 })
      h.client.start()
      assert(h.created[0].url.indexOf('since=501') !== -1, '有持久化游标 → 续传（刷新页面不会重放已消费的增量）')
      assert(h.client.hasCursor() === true, '有游标时不再走 tail')
      h.client.stop()
    }

    // ③ 降级：连续失败 / 环境没有 EventSource / 连上但不推流
    {
      const h = cnHarness({ over: { maxFails: 3 } })
      h.client.start()
      h.created[0].emitRaw('error', '')
      h.created[0].emitRaw('error', '')
      assert(h.client.modeOf() === 'sse' && h.fallbacks.length === 0,
        '偶尔出错不降级（EventSource 自己会重连，过早降级会白白丢掉秒级延迟）')
      h.created[0].emitRaw('error', '')
      assert(h.client.modeOf() === 'poll' && h.fallbacks.indexOf('start') !== -1,
        '连续 3 次都没收到首帧 → 降级为轮询')
      assert(h.statuses.some((p) => p.status === 'degraded' && p.detail.indexOf('降级') !== -1),
        '降级必须**说出来**（否则用户看到"一切正常"却收不到大陆预警——本插件最不能接受的形态）')

      const h2 = cnHarness({ over: { createEventSource: () => { throw new Error('no EventSource') } } })
      h2.client.start()
      assert(h2.client.modeOf() === 'poll' && h2.fallbacks.indexOf('start') !== -1,
        '环境没有 EventSource → 立即降级（不能静默地一条都收不到）')

      const h3 = cnHarness({ over: { probeMs: 8000, maxFails: 2 } })
      h3.client.start()
      assert(h3.created.length === 1, '（前置）已建连')
      h3.sched.advance(8000)
      assert(h3.created.length === 2 && h3.created[0].closed === true,
        '连上但 8 秒没有任何数据（代理把流缓冲住了）→ 关掉重连')
      h3.sched.advance(8000)
      assert(h3.client.modeOf() === 'poll', '两次都拿不到首帧 → 降级（连不上与"连上但不推流"是两回事）')
    }

    // ④ 灾种开关：关掉主动断开、打开恢复
    {
      const h = cnHarness({})
      h.client.start()
      assert(h.created.length === 1 && h.created[0].closed === false, '（前置）连接活着')
      h.setCfg({ disasters: { earthquake: false } })
      h.sched.advance(5000)
      assert(h.client.modeOf() === 'disabled' && h.created[0].closed === true,
        '关掉「地震」开关 → 主动断开 SSE（不再读 /stream，Host 侧十分钟后自然断开与 Wolfx 的连接）')
      h.setCfg({ disasters: { earthquake: true } })
      h.sched.advance(5000)
      assert(h.created.length === 2 && h.client.modeOf() === 'sse', '重新打开开关 → 恢复消费（不会卡在"停用"状态）')
      h.client.stop()
      h.sched.advance(60000)
      assert(h.created.length === 2, 'stop 之后不再重连')
    }

    // ⑤ 贯通：真实 EEW 帧经 SSE → 契约 → 主链 → 历史
    {
      const t5 = loadClient().__test
      const cfg5 = {
        watch: { prefectures: [], cities: [], places: [{ name: '新龙', lat: 30.887, lon: 99.89, radiusKm: 100 }] },
        disasters: { earthquake: true, tsunami: true, weather: true },
        thresholds: { quakeScale: 40, eewScale: 45, tsunamiGrade: 'Watch', globalMagnitude: 4, cnReportMagnitude: 3 },
        notify: { sound: false, system: false, volume: 0 },
        dedupe: { windowMinutes: 10 },
        quietHours: { enabled: false, start: '23:00', end: '07:00', breakForSevere: true },
      }
      const clock = { t: 1000000 }
      const sched = makeSched2(clock)
      const created = []
      const c = t5.createCnStream({
        id: 'cenc_eew',
        createEventSource: (url) => { const es = fakeES(url); created.push(es); return es },
        setTimer: (fn, ms) => sched.set(fn, ms),
        clearTimer: (k) => sched.clear(k),
        getCfg: () => cfg5,
        loadCursor: () => null,
        saveCursor: () => {},
        onStatus: () => {},
        onError: () => {},
        // 与 15-entry 的注入完全同形：走契约 → 主链
        apply: (entry, cfg) => {
          const res = t5.parseCencEewResult(JSON.parse(entry.xml))
          if (!res.ok) return false
          t5.handleAlert(res.alert, cfg)
          return true
        },
      })
      c.start()
      created[0].emit('sync', { cursor: 1, replayed: 0, reset: false, truncated: false, frozen: false })
      created[0].emit('entry', { seq: 2, id: 'cenc:b4kybfnuqayyy', xml: JSON.stringify(eewRaw) })
      const hist = t5.loadHistory()
      assert(hist.length === 1 && hist[0].hit === true,
        '真实 EEW 帧经 SSE → 契约 → 主链 → 播报并进历史（整条消费链贯通）')
      assert(hist[0].headline.indexOf('新龙') !== -1, '历史里的文案来自真实载荷')
      c.stop()
    }

    // ⑥ 同一场地震：EEW 已播报 → 速报（震级下修）不二次响铃
    {
      const t6 = loadClient().__test
      const cfg6 = {
        watch: { prefectures: [], cities: [], places: [{ name: '新龙', lat: 30.887, lon: 99.89, radiusKm: 100 }] },
        disasters: { earthquake: true, tsunami: true, weather: true },
        thresholds: { quakeScale: 40, eewScale: 45, tsunamiGrade: 'Watch', globalMagnitude: 4, cnReportMagnitude: 3 },
        notify: { sound: false, system: false, volume: 0 },
        dedupe: { windowMinutes: 10 },
        quietHours: { enabled: false, start: '23:00', end: '07:00', breakForSevere: true },
      }
      const eewAlert = t6.parseCencEew(eewRaw)
      const repAlert = t6.parseCencEqlist(listRaw).find((a) => a.hypo.name === '四川甘孜州新龙县' && a.magnitude === 3.2)
      assert(!!repAlert && eewAlert.eventKey === repAlert.eventKey, '（前置）两者归到同一个事件键')
      const r1 = t6.handleAlert(eewAlert, cfg6)
      assert(r1.notified === true, '预警 M4.2 命中关注点 → 播报')
      const r2 = t6.handleAlert(repAlert, cfg6)
      assert(r2.notified === false && (r2.reason === 'event-repeat' || r2.reason === 'replayed'),
        '几分钟后的速报（M4.2 → M3.2 下修）不二次响铃（归并靠事件键 + 24 小时已播报记忆）')
      const h6 = t6.loadHistory()
      assert(h6.length === 2 && h6.some((e) => e.suppressed === true),
        '被抑制的那条仍进历史（可见，不是静默丢弃）')
      // 兜底：即使事件键的记忆窗口（10 分钟）已过，24 小时的"已播报"记忆仍会挡住它
      assert(t6.wasRecentlyAlerted(repAlert) === true && t6.isStrengthUpgrade(repAlert) === false,
        '速报晚于 10 分钟到达时，靠"已播报记忆 + 未升级"判为重放（两条路都挡得住）')
    }

    // ⑦ 没有被预警过的事件，速报照常播报（这就是"补报"的定位）
    {
      const t7 = loadClient().__test
      const overseas = t7.parseCencEqlist(listRaw).find((a) => a.hypo.name === '福克斯群岛' && a.magnitude === 6.5)
      const cfg7 = {
        watch: { prefectures: [], cities: [], places: [{ name: 'Fox', lat: 52.85, lon: -171.4, radiusKm: 100 }] },
        disasters: { earthquake: true, tsunami: true, weather: true },
        thresholds: { quakeScale: 40, eewScale: 45, tsunamiGrade: 'Watch', globalMagnitude: 4, cnReportMagnitude: 4.5 },
        notify: { sound: false, system: false, volume: 0 },
        dedupe: { windowMinutes: 10 },
        quietHours: { enabled: false, start: '23:00', end: '07:00', breakForSevere: true },
      }
      const r = t7.handleAlert(overseas, cfg7)
      assert(r.notified === true, '没有 EEW 预警过的事件，速报照常播报（分钟级确认与补报）')
    }

    // ⑧ 文案：源不同，产品名与主管机构都不同
    {
      const t8 = loadClient().__test
      const eewAlert = t8.parseCencEew(eewRaw)
      const repAlert = t8.parseCencEqlist(listRaw)[0]
      const jmaAlert = t8.parse(JSON.parse(fs.readFileSync(path.join(ROOT, 'samples', 'quake-kumamoto-detailscale-20260907.json'), 'utf8')))
      const jmaWeather = t8.parseJma(fs.readFileSync(path.join(ROOT, 'samples', 'jma-vxww50-landslide.xml'), 'utf8'), { id: 'w' })
      assert(t8.cnProductName(eewAlert) === '大陆地震预警' && t8.cnProductName(repAlert) === '大陆地震速报',
        '大陆源的产品名与日本源区分开（気象庁叫「緊急地震速報」，CENC 叫「地震预警」）')
      assert(t8.alertTitleOf(eewAlert) === '⚠ 大陆地震预警',
        '大陆预警的通知标题不该套用日方产品名（用户会以为是日本气象厅发的）')
      // 对照组：日本 EEW（556）的文案一个字都不能变——改文案的范围只限大陆源
      const jpEew = t8.parse(JSON.parse(fs.readFileSync(
        path.join(ROOT, 'samples', 'eew-ibaraki-m6.7-20260823.json'), 'utf8')))
      assert(jpEew && jpEew.kind === 'eew' && t8.alertTitleOf(jpEew) === '⚠ 紧急地震速报（警报）',
        '日本 EEW 的文案保持不变（只把大陆源换成「地震预警」）')
      assert(t8.disclaimerOf(jpEew).indexOf('気象庁') !== -1, '日本 EEW 的免责声明仍指向気象庁')
      assert(t8.authorityOf(eewAlert) === '中国地震台网（CENC）', '大陆源的"官方"是中国地震台网')
      assert(t8.disclaimerOf(eewAlert).indexOf('中国地震台网') !== -1,
        '免责声明点名正确机构（此前硬编码「气象厅」，对大陆源与全球源都是错的）')
      assert(t8.authorityOf(jmaAlert) === '気象庁', 'P2PQuake 的 551/552/556 仍指向気象庁（它们只有数字 code）')
      assert(t8.authorityOf(jmaWeather) === '気象庁', '気象庁电文指向気象庁')
      const usgsRes = t8.parseUsgsResult(JSON.parse(fs.readFileSync(path.join(ROOT, 'samples', 'global', 'usgs-all-hour.geojson'), 'utf8')).features[0])
      assert(usgsRes.ok && t8.authorityOf(usgsRes.alert) === '美国地质调查局（USGS）',
        'USGS 地震指向 USGS（顺手修掉 0.4.0 起"请以气象厅发布为准"这条错文案）')
      assert(t8.disclaimerOf({}).indexOf('官方发布') !== -1 && t8.disclaimerOf({}).indexOf('气象厅') === -1,
        '认不出机构时用中性表述，不硬编码任何一家')
    }

    // ⑩ 手动链路开关（0.5.0 的"出口"）：强制轮询可撤销，自动降级不可撤销
    {
      // 一开始就选了「强制轮询」→ 不该先连一次 SSE 再切（那会白占一条 Wolfx 连接）
      const h = cnHarness({ cfg: { disasters: { earthquake: true }, cnTransport: 'poll' } })
      h.client.start()
      assert(h.client.modeOf() === 'poll' && h.created.length === 0,
        '设置里选了强制轮询 → 一开始就不建 SSE')
      assert(h.client.fallbackIsManual() === true, '标记为"用户选的"，以便下次改回自动时能升回')
      h.client.stop()

      // 运行中从「自动」改成「强制轮询」
      const h2 = cnHarness({})
      h2.client.start()
      assert(h2.client.modeOf() === 'sse' && h2.created.length === 1, '（前置）走在 SSE 上')
      h2.setCfg({ disasters: { earthquake: true }, cnTransport: 'poll' })
      h2.sched.advance(5000)
      assert(h2.client.modeOf() === 'poll' && h2.created[0].closed === true,
        '改成强制轮询 → 主动关掉 SSE 并切到轮询')
      assert(h2.statuses.some((p) => p.detail.indexOf('按设置选择轮询') !== -1),
        '手动选择也要说出来（用户有权知道当前走哪条路）')
      // 改回「自动」→ 施加的手动选择可以撤销
      h2.setCfg({ disasters: { earthquake: true }, cnTransport: 'auto' })
      h2.sched.advance(5000)
      assert(h2.client.modeOf() === 'sse' && h2.created.length === 2,
        '改回「自动」→ 从手动轮询升回 SSE（手动选择是可撤销的）')
      h2.client.stop()

      // 自动降级**不**因为改回「自动」而升回——那条链路已经证明过不通
      const h3 = cnHarness({ over: { maxFails: 1 } })
      h3.client.start()
      h3.created[0].emitRaw('error', '')
      assert(h3.client.modeOf() === 'poll' && h3.client.fallbackIsManual() === false,
        '自动降级标记为非手动')
      h3.setCfg({ disasters: { earthquake: true }, cnTransport: 'auto' })
      h3.sched.advance(20000)
      assert(h3.client.modeOf() === 'poll' && h3.created.length === 1,
        '自动降级不自动升回（反复试探只会抖动；要回 SSE 得靠刷新或改设置）')
      h3.client.stop()

      // 配置字段本身
      assert(T.DEFAULT_CFG.cnTransport === 'auto', '默认「自动」（SSE 优先 + 自动降级）')
      assert(T.normalizeCfg({}).cnTransport === 'auto', '缺字段 → 回退默认')
      assert(T.normalizeCfg({ cnTransport: 'poll' }).cnTransport === 'poll', '已选的值被保留')
      assert(T.normalizeCfg({ cnTransport: 'bogus' }).cnTransport === 'auto', '未知取值回退默认（白名单）')
    }

    // ⑪ 诊断快照：只读、永不抛错、可 JSON 化
    {
      const t11 = loadClient().__test
      const snap = t11.buildDiagSnapshot(1758268800000)
      assert(snap.snapshot === t11.DIAG_SNAPSHOT_VERSION, '快照带格式版本（与插件版本无关，见模块注释）')
      for (const k of ['at', 'page', 'aggregate', 'config', 'sources', 'dataHealth', 'feed', 'streams', 'history', 'warnings']) {
        assert(k in snap, '快照含 ' + k + ' 段')
      }
      // 0.6.0：海外源是 Client 直连的 REST，没有 /feed 路由可查——它们的计数单独一段。
      // 没有这一段，海外源出问题时诊断快照里**一个字都看不到**（而"看不到"正是这类
      // 源最容易出的故障形态：不发请求、状态是绿的，只是永远没有预警）。
      assert('overseas' in snap, '快照含 overseas 段（海外源的查询 / 未覆盖 / 年龄闸门计数）')
      let json = ''
      try { json = JSON.stringify(snap) } catch (err) { json = '' }
      assert(json.length > 50, '快照可 JSON 化（活对象/循环引用会在这里炸）')
      assert(!('version' in snap) && json.indexOf('"version"') === -1,
        '快照不含插件版本——版本号只在 package.json / CHANGELOG / README 三处（避免多一个会漂移的位置）')
      assert(snap.config.cnTransport === 'auto', '快照带链路选择（诊断"为什么走轮询"要看它）')
      assert(Array.isArray(snap.warnings), '生成过程中被兜住的异常要可见（不是假装一切正常）')
      assert(snap.config.watch && Array.isArray(snap.config.watch.places),
        '关注点摘要含坐标——匹配失败通常就靠"距最近关注点多少公里"来判')
      // 脏状态也必须能产出：诊断工具在真出事时最不该抛错
      t11.store.push({ sources: null, events: 'oops' })
      const snap2 = t11.buildDiagSnapshot()
      assert(snap2 && typeof snap2 === 'object' && Array.isArray(snap2.warnings),
        'store 被写坏成非对象/非数组时仍能产出快照')
    }
    {
      // 剪贴板不可用时**不抛错**，把文本交回调用方去显示
      const t12 = loadClient().__test
      const r = await t12.copyDiagSnapshot()
      assert(r && typeof r.text === 'string' && r.text.length > 50,
        '剪贴板不可用（沙箱里 navigator 不存在）也返回完整文本，交给界面手动复制')
      assert(r.ok === false, '明确回报"没复制成功"，而不是假装成功')
    }

    // ⑨ 注册表：设置页与诊断快照要能实时读到大陆源状态
    {
      const h = cnHarness({})
      h.client.start()
      const reg = T.cnStreamRegistry.cenc_eew
      assert(reg && typeof reg.stats === 'function' && typeof reg.mode === 'function',
        '大陆源客户端注册到 cnStreamRegistry（供设置页 / 诊断快照实时读取）')
      assert(reg.stats().connections >= 1 && reg.mode() === 'sse', '注册表给的是实时状态，不是滞后快照')
      h.client.stop()
      // 结构性守卫：**每一个源都必须有一个状态行**。这条断言防的是"加了源、忘了加到状态区块"
    }
    {
      const contractIds = Object.keys(T.SOURCE_CONTRACTS)
      const missing = contractIds.filter((id) => T.SOURCE_ORDER.indexOf(id) === -1)
      assert(missing.length === 0,
        '每个有校验约定的源都出现在设置页的「源状态」里（漏了就是"某个源坏了界面上看不见"）' +
        (missing.length ? '（缺：' + missing.join(',') + '）' : ''))
      const noLabel = T.SOURCE_ORDER.filter((id) => !T.SOURCE_LABELS[id])
      assert(noLabel.length === 0, '状态行里的每个源都有中文标签' +
        (noLabel.length ? '（缺：' + noLabel.join(',') + '）' : ''))
      assert(T.SOURCE_CODE_TEXT.cenc_eew && T.SOURCE_CODE_TEXT.cenc_eqlist,
        '历史的「类型」行能标出大陆源（否则会退化成 kind 兜底、与日本源混淆）')
      assert(T.p2pCodeTextOf('eew', 'cenc_eew', 'cenc:x') === 'CENC 预警',
        '大陆预警的历史条目标成 CENC 预警，而不是「code 556」')
      assert(T.p2pCodeTextOf('quake', 'cenc_eqlist', 'cenc:y') === 'CENC 速报', '大陆速报同理')
      assert(T.p2pCodeTextOf('eew', 556, '') === 'code 556', '日本 EEW 仍显示 P2PQuake 的 code（文案改动不外溢）')
    }
  } catch (e) {
    assert(false, '0.5.0 Client 半边检查失败：' + e.message + '\n' + (e && e.stack ? e.stack.split('\n').slice(1, 3).join('\n') : ''))
  }

  // ==========================================================================
  // 0.5.0：中国行政区划表（省 → 地级市，带坐标）
  // 生成脚本 scripts/build-cn-areas.mjs（--check 可校验产物是否与源一致）。
  // 这里的断言是**表驱动**的：结构全量校验 + 已知城市的坐标锚点。
  // 「不要只验证恰好对的那部分」——所以既查全量不变量，也查真实地名。
  // ==========================================================================
  try {
    const { CN_AREAS } = await import(pathToFileURL(path.join(ROOT, 'lib', 'data', 'cn-areas.js')).href)
    const cjkOnly = (s) => /^[\u4e00-\u9fff]+$/.test(s)
    const cityTotal = CN_AREAS.reduce((n, p) => n + p.cities.length, 0)
    assert(CN_AREAS.length === 34, '省级行政区 34 个（含港澳台），实际 ' + CN_AREAS.length)
    assert(cityTotal >= 370 && cityTotal <= 400, '地级行政区在合理区间（' + cityTotal + '）')
    // 全量不变量
    const badName = []
    const badCoord = []
    const dup = []
    for (const p of CN_AREAS) {
      if (!cjkOnly(p.name)) badName.push(p.name)
      if (!(p.lat > 3 && p.lat < 54) || !(p.lon > 73 && p.lon < 135)) badCoord.push(p.name)
      if (p.cities.length === 0) dup.push(p.name + '(无下级)')
      const seen = new Set()
      for (const c of p.cities) {
        if (!cjkOnly(c.name)) badName.push(p.name + '/' + c.name)
        if (!(c.lat > 3 && c.lat < 54) || !(c.lon > 73 && c.lon < 135)) badCoord.push(c.name)
        if (seen.has(c.name)) dup.push(p.name + '/' + c.name)
        seen.add(c.name)
      }
    }
    assert(badName.length === 0, '所有名称都是中文（混进罗马字名会让人误选）' + (badName.length ? '：' + badName.slice(0, 5).join(',') : ''))
    assert(badCoord.length === 0, '所有坐标都落在中国境内（纬度 3–54 / 经度 73–135）' + (badCoord.length ? '：' + badCoord.slice(0, 5).join(',') : ''))
    assert(dup.length === 0, '同一省级项下没有重名' + (dup.length ? '：' + dup.slice(0, 5).join(',') : ''))
    // 名称提取的两个真实坑（都在生成时踩到过，回归守住）
    assert(!JSON.stringify(CN_AREAS).includes('県'),
      '没有日文变体的行政区名（实测 GeoNames 的 雲林 有「雲林県」候选）')
    const tw = CN_AREAS.find((p) => p.name === '台湾')
    assert(!!tw && tw.cities.some((c) => c.name === '新北市'),
      '新北市存在——实测它的候选里有旧名「臺灣省」，按"省 > 市"排会挑错成「臺灣省」')
    assert(!!tw && !tw.cities.some((c) => c.name === '臺灣省' || c.name === '台湾省'),
      '没有把「臺灣省」当成一个下级市（它是新北市的旧名候选）')
    assert(tw.cities.length === 22, '台湾 22 个县市，实际 ' + tw.cities.length)
    // 已知城市的坐标锚点（容差 2°：表里是**行政区中心点**，与市中心可差上百公里，
    // 甘孜州 / 哈尔滨市 那种面积巨大的尤其明显——见产物头部的已知取舍）
    const ANCHORS = [
      ['四川省', '成都市', 30.66, 104.07], ['四川省', '甘孜藏族自治州', 31.02, 100.41],
      ['北京市', '北京市', 39.90, 116.41], ['上海市', '上海市', 31.23, 121.47],
      ['新疆维吾尔自治区', '乌鲁木齐市', 43.83, 87.62], ['西藏自治区', '拉萨市', 29.65, 91.14],
      ['台湾', '花蓮縣', 23.98, 121.60], ['香港', '香港', 22.32, 114.17], ['澳门', '澳门', 22.19, 113.54],
    ]
    const miss = []
    for (const [pn, cn2, lat, lon] of ANCHORS) {
      const p = CN_AREAS.find((x) => x.name === pn)
      const c = p && p.cities.find((x) => x.name === cn2)
      if (!c) { miss.push(pn + '/' + cn2 + '(缺)'); continue }
      if (Math.max(Math.abs(c.lat - lat), Math.abs(c.lon - lon)) > 2.0) {
        miss.push(cn2 + '(' + c.lat + ',' + c.lon + ')')
      }
    }
    assert(miss.length === 0, '已知城市的坐标对得上参考值' + (miss.length ? '：' + miss.join(' ') : ''))
    // 直辖市：只有一条且与省同名（级联到第二级不会是空的）
    const noCity = ['北京市', '上海市', '天津市', '重庆市'].filter((pn) => {
      const p = CN_AREAS.find((x) => x.name === pn)
      return !p || p.cities.length !== 1 || p.cities[0].name !== pn
    })
    assert(noCity.length === 0, '四个直辖市各自只有一条同名下级' + (noCity.length ? '：' + noCity.join(',') : ''))
  } catch (e) {
    assert(false, '0.5.0 中国行政区划表检查失败：' + e.message)
  }

  // ==========================================================================
  // 0.5.0：设置页的三级级联（中国 → 省 → 地级市）与半径语义
  // ==========================================================================
  try {
    const { CN_AREAS } = await import(pathToFileURL(path.join(ROOT, 'lib', 'data', 'cn-areas.js')).href)

    // ① Host 的 /areas 把行政区划表随市区町村表一起下发
    {
      const mod = await import(pathToFileURL(path.join(ROOT, 'lib', 'index.js')).href)
      const routes = []
      mod.apply({
        effect(fn) { fn(); return () => {} },
        inject(names, cb) {
          if (names.indexOf('webServer') !== -1) {
            cb({ effect(fn) { fn(); return () => {} }, webServer: { register: (r) => { routes.push(r); return () => {} } } })
          }
        },
      })
      const areas = routes.find((r) => r.path === '/dsh-quake-alert/areas')
      let body = ''
      areas.handler({}, { writeHead() {}, end(b) { body = b } })
      const parsed = JSON.parse(body)
      assert(Array.isArray(parsed.cnAreas) && parsed.cnAreas.length === CN_AREAS.length,
        '/areas 随同一份响应下发中国行政区划表（不内联进 bundle，理由同市区町村表）')
      assert(parsed.cnAreas.every((p) => typeof p.name === 'string' && Array.isArray(p.cities) && p.cities.length > 0),
        '下发的省级项都带下级与坐标（没有下级的省级项在级联里是死路）')
      assert(parsed.cnAreas.find((p) => p.name === '四川省').cities.some((c) => c.name === '成都市'),
        '表里有「四川省 / 成都市」')
    }

    const t = loadClient().__test

    // ② 表的规整：Host 的 JSON 与 localStorage 一样属于不可信输入
    assert(t.setCnAreas(null) === false && t.setCnAreas({}) === false, '非数组 / 非表 → 拒绝')
    assert(t.setCnAreas([{ name: '' }, { name: '甲省' }, { name: '乙省', lat: 1, lon: 2, cities: [] }]) === false,
      '全是坏条目 → 整体拒绝（不做部分接受）')
    assert(t.setCnAreas([
      { name: '甲省', lat: 30, lon: 100, cities: [{ name: '甲市', lat: 30.1, lon: 100.1 }, { name: '甲市', lat: 30.2, lon: 100.2 }, { name: '坏市', lat: 999, lon: 1 }] },
      { name: '乙省', lat: 20, lon: 90, cities: [] },
    ]) === true, '有一项可用即接受')
    assert(t.cnProvinces().length === 1, '没有下级的省级项被丢弃（选中后按钮没反应 = 死路）')
    assert(t.cnCitiesOf('甲省').length === 1, '同省重名与坏坐标的市被丢弃')
    assert(t.cnCitiesOf('不存在').length === 0, '未收录的省 → 空数组')
    t.resetCityTable()

    // ③ 级联的产物：所选城市的坐标 + 半径 → 一个关注点
    t.setCnAreas(CN_AREAS)
    const p = t.cnPlaceOf('四川省', '成都市', 100)
    assert(!!p && p.name === '四川省·成都市' && p.radiusKm === 100,
      '级联产出带「省·市」名称的关注点（避免两个省的「城区」撞名）')
    assert(Math.abs(p.lat - 30.76) < 0.01 && Math.abs(p.lon - 103.87) < 0.01, '坐标取自行政区划表')
    assert(t.cnPlaceOf('四川省', '不存在市', 100) === null, '未收录的市 → null（调用方给文字原因，不静默）')
    assert(t.cnPlaceOf('不存在省', '成都市', 100) === null, '未收录的省 → null')
    assert(t.cnPlaceOf('四川省', '成都市', 0) === null || t.cnPlaceOf('四川省', '成都市', 0) === null,
      '半径越界 → null（0 / 负数 / 超上限都不该造出一个能匹配的关注点）')
    assert(t.cnPlaceOf('四川省', '成都市', 9999) === null && t.cnPlaceOf('四川省', '成都市', NaN) === null,
      '半径 9999 / NaN → null')
    // 产物必须能被配置层原样接受（否则界面上"加上了"、实际会被 normalizePlaces 丢掉）
    const normalized = t.normalizePlaces([p])
    assert(normalized.length === 1 && normalized[0].name === '四川省·成都市' && normalized[0].radiusKm === 100,
      '级联产物能通过 normalizePlaces（否则会出现"加了但没生效"）')

    // ④ 真实事件端到端：选「甘孜藏族自治州」+ 默认 100km → 能命中实测的四川新龙县事件
    {
      const t2 = loadClient().__test
      t2.setCnAreas(CN_AREAS)
      const place = t2.cnPlaceOf('四川省', '甘孜藏族自治州', t2.DEFAULT_PLACE_RADIUS_KM)
      assert(!!place, '（前置）级联能产出甘孜州的关注点')
      const listRaw = JSON.parse(fs.readFileSync(path.join(ROOT, 'samples', 'cn', 'cenc-eqlist-last.json'), 'utf8'))
      const xinlong = t2.parseCencEqlist(listRaw).find((a) => a.hypo.name === '四川甘孜州新龙县' && a.magnitude === 4.2)
        || t2.parseCencEqlist(listRaw).find((a) => a.hypo.name === '四川甘孜州新龙县')
      assert(!!xinlong, '（前置）速报样本里有新龙县事件')
      const cfg = {
        watch: { prefectures: [], cities: [], places: [place] },
        disasters: { earthquake: true, tsunami: true, weather: true },
        thresholds: { quakeScale: 40, eewScale: 45, tsunamiGrade: 'Watch', globalMagnitude: 4, cnReportMagnitude: 3 },
        notify: { sound: false, system: false, volume: 0 },
        dedupe: { windowMinutes: 10 },
        quietHours: { enabled: false, start: '23:00', end: '07:00', breakForSevere: true },
      }
      const m = t2.matchAlert(xinlong, cfg)
      assert(m.hit === true && m.reason.indexOf('甘孜藏族自治州') !== -1,
        '选「甘孜藏族自治州」+ 默认 100km 就能命中实测的新龙县事件（整条级联真的接上了匹配）')
      // 对照：选成都（离新龙县约 380km）在默认半径下不该命中——否则说明半径没起作用
      const chengdu = t2.cnPlaceOf('四川省', '成都市', 100)
      const cfg2 = JSON.parse(JSON.stringify(cfg))
      cfg2.watch.places = [chengdu]
      assert(t2.matchAlert(xinlong, cfg2).hit === false,
        '（对照）选成都 + 100km 不命中（约 380km 外），半径确实在起作用')
    }
    t.resetCityTable()

    // ⑤ 半径：新建默认 100，既有配置的 300 不被静默改掉
    assert(t.DEFAULT_PLACE_RADIUS_KM === 100, '新建关注点的默认半径是 100km（DESIGN 9.2）')
    assert(t.RADIUS_PRESETS.length === 3 && t.RADIUS_PRESETS.some((o) => o.v === 100),
      '三档语义预设，含默认档')
    assert(t.RADIUS_PRESETS.every((o) => typeof o.label === 'string' && o.label.indexOf('km') !== -1),
      '预设用语义标签 + 括注公里数（普通用户不必理解"公里"）')
    const legacy = t.normalizePlaces([{ name: '旧点', lat: 1, lon: 2 }])
    assert(legacy[0].radiusKm === 300,
      '缺 radiusKm 的旧条目仍按 300 兜底 —— 把用户配好的半径从 300 改成 100 会让提醒变窄（漏报方向）')
    assert(t.normalizePlaces([{ name: 'x', lat: 1, lon: 2, radiusKm: 100 }])[0].radiusKm === 100,
      '显式配的 100 被保留')
    // ⑥ 设置页**真的渲染一次**（本项目此前从不渲染 UI，于是"设置页能不能渲染"从没被守过）
    {
      // 极简 React：够跑完一次渲染即可。useEffect 不执行（副作用与订阅不在本用例的范围）。
      const mkReact = () => {
        const states = []
        let idx = 0
        return {
          __reset() { idx = 0 },
          createElement: (type, props, ...children) => ({
            type, props: props || {},
            children: children.flat(4).filter((c) => c !== null && c !== undefined && c !== false && c !== true),
          }),
          useState: (init) => {
            const i = idx++
            if (!(i in states)) states[i] = typeof init === 'function' ? init() : init
            return [states[i], (v) => { states[i] = typeof v === 'function' ? v(states[i]) : v }]
          },
          useEffect: () => {},
          useRef: (init) => ({ current: init }),
        }
      }
      const react = mkReact()
      const { exports: ex } = loadClientEx({}, { react })
      const T2 = ex.__test
      T2.setCnAreas(CN_AREAS)
      let tree = null
      let err = null
      try {
        react.__reset()
        tree = T2.SettingsPanel()
      } catch (e) { err = e }
      assert(err === null, '设置页能渲染（不抛错）' + (err ? '：' + err.message : ''))
      const texts = []
      const walk = (node) => {
        if (node === null || node === undefined) return
        if (typeof node === 'string' || typeof node === 'number') { texts.push(String(node)); return }
        if (Array.isArray(node)) { node.forEach(walk); return }
        if (node && node.children) node.children.forEach(walk)
      }
      walk(tree)
      const has = (s) => texts.some((t) => t.indexOf(s) !== -1)
      assert(has('① 日本：都道府县 / 市区町村'), '渲染结果里有「日本」这一级')
      assert(has('② 中国大陆：省 / 地级市'), '渲染结果里有「中国大陆」这一级')
      assert(has('③ 其他地区：坐标 + 半径'), '渲染结果里有「其他地区」这一级')
      assert(has('四川省') && has('西藏自治区'), '级联的省份选项出现在渲染结果里')
      assert(has('仅本地（约 30 km）') && has('本市及周边（约 100 km，默认）'),
        '三档半径语义预设出现在渲染结果里')
      assert(has('添加这个城市') && has('用我的位置'), '级联的两个按钮都在')
      // 还没选省份时，城市下拉只显示占位项 —— 不做成"猜一个默认省"是对的选择
      assert(has('（先选省份）'), '未选省份时城市下拉给出占位提示，而不是空的')
      assert(has('诊断') && has('生成诊断快照'), '诊断区块也在（同一页）')
      // 0.5.2 的教训与 0.5.0 相同：新加的 UI 必须有渲染断言守着，否则一个拼错的 h(...) 会白屏
      // 而没有任何断言会失败。这里同时确认两个灾种开关与那段"橙色才播报 / 没有解除标志"的说明。
      assert(has('中国大陆气象灾害') && has('暴雨预警') && has('地质灾害预警'),
        '大陆气象灾害的两个开关渲染出来了')
      assert(has('橙色及以上') && has('没有「解除」标志'),
        '设置页如实说明"橙色才播报"与"没有解除标志"（DESIGN 10.2 要求 UI 不得假装能处理）')
      // 0.6.0：海外气象源的开关与说明。与 0.5.0 / 0.5.2 同一条纪律——新加的 UI 必须有渲染断言，
      // 否则一个拼错的 h(...) 会白屏而没有任何断言会失败。
      assert(has('海外气象灾害') && has('洪水 / 山洪 / 降雨 / 风暴潮预警'),
        '海外气象的开关渲染出来了')
      assert(has('Data Source: Environment and Climate Change Canada'),
        '设置页带上了 ECCC 的署名（End-use Licence v2.1.1 要求署名）')
      assert(has('打开页面时若某条预警已发布超过 6 小时'),
        '设置页如实说明了年龄闸门（用户知道为什么打开页面时老预警不响）')
      T2.resetCityTable()
    }
  } catch (e) {
    assert(false, '0.5.0 设置页级联检查失败：' + e.message + '\n' + (e && e.stack ? e.stack.split('\n').slice(1, 3).join('\n') : ''))
  }

  // ==========================================================================
  // 0.5.2：大陆气象源（nmc.cn）
  // Host 侧：列表裁剪 / 详情门槛 / 正文提取；Client 侧：契约 / 行政区归属 / 层级匹配。
  // 全部用 samples/nmc/ 的真实 fixture，不联网。
  // ==========================================================================
  try {
    const nmc = await import(pathToFileURL(path.join(ROOT, 'lib', 'nmc-source.js')).href)
    const { CN_AREAS } = await import(pathToFileURL(path.join(ROOT, 'lib', 'data', 'cn-areas.js')).href)
    const samplePath = (n) => path.join(ROOT, 'samples', 'nmc', n)
    const listSample = JSON.parse(fs.readFileSync(samplePath('alarm-list.json'), 'utf8'))
    const fixtureItems = listSample.data.page.list
    const detailOf = (n) => fs.readFileSync(samplePath(n), 'utf8')

    console.log('== 0.5.2 Host：时间与图标编码 ==')
    assert(nmc.nmcTimeToIso('2026/09/19 12:31') === '2026-09-19T12:31:00+08:00',
      '北京时间裸串（斜杠、无秒）→ 带 +08:00 的 ISO（交给 Date.parse 会按本机时区解释，本机是 JST 时整差一小时）')
    assert(nmc.nmcTimeToIso('2026-09-19 12:31:05') === '2026-09-19T12:31:05+08:00', '连字符 + 带秒的写法也认')
    assert(nmc.nmcTimeToIso('') === '' && nmc.nmcTimeToIso('昨天') === '',
      '认不出返回空串（不猜当前时间——那会让一条时间损坏的预警在每次重启时被当成"刚发布"重播）')
    assert(nmc.nmcTimeMs('2026/09/19 12:31') === Date.parse('2026-09-19T12:31:00+08:00'), 'nmcTimeMs 与 ISO 一致')
    {
      const c = nmc.nmcCodesOf('https://image.nmc.cn/assets/img/alarm/p0021003.png')
      assert(c && c.kindCode === 21 && c.levelCode === 3, '图标编码 p0021003 → 灾种 21（地质灾害）/ 等级 3（黄）')
      assert(nmc.nmcCodesOf('') === null && nmc.nmcCodesOf('https://x/y.png') === null, '不成形的图标地址 → null（由调用方跳过该条）')
    }

    console.log('== 0.5.2 Host：列表解析与灾种裁剪 ==')
    let parsed = null
    let parseErr = null
    try { parsed = nmc.parseNmcList(JSON.stringify(listSample)) } catch (e) { parseErr = e }
    assert(parseErr === null, '真实列表样本能解析' + (parseErr ? '：' + parseErr.message : ''))
    assert(parsed && parsed.length === fixtureItems.length, '裁剪后条数与样本一致（' + (parsed ? parsed.length : '-') + '）')
    assert(parsed && parsed.every((e) => e.kind === 'rainstorm' || e.kind === 'geology'),
      '只留暴雨 / 地质灾害——实测雷电+大风+高温占完整列表的 76%，原样转发会把历史刷满')
    assert(parsed && parsed.every((e) => e.id && e.title && e.detailUrl && e.payload),
      '每条都有 id / title / detailUrl / payload')
    assert(parsed && parsed.every((e) => e.updated.indexOf('+08:00') > 0),
      '每条都带可比较的发布时间（冷启动判据要用它）')
    assert(parsed && parsed.every((e) => e.detailNeeded === (['red', 'orange'].indexOf(e.level) !== -1)),
      '只有橙 / 红才需要拉详情（蓝 / 黄占样本的 94%）')
    {
      // 结构不符必须抛错：被拦截成 HTML 与"这一次没有预警"不能同形（DESIGN 4.5）
      let e1 = null
      try { nmc.parseNmcList('<html>拦截页</html>') } catch (e) { e1 = e }
      assert(!!e1, '响应不是 JSON → 抛错（不是返回空数组）')
      let e2 = null
      try { nmc.parseNmcList('{"code":0}') } catch (e) { e2 = e }
      assert(!!e2, '缺少 data.page.list → 抛错（上游改版要能被看见）')
      const empty = nmc.parseNmcList('{"code":0,"data":{"page":{"list":[]}}}')
      assert(Array.isArray(empty) && empty.length === 0, '真正的空列表 → 空数组（不是故障）')
      // 单条坏（缺 pic / 缺 alertid）只跳过它，其余真实预警照常
      const mixed = {
        code: 0,
        data: { page: { list: [
          { alertid: 'x1', issuetime: '2026/09/19 12:31', title: '云南省丽江市气象台发布暴雨橙色预警信号', pic: 'https://i/a/p0002002.png' },
          { alertid: '', issuetime: '2026/09/19 12:31', title: '缺 alertid', pic: 'https://i/a/p0002003.png' },
          { alertid: 'x3', issuetime: '2026/09/19 12:31', title: '缺 pic', pic: '' },
          { alertid: 'x4', issuetime: '2026/09/19 12:31', title: '不接的灾种', pic: 'https://i/a/p0012003.png' },
        ] } },
      }
      const one = nmc.parseNmcList(JSON.stringify(mixed))
      assert(one.length === 1 && one[0].id === 'x1', '单条缺字段 / 不接的灾种只跳过它，其余照常（逐条语义）')
    }
    {
      // 详情页正文提取：用真实页面（46KB），验证的不是"正则能不能跑"，而是容器还在不在
      const text = nmc.extractAlarmText(detailOf('detail-geology-yellow.html'))
      assert(text.length > 20 && text.indexOf('<') === -1, '详情页 → 纯文本正文（' + text.length + ' 字）')
      assert(text.indexOf('地质灾害') !== -1, '正文里含灾种说明（#alarmtext 还在原位置）')
      assert(nmc.extractAlarmText('<html>没有正文容器</html>') === '', '没有 #alarmtext → 空串（文案少一段，不让整条预警作废）')
    }
    assert(Number.isFinite(nmc.nmcFeedTime(JSON.stringify(listSample))),
      '上游数据时间取自列表里最新一条（stale 判定用它，而不是"我们收到多少条"）')

    console.log('== 0.5.2 Host：详情门槛与冷启动窗口 ==')
    {
      // startedAt=0 → 所有样本条目都落在回看窗口内，断言与"样本里恰好有哪些时间"解耦
      const calls = []
      const detailByUrl = {}
      for (const it of fixtureItems) detailByUrl[nmc.NMC_DETAIL_BASE + it.alertid + '.html'] = detailOf('detail-geology-yellow.html')
      const src = nmc.createNmcSource({
        now: () => Date.parse('2026-09-19T05:00:00Z'),
        startedAt: 0,
        fetchText: async (url) => {
          calls.push(url)
          if (url.indexOf('/rest/findAlarm') !== -1) return JSON.stringify(listSample)
          return detailByUrl[url] !== undefined ? detailByUrl[url] : '<html></html>'
        },
        idleMs: 0,
      })
      await src.pollOnce()
      const wantDetail = parsed.filter((e) => e.detailNeeded).length
      const detailCalls = calls.filter((u) => u.indexOf('/rest/findAlarm') === -1).length
      assert(detailCalls === wantDetail, '只为橙 / 红发详情请求（' + detailCalls + ' 次 = 样本里的橙红条数）')
      const snap = src.snapshot(0, {})
      assert(snap.entries.length === parsed.length, '全部条目都进了缓冲（蓝 / 黄也要入历史，只是不播报）')
      const blue = snap.entries.find((e) => JSON.parse(e.xml).level === 'blue')
      assert(blue && JSON.parse(blue.xml).detail === '' && blue.xml.indexOf('alertid') !== -1,
        '蓝 / 黄条目的载荷是 JSON（没拉详情）——两种形态必须统一，否则总有一条路径没被断言覆盖')
      const orange = snap.entries.find((e) => JSON.parse(e.xml).level === 'orange')
      if (orange) assert(JSON.parse(orange.xml).detail.length > 0, '橙 / 红条目的载荷里带上了详情正文')
      assert(src.stats().detailsFetched === wantDetail, 'detailsFetched 计数与请求数一致')
    }
    {
      // 冷启动回看窗口：窗口外的旧条目只记已见、不产事件（否则每次重启都会重播 24 小时的历史）。
      // 用**单条**构造而不是整个 fixture：样本横跨 24 小时，用样本会让"窗口外"这条断言
      // 实际取决于"样本里恰好有哪些时间"，那是噪声不是验证。
      const one = {
        code: 0,
        data: { page: { list: [{
          alertid: 'old-1', issuetime: '2026/09/19 08:00',
          title: '云南省丽江市气象台发布暴雨橙色预警信号', pic: 'https://i/a/p0002002.png',
        }] } },
      }
      const t0 = Date.parse('2026-09-19T12:30:00+08:00')
      const detailCalls = []
      const src = nmc.createNmcSource({
        now: () => t0,
        startedAt: t0,
        fetchText: async (url) => {
          detailCalls.push(url)
          return url.indexOf('/rest/findAlarm') !== -1 ? JSON.stringify(one) : '<html></html>'
        },
        idleMs: 0,
      })
      await src.pollOnce()
      assert(src.snapshot(0, {}).entries.length === 0, '早于启动时刻 4.5 小时（回看窗口 30 分钟之外）的旧预警不入缓冲')
      assert(detailCalls.length === 1, '就连详情也不会为它抓（历史只记已见）')
      // 同一条数据、把启动时刻挪到它发布后 10 分钟 → 它就成了"启动前后不久发布的新预警"，照常处理
      const t1 = Date.parse('2026-09-19T08:10:00+08:00')
      const src2 = nmc.createNmcSource({
        now: () => t1,
        startedAt: t1,
        fetchText: async (url) => (url.indexOf('/rest/findAlarm') !== -1 ? JSON.stringify(one) : '<html></html>'),
        idleMs: 0,
      })
      await src2.pollOnce()
      assert(src2.snapshot(0, {}).entries.length === 1, '同一批数据、启动时刻在它发布之后 10 分钟 → 照常处理（窗口边界真的在起作用）')
    }
    {
      // 停更探针：源还在响应、但最新一条已经很旧 → stale。判据是**数据时间**，不是"收到几条"。
      const staleList = JSON.parse(JSON.stringify(listSample))
      for (const it of staleList.data.page.list) it.issuetime = '2026/09/19 08:00'
      const mkSrc = (nowMs) => nmc.createNmcSource({
        now: () => nowMs,
        startedAt: 0,
        fetchText: async (url) => (url.indexOf('/rest/findAlarm') !== -1 ? JSON.stringify(staleList) : '<html></html>'),
        idleMs: 0,
      })
      const stale = mkSrc(Date.parse('2026-09-19T12:30:00+08:00'))
      await stale.pollOnce()
      assert(stale.stats().stale === true, '最新一条已过 4.5 小时（阈值 3 小时）→ 判上游停更')
      const fresh = mkSrc(Date.parse('2026-09-19T09:30:00+08:00'))
      await fresh.pollOnce()
      assert(fresh.stats().stale === false, '同一批数据、时钟离它只有 1.5 小时 → 不判停更（阈值真的在起作用）')
    }

    console.log('== 0.5.2 Client：契约与解析 ==')
    // 归属解析（cnArea）依赖行政区划表，所以先在契约段之前注入——否则下面那条
    // "机构名 → 省 + 市"会因为表还没到位而失败（这正是它第一次跑出来的样子）
    assert(T.setCnAreas(CN_AREAS), '注入中国行政区划表')
    {
      const mk = (o) => Object.assign({
        alertid: '53072441600000_20260919030245',
        title: '云南省丽江市宁蒗彝族自治县气象台发布地质灾害黄色预警信号',
        issued: '2026-09-19T03:01:00+08:00',
        kind: 'geology',
        level: 'yellow',
        detail: '',
      }, o || {})
      const res = T.parseNmcAlarmResult(mk())
      assert(res.ok && res.alert.kind === 'weather' && res.alert.locator === 'area',
        '气象源复用 kind=weather，但 locator=area（匹配走行政区层级，DESIGN 8.5）')
      assert(res.ok && res.alert.severity === 'yellow', '黄色 → severity=yellow（忠实映射，不拔高）')
      assert(res.ok && res.alert.cnArea.province === '云南省' && res.alert.cnArea.city === '丽江市',
        '机构名 → 省 + 市（云南省 / 丽江市）')
      assert(res.ok && res.alert.headline === '云南省丽江市宁蒗彝族自治县 · 地质灾害黄色预警',
        '文案用发布地的原文，不用行政区表里的显示名（表里是 GeoNames 的旧名，用户对不上号）')
      assert(res.ok && res.alert.cancelled === false, '没有"解除"形态 → cancelled 恒 false（不得假装能处理）')
      assert(res.ok && res.alert.eventKey === 'nmc:53072441600000_20260919030245', '事件键取 alertid（升级会换新 ID，那是该再响一次的情形）')

      const red = T.parseNmcAlarmResult(mk({ kind: 'rainstorm', level: 'red', title: '海南省陵水县气象台发布暴雨红色预警信号' }))
      assert(red.ok && red.alert.severity === 'red' && red.alert.cnRank === 4, '红色 → severity=red（静默时段能穿透的只有它）')
      assert(T.parseNmcAlarmResult(mk({ alertid: '' })).kind === 'schema', '缺 alertid → schema')
      assert(T.parseNmcAlarmResult(mk({ kind: undefined })).kind === 'schema', '缺 kind → schema（Host 必须给）')
      assert(T.parseNmcAlarmResult(mk({ kind: 'typhoon' })).kind === 'empty',
        '不在范围内的灾种 → empty（向前兼容：Host 将来多转发灾种时旧 Client 静默跳过，而不是点亮蓝点）')
      assert(T.parseNmcAlarmResult(mk({ level: 'purple' })).kind === 'schema', '认不出的等级 → schema')
      assert(T.parseNmcAlarmResult(mk({ title: '某机构发布暴雨橙色预警信号' })).kind === 'schema',
        'title 里解析不出机构名 → schema（匹配完全依赖它，宁可点亮蓝点也不播报给不知道发给谁的人）')
      assert(T.parseNmcAlarmResult(mk({ issued: '' })).kind === 'schema', '缺发布时间 → schema')
      assert(T.parseNmcAlarmResult(mk({ issued: '2200-01-01T00:00:00+08:00' })).kind === 'value', '时间在 100 年后 → value')
      assert(T.parseNmcAlarmResult(null).kind === 'schema', '非对象 → schema')
    }

    console.log('== 0.5.2 Client：行政区归属（含别名） ==')
    {
      const cases = [
        ['云南省丽江市宁蒗彝族自治县气象台', '云南省', '丽江市'],
        // 别名：GeoNames 的显示名是「毕节地区」，气象台写「毕节市」
        ['贵州省毕节市威宁县气象台', '贵州省', '毕节地区'],
        // 别名：GeoNames 的显示名是「思茅市」（普洱的旧名），气象台写「普洱市」
        ['云南省普洱市墨江哈尼族自治县气象台', '云南省', '思茅市'],
        // 直辖市：省名之后没有市名，靠"该省下只有一个条目"补上
        ['上海市浦东新区气象台', '上海市', '上海市'],
        // 省直辖县：本来就不属于任何地级市 → city 为空，由调用方按省放行
        ['海南省乐东县气象台', '海南省', ''],
        // 省级台：同样只到省
        ['辽宁省气象台', '辽宁省', ''],
      ]
      for (const [org, prov, city] of cases) {
        const a = T.cnAreaOf(org)
        assert(a && a.matched && a.province === prov && a.city === city,
          org + ' → ' + (prov || '?') + ' / ' + (city || '（仅省）'))
      }
      // 误配防护：省别名里含「海南」，而青海省有个「海南藏族自治州」——全局搜索会把它归到海南省
      const qh = T.cnAreaOf('青海省海南藏族自治州共和县气象台')
      assert(qh && qh.province === '青海省', '「青海省海南藏族自治州」归青海省，不被省别名「海南」抢走（省名必须出现在开头）')
      assert(T.cnAreaOf('') && T.cnAreaOf('').matched === false, '空机构名 → matched=false（省级兜底的输入）')
      assert(T.cnAreaOf('中国气象局').matched === false, '认不出的机构 → matched=false（国家级预警按全国放行）')
      assert(T.normAliases(['丽江市', '丽江', '丽', ''], '丽江市').join(',') === '丽江',
        '别名规整：去掉与显示名重复的、单字的、空的')
      assert(T.normAliases(['aa', 'bb', 'cc', 'dd', 'ee', 'ff', 'gg', 'hh', 'ii', 'jj'], 'zz').length === 8, '别名上限 8 条')
      assert(T.normAliases(undefined, 'x').length === 0, '缺 aliases 字段（Host 未升级）→ 空数组，别名是增强而不是前提')
    }

    console.log('== 0.5.2 Client：行政区层级匹配 ==')
    {
      const place = { name: '云南省·丽江市', lat: 26.85, lon: 100.51, radiusKm: 100 }
      const mkAlert = (o) => T.parseNmcAlarmResult(Object.assign({
        alertid: 'a1',
        title: '云南省丽江市宁蒗彝族自治县气象台发布暴雨橙色预警信号',
        issued: '2026-09-19T03:01:00+08:00',
        kind: 'rainstorm',
        level: 'orange',
        detail: '',
      }, o || {})).alert
      const cfgWith = (watch, disasters) => ({
        watch: Object.assign({ prefectures: [], cities: [], places: [] }, watch || {}),
        disasters: Object.assign({ earthquake: true, tsunami: true, weather: true, cnRainstorm: true, cnGeology: true }, disasters || {}),
        thresholds: {},
      })
      let m = T.matchAlert(mkAlert(), cfgWith({ places: [place] }))
      assert(m.hit === true && m.reason.indexOf('丽江市') !== -1, '命中关注的市（' + m.reason + '）')
      m = T.matchAlert(mkAlert(), cfgWith({ places: [{ name: '云南省·昆明市', lat: 25, lon: 102.7, radiusKm: 100 }] }))
      assert(m.hit === false && m.reason.indexOf('不在关注列表') !== -1, '同省不同市 → 不命中（' + m.reason + '）')
      m = T.matchAlert(mkAlert(), cfgWith({ places: [{ name: '京都', lat: 35, lon: 135, radiusKm: 300 }] }))
      assert(m.hit === false && m.reason.indexOf('未设置中国大陆关注点') !== -1,
        '只有自由坐标点（无「省·市」名）→ 明确说明没配中国大陆关注点，不静默（' + m.reason + '）')
      // 门槛：黄 / 蓝只入历史
      m = T.matchAlert(mkAlert({ level: 'yellow' }), cfgWith({ places: [place] }))
      assert(m.hit === false && m.reason.indexOf('未达橙色') !== -1, '黄色 → 不播报，reason 说清是等级不够（' + m.reason + '）')
      m = T.matchAlert(mkAlert({ level: 'blue' }), cfgWith({ places: [place] }))
      assert(m.hit === false, '蓝色 → 不播报')
      m = T.matchAlert(mkAlert({ level: 'red' }), cfgWith({ places: [place] }))
      assert(m.hit === true, '红色 → 播报')
      // 两个灾种各有开关（DESIGN 8.4）
      m = T.matchAlert(mkAlert(), cfgWith({ places: [place] }, { cnRainstorm: false }))
      assert(m.hit === false && m.reason.indexOf('暴雨') !== -1, '关掉暴雨 → 不播报暴雨')
      m = T.matchAlert(mkAlert(), cfgWith({ places: [place] }, { cnGeology: false }))
      assert(m.hit === true, '关掉地质灾害不影响暴雨（两个开关互不牵连）')
      const geo = mkAlert({ kind: 'geology', level: 'orange', title: '云南省丽江市气象台发布地质灾害橙色预警信号' })
      m = T.matchAlert(geo, cfgWith({ places: [place] }, { cnGeology: false }))
      assert(m.hit === false && m.reason.indexOf('地质灾害') !== -1, '关掉地质灾害 → 不播报地质灾害')
      // 省级兜底：省直辖县（市归属为空）按省放行，宁可多报绝不漏报
      const hainan = mkAlert({ level: 'red', kind: 'rainstorm', title: '海南省陵水县气象台发布暴雨红色预警信号' })
      m = T.matchAlert(hainan, cfgWith({ places: [{ name: '海南省·海口市', lat: 20.03, lon: 110.34, radiusKm: 100 }] }))
      assert(m.hit === true && m.reason.indexOf('仅能定位到 海南省') !== -1,
        '省直辖县（归属只到省）→ 按省放行并说明原因（' + m.reason + '）')
      m = T.matchAlert(hainan, cfgWith({ places: [{ name: '广东省·广州市', lat: 23.13, lon: 113.26, radiusKm: 100 }] }))
      assert(m.hit === false, '同一条预警对另一个省的用户不命中（按省放行不等于全国放行）')
      // 国家级 / 认不出省的机构 → 全国放行（这类实测为 0 条，但真出现时不该漏）
      const national = mkAlert({ level: 'red', title: '中央气象台发布暴雨红色预警信号' })
      m = T.matchAlert(national, cfgWith({ places: [{ name: '广东省·广州市', lat: 23.13, lon: 113.26, radiusKm: 100 }] }))
      assert(m.hit === true && m.reason.indexOf('未能定位到省份') !== -1, '认不出省 → 按全国放行')
      assert(T.cnPlaceParts('云南省·丽江市').city === '丽江市' && T.cnPlaceParts('京都') === null,
        '「省·市」解析：自由坐标点不参与行政区匹配')
    }

    // 契约层：新源必须同时出现在 SOURCE_CONTRACTS 与设置页的源状态里
    assert(T.SOURCE_CONTRACTS && T.SOURCE_CONTRACTS.nmc_alarm, 'nmc_alarm 有校验约定（字段契约 / 时区 / 新鲜度阈值）')
    assert(T.SOURCE_CONTRACTS.nmc_alarm.staleAfterMs === 3 * 60 * 60 * 1000, '停更阈值 3 小时')
    T.resetCityTable()
  } catch (e) {
    assert(false, '0.5.2 大陆气象源检查失败：' + e.message + '\n' + (e && e.stack ? e.stack.split('\n').slice(1, 3).join('\n') : ''))
  }

  // ==========================================================================
  // 0.5.3：校验机制（探针阈值 / 蓝点生命周期 / 升级阈值 / 字节预算 / Host-Client 一致）
  //
  // 这一节的断言刻意都在问「这个能力**真的生效**了吗」，而不是「函数被调用了」。
  // 依据是 0.5.1 的复盘：那一轮抓出的 4 条缺陷（48 小时停更探针、SSE 的 stale 可见性、
  // 速报的批量语义、pruneSeen）全都是"写了、注释齐、单测过、但能力不生效"的形态。
  // ==========================================================================
  try {
    console.log('== 0.5.3 机制层：契约阈值真的生效了吗 ==')
    {
      let clock = 1_700_000_000_000
      const pushes = []
      T.resetSourceHealth()
      const probe = T.createHealthProbe({ now: () => clock, pushSource: (id, p) => pushes.push([id, p]) })

      // ① 阈值只从契约来：把契约里的数字改成 1 分钟，行为必须跟着变
      const orig = T.SOURCE_CONTRACTS.usgs.staleAfterMs
      try {
        T.SOURCE_CONTRACTS.usgs.staleAfterMs = 60 * 1000
        assert(T.staleAfterOf('usgs') === 60 * 1000, '探针阈值取自契约（不是某处硬编码）')
        T.noteFreshness('usgs', clock)
        probe.tick()
        assert(T.sourceHealthOf('usgs').fresh.stale === false, '刚拿到数据 → 不停更')
        clock += 61 * 1000
        probe.tick()
        assert(T.sourceHealthOf('usgs').fresh.stale === true,
          '超过契约里的 1 分钟 → 判停更（改契约即改行为，这就是"声明生效"）')
        assert(pushes.some((x) => x[0] === 'usgs' && x[1].status === 'stale'),
          '停更时上报了 stale 状态（否则"数据已过期"永远不会出现在界面上）')
        clock += 1000
        T.noteFreshness('usgs', clock)
        probe.tick()
        assert(T.sourceHealthOf('usgs').fresh.stale === false, '数据恢复 → 停止更')
      } finally {
        T.SOURCE_CONTRACTS.usgs.staleAfterMs = orig
      }
      // ② staleAfterMs 为 null 的推送源不判（日本可能数小时没有有感地震，而连接是好的）
      T.resetSourceHealth()
      T.noteFreshness('p2pquake', clock)
      clock += 10 * 60 * 60 * 1000
      probe.tick()
      assert(T.sourceHealthOf('p2pquake').fresh.stale === false,
        '契约里 staleAfterMs=null 的推送源不判停更')
      // ③ 从未上报过数据时间 → 不判（"不知道数据什么时候来的"不等于"数据是旧的"）
      T.resetSourceHealth()
      probe.tick()
      assert(!T.sourceHealthOf('usgs') || T.sourceHealthOf('usgs').fresh.stale === false,
        '从未上报数据时间 → 不判停更（不猜）')
      assert(T.staleAfterOf('p2pquake') === 0 && T.staleAfterOf('emsc') === 0 && T.staleAfterOf('noaa') === 0,
        '三个 staleAfterMs=null 的源（两个推送源 + NOAA 的"列表为空是常态"）归一成 0')
      T.resetSourceHealth()
    }

    console.log('== 0.5.3 机制层：蓝点跨刷新存活 + TTL 自愈 ==')
    {
      const c1 = loadClientEx()
      const t1 = c1.exports.__test
      t1.resetSourceHealth()
      for (let i = 0; i < t1.SCHEMA_ESCALATE_CONSECUTIVE; i++) {
        t1.noteParseResult('usgs', t1.failResult('schema', '上游把 properties.mag 改名了'))
      }
      assert(t1.store.sources.usgs.status === 'schema-error', '（前置）蓝点点亮')
      // 模拟「页面刷新」：同一个 localStorage，重新执行一遍 client bundle
      const seed = {}
      for (const [k, v] of c1.storage) seed[k] = v
      const c2 = loadClientEx(seed)
      const t2 = c2.exports.__test
      assert(!t2.store.sources.usgs || t2.store.sources.usgs.status !== 'schema-error',
        '刷新那一刻连接状态是空的（conn 层不持久化，重启即重新建连）')
      assert(t2.sourceHealthOf('usgs').data && t2.sourceHealthOf('usgs').data.detail.indexOf('mag') !== -1,
        '但数据健康记录还在 —— 蓝点跨刷新存活（DESIGN 11.6 第 7 条要的就是这个）')
      assert(t2.effectiveStatusOf('usgs', 'open', '连接正常').status === 'schema-error',
        '所以新会话一开始就如实显示为"数据格式异常"，而不是装作一切正常')
      const healed = t2.pruneHealth(Date.now() + t2.HEALTH_TTL_MS + 1000)
      assert(healed === 1 && t2.sourceHealthOf('usgs').data === null,
        '24 小时没有复现 → 自动清除（TTL 自愈；cenc_eew 那种数天一条数据的源靠它恢复）')
      const c3 = loadClientEx(seed)
      const t3 = c3.exports.__test
      assert(t3.loadHealth(Date.now() + t3.HEALTH_TTL_MS + 1000) === 0,
        '过期的持久化记录在**读取**时也被丢弃（关掉浏览器三天再打开不该看到陈旧蓝点）')
      t3.resetSourceHealth()
    }

    console.log('== 0.5.3：环缓冲字节预算（DESIGN 11.6 第 5 条） ==')
    {
      const pollerMod = await import(pathToFileURL(path.join(ROOT, 'lib', 'poller.js')).href)
      const payload = 'x'.repeat(400)
      const mkPoller = (maxBufferBytes) => pollerMod.createPoller({
        feedUrl: 'feed://x',
        parseFeed: () => [
          { id: 'a', updated: '2026-01-01T00:00:00Z', payload },
          { id: 'b', updated: '2026-01-01T00:00:01Z', payload },
          { id: 'c', updated: '2026-01-01T00:00:02Z', payload },
        ],
        singleStage: true,
        maxEntries: 120,
        maxBufferBytes,
        now: () => 1_700_000_000_000,
        startedAt: 0,
        fetchText: async () => 'feed',
        idleMs: 0,
      })
      const big = mkPoller(0)
      await big.pollOnce()
      assert(big.snapshot(0, {}).entries.length === 3, '不限字节时三条都留着（对照）')
      const capped = mkPoller(1000)
      await capped.pollOnce()
      const snap = capped.snapshot(0, {})
      assert(snap.entries.length === 2, '预算 1000 / 每条 400 → 只留 2 条')
      assert(snap.entries[0].id === 'b', '留下的是较新的两条（从最旧的一端淘汰）')
      assert(capped.stats().dropped === 1, '淘汰计入 dropped')
      assert(snap.truncated === true, '于是 truncated 为真 —— Client 会知道中间有缺口，而不是以为补齐了')
      assert(capped.stats().bufferBytes <= 1000, 'bufferBytes 不超预算（' + capped.stats().bufferBytes + '）')
      const tiny = mkPoller(1)
      await tiny.pollOnce()
      assert(tiny.snapshot(0, {}).entries.length === 1,
        '预算装不下一条时仍留一条（那一条正是用户要看的数据，全清掉等于"什么都没收到"）')
    }

    console.log('== 0.5.3：Host 与 Client 的停更阈值一致 ==')
    {
      const host = await import(pathToFileURL(path.join(ROOT, 'lib', 'index.js')).href)
      const nmcMod = await import(pathToFileURL(path.join(ROOT, 'lib', 'nmc-source.js')).href)
      assert(T.SOURCE_CONTRACTS.jma.staleAfterMs === host.JMA_STALE_MS,
        'jma：契约 ' + T.SOURCE_CONTRACTS.jma.staleAfterMs + ' = Host 常量 ' + host.JMA_STALE_MS +
        '（两个半边分开构建，一致性只能靠断言）')
      assert(T.SOURCE_CONTRACTS.usgs.staleAfterMs === host.USGS_STALE_MS, 'usgs：契约与 Host 常量一致')
      assert(T.SOURCE_CONTRACTS.nmc_alarm.staleAfterMs === nmcMod.NMC_STALE_MS, 'nmc_alarm：契约与 Host 常量一致')
      assert(T.SCHEMA_ESCALATE_COUNT > 1 && T.SCHEMA_ESCALATE_CONSECUTIVE > T.SCHEMA_ESCALATE_COUNT,
        '两条升级路径的阈值都 > 1（单条失败绝不升级 —— 这是 0.5.3 的前提）')
      assert(T.HEALTH_TTL_MS === 24 * 60 * 60 * 1000, '蓝点 TTL 是 24 小时')
    }
  } catch (e) {
    assert(false, '0.5.3 校验机制检查失败：' + e.message + '\n' + (e && e.stack ? e.stack.split('\n').slice(1, 3).join('\n') : ''))
  }

  console.log('== 0.5.4：状态合成 / 跨标签页清空 / 契约原型链 / JMA 标签 / 演示链路 ==')
  try {
    // ---- 1. 展示状态是**合成**出来的：蓝点不被探针或连接层抹掉 ----
    {
      const t = loadClientEx().exports.__test
      const store = t.store
      store.pushSource('usgs', { status: 'open' })
      for (let i = 0; i < 5; i++) t.noteParseResult('usgs', { ok: false, kind: 'schema', detail: '上游把 properties.mag 改名了' })
      assert(store.sources.usgs.status === 'schema-error', '（前置）连续 5 条同因失败 → 数据格式异常（蓝点）')
      t.noteFreshness('usgs', Date.now() - 60 * 60 * 1000)
      const probe = t.createHealthProbe()
      probe.tick()
      assert(store.sources.usgs.status === 'schema-error',
        '探针判「数据已过期」不改展示状态 —— schema-error 优先于 stale')
      t.noteFreshness('usgs', Date.now())
      probe.tick()
      assert(store.sources.usgs.status === 'schema-error',
        '探针判「数据已恢复」也不会把蓝点刷成绿色（修复前正是这条：能力写了、但被后写者覆盖）')

      // 连接层的常态上报（P2PQuake 约每 10 分钟一次断线）同样不能抹掉蓝点
      const sockets = []
      function FakeWs(url) { this.url = url; this.readyState = 0; sockets.push(this) }
      FakeWs.prototype.close = function () { this.readyState = 3; if (this.onclose) { const f = this.onclose; this.onclose = null; f() } }
      const t2 = loadClientEx(null, { window: { WebSocket: FakeWs } }).exports.__test
      const ws = t2.createWsClient({ sourceId: 'emsc', urlOf: () => 'wss://example.invalid/ws', onRaw: () => {} })
      ws.start()
      sockets[0].onopen()
      for (let i = 0; i < 5; i++) t2.noteParseResult('emsc', { ok: false, kind: 'schema', detail: '字段改名了' })
      assert(t2.store.sources.emsc.status === 'schema-error', '（前置）EMSC 蓝点')
      sockets[0].onclose()
      assert(t2.store.sources.emsc.status === 'schema-error',
        '一次常态断线（reconnecting）不会冲掉蓝点 —— 用户要看见的是"数据读不懂"，不是"正在重连"')
      ws.stop()

      // 跨刷新：蓝点落盘 → 重新加载 → 装载时立刻重发（而不是等该源下一次上报）
      const first = loadClientEx()
      const t3 = first.exports.__test
      for (let i = 0; i < 5; i++) t3.noteParseResult('jma', { ok: false, kind: 'schema', detail: '结构变了' })
      const second = loadClientEx(Object.fromEntries(first.storage))
      const t4 = second.exports.__test
      t4.republishDataHealth()
      assert(!!(t4.store.sources.jma && t4.store.sources.jma.status === 'schema-error'),
        '模拟页面重载 + republishDataHealth → 蓝点立刻回到 store')
      assert(!!(t4.store.sources.jma && t4.store.sources.jma.label && t4.store.sources.jma.label !== 'jma'),
        '重发的蓝点带上契约里的源名而不是裸 id：' + String(t4.store.sources.jma && t4.store.sources.jma.label))
    }

    // ---- 2. 跨标签页「清空记录」要真的清干净 ----
    {
      const mem = new Map()
      const ls = {
        getItem: (k) => (mem.has(k) ? mem.get(k) : null),
        setItem: (k, v) => mem.set(k, String(v)),
        removeItem: (k) => mem.delete(k),
      }
      const chans = []
      function FakeBC() { this.onmessage = null; chans.push(this) }
      FakeBC.prototype.postMessage = function (d) { for (const c of chans) if (c !== this && c.onmessage) c.onmessage({ data: d }) }
      FakeBC.prototype.close = function () {}
      const A = loadClientEx(null, { window: { localStorage: ls, BroadcastChannel: FakeBC } }).exports.__test
      const B = loadClientEx(null, { window: { localStorage: ls, BroadcastChannel: FakeBC } }).exports.__test
      A.ensureAlertChannel(); B.ensureAlertChannel()
      const ev = (id) => ({ id, code: 551, kind: 'quake', label: '地震速报·震度速报', severity: 'yellow', issued: '', headline: 'h', hit: true })
      A.addEvent(ev('x1')); B.addEvent(ev('x1'))
      A.store.push({ events: [] })
      ls.setItem('dsh.quakeAlert.history', '[]')
      A.broadcastHistoryCleared()
      assert(B.store.events.length === 0,
        '另一个标签页的内存历史也被清空（修复前只清了 alertedEvents，列表里仍显示着旧记录）')
      B.addEvent(ev('x2'))
      const disk = JSON.parse(mem.get('dsh.quakeAlert.history') || '[]')
      assert(!disk.some((e) => e.id === 'x1'),
        '被清掉的记录不会被另一个标签页的下一次 addEvent 写回磁盘（清空若出于隐私动机，这就是泄漏面）')
    }

    // ---- 3. 契约层查表不再命中原型链 ----
    {
      const base = { alertid: '53072441600000_x', title: '云南省丽江市宁蒗彝族自治县气象台发布暴雨橙色预警信号', issued: '2026-09-19T03:02:45+08:00' }
      const r1 = T.parseNmcAlarmResult(Object.assign({}, base, { kind: 'constructor', level: 'orange' }))
      assert(r1.ok === false && r1.kind === 'empty', 'kind=constructor 被判 empty（修复前直接放行，kindLabel 里嵌进函数源码）')
      const r2 = T.parseNmcAlarmResult(Object.assign({}, base, { kind: 'rainstorm', level: 'constructor' }))
      assert(r2.ok === false && r2.kind === 'schema', 'level=constructor 被判 schema（修复前 severity 变成函数对象）')
      const ok = T.parseNmcAlarmResult(Object.assign({}, base, { kind: 'rainstorm', level: 'orange' }))
      assert(ok.ok === true && ok.alert.cnRank === 3, '（对照）正常的 kind / level 仍然通过')
    }

    // ---- 4. JMA 汇总副本的标签按**级别**判 ----
    {
      const danger = fs.readFileSync(path.join(ROOT, 'samples', 'jma-vpww53-hyogo-danger-20260914.xml'), 'utf8')
      const a = T.parseJma(danger, { id: 'jma-vpww53-hyogo-danger-20260914.xml' })
      assert(!!a && a.level === 4, '（前置）兵庫県样本是 L4 危険警報')
      assert(!!a && a.kindLabel !== '气象特别警报',
        'L4 的 VPWW53 不再被标成「气象特别警报」（特別警報是 L5，最高级别）：' + String(a && a.kindLabel))
      const special = fs.readFileSync(path.join(ROOT, 'samples', 'jma-vpww53-tokyo-special-20260907.xml'), 'utf8')
      const b = T.parseJma(special, { id: 'jma-vpww53-tokyo-special-20260907.xml' })
      assert(!!b && b.level === 5 && b.kindLabel === '气象特别警报', '真正的 L5 特別警報仍然显示为「气象特别警报」')
      const heavy = fs.readFileSync(path.join(ROOT, 'samples', 'jma-vpww55-heavyrain.xml'), 'utf8')
      const c = T.parseJma(heavy, { id: 'jma-vpww55-heavyrain.xml' })
      assert(!!c && c.kindLabel === '大雨警报', '带灾种名的副本仍给出具体灾种（不被汇总分支抢走）：' + String(c && c.kindLabel))
    }

    // ---- 5. 未配置大陆关注点：不进历史，但判定要带 noWatch 标记 ----
    {
      const t = loadClientEx().exports.__test
      const cfg = t.loadCfg()
      assert(cfg.watch.places.length === 0, '（前置）默认配置里没有大陆关注点')
      const alert = t.parseNmcAlarm({
        alertid: '53072441600000_y', title: '云南省丽江市宁蒗彝族自治县气象台发布暴雨橙色预警信号',
        issued: '2026-09-19T03:02:45+08:00', kind: 'rainstorm', level: 'orange', detail: '',
      })
      const m = t.matchAlert(alert, cfg)
      assert(m.hit === false && m.noWatch === true, '「未设置中国大陆关注点」带 noWatch 标记')
      const before = t.store.events.length
      t.handleAlert(alert, cfg)
      assert(t.store.events.length === before,
        '未配置关注点时不写历史 —— 否则默认配置的用户每天被几十条无关大陆预警刷满「最近预警」')
    }

    // ---- 6. nmc 电文不会清空日本电文留下的 L3 提示 ----
    {
      const t = loadClientEx().exports.__test
      const cfg = t.loadCfg()
      const l3 = t.parseJma(t.buildTestTelegram('東京都', 1700000000000, 'landslide-l3', ''), { id: 'test-l3' })
      t.updateWeatherHint(l3, cfg)
      assert(!!(t.store.weatherHint && t.store.weatherHint.level === 3), '（前置）日本 L3 命中 → 侧边栏留一条提示')
      const nmc = t.parseNmcAlarm({
        alertid: '53072441600000_z', title: '云南省丽江市宁蒗彝族自治县气象台发布暴雨橙色预警信号',
        issued: '2026-09-19T03:02:45+08:00', kind: 'rainstorm', level: 'orange', detail: '',
      })
      t.updateWeatherHint(nmc, cfg)
      assert(!!(t.store.weatherHint && t.store.weatherHint.level === 3),
        '大陆气象电文（regions 恒为空）不会把日本电文的 L3 提示清成 null')
    }

    // ---- 7. 测试按钮可反复点击（事件键带毫秒，与全球链路同口径） ----
    {
      const t = loadClientEx().exports.__test
      const mk = (ms) => {
        const a = t.parseJma(t.buildTestTelegram('東京都', ms, 'heavyrain', ''), { id: 'test-weather-' + ms })
        a.eventKey = 'test-weather:' + ms + ':heavyrain'
        return a
      }
      const r1 = t.handleAlert(mk(1700000000001), t.currentCfg(), { skipQuietHours: true })
      const r2 = t.handleAlert(mk(1700000000002), t.currentCfg(), { skipQuietHours: true })
      assert(r1.notified === true && r2.notified === true,
        '同一场景连点两次都播报（修复前第二次会被判成"同一事件的后续发布"而静默）')
    }

    // ---- 8. 降级客户端建立失败要回滚，不能谎报「已降级为轮询」 ----
    {
      const t = loadClientEx().exports.__test
      const stream = t.createCnStream({
        id: 'cenc_eew',
        createEventSource: () => { throw new Error('没有 EventSource') },
        createFallback: () => { throw new Error('建立轮询客户端失败') },
      })
      stream.start()
      assert(stream.modeOf() === 'idle',
        '降级建立失败后回滚到 idle（修复前 mode 停在 poll：UI 说"已降级"，实际一条预警都收不到）')
      stream.stop()
    }

    // ---- 9. WebSocket 客户端 stop 之后 start 是活的 ----
    {
      const sockets = []
      function FakeWs2(url) { this.url = url; this.readyState = 0; sockets.push(this) }
      FakeWs2.prototype.close = function () { this.readyState = 3 }
      const t = loadClientEx(null, { window: { WebSocket: FakeWs2 } }).exports.__test
      const c = t.createWsClient({ onRaw: () => {} })
      c.start()
      const n1 = sockets.length
      c.stop()
      c.start()
      assert(sockets.length === n1 + 1, 'stop 之后再 start 会真的新建连接（修复前 start 不清 stopped，静默无效）')
      c.stop()
    }

    // ---- 10. Host poller：空闲后停链 + markRead 唤醒（0.5.4 / DESIGN 5.2 的按需轮询） ----
    {
      const realSet = global.setTimeout
      const realClear = global.clearTimeout
      const pending = []
      // poller 用模块内的全局 setTimeout，只能这样注入（跑完在 finally 里恢复）
      global.setTimeout = (fn, ms) => { const t = { fn, ms, cleared: false, unref() {} }; pending.push(t); return t }
      global.clearTimeout = (t) => { if (t) t.cleared = true }
      try {
        const pollerMod = await import(pathToFileURL(path.join(ROOT, 'lib', 'poller.js')).href)
        const poller = pollerMod.createPoller({
          feedUrl: 'https://example.invalid/feed', parseFeed: () => [], singleStage: true,
          idleMs: 60 * 1000, firstDelayMs: 1500, intervalMs: 60 * 1000,
          fetchText: async () => '[]',
        })
        const runOne = async () => { const t = pending.shift(); if (t && !t.cleared) await t.fn() }
        poller.start()
        await runOne()
        assert(pending.length === 0,
          '空闲一轮之后不再自续（修复前每 5 秒一轮永远不停，idleSkips 一天 +17280 且显示成「节流跳过 N 次」）')
        assert(poller.stats().idleSkips === 1, 'idleSkips 只记一次"进入空闲"：' + poller.stats().idleSkips)
        assert(poller.stats().polls === 0, '（对照）空闲期间没有产生任何外部请求')
        poller.markRead()
        assert(pending.length === 1 && pending[0].ms === pollerMod.IDLE_RETRY_MS,
          'markRead（/feed 被访问）唤醒轮询：排出一个短退避')
        await runOne()
        assert(poller.stats().polls === 1, '唤醒之后真的拉了源')
        assert(pending.length === 1 && pending[0].ms === 60 * 1000, '成功一轮之后回到正常间隔')
        poller.stop()
      } finally {
        global.setTimeout = realSet
        global.clearTimeout = realClear
      }
    }

    // ---- 11. Host settings 迁移标记：以 Host 为准时要认领，避免本地镜像日后复活 ----
    {
      const seed = { 'dsh.quakeAlert.v1': JSON.stringify({ version: 1, thresholds: { quakeScale: 30 } }) }
      const first = loadClientEx(seed)
      const t = first.exports.__test
      let snap = {
        status: 'ready', mode: 'host', writable: true,
        value: { thresholds: { quakeScale: 55 } }, user: { thresholds: { quakeScale: 55 } },
      }
      let syncFn = null
      const scope = {
        getSnapshot: () => snap,
        subscribe: (fn) => { syncFn = fn; return () => {} },
        mutate: () => Promise.resolve(),
      }
      t.bindSettingsScope(scope)
      assert(t.currentCfg().thresholds.quakeScale === 55, '（前置）Host 已有内容 → 以 Host 为准')
      assert(first.storage.get('dsh.quakeAlert.hostMigrated') === '1',
        '首次 bind 时 Host 已非空也要落「已认领」标记（修复前永不落盘）')
      // Host 被清空（用户在别处恢复默认）→ 本地那份**过期**的镜像不该迁回去
      snap = { status: 'ready', mode: 'host', writable: true, value: {}, user: {} }
      if (typeof syncFn === 'function') syncFn()
      assert(t.currentCfg().thresholds.quakeScale === 40,
        'Host 清空后不会被本地旧值复活（修复前实测会写回 55）：' + t.currentCfg().thresholds.quakeScale)
    }
  } catch (e) {
    assert(false, '0.5.4 检查失败：' + e.message + '\n' + (e && e.stack ? e.stack.split('\n').slice(1, 3).join('\n') : ''))
  }

  // ==========================================================================
  // 0.6.0 第 2 期：海外气象源（美国 NWS / 加拿大 ECCC）的解析层与契约
  // 全部用 samples/nws/ 与 samples/eccc/ 的真实 fixture，不联网。
  // 这一批断言问的是"能力真的生效吗"（11.9 F）：白名单真的在拦、门槛真的按 event 分档、
  // 事件键真的把同一次事件的 Update 归并到一起、许可要求的署名真的进了正文。
  // ==========================================================================
  try {
    const T6 = loadClientEx().exports.__test
    const nwsSample = JSON.parse(fs.readFileSync(path.join(ROOT, 'samples', 'nws', 'nws-flood-alerts.geojson'), 'utf8'))
    const ecccSample = JSON.parse(fs.readFileSync(path.join(ROOT, 'samples', 'eccc', 'eccc-alerts.geojson'), 'utf8'))
    const usPlace = { name: '休斯敦', lat: 29.7604, lon: -95.3698, radiusKm: 100 }
    const caPlace = { name: '多伦多', lat: 43.6532, lon: -79.3832, radiusKm: 150 }
    const jpPlace = { name: '东京', lat: 35.6812, lon: 139.7671, radiusKm: 100 }
    // 取数器与匹配层只读配置，不写；复制一份避免污染 currentCfg 返回的对象。
    const mkCfg = (places, overseas) => {
      const c = JSON.parse(JSON.stringify(T6.currentCfg()))
      c.watch.places = places
      c.disasters.overseasWeather = overseas !== false
      return c
    }
    const nwsByEvent = (ev) => nwsSample.features.filter((f) => f.properties.event === ev)[0]

    console.log('== 0.6.0 NWS：白名单 / 门槛 / 事件键 ==')

    // ---- 1. 白名单：8 类事件一个都不能少，且都能从真实 fixture 走通 ----
    {
      const white = T6.NWS_EVENT_WHITELIST
      const want = ['Flood Warning', 'Flash Flood Warning', 'Coastal Flood Warning', 'Flood Watch',
        'Flood Advisory', 'Coastal Flood Watch', 'Coastal Flood Advisory', 'Coastal Flood Statement']
      assert(want.every((e) => Object.prototype.hasOwnProperty.call(white, e)),
        '8 类洪水事件都在白名单里（契约里声明了几类，这里就必须有几类）')
      let okCount = 0
      for (const f of nwsSample.features) {
        const r = T6.parseNwsAlertResult(f, { place: usPlace })
        if (r.ok) okCount += 1
        else assert(false, '真实 fixture 里的 ' + f.properties.event + ' 解析失败：' + r.kind + ' ' + r.detail)
      }
      assert(okCount === nwsSample.features.length, 'fixture 里的每一条都解析成功（' + okCount + ' 条）')
    }

    // ---- 2. 门槛按 event 分档，**不按 severity**——这条有实测证据 ----
    {
      const fw = T6.parseNwsAlertResult(nwsByEvent('Flood Warning'), { place: usPlace }).alert
      const ffw = T6.parseNwsAlertResult(nwsByEvent('Flash Flood Warning'), { place: usPlace }).alert
      const watch = T6.parseNwsAlertResult(nwsByEvent('Flood Watch'), { place: usPlace }).alert
      const adv = T6.parseNwsAlertResult(nwsByEvent('Flood Advisory'), { place: usPlace }).alert
      assert(fw.overseasRank >= T6.OVERSEAS_BROADCAST_MIN_RANK, 'Flood Warning 达到播报线（Warning 类）')
      assert(ffw.overseasRank >= T6.OVERSEAS_BROADCAST_MIN_RANK, 'Flash Flood Warning 达到播报线')
      assert(watch.overseasRank < T6.OVERSEAS_BROADCAST_MIN_RANK, 'Flood Watch 不到播报线（只进历史）')
      assert(adv.overseasRank < T6.OVERSEAS_BROADCAST_MIN_RANK, 'Flood Advisory 不到播报线')
      // 关键证据：Flood Watch 的 severity 实测是 Severe（与 Flood Warning 同级），
      // 所以"按 severity ≥ orange 播报"会把警戒当警报播出去。门槛必须看 event 名。
      assert(watch.severity === 'orange' && watch.overseasRank < T6.OVERSEAS_BROADCAST_MIN_RANK,
        'Flood Watch 的 severity 是 orange 但档位不到线——这正是"门槛不能按 severity"的实测证据')
    }

    // ---- 3. severity 忠实映射，不拔高 ----
    {
      assert(T6.NWS_SEVERITY.Extreme === 'red' && T6.NWS_SEVERITY.Severe === 'orange' &&
        T6.NWS_SEVERITY.Moderate === 'yellow' && T6.NWS_SEVERITY.Minor === 'info',
        'NWS 的四个 severity 各自映射到本项目配色，不做"恒 red"那种拔高')
      const fw = T6.parseNwsAlertResult(nwsByEvent('Flood Warning'), { place: usPlace }).alert
      assert(fw.severity === 'orange', 'Flood Warning（Severe）→ orange，未被拔高成 red')
    }

    // ---- 4. 时间：NWS 自带偏移，**不做换算**（与 JMA / nmc / Wolfx 相反的形态）----
    {
      const f = nwsByEvent('Flood Warning')
      const a = T6.parseNwsAlertResult(f, { place: usPlace }).alert
      assert(a.issued === f.properties.sent, 'issued 原样保留响应里的带偏移时刻：' + a.issued)
      assert(/[+-]\d{2}:\d{2}$/.test(a.issued), '确实是带偏移的 ISO（不是补出来的本地时间）')
    }

    // ---- 5. 事件键：按 CAP 的 references 归并事件链（0.6.0 review 修正的核心） ----
    {
      const f = nwsByEvent('Flood Warning')
      const base = T6.parseNwsAlertResult(f, { place: usPlace }).alert
      // 该 fixture 是 msgType=Update 且带 references → 事件键取**被取代的那条**，不是它自己
      assert(base.eventKey === T6.nwsEventKeyOf(f.properties.id, f.properties.references),
        '事件键由 identifier + references 推出')
      assert(base.eventKey === 'nws:' + f.properties.references[0].identifier.replace(/\.[0-9]+$/, ''),
        'Update 的事件键取 references 指向的原消息：' + base.eventKey)
      assert(base.eventKey !== 'nws:' + f.properties.id.replace(/\.[0-9]+$/, ''),
        '——而且它与自身 identifier 算出的键**不同**（"取消永远匹配不上"那个缺陷正来自这里）')
      // 没有 references 的原始 Alert 用自身 identifier
      const raw = nwsByEvent('Flash Flood Warning')
      const rawAlert = T6.parseNwsAlertResult(raw, { place: usPlace }).alert
      assert(rawAlert.eventKey === 'nws:' + raw.properties.id.replace(/\.[0-9]+$/, ''),
        '原始 Alert（无 references）用自身 identifier')
    }

    // ---- 5b. 取消链路端到端（review A1 的守卫） ----
    {
      const alert = T6.parseNwsAlertResult(nwsByEvent('Flood Warning'), { place: usPlace }).alert
      T6.rememberAlerted(alert) // 模拟"这条已经播报过"
      assert(T6.wasRecentlyAlerted(alert) === true, '（前置）播报后 24 小时内记得它')
      const c = JSON.parse(JSON.stringify(nwsByEvent('Flood Warning')))
      c.properties.id = c.properties.id.replace(/(\.[0-9]+)$/, '.2') // Cancel 会换新 identifier
      c.properties.messageType = 'Cancel'
      const cancelAlert = T6.parseNwsAlertResult(c, { place: usPlace }).alert
      assert(cancelAlert.cancelled === true, '（前置）messageType=Cancel → cancelled')
      assert(cancelAlert.id !== alert.id, '（前置）Cancel 的消息 id 与原来不同（CAP 要求 identifier 唯一）')
      assert(cancelAlert.eventKey === alert.eventKey,
        'Cancel 的事件键与当初播报的那条**相同**——否则用户永远收不到"此前警报已作废"')
      assert(T6.wasRecentlyAlerted(cancelAlert) === true, '于是取消链路能命中记忆，会补一条作废提醒')
    }

    // ---- 6. 取消语义：NWS 有真正的 Cancel（比 nmc 强）----
    {
      const c = JSON.parse(JSON.stringify(nwsByEvent('Flood Warning')))
      c.properties.messageType = 'Cancel'
      assert(T6.parseNwsAlertResult(c, { place: usPlace }).alert.cancelled === true, 'messageType=Cancel → cancelled')
      assert(T6.parseNwsAlertResult(nwsByEvent('Flood Warning'), { place: usPlace }).alert.cancelled === false,
        '其余 messageType（Alert / Update）不算取消')
    }

    // ---- 7. 判据的分类：不在范围内是 empty，结构不符才是 schema ----
    {
      const craft = (patch) => {
        const f = JSON.parse(JSON.stringify(nwsByEvent('Flood Warning')))
        Object.assign(f.properties, patch)
        return T6.parseNwsAlertResult(f, { place: usPlace })
      }
      assert(craft({ event: 'Small Craft Advisory' }).kind === 'empty',
        '海事通告（占全量三分之二）判 empty，不是故障')
      assert(craft({ event: 'constructor' }).kind === 'empty',
        'event=constructor 判 empty——直查白名单会命中原型链返回函数对象（0.5.4 修过的同一个坑）')
      assert(craft({ sent: undefined }).kind === 'schema', '缺 sent → schema')
      // properties.id 缺了会退回 GeoJSON 外层的 feature.id（实测外层是完整 URL）——那是有意的
      // 兜底（宁可多认一种 id 形态，也不丢一条真实预警），所以"缺 identifier"要两层都清才成立。
      {
        const noId = JSON.parse(JSON.stringify(nwsByEvent('Flood Warning')))
        noId.properties.id = undefined
        assert(T6.parseNwsAlertResult(noId, { place: usPlace }).ok === true,
          '只有 properties.id 缺失时退回外层 feature.id（兜底，不判 schema）')
        delete noId.id
        assert(T6.parseNwsAlertResult(noId, { place: usPlace }).kind === 'schema', '两层都没有 identifier → schema')
      }
      assert(T6.parseNwsAlertResult('nope', {}).kind === 'schema', '顶层不是对象 → schema')
    }

    // ---- 8. 正文原样保留（instruction 是"该怎么做"，截断它才是危险）----
    {
      const f = nwsByEvent('Flash Flood Warning')
      const a = T6.parseNwsAlertResult(f, { place: usPlace }).alert
      assert(a.detail.indexOf(String(f.properties.description).slice(0, 40)) === 0, 'detail 以官方 description 开头')
      assert(a.detail.indexOf('Turn around, don\'t drown') >= 0, 'instruction 也在 detail 里')
      assert(a.kindLabel.indexOf('美国') === 0 && a.kindLabel.indexOf('NWS') > 0,
        'kindLabel 带国别与发布机构：' + a.kindLabel)
    }

    // ---- 9. originPlace 透传（匹配层据此命中，不再算距离）----
    {
      const a = T6.parseNwsAlertResult(nwsByEvent('Flood Warning'), { place: usPlace }).alert
      assert(a.locator === 'overseas', 'locator 是 overseas（不是 point——命中在取数时就已发生）')
      assert(a.originPlace && a.originPlace.name === '休斯敦', 'originPlace 记录了这条是哪个关注点查回来的')
      const noPlace = T6.parseNwsAlertResult(nwsByEvent('Flood Warning')).alert
      assert(noPlace.originPlace === null, '取数器没给 place 时是 null，而不是 undefined/{}')
    }

    console.log('== 0.6.0 ECCC：两道过滤器 / 署名 / 事件键 ==')

    // ---- 10. 两道过滤器：advisory 与不在白名单的灾种都判 empty ----
    {
      const kinds = {}
      for (const f of ecccSample.features) {
        const r = T6.parseEcccAlertResult(f, { place: caPlace })
        kinds[f.properties.alert_code] = r.ok ? 'ok' : r.kind
      }
      assert(kinds.FTA === 'empty', 'frost advisory（advisory）判 empty：官方定义就是"非危险天气"')
      assert(kinds.WDW === 'empty', 'wind warning 判 empty：不在本插件的灾种范围内')
      assert(kinds.CFW === 'ok', 'storm surge warning 解析成功（加拿大当前唯一命中的一类）')
    }

    // ---- 11. 白名单按名称关键词，**按码猜是错的**（4.6.3 踩过 CFW 那个坑）----
    {
      // 构造一条降雨预警：**码本身用任意值**（白名单不看码，只看名称），
      // 因为 ECCC 的三字母码表没有官方枚举，而当前季节没有降雨样本。
      const f = JSON.parse(JSON.stringify(ecccSample.features[2]))
      f.properties.alert_code = 'ZZZ'
      f.properties.alert_name_en = 'rainfall warning'
      const r = T6.parseEcccAlertResult(f, { place: caPlace })
      assert(r.ok, '降雨预警（当前季节无真实样本）能通过白名单——即便码是任意值')
      assert(r.alert.headline.indexOf('降雨预警') === 0, '按名称关键词给出中文标签：' + r.alert.headline)
      assert(r.alert.ecccCode === 'ZZZ', '码只作诊断与事件键，不参与白名单判据')
      // 反向：同一权限下"风"必须被排除，即便它也是 warning
      f.properties.alert_name_en = 'wind warning'
      assert(T6.parseEcccAlertResult(f, { place: caPlace }).kind === 'empty', 'wind warning 仍被排除')
    }

    // ---- 12. 许可要求的署名真的进了正文（ECCC 独有，硬约束）----
    {
      const a = T6.parseEcccAlertResult(ecccSample.features[2], { place: caPlace }).alert
      assert(a.detail.indexOf('Data Source: Environment and Climate Change Canada') > 0,
        'detail 带署名（End-use Licence v2.1.1 要求）')
      const rawText = ecccSample.features[2].properties.alert_text_en
      assert(a.detail.indexOf(String(rawText).slice(0, 40)) === 0, '官方正文原样保留、未被改写（同一条许可要求）')
    }

    // ---- 13. 事件键按"码 + 区域 + 发布日"；消息 id 含时刻 ----
    {
      const f = ecccSample.features[2]
      const a = T6.parseEcccAlertResult(f, { place: caPlace }).alert
      assert(a.eventKey === 'eccc:CFW:' + f.properties.feature_id + ':' + f.properties.publication_datetime.slice(0, 10),
        '事件键 = 码 + 区域 + 发布日：' + a.eventKey)
      const later = JSON.parse(JSON.stringify(f))
      later.properties.publication_datetime = f.properties.publication_datetime.replace('T10:50', 'T14:20')
      const b = T6.parseEcccAlertResult(later, { place: caPlace }).alert
      assert(b.eventKey === a.eventKey, '同一天内的再次发布同键 → 不会重复响铃')
      assert(b.id !== a.id, '消息 id 含时刻 → "同一条消息重复到达"仍能去重')
    }

    // ---- 14. 判据分类 ----
    {
      const craft = (patch) => {
        const f = JSON.parse(JSON.stringify(ecccSample.features[2]))
        Object.assign(f.properties, patch)
        return T6.parseEcccAlertResult(f, { place: caPlace })
      }
      assert(craft({ risk_colour_en: 'purple' }).kind === 'schema', '颜色越界 → schema（颜色是 ECCC 的等级本体）')
      assert(craft({ risk_colour_en: undefined }).kind === 'schema', '缺颜色 → schema')
      assert(craft({ publication_datetime: '昨天' }).kind === 'schema', '发布时间不可解析 → schema')
      assert(craft({ alert_name_en: '' }).kind === 'schema', '缺英文名 → schema')
      assert(craft({ alert_type: 'advisory' }).kind === 'empty', 'advisory → empty')
    }

    // ---- 15. 契约：两条都登记，且关键字段与设计一致 ----
    {
      const C = T6.SOURCE_CONTRACTS
      assert(C.nws_alerts && C.eccc_alerts, '两条海外源的契约都已登记')
      assert(Object.keys(C).length === 10, '契约总数 10（原有 8 + 海外 2）：' + Object.keys(C).length)
      for (const id of ['nws_alerts', 'eccc_alerts']) {
        const c = C[id]
        assert(Array.isArray(c.required) && c.required.length > 0, id + ' 的 required 非空')
        assert(typeof c.tolerant === 'string' && c.tolerant.length > 20, id + ' 的 tolerant 写明了不判 schema 的范围')
        assert(typeof c.empty === 'string' && c.empty.length > 20, id + ' 的 empty 写明了什么形态算正常无数据')
        assert(c.staleAfterMs === null && typeof c.staleReason === 'string' && c.staleReason.length > 20,
          id + ' 的 staleAfterMs 是 null，且 staleReason 写清了为什么判不了停更')
        assert(c.transport === 'rest' && typeof c.pollMs === 'number', id + ' 是 REST 轮询且声明了周期')
      }
      assert(C.nws_alerts.region === 'us' && C.eccc_alerts.region === 'ca', '两条各自标了国别')
      assert(/自带偏移/.test(C.nws_alerts.timezone) && /UTC/.test(C.eccc_alerts.timezone),
        '时区一栏如实写了两源的相反形态（NWS 自带偏移 / ECCC 是 UTC）')
    }

    console.log('== 0.6.0 取数器：按关注点查询 ==')

    // ---- 16. 几何：采样点与 bbox ----
    {
      assert(T6.nwsSamplePoints({ lat: 29.7604, lon: -95.3698, radiusKm: 10 }).length === 1,
        '半径 < 25km 只查中心点（NWS 的县通常比它大，采样点会落进同一个县）')
      const pts = T6.nwsSamplePoints({ lat: 29.7604, lon: -95.3698, radiusKm: 100 })
      assert(pts.length === 5, '半径 ≥ 25km 时补 4 个方位采样点')
      assert(pts[0][0] === 29.7604 && pts[0][1] === -95.3698, '第一个是中心点')
      assert(pts.some((p) => p[0] > 29.76) && pts.some((p) => p[0] < 29.76) &&
        pts.some((p) => p[1] > -95.37) && pts.some((p) => p[1] < -95.37), '四个方位都覆盖到')
      const bbox = T6.ecccBboxOf({ lat: 45, lon: -75, radiusKm: 111 })
      const b = bbox.split(',').map(Number)
      assert(b.length === 4 && b[0] < -75 && b[2] > -75 && b[1] < 45 && b[3] > 45,
        'ECCC 的 bbox 由坐标与半径算出：' + bbox)
      assert((b[2] - b[0]) > (b[3] - b[1]),
        '经度跨度大于纬度跨度（45° 处 cos≈0.71，同样的公里数对应更多经度）')
      const hi = T6.ecccBboxOf({ lat: 70, lon: 0, radiusKm: 111 }).split(',').map(Number)
      assert((hi[2] - hi[0]) > (b[2] - b[0]), '纬度越高，同样的半径对应越宽的经度')
    }

    // ---- 17. 覆盖范围：只对"那个国家"的关注点发请求 ----
    {
      const US = { minLat: 24, maxLat: 50, minLon: -125, maxLon: -66 }
      const CA = { minLat: 41, maxLat: 84, minLon: -141, maxLon: -52 }
      const cfgAll = mkCfg([usPlace, caPlace, jpPlace])
      const inUs = T6.placesInBoxes(cfgAll, [US]).map((p) => p.name).join(',')
      assert(inUs === '休斯敦,多伦多',
        '美国盒选中两个北美点——多伦多也在盒内（美加边界不是矩形），由第 19 条的 400 兜底处理：' + inUs)
      assert(T6.placesInBoxes(cfgAll, [CA]).map((p) => p.name).join(',') === '多伦多', '加拿大盒只选中多伦多')
      assert(T6.placesInBoxes(cfgAll, [US, CA]).length === 2, '东京不在任何一个盒里 → 一个请求都不发')
    }

    // ---- 18. 取数器主链：查询 → 契约 → 交出 Alert（用真实 fixture，不联网） ----
    {
      const cfg = mkCfg([usPlace])
      const urls = []
      const handed = []
      let status = null
      const src = T6.createNwsSource({
        getCfg: () => cfg,
        onStatus: (p) => { status = p },
        onAlert: (a, c, o) => handed.push({ id: a.id, stale: !!(o && o.staleOnArrival) }),
        fetchText: async (url) => {
          urls.push(url)
          return JSON.stringify({ type: 'FeatureCollection', features: nwsSample.features })
        },
      })
      const r = await src.pollOnce()
      assert(urls.length === 5, '1 个关注点 + 100km 半径 = 5 个请求（中心 + 4 方位）')
      assert(urls[0].indexOf('point=29.7604,-95.3698') > 0, '第一个请求是中心点：' + urls[0].slice(0, 100))
      assert(urls[0].indexOf('event=') > 0 && urls[0].indexOf('Flood') > 0,
        'URL 带 event 白名单参数（服务端过滤，省掉占全量三分之二的海事通告）')
      assert(r.applied === 7 && handed.length === 7,
        'fixture 的 7 条各交出一次：5 个采样点返回同一批，靠 alert.id 在一轮内去重')
      assert(src.stats().received === 35, '收到计数按每份响应累计（7 × 5）：' + src.stats().received)
      assert(handed.every((h) => h.stale === false), '刚发布的条目不进门闸（fixture 都是当天的）')
      // detail **只放语义信息**（0.6.0 review 修正）：正常情况下它为空——计数由设置页的
      // OVERSEAS_STAT_ORDER 从 stats 直接读，这样 detail 变化才等于"语义变化"，
      // 上报去重键才敢把它算进去（否则每轮都会被判成变化、页面反复重渲）。
      assert(status && status.status === 'open' && /已按 1 个关注点查询/.test(status.detail || ''),
        '正常一轮的状态是 open，detail 是非单调的语义摘要（review B-1：留空会让悬停显示裸状态词 open）：' + JSON.stringify(status))
    }

    // ---- 19. 400 = "不在覆盖范围"，不是故障（实测多伦多 / 温哥华 / 伦敦都会被 NWS 这样答） ----
    {
      const cfg = mkCfg([caPlace])
      let calls = 0
      let status = null
      const src = T6.createNwsSource({
        getCfg: () => cfg,
        onStatus: (p) => { status = p },
        onAlert: () => {},
        fetchText: async () => {
          calls += 1
          const e = new Error('HTTP 400')
          e.status = 400
          throw e
        },
      })
      await src.pollOnce()
      assert(calls === 5, '第一轮按采样点各查一次（还不知道会被拒）')
      assert(src.stats().rejected === 5 && src.stats().errors === 0,
        '400 记成 rejected 而不是 errors（它是参数问题，不是链路故障）：' + JSON.stringify({ rejected: src.stats().rejected, errors: src.stats().errors }))
      assert(status && status.status === 'open',
        '状态是 open 而不是 unreachable——把它显示成红色会让多伦多用户以为插件坏了：' + JSON.stringify(status))
      await src.pollOnce()
      assert(calls === 5, '冷却期内不再查这些 URL（TTL 到期后会自动重试一次）')
    }

    // ---- 20. 门闸、开关、关注点与失败分类 ----
    {
      // 年龄闸门：首轮把"发布已 10 小时"的条目标记为 staleOnArrival
      const cfg = mkCfg([usPlace])
      const old = JSON.parse(JSON.stringify(nwsSample.features))
      const oldStamp = new Date(Date.now() - 10 * 3600 * 1000).toISOString()
      for (const f of old) { f.properties.sent = oldStamp; f.properties.id = f.properties.id + '.old' }
      const seen = []
      const mk = () => T6.createNwsSource({
        getCfg: () => cfg,
        onStatus: () => {},
        onAlert: (a, c, o) => seen.push(!!(o && o.staleOnArrival)),
        fetchText: async () => JSON.stringify({ type: 'FeatureCollection', features: old }),
      })
      const src1 = mk()
      await src1.pollOnce()
      assert(seen.length === 7 && seen.every(Boolean),
        '首轮：发布 10 小时的条目全部带 staleOnArrival（只进历史，不响铃）')
      const seen2 = []
      const src2 = T6.createNwsSource({
        getCfg: () => cfg,
        onStatus: () => {},
        onAlert: (a, c, o) => seen2.push(!!(o && o.staleOnArrival)),
        fetchText: async () => JSON.stringify({ type: 'FeatureCollection', features: old }),
      })
      await src2.pollOnce() // 第一轮：建立"刚刚成功过"
      seen2.length = 0
      await src2.pollOnce() // 第二轮：距上次成功很近 → 不再按首轮处理
      assert(seen2.length === 7 && seen2.every((v) => v === false),
        '距上次成功 30 分钟以内：同样的老数据不再进门闸（它是"刚查到的"，不是"刚打开的"）')

      // 开关关闭 → 一个请求都不发
      let callsOff = 0
      const offSrc = T6.createNwsSource({
        getCfg: () => mkCfg([usPlace], false),
        onStatus: () => {},
        onAlert: () => {},
        fetchText: async () => { callsOff += 1; return '{}' },
      })
      const offRes = await offSrc.pollOnce()
      assert(callsOff === 0 && offRes.disabled === true, '灾种开关关闭时不产生任何请求')

      // 没有这一国的关注点 → 也不发请求，但状态要说清怎么配（不静默）
      let callsNone = 0
      let stNone = null
      const noneSrc = T6.createNwsSource({
        getCfg: () => mkCfg([jpPlace]),
        onStatus: (p) => { stNone = p },
        onAlert: () => {},
        fetchText: async () => { callsNone += 1; return '{}' },
      })
      const noneRes = await noneSrc.pollOnce()
      assert(callsNone === 0 && noneRes.noPlaces === true, '只有日本关注点时，美国源一个请求都不发')
      assert(stNone && /未设置/.test(stNone.detail) && /其他地区/.test(stNone.detail),
        '状态里说明去哪里配关注点：' + (stNone && stNone.detail))

      // 失败分类：非 JSON / 缺 features / 响应过大 / HTTP 500
      const mkBad = (body, err) => T6.createNwsSource({
        getCfg: () => cfg,
        onStatus: () => {},
        onAlert: () => {},
        fetchText: async () => {
          if (err) { const e = new Error(err.message || 'boom'); e.status = err.status; throw e }
          return body
        },
      })
      const r1 = await mkBad('<html>拦截页</html>').pollOnce()
      assert(r1.failed === 5, '被拦截成 HTML → 每个请求都算失败（不是静默跳过）')
      const r2 = await mkBad('{"oops":1}').pollOnce()
      assert(r2.failed === 5, '缺 features 数组 → 失败（上游改版要看得见）')
      // 0.6.0 review A2：顶层结构不符 = **契约漂移**，要按 DESIGN 4.5 的配色语义点亮蓝点
      // （schema-error：用户处理不了、等插件更新），而不是红点（让用户去折腾自己的网络）。
      // 清掉前面几条"坏响应"留下的健康记录，避免它们把这里的状态预先染成 schema-error。
      T6.resetSourceHealth()
      let stSchema = null
      const badStruct = T6.createNwsSource({
        getCfg: () => cfg,
        onStatus: (p) => { stSchema = p },
        onAlert: () => {},
        fetchText: async () => '{"oops":1}',
      })
      await badStruct.pollOnce()
      await badStruct.pollOnce()
      assert(stSchema && stSchema.status === 'schema-error',
        '顶层结构不符 → schema-error（蓝点），而不是 unreachable（红点）：' + JSON.stringify(stSchema))
      const r3 = await mkBad('x'.repeat(600 * 1024)).pollOnce()
      assert(r3.failed === 5, '响应体超过上限 → 失败（在 JSON 解析之前就拦下，不会把几百 KB 塞进解析器）')
      // 5xx 同样是"环境问题"那一类（它是真的连不上），所以要先把上面的 schema 记录清掉
      T6.resetSourceHealth()
      let st500 = null
      const s500 = T6.createNwsSource({
        getCfg: () => cfg,
        onStatus: (p) => { st500 = p },
        onAlert: () => {},
        fetchText: async () => { const e = new Error('HTTP 500'); e.status = 500; throw e },
      })
      await s500.pollOnce()
      assert(st500 && st500.status === 'unreachable', '全部 5xx → unreachable（红色：环境问题）')
    }

    console.log('== 0.6.0 review：修掉的三条各配一条守卫 ==')

    // ---- 23. 请求上限不能吞掉关注点（review A1） ----
    {
      const many = Array.from({ length: 10 }, (_, i) => ({ name: 'p' + i, lat: 30 + i * 0.2, lon: -95, radiusKm: 100 }))
      const urls = []
      const src = T6.createNwsSource({
        getCfg: () => mkCfg(many),
        onStatus: () => {},
        onAlert: () => {},
        fetchText: async (url) => { urls.push(decodeURIComponent(url)); return '{"type":"FeatureCollection","features":[]}' },
      })
      await src.pollOnce()
      const lats = new Set(urls.map((u) => { const m = /point=([\d.-]+),/.exec(u); return m ? Number(m[1]) : null }).filter(Boolean))
      const missed = many.filter((p) => ![...lats].some((v) => Math.abs(v - p.lat) < 0.001))
      assert(missed.length === 0,
        '10 个关注点（50 个请求 > 上限 ' + T6.MAX_REQUESTS_PER_ROUND + '）时每个点仍被查一次——' +
        '上限只截采样点，绝不吞掉关注点；漏掉的是：' + missed.map((p) => p.name).join(','))
      assert(urls.length === T6.MAX_REQUESTS_PER_ROUND, '请求数仍守在上限内：' + urls.length)
      assert(src.stats().throttledLast === 10, '被截断的采样点如实计数（本轮 10 个）：' + src.stats().throttledLast)
      assert(src.stats().throttledTotal === 10, '累计值也记（诊断里看趋势）：' + src.stats().throttledTotal)
    }

    // ---- 24. 年龄闸门必须更新事件记忆（review A2） ----
    {
      const cfg = mkCfg([usPlace])
      const f = JSON.parse(JSON.stringify(nwsByEvent('Flood Warning')))
      f.properties.sent = new Date(Date.now() - 10 * 3600 * 1000).toISOString()
      f.properties.id = 'urn:oid:2.49.0.1.840.0.guard.001.1'
      // 清掉 references：否则事件键会指回 fixture 里那条原消息，而它在第 5b 条用例里已被
      // rememberAlerted 记过 —— 这条就会先被 looksReplayed 拦下（那说明机制是好的，但测不到本用例）
      delete f.properties.references
      const alert = T6.parseNwsAlertResult(f, { place: usPlace }).alert
      const r = T6.handleAlert(alert, cfg, { staleOnArrival: 10 })
      assert(r.reason === 'stale-on-arrival', '老预警走的是"只记历史"分支：' + r.reason)
      // isEventRepeat **自己会写记忆**，所以只能调用一次来验证 handleAlert 有没有写
      assert(T6.isEventRepeat(alert, 10) === true,
        '该分支排在 isEventRepeat 之后 → 事件记忆已写入，后续轮次会判成"后续发布"而不是再进一次历史')
    }

    // ---- 25. 状态去重键必须包含 detail（review A3） ----
    {
      // 前面的"坏响应"测试会往健康层里留下 schema 记录，而状态是经 effectiveStatusOf 合成的
      // ——不清掉的话这里拿到的是蓝点而不是本用例要验的 open（测试间的模块级状态污染）。
      T6.resetSourceHealth()
      const seen = []
      let places = []
      const src = T6.createNwsSource({
        getCfg: () => mkCfg(places),
        onStatus: (p) => {
          seen.push(p.status + '|' + (p.detail || ''))
          // 模拟 15-entry 的 feedStatus → publishStatus 写 store（12e 自己不写）
          T6.store.push({ sources: Object.assign({}, T6.store.sources, { nws_alerts: Object.assign({ label: p.label }, p) }) })
        },
        onAlert: () => {},
        fetchText: async () => '{"type":"FeatureCollection","features":[]}',
      })
      await src.pollOnce()
      places = [usPlace]
      await src.pollOnce()
      await src.pollOnce()
      assert(seen.length === 2, '状态推送 2 次（"未设置" → 空），第 3 次相同则不再推：' + JSON.stringify(seen))
      assert(/未设置/.test(seen[0]), '第一次说明去哪里配关注点：' + seen[0])
      assert(seen[1] === 'open|已按 1 个关注点查询',
        '第二次 detail 变成"已按 N 个关注点查询"——不会把"未设置"的旧文案一直挂在设置页上：' + seen[1])
    }

    // ---- 26. 400 只跳过那一个请求，不吞掉整个关注点（review B1） ----
    {
      T6.resetSourceHealth()
      const urls = []
      const hitPoint = 'point=29.7604,-95.3698'
      const src = T6.createNwsSource({
        getCfg: () => mkCfg([usPlace]),
        onStatus: () => {},
        onAlert: () => {},
        fetchText: async (url) => {
          urls.push(url)
          if (url.indexOf(hitPoint) > 0) { const e = new Error('HTTP 400'); e.status = 400; throw e }
          return '{"type":"FeatureCollection","features":[]}'
        },
      })
      await src.pollOnce()
      assert(src.stats().rejected === 1, '只有中心点被上游拒绝：' + src.stats().rejected)
      assert(urls.length === 5, '当轮其余 4 个方位点仍然照查：' + urls.length)
      await src.pollOnce()
      assert(urls.length === 9, '第二轮只跳过那 1 个 URL，仍查 4 个方位点（修复前整点被跳、第二轮 0 个请求）')
    }

    // ---- 27. 只有覆盖外坐标时，年龄闸门不该永远停在"首轮"（review B2） ----
    {
      T6.resetSourceHealth()
      const src = T6.createNwsSource({
        getCfg: () => mkCfg([caPlace]),
        onStatus: () => {},
        onAlert: () => {},
        fetchText: async () => { const e = new Error('HTTP 400'); e.status = 400; throw e },
      })
      await src.pollOnce()
      assert(src.stats().gated === 1, '第一轮算"首轮"')
      // 第二轮：这些 URL 已被记住，不再发请求 —— 门闸计数也不该再涨
      await src.pollOnce()
      assert(src.stats().gated === 1, '第二轮不再被当成首轮（400 也是"上游有响应"，修复前恒为首轮）')
    }

    // ---- 28. 外层 URL id 也要能归并版本（review B3） ----
    {
      const base = nwsByEvent('Flood Warning')
      const outer = {
        id: 'https://api.weather.gov/alerts/urn:oid:2.49.0.1.840.0.abc.001.1',
        type: 'Feature',
        geometry: base.geometry,
        properties: Object.assign({}, base.properties),
      }
      delete outer.properties.id
      delete outer.properties.references
      const a = T6.parseNwsAlertResult(outer, { place: usPlace }).alert
      assert(a.id === 'nws:urn:oid:2.49.0.1.840.0.abc.001.1',
        '外层 URL id 会抽出 urn:oid 段（否则事件键带 URL 前缀，版本归并与取消匹配都失效）：' + a.id)
      assert(a.eventKey === 'nws:urn:oid:2.49.0.1.840.0.abc.001',
        '事件键随之正确（同一链的 .2 版会算出同一个键）：' + a.eventKey)
    }

    // ---- 29. stop() 之后不再写状态、中止不算失败（review A-1） ----
    {
      T6.resetSourceHealth()
      const reports = []
      const src = T6.createNwsSource({
        getCfg: () => mkCfg([usPlace]),
        onStatus: (p) => reports.push(p.status + '|' + (p.detail || '')),
        onAlert: () => {},
        fetchText: async () => {
          await new Promise((resolve) => setTimeout(resolve, 30)) // 挂住，让 stop() 发生在途中
          const e = new Error('The user aborted a request.')
          e.name = 'AbortError'
          throw e
        },
      })
      const pending = src.pollOnce()
      await new Promise((resolve) => setTimeout(resolve, 5))
      src.stop()
      await pending
      assert(reports.length === 0,
        '停用之后不再上报任何状态（修复前会写一条 unreachable 红点，重载时还会把新会话短暂染红）：' + JSON.stringify(reports))
      assert(src.stats().errors === 0, '主动中止不算失败：' + src.stats().errors)
    }

    // ---- 30. 400 的冷却带 TTL、文案不替上游断言原因（review A-2） ----
    {
      assert(typeof T6.UNCOVERED_TTL_MS === 'number' && T6.UNCOVERED_TTL_MS > 0,
        '冷却期是有限值（不是永久拉黑）：' + T6.UNCOVERED_TTL_MS + 'ms')
      T6.resetSourceHealth()
      let status = null
      const src = T6.createNwsSource({
        getCfg: () => mkCfg([usPlace]),
        onStatus: (p) => { status = p },
        onAlert: () => {},
        fetchText: async () => { const e = new Error('HTTP 400'); e.status = 400; e.bodyHint = '{"title":"Invalid Parameter"}'; throw e },
      })
      await src.pollOnce()
      assert(status && !/不在\s*NWS\s*的覆盖范围/.test(status.detail || ''),
        '文案只说"被上游拒绝（HTTP 400）"，不断言"这个点不在覆盖范围"（我们无法证实那是唯一原因）：' + JSON.stringify(status))
      assert(/HTTP 400/.test(status.detail || ''), '但仍然写明是 400 与多久后重试：' + status.detail)
    }

    // ---- 31. 海外预警不清掉日本气象 L3 提示（review A-3，0.5.4 修过 nmc 的同一处） ----
    {
      const cfg = mkCfg([usPlace])
      T6.store.push({ weatherHint: { level: 3, label: 'テスト県', at: Date.now() } })
      const alert = T6.parseNwsAlertResult(nwsByEvent('Flood Warning'), { place: usPlace }).alert
      T6.handleAlert(alert, cfg)
      assert(T6.store.weatherHint && T6.store.weatherHint.level === 3,
        '海外预警（regions 恒空）不再抹掉日本电文留下的「L3 未达 L4」提示：' + JSON.stringify(T6.store.weatherHint))
      T6.store.push({ weatherHint: null })
    }

    // ---- 32. 采样点按轮次轮转，尾部关注点也能轮到（review B-2） ----
    {
      const many = Array.from({ length: 10 }, (_, i) => ({ name: 'p' + i, lat: 30 + i * 0.2, lon: -95, radiusKm: 100 }))
      const urls = []
      const src = T6.createNwsSource({
        getCfg: () => mkCfg(many),
        onStatus: () => {},
        onAlert: () => {},
        fetchText: async (url) => { urls.push(decodeURIComponent(url)); return '{"type":"FeatureCollection","features":[]}' },
      })
      const countPerPlace = (from, to) => {
        const m = {}
        for (let i = from; i < to && i < urls.length; i += 1) {
          const mm = /point=([\d.-]+),/.exec(urls[i])
          if (!mm) continue
          const lat = Number(mm[1])
          const idx = many.findIndex((p) => Math.abs(p.lat - lat) < 0.001)
          if (idx >= 0) m['p' + idx] = (m['p' + idx] || 0) + 1
        }
        return m
      }
      await src.pollOnce()
      await src.pollOnce()
      const ptsOf = (from, to) => urls.slice(from, to)
        .map((u) => { const m = /point=([\d.,-]+)/.exec(u); return m ? m[1] : '' })
        .filter(Boolean)
      const first = ptsOf(0, 40)
      const second = ptsOf(40, 80)
      // 每轮的前 10 个请求是各关注点的**中心点**（无条件优先），差异应出现在采样点部分
      assert(first.slice(0, 10).join(' ') === second.slice(0, 10).join(' '),
        '两轮的中心点集合相同（每个关注点每轮必被查一次）')
      assert(first[10] !== second[10],
        '第一个采样点在两轮里属于不同的关注点（' + first[10] + ' → ' + second[10] + '）' +
        '——这就是轮转：固定顺序会让同一批关注点永远拿满采样、尾部永远只有中心点')
      assert(first.length === 40 && second.length === 40, '两轮都守在上限 40 内：' + first.length + '/' + second.length)
    }

    // ---- 33. 整轮失败会退避（review B-5：DESIGN 4.7.2 承诺过，此前实现里没有） ----
    {
      let calls = 0
      const src = T6.createNwsSource({
        getCfg: () => mkCfg([usPlace]),
        intervalMs: 5, // 正常间隔压到 5ms：有退避时不会按这个节奏继续打
        firstDelayMs: 1,
        onStatus: () => {},
        onAlert: () => {},
        fetchText: async () => { calls += 1; const e = new Error('HTTP 500'); e.status = 500; throw e },
      })
      src.start()
      await new Promise((resolve) => setTimeout(resolve, 150))
      src.stop()
      // 无退避时：每 5ms 一轮 × 5 个请求 = 上百次；有退避（1 秒起）时 150ms 内只有第一轮
      assert(calls <= 20, '全部失败后进入退避，150ms 内只跑了 ' + calls + ' 个请求（无退避会是上百次）')
      assert(T6.OVERSEAS_MIN_BACKOFF_MS === 1000 && T6.OVERSEAS_MAX_BACKOFF_MS === 60000,
        '退避是 1s → 60s 上限（与 DESIGN 4.7.2 一致）')
    }

    console.log('== 0.6.0 匹配：查询即匹配 ==')
    // ---- 21. matchOverseasAlert 的四条判定 ----
    {
      const alert = T6.parseNwsAlertResult(nwsByEvent('Flood Warning'), { place: usPlace }).alert
      const cfg = mkCfg([usPlace])
      const m = T6.matchOverseasAlert(alert, cfg)
      assert(m.hit === true, '命中所属关注点（不算距离——命中在取数时就已发生）')
      assert(m.place && m.place.name === '休斯敦', '返回命中的关注点，供 UI 显示')
      assert(/命中关注点/.test(m.reason), '理由写清了命中哪个点：' + m.reason)
      const noWatch = T6.matchOverseasAlert(alert, mkCfg([]))
      assert(noWatch.hit === false && noWatch.noWatch === true, '没有海外关注点 → noWatch（不静默）')
      assert(T6.matchOverseasAlert(alert, mkCfg([usPlace], false)).hit === false, '灾种开关关闭 → 不提醒')
      const watch = T6.parseNwsAlertResult(nwsByEvent('Flood Watch'), { place: usPlace }).alert
      const wm = T6.matchOverseasAlert(watch, cfg)
      assert(wm.hit === false && /未达播报档位/.test(wm.reason),
        'Watch 档位不到线 → 不打扰，但理由说清了（并仍进历史）')
      const gone = T6.parseNwsAlertResult(nwsByEvent('Flood Warning'),
        { place: { name: '已删掉的点', lat: 1, lon: 1, radiusKm: 100 } }).alert
      assert(T6.matchOverseasAlert(gone, cfg).hit === false, '来源关注点已被删除 → 不命中')
      const orphan = JSON.parse(JSON.stringify(alert))
      orphan.originPlace = null
      assert(T6.matchOverseasAlert(orphan, cfg).hit === false, '没有来源关注点 → 不猜，判不命中')
    }

    // ---- 22. 开关四处同步（Client 默认值 / normalizeCfg / Host schema / 设置页） ----
    {
      assert(T6.DEFAULT_CFG.disasters.overseasWeather === true, 'Client 默认值是开')
      const norm = T6.normalizeCfg({ disasters: { overseasWeather: false } })
      assert(norm.disasters.overseasWeather === false, 'normalizeCfg 认这个字段（漏掉会被静默丢弃）')
      const norm2 = T6.normalizeCfg({ disasters: { overseasWeather: 'yes please' } })
      assert(norm2.disasters.overseasWeather === true, '类型不对时退回默认值')
      const hostMod = await import(pathToFileURL(path.join(ROOT, 'lib', 'index.js')).href)
      const hostParsed = hostMod.QuakeAlertSettingsSchema({ disasters: { overseasWeather: false } })
      assert(hostParsed.disasters.overseasWeather === false,
        'Host schema 认这个开关（四处同步里的第三处；默认值一致由前面那条 JSON 全等断言守着）')
    }
  } catch (e) {
    assert(false, '0.6.0 第 2 期检查失败：' + e.message + '\n' + (e && e.stack ? e.stack.split('\n').slice(1, 3).join('\n') : ''))
  }

  console.log('\n结果: ' + pass + ' 通过, ' + fail + ' 失败')
  process.exit(fail === 0 ? 0 : 1)
})()
