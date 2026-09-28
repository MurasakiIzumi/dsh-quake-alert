# Changelog

本文件记录 dsh-quake-alert 的显著变更，格式参照 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)。

## [0.10.0] - 2026-09-28

### Changed

- 全代码注释精简：注释统一为「只解释代码的含义与作用」，删除注释里的版本号与清单编号、私有设计文档引用、历史沿革与设计论证。
- 三语 README 重写为使用说明；工作原理、覆盖范围与数据来源、已知限制、开发与构建移入新增的 `GUIDE.md` / `GUIDE.zh.md`。
- CHANGELOG 重写为纯变更记录：删除各版本开头的背景自述与「有意不做 / 待定 / 复验」小节，只保留 Added / Changed / Fixed / Removed。
- `package.json` 的 `files` 增加 `GUIDE.md` 与 `GUIDE.zh.md`。

## [0.9.5] - 2026-09-27

### Changed

- `lib/wolfx-source.js` 的固定长度缓冲改用条数 + 字节双约束（`DEFAULT_MAX_BUFFER_BYTES` 取与 poller 同值的 8MB），淘汰从最旧开始、共用 `dropped` 计数，`stats()` 新增 `bufferBytes` / `maxBufferBytes` 读数。
- `14-ui-status.js` 与设置页对 disabled 状态统一画成空心圆点（10px / 8px 的尺寸差异保留）。
- 三语 README 的正文、警戒レベル表与表下说明改按「未达档位既不播报、也不进历史」改写，`TROUBLESHOOTING.zh.md` 两行表格同步。
- `06-matcher`、`05b`、`05f`、`05h`、`lib/nmc-source` 等处对齐「未达档位不进历史」的注释口径。
- Alert 的 `intensity` 字段同时承载 EEW 的连续小数（实测 5.8）与速报的整数档（实测 3…8），在文件头与两处赋值点写明，回归钉住两条链路写同一字段名。
- `parseEpspResult` 的文档注释订正：该包装函数在 `15-entry` 的 `onRaw` 里，P2PQuake 每一帧都经它，schema / value 失败经 `noteParseResult` 升级成界面蓝点。
- 订正三条过期注释：`world-cities.js` 文件头（城市名已改为统一拉丁，不再是中文候选优先）、`poller.js` 与 `global-sources.js` 的上限（512KB，非 2MB）、`prune-dead-i18n.mjs` 的 DEAD 清单说明（`scale.*` / `tsunami.*` 已在 00g 复活，脚本只扫 00a / 00e）。
- `scripts/build-world-cities.mjs` 的 `render()` 模板改成与实现一致的拉丁城市名规则，重名示例改为产物的全角括号写法（实测 84 条带一级行政区的名字用全角）。
- `scripts/lib/geonames.mjs` 的城市名函数注释改为「已按本函数重生成过」，去掉「已提交的 `lib/data/world-cities.js` 仍是旧名字」的过期描述。
- 三语 README 的断言数字由 2097 改为 2118。
- `CHANGELOG` 里「CI 的 action 不钉死 SHA」的理由改指 `.github/dependabot.yml` 头部（`contracts.yml` 无相关字样）；三语 README 表格下说明补齐「判不了」的三个例子。

### Fixed

- 新增 `pruneCitiesOfUnwatchedPrefs()`，在 `loadCityTable()` 的表就绪时（含重试之后）清理已取消关注县下的市町村残留配置。
- 恢复 `loadCityTable()` 里被同类补修挤掉的 `pruneUnknownCities()` 调用。
- SSE 写入积压时只「停止写」不关连接：cleanup 与 `closeAll` 现在都会结束并销毁连接。
- `webServer.register()` 的 handler 维护 `live` 连接集合，路由清理时先 `closeAll()`，停用 / 重载不再遗留推数据的旧连接。
- status 帧新增 `connected` / `lastError`，`12c` 据此把中继断线与「这段时间没数据」区分并把原因写进 detail 行。
- `isEventFreshEnough` 的时间不可解析路径新增 `unparseableTime` 计数并进 status 帧（放行语义不变）。
- `loadCfg` / `sectionToCfg` / `loadConfigBackup` 三处捕获 `normalizeCfg` 取词时的 TypeError 并退回默认值，不再整页白屏。
- `updateWeatherHint` 改为在命中判定之后、任何抑制分支之前调用，静默时段里的 L4 也会清掉侧边栏「L3 未播报」提示。
- 新增 `forgetAllAlerted()`（内存 + 写入本地存储），「清空记录」在发起页与接收页都走它，三个「已播报」副本不再不一致。
- `effectiveStatusOf` 让 `disabled` 优先于一切健康判定，被用户关掉的源不再被判成 schema-error。
- `12b` 在缺 `AbortSignal.timeout` 的引擎上补自建信号分支，超时保护不再整条消失。
- `feedStatsOf` 随插件重建清理，与 `overseasStatsOf` 一致。
- `sourceEnabled` 的源 id 由 `nws` / `eccc` 订正为 `nws_alerts` / `eccc_alerts`。
- `/stream` 增加 `req.method` 校验（非 GET 不再能换来长连接）。
- `SETTINGS_TABS.some((t) => …)` 与两处 `setTick((t) => …)` 的箭头参数改名，不再遮蔽 i18n 的 `t`。
- `staleAfterMs: 0` 旁的「预警告稀疏 → 不给新鲜度阈值」措辞订正。
- Wolfx 默认接线加断言：不传选项时 `stats().maxBufferBytes` 吃默认值，且该默认值与 poller 同值。
- 圆点断言由「串存在」改为计数 ≥2。
- 新增断言把「表里不存在」与「所属县未关注」两种残留条目喂进真实装载路径，断言装载完成后都被清掉。
- EEW 样本断言由「一定不是整数」改为「是有限数」，保留「两条链路写同一字段名」的断言。

## [0.9.4] - 2026-09-27

### Added

- `lib/wolfx-source.js` 新增 REST 兜底轮询 `pollRest`（`https://api.wolfx.jp/<id>.json`，与 WS 同构走 `handleDataFrame`，仅 WS 未连接时跑，`stop()` 中止在飞请求），统计量 `restPolls` / `restFetched` / `restLastError` / `restUrl` 暴露给 `/feed?stats=1` 与排障脚本。
- `scripts/check-wolfx-live.mjs` 真的请求一次 REST 端点，区分「wss:// 不通但 api.wolfx.jp 通」与「两条都不通 = 网络层」。
- `scripts/check-time-travel.cjs` 机械检查（宿主时钟整体前移后跑完整回归，CI 里跑 +180 天）。
- 新增 `scripts/fix-cities-kana.mjs`（幂等）固化 22 处市町村名修正清单。
- 新增 `scripts/prune-dead-i18n.mjs`（幂等）固化死 i18n 键清理清单。
- 新增 `scripts/localize-country-names.mjs`（幂等）迁移国家 / 地区名为四语形态。
- 新增 `.gitattributes`，只钉 `client/client.js text eol=lf` 一处。
- 新增客户端文案面 `00g-texts-events.js`（88 键 ×4 语）与 `00h-texts-reasons.js`（69 键 ×4 语）。
- 新增 `retryCityTable()` 与设置页的「重试」按钮。
- 新增 `optionsOfTree` / `selectsOfTree` 测试工具，能读元素属性。
- 新增 `nmcPageInfoOf` 与 stats 字段 `listCount` / `count` / `totalPage` / `listTruncated`，`/feed?stats=1` 与诊断里可见 nmc 列表被截断。
- 新增 `cnAreasStateOf`，大陆行政区划表有自己的加载状态（失败如实显示并可重试）。
- 新增 `itemSkipped` 计数与 `lastError` 说明，`cenc_eqlist` 逐条解析失败不再不可见。
- 新增 `md5StaleFrames` 计数器，速报「上游改表不刷指纹」可见。
- 新增 `cannotJudge` 标记，区分「判不了」与「离得远」。
- CI 加固：`push: branches: [main]` 触发、`permissions: contents: read`、`timeout-minutes`、`concurrency`，并新增 `.github/dependabot.yml` 跟踪 action 与 npm 依赖。
- 新增 `regression` job（原 `bundle-sync`），「核心回归套件 + 时钟前移检查」从零依赖的 `contracts` job 挪过来，`contracts` 只留引用检查与离线 / 在线契约三步。
- 核心回归套件的失败行写进 job summary（`$GITHUB_STEP_SUMMARY`），无需登录即可读。
- `package.json` 的 `files` 与 `lib` 下实际文件一致性加回归守卫（`lib/index.js` 运行时动态 import `lib/data/*.js`）。

### Changed

- 我们拼的字（事件类型标签、震度 / 海啸等级词、headline 模板、匹配层与流水线的 reason 与抑制说明、未命中后缀）改为按界面语言取词；上游电文原文继续原样透传。
- 履历「类型」行的来源标注由写死中文改为文案 key `sourceCode.*`（四语），取词在 `p2pCodeTextOf` 里做；`EMSC` / `USGS` / `NOAA CAP` / `NWS` / `ECCC` / `code 551` 等品牌名与规范标识不翻。
- 源码侧 8 个文件改成取词：`05-parser` / `05b` / `05c` / `05f` / `05h` / `06-matcher` / `10-dedupe` / `11-pipeline`；`SOURCE_ZH` 中文源名表删除，改用 00f 已有的四语 `settings.sourceLabels.*`。
- 状态 / 诊断层约 70 条字符串（散在 `12-websocket` / `12b` / `12c` / `12d` / `12e` / `05g` 与 Host 的 `lib/poller.js` / `lib/nmc-source.js`）改成简短英文，例如 `retry 3`、`stale · no new data for 180m`。
- `05e-cn-parsers.js` 的 `kindLabel` 与深度后缀、「第 N 报」改为 `kind.cenc*` 四语取词。
- `lib/wolfx-source.js` 两个 `label` 改为 `CENC EEW` / `CENC eqlist`；`15-entry.js` 传给 `createFeedClient` / `createCnStream` 的三处中文副本与 `05d` 契约五条描述性源名改成中性英文（`気象庁 防災情報XML` / `気象庁` 保持原样）。
- 日本源三条测试电文正文改为整句日语；全球源（EMSC / USGS）假地名改为 `<watch point> region (test)`。
- 删除 `TEST_SCENARIOS` / `TEST_GEO_SCENARIOS` 里无消费者的 `label` / `note` 字段。
- 历史准入收紧：没命中 / 未达档位的条目一律不再进历史；判不了的（区域数据缺失、坐标缺失、震源情报无震度、海外源没有来源关注点）仍进历史。
- 震度档位规整：先按既有语义夹取到 [0,70]，再吸附到最近合法档位（42 → 40）；`0` 保留；震级门槛不吸附。
- 国家 / 地区名数据改为四语 `{ code, count, names: { 'zh-CN', 'zh-TW', ja, en } }`，设置页按当前语言取词并按该语言排序规则排列；名字由 `Intl.DisplayNames` 算出（166 个国家 × 4 种语言）；老 Host 只下发 `name` 的形态仍兼容。
- 城市名统一用拉丁文，规则落在 `latinCityNameOf`（取 `asciiname`，缺则退 `name`），生成脚本改用它并重跑：`lib/data/world-cities.js` 的 5224 条城市名零汉字。
- GeoNames 源数据（`cities15000.zip` / `admin1CodesASCII.txt`）加进 `.gitignore`。
- 历史记录新增「过去 5 天」上限与既有 30 条上限同时生效，按写入时刻判定；老记录没有写入时刻时退回按发布时刻判一次，两者都认不出则保留；三语 README 同步写明两个上限。
- P2PQuake 重连时用官方 REST `/v2/history` 补拉断线窗口内 2 分钟的消息，逐条走同一主链，时间认不出的不补但计数；补拉失败不改变连接状态；首次连接不补。
- 「真正播报过的事件」记忆存到本地的 `dsh.quakeAlert.alerted`，启动时读回并丢掉过期条目，删除也写回本地。
- 音效新增地震（含紧急地震速报）/ 海啸 / 气象灾害三个分开关，默认全开；`notify.sound` 总开关关掉时三个分开关不显示；判据抽成纯函数 `soundAllowedFor`；Host schema / `DEFAULT_CFG` / `normalizeCfg` 三处同步。
- 海外源响应体上限改为按 body 流读取、超限立刻 `cancel()`；没有 `TextDecoder` 的环境退回 `res.text()` 事后比较。
- `fetch` / `TextDecoder` / `TextEncoder` 注入测试沙箱，12e 默认取数路径在回归里可执行。
- `cnStreamRegistry` 注册与 `start()`、注销与 `stop()` 配对。
- 源契约的 `required` 按「实现有意容忍」放宽（P2PQuake 551 `earthquake.time`、551 `points[].scale/pref/addr`、552 `areas[].name` 与 `grade` 枚举、556 `issue.eventId`；JMA 的 `Item/Kind` / `Area` / `ReportDateTime` 结构必需；USGS 的 `geometry.coordinates` 与 `metadata.generated`；速报 `md5`；NMC `kind` 越界）。
- 气象事件窗口 3 小时（`WEATHER_EVENT_WINDOW_MINUTES`）与解除匹配 24 小时（`ALERTED_MAX_MS`）的分工写进两边注释，并用断言钉住两个取值与作用。
- `/stream` 补发条数上限保持现状（一次重连最多补发满固定长度缓冲 120 条），量级写进 README 已知限制。
- 三语 README 里指向不存在章节的引用改成自足说明。
- README 打包口径改为如实说明「运行时加载构建产物，本仓库的包把源码也一起发」，并点明 `samples/` / `tests/` / `scripts/` 不在包里。
- `11-pipeline` 注释写明 `weakenEvent` 不推广到全部灾种（551「震源情报」的 `strength` 为 -1 且与该地震「各地震度」共用同一事件键），并用断言钉住反面。
- 回归 1767 → 2097（+330 条），覆盖下列修正项与两条产品决策（历史只收「命中或判不了」、震度档位就近对齐）。

