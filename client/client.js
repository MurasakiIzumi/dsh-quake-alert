window.__ModuleLoader__.load({ id: "dsh-quake-alert", factory: (require) => {
var module = { exports: {} }; var exports = module.exports;

/**
 * dsh-quake-alert client bundle —— 由 scripts/build-client.mjs (rollup) 从 client/src/*.js 打包生成。
 * 请勿直接编辑本文件：改 client/src/ 下的 ESM 模块（每个文件头部写了职责与依赖），再运行 pnpm build。
 * 灾害预警：DSH 使用期间经 P2PQuake WebSocket 接收日本地震 / 海啸信息，按「关注地区 + 震度 / 海啸阈值」
 * 命中后页内 toast、页面后台系统通知与提示音（设置 → 灾害预警）；数据由 P2PQuake 转播，仅供参考。
 */

'use strict';

var React = require('react');

// ============================================================================
// dsh-quake-alert · client/src/09-notify.js
// 作用：用户可见提醒的两种呈现——系统通知与页面内 toast（能力与权限判定、发送、toast 渲染）。
// 依赖：01-constants。约定：页面可见时只用 toast，后台才用系统通知（系统通知不可用时回退 toast）。
// ============================================================================

function notificationSupported() { return typeof window !== 'undefined' && typeof window.Notification === 'function' }
function notificationPermission() {
  if (!notificationSupported()) return 'unsupported'
  return window.Notification.permission
}
function requestNotificationPermission() {
  if (!notificationSupported()) return Promise.resolve('unsupported')
  try {
    // 老实现的 `requestPermission` 是回调式：返回 `undefined` 并把结果交给回调。这里两种签名都接——
    // 返回 Promise 就直接用，否则轮询等回调（30 秒无回应按 'default' 收场，不假装成功）。
    let cbResult = '';
    const ret = window.Notification.requestPermission((res) => { cbResult = String(res || ''); });
    if (ret && typeof ret.then === 'function') return ret
    return new Promise((resolve) => {
      let tries = 0;
      const tick = () => {
        tries += 1;
        if (cbResult) { resolve(cbResult); return }
        if (tries > 120) { resolve('default'); return } // 30 秒没有回应：当作"尚未决定"
        setTimeout(tick, 250);
      };
      tick();
    })
  } catch (err) { return Promise.resolve('denied') }
}
function showSystemNotification(opts) {
  if (!notificationSupported() || window.Notification.permission !== 'granted') return false
  try {
    // eslint-disable-next-line no-new
    new window.Notification(opts.title, {
      body: opts.body || '',
      tag: opts.tag || 'quake-alert',
      icon: opts.icon,
      silent: Boolean(opts.silent),
    });
    return true
  } catch (err) { return false }
}
let toastSeq = 0;
// 当前屏上的 toast，共用一个纵向排列容器（自动堆叠）；超过 TOAST_MAX 条时收掉最旧的一条。
const TOAST_MAX = 3;
let toastBox = null;
const liveToasts = []; // [{ el, key }]
function ensureToastBox(doc) {
  if (toastBox && toastBox.parentNode) return toastBox
  const box = doc.createElement('div');
  const st = box.style;
  st.position = 'fixed';
  st.top = '16px';
  st.right = '16px';
  // 高于 DSH 前端自身的层级（最高约 1100）
  st.zIndex = '2000';
  st.display = 'flex';
  st.flexDirection = 'column';
  st.gap = '8px';
  st.alignItems = 'flex-end';
  // 容器本身不挡点击，单条 toast 恢复 auto —— 否则空白的容器会盖住右下角一片界面
  st.pointerEvents = 'none';
  if (typeof box.setAttribute === 'function') box.setAttribute('aria-live', 'polite');
  doc.body.appendChild(box);
  toastBox = box;
  return box
}
function dropToast(entry) {
  const i = liveToasts.indexOf(entry);
  if (i !== -1) liveToasts.splice(i, 1);
  try { if (entry.el && entry.el.parentNode) entry.el.parentNode.removeChild(entry.el); } catch (err) { /* 已移除 */ }
}
/** 渲染一条 toast 并在 ttl 后淡出移除；dropToast 从界面与 liveToasts 里摘掉一条。 */
function showToast(opts) {
  try {
    if (!window.document || !window.document.body) return
    const doc = window.document;
    const color = opts.color || '#e8565b';
    const key = color + '|' + (opts.title || '') + '|' + (opts.body || '');
    // 同一条已经在屏上就不再叠一条；参数名不用 `t`（那是 i18n 取词函数名）
    if (liveToasts.some((live) => live.key === key)) return
    const box = ensureToastBox(doc);
    while (liveToasts.length >= TOAST_MAX) dropToast(liveToasts[0]);
    const el = doc.createElement('div');
    const id = 'quake-alert-toast-' + (++toastSeq);
    el.id = id;
    // role=alert：页面可见时只用 toast，读屏用户全靠这个 live region 收到警报
    if (typeof el.setAttribute === 'function') el.setAttribute('role', 'alert');
    const style = el.style;
    style.pointerEvents = 'auto';
    style.maxWidth = '340px';
    style.background = 'rgba(24,25,30,0.97)';
    style.color = '#e8e8ea';
    style.border = '1px solid ' + color;
    style.borderLeft = '4px solid ' + color;
    style.borderRadius = '10px';
    style.padding = '10px 14px';
    style.font = '13px/1.5 system-ui, sans-serif';
    style.boxShadow = '0 6px 24px rgba(0,0,0,0.45)';
    style.cursor = 'pointer';
    style.opacity = '0';
    style.transition = 'opacity .18s ease';
    const title = doc.createElement('div');
    title.style.fontWeight = '700';
    title.style.color = color;
    // 标题也要能换行，长标题（含区域名与震级）否则会溢出 340px
    title.style.wordBreak = 'break-word';
    title.textContent = opts.title || '';
    const body = doc.createElement('div');
    body.style.marginTop = '3px';
    body.style.whiteSpace = 'pre-wrap';
    body.style.wordBreak = 'break-word';
    body.textContent = opts.body || '';
    el.appendChild(title); el.appendChild(body);
    const entry = { el, key };
    el.addEventListener('click', () => { dropToast(entry); });
    box.appendChild(el);
    liveToasts.push(entry);
    requestAnimationFrame(() => { el.style.opacity = '1'; });
    const ttl = opts.ttlMs || 8000;
    setTimeout(() => {
      el.style.opacity = '0';
      setTimeout(() => dropToast(entry), 220);
    }, ttl);
  } catch (err) { /* DOM 不可用忽略 */ }
}

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
};

// ============================================================================
// dsh-quake-alert · client/src/00b-texts-settings.js
//
// 作用：设置页文案表（各语言并列）——区块标题、选项卡、控件标签、按钮、说明、折叠区、
//       状态提示、错误提示、测试结果模板、履历条目的徽标与字段名。
// 内容：纯数据对象，不 import 任何模块（依赖方向：文案文件 ← 00-i18n.js ← 其它）。
//       key 命名 `settings.子面.用途`，全小写驼峰段；插值写 `{name}`（由 t() 替换）。
//
// 只放我们生成的文本，下面这些一律不进表、原样透传：
// 源侧标签（`SOURCE_CODE_TEXT` / `p2pCodeTextOf` 的来源标注、`P2P_KIND_CODE`、
// `store.sources[id].label`、`store.weatherHint.label`）、地名（`place.name` / `c.name` /
// `c.admin`）、`alert.detail`、`e.headline`、`e.label`（解析层 kindLabel）、`res.detail`、
// 语义标签里的专有名词原文（'気象庁' / '東京都' / 'Data Source: Environment and Climate
// Change Canada'）、源文本里的固定枚举（'Flood / Flood Warning' / 'Watch' / 'Advisory' /
// 'Statement' / 'warning' / 'advisory'）、单位与标识（'km' / '%' / 'EEW' / 'CENC' /
// 'NOAA' / 'NWS' / 'ECCC' / 'SSE' / 'Web Audio' / 'settings.yaml' / 'localStorage' /
// 'TROUBLESHOOTING.zh.md' / 'dsh web' / 'QuakeAlert' / 'AI'）、间隔符与破折号
// （' · ' / ' / ' / '—' / '…' / '（' / '）'）。
//
// 另有 `store.detail`（源状态摘要，源名与状态文字都走 t()，见 07-store）与都道府县名
// （走 `prefLabelOf` 的日文原名 / 中文名 / 罗马字三分支，见 01-constants）已经进表。
// `e.suppressedReason`（11-pipeline 拼的「为什么没播报」，进履历条目的说明字段）尚未进表。
// ============================================================================

const SETTINGS = {
  'zh-CN': {
    // ---------- 连接状态（statusMetaOf；侧边栏状态指示与设置页状态条共用） ----------
    'settings.status.idle': '未启动',
    'settings.status.connecting': '连接中…',
    'settings.status.open': '已连接',
    'settings.status.reconnecting': '重连中（第 {n} 次）',
    'settings.status.closed': '已停止',
    // 轮询源与"消息处理失败"也有自己的状态：上游被墙 / 路由 500 / 主链抛错时不能与"没有新闻"同形
    'settings.status.unreachable': '无法连接',
    'settings.status.degraded': '链路降级',
    'settings.status.stale': '数据已过期',
    'settings.status.schemaError': '数据格式异常',
    'settings.status.disabled': '已关闭',
    // 认不出的状态码原样回显（配置 / 上游里出现没登记的状态时不该显示空白）
    'settings.status.raw': '{status}',

    // ---------- 配置存储位置的人话说明（settingsSyncLabel） ----------
    'settings.storage.host': '保存在本机（settings.yaml）',
    'settings.storage.memory': '只保存在这个浏览器里',
    'settings.storage.local': '浏览器本地存储',

    // ---------- 源名标签（被 00f 的 SOURCE_LABEL_KEYS 与 statusTextOf 指向） ----------
    // 与 `settings.source.*` 分开：这些是源的名字，侧边栏悬停提示、源状态区块、重试按钮三处共用。
    'settings.sourceLabels.p2pquake': 'P2PQuake（日本地震 / EEW / 海啸，实时推送）',
    'settings.sourceLabels.emsc': 'EMSC（全球地震，实时推送）',
    'settings.sourceLabels.cencEew': '大陆地震预警（CENC，SSE 推送）',
    'settings.sourceLabels.cencEqlist': '大陆地震速报（CENC，SSE 推送）',
    'settings.sourceLabels.jma': '気象庁（气象灾害，Host 轮询）',
    'settings.sourceLabels.usgs': 'USGS（全球地震目录，Host 轮询）',
    'settings.sourceLabels.noaa': 'NOAA（海啸 CAP，Host 轮询）',
    'settings.sourceLabels.nmc': '中央气象台（大陆暴雨 / 地质灾害预警，Host 轮询）',
    'settings.sourceLabels.nws': 'NWS（美国洪水 / 山洪 / 沿海洪水，Client 直连）',
    'settings.sourceLabels.eccc': 'ECCC（加拿大降雨 / 风暴潮预警，Client 直连）',

    'settings.source.title': '源状态',
    'settings.source.keyValue': '{k}：{v}',
    'settings.source.secondsAgo': '{n} 秒前',
    'settings.source.dash': '—',
    'settings.source.notFetched': '尚未拉取',
    'settings.source.receivedIncrements': '已收到 {n} 条增量',
    'settings.source.localErrors': '，本地失败 {n} 次',
    'settings.source.truncated': '，增量缺口 {n} 次',
    'settings.source.resets': '，读取位置重置 {n} 次',
    'settings.source.hostErrors': '，Host 失败 {n} 次',
    'settings.source.hostDetailDropped': '，Host 放弃详情 {n} 条',
    'settings.source.lastFetch': ' · 最近拉取 {ago}',
    'settings.source.notQueried': '尚未查询',
    'settings.source.polls': '已查询 {n} 轮',
    'settings.source.requests': ' · 请求 {n} 次',
    'settings.source.respondedItems': ' · 响应条目 {n}',
    'settings.source.applied': '，交给主链 {n} 条',
    'settings.source.ageSkipped': '，过老只记历史 {n} 条',
    'settings.source.rejected': '，被上游拒绝 {n} 次',
    'settings.source.overseasTruncated': '，上游结果被分页上限截断 {n} 轮',
    'settings.source.throttled': '，本轮超上限跳过 {n} 个请求',
    'settings.source.errors': '，失败 {n} 次',
    'settings.source.lastQuery': ' · 最近查询 {ago}',
    'settings.source.notStarted': '尚未启动',
    'settings.source.modeSse': 'SSE 推送',
    'settings.source.modePoll': '已降级为轮询',
    'settings.source.modeDisabled': '已关闭（「地震」开关关掉了）',
    'settings.source.modeIdle': '未连接',
    'settings.source.received': ' · 已收到 {n} 条',
    'settings.source.broadcast': '，已播报 {n}',
    'settings.source.fallbacks': '，降级 {n} 次',
    'settings.source.probeTimeouts': '，未收到数据 {n} 次',
    'settings.source.lastData': ' · 最近数据 {ago}',
    'settings.source.retry': '重试 {name} 的数据解析',

    // ---------- 地区分支与选项卡 ----------
    'settings.region.jp': '日本',
    'settings.region.cn': '中国大陆',
    'settings.region.global': '其他国家 / 地区',
    'settings.tab.region': '地区',
    'settings.tab.disaster': '灾害',
    'settings.tab.notify': '通知',
    'settings.tab.history': '履历',
    'settings.tab.misc': '其他',

    // ---------- 关注地区：手填坐标与定位（全球分支 / 大陆分支共用） ----------
    'settings.place.latInvalid': '纬度需要是 -90 ~ 90 之间的数字',
    'settings.place.lonInvalid': '经度需要是 -180 ~ 180 之间的数字',
    'settings.place.radiusInvalid': '半径需要是 1 ~ 2000 km 之间的数字',
    'settings.place.max': '最多 {n} 个关注点',
    'settings.place.addedPrefix': '已添加「{name}」',
    'settings.place.addedDedupe': '（坐标相同的重复点会被自动合并）',
    'settings.place.geoUnsupportedPlace': '当前浏览器不支持定位，请手动填写坐标',
    'settings.place.geoUnsupportedCn': '当前浏览器不支持定位，请选择省份与城市',
    'settings.place.locating': '正在获取当前位置…',
    'settings.place.geoNoCoords': '定位失败：没有返回坐标',
    'settings.place.myLocation': '我的位置',
    'settings.place.fillConfirm': '已填入当前位置，确认半径后点「添加关注点」',
    'settings.place.geoFailed': '定位失败：{reason}',
    'settings.place.geoDenied': '被拒绝或不可用',
    'settings.place.myLocationAdded': '已添加「我的位置」（{lat}, {lon}，半径 {radius} km）',
    'settings.place.geoImprecise': '定位可能不精确，请确认坐标或改用手动选择城市。',
    'settings.place.geoDenied2': '（也可以手动选择省份与城市）',

    // ---------- 半径控件 ----------
    'settings.radius.label': '半径',
    'settings.radius.custom': '自定义…',

    // ---------- 中国大陆的三级级联 ----------
    'settings.cn.pickRequired': '请先选择省份与城市（行政区划表未加载时请重启 dsh web）',
    'settings.cn.exists': '「{name}」已经在关注列表里了',
    'settings.cn.added': '已添加「{name}」（{lat}, {lon}，半径 {radius} km）',
    'settings.cn.tableFailed': '行政区划数据加载失败，可以改用「其他国家 / 地区」手动填坐标',
    'settings.cn.loading': '正在加载…',
    'settings.cn.provinceAll': '请选择省份 / 直辖市 / 特别行政区',
    'settings.cn.cityFirstProvince': '（先选省份）',
    'settings.cn.provinceLabel': '一级行政区（省 / 自治区 / 直辖市）',
    'settings.cn.cityLabel': '城市',
    'settings.cn.addButton': '添加这个城市',
    'settings.cn.useMyLocation': '用我的位置',

    // ---------- 市区町村细化器 ----------
    'settings.cities.failed': '市区町村列表加载失败，只能按都道府县关注',
    'settings.retry': '重试',
    'settings.cities.pickPrefFirst': '先选都道府县',
    'settings.cities.hint': '不选就是全县。EEW 和海啸只到县一级。',
    'settings.cities.prefAll': '全县',
    'settings.cities.prefSelected': '已选 {n} 个',
    'settings.cities.max': '最多 {n} 个市町村',
    'settings.cities.searchPlaceholder': '搜索 {pref} 的市町村…',
    'settings.cities.searchLabel': '搜索 {pref} 的市町村',
    'settings.cities.overLimit': '…共 {n} 个，请输入关键词',

    // ---------- 已关注地区列表 ----------
    // 只是后缀（原名），显示名由调用方按语言拼（`prefLabelOf`）。
    'settings.watch.prefMeta': '（{jp}）',
    'settings.watch.prefOrFull': ' · 全境',
    'settings.watch.prefDetail': ' · 已细化 {n} 个市区町村',
    'settings.watch.remove': '移除',
    'settings.watch.placeMeta': ' · 半径 {radius} km',
    'settings.watch.title': '已关注（{n}）',
    'settings.watch.empty': '还没有添加地区',
    'settings.watch.groupJp': '日本（按行政区）',
    'settings.watch.groupCn': '中国大陆（按行政区、坐标）',
    'settings.watch.groupGlobal': '其他国家 / 地区（按坐标、半径）',
    'settings.watch.noneJp': '未选择：全日本都会提醒',
    'settings.watch.noneOther': '还没有添加',

    // ---------- 日本分支 ----------
    'settings.jp.hintAll': '不选的话，全日本的地震都会提醒',
    'settings.jp.hintSelected': '已选 {n} 个地区',

    // ---------- 中国大陆分支 ----------
    'settings.cnBranch.hint': '选城市就会用市中心的坐标。面积大的州、市，把半径调大一些。',
    'settings.cnBranch.warning': '⚠ 预警被撤销或修改时不会另行通知。以中国地震台网发布为准。',
    'settings.cnBranch.foldTitle': '数据来源的局限',
    'settings.cnBranch.fold1': '没有取消或最终报标志：预警被上游撤销或修改时，不会补一条"已作废"。日本的地震速报和海啸有这条链路，大陆源没有。',
    'settings.cnBranch.fold2': '表里的坐标是行政区中心点，不是市政府所在地。面积大的州市（比如甘孜州、哈尔滨市）离城区可能差一百多公里。',
    'settings.cnBranch.fold3': '大陆预警请以中国地震台网（CENC）发布为准。',

    // ---------- 其他国家 / 地区分支 ----------
    'settings.global.cityFirst': '先选国家，再点城市。',
    'settings.global.cityFailed': '城市列表加载失败，可以手动填坐标，或重启 dsh web 再试。',
    'settings.global.cityNotCovered': '没有这个国家的城市列表（只收人口 10 万以上的城镇）。请用下面的坐标输入。',
    'settings.global.citySearchPlaceholder': '搜索城市（共 {n} 个）',
    'settings.global.citySearchLabel': '搜索城市',
    'settings.global.cityAddTitle': '添加 {label}',
    'settings.global.hint': '按位置和半径匹配。不影响日本的地震、海啸。',
    'settings.global.countryLabel': '国家 / 地区',
    'settings.global.countryAll': '请选择国家 / 地区',
    'settings.global.countryLoading': '正在加载国家 / 地区列表…',
    'settings.global.countryOption': '{name}（{n} 个城市）',
    'settings.global.manualHint': '也可以直接填坐标：',
    'settings.place.fieldName': '名称',
    'settings.place.fieldNamePlaceholder': '如 东京 / 家',
    'settings.place.fieldLat': '纬度',
    'settings.place.fieldLon': '经度',
    'settings.place.add': '添加关注点',
    'settings.place.useCurrentShort': '用当前位置',

    // ---------- 灾害类型与阈值 ----------
    'settings.section.watch': '关注地区',
    'settings.section.disaster': '灾害类型与阈值',
    'settings.disaster.hint': '关闭后仍会记录，只是不提示。',
    'settings.disaster.notifySwitch': '提醒',
    'settings.disaster.groupQuake': '地震',
    'settings.disaster.quakeJpLabel': '日本 · 实测震度',
    'settings.disaster.quakeJpNote': '本地观测到的震度',
    'settings.disaster.quakeJpSelect': '日本地震（实测震度最低值）',
    'settings.disaster.eewLabel': '日本 · 紧急地震速报（EEW）',
    'settings.disaster.eewNote': '预测的震度',
    'settings.disaster.eewSelect': '紧急地震速报（预测震度最低值）',
    'settings.disaster.globalLabel': '全球 / 大陆地震预警',
    'settings.disaster.globalNote': '震中到关注点的距离',
    'settings.disaster.globalSelect': '全球与大陆地震预警（最低震级）',
    'settings.disaster.cnReportLabel': '大陆地震速报（CENC 编目）',
    'settings.disaster.cnReportNote': '台网编目，每天都有',
    'settings.disaster.cnReportSelect': '大陆地震速报（最低震级）',
    'settings.disaster.foldScaleTitle': '震度和震级为什么分开设置',
    'settings.disaster.foldScale1': '日本给的是震度，全球和大陆给的是震级，两者不能换算。',
    'settings.disaster.foldScale2': '大陆速报从 M2.5 起就有数据、每天都很多，所以门槛单独设，免得小震一直响。',
    'settings.disaster.groupTsunami': '海啸',
    'settings.disaster.tsunamiJpLabel': '日本 · 全球（NOAA）',
    'settings.disaster.tsunamiJpNote': '全球源按关注点半径判定',
    'settings.disaster.tsunamiSelect': '海啸等级',
    'settings.disaster.groupWeatherJp': '气象 · 日本（気象庁）',
    'settings.disaster.weatherJpLabel': '泥石流 / 洪水 / 大雨 / 高潮',
    'settings.disaster.weatherJpNote': '危险级别才播报',
    'settings.disaster.gateJma4': '警戒4级以上',
    'settings.disaster.groupWeatherCn': '气象 · 中国大陆（中央气象台）',
    'settings.disaster.cnRainstormSwitch': '暴雨预警',
    'settings.disaster.cnGeologySwitch': '地质灾害预警',
    'settings.disaster.weatherCnLabel': '暴雨 / 地质灾害',
    'settings.disaster.weatherCnNote': '橙色以上才播报',
    'settings.disaster.gateOrange': '橙色以上',
    'settings.disaster.groupWeatherOverseas': '气象 · 海外（美国 NWS / 加拿大 ECCC）',
    'settings.disaster.weatherOverseasLabel': '洪水 / 山洪 / 降雨 / 风暴潮',
    'settings.disaster.weatherOverseasNote': '警告级才播报',
    'settings.disaster.gateOverseas': '警告级（美）· 黄色以上（加）',

    // ---------- 折叠：各数据源的取舍（安全相关 + 许可署名，一条都不能删） ----------
    'settings.disaster.foldTradeoffsTitle': '各数据源的取舍',
    'settings.disaster.tradeoffCnTitle': '中国大陆气象',
    'settings.disaster.tradeoffCn1': '只接暴雨和地质灾害两类。雷电、大风、高温等不接，否则每天几十条会刷屏。',
    'settings.disaster.tradeoffCn2': '橙色以上才播报；黄色和蓝色会记进「履历」，但不响铃也不弹通知（免打扰时段也不放行橙色，只有红色能穿透）。',
    'settings.disaster.tradeoffCn3': '匹配按行政区：只有在中国大陆分支里选的省、市才算关注点，手填的坐标不参与。机构名只到省级时（比如海南省直辖县）按全省放行，宁可多报也不漏报。',
    'settings.disaster.tradeoffCn4': '这批数据没有取消或最终报标志：预警到期就直接从列表里消失，所以没收到取消不代表警报仍然有效。',
    'settings.disaster.tradeoffOverseasTitle': '海外气象',
    'settings.disaster.tradeoffOverseas1': '关注点在「地区」页的「其他国家 / 地区」里配。美国按县和区划判定，半径 25km 以上时会额外查中心点周围的几个方向，所以半径只是近似、不保证覆盖半径内的所有县；加拿大把半径换算成矩形范围去查，与之相交的预警都算命中。',
    'settings.disaster.tradeoffOverseas2': '美国只播报 Flood / Flash Flood / Coastal Flood Warning，Watch、Advisory、Statement 只记录。',
    'settings.disaster.tradeoffOverseas3': '加拿大只接 warning 类的降雨、洪水、风暴潮。霜冻和雾属于 ECCC 的 advisory（官方定义就是"非危险天气"）；大风、高温、雷暴虽然是 warning，但不在本插件的灾种范围内。',
    'settings.disaster.tradeoffOverseas4': '打开页面时，如果某条预警已经发布超过 6 小时，只记录不响铃；页面休眠超过 30 分钟再恢复时也按这条处理。',
    'settings.disaster.tradeoffOverseas5': '数据来源：美国国家气象局（NWS）；加拿大环境与气候变化部（ECCC，Data Source: Environment and Climate Change Canada）。',
    'settings.disaster.weatherHint': '{label} 有 L{level} 气象警报（未达播报级别）',

    // ---------- 通知与声音 ----------
    'settings.perm.granted': '通知权限：已授权',
    'settings.perm.denied': '通知权限：已被拒绝，请在浏览器站点设置里允许',
    'settings.perm.default': '通知权限：未授权，点「测试系统通知」授权',
    'settings.perm.unsupported': '当前浏览器不支持系统通知',
    'settings.strip.received': '已收到 {n} 条推送',
    'settings.strip.more': '详情在「其他」里',
    'settings.section.language': '语言 / Language',
    'settings.language.label': '界面语言',
    'settings.section.source': '数据源',
    'settings.source.prod': '正式（实时推送）',
    'settings.source.sandbox': '沙箱（回放 2023 年数据，测试用）',
    'settings.source.config': '配置：{value}',
    'settings.section.cnTransport': '大陆源链路',
    'settings.cnTransport.label': '取数方式',
    'settings.cnTransport.auto': '自动（优先推送）',
    'settings.cnTransport.poll': '强制轮询（15 秒一次）',
    'settings.cnTransport.selectLabel': '大陆源取数方式',
    'settings.cnTransport.foldTitle': '什么时候需要改成强制轮询',
    'settings.cnTransport.fold1': 'SSE 推送的延迟是秒级，轮询最坏 15 秒——大陆预警抢的就是这几秒，所以默认用推送。',
    'settings.cnTransport.fold2': '只有在推送被网络中间设备反复掐断、而普通请求仍然正常时，才需要强制轮询。当前实际走在哪条路上，看下方「源状态」。',
    'settings.section.notify': '通知与声音',
    'settings.notify.sound': '提示音',
    'settings.notify.soundQuake': '地震（含紧急地震速报）',
    'settings.notify.soundTsunami': '海啸',
    'settings.notify.soundWeather': '气象灾害',
    'settings.notify.system': '系统通知',
    'settings.notify.volume': '音量',
    'settings.notify.testQuake': '试听地震音',
    'settings.notify.testEew': '试听 EEW 音',
    'settings.notify.testTsunami': '试听海啸音',
    'settings.notify.testWeather': '试听气象音',
    'settings.notify.testSystem': '测试系统通知',
    'settings.notify.testTitle': 'QuakeAlert 测试',
    'settings.notify.testBody': '这是一条测试系统通知。',
    'settings.notify.testSent': '已发送测试通知，请查看系统通知中心',
    'settings.notify.testFailed': '测试通知发送失败',
    'settings.notify.toastBody': '页面内弹窗工作正常。',
    'settings.notify.unsupportedTest': '当前浏览器不支持系统通知，无法测试',
    'settings.notify.deniedRetry': '通知权限已被拒绝 —— 请在浏览器站点设置中允许后重试',
    'settings.notify.notGranted': '未获得通知权限（浏览器未授权）',
    'settings.notify.testToast': '测试 Toast',
    'settings.notify.audioLocked': '⚠ 提示音还没解锁：点一下页面任意位置就好。',
    'settings.notify.audioUnavailable': '当前环境不支持 Web Audio，提示音不可用。',

    // ---------- 静默时段 ----------
    'settings.section.quiet': '静默时段',
    'settings.quiet.enable': '启用静默时段',
    'settings.quiet.start': '开始',
    'settings.quiet.end': '结束',
    'settings.quiet.startLabel': '静默时段开始时间',
    'settings.quiet.endLabel': '静默时段结束时间',
    'settings.quiet.breakForSevere': '紧急警报仍提醒（EEW、海啸警报、震度6弱以上、气象4级以上）',
    'settings.quiet.hint': '按浏览器本地时间判定。跨夜时段写成 23:00–07:00。免打扰期间仍会记录。',

    // ---------- 测试与诊断 ----------
    'settings.section.diag': '测试与诊断',
    'settings.diag.hint': '测试消息不会联网，用来确认提醒是否正常。',
    'settings.diag.sendWeather': '发送测试气象警报',
    'settings.diag.parseFailed': '测试消息解析失败，请把这个情况反馈给开发者',
    'settings.diag.outcomeSent': ' —— 已播报：应看到提示音与弹窗',
    'settings.diag.outcomeNotSent': ' —— 未播报（{reason}），只会记入「履历」',
    'settings.diag.outcomeUnknown': '未知原因',
    'settings.diag.sentWeather': '已发送：{label}（{pref} / 警戒レベル{level}，{note}）',
    'settings.diag.scenarios': '每次点击换一个场景：{list}。',
    // 测试场景的显示名与说明：场景数据（TEST_SCENARIOS / TEST_GEO_SCENARIOS）留在 05b / 05c
    // 保持纯数据，key 用它们的稳定标识（`sc.key`），那两个文件不必 import t()。
    'settings.diag.scenario.landslide': '泥石流警戒情报',
    'settings.diag.scenarioNote.landslide': '市町村级 / 电文本身即 L4',
    'settings.diag.scenario.flood': '指定河川洪水予報（氾濫危険情報）',
    'settings.diag.scenarioNote.flood': '级别写在主文里',
    'settings.diag.scenario.heavyrain': '大雨危険警報',
    'settings.diag.scenarioNote.heavyrain': '级别写在 Kind 名称里',
    'settings.diag.scenario.stormsurge': '高潮危険警報',
    'settings.diag.scenarioNote.stormsurge': '级别写在 Kind 名称里',
    'settings.diag.scenario.landslide-l3': '泥石流警報（警戒レベル3）',
    'settings.diag.scenarioNote.landslide-l3': '未达 L4：不播报',
    'settings.diag.scenario.emsc': 'EMSC 地震（震中就在关注点）',
    'settings.diag.scenarioNote.emsc': 'M6.2',
    'settings.diag.scenario.usgs': 'USGS 地震（约 80km 外）',
    'settings.diag.scenarioNote.usgs': 'M5.6 · 近处，小半径也可能不命中',
    'settings.diag.scenario.noaa': 'NOAA 海啸警报',
    'settings.diag.scenarioNote.noaa': 'Tsunami Advisory',
    'settings.diag.scenario.emsc-far': 'EMSC 远地地震（约 550km 外）',
    'settings.diag.scenarioNote.emsc-far': 'M7.0 · 用于演示半径：半径 < 550km 时不命中',
    'settings.diag.sendGlobal': '发送测试全球警报',
    'settings.diag.needPlace': '请先在「地区」里添加一个位置，测试消息需要一个震中',
    'settings.diag.sentGlobal': '已发送：{label}（{note}）',
    'settings.diag.globalScenarios': '每次点击换一个场景：{list}。最后一条在约 550km 外，用来演示半径的作用。',
    'settings.diag.snapshotHint': '把快照发给 AI 助手，配合 TROUBLESHOOTING.zh.md 排查。',
    'settings.diag.snapshotButton': '生成诊断快照',
    'settings.diag.copied': '已复制到剪贴板。',
    'settings.diag.copiedWithWarning': '已复制到剪贴板，但快照生成时有过异常：{warning}',
    'settings.diag.clipboardUnavailable': '剪贴板不可用',
    'settings.diag.clipboardError': '（{error}）',
    'settings.diag.copyManual': '，请手动全选下面的文本复制。',
    'settings.diag.generatingFailed': '生成失败：{error}',
    'settings.diag.snapshotWarn': '⚠ 包含你关注的地区和坐标，分享前请注意。',

    // ---------- 免责声明 ----------
    'settings.section.disclaimer': '免责声明',
    'settings.disclaimer.short': '仅供参考。避险请以当地官方发布为准。页面关闭后不会再提醒。',
    'settings.disclaimer.foldTitle': '数据来源与完整声明',
    'settings.disclaimer.source': '预警数据由 P2PQuake 转播、日本气象厅公开 XML 电文、EMSC / USGS / NOAA，美国国家气象局（NWS）与加拿大环境与气候变化部（ECCC）的公开接口（浏览器直连），以及 Wolfx 转播的中国地震台网（CENC）信息提供，均非官方直接推送；紧急地震速报（EEW）与大陆地震预警等内容与配信品质无保证。',
    'settings.disclaimer.authority': '避险请以当地主管机构（日本气象厅 気象庁 / 中国地震台网 CENC / 美国 NWS・USGS・NOAA / 加拿大 ECCC 等）官方发布为准。',

    // ---------- 预警记录（履历） ----------
    'settings.section.history': '预警记录（{n} 条）',
    'settings.history.hint': '没到阈值、没有提醒的记录也在里面。点开看详情。',
    'settings.history.empty': '暂无记录',
    'settings.history.statusHit': '未触发提醒',
    'settings.history.statusSuppressed': '未重复提醒',
    'settings.history.statusPrefHit': '命中 {pref}',
    'settings.history.statusAlerted': '已提醒',
    'settings.history.toggleCollapse': '点击收起（回车 / 空格同样可用）',
    'settings.history.toggleExpand': '点击展开详情（回车 / 空格同样可用）',
    'settings.history.collapse': '▲ 收起',
    'settings.history.expand': '▼ 展开',
    'settings.history.fieldKind': '类型',
    'settings.history.fieldTime': '时间',
    'settings.history.fieldPref': '命中',
    'settings.history.fieldNote': '说明',
    'settings.history.fieldContent': '内容',
    'settings.history.fieldDetail': '正文',
    'settings.history.kindValue': '{label}（{code}）',
    'settings.history.clear': '清空记录',
  },

  'zh-TW': {
    // ---------- 连接状态（statusMetaOf；侧边栏状态指示与设置页状态条共用） ----------
    'settings.status.idle': '未啟動',
    'settings.status.connecting': '連線中…',
    'settings.status.open': '已連線',
    'settings.status.reconnecting': '重新連線中（第 {n} 次）',
    'settings.status.closed': '已停止',
    'settings.status.unreachable': '無法連線',
    'settings.status.degraded': '鏈路降級',
    'settings.status.stale': '資料已過期',
    'settings.status.schemaError': '資料格式異常',
    'settings.status.disabled': '已關閉',
    'settings.status.raw': '{status}',

    // ---------- 配置存储位置的人话说明（settingsSyncLabel） ----------
    'settings.storage.host': '儲存在本機（settings.yaml）',
    'settings.storage.memory': '只儲存在這個瀏覽器裡',
    'settings.storage.local': '瀏覽器本機儲存',

    // ---------- 源名标签（SOURCE_LABEL_KEYS 指向这里） ----------
    'settings.sourceLabels.p2pquake': 'P2PQuake（日本地震 / EEW / 海嘯，即時推送）',
    'settings.sourceLabels.emsc': 'EMSC（全球地震，即時推送）',
    'settings.sourceLabels.cencEew': '大陸地震預警（CENC，SSE 推送）',
    'settings.sourceLabels.cencEqlist': '大陸地震速報（CENC，SSE 推送）',
    'settings.sourceLabels.jma': '気象庁（氣象災害，Host 輪詢）',
    'settings.sourceLabels.usgs': 'USGS（全球地震目錄，Host 輪詢）',
    'settings.sourceLabels.noaa': 'NOAA（海嘯 CAP，Host 輪詢）',
    'settings.sourceLabels.nmc': '中央氣象台（大陸暴雨 / 地質災害預警，Host 輪詢）',
    'settings.sourceLabels.nws': 'NWS（美國洪水 / 山洪 / 沿海洪水，Client 直連）',
    'settings.sourceLabels.eccc': 'ECCC（加拿大降雨 / 風暴潮警報，Client 直連）',

    'settings.source.title': '來源狀態',
    'settings.source.keyValue': '{k}：{v}',
    'settings.source.secondsAgo': '{n} 秒前',
    'settings.source.dash': '—',
    'settings.source.notFetched': '尚未取得',
    'settings.source.receivedIncrements': '已收到 {n} 筆增量',
    'settings.source.localErrors': '，本機失敗 {n} 次',
    'settings.source.truncated': '，增量缺口 {n} 次',
    'settings.source.resets': '，讀取位置重設 {n} 次',
    'settings.source.hostErrors': '，Host 失敗 {n} 次',
    'settings.source.hostDetailDropped': '，Host 捨棄詳情 {n} 筆',
    'settings.source.lastFetch': ' · 最近取得 {ago}',
    'settings.source.notQueried': '尚未查詢',
    'settings.source.polls': '已查詢 {n} 輪',
    'settings.source.requests': ' · 請求 {n} 次',
    'settings.source.respondedItems': ' · 回應項目 {n} 筆',
    'settings.source.applied': '，交給主流程 {n} 筆',
    'settings.source.ageSkipped': '，過舊僅記錄 {n} 筆',
    'settings.source.rejected': '，被上游拒絕 {n} 次',
    'settings.source.overseasTruncated': '，上游結果被分頁上限截斷 {n} 輪',
    'settings.source.throttled': '，本輪超過上限略過 {n} 個請求',
    'settings.source.errors': '，失敗 {n} 次',
    'settings.source.lastQuery': ' · 最近查詢 {ago}',
    'settings.source.notStarted': '尚未啟動',
    'settings.source.modeSse': 'SSE 推送',
    'settings.source.modePoll': '已降級為輪詢',
    'settings.source.modeDisabled': '已關閉（「地震」開關關掉了）',
    'settings.source.modeIdle': '未連線',
    'settings.source.received': ' · 已收到 {n} 筆',
    'settings.source.broadcast': '，已播報 {n} 筆',
    'settings.source.fallbacks': '，降級 {n} 次',
    'settings.source.probeTimeouts': '，未收到資料 {n} 次',
    'settings.source.lastData': ' · 最近資料 {ago}',
    'settings.source.retry': '重試 {name} 的資料解析',

    // ---------- 地区分支与选项卡 ----------
    'settings.region.jp': '日本',
    'settings.region.cn': '中國大陸',
    'settings.region.global': '其他國家 / 地區',
    'settings.tab.region': '地區',
    'settings.tab.disaster': '災害',
    'settings.tab.notify': '通知',
    'settings.tab.history': '紀錄',
    'settings.tab.misc': '其他',

    // ---------- 关注地区：手填坐标与定位（全球分支 / 大陆分支共用） ----------
    'settings.place.latInvalid': '緯度需為 -90 ~ 90 之間的數字',
    'settings.place.lonInvalid': '經度需為 -180 ~ 180 之間的數字',
    'settings.place.radiusInvalid': '半徑需為 1 ~ 2000 km 之間的數字',
    'settings.place.max': '最多 {n} 個關注點',
    'settings.place.addedPrefix': '已新增「{name}」',
    'settings.place.addedDedupe': '（座標相同的重複點會自動合併）',
    'settings.place.geoUnsupportedPlace': '目前瀏覽器不支援定位，請手動填寫座標',
    'settings.place.geoUnsupportedCn': '目前瀏覽器不支援定位，請選擇省份與城市',
    'settings.place.locating': '正在取得目前位置…',
    'settings.place.geoNoCoords': '定位失敗：沒有傳回座標',
    'settings.place.myLocation': '我的位置',
    'settings.place.fillConfirm': '已填入目前位置，確認半徑後點「新增關注點」',
    'settings.place.geoFailed': '定位失敗：{reason}',
    'settings.place.geoDenied': '被拒絕或無法使用',
    'settings.place.myLocationAdded': '已新增「我的位置」（{lat}, {lon}，半徑 {radius} km）',
    'settings.place.geoImprecise': '定位可能不精確，請確認座標或改用手動選擇城市。',
    'settings.place.geoDenied2': '（也可以手動選擇省份與城市）',

    // ---------- 半径控件 ----------
    'settings.radius.label': '半徑',
    'settings.radius.custom': '自訂…',

    // ---------- 中国大陆的三级级联 ----------
    'settings.cn.pickRequired': '請先選擇省份與城市（行政區劃表未載入時請重新啟動 dsh web）',
    'settings.cn.exists': '「{name}」已經在關注清單裡了',
    'settings.cn.added': '已新增「{name}」（{lat}, {lon}，半徑 {radius} km）',
    'settings.cn.tableFailed': '行政區劃資料載入失敗，可以改用「其他國家 / 地區」手動填座標',
    'settings.cn.loading': '正在載入…',
    'settings.cn.provinceAll': '請選擇省份 / 直轄市 / 特別行政區',
    'settings.cn.cityFirstProvince': '（先選省份）',
    'settings.cn.provinceLabel': '一級行政區（省 / 自治區 / 直轄市）',
    'settings.cn.cityLabel': '城市',
    'settings.cn.addButton': '新增這個城市',
    'settings.cn.useMyLocation': '用我的位置',

    // ---------- 市区町村细化器 ----------
    'settings.cities.failed': '市區町村清單載入失敗，只能按都道府縣關注',
    'settings.retry': '重試',
    'settings.cities.pickPrefFirst': '先選都道府縣',
    'settings.cities.hint': '不選就是全縣。EEW 和海嘯只到縣一級。',
    'settings.cities.prefAll': '全縣',
    'settings.cities.prefSelected': '已選 {n} 個',
    'settings.cities.max': '最多 {n} 個市町村',
    'settings.cities.searchPlaceholder': '搜尋 {pref} 的市區町村…',
    'settings.cities.searchLabel': '搜尋 {pref} 的市區町村',
    'settings.cities.overLimit': '…共 {n} 個，請輸入關鍵字',

    // ---------- 已关注地区列表 ----------
    'settings.watch.prefMeta': '（{jp}）',
    'settings.watch.prefOrFull': ' · 全境',
    'settings.watch.prefDetail': ' · 已細分 {n} 個市區町村',
    'settings.watch.remove': '移除',
    'settings.watch.placeMeta': ' · 半徑 {radius} km',
    'settings.watch.title': '已關注（{n}）',
    'settings.watch.empty': '還沒有新增地區',
    'settings.watch.groupJp': '日本（按行政區）',
    'settings.watch.groupCn': '中國大陸（按行政區、座標）',
    'settings.watch.groupGlobal': '其他國家 / 地區（按座標、半徑）',
    'settings.watch.noneJp': '未選擇：全日本都會提醒',
    'settings.watch.noneOther': '還沒有新增',

    // ---------- 日本分支 ----------
    'settings.jp.hintAll': '不選的話，全日本的地震都會提醒',
    'settings.jp.hintSelected': '已選 {n} 個地區',

    // ---------- 中国大陆分支 ----------
    'settings.cnBranch.hint': '選城市就會用市中心的座標。面積大的州、市，把半徑調大一些。',
    'settings.cnBranch.warning': '⚠ 預警被撤銷或修改時不會另行通知。以中國地震台網發布為準。',
    'settings.cnBranch.foldTitle': '資料來源的局限',
    'settings.cnBranch.fold1': '沒有取消或最終報標誌：預警被上游撤銷或修改時，不會補一則「已作廢」。日本的地震速報和海嘯有這條流程，大陸源沒有。',
    'settings.cnBranch.fold2': '表裡的座標是行政區中心點，不是市政府所在地。面積大的州市（例如甘孜州、哈爾濱市）離城區可能差一百多公里。',
    'settings.cnBranch.fold3': '大陸預警請以中國地震台網（CENC）發布為準。',

    // ---------- 其他国家 / 地区分支 ----------
    'settings.global.cityFirst': '先選國家，再點城市。',
    'settings.global.cityFailed': '城市清單載入失敗，可以手動填座標，或重新啟動 dsh web 再試。',
    'settings.global.cityNotCovered': '沒有這個國家的城市清單（只收人口 10 萬以上的城鎮）。請用下面的座標輸入。',
    'settings.global.citySearchPlaceholder': '搜尋城市（共 {n} 個）',
    'settings.global.citySearchLabel': '搜尋城市',
    'settings.global.cityAddTitle': '新增 {label}',
    'settings.global.hint': '按位置和半徑匹配。不影響日本的地震、海嘯。',
    'settings.global.countryLabel': '國家 / 地區',
    'settings.global.countryAll': '請選擇國家 / 地區',
    'settings.global.countryLoading': '正在載入國家 / 地區清單…',
    'settings.global.countryOption': '{name}（{n} 個城市）',
    'settings.global.manualHint': '也可以直接填座標：',
    'settings.place.fieldName': '名稱',
    'settings.place.fieldNamePlaceholder': '例如 東京 / 家',
    'settings.place.fieldLat': '緯度',
    'settings.place.fieldLon': '經度',
    'settings.place.add': '新增關注點',
    'settings.place.useCurrentShort': '用目前位置',

    // ---------- 灾害类型与阈值 ----------
    'settings.section.watch': '關注地區',
    'settings.section.disaster': '災害類型與門檻',
    'settings.disaster.hint': '關閉後仍會記錄，只是不提示。',
    'settings.disaster.notifySwitch': '提醒',
    'settings.disaster.groupQuake': '地震',
    'settings.disaster.quakeJpLabel': '日本 · 實測震度',
    'settings.disaster.quakeJpNote': '當地觀測到的震度',
    'settings.disaster.quakeJpSelect': '日本地震（實測震度最低值）',
    'settings.disaster.eewLabel': '日本 · 緊急地震速報（EEW）',
    'settings.disaster.eewNote': '預測的震度',
    'settings.disaster.eewSelect': '緊急地震速報（預測震度最低值）',
    'settings.disaster.globalLabel': '全球 / 大陸地震預警',
    'settings.disaster.globalNote': '震央到關注點的距離',
    'settings.disaster.globalSelect': '全球與大陸地震預警（最低震級）',
    'settings.disaster.cnReportLabel': '大陸地震速報（CENC 目錄）',
    'settings.disaster.cnReportNote': '台網目錄，每天都有',
    'settings.disaster.cnReportSelect': '大陸地震速報（最低震級）',
    'settings.disaster.foldScaleTitle': '震度和震級為什麼分開設定',
    'settings.disaster.foldScale1': '日本給的是震度，全球和大陸給的是震級，兩者不能換算。',
    'settings.disaster.foldScale2': '大陸速報從 M2.5 起就有資料、每天都很多，所以門檻單獨設定，免得小震一直響。',
    'settings.disaster.groupTsunami': '海嘯',
    'settings.disaster.tsunamiJpLabel': '日本 · 全球（NOAA）',
    'settings.disaster.tsunamiJpNote': '全球源按關注點半徑判定',
    'settings.disaster.tsunamiSelect': '海嘯等級',
    'settings.disaster.groupWeatherJp': '氣象 · 日本（気象庁）',
    'settings.disaster.weatherJpLabel': '土石流 / 洪水 / 大雨 / 暴潮',
    'settings.disaster.weatherJpNote': '危險級別才播報',
    'settings.disaster.gateJma4': '警戒4級以上',
    'settings.disaster.groupWeatherCn': '氣象 · 中國大陸（中央氣象台）',
    'settings.disaster.cnRainstormSwitch': '暴雨預警',
    'settings.disaster.cnGeologySwitch': '地質災害預警',
    'settings.disaster.weatherCnLabel': '暴雨 / 地質災害',
    'settings.disaster.weatherCnNote': '橙色以上才播報',
    'settings.disaster.gateOrange': '橙色以上',
    'settings.disaster.groupWeatherOverseas': '氣象 · 海外（美國 NWS / 加拿大 ECCC）',
    'settings.disaster.weatherOverseasLabel': '洪水 / 山洪 / 降雨 / 風暴潮',
    'settings.disaster.weatherOverseasNote': '警告級才播報',
    'settings.disaster.gateOverseas': '警告級（美）· 黃色以上（加）',

    // ---------- 折叠：各数据源的取舍（安全相关 + 许可署名，一条都不能删） ----------
    'settings.disaster.foldTradeoffsTitle': '各資料來源的取捨',
    'settings.disaster.tradeoffCnTitle': '中國大陸氣象',
    'settings.disaster.tradeoffCn1': '只接暴雨和地質災害兩類。雷電、大風、高溫等不接，否則每天幾十則會洗版。',
    'settings.disaster.tradeoffCn2': '橙色以上才播報；黃色和藍色會記進「紀錄」，但不響鈴也不彈通知（勿擾時段也不放行橙色，只有紅色能穿透）。',
    'settings.disaster.tradeoffCn3': '匹配按行政區：只有在中國大陸分支裡選的省、市才算關注點，手填的座標不參與。機構名只到省級時（例如海南省直轄縣）按全省放行，寧可多報也不漏報。',
    'settings.disaster.tradeoffCn4': '這批資料沒有取消或最終報標誌：預警到期就直接從清單裡消失，所以沒收到取消不代表警報仍然有效。',
    'settings.disaster.tradeoffOverseasTitle': '海外氣象',
    'settings.disaster.tradeoffOverseas1': '關注點在「地區」頁的「其他國家 / 地區」裡設定。美國按郡和區劃判定，半徑 25km 以上時會額外查中心點周圍的幾個方向，所以半徑只是近似、不保證涵蓋半徑內的所有郡；加拿大把半徑換算成矩形範圍去查，與之相交的預警都算命中。',
    'settings.disaster.tradeoffOverseas2': '美國只播報 Flood / Flash Flood / Coastal Flood Warning，Watch、Advisory、Statement 只記錄。',
    'settings.disaster.tradeoffOverseas3': '加拿大只接 warning 類的降雨、洪水、風暴潮。霜凍和霧屬於 ECCC 的 advisory（官方定義就是「非危險天氣」）；大風、高溫、雷暴雖然是 warning，但不在本插件的災種範圍內。',
    'settings.disaster.tradeoffOverseas4': '打開頁面時，如果某則預警已經發布超過 6 小時，只記錄不響鈴；頁面休眠超過 30 分鐘再恢復時也按這條處理。',
    'settings.disaster.tradeoffOverseas5': '資料來源：美國國家氣象局（NWS）；加拿大環境與氣候變遷部（ECCC，Data Source: Environment and Climate Change Canada）。',
    'settings.disaster.weatherHint': '{label} 有 L{level} 氣象警報（未達播報級別）',

    // ---------- 通知与声音 ----------
    'settings.perm.granted': '通知權限：已授權',
    'settings.perm.denied': '通知權限：已被拒絕，請在瀏覽器網站設定裡允許',
    'settings.perm.default': '通知權限：未授權，點「測試系統通知」授權',
    'settings.perm.unsupported': '目前瀏覽器不支援系統通知',
    'settings.strip.received': '已收到 {n} 則推送',
    'settings.strip.more': '詳情在「其他」裡',
    'settings.section.language': '語言 / Language',
    'settings.language.label': '介面語言',
    'settings.section.source': '資料來源',
    'settings.source.prod': '正式（即時推送）',
    'settings.source.sandbox': '沙箱（回放 2023 年資料，測試用）',
    'settings.source.config': '設定：{value}',
    'settings.section.cnTransport': '大陸源鏈路',
    'settings.cnTransport.label': '取得方式',
    'settings.cnTransport.auto': '自動（優先推送）',
    'settings.cnTransport.poll': '強制輪詢（每 15 秒一次）',
    'settings.cnTransport.selectLabel': '大陸源取得方式',
    'settings.cnTransport.foldTitle': '什麼時候需要改成強制輪詢',
    'settings.cnTransport.fold1': 'SSE 推送的延遲是秒級，輪詢最壞 15 秒——大陸預警搶的就是這幾秒，所以預設用推送。',
    'settings.cnTransport.fold2': '只有在推送被網路中間設備反覆中斷、而一般請求仍然正常時，才需要強制輪詢。目前實際走在哪條路上，請看下方「來源狀態」。',
    'settings.section.notify': '通知與音效',
    'settings.notify.sound': '提示音',
    'settings.notify.soundQuake': '地震（含緊急地震速報）',
    'settings.notify.soundTsunami': '海嘯',
    'settings.notify.soundWeather': '氣象災害',
    'settings.notify.system': '系統通知',
    'settings.notify.volume': '音量',
    'settings.notify.testQuake': '試聽地震音',
    'settings.notify.testEew': '試聽 EEW 音',
    'settings.notify.testTsunami': '試聽海嘯音',
    'settings.notify.testWeather': '試聽氣象音',
    'settings.notify.testSystem': '測試系統通知',
    'settings.notify.testTitle': 'QuakeAlert 測試',
    'settings.notify.testBody': '這是一則測試系統通知。',
    'settings.notify.testSent': '已送出測試通知，請查看系統通知中心',
    'settings.notify.testFailed': '測試通知送出失敗',
    'settings.notify.toastBody': '頁面內彈窗運作正常。',
    'settings.notify.unsupportedTest': '目前瀏覽器不支援系統通知，無法測試',
    'settings.notify.deniedRetry': '通知權限已被拒絕 —— 請在瀏覽器網站設定中允許後重試',
    'settings.notify.notGranted': '未取得通知權限（瀏覽器未授權）',
    'settings.notify.testToast': '測試 Toast',
    'settings.notify.audioLocked': '⚠ 提示音還沒解鎖：點一下頁面任意位置就好。',
    'settings.notify.audioUnavailable': '目前環境不支援 Web Audio，提示音無法使用。',

    // ---------- 静默时段 ----------
    'settings.section.quiet': '勿擾時段',
    'settings.quiet.enable': '啟用勿擾時段',
    'settings.quiet.start': '開始',
    'settings.quiet.end': '結束',
    'settings.quiet.startLabel': '勿擾時段開始時間',
    'settings.quiet.endLabel': '勿擾時段結束時間',
    'settings.quiet.breakForSevere': '緊急警報仍會提醒（EEW、海嘯警報、震度6弱以上、氣象4級以上）',
    'settings.quiet.hint': '按瀏覽器本機時間判定。跨夜時段寫成 23:00–07:00。勿擾期間仍會記錄。',

    // ---------- 测试与诊断 ----------
    'settings.section.diag': '測試與診斷',
    'settings.diag.hint': '測試訊息不會連網，用來確認提醒是否正常。',
    'settings.diag.sendWeather': '傳送測試氣象警報',
    'settings.diag.parseFailed': '測試訊息解析失敗，請把這個情況回報給開發者',
    'settings.diag.outcomeSent': ' —— 已播報：應會看到提示音與彈窗',
    'settings.diag.outcomeNotSent': ' —— 未播報（{reason}），只會記入「紀錄」',
    'settings.diag.outcomeUnknown': '未知原因',
    'settings.diag.sentWeather': '已傳送：{label}（{pref} / 警戒レベル{level}，{note}）',
    'settings.diag.scenarios': '每次點擊換一個情境：{list}。',
    'settings.diag.scenario.landslide': '土石流警戒情報',
    'settings.diag.scenarioNote.landslide': '市區町村級 / 電文本身即 L4',
    'settings.diag.scenario.flood': '指定河川洪水予報（氾濫危険情報）',
    'settings.diag.scenarioNote.flood': '級別寫在主文裡',
    'settings.diag.scenario.heavyrain': '大雨危険警報',
    'settings.diag.scenarioNote.heavyrain': '級別寫在 Kind 名稱裡',
    'settings.diag.scenario.stormsurge': '高潮危険警報',
    'settings.diag.scenarioNote.stormsurge': '級別寫在 Kind 名稱裡',
    'settings.diag.scenario.landslide-l3': '土石流警報（警戒レベル3）',
    'settings.diag.scenarioNote.landslide-l3': '未達 L4：不播報',
    'settings.diag.scenario.emsc': 'EMSC 地震（震央就在關注點）',
    'settings.diag.scenarioNote.emsc': 'M6.2',
    'settings.diag.scenario.usgs': 'USGS 地震（約 80km 外）',
    'settings.diag.scenarioNote.usgs': 'M5.6 · 近處，小半徑也可能不命中',
    'settings.diag.scenario.noaa': 'NOAA 海嘯警報',
    'settings.diag.scenarioNote.noaa': 'Tsunami Advisory',
    'settings.diag.scenario.emsc-far': 'EMSC 遠地地震（約 550km 外）',
    'settings.diag.scenarioNote.emsc-far': 'M7.0 · 用於示範半徑：半徑 < 550km 時不命中',
    'settings.diag.sendGlobal': '傳送測試全球警報',
    'settings.diag.needPlace': '請先在「地區」裡新增一個位置，測試訊息需要一個震央',
    'settings.diag.sentGlobal': '已傳送：{label}（{note}）',
    'settings.diag.globalScenarios': '每次點擊換一個情境：{list}。最後一則在約 550km 外，用來示範半徑的作用。',
    'settings.diag.snapshotHint': '把快照傳給 AI 助手，配合 TROUBLESHOOTING.zh.md 排查。',
    'settings.diag.snapshotButton': '產生診斷快照',
    'settings.diag.copied': '已複製到剪貼簿。',
    'settings.diag.copiedWithWarning': '已複製到剪貼簿，但產生快照時發生異常：{warning}',
    'settings.diag.clipboardUnavailable': '剪貼簿無法使用',
    'settings.diag.clipboardError': '（{error}）',
    'settings.diag.copyManual': '，請手動全選下面的文字複製。',
    'settings.diag.generatingFailed': '產生失敗：{error}',
    'settings.diag.snapshotWarn': '⚠ 包含你關注的地區和座標，分享前請注意。',

    // ---------- 免责声明 ----------
    'settings.section.disclaimer': '免責聲明',
    'settings.disclaimer.short': '僅供參考。避難請以當地官方發布為準。頁面關閉後不會再提醒。',
    'settings.disclaimer.foldTitle': '資料來源與完整聲明',
    'settings.disclaimer.source': '預警資料由 P2PQuake 轉播、日本氣象廳公開 XML 電文、EMSC / USGS / NOAA、美國國家氣象局（NWS）與加拿大環境與氣候變遷部（ECCC）的公開介面（瀏覽器直連），以及 Wolfx 轉播的中國地震台網（CENC）資訊提供，均非官方直接推送；緊急地震速報（EEW）與大陸地震預警等內容與配信品質無保證。',
    'settings.disclaimer.authority': '避難請以當地主管機構（日本氣象廳 気象庁 / 中國地震台網 CENC / 美國 NWS・USGS・NOAA / 加拿大 ECCC 等）官方發布為準。',

    // ---------- 预警记录（履历） ----------
    'settings.section.history': '預警紀錄（{n} 則）',
    'settings.history.hint': '沒到門檻、沒有提醒的紀錄也在裡面。點開看詳情。',
    'settings.history.empty': '暫無紀錄',
    'settings.history.statusHit': '未觸發提醒',
    'settings.history.statusSuppressed': '未重複提醒',
    'settings.history.statusPrefHit': '命中 {pref}',
    'settings.history.statusAlerted': '已提醒',
    'settings.history.toggleCollapse': '點擊收合（Enter / 空白鍵同樣可用）',
    'settings.history.toggleExpand': '點擊展開詳情（Enter / 空白鍵同樣可用）',
    'settings.history.collapse': '▲ 收合',
    'settings.history.expand': '▼ 展開',
    'settings.history.fieldKind': '類型',
    'settings.history.fieldTime': '時間',
    'settings.history.fieldPref': '命中',
    'settings.history.fieldNote': '說明',
    'settings.history.fieldContent': '內容',
    'settings.history.fieldDetail': '內文',
    'settings.history.kindValue': '{label}（{code}）',
    'settings.history.clear': '清除紀錄',
  },

  ja: {
    'settings.status.idle': '未起動',
    'settings.status.connecting': '接続中…',
    'settings.status.open': '接続済み',
    'settings.status.reconnecting': '再接続中（{n} 回目）',
    'settings.status.closed': '停止',
    'settings.status.unreachable': '接続できません',
    'settings.status.degraded': '経路が劣化',
    'settings.status.stale': 'データが古い',
    'settings.status.schemaError': 'データ形式の異常',
    'settings.status.disabled': 'オフ',
    'settings.status.raw': '{status}',

    'settings.storage.host': 'この端末に保存（settings.yaml）',
    'settings.storage.memory': 'このブラウザ内だけに保存',
    'settings.storage.local': 'ブラウザのローカルストレージ',

    'settings.sourceLabels.p2pquake': 'P2PQuake（日本の地震 / EEW / 津波、リアルタイム配信）',
    'settings.sourceLabels.emsc': 'EMSC（全球の地震、リアルタイム配信）',
    'settings.sourceLabels.cencEew': '中国大陸の地震予警（CENC、SSE 配信）',
    'settings.sourceLabels.cencEqlist': '中国大陸の地震速報（CENC、SSE 配信）',
    'settings.sourceLabels.jma': '気象庁（気象災害、Host ポーリング）',
    'settings.sourceLabels.usgs': 'USGS（全球の地震カタログ、Host ポーリング）',
    'settings.sourceLabels.noaa': 'NOAA（津波 CAP、Host ポーリング）',
    'settings.sourceLabels.nmc': '中国気象台（中国大陸の大雨 / 地質災害警報、Host ポーリング）',
    'settings.sourceLabels.nws': 'NWS（米国の洪水 / 鉄砲水 / 沿岸洪水、Client 直結）',
    'settings.sourceLabels.eccc': 'ECCC（カナダの降雨 / 高潮警報、Client 直結）',

    'settings.source.title': 'データ源の状態',
    'settings.source.keyValue': '{k}：{v}',
    'settings.source.secondsAgo': '{n} 秒前',
    'settings.source.dash': '—',
    'settings.source.notFetched': '未取得',
    'settings.source.receivedIncrements': '受信 {n} 件',
    'settings.source.localErrors': '、ローカル失敗 {n} 回',
    'settings.source.truncated': '、欠落 {n} 回',
    'settings.source.resets': '、読み取り位置の初期化 {n} 回',
    'settings.source.hostErrors': '、Host 失敗 {n} 回',
    'settings.source.hostDetailDropped': '、Host が詳細を破棄 {n} 件',
    'settings.source.lastFetch': ' · 最終取得 {ago}',
    'settings.source.notQueried': '未照会',
    'settings.source.polls': '{n} 回照会',
    'settings.source.requests': ' · リクエスト {n} 回',
    'settings.source.respondedItems': ' · 応答 {n} 件',
    'settings.source.applied': '、本体処理へ {n} 件',
    'settings.source.ageSkipped': '、古すぎて履歴のみ {n} 件',
    'settings.source.rejected': '、上流に拒否 {n} 回',
    'settings.source.overseasTruncated': '、上流の結果が上限で打ち切り {n} 回',
    'settings.source.throttled': '、今回の上限超過でスキップ {n} 件',
    'settings.source.errors': '、失敗 {n} 回',
    'settings.source.lastQuery': ' · 最終照会 {ago}',
    'settings.source.notStarted': '未開始',
    'settings.source.modeSse': 'SSE 配信',
    'settings.source.modePoll': 'ポーリングに降格',
    'settings.source.modeDisabled': 'オフ（「地震」スイッチが切）',
    'settings.source.modeIdle': '未接続',
    'settings.source.received': ' · 受信 {n} 件',
    'settings.source.broadcast': '、通知 {n} 件',
    'settings.source.fallbacks': '、降格 {n} 回',
    'settings.source.probeTimeouts': '、初回データなし {n} 回',
    'settings.source.lastData': ' · 最終データ {ago}',
    'settings.source.retry': '{name} のデータ解析を再試行',

    'settings.region.jp': '日本',
    'settings.region.cn': '中国大陸',
    'settings.region.global': 'その他の国・地域',
    'settings.tab.region': '地域',
    'settings.tab.disaster': '災害',
    'settings.tab.notify': '通知',
    'settings.tab.history': '履歴',
    'settings.tab.misc': 'その他',

    'settings.place.latInvalid': '緯度は -90 〜 90 の数値で入力してください',
    'settings.place.lonInvalid': '経度は -180 〜 180 の数値で入力してください',
    'settings.place.radiusInvalid': '半径は 1 〜 2000 km の数値で入力してください',
    'settings.place.max': '登録できる地点は最大 {n} 件です',
    'settings.place.addedPrefix': '「{name}」を追加しました',
    'settings.place.addedDedupe': '（座標が同じ地点は自動的にまとめられます）',
    'settings.place.geoUnsupportedPlace': 'このブラウザは位置情報に対応していません。座標を手入力してください',
    'settings.place.geoUnsupportedCn': 'このブラウザは位置情報に対応していません。省と都市を選んでください',
    'settings.place.locating': '現在地を取得しています…',
    'settings.place.geoNoCoords': '位置情報の取得に失敗しました：座標が返されませんでした',
    'settings.place.myLocation': '現在地',
    'settings.place.fillConfirm': '現在地を入力しました。半径を確認して「地点を追加」を押してください',
    'settings.place.geoFailed': '位置情報の取得に失敗しました：{reason}',
    'settings.place.geoDenied': '拒否されたか利用できません',
    'settings.place.myLocationAdded': '「現在地」を追加しました（{lat}, {lon}、半径 {radius} km）',
    'settings.place.geoImprecise': '位置情報は誤差を含む場合があります。座標を確認するか、都市を手動で選んでください。',
    'settings.place.geoDenied2': '（省と都市を手動で選ぶこともできます）',

    'settings.radius.label': '半径',
    'settings.radius.custom': 'カスタム…',

    'settings.cn.pickRequired': '先に省と都市を選んでください（行政区画表が未読み込みの場合は dsh web を再起動してください）',
    'settings.cn.exists': '「{name}」はすでに登録されています',
    'settings.cn.added': '「{name}」を追加しました（{lat}, {lon}、半径 {radius} km）',
    'settings.cn.tableFailed': '行政区画データを読み込めませんでした。「その他の国・地域」で座標を手入力してください',
    'settings.cn.loading': '読み込み中…',
    'settings.cn.provinceAll': '省 / 直轄市 / 特別行政区を選択',
    'settings.cn.cityFirstProvince': '（先に省を選択）',
    'settings.cn.provinceLabel': '第一級行政区（省 / 自治区 / 直轄市）',
    'settings.cn.cityLabel': '都市',
    'settings.cn.addButton': 'この都市を追加',
    'settings.cn.useMyLocation': '現在地を使う',

    'settings.cities.failed': '市区町村の一覧を読み込めませんでした。都道府県単位でのみ登録できます',
    'settings.retry': '再試行',
    'settings.cities.pickPrefFirst': '先に都道府県を選んでください',
    'settings.cities.hint': '未選択なら県全体です。緊急地震速報と津波は県単位までです。',
    'settings.cities.prefAll': '県全体',
    'settings.cities.prefSelected': '{n} 件選択',
    'settings.cities.max': '登録できる市区町村は最大 {n} 件です',
    'settings.cities.searchPlaceholder': '{pref} の市区町村を検索…',
    'settings.cities.searchLabel': '{pref} の市区町村を検索',
    'settings.cities.overLimit': '…全 {n} 件です。キーワードを入力してください',

    'settings.watch.prefMeta': '（{jp}）',
    'settings.watch.prefOrFull': ' · 全域',
    'settings.watch.prefDetail': ' · 市区町村 {n} 件',
    'settings.watch.remove': '削除',
    'settings.watch.placeMeta': ' · 半径 {radius} km',
    'settings.watch.title': '登録済み（{n}）',
    'settings.watch.empty': 'まだ登録がありません',
    'settings.watch.groupJp': '日本（行政区単位）',
    'settings.watch.groupCn': '中国大陸（行政区・座標）',
    'settings.watch.groupGlobal': 'その他の国・地域（座標・半径）',
    'settings.watch.noneJp': '未選択：日本全国で通知します',
    'settings.watch.noneOther': 'まだ登録がありません',

    'settings.jp.hintAll': '未選択なら、日本全国の地震を通知します',
    'settings.jp.hintSelected': '{n} 件の地域を選択中',

    'settings.cnBranch.hint': '都市を選ぶと市中心部の座標を使います。面積の広い州・市では半径を大きめにしてください。',
    'settings.cnBranch.warning': '⚠ 警報が取消・変更されても別途通知しません。中国地震台網の発表をご確認ください。',
    'settings.cnBranch.foldTitle': 'データ源の限界',
    'settings.cnBranch.fold1': '取消・最終報のフラグがありません：警報が上流で取消・変更されても「無効」という追記は届きません。日本の地震速報と津波にはこの経路がありますが、中国大陸の源にはありません。',
    'settings.cnBranch.fold2': '表の座標は行政区の中心点で、市役所の位置ではありません。面積の広い州・市（甘孜州、ハルビン市など）では市街地と 100 km 以上離れることがあります。',
    'settings.cnBranch.fold3': '中国大陸の警報は中国地震台網（CENC）の発表をご確認ください。',

    'settings.global.cityFirst': '先に国を選び、そのあと都市を選んでください。',
    'settings.global.cityFailed': '都市一覧を読み込めませんでした。座標を手入力するか、dsh web を再起動してください。',
    'settings.global.cityNotCovered': 'この国の都市一覧はありません（人口 10 万人以上の都市のみ収録）。下の座標入力を使ってください。',
    'settings.global.citySearchPlaceholder': '都市を検索（全 {n} 件）',
    'settings.global.citySearchLabel': '都市を検索',
    'settings.global.cityAddTitle': '{label} を追加',
    'settings.global.hint': '位置と半径で照合します。日本の地震・津波には影響しません。',
    'settings.global.countryLabel': '国・地域',
    'settings.global.countryAll': '国・地域を選択',
    'settings.global.countryLoading': '国・地域の一覧を読み込み中…',
    'settings.global.countryOption': '{name}（{n} 都市）',
    'settings.global.manualHint': '座標を直接入力することもできます：',
    'settings.place.fieldName': '名前',
    'settings.place.fieldNamePlaceholder': '例：東京 / 自宅',
    'settings.place.fieldLat': '緯度',
    'settings.place.fieldLon': '経度',
    'settings.place.add': '地点を追加',
    'settings.place.useCurrentShort': '現在地を使う',

    'settings.section.watch': '登録地域',
    'settings.section.disaster': '災害の種類としきい値',
    'settings.disaster.hint': 'オフでも記録は残り、通知だけを行いません。',
    'settings.disaster.notifySwitch': '通知',
    'settings.disaster.groupQuake': '地震',
    'settings.disaster.quakeJpLabel': '日本 · 観測震度',
    'settings.disaster.quakeJpNote': '現地で観測された震度',
    'settings.disaster.quakeJpSelect': '日本地震（観測震度の下限）',
    'settings.disaster.eewLabel': '日本 · 緊急地震速報（EEW）',
    'settings.disaster.eewNote': '予測震度',
    'settings.disaster.eewSelect': '緊急地震速報（予測震度の下限）',
    'settings.disaster.globalLabel': '世界 / 中国大陸の地震警報',
    'settings.disaster.globalNote': '震源から登録地点までの距離',
    'settings.disaster.globalSelect': '世界と中国大陸の地震警報（マグニチュードの下限）',
    'settings.disaster.cnReportLabel': '中国大陸の地震速報（CENC 目録）',
    'settings.disaster.cnReportNote': '台網の目録、毎日あり',
    'settings.disaster.cnReportSelect': '中国大陸の地震速報（マグニチュードの下限）',
    'settings.disaster.foldScaleTitle': '震度とマグニチュードを分けている理由',
    'settings.disaster.foldScale1': '日本は震度、世界と中国大陸はマグニチュードで発表され、両者は換算できません。',
    'settings.disaster.foldScale2': '中国大陸の速報は M2.5 からデータがあり毎日多いため、しきい値を別にして小さな地震で鳴り続けないようにしています。',
    'settings.disaster.groupTsunami': '津波',
    'settings.disaster.tsunamiJpLabel': '日本 · 世界（NOAA）',
    'settings.disaster.tsunamiJpNote': '世界の源は登録地点の半径で判定します',
    'settings.disaster.tsunamiSelect': '津波の等級',
    'settings.disaster.groupWeatherJp': '気象 · 日本（気象庁）',
    'settings.disaster.weatherJpLabel': '土砂災害 / 洪水 / 大雨 / 高潮',
    'settings.disaster.weatherJpNote': '危険なレベルでのみ通知',
    'settings.disaster.gateJma4': '警戒レベル4以上',
    'settings.disaster.groupWeatherCn': '気象 · 中国大陸（中央気象台）',
    'settings.disaster.cnRainstormSwitch': '大雨警報',
    'settings.disaster.cnGeologySwitch': '地質災害警報',
    'settings.disaster.weatherCnLabel': '大雨 / 地質災害',
    'settings.disaster.weatherCnNote': '橙色以上でのみ通知',
    'settings.disaster.gateOrange': '橙色以上',
    'settings.disaster.groupWeatherOverseas': '気象 · 海外（米国 NWS / カナダ ECCC）',
    'settings.disaster.weatherOverseasLabel': '洪水 / 鉄砲水 / 降雨 / 高潮',
    'settings.disaster.weatherOverseasNote': '警報級でのみ通知',
    'settings.disaster.gateOverseas': '警報級（米）· 黄色以上（加）',

    'settings.disaster.foldTradeoffsTitle': 'データ源ごとの取捨',
    'settings.disaster.tradeoffCnTitle': '中国大陸の気象',
    'settings.disaster.tradeoffCn1': '大雨と地質災害の 2 種類のみです。雷電・強風・高温などは扱いません（毎日数十件になり画面が埋まるため）。',
    'settings.disaster.tradeoffCn2': '橙色以上でのみ通知します。黄色と青色は「履歴」に残るだけで、音も通知も出しません（おやすみ時間でも橙色は通さず、赤色のみ通します）。',
    'settings.disaster.tradeoffCn3': '照合は行政区単位です。中国大陸の区分で選んだ省・市だけが登録地点となり、手入力の座標は関与しません。発表機関名が省級までの場合（海南省の直轄県など）は全省で通し、通知が多い側に倒します。',
    'settings.disaster.tradeoffCn4': 'このデータには取消・最終報のフラグがありません：警報は期限が来ると一覧から消えるため、取消が届かないことは警報が有効という意味ではありません。',
    'settings.disaster.tradeoffOverseasTitle': '海外の気象',
    'settings.disaster.tradeoffOverseas1': '登録地点は「地域」ページの「その他の国・地域」で設定します。米国は郡と区画で判定し、半径 25km 以上のときは中心点の周囲も追加で照会するため、半径は近似でしかなく範囲内のすべての郡を網羅する保証はありません。カナダは半径を矩形範囲に換算して照会し、交差する警報をすべて命中とします。',
    'settings.disaster.tradeoffOverseas2': '米国は Flood / Flash Flood / Coastal Flood Warning のみ通知し、Watch・Advisory・Statement は記録のみです。',
    'settings.disaster.tradeoffOverseas3': 'カナダは warning クラスの降雨・洪水・高潮のみ扱います。霜と霧は ECCC の advisory（公式定義が「危険でない天気」）です。強風・高温・雷雨は warning ですが、本プラグインの対象災害ではありません。',
    'settings.disaster.tradeoffOverseas4': 'ページを開いた時点で発表から 6 時間を超えている警報は、記録のみで音は鳴らしません。ページが 30 分以上休止して復帰した場合も同じ扱いです。',
    'settings.disaster.tradeoffOverseas5': 'データ源：米国国立気象局（NWS）、カナダ環境・気候変動省（ECCC、Data Source: Environment and Climate Change Canada）。',
    'settings.disaster.weatherHint': '{label} に L{level} の気象警報があります（通知基準未満）',

    'settings.perm.granted': '通知の許可：あり',
    'settings.perm.denied': '通知の許可：拒否されています。ブラウザのサイト設定で許可してください',
    'settings.perm.default': '通知の許可：未許可。「システム通知をテスト」で許可できます',
    'settings.perm.unsupported': 'このブラウザはシステム通知に対応していません',
    'settings.strip.received': '受信 {n} 件',
    'settings.strip.more': '詳細は「その他」にあります',
    'settings.section.language': '言語 / Language',
    'settings.language.label': '表示言語',
    'settings.section.source': 'データ源',
    'settings.source.prod': '本番（リアルタイム配信）',
    'settings.source.sandbox': 'サンドボックス（2023 年データの再生、テスト用）',
    'settings.source.config': '設定：{value}',
    'settings.section.cnTransport': '中国大陸源の経路',
    'settings.cnTransport.label': '取得方法',
    'settings.cnTransport.auto': '自動（配信を優先）',
    'settings.cnTransport.poll': 'ポーリングを強制（15 秒ごと）',
    'settings.cnTransport.selectLabel': '中国大陸源の取得方法',
    'settings.cnTransport.foldTitle': 'ポーリング強制が必要になるのはどんなときか',
    'settings.cnTransport.fold1': 'SSE 配信の遅延は秒単位、ポーリングは最悪 15 秒です。中国大陸の警報はこの数秒が勝負なので、既定では配信を使います。',
    'settings.cnTransport.fold2': '配信がネットワーク機器に繰り返し切断され、通常のリクエストは正常な場合にのみポーリング強制が必要です。現在どちらの経路にいるかは下の「データ源の状態」で確認できます。',
    'settings.section.notify': '通知とサウンド',
    'settings.notify.sound': '通知音',
    'settings.notify.soundQuake': '地震（緊急地震速報を含む）',
    'settings.notify.soundTsunami': '津波',
    'settings.notify.soundWeather': '気象災害',
    'settings.notify.system': 'システム通知',
    'settings.notify.volume': '音量',
    'settings.notify.testQuake': '地震音を試聴',
    'settings.notify.testEew': 'EEW 音を試聴',
    'settings.notify.testTsunami': '津波音を試聴',
    'settings.notify.testWeather': '気象音を試聴',
    'settings.notify.testSystem': 'システム通知をテスト',
    'settings.notify.testTitle': 'QuakeAlert テスト',
    'settings.notify.testBody': 'これはテストのシステム通知です。',
    'settings.notify.testSent': 'テスト通知を送信しました。システムの通知センターをご確認ください',
    'settings.notify.testFailed': 'テスト通知の送信に失敗しました',
    'settings.notify.toastBody': 'ページ内のポップアップは正常に動作しています。',
    'settings.notify.unsupportedTest': 'このブラウザはシステム通知に対応していないため、テストできません',
    'settings.notify.deniedRetry': '通知が拒否されています —— ブラウザのサイト設定で許可してから再試行してください',
    'settings.notify.notGranted': '通知の許可が得られませんでした（ブラウザが許可していません）',
    'settings.notify.testToast': 'Toast をテスト',
    'settings.notify.audioLocked': '⚠ 通知音はまだ有効になっていません：ページのどこかを一度クリックしてください。',
    'settings.notify.audioUnavailable': 'この環境は Web Audio に対応していないため、通知音は使えません。',

    'settings.section.quiet': 'おやすみ時間',
    'settings.quiet.enable': 'おやすみ時間を有効にする',
    'settings.quiet.start': '開始',
    'settings.quiet.end': '終了',
    'settings.quiet.startLabel': 'おやすみ時間の開始時刻',
    'settings.quiet.endLabel': 'おやすみ時間の終了時刻',
    'settings.quiet.breakForSevere': '緊急の警報は通知する（EEW、津波警報、震度6弱以上、気象レベル4以上）',
    'settings.quiet.hint': 'ブラウザのローカル時刻で判定します。日をまたぐ場合は 23:00–07:00 のように指定します。おやすみ時間中も記録は残ります。',

    'settings.section.diag': 'テストと診断',
    'settings.diag.hint': 'テストメッセージは通信しません。通知が正常かを確かめるためのものです。',
    'settings.diag.sendWeather': 'テスト気象警報を送信',
    'settings.diag.parseFailed': 'テストメッセージの解析に失敗しました。この状況を開発者に知らせてください',
    'settings.diag.outcomeSent': ' —— 通知しました：通知音とポップアップが出るはずです',
    'settings.diag.outcomeNotSent': ' —— 通知しませんでした（{reason}）。「履歴」にのみ記録されます',
    'settings.diag.outcomeUnknown': '不明な理由',
    'settings.diag.sentWeather': '送信しました：{label}（{pref} / 警戒レベル{level}、{note}）',
    'settings.diag.scenarios': 'クリックごとに場面が変わります：{list}。',
    'settings.diag.scenario.landslide': '土砂災害警戒情報',
    'settings.diag.scenarioNote.landslide': '市町村単位 / 電文自体が L4',
    'settings.diag.scenario.flood': '指定河川洪水予報（氾濫危険情報）',
    'settings.diag.scenarioNote.flood': 'レベルは本文に記載',
    'settings.diag.scenario.heavyrain': '大雨危険警報',
    'settings.diag.scenarioNote.heavyrain': 'レベルは Kind 名に記載',
    'settings.diag.scenario.stormsurge': '高潮危険警報',
    'settings.diag.scenarioNote.stormsurge': 'レベルは Kind 名に記載',
    'settings.diag.scenario.landslide-l3': '土砂災害警報（警戒レベル3）',
    'settings.diag.scenarioNote.landslide-l3': 'L4 未満：通知しません',
    'settings.diag.scenario.emsc': 'EMSC の地震（震源が登録地点そのもの）',
    'settings.diag.scenarioNote.emsc': 'M6.2',
    'settings.diag.scenario.usgs': 'USGS の地震（約 80km 離れている）',
    'settings.diag.scenarioNote.usgs': 'M5.6 · 近いため、半径が小さいと命中しないことも',
    'settings.diag.scenario.noaa': 'NOAA 津波警報',
    'settings.diag.scenarioNote.noaa': 'Tsunami Advisory',
    'settings.diag.scenario.emsc-far': 'EMSC の遠地地震（約 550km 離れている）',
    'settings.diag.scenarioNote.emsc-far': 'M7.0 · 半径のデモ用：半径 < 550km では命中しません',
    'settings.diag.sendGlobal': 'テストの世界警報を送信',
    'settings.diag.needPlace': '先に「地域」で地点を追加してください。テストメッセージには震源が必要です',
    'settings.diag.sentGlobal': '送信しました：{label}（{note}）',
    'settings.diag.globalScenarios': 'クリックごとに場面が変わります：{list}。最後の 1 件は約 550km 離れた地点で、半径の働きを示すためのものです。',
    'settings.diag.snapshotHint': 'スナップショットを AI アシスタントに渡し、TROUBLESHOOTING.zh.md とあわせて調べてください。',
    'settings.diag.snapshotButton': '診断スナップショットを生成',
    'settings.diag.copied': 'クリップボードにコピーしました。',
    'settings.diag.copiedWithWarning': 'クリップボードにコピーしましたが、スナップショット生成時に例外がありました：{warning}',
    'settings.diag.clipboardUnavailable': 'クリップボードを利用できません',
    'settings.diag.clipboardError': '（{error}）',
    'settings.diag.copyManual': '。下のテキストを全選択して手動でコピーしてください。',
    'settings.diag.generatingFailed': '生成に失敗しました：{error}',
    'settings.diag.snapshotWarn': '⚠ 登録している地域と座標が含まれます。共有の際はご注意ください。',

    'settings.section.disclaimer': '免責事項',
    'settings.disclaimer.short': '参考情報です。避難は現地の公式発表に従ってください。ページを閉じると通知されなくなります。',
    'settings.disclaimer.foldTitle': 'データ源と全文の声明',
    'settings.disclaimer.source': '警報データは、P2PQuake の転送、気象庁が公開する XML 電文、EMSC / USGS / NOAA、米国国立気象局（NWS）とカナダ環境・気候変動省（ECCC）の公開インターフェース（ブラウザ直結）、および Wolfx が転送する中国地震台網（CENC）の情報によるもので、いずれも公式の直接配信ではありません。緊急地震速報（EEW）と中国大陸の地震警報などの内容と配信品質は保証されません。',
    'settings.disclaimer.authority': '避難は現地の主管機関（気象庁 / 中国地震台網 CENC / 米国 NWS・USGS・NOAA / カナダ ECCC など）の公式発表に従ってください。',

    'settings.section.history': '警報の記録（{n} 件）',
    'settings.history.hint': 'しきい値に達せず通知しなかった記録も含まれます。クリックで詳細を表示します。',
    'settings.history.empty': '記録はありません',
    'settings.history.statusHit': '通知せず',
    'settings.history.statusSuppressed': '重複通知せず',
    'settings.history.statusPrefHit': '命中 {pref}',
    'settings.history.statusAlerted': '通知済み',
    'settings.history.toggleCollapse': 'クリックで閉じる（Enter / スペースも可）',
    'settings.history.toggleExpand': 'クリックで詳細を表示（Enter / スペースも可）',
    'settings.history.collapse': '▲ 閉じる',
    'settings.history.expand': '▼ 展開',
    'settings.history.fieldKind': '種類',
    'settings.history.fieldTime': '時刻',
    'settings.history.fieldPref': '命中',
    'settings.history.fieldNote': '説明',
    'settings.history.fieldContent': '内容',
    'settings.history.fieldDetail': '本文',
    'settings.history.kindValue': '{label}（{code}）',
    'settings.history.clear': '記録を消去',
  },

  en: {
    'settings.status.idle': 'Not started',
    'settings.status.connecting': 'Connecting…',
    'settings.status.open': 'Connected',
    'settings.status.reconnecting': 'Reconnecting (attempt {n})',
    'settings.status.closed': 'Stopped',
    'settings.status.unreachable': 'Cannot connect',
    'settings.status.degraded': 'Degraded link',
    'settings.status.stale': 'Data is stale',
    'settings.status.schemaError': 'Unexpected data format',
    'settings.status.disabled': 'Off',
    'settings.status.raw': '{status}',

    'settings.storage.host': 'Saved on this machine (settings.yaml)',
    'settings.storage.memory': 'Kept in this browser only',
    'settings.storage.local': 'Browser local storage',

    'settings.sourceLabels.p2pquake': 'P2PQuake (Japan quakes / EEW / tsunami, live push)',
    'settings.sourceLabels.emsc': 'EMSC (global earthquakes, live push)',
    'settings.sourceLabels.cencEew': 'Mainland China earthquake warning (CENC, SSE push)',
    'settings.sourceLabels.cencEqlist': 'Mainland China earthquake report (CENC, SSE push)',
    'settings.sourceLabels.jma': 'JMA (weather hazards, Host polling)',
    'settings.sourceLabels.usgs': 'USGS (global earthquake catalogue, Host polling)',
    'settings.sourceLabels.noaa': 'NOAA (tsunami CAP, Host polling)',
    'settings.sourceLabels.nmc': 'CMA (mainland China rainstorm / geological hazard alerts, Host polling)',
    'settings.sourceLabels.nws': 'NWS (U.S. flood / flash flood / coastal flood, direct from client)',
    'settings.sourceLabels.eccc': 'ECCC (Canada rainfall / storm surge alerts, direct from client)',

    'settings.source.title': 'Source status',
    'settings.source.keyValue': '{k}: {v}',
    'settings.source.secondsAgo': '{n}s ago',
    'settings.source.dash': '—',
    'settings.source.notFetched': 'Not fetched yet',
    'settings.source.receivedIncrements': 'Received {n} updates',
    'settings.source.localErrors': ', {n} local failures',
    'settings.source.truncated': ', {n} gaps',
    'settings.source.resets': ', {n} position resets',
    'settings.source.hostErrors': ', {n} host failures',
    'settings.source.hostDetailDropped': ', {n} details dropped by host',
    'settings.source.lastFetch': ' · Last fetch {ago}',
    'settings.source.notQueried': 'Not queried yet',
    'settings.source.polls': '{n} polls',
    'settings.source.requests': ' · {n} requests',
    'settings.source.respondedItems': ' · {n} items returned',
    'settings.source.applied': ', {n} passed to pipeline',
    'settings.source.ageSkipped': ', {n} too old, history only',
    'settings.source.rejected': ', {n} rejected upstream',
    'settings.source.overseasTruncated': ', {n} truncated by page limit',
    'settings.source.throttled': ', {n} requests skipped over limit',
    'settings.source.errors': ', {n} failures',
    'settings.source.lastQuery': ' · Last query {ago}',
    'settings.source.notStarted': 'Not started',
    'settings.source.modeSse': 'SSE stream',
    'settings.source.modePoll': 'Fell back to polling',
    'settings.source.modeDisabled': 'Off (the earthquake switch is off)',
    'settings.source.modeIdle': 'Not connected',
    'settings.source.received': ' · {n} received',
    'settings.source.broadcast': ', {n} alerted',
    'settings.source.fallbacks': ', {n} fallbacks',
    'settings.source.probeTimeouts': ', {n} with no data received',
    'settings.source.lastData': ' · Last data {ago}',
    'settings.source.retry': 'Retry parsing {name} data',

    'settings.region.jp': 'Japan',
    'settings.region.cn': 'Mainland China',
    'settings.region.global': 'Other countries / regions',
    'settings.tab.region': 'Regions',
    'settings.tab.disaster': 'Hazards',
    'settings.tab.notify': 'Alerts',
    'settings.tab.history': 'History',
    'settings.tab.misc': 'More',

    'settings.place.latInvalid': 'Latitude must be a number between -90 and 90',
    'settings.place.lonInvalid': 'Longitude must be a number between -180 and 180',
    'settings.place.radiusInvalid': 'Radius must be a number between 1 and 2000 km',
    'settings.place.max': 'At most {n} watch locations',
    'settings.place.addedPrefix': 'Added "{name}"',
    'settings.place.addedDedupe': ' (locations with the same coordinates are merged)',
    'settings.place.geoUnsupportedPlace': 'This browser has no location support. Enter coordinates manually.',
    'settings.place.geoUnsupportedCn': 'This browser has no location support. Pick a province and city.',
    'settings.place.locating': 'Getting your location…',
    'settings.place.geoNoCoords': 'Location failed: no coordinates returned',
    'settings.place.myLocation': 'My location',
    'settings.place.fillConfirm': 'Location filled in. Check the radius, then click "Add location".',
    'settings.place.geoFailed': 'Location failed: {reason}',
    'settings.place.geoDenied': 'denied or unavailable',
    'settings.place.myLocationAdded': 'Added "My location" ({lat}, {lon}, radius {radius} km)',
    'settings.place.geoImprecise': 'Location may be imprecise. Check the coordinates or pick a city manually.',
    'settings.place.geoDenied2': ' (you can also pick a province and city manually)',

    'settings.radius.label': 'Radius',
    'settings.radius.custom': 'Custom…',

    'settings.cn.pickRequired': 'Pick a province and city first (if the admin table is not loaded, restart dsh web)',
    'settings.cn.exists': '"{name}" is already on your watch list',
    'settings.cn.added': 'Added "{name}" ({lat}, {lon}, radius {radius} km)',
    'settings.cn.tableFailed': 'Could not load the administrative division data. Use "Other countries / regions" to enter coordinates manually.',
    'settings.cn.loading': 'Loading…',
    'settings.cn.provinceAll': 'Select a province / municipality / SAR',
    'settings.cn.cityFirstProvince': '(select a province first)',
    'settings.cn.provinceLabel': 'First-level division (province / autonomous region / municipality)',
    'settings.cn.cityLabel': 'City',
    'settings.cn.addButton': 'Add this city',
    'settings.cn.useMyLocation': 'Use my location',

    'settings.cities.failed': 'Could not load the municipality list. You can watch by prefecture only.',
    'settings.retry': 'Retry',
    'settings.cities.pickPrefFirst': 'Select a prefecture first',
    'settings.cities.hint': 'No selection means the whole prefecture. EEW and tsunami only go down to prefecture level.',
    'settings.cities.prefAll': 'Whole prefecture',
    'settings.cities.prefSelected': '{n} selected',
    'settings.cities.max': 'At most {n} municipalities',
    'settings.cities.searchPlaceholder': 'Search municipalities in {pref}…',
    'settings.cities.searchLabel': 'Search municipalities in {pref}',
    'settings.cities.overLimit': '…{n} in total, type a keyword',

    'settings.watch.prefMeta': ' ({jp})',
    'settings.watch.prefOrFull': ' · whole prefecture',
    'settings.watch.prefDetail': ' · {n} municipalities',
    'settings.watch.remove': 'Remove',
    'settings.watch.placeMeta': ' · radius {radius} km',
    'settings.watch.title': 'Watching ({n})',
    'settings.watch.empty': 'No locations added yet',
    'settings.watch.groupJp': 'Japan (by administrative area)',
    'settings.watch.groupCn': 'Mainland China (by area and coordinates)',
    'settings.watch.groupGlobal': 'Other countries / regions (by coordinates and radius)',
    'settings.watch.noneJp': 'Nothing selected: all of Japan will alert',
    'settings.watch.noneOther': 'Nothing added yet',

    'settings.jp.hintAll': 'With nothing selected, every earthquake in Japan will alert',
    'settings.jp.hintSelected': '{n} areas selected',

    'settings.cnBranch.hint': 'Picking a city uses its city-centre coordinates. For large prefectures and cities, raise the radius.',
    'settings.cnBranch.warning': '⚠ No separate notice when an alert is cancelled or changed. Check announcements from the China Earthquake Networks Center.',
    'settings.cnBranch.foldTitle': 'Limits of this data source',
    'settings.cnBranch.fold1': 'There is no cancellation or final-report flag: when upstream cancels or changes an alert, no "void" follow-up arrives. Japan\'s earthquake reports and tsunami warnings have that path; mainland sources do not.',
    'settings.cnBranch.fold2': 'The coordinates in the table are administrative centres, not city halls. Large prefectures and cities (Garzê, Harbin, for example) can be over 100 km from the urban area.',
    'settings.cnBranch.fold3': 'For mainland China alerts, follow announcements from the China Earthquake Networks Center (CENC).',

    'settings.global.cityFirst': 'Pick a country first, then a city.',
    'settings.global.cityFailed': 'Could not load the city list. Enter coordinates manually, or restart dsh web and try again.',
    'settings.global.cityNotCovered': 'No city list for this country (only towns above 100,000 people are included). Use the coordinate fields below.',
    'settings.global.citySearchPlaceholder': 'Search cities ({n} total)',
    'settings.global.citySearchLabel': 'Search cities',
    'settings.global.cityAddTitle': 'Add {label}',
    'settings.global.hint': 'Matched by location and radius. It does not affect Japan\'s earthquakes or tsunami.',
    'settings.global.countryLabel': 'Country / region',
    'settings.global.countryAll': 'Select a country / region',
    'settings.global.countryLoading': 'Loading the country / region list…',
    'settings.global.countryOption': '{name} ({n} cities)',
    'settings.global.manualHint': 'Or enter coordinates directly:',
    'settings.place.fieldName': 'Name',
    'settings.place.fieldNamePlaceholder': 'e.g. Tokyo / home',
    'settings.place.fieldLat': 'Latitude',
    'settings.place.fieldLon': 'Longitude',
    'settings.place.add': 'Add location',
    'settings.place.useCurrentShort': 'Use current location',

    'settings.section.watch': 'Watch regions',
    'settings.section.disaster': 'Hazard types and thresholds',
    'settings.disaster.hint': 'Still recorded when off, just not alerted.',
    'settings.disaster.notifySwitch': 'Alert',
    'settings.disaster.groupQuake': 'Earthquakes',
    'settings.disaster.quakeJpLabel': 'Japan · observed intensity',
    'settings.disaster.quakeJpNote': 'Intensity observed locally',
    'settings.disaster.quakeJpSelect': 'Japan earthquakes (minimum observed intensity)',
    'settings.disaster.eewLabel': 'Japan · Earthquake Early Warning (EEW)',
    'settings.disaster.eewNote': 'Predicted intensity',
    'settings.disaster.eewSelect': 'Earthquake Early Warning (minimum predicted intensity)',
    'settings.disaster.globalLabel': 'Global / mainland China earthquake alerts',
    'settings.disaster.globalNote': 'Distance from the epicentre to your locations',
    'settings.disaster.globalSelect': 'Global and mainland China earthquake alerts (minimum magnitude)',
    'settings.disaster.cnReportLabel': 'Mainland China earthquake reports (CENC catalogue)',
    'settings.disaster.cnReportNote': 'Network catalogue, every day',
    'settings.disaster.cnReportSelect': 'Mainland China earthquake reports (minimum magnitude)',
    'settings.disaster.foldScaleTitle': 'Why intensity and magnitude are set separately',
    'settings.disaster.foldScale1': 'Japan reports intensity; global and mainland sources report magnitude. The two cannot be converted.',
    'settings.disaster.foldScale2': 'Mainland reports start at M2.5 and arrive every day, so the threshold is separate to keep small quakes quiet.',
    'settings.disaster.groupTsunami': 'Tsunami',
    'settings.disaster.tsunamiJpLabel': 'Japan · global (NOAA)',
    'settings.disaster.tsunamiJpNote': 'Global sources match by your location radius',
    'settings.disaster.tsunamiSelect': 'Tsunami level',
    'settings.disaster.groupWeatherJp': 'Weather · Japan (JMA)',
    'settings.disaster.weatherJpLabel': 'Landslides / floods / heavy rain / storm surge',
    'settings.disaster.weatherJpNote': 'Alerted at dangerous levels only',
    'settings.disaster.gateJma4': 'Warning level 4 or above',
    'settings.disaster.groupWeatherCn': 'Weather · Mainland China (National Meteorological Center)',
    'settings.disaster.cnRainstormSwitch': 'Rainstorm alerts',
    'settings.disaster.cnGeologySwitch': 'Geological disaster alerts',
    'settings.disaster.weatherCnLabel': 'Rainstorm / geological disaster',
    'settings.disaster.weatherCnNote': 'Alerted at orange or above',
    'settings.disaster.gateOrange': 'Orange or above',
    'settings.disaster.groupWeatherOverseas': 'Weather · overseas (US NWS / Canada ECCC)',
    'settings.disaster.weatherOverseasLabel': 'Floods / flash floods / rainfall / storm surge',
    'settings.disaster.weatherOverseasNote': 'Alerted at warning level only',
    'settings.disaster.gateOverseas': 'Warning (US) · yellow or above (CA)',

    'settings.disaster.foldTradeoffsTitle': 'Trade-offs per data source',
    'settings.disaster.tradeoffCnTitle': 'Mainland China weather',
    'settings.disaster.tradeoffCn1': 'Only rainstorm and geological disaster alerts. Lightning, high winds and heat are excluded — otherwise dozens a day would flood the list.',
    'settings.disaster.tradeoffCn2': 'Alerted at orange or above; yellow and blue go to History without a sound or notification (orange does not pass during quiet hours either; only red does).',
    'settings.disaster.tradeoffCn3': 'Matching is by administrative area: only provinces and cities picked in the mainland China branch count as watch locations; manually entered coordinates do not. When the issuing body is known only at province level (directly administered counties in Hainan, for example), the whole province passes — we would rather over-alert than miss one.',
    'settings.disaster.tradeoffCn4': 'This feed has no cancellation or final-report flag: alerts simply disappear from the list when they expire, so not receiving a cancellation does not mean the alert is still in effect.',
    'settings.disaster.tradeoffOverseasTitle': 'Overseas weather',
    'settings.disaster.tradeoffOverseas1': 'Watch locations are configured under "Other countries / regions" on the Regions tab. The US is matched by county and division; with a radius of 25km or more we also query around the centre point, so the radius is approximate and does not guarantee every county within it. Canada converts the radius into a bounding box, and any intersecting alert counts as a hit.',
    'settings.disaster.tradeoffOverseas2': 'For the US only Flood / Flash Flood / Coastal Flood Warning are alerted; Watch, Advisory and Statement are recorded only.',
    'settings.disaster.tradeoffOverseas3': 'For Canada only warning-class rainfall, floods and storm surge are included. Frost and fog are ECCC advisories (officially defined as non-hazardous weather); high winds, heat and thunderstorms are warnings but are outside this plugin\'s hazard set.',
    'settings.disaster.tradeoffOverseas4': 'When the page opens, an alert issued more than 6 hours ago is recorded without a sound; the same applies when the page resumes after more than 30 minutes asleep.',
    'settings.disaster.tradeoffOverseas5': 'Data sources: the U.S. National Weather Service (NWS); Environment and Climate Change Canada (ECCC, Data Source: Environment and Climate Change Canada).',
    'settings.disaster.weatherHint': '{label} has an L{level} weather alert (below the alert threshold)',

    'settings.perm.granted': 'Notification permission: granted',
    'settings.perm.denied': 'Notification permission: denied — allow it in your browser site settings',
    'settings.perm.default': 'Notification permission: not granted — click "Test system notification" to allow',
    'settings.perm.unsupported': 'This browser does not support system notifications',
    'settings.strip.received': 'Received {n} pushes',
    'settings.strip.more': 'Details are under "More"',
    'settings.section.language': 'Language',
    'settings.language.label': 'Interface language',
    'settings.section.source': 'Data source',
    'settings.source.prod': 'Production (live push)',
    'settings.source.sandbox': 'Sandbox (2023 replay, for testing)',
    'settings.source.config': 'Config: {value}',
    'settings.section.cnTransport': 'Mainland China link',
    'settings.cnTransport.label': 'Fetch method',
    'settings.cnTransport.auto': 'Automatic (prefer the stream)',
    'settings.cnTransport.poll': 'Force polling (every 15s)',
    'settings.cnTransport.selectLabel': 'Mainland China fetch method',
    'settings.cnTransport.foldTitle': 'When to force polling',
    'settings.cnTransport.fold1': 'The SSE stream lags by seconds; polling by up to 15. Mainland alerts are won in those seconds, so the stream is the default.',
    'settings.cnTransport.fold2': 'Force polling only when network middleboxes keep cutting the stream while ordinary requests still work. Which path is actually in use is shown below under "Source status".',
    'settings.section.notify': 'Notifications and sound',
    'settings.notify.sound': 'Alert sound',
    'settings.notify.soundQuake': 'Earthquakes (incl. EEW)',
    'settings.notify.soundTsunami': 'Tsunami',
    'settings.notify.soundWeather': 'Weather hazards',
    'settings.notify.system': 'System notifications',
    'settings.notify.volume': 'Volume',
    'settings.notify.testQuake': 'Preview earthquake sound',
    'settings.notify.testEew': 'Preview EEW sound',
    'settings.notify.testTsunami': 'Preview tsunami sound',
    'settings.notify.testWeather': 'Preview weather sound',
    'settings.notify.testSystem': 'Test system notification',
    'settings.notify.testTitle': 'QuakeAlert test',
    'settings.notify.testBody': 'This is a test system notification.',
    'settings.notify.testSent': 'Test notification sent — check your system notification centre',
    'settings.notify.testFailed': 'Could not send the test notification',
    'settings.notify.toastBody': 'In-page toasts are working.',
    'settings.notify.unsupportedTest': 'This browser does not support system notifications, so it cannot be tested',
    'settings.notify.deniedRetry': 'Notification permission was denied — allow it in your browser site settings and try again',
    'settings.notify.notGranted': 'Notification permission not granted (the browser did not allow it)',
    'settings.notify.testToast': 'Test toast',
    'settings.notify.audioLocked': '⚠ The alert sound is not unlocked yet: click anywhere on the page.',
    'settings.notify.audioUnavailable': 'This environment does not support Web Audio, so the alert sound is unavailable.',

    'settings.section.quiet': 'Quiet hours',
    'settings.quiet.enable': 'Enable quiet hours',
    'settings.quiet.start': 'Start',
    'settings.quiet.end': 'End',
    'settings.quiet.startLabel': 'Quiet hours start time',
    'settings.quiet.endLabel': 'Quiet hours end time',
    'settings.quiet.breakForSevere': 'Still alert for emergencies (EEW, tsunami warnings, intensity 6-lower or above, weather level 4 or above)',
    'settings.quiet.hint': 'Judged by your browser\'s local time. Write overnight ranges as 23:00–07:00. Everything is still recorded during quiet hours.',

    'settings.section.diag': 'Tests and diagnostics',
    'settings.diag.hint': 'Test messages do not go online; they only confirm that alerting works.',
    'settings.diag.sendWeather': 'Send test weather alert',
    'settings.diag.parseFailed': 'Could not parse the test message — please report this to the developer',
    'settings.diag.outcomeSent': ' — alerted: you should see a sound and a popup',
    'settings.diag.outcomeNotSent': ' — not alerted ({reason}), recorded in History only',
    'settings.diag.outcomeUnknown': 'unknown reason',
    'settings.diag.sentWeather': 'Sent: {label} ({pref} / warning level {level}, {note})',
    'settings.diag.scenarios': 'Each click moves to the next scenario: {list}.',
    'settings.diag.scenario.landslide': 'Landslide warning information',
    'settings.diag.scenarioNote.landslide': 'municipality level / the telegram itself is L4',
    'settings.diag.scenario.flood': 'Designated river flood forecast (flooding risk)',
    'settings.diag.scenarioNote.flood': 'the level is written in the body',
    'settings.diag.scenario.heavyrain': 'Heavy rain critical warning',
    'settings.diag.scenarioNote.heavyrain': 'the level is in the Kind name',
    'settings.diag.scenario.stormsurge': 'Storm surge critical warning',
    'settings.diag.scenarioNote.stormsurge': 'the level is in the Kind name',
    'settings.diag.scenario.landslide-l3': 'Landslide warning (level 3)',
    'settings.diag.scenarioNote.landslide-l3': 'below L4 — not announced',
    'settings.diag.scenario.emsc': 'EMSC earthquake (epicentre right at the watch point)',
    'settings.diag.scenarioNote.emsc': 'M6.2',
    'settings.diag.scenario.usgs': 'USGS earthquake (~80 km away)',
    'settings.diag.scenarioNote.usgs': 'M5.6 · nearby, so a small radius may still miss it',
    'settings.diag.scenario.noaa': 'NOAA tsunami warning',
    'settings.diag.scenarioNote.noaa': 'Tsunami Advisory',
    'settings.diag.scenario.emsc-far': 'EMSC distant earthquake (~550 km away)',
    'settings.diag.scenarioNote.emsc-far': 'M7.0 · demonstrates the radius: not matched when radius < 550 km',
    'settings.diag.sendGlobal': 'Send test global alert',
    'settings.diag.needPlace': 'Add a location under Regions first — a test message needs an epicentre',
    'settings.diag.sentGlobal': 'Sent: {label} ({note})',
    'settings.diag.globalScenarios': 'Each click moves to the next scenario: {list}. The last one is about 550km away, to show how the radius works.',
    'settings.diag.snapshotHint': 'Hand the snapshot to an AI assistant and troubleshoot with TROUBLESHOOTING.zh.md.',
    'settings.diag.snapshotButton': 'Generate diagnostic snapshot',
    'settings.diag.copied': 'Copied to the clipboard.',
    'settings.diag.copiedWithWarning': 'Copied to the clipboard, but generating the snapshot raised: {warning}',
    'settings.diag.clipboardUnavailable': 'Clipboard unavailable',
    'settings.diag.clipboardError': ' ({error})',
    'settings.diag.copyManual': ' — select the text below and copy it manually.',
    'settings.diag.generatingFailed': 'Generation failed: {error}',
    'settings.diag.snapshotWarn': '⚠ Contains the regions and coordinates you watch; take care before sharing.',

    'settings.section.disclaimer': 'Disclaimer',
    'settings.disclaimer.short': 'For reference only. For evacuation, follow local official announcements. Alerts stop once the page is closed.',
    'settings.disclaimer.foldTitle': 'Data sources and full statement',
    'settings.disclaimer.source': 'Alert data comes from P2PQuake relays, public XML telegrams from the Japan Meteorological Agency, EMSC / USGS / NOAA, public interfaces of the U.S. National Weather Service (NWS) and Environment and Climate Change Canada (ECCC) called directly from the browser, and China Earthquake Networks Center (CENC) information relayed by Wolfx. None of it is an official direct push; the content and delivery quality of the Earthquake Early Warning (EEW) and mainland China earthquake alerts are not guaranteed.',
    'settings.disclaimer.authority': 'For evacuation, follow the official announcements of the responsible local authorities (Japan Meteorological Agency / China Earthquake Networks Center CENC / U.S. NWS, USGS, NOAA / Canada ECCC, and others).',

    'settings.section.history': 'Alert history ({n})',
    'settings.history.hint': 'Entries below the threshold, and those never alerted, are here too. Click one for details.',
    'settings.history.empty': 'No records yet',
    'settings.history.statusHit': 'No alert',
    'settings.history.statusSuppressed': 'Not repeated',
    'settings.history.statusPrefHit': 'Hit {pref}',
    'settings.history.statusAlerted': 'Alerted',
    'settings.history.toggleCollapse': 'Click to collapse (Enter / Space also work)',
    'settings.history.toggleExpand': 'Click for details (Enter / Space also work)',
    'settings.history.collapse': '▲ Collapse',
    'settings.history.expand': '▼ Details',
    'settings.history.fieldKind': 'Type',
    'settings.history.fieldTime': 'Time',
    'settings.history.fieldPref': 'Hit',
    'settings.history.fieldNote': 'Note',
    'settings.history.fieldContent': 'Content',
    'settings.history.fieldDetail': 'Body',
    'settings.history.kindValue': '{label} ({code})',
    'settings.history.clear': 'Clear history',
  },
};

// ============================================================================
// dsh-quake-alert · client/src/00c-texts-configio.js
//
// 作用：配置导出 / 导入这一面的文案表（各语言并列），含「错误码 → 文案」映射。
// 内容：纯数据对象，不 import 任何模块（依赖方向：文案文件 ← 00-i18n.js ← 其它）。
// ============================================================================

const CONFIG_IO = {
  'zh-CN': {
    'settings.configIo.title': '配置导出与导入',
    'settings.configIo.hint': '备份文件只含设置，不含预警记录。',
    'settings.configIo.exportBtn': '导出配置',
    'settings.configIo.importBtn': '导入配置',
    'settings.configIo.exported': '已导出配置文件。',
    'settings.configIo.exportFallback': '当前环境不能自动下载：请手动复制下面的文本。',
    'settings.configIo.copied': '已复制到剪贴板。',
    'settings.configIo.copyBtn': '复制',
    'settings.configIo.copyFailed': '复制失败，请手动全选复制。',
    'settings.configIo.imported': '已导入配置。',
    'settings.configIo.importedSkipped': '其中 {n} 个关注点因坐标无效被跳过。',
    'settings.configIo.importedRadius': '另有 {n} 个关注点没有有效半径，已按默认 300 km 处理。',
    'settings.configIo.importedCities': '另有 {n} 个市町村超出上限，已忽略。',
    'settings.configIo.undoBtn': '撤销上次导入',
    'settings.configIo.undoAt': '备份于 {at}',
    'settings.configIo.undone': '已恢复导入前的配置。',
    'settings.configIo.noBackup': '没有可撤销的导入记录。',
    'settings.configIo.errJson': '不是有效的 JSON 文件。',
    'settings.configIo.errShape': '文件里没有本插件能读的配置。',
    'settings.configIo.errFormat': '这不是灾害预警插件的配置文件。',
    'settings.configIo.errVersion': '文件缺少格式版本号，或版本号非法。',
    'settings.configIo.errNewer': '文件来自更新版本的插件（格式版本 {v}），当前版本读不了。',
    'settings.configIo.errRead': '读取文件失败。',
    'settings.configIo.errNoFile': '没有选择文件。',
    'settings.configIo.errBackupFailed': '当前环境无法保存备份（浏览器存储可能已满或被禁用）。为避免无法撤销，导入已取消。',
    'settings.configIo.errUnexpected': '导入过程中出错了：{detail}',
  },

  'zh-TW': {
    'settings.configIo.title': '設定匯出與匯入',
    'settings.configIo.hint': '備份檔只含設定，不含警報紀錄。',
    'settings.configIo.exportBtn': '匯出設定',
    'settings.configIo.importBtn': '匯入設定',
    'settings.configIo.exported': '已匯出設定檔。',
    'settings.configIo.exportFallback': '目前環境無法自動下載：請手動複製下面的文字。',
    'settings.configIo.copied': '已複製到剪貼簿。',
    'settings.configIo.copyBtn': '複製',
    'settings.configIo.copyFailed': '複製失敗，請手動全選複製。',
    'settings.configIo.imported': '已匯入設定。',
    'settings.configIo.importedSkipped': '其中 {n} 個關注點因座標無效被略過。',
    'settings.configIo.importedRadius': '另有 {n} 個關注點沒有有效半徑，已按預設 300 km 處理。',
    'settings.configIo.importedCities': '另有 {n} 個市町村超出上限，已忽略。',
    'settings.configIo.undoBtn': '復原上次匯入',
    'settings.configIo.undoAt': '備份於 {at}',
    'settings.configIo.undone': '已還原匯入前的設定。',
    'settings.configIo.noBackup': '沒有可復原的匯入紀錄。',
    'settings.configIo.errJson': '不是有效的 JSON 檔案。',
    'settings.configIo.errShape': '這個檔案裡沒有本插件能讀取的設定。',
    'settings.configIo.errFormat': '這不是災害警報插件的設定檔。',
    'settings.configIo.errVersion': '檔案缺少格式版本號，或版本號不合法。',
    'settings.configIo.errNewer': '檔案來自較新版本的插件（格式版本 {v}），目前版本無法讀取。',
    'settings.configIo.errRead': '讀取檔案失敗。',
    'settings.configIo.errNoFile': '沒有選擇檔案。',
    'settings.configIo.errBackupFailed': '目前環境無法儲存備份（瀏覽器儲存空間可能已滿或被停用）。為避免無法復原，匯入已取消。',
    'settings.configIo.errUnexpected': '匯入過程中發生錯誤：{detail}',
  },

  ja: {
    'settings.configIo.title': '設定のエクスポートとインポート',
    'settings.configIo.hint': 'バックアップファイルに含まれるのは設定のみで、警報の履歴は含まれません。',
    'settings.configIo.exportBtn': '設定をエクスポート',
    'settings.configIo.importBtn': '設定をインポート',
    'settings.configIo.exported': '設定ファイルをエクスポートしました。',
    'settings.configIo.exportFallback': 'この環境では自動ダウンロードできません。下のテキストを手動でコピーしてください。',
    'settings.configIo.copied': 'クリップボードにコピーしました。',
    'settings.configIo.copyBtn': 'コピー',
    'settings.configIo.copyFailed': 'コピーできませんでした。手動で全選択してコピーしてください。',
    'settings.configIo.imported': '設定をインポートしました。',
    'settings.configIo.importedSkipped': 'うち {n} 件の監視地点は座標が無効なためスキップしました。',
    'settings.configIo.importedRadius': 'さらに {n} 件の監視地点には有効な半径がないため、既定の 300 km で扱います。',
    'settings.configIo.importedCities': 'さらに {n} 件の市区町村が上限を超えるため、無視しました。',
    'settings.configIo.undoBtn': '直前のインポートを元に戻す',
    'settings.configIo.undoAt': 'バックアップ日時：{at}',
    'settings.configIo.undone': 'インポート前の設定に戻しました。',
    'settings.configIo.noBackup': '元に戻せるインポート履歴がありません。',
    'settings.configIo.errJson': '有効な JSON ファイルではありません。',
    'settings.configIo.errShape': 'このファイルには読み込める設定が含まれていません。',
    'settings.configIo.errFormat': '災害警報プラグインの設定ファイルではありません。',
    'settings.configIo.errVersion': '形式バージョンがないか、値が不正です。',
    'settings.configIo.errNewer': 'より新しいバージョンのプラグインが出力したファイルです（形式バージョン {v}）。現在のバージョンでは読み込めません。',
    'settings.configIo.errRead': 'ファイルの読み込みに失敗しました。',
    'settings.configIo.errNoFile': 'ファイルが選択されていません。',
    'settings.configIo.errBackupFailed': 'この環境ではバックアップを保存できません（ブラウザの保存領域が満杯か、無効になっています）。元に戻せなくなるため、インポートを中止しました。',
    'settings.configIo.errUnexpected': 'インポート中にエラーが発生しました：{detail}',
  },

  en: {
    'settings.configIo.title': 'Export and import settings',
    'settings.configIo.hint': 'The backup file contains settings only, not alert history.',
    'settings.configIo.exportBtn': 'Export settings',
    'settings.configIo.importBtn': 'Import settings',
    'settings.configIo.exported': 'Settings file exported.',
    'settings.configIo.exportFallback': 'Automatic download is unavailable here. Copy the text below manually.',
    'settings.configIo.copied': 'Copied to clipboard.',
    'settings.configIo.copyBtn': 'Copy',
    'settings.configIo.copyFailed': 'Copy failed. Select all and copy manually.',
    'settings.configIo.imported': 'Settings imported.',
    'settings.configIo.importedSkipped': '{n} watch location(s) were skipped because their coordinates were invalid.',
    'settings.configIo.importedRadius': '{n} more watch location(s) had no valid radius and now use the 300 km default.',
    'settings.configIo.importedCities': '{n} more municipalities exceeded the limit and were ignored.',
    'settings.configIo.undoBtn': 'Undo last import',
    'settings.configIo.undoAt': 'Backed up at {at}',
    'settings.configIo.undone': 'Restored the settings from before the import.',
    'settings.configIo.noBackup': 'There is no import to undo.',
    'settings.configIo.errJson': 'Not a valid JSON file.',
    'settings.configIo.errShape': 'This file contains no settings this plugin can read.',
    'settings.configIo.errFormat': 'This is not a disaster alert plugin settings file.',
    'settings.configIo.errVersion': 'The format version is missing or invalid.',
    'settings.configIo.errNewer': 'This file comes from a newer plugin version (format version {v}); this version cannot read it.',
    'settings.configIo.errRead': 'Could not read the file.',
    'settings.configIo.errNoFile': 'No file selected.',
    'settings.configIo.errBackupFailed': 'Could not save a backup (browser storage may be full or disabled). The import was cancelled so it always stays undoable.',
    'settings.configIo.errUnexpected': 'Something went wrong during the import: {detail}',
  },
};

// ============================================================================
// dsh-quake-alert · client/src/00e-texts-units.js
//
// 作用：量纲类展示文案表（各语言并列）——震度、海啸等级、震级档位、关注半径档位。
// 内容：纯数据对象，不 import 任何模块。01-constants 的对应常量只保存「值 + 文案 key」。
//
// 震度的日文写法分语种：`5弱` / `5強` 的「強」是日文汉字，中文简体写作「强」，
// 两栏故意不同，不要统一。震级档位文案由 `GLOBAL_MAG_OPTIONS` 与 `CN_REPORT_MAG_OPTIONS`
// 共用（同值同文案）；两者默认值一旦分家，这里必须拆成两组 key。
// ============================================================================

const UNITS = {
  'zh-CN': {

    'scaleOpt.10': '震度1 以上', 'scaleOpt.20': '震度2 以上', 'scaleOpt.30': '震度3 以上',
    'scaleOpt.40': '震度4 以上', 'scaleOpt.45': '震度5弱 以上', 'scaleOpt.50': '震度5强 以上',
    'scaleOpt.55': '震度6弱 以上', 'scaleOpt.60': '震度6强 以上', 'scaleOpt.70': '震度7',

    'tsunamiOpt.Watch': '注意报及以上',
    'tsunamiOpt.Warning': '警报及以上',
    'tsunamiOpt.MajorWarning': '仅大海啸警报',

    'magOpt.3': 'M3.0 以上', 'magOpt.3.5': 'M3.5 以上', 'magOpt.4': 'M4.0 以上',
    'magOpt.4.5': 'M4.5 以上（默认）', 'magOpt.5': 'M5.0 以上', 'magOpt.5.5': 'M5.5 以上',
    'magOpt.6': 'M6.0 以上', 'magOpt.6.5': 'M6.5 以上', 'magOpt.7': 'M7.0 以上',

    'radius.30': '仅本地（约 30 km）',
    'radius.100': '本市及周边（约 100 km，默认）',
    'radius.300': '较大范围（约 300 km）'
  },

  'zh-TW': {

    'scaleOpt.10': '震度1 以上', 'scaleOpt.20': '震度2 以上', 'scaleOpt.30': '震度3 以上',
    'scaleOpt.40': '震度4 以上', 'scaleOpt.45': '震度5弱 以上', 'scaleOpt.50': '震度5強 以上',
    'scaleOpt.55': '震度6弱 以上', 'scaleOpt.60': '震度6強 以上', 'scaleOpt.70': '震度7',

    'tsunamiOpt.Watch': '注意報以上',
    'tsunamiOpt.Warning': '警報以上',
    'tsunamiOpt.MajorWarning': '僅大海嘯警報',

    'magOpt.3': 'M3.0 以上', 'magOpt.3.5': 'M3.5 以上', 'magOpt.4': 'M4.0 以上',
    'magOpt.4.5': 'M4.5 以上（預設）', 'magOpt.5': 'M5.0 以上', 'magOpt.5.5': 'M5.5 以上',
    'magOpt.6': 'M6.0 以上', 'magOpt.6.5': 'M6.5 以上', 'magOpt.7': 'M7.0 以上',

    'radius.30': '僅本地（約 30 km）',
    'radius.100': '本市及周邊（約 100 km，預設）',
    'radius.300': '較大範圍（約 300 km）'
  },

  ja: {

    'scaleOpt.10': '震度1以上', 'scaleOpt.20': '震度2以上', 'scaleOpt.30': '震度3以上',
    'scaleOpt.40': '震度4以上', 'scaleOpt.45': '震度5弱以上', 'scaleOpt.50': '震度5強以上',
    'scaleOpt.55': '震度6弱以上', 'scaleOpt.60': '震度6強以上', 'scaleOpt.70': '震度7',

    'tsunamiOpt.Watch': '津波注意報以上',
    'tsunamiOpt.Warning': '津波警報以上',
    'tsunamiOpt.MajorWarning': '大津波警報のみ',

    'magOpt.3': 'M3.0 以上', 'magOpt.3.5': 'M3.5 以上', 'magOpt.4': 'M4.0 以上',
    'magOpt.4.5': 'M4.5 以上（既定）', 'magOpt.5': 'M5.0 以上', 'magOpt.5.5': 'M5.5 以上',
    'magOpt.6': 'M6.0 以上', 'magOpt.6.5': 'M6.5 以上', 'magOpt.7': 'M7.0 以上',

    'radius.30': 'ローカルのみ（約 30 km）',
    'radius.100': '市とその周辺（約 100 km、既定）',
    'radius.300': '広い範囲（約 300 km）'
  },

  en: {

    'scaleOpt.10': 'Intensity 1 or higher', 'scaleOpt.20': 'Intensity 2 or higher', 'scaleOpt.30': 'Intensity 3 or higher',
    'scaleOpt.40': 'Intensity 4 or higher', 'scaleOpt.45': 'Intensity 5 lower or higher', 'scaleOpt.50': 'Intensity 5 upper or higher',
    'scaleOpt.55': 'Intensity 6 lower or higher', 'scaleOpt.60': 'Intensity 6 upper or higher', 'scaleOpt.70': 'Intensity 7',

    'tsunamiOpt.Watch': 'Advisory or higher',
    'tsunamiOpt.Warning': 'Warning or higher',
    'tsunamiOpt.MajorWarning': 'Major warning only',

    'magOpt.3': 'M3.0 or higher', 'magOpt.3.5': 'M3.5 or higher', 'magOpt.4': 'M4.0 or higher',
    'magOpt.4.5': 'M4.5 or higher (default)', 'magOpt.5': 'M5.0 or higher', 'magOpt.5.5': 'M5.5 or higher',
    'magOpt.6': 'M6.0 or higher', 'magOpt.6.5': 'M6.5 or higher', 'magOpt.7': 'M7.0 or higher',

    'radius.30': 'Local only (~30 km)',
    'radius.100': 'City and surroundings (~100 km, default)',
    'radius.300': 'Wider area (~300 km)'
  }
};

// ============================================================================
// dsh-quake-alert · client/src/00g-texts-events.js
//
// 作用：解析层与提醒面自己拼出来的那些字的四语文案——事件类型标签（`kindLabel`）、
//       震度 / 海啸等级词、解析层拼 `headline` 用的模板。
// 内容：EVENTS（四种语言各一份，键集必须完全一致，见 00-i18n 的校验）。纯数据，无依赖。
//
// 电文原文不翻（原样透传），本文件只放**我们拼的字**；正则与匹配用的字也不在这里，
// 它们留在解析器里保持日文原样（`/土砂災害警戒情報/` 这类翻译了就永远匹配不上上游电文）。
// ja 一栏用官方原词（`大雨警報` / `土砂災害警戒情報` / `津波警報`），其余语言才是译名。
// ============================================================================

const EVENTS = {
  'zh-CN': {
    'kind.cencEew': '大陆地震预警（CENC）',
    'kind.cencEqlist': '大陆地震速报（CENC）',
    'kind.cencDepth': ' · 深 {depth}km',
    'kind.cencReportNo': '（第 {n} 报）',
    'sourceCode.jma': 'JMA 电文',
    'sourceCode.cencEew': 'CENC 预警',
    'sourceCode.cencEqlist': 'CENC 速报',
    'sourceCode.cencMainland': 'CENC 大陆',
    'sourceCode.nmc': '中央气象台',
    'kind.depthSuffix': ' · 深 {depth}km',
    'kind.cnRainstorm': '暴雨',
    'kind.cnGeology': '地质灾害',
    'kind.cnLevelRed': '红色',
    'kind.cnLevelOrange': '橙色',
    'kind.cnLevelYellow': '黄色',
    'kind.cnLevelBlue': '蓝色',
    'kind.cnLevelUnknown': '等级不明',
    'kind.cnWhat': '{kind}{level}预警',
    'kind.nwsFlood': '洪水',
    'kind.nwsFlashFlood': '山洪',
    'kind.nwsCoastalFlood': '沿海洪水',
    'kind.nwsFloodWatch': '洪水警戒',
    'kind.nwsFloodAdvisory': '洪水注意',
    'kind.nwsCoastalWatch': '沿海洪水警戒',
    'kind.nwsCoastalAdvisory': '沿海洪水注意',
    'kind.nwsCoastalStatement': '沿海洪水说明',
    'kind.caStormSurge': '风暴潮预警',
    'kind.caFlashFlood': '山洪预警',
    'kind.caFlood': '洪水预警',
    'kind.caRain': '降雨预警',
    'kind.caHydrology': '水文预警',
    'kind.caWeather': '气象预警',
    'kind.noaaMajorWarning': '大海啸警报（NOAA）',
    'kind.noaaWarning': '海啸警报（NOAA）',
    'kind.noaaInfo': '海啸信息（NOAA）',
    'kind.noaaForeshock': ' · 前震 M{mag}',
    'kind.cnHeadline': '{place}{kind}{level}预警',
    'kind.cnLabel': '大陆{kind}{level}预警（中央气象台）',
    // —— 地震情报（P2PQuake 551 的 issue.type 分类）——
    'kind.quakeScale': '地震速报·震度速报',
    'kind.quakeHypo': '地震情报·震源',
    'kind.quakeScaleHypo': '地震情报·震源与震度',
    'kind.quakeDetail': '地震情报·各地震度',
    'kind.quakeForeign': '地震情报·远地地震',
    'kind.quakeInfo': '地震情报',
    // —— 紧急地震速报 ——
    'kind.eewWarning': '紧急地震速报（警报）',
    'kind.eewCancelled': 'EEW·已取消',
    // —— 海啸 ——
    'kind.tsunamiMajor': '大海啸警报',
    'kind.tsunamiWarning': '海啸警报',
    'kind.tsunamiAdvisory': '海啸注意报',
    'kind.tsunamiCancelled': '海啸·已解除',
    'kind.tsunamiCleared': '海啸预报已解除',
    'kind.eewCancelledHeadline': '本警报已取消',
    'scale.prefixMax': '最大',
    'scale.prefixEewMax': '预测最大',
    // —— 日本气象厅的灾种（ja 用官方原词）——
    'kind.jmaLandslideInfo': '泥石流警戒情报',
    'kind.jmaFloodForecast': '洪水预报',
    'kind.jmaHeavyRain': '大雨警报',
    'kind.jmaLandslide': '泥石流警报',
    'kind.jmaFlood': '洪水警报',
    'kind.jmaStormSurge': '风暴潮警报',
    'kind.jmaStorm': '暴风警报',
    'kind.jmaWave': '海浪警报',
    'kind.jmaThunder': '雷击警报',
    'kind.jmaFog': '浓雾警报',
    'kind.jmaDry': '干燥警报',
    'kind.jmaAvalanche': '雪崩警报',
    'kind.jmaWeatherEmergency': '气象特别警报',
    'kind.jmaWeather': '气象警报',
    // —— 全球源与海外气象源 ——
    'kind.globalEmsc': '全球地震（EMSC）',
    'kind.globalUsgs': '全球地震（USGS）',
    'kind.noaaUnrecognized': 'NOAA 事件（未识别：{event}）',
    'kind.usHazard': '美国{hazard}（NWS）',
    'kind.caHazard': '加拿大{hazard}（ECCC）',
    // —— 解析层拼 headtitle 用的后缀与模板（**这些字是我们拼的**）——
    'kind.cancelledSuffix': '（已解除）',
    'kind.downgradedSuffix': '（降级）',
    'kind.levelSuffix': '（警戒レベル{level}）',
    'kind.quakeHeadline': '震源 {name} · M{mag}',
    'kind.quakeHeadlineNoName': '{label}',
    'kind.tsunamiLine': '{area}：{grade}{height}',
    'kind.tsunamiHeight': ' 高{height}',
    'kind.areaUnknown': '—',
    // —— 震度 / 海啸等级的词（解析层拼正文时用；ja 是官方写法）——
    'scale.10': '震度1', 'scale.20': '震度2', 'scale.30': '震度3', 'scale.40': '震度4',
    'scale.45': '震度5弱', 'scale.46': '震度5弱以上', 'scale.50': '震度5强',
    'scale.55': '震度6弱', 'scale.60': '震度6强', 'scale.70': '震度7',
    'scale.number': '震度{n}',
    'scale.unknown': '震度不明',
    'tsunami.Watch': '海啸注意报',
    'tsunami.Warning': '海啸警报',
    'tsunami.MajorWarning': '大海啸警报',
    'tsunami.unknown': '海啸（等级不明）',
  },
  'zh-TW': {
    'kind.cencEew': '大陸地震預警（CENC）',
    'kind.cencEqlist': '大陸地震速報（CENC）',
    'kind.cencDepth': ' · 深 {depth}km',
    'kind.cencReportNo': '（第 {n} 報）',
    'sourceCode.jma': 'JMA 電文',
    'sourceCode.cencEew': 'CENC 預警',
    'sourceCode.cencEqlist': 'CENC 速報',
    'sourceCode.cencMainland': 'CENC 大陸',
    'sourceCode.nmc': '中央氣象台',
    'kind.depthSuffix': ' · 深 {depth}km',
    'kind.cnRainstorm': '暴雨',
    'kind.cnGeology': '地質災害',
    'kind.cnLevelRed': '紅色',
    'kind.cnLevelOrange': '橙色',
    'kind.cnLevelYellow': '黃色',
    'kind.cnLevelBlue': '藍色',
    'kind.cnLevelUnknown': '等級不明',
    'kind.cnWhat': '{kind}{level}預警',
    'kind.nwsFlood': '洪水',
    'kind.nwsFlashFlood': '山洪',
    'kind.nwsCoastalFlood': '沿海洪水',
    'kind.nwsFloodWatch': '洪水警戒',
    'kind.nwsFloodAdvisory': '洪水注意',
    'kind.nwsCoastalWatch': '沿海洪水警戒',
    'kind.nwsCoastalAdvisory': '沿海洪水注意',
    'kind.nwsCoastalStatement': '沿海洪水說明',
    'kind.caStormSurge': '風暴潮預警',
    'kind.caFlashFlood': '山洪預警',
    'kind.caFlood': '洪水預警',
    'kind.caRain': '降雨預警',
    'kind.caHydrology': '水文預警',
    'kind.caWeather': '氣象預警',
    'kind.noaaMajorWarning': '大海嘯警報（NOAA）',
    'kind.noaaWarning': '海嘯警報（NOAA）',
    'kind.noaaInfo': '海嘯資訊（NOAA）',
    'kind.noaaForeshock': ' · 前震 M{mag}',
    'kind.cnHeadline': '{place}{kind}{level}預警',
    'kind.cnLabel': '大陸{kind}{level}預警（中央氣象台）',
    'kind.quakeScale': '地震速報·震度速報',
    'kind.quakeHypo': '地震情報·震源',
    'kind.quakeScaleHypo': '地震情報·震源與震度',
    'kind.quakeDetail': '地震情報·各地震度',
    'kind.quakeForeign': '地震情報·遠地地震',
    'kind.quakeInfo': '地震情報',
    'kind.eewWarning': '緊急地震速報（警報）',
    'kind.eewCancelled': 'EEW·已取消',
    'kind.tsunamiMajor': '大海嘯警報',
    'kind.tsunamiWarning': '海嘯警報',
    'kind.tsunamiAdvisory': '海嘯注意報',
    'kind.tsunamiCancelled': '海嘯·已解除',
    'kind.tsunamiCleared': '海嘯預報已解除',
    'kind.eewCancelledHeadline': '本警報已取消',
    'scale.prefixMax': '最大',
    'scale.prefixEewMax': '預測最大',
    'kind.jmaLandslideInfo': '土石流警戒情報',
    'kind.jmaFloodForecast': '洪水預報',
    'kind.jmaHeavyRain': '大雨警報',
    'kind.jmaLandslide': '土石流警報',
    'kind.jmaFlood': '洪水警報',
    'kind.jmaStormSurge': '風暴潮警報',
    'kind.jmaStorm': '暴風警報',
    'kind.jmaWave': '海浪警報',
    'kind.jmaThunder': '雷擊警報',
    'kind.jmaFog': '濃霧警報',
    'kind.jmaDry': '乾燥警報',
    'kind.jmaAvalanche': '雪崩警報',
    'kind.jmaWeatherEmergency': '氣象特別警報',
    'kind.jmaWeather': '氣象警報',
    'kind.globalEmsc': '全球地震（EMSC）',
    'kind.globalUsgs': '全球地震（USGS）',
    'kind.noaaUnrecognized': 'NOAA 事件（未識別：{event}）',
    'kind.usHazard': '美國{hazard}（NWS）',
    'kind.caHazard': '加拿大{hazard}（ECCC）',
    'kind.cancelledSuffix': '（已解除）',
    'kind.downgradedSuffix': '（降級）',
    'kind.levelSuffix': '（警戒レベル{level}）',
    'kind.quakeHeadline': '震源 {name} · M{mag}',
    'kind.quakeHeadlineNoName': '{label}',
    'kind.tsunamiLine': '{area}：{grade}{height}',
    'kind.tsunamiHeight': ' 高{height}',
    'kind.areaUnknown': '—',
    'scale.10': '震度1', 'scale.20': '震度2', 'scale.30': '震度3', 'scale.40': '震度4',
    'scale.45': '震度5弱', 'scale.46': '震度5弱以上', 'scale.50': '震度5強',
    'scale.55': '震度6弱', 'scale.60': '震度6強', 'scale.70': '震度7',
    'scale.number': '震度{n}',
    'scale.unknown': '震度不明',
    'tsunami.Watch': '海嘯注意報',
    'tsunami.Warning': '海嘯警報',
    'tsunami.MajorWarning': '大海嘯警報',
    'tsunami.unknown': '海嘯（等級不明）',
  },
  ja: {
    'kind.cencEew': '中国大陸の地震予警（CENC）',
    'kind.cencEqlist': '中国大陸の地震速報（CENC）',
    'kind.cencDepth': ' · 深さ {depth}km',
    'kind.cencReportNo': '（第 {n} 報）',
    'sourceCode.jma': '気象庁 電文',
    'sourceCode.cencEew': 'CENC 警報',
    'sourceCode.cencEqlist': 'CENC 速報',
    'sourceCode.cencMainland': 'CENC 中国大陸',
    'sourceCode.nmc': '中国気象局',
    'kind.depthSuffix': ' · 深さ {depth}km',
    'kind.cnRainstorm': '大雨',
    'kind.cnGeology': '地質災害',
    'kind.cnLevelRed': '赤',
    'kind.cnLevelOrange': 'オレンジ',
    'kind.cnLevelYellow': '黄',
    'kind.cnLevelBlue': '青',
    'kind.cnLevelUnknown': '等級不明',
    'kind.cnWhat': '{kind}・{level}警報',
    'kind.nwsFlood': '洪水',
    'kind.nwsFlashFlood': '鉄砲水',
    'kind.nwsCoastalFlood': '海岸洪水',
    'kind.nwsFloodWatch': '洪水注意報',
    'kind.nwsFloodAdvisory': '洪水注意情報',
    'kind.nwsCoastalWatch': '海岸洪水注意報',
    'kind.nwsCoastalAdvisory': '海岸洪水注意情報',
    'kind.nwsCoastalStatement': '海岸洪水情報',
    'kind.caStormSurge': '高潮警報',
    'kind.caFlashFlood': '鉄砲水警報',
    'kind.caFlood': '洪水警報',
    'kind.caRain': '大雨警報',
    'kind.caHydrology': '水文警報',
    'kind.caWeather': '気象警報',
    'kind.noaaMajorWarning': '大津波警報（NOAA）',
    'kind.noaaWarning': '津波警報（NOAA）',
    'kind.noaaInfo': '津波情報（NOAA）',
    'kind.noaaForeshock': ' · 前震 M{mag}',
    'kind.cnHeadline': '{place}{kind}{level}警報',
    'kind.cnLabel': '中国大陸 {kind}{level}警報（中央気象台）',
    'kind.quakeScale': '地震速報・震度速報',
    'kind.quakeHypo': '地震情報・震源',
    'kind.quakeScaleHypo': '地震情報・震源と震度',
    'kind.quakeDetail': '地震情報・各地の震度',
    'kind.quakeForeign': '地震情報・遠地地震',
    'kind.quakeInfo': '地震情報',
    'kind.eewWarning': '緊急地震速報（警報）',
    'kind.eewCancelled': 'EEW・取消',
    'kind.tsunamiMajor': '大津波警報',
    'kind.tsunamiWarning': '津波警報',
    'kind.tsunamiAdvisory': '津波注意報',
    'kind.tsunamiCancelled': '津波・解除',
    'kind.tsunamiCleared': '津波予報を解除しました',
    'kind.eewCancelledHeadline': 'この警報は取消されました',
    'scale.prefixMax': '最大',
    'scale.prefixEewMax': '予想最大',
    'kind.jmaLandslideInfo': '土砂災害警戒情報',
    'kind.jmaFloodForecast': '指定河川洪水予報',
    'kind.jmaHeavyRain': '大雨警報',
    'kind.jmaLandslide': '土砂災害警報',
    'kind.jmaFlood': '洪水警報',
    'kind.jmaStormSurge': '高潮警報',
    'kind.jmaStorm': '暴風警報',
    'kind.jmaWave': '波浪警報',
    'kind.jmaThunder': '雷注意報',
    'kind.jmaFog': '濃霧注意報',
    'kind.jmaDry': '乾燥注意報',
    'kind.jmaAvalanche': 'なだれ注意報',
    'kind.jmaWeatherEmergency': '気象特別警報',
    'kind.jmaWeather': '気象警報',
    'kind.globalEmsc': '世界の地震（EMSC）',
    'kind.globalUsgs': '世界の地震（USGS）',
    'kind.noaaUnrecognized': 'NOAA の事象（未分類：{event}）',
    'kind.usHazard': 'アメリカ{hazard}（NWS）',
    'kind.caHazard': 'カナダ{hazard}（ECCC）',
    'kind.cancelledSuffix': '（解除）',
    'kind.downgradedSuffix': '（降級）',
    'kind.levelSuffix': '（警戒レベル{level}）',
    'kind.quakeHeadline': '震源 {name} · M{mag}',
    'kind.quakeHeadlineNoName': '{label}',
    'kind.tsunamiLine': '{area}：{grade}{height}',
    'kind.tsunamiHeight': ' 高さ{height}',
    'kind.areaUnknown': '—',
    'scale.10': '震度1', 'scale.20': '震度2', 'scale.30': '震度3', 'scale.40': '震度4',
    'scale.45': '震度5弱', 'scale.46': '震度5弱以上', 'scale.50': '震度5強',
    'scale.55': '震度6弱', 'scale.60': '震度6強', 'scale.70': '震度7',
    'scale.number': '震度{n}',
    'scale.unknown': '震度不明',
    'tsunami.Watch': '津波注意報',
    'tsunami.Warning': '津波警報',
    'tsunami.MajorWarning': '大津波警報',
    'tsunami.unknown': '津波（等級不明）',
  },
  en: {
    'kind.cencEew': 'Mainland China earthquake warning (CENC)',
    'kind.cencEqlist': 'Mainland China earthquake report (CENC)',
    'kind.cencDepth': ' · {depth} km deep',
    'kind.cencReportNo': ' (report #{n})',
    'sourceCode.jma': 'JMA bulletin',
    'sourceCode.cencEew': 'CENC alert',
    'sourceCode.cencEqlist': 'CENC rapid report',
    'sourceCode.cencMainland': 'CENC (mainland)',
    'sourceCode.nmc': 'CMA',
    'kind.depthSuffix': ' · {depth} km deep',
    'kind.cnRainstorm': 'heavy rain',
    'kind.cnGeology': 'geological hazard',
    'kind.cnLevelRed': 'red',
    'kind.cnLevelOrange': 'orange',
    'kind.cnLevelYellow': 'yellow',
    'kind.cnLevelBlue': 'blue',
    'kind.cnLevelUnknown': 'level unknown',
    'kind.cnWhat': '{level} {kind} warning',
    'kind.nwsFlood': 'flood',
    'kind.nwsFlashFlood': 'flash flood',
    'kind.nwsCoastalFlood': 'coastal flood',
    'kind.nwsFloodWatch': 'flood watch',
    'kind.nwsFloodAdvisory': 'flood advisory',
    'kind.nwsCoastalWatch': 'coastal flood watch',
    'kind.nwsCoastalAdvisory': 'coastal flood advisory',
    'kind.nwsCoastalStatement': 'coastal flood statement',
    'kind.caStormSurge': 'storm surge warning',
    'kind.caFlashFlood': 'flash flood warning',
    'kind.caFlood': 'flood warning',
    'kind.caRain': 'rainfall warning',
    'kind.caHydrology': 'hydrological warning',
    'kind.caWeather': 'weather warning',
    'kind.noaaMajorWarning': 'major tsunami warning (NOAA)',
    'kind.noaaWarning': 'tsunami warning (NOAA)',
    'kind.noaaInfo': 'tsunami information (NOAA)',
    'kind.noaaForeshock': ' · foreshock M{mag}',
    'kind.cnHeadline': '{place}{kind}{level} warning',
    'kind.cnLabel': 'Mainland China {level} {kind} warning (CMA)',
    'kind.quakeScale': 'Earthquake report · intensity',
    'kind.quakeHypo': 'Earthquake report · epicentre',
    'kind.quakeScaleHypo': 'Earthquake report · epicentre and intensity',
    'kind.quakeDetail': 'Earthquake report · intensity by area',
    'kind.quakeForeign': 'Earthquake report · distant earthquake',
    'kind.quakeInfo': 'Earthquake report',
    'kind.eewWarning': 'EEW (warning)',
    'kind.eewCancelled': 'EEW · cancelled',
    'kind.tsunamiMajor': 'Major tsunami warning',
    'kind.tsunamiWarning': 'Tsunami warning',
    'kind.tsunamiAdvisory': 'Tsunami advisory',
    'kind.tsunamiCancelled': 'Tsunami · cancelled',
    'kind.tsunamiCleared': 'Tsunami forecast cleared',
    'kind.eewCancelledHeadline': 'This warning has been cancelled',
    'scale.prefixMax': 'max ',
    'scale.prefixEewMax': 'predicted ',
    'kind.jmaLandslideInfo': 'Debris-flow warning',
    'kind.jmaFloodForecast': 'River flood forecast',
    'kind.jmaHeavyRain': 'Heavy rain warning',
    'kind.jmaLandslide': 'Debris-flow warning',
    'kind.jmaFlood': 'Flood warning',
    'kind.jmaStormSurge': 'Storm surge warning',
    'kind.jmaStorm': 'Storm warning',
    'kind.jmaWave': 'High wave warning',
    'kind.jmaThunder': 'Thunderstorm advisory',
    'kind.jmaFog': 'Dense fog advisory',
    'kind.jmaDry': 'Dry air advisory',
    'kind.jmaAvalanche': 'Avalanche advisory',
    'kind.jmaWeatherEmergency': 'Emergency weather warning',
    'kind.jmaWeather': 'Weather warning',
    'kind.globalEmsc': 'Global earthquake (EMSC)',
    'kind.globalUsgs': 'Global earthquake (USGS)',
    'kind.noaaUnrecognized': 'NOAA event (unrecognized: {event})',
    'kind.usHazard': 'US {hazard} (NWS)',
    'kind.caHazard': 'Canada {hazard} (ECCC)',
    'kind.cancelledSuffix': ' (cancelled)',
    'kind.downgradedSuffix': ' (downgraded)',
    'kind.levelSuffix': ' (level {level})',
    'kind.quakeHeadline': 'Epicentre {name} · M{mag}',
    'kind.quakeHeadlineNoName': '{label}',
    'kind.tsunamiLine': '{area}: {grade}{height}',
    'kind.tsunamiHeight': ', {height} high',
    'kind.areaUnknown': '—',
    'scale.10': 'Intensity 1', 'scale.20': 'Intensity 2', 'scale.30': 'Intensity 3',
    'scale.40': 'Intensity 4', 'scale.45': 'Intensity 5 lower', 'scale.46': 'Intensity 5 lower or higher',
    'scale.50': 'Intensity 5 upper',
    'scale.55': 'Intensity 6 lower', 'scale.60': 'Intensity 6 upper',
    'scale.70': 'Intensity 7',
    'scale.number': 'Intensity {n}',
    'scale.unknown': 'Intensity unknown',
    'tsunami.Watch': 'Tsunami advisory',
    'tsunami.Warning': 'Tsunami warning',
    'tsunami.MajorWarning': 'Major tsunami warning',
    'tsunami.unknown': 'Tsunami (grade unknown)',
  },
};

// ============================================================================
// dsh-quake-alert · client/src/00h-texts-reasons.js
//
// 作用：匹配层与流水线自己写下的原因文案的四语表——「未命中：…」那一串、判不了时的说明、
//       静默时段抑制说明等，进履历条目的「说明」字段。
// 内容：REASONS（四种语言各一份，键集必须完全一致，见 00-i18n 的校验）。纯数据，无依赖。
//
// 这些字全部是我们自己写的，跟界面语言走；上游电文原文（JMA 的 `注意報を解除します`、
// USGS 的地名、NWS 的官方事件名）不翻，由各自的解析器原样透传。
// 正则匹配用的字不许动（`/注意報に切り替え/` 之类），本文件只放取词。
// ============================================================================

const REASONS = {
  'zh-CN': {
    'reason.sourceUnknown': '未知源',
    // —— 缺少配置 ——
    'reason.noGlobalWatch': '未设置全球关注点（设置 → 灾害预警 → 关注地区 → 其他国家 / 地区）',
    'reason.noOverseasWatch': '未设置海外关注点（设置 → 灾害预警 → 关注地区 → 其他国家 / 地区）',
    // —— 开关关闭 ——
    'reason.quakeOff': '地震提醒已关闭',
    'reason.tsunamiOff': '海啸提醒已关闭',
    'reason.weatherOff': '气象灾害提醒已关闭',
    'reason.overseasWeatherOff': '海外气象提醒已关闭',
    'reason.cnRainstormOff': '大陆暴雨提醒已关闭',
    'reason.cnGeologyOff': '大陆地质灾害提醒已关闭',
    // —— 取消 / 解除 ——
    'reason.cancelledMuted': '取消消息不提醒',
    'reason.clearedMuted': '解除消息不提醒',
    'reason.cancelNoPriorAlert': '取消 / 解除消息，且此前未提醒过该事件',
    'reason.clearedIsNotAlert': '这是取消 / 解除消息',
    'reason.cancelNoPierceQuiet': '静默时段 {start}–{end}（取消 / 解除不穿透）',
    // —— 判不了（结构性缺失）——
    'reason.noCoordinates': '本条消息未携带可用坐标，无法判定震中距',
    'reason.noTsunamiAreas': '本条没有海啸预报区数据',
    'reason.jmaNoUsableArea': '本条电文未携带可判定的区域',
    'reason.eewNoAreaData': '本条 EEW 未携带区域数据，无法按阈值判定',
    'reason.hypocenterOnly': '本条为震源情报，无震度数据，无法按阈值判定',
    'reason.unsupportedCode': '不支持的 code',
    'reason.overseasNoOrigin': '这条海外预警未携带来源关注点，无法判定',
    // —— 阈值与距离 ——
    'reason.tsunamiBelowGrade': '海啸等级未达阈值（本条 {rank} < {min}）',
    'reason.magBelow': 'M{mag} 低于{name} M{min}',
    'reason.quakeMissed': '关注地区未命中或强度低于阈值',
    'reason.tsunamiMissed': '关注地区未命中或等级低于阈值',
    'reason.distanceFrom': '{mag}距 {place} 约 {km} km（半径 {radius} km 之外）',
    'reason.magOnly': 'M{mag}',
    'reason.nearestWatch': '震中距最近的关注点（{place}）约 {km} km（半径 {radius} km 之外）',
    'reason.hitEewScale': 'EEW 预测震度达标',
    'reason.hitObservedScale': '观测震度达标',
    'reason.hitTsunamiGrade': '海啸等级达标',
    'reason.hitLevel': '警戒レベル{level}（{area}）',
    // —— 大陆行政区匹配 ——
    'reason.cnLandslideOnlyRecorded': '{what}（未达橙色，仅记录）',
    'reason.cnHit': '{what} · 命中关注点 {province}·{city}',
    'reason.cnNotWatched': '{what}（{province}·{city}）不在关注列表里',
    'reason.cnProvinceOnly': '{what} · 仅能定位到 {province}（{org}）',
    'reason.cnNoProvince': '{what} · 未能定位到省份，按全国放行',
    'reason.cnOrgUnknown': '{what} · 归属未识别（{org}）',
    'reason.cnOrgPlaceholder': '发布机构未给出市级',
    'reason.cnOrgNameUnknown': '机构名未知',
    // —— 海外源 ——
    'reason.overseasBelowLevel': '{headline}（未达播报档位，仅记录）',
    'reason.overseasHit': '命中关注点「{place}」· {headline}',
    'reason.overseasOriginGone': '来源关注点「{place}」已不在关注列表里',
    'reason.overseasHeadlineFallback': '海外气象预警',
    'reason.magThresholdReport': '速报震级阈值',
    'reason.magThresholdGlobal': '全球震级阈值',
    'reason.pointHit': '{mag}距 {place} 约 {km} km（半径 {radius} km）',
    'reason.missUnknownAreas': '{base}（另有 {n} 个区域名未能识别归属县）',
    'reason.missNarrowedByCities': '（已按所选 {n} 个市区町村收窄）',
    'reason.noCnWatch': '未设置中国大陆关注点（设置 → 灾害预警 → 关注地区 → 中国大陆 → 选省与城市）',
    'reason.weatherMissedL4': '关注地区未命中，或命中地区未达 L4',
    'reason.weatherBelowL4': '警戒レベル{level}（未达 L4，仅记录）',
    // —— 去重 / 静默 / 跨标签页（流水线自己写的）——
    'reason.duplicateMessage': '同一条消息刚处理过（去重窗口内）',
    'reason.eventRepeatSuppressed': '同一地震的后续发布（强度未升级）',
    'reason.eventRepeatDetail': '同一事件的后续发布，强度未升级',
    'reason.replaySuppressed': '同一事件在最近 24 小时内已提醒过（同强度，不重复响铃）',
    'reason.replayDetail': '该事件在最近 24 小时内已经提醒过，本次只记历史',
    'reason.staleOnArrival': '打开页面时该预警已发布约 {hours} 小时（只记历史，不打扰）',
    'reason.staleOnArrivalDetail': '发布较早，仅记录',
    'reason.quietHours': '静默时段 {start}–{end}',
    'reason.quietNoRedPierce': '（未开启红色等级穿透）',    'reason.quietHoursDetail': '当前处于静默时段',
    'reason.otherTab': '其它 DSH 标签页已提醒',
    'reason.otherTabDetail': '其它 DSH 标签页已提醒同一条',
    'reason.authoritySuppressed': '{source} 已播报同一事件，本条（{mine}）按优先源规则只计数、不进历史',
    'reason.placeUnnamed': '未命名',
    // —— 历史条目上的后缀（用户点名的那一句就在这儿）——
    'hist.missSuffix': '（未命中：{reason}）',
    'hist.hit': '已提醒',
    'hist.suppressed': '已静默',
  },
  'zh-TW': {
    'reason.sourceUnknown': '未知來源',
    'reason.noGlobalWatch': '未設定全球關注點（設定 → 災害預警 → 關注地區 → 其他國家 / 地區）',
    'reason.noOverseasWatch': '未設定海外關注點（設定 → 災害預警 → 關注地區 → 其他國家 / 地區）',
    'reason.quakeOff': '地震提醒已關閉',
    'reason.tsunamiOff': '海嘯提醒已關閉',
    'reason.weatherOff': '氣象災害提醒已關閉',
    'reason.overseasWeatherOff': '海外氣象提醒已關閉',
    'reason.cnRainstormOff': '大陸暴雨提醒已關閉',
    'reason.cnGeologyOff': '大陸地質災害提醒已關閉',
    'reason.cancelledMuted': '取消訊息不提醒',
    'reason.clearedMuted': '解除訊息不提醒',
    'reason.cancelNoPriorAlert': '取消 / 解除訊息，且此前未提醒過該事件',
    'reason.clearedIsNotAlert': '這是取消 / 解除訊息',
    'reason.cancelNoPierceQuiet': '靜默時段 {start}–{end}（取消 / 解除不穿透）',
    'reason.noCoordinates': '本則訊息未攜帶可用座標，無法判定震央距',
    'reason.noTsunamiAreas': '本則沒有海嘯預報區資料',
    'reason.jmaNoUsableArea': '本則電文未攜帶可判定的區域',
    'reason.eewNoAreaData': '本則 EEW 未攜帶區域資料，無法依門檻判定',
    'reason.hypocenterOnly': '本則為震源情報，無震度資料，無法依門檻判定',
    'reason.unsupportedCode': '不支援的 code',
    'reason.overseasNoOrigin': '這則海外預警未攜帶來來源關注點，無法判定',
    'reason.tsunamiBelowGrade': '海嘯等級未達門檻（本則 {rank} < {min}）',
    'reason.magBelow': 'M{mag} 低於{name} M{min}',
    'reason.quakeMissed': '關注地區未命中或強度低於門檻',
    'reason.tsunamiMissed': '關注地區未命中或等級低於門檻',
    'reason.distanceFrom': '{mag}距 {place} 約 {km} km（半徑 {radius} km 之外）',
    'reason.magOnly': 'M{mag}',
    'reason.nearestWatch': '震央距最近的關注點（{place}）約 {km} km（半徑 {radius} km 之外）',
    'reason.hitEewScale': 'EEW 預測震度達標',
    'reason.hitObservedScale': '觀測震度達標',
    'reason.hitTsunamiGrade': '海嘯等級達標',
    'reason.hitLevel': '警戒レベル{level}（{area}）',
    'reason.cnLandslideOnlyRecorded': '{what}（未達橙色，僅記錄）',
    'reason.cnHit': '{what} · 命中關注點 {province}·{city}',
    'reason.cnNotWatched': '{what}（{province}·{city}）不在關注清單裡',
    'reason.cnProvinceOnly': '{what} · 僅能定位到 {province}（{org}）',
    'reason.cnNoProvince': '{what} · 未能定位到省份，依全國放行',
    'reason.cnOrgUnknown': '{what} · 歸屬未識別（{org}）',
    'reason.cnOrgPlaceholder': '發布機構未給出市級',
    'reason.cnOrgNameUnknown': '機構名未知',
    'reason.overseasBelowLevel': '{headline}（未達播報檔位，僅記錄）',
    'reason.overseasHit': '命中關注點「{place}」· {headline}',
    'reason.overseasOriginGone': '來源關注點「{place}」已不在關注清單裡',
    'reason.overseasHeadlineFallback': '海外氣象預警',
    'reason.magThresholdReport': '速報震級門檻',
    'reason.magThresholdGlobal': '全球震級門檻',
    'reason.pointHit': '{mag}距 {place} 約 {km} km（半徑 {radius} km）',
    'reason.missUnknownAreas': '{base}（另有 {n} 個區域名未能識別歸屬縣）',
    'reason.missNarrowedByCities': '（已依所選 {n} 個市區町村收窄）',
    'reason.noCnWatch': '未設定中國大陸關注點（設定 → 災害預警 → 關注地區 → 中國大陸 → 選省與城市）',
    'reason.weatherMissedL4': '關注地區未命中，或命中地區未達 L4',
    'reason.weatherBelowL4': '警戒レベル{level}（未達 L4，僅記錄）',
    'reason.duplicateMessage': '同一則訊息剛處理過（去重視窗內）',
    'reason.eventRepeatSuppressed': '同一地震的後續發布（強度未升級）',
    'reason.eventRepeatDetail': '同一事件的後續發布，強度未升級',
    'reason.replaySuppressed': '同一事件在最近 24 小時內已提醒過（同強度，不重複響鈴）',
    'reason.replayDetail': '該事件在最近 24 小時內已經提醒過，本次只記歷史',
    'reason.staleOnArrival': '打開頁面時該預警已發布約 {hours} 小時（只記歷史，不打擾）',
    'reason.staleOnArrivalDetail': '發布較早，僅記錄',
    'reason.quietHours': '靜默時段 {start}–{end}',
    'reason.quietNoRedPierce': '（未開啟紅色等級穿透）',
    'reason.quietHoursDetail': '目前處於靜默時段',
    'reason.otherTab': '其它 DSH 分頁已提醒',
    'reason.otherTabDetail': '其它 DSH 分頁已提醒同一則',
    'reason.authoritySuppressed': '{source} 已播報同一事件，本則（{mine}）依優先源規則只計數、不進歷史',
    'reason.placeUnnamed': '未命名',
    'hist.missSuffix': '（未命中：{reason}）',
    'hist.hit': '已提醒',
    'hist.suppressed': '已靜默',
  },
  ja: {
    'reason.sourceUnknown': '不明なソース',
    'reason.noGlobalWatch': '海外の関心地点が未設定（設定 → 災害警報 → 関心地区 → その他の国 / 地域）',
    'reason.noOverseasWatch': '海外の関心地点が未設定（設定 → 災害警報 → 関心地区 → その他の国 / 地域）',
    'reason.quakeOff': '地震の通知はオフです',
    'reason.tsunamiOff': '津波の通知はオフです',
    'reason.weatherOff': '気象災害の通知はオフです',
    'reason.overseasWeatherOff': '海外の気象の通知はオフです',
    'reason.cnRainstormOff': '中国大陸の大雨の通知はオフです',
    'reason.cnGeologyOff': '中国大陸の地質災害の通知はオフです',
    'reason.cancelledMuted': '取消の電文は通知しません',
    'reason.clearedMuted': '解除の電文は通知しません',
    'reason.cancelNoPriorAlert': '取消 / 解除の電文で、かつこの事象はまだ通知していません',
    'reason.clearedIsNotAlert': 'これは取消 / 解除の電文です',
    'reason.cancelNoPierceQuiet': 'サイレント時間帯 {start}–{end}（取消 / 解除は貫通しません）',
    'reason.noCoordinates': 'この電文には有効な座標がなく、震央距離を判定できません',
    'reason.noTsunamiAreas': 'この電文には津波予報区のデータがありません',
    'reason.jmaNoUsableArea': 'この電文には判定できる区域がありません',
    'reason.eewNoAreaData': 'この EEW には区域データがなく、しきい値で判定できません',
    'reason.hypocenterOnly': 'これは震源情報で震度データがなく、しきい値で判定できません',
    'reason.unsupportedCode': '対応していない code',
    'reason.overseasNoOrigin': 'この海外警報には元の関心地点がなく、判定できません',
    'reason.tsunamiBelowGrade': '津波の等級がしきい値未満（本次 {rank} < {min}）',
    'reason.magBelow': 'M{mag} は{name} M{min} 未満',
    'reason.quakeMissed': '関心地区に該当しないか、しきい値未満の震度です',
    'reason.tsunamiMissed': '関心地区に該当しないか、しきい値未満の等級です',
    'reason.distanceFrom': '{mag}は {place} から約 {km} km（半径 {radius} km の外）',
    'reason.magOnly': 'M{mag}',
    'reason.nearestWatch': '震央に最も近い関心地点（{place}）から約 {km} km（半径 {radius} km の外）',
    'reason.hitEewScale': 'EEW の予想震度がしきい値に達しました',
    'reason.hitObservedScale': '観測震度がしきい値に達しました',
    'reason.hitTsunamiGrade': '津波の等級がしきい値に達しました',
    'reason.hitLevel': '警戒レベル{level}（{area}）',
    'reason.cnLandslideOnlyRecorded': '{what}（オレンジ未満のため記録のみ）',
    'reason.cnHit': '{what} · 関心地点 {province}·{city} に該当',
    'reason.cnNotWatched': '{what}（{province}·{city}）は関心リストにありません',
    'reason.cnProvinceOnly': '{what} · {province} までしか特定できません（{org}）',
    'reason.cnNoProvince': '{what} · 省まで特定できないため全国として通します',
    'reason.cnOrgUnknown': '{what} · 帰属を識別できません（{org}）',
    'reason.cnOrgPlaceholder': '発表機関が市レベルを示していません',
    'reason.cnOrgNameUnknown': '機関名不明',
    'reason.overseasBelowLevel': '{headline}（通知のしきい値未満のため記録のみ）',
    'reason.overseasHit': '関心地点「{place}」に該当 · {headline}',
    'reason.overseasOriginGone': '元の関心地点「{place}」は関心リストにありません',
    'reason.overseasHeadlineFallback': '海外の気象警報',
    'reason.magThresholdReport': '速報のマグニチュードしきい値',
    'reason.magThresholdGlobal': '世界のマグニチュードしきい値',
    'reason.pointHit': '{mag}は {place} から約 {km} km（半径 {radius} km）',
    'reason.missUnknownAreas': '{base}（ほか {n} 件の区域名は所属県を特定できません）',
    'reason.missNarrowedByCities': '（選択した {n} 市区町村で絞り込み済み）',
    'reason.noCnWatch': '中国大陸の関心地点が未設定（設定 → 災害警報 → 関心地区 → 中国大陸 → 省と市を選択）',
    'reason.weatherMissedL4': '関心地区に該当しないか、該当地区が L4 未満です',
    'reason.weatherBelowL4': '警戒レベル{level}（L4 未満のため記録のみ）',
    'reason.duplicateMessage': '同じ電文を直前に処理済み（重複排除の窓内）',
    'reason.eventRepeatSuppressed': '同じ地震の続報（強度が上がっていない）',
    'reason.eventRepeatDetail': '同じ事象の続報で、強度が上がっていません',
    'reason.replaySuppressed': '同じ事象は直近 24 時間に通知済み（同強度のため再通知しません）',
    'reason.replayDetail': 'この事象は直近 24 時間に通知済みのため、今回は履歴のみ',
    'reason.staleOnArrival': 'ページを開いた時点で発表から約 {hours} 時間経過（履歴のみ）',
    'reason.staleOnArrivalDetail': '発表が早いため記録のみ',
    'reason.quietHours': 'サイレント時間帯 {start}–{end}',
    'reason.quietNoRedPierce': '（赤レベルの貫通は無効）',
    'reason.quietHoursDetail': '現在はサイレント時間帯です',
    'reason.otherTab': '他の DSH タブが通知済み',
    'reason.otherTabDetail': '他の DSH タブが同じ電文を通知済み',
    'reason.authoritySuppressed': '{source} が同じ事象を通知済みのため、本件（{mine}）は優先ソースのルールにより計数のみで履歴に入れません',
    'reason.placeUnnamed': '名称未設定',
    'hist.missSuffix': '（未命中：{reason}）',
    'hist.hit': '通知済み',
    'hist.suppressed': 'サイレント',
  },
  en: {
    'reason.sourceUnknown': 'unknown source',
    'reason.noGlobalWatch': 'No global watch point configured (Settings → Disasters → Regions → Other countries / regions)',
    'reason.noOverseasWatch': 'No overseas watch point configured (Settings → Disasters → Regions → Other countries / regions)',
    'reason.quakeOff': 'Earthquake alerts are off',
    'reason.tsunamiOff': 'Tsunami alerts are off',
    'reason.weatherOff': 'Weather alerts are off',
    'reason.overseasWeatherOff': 'Overseas weather alerts are off',
    'reason.cnRainstormOff': 'Mainland heavy-rain alerts are off',
    'reason.cnGeologyOff': 'Mainland geological-hazard alerts are off',
    'reason.cancelledMuted': 'Cancellations are not announced',
    'reason.clearedMuted': 'Clearances are not announced',
    'reason.cancelNoPriorAlert': 'a cancellation / clearance, and this event was never announced',
    'reason.clearedIsNotAlert': 'this is a cancellation / clearance',
    'reason.cancelNoPierceQuiet': 'quiet hours {start}–{end} (cancellations do not break through)',
    'reason.noCoordinates': 'the message carries no usable coordinates, so the distance cannot be judged',
    'reason.noTsunamiAreas': 'the message has no tsunami forecast areas',
    'reason.jmaNoUsableArea': 'the telegram carries no area that can be judged',
    'reason.eewNoAreaData': 'this EEW carries no area data, so the threshold cannot be applied',
    'reason.hypocenterOnly': 'this is an epicentre report with no intensity data, so the threshold cannot be applied',
    'reason.unsupportedCode': 'unsupported code',
    'reason.overseasNoOrigin': 'this overseas alert carries no source watch point, so it cannot be judged',
    'reason.tsunamiBelowGrade': 'tsunami grade below the threshold (this one {rank} < {min})',
    'reason.magBelow': 'M{mag} is below the {name} threshold of M{min}',
    'reason.quakeMissed': 'no watch area matched, or the intensity is below the threshold',
    'reason.tsunamiMissed': 'no watch area matched, or the grade is below the threshold',
    'reason.distanceFrom': '{mag} about {km} km from {place} (outside the {radius} km radius)',
    'reason.magOnly': 'M{mag}',
    'reason.nearestWatch': 'about {km} km from the nearest watch point ({place}) — outside the {radius} km radius',
    'reason.hitEewScale': 'EEW predicted intensity reached the threshold',
    'reason.hitObservedScale': 'observed intensity reached the threshold',
    'reason.hitTsunamiGrade': 'tsunami grade reached the threshold',
    'reason.hitLevel': 'level {level} ({area})',
    'reason.cnLandslideOnlyRecorded': '{what} (below orange — recorded only)',
    'reason.cnHit': '{what} · matched watch point {province}·{city}',
    'reason.cnNotWatched': '{what} ({province}·{city}) is not in the watch list',
    'reason.cnProvinceOnly': '{what} · could only be located to {province} ({org})',
    'reason.cnNoProvince': '{what} · province could not be determined, so it is passed nationwide',
    'reason.cnOrgUnknown': '{what} · issuing office not recognized ({org})',
    'reason.cnOrgPlaceholder': 'the issuer gave no city level',
    'reason.cnOrgNameUnknown': 'office name unknown',
    'reason.overseasBelowLevel': '{headline} (below the announcement level — recorded only)',
    'reason.overseasHit': 'matched watch point "{place}" · {headline}',
    'reason.overseasOriginGone': 'source watch point "{place}" is no longer in the watch list',
    'reason.overseasHeadlineFallback': 'overseas weather alert',
    'reason.magThresholdReport': 'rapid-report magnitude threshold',
    'reason.magThresholdGlobal': 'global magnitude threshold',
    'reason.pointHit': '{mag}about {km} km from {place} (within the {radius} km radius)',
    'reason.missUnknownAreas': '{base} (another {n} area names could not be tied to a prefecture)',
    'reason.missNarrowedByCities': ' (narrowed to the {n} selected municipalities)',
    'reason.noCnWatch': 'No mainland-China watch point configured (Settings → Disasters → Regions → Mainland China → pick a province and city)',
    'reason.weatherMissedL4': 'no watch area matched, or the matched area is below level 4',
    'reason.weatherBelowL4': 'level {level} (below level 4 — recorded only)',
    'reason.duplicateMessage': 'the same message was just handled (inside the dedupe window)',
    'reason.eventRepeatSuppressed': 'a follow-up report of the same earthquake (intensity unchanged)',
    'reason.eventRepeatDetail': 'a follow-up of the same event, with no intensity upgrade',
    'reason.replaySuppressed': 'this event was already announced within the last 24 hours (same strength)',
    'reason.replayDetail': 'already announced within the last 24 hours — history only this time',
    'reason.staleOnArrival': 'published about {hours} hours before the page was opened (history only)',
    'reason.staleOnArrivalDetail': 'published a while ago — recorded only',
    'reason.quietHours': 'quiet hours {start}–{end}',
    'reason.quietNoRedPierce': ' (red-level piercing is off)',
    'reason.quietHoursDetail': 'currently inside quiet hours',
    'reason.otherTab': 'another DSH tab already announced it',
    'reason.otherTabDetail': 'another DSH tab already announced the same message',
    'reason.authoritySuppressed': '{source} already announced the same event, so this one ({mine}) is counted only and stays out of the history',
    'reason.placeUnnamed': 'unnamed',
    'hist.missSuffix': ' (not matched: {reason})',
    'hist.hit': 'announced',
    'hist.suppressed': 'silenced',
  },
};

// ============================================================================
// dsh-quake-alert · client/src/00-i18n.js
//
// 作用：界面语言的唯一入口——语言清单与显示名、BCP 47 回退链、文案表汇总与自校验、t() 取词。
// 依赖：各 `00x-texts-*.js` 文案文件（纯数据，不 import 任何模块）。
//
// 语言值域是本文件自己的 BCP 47 清单，不对齐宿主的 zh / en（宿主只校验 BCP 47 形状）。
// 加一种语言 = LANGS 加一项 + LANGUAGE_LABELS 加一项 + 每份文案文件补一栏，三者缺一不可；
// 漏一份语言或漏一条 key 都在加载期抛错。只翻我们生成的文本，源侧 headline / detail /
// 地名 / kindLabel / reason 一律原样透传。t() 取不到 key 时回显 key 本身。
// ============================================================================


// ---------- 语言清单（顺序即设置页下拉顺序） ----------
/** 支持的语言，BCP 47 完整标识。加语言要同时改 LANGS、LANGUAGE_LABELS 与每份文案表。 */
const LANGS = ['zh-CN', 'zh-TW', 'ja', 'en'];
/** 默认语言。也是「配置里的值认不出」时的回退终点。 */
const DEFAULT_LANGUAGE = 'zh-CN';
/** 语言显示名：按该语言自己的写法（语言选择器里不出现用户看不懂的自己语言名）。 */
const LANGUAGE_LABELS = { 'zh-CN': '简体中文', 'zh-TW': '繁體中文', ja: '日本語', en: 'English' };

/**
 * 繁体侧的地区子标签（小写比较）；脚本子标签 `hant` / `hans` 在 resolveLang 里单独处理。
 * 中文的地区变体不能像 `ja-JP` 那样按主语言匹配：`zh-HK` / `zh-TW` 的用户要繁体，
 * 而按主语言匹配只会落到清单里第一个 `zh-*`（`zh-CN`），界面上看不出异常。
 */
const HANT_REGIONS = ['tw', 'hk', 'mo'];

// ---------- 文案表汇总 ----------
const PARTS = [CORE, SETTINGS, CONFIG_IO, UNITS, EVENTS, REASONS];

/**
 * 把文案文件按语言合并成 `{ lang: { key: text } }`，并当场校验：每份文案文件覆盖 LANGS 的每一种语言、
 * 内部各语言的 key 集合完全相同、不同文案文件之间没有重复 key。任一条不满足就抛错，装载即失败。
 */
function mergeParts(parts) {
  // 每个语言还得有显示名（语言下拉的 label），否则 LANGUAGE_OPTIONS 会产出 label: undefined
  for (const lang of LANGS) {
    if (typeof LANGUAGE_LABELS[lang] !== 'string' || !LANGUAGE_LABELS[lang]) {
      throw new Error('i18n 语言缺显示名（LANGUAGE_LABELS）：' + lang)
    }
  }
  const tables = {};
  for (const lang of LANGS) tables[lang] = {};
  for (const part of parts) {
    for (const lang of LANGS) {
      if (!part[lang]) throw new Error('i18n 文案表缺语言：' + lang)
    }
    const baseKeys = Object.keys(part[LANGS[0]]).sort();
    for (const lang of LANGS.slice(1)) {
      const curKeys = Object.keys(part[lang]);
      const missing = baseKeys.filter((k) => !Object.prototype.hasOwnProperty.call(part[lang], k));
      const extra = curKeys.filter((k) => !baseKeys.includes(k));
      if (missing.length || extra.length) {
        throw new Error('i18n 表不齐（' + lang + '）：缺 [' + missing.join(', ') + '] 多 [' + extra.join(', ') + ']')
      }
    }
    for (const lang of LANGS) {
      for (const k of Object.keys(part[lang])) {
        if (Object.prototype.hasOwnProperty.call(tables[lang], k)) {
          throw new Error('i18n key 重复：' + lang + ' / ' + k)
        }
        tables[lang][k] = part[lang][k];
      }
    }
  }
  return tables
}

const TABLES = mergeParts(PARTS);

// ---------- 当前语言 ----------
let currentLang = DEFAULT_LANGUAGE;

/**
 * 把任意值解析成清单里的语言，逐级回退：精确匹配（大小写不敏感）→ 中文按脚本 / 地区分流
 * （`zh-TW` / `zh-HK` / `zh-Hant` → `zh-TW`，`zh` / `zh-CN` / `zh-SG` / `zh-Hans` → `zh-CN`）
 * → 其它主语言匹配（`ja-JP` → `ja`）→ 默认语言。
 */
function resolveLang(value) {
  const raw = String(value === undefined || value === null ? '' : value).trim();
  if (!raw) return DEFAULT_LANGUAGE
  const lower = raw.toLowerCase();
  const exact = LANGS.find((l) => l.toLowerCase() === lower);
  if (exact) return exact
  const parts = lower.split('-');
  // 中文这一支必须先看脚本与地区子标签，再看主语言：清单里主语言匹配只取第一个 `zh-*`（简体）。
  // 且脚本优先于地区：`zh-Hans-HK` 是简体字形 + 香港地区，判成繁体是错的；`zh-Hant-CN` 反之。
  if (parts[0] === 'zh') {
    const subs = parts.slice(1);
    if (subs.indexOf('hant') !== -1) return 'zh-TW'
    if (subs.indexOf('hans') !== -1) return 'zh-CN'
    return subs.some((p) => HANT_REGIONS.indexOf(p) !== -1) ? 'zh-TW' : 'zh-CN'
  }
  const byBase = LANGS.find((l) => l.split('-')[0].toLowerCase() === parts[0]);
  return byBase || DEFAULT_LANGUAGE
}

/** 设置当前界面语言（值认不出时按回退链落到默认语言）。返回生效后的值。 */
function setLanguage(value) {
  currentLang = resolveLang(value);
  return currentLang
}

function getLanguage() { return currentLang }

/** 取词。params 用于替换 `{name}`；缺 key 时回显 key 本身。 */
function t(key, params) {
  const k = String(key);
  const table = TABLES[currentLang] || TABLES[DEFAULT_LANGUAGE];
  // 用 hasOwnProperty 而不是 `table[k]`：key 恰好叫 `constructor` / `toString` 时会命中原型链。
  let s = Object.prototype.hasOwnProperty.call(table, k) ? table[k] : undefined;
  if (s === undefined) {
    const def = TABLES[DEFAULT_LANGUAGE];
    s = Object.prototype.hasOwnProperty.call(def, k) ? def[k] : undefined;
  }
  if (s === undefined) return k
  if (params) {
    s = s.replace(/\{(\w+)\}/g, (m, name) => (
      Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : m
    ));
  }
  return s
}

/** 某语言的整张表（回归用：校验各语言 key 集合一致、zh-CN 与旧字面量一致）。 */
function tableOf(lang) {
  return TABLES[resolveLang(lang)] || TABLES[DEFAULT_LANGUAGE]
}

// ============================================================================
// dsh-quake-alert · client/src/00d-texts-regions.js
//
// 作用：日本 47 都道府县的显示名表（英文罗马字 + 繁体中文），键与 `PREFECTURES[].jp` 一一对应。
// 内容：PREF_EN、PREF_HANT。纯数据对象，不 import 任何模块。
//
// 匹配一律用 `01-constants` 的 `PREFECTURES[].jp`（日文全称），这里只供显示，不能反过来喂匹配。
// 罗马字按平文式通行拼法（`Gifu` / `Hyogo` / `Kochi`）；繁体名去「都 / 府 / 県」、保留「道」，
// 字形按繁体通行写法（`静岡` → `靜岡`、`広島` → `廣島`），不照抄日文汉字。
// ============================================================================

/** 都道府县（日文全称）→ 英文显示名。键与 `PREFECTURES[].jp` 一一对应。 */
const PREF_EN = {
  '北海道': 'Hokkaido',
  '青森県': 'Aomori',
  '岩手県': 'Iwate',
  '宮城県': 'Miyagi',
  '秋田県': 'Akita',
  '山形県': 'Yamagata',
  '福島県': 'Fukushima',
  '茨城県': 'Ibaraki',
  '栃木県': 'Tochigi',
  '群馬県': 'Gunma',
  '埼玉県': 'Saitama',
  '千葉県': 'Chiba',
  '東京都': 'Tokyo',
  '神奈川県': 'Kanagawa',
  '新潟県': 'Niigata',
  '富山県': 'Toyama',
  '石川県': 'Ishikawa',
  '福井県': 'Fukui',
  '山梨県': 'Yamanashi',
  '長野県': 'Nagano',
  '岐阜県': 'Gifu',
  '静岡県': 'Shizuoka',
  '愛知県': 'Aichi',
  '三重県': 'Mie',
  '滋賀県': 'Shiga',
  '京都府': 'Kyoto',
  '大阪府': 'Osaka',
  '兵庫県': 'Hyogo',
  '奈良県': 'Nara',
  '和歌山県': 'Wakayama',
  '鳥取県': 'Tottori',
  '島根県': 'Shimane',
  '岡山県': 'Okayama',
  '広島県': 'Hiroshima',
  '山口県': 'Yamaguchi',
  '徳島県': 'Tokushima',
  '香川県': 'Kagawa',
  '愛媛県': 'Ehime',
  '高知県': 'Kochi',
  '福岡県': 'Fukuoka',
  '佐賀県': 'Saga',
  '長崎県': 'Nagasaki',
  '熊本県': 'Kumamoto',
  '大分県': 'Oita',
  '宮崎県': 'Miyazaki',
  '鹿児島県': 'Kagoshima',
  '沖縄県': 'Okinawa',
};

/** 都道府县（日文全称）→ 繁体中文显示名。用字规则见文件头。键与 `PREFECTURES[].jp` 一一对应。 */
const PREF_HANT = {
  '北海道': '北海道',
  '青森県': '青森',
  '岩手県': '岩手',
  '宮城県': '宮城',
  '秋田県': '秋田',
  '山形県': '山形',
  '福島県': '福島',
  '茨城県': '茨城',
  '栃木県': '栃木',
  '群馬県': '群馬',
  '埼玉県': '埼玉',
  '千葉県': '千葉',
  '東京都': '東京',
  '神奈川県': '神奈川',
  '新潟県': '新潟',
  '富山県': '富山',
  '石川県': '石川',
  '福井県': '福井',
  '山梨県': '山梨',
  '長野県': '長野',
  '岐阜県': '岐阜',
  '静岡県': '靜岡',
  '愛知県': '愛知',
  '三重県': '三重',
  '滋賀県': '滋賀',
  '京都府': '京都',
  '大阪府': '大阪',
  '兵庫県': '兵庫',
  '奈良県': '奈良',
  '和歌山県': '和歌山',
  '鳥取県': '鳥取',
  '島根県': '島根',
  '岡山県': '岡山',
  '広島県': '廣島',
  '山口県': '山口',
  '徳島県': '德島',
  '香川県': '香川',
  '愛媛県': '愛媛',
  '高知県': '高知',
  '福岡県': '福岡',
  '佐賀県': '佐賀',
  '長崎県': '長崎',
  '熊本県': '熊本',
  '大分県': '大分',
  '宮崎県': '宮崎',
  '鹿児島県': '鹿兒島',
  '沖縄県': '沖繩',
};

// ============================================================================
// dsh-quake-alert · client/src/01-constants.js
// 全仓库唯一的常量与默认配置来源：震度档位、海啸等级、47 都道府县表、DEFAULT_CFG、存储 key、
// 重连参数、历史上限等。依赖 00-i18n、00d-texts-regions。新的共享常量放这里。
// ============================================================================

const h = React.createElement;
const { useState, useEffect, useRef } = React;

// ---------- 常量 ----------
const WS_URL = 'wss://api.p2pquake.net/v2/ws';
const SANDBOX_URL = 'wss://api-realtime-sandbox.p2pquake.net/v2/ws';
const EMSC_WS_URL = 'wss://www.seismicportal.eu/standing_order/websocket';
const STORAGE_KEY = 'dsh.quakeAlert.v1';
const HISTORY_KEY = 'dsh.quakeAlert.history';
// 源健康记录：**唯一**一处跨刷新保留的运行时状态，存「某个源的解析在什么时候因为什么失败了」。 连接状态不在这里：重启即重新建连，旧值没有意义。
const HEALTH_KEY = 'dsh.quakeAlert.health';
const ALERTED_KEY = 'dsh.quakeAlert.alerted';
const HISTORY_MAX = 30; // 「最近预警」保留条数（内存与设置页展示）
// 「最近预警」的时间上限，与 HISTORY_MAX 条数上限同时生效、取更严格的
const HISTORY_MAX_AGE_MS = 5 * 24 * 60 * 60 * 1000;
const MAX_WATCH_CITIES = 300; // 关注市区町村上限（防止配置与 UI 被撑爆）
const MAX_WATCH_PLACES = 20;
const RECONNECT_BASE = 1000; // 重连间隔递增的起点 1s
const RECONNECT_MAX = 60000; // 封顶 60s
// 用户可选的最低震度档位（值 = P2PQuake scale）。labelKey 由渲染时的取词函数解析成各语言文案。
const SCALE_OPTIONS = [
  { v: 10, labelKey: 'scaleOpt.10' }, { v: 20, labelKey: 'scaleOpt.20' }, { v: 30, labelKey: 'scaleOpt.30' },
  { v: 40, labelKey: 'scaleOpt.40' }, { v: 45, labelKey: 'scaleOpt.45' }, { v: 50, labelKey: 'scaleOpt.50' },
  { v: 55, labelKey: 'scaleOpt.55' }, { v: 60, labelKey: 'scaleOpt.60' }, { v: 70, labelKey: 'scaleOpt.70' },
];
const TSUNAMI_RANK = { Watch: 1, Warning: 2, MajorWarning: 3 };
const TSUNAMI_OPTIONS = [
  { g: 'Watch', labelKey: 'tsunamiOpt.Watch' },
  { g: 'Warning', labelKey: 'tsunamiOpt.Warning' },
  { g: 'MajorWarning', labelKey: 'tsunamiOpt.MajorWarning' },
];
// 全球源（EMSC / USGS）的最低震级档位，默认取 M4.5
const GLOBAL_MAG_OPTIONS = [
  { v: 3, labelKey: 'magOpt.3' }, { v: 3.5, labelKey: 'magOpt.3.5' }, { v: 4, labelKey: 'magOpt.4' },
  { v: 4.5, labelKey: 'magOpt.4.5' }, { v: 5, labelKey: 'magOpt.5' }, { v: 5.5, labelKey: 'magOpt.5.5' },
  { v: 6, labelKey: 'magOpt.6' }, { v: 6.5, labelKey: 'magOpt.6.5' }, { v: 7, labelKey: 'magOpt.7' },
];
// 大陆速报（cenc_eqlist）的独立门槛：速报覆盖低到 M2.5，不与预警共用
const CN_REPORT_MAG_OPTIONS = [
  { v: 3.5, labelKey: 'magOpt.3.5' }, { v: 4, labelKey: 'magOpt.4' },
  { v: 4.5, labelKey: 'magOpt.4.5' }, { v: 5, labelKey: 'magOpt.5' },
  { v: 5.5, labelKey: 'magOpt.5.5' }, { v: 6, labelKey: 'magOpt.6' },
];

// ---------- 关注点半径 ----------
const RADIUS_PRESETS = [
  { v: 30, labelKey: 'radius.30' },
  { v: 100, labelKey: 'radius.100' },
  { v: 300, labelKey: 'radius.300' },
];
// 新建关注点的默认半径；既有配置里的 radiusKm 一律不动
const DEFAULT_PLACE_RADIUS_KM = 100;
// 关注点缺 radiusKm 或值非法时的兜底：取比默认值宽的 300，避免收窄用户已配好的监控范围
const LEGACY_PLACE_RADIUS_KM = 300;
const MIN_PLACE_RADIUS_KM = 1;
const MAX_PLACE_RADIUS_KM = 2000;

// 日本 47 都道府县：jp 为匹配用日文全称（P2PQuake pref 格式），zh 为界面显示
const PREFECTURES = [
  ['北海道', '北海道'], ['青森県', '青森'], ['岩手県', '岩手'], ['宮城県', '宫城'],
  ['秋田県', '秋田'], ['山形県', '山形'], ['福島県', '福岛'], ['茨城県', '茨城'],
  ['栃木県', '栃木'], ['群馬県', '群马'], ['埼玉県', '埼玉'], ['千葉県', '千叶'],
  ['東京都', '东京'], ['神奈川県', '神奈川'], ['新潟県', '新潟'], ['富山県', '富山'],
  ['石川県', '石川'], ['福井県', '福井'], ['山梨県', '山梨'], ['長野県', '长野'],
  ['岐阜県', '岐阜'], ['静岡県', '静冈'], ['愛知県', '爱知'], ['三重県', '三重'],
  ['滋賀県', '滋贺'], ['京都府', '京都'], ['大阪府', '大阪'], ['兵庫県', '兵库'],
  ['奈良県', '奈良'], ['和歌山県', '和歌山'], ['鳥取県', '鸟取'], ['島根県', '岛根'],
  ['岡山県', '冈山'], ['広島県', '广岛'], ['山口県', '山口'], ['徳島県', '德岛'],
  ['香川県', '香川'], ['愛媛県', '爱媛'], ['高知県', '高知'], ['福岡県', '福冈'],
  ['佐賀県', '佐贺'], ['長崎県', '长崎'], ['熊本県', '熊本'], ['大分県', '大分'],
  ['宮崎県', '宫崎'], ['鹿児島県', '鹿儿岛'], ['沖縄県', '冲绳'],
].map(([jp, zh]) => ({ jp, zh }));
const PREF_SET = new Set(PREFECTURES.map((p) => p.jp));
// PREFECTURES 的顺序就是 JIS 码 01..47，而気象庁电文的区域码前两位正是都道府県码。 判县优先用 code 而不是名称：名称有 25 例同名跨县（伊達市 北海道/福島県），已改制的旧名也会认错。
const PREF_BY_CODE = {};
PREFECTURES.forEach((p, i) => { PREF_BY_CODE[String(i + 1).padStart(2, '0')] = p.jp; });
/** 区域码 → 都道府県名（取前两位；认不出返回空字符串）。 */
function prefOfCode(code) {
  const s = String(code === undefined || code === null ? '' : code).trim();
  if (!/^\d{4,}$/.test(s)) return ''
  const hit = PREF_BY_CODE[s.slice(0, 2)];
  return hit || ''
}
/** 都道府県名 → 2 位都道府県码（认不出返回空字符串）。 */
function prefCodeOf(pref) {
  const i = PREFECTURES.findIndex((p) => p.jp === pref);
  return i === -1 ? '' : String(i + 1).padStart(2, '0')
}
// 都道府県简写 → 全称：源里的 pref 多半是全称，但出现过「京都」这类简写，不统一成全称就会与用户 勾选的「京都府」永不相等（静默漏报）。只削 県 / 都 / 府——「北海道」本身就是全称。
const PREF_SHORT = {};
for (const p of PREFECTURES) {
  const short = p.jp.replace(/[都府県]$/, '');
  if (short !== p.jp && !Object.prototype.hasOwnProperty.call(PREF_SHORT, short)) PREF_SHORT[short] = p.jp;
}
function normalizePref(raw) {
  const s = String(raw === undefined || raw === null ? '' : raw).trim();
  if (!s || PREF_SET.has(s)) return s
  return Object.prototype.hasOwnProperty.call(PREF_SHORT, s) ? PREF_SHORT[s] : s
}

/** 都道府県的**显示名**（随界面语言变）：日文用原名，简体用 PREFECTURES[].zh，繁体用 PREF_HANT， 英文用 PREF_EN；`jp` 那一栏是匹配用的形状，显示不能复用它。认不出的原样返回。 */
function prefLabelOf(pref) {
  const s = String(pref === undefined || pref === null ? '' : pref).trim();
  if (!s) return ''
  const hit = PREFECTURES.find((p) => p.jp === s);
  if (!hit) return s
  const lang = getLanguage();
  if (lang === 'ja') return hit.jp
  if (lang === 'en') return PREF_EN[hit.jp] || hit.jp
  // 繁体缺项时回退到**日文原名**，与 en 分支同形：回退到 `hit.zh` 会在繁体界面里混进简体字形
  if (lang === 'zh-TW') return PREF_HANT[hit.jp] || hit.jp
  return hit.zh
}

// ---------- 时间：源时区 → 带偏移的 ISO 8601 ----------
// P2PQuake 与 Wolfx 给的时间串**自己不带时区**，解析器负责补成带偏移的 ISO 8601，UI 只按本地
// 时区渲染；其余源本身是绝对时间（JMA 带 +09:00、USGS 是 epoch 毫秒、EMSC 带 Z、NOAA 的 <sent>
// 带偏移）。历史里带不了偏移的旧数据一律按 JST 解释。
const P2P_TZ_OFFSET = '+09:00';
const P2P_TIME_RE = /^(\d{4})\/(\d{2})\/(\d{2})[ T](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?$/;
/** P2PQuake 的裸 JST 时间串 → 带 +09:00 偏移的 ISO 8601；认不出时**原样返回**（绝不丢信息）。 */
function p2pTimeToIso(raw) {
  const s = String(raw === undefined || raw === null ? '' : raw).trim();
  if (!s) return ''
  const m = P2P_TIME_RE.exec(s);
  if (!m) return s
  const ms = m[7] ? m[7].padEnd(3, '0').slice(0, 3) : '';
  return m[1] + '-' + m[2] + '-' + m[3] + 'T' + m[4] + ':' + m[5] + ':' + m[6] +
    (ms ? '.' + ms : '') + P2P_TZ_OFFSET
}
// Wolfx 的 cenc_eew / cenc_eqlist 给的是裸北京时间，与中国全境单一时区、无夏令时，偏移恒为 +08:00
const CN_TZ_OFFSET = '+08:00';
const CN_TIME_RE = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?$/;
/** 大陆源的裸北京时间串 → 带 +08:00 偏移的 ISO 8601；认不出时**原样返回**（绝不丢信息）。 */
function cnTimeToIso(raw) {
  const s = String(raw === undefined || raw === null ? '' : raw).trim();
  if (!s) return ''
  const m = CN_TIME_RE.exec(s);
  if (!m) return s
  const ms = m[7] ? m[7].padEnd(3, '0').slice(0, 3) : '';
  return m[1] + '-' + m[2] + '-' + m[3] + 'T' + m[4] + ':' + m[5] + ':' + m[6] +
    (ms ? '.' + ms : '') + CN_TZ_OFFSET
}
/** 时间串 → Date。JST 串与北京串看起来只差分隔符，所以按各自的正则分别补偏移，不能只判一种。 */
function issuedToDate(raw) {
  const s = String(raw === undefined || raw === null ? '' : raw).trim();
  if (!s) return null
  const d = new Date(P2P_TIME_RE.test(s) ? p2pTimeToIso(s) : (CN_TIME_RE.test(s) ? cnTimeToIso(s) : s));
  return Number.isFinite(d.getTime()) ? d : null
}
/** 时间串 → 本地时区文案（历史详情用）；无法解析时原样返回，不把原文弄丢。 */
function formatIssuedLocal(raw) {
  const d = issuedToDate(raw);
  if (!d) return String(raw === undefined || raw === null ? '' : raw)
  try {
    return new Intl.DateTimeFormat(undefined, {
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
    }).format(d)
  } catch (err) { return d.toISOString() }
}

// ---------- 界面语言 ----------
// 选项从 00-i18n 的语言清单派生：加一种语言只改 00-i18n 与文案表，配置契约一行都不用动
const LANGUAGE_OPTIONS = LANGS.map((v) => ({ v, label: LANGUAGE_LABELS[v] }));

const DEFAULT_CFG = {
  version: 1,
  source: 'prod', // prod | sandbox（沙箱回放 2023 年历史，约30秒/条，测试用）
  // auto = SSE 优先、走不通自动降级为轮询；poll = 用户强制轮询
  cnTransport: 'auto',
  // 两种关注模式并存，互不影响（日本用户不用配 places，全球用户不用配 prefectures）： · 行政区（prefectures / cities）——日本源用，粒度到市区町村 · 坐标点（places）——全球源用，判定「震中距 ≤ radiusKm」
  watch: { prefectures: [], cities: [], places: [] },
  disasters: { earthquake: true, tsunami: true, weather: true, cnRainstorm: true, cnGeology: true, overseasWeather: true }, // weather = 日本气象灾害（泥石流 / 洪水 / 大雨 / 高潮…），固定 L4 以上播报；cnRainstorm / cnGeology = 中国大陆气象灾害（0.5.2），固定橙色以上播报；overseasWeather = 海外气象灾害（0.6.0，美国 NWS + 加拿大 ECCC），一个开关覆盖两个"按关注点生效"的源
  // globalMagnitude：全球源（EMSC / USGS）的最低震级；cnReportMagnitude：大陆速报的独立门槛 （大陆地震预警与全球源共用 globalMagnitude——同样是"只有震级、没有分区烈度"的坐标型源）
  thresholds: {
    quakeScale: 40, eewScale: 45, tsunamiGrade: 'Watch',
    globalMagnitude: 4.5, cnReportMagnitude: 4.5,
  },
  notify: { sound: true, system: true, volume: 0.7, soundQuake: true, soundTsunami: true, soundWeather: true },
  dedupe: { windowMinutes: 10 },
  // 静默时段：按浏览器本地时间判定；跨午夜用 start > end 表示（如 23:00–07:00）
  quietHours: { enabled: false, start: '23:00', end: '07:00', breakForSevere: true },
  // 界面语言。**必须留在末尾**：Host schema 的字段顺序要与此一致——"Host 默认值与 Client DEFAULT_CFG 完全一致"的断言是 JSON.stringify 全量比较，顺序不同就会红。
  language: 'zh-CN',
};

// ============================================================================
// dsh-quake-alert · client/src/02-storage.js
// 浏览器侧存储层：localStorage 读写、类型守卫（isPlainObject / numOr / boolOr / timeOr）、
// 配置规整 normalizeCfg、loadCfg / saveCfg、历史记录规整。
// 依赖 01-constants、00-i18n。读到的内容一律做类型校验，任何异常退回默认值。
// ============================================================================


// ---------- 存储（localStorage） ----------
const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
/** 历史条目是否还在「过去 5 天」里。判据是记录的**写入时刻**（`at`），不是电文的发布时刻
 *（占位的是已经躺在列表里的记录，计时从落笔开始）；老记录没有 `at` 时退回按 `issued` 判一次，
 *  两者都认不出时**保留**（不因为缺字段删用户的数据）。 */
function withinHistoryAge(e, now) {
  // `at > 0` 才算"有写入时刻"：规整时会给老条目补 `at: 0`（表示不知道），那一支要退回 issued
  const written = (e && typeof e.at === 'number' && Number.isFinite(e.at) && e.at > 0) ? e.at : NaN;
  if (Number.isFinite(written)) return (now - written) <= HISTORY_MAX_AGE_MS
  const issued = Date.parse(String((e && e.issued) || ''));
  if (Number.isFinite(issued)) return (now - issued) <= HISTORY_MAX_AGE_MS
  return true
}
/** 数值规整：夹取到 [min,max]，类型不符时回退 fallback。**数字字符串也当数值**（`"100"` → 100）， 否则把数字写成字符串的配置会让 `radiusKm: "100"` 静默退回兜底的 300 km，反而放大半径。 */
function numOr(v, fallback, min, max) {
  let n = v;
  if (typeof n === 'string' && n.trim() !== '') n = Number(n);
  if (typeof n !== 'number' || !Number.isFinite(n)) return fallback
  if (typeof min === 'number' && n < min) return min
  if (typeof max === 'number' && n > max) return max
  return n
}
const boolOr = (v, fallback) => (typeof v === 'boolean' ? v : fallback);
// 「HH:MM」时间字符串校验（允许 1 位小时，如 "7:05"）
const TIME_RE = /^([01]?\d|2[0-3]):([0-5]\d)$/;
const timeOr = (v, fallback) => (typeof v === 'string' && TIME_RE.test(v.trim()) ? v.trim() : fallback);
const minutesOfTime = (v) => {
  const m = TIME_RE.exec(String(v === undefined || v === null ? '' : v).trim());
  return m ? Number(m[1]) * 60 + Number(m[2]) : null
};
// 静默时段判定：start > end 表示跨午夜（23:00–07:00），start === end 视为「不静默」。 now 可注入，便于测试覆盖边界而不依赖运行时刻。
function inQuietHours(cfg, now) {
  const q = cfg && cfg.quietHours;
  if (!q || q.enabled !== true) return false
  const start = minutesOfTime(q.start);
  const end = minutesOfTime(q.end);
  if (start === null || end === null || start === end) return false
  const d = now || new Date();
  const cur = d.getHours() * 60 + d.getMinutes();
  return start < end ? (cur >= start && cur < end) : (cur >= start || cur < end)
}

function loadJSON(key, fallback) {
  try {
    const s = window.localStorage.getItem(key);
    if (!s) return fallback
    const v = JSON.parse(s);
    return v === null || v === undefined ? fallback : v
  } catch (err) {
    return fallback
  }
}
function saveJSON(key, value) {
  try { window.localStorage.setItem(key, JSON.stringify(value)); } catch (err) { /* 容量/隐私模式忽略 */ }
}
// 历史记录必须是「对象数组」，且每个字段都必须是渲染层能直接交给 React 的基本类型： 元素为 null 会抛错，字段是对象/数组会让 React 抛「Objects are not valid as a React child」。
const strOr = (v, fallback) => (typeof v === 'string' ? v : (typeof v === 'number' || typeof v === 'boolean' ? String(v) : fallback));
// 历史条目里 `detail` 正文的保留上限。正文是解析层给的官方长文（NWS 的 description + instruction、 ECCC 的正文 + 署名），单条可达数 KB； 历史最多 30 条且写进 localStorage，
// 不截断会撑爆配额， 而超配额时 saveJSON 是**静默失败**的，整份历史会停止写入本地存储。
const HISTORY_DETAIL_MAX = 1200;
function normalizeHistoryEntry(e, i) {
  const key = strOr(e.key, '') || strOr(e.id, '');
  return {
    key: key || 'legacy-' + i, // 早期版本可能没有 key，补一个稳定兜底键，保证 React key 与去重都可用
    id: strOr(e.id, ''),
    // code 是来源标识（'emsc'/'usgs'/'noaa'/'jma'/551…）：只看 kind 会把全球地震 （kind 也是 'quake'）标成「code 551」。旧条目没有它 → 空串，展示层回退到 kind 映射。
    code: strOr(e.code, ''),
    kind: strOr(e.kind, ''),
    label: strOr(e.label, ''),
    severity: strOr(e.severity, ''),
    issued: strOr(e.issued, ''),
    headline: strOr(e.headline, ''),
    detail: strOr(e.detail, '').slice(0, HISTORY_DETAIL_MAX),
    pref: strOr(e.pref, ''),
    hit: e.hit === true,
    suppressed: e.suppressed === true,
    suppressedReason: strOr(e.suppressedReason, ''),
    // 写入时刻：历史保留的「过去 5 天」以它为准（见 withinHistoryAge）；老条目 → 0 表示不知道
    at: (typeof e.at === 'number' && Number.isFinite(e.at)) ? e.at : 0,
  }
}
function loadHistory(nowMs) {
  const v = loadJSON(HISTORY_KEY, null);
  if (!Array.isArray(v)) return []
  const now = typeof nowMs === 'number' && Number.isFinite(nowMs) ? nowMs : Date.now();
  return v
    .filter((e) => isPlainObject(e) && withinHistoryAge(e, now))
    .slice(0, HISTORY_MAX)
    .map(normalizeHistoryEntry)
}
// 每次都返回全新对象，避免调用方改动嵌套字段时污染 DEFAULT_CFG；深拷贝派生而不是手抄字段清单， 因为 freshCfg 是 settingsOpsFor 判断「某字段是否等于默认值」的唯一基准（漏抄的字段永不 unset）。
const cloneCfg = (v) => (Array.isArray(v)
  ? v.map(cloneCfg)
  : (isPlainObject(v) ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, cloneCfg(x)])) : v));
const freshCfg = () => cloneCfg(DEFAULT_CFG);
// 全球关注点：[{ name, lat, lon, radiusKm, origin }]。经纬度只接受合法范围——格式不合法的数据里的 NaN 或越界值 会让距离计算得出无意义的结果，表现为"看起来配好了却永远不提醒"。半径夹在 1–2000 km； 按经纬度（三位小数）去重。
/** 关注点的**来源分支**：jp / cn / global，回答"这个点是在哪个国家的分支下加的"。消费者：跨源归并 判断优先源、大陆气象（行政区层级）匹配挑出大陆关注点、诊断快照。老配置没有这个字段，
 *   缺失时按 **名称形状推导**（设置页「中国大陆」级联产出的名字恒为「省·市」，见 04-city-table 的 cnPlaceOf）， 其余为 'global'。 */
const PLACE_ORIGINS = { jp: true, cn: true, global: true };
function placeOriginOf(p, name) {
  const raw = String((p && p.origin) || '');
  if (own(PLACE_ORIGINS, raw)) return raw
  return String(name || '').indexOf('·') > 0 ? 'cn' : 'global'
}
/** @param {{ total?: number, dropped?: number, radiusFixed?: number, citiesDropped?: number }} [audit] 可选的**检查清单**： 本函数的契约是静默丢弃非法条目（
 *   对 localStorage 里的数据是对的），但"导入一份配置"时需要 如实说明少了什么，传了 audit 就记下"总共几条 / 丢了几条 / 几条的半径不是数值"。 */
function normalizePlaces(list, audit) {
  const out = [];
  const seen = new Set();
  for (const p of list) {
    if (audit) audit.total += 1;
    if (!isPlainObject(p)) { if (audit) audit.dropped += 1; continue }
    // 用显式范围判断而不是 numOr：numOr 对越界值是**夹取**，而经纬度越界意味着数据本身是坏的 （例如把半径填进了纬度列），夹到边界会造出一个"看起来合法"的错误关注点。
    const lat = (typeof p.lat === 'number' && Number.isFinite(p.lat) && Math.abs(p.lat) <= 90) ? p.lat : null;
    const lon = (typeof p.lon === 'number' && Number.isFinite(p.lon) && Math.abs(p.lon) <= 180) ? p.lon : null;
    if (lat === null || lon === null) { if (audit) audit.dropped += 1; continue }
    const key = lat.toFixed(3) + ',' + lon.toFixed(3);
    if (seen.has(key)) { if (audit) audit.dropped += 1; continue }
    seen.add(key);
    const name = strOr(p.name, '').slice(0, 30).trim() || (lat.toFixed(2) + ', ' + lon.toFixed(2));
    const origin = placeOriginOf(p, name);
    // 半径"不是数值"（缺失 / null / true / 乱字符串）时 numOr 会退回兜底值；数字字符串是合法的， 所以只在真正回退时记账。
    const radiusOk = (typeof p.radiusKm === 'number' && Number.isFinite(p.radiusKm)) ||
      (typeof p.radiusKm === 'string' && p.radiusKm.trim() !== '' && Number.isFinite(Number(p.radiusKm)));
    if (audit && !radiusOk) audit.radiusFixed += 1;
    const entry = {
      name,
      lat,
      lon,
    // 半径走 01-constants 的统一常量，与设置页渲染档位、Host schema 的 1–2000 保持一致
    radiusKm: numOr(p.radiusKm, LEGACY_PLACE_RADIUS_KM, MIN_PLACE_RADIUS_KM, MAX_PLACE_RADIUS_KM),
      origin,
    };
    // 大陆关注点的省 / 市：显式落在 place 上，matcher 与诊断不再从「省·市」这个名字反推； 老配置只有名字，这里从名字拆一次并固化。
    if (origin === 'cn') {
      let province = strOr(p.province, '').slice(0, 20).trim();
      let city = strOr(p.city, '').slice(0, 20).trim();
      if (!province || !city) {
        const i = name.indexOf('·');
        if (i > 0 && i < name.length - 1) {
          if (!province) province = name.slice(0, i);
          if (!city) city = name.slice(i + 1);
        }
      }
      if (province && city) {
        entry.province = province;
        entry.city = city;
      }
    }
    out.push(entry);
    if (out.length >= MAX_WATCH_PLACES) break
  }
  return out
}
// 数值规整 + **吸附到最近的合法档位**：机器级配置可以被手工改成任意数字（`quakeScale: 42`），而界面
// 下拉里只有固定档位（严格枚举会让脏值注册失败），所以"就近对齐"放在 Client：先夹到 [min,max] 再吸附。
function snapOr(v, fallback, options, min, max) {
  const n = numOr(v, fallback, min, max);
  // 0 在这两个字段上有明确含义（"来者不拒"，匹配层是 `scale >= threshold`），而它不是档位表里的一项 ——按"最近档位"吸附会把它推到 10，等于**收窄**了用户的范围，所以保留它。
  if (n === 0) return 0
  const vals = (Array.isArray(options) ? options : [])
    .map((o) => (o && typeof o === 'object' ? o.v : o))
    .filter((x) => typeof x === 'number' && Number.isFinite(x));
  if (vals.length === 0) return n
  let best = vals[0];
  for (const o of vals) if (Math.abs(o - n) < Math.abs(best - n)) best = o;
  return best
}

/** 关注市区町村列表的规整：只保类型、去重与长度上限（名字是否真实存在由数据表校验）。
 *  @param {object} [audit] 见 normalizePlaces：超出 MAX_WATCH_CITIES 被截断的条数记进 `audit.citiesDropped`。 */
function normalizeCities(list, audit) {
  const out = Array.from(new Set(list.filter((c) => typeof c === 'string' && c.length > 0 && c.length <= 30)));
  if (out.length <= MAX_WATCH_CITIES) return out
  if (audit) audit.citiesDropped += out.length - MAX_WATCH_CITIES;
  return out.slice(0, MAX_WATCH_CITIES)
}
// 逐字段校验 + 回退默认值：任何形状的输入都规整成一份合法配置。audit 见 normalizePlaces， 只有导入路径会传它。
function normalizeCfg(input, audit) {
  // 调用方都保证传对象，但本函数的契约是"任何脏输入都能规整"，不该因为传进 null/undefined 就抛错
  const stored = isPlainObject(input) ? input : {};
  const w = isPlainObject(stored.watch) ? stored.watch : {};
  const d = isPlainObject(stored.disasters) ? stored.disasters : {};
  const t = isPlainObject(stored.thresholds) ? stored.thresholds : {};
  const n = isPlainObject(stored.notify) ? stored.notify : {};
  const de = isPlainObject(stored.dedupe) ? stored.dedupe : {};
  const qh = isPlainObject(stored.quietHours) ? stored.quietHours : {};
  return {
    version: DEFAULT_CFG.version,
    source: stored.source === 'sandbox' ? 'sandbox' : 'prod',
    // 白名单校验：只认 'poll'，其余一律回 'auto'（将来加第三种取值时不会静默错位）
    cnTransport: stored.cnTransport === 'poll' ? 'poll' : 'auto',
    watch: {
      // 只保留 47 县中确实存在的名字，避免格式不合法的数据在设置页渲染出幽灵按钮
      prefectures: Array.isArray(w.prefectures)
        ? Array.from(new Set(w.prefectures.filter((p) => typeof p === 'string' && PREF_SET.has(p))))
        : [],
      // 市区町村：只保证类型、去重与规模（上限与设置页同一常量），名字是否存在由数据表校验
      cities: Array.isArray(w.cities) ? normalizeCities(w.cities, audit) : [],
      // 旧配置没有这个字段 → 统一成空数组
      places: Array.isArray(w.places) ? normalizePlaces(w.places, audit) : [],
    },
    disasters: {
      earthquake: boolOr(d.earthquake, DEFAULT_CFG.disasters.earthquake),
      tsunami: boolOr(d.tsunami, DEFAULT_CFG.disasters.tsunami),
      weather: boolOr(d.weather, DEFAULT_CFG.disasters.weather),
      // 以下三个**必须在这里同步**，漏掉就会被 applyCfg 静默丢弃， 表现是"用户关掉了这类提醒，刷新之后它又自己开了"。
      cnRainstorm: boolOr(d.cnRainstorm, DEFAULT_CFG.disasters.cnRainstorm),
      cnGeology: boolOr(d.cnGeology, DEFAULT_CFG.disasters.cnGeology),
      overseasWeather: boolOr(d.overseasWeather, DEFAULT_CFG.disasters.overseasWeather),
    },
    thresholds: {
      // 夹取之后吸附到界面上的合法档位（手改的 42 → 40），见 snapOr
      quakeScale: snapOr(t.quakeScale, DEFAULT_CFG.thresholds.quakeScale, SCALE_OPTIONS, 0, 70),
      eewScale: snapOr(t.eewScale, DEFAULT_CFG.thresholds.eewScale, SCALE_OPTIONS, 0, 70),
      // 白名单校验，同时避免 'constructor' 之类的原型链键被当成合法等级
      tsunamiGrade: TSUNAMI_OPTIONS.some((o) => o.g === t.tsunamiGrade)
        ? t.tsunamiGrade
        : DEFAULT_CFG.thresholds.tsunamiGrade,
      // 全球源的最低震级：0 是有意义的取值（来者不拒），所以下界是 0。**不吸附档位**——下拉里那些 M3〜M7 只是常用预设，M6.7 这样的自定义门槛是合法且有意义的，吸附会改掉用户的实际门槛。
      globalMagnitude: numOr(t.globalMagnitude, DEFAULT_CFG.thresholds.globalMagnitude, 0, 10),
      // 大陆速报的独立门槛。新增字段**必须在这里同步**，否则 applyCfg 会静默丢弃它。同上，不吸附。
      cnReportMagnitude: numOr(t.cnReportMagnitude, DEFAULT_CFG.thresholds.cnReportMagnitude, 0, 10),
    },
    notify: {
      sound: boolOr(n.sound, DEFAULT_CFG.notify.sound),
      system: boolOr(n.system, DEFAULT_CFG.notify.system),
      volume: numOr(n.volume, DEFAULT_CFG.notify.volume, 0, 1),
      // 分灾害音效开关：**必须在这里同步**，否则 applyCfg 会静默丢弃它们
      soundQuake: boolOr(n.soundQuake, DEFAULT_CFG.notify.soundQuake),
      soundTsunami: boolOr(n.soundTsunami, DEFAULT_CFG.notify.soundTsunami),
      soundWeather: boolOr(n.soundWeather, DEFAULT_CFG.notify.soundWeather),
    },
    dedupe: {
      windowMinutes: numOr(de.windowMinutes, DEFAULT_CFG.dedupe.windowMinutes, 1, 1440),
    },
    quietHours: {
      enabled: boolOr(qh.enabled, DEFAULT_CFG.quietHours.enabled),
      start: timeOr(qh.start, DEFAULT_CFG.quietHours.start),
      end: timeOr(qh.end, DEFAULT_CFG.quietHours.end),
      breakForSevere: boolOr(qh.breakForSevere, DEFAULT_CFG.quietHours.breakForSevere),
    },
    // 界面语言：走 BCP 47 惯例的逐级回退（精确匹配 → 中文按脚本 / 地区分流 → 其它主语言 → 默认语言）；认不出的一律落到默认语言，手改进来的无语言包代码不会把界面带进半本地化状态。
    language: resolveLang(stored.language),
  }
}
function loadCfg() {
  const stored = loadJSON(STORAGE_KEY, null);
  if (!isPlainObject(stored)) {
    const fresh = freshCfg();
    saveJSON(STORAGE_KEY, fresh);
    // 语言要在**任何界面文本被取用之前**生效：配置是启动最早读到的状态，而通知 / 状态条的文案 可能第一帧就渲染，所以设置语言与"读配置"绑在一起。
    setLanguage(fresh.language);
    return fresh
  }
  let cfg;
  try {
    cfg = normalizeCfg(stored);
  } catch (err) {
    // 一条格式不合法的数据绝不能把整个插件拖崩。规整流程会调 i18n 取词，而某些字符串化不了的形状 （`{toString:null, valueOf:null}`，JSON / YAML 都造得出来） 会让 `String(v)` 抛 TypeError；
    // 调用方里有**渲染期**的（设置页 `useState(() => currentCfg())`），抛错 = 整页白屏。
    try { console.warn('[dsh-quake-alert] 配置归一化失败，本次改用默认配置：' + String((err && err.message) || err)); } catch (e) { /* 忽略 */ }
    const fresh = freshCfg();
    saveJSON(STORAGE_KEY, fresh);
    setLanguage(fresh.language);
    return fresh
  }
  // 版本不同（插件升级 / 用户手改）时按当前 schema 统一保留可识别字段，再写回当前版本号； 不能写回默认值——一次版本号变化就会静默丢掉用户选好的关注地区与阈值。
  if (stored.version !== DEFAULT_CFG.version) saveJSON(STORAGE_KEY, cfg);
  setLanguage(cfg.language);
  return cfg
}
function saveCfg(cfg) {
  const next = { ...cfg, version: DEFAULT_CFG.version };
  saveJSON(STORAGE_KEY, next);
  return next
}


// 安全字典查找：外部数据里的 'constructor'/'toString' 等键会命中原型链，例如 AREA_PREF['constructor'] 会返回 Object 构造函数并让 .slice() 抛错。04-city-table / 解析层共用。
const own = (map, key) => (Object.prototype.hasOwnProperty.call(map, key) ? map[key] : undefined);

// ============================================================================
// dsh-quake-alert · client/src/00f-source-labels.js
//
// 作用：源 id ↔ 文案 key 的单一映射（SOURCE_LABEL_KEYS、STATUS_TEXT_KEYS），
//       以及「显示时求值」的两个取词助手 sourceLabelOf / statusTextOf。
// 依赖：00-i18n。
//
// 这两个映射各有一份：13-ui-settings 的源名表 / statusMetaOf 与 07-store 的状态摘要
// 必须给同一个答案，所以都从这里取。
// **取词必须在调用时求值**：`t()` 读的是当前语言，而当前语言由 `loadCfg` / `applyCfg` 设置。
// 模块级写 `const X = t('...')` 会固化成默认语言，用户切语言后它不会变，所以这里导出函数。
// ============================================================================


/** 源 id → 显示名 key。新增源时这里加一项（13 的 SOURCE_ORDER 是排列顺序，另一件事）。 */
const SOURCE_LABEL_KEYS = {
  p2pquake: 'settings.sourceLabels.p2pquake',
  emsc: 'settings.sourceLabels.emsc',
  cenc_eew: 'settings.sourceLabels.cencEew',
  cenc_eqlist: 'settings.sourceLabels.cencEqlist',
  jma: 'settings.sourceLabels.jma',
  usgs: 'settings.sourceLabels.usgs',
  noaa: 'settings.sourceLabels.noaa',
  nmc_alarm: 'settings.sourceLabels.nmc',
  nws_alerts: 'settings.sourceLabels.nws',
  eccc_alerts: 'settings.sourceLabels.eccc',
};

/** 连接状态码 → 文案 key（与 13 的 `statusMetaOf` 用同一批 key）。 */
const STATUS_TEXT_KEYS = {
  idle: 'settings.status.idle',
  connecting: 'settings.status.connecting',
  open: 'settings.status.open',
  reconnecting: 'settings.status.reconnecting',
  closed: 'settings.status.closed',
  unreachable: 'settings.status.unreachable',
  degraded: 'settings.status.degraded',
  stale: 'settings.status.stale',
  'schema-error': 'settings.status.schemaError',
  disabled: 'settings.status.disabled',
};

/** 源 id → 当前语言下的显示名。认不出的 id 原样返回（宁可显示 id，也不要显示空白）。 */
function sourceLabelOf(id) {
  const raw = String(id === undefined || id === null ? '' : id);
  // hasOwnProperty：直接取 `SOURCE_LABEL_KEYS['constructor']` 会命中原型链（同 00-i18n 的 t）
  const key = Object.prototype.hasOwnProperty.call(SOURCE_LABEL_KEYS, raw) ? SOURCE_LABEL_KEYS[raw] : '';
  return key ? t(key) : raw
}

/** 状态码 → 当前语言下的文字。`retries` 只被 reconnecting 用到。 */
function statusTextOf(status, retries) {
  const code = String(status === undefined || status === null ? '' : status);
  const key = Object.prototype.hasOwnProperty.call(STATUS_TEXT_KEYS, code) ? STATUS_TEXT_KEYS[code] : '';
  if (!key) return t('settings.status.raw', { status: code })
  if (code === 'reconnecting') return t(key, { n: typeof retries === 'number' && Number.isFinite(retries) ? retries : 0 })
  return t(key)
}

// ============================================================================
// dsh-quake-alert · client/src/07-store.js
// 全局 store：连接状态 + 最近预警，供设置页与状态指示订阅。含 store 对象与 addEvent。
// store.push({}) 是各 UI 的重渲染信号，改变它会影响所有订阅方。
// ============================================================================


const store = {
  status: 'idle', // idle | connecting | open | reconnecting | closed（多源聚合结果）
  retries: 0,
  detail: '',
  sources: {}, // { [id]: { label, status, retries, detail } }
  received: 0, // 收到并成功解析的推送条数（诊断用）
  events: loadHistory(), // 最近预警 [{kind,label,severity,issued,headline,pref}]
  weatherHint: null, // 气象警报的「静默提示」（L3 命中关注地区时只记一笔）：{ level, area, pref, at } | null
  listeners: new Set(),
  push(patch) {
    Object.assign(this, patch);
    this.listeners.forEach((fn) => fn());
  },
  /** 某个连接源汇报自己的状态；主状态由 recomputeStatus 聚合得出。 */
  pushSource(id, patch) {
    const cur = this.sources[id] || { label: id, status: 'idle', retries: 0, detail: '' };
    this.sources[id] = Object.assign({}, cur, patch);
    this.recomputeStatus();
    this.push({});
  },
  /** 插件停用 / 重建时把源清空，避免残留的旧状态把新会话显示成"已连接"。 */
  clearSources() {
    this.sources = {};
    this.received = 0; // 推送计数也归零：否则重载后徽标会带着上一代的数字继续涨
    this.recomputeStatus();
    this.push({});
  },
  recomputeStatus() {
    // 源名要按语言现取（`sourceLabelOf(id)`），不能沿用 `sources[id].label`——那是建连那一刻的语言
    const ids = Object.keys(this.sources);
    if (ids.length === 0) {
      this.status = 'idle'; this.retries = 0; this.detail = '';
      return
    }
    const activeIds = ids.filter((id) => this.sources[id].status !== 'disabled');
    if (activeIds.length === 0) {
      this.status = 'disabled'; this.retries = 0;
      this.detail = ids.map((id) => t('status.sourceDisabled', { name: sourceLabelOf(id) })).join(' · ');
      return
    }
    const pick = (s) => activeIds.filter((id) => this.sources[id].status === s)[0];
    // 主状态优先级：红（停了 / 不可达）→ 蓝（数据格式异常）→ 黄（连接中 / 重连 / 降级）→ 灰（过期）→ 绿
    const chosenId = pick('closed') || pick('unreachable') || pick('schema-error') ||
      pick('reconnecting') || pick('connecting') || pick('degraded') || pick('stale') ||
      pick('open') || activeIds[0];
    const chosen = this.sources[chosenId];
    this.status = chosen.status;
    this.retries = typeof chosen.retries === 'number' ? chosen.retries : 0;
    // 没有具体原因时退回**状态文字**，裸状态码是给开发看的
    const badIds = activeIds.filter((id) => this.sources[id].status !== 'open');
    this.detail = (badIds.length ? badIds : activeIds)
      .map((id) => {
        const s = this.sources[id];
        return t('status.sourceDetail', {
          name: sourceLabelOf(id),
          detail: s.detail || statusTextOf(s.status, s.retries),
        })
      }).join(' · ');
  },
  subscribe(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn) },
};
let anonSeq = 0; // 无 id 消息用递增匿名 key，避免空 id 互相覆盖
function addEvent(ev) {
  const hasId = ev && ev.id && ev.id !== '';
  const key = hasId ? ev.id : ('anon-' + (++anonSeq));
  // 写入时刻：历史保留的「过去 5 天」以它为准（见 withinHistoryAge）；有限值可注入以便测试
  const now = (ev && typeof ev.at === 'number' && Number.isFinite(ev.at) && ev.at > 0) ? ev.at : Date.now();
  const item = normalizeHistoryEntry(Object.assign({}, ev, { key, at: now }), 0);
  // 条数与**时间**两个上限同时生效
  const fresh = store.events.filter((e) => withinHistoryAge(e, now));
  store.events = [item].concat(fresh.filter((e) => e.key !== key)).slice(0, HISTORY_MAX);
  saveJSON(HISTORY_KEY, store.events.slice(0, HISTORY_MAX));
  store.push({});
}

// ============================================================================
// dsh-quake-alert · client/src/03-settings-bridge.js
// 机器级持久化桥：把配置交给 DSH Host settings（settings.yaml），localStorage 作回退与镜像。
// 含 currentCfg / applyCfg / settingsOpsFor / pushCfgToHost / bindSettingsScope / reloadFromLocal。
// 没有 settings 服务 / 页面非 loopback / Host 不持久化时，整条链路退化为纯 localStorage。
// ============================================================================


// ---------- 机器级持久化：Host 存储为主，localStorage 为回退与镜像 ----------
// 本模块只认一个**形状**（两代宿主都提供它），不关心它来自哪个服务：DSH 0.1.6 及以前是
// `ctx.settingsScope.bind({ namespace })` 返回的 scope，0.1.7 起是 `ctx.configForms.get('quake-alert')`
// 返回的 ConfigForm。两边同名同义：`getSnapshot()` / `subscribe(fn)` / `mutate(ops)`，快照字段
// `status / value / user / writable / mode` 一一对应。分派在 15-entry.js。scope 快照是**同步**可读的，
// 所以内部读取（重连、handleRaw）仍然同步；写入先更新内存与 localStorage 镜像，再异步推给 Host。
const SETTINGS_NS = 'quake-alert';
/** 「本地配置已迁移到 Host」写在本地的标记：迁移只能发生一次，见 bindSettingsScope。 */
const MIGRATED_KEY = 'dsh.quakeAlert.hostMigrated';
let runtimeCfg = null; // 内存中的当前配置
let settingsScope = null; // bind 成功后的 scope handle
let settingsSync = 'local'; // local（无 Host）| host（写入 settings.yaml）| memory（Host 不持久化）

// Host section ⇄ 本地配置：version 是本地存储的结构版本概念，不属于 Host schema
function cfgToSection(cfg) {
  const out = {};
  for (const key of Object.keys(cfg)) if (key !== 'version') out[key] = cfg[key];
  return out
}
function sectionToCfg(section) {
  try {
    return normalizeCfg(Object.assign({ version: DEFAULT_CFG.version }, isPlainObject(section) ? section : {}))
  } catch (err) {
    // 与 loadCfg 同理：Host 下发的 section 也是外部输入（settings.yaml / profile 都能手写），
    // 规整的过程抛错不该让调用方的渲染期炸掉。
    try { console.warn('[dsh-quake-alert] Host section 归一化失败，本次改用默认配置：' + String((err && err.message) || err)); } catch (e) { /* 忽略 */ }
    return freshCfg()
  }
}
// 同步读取入口：调用方无需感知 Host 的存在
function currentCfg() {
  if (runtimeCfg === null) runtimeCfg = loadCfg();
  return runtimeCfg
}
// 本地镜像被**其它 DSH 标签页**改写后（storage 事件），把 localStorage 重新读回内存副本。
// 跨模块不能直接给本模块私有的 runtimeCfg 赋值（打包进 'use strict' 的 bundle 会抛 ReferenceError）。
/** 语言变化后，**由语言派生出来的文本**要重算，并让订阅者重渲染：`store.detail` 是 `recomputeStatus` 拼好的字符串（源名 + 状态文字），而状态点只订阅 store，不通知就不会重渲染。 */
function syncDerivedTextAfterLanguageChange() {
  try {
    store.recomputeStatus();
    store.push({});
  } catch (err) {
    // store 不可用（单测里很常见）时忽略：语言本身已经生效，这里只是让派生文本跟上。
  }
}
function reloadFromLocal() {
  const prevLang = getLanguage();
  runtimeCfg = loadCfg();
  if (getLanguage() !== prevLang) syncDerivedTextAfterLanguageChange();
  return runtimeCfg
}
// 写入入口：内存立即生效 → localStorage 镜像 → Host（可用时异步持久化）
function applyCfg(cfg) {
  const prevLang = getLanguage();
  // 写入路径也要规整，否则「坐标相同的关注点自动合并」「name 截断到 30 字」这类不变量在内存与 localStorage 里都不成立——同一次会话里重复添加同一个点会真的存两份。
  runtimeCfg = saveCfg(normalizeCfg(cfg));
  // 语言在**写入路径**也要生效：设置页切换语言走的就是这里，语言不在此刻落到 i18n 的当前值， 界面会等下一次配置加载才切换。
  setLanguage(runtimeCfg.language);
  if (getLanguage() !== prevLang) syncDerivedTextAfterLanguageChange();
  pushCfgToHost(runtimeCfg);
  return runtimeCfg
}
// 只提交与默认值不同的字段；等于默认值的字段用 unset 交还 schema 默认层， 这样 settings.yaml 里只留下用户真正改过的东西。
function settingsOpsFor(cfg) {
  const cur = cfgToSection(cfg);
  const def = cfgToSection(freshCfg());
  const ops = [];
  const walk = (node, base, path) => {
    for (const key of Object.keys(node)) {
      const p = path.concat(key);
      const cv = node[key];
      const bv = base[key];
      if (isPlainObject(cv) && isPlainObject(bv)) { walk(cv, bv, p); continue }
      if (JSON.stringify(cv) === JSON.stringify(bv)) ops.push({ op: 'unset', path: p });
      else ops.push({ op: 'set', path: p, value: cv });
    }
  };
  walk(cur, def, []);
  return ops
}
/** 把配置推给 Host。返回 `scope.mutate()` 的 pending（没有真正发出写请求时返回 null）， 调用方据此判断"Host 是否确认接收"——迁移标记要靠它，见 bindSettingsScope。 */
function pushCfgToHost(cfg) {
  const scope = settingsScope;
  if (!scope || settingsSync !== 'host') return null
  try {
    const snap = scope.getSnapshot();
    if (!snap || snap.status !== 'ready' || snap.writable !== true || snap.mode !== 'host') return null
    const ops = settingsOpsFor(cfg);
    if (ops.length === 0) return null
    const pending = scope.mutate(ops);
    if (pending && typeof pending.catch === 'function') pending.catch(() => { /* 写失败不回滚本地 */ });
    return (pending && typeof pending.then === 'function') ? pending : null
  } catch (err) { return null }
}
// 绑定 Host settings。三种来源的优先关系：① Host 用户层已有内容 → 以 Host 为准（机器级配置是 source of truth）；② Host 为空、本地已有非默认配置 → 一次性迁移到 Host；
// ③ Host 不可用 → 保持 localStorage。
/** 迁移的尝试上限。Host 持续拒绝写入时（revision 冲突等）不设上限会变成"每来一次 sync 就写一次" 的循环；用尽之后保留本地镜像，用户下一次改配置时经 applyCfg 直接写进 Host。 */
const MIGRATE_MAX_ATTEMPTS = 3;

function bindSettingsScope(scope) {
  settingsScope = scope;
  let migrateAttempts = 0;
  const sync = () => {
    let snap = null;
    try { snap = scope.getSnapshot(); } catch (err) { return }
    if (!snap || snap.status !== 'ready' || snap.value === undefined) { settingsSync = 'local'; store.push({}); return }
    if (snap.mode !== 'host' || snap.writable !== true) { settingsSync = 'memory'; store.push({}); return }
    settingsSync = 'host';
    const user = isPlainObject(snap.user) ? snap.user : {};
    const claimed = loadJSON(MIGRATED_KEY, null) === 1;
    if (Object.keys(user).length === 0 && !claimed) {
      // 迁移**只能发生一次**，而且这个"一次"必须写入本地存储：只在本次 bind 里记局部标志的话，每次重载 页面都会重新判断，"用户显式清空 Host"会被本地镜像静默恢复。
      const local = loadCfg();
      if (JSON.stringify(cfgToSection(local)) !== JSON.stringify(cfgToSection(freshCfg()))) {
        if (migrateAttempts >= MIGRATE_MAX_ATTEMPTS) {
          // 重试用尽：**不落标记、也不用 Host 的空值覆盖本地镜像**（那等于丢掉用户配置）， 用户下一次改配置会经 applyCfg 直接写进 Host。
          store.push({});
          return
        }
        migrateAttempts += 1;
        runtimeCfg = saveCfg(local);
        const pending = pushCfgToHost(runtimeCfg);
        // **等 Host 真的接收之后再落"已完成迁移"标记**：先落标记再写的话，写入失败会让本地配置既没进
        // Host、又因为标记而不再重试，随后被 Host 的空值覆盖；也不能把 `pending` 的 resolve 当成功
        //（平台的 mutate 在 Host 拒绝时也是 resolve），所以 settle 之后回读一次才算完成。
        if (pending) {
          pending.then(() => {
            let landed = false;
            try {
              const after = scope.getSnapshot();
              landed = !!(after && after.status === 'ready' && isPlainObject(after.user) && Object.keys(after.user).length > 0);
            } catch (err) { landed = false; }
            if (!landed) return
            try { saveJSON(MIGRATED_KEY, 1); } catch (err) { /* 忽略 */ }
          }).catch(() => { /* 写失败：不落标记，下次重试 */ });
        }
        store.push({});
        return
      }
      // 本地就是默认值：Host 为空与本地等价，直接标记为已处理
      saveJSON(MIGRATED_KEY, 1);
    } else if (!claimed) {
      // **这个标记也要在这一条路径上写**：只在上一条分支里写的话，"首次 bind 时 Host 已非空" （第二个浏览器 / 手写过 settings.yaml）就永远不落标记，此后 Host 一旦变空，
      // 本浏览器会把 **过期**的本地镜像重新迁回 Host，静默复活旧配置。
      saveJSON(MIGRATED_KEY, 1);
    }
    const next = sectionToCfg(snap.value);
    runtimeCfg = saveCfg(next); // localStorage 保持为镜像：Host 掉线时仍能工作
    // **语言也必须在这条路径上落地**：Host 是优先源而 `loadCfg` 读的是 localStorage 镜像，这条路径上 runtimeCfg 已是 Host 的值，界面却仍停在启动时的语言，且不会自愈（sync 是"值没变就不重算"的幂等路径）。
    if (getLanguage() !== runtimeCfg.language) {
      setLanguage(runtimeCfg.language);
      syncDerivedTextAfterLanguageChange();
    }
    store.push({});
  };
  let disposer = null;
  try { disposer = scope.subscribe(sync); } catch (err) { /* 订阅失败只是失去实时同步 */ }
  sync();
  // 返回解除函数：调用方要把它注册进 ctx.effect，否则同一页面内停用 → 启用 N 次会累积 N 个订阅。
  return () => {
    try { if (typeof disposer === 'function') disposer(); } catch (err) { /* 忽略 */ }
    if (settingsScope === scope) settingsScope = null;
  }
}


const settingsState = () => ({ sync: settingsSync, bound: settingsScope !== null, runtime: runtimeCfg });
const resetSettings = () => { runtimeCfg = null; settingsScope = null; settingsSync = 'local'; };

// ============================================================================
// dsh-quake-alert · client/src/04-city-table.js
// 市区町村表与「观测点 addr → 市町村」的对应：表的注入与规整、假名写法对齐、规范写法反查、拉表与查询。
// 要点：気象庁/P2PQuake 的观测点名用短名与消歧写法，必须先统一到市町村全称再比对；假名写法不
// 同时一律经 normKana 比对与反查，显示仍用本表写法。
// ============================================================================


// ---------- 市区町村表：Host 路由提供，Client 拉一次并缓存 ----------
// /dsh-quake-alert/areas 返回 { prefectures: {...} }（全国 1700+ 条，不内联进 bundle）。
const AREAS_PATH = '/dsh-quake-alert/areas';
let cityTable = null;
let cityTableState = 'idle'; // idle | loading | ready | failed
let cityNameSet = null; // 全部市町村名（校验配置用）
let cityPrefIndex = null; // Map<统一后的市町村名, { name: 规范写法, prefs: 都道府県[] }>：JMA 电文只给市町村名，要反查所属县
let riverAreas = null; // Map<河川予報区域コード, { name, cities }>：指定河川洪水予報用

// ---------- 地名假名写法对齐 ----------
// 不同数据源对同一市町村的写法不一致（金け崎町 ↔ 金ケ崎町、南あるぷす市 ↔ 南アルプス市）。
// 对齐步骤：先「平假名 → 片假名」，再把「ケ → ヶ」——两步都要。结果只用于比较与反查。
const KANA_HIRA_MIN = 0x3041;
const KANA_HIRA_MAX = 0x3096;
const KANA_KE_RE = /\u30b1/g;
function normKana(input) {
  const s = String(input === undefined || input === null ? '' : input);
  let out = '';
  for (const ch of s) {
    const c = ch.codePointAt(0);
    out += (c >= KANA_HIRA_MIN && c <= KANA_HIRA_MAX) ? String.fromCodePoint(c + 0x60) : ch;
  }
  return out.replace(KANA_KE_RE, '\u30f6')
}

function setCityTable(table) {
  if (!isPlainObject(table)) return false
  const clean = {};
  const names = new Set();
  for (const pref of Object.keys(table)) {
    if (!PREF_SET.has(pref)) continue
    const list = table[pref];
    if (!Array.isArray(list)) continue
    const uniq = Array.from(new Set(list.filter((c) => typeof c === 'string' && c.length > 0 && c.length <= 30)));
    if (uniq.length === 0) continue
    clean[pref] = uniq;
    for (const c of uniq) names.add(c);
  }
  if (Object.keys(clean).length === 0) return false
  cityTable = clean;
  cityNameSet = names;
  // 索引键走假名写法对齐：外部写法（河川区域表 / JMA 电文）与本表写法不同时也要能查到
  cityPrefIndex = new Map();
  for (const pref of Object.keys(clean)) {
    for (const c of clean[pref]) {
      const key = normKana(c);
      const hit = cityPrefIndex.get(key);
      if (hit) { if (hit.prefs.indexOf(pref) === -1) hit.prefs.push(pref); }
      else cityPrefIndex.set(key, { name: c, prefs: [pref] });
    }
  }
  buildAddrIndex();
  cityTableState = 'ready';
  return true
}
const citiesOfPref = (pref) => (cityTable && own(cityTable, pref)) || [];
/** 市町村名 → 所属都道府県（写法差异已对齐；重名时返回多个；表未加载或未收录时返回空数组）。 */
const prefsOfCity = (name) => {
  if (!cityPrefIndex) return []
  const hit = cityPrefIndex.get(normKana(name));
  return hit ? hit.prefs.slice() : []
};
/** 市町村名 → 本表里的规范写法（表未加载或未收录时返回空字符串）。JMA 电文、河川区域表给的是
 *  外部写法，直接与用户勾选名比对会漏报，所以比对前先取规范名。 */
const canonicalCityOf = (name) => {
  if (!cityPrefIndex) return ''
  const hit = cityPrefIndex.get(normKana(name));
  return hit ? hit.name : ''
};

/** 河川予報区域表（scripts/build-areas.mjs 生成，Host 随 /areas 下发）。指定河川洪水予報的电文
 *  区域是河川名（「天塩川」），必须先映射到市町村才能与用户关注比对。 */
function setRiverAreas(list) {
  if (!Array.isArray(list)) return false
  const idx = new Map();
  for (const a of list) {
    if (!a || typeof a.code !== 'string' || !Array.isArray(a.cities)) continue
    idx.set(a.code, { name: typeof a.name === 'string' ? a.name : '', cities: a.cities.filter((c) => typeof c === 'string' && c) });
  }
  if (idx.size === 0) return false
  riverAreas = idx;
  return true
}
/** 河川予報区域コード → 覆盖的市町村名列表（未收录时返回空数组）。 */
const riverAreaCities = (code) => {
  if (!riverAreas) return []
  const hit = riverAreas.get(String(code || ''));
  return hit ? hit.cities.slice() : []
};

// ---------- 中国行政区划表：Host 随 /areas 一起下发 ----------
// 省 34 + 地级 384 共约 21KB。设置页的三级级联与**关注点坐标填充**都用它（大陆源是坐标 + 半径匹配）。
let cnAreas = null; // [{ code, name, aliases, lat, lon, cities:[{name,aliases,lat,lon}] }]
/** 大陆行政区划表的加载结果：空串 = 还没失败，非空 = 失败原因。设置页据此区分"加载中"与"失败"。 */
let cnAreasFailed = '';
/** 别名的规整：丢掉单字别名（"丽"这类会匹配到半个中国）与和显示名重复的项，上限 8 条（匹配是
 *  **最长命中**，砍掉短名不影响建制全名）。缺失 `aliases` 字段时返回空数组——别名是增强，不是前提。 */
function normAliases(list, name) {
  if (!Array.isArray(list)) return []
  const out = [];
  const seen = new Set();
  for (const a of list) {
    if (typeof a !== 'string') continue
    const s = a.trim();
    if (!s || s === name || s.length < 2 || seen.has(s)) continue
    seen.add(s);
    out.push(s);
    if (out.length >= 8) break
  }
  return out
}
/** 注入并规整行政区划表。**逐字段校验**：表来自 Host 的 JSON，与 localStorage 一样属于不可信输入
 *  ——一个坏条目会让级联渲染出幽灵选项，或把用户带到错误的坐标上。整体规整失败就整体拒绝。 */
function setCnAreas(list) {
  if (!Array.isArray(list)) { cnAreasFailed = '响应里没有 cnAreas'; return false }
  const out = [];
  const seenProv = new Set();
  for (const p of list) {
    if (!isPlainObject(p)) continue
    const name = typeof p.name === 'string' ? p.name.trim() : '';
    if (!name || seenProv.has(name)) continue
    if (!validLatLon(p.lat, p.lon)) continue
    const cities = [];
    const seenCity = new Set();
    for (const c of (Array.isArray(p.cities) ? p.cities : [])) {
      if (!isPlainObject(c)) continue
      const cn2 = typeof c.name === 'string' ? c.name.trim() : '';
      if (!cn2 || seenCity.has(cn2)) continue
      if (!validLatLon(c.lat, c.lon)) continue
      seenCity.add(cn2);
      cities.push({ name: cn2, aliases: normAliases(c.aliases, cn2), lat: c.lat, lon: c.lon });
    }
    // 没有下级的省级项在级联里是死路：直接丢弃
    if (cities.length === 0) continue
    seenProv.add(name);
    out.push({ code: typeof p.code === 'string' ? p.code : '', name, aliases: normAliases(p.aliases, name), lat: p.lat, lon: p.lon, cities });
  }
  if (out.length === 0) { cnAreasFailed = 'cnAreas 里没有可用的省份'; return false }
  cnAreas = out;
  cnAreasFailed = '';
  return true
}
function validLatLon(lat, lon) {
  return typeof lat === 'number' && Number.isFinite(lat) && Math.abs(lat) <= 90 &&
    typeof lon === 'number' && Number.isFinite(lon) && Math.abs(lon) <= 180
}
/** 省级列表（表未加载时返回空数组）。 */
const cnProvinces = () => (cnAreas ? cnAreas.slice() : []);
/** 某个省下的地级市列表（未收录时返回空数组）。 */
const cnCitiesOf = (province) => {
  if (!cnAreas) return []
  const hit = cnAreas.find((p) => p.name === province);
  return hit ? hit.cities.slice() : []
};
/** 「省 + 市 + 半径」→ 一个关注点（表里查不到时返回 null）。名称取「省·市」以免两个省的"城区"撞名；
 *  `origin: 'cn'` 是**来源分支**，只做标注、**不限制匹配范围**：坐标点对所有坐标型源依然有效。 */
function cnPlaceOf(province, city, radiusKm) {
  if (!cnAreas) return null
  const p = cnAreas.find((x) => x.name === province);
  if (!p) return null
  const c = p.cities.find((x) => x.name === city);
  if (!c) return null
  const r = Number(radiusKm);
  if (!Number.isFinite(r) || r < 1 || r > 2000) return null
  // province / city 显式落在关注点上，matcher 不再从「省·市」这个名字反推；名字是给人看的标签
  return { name: province + '·' + city, lat: c.lat, lon: c.lon, radiusKm: r, origin: 'cn', province, city }
}

// ---------- 全球主要城市表：按国家分包，展开某国时才拉 ----------
// 整表 5224 条城市约 375KB 源码。Host 按 `?country=XX` **分包下发**，这里按需拉取并缓存。
let worldCountries = null; // [{ code, count, names: { 'zh-CN', 'zh-TW', ja, en } }]
const worldCityPacks = new Map(); // code -> { state: 'loading'|'ready'|'failed', cities, error }
/** 界面语言清单（与 00-i18n 的 LANGS 同一批）：国家名的四条名字就按这个顺序兜底。 */
const COUNTRY_NAME_LANGS = ['zh-CN', 'zh-TW', 'ja', 'en'];
/** 国家名的本地化四条：取词时按当前语言解析，认不出该语言时逐级退回（zh-CN → en → code），
 *  最坏情况显示 ISO 码而不是空白。 */
function setWorldCountries(list) {
  if (!Array.isArray(list)) return false
  const out = [];
  const seen = new Set();
  for (const c of list) {
    if (!isPlainObject(c)) continue
    const code = typeof c.code === 'string' ? c.code.trim().toUpperCase() : '';
    if (!code || seen.has(code)) continue
    const names = {};
    let any = false;
    for (const lang of COUNTRY_NAME_LANGS) {
      const v = isPlainObject(c.names) ? c.names[lang] : undefined;
      if (typeof v === 'string' && v.trim()) { names[lang] = v.trim(); any = true; }
    }
    // 旧 Host（或别处塞进来的）只给 `name`：当作默认语言那一份，照常可用
    if (!any && typeof c.name === 'string' && c.name.trim()) { names['zh-CN'] = c.name.trim(); any = true; }
    if (!any) continue
    seen.add(code);
    out.push({ code, names, count: Number(c.count) || 0 });
  }
  if (out.length === 0) return false
  worldCountries = out;
  return true
}
/** 取某个国家在当前语言下的名字（认不出就逐级退回，最后退回 ISO 码）。 */
function countryNameOf(entry, lang) {
  if (!entry || !isPlainObject(entry.names)) return ''
  const want = String(lang || '');
  return entry.names[want] || entry.names['zh-CN'] || entry.names.en || entry.code || ''
}
const worldCountriesOf = () => (worldCountries ? worldCountries.map((c) => Object.assign({}, c)) : []);
const countryPackOf = (code) => worldCityPacks.get(String(code === undefined || code === null ? '' : code).trim().toUpperCase()) || null;
/** 拉某个国家的城市包。同一国家的并发调用共用同一条在途请求（Map 里先落 `loading`）。三种失败要能
 *  分开说，因为出路不同：`failed`（拉不到 → 重试）、`error: 'not-covered'`（Host 答 404：这个国家不在
 *  表里 → 用手填坐标）、以及正常但为空。 */
async function loadCountryCities(code) {
  const cc = String(code === undefined || code === null ? '' : code).trim().toUpperCase();
  if (!cc) return null
  const cur = worldCityPacks.get(cc);
  if (cur && (cur.state === 'ready' || cur.state === 'loading')) return cur
  worldCityPacks.set(cc, { state: 'loading', cities: [], error: '' });
  store.push({});
  try {
    if (typeof window === 'undefined' || typeof window.fetch !== 'function') throw new Error('当前环境不支持 fetch')
    const res = await window.fetch(AREAS_PATH + '?country=' + encodeURIComponent(cc), { headers: { accept: 'application/json' } });
    if (res && res.status === 404) {
      worldCityPacks.set(cc, { state: 'ready', cities: [], error: 'not-covered' });
      store.push({});
      return worldCityPacks.get(cc)
    }
    if (!res || !res.ok) throw new Error('HTTP ' + (res ? res.status : '?'))
    const data = await res.json();
    const cities = (Array.isArray(data && data.cities) ? data.cities : [])
      .filter((c) => isPlainObject(c) && typeof c.name === 'string' && validLatLon(c.lat, c.lon))
      .map((c) => ({ name: c.name, admin: typeof c.admin === 'string' ? c.admin : '', lat: c.lat, lon: c.lon }));
    worldCityPacks.set(cc, { state: 'ready', cities, error: '' });
  } catch (err) {
    worldCityPacks.set(cc, { state: 'failed', cities: [], error: String((err && err.message) || err) });
  }
  store.push({});
  return worldCityPacks.get(cc)
}
/** 测试钩子：清掉国家清单与已缓存的包。 */
function resetWorldCities() {
  worldCountries = null;
  worldCityPacks.clear();
}

/** 发布机构名 → 行政区归属（大陆气象源用）：输入气象台的机构名（`气象台` 后缀去没去掉都可以），
 *  输出 `{ province, city, matched }`。三条规则：① **省名必须出现在机构名的开头**并取最长命中——
 *  不能全局搜索，省别名里有「海南」，而青海省的机构名是「青海省海南藏族自治州共和县气象台」，
 *  全局搜会把一条青海的预警归到海南省；② 市级在**省名之后的那一段**里找最长命中，用 `aliases`
 *  而不是只认显示名（显示名会挑到旧名，「毕节地区」对应气象台的「毕节市」）；③ 市级找不到时，
 *  若该省下**只有一个可选条目**（直辖市 / 港澳）就用它，否则返回 `city: ''` 由调用方走省级兜底。
 *  @returns {{ province: string, city: string, matched: boolean }|null} 表未加载时返回 null */
function cnAreaOf(org) {
  if (!cnAreas || cnAreas.length === 0) return null
  const s = String(org === undefined || org === null ? '' : org).trim();
  if (!s) return { province: '', city: '', matched: false }
  let prov = null;
  let plen = 0;
  for (const p of cnAreas) {
    for (const n of [p.name].concat(p.aliases || [])) {
      if (n.length > plen && s.startsWith(n)) { prov = p; plen = n.length; }
    }
  }
  if (!prov) return { province: '', city: '', matched: false }
  const rest = s.slice(plen);
  let city = null;
  let clen = 0;
  for (const c of prov.cities) {
    for (const n of [c.name].concat(c.aliases || [])) {
      if (n.length > clen && rest.indexOf(n) !== -1) { city = c; clen = n.length; }
    }
  }
  if (!city && prov.cities.length === 1) city = prov.cities[0];
  return { province: prov.name, city: city ? city.name : '', matched: true }
}

// ---------- addr → 市町村对应 ----------
// 551 的 points[].addr 与市町村全称有一批写法差异（政令市短名、重名消歧前缀、北海道支庁名、仮名表记），
// 匹配前先统一到所属市町村全称；认不出的返回 null，调用方据此放行。
const HOKKAIDO_BRANCHES = [
  '石狩', '後志', '空知', '渡島', '檜山', '胆振', '日高', '上川', '留萌', '宗谷',
  '網走', '北見', '紋別', '十勝', '釧路', '根室',
];
function cityAliases(city, pref) {
  const out = [city];
  const m = /^(.+市)(.+区)$/.exec(city);
  if (m) out.push(m[1].slice(0, -1) + m[2]);
  else if (/区$/.test(city)) out.push('東京' + city);
  if (pref) {
    // 只削 県 / 都 / 府：「北海道」削出来是「北海」，会给北海道的每个市町村造一条幻影别名
    const short = String(pref).replace(/[都府県]$/, '');
    if (short && short !== pref) out.push(short + city);
  }
  if (pref === '北海道') {
    for (const b of HOKKAIDO_BRANCHES) { out.push(b + city); out.push(b + '地方' + city); }
  }
  return out
}
let addrAliasIndex = null; // Map<统一后的别名, 市町村全称>
let addrAliasMax = 0;
function buildAddrIndex() {
  const idx = new Map();
  let max = 0;
  if (cityTable) {
    for (const pref of Object.keys(cityTable)) {
      for (const city of cityTable[pref]) {
        for (const alias of cityAliases(city, pref)) {
          const a = normKana(alias);
          if (!idx.has(a)) idx.set(a, city);
          if (a.length > max) max = a.length;
        }
      }
    }
  }
  addrAliasIndex = idx;
  addrAliasMax = max;
}
// addr → 市町村全称（最长前缀命中）；认不出返回 null
function lookupAddrCity(area) {
  if (!addrAliasIndex || addrAliasIndex.size === 0) return null
  const a = normKana(area);
  for (let len = Math.min(addrAliasMax, a.length); len >= 2; len--) {
    const hit = addrAliasIndex.get(a.slice(0, len));
    if (hit) return hit
  }
  return null
}
// 配置里可能残留表里不存在的市町村名（手工改过配置 / 数据表更新）→ 表到位后清掉
function pruneUnknownCities() {
  if (!cityNameSet) return
  const cur = currentCfg();
  const kept = cur.watch.cities.filter((c) => cityNameSet.has(c));
  if (kept.length === cur.watch.cities.length) return
  applyCfg(Object.assign({}, cur, { watch: Object.assign({}, cur.watch, { cities: kept }) }));
}
/** 清掉「所属都道府县已经不在关注列表里」的市町村。设置页取消关注某个县时的清理**依赖市町村表**
 *（表未就绪时 `citiesOfPref` 返回空数组，清理会悄悄失灵）；县归不出来且整条消息没有任何区域能归到县
 *  时会落到市级比对，残留条目仍可能多报一次，表就绪后补做这一次清理即可消除。两个保守边界：
 *  **关注列表为空 = 全日本**（不清）；归属认不出的条目保留。 */
function pruneCitiesOfUnwatchedPrefs() {
  if (!cityPrefIndex) return
  const cur = currentCfg();
  const watched = (cur.watch && cur.watch.prefectures) || [];
  if (watched.length === 0) return
  const cities = (cur.watch && cur.watch.cities) || [];
  const kept = cities.filter((c) => {
    const prefs = prefsOfCity(c);
    if (prefs.length === 0) return true
    return prefs.some((p) => watched.indexOf(p) !== -1)
  });
  if (kept.length === cities.length) return
  applyCfg(Object.assign({}, cur, { watch: Object.assign({}, cur.watch, { cities: kept }) }));
}
let cityTableAbort = null; // 在途请求的取消器（插件卸载时用）
async function loadCityTable() {
  if (cityTableState === 'loading' || cityTableState === 'ready') return cityTableState
  if (typeof window === 'undefined' || typeof window.fetch !== 'function') { cityTableState = 'failed'; return cityTableState }
  cityTableState = 'loading';
  store.push({});
  const AC = (typeof window !== 'undefined' && window) ? window.AbortController : undefined;
  cityTableAbort = typeof AC === 'function' ? new AC() : null;
  try {
    const init = { headers: { accept: 'application/json' } };
    if (cityTableAbort) init.signal = cityTableAbort.signal;
    const res = await window.fetch(AREAS_PATH, init);
    if (!res || !res.ok) throw new Error('HTTP ' + (res ? res.status : '?'))
    const data = await res.json();
    const payload = isPlainObject(data) && isPlainObject(data.prefectures) ? data.prefectures : data;
    if (!setCityTable(payload)) throw new Error('payload 不含市町村表')
    // 河川予報区域表随同一份响应下发；缺失只影响洪水，不影响既有功能
    if (isPlainObject(data) && Array.isArray(data.riverAreas)) setRiverAreas(data.riverAreas);
    // 中国行政区划表供设置页的三级级联；缺失只影响大陆源的"选城市"路径，被拒时记原因以便显示重试
    if (isPlainObject(data) && Array.isArray(data.cnAreas)) setCnAreas(data.cnAreas);
    else cnAreasFailed = '响应里没有 cnAreas';
    // 全球国家清单（城市本体按 `?country=` 分包另取）；缺失只影响「其他国家 / 地区」分支的城市列表
    if (isPlainObject(data) && Array.isArray(data.worldCountries)) setWorldCountries(data.worldCountries);
    pruneUnknownCities();
    // 再把"所属县已不在关注列表里"的市町村清掉（见该函数说明）
    pruneCitiesOfUnwatchedPrefs();
  } catch (err) {
    // 插件卸载造成的中止不算"失败"：下次装载应当能重试
    const aborted = !!(cityTableAbort && cityTableAbort.signal && cityTableAbort.signal.aborted);
    cityTableState = aborted ? 'idle' : 'failed';
  }
  cityTableAbort = null;
  store.push({});
  return cityTableState
}
/** 插件卸载时调用：中止在途请求，免得卸载之后还去写 store / 用户配置。 */
function abortCityTableLoad() {
  if (cityTableAbort) {
    try { cityTableAbort.abort(); } catch (err) { /* 已结束等忽略 */ }
    // 故意不在这里置空：loadCityTable 的 catch 要靠它的 signal 区分「被中止」与「真失败」
  }
}

/** 重试加载行政区划表，供设置页的「重试」按钮使用：`loadCityTable` 的守卫会把 `loading` / `ready`
 *  挡回去，而唯一的调用点是 15-entry 的 `ctx.effect`（只在插件装载时执行一次），一次瞬时失败就会让
 *  整场会话失去市町村表（市级收窄失效 → 多报、设置页选不出市町村、prune 不再运行）。 */
async function retryCityTable() {
  if (cityTableState === 'loading') return cityTableState
  cityTableState = 'idle';
  cnAreasFailed = '';
  return loadCityTable()
}


// 供测试钩子重置表状态
const resetCityTable = () => {
  abortCityTableLoad();
  cityTable = null; cityNameSet = null; cityTableState = 'idle';
  addrAliasIndex = null; addrAliasMax = 0; cityPrefIndex = null; riverAreas = null;
  cnAreas = null;
  cnAreasFailed = '';
};

/** 大陆表的状态：'idle' | 'ready' | 'failed'。设置页据此区分"加载中"与"失败"。 */
const cnAreasStateOf = () => (cnAreas ? 'ready' : (cnAreasFailed ? 'failed' : 'idle'));

// ============================================================================
// dsh-quake-alert · client/src/05-parser.js
// 作用：P2PQuake 原始消息（code 551/552/556）→ 统一 Alert：字段映射、区域名对齐 prefsOfArea、
//       跨县区域展开、震度/海啸文案与 headline 组装。依赖 01-constants、02-storage、00-i18n。


// ---------- 解析器：P2PQuake code → Alert ----------
// Alert 字段：id/code/kind/kindLabel/severity/issued/headline/maxScale/hypo/geo/cancelled/raw，
// 加 regions:[{pref, area, scale?, grade?}]、eventKey（归并同一地震的多次发布）、strength（判强度升级）。

// 电文里的震中坐标 → { lat, lon }；缺一个 / 越界 / 非有限数一律返回 null（半个坐标会让跨源归并把
// 两场不相关的地震并成一个，属漏报方向）。只服务跨源事件归并（±2 分钟 + 50km，见 10-dedupe）：
// **不设 locator:'point'**，否则 06-matcher 按"震中距 ≤ 半径"匹配，漏掉震中远而本地震度达阈值的。
function geoOfHypo(hypo) {
  const lat = hypo ? hypo.latitude : null;
  const lon = hypo ? hypo.longitude : null;
  if (typeof lat !== 'number' || typeof lon !== 'number') return null
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return null
  return { lat, lon }
}
// 区域名 → 都道府县全称。551 的 points[].pref 本身是县全称（偶有「京都」这类简写，由 normalizePref 统一为全称）；
// 556/552 的 areas[].name 是「区域名」，一部分不含都道府县名（北海道用地方名、东京都用岛屿名、海啸予報区用海域名），不映射就会静默漏报。
const AREA_PREF = {
  '伊豆大島': ['東京都'], '新島': ['東京都'], '神津島': ['東京都'],
  '三宅島': ['東京都'], '八丈島': ['東京都'], '小笠原': ['東京都'],
  'オホーツク海沿岸': ['北海道'],
  '陸奥湾': ['青森県'],
  '東京湾内湾': ['千葉県', '東京都', '神奈川県'],
  '伊豆諸島': ['東京都'],
  '小笠原諸島': ['東京都'],
  '相模湾・三浦半島': ['神奈川県'],
  '佐渡': ['新潟県'],
  '伊勢・三河湾': ['愛知県', '三重県'],
  '淡路島南部': ['兵庫県'],
  '隠岐': ['島根県'],
  '有明・八代海': ['福岡県', '佐賀県', '長崎県', '熊本県'],
  '壱岐・対馬': ['長崎県'],
  '種子島・屋久島地方': ['鹿児島県'],
  '奄美群島・トカラ列島': ['鹿児島県'],
  '沖縄本島地方': ['沖縄県'],
  '大東島地方': ['沖縄県'],
  '宮古島・八重山地方': ['沖縄県'],
};
// 556 的 areas[].pref 是府県予報区名（简写："茨城"/"東京"/"北海道道北"…），仅作区域名对不上时的兜底。
const FORECAST_PREF = {
  '伊豆諸島': ['東京都'], '小笠原': ['東京都'], '奄美群島': ['鹿児島県'],
  '沖縄本島': ['沖縄県'], '大東島': ['沖縄県'], '宮古島': ['沖縄県'], '八重山': ['沖縄県'],
};
// 北海道在 EEW 中按地方名划分区域（石狩地方北部…），名称里没有「北海道」
const HOKKAIDO_AREA_PREFIX = [
  '石狩地方', '後志地方', '空知地方', '渡島地方', '檜山地方', '胆振地方', '日高地方',
  '上川地方', '留萌地方', '宗谷地方', '網走地方', '北見地方', '紋別地方', '十勝地方',
  '釧路地方', '根室地方',
];
// 县名按长度降序：保证「京都府」先于「京都」被匹配（否则京都府会被截成京都）
const PREF_BY_LENGTH = PREFECTURES.map((p) => p.jp).sort((a, b) => b.length - a.length);
const startsWith = (s, p) => s.lastIndexOf(p, 0) === 0;
// 字典查找一律用 own()（见 02-storage）：外部键会命中原型链，AREA_PREF['constructor'] 会让 .slice() 抛错。

// 对齐区域名，返回它可能覆盖的全部都道府县（海啸「有明・八代海」等跨多个县）
function prefsOfArea(name, forecastPref) {
  const s = String(name || '');
  const exact = own(AREA_PREF, s);
  if (exact) return exact.slice()
  if (HOKKAIDO_AREA_PREFIX.some((p) => startsWith(s, p))) return ['北海道']
  for (const p of PREF_BY_LENGTH) if (startsWith(s, p)) return [p]
  const hint = String(forecastPref || '');
  if (hint) {
    const hit = own(FORECAST_PREF, hint);
    if (hit) return hit.slice()
    for (const p of PREF_BY_LENGTH) if (startsWith(hint, p)) return [p]
    for (const p of PREF_BY_LENGTH) if (startsWith(p, hint)) return [p]
  }
  return []
}
// 把一个区域展开成 region 条目；跨县区域展开为多条，对不上时 pref='' 并标记
function regionsOfArea(name, forecastPref, value, valueKey) {
  const area = name || '';
  const prefs = prefsOfArea(area, forecastPref);
  if (prefs.length === 0) {
    const region = { pref: '', area, prefUnknown: true };
    region[valueKey] = value;
    return [region]
  }
  return prefs.map((p) => {
    const region = { pref: p, area };
    region[valueKey] = value;
    return region
  })
}
// 震度 / 海啸等级文字：按界面语言取词；取不到该档位的键时退回数字形态（别在这里写死中文）。
const scaleText = (v) => {
  const key = 'scale.' + v;
  const own1 = (typeof v === 'number') ? t(key) : '';
  if (own1 && own1 !== key) return own1
  if (typeof v === 'number' && v > 0) return t('scale.number', { n: Math.floor(v / 10) })
  return t('scale.unknown')
};
// 震度后缀：只在有效震度（>0）时追加；震度是用户判断严重性的关键信息（阈值也按震度设），必须出现在
// headline 里。prefix 例：'最大' → 「最大震度3」。prefix 与 scaleText 之间不留空格（英文靠 scaleText 自带空格）。
const scaleSuffix = (v, prefix) => (typeof v === 'number' && v > 0 ? ' · ' + prefix + scaleText(v) : '');
// severity → 颜色。'yellow'（默认阈值 40 下最常见的命中，震度4）必须显式处理，否则落到默认的"信息蓝"。
const sevColor = (s) => (
  s === 'red' ? '#e8565b'
    : (s === 'orange' ? '#f76b15'
      : (s === 'yellow' ? '#d9a406' : '#3b82f6'))
);
const severityOfScale = (v) => {
  if (typeof v !== 'number' || v <= 0) return 'info'
  if (v >= 55) return 'red'
  if (v >= 45) return 'orange'
  if (v >= 40) return 'yellow'
  return 'info'
};

function parseQuake(raw) {
  const type = (raw.issue && raw.issue.type) || '';
  // 分类名是我们给起的（不是电文原文）→ 按界面语言取词
  const labelMap = {
    ScalePrompt: 'kind.quakeScale', Destination: 'kind.quakeHypo', ScaleAndDestination: 'kind.quakeScaleHypo',
    DetailScale: 'kind.quakeDetail', Foreign: 'kind.quakeForeign', Other: 'kind.quakeInfo',
  };
  const labelKeyOf = () => own(labelMap, type) || 'kind.quakeInfo';
  const eq = raw.earthquake || {};
  const hypo = eq.hypocenter || {};
  const pts = raw.points || [];
  const hasHypo = typeof hypo.name === 'string' && hypo.name !== '';
  // 有震源名时用模板拼（`震源 {name} · M{mag}`）；震源名与机构名是上游原文，原样透传。
  const headBase = hasHypo
    ? t('kind.quakeHeadline', { name: hypo.name, mag: (typeof hypo.magnitude === 'number' ? hypo.magnitude : '—') })
    : t(labelKeyOf());
  const headline = headBase + scaleSuffix(eq.maxScale, t('scale.prefixMax'));
  return {
    id: String(raw.id || raw._id || ''), code: 551, kind: 'quake',
    kindLabel: t(labelKeyOf()),
    severity: severityOfScale(eq.maxScale),
    // 时间统一转成带偏移的 ISO 8601。P2PQuake 给的是裸 JST（"2026/09/07 23:25:14"），不补偏移
    // 在其它时区会差 1 小时且无标注；旧历史数据没有偏移，由 formatIssuedLocal 按 JST 解释。
    issued: p2pTimeToIso((raw.issue && raw.issue.time) || raw.time || ''),
    headline,
    maxScale: typeof eq.maxScale === 'number' ? eq.maxScale : -1,
    // 事件级去重键：同一次地震的速报 / 震源 / 详报共享 earthquake.time（551 没有 issue.eventId）
    eventKey: eq.time ? 'quake:' + eq.time : '',
    strength: typeof eq.maxScale === 'number' ? eq.maxScale : -1,
    hypo: { name: hypo.name || '', magnitude: typeof hypo.magnitude === 'number' ? hypo.magnitude : null },
    // 震中坐标：只给跨源事件归并用，不参与匹配（见 geoOfHypo）
    geo: geoOfHypo(hypo),
    regions: pts.map((p) => ({
      pref: normalizePref(p.pref),
      area: p.addr || '',
      scale: typeof p.scale === 'number' ? p.scale : -1,
      // isArea=true 是区域名（无法对应到具体市区町村），false/缺省才是观测点，可做市级收窄。
      cityKnown: p.isArea !== true,
    })),
    cancelled: false,
    raw,
  }
}

function parseEew(raw) {
  const cancelled = raw.cancelled === true;
  const eq = raw.earthquake || {};
  const hypo = eq.hypocenter || {};
  const areas = raw.areas || [];
  const maxTo = areas.reduce((m, a) => (typeof a.scaleTo === 'number' && a.scaleTo > m ? a.scaleTo : m), -1);
  return {
    id: String(raw.id || raw._id || ''), code: 556, kind: 'eew',
    kindLabel: cancelled ? t('kind.eewCancelled') : t('kind.eewWarning'),
    severity: cancelled ? 'info' : 'red',
    issued: p2pTimeToIso((raw.issue && raw.issue.time) || raw.time || ''),
    headline: cancelled
      ? t('kind.eewCancelledHeadline')
      : t('kind.quakeHeadline', { name: (hypo.name || t('kind.areaUnknown')), mag: (typeof hypo.magnitude === 'number' ? hypo.magnitude : '—') }) +
        scaleSuffix(maxTo, t('scale.prefixEewMax')),
    maxScale: maxTo,
    // EEW 的多报共享 issue.eventId（serial 递增），用它做事件级去重
    eventKey: (raw.issue && raw.issue.eventId) ? 'eew:' + raw.issue.eventId : '',
    strength: maxTo,
    hypo: { name: hypo.name || '', magnitude: typeof hypo.magnitude === 'number' ? hypo.magnitude : null },
    // 震中坐标：同 551（见 geoOfHypo）。EEW 是日本这一路最先播出的来源，跨源归并最依赖它带坐标。
    geo: geoOfHypo(hypo),
    regions: areas.flatMap((a) => regionsOfArea(a.name, a.pref, typeof a.scaleTo === 'number' ? a.scaleTo : -1, 'scale')),
    cancelled,
    raw,
  }
}

function parseTsunami(raw) {
  const cancelled = raw.cancelled === true;
  const areas = raw.areas || [];
  // 两侧分隔符与「高さ」前缀是我们拼的，走模板（`{area}：{grade}{height}`）；预报区名与浪高描述是电文原文。
  const gradeKeyOf = (grade) => {
    const k = 'tsunami.' + grade;
    const got = grade ? t(k) : '';
    return (got && got !== k) ? got : (grade || t('kind.areaUnknown'))
  };
  const lines = areas.map((a) => t('kind.tsunamiLine', {
    area: a.name || t('kind.areaUnknown'),
    grade: gradeKeyOf(a.grade),
    height: (a.maxHeight && a.maxHeight.description) ? t('kind.tsunamiHeight', { height: a.maxHeight.description }) : '',
  }));
  const worst = areas.reduce((m, a) => Math.max(m, own(TSUNAMI_RANK, a.grade) || 0), 0);
  const anyWarning = worst >= 2;
  return {
    id: String(raw.id || raw._id || ''), code: 552, kind: 'tsunami',
    kindLabel: cancelled
      ? t('kind.tsunamiCancelled')
      : (worst >= 3 ? t('kind.tsunamiMajor') : (anyWarning ? t('kind.tsunamiWarning') : t('kind.tsunamiAdvisory'))),
    severity: cancelled ? 'info' : (worst >= 2 ? 'red' : 'orange'),
    issued: p2pTimeToIso((raw.issue && raw.issue.time) || raw.time || ''),
    headline: cancelled ? t('kind.tsunamiCleared') : lines.join('；'),
    maxScale: worst,
    // 事件键用「预报区名集合」。海啸预报没有可归并的 id（issue 只有 source/time/type），绝不能留空：
    // cancelKeyOf 会退回 kind（'tsunami'），任意海域的解除都被当成"此前提醒过的事件"，播出一条无关的
    // 「海啸预报已解除」（海啸域的假安全）。区域不一致时匹配不上 → 不提示（安全侧）。
    eventKey: areas.length ? 'tsunami:' + areas.map((a) => String(a.name || '')).sort().join(',') : '',
    strength: worst,
    regions: areas.flatMap((a) => regionsOfArea(a.name, a.pref, a.grade || '', 'grade')),
    cancelled,
    raw,
  }
}

function parse(raw) {
  if (!raw || typeof raw !== 'object') return null
  if (raw.code === 556) return parseEew(raw)
  if (raw.code === 552) return parseTsunami(raw)
  if (raw.code === 551) return parseQuake(raw)
  return null
}

// ============================================================================
// dsh-quake-alert · client/src/05b-jma-parser.js
// 作用：気象庁防災情報XML 电文 → 与 P2PQuake 同套 Alert，让气象警报（泥石流 / 洪水 / 大雨 / 高潮…）走同一条主链；
//       依赖 01-constants、02-storage（own）、04-city-table（市町村反查 / 河川区域表）、05-parser（prefsOfArea）、00-i18n。
// 契约：警戒レベル是**读**出来的（<Kind><Name>「レベル４大雨危険警報」或 <Headline><Text>「【警戒レベル２相当情報［洪水］】」），不推算。
// ============================================================================


const LEVEL_DIGITS = { '１': 1, '２': 2, '３': 3, '４': 4, '５': 5, '1': 1, '2': 2, '3': 3, '4': 4, '5': 5 };
// 指定河川洪水予報（VXKO）：Kind 名称不带级别数字（「氾濫注意情報」…），等级按名称映射
const FLOOD_KIND_LEVEL = {
  '氾濫注意情報': 2, '氾濫注意報': 2,
  '氾濫警報': 3,
  '氾濫危険情報': 4,
  '氾濫発生情報': 5,
};
// 解除 / 无内容：这些 Kind 不代表"正在发布某种警报"；解除与发布共用同一条电文类型，靠 Name / Status 区分
const INACTIVE_KIND = /^(解除|なし|発表警報・注意報はなし)$/;

// 旧格式（R06 前）电文的 Kind 名称 → 警戒レベル：特別警報 5 / 危険警報 4 / 警報 3，注意報一律 0。
// 旧格式不带「レベルＮ」字样，只认数字会把最高级的特別警報整条丢掉（parseJma 返回 null），所以必须按
// 名称语义兜底。注意報返回 0 是电文级的刻意取值：L2 本就不播报，抬成 2 会让同一份注意報的两份副本
// （VPWW53 与（Ｈ２７））把历史刷屏；逐区级别另算（见 regionKindLevel）。
function legacyKindLevel(name) {
  const s = String(name || '');
  if (!s) return 0
  if (/特別警報/.test(s)) return 5
  if (/危険警報/.test(s)) return 4
  if (/警報/.test(s) && !/注意報/.test(s)) return 3
  return 0
}
// **地区级**级别：与 legacyKindLevel 的唯一差别是注意報给 2。地区级必须给出 2，否则该地区会**回退到
// 电文最大值**——一条含危険警報（L4）的电文里，只到「大雨注意報」的市町村会被播成「警戒レベル4」。
function regionKindLevel(name) {
  const s = String(name || '');
  if (!s) return 0
  if (/特別警報/.test(s)) return 5
  if (/危険警報/.test(s)) return 4
  if (/注意報/.test(s)) return 2
  if (/警報/.test(s)) return 3
  return 0
}
/** 解除 / 无内容：这些 Kind 不代表"正在发布某种警报"（Name 与 Status 任一命中即算）。 */
const isInactiveItem = (it) => !!it && (INACTIVE_KIND.test(it.kindName) || INACTIVE_KIND.test(it.status));
/** 单个 Item（一条电文里的一个区域块）的警戒レベル：名称里的「レベルＮ」优先，其次河川等级映射与名称语义。 */
function itemLevelOf(it) {
  return Math.max(
    maxLevelIn(it.kindName),
    own(FLOOD_KIND_LEVEL, it.kindName) || 0,
    regionKindLevel(it.kindName),
  )
}
// 电文标题 → 我们给起的标签 key（按界面语言取词）。左边正则拿去匹配上游**日文原文**，永远保持日文原样。
// 特别警报不在这个表里：它不能只看标题，见 kindLabelOf。
const KIND_LABELS = [
  [/土砂災害警戒情報/, 'kind.jmaLandslideInfo'],
  [/指定河川洪水予報/, 'kind.jmaFloodForecast'],
  [/（大雨）|[（(]浸水/, 'kind.jmaHeavyRain'],
  [/（土砂）/, 'kind.jmaLandslide'],
  [/（洪水）/, 'kind.jmaFlood'],
  [/（高潮）/, 'kind.jmaStormSurge'],
  [/（暴風）/, 'kind.jmaStorm'],
  [/（波浪）/, 'kind.jmaWave'],
  [/（雷）/, 'kind.jmaThunder'],
  [/（濃霧）/, 'kind.jmaFog'],
  [/（乾燥）/, 'kind.jmaDry'],
  [/（なだれ）/, 'kind.jmaAvalanche'],
];

// ---------- 最小 XML 取值工具（纯正则，不引依赖） ----------
const decode = (s) => String(s)
  .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
function block(scope, tagName) {
  const m = new RegExp('<' + tagName + '(?:\\s[^>]*)?>([\\s\\S]*?)</' + tagName + '>').exec(scope);
  return m ? m[1] : ''
}
function tag(scope, tagName) {
  const m = new RegExp('<' + tagName + '(?:\\s[^>]*)?>([\\s\\S]*?)</' + tagName + '>').exec(scope);
  return m ? decode(m[1]).trim() : ''
}
// 文本里出现的最大警戒レベル（全角 / 半角数字都认）
function maxLevelIn(text) {
  let max = 0;
  for (const m of String(text).matchAll(/レベル\s*([１-５1-5])/g)) {
    const n = own(LEVEL_DIGITS, m[1]) || 0;
    if (n > max) max = n;
  }
  return max
}

// ---------- 电文拆分 ----------
// 取值时用 (?:^|\s) 防止 codeType 被 type 的规则误命中。
const attrOf = (attrs, name) => {
  const m = new RegExp('(?:^|\\s)' + name + '="([^"]*)"').exec(String(attrs || ''));
  return m ? m[1] : ''
};

// 区域类型判定：优先看 codeType，缺失或不可辨时按**代码位数**兜底（实测：市町村 7 位／府県予報区・
// 細分区域 6 位／河川予報区域 12 位）。兜底是必需的：気象庁在 Body 的 <Warning> 里常把区域写成
// **裸 <Area>**（VXWW50 就是），只认 codeType 会一个区域都取不到，表现为"解析成功但 regions 为空"。
function regionKindOf(codeType, code) {
  const ct = String(codeType || '');
  if (/市町村/.test(ct)) return 'city'
  if (/予報区域/.test(ct)) return 'river'
  if (/府県予報区|細分区域/.test(ct)) return 'pref'
  // 显式给出 codeType 但不在上面的集合里 → 判未知，不按位数猜：放宽 <Area> 匹配后会摄入 `水位観測所`
  // 这类非行政区域，位数兜底会把码长恰好 6/7 位的它们变成幻影的府県予報区 / 市町村区域。
  if (ct) return ''
  const c = String(code || '');
  if (/^\d{12}$/.test(c)) return 'river'
  if (/^\d{7}$/.test(c)) return 'city'
  if (/^\d{6}$/.test(c)) return 'pref'
  return ''
}

// 提取电文里的 (Kind, 区域) 条目：按 <Warning type> / <Information type> 容器切块，块内 Item 继承该
// type 作为 codeType；容器内的 <Areas codeType> 优先，没有则退回 Item 里的裸 <Area>。
// 传入**全文**（而不是只传 Body）：市町村清单常只出现在 Head 的 <Information> 里。
function itemsOf(scope) {
  const out = [];
  const containers = [];
  for (const m of String(scope).matchAll(/<(Warning|Information)([^>]*)>([\s\S]*?)<\/\1>/g)) {
    containers.push({ type: attrOf(m[2], 'type'), body: m[3] });
  }
  if (containers.length === 0) containers.push({ type: '', body: String(scope) });
  // 按块取 <Area>（属性可有可无、Name/Code 可缺一）：原写法要求 <Area> 紧跟 <Name> 再 <Code>，带属性的
  // <Area codeType="…">、子元素顺序不同或只有 Name 的条目都会被静默丢弃 → regions 为空 → 不播报。
  // codeType 先看 <Area> 自身的属性，再退回容器 / 外层。
  const AREA = /<Area(\s[^>]*)?>([\s\S]*?)<\/Area>/g;
  const areasIn = (blockText, fallbackType) => {
    const list = [];
    for (const a of String(blockText).matchAll(AREA)) {
      const name = tag(a[2], 'Name');
      const code = tag(a[2], 'Code');
      if (!name && !code) continue
      list.push({ codeType: attrOf(a[1], 'codeType') || fallbackType, name, code });
    }
    return list
  };
  for (const c of containers) {
    for (const im of c.body.matchAll(/<Item>([\s\S]*?)<\/Item>/g)) {
      const raw = im[1];
      const kindBlock = block(raw, 'Kind');
      const item = {
        codeType: c.type,
        kindName: tag(kindBlock, 'Name'),
        kindCode: tag(kindBlock, 'Code'),
        status: tag(kindBlock, 'Status') || tag(kindBlock, 'Condition'),
        areas: [],
      };
      const wrapped = [...raw.matchAll(/<Areas([^>]*)>([\s\S]*?)<\/Areas>/g)];
      if (wrapped.length) {
        for (const am of wrapped) {
          const ct = attrOf(am[1], 'codeType') || c.type;
          for (const a of areasIn(am[2], ct)) item.areas.push(a);
        }
      } else {
        for (const a of areasIn(raw, c.type)) item.areas.push(a);
      }
      out.push(item);
    }
  }
  return out
}

// 判定电文整体的警戒レベル：Kind 名称、Headline 文本、标题三者取最大。指定河川洪水予報另按 Kind 名称
// 映射；土砂災害警戒情報固定 4（它本身就是 L4 相当）。
function levelOf({ title, headTitle, headlineText, notice, items, inactiveScope }) {
  let level = 0;
  for (const it of items) {
    // 用 isInactiveItem（Name 或 Status 任一命中即算解除）：只看 Name 会把"Status=解除、Name 仍是灾种名"的条目算进级别。
    if (isInactiveItem(it)) continue
    // 电文级刻意不含注意報的 2（理由见 legacyKindLevel）；逐区级别另算（见 itemLevelOf）。
    const inName = maxLevelIn(it.kindName);
    if (inName > level) level = inName;
    const mapped = own(FLOOD_KIND_LEVEL, it.kindName) || 0;
    if (mapped > level) level = mapped;
    const legacy = legacyKindLevel(it.kindName);
    if (legacy > level) level = legacy;
  }
  // 除标题与主文之外还必须读 **<Body><Notice>**：Ｒ０６ 総合副本（VPWW53/54）把多灾种多级别合并成一条，
  // Kind 只写灾种名，地区级级别只出现在 Notice 里（［危険警報・氾濫特別警報の発表状況］〈レベル４大雨危険警報〉姫路市…）；
  // 不读它，整条真实存在的 L4 危険警報会被判成 L3 而不播报。
  for (const s of [headlineText, notice, headTitle, title]) {
    const n = maxLevelIn(s);
    if (n > level) level = n;
  }
  // 有些电文只在主文里写〈危険警報（大雨、土砂災害）〉而不带「レベルＮ」：危険警報固定是 L4 相当，
  // 按语义兜底。**必须要求它出现在〈…〉条目里**：Notice 的栏目名固定写作「［危険警報・氾濫特別警報の
  // 発表状況］」，用裸 /危険警報/ 会把每一条带该 Notice 的电文都抬成 L4。
  const dangerItem = /〈[^〉]*危険警報/.test(String(headlineText || '') + ' ' + String(notice || ''));
  if (level < 4 && dangerItem) level = 4;
  if (level === 0 && /土砂災害警戒情報/.test(title)) level = 4;
  // 「気象特別警報報知」是特別警報的报知电文，Kind 缺失时按标题兜底为 L5；**必须排除整条都是解除**的
  // 情况（解除报知的 Kind 是「解除」，循环里被跳过），否则一条解除消息会被抬成 L5，headline 显示成
  // 「警戒レベル5（已解除）」。口径必须与 cancelled 相同——只看 Body 副本（见 parseJma）：JMA 常把
  // 解除写在 <Status> 里而 Name 为空，且 Head 的摘要副本根本没有 Status。
  const scope = inactiveScope || items;
  const allInactive = scope.length > 0 && scope.every(isInactiveItem);
  if (level === 0 && !allInactive && /気象特別警報報知/.test(title)) level = 5;
  return level
}

// 从 <Body><Notice> 解析「级别 → 地区名列表」：〈レベル４大雨危険警報〉姫路市　たつの市　多可町＊
// ——全角空格分隔，`＊` 表示列表不完整，所以只做**精确提升**：列出的地区提升到该级别，没列出的仍按
// 自己的 Kind 判定（R06 分灾种副本带精确的逐区级别，会照常播报那些地区）。解析不出来返回空表，调用方回退电文级别。
function noticeAreaLevels(notice) {
  const text = String(notice || '');
  if (!text || text.indexOf('レベル') === -1) return []
  const out = [];
  const push = (digit, listText) => {
    const level = own(LEVEL_DIGITS, digit) || 0;
    if (level <= 0) return
    const names = String(listText)
      .split(/[\s\u3000、,，]+/)
      // 去掉尾随的省略标记：半角的 `*` 也会粘在最后一个地区名上，只排除全角 `＊` 会漏掉那个唯一的 L4 城市。
      .map((s) => s.replace(/[*＊※…]+$/g, '').trim())
      .filter(Boolean);
    if (names.length) out.push({ level, names });
  };
  // 形态 A：〈レベル４大雨危険警報〉姫路市　たつの市　多可町＊ —— 级别标记到 〉限在同一行、限长 40 字：
  // 原来的 `[^〉]*` 会跨段一直吃到后面某段的 〉，把级别错配到别的市町村（误报与漏报同时发生）。
  // 地区列表用 `[\s\S]{0,300}?` + 前瞻到 `〈` / `］` / 结尾：允许跨行，但不会吞进下一段。
  for (const m of text.matchAll(/レベル\s*([１-５1-5])[^〉\n]{0,40}〉([\s\S]{0,300}?)(?=〈|］|$)/g)) push(m[1], m[2]);
  // 形态 B：［警戒レベル４相当情報の発表状況］\n姫路市　たつの市 —— 级别写在**栏目名**里，地区列表紧随其后。
  for (const m of text.matchAll(/［[^］\n]*レベル\s*([１-５1-5])[^］]*］([\s\S]{0,300}?)(?=〈|［|$)/g)) push(m[1], m[2]);
  return out
}
/** 把 Notice 里的地区级级别套到 regions 上（名称经假名写法对齐后比较差异）。只在更高时提升。 */
function applyNoticeLevels(regions, notice) {
  const pairs = noticeAreaLevels(notice);
  if (pairs.length === 0) return regions
  for (const r of regions) {
    const own1 = normKana(r.city || '');
    const own2 = normKana(r.area || '');
    for (const p of pairs) {
      let hit = false;
      for (const n of p.names) {
        const k = normKana(n);
        if ((own1 && own1 === k) || (own2 && own2 === k)) { hit = true; break }
      }
      if (hit && p.level > (r.level || 0)) r.level = p.level;
    }
  }
  return regions
}

// 区域展开：一律归到「都道府県 + 市町村」两层，查不到归属县就标记 prefUnknown（放行）。市町村名必须换成
// 本表的规范写法（canonicalCityOf）：用户勾选的名字来自市区町村表，而电文与河川区域表给的是外部写法
// （「南アルプス市」vs 本表「南あるぷす市」、「金ケ崎町」vs「金け崎町」），直接比对会漏报；取不到规范名时回退原写法。
function regionsOf(items, notice, opts) {
  const includeInactive = !!(opts && opts.includeInactive);
  const out = [];
  const at = new Map(); // 区域键 → out 下标：同一区域重复出现时保留更高的级别
  const push = (region, level) => {
    const key = region.pref + '|' + (region.city || '') + '|' + region.area;
    const idx = at.get(key);
    if (idx !== undefined) {
      if (level > (out[idx].level || 0)) out[idx].level = level;
      return
    }
    at.set(key, out.length);
    out.push(level > 0 ? Object.assign({ level }, region) : region);
  };
  for (const it of items) {
    if (!includeInactive && isInactiveItem(it)) continue
    // 逐区级别由这条 Item 自己的 Kind 决定，**不能用电文最大值**（同一次发布里各区级别可以不同）。
    const lv = itemLevelOf(it);
    for (const a of it.areas) {
      const kind = regionKindOf(a.codeType, a.code);
      if (kind === 'city' || kind === 'pref') {
        const city = kind === 'city' ? (canonicalCityOf(a.name) || a.name) : '';
        // 判县优先用区域码前两位（准确），名称反查只在前者不可用时兜底
        const byCode = prefOfCode(a.code);
        if (byCode) {
          push({ pref: byCode, area: a.name, city }, lv);
          continue
        }
        const prefs = kind === 'city' ? prefsOfCity(a.name) : prefsOfArea(a.name);
        if (prefs.length === 0) push({ pref: '', area: a.name, city, prefUnknown: true }, lv);
        else for (const p of prefs) push({ pref: p, area: a.name, city }, lv);
      } else if (kind === 'river') {
        // 河川予報区域码是 12 位，前两位与都道府県无关，只能查 river-areas 表
        const cities = riverAreaCities(a.code);
        if (cities.length === 0) push({ pref: '', area: a.name, city: '', prefUnknown: true }, lv);
        else {
          for (const raw of cities) {
            const c = canonicalCityOf(raw) || raw;
            const prefs = prefsOfCity(c);
            if (prefs.length === 0) push({ pref: '', area: a.name, city: c, prefUnknown: true }, lv);
            else for (const p of prefs) push({ pref: p, area: a.name, city: c }, lv);
          }
        }
      }
      // 判不出类型的条目（水位観測所等）一律忽略
    }
  }
  // <Body><Notice> 是総合副本里唯一的地区级级别来源（见 noticeAreaLevels）
  return applyNoticeLevels(out, notice)
}

// 电文标题 → 标签。**特别警报必须结合级别判**：「気象特別警報・警報・注意報」是 VPWW53 的**产品名**
// （総括副本），只说明这份电文覆盖特別警報／警報／注意報三类，与这一条里有没有特別警報无关——只看标题
// 会把 L4 显示成「气象特别警报」（把官方等级说高一级），而 VPWW54 在 L5 时又会低估成「气象警报」。
// 所以汇总族（SUMMARY_TITLE 的四种产品名）按级别取标签；带灾种名的分灾种副本（（大雨）／（土砂）…）仍按标题。
function kindLabelOf(title, level) {
  // 局部变量不能叫 `t`（那是 00-i18n 的取词函数，遮蔽之后本函数里的 t('…') 会变成调用字符串）。
  const src = String(title || '');
  // ① 先按**灾种**匹配：带灾种名的副本给出的是具体灾种，比"气象警报"这类概括标签有信息量。
  for (const [re, labelKey] of KIND_LABELS) if (re.test(src)) return t(labelKey)
  // ② 汇总族（SUMMARY_TITLE 的四种产品名）与概括名「気象警報・注意報」本身不含灾种 → 按级别取。
  if (SUMMARY_TITLE.test(src) || /気象警報・注意報/.test(src)) {
    return (typeof level === 'number' && level >= 5) ? t('kind.jmaWeatherEmergency') : t('kind.jmaWeather')
  }
  // ③ 认不出的标题：**原样返回电文标题**（上游原文，不翻），没有标题时才用概括标签。
  return src || t('kind.jmaWeather')
}

// 汇总型电文：同一次发布会有 2〜3 份**不同格式的副本**同时出现在 feed 里（VPWW53、VPWW54（Ｈ２７）、
// VPNO50），title / headTitle 各不相同且気象警報・注意報 的 EventID 为空——沿用标题做事件键会当成三个事件。
const SUMMARY_TITLE = /気象特別警報・警報・注意報|気象警報・注意報（Ｈ２７）|気象警報・注意報（Ｒ０６）|気象特別警報報知/;
// 灾种关键词（按最高级别的 Kind 名称匹配具体灾种）
const HAZARD_KEYS = [
  [/大雨|浸水/, '大雨'], [/土砂/, '土砂'], [/洪水|氾濫/, '洪水'], [/高潮/, '高潮'],
  [/暴風/, '暴風'], [/波浪/, '波浪'], [/雷/, '雷'], [/濃霧/, '濃霧'],
  [/乾燥/, '乾燥'], [/なだれ/, 'なだれ'], [/大雪|着雪/, '大雪'],
];
/** 从一条 Kind 名称里取灾种关键词（取不到返回空串）。 */
function hazardWordOf(name) {
  const s = String(name || '');
  for (const [re, key] of HAZARD_KEYS) if (re.test(s)) return key
  return ''
}
/** 取级别最高的那条 Kind 名称，再从中提取灾种——副本之间只要最高级条目相同就会得到同一个键。 */
function hazardKeyOf(items, fallbackText) {
  let name = '';
  let best = -1;
  for (const it of items) {
    if (isInactiveItem(it)) continue
    const lv = itemLevelOf(it);
    if (lv > best) { best = lv; name = it.kindName; }
  }
  // 先用灾种关键词；没有关键词的灾种（「竜巻注意報」这类）直接用 Kind 名称当键——统一到未知标记会让两个不同灾种共用一把钥匙。
  const activeKey = hazardWordOf(name) || String(name || '');
  if (activeKey) return activeKey
  // 再退到 inactive 条目：解除电文里"被解除的那一项"往往就写着灾种（「大雨警報」+ Status=解除），
  // 无条件跳过会让键退化，而发布电文算出的键是 `jma:summary:大雨:<office>` → 两边永不相等，解除提示从未生效。
  for (const it of items) {
    const hit = hazardWordOf(it.kindName);
    if (hit) return hit
  }
  for (const [re, key] of HAZARD_KEYS) if (re.test(String(fallbackText || ''))) return key
  // 认不出灾种（VPNO50「東京都の特別警報を警報に切り替えました」这类报知电文通篇不带灾种）→ 用**显式
  // 未知标记** `?`：退回「气象」看起来像一个具体灾种，又会与将来真叫「气象」的键撞车。
  return '?'
}

// 解析一条 JMA 电文 → Alert；返回 null 表示这条电文与本插件无关（天气预报、地震火山、观测资料等）。
// xml 是详情电文原文；entry 是 Host 侧 feed 条目（给 Alert 一个稳定 id）。
function parseJma(xml, entry) {
  // 先剥掉 XML 注释：注释里可能出现 `<Body>` / `<Notice>` / 「レベル４」这类字样，而 block()/tag() 只认
  // 标签，会让 notice 变成"注释文本 + 末尾真正的 Notice"。indexOf 早退：未闭合的 `<!--` 会退化成 O(n²) 回溯。
  let text = String(xml || '');
  if (text.indexOf('<!--') !== -1 && text.indexOf('-->') !== -1) text = text.replace(/<!--[\s\S]*?-->/g, '');
  if (!text || text.indexOf('<Report') === -1) return null
  const control = block(text, 'Control');
  const head = block(text, 'Head');
  const body = block(text, 'Body');

  const title = tag(control, 'Title') || tag(head, 'Title');
  const headTitle = tag(head, 'Title');
  const headlineText = tag(block(head, 'Headline'), 'Text');
  // <Body><Notice>：Ｒ０６ 総合副本里唯一的地区级级别来源（见 levelOf / noticeAreaLevels）
  const notice = tag(body, 'Notice');
  const reportTime = tag(head, 'ReportDateTime') || tag(control, 'DateTime');
  const eventId = tag(head, 'EventID');
  // 用**全文**提取条目：市町村清单常只出现在 Head 的 <Information> 里（Body 的 <Warning> 反而只有摘要），
  // 只看 Body 会取不到区域；重复条目由 regionsOf 去重兜底。
  const items = itemsOf(text);
  // 解除判定只看 **Body** 副本：Head 的摘要项通常**没有 <Status>**（Head 的 Kind 只有 Name/Code/Condition），
  // 而 every() 跨两份副本聚合，Head 里那条同名 Item 会把"Status=解除"稀释成"发布"。Body 缺失时退回全部 items。
  const bodyItems = itemsOf(body);
  const inactiveScope = bodyItems.length > 0 ? bodyItems : items;

  const level = levelOf({ title, headTitle, headlineText, notice, items, inactiveScope });
  const cancelled = inactiveScope.length > 0 && inactiveScope.every(isInactiveItem);
  // 把「特別警報 → 警報」的**降级**从"解除"里分出来：「…を警報に切り替えました」既不是解除也不是新发布，
  // 特別警報结束了但**警報仍然有效**。按解除处理会让历史写下「气象警报（已解除）」（假安全方向）；
  // 降级成一个正常的 L4 警报，交给关注地区 / 阈值 / 静默时段照常裁决，它的键与随后的真解除相同。
  const downgradeTo = cancelled
    ? (/注意報に切り替え/.test(headlineText || '') ? 2 : (/警報に切り替え/.test(headlineText || '') ? 4 : 0))
    : 0;
  const downgraded = downgradeTo > 0;
  const cancels = cancelled && !downgraded;
  // 没有级别又不取消（也不是降级）→ 与预警无关（天气预报、观测资料等），交给调用方丢弃
  if (level === 0 && !cancels && !downgraded) return null

  const effLevel = downgraded ? downgradeTo : level;
  // 降级电文要**保留区域**（解除才清空）：regionsOf 默认跳过 inactive 条目，而降级电文里唯一的条目就是
  // 「解除」那一项；区域级别由降级后的档位补上。
  const regions = cancels ? [] : regionsOf(items, notice, { includeInactive: downgraded });
  if (downgraded) for (const r of regions) if (typeof r.level !== 'number') r.level = effLevel;
  const kindLabel = kindLabelOf(title, effLevel);
  const first = String(headlineText || '').split(/[。\n]/)[0].trim();
  const levelText = effLevel > 0 ? t('kind.levelSuffix', { level: effLevel }) : '';
  const headline = (kindLabel + levelText + (first ? ' · ' + first : '')).slice(0, 180);
  // 事件键：优先 EventID，其次 Head 标题；汇总型电文改用**内容指纹**「灾种 + 編集官署名コード」，否则同一条
  // 警报会因副本标题不同被当成三个事件。指纹**刻意不含发布时刻**：同一次发布的副本会跨分钟（分灾种副本
  // 11:30:33 / 総合副本 11:31:10），而解除的发布时间必然晚于发布，含时刻就注定让解除与发布算出不同的键、
  // 解除链路失效；同一官署 + 同一灾种在事件窗口内共用一键，重复与升级由去重层判定（见 10-dedupe）。
  // 官署名碼取电文 id 的后缀（編集官署名コード：130000=気象庁、280000=神戸地方気象台…），不能用 regions[0]
  // ——解除电文的 regions 恒为空。**取不到后缀时退回 <EditorialOffice> 文本，绝不留空**：留空会让所有官署
  // 的同一灾种共用一个键（`jma:summary:大雨:`），一次发布会被当成另一次发布的重复而静默。
  const idSuffix = /([0-9]{6})\.xml$/.exec(String((entry && entry.id) || ''));
  const officeKey = (idSuffix ? idSuffix[1] : '') ||
    tag(control, 'EditorialOffice') || tag(control, 'PublishingOffice') || 'unknown';
  const eventKey = SUMMARY_TITLE.test(title)
    ? 'jma:summary:' + hazardKeyOf(items, headlineText) + ':' + officeKey
    : 'jma:' + (eventId || headTitle || title);

  return {
    id: (entry && entry.id) || eventId || title,
    code: 'jma',
    kind: 'weather',
    kindLabel: cancels
      ? kindLabel + t('kind.cancelledSuffix')
      : (downgraded ? kindLabel + t('kind.downgradedSuffix') : kindLabel),
    severity: effLevel >= 4 ? 'red' : (effLevel === 3 ? 'orange' : (effLevel === 2 ? 'yellow' : 'info')),
    issued: reportTime,
    headline,
    level: effLevel,
    maxScale: effLevel,
    hypo: { name: '', magnitude: null },
    regions: regions.length ? regions : [],
    eventKey,
    strength: effLevel,
    cancelled: cancels,
    // 降级为警报 / 注意报：cancelled 为 false 是有意的——警報仍然有效。
    downgraded,
    raw: { title, headTitle, eventId, infoType: tag(head, 'InfoType'), serial: tag(head, 'Serial') },
  }
}

// 测试电文场景，按顺序轮换，覆盖链路上不同分支：级别落点（Kind 名称 / 标题本身即 L4 的土砂災害警戒情報 /
// Headline 主文里的指定河川洪水予報）、区域粒度（市町村 / 府県予報区）、边界两侧（L4 播报、L3 不播报）。
const TEST_SCENARIOS = [
  { key: 'landslide' },
  { key: 'flood' },
  { key: 'heavyrain' },
  { key: 'stormsurge' },
  { key: 'landslide-l3' },
];

function testXml(o) {
  const stamp = new Date(o.ms).toISOString();
  return '<?xml version="1.0" encoding="UTF-8"?>' +
    '<Report xmlns="http://xml.kishou.go.jp/jmaxml1/">' +
    '<Control><Title>' + o.controlTitle + '</Title><DateTime>' + stamp + '</DateTime>' +
    '<Status>通常</Status><EditorialOffice>QuakeAlert テスト</EditorialOffice></Control>' +
    '<Head xmlns="http://xml.kishou.go.jp/jmaxml1/informationBasis1/">' +
    '<Title>' + o.headTitle + '</Title><ReportDateTime>' + stamp + '</ReportDateTime>' +
    '<EventID>' + o.eventId + '</EventID><InfoType>発表</InfoType><Serial>' + o.ms + '</Serial>' +
    '<Headline><Text>' + o.headlineText + '</Text>' +
    '<Information type="' + o.infoType + '"><Item>' +
    '<Kind><Name>' + o.kindName + '</Name><Code>' + o.kindCode + '</Code><Status>発表</Status></Kind>' +
    '<Areas codeType="' + o.codeType + '">' +
    '<Area><Name>' + o.areaName + '</Name><Code>' + o.areaCode + '</Code></Area>' +
    '</Areas></Item></Information></Headline></Head><Body/></Report>'
}

// 构造一条**测试用**电文（不联网）：设置页的「发送测试气象警报」按钮用它走完整链路。
// 区域挂在"用户关注的第一个都道府县"下——写死一个县会让关注别处的用户点下去被匹配挡掉、什么都不发生；
// 没选任何县（全日本模式）时退回東京都。判县只看区域码前两位，用县码拼出的码就够。
// id 与 EventID 都带时间戳与场景名：否则第二条会被消息级去重挡住，或被事件级去重当成"强度未升级的重复
// 发布"而只记历史、不播报。
// @param pref 都道府县名（关注列表首项）；@param nowMs 时间戳；@param key TEST_SCENARIOS 里的 key（默认
// landslide）；@param cityName 市町村级场景用的市町村名（表未加载时可省略，退回县名）。
function buildTestTelegram(pref, nowMs, key, cityName) {
  const p = pref || '東京都';
  const pc = prefCodeOf(p) || '13';
  const ms = nowMs || Date.now();
  const scenario = key || 'landslide';
  const eventId = 'QUAKEALERT-TEST-' + scenario + '-' + ms;
  const base = { ms, eventId };
  const city = cityName || '';
  if (scenario === 'flood') {
    return testXml(Object.assign(base, {
      controlTitle: '指定河川洪水予報',
      headTitle: p + '指定河川洪水予報（テスト）',
      headlineText: '【警戒レベル４相当情報［洪水］】' + p + 'のテスト川では、氾濫危険水位に到達しています' +
        '（これはテスト配信です。実際の災害ではありません。）。',
      infoType: '指定河川洪水予報',
      kindName: '氾濫危険情報', kindCode: '40',
      codeType: '気象情報／府県予報区・細分区域等',
      areaName: p, areaCode: pc + '0000',
    }))
  }
  if (scenario === 'heavyrain' || scenario === 'stormsurge') {
    const isSurge = scenario === 'stormsurge';
    const kind = isSurge ? '高潮危険警報' : '大雨危険警報';
    const field = isSurge ? '高潮' : '大雨';
    return testXml(Object.assign(base, {
      controlTitle: '気象警報・注意報（Ｒ０６）（' + field + '）',
      headTitle: p + field + '警報・注意報（テスト）',
      headlineText: p + 'にレベル４' + kind + 'を発表しています（これはテスト配信です。実際の災害ではありません。）。',
      infoType: '気象警報・注意報（府県予報区等）',
      kindName: 'レベル４' + kind, kindCode: isSurge ? '48' : '43',
      codeType: '気象情報／府県予報区・細分区域等',
      areaName: p, areaCode: pc + '0000',
    }))
  }
  if (scenario === 'landslide-l3') {
    return testXml(Object.assign(base, {
      controlTitle: '気象警報・注意報（Ｒ０６）（土砂）',
      headTitle: p + '土砂災害警報・注意報（テスト）',
      headlineText: p + 'にレベル３土砂災害警報を発表しています（これはテスト配信です。実際の災害ではありません。）。',
      infoType: '気象警報・注意報（府県予報区等）',
      kindName: 'レベル３土砂災害警報', kindCode: '03',
      codeType: '気象情報／府県予報区・細分区域等',
      areaName: p, areaCode: pc + '0000',
    }))
  }
  // 默认：土砂災害警戒情報（电文本身就是警戒レベル4 相当）
  return testXml(Object.assign(base, {
    controlTitle: '土砂災害警戒情報',
    headTitle: p + '土砂災害警戒情報（テスト）',
    headlineText: '【警戒レベル４相当情報［土砂災害］】' + p + city +
      'では、土砂災害が発生するおそれが高まっています（これはテスト配信です。実際の災害ではありません。）。',
    infoType: '土砂災害警戒情報',
    kindName: '警戒', kindCode: '3',
    codeType: '気象・地震・火山情報／市町村等',
    areaName: city || p, areaCode: pc + '00000',
  }))
}

// ============================================================================
// dsh-quake-alert · client/src/05c-global-parsers.js
// 作用：三个全球源 → 与日本源同套 Alert：EMSC standing_order WebSocket（顶层 { action, data }，data 是
//       GeoJSON **Feature** 而非 FeatureCollection）、USGS summary feed、NOAA tsunami.gov 的 CAP 1.2。
// 依赖：02-storage（isPlainObject）、00-i18n（t）。
// 契约：全球源只给「震中坐标 + 震级」，没有都道府县 / 市町村 → locator:'point'、regions 恒为空数组，匹配交给
//       06-matcher 的 matchPointAlert（Haversine 距离）；震级阈值是独立旋钮 thresholds.globalMagnitude（与
//       日本的震度不可换算）。EMSC 的区域字段叫 flynn_region、time 是 ISO 字符串、lat/lon 在 properties 里；
//       USGS 的 geometry.coordinates = [lon, lat, depthKm]、time/updated 是 epoch 毫秒；NOAA 的 circle 是
//       "lat,lon 半径"，震级与震中另有 parameter（EventPreliminaryMagnitude / EventLatLon）。
// ============================================================================


// 取第一个可用数值（全球源的坐标 / 震级可能同时存在于两三个地方，按优先级回退），经 toNumOrNull 规整，
// 所以**数字字符串也算**（CAP 的 parameter 全是字符串）：只认 typeof number 会让 magnitude 变 null、震级门槛被整个跳过。
function firstNumber(...vals) {
  for (const v of vals) {
    const n = toNumOrNull(v);
    if (n !== null) return n
  }
  return null
}
// 字符串 → 数值；空串与垃圾值一律给 null。不能用 Number('')——它等于 0，会把"没有震级"变成"震级 0"。
function toNumOrNull(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null
  const s = String(v === undefined || v === null ? '' : v).trim();
  if (!s) return null
  const n = Number(s);
  return Number.isFinite(n) ? n : null
}
function decodeXml(s) {
  return String(s)
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&')
}
/** 单个标签的文本（取首个匹配；CAP 的 info/area 都是单层，够用）。 */
function tagText(scope, name) {
  const m = new RegExp('<' + name + '(?:\\s[^>]*)?>([\\s\\S]*?)</' + name + '>').exec(String(scope));
  return m ? decodeXml(m[1]).trim() : ''
}

// 震级 → severity，与日本源按震度分级（10..70）是两套独立边界：M7 以上是需跨区域响应的大地震，
// M6 以上可能造成局部破坏，M5 以上普遍有感。
function severityOfMagnitude(mag) {
  if (typeof mag !== 'number' || !Number.isFinite(mag)) return 'info'
  if (mag >= 7) return 'red'
  if (mag >= 6) return 'orange'
  if (mag >= 5) return 'yellow'
  return 'info'
}

// 事件键里的「发震时刻（分钟）」必须先**换算到 UTC** 再取分钟：各源给的 ISO 偏移不同（EMSC 是 `…Z`、
// USGS 经 toIso 也是 `…Z`，大陆源是 `+08:00`），直接切字符串前 16 位会让同一场地震落进相隔 8 小时的
// 两个桶，键永远不相等、跨源归并失效，同一场地震响两次。无法解析时返回 null（见 geoEventKey）。
function minuteKeyOf(timeIso) {
  const s = String(timeIso === undefined || timeIso === null ? '' : timeIso);
  // 局部变量不叫 `t`（那是 00-i18n 的取词函数，遮蔽了本函数里的 t('key') 会去调 Date.parse）
  const ms = Date.parse(s);
  if (!Number.isFinite(ms)) return null
  return new Date(ms).toISOString().slice(0, 16)
}

// 跨源事件键：同一场地震 EMSC 与 USGS 都会推，两边机构、编号、震级都可能不同，但「发震时刻（分钟）+
// 震中（0.1 度 ≈ 11km）」是一致的，用它把两个全球源的同一次地震归并成一个事件。跨分钟边界（两边测定的
// 发震时刻差过一分钟）时归并会失败——宁可多响一次，不漏报。大陆源（cenc_eew / cenc_eqlist）走同一把钥匙：
// 它们的 **EventID 与 EEW 格式完全不同**（EEW 是 `b4kybfnuqayyy` 这类随机串，速报是 `CD.20260918205536.056`），归并只能靠时间 + 震中。
// 0.1° 桶的字符串化。**必须把 "-0.0" 统一成 "0.0"**：`(-0.02).toFixed(1)` 得 "-0.0" 而 `(0.02).toFixed(1)`
// 得 "0.0"，赤道与本初子午线两侧的震中会落进两个不同的桶，事件键永远不相等 → 跨源归并失败、同一场地震响两次。
function oneDp(n) {
  if (typeof n !== 'number' || !Number.isFinite(n)) return '?'
  const s = n.toFixed(1);
  return s === '-0.0' ? '0.0' : s
}

// 时间不可解析时的事件键序号，**只增不减**：两段时间不可解析的事件永远不会得到同一个键（见 geoEventKey）。
let unknownTimeSeq = 0;

function geoEventKey(timeIso, lat, lon) {
  const min = minuteKeyOf(timeIso);
  // 时间不可解析时**不能**退回 `String(timeIso).slice(0, 16)`：空串会切片成空串，键退化成 `geo:@30.9,99.9`，
  // 该震中之后**所有**事件共用这一个键，后续地震全部被判重复而静默（漏报）。给一个不可能与其它事件相同的键。
  const at = min === null ? ('!t' + (++unknownTimeSeq)) : min;
  return 'geo:' + at + '@' + oneDp(lat) + ',' + oneDp(lon)
}

/** epoch 毫秒或 ISO 字符串 → ISO 字符串（USGS 给毫秒，EMSC 给字符串，统一到后者）。 */
function toIso(v) {
  if (typeof v === 'number' && Number.isFinite(v)) {
    const d = new Date(v);
    return Number.isFinite(d.getTime()) ? d.toISOString() : ''
  }
  return typeof v === 'string' ? v : ''
}

// EMSC standing_order WebSocket 消息 → Alert。消息形如 { action: 'create'|'update'|'delete', data: Feature }；
// 非地震事件（爆炸等）由 properties.evtype 区分，实测 'ke' = known earthquake。
function parseEmsc(raw) {
  if (!isPlainObject(raw)) return null
  const d = isPlainObject(raw.data) ? raw.data : null;
  const p = d && isPlainObject(d.properties) ? d.properties : null;
  if (!p) return null
  const coords = (d.geometry && Array.isArray(d.geometry.coordinates)) ? d.geometry.coordinates : [];
  const lon = firstNumber(p.lon, coords[0]);
  const lat = firstNumber(p.lat, coords[1]);
  const depth = firstNumber(p.depth, coords[2]);
  const mag = firstNumber(p.mag, null);
  const region = String(p.flynn_region || '').trim();
  const time = toIso(p.time);
  const unid = String(p.unid || p.source_id || d.id || '').trim();
  const headline = 'M' + (mag === null ? '—' : mag) + (region ? ' · ' + region : '') +
    (depth === null ? '' : t('kind.depthSuffix', { depth: Math.round(depth) }));
  return {
    id: 'emsc:' + (unid || (lat + ',' + lon + ',' + time)),
    code: 'emsc',
    kind: 'quake',
    kindLabel: t('kind.globalEmsc'),
    source: 'emsc',
    locator: 'point',
    severity: severityOfMagnitude(mag),
    issued: time,
    headline,
    maxScale: -1,
    level: 0,
    geo: { lat, lon, depthKm: depth },
    magnitude: mag,
    magType: String(p.magtype || ''),
    hypo: { name: region, magnitude: mag },
    regions: [],
    eventKey: geoEventKey(time, lat, lon),
    strength: mag === null ? 0 : mag,
    cancelled: false,
    raw,
  }
}

/** USGS summary feed 的单个 Feature → Alert。coordinates 顺序是 [经度, 纬度, 深度 km]。 */
function parseUsgsFeature(f) {
  if (!isPlainObject(f)) return null
  const p = isPlainObject(f.properties) ? f.properties : null;
  if (!p) return null
  const coords = (isPlainObject(f.geometry) && Array.isArray(f.geometry.coordinates)) ? f.geometry.coordinates : [];
  const lon = firstNumber(coords[0], p.lon);
  const lat = firstNumber(coords[1], p.lat);
  // 坐标不完整时**不造事件对象**：null 组合会让不同地震的 id 撞在一起（`usgs:null,null,<time>`），并进历史与诊断。
  if (typeof lat !== 'number' || !Number.isFinite(lat) ||
      typeof lon !== 'number' || !Number.isFinite(lon)) return null
  const depth = firstNumber(coords[2], null);
  const mag = firstNumber(p.mag, null);
  const place = String(p.place || '').trim();
  const time = toIso(p.time);
  const headline = 'M' + (mag === null ? '—' : mag) + (place ? ' · ' + place : '') +
    (depth === null ? '' : t('kind.depthSuffix', { depth: Math.round(depth) }));
  return {
    id: 'usgs:' + String(f.id || p.code || (lat + ',' + lon + ',' + time)),
    code: 'usgs',
    kind: 'quake',
    kindLabel: t('kind.globalUsgs'),
    source: 'usgs',
    locator: 'point',
    severity: severityOfMagnitude(mag),
    issued: time,
    headline,
    maxScale: -1,
    level: 0,
    geo: { lat, lon, depthKm: depth },
    magnitude: mag,
    magType: String(p.magType || ''),
    // USGS 的 alert 字段（green/yellow/orange/red）是 PAGER 的损失评估，实测全为 null：不做映射，severity 统一按震级判，避免两个源对同一地震给出不同颜色。
    hypo: { name: place, magnitude: mag },
    regions: [],
    eventKey: geoEventKey(time, lat, lon),
    strength: mag === null ? 0 : mag,
    cancelled: false,
    raw: f,
  }
}

// NOAA tsunami.gov 的事件分级。CAP 的 <severity>（Minor/Moderate/…）对海啸不够具体，真正决定行动的是
// <event> 名称。第三项是**等级**，与日本 552 的 TSUNAMI_RANK（Watch=1/Warning=2/MajorWarning=3）同一把尺，
// 由 matchPointAlert 用 thresholds.tsunamiGrade 做门槛；第四项是颜色。**等级与标签必须同口径**：Advisory /
// Watch 的等级是 2（对应日本的「海啸警報」档，NOAA 的官方定义是"对近水的人有危险"），标签不能写成「注意报」。
// 「Tsunami Information」= 0：语义上低于日本的「津波注意報」，按 1 处理会让它在半径内直接响铃。
// event 名是**受控词表**（CAP 里由发布机构填写），所以**整串锚定**匹配（大小写与多余空格先统一）：子串匹配会把
// "Not a Tsunami Warning" / "Tsunami Warning Cancellation" 抬到最高档 3（误报方向）。未识别的 event 用如实
// 标签落历史，等级仍是 0（不会响铃，但能看出上游加了新 event 名）。
const NOAA_EVENT_RULES = [
  [/^tsunami warning$/, 'kind.noaaMajorWarning', 3, 'red'],
  [/^tsunami advisory$/, 'kind.noaaWarning', 2, 'orange'],
  [/^tsunami watch$/, 'kind.noaaWarning', 2, 'orange'],
  [/^tsunami information( statement)?$/, 'kind.noaaInfo', 0, 'info'],
];

// NOAA tsunami.gov 的 CAP 1.2 电文 → Alert。结构：alert > info > area > circle（"纬度,经度 半径"），
// 震级与震中另有 parameter 备份；msgType=Cancel 是解除，走与日本源相同的取消 / 解除链路。
// xml 是 CAP 原文；entry 是事件列表里的条目（用于给 Alert 一个稳定 id）。
function parseNoaaCap(xml, entry) {
  const text = String(xml || '');
  if (text.indexOf('<alert') === -1) return null
  const identifier = tagText(text, 'identifier');
  if (!identifier) return null
  const msgType = tagText(text, 'msgType');
  const event = tagText(text, 'event');
  const sent = tagText(text, 'sent');
  const capHeadline = tagText(text, 'headline');
  const areaDesc = tagText(text, 'areaDesc');
  // parameter 是成对出现的 valueName / value，可能有多个，逐个收进字典
  const params = {};
  for (const m of text.matchAll(/<parameter>([\s\S]*?)<\/parameter>/g)) {
    const n = tagText(m[1], 'valueName');
    if (n) params[n] = tagText(m[1], 'value');
  }
  // 震中优先取 area 的 circle（"纬,经 半径"），它才是配信覆盖范围，EventLatLon 只是备份。CAP 允许一个
  // info 下**多个 <area>**，各有自己的 circle——全部收集：只看第一个会让其余海域的沿海用户漏报。
  const geoList = [];
  for (const m of text.matchAll(/<circle>([\s\S]*?)<\/circle>/g)) {
    const cm = /^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)/.exec(m[1]);
    if (cm) geoList.push({ lat: Number(cm[1]), lon: Number(cm[2]) });
  }
  if (geoList.length === 0) {
    const em = /^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)/.exec(String(params.EventLatLon || ''));
    if (em) geoList.push({ lat: Number(em[1]), lon: Number(em[2]) });
  }
  const geo = geoList.length ? geoList[0] : { lat: null, lon: null };
  const mag = toNumOrNull(params.EventPreliminaryMagnitude);
  // 认不出时**如实标注**而不是冒充"海啸信息"：等级仍是 0（不会响铃），但历史里能看出上游加了新 event 名。
  const eventNorm = String(event || '').trim().toLowerCase().replace(/\s+/g, ' ');
  const matched = NOAA_EVENT_RULES.find(([re]) => re.test(eventNorm));
  // 匹配到时 rule[1] 是**文案 key**（要取词）；没匹配到时已经是取好词的句子，t() 对不存在的 key 原样回显，
  // 所以下面统一过一遍 t() 是安全的。
  const rule = matched || [null, t('kind.noaaUnrecognized', { event: String(event || '—').slice(0, 40) }), 0, 'info'];
  const ruleLabel = t(rule[1]);
  const cancelled = msgType === 'Cancel';
  const origin = String(params.EventOriginTime || sent || '');
  const eventName = String(params.EventLocationName || areaDesc || '').trim();
  const headline = (capHeadline || event || t('kind.noaaInfo')) + (eventName ? ' · ' + eventName : '') +
    (mag === null ? '' : t('kind.noaaForeshock', { mag: mag }));
  // identifier 形如 PHEB-1-26234000，中间的数字是消息版本号——同一事件的多版要归并成一个键
  const eventKey = 'noaa:' + identifier.replace(/-\d+-/, '-');
  return {
    id: 'noaa:' + (identifier || (entry && entry.id) || eventKey),
    code: 'noaa',
    kind: 'tsunami',
    kindLabel: cancelled ? ruleLabel + t('kind.cancelledSuffix') : ruleLabel,
    source: 'noaa',
    locator: 'point',
    severity: cancelled ? 'info' : rule[3],
    issued: sent || origin,
    headline,
    maxScale: rule[2],
    // 与日本 552 的等级共用同一把尺，供 matchPointAlert 做 tsunamiGrade 门槛
    tsunamiRank: rule[2],
    level: 0,
    geo,
    // 多区域电文的全部圆心（matchPointAlert 对任一点命中即算命中）；geo 保留第一个以兼容旧调用方
    geoList,
    magnitude: mag,
    magType: String(params.EventPreliminaryMagnitudeType || ''),
    hypo: { name: eventName, magnitude: mag },
    regions: [],
    eventKey,
    strength: rule[2],
    cancelled,
    raw: { identifier, msgType, event, sent, areaDesc, params },
  }
}


// 测试场景。全球源的地震不是随时都有，用户没法"等一条"来验证链路——与气象按钮同样的做法：**构造源格式的
// 原文**（EMSC 的 WebSocket 帧、USGS 的 GeoJSON feature、NOAA 的 CAP 电文）再交给真正的解析器与匹配引擎，
// 点一次就验证「解析器 → 坐标匹配 → 通知 → 历史」整条链路，且不发任何网络请求。
const TEST_GEO_SCENARIOS = [
  { key: 'emsc', source: 'emsc' },
  { key: 'usgs', source: 'usgs' },
  { key: 'noaa', source: 'noaa' },
  // 半径是可配的（1–2000km，新建默认 100km），所以这里**不能承诺"一定不命中"**：半径 ≥556km 的用户会真的响铃。
  { key: 'emsc-far', source: 'emsc' },
];

// 纬度偏移 1 度约 111km；夹在 ±89.5 以内，避免极端位置把纬度推到界外
const shiftLat = (lat, deg) => Math.max(-89.5, Math.min(89.5, lat + deg));

function capTestXml(identifier, event, headline, name, lat, lon, mag, stamp) {
  return '<?xml version="1.0" encoding="UTF-8"?>' +
    '<alert xmlns="urn:oasis:names:tc:emergency:cap:1.2">' +
    '<identifier>' + identifier + '</identifier><sender>quakealert-test</sender>' +
    '<sent>' + stamp + '</sent><status>Actual</status><msgType>Alert</msgType>' +
    '<info><category>Geo</category><event>' + event + '</event>' +
    '<severity>Moderate</severity><urgency>Expected</urgency><certainty>Likely</certainty>' +
    '<headline>' + headline + '</headline>' +
    '<parameter><valueName>EventLocationName</valueName><value>' + name + '</value></parameter>' +
    '<parameter><valueName>EventPreliminaryMagnitude</valueName><value>' + mag + '</value></parameter>' +
    '<area><areaDesc>' + name + '</areaDesc><circle>' + lat + ',' + lon + ' 0.0</circle></area>' +
    '</info></alert>'
}

// 按场景构造一条**测试用**的源原文。
// @param place 用户的第一个全球关注点 { name?, lat, lon }；@param nowMs 时间戳（id 里带上它，连点两次不会被
// 消息级去重吞掉）；@param key TEST_GEO_SCENARIOS 里的 key。返回 { source, payload, label, note }。
function buildTestGlobalMessage(place, nowMs, key) {
  const ms = nowMs || Date.now();
  const p = place || {};
  const lat = (typeof p.lat === 'number' && Number.isFinite(p.lat)) ? p.lat : 0;
  const lon = (typeof p.lon === 'number' && Number.isFinite(p.lon)) ? p.lon : 0;
  const name = String(p.name || 'watch point');
  const stamp = new Date(ms).toISOString();
  const scenario = TEST_GEO_SCENARIOS.filter((s) => s.key === key)[0] || TEST_GEO_SCENARIOS[0];

  if (scenario.key === 'usgs') {
    const shifted = shiftLat(lat, 0.7); // 约 78km
    return {
      source: 'usgs',
      payload: {
        type: 'FeatureCollection',
        features: [{
          type: 'Feature',
          id: 'QUAKEALERT-TEST-usgs-' + ms,
          geometry: { type: 'Point', coordinates: [lon, shifted, 25] },
          properties: {
            mag: 5.6, place: name + ' region (test)', time: ms, updated: ms,
            magType: 'mww', tsunami: 0, alert: null, title: 'M 5.6 - QuakeAlert test',
          },
        }],
      },
    }
  }
  if (scenario.key === 'noaa') {
    return {
      source: 'noaa',
      payload: capTestXml('QUAKEALERT-TEST-NOAA-' + ms, 'Tsunami Advisory', 'TEST TSUNAMI ADVISORY',
        name, lat, lon, 7.1, stamp),
    }
  }
  const far = scenario.key === 'emsc-far';
  const shifted = far ? shiftLat(lat, 5) : lat; // 5 度约 555km
  const mag = far ? 7.0 : 6.2;
  return {
    source: 'emsc',
    payload: {
      action: 'update',
      data: {
        type: 'Feature',
        id: 'QUAKEALERT-TEST-' + scenario.key + '-' + ms,
        geometry: { type: 'Point', coordinates: [lon, shifted, 10] },
        properties: {
          source_id: 'test', unid: 'QUAKEALERT-TEST-' + scenario.key + '-' + ms,
          source_catalog: 'QuakeAlert-TEST', auth: 'QuakeAlert',
          time: stamp, lastupdate: stamp,
          flynn_region: name + ' region (test)',
          lat: shifted, lon, depth: 10,
          mag, magtype: 'mw', evtype: 'ke',
        },
      },
    },
  }
}

/** 测试消息 → Alert：按 source 走对应的真实解析器（与线上链路完全同一条代码路径）。 */
function parseTestGlobalMessage(msg) {
  if (!msg) return null
  let alert = null;
  if (msg.source === 'usgs') {
    const json = typeof msg.payload === 'string' ? JSON.parse(msg.payload) : msg.payload;
    const feats = (json && json.features) || [];
    alert = feats.length ? parseUsgsFeature(feats[0]) : null;
  } else if (msg.source === 'noaa') {
    alert = parseNoaaCap(String(msg.payload), { id: 'test-noaa' });
  } else {
    alert = parseEmsc(msg.payload);
  }
  if (!alert) return null
  // 测试消息的事件键必须每次不同，否则第二次点击会被判成"同一场地震的重复发布"而静默（用户会以为按钮坏了）。
  // 生产的事件键按「分钟 + 震中」归并，连点两次必然落在同一分钟；这里换成带毫秒的 id。
  alert.eventKey = 'test:' + alert.id;
  return alert
}

// ============================================================================
// dsh-quake-alert · client/src/05e-cn-parsers.js
//
// 作用：把 Wolfx 转播的中国大陆地震源（`cenc_eew` 预警 / `cenc_eqlist` 速报）解析成内部模型（Alert）。
// 依赖：01-constants（cnTimeToIso）、02-storage（isPlainObject）、05c-global-parsers（severityOfMagnitude、geoEventKey）。
//
// 大陆源没有分区烈度表（中继只给震中坐标 + 震级），所以走 `locator:'point'`，与 EMSC / USGS 同一条
// 匹配路径。实测字段：`cenc_eew` 10 个字段全是 number；`cenc_eqlist` 是 50 条整表（No1…No50 + md5）
// 且**所有字段都是字符串**。两源的 EventID 格式互不相干 → 归并只能靠「发震时刻 + 震中」（geoEventKey）。
//
// 取值域事实：`MaxIntensity`（EEW，实测连续小数 5.8）与 `intensity`（速报，实测整数 3…8）都是
// 中国地震烈度（GB/T 17742-2020），是震中附近的最大值、不是用户所在地的烈度——两条链路写进 Alert
// 的同一个 `intensity` 字段但**取值域不同**，下游若要按它分档必须先分裂字段名。
//
// 大陆源**没有取消 / 最终报标志**，cancelled 恒为 false，代码里不得假装能处理。
// ============================================================================


/** 字符串或数字 → 有限数值；空串 / 垃圾值 / 缺失一律 null。
 *  不能用 `Number('')`——它等于 0，会把"没有震级"变成"震级 0"并放行一个不知道多大的事件。 */
function numOrNull(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null
  const s = String(v === undefined || v === null ? '' : v).trim();
  if (!s) return null
  const n = Number(s);
  return Number.isFinite(n) ? n : null
}

/** 人名可读的震级文案：未知时给 M—，绝不显示 "Mnull"。 */
function magText(mag) {
  return 'M' + (mag === null ? '—' : mag)
}

/** 震中名 + 深度 的公共 headline 片段。 */
function placeText(name, depthKm) {
  return (name ? ' · ' + name : '') + (depthKm === null ? '' : t('kind.cencDepth', { depth: Math.round(depthKm) }))
}

/**
 * 大陆地震预警（`cenc_eew`）→ Alert。WS 推送包（含 `type`）与 REST 快照（无 type）都接受。
 * @returns {object|null} 结构不对时返回 null（由契约层的 schema 判据负责分类）
 */
function parseCencEew(raw) {
  if (!isPlainObject(raw)) return null
  const id = String(raw.ID === undefined || raw.ID === null ? '' : raw.ID).trim();
  if (!id) return null
  const lat = numOrNull(raw.Latitude);
  const lon = numOrNull(raw.Longitude);
  if (lat === null || lon === null) return null
  const mag = numOrNull(raw.Magnitude);
  const depth = numOrNull(raw.Depth);
  const place = String(raw.HypoCenter === undefined || raw.HypoCenter === null ? '' : raw.HypoCenter).trim();
  // OriginTime 是发震时刻，ReportTime 是发布时刻（实测两者相同，是上游的填充习惯，不能据此判定
  // 它"不是实时预警"）。事件键用 OriginTime（与其它源同一口径）。
  const originIso = cnTimeToIso(raw.OriginTime);
  const reportIso = cnTimeToIso(raw.ReportTime);
  const reportNum = numOrNull(raw.ReportNum);
  const headline = magText(mag) + placeText(place, depth) +
    (reportNum !== null && reportNum > 1 ? t('kind.cencReportNo', { n: reportNum }) : '');
  return {
    // id 前缀 cenc: ——与速报的 EventID 是两套命名空间
    id: 'cenc:' + id,
    code: 'cenc_eew',
    kind: 'eew',
    kindLabel: t('kind.cencEew'),
    source: 'cenc_eew',
    // 无分区烈度 → 坐标 + 半径匹配；震级门槛共用 thresholds.globalMagnitude（与预警同档）
    locator: 'point',
    speedReport: false,
    // **恒 red，与日本 556 同口径**（EEW 本质是警报）。severity 决定配色与**静默时段能否穿透**
    // （只有 red 穿透）：按震级分档会让 M4.2 的预警在夜间被静默掉，那是漏报方向。
    severity: 'red',
    issued: originIso,
    reportTime: reportIso,
    headline,
    maxScale: -1,
    level: 0,
    geo: { lat, lon, depthKm: depth },
    magnitude: mag,
    magType: '',
    hypo: { name: place, magnitude: mag },
    regions: [],
    eventKey: geoEventKey(originIso, lat, lon),
    strength: mag === null ? 0 : mag,
    // 中国地震烈度（震中附近最大值，只入库、不上 UI）。**取值域**：EEW 的 `MaxIntensity` 是连续
    // 小数（5.8），与速报那条整数档共用同一个字段名——下游若要按它分档，先分裂字段（见文件头）。
    intensity: numOrNull(raw.MaxIntensity),
    reportNum,
    cancelled: false, // 大陆源不提供取消 / 最终报标志，不得假装能处理
    raw,
  }
}

/** 速报整表里的单项（`NoN`）→ Alert。所有字段都是字符串（实测）；地名取 placeName 优先。 */
function parseCencEqlistItem(item) {
  if (!isPlainObject(item)) return null
  const eventId = String(item.EventID === undefined || item.EventID === null ? '' : item.EventID).trim();
  if (!eventId) return null
  const lat = numOrNull(item.latitude);
  const lon = numOrNull(item.longitude);
  if (lat === null || lon === null) return null
  const mag = numOrNull(item.magnitude);
  const depth = numOrNull(item.depth);
  const place = String(
    (item.placeName === undefined || item.placeName === null ? '' : item.placeName) ||
    (item.location === undefined || item.location === null ? '' : item.location)
  ).trim();
  // time 是发震时刻，ReportTime 是发布时刻。实测 lag 209–1643 秒。
  const originIso = cnTimeToIso(item.time);
  const reportIso = cnTimeToIso(item.ReportTime);
  const headline = magText(mag) + placeText(place, depth);
  return {
    id: 'cenc:' + eventId,
    code: 'cenc_eqlist',
    kind: 'quake',
    kindLabel: t('kind.cencEqlist'),
    source: 'cenc_eqlist',
    locator: 'point',
    // 速报不是预警：用**独立**的震级门槛（thresholds.cnReportMagnitude），否则会被小震频繁打扰。
    speedReport: true,
    severity: severityOfMagnitude(mag),
    issued: originIso,
    reportTime: reportIso,
    headline,
    maxScale: -1,
    level: 0,
    geo: { lat, lon, depthKm: depth },
    magnitude: mag,
    magType: '',
    hypo: { name: place, magnitude: mag },
    regions: [],
    eventKey: geoEventKey(originIso, lat, lon),
    strength: mag === null ? 0 : mag,
    // 中国地震烈度（整数档，只入库、不上 UI）：与上面 EEW 那条**同名不同域**（速报 3…8 整数）。
    intensity: numOrNull(item.intensity),
    // 实测全是 "reviewed"。不认识的取值**不丢弃**——它仍是同一场真实地震，原样带上供诊断。
    reportType: String(item.type === undefined || item.type === null ? '' : item.type).trim(),
    cancelled: false,
    raw: item,
  }
}

/**
 * 速报整表 → 按 `No1…NoN` **数值序**（不是字典序，否则 No10 会排到 No2 前面）；实测 No1 最新。
 * 非 `NoN` 键（type / md5）原样跳过。
 * @returns {object[]} 原始条目（未解析），供逐条过契约
 */
function cencEqlistItems(json) {
  if (!isPlainObject(json)) return []
  const keys = Object.keys(json)
    .map((k) => { const m = /^No(\d+)$/.exec(k); return m ? { k, n: Number(m[1]) } : null })
    .filter(Boolean)
    .sort((a, b) => a.n - b.n);
  return keys.map((e) => json[e.k]).filter(isPlainObject)
}

/** 速报整表的变更指纹。实测存在；缺失时返回空串（**不**据此判 schema）。 */
function cencEqlistMd5Of(json) {
  if (!isPlainObject(json)) return ''
  const v = json.md5;
  return typeof v === 'string' ? v.trim() : ''
}

/** 速报整表 → Alert[]（逐条解析，坏条目跳过而不是整表作废）。 */
function parseCencEqlist(json) {
  return cencEqlistItems(json).map(parseCencEqlistItem).filter(Boolean)
}

// ============================================================================
// dsh-quake-alert · client/src/05f-nmc-parsers.js
//
// 作用：把 Host 转来的 nmc.cn 预警（JSON）解析成内部模型（Alert）——暴雨与地质灾害预警信号。
// 依赖：02-storage（isPlainObject / own）、00-i18n（t）、04-city-table（cnAreaOf）。
//
// 三处结构性差异：① 匹配走**行政区层级**（locator:'area'）：把机构名解析成「省 + 市」再与用户
// 关注的市比对，不用半径（"选丽江市 + 100km"会漏掉辖下较远的县）。② 机构名每条都以省名开头，
// 自带完整层级链 → 不需要县表，由 cnAreaOf 在「省 + 市」这一层做最长匹配。
// ③ 等级与灾种**只认 `pic` 图标编码**（Host 已解成 kind / level），不做中文匹配。
//
// 已知缺口：**没有"解除"电文**（列表是当前生效集合，过期即消失，cancelled 恒为 false）；机构名
// 可能带错字（市名对不上时按省级兜底放行，而不是丢弃这条预警）。
// ============================================================================


/** 灾种标识 → 中文（与 Host 的 NMC_KINDS 值域对齐）。 */
const NMC_KIND_TEXT = { rainstorm: 'kind.cnRainstorm', geology: 'kind.cnGeology' };
/** 等级 → 中文（与图标编码 `001`..`004` 的对应关系见 lib/nmc-source.js）。 */
const NMC_LEVEL_TEXT = { red: 'kind.cnLevelRed', orange: 'kind.cnLevelOrange', yellow: 'kind.cnLevelYellow', blue: 'kind.cnLevelBlue' };
/** 等级 → severity。**忠实映射，不拔高**：四色本身就是官方等级；后果是静默时段（只放行 red）
 *  **不会**放行橙色预警。 */
const NMC_LEVEL_SEVERITY = { red: 'red', orange: 'orange', yellow: 'yellow', blue: 'info' };
/** 等级序（越大越重），与 Host 的 NMC_LEVEL_RANK 一致；播报门槛为橙色及以上，低于它的条目仍然
 *  解析，但不进历史、不打扰。 */
const NMC_LEVEL_RANK = { red: 4, orange: 3, yellow: 2, blue: 1 };
const NMC_BROADCAST_MIN_RANK = 3;

/** 从 `title` 里取出发布机构名（`…气象台发布…`）；认不出返回空串，届时由契约层判 schema。
 *  @param {unknown} title */
function orgOf(title) {
  const m = /^(.*?(?:气象台|气象局|预警中心))发布/.exec(String(title === undefined || title === null ? '' : title));
  return m ? m[1] : ''
}

/**
 * nmc.cn 预警（Host 的 JSON 载荷）→ Alert。结构不符返回 null（由契约层分类成 schema / empty），
 * 而不是编一个空对象——后者会让"上游改版"在 UI 上长成"这条预警没有内容"。
 * @param {object} raw `{ alertid, title, issued, kind, level, detail }`
 * @returns {object|null}
 */
function parseNmcAlarm(raw) {
  if (!isPlainObject(raw)) return null
  const alertid = String(raw.alertid === undefined || raw.alertid === null ? '' : raw.alertid).trim();
  if (!alertid) return null
  const kind = typeof raw.kind === 'string' && own(NMC_KIND_TEXT, raw.kind) ? raw.kind : '';
  if (!kind) return null
  const level = typeof raw.level === 'string' && own(NMC_LEVEL_TEXT, raw.level) ? raw.level : '';
  if (!level) return null
  const issued = String(raw.issued === undefined || raw.issued === null ? '' : raw.issued).trim();
  const title = String(raw.title === undefined || raw.title === null ? '' : raw.title).trim();
  const detail = String(raw.detail === undefined || raw.detail === null ? '' : raw.detail).trim();
  const org = orgOf(title);
  const area = org ? cnAreaOf(org) : null;
  // 机构名去掉表示发布主体的后缀即"发布地"：「云南省丽江市宁蒗彝族自治县气象台」→ 该县。
  const place = org.replace(/(?:气象台|气象局|预警中心)$/, '');
  // 查表一律走 own()：外部数据当键时，直查会让 'constructor' 这类键命中原型链返回函数对象，值域
  // 就更没保证。契约层（05d）用的是同一个约定。
  const rank = own(NMC_LEVEL_RANK, level) || 0;
  // 灾种名与等级词都是**我们给起的**（电文原文只有编码）→ 按界面语言取词，表里存的是 i18n key。
  const kindKey = own(NMC_KIND_TEXT, kind);
  const levelKey = own(NMC_LEVEL_TEXT, level);
  const kindText = kindKey ? t(kindKey) : '';
  const levelText = levelKey ? t(levelKey) : '';
  return {
    // 前缀 nmc: ——与其它源的 id 命名空间分开（alertid 是纯数字串，不加前缀会与 P2PQuake 撞车）。
    id: 'nmc:' + alertid,
    code: 'nmc_alarm',
    // kind 复用 'weather'：与日本气象电文共用整条链路；真正区分两者的是 locator（'area'）。
    kind: 'weather',
    kindLabel: t('kind.cnLabel', { kind: kindText, level: levelText }),
    source: 'nmc_alarm',
    locator: 'area',
    severity: own(NMC_LEVEL_SEVERITY, level),
    issued,
    reportTime: issued,
    // 文案用**发布地 + 灾种 + 等级**，不用行政区表里的名字（那是 GeoNames 显示名，实测会挑到旧名
    // 「思茅市」而气象台写「普洱市」，照搬会让用户对不上号）。
    headline: t('kind.cnHeadline', { place: (place ? place + ' · ' : ''), kind: kindText, level: levelText }),
    maxScale: -1,
    level: 0,
    // regions 是日本源的概念，大陆源不用它——归属放在 cnArea 里，留空数组是为了不让 06-matcher 的
    // "未携带可判定区域"分支（只看 regions）误伤。
    regions: [],
    // 事件键取 alertid：它每条唯一，升级（黄→橙）会换新的 alertid——那正是应该再响一次的情形，
    // 所以不做"同机构同灾种归并"（那会把升级吞掉）。
    eventKey: 'nmc:' + alertid,
    strength: rank,
    // 行政区归属：city 为空 = 只能定位到省（省直辖县 / 省台发布），由 matcher 走省级兜底。
    cnArea: {
      org,
      province: area ? area.province : '',
      city: area ? area.city : '',
      resolved: !!(area && area.matched),
    },
    cnKind: kind,
    cnLevel: level,
    cnRank: rank,
    detail,
    cancelled: false, // 列表里没有"解除"这种形态，不得假装能处理
    raw,
  }
}

// ============================================================================
// dsh-quake-alert · client/src/05h-overseas-parsers.js
//
// 作用：把**海外气象源**（美国 NWS、加拿大 ECCC）的预警解析成内部模型（Alert）。
// 内容：`nws_alerts`——NWS 的洪水类预警（8 种 event）；`eccc_alerts`——ECCC 的降雨 / 洪水 / 风暴潮 warning。
// 依赖：02-storage（isPlainObject / own）、00-i18n（t）。
//
// 与其它源的结构性差异：
// ① **`locator: 'overseas'`**：取数器是**按关注点查询**的（NWS 用 `?point=`、ECCC 用 `?bbox=`），
//    "这条预警属于哪个关注点"在取数时已确定，由取数器通过 opts.place 传进来（记成 alert.originPlace），
//    匹配层因此不做距离计算——与全球地震源（`locator:'point'`）是两种形态。
// ② **NWS 的播报门槛按 `event` 名，不按 severity**：实测 `Flood Watch` 的 severity 也是 `Severe`，
//    区分不了"警告"与"警戒"；而 event 名本身有层级，所以门槛取 `Warning` 结尾（见白名单的 rank）。
// ③ **ECCC 只接 `alert_type === 'warning'`**：advisory 按 ECCC 的定义是「generally not considered
//    hazardous」（实测 116 条里 114 条是 frost advisory）。
// ④ **ECCC 的白名单按 `alert_name_en` 关键词，不按 CAP 的 `<event>`**：CAP XML 归档里法语办公室的
//    `<event>` 是法语，而 OGC API 通道（我们走的这条）给的是固定英文名，没有语言变体问题；API 里也
//    没有 CAP 的 eventCode（只有三字母 `alert_code`，其码表无官方枚举）。降雨类当前季节**没有样本**，
//    这份白名单**未被证实** → 白名单外的新类型判 `empty`（向前兼容）。
// ⑤ **事件键按"事件链"取，不是按消息取**：NWS 的 CAP identifier 在 Update / Cancel 时会换一条新的
//    → 键落在 **VTEC 的事件追踪号**上（见 nwsEventKeyOf）；ECCC 没有稳定的 alert id → 事件键 =
//    码 + 区域 + **发布日**：同一天内的更新同键，跨天的新过程换键。
//
// 两条共同的已知缺口：**ECCC 没有可靠的"解除"表达**（`status_en` 的 ended 连刚发布的霜冻都有，
// 含义未证实，所以 cancelled 恒为 false；NWS 有 CAP 的 Cancel 可用）；**上游停更看不见**（按点 /
// 框查询的空响应是常态，`staleAfterMs` 只能 null）。
// ============================================================================


/** NWS 的 `event` → 内部灾种与播报档位。白名单是**精确匹配**。 */
const NWS_EVENT_WHITELIST = {
  'Flood Warning': { kind: 'flood', text: 'kind.nwsFlood', rank: 3 },
  'Flash Flood Warning': { kind: 'flashFlood', text: 'kind.nwsFlashFlood', rank: 3 },
  'Coastal Flood Warning': { kind: 'coastalFlood', text: 'kind.nwsCoastalFlood', rank: 3 },
  'Flood Watch': { kind: 'flood', text: 'kind.nwsFloodWatch', rank: 1 },
  'Flood Advisory': { kind: 'flood', text: 'kind.nwsFloodAdvisory', rank: 1 },
  'Coastal Flood Watch': { kind: 'coastalFlood', text: 'kind.nwsCoastalWatch', rank: 1 },
  'Coastal Flood Advisory': { kind: 'coastalFlood', text: 'kind.nwsCoastalAdvisory', rank: 1 },
  'Coastal Flood Statement': { kind: 'coastalFlood', text: 'kind.nwsCoastalStatement', rank: 1 },
};
/** NWS 的 severity → 配色（忠实映射，不拔高）。 */
const NWS_SEVERITY = { Extreme: 'red', Severe: 'orange', Moderate: 'yellow', Minor: 'info' };
/** NWS 的 severity → 强度序（用于"同一事件的后续发布是否升级"）。 */
const NWS_SEV_RANK = { Extreme: 4, Severe: 3, Moderate: 2, Minor: 1 };

/** ECCC 的 `risk_colour_en` → 配色（三色与 nmc 的四色同源，可直接对应）。 */
const ECCC_COLOUR_SEVERITY = { red: 'red', orange: 'orange', yellow: 'yellow' };
/** ECCC 的三色 → 强度序。**没有 info 档**：只有 warning 进来，黄色 warning 按 ECCC 的定义已经
 *  属于 hazardous。 */
const ECCC_COLOUR_RANK = { red: 4, orange: 3, yellow: 2 };

/** ECCC 的灾种白名单：**先看排除名单，再看包含名单**。 */
const ECCC_EXCLUDE = /frost|fog|freez|snow|blizzard|ice\b|icing|wind|gale|heat|cold|thunderstorm|tornado|hurricane|tropical|air quality|humidex|visibility/i;
const ECCC_INCLUDE = /rain|flood|surge|hydrolog|water|precipitation/i;

/** ECCC 的英文名 → 中文灾种标签。**按名称关键词映射，不查三字母码表**——`alert_code` 没有官方
 *  枚举，猜码踩过坑（把 `CFW` 当成洪水，实际是 storm surge warning）。 */
function ecccKindTextOf(nameEn) {
  const s = String(nameEn || '');
  if (/storm surge|surge/i.test(s)) return t('kind.caStormSurge')
  if (/flash flood/i.test(s)) return t('kind.caFlashFlood')
  if (/flood/i.test(s)) return t('kind.caFlood')
  if (/rain|precipitation/i.test(s)) return t('kind.caRain')
  if (/hydrolog|water/i.test(s)) return t('kind.caHydrology')
  return t('kind.caWeather')
}

/** 播报门槛（两个源共用）：`overseasRank >= 3` 才打扰用户；未达档位的也不进历史。 */
const OVERSEAS_BROADCAST_MIN_RANK = 3;

/** NWS 的 event → **当前界面语言**的灾种名（供 UI / 测试使用）。**必须是函数**：写成模块级常量会在
 *  加载时求值，把语言冻在那一刻（切语言后不跟着变）。 */
function nwsKindTextOf(ev) {
  const rule = own(NWS_EVENT_WHITELIST, String(ev || ''));
  return rule ? t(rule.text) : ''
}
/** 整张表（按当前语言求值）。 */
const nwsKindTextMap = () => Object.fromEntries(
  Object.entries(NWS_EVENT_WHITELIST).map(([ev, v]) => [ev, t(v.text)]),
);

/**
 * NWS 的 **VTEC 事件追踪键**：`<office>.<phenom>.<significance>.<ETN>`。VTEC 段位是
 * `/O.<ACTION>.<OFFICE>.<PHENOM>.<SIG>.<ETN>.<BEGIN>-<END>/`；**ACTION 之外的四段跨版本稳定**
 * （同一次洪水从 `NEW` → `EXT` → `CON` → `CAN` 只改 ACTION），所以键必须剔除 ACTION。
 *
 * @param {unknown} vtecList `properties.parameters.VTEC`（字符串数组）
 * @returns {string} 解析不出来时返回 ''（调用方退到兜底）
 */
function nwsVtecKeyOf(vtecList) {
  if (!Array.isArray(vtecList)) return ''
  for (const raw of vtecList) {
    // 不在行首锚定：实测存在一条字符串里带多段 VTEC 的产品，取第一段即可。
    // ETN 段放宽到 `\d{4,6}`：NWS 规范写 4 位，但实测出现过 5 位（`/O.NEW.KRLX.FA.W.01370.…/`），
    // 写死 4 位会让整段失配，调用方就退回 references 兜底（每次 Update 各得一键 → 重复响铃）。
    // 放宽是上界，不会把两个不同事件并成一个（ETN 仍要求 ≥4 位数字）。
    const m = /\/O\.[A-Z]{3}\.([A-Z0-9]{4})\.([A-Z]{2})\.([A-Z])\.(\d{4,6})\./.exec(String(raw || ''));
    if (m) return m[1] + '.' + m[2] + '.' + m[3] + '.' + m[4]
  }
  return ''
}

/**
 * NWS 的事件键。**首选 VTEC 的事件追踪号**。
 *
 * 不能用 CAP 的 `references`：它指向**被本条取代的那条消息**，而 NWS 实测是**逐版串联**的链
 * （每条只引用紧邻的上一版），"取 sent 最早的一条"**只能回溯一步**，算出的键每版都不同 → 同一场
 * 洪水随每次 Update 重复响铃。兜底顺序（**都不判 schema**）：① VTEC 追踪号；② references 里
 * `sent` 最早的一条（保留给没有 VTEC 的海事 / 特殊电文）；③ 自身 identifier。后两者去掉末尾版本段。
 */
function nwsEventKeyOf(id, references, vtecList) {
  const vtec = nwsVtecKeyOf(vtecList);
  if (vtec) return 'nws:' + vtec
  const refs = Array.isArray(references) ? references : [];
  let best = null;
  for (const r of refs) {
    if (!r || typeof r.identifier !== 'string' || !r.identifier) continue
    // 局部变量不叫 `t`（那是 00-i18n 的取词函数）
    const sentMs = Number.isFinite(Date.parse(r.sent)) ? Date.parse(r.sent) : Number.POSITIVE_INFINITY;
    if (!best || sentMs < best.sentMs || (sentMs === best.sentMs && String(r.identifier) < String(best.id))) {
      best = { sentMs, id: r.identifier };
    }
  }
  const base = best ? best.id : id;
  return 'nws:' + String(base).replace(/\.[0-9]+$/, '')
}

/** ECCC 的事件键：码 + 区域 + 发布日（同一天内的更新同键）。 */
function ecccEventKeyOf(code, areaKey, published) {
  const day = String(published).slice(0, 10);
  return 'eccc:' + code + ':' + areaKey + ':' + day
}

/**
 * NWS 的预警体（一条 GeoJSON feature）→ Alert。
 * @param {{ place?: object }} [opts] `place` 是取数器查这条时用的关注点（记成 originPlace）
 * @returns {object|null} 结构不符或不在白名单时返回 null（由契约层分类成 schema / empty）
 */
function parseNwsAlert(feature, opts) {
  if (!isPlainObject(feature)) return null
  const p = feature.properties;
  if (!isPlainObject(p)) return null
  const event = typeof p.event === 'string' ? p.event : '';
  const rule = own(NWS_EVENT_WHITELIST, event);
  if (!rule) return null
  // id 优先取 properties.id（CAP identifier），缺了才退回外层 id；两者都缺就设法去重，判 null。
  const rawId = String(p.id || feature.id || '').trim();
  if (!rawId) return null
  // GeoJSON 外层的 `feature.id` 是**完整 URL**（`https://api.weather.gov/alerts/urn:oid:…`），抽出
  // `urn:oid:` 段再用：否则事件键带着 URL 前缀，末尾版本段的归并与取消消息的匹配都会失效。
  const idMatch = /(urn:oid:[\s\S]+)$/.exec(rawId);
  const id = idMatch ? idMatch[1] : rawId;
  const sent = typeof p.sent === 'string' ? p.sent : '';
  if (!sent || !Number.isFinite(Date.parse(sent))) return null
  const sev = typeof p.severity === 'string' && own(NWS_SEVERITY, p.severity) ? p.severity : '';
  const areaDesc = String(p.areaDesc || '').trim();
  const headline = String(p.headline || '').trim();
  // 正文原样保留：改写官方正文对任何源都不合适，而 instruction 是"该怎么做"——截断它才危险。
  const description = String(p.description || '').trim();
  const instruction = String(p.instruction || '').trim();
  const detail = [description, instruction].filter(Boolean).join('\n\n');
  const place = opts && isPlainObject(opts.place) ? opts.place : null;
  const vtecList = isPlainObject(p.parameters) ? own(p.parameters, 'VTEC') : null;
  const vtecKey = nwsVtecKeyOf(vtecList);
  return {
    id: 'nws:' + id,
    code: 'nws_alerts',
    // kind 复用 'weather'：与日本气象电文 / 大陆气象预警共用整条链路；真正区分三者的是 locator。
    kind: 'weather',
    kindLabel: t('kind.usHazard', { hazard: t(rule.text) }) + '（' + (String(p.senderName || '').trim() || 'NWS') + '）',
    source: 'nws_alerts',
    locator: 'overseas',
    severity: sev ? own(NWS_SEVERITY, sev) : 'info',
    issued: sent,
    reportTime: sent,
    headline: headline || (rule.text + (areaDesc ? ' · ' + areaDesc : '')),
    maxScale: -1,
    level: 0,
    regions: [],
    eventKey: nwsEventKeyOf(id, p.references, vtecList),
    strength: (sev && own(NWS_SEV_RANK, sev)) || 0,
    // 海外源特有：这条预警属于哪个关注点（取数时确定）。
    originPlace: place,
    overseas: {
      country: 'us',
      event,
      // NWS 的 eventCode 是对象（`{SAME:['FLW'],…}`），**不能当白名单键**（Flood Warning 的 SAME
      // 实测给的是 FLS）。这里只留一份供诊断。
      eventCode: isPlainObject(p.eventCode) ? p.eventCode : null,
      areaDesc,
      messageType: String(p.messageType || ''),
      senderName: String(p.senderName || ''),
      ends: String(p.ends || p.expires || ''),
      ugc: isPlainObject(p.geocode) && Array.isArray(p.geocode.UGC) ? p.geocode.UGC : [],
      // 事件键的来源（供诊断核对"这条属于哪一次事件"）。
      vtecKey,
    },
    // 播报档位：Warning 类 = 3，Watch / Advisory / Statement = 1（见文件头 ②）。
    overseasRank: rule.rank,
    nwsEvent: event,
    detail,
    // NWS 有真正的取消语义（CAP messageType）。
    cancelled: String(p.messageType || '') === 'Cancel',
    raw: feature,
  }
}

/**
 * ECCC 的预警体（一条 GeoJSON feature）→ Alert。
 * @param {{ place?: object }} [opts]
 * @returns {object|null} 结构不符 / 不是 warning / 不在白名单时返回 null
 */
function parseEcccAlert(feature, opts) {
  if (!isPlainObject(feature)) return null
  const p = feature.properties;
  if (!isPlainObject(p)) return null
  const alertType = typeof p.alert_type === 'string' ? p.alert_type : '';
  if (alertType !== 'warning') return null
  const code = typeof p.alert_code === 'string' ? p.alert_code.trim() : '';
  const nameEn = typeof p.alert_name_en === 'string' ? p.alert_name_en.trim() : '';
  // 白名单：先排除、再包含——顺序写死能避免将来加词时互相打架（"storm surge warning" 两边都不冲突）。
  if (!nameEn || ECCC_EXCLUDE.test(nameEn) || !ECCC_INCLUDE.test(nameEn)) return null
  if (!code) return null
  const published = typeof p.publication_datetime === 'string' ? p.publication_datetime : '';
  if (!published || !Number.isFinite(Date.parse(published))) return null
  const colour = typeof p.risk_colour_en === 'string' ? p.risk_colour_en.toLowerCase() : '';
  if (!own(ECCC_COLOUR_SEVERITY, colour)) return null
  const area = String(p.feature_name_en || '').trim();
  const text = String(p.alert_text_en || '').trim();
  const province = String(p.province || '').trim();
  const place = opts && isPlainObject(opts.place) ? opts.place : null;
  const textZh = ecccKindTextOf(nameEn);
  // 区域键：feature_id 优先（稳定），缺了退回区域名。
  const areaKey = String(p.feature_id || area || province || 'unknown');
  // 署名是 ECCC 许可（End-use Licence v2.1.1）的硬要求，正文**不得改写**——所以正文原样保留，
  // 署名作为末行一起进历史与通知。
  const ATTRIBUTION = 'Data Source: Environment and Climate Change Canada';
  return {
    id: 'eccc:' + code + ':' + areaKey + ':' + published,
    code: 'eccc_alerts',
    kind: 'weather',
    kindLabel: t('kind.caHazard', { hazard: textZh }) + '（ECCC）',
    source: 'eccc_alerts',
    locator: 'overseas',
    severity: own(ECCC_COLOUR_SEVERITY, colour),
    issued: published,
    reportTime: published,
    headline: textZh + (area ? ' · ' + area : '') + (province ? '（' + province + '）' : ''),
    maxScale: -1,
    level: 0,
    regions: [],
    eventKey: ecccEventKeyOf(code, areaKey, published),
    strength: own(ECCC_COLOUR_RANK, colour) || 0,
    originPlace: place,
    overseas: {
      country: 'ca',
      alertCode: code,
      nameEn,
      colour,
      province,
      area,
      statusEn: String(p.status_en || ''),
      confidence: String(p.confidence_en || ''),
      impact: String(p.impact_en || ''),
      expiry: String(p.expiration_datetime || ''),
      validity: String(p.validity_datetime || ''),
      attribution: ATTRIBUTION,
    },
    overseasRank: 3,
    ecccCode: code,
    detail: text ? text + '\n\n' + ATTRIBUTION : ATTRIBUTION,
    // ECCC 的 `status_en` 实测有 ended / continued，但一条刚发布的霜冻也是 `ended`——含义未证实，
    // 所以**不据此判取消**，宁可多说一次。
    cancelled: false,
    raw: feature,
  }
}

// ============================================================================
// dsh-quake-alert · client/src/05d-source-contracts.js
//
// 作用：**解析契约**与**每源校验约定**——统一返回形态 + 每源的 schema / stale / empty 判据。
// 依赖：01-constants、02-storage、05/05b/05c（各源的解析器）、07-store（状态上报）。
// 健康记录（存 / 升级阈值 / 自愈）在 05g-source-health.js，自检调度在 12d-health-probe.js。
//
// 三类失败：empty 源正常但无相关数据（不计失败）；schema 结构不符；value 值客观不可能。
// 后两类计入健康状态并停止播报该源。解析层严格，匹配层宽松。
// ============================================================================


/** 解析成功。 */
const okResult = (alert) => ({ ok: true, alert });
/** 解析失败 / 无关。kind ∈ 'empty' | 'schema' | 'value'。 */
const failResult = (kind, detail) => ({ ok: false, kind, detail: String(detail || '') });

const numOf = (v) => {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null
  const s = String(v === undefined || v === null ? '' : v).trim();
  if (!s) return null
  const n = Number(s);
  return Number.isFinite(n) ? n : null
};
const timeMsOf = (v) => {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null
  const t = Date.parse(String(v === undefined || v === null ? '' : v));
  return Number.isFinite(t) ? t : null
};
/** 时间戳是否客观不可能：1970 年以前、或 100 年以后。
 *  缺失 / 不可解析不算"不可能"——存在性由各源的 schema 判据负责。 */
const timeIsImpossible = (ms, now) => {
  if (typeof ms !== 'number' || !Number.isFinite(ms)) return false
  return ms < 0 || ms > (Date.now()) + 100 * 365 * 24 * 3600 * 1000
};

/**
 * 每源校验约定。字段含义：
 *   required    —— 必需字段与类型（schema 判据）。缺一个即判 schema，不猜、不兜底。
 *   timezone    —— 源时区。解析器把时间转成带偏移的 ISO 8601。
 *   staleAfterMs—— 新鲜度阈值（stale 判据）；null = 不适用，理由在 staleReason。
 *   empty       —— 什么形态算"源正常但当前无数据"（不计失败）。
 *   tolerant    —— 明确**不判 schema** 的字段范围；与 required 互补，required 只列实现真会拦下的字段。
 *   pollMs      —— 传输层的轮询 / 推送周期。
 */
const SOURCE_CONTRACTS = {
  p2pquake: {
    label: 'P2PQuake',
    region: 'jp',
    disasters: ['quake', 'eew', 'tsunami'],
    transport: 'ws',
    url: 'wss://api.p2pquake.net/v2/ws',
    pollMs: null,
    timezone: 'Asia/Tokyo（+09:00）—— issue.time / earthquake.time / areas[].arrivalTime 都是裸 JST，由 p2pTimeToIso 补偏移',
    required: [
      'code：必须是 551 / 552 / 556 之一（其它 code 判 empty，不算故障）',
      '每条都要：id（或 _id）string、issue.time string',
      '551：earthquake 是对象、earthquake.maxScale 是 number、points 是数组，且 points[] 每一项是对象；' +
      'scale / pref / addr **只在存在时**要求类型正确（0.4.2 起有意放宽：单个观测点缺字段' +
      '不该让整条警报消失，预警产品里丢整条的代价是漏报）',
      '552：areas 是数组、每项是对象，grade **只在存在时**要求是字符串——**不查枚举**：' +
      '未知等级按 rank 0 处理、正文照原样显示（与解析器 areas.map 里的 `|| "—"` 一致）',
      '556：earthquake 与 earthquake.hypocenter 是对象、areas 是数组且每项必须有非空 name；' +
      'scaleTo **只在存在时**要求是 number',
      '时间是"客观不可能"检查（越界判 value），**缺 earthquake.time 不判 schema**：' +
      '它只喂事件归并键（`quake:` + eq.time），缺了就退化成不做事件级去重，警报本身照发',
    ],
    empty: 'code 不是 551/552/556（P2PQuake 还会推火山、其他情报等与本插件无关的消息）',
    staleAfterMs: null,
    staleReason: '推送源没有"数据新鲜度"概念：日本可能数小时没有有感地震。活性由连接层负责' +
      '（建连超时监控 15 秒 + 连接假死检测 20 分钟，见 12-websocket）。',
  },
  jma: {
    label: '気象庁 防災情報XML',
    region: 'jp',
    disasters: ['weather'],
    transport: 'feed',
    url: 'https://www.data.jma.go.jp/developer/xml/feed/extra.xml',
    pollMs: 60 * 1000,
    timezone: 'Asia/Tokyo（+09:00）—— Head/ReportDateTime 带 +09:00；Control/DateTime 是 UTC（Z）。' +
      '两者都带偏移，解析器优先取 ReportDateTime',
    required: [
      '电文非空',
      '不是 HTML（返回 `<!DOCTYPE html>` / `<html` 判 schema：拦截页或地址失效最常见）',
      '<Report> 根元素（防災情報XML 的标志）',
    ],
    tolerant: '电文结构本身（Item / Kind、Area / Name / Code、ReportDateTime、Control/Title）' +
      '**不作 schema 判据**：缺 Items、缺 Area、只有注意報或"なし"的电文一律归 empty，' +
      '由匹配层的 cannotJudge 决定要不要留痕。',
    empty: '警戒レベル 0 且不是解除的电文：天气预报、府県気象情報、火山、观测资料，以及"只有注意報 /' +
      ' なし"的警报电文（L1〜L2 按设计既不播报也不进历史，所以归入 empty 而不是失败）',
    staleAfterMs: 3 * 60 * 60 * 1000,
    staleReason: 'feed 每分钟更新（掲載直近の入電）。但"我们没有相关电文"是常态（只有天气预报时也正常），' +
      '所以阈值不查"我们收到多少条"，只查 feed 自身的最新 <updated>：超过 3 小时说明上游停更。',
  },
  emsc: {
    label: 'EMSC',
    region: 'global',
    disasters: ['quake'],
    transport: 'ws',
    url: 'wss://www.seismicportal.eu/standing_order/websocket',
    pollMs: null,
    timezone: 'UTC（properties.time 形如 2026-09-12T02:15:12.43Z，自带偏移，无需转换）',
    required: [
      '顶层 { action, data }（data 是 GeoJSON Feature，不是 FeatureCollection）',
      'data.properties object：mag number、time string',
      'data.properties.lat/lon number，或 data.geometry.coordinates[0..1]',
    ],
    tolerant: 'properties.flynn_region（地名）缺失**不判 schema**：解析器用 String(p.flynn_region||\'\') ' +
      '取空串，正文退化成没有地名的形态而不是丢整条。required 只列实现真的会拦下的字段（0.5.1 定）。',
    empty: 'action === "delete"（事件被撤回），或 properties.evtype 不是 "ke"（非地震事件，如爆炸）',
    staleAfterMs: null,
    staleReason: '全球 M4+ 平均约 30 分钟一条，稀疏是常态，不能用消息间隔判死。活性由连接层负责' +
      '（建连超时监控 15 秒 + 3 小时无消息的连接假死检测，见 15-entry 的 staleAfterMs）。',
  },
  usgs: {
    label: 'USGS',
    region: 'global',
    disasters: ['quake'],
    transport: 'feed',
    url: 'https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/2.5_day.geojson',
    pollMs: 120 * 1000,
    timezone: 'UTC（properties.time/updated 是 epoch 毫秒，经 toIso 转成带 Z 的 ISO）',
    required: [
      '顶层 GeoJSON：features[] 数组（**Host 侧校验**：lib/global-sources.js 的 parseUsgsEntries）',
      '每个 feature：properties 是对象、mag 是 number、time 是 number（epoch 毫秒或可解析的时间）',
      '震中坐标：geometry.coordinates[0..1] **或** properties.lat/lon（解析器两条都认，' +
      '此前写成"必须 geometry.coordinates"是比实现严的声明）',
      '坐标不越界（越界判 value，与"缺坐标判 schema"是两种不同的结论）',
    ],
    tolerant: 'feature.id（缺失时解析器按 properties.code / 坐标兜底出稳定 id）与 properties.updated' +
      '（当前实现不读它，修订版靠 properties.time + 坐标近似归并）——两者缺失都不判 schema。' +
      '另：`metadata.generated` 是**停更判据的输入而不是 schema 判据**——缺了它只意味着"新鲜度未知"' +
      '（usgsFeedGeneratedAt 返回 NaN，停更检测不触发），不会把这一帧判成故障。',
    empty: 'features 为空数组（该窗口内没有 M2.5+ 事件，罕见但正常）',
    staleAfterMs: 30 * 60 * 1000,
    staleReason: 'USGS 摘要 feed 每 5 分钟重新生成，metadata.generated 是它的生成时刻；' +
      '超过 30 分钟说明上游停更或我们拿到的是缓存。',
  },
  noaa: {
    label: 'NOAA tsunami.gov',
    region: 'global',
    disasters: ['tsunami'],
    transport: 'feed',
    url: 'https://www.tsunami.gov/events/xml/PHEBAtom.xml',
    pollMs: 5 * 60 * 1000,
    timezone: 'UTC（CAP <sent> 形如 2026-08-22T08:30:40-00:00，自带偏移）',
    required: [
      '事件列表：<entry> + <link rel="related" title="CapXML document" href>',
      'CAP 电文：<alert> 根、<identifier>、<info>（event / sent）',
    ],
    tolerant: '区域（<area><circle> 或 info/parameter 里的 EventLatLon）缺失**不判 schema**：' +
      'alert.geo 取 {lat:null,lon:null}，行动提示退化成"无坐标"形态而不是丢整条。',
    empty: 'msgType === "Test"（演练电文）；或事件列表为空（大多数时候没有海啸）',
    staleAfterMs: null,
    staleReason: '事件列表只在有海啸时才有内容，"列表为空"是绝大多数时间的正常形态，不能据此判 stale。',
  },
  // ---- 中国大陆源 ----
  // 两处结构性差异：① 传输是 **Host 单点常连**（Wolfx 限 5–7 连接/IP），不是 Client 直连。
  // ② cenc_eqlist 的字段**全是字符串**，cenc_eew 的字段是 number，同一上游两种序列化风格。
  cenc_eew: {
    label: 'Wolfx CENC EEW',
    region: 'cn',
    disasters: ['eew'],
    transport: 'ws',
    url: 'wss://ws-api.wolfx.jp/cenc_eew（REST 快照 https://api.wolfx.jp/cenc_eew.json）',
    pollMs: null,
    timezone: 'Asia/Shanghai（+08:00，无夏令时）—— OriginTime / ReportTime 是裸北京时间，由 cnTimeToIso 补偏移',
    required: [
      '接收两种形态：WS 推送包（含 type:"cenc_eew"）与 REST 快照（无 type）',
      'ID string 非空（消息唯一键，Alert 的 id 取 cenc: 前缀）',
      'Latitude / Longitude 为数值，且落在合法范围内',
      'Magnitude 为数值（缺它这条预警就没有阈值可判 → 判 schema）',
      'OriginTime 为可解析的北京时间串，且不是客观不可能的时刻',
    ],
    tolerant: 'Depth / ReportNum / MaxIntensity / HypoCenter / ReportTime 缺失或类型不对**不判 schema**' +
      '——沿用 0.4.2 对 551 观测点定的同一口径（"存在则类型必须正确"，缺失容忍）：' +
      '整条丢弃在预警产品里的代价是漏报。取不到值时解析器给 null / 空串，文案退化成 M— / 无地名。' +
      '（0.5.1 修正：此前 required 把这几项也写成必需，与实现的校验范围不符。）',
    empty: '10 个字段一个都没有（只有 type 包裹或空对象）——源正常但当前没有预警。' +
      '**这条未实测**：Wolfx 总是回最后一条预警（哪怕已过数天），从未见过"无预警"的返回形态，' +
      '样本不足以确认。保守取此判据，是因为判反了会点亮一个用户根本处理不了的蓝点（DESIGN 4.5 的配色语义）。',
    staleAfterMs: null,
    staleReason: '预警稀疏（实测门槛约 M4.0，数天一次），"很久没消息"是常态，不能据此判死。' +
      '活性由连接层负责（心跳实测精确 60 秒、200 秒内无服务端强断，超 120 秒无消息即重连）。' +
      '中继是否存活由 cenc_eqlist 探（它每天都有数据）——这也是两个源都要接的原因之一。',
  },
  cenc_eqlist: {
    label: 'Wolfx CENC eqlist',
    region: 'cn',
    disasters: ['quake'],
    transport: 'ws',
    url: 'wss://ws-api.wolfx.jp/cenc_eqlist（REST 快照 https://api.wolfx.jp/cenc_eqlist.json）',
    pollMs: null,
    timezone: 'Asia/Shanghai（+08:00，无夏令时）—— time / ReportTime 是裸北京时间，由 cnTimeToIso 补偏移',
    required: [
      '整表载荷：No1…NoN（数值序，No1 最新）；**md5 不是判据**——它只作诊断读数与' +
      '（P3-31 之前）的整表短路，缺了照常逐条比对',
      '每项：EventID string 非空',
      '每项：latitude / longitude 为数字字符串或数值，且落在合法范围内',
      '每项：magnitude 为数字字符串或数值（缺它这条速报就没有阈值可判）',
      '每项：time 为可解析的北京时间串，且不是客观不可能的时刻',
    ],
    tolerant: 'placeName / location / depth / intensity / ReportTime / type 缺失或类型不对**不判 schema**' +
      '（同上：保留一条真实地震比丢弃它重要）。地名取 placeName 优先、location 兜底，都没有则留空。' +
      '注意本判据是**逐项**的——线上由 Host 把整表拆成逐条 entry，整表级的"全坏"由 Host 侧判（见 wolfx-source）。',
    empty: '整表里一个 NoN 都没有——源正常但当前没有速报数据',
    staleAfterMs: 48 * 60 * 60 * 1000,
    staleReason: '**本插件唯一真正有意义的新鲜度阈值，而且它探的是中继不是灾害**：速报每天都有数据，' +
      '所以"超过 48 小时没有新批次"即判中继异常（fj_eew 那种连接正常但停更 4 个月的形态，' +
      '靠连接检测完全发现不了）。实测发布 lag 209–1643 秒，阈值不能贴着 lag 取留出余量。',
  },
  // ---- 中国大陆气象源 ----
  // 一条 Host 源（`nmc_alarm`）承载**两个灾种**（暴雨 / 地质灾害）：两者来自同一个
  // `rest/findAlarm` 响应、只有 `pic` 编码不同，所以是一条契约。匹配走**行政区层级**
  // （locator:'area'），因此"title 能解析出机构名"是**必需字段**——解析不出就归不了属。
  nmc_alarm: {
    label: 'CMA warning signals (nmc.cn)',
    region: 'cn',
    disasters: ['weather'],
    transport: 'feed',
    url: 'https://www.nmc.cn/rest/findAlarm（详情页 https://www.nmc.cn/publish/alarm/<alertid>.html）',
    pollMs: 120 * 1000,
    timezone: 'Asia/Shanghai（+08:00，无夏令时）—— issuetime 是裸北京时间，且写法与 Wolfx 不同' +
      '（`2026/09/19 12:31`：斜杠分隔、无秒）。Host 侧补偏移后以带偏移的 ISO 下发，' +
      '所以 Client 这里拿到的时间已经可以直接 Date.parse。',
    required: [
      'alertid string 非空（每条预警的唯一键，Host 用它去重与拼详情 URL）',
      'kind 是 string；`{rainstorm, geology}` 之外的取值判 **empty 而不是 schema**' +
      '（0.9.4 / C2：实现里走的是 `own(NMC_KIND_TEXT, kind)` 判空，说明这两种之外只是"不在我们范围内"，' +
      '不是源坏了——此前写在 required 里会让人以为要判故障）',
      'level ∈ {red, orange, yellow, blue}（Host 从 pic 的等级码译出）',
      'title string 非空，且形如「…气象台发布…预警信号」——**匹配完全依赖它**，解析不出机构名即判 schema',
      'issued 可解析的 ISO 时间（Host 已补 +08:00）',
    ],
    tolerant: 'detail（详情页正文）缺失或为空**不判 schema**：只有橙色及以上才会拉详情（DESIGN 8.4），' +
      '蓝 / 黄的正文本来就是空的，而详情抓取失败也只会让文案少一段说明——' +
      '为了一段附属文字丢掉一条真实预警是漏报方向。',
    empty: 'kind 是字符串但**不在本插件范围内**——这是**向前兼容**的兜底而不是当下会发生的形态：' +
      'Host 已经按灾种过滤（实测雷电 / 大风 / 高温占 76%，原样转发会把历史刷满），' +
      '所以正常收到的条目一定是暴雨或地质灾害。判 empty 而不是 schema，是为了将来 Host 若改为' +
      '转发全部灾种时，旧 Client 静默跳过而不是点亮一个用户处理不了的蓝点。',
    staleAfterMs: 3 * 60 * 60 * 1000,
    staleReason: '判据是**列表里最新一条的发布时间**（不是"我们收到多少条"）：全国范围的预警是连续' +
      '不断的（实测 238 条覆盖约 24 小时），所以"3 小时没有任何新预警"只可能是上游停更或我们' +
      '拿到缓存。与 JMA 同档；实测 40 分钟窗口里新增 11 条、相邻两次新增的最长间隔只有 10 分钟，' +
      '余量近 20 倍。',
  },
  // 海外气象源：两条都是 **Client 直连的 REST 轮询**（CORS 实测允许），且都是**按关注点查询**
  // （NWS 按点、ECCC 按 bbox）——locator 是 'overseas'（命中在取数时已发生，匹配层不算距离）、
  // staleAfterMs 只能是 null（空响应是常态）、时间语义相反（NWS 自带偏移、ECCC 是 UTC Z）。
  nws_alerts: {
    label: 'NWS alerts (api.weather.gov)',
    region: 'us',
    disasters: ['weather'],
    transport: 'rest',
    url: 'https://api.weather.gov/alerts/active?point=<lat>,<lon>' +
      '（半径 ≥ 25km 时另查 4 个方位采样点，见 DESIGN 4.7.2；全量 /alerts/active 1.67MB 不可用）',
    pollMs: 120 * 1000,
    timezone: '**响应自带偏移**（`2026-09-22T06:51:00-04:00`，随州与夏令时变化）——不换算，直接 Date.parse。' +
      '这是本插件第一个"时刻完整"的源：JMA / nmc / Wolfx 给的都是裸本地时间、必须补偏移，NWS 不是。',
    required: [
      'properties 是对象（一条 CAP 电文）',
      'properties.event string 且**精确命中 8 类洪水白名单**（未命中判 empty，见下）',
      // 实现会退回 GeoJSON 外层的 `id`（实测是 URL，解析器会剥掉前缀），所以"properties.id 必需"
      // 是比实现更严的声明——后来者按它写测试会误判某个字段必需。
      '`properties.id` 或 GeoJSON 外层的 `id` 至少有一个非空（去重与消息级 id 的基础）',
      'properties.sent 可解析的 ISO 时间（带偏移）',
    ],
    tolerant: 'severity 缺失或不在 {Extreme,Severe,Moderate,Minor} 内 → 退回 info，**不判 schema**：' +
      '宁可让一条真实洪水预警少一个颜色，也不要因为上游少给一个枚举值就整源停播（漏报方向）。' +
      'headline / areaDesc / description / instruction / geocode / ends / senderName 缺失一律不判 schema。' +
      '**事件键（eventKey）取 `parameters.VTEC` 的事件追踪号** `<office>.<phenom>.<sig>.<ETN>`' +
      '（`/O.<ACTION>.KRLX.FA.W.0137.….` → `KRLX.FA.W.0137`，ACTION 段刻意剔除：它随' +
      ' NEW→EXT→CON→CAN 变化）；VTEC 缺失或解析不出时退回 CAP 的 `references`（取 `sent` 最早的一条）、' +
      '再退回自身 identifier——**三级兜底都不判 schema**。' +
      '`properties.eventCode` 是对象（`{SAME:[…],NationalWeatherService:[…]}`）且实测 `Flood Warning` 的 ' +
      'SAME 给的是 `FLS`——它只作诊断，**不参与任何判据**。',
    empty: '`properties.event` 不在白名单——它是**向前兼容的兜底**而不是异常：全量 359 条里海事通告占' +
      '三分之二（Small Craft Advisory 202 条、Gale Warning 34 条），非本插件灾种（Air Quality / Frost / ' +
      'Wind / Test Message）也在其中。另外 `features: []`（该点当前没有预警）同样是正常形态。' +
      '两类都判 empty 而不是 schema，是为了不点亮一个用户处理不了的蓝点。',
    staleAfterMs: null,
    staleReason: '**按点查询的响应天然可能是空的**：美国绝大多数坐标绝大多数时候没有洪水预警，' +
      '"这一轮没数据"与"上游停更"完全同形，据此判 stale 会把正常状态反复报成故障。' +
      '活性交给连接层（请求是否成功）。代价要如实说：**"服务在但数据不更新"这种停更本插件看不见**，' +
      '能发现的只有 schema 判据能抓到的结构改版（DESIGN 4.7.7 第 2 条）。',
  },
  eccc_alerts: {
    label: 'ECCC alerts (api.weather.gc.ca)',
    region: 'ca',
    disasters: ['weather'],
    transport: 'rest',
    url: 'https://api.weather.gc.ca/collections/weather-alerts/items?f=json&bbox=<minLon>,<minLat>,<maxLon>,<maxLat>' +
      '（bbox = 关注点坐标 ± radiusKm，OGC API 的矩形查询）',
    pollMs: 300 * 1000,
    timezone: '**UTC**（`2026-09-22T08:47:21.957Z`）——不需要补偏移，直接 Date.parse。',
    required: [
      'properties 是对象',
      'alert_type === "warning"（advisory 判 empty，见下）',
      'alert_name_en 命中灾种白名单（未命中判 empty，见下）',
      'alert_code string 非空（ECCC 的三字母码，只作诊断与事件键）',
      'publication_datetime 可解析的 ISO 时间',
      'risk_colour_en ∈ {yellow, orange, red}——**颜色是 ECCC 2025 改版后的核心等级信息**，' +
      '缺失或越界说明上游结构变了，判 schema 让用户看见',
    ],
    tolerant: 'alert_text_en 为空 → detail 只留署名行，**不判 schema**（正文是"该怎么做"的说明，' +
      '它的缺失不该让一条真实预警消失）。feature_id / province / confidence_en / impact_en / status_en ' +
      '缺失一律不判 schema——**事件键会在 feature_id 缺失时退回区域名**（见 05h 的 ecccEventKeyOf；' +
      '两个都缺时会退到 province，这时同省同码同日期的两条不同 warning 会算出同一个事件键而被' +
      '当成"后续发布"——已知的边界，等真实样本出现再校准）。' +
      '**事件键按 UTC 发布日分桶**（`eccc:<code>:<areaKey>:<YYYY-MM-DD>`）：同一天内的更新同键、' +
      '不重复响铃；跨 UTC 日界的持续过程会换键，最多多响一次（保守方向）。',
    empty: '两类都判 empty（向前兼容，不点亮蓝点）：① `alert_type !== "warning"`——ECCC 的 advisory 按官方' +
      '定义是「generally not considered hazardous」，实测当前 116 条里 114 条是 frost advisory；' +
      '② `alert_name_en` 不在白名单（风 / 高温 / 雷暴 / 雾…）。' +
      '**注意白名单的证据等级**：ECCC 的码表没有官方枚举，而当前季节没有降雨类样本，' +
      '白名单是按名称关键词收的（`' + String(ECCC_INCLUDE) + '`，并排除 `' + String(ECCC_EXCLUDE) + '`），' +
      '**是本设计里唯一未经实测证实的部分**——首批真实降雨预警到达后要回头校准（DESIGN 4.7.5）。',
    staleAfterMs: null,
    staleReason: '与 NWS 同因：bbox 查询在"这个范围当前没有本插件范围内的预警"时返回空数组，' +
      '与"上游停更"同形。另外 ECCC 的 **CAP 归档只有当天、历史不可得**（实测跨 3 天取样全部失败），' +
      '所以也无法用"上一次见到数据是什么时候"来判停更。',
  },
};

// ---------------------------------------------------------------- Result 包装
// 包装函数先把"结构不符 / 值不可能"挡在解析器之前，再调用真实解析器（单一实现）。

/**
 * P2PQuake（551/552/556）。
 *
 * 运行时调用点是 15-entry.js 里 P2PQuake 的 onRaw（每帧一次），调用后立刻记入数据健康：
 * schema / value 失败会升级成界面蓝点，不是被丢掉。
 */
function parseEpspResult(raw) {
  if (!isPlainObject(raw)) return failResult('schema', '顶层不是对象')
  const code = raw.code;
  if (code !== 551 && code !== 552 && code !== 556) {
    return failResult('empty', 'code=' + String(code) + ' 不属于本插件的灾种')
  }
  const id = raw.id || raw._id;
  if (typeof id !== 'string' || !id) return failResult('schema', '缺少 id/_id')
  const issueTime = raw.issue && raw.issue.time;
  if (typeof issueTime !== 'string' || !issueTime) return failResult('schema', '缺少 issue.time')
  if (code === 551) {
    const eq = raw.earthquake;
    if (!isPlainObject(eq)) return failResult('schema', '551 缺少 earthquake')
    if (typeof eq.maxScale !== 'number') return failResult('schema', '551 缺少 earthquake.maxScale（number）')
    if (!Array.isArray(raw.points)) return failResult('schema', '551 缺少 points 数组')
    for (const p of raw.points) {
      if (!isPlainObject(p)) return failResult('schema', '551 的 points[] 含非对象项')
      // 逐项只查"**存在则类型正确**"（0.4.2 放宽）：单个观测点缺 scale / 缺 pref 不该让整条
      // 警报消失——其他观测点是好的，而整条丢弃在预警产品里的代价是漏报。
      // 真正要挡的是"结构型错误"（points 不是数组、项不是对象、字段类型明显不对）。
      if (p.scale !== undefined && p.scale !== null && typeof p.scale !== 'number') {
        return failResult('schema', '551 的 points[].scale 类型不是 number')
      }
      if (p.pref !== undefined && p.pref !== null && typeof p.pref !== 'string') {
        return failResult('schema', '551 的 points[].pref 类型不是 string')
      }
      if (p.addr !== undefined && p.addr !== null && typeof p.addr !== 'string') {
        return failResult('schema', '551 的 points[].addr 类型不是 string')
      }
    }
    if (timeIsImpossible(timeMsOf(eq.time))) return failResult('value', '551 的 earthquake.time 客观不可能：' + String(eq.time))
  }
  if (code === 552) {
    if (!Array.isArray(raw.areas)) return failResult('schema', '552 缺少 areas 数组')
    for (const a of raw.areas) {
      if (!isPlainObject(a)) return failResult('schema', '552 的 areas[] 含非对象项')
      if (a.grade !== undefined && a.grade !== null && typeof a.grade !== 'string') {
        return failResult('schema', '552 的 areas[].grade 不是字符串')
      }
    }
  }
  if (code === 556) {
    const eq = raw.earthquake;
    if (!isPlainObject(eq)) return failResult('schema', '556 缺少 earthquake')
    if (!isPlainObject(eq.hypocenter)) return failResult('schema', '556 缺少 earthquake.hypocenter')
    if (!Array.isArray(raw.areas)) return failResult('schema', '556 缺少 areas 数组')
    for (const a of raw.areas) {
      if (!isPlainObject(a)) return failResult('schema', '556 的 areas[] 含非对象项')
      if (typeof a.name !== 'string' || !a.name) return failResult('schema', '556 的 areas[].name 缺失')
      if (a.scaleTo !== undefined && a.scaleTo !== null && typeof a.scaleTo !== 'number') {
        return failResult('schema', '556 的 areas[].scaleTo 不是 number')
      }
    }
  }
  const alert = parse(raw);
  if (!alert) return failResult('schema', '解析器未能生成 Alert（结构通过校验但字段映射失败）')
  return okResult(alert)
}

/** 気象庁 防災情報XML。 */
function parseJmaResult(xml, entry) {
  const text = String(xml === undefined || xml === null ? '' : xml);
  if (!text) return failResult('schema', '电文为空')
  if (text.indexOf('<Report') === -1) {
    if (/^\s*<(!doctype|html)/i.test(text) || text.indexOf('<html') !== -1) {
      return failResult('schema', '返回的是 HTML 而不是 XML 电文（可能被拦截或地址失效）')
    }
    return failResult('schema', '不是防災情報XML（缺少 <Report> 根元素）')
  }
  const alert = parseJma(text, entry);
  if (!alert) return failResult('empty', '与本插件无关的电文（无警戒レベル、且不是解除）')
  return okResult(alert)
}

/** EMSC standing_order。 */
function parseEmscResult(raw) {
  if (!isPlainObject(raw)) return failResult('schema', '顶层不是对象')
  if (raw.action === 'delete') return failResult('empty', '事件撤回通知（action=delete）')
  const d = raw.data;
  if (!isPlainObject(d)) return failResult('schema', '缺少 data 对象')
  const p = d.properties;
  if (!isPlainObject(p)) return failResult('schema', '缺少 data.properties')
  const coords = (d.geometry && Array.isArray(d.geometry.coordinates)) ? d.geometry.coordinates : [];
  const lat = numOf(p.lat !== undefined ? p.lat : coords[1]);
  const lon = numOf(p.lon !== undefined ? p.lon : coords[0]);
  if (lat === null || lon === null) return failResult('schema', '缺少震中坐标（properties.lat/lon 与 geometry.coordinates 都没有）')
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return failResult('value', '震中坐标越界：' + lat + ',' + lon)
  if (numOf(p.mag) === null) return failResult('schema', '缺少 properties.mag（number）')
  const t = timeMsOf(p.time);
  if (t === null) return failResult('schema', '缺少 properties.time（可解析的时间）')
  if (timeIsImpossible(t)) return failResult('value', '发震时刻客观不可能：' + String(p.time))
  if (p.evtype !== undefined && String(p.evtype) !== 'ke') {
    return failResult('empty', '非地震事件（evtype=' + String(p.evtype) + '）')
  }
  const alert = parseEmsc(raw);
  if (!alert) return failResult('schema', '解析器未能生成 Alert（结构通过校验但字段映射失败）')
  return okResult(alert)
}

/** USGS summary feed 的单个 Feature。 */
function parseUsgsResult(feature) {
  if (!isPlainObject(feature)) return failResult('schema', '不是 GeoJSON Feature 对象')
  const p = feature.properties;
  if (!isPlainObject(p)) return failResult('schema', '缺少 feature.properties')
  const coords = (isPlainObject(feature.geometry) && Array.isArray(feature.geometry.coordinates))
    ? feature.geometry.coordinates : [];
  const lon = numOf(coords[0] !== undefined ? coords[0] : p.lon);
  const lat = numOf(coords[1] !== undefined ? coords[1] : p.lat);
  if (lat === null || lon === null) return failResult('schema', '缺少 geometry.coordinates / properties.lat,lon')
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return failResult('value', '震中坐标越界：' + lat + ',' + lon)
  if (numOf(p.mag) === null) return failResult('schema', '缺少 properties.mag（number）')
  const t = timeMsOf(p.time);
  if (t === null) return failResult('schema', '缺少 properties.time（epoch 毫秒或可解析的时间）')
  if (timeIsImpossible(t)) return failResult('value', '发震时刻客观不可能：' + String(p.time))
  const alert = parseUsgsFeature(feature);
  if (!alert) return failResult('schema', '解析器未能生成 Alert（结构通过校验但字段映射失败）')
  return okResult(alert)
}

/** NOAA tsunami.gov 的 CAP 1.2 电文。 */
function parseNoaaResult(xml, entry) {
  const text = String(xml === undefined || xml === null ? '' : xml);
  if (!text) return failResult('schema', 'CAP 电文为空')
  if (text.indexOf('<alert') === -1) {
    if (text.indexOf('<html') !== -1 || /^\s*<(!doctype|html)/i.test(text)) {
      return failResult('schema', '返回的是 HTML 而不是 CAP 电文（可能被拦截或地址失效）')
    }
    return failResult('schema', '不是 CAP 电文（缺少 <alert> 根元素）')
  }
  const msgType = (/<msgType>([^<]*)<\/msgType>/.exec(text) || [])[1] || '';
  if (String(msgType).trim() === 'Test') return failResult('empty', '演练电文（msgType=Test）')
  const alert = parseNoaaCap(text, entry);
  if (!alert) return failResult('schema', '缺少 <identifier> 或解析器未能生成 Alert')
  if (alert.geoList && alert.geoList.length) {
    for (const g of alert.geoList) {
      if (Math.abs(g.lat) > 90 || Math.abs(g.lon) > 180) return failResult('value', 'circle 坐标越界：' + g.lat + ',' + g.lon)
    }
  }
  return okResult(alert)
}

/**
 * Wolfx 大陆地震预警（`cenc_eew`）。
 *
 * 时间判据用 `cnTimeToIso` 之后的串去解析：裸的 `2026-09-18 20:50:23` 交给 `Date.parse` 会按
 * **本机时区**解释，而它其实是北京时间——那样"客观不可能"这条判据就带上了本机时区的偏差。
 */
function parseCencEewResult(raw) {
  if (!isPlainObject(raw)) return failResult('schema', '顶层不是对象')
  if (raw.type !== undefined && String(raw.type) !== 'cenc_eew') {
    return failResult('schema', 'type 不是 cenc_eew（收到 ' + String(raw.type) + '）')
  }
  // empty 判据：10 个字段一个都没有。理由见 SOURCE_CONTRACTS.cenc_eew.empty。
  const fields = ['ID', 'EventID', 'OriginTime', 'ReportTime', 'Latitude', 'Longitude', 'Magnitude', 'Depth', 'MaxIntensity', 'HypoCenter'];
  const hasAny = fields.some((k) => {
    const v = raw[k];
    return v !== undefined && v !== null && String(v) !== ''
  });
  if (!hasAny) return failResult('empty', '载荷里没有任何预警字段（源正常但当前没有预警）')
  const id = raw.ID;
  if (typeof id !== 'string' || !id.trim()) return failResult('schema', '缺少 ID（string）')
  const lat = numOf(raw.Latitude);
  const lon = numOf(raw.Longitude);
  if (lat === null || lon === null) return failResult('schema', '缺少 Latitude / Longitude（数值）')
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return failResult('value', '震中坐标越界：' + lat + ',' + lon)
  if (numOf(raw.Magnitude) === null) return failResult('schema', '缺少 Magnitude（数值）')
  const t = timeMsOf(cnTimeToIso(raw.OriginTime));
  if (t === null) return failResult('schema', '缺少 OriginTime（可解析的北京时间）')
  if (timeIsImpossible(t)) return failResult('value', '发震时刻客观不可能：' + String(raw.OriginTime))
  const alert = parseCencEew(raw);
  if (!alert) return failResult('schema', '解析器未能生成 Alert（结构通过校验但字段映射失败）')
  return okResult(alert)
}

/**
 * 速报整表里的单项（`NoN`）。逐条过契约，便于定位"哪一项坏了"。
 * 注意：单项失败**不等于整表坏**——批量语义见 parseCencEqlistResult。
 */
function parseCencEqlistItemResult(item) {
  if (!isPlainObject(item)) return failResult('schema', '速报项不是对象')
  const eventId = item.EventID;
  if (typeof eventId !== 'string' || !eventId.trim()) return failResult('schema', '缺少 EventID（string）')
  const lat = numOf(item.latitude);
  const lon = numOf(item.longitude);
  if (lat === null || lon === null) return failResult('schema', '缺少 latitude / longitude（数字字符串或数值）')
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return failResult('value', '震中坐标越界：' + lat + ',' + lon)
  if (numOf(item.magnitude) === null) return failResult('schema', '缺少 magnitude（数字字符串或数值）')
  const t = timeMsOf(cnTimeToIso(item.time));
  if (t === null) return failResult('schema', '缺少 time（可解析的北京时间）')
  if (timeIsImpossible(t)) return failResult('value', '发震时刻客观不可能：' + String(item.time))
  const alert = parseCencEqlistItem(item);
  if (!alert) return failResult('schema', '解析器未能生成 Alert（结构通过校验但字段映射失败）')
  return okResult(alert)
}

/**
 * 速报整表 → 批量结果 `{ ok, alerts, dropped, md5 }`。
 *
 * 坏的条目逐条丢弃并计数（`dropped`，不是静默），只有一条都没解析出来才判整表 schema——
 * 一条缺坐标就让整表作废等于漏掉其余真实地震。整表一条都没有则判 empty。
 */
function parseCencEqlistResult(json) {
  if (!isPlainObject(json)) return failResult('schema', '顶层不是对象')
  if (json.type !== undefined && String(json.type) !== 'cenc_eqlist') {
    return failResult('schema', 'type 不是 cenc_eqlist（收到 ' + String(json.type) + '）')
  }
  const items = cencEqlistItems(json);
  if (items.length === 0) return failResult('empty', '整表里没有 NoN 条目（源正常但当前没有速报数据）')
  const alerts = [];
  let dropped = 0;
  let firstDetail = '';
  for (const it of items) {
    const res = parseCencEqlistItemResult(it);
    if (res.ok) { alerts.push(res.alert); continue }
    if (res.kind === 'empty') continue
    dropped++;
    if (!firstDetail) firstDetail = res.kind + '：' + res.detail;
  }
  if (alerts.length === 0) {
    return failResult('schema', '整表 ' + items.length + ' 条全部无法解析（' + firstDetail + '）')
  }
  return { ok: true, alerts, dropped, md5: cencEqlistMd5Of(json), total: items.length }
}

/**
 * 中央气象台预警（`nmc_alarm`）。
 *
 * `title` 里**必须**能解析出机构名——匹配依赖它。灾种不在范围内时判 empty 而不是 schema：
 * Host 已按灾种过滤，正常收不到，判 empty 使"Host 将来转发更多灾种"对旧 Client 是静默跳过。
 */
function parseNmcAlarmResult(raw) {
  if (!isPlainObject(raw)) return failResult('schema', '顶层不是对象')
  const alertid = String(raw.alertid === undefined || raw.alertid === null ? '' : raw.alertid).trim();
  if (!alertid) return failResult('schema', '缺少 alertid（string）')
  if (typeof raw.kind !== 'string' || !raw.kind) return failResult('schema', '缺少 kind（string）')
  // 查表一律走 own()：`NMC_KIND_TEXT['constructor']` 会命中原型链返回 Object 构造函数（truthy），
  // 于是 `kind: 'constructor'` 这样的格式不合法的数据会绕过 empty / schema 判据被放行。Host 的 JSON 属于
  // 不可信输入，不能直查。
  if (!own(NMC_KIND_TEXT, raw.kind)) return failResult('empty', '灾种不在本插件范围内：' + raw.kind)
  if (typeof raw.level !== 'string' || !own(NMC_LEVEL_TEXT, raw.level)) {
    return failResult('schema', '缺少或无法识别的 level：' + String(raw.level))
  }
  const title = String(raw.title === undefined || raw.title === null ? '' : raw.title).trim();
  if (!title) return failResult('schema', '缺少 title（string）')
  if (!orgOf(title)) return failResult('schema', 'title 里解析不出发布机构（形如「…气象台发布…」）')
  const t = timeMsOf(raw.issued);
  if (t === null) return failResult('schema', '缺少 issued（可解析的 ISO 时间）')
  if (timeIsImpossible(t)) return failResult('value', '发布时间客观不可能：' + String(raw.issued))
  const alert = parseNmcAlarm(raw);
  if (!alert) return failResult('schema', '解析器未能生成 Alert（结构通过校验但字段映射失败）')
  return okResult(alert)
}

/**
 * 美国 NWS 洪水类预警（`nws_alerts`）。
 *
 * `opts.place` 是取数器查这条时用的关注点——它让匹配层不必再算距离。判据顺序：先把
 * "不在范围内"与"结构不符"分开，再交给解析器（单一实现）。
 */
function parseNwsAlertResult(raw, opts) {
  if (!isPlainObject(raw)) return failResult('schema', '顶层不是对象')
  const p = raw.properties;
  if (!isPlainObject(p)) return failResult('schema', '缺少 properties（对象）')
  const event = typeof p.event === 'string' ? p.event : '';
  // 走 own()：`event: 'constructor'` 这类键直查会命中原型链返回函数对象（truthy），
  // 于是格式不合法的数据绕过白名单被放行（与 nmc 查表是同一个坑）。
  if (!own(NWS_EVENT_WHITELIST, event)) {
    return failResult('empty', '事件类型不在本插件范围内：' + (event || '(空)'))
  }
  const id = String(p.id === undefined || p.id === null ? (raw.id || '') : p.id).trim();
  if (!id) return failResult('schema', '缺少 properties.id（CAP identifier）')
  const t = timeMsOf(p.sent);
  if (t === null) return failResult('schema', '缺少或无法解析 properties.sent（ISO 时间）')
  if (timeIsImpossible(t)) return failResult('value', '发布时间客观不可能：' + String(p.sent))
  const alert = parseNwsAlert(raw, opts);
  if (!alert) return failResult('schema', '解析器未能生成 Alert（结构通过校验但字段映射失败）')
  return okResult(alert)
}

/**
 * 加拿大 ECCC 预警（`eccc_alerts`）。
 *
 * 两道过滤器都在契约层做（与解析器里的同一份名单），让"不在范围内"在**进入解析器之前**就有
 * 明确归类，而不是靠解析器返回 null 再反推是 schema 还是 empty。
 */
function parseEcccAlertResult(raw, opts) {
  if (!isPlainObject(raw)) return failResult('schema', '顶层不是对象')
  const p = raw.properties;
  if (!isPlainObject(p)) return failResult('schema', '缺少 properties（对象）')
  const type = typeof p.alert_type === 'string' ? p.alert_type : '';
  if (type !== 'warning') {
    return failResult('empty', 'ECCC 的 ' + (type || '(空类型)') + ' 不在本插件接的范围内（advisory 按官方定义是非危险天气）')
  }
  const nameEn = typeof p.alert_name_en === 'string' ? p.alert_name_en.trim() : '';
  if (!nameEn) return failResult('schema', '缺少 alert_name_en（string）')
  // 先排除、再包含——与 05h 里的顺序一致。
  if (ECCC_EXCLUDE.test(nameEn) || !ECCC_INCLUDE.test(nameEn)) {
    return failResult('empty', '灾种不在本插件范围内：' + nameEn)
  }
  const code = typeof p.alert_code === 'string' ? p.alert_code.trim() : '';
  if (!code) return failResult('schema', '缺少 alert_code（string）')
  const t = timeMsOf(p.publication_datetime);
  if (t === null) return failResult('schema', '缺少或无法解析 publication_datetime')
  if (timeIsImpossible(t)) return failResult('value', '发布时间客观不可能：' + String(p.publication_datetime))
  const colour = typeof p.risk_colour_en === 'string' ? p.risk_colour_en.toLowerCase() : '';
  if (!own(ECCC_COLOUR_SEVERITY, colour)) {
    return failResult('schema', 'risk_colour_en 缺失或越界：' + String(p.risk_colour_en))
  }
  const alert = parseEcccAlert(raw, opts);
  if (!alert) return failResult('schema', '解析器未能生成 Alert（结构通过校验但字段映射失败）')
  return okResult(alert)
}

// ============================================================================
// dsh-quake-alert · client/src/05g-source-health.js
//
// 作用：**机制层**——统一的源健康记录：data / fresh 两层的存储与合成、逐条计数的升级阈值、
//       蓝点的跨刷新持久化与 TTL 自愈。
// 依赖：01-constants（HEALTH_KEY）、02-storage（loadJSON / saveJSON / isPlainObject）、07-store。
// 分工：05d 是**约定层**（字段契约与失败分类），本文件是**机制层**（失败怎么存、何时升级成源级
// 异常、何时消失）。调用方仍调 `noteParseResult` 等函数，但 import 来自这里。
//
// 三件事是本文件存在的理由：① 单条失败不立即点亮蓝点——同一失败原因 10 分钟窗口内累计 ≥5 条、
// 或连续失败 ≥10 条才升级（线上是逐条 entry，实测整表 50 条里坏 1〜2 条是常态）；② 蓝点带 24 小时
// TTL，不復现就自动清除；③ data 层写入本地存储，页面刷新后蓝点仍在——"要等插件更新"与刷新页面无关。
//
// 明确不做：连接状态（conn）不持久化、也不在这里判定，由各传输层上报；新鲜度（fresh）只存"最后
// 数据时间"，判定交给自检，阈值只从契约来。
// ============================================================================


/** 同一失败原因在窗口内累计这么多条 → 升级成源级蓝点。取 5：整表 50 条里坏 1〜2 条是常态。 */
const SCHEMA_ESCALATE_COUNT = 5;
const SCHEMA_ESCALATE_WINDOW_MS = 10 * 60 * 1000;

/** 连续失败这么多条（**不看原因**）→ 同样升级。兜"坏法不重样"：结构改得面目全非时每条失败的原因
 *  字符串都不同，按原因计数到不了阈值。 */
const SCHEMA_ESCALATE_CONSECUTIVE = 10;

/** 蓝点的存活上限：超过它没有复现就自动清除。24 小时足够"用户第二天打开还在"，又不会永久挂着。 */
const HEALTH_TTL_MS = 24 * 60 * 60 * 1000;

// ---------------------------------------------------------------- 存储
/** 内存里的健康记录：id → { data, fresh, counters, consecutiveFail } */
const health = new Map();

function ensure(id) {
  let r = health.get(id);
  if (!r) {
    r = {
      data: null, // { errorKey, kind, detail, at, firstAt, count, escalated }
      fresh: { dataTime: 0, stale: false, staleSince: 0 },
      counters: { ok: 0, schema: 0, value: 0, empty: 0 },
      consecutiveFail: 0,
    };
    health.set(id, r);
  }
  return r
}

/** 写入本地存储。只写 data 一层，没有异常的源不占空间。 */
function persist() {
  const out = {};
  for (const [id, r] of health) {
    if (!r.data) continue
    const d = r.data;
    out[id] = {
      errorKey: d.errorKey, kind: d.kind, detail: d.detail,
      at: d.at, firstAt: d.firstAt, escalated: d.escalated === true,
    };
  }
  saveJSON(HEALTH_KEY, out);
}

/** 从 localStorage 恢复（模块加载时自动调一次）。过期的直接丢掉——TTL 在**读取**时也要判，
 *  否则关掉浏览器三天再打开会看到一个早已过期的蓝点。 @returns {number} 恢复了几条 */
function loadHealth(now) {
  const t = now === undefined ? Date.now() : now;
  const raw = loadJSON(HEALTH_KEY, null);
  if (!isPlainObject(raw)) return 0
  let n = 0;
  for (const id of Object.keys(raw)) {
    const d = raw[id];
    if (!isPlainObject(d)) continue
    if (typeof d.errorKey !== 'string' || !d.errorKey) continue
    if (!Number.isFinite(d.at) || t - d.at > HEALTH_TTL_MS) continue
    const r = ensure(id);
    r.data = {
      errorKey: d.errorKey,
      kind: typeof d.kind === 'string' ? d.kind : 'schema',
      detail: typeof d.detail === 'string' ? d.detail : '',
      at: d.at,
      firstAt: Number.isFinite(d.firstAt) ? d.firstAt : d.at,
      count: 1, // 计数不跨刷新累计：它是"这一轮里坏了多少条"，跨会话没有意义
      escalated: d.escalated === true,
    };
    n += 1;
  }
  return n
}

// ---------------------------------------------------------------- 数据层（解析失败）
/** 连接层基线：清掉数据健康之后，展示状态该回到哪一个连接状态。store 里存的是**合成结果**，所以先
 *  看它是不是由数据层投出来的（`schema-error` / `stale`）——是就按 `open` 计，否则沿用当前值。 */
function connBaseOf(sourceId) {
  const cur = (store.sources && store.sources[sourceId]) || {};
  const s = cur.status;
  return (s === 'schema-error' || s === 'stale' || !s) ? 'open' : s
}

/** 清掉 data 层（成功解析 / empty / TTL 自愈都走这里）。只有**确实从异常恢复了**才上报——否则
 *  每条成功的数据都会触发一次设置页重渲。 */
function clearData(sourceId, detail, t) {
  const r = health.get(sourceId);
  if (!r || !r.data) return false
  const wasEscalated = r.data.escalated === true;
  r.data = null;
  r.consecutiveFail = 0;
  persist();
  // 走 publishStatus 而不是直接 pushSource：清掉蓝点之后该显示什么得由合成规则决定——若这个源
  // 此刻正停更，展示状态应当是「数据已过期」而不是「已连接」。
  if (wasEscalated) publishStatus(sourceId, { status: connBaseOf(sourceId), detail });
  return true
}

/**
 * 记录一次解析结果。返回 true = "这条数据不可用，调用方不应继续处理它"——与"是否点亮蓝点"**解耦**：
 * 单条坏数据不该让整个源变蓝。
 *
 * empty 仍算"结构是好的"，**默认**清掉蓝点（JMA 的常态就是 empty）。**唯一例外是逐条上报
 * （`opts.perItem`）**：那时 empty 只计数、不清 data 层——empty 只说明"**这一条**无关"，不能证明
 * 同批次此前那条 schema 失败已恢复；批量取数（12e 一轮查 N 个关注点）里立即 clearData 会连**其它
 * 条目**的失败计数一起清掉，两条升级阈值都不可达、蓝点永不点亮，即"局部改版 / 局部拦截"退化成
 * **静默漏报**。「条级独立」的来源（12b 的 feed、15-entry 的 WS）不传 perItem；只有"一轮 = 一批
 * 请求"的海外源传。
 */
function noteParseResult(sourceId, res, now, opts) {
  if (!res || res.ok) return false
  const t = now === undefined ? Date.now() : now;
  const r = ensure(sourceId);
  const kind = res.kind === 'value' ? 'value' : (res.kind === 'empty' ? 'empty' : 'schema');
  if (kind === 'empty') {
    r.counters.empty += 1;
    if (!(opts && opts.perItem)) clearData(sourceId, 'schema recovered');
    return false
  }
  r.counters[kind] += 1;
  r.consecutiveFail += 1;
  const key = kind + '|' + String(res.detail || '');
  const prev = r.data;
  const sameReason = !!prev && prev.errorKey === key && (t - prev.firstAt) <= SCHEMA_ESCALATE_WINDOW_MS;
  const count = sameReason ? prev.count + 1 : 1;
  const firstAt = sameReason ? prev.firstAt : t;
  // 一旦升级就保持（同一条异常挂着的期间不该忽蓝忽绿）；它只由成功 / empty / TTL 清除。
  const escalated = (prev && prev.escalated === true) ||
    count >= SCHEMA_ESCALATE_COUNT ||
    r.consecutiveFail >= SCHEMA_ESCALATE_CONSECUTIVE;
  const wasEscalated = !!(prev && prev.escalated === true);
  r.data = { errorKey: key, kind, detail: String(res.detail || ''), at: t, firstAt, count, escalated: !!escalated };
  if (escalated && !wasEscalated) {
    try {
      console.warn('[dsh-quake-alert] ' + sourceId + ' repeated parse failures (' + kind + ', ' + count + '): ' + res.detail);
    } catch (e) { /* 忽略 */ }
    persist();
    publishStatus(sourceId, { status: connBaseOf(sourceId), detail: kind + '：' + res.detail });
  }
  return true
}

/** 解析成功。清掉蓝点（若此前有），并累加成功计数。 */
function noteSourceSuccess(sourceId, now) {
  const r = ensure(sourceId);
  r.counters.ok += 1;
  return clearData(sourceId, 'schema recovered')
}

/** TTL 自愈：由自检定期调用（模块自己不排定时器，定时器归 fiber）。 @returns {number} 自愈了几个源 */
function pruneHealth(now) {
  const t = now === undefined ? Date.now() : now;
  let healed = 0;
  for (const [id, r] of health) {
    if (!r.data) continue
    if (t - r.data.at <= HEALTH_TTL_MS) continue
    const wasEscalated = r.data.escalated === true;
    r.data = null;
    r.consecutiveFail = 0;
    healed += 1;
    if (wasEscalated) {
      publishStatus(id, { status: connBaseOf(id), detail: 'schema error not seen for 24h · auto-recovered' });
    }
  }
  if (healed) persist();
  return healed
}

// ---------------------------------------------------------------- 新鲜度层
/** 上报"我最后一次拿到数据的时刻"（epoch 毫秒）。**判定不在这里**——阈值只从契约来，由自检统一算。 */
function noteFreshness(sourceId, dataTime) {
  const r = ensure(sourceId);
  if (typeof dataTime === 'number' && Number.isFinite(dataTime) && dataTime > 0) r.fresh.dataTime = dataTime;
  return Object.assign({}, r.fresh)
}

/** 自检写入判定结果。`staleSince` 只在"从未停更变成停更"的那一刻记一次。 */
function noteStale(sourceId, stale, now) {
  const t = now === undefined ? Date.now() : now;
  const r = ensure(sourceId);
  const next = stale === true;
  if (next && !r.fresh.stale) r.fresh.staleSince = t;
  if (!next) r.fresh.staleSince = 0;
  r.fresh.stale = next;
  return Object.assign({}, r.fresh)
}

// ---------------------------------------------------------------- 读取
function snapshot(r) {
  return {
    data: r.data ? Object.assign({}, r.data) : null,
    fresh: Object.assign({}, r.fresh),
    counters: Object.assign({}, r.counters),
    consecutiveFail: r.consecutiveFail,
  }
}

/** 单个源的记录；传 undefined 取全部（诊断快照用）。 */
function sourceHealthOf(sourceId) {
  if (sourceId !== undefined) {
    const r = health.get(sourceId);
    return r ? snapshot(r) : null
  }
  const all = {};
  for (const [k, v] of health) all[k] = snapshot(v);
  return all
}

/**
 * 把"数据健康"叠加到连接状态上。优先级：数据格式异常（用户处理不了）> 停更（中灰）> 连接状态。
 */
function effectiveStatusOf(sourceId, connStatus, detail) {
  // 用户**主动关掉**的源优先于一切健康判定：否则蓝点与 stale 会覆盖 disabled，把"我把这个灾种关了"
  // 改写成"数据格式异常 / 上游停更"。
  if (connStatus === 'disabled') return { status: 'disabled', detail }
  const r = health.get(sourceId);
  if (r && r.data && r.data.escalated) return { status: 'schema-error', detail: r.data.kind + '：' + r.data.detail }
  if (r && r.fresh && r.fresh.stale) return { status: 'stale', detail: detail || 'upstream data stale' }
  return { status: connStatus, detail }
}

/**
 * **统一的状态发布入口**——任何要写 `store.sources` 的层都从这里走。
 *
 * `store.pushSource` 是**整体替换** status + detail 的，而展示状态是**合成**出来的（见
 * `effectiveStatusOf`）。其它层直接写 store 会把合成结论抹掉：自检把"停更"翻回"恢复"时写 `open` 会永久
 * 刷绿一条 schema-error 蓝点，P2PQuake 常态断线写 `reconnecting` 同样冲掉蓝点。
 *
 * @param {string} sourceId
 * @param {object} patch 至少给 status 与 detail 之一；其余字段（label / retries…）原样透传
 * @returns {{status: string, detail: string}} 本次合成出的展示状态（调用方可用它做去重键）
 */
function publishStatus(sourceId, patch) {
  const p = Object.assign({}, patch);
  // 07-store.pushSource 的兜底是**裸 id**，不补 label 的话侧边栏详情会显示成「usgs：上游数据已过期…」。
  // store 里已有 label 就沿用，否则退到契约里的 label，最后才是 id。
  if (p.label === undefined) {
    const cur = (store.sources && store.sources[sourceId]) || {};
    const declared = SOURCE_CONTRACTS[sourceId];
    p.label = cur.label || (declared && declared.label) || sourceId;
  }
  const eff = effectiveStatusOf(sourceId, p.status, p.detail);
  p.status = eff.status;
  p.detail = eff.detail;
  store.pushSource(sourceId, p);
  return eff
}

/** 把已经升级的数据健康记录重新发布到 store——插件装载时调用。刷新页面后 store 是空的而蓝点存在
 *  localStorage 里，不重发就要等该源下一次上报才显示，而"蓝点跨刷新存活"应当是**立刻**成立。 */
function republishDataHealth() {
  for (const [id, r] of health) {
    if (!r.data || !r.data.escalated) continue
    publishStatus(id, { status: 'open' });
  }
}

/** 手动重试：清掉异常标记，等下一批数据自证。 */
function retrySource(sourceId, now) {
  const r = ensure(sourceId);
  r.data = null;
  r.consecutiveFail = 0;
  persist();
  publishStatus(sourceId, { status: connBaseOf(sourceId), detail: 'manual retry · awaiting next batch' });
  return true
}

/**
 * 插件（重新）装载时重置**连接与新鲜度**两层。刻意**不清 data 层**：它已从 localStorage 恢复，
 * 而"上游改了字段、等插件更新"与用户刷新页面 / 重新启用插件无关。
 */
function resetConnHealth() {
  for (const [, r] of health) {
    r.fresh = { dataTime: 0, stale: false, staleSince: 0 };
    r.consecutiveFail = 0;
  }
}

/** 测试钩子：清空全部（含持久化）——模块级 Map 会跨用例存活。 */
function resetSourceHealth() {
  health.clear();
  saveJSON(HEALTH_KEY, {});
}

// 模块加载时恢复一次：页面刷新后蓝点仍在。
loadHealth();

// ============================================================================
// dsh-quake-alert · client/src/06-matcher.js
// 作用：匹配引擎——决定一条 Alert 是否该提醒用户（区域匹配、阈值判定、未命中原因）；
//       依赖 01-constants、04-city-table（lookupAddrCity）、05h-overseas-parsers。
// ============================================================================


// 关注地区匹配：县级始终生效（watch.prefectures 为空 = 全日本）；市级只在数据本身有市区町村粒度
// 时收窄（cityLevel）。放行两类：区域级数据（对应不到市町村）、addr 认不出市町村。
function regionInWatch(region, watch, cityLevel, anyResolvedPref) {
  const list = watch && watch.prefectures;
  const cities = (watch && watch.cities) || [];
  // region.pref 为空 = 归属县未能识别，不能一律放行：552 / 556 的县级过滤是唯一的收窄手段，
  // 一律放行会让含"未收录预报区名"的海啸电文提醒所有关注列表非空的用户。
  // 口径：同一条消息里只要有区域能归到县，归不到的条目不参与县级过滤；全都归不到县时才放行。
  if (list && list.length > 0) {
    if (region.pref) {
      if (list.indexOf(region.pref) === -1) return false
    } else if (anyResolvedPref) {
      return false
    }
  }
  if (!cityLevel || cities.length === 0) return true
  if (region.cityKnown === false) return true
  const addrCity = lookupAddrCity(region.area);
  if (!addrCity) return true
  return cities.indexOf(addrCity) !== -1
}

// 气象警报（泥石流 / 洪水 / 大雨 / 高潮…）的关注地区匹配。与 551 不同：JMA 电文的区域在解析阶段
// 就已归到「县 + 市町村」，不再做 addr 反查。放行两类：pref 为空（无法判定）、区域级条目（city 为空）。
// 市町村比对走 normKana 等价（「金ケ崎町」vs「金け崎町」），直接 indexOf 会让已勾选的用户漏报。
function regionInWeatherWatch(region, watch) {
  const list = (watch && watch.prefectures) || [];
  const cities = (watch && watch.cities) || [];
  if (list.length > 0 && region.pref && list.indexOf(region.pref) === -1) return false
  if (cities.length === 0) return true
  if (!region.city) return true
  const target = normKana(region.city);
  return cities.some((c) => normKana(c) === target)
}

// ---------- 坐标匹配（全球源：EMSC / USGS / NOAA CAP） ----------
// 全球源只给「震中坐标 + 震级」，用户按「位置 + 半径」关注，这里做球面距离判定（Haversine）；
// 坐标缺失时如实说明无法判定，不猜、不静默放行。
const EARTH_RADIUS_KM = 6371;
function distanceKm(lat1, lon1, lat2, lon2) {
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.pow(Math.sin(dLat / 2), 2) +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.pow(Math.sin(dLon / 2), 2);
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(a)))
}
/** 坐标是否可用于计算：数值、有限、且在合法范围内（-200 这类"未知"特殊标记值会被挡下）。 */
function validGeo(geo) {
  return !!geo && typeof geo.lat === 'number' && Number.isFinite(geo.lat) &&
    typeof geo.lon === 'number' && Number.isFinite(geo.lon) &&
    Math.abs(geo.lat) <= 90 && Math.abs(geo.lon) <= 180
}
/**
 * 坐标型警报的匹配：震中落在任一关注点的半径内即命中；震级阈值单独判断。
 * @returns {{ hit: boolean, reason: string, place?: object, distanceKm?: number }}
 */
function matchPointAlert(alert, cfg) {
  const places = (cfg.watch && cfg.watch.places) || [];
  if (places.length === 0) {
    return { hit: false, reason: t('reason.noGlobalWatch') }
  }
  // 多区域电文（CAP 允许一个 info 下多个 <area><circle>）：任一圆心落在半径内即算命中，只看第一个
  // circle 会让其余海域的沿海用户漏报。
  const pts = (Array.isArray(alert.geoList) && alert.geoList.length ? alert.geoList : [alert.geo]).filter(validGeo);
  if (pts.length === 0) {
    return { hit: false, cannotJudge: true, reason: t('reason.noCoordinates') }
  }
  // 海啸等级门槛同样适用于全球源：NOAA CAP 的 <event> 决定等级，与日本 552 的 tsunamiGrade 共用
  // 一把尺（Warning=3 / Advisory・Watch=2 / Information=0）。
  if (alert.kind === 'tsunami') {
    const rank = typeof alert.tsunamiRank === 'number'
      ? alert.tsunamiRank
      : (typeof alert.maxScale === 'number' ? alert.maxScale : 0);
    const minRank = own(TSUNAMI_RANK, (cfg.thresholds || {}).tsunamiGrade) || 1;
    if (rank < minRank) {
      return { hit: false, reason: t('reason.tsunamiBelowGrade', { rank: rank, min: minRank }) }
    }
  }
  // 震级门槛分两把：坐标型预警（EMSC / USGS / cenc_eew）用 th.globalMagnitude，
  // 大陆速报（cenc_eqlist，alert.speedReport）用 th.cnReportMagnitude。
  const th = cfg.thresholds || {};
  const minMag = alert.speedReport ? th.cnReportMagnitude : th.globalMagnitude;
  const magName = alert.speedReport ? t('reason.magThresholdReport') : t('reason.magThresholdGlobal');
  const mag = typeof alert.magnitude === 'number' && Number.isFinite(alert.magnitude) ? alert.magnitude : null;
  // 震级阈值只作用于地震：海啸的严重性由自己的等级决定，NOAA 电文里的前震震级只是参考值。
  const quakeLike = alert.kind === 'quake' || alert.kind === 'eew';
  if (quakeLike && mag !== null && typeof minMag === 'number' && mag < minMag) {
    return { hit: false, reason: t('reason.magBelow', { mag: mag, name: magName, min: minMag }) }
  }
  let nearest = null;
  for (const g of pts) {
    for (const p of places) {
      const d = distanceKm(g.lat, g.lon, p.lat, p.lon);
      if (!nearest || d < nearest.d) nearest = { p, d };
      if (d <= p.radiusKm) {
        return {
          hit: true,
          reason: t('reason.pointHit', { mag: (mag === null ? '' : t('reason.magOnly', { mag: mag }) + ' · '), place: p.name, km: Math.round(d), radius: p.radiusKm }),
          place: p,
          distanceKm: d,
        }
      }
    }
  }
  return {
    hit: false,
    reason: t('reason.nearestWatch', { place: nearest.p.name, km: Math.round(nearest.d), radius: nearest.p.radiusKm }),
  }
}

// 未命中原因：若存在未能识别归属县的区域名，明确提示，避免用户误以为链路故障
function missReason(alert, watch, base) {  const list = watch && watch.prefectures;
  const cities = (watch && watch.cities) || [];
  let reason = base;
  if (list && list.length > 0) {
    const unknown = alert.regions.filter((r) => !r.pref).length;
    if (unknown > 0) reason = t('reason.missUnknownAreas', { base: base, n: unknown });
  }
  if (cities.length > 0) reason += t('reason.missNarrowedByCities', { n: cities.length });
  return reason
}

// ---------- 行政区层级匹配（大陆气象源） ----------
/**
 * 「省·市」名字 → 行政区对（分隔符是 U+00B7，以免两个省的"城区"撞名）。
 * 只服务老配置（place 上只有名字、没有显式 province / city）的解析，**不是**"这个点算不算
 * 大陆点"的判据——那个判据是 `origin`，见 cnWatchPlaces。
 */
function cnPlaceParts(name) {
  const s = String(name === undefined || name === null ? '' : name).trim();
  const i = s.indexOf('·');
  if (i <= 0 || i === s.length - 1) return null
  return { province: s.slice(0, i), city: s.slice(i + 1) }
}

const trimmed = (v) => (typeof v === 'string' ? v.trim() : '');

// 一条大陆关注点都没配时的说明；noWatch 的条目在 11-pipeline 里不进历史。
const NO_CN_WATCH_REASON = t('reason.noCnWatch');

/**
 * 从关注点列表里挑出**大陆关注点**（判据是 placeOriginOf 给的 origin，与 normalizePlaces 同一个
 * 函数，两处口径不会漂开），并给出每条的省 / 市：优先读 place 上的显式字段，缺失时回退解析
 * 「省·市」名字——回退只发生在已确定是大陆点之后。
 */
function cnWatchPlaces(places) {
  const out = [];
  for (const p of places) {
    if (!p) continue
    if (placeOriginOf(p, p.name) !== 'cn') continue
    let province = trimmed(p.province);
    let city = trimmed(p.city);
    if (!province || !city) {
      const parts = cnPlaceParts(p.name);
      if (parts) {
        if (!province) province = parts.province;
        if (!city) city = parts.city;
      }
    }
    out.push({ place: p, province, city });
  }
  return out
}

// 等级词与灾种名是界面用语（不是电文原文）→ 按界面语言取词
const NMC_LEVEL_KEY = { red: 'kind.cnLevelRed', orange: 'kind.cnLevelOrange', yellow: 'kind.cnLevelYellow', blue: 'kind.cnLevelBlue' };

/**
 * 大陆气象预警的匹配，规则按优先级排：灾种开关 → 有无大陆关注点（无则 noWatch）→ 播报门槛
 * （橙色及以上）→ 归属（市对上用市；市对不上按省放行；连省都认不出也放行）。
 */
function matchCnAreaAlert(alert, cfg) {
  const d = cfg.disasters || {};
  if (alert.cnKind === 'geology') {
    if (d.cnGeology === false) return { hit: false, reason: t('reason.cnGeologyOff') }
  } else if (d.cnRainstorm === false) {
    return { hit: false, reason: t('reason.cnRainstormOff') }
  }
  if (alert.cancelled) return { hit: false, reason: t('reason.clearedMuted') }
  // 等级词与灾种名都是界面用语（不是电文原文）→ 按界面语言取词
  const levelWord = t(NMC_LEVEL_KEY[alert.cnLevel] || 'kind.cnLevelUnknown');
  const kindWord = t(alert.cnKind === 'geology' ? 'kind.cnGeology' : 'kind.cnRainstorm');
  const what = t('kind.cnWhat', { kind: kindWord, level: levelWord });
  const places = (cfg.watch && cfg.watch.places) || [];
  const cnPlaces = cnWatchPlaces(places);
  if (cnPlaces.length === 0) {
    // 没有关注点就明确说明怎么加，不静默；noWatch 让 11-pipeline 把这一类和"命中了但不在列表里"
    // 区分开（前者不进历史），所以它必须排在门槛之前。
    return { hit: false, noWatch: true, reason: NO_CN_WATCH_REASON }
  }
  const rank = typeof alert.cnRank === 'number' ? alert.cnRank : 0;
  if (rank < 3) {
    return { hit: false, reason: t('reason.cnLandslideOnlyRecorded', { what: what }) }
  }
  const area = alert.cnArea || {};
  const province = String(area.province || '');
  const city = String(area.city || '');
  if (city) {
    const hit = cnPlaces.find((p) => p.province === province && p.city === city);
    if (hit) {
      return { hit: true, reason: t('reason.cnHit', { what: what, province: hit.province, city: hit.city }), place: hit.place }
    }
    return {
      hit: false,
      reason: t('reason.cnNotWatched', { what: what, province: province, city: city }),
    }
  }
  // 市级归属未知：省内有任何一个关注点就放行，并在 reason 里说明只定位到省（省直辖县、省台发布、
  // 机构名错字都属这一类）；省名也认不出时按全国放行。
  const sameProv = cnPlaces.filter((p) => !province || p.province === province);
  if (sameProv.length > 0) {
    return {
      hit: true,
      reason: province
      ? t('reason.cnProvinceOnly', { what: what, province: province, org: (area.org || t('reason.cnOrgPlaceholder')) })
      : t('reason.cnNoProvince', { what: what }),
      place: sameProv[0].place,
    }
  }
  return { hit: false, reason: t('reason.cnOrgUnknown', { what: what, org: (area.org || t('reason.cnOrgNameUnknown')) }) }
}

/**
 * 海外气象源的命中判定：**查询即匹配**——取数器按关注点查 NWS 的 `?point=` / ECCC 的 `?bbox=`，
 * 归属在取数时就已确定，这里不算距离。三个判定都是漏报防线：关注点被删了如实说明、档位不够不播报
 * （也不进历史）、取数器没记归属就明确说无法判定。
 */
function matchOverseasAlert(alert, cfg) {
  const d = cfg.disasters || {};
  if (d.overseasWeather === false) return { hit: false, reason: t('reason.overseasWeatherOff') }
  // 防御性守卫：取消 / 解除消息的正常路径在 11-pipeline 里已由 handleCancelled 处理，走到这里
  // 的不是 cancelled。保留是为守住 matchAlert 的对外不变量——cancelled 的消息永不返回 hit。
  if (alert.cancelled) return { hit: false, reason: t('reason.cancelledMuted') }
  const places = (cfg.watch && cfg.watch.places) || [];
  if (places.length === 0) {
    return {
      hit: false,
      noWatch: true,
      reason: t('reason.noOverseasWatch'),
    }
  }
  const origin = alert.originPlace;
  if (!origin) return { hit: false, cannotJudge: true, reason: t('reason.overseasNoOrigin') }
  // 关注点还在不在按"名字 + 坐标"比对（用户只改半径时仍是同一个点）
  const still = places.some((p) => p && p.name === origin.name && p.lat === origin.lat && p.lon === origin.lon);
  if (!still) {
    return { hit: false, reason: t('reason.overseasOriginGone', { place: (origin.name || t('reason.placeUnnamed')) }) }
  }
  const rank = typeof alert.overseasRank === 'number' ? alert.overseasRank : 0;
  if (rank < OVERSEAS_BROADCAST_MIN_RANK) {
    return {
      hit: false,
      reason: t('reason.overseasBelowLevel', { headline: (alert.headline || t('reason.overseasHeadlineFallback')) }),
    }
  }
  return {
    hit: true,
    reason: t('reason.overseasHit', { place: (origin.name || t('reason.placeUnnamed')), headline: (alert.headline || '') }),
    place: origin,
  }
}

function matchAlert(alert, cfg) {
  const w = cfg.watch || {};
  // 局部变量不能叫 `t`：那是 00-i18n 的取词函数，遮蔽之后本函数里的 t('reason…') 会变成调用
  // 配置对象（TypeError）；check-imports 会拦这种遮蔽。
  const th = cfg.thresholds || {};
  // 这条消息里是否存在能归到县的区域：决定"归不到县的区域"要不要放行（见 regionInWatch）
  const anyPref = (alert.regions || []).some((r) => !!r.pref);
  if (alert.kind === 'eew' || alert.kind === 'quake') {
    if ((cfg.disasters || {}).earthquake === false) return { hit: false, reason: t('reason.quakeOff') }
    if (alert.cancelled) return { hit: false, reason: t('reason.cancelledMuted') }
    // 全球源（EMSC / USGS）只有震中坐标、没有行政区区域 → 走坐标匹配
    if (alert.locator === 'point') return matchPointAlert(alert, cfg)
    // 551 的「震源情报 / 远地地震」没有 points，无从按震度判定
    if (alert.regions.length === 0) {
      return {
        hit: false,
        cannotJudge: true,
        reason: alert.kind === 'eew' ? t('reason.eewNoAreaData') : t('reason.hypocenterOnly'),
      }
    }
    const threshold = alert.kind === 'eew' ? th.eewScale : th.quakeScale;
    const hitRegion = alert.regions.find((r) => regionInWatch(r, w, alert.kind === 'quake', anyPref) && typeof r.scale === 'number' && r.scale >= threshold);
    return hitRegion
      ? { hit: true, reason: alert.kind === 'eew' ? t('reason.hitEewScale') : t('reason.hitObservedScale'), region: hitRegion }
      : { hit: false, reason: missReason(alert, w, t('reason.quakeMissed')) }
  }
  if (alert.kind === 'tsunami') {
    if ((cfg.disasters || {}).tsunami === false) return { hit: false, reason: t('reason.tsunamiOff') }
    if (alert.cancelled) return { hit: false, reason: t('reason.clearedMuted') }
    // NOAA CAP 的海啸同样是坐标型（CAP 里给的是 circle / polygon，不是津波予報区）
    if (alert.locator === 'point') return matchPointAlert(alert, cfg)
    if (alert.regions.length === 0) return { hit: false, cannotJudge: true, reason: t('reason.noTsunamiAreas') }
    const minRank = own(TSUNAMI_RANK, th.tsunamiGrade) || 1;
    const hitRegion = alert.regions.find((r) => regionInWatch(r, w, false, anyPref) && (own(TSUNAMI_RANK, r.grade) || 0) >= minRank);
    return hitRegion
      ? { hit: true, reason: t('reason.hitTsunamiGrade'), region: hitRegion }
      : { hit: false, reason: missReason(alert, w, t('reason.tsunamiMissed')) }
  }
  if (alert.kind === 'weather') {
    // 海外气象源走**查询即匹配**：取数器按关注点查，归属在取数时已定，这里不做距离计算
    if (alert.locator === 'overseas') return matchOverseasAlert(alert, cfg)
    // 大陆气象源走**行政区层级**匹配，多一道等级门槛（橙色及以上才播报）
    if (alert.locator === 'area') return matchCnAreaAlert(alert, cfg)
    if ((cfg.disasters || {}).weather === false) return { hit: false, reason: t('reason.weatherOff') }
    if (alert.cancelled) return { hit: false, reason: t('reason.clearedMuted') }
    if (alert.regions.length === 0) return { hit: false, cannotJudge: true, reason: t('reason.jmaNoUsableArea') }
    // 播报边界写死在 L4：L1〜L3 仍然解析，但既不播报也不进历史（L3 是「高齢者等避難」，L4 才是
    // 避难指示级）。是否播报必须看命中地区**自己的**级别，不能看电文最大值：同一条 VPWW55 里姫路市 L4、
    // 相生市 L3、西脇市 L2 是常态，用电文最大值会把只到 L2 的地区播成「警戒レベル4」，还让市级收窄
    // 失去意义。region.level 缺失时（老对象 / 类型未识别）回退电文级别。
    const lvOf = (r) => (typeof r.level === 'number' ? r.level : alert.level);
    const hitRegion = alert.regions.find((r) => regionInWeatherWatch(r, w) && lvOf(r) >= 4);
    if (!hitRegion) {
      const anyL4 = alert.regions.some((r) => lvOf(r) >= 4);
      return {
        hit: false,
        reason: missReason(alert, w, anyL4
          ? t('reason.weatherMissedL4')
          : t('reason.weatherBelowL4', { level: (alert.level || '—') })),
      }
    }
    return {
      hit: true,
      reason: t('reason.hitLevel', { level: lvOf(hitRegion), area: (hitRegion.city || hitRegion.area) }),
      region: hitRegion,
    }
  }
  return { hit: false, cannotJudge: true, reason: t('reason.unsupportedCode') }
}

// ============================================================================
// dsh-quake-alert · client/src/08-audio.js
// 作用：提示音合成（Web Audio，零音频文件）——AudioContext 懒创建与解锁、按灾害类型选音色播放。
// 依赖：01-constants。浏览器要求 AudioContext 先经一次用户交互才能出声，故有 unlock 逻辑。
// ============================================================================

// ---------- 音频（Web Audio 合成，零文件） ----------
let audioCtx = null;
function ensureAudio() {
  if (audioCtx === null && typeof window !== 'undefined') {
    const Ctor = window.AudioContext || window.webkitAudioContext;
    if (Ctor) { try { audioCtx = new Ctor(); } catch (err) { audioCtx = null; } }
  }
  return audioCtx
}
function unlockAudio() {
  const ctx = ensureAudio();
  if (ctx && ctx.state === 'suspended') ctx.resume().catch(() => {});
}
/** 当前音频可用状态：'running' | 'suspended' | 'unavailable'，设置页据此提示尚未解锁。 */
function audioState() {
  // 不能调用 ensureAudio()：它真的会 new AudioContext，设置页渲染读本函数时会在无用户手势的
  // 情况下创建音频上下文。未创建同样属于"未解锁"，按 suspended 回答。
  if (typeof window !== 'undefined' && !(window.AudioContext || window.webkitAudioContext)) return 'unavailable'
  if (audioCtx === null) return 'suspended'
  return audioCtx.state === 'running' ? 'running' : 'suspended'
}
// 音色描述：notes 列表（freq Hz / start s / dur s / type）
const SOUNDS = {
  eew: { notes: [
    { freq: 932, start: 0, dur: 0.12, type: 'square' },
    { freq: 932, start: 0.22, dur: 0.12, type: 'square' },
    { freq: 1244, start: 0.44, dur: 0.5, type: 'square' },
  ] },
  tsunami: { notes: [
    { freq: 196, start: 0, dur: 0.9, type: 'sawtooth' },
    { freq: 147, start: 0.7, dur: 1.1, type: 'sawtooth' },
  ] },
  quake: { notes: [
    { freq: 659, start: 0, dur: 0.18, type: 'sine' },
    { freq: 880, start: 0.2, dur: 0.3, type: 'sine' },
  ] },
  // 气象警报（泥石流 / 洪水 / 大雨 / 高潮）：下行三音 + triangle 波形，与地震 / EEW / 海啸区分开
  weather: { notes: [
    { freq: 587, start: 0, dur: 0.22, type: 'triangle' },
    { freq: 494, start: 0.26, dur: 0.22, type: 'triangle' },
    { freq: 392, start: 0.52, dur: 0.6, type: 'triangle' },
  ] },
  // 取消 / 解除：下行音，与「警报」区分开
  cancel: { notes: [
    { freq: 880, start: 0, dur: 0.16, type: 'sine' },
    { freq: 659, start: 0.18, dur: 0.34, type: 'sine' },
  ] },
  test: { notes: [
    { freq: 784, start: 0, dur: 0.16, type: 'sine' },
    { freq: 1046, start: 0.18, dur: 0.3, type: 'sine' },
  ] },
};
function playSound(kind, volume) {
  const preset = SOUNDS[kind] || SOUNDS.test;
  const ctx = ensureAudio();
  if (!ctx) return
  const vol = typeof volume === 'number' && volume >= 0 && volume <= 1 ? volume : 0.7;
  const doPlay = () => {
    const master = ctx.createGain();
    master.gain.value = vol * 0.5;
    master.connect(ctx.destination);
    const t0 = ctx.currentTime;
    const nodes = []; // 这次播放创建的所有节点，播完统一断开
    let endAt = 0;
    for (const n of preset.notes) {
      const osc = ctx.createOscillator();
      const g = ctx.createGain();
      osc.type = n.type || 'sine';
      osc.frequency.value = n.freq;
      const start = t0 + n.start;
      g.gain.setValueAtTime(0.0001, start);
      g.gain.exponentialRampToValueAtTime(1, start + 0.02);
      g.gain.setValueAtTime(1, start + n.dur - 0.08);
      g.gain.exponentialRampToValueAtTime(0.0001, start + n.dur);
      osc.connect(g); g.connect(master);
      osc.start(start); osc.stop(start + n.dur + 0.05);
      nodes.push(osc, g);
      if (n.start + n.dur > endAt) endAt = n.start + n.dur;
    }
    // 播完断开：osc.stop() 只是停止发声，节点仍挂在 destination 上，长期运行会一直累积
    setTimeout(() => {
      for (const node of nodes) { try { node.disconnect(); } catch (err) { /* 已断开等忽略 */ } }
      try { master.disconnect(); } catch (err) { /* 忽略 */ }
    }, Math.ceil((endAt + 0.3) * 1000));
  };
  if (ctx.state === 'suspended') ctx.resume().then(() => { if (ctx.state === 'running') doPlay(); }).catch(() => {});
  else doPlay();
}
/** 按灾害类型选音色（纯函数，便于断言气象不再沿用地震音）。 */
function soundKindOf(alert) {
  if (!alert) return 'test'
  if (alert.kind === 'eew') return 'eew'
  if (alert.kind === 'tsunami') return alert.maxScale >= 3 ? 'tsunami' : 'quake'
  if (alert.kind === 'weather') return 'weather'
  return 'quake'
}
function playAlertSound(alert, volume) {
  playSound(soundKindOf(alert), volume);
}
/**
 * 这条提醒该不该**发声**：`notify.sound` 是总开关，三个分开关按灾种类别细分——地震（含 EEW）/ 海啸 /
 * 气象；认不出的 kind（测试音等）只看总开关。
 */
function soundAllowedFor(cfg, alert) {
  const n = (cfg && cfg.notify) || {};
  if (n.sound === false) return false
  const k = soundKindOf(alert);
  if (k === 'eew' || k === 'quake') return n.soundQuake !== false
  if (k === 'tsunami') return n.soundTsunami !== false
  if (k === 'weather') return n.soundWeather !== false
  return true
}

// ============================================================================
// dsh-quake-alert · client/src/10-dedupe.js
// 作用：三层去重（消息 id 防重放、事件键合并同一地震的多次发布、跨标签页抢占）与「已提醒事件」记忆。
// 依赖：01-constants、07-store（通道建立时机在 15-entry 的 apply 里）、06-matcher（坐标型近似归并）。
// 通道监听必须在插件加载时就建立，否则会错过其它标签页的广播。
// ============================================================================


// ---------- 去重 ----------
// 时钟回拨（NTP 校正 / 用户改时间 / 休眠唤醒）时把记录时间夹到 now，而不是删除：删掉等于一次性
// 清空去重记忆，本该被窗口抑制的重复消息会重新播报。
const seen = new Map(); // id -> { ts, win }
function isDuplicate(id, windowMinutes) {
  if (!id) return false
  const now = Date.now();
  const win = Math.max(1, windowMinutes || 10) * 60 * 1000;
  for (const [k, v] of seen) {
    // 清理要用**这条记录自己的窗口**，不是本次调用的窗口——本次的窗口可能属于另一个源 / 另一段设置
    const ts = typeof v === 'object' && v !== null ? v.ts : v;
    const own = (typeof v === 'object' && v !== null && typeof v.win === 'number') ? v.win : win;
    if (ts > now) { seen.set(k, { ts: now, win: own }); continue }
    if (now - ts > own) seen.delete(k);
  }
  const prev = seen.get(id);
  if (prev) {
    // 命中即刷新时间戳：窗口语义是"这段时间内见过就算重复"，不是"首次见到起算"
    const own = typeof prev.win === 'number' ? prev.win : win;
    seen.set(id, { ts: now, win: own });
    return true
  }
  seen.set(id, { ts: now, win });
  return false
}
// 同一次地震会连发「震度速报 → 震源情报 → 各地震度」或 EEW 多报（serial 递增）：消息 id 各不相同，
// 但共享事件键；只有强度升级时才再提醒一次。
//
// 坐标型源另存发震时刻与震中：eventKey 是「分钟 + 0.1 度」的指纹，而源的定位与发震时刻都会浮动，
// 任一处跨过量化边界就会算出不同的键（EMSC 与 USGS 因此各响一次）——所以键未命中时再按
// 「±2 分钟 + 50km」找一次。
const GEO_NEAR_MS = 2 * 60 * 1000;
const GEO_NEAR_KM = 50;
/** 强度是否可用于比较：只有有限数值才算数。 */
const isFiniteStrength = (v) => typeof v === 'number' && Number.isFinite(v);
const eventSeen = new Map(); // eventKey -> { ts, strength, at, geo, source, win, kind, test }
function issuedMsOf(alert) {
  // 局部变量不叫 `t`（那是 00-i18n 的取词函数）
  const ms = Date.parse(String((alert && alert.issued) || ''));
  return Number.isFinite(ms) ? ms : null
}
/**
 * 找"这一条可能对应的先前事件记录"：先查精确事件键，未命中再按「±2 分钟 + 50km」找。
 * `allowSameSource` 决定近似那一级要不要排除同源：isEventRepeat 传 false（同源修订复用同一个消息
 * id，同源两次不同地震被归并就是漏报），isStrengthUpgrade 传 true（调用方已确定是同一条消息的再次
 * 到达）。判据是「有没有可用震中」而不是「locator 是不是 point」：日本源（551 / 556）也带 geo 并参与
 * 事件归并，但仍走行政区匹配。
 */
function findPrevEvent(alert, allowSameSource) {
  const prev = eventSeen.get(alert.eventKey);
  if (prev) return prev
  if (!validGeo(alert.geo)) return null
  const at = issuedMsOf(alert);
  if (at === null) return null
  if (String(alert.eventKey || '').indexOf('test:') === 0) return null // 测试消息每次都是独立演示
  const source = sourceIdOf(alert);
  for (const v of eventSeen.values()) {
    if (!v.geo || typeof v.at !== 'number') continue
    if (!allowSameSource && source && v.source && v.source === source) continue
    // 候选也要过滤：灾种不同、或对方是演示消息，就不该算"同一事件的副本"（否则跨源不比 strength，
    // 一条海啸警报可能被附近的地震记录压成静默）
    if (v.test) continue
    if (v.kind && alert.kind && v.kind !== alert.kind) continue
    if (Math.abs(v.at - at) <= GEO_NEAR_MS && distanceKm(alert.geo.lat, alert.geo.lon, v.geo.lat, v.geo.lon) <= GEO_NEAR_KM) {
      return v
    }
  }
  return null
}

/**
 * 事件键级去重：同一条事件键此前见过且强度未升级 → 判重复。
 * @param {number} [nowMs] 注入点（测试用）：`Date.now()` 不可注入时跨时间行为无法测试。
 */
function isEventRepeat(alert, windowMinutes, nowMs) {
  if (!alert.eventKey) return false
  const now = (typeof nowMs === 'number' && Number.isFinite(nowMs)) ? nowMs : Date.now();
  const win = Math.max(1, windowMinutes || 10) * 60 * 1000;
  for (const [k, v] of eventSeen) {
    if (v.ts > now) { v.ts = now; continue }
    // 清理要用**这条记录自己的窗口**，不是本次调用的窗口：否则按 3 小时窗口记住的气象事件会被
    // 10 分钟后任意一条命中地震带着的 10 分钟窗口清掉，随后的更新就被判成新事件而重复响铃。
    // 旧记录没有 win 字段时退回本次调用的窗口。
    const own = typeof v.win === 'number' ? v.win : win;
    if (now - v.ts > own) eventSeen.delete(k);
  }
  const prev = findPrevEvent(alert, false);
  // 强度必须是有限数值才参与比较（缺失时 undefined <= x 恒为 false，这条消息永远不被判重复）；
  // 方向与全项目一致：说不清是不是升级 → 放行。
  if (prev && isFiniteStrength(alert.strength) && alert.strength <= prev.strength) return true
  const at = issuedMsOf(alert);
  const geo = validGeo(alert.geo) ? { lat: alert.geo.lat, lon: alert.geo.lon } : null;
  // kind / test 一并存下来：findPrevEvent 的近似那一级靠它们过滤候选
  eventSeen.set(alert.eventKey, {
    ts: now,
    strength: alert.strength,
    at,
    geo,
    source: sourceIdOf(alert),
    win,
    kind: String(alert.kind || ''),
    test: String(alert.eventKey || '').indexOf('test:') === 0,
  });
  return false
}

// ---------- 跨源优先源 ----------
// 日本源（551 / 552 / 556）的解析器不设 `source` 字段（历来靠数字 code 认源），故在这里按 code 补。
const SOURCE_BY_CODE = { 551: 'p2pquake', 552: 'p2pquake', 556: 'p2pquake' };
function sourceIdOf(alert) {
  if (!alert) return ''
  const s = String(alert.source || '');
  if (s) return s
  const code = (alert.code === undefined || alert.code === null) ? '' : String(alert.code);
  return own(SOURCE_BY_CODE, code) || ''
}
/**
 * 源的权威序（数字越小越"本地权威"）：1 日本 P2PQuake、2 大陆预警 cenc_eew、3 大陆速报
 * cenc_eqlist、4 USGS / EMSC、5 NOAA。它不决定谁先播（先到者播是时序决定的，低优先级源先播、
 * 高优先级源后到也不补播），只服务诊断文案。
 */
const SOURCE_RANK = { p2pquake: 1, cenc_eew: 2, cenc_eqlist: 3, usgs: 4, emsc: 4, noaa: 5 };
/**
 * 源的**机构**归属：跨源归并只在跨机构时成立。同机构（EEW → 速报）是同一份信息的演进，仍走
 * isEventRepeat（记历史、强度升级放行）；跨机构（日本台网 / USGS / EMSC）是同一件事的重复转述，
 * 才按优先源规则抑制。`p2pquake` 与 `jma` 同属気象庁（P2PQuake 只是转播渠道）。
 */
const SOURCE_AGENCY = {
  p2pquake: 'jma', jma: 'jma',
  cenc_eew: 'cenc', cenc_eqlist: 'cenc',
  usgs: 'usgs', emsc: 'emsc', noaa: 'noaa',
};
const agencyOf = (id) => {
  const key = String(id === undefined || id === null ? '' : id);
  const v = own(SOURCE_AGENCY, key);
  return v || key // 认不出的源用它自己当机构名：两个未知源只在 id 相同时才算同一机构
};
/** 参与跨源归并的灾种：只有地震类有"多个源报同一件事"的形态。 */
const CROSS_SOURCE_KINDS = { quake: true, eew: true, tsunami: true };
// 源显示名走 00f 的 settings.sourceLabels.*（四语的唯一映射）；认不出的源退回 id 本身。
const sourceNameOf = (id) => sourceLabelOf(id) || String(id || t('reason.sourceUnknown'));
const rankOfSource = (id) => {
  const v = own(SOURCE_RANK, String(id === undefined || id === null ? '' : id));
  return typeof v === 'number' ? v : 9
};
const sourceZhOf = (id) => sourceNameOf(id);

/**
 * 这条是不是**同一事件在另一个源上的副本**？只对地震类、且只对**跨机构**生效。
 * @returns {{source: string, mine: string, rank: number, mineRank: number}|null}
 *   `source` = 已经播报过的那个源（null = 不是跨源副本，交给 isEventRepeat）。
 *
 * 判据只有 findPrevEvent(alert, false) 一条路径（先精确事件键，再「±2 分钟 + 50km」，排除同源）。
 * **跨源不比 strength**：日本给的是震度、全球给的是震级，两者不可换算。
 */
function crossSourceCopyOf(alert) {
  if (!alert || !alert.eventKey) return null
  if (!own(CROSS_SOURCE_KINDS, String(alert.kind || ''))) return null
  if (String(alert.eventKey).indexOf('test:') === 0) return null // 测试消息每次都是独立演示
  const mine = sourceIdOf(alert);
  if (!mine) return null
  const prev = findPrevEvent(alert, false);
  if (!prev) return null
  const other = String(prev.source || '');
  if (!other || other === mine) return null
  if (agencyOf(other) === agencyOf(mine)) return null // 同机构：8.3 那条链路，交给 isEventRepeat
  return { source: other, mine, rank: rankOfSource(other), mineRank: rankOfSource(mine) }
}

/** 被优先源压掉的条数：被抑制的条目连历史都不进，所以计数必须另留一处供诊断读取。 */
const authorityStats = { suppressed: 0, bySource: {}, lastAt: 0, lastDetail: '' };
function noteAuthoritySuppressed(info, alert) {
  authorityStats.suppressed += 1;
  const k = String(info.source || '');
  authorityStats.bySource[k] = (authorityStats.bySource[k] || 0) + 1;
  authorityStats.lastAt = Date.now();
  authorityStats.lastDetail = t('reason.authoritySuppressed', { source: sourceZhOf(info.source), mine: sourceZhOf(info.mine) });
  return authorityStats.lastDetail
}
function authorityStatsOf() {
  return {
    suppressed: authorityStats.suppressed,
    bySource: Object.assign({}, authorityStats.bySource),
    lastAt: authorityStats.lastAt || null,
    lastDetail: authorityStats.lastDetail,
  }
}

/**
 * 让事件键的强度**回落**（降级电文调用），返回是否真的降了。气象电文的 L4 → L3 → L2 是同一次
 * 灾害过程的强度回落，但记忆里的 strength 必须跟着降，否则"降级之后再次升级"会被判成"强度未
 * 升级的重复发布"而永久静默。只在强度确实更低时下调。
 */
function weakenEvent(alert) {
  if (!alert || !alert.eventKey) return false
  const prev = eventSeen.get(alert.eventKey);
  if (!prev || typeof alert.strength !== 'number') return false
  if (alert.strength < prev.strength) { prev.strength = alert.strength; return true }
  return false
}
/**
 * 只读探测：同一个事件键此前见过、且这一条的强度更高吗？消息级去重（isDuplicate，按 alert.id）
 * 排在事件级去重之前，而同一个消息 id 可能携带升级后的内容——EMSC 修订复用同一个 unid、
 * USGS 震级复核后刷新 properties.updated。若只按 id 挡掉，震级上修（M5.2 → M6.4）永远不会再提醒。
 *
 * 本函数不修改任何状态（登记由 isEventRepeat 负责）。时钟回拨（ts > now）按"未见过"处理。
 */
function isStrengthUpgrade(alert) {
  if (!alert || !alert.eventKey) return false
  // 必须走 findPrevEvent（含坐标近似）：源修订会把坐标挪过 0.1° 桶、或让发震时刻跨分钟，
  // 精确键随之改变，只查精确键就会把"震级上修"误判成"重复发布"而静默
  const prev = findPrevEvent(alert, true);
  if (!prev) return false
  if (prev.ts > Date.now()) return false
  return alert.strength > prev.strength
}
/**
 * 忘掉一个事件键，解除 / 取消时调用：灾害过程已结束后再发布同一个键（同一官署 + 同一灾种）
 * 是新事件，必须能重新播报，否则长事件窗口（气象 3 小时）会把"解除后再次发布"当成重复而静默。
 */
function forgetEvent(eventKey) {
  if (eventKey) eventSeen.delete(eventKey);
}
// 已实际提醒过的事件（eventKey → ts），供取消 / 解除判断"此前是否确实提醒过同一事件"。
// 这份记忆与"事件级去重的窗口"（11-pipeline 的 WEATHER_EVENT_WINDOW_MINUTES，180 分钟）是两件事：
// 这里的 24 小时按"一条气象事件可能持续多久"取（实测发布到解除可相隔 5 小时）。
const ALERTED_MAX_MS = 1440 * 60 * 1000;
const alertedEvents = new Map();
/**
 * 把"真正播报过的事件"写进 localStorage：Host 重启后会按首次启动回看窗口重新投递缓冲里的事件，
 * 而消息级去重只有 10 分钟、事件级只有 3 小时，不持久化就会重报。先清理再写入本地存储，只写有限数值。
 */
function persistAlerted() {
  const now = Date.now();
  const out = {};
  for (const [k, v] of alertedEvents) {
    if (typeof v !== 'number' || !Number.isFinite(v)) continue
    if (v > now) { alertedEvents.set(k, now); out[k] = now; continue }
    if (now - v > ALERTED_MAX_MS) { alertedEvents.delete(k); continue }
    out[k] = v;
  }
  saveJSON(ALERTED_KEY, out);
}
/** 启动时读回：认不出的形状当"没有记忆"，过期条目直接丢掉。 */
function loadAlerted() {
  const raw = loadJSON(ALERTED_KEY, null);
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return
  const now = Date.now();
  for (const k of Object.keys(raw)) {
    const v = raw[k];
    if (typeof v !== 'number' || !Number.isFinite(v)) continue
    const ts = v > now ? now : v;
    if (now - ts > ALERTED_MAX_MS) continue
    alertedEvents.set(k, ts);
  }
}
loadAlerted();
/**
 * 取消 / 解除的匹配键。不留 kind 兜底：事件键为空的 alert 若退化成 kind，任意一条海啸解除都会
 * 匹配上"此前提醒过的任意海啸事件"而播出一条假解除。空键返回空串，调用方会跳过它。
 */
const cancelKeyOf = (alert) => (alert && alert.eventKey) || '';
function rememberAlerted(alert) {
  const key = cancelKeyOf(alert);
  if (!key) return
  const now = Date.now();
  for (const [k, v] of alertedEvents) {
    if (v > now) { alertedEvents.set(k, now); continue }
    if (now - v > ALERTED_MAX_MS) alertedEvents.delete(k);
  }
  alertedEvents.set(key, now);
  persistAlerted();
}
/** 忘掉"此前提醒过"的某个事件；删除也要写入本地存储，否则刷新后那条已取消的事件又变回"提醒过"。 */
function forgetAlerted(alert) {
  const key = cancelKeyOf(alert);
  if (!key) return
  if (alertedEvents.delete(key)) persistAlerted();
}
/**
 * 清空**整份**"此前提醒过"的记忆（内存 + 磁盘）。只清内存或只清一半会让同一条解除在两个标签页
 * 上得出相反结论，任意一页刷新后记忆也会从 ALERTED_KEY 复活。
 */
function forgetAllAlerted() {
  alertedEvents.clear();
  try { saveJSON(ALERTED_KEY, {}); } catch (err) { /* 写入本地存储失败：内存已清，下一次写入会覆盖 */ }
}
/**
 * 取消 / 解除消息是否有"此前确实提醒过的同一事件"。窗口必须与 alertedEvents 的保留期（24 小时）
 * 一致，不能用 dedupe.windowMinutes（默认 10 分钟）：解除必然晚于发布（实测发布到解除相隔 5 小时）。
 */
function wasRecentlyAlerted(alert) {
  const key = cancelKeyOf(alert);
  if (!key) return false
  const v = alertedEvents.get(key);
  if (typeof v !== 'number') return false
  const now = Date.now();
  if (v > now || now - v > ALERTED_MAX_MS) { alertedEvents.delete(key); return false }
  return true
}
// 多开 DSH 页面时每个标签页都会收到同一条推送；用 BroadcastChannel 协商，只让一个标签页播报。
// 通道必须在插件加载时就建立监听，否则后加载的标签页会错过先到的广播；不支持 BroadcastChannel
// 时退化为「各标签页各自提醒」。
//
// TTL 取 10 分钟：真正会重复播报的是**先被冻结、后恢复**的标签页——恢复后它才拉到同一批 entry，
// 5 秒窗口早已过期；10 分钟与消息级去重窗口一致。
const TAB_DEDUPE_MS = 10 * 60 * 1000;
const tabAlerted = new Map(); // key -> ts
let alertChannel = null;
function ensureAlertChannel() {
  if (alertChannel !== null || typeof window === 'undefined' || typeof window.BroadcastChannel !== 'function') return alertChannel
  try {
    alertChannel = new window.BroadcastChannel('dsh-quake-alert');
    alertChannel.onmessage = (ev) => {
      const d = ev && ev.data;
      if (!d) return
      // 另一个标签页清空了历史 → 本标签页也要清（否则它的下一次 addEvent 会把整份记录写回磁盘）
      if (d.type === 'history-cleared') {
        alertedEvents.clear();
        try { saveJSON(ALERTED_KEY, {}); } catch (err) { /* 写入本地存储失败：内存已清 */ }
        // **内存副本与磁盘都要清**：只清 alertedEvents 的话，本标签页的历史列表仍显示那些条目，
        // 下一次 addEvent 会把它们（连同新条目）重新写回 localStorage。
        store.push({ events: [] });
        try { saveJSON(HISTORY_KEY, []); } catch (err) { /* 写入本地存储失败：内存已清，下次 addEvent 会覆盖 */ }
        return
      }
      if (d.type !== 'alerted' || !d.key) return
      tabAlerted.set(String(d.key), Date.now());
      // 顺带同步事件键：其它标签页此前提醒过的事件，本标签页在收到取消消息时也要知道
      if (d.eventKey) alertedEvents.set(String(d.eventKey), Date.now());
    };
  } catch (err) { alertChannel = null; }
  return alertChannel
}
/** 抢占这条提醒：已被本标签页抢占过则返回 false，抢占成功则广播给其它标签页。 */
function claimAlertForTab(key, eventKey) {
  if (!key) return true
  const now = Date.now();
  for (const [k, v] of tabAlerted) {
    if (v > now) { tabAlerted.set(k, now); continue }
    if (now - v > TAB_DEDUPE_MS) tabAlerted.delete(k);
  }
  if (tabAlerted.has(key)) return false
  tabAlerted.set(key, now);
  if (ensureAlertChannel()) {
    try { alertChannel.postMessage({ type: 'alerted', key, eventKey: eventKey || '' }); } catch (err) { /* 通道已关闭等忽略 */ }
  }
  return true
}
/** 广播「历史已清空」，让其它标签页同步清掉内存副本与磁盘（见 13-ui-settings 的清空按钮）。 */
function broadcastHistoryCleared() {
  if (ensureAlertChannel()) {
    try { alertChannel.postMessage({ type: 'history-cleared' }); } catch (err) { /* 忽略 */ }
  }
}


// 通道关闭
function closeAlertChannel() {
  try { if (alertChannel) { alertChannel.close(); alertChannel = null; } } catch (err) { /* 忽略 */ }
}

// ============================================================================
// dsh-quake-alert · client/src/11-pipeline.js
//
// 作用：主链——收到一条原始消息后的完整处理顺序（解析 → 去重 → 匹配 → 静默时段 →
//       跨标签页抢占 → 通知 → 历史）；handleCancelled 处理取消 / 解除（仅对已提醒过的事件）。
// 依赖：05-parser、06-matcher、07-store、08-audio、09-notify、10-dedupe、01-constants、00-i18n。
// ============================================================================


/**
 * 气象灾害的**事件窗口**（分钟）：同一官署同一灾种在此窗口内的后续电文只记历史，强度升级仍提醒。
 * 气象灾害是持续过程、多次发布的强度通常不变，默认 10 分钟窗口会让每条更新重新响铃。
 * 与 10-dedupe 的 `ALERTED_MAX_MS`（24 小时，判"这条解除是否对应提醒过的事件"）不是同一个窗口。
 */
const WEATHER_EVENT_WINDOW_MINUTES = 180;

// ---------- 主链：收到消息 ----------
// 区域文案：府県予報区级条目的 area 与 pref 常同名，直接拼接会显示成「東京都東京都」。
function areaLabelOf(region) {
  const name = region.city || region.area || '';
  if (!name) return region.pref || ''
  if (!region.pref || name === region.pref || name.indexOf(region.pref) === 0) return name
  return region.pref + name
}

/** 大陆源的产品名：日本源与大陆源是两家机构的不同产品（緊急地震速報 / 地震预警），名称不可互套。 */
function cnProductName(alert) {
  if (!alert) return ''
  if (alert.source === 'cenc_eew') return t('product.cnEew')
  if (alert.source === 'cenc_eqlist') return t('product.cnEqlist')
  return ''
}

/**
 * 通知文案里的「官方发布」指哪家机构：各源主管机构完全不同，认不出时退化成中性表述。
 * 值存文案表的 key 而不是名字本身——机构归属与语言无关，名字要随界面语言走（00a-texts-core.js）。
 */
const AUTHORITY_BY_SOURCE = {
  emsc: 'authority.emsc',
  usgs: 'authority.usgs',
  noaa: 'authority.noaa',
  cenc_eew: 'authority.cenc',
  cenc_eqlist: 'authority.cenc',
  // 大陆气象预警的发布主体是各级气象台，汇总在中央气象台（中国气象局）的网站上。
  nmc_alarm: 'authority.cma',
  // 海外气象源（美国 NWS / 加拿大 ECCC）。
  nws_alerts: 'authority.nws',
  eccc_alerts: 'authority.eccc',
  jma: 'authority.jma',
};
function authorityOf(alert) {
  if (!alert) return ''
  const bySource = own(AUTHORITY_BY_SOURCE, String(alert.source || ''));
  if (bySource) return t(bySource)
  const byCode = own(AUTHORITY_BY_SOURCE, String(alert.code === undefined ? '' : alert.code));
  if (byCode) return t(byCode)
  // P2PQuake 的 551 / 552 / 556 都是转播気象庁的信息（只有数字 code，没有 source）
  if (alert.code === 551 || alert.code === 552 || alert.code === 556) return t('authority.jma')
  return ''
}
/** 「仅供参考」那一行：机构已知时点名，未知时用中性表述。 */
function disclaimerOf(alert) {
  const a = authorityOf(alert);
  return a ? t('disclaimer.named', { authority: a }) : t('disclaimer.generic')
}

/**
 * 气象预警的**行动提示**，按机构分岔：日本气象电文 → 市町村级的避难信息（日本の避難情報）；
 * 大陆气象预警 → 各级气象台发布的防御指引（没有"市町村"这个行政层级）；
 * 海外气象（NWS / ECCC）→ 当地官方发布的避难与撤离指引；认不出来源退回中性表述（action.generic）。
 */
function weatherActionHintOf(alert) {
  if (!alert) return t('action.generic')
  if (alert.locator === 'overseas') return t('action.overseas')
  if (alert.locator === 'area') return t('action.cnArea')
  return t('action.jp')
}

/** 系统通知 / 页内 toast 的标题。 */
function alertTitleOf(alert) {
  if (!alert) return t('app.name')
  // kindLabel 已含灾种与「（警报）」等级，不另拼后缀；分级是安全信息，不可省略。
  if (alert.kind === 'eew') return '⚠ ' + (cnProductName(alert) || t('product.jpEew'))
  if (alert.kind === 'quake') return '🌐 ' + alert.kindLabel
  if (alert.kind === 'tsunami') return '🌊 ' + alert.kindLabel
  if (alert.kind === 'weather') return '🌧 ' + alert.kindLabel
  return t('app.name')
}

/**
 * 命中之后的 severity：决定通知配色，也决定静默时段能否穿透。
 * 日本地震按命中区域的震度判定（非 headline 里的最大震度），EEW 恒为 red，海啸 / 气象用解析层算好的值。
 * 坐标型全球源（`locator === 'point'`）的 `maxScale` 恒为 -1，必须用解析层按震级判定的 `severity`，
 * 否则强震会被算成 `info`，既显示不出严重性、也会被静默时段当成非红色等级吞掉。
 */
function hitSeverityOf(alert, m) {
  if (!alert || alert.kind !== 'quake') return alert ? alert.severity : 'info'
  if (alert.locator === 'point') return alert.severity
  const scale = (m && m.region && typeof m.region.scale === 'number') ? m.region.scale : alert.maxScale;
  return severityOfScale(scale)
}

// 气象警报的「静默提示」：命中关注地区、但未达 L4 所以没有播报时留一笔，供侧边栏悬停提示与设置页显示。
// 命中地区已达 L4（已真正播报）时必须清掉，否则「未达 L4，未播报」的文案与事实矛盾。
// 只对日本气象电文生效：大陆源（`locator === 'area'`）与海外源（`locator === 'overseas'`）的
// `regions` 恒为空数组，它们会走到"清空提示"分支、把日本电文刚留下的提示抹掉。
function updateWeatherHint(alert, cfg) {
  if (alert.kind !== 'weather' || alert.cancelled) return
  if (alert.locator === 'area' || alert.locator === 'overseas') return
  if ((cfg.disasters || {}).weather === false) return
  const w = cfg.watch || {};
  const lvOf = (r) => (typeof r.level === 'number' ? r.level : alert.level);
  // 只看**关注地区自己的级别**：整条电文最大 L4 时关注地区可能只有 L3（提示要保留），
  // 反之命中地区已达 L4（已播报）就该清掉。
  const hit = alert.regions.find((r) => regionInWeatherWatch(r, w) && lvOf(r) === 3);
  const hitL4 = alert.regions.some((r) => regionInWeatherWatch(r, w) && lvOf(r) >= 4);
  if (!hit || hitL4) {
    if (store.weatherHint) store.push({ weatherHint: null });
    return
  }
  store.push({
    weatherHint: { level: 3, label: areaLabelOf(hit), at: Date.now() },
  });
}

// 取消 / 解除消息：仅当此前提醒过同一事件时才补一条「已取消」，否则只记历史（避免打扰）。
function handleCancelled(alert, cfg) {
  if (alert.kind !== 'eew' && alert.kind !== 'tsunami' && alert.kind !== 'weather') return
  const disasters = cfg.disasters || {};
  // 历史条目带上解析层给出的正文（detail）：NWS 的 description + instruction、ECCC 的正文 + 署名
  // 都在其中，`addEvent` 会被 normalizeHistoryEntry 过滤掉未列出的字段（见 07-store / 02-storage）。
  const pushEvent = (fields) => addEvent(Object.assign({ detail: alert.detail }, fields));
  if (alert.kind === 'eew' && disasters.earthquake === false) return
  if (alert.kind === 'tsunami' && disasters.tsunami === false) return
  // 气象的开关按**来源**分岔：海外源由它自己的 `overseasWeather` 管（见 12e 与 13-ui 的设置项）。
  if (alert.kind === 'weather') {
    const off = alert.locator === 'overseas' ? disasters.overseasWeather === false : disasters.weather === false;
    if (off) return
  }
  if (!wasRecentlyAlerted(alert)) {
    pushEvent({
      id: alert.id, code: alert.code, kind: alert.kind, label: alert.kindLabel, severity: alert.severity,
      issued: alert.issued, headline: alert.headline + t('hist.missSuffix', { reason: t('reason.cancelNoPriorAlert') }), hit: false,
    });
    return
  }
  // 取消 / 解除消息不穿透静默（它不是紧急警报，静默期间只记历史）
  if (inQuietHours(cfg)) {
    pushEvent({
      id: alert.id, code: alert.code, kind: alert.kind, label: alert.kindLabel, severity: alert.severity,
      issued: alert.issued, headline: alert.headline, hit: true,
      suppressed: true,
      suppressedReason: t('reason.cancelNoPierceQuiet', { start: cfg.quietHours.start, end: cfg.quietHours.end }),
    });
    return
  }
  // 用 forgetAlerted 从本地存储里删除而不是直接 delete，否则刷新后这条已被取消的事件又变成"提醒过"。
  forgetAlerted(alert); // 同一条取消只提醒一次
  // 灾害过程已结束：忘掉事件键，"解除之后再次发布"才会被当成新事件（见 10-dedupe）
  forgetEvent(cancelKeyOf(alert));
  if (!claimAlertForTab('cancel:' + (alert.id || cancelKeyOf(alert)), '')) {
    pushEvent({
      id: alert.id, code: alert.code, kind: alert.kind, label: alert.kindLabel, severity: alert.severity,
      issued: alert.issued, headline: alert.headline, hit: true,
      suppressed: true, suppressedReason: t('reason.otherTab'),
    });
    return
  }
  pushEvent({
    id: alert.id, code: alert.code, kind: alert.kind, label: alert.kindLabel, severity: alert.severity,
    issued: alert.issued, headline: alert.headline, hit: true,
  });
  const title = alert.kind === 'eew'
    ? '✅ ' + t('notify.cancelTitle', { product: cnProductName(alert) || t('product.jpEewShort') })
    : (alert.kind === 'tsunami' ? t('notify.tsunamiLifted') : '✅ ' + alert.kindLabel);
  const body = alert.headline + '\n' + t('notify.cancelBody') + '\n' + disclaimerOf(alert);
  if (cfg.notify.sound !== false) playSound('cancel', cfg.notify.volume);
  const pageVisible = typeof document !== 'undefined' && document.visibilityState === 'visible';
  if (pageVisible) {
    showToast({ title, body, color: '#4ade80' });
  } else if (cfg.notify.system) {
    const ok = showSystemNotification({ title, body, tag: 'quake-alert-cancel-' + alert.id, silent: true });
    if (!ok) showToast({ title, body, color: '#4ade80', ttlMs: 20000 });
  }
}

function handleRaw(raw, cfg) {
  const alert = parse(raw);
  if (!alert) return
  handleAlert(alert, cfg);
}

/**
 * 处理一条已统一为 Alert 的消息——P2PQuake 的 551/552/556 与気象庁的电文都汇到这里，六步流程一致。
 * @param {{ skipQuietHours?: boolean }} [opts] 仅供设置页的「发送测试气象警报」用（测试不该被静默吞掉）。
 * @returns {{ notified: boolean, reason?: string, detail?: string }} 是否真的播报了，以及没播报的原因。
 */
/** 坐标型全球源在用户**没有配置任何「全球关注点」**时整条丢弃（连历史都不记），配好后立即生效。 */
function watchlessPoint(alert, cfg) {
  if (!alert || alert.locator !== 'point') return false
  const places = (cfg.watch && cfg.watch.places) || [];
  return places.length === 0
}

function handleAlert(alert, cfg, opts) {
  const options = opts || {};
  // 历史条目统一带上解析层的正文（同 handleCancelled）。
  const pushEvent = (fields) => addEvent(Object.assign({ detail: alert.detail }, fields));
  if (watchlessPoint(alert, cfg)) {
    return { notified: false, reason: 'no-watch-point', detail: t('reason.noGlobalWatch') }
  }
  // received 计数用 push 带出去，设置页的"已收到 N 条推送"才会立刻反映（直接自增不会触发重渲）。
  store.push({ received: store.received + 1 });
  // 消息级去重按 alert.id，**但强度升级要放行**：全球源的修订版复用同一个 id（EMSC 的 unid /
  // USGS 的 feature id），一律挡掉会让震级上修永远不再提醒。`isDuplicate` 有登记副作用（见
  // 10-dedupe），只求值一次并留用；`upgrading` 还要供**跨标签页抢占**用：抢占记忆按消息 id 保留
  // 10 分钟，不绕开的话同 id 的修订版会被本标签页上一次的抢占挡下（震级上修被静默）。
  const dup = isDuplicate(alert.id, cfg.dedupe.windowMinutes);
  const upgrading = dup && isStrengthUpgrade(alert);
  if (dup && !upgrading) {
    return { notified: false, reason: 'duplicate', detail: t('reason.duplicateMessage') }
  }
  if (alert.cancelled) {
    handleCancelled(alert, cfg);
    return { notified: false, reason: 'cancelled', detail: t('reason.clearedIsNotAlert') }
  }
  const m = matchAlert(alert, cfg);
  // 气象强度的**回落**要在命中与未命中两条路径上都写回事件记忆：海外气象源的档位由 event 名
  // （NWS）或颜色档（ECCC）决定、强度由 severity 决定，两条正交，"命中但降级"也会发生。
  // 只对气象下调"已播报强度"，不推广到另外两个灾种：551 的「震源情报」`strength` 是 -1，
  // 而它与该地震的「各地震度」共用同一个事件键（都取自 `earthquake.time`），下调会让同一场地震的
  // 各地震度被 `isStrengthUpgrade` 判成"升级"再响一次；海啸（552）没有可归并的事件 id。
  if (alert.kind === 'weather') weakenEvent(alert);
  if (!m.hit) {
    // 气象警报：即使不播报（L3 及以下），也把"正在升级"留给侧边栏 tooltip
    updateWeatherHint(alert, cfg);
    // "没命中 / 未达档位"的条目一律不进历史（否则历史会被 L1〜L3 与 Watch/Advisory 占满）；
    // `m.noWatch`（未配置关注点，命中概率恒为 0）同样不进。
    // **但"判不了"必须留痕**：region 数据缺失、坐标缺失、震源情报无震度、海外源没有来源关注点
    // 不是"离得远"而是"根本没法判定"，matcher 用 `cannotJudge` 把这两类分开。
    if (!m.noWatch && m.cannotJudge === true) {
      pushEvent({
        id: alert.id, code: alert.code, kind: alert.kind, label: alert.kindLabel, severity: alert.severity,
        issued: alert.issued, headline: alert.headline + t('hist.missSuffix', { reason: m.reason }), hit: false,
      });
    }
    return { notified: false, reason: 'not-hit', detail: m.reason }
  }
  // 命中的提示必须在**任何抑制分支之前**更新：它只写在"真的播报出去"的路径末尾时，过老 / 静默
  // 时段 / 其它标签页 / 重放这些分支都会跳过它，侧边栏会停在"未播报"而历史里标着"已命中"。
  updateWeatherHint(alert, cfg);
  const hitPref = m.region ? m.region.pref : '';
  // 严重度见 hitSeverityOf 的注释
  const hitSeverity = hitSeverityOf(alert, m);
  // 跨会话重放**探测**：Host 重启后会按首次启动的回看窗口（USGS 6 小时 / NOAA 24 小时）重投缓冲里的事件，
  // 而 Client 的去重窗口只有 10 分钟；`alertedEvents`（"真正播报过"的记忆）保留 24 小时，正好挡它。
  // **必须在这里先算**：isEventRepeat 会把 strength 更新成本次的值，之后 isStrengthUpgrade 恒为 false；
  // 也不能就地抑制——同一会话内的后续发布（震度速报 → 各地震度）要由 isEventRepeat 归类。
  const looksReplayed = wasRecentlyAlerted(alert) && !isStrengthUpgrade(alert);
  // 同一次地震的后续发布（速报 → 震源 → 各地震度、或 EEW 多报）强度未升级 → 只更新历史，不再响铃。
  // 气象灾害用更长的事件窗口（见 WEATHER_EVENT_WINDOW_MINUTES）。
  const repeatWindow = alert.kind === 'weather'
    ? Math.max(cfg.dedupe.windowMinutes || 10, WEATHER_EVENT_WINDOW_MINUTES)
    : cfg.dedupe.windowMinutes;
  // 跨源优先源：同一场地震被多个源报出时，只让**一个**源向用户播报。位置两条都不能挪：
  //   · **必须在 isEventRepeat 之前**——它是只读探测，而 isEventRepeat 会把这条事件写进记忆，
  //     写进去之后 findPrevEvent 找到的就是它自己，跨源判定永远不会成立。
  //   · **必须在 m.hit 之后**——只有"本来会播报"的副本才算被优先源压掉。
  // 被压掉的副本**不进历史**（多源重复会把 30 条的「最近预警」挤掉），但抑制必须留下计数与原因。
  const crossSource = crossSourceCopyOf(alert);
  if (crossSource) {
    return { notified: false, reason: 'authority-suppressed', detail: noteAuthoritySuppressed(crossSource) }
  }
  if (isEventRepeat(alert, repeatWindow)) {
    pushEvent({
      id: alert.id, code: alert.code, kind: alert.kind, label: alert.kindLabel, severity: hitSeverity,
      issued: alert.issued, headline: alert.headline, hit: true, pref: hitPref,
      suppressed: true, suppressedReason: t('reason.eventRepeatSuppressed'),
    });
    return { notified: false, reason: 'event-repeat', detail: t('reason.eventRepeatDetail') }
  }
  // 事件级去重没拦下、但记忆说"这个事件在 24 小时内已经真正播报过" → 判为跨会话重放
  // （Host 重启按回看窗口重投），只记历史不响铃。该判据覆盖的不只是重投，还包括"同一官署同一
  // 灾种在事件窗口之后、24 小时之内等强度的第二次独立发布"，所以文案不写成"Host 重启后的重放"。
  if (looksReplayed) {
    pushEvent({
      id: alert.id, code: alert.code, kind: alert.kind, label: alert.kindLabel, severity: hitSeverity,
      issued: alert.issued, headline: alert.headline, hit: true, pref: hitPref,
      suppressed: true, suppressedReason: t('reason.replaySuppressed'),
    });
    return { notified: false, reason: 'replayed', detail: t('reason.replayDetail') }
  }
  // 打开页面时才发现的老预警（options.staleOnArrival，时效门槛）：**仍然命中、仍然进历史**，但不响铃、
  // 不弹通知——海外气象源按关注点查询，页面一打开就会把当前生效的（可能几小时前发布的）预警全拉回来。
  // **必须放在 `isEventRepeat` 之后**：放在它之前会绕过事件级记忆的更新，同一条老预警每过一轮消息级
  // 去重窗口（10 分钟）就再进一次历史，把 30 条的历史列表占满。
  if (options.staleOnArrival) {
    const hours = typeof options.staleOnArrival === 'number' ? options.staleOnArrival : 0;
    // **同时记进"已提醒过"的 24 小时记忆**：只靠 isEventRepeat 的事件窗口（气象 3 小时）不够，
    // 窗口一过，同一条仍在生效的老预警会被判成新事件、在开着的页面里响铃；记进去之后由上面的
    // `looksReplayed` 分支拦住。
    rememberAlerted(alert);
    pushEvent({
      id: alert.id, code: alert.code, kind: alert.kind, label: alert.kindLabel, severity: hitSeverity,
      issued: alert.issued, headline: alert.headline, hit: true, pref: hitPref,
      suppressed: true,
      suppressedReason: t('reason.staleOnArrival', { hours: hours }),
    });
    return { notified: false, reason: 'stale-on-arrival', detail: t('reason.staleOnArrivalDetail') }
  }
  // 静默时段：命中但不响铃、不弹通知，只记历史。红色等级（EEW、大海啸警报）默认可穿透。
  if (!options.skipQuietHours && inQuietHours(cfg) && !(hitSeverity === 'red' && cfg.quietHours.breakForSevere !== false)) {
    pushEvent({
      id: alert.id, code: alert.code, kind: alert.kind, label: alert.kindLabel, severity: hitSeverity,
      issued: alert.issued, headline: alert.headline, hit: true, pref: hitPref,
      suppressed: true,
      suppressedReason: t('reason.quietHours', { start: cfg.quietHours.start, end: cfg.quietHours.end }) +
        (hitSeverity === 'red' ? t('reason.quietNoRedPierce') : ''),
    });
    return { notified: false, reason: 'quiet-hours', detail: t('reason.quietHoursDetail') }
  }
  // 其它 DSH 标签页已经播报过同一条消息 → 本标签页静默，避免多个页面同时响铃。抢占键用消息 id
  // 而不是事件键：多标签页收到的是同一条消息，而同一事件的不同消息（如强度升级）不应被拦。
  // **但同 id、更高强度的修订版必须绕开抢占**（`upgrading`），否则"震级上修"会被上一次同 id 的
  // 抢占（按消息 id 保留 10 分钟）抑制，成为一条静默的漏报。
  if (!upgrading && !claimAlertForTab(alert.id, cancelKeyOf(alert))) {
    pushEvent({
      id: alert.id, code: alert.code, kind: alert.kind, label: alert.kindLabel, severity: hitSeverity,
      issued: alert.issued, headline: alert.headline, hit: true, pref: hitPref,
      suppressed: true, suppressedReason: t('reason.otherTab'),
    });
    return { notified: false, reason: 'other-tab', detail: t('reason.otherTabDetail') }
  }
  // 县名走 prefLabelOf（随界面语言）：日文界面是「東京都」，中文界面「东京（東京都）」，
  // 英文界面「Tokyo (東京都)」。命中行的标签也跟着语言走，原名括号只在"显示名与原名不同"时出现。
  const prefLabel = prefLabelOf(hitPref);
  const title = alertTitleOf(alert);
  const bodyLines = [alert.headline];
  if (hitPref) {
    bodyLines.push(prefLabel !== hitPref
      ? t('notify.hitPrefNamed', { pref: prefLabel, jp: hitPref })
      : t('notify.hitPref', { pref: prefLabel }));
  }
  // 全球源没有行政区，命中依据是「距某个关注点多少公里」——半径由用户自己设，说出距离才可判断可信度。
  // **判据是"有没有真实距离"，不是"是哪个源"**：只有坐标型源（`locator === 'point'`，见 matchPointAlert）
  // 会给出 `distanceKm`；海外气象（查询即匹配）与大陆气象（行政区层级）都只给关注点，落到下面那一支
  // `Math.round(undefined)` 会拼出「距震中约 NaN km」，还把一场暴雨 / 洪水说成"震中"。
  else if (m.place && typeof m.distanceKm === 'number' && Number.isFinite(m.distanceKm)) {
    bodyLines.push(t('notify.hitPlaceDistance', { place: m.place.name, km: Math.round(m.distanceKm) }));
  } else if (m.place) {
    bodyLines.push(t('notify.hitPlaceOfficial', { place: m.place.name }));
  }
  if (alert.kind === 'tsunami') bodyLines.push(t('action.tsunami'));
  // 行动提示按**机构**分岔：日本气象电文对应市町村级的避难信息，大陆预警由各级气象台发布，
  // 美加的洪水预警由当地应急部门（county / 省）发布。
  if (alert.kind === 'weather') bodyLines.push(weatherActionHintOf(alert));
  bodyLines.push(disclaimerOf(alert));
  pushEvent({
    id: alert.id, code: alert.code, kind: alert.kind, label: alert.kindLabel, severity: hitSeverity,
    issued: alert.issued, headline: alert.headline, hit: true, pref: hitPref,
  });
  const vol = cfg.notify.volume;
  // 总开关 + 分灾害开关（地震含 EEW / 海啸 / 气象），见 soundAllowedFor
  if (soundAllowedFor(cfg, alert)) playAlertSound(alert, vol);
  const pageVisible = typeof document !== 'undefined' && document.visibilityState === 'visible';
  const body = bodyLines.join('\n');
  if (pageVisible) {
    // 页面可见时只用页内 toast，后台才走系统通知
    showToast({ title, body, color: sevColor(hitSeverity) });
  } else if (cfg.notify.system) {
    const ok = showSystemNotification({ title, body, tag: 'quake-alert-' + alert.id, silent: true });
    if (!ok) showToast({ title, body, color: sevColor(hitSeverity), ttlMs: 20000 });
  }
  rememberAlerted(alert);
  return { notified: true }
}

// ============================================================================
// dsh-quake-alert · client/src/12-websocket.js
// 作用：P2PQuake WebSocket 连接管理（状态机、重连间隔递增、数据源切换、建连超时监控、连接假死检测、断线补拉、转交主链）。
// 依赖：00-i18n、01-constants、02-storage、03-settings-bridge、05g-source-health、11-pipeline。
// ============================================================================


/** 建连超时监控：连接假死时浏览器既不给 onopen 也不给 onclose，没有它状态点会永远停在「连接中…」。 */
const CONNECT_TIMEOUT_MS = 15 * 1000;

/** 连接假死检测：NAT / 代理静默断开时浏览器不触发 onclose，状态点常绿却收不到推送；正常时 lastActivityAt
 *  会被 onclose → 重连 → onopen 不断刷新，所以 20 分钟无活动即判死。 */
const STALE_AFTER_MS = 20 * 60 * 1000;
const STALE_CHECK_MS = 60 * 1000;

/** 断线补拉：P2PQuake 的 WS **没有回放**，断线窗口里的 551 / 552 / 556 永久丢失，而 EEW 的有效窗口只有几十秒。
 *  官方 REST `/v2/history` 返回与 WS 同一套 JSON，补拉后走同一条主链（按 id 去重）；只在重连时补，窗口 2 分钟，
 *  时间认不出的条目不补但计入 backfillSkipped。 */
const P2P_HISTORY_URL = 'https://api.p2pquake.net/v2/history';
const P2P_HISTORY_CODES = [551, 552, 556];
const P2P_HISTORY_WINDOW_MS = 2 * 60 * 1000;
const P2P_HISTORY_LIMIT = 20;
/** 两次补拉之间的最小间隔（重连最密 1 秒一次，避免把 REST 打成洪水）。 */
const P2P_HISTORY_MIN_GAP_MS = 5 * 1000;

// ---------- WebSocket 客户端（P2PQuake：约每 10 分钟强制断线，重连是常态路径） ----------
/**
 * @param {object} [opts] 不传即 P2PQuake（日本链路）；urlOf 默认在正式源 / 沙箱源之间切换，staleAfterMs = 0
 *   关闭「久无数据」检测；sourceId / label / openDetail 供状态上报用；onRaw 是消息处理入口。
 */
function createWsClient(opts) {
  const o = opts || {};
  const sourceId = o.sourceId || 'p2pquake';
  const label = o.label || 'P2PQuake';
  const staleAfterMs = o.staleAfterMs === undefined ? STALE_AFTER_MS : o.staleAfterMs;
  const staleCheckMs = o.staleCheckMs === undefined ? STALE_CHECK_MS : o.staleCheckMs;
  const connectTimeoutMs = o.connectTimeoutMs === undefined ? CONNECT_TIMEOUT_MS : o.connectTimeoutMs;
  const urlOf = o.urlOf || (() => (currentCfg().source === 'sandbox' ? SANDBOX_URL : WS_URL));
  // 默认连接说明**在调用时取词**：写死在模块里的中文会让英文 / 繁体界面露出整句中文，切语言后重算。
  const openDetailOf = o.openDetail || ((url) => (url.indexOf('sandbox') !== -1
    ? t('source.p2pSandbox')
    : t('source.p2pConnected')));
  const onRaw = o.onRaw || ((raw, cfg) => handleRaw(raw, cfg));
  // 上报经 publishStatus 合成：本层只知道**连接**状态，展示状态还要叠加数据健康（蓝点）与停更。
  const report = (patch) => publishStatus(sourceId, Object.assign({ label }, patch));
  let ws = null;
  let timer = null;
  let staleTimer = null;
  let connectTimer = null;
  let stopped = false;
  let retries = 0;
  let lastActivityAt = 0; // 最近一次 onopen / onmessage 的时刻
  let processFails = 0; // 连续的消息处理失败次数（主链异常必须可见）
  let visibilityBound = false;

  /**
   * 页面从冻结 / 休眠中恢复时刷新活动时刻：冻结期间消息事件不会被派发，恢复后立刻按「20 分钟无活动」判死
   * 会拆掉健康的连接，而 P2PQuake 没有回放、冻结期间的消息永久丢失。
   */
  function onVisibilityChange() {
    if (stopped) return
    const doc = typeof document !== 'undefined' ? document : null;
    if (!doc || doc.visibilityState !== 'visible') return
    if (!ws || ws.readyState !== 1) return
    lastActivityAt = Date.now();
    armStaleWatch();
  }
  function bindVisibility() {
    const doc = typeof document !== 'undefined' ? document : null;
    if (!doc || visibilityBound || typeof doc.addEventListener !== 'function') return
    doc.addEventListener('visibilitychange', onVisibilityChange);
    visibilityBound = true;
  }
  function unbindVisibility() {
    const doc = typeof document !== 'undefined' ? document : null;
    if (!doc || !visibilityBound || typeof doc.removeEventListener !== 'function') return
    doc.removeEventListener('visibilitychange', onVisibilityChange);
    visibilityBound = false;
  }

  function stopStaleWatch() {
    if (staleTimer) { clearTimeout(staleTimer); staleTimer = null; }
  }
  function clearConnectWatch() {
    if (connectTimer) { clearTimeout(connectTimer); connectTimer = null; }
  }
  /** 建连阶段排一个超时：到点还没动静就放弃这条连接，按递增的间隔重来。 */
  function armConnectWatch(target) {
    clearConnectWatch();
    if (stopped || !(connectTimeoutMs > 0)) return
    connectTimer = setTimeout(() => {
      connectTimer = null;
      if (stopped || ws !== target) return // 已经换过连接 / 已清理，忽略这次
      // 先关掉这条卡住的连接：否则 1 秒后 connect() 只是覆盖 ws 引用，旧 socket 无人回收
      teardown();
      scheduleReconnect('connect timeout (no response)');
    }, connectTimeoutMs);
    if (connectTimer && typeof connectTimer.unref === 'function') connectTimer.unref();
  }
  /** 排下一次「是否久无数据」的检查；检测关闭（staleAfterMs <= 0）时不排。 */
  function armStaleWatch() {
    stopStaleWatch();
    if (stopped || !(staleAfterMs > 0) || !(staleCheckMs > 0)) return
    staleTimer = setTimeout(() => {
      staleTimer = null;
      if (stopped) return
      if (lastActivityAt && Date.now() - lastActivityAt > staleAfterMs) {
        // 这条连接确实已经死了，不必再等下一次重试间隔：立刻换一条，onopen 会刷新 lastActivityAt
        report({ status: 'reconnecting', retries, detail: 'stale link · reconnecting' });
        teardown();
        connect();
        return
      }
      armStaleWatch();
    }, staleCheckMs);
    if (staleTimer && typeof staleTimer.unref === 'function') staleTimer.unref();
  }

  /** @param {string} [reason] 断开原因，写进状态文案（onclose 时留空用默认文案）。 */
  const scheduleReconnect = (reason) => {
    if (stopped) return
    retries += 1; // 从「第 1 次」开始计数，重连间隔依次为 1s → 2s → 4s → … → 60s 封顶
    report({
      status: 'reconnecting',
      retries,
      detail: (reason || 'disconnected') + ' · retry ' + retries,
    });
    const delay = Math.min(RECONNECT_MAX, RECONNECT_BASE * Math.pow(2, retries - 1));
    timer = setTimeout(connect, delay);
  };
  let everOpened = false;
  let lastBackfillAt = 0;
  /** 补拉的计数（诊断 / 测试用）：试了几次、补进几条、因时间过期跳过几条、失败几次。 */
  const backfillStats = { attempts: 0, fed: 0, skipped: 0, errors: 0, lastAt: 0, lastDetail: '' };
  /** 一条历史消息的时间（毫秒）。P2PQuake 的 `time` 与 551/556 的 issue / earthquake.time 都试。 */
  function historyTimeMs(raw) {
    const cands = [
      raw && raw.time,
      raw && raw.issue && raw.issue.time,
      raw && raw.earthquake && raw.earthquake.time,
    ];
    for (const c of cands) {
      const iso = p2pTimeToIso(String(c === undefined || c === null ? '' : c));
      // 局部变量不叫 `t`（那是 00-i18n 的取词函数，遮蔽后 t('key') 会变成 Date.parse）
      const ms = Date.parse(iso);
      if (Number.isFinite(ms)) return ms
    }
    return NaN
  }
  const fetchJson = o.fetchJson || ((url) => window.fetch(url).then((res) => {
    if (!res || !res.ok) throw new Error('HTTP ' + (res ? res.status : '?'))
    return res.json()
  }));
  /** 重连后补拉断线窗口里的消息（见文件头 P2P_HISTORY_*）。**逐条**交给主链：一条坏数据不该让整次补拉白做。 */
  function backfillAfterGap() {
    if (stopped) return
    const now = Date.now();
    if (lastBackfillAt && now - lastBackfillAt < P2P_HISTORY_MIN_GAP_MS) return
    lastBackfillAt = now;
    backfillStats.attempts += 1;
    const url = P2P_HISTORY_URL + P2P_HISTORY_CODES.map((c) => '&codes=' + c).join('') + '&limit=' + P2P_HISTORY_LIMIT;
    Promise.resolve()
      .then(() => fetchJson(url))
      .then((list) => {
        if (stopped || !Array.isArray(list)) return
        // 由旧到新交给主链：这样后到的（更新的）消息不会先被处理
        const rows = list.map((raw) => ({ raw, t: historyTimeMs(raw) }))
          .filter((r) => r.raw && typeof r.raw === 'object')
          .sort((a, b) => (Number.isFinite(a.t) ? a.t : 0) - (Number.isFinite(b.t) ? b.t : 0));
        for (const r of rows) {
          if (stopped) return
          if (!Number.isFinite(r.t) || (now - r.t) > P2P_HISTORY_WINDOW_MS) {
            backfillStats.skipped += 1;
            continue
          }
          try {
            onRaw(r.raw, currentCfg());
            backfillStats.fed += 1;
          } catch (err) { backfillStats.errors += 1; backfillStats.lastDetail = String((err && err.message) || err); }
        }
        backfillStats.lastAt = Date.now();
      })
      .catch((err) => {
        // 补拉失败**不改变连接状态**：它只是一条恢复路径，算成"源不可达"会让状态点无谓变红
        backfillStats.errors += 1;
        backfillStats.lastDetail = String((err && err.message) || err);
      });
  }
  const connect = () => {
    if (stopped) return
    const url = urlOf();
    report({ status: 'connecting', retries, detail: 'connecting · ' + url });
    try { ws = new window.WebSocket(url); } catch (err) {
      scheduleReconnect();
      return
    }
    armConnectWatch(ws);
    ws.onopen = () => {
      clearConnectWatch();
      retries = 0;
      processFails = 0;
      lastActivityAt = Date.now();
      armStaleWatch();
      report({ status: 'open', retries: 0, detail: openDetailOf(url) });
      // **重连**时补拉断线窗口里的消息（首次连接没有缺口），见 backfillAfterGap
      const isReconnect = everOpened;
      everOpened = true;
      if (isReconnect) backfillAfterGap();
    };
    ws.onmessage = (ev) => {
      lastActivityAt = Date.now();
      let raw;
      try { raw = JSON.parse(String(ev.data)); } catch (err) { return } // 单条 JSON 坏掉不影响连接
      // 主链**必须单独 try**：与 JSON.parse 共用空 catch 会把 parse / match / handleAlert 的异常一起吞掉。
      try {
        onRaw(raw, currentCfg());
        // 恢复：连续失败后只要有一条处理成功就把状态改回 open，否则一次主链异常会让侧边栏永久停在"链路降级"。
        if (processFails > 0) {
          processFails = 0;
          report({ status: 'open', retries, detail: openDetailOf(url) });
        }
      } catch (err) {
        processFails += 1;
        report({
          status: 'degraded',
          retries,
          detail: 'processing failed x' + processFails + ': ' + String((err && err.message) || err),
        });
      }
    };
    ws.onerror = () => { /* onclose 统一处理 */ };
    ws.onclose = () => {
      clearConnectWatch();
      stopStaleWatch(); // stale 链必须随这条 socket 结束，否则它会脱离连接继续存活
      scheduleReconnect();
    };
  };
  const teardown = () => {
    stopStaleWatch();
    clearConnectWatch();
    if (timer) { clearTimeout(timer); timer = null; }
    if (ws) { try { ws.onclose = null; ws.close(); } catch (err) {} ws = null; }
  };
  return {
    start() {
      // start 是 stop 的逆操作：只有 restart() 清 `stopped` 时，"stop 之后再 start"会静默地什么都不做。
      stopped = false;
      retries = 0;
      processFails = 0;
      bindVisibility();
      connect();
    },
    stop() {
      stopped = true;
      teardown();
      unbindVisibility();
      report({ status: 'closed', retries, detail: 'stopped (plugin disabled)' });
    },
    backfillStatsOf() { return Object.assign({}, backfillStats) },
    restart() {
      stopped = false;
      retries = 0; // 切数据源后立即从 1s 的间隔重新开始，而不是沿用上一条连接的递增进度
      processFails = 0;
      bindVisibility(); // stop() 会解绑；restart 之后这条 socket 同样需要"恢复可见时重置 stale 计时"
      teardown();
      connect();
    },
  }
}

let activeClient = null;


// entry 需要把新建的 client 记到模块级 activeClient：跨模块不能写 imported binding
const setActiveClient = (c) => { activeClient = c; };

// ============================================================================
// dsh-quake-alert · client/src/12b-feed-poll.js
// 作用：从 Host 的只读路由拉気象庁 / 全球源的电文增量，解析成 Alert 后交给主链（handleAlert，与 P2PQuake 的
//       551/552/556 汇到同一条链）；含读取位置生命周期、增量应用、失败容错、启停、诊断计数。
// 依赖：02-storage（读取位置写入本地存储）、03-settings-bridge、05b/05d（解析契约）、05g（健康）、07-store、11-pipeline。
// ============================================================================


/** Host 侧的电文增量路由（与 lib/index.js 的 FEED_PATH 对应）。只从回环地址取增量：Host 是每台机器唯一的
 *  外部请求者（気象庁要求「一度取得したファイルを再度取得しない」，多标签页不会放大请求）。 */
const FEED_PATH = '/dsh-quake-alert/feed';
/** 本地拉取间隔：Host 每 60s 拉一次源，这里 15s 拉一次本地缓存，端到端最坏约 75s。 */
const FEED_POLL_MS = 15 * 1000;
/** 启动后首轮延迟：给插件装载、城市表与 host 侧首轮轮询让路。 */
const FEED_FIRST_DELAY_MS = 3000;
/** 读取位置在 localStorage 里的键。 */
const FEED_CURSOR_KEY = 'dsh.quakeAlert.feedCursor';
/** 首次启动的特殊标记值：还没有读取位置 → 用 tail 语义对齐位置而不是重放历史。 */
const FEED_TAIL = 'tail';
/** 各源最近一次轮询结果的**只读快照**（id → stats）。放模块级对象而不是 store：每轮都 push 会让设置页与侧边栏反复重渲。 */
const feedStatsOf = {};
/** 本地路由的单次请求超时：Host 卡住时不能让 inFlight 一直占着、把整条轮询拖停。 */
const FEED_FETCH_TIMEOUT_MS = 10 * 1000;

/** 读回已持久化的读取位置；任何格式不合法的数据（非数字 / NaN / 负数）一律当作"没有记录"。 */
function loadFeedCursor(key) {
  const v = loadJSON(key, null);
  return (typeof v === 'number' && Number.isFinite(v) && v >= 0) ? Math.floor(v) : null
}
function saveFeedCursor(v, key) {
  if (typeof v === 'number' && Number.isFinite(v) && v >= 0) saveJSON(key, Math.floor(v));
}

async function defaultFetchJson(url, signal) {
  const AS = (typeof window !== 'undefined' && window) ? window.AbortSignal : undefined;
  let timeout = (AS && typeof AS.timeout === 'function') ? AS.timeout(FEED_FETCH_TIMEOUT_MS) : undefined;
  let timeoutTimer = null;
  // `AbortSignal.timeout` 只有较新引擎才有（Chrome 103+ / Firefox 124+），缺失时超时保护会整条消失：挂死的
  // 请求让 inFlight 永不 settle、四源一起永久停摆。这里补一个自建 AbortController 的分支。
  if (!timeout && typeof AbortController === 'function') {
    const ctrl = new AbortController();
    timeoutTimer = setTimeout(() => { try { ctrl.abort(); } catch (err) { /* 已中止 */ } }, FEED_FETCH_TIMEOUT_MS);
    timeout = ctrl.signal;
  }
  /** 把「请求超时」与「插件停用时中止」合成**一个**信号：`AbortSignal.any` 在 Chrome 103-115 /
   *  Firefox 100-123 上没有，缺失时自建 AbortController 合并两个信号（任一触发即中止），
   *  只有这样才能真正掐断底层请求（12e 的 Promise.race 只是让 Promise 早点失败）。 */
  let sig = timeout;
  const anyFn = (AS && typeof AS.any === 'function')
    ? AS.any
    : ((typeof AbortSignal !== 'undefined' && typeof AbortSignal.any === 'function') ? AbortSignal.any : null);
  try {
    if (signal && timeout) {
      if (anyFn) {
        sig = anyFn([signal, timeout]);
      } else if (typeof AbortController === 'function') {
        const ctrl = new AbortController();
        if (signal.aborted || timeout.aborted) {
          ctrl.abort();
        } else {
          const onAbort = () => { try { ctrl.abort(); } catch (err) { /* 已经中止过 */ } };
          signal.addEventListener('abort', onAbort, { once: true });
          timeout.addEventListener('abort', onAbort, { once: true });
        }
        sig = ctrl.signal;
      } else {
        // 连 AbortController 都没有（很老的引擎）：只能保业务信号，超时退回 Promise.race 兜底
        sig = signal;
      }
    } else if (signal) {
      sig = signal;
    }
  } catch (err) { sig = timeout; }
  const request = window.fetch(url, { headers: { accept: 'application/json' }, signal: sig })
    .then((res) => {
      if (!res || !res.ok) throw new Error('HTTP ' + (res ? res.status : '?'))
      return res.json()
    });
  // 兜底（只在"连 AbortController 都没有"的老引擎上生效）：让这一轮按时结束，避免轮询链永久停摆。
  try {
    if (!(typeof AbortController === 'function') && timeout) {
      let timer = null;
      try {
        return await Promise.race([
          request,
          new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error('local timeout (' + FEED_FETCH_TIMEOUT_MS + 'ms): ' + url)), FEED_FETCH_TIMEOUT_MS);
          }),
        ])
      } finally {
        if (timer) clearTimeout(timer);
      }
    }
    return await request
  } finally {
    // 自建的超时定时器要在请求结束时清掉（成功 / 失败 / 被中止），否则会一直挂到超时点
    if (timeoutTimer) clearTimeout(timeoutTimer);
  }
}

/**
 * @param {object} [opts] 注入点（fetchJson / apply / getCfg / loadCursor / saveCursor / onError / onStatus）供测试替换。
 * @param {string} [opts.id] 源标识（诊断用）；[opts.label] 状态文案里的源名。
 * @param {string} [opts.path] Host 增量路由；全球源用 `?source=usgs` 这类分派参数。
 * @param {string} [opts.cursorKey] 该源自己的读取位置存储键——多源共用一条键会互相顶掉读取位置。
 * @param {(cfg: object) => boolean} [opts.enabled] 该源当前是否需要拉取（按灾种开关判断）。
 * @param {(patch: object) => void} [opts.onStatus] 状态上报：把本源的连接 / 失败情况送进 store 参与整体聚合。
 */
function createFeedClient(opts = {}) {
  const id = opts.id || 'jma';
  const label = opts.label || id;
  const path = opts.path || FEED_PATH;
  const cursorKey = opts.cursorKey || FEED_CURSOR_KEY;
  const intervalMs = opts.intervalMs || FEED_POLL_MS;
  const firstDelayMs = opts.firstDelayMs === undefined ? FEED_FIRST_DELAY_MS : opts.firstDelayMs;
  const fetchJson = opts.fetchJson || defaultFetchJson;
  const getCfg = opts.getCfg || currentCfg;
  const onError = opts.onError || (() => {});
  const onStatus = opts.onStatus || (() => {});
  // 该源此轮要不要拉：气象源跟 weather 开关，全球地震跟 earthquake 开关，海啸跟 tsunami 开关。
  const enabled = opts.enabled || ((cfg) => (cfg.disasters || {}).weather !== false);
  const loadCursor = opts.loadCursor || (() => loadFeedCursor(cursorKey));
  const saveCursor = opts.saveCursor || ((v) => saveFeedCursor(v, cursorKey));
  const apply = opts.apply || ((entry, cfg) => {
    // 走解析契约：schema / value 失败会计入数据健康且**不播报**，empty（与本插件无关的电文）静静跳过。
    const res = parseJmaResult(entry && entry.xml, { id: entry && entry.id });
    if (noteParseResult(id, res)) return false
    if (!res.ok) return false
    noteSourceSuccess(id);
    handleAlert(res.alert, cfg);
    return true
  });

  // null = 本浏览器还没有读取位置（首次启动）→ 首轮用 tail 对齐，不重放 Host 缓冲里的历史。
  // 读取位置语义：`?since=N` 返回 seq > N 的条目（Host 的固定长度缓冲淘汰旧条目时带 truncated，有缺口仍照常应用）；
  // `?since=tail` 是首次启动只要当前位置；响应带 `reset` 表示 Host 重启后读取位置从 0 重算，据此对齐。
  let since = null;
  try {
    const stored = loadCursor();
    if (typeof stored === 'number' && Number.isFinite(stored) && stored >= 0) since = Math.floor(stored);
  } catch (err) { /* 读取本地存储失败按首次启动处理 */ }
  let timer = null;
  let running = false;
  let stopped = false; // 插件停用：在途轮询的响应回来后不该再 apply
  let inFlight = null;
  let abortCtl = null;
  let lastStatusKey = '';
  // Host 的 errors / detailDropped 是**进程内累计**计数（永不归零），判断"这一轮又失败了"必须看增量。
  let lastHostErrors = 0;
  let lastHostDropped = 0;
  const stats = { polls: 0, received: 0, applied: 0, errors: 0, truncated: 0, tailSync: 0, resets: 0, morePages: 0, lastAt: 0, cursor: 0, host: null };

  /** 状态上报：只在**状态**变化时送出（轮询每 15 秒一轮，每轮都 push 会让设置页反复重渲），并经
   *  effectiveStatusOf 合并"数据格式异常"（蓝点，优先级高于连接状态）。 */
  function reportStatus(patch) {
    const eff = effectiveStatusOf(id, patch.status, patch.detail);
    // key **只取状态**：detail 里含"已收到 N 条增量"这类单调计数，用它做 key 会让每轮都判定为"变化"。
    // 还要比 **store 里当前实际的状态**：自检（12d）、健康层（05g）与 WS 连接层也会写同一个源，若它们
    // 刚改过展示状态而这里不上报，那个状态会**永久**留在界面上。
    const cur = ((store.sources || {})[id] || {}).status;
    if (eff.status === lastStatusKey && cur === eff.status) return
    lastStatusKey = eff.status;
    try { onStatus(Object.assign({ label }, eff)); } catch (err) { /* UI 回调异常不影响轮询 */ }
  }

  /** 推进读取位置并写入本地存储（值没变就不写，15s 一次的轮询不必每次都碰 localStorage）。 */
  function setCursor(next) {
    if (!(typeof next === 'number' && Number.isFinite(next) && next >= 0)) return
    const v = Math.floor(next);
    if (v === since) return
    since = v;
    try { saveCursor(v); } catch (err) { /* 隐私模式等写入本地存储失败：本次仍以内存里的读取位置工作 */ }
  }
  const cursorNow = () => (since === null ? 0 : since);

  async function pollOnce() {
    stats.polls += 1;
    // 灾种开关关闭时不必拉增量（Host 侧随后也会据此停轮询）；状态如实上报为「已关闭」，聚合状态不会显示成异常。
    if (!enabled(getCfg())) {
      reportStatus({ status: 'disabled', detail: 'disabled · hazard switch off' });
      return { applied: 0, cursor: cursorNow(), skipped: true }
    }
    let data;
    // 自持取消器：插件停用时要能中止在途请求，否则响应回来后仍会 apply → handleAlert → 响铃 / 弹窗 / 写历史。
    abortCtl = (typeof window !== 'undefined' && window && typeof window.AbortController === 'function')
      ? new window.AbortController()
      : null;
    try {
      // path 可能自带查询串（全球源用 `?source=usgs` 分派），按需选分隔符；stats=1 把 Host 侧的健康计数一并取回。
      const sep = path.indexOf('?') === -1 ? '?' : '&';
      data = await fetchJson(
        path + sep + 'since=' + (since === null ? FEED_TAIL : since) + '&stats=1',
        abortCtl ? abortCtl.signal : undefined,
      );
    } catch (err) {
      // 用户主动停用（abort）不是"源不可达"：不上报 unreachable、不计失败，否则侧边栏会留下一个红点。
      if (stopped) return { applied: 0, cursor: cursorNow(), aborted: true }
      stats.errors += 1;
      onError(err);
      reportStatus({ status: 'unreachable', detail: 'feed route failed: ' + String((err && err.message) || err) });
      return { applied: 0, cursor: cursorNow() }
    } finally {
      abortCtl = null;
    }
    stats.lastAt = Date.now();
    // Host 回显的源必须与请求的一致：Host 比 Client 旧时会把 jma 的原文交给 noaa 的解析器，解析必失败，
    // 而读取位置仍在推进——那些条目被永久跳过且表面正常。
    if (data && data.source && data.source !== id) {
      const err = new Error('source mismatch: asked ' + id + ', host returned ' + data.source);
      stats.errors += 1;
      onError(err);
      reportStatus({ status: 'unreachable', detail: err.message });
      return { applied: 0, cursor: cursorNow() }
    }
    if (data && data.stats) stats.host = data.stats;
    // 把**源自己的数据时间**交给自检（阈值由自检从契约里取），这里只上报事实、不判 stale。取 Host 的
    // `feedTime`（源自 <updated> / metadata.generated / 列表最新一条），不是"我们收到条目的时刻"：JMA 可能
    // 几小时只有天气预报，用收到时刻会把那种正常情况判成停更。
    if (data && data.stats && Number.isFinite(data.stats.feedTime) && data.stats.feedTime > 0) {
      noteFreshness(id, data.stats.feedTime);
    }
    // 首次对齐：Host 只回当前位置，不应用任何条目（即使响应里意外带了也不应用），否则"刷新页面"又变成重放历史。
    if (data && data.tail === true) {
      stats.tailSync += 1;
      setCursor(data.cursor);
      stats.cursor = cursorNow();
      reportStatus({ status: 'open', detail: 'aligned · ' + hostDetail() });
      return { applied: 0, cursor: cursorNow(), tail: true }
    }
    // 本地没有读取位置、响应却没带 tail 标记 → 对面是不认 `since=tail` 的旧版 Host（按 0 吐回整个固定长度缓冲）：
    // 取它的读取位置对齐即可，不能把这些历史当增量播一遍。
    if (since === null) {
      stats.tailSync += 1;
      if (data && Number.isFinite(data.cursor)) setCursor(data.cursor);
      stats.cursor = cursorNow();
      return { applied: 0, cursor: cursorNow(), tail: true, legacyHost: true }
    }
    const entries = Array.isArray(data && data.entries) ? data.entries : [];
    if (data && data.truncated) stats.truncated += 1;
    let applied = 0;
    let lastSeenSeq = null;
    for (const e of entries) {
      if (stopped) break // 插件已停用：剩下的条目不再处理
      stats.received += 1;
      try {
        if (apply(e, getCfg())) applied += 1;
      } catch (err) {
        // 单条电文解析失败不能影响后续条目，也不能让读取位置停住
        stats.errors += 1;
        onError(err);
      }
      if (e && Number.isFinite(e.seq)) lastSeenSeq = e.seq;
    }
    stats.applied += applied;
    let reset = false;
    if (data && Number.isFinite(data.cursor)) {
      // Host 重启过 → 它给的读取位置一定比 Client 手里的小；以 `data.cursor < since` 为准而不是只看 reset 标记：
      // 漏标记时也必须自愈，否则 entries 恒空且 truncated 不为真——静默失联。
      const regressed = since !== null && data.cursor < since;
      if (data.reset === true || regressed) {
        reset = true;
        stats.resets += 1;
      }
      // Host 会用 MAX_FEED_ENTRIES 截断大响应（本轮只给前 N 条），此时不能直接跳到 data.cursor（那 N 条之后的条目
      // 会被静默跳过），改用**最后一条实际返回的 seq** 推进。
      const last = entries.length ? entries[entries.length - 1] : null;
      // 被停用打断时（stopped）只能用**已经处理到的那条**推进：跳到整批末条会把没处理的条目连读取位置一起跳过。
      const next = stopped
        ? (lastSeenSeq !== null ? lastSeenSeq : cursorNow())
        : (last && Number.isFinite(last.seq) ? last.seq : data.cursor);
      if (data.more === true) stats.morePages += 1;
      setCursor(next);
    }
    stats.cursor = cursorNow();
    // 增量缺口与读取位置重置必须**让用户看得见**：被跳过的条目是静默漏报，只进诊断计数会被当成"都收到了"。
    // Host 的 errors / detailDropped 是累计计数，所以一律看增量。
    const host = stats.host || {};
    const hostErrors = Number(host.errors) || 0;
    const hostDropped = Number(host.detailDropped) || 0;
    const errDelta = Math.max(0, hostErrors - lastHostErrors);
    const dropDelta = Math.max(0, hostDropped - lastHostDropped);
    lastHostErrors = hostErrors;
    lastHostDropped = hostDropped;
    const warn = [];
    if (data && data.truncated) warn.push('gap: host ring buffer evicted entries');
    if (reset) warn.push('host cursor reset');
    if (errDelta) warn.push('host fetch failures +' + errDelta);
    if (dropDelta) warn.push('host detail drops +' + dropDelta);
    // stale 有**自己的状态**（中灰「数据已过期」），不折叠进 degraded：它表示"源在响应、但给的是旧数据"。
    reportStatus({
      status: host.stale ? 'stale' : (warn.length ? 'degraded' : 'open'),
      detail: 'received ' + stats.received + ' increments · ' + hostDetail() +
        (host.stale ? ' · upstream data stale' : '') +
        (warn.length ? ' · ' + warn.join('；') : ''),
    });
    return { applied, cursor: cursorNow(), truncated: !!(data && data.truncated), reset, more: !!(data && data.more) }
  }

  /** 状态文案里的 Host 侧摘要：只在本源当前有问题时才值得占位置（正常时保持简短）。 */
  function hostDetail() {
    const h = stats.host;
    if (!h) return 'last fetch ' + new Date(stats.lastAt).toLocaleTimeString()
    const errs = Number(h.errors) || 0;
    const idle = Number(h.idleSkips) || 0;
    return 'host polls ' + (Number(h.polls) || 0) + (errs ? ' · fails ' + errs : '') +
      (idle ? ' · idle ' + idle : '')
  }

  function pollSerial() {
    if (inFlight) return inFlight
    inFlight = pollOnce().finally(() => {
      inFlight = null;
      // 给设置页的「全球源状态」留一份快照（不触发 store 重渲）
      feedStatsOf[id] = Object.assign({}, stats, { running });
    });
    return inFlight
  }

  function schedule(delay) {
    if (!running) return
    // 与其他定时器一致的纪律：排新的之前先清旧的，少这一行就意味着多一条自续的轮询链（上游请求速率翻倍）。
    if (timer) { clearTimeout(timer); timer = null; }
    timer = setTimeout(async () => {
      timer = null;
      // 灾种开关的判断放在 pollOnce 里：那里会如实上报「已关闭」状态（不产生任何网络请求）。
      try { await pollSerial(); } catch (err) { onError(err); }
      schedule(intervalMs);
    }, delay);
  }

  return {
    id,
    path,
    cursorKey,
    start() {
      if (running) return
      stopped = false;
      running = true;
      schedule(firstDelayMs);
    },
    stop() {
      stopped = true;
      running = false;
      if (timer) { clearTimeout(timer); timer = null; }
      // 中止在途请求：插件停用后回来的响应不该再 apply（响铃 / 弹窗 / 写历史）
      if (abortCtl) { try { abortCtl.abort(); } catch (err) { /* 已结束等忽略 */ } abortCtl = null; }
    },
    pollOnce,
    pollSerial,
    stats() { return Object.assign({}, stats, { running }) },
    /** 测试与诊断用：当前的读取位置（尚未对齐时为 0）。 */
    cursor() { return cursorNow() },
    /** 测试与诊断用：本客户端是否还没有读取位置（首轮会走 tail 对齐）。 */
    hasCursor() { return since !== null },
  }
}

// ============================================================================
// dsh-quake-alert · client/src/12c-cn-stream.js
// 作用：消费大陆源（Wolfx cenc_eew / cenc_eqlist）的 **SSE 推送**，解析成 Alert 后交给主链 handleAlert；含
//       EventSource 生命周期、Last-Event-ID 断线补齐、读取位置持久化、**降级到轮询**。
// 依赖：00-i18n、02-storage、03-settings-bridge、05d（解析契约）、05g（健康）、07-store、11-pipeline、12b-feed-poll。
// ============================================================================


/** Host 侧的 SSE 路由（与 lib/index.js 的 STREAM_PATH 对应）。 */
const STREAM_PATH = '/dsh-quake-alert/stream';
/** 每个源自己的读取位置存储键前缀。 */
const CN_CURSOR_KEY = 'dsh.quakeAlert.streamCursor';
/** 连上之后多久没收到第一条数据 `sync` 就判定"这条流不通"。第一条数据是 Host 立刻写出的，正常几十毫秒就到。 */
const SSE_PROBE_MS = 8000;
/** 连续失败到这个次数就降级到轮询（3 = 容忍一次网络抖动与一次 Host 重启）。 */
const SSE_MAX_FAILS = 3;
/** 降级 / 停用期间重新探测的间隔：用户重新打开灾种开关后要能回来。 */
const CN_RECHECK_MS = 5000;
/** 已连接的流"多久没有任何帧"即判定连接已死：Host 每 15 秒必发一个 status 帧，45 秒 = 3 倍余量可靠；看似连着其实已断的长连接在浏览器里**不会**触发 onerror。 */
const SSE_SILENCE_DEAD_MS = 45 * 1000;

/** 读回已持久化的读取位置；任何格式不合法的数据一律当作"没有记录"。 */
function loadCursorOf(key) {
  const v = loadJSON(key, null);
  return (typeof v === 'number' && Number.isFinite(v) && v >= 0) ? Math.floor(v) : null
}
function saveCursorOf(key, v) {
  if (typeof v === 'number' && Number.isFinite(v) && v >= 0) saveJSON(key, Math.floor(v));
}

/**
 * @param {object} opts —— `id`（`cenc_eew` / `cenc_eqlist`）、`label`（状态文案里的源名）、`path`（SSE 路由，
 *   含 `?source=`）、`enabled`（该源当前是否需要消费）、`apply`（逐条应用，注入解析契约）、`onStatus` / `onError`。
 * @param {(url: string) => object} [opts.createEventSource] 注入点（测试用）；[opts.createFallback] 降级客户端工厂
 *   （默认建一个 12b 的轮询客户端）；[opts.createFeedClient] 供断言"降级客户端拿了哪个读取位置键"。
 * @param {() => object} [opts.getCfg]、[opts.loadCursor]、[opts.saveCursor]、[opts.now]（与 silenceDeadMs 配套的假时钟）。
 * @param {number} [opts.probeMs]、[opts.maxFails]、[opts.silenceDeadMs]（已连接的流多久无帧即判死；0 = 不判）。
 */
function createCnStream(opts = {}) {
  const id = opts.id;
  const label = opts.label || id;
  const path = opts.path || (STREAM_PATH + '?source=' + id);
  const cursorKey = opts.cursorKey || (CN_CURSOR_KEY + '.' + id);
  const getCfg = opts.getCfg || currentCfg;
const now = opts.now || (() => Date.now());
const silenceDeadMs = opts.silenceDeadMs === undefined ? SSE_SILENCE_DEAD_MS : opts.silenceDeadMs;
  const onError = opts.onError || (() => {});
  const onStatus = opts.onStatus || (() => {});
  const apply = opts.apply || (() => false);
  const enabled = opts.enabled || (() => true);
  const probeMs = opts.probeMs === undefined ? SSE_PROBE_MS : opts.probeMs;
  const maxFails = opts.maxFails === undefined ? SSE_MAX_FAILS : opts.maxFails;
  const loadCursor = opts.loadCursor || (() => loadCursorOf(cursorKey));
  const saveCursor = opts.saveCursor || ((v) => saveCursorOf(cursorKey, v));
  const createEventSource = opts.createEventSource
    || ((url) => new window.EventSource(url));
  // 定时器注入点：自检超时与周期检查都靠它，测试要能确定性地推进（不真等 8 秒 / 5 秒）
  const setTimer = opts.setTimer || ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = opts.clearTimer || ((timer) => clearTimeout(timer));
  // 降级工厂：默认按 12b 的轮询客户端建一个（`?source=` 分派，Host 侧早就支持）。
  const makeFeedClient = opts.createFeedClient || createFeedClient;
  const createFallback = opts.createFallback || (() => makeFeedClient({
    id,
    label,
    path: FEED_PATH + '?source=' + id,
    // 与 SSE 用**同一个**读取位置键：两侧的 seq 都来自 Host 同一个源的读取位置，降级时能无缝接续；用独立的键会让轮询
    // 从 `since=tail` 起步，SSE 挂掉到降级生效之间的条目被静默跳过（真实的漏报窗口）。
    cursorKey: CN_CURSOR_KEY + '.' + id,
    enabled,
    // 不是 onStatus：降级态下轮询侧的 "open" 会把"已降级"盖掉，必须合成一条（见 fallbackStatus）。
    onStatus: fallbackStatus,
    onError,
    apply,
  }));

  let since = null;
  try {
    const stored = loadCursor();
    if (typeof stored === 'number' && Number.isFinite(stored) && stored >= 0) since = Math.floor(stored);
  } catch (err) { /* 读取本地存储失败按首次启动处理 */ }

  let running = false;
  let source = null; // EventSource 实例
  let probeTimer = null;
  let tickTimer = null;
  let fallbackClient = null;
  let mode = 'idle'; // idle | sse | poll | disabled
  let consecutiveFails = 0;
  let sawSyncThisConn = false;
  let lastStatusKey = '';
  let inFallback = false;
  /** 当前的轮询是"用户选的"还是"自动降级来的"——只有前者能自动升回 SSE。 */
  let fallbackManual = false;
  // 最近一次收到**任何**帧（sync / entry / status）的时刻。Host 每 15 秒必发一个 status 帧，"长时间一个帧都没有"
  // 是可靠的死连接判据（只看"第一条数据之前"发现不了曾经成功、之后被中间设备静默掐断的长连接）。
  let lastFrameAt = 0;
  const stats = {
    mode: 'idle', connections: 0, syncs: 0, received: 0, applied: 0, errors: 0,
    sseErrors: 0, probeTimeouts: 0, fallbacks: 0, fallbackManual: false, truncated: 0, resets: 0,
    // 已连接的流被判"静默死亡"的次数：与 probeTimeouts（第一条数据之前超时）成因不同，分开统计。
    silentDeaths: 0,
    // stale（源可达但数据是旧的）：由 Host 的 sync / status 帧告知；Client 自己判不出来——"没有新 entry"与
    // "这几天确实没有地震"在本地长得一模一样。
    stale: false, dataTime: 0,
    // Host 侧的"中继连接是否还活着"与它最近一次错误：SSE 路径下 Client 不轮询 /feed，Host 的 stats 在界面上
    // 零消费者，中继被掐断时界面会一直显示绿色的 "SSE connected · received 0"。
    hostConnected: null, hostError: '',
    lastAt: 0, lastEventAt: 0, cursor: 0, frozen: false, lastDetail: '',
  };

  /** 用户在设置页选了「强制轮询」（`cnTransport: 'poll'`）？默认 'auto'。 */
  const wantPoll = (cfg) => String((cfg && cfg.cnTransport) || 'auto') === 'poll';

  const cursorNow = () => (since === null ? 0 : since);
  /** 注册到 cnStreamRegistry（实时读取，见文件末说明）。注册与 start / stop 对齐：只在构造时写一次会让停用后的
   *  源仍列在表里（`running=false, mode='idle'`），设置页的"尚未启动"分支永远不可达。 */
  function registerSelf() {
    cnStreamRegistry[id] = {
      stats: () => Object.assign({}, stats, { running, hasCursor: since !== null, fallbackActive: inFallback }),
      mode: () => mode,
    };
  }
  function unregisterSelf() {
    if (cnStreamRegistry[id]) delete cnStreamRegistry[id];
  }
  /** @param {number} next @param {boolean} [force] Host 明确说"读取位置重置过"（它重启 / 时钟回拨）时必须允许回退，
   *   否则本地读取位置永远卡在一个比 Host 大的值上，之后每次重连都触发 reset + 全量重放（12b 有等价的自愈）。 */
  function setCursor(next, force) {
    if (!(typeof next === 'number' && Number.isFinite(next) && next >= 0)) return
    const v = Math.floor(next);
    if (v === since) return
    // 读取位置只前进：SSE 的补发与实况可能交错到达，回退会让"断线补齐"重复投递
    if (!force && since !== null && v < since) return
    since = v;
    stats.cursor = v;
    try { saveCursor(v); } catch (err) { /* 隐私模式等写入本地存储失败：本次仍以内存里的读取位置工作 */ }
  }

  /** 状态上报。`k` 是去重键，**不取 detail**（detail 里含"已收到 N 条"这类单调计数，用它做键会每轮都判定为
   *  "变化"）；也不能只取 status：降级与"出错但正在自动重连"是同一个 status，却是完全不同的两件事。
   *  所以由调用方给一个稳定的**语义**键，默认退回 status。 */
  function reportStatus(patch, k) {
    stats.lastDetail = String(patch.detail || '');
    const eff = effectiveStatusOf(id, patch.status, patch.detail);
    const key = k || eff.status;
    // 还要比 **store 里当前实际的状态**：自检（12d）、健康层（05g）与 WS 连接层会写同一个源，若它们刚把展示
    // 状态改成别的值而这里不上报，那个被覆盖的状态会永久留在界面上（12b 侧同款修正）。
    const cur = ((store.sources || {})[id] || {}).status;
    if (key === lastStatusKey && cur === eff.status) return
    lastStatusKey = key;
    try { onStatus(Object.assign({ label }, eff)); } catch (err) { /* UI 回调异常不影响链路 */ }
  }

  /** 降级态下，轮询客户端（12b）的上报要经过这一层再出去：12b 有**自己独立的**状态去重键，降级之后它第一次
   *  成功轮询就会报一条 `open`，把 12c 刚报出去的"已降级为轮询"整条覆盖掉。处理方式是把两者**合并成一条**：
   *  状态取"降级"（或用户手动选择），细节附上轮询侧的信息；键带上轮询侧的状态，它自己变化时仍会重新上报。 */
  function fallbackStatus(patch) {
    if (!inFallback) return
    const p = patch || {};
    reportStatus({
      status: fallbackManual ? 'disabled' : 'degraded',
      detail: (fallbackManual ? t('source.cnPollManual') : t('source.cnFallback')) +
        t('source.cnPollDelay') + (p.detail ? ' · ' + String(p.detail) : ''),
    }, 'fallback:' + String(p.status || ''));
  }

  function closeSource() {
    if (probeTimer) { clearTimer(probeTimer); probeTimer = null; }
    const s = source;
    source = null;
    if (s) {
      try { s.onerror = null; s.onmessage = null; } catch (err) { /* 忽略 */ }
      try { s.close(); } catch (err) { /* 已关闭 */ }
    }
  }

  /** 切到轮询。
   *  @param {string} reason 人话原因（会出现在状态里，所以说清是"哪条链路不行了"）
   *  @param {boolean} [manual] true = 用户在设置页选了「强制轮询」，false/缺省 = 自动降级。区别只在能不能自动
   *    升回 SSE：自动降级不再升回，而**手动**选择是可以撤销的（用户改回「自动」就该回到 SSE）。 */
  function activateFallback(reason, manual) {
    if (inFallback) return
    // **先建客户端，成功之后才置位**：反过来（先置位、建失败就 return）会让 inFallback 锁死、SSE 已关、
    // fallbackClient 仍是 null，tick 没有一条分支能再建起链路，而界面显示的是"已降级为轮询"。
    let client = null;
    try {
      client = createFallback();
    } catch (err) {
      onError(err);
      // 回滚到 idle 并如实上报：用户显式选了「强制轮询」时 tick 会每 5 秒重试一次；自动降级来的（wantPoll
      // 为假）不再重试——SSE 已证明不通、轮询客户端又建不起来，显示"无法连接"就是全部能做的。
      inFallback = false;
      fallbackManual = false;
      mode = 'idle';
      stats.mode = mode;
      reportStatus({ status: 'unreachable', detail: 'fallback client failed: ' + String((err && err.message) || err) });
      return
    }
    inFallback = true;
    fallbackManual = manual === true;
    stats.fallbacks += 1;
    stats.fallbackManual = fallbackManual;
    mode = 'poll';
    stats.mode = mode;
    closeSource();
    fallbackClient = client;
    try { fallbackClient.start(); } catch (err) { onError(err); }
    // 去重键显式给 'fallback'：进入降级之前刚上报过 degraded 是同一个 status，按 status 去重会让这条"已降级"
    // 被自己的上一条吃掉——而降级是不能被静默的。
    reportStatus({
      status: fallbackManual ? 'disabled' : 'degraded',
      detail: (fallbackManual ? t('source.cnPollManual') : t('source.cnFallbackReason', { reason })) +
        t('source.cnFallbackDelay'),
    }, 'fallback');
  }

  /** 从轮询升回 SSE（只有**手动**选的轮询会被自动升回）。 */
  function leaveFallback() {
    if (!inFallback) return
    inFallback = false;
    fallbackManual = false;
    if (fallbackClient) { try { fallbackClient.stop(); } catch (err) { /* 忽略 */ } }
    fallbackClient = null;
    mode = 'idle';
    stats.mode = mode;
    // 降级期间推进读取位置的是**轮询客户端**（它写的正是同一个存储键），12c 自己的内存 `since` 停在进入降级之前
    // 那一刻；不重新读取本地存储就升回 SSE 会带着过期的读取位置建连，Host 于是重放整段固定长度缓冲。
    try {
      const stored = loadCursor();
      if (typeof stored === 'number' && Number.isFinite(stored) && stored >= 0) since = Math.floor(stored);
    } catch (err) { /* 读取本地存储失败就沿用内存值（退化为旧行为，不至于连不上） */ }
    consecutiveFails = 0;
    connectSse();
  }

  /** 单一的周期检查（每 5 秒）。用**一个**定时器同时管三个方向，因为它们会互相打架：灾种开关被关掉 → 主动
   *  断开 SSE（Host 侧十分钟后自然断开与 Wolfx 的连接）；开关又打开 → 恢复消费；「链路」选择变了 → 强制轮询
   *  ↔ 自动。分成多个定时器容易写出"关掉之后再也回不来"这种半途状态。 */
  function scheduleTick() {
    if (!running) return
    if (tickTimer) { clearTimer(tickTimer); tickTimer = null; }
    tickTimer = setTimer(() => {
      tickTimer = null;
      if (!running) return
      // 整段捕获异常：这个 tick 是**唯一**的恢复链（灾种开关往返、手动 / 自动链路切换都靠它），一次抛错就不会再
      // self-reschedule；reschedule 放在 catch 之外，保证无论成败都会重排。
      try {
        const cfg = getCfg();
        const on = enabled(cfg);
        if (!on) {
          if (mode !== 'disabled') enterDisabled();
        } else if (mode === 'disabled') {
          consecutiveFails = 0;
          // 恢复消费时**同样要先看用户的链路选择**：选了「强制轮询」就不该先建 SSE（白占一条 Wolfx 连接，还会
          // 在自检超时后谎报一次"连上但不推流"），与 start() 里的不变量一致。
          if (wantPoll(cfg)) activateFallback('manual polling selected', true);
          else connectSse();
        } else if (wantPoll(cfg)) {
          // 用户选了「强制轮询」。**已经在轮询（自动降级来的）时也要认下这个选择**：否则 fallbackManual 永远是
          // false，用户之后改回「自动」时 leaveFallback 分支不成立 → 永久停在轮询。
          if (!inFallback) activateFallback('manual polling selected', true);
          else if (!fallbackManual) {
            fallbackManual = true;
            stats.fallbackManual = true;
            reportStatus({ status: 'disabled', detail: t('source.cnPollManual') + t('source.cnPollDelay') }, 'fallback:manual');
          }
        } else if (inFallback && fallbackManual) {
          // 用户改回「自动」：手动选的轮询要能撤销。自动降级的不升回——那条链路已经证明过不通。
          leaveFallback();
        }
        // **持续静默**的存活判据（放在链路选择之后：用户刚改回自动时应先建连）。Host 每 15 秒发一个 status 帧，
        // 超时没有帧即判死：关流重连，连续 maxFails 次就降级——否则界面会永远停在"SSE 已连接"。
        if (silenceDeadMs > 0 && mode === 'sse' && source && lastFrameAt &&
            (now() - lastFrameAt) > silenceDeadMs) {
          stats.silentDeaths += 1;
          consecutiveFails += 1;
          closeSource();
          reportStatus({
            status: 'degraded',
            detail: 'SSE silent ' + Math.round(silenceDeadMs / 1000) + 's → dead',
          });
          if (consecutiveFails >= maxFails) activateFallback('silent disconnect');
          else connectSse();
        }
      } catch (err) { onError(err); }
      scheduleTick();
    }, CN_RECHECK_MS);
    if (tickTimer && typeof tickTimer.unref === 'function') tickTimer.unref();
  }

  function connectSse() {
    if (!running || source) return
    sawSyncThisConn = false;
    stats.connections += 1;
    const url = path + (path.indexOf('?') === -1 ? '?' : '&') +
      // 页面首次建立连接时带上已持久化的读取位置：刷新 / 重开标签页都能补齐断线期间的事件；之后浏览器自动重连时会带
      // `Last-Event-ID`，Host 优先用它（更准）。
      'since=' + (since === null ? 'tail' : since);
    let es;
    try {
      es = createEventSource(url);
    } catch (err) {
      onError(err);
      consecutiveFails += 1;
      reportStatus({ status: 'unreachable', detail: 'EventSource failed: ' + String((err && err.message) || err) });
      return activateFallback('EventSource failed')
    }
    if (!es || typeof es.addEventListener !== 'function') {
      consecutiveFails += 1;
      reportStatus({ status: 'unreachable', detail: 'no EventSource available' });
      return activateFallback('EventSource unsupported')
    }
    source = es;
    mode = 'sse';
    stats.mode = mode;
    // 静默判据的起点：建连那一刻起算，第一条数据之前的判定仍由下面的 8 秒自检负责（更精确）。
    lastFrameAt = now();
    /** sync 帧算出的告警（增量缺口 / 读取位置重置 / Host 侧未在运行）。**必须留到 status 帧继续带上**：
     *  store.pushSource 整体替换 status + detail，而 status 帧每 15 秒就来一次，只报"已连接"会让这三条
     *  告警在 15 秒后自己消失——它们的条件其实仍然成立。 */
    let connWarn = [];
    const onSync = (ev) => {
      if (source !== es) return
      sawSyncThisConn = true;
      lastFrameAt = now();
      consecutiveFails = 0;
      stats.syncs += 1;
      stats.lastAt = Date.now();
      let d = null;
      try { d = JSON.parse(String(ev && ev.data)); } catch (err) { d = null; }
      if (d && d.truncated) stats.truncated += 1;
      if (d && d.reset) stats.resets += 1;
      stats.frozen = !!(d && d.frozen);
      stats.stale = !!(d && d.stale);
      if (d && Number.isFinite(d.dataTime)) stats.dataTime = d.dataTime;
      // 同一个数据时间也交给自检——自检按**契约里的阈值**判，Host 侧继续按它自己的常量判（它能分辨"中继停更"
      // 与"数据陈旧"）；两者用的是同一个数值。
      if (d && Number.isFinite(d.dataTime) && d.dataTime > 0) noteFreshness(id, d.dataTime);
      // Host 明确说重置过（它重启 / 时钟回拨）→ **允许读取位置回退**并对齐到它的当前位置，否则本地读取位置卡在比 Host
      // 大的值上，每次重连都会 reset + 全量重放；没有补发条目 = 已经在线，读取位置就是 Host 的当前位置 → 同样对齐。
      if (d && d.reset && Number.isFinite(d.cursor)) setCursor(d.cursor, true);
      else if (d && Number.isFinite(d.cursor) && (!d.replayed || d.replayed === 0)) setCursor(d.cursor);
      const warn = [];
      if (d && d.truncated) warn.push('gap: host ring buffer evicted entries');
      if (d && d.reset) warn.push('host cursor reset');
      if (d && d.frozen) warn.push('host source not running');
      connWarn = warn;
      // stale 有**自己的状态**（中灰「数据已过期」），不折叠进 degraded：源在响应、但给的是旧数据；口径与 12b 一致。
      reportStatus({
        status: stats.stale ? 'stale' : (warn.length ? 'degraded' : 'open'),
        detail: 'SSE connected' + (d ? ' · replayed ' + (d.replayed || 0) : '') +
          ' · received ' + stats.received + '' +
          (stats.stale ? ' · relay stale' : '') +
          (warn.length ? ' · ' + warn.join('；') : ''),
      });
    };
    /** Host 的周期状态帧（每 15 秒，兼作 SSE keep-alive）。它存在的理由是**停更**：停更的形态就是"不再有新
     *  entry"，只看 entry 的话状态会永远停在连接那一刻；Host 不推这一帧，默认（SSE）路径下这件事在界面上
     *  完全不可见——只有降级到轮询之后才读得到 /feed 的 stats。 */
    const onStatusFrame = (ev) => {
      if (source !== es) return
      // 状态帧同样是"这条连接还活着"的证据——Host 每 15 秒必发一个，静默判据正是靠它。
      lastFrameAt = now();
      let d = null;
      try { d = JSON.parse(String(ev && ev.data)); } catch (err) { d = null; }
      if (!d || typeof d !== 'object') return
      stats.stale = d.stale === true;
      // Host 说"中继连接断了"时界面不能继续显示绿色已连接：`connected` 只有 Host 知道（它才持有那条 WebSocket）。
      if (typeof d.connected === 'boolean') stats.hostConnected = d.connected;
      stats.hostError = d.lastError ? String(d.lastError) : '';
      if (Number.isFinite(d.dataTime)) stats.dataTime = d.dataTime;
      if (Number.isFinite(d.dataTime) && d.dataTime > 0) noteFreshness(id, d.dataTime);
      // 有意**不更新** stats.lastAt：它表示"最近一条数据"，而状态帧每 15 秒必到，更新它会让设置页永远显示"最近数据 0 秒前"。
      const hostWarn = [];
      if (stats.hostConnected === false) hostWarn.push('relay disconnected');
      if (stats.hostError) hostWarn.push(stats.hostError);
      const warnAll = connWarn.concat(hostWarn);
      reportStatus({
        status: stats.stale ? 'stale' : (warnAll.length ? 'degraded' : 'open'),
        detail: 'SSE connected · received ' + stats.received + '' +
          (stats.stale ? ' · relay stale' : '') +
          (warnAll.length ? ' · ' + warnAll.join(' · ') : ''),
      });
    };
    const onEntry = (ev) => {
      if (source !== es) return
      // 收到真实数据即证明链路是通的：该计数也被"连续 N 次没收到第一条数据"的降级判定使用，只在 sync 帧归零会让零星 error 累积。
      consecutiveFails = 0;
      stats.lastAt = Date.now();
      stats.lastEventAt = Date.now();
      lastFrameAt = now();
      let entry = null;
      try { entry = JSON.parse(String(ev && ev.data)); } catch (err) { entry = null; }
      if (!entry || typeof entry !== 'object') {
        stats.errors += 1;
        noteParseResult(id, failResult('schema', 'SSE frame is not valid JSON'));
        return
      }
      stats.received += 1;
      try {
        if (apply(entry, getCfg())) stats.applied += 1;
      } catch (err) {
        // 单条事件解析失败不能影响后续条目，也不能让读取位置停住
        stats.errors += 1;
        onError(err);
      }
      // 读取位置在 apply **之后**推进，与 12b 的口径一致（"已处理到的最后一条"）；先推读取位置的话 apply 抛错时那条就永久不再投递。
      if (Number.isFinite(entry.seq)) setCursor(entry.seq);
    };
    const onErrorEv = (ev) => {
      if (source !== es) return
      stats.sseErrors += 1;
      stats.errors += 1;
      consecutiveFails += 1;
      // EventSource 自己会按 readyState 重连，这里只判定"这条路走不通"：收到过 sync 的连接再出错多是网络抖动或
      // Host 重启，一次 sync 都没收到说明这条流从来没通过。
      reportStatus({
        status: 'degraded',
        detail: 'SSE down (x' + consecutiveFails + ')' + (sawSyncThisConn ? ' · reconnecting' : ''),
      });
      if (!sawSyncThisConn && consecutiveFails >= maxFails) activateFallback('no first frame x' + consecutiveFails);
    };
    try {
      es.addEventListener('sync', onSync);
      es.addEventListener('entry', onEntry);
      es.addEventListener('error', onErrorEv);
    } catch (err) { /* 极简实现可能不支持命名事件，下面由超时自检捕获 */ }
    // status 与上面分开注册：它是最可有可无的一帧（少了它只是看不到"停更"），不该因为某个实现不认这个事件名
    // 而把 sync / entry 的注册一起带走。
    try { es.addEventListener('status', onStatusFrame); } catch (err) { /* 忽略 */ }
    // 第一条数据的自检：连上但**不推流**（代理把流缓冲住了）与"连不上"是两回事，而 onerror 未必会来。
    if (probeMs > 0) {
      probeTimer = setTimer(() => {
        probeTimer = null;
        if (!running || source !== es || sawSyncThisConn) return
        stats.probeTimeouts += 1;
        consecutiveFails += 1;
        closeSource();
        reportStatus({ status: 'degraded', detail: 'SSE up but silent for ' + probeMs + 'ms (proxy buffering?)' });
        if (consecutiveFails >= maxFails) activateFallback('connected but silent');
        else connectSse();
      }, probeMs);
      // 与 tickTimer 一致地 unref：这个 8 秒自检不该把 Node 侧的测试进程拖住
      if (probeTimer && typeof probeTimer.unref === 'function') probeTimer.unref();
    }
  }

  function enterDisabled(patch) {
    mode = 'disabled';
    stats.mode = mode;
    closeSource();
    // 停用轮询降级端：它在跑的话也会一直拉
    if (fallbackClient) { try { fallbackClient.stop(); } catch (err) { /* 忽略 */ } fallbackClient = null; }
    inFallback = false;
    reportStatus({ status: 'disabled', detail: 'disabled · hazard switch off' });
    // 关掉灾种开关 → 不再读 `/feed` 与 `/stream` → Host 侧 10 分钟后自然断开与 Wolfx 的连接
  }

  return {
    id,
    label,
    path,
    start() {
      if (running) return
      running = true;
      registerSelf(); // 与 stop() 里的注销配对
      stats.cursor = cursorNow();
      scheduleTick();
      const cfg = getCfg();
      if (!enabled(cfg)) { enterDisabled(); return }
      // 用户选了「强制轮询」→ 一开始就不建 SSE（也不必先连一次再切，那会白占一条 Wolfx 连接）
      if (wantPoll(cfg)) { activateFallback('manual polling selected', true); return }
      connectSse();
    },
    stop() {
      running = false;
      closeSource();
      if (tickTimer) { clearTimer(tickTimer); tickTimer = null; }
      if (fallbackClient) { try { fallbackClient.stop(); } catch (err) { /* 忽略 */ } }
      fallbackClient = null;
      inFallback = false;
      fallbackManual = false;
      mode = 'idle';
      stats.mode = mode;
      unregisterSelf(); // 停用后不再挂在注册表里（见 registerSelf 的说明）
    },
    /** 测试与诊断：当前处于哪条链路。 */
    modeOf() { return mode },
    /** 测试与诊断：当前轮询是用户选的还是自动降级来的。 */
    fallbackIsManual() { return fallbackManual },
    stats() {
      return Object.assign({}, stats, {
        running, hasCursor: since !== null, fallbackActive: inFallback, fallbackManual,
      })
    },
    cursor() { return cursorNow() },
    hasCursor() { return since !== null },
  }
}

/** 大陆源客户端的注册表（id → { stats, mode }），供设置页与诊断快照**实时**读取：拷出来的快照会滞后一轮，
 *  而这里恰恰要靠计数判断"是不是根本没在收数据"。 */
const cnStreamRegistry = {};

// ============================================================================
// dsh-quake-alert · client/src/12d-health-probe.js
//
// 作用：机制层的自检调度——定时器按 `SOURCE_CONTRACTS[*].staleAfterMs` 判定各源新鲜度，并驱动
//       蓝点 TTL 自愈（`pruneHealth`）。契约是唯一阈值来源，源只上报最后取数时刻、自己不判 stale；
//       自检不发外部请求，只读已有的数据时间。
// 依赖：05d（契约声明）、05g（健康记录）、07-store（状态上报）。
// ============================================================================


/** 自检周期。最短阈值是 USGS 的 30 分钟，30 秒分辨率够用，每轮只遍历 8 条记录、不发请求。 */
const PROBE_INTERVAL_MS = 30 * 1000;

/**
 * 取某个源的新鲜度阈值（毫秒）；`null` / 非正数表示这条链路不判新鲜度。`staleAfterMs: null` 的是推送源
 * （P2PQuake / EMSC / cenc_eew，活性由连接层负责）。Host 与 Client 分开构建，`lib/` 不能 import 本契约，
 * 故 Host 侧仍保留自己的 `feedStaleMs` 常量，两边一致性由回归断言守护。
 */
function staleAfterOf(sourceId) {
  const c = SOURCE_CONTRACTS[sourceId];
  if (!c) return 0
  const v = c.staleAfterMs;
  return (typeof v === 'number' && Number.isFinite(v) && v > 0) ? v : 0
}

/** 毫秒 → 中文可读（诊断与状态行用）。 */
function humanMinutes(ms) {
  const m = Math.round(ms / 60000);
  if (m < 60) return m + 'm'
  return (Math.round(m / 6) / 10) + 'h'
}

/**
 * 建一个自检器。定时器与 pushSource 都可注入（测试用假时钟直接调 `tick()`，不等真实定时器）。
 * @param {object} [opts] 另有 now / intervalMs / setTimer / clearTimer 可注入。
 * @param {(id: string, patch: object) => void} [opts.pushSource] 注入点（测试用）：注入时按原样
 *   推送以便断言原始 patch；生产路径必须经 `publishStatus` 合成新鲜度 / 连接层 / 数据健康层。
 * @param {(id: string) => boolean} [opts.sourceEnabled] 该源当前是否被用户开着。关掉的源不判
 *   stale：Client 不再拉它，dataTime 停在关掉前的值。默认全部视为开启。
 */
function createHealthProbe(opts = {}) {
  const now = opts.now || (() => Date.now());
  const intervalMs = opts.intervalMs === undefined ? PROBE_INTERVAL_MS : opts.intervalMs;
  const setTimer = opts.setTimer || ((fn, ms) => setInterval(fn, ms));
  const clearTimer = opts.clearTimer || ((t) => clearInterval(t));
  const sourceEnabled = opts.sourceEnabled || (() => true);
  // 默认经 publishStatus 合成展示状态（新鲜度 + 连接层 + 数据健康层）；直接 pushSource 会让
  // "数据已恢复更新"刷掉 schema-error 蓝点。
  const push = opts.pushSource || ((id, patch) => publishStatus(id, patch));
  let timer = null;

  /**
   * 跑一轮：先做 TTL 自愈，再逐源判新鲜度。`dataTime` 从未上报（0）时不判——"不知道数据什么时候
   * 来的"不等于"数据是旧的"。返回本轮时刻。
   */
  function tick() {
    const t = now();
    pruneHealth(t);
    for (const id of Object.keys(SOURCE_CONTRACTS)) {
      const after = staleAfterOf(id);
      if (after <= 0) continue
      // 源被用户关掉时不判新鲜度（Client 不再拉它，dataTime 停在关掉前的值）；先清掉可能残留的
      // stale，否则关闭那一刻的 stale 会一直挂到重开。
      if (!sourceEnabled(id)) {
        const recOff = sourceHealthOf(id);
        if (recOff && recOff.fresh && recOff.fresh.stale) {
          noteStale(id, false, t);
          push(id, { status: 'disabled', detail: 'disabled · hazard switch off' });
        }
        continue
      }
      const rec = sourceHealthOf(id);
      const dataTime = rec && rec.fresh && Number.isFinite(rec.fresh.dataTime) ? rec.fresh.dataTime : 0;
      if (!(dataTime > 0)) continue
      const stale = (t - dataTime) > after;
      const was = !!(rec && rec.fresh && rec.fresh.stale);
      noteStale(id, stale, t);
      if (stale !== was) {
        // 只在翻转的那一刻上报：状态没变时每次 push 都会让设置页与状态点重渲一遍。恢复时给的
        // 是 `open`，源自己的连接状态由源的下一次上报纠正。
        push(id, stale
          ? { status: 'stale', detail: 'stale · no new data for ' + humanMinutes(after) }
          : { status: 'open', detail: 'data fresh again' });
      }
    }
    return t
  }

  return {
    intervalMs,
    tick,
    start() {
      if (timer) return
      timer = setTimer(tick, intervalMs);
      if (timer && typeof timer.unref === 'function') timer.unref();
    },
    stop() {
      if (timer) { clearTimer(timer); timer = null; }
    },
  }
}

// ============================================================================
// dsh-quake-alert · client/src/12e-overseas-poll.js — 海外气象源（美国 NWS / 加拿大 ECCC）的取数器：
// 按关注点查询外部 REST，逐条交给解析契约，命中门槛的交给主链；每轮读一次配置、串行请求，
// `staleAfterMs` 为 null 故不判停更。依赖 02-storage、03-settings-bridge、05d、05g、07-store、11-pipeline。
// ============================================================================


/** NWS 的洪水类查询端点（全量 `/alerts/active` 1.67MB 不可用）。 */
const NWS_ALERTS_BASE = 'https://api.weather.gov/alerts/active';
/** ECCC 的预警集合（OGC API - Features）。 */
const ECCC_ALERTS_BASE = 'https://api.weather.gc.ca/collections/weather-alerts/items';
/**
 * NWS 的 `?event=` 白名单参数——从 05h 的白名单派生（同一个集合）。它是发给上游的服务端过滤：
 * 漏同步不会报错，只是那一类永远不返回（静默漏报）。
 */
const NWS_EVENT_QUERY = Object.keys(NWS_EVENT_WHITELIST).join(',');

const NWS_POLL_MS = 120 * 1000;
const ECCC_POLL_MS = 300 * 1000;
/** 首轮延迟：错开启动窗口，也让设置页先渲染出来。 */
const OVERSEAS_FIRST_DELAY_MS = 4000;
/** 单次请求超时（Client 侧统一 10 秒）。 */
const OVERSEAS_TIMEOUT_MS = 10 * 1000;
/** 单次响应体上限。ECCC 的 bbox 查询在预警密集时实测可到 200KB（几何 + 双语正文）。 */
const OVERSEAS_MAX_BODY_CHARS = 512 * 1024;
/** 半径小于它时只查中心点：NWS 的县通常比它大，采样点会落进同一个县，白花请求。 */
const MIN_SAMPLE_RADIUS_KM = 25;
/** 每轮请求数上限：20 个关注点 × 5 个采样点 = 100，串行跑完会超过一轮的间隔。 */
const MAX_REQUESTS_PER_ROUND = 40;
/** 时效门槛：首轮（或距上次成功超过 GATE_RESET）时，只播报发布在这么久以内的条目。 */
const OVERSEAS_FRESH_GATE_MS = 6 * 60 * 60 * 1000;
/** 距上次成功超过这么久，就重新按"首轮"处理（页面休眠恢复后不该把几小时前的当新警报）。 */
const OVERSEAS_GATE_RESET_MS = 30 * 60 * 1000;
/**
 * HTTP 400 之后的冷却期：冷却期内跳过该 URL，到期自动重试一次（400 也可能是我们的参数被上游拒绝）。
 */
const UNCOVERED_TTL_MS = 60 * 60 * 1000;
/** 整轮全部失败时，重试间隔逐次延长的起点与上限。 */
const OVERSEAS_MIN_BACKOFF_MS = 1000;
const OVERSEAS_MAX_BACKOFF_MS = 60 * 1000;

/**
 * 海外源的计数快照（供设置页的状态区块与诊断快照读取）：轮次 / 请求数 / 未覆盖 / 时效门槛。
 */
const overseasStatsOf = {};

/** 覆盖范围包围盒：盒外的关注点不产生请求。NWS 对覆盖外的点回 400，由 pollOnce 的 `uncovered`
 *  分类捕获；盒内重叠（美加边境）会让同一个点查两个源。含波多黎各与美属维尔京群岛、关岛与
 *  北马里亚纳、美属萨摩亚（都是 NWS 的正式预报区）。 */
const US_BOXES = [
  { minLat: 24, maxLat: 50, minLon: -125, maxLon: -66 }, // 本土
  { minLat: 51, maxLat: 72, minLon: -170, maxLon: -129 }, // 阿拉斯加
  { minLat: 18, maxLat: 23, minLon: -161, maxLon: -154 }, // 夏威夷
  { minLat: 17, maxLat: 19, minLon: -68, maxLon: -64 }, // 波多黎各 / 美属维尔京群岛
  { minLat: 13, maxLat: 21, minLon: 144, maxLon: 146 }, // 关岛 / 北马里亚纳
  { minLat: -15, maxLat: -13, minLon: -171, maxLon: -169 }, // 美属萨摩亚
];
const CA_BOX = { minLat: 41, maxLat: 84, minLon: -141, maxLon: -52 };

/** 1 纬度的公里数（地球平均半径口径，与 06-matcher 的 distanceKm 同一量级即可）。 */
const KM_PER_DEG = 111;

const inBox = (p, b) => p.lat >= b.minLat && p.lat <= b.maxLat && p.lon >= b.minLon && p.lon <= b.maxLon;

/** 关注点里落在给定包围盒内的那些（配置不合法的一律跳过，不猜）。 */
function placesInBoxes(cfg, boxes) {
  const out = [];
  for (const p of ((cfg.watch || {}).places || [])) {
    if (!p || typeof p.lat !== 'number' || typeof p.lon !== 'number') continue
    if (!Number.isFinite(p.lat) || !Number.isFinite(p.lon)) continue
    if (boxes.some((b) => inBox(p, b))) out.push(p);
  }
  return out
}

/** 经度方向的度数：高纬度处同样的公里数对应更多经度，除以 cos 是必须的（否则 bbox 会偏窄）。 */
function lonDegreesOf(km, lat) {
  const c = Math.cos((Math.max(-89.9, Math.min(89.9, lat)) * Math.PI) / 180);
  return km / (KM_PER_DEG * Math.max(0.05, c))
}

// 采样点 / bbox 的坐标夹取：半径 2000km 时高纬度的方位点会算出 `lon < -180`，那样的 URL 会被上游回 400。
const clampLat = (v) => Math.max(-90, Math.min(90, v));
const clampLon = (v) => Math.max(-180, Math.min(180, v));

/** ECCC 的 bbox：坐标 ± 半径（经度按纬度修正）。NWS 不支持 bbox，只按点查（`?point=`）。 */
function ecccBboxOf(place) {
  const dLat = Number(place.radiusKm || 0) / KM_PER_DEG;
  const dLon = lonDegreesOf(Number(place.radiusKm || 0), place.lat);
  const f = (n) => Number(n.toFixed(4));
  return [
    f(clampLon(place.lon - dLon)), f(clampLat(place.lat - dLat)),
    f(clampLon(place.lon + dLon)), f(clampLat(place.lat + dLat)),
  ].join(',')
}

/** NWS 的采样点：中心 + （半径够大时）四个方位。返回 `[lat, lon]` 数组。 */
function nwsSamplePoints(place) {
  const pts = [[place.lat, place.lon]];
  const r = Number(place.radiusKm || 0);
  if (!(r >= MIN_SAMPLE_RADIUS_KM)) return pts
  const dLat = r / KM_PER_DEG;
  const dLon = lonDegreesOf(r, place.lat);
  pts.push([clampLat(place.lat + dLat), place.lon]);
  pts.push([clampLat(place.lat - dLat), place.lon]);
  pts.push([place.lat, clampLon(place.lon + dLon)]);
  pts.push([place.lat, clampLon(place.lon - dLon)]);
  return pts
}

/** 默认取数：Node / 浏览器通用的 fetch，带超时与 Accept。 */
async function defaultFetchText(url, ctx) {
  const signal = ctx && ctx.signal;
  const timeoutMs = ctx && typeof ctx.timeoutMs === 'number' ? ctx.timeoutMs : OVERSEAS_TIMEOUT_MS;
  const work = (async () => {
    const res = await fetch(url, { signal, headers: { Accept: 'application/json' } });
    if (!res.ok) {
      // 带上状态码：NWS 对覆盖范围之外的坐标返回 400，那与"网络不通"是两回事（见 pollOnce）。
      const err = new Error('HTTP ' + res.status);
      err.status = res.status;
      // 400 的响应体自带原因（NWS 是 `Invalid Parameter` + parameterErrors），只留给诊断、不参与判据。
      if (res.status === 400) {
        try { err.bodyHint = String(await res.text()).slice(0, 160); } catch (e) { /* 读不到就算了 */ }
      }
      throw err
    }
    // 按流读取并在超限处立刻停：`await res.text()` 之后才比长度时整个响应体已进内存，上限只
    // 保护了后续 JSON.parse 的代价。比的是字符数，而流按字节计——取字节数偏保守（宁可早停）。
    const stream = res.body;
    const dec = typeof TextDecoder !== 'undefined' ? new TextDecoder('utf-8') : null;
    // 没有 TextDecoder 就只能 `String(chunk)`（字节数组的逗号串），解出来一定是坏 JSON，故退化。
    if (dec && stream && typeof stream.getReader === 'function') {
      const reader = stream.getReader();
      let out = '';
      let total = 0;
      try {
        for (;;) {
          const step = await reader.read();
          if (!step || step.done) break
          const chunk = step.value;
          total += chunk && typeof chunk.byteLength === 'number' ? chunk.byteLength : 0;
          if (total > OVERSEAS_MAX_BODY_CHARS) {
            try { await reader.cancel(); } catch (e) { /* 取消失败不影响判定 */ }
            throw new Error('body too large (' + total + ' > ' + OVERSEAS_MAX_BODY_CHARS + ' bytes)')
          }
          out += dec.decode(chunk, { stream: true });
        }
        out += dec.decode();
      } finally {
        try { reader.releaseLock(); } catch (e) { /* 已释放 */ }
      }
      return out
    }
    return await res.text()
  })();
  if (signal) return await work
  // 没有 AbortController 时用 Promise.race 实现超时保护：否则单次请求可以永久挂住，下一轮不再排，
  // 整条轮询链静默停摆、状态还保持绿色。
  return await Promise.race([
    work,
    new Promise((_, reject) => {
      setTimeout(() => reject(new Error(t('source.noAbortController'))), timeoutMs);
    }),
  ])
}

/**
 * 通用海外取数器，与 12b 的 createFeedClient 接口同形（start / stop / pollOnce / pollSerial / stats）。
 * @param {object} opts 另有 id / label / intervalMs / firstDelayMs / enabled / getCfg / placesFor(cfg)
 *   -> place[]（该国关注点）/ urlsFor(place, cfg) -> string[]（该点的查询 URL，NWS 多个采样点、
 *   ECCC 一个 bbox）/ parseOne(feature, place) -> result / onStatus(patch) / onError(err) / fetchText(url, ctx)
 */
function createOverseasSource(opts = {}) {
  const id = opts.id || 'overseas';
  const label = opts.label || id;
  const regionText = opts.regionText || '';
  const intervalMs = opts.intervalMs || NWS_POLL_MS;
  const firstDelayMs = opts.firstDelayMs === undefined ? OVERSEAS_FIRST_DELAY_MS : opts.firstDelayMs;
  const getCfg = opts.getCfg || currentCfg;
  const fetchText = opts.fetchText || defaultFetchText;
  const onError = opts.onError || (() => {});
  const onStatus = opts.onStatus || (() => {});
  const enabled = opts.enabled || ((cfg) => (cfg.disasters || {}).overseasWeather !== false);
  const placesFor = opts.placesFor || (() => []);
  const urlsFor = opts.urlsFor || (() => []);
  const parseOne = opts.parseOne || (() => ({ ok: false, kind: 'schema', detail: 'no parser configured' }));
  // 超时与 400 冷却期时长可注入，便于回归测试在毫秒级验这两条路径（`NaN` 也是 number 而
  // `setTimeout(fn, NaN)` 会立即触发，故用 Number.isFinite 判）。
  const timeoutMs = Number.isFinite(opts.timeoutMs) ? opts.timeoutMs : OVERSEAS_TIMEOUT_MS;
  const uncoveredTtlMs = Number.isFinite(opts.uncoveredTtlMs) ? opts.uncoveredTtlMs : UNCOVERED_TTL_MS;
  // 交给主链的出口可注入：默认是 11-pipeline 的 handleAlert，测试注入 spy 后只验取数器交出了什么。
  const onAlert = opts.onAlert || handleAlert;

  let timer = null;
  let running = false;
  let stopped = false;
  let inFlight = null;
  let abortCtl = null;
  let lastStatusKey = '';
  let lastSuccessAt = 0;
  let lastError = '';
  /** 时效门槛上一轮是否处于激活状态（用于"只在进入时计数"，见 pollOnce 里的 gated）。 */
  let gateActive = false;
  /** 整轮全部失败时的重试间隔递增量（0 = 不递增，用正常间隔）。 */
  let backoffMs = 0;
  const stats = {
    polls: 0, requests: 0, received: 0, applied: 0, errors: 0,
    ageSkipped: 0, throttledLast: 0, throttledTotal: 0, gated: 0, rejected: 0,
    truncated: 0, lastAt: 0, lastDataAt: 0,
  };
  // 会话内记住"这些 URL 暂时别查"（键 = URL，值 = 可以再试的时刻），到期自动重试一次。
  const uncovered = new Map();

  /** 状态上报：只在变化时送出；除自己上一轮的值，还比 store 里的当前值（自检 / 健康层也写同一个源）。 */
  function reportStatus(patch) {
    const eff = effectiveStatusOf(id, patch.status, patch.detail);
    const cur = ((store.sources || {})[id] || {});
    // 去重键 = status + detail：只比 status 会让"同一状态下的语义变化"永远推不出去；代价是
    // detail 里不能放单调计数（那会让每轮都判为变化、整页重渲），计数由 13-ui 直接读 stats。
    const key = eff.status + '|' + String(eff.detail || '');
    if (key === lastStatusKey && cur.status === eff.status && String(cur.detail || '') === String(eff.detail || '')) return
    lastStatusKey = key;
    // 与 12b 同形：由调用方（15-entry 的 feedStatus）统一写入，本模块不直接写 store（否则一轮 publish 两次）。
    try { onStatus(Object.assign({ label }, eff)); } catch (err) { /* UI 回调异常不影响轮询 */ }
  }

  async function pollOnce() {
    if (stopped) return { applied: 0, aborted: true }
    const cfg = getCfg();
    stats.lastAt = Date.now();
    if (!enabled(cfg)) {
      reportStatus({ status: 'disabled', detail: t('source.overseasDisabled') });
      return { applied: 0, disabled: true }
    }
    const places = placesFor(cfg);
    if (places.length === 0) {
      // 与坐标型源同一条原则（06-matcher 的 noWatch）：不静默——"配错了关注点"看起来像"根本
      // 没有预警"。这里不产生任何网络请求。是"配置里没有点"还是"有点但都在覆盖盒外"必须分开说。
      const anyPlaces = ((cfg.watch || {}).places || []).length > 0;
      reportStatus({
        status: 'open',
        detail: (anyPlaces
          ? t('source.overseasNoneInCoverage', { region: regionText })
          : t('source.overseasNoPlaces', { region: regionText })) +
          t('source.settingsHint'),
      });
      return { applied: 0, noPlaces: true }
    }
    // 请求清单：先保证每个关注点都被查一次，再补采样点——按顺序平铺后整段截断会让排在后面的
    // 关注点每轮都被截断、永远查不到（静默漏报）。每个关注点的第一个 URL 无条件排上，剩下的
    // 额度才补方位采样点；真超出时 `skippedPlaces` 如实计数。
    const now = Date.now();
    // 暂时被上游拒绝的 URL 先跳过（TTL 到期后会自动重试一次，见下面 400 分支）
    const groups = places
      .map((p) => ({ place: p, urls: (urlsFor(p, cfg) || []).filter((u) => !(uncovered.get(u) > now)) }))
      .filter((g) => Array.isArray(g.urls) && g.urls.length > 0);
    const reqs = [];
    for (const g of groups) reqs.push({ place: g.place, url: g.urls[0] });
    const coreCount = reqs.length;
    // 补方位采样点的起点按轮次轮转：固定顺序会让排在后面的关注点每轮都只拿到中心点，等效半径退化成"那一个县"。
    const offset = groups.length > 0 ? (stats.polls % groups.length) : 0;
    const rotated = groups.slice(offset).concat(groups.slice(0, offset));
    for (const g of rotated) {
      for (let i = 1; i < g.urls.length; i += 1) {
        if (reqs.length >= MAX_REQUESTS_PER_ROUND) break
        reqs.push({ place: g.place, url: g.urls[i] });
      }
      if (reqs.length >= MAX_REQUESTS_PER_ROUND) break
    }
    const capped = reqs.slice(0, MAX_REQUESTS_PER_ROUND);
    // 被截断的采样点数要按"本该有多少"算：补采样点时已 break 在上限上，剩下的没进 reqs。
    const wantSamples = groups.reduce((n, g) => n + Math.max(0, g.urls.length - 1), 0);
    const gotSamples = Math.max(0, capped.length - Math.min(coreCount, capped.length));
    const skippedPlaces = Math.max(0, coreCount - capped.length);
    const skippedSamples = Math.max(0, wantSamples - gotSamples);
    // `Last` 是本轮值（设置页看当下）、`Total` 是累计值（诊断里看趋势），两个计数分开。
    stats.throttledLast = skippedPlaces + skippedSamples;
    stats.throttledTotal += stats.throttledLast;

    // 时效门槛：首轮或"距上次成功超过 30 分钟"（页面休眠恢复）时，只把发布在 6 小时以内的当新警报。
    const gated = (now - lastSuccessAt) > OVERSEAS_GATE_RESET_MS;
    // 只在进入门槛的那一刻计数：源持续不可达时 lastSuccessAt 一直不更新，否则每轮都会 +1。
    if (gated && !gateActive) stats.gated += 1;
    gateActive = gated;

    stats.polls += 1;
    stats.requests += capped.length;
    let okCount = 0;
    let failCount = 0;
    let applied = 0;
    let rejectedNow = 0;
    let newestDataAt = 0;
    /** 本轮有多少个响应被 ECCC 的分页上限截断（轮末汇总成 stats.truncated，见下）。 */
    let truncatedNow = 0;
    // 同一条预警可能被多个采样点查到（中心点与方位点落进同一个县）→ 一轮内只处理一次。
    const seen = new Set();
    for (const item of capped) {
      if (stopped) break
      // 超时标记：`AbortController.abort()` 的错误与"用户停用插件"在 fetch 层完全同形，只靠 `stopped` 区分不了。
      let timedOut = false;
      abortCtl = typeof AbortController === 'function' ? new AbortController() : null;
      const timerId = abortCtl
        ? setTimeout(() => { timedOut = true; try { abortCtl.abort(); } catch (e) {} }, timeoutMs)
        : null;
      try {
        const text = await fetchText(item.url, {
          signal: abortCtl ? abortCtl.signal : undefined,
          timeoutMs,
        });
        if (typeof text !== 'string') throw new Error('fetcher returned non-text')
        if (text.length > OVERSEAS_MAX_BODY_CHARS) {
          throw new Error('body too large (' + text.length + ' > ' + OVERSEAS_MAX_BODY_CHARS + ' chars)')
        }
        let json = null;
        try {
          json = JSON.parse(text);
        } catch (err) {
          // HTTP 200 却不是 JSON（拦截页 / 上游改版）按 schema 上报，不按链路故障（否则同一份证据两个六态）。
          noteParseResult(id, failResult('schema', 'response is not JSON (blocked page or upstream change?)'));
          throw new Error('response is not JSON (blocked page or upstream change?)')
        }
        const feats = json && Array.isArray(json.features) ? json.features : null;
        if (!feats) {
          // 顶层结构不符 = 契约漂移（蓝点：用户处理不了、等插件更新），不是链路故障（红点）。
          noteParseResult(id, failResult('schema', 'response lacks features[]'));
          throw new Error('response lacks features[]')
        }
        // 结构正确但空数组（NWS 按点查询的常态）交给轮末统一判定：逐响应上报 `empty` 会
        // `clearData`（清蓝点 + 归零连续失败计数），同轮其它 URL 的 schema 失败就被清零。
        if (typeof json.numberMatched === 'number' && json.numberMatched > feats.length) truncatedNow += 1;
        okCount += 1;
        stats.received += feats.length;
        for (const feature of feats) {
          // 单条各自捕获异常：整个 features 循环与 fetch 共用一个 try，会让一条 entry 的解析 /
          // 主链异常被记成"这个请求失败"，还会静默丢掉该响应里剩下的条目。
          let res = null;
          try {
            res = parseOne(feature, item.place);
          } catch (parseErr) {
            stats.errors += 1;
            lastError = 'item parse threw: ' + String((parseErr && parseErr.message) || parseErr);
            continue
          }
          // 逐条 empty 必须传 `perItem`：只计数、不清蓝点——单条"不在范围内"不能证明同轮其它
          // 条目的 schema 失败已恢复。
          if (noteParseResult(id, res, undefined, { perItem: true })) continue
          if (!res.ok) continue
          const alert = res.alert;
          if (seen.has(alert.id)) continue
          seen.add(alert.id);
          noteSourceSuccess(id);
          const issued = Date.parse(alert.issued);
          if (Number.isFinite(issued) && issued > newestDataAt) newestDataAt = issued;
          const stale = gated && Number.isFinite(issued) && (now - issued) > OVERSEAS_FRESH_GATE_MS;
          // 只统计本来会被播报的那些：Watch / Advisory 由档位决定（`overseasRank < 3`）本来就
          // 不播报，算进"过老只记历史"会让设置页那个数字失去解释力。
          const rank = typeof alert.overseasRank === 'number' ? alert.overseasRank : 0;
          if (stale && rank >= OVERSEAS_BROADCAST_MIN_RANK) stats.ageSkipped += 1;
          // 过老的条目仍然交给主链（带 staleOnArrival，主链走"命中 + 只记历史"那条分支），
          // 丢掉它会让用户看不到"就在打开页面前刚发布的洪水预警"。
          try {
            onAlert(alert, cfg, stale ? { staleOnArrival: Math.round((now - issued) / 3600000) } : undefined);
          } catch (alertErr) {
            stats.errors += 1;
            lastError = 'pipeline threw: ' + String((alertErr && alertErr.message) || alertErr);
            continue
          }
          applied += 1;
        }
      } catch (err) {
        // 用户主动停用不是故障：stop() 会 abort 在途请求，照常累加会在侧边栏留下红点并往诊断里写中止信息。
        if (stopped) return { applied, aborted: true }
        // 400 = "这个坐标不在我的服务范围内"（NWS 实测对加拿大 / 英国的点都这么答）：参数问题、
        // 不是链路故障，显示成红色"不可达"会让用户以为插件坏了。① 不替上游断言原因（文案只说
        // "被上游拒绝（HTTP 400）"，响应体前 160 字留在诊断里）；② 拉黑带 TTL，1 小时后重试一次；
        // ③ 按请求（URL）记而不是按关注点——NWS 的覆盖外是逐点的。
        if (err && err.status === 400) {
          stats.rejected += 1;
          rejectedNow += 1;
          uncovered.set(item.url, now + uncoveredTtlMs);
          if (!lastError) lastError = 'HTTP 400（' + String(err.bodyHint || '').slice(0, 160) + '）';
          // 400 也是"上游有响应"，同样算一次成功接触：否则只配了覆盖外坐标的用户 lastSuccessAt
          // 永远不更新、时效门槛恒处于"首轮"。
          lastSuccessAt = Date.now();
          continue
        }
        failCount += 1;
        stats.errors += 1;
        // 超时自己标记过 → 给一条能读懂的原因（否则诊断里会写 "The user aborted a request."）。
        const timedOutNow = timedOut && !(err && err.status);
        lastError = timedOutNow
          ? 'timeout (' + Math.round(timeoutMs / 1000) + 's)'
          : String((err && err.message) || err);
        onError(timedOutNow ? new Error(lastError) : err);
      } finally {
        if (timerId) clearTimeout(timerId);
        abortCtl = null;
      }
    }
    if (newestDataAt) {
      stats.lastDataAt = newestDataAt;
      // 上报"最后一次拿到数据的时刻"：契约里这条源的 staleAfterMs 是 null（自检不判），
      // 但诊断快照与排障要看得到它。
      noteFreshness(id, newestDataAt);
    }
    // 轮末的两条轮级判定：① 分页截断按轮计数（按响应累加时 N 个关注点的一轮会 +N，与 UI 说法
    // 不符）；② 结构正常的空结果只在整轮无失败时才判"结构没问题"（05g 的 empty 语义，清蓝点）。
    if (truncatedNow) stats.truncated += 1;
    // `applied === 0` 时才需要它：有成功解析的条目时 `noteSourceSuccess` 已经清过蓝点。
    if (okCount > 0 && failCount === 0 && applied === 0) {
      noteParseResult(id, failResult('empty', 'ok structure, nothing in scope'));
    }
    // 停用之后不再写状态，否则"用户主动关掉插件"会在侧边栏留下红点、诊断里多一条中止信息。
    if (stopped) return { applied, aborted: true }
    // 成功一轮就清掉上次的失败文案，否则一次瞬时 500 会永远挂在诊断里。
    if (okCount > 0 && failCount === 0) lastError = '';
    // 状态分类：有响应且无失败 → open；有响应也有失败 → degraded（仍在工作）；
    // 全部失败 → unreachable（红色，环境问题）；全部被 400 拒绝 → 仍是 open（参数问题）。
    if (okCount > 0 && failCount === 0) {
      lastSuccessAt = Date.now();
      // detail 只放非单调的语义信息（它进去重键），但也不能留空——空 detail 会让侧边栏悬停与
      // 设置页顶部回退成裸状态词。计数由设置页从 stats 直接读。
      const notes = [];
      if (skippedPlaces) notes.push('too many watch points · queried ' + capped.length);
      else if (skippedSamples) notes.push('sample points capped');
      if (rejectedNow) notes.push('rejected x' + rejectedNow + ' (HTTP 400)');
      if (notes.length === 0) notes.push('queried ' + places.length + ' watch points');
      reportStatus({ status: 'open', detail: notes.join(' · ') });
    } else if (okCount > 0) {
      lastSuccessAt = Date.now();
      reportStatus({ status: 'degraded', detail: failCount + '/' + capped.length + ' requests failed: ' + lastError });
    } else if (failCount > 0) {
      reportStatus({ status: 'unreachable', detail: 'all requests failed: ' + lastError });
    } else if (rejectedNow > 0) {
      // 不替上游断言原因：400 也可能是"我们的参数被拒"，文案只说被拒绝 + 多久后重试。
      reportStatus({
        status: 'open',
        detail: 'rejected x' + rejectedNow + ' (HTTP 400) · retry in ' + Math.round(uncoveredTtlMs / 60000) + 'm',
      });
    }
    stats.applied += applied;
    return {
      applied, requests: capped.length, failed: failCount,
      throttled: stats.throttledLast, rejected: rejectedNow,
    }
  }

  function pollSerial() {
    if (inFlight) return inFlight
    inFlight = pollOnce().finally(() => {
      inFlight = null;
      // 给设置页的「源状态」与诊断快照留一份快照（不触发 store 重渲，渲染侧每 5 秒自己读）。
      overseasStatsOf[id] = Object.assign({}, stats, { running, lastError });
    });
    return inFlight
  }

  function schedule(delay) {
    if (!running) return
    // 排新的定时器之前先清旧的
    if (timer) { clearTimeout(timer); timer = null; }
    timer = setTimeout(async () => {
      timer = null;
      let res = null;
      try { res = await pollSerial(); } catch (err) { onError(err); }
      // 失败后的重试间隔递增：整轮全部失败才递增，成功即回正常间隔。递增必须加在正常间隔之上——上限
      // 60 秒而真实间隔是 120 / 300 秒，取 max 会让递增恒等于正常间隔（等于死代码）。
      const allFailed = !!(res && res.requests > 0 && res.failed === res.requests);
      if (allFailed) backoffMs = backoffMs ? Math.min(backoffMs * 2, OVERSEAS_MAX_BACKOFF_MS) : OVERSEAS_MIN_BACKOFF_MS;
      else backoffMs = 0;
      schedule(intervalMs + backoffMs);
    }, delay);
  }

  return {
    id,
    label,
    start() {
      if (running) return
      stopped = false;
      running = true;
      backoffMs = 0;
      // 门槛标志也要复位：它记的是"上一轮门槛是否激活"，在门槛激活期间 stop() 之后重新开始
      // 会让"进入过几次门槛"少计一次。
      gateActive = false;
      schedule(firstDelayMs);
    },
    stop() {
      stopped = true;
      running = false;
      if (timer) { clearTimeout(timer); timer = null; }
      // 中止在途请求：插件停用后回来的响应不该再进主链（响铃 / 弹窗 / 写历史）
      if (abortCtl) { try { abortCtl.abort(); } catch (err) { /* 已结束等忽略 */ } abortCtl = null; }
      // 停用后也刷新一次快照，否则诊断里 `running` 会一直停在 true。
      overseasStatsOf[id] = Object.assign({}, stats, { running: false, lastError });
    },
    pollOnce,
    pollSerial,
    stats() {
      return Object.assign({}, stats, { running, lastError })
    },
    /** 测试与诊断用：把"上次成功"归零，模拟页面刚打开。 */
    resetGate() { lastSuccessAt = 0; gateActive = false; },
  }
}

/** 美国 NWS 的取数器（洪水 / 山洪 / 沿海洪水）。 */
function createNwsSource(opts = {}) {
  return createOverseasSource(Object.assign({
    id: 'nws_alerts',
    label: 'NWS',
    regionText: 'United States',
    intervalMs: NWS_POLL_MS,
    placesFor: (cfg) => placesInBoxes(cfg, US_BOXES),
    urlsFor: (place) => nwsSamplePoints(place).map((pt) =>
      urlOfLocal(NWS_ALERTS_BASE, { point: pt[0].toFixed(4) + ',' + pt[1].toFixed(4), event: NWS_EVENT_QUERY })),
    parseOne: (feature, place) => parseNwsAlertResult(feature, { place }),
  }, opts))
}

/** 加拿大 ECCC 的取数器（降雨 / 洪水 / 风暴潮 warning）。 */
function createEcccSource(opts = {}) {
  return createOverseasSource(Object.assign({
    id: 'eccc_alerts',
    label: 'ECCC',
    regionText: 'Canada',
    intervalMs: ECCC_POLL_MS,
    placesFor: (cfg) => placesInBoxes(cfg, [CA_BOX]),
    urlsFor: (place) => [urlOfLocal(ECCC_ALERTS_BASE, { f: 'json', limit: '200', bbox: ecccBboxOf(place) })],
    parseOne: (feature, place) => parseEcccAlertResult(feature, { place }),
  }, opts))
}

/** URL 里的值只做最小转义：保留逗号（`point=lat,lon` 与 `bbox=a,b,c,d` 都靠逗号分隔，
 *  两个源都接受裸逗号，转成 `%2C` 之后 URL 在排障日志里几乎没法读）。 */
function encodeValue(v) {
  return encodeURIComponent(v).replace(/%2C/g, ',')
}

/** 模块级 URL 拼装（两个 profile 共用）。 */
function urlOfLocal(base, params) {
  const qs = Object.keys(params).map((k) => k + '=' + encodeValue(params[k])).join('&');
  return base + '?' + qs
}

// ============================================================================
// dsh-quake-alert · client/src/16-diag.js
// 作用：**只读诊断快照**——把 Client 侧的实时状态压成一份 JSON：聚合状态、逐源状态与数据健康、
//       增量计数、大陆源的链路模式、关注点摘要、最近几条历史、投递面。
// 依赖：03-settings-bridge、05g-source-health、07-store、08-audio、09-notify、10-dedupe、
//       12b-feed-poll、12c-cn-stream、12e-overseas-poll。
// 三条纪律（对外契约）：① **只读**——不改状态、不发请求；② **永不抛错**——每个片段各自 try/catch，
//       异常进 `warnings` 一并返回；③ **只放可 JSON 化的叶子字段**——活对象必须逐字段取，不能直接 stringify。
// ============================================================================


/** 快照格式版本（与插件版本无关）。**加字段就提号**：读快照的一方据此知道"这份快照有哪些键"，
 *  缺键 = 来自更早的版本，而不是"这一项没配"。 */
const DIAG_SNAPSHOT_VERSION = 4;

const str = (v) => String(v === undefined || v === null ? '' : v);
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** 每个片段各自捕获异常，异常写进 warnings：一个会抛错的诊断工具在真出事时最没用。 */
function safe(fn, fallback, warnings, label) {
  try {
    return fn()
  } catch (err) {
    warnings.push(label + '：' + str((err && err.message) || err));
    return fallback
  }
}

/** 来源标注：让读快照的一方知道这条状态是哪条链路报的，不用去猜字段顺序。 */
function sourceRows() {
  const out = {};
  const srcs = (store && store.sources) || {};
  for (const id of Object.keys(srcs)) {
    const s = srcs[id] || {};
    out[id] = { label: str(s.label), status: str(s.status), retries: num(s.retries), detail: str(s.detail) };
  }
  return out
}

/** 增量源的计数（12b）：只留诊断用得上的字段，host 那段原样带上（它就是 Host 的健康计数）。 */
function feedRows() {
  const out = {};
  for (const id of Object.keys(feedStatsOf)) {
    const f = feedStatsOf[id] || {};
    out[id] = {
      polls: num(f.polls), received: num(f.received), applied: num(f.applied),
      errors: num(f.errors), truncated: num(f.truncated), resets: num(f.resets),
      tailSync: num(f.tailSync), morePages: num(f.morePages),
      lastAt: f.lastAt ? new Date(f.lastAt).toISOString() : null,
      cursor: num(f.cursor), running: f.running === true,
      host: f.host || null,
    };
  }
  return out
}

/** 海外源（12e）：Client 直连的 REST 轮询，字段语义与 feed / streams 两张表不同。`rejected` 是被上游
 *  HTTP 400 拒绝的请求数，**不代表"这个点不在覆盖范围"**（也可能是参数被拒）；`ageSkipped` 是被年龄门槛
 *  拦下、本来会播报的条数（只进历史不响铃）；`gated` 是进入首轮 / 休眠恢复状态的次数。 */
function overseasRows() {
  const out = {};
  for (const id of Object.keys(overseasStatsOf)) {
    const o = overseasStatsOf[id] || {};
    out[id] = {
      polls: num(o.polls), requests: num(o.requests), received: num(o.received), applied: num(o.applied),
      errors: num(o.errors),
      // 被上游用 HTTP 400 拒绝的请求数（**不代表"这个点不在覆盖范围"**，响应体前 160 字在 lastError 里）
      rejected: num(o.rejected),
      ageSkipped: num(o.ageSkipped),
      // 上游条目数超过每次请求上限、被我们截断的轮数（ECCC 的 limit=200）
      truncated: num(o.truncated),
      // 两个 throttle 计数分开：Last 是本轮、Total 是累计
      throttledLast: num(o.throttledLast), throttledTotal: num(o.throttledTotal), gated: num(o.gated),
      lastAt: o.lastAt ? new Date(o.lastAt).toISOString() : null,
      lastDataAt: o.lastDataAt ? new Date(o.lastDataAt).toISOString() : null,
      running: o.running === true,
      lastError: str(o.lastError),
    };
  }
  return out
}

/** 大陆源（12c）：**链路模式是这里最要紧的一列**——降级意味着延迟从秒级变成最长 15 秒。 */
function streamRows(warnings) {
  const out = {};
  const warn = Array.isArray(warnings) ? warnings : [];
  for (const id of Object.keys(cnStreamRegistry)) {
    const reg = cnStreamRegistry[id];
    const s = safe(() => reg.stats(), {}, warn, 'stream:' + id) || {};
    out[id] = {
      mode: safe(() => reg.mode(), 'unknown', warn, 'mode:' + id),
      connections: num(s.connections), syncs: num(s.syncs),
      received: num(s.received), applied: num(s.applied),
      errors: num(s.errors), sseErrors: num(s.sseErrors), probeTimeouts: num(s.probeTimeouts),
      fallbacks: num(s.fallbacks), truncated: num(s.truncated), resets: num(s.resets),
      lastAt: s.lastAt ? new Date(s.lastAt).toISOString() : null,
      lastEventAt: s.lastEventAt ? new Date(s.lastEventAt).toISOString() : null,
      cursor: num(s.cursor), frozen: s.frozen === true,
      // stale 由 Host 的 sync / status 帧告知（Client 自己判不出"没有数据"与"没有地震"）
      stale: s.stale === true,
      dataTime: s.dataTime ? new Date(s.dataTime).toISOString() : null,
      running: s.running === true, fallbackActive: s.fallbackActive === true,
      lastDetail: str(s.lastDetail),
    };
  }
  return out
}

/** 关注点摘要。**坐标是有意保留的**：匹配失败通常就要靠"震中距最近关注点多少公里"来判。 */
function watchSummary(cfg) {
  const w = (cfg && cfg.watch) || {};
  const places = Array.isArray(w.places) ? w.places : [];
  return {
    prefectures: Array.isArray(w.prefectures) ? w.prefectures.slice(0, 50) : [],
    citiesCount: Array.isArray(w.cities) ? w.cities.length : 0,
    cities: Array.isArray(w.cities) ? w.cities.slice(0, 30) : [],
    places: places.slice(0, 20).map((p) => ({
      name: str(p && p.name), lat: num(p && p.lat), lon: num(p && p.lon), radiusKm: num(p && p.radiusKm),
      // 来源分支（jp / cn / global）：决定"这个关注点归哪个源"；优先源判错时第一个要核的就是它。
      origin: str(p && p.origin) || 'global',
      // 大陆关注点的省 / 市：行政区层级匹配读它而不从名字反推。非大陆点不写这两个键，免得快照里多出空字段。
      ...(str(p && p.origin) === 'cn' ? { province: str(p && p.province), city: str(p && p.city) } : {}),
    })),
    placesCount: places.length,
  }
}

/** 跨源优先源：被优先源压掉的条数。被抑制的条目连历史都不进，这一段是它们的**唯一**痕迹；
 *  `bySource` 按**已播报的那个源**分组，能回答"是不是 USGS 总在抢在日本源前面"。 */
function authorityRow() {
  const a = authorityStatsOf();
  const bySource = {};
  const src = (a && a.bySource) || {};
  for (const k of Object.keys(src)) bySource[k] = num(src[k]);
  return {
    suppressed: num(a && a.suppressed),
    bySource,
    lastAt: (a && a.lastAt) ? new Date(a.lastAt).toISOString() : null,
    lastDetail: str(a && a.lastDetail),
  }
}

/** 最近几条历史：只留判定"到底播报没播报、为什么没播报"所需的字段。 */
function historySummary() {
  const evs = (store && Array.isArray(store.events)) ? store.events : [];
  return {
    count: evs.length,
    recent: evs.slice(0, 5).map((e) => ({
      kind: str(e && e.kind), label: str(e && e.label), severity: str(e && e.severity),
      issued: str(e && e.issued), hit: e && e.hit === true,
      suppressed: e && e.suppressed === true, suppressedReason: str(e && e.suppressedReason),
      headline: str(e && e.headline).slice(0, 120),
    })),
  }
}

/** 页面环境：有些故障只在后台标签页或离线时出现。 */
function pageEnv() {
  const out = { visibility: 'unknown', online: null, hasEventSource: false, hasBroadcastChannel: false };
  try {
    if (typeof document !== 'undefined' && document && typeof document.visibilityState === 'string') {
      out.visibility = document.visibilityState;
    }
  } catch (err) { /* 忽略 */ }
  try {
    if (typeof navigator !== 'undefined' && navigator && typeof navigator.onLine === 'boolean') out.online = navigator.onLine;
  } catch (err) { /* 忽略 */ }
  try {
    out.hasEventSource = typeof window !== 'undefined' && typeof window.EventSource === 'function';
    out.hasBroadcastChannel = typeof window !== 'undefined' && typeof window.BroadcastChannel === 'function';
  } catch (err) { /* 忽略 */ }
  return out
}

/** 生成诊断快照。@param {number} [now] 注入点（测试用）
 *  @returns {object} 可直接 JSON.stringify 的纯数据对象；被捕获的异常在 `warnings` 里 */
function buildDiagSnapshot(now) {
  const warnings = [];
  const cfg = safe(() => currentCfg() || {}, {}, warnings, 'cfg') || {};
  const t = (typeof now === 'number' && Number.isFinite(now)) ? now : Date.now();
  const cfgThresholds = (cfg && cfg.thresholds) || {};
  const cfgDisasters = (cfg && cfg.disasters) || {};
  const cfgNotify = (cfg && cfg.notify) || {};
  const cfgDedupe = (cfg && cfg.dedupe) || {};
  const cfgQuiet = (cfg && cfg.quietHours) || {};
  const thresholds = {};
  for (const k of Object.keys(cfgThresholds)) thresholds[k] = cfgThresholds[k];
  const disasters = {};
  for (const k of Object.keys(cfgDisasters)) disasters[k] = cfgDisasters[k];
  return {
    snapshot: DIAG_SNAPSHOT_VERSION,
    at: new Date(t).toISOString(),
    page: safe(pageEnv, {}, warnings, 'page'),
    aggregate: safe(() => ({
      status: str(store.status), retries: num(store.retries), detail: str(store.detail),
      received: num(store.received),
      weatherHint: store.weatherHint
        ? { level: num(store.weatherHint.level), label: str(store.weatherHint.label), at: num(store.weatherHint.at) }
        : null,
    }), {}, warnings, 'aggregate'),
    config: safe(() => ({
      settingsStorage: str(settingsSync), // host（settings.yaml）| local | memory
      source: str(cfg.source),
      disasters,
      thresholds,
      notify: { sound: cfgNotify.sound !== false, system: cfgNotify.system !== false, volume: num(cfgNotify.volume) },
      dedupe: { windowMinutes: num(cfgDedupe.windowMinutes) },
      quietHours: {
        enabled: cfgQuiet.enabled === true, start: str(cfgQuiet.start), end: str(cfgQuiet.end),
        breakForSevere: cfgQuiet.breakForSevere !== false,
      },
      cnTransport: str(cfg.cnTransport) || 'auto', // 'auto'（默认，SSE 可自动降级）| 'poll'（用户强制轮询）
      // 界面语言：**规整后的生效值，不是持久层原值**（cfg 来自 currentCfg()，一定过 normalizeCfg），
      // 所以它只能回答"界面现在按哪个语言渲染"。
      language: str(cfg.language),
      watch: safe(() => watchSummary(cfg), {}, warnings, 'watch'),
    }), {}, warnings, 'config'),
    sources: safe(sourceRows, {}, warnings, 'sources'),
    // 数据健康：schema-error 的**原因**在这里（蓝点的解释）
    dataHealth: safe(() => sourceHealthOf() || {}, {}, warnings, 'health'),
    feed: safe(feedRows, {}, warnings, 'feed'),
    streams: safe(() => streamRows(warnings), {}, warnings, 'streams'),
    // 海外源：Client 直连的 REST 轮询，与 feed / streams 并列（字段语义不同，见 overseasRows）。
    overseas: safe(overseasRows, {}, warnings, 'overseas'),
    // 跨源优先源：被压掉的跨源副本条数——那些条目不进历史，这里是它们唯一的痕迹。
    authority: safe(authorityRow, {}, warnings, 'authority'),
    history: safe(historySummary, {}, warnings, 'history'),
    // 投递面：音频未解锁（用户从未点过页面）与系统通知权限被拒都**无法从 config 推导**——
    // config.notify.system 是"用户想不想要"，这里是"浏览器允不允许 / 解锁没解锁"。
    delivery: safe(() => ({
      audio: str(audioState()),
      notificationPermission: str(notificationPermission()),
    }), {}, warnings, 'delivery'),
    // 生成过程中被捕获的异常：诊断工具自身的失败也要可见，不能假装一切正常
    warnings,
  }
}

/** 复制诊断快照到剪贴板。剪贴板不可用（沙箱 iframe / 权限被拒）时**不抛错**，而是把文本交回调用方去显示成可手动复制的文本框。
 *  @returns {Promise<{ ok: boolean, text: string, warning?: string, error?: string }>} */
async function copyDiagSnapshot(now) {
  const warnings = [];
  const text = safe(() => JSON.stringify(buildDiagSnapshot(now), null, 2), '{}', warnings, 'stringify');
  try {
    if (typeof navigator !== 'undefined' && navigator && navigator.clipboard &&
        typeof navigator.clipboard.writeText === 'function') {
      await navigator.clipboard.writeText(text);
      // 快照生成时被捕获的异常要**跟着结果回给界面**：复制确实成功了，所以不能报 ok:false；
      // 但也绝不能只说"已复制"——用户以为手里是一份完整诊断，而里面其实少了几个片段。
      return warnings.length
        ? { ok: true, text, warning: warnings.join('；') }
        : { ok: true, text }
    }
  } catch (err) {
    return { ok: false, text, error: str((err && err.message) || err) }
  }
  return { ok: false, text }
}

// ============================================================================
// dsh-quake-alert · client/src/17-config-io.js
// 作用：配置的导出 / 导入 / 撤销。
// 内容：导出文件格式与版本、导入校验、导入前自动备份、撤销上次导入、文件下载与读取。
// 依赖：01-constants、02-storage（规整与存取）、03-settings-bridge（读写配置的唯一入口）。
// 语义（对外契约）：
//   · 只导出配置本身（关注点、阈值、语言、数据源、静默时段……）；历史与源健康记录**不进文件**。
//   · **导入是整体替换**，不是合并，所以导入前**自动把当前配置备份一份**，并给出「撤销上次导入」出口。
//   · **格式版本是唯一的契约**：文件里不写插件版本；`formatVersion` 高于本版能读的就**拒绝**。
//   · 校验失败一律返回**错误码**（不是拼好的中文句子）：文案由 UI 层按当前界面语言翻。
// ============================================================================


/** 文件标识：导入时用它区分"这是本插件的配置文件"与"随手拖进来的其它 JSON"。 */
const CONFIG_FORMAT = 'dsh-quake-alert/config';
/** 格式版本。结构变化时 +1；导入端对更高的版本直接拒绝（见文件头）。 */
const CONFIG_FORMAT_VERSION = 1;
/** 导入前自动备份的存放位置（与配置本身同一个 localStorage，便于一键撤销）。 */
const CONFIG_BACKUP_KEY = 'dsh.quakeAlert.backup';

/** 导出文件名：带日期，便于用户区分多次导出。 */
function configFileName(now) {
  const d = now instanceof Date ? now : new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return 'quake-alert-config-' + d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate()) + '.json'
}

/** 生成导出文件内容（缩进过的 JSON）。cfg 省略时取当前生效的配置；now 用于测试注入时间。 */
function buildConfigExport(cfg, now) {
  const at = now instanceof Date ? now : new Date();
  return JSON.stringify({
    format: CONFIG_FORMAT,
    formatVersion: CONFIG_FORMAT_VERSION,
    exportedAt: at.toISOString(),
    config: normalizeCfg(cfg || currentCfg()),
  }, null, 2)
}

/** 解析并校验一份导入文本。**不做任何写入**（纯函数）。
 *  @returns {{ok:true,cfg:object,formatVersion:number,warnings:object}|{ok:false,error:string,detail?:string}}
 *  error 取值：`json`（不是 JSON）/ `shape`（结构不符）/ `format`（其它应用）/ `version`（非法）/ `newer`（版本更高） */
function parseConfigImport(text) {
  // 去掉 BOM：记事本、PowerShell 的 `Out-File -Encoding utf8` 都会加上，而 JSON.parse 会因此在首字符上抛。
  const raw = String(text === undefined || text === null ? '' : text).replace(/^\uFEFF/, '');
  if (!raw.trim()) return { ok: false, error: 'shape' }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return { ok: false, error: 'json', detail: String((err && err.message) || err) }
  }
  if (!isPlainObject(parsed)) return { ok: false, error: 'shape' }
  if (parsed.format !== CONFIG_FORMAT) return { ok: false, error: 'format', detail: String(parsed.format === undefined ? '' : parsed.format) }
  const v = parsed.formatVersion;
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 1) return { ok: false, error: 'version' }
  if (v > CONFIG_FORMAT_VERSION) return { ok: false, error: 'newer', detail: String(v) }
  if (!isPlainObject(parsed.config)) return { ok: false, error: 'shape' }
  // 规整出错也返回错误码：畸形配置（字段是转不成字符串的对象）会在规整里抛，抛出去 UI 那条 .then 链上没人接得住。
  let cfg;
  // 关注点检查清单：规整流程会**静默**丢弃坐标非法的关注点，这里把清单交出去，由界面如实说明少了什么。
  const audit = { total: 0, dropped: 0, radiusFixed: 0 };
  try {
    cfg = normalizeCfg(parsed.config, audit);
  } catch (err) {
    return { ok: false, error: 'shape', detail: String((err && err.message) || err) }
  }
  return { ok: true, cfg, formatVersion: v, warnings: audit }
}

/** 把当前配置备份到 localStorage（覆盖上一次备份）。**返回备份时间；写不进去时返回空字符串**——
 *  saveJSON 是静默失败的，而这份备份是"导入还能回滚"的**全部依据**，所以写后**回读校验**、确认真的写进了本地存储。 */
function backupCurrentConfig(now) {
  const at = now instanceof Date ? now : new Date();
  const payload = { at: at.toISOString(), config: normalizeCfg(currentCfg()) };
  saveJSON(CONFIG_BACKUP_KEY, payload);
  const back = loadConfigBackup();
  return back && back.at === payload.at ? payload.at : ''
}

/** 读回备份。没有备份、或备份结构不可用时返回 null（不抛错：界面只需知道"能不能撤销"）。 */
function loadConfigBackup() {
  const b = loadJSON(CONFIG_BACKUP_KEY, null);
  if (!isPlainObject(b) || !isPlainObject(b.config)) return null
  let cfg;
  try {
    cfg = normalizeCfg(b.config);
  } catch (err) {
    // 备份同样是外部输入（用户能在 localStorage 里改），规整时可能抛；调用方在渲染期，按"没有可撤销的备份"处理。
    try { console.warn('[dsh-quake-alert] 备份配置归一化失败，视为无备份：' + String((err && err.message) || err)); } catch (e) { /* 忽略 */ }
    return null
  }
  return { at: String(b.at || ''), cfg }
}

function clearConfigBackup() {
  try {
    if (typeof window !== 'undefined' && window.localStorage) window.localStorage.removeItem(CONFIG_BACKUP_KEY);
  } catch (err) { /* 存储不可用时忽略：清不掉备份不影响正确性 */ }
}

/** 导入：**先备份当前配置，再整体替换**；校验失败时**什么都不写**（连备份都不做）。
 *  @returns {{ok:true,cfg:object,backupAt:string}|{ok:false,error:string,detail?:string}} */
function importConfig(text, now) {
  const parsed = parseConfigImport(text);
  if (!parsed.ok) return parsed
  const backupAt = backupCurrentConfig(now);
  // 备份不成功就**不导入**：没有退路时"整体替换成另一份配置"是不可逆的破坏性操作。
  if (!backupAt) return { ok: false, error: 'backup-failed' }
  const next = applyCfg(parsed.cfg);
  return { ok: true, cfg: next, backupAt, warnings: parsed.warnings }
}

/** 撤销上次导入：把备份写回去，**然后清掉备份**——一次性撤销，撤销成功即清掉快照、按钮随之消失。 */
function undoConfigImport() {
  const b = loadConfigBackup();
  if (!b) return { ok: false, error: 'no-backup' }
  applyCfg(b.cfg);
  clearConfigBackup();
  return { ok: true, at: b.at }
}

/** 触发浏览器下载。**返回是否成功**——沙箱 iframe 里 `URL.createObjectURL` 可能不可用，
 *  那种情况下 UI 要退回"把文本显示出来让用户自己复制"（同诊断快照的处理）。 */
function downloadConfigFile(text, filename) {
  try {
    if (typeof document === 'undefined' || typeof URL === 'undefined' || typeof URL.createObjectURL !== 'function') return false
    const blob = new Blob([String(text)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = String(filename || configFileName());
    if (document.body && typeof document.body.appendChild === 'function') {
      document.body.appendChild(a);
      a.click();
      if (typeof a.remove === 'function') a.remove();
      else if (typeof document.body.removeChild === 'function') document.body.removeChild(a);
    } else {
      a.click();
    }
    setTimeout(() => { try { URL.revokeObjectURL(url); } catch (err) { /* 忽略 */ } }, 1000);
    return true
  } catch (err) { return false }
}

/** 读文件为文本。优先用 `File.text()`（现代浏览器），否则退回 FileReader。 */
function readConfigFile(file) {
  if (!file) return Promise.resolve({ ok: false, error: 'no-file' })
  if (typeof file.text === 'function') {
    return file.text().then((s) => ({ ok: true, text: String(s) }), (err) => ({ ok: false, error: 'read', detail: String((err && err.message) || err) }))
  }
  return new Promise((resolve) => {
    try {
      const fr = new FileReader();
      fr.onload = () => resolve({ ok: true, text: String(fr.result === undefined || fr.result === null ? '' : fr.result) });
      fr.onerror = () => resolve({ ok: false, error: 'read' });
      fr.readAsText(file);
    } catch (err) {
      resolve({ ok: false, error: 'read', detail: String((err && err.message) || err) });
    }
  })
}

// ============================================================================
// dsh-quake-alert · client/src/13-ui-settings.js — 设置页面板（设置 → 灾害预警）的全部 UI：连接状态与
// 数据源、关注地区、阈值、通知与声音、静默时段、免责、最近预警记录。所有写入都经 applyCfg（保证内存 /
// 镜像 / Host 三处一致）；本文件生成的文本一律走 t('settings.*')，源侧文本一律原样透传。
// 依赖：00-i18n、01-constants、02-storage、03-settings-bridge、04-city-table、07-store、08-audio、
// 09-notify、05b/05c（测试电文）、11-pipeline、12-websocket、12b/12c/12e（计数）、16-diag、17-config-io。
// ============================================================================


// ---------- 设置页 UI（含侧边栏共用的状态映射） ----------
function statusMetaOf(status, retries) {
  return {
    idle: { color: '#7c8494', text: t('settings.status.idle') },
    connecting: { color: '#d9a406', text: t('settings.status.connecting') },
    open: { color: '#4ade80', text: t('settings.status.open') },
    reconnecting: { color: '#d9a406', text: t('settings.status.reconnecting', { n: retries }) },
    closed: { color: '#e8565b', text: t('settings.status.closed') },
    // 轮询源与"消息处理失败"也有自己的状态：否则上游被墙 / 路由 500 / 主链抛错在界面上与"没有新闻"完全不可区分。
    unreachable: { color: '#e8565b', text: t('settings.status.unreachable') },
    degraded: { color: '#d9a406', text: t('settings.status.degraded') },
    stale: { color: '#8b8f98', text: t('settings.status.stale') },
    'schema-error': { color: '#3b82f6', text: t('settings.status.schemaError') },
    disabled: { color: '#7c8494', text: t('settings.status.disabled') },
    // 认不出的状态码原样回显：显示空白比显示一个生面孔的状态码更难排查。
  }[status] || { color: '#7c8494', text: t('settings.status.raw', { status: String(status) }) }
}
// 配置存储位置的人话说明（settings.yaml / 进程内 / localStorage）
function settingsSyncLabel() {
  return {
    host: t('settings.storage.host'),
    memory: t('settings.storage.memory'),
    local: t('settings.storage.local'),
  }[settingsSync] || String(settingsSync)
}
// 历史条目「类型」行显示的 P2PQuake code；气象电文不在此表里。索引一律经 own()，避免外部数据的键命中原型链。
const P2P_KIND_CODE = { quake: 551, eew: 556, tsunami: 552 };
/**
 * alert.code → 来源标注的**文案 key**（全球源、JMA 电文与大陆源没有 P2PQuake 的 code）。值是 key，
 * 取词在 `p2pCodeTextOf` 里做——这些字符串进履历条目的「类型」行，写死中文会在英 / 日界面下露出来。
 * 机构品牌名（EMSC / USGS / NOAA CAP / NWS / ECCC）与 `code N` 这种规范标识不翻。
 */
const SOURCE_CODE_TEXT = {
  emsc: 'EMSC', usgs: 'USGS', noaa: 'NOAA CAP', jma: 'sourceCode.jma',
  cenc_eew: 'sourceCode.cencEew', cenc_eqlist: 'sourceCode.cencEqlist',
  // 大陆气象预警的发布主体是各级气象台、由中央气象台汇总；标成「JMA 电文」会让一条云南暴雨预警指向日本气象厅。
  nmc_alarm: 'sourceCode.nmc',
  // 海外气象源同理，机构名不能省——ECCC 的许可（End-use Licence v2.1.1）本身就要求署名。
  nws_alerts: 'NWS', eccc_alerts: 'ECCC',
};
/** 表里的值可能是 key（要取词），也可能已经是品牌名（原样返回）。 */
const sourceCodeLabelOf = (value) => {
  const s = String(value === undefined || value === null ? '' : value);
  const got = t(s);
  return got === s ? s : got
};
/**
 * 历史条目「类型」行的来源标注：优先用 alert.code（全球地震的 kind 也是 'quake'）；旧历史没有 code
 * 字段，用 id 前缀（emsc: / usgs: / noaa: / cenc: / nmc: / nws: / eccc:）认出来源。
 */
function p2pCodeTextOf(kind, code, id) {
  const codeStr = String(code === undefined || code === null ? '' : code);
  const byCode = own(SOURCE_CODE_TEXT, codeStr);
  if (byCode) return sourceCodeLabelOf(byCode)
  if (/^\d{3}$/.test(codeStr)) return 'code ' + codeStr
  const idStr = String(id === undefined || id === null ? '' : id);
  if (idStr.indexOf('emsc:') === 0) return 'EMSC'
  if (idStr.indexOf('usgs:') === 0) return 'USGS'
  if (idStr.indexOf('noaa:') === 0) return 'NOAA CAP'
  if (idStr.indexOf('cenc:') === 0) return t('sourceCode.cencMainland')
  if (idStr.indexOf('nmc:') === 0) return t('sourceCode.nmc')
  if (idStr.indexOf('nws:') === 0) return 'NWS'
  if (idStr.indexOf('eccc:') === 0) return 'ECCC'
  const c = own(P2P_KIND_CODE, kind);
  if (c) return 'code ' + c
  // 兜底：气象（kind='weather'）在出现大陆气象源之前只有日本这一个来源，故这里必须注明是日方的。
  return kind === 'weather' ? t('sourceCode.jma') : '—'
}
const KIND_COLORS = { eew: '#e8565b', quake: '#3b82f6', tsunami: '#f76b15', weather: '#a78bfa' };
const kindColorOf = (kind) => own(KIND_COLORS, kind) || '#7c8494';
/** 下拉框的自绘箭头（data URI）：原生箭头的水平位置由浏览器决定，选项文字短于 `min-width: 180px` 时
 *  它会落在框中段而不是贴着右边缘；自绘的位置由 `background-position` 固定，多宽都贴右 8px。 */
const SELECT_ARROW = "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='6'%3E%3Cpath d='M1 1l4 4 4-4' fill='none' stroke='%236b7280' stroke-width='1.6' stroke-linecap='round'/%3E%3C/svg%3E\")";
const s = {
  section: (title, ...children) => h('div', { style: { padding: '14px 16px', borderBottom: '1px solid rgba(148,163,184,0.14)' } },
    h('div', { style: { fontWeight: 700, fontSize: 13, marginBottom: 10, color: '#dfe3e8' } }, title), ...children),
  label: (text) => h('div', { style: { color: '#9aa0a6', fontSize: 12, marginBottom: 4 } }, text),
  row: (...children) => h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', margin: '4px 0' } }, ...children),
  checkbox: (checked, onChange, text) => h('label', { style: { display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, cursor: 'pointer', color: '#dfe3e8' } },
    h('input', { type: 'checkbox', checked, onChange: (e) => onChange(e.target.checked) }), text),
  // `label`（第 5 参）渲染成 `aria-label`：此前下拉的文字与控件在 DOM 里没有关联，读屏只能念"组合框"。
  // `extra`（第 6 参）是调用方追加的样式；自绘箭头的三项写在 `extra` 之后——`background` 是简写，带上它会清掉 `backgroundImage`。
  select: (value, options, onChange, textOf, label, extra) => h('select', {
    value, onChange: (e) => onChange(e.target.value),
    'aria-label': label || undefined,
    style: Object.assign({
      // 用 `backgroundColor` 而不是 `background`：后者是简写，会把下面的 backgroundImage 一起清掉
      backgroundColor: '#ffffff', color: '#1a1a1a', border: '1px solid #6b7280', borderRadius: 6,
      // 右侧留 26px 给箭头（自绘的，位置由 backgroundPosition 定）
      padding: '4px 26px 4px 8px', fontSize: 12, minWidth: 180,
      appearance: 'none', WebkitAppearance: 'none', MozAppearance: 'none',
    }, extra || {}, {
      backgroundImage: SELECT_ARROW, backgroundRepeat: 'no-repeat',
      backgroundPosition: 'right 8px center', backgroundSize: '10px 6px',
    }),
  }, options.map((o) => h('option', {
    key: String(o.v !== undefined ? o.v : o.g), value: String(o.v !== undefined ? o.v : o.g),
    style: { background: '#ffffff', color: '#1a1a1a' },
  }, textOf(o)))),
  btn: (text, onClick, extra) => h('button', {
    onClick,
    style: Object.assign({ background: 'rgba(148,163,184,0.12)', color: 'inherit', border: '1px solid rgba(148,163,184,0.35)', borderRadius: 6, padding: '5px 12px', cursor: 'pointer', fontSize: 12 }, extra || {}),
  }, text),
};

/**
 * 折叠的次要说明（原生 `<details>`）：设置页只把一句判据留在主视野，解释、边界与许可署名收进这里。
 * 内容始终在 DOM 里（可搜索、可读屏、可复制），用原生元素即自带键盘可达与展开语义。
 */
const fold = (summary, ...children) => h('details', { style: { marginTop: 6 } },
  h('summary', { style: { fontSize: 11, color: '#8b93a1', cursor: 'pointer', width: 'fit-content' } }, summary),
  h('div', {
    style: {
      fontSize: 11, color: '#9aa0a6', lineHeight: 1.7, marginTop: 5, paddingLeft: 10,
      borderLeft: '2px solid rgba(148,163,184,0.2)',
    },
  }, ...children));

/**
 * 源的展示名（源 id → 文案 key）与取词都在 `00f-source-labels.js` 的 `sourceLabelOf`：单一来源是重点，
 * 侧边栏的悬停提示（07-store）与这里必须给同一个答案。取词在调用时求值，所以切语言后立刻跟着变。
 * 下面几组顺序表同理，**一处维护**：加一个源只改这里，漏掉就变成"某个源坏了但界面上看不见"。
 */
const SOURCE_ORDER = ['p2pquake', 'emsc', 'cenc_eew', 'cenc_eqlist', 'jma', 'usgs', 'noaa', 'nmc_alarm', 'nws_alerts', 'eccc_alerts'];
/** 走 `/feed` 增量计数的源（feedStatsOf 有快照）。大陆地震源走 SSE，另有自己的计数与链路模式。 */
const FEED_STAT_ORDER = ['jma', 'usgs', 'noaa', 'nmc_alarm'];
/** 走 SSE 的源：状态从 cnStreamRegistry 实时读。 */
const STREAM_ORDER = ['cenc_eew', 'cenc_eqlist'];
/** 海外源：Client 直连的 REST 轮询，计数从 `overseasStatsOf` 实时读。字段语义（轮次 / 请求 / 未覆盖）
 *  与 FEED_STAT_ORDER 不同，故单独一张表。 */
const OVERSEAS_STAT_ORDER = ['nws_alerts', 'eccc_alerts'];
/**
 * 源状态区块。拆成独立组件是因为它显示"最近拉取 N 秒前"、需要自己走时钟；挂在设置页主组件里会让 5 秒
 * 一次的 setState 重建整个设置页（关注县较多时那意味着几千个市町村按钮一起重建）。内容含 Host 侧的失败
 * 与放弃数（来自 /feed?stats=1）：只显示本地计数的话，「上游被墙」与「上游没有新闻」仍然不可区分。
 */
function SourceStatusBlock() {
  const [, setTick] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => setTick((x) => x + 1), 5000);
    return () => clearInterval(timer)
  }, []);
  // 订阅 store：源的连接 / 数据状态变化要立刻反映（不必等那 5 秒的时钟）
  useEffect(() => store.subscribe(() => setTick((x) => x + 1)), []);
  const rows = [];
  const sources = store.sources || {};
  for (const id of SOURCE_ORDER) {
    const st = sources[id];
    if (!st) continue
    const meta = statusMetaOf(st.status, st.retries);
    rows.push(t('settings.source.keyValue', {
      k: sourceLabelOf(id),
      v: meta.text + (st.detail ? ' · ' + st.detail : ''),
    }));
  }
  for (const id of FEED_STAT_ORDER) {
    const f = feedStatsOf[id];
    const st = sources[id];
    if (!f) {
      if (!st) rows.push(t('settings.source.keyValue', { k: sourceLabelOf(id), v: t('settings.source.notFetched') }));
      continue
    }
    const host = f.host || {};
    const ago = f.lastAt ? t('settings.source.secondsAgo', { n: Math.max(0, Math.round((Date.now() - f.lastAt) / 1000)) }) : t('settings.source.dash');
    rows.push(t('settings.source.keyValue', {
      k: sourceLabelOf(id),
      v: t('settings.source.receivedIncrements', { n: f.received }) +
        (f.errors ? t('settings.source.localErrors', { n: f.errors }) : '') +
        (f.truncated ? t('settings.source.truncated', { n: f.truncated }) : '') +
        (f.resets ? t('settings.source.resets', { n: f.resets }) : '') +
        (Number(host.errors) ? t('settings.source.hostErrors', { n: host.errors }) : '') +
        (Number(host.detailDropped) ? t('settings.source.hostDetailDropped', { n: host.detailDropped }) : '') +
        t('settings.source.lastFetch', { ago }),
    }));
  }
  // 海外源：只有这个形态才有的计数——年龄门槛（过老只记历史）、被上游拒绝（HTTP 400）、被分页上限截断。
  for (const id of OVERSEAS_STAT_ORDER) {
    const o = overseasStatsOf[id];
    const st = sources[id];
    if (!o) {
      if (!st) rows.push(t('settings.source.keyValue', { k: sourceLabelOf(id), v: t('settings.source.notQueried') }));
      continue
    }
    const ago = o.lastAt ? t('settings.source.secondsAgo', { n: Math.max(0, Math.round((Date.now() - o.lastAt) / 1000)) }) : t('settings.source.dash');
    // 「响应条目」而不是「收到 N 条」：NWS 按点的 5 个采样点各查一次，同一批预警会被重复计入。
    rows.push(t('settings.source.keyValue', {
      k: sourceLabelOf(id),
      v: t('settings.source.polls', { n: o.polls || 0 }) +
        t('settings.source.requests', { n: o.requests || 0 }) +
        t('settings.source.respondedItems', { n: o.received || 0 }) +
        (o.applied ? t('settings.source.applied', { n: o.applied }) : '') +
        (o.ageSkipped ? t('settings.source.ageSkipped', { n: o.ageSkipped }) : '') +
        (o.rejected ? t('settings.source.rejected', { n: o.rejected }) : '') +
        (o.truncated ? t('settings.source.overseasTruncated', { n: o.truncated }) : '') +
        (o.throttledLast ? t('settings.source.throttled', { n: o.throttledLast }) : '') +
        (o.errors ? t('settings.source.errors', { n: o.errors }) : '') +
        t('settings.source.lastQuery', { ago }),
    }));
  }
  // 大陆源走 SSE，状态从注册表实时读。链路模式必须显示出来——降级到轮询意味着延迟从秒级变成最长 15 秒。
  for (const id of STREAM_ORDER) {
    const reg = cnStreamRegistry[id];
    const st = sources[id];
    if (!reg) {
      if (!st) rows.push(t('settings.source.keyValue', { k: sourceLabelOf(id), v: t('settings.source.notStarted') }));
      continue
    }
    const c = reg.stats();
    const modeText = c.mode === 'sse' ? t('settings.source.modeSse')
      : (c.mode === 'poll' ? t('settings.source.modePoll')
        : (c.mode === 'disabled' ? t('settings.source.modeDisabled') : t('settings.source.modeIdle')));
    const ago = c.lastAt ? t('settings.source.secondsAgo', { n: Math.max(0, Math.round((Date.now() - c.lastAt) / 1000)) }) : t('settings.source.dash');
    rows.push(t('settings.source.keyValue', {
      k: sourceLabelOf(id),
      v: modeText +
        t('settings.source.received', { n: c.received }) +
        (c.applied ? t('settings.source.broadcast', { n: c.applied }) : '') +
        (c.errors ? t('settings.source.errors', { n: c.errors }) : '') +
        (c.fallbacks ? t('settings.source.fallbacks', { n: c.fallbacks }) : '') +
        (c.probeTimeouts ? t('settings.source.probeTimeouts', { n: c.probeTimeouts }) : '') +
        (c.truncated ? t('settings.source.truncated', { n: c.truncated }) : '') +
        (c.resets ? t('settings.source.resets', { n: c.resets }) : '') +
        t('settings.source.lastData', { ago }),
    }));
  }
  if (rows.length === 0) return null
  // schema-error 提供手动重试：源改版后字段可能又回来了，用户不该为了清掉一个蓝点去重装插件。
  const retryRows = SOURCE_ORDER
    .filter((id) => sources[id] && sources[id].status === 'schema-error')
    .map((id) => h('div', { key: 'retry-' + id, style: { marginTop: 4 } },
      s.btn(t('settings.source.retry', { name: sourceLabelOf(id) }), () => retrySource(id))));
  return h('div', { style: { marginTop: 10, fontSize: 11, color: '#9aa0a6', lineHeight: 1.7 } },
    h('div', { style: { marginBottom: 2 } }, t('settings.source.title')),
    rows.map((t2, i) => h('div', { key: 'feedstat-' + i }, t2)),
    retryRows)
}

/** 设置页默认落在哪个「国家 / 地区」分支：由现有配置推断，而不是固定日本——否则已配了中国或海外关注点的
 *  用户打开设置页会先看到"日本：未选择"，以为配置丢了。三边都空时落在日本（默认链路）。 */
function inferRegionTab(cfg) {
  const w = (cfg && cfg.watch) || {};
  const places = Array.isArray(w.places) ? w.places : [];
  if (Array.isArray(w.prefectures) && w.prefectures.length > 0) return 'jp'
  if (places.some((p) => p && p.origin === 'cn')) return 'cn'
  if (places.length > 0) return 'global'
  return 'jp'
}
/** 一级「国家 / 地区」的三个分支。**label 存 key、渲染时取词**：模块级对象里的 `t()` 会在模块加载那一刻
 *  求值，那时语言还是默认值，用户切语言后标签不会跟着变。 */
const REGION_TABS = [
  { v: 'jp', labelKey: 'settings.region.jp', icon: '🇯🇵' },
  { v: 'cn', labelKey: 'settings.region.cn', icon: '🇨🇳' },
  { v: 'global', labelKey: 'settings.region.global', icon: '🌐' },
];
/**
 * 设置页的选项卡：分页依据是用户要做什么——地区（我在乎哪里）/ 灾害（哪些灾种、多强）/ 通知（怎么提醒）/
 * 履历（刚发生了什么）/ 其他（链路、诊断、免责）。每页只渲染自己的区块，未选中的页连 DOM 都不产生；
 * `labelKey` 而不是 `label` 的理由同 REGION_TABS。
 */
const SETTINGS_TABS = [
  { v: 'region', labelKey: 'settings.tab.region' },
  { v: 'disaster', labelKey: 'settings.tab.disaster' },
  { v: 'notify', labelKey: 'settings.tab.notify' },
  { v: 'history', labelKey: 'settings.tab.history' },
  { v: 'misc', labelKey: 'settings.tab.misc' },
];

function SettingsPanel(props) {
  const [cfg, setCfgState] = useState(() => currentCfg());
  const [, setTick] = useState(0);
  const [perm, setPerm] = useState(() => notificationPermission());
  const [testMsg, setTestMsg] = useState('');
  const [expanded, setExpanded] = useState(null);
  const [cityQuery, setCityQuery] = useState({}); // 每个县的市町村搜索词
  const [cityMsg, setCityMsg] = useState(''); // 市町村上限的反馈：超限时说明原因，不静默丢弃
  const [weatherTestMsg, setWeatherTestMsg] = useState(''); // 「发送测试气象警报」的结果提示
  const [weatherTestSeq, setWeatherTestSeq] = useState(0); // 测试场景轮换序号
  // 全球关注点的输入草稿与反馈：校验失败必须给出文字原因，不能静默吞掉用户输入。默认半径只影响新建的关注点。
  const [placeDraft, setPlaceDraft] = useState({ name: '', lat: '', lon: '', radiusKm: String(DEFAULT_PLACE_RADIUS_KM) });
  const [placeMsg, setPlaceMsg] = useState('');
  // 中国大陆的三级级联：省 → 地级市 → 半径。选完给出表里的坐标，用户不需要知道经纬度。
  const [cnPick, setCnPick] = useState({ province: '', city: '', radiusKm: DEFAULT_PLACE_RADIUS_KM });
  const [cnMsg, setCnMsg] = useState('');
  // 全球链路的测试：场景轮换序号与结果提示
  const [geTestSeq, setGeTestSeq] = useState(0);
  const [geTestMsg, setGeTestMsg] = useState('');
  // 诊断快照：{ text, msg } | null
  const [diag, setDiag] = useState(null);
  // 配置导出导入：结果提示、下载不可用时的回退文本、以及"能不能撤销"的备份时间。
  const [cfgIoMsg, setCfgIoMsg] = useState('');
  const [cfgIoText, setCfgIoText] = useState('');
  const [cfgIoBackupAt, setCfgIoBackupAt] = useState(() => {
    const b = loadConfigBackup();
    return b ? b.at : ''
  });
  const cfgIoFileRef = useRef(null);
  // 「源状态」区块的相对时间要自己走 —— 见 SourceStatusBlock（避免每 5 秒重渲整个设置页）
  // 音量滑块：拖动期间只改本地草稿，停手 300ms 后才写入本地存储
  const [volDraft, setVolDraft] = useState(null);
  // 选项卡。默认「地区」——首次配置的起点。`props.initialTab` 只给回归测试用。
  const [tab, setTab] = useState(() => {
    const want = props && props.initialTab;
    return SETTINGS_TABS.some((tab) => tab.v === want) ? want : 'region'
  });
  // 关注地区的当前分支：地址是"用户视角的一条路径"，不是三块并列。
  const [regionTab, setRegionTab] = useState(() => inferRegionTab(currentCfg()));
  // 「其他国家 / 地区」分支：所选国家与城市搜索词（城市表按国家分包，见 04-city-table）
  const [country, setCountry] = useState('');
  const [worldCityQuery, setWorldCityQuery] = useState('');
  const volTimer = useRef(null);
  const volPending = useRef(null); // 尚未写入本地存储的草稿值：卸载时补写，拖完立刻关设置页也不丢改动
  const restartTimer = useRef(null); // 切换数据源后的重启延时（见下方）
  // store 变化（新预警、Host 配置同步）都要重新读一次当前配置
  useEffect(() => store.subscribe(() => { setTick((n) => n + 1); setCfgState(currentCfg()); }), []);
  useEffect(() => () => {
    if (volTimer.current) { clearTimeout(volTimer.current); volTimer.current = null; }
    // 挂起的"切换数据源后重启"要**执行**而不是丢弃：切完数据源 80ms 内关掉设置页，那次 restart() 就永远
    // 不会发生，连接要等下一次强制断线才切到新地址。清定时器仍然必要（不能让已无 fiber 归属的回调复活 socket）。
    if (restartTimer.current) {
      clearTimeout(restartTimer.current);
      restartTimer.current = null;
      const c = activeClient; // 模块级 live binding：插件停用时已被置为 null
      if (c) { try { c.restart(); } catch (err) { /* 与延时路径同一处置 */ } }
    }
    const v = volPending.current;
    if (v !== null) {
      volPending.current = null;
      // 卸载中不能 setState，只补写本地存储。必须经 applyCfg 而不是 saveCfg：后者只写 localStorage 镜像，有 Host
      // settings 时下次同步会被 Host 的旧值覆盖回来。
      const cur = currentCfg();
      applyCfg({ ...cur, notify: { ...cur.notify, volume: v } });
    }
  }, []);
  // 其它 DSH 标签页改了配置 → 由 15-entry 的常驻 storage 监听统一回读并 store.push()，本组件跟随。

  // 立即基于最新配置计算（内存 + localStorage 镜像 + Host），再 setState
  const setCfg = (fn) => { const next = applyCfg(fn(currentCfg())); setCfgState(next); };
  const togglePref = (jp) => setCfg((c) => {
    const cur = c.watch.prefectures;
    const removing = cur.indexOf(jp) !== -1;
    const next = removing ? cur.filter((p) => p !== jp) : cur.concat(jp);
    // 取消关注某个县时，同时清掉它下面已选的市町村（避免留下永远不生效的条目）
    const cities = removing
      ? c.watch.cities.filter((city) => citiesOfPref(jp).indexOf(city) === -1)
      : c.watch.cities;
    return { ...c, watch: { ...c.watch, prefectures: next, cities } }
  });
  // 取消选中永远允许；新增到上限时拒绝并说明原因（与 MAX_WATCH_PLACES 同一套写法，不做静默截断）。
  const toggleCity = (city) => {
    const cur = cfg.watch.cities;
    const selected = cur.indexOf(city) !== -1;
    if (!selected && cur.length >= MAX_WATCH_CITIES) {
      setCityMsg(t('settings.cities.max', { n: MAX_WATCH_CITIES })); return
    }
    setCityMsg('');
    setCfg((c) => {
      const list = c.watch.cities;
      return { ...c, watch: { ...c.watch, cities: list.indexOf(city) === -1 ? list.concat(city) : list.filter((x) => x !== city) } }
    });
  };

  // ---------- 全球关注点：全球源给的是震中坐标，没有都道府县，所以关注表达是「位置 + 半径」----------
  const addPlace = () => {
    const places = cfg.watch.places || [];
    const lat = Number(String(placeDraft.lat).trim());
    const lon = Number(String(placeDraft.lon).trim());
    const radiusKm = Number(String(placeDraft.radiusKm).trim());
    if (String(placeDraft.lat).trim() === '' || !Number.isFinite(lat) || Math.abs(lat) > 90) {
      setPlaceMsg(t('settings.place.latInvalid')); return
    }
    if (String(placeDraft.lon).trim() === '' || !Number.isFinite(lon) || Math.abs(lon) > 180) {
      setPlaceMsg(t('settings.place.lonInvalid')); return
    }
    if (!Number.isFinite(radiusKm) || radiusKm < 1 || radiusKm > 2000) {
      setPlaceMsg(t('settings.place.radiusInvalid')); return
    }
    if (places.length >= MAX_WATCH_PLACES) {
      setPlaceMsg(t('settings.place.max', { n: MAX_WATCH_PLACES })); return
    }
    const name = String(placeDraft.name || '').trim() || (lat.toFixed(2) + ', ' + lon.toFixed(2));
    // origin：手填坐标与「用我的位置」都归 'global' 分支——origin 只做标注（不影响匹配范围）。
    setCfg((c) => ({ ...c, watch: { ...c.watch, places: (c.watch.places || []).concat([{ name, lat, lon, radiusKm, origin: 'global' }]) } }));
    setPlaceDraft({ name: '', lat: '', lon: '', radiusKm: String(radiusKm) });
    setPlaceMsg(t('settings.place.addedPrefix', { name }) + t('settings.place.addedDedupe'));
  };
  const removePlace = (idx) => setCfg((c) => ({
    ...c, watch: { ...c.watch, places: (c.watch.places || []).filter((_, i) => i !== idx) },
  }));
  const useMyLocation = () => {
    const geo = (typeof navigator !== 'undefined') ? navigator.geolocation : null;
    if (!geo || typeof geo.getCurrentPosition !== 'function') { setPlaceMsg(t('settings.place.geoUnsupportedPlace')); return }
    setPlaceMsg(t('settings.place.locating'));
    geo.getCurrentPosition(
      (pos) => {
        const c = pos && pos.coords;
        if (!c) { setPlaceMsg(t('settings.place.geoNoCoords')); return }
        setPlaceDraft((d) => ({
          ...d,
          name: d.name || t('settings.place.myLocation'),
          lat: String(c.latitude.toFixed(4)),
          lon: String(c.longitude.toFixed(4)),
        }));
        setPlaceMsg(t('settings.place.fillConfirm'));
      },
      (err) => setPlaceMsg(t('settings.place.geoFailed', { reason: (err && err.message) || t('settings.place.geoDenied') })),
      { timeout: 10000 },
    );
  };
  /** 定位并**直接添加**一个关注点（半径已在级联里选好，再让用户去另一个表单点「添加」是多余的一步）。 */
  const addMyLocationPlace = () => {
    const geo = (typeof navigator !== 'undefined') ? navigator.geolocation : null;
    if (!geo || typeof geo.getCurrentPosition !== 'function') { setCnMsg(t('settings.place.geoUnsupportedCn')); return }
    setCnMsg(t('settings.place.locating'));
    geo.getCurrentPosition(
      (pos) => {
        const c = pos && pos.coords;
        if (!c) { setCnMsg(t('settings.place.geoNoCoords')); return }
        const lat = Math.round(c.latitude * 100) / 100;
        const lon = Math.round(c.longitude * 100) / 100;
        if ((cfg.watch.places || []).length >= MAX_WATCH_PLACES) { setCnMsg(t('settings.place.max', { n: MAX_WATCH_PLACES })); return }
        setCfg((cf) => ({
          ...cf,
          watch: { ...cf.watch, places: (cf.watch.places || []).concat([{ name: t('settings.place.myLocation'), lat, lon, radiusKm: cnPick.radiusKm, origin: 'global' }]) },
        }));
        // 台式机的定位靠 WiFi / IP 库，可能不准 —— 如实说，别让用户以为这就是精确位置
        setCnMsg(t('settings.place.myLocationAdded', { lat, lon, radius: cnPick.radiusKm }) +
          t('settings.place.geoImprecise'));
      },
      (err) => setCnMsg(t('settings.place.geoFailed', { reason: (err && err.message) || t('settings.place.geoDenied') }) + t('settings.place.geoDenied2')),
      { timeout: 10000 },
    );
  };

  /** 关注点输入框（受控）：四个字段共用一份草稿。 */
  const placeField = (label, key, placeholder, width) => h('label', {
    style: { display: 'flex', flexDirection: 'column', gap: 2, fontSize: 11, color: '#9aa0a6' },
  }, label, h('input', {
    type: 'text',
    value: placeDraft[key],
    placeholder,
    onChange: (e) => setPlaceDraft((d) => Object.assign({}, d, { [key]: e.target.value })),
    style: {
      width, boxSizing: 'border-box', background: '#ffffff', color: '#1a1a1a',
      border: '1px solid #6b7280', borderRadius: 6, padding: '3px 6px', fontSize: 12,
    },
  }));

  // ---------- 半径控件 ----------
  /** 当前值是否正好是某个语义档。 */
  const isRadiusPreset = (km) => RADIUS_PRESETS.some((o) => o.v === Number(km));
  /** 半径选择：三档语义标签 + 一个始终可见的数字输入（数字框是真实值，下拉只是快捷键；非档位值时下拉显示
   *  「自定义」）。 */
  const radiusControl = (km, onChange, key) => h('div', {
    key: key || 'radius',
    style: { display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, color: '#9aa0a6', flexWrap: 'wrap' },
  },
    h('span', null, t('settings.radius.label')),
    s.select(isRadiusPreset(km) ? Number(km) : 'custom',
      // 「自定义」也走 `labelKey`，与档位项同一形状——`textOf` 因此只有一条取词路径
      RADIUS_PRESETS.concat([{ v: 'custom', labelKey: 'settings.radius.custom' }]),
      (v) => { if (v !== 'custom') onChange(Number(v)); },
      (o) => t(o.labelKey)),
    h('input', {
      type: 'number', min: MIN_PLACE_RADIUS_KM, max: MAX_PLACE_RADIUS_KM, value: km,
      onChange: (e) => {
        const raw = String(e.target.value).trim();
        if (raw === '') return // 输入中间态（全删）不写进配置，等用户填完
        const v = Number(raw);
        if (!Number.isFinite(v)) return
        onChange(Math.min(MAX_PLACE_RADIUS_KM, Math.max(MIN_PLACE_RADIUS_KM, Math.round(v))));
      },
      style: {
        width: 68, boxSizing: 'border-box', background: '#ffffff', color: '#1a1a1a',
        border: '1px solid #6b7280', borderRadius: 6, padding: '3px 6px', fontSize: 12,
      },
    }),
    h('span', null, 'km'),
  );

  // ---------- 中国大陆的三级级联（0.5.0）----------
  const provinces = cnProvinces();
  /** 选了省之后，市默认落在第一个上——否则用户会以为"选了省但没反应"。 */
  const pickProvince = (province) => {
    const cities = cnCitiesOf(province);
    setCnPick((p) => ({ ...p, province, city: cities.length ? cities[0].name : '' }));
    setCnMsg('');
  };
  const addCnPlace = () => {
    const p = cnPlaceOf(cnPick.province, cnPick.city, cnPick.radiusKm);
    if (!p) { setCnMsg(t('settings.cn.pickRequired')); return }
    if ((cfg.watch.places || []).length >= MAX_WATCH_PLACES) { setCnMsg(t('settings.place.max', { n: MAX_WATCH_PLACES })); return }
    if ((cfg.watch.places || []).some((x) => x.name === p.name)) { setCnMsg(t('settings.cn.exists', { name: p.name })); return }
    setCfg((c) => ({ ...c, watch: { ...c.watch, places: (c.watch.places || []).concat([p]) } }));
    setCnMsg(t('settings.cn.added', { name: p.name, lat: p.lat, lon: p.lon, radius: p.radiusKm }));
  };
  /** 数据表加载失败时的重试。表到位后 store.push 会触发重渲。 */
  const onRetryCityTable = () => {
    try {
      const p = retryCityTable();
      if (p && typeof p.catch === 'function') p.catch(() => {});
    } catch (err) { /* 重试失败由界面上的失败文案继续表示 */ }
  };
  /** 国家 / 地区级联的第一级（中国）——省的选项。 */
  const cnCascade = () => {
    if (provinces.length === 0) {
      // 按大陆表自己的状态区分"加载中"与"失败"：只看 cityTableState 的话，大陆表失败时仍会显示"正在加载…"。
      const failed = cnAreasStateOf() === 'failed';
      return h('div', { style: { fontSize: 11, color: failed ? '#d9a406' : '#9aa0a6', marginTop: 6 } },
        failed ? t('settings.cn.tableFailed') : t('settings.cn.loading'),
        failed ? h('span', { style: { marginLeft: 8 } },
          s.btn(t('settings.retry'), onRetryCityTable, { fontSize: 11 })) : null)
    }
    const cities = cnCitiesOf(cnPick.province);
    const provOptions = [{ v: '', label: t('settings.cn.provinceAll') }]
      .concat(provinces.map((p) => ({ v: p.name, label: p.name })));
    const cityOptions = (cities.length ? cities : [{ name: '' }]).map((c) => ({ v: c.name, label: c.name || t('settings.cn.cityFirstProvince') }));
    return h('div', null,
      h('div', { style: { display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' } },
        s.select(cnPick.province, provOptions, pickProvince, (o) => o.label, t('settings.cn.provinceLabel')),
        s.select(cnPick.city, cityOptions, (v) => { setCnPick((p) => ({ ...p, city: v })); setCnMsg(''); }, (o) => o.label, t('settings.cn.cityLabel')),
      ),
      h('div', { style: { marginTop: 6 } },
        radiusControl(cnPick.radiusKm, (v) => setCnPick((p) => ({ ...p, radiusKm: v })), 'cn-radius')),
      h('div', { style: { marginTop: 8, display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' } },
        s.btn(t('settings.cn.addButton'), addCnPlace),
        s.btn(t('settings.cn.useMyLocation'), addMyLocationPlace, { fontSize: 11 }),
      ),
      cnMsg ? h('div', { role: 'status', style: { fontSize: 11, color: '#93c5fd', marginTop: 6 } }, cnMsg) : null,
    )
  };
  // 市区町村选择器：数据表到位后，为每个已关注的县提供「搜索 + 多选」
  const cityPicker = () => {
    if (cityTableState === 'failed') {
      // 失败要能重试：一次瞬时失败就让整场会话失去市町村表（市级收窄失效、选不出市町村），用户只能刷新页面。
      return h('div', { style: { fontSize: 11, color: '#d9a406', marginTop: 10 } },
        t('settings.cities.failed'),
        h('span', { style: { marginLeft: 8 } },
          s.btn(t('settings.retry'), onRetryCityTable, { fontSize: 11 })))
    }
    if (cfg.watch.prefectures.length === 0) {
      return h('div', { style: { fontSize: 11, color: '#9aa0a6', marginTop: 10 } }, t('settings.cities.pickPrefFirst'))
    }
    if (cityTableState !== 'ready') {
      return h('div', { style: { fontSize: 11, color: '#9aa0a6', marginTop: 10 } }, t('settings.cn.loading'))
    }
    return h('div', { style: { marginTop: 10 } },
      h('div', { style: { fontSize: 11, color: '#9aa0a6', marginBottom: 4 } },
        t('settings.cities.hint')),
      cfg.watch.prefectures.map((pref) => {
        const list = citiesOfPref(pref);
        if (list.length === 0) return null
        const q = cityQuery[pref] || '';
        const shown = q ? list.filter((c) => c.indexOf(q) !== -1) : list;
        const sel = list.filter((c) => cfg.watch.cities.indexOf(c) !== -1).length;
        return h('div', { key: pref, style: { border: '1px solid rgba(148,163,184,0.18)', borderRadius: 6, padding: '6px 8px', margin: '6px 0' } },
          h('div', { style: { fontSize: 12, color: '#dfe3e8', marginBottom: 4 } },
            pref + '：' + (sel === 0 ? t('settings.cities.prefAll') : t('settings.cities.prefSelected', { n: sel }))),
          h('input', {
            type: 'text', value: q, placeholder: t('settings.cities.searchPlaceholder', { pref }),
            'aria-label': t('settings.cities.searchLabel', { pref }),
            onChange: (e) => setCityQuery((prev) => Object.assign({}, prev, { [pref]: e.target.value })),
            style: { width: '100%', boxSizing: 'border-box', background: '#ffffff', color: '#1a1a1a', border: '1px solid #6b7280', borderRadius: 6, padding: '3px 8px', fontSize: 12, marginBottom: 5 },
          }),
          h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 4, maxHeight: 150, overflowY: 'auto' } },
            shown.slice(0, 200).map((city) => {
              const on = cfg.watch.cities.indexOf(city) !== -1;
              return h('button', {
                key: city, onClick: () => toggleCity(city),
                // 选中态也要给 aria-pressed，否则读屏用户无法知道选了哪些市町村。
                'aria-pressed': on ? 'true' : 'false',
                style: {
                  fontSize: 11, padding: '2px 8px', borderRadius: 11, cursor: 'pointer',
                  border: '1px solid ' + (on ? '#3b82f6' : 'rgba(148,163,184,0.3)'),
                  background: on ? 'rgba(59,130,246,0.18)' : 'transparent',
                  color: on ? '#93c5fd' : '#9aa0a6',
                },
              }, city)
            }),
            shown.length > 200
              ? h('span', { style: { fontSize: 11, color: '#9aa0a6' } }, t('settings.cities.overLimit', { n: shown.length }))
              : null),
        )
      }),
      cityMsg ? h('div', { role: 'status', style: { fontSize: 11, color: '#93c5fd', marginTop: 6 } }, cityMsg) : null,
    )
  };
  // ---------- 关注地区的统合 ----------
  // 第一级从三个平铺区块收成一个唯一的「国家 / 地区」选择器，选中后只展开该国自己的下级控件；代码里仍是
  // 三条各自合适的实现（"统合 UI，不统合模型"）：日本 → 都道府县 + 市区町村（源按行政区名匹配）；大陆 →
  // 省 + 地级市 + 半径；其他国家 → 坐标 + 半径。硬把日本改成坐标匹配会让"震中 150km 外、本地却到震度 5
  // 弱"的地震漏掉，所以数据模型一个字段都不动。县名的显示名统一走 01-constants 的 `prefLabelOf`。
  /** 按来源分支筛关注点（`origin` 见 02-storage 的 placeOriginOf）。 */
  const placesOfOrigin = (origin) => (cfg.watch.places || [])
    .filter((p) => (origin === 'cn' ? (p && p.origin === 'cn') : (p && p.origin !== 'cn')));
  /** 唯一的「国家 / 地区」选择器（三个分支各自带已关注计数）。 */
  const regionTabs = () => h('div', { style: { display: 'flex', gap: 6, flexWrap: 'wrap' } },
    REGION_TABS.map((tab) => {
      const n = tab.v === 'jp' ? (cfg.watch.prefectures || []).length : placesOfOrigin(tab.v).length;
      const on = regionTab === tab.v;
      return h('button', {
        key: tab.v,
        onClick: () => setRegionTab(tab.v),
        'aria-pressed': on ? 'true' : 'false',
        style: {
          fontSize: 12, padding: '5px 12px', borderRadius: 8, cursor: 'pointer',
          border: '1px solid ' + (on ? '#3b82f6' : 'rgba(148,163,184,0.3)'),
          background: on ? 'rgba(59,130,246,0.18)' : 'transparent',
          color: on ? '#93c5fd' : '#9aa0a6',
        },
      }, tab.icon + ' ' + t(tab.labelKey) + (n > 0 ? '（' + n + '）' : ''))
    }));

  /**
   * 已关注地区的统一列表（按来源分支分组）：配置里仍是 prefectures / cities / places 三份数据，
   * 但用户看到的是一份"我关注了哪里"的清单。
   */
  const watchList = () => {
    const w = cfg.watch || {};
    const places = w.places || [];
    const jpRows = (w.prefectures || []).map((pref) => {
      const cities = (w.cities || []).filter((c) => citiesOfPref(pref).indexOf(c) !== -1);
      // 显示名随语言（日文「東京都」/ 中文「东京」/ 英文「Tokyo」）；原名只在两者不同时括注。
      const label = prefLabelOf(pref);
      return h('div', { key: 'wl-jp-' + pref, style: { display: 'flex', alignItems: 'center', gap: 8, margin: '3px 0', fontSize: 12 } },
        h('span', { style: { flex: 1 } },
          '🇯🇵 ' + label + (label !== pref ? t('settings.watch.prefMeta', { jp: pref }) : '') +
          t('settings.watch.prefOrFull') +
          (cities.length ? t('settings.watch.prefDetail', { n: cities.length }) : '')),
        s.btn(t('settings.watch.remove'), () => togglePref(pref)))
    });
    const placeRow = (p, i, icon) => h('div', { key: 'wl-place-' + i, style: { display: 'flex', alignItems: 'center', gap: 8, margin: '3px 0', fontSize: 12 } },
      h('span', { style: { flex: 1 } },
        icon + ' ' + p.name + ' · ' + Number(p.lat).toFixed(3) + ', ' + Number(p.lon).toFixed(3) +
        t('settings.watch.placeMeta', { radius: p.radiusKm })),
      s.btn(t('settings.watch.remove'), () => removePlace(i)));
    const cnRows = [];
    const glRows = [];
    places.forEach((p, i) => {
      if (p && p.origin === 'cn') cnRows.push(placeRow(p, i, '🇨🇳'));
      else glRows.push(placeRow(p, i, '🌐'));
    });
    const group = (title, rows, empty) => h('div', { style: { marginTop: 8 } },
      h('div', { style: { fontSize: 11, color: '#9aa0a6', marginBottom: 2 } }, title),
      rows.length ? rows : h('div', { style: { fontSize: 11, color: '#9aa0a6' } }, empty));
    const total = (w.prefectures || []).length + places.length;
    return h('div', { style: { marginTop: 12, borderTop: '1px solid rgba(148,163,184,0.18)', paddingTop: 8 } },
      h('div', { style: { fontSize: 12, fontWeight: 700, color: '#dfe3e8' } }, t('settings.watch.title', { n: total })),
      total === 0
        ? h('div', { style: { fontSize: 11, color: '#d9a406', marginTop: 4 } }, t('settings.watch.empty'))
        : null,
      group(t('settings.watch.groupJp'), jpRows, t('settings.watch.noneJp')),
      group(t('settings.watch.groupCn'), cnRows, t('settings.watch.noneOther')),
      group(t('settings.watch.groupGlobal'), glRows, t('settings.watch.noneOther')),
    )
  };

  /** 日本分支：都道府县 + 市区町村细化。 */
  const jpBranch = () => h('div', null,
    h('div', { style: { fontSize: 11, color: '#9aa0a6', marginBottom: 8 } },
      cfg.watch.prefectures.length === 0
        ? t('settings.jp.hintAll')
        : t('settings.jp.hintSelected', { n: cfg.watch.prefectures.length })),
    h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 5 } },
      PREFECTURES.map((p) => {
        const on = cfg.watch.prefectures.indexOf(p.jp) !== -1;
        return h('button', {
          key: p.jp,
          onClick: () => togglePref(p.jp),
          'aria-pressed': on ? 'true' : 'false',
          style: {
            fontSize: 11, padding: '2px 9px', borderRadius: 12, cursor: 'pointer',
            border: '1px solid ' + (on ? '#3b82f6' : 'rgba(148,163,184,0.3)'),
            background: on ? 'rgba(59,130,246,0.18)' : 'transparent',
            color: on ? '#93c5fd' : '#9aa0a6',
          },
        }, prefLabelOf(p.jp))
      }),
    ),
    cityPicker(),
  );

  /** 中国大陆分支：省 → 地级市 → 半径（说明文字随分支走）。 */
  const cnBranch = () => h('div', null,
    h('div', { style: { fontSize: 11, color: '#9aa0a6', marginBottom: 8 } },
      t('settings.cnBranch.hint')),
    // 无取消机制是安全相关的缺口：主视野只留这一行结论，完整边界收进折叠（信息不删，只是不再占地方）。
    h('div', { style: { fontSize: 11, color: '#d9a406', marginBottom: 8 } },
      t('settings.cnBranch.warning')),
    cnCascade(),
    fold(t('settings.cnBranch.foldTitle'),
      h('div', null, t('settings.cnBranch.fold1')),
      h('div', null, t('settings.cnBranch.fold2')),
      h('div', null, t('settings.cnBranch.fold3'))),
  );

  /** 从城市表点选一个城市 → 关注点（origin: 'global'，半径取上面那个共用旋钮）。 */
  const addCityPlace = (c) => {
    const places = cfg.watch.places || [];
    if (places.length >= MAX_WATCH_PLACES) { setPlaceMsg(t('settings.place.max', { n: MAX_WATCH_PLACES })); return }
    // 按**坐标**判重（与 normalizePlaces 的口径一致）：否则同一个城市点两次会出现两行
    if (places.some((p) => p && Math.abs(p.lat - c.lat) < 0.02 && Math.abs(p.lon - c.lon) < 0.02)) {
      setPlaceMsg(t('settings.cn.exists', { name: c.name })); return
    }
    const radiusKm = Number(placeDraft.radiusKm) || DEFAULT_PLACE_RADIUS_KM;
    setCfg((cf) => ({ ...cf, watch: { ...cf.watch, places: (cf.watch.places || []).concat([
      { name: c.name, lat: c.lat, lon: c.lon, radiusKm, origin: 'global' },
    ]) } }));
    setPlaceMsg(t('settings.cn.added', { name: c.name, lat: c.lat, lon: c.lon, radius: radiusKm }));
  };

  /** 其他国家 / 地区分支：先按国家选城市（9.4 的城市表），再给手填坐标这个出口。 */
  const globalBranch = () => {
    const hint = { fontSize: 11, color: '#9aa0a6', lineHeight: 1.6 };
    const countries = worldCountriesOf();
    // 国家名的取词与排序都跟着**当前界面语言**（见 countryNameOf）
    const lang = getLanguage();
    const pack = country ? countryPackOf(country) : null;
    const cityList = (pack && pack.state === 'ready') ? pack.cities : [];
    const q = worldCityQuery.trim();
    const shown = q
      ? cityList.filter((c) => c.name.indexOf(q) !== -1 ||
          (c.admin && c.admin.toLowerCase().indexOf(q.toLowerCase()) !== -1))
      : cityList;
    const cityBlock = () => {
      if (!country) {
        return h('div', { style: Object.assign({}, hint, { marginTop: 8 }) },
          countries.length ? t('settings.global.cityFirst') : t('settings.cn.loading'))
      }
      if (!pack || pack.state === 'loading') {
        return h('div', { style: Object.assign({}, hint, { marginTop: 8 }) }, t('settings.cn.loading'))
      }
      if (pack.state === 'failed') {
        return h('div', { style: Object.assign({}, hint, { marginTop: 8, color: '#d9a406' }) },
          t('settings.global.cityFailed'))
      }
      if (pack.error === 'not-covered' || cityList.length === 0) {
        return h('div', { style: Object.assign({}, hint, { marginTop: 8 }) },
          t('settings.global.cityNotCovered'))
      }
      return h('div', { style: { marginTop: 8 } },
        h('input', {
          type: 'text', value: worldCityQuery, placeholder: t('settings.global.citySearchPlaceholder', { n: cityList.length }),
          'aria-label': t('settings.global.citySearchLabel'),
          onChange: (e) => setWorldCityQuery(e.target.value),
          style: {
            width: '100%', boxSizing: 'border-box', background: '#ffffff', color: '#1a1a1a',
            border: '1px solid #6b7280', borderRadius: 6, padding: '3px 8px', fontSize: 12,
          },
        }),
        h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 4, maxHeight: 170, overflowY: 'auto', marginTop: 6 } },
          shown.slice(0, 200).map((c) => {
            const label = c.admin ? c.name + '（' + c.admin + '）' : c.name;
            return h('button', {
              key: c.name + '@' + c.lat + ',' + c.lon,
              onClick: () => addCityPlace(c),
              title: t('settings.global.cityAddTitle', { label }),
              style: {
                fontSize: 11, padding: '2px 9px', borderRadius: 11, cursor: 'pointer',
                border: '1px solid rgba(148,163,184,0.3)', background: 'transparent', color: '#9aa0a6',
              },
            }, label)
          }),
          shown.length > 200
            ? h('span', { style: hint }, t('settings.cities.overLimit', { n: shown.length }))
            : null),
      )
    };
    return h('div', null,
      h('div', { style: Object.assign({}, hint, { marginBottom: 8 }) },
        t('settings.global.hint')),
      s.label(t('settings.global.countryLabel')),
      s.row(s.select(country,
        [{ v: '', label: countries.length ? t('settings.global.countryAll') : t('settings.global.countryLoading') }]
          .concat(countries
            // 国家名按当前界面语言取（数据里带四种语言的写法），并按该语言的排序规则排——中文按拼音、
            // 日文按假名、英文按字母。这里**只映射一次**：排原始条目（按解析出的本地化名字），再 map 成
            // `{v, label}`；链到第二段时字段名变了会让所有 option 的 value 相同。
            .slice()
            .sort((a, b) => countryNameOf(a, lang).localeCompare(countryNameOf(b, lang), lang))
            .map((c) => ({
              v: c.code,
              label: t('settings.global.countryOption', { name: countryNameOf(c, lang), n: c.count }),
            }))),
        (v) => { setCountry(v); setWorldCityQuery(''); if (v) loadCountryCities(v); },
        (o) => o.label, t('settings.global.countryLabel'))),
      // 半径是**共用**的一个旋钮：城市点选与手填坐标都按它新建关注点（匹配层只认每个点自己的 radiusKm）。
      h('div', { style: { marginTop: 6 } },
        radiusControl(Number(placeDraft.radiusKm) || DEFAULT_PLACE_RADIUS_KM,
          (v) => setPlaceDraft((d) => ({ ...d, radiusKm: String(v) })), 'place-radius')),
      cityBlock(),
      h('div', { style: { marginTop: 12, borderTop: '1px solid rgba(148,163,184,0.18)', paddingTop: 10 } },
        h('div', { style: Object.assign({}, hint, { marginBottom: 6 }) }, t('settings.global.manualHint')),
        h('div', { style: { display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'flex-end' } },
          placeField(t('settings.place.fieldName'), 'name', t('settings.place.fieldNamePlaceholder'), 120),
          placeField(t('settings.place.fieldLat'), 'lat', '35.6812', 90),
          placeField(t('settings.place.fieldLon'), 'lon', '139.7671', 90),
          s.btn(t('settings.place.add'), addPlace),
          s.btn(t('settings.place.useCurrentShort'), useMyLocation)),
      ),
      placeMsg ? h('div', { role: 'status', style: { fontSize: 11, color: '#93c5fd', marginTop: 6 } }, placeMsg) : null,
    )
  };

  const sectionWatch = () => s.section(t('settings.section.watch'),
    regionTabs(),
    h('div', { style: { marginTop: 10 } },
      regionTab === 'jp' ? jpBranch() : (regionTab === 'cn' ? cnBranch() : globalBranch())),
    watchList(),
  );

  // ---------- 灾害类型与阈值（按灾种一张表）----------
  // 一行就是一个灾种，它自己的开关与阈值并排。开关的共享关系如实呈现（`disasters.earthquake` 一个字段管
  // 四行地震），不伪造四个开关：拆开会让老配置的语义漂移。
  /** 一行：灾种名 + 口径说明 | 开关 + 阈值。 */
  const disasterRow = (label, note, control) => h('div', {
    style: { display: 'flex', alignItems: 'flex-start', gap: 10, padding: '6px 0', borderBottom: '1px solid rgba(148,163,184,0.10)' },
  },
    h('div', { style: { flex: 1, minWidth: 170 } },
      h('div', { style: { fontSize: 12, color: '#e6e6e8' } }, label),
      note ? h('div', { style: { fontSize: 11, color: '#9aa0a6', lineHeight: 1.5, marginTop: 2 } }, note) : null),
    h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', paddingTop: 2 } },
      (Array.isArray(control) ? control : [control]).filter(Boolean)));
  const switchOf = (key, text) => s.checkbox(cfg.disasters[key] !== false,
    (v) => setCfg((c) => ({ ...c, disasters: { ...c.disasters, [key]: v } })), text);
  const thSelect = (key, options, asNumber, label) => s.select(cfg.thresholds[key], options,
    (v) => setCfg((c) => ({ ...c, thresholds: { ...c.thresholds, [key]: asNumber ? Number(v) : v } })),
    // 选项文字是 `labelKey`（值的档位表在 01-constants，文字在文案表）：渲染时取词，切语言后跟着换。
    (o) => t(o.labelKey), label);
  /** 分组的标题行：一个开关管这一组的若干行（共享关系写在标题里，别让人以为漏了开关）。 */
  const disasterGroup = (title, switchKey, switchText, extra) => h('div', {
    style: { display: 'flex', alignItems: 'center', gap: 10, margin: '14px 0 2px', flexWrap: 'wrap' },
  },
    h('div', { style: { fontSize: 12, fontWeight: 700, color: '#93c5fd', flex: 1, minWidth: 150 } }, title),
    switchKey ? switchOf(switchKey, switchText || t('settings.disaster.notifySwitch')) : null,
    extra || null);
  /** 播报门槛（不可调）。写成只读文字而不是置灰的下拉——置灰的下拉会让人以为能调。 */
  const fixedGate = (text) => h('span', { style: { fontSize: 11, color: '#9aa0a6' } }, text);

  const sectionDisasters = () => s.section(t('settings.section.disaster'),
    h('div', { style: { fontSize: 11, color: '#9aa0a6', marginBottom: 4 } },
      t('settings.disaster.hint')),

    // —— 地震：日本 / 全球 / 大陆共用 disasters.earthquake 这一个开关 ——
    disasterGroup(t('settings.disaster.groupQuake'), 'earthquake', t('settings.disaster.notifySwitch')),
    disasterRow(t('settings.disaster.quakeJpLabel'), t('settings.disaster.quakeJpNote'), [thSelect('quakeScale', SCALE_OPTIONS, true, t('settings.disaster.quakeJpSelect'))]),
    disasterRow(t('settings.disaster.eewLabel'), t('settings.disaster.eewNote'), [thSelect('eewScale', SCALE_OPTIONS, true, t('settings.disaster.eewSelect'))]),
    disasterRow(t('settings.disaster.globalLabel'), t('settings.disaster.globalNote'), [thSelect('globalMagnitude', GLOBAL_MAG_OPTIONS, true, t('settings.disaster.globalSelect'))]),
    disasterRow(t('settings.disaster.cnReportLabel'), t('settings.disaster.cnReportNote'), [thSelect('cnReportMagnitude', CN_REPORT_MAG_OPTIONS, true, t('settings.disaster.cnReportSelect'))]),
    fold(t('settings.disaster.foldScaleTitle'),
      h('div', null, t('settings.disaster.foldScale1')),
      h('div', null, t('settings.disaster.foldScale2'))),

    // —— 海啸：日本 552 与 NOAA CAP 共用等级门槛 ——
    disasterGroup(t('settings.disaster.groupTsunami'), 'tsunami', t('settings.disaster.notifySwitch')),
    // note 要写清全球源看的是**关注点**（`places`），不是日本那 47 个都道府县。
    disasterRow(t('settings.disaster.tsunamiJpLabel'), t('settings.disaster.tsunamiJpNote'), [thSelect('tsunamiGrade', TSUNAMI_OPTIONS, false, t('settings.disaster.tsunamiSelect'))]),

    // —— 气象：门槛固定在该机构真正代表危险的那一档（L4 避難指示级才真正涉及人身财产损失）——
    disasterGroup(t('settings.disaster.groupWeatherJp'), 'weather', t('settings.disaster.notifySwitch')),
    disasterRow(t('settings.disaster.weatherJpLabel'), t('settings.disaster.weatherJpNote'), [fixedGate(t('settings.disaster.gateJma4'))]),

    // 中国大陆气象灾害：两个灾种分开——它们同源但产出差别很大，合成一个开关会让"我只想要暴雨"的用户找不到出口。
    disasterGroup(t('settings.disaster.groupWeatherCn'), null, null,
      [switchOf('cnRainstorm', t('settings.disaster.cnRainstormSwitch')), switchOf('cnGeology', t('settings.disaster.cnGeologySwitch'))]),
    disasterRow(t('settings.disaster.weatherCnLabel'), t('settings.disaster.weatherCnNote'), [fixedGate(t('settings.disaster.gateOrange'))]),

    // 海外气象灾害：美国 NWS + 加拿大 ECCC。一个开关覆盖两个源（各自按关注点生效）。
    disasterGroup(t('settings.disaster.groupWeatherOverseas'), 'overseasWeather', t('settings.disaster.notifySwitch')),
    disasterRow(t('settings.disaster.weatherOverseasLabel'), t('settings.disaster.weatherOverseasNote'), [fixedGate(t('settings.disaster.gateOverseas'))]),

    // 长解释（安全相关 + 许可署名）收进折叠：一条都不能删，只是不再占主视野。
    fold(t('settings.disaster.foldTradeoffsTitle'),
      h('div', { style: { fontWeight: 600, color: '#c8ccd4' } }, t('settings.disaster.tradeoffCnTitle')),
      h('div', null, t('settings.disaster.tradeoffCn1')),
      h('div', null, t('settings.disaster.tradeoffCn2')),
      h('div', null, t('settings.disaster.tradeoffCn3')),
      h('div', null, t('settings.disaster.tradeoffCn4')),
      h('div', { style: { fontWeight: 600, color: '#c8ccd4', marginTop: 4 } }, t('settings.disaster.tradeoffOverseasTitle')),
      h('div', null, t('settings.disaster.tradeoffOverseas1')),
      h('div', null, t('settings.disaster.tradeoffOverseas2')),
      // ECCC 的 wind warning 确实是 warning，它被排除是因为**不在本插件的灾种范围内**，不是不危险。
      h('div', null, t('settings.disaster.tradeoffOverseas3')),
      h('div', null, t('settings.disaster.tradeoffOverseas4')),
      h('div', null, t('settings.disaster.tradeoffOverseas5'))),
    store.weatherHint
      ? h('div', { style: { fontSize: 11, color: '#d9a406', marginTop: 6 } },
          t('settings.disaster.weatherHint', { label: store.weatherHint.label || '', level: store.weatherHint.level }))
      : null,
  );
  const flushVolume = () => {
    if (volTimer.current) { clearTimeout(volTimer.current); volTimer.current = null; }
    const v = volPending.current;
    if (v === null) return
    volPending.current = null;
    setVolDraft(null);
    setCfg((c) => ({ ...c, notify: { ...c.notify, volume: v } }));
  };
  const onVolumeInput = (v) => {
    volPending.current = v;
    setVolDraft(v);
    if (volTimer.current) clearTimeout(volTimer.current);
    volTimer.current = setTimeout(flushVolume, 300);
  };
  const volShown = volDraft === null ? cfg.notify.volume : volDraft;

  const statusMeta = statusMetaOf(store.status, store.retries);
  // 状态圆点，不带外边距（唯一用它的 statusStrip 是 flex + gap 排的）。disabled（用户关掉了灾种或全部
  // 关掉）必须画空心，与 14-ui-status.js 的 StatusIndicator 同一形态：形状差异是色觉障碍用户唯一能用的判据。
  const dotStyle = store.status === 'disabled'
    ? { display: 'inline-block', width: 10, height: 10, borderRadius: '50%', background: 'transparent', border: '1.5px solid ' + statusMeta.color, flexShrink: 0 }
    : { display: 'inline-block', width: 10, height: 10, borderRadius: '50%', background: statusMeta.color, flexShrink: 0 };
  const dot = h('span', { style: dotStyle });

  const permText = {
    granted: t('settings.perm.granted'),
    denied: t('settings.perm.denied'),
    default: t('settings.perm.default'),
    unsupported: t('settings.perm.unsupported'),
  }[perm] || '';

  // ---------- 选项卡：每页只渲染自己的区块，未选中的页不产生 DOM ----------
  /** 选项卡角标：只有真的有内容时才显示数字，免得三个空数字占视线。 */
  const tabBadgeOf = (v) => {
    if (v === 'region') {
      const n = (cfg.watch.prefectures || []).length + (cfg.watch.places || []).length;
      return n > 0 ? ' ' + n : ''
    }
    if (v === 'history') return store.events.length > 0 ? ' ' + store.events.length : ''
    return ''
  };
  const tabBar = () => h('div', {
    style: { display: 'flex', gap: 2, flexWrap: 'wrap', borderBottom: '1px solid rgba(148,163,184,0.18)' },
  }, SETTINGS_TABS.map((tabDef) => {
    const on = tab === tabDef.v;
    return h('button', {
      key: tabDef.v,
      onClick: () => setTab(tabDef.v),
      // `aria-current` 而不是 `aria-pressed`：这是"当前显示哪一页"，不是开关。不用 role="tablist" 是因为
      // 那套 ARIA 还要求方向键导航与 tabpanel 关联，只加一半比没有更糟。
      'aria-current': on ? 'true' : undefined,
      style: {
        fontSize: 12, padding: '7px 13px', cursor: 'pointer', background: 'transparent',
        border: 'none', borderBottom: '2px solid ' + (on ? '#3b82f6' : 'transparent'),
        color: on ? '#e6e6e8' : '#9aa0a6', fontWeight: on ? 600 : 400,
      },
    }, t(tabDef.labelKey) + tabBadgeOf(tabDef.v))
  }));

  /**
   * 常驻状态条（**在选项卡之外**）：只回答"通不通、收到多少条"。逐源细节在「其他」页的「源状态」里。
   */
  const statusStrip = () => h('div', {
    style: {
      display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap',
      padding: '8px 16px', borderBottom: '1px solid rgba(148,163,184,0.14)', fontSize: 12,
    },
  },
    dot,
    h('span', { style: { fontWeight: 600 } }, statusMeta.text),
    store.received > 0
      ? h('span', { style: { color: '#9aa0a6' } }, t('settings.strip.received', { n: store.received }))
      : null,
    // 告诉用户"更细的在哪"，已经在那一页时就不必再说。颜色用 #9aa0a6 以保证 11px 小字过 AA 4.5:1。
    tab === 'misc' ? null : h('span', { style: { color: '#9aa0a6', fontSize: 11, marginLeft: 'auto' } }, t('settings.strip.more')));

  /** 界面语言：选中即由 15-entry 写进配置并调 setLanguage，界面**当场**跟着换。 */
  const sectionLanguage = () => s.section(t('settings.section.language'),
    // `flex: 1`：这一行只有标签与一个短下拉，不撑满的话右半边空着、观感像"控件没对齐"。
    s.row(s.label(t('settings.language.label')), s.select(cfg.language, LANGUAGE_OPTIONS,
      (v) => setCfg((c) => ({ ...c, language: v })), (o) => o.label, t('settings.language.label'), { flex: 1 })),
  );

  /** 数据源与配置存储。数据源切换是"验证用"的，所以与其他排障面同页。 */
  const sectionSource = () => s.section(t('settings.section.source'),
    s.row(
      s.select(cfg.source, [
        { v: 'prod', label: t('settings.source.prod') },
        { v: 'sandbox', label: t('settings.source.sandbox') },
      ], (v) => {
        setCfg((c) => ({ ...c, source: v }));
        // 延时用 ref 保存并在卸载时清理：否则"切换数据源后 80ms 内离开设置页"会在到点时复活一个已无 fiber
        // 归属的 socket（继续上报状态并响铃）。执行前再复查 activeClient。
        if (restartTimer.current) clearTimeout(restartTimer.current);
        restartTimer.current = setTimeout(() => {
          restartTimer.current = null;
          const c = activeClient; // 模块级 live binding：插件停用时已被置为 null
          if (c) { try { c.restart(); } catch (err) { /* 忽略 */ } }
        }, 80);
      }, (o) => o.label, t('settings.section.source')),
    ),
    h('div', { style: { fontSize: 11, color: '#9aa0a6', marginTop: 6 } },
      t('settings.source.config', { value: settingsSyncLabel() })),
  );

  // 大陆源的链路选择是一个出口：自动降级判不出的那几种网络（能连上、偶尔漏、整体像坏的）需要手动开关。
  const sectionCnTransport = () => s.section(t('settings.section.cnTransport'),
    s.row(s.label(t('settings.cnTransport.label')), s.select(cfg.cnTransport || 'auto', [
      { v: 'auto', label: t('settings.cnTransport.auto') },
      { v: 'poll', label: t('settings.cnTransport.poll') },
    ], (v) => setCfg((c) => ({ ...c, cnTransport: v })), (o) => o.label, t('settings.cnTransport.selectLabel'))),
    fold(t('settings.cnTransport.foldTitle'),
      h('div', null, t('settings.cnTransport.fold1')),
      h('div', null, t('settings.cnTransport.fold2'))),
  );

  const sectionNotify = () => s.section(t('settings.section.notify'),
    s.row(
      s.checkbox(cfg.notify.sound !== false, (v) => setCfg((c) => ({ ...c, notify: { ...c.notify, sound: v } })), t('settings.notify.sound')),
      s.checkbox(cfg.notify.system !== false, (v) => setCfg((c) => ({ ...c, notify: { ...c.notify, system: v } })), t('settings.notify.system')),
    ),
    // 分灾害音效开关：总开关关掉时这三个没有意义，所以**只在总开关打开时显示**（"显示却无效"是要避免的那种界面）。
    cfg.notify.sound !== false
      ? s.row(
        s.checkbox(cfg.notify.soundQuake !== false, (v) => setCfg((c) => ({ ...c, notify: { ...c.notify, soundQuake: v } })), t('settings.notify.soundQuake')),
        s.checkbox(cfg.notify.soundTsunami !== false, (v) => setCfg((c) => ({ ...c, notify: { ...c.notify, soundTsunami: v } })), t('settings.notify.soundTsunami')),
        s.checkbox(cfg.notify.soundWeather !== false, (v) => setCfg((c) => ({ ...c, notify: { ...c.notify, soundWeather: v } })), t('settings.notify.soundWeather')),
      )
      : null,
    s.row(s.label(t('settings.notify.volume')), h('input', {
      type: 'range', min: 0, max: 100,
      value: Math.round(volShown * 100),
      onChange: (e) => onVolumeInput(Number(e.target.value) / 100),
      'aria-label': t('settings.notify.volume'),
      style: { flex: 1, minWidth: 120 },
    }), h('span', { style: { color: '#9aa0a6', fontSize: 11, width: 34 } }, Math.round(volShown * 100) + '%')),
    s.row(
      // 试听本身就是用户手势：顺手解锁音频并刷新状态提示（否则"尚未解锁"的警告会一直挂着）
      s.btn(t('settings.notify.testQuake'), () => { unlockAudio(); setTick((t) => t + 1); playSound('quake', volShown); }),
      s.btn(t('settings.notify.testEew'), () => { unlockAudio(); setTick((t) => t + 1); playSound('eew', volShown); }),
      s.btn(t('settings.notify.testTsunami'), () => { unlockAudio(); setTick((t) => t + 1); playSound('tsunami', volShown); }),
      s.btn(t('settings.notify.testWeather'), () => { unlockAudio(); setTick((t) => t + 1); playSound('weather', volShown); }),
    ),
    s.row(
      s.btn(t('settings.notify.testSystem'), () => {
        unlockAudio();
        const send = () => {
          const ok = showSystemNotification({ title: t('settings.notify.testTitle'), body: t('settings.notify.testBody'), tag: 'quake-test', silent: true });
          setTestMsg(ok ? t('settings.notify.testSent') : t('settings.notify.testFailed'));
        };
        if (perm === 'unsupported') { setTestMsg(t('settings.notify.unsupportedTest')); return }
        if (perm === 'denied') { setTestMsg(t('settings.notify.deniedRetry')); return }
        if (perm === 'default') {
          requestNotificationPermission().then((p) => {
            setPerm(p);
            if (p === 'granted') send();
            else setTestMsg(t('settings.notify.notGranted'));
          });
          return
        }
        send();
      }),
      s.btn(t('settings.notify.testToast'), () => showToast({ title: t('settings.notify.testTitle'), body: t('settings.notify.toastBody'), color: '#4ade80', ttlMs: 4000 })),
    ),
    h('div', { style: { color: '#9aa0a6', fontSize: 11, marginTop: 6 } }, permText),
    // 提示音未解锁时必须**显式告知**：页面可见时通知路径只用页内 toast，用户会看到「提示音：开」却听不到声音。
    audioState() === 'suspended'
      ? h('div', { style: { color: '#d9a406', fontSize: 11, marginTop: 4 } },
          t('settings.notify.audioLocked'))
      : (audioState() === 'unavailable'
        ? h('div', { style: { color: '#9aa0a6', fontSize: 11, marginTop: 4 } }, t('settings.notify.audioUnavailable'))
        : null),
    testMsg ? h('div', { role: 'status', style: { color: '#93c5fd', fontSize: 11, marginTop: 4 } }, testMsg) : null,
  );

  // 静默时段
  const sectionQuiet = () => s.section(t('settings.section.quiet'),
    s.row(s.checkbox(cfg.quietHours.enabled, (v) => setCfg((c) => ({ ...c, quietHours: { ...c.quietHours, enabled: v } })), t('settings.quiet.enable'))),
    s.row(
      s.label(t('settings.quiet.start')),
      h('input', {
        type: 'time', value: cfg.quietHours.start,
        'aria-label': t('settings.quiet.startLabel'),
        onChange: (e) => setCfg((c) => ({ ...c, quietHours: { ...c.quietHours, start: e.target.value || c.quietHours.start } })),
        style: { background: '#ffffff', color: '#1a1a1a', border: '1px solid #6b7280', borderRadius: 6, padding: '4px 8px', fontSize: 12 },
      }),
      s.label(t('settings.quiet.end')),
      h('input', {
        type: 'time', value: cfg.quietHours.end,
        'aria-label': t('settings.quiet.endLabel'),
        onChange: (e) => setCfg((c) => ({ ...c, quietHours: { ...c.quietHours, end: e.target.value || c.quietHours.end } })),
        style: { background: '#ffffff', color: '#1a1a1a', border: '1px solid #6b7280', borderRadius: 6, padding: '4px 8px', fontSize: 12 },
      }),
    ),
    s.row(s.checkbox(cfg.quietHours.breakForSevere, (v) => setCfg((c) => ({ ...c, quietHours: { ...c.quietHours, breakForSevere: v } })), t('settings.quiet.breakForSevere'))),
    h('div', { style: { fontSize: 11, color: '#9aa0a6', marginTop: 6 } },
      // 时区基准必须写出来：这个判定用的是**浏览器本地时间**（inQuietHours），跨时区用户猜错会在半夜被响铃。
      t('settings.quiet.hint')),
  );

  // 测试与诊断：两类测试按钮都是"无灾情时验证整条链路"的入口，与源状态、诊断快照同属排障面。
  const sectionDiagnostics = () => s.section(t('settings.section.diag'),
    h('div', { style: { fontSize: 11, color: '#9aa0a6', marginBottom: 6 } },
      t('settings.diag.hint')),
    // 气象链路：区域取关注列表首项，保证一定命中（否则点了没反应会让人以为坏了）。
    s.row(s.btn(t('settings.diag.sendWeather'), () => {
      const pref = (cfg.watch.prefectures && cfg.watch.prefectures[0]) || '東京都';
      const sc = TEST_SCENARIOS[weatherTestSeq % TEST_SCENARIOS.length];
      const ms = Date.now();
      const city = citiesOfPref(pref)[0] || ''; // 市町村级场景用真实市町村名
      const alert = parseJma(buildTestTelegram(pref, ms, sc.key, city), { id: 'test-weather-' + ms });
      setWeatherTestSeq(weatherTestSeq + 1);
      if (!alert) { setWeatherTestMsg(t('settings.diag.parseFailed')); return }
      // 事件键改成**每次都不同**，否则同一场景第二次就静默：汇总型电文的事件键是「灾种 + 官署」（不含发布时刻），
      // 连点两次会算出同一个键而被 `isEventRepeat` 判成"强度未升级"、只记历史。
      alert.eventKey = 'test-weather:' + ms + ':' + sc.key;
      const res = handleAlert(alert, currentCfg(), { skipQuietHours: true });
      // 提示按**实际结果**生成：开关关闭 / 未达 L4 / 静默 / 其它标签页已提醒时就是不会响，必须如实说明。
      const outcome = res && res.notified
        ? t('settings.diag.outcomeSent')
        : t('settings.diag.outcomeNotSent', { reason: (res && res.detail) || t('settings.diag.outcomeUnknown') });
      setWeatherTestMsg(t('settings.diag.sentWeather', { label: t('settings.diag.scenario.' + sc.key), pref, level: alert.level, note: t('settings.diag.scenarioNote.' + sc.key) }) + outcome);
    })),
    h('div', { style: { fontSize: 11, color: '#9aa0a6', marginTop: 4 } },
      t('settings.diag.scenarios', { list: TEST_SCENARIOS.map((x) => t('settings.diag.scenario.' + x.key)).join(' / ') })),
    weatherTestMsg
      ? h('div', { role: 'status', style: { color: '#93c5fd', fontSize: 11, marginTop: 4 } }, weatherTestMsg)
      : null,
    // 全球链路：构造的是**源格式原文**（EMSC / USGS / NOAA 各一种），因此解析器与匹配引擎都被真实走过。
    s.row(s.btn(t('settings.diag.sendGlobal'), () => {
      const places = cfg.watch.places || [];
      if (places.length === 0) { setGeTestMsg(t('settings.diag.needPlace')); return }
      const sc = TEST_GEO_SCENARIOS[geTestSeq % TEST_GEO_SCENARIOS.length];
      const ms = Date.now();
      const msg = buildTestGlobalMessage(places[0], ms, sc.key);
      setGeTestSeq(geTestSeq + 1);
      const alert = parseTestGlobalMessage(msg);
      if (!alert) { setGeTestMsg(t('settings.diag.parseFailed')); return }
      const res = handleAlert(alert, currentCfg(), { skipQuietHours: true });
      // 提示按**实际结果**生成：开关关闭 / 半径外 / 静默 / 其它标签页已提醒时就是不会响，必须如实说明。
      const outcome = res && res.notified
        ? t('settings.diag.outcomeSent')
        : t('settings.diag.outcomeNotSent', { reason: (res && res.detail) || t('settings.diag.outcomeUnknown') });
      setGeTestMsg(t('settings.diag.sentGlobal', { label: t('settings.diag.scenario.' + sc.key), note: t('settings.diag.scenarioNote.' + sc.key) }) + outcome);
    })),
    h('div', { style: { fontSize: 11, color: '#9aa0a6', marginTop: 4 } },
      t('settings.diag.globalScenarios', { list: TEST_GEO_SCENARIOS.map((x) => t('settings.diag.scenario.' + x.key)).join(' / ') })),
    geTestMsg ? h('div', { role: 'status', style: { color: '#93c5fd', fontSize: 11, marginTop: 4 } }, geTestMsg) : null,
    // 源状态：逐源的连接 / 增量 / 失败计数。它回答的是"哪条链路在动"，与关注了哪个国家无关。
    h(SourceStatusBlock, { key: 'source-status' }),
    // 诊断快照：界面上只做两件事——生成，以及在**剪贴板不可用时把文本显示出来**。
    h('div', { style: { marginTop: 12, borderTop: '1px solid rgba(148,163,184,0.18)', paddingTop: 10 } },
      h('div', { style: { fontSize: 11, color: '#9aa0a6' } },
        t('settings.diag.snapshotHint'))),
    s.row(s.btn(t('settings.diag.snapshotButton'), () => {
      copyDiagSnapshot().then((r) => setDiag({
        text: r.text,
        msg: r.ok
          ? (r.warning ? t('settings.diag.copiedWithWarning', { warning: r.warning }) : t('settings.diag.copied'))
          : (t('settings.diag.clipboardUnavailable') + (r.error ? t('settings.diag.clipboardError', { error: r.error }) : '') + t('settings.diag.copyManual')),
      })).catch((err) => setDiag({ text: '', msg: t('settings.diag.generatingFailed', { error: String((err && err.message) || err) }) }));
    })),
    h('div', { style: { fontSize: 11, color: '#d9a406', marginTop: 4 } },
      t('settings.diag.snapshotWarn')),
    diag ? h('div', { role: 'status', style: { color: '#93c5fd', fontSize: 11, marginTop: 4 } }, diag.msg) : null,
    diag && diag.text
      ? h('textarea', {
          readOnly: true, value: diag.text, rows: 10,
          onFocus: (e) => { try { e.target.select(); } catch (err) { /* 忽略 */ } },
          style: {
            width: '100%', boxSizing: 'border-box', marginTop: 6, fontSize: 11,
            fontFamily: 'ui-monospace, monospace', background: '#ffffff', color: '#1a1a1a',
            border: '1px solid #6b7280', borderRadius: 6, padding: 8,
          },
        })
      : null,
  );

  // 导入是**整体替换**：17-config-io 的 `importConfig` 会先把当前配置备份一份再写回，校验失败什么都不写；
  // 这里只负责把**错误码**翻成当前语言（17 不认识界面语言）。
  const cfgIoErrorText = (res) => {
    const map = {
      json: 'settings.configIo.errJson',
      shape: 'settings.configIo.errShape',
      format: 'settings.configIo.errFormat',
      version: 'settings.configIo.errVersion',
      newer: 'settings.configIo.errNewer',
      read: 'settings.configIo.errRead',
      'no-file': 'settings.configIo.errNoFile',
      'backup-failed': 'settings.configIo.errBackupFailed',
    };
    return t(own(map, res && res.error) || 'settings.configIo.errShape', { v: String((res && res.detail) || '') })
  };
  const onExportCfg = () => {
    const text = buildConfigExport(cfg);
    if (downloadConfigFile(text, configFileName())) {
      setCfgIoText('');
      setCfgIoMsg(t('settings.configIo.exported'));
    } else {
      // 沙箱 iframe 里 `URL.createObjectURL` 可能不可用：退回"显示出来让用户自己复制"（同诊断快照）。
      setCfgIoText(text);
      setCfgIoMsg(t('settings.configIo.exportFallback'));
    }
  };
  const onImportCfg = (file) => {
    readConfigFile(file).then((r) => {
      if (!r.ok) { setCfgIoMsg(cfgIoErrorText(r)); return }
      const res = importConfig(r.text);
      if (!res.ok) { setCfgIoMsg(cfgIoErrorText(res)); return }
      // 配置被**整体替换**了：组件里的 cfg 快照要跟着换，否则界面还显示导入前的关注点与阈值。
      setCfgState(currentCfg());
      // 地区页签只在挂载时推导过一次，此后只由页签按钮切换——导入（整体替换）后必须重算。
      setRegionTab(inferRegionTab(currentCfg()));
      setCfgIoBackupAt(res.backupAt);
      // 导入成功不等于"原样导入"：规整流程会丢弃坐标非法的关注点、把非数值的半径退回默认值，有账就如实补一句。
      const w = res.warnings || {};
      const parts = [];
      if (w.dropped > 0) parts.push(t('settings.configIo.importedSkipped', { n: w.dropped }));
      if (w.radiusFixed > 0) parts.push(t('settings.configIo.importedRadius', { n: w.radiusFixed }));
      if (w.citiesDropped > 0) parts.push(t('settings.configIo.importedCities', { n: w.citiesDropped }));
      setCfgIoMsg(parts.length
        ? t('settings.configIo.imported') + ' ' + parts.join(' ')
        : t('settings.configIo.imported'));
    }).catch((err) => {
      // 兜底：解析层的异常已在 17-config-io 转成错误码，但读文件仍可能抛；少了这个 catch，用户看到的是"点了没有任何反应"。
      setCfgIoMsg(t('settings.configIo.errUnexpected', { detail: String((err && err.message) || err) }));
    });
  };
  const onUndoCfg = () => {
    const res = undoConfigImport();
    if (!res.ok) { setCfgIoMsg(t('settings.configIo.noBackup')); return }
    setCfgState(currentCfg());
    // 撤销与导入一样是**整体替换**，地区页签必须跟着重算（否则选择器仍高亮导入后的分支）。
    setRegionTab(inferRegionTab(currentCfg()));
    // 撤销是一次性的：备份已被清掉，界面上的按钮与备份时间要跟着消失。
    setCfgIoBackupAt('');
    setCfgIoMsg(t('settings.configIo.undone'));
  };
  /** 复制当前导出文本（导出回退路径上的那一步）。剪贴板不可用时如实说。 */
  const onCopyCfg = () => {
    const text = cfgIoText || buildConfigExport(cfg);
    const ok = () => setCfgIoMsg(t('settings.configIo.copied'));
    const fail = () => setCfgIoMsg(t('settings.configIo.copyFailed'));
    try {
      const clip = (typeof navigator !== 'undefined' && navigator) ? navigator.clipboard : null;
      if (clip && typeof clip.writeText === 'function') {
        clip.writeText(text).then(ok).catch(fail);
        return
      }
    } catch (err) { /* 落到失败分支（沙箱 iframe / 权限被拒） */ }
    fail();
  };
  const sectionConfigIo = () => s.section(t('settings.configIo.title'),    h('div', { style: { fontSize: 11, color: '#9aa0a6', marginBottom: 6 } }, t('settings.configIo.hint')),
    s.row(
      s.btn(t('settings.configIo.exportBtn'), onExportCfg),
      s.btn(t('settings.configIo.importBtn'), () => { if (cfgIoFileRef.current) cfgIoFileRef.current.click(); }),
      // 「撤销上次导入」只在真的有备份时出现：一个点了只会说"没有可撤销的记录"的按钮比没有更让人以为出了问题。
      cfgIoBackupAt ? s.btn(t('settings.configIo.undoBtn'), onUndoCfg) : null,
    ),
    // 备份时间要**看得见**：备份跨会话保留，而"撤销"会把导入之后的所有改动整体回滚，用户需要判断要恢复的是多久之前的快照。
    cfgIoBackupAt ? h('div', { style: { fontSize: 11, color: '#9aa0a6', marginTop: 4 } },
      t('settings.configIo.undoAt', { at: formatIssuedLocal(cfgIoBackupAt) })) : null,
    h('input', {
      ref: cfgIoFileRef,
      type: 'file',
      accept: '.json,application/json',
      style: { display: 'none' },
      onChange: (e) => {
        const f = e.target.files && e.target.files[0];
        // 清空 value：否则连续导入**同一个文件**时 onChange 不会再触发（浏览器不会为同一个值重复派发 change）。
        e.target.value = '';
        if (f) onImportCfg(f);
      },
    }),
    cfgIoMsg ? h('div', { role: 'status', style: { color: '#93c5fd', fontSize: 11, marginTop: 4 } }, cfgIoMsg) : null,
    cfgIoText
      ? h('div', null,
        h('div', { style: { fontSize: 11, color: '#d9a406', marginTop: 6 } }, t('settings.configIo.exportFallback')),
        // 把"复制"真的做出来：此前文案说"请手动复制下面的文本"，却只有一个只读文本框。
        s.row(s.btn(t('settings.configIo.copyBtn'), onCopyCfg, { fontSize: 11 })),
        h('textarea', {
          readOnly: true, value: cfgIoText, rows: 8,
          onFocus: (e) => { try { e.target.select(); } catch (err) { /* 忽略 */ } },
          style: {
            width: '100%', boxSizing: 'border-box', marginTop: 6, fontSize: 11,
            fontFamily: 'ui-monospace, monospace', background: '#ffffff', color: '#1a1a1a',
            border: '1px solid #6b7280', borderRadius: 6, padding: 8,
          },
        }))
      : null,
  );

  const sectionDisclaimer = () => s.section(t('settings.section.disclaimer'),
    h('div', { style: { color: '#9aa0a6', fontSize: 11 } },
      t('settings.disclaimer.short')),
    fold(t('settings.disclaimer.foldTitle'),
      h('div', null, t('settings.disclaimer.source')),
      h('div', null, t('settings.disclaimer.authority'))));

  // 最近预警（点击条目展开详情；多条时可滚动）
  const sectionHistory = () => s.section(t('settings.section.history', { n: store.events.length }),
    h('div', { style: { fontSize: 11, color: '#9aa0a6', marginBottom: 6 } },
      t('settings.history.hint')),
    store.events.length === 0
      ? h('div', { style: { color: '#9aa0a6', fontSize: 12, padding: '4px 0' } }, t('settings.history.empty'))
      : h('div', { style: { maxHeight: 300, overflowY: 'auto', paddingRight: 4 } },
          store.events.slice(0, HISTORY_MAX).map((e, i) => {
            const itemKey = e.key || e.id || i;
            const open = expanded === itemKey;
            const toggle = () => setExpanded(open ? null : itemKey);
            const head = String(e.headline || '');
            const muted = e.hit === false || e.suppressed === true;
            const statusText = e.hit === false
              ? t('settings.history.statusHit')
              : (e.suppressed ? t('settings.history.statusSuppressed')
                : (e.pref ? t('settings.history.statusPrefHit', { pref: e.pref }) : t('settings.history.statusAlerted')));
            // 气象电文来自気象庁防災情報XML，没有 P2PQuake 的 code；旧写法会把泥石流 / 洪水电文标成「code 551」。
            const codeText = p2pCodeTextOf(e.kind, e.code, e.id);
            return h('div', {
              key: itemKey,
              // 可键盘操作：详情是用户核对"插件到底看到了什么"的唯一入口，只在 onClick 上可用等于把键盘用户挡在门外。
              role: 'button',
              tabIndex: 0,
              'aria-expanded': open,
              onClick: toggle,
              onKeyDown: (ev) => {
                if (ev.key === 'Enter' || ev.key === ' ' || ev.key === 'Spacebar') { ev.preventDefault(); toggle(); }
              },
              title: open ? t('settings.history.toggleCollapse') : t('settings.history.toggleExpand'),
              style: Object.assign({
                cursor: 'pointer',
                borderLeft: '3px solid ' + kindColorOf(e.kind),
                background: open
                  ? (muted ? 'rgba(148,163,184,0.16)' : 'rgba(59,130,246,0.22)')
                  : (muted ? 'rgba(148,163,184,0.05)' : 'rgba(148,163,184,0.09)'),
                borderRadius: 6, padding: '6px 10px', margin: '5px 0',
              }, open ? { boxShadow: 'inset 0 0 0 1px rgba(148,163,184,0.55)' } : null),
            },
              h('div', { style: { display: 'flex', gap: 8, alignItems: 'center' } },
                h('span', { style: { fontWeight: 700, fontSize: 12, color: kindColorOf(e.kind) } }, String(e.label || '')),
                h('span', { style: { fontSize: 11, border: '1px solid ' + (muted ? '#8b8f98' : '#4ade80'), color: muted ? '#8b8f98' : '#4ade80', borderRadius: 8, padding: '0 6px' } }, statusText),
                h('span', { style: { color: '#9aa0a6', fontSize: 11, marginLeft: 'auto', whiteSpace: 'nowrap' } }, open ? t('settings.history.collapse') : t('settings.history.expand'))),
              !open
                ? h('div', { style: { fontSize: 12, color: '#c8ccd4', marginTop: 3, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' } }, head)
                : h('div', { style: { fontSize: 12, marginTop: 6 } },
                    h('div', { style: { display: 'flex', gap: 6 } },
                      h('span', { style: { color: '#9aa0a6', width: 44 } }, t('settings.history.fieldKind')),
                      h('span', { style: { color: '#e6e6e8' } }, t('settings.history.kindValue', { label: String(e.label || ''), code: codeText }))),
                    h('div', { style: { display: 'flex', gap: 6, marginTop: 2 } },
                      h('span', { style: { color: '#9aa0a6', width: 44 } }, t('settings.history.fieldTime')),
                      // 按**本地时区**渲染：解析层存的是带偏移的 ISO 8601，直接显示原文会让大陆用户看到差 1 小时且无标注的 JST 时间。
                      h('span', { style: { color: '#e6e6e8' } }, formatIssuedLocal(e.issued) || '—')),
                    e.pref ? h('div', { style: { display: 'flex', gap: 6, marginTop: 2 } },
                      h('span', { style: { color: '#9aa0a6', width: 44 } }, t('settings.history.fieldPref')),
                      h('span', { style: { color: '#e6e6e8' } }, String(e.pref))) : null,
                    e.suppressedReason ? h('div', { style: { display: 'flex', gap: 6, marginTop: 2 } },
                      h('span', { style: { color: '#9aa0a6', width: 44 } }, t('settings.history.fieldNote')),
                      h('span', { style: { color: '#e6e6e8' } }, String(e.suppressedReason))) : null,
                    h('div', { style: { display: 'flex', gap: 6, marginTop: 2 } },
                      h('span', { style: { color: '#9aa0a6', width: 44 } }, t('settings.history.fieldContent')),
                      h('span', { style: { color: '#e6e6e8', flex: 1, wordBreak: 'break-all' } }, head)),
                    // 官方正文：NWS 的 description + instruction、ECCC 的正文 + 署名（许可要求署名）。
                    e.detail ? h('div', { style: { display: 'flex', gap: 6, marginTop: 4 } },
                      h('span', { style: { color: '#9aa0a6', width: 44, flexShrink: 0 } }, t('settings.history.fieldDetail')),
                      h('span', { style: { color: '#c8ccd4', flex: 1, whiteSpace: 'pre-wrap', wordBreak: 'break-word' } }, String(e.detail))) : null,
                  ),
            )
          }),
        ),
    s.row(s.btn(t('settings.history.clear'), () => {
      store.push({ events: [] });
      saveJSON(HISTORY_KEY, []);
      // 本页的"已播报"记忆也要清并写入本地存储：只清历史列表的话，同一条解除到达时本页仍会播「已解除」、别的标签页却写「无对应提醒」。
      forgetAllAlerted();
      // 还要广播：其它标签页的内存副本不清的话，它们下一次 addEvent 会把整份记录（含刚被清掉的条目）重新写回磁盘。
      broadcastHistoryCleared();
    })),
  );

  return h('div', { style: { fontFamily: 'system-ui, sans-serif', fontSize: 13, color: '#dfe3e8' } },
    statusStrip(),
    tabBar(),
    tab === 'region' ? sectionWatch() : null,
    tab === 'disaster' ? sectionDisasters() : null,
    tab === 'notify' ? h('div', null, sectionNotify(), sectionQuiet()) : null,
    tab === 'history' ? sectionHistory() : null,
    tab === 'misc' ? h('div', null, sectionSource(), sectionCnTransport(), sectionLanguage(), sectionConfigIo(), sectionDiagnostics(), sectionDisclaimer()) : null,
  )
}

// ============================================================================
// dsh-quake-alert · client/src/14-ui-status.js — 侧边栏底部的连接状态指示：状态圆点
// （绿=已连接 / 黄=连接或重连中 / 红=已停止）+ 悬停详情 + 无障碍标签。依赖 01-constants、07-store、00-i18n。
// ============================================================================


function StatusIndicator(props) {
  const [, setTick] = useState(0);
  useEffect(() => store.subscribe(() => setTick((n) => n + 1)), []);
  const meta = statusMetaOf(store.status, store.retries);
  const wide = Boolean(props && props.wide);
  // disabled（用户关掉了某个灾种）用空心圆点，与 stale / 未启动的实心灰区分开（六态表）。
  const dotStyle = store.status === 'disabled'
    ? { display: 'inline-block', width: 8, height: 8, borderRadius: '50%', background: 'transparent', border: '1.5px solid ' + meta.color, flex: '0 0 auto' }
    : { display: 'inline-block', width: 8, height: 8, borderRadius: '50%', background: meta.color, flex: '0 0 auto' };
  // 气象警报的静默提示：只有"命中关注地区但未达 L4、没有播报"时才存在（L4 以上播报后清掉）。
  const hint = store.weatherHint;
  const hintText = hint && typeof hint.level === 'number'
    ? t('status.weatherHint', { level: hint.level }) + (hint.label ? t('status.weatherHintLabel', { label: hint.label }) : '')
    : '';
  return h('div', {
    role: 'status',
    'aria-label': t('app.statusPrefix') + meta.text + hintText,
    title: t('app.statusPrefix') + meta.text + (store.detail ? ' · ' + store.detail : '') + hintText,
    style: { display: 'flex', alignItems: 'center', gap: 6, padding: wide ? '4px 8px' : '4px', fontSize: 12, color: 'inherit', cursor: 'default' },
  },
    h('span', { style: dotStyle }),
    wide ? h('span', { style: { whiteSpace: 'nowrap' } }, t('app.name')) : null)
}

// ============================================================================
// dsh-quake-alert · client/src/15-entry.js
// 作用：插件入口——apply 与单测钩子。注册音效解锁、跨标签页通道、settings 绑定、市区町村表、
//       各源客户端的启停、设置页与状态指示两个 slot，并导出 exports.__test。
// 依赖：全部前置文件。所有副作用都包在 ctx.effect 内，插件停用即回收。
// ============================================================================


const name = 'dsh-quake-alert';
const inject = ['slots'];
function apply(ctx) {
  // 音效解锁：首次用户手势创建/恢复 AudioContext（自动播放策略标准解法）
  ctx.effect(() => {
    const unlock = () => { try { unlockAudio(); } catch (err) {} };
    window.addEventListener('pointerdown', unlock, { passive: true });
    window.addEventListener('keydown', unlock, { passive: true });
    return () => {
      window.removeEventListener('pointerdown', unlock);
      window.removeEventListener('keydown', unlock);
    }
  }, 'dsh-quake-alert: audio unlock');

  // 跨标签页去重通道：必须在插件加载时就开始监听，否则会错过其它标签页的广播。
  // ensure 与 close 同处一个 effect（effect 体在 apply 时**同步执行**），两代 fiber 不能共享同一条通道。
  ctx.effect(() => {
    ensureAlertChannel();
    return () => { closeAlertChannel(); }
  }, 'dsh-quake-alert: tab channel');

  // 插件（重新）装载时清空上一代的**连接**状态：残留状态会把新会话显示成"已连接"。
  // 数据健康不清（已写入本地存储，表达的是"上游改了字段、要等插件更新"，与刷新页面 / 重新启用无关）。
  store.clearSources();
  resetConnHealth();
  // 立刻重新发布已升级的数据健康：store 刚被清空而蓝点存在 localStorage 里，不重发要等该源下一轮上报才显示。
  republishDataHealth();

  // 健康自检：按 SOURCE_CONTRACTS 里的阈值判定各源的数据新鲜度并驱动蓝点 TTL 自愈。放进 effect
  // 是因为它有定时器（定时器归 fiber）。sourceEnabled 是「这个源现在开着吗」的唯一映射：关掉的源不判 stale。
  const sourceEnabled = (id) => {
    const d = (currentCfg().disasters) || {};
    if (id === 'jma') return d.weather !== false
    if (id === 'usgs' || id === 'cenc_eew' || id === 'cenc_eqlist') return d.earthquake !== false
    if (id === 'noaa') return d.tsunami !== false
    if (id === 'nmc_alarm') return d.cnRainstorm !== false || d.cnGeology !== false
    if (id === 'nws_alerts' || id === 'eccc_alerts') return d.overseasWeather !== false
    return true
  };
  ctx.effect(() => {
    const probe = createHealthProbe({ sourceEnabled });
    probe.start();
    return () => { try { probe.stop(); } catch (err) { /* 已停 */ } }
  }, 'dsh-quake-alert: health probe');

  // 机器级持久化：settings 服务可用时配置交给 DSH 的机器级存储，服务缺席（或页面非 loopback）时保持 localStorage。
  // 两代宿主的读写入口是两个不同的服务（03-settings-bridge 只认"快照 + 写入"）：旧宿主走 settingsScope.bind({ namespace })，
  // 新宿主走 configForms.get(entryId)；两者都 ctx.inject 等待，先到者胜（bound 守卫）。
  if (typeof ctx.inject === 'function') {
    let bound = false;
    const bindHostSettings = (resolveScope, label) => {
      if (bound) return
      let unbind = null;
      try {
        const scope = resolveScope();
        if (!scope) return
        unbind = bindSettingsScope(scope);
        bound = true;
      } catch (err) { /* bind 失败 → 继续用 localStorage */ }
      // 订阅必须随 fiber 释放：否则同一页面内停用 → 启用 N 次会累积 N 个订阅，此后 Host 每次配置变更都触发 N 次写入本地存储与重渲。
      if (bound && typeof unbind === 'function' && typeof ctx.effect === 'function') {
        ctx.effect(() => () => { try { unbind(); } catch (err) { /* 忽略 */ } }, 'dsh-quake-alert: ' + label + ' unbind');
      }
    };
    // 命名空间就是本插件在 profile 里的条目 id（与 cordis.patch.yml 的 `- id:` 一致），与 Host 侧 Config schema 同名。
    ctx.inject(['configForms'], (settingsCtx) => {
      const forms = settingsCtx.configForms;
      if (!forms || typeof forms.get !== 'function') return
      bindHostSettings(() => forms.get(SETTINGS_NS), 'configForms');
    });
    // 旧宿主回退路径：新宿主下这个服务永远不出现，回调不会执行。
    ctx.inject(['settingsScope'], (settingsCtx) => {
      const scope = settingsCtx.settingsScope;
      if (!scope || typeof scope.bind !== 'function') return
      bindHostSettings(() => scope.bind({ namespace: SETTINGS_NS }), 'settingsScope');
    });
  }

  // 跨标签页配置同步：storage 事件只在「别的标签页写入」时触发，监听必须常驻（写在设置页组件里会让没打开
  // 设置页的标签页不跟随）。回读走 03 的显式入口（跨模块不能直接给它私有的 runtimeCfg 赋值），再 store.push()。
  ctx.effect(() => {
    const onStorage = (e) => {
      if (!e || e.key === null || e.key === STORAGE_KEY) {
        reloadFromLocal();
        store.push({});
      }
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage)
  }, 'dsh-quake-alert: cross-tab config');

  // 市区町村表：Host 路由提供，拉一次缓存；失败只影响市级细化，不影响任何提醒。放进 effect 以便飞行中停用时中止请求。
  ctx.effect(() => {
    loadCityTable();
    return () => { try { abortCityTableLoad(); } catch (err) {} }
  }, 'dsh-quake-alert: city table');

  // WebSocket 常驻连接（与设置页是否打开无关）。start() 必须写在 effect 内：若同一 apply 后面的注册抛错，连接也要
  // 随 fiber 收掉，否则会留下没有清理器的 socket。onRaw 走解析契约：结构不符 / 值不可能 → 计入数据健康且**不播报**；
  // 与本插件无关的消息（其他 code）判为 empty、静静跳过。
  const client = createWsClient({
    onRaw: (raw, cfg) => {
      const res = parseEpspResult(raw);
      if (noteParseResult('p2pquake', res)) return
      if (!res.ok) return
      noteSourceSuccess('p2pquake');
      handleAlert(res.alert, cfg);
    },
  });
  setActiveClient(client);
  ctx.effect(() => {
    client.start();
    return () => {
      try { client.stop(); } catch (err) {}
      // 置空：否则设置页里 80ms 后触发的 restart() 还能复活一个已无 fiber 归属的 socket，它会继续上报状态并响铃。
      setActiveClient(null);
    }
  }, 'dsh-quake-alert: ws client');

  /** 轮询源的状态上报：把每个源的连接 / 失败情况经 publishStatus 合成后送进 store（12b 自己也用结果做去重键）。 */
  const feedStatus = (sourceId) => (patch) => publishStatus(sourceId, patch);
  const feedError = (name) => (err) => {
    try { console.warn('[dsh-quake-alert] ' + name + ' 请求失败：' + String((err && err.message) || err)); } catch (e) {}
  };

  // 気象庁电文增量：Host 侧负责轮询与去重，这里只拉本地增量并交给主链。
  const feed = createFeedClient({
    id: 'jma',
    label: '気象庁',
    onStatus: feedStatus('jma'),
    onError: feedError('jma'),
  });
  // 全球地震（USGS）：Host 轮询 GeoJSON，Client 只拉本地增量。与 EMSC 互补（EMSC 是实时推送，USGS
  // 目录更完整、还带修订版），两者的同类地震靠 geoEventKey 归并，不会重复提醒。
  const usgsFeed = createFeedClient({
    id: 'usgs',
    label: 'USGS',
    path: FEED_PATH + '?source=usgs',
    cursorKey: FEED_CURSOR_KEY + '.usgs',
    enabled: (cfg) => (cfg.disasters || {}).earthquake !== false,
    onStatus: feedStatus('usgs'),
    onError: feedError('usgs'),
    apply: (entry, cfg) => {
      let feature;
      try { feature = JSON.parse(entry && entry.xml); } catch (err) {
        noteParseResult('usgs', failResult('schema', 'Host 载荷不是合法 JSON'));
        return false
      }
      const res = parseUsgsResult(feature);
      if (noteParseResult('usgs', res)) return false
      if (!res.ok) return false
      noteSourceSuccess('usgs');
      handleAlert(res.alert, cfg);
      return true
    },
  });
  // 海啸（NOAA）：Host 拉事件列表再取 CAP 详情，Client 解析 CAP。
  const noaaFeed = createFeedClient({
    id: 'noaa',
    label: 'NOAA',
    path: FEED_PATH + '?source=noaa',
    cursorKey: FEED_CURSOR_KEY + '.noaa',
    intervalMs: 5 * 60 * 1000,
    enabled: (cfg) => (cfg.disasters || {}).tsunami !== false,
    onStatus: feedStatus('noaa'),
    onError: feedError('noaa'),
    apply: (entry, cfg) => {
      const res = parseNoaaResult(entry && entry.xml, { id: entry && entry.id });
      if (noteParseResult('noaa', res)) return false
      if (!res.ok) return false
      noteSourceSuccess('noaa');
      handleAlert(res.alert, cfg);
      return true
    },
  });
  // 大陆气象灾害（CMA）：中央气象台汇总的预警信号（暴雨 + 地质灾害），走 Host 的 `/feed` **轮询**，
  // 延迟最坏 120+15 秒。两个灾种各有开关，但**共用一个 Host 源**（同端点、同响应），只要有一个开着就继续拉。
  const nmcFeed = createFeedClient({
    id: 'nmc_alarm',
    label: 'CMA',
    path: FEED_PATH + '?source=nmc_alarm',
    cursorKey: FEED_CURSOR_KEY + '.nmc_alarm',
    enabled: (cfg) => {
      const d = cfg.disasters || {};
      return d.cnRainstorm !== false || d.cnGeology !== false
    },
    onStatus: feedStatus('nmc_alarm'),
    onError: feedError('nmc_alarm'),
    apply: (entry, cfg) => {
      let raw;
      try {
        raw = JSON.parse(entry && entry.xml);
      } catch (err) {
        noteParseResult('nmc_alarm', failResult('schema', 'Host 载荷不是合法 JSON'));
        return false
      }
      const res = parseNmcAlarmResult(raw);
      if (noteParseResult('nmc_alarm', res)) return false
      if (!res.ok) return false
      noteSourceSuccess('nmc_alarm');
      handleAlert(res.alert, cfg);
      return true
    },
  });
  const feeds = [feed, usgsFeed, noaaFeed, nmcFeed];
  ctx.effect(() => {
    for (const f of feeds) f.start();
    return () => { for (const f of feeds) { try { f.stop(); } catch (err) {} } }
  }, 'dsh-quake-alert: feed clients');

  // 大陆源：Wolfx 的 cenc_eew（预警）+ cenc_eqlist（速报），走 Host 的 **SSE 推送**（EEW 的价值在秒级）；
  // 12c 在"能证明长连接走不通"时自动切到 `?source=` 轮询并把降级状态说出来。两者都跟「地震」开关，只有速报另有**震级门槛**。
  const cencApply = (sourceId, parseEntry) => (entry, cfg) => {
    let raw;
    try {
      raw = JSON.parse(entry && entry.xml);
    } catch (err) {
      noteParseResult(sourceId, failResult('schema', 'Host 载荷不是合法 JSON'));
      return false
    }
    const res = parseEntry(raw);
    if (noteParseResult(sourceId, res)) return false
    if (!res.ok) return false
    noteSourceSuccess(sourceId);
    handleAlert(res.alert, cfg);
    return true
  };
  const cnEnabled = (cfg) => (cfg.disasters || {}).earthquake !== false;
  const cencEew = createCnStream({
    id: 'cenc_eew',
    label: 'CENC EEW',
    enabled: cnEnabled,
    onStatus: feedStatus('cenc_eew'),
    onError: feedError('cenc_eew'),
    apply: cencApply('cenc_eew', parseCencEewResult),
  });
  const cencEqlist = createCnStream({
    id: 'cenc_eqlist',
    label: 'CENC eqlist',
    enabled: cnEnabled,
    onStatus: feedStatus('cenc_eqlist'),
    onError: feedError('cenc_eqlist'),
    apply: cencApply('cenc_eqlist', parseCencEqlistItemResult),
  });
  ctx.effect(() => {
    cencEew.start();
    cencEqlist.start();
    return () => { for (const c of [cencEew, cencEqlist]) { try { c.stop(); } catch (err) {} } }
  }, 'dsh-quake-alert: cn streams');

  // 海外气象：美国 NWS 与加拿大 ECCC，**Client 直连的外部 REST**（CORS 允许），按关注点查询、
  // 不判停更、年龄门槛在首轮生效。两个源各自只对"落在对应国家包围盒内的关注点"发请求，不需要
  // 额外开关；灾种开关（overseasWeather）关掉时连请求都不发。
  const nwsSource = createNwsSource({
    onStatus: feedStatus('nws_alerts'),
    onError: feedError('nws_alerts'),
  });
  const ecccSource = createEcccSource({
    onStatus: feedStatus('eccc_alerts'),
    onError: feedError('eccc_alerts'),
  });
  ctx.effect(() => {
    // 清掉上一代的计数快照：overseasStatsOf 与 feedStatsOf 都是模块级的，插件重建后到首个轮询
    // 完成前，设置页与诊断会显示上一代的数字与 `running: true`。
    for (const k of Object.keys(overseasStatsOf)) delete overseasStatsOf[k];
    for (const k of Object.keys(feedStatsOf)) delete feedStatsOf[k];
    nwsSource.start();
    ecccSource.start();
    return () => { for (const s of [nwsSource, ecccSource]) { try { s.stop(); } catch (err) {} } }
  }, 'dsh-quake-alert: overseas pollers');

  // 全球地震：EMSC 的 WebSocket，复用与 P2PQuake 同一套连接管理（重试间隔递增、建连超时监控、生命周期归还 fiber）。
  // staleAfterMs 取 3 小时（远大于正常推送间隔）：建连超时监控在 onopen 后即撤销，没有它连接可以永久停在绿色上。
  const emsc = createWsClient({
    sourceId: 'emsc',
    label: 'EMSC',
    urlOf: () => EMSC_WS_URL,
    staleAfterMs: 3 * 60 * 60 * 1000,
    openDetail: () => t('status.emscConnected'),
    onRaw: (raw, cfg) => {
      const res = parseEmscResult(raw);
      if (noteParseResult('emsc', res)) return
      if (!res.ok) return
      noteSourceSuccess('emsc');
      handleAlert(res.alert, cfg);
    },
  });
  ctx.effect(() => {
    emsc.start();
    return () => { try { emsc.stop(); } catch (err) {} }
  }, 'dsh-quake-alert: EMSC ws client');

  // 设置页：设置 → 灾害预警
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'quake-alert',
    order: 60,
    label: () => t('app.name'),
  }, (props) => h(SettingsPanel, { close: props ? props.close : undefined })));

  // 侧边栏底部状态指示（绿/黄/红圆点，悬停显示详情）
  ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
    name: 'sidebar.footer.action',
    id: 'quake-alert-status',
    order: 50,
    label: () => t('app.name'),
  }, (props) => h(StatusIndicator, props || {})));
}

// 单测钩子（客户端宿主忽略额外导出）
const __test = {
  // 本地化机制（语言清单 / BCP 47 回退链 / 取词 / 文案表）
  LANGS, DEFAULT_LANGUAGE, LANGUAGE_LABELS, resolveLang, setLanguage, getLanguage, t, tableOf,
  // 配置导出导入（格式标识 / 校验 / 导入前备份 / 撤销）
  buildConfigExport, parseConfigImport, importConfig, undoConfigImport, loadConfigBackup, configFileName,
  CONFIG_FORMAT, CONFIG_FORMAT_VERSION,
  // 机制层（统一健康记录 + 自检 + 升级阈值）
  createHealthProbe, staleAfterOf, PROBE_INTERVAL_MS,
  resetConnHealth, pruneHealth, noteFreshness, noteStale, loadHealth, publishStatus, republishDataHealth,
  SCHEMA_ESCALATE_COUNT, SCHEMA_ESCALATE_CONSECUTIVE, SCHEMA_ESCALATE_WINDOW_MS, HEALTH_TTL_MS,
  // 大陆气象源（nmc.cn）：解析层 / 契约 / 行政区层级匹配
  parseNmcAlarm, orgOf, parseNmcAlarmResult, matchCnAreaAlert, cnPlaceParts, cnWatchPlaces, cnAreaOf, normAliases,
  NMC_KIND_TEXT, NMC_LEVEL_TEXT, NMC_LEVEL_RANK, NMC_BROADCAST_MIN_RANK,
  // 海外气象源（美国 NWS / 加拿大 ECCC）：解析层 / 契约 / 事件键 / 白名单；取数器按关注点查询、查询即匹配、年龄门槛
  parseNwsAlert, parseEcccAlert, parseNwsAlertResult, parseEcccAlertResult,
  ecccKindTextOf, nwsEventKeyOf, nwsVtecKeyOf, ecccEventKeyOf, NWS_EVENT_WHITELIST, nwsKindTextOf, nwsKindTextMap,
  NWS_SEVERITY, NWS_SEV_RANK, ECCC_COLOUR_SEVERITY, ECCC_COLOUR_RANK, ECCC_INCLUDE, ECCC_EXCLUDE,
  OVERSEAS_BROADCAST_MIN_RANK,
  createNwsSource, createEcccSource, nwsSamplePoints, ecccBboxOf, placesInBoxes, US_BOXES, CA_BOX, defaultFetchText, matchOverseasAlert,
  NWS_ALERTS_BASE, ECCC_ALERTS_BASE, NWS_EVENT_QUERY,
  MIN_SAMPLE_RADIUS_KM, MAX_REQUESTS_PER_ROUND, OVERSEAS_FRESH_GATE_MS, OVERSEAS_GATE_RESET_MS,
  UNCOVERED_TTL_MS, OVERSEAS_MIN_BACKOFF_MS, OVERSEAS_MAX_BACKOFF_MS,
  overseasStatsOf, defaultFetchText,
  parse, parseQuake, parseEew, parseTsunami, parseJma, parseEmsc, parseUsgsFeature, parseNoaaCap, severityOfMagnitude, geoEventKey, TEST_GEO_SCENARIOS, buildTestGlobalMessage, parseTestGlobalMessage, feedStatsOf, watchlessPoint, buildTestTelegram, TEST_SCENARIOS, jmaMaxLevelIn: maxLevelIn, jmaItemsOf: itemsOf, noticeAreaLevels, applyNoticeLevels, regionKindOf, matchAlert, matchPointAlert, distanceKm, validGeo, normalizePlaces, soundKindOf, soundAllowedFor, playSound, sevColor, p2pCodeTextOf, kindColorOf, alertTitleOf, prefsOfArea, regionsOfArea, AREA_PREF, loadCfg, normalizeCfg, loadHistory, normalizeHistoryEntry, addEvent, withinHistoryAge, handleRaw, handleCancelled, handleAlert, updateWeatherHint, WEATHER_EVENT_WINDOW_MINUTES, hitSeverityOf, createFeedClient, FEED_PATH, FEED_POLL_MS, FEED_CURSOR_KEY, FEED_TAIL, createCnStream, cnStreamRegistry, STREAM_PATH, CN_CURSOR_KEY, cnProductName, authorityOf, disclaimerOf, weatherActionHintOf, SOURCE_ORDER, sourceLabelOf, SOURCE_CODE_TEXT, SettingsPanel, statusMetaOf, buildDiagSnapshot, copyDiagSnapshot, DIAG_SNAPSHOT_VERSION, inQuietHours, placeOriginOf, PLACE_ORIGINS, geoOfHypo, sourceIdOf, crossSourceCopyOf, noteAuthoritySuppressed, authorityStatsOf, SOURCE_RANK, sourceNameOf, SOURCE_AGENCY, agencyOf, CROSS_SOURCE_KINDS, rankOfSource, sourceZhOf, alertedEvents, isDuplicate, isEventRepeat, isStrengthUpgrade, weakenEvent, forgetEvent, forgetAllAlerted, claimAlertForTab, cancelKeyOf, rememberAlerted, wasRecentlyAlerted, ensureAlertChannel, broadcastHistoryCleared, createWsClient, store, HISTORY_MAX, HISTORY_MAX_AGE_MS, LEGACY_PLACE_RADIUS_KM, requestNotificationPermission, PREFECTURES, prefLabelOf, PREF_EN, PREF_HANT, SCALE_OPTIONS, TSUNAMI_OPTIONS, GLOBAL_MAG_OPTIONS, DEFAULT_CFG, STORAGE_KEY, currentCfg, applyCfg, reloadFromLocal, bindSettingsScope, settingsOpsFor, cfgToSection, sectionToCfg, SETTINGS_NS, settingsState, resetSettings, setCityTable, citiesOfPref, prefsOfCity, canonicalCityOf, normKana, setRiverAreas, riverAreaCities, cityAliases, lookupAddrCity, buildAddrIndex, normalizePref, prefOfCode, prefCodeOf, pruneUnknownCities, pruneCitiesOfUnwatchedPrefs, loadCityTable, abortCityTableLoad, cityTableState: () => cityTableState, cnAreasStateOf, retryCityTable, resetCityTable, setCnAreas, cnProvinces, cnCitiesOf, cnPlaceOf, setWorldCountries, worldCountriesOf, countryNameOf, countryPackOf, loadCountryCities, resetWorldCities, RADIUS_PRESETS, DEFAULT_PLACE_RADIUS_KM, MIN_PLACE_RADIUS_KM, MAX_PLACE_RADIUS_KM, p2pTimeToIso, cnTimeToIso, CN_TIME_RE, CN_REPORT_MAG_OPTIONS, LANGUAGE_OPTIONS, issuedToDate, formatIssuedLocal, audioState, SOURCE_CONTRACTS, parseEpspResult, parseEmscResult, parseUsgsResult, parseNoaaResult, parseJmaResult, parseCencEewResult, parseCencEqlistItemResult, parseCencEqlistResult, parseCencEew, parseCencEqlist, parseCencEqlistItem, cencEqlistItems, cencEqlistMd5Of, failResult, noteParseResult, noteSourceSuccess, retrySource, sourceHealthOf, effectiveStatusOf, resetSourceHealth, P2P_TIME_RE, MIGRATED_KEY };

exports.__test = __test;
exports.apply = apply;
exports.inject = inject;
exports.name = name;

return module.exports;
} });
