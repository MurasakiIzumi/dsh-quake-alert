# samples — P2PQuake / 気象庁 真实消息样本库

本目录存放六类真实消息样本，用于开发、模拟回放与单元测试：

- **P2PQuake JSON**（地震 / EEW / 海啸）：实时链路与匹配回归
- **気象庁防災情報XML**（泥石流 / 洪水 / 大雨 / 高潮）：0.3.0 起的气象警报链路
- **特别警报电文**（旧格式 / 报知）：0.4.0 修复最高级警报漏报的回归 fixture
- **全球源样本**（EMSC / USGS / NOAA）：0.4.0 全球化链路的回归 fixture
- **大陆地震源样本**（Wolfx `cenc_eew` / `cenc_eqlist`，`cn/`）：0.5.0 大陆链路的回归 fixture
- **大陆气象预警样本**（中央气象台 nmc.cn，`nmc/`）：0.5.2 暴雨 / 地质灾害链路的回归 fixture

> 数据来自 P2PQuake 公开 API 与気象庁公开信息，均为公开信息，仅用于本项目的开发与回归测试。
> 気象庁のコンテンツは政府標準利用規約に準拠（出典明記のうえ利用可）。

## P2PQuake JSON

数据来源与采集时间：

- `quake-kumamoto-detailscale-20260907.json` — code 551（地震情報・DetailScale 各地の震度），取自 `/history?codes=551`，2026-09-07 熊本県熊本地方 M3.8，最大震度3。points 为抽样（原消息 80+ 观测点）。
- `quake-kumamoto-scaleprompt-20260907.json` — code 551（地震情報・ScalePrompt 震度速報），同一次地震的速报版，`isArea: true`，观测点是区域名（"熊本県天草・芦北"）。
- `eew-ibaraki-m6.7-20260823.json` — code 556（緊急地震速報（警報）），取自 `/history?codes=556`，2026-08-23 茨城県南部 M6.7，预测震度 5 強（areas 全量保留）。
- `tsunami-fukushima-spec-example.json` — code 552（津波予報），规格文档 OpenAPI example（2019-06-18 山形県沖地震），因近期无真实海啸情报（`/history?codes=552` 返回空），故采用规格示例。
- `ws-sandbox-20230905-fukushima.json` — code 551，WebSocket 沙箱（`wss://api-realtime-sandbox.p2pquake.net/v2/ws`）实测收到的 2023-09-05 福島県沖 M4.0 真实推送（沙箱每约 30 秒回放一条 2023 年历史消息）。

字段说明（完整定义见 https://github.com/p2pquake/epsp-specifications/blob/master/json-api-v2.yaml ）：

- 551：`earthquake.hypocenter`（震源 name/lat/lng/depth/magnitude）、`earthquake.maxScale`（最大震度）、`points[]`（`pref` 都道府县全称 / `addr` 观测点或区域名 / `scale` / `isArea`）。
- 556：`earthquake.hypocenter`（震央）、`areas[]`（`pref` 为**简写**如"茨城"、"東京"，`name` 为完整区域名如"茨城県南部"、"東京都２３区"，`scaleFrom/scaleTo` 预测震度区间）、`cancelled`（取消）。
- 552：`areas[]`（`grade`: MajorWarning/Warning/Watch、`name` 津波予報区、`maxHeight`）。

注意：551 的 `pref` 是全称（茨城県），556 的 `pref` 是简写（茨城）——地点匹配时 556 应使用 `areas[].name` 而非 `pref`。

## 気象庁防災情報XML（0.3.0）

全部取自気象庁官方样本包 `jmaxml_20260723_Samples.zip`（https://xml.kishou.go.jp/tec_material.html ），
是官方为电文规格提供的**样本电文**（含匿名化的 `○○川` 之类占位名），不是实况抓取。