### Fixed

- CI 红：`tests/sync-test.cjs` 的 Host 侧断言 `await import(lib/index.js)` 需要 `@deepseek-ai/schemastery`，零依赖的 `contracts` job 不跑 `pnpm install` 导致三条 Host 断言全红；同步加载 Host 入口的核心回归套件挪到装依赖的 job，`contracts` 只留真正零依赖的三步。
- 测试依赖本机时区：`fmt()` 用 `getFullYear()` / `getHours()` 拼裸时间串，改为加 9 小时偏移后取 UTC 字段；workflow 注释写明不要给 CI 固定 TZ。
- 两条时间炸弹：① 以 `Date.UTC(2026,8,28,12,0,0)` 当 now 判 24 小时记忆；② `Date.UTC(2026,8,27,12,0,0)` 喂给内部用真实时钟剪枝的 `addEvent`；两处改用 `Date.now()` 或其偏移。
- 局部变量遮蔽 i18n 的 `t` 共 6 处（含 `06-matcher` 的 `const t = cfg.thresholds`）改名，并在 `scripts/check-imports.mjs` 加机械守卫：一个文件里 `t` 不许既是 import 又是局部声明（该守卫又抓出 4 处）。
- `scripts/check-imports.mjs` 新增守卫：状态层文件里不许出现中文字面量。
- Host 轮询器失败路径不做重试间隔递增，改为按 2 的幂放大到 10 分钟封顶，一轮成功立刻回到 `intervalMs`。
- Host 轮询器 `stop()` 不中止在飞请求，改为每轮挂一个 `AbortController` 并在 `stop()` 中止它，「被自己中止」不计入 `errors` / `lastError`。
- `content-length` 预检拦不住解压后的超大响应，改为按 `res.body` 流读取、边读边计数、超限即 `cancel`；没有 body 流的环境退回 `res.text()` 加事后比较。
- feed 抓取失败只 `errors++` 不写 `lastError`，超时 / DNS 这类故障现在有原因。
- `/areas` 注释「单次响应约 80KB」改为实测 103,606 B。
- `build-client.mjs --check` 在 Windows + `core.autocrlf=true` 的全新检出上假报 bundle 陈旧（CRLF vs LF）。
- 本地请求超时被静默丢弃：`AbortSignal.any` 不可用的浏览器上 `else if (signal) sig = signal` 丢掉超时信号，导致 jma / usgs / noaa / nmc 四源同时永久停摆；改为自建 `AbortController` 同时接上两个信号，最老引擎另留 `Promise.race` 兜底。
- 跨源近似归并加候选过滤：候选记录带 `kind` / `test`，灾种不同或对方是演示消息不算同一事件的副本。
- `geoEventKey` 在时间不可解析时不再回退 `String(time).slice(0,16)`，改为给一个不可能与其它事件相同的键。
- 导入配置不再静默丢掉关注点：规整时记一份检查清单（原始条数 / 丢掉几条 / 几条半径被回退），导入结果带上它并如实显示；`numOr` 开始接受数字字符串，`radiusKm: "100"` 不再被放大成 300km。
- 区域全不认识时：`matchAlert` 返回 `hit:false` + 原因，`handleAlert` 的未命中分支仍写历史，并用断言钉住。
- JMA「特別警報 → 警報」（`VPNO50` 的「…を警報に切り替えました」）不再按解除处理，识别为降级：照 L4 警报处理（区域保留、按关注地区 / 阈值 / 静默时段裁决），标签写「（降级）」，`cancelled=false`，与稍后的真解除共用同一把键。
- `hazardKeyOf` 不再跳过 inactive 条目，解除电文也能认出灾种；确实认不出时用显式未知标记 `?`（不再退回「气象」）。
- NOAA 的 event 名匹配由子串改为整串锚定（先统一大小写与空格），未识别 event 等级仍为 0，但标签如实带出原始 event 名。
- NWS 的 VTEC 事件追踪号由写死 4 位放宽到 4~6 位。
- `requestPermission` 两种签名都接（回调式与 Promise 式），不再显示「未获授权」。
- 撤销导入不再漏算地区页签（导入只有全球关注点的配置后一级选择器仍高亮旧分支）。
- 15 条无消费者的 i18n 键：`configIo.copied` / `configIo.copyFailed` 接线成配置页的复制按钮，其余 13 条（`scale.*` 10 条、`tsunami.*` 3 条）与 `source.jma` / `source.nmc` 删除。
- `pnpm check` 的 `node --check` 手写清单补齐 `cities.js` / `cn-areas.js` / `river-areas.js`，并在回归里加守卫：`lib` 下每个 `.js` 都必须出现在 check 脚本里。
- `check-imports.mjs` 不再把整段模板串（含 `${…}` 插值）清空，改为只抹字面部分、插值体按普通代码扫描。
- zip 读取器校验中央目录里的 CRC32 与「解压后长度」；`scripts/build-areas.mjs` 的 fetch 补上 120 秒超时。
- 速报的 md5 指纹不再当「整表没变」的判定条件，只作观测读数，去重一律走逐条比对。
- `nmcFeedTime` 改为取 nmc 列表里的最新时刻，不再假定第一条最新。
- 速报去重记忆 TTL 由 24 小时改为 30 天（`EQLIST_SEEN_TTL_MS`），老条目计入 `dupSkipped`。
- 规整里的硬编码 `300 / 300` 改用 01-constants 的 `MIN|MAX_PLACE_RADIUS_KM` / `MAX_WATCH_CITIES`；半径兜底值起名 `LEGACY_PLACE_RADIUS_KM`（300）。
- `/[都道府県]$/` 不再对北海道削出「北海」并造出上百条「北海○○市」幻影别名，只削 県 / 都 / 府 后缀。
- `res.write` 的写入积压：写入连续积压超过 200 帧就主动断流，让 Client 带 `Last-Event-ID` 重连由固定长度缓冲补齐，`drain` 到了归零。
- 补发期间客户端断开后订阅与心跳再也清不掉：每一步之后复查 `closed`，装完再复查一次；补发期间断开不再 `markRead()`。
- 消息级去重由固定窗口改为「命中即刷新」，清理时用这条记录自己的窗口。
- 市町村表 22 处错名修正（11 处 U+3096「ゖ」，以及 ヶ / ケ 写成 `け`、`ノ` 写成 `の`、`アルプス` 写成 `あるぷす`）；ケ 与 ヶ 是两种不同的字，有河川表的 8 例以河川表为准；回归守卫：不许再出现 U+3096、与河川表不许再有拼写冲突、22 处官方写法必须在表里。
- USGS 缺 `geometry` 时直接返回 null，不再产出 `id: 'usgs:null,null,<时间>'` 这类会互相撞键的事件对象。
- 删除 `parseUsgsFeed`（生产路径无调用点），回归改由测试自己 map 真实样本的每个 feature。
- 「北海道」记录订正：CHANGELOG 曾把「两表假名不一致（8 例）」记为 0.3.2 / Fixed，实际数据一直在。
- NMC 橙 / 红预警详情页抓取失败后不再整条丢弃：重试用尽后改用 `parseNmcList` 拼好的同形 `payload` 入库，并单独计入 `detailFallback`。
- nmc 详情取全部 `#alarmtext` 块并用换行分隔（原先只取第一个，实测 5 份真实详情页中 4 份有第二个「防御指南」块）。
- JMA 电文所有区域都不认识时：`regions` 为空时 `matchAlert` 返回 `hit:false` + 原因，未命中分支仍写历史（断言钉住）。
- 气象去重窗口 3 小时与已提醒记忆 24 小时各管一个问题，两处文档口径订正为一致。
- 市町村按钮补 `aria-pressed`（WCAG 4.1.2）。
- 设置页一处 11px 文字由 `#6b7280`（深色底约 3.6:1）改为 `#9aa0a6`。
- 切换数据源后的重启不再被「关掉设置页」取消：清理时执行挂起的重启（定时器照旧清掉）。
- 一批告警同时到达时 toast 不再完全重叠：共用纵向堆叠容器、最多同时 3 条（超出收掉最旧的）、标题 + 正文 + 颜色相同的正在显示 toast 不再叠一条、容器 `pointer-events: none` + 单条 `auto`；长标题补 `word-break`。
- 诊断工具自身的失败不再被吞：调用方的 warnings 传进 `safe()`；`stringify` 失败时结果里带上 `warning`。
- 快照版本号由 3 提到 4。
- `/feed` 由只按条数截断改为增加 1MB 字节预算（至少保留一条），截断同样置 `more`，Client 按实际返回的 seq 续拉。
- nmc 列表被 `pageSize=500` 截断时尾部不再静默消失：可见「被截断」，不擅自翻页。
- 从轮询升回 SSE 前重新读取本地存储，不再用过期的内存读取位置（降级期间推进读取位置的是轮询客户端）。
- SSE 存活判定不再只覆盖「收到第一条数据之前」：Host 每 15 秒必发状态帧，45 秒没有任何帧即判死重连，连续 `maxFails` 次降级到轮询；两种死亡分开计数。
- `12c` 改为 apply 之后再推进读取位置，不再先推进后 apply。

### Removed

- 删除 `SOURCE_ZH` 中文源名表、`parseUsgsFeed` 死映射器、15 条死 i18n 键（`scale.*` 10 条、`tsunami.*` 3 条、`source.jma`、`source.nmc`）与 `TEST_SCENARIOS` / `TEST_GEO_SCENARIOS` 的 `label` / `note` 字段。

## [0.9.3] - 2026-09-27

### Added

- 繁体中文（`zh-TW`）一整套界面文案：`00a` / `00b` / `00c` / `00e` 四个文案文件各补一整栏，每语言 408 条 key，用词按 zh-TW 写（設定 / 匯入 / 匯出 / 紀錄 / 載入 / 勿擾時段 / 土石流 / 暴潮 / 資訊）而非简体字形转换。
- 都道府县名繁体栏 `PREF_HANT`（00d）：47 项与 `PREFECTURES` 一一对应，去掉「都 / 府 / 県」、保留「道」，字形按繁体通行写法（`静岡` → `靜岡`、`広島` → `廣島`、`沖縄` → `沖繩`、`鹿児島` → `鹿兒島`）。
- 新增 `source.p2pConnected` / `source.p2pSandbox` 两条文案（四语言），取消 `12-websocket.js` 里的中文字面量。

### Changed

- `LANGUAGE_OPTIONS` 与设置页语言下拉随 `00-i18n` 派生自动多出一项；配置契约与 Host schema 未改。
- 装载期三条校验（文案文件覆盖全部语言、面内各语言 key 集合一致、面无重复 key）继续把「漏翻一条」变成装载即失败。
- `resolveLang` 的中文回退改为脚本与地区子标签优先：`zh-Hant` / `zh-HK` / `zh-MO` / `zh-TW` → `zh-TW`；`zh` / `zh-Hans` / `zh-CN` / `zh-SG` → `zh-CN`；非中文仍按主语言回退。
- 渲染冒烟的「简体字形」判据由手写 34 字正则改为手写冻结的 185 字简体专有字表，既查整张 zh-TW 表（覆盖全部 408 条），也查渲染文本（zh-TW 用该表，ja / en 沿用原先那批高置信字），另两个语言面加「整条照抄 zh-CN 表值」的反查。
- 「繁体县名不得照抄日文汉字」判据改为显式断言字确实不同的 5 个县（`静岡` / `広島` / `徳島` / `鹿児島` / `沖縄`）并加下界守卫，另按「繁体与简体有差异」派生全部 22 项查非空。
- 繁体用词校正：`链路` → `鏈路`；`prefLabelOf` 在繁体缺项时回退到日文原名而不是简体名。
- 测试面同步与判据加固：语言清单长度与渲染覆盖次数改为从清单派生；语言下拉的选项、显示名与顺序整体钉住；渲染冒烟 seed 扩到全部 47 个县并补「47 个县都有简体名」；按语言补 `store.detail` 与安全分级的繁体实值；配置导出导入补 `language: 'zh-TW'` 往返；`bindSettingsScope` 补「Host 语言立即生效」；回退表样本换成 `zh-Hant-TW`；key 集合一致性循环从 `LANGS.slice(1)` 起跑；语言负样本前置失败不再让后续断言空过；县名期望表加 `hasOwnProperty` 守卫。
- 回归 1693 → 1767（+74 条）。

