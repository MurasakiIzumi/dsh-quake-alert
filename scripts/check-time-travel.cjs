// 时间旅行守卫（0.9.4）。
//
// 用法：node scripts/check-time-travel.cjs [天数]      # 默认 180
//
// 为什么要有它：回归套件里有一类**定时炸弹**——把某个绝对时刻当成"现在"写死，却与**真实
// 时钟**（`Date.now()`、`addEvent` 内部的剪枝、`wasRecentlyAlerted` 的记忆窗口）做差或比较。
// 这种断言在写下的当天**全绿**，然后在某一天突然开始在 CI 上红，而且红得毫无线索：
//
//   · `Date.UTC(2026,8,28,12,0,0)` 当作"现在"去判 24 小时记忆 → 真实时间越过
//     2026-09-27T12:00Z 之后，"25 小时前"变成"23.9 小时前"，断言必红（0.9.4 的第二次 CI 红）
//   · `const now = Date.UTC(2026,8,27,12,0,0)` 喂给 `addEvent`，而它内部用真实时钟剪枝
//     → 真实时间一过 7 天，`at: now - 1*DAY` 的条目被当成过期剪掉（0.9.4 发现的第二颗）
//
// 做法：把**宿主**的 `Date` 整体前移 N 天，再跑完整回归套件。任何"依赖真实日期"的断言都会
// 在这里现形。只前移宿主 Date 是够的：沙箱（bundle 跑在 vm 里）的 Date 由测试自己注入，
// 而那些注入的冻结时钟正是"安全写法"的样板。
//
// 退出码 = 回归套件的退出码（脚本失败即非零），所以可以直接当 CI 的一步用。
const DAY = 24 * 60 * 60 * 1000
const arg = Number(process.argv[2])
const days = Number.isFinite(arg) && arg >= 0 ? arg : 180

const RealDate = Date
class ShiftedDate extends RealDate {
  constructor(...args) {
    if (args.length === 0) super(RealDate.now() + days * DAY)
    else super(...args)
  }
  static now() { return RealDate.now() + days * DAY }
}
// UTC / parse 由子类继承，行为与真实 Date 一致（显式列出是为了让"这两个不能变"一眼可见）。
ShiftedDate.UTC = RealDate.UTC
ShiftedDate.parse = RealDate.parse
globalThis.Date = ShiftedDate

console.log('[time-travel] 宿主时钟前移 ' + days + ' 天，跑完整回归套件')
require('../tests/sync-test.cjs')
