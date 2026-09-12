// ============================================================================
// dsh-quake-alert · client/src/05b-jma-parser.js
//
// 作用：把気象庁防災情報XML 的电文解析成与 P2PQuake 同一套内部模型（Alert），
//       让 551/552/556 之外的气象警报（泥石流 / 洪水 / 大雨 / 高潮…）能走同一条主链。
// 内容：Report 结构提取、警戒レベル判定、区域展开（市町村 / 河川予報区域 / 府県予報区）、
//       中文灾害标签、解除判定、事件键。
// 依赖：01-constants、02-storage（own）、04-city-table（市町村反查 / 河川区域表）、
//       05-parser（prefsOfArea）。
//
// 关键事实（均来自 JMA 官方样本实测，样本见 samples/jma-*.xml）：
//   · 警戒レベル写在 <Kind><Name> 里（「レベル４大雨危険警報」「レベル２土砂災害注意報」），
//     或写在 <Head><Headline><Text> 里（「【警戒レベル２相当情報［洪水］】」）——是读出来的，不是推算的。
//   · 指定河川洪水予報（VXKO）的 Kind 名称不带数字（「氾濫注意情報」「氾濫危険情報」），
//     等级要按名称映射；它的区域是**河川予報区域**（12 位代码），必须先经 river-areas 表
//     映射到市町村才能与用户关注比对。
//   · 土砂災害警戒情報（VXWW50）本身就是警戒レベル4 相当，Kind 只有 警戒 / 解除 / なし。
//   · 解除与发布共用同一条电文类型，靠 <Kind> 的 Status / Condition 区分。
// ============================================================================

import { prefOfCode, prefCodeOf } from './01-constants.js'
import { own } from './02-storage.js'
import { prefsOfCity, canonicalCityOf, riverAreaCities } from './04-city-table.js'
import { prefsOfArea } from './05-parser.js'

const LEVEL_DIGITS = { '１': 1, '２': 2, '３': 3, '４': 4, '５': 5, '1': 1, '2': 2, '3': 3, '4': 4, '5': 5 }
// 指定河川洪水予報：Kind 名称 → 警戒レベル（新体系的四个等级）
const FLOOD_KIND_LEVEL = {
  '氾濫注意情報': 2, '氾濫注意報': 2,
  '氾濫警報': 3,
  '氾濫危険情報': 4,
  '氾濫発生情報': 5,
}
// 解除 / 无内容：这些 Kind 不代表"正在发布某种警报"
const INACTIVE_KIND = /^(解除|なし|発表警報・注意報はなし)$/

/**
 * 旧格式电文的 Kind 名称 → 警戒レベル（0.3.4 修复漏报）。
 *
 * R06 新格式把级别写在名称里（「レベル４大雨危険警報」），旧格式只写名称
 * （「大雨特別警報」「大雨警報」「大雨注意報」）。此前 levelOf() 只认「レベルＮ」字样，
 * 于是**不带级别数字的旧格式电文被整体丢弃**（parseJma 返回 null）——包括最高级别的特别警报。
 * 实测证据（2026-09-07 東京都「大雨特別警報」，见 samples/jma-vpww53-tokyo-special-20260907.xml）：
 * 同一事件的三条电文 VPWW53 / VPWW54 / VPNO50 全部返回 null，插件该事件完全静默；
 * 而同一时刻的 R06 电文只有「その他注意報 / 暴風 / 波浪」，不含这条特别警报。
 * 也就是说：旧格式不是"迟早会被 R06 覆盖的副本"，它是部分时刻唯一的内容载体。
 *
 * 语义依据：気象庁的警报体系里 特別警報 > 危険警報(=L4) > 警報(=L3) > 注意報(=L2)。
 * 注意報级（2）**刻意不返回**：同一次发布往往同时以 VPWW53 与（Ｈ２７）两份副本出现，
 * 把 L2 也抬升等于让历史被同一份注意報的两份副本刷屏；而 L2 本就不播报。
 * R06 的「レベル２」仍照旧解析入历史，行为不变。
 */
