// ============================================================================
// dsh-quake-alert · client/src/00a-texts-core.js
//
// 作用：核心文案表（三语言并列）——通知、行动提示、免责行、机构名、状态条。
// 内容：纯数据对象，**不 import 任何模块**（依赖方向：面文件 ← 00-i18n.js ← 其它）。
// 依赖：无。
//
// key 命名：`面.子面.用途`，全小写驼峰段；插值写 `{name}`（由 t() 替换）。
// zh-CN 一栏是**逐字现状**——0.9.0 的 i18n 只是把既有字符串搬进表里，
// 默认语言下的输出必须与 0.8.2 完全一致（回归里有一条断言守这件事）。
//
// 范围（DESIGN 11.10）：只放**我们生成的文本**。源的 headline / detail / 地名 /
// 解析层 kindLabel / 各源 reason 一律不进这里，它们原样透传。
// ============================================================================

const CORE = {
  'zh-CN': {
    'app.name': '灾害预警',
    'app.statusPrefix': '灾害预警：',

    // 大陆源的产品名与日本源的「緊急地震速報」是两家机构的不同产品（见 11-pipeline 的说明）。
    'product.cnEew': '大陆地震预警',
    'product.cnEqlist': '大陆地震速报',
    'product.jpEew': '紧急地震速报（警报）',
    'product.jpEewShort': '紧急地震速报',

    // 免责声明里点名的机构（按源）。认不出时退回 disclaimer.generic，不硬编码任何一家。
    'authority.emsc': '欧洲-地中海地震中心（EMSC）',
    'authority.usgs': '美国地质调查局（USGS）',
    'authority.noaa': '太平洋海啸警报中心（NOAA）',
    'authority.cenc': '中国地震台网（CENC）',
    'authority.cma': '中央气象台（中国气象局）',
    'authority.nws': '美国国家气象局（NWS）',
    'authority.eccc': '加拿大环境与气候变化部（ECCC）',
    'authority.jma': '気象庁',

    'disclaimer.named': '仅供参考，请以{authority}的官方发布为准',
    'disclaimer.generic': '仅供参考，请以官方发布为准',

    // 取消 / 解除通知（解除电文命中时）的标题与正文。
    'notify.cancelTitle': '{product}已取消',
    'notify.cancelBody': '此前发出的警报已作废。',
    'notify.tsunamiLifted': '✅ 海啸预报已解除',

    // 气象预警的行动提示：三家机构的处置口径不同，不能互相套用（见 11-pipeline 的说明）。
    'action.generic': '请关注当地官方发布的指引',
    'action.overseas': '请关注当地官方发布的避难与撤离指引',
    'action.cnArea': '请关注当地气象台发布的防御指引',
    'action.jp': '请确认所在市町村的避难信息',

    // 通知正文里的命中行。行政区的县名要跟着界面语言走（prefLabelOf），
    // 所以这里只放"标签 + 占位符"，拼装仍在 11-pipeline。
    'notify.hitPref': '命中地区：{pref}',
    'notify.hitPrefNamed': '命中地区：{pref}（{jp}）',
    'notify.hitPlaceDistance': '命中位置：{place}（距震中约 {km} km）',
    'notify.hitPlaceOfficial': '命中位置：{place}（按该点所在地的官方预警判定）',
    // 海啸的行动提示：与气象的三家口径并列，单独一条（它不按机构分岔）。
    'action.tsunami': '请立即远离海岸与河口',

    // 源在状态区块里的显示名（短标签，与免责声明里点名的全称是两回事）。
    'source.jma': '気象庁',
    'source.nmc': '中央气象台',
    'status.emscConnected': '已连接 EMSC（全球地震实时推送）',
    // 源状态摘要（07-store 拼的悬停提示 / 侧边栏 title）：源名与分隔符都要跟着语言走，
    // 状态码本身由 00f 的 statusTextOf 翻。
    'status.sourceDisabled': '{name}：已关闭',
    'status.sourceDetail': '{name}：{detail}',

    // 取数层写给用户的**状态说明**（进 store.sources[id].detail：设置页的源状态区块、侧边栏
    // 悬停提示、诊断快照）。它们不是源侧文本，而是我们自己写的降级 / 关闭 / 覆盖范围说明。
    'source.cnPollManual': '已按设置选择轮询',
    'source.cnFallback': 'SSE 推送不可用 → 已降级为轮询',
    'source.cnFallbackReason': 'SSE 推送不可用（{reason}）→ 已降级为轮询',
    'source.cnPollDelay': '（延迟最长 15 秒）',
    'source.cnFallbackDelay': '（延迟从秒级变为最长 15 秒）',
    'source.overseasDisabled': '海外气象提醒已关闭',
    'source.overseasNoneInCoverage': '关注点都不在{region}源的覆盖范围内',
    'source.overseasNoPlaces': '未设置{region}关注点',
    'source.settingsHint': '（设置 → 灾害预警 → 关注地区 → 其他国家 / 地区）',
    'source.noAbortController': '请求超时（本环境没有 AbortController）',

    // 状态圆点的提示后缀（气象警报的静默提示，只在该源未达播报门槛时出现）。
    'status.weatherHint': ' · 气象警报 L{level}',
    'status.weatherHintLabel': '（{label}）',
  },

  ja: {
    'app.name': '災害警報',
    'app.statusPrefix': '災害警報：',

    'product.cnEew': '中国大陸の地震予警',
    'product.cnEqlist': '中国大陸の地震速報',
    'product.jpEew': '緊急地震速報（警報）',
    'product.jpEewShort': '緊急地震速報',

    'authority.emsc': '欧州地中海地震学センター（EMSC）',
    'authority.usgs': 'アメリカ地質調査所（USGS）',
    'authority.noaa': '太平洋津波警報センター（NOAA）',
    'authority.cenc': '中国地震台網（CENC）',
    'authority.cma': '中国気象局 中央気象台',
    'authority.nws': 'アメリカ国立気象局（NWS）',
    'authority.eccc': 'カナダ環境・気候変動省（ECCC）',
    'authority.jma': '気象庁',

    'disclaimer.named': '参考情報です。{authority}の公式発表をご確認ください',
    'disclaimer.generic': '参考情報です。公式発表をご確認ください',

    'notify.cancelTitle': '{product}を取消',
    'notify.cancelBody': '以前に発表された警報は無効になりました。',
    'notify.tsunamiLifted': '✅ 津波予報は解除されました',

    'action.generic': '現地の公式情報をご確認ください',
    'action.overseas': '現地の公式な避難・退避の指示に従ってください',
    'action.cnArea': '現地の気象台が発表する防災情報をご確認ください',
    'action.jp': 'お住まいの市町村の避難情報をご確認ください',

    'notify.hitPref': 'ヒット地域：{pref}',
    'notify.hitPrefNamed': 'ヒット地域：{pref}（{jp}）',
    'notify.hitPlaceDistance': 'ヒット位置：{place}（震源から約 {km} km）',
    'notify.hitPlaceOfficial': 'ヒット位置：{place}（その地点の公式警報による判定）',
    'action.tsunami': 'ただちに海岸と河口から離れてください',

    'source.jma': '気象庁',
    'source.nmc': '中国気象台',
    'status.emscConnected': 'EMSC に接続しました（全球地震のリアルタイム配信）',
    'status.sourceDisabled': '{name}：停止中',
    'status.sourceDetail': '{name}：{detail}',

    'source.cnPollManual': '設定によりポーリングを選択',
    'source.cnFallback': 'SSE 配信が使えないためポーリングに降格',
    'source.cnFallbackReason': 'SSE 配信が使えないため（{reason}）ポーリングに降格',
    'source.cnPollDelay': '（遅延は最大 15 秒）',
    'source.cnFallbackDelay': '（遅延は秒単位から最大 15 秒に）',
    'source.overseasDisabled': '海外の気象警報はオフです',
    'source.overseasNoneInCoverage': '登録地点が{region}のソースの対象範囲にありません',
    'source.overseasNoPlaces': '{region}の登録地点がありません',
    'source.settingsHint': '（設定 → 災害警報 → 監視地域 → その他の国 / 地域）',
    'source.noAbortController': 'リクエストがタイムアウト（この環境に AbortController がありません）',

    'status.weatherHint': ' · 気象警報 L{level}',
    'status.weatherHintLabel': '（{label}）',
  },

  en: {
    'app.name': 'Disaster alerts',
    'app.statusPrefix': 'Disaster alerts: ',

    'product.cnEew': 'Mainland China earthquake warning',
    'product.cnEqlist': 'Mainland China earthquake report',
    'product.jpEew': 'Earthquake Early Warning (Alert)',
    'product.jpEewShort': 'Earthquake Early Warning',

    // 英文的机构名前带 the：这些值只出现在 disclaimer.named 的 {authority} 位置，
    // 单独展示机构名的位置（设置页 / 诊断）另有各自的表，不复用这一栏。
    'authority.emsc': 'the Euro-Mediterranean Seismological Centre (EMSC)',
    'authority.usgs': 'the U.S. Geological Survey (USGS)',
    'authority.noaa': 'the Pacific Tsunami Warning Center (NOAA)',
    'authority.cenc': 'the China Earthquake Networks Center (CENC)',
    'authority.cma': 'the National Meteorological Center of China',
    'authority.nws': 'the U.S. National Weather Service (NWS)',
    'authority.eccc': 'Environment and Climate Change Canada (ECCC)',
    'authority.jma': 'the Japan Meteorological Agency (JMA)',

    'disclaimer.named': 'For reference only. Check official announcements from {authority}.',
    'disclaimer.generic': 'For reference only. Check official announcements.',

    'notify.cancelTitle': '{product} cancelled',
    'notify.cancelBody': 'The previously issued alert is no longer in effect.',
    'notify.tsunamiLifted': '✅ Tsunami advisory lifted',

    'action.generic': 'Follow guidance from local officials.',
    'action.overseas': 'Follow local evacuation and shelter guidance.',
    'action.cnArea': 'Follow the protective guidance issued by the local weather office.',
    'action.jp': 'Check the evacuation information for your municipality.',

    'notify.hitPref': 'Hit area: {pref}',
    'notify.hitPrefNamed': 'Hit area: {pref} ({jp})',
    'notify.hitPlaceDistance': 'Hit: {place} (~{km} km from the epicentre)',
    'notify.hitPlaceOfficial': 'Hit: {place} (matched against the official alert for that location)',
    'action.tsunami': 'Move away from the coast and river mouths immediately.',

    'source.jma': 'JMA',
    'source.nmc': 'CMA',
    'status.emscConnected': 'Connected to EMSC (global earthquake push)',
    'status.sourceDisabled': '{name}: disabled',
    'status.sourceDetail': '{name}: {detail}',

    'source.cnPollManual': 'Polling chosen in settings',
    'source.cnFallback': 'SSE unavailable — fell back to polling',
    'source.cnFallbackReason': 'SSE unavailable ({reason}) — fell back to polling',
    'source.cnPollDelay': ' (up to 15 s delay)',
    'source.cnFallbackDelay': ' (delay goes from seconds to up to 15 s)',
    'source.overseasDisabled': 'Overseas weather alerts are off',
    'source.overseasNoneInCoverage': 'No watch location is inside the {region} source coverage',
    'source.overseasNoPlaces': 'No {region} watch locations configured',
    'source.settingsHint': ' (Settings → Disaster alerts → Watch regions → Other countries / regions)',
    'source.noAbortController': 'Request timed out (no AbortController in this environment)',

    'status.weatherHint': ' · Weather alert L{level}',
    'status.weatherHintLabel': ' ({label})',
  },
}

export { CORE }
