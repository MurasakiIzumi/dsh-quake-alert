// ============================================================================
// dsh-quake-alert · client/src/05f-nmc-parsers.js
//
// 作用：把 Host 转来的 nmc.cn 预警（JSON）解析成与日本源 / 全球源同一套内部模型（Alert）。
// 内容：`nmc_alarm`——中央气象台汇总的**暴雨**与**地质灾害**预警信号。
// 依赖：02-storage（isPlainObject）、04-city-table（cnAreaOf）。
//
// 与其它源的三处结构性差异（都是实测决定的，不是风格选择）：
//
// ① **匹配走行政区层级，不走半径**（DESIGN 8.5）。
//    预警的粒度到县（「云南省丽江市宁蒗彝族自治县气象台发布地质灾害黄色预警信号」），
//    而设置页只让用户选到地级市。所以 locator 是 `'area'`：把机构名解析成「省 + 市」，
//    再与用户关注的市比对。**不用半径**——"选丽江市 + 100km"会漏掉辖下较远的县，
//    而漏报正是这套系统最不想要的（DESIGN 8.5 明确否决了"县名换坐标 + 半径"）。
//
// ② **机构名自带完整层级链，不需要县表**。
//    0.5.0 曾预留"省 → 市 → 县"三级表（2900 条）用于"从县名向上找地级市"。开工前实测
//    238 条真实预警：**每一条的机构名都以省名开头**，226 条能直接定位到地级市，剩下 12 条
//    是海南省直辖县 / 上海市辖区（本就不属于任何地级市，县表也救不了）。所以县表不建，
//    改由 04-city-table 的 cnAreaOf 在「省 + 市」这一层做最长匹配（DESIGN 8.5 已按实测更正）。
//
// ③ **等级与灾种只认图标编码，不认中文**。
//    Host 已经把 `pic` 的编码解成 `kind` / `level` 两个词（见 lib/nmc-source.js），
//    这一层不做任何中文匹配——`title` 的措辞会随上游改（样本里"预警信号"与"预警"两种都有），
//    而图标文件名是程序契约。
//
// 三条已知缺口（与大陆地震源同类，UI 与文档必须如实说明，代码里不得假装能处理）：
//   · **没有"解除"电文**。列表是"当前生效集合"，预警过期就从列表消失，我们看不到"解除"这个
//     动作，因此 cancelled 恒为 false——"没收到取消"不等于"警报仍然有效"。
//   · **没有取消 / 最终报标志**。
//   · **机构名可能带错字**。实测「黑龙江省齐哈尔市克山县气象台」（少了"齐"）——市名对不上时
//     按省级兜底放行（见 06-matcher），而不是丢弃这条预警。
// ============================================================================

import { isPlainObject, own } from './02-storage.js'
import { cnAreaOf } from './04-city-table.js'

/** 灾种标识 → 中文（与 Host 的 NMC_KINDS 值域对齐）。 */
const NMC_KIND_TEXT = { rainstorm: '暴雨', geology: '地质灾害' }
/** 等级 → 中文（与图标编码 `001`..`004` 的对应关系见 lib/nmc-source.js）。 */
const NMC_LEVEL_TEXT = { red: '红色', orange: '橙色', yellow: '黄色', blue: '蓝色' }
/**
 * 等级 → severity（DESIGN 2 节的配色语义）：红 → red、橙 → orange、黄 → yellow、蓝 → info。
 *
 * **忠实映射，不做"警报恒 red"那种拔高**（0.5.1 对 `cenc_eew` 的修正不适用这里）：
 * 那条修正是因为日本 EEW 本身就是警报、按震级分档纯属把警报降级；而气象预警的四个颜色
 * **本身就是等级**，拔高橙色会让"橙色"这个用户能看见的官方等级失去意义。
 * 后果要如实写进文档：静默时段（默认只放行 red）**不会**放行橙色预警——夜里发布的橙色
 * 暴雨预警只在历史里留痕。这是取舍，不是遗漏。
 */
