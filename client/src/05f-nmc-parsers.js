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

import { isPlainObject, own } from './02-storage.js'
import { t } from './00-i18n.js'
import { cnAreaOf } from './04-city-table.js'

/** 灾种标识 → 中文（与 Host 的 NMC_KINDS 值域对齐）。 */
const NMC_KIND_TEXT = { rainstorm: 'kind.cnRainstorm', geology: 'kind.cnGeology' }
/** 等级 → 中文（与图标编码 `001`..`004` 的对应关系见 lib/nmc-source.js）。 */
const NMC_LEVEL_TEXT = { red: 'kind.cnLevelRed', orange: 'kind.cnLevelOrange', yellow: 'kind.cnLevelYellow', blue: 'kind.cnLevelBlue' }
/** 等级 → severity。**忠实映射，不拔高**：四色本身就是官方等级；后果是静默时段（只放行 red）
 *  **不会**放行橙色预警。 */
const NMC_LEVEL_SEVERITY = { red: 'red', orange: 'orange', yellow: 'yellow', blue: 'info' }
/** 等级序（越大越重），与 Host 的 NMC_LEVEL_RANK 一致；播报门槛为橙色及以上，低于它的条目仍然
 *  解析，但不进历史、不打扰。 */
const NMC_LEVEL_RANK = { red: 4, orange: 3, yellow: 2, blue: 1 }
export const NMC_BROADCAST_MIN_RANK = 3

/** 从 `title` 里取出发布机构名（`…气象台发布…`）；认不出返回空串，届时由契约层判 schema。
 *  @param {unknown} title */
function orgOf(title) {
  const m = /^(.*?(?:气象台|气象局|预警中心))发布/.exec(String(title === undefined || title === null ? '' : title))
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
  const alertid = String(raw.alertid === undefined || raw.alertid === null ? '' : raw.alertid).trim()
  if (!alertid) return null
  const kind = typeof raw.kind === 'string' && own(NMC_KIND_TEXT, raw.kind) ? raw.kind : ''
  if (!kind) return null
  const level = typeof raw.level === 'string' && own(NMC_LEVEL_TEXT, raw.level) ? raw.level : ''
  if (!level) return null
  const issued = String(raw.issued === undefined || raw.issued === null ? '' : raw.issued).trim()
  const title = String(raw.title === undefined || raw.title === null ? '' : raw.title).trim()
  const detail = String(raw.detail === undefined || raw.detail === null ? '' : raw.detail).trim()
  const org = orgOf(title)
  const area = org ? cnAreaOf(org) : null
  // 机构名去掉表示发布主体的后缀即"发布地"：「云南省丽江市宁蒗彝族自治县气象台」→ 该县。
  const place = org.replace(/(?:气象台|气象局|预警中心)$/, '')
  // 查表一律走 own()：外部数据当键时，直查会让 'constructor' 这类键命中原型链返回函数对象，值域
  // 就更没保证。契约层（05d）用的是同一个约定。
  const rank = own(NMC_LEVEL_RANK, level) || 0
  // 灾种名与等级词都是**我们给起的**（电文原文只有编码）→ 按界面语言取词，表里存的是 i18n key。
  const kindKey = own(NMC_KIND_TEXT, kind)
  const levelKey = own(NMC_LEVEL_TEXT, level)
  const kindText = kindKey ? t(kindKey) : ''
  const levelText = levelKey ? t(levelKey) : ''
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

export { parseNmcAlarm, orgOf, NMC_KIND_TEXT, NMC_LEVEL_TEXT, NMC_LEVEL_SEVERITY, NMC_LEVEL_RANK }