### Fixed

- `bindSettingsScope` 的 `sync()` 增加 `setLanguage`，Host 的语言值落到 i18n（此前语言下拉与诊断快照已是 Host 值、界面停在启动镜像解析出的语言且不会自愈）。
- Host 的形状校验容忍语言码首尾空白，下划线 / 空格分隔 / 中文名 / 数字照旧拦住（手写 `settings.yaml` 留一个行尾空格不再让整段 section 被 wire 校验拒掉）。
- `zh-Hans-HK` 按脚本子标签判为简体（地区不再压过脚本），`zh-Hant-CN` 同理判为繁体。
- `status.emscConnected` 由中文字面量改为 `t()` 取词。

## [0.9.2] - 2026-09-27

### Added

- 诊断快照新增只读 `delivery` 段（`audio` / `notificationPermission`）。

### Changed

- NOAA 海啸事件标签由「海啸注意报（NOAA）」改为「海啸警报」，等级仍为 2；测试场景名与三语文案 `settings.diag.scenario.noaa` 同步。
- `scripts/check-contracts.mjs` 增加第三份 NWS 事件白名单自检：读 `client/src/05h` 源码文本逐项比对。
- 三语 README：模块数 27 → 35、构建脚本清单补 `build-cn-areas.mjs`、开发章节断言数由 1427 统一为 1683；日文 README 连接状态点补齐到六态。
- 0.7.0 条目里 `@deepseek-ai/schemastery` 的写法由 `~3.18.4` 改为 `^3.18.4`，与实际声明一致。

### Fixed

- 逐条上报的 `empty` 不再清数据层：`parseNwsAlertResult` 对非白名单事件返回 `empty`，经 `noteParseResult` 会清蓝点并归零 `consecutiveFail`；现逐条上报传 `perItem`，只有轮级判定清蓝点。
- 强度升级绕开跨标签页标记为已处理：`claimAlertForTab` 按消息 id 保留 10 分钟，EMSC 修订版复用同一 `unid`（`action: 'update'`），震级上修（M5.2 → M6.4）此前被静默。
- 导入备份改为一次性：撤销成功后调 `clearConfigBackup` 清掉备份并隐藏按钮，按钮下方显示备份时间（三语言）。
- `wolfx` 空闲重探不再无条件 `scheduleNext(IDLE_RETRY_MS)`，改为停链、由 `markRead()` 唤醒，`idleSkips` 不再无界增长。
- `parseNoaaEntries` 匹配前先 `indexOf('</entry>')` 早退，避免只有开标签的截断响应上 O(n²) 回溯。
- 整体替换配置后重算 `regionTab`，导入后地区页签不再停在挂载时推导的旧分支。
- 三处契约把 EMSC 的 `flynn_region`、USGS 的 `id` / `updated`、NOAA 的 `<area><circle>` 由 `required` 移入 `tolerant`。
- ECCC 用例改为断言两道过滤器的不变量，不再点名 `FTA` / `WDW` / `CFW`；契约脚本不再点名 `storm surge warning`；区域名对齐用例补 188 / 66 两条长度断言。
- P2PQuake 552 改为按真实结构覆盖：551 / 552 / 556 三种 code 各拉最近一条分别检查。

## [0.9.1] - 2026-09-26

### Changed

- `mergeParts` 增加装载期校验：每种语言都必须有显示名（`LANGUAGE_LABELS`），否则 `LANGUAGE_OPTIONS` 会产出 `label: undefined`。
- `scripts/check-imports.mjs` 的 i18n key 检查排除字符串拼接（`t('a.' + key)`），并接受双引号 / 反引号 / `t (` 三种写法。
- `00b-texts-settings.js` 文件头不再把 `store.detail` 与都道府县名列为原样透传，`suppressedReason` 单独标出。

### Fixed

- 设置页 47 个县名改走 `prefLabelOf`，删掉另写的恒取中文名实现（英文界面此前显示「北海道 / 青森」等）。
- 已关注县的显示名模板由 `'{zh}（{jp}）'` 改回只括注原名，不再出现「东京东京（東京都）」。
- `parseConfigImport` 把规整包进 try/catch 并返回 `shape` 错误码；UI 补 `.catch` 兜底并新增「导入过程中出错了」文案。
- 备份写失败时拒绝导入：`saveJSON` 写后回读校验，取不到即返回 `backup-failed`，不再报「导入成功 + 可撤销」。
- 语言真变化时调 `store.recomputeStatus()` + `store.push({})`，侧边栏悬停提示、状态点读屏标签、诊断快照状态摘要不再停在旧语言。
- `TEST_SCENARIOS` / `TEST_GEO_SCENARIOS` 的 `label` / `note` 改为按稳定标识取 `settings.diag.scenario.<key>`，不再恒为中文。
- 12c / 12e 的降级 / 关闭 / 覆盖范围说明进文案表并走 `t()`，源状态 `detail` 不再恒为中文。
- 配置导入接受 UTF-8 BOM（`replace(/^\uFEFF/, '')`），不再提示「不是有效的 JSON」。
- `t()` 改用 `hasOwnProperty` 取词，`t('constructor')` / `t('toString')` / `t('valueOf')` 回显 key 且带参数不抛，`00f` 的两张映射表同样处理。
- 日文译文 `中国大陸の分支` → `中国大陸の区分`。
- 英文界面语言区块标题由「Language / 言語」改为 `Language`。
- `statusTextOf` 的 `retries` 非数字一律按 0，不再渲染「重连中（第 undefined 次）」。

## [0.9.0] - 2026-09-26

### Added

- 界面语言支持简体中文 / 日本語 / English（设置 → 其他 → 语言）：只翻本插件生成的文本，源的 `headline` / `detail` / 地名 / `kindLabel` 原样透传。
- 语言值域是插件自己的 BCP 47 清单，Host schema 只校验 BCP 47 形状、白名单留在 Client。
- 回退链按 BCP 47 惯例逐级匹配（精确 → 主语言 → 默认 `zh-CN`），认不出的值落到清单内语言，不跟随 `navigator.language`。
- `00-i18n.js` 提供机制（语言清单、回退链、取词、汇总），各 `00x-texts-*.js` 为三语言并列的纯数据面；模块加载期校验每份面覆盖全部语言、同面内各语言 key 集合相同、面间无重复 key。
- 取不到 key 时回显 key 本身（界面上直接显示 `settings.watch.title`）。
- 语言在 `loadCfg`（启动）与 `applyCfg`（设置页切换）两条路径上都生效。
- 都道府县显示名随语言（日文「東京都」/ 中文「东京（東京都）」/ 英文「Tokyo (東京都)」）；匹配始终用 `PREFECTURES[].jp`，`PREF_SET` / `PREF_SHORT` 由它派生，罗马字另存 47 条表。
- 源名与连接状态随语言：源 id → 文案 key 的映射只有一份（侧边栏悬停提示、设置页源状态区块、重试按钮共用）且调用时求值；状态摘要不再直接拼 `open` / `closed`。
- 配置导出导入（设置 → 其他）：导出关注点、阈值、语言、数据源、静默时段、通知开关，不含履历与源健康记录；文件为带 `format` / `formatVersion` 的 JSON，不写插件版本。
- 导入为整体替换不合并；导入前自动备份并提供「撤销上次导入」；校验失败什么都不写（连备份都不做）；失败返回错误码，文案由界面按当前语言翻。
- `formatVersion` 高于本版可读的直接拒绝；沙箱里自动下载不可用时退回「把 JSON 显示出来让用户自己复制」。

### Changed

- 设置页震度 / 海啸 / 震级 / 半径四个档位下拉的选项文字搬进三语表，档位表只留 `labelKey`，渲染时取词；匹配值未动（震度仍用 P2PQuake `scale` 数值，海啸仍用 `Watch` / `Warning` / `MajorWarning`）。
- `LANGUAGE_OPTIONS` 改为从 `00-i18n.js` 的语言清单派生，不再另写一份。
- 默认语言下界面输出与本地化之前逐字一致。
- `scripts/check-imports.mjs` 增加 i18n key 引用一致性检查：正文里 `t('字面量')` 的 key 必须存在于文案表（剥掉注释后再匹配）。

### Fixed

- 语言断言不再用 `'ja'` 当清单外语言码，改为从 `LANGS` 派生的清单外合法 BCP 47 值 `pt-BR`。
- 源名表与选项卡标签改为调用时求值，不再在模块加载期取词（此前切语言后一半跟着切、一半不切）。

## [0.8.2] - 2026-09-26

### Changed

- Host 的语言校验由 `z.union(['zh-CN'])` 改为 `z.string().pattern(BCP47)`（与 `dsh-client-locale` 的 `LOCALE_ID_PATTERN` 同形），白名单留在 Client；`"日本語"`、数字 42 仍被拒。
- 诊断快照：大陆关注点带上 `province` / `city`，非大陆点不写这两个键；格式版本 2 → 3。
- 设置页状态条指路文案颜色 `#6b7280` → `#9aa0a6`；`s.select` 自绘箭头的三项样式移到调用方 `extra` 之后；静默时段补回「按浏览器本地时间判定」。
- `lib/index.js` 的 `vol()` 说明订正：未标 volatile 的字段会被规整回默认值，且所有设置写不进 profile 配置、客户端吞掉报错。
- `TROUBLESHOOTING.zh.md` 新增设置页导航说明（五个选项卡 + 排障面在「其他」），修正路径串 `设置 → 灾害预警 → 其他 → 测试与诊断`、`设置 → 灾害 → 提醒阈值`、`设置 → 通知 → 通知与声音` 与诊断快照版本 / 字段说明。
- 本地化范围写清：`LANGUAGE_OPTIONS` 只管界面语言，源的文本原样透传；订正「不存在语言变体问题」一句，ECCC 是唯一英法双语源（固定取 `_en`）。

### Fixed

- 大陆气象：`matchCnAreaAlert` 把关注点判定提到门槛之前，`cnPlaces.length === 0` 时统一返回 `noWatch`；未配大陆关注点时黄 / 蓝预警不再写进履历，门槛本身未动。
- 大陆关注点判据由「名字里含 `·`(U+00B7)」改为显式来源分支 `origin`，与 `normalizePlaces` 共用 `placeOriginOf`；手填坐标与全球城市点不再被算成大陆关注点。
- 省份认不出的预警不再让任意含 `·` 的关注点命中播报（仍按全国放行，作用范围收窄）。
- `cnPlaceOf` 产出 `province` / `city` 并显式落到关注点上，`normalizePlaces` 透传，老配置按名字形状迁移一次；两个字段登记进 Host schema，行政区匹配不再从名字反推。
- 日本 EEW 通知标题改回「⚠ 紧急地震速报（警报）」，海外气象行动提示改回「避难与撤离指引」，大陆气象提示改回「防御指引」。
- 日本 EEW 的通知标题与履历 `label` 对「是不是警报级」的说法必须一致（断言锚点升级）。
- 全球海啸行写回「全球源按关注点半径判定」并配断言。

## [0.8.1] - 2026-09-26

### Added

- 设置页由一列改为五个选项卡（地区 / 灾害 / 通知 / 履历 / 其他），每页只渲染自己可见的区块，未选中页不产生 DOM（「只看履历」从 616 个元素降到 13 个）。
- 页签带角标（地区显示关注数、履历显示记录条数），只在有内容时出现。
- 常驻状态条提到选项卡之外（面板最上方），切页不变，只显示状态圆点 + 结论（已连接 / 未启动 / 重连中）+ 已收到条数。
- 状态条不再复述 `store.detail`，逐源信息只留在「其他」页的「源状态」。
- 语言先行契约一次立齐：`LANGUAGE_OPTIONS` 常量、`DEFAULT_CFG.language`、`normalizeCfg` 白名单、Host schema 叶子（带 `volatile()`）、UI 下拉、诊断快照字段；当前只有简体中文，界面注明「其他语言在 0.9.0 加入」。

### Changed

- 文本瘦身：默认可见汉字（三个地区分支之和）从 6688 降到 2832（−58%），每区块只留一行说明、每选项行只留一句判据，解释与许可署名收进原生 `<details>`（内容仍在 DOM 里）。
- 安全相关文案未删：大陆源无取消机制、橙色门槛、ECCC 署名、6 小时年龄门槛、海啸行动提示、免责声明。
- 文案去 AI 味改了 28 处，例如 `配置：机器级（settings.yaml）` → `配置：保存在本机（settings.yaml）`、`按观测震度` → `本地观测到的震度`、`固定：警戒レベル4 以上` → `警戒4级以上`、`命中关注地区` → `命中地区`、`命中关注点` → `命中位置`、`逐源详情见「其他」` → `详情在「其他」里`。
- 下拉框改自绘箭头（`appearance: none` + 背景 SVG），箭头固定贴右边缘，各平台长相一致。
- `background` 简写改成 `backgroundColor`，避免清掉 `backgroundImage`。

