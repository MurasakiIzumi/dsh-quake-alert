#!/usr/bin/env node
// dsh-quake-alert · 大陆源连通性诊断（开发 / 排障用，不入发行包）
//
// 用途：用**真实的 lib/wolfx-source.js** 连真实的 Wolfx，回答三个问题——
//   ① 这台机器的网络能不能连上 `wss://ws-api.wolfx.jp`？
//   ② 连上之后 `query_<id>` 指令能不能取回数据？（指令名错、被中间层拦截、上游停更都表现成"连上了但没数据"）
//   ③ 拿到的数据有多旧？（速报每天都有数据，最新事件太旧 = 中继停更，不是"最近没有地震"）
//
// 这是 `TROUBLESHOOTING.zh.md` 里"AI 能直接跑的检查"之一：不需要人看界面，只读退出码与输出。
// 与运行时链路的区别：这里**关掉年龄闸门**——排障要问的是"中继有没有在给数据"，
// 而运行时要问的是"这条数据还值不值得播报"。两者判据不同，不能共用一次运行。
//
// 用法：
//   node scripts/check-wolfx-live.mjs             # 两条链路都查
//   node scripts/check-wolfx-live.mjs --source=cenc_eew
//   node scripts/check-wolfx-live.mjs --wait=12   # 等待秒数（默认 8）
//
// 退出码：0 = 两条（或指定的一条）都拿到了数据；1 = 有链路没拿到（输出里有分类）。
// 退出码为上界：它只能说"这台机器此刻能不能用"，不能替代运行时链路自身的健康状态。

import { createWolfxSource, CENC_EEW_ID, CENC_EQLIST_ID, WOLFX_WS_BASE, WOLFX_REST_BASE } from '../lib/wolfx-source.js'

const argv = process.argv.slice(2)
const waitArg = argv.find((a) => a.startsWith('--wait='))
const waitMs = (waitArg ? Number(waitArg.split('=')[1]) : 8) * 1000
const onlyArg = argv.find((a) => a.startsWith('--source='))
const wanted = onlyArg ? [onlyArg.split('=')[1]] : [CENC_EEW_ID, CENC_EQLIST_ID]

const errors = []
const sources = wanted.map((id) => {
  const src = createWolfxSource({
    id,
    idleMs: 0,
    firstDelayMs: 0,
    maxEventAgeMs: 0, // 排障：只看"中继有没有给数据"
    onError: (e) => errors.push(id + '：' + String((e && e.message) || e)),
  })
  src.markRead()
  return src
})

console.log('Wolfx 端点：' + WOLFX_WS_BASE + '<id>   （REST 降级通道：' + WOLFX_REST_BASE + '<id>.json）')
console.log('等待 ' + (waitMs / 1000) + ' 秒…\n')
for (const s of sources) s.start()

setTimeout(() => {
  let failed = 0
  for (const src of sources) {
    const st = src.stats()
    const snap = src.snapshot(0)
    const newest = st.dataTime ? new Date(st.dataTime).toISOString() : ''
    console.log('=== ' + src.id + ' ===')
    console.log('  WebSocket 建连：' + (st.connected ? '成功（第 ' + st.connects + ' 次）' : '**未建立**'))
    console.log('  收到帧：' + st.frames + ' 条数据帧 / ' + st.messages + ' 条消息（含心跳）')
    console.log('  错误：' + st.errors + (st.lastError ? '（最后一条：' + st.lastError + '）' : ''))
    console.log('  最新事件时刻：' + (newest || '（没拿到任何事件）'))
    console.log('  环缓冲：' + snap.entries.length + ' 条')
    const first = snap.entries[0]
    if (first) console.log('  样例：' + first.id + ' | ' + first.title)
    if (!st.connected) {
      failed += 1
      console.log('  → 归类：unreachable。这台机器连不上 ws-api.wolfx.jp。')
      console.log('    可先用 REST 通道对照：curl -s ' + WOLFX_REST_BASE + src.id + '.json')
      console.log('    两条都不通就是网络层（DNS / 中间设备 / 出网策略），AI 修不了，' +
        '如实告诉用户"该源在当前网络不可达"，并说明日本与全球源走别的域名、不受影响。')
    } else if (st.frames === 0) {
      failed += 1
      console.log('  → 归类：connected-but-silent。连上了但一个数据帧都没有。')
      console.log('    最常见的原因是 query 指令形态变了（实测必须是纯文本 query_cenceew / query_cenceqlist，' +
        '发 JSON 不会有任何响应），也可能是中间设备只放行握手。')
    } else if (!st.dataTime) {
      failed += 1
      console.log('  → 归类：schema-error。拿到帧但解析不出任何事件（源改版？）。这是插件要修的问题，不是网络问题。')
    } else if (st.stale) {
      console.log('  → 归类：stale。中继可达、协议正常，但最新事件已超过 ' +
        Math.round((Date.now() - st.dataTime) / 3600000) + ' 小时前——是**中继停更**，不是"最近没有地震"。')
      failed += 1
    } else {
      // 注意这里的"正常"判据是**中继是否还在转发**（48 小时），不是"数据够不够新到值得播报"。
      // 速报一天几十条，所以超过 48 小时没有新事件才是异常；几小时前的数据是正常的安静期。
      const ageH = Math.round((Date.now() - st.dataTime) / 3600000)
      console.log('  → 正常：中继在转发（最新事件 ' + ageH + ' 小时前，未超 48 小时阈值）。')
      console.log('    注意这条判据探的是**中继**，不是"值不值得播报"——运行时还会按事件年龄闸门' +
        '（预警 10 分钟 / 速报 6 小时）决定要不要打扰用户。')
    }
    console.log('')
  }
  if (errors.length) console.log('底层错误：\n  ' + errors.join('\n  '))
  for (const s of sources) s.stop()
  console.log(failed === 0 ? '结论：全部通过。' : '结论：' + failed + ' 条链路有问题（见上面的归类）。')
  process.exit(failed === 0 ? 0 : 1)
}, waitMs)