function legacyKindLevel(name) {
  const s = String(name || '')
  if (!s) return 0
  if (/特別警報/.test(s)) return 5
  if (/危険警報/.test(s)) return 4
  if (/警報/.test(s) && !/注意報/.test(s)) return 3
  return 0
}
// 电文标题 → 中文标签（M3 才做 i18n，这里与既有 kindLabel 一样先硬编码中文）
const KIND_LABELS = [
  [/土砂災害警戒情報/, '泥石流警戒情报'],
  [/指定河川洪水予報/, '洪水预报'],
  [/（大雨）|[（(]浸水/, '大雨警报'],
  [/（土砂）/, '泥石流警报'],
  [/（洪水）/, '洪水警报'],
  [/（高潮）/, '风暴潮警报'],
  [/（暴風）/, '暴风警报'],
  [/（波浪）/, '海浪警报'],
  [/（雷）/, '雷击警报'],
  [/（濃霧）/, '浓雾警报'],
  [/（乾燥）/, '干燥警报'],
  [/（なだれ）/, '雪崩警报'],
  [/気象特別警報/, '气象特别警报'],
  [/気象警報・注意報/, '气象警报'],
]

// ---------- 最小 XML 取值工具（与 05-parser 的正则风格一致，不引依赖） ----------
const decode = (s) => String(s)
  .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&')
function block(scope, tagName) {
  const m = new RegExp('<' + tagName + '(?:\\s[^>]*)?>([\\s\\S]*?)</' + tagName + '>').exec(scope)
  return m ? m[1] : ''
}
function tag(scope, tagName) {
  const m = new RegExp('<' + tagName + '(?:\\s[^>]*)?>([\\s\\S]*?)</' + tagName + '>').exec(scope)
  return m ? decode(m[1]).trim() : ''
}
// 文本里出现的最大警戒レベル（全角 / 半角数字都认）
function maxLevelIn(text) {
  let max = 0
  for (const m of String(text).matchAll(/レベル\s*([１-５1-5])/g)) {
    const n = own(LEVEL_DIGITS, m[1]) || 0
    if (n > max) max = n
  }
  return max
}

// ---------- 电文拆分 ----------
// 取值时用 (?:^|\s) 防止 codeType 被 type 的规则误命中。
const attrOf = (attrs, name) => {
  const m = new RegExp('(?:^|\\s)' + name + '="([^"]*)"').exec(String(attrs || ''))
  return m ? m[1] : ''
}

/**
 * 区域类型判定：优先看 codeType，缺失或不可辨时按**代码位数**兜底。
 * 实测位数：市町村 7 位（北九州市 4010000）／府県予報区・細分区域 6 位（宗谷地方 011000）／
 * 河川予報区域 12 位（天塩川 810101000100）。
 * 这条兜底是必需的：気象庁在 Body 的 <Warning> 里常把区域写成**裸 <Area>**（不带
 * <Areas codeType="..."> 包裹），VXWW50 就是这样——只认 codeType 会一个区域都取不到，
 * 表现为"解析成功但 regions 为空"，等于静默漏报。
 */
function regionKindOf(codeType, code) {
  const ct = String(codeType || '')
  if (/市町村/.test(ct)) return 'city'
  if (/予報区域/.test(ct)) return 'river'
  if (/府県予報区|細分区域/.test(ct)) return 'pref'
  const c = String(code || '')
  if (/^\d{12}$/.test(c)) return 'river'
  if (/^\d{7}$/.test(c)) return 'city'
  if (/^\d{6}$/.test(c)) return 'pref'
  return ''
}

/**
 * 提取电文里的 (Kind, 区域) 条目。
 * 按 <Warning type="…"> / <Information type="…"> 容器切块，块内 Item 继承该 type 作为 codeType；
 * 容器内的 <Areas codeType="…"> 优先，没有则退回 Item 里的裸 <Area>。
 * 传入**全文**（而不是只传 Body）：市町村清单常只出现在 Head 的 <Information> 里。
 */
function itemsOf(scope) {
  const out = []
  const containers = []
  for (const m of String(scope).matchAll(/<(Warning|Information)([^>]*)>([\s\S]*?)<\/\1>/g)) {
    containers.push({ type: attrOf(m[2], 'type'), body: m[3] })
  }
  if (containers.length === 0) containers.push({ type: '', body: String(scope) })
  const AREA = /<Area>\s*<Name>([^<]*)<\/Name>\s*<Code>([^<]*)<\/Code>[\s\S]*?<\/Area>/g
  for (const c of containers) {
    for (const im of c.body.matchAll(/<Item>([\s\S]*?)<\/Item>/g)) {
      const raw = im[1]
      const kindBlock = block(raw, 'Kind')
      const item = {
        codeType: c.type,
        kindName: tag(kindBlock, 'Name'),
        kindCode: tag(kindBlock, 'Code'),
        status: tag(kindBlock, 'Status') || tag(kindBlock, 'Condition'),
        areas: [],
      }
      const wrapped = [...raw.matchAll(/<Areas([^>]*)>([\s\S]*?)<\/Areas>/g)]
      if (wrapped.length) {
        for (const am of wrapped) {
          const ct = attrOf(am[1], 'codeType') || c.type
          for (const a of am[2].matchAll(AREA)) {
            item.areas.push({ codeType: ct, name: decode(a[1]).trim(), code: a[2].trim() })
          }
        }
      } else {
        for (const a of raw.matchAll(AREA)) {
          item.areas.push({ codeType: c.type, name: decode(a[1]).trim(), code: a[2].trim() })
        }
      }
      out.push(item)
    }
  }
  return out
}

/**
 * 判定电文整体的警戒レベル：取自 Kind 名称、Headline 文本、标题，三者取最大。
 * 指定河川洪水予報另按 Kind 名称映射；土砂災害警戒情報固定为 4（它本身就是 L4 相当）。
 */
function levelOf({ title, headTitle, headlineText, items }) {
  let level = 0
  for (const it of items) {
    if (INACTIVE_KIND.test(it.kindName)) continue
    const inName = maxLevelIn(it.kindName)
    if (inName > level) level = inName
    const mapped = own(FLOOD_KIND_LEVEL, it.kindName) || 0
    if (mapped > level) level = mapped
    const legacy = legacyKindLevel(it.kindName)
    if (legacy > level) level = legacy
  }
  for (const s of [headlineText, headTitle, title]) {
    const n = maxLevelIn(s)
    if (n > level) level = n
  }
  if (level === 0 && /土砂災害警戒情報/.test(title)) level = 4
  // 「気象特別警報報知」是气象厅为特別警報专发的最高优先级报知电文；正常情况它的 Kind 名称
  // 就是「大雨特別警報」（已被上面的映射接住），这里只是 Kind 缺失时的兜底。
  // 必须排除"整条电文都是解除"的情况：解除报知的 Kind 是「解除」（循环里被 continue 跳过），
  // 若不排除，标题兜底会把一条解除消息抬成 L5，headline 会显示成「警戒レベル5（已解除）」。
  const allInactive = items.length > 0 && items.every((it) => INACTIVE_KIND.test(it.kindName))
  if (level === 0 && !allInactive && /気象特別警報報知/.test(title)) level = 5
  return level
}

/**
 * 区域展开：一律归到「都道府県 + 市町村」两层，查不到归属县就标记 prefUnknown（放行）。
 *
 * 市町村名必须换成**本表的规范写法**（canonicalCityOf）再放进 region.city：用户勾选的
 * 市町村名来自市区町村表，而电文与河川区域表给的是外部写法（「南アルプス市」vs 本表
 * 「南あるぷす市」、「金ケ崎町」vs「金け崎町」），直接比对会漏报。取不到规范名时回退原写法。
 */
function regionsOf(items) {
  const out = []
  const seen = new Set()
  const push = (region) => {
    const key = region.pref + '|' + (region.city || '') + '|' + region.area
    if (seen.has(key)) return
    seen.add(key)
    out.push(region)
  }
  for (const it of items) {
    if (INACTIVE_KIND.test(it.kindName) || INACTIVE_KIND.test(it.status)) continue
    for (const a of it.areas) {
      const kind = regionKindOf(a.codeType, a.code)
      if (kind === 'city' || kind === 'pref') {
        const city = kind === 'city' ? (canonicalCityOf(a.name) || a.name) : ''
        // 判县优先用区域码前两位（准确），名称反查只在前者不可用时兜底
        const byCode = prefOfCode(a.code)
        if (byCode) {
          push({ pref: byCode, area: a.name, city })
          continue
        }
        const prefs = kind === 'city' ? prefsOfCity(a.name) : prefsOfArea(a.name)
        if (prefs.length === 0) push({ pref: '', area: a.name, city, prefUnknown: true })
        else for (const p of prefs) push({ pref: p, area: a.name, city })
      } else if (kind === 'river') {
        // 河川予報区域码是 12 位，前两位与都道府県无关，只能查 river-areas 表
        const cities = riverAreaCities(a.code)
        if (cities.length === 0) push({ pref: '', area: a.name, city: '', prefUnknown: true })
        else {
          for (const raw of cities) {
            const c = canonicalCityOf(raw) || raw
            const prefs = prefsOfCity(c)
            if (prefs.length === 0) push({ pref: '', area: a.name, city: c, prefUnknown: true })
            else for (const p of prefs) push({ pref: p, area: a.name, city: c })
          }
        }
      }
      // 判不出类型的条目（水位観測所等）一律忽略
    }
  }
  return out
}

function kindLabelOf(title) {
  for (const [re, label] of KIND_LABELS) if (re.test(title)) return label
  return title || '气象警报'
}

/**
 * 汇总型电文：同一次发布会有 2〜3 份**不同格式的副本**同时出现在 feed 里
 * （实测 2026-09-07 東京都特別警報：VPWW53「気象特別警報・警報・注意報」、
 * VPWW54「気象警報・注意報（Ｈ２７）」、VPNO50「気象特別警報報知」，时间戳 13:57:52〜54）。
 * 它们的 title / headTitle 各不相同，而気象警報・注意報 的 EventID 又是空的——
 * 若沿用「标题」做事件键，同一条警报会被当成三个事件、连响三次铃。
 */
const SUMMARY_TITLE = /気象特別警報・警報・注意報|気象警報・注意報（Ｈ２７）|気象特別警報報知/
// 灾种关键词（顺序 = 优先级无关，按最高级别的 Kind 名称匹配具体灾种）
const HAZARD_KEYS = [
  [/大雨|浸水/, '大雨'], [/土砂/, '土砂'], [/洪水|氾濫/, '洪水'], [/高潮/, '高潮'],
  [/暴風/, '暴風'], [/波浪/, '波浪'], [/雷/, '雷'], [/濃霧/, '濃霧'],
  [/乾燥/, '乾燥'], [/なだれ/, 'なだれ'], [/大雪|着雪/, '大雪'],
]
/** 取级别最高的那条 Kind 名称，再从中提取灾种——副本之间只要最高级条目相同就会得到同一个键。 */
function hazardKeyOf(items) {
  let name = ''
  let best = -1
  for (const it of items) {
    if (INACTIVE_KIND.test(it.kindName)) continue
    const lv = Math.max(legacyKindLevel(it.kindName), own(FLOOD_KIND_LEVEL, it.kindName) || 0, maxLevelIn(it.kindName))
    if (lv > best) { best = lv; name = it.kindName }
  }
  for (const [re, key] of HAZARD_KEYS) if (re.test(name)) return key
  return name || '气象'
}

/**
 * 解析一条 JMA 电文。返回 null 表示这条电文与本插件无关（天气预报、地震火山、观测资料等）。
 * @param {string} xml 详情电文原文
 * @param {{ id?: string }} [entry] Host 侧 feed 条目（用于给 Alert 一个稳定 id）
 * @returns {object|null} Alert
 */
function parseJma(xml, entry) {
  const text = String(xml || '')
  if (!text || text.indexOf('<Report') === -1) return null
  const control = block(text, 'Control')
  const head = block(text, 'Head')

  const title = tag(control, 'Title') || tag(head, 'Title')
  const headTitle = tag(head, 'Title')
  const headlineText = tag(block(head, 'Headline'), 'Text')
  const eventId = tag(head, 'EventID')
  // 用**全文**提取条目：市町村清单常只出现在 Head 的 <Information> 里（Body 的 <Warning>
  // 反而只有摘要），只看 Body 会取不到区域。重复条目由 regionsOf 去重兜住。
  const items = itemsOf(text)

  const level = levelOf({ title, headTitle, headlineText, items })
  const cancelled = items.length > 0 &&
    items.every((it) => INACTIVE_KIND.test(it.kindName) || INACTIVE_KIND.test(it.status))
  // 没有级别又不是解除 → 与预警无关（天气预报、观测资料等），交给调用方丢弃
  if (level === 0 && !cancelled) return null

  const regions = cancelled ? [] : regionsOf(items)
  // 解除电文若展开不出区域，至少保留一个空区域条目，让事件键与提示仍可工作
  const kindLabel = kindLabelOf(title)
  const first = String(headlineText || '').split(/[。\n]/)[0].trim()
  const levelText = level > 0 ? '（警戒レベル' + level + '）' : ''
  const headline = (kindLabel + levelText + (first ? ' · ' + first : '')).slice(0, 180)
  // 事件键：优先 EventID，其次 Head 标题。汇总型电文（同时存在多份格式副本）改用**内容指纹**
  // ——「灾种 + 发布时刻(分钟) + 府县码」——否则同一条警报会因副本标题不同而被当成三个事件、连响三次。
  // 指纹里的府县码取电文 id 的后缀，而不是 regions[0]：解除电文的 regions 恒为空，
  // 用 regions 会让解除与发布算出不同的键，handleCancelled 就找不到"此前提醒过的事件"，
  // 解除提醒会静默丢失（与 0.1.3 加入的取消链路冲突）。
  const idSuffix = /([0-9]{6})\.xml$/.exec(String((entry && entry.id) || ''))
  const eventKey = SUMMARY_TITLE.test(title)
    ? 'jma:summary:' + hazardKeyOf(items) + ':' +
      String(tag(control, 'DateTime') || tag(head, 'ReportDateTime') || '').slice(0, 16) + ':' +
      (idSuffix ? idSuffix[1] : '')
    : 'jma:' + (eventId || headTitle || title)

  return {
    id: (entry && entry.id) || eventId || title,
    code: 'jma',
    kind: 'weather',
    kindLabel: cancelled ? kindLabel + '（已解除）' : kindLabel,
    severity: level >= 4 ? 'red' : (level === 3 ? 'orange' : (level === 2 ? 'yellow' : 'info')),
    issued: tag(head, 'ReportDateTime') || tag(control, 'DateTime'),
    headline,
    level,
    maxScale: level,
    hypo: { name: '', magnitude: null },
    regions: regions.length ? regions : [],
    eventKey,
    strength: level,
    cancelled,
    raw: { title, headTitle, eventId, infoType: tag(head, 'InfoType'), serial: tag(head, 'Serial') },
  }
}

/**
 * 测试电文场景。按顺序轮换，覆盖链路上不同的分支：
 *   · 级别落点不同：Kind 名称里（大雨 / 高潮 / L3 土砂）／电文标题本身即 L4（土砂災害警戒情報）／
 *     Headline 主文里（指定河川洪水予報）
 *   · 区域粒度不同：市町村级 / 府県予報区级
 *   · 边界两侧：L4（播报）与 L3（不播报，只记历史与侧边栏提示）
 */
export const TEST_SCENARIOS = [
  { key: 'landslide', label: '泥石流警戒情报', note: '市町村级 / 电文本身即 L4' },
  { key: 'flood', label: '指定河川洪水予報（氾濫危険情報）', note: '级别写在主文里' },
  { key: 'heavyrain', label: '大雨危険警報', note: '级别写在 Kind 名称里' },
  { key: 'stormsurge', label: '高潮危険警報', note: '级别写在 Kind 名称里' },
  { key: 'landslide-l3', label: '泥石流警報（警戒レベル3）', note: '未达 L4：不播报' },
]

function testXml(o) {
  const stamp = new Date(o.ms).toISOString()
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

/**
 * 构造一条**测试用**电文（不联网、不经过 Host 轮询）——设置页的「发送测试气象警报」
 * 按钮用它走完整链路，让用户在无灾情时也能确认提醒与音效长什么样。
 *
 * 区域挂在"用户关注的第一个都道府县"下：若写死一个县，关注别处的用户点下去会被匹配挡掉、
 * 什么都不发生，反而以为插件坏了；用关注列表首项才能保证走通。没选任何县（全日本模式）时
 * 退回東京都。判县只看区域码前两位，所以这里用县码拼出的码就足够。
 *
 * id 与 EventID 都带时间戳与场景名：否则第二条会被消息级去重挡住，或被事件级去重当成
 * "强度未升级的重复发布"而只记历史、不播报——连点两次就没反应了。
 *
 * @param {string} pref 都道府县名（关注列表首项）
 * @param {number} nowMs 时间戳
 * @param {string} [key] TEST_SCENARIOS 里的 key，默认 landslide
 * @param {string} [cityName] 市町村级场景用的市町村名（表未加载时可省略，退回县名）
 */
function buildTestTelegram(pref, nowMs, key, cityName) {
  const p = pref || '東京都'
  const pc = prefCodeOf(p) || '13'
  const ms = nowMs || Date.now()
  const scenario = key || 'landslide'
  const eventId = 'QUAKEALERT-TEST-' + scenario + '-' + ms
  const base = { ms, eventId }
  const city = cityName || ''
  if (scenario === 'flood') {
    return testXml(Object.assign(base, {
      controlTitle: '指定河川洪水予報',
      headTitle: p + '指定河川洪水予報（テスト）',
      headlineText: '【警戒レベル４相当情報［洪水］】' + p + 'のテスト川では、氾濫危険水位に到達しています' +
        '（这是一条测试警报，不是真实灾情）。',
      infoType: '指定河川洪水予報',
      kindName: '氾濫危険情報', kindCode: '40',
      codeType: '気象情報／府県予報区・細分区域等',
      areaName: p, areaCode: pc + '0000',
    }))
  }
  if (scenario === 'heavyrain' || scenario === 'stormsurge') {
    const isSurge = scenario === 'stormsurge'
    const kind = isSurge ? '高潮危険警報' : '大雨危険警報'
    const field = isSurge ? '高潮' : '大雨'
    return testXml(Object.assign(base, {
      controlTitle: '気象警報・注意報（Ｒ０６）（' + field + '）',
      headTitle: p + field + '警報・注意報（テスト）',
      headlineText: p + 'にレベル４' + kind + 'を発表しています（这是一条测试警报，不是真实灾情）。',
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
      headlineText: p + 'にレベル３土砂災害警報を発表しています（这是一条测试警报，不是真实灾情）。',
      infoType: '気象警報・注意報（府県予報区等）',
      kindName: 'レベル３土砂災害警報', kindCode: '03',
      codeType: '気象情報／府県予報区・細分区域等',
      areaName: p, areaCode: pc + '0000',
    }))
  }
  // 默认：土砂災害警戒情報（电文本身就是警戒レベル4 相当，区域是市町村）
  return testXml(Object.assign(base, {
    controlTitle: '土砂災害警戒情報',
    headTitle: p + '土砂災害警戒情報（テスト）',
    headlineText: '【警戒レベル４相当情報［土砂災害］】' + p + city +
      'では、土砂災害が発生するおそれが高まっています（这是一条测试警报，不是真实灾情）。',
    infoType: '土砂災害警戒情報',
    kindName: '警戒', kindCode: '3',
    codeType: '気象・地震・火山情報／市町村等',
    areaName: city || p, areaCode: pc + '00000',
  }))
}


export { parseJma, buildTestTelegram, maxLevelIn, itemsOf, regionsOf, levelOf, kindLabelOf, FLOOD_KIND_LEVEL, INACTIVE_KIND }