## [0.8.0] - 2026-09-26

### Added

- 跨源优先源：同一场地震被日本台网 / 中国台网 / USGS / EMSC 各报一次时只让先到的源播报，其余副本不进历史；判据为 ±2 分钟 + 50km + 跨机构，跨源不比 strength、不补播。
- 被抑制的条数计入诊断快照 `authority` 段；同一机构内部的产品演进仍走「只记历史」链路。
- 日本源 551 / 556 解析器产出 `alert.geo`（取 `earthquake.hypocenter` 经纬度），不设 `locator: 'point'`；缺一个 / 越界 / `-200` 特殊标记值一律不产出 geo。
- `watch.places` 条目新增来源分支 `origin`（`cn` / `global`）；老配置无该字段时按名称形状推导，Host schema 同步登记。
- 全球主要城市表：人口 10 万以上城镇、166 个国家 / 地区共 5224 条（GeoNames，CC BY 4.0），按国家分包由 Host 下发（`/areas?country=XX`，不带参数只给约 160 条国家清单）。
- 城市名取 GeoNames alternatenames 里的中文候选（最短一个），无则用 asciiname；同国内重名城市附一级行政区（`斯普林菲尔德（Illinois）`）；`admin` 只用于展示与区分，不参与匹配。
- 城市表不含日本与中国（含台港澳）；构建脚本 `scripts/build-world-cities.mjs`，与 `build-cn-areas.mjs` 共用抽出的 `scripts/lib/geonames.mjs`。
- 诊断快照格式版本 1 → 2：新增 `authority` 段（被压掉的条数、按已播报源分组、最近一条的原因），`config.watch.places[]` 新增 `origin`。

### Changed

- 设置页三个平铺地区区块（日本 / 中国大陆 / 其他地区）收成一个「国家 / 地区」选择器，选中后只展开该国下级控件；已关注地区在同一区块以统一列表呈现（按来源分组、可直接移除）。
- 配置仍是 `prefectures` / `cities` / `places` 三份数据，匹配语义未动（日本按行政区名、坐标型源按震中距 ≤ 半径）；默认落在哪个分支由现有配置推断。
- 灾害类型与提醒阈值并成按灾种的一张表（一行一个灾种，开关与阈值并排）；`disasters.earthquake` 一个字段管四行地震，固定门槛（气象 L4、大陆橙色、海外 warning）写成只读文字。
- 「其他国家 / 地区」分支改为「国家 / 地区」选择 → 城市搜索 → 点选即添加，半径共用同一个旋钮；手填坐标保留为出口。
- 城市列表的拉取失败 / 未被收录（Host 答 404）/ 正常为空三种状态分别说明（重试 / 手填 / 无事）。
- 测试按钮与源状态收进「测试与诊断」区块。
- 提示文案里的路径同步更新（如 `未设置全球关注点（设置 → 灾害预警 → 关注地区 → 其他国家 / 地区）`）。
- `pnpm check` 增加数据表的语法检查；新增 `build:cn-areas` / `build:world-cities` 两个脚本入口。

### Fixed

- 日本气象电文与大陆气象说明文字里的 `**行政区中心点**` 等 markdown 标记不再被原样渲染成星号，强调改用语序。

## [0.7.0] - 2026-09-26

### Added

- 新增回归断言：`Config` 导出存在且与 `QuakeAlertSettingsSchema` 是同一对象。
- 新增回归断言：每个可编辑叶子都带 volatile，期望条数从 `DEFAULT_CFG` 递归算出。
- 新增回归断言：`applySettingsService` 的四种宿主形态（只有 configure / 只有 register / 两者都有时优先新 API / 两者都没有）。
- 新增回归断言：register 抛错时的兜底。
- 新增回归断言：client 侧 `configForms` 与 `settingsScope` 两条入口都在。
- 新增回归断言：`ConfigForm` 形状被当成机器级配置源，写回的 ops 是 `SettingsPathOp` 形状。

### Changed

- 适配 DSH 0.1.7-rc.2：按宿主实际提供的 settings 方法分派，同时保留 0.1.6 的旧路径。
- 依赖 `@deepseek-ai/schemastery` `^3.18.2` → `^3.18.4`（`.volatile()` 为 3.18.4 新增）。
- 回归断言 1346 → 1363。

### Fixed

- Host 侧导出 `Config`，给全部 24 个可编辑叶子标 volatile。
- 自带配置页面的插件改调 `settings.configure({ auto: false }, ctx.fiber)`；`register` 路径保留为 0.1.6 回退。
- 0.1.7 的 settings 表单从插件导出的 `Config` schema 派生，命名空间为插件在 profile 里的条目 id（仍为 `quake-alert`）。
- 两代 settings API 都不存在时，日志改为说明「宿主版本与插件不匹配」，不再报「settings.yaml 类型不符」。
- 客户端绑定点由 `ctx.settingsScope.bind({ namespace })` 改为 `ctx.configForms.get('quake-alert')`（`ConfigForm`）。
- 旧服务作为回退。
- 两侧绑定点的快照字段一致（`status / value / user / writable / mode`）。
- 写入用 `{op:'set'|'unset', path, value}`（`SettingsPathOp` 形状）。
- `dsh.client.inject` 里失效的 `@deepseek-ai/dsh-client-runtime` 换成 `@deepseek-ai/dsh-client-ui-renderer`。
- 同时补上真正依赖的 `@deepseek-ai/dsh-api-remotes`。

## [0.6.2] - 2026-09-22

### Added

- 新增回归断言：大陆气象命中文案不得含 `NaN` / 「震中」/ 日本口径。
- 新增回归断言：空响应不能清零整轮失败；重试间隔递增必须加在正常间隔之上（用 1200ms 间隔区分）。
- 新增回归断言：`truncated` 的轮语义、`gateActive` 在 `resetGate()` 后重新计数、坐标夹取、大陆气象的官方正文进历史。
- 新增回归断言：`defaultFetchText` 的两条默认路径（无 signal 时 `Promise.race` 超时兜底、400 的 `bodyHint` 截断到 160 字）。
- 修掉三条自身脆弱的用例：ECCC 样本不再绑定季节（不再写死风暴潮，`alert_type` / 名字按需构造）。
- `nws-point-alerts` 的断言改为跟白名单成员关系走；排除名单的负向词改为从 `ECCC_EXCLUDE` 派生。
- 测试沙箱的 `AbortController` 改为 `'AbortController' in o ? …`，「没有 AbortController」的兜底分支可注入。

### Changed

- 三语 README：取消链路由「按 CAP 的 `references` 关联回原警报」改为 VTEC 事件追踪号（`references` 只作兜底）。
- 三语 README：`wind warning` 是 warning，排除理由是「不在本插件的灾种范围内」（只有霜冻 / 雾是 advisory）。
- 三语 README 的「边界」条数统一成五条。
- `TROUBLESHOOTING.zh.md` 第 0 节与 3.1 节补上 NWS / ECCC 两条链路。
- `check-contracts` 一节的源数与 CI 注释同步为 10。
- `scripts/capture-overseas-fixtures.mjs` 写入文件前校验事件链两版的 VTEC 追踪号相同。
- `scripts/capture-overseas-fixtures.mjs` 被引用消息拉取失败时明说并跳过。
- `scripts/capture-overseas-fixtures.mjs` 裁剪后把 `numberMatched` / `numberReturned` 改成裁剪后的条数。
- 该脚本新增自检：与 `client/src/05h` 的白名单逐项比对。
- `samples/eccc/eccc-alerts.geojson` 的 `numberMatched` / `numberReturned` 由 116 改成 3。
- CHANGELOG 0.6.1 措辞订正：坐标夹取、`truncated`、`gated` 进入计数、海外 `ageSkipped` 口径四项当时只有实现、没有断言。
- 回归断言 1,315 → 1,346。

### Fixed

- 大陆气象（nmc）通知正文不再出现「距震中约 NaN km」与日本口径避难提示：判据由 `locator === 'overseas'` 改为有没有真实距离。
- 真实距离只有坐标型源才有；行动提示按机构分岔：日本 → 市町村避难信息，大陆 → 当地气象台的防御指引，海外 → 当地官方指引。
- 空响应不再清零整轮解析失败计数：空结果判定由 `05g` 的 `empty` 分支（会 `clearData`）移到轮末，只在整轮一条失败都没有时才发。
- 失败重试间隔递增改为加在正常间隔之上（原 `max(重试间隔, 正常间隔)` 在 120 / 300 秒真实间隔下恒等于正常间隔，60 秒上限形同虚设）。
- `truncated` 单位由「响应」改为「轮」，在轮末汇总（加拿大 N 个关注点一轮不再 +N）。
- 开关标志随 `start()` / `resetGate()` 复位。
- 可注入的 `timeoutMs` / `uncoveredTtlMs` 改用 `Number.isFinite` 判断，`NaN` 不再被当成有效值。

## [0.6.1] - 2026-09-22

### Added

- `alert.detail` 写进历史条目（截断到 1200 字符），设置页展开条目时多一行「正文」。
- NWS 的 `description + instruction` 与 ECCC 的正文 + 署名进入 `alert.detail`。
- `samples/nws/nws-event-chain.geojson` / `nws-cancel-chain.geojson`：两条真实事件链快照。
- 快照内容：同一洪水预警的连续两版；被取消的警报 + 它的 Cancel。
- `createOverseasSource` 的 `timeoutMs` / `uncoveredTtlMs` 可注入。
- 测试沙箱补上 `AbortController`（浏览器标准全局）。
- 新增回归断言：真实事件链同键 + 端到端 `handleAlert`、Cancel 端到端。
- 新增回归断言：`createEcccSource` 的取数接线（URL / bbox / `limit=200` / `overseasStatsOf` 快照）。
- 新增回归断言：400 冷却到期后重试、ECCC 排除名单表驱动（17 个词 +「先排除再包含」顺序）。
- 新增回归断言：`feature_id` 缺失时的事件键兜底、真实非白名单响应判 empty、白名单大小写精确匹配。
- 新增回归断言：超时文案、重试间隔递增、空响应清蓝点、海外通知文案无 NaN。

### Changed

- 用例 18 的「刚发布不进门闸」不再依赖 fixture 的绝对日期（`sent` 固定为抓取当天）。
- `scripts/check-overseas-sources.mjs` 补上顶层形状判据：缺 `features` 时不再被当成「0 条」且 exit 0。
- `samples/README.md` 措辞订正：ECCC 被排除的 `wind warning` 是 warning（只有霜冻 / 雾是 advisory）。
- 同上：排除理由是「不在本插件的灾种范围内」。
- 回归断言 1242 → 1315。

### Fixed

- NWS 事件键改用 VTEC 事件追踪号 `<office>.<phenom>.<sig>.<ETN>`（剔除 ACTION 段）。
- 不再取 CAP `references` 里 `sent` 最早的一条。
- 事件键兜底顺序：VTEC → references（取 `sent` 最早、并列取 identifier 字典序）→ 自身 identifier，三级都不判 schema。
- 海外预警通知正文不再出现「距震中约 NaN km」：`matchOverseasAlert` 返回 `place` 但无 `distanceKm`，全球源分支改为按有无距离拼接。
- 行动提示的日本口径修正（海外源不再说「请确认所在市町村的避难信息」）。
- 免责声明补 `nws_alerts` / `eccc_alerts` 的 `AUTHORITY_BY_SOURCE` 机构名。
- 取消链路的灾种开关按来源分岔：`handleCancelled` 不再一律看日本气象的 `disasters.weather`。
- 强度的回落也在命中路径上写回事件记忆：`weakenEvent` 在命中与未命中两条路径都下调强度。
- 失败重试间隔递增不得短于正常间隔：改为 `max(重试间隔, 正常间隔)`。
- `?point=` 覆盖范围补上三个海外领地：波多黎各 / 美属维尔京群岛、关岛 / 北马里亚纳、美属萨摩亚。
- 「有点但都不在覆盖范围」与「一个都没配」分成两句文案（此前一律说「未设置美国关注点」）。
- 结构正确的空响应（`{"features":[]}`）会清掉蓝点。
- HTTP 200 + 非 JSON 与「缺 `features`」统一判 schema（蓝点），不再一个判红点、一个判蓝点。
- 超时不再被报告成「用户主动中止」。
- `16-diag` 快照字段名订正：`uncovered` → `rejected`。
- `gated` 只在进入门槛时计数（原为统计门槛激活的轮数）。
- `ageSkipped` 只统计本来会播报的条目。
- 设置页「收到 N 条」改为「响应条目 N」；新增 `truncated`（上游条目超过 ECCC `limit=200` 的轮数）。
- `NWS_EVENT_QUERY` 改为从白名单派生。
- 采样点坐标夹取（半径最大 2000km 时高纬度的方位点会算出 `lon < -180`）。
- 契约与实现对齐：`nws_alerts` 的 `required` 去掉「`properties.id` 必须非空」（实现会退回 GeoJSON 外层的 `id`）。
- `eccc_alerts` 补上事件键的 UTC 日界与 `areaKey` 兜底边界。