| 文件 | 电文 | 灾害 | 关注点 |
|---|---|---|---|
| `jma-vxww50-landslide.xml` | `VXWW50` 土砂災害警戒情報 | 泥石流 | 电文本身即**警戒レベル4 相当**（级别写在 Headline 的「警戒レベル４相当情報［土砂災害］」里）；Kind 只有 警戒/解除/なし；区域**只有市町村** |
| `jma-vxko-flood.xml` | `VXKO` 指定河川洪水予報 | 洪水 | 级别写在 Headline 主文「【警戒レベル２相当情報［洪水］】」；Kind 名称是 氾濫注意情報/氾濫警報/氾濫危険情報/氾濫発生情報；区域是**河川予報区域**（12 位码，需经 `lib/data/river-areas.js` 映射到市町村） |
| `jma-vpww56-landslide.xml` | `VPWW56` 気象警報・注意報（Ｒ０６）（土砂） | 泥石流 | 级别写在 `<Kind><Name>`（`レベル４土砂災害危険警報`）；区域含府県予報区・細分区域与市町村 |
| `jma-vpww55-heavyrain.xml` | `VPWW55` 気象警報・注意報（Ｒ０６）（大雨） | 大雨 / 浸水 | 同上（`レベル４大雨危険警報`） |
| `jma-vpww57-stormsurge.xml` | `VPWW57` 気象警報・注意報（Ｒ０６）（高潮） | 高潮 | **VPWW57 是高潮不是洪水**（曾误以为 55/56/57 = 大雨/土砂/洪水） |

解析要点（实现见 `client/src/05b-jma-parser.js`）：

- **判县优先用区域码前两位**（`宗谷北部=011011` → 北海道、`北九州市=4010000` → 福岡県），名称反查只作兜底——名称有 25 例同名跨县，且已改制的旧名会认到别的县。
- 気象庁在 `Body` 的 `<Warning>` 里会把区域写成**裸 `<Area>`**（不带 `<Areas codeType="…">` 包裹），且市町村清单常只在 `Head` 的 `<Information>` 里——两处都要取，否则会"解析成功但区域为空"。
- 区域码位数：市町村 7 位 / 府県予報区・細分区域 6 位 / 河川予報区域 12 位。

## 特别警报电文（0.4.0）

2026-09-07 **東京都「大雨特別警報」**——气象厅最高级别的气象警报。同一次发布在 feed 里同时存在
三份**格式副本**，这正是当时漏报的根因：旧格式的 Kind 名称不带「レベルＮ」字样，被 `levelOf()`
判为"与预警无关"而整条丢弃（而同一时刻的 R06 电文只有「その他注意報 / 暴風 / 波浪」，不含这条警报）。

| 文件 | 电文 | Kind.Name | 说明 |
|---|---|---|---|
| `jma-vpww53-tokyo-special-20260907.xml` | 気象特別警報・警報・注意報（VPWW53） | 大雨特別警報 / 大雨警報 / 大雨注意報 … | 级别必须按名称语义映射 |
| `jma-vpww54-tokyo-special-20260907.xml` | 気象警報・注意報（Ｈ２７）（VPWW54） | 同上 | 与 VPWW53 内容重复的另一份格式 |
| `jma-vpno50-tokyo-special-20260907.xml` | 気象特別警報報知（VPNO50） | 大雨特別警報 | 气象厅为特别警报专发的最高优先级报知 |
| `jma-vpno50-tokyo-cancel-20260907.xml` | 気象特別警報報知（VPNO50） | 解除 | 同日 19:01 的解除报知，Kind 只有「解除」 |

回归断言覆盖：三份副本必须算出**同一个事件键**（否则同一条警报连响三次）、解除报知不能被
「気象特別警報報知」的标题兜底误抬成 L5、旧格式的「大雨警報」应按 L3 解析、旧格式的注意報
仍不产生 Alert（同一份注意報有 VPWW53 / Ｈ２７ 两份副本，抬升会把历史刷屏）。

## 危険警報与逐区级别（0.4.1）

