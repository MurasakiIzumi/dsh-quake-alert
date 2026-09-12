# samples — P2PQuake / 気象庁 真实消息样本库

本目录存放四类真实消息样本，用于开发、模拟回放与单元测试：

- **P2PQuake JSON**（地震 / EEW / 海啸）：实时链路与匹配回归
- **気象庁防災情報XML**（泥石流 / 洪水 / 大雨 / 高潮）：0.3.0 起的气象警报链路
- **特别警报电文**（旧格式 / 报知）：0.4.0 修复最高级警报漏报的回归 fixture
- **全球源样本**（EMSC / USGS / NOAA）：0.4.0 全球化链路的回归 fixture

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