## [0.6.0] - 2026-09-22

### Added

- `client/src/05h-overseas-parsers.js`：海外气象源解析层。
- `nws_alerts` 精确匹配 `properties.event` 的 8 类洪水预警。
- 8 类为 `Flood Warning` / `Flash Flood Warning` / `Coastal Flood Warning` 及各类 Watch、Advisory、Statement。
- `eccc_alerts` 要求 `alert_type='warning'` 且 `alert_name_en` 命中 `/rain|flood|surge|hydrolog|water/`。
- 同时排除 frost / fog / wind / heat 等。
- 两个海外源共用 `locator: 'overseas'`：命中在取数时发生（NWS 按点、ECCC 按 bbox）。
- 取数器把关注点记进 `alert.originPlace`，匹配层不做距离计算。
- `SOURCE_CONTRACTS` 追加 `nws_alerts` / `eccc_alerts` 与 `parseNwsAlertResult` / `parseEcccAlertResult`。
- 两条契约的 `staleAfterMs` 均为 null。
- 设置页源状态区登记两个新源：`SOURCE_CODE_TEXT` / `SOURCE_LABELS` / `SOURCE_ORDER` 与 `p2pCodeTextOf` 的 id 前缀兜底。
- `client/src/12e-overseas-poll.js`：海外源取数器，两个源都是 Client 直连的外部 REST。
- 接口与 `12b` / `12c` 同形（start / stop / pollOnce / pollSerial / stats）。
- 取数纪律：每轮读一次配置、串行请求、10 秒超时、512KB 响应体上限、排新定时器前先清旧的。
- 年龄门槛：首轮或距上次成功 30 分钟时，只播报发布在 6 小时内的条目，更早的仍进历史。
- NWS 取数用 `?point=`，半径 ≥ 25km 时补 4 个方位采样点；ECCC 取数用 `bbox=`（坐标 ± 半径）。
- `client/src/06-matcher.js` 新增 `matchOverseasAlert`：海外气象走查询即匹配，匹配层不算距离。
- `matchOverseasAlert` 四条判定：灾种开关、取消、档位、归属是否仍在关注列表里。
- 播报档位：`Warning` 才播，`Watch` / `Advisory` / `Statement` 只记录。
- 新增 `disasters.overseasWeather` 开关（默认开，一个开关覆盖两个源）。
- `disasters.overseasWeather` 在 `DEFAULT_CFG` / `normalizeCfg` / Host schema / 设置页四处同步。
- `scripts/check-contracts.mjs` 接入两个海外源：在线模式拉真实数据过解析器（NWS 全量 event 查询 80 条、ECCC 全国 bbox 116 条）。
- 该脚本离线模式用新的 `samples/nws` / `samples/eccc` fixture。
- 设置页源状态区新增一行：已查询轮数 / 请求 / 收到 / 交给主链 / 过老只记历史 / 被上游拒绝 / 超上限跳过 / 失败。
- 诊断快照新增 `overseas` 段，与 `feed` / `streams` 并列；计数表与 `feedStatsOf` 分开。
- `scripts/check-overseas-sources.mjs`：零依赖，一条命令打印四个候选源的可达性 / 灾种分布 / 体积 / CORS / 空间粒度。
- 该脚本不进 CI，网络不可达不算失败。
- `scripts/capture-overseas-fixtures.mjs` + `samples/nws/` + `samples/eccc/`：真实响应快照，裁剪但保持同形。
- NWS fixture 保留 8 类洪水预警里的 7 类（`Coastal Flood Warning` 当前无活跃样本），另存一份 `?point=` 查询样本。
- ECCC fixture 每种 `alert_code` 各留一条并保留 Polygon 几何。
- 海外气象源调研：四个候选源中只有美国 NWS 三项同时达标。
- NWS 达标项：灾种契合、`?point=lat,lon` 服务端查询、返回 `Access-Control-Allow-Origin: *` 可 Client 直连。
- 调研结论：GDACS 否决（粒度为国家 / 区域级，台风 / 山火 / 干旱 / 火山不在范围内）。
- 调研结论：MeteoAlarm 不入 0.6.0；ECCC 增益有限。
- 调研纠正：ECCC 的 `CFW` 是 storm surge warning，不是洪水码。
- 调研纠正：CAP 归档里法语办公室的 `<event>` 是 `gel` 而 `eventCode` 仍是 `frost`；归档只有当天、历史不可得。
- 海外气象源接入设计定稿：美国 NWS 主 + 加拿大 ECCC 补，Client 直连，实施分六期。
- ECCC 许可要求署名，且警报内容与意图不得改变（正文原样保留、severity 忠实映射不拔高）。
- 三语 README / `TROUBLESHOOTING.zh.md` / `samples/README.md` 同步：功能列表、工作原理、数据来源与 ECCC 署名要求、fixture 字段要点。
- 文档已知限制：美国半径是近似、ECCC 不覆盖河川洪水、两个源都判不出上游停更、NWS 将来可能改用 API key。
- 新增回归断言：白名单真的在拦（含 `event: 'constructor'` 的原型链攻击）、门槛按 `event` 分档、`originPlace` 透传。
- 新增回归断言：事件键把同一次事件的 Update 归并到同一个键（消息 id 仍带版本）、`messageType=Cancel` 判取消。
- 新增回归断言：ECCC 署名进正文且官方正文未被改写。

### Changed

- 回归断言 1103 → 1242（第 2 期 +61、第 3 / 4 期 +42、第 5 期 +4、第 6 期 review +31）。
- 按实测纠正播报门槛：从「severity ≥ orange」改为按 `event` 名分档。
- 依据：`Flood Watch` 的 severity 也是 `Severe`，与 `Flood Warning` 同级。
- ECCC 白名单从 `eventCode` 改为 `alert_name_en`（OGC API 只给三字母 `alert_code`，无官方枚举）。

### Fixed

- 诊断快照此前对新源不可见：新增 `overseas` 段，并加一条断言守着它的存在。
- NWS 取消链路：事件键改为取 CAP 的 `references`（指向被取代的消息），`wasRecentlyAlerted` 不再恒为假。
- 顶层结构不符（上游改结构、中间层塞回 `{oops:1}`）由判「链路不可达」（红点）改为走 `noteParseResult('schema')`（蓝点）。
- 请求上限吞掉关注点：`MAX_REQUESTS_PER_ROUND = 40` 改为先保证每个关注点的第一个查询无条件排上，剩余额度才补方位采样点。
- 方位采样点本身按轮次轮转起点。
- 年龄门槛排在事件级去重之前会让同一条老预警反复进历史：`staleOnArrival` 移到 `looksReplayed` 之后，并同时记进「已提醒」记忆。
- 状态上报的去重键由 `status` 改为 `status + detail`，刚加完关注点后不再一直显示过期的状态文案。
- 「收到 N 条 / 处理 M 条」计数移到设置页的海外源计数行；detail 改为非单调的「已按 N 个关注点查询」，不留空。
- `stop()` 之后取数器不再写状态：中止不算失败、不写状态、不打失败日志（照搬 `12b-feed-poll.js` 的守卫）。
- 任何 400 不再被判成「这个点不在覆盖范围」并永久拉黑：改为按 URL 记 1 小时冷却，文案为「被上游拒绝（HTTP 400，60 分钟后重试）」。
- 400 的响应体前 160 字留在诊断的 `lastError` 里。
- NWS 对覆盖范围之外的坐标（多伦多 / 温哥华 / 伦敦）返回 400 时，取数器单独分类成 `rejected`，状态保持 open。
- 海外预警不再清掉侧边栏的「日本气象 L3 未达 L4」提示：`updateWeatherHint` 排除 `regions` 恒为空数组的源。
- 单条处理异常不再连带丢掉整个响应：每条 entry 的解析 / 主链各自捕获异常。
- 新增失败重试间隔递增：整轮全部失败才递增（1s 起、翻倍到 60s 上限），成功即回正常间隔。
- 诊断语义订正：`throttled` 拆成 `throttledLast` / `throttledTotal`；`lastError` 成功后清零。
- 诊断语义订正：`stop()` 后刷新快照；`overseasStatsOf` 不再跨插件代存活。
- 诊断语义订正：`feedError` 不再把按点查询的失败写成「增量拉取失败」。

## [0.5.4] - 2026-09-19

### Added

- 无障碍：`s.select` 支持 `aria-label`，6 个阈值 / 链路 / 行政区下拉、音量滑块、两个静默时间框与市町村搜索框都有可编程名称。
- 测试结果与诊断提示加 `role="status"`；页内 toast 加 `role="alert"`（页面可见时只用 toast）。

### Changed

- CI 现在跑核心回归套件：`.github/workflows/contracts.yml` 增加 `check-imports.mjs` 与 `tests/sync-test.cjs` 两步（零依赖）。
- `build-client --check` 仍留给本地 `npm run check`。
- 订正 EMSC「久无数据」检测的描述（0.4.1 起为 3 小时），三语 README 与 05d 契约 `staleReason` 四处同步。
- `05e` / `05c` 注释里 EEW 的 EventID 形态按样本修正（实测 `samples/cn/cenc-eew-last.json` 是 `b4kybfnuqayyy` 这类随机串）。
- 回归断言 1070 → 1103。

### Fixed

- 蓝点被常态断线或自检抹掉后不再恢复：新增 `publishStatus`（05g）作为唯一的 store 写入出口。
- `12-websocket` / `12d` / `15-entry` / `05g` 内部四处全部改走 `publishStatus`。
- `12b` / `12c` 的去重判断除自己的键，还比 store 里当前实际的状态，被外部覆盖的状态在下一轮自愈。
- 新增 `republishDataHealth()`：刷新页面后立刻重新发布已持久化的蓝点（3 秒 + 15 秒），不必等该源下一次上报。
- 降级客户端建立失败后该源整个会话静默：`activateFallback` 改为先建成功再置位，失败回滚到 `idle` 并如实上报 `unreachable`。
- 用户显式选「强制轮询」时 tick 每 5 秒重试。
- 跨标签页「清空记录」同时清内存与磁盘（此前接收方只清 `alertedEvents`，下次 `addEvent` 会把记录写回 localStorage）。
- `12-websocket.start()` 重置 `stopped`，stop 之后再 start 可用。
- `12c` 的 `consecutiveFails` 收到真实数据即归零。
- JMA 汇总副本不再一律标成「气象特别警报」（05b）：汇总族按级别取标签（L5 → 特别警报），带灾种名的副本仍走具体灾种。
- 未配置中国大陆关注点时 nmc 预警不再写进「最近预警」：`matchCnAreaAlert` 给这一类带 `noWatch` 标记，pipeline 据此不进历史（设置页与诊断仍可见）。
- 大陆气象电文不再清空日本电文留下的「L3 正在升级」提示：`updateWeatherHint` 只对日本气象电文生效。
- `looksReplayed` 的抑制理由措辞订正为「24 小时已提醒记忆」。
- 「发送测试气象警报」连点两次不再静默：气象事件键带上毫秒。
- 测试场景半径说明修正：0.5.0 起新建关注点默认半径 100km，半径可配到 2000。
- `parseNmcAlarmResult` / `parseNmcAlarm` 改用 `own()` 查表，`kind: 'constructor'` 不再命中原型链绕过契约的 empty / schema 判据。
- `12b` 的 `schedule()` 排新定时器前先 clear。
- `poller.js` 真空闲时停链：不再每 5 秒空跑自续，由 `markRead()`（/feed 被访问）唤醒；短重试间隔只用于「还没有人来读」的启动窗口。
- settings namespace 注册失败包一层 try/catch + 一条明确的警告日志。
- 触发条件：schema 不做类型强转，手写的 `notify: { volume: "0.5" }` 会让 `register` 抛错。
- Host 迁移标记 `MIGRATED_KEY`（03-settings-bridge）：以 Host 为准的每一条路径都写入「已处理」标记。
- 迁移改为 settle 后回读 `getSnapshot().user` 确认字段真的落上才算完成，并有尝试上限，不再把 resolve 当成功。

## [0.5.3] - 2026-09-19

### Added