`jma-vpww53-hyogo-danger-20260914.xml` —— 精简自 2026-09-14 20:31 JST 兵庫県（神戸地方気象台）的
VPWW53 **live 电文**（原电文约 41KB，只保留三个市町村的 Item，Control / Head / Headline /
Body Notice 与 Warning 的结构与原文一致）。它锁定两个真实缺陷：

- **级别只在 `<Body><Notice>` 里**：総合副本的 `<Kind><Name>` 只写灾种名（「大雨警報」），
  级别写在 `〈レベル４大雨危険警報〉姫路市　たつの市　多可町＊` —— 不读 Notice 时整条被判成 L3，
  一条真实存在的 L4 危険警報完全不播报。
- **同一电文里不同市町村的级别不同**（姫路市 L4 / 相生市 L3 / 西脇市 L2）—— 拿电文最大值当闸门，
  会把只到 L2 的西脇市播成「警戒レベル4（避难指示级）」。

回归断言还覆盖事件键 = `jma:summary:大雨:280000`（灾种 + 編集官署名コード，**不含发布时刻**；
含时刻的话解除电文永远算不出与发布相同的键，解除提醒会静默丢失）。

## 全球源样本（0.4.0）

`global/` 子目录，全部为 2026-09-12 实测抓取（非构造）：

| 文件 | 来源 | 解析要点 |
|---|---|---|
| `global/emsc-ws-sample.json` | EMSC `standing_order` WebSocket 实收 | 顶层 `{action, data}`，data 是 GeoJSON **Feature**（不是 FeatureCollection）；区域字段是 `flynn_region`（**没有** `region`）；`time` 是 ISO 字符串；`lat/lon` 在 properties 里 |
| `global/usgs-all-hour.geojson` | USGS `all_hour.geojson` | FeatureCollection；`geometry.coordinates = [经度, 纬度, 深度km]`；`time/updated` 是 epoch 毫秒；实测 11 条，`alert` 全为 null |
| `global/noaa-pheb-atom.xml` | NOAA `tsunami.gov/events/xml/PHEBAtom.xml` | 事件列表；`<id>` 是 `urn:uuid`（**不是**详情地址），CAP 详情地址在 `<link rel="related" title="CapXML document" href>` |
| `global/noaa-pheb-cap.xml` | NOAA `PHEBCAP.xml` | CAP 1.2；震中在 `alert > info > area > circle`（`"纬,经 半径"`），震级与震源另有 `info > parameter`（`EventPreliminaryMagnitude` / `EventLatLon`） |

> 注意：`noaa-pheb-atom.xml` 抓到的是 2026-08-22 的一次事件（Tsunami Information），**不是**
> 抓取时刻的最新海啸。用它做 fixture 时不要假设"当前最新"。

## 大陆气象预警样本（0.5.2）

`samples/nmc/` 子目录，2026-09-19 实测抓取（非构造），采集脚本 `node scripts/capture-nmc-fixtures.mjs`：

| 文件 | 来源 | 说明 |
|---|---|---|
| `nmc/alarm-list.json` | `https://www.nmc.cn/rest/findAlarm?pageNo=1&pageSize=500` | **裁剪版**：完整响应 241 条里只留本插件接的暴雨 + 地质灾害（24 条）。结构与真实响应**同形**（`data.page.list`），只是 list 变短——解析器读的就是这个路径，换一套结构测的就不是线上那条路径了 |
| `nmc/detail-<灾种>-<等级>.html` | `https://www.nmc.cn/publish/alarm/<alertid>.html` | 详情页**完整** HTML（约 46KB）。正文在 `#alarmtext` 里，由 `lib/nmc-source.js` 的 `extractAlarmText` 提取；裁剪就验不到真实的页面结构 |

解析要点（实现见 `lib/nmc-source.js` 与 `client/src/05f-nmc-parsers.js`）：