const NMC_LEVEL_SEVERITY = { red: 'red', orange: 'orange', yellow: 'yellow', blue: 'info' }
/** 等级序（越大越重），与 Host 的 NMC_LEVEL_RANK 一致。 */
const NMC_LEVEL_RANK = { red: 4, orange: 3, yellow: 2, blue: 1 }
/** 播报门槛：橙色及以上（DESIGN 8.4）。低于它的条目仍然解析、仍然进历史，只是不打扰。 */
export const NMC_BROADCAST_MIN_RANK = 3

/**
 * 从 `title` 里取出发布机构名（`…气象台发布…`）。
 * 认不出返回空串——那说明上游换了措辞，届时由契约层的 schema 判据兜住（见 05d）。
 * @param {unknown} title
 */
function orgOf(title) {
  const m = /^(.*?(?:气象台|气象局|预警中心))发布/.exec(String(title === undefined || title === null ? '' : title))
  return m ? m[1] : ''
}

/**
 * nmc.cn 预警（Host 的 JSON 载荷）→ Alert。
 *
 * **结构不符返回 null**（由契约层分类成 schema / empty），而不是在这里抛错或编一个空对象：
 * 后者会让"上游改版"在 UI 上长成"这条预警没有内容"。
 *
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
  // 查表一律走 own()（0.5.4）：上面两处白名单已经限定了取值，但这里同样是"外部数据当键"，
  // 直查会让 'constructor' 这类键命中原型链返回函数对象（severity 变成函数、headline 里
  // 嵌进函数源码）。契约层（05d）已同步改成 own()，两处是同一个约定。
  const rank = own(NMC_LEVEL_RANK, level) || 0
  const kindText = own(NMC_KIND_TEXT, kind)
  return {
    // 前缀 nmc: ——与其它源的 id 命名空间分开（alertid 是纯数字串，不加前缀会与
    // P2PQuake 的数字 eventId 撞在同一个集合里，去重表可以按 id 建索引）。
    id: 'nmc:' + alertid,
    code: 'nmc_alarm',
    // kind 复用 'weather'：它是气象灾害，与日本气象电文共用"进历史 / 配色 / 文案"的整条链路。
    // 真正区分两者的是 locator（'area' = 走行政区层级匹配，见 06-matcher）。
    kind: 'weather',
    kindLabel: '大陆' + kindText + '预警（中央气象台）',
    source: 'nmc_alarm',
    locator: 'area',
    severity: own(NMC_LEVEL_SEVERITY, level),
    issued,
    reportTime: issued,
    // 文案用**发布地 + 灾种 + 等级**，不用行政区表里的名字：表里的名字是 GeoNames 的显示名，
    // 实测会挑到旧名（「思茅市」而气象台写「普洱市」），照搬会让用户对不上号。
    headline: (place ? place + ' · ' : '') + kindText + own(NMC_LEVEL_TEXT, level) + '预警',
    maxScale: -1,
    level: 0,
    // regions 是日本源的概念（都道府县 + 市町村）。大陆源不用它——归属放在 cnArea 里，
    // 留空数组是为了让 06-matcher 的"未携带可判定区域"分支不会误伤（那条分支只看 regions）。
    regions: [],
    // 事件键取 alertid：nmc.cn 的 alertid 是**每条预警唯一**的，升级（黄→橙）会换新的 alertid
    // ——那正是应该再响一次的情形。所以这里不做"同机构同灾种归并"：那会把升级吞掉，
    // 而升级恰恰是用户最需要知道的那一次（与 DESIGN 11.7 第 6 条对日本官署的取舍不同：
    // 那边是同一官署管多县导致的**误归并**，这边的键本来就是唯一的）。
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
    cancelled: false, // 列表里没有"解除"这种形态——见文件头，不得假装能处理
    raw,
  }
}

export { parseNmcAlarm, orgOf, NMC_KIND_TEXT, NMC_LEVEL_TEXT, NMC_LEVEL_SEVERITY, NMC_LEVEL_RANK }
