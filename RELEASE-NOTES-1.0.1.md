# 灾害预警 QuakeAlert 1.0.1

修复：开着 DSH 锁屏 / 休眠过夜后再回到电脑前，灾害预警一直显示黄灯「链路降级」、不会自动恢复绿色。

- Host 侧的 `stats.lastError` 只写不清：长休眠唤醒后心跳必然超时一次，那条错误文案会一直留着——中继早已重连正常，界面却永久停在「链路降级」，只有重启 DSH 才会清。现在恢复（重连成功 / 一整帧正常解析）即清零，错误同时带上时间戳。
- 「个别条目字段缺失」这类结构观测不再算作故障，不再造成降级。
- 新增「冻结 / 恢复」机制层：休眠唤醒后主动换一条连接（而不是把冻结误判成连接死亡）；自动降级也会复探一次 SSE、通了就升回推送——此前自动降级是单向的，只能手动改一次链路设置才回得去。
- P2PQuake 的 WebSocket 在唤醒时不再把已经断掉的连接当作「刚刚活跃」（此前会假绿最长 20 分钟）。
- 唤醒后立刻补一轮取数与自检，界面不必再等一个完整周期才回到绿色。

回归断言 2190 → 2213。

---

# QuakeAlert 1.0.1

Fixed: after locking the screen or suspending the machine overnight with DSH running, the disaster-alert status stayed on the yellow "degraded link" indicator and never returned to green.

- The Host-side `stats.lastError` was write-only: a long sleep always causes one heartbeat timeout, and that error text stayed forever — the relay had already reconnected while the UI stayed permanently "degraded" until DSH was restarted. It is now cleared on recovery (a successful reconnect or a fully parsed frame) and carries a timestamp.
- Structural observations such as "a few items were missing fields" are no longer treated as failures and no longer degrade the link.
- New freeze/resume layer: after a wake-up the client actively replaces the connection instead of mistaking the freeze for a dead link, and an automatic SSE fallback now re-probes and returns to push — previously that fallback was one-way, and only a manual change of the link setting could undo it.
- The P2PQuake WebSocket no longer treats an already-dead connection as "just active" on wake-up (it used to show green for up to 20 minutes).
- Polling and the health check now run one round immediately after a wake-up, so the UI no longer waits a full cycle to turn green.

Regression assertions: 2190 → 2213.
