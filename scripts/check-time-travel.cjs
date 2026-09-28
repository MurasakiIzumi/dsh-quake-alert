// 时钟前移检查：回归套件里有一类定时炸弹——把绝对时刻当成"现在"写死，却与**真实** `Date.now()`
// 做差或比较，于是写下当天全绿、某天突然在 CI 上红。例：`Date.UTC(2026,8,28,12,0,0)` 当作"现在"
// 去判 24 小时记忆，真实时间越过该点后"25 小时前"变成"23.9 小时前"；把 `now` 喂给内部用真实时钟
// 剪枝的 `addEvent`，真实时间一过 7 天该条目就被当成过期剪掉。
// 做法：把**宿主**的 `Date` 整体前移 N 天再跑完整回归套件，任何依赖真实日期的断言都会现形；
// 只前移宿主就够了，沙箱（bundle 跑在 vm 里）的 Date 由测试自己注入成冻结时钟。
// 用法：node scripts/check-time-travel.cjs [天数]      # 默认 180；退出码 = 回归套件的退出码。
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
