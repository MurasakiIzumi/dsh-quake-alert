# samples — P2PQuake 真实消息样本库

本目录存放 P2PQuake JSON API v2 推送的真实消息样本，用于开发、模拟回放与单元测试。

> 数据来自 P2PQuake 公开 API 与気象庁公开信息，均为公开信息，仅用于本项目的开发与回归测试。

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
