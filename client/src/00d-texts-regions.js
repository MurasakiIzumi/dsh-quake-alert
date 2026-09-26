// ============================================================================
// dsh-quake-alert · client/src/00d-texts-regions.js
//
// 作用：日本 47 都道府县的**显示名**表（英文字幕）。
// 内容：纯数据对象，不 import 任何模块。
// 依赖：无。
//
// 为什么要单独一份：`01-constants` 的 `PREFECTURES` 只有两个字段——`jp`（匹配用日文全称，
// P2PQuake 的 pref 就是这个形状）与 `zh`（中文界面显示名）。**匹配永远用 `jp`**，而显示名
// 是随界面语言变的：日文界面直接用 `jp` 原文，中文界面用 `zh`，英文界面需要罗马字。
//
// 为什么不把英文名塞进 `PREFECTURES`：那个数组的每一项都参与匹配（`PREF_SET` / `PREF_SHORT`
// 都从它派生），往里加字段等于让"显示"渗进"匹配"的数据结构——0.8.0 把来源分支显式化时
// 踩过一次同类问题（拿名字形状当判据）。
//
// 罗马字按**平文式**（Hepburn 以外交/地图惯用的通行拼法）：`Gifu` / `Hyogo` / `Kochi`，
// 不使用 `Gihu` / `Hyôgo` 这类带长音的写法——县名在关注列表里要短、要能一眼认出。
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
}

export { PREF_EN }