- 列表每条只有 `alertid` / `issuetime` / `title` / `url` / `pic` 五个字段——**没有正文、没有区划代码、没有坐标**。所以匹配只能靠 `title` 里的机构名，正文要另拉详情页。
- `pic` 的文件名是**程序契约**：`p` + 4 位灾种码 + 3 位等级码。实测 `0002`=暴雨、`0021`=地质灾害、`0012`=雷电、`0007`=大风、`0003`=高温、`0005`=大雾、`0004`=寒潮、`0011`=道路结冰、`0015`=雷雨大风、`0000`=其它；等级 `001`=红 `002`=橙 `003`=黄 `004`=蓝。灾种与等级**只认编码，不认中文**（`title` 的措辞会随上游改，样本里"预警信号"与"预警"两种都有）。
- `issuetime` 是裸北京时间 `2026/09/19 12:31`（**斜杠**分隔、无秒）——与 Wolfx 的 `2026-09-18 20:50:23` 又是一种写法，三种源三种格式（DESIGN 4.5 记过这个坑）。
- `alertid` 形如 `53072441600000_20260919030245`，**前 6 位是行政区划代码**（530724 = 云南省丽江市宁蒗彝族自治县）。本版本不用它（用户的关注点表来自 GeoNames，两边没有共同主键），但它的存在说明"层级"在这条链路上是可靠的：实测 238 条里 0 条解析不出省份。
- 列表是**当前生效集合**、不是事件流：实测覆盖约 24 小时，**没有"解除"电文**，预警过期即从列表消失。
- 列表随预警发布 / 过期而变，所以 fixture 的 diff 天然是噪音，别当成"回归失败"。要固定的是**字段形态**，那由 `tests/sync-test.cjs` 的断言来钉。

## 海外气象源样本（0.6.0）

`samples/nws/` 与 `samples/eccc/` 两个子目录，2026-09-22 实测抓取（非构造），
采集脚本 `node scripts/capture-overseas-fixtures.mjs`：

| 文件 | 来源 | 说明 |
|---|---|---|
| `nws/nws-flood-alerts.geojson` | `https://api.weather.gov/alerts/active?event=<8 类洪水>` | **裁剪版**：74 条里每个 event 类型各留 1 条（7 类）。结构与真实响应**同形**（`{type:'FeatureCollection', features:[…]}`），properties 与 geometry 都**完整保留**——正文（`description` / `instruction`）是解析目标，裁掉就测不到 |
| `nws/nws-point-alerts.geojson` | 同日 `?point=29.7604,-95.3698` | 运行时真正用的形态（按点查询）。5KB 一条，正好说明"为什么用 point 而不是全量"（全量 1.67MB）。**内容是 `Air Quality Alert`**——即"按点查到的、不在本插件白名单内的真实响应"，用来钉白名单的**否定方向**（判 `empty` 而不是 schema / 放行） |
| `eccc/eccc-alerts.geojson` | `https://api.weather.gc.ca/collections/weather-alerts/items?f=json&limit=200` | **裁剪版**：每种 `alert_code` 各留 1 条（当前季节只有 FTA / WDW / CFW），**保留 Polygon**——它 100% 带几何，是匹配的输入 |
| `nws/nws-event-chain.geojson` | 同一次洪水预警的**连续两版**（`/alerts/active` 取一条 Update，再按它的 `references` 拉上一版） | 0.6.1 新增。存在的理由：0.6.0 的算法是用"同一 serial 递增 version"的**合成**样本验证的，而实测的链是**逐版串联**的——合成样本永远发现不了那件事。两版的 identifier / sent 都不同，**VTEC 追踪号相同** |
| `nws/nws-cancel-chain.geojson` | 一条 `messageType=Cancel` + 它 `references` 的那条警报 | 0.6.1 新增。两者的 VTEC 只有 ACTION 段不同（`EXT` → `CAN`）、CAP identifier 完全不同：这是"用 VTEC 做事件键"才能匹配上"此前播报的警报已作废"的证据 |

解析要点（实现见 `client/src/05h-overseas-parsers.js` 与 `12e-overseas-poll.js`）：

