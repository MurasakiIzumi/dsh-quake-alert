// ============================================================================
// dsh-quake-alert · client/src/05b-jma-parser.js
// 作用：気象庁防災情報XML 电文 → 与 P2PQuake 同套 Alert，让气象警报（泥石流 / 洪水 / 大雨 / 高潮…）走同一条主链；
//       依赖 01-constants、02-storage（own）、04-city-table（市町村反查 / 河川区域表）、05-parser（prefsOfArea）、00-i18n。
// 契约：警戒レベル是**读**出来的（<Kind><Name>「レベル４大雨危険警報」或 <Headline><Text>「【警戒レベル２相当情報［洪水］】」），不推算。
// ============================================================================

import { prefOfCode, prefCodeOf } from './01-constants.js'
import { t } from './00-i18n.js'
import { own } from './02-storage.js'
import { prefsOfCity, canonicalCityOf, riverAreaCities, normKana } from './04-city-table.js'
import { prefsOfArea } from './05-parser.js'

const LEVEL_DIGITS = { '１': 1, '２': 2, '３': 3, '４': 4, '５': 5, '1': 1, '2': 2, '3': 3, '4': 4, '5': 5 }
// 指定河川洪水予報（VXKO）：Kind 名称不带级别数字（「氾濫注意情報」…），等级按名称映射
const FLOOD_KIND_LEVEL = {
  '氾濫注意情報': 2, '氾濫注意報': 2,
  '氾濫警報': 3,
  '氾濫危険情報': 4,
  '氾濫発生情報': 5,
}
// 解除 / 无内容：这些 Kind 不代表"正在发布某种警报"；解除与发布共用同一条电文类型，靠 Name / Status 区分
const INACTIVE_KIND = /^(解除|なし|発表警報・注意報はなし)$/

// 旧格式（R06 前）电文的 Kind 名称 → 警戒レベル：特別警報 5 / 危険警報 4 / 警報 3，注意報一律 0。
// 旧格式不带「レベルＮ」字样，只认数字会把最高级的特別警報整条丢掉（parseJma 返回 null），所以必须按
// 名称语义兜底。注意報返回 0 是电文级的刻意取值：L2 本就不播报，抬成 2 会让同一份注意報的两份副本
// （VPWW53 与（Ｈ２７））把历史刷屏；逐区级别另算（见 regionKindLevel）。
function legacyKindLevel(name) {
  const s = String(name || '')
  if (!s) return 0
  if (/特別警報/.test(s)) return 5
  if (/危険警報/.test(s)) return 4
  if (/警報/.test(s) && !/注意報/.test(s)) return 3
  return 0
}
// **地区级**级别：与 legacyKindLevel 的唯一差别是注意報给 2。地区级必须给出 2，否则该地区会**回退到
// 电文最大值**——一条含危険警報（L4）的电文里，只到「大雨注意報」的市町村会被播成「警戒レベル4」。
function regionKindLevel(name) {
  const s = String(name || '')
  if (!s) return 0
  if (/特別警報/.test(s)) return 5
  if (/危険警報/.test(s)) return 4
  if (/注意報/.test(s)) return 2
  if (/警報/.test(s)) return 3
  return 0
}
/** 解除 / 无内容：这些 Kind 不代表"正在发布某种警报"（Name 与 Status 任一命中即算）。 */
const isInactiveItem = (it) => !!it && (INACTIVE_KIND.test(it.kindName) || INACTIVE_KIND.test(it.status))
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
]

// ---------- 最小 XML 取值工具（纯正则，不引依赖） ----------
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

