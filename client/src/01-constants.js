// ============================================================================
// dsh-quake-alert · client/src/01-constants.js
//
// 作用：唯一的常量与默认配置来源（React 依赖也在这里引入）。
// 内容：震度文案与档位、海啸等级与排序、47 都道府县表、简写→全称映射、
//       默认配置 DEFAULT_CFG、存储 key、重连参数、历史上限等全部共享常量。
// 依赖：无（本文件必须最先拼接）。
// 新增常量请优先放这里，避免散落到各功能文件里。
// ============================================================================

// ---------- 依赖 ----------
import React from 'react'
const h = React.createElement
const { useState, useEffect, useRef } = React

// ---------- 常量 ----------
const WS_URL = 'wss://api.p2pquake.net/v2/ws'
const SANDBOX_URL = 'wss://api-realtime-sandbox.p2pquake.net/v2/ws'
// 全球地震（0.4.0）：EMSC 的实时推送通道。它是少数提供 WebSocket 的全球地震源
// （USGS / GDACS 都只有轮询），因此在全球链路上复用与 P2PQuake 相同的连接管理。
const EMSC_WS_URL = 'wss://www.seismicportal.eu/standing_order/websocket'
const STORAGE_KEY = 'dsh.quakeAlert.v1'
const HISTORY_KEY = 'dsh.quakeAlert.history'
const HISTORY_MAX = 30 // 「最近预警」保留条数（内存与设置页展示）
const MAX_WATCH_CITIES = 300 // 关注市区町村上限（防止配置与 UI 被撑爆）
// 全球关注点上限：每个点带名字、经纬度与半径，几十个点就足够覆盖"我住哪、家人在哪"，
// 再多说明用法不对（那是一张地图，不是一份关注列表）。
const MAX_WATCH_PLACES = 20
const RECONNECT_BASE = 1000 // 指数退避起点 1s
const RECONNECT_MAX = 60000 // 封顶 60s

const SCALE_TEXT = {
  10: '震度1', 20: '震度2', 30: '震度3', 40: '震度4',
  45: '震度5弱', 46: '震度5弱以上', 50: '震度5强', 55: '震度6弱',
  60: '震度6强', 70: '震度7',
}
// 用户可选的最低震度档位（值 = P2PQuake scale 数值）
const SCALE_OPTIONS = [
  { v: 10, label: '震度1 以上' }, { v: 20, label: '震度2 以上' }, { v: 30, label: '震度3 以上' },
  { v: 40, label: '震度4 以上' }, { v: 45, label: '震度5弱 以上' }, { v: 50, label: '震度5强 以上' },
  { v: 55, label: '震度6弱 以上' }, { v: 60, label: '震度6强 以上' }, { v: 70, label: '震度7' },
]
const TSUNAMI_RANK = { Watch: 1, Warning: 2, MajorWarning: 3 }
const TSUNAMI_GRADE_TEXT = { Watch: '津波注意报', Warning: '海啸警报', MajorWarning: '大海啸警报' }
const TSUNAMI_OPTIONS = [
  { g: 'Watch', label: '注意报及以上' }, { g: 'Warning', label: '警报及以上' }, { g: 'MajorWarning', label: '仅大海啸警报' },
]
// 全球源（EMSC / USGS）的最低震级。全球目录里 M2.5+ 每天近百条，而用户真正关心的是
// "我这附近有没有明显晃动"——M4.5 是全球速报的常用门槛，默认取它。
const GLOBAL_MAG_OPTIONS = [
  { v: 3, label: 'M3.0 以上' }, { v: 3.5, label: 'M3.5 以上' }, { v: 4, label: 'M4.0 以上' },
  { v: 4.5, label: 'M4.5 以上（默认）' }, { v: 5, label: 'M5.0 以上' }, { v: 5.5, label: 'M5.5 以上' },
  { v: 6, label: 'M6.0 以上' }, { v: 6.5, label: 'M6.5 以上' }, { v: 7, label: 'M7.0 以上' },
]

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
].map(([jp, zh]) => ({ jp, zh }))
const PREF_SET = new Set(PREFECTURES.map((p) => p.jp))
// 都道府県コード → 都道府県名。PREFECTURES 的顺序就是 JIS 码 01..47（01 北海道 … 47 沖縄県），
// 気象庁电文里的区域码前两位正是都道府県码：细分区 宗谷北部=011011、市町村 北九州市=4010000。
// 判县因此优先用 code 而不是名称——名称有 25 例同名跨县（伊達市 北海道/福島県、川崎町 宮城県/福岡県…），
// 且已改制的旧名会把历史电文里的区域认到别的县（福岡県「那珂川町」曾落到栃木県那珂川町）。
const PREF_BY_CODE = {}
PREFECTURES.forEach((p, i) => { PREF_BY_CODE[String(i + 1).padStart(2, '0')] = p.jp })
/** 区域码 → 都道府県名（取前两位；认不出返回空字符串）。 */
function prefOfCode(code) {
  const s = String(code === undefined || code === null ? '' : code).trim()
  if (!/^\d{4,}$/.test(s)) return ''
  const hit = PREF_BY_CODE[s.slice(0, 2)]
  return hit || ''
}
/** 都道府県名 → 2 位都道府県码（认不出返回空字符串）。测试电文按关注地区构造时用。 */
function prefCodeOf(pref) {
  const i = PREFECTURES.findIndex((p) => p.jp === pref)
  return i === -1 ? '' : String(i + 1).padStart(2, '0')
}
// 都道府県简写 → 全称：551 的 points[].pref 通常是全称，但实测直播数据里出现过「京都」
// 这类简写，不归一就会与用户勾选的「京都府」永不相等（静默漏报）。
const PREF_SHORT = {}
for (const p of PREFECTURES) {
  const short = p.jp.replace(/[都道府県]$/, '')
  if (short !== p.jp && !Object.prototype.hasOwnProperty.call(PREF_SHORT, short)) PREF_SHORT[short] = p.jp
}
function normalizePref(raw) {
  const s = String(raw === undefined || raw === null ? '' : raw).trim()
  if (!s || PREF_SET.has(s)) return s
  return Object.prototype.hasOwnProperty.call(PREF_SHORT, s) ? PREF_SHORT[s] : s
}