- **NWS 的白名单按 `properties.event` 精确匹配**（8 类洪水预警）。**不能按 severity 分档**：
  实测 `Flood Watch` 的 severity 也是 `Severe`（与 `Flood Warning` 同级），
  而 `Coastal Flood Watch` 是 `Moderate`——severity 区分不了"警告"与"警戒"。
  另外 `properties.eventCode` 是**对象**（`{SAME:['FLW'],NationalWeatherService:['FLW']}`），
  且实测 `Flood Warning` 的 SAME 给的是 `FLS`，所以它只作诊断、不参与任何判据。
- **NWS 的时间自带偏移**（`2026-09-22T06:51:00-04:00`，随州与夏令时变化）——直接 `Date.parse`，
  **不要补本地时区**。这是本插件第一个"时刻完整"的源（JMA / nmc / Wolfx 给的都是裸本地时间）。
- **NWS 的事件键取 VTEC 的** `<office>.<phenom>.<sig>.<ETN>`（如 `/O.EXT.KRLX.FA.W.0137.…/` →
  `KRLX.FA.W.0137`），**剔除 ACTION 段**：它从 `NEW` → `EXT` → `CON` → `CAN` 全程在变，
  放进去等于每次更新换一个键。这是 NWS 官方的事件追踪标识，实测 80/80 条活跃洪水类电文都有
  标准 7 段 VTEC，且同一条链的每个版本完全一致（`nws-event-chain.geojson` 就是这条证据），
  Cancel 与被取消的那条也一致（`nws-cancel-chain.geojson`）。
  **不要用 CAP 的 `references` 做事件键**（0.6.0 的做法，已被实测否定）：`references` 指向的是
  **被本条取代的那条消息**，而实测的链是**逐版串联**的——"取 `sent` 最早的一条"只能回溯一步，
  8 条真实链里 7 条会算出每版不同的键（症状：同一场洪水随每次更新重复响铃）。它现在只作为
  VTEC 缺失时的兜底（再下一级是自身 identifier）。
- **ECCC 只接 `alert_type === 'warning'`**：`advisory` 按 ECCC 自己的定义是
  「generally not considered hazardous」（霜冻、雾、高温都在里面）。实测当前 116 条里 114 条是
  frost advisory——不排除它，这个源就是噪声源。
  **注意 `wind warning` 是 warning**（只有霜冻 / 雾是 advisory）：它被排除是因为**不在本插件的
  灾种范围内**，不是因为"不危险"——这两件事不能混成一句。
- **ECCC 的白名单按 `alert_name_en` 关键词**（`/rain|flood|surge|hydrolog|water/`，并排除
  frost / fog / wind / heat…）。**不要按三字母 `alert_code` 猜**：它没有官方枚举，
  而 0.6.0 的调研阶段正是靠猜码把 `CFW` 当成了洪水（实际是 **storm surge warning**）。
  另外 **CAP XML 归档**里法语办公室的 `<event>` 是 `gel`——但 OGC API 通道给的是固定英文
  `alert_name_en` 与双语字段，不存在这个问题（我们走的就是后者）。
- **ECCC 的许可要求署名且不得改写**：End-use Licence v2.1.1 要求
  `Data Source: Environment and Climate Change Canada`，且警报内容与意图不得改变——
  所以 `alert_text_en` 原样进 `detail`，署名作为末行，severity 忠实映射（不拔高）。
- **当前季节没有降雨类样本**：ECCC 的降雨预警长什么样，这份 fixture **回答不了**
  （DESIGN 4.6.3 已登记这个缺口）。等它真实出现时用采集脚本重抓，并把 `alert_code` 补进白名单。
- fixture 随季节与生效集合变化，diff 天然是噪音；要固定的是**字段形态**，
  那由 `tests/sync-test.cjs` 的 0.6.0 / 0.6.1 断言来钉（含真实事件链的同键断言）。