// 区域类型判定：优先看 codeType，缺失或不可辨时按**代码位数**兜底（实测：市町村 7 位／府県予報区・
// 細分区域 6 位／河川予報区域 12 位）。兜底是必需的：気象庁在 Body 的 <Warning> 里常把区域写成
// **裸 <Area>**（VXWW50 就是），只认 codeType 会一个区域都取不到，表现为"解析成功但 regions 为空"。
function regionKindOf(codeType, code) {
  const ct = String(codeType || '')
  if (/市町村/.test(ct)) return 'city'
  if (/予報区域/.test(ct)) return 'river'
  if (/府県予報区|細分区域/.test(ct)) return 'pref'
  // 显式给出 codeType 但不在上面的集合里 → 判未知，不按位数猜：放宽 <Area> 匹配后会摄入 `水位観測所`
  // 这类非行政区域，位数兜底会把码长恰好 6/7 位的它们变成幻影的府県予報区 / 市町村区域。
  if (ct) return ''
  const c = String(code || '')
  if (/^\d{12}$/.test(c)) return 'river'
  if (/^\d{7}$/.test(c)) return 'city'
  if (/^\d{6}$/.test(c)) return 'pref'
  return ''
}

// 提取电文里的 (Kind, 区域) 条目：按 <Warning type> / <Information type> 容器切块，块内 Item 继承该
// type 作为 codeType；容器内的 <Areas codeType> 优先，没有则退回 Item 里的裸 <Area>。
// 传入**全文**（而不是只传 Body）：市町村清单常只出现在 Head 的 <Information> 里。
function itemsOf(scope) {
  const out = []
  const containers = []
  for (const m of String(scope).matchAll(/<(Warning|Information)([^>]*)>([\s\S]*?)<\/\1>/g)) {
    containers.push({ type: attrOf(m[2], 'type'), body: m[3] })
  }
  if (containers.length === 0) containers.push({ type: '', body: String(scope) })
  // 按块取 <Area>（属性可有可无、Name/Code 可缺一）：原写法要求 <Area> 紧跟 <Name> 再 <Code>，带属性的
  // <Area codeType="…">、子元素顺序不同或只有 Name 的条目都会被静默丢弃 → regions 为空 → 不播报。
  // codeType 先看 <Area> 自身的属性，再退回容器 / 外层。
  const AREA = /<Area(\s[^>]*)?>([\s\S]*?)<\/Area>/g
  const areasIn = (blockText, fallbackType) => {
    const list = []
    for (const a of String(blockText).matchAll(AREA)) {
      const name = tag(a[2], 'Name')
      const code = tag(a[2], 'Code')
      if (!name && !code) continue
      list.push({ codeType: attrOf(a[1], 'codeType') || fallbackType, name, code })
    }
    return list
  }
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
          for (const a of areasIn(am[2], ct)) item.areas.push(a)
        }
      } else {
        for (const a of areasIn(raw, c.type)) item.areas.push(a)
      }
      out.push(item)
    }
  }
  return out
}