const DEFAULT_CFG = {
  version: 1,
  source: 'prod', // prod | sandbox（沙箱回放 2023 年历史，约30秒/条，测试用）
  // 两种关注模式并存：
  //   · 行政区（prefectures / cities）——日本源（P2PQuake、気象庁）用，粒度到市区町村
  //   · 坐标点（places）——全球源（EMSC / USGS / NOAA）用，判定方式是「震中距 ≤ radiusKm」
  // 两者互不影响：日本用户不用配 places，全球用户不用配 prefectures。
  watch: { prefectures: [], cities: [], places: [] },
  disasters: { earthquake: true, tsunami: true, weather: true }, // weather = 气象灾害（泥石流 / 洪水 / 大雨 / 高潮…），固定 L4 以上播报
  // globalMagnitude：全球源（EMSC / USGS）的最低震级。日本源用的是震度（quakeScale），
  // 全球源只有震级——实测 EMSC 会推 M3.8 级别的事件，若沿用"来什么报什么"会明显吵闹。
  thresholds: { quakeScale: 40, eewScale: 45, tsunamiGrade: 'Watch', globalMagnitude: 4.5 },
  notify: { sound: true, system: true, volume: 0.7 },
  dedupe: { windowMinutes: 10 },
  // 静默时段（0.2.0）：按浏览器本地时间判定；跨午夜用 start > end 表示（如 23:00–07:00）
  quietHours: { enabled: false, start: '23:00', end: '07:00', breakForSevere: true },
}


export { React, h, useState, useEffect, useRef, WS_URL, SANDBOX_URL, EMSC_WS_URL, STORAGE_KEY, HISTORY_KEY, HISTORY_MAX, MAX_WATCH_CITIES, MAX_WATCH_PLACES, RECONNECT_BASE, RECONNECT_MAX, SCALE_TEXT, SCALE_OPTIONS, TSUNAMI_RANK, TSUNAMI_GRADE_TEXT, TSUNAMI_OPTIONS, GLOBAL_MAG_OPTIONS, PREFECTURES, PREF_SET, PREF_SHORT, PREF_BY_CODE, prefOfCode, prefCodeOf, normalizePref, DEFAULT_CFG }