- `client/src/05g-source-health.js`：统一的源健康记录，三层模型（conn 不持久化 / data 持久化 / fresh 由自检写）。
- 蓝点跨刷新持久化：data 一层写入本地存储；`15-entry` 装载时不再清它（`resetSourceHealth()` → `resetConnHealth()`，只重置连接与新鲜度两层）。
- 蓝点 TTL 自愈：24 小时没有复现就自动清除并记一次自愈。
- 逐条升级阈值：单条解析失败不再点亮源级蓝点，改为先记计数。
- 升级条件：同一失败原因在 10 分钟内累计 ≥5 条，或连续 10 条全失败。
- `client/src/12d-health-probe.js`：自检调度，30 秒定时器按契约里的 `staleAfterMs` 判定每个源的新鲜度。
- 自检的两个例外：`staleAfterMs: null` 的推送源不判；从未上报过数据时间时不判。
- 停更阈值来源归拢到契约，此前四处硬编码：`lib/index.js` 的 `feedStaleMs`、`lib/wolfx-source.js` 的 preset。
- 另两处硬编码同样归拢：`15-entry` 传给 12-websocket 的 `staleAfterMs`、12c 对 SSE status 帧的直通。
- `JMA_STALE_MS` / `USGS_STALE_MS`：Host 侧停更阈值从内联数字提成导出常量。
- `scripts/check-contracts.mjs` + `scripts/lib/load-client.mjs` + `.github/workflows/contracts.yml`：CI 契约测试。
- 契约测试形态是端到端：拉真实数据交给解析器，上游改版会变成 `schema` / `value` 失败。
- 触发方式为 `workflow_dispatch` + `pull_request`，不设定时任务；`--offline` 用 `samples/` 快照跑；网络不可达不算失败。
- 推送源的在线契约测试改用两条 REST 端点取真实电文（`api.p2pquake.net/v2/history` 与 EMSC 的 FDSN query），不干等推送。
- 固定长度缓冲字节预算：`poller.js` 加 8MB 预算，超了从最旧的淘汰并计入 `dropped`，`truncated` 语义随之生效；预算装不下一条时仍留一条。

### Changed

- 回归断言 1041 → 1070。
- 三处既有断言按新语义重写（「schema 失败 → 进入 schema-error」现在要多喂几条）。
- 测试沙箱补上 `setInterval` / `clearInterval`（自检在 `apply` 里排定时器）。

## [0.5.2] - 2026-09-19

### Added

- `lib/nmc-source.js`：`nmc.cn` 预警源的 Host 半边。
- 列表一次返回当前全部生效预警（实测 241 条 / 65KB），Host 只把暴雨与地质灾害两类拆成逐条 entry。
- nmc 源参数：120 秒轮询、首次启动回看 30 分钟、停更阈值 3 小时（判据是列表里最新一条的发布时间）。
- 灾种与等级只认图标编码：`pic` 文件名是 `p` + 4 位灾种码 + 3 位等级码。
- 编码表：`0002`=暴雨、`0021`=地质灾害；`001`=红 `002`=橙 `003`=黄 `004`=蓝。
- 详情只对橙色及以上拉取，靠 `poller.js` 新增的逐条 `needDetail` 钩子实现。
- `lib/poller.js` 新增两个逐条钩子：`needDetail`（这一条要不要第二次请求）与 `detailTransform`（详情原文 → 入库载荷）。
- 既有四个源不受这两个钩子影响。
- `client/src/05f-nmc-parsers.js`：解析层，`kind` 复用 `'weather'`，`locator` 是 `'area'`。
- 行政区层级匹配（`06-matcher` 的 `matchCnAreaAlert` + `04-city-table` 的 `cnAreaOf`）：机构名 → 省 + 地级市 → 与用户关注的地级市比对。
- 匹配规则一：省名必须出现在机构名开头（避免省别名「海南」抢走青海省海南藏族自治州）。
- 匹配规则二：市级用 GeoNames 的全部中文候选做最长匹配（显示名可能是旧名）。
- 匹配规则三：市级找不到时，若该省下只有一个条目（直辖市 / 港澳）就用它。
- 市级归属未知时按省放行并说明原因；认不出省的国家级机构全国放行。
- `cn-areas.js` 新增 `aliases`：每条记录的其余中文候选，只参与匹配、不进 UI。
- 加别名后实测可定位率 88% → 95%（226/238）；产物 21KB → 27.8KB。
- 两个独立灾种开关 `disasters.cnRainstorm` / `cnGeology`（默认都开），共用一个 Host 源，任一开着就继续拉增量。
- severity 忠实映射（橙 → orange、红 → red），不做拔高；橙色预警不穿透静默时段。
- nmc 列表是「当前生效集合」，预警过期即消失，无「解除」标志，`cancelled` 恒为 false。
- `samples/nmc/` + `scripts/capture-nmc-fixtures.mjs`：真实样本（列表裁剪版 24 条 + 5 个详情页）与采集脚本。
- nmc 列表 fixture 存裁剪版但保持与真实响应同形（`data.page.list`）。

### Changed

- 回归断言 966 → 1039。

- `lib/index.js` 的 `pollers` 表新增 `nmc_alarm`；`/feed?source=nmc_alarm` 开箱可用。
- settings schema 新增两个灾种开关。

## [0.5.1] - 2026-09-19

### Changed

- 回归断言 946 → 966。
- `check-cn-e2e.mjs` 的读流器改为按「读到足够多 / 连续 1.5 秒没有新数据 / 整体超时」收工。
- `TROUBLESHOOTING.zh.md` 入口表去掉「0.5.0 补齐」标注。
- 三语 README 的 Known limitations 补上大陆源的四条限制。
- 设置页「② 中国大陆」补上「没有取消 / 最终报标志」的说明，三语 README 同步。
- `SOURCE_CONTRACTS.cenc_*` 的 `required` 与实现对齐，新增 `tolerant` 说明明确不判 schema 的字段范围。
- 代码卫生：`15-entry.js` 的 `__test` 导出去掉四个重复键；删掉只写不读的 `heartbeatSeen`。

### Fixed

- `cenc_eew` 的大陆预警 severity 恒 `red`（与日本 556 同口径），速报仍按震级分档（`severityOfMagnitude`）。
- `cenc_eqlist` 的中继停更自检（48 小时）：抽成 `refreshStale(t)`，由每个数据帧（含被 md5 短路的）与每 30 秒的例行检查共同推动。
- 默认（SSE）路径下「中继停更」不可见：`sync` 帧带上 `stale` / `dataTime`。
- 新增每 15 秒一帧的 `event: status`（兼作 keep-alive），把停更推给 Client，显示成中灰「数据已过期」。
- SSE → 轮询降级时不衔接读取位置：两侧共用同一个读取位置键（原为 `feedCursor.<id>` 与 `streamCursor.<id>` 两个键）。
- 整表「有条目却一条都解析不出来」不再与「空表」同形：只有真正的空表才算正常，有条目但全解析失败计入 `errors` / `schemaSkipped`。
- 周期 `status` 帧不再抹掉 `sync` 帧的告警（增量缺口 / Host 读取位置重置 / Host 侧该源未在运行）。
- 选了「强制轮询」再关掉灾种开关，重新打开时不再先白建一条 SSE，恢复时同样先看链路选择。
- 降级状态不再被轮询自己的「成功」覆盖：降级态下轮询侧的上报经过一层合并，状态保持「已降级」。
- 自动降级之后手动开关能救回来：切回「自动」时，「已经在轮询（自动降级来的）」也认下用户的选择。
- `markRead()` 不再把正在等待的重试间隔重置为 0：只有「因无人使用而主动断开」这一种情形才立刻重连。
- `pruneSeen()` 挂到数据帧上（此前从未被调用，`seenTtlMs` 成了假选项）。
- `geoEventKey` 把 `-0.0` 统一成 `0.0`，赤道 / 本初子午线两侧的同一场地震跨源归并不再失败。
- 空闲断开只计 `idleSkips`，不再写进 `lastError`。
- 事件记忆的过期清理按每条记录自己的窗口（旧记录没有该字段时退回本次窗口），并加可注入的时钟。
- SSE 侧读取位置在 Host 明确说 `reset` 时允许回退，其余情况仍只前进。

## [0.5.0] - 2026-09-19

### Added

- `client/src/12c-cn-stream.js`：大陆源的 Client 半边，消费 Host 的 SSE 推送，带读取位置持久化与断线补齐。
- SSE 自动降级：EventSource 不可用、连续 3 次拿不到第一条数据、或「连上但不推流」都会自动切到 `/feed?source=cenc_*` 轮询，并把降级这件事显示出来。
- 设置页「国家 / 地区」三级结构：① 日本（都道府县 → 市区町村）② 中国大陆（省 → 地级市 → 半径）③ 其他地区（坐标 + 半径）。
- ②③ 写进同一份 `watch.places`，共享 20 个上限。
- 三档半径语义 + 自定义数值：仅本地（约 30 km）/ 本市及周边（约 100 km，新建默认）/ 较大范围（约 300 km）。
- 半径下拉旁始终有可直接填的公里数输入框；既有配置里的 `radiusKm` 一律不动。
- `/areas` 随同一份响应下发中国行政区划表（`cnAreas`，约 21KB，不内联进 bundle）；Client 侧 `setCnAreas` 逐字段规整。
- `cnPlaceOf(省, 市, 半径)` 纯函数：级联的产物。
- `client/src/16-diag.js` + 设置页「诊断」区块：把 Client 侧实时状态压成一份 JSON。
- 快照内容：聚合状态、逐源状态与数据健康、增量计数、大陆源链路模式、关注点摘要、未响铃原因。
- 诊断快照纪律：只读、每个片段各自捕获异常、只放可 JSON 化的叶子字段；剪贴板不可用时显示成可手动复制的文本框；不含插件版本。
- `config.cnTransport`（自动 / 强制轮询）：改回「自动」会升回 SSE；自动降级不再升回。
- `lib/data/cn-areas.js` + `scripts/build-cn-areas.mjs`：中国行政区划表（省 / 特别行政区 34 → 地级行政区 384，带坐标）。
- 行政区划表来源 GeoNames（CC BY 4.0，含 TW/HK/MO dump），构建脚本带 `--check` 与 `--from`。
- `client/src/05e-cn-parsers.js`：大陆源解析器，`cenc_eew`（预警，坐标型）与 `cenc_eqlist`（速报，整表逐条）。
- 解析器实测坑：整表字段全是字符串而 EEW 是 number；整表里混有境外地震；两源 EventID 格式互不相干。
- `SOURCE_CONTRACTS` 追加 `cenc_eew` / `cenc_eqlist`，含四要素（必需字段、源时区、新鲜度阈值、empty 判据）。
- 速报的 48 小时新鲜度阈值作中继自检；预警本身稀疏，不给阈值。
- `lib/wolfx-source.js`：Wolfx 大陆源的 Host 半边——WS 常连、心跳超时监控、重试间隔递增、固定长度缓冲 + 读取位置、逐条去重。
- `lib/wolfx-source.js` 与 `poller.js` 接口同形（`start/stop/snapshot/stats/markRead`）。
- `/feed?source=cenc_eew|cenc_eqlist` 开箱可用。
- `/dsh-quake-alert/stream` SSE 路由：第一条数据 `event: sync` 给出读取位置与缓冲状态。
- 逐条 entry 带 `id:`，供浏览器重连时用 `Last-Event-ID` 补齐断线期间的消息。
- 事件年龄门槛：按发震时刻设 10 分钟 / 6 小时，被挡下的条目记为已见并计入 `ageSkipped`。
- `samples/cn/` + `scripts/capture-cn-fixtures.mjs`：真实抓取的 WS 推送形态 fixture 与可复现的抓取脚本。
- WS 的 query 指令是纯文本 `query_cenceew` / `query_cenceqlist`（发 JSON 不会有响应）。
- 中国标准时间常量：`CN_TZ_OFFSET` / `CN_TIME_RE` / `cnTimeToIso`。
- `issuedToDate` 同步认裸北京时间（`2026-09-18 20:50:23`）与 JST 两种格式。
- `thresholds.cnReportMagnitude`（默认 M4.5，`CN_REPORT_MAG_OPTIONS`）：速报用独立的震级门槛，预警与全球源共用 `globalMagnitude`。
- `DEFAULT_CFG`、`normalizeCfg`、Host schemastery schema、`matchPointAlert` 四处同步新增 `cnReportMagnitude`。
- `scripts/check-cn-e2e.mjs`：Host↔Client 端到端脚本（真实 Wolfx → `lib/wolfx-source` → `createStreamHandler`）。
- 其后接真实 HTTP SSE → SSE 读流器 → Client 解析契约；不进 CI。
- `scripts/check-wolfx-live.mjs`：大陆源连通性诊断脚本，用真实的 `lib/wolfx-source.js` 连真实 Wolfx。
- 输出：是否连得上 / query 指令能否取到数据 / 数据有多旧；已进 `TROUBLESHOOTING.zh.md` 的入口一览。

### Changed