// 判定电文整体的警戒レベル：Kind 名称、Headline 文本、标题三者取最大。指定河川洪水予報另按 Kind 名称
// 映射；土砂災害警戒情報固定 4（它本身就是 L4 相当）。
function levelOf({ title, headTitle, headlineText, notice, items, inactiveScope }) {
  let level = 0
  for (const it of items) {
    // 用 isInactiveItem（Name 或 Status 任一命中即算解除）：只看 Name 会把"Status=解除、Name 仍是灾种名"的条目算进级别。
    if (isInactiveItem(it)) continue
    // 电文级刻意不含注意報的 2（理由见 legacyKindLevel）；逐区级别另算（见 itemLevelOf）。
    const inName = maxLevelIn(it.kindName)
    if (inName > level) level = inName
    const mapped = own(FLOOD_KIND_LEVEL, it.kindName) || 0
    if (mapped > level) level = mapped
    const legacy = legacyKindLevel(it.kindName)
    if (legacy > level) level = legacy
  }
  // 除标题与主文之外还必须读 **<Body><Notice>**：Ｒ０６ 総合副本（VPWW53/54）把多灾种多级别合并成一条，
  // Kind 只写灾种名，地区级级别只出现在 Notice 里（［危険警報・氾濫特別警報の発表状況］〈レベル４大雨危険警報〉姫路市…）；
  // 不读它，整条真实存在的 L4 危険警報会被判成 L3 而不播报。
  for (const s of [headlineText, notice, headTitle, title]) {
    const n = maxLevelIn(s)
    if (n > level) level = n
  }
  // 有些电文只在主文里写〈危険警報（大雨、土砂災害）〉而不带「レベルＮ」：危険警報固定是 L4 相当，
  // 按语义兜底。**必须要求它出现在〈…〉条目里**：Notice 的栏目名固定写作「［危険警報・氾濫特別警報の
  // 発表状況］」，用裸 /危険警報/ 会把每一条带该 Notice 的电文都抬成 L4。
  const dangerItem = /〈[^〉]*危険警報/.test(String(headlineText || '') + ' ' + String(notice || ''))
  if (level < 4 && dangerItem) level = 4
  if (level === 0 && /土砂災害警戒情報/.test(title)) level = 4
  // 「気象特別警報報知」是特別警報的报知电文，Kind 缺失时按标题兜底为 L5；**必须排除整条都是解除**的
  // 情况（解除报知的 Kind 是「解除」，循环里被跳过），否则一条解除消息会被抬成 L5，headline 显示成
  // 「警戒レベル5（已解除）」。口径必须与 cancelled 相同——只看 Body 副本（见 parseJma）：JMA 常把
  // 解除写在 <Status> 里而 Name 为空，且 Head 的摘要副本根本没有 Status。
  const scope = inactiveScope || items
  const allInactive = scope.length > 0 && scope.every(isInactiveItem)
  if (level === 0 && !allInactive && /気象特別警報報知/.test(title)) level = 5
  return level
}

// 从 <Body><Notice> 解析「级别 → 地区名列表」：〈レベル４大雨危険警報〉姫路市　たつの市　多可町＊
// ——全角空格分隔，`＊` 表示列表不完整，所以只做**精确提升**：列出的地区提升到该级别，没列出的仍按
// 自己的 Kind 判定（R06 分灾种副本带精确的逐区级别，会照常播报那些地区）。解析不出来返回空表，调用方回退电文级别。
function noticeAreaLevels(notice) {
  const text = String(notice || '')
  if (!text || text.indexOf('レベル') === -1) return []
  const out = []
  const push = (digit, listText) => {
    const level = own(LEVEL_DIGITS, digit) || 0
    if (level <= 0) return
    const names = String(listText)
      .split(/[\s\u3000、,，]+/)
      // 去掉尾随的省略标记：半角的 `*` 也会粘在最后一个地区名上，只排除全角 `＊` 会漏掉那个唯一的 L4 城市。
      .map((s) => s.replace(/[*＊※…]+$/g, '').trim())
      .filter(Boolean)
    if (names.length) out.push({ level, names })
  }
  // 形态 A：〈レベル４大雨危険警報〉姫路市　たつの市　多可町＊ —— 级别标记到 〉限在同一行、限长 40 字：
  // 原来的 `[^〉]*` 会跨段一直吃到后面某段的 〉，把级别错配到别的市町村（误报与漏报同时发生）。
  // 地区列表用 `[\s\S]{0,300}?` + 前瞻到 `〈` / `］` / 结尾：允许跨行，但不会吞进下一段。
  for (const m of text.matchAll(/レベル\s*([１-５1-5])[^〉\n]{0,40}〉([\s\S]{0,300}?)(?=〈|］|$)/g)) push(m[1], m[2])
  // 形态 B：［警戒レベル４相当情報の発表状況］\n姫路市　たつの市 —— 级别写在**栏目名**里，地区列表紧随其后。
  for (const m of text.matchAll(/［[^］\n]*レベル\s*([１-５1-5])[^］]*］([\s\S]{0,300}?)(?=〈|［|$)/g)) push(m[1], m[2])
  return out
}
/** 把 Notice 里的地区级级别套到 regions 上（名称经假名写法对齐后比较差异）。只在更高时提升。 */
function applyNoticeLevels(regions, notice) {
  const pairs = noticeAreaLevels(notice)
  if (pairs.length === 0) return regions
  for (const r of regions) {
    const own1 = normKana(r.city || '')
    const own2 = normKana(r.area || '')
    for (const p of pairs) {
      let hit = false
      for (const n of p.names) {
        const k = normKana(n)
        if ((own1 && own1 === k) || (own2 && own2 === k)) { hit = true; break }
      }
      if (hit && p.level > (r.level || 0)) r.level = p.level
    }
  }
  return regions
}

