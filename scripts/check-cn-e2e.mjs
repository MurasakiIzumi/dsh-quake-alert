#!/usr/bin/env node
// dsh-quake-alert · 大陆源 Host↔Client 端到端复验（开发 / 排障用，不入发行包）
//
// 为什么需要它：仓库内的回归用例把两半**各自**用假件覆盖（Host 用假 socket、Client 用假
// EventSource），而它们之间那段**真实协议**没人守——帧格式、事件名、`id:` 字段、
// Last-Event-ID 补发、`sec-fetch-site` 防护。任何一侧改动都可能让另一边静默收不到数据。
// 这个脚本把两半接起来跑一次真的：
//
//   真实 Wolfx WS → lib/wolfx-source → lib/index.js 的 createStreamHandler → 真实 HTTP SSE
//   → 从零手写的 SSE 读流器（第三方视角，不用我们自己的客户端代码）
//   → client/client.js 的解析契约 → Alert
//
// 需要能连上 api.wolfx.jp（本机出口在日本时可用；大陆网络下的可达性见 TROUBLESHOOTING.zh.md）。
// **不进 CI**：它依赖外部服务，适合在改动传输层前后手动跑一次。
//
// 用法：node scripts/check-cn-e2e.mjs
// 退出码：0 = 全部通过；1 = 有断言失败（输出里逐条列出）。

import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'
import { createWolfxSource, CENC_EEW_ID, CENC_EQLIST_ID } from '../lib/wolfx-source.js'
import { createStreamHandler } from '../lib/index.js'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

// ---- 在沙箱里加载真实 client bundle，取它的解析契约 ----
const CLIENT_CODE = fs.readFileSync(path.join(ROOT, 'client', 'client.js'), 'utf8')
function loadClientTest() {
  const mem = new Map()
  const windowStub = {
    localStorage: {
      getItem: (k) => (mem.has(k) ? mem.get(k) : null),
      setItem: (k, v) => mem.set(k, String(v)),
      removeItem: (k) => mem.delete(k),
    },
    AudioContext: undefined, WebSocket: undefined, Notification: undefined, document: undefined,
    addEventListener() {}, removeEventListener() {},
  }
  const sandbox = { window: windowStub, console, setTimeout, clearTimeout }
  windowStub.window = windowStub
  windowStub.__ModuleLoader__ = { load: ({ factory }) => { sandbox.__exports = factory(() => ({})) } }
  vm.createContext(sandbox)
  vm.runInContext(CLIENT_CODE, sandbox, { filename: 'client.js' })
  return sandbox.__exports.__test
}

// ---- 手写的最小 SSE 读流器（第三方视角，不用我们自己的客户端代码） ----
async function readSse(url, lastEventId) {
  const headers = { accept: 'text/event-stream' }
  if (lastEventId) headers['last-event-id'] = String(lastEventId)
  const res = await fetch(url, { headers })
  const status = res.status
  const ctype = res.headers.get('content-type') || ''
  if (!res.body) return { status, ctype, frames: [] }
  const reader = res.body.getReader()
  const dec = new TextDecoder()
  let buf = ''
  const frames = []
  const deadline = Date.now() + 6000
  while (Date.now() < deadline && frames.length < 8) {
    const chunk = await Promise.race([
      reader.read(),
      new Promise((r) => setTimeout(() => r({ done: true, value: undefined }), 1500)),
    ])
    if (chunk.done) { if (chunk.value === undefined) continue; break }
    buf += dec.decode(chunk.value, { stream: true })
    let idx
    while ((idx = buf.indexOf('\n\n')) !== -1) {
      const raw = buf.slice(0, idx)
      buf = buf.slice(idx + 2)
      if (raw.startsWith(':')) { frames.push({ comment: raw }); continue }
      const f = { event: '', data: '', id: '' }
      for (const line of raw.split('\n')) {
        if (line.startsWith('event:')) f.event = line.slice(6).trim()
        else if (line.startsWith('data:')) f.data += line.slice(5).trim()
        else if (line.startsWith('id:')) f.id = line.slice(3).trim()
      }
      frames.push(f)
    }
  }
  try { reader.cancel() } catch {}
  return { status, ctype, frames }
}

const sources = {
  [CENC_EEW_ID]: createWolfxSource({ id: CENC_EEW_ID, idleMs: 0, maxEventAgeMs: 0 }),
  [CENC_EQLIST_ID]: createWolfxSource({ id: CENC_EQLIST_ID, idleMs: 0, maxEventAgeMs: 0 }),
}
const handler = createStreamHandler({ sources, keepAliveMs: 60000 })
const server = http.createServer((req, res) => {
  if (req.url.startsWith('/dsh-quake-alert/stream')) return handler(req, res)
  res.writeHead(404); res.end('no')
})
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const base = 'http://127.0.0.1:' + server.address().port
for (const s of Object.values(sources)) { s.markRead(); s.start() }
await new Promise((r) => setTimeout(r, 4000)) // 等 Wolfx 的首包