- 回归用例 678 → 933。
- 新增用例覆盖 Host 侧建连超时监控、心跳超时、重试间隔递增、空闲断开、年龄门槛、md5 短路、SSE 第一条数据与断线补齐。
- 新增用例覆盖 Client 侧 SSE 生命周期、读取位置只前进、四类降级路径、灾种开关与链路开关双向切换、贯通主链、同事件不二次响铃、诊断快照只读与容错。
- 行政区划表用例为表驱动：全量结构不变量 + 已知城市坐标锚点 + 两处名称提取回归。
- 级联用例覆盖表规整 / 产物 / 越界拒绝；另有真实事件端到端用例。
- 真实事件用例：选「甘孜藏族自治州」+ 默认 100km 能命中实测的四川新龙县事件，选成都（约 380km 外）不会。
- 测试沙箱可注入极简 React（`createElement` / `useState` / `useEffect` / `useRef`）。
- 用它渲染一次设置页，断言三级区块、省份选项、半径预设与按钮出现在渲染树里。
- 三个 README 同步更新（功能列表 + 使用步骤重新编号）。

### Fixed

- `geoEventKey` 跨源归并因时区偏移而永久失效：新增 `minuteKeyOf()` 先换算到 UTC 再取分钟；时间不可解析时退回原串切片。
- `query` 指令名被拼错：实测指令是 `query_cenceew`（源 id 去掉下划线），改为按源显式写死指令名。
- `dataTime` 不再只在条目入缓冲时更新，改为取所有解析出的候选里最新的事件时刻。
- SSE 路由不再把「缺 `since`」当成「从 0 取」：空值显式排掉再看数字，缺失一律按 tail。
- 通知文案不再把主管机构硬编码成「气象厅」：按源给出机构名（気象庁 / EMSC / USGS / NOAA / 中国地震台网），认不出时用中性表述。
- 大陆源的通知标题不再套用日方产品名（気象庁叫「緊急地震速報」，CENC 叫「地震预警」）。
- 降级状态不再被自己的状态去重吃掉：改成由调用方给一个稳定的语义键（`fallback`）。
- 设置页的源列表归拢成 `SOURCE_ORDER` / `FEED_STAT_ORDER` / `STREAM_ORDER` 一处维护，并加结构性断言：每个有校验约定的源都必须在状态行里出现。
- `createStreamHandler` 漏注入跨站防护时不再静默失去防护，默认值改为真实实现。
- 设置页的免责声明不再硬编码日本气象厅，改为列出各源的主管机构。
- 行政区划中文名提取两处实错：① GeoNames 的 `雲林` 候选里有日文变体 `雲林県`；② `新北市` 的候选里有旧名 `臺灣省`。
- 名称优先级按层级分开（省级把 `省/自治区` 排最高，市级反过来把 `省` 压到最低），并直接排除日文字形候选。

## [0.4.2] - 2026-09-14

### Changed

- 解析契约补上「真实样本必须通过」的回归断言：真实 551 / 551 速报 / 556 / 552、VXWW50 / VXKO / VPWW53、EMSC 帧、USGS 全部 feature、NOAA CAP 必须全部判 `ok`。
- 用真实 live 数据验证：JMA feed 10 条电文、P2PQuake `551` ×10、USGS `2.5_day` 38 条 feature 全部 `ok`；`metadata.generated` 距当时 1 分钟（stale 阈值 30 分钟）。
- 解析前剥离 XML 注释，`block()` / `tag()` 不再把注释里的 `<Body>` / `<Notice>` / 「レベル４」当成真内容；样本注释已改写。
- 配置规整时加字段漂移断言（`normalizeCfg` 必须覆盖 `DEFAULT_CFG` 的每一个顶层与嵌套字段），并为 `normalizeCfg` 加非对象输入兜底。
- 删掉 `05-parser` 里因 `own()` 迁移遗留的孤立注释，修正 `normalizeCfg` 的错行格式。
- 回归断言 631 → 679。

### Fixed

- 气象「降级后再次升级」被永久静默：新增 `weakenEvent()`，降级电文把该事件键的强度下调（只在确实更低时下调），再次升级即可重新播报。
- 坐标型近似归并会吞掉同源的两次不同地震：`±2 分钟 + 50km` 归并限定为跨源，同源相隔 40 秒、相距 7km 的主震与紧邻余震不再被静默。
- 官署名碼取不到时事件键退化成空：退回 `<EditorialOffice>` 文本兜底，不留空。
- 震级上修的放行只在事件键逐字相同时成立：抽出 `findPrevEvent()`，`isEventRepeat` 用它做跨源近似，`isStrengthUpgrade` 用它做含同源近似。
- 真实的 JMA 解除电文被当成一次新发布：解除判定只看 Body 副本（Body 缺失时才退回全部），`levelOf` 的 `allInactive` 用同一口径。
- Notice 解析两处漏提升：半角 `*` 会粘在最后一个地区名上（只列一个市町村时唯一的 L4 城市不被提升），`[^〉]*` 会跨段错配级别；改为逐 token 去尾随标记、级别段限同行限长。
- 补上「［警戒レベル４相当情報の発表状況］」这种级别写在栏目名里的形态。
- `stopped` 打断后读取位置仍推进到整批末条：只用已处理到的那条推进，一条都没处理就原地不动。
- `timeIsImpossible(null)` 返回 true 导致时间缺失的 551 / USGS feature 被整条丢弃：缺失由 schema 判据负责。
- 「危険警報」的语义兜底把 Notice 的栏目名当真（「［危険警報・氾濫特別警報の発表状況］なし」）：要求它出现在 `〈…危険警報` 条目里。
- `pref===''` 一律放行：同一条消息里只要有区域能归到县，归不到的条目不参与县级过滤；只有整条消息都归不到县时才放行。
- 显式但不认识的 `codeType` 会退回按码位数猜：显式给出但不认识即判未知，位数兜底只服务于没给 `codeType` 的裸 `<Area>`。
- 解析契约对 551 的观测点过严：改为「存在则类型必须正确」，缺失容忍，单个 `points[]` 项缺 `scale` 不再让整条地震情报被判 schema 丢弃。
- 契约对「只有注意報」的电文判 empty 的语义描述写错：`SOURCE_CONTRACTS` 的 `empty` 说明改准，它还包括「只有注意報 / なし」的警报电文。
- WebSocket 的 `degraded` 状态不会恢复：只要有一条消息处理成功就复位并上报回 `open`。
- feed 源的 `degraded` 同样永久不恢复：判断只看增量，不再用进程内累计、永不归零的 `errors` / `detailDropped`。
- `stale`（中灰「数据已过期」）从来没有被上报过：「源在响应但数据是旧的」显示为中灰。
- 状态上报的去重键含单调计数，每 15 秒一轮都判定为变化、整页重渲：键只取状态，数字由设置页自己的 5 秒时钟读快照。
- 插件停用（abort）被上报成 `unreachable` + 计一次失败 + 打一条失败日志：`stopped` 时直接返回，不计不报。
- 打开设置页会创建 AudioContext：`audioState()` 未创建时按「未解锁」回答，不为查询而创建。
- `disabled` 状态未显示为空心圆点：disabled 改用描边圆点。
- 插件重载后数据健康记录残留：上一代留下的 `schema-error` 与 `store.clearSources()` 一起清掉。
- `restart()` 不重新绑定 `visibilitychange`：stop 之后再 restart 的 socket 恢复可见时会重置 stale 计时。
- `empty` 不清理 `schema-error`：empty 也视为「结构是好的」，清掉异常并恢复 `open`，蓝点与重试按钮不再挂到下一次成功解析。
- JMA / NOAA 的 Atom 解析对拦截页返回 `[]`：正常空 feed → `[]`（empty）；HTML 拦截页或被截断（有 `<entry` 没有 `</entry>`）→ 抛错。
- 迁移标记先写入本地存储、Host 写入后失败导致本地配置被 Host 空值覆盖：等 `scope.mutate()` 成功之后再落标记（`pushCfgToHost` 返回 pending），失败就不写、下次再试。
- 历史详情里旧数据（无 `code`）的全球地震仍显示成「code 551」：数值 code 走 `/^\d{3}$/` 分支，无 code 时按 `id` 前缀（`emsc:` / `usgs:` / `noaa:`）认来源。
- `/feed` 与 `/areas` 的 `writeHead` / `end` 移出了 try，客户端中途断开时 `end()` 抛 `ERR_STREAM_WRITE_AFTER_END`：整段移入 try 内，且先序列化再发头。

## [0.4.1] - 2026-09-14

### Added

- 新增解析契约 `{ ok:true, alert } | { ok:false, kind:'empty'|'schema'|'value', detail }`，为五个源各自实现包装：P2PQuake 551/552/556、JMA 电文、EMSC、USGS、NOAA CAP。
- 三类失败语义：`empty`（源正常但当前无相关数据，不计失败）/ `schema`（结构不符）/ `value`（结构对但值客观不可能）。
- 新增 `SOURCE_CONTRACTS`：每源的必需字段与类型（schema 判据）、源时区、新鲜度阈值（stale 判据）、empty 判据。
- 健康状态落地：解析失败进入 `schema-error`（蓝点，与「网络不可达」的红点分开）、同一失败原因只记一次日志、解析恢复后自动回到正常、设置页提供手动重试。
- 源时区：P2PQuake 的裸 JST 时间（`2026/09/07 23:25:14`）统一转成带 `+09:00` 的 ISO 8601，UI 按本地时区渲染，旧历史数据按 JST 解释。
- 上游停更检测：JMA feed 的 `<updated>`、USGS 的 `metadata.generated` 超出阈值即标 stale。
- 新增 `TROUBLESHOOTING.zh.md`：按「触发条件 → 可执行的检查 → 结果对应的处置」组织的排查文档；`README.zh.md` 加入口句。

### Changed

- 汇总型 JMA 电文的事件键不再含发布时刻；`気象警報・注意報（Ｒ０６）` 纳入汇总族；`region` 增加 `level` 字段。
- 气象灾害的事件去重窗口 10 分钟 → 3 小时。
- 跨标签页标记为已处理的 TTL 5 秒 → 10 分钟。
- `applyCfg` 也走 `normalizeCfg`；`freshCfg` 由 `DEFAULT_CFG` 深拷贝派生；settings 订阅随 fiber 释放；「已迁移到 Host」标记写入本地存储。
- 生命周期收口：`store.clearSources()` 真正被调用、`activeClient` 随停用置空、跨标签页通道的建立与关闭都在同一个 effect 内、切换数据源的 80ms 延时随组件卸载清理。
- 「清空记录」广播给其它标签页。
- 历史详情可键盘操作（`role` / `tabIndex` / 回车与空格）；「类型」行按 `alert.code` 标注来源。
- 设置页「源状态」拆成独立组件；提示音未解锁时显式提示（页面可见时只用页内 toast）。
- `scripts/check-imports.mjs` 的未声明赋值检查去掉 `owner.has` 兜底。
- 回归断言 561 → 631；`samples/` 新增 `jma-vpww53-hyogo-danger-20260914.xml`。

### Fixed

- JMA 総合副本（VPWW53/54）里的「危険警報（=L4）」被读成 L3：`levelOf()` 读 `<Body><Notice>` 并纳入级别判定；`<Area>` 匹配放宽（带属性或只有 Name 的条目不再被静默丢弃）。
- USGS / EMSC 的修订版永远不会再提醒：单级源的去重键改为 `id@updated`，同 id 的强度升级穿透消息级去重（`isStrengthUpgrade`）。
- 详情电文抓取失败即永久放弃：改为有界重试（默认最多 3 次），超过上限才放弃并计入 `detailDropped`。
- 首次启动容差不分源：改为按源配置回看窗口（USGS 6 小时 / NOAA 24 小时，JMA 仍 2 分钟）。
- JMA 解除电文与发布电文永远算不出同一个键：汇总型事件键改为「灾种 + 編集官署名コード」，取消匹配窗口与 `alertedEvents` 保留期对齐为 24 小时，解除时清掉事件键。
- 552 海啸的事件键恒为空：改用「预报区名集合」做事件键，去掉 `cancelKeyOf` 的 kind 兜底。
- 未识别归属县的区域被直接否决（`regionInWatch`）：`pref` 为空时放行。
- 全球点型地震命中后 severity 恒为 `info`：坐标型地震直接使用解析层按震级判定的 severity。
- 坐标缺失的全球警报被彻底静默：这类「无法判定」进历史并写明原因。
- 同一条电文里不同市町村的级别被拉平：`region` 各自携带级别，是否播报看命中地区自己的级别。
- NOAA 的「Tsunami Information」也会响铃：全球海啸共用 `tsunamiGrade`（Information=0 / Advisory・Watch=2 / Warning=3），`alert` 的多 `<area><circle>` 全部纳入匹配。
- 字符串类型的震级被静默丢成 null：`firstNumber` 接受数字字符串。
- WebSocket 的 `onmessage` 用一个空 catch 包住整条主链：只包 `JSON.parse`，主链异常计入连续失败次数并上报 `degraded`。
- 轮询链路不参与状态聚合：feed 客户端按「只在变化时上报」送进 store。
- EMSC 关掉了「久无数据」检测：改为 3 小时阈值，页面从冻结中恢复时重置计时。
- Host 侧健康计数无人消费：Client 每轮都带 `stats=1` 并显示 Host 的失败数 / 放弃数 / 上游停更；三个轮询器补 `onError` 日志。
- `/feed` 无鉴权且有 markRead 副作用：拒绝 `sec-fetch-site: cross-site` 的请求。
- 未知 `source` 静默退回 jma：改为显式 400，Client 也校验回显的 `source`。
- XML 正则的二次方回溯：每处提取前加 `indexOf` 早退，响应体上限从 2MB 收到 512KB，并在 `res.text()` 之前先看 `content-length`。
- feed 客户端没有可取消的在途请求：自持 AbortController，`stop()` 时中止。
- 新增 `schema-error` / `stale` 状态：上游改版或停更不再与「没有新闻」同形。