// 区域展开：一律归到「都道府県 + 市町村」两层，查不到归属县就标记 prefUnknown（放行）。市町村名必须换成
// 本表的规范写法（canonicalCityOf）：用户勾选的名字来自市区町村表，而电文与河川区域表给的是外部写法
// （「南アルプス市」vs 本表「南あるぷす市」、「金ケ崎町」vs「金け崎町」），直接比对会漏报；取不到规范名时回退原写法。
function regionsOf(items, notice, opts) {
  const includeInactive = !!(opts && opts.includeInactive)
  const out = []
  const at = new Map() // 区域键 → out 下标：同一区域重复出现时保留更高的级别
  const push = (region, level) => {
    const key = region.pref + '|' + (region.city || '') + '|' + region.area
    const idx = at.get(key)
    if (idx !== undefined) {
      if (level > (out[idx].level || 0)) out[idx].level = level
      return
    }
    at.set(key, out.length)
    out.push(level > 0 ? Object.assign({ level }, region) : region)
  }
  for (const it of items) {
    if (!includeInactive && isInactiveItem(it)) continue
    // 逐区级别由这条 Item 自己的 Kind 决定，**不能用电文最大值**（同一次发布里各区级别可以不同）。
    const lv = itemLevelOf(it)
    for (const a of it.areas) {
      const kind = regionKindOf(a.codeType, a.code)
      if (kind === 'city' || kind === 'pref') {
        const city = kind === 'city' ? (canonicalCityOf(a.name) || a.name) : ''
        // 判县优先用区域码前两位（准确），名称反查只在前者不可用时兜底
        const byCode = prefOfCode(a.code)
        if (byCode) {
          push({ pref: byCode, area: a.name, city }, lv)
          continue
        }
        const prefs = kind === 'city' ? prefsOfCity(a.name) : prefsOfArea(a.name)
        if (prefs.length === 0) push({ pref: '', area: a.name, city, prefUnknown: true }, lv)
        else for (const p of prefs) push({ pref: p, area: a.name, city }, lv)
      } else if (kind === 'river') {
        // 河川予報区域码是 12 位，前两位与都道府県无关，只能查 river-areas 表
        const cities = riverAreaCities(a.code)
        if (cities.length === 0) push({ pref: '', area: a.name, city: '', prefUnknown: true }, lv)
        else {
          for (const raw of cities) {
            const c = canonicalCityOf(raw) || raw
            const prefs = prefsOfCity(c)
            if (prefs.length === 0) push({ pref: '', area: a.name, city: c, prefUnknown: true }, lv)
            else for (const p of prefs) push({ pref: p, area: a.name, city: c }, lv)
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
  const src = String(title || '')
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
const SUMMARY_TITLE = /気象特別警報・警報・注意報|気象警報・注意報（Ｈ２７）|気象警報・注意報（Ｒ０６）|気象特別警報報知/
// 灾种关键词（按最高级别的 Kind 名称匹配具体灾种）
const HAZARD_KEYS = [
  [/大雨|浸水/, '大雨'], [/土砂/, '土砂'], [/洪水|氾濫/, '洪水'], [/高潮/, '高潮'],
  [/暴風/, '暴風'], [/波浪/, '波浪'], [/雷/, '雷'], [/濃霧/, '濃霧'],
  [/乾燥/, '乾燥'], [/なだれ/, 'なだれ'], [/大雪|着雪/, '大雪'],
]
/** 从一条 Kind 名称里取灾种关键词（取不到返回空串）。 */
function hazardWordOf(name) {
  const s = String(name || '')
  for (const [re, key] of HAZARD_KEYS) if (re.test(s)) return key
  return ''
}
/** 取级别最高的那条 Kind 名称，再从中提取灾种——副本之间只要最高级条目相同就会得到同一个键。 */
function hazardKeyOf(items, fallbackText) {
  let name = ''
  let best = -1
  for (const it of items) {
    if (isInactiveItem(it)) continue
    const lv = itemLevelOf(it)
    if (lv > best) { best = lv; name = it.kindName }
  }
  // 先用灾种关键词；没有关键词的灾种（「竜巻注意報」这类）直接用 Kind 名称当键——统一到未知标记会让两个不同灾种共用一把钥匙。
  const activeKey = hazardWordOf(name) || String(name || '')
  if (activeKey) return activeKey
  // 再退到 inactive 条目：解除电文里"被解除的那一项"往往就写着灾种（「大雨警報」+ Status=解除），
  // 无条件跳过会让键退化，而发布电文算出的键是 `jma:summary:大雨:<office>` → 两边永不相等，解除提示从未生效。
  for (const it of items) {
    const hit = hazardWordOf(it.kindName)
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
  let text = String(xml || '')
  if (text.indexOf('<!--') !== -1 && text.indexOf('-->') !== -1) text = text.replace(/<!--[\s\S]*?-->/g, '')
  if (!text || text.indexOf('<Report') === -1) return null
  const control = block(text, 'Control')
  const head = block(text, 'Head')
  const body = block(text, 'Body')

  const title = tag(control, 'Title') || tag(head, 'Title')
  const headTitle = tag(head, 'Title')
  const headlineText = tag(block(head, 'Headline'), 'Text')
  // <Body><Notice>：Ｒ０６ 総合副本里唯一的地区级级别来源（见 levelOf / noticeAreaLevels）
  const notice = tag(body, 'Notice')
  const reportTime = tag(head, 'ReportDateTime') || tag(control, 'DateTime')
  const eventId = tag(head, 'EventID')
  // 用**全文**提取条目：市町村清单常只出现在 Head 的 <Information> 里（Body 的 <Warning> 反而只有摘要），
  // 只看 Body 会取不到区域；重复条目由 regionsOf 去重兜底。
  const items = itemsOf(text)
  // 解除判定只看 **Body** 副本：Head 的摘要项通常**没有 <Status>**（Head 的 Kind 只有 Name/Code/Condition），
  // 而 every() 跨两份副本聚合，Head 里那条同名 Item 会把"Status=解除"稀释成"发布"。Body 缺失时退回全部 items。
  const bodyItems = itemsOf(body)
  const inactiveScope = bodyItems.length > 0 ? bodyItems : items

  const level = levelOf({ title, headTitle, headlineText, notice, items, inactiveScope })
  const cancelled = inactiveScope.length > 0 && inactiveScope.every(isInactiveItem)
  // 把「特別警報 → 警報」的**降级**从"解除"里分出来：「…を警報に切り替えました」既不是解除也不是新发布，
  // 特別警報结束了但**警報仍然有效**。按解除处理会让历史写下「气象警报（已解除）」（假安全方向）；
  // 降级成一个正常的 L4 警报，交给关注地区 / 阈值 / 静默时段照常裁决，它的键与随后的真解除相同。
  const downgradeTo = cancelled
    ? (/注意報に切り替え/.test(headlineText || '') ? 2 : (/警報に切り替え/.test(headlineText || '') ? 4 : 0))
    : 0
  const downgraded = downgradeTo > 0
  const cancels = cancelled && !downgraded
  // 没有级别又不取消（也不是降级）→ 与预警无关（天气预报、观测资料等），交给调用方丢弃
  if (level === 0 && !cancels && !downgraded) return null

  const effLevel = downgraded ? downgradeTo : level
  // 降级电文要**保留区域**（解除才清空）：regionsOf 默认跳过 inactive 条目，而降级电文里唯一的条目就是
  // 「解除」那一项；区域级别由降级后的档位补上。
  const regions = cancels ? [] : regionsOf(items, notice, { includeInactive: downgraded })
  if (downgraded) for (const r of regions) if (typeof r.level !== 'number') r.level = effLevel
  const kindLabel = kindLabelOf(title, effLevel)
  const first = String(headlineText || '').split(/[。\n]/)[0].trim()
  const levelText = effLevel > 0 ? t('kind.levelSuffix', { level: effLevel }) : ''
  const headline = (kindLabel + levelText + (first ? ' · ' + first : '')).slice(0, 180)
  // 事件键：优先 EventID，其次 Head 标题；汇总型电文改用**内容指纹**「灾种 + 編集官署名コード」，否则同一条
  // 警报会因副本标题不同被当成三个事件。指纹**刻意不含发布时刻**：同一次发布的副本会跨分钟（分灾种副本
  // 11:30:33 / 総合副本 11:31:10），而解除的发布时间必然晚于发布，含时刻就注定让解除与发布算出不同的键、
  // 解除链路失效；同一官署 + 同一灾种在事件窗口内共用一键，重复与升级由去重层判定（见 10-dedupe）。
  // 官署名碼取电文 id 的后缀（編集官署名コード：130000=気象庁、280000=神戸地方気象台…），不能用 regions[0]
  // ——解除电文的 regions 恒为空。**取不到后缀时退回 <EditorialOffice> 文本，绝不留空**：留空会让所有官署
  // 的同一灾种共用一个键（`jma:summary:大雨:`），一次发布会被当成另一次发布的重复而静默。
  const idSuffix = /([0-9]{6})\.xml$/.exec(String((entry && entry.id) || ''))
  const officeKey = (idSuffix ? idSuffix[1] : '') ||
    tag(control, 'EditorialOffice') || tag(control, 'PublishingOffice') || 'unknown'
  const eventKey = SUMMARY_TITLE.test(title)
    ? 'jma:summary:' + hazardKeyOf(items, headlineText) + ':' + officeKey
    : 'jma:' + (eventId || headTitle || title)

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
export const TEST_SCENARIOS = [
  { key: 'landslide' },
  { key: 'flood' },
  { key: 'heavyrain' },
  { key: 'stormsurge' },
  { key: 'landslide-l3' },
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

// 构造一条**测试用**电文（不联网）：设置页的「发送测试气象警报」按钮用它走完整链路。
// 区域挂在"用户关注的第一个都道府县"下——写死一个县会让关注别处的用户点下去被匹配挡掉、什么都不发生；
// 没选任何县（全日本模式）时退回東京都。判县只看区域码前两位，用县码拼出的码就够。
// id 与 EventID 都带时间戳与场景名：否则第二条会被消息级去重挡住，或被事件级去重当成"强度未升级的重复
// 发布"而只记历史、不播报。
// @param pref 都道府县名（关注列表首项）；@param nowMs 时间戳；@param key TEST_SCENARIOS 里的 key（默认
// landslide）；@param cityName 市町村级场景用的市町村名（表未加载时可省略，退回县名）。
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
        '（これはテスト配信です。実際の災害ではありません。）。',
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


export { parseJma, buildTestTelegram, maxLevelIn, itemsOf, regionsOf, levelOf, kindLabelOf, noticeAreaLevels, applyNoticeLevels, regionKindOf, itemLevelOf, FLOOD_KIND_LEVEL, INACTIVE_KIND }