const T = loadClientTest()
const checks = []
const ok = (name, cond, extra) => checks.push([name, !!cond, extra || ''])

// ① 真 SSE：首帧 sync + 真实载荷的 entry（带 since=0 才能拿到已入缓冲的那条——
//    不带游标时是 tail 语义：只对齐位置、不重放，那正是设计要的行为）
const r1 = await readSse(base + '/dsh-quake-alert/stream?source=cenc_eew&since=0')
ok('HTTP 200 + text/event-stream', r1.status === 200 && r1.ctype.indexOf('text/event-stream') === 0, r1.status + ' ' + r1.ctype)
const sync = r1.frames.find((f) => f.event === 'sync')
ok('首帧是 event: sync', !!sync, JSON.stringify(sync && sync.data).slice(0, 120))
const sdata = sync ? JSON.parse(sync.data) : {}
ok('sync 带 cursor / frozen / replayed', Number.isFinite(sdata.cursor) && 'frozen' in sdata && 'replayed' in sdata, JSON.stringify(sdata))
const entry = r1.frames.find((f) => f.event === 'entry')
ok('收到 event: entry（真实 Wolfx 载荷）', !!entry, entry ? entry.data.slice(0, 80) : '(none)')
ok('entry 帧带 id:（浏览器重连时原样带回）', !!entry && /^\d+$/.test(entry.id), entry && entry.id)

// ② 真实载荷能吃下 Client 的解析契约
let eewAlert = null
if (entry) {
  const payload = JSON.parse(entry.data)
  ok('entry 形状与 /feed 一致（seq/id/xml）', Number.isFinite(payload.seq) && !!payload.id && typeof payload.xml === 'string')
  const res = T.parseCencEewResult(JSON.parse(payload.xml))
  ok('真实载荷 → cenc_eew 契约 ok', res.ok === true, res.ok ? '' : res.kind + ':' + res.detail)
  eewAlert = res.ok ? res.alert : null
  if (eewAlert) {
    ok('归一出的 Alert 走坐标匹配', eewAlert.locator === 'point' && eewAlert.kind === 'eew')
    ok('烈度只入库不进文案', typeof eewAlert.intensity === 'number' && eewAlert.headline.indexOf('烈度') === -1)
    ok('事件键归一到 UTC 分钟', /^geo:\d{4}-\d{2}-\d{2}T\d{2}:\d{2}@/.test(eewAlert.eventKey), eewAlert.eventKey)
  }
}

// ③ 速报整表：50 条逐条 entry，逐条契约都要通过
const r2 = await readSse(base + '/dsh-quake-alert/stream?source=cenc_eqlist&since=0')
const repEntries = r2.frames.filter((f) => f.event === 'entry')
ok('速报整表展开成多条 entry（不是一条整表）', repEntries.length >= 20, '收到 ' + repEntries.length + ' 条')
let repOk = 0
for (const f of repEntries) {
  const payload = JSON.parse(f.data)
  const res = T.parseCencEqlistItemResult(JSON.parse(payload.xml))
  if (res.ok) repOk += 1
}
ok('每一条速报都过客户端契约', repOk === repEntries.length, repOk + '/' + repEntries.length)

// ④ Last-Event-ID 断线补齐
const firstSeq = Number(entry ? entry.id : 0)
if (firstSeq > 1) {
  const r3 = await readSse(base + '/dsh-quake-alert/stream?source=cenc_eew', firstSeq - 1)
  const replayed = r3.frames.filter((f) => f.event === 'entry')
  ok('带 Last-Event-ID 重连 → 补发断线期间的条目', replayed.length >= 1 && Number(replayed[0].id) >= firstSeq,
    '补发 ' + replayed.length + ' 条，首条 id=' + (replayed[0] && replayed[0].id))
}

// ⑤ 参数校验与跨站防护
const bad = await fetch(base + '/dsh-quake-alert/stream?source=constructor')
ok('未知源 → 400', bad.status === 400, String(bad.status))
// 跨站那条用 node:http 直接发：undici 的 fetch 会丢掉 sec- 前缀的头，测不出防护本身
const csStatus = await new Promise((resolve) => {
  const req = http.request(base + '/dsh-quake-alert/stream?source=cenc_eew', {
    headers: { 'sec-fetch-site': 'cross-site', accept: 'text/event-stream' },
  }, (res) => { res.resume(); resolve(res.statusCode) })
  req.on('error', () => resolve(-1))
  req.end()
})
ok('跨站请求 → 403（这条路由会保持外部连接）', csStatus === 403, String(csStatus))

for (const s of Object.values(sources)) s.stop()
server.close()
let bad2 = 0
for (const [name, pass, extra] of checks) {
  if (!pass) bad2 += 1
  console.log((pass ? '  OK   ' : '  FAIL ') + name + (extra && !pass ? '   [' + extra + ']' : ''))
}
console.log('RESULT ' + (checks.length - bad2) + '/' + checks.length + ' 通过')
process.exit(bad2 === 0 ? 0 : 1)