## [0.4.0] - 2026-09-12

### Added

- 全球化第一阶段新增三个数据源：EMSC（WebSocket 实时全球地震，Client 直连）、USGS（GeoJSON 摘要，Host 单点轮询）、NOAA tsunami.gov（CAP 1.2 海啸电文，Host 单点轮询）。
- `Alert` 增加坐标模型：`source` / `locator`（'area' | 'point'）/ `geo{lat,lon,depthKm}` / `magnitude` / `magType`。
- 新增「全球关注点」（坐标 + 半径，上限 20 个），坐标型警报按 Haversine 距离判定命中。
- 新增阈值 `thresholds.globalMagnitude`（默认 M4.5），与日本震度互为独立旋钮。
- 设置页新增「全球关注点」区块（含「用当前位置」按钮）与全球震级阈值。
- 多源连接状态聚合：任一链路异常即不显示为「一切正常」，悬停详情逐个列出各源。
- 跨源同事件归并：EMSC 与 USGS 对同一场地震按「发震时刻(分) + 震中(0.1°)」算出同一事件键。
- 设置页「发送测试全球警报（轮换场景）」：本地构造 EMSC / USGS / NOAA 三种源格式原文，走真实解析器与匹配引擎，不发网络请求；四个场景覆盖三个源，含一条落在半径之外的；结果按实际播报情况如实提示。
- 设置页「全球源状态」：EMSC 连接状态 + 三个轮询源各自的增量条数、失败次数与最近拉取时间。

### Changed

- Host 侧 `/feed` 支持 `?source=jma|usgs|noaa` 分派；三个源各有独立的固定长度缓冲与读取位置（默认 jma，旧 Client 兼容）。
- `lib/poller.js` 支持注入 feed 解析器与单级源（USGS 一次请求即含全部字段，不拉详情）。
- 回归断言 439 → 561；`samples/` 新增 4 条真实特别警报电文与 4 个全球源样本。

### Fixed

- 最高级「特別警報」漏报：`levelOf()` 补 Kind 名称的语义映射（特別警報→5、危険警報→4、警報→3），并给「気象特別警報報知」加标题兜底。
- 同一次发布的多份格式副本各播报一次：汇总型电文的事件键改用「灾种 + 发布时刻(分) + 府县码」内容指纹。
- 全球源在未配置关注点时的「未命中」写入历史：不再写入。
- `scripts/check-imports.mjs` 误报：对象字面量的键（`{ name: ... }`）被当成模块引用。
- 海啸被全球震级阈值误伤：`thresholds.globalMagnitude` 只作用于地震，海啸严重性由它自己的等级（警报 / 注意报 / 信息）决定。
- 测试消息连点两次不会播报第二次：测试消息改用带毫秒的事件键。

## [0.3.3] - 2026-09-12

### Added

- WebSocket 建连超时监控：建连 15 秒仍无 `onopen` / `onclose` 时关闭该连接并按逐次延长的间隔重连（`connectTimeoutMs` 可配置，置 0 关闭）。

### Changed

- README 三语 Known limitations 增加一条：多个 DSH 页面共享同一个气象电文读取位置。
- 回归断言 433 → 439。

## [0.3.2] - 2026-09-11

### Changed

- 读取位置：写入本地存储并持久化；首次用 `tail` 只对齐位置；Host 重启自愈；起点改为跨进程单调的时间戳。
- `/feed`：`since` 缺失或非法（含空串与纯空白）按 `tail` 处理；单次上限 50 条并标记 `more`。
- `/areas`：`cache-control` 改为 `no-cache`。
- 显示：气象条目标注「JMA 电文」；severity 配色补 `yellow`；灾种配色补 `weather`。
- 回归断言 346 → 433。

### Fixed

- `/areas` 未下发河川予報区域表，导致指定河川洪水予報跨县误报、市级收窄失效。
- 河川区域表与市区町村表的假名写法不一致（8 例），导致反查失败误报、市级比对漏报。
- 刷新页面重放 Host 缓冲内的历史警报（读取位置未持久化）。
- Host 重启后 Client 读取位置不回退，导致气象电文静默失联。
- 首次启动丢弃进程启动后发布的电文。
- 外部请求无超时；响应体无大小上限。
- WebSocket 连接假死不重连（状态点仍显示已连接）。
- 气象条目在历史详情里被标成「code 551」；震度4 命中显示为信息蓝；气象条目落灰色兜底。
- 跨标签页配置同步只在设置页打开时生效。
- 音频节点播完不 `disconnect()`；`loadCityTable()` 未纳入 effect（停用后仍会写配置）。

## [0.3.1] - 2026-09-11

### Added

- 设置页「发送测试气象警报（轮换场景）」按钮：本地构造 5 种电文走完整链路，零网络请求。
- 气象警报独立音色（下行三音 + triangle），设置页新增「试听气象音」。

### Changed

- 回归断言 320 → 346。

### Fixed

- 「静默提示」在 L4 已播报后仍显示「未达 L4，未播报」。
- 提示里的地区名重复（「東京都東京都」）。
- 测试提示写死「应看到提示音与弹窗」，未按实际结果生成。
- `check-imports.mjs` 的词法剥离误报。

## [0.3.0] - 2026-09-11

### Added

- 气象灾害预警（JMA 防災情報XML）：Host 侧轮询 Atom feed 并两级抓取（feed 列表 → 详情电文），Client 侧解析。
- 覆盖 `VXWW50` 土砂災害警戒情報、`VXKO` 指定河川洪水予報、`VPWW55/56/57` 気象警報・注意報 等。
- 播报边界固定为警戒レベル4 以上（级别取自电文，不推算）；L1〜L3 仍解析并入历史，L3 命中只在侧边栏提示。
- 河川予報区域表 `lib/data/river-areas.js`（338 区域 / 884 市町村 / 1,567 区域×市町村对），以 12 位区域码为主键。
- 零依赖 zip 读取器 `scripts/lib/zip.mjs`。
- 设置页「灾害类型」小节（地震 / 海啸 / 气象灾害三个开关）。
- 构建脚本 `pnpm build:areas`。

### Changed

- 外部请求只由 Host 发起；10 分钟内无增量读取则跳过轮询。
- 首次启动不回放历史；详情拉取失败的 entry 不再重试。
- `handleRaw` 拆出 `handleAlert`，两条数据源汇到同一处。
- 静默时段的红色穿透说明补全（震度6弱以上的地震与 L4 以上的气象警报同样穿透）。
- 回归断言 236 → 320；`samples/` 新增 5 条気象庁官方样本电文。

## [0.2.2] - 2026-09-10

### Changed

- `scripts/check-imports.mjs` 增加「赋值给本文件未声明、也未 import 的名字」检查。
- 回归断言 230 → 236。
- README 三语同步修正过时描述。

### Fixed

- 跨标签页配置同步失效（0.2.1 拆分的回归）。
- 音量草稿在机器级持久化下仍会丢改动。

## [0.2.1] - 2026-09-10

### Changed

- 客户端源码模块化：`client/client.js` 拆成 `client/src/` 下 15 个标准 ESM 模块，由 rollup 打包回单文件 bundle。
- 新增 `scripts/check-imports.mjs`（跨模块引用检查）；构建脚本把循环依赖升级为构建失败。
- `package.json` 增加 `build` / `check` / `test` 脚本与 rollup devDependency。

## [0.2.0] - 2026-09-10

### Added

- 静默时段：按浏览器本地时间判定，开始晚于结束表示跨午夜；红色等级默认穿透、可关闭。
- 机器级持久化：Host 注册 `quake-alert` settings namespace，配置存入机器的 `settings.yaml`；localStorage 保留为镜像与回退，首次启用时迁移已有本地配置。
- 市区町村级匹配：`/areas` 提供 47 都道府县 / 1,917 个市町村，设置页按县搜索多选；观测点 addr 先对齐到市町村再比对。
- 解析 551 的 `pref` 简写（「京都」→「京都府」）。
- 运行期新增依赖 `@deepseek-ai/schemastery`。

### Changed

- 回归断言 130 → 230。

### Fixed

- EEW 提醒颜色被降级（0.1.3 的回归）→ 恢复恒为红色。
- 音量草稿丢失；「试听」按钮改用当前草稿值。
- 侧边栏状态圆点补 `role="status"` 与 `aria-label`。

## [0.1.3] - 2026-09-10

### Added

- 取消 / 解除提醒：此前提醒过的事件被取消 / 解除时补一条下行音。
- 侧边栏连接状态指示（绿 / 黄 / 红 + 悬停详情）。
- 音效新增 `cancel`。

### Changed

- 音量滑块改为本地草稿 + 300ms 防抖写入本地存储。
- 设置页监听 `storage` 事件，其它标签页改配置后本页立即同步。
- 回归断言 105 → 130。

### Fixed

- 提醒里看不到震度（551 / 556 的 headline 补上震度）。
- 配置版本变化会清空用户配置。
- 历史记录字段被污染会使设置页崩溃。
- 前台同时弹 toast 与系统通知。
- 取消消息静默（用户不知道已发出的警报作废）。
- `client.start()` 在 `ctx.effect` 之外，注册失败会留下没有清理器的连接。
- 去重窗口在系统时间回拨时失效；toast 颜色按全日本最大震度。

## [0.1.2] - 2026-09-09

### Changed

- 清理死代码与未用字段（`unique()`、`prefOfName()`、Alert 的 `second`）。
- `tests/` 与 `samples/` 纳入仓库。
- README 提供三语版本；`package.json` 的 `files` 补上 `CHANGELOG.md` 与两份 README 译文。

### Fixed

- EEW 未携带区域数据时的提示措辞错误。

## [0.1.1] - 2026-09-09

### Added

- 事件级去重：同一地震的多次发布只响一次，震度升级时才再次提醒。
- 跨标签页去重：`BroadcastChannel` 协商，同一条预警只由一个标签页播报。

### Changed

- 回归测试 33 → 105 项。
- README 修正 EEW 延迟说法（实测约 811ms，改为「数百毫秒级」）。

### Fixed

- 关注特定都道府县时海啸 / EEW 静默漏报：区域名对齐改为「显式区域表 + 47 县名按长度降序前缀匹配 + 府県予報区名兜底」三层策略（修复前 16 个都道府县受影响）。
- localStorage 被污染导致插件整体加载失败：读入数据一律做类型校验。
- 音量 0 被显示成 70%。
- 「最近预警」写入本地存储从 20 条提升到 30 条。
- 重连计数从「第 0 次」改为「第 1 次」；`restart()` 重置重试间隔计数。
- 「测试系统通知」在权限被拒 / 不支持时无反馈。
- 震源情报的未命中原因不明确。
- `notificationSupported()` 的构造函数判断（`typeof === 'function'`）。
- 删除死代码 `alert.kind !== 'other'` 与 Host 半边空的 `ctx.on('dispose')`。
- toast 的 z-index 由 2147483000 降为 2000。

## [0.1.0] - 2026-09-08

### Added

- P2PQuake WebSocket 实时推送（`wss://api.p2pquake.net/v2/ws`）。
- 断线自动重连（重连间隔逐次延长，1s → 60s 封顶）。
- 解析器：code 551 / 556 / 552 → 统一 Alert；556 的 `pref` 简写统一为都道府县全称。
- 匹配引擎：关注都道府县多选（默认全日本）× 分级阈值 × 消息 id 去重。
- 通知：Web Audio 合成三种灾害音色 + 音量调节；前台 toast、后台系统通知。
- 设置页（设置 → 灾害预警）：关注地区、阈值、声音、系统通知、试听 / 测试、数据源切换。
- 数据源切换：正式源与沙箱源（回放 2023 年历史，约 30 秒/条）。
- 历史记录：最近 30 条（含未达阈值的灰色条目），可展开、可清空。
- 配置持久化：localStorage（`dsh.quakeAlert.v1`），带版本字段。
- 回归测试 `tests/sync-test.cjs`。

### Fixed

- 设置页区块辅助函数只渲染首个子元素。
- 深色主题下原生下拉框选项难以辨识。
- WebSocket 推送的 `_id` 未被识别，历史记录恒为 1 条。
- 配置写入时机不确定。
- 最近预警记录只展示单条、无展开反馈。
