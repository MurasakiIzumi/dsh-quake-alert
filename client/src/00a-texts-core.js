// ============================================================================
// dsh-quake-alert · client/src/00a-texts-core.js
// 作用：核心文案表（各语言并列）——通知、行动提示、免责行、机构名、状态条。
// 内容：纯数据对象，不 import 任何模块（依赖方向：文案文件 ← 00-i18n.js ← 其它）。
// key 命名：`面.子面.用途`，全小写驼峰段；插值写 `{name}`（由 t() 替换）。只放我们生成的
// 文本：源的 headline / detail / 地名 / 解析层 kindLabel / 各源 reason 一律原样透传。
// ============================================================================

const CORE = {
  'zh-CN': {
    'app.name': '灾害预警',
    'app.statusPrefix': '灾害预警：',

    'product.cnEew': '大陆地震预警',
    'product.cnEqlist': '大陆地震速报',
    'product.jpEew': '紧急地震速报（警报）',
    'product.jpEewShort': '紧急地震速报',

    // 依据源给免责声明点名的机构；认不出时退回 disclaimer.generic。
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

    // 气象预警的行动提示：三家机构口径不同，不能互相套用。
    'action.generic': '请关注当地官方发布的指引',
    'action.overseas': '请关注当地官方发布的避难与撤离指引',
    'action.cnArea': '请关注当地气象台发布的防御指引',
    'action.jp': '请确认所在市町村的避难信息',

    // 通知正文里的命中行：县名跟着界面语言走（prefLabelOf），所以这里只有标签 + 占位符。
    'notify.hitPref': '命中地区：{pref}',
    'notify.hitPrefNamed': '命中地区：{pref}（{jp}）',
    'notify.hitPlaceDistance': '命中位置：{place}（距震中约 {km} km）',
    'notify.hitPlaceOfficial': '命中位置：{place}（按该点所在地的官方预警判定）',
    // 海啸的行动提示：不按机构分岔，单独一条。
    'action.tsunami': '请立即远离海岸与河口',

    // 源在状态区块里的短显示名，与免责声明里点名的全称是两回事。
    'status.emscConnected': '已连接 EMSC（全球地震实时推送）',
    // 源状态摘要（07-store 拼的悬停提示 / 侧边栏 title）：源名与分隔符跟着语言走，
    // 状态码本身由 00f 的 statusTextOf 翻。
    'status.sourceDisabled': '{name}：已关闭',
    'status.sourceDetail': '{name}：{detail}',

    // 取数层写进 store.sources[id].detail 的降级 / 关闭 / 覆盖范围说明，不是源侧文本。
    'source.p2pConnected': '已连接 P2PQuake（约每 10 分钟自动重连）',
    'source.p2pSandbox': '沙箱源：回放 2023 年历史（约30秒/条）',
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
    'status.weatherHintLabel': '（{label}）'
  },

  'zh-TW': {
    'app.name': '災害預警',
    'app.statusPrefix': '災害預警：',

    'product.cnEew': '大陸地震預警',
    'product.cnEqlist': '大陸地震速報',
    'product.jpEew': '緊急地震速報（警報）',
    'product.jpEewShort': '緊急地震速報',

    'authority.emsc': '歐洲-地中海地震中心（EMSC）',
    'authority.usgs': '美國地質調查局（USGS）',
    'authority.noaa': '太平洋海嘯警報中心（NOAA）',
    'authority.cenc': '中國地震台網（CENC）',
    'authority.cma': '中央氣象台（中國氣象局）',
    'authority.nws': '美國國家氣象局（NWS）',
    'authority.eccc': '加拿大環境與氣候變遷部（ECCC）',
    'authority.jma': '気象庁',

    'disclaimer.named': '僅供參考，請以{authority}的官方發布為準',
    'disclaimer.generic': '僅供參考，請以官方發布為準',

    'notify.cancelTitle': '{product}已取消',
    'notify.cancelBody': '先前發出的警報已作廢。',
    'notify.tsunamiLifted': '✅ 海嘯預報已解除',

    'action.generic': '請關注當地官方發布的指引',
    'action.overseas': '請關注當地官方發布的避難與撤離指引',
    'action.cnArea': '請關注當地氣象台發布的防禦指引',
    'action.jp': '請確認所在市町村的避難資訊',

    'notify.hitPref': '命中地區：{pref}',
    'notify.hitPrefNamed': '命中地區：{pref}（{jp}）',
    'notify.hitPlaceDistance': '命中位置：{place}（距震央約 {km} km）',
    'notify.hitPlaceOfficial': '命中位置：{place}（依該點所在地的官方預警判定）',
    'action.tsunami': '請立即遠離海岸與河口',
    'status.emscConnected': '已連線 EMSC（全球地震即時推送）',
    'status.sourceDisabled': '{name}：已關閉',
    'status.sourceDetail': '{name}：{detail}',

    'source.p2pConnected': '已連線 P2PQuake（約每 10 分鐘自動重新連線）',
    'source.p2pSandbox': '沙箱源：回放 2023 年歷史（約 30 秒 / 筆）',
    'source.cnPollManual': '已依設定選擇輪詢',
    'source.cnFallback': 'SSE 推送無法使用 → 已降級為輪詢',
    'source.cnFallbackReason': 'SSE 推送無法使用（{reason}）→ 已降級為輪詢',
    'source.cnPollDelay': '（延遲最長 15 秒）',
    'source.cnFallbackDelay': '（延遲從秒級變為最長 15 秒）',
    'source.overseasDisabled': '海外氣象提醒已關閉',
    'source.overseasNoneInCoverage': '關注點都不在{region}源的涵蓋範圍內',
    'source.overseasNoPlaces': '未設定{region}關注點',
    'source.settingsHint': '（設定 → 災害預警 → 關注地區 → 其他國家 / 地區）',
    'source.noAbortController': '請求逾時（本環境沒有 AbortController）',

    'status.weatherHint': ' · 氣象警報 L{level}',
    'status.weatherHintLabel': '（{label}）'
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
    'status.emscConnected': 'EMSC に接続しました（全球地震のリアルタイム配信）',
    'status.sourceDisabled': '{name}：停止中',
    'status.sourceDetail': '{name}：{detail}',

    'source.p2pConnected': 'P2PQuake に接続しました（約 10 分ごとに自動再接続）',
    'source.p2pSandbox': 'サンドボックス源：2023 年の履歴を再生（約 30 秒 / 件）',
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
    'status.weatherHintLabel': '（{label}）'
  },

  en: {
    'app.name': 'Disaster alerts',
    'app.statusPrefix': 'Disaster alerts: ',

    'product.cnEew': 'Mainland China earthquake warning',
    'product.cnEqlist': 'Mainland China earthquake report',
    'product.jpEew': 'Earthquake Early Warning (Alert)',
    'product.jpEewShort': 'Earthquake Early Warning',

    // 英文机构名带 the：只用在 disclaimer.named 的 {authority} 位置，单独展示机构名的位置
    // （设置页 / 诊断）另有各自的表。
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
    'status.emscConnected': 'Connected to EMSC (global earthquake push)',
    'status.sourceDisabled': '{name}: disabled',
    'status.sourceDetail': '{name}: {detail}',

    'source.p2pConnected': 'Connected to P2PQuake (auto-reconnects about every 10 minutes)',
    'source.p2pSandbox': 'Sandbox feed: replaying 2023 history (~30 s per message)',
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
    'status.weatherHintLabel': ' ({label})'
  }
}

export { CORE }
