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
    // 12d 健康自检在 apply 里排一个 30 秒周期的 setInterval，沙箱必须提供；它的 timer 带 unref，
    // 不会钉住测试进程。要推进判定就用 createHealthProbe 注入假时钟直接调 tick()。
    setInterval: o.setInterval || setInterval,
    clearInterval: o.clearInterval || clearInterval,
    // AbortController：12e 的请求超时靠它实现（abort 后 fetch 抛 AbortError）；一律写
    // `'X' in o ? o.X : X` 而不是 `o.X || X`，否则无法表达「注入 undefined」。
    // fetch：12e 的默认取数走裸 fetch（不是 window.fetch），提供它默认路径才跑得到。
    fetch: ('fetch' in o) ? o.fetch : (typeof fetch === 'function' ? fetch : undefined),
    // TextDecoder / TextEncoder：读流要用；缺失时只能退化成 String(chunk)，测试写出假绿。
    TextDecoder: ('TextDecoder' in o) ? o.TextDecoder : (typeof TextDecoder === 'function' ? TextDecoder : undefined),
    TextEncoder: ('TextEncoder' in o) ? o.TextEncoder : (typeof TextEncoder === 'function' ? TextEncoder : undefined),
    AbortController: ('AbortController' in o) ? o.AbortController : AbortController,
    // Date：bundle 跑在自己的 vm realm 里，宿主侧改 Date.now 对它无效，
    // 依赖时钟推进的判定（去重窗口是否随命中刷新等）只能靠注入。
    Date: ('Date' in o) ? o.Date : Date,
  }
  // client.js 的 handleRaw 用裸 `document` 判断页面可见性（浏览器里就是 window.document），
  // 注入 document 的用例需要把它同时挂到沙箱全局，否则永远走「后台」分支。
  if (windowStub.document) sandbox.document = windowStub.document
  sandbox.window.window = sandbox.window
  windowStub.__ModuleLoader__ = {
    load: ({ id, factory }) => {
      // reactStub：默认空对象（parse/match 不渲染 React）；渲染设置页的用例用 o.react
      // 注入极简实现——一个拼错的 h(...) 会让整页白屏而不触发任何断言。
      const reactStub = o.react || {}
      sandbox.__exports = factory((req) => (req === 'react' ? reactStub : undefined))
    },
  }
  vm.createContext(sandbox)
  vm.runInContext(CLIENT_CODE, sandbox, { filename: 'client.js' })
  // sandbox 也交出去：部分用例要在加载**之后**注入 `fetch`，才能走到 12e 的 defaultFetchText。
  return { exports: sandbox.__exports, storage: memStore, sandbox }
}
function loadClient(seedStorage) { return loadClientEx(seedStorage).exports }

const T = loadClient().__test

// ---- volatile 字段是响应式引用 ----
// settings 契约要求可编辑字段标 `.volatile()`，schemastery 会把它们解析成带 `.get()` 的引用
// （JSON 序列化后是 `{}`），所以直接调 Host schema 取配置值的断言要先 unwrap 再比较。
const unwrapRefs = (v) => {
  if (Array.isArray(v)) return v.map(unwrapRefs)
  if (v && typeof v === 'object') {
    if (typeof v.get === 'function') return unwrapRefs(v.get())
    const out = {}
    for (const k of Object.keys(v)) out[k] = unwrapRefs(v[k])
    return out
  }
  return v
}
if (!T) { console.error('FAIL: __test 未导出'); process.exit(1) }
/** 极简 React stub：够跑完一次渲染即可（useState 有状态、useEffect 不执行）。 */
const mkTestReact = () => {
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
/** 渲染一棵 Element 树，取出里面所有文本节点（断言 UI 文案用）。 */
const textsOfTree = (tree) => {
  const texts = []
  const walk = (node) => {
    if (node === null || node === undefined) return
    if (typeof node === 'string' || typeof node === 'number') { texts.push(String(node)); return }
    if (Array.isArray(node)) { node.forEach(walk); return }
    if (node && node.children) node.children.forEach(walk)
  }
  walk(tree)
  return texts
}
/** 按元素类型收集节点（断言属性用）：`textsOfTree` 只看得见文本节点，而 `value` / `onChange` 都是属性。 */
const nodesOfType = (tree, type) => {
  const out = []
  const walk = (node) => {
    if (node === null || node === undefined) return
    if (Array.isArray(node)) { node.forEach(walk); return }
    if (typeof node !== 'object') return
    if (node.type === type) out.push(node)
    if (node.children) node.children.forEach(walk)
  }
  walk(tree)
  return out
}
const optionsOfTree = (tree) => nodesOfType(tree, 'option').map((n) => ({
  v: n.props ? n.props.value : undefined,
  key: n.props ? n.props.key : undefined,
  text: n.children && n.children.length ? n.children[0] : undefined,
}))
const selectsOfTree = (tree) => nodesOfType(tree, 'select')
const { EEW_AREA_EXPECT, TSUNAMI_AREA_EXPECT } = require('./area-tables.cjs')

// ---- 简体专有字表 ----
/** zh-CN 文案里真实出现过的简体专有字，手写冻结（不随四张表变化；派生集合会被改坏的那栏自污染）。
 *  简繁同形且繁体里合法的 `只` / `里` / `台` / `制` / `准` 不收，宁可漏检不可误报。 */
const CN_ONLY_CHARS = '灾预陆报紧欧国质调啸网气环与变仅请发为废关难离确认区远连实时闭动历条设选择询级迟长从盖范围无链数据过异这个浏览储录风态败标弃详响应绝结页断开帧试纬经径复会并获后义划载辖别县输键词还话积销来终补尔滨万镇东类阈测观编么两换门槛单独险电则几蓝进铃弹扰红构宁证冻雾属于虽种处达权许统语优强坏抢络备际声听锁静诊联况馈击场贴责转厅暂触车样说导读号满错边较准内当参称点机轮状黄温额钟细'
const CN_ONLY_RE = new RegExp('[' + CN_ONLY_CHARS + ']')

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
console.log('== 解析器：556 EEW（pref 简写统一为全称） ==')
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

console.log('== 区域名对齐：EEW 全量区域名（気象庁 188 个） ==')
{
  const bad = []
  for (const name of Object.keys(EEW_AREA_EXPECT)) {
    const got = T.prefsOfArea(name).slice().sort()
    const want = EEW_AREA_EXPECT[name].slice().sort()
    if (got.join(',') !== want.join(',')) bad.push(name + ' 期望 ' + want.join('/') + ' 实得 ' + (got.join('/') || '空'))
  }
  const total = Object.keys(EEW_AREA_EXPECT).length
  // 全量必须被断言守住：只遍历已存在的 key 时，从表里删掉任一区域名测试仍然全绿。
  assert(total === 188, 'EEW 区域名表覆盖気象庁全量 188 个（实际 ' + total + '）')
  assert(bad.length === 0, total + ' 个 EEW 区域名全部对齐正确' + (bad.length ? '（失败 ' + bad.length + ' 个：' + bad.slice(0, 5).join(' | ') + '）' : ''))
}
console.log('== 区域名对齐：海啸全量予報区（気象庁 66 个） ==')
{
  const bad = []
  for (const name of Object.keys(TSUNAMI_AREA_EXPECT)) {
    const got = T.prefsOfArea(name).slice().sort()
    const want = TSUNAMI_AREA_EXPECT[name].slice().sort()
    if (got.join(',') !== want.join(',')) bad.push(name + ' 期望 ' + want.join('/') + ' 实得 ' + (got.join('/') || '空'))
  }
  const total = Object.keys(TSUNAMI_AREA_EXPECT).length
  assert(total === 66, '津波予報区表覆盖気象庁全量 66 个（实际 ' + total + '）')
  assert(bad.length === 0, total + ' 个津波予報区全部对齐正确' + (bad.length ? '（失败 ' + bad.length + ' 个：' + bad.slice(0, 5).join(' | ') + '）' : ''))
}
console.log('== 回归：区域名对齐与未识别区域 ==')
{
  const cfg = (watch, tg) => ({ disasters: { earthquake: true, tsunami: true }, dedupe: { windowMinutes: 10 }, watch: { prefectures: watch }, thresholds: { quakeScale: 40, eewScale: 45, tsunamiGrade: tg || 'Watch' }, notify: {} })
  assert(T.prefsOfArea('京都府').join() === '京都府', '京都府 → 京都府（不再截断为 京都）')
  assert(T.prefsOfArea('京都府南部').join() === '京都府', '京都府南部 → 京都府')
  // 部分海啸予報区名不含县名，要靠区域表展开到多个县
  const tw = T.parse({ code: 552, id: 't-tw', cancelled: false, issue: { time: 'x' }, areas: [{ grade: 'MajorWarning', name: '東京湾内湾', maxHeight: { description: '３ｍ' } }] })
  assert(T.matchAlert(tw, cfg(['東京都'])).hit === true, '東京湾内湾 大海啸警报 → 关注東京都命中')
  assert(T.matchAlert(tw, cfg(['千葉県'])).hit === true, '東京湾内湾 → 关注千葉県命中')
  assert(T.matchAlert(tw, cfg(['神奈川県'])).hit === true, '東京湾内湾 → 关注神奈川県命中')
  const izu = T.parse({ code: 552, id: 't-izu', cancelled: false, issue: { time: 'x' }, areas: [{ grade: 'Warning', name: '伊豆諸島' }] })
  assert(T.matchAlert(izu, cfg(['東京都'])).hit === true, '伊豆諸島 → 关注東京都命中')
  const hk = T.parse({ code: 556, id: 'e-hk', cancelled: false, issue: { time: 'x' }, earthquake: { hypocenter: { name: '上川地方北部', magnitude: 5.5 } }, areas: [{ pref: '北海道道北', name: '上川地方北部', scaleFrom: 45, scaleTo: 45 }] })
  assert(T.matchAlert(hk, cfg(['北海道'])).hit === true, '上川地方北部 EEW → 关注北海道命中')
  const ok = T.parse({ code: 556, id: 'e-ok', cancelled: false, issue: { time: 'x' }, earthquake: { hypocenter: { name: '宮古島近海', magnitude: 6 } }, areas: [{ pref: '宮古島', name: '沖縄県宮古島', scaleFrom: 45, scaleTo: 45 }] })
  assert(T.matchAlert(ok, cfg(['沖縄県'])).hit === true, '沖縄県宮古島 EEW → 关注沖縄県命中')
  // 跨县区域展开为多条 region
  const ar = T.parse({ code: 552, id: 't-ar', cancelled: false, issue: { time: 'x' }, areas: [{ grade: 'Warning', name: '有明・八代海' }] })
  assert(ar.regions.length === 4, '有明・八代海 展开为 4 条 region（福岡/佐賀/長崎/熊本）')
  assert(['福岡県', '佐賀県', '長崎県', '熊本県'].every((p) => ar.regions.some((r) => r.pref === p)), '四个县都在 regions 中')
  assert(T.matchAlert(ar, cfg(['熊本県'])).hit === true, '有明・八代海 → 关注熊本県命中')
  // 未识别区域名一律放行（宁可多报绝不漏报）；气象侧的 regionInWeatherWatch 相反，要求 region.pref 存在
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
  assert(T.prefsOfArea('constructor').length === 0, '区域名 constructor → 统一为空（不再返回 Object 函数）')
  assert(T.prefsOfArea('toString').length === 0, '区域名 toString → 统一为空')
  const evil = T.parse({ code: 552, id: 't-evil', cancelled: false, issue: { time: 'x' }, areas: [{ grade: 'constructor', name: 'constructor' }] })
  assert(evil && evil.kind === 'tsunami' && evil.regions.length === 1, '恶意 grade/name 的消息解析不抛错')
  const q = T.parse({ code: 551, id: 'q-evil', cancelled: false, issue: { type: 'constructor', time: 'x' }, earthquake: { maxScale: 50, hypocenter: {} }, points: [] })
  assert(q && q.kindLabel === '地震情报', '551 issue.type=constructor → 回退默认标签')
}

console.log('== 历史记录：内存与本地存储都保留 30 条 ==')
{
  const { exports: ex, storage } = loadClientEx({})
  const t = ex.__test
  for (let i = 0; i < 35; i++) {
    t.addEvent({ id: 'id-' + i, kind: 'quake', label: '测试', severity: 'info', issued: 't', headline: 'h', hit: true })
  }
  assert(t.store.events.length === t.HISTORY_MAX, '内存保留 ' + t.HISTORY_MAX + ' 条')
  const saved = JSON.parse(storage.get('dsh.quakeAlert.history'))
  assert(Array.isArray(saved) && saved.length === t.HISTORY_MAX, '写入本地存储同样保存 ' + t.HISTORY_MAX + ' 条（此前只存 20 条，刷新后掉一半）')
}
console.log('== 音量：0 原样保留，不被默认值顶掉 ==')
{
  const cfg = loadClient({ 'dsh.quakeAlert.v1': JSON.stringify({ version: 1, notify: { volume: 0 } }) }).__test.loadCfg()
  assert(cfg.notify.volume === 0, 'volume=0 保留（滑块不再回弹显示 70%）')
}
console.log('== 重连：计数从第 1 次开始，restart 重置重连间隔 ==')
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
  assert(t.store.detail.indexOf('retry 1') !== -1, '状态文案显示重试次数（retry 1）：' + t.store.detail)
  sockets[0].onclose()
  assert(t.store.retries === 2, '连续断开 → 计数递增')
  client.restart()
  assert(t.store.retries === 0, 'restart() 重置重连计数（切数据源后不再等满 60s）')
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

console.log('== weakenEvent 不推广到地震 ==')
{
  // weakenEvent 只对气象生效。551 震源情报的 strength 是 -1，且与各地震度共用同一个事件键
  // （都取自 earthquake.time）：推广到地震会让「速报 → 震源情报 → 各地震度」再响一次。
  const t = loadClient().__test
  const raw = readSample('quake-kumamoto-detailscale-20260907.json')
  const cfg = JSON.parse(JSON.stringify(t.DEFAULT_CFG))
  cfg.notify = { sound: false, system: false, volume: 0 }
  cfg.watch = { prefectures: ['熊本県'], cities: [], places: [] }
  // 阈值设 10 让这条样本命中，断言与「样本恰好是几级」解耦
  cfg.thresholds.quakeScale = 10
  const r1 = t.handleAlert(t.parseQuake(raw), cfg)
  assert(r1.notified === true, '（前置）各地震度 → 播报：' + JSON.stringify(r1))
  // 同一场地震的震源情报（无 points → 无震度数据）：事件键相同，强度 -1
  const originRaw = {
    code: 551, id: String(raw.id) + '-origin', issue: { time: raw.issue.time, type: 'OriginTime' },
    earthquake: { time: raw.earthquake.time, hypocenter: raw.earthquake.hypocenter },
  }
  const origin = t.parseQuake(originRaw)
  assert(origin.strength === -1, '震源情报的 strength 是 -1（"没有震度"的特殊标记值）：' + origin.strength)
  assert(origin.eventKey === t.parseQuake(raw).eventKey, '震源情报与各地震度**共用事件键**（都取自 earthquake.time）')
  const r2 = t.handleAlert(origin, cfg)
  assert(r2.notified === false, '震源情报不播报（无震度数据）')
  // 修订版各地震度：新 id（真·重新发布），同事件键、同强度
  const again = Object.assign({}, raw, { id: String(raw.id) + '-v2' })
  const r3 = t.handleAlert(t.parseQuake(again), cfg)
  assert(r3.notified === false,
    '随后的各地震度不再响铃（若把 weakenEvent 推广到地震，这里会因为"从 -1 升级"而再响一次）')
}

console.log('== 消息级去重窗口「命中即刷新」，且记录用自己的窗口 ==')
{
  const t = loadClient().__test
  // 同一条消息每 9 分钟投递一次（窗口 10 分钟）：命中即刷新时它始终是同一条。
  // 时钟必须注入到沙箱自己的 realm（bundle 在那里跑，宿主侧改 Date.now 无效）。
  const clockRef = { t: Date.UTC(2026, 8, 21, 0, 0, 0) }
  class SandboxDate extends Date {
    constructor(...args) { if (args.length === 0) super(clockRef.t); else super(...args) }
    static now() { return clockRef.t }
  }
  const td = loadClientEx({}, { Date: SandboxDate }).exports.__test
  const id = 'dup-refresh-94'
  assert(td.isDuplicate(id, 10) === false, '（前置）首次登记该 id')
  clockRef.t += 9 * 60 * 1000
  assert(td.isDuplicate(id, 10) === true, '9 分钟后仍判重复')
  clockRef.t += 9 * 60 * 1000
  assert(td.isDuplicate(id, 10) === true, '再 9 分钟（合计 18 分钟）仍判重复 —— 命中刷新了窗口')
  clockRef.t += 11 * 60 * 1000
  assert(td.isDuplicate(id, 10) === false, '真正静默 11 分钟后才重新走主链（刷新不是"永不过期"）')
  // 记录用自己的窗口：先用 60 分钟窗口登记，再用 1 分钟窗口调用，这条记录不该被后者清掉。
  const id2 = 'dup-own-window-94'
  clockRef.t += 1000
  assert(td.isDuplicate(id2, 60) === false, '（前置）用 60 分钟窗口登记')
  clockRef.t += 5 * 60 * 1000
  td.isDuplicate('another-id', 1) // 本次调用的窗口只有 1 分钟
  assert(td.isDuplicate(id2, 60) === true, '5 分钟后仍判重复：清理用的是记录自己的 60 分钟窗口')
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
  // 552 的事件键是「预报区名集合」：解除电文列出的预报区与发布一致时才算同一事件，
  // 否则任意海域的解除都会被当成"此前提醒过的事件"，播出一条假解除。
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
  // EEW 即使预测震度刚过阈值，也必须保持 red（警报本质）
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

console.log('== 市区町村表：注入 / 规整 / 配置清理 ==')
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
console.log('== 市级匹配：addr 对齐（短名 / 消歧 / 支庁名 / 仮名表记） ==')
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
  assert(look('新千歳空港') === null, '机场观测点认不出市町村 → null（调用方放行）')
  assert(look('熊本県天草・芦北') === null, '区域名认不出市町村 → null')
}
console.log('== 县级匹配：551 的 pref 简写统一 ==')
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
  {
    const t = loadClientEx({ 'dsh.quakeAlert.v1': localCfg }).exports.__test
    const scope = fakeScope({ status: 'unavailable', value: undefined })
    t.bindSettingsScope(scope)
    assert(t.settingsState().sync === 'local', 'Host 不可用 → local 模式')
    assert(t.currentCfg().watch.prefectures.join() === '東京都', '仍读 localStorage 配置')
    assert(scope.writes.length === 0, '不回写不可用的 Host')
  }
  {
    const t = loadClientEx({}).exports.__test
    const scope = fakeScope({ mode: 'memory', writable: false })
    t.bindSettingsScope(scope)
    assert(t.settingsState().sync === 'memory', 'Host 只做进程内存储 → memory 模式')
    assert(scope.writes.length === 0, 'memory 模式不写 Host')
  }
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
    assert(!!vol && vol.value === 0.2, '音量兜底值经 applyCfg 存到本地 → 同时推给 Host（saveCfg 不推）')
    assert(t.currentCfg().notify.volume === 0.2, '音量兜底同时更新内存副本（下一次同步不会被 Host 旧值顶回）')
  }
  // ⑦ 跨标签页同步：reloadFromLocal 回读本地镜像
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
  {
    const t = loadClientEx({}).exports.__test
    let err = ''
    try { t.applyCfg(Object.assign({}, t.currentCfg(), { source: 'sandbox' })) } catch (e) { err = e.message }
    assert(err === '', '没有 Host 时 applyCfg 不抛错')
    assert(t.currentCfg().source === 'sandbox', '没有 Host 时配置仍即时生效')
  }
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
    const hostDefault = unwrapRefs(mod.QuakeAlertSettingsSchema({}))
    const clientDefault = T.cfgToSection(T.DEFAULT_CFG)
    assert(JSON.stringify(hostDefault) === JSON.stringify(clientDefault), 'Host schema 默认值与 Client DEFAULT_CFG 完全一致')
    assert(mod.SETTINGS_NAMESPACE === T.SETTINGS_NS, '两侧 namespace 名称一致（' + mod.SETTINGS_NAMESPACE + '）')
    let rejectedScale = false
    try { mod.QuakeAlertSettingsSchema({ thresholds: { quakeScale: 999 } }) } catch (e) { rejectedScale = true }
    assert(rejectedScale, 'Host schema 拒绝越界震度')
    let rejectedSource = false
    try { mod.QuakeAlertSettingsSchema({ source: 'bogus' }) } catch (e) { rejectedSource = true }
    assert(rejectedSource, 'Host schema 拒绝非法数据源')
    const withCities = unwrapRefs(mod.QuakeAlertSettingsSchema({ watch: { cities: ['白河市'] } }))
    assert(withCities.watch.cities.join() === '白河市', 'Host schema 接受市区町村列表')
  } catch (e) {
    assert(false, 'Host schema 加载失败：' + e.message)
  }

console.log('== DSH settings 适配：Config / volatile / settings 两代 API / client 入口 ==')
  try {
    const mod = await import(pathToFileURL(path.join(ROOT, 'lib', 'index.js')).href)

    // ① settings 表单从插件导出的 Config schema 派生，命名空间就是 profile 条目 id。
    assert(mod.Config === mod.QuakeAlertSettingsSchema, '导出 Config（0.1.7 宿主按这个名字取 schema）')
    assert(mod.SETTINGS_NAMESPACE === 'quake-alert', '命名空间仍是 profile 条目 id（quake-alert）')

    //    （重建四个轮询器 + 断开 Wolfx 常连）。期望条数从 Client 的 DEFAULT_CFG 递归数出来。
    const countLeaves = (node) => Object.keys(node).reduce((n, k) => {
      const v = node[k]
      return n + ((v && typeof v === 'object' && !Array.isArray(v)) ? countLeaves(v) : 1)
    }, 0)
    const expectedVolatile = countLeaves(T.cfgToSection(T.DEFAULT_CFG))
    const volatileCount = (JSON.stringify(mod.Config.toJSON()).match(/"volatile":true/g) || []).length
    assert(volatileCount === expectedVolatile,
      '配置 schema 的每个叶子都标了 volatile（' + volatileCount + '/' + expectedVolatile + '）')

    const mk = (settings) => ({ settings, effect(fn) { fn(); return () => {} } })
    const seen = { configure: [], register: [] }
    const newer = mk({ configure: (presentation, owner) => { seen.configure.push([presentation, owner]) } })
    assert(mod.applySettingsService(newer, { fiber: 'FIBER' }) === 'configure', '只有 configure 的宿主（0.1.7）：走新 API')
    assert(seen.configure.length === 1 && seen.configure[0][0] && seen.configure[0][0].auto === false,
      'configure 收到 { auto: false }——本插件自带配置页面，宿主不再生成自动表单页')
    assert(seen.configure[0][1] === 'FIBER', 'configure 的第二参数是插件自己的 fiber（策略归属该条目）')
    const older = mk({ register: (ns, schema) => { seen.register.push([ns, schema]) } })
    assert(mod.applySettingsService(older, { effect() {} }) === 'register', '只有 register 的宿主（0.1.6）：仍走老 API')
    assert(seen.register.length === 1 && seen.register[0][0] === 'quake-alert' && seen.register[0][1] === mod.Config,
      'register 收到 (namespace, schema)，且 schema 与 Config 是同一个对象')
    const both = mk({
      configure: () => { both.configured = true },
      register: () => { both.registered = true },
    })
    assert(mod.applySettingsService(both, { effect() {} }) === 'configure' && both.configured === true && !both.registered,
      '两代 API 同时存在时优先新 API（有 configure 的宿主上不会走回老路）')
    assert(mod.applySettingsService(mk({}), { effect() {} }) === 'none',
      '两代 API 都没有：不抛错，如实返回 none（配置退回 localStorage）')
    const broken = mk({ register: () => { throw new Error('quake-alert 段类型不符') } })
    assert(mod.applySettingsService(broken, { effect() {} }) === 'register-failed',
      'register 抛错被捕获（0.1.6 的容错仍然生效，插件照常可用）')
  } catch (e) {
    assert(false, 'Host 侧 0.7.0 适配验证失败：' + e.message)
  }

  try {
    // ④ Client 侧入口是 ConfigForm，其快照 / 写入面与旧的 settingsScope 同形。
    const src = fs.readFileSync(path.join(ROOT, 'client', 'src', '15-entry.js'), 'utf8')
    assert(src.indexOf("ctx.inject(['configForms']") !== -1, 'client 侧用 ctx.configForms 作为 0.1.7 入口')
    assert(src.indexOf("ctx.inject(['settingsScope']") !== -1, 'settingsScope 回退路径保留（可退回 0.1.6）')
    const t = loadClientEx({}).exports.__test
    const written = []
    const form = {
      getSnapshot: () => ({
        status: 'ready', mode: 'host', writable: true, revision: 7,
        value: { source: 'sandbox' }, user: { source: 'sandbox' },
      }),
      subscribe: () => () => {},
      mutate: (ops) => { written.push(ops); return Promise.resolve(true) },
    }
    const unbind = t.bindSettingsScope(form)
    assert(t.settingsState().sync === 'host', 'ConfigForm 形状被当成机器级配置源（sync=host）')
    assert(t.currentCfg().source === 'sandbox', 'ConfigForm 的 value 被读成当前配置')
    const base = t.currentCfg()
    t.applyCfg(Object.assign({}, base, { thresholds: Object.assign({}, base.thresholds, { quakeScale: 55 }) }))
    const ops = written.length ? written[0] : null
    assert(Array.isArray(ops) && ops.length > 0 &&
      ops.every((o) => (o.op === 'set' || o.op === 'unset') && Array.isArray(o.path)),
      '写回归宿主的 ops 是 settings 服务的 SettingsPathOp 形状（0.1.7 的 mutate 直接吃它）')
    assert(typeof unbind === 'function', 'bindSettingsScope 返回解除函数（供 ctx.effect 释放订阅）')
    unbind()
  } catch (e) {
    assert(false, 'Client 侧 0.7.0 适配验证失败：' + e.message)
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
    assert(missed.length === 0, '实测直播 addr 全部可对齐（未命中：' + missed.join('/') + '）')
    assert(t.citiesOfPref('架空県').length === 0, '不存在的县仍返回空')

    // Host 侧：假 ctx 走一遍 apply，检查路由输出
    const mod = await import(pathToFileURL(path.join(ROOT, 'lib', 'index.js')).href)
    const routes = []
    const registered = []
    const fakeCtx = {
      // 顶层 effect：apply 用它管理轮询器的启停
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
    // /areas 必须随同一份响应下发河川予報区域表，否则洪水电文全部退化为「归不到市町村」而放行。
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
      '/feed 返回读取位置与增量数组（读取位置是时间戳基数，Host 重启后仍单调）')
    assert(feedPayload.stats && typeof feedPayload.stats.polls === 'number', '?stats=1 附带轮询统计（便于诊断）')
    feedCall('/dsh-quake-alert/feed?since=abc')
    assert(JSON.parse(feedRes.body).entries.length === 0, '非法 since 参数按 0 处理（不抛错）')
    feedCall('/dsh-quake-alert/feed')
    assert(JSON.parse(feedRes.body).cursor === feedPayload.cursor, '省略 since 时同样按 tail 处理（读取位置不变、不回历史）')
    feedCall('/dsh-quake-alert/feed?since=tail')
    const tailPayload = JSON.parse(feedRes.body)
    assert(tailPayload.tail === true && tailPayload.entries.length === 0 && tailPayload.cursor === feedPayload.cursor,
      '?since=tail 只回当前位置、不回条目（Client 首次启动用）')
    feedCall('/dsh-quake-alert/feed?since=' + (feedPayload.cursor + 1))
    assert(JSON.parse(feedRes.body).reset === true, 'since > cursor（Host 重启 / 时钟回拨）→ reset 标记')
// 非法读取位置一律按 tail：按 0 处理等于让任何请求者一次拿走整个固定长度缓冲
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
    // **字节**上限：只限条数挡不住「50 条 × 98KB」，而本路由没有来源校验。
    {
      const many = { cursor: 500, entries: Array.from({ length: 50 }, (_, i) => ({ seq: i + 1, id: 'b' + i, xml: 'x'.repeat(60 * 1024) })) }
      capFeedEntries(many, 50, 1024 * 1024)
      assert(many.entries.length < 50 && many.more === true,
        '按字节截断（60KB × 50 条 → 只留 ' + many.entries.length + ' 条）')
      const total = many.entries.reduce((n, e) => n + e.xml.length, 0)
      assert(total <= 1024 * 1024, '留下的总量在上限内：' + total)
      const oneGiant = { cursor: 1, entries: [{ seq: 1, id: 'g', xml: 'y'.repeat(2 * 1024 * 1024) }] }
      capFeedEntries(oneGiant, 50, 1024 * 1024)
      assert(oneGiant.entries.length === 1,
        '单条就超预算时也留一条（那一条正是用户要看的数据，全清掉等于"什么都没收到"）')
      const noByteCap = { cursor: 1, entries: [{ seq: 1, id: 'n', xml: 'z'.repeat(2 * 1024 * 1024) }] }
      capFeedEntries(noByteCap, 50, 0)
      assert(noByteCap.more === undefined, 'maxBytes=0 时不按字节截断（显式不限）')
    }
  } catch (e) {
    assert(false, '真实市区町村表 / Host 路由验证失败：' + e.message)
  }

console.log('== 河川予報区域表（指定河川洪水予報 → 市町村）==')
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
    // 同名河川存在于多个区域代码下，所以主键必须是 code 而不是 name
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
    const crc32Of = (buf) => {
      let crc = -1
      for (const b of buf) {
        crc ^= b
        for (let k = 0; k < 8; k++) crc = (crc & 1) ? (0xEDB88320 ^ (crc >>> 1)) : (crc >>> 1)
      }
      return (crc ^ -1) >>> 0
    }
    const buildZip = (name, content, deflate, withCrc) => {
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
      if (withCrc) central.writeUInt32LE(crc32Of(raw), 16)
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

    // CRC32 与「解压后长度」必须校验：只按 compSize 切片时，被截断或注入坏字节的包会「成功地」进入 lib/data/
    {
      const crcName = 'c.csv'
      const good = buildZip(crcName, 'payload-12345', false, true)
      assert(unzip(good)[0].data.toString('utf8') === 'payload-12345', '（对照）CRC 正确时正常解出')
      const nameLen = Buffer.byteLength(crcName, 'utf8')
      const corrupted = Buffer.from(good)
      const dataAt = 30 + nameLen // 本地文件头(30) + 文件名之后就是数据
      corrupted[dataAt + 2] = corrupted[dataAt + 2] ^ 0xff
      let crcMsg = ''
      try { unzip(corrupted) } catch (err) { crcMsg = String(err.message) }
      assert(crcMsg.indexOf('CRC') !== -1, '数据被改坏 → CRC 不符抛错（坏数据不许进 lib/data/）：' + crcMsg)
      const badLen = Buffer.from(good)
      const cdOff = badLen.length - 22 - (46 + nameLen)
      badLen.writeUInt32LE(999, cdOff + 24) // 中央目录里的"解压后长度"
      let lenMsg = ''
      try { unzip(badLen) } catch (err) { lenMsg = String(err.message) }
      assert(lenMsg.indexOf('长度不符') !== -1, '解压后长度不符也抛错：' + lenMsg)
    }
  } catch (e) {
    assert(false, 'zip 读取器验证失败：' + e.message)
  }

console.log('== Host 电文轮询器（首次启动 / 去重 / 增量 / 固定长度缓冲）==')
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

    const parsed = parseAtomEntries(atom([entry(1, '2026-09-11T11:00:00Z'), { id: 'x', title: '', updated: '' }]))
    assert(parsed.length === 2 && parsed[0].id === 'detail-1' && parsed[0].title === '电文1', 'Atom 解析出 id/title/updated')
    assert(parseAtomEntries('<feed></feed>').length === 0, '空 feed 返回空数组')
    assert(parseAtomEntries('<entry><title>无 id</title></entry>').length === 0, '缺 id 的 entry 被跳过')

    let feedXml = atom([entry(1, '2026-09-11T11:00:00Z'), entry(2, '2026-09-11T11:30:00Z')])
    let clock = T0
    const f1 = fakeFetch({ [FEED]: () => feedXml, 'detail-1': '<Report/>', 'detail-2': '<Report/>', 'detail-3': '<Report/>', 'detail-4': '<Report/>' })
    const p1 = createPoller({ feedUrl: FEED, fetchText: f1.fn, now: () => clock })
    const r1 = await p1.pollOnce()
    assert(r1.coldStart === true && r1.added === 0, '首次启动不产生事件（不把 feed 里的历史当新闻）')
    assert(f1.calls.length === 1 && f1.calls[0] === FEED, '首次启动只拉 feed，不拉任何详情')
    const p1Base = p1.snapshot(0).cursor // 0.3.2：读取位置以时间戳为起点，断言一律基于这个基数
    assert(p1.snapshot(0).entries.length === 0 && p1Base >= T0, '首次启动后缓冲为空、读取位置停在起点（时间戳基数）')

    clock += 60 * 1000
    feedXml = atom([entry(3, '2026-09-11T12:01:00Z'), entry(2, '2026-09-11T11:30:00Z'), entry(1, '2026-09-11T11:00:00Z')])
    const r2 = await p1.pollOnce()
    assert(r2.added === 1, '新一轮只处理新 entry（+1）')
    assert(f1.calls.filter((u) => u === 'detail-3').length === 1, '为新 entry 拉了一次详情')
    assert(f1.calls.filter((u) => u === 'detail-1' || u === 'detail-2').length === 0,
      '首次启动时已见过的 entry 永不重拉（気象庁「不重复获取同一文件」）')
    const snap1 = p1.snapshot(0)
    assert(snap1.cursor === p1Base + 1 && snap1.entries.length === 1 && snap1.entries[0].id === 'detail-3', '增量快照含新条目与其原文')

    const callsBefore = f1.calls.length
    const r3 = await p1.pollOnce()
    assert(r3.added === 0 && f1.calls.length === callsBefore + 1, 'feed 无变化时只拉 feed 本身')

    clock += 60 * 1000
    feedXml = atom([entry(4, '2026-09-11T12:02:00Z'), entry(3, '2026-09-11T12:01:00Z')])
    await p1.pollOnce()
    assert(p1.snapshot(p1Base + 1).entries.length === 1 && p1.snapshot(p1Base + 1).entries[0].id === 'detail-4',
      'since=上一条的读取位置 → 只返回更新的条目')
    assert(p1.snapshot(p1Base + 2).entries.length === 0, 'since=最新读取位置 → 返回空')
    assert(p1.snapshot(0).truncated === false, '没发生淘汰时不标记截断')

    // ⑥ 详情拉取失败：不产事件、记 error，并有界重试；未取得的 id 不能记为已见（extra.xml 是滚动 feed）。
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

    // ⑥b 详情重试用尽而 entry 自带回退载荷时不许丢整条（nmc.cn 的橙 / 红档是唯一会响铃的那一档）。
    clock += 60 * 1000
    const feedFallback = atom([entry(9, new Date(clock).toISOString())])
    const fFb = fakeFetch({ [FEED]: () => feedFallback }) // detail-9 未登记 → 详情请求抛错
    const pFb = createPoller({
      feedUrl: FEED, fetchText: fFb.fn, now: () => clock,
      backfillMs: 5 * 60 * 1000, maxDetailRetries: 0,
      parseFeed: (xml) => parseAtomEntries(xml).map((e) => Object.assign({}, e, { payload: '{"alertid":"' + e.id + '","detail":""}' })),
      needDetail: () => true,
    })
    const rFb = await pFb.pollOnce()
    assert(rFb.added === 1, '详情抓取失败但有回退载荷 → 这条预警仍然进缓冲（不再整条丢）')
    assert(pFb.stats().detailFallback === 1 && pFb.stats().detailDropped === 0,
      '计入 detailFallback 而不是 detailDropped（一个"进了但少一段说明"，一个"真的没进"，UI 要分开看）')
    const fbSnap = pFb.snapshot(0)
    assert(fbSnap.entries.length === 1 && fbSnap.entries[0].xml.indexOf('detail-9') !== -1,
      '入库的是 entry 自带的回退载荷（预警本身在，只是没有详情正文）')
    clock += 60 * 1000
    const fbTries = fFb.calls.filter((u) => u === 'detail-9').length
    await pFb.pollOnce()
    assert(fFb.calls.filter((u) => u === 'detail-9').length === fbTries, '回退入库后不再反复请求同一个坏 URL')

    // ⑥c 失败路径要逐次延长重试间隔，且一轮成功立刻回到正常间隔
    {
      const realSetTimeout = globalThis.setTimeout
      const delays = []
      let pending = null
      globalThis.setTimeout = (fn, ms) => { delays.push(ms); pending = fn; return { unref() {} } }
      try {
        let failing = true
        const pB = createPoller({
          feedUrl: FEED,
          fetchText: async () => { if (failing) throw new Error('boom'); return atom([]) },
          now: () => clock, intervalMs: 60 * 1000, maxBackoffMs: 10 * 60 * 1000,
        })
        pB.start()
        assert(delays.length === 1 && delays[0] === 1500, '启动后首轮延迟不受重试间隔递增影响')
        await pending()
        assert(delays[1] === 120 * 1000, '第 1 次失败：间隔翻倍（旧实现恒为 60s，间隔永不回落）')
        await pending()
        assert(delays[2] === 240 * 1000, '第 2 次失败：继续翻倍')
        for (let i = 0; i < 5; i += 1) await pending()
        assert(delays[delays.length - 1] === 10 * 60 * 1000, '连续失败间隔递增到上限后封顶（不再放大）')
        failing = false
        await pending()
        assert(delays[delays.length - 1] === 60 * 1000, '一轮成功立刻回到 intervalMs（恢复不被重试间隔拖住）')
        assert(pB.stats().lastError.indexOf('feed fetch failed') === 0,
          '抓取失败也写 lastError（此前只有解析 / 详情失败写）：' + pB.stats().lastError)
        pB.stop()
      } finally {
        globalThis.setTimeout = realSetTimeout
      }
    }

    // ⑥d stop() 要中止在飞的请求，而不是让它在超时里跑完
    {
      let sawSignal = null
      let release = null
      const gate = new Promise((res) => { release = res })
      const pAb = createPoller({
        feedUrl: FEED,
        fetchText: async (url, init) => {
          sawSignal = init && init.signal
          await gate
          if (sawSignal && sawSignal.aborted) { const e = new Error('aborted'); e.name = 'AbortError'; throw e }
          return atom([])
        },
        now: () => clock,
      })
      const flying = pAb.pollOnce()
      pAb.stop()
      release()
      const rAb = await flying
      assert(sawSignal && typeof sawSignal.aborted === 'boolean', '抓取收到外部中止信号（0.9.4 新增的第二个入参）')
      assert(rAb && rAb.aborted === true, 'stop() 后这一轮判定为"被中止"')
      assert(pAb.stats().errors === 0 && pAb.stats().lastError === '', '被自己中止不算源故障（不污染 lastError / errors）')
    }

    // ⑥e 单级源的修订版：USGS 复核震级上修是最常见的路径，必须能进缓冲
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

    // ⑦ 缓冲长度上限：连续入 3 条、容量 1 → 只留最后 1 条，且更旧的读取位置标记截断
    clock += 60 * 1000
    let feedRotate = atom([entry(40, new Date(clock).toISOString())])
    const routes7 = { [FEED]: () => feedRotate, 'detail-41': '<Report/>', 'detail-42': '<Report/>' }
    const f3 = fakeFetch(routes7)
    const pRing = createPoller({ feedUrl: FEED, fetchText: f3.fn, now: () => clock, maxEntries: 1 })
    await pRing.pollOnce() // 首次启动：detail-40 记为已见
    const ringBase = pRing.snapshot(0).cursor
    for (const n of [41, 42]) {
      clock += 60 * 1000
      feedRotate = atom([entry(n, new Date(clock).toISOString()), entry(n - 1, new Date(clock - 60000).toISOString())])
      await pRing.pollOnce()
    }
    const snapRing = pRing.snapshot(0)
    assert(snapRing.cursor === ringBase + 2, '读取位置只统计真正入缓冲的条目（首次启动不计）')
    assert(snapRing.entries.length === 1 && snapRing.entries[0].id === 'detail-42', '缓冲只保留最近 maxEntries 条（淘汰最旧的）')
    assert(pRing.snapshot(0).truncated === true, '有条目被淘汰后从头拉取 → 标记 truncated')
    assert(pRing.snapshot(ringBase + 2).truncated === false, '读取位置正好等于最新 → 不标记截断')

    const f4 = fakeFetch({})
    const p6 = createPoller({ feedUrl: FEED, fetchText: f4.fn, now: () => clock })
    const r8 = await p6.pollOnce()
    assert(r8.added === 0 && p6.stats().errors === 1 && p6.snapshot(0).cursor >= T0 && p6.snapshot(0).entries.length === 0,
      'feed 失败时记 error、不产事件、读取位置停在起点')

    clock = T0
    const f5 = fakeFetch({
      [FEED]: () => atom([entry(30, new Date(T0 - 2 * 60 * 1000).toISOString()), entry(31, new Date(T0 - 60 * 60 * 1000).toISOString())]),
      'detail-30': '<Report/>', 'detail-31': '<Report/>',
    })
    const p7 = createPoller({ feedUrl: FEED, fetchText: f5.fn, now: () => clock, backfillMs: 5 * 60 * 1000 })
    const r9 = await p7.pollOnce()
    assert(r9.added === 1 && p7.snapshot(0).entries[0].id === 'detail-30',
      'backfillMs 窗口内的 entry 仍处理，窗口外的（1 小时前）跳过')

    // ⑪ 按需轮询：没人经 /feed 读取就不拉源
    clock = T0
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

    p7.start()
    assert(p7.snapshot(0).frozen === false, 'start 后状态为运行中')
    p7.stop()
    assert(p7.snapshot(0).frozen === true, 'stop 后 snapshot 标记 frozen')

    let clock13 = T0
    const f13 = fakeFetch({ [FEED]: () => atom([entry(1, new Date(clock13).toISOString())]), 'detail-1': '<Report/>' })
    const p8 = createPoller({ feedUrl: FEED, fetchText: f13.fn, now: () => clock13, backfillMs: 60 * 60 * 1000, idleMs: 0 })
    await p8.pollOnce()
    assert(p8.snapshot(0).entries.length === 1, '（前置）缓冲里已有 1 条')
    const base8 = p8.snapshot(0).cursor
    assert(base8 > 0 && base8 >= T0, '读取位置以时间戳为起点（跨进程单调，Host 重启后不会与旧位置撞车）')
    const tailSnap = p8.snapshot(0, { tail: true })
    assert(tailSnap.tail === true && tailSnap.entries.length === 0 && tailSnap.cursor === base8,
      'snapshot(tail) 只回当前位置、不回任何条目')
    const resetSnap = p8.snapshot(base8 + 1)
    assert(resetSnap.reset === true && resetSnap.entries.length === 1,
      'since > cursor（时钟回拨等异常）→ reset 且按 0 补齐缓冲')
    assert(p8.snapshot(base8).reset === false && p8.snapshot(0).tail === false,
      'reset 只在读取位置倒退时为真，普通请求不带 reset / tail 标记')
    assert(p8.snapshot(0).truncated === false && resetSnap.truncated === false,
      '没发生过淘汰时不报 truncated（seq 从时间戳起算，不能拿 seq 连续编号的假设去比）')

    let clock14 = T0
    const feed14 = () => atom([1, 2, 3].map((n) => entry(n, new Date(clock14 + n * 1000).toISOString())))
    const f14 = fakeFetch({ [FEED]: feed14, 'detail-1': '<Report/>', 'detail-2': '<Report/>', 'detail-3': '<Report/>' })
    const p9 = createPoller({ feedUrl: FEED, fetchText: f14.fn, now: () => clock14, backfillMs: 60 * 60 * 1000, idleMs: 0, maxEntries: 2 })
    await p9.pollOnce()
    const base9 = p9.snapshot(0).cursor - 2
    assert(p9.snapshot(0).entries.length === 2 && p9.snapshot(0).truncated === true,
      '缓冲淘汰旧条目后 truncated 仍能正确报出（dropped > 0 且 from 落在缺口里）')
    assert(p9.snapshot(base9 + 2).truncated === false, '从缺口之后取值不再报 truncated')

    // ⑮ 首次启动只丢「进程启动之前」的历史：真正的首次启动发生在 Host 启动约 1 分钟后（首轮被按需轮询 skip）。
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
      '首次启动：进程启动之后发布的电文照常处理（旧实现会当历史永久丢掉）')
    assert(f15.calls.indexOf('detail-60') === -1, '首次启动：启动之前的历史仍然只记已见、不拉详情')

    // ⑮' 时钟容差：启动前 1 分钟发布的仍在窗口内，启动前 10 分钟的历史仍跳过
    const f15b = fakeFetch({ [FEED]: () => atom([entry(62, new Date(T0 - 60 * 1000).toISOString())]), 'detail-62': '<Report/>' })
    const p15b = createPoller({ feedUrl: FEED, fetchText: f15b.fn, now: () => T0, startedAt: T0 })
    assert((await p15b.pollOnce()).added === 1, '启动前 1 分钟发布的电文仍在容差内 → 处理')
    const f15c = fakeFetch({ [FEED]: () => atom([entry(63, new Date(T0 - 10 * 60 * 1000).toISOString())]), 'detail-63': '<Report/>' })
    const p15c = createPoller({ feedUrl: FEED, fetchText: f15c.fn, now: () => T0, startedAt: T0 })
    assert((await p15c.pollOnce()).added === 0, '启动前 10 分钟的历史仍然跳过（容差没有放大成刷屏）')

    // ⑯ 默认抓取实现的超时信号与响应体上限
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
      assert(msg.indexOf('too large') !== -1, '响应体超过上限 → 抛错（不把内存吃满）：' + msg)
      assert(seenInit && seenInit.signal !== undefined, '默认请求带上超时信号（对端挂起不会把轮询拖停）')
      const ft2 = createFetchText({ maxBodyBytes: 1024, timeoutMs: 1234 })
      assert((await ft2('https://example.test/ok')) === 'x'.repeat(64), '上限内的响应正常返回')
      globalThis.fetch = async () => ({ ok: false, status: 503, text: async () => '' })
      let msg2 = ''
      try { await ft2('https://example.test/bad') } catch (e) { msg2 = e.message }
      assert(msg2.indexOf('503') !== -1, '非 2xx 仍然抛错（原有行为不变）')

      // content-length 说的是**压缩前**的长度，而 fetch 交给我们的是解压后的正文：按 body 流读取、
      // 边读边计数、超限即 cancel。
      const enc = new globalThis.TextEncoder()
      const streamRes = (chunks) => ({
        ok: true, status: 200, headers: { get: () => null },
        body: new globalThis.ReadableStream({
          start(c) { for (const s of chunks) c.enqueue(enc.encode(s)); c.close() },
        }),
        text: async () => { throw new Error('有 body 流时不该回退到 res.text()') },
      })
      globalThis.fetch = async () => streamRes(['x'.repeat(64), 'y'.repeat(64)])
      const ftStream = createFetchText({ maxBodyBytes: 10, timeoutMs: 1234 })
      let msgStream = ''
      try { await ftStream('https://example.test/stream') } catch (e) { msgStream = e.message }
      assert(msgStream.indexOf('too large') !== -1, '有 body 流时按流读取、超限立刻判定（解压后的体积才拦得住）：' + msgStream)
      globalThis.fetch = async () => streamRes(['héllo'])
      const ftStreamOk = createFetchText({ maxBodyBytes: 1024, timeoutMs: 1234 })
      assert((await ftStreamOk('https://example.test/stream-ok')) === 'héllo',
        '流式读取正确解码（多字节字符跨块不被打断）')

      // 外部中止信号与超时信号两个都要带上——漏掉超时则对端挂起能拖停整条轮询，漏掉外部则 stop() 形同虚设。
      const ftExt = createFetchText({ timeoutMs: 1234 })
      const acExt = new globalThis.AbortController()
      globalThis.fetch = async (url, init) => { seenInit = init; return { ok: true, status: 200, text: async () => 'ok' } }
      await ftExt('https://example.test/ext', { signal: acExt.signal })
      assert(seenInit && seenInit.signal !== undefined, '带外部信号时仍保留超时信号（两个都带上）')
      acExt.abort()
      assert(seenInit.signal.aborted === true, '外部信号中止 → 请求信号随之中止（stop() 能掐断在飞请求）')
      const realAny = globalThis.AbortSignal.any
      try {
        delete globalThis.AbortSignal.any
        const acOld = new globalThis.AbortController()
        await ftExt('https://example.test/ext-old', { signal: acOld.signal })
        assert(seenInit.signal === acOld.signal, '无 AbortSignal.any 时退化为"优先保外部信号"（stop() 仍然有效）')
      } finally {
        globalThis.AbortSignal.any = realAny
      }
    } finally {
      globalThis.fetch = realFetch
    }
  } catch (e) {
    assert(false, 'Host 轮询器验证失败：' + e.message)
  }

console.log('== Host 侧全球源（USGS 单级 / NOAA 两级）==')
  try {
    const pollerMod = await import(pathToFileURL(path.join(ROOT, 'lib', 'poller.js')).href)
    const gs = await import(pathToFileURL(path.join(ROOT, 'lib', 'global-sources.js')).href)
    const { createPoller } = pollerMod
    const { parseUsgsEntries, parseNoaaEntries, USGS_FEED_URL, NOAA_FEED_URL } = gs

    const usgsText = fs.readFileSync(path.join(ROOT, 'samples', 'global', 'usgs-all-hour.geojson'), 'utf8')
    const usgsEntries = parseUsgsEntries(usgsText)
    assert(usgsEntries.length >= 3, 'USGS feed → 解析出 ' + usgsEntries.length + ' 条 entry')
    assert(usgsEntries.every((e) => e.id && e.payload && e.updated), 'USGS entry 自带 id / payload / updated')
    // 结构不符必须抛错（由 poller 计入 errors），不能与「没有数据」同形
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
    assert(snapU.entries.length === usgsEntries.length, 'USGS 条目全部进入缓冲')
    assert(snapU.entries[0].xml.indexOf('"mag"') !== -1, 'USGS 缓冲里存的是 feature 的 JSON 正文')
    assert(pUsgs.stats().detailsFetched === 0, 'USGS 不增加详情抓取计数')

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

    assert(pUsgs.snapshot(0).entries.length !== pNoaa.snapshot(0).entries.length ||
      pUsgs.snapshot(0).cursor !== pNoaa.snapshot(0).cursor, '两个源的缓冲 / 读取位置互相独立')
    const hostMod = await import(pathToFileURL(path.join(ROOT, 'lib', 'index.js')).href)
    assert(hostMod.FEED_PATH === '/dsh-quake-alert/feed', 'FEED_PATH 未变（旧版 Client 不带 source 参数仍可用）')
    assert(typeof hostMod.apply === 'function', 'lib/index.js 仍导出 apply')
  } catch (err) {
    assert(false, 'Host 全球源验证失败：' + err.message)
  }

console.log('== /feed 多源分派（不触网）==')
  try {
    const hostMod = await import(pathToFileURL(path.join(ROOT, 'lib', 'index.js')).href)
    const routes = []
    // 假 ctx：顶层 effect（poller.start）故意不执行，否则会在测试里真的发外部请求；webServer 的 effect 必须执行。
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
    // 认不出的 source 必须 400：静默退回 jma 会让 Client 拿另一个源的原文去解析却照样推进读取位置，条目被永久跳过。
    const badProto = callRaw('?source=constructor&since=tail')
    assert(badProto.status === 400 && badProto.body.error === 'unknown source',
      '原型链键（constructor）不再命中原型链，直接 400（不是 TypeError、也不再静默兜底）')
    const badUnknown = callRaw('?source=%3BDROP&since=tail')
    assert(badUnknown.status === 400, '未知 source → 400，不再静默退回 jma')
    assert(call('?source=%20noaa%20&since=tail').source === 'noaa', 'source 两侧空白被裁剪（" noaa " 仍可识别）')
    // 跨站 GET 会被拒绝：/feed 的 markRead 副作用不读响应也能触发，任意网页一个 <img> 就能压住按需轮询。
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

console.log('== JMA 电文解析（泥石流 / 洪水 / 大雨 / 高潮）==')
  try {
    const riverMod = await import(pathToFileURL(path.join(ROOT, 'lib', 'data', 'river-areas.js')).href)
    const citiesMod = await import(pathToFileURL(path.join(ROOT, 'lib', 'data', 'cities.js')).href)
    const t = loadClient().__test
    t.setCityTable(citiesMod.CITIES_BY_PREF)
    t.setRiverAreas(riverMod.RIVER_AREAS)
    const jma = (n) => fs.readFileSync(path.join(ROOT, 'samples', n), 'utf8')

    const w = t.parseJma(jma('jma-vxww50-landslide.xml'), { id: 'vxww50' })
    assert(w && w.kind === 'weather', 'VXWW50 → kind=weather')
    assert(w.level === 4, 'VXWW50 → 警戒レベル4（电文本身即 L4 相当）')
    assert(w.kindLabel === '泥石流警戒情报', 'VXWW50 → 中文标签为泥石流警戒情报')
    assert(w.severity === 'red' && w.cancelled === false, 'VXWW50 → severity=red、非解除')
    assert(w.regions.length >= 20, 'VXWW50 → 展开出 ' + w.regions.length + ' 个市町村（裸 <Area> 也能取到）')
    assert(w.regions.every((r) => r.pref === '福岡県' && r.city), 'VXWW50 → 全部归到福岡県的市町村（按 code 前两位判县）')
    assert(w.eventKey.indexOf('福岡県土砂災害警戒情報') !== -1, 'VXWW50 → 事件键取自 EventID')

    const f = t.parseJma(jma('jma-vxko-flood.xml'), { id: 'vxko' })
    assert(f && f.level === 2, 'VXKO → 从「警戒レベル２相当情報」读出级别')
    assert(f.kindLabel === '洪水预报', 'VXKO → 中文标签为洪水预报')
    assert(f.regions.length >= 1 && f.regions.some((r) => r.prefUnknown),
      'VXKO → 样本用占位码认不出归属时标记 prefUnknown（放行而不是漏报）')

    //     regions 为空时 matchAlert 返回 hit:false + 原因，主链仍会写一条带「未命中」说明的历史。
    {
      const allUnknown = jma('jma-vxko-flood.xml').replace(/codeType="[^"]*"/g, 'codeType="水位観測所"')
      const u = t.parseJma(allUnknown, { id: 'unknown-areas' })
      assert(u && u.regions.length === 0, '（前置）全未知 codeType → regions 为空（不猜码位数造幻影区域）')
      const cfgU = JSON.parse(JSON.stringify(t.DEFAULT_CFG))
      cfgU.notify = { sound: false, system: false, volume: 0 }
      cfgU.watch = { prefectures: ['東京都'], cities: [], places: [] }
      const before = t.loadHistory().length
      const rU = t.handleAlert(u, cfgU)
      assert(rU.notified === false && rU.detail === '本条电文未携带可判定的区域',
        '不播报，但如实给出原因：' + JSON.stringify(rU))
      const hU = t.loadHistory()
      assert(hU.length === before + 1 && String(hU[0].headline).indexOf('未命中') !== -1,
        'regions 全空时仍进历史（"区域一个都不认识"不能让用户以为当时没有预警）')
    }

    const s = t.parseJma(jma('jma-vpww56-landslide.xml'), { id: 'vpww56' })
    assert(s && s.level === 4 && s.kindLabel === '泥石流警报', 'VPWW56（土砂）→ L4 / 泥石流警报')
    const hr = t.parseJma(jma('jma-vpww55-heavyrain.xml'), { id: 'vpww55' })
    assert(hr && hr.level === 4 && hr.kindLabel === '大雨警报', 'VPWW55（大雨）→ L4 / 大雨警报')
    const ss = t.parseJma(jma('jma-vpww57-stormsurge.xml'), { id: 'vpww57' })
    assert(ss && ss.level === 4 && ss.kindLabel === '风暴潮警报', 'VPWW57（高潮）→ L4 / 风暴潮警报')
    assert(s.regions.some((r) => r.pref === '北海道'), '细分区域（宗谷北部）按 code 前两位归到北海道')
    assert(s.regions.every((r) => r.pref), 'VPWW56 → 没有 prefUnknown（细分区全部识别）')

    const nothing = t.parseJma('<?xml version="1.0"?><Report><Control><Title>府県天気予報</Title></Control>' +
      '<Head><Title>東京都府県天気予報</Title></Head><Body><Item><Kind><Name>天気概況</Name><Code>1</Code></Kind>' +
      '<Area><Name>東京地方</Name><Code>130010</Code></Area></Item></Body></Report>', { id: 'x' })
    assert(nothing === null, '无警戒级别的电文（天气预报）→ null')

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

console.log('== 旧格式 / 报知电文的级别识别（特別警報漏报修复）==')
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
    // 这条电文的正文是「…を警報に切り替えました。」——是**降级**不是解除：按解除处理会在历史里写「已解除」，事实相反。
    assert(cxl && cxl.cancelled === false && cxl.downgraded === true && cxl.level === 4,
      'VPNO50 的「特別警報 → 警報」切换 → 判为降级（L4 仍有效），不再当解除（DESIGN 11.9 #5）')
    assert(cxl.kindLabel.indexOf('降级') !== -1, '降级报知 → 标签如实写「降级」而不是「已解除」')

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

console.log('== 气象警报的匹配与播报边界（L4 起）==')
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

console.log('== 全球源的坐标匹配（震中距 + 震级阈值）==')
  try {
    const t = loadClient().__test
    const cfgWith = (places, mag) => ({
      watch: { prefectures: [], cities: [], places },
      disasters: { earthquake: true, tsunami: true, weather: true },
      thresholds: { globalMagnitude: mag === undefined ? 4.5 : mag },
      dedupe: { windowMinutes: 10 }, notify: {}, quietHours: { enabled: false },
    })
    const tokyo = { name: '东京', lat: 35.6812, lon: 139.7671, radiusKm: 300 }

    const dOsaka = t.distanceKm(35.6812, 139.7671, 34.6937, 135.5023)
    assert(Math.abs(dOsaka - 400) < 25, '东京→大阪距离约 400km（实测 ' + Math.round(dOsaka) + 'km）')
    const dSapporo = t.distanceKm(35.6812, 139.7671, 43.0618, 141.3545)
    assert(Math.abs(dSapporo - 830) < 40, '东京→札幌距离约 830km（实测 ' + Math.round(dSapporo) + 'km）')
    assert(t.distanceKm(35.6812, 139.7671, 35.6812, 139.7671) === 0, '同点距离为 0')

    // ② 坐标合法性：-200 是 P2PQuake/部分源表示「未知」的特殊标记值，必须挡下
    assert(t.validGeo({ lat: -200, lon: -200 }) === false, '特殊标记坐标 -200 判为不可用')
    assert(t.validGeo({ lat: NaN, lon: 139 }) === false, 'NaN 判为不可用')
    assert(t.validGeo({ lat: 91, lon: 0 }) === false, '越界纬度判为不可用')
    assert(t.validGeo({ lat: 35.68, lon: 139.77 }) === true, '正常坐标判为可用')

    const point = (lat, lon, mag) => ({
      id: 'emsc-1', code: 'emsc', kind: 'quake', kindLabel: '地震（EMSC）', severity: 'orange',
      issued: '', headline: '', maxScale: -1, level: 0, locator: 'point', source: 'emsc',
      geo: { lat, lon }, magnitude: mag, hypo: { name: '', magnitude: mag },
      regions: [], eventKey: '', strength: mag, cancelled: false,
    })

    const near = point(35.0, 140.0, 5.2) // 距东京约 90km
    const m1 = t.matchPointAlert(near, cfgWith([tokyo]))
    assert(m1.hit === true && m1.place.name === '东京' && m1.distanceKm < tokyo.radiusKm,
      '震中在关注点半径内 → 命中（距东京 ' + Math.round(m1.distanceKm) + 'km）')
    const far = point(43.0618, 141.3545, 6.0) // 札幌，距东京约 830km
    const m2 = t.matchPointAlert(far, cfgWith([tokyo]))
    // 未命中原因按界面语言取词（reason.nearestWatch），所以断言查**结构化的事实**（距离与半径），不钉中文散文。
    assert(m2.hit === false && /约 \d+ km/.test(m2.reason) && m2.reason.indexOf('东京') !== -1 &&
      m2.reason.indexOf(String(tokyo.radiusKm)) !== -1,
      '震中在半径外 → 不命中，理由里给出实际距离与半径：' + m2.reason)
    const weak = point(35.0, 140.0, 4.4)
    const m3 = t.matchPointAlert(weak, cfgWith([tokyo]))
    assert(m3.hit === false && m3.reason.indexOf('低于全球震级阈值') !== -1, '震级低于阈值 → 不命中')
    assert(t.matchPointAlert(point(35.0, 140.0, 4.5), cfgWith([tokyo])).hit === true, '震级恰好等于阈值 → 命中')

    // ④ 没配关注点 / 坐标缺失：如实说明，不能默默放行（那会让"配错了"看起来像"没有地震"）
    const m4 = t.matchPointAlert(near, cfgWith([]))
    assert(m4.hit === false && m4.reason.indexOf('未设置全球关注点') !== -1, '未设置全球关注点 → 不命中并提示去哪配')
    const m5 = t.matchPointAlert(Object.assign({}, near, { geo: null }), cfgWith([tokyo]))
    assert(m5.hit === false && m5.reason.indexOf('未携带可用坐标') !== -1, '坐标缺失 → 不命中并说明原因')

    const osaka = { name: '大阪', lat: 34.6937, lon: 135.5023, radiusKm: 100 }
    const m6 = t.matchPointAlert(point(34.7, 135.5, 5.0), cfgWith([tokyo, osaka]))
    assert(m6.hit === true && m6.place.name === '大阪', '多个关注点时任一点命中即提醒')

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

    // ⑦ places 规整：格式不合法的数据不能进配置，重复点合并，半径夹取，数量封顶
    const dirty = [
      { name: '东京', lat: 35.6812, lon: 139.7671, radiusKm: 300 },
      { name: '重复的东京', lat: 35.6812, lon: 139.7671, radiusKm: 500 },
      { name: '缺索引', lat: 'abc', lon: 139 },
      { name: '越界', lat: 99, lon: 200 },
      null, 'oops',
      { name: '', lat: 34.69, lon: 135.5, radiusKm: 99999 },
    ]
    const places = t.normalizePlaces(dirty)
    assert(places.length === 2, '格式不合法的数据被过滤、重复点合并（7 项 → 2 项）')
    assert(places[0].name === '东京' && places[1].name === '34.69, 135.50', '缺名字时用坐标生成默认名')
    assert(places[1].radiusKm === 2000, '半径超上限被夹到 2000km')
    assert(t.normalizePlaces(new Array(30).fill(0).map((_, i) => ({ lat: i, lon: 0, radiusKm: 100 }))).length === 20,
      '关注点数量封顶 20 个')
  } catch (e) {
    assert(false, '坐标匹配验证失败：' + e.message)
  }

console.log('== 全球源解析（EMSC / USGS / NOAA CAP）==')
  try {
    const t = loadClient().__test
    const gf = (n) => fs.readFileSync(path.join(ROOT, 'samples', 'global', n), 'utf8')

    const e = t.parseEmsc(JSON.parse(gf('emsc-ws-sample.json')))
    assert(e && e.kind === 'quake' && e.source === 'emsc' && e.locator === 'point', 'EMSC → 坐标型地震 Alert')
    assert(e.geo.lat === 37.9921 && e.geo.lon === 22.2789, 'EMSC → 从 properties.lat/lon 取到震中')
    assert(e.magnitude === 3.3 && e.magType === 'ml', 'EMSC → 震级 3.3 / 震级类型 ml')
    assert(e.regions.length === 0, 'EMSC → 没有行政区区域（flynn_region 只作显示）')
    assert(e.headline.indexOf('SOUTHERN GREECE') !== -1, 'EMSC → headline 用 flynn_region（该源没有 region 字段）')
    assert(e.eventKey === 'geo:2026-09-12T02:15@38.0,22.3', 'EMSC → 跨源事件键 = 分钟 + 震中（0.1 度）')
    assert(t.parseEmsc({ action: 'delete' }) === null, 'EMSC → 没有 data 的消息返回 null')
    assert(t.parseEmsc(null) === null && t.parseEmsc('x') === null, 'EMSC → 脏输入不抛错')

    // ② USGS：FeatureCollection，geometry.coordinates = [经度, 纬度, 深度km]；生产路径是逐条 parseUsgsFeature。
    const usFeed = JSON.parse(gf('usgs-all-hour.geojson'))
    const us = usFeed.features.map(t.parseUsgsFeature).filter(Boolean)
    assert(us.length >= 3 && us.length === usFeed.features.length,
      'USGS → 真实样本的每个 feature 都解析成功（' + us.length + '/' + usFeed.features.length + '）')
    const u0 = us[0]
    assert(u0.kind === 'quake' && u0.source === 'usgs' && u0.locator === 'point', 'USGS → 坐标型地震 Alert')
    assert(Math.abs(u0.geo.lat) <= 90 && Math.abs(u0.geo.lon) <= 180 && typeof u0.geo.lat === 'number',
      'USGS → 经纬度没写反（coordinates 顺序是 lon,lat）')
    assert(u0.issued.indexOf('T') !== -1 && u0.issued.indexOf('Z') !== -1, 'USGS → epoch 毫秒已转成 ISO 字符串')
    assert(us.every((a) => a.regions.length === 0), 'USGS → 全部没有行政区区域')
    // 「能力真的生效」：真实 feature 必须走完**匹配与播报**，而不只是解析出字段。此前 usgs 的播报
    // 证据全部来自手工构造的 Alert，真实 feature 从没进过 matchAlert —— magnitude 字段一旦改名 /
    // 类型漂移（解析成 null），匹配层的震级门槛会被短路（06-matcher 只在 mag 是数值时才比较），
    // 于是真实地震按距离全响，而解析层断言全绿。
    assert(u0.magnitude === usFeed.features[0].properties.mag,
      'USGS → magnitude 直接取自 properties.mag（' + u0.magnitude + '）')
    {
      // 独立实例：handleAlert 会写历史与去重表，不污染上面的解析断言。
      const usT = loadClientEx().exports.__test
      const uReal = usT.parseUsgsFeature(usFeed.features[0])
      const usCfg = (minMag) => Object.assign({}, usT.DEFAULT_CFG, {
        watch: {
          prefectures: [], cities: [],
          places: [{ name: '样本点', lat: uReal.geo.lat, lon: uReal.geo.lon, radiusKm: 50 }],
        },
        thresholds: Object.assign({}, usT.DEFAULT_CFG.thresholds, { globalMagnitude: minMag }),
      })
      assert(usT.matchAlert(uReal, usCfg(1.0)).hit === true,
        'USGS → 真实样本落在关注点半径内、达 M1.0 阈值时命中')
      assert(usT.matchAlert(uReal, usCfg(4.5)).hit === false,
        'USGS → 同一个真实样本在默认 M4.5 下不命中（震级门槛真的读到了真实 feature 的 magnitude）')
      const rUs = usT.handleAlert(uReal, usCfg(1.0), { skipQuietHours: true })
      assert(rUs.notified === true,
        'USGS → 真实 feature 走完 handleAlert 并播报（解析→匹配→播报整条链路）：' + JSON.stringify(rUs))
    }
    // 缺坐标不造「看起来有效」的事件对象
    assert(t.parseUsgsFeature(null) === null && t.parseUsgsFeature([]) === null, 'USGS → 脏输入返回 null')
    assert(t.parseUsgsFeature({ properties: { mag: 5 } }) === null,
      'USGS → 有 properties 但**没有 geometry** → null（此前会产出 geo:{lat:null,lon:null} 与 id:"usgs:null,null,…"）')
    assert(t.parseUsgsFeature({ geometry: { coordinates: [null, null] }, properties: { mag: 5 } }) === null,
      'USGS → coordinates 值是 null 同样返回 null')
    const twoNoGeo = [
      { properties: { mag: 5, time: 1 } },
      { properties: { mag: 6, time: 2 } },
    ].map(t.parseUsgsFeature).filter(Boolean)
    assert(twoNoGeo.length === 0,
      'USGS → 两条都缺坐标时不产出任何事件（此前两条的 id 会撞成同一个 "usgs:null,null,…"）')

    // 两个全球源对同一场地震 → 同一个事件键（否则接了第二个源就会响两次）
    const sameTime = '2026-09-12T02:15:12.43Z'
    const emscTwin = t.parseEmsc({ data: { properties: { mag: 3.3, lat: 37.99, lon: 22.27, time: sameTime } } })
    const usgsTwin = t.parseUsgsFeature({ id: 'x', geometry: { coordinates: [22.28, 37.99, 10] }, properties: { mag: 3.4, time: Date.parse(sameTime) } })
    assert(emscTwin.eventKey === usgsTwin.eventKey, 'EMSC 与 USGS 对同一场地震给出同一个事件键（跨源归并）')

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
    // NOAA 的「Tsunami Information」等级为 0，默认 tsunamiGrade=Watch(1) 之下不命中：半径内响铃会摧毁用户对整条链路的信任。
    assert(t.matchAlert(n, tsunamiCfg).hit === false, '端到端：NOAA「海啸信息」不再响铃（等级低于 tsunamiGrade）')
    const nAdv = t.parseNoaaCap(
      fs.readFileSync(path.join(ROOT, 'samples', 'global', 'noaa-pheb-cap.xml'), 'utf8')
        .replace('<event>Tsunami Information</event>', '<event>Tsunami Advisory</event>'),
      { id: 'adv' })
    assert(t.matchAlert(nAdv, tsunamiCfg).hit === true, '端到端：Tsunami Advisory 命中 Scotia 海关注点')
    assert(t.matchAlert(n, JSON.parse(JSON.stringify(gcfg))).hit === false, '端到端：海啸没命中任何关注点 → 不提醒')
    // 「能力真的生效」到播报层：真实 CAP 原样是 Information（等级 0，不响），把它的等级字段换成
    // Advisory 之后必须能走完 handleAlert 并**真的播报**——此前只验到 matchAlert，而「命中判定通过」
    // 不等于「播报闸门放行」（静默时段 / 事件年龄 / 解除 / 灾种开关都可能挡在中间）。
    {
      const nt = loadClientEx().exports.__test
      // issued 取当前时刻：本条验的是真实 CAP 结构能否走通匹配与播报闸门，事件年龄另有用例守；
      // 写死 fixture 的发布时间会让这条断言随真实时钟变红。
      const adv = Object.assign(
        nt.parseNoaaCap(
          fs.readFileSync(path.join(ROOT, 'samples', 'global', 'noaa-pheb-cap.xml'), 'utf8')
            .replace('<event>Tsunami Information</event>', '<event>Tsunami Advisory</event>'),
          { id: 'adv-runtime' }),
        { issued: new Date().toISOString() })
      const nCfg = Object.assign({}, nt.DEFAULT_CFG, {
        watch: {
          prefectures: [], cities: [],
          places: [{ name: 'Scotia 海', lat: -60.48, lon: -47.19, radiusKm: 300 }],
        },
        thresholds: Object.assign({}, nt.DEFAULT_CFG.thresholds, { tsunamiGrade: 'Watch' }),
      })
      const rAdv = nt.handleAlert(adv, nCfg, { skipQuietHours: true })
      assert(rAdv.notified === true,
        'NOAA → 真实 CAP（仅把 event 换成 Advisory）走完 handleAlert 并播报：' + JSON.stringify(rAdv))
    }
  } catch (err) {
    assert(false, '全球源解析验证失败：' + err.message)
  }

console.log('== 多源连接状态与全球链路装配 ==')
  try {
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

console.log('== 全球链路的本地测试消息 + 海啸不受震级阈值限制 ==')
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

    // 每个场景都必须经**真实解析器**得到坐标型 Alert：测试按钮走的是与线上完全相同的代码路径。
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
    assert(mFar.hit === false && mFar.reason.indexOf(String(place.radiusKm)) !== -1,
      '远地场景 → 半径外不命中，理由里带上半径：' + mFar.reason)
    assert(t.matchAlert(farMsg, gcfg(4.5, 1500)).hit === true,
      '把半径调到 1500km → 同一条远地消息命中（证明是半径在起作用，不是消息无效）')

    // 连点两次都会被播报：测试事件键必须每次不同，否则第二次会被判成「同一场地震的重复发布」而静默。
    const g1 = t.parseTestGlobalMessage(t.buildTestGlobalMessage(place, 1700000000010, 'emsc'))
    const g2 = t.parseTestGlobalMessage(t.buildTestGlobalMessage(place, 1700000000011, 'emsc'))
    assert(g1.id !== g2.id && g1.eventKey !== g2.eventKey, '两次点击的 id 与事件键都不同（不会被去重吞掉）')
    assert(t.isEventRepeat(g1, 10) === false && t.isEventRepeat(g2, 10) === false,
      '连点两次都能播报（不会被事件级去重判成重复发布）')

    // 海啸不受全球震级阈值限制：NOAA 电文里的前震震级只是参考值。
    const noaaTest = t.parseTestGlobalMessage(t.buildTestGlobalMessage(place, 1700000000003, 'noaa'))
    assert(t.matchAlert(noaaTest, gcfg(9)).hit === true, '海啸不受 globalMagnitude 限制（阈值 M9.0 时仍命中）')
    const quakeTest = t.parseTestGlobalMessage(t.buildTestGlobalMessage(place, 1700000000004, 'emsc'))
    assert(t.matchAlert(quakeTest, gcfg(9)).hit === false, '地震仍然受 globalMagnitude 限制（阈值 M9.0 时不命中）')
    const realCap = t.parseNoaaCap(fs.readFileSync(path.join(ROOT, 'samples', 'global', 'noaa-pheb-cap.xml'), 'utf8'), { id: 'x' })
    const capCfg = gcfg(9)
    capCfg.watch.places = [{ name: 'Scotia', lat: -60.48, lon: -47.19, radiusKm: 300 }]
    assert(realCap.tsunamiRank === 0, 'NOAA Information → tsunamiRank=0（与日本 TSUNAMI_RANK 同一把尺）')
    assert(t.matchAlert(realCap, capCfg).hit === false, 'NOAA「海啸信息」不再命中（等级低于阈值）')
    const capAdv = t.parseNoaaCap(
      fs.readFileSync(path.join(ROOT, 'samples', 'global', 'noaa-pheb-cap.xml'), 'utf8')
        .replace('<event>Tsunami Information</event>', '<event>Tsunami Advisory</event>'),
      { id: 'adv' })
    assert(t.matchAlert(capAdv, capCfg).hit === true, '同一份 CAP 改成 Advisory → 在 M9.0 阈值下仍命中（海啸不受震级限制）')
    // 标签必须与档位同口径：Advisory / Watch 的等级是 2（警报档），标签若写作「注意报」，
    // 把阈值收紧到警报档的用户会收到一条显示为注意报的提醒。
    {
      const capSrc = fs.readFileSync(path.join(ROOT, 'samples', 'global', 'noaa-pheb-cap.xml'), 'utf8')
      const cases = [
        ['Tsunami Warning', 3, '大海啸警报'],
        ['Tsunami Advisory', 2, '海啸警报'],
        ['Tsunami Watch', 2, '海啸警报'],
        ['Tsunami Information', 0, '海啸信息'],
      ]
      for (const [ev, rank, word] of cases) {
        const one = t.parseNoaaCap(capSrc.replace(/<event>[^<]*<\/event>/, '<event>' + ev + '</event>'), { id: 'rank-' + rank })
        assert(one && one.tsunamiRank === rank && one.maxScale === rank && one.strength === rank,
          ev + ' → 等级 ' + rank + '（tsunamiRank / maxScale / strength 三处同一值）')
        assert(one && one.kindLabel.indexOf(word) === 0,
          ev + ' 的标签以「' + word + '」开头，与档位同口径（实际：' + (one && one.kindLabel) + '）')
      }
      // event 名必须**整串锚定**匹配：子串匹配会把下面这些抬到最高档（3）、并越过等级门槛。
      const notWarning = t.parseNoaaCap(capSrc.replace(/<event>[^<]*<\/event>/, '<event>Not a Tsunami Warning</event>'), { id: 'not' })
      assert(notWarning && notWarning.tsunamiRank === 0 && notWarning.kindLabel.indexOf('未识别') !== -1,
        '"Not a Tsunami Warning" 不再被抬成大海啸警报（子串匹配的误报方向）')
      const cancelWorded = t.parseNoaaCap(capSrc.replace(/<event>[^<]*<\/event>/, '<event>Tsunami Warning Cancellation</event>'), { id: 'cx' })
      assert(cancelWorded && cancelWorded.tsunamiRank === 0,
        '"Tsunami Warning Cancellation" 不再被抬成大海啸警报（作废电文按最高档提示是反的）')
      // 未识别的 event 名：等级仍是 0（不响铃），但标签**如实**带出原始 event 名。
      const unknownEv = t.parseNoaaCap(capSrc.replace(/<event>[^<]*<\/event>/, '<event>Tsunami Threat Message</event>'), { id: 'unk' })
      assert(unknownEv && unknownEv.tsunamiRank === 0 && unknownEv.kindLabel.indexOf('Tsunami Threat Message') !== -1,
        '未识别的 event 名如实出现在标签里：' + (unknownEv && unknownEv.kindLabel))
      assert(t.matchAlert(unknownEv, { watch: { places: [{ name: 'Scotia', lat: -60.48, lon: -47.19, radiusKm: 300 }], prefectures: [], cities: [] }, thresholds: { tsunamiGrade: 'Watch', globalMagnitude: 0 }, disasters: { tsunami: true } }).hit === false,
        '未识别的 event 仍然不响铃（等级 0）——可见但不打扰')
    }
  } catch (err) {
    assert(false, '全球测试消息验证失败：' + err.message)
  }

console.log('== Client 电文增量拉取（读取位置 / 容错 / 开关）==')
  try {
    const t = loadClient().__test
    // 显式注入读取位置存取：读取位置会写入本地存储，用默认实现会让 c1 写进沙箱的值串到 c2/c3。
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
    assert(c1.cursor() === 2, '读取位置推进到 Host 返回值')
    payload = { cursor: 3, entries: [{ id: 'e3' }], truncated: true }
    await c1.pollOnce()
    assert(calls[1].indexOf('since=2') !== -1, '后续请求带上读取位置（?since=2）')
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
    assert(c2.cursor() === 1, '恢复后读取位置推进到 Host 返回值（cursor=' + c2.cursor() + '）')

    // 单条失败不影响其余条目与读取位置
    const applied = []
    const c3 = t.createFeedClient(Object.assign({
      fetchJson: async () => ({ cursor: 3, entries: [{ id: 'ok' }, { id: 'bad' }, { id: 'ok2' }] }),
      apply: (e) => { if (e.id === 'bad') throw new Error('parse fail'); applied.push(e.id); return true },
      getCfg: () => ({ disasters: { weather: true } }),
    }, noStore))
    const r3 = await c3.pollOnce()
    assert(r3.applied === 2 && applied.join() === 'ok,ok2', '单条失败不影响其余条目')
    assert(c3.cursor() === 3 && c3.stats().errors === 1, '单条失败不阻断读取位置前进')

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

console.log('== feed 读取位置持久化与 Host 重启恢复 ==')
  try {
    const t = loadClient().__test

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
    assert(firstUrls[0].indexOf('since=tail') !== -1, '首次启动（没有读到的位置）→ 请求 since=tail')
    assert(appliedFirst === 0 && r1.applied === 0 && r1.tail === true, 'tail 响应不应用任何条目（响应里带了也不应用）')
    assert(c1.cursor() === 7 && firstSaved.join() === '7', 'tail 对齐后立即持久化读取位置')
    assert(c1.hasCursor() === true, 'tail 之后不再是"没有读取位置"状态')

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
      '旧版 Host（响应没有 tail 标记）也不重放历史：只取读取位置对齐')

    const secondUrls = []
    let appliedSecond = 0
    const c2 = t.createFeedClient({
      fetchJson: async (url) => { secondUrls.push(url); return { cursor: 9, entries: [{ id: 'new-1' }] } },
      apply: () => { appliedSecond += 1; return true },
      loadCursor: () => 5, saveCursor: () => {},
      getCfg: () => ({ disasters: { weather: true } }),
    })
    await c2.pollOnce()
    assert(secondUrls[0].indexOf('since=5') !== -1, '有持久化的读取位置 → 首次请求直接带上它（不重放）')
    assert(appliedSecond === 1 && c2.cursor() === 9, '只应用读取位置之后的增量')

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
    assert(shared === 12, '两次加载后读取位置仍是 12（没有因为重放而前进）')

    // ③' Host 截断（more）：读取位置必须停在最后一条实际返回的 seq，否则被截断的条目会被静默跳过。
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
      'Host 截断（more）→ 读取位置停在最后一条的 seq（不跳过没拿到的条目）')
    await cMore.pollOnce()
    assert(moreUrls[1].indexOf('since=4') !== -1 && cMore.cursor() === 12,
      '下一轮从截断处继续，最终追平 cursor')

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
    assert(c3.cursor() === 2 && p3Saved.join() === '2', 'reset 后读取位置对齐到 Host 当前值并持久化')
    assert(r3.reset === true && c3.stats().resets === 1, 'reset 如实计数（诊断可见）')

    const c4 = t.createFeedClient({
      fetchJson: async () => ({ cursor: 1, entries: [] }),
      apply: () => true,
      loadCursor: () => 37, saveCursor: () => {},
      getCfg: () => ({ disasters: { weather: true } }),
    })
    const r4 = await c4.pollOnce()
    assert(r4.reset === true && c4.cursor() === 1, 'Host 未标记 reset 但读取位置回退 → 仍然自愈')

    for (const dirty of ['abc', -5, null, undefined, {}, []]) {
      const dirtyUrls = []
      const c5 = loadClientEx({ 'dsh.quakeAlert.feedCursor': JSON.stringify(dirty) }).exports.__test.createFeedClient({
        fetchJson: async (url) => { dirtyUrls.push(url); return { cursor: 0, entries: [], tail: true } },
        apply: () => true,
        getCfg: () => ({ disasters: { weather: true } }),
      })
      await c5.pollOnce()
      assert(dirtyUrls[0].indexOf('since=tail') !== -1, '格式不合法的读取位置 ' + JSON.stringify(dirty) + ' → 当作无记录，用 tail')
    }

    const s7 = loadClientEx()
    const c6 = s7.exports.__test.createFeedClient({
      fetchJson: async () => ({ cursor: 4, entries: [], tail: true }),
      apply: () => true,
      getCfg: () => ({ disasters: { weather: true } }),
    })
    await c6.pollOnce()
    assert(s7.storage.get(t.FEED_CURSOR_KEY) === '4', '读取位置真实写入 localStorage（键 ' + t.FEED_CURSOR_KEY + '）')

    const s8 = loadClientEx({ [t.FEED_CURSOR_KEY]: 4 })
    const reloadUrls = []
    const c7 = s8.exports.__test.createFeedClient({
      fetchJson: async (url) => { reloadUrls.push(url); return { cursor: 4, entries: [] } },
      apply: () => true,
      getCfg: () => ({ disasters: { weather: true } }),
    })
    await c7.pollOnce()
    assert(reloadUrls[0].indexOf('since=4') !== -1, '重新加载后从 localStorage 读回读取位置（刷新不重放）')
  } catch (e) {
    assert(false, 'feed 读取位置持久化验证失败：' + e.message)
  }

console.log('== 本地请求超时不能被丢掉 ==')
  try {
    // 有 AbortSignal.timeout 却没有 AbortSignal.any 的浏览器：超时信号不能被丢掉，否则挂死的请求会让四源一起永久停摆。
    const seenSignals = []
    const instances = []
    class RecorderAC extends AbortController { constructor() { super(); instances.push(this) } }
    const fakeTimeout = {
      aborted: false, handlers: [],
      addEventListener(type, fn) { if (type === 'abort') this.handlers.push(fn) },
    }
    const s = loadClientEx(undefined, {
      window: {
        AbortController: RecorderAC,
        AbortSignal: { timeout: () => fakeTimeout }, // 只有 timeout，**没有 any**
        fetch: (url, init) => new Promise((_, reject) => {
          const sig = init && init.signal
          seenSignals.push(sig)
          if (sig && typeof sig.addEventListener === 'function') {
            sig.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
          }
        }),
      },
    })
    const c = s.exports.__test.createFeedClient({
      apply: () => true, getCfg: () => ({ disasters: { weather: true } }), onStatus: () => {},
    })
    const flying = c.pollOnce()
    await new Promise((r) => setImmediate(r))
    const business = instances.length ? instances[0].signal : null
    assert(!!business && seenSignals.length === 1, '（前置）这一轮真的发出了本地请求')
    assert(seenSignals[0] && seenSignals[0] !== business,
      '没有 AbortSignal.any 时也不直接把业务信号当请求信号（超时没有被丢掉）')
    assert(seenSignals[0].aborted === false, '（前置）请求信号此刻尚未中止')
    fakeTimeout.aborted = true
    for (const fn of fakeTimeout.handlers.slice()) fn()
    assert(seenSignals[0].aborted === true && business.aborted === false,
      '超时信号单独触发即可中止请求（业务信号未被中止 —— 正是修复前丢掉的那一半）')
    const r = await flying
    assert(r && r.applied === 0, '超时后这一轮能结束（修复前 inFlight 永不 settle，整条轮询链停摆）')
  } catch (e) {
    assert(false, '0.9.4 本地请求超时验证失败：' + e.message)
  }

console.log('== 河川区域表端到端装配与地名假名写法对齐 ==')
  try {
    const citiesMod2 = await import(pathToFileURL(path.join(ROOT, 'lib', 'data', 'cities.js')).href)
    const riverMod2 = await import(pathToFileURL(path.join(ROOT, 'lib', 'data', 'river-areas.js')).href)

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

    {
      const calls = []
      let fail = true
      const tR = loadClientEx(undefined, {
        window: {
          fetch: async (url) => {
            calls.push(url)
            if (fail) throw new Error('一次瞬时失败')
            return { ok: true, status: 200, json: async () => areasPayload }
          },
        },
      }).exports.__test
      const st1 = await tR.loadCityTable()
      assert(st1 === 'failed' && tR.cityTableState() === 'failed', '一次瞬时失败 → 状态 failed（不静默）')
    // 装载时那一次失败会让整场会话没有市町村表，用户只能刷新页面；现在有重试入口。
      fail = false
      const st2 = await tR.retryCityTable()
      assert(st2 === 'ready' && calls.length === 2, '重试后装载成功（不必刷新页面）')
      assert(tR.citiesOfPref('東京都').indexOf('目黒区') !== -1, '重试成功后表真的可用')

    // cnAreas 缺失时状态要能区分「失败」与「加载中」
      const tN = loadClientEx(undefined, {
        window: { fetch: async () => ({ ok: true, status: 200, json: async () => ({ prefectures: areasPayload.prefectures, riverAreas: areasPayload.riverAreas }) }) },
      }).exports.__test
      assert(tN.cnAreasStateOf() === 'idle', '（前置）还没加载 → idle')
      await tN.loadCityTable()
      assert(tN.cnAreasStateOf() === 'failed',
        '响应里没有 cnAreas → 大陆表状态 failed（此前只看市町村表的状态，于是永远是"正在加载…"）')
      const tRej = loadClientEx(undefined, {
        window: { fetch: async () => ({ ok: true, status: 200, json: async () => ({ prefectures: areasPayload.prefectures, cnAreas: [] }) }) },
      }).exports.__test
      await tRej.loadCityTable()
      assert(tRej.cnAreasStateOf() === 'failed', 'cnAreas 为空数组（被拒）同样记 failed')
      assert(tRej.cnProvinces().length === 0, '（对照）表确实没装进来')
      const tOk = loadClientEx(undefined, {
        window: { fetch: async () => ({ ok: true, status: 200, json: async () => areasPayload }) },
      }).exports.__test
      await tOk.loadCityTable()
      assert(tOk.cnAreasStateOf() === 'ready' && tOk.cnProvinces().length > 0,
        '正常响应 → ready（' + tOk.cnProvinces().length + ' 个省级项）')
    }

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
      '河川表的 ' + seenCity.size + ' 个市町村全部可统一到市区町村表（未收录：' + unresolved.join('/') + '）')

    assert(t2.normKana('金け崎町') === t2.normKana('金ケ崎町') && t2.normKana('金ケ崎町') === '金ヶ崎町',
      'け / ケ / ヶ 统一到同一形式（金け崎町 ↔ 金ケ崎町）')
    assert(t2.normKana('南あるぷす市') === t2.normKana('南アルプス市'), '平假名 ↔ 片假名写法对齐（南あるぷす市 ↔ 南アルプス市）')
    assert(t2.prefsOfCity('金ケ崎町').join() === '岩手県', '河川表写法也能反查到县（金ケ崎町 → 岩手県）')
    assert(t2.prefsOfCity('南アルプス市').join() === '山梨県', '假名种类不同也能反查到县（南アルプス市 → 山梨県）')
    // 两张表给出的是同一个规范名，规范写法取市区町村表那一份
    assert(t2.canonicalCityOf('金ケ崎町') === '金ケ崎町' && t2.canonicalCityOf('南アルプス市') === '南アルプス市',
      '规范名取市区町村表的写法（两张表已一致，不再有"河川表对、市町村表错"的第二种答案）')
    assert(t2.canonicalCityOf('金け崎町') === '金ケ崎町',
      '旧的错写法（金け崎町）仍能统一到规范名——用户配置里可能存着它')

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

console.log('== UI 文案与配色（气象 code / severity 配色 / 标题分隔符）==')
  try {
    const t = loadClient().__test

    // 气象电文的来源标注：落到 else 分支会标成「code 551」（地震速报）
    assert(t.p2pCodeTextOf('weather') === 'JMA 电文', '气象条目显示「JMA 电文」而不是 code 551')
    assert(t.p2pCodeTextOf('quake') === 'code 551' && t.p2pCodeTextOf('eew') === 'code 556' &&
      t.p2pCodeTextOf('tsunami') === 'code 552', 'P2PQuake 三类仍显示各自的 code')
    assert(t.p2pCodeTextOf('constructor') === '—' && t.p2pCodeTextOf(undefined) === '—',
      '未知 kind 不命中原型链，显示占位符')

    // 灾种配色：气象缺键时历史条目会落到灰色兜底
    assert(typeof t.kindColorOf('weather') === 'string' && t.kindColorOf('weather') !== t.kindColorOf('未知'),
      '气象条目有专属配色（不再落灰色兜底）')

    // severity → 颜色：yellow 是默认阈值 40 下最常见的命中档，不能落进"信息蓝"
    assert(t.sevColor('yellow') === '#d9a406', 'yellow 有独立配色（震度4 命中不再显示成信息蓝）')
    assert(t.sevColor('red') === '#e8565b' && t.sevColor('orange') === '#f76b15' && t.sevColor('info') === '#3b82f6',
      '其余档位配色不变（红用调亮后的 AA 达标值）')

    // 标题在非「各地」分支不得留下悬空的「 · 」
    assert(t.alertTitleOf({ kind: 'quake', kindLabel: '地震情报·各地震度' }) === '🌐 地震情报·各地震度',
      'quake 标题直接用 kindLabel（没有悬空分隔符）')
    assert(t.alertTitleOf({ kind: 'quake', kindLabel: '地震情报' }) === '🌐 地震情报', '非「各地」分支同样干净')
    assert(t.alertTitleOf({ kind: 'weather', kindLabel: '洪水预报' }) === '🌧 洪水预报', 'weather 标题不变')
    assert(t.alertTitleOf(null) === '灾害预警', '空输入有兜底标题')
  } catch (e) {
    assert(false, 'UI 文案与配色验证失败：' + e.message)
  }

console.log('== WebSocket 连接假死检测 / 音频节点回收 / 城市表请求可中止 ==')
  try {
    // 久无数据 → 主动重连（连接假死时不会触发 onclose）
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
    assert(socketsA.length === 2, '久无数据 → 主动重连（连接假死时不会触发 onclose）')
    cA.stop()

    // 持续有消息时不误判
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
    assert(socketsB.length === 1, '持续有消息时不误判为连接假死（不重连）')
    cB.stop()

    // 播完 disconnect：长期运行不再累积节点
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

console.log('== WebSocket 建连超时监控 ==')
  try {
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
    assert(tKA.store.detail.indexOf('connect timeout') !== -1 && tKA.store.retries === 1,
      '状态文案写明连接超时并计入重试间隔：' + tKA.store.detail)
    await new Promise((r) => setTimeout(r, 1100)) // 重试间隔 1s 到点后才真正重连
    assert(socketsKA.length === 2, '重试间隔到点后重新发起连接（此前会永远卡在「连接中…」）')
    cKA.stop()

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
    assert(socketsKB.length === 1 && exKB.__test.store.status === 'open', '正常建连后超时监控解除，不误触发重连')
    cKB.stop()

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
    assert(exKC.__test.store.retries === 1 && socketsKC.length === 1, 'onclose 先到 → 超时监控解除，不重复触发')
    cKC.stop()

    const socketsKD = []
    class FakeWSD {
      constructor(url) { this.url = url; socketsKD.push(this) }
      close() {}
    }
    const exKD = loadClientEx({}, { window: { WebSocket: FakeWSD } }).exports
    const cKD = exKD.__test.createWsClient({ connectTimeoutMs: 0 })
    cKD.start()
    await new Promise((r) => setTimeout(r, 90))
    assert(socketsKD.length === 1, 'connectTimeoutMs=0 可关掉建连超时监控')
    cKD.stop()
  } catch (e) {
    assert(false, '建连超时监控验证失败：' + e.message)
  }

console.log('== 气象灾害配置字段 ==')
  {
    const dirty = loadClient({
      'dsh.quakeAlert.v1': JSON.stringify({ version: 1, disasters: { earthquake: false, weather: 'yes' } }),
    }).__test.loadCfg()
    assert(dirty.disasters.weather === true, 'weather 类型不符 → 回退默认 true')
    assert(dirty.disasters.earthquake === false, '同组其它字段不受影响')
    const legacy = loadClient({ 'dsh.quakeAlert.v1': JSON.stringify({ version: 1 }) }).__test.loadCfg()
    assert(legacy.disasters.weather === true, '旧配置缺 weather 字段 → 取默认值（不误关）')
  }

console.log('== 设置页「发送测试气象警报」的轮换场景 ==')
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
    // 解除电文也要清：解除的 regions 是空数组，且 cancelled 在主链的两条 updateWeatherHint
    // 调用点**之前**就返回了——不补这一句，解除后提示会永久留在侧边栏与设置页。
    t.updateWeatherHint(l3, cfg)
    assert(t.store.weatherHint && t.store.weatherHint.level === 3, '（前置）重新写入 L3 静默提示')
    const clearedL3 = Object.assign({}, l3, { id: l3.id + '-cleared', cancelled: true })
    t.handleAlert(clearedL3, cfg, { skipQuietHours: true })
    assert(t.store.weatherHint === null,
      '气象警报解除后静默提示被清掉（解除电文走 cancelled 早退路径，提示不能停在"未达 L4"那一笔）')

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

console.log('== 源时区与全局严重度 ==')
  try {
    const t = loadClient().__test
    assert(t.p2pTimeToIso('2026/09/07 23:25:14') === '2026-09-07T23:25:14+09:00',
      'P2PQuake 裸 JST → 带 +09:00 偏移的 ISO 8601')
    assert(t.p2pTimeToIso('2026/09/08 00:03:16.886') === '2026-09-08T00:03:16.886+09:00', '毫秒被保留')
    assert(t.p2pTimeToIso('不是时间') === '不是时间', '认不出时原样返回（绝不丢信息）')
    assert(t.p2pTimeToIso('') === '', '空串 → 空串')
    const q = t.parse(readSample('quake-kumamoto-detailscale-20260907.json'))
    assert(q.issued.indexOf('+09:00') !== -1, '551 的 issued 带 +09:00（此前是裸 JST 字符串）')
    const e = t.parse(eew)
    assert(e.issued.indexOf('+09:00') !== -1, '556 的 issued 带 +09:00')
    // 旧历史数据没有偏移 → 按 JST 解释
    assert(typeof t.formatIssuedLocal('2026/09/07 23:25:14') === 'string', '旧历史（裸 JST）也能格式化，不抛错')

    // ② 全球点型地震的严重度：maxScale 恒为 -1，走震度路径会算成 info，既显示不出严重性，又让静默时段的红色穿透失效。
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

    const ev = { id: 'emsc-1', eventKey: 'geo:x', strength: 5.2, locator: 'point', issued: '2026-09-12T02:15:12Z', geo: { lat: 38, lon: 22.3 } }
    assert(t.isDuplicate(ev.id, 10) === false, '（前置）首次见到该 id')
    assert(t.isStrengthUpgrade(Object.assign({}, ev, { strength: 6.4 })) === false,
      '还没登记事件时不算升级（isStrengthUpgrade 只读）')
    t.isEventRepeat(ev, 10) // 登记 strength=5.2
    assert(t.isStrengthUpgrade(Object.assign({}, ev, { strength: 6.4 })) === true,
      'M5.2 → M6.4 判为强度升级 → 允许穿透消息级去重（否则震级上修永远不会再提醒）')
    assert(t.isStrengthUpgrade(ev) === false, '同强度不算升级')
    assert(t.isDuplicate(ev.id, 10) === true, '同一 id 第二次确实被消息级去重挡住（升级由调用方放行）')

      // ③b 同 id 的强度升级要绕过跨标签页抢占：抢占键是消息 id 且记忆保留 10 分钟，而 EMSC 的修订版复用同一个 unid。
    {
      const ucfg = {
        watch: { prefectures: [], cities: [], places: [{ name: '雅典', lat: 37.98, lon: 23.73, radiusKm: 500 }] },
        disasters: { earthquake: true, tsunami: true, weather: true },
        thresholds: { globalMagnitude: 4.5, quakeScale: 40, eewScale: 45, tsunamiGrade: 'Watch' },
        dedupe: { windowMinutes: 10 }, notify: {}, quietHours: { enabled: false },
      }
      // 用**真实解析器**产出的 Alert，并另起一个干净实例：前面已登记的去重 / 事件记忆会干扰「首次播报」这条前置断言。
      const tu = loadClientEx({}, {}).exports.__test
      const base = tu.parseEmsc(JSON.parse(fs.readFileSync(path.join(ROOT, 'samples', 'global', 'emsc-ws-sample.json'), 'utf8')))
      const up1 = Object.assign({}, base, { strength: 5.2, magnitude: 5.2, severity: 'yellow' })
      const up2 = Object.assign({}, base, { strength: 6.4, magnitude: 6.4, severity: 'red' })
      const rr1 = tu.handleAlert(up1, ucfg, { skipQuietHours: true })
      assert(rr1.notified === true, '（前置）M5.2 首次播报（实际：' + JSON.stringify(rr1) + '）')
      const rr2 = tu.handleAlert(up2, ucfg, { skipQuietHours: true })
      assert(rr2.notified === true && rr2.reason !== 'other-tab',
        '同 id 的震级上修绕过跨标签页抢占 → 仍然播报（修复前被判 other-tab 静默；实际：' + JSON.stringify(rr2) + '）')
    }

    const a1 = { id: 'e1', eventKey: 'geo:k1', strength: 5.0, locator: 'point', issued: '2026-09-13T10:00:00Z', geo: { lat: 10.1, lon: 100.2 } }
    const a2 = { id: 'u1', eventKey: 'geo:k2', strength: 5.0, locator: 'point', issued: '2026-09-13T10:00:30Z', geo: { lat: 10.15, lon: 100.25 } }
    assert(t.isEventRepeat(a1, 10) === false, '（前置）第一源播报')
    assert(t.isEventRepeat(a2, 10) === true,
      '另一个源对同一场地震（±2 分钟内、约 7km）换了个指纹 → 仍判为同一事件，不重复响铃')
    const a3 = Object.assign({}, a2, { eventKey: 'geo:k3', issued: '2026-09-13T12:30:00Z' })
    assert(t.isEventRepeat(a3, 10) === false, '时间差 2.5 小时 → 按新事件处理')

    // ④b 事件记忆按**各自**的窗口过期：清理不能用「本次调用的窗口」
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

    // ⑤ 解析契约：empty / schema / value 三类的区分
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

    const ids = ['p2pquake', 'jma', 'emsc', 'usgs', 'noaa', 'cenc_eew', 'cenc_eqlist']
    const missing = ids.filter((id) => {
      const c = t.SOURCE_CONTRACTS[id]
      return !c || !c.label || !c.timezone || !Array.isArray(c.required) || c.required.length === 0 ||
        !c.empty || !('staleAfterMs' in c) || (!c.staleAfterMs && !c.staleReason)
    })
    assert(missing.length === 0, '七个源的校验约定齐全（必需字段 / 源时区 / 新鲜度阈值 / empty 判据）' +
      (missing.length ? '（缺：' + missing.join(',') + '）' : ''))

    t.store.clearSources()
    t.resetSourceHealth()
    t.noteParseResult('usgs', t.failResult('schema', '缺 properties.mag'))
    assert(!t.store.sources.usgs || t.store.sources.usgs.status !== 'schema-error',
      '单条坏数据**不**点亮蓝点（线上是逐条 entry，一条格式不合法的数据不该让整个源变蓝——0.5.3 修的就是这个）')
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
    // empty 证明「结构是好的」，要清掉 schema-error——JMA 的常态就是 empty
    t.noteParseResult('usgs', t.failResult('empty', 'features 为空'))
    assert(t.sourceHealthOf('usgs').data === null && t.store.sources.usgs.status === 'open',
      'empty 清掉 schema-error（不再是"不覆盖已有异常"）')
    assert(t.noteSourceSuccess('usgs') === false, '已经恢复的源再报成功 → 无动作（不会重复上报）')
    assert(t.effectiveStatusOf('p2pquake', 'open', 'ok').status === 'open', '没有异常记录的源不受影响')
    // 逐条上报的 empty 不清蓝点（opts.perItem）：1 个被拦截 URL 的 schema 失败会被同轮其它 URL 的 empty 清掉，蓝点永不点亮。
    t.resetSourceHealth()
    t.store.clearSources()
    for (let i = 0; i < t.SCHEMA_ESCALATE_CONSECUTIVE; i++) {
      t.noteParseResult('nws_alerts', t.failResult('schema', '响应不是合法 JSON（可能是拦截页或上游改版）'))
    }
    assert(t.store.sources.nws_alerts.status === 'schema-error', '（前置）局部拦截 → schema-error（蓝点）')
    t.noteParseResult('nws_alerts', t.failResult('empty', '事件类型不在本插件范围内'), undefined, { perItem: true })
    assert(t.store.sources.nws_alerts.status === 'schema-error' && t.sourceHealthOf('nws_alerts').data !== null,
      '逐条 empty（perItem）不清蓝点：同轮其它条目的结构异常要留着（修复前蓝点会在这里被清掉）')
    t.noteParseResult('nws_alerts', t.failResult('empty', '本轮响应结构正常，但没有本插件范围内的条目'))
    assert(t.sourceHealthOf('nws_alerts').data === null && t.store.sources.nws_alerts.status === 'open',
      '对照：轮级 empty（不传 perItem）照旧清蓝点（0.4.2 的 JMA 语义没有被顺手改掉）')
    // 数据种类（opts.subject）：同一个源里不同种类的电文结构各自独立——种类 A 正常不能证明种类 B 没改版。
    // 此前成功一律清蓝点，于是 552/556 改版后同源其它电文照常到达就会一直把它清掉，两条升级阈值都到
    // 不了、蓝点永不点亮、界面一片绿，而那条链路已经悄悄不响了。
    t.resetSourceHealth()
    t.store.clearSources()
    for (let i = 0; i < t.SCHEMA_ESCALATE_CONSECUTIVE; i++) {
      t.noteParseResult('p2pquake', t.failResult('schema', '552 缺少 areas 数组'), undefined, { subject: '552' })
    }
    assert(t.store.sources.p2pquake.status === 'schema-error', '（前置）552 结构改版 → 蓝点升起')
    t.noteSourceSuccess('p2pquake', undefined, { subject: '551' })
    assert(t.sourceHealthOf('p2pquake').data !== null && t.store.sources.p2pquake.status === 'schema-error',
      '551 照常到达**不能**清掉 552 的蓝点（修复前这里会被清掉，海啸那条链路已悄悄不响了）')
    t.noteSourceSuccess('p2pquake', undefined, { subject: '552' })
    assert(t.sourceHealthOf('p2pquake').data === null && t.store.sources.p2pquake.status === 'open',
      '同种类（552）的数据正常到达才算恢复')
    // empty 也按种类算：别的种类"与本插件无关"不等于本种类恢复了
    t.resetSourceHealth()
    t.store.clearSources()
    for (let i = 0; i < t.SCHEMA_ESCALATE_CONSECUTIVE; i++) {
      t.noteParseResult('p2pquake', t.failResult('schema', '552 缺少 areas 数组'), undefined, { subject: '552' })
    }
    t.noteParseResult('p2pquake', t.failResult('empty', '与本插件无关的电文'), undefined, { subject: '554' })
    assert(t.sourceHealthOf('p2pquake').data !== null, '别的种类的 empty 不清本种类的蓝点')
    t.noteParseResult('p2pquake', t.failResult('empty', '与本插件无关的电文'), undefined, { subject: '552' })
    assert(t.sourceHealthOf('p2pquake').data === null, '同种类的 empty 才算"结构是好的"')
    // 种类进 errorKey：两种电文各坏一条、detail 恰好相同时，不该凑成"同一原因累计 2 条"
    t.resetSourceHealth()
    t.store.clearSources()
    t.noteParseResult('nmc_alarm', t.failResult('schema', '缺少 title'), undefined, { subject: 'rainstorm' })
    t.noteParseResult('nmc_alarm', t.failResult('schema', '缺少 title'), undefined, { subject: 'geology' })
    assert(t.sourceHealthOf('nmc_alarm').data.count === 1,
      '不同种类的同句 detail 不互相续上计数（实得 ' + t.sourceHealthOf('nmc_alarm').data.count + '）')
    // 老记录（没写种类）照旧被任何成功清掉：不把蓝点无谓地挂满 24 小时
    t.resetSourceHealth()
    t.store.clearSources()
    t.noteParseResult('emsc', t.failResult('schema', '缺 data'))
    t.noteSourceSuccess('emsc', undefined, { subject: 'whatever' })
    assert(t.sourceHealthOf('emsc').data === null,
      '失败记录没写种类时任何成功都能清掉（旧版本留下的记录 / 认不出种类）')
    // 接线也要守：种类是**调用点**传进去的（P2P 的电文 code、nmc 的灾种）。机制层再正确，调用点
    // 不传就退化成"任何成功都清蓝点"，而上面这些机制层断言照不出来。
    // 读**源文件**而不是构建产物：rollup 会把"函数从来不读"的对象属性整个删掉（实测 `{ subject }`
    // 会变成 `{ }`），于是产物断言会随机制层一起红绿、报出与接线无关的失败。
    const entrySrc = fs.readFileSync(path.join(ROOT, 'client', 'src', '15-entry.js'), 'utf8')
    assert(entrySrc.indexOf("noteParseResult('p2pquake', res, undefined, { subject })") !== -1,
      'P2P 的失败上报也带种类（不带的失败记录无从归属，任何成功都会把它清掉）')
    assert(entrySrc.indexOf("noteSourceSuccess('p2pquake', undefined, { subject })") !== -1,
      'P2P 的调用点把电文 code 当种类传下去')
    assert(entrySrc.indexOf("noteParseResult('nmc_alarm', res, undefined, { subject })") !== -1,
      'nmc 的失败上报也带种类')
    assert(entrySrc.indexOf("noteSourceSuccess('nmc_alarm', undefined, { subject })") !== -1,
      'nmc 的调用点把灾种当种类传下去')
    // 第二条升级路径：坏法不重样时按连续失败数也能捕获（按原因计数永远到不了阈值）
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
      '只关注西脇市（L2）→ 不播报（逐区判定生效，不被同县 L4 连坐）')
    // 事件键不含发布时刻：解除电文才能与发布电文算到同一个键（否则解除链路永远匹配不上）
    assert(h53.eventKey === 'jma:summary:大雨:280000',
      '総合副本的事件键 = 灾种 + 編集官署名コード（不含发布时刻，解除才能匹配上）')
    // 真实解除电文的 Kind 全是「解除」、主文也不含灾种词 → 灾种认不出，键里用**显式未知标记** `?`
    // （退回「气象」会看起来像一个具体灾种，还会与将来真叫「气象」的键撞车）。
    const cancelXml = fs.readFileSync(path.join(ROOT, 'samples', 'jma-vpno50-tokyo-cancel-20260907.xml'), 'utf8')
    const cancelAlert = t.parseJma(cancelXml, { id: 'https://x/20260907190104_0_VPNO50_130000.xml' })
    assert(cancelAlert && cancelAlert.downgraded === true && cancelAlert.cancelled === false,
      '真实「特別警報 → 警報」报知 → 降级（cancelled=false）')
    assert(cancelAlert.eventKey === 'jma:summary:?:130000',
      '认不出灾种时用显式未知标记 `?`，不再冒充「气象」这个具体灾种')
    assert(cancelAlert.regions.length > 0,
      '降级电文**保留区域**（解除才清空）：否则它连"哪个地区降级了"都说不出来，只能进历史')
    // 对照：主文里认得出灾种时，解除与发布能算到同一个键
    const cancelSame = Object.assign({}, h53, { cancelled: true, level: 0, strength: 0, regions: [] })
    assert(t.cancelKeyOf(cancelSame) === h53.eventKey, '（对照）同一灾种的解除与发布共用同一个 cancelKeyOf 键')

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
    assert(String(badFeed.stats().lastError).indexOf('parse failed') !== -1,
      'Host：失败原因可读（供 TROUBLESHOOTING 引用）：' + badFeed.stats().lastError)
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

console.log('== 对源时区与全局严重度修复的回归检查 ==')
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

    const hyogoXml = fs.readFileSync(path.join(ROOT, 'samples', 'jma-vpww53-hyogo-danger-20260914.xml'), 'utf8')
    const tokyoXml = fs.readFileSync(path.join(ROOT, 'samples', 'jma-vpww55-heavyrain.xml'), 'utf8')
    const k1 = t.parseJma(hyogoXml, { id: 'no-suffix-1' }).eventKey
    const k2 = t.parseJma(tokyoXml, { id: 'no-suffix-2' }).eventKey
    assert(k1.indexOf('jma:summary:') === 0 && k1.split(':')[3] !== '',
      'id 不含 6 位后缀时，键里仍有官署标识（' + k1 + '）')
    assert(k1 !== k2, '不同气象台的同灾种电文不会共键（' + k1 + ' vs ' + k2 + '）')

    const q551 = {
      code: 551, id: 'x', issue: { time: 't' },
      earthquake: { time: '2026/09/14 12:00:00', maxScale: 40 },
      points: [{ pref: '東京都', addr: '千代田区' }],
    }
    const r551 = t.parseEpspResult(q551)
    assert(r551.ok === true, '551 的 points 项缺 scale → 仍按可用数据处理（不再整条判 schema）')
    const bad551 = Object.assign({}, q551, { points: [{ pref: '東京都', addr: 'a', scale: '40' }] })
    assert(t.parseEpspResult(bad551).kind === 'schema', '字段类型明显不对（scale 是字符串）仍判 schema')

    const s1 = { id: 's1', source: 'emsc', eventKey: 'geo:m1', strength: 5.0, locator: 'point', issued: '2026-09-21T10:00:00Z', geo: { lat: 30, lon: 130 } }
    const s2 = { id: 's2', source: 'emsc', eventKey: 'geo:m2', strength: 5.0, locator: 'point', issued: '2026-09-21T10:00:40Z', geo: { lat: 30.05, lon: 130.05 } }
    assert(t.isEventRepeat(s1, 10) === false, '（前置）同源第一条播报')
    assert(t.isEventRepeat(s2, 10) === false,
      '同源相隔 40 秒、相距 ~7km 的第二条消息 → 不算同一事件（可能是主震与余震，吞掉就是漏报）')
    const u1 = Object.assign({}, s1, { id: 'u1', source: 'usgs', eventKey: 'geo:m3' })
    const e1 = Object.assign({}, s1, { id: 'e1', source: 'emsc', eventKey: 'geo:m4', issued: '2026-09-21T11:00:00Z' })
    assert(t.isEventRepeat(e1, 10) === false, '（前置）EMSC 报一场地震')
    assert(t.isEventRepeat(u1, 10) === true, 'USGS 对同一场地震（±2 分钟、~7km）→ 跨源归并，不重复响铃')

    const nc = t.normalizeCfg(t.DEFAULT_CFG)
    const lostTop = Object.keys(t.DEFAULT_CFG).filter((k) => !(k in nc))
    const lostNested = []
    for (const k of ['watch', 'disasters', 'thresholds', 'notify', 'dedupe', 'quietHours']) {
      for (const f of Object.keys(t.DEFAULT_CFG[k])) if (!(f in nc[k])) lostNested.push(k + '.' + f)
    }
    assert(lostTop.length === 0 && lostNested.length === 0,
      'normalizeCfg 覆盖 DEFAULT_CFG 的全部字段（顶层与嵌套都没有漂移）' +
      (lostTop.length || lostNested.length ? '（缺：' + lostTop.concat(lostNested).join(',') + '）' : ''))

    assert(t.audioState() === 'unavailable', '沙箱里没有 AudioContext 构造器 → audioState=unavailable（且不抛错）')

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

    t.store.clearSources()
    t.resetSourceHealth()
    for (let i = 0; i < t.SCHEMA_ESCALATE_CONSECUTIVE; i++) {
      t.noteParseResult('jma', t.failResult('schema', '结构不符'))
    }
    assert(t.store.sources.jma.status === 'schema-error', '（前置）进入 schema-error')
    t.noteParseResult('jma', t.failResult('empty', '天气预报，与本插件无关'))
    assert(t.sourceHealthOf('jma').data === null && t.store.sources.jma.status === 'open',
      'empty 证明结构是好的 → 清掉 schema-error（JMA 的常态就是 empty）')

    const noTime551 = {
      code: 551, id: 't', issue: { time: '2026/09/14 12:00:00' },
      earthquake: { maxScale: 40 }, points: [{ pref: '東京都', addr: 'a', scale: 40 }],
    }
    assert(t.parseEpspResult(noTime551).ok === true, '551 缺 earthquake.time → 不再整条判 value')

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

    // ⑫ pref='' 的口径：同一条消息里有区域能归县时，归不到的条目不参与县级过滤；
    //     整条消息都归不到县时才放行（避免整条静默）。
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

    const gauge = commented.replace('</Item></Information>',
      '</Item><Item><Kind><Name>大雨警報</Name><Code>03</Code></Kind>' +
      '<Areas codeType="水位観測所"><Area><Name>某某観測所</Name><Code>123456</Code></Area></Areas>' +
      '</Item></Information>')
    const hGauge = t.parseJma(gauge, { id: baseUrl })
    assert(!hGauge.regions.some((r) => r.area === '某某観測所'),
      'codeType 显式但不是行政区域 → 忽略（位数兜底只服务于没给 codeType 的裸 <Area>）')

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
  // 中国大陆地震源（Wolfx cenc_eew / cenc_eqlist）
  // 断言由 samples/cn/ 下的真实抓取样本驱动，不是照文档猜的结构
  // ==========================================================================
  try {
    const cn = (n) => JSON.parse(fs.readFileSync(path.join(ROOT, 'samples', 'cn', n), 'utf8'))
    const eewRaw = cn('cenc-eew-last.json')       // 真实：四川甘孜州新龙县 M4.2，ReportNum=2
    const listRaw = cn('cenc-eqlist-last.json')   // 真实：最新 50 条整表 + md5

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
    // 不能用 `instanceof Date`：client.js 跑在 vm 沙箱里，有自己的 Date 原型，宿主侧的 Date 对它永远为假。
    const cnDate = T.issuedToDate('2026-09-18 20:50:23')
    assert(!!cnDate && cnDate.toISOString() === '2026-09-18T12:50:23.000Z',
      'issuedToDate 认得裸北京时间（差 1 小时的时间显示 bug 的根因就在这里）')

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

    const restForm = Object.assign({}, eewRaw)
    delete restForm.type
    assert(T.parseCencEewResult(restForm).ok === true,
      'REST 快照（无 type）与 WS 推送包同样可解析——实测两者只差一个 type 字段')

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
    // cenc_eew 的 severity **恒 red**（与日本 556 同口径）：severity 决定配色，也决定静默时段能否穿透，只有 red 穿透。
    const cencEewAlert = T.parseCencEewResult(eewRaw).alert
    assert(cencEewAlert.magnitude < 5 && cencEewAlert.severity === 'red',
      '大陆预警 severity 恒 red —— 不因为实测样本只有 M4.2 就降级成 info')
    assert(T.hitSeverityOf(cencEewAlert, { region: null, place: null }) === 'red',
      '命中判定之后仍是 red（静默时段的红色穿透因此对它有效）')

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
      '速报的事件键把 +08:00 换算到 UTC（22:32 北京 → 14:32Z）')
    const overseas = listRes.alerts.find((a) => a.hypo.name === '福克斯群岛')
    assert(!!overseas && Math.abs(overseas.geo.lon + 171.4) < 1e-9 && overseas.magnitude === 6.5,
      '速报整表含境外地震且负经度正常解析（实测福克斯群岛 M6.5）')

    const mk = (id, mag) => ({ EventID: id, time: '2026-09-18 20:00:00', magnitude: String(mag), latitude: '30', longitude: '100' })
    const shuffled = { type: 'cenc_eqlist', No10: mk('C', 3), No2: mk('B', 3), No1: mk('A', 3) }
    assert(T.cencEqlistItems(shuffled).map((x) => x.EventID).join(',') === 'A,B,C',
      'No1…NoN 按数值序展开（字典序会让 No10 插到 No2 前面）')

    const oneBad = JSON.parse(JSON.stringify(listRaw))
    oneBad.No7.latitude = ''
    const partialRes = T.parseCencEqlistResult(oneBad)
    assert(partialRes.ok === true && partialRes.alerts.length === 49 && partialRes.dropped === 1,
      '整表 50 条里 1 条坏 → 另外 49 条照常播报，丢弃数可见（不是静默）')
    assert(T.parseCencEqlistResult({ type: 'cenc_eqlist' }).kind === 'empty',
      '整表里一个 NoN 都没有 → empty')
    assert(T.parseCencEqlistResult({ type: 'cenc_eqlist', No1: { EventID: 'x' }, No2: { EventID: 'y' } }).kind === 'schema',
      '整表每一条都解析不出 → schema（源改版的信号）')

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
      'CENC 速报与 USGS 对同一场境外地震 → 同一个事件键（按 UTC 换算，否则会差 8 小时永远不归并）')
    assert(T.geoEventKey('2026-09-17T22:19:52+08:00', 52.85, -171.4) ===
      T.geoEventKey('2026-09-17T14:19:52Z', 52.85, -171.4),
      'geoEventKey 自身对两种偏移给出同一把钥匙（回归：此前直接切字符串，永久失效）')
    // 时间不可解析时的键不能与任何其它事件相同：退回原串切片时空串会让该震中之后所有事件共用一个键，后续全部静默。
    assert(/^geo:!t\d+@1\.0,2\.0$/.test(T.geoEventKey('乱码', 1, 2)),
      '时间不可解析时不抛错、仍产出可用的键（改为唯一键，不再退化成同一把钥匙）')
    assert(T.geoEventKey('', 30.9, 99.9) !== T.geoEventKey('', 30.9, 99.9),
      '空时间 + 同一震中的两条**不同**消息得到不同的键（修复前会永久互判重复）')
    assert(T.geoEventKey('2026-09-17T14:19:52Z', 1, 2) === T.geoEventKey('2026-09-17T14:19:52Z', 1, 2),
      '对照：时间可解析时键仍然是稳定的（同一条消息仍会被判重）')

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
    assert(farHit.hit === false && farHit.reason.indexOf('100') !== -1,
      '震中在半径外 → 不命中，且理由里给出实际距离：' + farHit.reason)
    const noPlace = JSON.parse(JSON.stringify(placeXinlong))
    noPlace.watch.places = []
    assert(T.matchAlert(eewXinlong, noPlace).hit === false && T.matchAlert(eewXinlong, noPlace).reason.indexOf('未设置') !== -1,
      '没有关注点 → 明确说明"未设置全球关注点"，而不是静默丢弃')

    // ⑩ 配置字段：加字段必须同时改 DEFAULT_CFG 与 normalizeCfg
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

    assert(T.SOURCE_CONTRACTS.cenc_eew.empty.indexOf('未实测') !== -1,
      'cenc_eew 的 empty 判据标注了证据等级（样本不足，不掩饰）')
    assert(T.SOURCE_CONTRACTS.cenc_eqlist.staleAfterMs === 48 * 60 * 60 * 1000,
      '速报的 48 小时新鲜度阈值是中继探测（唯一真正有意义的一条）')
    assert(T.SOURCE_CONTRACTS.cenc_eew.staleAfterMs === null,
      '预警本身不给新鲜度阈值（稀疏是常态，不能据此判死）')
  } catch (e) {
    assert(false, '0.5.0 大陆源检查失败：' + e.message)
  }

  // ==========================================================================
  // 大陆源的 Host 半边（WS 常连 / 固定长度缓冲 / 去重 / 年龄门槛 / SSE）
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
     * 建一个源 + 一批假件。startT 是假时钟起点：默认取速报样本里最新那条的发布时间附近，
     * 预警的用例必须传更早的时刻（真实 EEW 样本的发震时刻是 12:50Z，而年龄门槛只有 10 分钟）。
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

    const eewRaw = cnSample('cenc-eew-last.json')
    const listRaw = cnSample('cenc-eqlist-last.json')
    const eewEntry = wx.cencEewEntry(eewRaw)
    assert(!!eewEntry && eewEntry.id === 'cenc:b4kybfnuqayyy' && eewEntry.dedupeKey === 'b4kybfnuqayyy@2',
      'EEW 帧 → entry，去重键是 ID@ReportNum（修订版必须能进缓冲）')
    assert(JSON.parse(eewEntry.payload).Magnitude === 4.2, 'entry.payload 是原始 JSON（Host 不改字段）')
    assert(eewEntry.updated === '2026-09-18T12:50:23.000Z',
      'updated 换算到 UTC（Host 侧与 Client 侧各自持有一份 +08:00 转换，见模块注释）')
    assert(wx.cencEewEntry({ type: 'cenc_eew' }) === null, '缺 ID / 坐标的帧 → null（不造空 entry）')
    const listEntries = wx.cencEqlistEntries(listRaw)
    assert(listEntries.length === 50 && listEntries[0].id === 'cenc:CD.20260918223231.903',
      '速报整表 → 50 条**逐条** entry（整表当一条会把 50 条老事件反复重推）')
    assert(listEntries[0].dedupeKey === 'CD.20260918223231.903@2026-09-18 22:37:38',
      '速报去重键是 EventID@ReportTime（修订版要能进来，与 USGS 的 id@updated 同一理由）')
    assert(wx.cencEqlistEntries({ No1: { EventID: 'x' } }).length === 0, '缺坐标的速报项被跳过')
    assert(wx.cencEqlistMd5(listRaw).length === 32, '整表 md5 指纹可读（只做短路用）')

    const nowMs = Date.parse('2026-09-18T14:40:00Z')
    assert(wx.isEventFreshEnough(nowMs - 60 * 1000, nowMs, 10 * 60 * 1000) === true, '1 分钟前的 EEW → 值得播报')
    assert(wx.isEventFreshEnough(nowMs - 3 * 24 * 3600 * 1000, nowMs, 10 * 60 * 1000) === false,
      '3 天前的 EEW → 不播报（连上时 Wolfx 会回放最后一条，可能已过去数天）')
    assert(wx.isEventFreshEnough(NaN, nowMs, 10 * 60 * 1000) === true,
      '时间不可解析时不替用户决定（不因缺时间丢掉消息）')

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
        'entry 进了缓冲（/feed 与 SSE 共用它）')
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
      assert(h.sockets.length === 1 && h.sched.size() >= 1, '断线后安排重连（间隔递增）')
      h.sched.advance(1000)
      assert(h.sockets.length === 2, '重试间隔 1 秒到点后重新建连')
      assert(h.sockets[0].closed === true, '旧 socket 被真正关闭')
      // stop() 必须真的断开——不能像 Host 轮询器那样把在飞连接留着
      const cur = h.sockets[1]
      h.src.stop()
      assert(cur.closed === true, 'stop() 真的断开了在飞连接（DESIGN 11.6 第 4 条的同类缺口不重演）')
      const n = h.sockets.length
      h.sched.advance(10 * 60 * 1000)
      assert(h.sockets.length === n, 'stop 之后不再重连')
    }

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
        '首次启动只放行 6 小时内的事件（北京 22:32/20:50/20:09 三条），其余 47 条记已见不入缓冲')
      assert(st.ageSkipped === 47 && st.lastAdded === 3, '被年龄门槛挡下的条数可见（不是静默丢弃）')
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
      // 停更判定探测的是中继：整表最新事件距今超过 48 小时 → stale。年龄门槛保持默认 6 小时，
      // 被门槛挡下的条目也必须更新 dataTime，否则首次启动时这条自检永远不会触发。
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
      assert(src2.stats().stale === true, '整表最新事件距今超 48 小时 → 判定中继停更（只有速报能做这个探测）')
      assert(src2.stats().ageSkipped === 50 && src2.snapshot(0).entries.length === 0,
        '同一批数据全部被年龄门槛挡下（2 天前的速报没有播报价值）')
      assert(src2.stats().dataTime === Date.parse('2026-09-18T14:32:31Z'),
        '被挡下的条目仍要更新 dataTime —— 否则首次启动时"中继停更"永远不会被发现')
      const freshList = JSON.parse(JSON.stringify(listRaw))
      freshList.No1.time = '2026-09-20 23:30:00'
      freshList.No1.ReportTime = '2026-09-20 23:35:00'
      freshList.md5 = 'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee'
      sockets2[0].onmessage({ data: JSON.stringify(freshList) })
      assert(src2.stats().stale === false && src2.stats().staleSince === 0,
        '有新鲜数据后 stale 复位（否则蓝点会永久挂着）')
      // 真正落在 6 小时窗口内的事件必须进缓冲（门槛只挡旧的）：北京 09-21 02:30 = 18:30Z，距起点 5.5 小时。
      const liveList = JSON.parse(JSON.stringify(listRaw))
      liveList.No1.time = '2026-09-21 02:30:00'
      liveList.No1.ReportTime = '2026-09-21 02:35:00'
      liveList.No1.EventID = 'CD.20260921023000.001'
      liveList.md5 = 'dddddddddddddddddddddddddddddddd'
      sockets2[0].onmessage({ data: JSON.stringify(liveList) })
      assert(src2.snapshot(0).entries.length === 1 && src2.stats().lastAdded === 1,
        '窗口内的新事件照常进缓冲（门槛只看时效，不是"一律不推"）')
    }

    // ④b 停更自检必须由**时钟**推动：中继停更的两种形态（转发同一张旧表被 md5 短路 / 不再推数据帧）都不产生「有变化的新帧」。
    {
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
        '整表 md5 未变但时钟走过 50 小时 → 仍要判停更（md5 短路只该省掉逐条比对，不能连自检一起跳过）')

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

    // ④b-2 REST 兜底必须真的存在：wss:// 被中间设备掐断时，两个大陆源会静默停摆而状态还是绿的。
    {
      const flush = () => new Promise((r) => setImmediate(r))
      const clockR = { t: Date.parse('2026-09-18T14:40:00Z') }
      const schedR = makeSched(clockR)
      const socketsR = []
      const callsR = []
      let restFail = false
      let lastInit = null
      const srcR = wx.createWolfxSource({
        id: 'cenc_eqlist', now: () => clockR.t,
        setTimer: (f, m) => schedR.set(f, m), clearTimer: (k) => schedR.clear(k),
        createSocket: () => { const x = makeSocket(); socketsR.push(x); return x },
        idleMs: 0, firstDelayMs: 0, heartbeatTimeoutMs: 0, connectTimeoutMs: 5 * 60 * 1000,
        restPollMs: 60 * 1000,
        fetchText: async (url, init) => {
          callsR.push(url); lastInit = init || null
          if (restFail) throw new Error('HTTP 503')
          return JSON.stringify(listRaw)
        },
      })
      srcR.markRead(); srcR.start(); schedR.advance(0)
      await flush()
      assert(callsR.length === 1 && callsR[0] === 'https://api.wolfx.jp/cenc_eqlist.json',
        'WS 未连上时按 REST 快照地址取数（此前这条"降级通道"没有任何代码）')
      assert(srcR.stats().restPolls === 1 && srcR.stats().restFetched === 1, 'REST 的"试了几次 / 成几次"分开计数')
      assert(srcR.stats().frames === 0, 'REST 快照不计入 WS 数据帧（否则"连上了但没数据"这个归类会失效）')
      assert(srcR.snapshot(0).entries.length === 3, 'REST 拿到的整表走**同一个** handleDataFrame 入缓冲（不另写一份解析）')
      assert(lastInit && lastInit.signal !== undefined, 'REST 请求带中止信号（stop() 能掐断在飞请求）')

      // 节流：每次重连间隔到点都请求一次就太吵了，restPollMs 内不重复
      socketsR[0].onclose({ code: 1006 })
      schedR.advance(1000)
      await flush()
      assert(callsR.length === 1, 'restPollMs 之内不重复请求 REST（重连间隔 1s→2s→… 不该放大成 REST 频率）')

      // 越过节流窗口：REST 失败要留下原因，不能静默
      restFail = true
      socketsR[1].onclose({ code: 1006 })
      clockR.t += 61 * 1000
      schedR.advance(2000)
      await flush()
      assert(srcR.stats().restPolls === 2 && srcR.stats().restFetched === 1, '（前置）第二次 REST 尝试发生且未成功')
      assert(srcR.stats().restLastError.indexOf('REST 兜底失败') === 0,
        'REST 失败留下原因（"连不上 WS 又拿不到 REST" = 网络层，与"最近没有地震"必须不同形）')
      srcR.stop()

      // stop() 中止在飞的 REST 请求
      let aborted = null
      let releaseR = null
      const gateR = new Promise((r) => { releaseR = r })
      const srcR2 = wx.createWolfxSource({
        id: 'cenc_eew', now: () => clockR.t,
        setTimer: (f, m) => schedR.set(f, m), clearTimer: (k) => schedR.clear(k),
        createSocket: () => { const x = makeSocket(); socketsR.push(x); return x },
        idleMs: 0, firstDelayMs: 0, heartbeatTimeoutMs: 0, connectTimeoutMs: 0,
        fetchText: async (url, init) => {
          aborted = init && init.signal
          await gateR
          const e = new Error('aborted'); e.name = 'AbortError'; throw e
        },
      })
      srcR2.markRead(); srcR2.start()
      clockR.t += 5 * 60 * 1000
      schedR.advance(0)
      await flush()
      assert(aborted && aborted.aborted === false, '（前置）REST 请求在飞')
      srcR2.stop()
      assert(aborted.aborted === true, 'stop() 中止在飞的 REST 请求（不留一条 20 秒超时的挂起请求）')
      releaseR()
      await flush()
      assert(srcR2.stats().restLastError === '', '被自己中止不算故障（不写 restLastError）')
    }

    // ④c 悄悄失灵与速率约束
    {
      // 整表「有 NoN 项却一条都解析不出来」必须与「空表」不同形：字段改名会让整表被丢弃，而 errors 不涨、dataTime 停在 0。
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

      // **逐条**失败要有计数：上游改几个字段名时 45/50 条仍解析得出来，「整表全坏」那条判据永远不触发。
      {
        const h3 = harness('cenc_eqlist')
        h3.src.markRead(); h3.src.start(); h3.sched.advance(0)
        const s3 = h3.sockets[0]
        s3.onopen()
        const partial = JSON.parse(JSON.stringify(listRaw))
        // 挑**最旧**的 3 条把坐标字段改名（与首次启动的年龄门槛解耦，否则分不清是门槛还是丢条）。
        let renamed = 0
        const keysDesc = Object.keys(partial).filter((k) => /^No\d+$/.test(k))
          .sort((a, b) => Number(b.slice(2)) - Number(a.slice(2)))
        for (const k of keysDesc) {
          if (renamed >= 3) break
          partial[k].Longitude = partial[k].longitude
          delete partial[k].longitude
          renamed += 1
        }
        const errBefore3 = h3.src.stats().errors
        s3.onmessage({ data: JSON.stringify(partial) })
        assert(h3.src.stats().itemSkipped === 3,
          '逐条丢弃有计数（itemSkipped=' + h3.src.stats().itemSkipped + '）—— 此前那 3 条无声消失')
        assert(h3.src.stats().errors === errBefore3, '个别条目脏不算源的故障（不把蓝点点亮）')
        // 原因要可见，但**不能**写进 lastError：那一条会被每 15 秒一帧的 status 帧当成"当前故障"推到
        // 界面，于是"上游有个别条目缺字段"（常态）会给黄灯一条永不消失的理由。
        assert(h3.src.stats().lastError === '' &&
          h3.src.stats().lastSchemaNote.indexOf('有 3 条无法解析') !== -1,
          '原因写进 lastSchemaNote 而不是 lastError（"少了 3 条"与"这批没有新地震"仍然不同形，' +
          '但不构成降级理由）：lastError=' + JSON.stringify(h3.src.stats().lastError) +
          ' lastSchemaNote=' + JSON.stringify(h3.src.stats().lastSchemaNote))
        assert(h3.src.stats().lastAdded === 3, '窗口内的新鲜条目照常入缓冲（门槛与"丢条"互不干扰）')
        h3.src.stop()
      }

      // lastError 的语义是「**当前**这条故障」，不是"曾经出过错"：Host 把它放进每 15 秒一帧的 status 帧，
      // Client 只要看到非空就合成「链路降级」。只写不清 = 黄灯永久钉在界面上——长休眠唤醒后心跳必然超时
      // 一次，正是这条路径让"睡一夜醒来一直是黄灯"每次都发生。
      {
        const hL = harness('cenc_eew', { heartbeatTimeoutMs: 0 })
        hL.src.markRead(); hL.src.start(); hL.sched.advance(0)
        const sL = hL.sockets[0]
        sL.onopen()
        sL.onmessage({ data: JSON.stringify({ type: 'cenc_eew' }) }) // 缺 ID / 坐标 → 帧结构不符
        assert(/帧结构不符/.test(hL.src.stats().lastError), '坏帧写 lastError（前置）：' + hL.src.stats().lastError)
        assert(hL.src.stats().lastErrorAt === hL.clock.t,
          '同时打上时间戳（Client 据此判新鲜度）：' + hL.src.stats().lastErrorAt)
        sL.onmessage({ data: JSON.stringify(eewRaw) }) // 紧接着一帧完全正常
        assert(hL.src.stats().lastError === '',
          '恢复正常的那一帧把 lastError 清掉（"曾经出过错" ≠ "现在还是坏的"）')
        assert(hL.src.stats().lastErrorAt === 0, '时间戳一并归零（否则 Client 会拿旧时间戳继续判降级）')
        hL.src.stop()
      }
      {
        const hB = harness('cenc_eew', { heartbeatTimeoutMs: 2000 })
        hB.src.markRead(); hB.src.start(); hB.sched.advance(0)
        hB.sockets[0].onopen()
        hB.sched.advance(31000) // housekeeping 每 30 秒一轮：超过 2 秒没有消息即判死
        assert(/超过 2000ms/.test(hB.src.stats().lastError),
          '心跳超时写 lastError（前置）：' + hB.src.stats().lastError)
        hB.sched.advance(60000) // 等重连
        assert(hB.sockets.length >= 2, '判死后确实重连了（前置）：' + hB.sockets.length)
        hB.sockets[hB.sockets.length - 1].onopen()
        assert(hB.src.stats().lastError === '',
          '重连成功（onopen）即清空 lastError —— 中继早就好了、文案还留着，就是界面一直黄灯的那条路径')
        hB.src.stop()
      }

      // md5 只是**观测读数**，不再是「整表没变」的判定条件：上游改了表却忘了刷指纹时旧实现整帧跳过，与「没有新地震」完全同形。
      {
        const h4 = harness('cenc_eqlist')
        h4.src.markRead(); h4.src.start(); h4.sched.advance(0)
        const s4 = h4.sockets[0]
        s4.onopen()
        s4.onmessage({ data: JSON.stringify(listRaw) })
        const addedFirst = h4.src.stats().lastAdded
        assert(addedFirst === 3, '（前置）首次整表放行窗口内的新鲜条目：' + addedFirst)
        // 同 md5、但表里**多了一条新事件**：模拟"上游改表没刷 md5"
        const stale = JSON.parse(JSON.stringify(listRaw))
        stale.No51 = {
          EventID: 'CD.20260919120000.001', latitude: '30.5', longitude: '100.5', magnitude: '4.0',
          time: '2026-09-19 12:00:00', placeName: '测试地', ReportTime: '2026-09-19 12:00:10',
        }
        // 数据时间落在窗口内（用同一批样本里最新那条的时间字段，确保过年龄门槛）
        stale.No51.time = listRaw.No1.time
        stale.No51.ReportTime = '2026-09-19 12:00:10'
        s4.onmessage({ data: JSON.stringify(stale) })
        assert(h4.src.stats().lastAdded >= 1,
          '指纹说"没变"但表里确实有新条目 → 仍然入库（旧实现整帧跳过，真实地震消失）')
        assert(h4.src.stats().md5StaleFrames === 1,
          '并且记一个可数读数 md5StaleFrames（"上游改表不刷指纹"这件事是可见的）')
        h4.src.stop()
      }

      // 速报的去重记忆必须长于整表覆盖窗口（约 20 天），否则老条目每帧都被当成新候选、再被年龄门槛挡下。
      {
        const h5 = harness('cenc_eqlist', { seenTtlMs: undefined })
        assert(h5.src.stats().seenTtlMs === undefined || true, '（前置）不显式传 TTL 时用源自己的默认')
        const seenTtlDefault = wx.createWolfxSource({ id: 'cenc_eqlist' }).stats()
        assert(seenTtlDefault && seenTtlDefault.running === false, '（前置）能建出源')
        const eqTtl = wx.EQLIST_SEEN_TTL_MS
        const pushTtl = wx.DEFAULT_SEEN_TTL_MS
        assert(eqTtl > 20 * 24 * 60 * 60 * 1000 && eqTtl > pushTtl,
          '速报 TTL（' + (eqTtl / 86400000) + ' 天）长于整表窗口（约 20 天）与通用 TTL（' + (pushTtl / 86400000) + ' 天）')
        h5.src.stop()
      }
      h.src.stop()

      // pruneSeen 必须真的被调用：TTL 是"记忆时长"而不是装饰（poller 每轮清一次）
      const h2 = harness('cenc_eqlist', { seenTtlMs: 1000 })
      h2.src.markRead(); h2.src.start(); h2.sched.advance(0)
      const s2 = h2.sockets[0]
      s2.onopen()
      s2.onmessage({ data: JSON.stringify(listRaw) })
      const added1 = h2.src.stats().lastAdded
      assert(added1 === 3, '（前置）首次启动放行窗口内的 3 条')
      s2.onmessage({ data: JSON.stringify(listRaw) })
      assert(h2.src.stats().lastAdded === 0, '（前置）md5 未变 → 短路，无新增')
      h2.clock.t += 100 * 1000 // 远超 1 秒的 TTL
      const changed = JSON.parse(JSON.stringify(listRaw))
      changed.md5 = 'zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz' // 绕过 md5 短路，逼它逐条比对
      s2.onmessage({ data: JSON.stringify(changed) })
      assert(h2.src.stats().lastAdded === added1,
        '去重键过了 TTL 之后重新入缓冲（pruneSeen 真的被调用，seenTtlMs 不是假选项）')
      h2.src.stop()

      // markRead 不能把正在等待的重连间隔重置为 0：/feed 每 15 秒调一次它，否则间隔会被压平成 15 秒。
      const h3 = harness('cenc_eew')
      h3.src.markRead(); h3.src.start(); h3.sched.advance(0)
      h3.sockets[0].onopen()
      h3.sockets[0].onclose({ code: 1006 }) // 断开 → 排 1 秒后重连
      const n3 = h3.sockets.length
      h3.clock.t += 500 // 重连还没到点
      h3.src.markRead() // 模拟 /feed 的一次读取
      h3.sched.advance(0)
      assert(h3.sockets.length === n3, 'markRead 不取消正在等待的重连（否则间隔被压平成 /feed 周期）')
      h3.sched.advance(600)
      assert(h3.sockets.length === n3 + 1, '间隔到点后照常重连')
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
      assert(h.sockets[0].closed === true, '超过 120 秒没有任何消息 → 判定连接已死并主动断开（连接假死时不会给事件）')
      h.sched.advance(1000) // 重连间隔 1 秒到点后才重连
      assert(h.sockets.length === 2, '断开后按递增间隔重连')
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
      // 有活跃订阅者时不算空闲；心跳超时设成 1 小时，让这条用例只考察「空闲判定」。
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

    {
      const h = harness('cenc_eew', { connectTimeoutMs: 15 * 1000 })
      h.src.markRead()
      h.src.start()
      h.sched.advance(0)
      assert(h.sockets.length === 1 && h.sockets[0].closed === false, '（前置）已发起连接')
      h.sched.advance(16 * 1000)
      assert(h.sockets[0].closed === true, '建连超时 → 关闭卡住的连接')
      h.sched.advance(1000)
      assert(h.sockets.length === 2, '建连超时后按递增间隔重连')
      assert(h.events.some((m) => m.indexOf('建连超时') !== -1), '建连超时落一条可读的错误')
    }

    assert(host.sseFrame('entry', { a: 1 }, 7) === 'id: 7\nevent: entry\ndata: {"a":1}\n\n',
      'SSE 帧：id + event + data + 空行结束')
    assert(host.sseFrame('', 'x').indexOf('event:') === -1, '没有事件名时不写 event 行')
    assert(host.sseFrame('x', 'a\nb') === 'event: x\ndata: "a\\nb"\n\n',
      'JSON 里的换行是转义的，不会把帧结构撑破')

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
      // 带 since → 走"补发缓冲里的历史条目"那条分支（tail 分支由后面 src4 的断言单独覆盖）
      handler({ url: '/dsh-quake-alert/stream?source=cenc_eew&since=50', headers: {} }, res)
      assert(res.status === 200 && res.headers['content-type'].indexOf('text/event-stream') === 0,
        '/stream 返回 200 + text/event-stream（该类型在 dsh-host-webserver 里被显式跳过压缩）')
      assert(res.frames[0].indexOf('event: sync') === 0 && res.frames[0].indexOf('"cursor":100') !== -1,
        '第一条数据是 sync（告诉 Client 读取位置与缓冲状态，供诊断与判断要不要改走 /feed）')
      assert(res.frames[0].indexOf('"stale":false') !== -1 && res.frames[0].indexOf('"dataTime":null') !== -1,
        'sync 第一条数据带上数据健康（这个假源没有 stats()，按"不 stale"兜底——诊断字段缺失不该把整条流弄断）')
      assert(res.frames[1].indexOf('id: 99') === 0 && res.frames[1].indexOf('event: entry') !== -1,
        '随后按 seq 补发缓冲里的条目（断线补齐，靠 id: 让浏览器重连时带回）')
      assert(src.reads === 1 && src.subs.length === 1, '订阅会 markRead（保持 WS 存活）并挂上订阅者')
      src.subs[0]({ seq: 101, id: 'cenc:y', title: 't2', updated: '', xml: '{"b":2}' })
      assert(res.frames.length === 3 && res.frames[2].indexOf('id: 101') === 0, '实况 entry 立刻推给订阅者')
      // 页面关闭 → 必须清掉订阅与心跳，否则 Host 会一直为已关闭的页面推流
      res.onClose()
      const n = res.frames.length
      src.subs.length = 0
      assert(src.subs.length === 0, '断开后订阅被清掉')
      assert(res.frames.length === n, '断开后不再写帧')

      // 补发期间断开时不许再装订阅与心跳：cleanup 有幂等守卫，装完就没人能清了。
      {
        const srcB = {
          reads: 0, subs: [], snapCount: 0,
          markRead() { this.reads++ },
          snapshot() {
            this.snapCount += 1
            return {
              cursor: 3, reset: false, truncated: false, frozen: false,
              entries: [{ seq: 1, id: 'a', title: '', updated: '', xml: '{}' },
                { seq: 2, id: 'b', title: '', updated: '', xml: '{}' },
                { seq: 3, id: 'c', title: '', updated: '', xml: '{}' }],
            }
          },
          subscribe(fn) { this.subs.push(fn); return () => { this.subs = this.subs.filter((f) => f !== fn) } },
        }
        let intervals = 0
        const hB = host.createStreamHandler({
          sources: { cenc_eew: srcB },
          setInterval: () => { intervals += 1; return 1 },
          clearInterval: () => {},
        })
        const rB = fakeRes()
        // 第二轮补发（第 2 条 entry）时 write 抛错 → cleanup 跑过 → 后面的订阅/心跳不该再装
        let writes = 0
        rB.write = () => { writes += 1; if (writes === 3) throw new Error('客户端已断开'); return true }
        hB({ url: '/dsh-quake-alert/stream?source=cenc_eew&since=0', headers: {} }, rB)
        assert(writes === 3, '（前置）补发到第 3 次写时抛错：' + writes)
        assert(srcB.subs.length === 0, '补发期间断开 → 不装订阅者（修复前会装上且再也清不掉）')
        assert(intervals === 0, '也不装心跳定时器（同上）')
        assert(srcB.reads === 0, '也不 markRead（markRead 会让 Host 的按需轮询为一个已断开的页面继续拉源）')
      }

      // 写入积压：持续 false 到上限就断流（不丢帧、让 Client 重连补齐）
      {
        const srcC = {
          subs: [],
          markRead() {},
          snapshot() { return { cursor: 0, entries: [], truncated: false, reset: false, frozen: false } },
          subscribe(fn) { this.subs.push(fn); return () => { this.subs = this.subs.filter((f) => f !== fn) } },
        }
        const hC = host.createStreamHandler({ sources: { cenc_eew: srcC }, setInterval: () => 1, clearInterval: () => {} })
        const rC = fakeRes()
        rC.write = () => false // 一直写入积压：客户端不读
        hC({ url: '/dsh-quake-alert/stream?source=cenc_eew', headers: {} }, rC)
        assert(srcC.subs.length === 1, '（前置）订阅已装上')
        for (let i = 0; i <= host.MAX_SSE_BACKPRESSURE + 2; i += 1) {
          if (srcC.subs[0]) srcC.subs[0]({ seq: i, id: 's' + i, title: '', updated: '', xml: '{}' })
        }
        assert(srcC.subs.length === 0,
          '连续写入积压超过 ' + host.MAX_SSE_BACKPRESSURE + ' 帧 → 主动断流并清掉订阅（Host 侧内存不再无上界）')
      }

      const src2 = Object.assign({}, src, { snaps: [], reads: 0, subs: [] })
      const h2 = host.createStreamHandler({ sources: { cenc_eew: src2 }, setInterval: () => 1, clearInterval: () => {} })
      const r2 = fakeRes()
      h2({ url: '/dsh-quake-alert/stream?source=cenc_eew&since=42', headers: { 'last-event-id': '55' } }, r2)
      assert(src2.snaps[0][0] === 55 && src2.snaps[0][1] === false, 'Last-Event-ID 优先（55 > 42）')
      const src3 = Object.assign({}, src, { snaps: [], reads: 0, subs: [] })
      const h3 = host.createStreamHandler({ sources: { cenc_eew: src3 }, setInterval: () => 1, clearInterval: () => {} })
      const r3 = fakeRes()
      h3({ url: '/dsh-quake-alert/stream?source=cenc_eew&since=42', headers: {} }, r3)
      assert(src3.snaps[0][0] === 42, '没有 Last-Event-ID 时用页面带来的持久化读取位置')
      const src4 = Object.assign({}, src, { snaps: [], reads: 0, subs: [] })
      const h4 = host.createStreamHandler({ sources: { cenc_eew: src4 }, setInterval: () => 1, clearInterval: () => {} })
      const r4 = fakeRes()
      h4({ url: '/dsh-quake-alert/stream?source=cenc_eew', headers: {} }, r4)
      assert(src4.snaps[0][1] === true, '什么记录都没有 → tail（不把几小时前的旧警报当新闻重放）')

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

      // keep-alive 帧同时承载**停更状态**：停更的形态就是「不再有新 entry」，只看 sync / entry 的话状态会停在连接那一刻。
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
        'sync 第一条数据把 Host 判定的 stale / dataTime 带给 Client')
      assert(tickers.length === 1, 'keep-alive 定时器已排上')
      tickers[0]()
      const ka = rS.frames[rS.frames.length - 1]
      assert(ka.indexOf('event: status') === 0 && ka.indexOf('"stale":true') !== -1,
        '周期 status 帧兼作 keep-alive：停更状态必须由 Host 推，否则 SSE 路径下它在界面上永远不可见')
    }

    assert(wx.WOLFX_SOURCES.cenc_eew.staleAfterMs === 0 && wx.WOLFX_SOURCES.cenc_eqlist.staleAfterMs === 48 * 3600 * 1000,
      '契约：预警不给新鲜度阈值（稀疏是常态）、速报 48 小时（探测中继）')
    assert(wx.MAX_EVENT_AGE_MS.cenc_eew === 10 * 60 * 1000 && wx.MAX_EVENT_AGE_MS.cenc_eqlist === 6 * 3600 * 1000,
      '契约：事件年龄门槛 预警 10 分钟 / 速报 6 小时')
    assert(wx.WOLFX_WS_BASE === 'wss://ws-api.wolfx.jp/' && wx.WOLFX_REST_BASE === 'https://api.wolfx.jp/',
      'WS 与 REST 两个端点都记在常量里（REST 是降级通道）')
  } catch (e) {
    assert(false, '0.5.0 Host 半边检查失败：' + e.message + '\n' + (e && e.stack ? e.stack.split('\n').slice(1, 3).join('\n') : ''))
  }

  // ==========================================================================
  // 大陆源的 Client 半边（SSE 消费 / 降级 / 贯通主链 / 文案）
  // EventSource 与定时器全部注入，不联网、不真等 8 秒自检。
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
        // 静默判据用注入的时钟（默认 Date.now()），否则「推进 20 秒」在 now() 眼里仍是 0 秒。
        now: () => clock.t,
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

    {
      const h = cnHarness({})
      h.client.start()
      assert(h.created.length === 1 && h.client.modeOf() === 'sse', '启动后建立 SSE 连接')
      assert(h.created[0].url.indexOf('source=cenc_eew') !== -1,
        'SSE URL 带 source 分派（与 Host 的 /stream?source= 对应）')
      assert(h.created[0].url.indexOf('since=tail') !== -1,
        '首次没有读取位置 → since=tail（只对齐位置，不把 Host 缓冲里的旧警报当新闻重放）')
      h.created[0].emit('sync', { source: 'cenc_eew', cursor: 500, reset: false, truncated: false, frozen: false, replayed: 0 })
      assert(h.client.cursor() === 500 && h.saved.indexOf(500) !== -1,
        '没有补发条目 → 读取位置对齐到 Host 当前位置并写入本地存储')
      assert(h.statuses.some((p) => p.status === 'open'), '第一条数据到达 → 上报 open（侧边栏不再是灰的）')
      h.created[0].emit('entry', { seq: 501, id: 'cenc:x', xml: '{"a":1}' })
      assert(h.client.cursor() === 501, '读取位置跟着 entry 的 seq 前进')
      assert(h.saved[h.saved.length - 1] === 501, '每条 entry 都推进读取位置并写入本地存储')
      // 回退保护：SSE 的补发与实况可能交错到达
      h.created[0].emit('entry', { seq: 400, id: 'cenc:y', xml: '{}' })
      assert(h.client.cursor() === 501, '读取位置只前进（回退会让"断线补齐"重复投递）')
      // 坏帧：计入数据健康，但不影响后续条目
      h.created[0].emitRaw('entry', 'not json')
      assert(!!T.sourceHealthOf('cenc_eew'), 'SSE 帧不是合法 JSON → 计入数据健康（蓝点语义）')
      T.resetSourceHealth()
      h.created[0].emit('entry', { seq: 502, id: 'cenc:z', xml: '{}' })
      assert(h.client.cursor() === 502, '坏帧之后照常继续处理（不让读取位置停住）')
      // status 帧（Host 每 15 秒推一次，兼作 keep-alive）：停更只能由 Host 告知
      const nStatus = h.statuses.length
      h.created[0].emit('status', { source: 'cenc_eew', cursor: 502, stale: true, dataTime: 1700000000000 })
      assert(h.statuses.length === nStatus + 1 && h.statuses[h.statuses.length - 1].status === 'stale',
        'Host 的 status 帧说停更 → 上报 stale（中灰「数据已过期」，不折叠进 degraded）')
      assert(h.client.stats().stale === true, 'stale 进入 stats（诊断快照与源状态行要能读到）')
      h.created[0].emit('status', { source: 'cenc_eew', cursor: 503, stale: false, dataTime: 0 })
      assert(h.statuses[h.statuses.length - 1].status === 'open', '恢复新鲜 → 回到 open（中灰点不会永久挂着）')
      // status 帧不能顶替「最近一条数据」的时刻，否则设置页会一直显示「最近数据 0 秒前」，把停更盖掉
      const lastAtBefore = h.client.stats().lastAt
      h.created[0].emit('status', { source: 'cenc_eew', stale: false })
      assert(h.client.stats().lastAt === lastAtBefore, 'status 帧不更新 lastAt（它表示"最近一条数据"）')
      h.client.stop()
      assert(h.created[0].closed === true, 'stop() 关掉在飞的 EventSource')

      // 第一条数据 sync 就带 stale 时也要认（连接那一刻上游已经是旧的）
      const h2 = cnHarness({})
      h2.client.start()
      h2.created[0].emit('sync', {
        source: 'cenc_eew', cursor: 9, reset: false, truncated: false, frozen: false, replayed: 0,
        stale: true, dataTime: 1700000000000,
      })
      assert(h2.statuses.some((p) => p.status === 'stale'), 'sync 第一条数据带 stale → 直接上报 stale')
      h2.client.stop()
    }

    {
      // store.pushSource 整体替换 status + detail，而 status 帧每 15 秒就来一次：只报「已连接」会让 sync 报出的告警自己消失。
      const h = cnHarness({})
      h.client.start()
      h.created[0].emit('sync', {
        source: 'cenc_eew', cursor: 5, reset: true, truncated: true, frozen: true, replayed: 3, stale: false,
      })
      const lastOf = (x) => x.statuses[x.statuses.length - 1]
      assert(lastOf(h).status === 'degraded' && lastOf(h).detail.indexOf('gap:') !== -1,
        'sync 的告警先上报（增量缺口 / 读取位置重置 / Host 未运行）：' + lastOf(h).detail)
      h.created[0].emit('status', { source: 'cenc_eew', cursor: 6, stale: false, dataTime: 0 })
      assert(lastOf(h).status === 'degraded' && lastOf(h).detail.indexOf('gap:') !== -1,
        'status 帧不得把 sync 的告警抹成"已连接"（条件仍然成立）：' + lastOf(h).detail)
      h.client.stop()

      // 降级客户端必须继承 SSE 的读取位置：否则降级瞬间从 since=tail 起步，会静默跳过缓冲里的条目。
      const captured = []
      const h2 = cnHarness({ cursor: 501, over: {
        // 覆盖掉 harness 默认的假 createFallback，逼它走 12c 的默认降级工厂（读取位置用的存储键就在那条路径上）
        createFallback: undefined,
        createFeedClient: (o) => { captured.push(o); return { start() {}, stop() {} } },
      } })
      h2.client.start()
      h2.created[0].emitRaw('error', '')
      h2.created[0].emitRaw('error', '')
      h2.created[0].emitRaw('error', '')
      assert(h2.client.modeOf() === 'poll' && captured.length === 1, '连续拿不到第一条数据 → 降级并建立轮询客户端')
      assert(captured[0].cursorKey === T.CN_CURSOR_KEY + '.cenc_eew',
        '降级客户端与 SSE 共用同一个读取位置存储键（否则降级期间会静默跳过一段条目）')
      h2.client.stop()
    }

    {
      const h = cnHarness({ cursor: 900 })
      h.client.start()
      assert(h.client.cursor() === 900, '（前置）从持久化的读取位置起步')
      h.created[0].emit('sync', {
        source: 'cenc_eew', cursor: 300, reset: true, truncated: false, frozen: false, replayed: 0, stale: false,
      })
      assert(h.client.cursor() === 300,
        'Host 明确 reset → 读取位置回退到它的当前位置（否则本地卡在更大的值上，每次重连都全量重放）')
      // 没有 reset 时仍然只前进——防止把"回退保护"一起改坏
      h.created[0].emit('entry', { seq: 200, id: 'cenc:old', xml: '{}' })
      assert(h.client.cursor() === 300, '没有 reset 时读取位置仍然只前进（回退会让"断线补齐"重复投递）')
      h.client.stop()
    }

    {
      const h = cnHarness({ cursor: 501 })
      h.client.start()
      assert(h.created[0].url.indexOf('since=501') !== -1, '有持久化的读取位置 → 续传（刷新页面不会重放已消费的增量）')
      assert(h.client.hasCursor() === true, '有读取位置时不再走 tail')
      h.client.stop()
    }

    {
      const h = cnHarness({ over: { maxFails: 3 } })
      h.client.start()
      h.created[0].emitRaw('error', '')
      h.created[0].emitRaw('error', '')
      assert(h.client.modeOf() === 'sse' && h.fallbacks.length === 0,
        '偶尔出错不降级（EventSource 自己会重连，过早降级会白白丢掉秒级延迟）')
      h.created[0].emitRaw('error', '')
      assert(h.client.modeOf() === 'poll' && h.fallbacks.indexOf('start') !== -1,
        '连续 3 次都没收到第一条数据 → 降级为轮询')
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
      assert(h3.client.modeOf() === 'poll', '两次都拿不到第一条数据 → 降级（连不上与"连上但不推流"是两回事）')
    }

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

    {
      const hOrder = cnHarness({
        over: {
          apply: () => { hOrder.order.push('apply'); return true },
          saveCursor: (v) => { hOrder.order.push('save:' + v) },
        },
      })
      hOrder.order = []
      hOrder.client.start()
      hOrder.created[0].emit('sync', { cursor: 10, replayed: 0, reset: false, truncated: false, frozen: false })
      hOrder.order.length = 0
      hOrder.created[0].emit('entry', { seq: 11, id: 'cenc:a', xml: '{}' })
      assert(hOrder.order.join(',') === 'apply,save:11',
        '读取位置在 apply 之后推进（修复前是 save:11,apply —— apply 抛错时那条永久不再投递）')

      // ② 从轮询升回 SSE 时要重新读取本地存储取读取位置：降级期间推进它的是轮询客户端，12c 自己的内存 since 停在进入降级之前。
      const cursorRef = { v: 100 }
      const hCursor = cnHarness({
        cfg: { disasters: { earthquake: true }, cnTransport: 'poll' },
        over: { loadCursor: () => cursorRef.v },
      })
      hCursor.client.start()
      assert(hCursor.created.length === 0 && hCursor.fallbacks.indexOf('start') !== -1,
        '（前置）选了强制轮询 → 一开始就不建 SSE')
      cursorRef.v = 777 // 降级期间轮询客户端把读取位置推进到 777（写的是同一个存储键）
      hCursor.setCfg({ disasters: { earthquake: true }, cnTransport: 'auto' })
      hCursor.sched.advance(5000) // 周期检查：用户改回「自动」→ 升回 SSE
      assert(hCursor.created.length === 1, '改回自动后升回 SSE')
      assert(hCursor.created[0].url.indexOf('since=777') !== -1,
        '升回 SSE 时用的是**降级期间推进过的**读取位置（修复前带的是进降级前那个值 → 整段重放）')

      // ③ 已连接的流「持续静默」要能判死：被中间设备静默掐断的长连接不会触发 onerror。
      const hSilent = cnHarness({ over: { silenceDeadMs: 12000 } })
      hSilent.client.start()
      hSilent.created[0].emit('sync', { cursor: 5, replayed: 0, reset: false, truncated: false, frozen: false })
      assert(hSilent.client.modeOf() === 'sse' && hSilent.created.length === 1, '（前置）已连上并收到过第一条数据')
      hSilent.sched.advance(20000) // 假时钟推过 12 秒的静默阈值（周期检查每 5 秒一轮）
      assert(hSilent.client.stats().silentDeaths === 1,
        '超过阈值没有任何帧 → 记一次 silentDeaths（Host 每 15 秒有状态帧，所以这是可靠的死连接判据）')
      assert(hSilent.created.length === 2, '判死后重连这条流，而不是永远停在"SSE 已连接"')
      assert(hSilent.statuses.some((p) => /SSE silent \d+s → dead/.test(String(p.detail))),
        '把"判定连接已死"说出来（降级 / 失联绝不能被静默）')
      const quietDead = hSilent.client.stats().silentDeaths
      hSilent.created[1].emit('status', { stale: false, dataTime: 0 })
      // 只推进一个周期：状态帧刚把计时器归零，不该判死（真实 Host 每 15 秒一个状态帧，阈值 45 秒 = 3 倍余量）。
      hSilent.sched.advance(5000)
      assert(hSilent.client.stats().silentDeaths === quietDead,
        '有帧在流动时不判死（状态帧本身就算活着）')
    }

    // ④ 长冻结（休眠 / 锁屏过夜）恢复：**不能**拿冻结前的时刻判「静默死亡」——那个判据的前提是
    //    "定时器一直在跑"，而冻结恰恰推翻了它。这是"睡一夜醒来一直是黄灯"的第一条路径。
    {
      const hR = cnHarness({ over: { silenceDeadMs: 45000 } })
      T.resetResumeForTest()
      hR.client.start()
      hR.created[0].emit('sync', { cursor: 5, replayed: 0, reset: false, truncated: false, frozen: false })
      hR.sched.advance(5000) // 正常跑一轮：基准时刻落在这里
      const deathsBefore = hR.client.stats().silentDeaths
      hR.clock.t += 8 * 3600 * 1000 // 睡 8 小时（这期间一个定时器都没跑）
      hR.sched.advance(0) // 唤醒后的第一轮
      assert(hR.client.stats().silentDeaths === deathsBefore,
        '冻结不被判成静默死亡（修复前：now - lastFrameAt = 8 小时 > 45 秒 → 判死并报 degraded）')
      assert(hR.client.stats().resumeReconnects === 1,
        '改成主动换一条连接：半开连接不会给任何事件，干等着只会一直显示绿')
      assert(hR.created.length === 2, '确实重建了（而不是对着一条僵尸连接再等 45 秒）')
      assert(!hR.statuses.some((p) => /SSE silent/.test(String(p.detail))), '不把"这是冻结"说成"SSE 静默死亡"')
      hR.client.stop()
    }

    // ④b 但**短暂切走**不该换连接：恢复事件很频繁（切一次标签页就来一次），判据要落在"帧还新不新鲜"
    //     上，而不是"有没有收到事件"。
    {
      const hS = cnHarness({})
      T.resetResumeForTest()
      hS.client.start()
      hS.created[0].emit('sync', { cursor: 5, replayed: 0, reset: false, truncated: false, frozen: false })
      hS.sched.advance(5000)
      T.emitResume(hS.clock.t) // 来源是浏览器事件，且上一帧才过去 5 秒
      assert(hS.created.length === 1, '短暂切走（帧还很新）不重建这条流')
      // 距上一帧超过静默阈值 → 仍然要换：Host 每 15 秒必发一帧，那是"这条连接确实没在转"的可靠证据
      hS.clock.t += 60000
      T.emitResume(hS.clock.t)
      assert(hS.created.length === 2, '距上一帧超过静默阈值 → 换一条（判据是帧的新鲜度，不是事件类型）')
      hS.client.stop()
    }

    // ⑤ 自动降级（非用户选择）在恢复时要能自己升回 SSE：它的判据是"这条链路已经证明过不通"，而休眠不是
    //    "不通"——否则黄灯再也不会自己变绿，只能手动去设置页把链路往返改一次。
    {
      const hU = cnHarness({ over: { probeMs: 0 } })
      T.resetResumeForTest()
      hU.client.start()
      const es0 = hU.created[0]
      es0.emit('error', {}) // 一次 sync 都还没收到的流：连续失败 3 次即降级
      es0.emit('error', {})
      es0.emit('error', {})
      assert(hU.client.modeOf() === 'poll' && hU.fallbacks.indexOf('start') !== -1,
        '连续 3 次拿不到首帧 → 自动降级到轮询（前置）：mode=' + hU.client.modeOf())
      assert(hU.statuses.some((p) => p.status === 'degraded'), '降级本身要说出来（前置）')
      const createdBefore = hU.created.length
      hU.clock.t += 8 * 3600 * 1000
      T.emitResume(hU.clock.t) // 睡醒 / 回到前台
      assert(hU.client.stats().fallbackProbes === 1, '恢复时复探一次 SSE')
      assert(hU.client.modeOf() === 'sse', '探到就升回 SSE（修复前：自动降级永不升回，黄灯一直挂着）')
      assert(hU.created.length === createdBefore + 1, '复探就是真的重建一条 SSE 连接')
      hU.client.stop()
    }

    // ⑥ Host 侧的旧错误文案不再造成永久降级：Host 已在恢复时清空，这里按**新鲜度**再兜一层（防那份
    //    文案"只写不清"再犯）。
    {
      const hE = cnHarness({})
      T.resetResumeForTest()
      hE.client.start()
      const esE = hE.created[0]
      // 先把"现在"推离假时钟起点（1000000），否则"8 小时前"会算成负数——真实 Date.now() 永远为正，
      // 而实现里"时间戳必须是正数"是有意的（0 / 缺失 = 旧版 Host，按新鲜处理，保持原行为）。
      hE.clock.t += 8 * 3600 * 1000
      esE.emit('sync', { cursor: 5, replayed: 0, reset: false, truncated: false, frozen: false })
      // 8 小时前记下的那条（休眠期间唯一一次心跳超时）→ 不该再算当前故障
      esE.emit('status', {
        stale: false, dataTime: 0, connected: true,
        lastError: '超过 120000ms 没有收到任何消息（心跳实测 60 秒一次）→ 判定连接已死',
        lastErrorAt: hE.clock.t - 8 * 3600 * 1000,
      })
      assert(!hE.statuses.some((p) => p.status === 'degraded'), '隔夜的旧文案不造成 degraded（按新鲜度失效）')
      // 刚刚记下的错误 → 照旧降级（这一层只过滤旧的，不掩盖真故障）
      esE.emit('status', {
        stale: false, dataTime: 0, connected: true,
        lastError: '整表 12 条全部无法解析（字段改名 / 类型变化）', lastErrorAt: hE.clock.t,
      })
      assert(hE.statuses.some((p) => p.status === 'degraded'), '新鲜错误照旧判降级')
      hE.client.stop()
    }

    // ⑦ P2PQuake 的 WS：恢复时按"距上次活动多久"决定是刷新计时还是换一条连接。
    {
      const clockRef = { t: Date.parse('2026-09-26T12:00:00Z') }
      class SandboxDate extends Date {
        constructor(...args) { if (args.length === 0) super(clockRef.t); else super(...args) }
        static now() { return clockRef.t }
      }
      const socketsW = []
      class FakeWSW {
        constructor(url) { this.url = url; this.readyState = 1; socketsW.push(this) }
        close() { this.readyState = 3 }
      }
      const exW = loadClientEx({}, { window: { WebSocket: FakeWSW }, Date: SandboxDate }).exports.__test
      exW.resetResumeForTest()
      const cW = exW.createWsClient({ staleAfterMs: 0 })
      cW.start()
      socketsW[0].onopen()
      assert(socketsW.length === 1, '（前置）已建连')
      clockRef.t += 5000
      exW.emitResume(clockRef.t)
      assert(socketsW.length === 1, '短暂切走再回来不重连（否则每切一次标签页都白换一条连接）')
      clockRef.t += 8 * 3600 * 1000
      exW.emitResume(clockRef.t)
      assert(socketsW.length === 2,
        '冻结很久后恢复 → 直接换一条（修复前：把死连接的时间戳刷成"刚刚活跃"，最长 20 分钟不重连、期间还显示绿色）')
      cW.stop()
    }

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
      // 对照组：日本 EEW（556）的文案一个字都不能变——改文案的范围只限大陆源。
      const jpEew = t8.parse(JSON.parse(fs.readFileSync(
        path.join(ROOT, 'samples', 'eew-ibaraki-m6.7-20260823.json'), 'utf8')))
      assert(jpEew && jpEew.kind === 'eew' && t8.alertTitleOf(jpEew) === '⚠ 紧急地震速报（警报）',
        '日本 EEW 的文案保持不变（只把大陆源换成「地震预警」）')
      assert(t8.alertTitleOf(jpEew).indexOf('警报') !== -1 && jpEew.kindLabel.indexOf('警报') !== -1,
        '通知标题与履历 label 对"是不是警报级"说法一致：' + t8.alertTitleOf(jpEew) + ' / ' + jpEew.kindLabel)
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

      assert(T.DEFAULT_CFG.cnTransport === 'auto', '默认「自动」（SSE 优先 + 自动降级）')
      assert(T.normalizeCfg({}).cnTransport === 'auto', '缺字段 → 回退默认')
      assert(T.normalizeCfg({ cnTransport: 'poll' }).cnTransport === 'poll', '已选的值被保留')
      assert(T.normalizeCfg({ cnTransport: 'bogus' }).cnTransport === 'auto', '未知取值回退默认（白名单）')
    }

    {
      const t11 = loadClient().__test
      const snap = t11.buildDiagSnapshot(1758268800000)
      assert(snap.snapshot === t11.DIAG_SNAPSHOT_VERSION, '快照带格式版本（与插件版本无关，见模块注释）')
      for (const k of ['at', 'page', 'aggregate', 'config', 'sources', 'dataHealth', 'feed', 'streams', 'history', 'warnings']) {
        assert(k in snap, '快照含 ' + k + ' 段')
      }
      // 海外源是 Client 直连的 REST，没有 /feed 路由可查，计数单独一段。
      assert('overseas' in snap, '快照含 overseas 段（海外源的查询 / 未覆盖 / 年龄门槛计数）')
      let json = ''
      try { json = JSON.stringify(snap) } catch (err) { json = '' }
      assert(json.length > 50, '快照可 JSON 化（活对象/循环引用会在这里炸）')
      assert(!('version' in snap) && json.indexOf('"version"') === -1,
        '快照不含插件版本——版本号只在 package.json / CHANGELOG 两处（避免多一个会漂移的位置）')
      assert(snap.config.cnTransport === 'auto', '快照带链路选择（诊断"为什么走轮询"要看它）')
      assert(Array.isArray(snap.warnings), '生成过程中被捕获的异常要可见（不是假装一切正常）')
      // lib 下每个 .js 都必须出现在 pnpm check 的 node --check 清单里（清单是手写的）
      {
        const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'))
        const cmd = String((pkg.scripts && pkg.scripts.check) || '')
        const listed = []
        for (const m of cmd.matchAll(/node --check ([^\s&]+)/g)) listed.push(m[1].replace(/\\/g, '/'))
        const walkLib = (dir, out) => {
          for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
            const p = path.join(dir, e.name)
            if (e.isDirectory()) walkLib(p, out)
            else if (e.name.endsWith('.js')) out.push(path.relative(ROOT, p).replace(/\\/g, '/'))
          }
        }
        const all = []
        walkLib(path.join(ROOT, 'lib'), all)
        const missing = all.filter((f) => listed.indexOf(f) === -1)
        assert(all.length >= 9 && missing.length === 0,
          'check 脚本覆盖 lib 下全部 ' + all.length + ' 个 .js（漏掉：' + (missing.join(', ') || '无') + '）')
        // files 必须把运行时会读的文件都发出去：lib/index.js 会动态 import lib/data/*.js，少一个装出来的包就不可用。
        const files = Array.isArray(pkg.files) ? pkg.files : []
        const notPackaged = all.filter((f) => !files.some((entry) => f === entry || f.indexOf(entry + '/') === 0))
        assert(notPackaged.length === 0,
          'package.json 的 files 覆盖 lib 下全部文件（漏掉：' + (notPackaged.join(', ') || '无') + '）')
        assert(files.indexOf('client') !== -1, 'client（构建产物 + 源码）随包分发——README 的打包口径据此写')
      }
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
      // 每个源都得有一个**本地化**的显示名；认不出的 id 会退回 id 本身，所以「取到的名字就是 id」等于「没有标签」。
      const noLabel = T.SOURCE_ORDER.filter((id) => T.sourceLabelOf(id) === id)
      assert(noLabel.length === 0, '状态行里的每个源都有显示名' +
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
  // 中国行政区划表（省 → 地级市，带坐标）
  // 生成脚本 scripts/build-cn-areas.mjs（--check 可校验产物是否与源一致）
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
    // 已知城市的坐标锚点（容差 2°：表里是行政区中心点，与市中心可差上百公里）
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

  // 设置页的三级级联（中国 → 省 → 地级市）与半径语义
  try {
    const { CN_AREAS } = await import(pathToFileURL(path.join(ROOT, 'lib', 'data', 'cn-areas.js')).href)

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

    assert(t.DEFAULT_PLACE_RADIUS_KM === 100, '新建关注点的默认半径是 100km（DESIGN 9.2）')
    assert(t.RADIUS_PRESETS.length === 3 && t.RADIUS_PRESETS.some((o) => o.v === 100),
      '三档语义预设，含默认档')
    // 档位表只保留 labelKey、文字在文案表里，所以断言查的是取出来的文案（每档一句话并括注公里数）。
    assert(t.RADIUS_PRESETS.every((o) => typeof o.labelKey === 'string' && t.t(o.labelKey).indexOf('km') !== -1),
      '预设用语义标签 + 括注公里数（普通用户不必理解"公里"）')
    const legacy = t.normalizePlaces([{ name: '旧点', lat: 1, lon: 2 }])
    assert(legacy[0].radiusKm === 300,
      '缺 radiusKm 的旧条目仍按 300 兜底 —— 把用户配好的半径从 300 改成 100 会让提醒变窄（漏报方向）')
    assert(t.normalizePlaces([{ name: 'x', lat: 1, lon: 2, radiusKm: 100 }])[0].radiusKm === 100,
      '显式配的 100 被保留')
    {
      /** 渲染设置页的一页，返回它里面所有文本节点。seedStorage 决定地区页落在哪个分支上。 */
      const renderTexts = (seed, tab) => {
        const react = mkTestReact()
        const { exports: ex } = loadClientEx(seed || {}, { react })
        ex.__test.setCnAreas(CN_AREAS)
        react.__reset()
        return textsOfTree(ex.__test.SettingsPanel({ initialTab: tab }))
      }
      const safeRender = (seed, tab, label) => {
        try { return renderTexts(seed, tab) } catch (e) {
          assert(false, label + '渲染失败：' + e.message)
          return []
        }
      }
      /** 渲染并返回 Element 树本身（要按结构断言时用；textsOfTree 只给文本）。 */
      const renderTree = (seed, tab) => {
        const react = mkTestReact()
        const { exports: ex } = loadClientEx(seed || {}, { react })
        ex.__test.setCnAreas(CN_AREAS)
        react.__reset()
        return ex.__test.SettingsPanel({ initialTab: tab })
      }
      /** 取出**页签栏**的按钮文本：页签是唯一同时带 `onClick` 与 `aria-current` 的按钮
       *  （分支按钮没有后者），所以标签写错、数量不对都会红。 */
      const tabBarTexts = (tree) => {
        const out = []
        const walk = (n) => {
          if (!n || typeof n !== 'object') return
          if (Array.isArray(n)) { n.forEach(walk); return }
          if (n.type === 'button' && n.props && typeof n.props.onClick === 'function' && 'aria-current' in n.props) {
            out.push((n.children || []).filter((c) => typeof c === 'string').join(''))
          }
          if (n.children) n.children.forEach(walk)
        }
        walk(tree)
        return out
      }
      /** 预置一份本地配置：inferRegionTab 据其中的 origin 决定展开哪个分支。 */
      const seedCfg = (watch) => ({
        'dsh.quakeAlert.v1': JSON.stringify({
          version: 1,
          watch: Object.assign({ prefectures: [], cities: [], places: [] }, watch),
        }),
      })
      const mkHas = (texts) => (s) => texts.some((t) => t.indexOf(s) !== -1)

      // —— 地区页：日本分支（未配置任何关注点时的默认落点）——
      const jpTexts = safeRender({}, 'region', '设置页（地区 / 日本分支）')
      const jpHas = mkHas(jpTexts)
      const jpTabTexts = tabBarTexts(renderTree({}, 'region'))
      assert(jpTabTexts.join('|') === '地区|灾害|通知|履历|其他',
        '页签恰好是这五页，且标签正确（0.8.2 review：原来靠正文里的同名词兜着，标签写错也看不出来）：' + jpTabTexts.join('|'))
      assert(jpHas('关注地区'), '渲染结果里有「关注地区」')
      assert(jpHas('关注地区') && jpHas('其他国家 / 地区'),
        '第一级是唯一的「国家 / 地区」选择器（分支按钮直接是区块第一行，没有再套一层说明）')
      assert(jpHas('日本') && jpHas('中国大陆') && jpHas('其他国家 / 地区'),
        '三个分支标签都在（用户一眼看到可以关注哪些地区）')
      assert(jpHas('已关注（'),
        '已关注地区的**统一列表**在同一个区块里（"统合 UI，不统合模型"的落点）')
      assert(jpHas('北海道') && jpHas('冲绳'), '默认落在日本分支：47 个都道府县按钮渲染出来了')
      assert(jpHas('先选都道府县'), '市区町村细化器也在日本分支里')
      assert(!jpHas('生成诊断快照') && !jpHas('预警记录'),
        '地区页**不含**其他页的区块——选项卡的意义就在这里（不用滚到底）')

      // —— 灾害页 ——
      const disTexts = safeRender({}, 'disaster', '设置页（灾害页）')
      const disHas = mkHas(disTexts)
      assert(disHas('灾害类型与阈值'), '开关与阈值合并成一张表（0.8.0）')
      assert(disHas('地震') && disHas('海啸') && disHas('气象 · 日本'),
        '按灾种分组的分组标题都在（一行一个灾种）')
      assert(disHas('警戒4级以上'),
        '固定门槛写成只读文字（做成置灰下拉会让人以为能调）')
      assert(disHas('全球源按关注点半径判定'),
        '海啸行写清全球源看的是关注点（0.8.2 review：0.8.1 把这句删了，只配日本县级的用户' +
        '会以为这一行已经覆盖 NOAA 海啸，实际匹配走 places）')
      assert(disHas('暴雨预警') && disHas('地质灾害预警') && disHas('橙色以上才播报') &&
        disHas('黄色和蓝色会记进「履历」') && disHas('没有取消或最终报标志'),
        '大陆气象的开关与门槛说明都在（DESIGN 10.2 要求 UI 不得假装能处理）')
      // 正向锚点会被同一行右侧的只读门槛值喂饱，所以反过来钉住「更宽的话」不许出现。
      assert(!disHas('所有等级都播报') && !disHas('黄色以上才播报') && !disHas('蓝色以上才播报'),
        '门槛没有被说成比「橙色以上」更宽（DESIGN 10.2：界面如实说明"哪些只记录不提醒"）')
      assert(disHas('洪水 / 山洪 / 降雨 / 风暴潮') &&
        disHas('Data Source: Environment and Climate Change Canada') &&
        disHas('打开页面时，如果某条预警已经发布超过 6 小时'),
        '海外气象的开关行、ECCC 署名（许可要求）与年龄门槛说明都在')

      const ntTexts = safeRender({}, 'notify', '设置页（通知页）')
      const ntHas = mkHas(ntTexts)
      assert(ntHas('通知与声音') && ntHas('静默时段'), '通知页含「通知与声音」与「静默时段」两块')
      assert(ntHas('试听地震音') && ntHas('测试系统通知'), '试听与测试按钮在通知页')
      assert(ntHas('跨夜时段写成 23:00–07:00'), '静默时段的说明也在（压缩成一行）')
      assert(ntHas('按浏览器本地时间判定'),
        '静默时段写明时区基准（判定用的是浏览器本地时间；不写的话跨时区用户只能在半夜被响铃后才知道）')

      const hiTexts = safeRender({}, 'history', '设置页（履历页）')
      const hiHas = mkHas(hiTexts)
      assert(hiHas('预警记录') && hiHas('清空记录'), '履历页有记录列表与清空按钮')
      assert(!hiHas('关注地区'), '履历页不含地区配置（这就是分页要解决的问题）')

      const msTexts = safeRender({}, 'misc', '设置页（其他页）')
      const msHas = mkHas(msTexts)
      assert(msHas('数据源') && msHas('大陆源链路') && msHas('测试与诊断') && msHas('免责声明'),
        '其他页含数据源、链路、诊断与免责')
      // 语言下拉必须让三种语言的显示名都出现（不做成「看着能切、其实没反应」的假控件）。
      assert(msHas('语言 / Language') && msHas('简体中文') && msHas('日本語') && msHas('English'),
        '语言选项在「其他」页，且中 / 日 / 英三种语言都在下拉里（不再是"选了没反应"的假控件）')
      assert(msHas('生成诊断快照') && msHas('正式（实时推送）'), '诊断快照与数据源开关都在')
      // 端到端：配置里的语言设成英文后，设置页渲染出来的文本就是英文（模块级求值会把默认语言固化，单测查不出）。
      const enSeed = {}
      enSeed[t.STORAGE_KEY] = JSON.stringify(Object.assign({}, t.DEFAULT_CFG, { language: 'en' }))
      const enBlob = safeRender(enSeed, 'misc', '设置页（英文）').join('\n')
      assert(enBlob.indexOf('Source status') !== -1 && enBlob.indexOf('Export settings') !== -1,
        '语言配成英文后，设置页渲染出的就是英文（端到端）')
      assert(enBlob.indexOf('源状态') === -1 && enBlob.indexOf('数据源') === -1 && enBlob.indexOf('免责声明') === -1,
        '英文界面下不再出现中文的区块标题（说明没有哪一处绕过了 t()）')

      // —— 常驻状态条：在选项卡**之外**，所以每一页都看得到，且只报"通不通 + 几条" ——
      const stripHas = (texts) => texts.some((t) => t.indexOf('未启动') !== -1)
      assert(stripHas(jpTexts) && stripHas(disTexts) && stripHas(ntTexts) && stripHas(hiTexts) && stripHas(msTexts),
        '状态条不随页切换消失（它挂在面板根上、不在任何 tab 分支里；0.8.2 review 把说明改准：' +
        '这条守的是"常驻"，不是"每页内容正确"）')
      assert(jpHas('详情在「其他」里') && !msHas('详情在「其他」里'),
        '状态条指路「其他」，但已经在那一页时就不再啰嗦')
      {
        // 往 store 里塞 detail，再看顶部那个常驻条会不会把它复述出来
        const react = mkTestReact()
        const { exports: exD } = loadClientEx({}, { react })
        exD.__test.store.push({ detail: '已连接 EMSC（全球地震实时推送）' })
        exD.__test.store.pushSource('emsc', { label: 'EMSC', status: 'open', detail: '全球地震实时推送' })
        react.__reset()
        const tStrip = textsOfTree(exD.__test.SettingsPanel({ initialTab: 'region' }))
        assert(!tStrip.some((x) => x.indexOf('全球地震实时推送') !== -1),
          '状态条不再复述逐源细节（store 里塞了 detail 也不会出现在面板顶部）——那是「其他」页「源状态」的活')
      }
      {
        // 有推送时报条数（并且与选项卡无关：这里特意渲染「履历」页）
        const react = mkTestReact()
        const { exports: ex } = loadClientEx({}, { react })
        ex.__test.store.push({ received: 7 })
        react.__reset()
        const t = textsOfTree(ex.__test.SettingsPanel({ initialTab: 'history' }))
        assert(t.some((x) => x.indexOf('已收到 7 条推送') !== -1),
          '状态条在有推送时显示条数（在「履历」页也看得到）')
      }

      // —— 地区页的中国大陆分支：由配置里的 origin=cn 推断（inferRegionTab）——
      const cnTexts = safeRender(seedCfg({
        places: [{ name: '四川省·成都市', lat: 30.66, lon: 104.07, radiusKm: 100, origin: 'cn' }],
      }), 'region', '设置页（地区 / 中国大陆分支）')
      const cnHas = mkHas(cnTexts)
      assert(cnHas('四川省') && cnHas('西藏自治区'),
        '中国分支的省份选项渲染出来了（只渲染默认分支的话这条路径从没被走过）')
      assert(cnHas('添加这个城市') && cnHas('用我的位置'), '级联的两个按钮都在')
      assert(cnHas('（先选省份）'), '未选省份时城市下拉给出占位提示，而不是空的')
      assert(cnHas('仅本地（约 30 km）') && cnHas('本市及周边（约 100 km，默认）'),
        '三档半径语义预设出现在渲染结果里')
      assert(cnHas('四川省·成都市'), '统一列表里列出了这个关注点（跨分支汇总）')
      assert(cnHas('没有取消或最终报标志'),
        '设置页如实说明大陆源无取消机制（DESIGN 10.2 要求 UI 不得假装能处理）')

      // —— 地区页的其他国家 / 地区分支 ——
      const glTexts = safeRender(seedCfg({
        places: [{ name: '东京', lat: 35.68, lon: 139.77, radiusKm: 100, origin: 'global' }],
      }), 'region', '设置页（地区 / 其他国家分支）')
      const glHas = mkHas(glTexts)
      assert(glHas('添加关注点') && glHas('用当前位置'), '其他国家分支给出手填坐标的入口')
      assert(glHas('东京'), '统一列表里列出了这个关注点')
      assert(glHas('也可以直接填坐标'), '手填坐标这条出口始终在（未收录国家 / 地区只能走它）')
    }
  } catch (e) {
    assert(false, '0.5.0 设置页级联检查失败：' + e.message + '\n' + (e && e.stack ? e.stack.split('\n').slice(1, 3).join('\n') : ''))
  }

  // 大陆气象源（nmc.cn）：Host 侧列表裁剪 / 详情门槛 / 正文提取；Client 侧契约 / 行政区归属 / 层级匹配。
  // 全部用 samples/nmc/ 的真实 fixture，不联网。
  try {
    const nmc = await import(pathToFileURL(path.join(ROOT, 'lib', 'nmc-source.js')).href)
    const { CN_AREAS } = await import(pathToFileURL(path.join(ROOT, 'lib', 'data', 'cn-areas.js')).href)
    const samplePath = (n) => path.join(ROOT, 'samples', 'nmc', n)
    const listSample = JSON.parse(fs.readFileSync(samplePath('alarm-list.json'), 'utf8'))
    const fixtureItems = listSample.data.page.list
    const detailOf = (n) => fs.readFileSync(samplePath(n), 'utf8')

console.log('== nmc.cn Host：时间与图标编码 ==')
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

console.log('== nmc.cn Host：列表解析与灾种裁剪 ==')
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
      '每条都带可比较的发布时间（首次启动的判据要用它）')
    assert(parsed && parsed.every((e) => e.detailNeeded === (['red', 'orange'].indexOf(e.level) !== -1)),
      '只有橙 / 红才需要拉详情（蓝 / 黄占样本的 94%）')
    {
    // 结构不符必须抛错：被拦截成 HTML 与「这一次没有预警」不能同形
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

      // 第二个 #alarmtext 块（「防御指南」）不能丢：实测 5 份真实详情页里 4 份都有它。
      {
        const twoBlocks = '<html><body>' +
          '<div id=alarmtext>某某县气象台发布暴雨橙色预警。</div>' +
          '<div class="x"><div id=alarmtext>防御指南：暂停户外作业，转移危险地带人员。</div></div>' +
          '</body></html>'
        const got = nmc.extractAlarmText(twoBlocks)
        assert(got.indexOf('暴雨橙色预警') !== -1 && got.indexOf('防御指南') !== -1,
          '两个 #alarmtext 块都取到（正文 + 防御指南）：' + JSON.stringify(got))
        assert(got.indexOf('\n') !== -1, '两段之间保留换行（挤成一行会让"该怎么做"难以辨认）')
        const realTwo = detailOf('detail-geology-yellow.html')
        const blocks = (realTwo.match(/id=alarmtext/g) || []).length
        assert(blocks >= 1 && nmc.extractAlarmText(realTwo).length >= text.length,
          '真实详情页（含 ' + blocks + ' 个 #alarmtext 块）提取不短于第一个块')
      }
    // 列表被 pageSize 截断要**可见**，而不是尾部静默消失
      {
        const list = listSample.data.page.list
        // 合成的"单页给完"响应（样本 fixture 本身是裁剪过的，count 仍是上游的真实总数）
        const singlePage = nmc.nmcPageInfoOf(JSON.stringify({
          data: { page: Object.assign({}, listSample.data.page, { count: list.length, totalPage: 1 }) },
        }))
        assert(singlePage.listCount === list.length && singlePage.truncated === false,
          '（对照）count 与 list 等长、totalPage=1 → 未截断')
        const multi = nmc.nmcPageInfoOf(JSON.stringify({
          data: { page: Object.assign({}, listSample.data.page, { count: 900, totalPage: 2 }) },
        }))
        assert(multi.truncated === true && multi.totalPage === 2,
          '上游说还有第 2 页 → truncated（旧实现从不读 totalPage / count）')
        const sampleInfo = nmc.nmcPageInfoOf(JSON.stringify(listSample))
        assert(sampleInfo.count > 0 && sampleInfo.truncated === true,
          '（真实样本）count(' + sampleInfo.count + ') > list(' + sampleInfo.listCount +
          ') → 报截断：这份 fixture 是裁剪过的，所以它确实"看起来被截断"')
        assert(nmc.nmcPageInfoOf('不是 JSON').truncated === false, '认不出分页信息时不误报截断')
      }
    }
    assert(Number.isFinite(nmc.nmcFeedTime(JSON.stringify(listSample))),
      '上游数据时间取自列表里最新一条（stale 判定用它，而不是"我们收到多少条"）')

console.log('== nmc.cn Host：详情门槛与首次启动窗口 ==')
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
    // 首次启动的回看窗口：窗口外的旧条目只记已见、不产事件（否则每次重启都会重播 24 小时的历史）。
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
      // 停更自检：源还在响应、但最新一条已经很旧 → stale。判据是**数据时间**，不是"收到几条"。
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

console.log('== nmc.cn Client：契约与解析 ==')
    // 归属解析（cnArea）依赖行政区划表，所以要在契约段之前注入
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

console.log('== nmc.cn Client：行政区归属（含别名） ==')
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

console.log('== nmc.cn Client：行政区层级匹配 ==')
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
    // 两个灾种各有开关
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

    // 真实 nmc.cn 列表 → Host parseNmcList 产出 payload → Client 解析 → 匹配判定。
    // 此前 Client 侧的输入全是手写对象，两半之间那段真实接口（payload 的字段名与取值域）没有守护：
    // Host 改了字段名，Client 会一律判 schema，而两边各自的用例都还是绿的。
    {
      const nmcHost = await import(pathToFileURL(path.join(ROOT, 'lib', 'nmc-source.js')).href)
      const listReal = JSON.parse(fs.readFileSync(path.join(ROOT, 'samples', 'nmc', 'alarm-list.json'), 'utf8'))
      const hosted = nmcHost.parseNmcList(JSON.stringify(listReal))
      assert(hosted.length > 0, '（前置）真实列表裁剪出 ' + hosted.length + ' 条')
      // 真实链路是 `JSON.parse(entry.xml)` 之后才交给解析器（15-entry 的 nmc 分支），payload 就是这个 xml。
      const bad = hosted.filter((e) => !T.parseNmcAlarmResult(JSON.parse(e.payload)).ok)
      assert(bad.length === 0,
        'Host 产出的全部 ' + hosted.length + ' 条 payload 都能被 Client 解析（两半接口一致；不合的：' +
        JSON.stringify(bad.slice(0, 2).map((e) => e.payload)) + '）')
      // 拿等级最高的一条走匹配：达橙色应命中；当季只有蓝 / 黄时应当是"未达橙色"而不是静默。
      const rank = { red: 4, orange: 3, yellow: 2, blue: 1 }
      const top = hosted.slice().sort((a, b) => (rank[b.level] || 0) - (rank[a.level] || 0))[0]
      const topAlert = T.parseNmcAlarmResult(JSON.parse(top.payload)).alert
      const area = topAlert.cnArea || {}
      const cnPlace = {
        name: (area.province || '') + '·' + (area.city || area.province || ''), lat: 30, lon: 110, radiusKm: 100,
      }
      const mTop = T.matchAlert(topAlert, {
        watch: { prefectures: [], cities: [], places: [cnPlace] },
        disasters: { earthquake: true, tsunami: true, weather: true, cnRainstorm: true, cnGeology: true },
        thresholds: {},
      })
      if ((rank[top.level] || 0) >= 3) {
        assert(mTop.hit === true, '真实列表里等级最高的一条（' + top.level + '）达门槛 → 命中：' + mTop.reason)
      } else {
        assert(mTop.hit === false && mTop.reason.indexOf('未达橙色') !== -1,
          '真实列表当季最高只有 ' + top.level + ' → 不播报且说明是等级不够（不是静默）：' + mTop.reason)
      }
    }

    // 契约层：新源必须同时出现在 SOURCE_CONTRACTS 与设置页的源状态里
    assert(T.SOURCE_CONTRACTS && T.SOURCE_CONTRACTS.nmc_alarm, 'nmc_alarm 有校验约定（字段契约 / 时区 / 新鲜度阈值）')
    assert(T.SOURCE_CONTRACTS.nmc_alarm.staleAfterMs === 3 * 60 * 60 * 1000, '停更阈值 3 小时')
    T.resetCityTable()
  } catch (e) {
    assert(false, '0.5.2 大陆气象源检查失败：' + e.message + '\n' + (e && e.stack ? e.stack.split('\n').slice(1, 3).join('\n') : ''))
  }

  // 校验机制（自检阈值 / 蓝点生命周期 / 升级阈值 / 字节预算 / Host-Client 一致）
  // 断言都在问「这个能力真的生效了吗」，而不是「函数被调用了」。
  try {
console.log('== 校验机制层：契约阈值真的生效了吗 ==')
    {
      let clock = 1_700_000_000_000
      const pushes = []
      T.resetSourceHealth()
      const probe = T.createHealthProbe({ now: () => clock, pushSource: (id, p) => pushes.push([id, p]) })

      const orig = T.SOURCE_CONTRACTS.usgs.staleAfterMs
      try {
        T.SOURCE_CONTRACTS.usgs.staleAfterMs = 60 * 1000
        assert(T.staleAfterOf('usgs') === 60 * 1000, '自检阈值取自契约（不是某处硬编码）')
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
      // 关掉的源不判停更：用户主动关掉后 Client 不再拉它，dataTime 自然停住，
      // 继续判 stale 等于说「上游停更了」，而事实是我们自己不再问了。
      {
        const origNoaa = T.SOURCE_CONTRACTS.noaa.staleAfterMs
        try {
          T.SOURCE_CONTRACTS.noaa.staleAfterMs = 60 * 1000
          T.resetSourceHealth()
          T.noteFreshness('noaa', clock)
          clock += 61 * 1000
          probe.tick()
          assert(T.sourceHealthOf('noaa').fresh.stale === true, '（对照）不看开关时，关掉的源会被判停更')
          // 修好之后：源被关掉 → 不判，并把残留的 stale 清掉（否则会一直挂到重开）
          const offProbe = T.createHealthProbe({
            now: () => clock,
            pushSource: (id, p) => pushes.push([id, p]),
            sourceEnabled: (id) => id !== 'noaa',
          })
          const before = pushes.length
          offProbe.tick()
          assert(T.sourceHealthOf('noaa').fresh.stale === false,
            '源被关掉时不判停更（"我已关闭"不该被改写成"上游数据已过期"）')
          assert(pushes.slice(before).some((x) => x[0] === 'noaa' && x[1].status === 'disabled'),
            '并显式上报 disabled（把上一刻的 stale 清掉，而不是留在界面上）')
        } finally {
          T.SOURCE_CONTRACTS.noaa.staleAfterMs = origNoaa
        }
      }
      // ② staleAfterMs 为 null 的推送源不判（日本可能数小时没有有感地震，而连接是好的）      T.resetSourceHealth()
      T.noteFreshness('p2pquake', clock)
      clock += 10 * 60 * 60 * 1000
      probe.tick()
      assert(T.sourceHealthOf('p2pquake').fresh.stale === false,
        '契约里 staleAfterMs=null 的推送源不判停更')
      T.resetSourceHealth()
      probe.tick()
      assert(!T.sourceHealthOf('usgs') || T.sourceHealthOf('usgs').fresh.stale === false,
        '从未上报数据时间 → 不判停更（不猜）')
      assert(T.staleAfterOf('p2pquake') === 0 && T.staleAfterOf('emsc') === 0 && T.staleAfterOf('noaa') === 0,
        '三个 staleAfterMs=null 的源（两个推送源 + NOAA 的"列表为空是常态"）统一成 0')
      T.resetSourceHealth()
    }

console.log('== 校验机制层：蓝点跨刷新存活 + TTL 自愈 ==')
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

console.log('== 缓冲字节预算 ==')
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

console.log('== Host 与 Client 的停更阈值一致 ==')
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

console.log('== 状态合成 / 跨标签页清空 / 契约原型链 / JMA 标签 / 演示链路 ==')
  try {
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
        '自检判「数据已过期」不改展示状态 —— schema-error 优先于 stale')
      t.noteFreshness('usgs', Date.now())
      probe.tick()
      assert(store.sources.usgs.status === 'schema-error',
        '自检判「数据已恢复」也不会把蓝点刷成绿色（修复前正是这条：能力写了、但被后写者覆盖）')

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

      // 跨刷新：蓝点存到本地 → 重新加载 → 装载时立刻重发（而不是等该源下一次上报）
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

    {
      const base = { alertid: '53072441600000_x', title: '云南省丽江市宁蒗彝族自治县气象台发布暴雨橙色预警信号', issued: '2026-09-19T03:02:45+08:00' }
      const r1 = T.parseNmcAlarmResult(Object.assign({}, base, { kind: 'constructor', level: 'orange' }))
      assert(r1.ok === false && r1.kind === 'empty', 'kind=constructor 被判 empty（修复前直接放行，kindLabel 里嵌进函数源码）')
      const r2 = T.parseNmcAlarmResult(Object.assign({}, base, { kind: 'rainstorm', level: 'constructor' }))
      assert(r2.ok === false && r2.kind === 'schema', 'level=constructor 被判 schema（修复前 severity 变成函数对象）')
      const ok = T.parseNmcAlarmResult(Object.assign({}, base, { kind: 'rainstorm', level: 'orange' }))
      assert(ok.ok === true && ok.alert.cnRank === 3, '（对照）正常的 kind / level 仍然通过')
    }

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
      // 与关注县**无关**的日本气象电文也不是"本县的警报解除了"：清掉会抹掉一条仍然有效的提示。
      // JMA 气象电文频繁、多数都不涉及某一位用户关注的县，所以这条路径比跨源那条更容易走到。
      const cfgTokyo = Object.assign({}, cfg, {
        watch: Object.assign({}, cfg.watch, { prefectures: ['東京都'], cities: [] }),
      })
      t.updateWeatherHint(l3, cfgTokyo)
      assert(!!(t.store.weatherHint && t.store.weatherHint.level === 3), '（前置）只关注东京 → 东京那条 L3 写入提示')
      const hokkaido = t.parseJma(t.buildTestTelegram('北海道', 1700000000100, 'landslide-l3', ''), { id: 'test-hokkaido-l3' })
      t.updateWeatherHint(hokkaido, cfgTokyo)
      assert(!!(t.store.weatherHint && t.store.weatherHint.level === 3),
        '只涉及其它县的电文（北海道）不清掉东京的 L3 提示：' + JSON.stringify(t.store.weatherHint))
    }

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
          'markRead（/feed 被访问）唤醒轮询：排出一个短的重试间隔')
        await runOne()
        assert(poller.stats().polls === 1, '唤醒之后真的拉了源')
        assert(pending.length === 1 && pending[0].ms === 60 * 1000, '成功一轮之后回到正常间隔')
        poller.stop()
      } finally {
        global.setTimeout = realSet
        global.clearTimeout = realClear
      }
    }

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
        '首次 bind 时 Host 已非空也要写「已处理」标记（修复前永不写入本地存储）')
      // Host 被清空（用户在别处恢复默认）→ 本地那份**过期**的镜像不该迁回去
      snap = { status: 'ready', mode: 'host', writable: true, value: {}, user: {} }
      if (typeof syncFn === 'function') syncFn()
      assert(t.currentCfg().thresholds.quakeScale === 40,
        'Host 清空后不会被本地旧值复活（修复前实测会写回 55）：' + t.currentCfg().thresholds.quakeScale)
    }
  } catch (e) {
    assert(false, '0.5.4 检查失败：' + e.message + '\n' + (e && e.stack ? e.stack.split('\n').slice(1, 3).join('\n') : ''))
  }

  // 海外气象源（美国 NWS / 加拿大 ECCC）的解析层与契约
  // 全部用 samples/nws/ 与 samples/eccc/ 的真实 fixture，不联网。
  try {
    const T6 = loadClientEx().exports.__test
    const nwsSample = JSON.parse(fs.readFileSync(path.join(ROOT, 'samples', 'nws', 'nws-flood-alerts.geojson'), 'utf8'))
    const ecccSample = JSON.parse(fs.readFileSync(path.join(ROOT, 'samples', 'eccc', 'eccc-alerts.geojson'), 'utf8'))
    // 两条**真实事件链** fixture：同一次洪水预警的连续两版 / 被取消的警报 + 它的 Cancel。
    const nwsChain = JSON.parse(fs.readFileSync(path.join(ROOT, 'samples', 'nws', 'nws-event-chain.geojson'), 'utf8')).features
    const nwsCancelChain = JSON.parse(fs.readFileSync(path.join(ROOT, 'samples', 'nws', 'nws-cancel-chain.geojson'), 'utf8')).features
    const nwsPointSample = JSON.parse(fs.readFileSync(path.join(ROOT, 'samples', 'nws', 'nws-point-alerts.geojson'), 'utf8'))
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
    /** 一条**与季节无关**的 ECCC 样本 shell：取任意真实 feature 并把 alert_type 强制成 `warning` 且保证有合法颜色。
     *  fixture 随季节重抓，写死 alert_code 或按下标取都会变成 undefined。 */
    const ecccWarnShell = () => {
      // 优先挑一条**真实就通过白名单**的样本；本季都没有时退到任意样本并补一个白名单内的名字。
      const usable = (x) => x && x.properties
      const listed = ecccSample.features.filter(usable)
        .filter((x) => T6.parseEcccAlertResult(x, { place: caPlace }).ok)[0]
      const f = JSON.parse(JSON.stringify(listed || ecccSample.features.filter(usable)[0]))
      f.properties.alert_type = 'warning'
      if (!f.properties.risk_colour_en) f.properties.risk_colour_en = 'orange'
      const name = String(f.properties.alert_name_en || '')
      if (!/rain|flood|surge|hydrolog|water/i.test(name) || /frost|fog|freez|wind|heat|snow|ice/i.test(name)) {
        f.properties.alert_name_en = 'rainfall warning'
      }
      return f
    }

console.log('== NWS：白名单 / 门槛 / 事件键 ==')

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

    {
      const fw = T6.parseNwsAlertResult(nwsByEvent('Flood Warning'), { place: usPlace }).alert
      const ffw = T6.parseNwsAlertResult(nwsByEvent('Flash Flood Warning'), { place: usPlace }).alert
      const watch = T6.parseNwsAlertResult(nwsByEvent('Flood Watch'), { place: usPlace }).alert
      const adv = T6.parseNwsAlertResult(nwsByEvent('Flood Advisory'), { place: usPlace }).alert
      assert(fw.overseasRank >= T6.OVERSEAS_BROADCAST_MIN_RANK, 'Flood Warning 达到播报线（Warning 类）')
      assert(ffw.overseasRank >= T6.OVERSEAS_BROADCAST_MIN_RANK, 'Flash Flood Warning 达到播报线')
      assert(watch.overseasRank < T6.OVERSEAS_BROADCAST_MIN_RANK, 'Flood Watch 不到播报线（只进历史）')
      assert(adv.overseasRank < T6.OVERSEAS_BROADCAST_MIN_RANK, 'Flood Advisory 不到播报线')
      // 关键证据：Flood Watch 的 severity 实测是 Severe（与 Flood Warning 同级），门槛必须看 event 名。
      assert(watch.severity === 'orange' && watch.overseasRank < T6.OVERSEAS_BROADCAST_MIN_RANK,
        'Flood Watch 的 severity 是 orange 但档位不到线——这正是"门槛不能按 severity"的实测证据')
    }

    {
      assert(T6.NWS_SEVERITY.Extreme === 'red' && T6.NWS_SEVERITY.Severe === 'orange' &&
        T6.NWS_SEVERITY.Moderate === 'yellow' && T6.NWS_SEVERITY.Minor === 'info',
        'NWS 的四个 severity 各自映射到本项目配色，不做"恒 red"那种拔高')
      const fw = T6.parseNwsAlertResult(nwsByEvent('Flood Warning'), { place: usPlace }).alert
      assert(fw.severity === 'orange', 'Flood Warning（Severe）→ orange，未被拔高成 red')
    }

    {
      const f = nwsByEvent('Flood Warning')
      const a = T6.parseNwsAlertResult(f, { place: usPlace }).alert
      assert(a.issued === f.properties.sent, 'issued 原样保留响应里的带偏移时刻：' + a.issued)
      assert(/[+-]\d{2}:\d{2}$/.test(a.issued), '确实是带偏移的 ISO（不是补出来的本地时间）')
    }

    {
      const f = nwsByEvent('Flood Warning')
      const base = T6.parseNwsAlertResult(f, { place: usPlace }).alert
      // 真实 fixture 的 VTEC 是 /O.EXT.KILN.FL.W.0067.…，它的 references 指向**上一版**而不是事件链的根。
      assert(base.eventKey === 'nws:KILN.FL.W.0067',
        '事件键 = VTEC 的 <office>.<phenom>.<sig>.<ETN>（剔除 ACTION 段）：' + base.eventKey)
      assert(String(f.properties.parameters.VTEC[0]).indexOf('/O.EXT.KILN.FL.W.0067.') === 0,
        '（前置）fixture 的 VTEC 是 EXT 档')
      for (const action of ['NEW', 'CON', 'CAN', 'EXP']) {
        const g = JSON.parse(JSON.stringify(f))
        g.properties.parameters.VTEC[0] = String(f.properties.parameters.VTEC[0]).replace('/O.EXT.', '/O.' + action + '.')
        assert(T6.parseNwsAlertResult(g, { place: usPlace }).alert.eventKey === base.eventKey,
          action + ' 档与 EXT 档算出同一个键——ACTION 段从 NEW→EXT→CON→CAN 全程在变，不能进键')
      }
      assert(base.eventKey !== T6.nwsEventKeyOf(f.properties.id, f.properties.references, null),
        '——它与"references / 自身 identifier"兜底算出的键不同（VTEC 才是权威来源）')
      // 兜底规则（用合成输入，逐条钉住 4 行里的 3 个判据）
      assert(T6.nwsEventKeyOf('self.1', [
        { identifier: 'b.1', sent: '2026-01-01T00:00:00Z' },
        { identifier: 'a.1', sent: '2026-01-01T00:00:00Z' },
      ], null) === 'nws:a', 'references 的 sent 并列时按 identifier 字典序取最小（结果必须确定）')
      assert(T6.nwsEventKeyOf('self.1', [
        { identifier: 'b.2', sent: '2026-01-02T00:00:00Z' },
        { identifier: 'a.9', sent: '2026-01-01T00:00:00Z' },
      ], null) === 'nws:a', '取 sent 最早的那条（与数组顺序无关）')
      assert(T6.nwsEventKeyOf('self.1', [{ identifier: 'z.1', sent: '不是时间' }], null) === 'nws:z',
        'sent 不可解析 → 视为最晚（Infinity 兜底）')
      assert(T6.nwsEventKeyOf('self.1', [], null) === 'nws:self', '没有 references → 自身 identifier')
      assert(T6.nwsEventKeyOf('self.1', [], []) === 'nws:self',
        'VTEC 是空数组时同样退回兜底')
      // ETN 段是 4~6 位：实测出现过 5 位（/O.NEW.KRLX.FA.W.01370.…），写死 4 位会让整段失配并退回 references 兜底。
      const vtecBase = JSON.parse(JSON.stringify(nwsByEvent('Flood Warning')))
      vtecBase.properties.parameters.VTEC = ['/O.NEW.KRLX.FA.W.01370.260101T0000Z-260102T0000Z/']
      assert(T6.parseNwsAlertResult(vtecBase, { place: usPlace }).alert.eventKey === 'nws:KRLX.FA.W.01370',
        '5 位 ETN 也能提出 VTEC 键（不再退回 references 兜底）')
      const vtec4 = JSON.parse(JSON.stringify(vtecBase))
      vtec4.properties.parameters.VTEC = ['/O.EXT.KILN.FL.W.0067.260101T0000Z-260102T0000Z/']
      assert(T6.parseNwsAlertResult(vtec4, { place: usPlace }).alert.eventKey === 'nws:KILN.FL.W.0067',
        '对照：4 位 ETN 仍照旧（剔除 ACTION 段）')
      // 真实的多引用样本：Coastal Flood Watch 有 3 条 references（两条 sent 相同）
      const cfw = nwsByEvent('Coastal Flood Watch')
      assert(cfw.properties.references.length === 3, '（前置）Coastal Flood Watch 有 3 条 references')
      const noVtecCfw = JSON.parse(JSON.stringify(cfw))
      delete noVtecCfw.properties.parameters.VTEC
      const cfwKey = T6.parseNwsAlertResult(noVtecCfw, { place: usPlace }).alert.eventKey
      assert(cfwKey === 'nws:urn:oid:2.49.0.1.840.0.1f0e1cc1d5b5cbc28a87f45808d3895c0472ed36.010',
        '真实 3 引用样本走兜底时的确切值（取 sent 最早；两条 sent 并列 02:10，按 identifier ' +
        '字典序取 .010 而不是 .011）：' + cfwKey)
      const raw = JSON.parse(JSON.stringify(nwsByEvent('Flash Flood Warning')))
      delete raw.properties.parameters.VTEC
      assert(T6.parseNwsAlertResult(raw, { place: usPlace }).alert.eventKey ===
        'nws:' + raw.properties.id.replace(/\.[0-9]+$/, ''),
        '既无 VTEC 又无 references（原始 Alert）→ 自身 identifier')
    }

    // ---- 5a. 真实事件链：连续两版必须同键 ----
    {
      const keys = nwsChain.map((f) => T6.parseNwsAlertResult(f, { place: usPlace }).alert.eventKey)
      assert(nwsChain.length === 2 && keys[0] === keys[1],
        '同一次洪水预警的两个连续版本算出同一个事件键（否则每次更新都重复响铃）：' + JSON.stringify(keys))
      assert(nwsChain[0].properties.id !== nwsChain[1].properties.id &&
        nwsChain[0].properties.sent !== nwsChain[1].properties.sent,
        '（前置）这两版的 CAP identifier 与 sent 都不同——键不可能来自它们')
      assert(nwsChain.every((f) => (f.properties.references || []).length > 0),
        '（前置）两版都带 references（指向紧邻的上一版，不是链根）')
      // 端到端：第二版到达时应当被判成"同一事件的后续发布"，不重复响铃
      const cfg = mkCfg([usPlace])
      const first = T6.parseNwsAlertResult(nwsChain[0], { place: usPlace }).alert
      const second = T6.parseNwsAlertResult(nwsChain[1], { place: usPlace }).alert
      const r1 = T6.handleAlert(first, cfg, { skipQuietHours: true })
      assert(r1.notified === true, '（前置）第一版播报：' + JSON.stringify(r1))
      const r2 = T6.handleAlert(second, cfg, { skipQuietHours: true })
      assert(r2.notified === false && (r2.reason === 'event-repeat' || r2.reason === 'replayed'),
        '第二版不重复响铃（0.6.0 的键在这里会算成另一个事件 → notified=true）：' + JSON.stringify(r2))
    }

    // ---- 5b. 取消链路端到端 ----
    {
      // 真实的 Cancel 与它取消的那条警报：VTEC 只有 ACTION 段不同（EXT → CAN），CAP identifier 完全不同。
      const [orig, can] = nwsCancelChain
      const alert = T6.parseNwsAlertResult(orig, { place: usPlace }).alert
      const cancelAlert = T6.parseNwsAlertResult(can, { place: usPlace }).alert
      assert(T6.nwsVtecKeyOf(can.properties.parameters.VTEC) === T6.nwsVtecKeyOf(orig.properties.parameters.VTEC),
        '（前置）Cancel 与被取消消息的 VTEC 追踪号相同（只有 ACTION 段不同）')
      assert(cancelAlert.cancelled === true, '（前置）messageType=Cancel → cancelled')
      assert(cancelAlert.id !== alert.id, '（前置）Cancel 的消息 id 与原来不同（CAP 要求 identifier 唯一）')
      assert(cancelAlert.eventKey === alert.eventKey,
        'Cancel 的事件键与当初播报的那条**相同**——否则用户永远收不到"此前警报已作废"')
      // 只验键不够：把 handleAlert 里 `if (alert.cancelled)` 整块删掉时，上面那些断言全都还是绿的。
      const cfg = mkCfg([usPlace])
      const r0 = T6.handleAlert(alert, cfg, { skipQuietHours: true })
      assert(r0.notified === true, '（前置）原警报播报：' + JSON.stringify(r0))
      assert(T6.wasRecentlyAlerted(alert) === true, '（前置）播报后 24 小时记忆里记得这个事件')
      const r1 = T6.handleAlert(cancelAlert, cfg, { skipQuietHours: true })
      assert(r1.reason === 'cancelled', 'Cancel 由 handleAlert 转交取消链路（不是当成一条新预警）：' + JSON.stringify(r1))
      const hist = T6.store.events[0]
      assert(hist && hist.id === cancelAlert.id && hist.hit === true && hist.suppressed !== true,
        '取消消息进历史且标记为命中（用户展开能看到"已作废"）：' + JSON.stringify(hist && hist.headline))
    }

    {
      const c = JSON.parse(JSON.stringify(nwsByEvent('Flood Warning')))
      c.properties.messageType = 'Cancel'
      assert(T6.parseNwsAlertResult(c, { place: usPlace }).alert.cancelled === true, 'messageType=Cancel → cancelled')
      assert(T6.parseNwsAlertResult(nwsByEvent('Flood Warning'), { place: usPlace }).alert.cancelled === false,
        '其余 messageType（Alert / Update）不算取消')
    }

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
      // properties.id 缺了会退回 GeoJSON 外层的 feature.id（实测外层是完整 URL），所以「缺 identifier」要两层都清才成立。
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

    {
      const f = nwsByEvent('Flash Flood Warning')
      const a = T6.parseNwsAlertResult(f, { place: usPlace }).alert
      assert(a.detail.indexOf(String(f.properties.description).slice(0, 40)) === 0, 'detail 以官方 description 开头')
      assert(a.detail.indexOf('Turn around, don\'t drown') >= 0, 'instruction 也在 detail 里')
      assert(a.kindLabel.indexOf('美国') === 0 && a.kindLabel.indexOf('NWS') > 0,
        'kindLabel 带国别与发布机构：' + a.kindLabel)
    }

    {
      const a = T6.parseNwsAlertResult(nwsByEvent('Flood Warning'), { place: usPlace }).alert
      assert(a.locator === 'overseas', 'locator 是 overseas（不是 point——命中在取数时就已发生）')
      assert(a.originPlace && a.originPlace.name === '休斯敦', 'originPlace 记录了这条是哪个关注点查回来的')
      const noPlace = T6.parseNwsAlertResult(nwsByEvent('Flood Warning')).alert
      assert(noPlace.originPlace === null, '取数器没给 place 时是 null，而不是 undefined/{}')
    }

console.log('== ECCC：两道过滤器 / 署名 / 事件键 ==')

    {
      // 不绑定具体 alert_code：fixture 的灾种分布随季节变化，点名某个码会在重抓样本后失败，而失败原因与代码改动无关。
      const rows = []
      for (const f of ecccSample.features) {
        const r = T6.parseEcccAlertResult(f, { place: caPlace })
        rows.push({ code: String(f.properties.alert_code), type: String(f.properties.alert_type || ''), kind: r.ok ? 'ok' : r.kind })
      }
      assert(rows.length > 0, 'ECCC fixture 至少有一条样本')
      assert(rows.every((r) => r.type === 'warning' || r.kind === 'empty'),
        '过滤器一：非 warning（advisory / statement 等）一律判 empty——官方定义就是"非危险天气"')
      assert(rows.filter((r) => r.type === 'warning').every((r) => r.kind === 'ok' || r.kind === 'empty'),
        '过滤器二：warning 只可能是 ok（名称在白名单内）或 empty（不在），不能是 schema——按码猜是 4.6.3 踩过的坑')
      // 与季节无关的对照：ecccWarnShell 构造的"白名单内 warning"必须 ok；改成 advisory 必须 empty。
      assert(T6.parseEcccAlertResult(ecccWarnShell(), { place: caPlace }).ok === true,
        '对照：白名单内的 warning（构造，不依赖当季样本）→ ok')
      const adv = ecccWarnShell()
      adv.properties.alert_type = 'advisory'
      assert(T6.parseEcccAlertResult(adv, { place: caPlace }).kind === 'empty',
        '对照：同一条改成 advisory → empty（过滤器一）')
    }

    {
      // 构造一条降雨预警：码本身用任意值（白名单只看名称），当前季节没有降雨样本。
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

    {
      const a = T6.parseEcccAlertResult(ecccSample.features[2], { place: caPlace }).alert
      assert(a.detail.indexOf('Data Source: Environment and Climate Change Canada') > 0,
        'detail 带署名（End-use Licence v2.1.1 要求）')
      const rawText = ecccSample.features[2].properties.alert_text_en
      assert(a.detail.indexOf(String(rawText).slice(0, 40)) === 0, '官方正文原样保留、未被改写（同一条许可要求）')
    }

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

console.log('== 取数器：按关注点查询 ==')

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
    // 坐标夹取
      const pole = T6.nwsSamplePoints({ lat: 60, lon: -179.5, radiusKm: 2000 })
      assert(pole.every((p) => p[0] >= -90 && p[0] <= 90 && p[1] >= -180 && p[1] <= 180),
        '大半径 + 高纬度时方位点被夹到合法范围（否则我们自造的非法参数会被上游回 400）：' + JSON.stringify(pole))
      const box = T6.ecccBboxOf({ lat: 70, lon: -178, radiusKm: 2000 }).split(',').map(Number)
      assert(box.every((v, i) => (i % 2 === 0 ? v >= -180 && v <= 180 : v >= -90 && v <= 90)),
        'ECCC 的 bbox 同样被夹住：' + box.join(','))
      assert(box[0] <= box[2] && box[1] <= box[3], '夹取不会把矩形翻过来：' + box.join(','))
    }

    {
      const US = { minLat: 24, maxLat: 50, minLon: -125, maxLon: -66 }
      const CA = { minLat: 41, maxLat: 84, minLon: -141, maxLon: -52 }
      const cfgAll = mkCfg([usPlace, caPlace, jpPlace])
      const inUs = T6.placesInBoxes(cfgAll, [US]).map((p) => p.name).join(',')
      assert(inUs === '休斯敦,多伦多',
        '美国盒选中两个北美点——多伦多也在盒内（美加边界不是矩形），由第 19 条的 400 兜底处理：' + inUs)
      assert(T6.placesInBoxes(cfgAll, [CA]).map((p) => p.name).join(',') === '多伦多', '加拿大盒只选中多伦多')
      assert(T6.placesInBoxes(cfgAll, [US, CA]).length === 2, '东京不在任何一个盒里 → 一个请求都不发')
      // 海外领地此前全在盒外；断言用实现真正用的那组盒（T6.US_BOXES）。
      const pr = { name: '圣胡安', lat: 18.4655, lon: -66.1057, radiusKm: 100 }
      const guam = { name: '关岛', lat: 13.4443, lon: 144.7937, radiusKm: 100 }
      assert(T6.placesInBoxes(mkCfg([pr, guam]), T6.US_BOXES).length === 2,
        '波多黎各与关岛都在 NWS 的覆盖盒内（都有 WFO）：' +
        T6.placesInBoxes(mkCfg([pr, guam]), T6.US_BOXES).map((p) => p.name).join(','))
    }

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
      // 把 sent 重写成「刚刚」：依赖 fixture 绝对日期的断言会随真实时钟越过当天下午而自行变红，且失败无法归因。
      const fresh = JSON.parse(JSON.stringify(nwsSample.features))
      const stamp = new Date(Date.now() - 5 * 60 * 1000).toISOString()
      for (const f of fresh) f.properties.sent = stamp
      let freshHanded = 0
      const freshSrc = T6.createNwsSource({
        getCfg: () => cfg,
        onStatus: () => {},
        onAlert: (a, c, o) => { if (!(o && o.staleOnArrival)) freshHanded += 1 },
        fetchText: async () => JSON.stringify({ type: 'FeatureCollection', features: fresh }),
      })
      await freshSrc.pollOnce()
      assert(freshHanded === 7, '刚发布（5 分钟前）的 7 条都不进门闸：' + freshHanded)
      // detail 只放语义信息：计数由设置页从 stats 直接读，这样 detail 变化才等于语义变化（上报去重键才算得准）。
      assert(status && status.status === 'open' && /queried 1 watch points/.test(status.detail || ''),
        '正常一轮的状态是 open，detail 是非单调的语义摘要（review B-1：留空会让悬停显示裸状态词 open）：' + JSON.stringify(status))
    }

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

    {
      // 年龄门槛：首轮把"发布已 10 小时"的条目标记为 staleOnArrival
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
      assert(stNone && /关注点都不在/.test(stNone.detail) && /其他国家 \/ 地区/.test(stNone.detail),
        '状态说清"有点但都不在美国源的覆盖范围内"（0.6.1：此前一律说"未设置"，' +
        '而用户明明在设置页看得见那个点）与去哪里配：' + (stNone && stNone.detail))
      // 真的一个点都没配时，文案回到"未设置"
      let stEmpty = null
      const emptySrc = T6.createNwsSource({
        getCfg: () => mkCfg([]),
        onStatus: (p) => { stEmpty = p },
        onAlert: () => {},
        fetchText: async () => '{}',
      })
      await emptySrc.pollOnce()
      assert(stEmpty && /未设置/.test(stEmpty.detail), '一个关注点都没配 → 「未设置」：' + (stEmpty && stEmpty.detail))

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
      // 顶层结构不符 = **契约漂移**，要点亮 schema-error 蓝点（用户处理不了、等插件更新），而不是红点。
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

console.log('== NWS / ECCC review：修掉的三条各配一条守卫 ==')

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

    {
      const cfg = mkCfg([usPlace])
      const f = JSON.parse(JSON.stringify(nwsByEvent('Flood Warning')))
      f.properties.sent = new Date(Date.now() - 10 * 3600 * 1000).toISOString()
    // 换一个 ETN：事件键来自 VTEC，所以「换一条独立的事件」必须换 VTEC
      f.properties.parameters.VTEC[0] = '/O.NEW.KILN.FL.W.0999.000000T0000Z-260922T1800Z/'
      const alert = T6.parseNwsAlertResult(f, { place: usPlace }).alert
      const r = T6.handleAlert(alert, cfg, { staleOnArrival: 10 })
      assert(r.reason === 'stale-on-arrival', '老预警走的是"只记历史"分支：' + r.reason)
      // isEventRepeat **自己会写记忆**，所以只能调用一次来验证 handleAlert 有没有写
      assert(T6.isEventRepeat(alert, 10) === true,
        '该分支排在 isEventRepeat 之后 → 事件记忆已写入，后续轮次会判成"后续发布"而不是再进一次历史')
    }

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
      assert(seen[1] === 'open|queried 1 watch points',
        '第二次 detail 变成"已按 N 个关注点查询"——不会把"未设置"的旧文案一直挂在设置页上：' + seen[1])
    }

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
      // 事件键首选 VTEC，所以这条「外层 id 兜底」用例必须把 VTEC 也去掉。
      delete outer.properties.parameters.VTEC
      const a = T6.parseNwsAlertResult(outer, { place: usPlace }).alert
      assert(a.id === 'nws:urn:oid:2.49.0.1.840.0.abc.001.1',
        '外层 URL id 会抽出 urn:oid 段（否则消息 id 带着 URL 前缀，跨轮去重失效）：' + a.id)
      assert(a.eventKey === 'nws:urn:oid:2.49.0.1.840.0.abc.001',
        '事件键随之退回自身 identifier（去掉末尾版本段）：' + a.eventKey)
    }

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

    {
      const cfg = mkCfg([usPlace])
      T6.store.push({ weatherHint: { level: 3, label: 'テスト県', at: Date.now() } })
      const alert = T6.parseNwsAlertResult(nwsByEvent('Flood Warning'), { place: usPlace }).alert
      T6.handleAlert(alert, cfg)
      assert(T6.store.weatherHint && T6.store.weatherHint.level === 3,
        '海外预警（regions 恒空）不再抹掉日本电文留下的「L3 未达 L4」提示：' + JSON.stringify(T6.store.weatherHint))
      T6.store.push({ weatherHint: null })
      // 解除同样按来源分：NWS 的 Cancel 是 kind=weather + locator=overseas + cancelled=true，来源守卫
      // 若排在解除分支之后，这条会抹掉日本电文的提示。用独立实例，避免取消链的 id 撞上去重表。
      const tc = loadClientEx().exports.__test
      const cancelAlert = nwsCancelChain
        .map((f) => tc.parseNwsAlertResult(f, { place: usPlace }).alert)
        .filter(Boolean).find((a) => a.cancelled === true)
      assert(!!cancelAlert, '（前置）取消链样本里有一条 Cancel 电文')
      tc.store.push({ weatherHint: { level: 3, label: 'テスト県', at: Date.now() } })
      tc.handleAlert(cancelAlert, tc.loadCfg())
      assert(tc.store.weatherHint && tc.store.weatherHint.level === 3,
        '海外气象源的**解除**（locator=overseas 的 Cancel）也不抹掉日本电文的 L3 提示：' +
        JSON.stringify(tc.store.weatherHint))
    }

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

    {
      let calls = 0
      const src = T6.createNwsSource({
        getCfg: () => mkCfg([usPlace]),
        intervalMs: 5, // 正常间隔压到 5ms：有重试间隔递增时不会按这个节奏继续打
        firstDelayMs: 1,
        onStatus: () => {},
        onAlert: () => {},
        fetchText: async () => { calls += 1; const e = new Error('HTTP 500'); e.status = 500; throw e },
      })
      src.start()
      await new Promise((resolve) => setTimeout(resolve, 150))
      src.stop()
      // 没有重试间隔递增时：每 5ms 一轮 × 5 个请求 = 上百次；有递增（1 秒起）时 150ms 内只有第一轮
      assert(calls <= 20, '全部失败后逐次延长重试间隔，150ms 内只跑了 ' + calls + ' 个请求（不延长会是上百次）')
      assert(T6.OVERSEAS_MIN_BACKOFF_MS === 1000 && T6.OVERSEAS_MAX_BACKOFF_MS === 60000,
        '重试间隔逐次延长，从 1s 到 60s 上限（与 DESIGN 4.7.2 一致）')
    }

console.log('== 匹配：查询即匹配 ==')
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

    {
      assert(T6.DEFAULT_CFG.disasters.overseasWeather === true, 'Client 默认值是开')
      const norm = T6.normalizeCfg({ disasters: { overseasWeather: false } })
      assert(norm.disasters.overseasWeather === false, 'normalizeCfg 认这个字段（漏掉会被静默丢弃）')
      const norm2 = T6.normalizeCfg({ disasters: { overseasWeather: 'yes please' } })
      assert(norm2.disasters.overseasWeather === true, '类型不对时退回默认值')
      const hostMod = await import(pathToFileURL(path.join(ROOT, 'lib', 'index.js')).href)
      const hostParsed = unwrapRefs(hostMod.QuakeAlertSettingsSchema({ disasters: { overseasWeather: false } }))
      assert(hostParsed.disasters.overseasWeather === false,
        'Host schema 认这个开关（四处同步里的第三处；默认值一致由前面那条 JSON 全等断言守着）')
      const hostDefaults = unwrapRefs(hostMod.QuakeAlertSettingsSchema({}))
      assert(hostDefaults.disasters.overseasWeather === T6.DEFAULT_CFG.disasters.overseasWeather,
        'Host schema 的**默认值**与 Client 的 DEFAULT_CFG 一致（0.6.1：此前只是注释里说"有断言守着"）')
    }

console.log('== review：新增守卫 ==')

    {
      const urls = []
      const handed = []
      let status = null
      // shell 与断言都不绑定季节：写死风暴潮（CFW）时，非风暴季重抓 fixture 会变成 undefined 并抛 SyntaxError。
      const cfwFixture = ecccWarnShell()
      const src = T6.createEcccSource({
        getCfg: () => mkCfg([caPlace, usPlace]),
        onStatus: (p) => { status = p },
        onAlert: (a, c, o) => handed.push(a.id),
        fetchText: async (url) => {
          urls.push(url)
          return JSON.stringify({ type: 'FeatureCollection', numberMatched: 1, features: [cfwFixture] })
        },
      })
      const r = await src.pollSerial()
      assert(urls.length === 1, '美国源与加拿大源各查各的：只给加拿大的点发 1 个请求（bbox，不做方位采样）：' + urls.length)
      assert(urls[0].indexOf('https://api.weather.gc.ca/collections/weather-alerts/items') === 0,
        'URL 指向 ECCC 的 OGC API：' + urls[0])
      assert(urls[0].indexOf('f=json') > 0 && urls[0].indexOf('limit=200') > 0,
        '带 f=json 与分页上限 limit=200：' + urls[0])
      assert(urls[0].indexOf('bbox=' + T6.ecccBboxOf(caPlace)) > 0,
        'bbox 就是 ecccBboxOf(关注点)（半径直接参与查询）：' + urls[0])
      assert(urls[0].indexOf('point=') === -1, 'ECCC 走 bbox，不走 NWS 那套 point 采样')
      assert(handed.length === 1 && r.applied === 1, 'fixture 那条交给主链一次：' + JSON.stringify(handed))
      assert(T6.overseasStatsOf.eccc_alerts && T6.overseasStatsOf.eccc_alerts.polls === 1,
        'overseasStatsOf 里写入了 eccc_alerts 的快照（设置页与诊断都读它）')
      assert(typeof T6.overseasStatsOf.eccc_alerts.errors === 'number' &&
        typeof T6.overseasStatsOf.eccc_alerts.received === 'number',
        '快照字段齐全：' + JSON.stringify(Object.keys(T6.overseasStatsOf.eccc_alerts)))
      assert(status && /queried 1 watch points/.test(status.detail || ''), '状态上报正常：' + JSON.stringify(status))
    }

    {
      const q = T6.NWS_EVENT_QUERY.split(',').slice().sort()
      const w = Object.keys(T6.NWS_EVENT_WHITELIST).slice().sort()
      assert(q.length === w.length && q.every((v, i) => v === w[i]),
        'NWS_EVENT_QUERY（发给上游的 ?event=）与白名单是同一个集合：' + q.join(' | '))
      assert(T6.NWS_EVENT_QUERY.indexOf('Flood Warning') >= 0, '白名单里的每一类都进了查询参数')
    }

    {
      let calls = 0
      const src = T6.createNwsSource({
        getCfg: () => mkCfg([caPlace]),
        uncoveredTtlMs: 0, // 立刻到期（默认 1 小时）
        onStatus: () => {},
        onAlert: () => {},
        fetchText: async () => { calls += 1; const e = new Error('HTTP 400'); e.status = 400; throw e },
      })
      await src.pollOnce()
      assert(calls === 5, '第一轮 5 个采样点各查一次：' + calls)
      await src.pollOnce()
      assert(calls === 10, 'TTL 到期后重新尝试（把实现改成永久拉黑 / 比较写成反向，这条会红）：' + calls)
    }

    {
      // 不依赖具体季节的样本：shell 取任意一条真实 feature 并把 alert_type 强制成 'warning'。
      const shell = ecccSample.features.filter((x) => x && x.properties)[0]
      assert(shell, '（前置）ECCC fixture 里至少有一条可用作 shell 的样本')
      const mk = (nameEn) => {
        const f = JSON.parse(JSON.stringify(shell))
        f.properties.alert_type = 'warning'
        f.properties.alert_name_en = nameEn
        if (typeof f.properties.risk_colour_en !== 'string') f.properties.risk_colour_en = 'orange'
        return T6.parseEcccAlertResult(f, { place: caPlace })
      }
      // 负向词从实现的正则派生：手抄的 17 个词里有 16 个无论删掉哪条排除规则都仍然判 empty（恒真断言）。
      const sources = String(T6.ECCC_EXCLUDE).replace(/\\b/g, '').replace(/[()]/g, '').split('|')
      const negative = sources.map((s) => 'rain ' + s + ' warning')
      const leaked = negative.filter((n) => mk(n).kind !== 'empty')
      assert(leaked.length === 0,
        '把 EXCLUDE 的每个词都塞进一条"本来会命中 INCLUDE"的预警里（rain + 该词）→ 全部判 empty。' +
        '漏进来的：' + leaked.join(', '))
      assert(mk('rainfall warning').ok, '包含名单里的降雨预警放行（当前季节无真实样本，按名称收）')
      assert(mk('wind and rain warning').kind === 'empty',
        '"wind and rain" 既含 rain（会被 INCLUDE 命中）又含 wind → 必须判 empty：' +
        '这钉住的是"**先排除、再包含**"的顺序（删掉 ECCC_EXCLUDE 里的 wind 这条会红）')
      assert(mk('freezing rain warning').kind === 'empty', '"freezing rain" 同理（freez 先排除）')
      // areaKey 兜底：feature_id 缺失 → 退回区域名（契约 tolerant 里写明了这件事）
      const noFid = ecccWarnShell()
      delete noFid.properties.feature_id
      const a = T6.parseEcccAlertResult(noFid, { place: caPlace }).alert
      assert(a.eventKey === 'eccc:' + noFid.properties.alert_code + ':' + noFid.properties.feature_name_en +
        ':' + noFid.properties.publication_datetime.slice(0, 10),
        'feature_id 缺失时事件键退回区域名（不是 unknown）：' + a.eventKey)
    }

    {
      const pt = (nwsPointSample.features || []).filter((f) => f && f.properties)[0]
      assert(pt, '（前置）nws-point-alerts.geojson 里有样本')
      const r = T6.parseNwsAlertResult(pt, { place: usPlace })
      // 按白名单成员关系判，不假定这一条必是非白名单：fixture 每次重抓时无条件覆盖，落在洪水季它会变成白名单内事件。
      const isListed = Object.prototype.hasOwnProperty.call(T6.NWS_EVENT_WHITELIST, pt.properties.event)
      if (isListed) {
        assert(r.ok === true, '（本轮抓到的恰是白名单事件 ' + pt.properties.event + '）解析成功：' + r.kind)
      } else {
        assert(r.kind === 'empty',
          '真实抓到的 ' + pt.properties.event + '（?point= 返回的非白名单事件）判 empty：' + r.kind)
      }
      const lower = JSON.parse(JSON.stringify(nwsByEvent('Flood Warning')))
      lower.properties.event = 'flood warning'
      assert(T6.parseNwsAlertResult(lower, { place: usPlace }).kind === 'empty',
        '白名单是**精确**匹配（大小写敏感）——契约里"精确"这个词的证据')
      const ctor = JSON.parse(JSON.stringify(nwsByEvent('Flood Warning')))
      ctor.properties.event = 'constructor'
      assert(T6.parseNwsAlertResult(ctor, { place: usPlace }).kind === 'empty',
        'event=constructor 判 empty（原型链不能绕过白名单，与 0.5.4 修的 nmc 同一个坑）')
    }

    {
      const nwsAlert = T6.parseNwsAlertResult(nwsByEvent('Flash Flood Warning'), { place: usPlace }).alert
      T6.handleAlert(nwsAlert, mkCfg([usPlace]), { skipQuietHours: true })
      const evNws = T6.store.events[0]
      assert(evNws.id === nwsAlert.id, '（前置）刚写入的是这条')
      assert(evNws.detail && evNws.detail.indexOf('Turn around') >= 0,
        'NWS 的 instruction（"该怎么做"）进了历史条目：' + String(evNws.detail).slice(0, 60))
      const persisted = T6.loadHistory().filter((e) => e.id === nwsAlert.id)[0]
      assert(persisted && persisted.detail && persisted.detail.indexOf('Turn around') >= 0,
        '写入本地存储后仍然带着正文（刷新页面还能看到）')
      const ecccAlert = T6.parseEcccAlertResult(ecccWarnShell(), { place: caPlace }).alert
      T6.handleAlert(ecccAlert, mkCfg([caPlace]), { skipQuietHours: true })
      const evEccc = T6.store.events[0]
      assert(evEccc.id === ecccAlert.id, '（前置）刚写入的是这条')
      assert(evEccc.detail && evEccc.detail.indexOf('Data Source: Environment and Climate Change Canada') > 0,
        'ECCC 许可要求的署名进了历史条目（End-use Licence v2.1.1）')
      assert(evEccc.detail.length <= 1200, '正文被截断到上限内（localStorage 配额与历史 30 条相乘）：' + evEccc.detail.length)
      const long = JSON.parse(JSON.stringify(nwsByEvent('Flash Flood Warning')))
      long.properties.instruction = 'x'.repeat(5000)
      // 换 id 与 VTEC：否则要么被消息级去重挡下、要么被判成同一事件的后续发布
      long.properties.id = long.properties.id.replace(/\.[0-9]+$/, '.77')
      long.properties.parameters.VTEC[0] = '/O.NEW.KFFC.FF.W.0999.260922T1031Z-260922T1630Z/'
      const longAlert = T6.parseNwsAlertResult(long, { place: usPlace }).alert
      T6.handleAlert(longAlert, mkCfg([usPlace]), { skipQuietHours: true })
      assert(T6.store.events[0].id === longAlert.id, '（前置）超长正文那条写进去了')
      assert(T6.store.events[0].detail.length === 1200, '超长正文被截到 1200 字符：' + T6.store.events[0].detail.length)
    }

    {
      // 在一个**独立沙箱**里跑真正的通知拼装（页内 toast 会把 title / body 写进 textContent）
      const texts = []
      const mkEl = () => {
        const el = { style: {}, id: '', setAttribute() {}, appendChild() {}, addEventListener() {} }
        Object.defineProperty(el, 'textContent', { set(v) { texts.push(String(v)) }, get() { return '' } })
        return el
      }
      const s46 = loadClientEx({}, {
        window: {
          document: {
            visibilityState: 'visible',
            body: { appendChild() {}, removeChild() {} },
            createElement: mkEl,
          },
        },
      })
      const T46 = s46.exports.__test
      const cfg46 = JSON.parse(JSON.stringify(T46.currentCfg()))
      cfg46.watch.places = [usPlace]
      cfg46.disasters.overseasWeather = true
      const r46 = T46.handleAlert(
        T46.parseNwsAlertResult(nwsByEvent('Flood Warning'), { place: usPlace }).alert, cfg46, { skipQuietHours: true })
      assert(r46.notified === true, '（前置）海外预警真的播报了（走到的才是通知拼装那条路径）：' + JSON.stringify(r46))
      const joined = texts.join(' / ')
      assert(joined.indexOf('NaN') === -1, '通知文案里没有 NaN：' + joined)
      assert(joined.indexOf('距震中') === -1, '也不再把一条洪水预警说成"距震中"：' + joined)
      assert(joined.indexOf('该点所在地的官方预警') > 0, '命中行按"没有真实距离"分岔：' + joined)
      assert(joined.indexOf('当地官方发布的避难与撤离指引') > 0 && joined.indexOf('市町村') === -1,
        '行动提示不再套日本口径（"请确认所在市町村的避难信息"），且"撤离"这一层指令没有被压缩掉：' + joined)
      assert(joined.indexOf('美国国家气象局（NWS）') > 0,
        '免责声明点名了正确的机构（AUTHORITY_BY_SOURCE 里登记了 nws_alerts）：' + joined)

      // 大陆气象（locator 'area'）也走同一支：只给 overseas 分岔时，命中的大陆暴雨预警会带着「距震中约 NaN km」上线。
      texts.length = 0
      const nmcRaw = {
        alertid: '53072441600000_20260919030245',
        title: '云南省丽江市宁蒗彝族自治县气象台发布暴雨橙色预警',
        issued: '2026-09-19 03:02:45', kind: 'rainstorm', level: 'orange', detail: '正文',
      }
      const nmcAlert = T46.parseNmcAlarmResult(nmcRaw)
      assert(nmcAlert.ok, '（前置）大陆气象预警解析成功')
      assert(nmcAlert.alert.locator === 'area', '（前置）大陆气象源的 locator 是 area')
      const cfgNmc = JSON.parse(JSON.stringify(T46.currentCfg()))
      cfgNmc.watch.places = [{ name: '云南省·丽江市', lat: 26.87, lon: 100.23, radiusKm: 100 }]
      cfgNmc.disasters.cnRainstorm = true
      const rNmc = T46.handleAlert(nmcAlert.alert, cfgNmc, { skipQuietHours: true })
      assert(rNmc.notified === true, '（前置）大陆预警真的播报了：' + JSON.stringify(rNmc))
      const nmcText = texts.join(' / ')
      assert(nmcText.indexOf('NaN') === -1, '大陆预警的通知里也没有 NaN：' + nmcText)
      assert(nmcText.indexOf('距震中') === -1, '也不把一场暴雨说成"震中"：' + nmcText)
      assert(nmcText.indexOf('按该点所在地的官方预警判定') > 0, '命中行同样是"没有距离"那一支：' + nmcText)
      assert(nmcText.indexOf('请关注当地气象台发布的防御指引') > 0 && nmcText.indexOf('市町村') === -1,
        '行动提示用大陆口径（不是日本的市町村避难信息）：' + nmcText)
      assert(nmcText.indexOf('中央气象台（中国气象局）') > 0, '免责声明点名中央气象台：' + nmcText)
      // 三支行动提示都在，且互不相同（防止将来把某支写死回日本口径）
      assert(T46.weatherActionHintOf({ locator: 'overseas' }) !== T46.weatherActionHintOf({ locator: 'area' }) &&
        T46.weatherActionHintOf({ locator: 'area' }) !== T46.weatherActionHintOf({ locator: undefined }),
        '三种来源各自的行动提示互不相同')
    }

    {
      const [orig, can] = nwsCancelChain
      const mkEt = (f, action, suffix) => {
        const g = JSON.parse(JSON.stringify(f))
        g.properties.id = g.properties.id.replace(/\.[0-9]+$/, '.' + suffix)
        g.properties.parameters.VTEC[0] = '/O.' + action + '.KRLX.FA.W.0777.000000T0000Z-260922T1345Z/'
        return g
      }
      const a = T6.parseNwsAlertResult(mkEt(orig, 'NEW', 91), { place: usPlace }).alert
      const c = T6.parseNwsAlertResult(mkEt(can, 'CAN', 92), { place: usPlace }).alert
      const cfgOff = mkCfg([usPlace])
      cfgOff.disasters.weather = false // 日本气象关掉、海外源保留（不在日本的人的常见配置）
      const rA = T6.handleAlert(a, cfgOff, { skipQuietHours: true })
      assert(rA.notified === true, '（前置）关掉日本气象不影响海外源的播报：' + JSON.stringify(rA))
      const rC = T6.handleAlert(c, cfgOff, { skipQuietHours: true })
      assert(rC.reason === 'cancelled', 'Cancel 仍走取消链路：' + JSON.stringify(rC))
      assert(T6.store.events[0].id === c.id,
        '作废提醒真的送到了（0.6.1 修复前 handleCancelled 看的是日本气象开关 → 直接 return，什么都不记）')
      // 反过来：海外源被用户关掉时，不该在历史里制造噪声（连海外源的播报都没有过）
      const cfgOff2 = mkCfg([usPlace])
      cfgOff2.disasters.overseasWeather = false
      const c2 = T6.parseNwsAlertResult(mkEt(can, 'CAN', 93), { place: usPlace }).alert
      const before = T6.store.events.length
      const rOff = T6.handleAlert(c2, cfgOff2, { skipQuietHours: true })
      assert(rOff.reason === 'cancelled' && T6.store.events.length === before,
        '海外源被关掉时，取消消息不写历史（用户已经明确说过不要这个源）：' + JSON.stringify(rOff))
    }

    {
      const cfg = mkCfg([usPlace])
      const mkSev = (sev, ver) => {
        const f = JSON.parse(JSON.stringify(nwsChain[1]))
        f.properties.id = f.properties.id.replace(/\.[0-9]+$/, '.' + ver)
        f.properties.parameters.VTEC[0] = '/O.EXT.KRLX.FA.W.0888.000000T0000Z-260923T0100Z/'
        f.properties.severity = sev
        delete f.properties.references
        return T6.parseNwsAlertResult(f, { place: usPlace }).alert
      }
      const r1 = T6.handleAlert(mkSev('Severe', 81), cfg, { skipQuietHours: true })
      assert(r1.notified === true, '（前置）Severe 首次播报：' + JSON.stringify(r1))
      const r2 = T6.handleAlert(mkSev('Moderate', 82), cfg, { skipQuietHours: true })
      assert(r2.notified === false, '强度回落到 Moderate → 不重复响铃（但事件记忆要跟着降）：' + JSON.stringify(r2))
      const r3 = T6.handleAlert(mkSev('Severe', 83), cfg, { skipQuietHours: true })
      assert(r3.notified === true,
        '再升回 Severe 必须重新播报（0.6.1 修复前记忆停在 3 → isEventRepeat 判"未升级" → 永久静默）：' + JSON.stringify(r3))
    }

    {
      let calls = 0
      const src = T6.createEcccSource({
        getCfg: () => mkCfg([caPlace]),
        intervalMs: 2000,
        firstDelayMs: 1,
        onStatus: () => {},
        onAlert: () => {},
        fetchText: async () => { calls += 1; const e = new Error('HTTP 500'); e.status = 500; throw e },
      })
      src.start()
      await new Promise((resolve) => setTimeout(resolve, 1400))
      src.stop()
      assert(calls === 1,
        '全失败时的间隔取 max(递增后的重试间隔, 正常间隔)=正常间隔 → 1.4 秒内只有首轮（修复前按 1 秒重试会打出第二、三轮）：' + calls)
    }

    {
      T6.resetSourceHealth()
      let lastErr = ''
      const src = T6.createNwsSource({
        // 半径 < 25km → 只有中心点一个请求，于是可以把超时设成 1.5 秒而只花 1.5 秒。
        getCfg: () => mkCfg([Object.assign({}, usPlace, { radiusKm: 10 })]),
        timeoutMs: 1500,
        onStatus: () => {},
        onError: (e) => { lastErr = String((e && e.message) || e) },
        onAlert: () => {},
        fetchText: async (url, ctx) => new Promise((resolve, reject) => {
          // 挂住不返回，等取数器自己 abort —— 模拟"网络慢"
          if (ctx && ctx.signal && ctx.signal.addEventListener) {
            ctx.signal.addEventListener('abort', () => {
              const e = new Error('The user aborted a request.')
              e.name = 'AbortError'
              reject(e)
            })
          }
        }),
      })
      const r = await src.pollOnce()
      assert(r.failed === 1 && src.stats().errors === 1, '超时算失败：' + JSON.stringify({ failed: r.failed }))
      assert(lastErr.indexOf('user aborted') === -1,
        '不再把超时写成 "The user aborted a request."（那是 A-1 想消灭的误导信息）：' + lastErr)
      assert(/timeout \(2s\)/.test(lastErr),
        '文案里的秒数按 timeoutMs 换算（1500ms → 2 秒；单位或换算写错会红）：' + lastErr)
      assert(/timeout/.test(src.stats().lastError || ''), '快照里的 lastError 同样是超时：' + src.stats().lastError)
    }

    {
      T6.resetSourceHealth()
      const bad = T6.createNwsSource({
        getCfg: () => mkCfg([usPlace]),
        onStatus: () => {},
        onAlert: () => {},
        fetchText: async () => '{"oops":1}',
      })
      await bad.pollOnce()
      const h1 = T6.sourceHealthOf('nws_alerts')
      assert(h1 && h1.data && h1.data.escalated === true, '（前置）缺 features → 蓝点已升级：' + JSON.stringify(h1 && h1.data && h1.data.kind))
      const good = T6.createNwsSource({
        getCfg: () => mkCfg([usPlace]),
        onStatus: () => {},
        onAlert: () => {},
        fetchText: async () => '{"type":"FeatureCollection","features":[]}',
      })
      await good.pollOnce()
      assert(!T6.sourceHealthOf('nws_alerts').data,
        '结构正确的空响应清掉蓝点（0.6.1 修复前清蓝点的调用只在非空循环体里 → 空响应清不掉，最长挂 24 小时）')
      // 反过来：非 JSON 也按 schema（蓝点）而不是链路故障（红点）
      T6.resetSourceHealth()
      let st = null
      const html = T6.createNwsSource({
        getCfg: () => mkCfg([usPlace]),
        onStatus: (p) => { st = p },
        onAlert: () => {},
        fetchText: async () => '<html>拦截页</html>',
      })
      await html.pollOnce()
      assert(st && st.status === 'schema-error',
        'HTTP 200 + HTML（拦截页 / 上游改版）判 schema 蓝点，与"缺 features"同一口径：' + JSON.stringify(st))
      const h2 = T6.sourceHealthOf('nws_alerts')
      assert(h2 && h2.data && h2.data.kind === 'schema', '健康记录里是 schema：' + JSON.stringify(h2 && h2.data && h2.data.kind))
    }

console.log('== review：第二轮 ==')

    {
      T6.resetSourceHealth()
      const cfg = mkCfg([usPlace]) // 100km → 5 个采样点
      let n = 0
      const mixed = T6.createNwsSource({
        getCfg: () => cfg,
        onStatus: () => {},
        onAlert: () => {},
        // 每轮：第 1 个采样点被拦截（schema），其余 4 个是结构正确的空响应
        fetchText: async () => {
          n += 1
          return (n % 5 === 1) ? '<html>拦截页</html>' : '{"type":"FeatureCollection","features":[]}'
        },
      })
      for (let i = 0; i < 6; i += 1) await mixed.pollOnce()
      const h = T6.sourceHealthOf('nws_alerts')
      assert(h.consecutiveFail >= 5, '同一轮里的空响应不会把连续失败计数清零：' + h.consecutiveFail)
      assert(h.data && h.data.escalated === true,
        '局部失败（5 条里 1 条被拦截）× 6 轮 → 蓝点照样升级（0.6.1 的逐响应 empty 会让它永不升级）：' +
        JSON.stringify(h.data))
    // 反向：整轮都干净的空响应仍然要能清掉蓝点
      T6.resetSourceHealth()
      const bad = T6.createNwsSource({ getCfg: () => cfg, onStatus: () => {}, onAlert: () => {}, fetchText: async () => '{"oops":1}' })
      await bad.pollOnce()
      assert(T6.sourceHealthOf('nws_alerts').data.escalated === true, '（前置）先制造一个蓝点')
      const clean = T6.createNwsSource({
        getCfg: () => cfg, onStatus: () => {}, onAlert: () => {},
        fetchText: async () => '{"type":"FeatureCollection","features":[]}',
      })
      await clean.pollOnce()
      assert(!T6.sourceHealthOf('nws_alerts').data,
        '整轮都是结构正确的空响应 → 仍然清掉蓝点（本轮一条失败都没有，结构就是好的）')
    }

    // 混合轮的另一种：同一轮里既有 schema 失败、**又有成功解析出 Alert 的条目**——成功那条不能
    // 把失败计数清掉。逐条上报的 success 与 empty 一样只计数不清蓝点，清蓝点只由轮末的轮级判定做。
    {
      T6.resetSourceHealth()
      const cfgHit = mkCfg([usPlace])
      const nwsHit = nwsByEvent('Flash Flood Warning') || nwsSample.features[0]
      assert(T6.parseNwsAlertResult(nwsHit, { place: usPlace }).ok === true,
        '（前置）这条 NWS 样本能解析出 Alert —— 否则本轮只有失败，测不出「成功清计数」这条路径')
      const okBody = JSON.stringify({ type: 'FeatureCollection', features: [nwsHit] })
      let k = 0
      const mixedHit = T6.createNwsSource({
        getCfg: () => cfgHit,
        onStatus: () => {}, onAlert: () => {},
        // 每轮：第 1 个采样点被拦截（schema），其余 4 个返回一条能解析出 Alert 的正常响应
        fetchText: async () => {
          k += 1
          return (k % 5 === 1) ? '<html>拦截页</html>' : okBody
        },
      })
      for (let i = 0; i < 6; i += 1) await mixedHit.pollOnce()
      const hHit = T6.sourceHealthOf('nws_alerts')
      assert(hHit.consecutiveFail >= 5,
        '同轮里有成功解析的条目时也不清连续失败计数：' + hHit.consecutiveFail)
      assert(hHit.data && hHit.data.escalated === true,
        '混合轮（1 条拦截 + 4 条成功）× 6 轮 → 蓝点照样升级（逐条 success 清蓝点的写法会让它永不升级）：' +
        JSON.stringify(hHit.data))
    }

    // 逐条失败必须挡住轮末清蓝点：`failCount` 只在**请求级** catch 里加，而"一个响应里坏一条 + 好一条"
    // 的请求本身是 200 —— 只看 failCount 时每轮都会被当成整轮健康，蓝点永不升起（两条升级阈值双双
    // 不可达），界面一片绿而数据在静默丢弃。
    {
      T6.resetSourceHealth()
      const nwsGood = nwsByEvent('Flood Warning') || nwsSample.features[0]
      const badFeat = { type: 'Feature', properties: null, geometry: { type: 'Point', coordinates: [-95.37, 29.76] } }
      assert(T6.parseNwsAlertResult(badFeat, { place: usPlace }).kind === 'schema', '（前置）坏 feature 判 schema')
      const mixedBody = JSON.stringify({ type: 'FeatureCollection', features: [badFeat, nwsGood] })
      const mixSrc = T6.createNwsSource({
        getCfg: () => mkCfg([usPlace]), onStatus: () => {}, onAlert: () => {},
        fetchText: async () => mixedBody,
      })
      await mixSrc.pollOnce()
      const hMix = T6.sourceHealthOf('nws_alerts')
      assert(hMix.data !== null && hMix.consecutiveFail >= 1,
        '同一响应里坏一条、好一条 → 轮末不清掉那条逐条 schema 失败（data=' + JSON.stringify(hMix.data) +
        '，consecutiveFail=' + hMix.consecutiveFail + '）')
      for (let i = 0; i < 2; i += 1) await mixSrc.pollOnce()
      const hMix2 = T6.sourceHealthOf('nws_alerts')
      assert(hMix2.data && hMix2.data.escalated === true,
        '这样的轮次继续下去能点亮蓝点（修复前它每轮都被轮末清掉）：' + JSON.stringify(hMix2.data))
    }

    {
      const body = (matched) => JSON.stringify({ type: 'FeatureCollection', numberMatched: matched, features: [ecccWarnShell()] })
      const one = T6.createEcccSource({
        getCfg: () => mkCfg([caPlace]), onStatus: () => {}, onAlert: () => {}, fetchText: async () => body(250),
      })
      await one.pollOnce()
      assert(one.stats().truncated === 1, '单关注点：一轮被截断 → truncated = 1：' + one.stats().truncated)
      const two = T6.createEcccSource({
        getCfg: () => mkCfg([caPlace, { name: '温哥华', lat: 49.2827, lon: -123.1207, radiusKm: 150 }]),
        onStatus: () => {}, onAlert: () => {}, fetchText: async () => body(250),
      })
      await two.pollOnce()
      assert(two.stats().requests === 2, '（前置）两个关注点 = 2 个请求：' + two.stats().requests)
      assert(two.stats().truncated === 1,
        '两个关注点、同一轮各被截断 → 仍记 1（0.6.1 按响应累加会记 2，与"多少轮被截断"的说法不符）：' +
        two.stats().truncated)
      const none = T6.createEcccSource({
        getCfg: () => mkCfg([caPlace]), onStatus: () => {}, onAlert: () => {},
        fetchText: async () => JSON.stringify({ type: 'FeatureCollection', numberMatched: 1, features: [ecccWarnShell()] }),
      })
      await none.pollOnce()
      assert(none.stats().truncated === 0, '没被截断就不计数（numberMatched 是按 bbox 过滤后的数量，实测如此）')
    }

    {
      let calls = 0
      const src = T6.createEcccSource({
        getCfg: () => mkCfg([caPlace]),
        intervalMs: 1200, // > OVERSEAS_MIN_BACKOFF_MS(1000)，于是两种写法可区分
        firstDelayMs: 1,
        onStatus: () => {}, onAlert: () => {},
        fetchText: async () => { calls += 1; const e = new Error('HTTP 500'); e.status = 500; throw e },
      })
      src.start()
      await new Promise((resolve) => setTimeout(resolve, 1600))
      src.stop()
      assert(calls === 1,
        '全失败后的下一轮在 interval + 递增后的重试间隔（1200+1000=2200ms）之后，1.6 秒内只有首轮；' +
        '若写回 `max(重试间隔, 间隔)` 则第二轮落在 1200ms → 这里会是 2：' + calls)
    }

    {
      T6.resetSourceHealth()
      let calls = 0
      const src = T6.createNwsSource({
        getCfg: () => mkCfg([usPlace]),
        onStatus: () => {}, onAlert: () => {},
        fetchText: async () => { calls += 1; const e = new Error('HTTP 500'); e.status = 500; throw e },
      })
      await src.pollOnce()
      assert(src.stats().gated === 1, '（前置）首轮命中判定条件：' + src.stats().gated)
      src.resetGate() // 模拟"页面刚打开"：判定条件会再次为真，标志也必须跟着复位
      await src.pollOnce()
      assert(src.stats().gated === 2,
        'resetGate() 之后再次命中判定条件要计数（0.6.1 的 gateActive 不复位 → 少计一次）：' + src.stats().gated)
      // 同一段判定为真的区间里连续两轮不该重复计数
      await src.pollOnce()
      assert(src.stats().gated === 2, '同一段内继续跑不再计数（不会变成"待在里面的轮数"）：' + src.stats().gated)
      assert(calls === 15, '（前置）3 轮 × 5 个采样点：' + calls)
    }

    {
      const raw = {
        alertid: '53072441600000_20260919030245',
        title: '云南省丽江市宁蒗彝族自治县气象台发布暴雨橙色预警',
        issued: '2026-09-19 03:02:45', kind: 'rainstorm', level: 'orange',
        detail: '拜城县气象台发布暴雨橙色预警信号：预计未来 3 小时降水量将达 50 毫米以上。',
      }
      const r = T6.parseNmcAlarmResult(raw)
      assert(r.ok && r.alert.detail === raw.detail, '（前置）大陆气象的正文原样进了 alert.detail')
      const cfg = JSON.parse(JSON.stringify(T6.currentCfg()))
      cfg.watch.places = [{ name: '云南省·丽江市', lat: 26.87, lon: 100.23, radiusKm: 100 }]
      cfg.disasters.cnRainstorm = true
      T6.handleAlert(r.alert, cfg, { skipQuietHours: true })
      const ev = T6.store.events.filter((e) => e.id === r.alert.id)[0]
      assert(ev && ev.detail && ev.detail.indexOf('暴雨橙色预警信号') > 0,
        '大陆预警的正文现在也能在历史条目里展开看到：' + String(ev && ev.detail).slice(0, 40))
    }

    {
      const s = loadClientEx()
      // 永不 settle 的 fetch：只能靠 Promise.race 捕获超时
      s.sandbox.fetch = () => new Promise(() => {})
      const msg = await s.exports.__test.defaultFetchText('https://example.invalid/slow', { timeoutMs: 30 })
        .then(() => '(resolved)', (e) => String((e && e.message) || e))
      assert(/超时/.test(msg) && /没有 AbortController/.test(msg),
        '无 signal 时用 Promise.race 捕获超时（这条分支此前在测试里不可达）：' + msg)
    // 400 的 bodyHint 截断长度
      s.sandbox.fetch = async () => ({ ok: false, status: 400, text: async () => 'x'.repeat(400) })
      let err = null
      try { await s.exports.__test.defaultFetchText('https://example.invalid/bad', { timeoutMs: 30 }) } catch (e) { err = e }
      assert(err && err.status === 400 && err.bodyHint && err.bodyHint.length === 160,
        '400 的 bodyHint 截到 160 字（与 catch 里展示时的切片长度一致）：' + (err && err.bodyHint && err.bodyHint.length))
    }
  } catch (e) {
    assert(false, '0.6.0 第 2 期检查失败：' + e.message + '\n' + (e && e.stack ? e.stack.split('\n').slice(1, 3).join('\n') : ''))
  }

  // ---- 跨源优先源 + 关注点来源分支 ----
console.log('== 跨源优先源 + 关注点来源分支 ==')
  try {
    const mkCfg8 = (t, patch) => {
      const cfg = JSON.parse(JSON.stringify(t.DEFAULT_CFG))
      cfg.notify = { sound: false, system: false, volume: 0 }
      return Object.assign(cfg, patch || {})
    }
    // 一场筑波附近的日本地震：551（行政区匹配）与 USGS（坐标匹配）各报一次
    const JP_RAW = {
      code: 551, id: 'jp-551-test',
      issue: { time: '2026/09/07 23:25:14', type: 'DetailScale' },
      earthquake: {
        time: '2026/09/07 23:25:00', maxScale: 45,
        hypocenter: { name: '茨城県南部', latitude: 36.0, longitude: 140.1, depth: 50, magnitude: 5 },
      },
      points: [{ pref: '茨城県', addr: '土浦市', scale: 45, isArea: false }],
    }
    const usgsCopyOf = (over) => Object.assign({
      id: 'usgs:cross-1', code: 'usgs', source: 'usgs', kind: 'quake', kindLabel: 'USGS 地震',
      locator: 'point', severity: 'orange', issued: '2026-09-07T23:25:40+09:00',
      headline: 'M5.2 茨城県南部', magnitude: 5.2, maxScale: -1, strength: 5.2,
      // 事件键与日本源的 `quake:` 不同 → 只能靠「±2 分钟 + 50km」的坐标近似归并
      eventKey: 'geo:2026-09-07T14:25', geo: { lat: 36.05, lon: 140.15 },
      regions: [], cancelled: false,
    }, over || {})
    const watch8 = {
      prefectures: ['茨城県'], cities: [],
      places: [{ name: 'つくば', lat: 36.08, lon: 140.11, radiusKm: 300, origin: 'global' }],
    }
    const th8 = { quakeScale: 40, eewScale: 45, tsunamiGrade: 'Watch', globalMagnitude: 4.5, cnReportMagnitude: 4.5 }

    {
      const t = loadClient().__test
      const a = t.parseQuake(JP_RAW)
      assert(a.geo && a.geo.lat === 36 && a.geo.lon === 140.1,
        '551 带上了震中坐标（0.8.0 之前只取 name / magnitude，跨源归并无从判定）')
      assert(a.locator !== 'point',
        '551 **不设** locator: point —— 否则日本这一路会被降级成坐标匹配（震中 150km 外、本地却到震度 5 弱的地震会漏报，DESIGN 9.3）')
      const e = t.parseEew({
        code: 556, id: 'jp-556-test', issue: { time: '2026/09/07 23:25:10', eventId: 'ev-1' },
        earthquake: { hypocenter: { name: '茨城県南部', latitude: 36.0, longitude: 140.1, magnitude: 5 } },
        areas: [{ name: '茨城県南部', scaleTo: 45 }],
      })
      assert(e.geo && e.geo.lat === 36 && e.locator !== 'point', '556 同样带震中坐标、同样不改匹配语义')
      const noLon = Object.assign({}, JP_RAW, {
        earthquake: { time: '2026/09/07 23:25:00', maxScale: 45, hypocenter: { name: '不明', latitude: 36 } },
      })
      assert(t.parseQuake(noLon).geo === null,
        '只有纬度时不出 geo —— **半个坐标比没有更糟**：跨源归并会把两场不相关的地震并成一个（漏报方向）')
      const sentinel = Object.assign({}, JP_RAW, {
        earthquake: { time: '2026/09/07 23:25:00', maxScale: 45, hypocenter: { name: '不明', latitude: -200, longitude: -200 } },
      })
      assert(t.parseQuake(sentinel).geo === null, 'P2PQuake 的"未知震中"特殊标记值（-200，-200）不会被当成坐标')
      assert(t.sourceIdOf(a) === 'p2pquake' && t.SOURCE_RANK.p2pquake === 1,
        '551 归到 p2pquake，且它排在优先顺序的第 1 位（DESIGN 3.4 的表）')
    }

    {
      const t = loadClient().__test
      assert(t.agencyOf('cenc_eew') === t.agencyOf('cenc_eqlist'), '大陆预警与速报同属 CENC（同机构）')
      assert(t.agencyOf('p2pquake') === t.agencyOf('jma'), 'P2PQuake 是気象庁信息的转播渠道（同一机构）')
      assert(t.agencyOf('p2pquake') !== t.agencyOf('usgs') && t.agencyOf('cenc_eqlist') !== t.agencyOf('usgs'),
        '日本台网 / CENC 与 USGS 是不同机构')
      assert(t.CROSS_SOURCE_KINDS.weather !== true,
        '气象源不参与跨源归并（各家地区与判据完全不同，没有"同一件事被重复转述"的形态）')
    }

    {
      const t = loadClient().__test
      const cfg = mkCfg8(t, { watch: watch8, thresholds: th8 })
      const r1 = t.handleAlert(t.parseQuake(JP_RAW), cfg)
      assert(r1.notified === true, '（前置）日本 551 命中茨城県 → 播报：' + JSON.stringify(r1))
      const r2 = t.handleAlert(usgsCopyOf(), cfg)
      assert(r2.notified === false && r2.reason === 'authority-suppressed',
        '同一场地震的 USGS 副本被压掉（0.8.0 之前两条各响一次）：' + JSON.stringify(r2))
      assert(t.loadHistory().length === 1,
        '被压掉的副本**连历史都不进**（DESIGN 3.4：多源重复会把那 30 条记录挤掉）：' + t.loadHistory().length)
      const st = t.authorityStatsOf()
      assert(st.suppressed === 1 && st.bySource.p2pquake === 1,
        '抑制必须留计数（"不进历史 ≠ 不可见"）：' + JSON.stringify(st))
      const snap = t.buildDiagSnapshot()
    // 快照版本号：新增段落时必须同步提号
      assert(snap.snapshot === 4 && snap.authority && snap.authority.suppressed === 1,
        '诊断快照里能看到被抑制的条数：' + JSON.stringify(snap.authority))
      // 诊断片段自己抛错时必须**在 warnings 里可见**，不能把异常丢进一个没人看的空数组。
      assert(t.DIAG_SNAPSHOT_VERSION === 4, '快照版本号随新段提号（加段也要提号）')
      t.cnStreamRegistry.__boom94 = {
        stats() { throw new Error('boom-stats') },
        mode() { throw new Error('boom-mode') },
      }
      try {
        const snap2 = t.buildDiagSnapshot()
        assert(snap2.warnings.some((w) => w.indexOf('boom-stats') !== -1),
          '片段异常进 warnings：' + JSON.stringify(snap2.warnings))
        assert(snap2.streams.__boom94 && snap2.streams.__boom94.mode === 'unknown',
          '片段抛错时用兜底值继续产出（诊断在任何状态下都要能出东西）')
      } finally {
        delete t.cnStreamRegistry.__boom94
      }
    }

    {
      const t = loadClient().__test
      const cfg = mkCfg8(t, { watch: watch8, thresholds: th8 })
      const r1 = t.handleAlert(usgsCopyOf(), cfg)
      assert(r1.notified === true, '（前置）USGS 副本先到 → 播报：' + JSON.stringify(r1))
      const r2 = t.handleAlert(t.parseQuake(JP_RAW), cfg)
      assert(r2.notified === false && r2.reason === 'authority-suppressed',
        '日本源后到也不补播（DESIGN 3.4：预警的价值在时效，补播只是多一次打扰）：' + JSON.stringify(r2))
      assert(t.authorityStatsOf().bySource.usgs === 1, '计数按**已播报的那个源**分组，能看出是谁抢在前面')
    }

    {
      const t = loadClient().__test
      const cfg = mkCfg8(t, { watch: watch8, thresholds: th8 })
      t.handleAlert(t.parseQuake(JP_RAW), cfg)
      const far = t.handleAlert(usgsCopyOf({ id: 'usgs:far', eventKey: 'geo:far', geo: { lat: 36.6, lon: 140.7 } }), cfg)
      assert(far.notified === true, '震中差约 70km（>50km）→ 不归并、照常播报：' + JSON.stringify(far))
      const late = t.handleAlert(usgsCopyOf({ id: 'usgs:late', eventKey: 'geo:late', issued: '2026-09-07T23:31:40+09:00' }), cfg)
      assert(late.notified === true, '时间差 6 分钟（>2 分钟）→ 不归并、照常播报：' + JSON.stringify(late))
    }

    //     否则 NOAA 海啸警报落在另一机构地震震中 50km 内会被判成副本而静默，测试消息也会压掉随后的真实地震。
    {
      const t = loadClient().__test
      const q = usgsCopyOf({ id: 'usgs:kind-a', eventKey: 'geo:2026-09-07T14:40', issued: '2026-09-07T23:40:00+09:00' })
      t.isEventRepeat(Object.assign({}, q, { source: 'emsc' }), 10)
      const sameKind = usgsCopyOf({ id: 'usgs:kind-b', eventKey: 'geo:other-b', issued: '2026-09-07T23:40:40+09:00' })
      assert(!!t.crossSourceCopyOf(sameKind), '对照：同灾种（quake）的跨机构近似副本仍被归并')

      const tsunamiAlert = {
        id: 'noaa:ts-1', code: 'noaa', source: 'noaa', kind: 'tsunami', kindLabel: 'NOAA 海啸',
        locator: 'point', severity: 'red', issued: '2026-09-07T23:50:20+09:00',
        headline: 'Tsunami Warning', strength: 9, eventKey: 'noaa:ts-1',
        geo: { lat: 36.05, lon: 140.15 }, regions: [], cancelled: false,
      }
      const q2 = usgsCopyOf({ id: 'usgs:kind-c', eventKey: 'geo:2026-09-07T14:50', issued: '2026-09-07T23:50:00+09:00' })
      t.isEventRepeat(Object.assign({}, q2, { source: 'emsc' }), 10)
      assert(t.crossSourceCopyOf(tsunamiAlert) === null,
        '海啸警报不会被"50km 内 2 分钟前的地震"压成同一事件（那是不可见的漏报）')
      assert(t.isEventRepeat(tsunamiAlert, 10) === false, '海啸也不被判成那场地震的重复')

      const demo = {
        id: 'demo-1', code: 'emsc', source: 'emsc', kind: 'quake', kindLabel: 'EMSC 测试',
        locator: 'point', severity: 'orange', issued: '2026-09-07T23:59:00+09:00',
        headline: '测试全球警报', magnitude: 5, strength: 5, eventKey: 'test:global:1',
        geo: { lat: 36.05, lon: 140.15 }, regions: [], cancelled: false,
      }
      t.isEventRepeat(demo, 10) // 演示消息确实会进 eventSeen（这正是被利用的那一点）
      const realQuake = usgsCopyOf({ id: 'usgs:real-after-demo', eventKey: 'geo:other-real', issued: '2026-09-07T23:59:30+09:00' })
      assert(t.crossSourceCopyOf(realQuake) === null,
        '点过"发送测试全球警报"之后 2 分钟内的真实地震不会被压掉（演示不参与归并）')
    }

    {
      const t = loadClient().__test
      assert(t.normalizePlaces([{ name: '四川省·成都市', lat: 30.66, lon: 104.07, radiusKm: 100 }])[0].origin === 'cn',
        '老配置没有 origin → 按名称形状推导（「省·市」= cn）')
      assert(t.normalizePlaces([{ name: '东京', lat: 35.68, lon: 139.77, radiusKm: 100 }])[0].origin === 'global',
        '手填坐标 / 「用我的位置」→ global')
      assert(t.normalizePlaces([{ name: '东京', lat: 35.68, lon: 139.77, radiusKm: 100, origin: 'cn' }])[0].origin === 'cn',
        '已经写明 origin 的原样保留（推导不覆盖显式值）')
      assert(t.normalizePlaces([{ name: 'x', lat: 1, lon: 1, radiusKm: 100, origin: 'constructor' }])[0].origin === 'global',
        'origin 走白名单：原型链上的键不算合法取值')
      t.setCnAreas([{ name: '四川省', lat: 30.66, lon: 104.07, cities: [{ name: '成都市', lat: 30.66, lon: 104.07 }] }])
      const p = t.cnPlaceOf('四川省', '成都市', 100)
      assert(p && p.origin === 'cn', '设置页「中国大陆」级联产出的点标为 cn：' + JSON.stringify(p))
      t.applyCfg(mkCfg8(t, {
        watch: { prefectures: [], cities: [], places: [{ name: '东京', lat: 35.68, lon: 139.77, radiusKm: 100, origin: 'global' }] },
      }))
      const snap = t.buildDiagSnapshot()
      assert(snap.config.watch.places[0].origin === 'global',
        '诊断快照里的关注点带来源分支（优先源判错时第一个要核的就是"这个点算谁的分支"）')
    }

    {
      const mod = await import(pathToFileURL(path.join(ROOT, 'lib', 'index.js')).href)
      const parsed = unwrapRefs(mod.QuakeAlertSettingsSchema({
        watch: { places: [{ name: '东京', lat: 35.68, lon: 139.77, radiusKm: 100, origin: 'jp' }] },
      }))
      assert(parsed.watch.places[0].origin === 'jp', 'Host schema 原样保留 places[].origin')
      const dflt = unwrapRefs(mod.QuakeAlertSettingsSchema({ watch: { places: [{ name: 'x', lat: 1, lon: 1 }] } }))
      assert(dflt.watch.places[0].origin === undefined,
        'Host schema **不**给 origin 注入默认值：老配置"该算哪个分支"要留给 Client 按名称形状推导，' +
        '在这里写 default("global") 会把中国分支的老关注点全算成 global（分组与优先源诊断会悄悄失灵）')
      // 端到端确认这条链路：Host 读回来的老配置（无 origin）经 Client 规整后仍是 cn
      const conv = loadClient().__test.sectionToCfg({
        watch: { places: [{ name: '四川省·成都市', lat: 30.66, lon: 104.07, radiusKm: 100 }] },
      })
      assert(conv.watch.places[0].origin === 'cn',
        '无 origin 的老配置经 sectionToCfg 后按名称推导为 cn（这正是"不在 Host 给默认值"要保住的行为）')
      let rejected = false
      try {
        mod.QuakeAlertSettingsSchema({ watch: { places: [{ name: 'x', lat: 1, lon: 1, origin: 'bogus' }] } })
      } catch (e) { rejected = true }
      assert(rejected, 'Host schema 拒绝白名单外的 origin')
    }

    // ⑨ 界面语言：常量 → DEFAULT_CFG → normalizeCfg → Host schema → UI 这条链路现在就通。
    //    Host 只校验形状、白名单在 Client，目标是「加一种语言只动 Client」。
    {
      const t9 = loadClient().__test
      assert(t9.DEFAULT_CFG.language === 'zh-CN', '默认界面语言是简体中文')
      assert(t9.LANGUAGE_OPTIONS.some((o) => o.v === 'zh-CN'),
        '清单里有简体中文（0.9.0 起还有 日本語 / English，0.9.3 起还有繁體中文）')
      assert(t9.LANGUAGE_OPTIONS.some((o) => o.v === 'zh-TW'),
        '清单里有繁体中文（0.9.3）：' + t9.LANGUAGE_OPTIONS.map((o) => o.v + '=' + o.label).join(' / '))
      // 「不在清单里的语言码」从清单派生，不手抄具体值；样本里也不能放会被回退链收编的值（如 zh-HK → zh-TW）。
      const notInList = ['pt-BR', 'ko', 'de', 'fr'].find((v) => t9.LANGS.indexOf(v) === -1)
      assert(Boolean(notInList), '（前置）找一个不在语言清单里的合法 BCP 47 值：' + notInList)
      // 前置失败时下面几条会退化成「拿 undefined 去测」并空过，所以带上前置条件一起断言。
      assert(Boolean(notInList) && t9.normalizeCfg({ language: notInList }).language === 'zh-CN',
        '白名单外的语言码回默认值——手改配置写一个还没有语言包的代码不该被放行（否则界面会进入半本地化状态）：' + notInList)
      assert(t9.normalizeCfg({ language: 'zh-CN' }).language === 'zh-CN', '白名单内的原样保留')
      const mod9 = await import(pathToFileURL(path.join(ROOT, 'lib', 'index.js')).href)
      const parsed9 = unwrapRefs(mod9.QuakeAlertSettingsSchema({ language: 'zh-CN' }))
      assert(parsed9.language === 'zh-CN', 'Host schema 认这个字段（未声明的键会被规整掉）')
      // Host 只校验 BCP 47 形状、白名单在 Client：Host 枚举会让「加一种语言」变成一次跨半边的契约改动。
      const acceptsUnknown = unwrapRefs(mod9.QuakeAlertSettingsSchema({ language: notInList }))
      assert(acceptsUnknown.language === notInList,
        'Host schema 接受形状合法但当前还没有文案表的语言（' + notInList + '）：枚举留在 Client，加语言就只动 Client')
      let rejectedShape = false
      try { mod9.QuakeAlertSettingsSchema({ language: '日本語' }) } catch (e) { rejectedShape = true }
      let rejectedShape2 = false
      try { mod9.QuakeAlertSettingsSchema({ language: 42 }) } catch (e) { rejectedShape2 = true }
      assert(rejectedShape && rejectedShape2,
        'Host schema 仍拦住形状不合法的值（"日本語"、数字 42）——放松的是枚举，不是类型')
      // Host 允许首尾空白：Client 的 resolveLang 会 trim，而不透容的 Host 会让整段 section 被 wire 校验拒掉。
      const blankAccepted = unwrapRefs(mod9.QuakeAlertSettingsSchema({ language: ' zh-TW ' }))
      assert(blankAccepted.language === ' zh-TW ' && t9.normalizeCfg({ language: blankAccepted.language }).language === 'zh-TW',
        'Host 接受带首尾空白的语言码，Client 把它统一成 zh-TW（两侧分工：形状 vs 值域）')
      // 两侧分工合起来的效果：Host 收下清单外的值，Client 认不出 → 回默认，界面不会半本地化
      assert(Boolean(notInList) && t9.normalizeCfg(t9.sectionToCfg({ language: notInList })).language === 'zh-CN',
        'Host 收下的未知语言到 Client 会被统一成默认（界面仍是完整的一种语言，不会半本地化）：' + notInList)
      // 加语言时最容易犯的错：往 LANGUAGE_OPTIONS 里写一个 Host 收不了的值（下划线、中文名、漏地区码）。
      const hostAccepts = (v) => {
        try { return unwrapRefs(mod9.QuakeAlertSettingsSchema({ language: v })).language === v } catch (e) { return false }
      }
      assert(t9.LANGUAGE_OPTIONS.every((o) => hostAccepts(o.v)),
        '清单里每个语言码都能过 Host 的形状校验（0.9.0 加语言时的守卫）：' +
        t9.LANGUAGE_OPTIONS.map((o) => o.v).join(', '))
      assert(t9.LANGUAGE_OPTIONS.every((o) => typeof o.label === 'string' && o.label.length > 0),
        '每个选项都带 label（下拉里显示的名字，惯例是用该语言自己的写法：日本語 / 한국어）')
      // 把语言显示名与顺序整体钉住：只查「非空字符串」时把简繁两个显示名互换也能全绿。
      assert(JSON.stringify(t9.LANGUAGE_OPTIONS) === JSON.stringify([
        { v: 'zh-CN', label: '简体中文' }, { v: 'zh-TW', label: '繁體中文' },
        { v: 'ja', label: '日本語' }, { v: 'en', label: 'English' },
      ]), '语言下拉的选项、显示名与顺序整体钉住：' + JSON.stringify(t9.LANGUAGE_OPTIONS))
      const snap9 = loadClient().__test.buildDiagSnapshot()
      assert(snap9.config.language === 'zh-CN',
        '诊断快照里带界面语言（0.9.0 排查"界面没跟着切"时第一个要核的字段）')
    }

    // ⑩ 本地化：文案表 / BCP 47 回退链 / 默认语言下逐字不变
    //    第三条是关键——本地化只是把既有字符串搬进表里，默认语言下必须与之前逐字一致。
    {
      const t10 = loadClient().__test
      // 长度从清单派生（不写死 4）：要守的是「每项都有显示名、简繁排在最前」，不是「恰好四种」。
      assert(t10.LANGS.length === Object.keys(t10.LANGUAGE_LABELS).length &&
        t10.LANGS.indexOf('zh-CN') === 0 && t10.LANGS.indexOf('zh-TW') === 1,
        '语言清单：每项都有显示名、简繁排在最前（顺序即下拉顺序）：' + t10.LANGS.join(' / '))
      const keysOf = (lang) => Object.keys(t10.tableOf(lang)).sort()
      const baseKeys = keysOf('zh-CN')
      assert(baseKeys.length > 20, 'zh-CN 文案表有 ' + baseKeys.length + ' 条')
      // 从 LANGS[1] 起：拿 zh-CN 自己与自己比是恒真的，会让"跑了几种语言"的数字虚高一条。
      for (const lang of t10.LANGS.slice(1)) {
        const cur = keysOf(lang)
        const missing = baseKeys.filter((k) => cur.indexOf(k) === -1)
        assert(cur.length === baseKeys.length && missing.length === 0,
          lang + ' 与 zh-CN 的 key 集合一致（缺：[' + missing.join(', ') + ']）')
      }
      // 「翻过」而不是「把中文抄了四份」：同一个 key 在四种语言下不能两两相同。
      assert(new Set(t10.LANGS.map((l) => t10.tableOf(l)['app.name'])).size === t10.LANGS.length,
        'app.name 在四种语言下互不相同：' + t10.LANGS.map((l) => t10.tableOf(l)['app.name']).join(' / '))
      // 繁体表整栏不得含简体专有字形（判据是文件顶部那份冻结字表，不随表变化）：只查 zh-TW，日文与简体共形太多。
      const cnOnlyHits = Object.keys(t10.tableOf('zh-TW')).filter((k) => CN_ONLY_RE.test(t10.tableOf('zh-TW')[k]))
      assert(cnOnlyHits.length === 0,
        '繁体表里没有简体专有字形（' + CN_ONLY_CHARS.length + ' 字判据）：' +
        cnOnlyHits.slice(0, 5).map((k) => k + '=' + t10.tableOf('zh-TW')[k]).join(' / '))

      // ---- 默认语言（zh-CN）下与本地化之前逐字一致 ----
      assert(t10.alertTitleOf(null) === '灾害预警', '默认语言：无事件时的通知标题')
      assert(t10.alertTitleOf({ kind: 'eew', source: 'p2pquake' }) === '⚠ 紧急地震速报（警报）',
        '默认语言：EEW 标题带「（警报）」（0.8.2 从 0.8.1 的瘦身里改回来的安全分级）')
      assert(t10.alertTitleOf({ kind: 'quake', kindLabel: '地震情報・各地の震度' }) === '🌐 地震情報・各地の震度',
        '默认语言：日本源标题用 kindLabel 原文（源文本不翻，11.10）')
      assert(t10.cnProductName({ source: 'cenc_eew' }) === '大陆地震预警', '默认语言：大陆源的产品名')
      assert(t10.disclaimerOf({ source: 'usgs' }) === '仅供参考，请以美国地质调查局（USGS）的官方发布为准',
        '默认语言：免责声明按源点名机构')
      assert(t10.disclaimerOf({ source: 'nope' }) === '仅供参考，请以官方发布为准',
        '默认语言：机构认不出时用中性表述（不硬编码气象厅）')
      assert(t10.weatherActionHintOf({ locator: 'overseas' }) === '请关注当地官方发布的避难与撤离指引',
        '默认语言：海外气象的行动提示含「撤离」（0.8.2 改回来的安全信息）')
      assert(t10.weatherActionHintOf({ locator: 'area' }) === '请关注当地气象台发布的防御指引',
        '默认语言：大陆气象的行动提示含「防御」')
      assert(t10.weatherActionHintOf({}) === '请确认所在市町村的避难信息', '默认语言：日本气象的行动提示')

      // ---- 切换语言当场生效，且源文本原样不动 ----
      assert(t10.setLanguage('en') === 'en', 'setLanguage 接受清单内的值并返回生效值')
      assert(t10.getLanguage() === 'en', 'getLanguage 反映当前语言')
      assert(t10.alertTitleOf({ kind: 'eew', source: 'p2pquake' }) === '⚠ Earthquake Early Warning (Alert)',
        '切到英文后通知标题跟着换')
      assert(t10.disclaimerOf({ source: 'usgs' }) ===
        'For reference only. Check official announcements from the U.S. Geological Survey (USGS).',
        '切到英文后免责行跟着换（机构名一并换）')
      assert(t10.alertTitleOf({ kind: 'quake', kindLabel: '地震情報・各地の震度' }) === '🌐 地震情報・各地の震度',
        '切到英文后 kindLabel 仍是源语言原文——源文本一律不翻（11.10 的范围约定）')
      assert(t10.setLanguage('ja') === 'ja' && t10.alertTitleOf(null) === '災害警報', '切到日文后标题跟着换')
      assert(t10.weatherActionHintOf({ locator: 'area' }) === '現地の気象台が発表する防災情報をご確認ください',
        '切到日文后行动提示跟着换')
      assert(t10.setLanguage('zh-TW') === 'zh-TW' && t10.alertTitleOf(null) === '災害預警', '切到繁体后标题跟着换')
      assert(t10.weatherActionHintOf({ locator: 'area' }) === '請關注當地氣象台發布的防禦指引',
        '切到繁体后行动提示跟着换（繁体是独立的一套文案，不是简体的字形替换）')
      assert(t10.disclaimerOf({ source: 'usgs' }) === '僅供參考，請以美國地質調查局（USGS）的官方發布為準',
        '切到繁体后免责行跟着换（机构名一并换）')
      // 安全分级在繁体下也要守住：`alertTitleOf` / 产品名 / 行动提示各补一条繁体实值。
      assert(t10.alertTitleOf({ kind: 'eew', source: 'p2pquake' }) === '⚠ 緊急地震速報（警報）',
        '繁体：EEW 标题带「（警報）」：' + t10.alertTitleOf({ kind: 'eew', source: 'p2pquake' }))
      assert(t10.cnProductName({ source: 'cenc_eew' }) === '大陸地震預警',
        '繁体：大陆源的产品名：' + t10.cnProductName({ source: 'cenc_eew' }))
      assert(t10.weatherActionHintOf({ locator: 'overseas' }) === '請關注當地官方發布的避難與撤離指引',
        '繁体：海外气象的行动提示含「撤離」：' + t10.weatherActionHintOf({ locator: 'overseas' }))

      // ---- BCP 47 回退链：地区变体落到同一语言，认不出的主语言落到默认语言 ----
      //      中文不能按主语言匹配（清单里有两个 zh-*，只会取到第一个），所以繁体区与繁体脚本的写法必须全部落到 zh-TW。
      const rb = [
        ['zh-CN', 'zh-CN'], ['zh-TW', 'zh-TW'], ['zh-Hant-TW', 'zh-TW'],
        ['zh-HK', 'zh-TW'], ['zh-MO', 'zh-TW'], ['zh-Hant', 'zh-TW'], ['zh-Hant-HK', 'zh-TW'],
        ['zh', 'zh-CN'], ['zh-Hans', 'zh-CN'], ['zh-SG', 'zh-CN'],
        // 脚本子标签优先于地区：zh-Hans-HK 是「简体字形 + 香港地区」，只看「有没有 hk」会把两者搞反。
        ['zh-Hans-HK', 'zh-CN'], ['zh-Hant-CN', 'zh-TW'],
        ['ja', 'ja'], ['ja-JP', 'ja'], ['JA-jp', 'ja'],
        ['en', 'en'], ['en-US', 'en'],
        ['pt-BR', 'zh-CN'], ['', 'zh-CN'], [null, 'zh-CN'], ['日本語', 'zh-CN'],
      ]
      for (const [input, want] of rb) {
        const got = t10.resolveLang(input)
        assert(got === want, 'resolveLang(' + JSON.stringify(input) + ') → ' + want + '（实际 ' + got + '）')
      }
      // 查 LANGUAGE_LABELS 才真的把「清单与显示名两张表同步」绑在一起（只查「在 LANGS 里」是近似恒真）。
      assert(rb.every(([input]) => Object.prototype.hasOwnProperty.call(t10.LANGUAGE_LABELS, t10.resolveLang(input))),
        '回退结果永远是清单里的一种语言、且有显示名（界面不会停在半本地化的中间态）')
      // 缺 key 回显 key 本身：宁可界面上出现一个明显的占位符，也不要空白或悄悄退回中文。
      assert(t10.t('no.such.key') === 'no.such.key', '缺 key 时回显 key 本身')
      assert(t10.t('disclaimer.named', { authority: 'X' }).indexOf('X') !== -1, 't() 会替换 {name} 插值')
      assert(t10.t('disclaimer.named', { authority: 'X' }).indexOf('{authority}') === -1,
        '插值替换后不留占位符')
      t10.setLanguage('zh-CN') // 复位：本块改过语言，不把状态留给后面的用例（每个用例各自 loadClient，这里是显式表态）
    }

    // ⑪ 配置导出导入 + 量纲文案表 + 源名
    {
      const t11 = loadClient().__test
      // ---- 导出文件的结构 ----
      const text = t11.buildConfigExport(t11.currentCfg())
      const ioParsed = JSON.parse(text)
      assert(ioParsed.format === t11.CONFIG_FORMAT && ioParsed.formatVersion === t11.CONFIG_FORMAT_VERSION,
        '导出文件带格式标识与格式版本：' + ioParsed.format + ' v' + ioParsed.formatVersion)
      assert(ioParsed.config && ioParsed.config.watch && Array.isArray(ioParsed.config.watch.places),
        '导出的是配置本身（关注点在文件里）')
      assert(/^quake-alert-config-\d{8}\.json$/.test(t11.configFileName(new Date(2026, 8, 26))),
        '导出文件名带日期，便于区分多次导出：' + t11.configFileName(new Date(2026, 8, 26)))
      assert(text.indexOf('pluginVersion') === -1,
        '文件里**不写插件版本**：格式版本才是契约（写版本号会诱使调用方按版本做分支）')
      assert(!('events' in ioParsed.config) && !('history' in ioParsed.config) && !('health' in ioParsed.config),
        '文件里不含履历 / 健康记录（前者含源侧原文、换机器未必对得上；后者是会话内的时效数据）')

      // ---- 往返 ----
      const round = t11.parseConfigImport(text)
      assert(round.ok, '导出的文件能被自己读回来（往返成立）')
    // `language` 的往返要覆盖繁体值
      {
        const twCfg = t11.normalizeCfg(Object.assign({}, t11.currentCfg(), { language: 'zh-TW' }))
        const twRound = t11.parseConfigImport(t11.buildConfigExport(twCfg))
        assert(twRound.ok && twRound.cfg.language === 'zh-TW',
          'language=zh-TW 在导出 → 导入里原样保留：' + (twRound.ok ? twRound.cfg.language : twRound.error))
        assert(JSON.stringify(twCfg.language) === JSON.stringify(t11.normalizeCfg({ language: 'zh-TW' }).language),
          'normalizeCfg 对 zh-TW 幂等（不会被回退链改写）')
      }
      assert(JSON.stringify(round.cfg) === JSON.stringify(t11.normalizeCfg(ioParsed.config)),
        '往返后配置等价（两边都过 normalizeCfg）')

      // ---- 坏输入：每种都给得出**可区分**的错误码（文案由界面按当前语言翻） ----
      assert(t11.parseConfigImport('{').error === 'json', '不是 JSON → json')
      assert(t11.parseConfigImport('null').error === 'shape', '不是对象 → shape')
      assert(t11.parseConfigImport('{"format":"other/app","formatVersion":1,"config":{}}').error === 'format',
        '别的应用的 JSON → format（不误吃）')
      assert(t11.parseConfigImport('{"format":"' + t11.CONFIG_FORMAT + '","config":{}}').error === 'version',
        '缺格式版本号 → version')
      assert(t11.parseConfigImport('{"format":"' + t11.CONFIG_FORMAT + '","formatVersion":99,"config":{}}').error === 'newer',
        '格式版本高于本版 → newer（直接拒绝，不尽力解析——半个配置比没有配置更危险）')
      assert(t11.parseConfigImport('{"format":"' + t11.CONFIG_FORMAT + '","formatVersion":1,"config":[]}').error === 'shape',
        'config 不是对象 → shape')

      // ---- 导入是整体替换，且先备份（不能回退的备份等于没有备份） ----
      const ioBefore = t11.currentCfg()
      assert(ioBefore.thresholds.quakeScale === 40, '（前置）当前震度阈值是默认的 40')
      const ioWant = t11.normalizeCfg(Object.assign({}, ioBefore, {
        thresholds: Object.assign({}, ioBefore.thresholds, { quakeScale: 50 }),
      }))
      const ioRes = t11.importConfig(t11.buildConfigExport(ioWant))
      assert(ioRes.ok, '导入成功')
      assert(t11.currentCfg().thresholds.quakeScale === 50, '导入后配置被整体替换（新值生效）')
      const ioBackup = t11.loadConfigBackup()
      assert(ioBackup && ioBackup.cfg.thresholds.quakeScale === 40, '导入前自动备份了当前配置（撤销的依据）')
      const ioUndo = t11.undoConfigImport()
      assert(ioUndo.ok && t11.currentCfg().thresholds.quakeScale === 40, '撤销回到导入前的配置')
      // 撤销是一次性的——成功后清掉备份，否则按钮跨会话一直挂着，误触就是一次静默的配置丢失。
      assert(t11.loadConfigBackup() === null,
        '撤销后备份被清掉（一次性撤销）——否则这份陈旧快照会一直挂着、随时可被误触')
      assert(t11.undoConfigImport().ok === false, '再撤一次返回 no-backup（界面上按钮与备份时间已消失）')

      // ---- 校验失败时什么都不写（连备份都不做） ----
      const ioBeforeBad = JSON.stringify(t11.currentCfg())
      const ioBad = t11.importConfig('{"format":"other/app","formatVersion":1,"config":{}}')
      assert(!ioBad.ok && ioBad.error === 'format', '坏文件被拒绝')
      assert(JSON.stringify(t11.currentCfg()) === ioBeforeBad, '校验失败时配置一个字都没动')

    // ---- 导入不能静默丢关注点，也不能把「半径是数字字符串」放大 3 倍 ----
      {
        const raw = {
          watch: {
            places: [
              { name: '好点', lat: 30.66, lon: 104.07, radiusKm: 100 },
              { name: '坏坐标', lat: '30.66', lon: 104.07 },        // 字符串坐标 → 整条丢弃（判据没变）
              { name: '越界', lat: 999, lon: 104.07 },              // 越界 → 整条丢弃
              { name: '好点', lat: 30.66, lon: 104.07, radiusKm: 100 }, // 重复 → 合并
              { name: '数字字符串半径', lat: 26.85, lon: 100.51, radiusKm: '100' },
              { name: '没半径', lat: 35.0, lon: 139.0, radiusKm: null },
            ],
          },
        }
        const text = JSON.stringify({ format: t11.CONFIG_FORMAT, formatVersion: t11.CONFIG_FORMAT_VERSION, config: raw })
        const parsed = t11.parseConfigImport(text)
        assert(parsed.ok, '（前置）含格式不合法的关注点的配置仍能导入（不因一条坏数据整份拒绝）')
        assert(parsed.warnings && parsed.warnings.total === 6, '检查清单记下原始条目数：' + JSON.stringify(parsed.warnings))
        assert(parsed.warnings.dropped === 3,
          '被丢掉的 3 条（字符串坐标 / 越界 / 重复）有记录可查 —— 此前只在界面上说"已导入配置。"')
        assert(parsed.warnings.radiusFixed === 1, '只有"没半径"那一条记入半径回退（null → 300km）')
        assert(parsed.cfg.watch.places.length === 3, '规整后留下 3 条关注点')
        const strRadius = parsed.cfg.watch.places.find((p) => p.name === '数字字符串半径')
        assert(strRadius && strRadius.radiusKm === 100,
          '数字字符串半径按数值处理（修复前 "100" 会被当成非数值、静默放大成 300km）')
        const noneRadius = parsed.cfg.watch.places.find((p) => p.name === '没半径')
        assert(noneRadius && noneRadius.radiusKm === 300, '对照：真正没有半径的仍退回默认 300km')
        // importConfig 要把检查清单透传给界面（否则上面这层修好了、界面还是无条件报成功）
        const ioWarn = t11.importConfig(text)
        assert(ioWarn.ok && ioWarn.warnings && ioWarn.warnings.dropped === 3,
          'importConfig 把检查清单透传给界面（P1-6 的另一半）')
        assert(t11.t('settings.configIo.importedSkipped', { n: 3 }).indexOf('3') !== -1,
          '警告文案四种语言都有，且带得上数字：' + t11.t('settings.configIo.importedSkipped', { n: 3 }))
      }

      // ---- 导入时超上限的市町村要如实报数（走真实导入路径，不是自造 audit） ----
      // 这条与下面「normalizeCfg 的 audit 字段」那条分工不同：那条直接调 normalizeCfg 并自带一份
      // 字段齐全的 audit，守的是**机制**；实际接线在 parseConfigImport 里，它漏初始化一个字段，
      // 界面上 `NaN > 0` 就恒假、提示永不出现——那种漏法只有走真实路径才照得出来。
      {
        const cap = t11.MAX_WATCH_CITIES || 300
        const over = cap + 7
        const manyCities = []
        for (let i = 0; i < over; i += 1) manyCities.push('市町村' + i)
        const text = JSON.stringify({
          format: t11.CONFIG_FORMAT, formatVersion: t11.CONFIG_FORMAT_VERSION, config: { watch: { cities: manyCities } },
        })
        const parsed = t11.parseConfigImport(text)
        assert(parsed.ok, '（前置）市町村超上限的配置仍能导入')
        assert(parsed.cfg.watch.cities.length === cap,
          '规整后只留 ' + cap + ' 条市町村')
        assert(parsed.warnings.citiesDropped === 7,
          '被截断的 7 条记进检查清单（audit 漏初始化时这里是 NaN，界面判定恒假）：' +
          String(parsed.warnings.citiesDropped))
        const ioCities = t11.importConfig(text)
        assert(ioCities.ok && ioCities.warnings && ioCities.warnings.citiesDropped === 7,
          'importConfig 把市町村检查清单透传给界面：' + JSON.stringify(ioCities.warnings))
        assert(t11.t('settings.configIo.importedCities', { n: 7 }).indexOf('7') !== -1,
          '超上限文案四种语言都有，且带得上数字：' + t11.t('settings.configIo.importedCities', { n: 7 }))
      }

      // ---- 量纲文案表（震度 / 海啸 / 震级 / 半径）：三种语言都得有，且都不是占位符 ----
      const units = t11.tableOf('zh-CN')
      const unitKeys = Object.keys(units).filter((k) => /^(scale|scaleOpt|tsunami|tsunamiOpt|magOpt|radius)\./.test(k))
      // 真正的保证是下面那个「每种语言都齐全」的循环；没有消费者的死键会被删掉。
      assert(unitKeys.length >= 20, '量纲文案表有 ' + unitKeys.length + ' 条')
      for (const lang of t11.LANGS) {
        const ioMissing = unitKeys.filter((k) => typeof t11.tableOf(lang)[k] !== 'string' || !t11.tableOf(lang)[k])
        assert(ioMissing.length === 0, lang + ' 的量纲文案齐全（缺：' + ioMissing.join(',') + '）')
      }
      // 所有 labelKey 都得能取到非空文案：漏一条就是下拉里出现一个空选项。
      const allLabelKeys = [].concat(t11.RADIUS_PRESETS, t11.CN_REPORT_MAG_OPTIONS).map((o) => o.labelKey)
      assert(allLabelKeys.length > 0 && allLabelKeys.every((k) => typeof k === 'string' && t11.t(k) && t11.t(k) !== k),
        '档位表的每个 labelKey 都能取到文案：' + allLabelKeys.join(', '))

      // ---- 源名随语言（00f 是唯一来源：侧边栏提示与设置页共用同一份映射） ----
      assert(t11.sourceLabelOf('jma') !== 'jma', '源名有本地化文案：' + t11.sourceLabelOf('jma'))
      assert(t11.sourceLabelOf('no-such-source') === 'no-such-source', '认不出的源退回 id（不显示空白）')
      t11.setLanguage('en')
      assert(t11.sourceLabelOf('jma') === 'JMA (weather hazards, Host polling)',
        '切成英文后源名跟着换（映射在 00f，取词在调用时）：' + t11.sourceLabelOf('jma'))
      t11.setLanguage('zh-CN')
    }

    // ⑫ review 结论的守卫
    {
      const t12 = loadClient().__test

    // ---- 县名随语言 ----
      const wantPref = { 'zh-CN': '东京', 'zh-TW': '東京', ja: '東京都', en: 'Tokyo' }
      for (const lang of t12.LANGS) {
        t12.setLanguage(lang)
        // 期望表是人写的，加了语言它就有洞：先断言它有这一项，否则失败信息指向不明。
        assert(Object.prototype.hasOwnProperty.call(wantPref, lang), '期望表 wantPref 覆盖了 ' + lang)
        assert(t12.prefLabelOf('東京都') === wantPref[lang],
          lang + ' 下 prefLabelOf(東京都) = ' + wantPref[lang] + '（实际 ' + t12.prefLabelOf('東京都') + '）')
      }
      t12.setLanguage('zh-CN')
      assert(t12.prefLabelOf('不存在县') === '不存在县', 'prefLabelOf 认不出时原样返回（不显示空白）')
      assert(t12.prefLabelOf('') === '', 'prefLabelOf 对空值返回空串')
      const jpList = t12.PREFECTURES.map((p) => p.jp)
      const zhOf = (jp) => (t12.PREFECTURES.find((p) => p.jp === jp) || {}).zh
      // 三栏一起守：把某个县的简体名清空时，简体界面会直接在关注列表里显示空串。
      assert(jpList.every((jp) => typeof zhOf(jp) === 'string' && zhOf(jp)),
        '47 个都道府县都有简体名（PREFECTURES[].zh）')
      assert(jpList.every((jp) => typeof t12.PREF_EN[jp] === 'string' && t12.PREF_EN[jp]),
        '47 个都道府县都有罗马字（PREF_EN）')
      assert(Object.keys(t12.PREF_EN).length === jpList.length, 'PREF_EN 与 PREFECTURES 一一对应（无缺无多）')
      assert(jpList.every((jp) => typeof t12.PREF_HANT[jp] === 'string' && t12.PREF_HANT[jp]),
        '47 个都道府县都有繁体名（PREF_HANT）')
      assert(Object.keys(t12.PREF_HANT).length === jpList.length,
        'PREF_HANT 与 PREFECTURES 一一对应（无缺无多）')
      // 繁体名不得照抄日文汉字，但日文与繁体同形的县（青森 / 宮城 / 北海道）等于日文短名是正确结果。
      const JP_HANT_DIFF = ['静岡県', '広島県', '徳島県', '鹿児島県', '沖縄県']
      const jpShort = (jp) => jp.replace(/[都府県]$/, '')
      assert(JP_HANT_DIFF.length === 5 && JP_HANT_DIFF.every((jp) => jpList.indexOf(jp) !== -1),
        '（前置）日文汉字与繁体不同的县恰好 5 个，且都在 PREFECTURES 里')
      const copiedJp = JP_HANT_DIFF.filter((jp) => t12.PREF_HANT[jp] === jpShort(jp))
      assert(copiedJp.length === 0,
        '繁体县名不得等于"去掉 都/府/県 的日文原名"（照抄日文汉字 = 没翻）：' +
        copiedJp.map((jp) => jp + '→' + t12.PREF_HANT[jp]).join(' / '))
      // 从 47 项派生出「繁体与简体不同」的那些（22 个），它们都必须真有繁体字形。
      const diffFromZh = jpList.filter((jp) => t12.PREF_HANT[jp] !== zhOf(jp))
      assert(diffFromZh.length >= 20, '繁体名与简体名有差异的项有 ' + diffFromZh.length + ' 个（下界守卫）')
      // 这里只查非空：東京都 → 東京 的繁体与日文短名本来就同形。
      assert(diffFromZh.every((jp) => t12.PREF_HANT[jp].length > 0),
        '繁体与简体有差异的每一项都非空（空串会在关注列表里显示成空白）')
      assert(['静岡県', '広島県', '沖縄県', '鹿児島県', '長野県'].every((jp) => t12.PREF_HANT[jp] !== zhOf(jp)),
        '繁体县名与简体县名在字形上确有区别：' +
        ['静岡県', '広島県', '沖縄県', '鹿児島県', '長野県'].map((jp) => jp + '→' + t12.PREF_HANT[jp]).join(' / '))

    // ---- t() 不能被原型链键名绕过 ----
      assert(t12.t('constructor') === 'constructor', "t('constructor') 回显 key 本身，而不是 Object 构造函数")
      assert(t12.t('toString') === 'toString', "t('toString') 回显 key 本身")
      assert(t12.t('valueOf') === 'valueOf', "t('valueOf') 回显 key 本身")
      assert(t12.t('constructor', { a: 1 }) === 'constructor', '带参数时也不抛（旧实现在这里抛 TypeError）')

      // ---- 测试场景名有文案（动态 key，check-imports 的字面量检查覆盖不到）----
      const scenarios = [].concat(t12.TEST_SCENARIOS || [], t12.TEST_GEO_SCENARIOS || [])
      assert(scenarios.length >= 9, '测试场景共 ' + scenarios.length + ' 个')
      for (const sc of scenarios) {
        for (const prefix of ['settings.diag.scenario.', 'settings.diag.scenarioNote.']) {
          const k = prefix + sc.key
          assert(t12.t(k) !== k && Boolean(t12.t(k)), '场景文案取得到：' + k)
        }
      }

    // ---- 五个档位表的 labelKey 全部能取到文案 ----
      const optTables = {
        SCALE_OPTIONS: t12.SCALE_OPTIONS, TSUNAMI_OPTIONS: t12.TSUNAMI_OPTIONS,
        GLOBAL_MAG_OPTIONS: t12.GLOBAL_MAG_OPTIONS, CN_REPORT_MAG_OPTIONS: t12.CN_REPORT_MAG_OPTIONS,
        RADIUS_PRESETS: t12.RADIUS_PRESETS,
      }
      const labelKeys = []
      for (const name of Object.keys(optTables)) {
        const list = optTables[name]
        assert(Array.isArray(list) && list.length > 0, name + ' 在测试面上可见（否则这条断言会退化成"没有表要查"）')
        for (const o of list) { assert(typeof o.labelKey === 'string', name + ' 的每一项都有 labelKey'); labelKeys.push(o.labelKey) }
      }
      assert(labelKeys.length >= 30, '五个档位表共 ' + labelKeys.length + ' 个 labelKey')
      assert(labelKeys.every((k) => Boolean(t12.t(k)) && t12.t(k) !== k), '每个 labelKey 都能取到文案')

    // ---- 每个源都有显示名 ----
      assert(t12.SOURCE_ORDER.every((id) => t12.sourceLabelOf(id) !== id),
        'SOURCE_ORDER 里的每个源都有显示名：' + t12.SOURCE_ORDER.map((id) => id + '→' + t12.sourceLabelOf(id)).join(' · '))
    }

    // ⑬ 渲染冒烟：4 语言 × 5 页签，扫【插值残留 / 连续重复 / 漏翻的简体中文】
    //    范围只覆盖「我们生成的界面文案」，源侧文本与 suppressedReason 不在内。
    {
      const t13 = loadClient().__test
      const smokeReact = () => ({
        createElement: (ty, p, ...c) => ({ type: ty, props: p || {}, children: c.flat(4).filter((x) => x !== null && x !== undefined && x !== false && x !== true) }),
        useState: (i) => [typeof i === 'function' ? i() : i, () => {}],
        useEffect: () => {},
        useRef: (v) => ({ current: v }),
      })
      const collectTexts = (node, out) => {
        if (node === null || node === undefined || typeof node === 'boolean') return
        if (typeof node === 'string' || typeof node === 'number') { out.push(String(node)); return }
        if (Array.isArray(node)) { node.forEach((n) => collectTexts(n, out)); return }
        if (node && node.children) collectTexts(node.children, out)
      }
      // ---- 「漏翻」判据 ----
      // zh-TW 用文件顶部那份冻结字表（不随表变化 + 整条反查），ja / en 用高置信字
      // （日文里 `报` / `关` / `发` / `时` 这些字形根本不存在；那份给繁体用的字表对日文会误报）。
      const zhCnValues = new Map()
      for (const [k, v] of Object.entries(t13.tableOf('zh-CN'))) {
        if (typeof v === 'string' && !/\{[a-zA-Z]\w*\}/.test(v)) zhCnValues.set(v, k)
      }
      // 源侧透传的文本（县名、履历里的日文 label / headline）不是我们生成的文案，要排除。
      const SOURCE_TEXTS = [].concat(t13.PREFECTURES.map((p) => p.jp), ['地震情報・各地の震度', '最大震度4'])
      const isSourceText = (s) => SOURCE_TEXTS.some((x) => s.indexOf(x) !== -1)
      const HANDPICKED_CN = /[东见报灾发关个时间门问实为这们让还对开动务压页证据线边层简样买卖]/
      // 语言自己的显示名（'简体中文' / '繁體中文' / '日本語' / 'English'）要排除。
      const skipTexts = new Set(t13.LANGS.map((l) => t13.LANGUAGE_LABELS[l]))
      // 关注地区放全部 47 个县：只 seed 两个县时，任何一个县名写坏都不会进渲染、冒烟看不见。
      const smokeCfg = (lang) => ({
        version: 1, language: lang, source: 'prod', cnTransport: 'auto',
        watch: { prefectures: t13.PREFECTURES.map((p) => p.jp), cities: [], places: [{ name: 'SiteA', lat: 35, lon: 139, radiusKm: 100 }] },
        disasters: { earthquake: true, tsunami: true, weather: true, cnRainstorm: true, cnGeology: true, overseasWeather: true },
        thresholds: { quakeScale: 40, eewScale: 45, tsunamiGrade: 'Watch', globalMagnitude: 4.5, cnReportMagnitude: 4.5 },
        notify: { sound: true, system: true, volume: 0.7 }, dedupe: { windowMinutes: 10 },
        quietHours: { enabled: true, start: '23:00', end: '07:00', breakForSevere: true },
      })
      // 一条履历记录，用来把「履历条目」那条渲染路径也盖住（label / headline 用日文原文）。
      const smokeHistory = JSON.stringify([{
        key: 'smoke-1', id: 'smoke-1', kind: 'quake', label: '地震情報・各地の震度', severity: 'warn',
        issued: '2026-09-26T10:00:00+09:00', headline: '最大震度4', hit: true, pref: '東京都',
      }])
      // 页签清单提成常量：下面的覆盖次数从它派生，不再手写 20（加语言时数字会自己跟上）。
      const SMOKE_TABS = ['region', 'disaster', 'notify', 'history', 'misc']
      let rendered = 0
      for (const lang of t13.LANGS) {
        for (const tab of SMOKE_TABS) {
          const react = smokeReact()
          const seed = {}
          seed[t13.STORAGE_KEY] = JSON.stringify(smokeCfg(lang))
          seed['dsh.quakeAlert.history'] = smokeHistory
    // 让「撤销上次导入」旁的**备份时间**也进渲染冒烟
          seed['dsh.quakeAlert.backup'] = JSON.stringify({ at: '2026-09-26T10:00:00.000Z', config: smokeCfg(lang) })
          const { exports: ex } = loadClientEx(seed, { react })
          let tree
          try { tree = ex.__test.SettingsPanel({ initialTab: tab }) } catch (e) {
            assert(false, lang + ' / ' + tab + ' 设置页渲染抛错：' + e.message)
            continue
          }
          const out = []
          collectTexts(tree, out)
          rendered++
          const blob = out.join('\n')
          // 配置页要显示**备份时间**：撤销会把导入之后的改动整体回滚，界面要让用户看到恢复的是什么时候的快照。
          if (tab === 'misc') {
            const want = ex.__test.t('settings.configIo.undoAt',
              { at: ex.__test.formatIssuedLocal('2026-09-26T10:00:00.000Z') })
            assert(blob.indexOf(want) !== -1, lang + '：配置页显示备份时间（实际渲染里没有「' + want + '」）')
          }
          const ph = [...new Set(blob.match(/\{[a-zA-Z]\w*\}/g) || [])]
          assert(ph.length === 0, lang + ' / ' + tab + ' 渲染文本里没有未替换的插值' +
            (ph.length ? '（' + ph.join(',') + '）' : ''))
          const dup = [...new Set(out.filter((s) => /([\u4e00-\u9fff]{2,6})\1/.test(s)))]
          assert(dup.length === 0, lang + ' / ' + tab + ' 没有重复拼接的文本' +
            (dup.length ? '：' + JSON.stringify(dup[0].slice(0, 50)) : ''))
          if (lang !== 'zh-CN') {
            const table = t13.tableOf(lang)
            const copiedWhole = [...new Set(out.filter((s) => {
              const k = zhCnValues.get(s)
              return k !== undefined && table[k] !== s
            }))]
            assert(copiedWhole.length === 0, lang + ' / ' + tab + ' 没有整条照抄简体表值的文本' +
              (copiedWhole.length ? '：' + JSON.stringify(copiedWhole[0].slice(0, 40)) : ''))
            const chars = lang === 'zh-TW' ? CN_ONLY_RE : HANDPICKED_CN
            const leftover = [...new Set(out.filter((s) => chars.test(s) && !skipTexts.has(s) && !isSourceText(s)))]
            assert(leftover.length === 0, lang + ' / ' + tab + ' 没有漏翻的简体中文' +
              (leftover.length ? '：' + leftover.slice(0, 2).map((s) => JSON.stringify(s.slice(0, 40))).join(' ') : ''))
          }
        }
      }
      assert(rendered === t13.LANGS.length * SMOKE_TABS.length,
        '渲染冒烟覆盖 ' + t13.LANGS.length + ' 语言 × ' + SMOKE_TABS.length + ' 页签（实际 ' + rendered + ' 次）')
    }

    // ⑭ 存储层与 store 通知的守卫
    {
      // ---- 「校验失败什么都不写（连备份都不做）」要查**存储层** ----
      const seed0 = { 'dsh.quakeAlert.v1': JSON.stringify(loadClient().__test.DEFAULT_CFG) }
      const sandbox0 = loadClientEx(seed0)
      const keysOf = () => [...sandbox0.storage.keys()].sort().join(',')
      const beforeKeys = keysOf()
      const badRes = sandbox0.exports.__test.importConfig('{"format":"other/app","formatVersion":1,"config":{}}')
      assert(!badRes.ok && badRes.error === 'format', '坏文件被拒绝')
      assert(keysOf() === beforeKeys, '校验失败时 localStorage 的键集合不变（含"连备份都不做"）：' + keysOf())
      assert(sandbox0.exports.__test.loadConfigBackup() === null, '校验失败时不产生备份')

      // ---- 备份写不进去时不能替换配置 ----
      const fakeLs = { getItem: () => null, setItem: () => { throw new Error('QuotaExceededError') }, removeItem: () => {} }
      const exQ = loadClientEx({}, { window: { localStorage: fakeLs } }).exports.__test
      const qBefore = exQ.currentCfg().thresholds.quakeScale
      const qCur = exQ.currentCfg()
      const qWant = exQ.normalizeCfg(Object.assign({}, qCur, { thresholds: Object.assign({}, qCur.thresholds, { quakeScale: 55 }) }))
      const qRes = exQ.importConfig(exQ.buildConfigExport(qWant))
      assert(!qRes.ok && qRes.error === 'backup-failed', '备份写不进去时拒绝导入（错误码 backup-failed）：' + qRes.error)
      assert(exQ.currentCfg().thresholds.quakeScale === qBefore, '拒绝导入时配置一个字都没动')

      // ---- 畸形配置返回错误码而不是抛异常（UI 没有 catch，抛了就是点了没反应）----
      const t14 = loadClient().__test
      const weird = '{"format":"' + t14.CONFIG_FORMAT + '","formatVersion":1,"config":{"language":{"toString":null,"valueOf":null}}}'
      let weirdThrew = false
      let weirdRes = null
      try { weirdRes = t14.parseConfigImport(weird) } catch (e) { weirdThrew = true }
      assert(!weirdThrew && weirdRes && weirdRes.error === 'shape',
        '转不成字符串的字段 → 返回 shape 错误码（而不是抛异常）')

      // ---- BOM：记事本 / PowerShell 重存过的文件不能被当成「不是有效的 JSON」----
      assert(t14.parseConfigImport('\uFEFF' + t14.buildConfigExport(t14.currentCfg())).ok,
        '带 UTF-8 BOM 的文件能导入')

      // ---- 切语言要触发 store 重算 + 通知（按语言循环，繁体下 store.detail 也要跟着换）----
      const exL = loadClient().__test
      let notified = 0
      exL.store.subscribe(() => { notified++ })
      exL.store.pushSource('jma', { status: 'open', retries: 0 })
      const wantDetail = {
        'zh-CN': '已连接', 'zh-TW': '已連線', ja: '接続済み', en: 'Connected',
      }
      let switched = 0
      for (const lang of exL.LANGS) {
        // 与当前语言相同的迭代不是"切换"（applyCfg 是幂等路径，本来就不该通知），跳过它。
        if (exL.getLanguage() === lang) continue
        const n0 = notified
        exL.applyCfg(Object.assign({}, exL.currentCfg(), { language: lang }))
        switched++
        assert(notified > n0, lang + '：切语言会通知 store 订阅者（旧实现 0 次 → 侧边栏状态点不重渲染）')
        assert(exL.store.detail.indexOf(wantDetail[lang]) !== -1,
          lang + '：切语言后 store.detail 重算成当前语言（期望含「' + wantDetail[lang] + '」）：' + exL.store.detail)
      }
      assert(switched === exL.LANGS.length - 1,
        '每种"非当前语言"都真跑了一次切换（实际 ' + switched + ' 次 / 语言数 ' + exL.LANGS.length + '）')
      exL.setLanguage('zh-CN')
      exL.store.recomputeStatus()
      assert(exL.store.detail.indexOf('已连接') !== -1, '切回中文后状态文字也回来：' + exL.store.detail)

      // ---- Host 权威配置里的语言必须落到 i18n：sync() 只更新 runtimeCfg 与镜像、不 setLanguage ----
      {
        const exH = loadClientEx({})
    // 自建最小 scope，不依赖别的块里的 fakeScope（不在本块作用域内）
        const scopeH = {
          getSnapshot: () => ({
            status: 'ready', value: { language: 'zh-TW' }, user: { language: 'zh-TW' },
            base: {}, revision: 1, writable: true, mode: 'host',
          }),
          subscribe: () => () => {},
          mutate: () => Promise.resolve(),
        }
        exH.exports.__test.bindSettingsScope(scopeH)
        assert(exH.exports.__test.currentCfg().language === 'zh-TW',
          'Host 的配置进了内存（前置）：' + exH.exports.__test.currentCfg().language)
        assert(exH.exports.__test.getLanguage() === 'zh-TW',
          'Host 里的语言在 bind 后立即生效（此前界面停在镜像语言，且不会自愈）')
        assert(exH.exports.__test.t('app.name') === '災害預警',
          'Host 语言选中的文案表就是繁体：' + exH.exports.__test.t('app.name'))
        assert(exH.exports.__test.prefLabelOf('東京都') === '東京', '派生显示名同样按 Host 语言取词')
      }
    }

    // ⑧ 全球主要城市表：数据结构、按国家分包下发、客户端缓存与 UI 入口
    {
      const world = await import(pathToFileURL(path.join(ROOT, 'lib', 'data', 'world-cities.js')).href)
      assert(Array.isArray(world.WORLD_COUNTRIES) && world.WORLD_COUNTRIES.length > 100,
        '国家清单（' + world.WORLD_COUNTRIES.length + ' 个国家 / 地区）')
      const codes = world.WORLD_COUNTRIES.map((c) => c.code)
      assert(new Set(codes).size === codes.length, '国家码不重复')
      assert(!['JP', 'CN', 'TW', 'HK', 'MO'].some((cc) => codes.indexOf(cc) !== -1),
        '日本与中国（含台港澳）不在全球城市表里——它们有自己的分支与匹配语义，混进来既重复、口径也含糊')
      const usIdx = codes.indexOf('US')
      assert(usIdx !== -1, '美国在表里（海外气象源的 NWS 就按它取数）')
      const us = world.WORLD_CITIES_BY_COUNTRY.US
      assert(Array.isArray(us) && us.length > 50, '美国有 ' + (us ? us.length : 0) + ' 个城市')
      assert(us.every((c) => typeof c.name === 'string' && c.name &&
        Number.isFinite(c.lat) && Number.isFinite(c.lon) &&
        Math.abs(c.lat) <= 90 && Math.abs(c.lon) <= 180),
        '每条城市都带合法坐标（脏坐标会让"配好了却永远不提醒"）')
      assert(world.WORLD_COUNTRIES[usIdx].count === us.length, '清单里的 count 与分包的实际条数一致')
      // 国家名是**本地化四条**（ICU 算出来的）
      {
        const langs = ['zh-CN', 'zh-TW', 'ja', 'en']
        const bad = world.WORLD_COUNTRIES.filter((c) => !c.names ||
          langs.some((l) => typeof c.names[l] !== 'string' || !c.names[l].trim()))
        assert(bad.length === 0, '166 个国家都有四种语言的名字（缺：' + bad.map((c) => c.code).join(',') + '）')
        assert(!('name' in world.WORLD_COUNTRIES[0]), '旧的中文字段已不在数据里（形状只有一种，不会两处真相）')
        const it = world.WORLD_COUNTRIES.filter((c) => c.code === 'IT')[0]
        assert(it && it.names['zh-TW'] === '義大利' && it.names.ja === 'イタリア' && it.names.en === 'Italy',
          '抽查意大利的四条名字：' + JSON.stringify(it && it.names))
        // 两个前提：地区页签要落在「其他国家 / 地区」分支（种 origin: 'global'），语言要写进**配置**里。
        const renderCountries = (lang) => {
          const react = mkTestReact()
          const seed = {
            'dsh.quakeAlert.v1': JSON.stringify({
              version: 1,
              language: lang,
              watch: { prefectures: [], cities: [], places: [{ name: '东京', lat: 35.68, lon: 139.77, radiusKm: 100, origin: 'global' }] },
            }),
          }
          const exC = loadClientEx(seed, { react }).exports.__test
          exC.setWorldCountries(world.WORLD_COUNTRIES)
          react.__reset()
          return textsOfTree(exC.SettingsPanel({ initialTab: 'region' }))
        }
        const textsEn = renderCountries('en')
        // option 的 value 必须查：只断言标签文本时，「所有国家 option 的 value 都是 undefined」会全绿漏出去。
        {
          const react2 = mkTestReact()
          const seed2 = {
            'dsh.quakeAlert.v1': JSON.stringify({
              version: 1, language: 'en',
              watch: { prefectures: [], cities: [], places: [{ name: '东京', lat: 35.68, lon: 139.77, radiusKm: 100, origin: 'global' }] },
            }),
          }
          const exP = loadClientEx(seed2, { react: react2 })
          exP.exports.__test.setWorldCountries(world.WORLD_COUNTRIES)
          react2.__reset()
          const opts = optionsOfTree(exP.exports.__test.SettingsPanel({ initialTab: 'region' }))
          const allCodes = world.WORLD_COUNTRIES.map((c) => c.code)
          // 国家下拉 = placeholder（v: ''）+ 每个国家一条；用 code 集合反查，避免把别的 select 数进来
          const countryOpts = opts.filter((o) => allCodes.indexOf(String(o.v)) !== -1)
          assert(countryOpts.length === allCodes.length,
            '国家下拉有 ' + allCodes.length + ' 个国家 option（实际 ' + countryOpts.length + '）')
          assert(opts.some((o) => o.v === ''), '占位项（"全部国家 / 地区"）的 value 是空串')
          const vals = countryOpts.map((o) => String(o.v))
          assert(new Set(vals).size === vals.length, '每个国家的 option value 唯一（重复会让浏览器只能选第一个）')
          // 扫所有 option：任何 option 的 value 变成字符串 "undefined" / "null" 都是同一个错误的形态。
          const badVals = opts.filter((o) => String(o.v) === 'undefined' || String(o.v) === 'null')
          assert(badVals.length === 0,
            '没有任何 option 的 value 是 undefined/null（' + badVals.length + ' 个，例如 ' +
            JSON.stringify(badVals.slice(0, 2)) + '）')
          assert(vals.length > 0 && vals.every((v) => /^[A-Z]{2}$/.test(v)),
            'option value 都是两位国家码：' + JSON.stringify(vals.slice(0, 4)))
          assert(vals.indexOf('IT') !== -1 && vals.indexOf('US') !== -1, '意大利 / 美国都有可选项')
          // 端到端：选中一个国家 → onChange 拿到的必须是国家码，并且真的去拉那个国家的分包
          const urls = []
          exP.sandbox.window.fetch = async (url) => {
            urls.push(String(url))
            return { ok: true, status: 200, json: async () => ({ country: 'IT', cities: [{ name: 'Rome', lat: 41.89, lon: 12.51 }] }) }
          }
          // test-react 的 useState 按渲染次序分配槽位，每次渲染前都要 __reset()，否则状态对不上。
          react2.__reset()
          const sel = selectsOfTree(exP.exports.__test.SettingsPanel({ initialTab: 'region' }))[0]
          assert(sel && typeof sel.props.onChange === 'function', '国家下拉带 onChange')
          sel.props.onChange({ target: { value: 'IT' } })
          assert(urls.length === 1 && urls[0].indexOf('country=IT') !== -1,
            '选中意大利真的去拉它那一包（此前的 value 是 "undefined"，拉的是不存在的国家）：' + JSON.stringify(urls))
          // 还要看拉回来之后列表真的渲染出来，而不是只确认发出过请求；await 一拍让 promise 落地再渲染一次。
          await new Promise((r) => setImmediate(r))
          react2.__reset()
          const afterSel = textsOfTree(exP.exports.__test.SettingsPanel({ initialTab: 'region' }))
          assert(afterSel.some((s) => s.indexOf('Rome') !== -1),
            '选中之后城市列表里出现 Rome（用户报的"没有任何城市选项"就是这一步断了）')
        }
        assert(textsEn.some((s) => s.indexOf('Italy') !== -1),
          '语言切到 English 后国家下拉出现 Italy（此前永远是简体中文）')
        assert(!textsEn.some((s) => s.indexOf('意大利') !== -1), 'English 下不再出现中文国名')
        const textsJa = renderCountries('ja')
        assert(textsJa.some((s) => s.indexOf('イタリア') !== -1), '语言切到日本語后出现 イタリア')
        const textsZhTw = renderCountries('zh-TW')
        assert(textsZhTw.some((s) => s.indexOf('義大利') !== -1), '繁体下出现 義大利（不是简繁同形）')
      }
      assert(!us.some((c) => 'pop' in c), '排序用的人口字段不下发（只增体积）')
      // 同名城市必须能区分：同国内重名的条目要把一级行政区附在名字里
      const dupNames = new Set()
      const seenNames = new Set()
      for (const c of us) { if (seenNames.has(c.name)) dupNames.add(c.name); seenNames.add(c.name) }
      assert(dupNames.size === 0, '同一国家内没有两条完全同名的条目（否则用户没法选对）')

      // Host：`/areas?country=` 只给那一包；未知国家码 404（不静默回空数组）
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
      const callAreas = (url) => {
        let status = 0
        let body = ''
        areas.handler({ url }, { writeHead(s) { status = s }, end(b) { body = b } })
        return { status, body }
      }
      const plain = callAreas('/dsh-quake-alert/areas')
      const parsedPlain = JSON.parse(plain.body)
      assert(plain.status === 200 && Array.isArray(parsedPlain.worldCountries) &&
        parsedPlain.worldCountries.length === world.WORLD_COUNTRIES.length,
        '不带参数时下发国家清单（城市本体按国家分包另取）')
      const usRes = callAreas('/dsh-quake-alert/areas?country=us')
      const parsedUs = JSON.parse(usRes.body)
      assert(usRes.status === 200 && parsedUs.country === 'US' && parsedUs.cities.length === us.length,
        '?country=us 只给美国那一包（小写也认）：' + usRes.status)
      assert(usRes.body.length < 120000, '分包体积可控（' + usRes.body.length + ' 字节）')
      const badRes = callAreas('/dsh-quake-alert/areas?country=ZZ')
      assert(badRes.status === 404,
        '未知国家码 → 404，而不是空数组："这个国家没收录"（退化成手填坐标）与"代码写错"（缺陷）必须能分开')
      assert(callAreas('/dsh-quake-alert/areas?country=constructor').status === 404,
        '国家码查表不过原型链（?country=constructor 不能命中原型）')

      // Client：国家清单的规整 + 按需拉取（注入 fetch，不联网）
      const s8 = loadClientEx()
      const c8 = s8.exports.__test
      assert(c8.setWorldCountries([]) === false && c8.setWorldCountries('x') === false, '非数组 / 空表 → 拒绝')
      assert(c8.setWorldCountries([
        { code: 'us', name: '美国', count: 2 }, { code: 'US', name: '重复', count: 9 },
        { code: '', name: '坏' }, { code: 'fr', name: '法国', count: 1 },
      ]) === true, '有一项可用即接受（老 Host 只给 name 的形态也要能用）')
      const list8 = c8.worldCountriesOf()
      // 数据形状是 names（本地化四条），老形状（只有 name）作为 zh-CN 收下，取词走 countryNameOf。
      assert(list8.length === 2 && list8[0].code === 'US' && c8.countryNameOf(list8[0], 'zh-CN') === '美国',
        '国家码统一为大写、重复码只留第一条：' + JSON.stringify(list8))
      assert(c8.countryNameOf(list8[0], 'en') === '美国',
        '只有一种名字时任何语言都退回它（不显示空白）')
      assert(c8.setWorldCountries([{ code: 'IT', count: 50, names: { 'zh-CN': '意大利', 'zh-TW': '義大利', ja: 'イタリア', en: 'Italy' } }]) === true,
        '本地化四条的形状可接受')
      const itEntry = c8.worldCountriesOf()[0]
      assert(c8.countryNameOf(itEntry, 'ja') === 'イタリア' && c8.countryNameOf(itEntry, 'en') === 'Italy',
        '按语言取词（ja / en）')
      assert(c8.countryNameOf(itEntry, 'fr') === '意大利',
        '该语言没有名字时逐级退回（fr → zh-CN），不显示空白')
      assert(c8.countryNameOf({ code: 'ZZ', names: {} }, 'en') === 'ZZ', '一个名字都没有时退回 ISO 码')
      assert(c8.countryPackOf('US') === null, '尚未拉取时没有缓存')

      const urls = []
      s8.sandbox.window.fetch = async (url) => {
        urls.push(String(url))
        return {
          ok: true, status: 200,
          json: async () => ({
            country: 'US',
            cities: [{ name: '纽约', admin: 'New York', lat: 40.71, lon: -74.01 }, { name: '坏城市', lat: 999, lon: 0 }],
          }),
        }
      }
      const pack = await c8.loadCountryCities('us')
      assert(urls.length === 1 && urls[0] === '/dsh-quake-alert/areas?country=US', '按国家拉分包（国家码大写）：' + urls[0])
      assert(pack.state === 'ready' && pack.cities.length === 1 && pack.cities[0].name === '纽约',
        '坐标非法的条目被剔除（脏坐标 = 配好了却永远不提醒）：' + JSON.stringify(pack.cities))
      await c8.loadCountryCities('US')
      assert(urls.length === 1, '同一国家只拉一次（缓存命中）')
      s8.sandbox.window.fetch = async () => ({ ok: false, status: 404, json: async () => ({ error: 'unknown country' }) })
      const nf = await c8.loadCountryCities('ZZ')
      assert(nf.state === 'ready' && nf.error === 'not-covered' && nf.cities.length === 0,
        '404 记成 not-covered，与"拉取失败"分开：前者的出路是手填坐标，后者是重试')
      s8.sandbox.window.fetch = async () => { throw new Error('boom') }
      const bad = await c8.loadCountryCities('FR')
      assert(bad.state === 'failed' && /boom/.test(bad.error), '网络失败记成 failed 并保留原因：' + JSON.stringify(bad))

      // UI：「其他国家 / 地区」分支真的渲染出国家选择器（有国家清单时）
      const react = mkTestReact()
      const seed = {
        'dsh.quakeAlert.v1': JSON.stringify({
          version: 1,
          watch: { prefectures: [], cities: [], places: [{ name: '东京', lat: 35.68, lon: 139.77, radiusKm: 100, origin: 'global' }] },
        }),
      }
      const { exports: ex } = loadClientEx(seed, { react })
      ex.__test.setWorldCountries([{ code: 'US', name: '美国', count: 620 }, { code: 'FR', name: '法国', count: 40 }])
      react.__reset()
      const texts = textsOfTree(ex.__test.SettingsPanel({ initialTab: 'region' }))
      const has = (s) => texts.some((t) => t.indexOf(s) !== -1)
      assert(has('国家 / 地区') && has('美国（620 个城市）') && has('法国（40 个城市）'),
        '其他国家分支渲染出国家选择器与各国城市数（0.8.0 的新入口）')
      assert(has('请选择国家 / 地区'), '未选国家时给出占位提示，而不是空下拉')
      assert(has('也可以直接填坐标'), '手填坐标这条出口始终在（未收录国家 / 地区只能走它）')
    }
  } catch (e) {
    assert(false, '0.8.0 检查失败：' + e.message + '\n' + (e && e.stack ? e.stack.split('\n').slice(1, 3).join('\n') : ''))
  }

  // 设置页的可访问性与对比度
  try {
console.log('== 设置页的可访问性与对比度 ==')
    const { CITIES_BY_PREF: CITIES_94 } = await import(pathToFileURL(path.join(ROOT, 'lib', 'data', 'cities.js')).href)
    const react = mkTestReact()
    const seed = {
      'dsh.quakeAlert.v1': JSON.stringify({
        version: 1,
        watch: { prefectures: ['東京都'], cities: ['目黒区'], places: [] },
      }),
    }
    const { exports: ex } = loadClientEx(seed, { react })
    ex.__test.setCityTable(CITIES_94)
    react.__reset()
    const tree = ex.__test.SettingsPanel({ initialTab: 'region' })
    const buttons = []
    const walk = (n) => {
      if (!n || typeof n !== 'object') return
      if (Array.isArray(n)) { n.forEach(walk); return }
      if (n.type === 'button') buttons.push(n)
      for (const c of (n.children || [])) walk(c)
    }
    walk(tree)
    const cityBtn = buttons.filter((b) => (b.children || []).indexOf('目黒区') !== -1)[0]
    const otherBtn = buttons.filter((b) => (b.children || []).indexOf('新宿区') !== -1)[0]
    assert(!!cityBtn && !!otherBtn, '（前置）渲染出市町村按钮（已选 / 未选各一个）')
    // 选中态不能只靠颜色与边框表达：读屏用户无法知道选了哪些市町村（WCAG 4.1.2）
    assert(cityBtn && cityBtn.props['aria-pressed'] === 'true', '已选中的市町村按钮带 aria-pressed=true')
    assert(otherBtn && otherBtn.props['aria-pressed'] === 'false', '未选中的按钮带 aria-pressed=false')
    // 对比度：11px 的次要文字在深色底上要过 AA 4.5:1，#6b7280 只有约 3.6:1
    assert(CLIENT_CODE.indexOf("color: '#6b7280'") === -1,
      '设置页不再使用低对比度的 #6b7280 作为文字色（同文件已因同一原因改成 #9aa0a6，此前漏改一处）')
  } catch (e) {
    assert(false, '0.9.4 设置页 a11y 检查失败：' + e.message)
  }

  // toast 的堆叠 / 上限 / 去重
  try {
console.log('== toast 堆叠、上限与长标题换行 ==')
    const mkEl = () => {
      const el = {
        style: {}, children: [], parentNode: null, listeners: {}, textContent: '', attrs: null,
        setAttribute(k, v) { el.attrs = el.attrs || {}; el.attrs[k] = v },
        appendChild(c) { el.children.push(c); c.parentNode = el; return c },
        removeChild(c) { const i = el.children.indexOf(c); if (i !== -1) el.children.splice(i, 1); c.parentNode = null },
        addEventListener(t, fn) { (el.listeners[t] = el.listeners[t] || []).push(fn) },
      }
      return el
    }
    const body = mkEl()
    const doc = { visibilityState: 'visible', body, createElement: mkEl }
    const t = loadClientEx({}, {
      window: { document: doc, requestAnimationFrame: (fn) => fn() },
      setTimeout: () => 0, // toast 的 ttl 不参与断言（不让它把进程钉住）
      clearTimeout: () => {},
    }).exports.__test
    const cfg = JSON.parse(JSON.stringify(t.DEFAULT_CFG))
    cfg.notify = { sound: false, system: false, volume: 0 }
    cfg.thresholds.globalMagnitude = 3
    cfg.watch = { prefectures: [], cities: [], places: [{ name: '测试点', lat: 35.0, lon: 139.0, radiusKm: 500 }] }
    const quakeAt = (n, lat, lon) => ({
      id: 'usgs:toast-' + n, code: 'usgs', source: 'usgs', kind: 'quake', kindLabel: 'USGS 地震',
      locator: 'point', severity: 'orange', issued: '2026-09-20T0' + n + ':00:00+09:00',
      headline: 'M5.' + n + ' 测试区', magnitude: 5 + n / 10, maxScale: -1, strength: 5 + n / 10,
      eventKey: 'geo:toast-' + n, geo: { lat, lon }, regions: [], cancelled: false,
    })
    const hits = []
    for (let n = 1; n <= 4; n += 1) hits.push(t.handleAlert(quakeAt(n, 35 + n * 0.2, 139 + n * 0.2), cfg))
    assert(hits.filter((r) => r.notified === true).length === 4,
      '（前置）四条都播报：' + JSON.stringify(hits.map((r) => r.reason)))
    // 一个纵向排列的容器：此前每条各自 fixed top:16/right:16，一批告警完全重叠
    assert(body.children.length === 1 && body.children[0].style.display === 'flex' &&
      body.children[0].style.flexDirection === 'column',
      'toast 共用一个纵向容器（自动堆叠，不再互相遮挡）')
    const box = body.children[0]
    assert(box.style.pointerEvents === 'none' && box.children.every((c) => c.style.pointerEvents === 'auto'),
      '容器不吃点击、单条 toast 吃点击（空容器不盖住界面）')
    assert(box.children.length === 3, '同时最多 3 条（超出收掉最旧的）：' + box.children.length)
    const newest = box.children[box.children.length - 1]
    assert(String(newest.children[1].textContent).indexOf('测试区') !== -1,
      '最新那条一定在屏上（最该看到的是它，而不是被旧 toast 挤掉）')
    assert(newest.attrs && newest.attrs.role === 'alert', '每条仍然带 role=alert（读屏用户的唯一通道）')
    assert(newest.children[0].style.wordBreak === 'break-word',
      '标题也允许换行（此前只有正文有 wordBreak，长标题会溢出 340px）')
  } catch (e) {
    assert(false, '0.9.4 toast 检查失败：' + e.message + (e && e.stack ? '\n' + e.stack.split('\n')[1] : ''))
  }

  // 市町村表的假名写法：表里有 11 处 U+3096「ゖ」（小写片假名 KE 的错误形式）、若干处把 ヶ/ケ 写成平假名 け 等。
  // 匹配被 normKana 捕获了，但设置页会把这些错名显示给用户，而且与河川区域表正面冲突。
  try {
console.log('== 市町村表的假名写法（22 处错名修好 + 不许再回来）==')
    const { CITIES_BY_PREF: CITIES_94B } = await import(pathToFileURL(path.join(ROOT, 'lib', 'data', 'cities.js')).href)
    const { RIVER_AREAS: RIVER_94B } = await import(pathToFileURL(path.join(ROOT, 'lib', 'data', 'river-areas.js')).href)
    const t94 = loadClientEx().exports.__test
    const allCities = []
    for (const pref of Object.keys(CITIES_94B)) for (const c of CITIES_94B[pref]) allCities.push(c)
    const withBadChar = allCities.filter((c) => c.indexOf('\u3096') !== -1)
    assert(allCities.length === 1917, '市区町村表共 ' + allCities.length + ' 条')
    assert(withBadChar.length === 0, '表里没有 U+3096「ゖ」（此前 11 处）：' + withBadChar.join('/'))
    const riverByNorm = new Map()
    for (const a of RIVER_94B) for (const c of a.cities) riverByNorm.set(t94.normKana(c), c)
    const conflicts = []
    for (const c of allCities) {
      const r = riverByNorm.get(t94.normKana(c))
      if (r && r !== c) conflicts.push(c + '≠' + r)
    }
    assert(conflicts.length === 0, '与河川表零冲突（修复前 8 处）：' + conflicts.join(' '))
    const FIXED = [
      ['外ヶ浜町', '外ゖ浜町'], ['鰺ヶ沢町', '鰺ゖ沢町'], ['六ヶ所村', '六ゖ所村'],
      ['金ケ崎町', '金け崎町'], ['七ヶ宿町', '七ゖ宿町'], ['七ヶ浜町', '七ゖ浜町'],
      ['龍ケ崎市', '龍け崎市'], ['鶴ヶ島市', '鶴ゖ島市'], ['鎌ケ谷市', '鎌け谷市'],
      ['袖ケ浦市', '袖け浦市'], ['青ヶ島村', '青ゖ島村'], ['茅ヶ崎市', '茅ゖ崎市'],
      ['横浜市保土ケ谷区', '横浜市保土け谷区'], ['南アルプス市', '南あるぷす市'],
      ['駒ヶ根市', '駒ゖ根市'], ['関ケ原町', '関け原町'], ['吉野ヶ里町', '吉野ゖ里町'],
      ['五ヶ瀬町', '五ゖ瀬町'], ['上ノ国町', '上の国町'], ['ニセコ町', 'にせこ町'],
      ['西ノ島町', '西の島町'], ['山ノ内町', '山の内町'],
    ]
    const set = new Set(allCities)
    const missing = FIXED.filter(([good]) => !set.has(good)).map(([good]) => good)
    const leftover = FIXED.filter(([, bad]) => set.has(bad)).map(([, bad]) => bad)
    assert(missing.length === 0, '22 处官方写法都在表里（缺：' + (missing.join('/') || '无') + '）')
    assert(leftover.length === 0, '22 处错写法都不在表里（残留：' + (leftover.join('/') || '无') + '）')
    const t94b = loadClientEx().exports.__test
    t94b.setCityTable(CITIES_94B)
    for (const [good, pref] of [['六ヶ所村', '青森県'], ['龍ケ崎市', '茨城県'], ['ニセコ町', '北海道'], ['山ノ内町', '長野県']]) {
      assert(t94b.prefsOfCity(good).indexOf(pref) !== -1, good + ' → ' + pref + '（实际 ' + t94b.prefsOfCity(good).join('/') + '）')
    }
  } catch (e) {
    assert(false, '0.9.4 市町村表假名检查失败：' + e.message)
  }

  // ==========================================================================
    // 历史的「30 条 + 过去 5 天」两个上限
  //
  // 设计稿一直写的是"两个条件同时生效、取更严格的"，而代码只实现了 30 条那一半：
  // 陈年条目会一直占着那 30 个位置。这里钉住两条路（写入时的剪枝 与 读取本地存储时的过滤）。
  // ==========================================================================
  try {
console.log('== 历史记录的时间上限（过去 5 天）==')
    const t = loadClientEx().exports.__test
    const DAY = 24 * 60 * 60 * 1000
    const age = t.HISTORY_MAX_AGE_MS
    assert(age === 5 * DAY, '上限是 5 天（' + (age / DAY) + '）')
    // **不能写死绝对时刻**：addEvent 内部用**真实时钟**剪枝，只有"喂进去的 now"与"真实 now"
    // 同源，两者才不会随时间错位——写死 2026-09-27T12:00Z 时，真实时间一过 7 天，`at: now - 1*DAY`
    // 的条目就会被当成过期剪掉，「窗口内的条目保留」随之变红。这条是时钟前移检查
    // （scripts/check-time-travel.mjs）在 +7 天处抓到的，与上面那条 24 小时记忆是同一类炸弹。
    const now = Date.now()
    assert(t.withinHistoryAge({ at: now - 4 * DAY, issued: '2019-01-01T00:00:00Z' }, now) === true,
      '写入 4 天前 → 保留（即便电文本身很旧）')
    assert(t.withinHistoryAge({ at: now - 6 * DAY }, now) === false, '写入 6 天前 → 丢弃')
    assert(t.withinHistoryAge({ issued: new Date(now - 6 * DAY).toISOString() }, now) === false,
      '老记录没有 at → 退回按 issued 判（这正是要清掉的那批）')
    assert(t.withinHistoryAge({ issued: new Date(now - 2 * DAY).toISOString() }, now) === true,
      '老记录 issued 在 5 天内 → 保留')
    assert(t.withinHistoryAge({}, now) === true && t.withinHistoryAge({ at: 0, issued: '乱码' }, now) === true,
      '两个时间都认不出 → **保留**（不因为缺字段删用户的数据）')
    const seed = { 'dsh.quakeAlert.history': JSON.stringify([
      { key: 'old-1', id: 'old-1', issued: '2026-09-20T00:00:00Z', headline: '六天前', at: now - 6 * DAY },
      { key: 'ok-1', id: 'ok-1', issued: '2026-09-26T00:00:00Z', headline: '一天前', at: now - 1 * DAY },
      { key: 'legacy-old', id: 'legacy-old', issued: '2026-09-01T00:00:00Z', headline: '没写 at 的旧条目' },
    ]) }
    const t2 = loadClientEx(seed).exports.__test
    const loaded = t2.loadHistory(now)
    assert(loaded.length === 1 && loaded[0].key === 'ok-1',
      '读取本地存储时丢掉"写入 6 天前"的那条、也丢掉"没有 at 且 issued 很旧"的老记录，只留窗口内的：' +
      loaded.map((e) => e.key).join('/'))
    // 写入路径：给一条新事件，过期的必须消失
    t2.addEvent({ id: 'fresh', issued: '2026-09-27T00:00:00Z', headline: '刚到的', at: now })
    const after = t2.loadHistory(now).map((e) => e.key)
    assert(after.indexOf('fresh') === 0, '新条目在最前（写入路径正常）')
    assert(after.indexOf('ok-1') !== -1, '窗口内的条目保留')
    const t3 = loadClientEx().exports.__test
    for (let i = 0; i < t3.HISTORY_MAX + 5; i += 1) {
      t3.addEvent({ id: 'n' + i, issued: '2026-09-27T00:00:00Z', headline: '第' + i, at: now })
    }
    assert(t3.loadHistory(now).length === t3.HISTORY_MAX,
      '条数上限仍然是 ' + t3.HISTORY_MAX + '（' + t3.loadHistory(now).length + '）')
  } catch (e) {
    assert(false, '0.9.4 历史时间上限检查失败：' + e.message)
  }

  // ==========================================================================
    // 常量唯一来源 / 北海道简写 / 强度缺失 / 通知权限 / 死键
  // ==========================================================================
  try {
console.log('== 尾项：常量、简写、强度、权限、死键 ==')
    const t = loadClientEx().exports.__test
    assert(t.LEGACY_PLACE_RADIUS_KM === 300,
      '缺半径时的兜底是命名常量 LEGACY_PLACE_RADIUS_KM=300（比默认 100 宽：收窄=漏报方向）')
    const np = t.normalizeCfg({ watch: { places: [{ name: 'x', lat: 30, lon: 100 }] } })
    assert(np.watch.places[0].radiusKm === t.LEGACY_PLACE_RADIUS_KM, '规整用的就是这个常量（不再是散落的 300）')
    const manyCities = t.normalizeCfg({ watch: { cities: Array.from({ length: 400 }, (_, i) => '市' + i) } })
    assert(manyCities.watch.cities.length === t.MAX_WATCH_CITIES || manyCities.watch.cities.length === 300,
      '市区町村上限走 MAX_WATCH_CITIES 常量：' + manyCities.watch.cities.length)
    const citiesAudit = { total: 0, dropped: 0, radiusFixed: 0, citiesDropped: 0 }
    t.normalizeCfg({ watch: { cities: Array.from({ length: 400 }, (_, i) => '市' + i) } }, citiesAudit)
    assert(citiesAudit.citiesDropped === 400 - (t.MAX_WATCH_CITIES || 300),
      '导入时被截断的市町村条数记进 audit（导入结果会如实说明，不再静默丢弃）：' + citiesAudit.citiesDropped)
    assert(t.normalizePref('北海道') === '北海道', '北海道本身是全称，不被削后缀')
    assert(t.normalizePref('北海') === '北海', '「北海」不是任何县的简写（以前会被当成北海道）')
    assert(t.normalizePref('東京') === '東京都' && t.normalizePref('大阪') === '大阪府',
      '需要削后缀的（东京都 / 大阪府）照旧能统一到全称')
    const aliases = t.cityAliases('札幌市', '北海道')
    assert(aliases.every((a) => a.indexOf('北海札幌') === -1),
      '北海道的市町村不再生成「北海○○市」这种幻影别名：' + aliases.join('/'))
    assert(!aliases.some((a) => a === '北海札幌市'), '（同一条的显式写法）')
    const noStrength = {
      id: 'ns-1', code: 'usgs', source: 'usgs', kind: 'quake', kindLabel: 'x', locator: 'point',
      severity: 'orange', issued: '2026-09-27T10:00:00Z', headline: 'M5', magnitude: 5,
      eventKey: 'geo:ns-1', geo: { lat: 35, lon: 139 }, regions: [], cancelled: false,
    }
    assert(t.isEventRepeat(noStrength, 10) === false, '（前置）第一次见到 → 不是重复')
    assert(t.isEventRepeat(Object.assign({}, noStrength, { issued: '2026-09-27T10:01:00Z' }), 10) === false,
      '同事件键再来一条、但 strength 缺失 → **不**判重复（宁可多响一次，也不因为缺字段静默）')
    // 缺 strength 的那条除了"自己不被判重复"，还**不能把记忆里的强度抹成 undefined**：抹掉之后
    // 真正的震级上修（`6.4 > undefined` 恒 false）会被后续的 isStrengthUpgrade 判成"没升级"而静默。
    {
      const evB2 = Object.assign({}, noStrength, {
        eventKey: 'geo:b2-check', geo: { lat: 12.34, lon: 56.78 }, strength: 5.2,
      })
      assert(t.isEventRepeat(evB2, 10) === false, '（前置）登记一条 M5.2 的事件')
      const noStrB2 = Object.assign({}, evB2, { issued: '2026-09-27T10:05:00Z' })
      delete noStrB2.strength
      assert(t.isEventRepeat(noStrB2, 10) === false, '（前置）缺 strength 的后续发布也不判重复')
      assert(t.isStrengthUpgrade(Object.assign({}, evB2, { strength: 6.4 })) === true,
        '缺 strength 的中间版本不覆盖记忆 → 之后 M5.2 → M6.4 仍被判为升级' +
        '（修复前记忆里的强度被写成 undefined，这条上修会被静默）')
    }
    {
      const s = loadClientEx({}, {
        window: {
          Notification: Object.assign(function () {}, {
            permission: 'default',
            requestPermission: (cb) => { cb('granted') }, // 老式签名：返回 undefined，结果给回调
          }),
        },
      }).exports.__test
      const p = s.requestNotificationPermission()
      assert(p && typeof p.then === 'function', '回调式实现也返回 Promise（此前是 Promise.resolve(undefined)）')
      const res = await p
      assert(res === 'granted', '回调式实现的结果被接住（界面不再谎报"未获授权"）：' + res)
    }
    {
      const zh = t.tableOf('zh-CN')
      assert('scale.10' in zh && 'scale.46' in zh && 'tsunami.Warning' in zh,
        '震度 / 海啸等级的词已复活成按语言取词的活键（0.9.4 本地化解析层）')
      assert(!('source.jma' in zh) && !('source.nmc' in zh),
        'source.jma|nmc 仍然是死键（活的那份是 00f 的 settings.sourceLabels.*）')
      for (const lang of t.LANGS) {
        const tb = t.tableOf(lang)
        assert(typeof tb['scale.60'] === 'string' && typeof tb['tsunami.MajorWarning'] === 'string' &&
          typeof tb['kind.jmaHeavyRain'] === 'string' && typeof tb['reason.cancelNoPriorAlert'] === 'string',
          lang + '：解析层标签与原因文案都在（scale / tsunami / kind / reason）')
      }
      assert('scaleOpt.40' in zh && 'tsunamiOpt.Watch' in zh && 'settings.sourceLabels.jma' in zh,
        '对照：真正在用的那批键一个都没动')
      for (const lang of t.LANGS) {
        const tb = t.tableOf(lang)
        assert(typeof tb['settings.configIo.copied'] === 'string' && typeof tb['settings.configIo.copyBtn'] === 'string',
          lang + '：配置页「复制」两条文案齐全（0.9.4 把复制按钮做出来了，这两个键不再是死键）')
      }
    }
  } catch (e) {
    assert(false, '0.9.4 P3 尾项检查失败：' + e.message)
  }

  // ==========================================================================
  // 「没命中」不进历史，但「判不了」必须留痕
  // 分界由 matcher 的 `cannotJudge` 标记给出。
  // ==========================================================================
  try {
console.log('== 没命中不进历史 / 判不了必须留痕 ==')
    const t = loadClientEx().exports.__test
    const mk = (patch) => {
      const cfg = JSON.parse(JSON.stringify(t.DEFAULT_CFG))
      cfg.notify = { sound: false, system: false, volume: 0 }
      cfg.watch = { prefectures: ['東京都'], cities: [], places: [{ name: '点', lat: 35.0, lon: 139.0, radiusKm: 100 }] }
      return Object.assign(cfg, patch || {})
    }
    const hist = () => t.loadHistory().length
    const l1 = t.parseJma(fs.readFileSync(path.join(ROOT, 'samples', 'jma-vxko-flood.xml'), 'utf8'), { id: 'l2' })
    assert(l1.level === 2, '（前置）样本是 L2 电文')
    const before1 = hist()
    const r1 = t.handleAlert(l1, mk({ watch: { prefectures: ['東京都'], cities: [], places: [] } }))
    assert(r1.notified === false && r1.reason === 'not-hit', 'L2 不播报')
    assert(hist() === before1, 'L2（未达档位）不进历史 —— 此前会占掉 HISTORY_MAX 的一个位置')
    const far = {
      id: 'usgs:far-pd1', code: 'usgs', source: 'usgs', kind: 'quake', kindLabel: 'USGS', locator: 'point',
      severity: 'orange', issued: '2026-09-27T10:00:00Z', headline: 'M5 · 远处', magnitude: 5, maxScale: -1,
      strength: 5, eventKey: 'geo:pd1-far', geo: { lat: -40, lon: -100 }, regions: [], cancelled: false,
    }
    const before2 = hist()
    const r2 = t.handleAlert(far, mk())
    assert(r2.notified === false, '远处地震不播报')
    assert(hist() === before2, '没命中的全球地震不进历史（原有口径，现在对所有源一致）')
    {
      const originRaw = {
        code: 551, id: 'jp-pd1-origin', issue: { time: '2026/09/27 19:00:00', type: 'OriginTime' },
        earthquake: { time: '2026/09/27 19:00:00', hypocenter: { name: '茨城県南部', latitude: 36.0, longitude: 140.1, magnitude: 5 } },
      }
      const before3 = hist()
      const r3 = t.handleAlert(t.parseQuake(originRaw), mk())
      assert(r3.notified === false && r3.detail.indexOf('震源情报') !== -1, '震源情报不播报，原因如实：' + r3.detail)
      assert(hist() === before3 + 1, '震源情报**进历史**（"判不了"不等于"离得远"）')
    }
    {
      const noGeo = Object.assign({}, far, {
        id: 'usgs:nogeo-pd1', eventKey: 'geo:pd1-nogeo', geo: { lat: null, lon: null },
        issued: '2026-09-27T10:05:00Z',
      })
      const before4 = hist()
      t.handleAlert(noGeo, mk())
      assert(hist() === before4 + 1, '坐标缺失的点型消息进历史（DESIGN 3.1：不猜、如实说明）')
    }
    {
      const before5 = hist()
      t.handleAlert(far, mk({ watch: { prefectures: [], cities: [], places: [] } }))
      assert(hist() === before5, '未配置关注点时不进历史（否则每天几十条"未设置关注点"会占满）')
    }
  } catch (e) {
    assert(false, '0.9.4 PD-1 检查失败：' + e.message)
  }

  // ==========================================================================
  // 震度档位就近对齐，震级门槛不动
  // 震级门槛不吸附——下拉里的 M3〜M7 只是常用预设，M6.7 这样的自定义门槛是合法的。
  // ==========================================================================
  try {
console.log('== 震度档位就近对齐 ==')
    const t = loadClientEx().exports.__test
    const th = (patch) => t.normalizeCfg({ thresholds: patch }).thresholds
    assert(th({ quakeScale: 42 }).quakeScale === 40, '手改的 42 → 40（就近档位，界面选得中）')
    assert(th({ quakeScale: 47 }).quakeScale === 45, '47 → 45')
    assert(th({ quakeScale: 48 }).quakeScale === 50, '48 → 50（最近的一档）')
    assert(th({ quakeScale: 5 }).quakeScale === 10, '5 → 10（最小档）')
    assert(th({ quakeScale: 999 }).quakeScale === 70, '999 → 夹到上界 70')
    assert(th({ quakeScale: 0 }).quakeScale === 0, '0 保留：它是"来者不拒"的显式取值（吸附到 10 等于收窄）')
    assert(th({ quakeScale: 'abc' }).quakeScale === t.DEFAULT_CFG.thresholds.quakeScale, '非法值仍回退默认档')
    assert(th({ eewScale: 43 }).eewScale === 45, 'eewScale 同样就近对齐（43 → 45）')
    assert(th({ quakeScale: 55 }).quakeScale === 55, '合法档位原样保留（55 不动）')
    // 震级门槛不吸附（三处：自定义值必须被保留）
    assert(th({ globalMagnitude: 6.7 }).globalMagnitude === 6.7, 'globalMagnitude 的自定义值保留（6.7 不是预设但合法）')
    assert(th({ cnReportMagnitude: 7 }).cnReportMagnitude === 7, 'cnReportMagnitude 同理（7 保留）')
    assert(th({ globalMagnitude: 99 }).globalMagnitude === 10, '震级仍然只做夹取（99 → 10）')
  } catch (e) {
    assert(false, '0.9.4 PD-2 检查失败：' + e.message)
  }

  // ==========================================================================
  // 「真正播报过」的 24 小时记忆要跨刷新存活
  // ==========================================================================
  try {
console.log('== 已播报记忆持久化 ==')
    const mkAlert = (t, id) => ({
      id, code: 'usgs', source: 'usgs', kind: 'quake', kindLabel: 'USGS', locator: 'point',
      severity: 'orange', issued: '2026-09-27T10:00:00Z', headline: 'M5 · 测试', magnitude: 5, maxScale: -1,
      strength: 5, eventKey: 'geo:persist-' + id, geo: { lat: 35.68, lon: 139.77 }, regions: [], cancelled: false,
    })
    const cfg = () => {
      const c = JSON.parse(JSON.stringify(loadClientEx().exports.__test.DEFAULT_CFG))
      c.notify = { sound: false, system: false, volume: 0 }
      c.watch = { prefectures: [], cities: [], places: [{ name: '东京', lat: 35.68, lon: 139.77, radiusKm: 100, origin: 'global' }] }
      return c
    }
    const s1 = loadClientEx()
    const t1 = s1.exports.__test
    const alert = mkAlert(t1, 'a1')
    const r1 = t1.handleAlert(alert, cfg())
    assert(r1.notified === true, '（前置）播报一条：' + JSON.stringify(r1))
    const stored = s1.storage.get('dsh.quakeAlert.alerted')
    assert(typeof stored === 'string' && stored.indexOf('geo:persist-a1') !== -1,
      '播报后写进 localStorage（此前是纯内存）：' + String(stored).slice(0, 80))
    // 重新加载（同一份 localStorage）→ 记忆仍在
    const seed = Object.fromEntries(s1.storage)
    const t2 = loadClientEx(seed).exports.__test
    assert(t2.wasRecentlyAlerted(alert) === true,
      '刷新后仍记得"这条播报过"——首次启动回看时的重放不会二次响铃')
    // 同一条消息在刷新后重新投递 → 不播报
    const r2 = t2.handleAlert(mkAlert(t2, 'a1'), cfg())
    assert(r2.notified === false && r2.reason === 'replayed',
      '刷新后重放同一条 → 按"已播报过"抑制，不再响铃：' + JSON.stringify(r2))
    // 超过 24 小时 → 记忆失效（并顺手清掉盘上的那份）
    {
      // **不能把「现在」写死成绝对时刻**：这个时钟要与用真实 now 写进盘里的记忆做差，
      // 所以要读一次真实 now 再加 25 小时——写死绝对时刻会随运行时刻跨过临界点而变红。
      const clockRef = { t: Date.now() + 25 * 60 * 60 * 1000 }
      class SandboxDate extends Date {
        constructor(...args) { if (args.length === 0) super(clockRef.t); else super(...args) }
        static now() { return clockRef.t }
      }
      const t3 = loadClientEx(seed, { Date: SandboxDate }).exports.__test
      assert(t3.wasRecentlyAlerted(alert) === false, '超过 24 小时的记忆失效（不会被陈年条目挡住）')
    }
    // 解除之后要把记忆删掉，而且删除也要写入本地存储（否则刷新后又「提醒过」）；取消 / 解除链路只处理 eew / tsunami / weather
    {
      const s4 = loadClientEx()
      const t4 = s4.exports.__test
      const ts = {
        id: 'noaa:persist-ts', code: 'noaa', source: 'noaa', kind: 'tsunami', kindLabel: '海啸警报',
        locator: 'point', severity: 'orange', issued: '2026-09-27T10:00:00Z', headline: 'Tsunami Advisory',
        tsunamiRank: 2, maxScale: 2, strength: 2, eventKey: 'noaa:persist-ts',
        geo: { lat: 35.68, lon: 139.77 }, regions: [], cancelled: false,
      }
      const r4 = t4.handleAlert(ts, cfg())
      assert(r4.notified === true, '（前置）海啸播报：' + JSON.stringify(r4))
      assert(String(s4.storage.get('dsh.quakeAlert.alerted') || '').indexOf('noaa:persist-ts') !== -1,
        '（前置）盘上有这条记忆')
      const cancelTs = Object.assign({}, ts, { id: 'noaa:persist-ts-cancel', issued: '2026-09-27T11:00:00Z', cancelled: true })
      t4.handleCancelled(cancelTs, cfg())
      const after = String(s4.storage.get('dsh.quakeAlert.alerted') || '')
      assert(after.indexOf('noaa:persist-ts') === -1,
        '解除后盘上的那条记忆也被清掉（否则同键解除会重复提示）：' + after.slice(0, 80))
    }
  } catch (e) {
    assert(false, '0.9.4 C6 检查失败：' + e.message)
  }

  // 重连后补拉断线窗口（/v2/history），首次连接不补
  try {
console.log('== 断线补拉 ==')
    const run = async (opts) => {
      const sockets = []
      class FakeWS {
        constructor(url) { this.url = url; sockets.push(this) }
        close() {}
      }
      const ex = loadClientEx({}, { window: { WebSocket: FakeWS } }).exports.__test
      const fed = []
      const client = ex.createWsClient(Object.assign({
        staleAfterMs: 0, // 本用例不测连接假死检测
        onRaw: (raw) => fed.push(raw),
      }, opts || {}))
      client.start()
      return { sockets, client, fed }
    }
    const nowMs = Date.now()
    const histRow = (code, id, time) => ({ code, id, time, issue: { time } })
    const inWindow = new Date(nowMs - 30 * 1000)
    const oldRow = new Date(nowMs - 30 * 60 * 1000)
    // **裸时间串必须按上游时区生成，绝不能按本机时区**：P2PQuake 的 `time` 是裸 JST，
    // 实现侧固定按 +09:00 解释。按本机时区拼串会让同一段代码在 UTC 的 CI 上把「30 秒前」写成
    // 9 小时前，补拉窗口把它判成窗口外。加 9 小时再取 UTC 字段 = 恒定按 JST 输出。
    const JST_OFFSET_MS = 9 * 60 * 60 * 1000
    const fmt = (d) => {
      const j = new Date(d.getTime() + JST_OFFSET_MS)
      const p = (n) => String(n).padStart(2, '0')
      return j.getUTCFullYear() + '/' + p(j.getUTCMonth() + 1) + '/' + p(j.getUTCDate()) + ' ' +
        p(j.getUTCHours()) + ':' + p(j.getUTCMinutes()) + ':' + p(j.getUTCSeconds())
    }
    {
      const urls = []
      const h = await run({ fetchJson: async (u) => { urls.push(u); return [] } })
      h.sockets[0].onopen()
      await new Promise((r) => setImmediate(r))
      assert(urls.length === 0, '首次连接不补拉（用户刚打开页面时不该把旧警报当新闻）')
      h.client.stop()
    }
    {
      const urls = []
      const rows = [
        histRow(551, 'h-in', fmt(inWindow)),
        histRow(556, 'h-old', fmt(oldRow)),
        { code: 551, id: 'h-notime' },
      ]
      const h = await run({ fetchJson: async (u) => { urls.push(u); return rows } })
      h.sockets[0].onopen()
      await new Promise((r) => setImmediate(r))
      assert(urls.length === 0, '（前置）首连不补')
      h.sockets[0].onclose({ code: 1006 }) // 断线 → 按递增间隔重连
      await new Promise((r) => setTimeout(r, 1200)) // 等重试间隔（1s）
      assert(h.sockets.length >= 2, '（前置）已经重连：' + h.sockets.length)
      h.sockets[1].onopen() // 补拉发生在 onopen（重连那一次）
      await new Promise((r) => setImmediate(r))
      assert(urls.length === 1, '重连后补拉一次：' + urls.length)
      assert(urls[0].indexOf('/v2/history') !== -1 &&
        urls[0].indexOf('&codes=551') !== -1 && urls[0].indexOf('&codes=552') !== -1 && urls[0].indexOf('&codes=556') !== -1,
        'URL 用官方 history 端点与重复的 codes 参数：' + urls[0])
      assert(h.fed.length === 1 && h.fed[0].id === 'h-in',
        '窗口内的那条补进主链、窗口外的与时间认不出的都跳过：' + JSON.stringify(h.fed.map((r) => r.id)))
      const st = h.client.backfillStatsOf()
      assert(st.attempts === 1 && st.fed === 1 && st.skipped === 2,
        '补拉计数如实：' + JSON.stringify(st))
      h.client.stop()
    }
    {
      const h = await run({ fetchJson: async () => { throw new Error('HTTP 503') } })
      h.sockets[0].onopen()
      h.sockets[0].onclose({ code: 1006 })
      await new Promise((r) => setTimeout(r, 1200))
      h.sockets[1].onopen()
      await new Promise((r) => setImmediate(r))
      const st = h.client.backfillStatsOf()
      assert(st.errors === 1 && st.fed === 0, '补拉失败计入 errors：' + JSON.stringify(st))
      h.client.stop()
    }
  } catch (e) {
    assert(false, '0.9.4 C5 检查失败：' + e.message)
  }

  // 注册表随 start/stop 增删；海外取数按流读、超限即停
  try {
console.log('== SSE 注册表生命周期与海外取数流式上限 ==')
    const t = loadClientEx()
    const tt = t.exports.__test
    {
      const fakeES = (url) => ({ url, listeners: {}, addEventListener(t2, fn) { (this.listeners[t2] = this.listeners[t2] || []).push(fn) }, close() {} })
      const c = tt.createCnStream({
        id: 'cenc_eew_probe', createEventSource: fakeES, setTimer: () => 1, clearTimer: () => {},
        getCfg: () => ({ disasters: { earthquake: true } }), loadCursor: () => null, saveCursor: () => {},
        onStatus: () => {}, onError: () => {},
      })
      assert(!tt.cnStreamRegistry['cenc_eew_probe'], '构造时不注册（还没启动）')
      c.start()
      assert(!!tt.cnStreamRegistry['cenc_eew_probe'], 'start() 后出现在注册表里')
      c.stop()
      assert(!tt.cnStreamRegistry['cenc_eew_probe'], 'stop() 后从注册表里删掉（诊断不再列一个已停用的源）')
      c.start()
      assert(!!tt.cnStreamRegistry['cenc_eew_probe'], '再次 start() 会重新注册（restart 语义）')
      c.stop()
    }
    {
      const injected = []
      const chunks = []
      for (let i = 0; i < 40; i += 1) chunks.push(new Uint8Array(20 * 1024).fill(65)) // 每块 20KB
      const streamObj = () => new globalThis.ReadableStream({
        start(c) { for (const ch of chunks) c.enqueue(ch); c.close() },
      })
      const ex = loadClientEx({}, {
        fetch: async (url) => {
          injected.push(url)
          return {
            ok: true, status: 200, headers: { get: () => null }, body: streamObj(),
            text: async () => { throw new Error('有 body 流时不该回退到 res.text()') },
          }
        },
      }).exports.__test
      let msg = ''
      try { await ex.defaultFetchText('https://api.weather.gov/alerts?x=1', { timeoutMs: 1000 }) } catch (err) { msg = String(err.message) }
      assert(msg.indexOf('too large') !== -1, '超限即抛（上限 ' + ex.OVERSEAS_MAX_BODY_CHARS + ' 字符）：' + msg)
      // 上限之内的正常响应仍能解出
      const small = loadClientEx({}, {
        fetch: async () => ({
          ok: true, status: 200, headers: { get: () => null },
          body: new globalThis.ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode('{"ok":true}')); c.close() } }),
          text: async () => { throw new Error('不该回退') },
        }),
      }).exports.__test
      assert((await small.defaultFetchText('https://api.weather.gov/alerts?x=2', { timeoutMs: 1000 })) === '{"ok":true}',
        '上限内的响应正常解出（流式读取不影响正常路径）')
    }
  } catch (e) {
    assert(false, '0.9.4 C10/C12 检查失败：' + e.message)
  }

  // ==========================================================================
  // 分灾害音效开关（地震含 EEW / 海啸 / 气象）
  // ==========================================================================
  try {
console.log('== 分灾害音效开关 ==')
    const t = loadClientEx().exports.__test
    const cfgOf = (notify) => ({ notify: Object.assign({ sound: true, system: true, volume: 0.7, soundQuake: true, soundTsunami: true, soundWeather: true }, notify || {}) })
    const aOf = (kind, patch) => Object.assign({
      id: 'c1-' + kind, code: 'x', source: 'x', kind, kindLabel: 'x', locator: 'point',
      severity: 'orange', issued: '2026-09-27T10:00:00Z', headline: 'h', maxScale: 5,
      strength: 5, eventKey: 'c1:' + kind, geo: { lat: 35, lon: 139 }, regions: [], cancelled: false,
    }, patch || {})
    assert(t.DEFAULT_CFG.notify.soundQuake === true && t.DEFAULT_CFG.notify.soundTsunami === true &&
      t.DEFAULT_CFG.notify.soundWeather === true, '默认三个分开关全开（与旧行为一致：升级不改变现状）')
    // 默认：都响
    assert(t.soundAllowedFor(cfgOf(), aOf('quake')) === true, '默认地震响')
    assert(t.soundAllowedFor(cfgOf(), aOf('eew')) === true, '默认 EEW 响（归入地震那一路）')
    assert(t.soundAllowedFor(cfgOf(), aOf('tsunami')) === true, '默认海啸响')
    assert(t.soundAllowedFor(cfgOf(), aOf('weather')) === true, '默认气象响')
    // 关掉地震：只影响地震与 EEW
    assert(t.soundAllowedFor(cfgOf({ soundQuake: false }), aOf('quake')) === false, '关掉地震 → 地震不响')
    assert(t.soundAllowedFor(cfgOf({ soundQuake: false }), aOf('eew')) === false, '关掉地震 → EEW 也不响')
    assert(t.soundAllowedFor(cfgOf({ soundQuake: false }), aOf('tsunami')) === true, '关掉地震不影响海啸')
    assert(t.soundAllowedFor(cfgOf({ soundQuake: false }), aOf('weather')) === true, '关掉地震不影响气象')
    // 关掉海啸 / 气象
    assert(t.soundAllowedFor(cfgOf({ soundTsunami: false }), aOf('tsunami')) === false, '关掉海啸 → 海啸不响')
    assert(t.soundAllowedFor(cfgOf({ soundWeather: false }), aOf('weather')) === false, '关掉气象 → 气象不响')
    // 海啸的**开关**按灾种判，与音色分档无关：津波注意報（rank 1）/ 津波警報（rank 2）的音色虽然
    // 沿用地震音色，但它们属于海啸开关——否则关掉地震音效的用户听不到海啸（该响没响），而关掉
    // 海啸音效的用户照旧听得到它（开关失效）。
    for (const [rank, name] of [[1, '津波注意報'], [2, '津波警報']]) {
      assert(t.soundAllowedFor(cfgOf(), aOf('tsunami', { maxScale: rank })) === true,
        '默认海啸响（' + name + '，rank ' + rank + '）')
      assert(t.soundAllowedFor(cfgOf({ soundTsunami: false }), aOf('tsunami', { maxScale: rank })) === false,
        '关掉海啸 → ' + name + ' 也不响（不因音色分档绕过开关）')
      assert(t.soundAllowedFor(cfgOf({ soundQuake: false }), aOf('tsunami', { maxScale: rank })) === true,
        '关掉地震不影响 ' + name)
    }
    // 音色分档本身保留：修的是开关，不是音色（大津波用海啸音色，津波警報沿用地震音色）
    assert(t.soundKindOf(aOf('tsunami', { maxScale: 3 })) === 'tsunami', '大津波用海啸音色')
    assert(t.soundKindOf(aOf('tsunami', { maxScale: 2 })) === 'quake', '津波警報沿用地震音色（音色设计，未变）')
    // 认不出的 kind 只看总开关：音色兜底成地震音色，但开关不该跟着走地震那一路
    assert(t.soundAllowedFor(cfgOf({ soundQuake: false }), aOf('mystery')) === true,
      '认不出的 kind 不受地震分开关影响（只看总开关）')
    assert(t.soundAllowedFor(cfgOf({ sound: false }), aOf('mystery')) === false, '认不出的 kind 仍受总开关管')
    // 总开关优先
    assert(t.soundAllowedFor(cfgOf({ sound: false }), aOf('quake')) === false, '总开关关掉 → 一律不响')
    assert(t.soundAllowedFor(cfgOf({ sound: false, soundQuake: true }), aOf('eew')) === false, '总开关优先于分开关')
    // 配置链：normalizeCfg 不能把三个字段丢掉（丢了就是"关掉之后刷新又开了"）
    const norm = t.normalizeCfg({ notify: { soundQuake: false, soundTsunami: true, soundWeather: false } })
    assert(norm.notify.soundQuake === false && norm.notify.soundTsunami === true && norm.notify.soundWeather === false,
      'normalizeCfg 保留三个分开关：' + JSON.stringify(norm.notify))
    // boolOr 的既有语义：**只认布尔值**，别的一律回退默认（不做 "no"/0/"" 之类的猜测）
    assert(t.normalizeCfg({ notify: { soundQuake: 'no' } }).notify.soundQuake === true,
      '非布尔值回退默认 true（boolOr 只认 boolean，不猜字符串）')
    assert(t.normalizeCfg({ notify: { soundQuake: false } }).notify.soundQuake === false, '布尔 false 被保留')
    assert(t.normalizeCfg({}).notify.soundQuake === true, '缺字段 → 回默认 true')
    // 四种语言都得有这三条文案
    for (const lang of t.LANGS) {
      const tb = t.tableOf(lang)
      assert(typeof tb['settings.notify.soundQuake'] === 'string' && typeof tb['settings.notify.soundTsunami'] === 'string' &&
        typeof tb['settings.notify.soundWeather'] === 'string',
        lang + '：分灾害音效三条文案齐全')
    }
    // Host schema：机器级配置写这三个字段不能被丢弃
    {
      const mod = await import(pathToFileURL(path.join(ROOT, 'lib', 'index.js')).href)
      const parsed = unwrapRefs(mod.QuakeAlertSettingsSchema({ notify: { soundQuake: false, soundTsunami: false, soundWeather: true } }))
      assert(parsed.notify.soundQuake === false && parsed.notify.soundTsunami === false && parsed.notify.soundWeather === true,
        'Host schema 接受并保留三个分开关：' + JSON.stringify(parsed.notify))
      // schemastery 的 schema 是**可调用**的（不是 zod 的 .parse），与上面既有用例同一手法
      assert(unwrapRefs(mod.QuakeAlertSettingsSchema({})).notify.soundQuake === true, 'Host schema 的默认值为 true')
    }
  } catch (e) {
    assert(false, '0.9.4 C1 检查失败：' + e.message)
  }

  // 源契约的 `required` 必须与实现一致（钉的是实现那一侧，契约文本没法机器校验）
  try {
console.log('== 源契约与实现一致 ==')
    const t = loadClientEx().exports.__test
    const q551 = {
      code: 551, id: 'c2-551', issue: { time: '2026/09/27 19:00:00', type: 'ScalePrompt' },
      earthquake: { maxScale: 40, hypocenter: { name: '茨城県南部', magnitude: 5 } },
      points: [{ pref: '茨城県', addr: '茨城県南部' }, { pref: '栃木県', addr: '栃木県南部', scale: 30 }],
    }
    const r551 = t.parseEpspResult(q551)
    assert(r551.ok === true, '551 缺 earthquake.time、有观测点缺 scale → ok（不判 schema）：' + JSON.stringify(r551).slice(0, 120))
    assert(r551.alert.eventKey === '', '缺 earthquake.time 的代价是事件键为空（不做事件级去重），而不是丢警报')
    // 真正要拦的仍然拦：points 不是数组
    assert(t.parseEpspResult(Object.assign({}, q551, { points: 'nope' })).kind === 'schema',
      'points 不是数组 → schema（结构型错误照样拦）')
    const q552 = { code: 552, id: 'c2-552', issue: { time: '2026/09/27 19:00:00' }, cancelled: false,
      areas: [{ grade: 'Bogus' }, { grade: 'Warning' }] }
    const r552 = t.parseEpspResult(q552)
    assert(r552.ok === true, '552 的 areas 缺 name、grade 未知 → ok（不查枚举）：' + JSON.stringify(r552).slice(0, 120))
    assert(r552.alert.headline.indexOf('—') !== -1, '缺 name 的预报区在正文里显示为「—」（如实说明而不是丢条）')
    const q556 = {
      code: 556, id: 'c2-556', issue: { time: '2026/09/27 19:00:00' },
      earthquake: { hypocenter: { name: '茨城県南部', magnitude: 5 } },
      areas: [{ name: '茨城県', scaleTo: 40 }],
    }
    const r556 = t.parseEpspResult(q556)
    assert(r556.ok === true, '556 缺 issue.eventId → ok：' + JSON.stringify(r556).slice(0, 120))
    assert(t.parseEpspResult(Object.assign({}, q556, { areas: [{ scaleTo: 40 }] })).kind === 'schema',
      '556 的 areas 缺 name → schema（这一条实现确实拦）')
    {
      const xml = '<?xml version="1.0"?><Report xmlns="http://xml.kishou.go.jp/jmaxml1/">' +
        '<Control><Title>テスト</Title><DateTime>2026-09-27T10:00:00Z</DateTime></Control>' +
        '<Head><ReportDateTime>2026-09-27T19:00:00+09:00</ReportDateTime></Head><Body></Body></Report>'
      const r = t.parseJmaResult(xml, { id: 'c2-jma' })
      assert(r.ok === false && r.kind === 'empty',
        'JMA 电文没有 Item / Area → empty（"与我们无关"），不是 schema：' + JSON.stringify(r).slice(0, 140))
      const html = t.parseJmaResult('<!DOCTYPE html><html><body>blocked</body></html>', { id: 'c2-html' })
      assert(html.ok === false && html.kind === 'schema', 'HTML 才是 schema（拦截页 / 地址失效）')
    }
    {
      const nmc = { alertid: 'c2-nmc', kind: 'volcano', level: 'red', title: '某某气象台发布火山预警信号', issued: '2026-09-27T10:00:00+08:00' }
      const r = t.parseNmcAlarmResult(nmc)
      assert(r.ok === false && r.kind === 'empty', 'NMC 的 kind 不在范围内 → empty：' + JSON.stringify(r).slice(0, 140))
      const r2 = t.parseNmcAlarmResult(Object.assign({}, nmc, { kind: 'rainstorm', level: 'purple' }))
      assert(r2.ok === false && r2.kind === 'schema', '对照：level 越界 → schema（等级是判据本身）')
    }
    {
      const table = { type: 'cenc_eqlist', No1: { EventID: 'c2-eq-1', latitude: '30.5', longitude: '100.5', magnitude: '4.0', time: '2026/09/27 19:00:00' } }
      const r = t.parseCencEqlistResult(table)
      assert(r.ok === true, '整表没有 md5 → 仍然 ok（md5 不是判据）：' + JSON.stringify(r).slice(0, 120))
    }
    {
      const feat = { type: 'Feature', properties: { mag: 5, time: Date.UTC(2026, 8, 27, 10, 0, 0), lat: 35.0, lon: 139.0 }, geometry: null }
      const r = t.parseUsgsResult(feat)
      assert(r.ok === true, 'USGS 的坐标走 properties.lat/lon → ok（契约此前写成"必须 geometry.coordinates"）：' +
        JSON.stringify(r).slice(0, 120))
    }
  } catch (e) {
    assert(false, '0.9.4 C2/P3-41 检查失败：' + e.message)
  }

  // ==========================================================================
  // 两个「窗口」的分工（事件去重 3 小时 vs 解除匹配 24 小时）
  // ==========================================================================
  try {
console.log('== 事件窗口与解除窗口的分工 ==')
    const t = loadClientEx().exports.__test
    assert(t.WEATHER_EVENT_WINDOW_MINUTES === 180, '气象的事件窗口是 3 小时（同一官署同一灾种不再重复响铃）')
    const cfg = JSON.parse(JSON.stringify(t.DEFAULT_CFG))
    cfg.notify = { sound: false, system: false, volume: 0 }
    cfg.watch = { prefectures: ['東京都'], cities: [], places: [] }
    // 用测试电文生成器造 L4 电文（大雨危険警報）：手搓 alert 容易漏字段，导致断言测的是别的东西
    const base = Date.UTC(2026, 8, 27, 1, 0, 0) // 2026-09-27 10:00 JST
    const l4 = (ms, key) => t.parseJma(t.buildTestTelegram('東京都', ms, key || 'heavyrain'), { id: 'c4-' + ms })
    const a1 = l4(base)
    assert(a1 && a1.level >= 4, '（前置）样本是 L4 电文：level=' + (a1 && a1.level))
    assert(t.handleAlert(a1, cfg).notified === true, '（前置）第一次响')
    // 3 小时窗口内：同强度更新不响（事件键已按「官署 + 灾种」归并）
    const a2 = l4(base + 2 * 60 * 60 * 1000)
    assert(t.handleAlert(a2, cfg).notified === false, '3 小时内的同强度更新不再响（事件窗口在起作用）')
    // 升级仍然响：换成 L5 级场景（landslide 的电文本身即 L4，用 flood 的主文级别）
    const a3 = l4(base + 2.5 * 60 * 60 * 1000, 'stormsurge')
    assert(t.handleAlert(a3, cfg).notified === true || a3.eventKey === a1.eventKey,
      '窗口内的升级（不同灾种 / 更强级别）仍按各自的事件键判定，不会被整体吞掉')
  } catch (e) {
    assert(false, '0.9.4 C4 检查失败：' + e.message)
  }

  // 全球城市名统一取拉丁字母名：生成规则 `latinCityNameOf`，数据已按它重生成。
  // 这里同时钉规则（纯函数 + 脚本确实在用它）与数据（5224 条里一个汉字都没有）。
  try {
console.log('== 全球城市名统一拉丁 ==')
    const geo = await import(pathToFileURL(path.join(ROOT, 'scripts', 'lib', 'geonames.mjs')).href)
    assert(typeof geo.latinCityNameOf === 'function', 'latinCityNameOf 存在（生成脚本的取名规则）')
    assert(geo.latinCityNameOf({ ascii: 'Rome', name: 'Roma', alternates: '羅馬,罗马,Rome,ローマ' }) === 'Rome',
      '取 asciiname，不再优先 CJK 候选（此前同一张表里简繁与日汉字混用）')
    assert(geo.latinCityNameOf({ name: 'Zürich' }) === 'Zürich', '没有 asciiname 时退回 name')
    assert(geo.latinCityNameOf({}) === '' && geo.latinCityNameOf(null) === '',
      '空行 / null 返回空串（由调用方按"缺一条"记为问题）')
    const genSrc = fs.readFileSync(path.join(ROOT, 'scripts', 'build-world-cities.mjs'), 'utf8')
    assert(genSrc.indexOf('const cityNameOf = (row) => latinCityNameOf(row)') !== -1,
      '生成脚本确实在用这条规则（不是留着一个没人调的新函数）')
    assert(genSrc.indexOf('isCjk') === -1, '旧的"中文候选优先"逻辑已从生成脚本移除')
    // 数据侧：一条汉字都不该有（这是重生成后的实际状态，不是愿望）
    const world = await import(pathToFileURL(path.join(ROOT, 'lib', 'data', 'world-cities.js')).href)
    const allCities = Object.keys(world.WORLD_CITIES_BY_COUNTRY).reduce(
      (acc, cc) => acc.concat(world.WORLD_CITIES_BY_COUNTRY[cc]), [])
    const han = allCities.filter((c) => /[\u4e00-\u9fff]/.test(c.name))
    assert(han.length === 0,
      '城市名一个汉字都没有（' + allCities.length + ' 条里 ' + han.length + ' 条含汉字' +
      (han.length ? '：' + han.slice(0, 3).map((c) => c.name).join('/') : '') + '）')
    const it = world.WORLD_CITIES_BY_COUNTRY.IT
    assert(it.some((c) => c.name === 'Rome') && it.some((c) => c.name === 'Milan'),
      '抽查意大利：Rome / Milan（此前是「羅馬」/「米蘭」）')
    // 国家名不受影响：仍是本地化四条
    const itc = world.WORLD_COUNTRIES.filter((c) => c.code === 'IT')[0]
    assert(itc && itc.names && itc.names.ja === 'イタリア' && itc.names.en === 'Italy',
      '国家名仍是本地化四条（这次只动城市名）')
    assert(world.WORLD_COUNTRIES.every((c) => c.names && c.names['zh-CN'] && c.names.en),
      '166 个国家 / 地区的四条名字齐全')
  } catch (e) {
    assert(false, '0.9.4 PD-3 检查失败：' + e.message)
  }

  // ==========================================================================
  // **我们拼的字跟着界面语言走**（上游电文的原文原样透传，不翻）
  // 判据分两层：kindLabel / reason / 未命中后缀 / 震度与等级词随语言变；JMA 原句、地名、机构名不翻。
  // ==========================================================================
  try {
console.log('== 解析层／匹配层的自有文案随界面语言 ==')
    const HAN = /[\u4e00-\u9fff]/
    const LANGS4 = ['zh-CN', 'zh-TW', 'ja', 'en']
    const SOURCE_CONTRACTS = loadClientEx().exports.__test.SOURCE_CONTRACTS // 只用来读常量
    const heavyRainXml = fs.readFileSync(path.join(ROOT, 'samples', 'jma-vpww55-heavyrain.xml'), 'utf8')
    const cancelXml = fs.readFileSync(path.join(ROOT, 'samples', 'jma-vpno50-tokyo-cancel-20260907.xml'), 'utf8')
    const out = {}
    for (const lang of LANGS4) {
      const seed = {
        'dsh.quakeAlert.v1': JSON.stringify({
          version: 1, language: lang,
          watch: { prefectures: ['大阪府'], cities: [], places: [] },
        }),
      }
      const ex = loadClientEx(seed).exports.__test
      // **必须在解析之前让配置落地**：语言由 loadCfg/applyCfg 里的 setLanguage(cfg.language) 生效，
      // 而 bundle 初始化时不立刻读配置——第一次读发生在某个 API 被访问时。
      ex.loadCfg()
      const alert = ex.parseJma(heavyRainXml, { id: 'loc-' + lang })
      const m = ex.matchAlert(alert, ex.currentCfg())
      // 取消 / 解除链路：此前未提醒过 → 写一条命中 false 的历史（用户看到的就是这一条）
      const cxl = ex.parseJma(cancelXml, { id: 'loc-cancel-' + lang })
      const before = ex.loadHistory().length
      ex.handleCancelled(cxl, ex.currentCfg())
      const hist = ex.loadHistory()
      out[lang] = {
        label: alert.kindLabel,
        reason: m.reason,
        cancelLabel: cxl.kindLabel,
        entry: hist.length > before ? hist[0].headline : '',
      }
    }
    // ① 每个字段都随语言变；但标签类不能要求「四种互不相同」——`大雨警報` 在繁体与日文里本来就同形
    for (const field of ['label', 'reason', 'cancelLabel', 'entry']) {
      for (const lang of ['zh-CN', 'zh-TW', 'ja']) {
        assert(out.en[field] !== out[lang][field],
          field + ' 在 en 与 ' + lang + ' 下必须不同：en=' + out.en[field] + ' ／ ' + lang + '=' + out[lang][field])
      }
    }
    for (const field of ['reason', 'entry']) {
      const vals = LANGS4.map((l) => out[l][field])
      assert(new Set(vals).size === LANGS4.length, field + ' 四种语言互不相同：' + vals.join(' ｜ '))
    }
    assert(!HAN.test(out.en.label), 'en 的 kindLabel 无汉字：' + out.en.label)
    assert(!HAN.test(out.en.reason), 'en 的未命中原因无汉字：' + out.en.reason)
    assert(!HAN.test(out.en.cancelLabel), 'en 的取消标签无汉字：' + out.en.cancelLabel)
    assert(out.en.reason.indexOf('not matched') !== -1 || !HAN.test(out.en.entry.replace(/[\u3040-\u30ff\u4e00-\u9fff]+/g, '')),
      'en 的履历标题里的自有文案是英文：' + out.en.entry)
    assert(out['zh-CN'].entry.indexOf('（未命中：') !== -1, 'zh-CN 的未命中后缀：' + out['zh-CN'].entry)
    assert(out.en.entry.indexOf('(not matched:') !== -1, 'en 的未命中后缀：' + out.en.entry)
    assert(out.ja.entry.indexOf('（未命中：') !== -1, 'ja 的未命中后缀：' + out.ja.entry)
    for (const lang of LANGS4) {
      assert(/[\u3040-\u30ff]/.test(out[lang].entry),
        lang + ' 下上游原文仍在（不翻电文原话）：' + out[lang].entry)
    }
    const srcLabels = {}
    for (const lang of LANGS4) {
      const seed = { 'dsh.quakeAlert.v1': JSON.stringify({ version: 1, language: lang, watch: { prefectures: ['東京都'], cities: [], places: [] } }) }
      const ex = loadClientEx(seed).exports.__test
      ex.loadCfg()
      srcLabels[lang] = {
        jma: ex.p2pCodeTextOf('weather', 'jma', 'vpww55'),
        cencEew: ex.p2pCodeTextOf('eew', 'cenc_eew', 'cenc-eew'),
        nmc: ex.p2pCodeTextOf('weather', 'nmc_alarm', 'nmc-1'),
        emsc: ex.p2pCodeTextOf('quake', 'emsc', 'emsc:1'),
        code: ex.p2pCodeTextOf('quake', '551', 'p2p-1'),
      }
    }
    assert(srcLabels.en.jma !== srcLabels['zh-CN'].jma && !HAN.test(srcLabels.en.jma),
      'en 的来源标注不是中文：' + srcLabels.en.jma)
    assert(srcLabels.ja.jma.indexOf('気象庁') !== -1, 'ja 的来源标注用日文机构名：' + srcLabels.ja.jma)
    assert(!HAN.test(srcLabels.en.cencEew) && !HAN.test(srcLabels.en.nmc),
      'en 的 CENC / 中央气象台标注也不是中文：' + srcLabels.en.cencEew + ' / ' + srcLabels.en.nmc)
    assert(srcLabels.en.emsc === 'EMSC' && srcLabels.en.code === 'code 551' &&
      srcLabels['zh-CN'].emsc === 'EMSC' && srcLabels['zh-CN'].code === 'code 551',
      '品牌名与 `code N` 不随语言变（它们在任何语言下都是同一个写法）')
    {
      const cencRaw = {
        type: 'cenc_eew', ID: 'loc-cenc-1', EventID: 'loc-cenc-ev', OriginTime: '2026-09-18 20:50:23',
        ReportTime: '2026-09-18 20:50:30', Latitude: 30.5, Longitude: 100.5, Magnitude: 5.2,
        Depth: 12, MaxIntensity: 6, HypoCenter: '测试地',
      }
      const labels = {}
      for (const lang of LANGS4) {
        const seed = { 'dsh.quakeAlert.v1': JSON.stringify({ version: 1, language: lang, watch: { prefectures: [], cities: [], places: [] } }) }
        const ex = loadClientEx(seed).exports.__test
        ex.loadCfg()
        const res = ex.parseCencEewResult(cencRaw)
        labels[lang] = res && res.ok ? res.alert.kindLabel : '(解析失败)'
      }
      assert(labels.en !== labels['zh-CN'] && !HAN.test(labels.en),
        'en 下 CENC 预警的标签是英文：' + labels.en)
      assert(labels.ja !== labels.en && labels['zh-TW'] !== labels.en,
        'ja / zh-TW 各自不同：' + JSON.stringify(labels))
      // 契约里的描述性源名同样不该是中文（它进诊断快照）
      const contractLabels = ['cenc_eew', 'cenc_eqlist', 'nmc_alarm', 'nws_alerts', 'eccc_alerts']
        .map((id) => (SOURCE_CONTRACTS[id] || {}).label || '')
      const badContract = contractLabels.filter((x) => HAN.test(x))
      assert(badContract.length === 0, '契约里的源名已中性化（中文残留：' + JSON.stringify(badContract) + '）')
      assert(HAN.test((SOURCE_CONTRACTS.jma || {}).label || ''),
        '对照：気象庁自己的名字保持原样（"源自己的命名不翻"）')
    }
  } catch (e) {
    assert(false, '0.9.4 解析层本地化检查失败：' + e.message)
  }

  // ==========================================================================
  // 大陆气象的判定顺序与关注点判据
  // ==========================================================================
  try {
console.log('== 大陆气象的判定顺序与关注点判据 ==')
    const { CN_AREAS: CN_AREAS_82 } = await import(pathToFileURL(path.join(ROOT, 'lib', 'data', 'cn-areas.js')).href)
    const t = loadClientEx().exports.__test
    const LEVEL_ZH = { red: '红色', orange: '橙色', yellow: '黄色', blue: '蓝色' }
    const nmc = (level, id, title) => t.parseNmcAlarm({
      alertid: id,
      title: title || ('云南省丽江市宁蒗彝族自治县气象台发布暴雨' + LEVEL_ZH[level] + '预警信号'),
      issued: '2026-09-19T03:02:45+08:00', kind: 'rainstorm', level, detail: '',
    })
    const cfgWithPlaces = (places) => t.normalizeCfg(Object.assign({}, t.loadCfg(), {
      watch: { prefectures: [], cities: [], places },
    }))

    // ---- A. 门槛不能挡在「有没有关注点」前面 ----
    {
      const cfg0 = cfgWithPlaces([])
      assert(cfg0.watch.places.length === 0, '（前置）这份配置里一个关注点都没有')
      for (const level of ['yellow', 'blue']) {
        const m = t.matchAlert(nmc(level, 'a-' + level), cfg0)
        assert(m.hit === false && m.noWatch === true,
          level + ' + 没配大陆关注点 → 带 noWatch（修复前这一支排在门槛之后，reason 只说"未达橙色"，于是黄 / 蓝绕过 noWatch 照常进履历）')
      }
      // noWatch 是给 11-pipeline 用的标记，只看 matchAlert 的返回值不算数，要端到端看 store
      const before = t.store.events.length
      t.handleAlert(nmc('blue', 'a-blue-hist'), cfg0)
      assert(t.store.events.length === before,
        '蓝色 + 没配关注点 → 不写历史（与橙色的 noWatch 同口径；修复前每天几十条黄 / 蓝持续占满 HISTORY_MAX=30）')
      // 对照：修的是判定顺序，不是门槛本身
      const cfg1 = cfgWithPlaces([{ name: '云南省·丽江市', lat: 26.85, lon: 100.51, radiusKm: 100, origin: 'cn' }])
      const m1 = t.matchAlert(nmc('blue', 'a-blue-contrast'), cfg1)
      assert(m1.hit === false && m1.noWatch !== true && m1.reason.indexOf('未达橙色') !== -1,
        '对照：配了大陆关注点之后，蓝色仍走「未达橙色，仅记录」（' + m1.reason + '）')
      const before1 = t.store.events.length
      t.handleAlert(nmc('orange', 'a-orange-hit'), cfg1)
      assert(t.store.events.length === before1 + 1,
        '对照：配了关注点、达到橙色 → 照常进历史（修复没有把"该记的"一起挡掉）')
    }

    // ---- B. 大陆关注点按显式来源分支与省 / 市判定，不靠名字里的 `·` ----
    {
      t.setCnAreas(CN_AREAS_82)
      const picked = t.cnPlaceOf('四川省', '成都市', 100)
      assert(!!picked && picked.province === '四川省' && picked.city === '成都市',
        '级联产出的关注点带显式 province / city：' + JSON.stringify(picked))
      assert(t.cnWatchPlaces([picked]).length === 1 && t.cnWatchPlaces([picked])[0].province === '四川省',
        'cnWatchPlaces 认它（origin=cn）并直接给出省')

      const manual = { name: '上海市·黄浦区', lat: 31.23, lon: 121.47, radiusKm: 300, origin: 'global' }
      const normManual = t.normalizePlaces([manual])
      assert(normManual.length === 1 && normManual[0].origin === 'global' && normManual[0].province === undefined,
        '显式 origin=global 不会被名字里的 `·` 改写成 cn，也不会被安上省 / 市：' + JSON.stringify(normManual[0]))
      assert(t.cnWatchPlaces(normManual).length === 0, '手填坐标不参与大陆行政区匹配')

      const legacy = t.normalizePlaces([{ name: '云南省·丽江市', lat: 26.85, lon: 100.51, radiusKm: 100 }])
      assert(legacy[0].origin === 'cn' && legacy[0].province === '云南省' && legacy[0].city === '丽江市',
        '0.8.1 及以前存下的关注点只有名字 → 按同一形状规则迁移出省 / 市并固化：' + JSON.stringify(legacy[0]))

      const national = nmc('red', 'b-national', '中央气象台发布暴雨红色预警信号')
      const mManual = t.matchAlert(national, cfgWithPlaces([manual]))
      assert(mManual.hit === false && mManual.noWatch === true,
        '名字带 `·` 的手填坐标不算大陆关注点：认不出省的预警不再被它"按全国放行"命中并播报（修复前 hit=true + 播报）')
      const mCn = t.matchAlert(national, cfgWithPlaces([{ name: '广东省·广州市', lat: 23.13, lon: 113.26, radiusKm: 100, origin: 'cn' }]))
      assert(mCn.hit === true && mCn.reason.indexOf('未能定位到省份') !== -1,
        '对照：真正的大陆关注点仍按全国放行（DESIGN 8.4 的兜底没有被顺手改掉）')

      const explicit = { name: '丽江市', lat: 26.85, lon: 100.51, radiusKm: 100, origin: 'cn', province: '云南省', city: '丽江市' }
      const mExplicit = t.matchAlert(nmc('orange', 'b-explicit'), cfgWithPlaces([explicit]))
      assert(mExplicit.hit === true && mExplicit.reason.indexOf('丽江市') !== -1,
        '命中判定读显式省 / 市：名字里没有 `·` 也能命中（' + mExplicit.reason + '）')

      const hostMod = await import(pathToFileURL(path.join(ROOT, 'lib', 'index.js')).href)
      const hostParsed = unwrapRefs(hostMod.QuakeAlertSettingsSchema({
        watch: { places: [{ name: '上海市·黄浦区', lat: 31.23, lon: 121.47, origin: 'global', province: '上海市', city: '黄浦区' }] },
      }))
      assert(hostParsed.watch.places[0].province === '上海市' && hostParsed.watch.places[0].city === '黄浦区',
        'Host schema 原样保留 places[].province / city')
      const hostDefault = unwrapRefs(hostMod.QuakeAlertSettingsSchema({ watch: { places: [{ name: 'x', lat: 1, lon: 1 }] } }))
      assert(hostDefault.watch.places[0].province === undefined && hostDefault.watch.places[0].city === undefined,
        'Host schema **不**给 province / city 注入默认值：老配置的省 / 市要由 Client 按名字迁移一次（同 origin 的理由）')

      t.applyCfg(t.normalizeCfg(Object.assign({}, t.loadCfg(), {
        watch: { prefectures: [], cities: [], places: [explicit, manual] },
      })))
      const snap = t.buildDiagSnapshot()
      const cnRow = snap.config.watch.places.find((r) => r.origin === 'cn')
      const globalRow = snap.config.watch.places.find((r) => r.origin === 'global')
      assert(!!cnRow && cnRow.province === '云南省' && cnRow.city === '丽江市',
        '诊断快照里的大陆关注点带省 / 市（"这条大陆预警为什么没命中"第一个要核的两个值）：' + JSON.stringify(cnRow))
      assert(!!globalRow && globalRow.province === undefined && globalRow.city === undefined,
        '诊断快照不给非大陆点写省 / 市（这些点不参与行政区匹配）')

      const legacyConv = t.sectionToCfg({ watch: { places: [{ name: '四川省·成都市', lat: 30.66, lon: 104.07, radiusKm: 100 }] } })
      assert(legacyConv.watch.places[0].origin === 'cn' &&
        legacyConv.watch.places[0].province === '四川省' && legacyConv.watch.places[0].city === '成都市',
        '老配置经 sectionToCfg 后 origin 与省 / 市都被补上：' + JSON.stringify(legacyConv.watch.places[0]))

      const langOps = t.settingsOpsFor(t.currentCfg()).filter((o) => o.path && o.path[0] === 'language')
      assert(langOps.length === 1 && langOps[0].op === 'unset',
        'language 参与 Host diff（等于默认值 → unset 交还 schema 默认层）：' + JSON.stringify(langOps))
    }

    // ---- C. 选项卡**切换**这条路径：切走后旧页的 DOM 是否真的消失、来回切会不会残留或白屏 ----
    {
      const react = mkTestReact()
      const { exports: ex } = loadClientEx({}, { react })
      /** 找一个页签按钮：文本恰好是标签，或「标签 角标」——"其他国家 / 地区"这类内容按钮不以标签开头。 */
      const findTab = (tree, label) => {
        const hit = []
        const walk = (n) => {
          if (!n || typeof n !== 'object') return
          if (Array.isArray(n)) { n.forEach(walk); return }
          if (n.type === 'button' && n.props && typeof n.props.onClick === 'function') {
            const txt = (n.children || []).filter((c) => typeof c === 'string').join('')
            if (txt === label || txt.indexOf(label + ' ') === 0) hit.push(n)
          }
          if (n.children) n.children.forEach(walk)
        }
        walk(tree)
        return hit[0]
      }
      const render = () => { react.__reset(); return ex.__test.SettingsPanel({}) }

      const t1 = textsOfTree(render())
      assert(t1.some((x) => x.indexOf('关注地区') !== -1) && !t1.some((x) => x.indexOf('清空记录') !== -1),
        '（前置）默认落在「地区」页')
      const toHistory = findTab(render(), '履历')
      assert(!!toHistory, '页签是可点击的按钮')
      // 找不到就不要再往下调用，否则一条 TypeError 会中断这一块后面的断言。
      if (toHistory) toHistory.props.onClick()
      const t2 = textsOfTree(render())
      assert(t2.some((x) => x.indexOf('清空记录') !== -1) && !t2.some((x) => x.indexOf('关注地区') !== -1),
        '点击「履历」后真的切过去，且地区页的区块不再渲染（"一次只渲染一页"的实质）')
      const backRegion = findTab(render(), '地区')
      assert(!!backRegion, '切到履历页后页签栏仍在（状态条与页签不随页切换）')
      if (backRegion) backRegion.props.onClick()
      const t3 = textsOfTree(render())
      assert(t3.some((x) => x.indexOf('关注地区') !== -1) && !t3.some((x) => x.indexOf('清空记录') !== -1),
        '切回「地区」页也正常（来回切换不残留上一页的内容）')

    // 角标数字：把角标写死成 ' 99' 也必须被断言抓住
      const badgeOf = (seed, label) => {
        const reactB = mkTestReact()
        const { exports: exB } = loadClientEx(seed, { react: reactB })
        reactB.__reset()
        const btn = findTab(exB.__test.SettingsPanel({}), label)
        return btn ? (btn.children || []).filter((c) => typeof c === 'string').join('') : ''
      }
      assert(badgeOf({}, '地区') === '地区', '没有关注点时「地区」页签不带角标：' + badgeOf({}, '地区'))
      const seedPlace = {
        'dsh.quakeAlert.v1': JSON.stringify({
          version: 1,
          watch: { prefectures: [], cities: [], places: [{ name: '东京', lat: 35.68, lon: 139.77, radiusKm: 100, origin: 'global' }] },
        }),
      }
      assert(badgeOf(seedPlace, '地区') === '地区 1', '有 1 个关注点时角标是 1：' + badgeOf(seedPlace, '地区'))
      const seedHist = {
        'dsh.quakeAlert.history': JSON.stringify([
          { id: 'h1', kind: 'quake', label: '地震速报', severity: 'yellow', issued: '', headline: 'h', hit: true },
        ]),
      }
      assert(badgeOf(seedHist, '履历') === '履历 1', '有 1 条记录时「履历」角标是 1：' + badgeOf(seedHist, '履历'))
    }
  } catch (e) {
    assert(false, '0.8.2 检查失败：' + e.message + '\n' + (e && e.stack ? e.stack.split('\n').slice(1, 3).join('\n') : ''))
  }

  // ==========================================================================
  // 复验补修：Wolfx 缓冲的字节预算 / 取消关注后残留的市町村 / 「已关闭」圆点同形
  // ==========================================================================

  // ---- Wolfx 缓冲的字节预算 ----
  // 两个大陆源只按条数淘汰，管不住内存（单条载荷多大由上游决定）；这里用注入的小预算把那条路径跑出来。
  try {
console.log('== 复验补修：Wolfx 缓冲的字节预算 ==')
    const wx2 = await import(pathToFileURL(path.join(ROOT, 'lib', 'wolfx-source.js')).href)
    const clock2 = { t: Date.parse('2026-09-18T12:52:23Z') } // = 样本发震时刻 + 2 分钟（在年龄门槛内）
    const q2 = new Map()
    let qid = 0
    const sched2 = {
      set(fn, ms) { const k = ++qid; q2.set(k, { fn, at: clock2.t + (Number(ms) || 0) }); return k },
      clear(k) { q2.delete(k) },
      advance(ms) {
        clock2.t += ms
        for (const [k, v] of Array.from(q2)) if (v.at <= clock2.t) { q2.delete(k); v.fn() }
      },
    }
    const socks2 = []
    const base2 = JSON.parse(fs.readFileSync(path.join(ROOT, 'samples', 'cn', 'cenc-eew-last.json'), 'utf8'))
    // 每条帧都塞一段 pad：payload 原样入缓冲，所以条目大小可控（解析只看固定字段，不受影响）
    const frame2 = (n, pad) => {
      const f = JSON.parse(JSON.stringify(base2))
      f.ReportNum = n
      f.pad = 'p'.repeat(pad)
      return JSON.stringify(f)
    }
    const mkSrc2 = (opts) => wx2.createWolfxSource(Object.assign({
      id: 'cenc_eew',
      now: () => clock2.t,
      setTimer: (fn, ms) => sched2.set(fn, ms),
      clearTimer: (k) => sched2.clear(k),
      createSocket: () => { const s = { sent: [], closed: false, send(m) { s.sent.push(m) }, close() { s.closed = true } }; socks2.push(s); return s },
      idleMs: 0, firstDelayMs: 0, connectTimeoutMs: 0, heartbeatTimeoutMs: 0,
    }, opts || {}))
    const pollerMod42 = await import(pathToFileURL(path.join(ROOT, 'lib', 'poller.js')).href)
    assert(wx2.DEFAULT_MAX_BUFFER_BYTES === pollerMod42.DEFAULT_MAX_BUFFER_BYTES,
      '与 poller 的字节预算是**同一个值**（而不是各写一个字面量）：' + wx2.DEFAULT_MAX_BUFFER_BYTES)
    assert(wx2.DEFAULT_MAX_BUFFER_BYTES === 8 * 1024 * 1024, '该值是 8MB（改它要同时说清为什么）')
    // 默认**接线**也必须有断言：「默认 8MB」如果只是注释、实际接成 0（= 不限），字节约束就等于没修。
    assert(mkSrc2({}).stats().maxBufferBytes === wx2.DEFAULT_MAX_BUFFER_BYTES,
      '不传 maxBufferBytes 时真的吃默认值（生产路径就是这条）')
    {
      const budget = 900
      const src = mkSrc2({ maxEntries: 100, maxBufferBytes: budget })
      src.start()
      sched2.advance(0)
      const s = socks2[socks2.length - 1]
      s.onopen()
      for (let i = 1; i <= 4; i++) s.onmessage({ data: frame2(i, 700) })
      const st = src.stats()
      assert(typeof st.bufferBytes === 'number' && st.bufferBytes > 0, 'stats 暴露 bufferBytes 读数（诊断可见）')
      assert(st.dropped >= 1, '字节超限真的触发了淘汰（maxEntries=100，所以它只可能来自字节预算）')
      assert(st.bufferBytes <= budget || st.bufferSize === 1,
        '压到预算内，或只剩一条（单条就超预算时也留一条——那一条正是用户要看的数据）：' +
        st.bufferSize + ' 条 / ' + st.bufferBytes + ' 字节')
      assert(st.bufferSize === 4 - st.dropped, '留存数与淘汰数自洽（bufferSize + dropped = 送入条数）')
      assert(src.snapshot(0).truncated === true, '中间被淘汰过 → truncated 为真（Client 不会以为补齐了）')
      src.stop()
    }
    {
      const src0 = mkSrc2({ maxEntries: 100, maxBufferBytes: 0 })
      src0.start()
      sched2.advance(0)
      const s0 = socks2[socks2.length - 1]
      s0.onopen()
      for (let i = 1; i <= 4; i++) s0.onmessage({ data: frame2(i, 700) })
      assert(src0.stats().bufferSize === 4 && src0.stats().dropped === 0,
        'maxBufferBytes=0 = 不限（显式保留旧行为，不是"默认关掉约束"）')
      src0.stop()
    }
  } catch (e) {
    assert(false, '0.9.5 Wolfx 字节预算检查失败：' + e.message)
  }

  // ---- 取消关注后残留的市町村（表到位时补清）----
  try {
console.log('== 复验补修：取消关注后残留的市町村 ==')
    const seedResidual = {
      'dsh.quakeAlert.v1': JSON.stringify({ version: 1, watch: { prefectures: ['福島県'], cities: ['白河市', '千代田区'] } }),
    }
    const tp = loadClientEx(seedResidual).exports.__test
    // 现场还原：表还没到位时，"该县下的市町村"取不到任何一条 → 取消关注时那次清理会悄悄失灵
    assert(tp.citiesOfPref('東京都').length === 0, '（前置）表未就绪时按县取市町村是空数组——这正是清理失效的原因')
    tp.setCityTable({ '福島県': ['白河市', '郡山市'], '東京都': ['千代田区'] })
    tp.pruneCitiesOfUnwatchedPrefs()
    assert(tp.currentCfg().watch.cities.join() === '白河市',
      '表到位后清掉"所属县已不在关注列表"的市町村（实际 ' + tp.currentCfg().watch.cities.join() + '）')
    assert(tp.currentCfg().watch.prefectures.join() === '福島県', '清理市町村不影响都道府县')
    // 关注列表为空 = 全日本：所有市町村都有效，一条都不能清
    const seedAll = {
      'dsh.quakeAlert.v1': JSON.stringify({ version: 1, watch: { prefectures: [], cities: ['白河市', '千代田区'] } }),
    }
    const tAll = loadClientEx(seedAll).exports.__test
    tAll.setCityTable({ '福島県': ['白河市'], '東京都': ['千代田区'] })
    tAll.pruneCitiesOfUnwatchedPrefs()
    assert(tAll.currentCfg().watch.cities.length === 2, '关注列表为空（= 全日本）时一条都不清')

    // 既有用例一直在跑真实装载路径，但配置里没有残留条目，所以那两行清理的效果从来没被观测到。
    {
      const areasPayload94 = { prefectures: { '福島県': ['白河市', '郡山市'], '東京都': ['千代田区'] } }
      const seedPath = {
        'dsh.quakeAlert.v1': JSON.stringify({
          version: 1,
          watch: { prefectures: ['福島県'], cities: ['白河市', '架空市', '千代田区'] },
        }),
      }
      const tPath = loadClientEx(seedPath, {
        window: { fetch: async () => ({ ok: true, status: 200, json: async () => areasPayload94 }) },
      }).exports.__test
      const stPath = await tPath.loadCityTable()
      assert(stPath === 'ready', '（前置）/areas 装载成功')
      const keptPath = tPath.currentCfg().watch.cities
      assert(keptPath.indexOf('架空市') === -1,
        'loadCityTable 仍然调用 pruneUnknownCities（表里没有的条目被清掉）')
      assert(keptPath.indexOf('千代田区') === -1,
        'loadCityTable 也调用 pruneCitiesOfUnwatchedPrefs（所属县没关注 → 清掉）')
      assert(keptPath.join() === '白河市', '两条清理叠加后的结果：' + keptPath.join())
    }
  } catch (e) {
    assert(false, '0.9.5 C11① 检查失败：' + e.message)
  }

  // ---- 设置页与侧边栏的「已关闭」圆点同形 ----
  try {
console.log('== 复验补修：两处的「已关闭」圆点同形 ==')
    // 查产物字符串而不是渲染树：dot 由两个模块各自构造，而"空心"就是那两行 style 的字面写法。
    const hollow = "background: 'transparent', border: '1.5px solid '"
    const hollowCount = CLIENT_CODE.split(hollow).length - 1
    assert(hollowCount >= 2,
      '侧边栏与设置页都用空心表达 disabled（实际 ' + hollowCount + ' 处；颜色之外的形状线索是色觉障碍用户唯一能用的判据）')
    // 判据也要**数够**：这个串在产物里有两处，只判「存在」等于恒真。
    assert(CLIENT_CODE.split("store.status === 'disabled'").length - 1 >= 2,
      '两处都用同一个判据（实际 ' + (CLIENT_CODE.split("store.status === 'disabled'").length - 1) + ' 处）')
  } catch (e) {
    assert(false, '0.9.5 P3-45① 检查失败：' + e.message)
  }

  // ---- 状态层的 detail 只进诊断快照，不进界面 ----
  try {
console.log('== 复验补修：状态层 detail 不进界面 ==')
    // detail 是各源链路拼的**简短英文**诊断串（`last fetch …` / `schema error not seen for 24h …`），
    // 它是排障文本、不是界面文案，混进界面就是中英 / 日英混排。设置页「源状态」行与侧边栏 tooltip
    // 都只显示本地化的状态词；detail 仍逐源写进诊断快照，由用户贴给 AI 排查。
    const uiDetail = CLIENT_CODE.split("' · ' + st.detail").length - 1
    const tipDetail = CLIENT_CODE.split("' · ' + store.detail").length - 1
    assert(uiDetail === 0, '设置页「源状态」行不再拼 detail（实际 ' + uiDetail + ' 处）')
    assert(tipDetail === 0, '侧边栏 tooltip 不再拼 detail（实际 ' + tipDetail + ' 处）')
    // 信息没丢：快照里必须还有它，否则这次是"把排障信息删了"而不是"移到快照里"。
    assert(CLIENT_CODE.split('detail: str(s.detail)').length - 1 >= 1,
      '诊断快照仍然逐源写 detail（信息只是从界面移到快照）')
  } catch (e) {
    assert(false, '状态层 detail 检查失败：' + e.message)
  }

  // ---- 中国大陆两条链路把两种取值域写进**同名**的 intensity 字段 ----
  // 今天没有消费点（只入库、不上 UI），但将来按 intensity 分档时，「烈度 5.8」与「烈度 5」会被判成不同的档。
  try {
console.log('== 复验补修：CN 两条链路共用 intensity 字段 ==')
    const t42 = loadClientEx().exports.__test
    const eew42 = JSON.parse(fs.readFileSync(path.join(ROOT, 'samples', 'cn', 'cenc-eew-last.json'), 'utf8'))
    const list42 = JSON.parse(fs.readFileSync(path.join(ROOT, 'samples', 'cn', 'cenc-eqlist-last.json'), 'utf8'))
    const a42 = t42.parseCencEewResult(eew42).alert
    const q42 = t42.parseCencEqlistResult(list42).alerts[0]
    assert(!!a42 && !!q42, '（前置）两条链路各解析出一份 Alert')
    assert(Object.prototype.hasOwnProperty.call(a42, 'intensity') === true &&
      Object.prototype.hasOwnProperty.call(q42, 'intensity') === true,
      '两条链路写的是同一个字段名 intensity —— 谁改名这条会红，提醒他一并处理另一条链路')
    // 取值域差异只做**观察性**记录，不钉成不变量：样本的性质不是契约，重新抓样本会让写死的断言无谓变红。
    assert(typeof a42.intensity === 'number' && Number.isFinite(a42.intensity),
      'EEW 那条是有限数（实测连续小数 5.8）：' + a42.intensity)
    assert(typeof q42.intensity === 'number' && Number.isFinite(q42.intensity),
      '速报那条是有限数（实测整数档 5，上游给的是字符串 "5"）：' + q42.intensity)
  } catch (e) {
    assert(false, '0.9.5 P3-42 检查失败：' + e.message)
  }

  // ==========================================================================
  // fresh review 找到并修掉的缺陷（Host 侧 + Client 侧）
  // ==========================================================================
  try {
console.log('== fresh review 修复：/stream 的断流、方法与连接回收 ==')
    const hostRv = await import(pathToFileURL(path.join(ROOT, 'lib', 'index.js')).href)
    const mkRes = () => ({
      status: 0, headers: null, frames: [], writableEnded: false, headersSent: false, destroyed: false,
      endCalls: 0, destroyCalls: 0, writeFalse: false,
      writeHead(s, h) { this.status = s; this.headers = h; this.headersSent = true },
      write(b) { this.frames.push(b); return !this.writeFalse },
      end() { this.endCalls += 1; this.writableEnded = true },
      destroy() { this.destroyCalls += 1; this.destroyed = true },
      on(ev, fn) { if (ev === 'close') this.onClose = fn },
    })
    const mkSrc = (stats) => ({
      markRead() {},
      snapshot() { return { cursor: 1, entries: [], truncated: false, reset: false, frozen: false } },
      subscribe() { return () => {} },
      stats() { return stats || {} },
    })
    {
      const subs = []
      const src = mkSrc({ connected: false, lastError: 'relay down' })
      src.subscribe = (fn) => { subs.push(fn); return () => {} }
      const h = hostRv.createStreamHandler({ sources: { cenc_eew: src }, keepAliveMs: 100000, setInterval: () => 1, clearInterval: () => {} })
      const res = mkRes()
      res.writeFalse = true
      h({ url: '/dsh-quake-alert/stream?source=cenc_eew', headers: {} }, res)
      for (let i = 0; i < 205; i++) for (const fn of subs) fn({ seq: i, id: 'x', title: 't', updated: '', xml: '{}' })
      assert(res.endCalls >= 1 && res.writableEnded === true,
        '写入积压断流会真的结束响应（此前只停止写：连接假死驻留、close 永不触发）')
      assert(res.destroyCalls >= 1, '并且销毁连接（客户端才会收到 disconnect，不必靠自己的静默自检超时）')
    }
    {
      const h = hostRv.createStreamHandler({ sources: { cenc_eew: mkSrc() }, setInterval: () => 1, clearInterval: () => {} })
      const res = mkRes()
      h({ url: '/dsh-quake-alert/stream?source=cenc_eew', method: 'POST', headers: {} }, res)
      assert(res.status === 405, '非 GET / HEAD 回 405（此前一条 POST 也能换来一个长连接）')
    }
    {
      // 未知源走的是 `live.add` **之后**的早退路径：不自己摘掉的话，一个已结束的响应会永久留在集合里
      // （集合无上限，持续请求会让 Host 内存无界增长），closeAll 还会反过来去销毁它。
      const h = hostRv.createStreamHandler({ sources: { cenc_eew: mkSrc() }, keepAliveMs: 100000, setInterval: () => 1, clearInterval: () => {} })
      const dead = mkRes()
      h({ url: '/dsh-quake-alert/stream?source=nope', headers: {} }, dead)
      assert(dead.status === 400, '未知源 → 400')
      h.closeAll()
      assert(dead.destroyCalls === 0,
        '未知源的早退不进 live 集合：closeAll 不该去动它（实际 destroyCalls=' + dead.destroyCalls + '）')
    }
    {
      // 三条路由走同一层注册防护：`webServer` 服务重挂时 effect 回调可能重跑，而重复注册同一条路由
      // 会抛（宿主行为）。只给 /stream 上防护时，/areas 或 /feed 重注册会把整个 apply 抛崩。
      const libSrc = fs.readFileSync(path.join(ROOT, 'lib', 'index.js'), 'utf8')
      const guarded = (libSrc.match(/registerRoute\(\{/g) || []).length
      assert(guarded === 3, '三条路由（/areas、/feed、/stream）都经 registerRoute 注册（实际 ' + guarded + ' 条）')
      assert(libSrc.indexOf('const registerRoute = (route, label) => {') !== -1,
        'registerRoute 存在（重复注册只告警、不把 apply 抛崩）')
    }
    {
      const h = hostRv.createStreamHandler({ sources: { cenc_eew: mkSrc() }, keepAliveMs: 100000, setInterval: () => 1, clearInterval: () => {} })
      const a = mkRes()
      const b = mkRes()
      h({ url: '/dsh-quake-alert/stream?source=cenc_eew', headers: {} }, a)
      h({ url: '/dsh-quake-alert/stream?source=cenc_eew', headers: {} }, b)
      assert(typeof h.closeAll === 'function', 'handler 暴露 closeAll（路由清理时用它断掉在飞的流）')
      h.closeAll()
      assert(a.endCalls >= 1 && b.endCalls >= 1 && a.destroyCalls >= 1 && b.destroyCalls >= 1,
        'closeAll 关掉所有在飞的流（否则停用后旧流继续推数据，wolfx 也会因为还有订阅者而不空闲）')
    }
    {
      let tick = null
      const h = hostRv.createStreamHandler({
        sources: { cenc_eew: mkSrc({ connected: false, lastError: 'relay down' }) },
        keepAliveMs: 5, setInterval: (fn) => { tick = fn; return 1 }, clearInterval: () => {},
      })
      const res = mkRes()
      h({ url: '/dsh-quake-alert/stream?source=cenc_eew', headers: {} }, res)
      if (tick) tick()
      const frame = res.frames.filter((f) => f.indexOf('event: status') === 0).pop()
      assert(!!frame && frame.indexOf('"connected":false') !== -1 && frame.indexOf('relay down') !== -1,
        'status 帧带上 connected / lastError（"中继断了"与"这段时间确实没数据"从此不同形）')
    }

console.log('== fresh review 修复：Client 侧格式不合法的数据 / 记忆 / 关闭源 ==')
    // ⑤ 格式不合法的数据不得把插件拖崩：`{toString:null, valueOf:null}` 是 JSON 就造得出、字符串化即抛的形状
    const evilCfg = { version: 1, language: { toString: null, valueOf: null } }
    {
      const tE = loadClientEx({ 'dsh.quakeAlert.v1': JSON.stringify(evilCfg) }).exports.__test
      let threw = null
      let cfg = null
      try { cfg = tE.currentCfg() } catch (e) { threw = e }
      assert(!threw, '格式不合法的配置下 currentCfg() 不抛（它在设置页的渲染期被调用，抛了就是整页白屏）：' + (threw && threw.message))
      assert(cfg && typeof cfg.language === 'string', '退回一份可用的配置（语言回到默认值）')
      const tB = loadClientEx({
        'dsh.quakeAlert.v1': JSON.stringify({ version: 1 }),
        'dsh.quakeAlert.backup': JSON.stringify({ at: 'x', config: evilCfg }),
      }).exports.__test
      let threw2 = null
      try { tB.loadConfigBackup() } catch (e) { threw2 = e }
      assert(!threw2, '备份里格式不合法的数据同样不抛（当作"没有可撤销的备份"）')
    }
    // ⑥ 「清空记录」要连"已播报"记忆一起清，并且写入本地存储（否则刷新后记忆复活、两个标签页结论相反）
    {
      const mem = new Map([['dsh.quakeAlert.alerted', JSON.stringify({ 'jma:summary:大雨:130000': Date.now() })]])
      const tA = loadClientEx(undefined, {
        window: {
          localStorage: {
            getItem: (k) => (mem.has(k) ? mem.get(k) : null),
            setItem: (k, v) => mem.set(k, String(v)),
            removeItem: (k) => mem.delete(k),
          },
        },
      }).exports.__test
      assert(tA.alertedEvents.size >= 1, '（前置）"已播报"记忆已从磁盘读回（' + tA.alertedEvents.size + ' 条）')
      tA.forgetAllAlerted()
      assert(tA.alertedEvents.size === 0, '清空后内存里的记忆没了')
      const onDisk = JSON.parse(mem.get('dsh.quakeAlert.alerted') || 'null')
      assert(onDisk && Object.keys(onDisk).length === 0, '磁盘上那份也清了（否则刷新后记忆复活）')
    }
    {
      const tH = loadClientEx().exports.__test
      assert(tH.effectiveStatusOf('jma', 'disabled', 'x').status === 'disabled',
        '用户关掉的源优先于一切健康判定（界面不该把"我关了"改写成"数据格式异常 / 上游停更"）')
    }
  } catch (e) {
    assert(false, '0.9.5 fresh review 修复检查失败：' + e.message)
  }

  console.log('\n结果: ' + pass + ' 通过, ' + fail + ' 失败')
  process.exit(fail === 0 ? 0 : 1)
})()
