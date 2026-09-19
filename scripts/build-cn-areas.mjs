#!/usr/bin/env node
// dsh-quake-alert · 中国行政区划表（省 → 地级市，带坐标）构建脚本
//
// 作用：把 GeoNames 的中国 / 台湾 / 香港 / 澳门 数据加工成 lib/data/cn-areas.js，
//       供设置页的「国家 → 一级行政区 → 市」级联与关注点坐标填充使用。
//
// 为什么需要它：大陆源（cenc_eew / cenc_eqlist）是**坐标 + 半径**匹配（DESIGN 8.3），
// 而让用户手填经纬度是不现实的。级联到地级市、由表里取该市的坐标，用户只需选"我关心哪里"。
//
// 为什么用 GeoNames：它的行政区划条目**每一条都带经纬度**，且 alternatenames 里有中文名
// （实测 360 个 ADM2 条目**全部**至少有一个纯中文候选）。国家统计局 / 民政部有权威的中文名
// 与区划代码，但**没有坐标**——两者无共同主键可关联（一个用拼音罗马字、一个用六位数字码），
// 硬凑的名字匹配会引入"名字看着对、位置错了几百公里"这类最难查的错误。
//
// **范围（0.5.0 / 0.5.2 复核）**：只做**省 + 地级市**两级。县一级（约 2900 条）是 DESIGN 8.5
// 原本为**气象**源（地质灾害预警粒度到县）预留的，理由是"预警只给县名、需要向上找到所属地级市"。
// **0.5.2 开工前实测推翻了这条假设**：nmc.cn 的预警标题形如「云南省丽江市宁蒗彝族自治县气象台
// 发布地质灾害黄色预警信号」——机构名**自带完整层级链**，237 条实测里 225 条可直接定位到地级市，
// 剩下 12 条是海南省直辖县 / 上海市辖区（本就不属于任何地级市，县表也救不了）。县表对匹配的
// 边际价值接近零，而它要多背 2900 条无法验证的数据，所以**不建**。详见 DESIGN 8.5。
//
// 真正需要的是**别名**：显示名只挑一个候选，而气象台用的是自己的写法（实测 GeoNames 给
// 「毕节地区」/「思茅市」这类**旧名**，而 nmc.cn 写「毕节市」/「普洱市」）。所以每条记录
// 额外输出它在 GeoNames alternatenames 里的**全部中文候选**（aliases），只参与匹配、不进 UI。
//
// 已知取舍（写在这里，避免下一轮当成新发现）：
//   · **行政区名的时效性**：GeoNames 的中文候选里可能同时有旧名与新名（实测 昌都 → 昌都地区 /
//     昌都市，那曲 → 那曲地区 / 那曲市）。本脚本按"当前建制后缀优先"排序（市 > 自治州 > 地区 > 盟），
//     所以会选到 昌都市；但也有只有旧名的条目（日喀则只有"日喀则地区"）。**影响仅限显示名**，
//     坐标取的是该行政区的中心点，不随改名变化。
//   · **坐标是行政区中心点，不是市政府驻地**：对半径匹配（几十〜几百公里）足够，
//     对"精确到我这条街"不够——那要靠「用我的位置」按钮（设置页）。
//
// 来源（运行期不联网，只有构建时需要网络；CC BY 4.0，出典明記で利用可）：
//   https://download.geonames.org/export/dump/CN.zip  （CN.txt：ADM1/ADM2 行）
//   https://download.geonames.org/export/dump/TW.zip  /  HK.zip  /  MO.zip
//
// 零依赖：zip 解压用 Node 内置 zlib（读取器见 scripts/lib/zip.mjs）。
//
// 用法：
//   node scripts/build-cn-areas.mjs                 # 联网取源 → 生成 lib/data/cn-areas.js
//   node scripts/build-cn-areas.mjs --check         # 只校验产物是否与当前源一致（不写盘）
//   node scripts/build-cn-areas.mjs --from <目录>    # 用本地已下载的 zip（离线 / 回归测试用）

import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { unzip } from './lib/zip.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const OUT = path.join(ROOT, 'lib', 'data', 'cn-areas.js')
const BASE = 'https://download.geonames.org/export/dump/'
const CHECK_ONLY = process.argv.includes('--check')
const fromIdx = process.argv.indexOf('--from')
const FROM_DIR = fromIdx === -1 ? null : process.argv[fromIdx + 1]

const COUNTRIES = ['CN', 'TW', 'HK', 'MO']

// ---------------------------------------------------------------- 取值工具
const isCjk = (s) => /^[\u4e00-\u9fff]+$/.test(s)
/**
 * 中文名候选的**层级相关**优先级。
 *
 * 为什么要分两级：GeoNames 的 alternatenames 里混着**过时名与外语变体**，
 * 只按"后缀看起来像行政区"排序会挑错（实测两例）：
 *   · `New Taipei City [新北市 / 臺北縣 / 臺灣省]` —— 按统一的"省 > 市"排会挑到 `臺灣省`，
 *     可这条记录是**新北市**；`臺灣省` 只是它的旧名之一。
 *   · `Yunlin [雲林 / 雲林県 / 雲林縣]` —— `県` 是**日文**字形，中文里根本不用。
 * 所以：省级表把 `省/自治区/特别行政区` 排最高；市级表反过来把 `省` 压到最低
 *（一个"市"的候选里出现"省"几乎必然是旧名），并把日文变体直接排除。
 */
const PROVINCE_RANK = [
  [/特别行政区$/, 10], [/省$/, 9], [/自治区$/, 8], [/市$/, 7],
  [/自治州$/, 5], [/地区$/, 3], [/盟$/, 3],
]
const CITY_RANK = [
  [/市$/, 9], [/自治州$/, 8], [/盟$/, 7], [/地区$/, 6],
  [/自治县$/, 5], [/[县縣]$/, 5], [/[区區]$/, 4], [/省$/, 1],
]
function rankOf(name, table) {
  for (const [re, r] of table) if (re.test(name)) return r
  return 2 // 没有行政区后缀的短名（如「成都」「雲林」）：能接受，但排在完整建制名之后
}
/** 候选是否**是中文**：日文特有的字形（県）不算——中文区划名里不会出现它。 */
const isChineseName = (s) => !/県/.test(s)
/**
 * 从 alternatenames 里挑中文名。先按层级相关的建制后缀优先级，再取更长的那一个（更完整）。
 * 没有纯中文候选时返回空串（由调用方记为"问题"，而不是回退成罗马字名——
 * 罗马字名混进中文界面比缺一条更容易让人误选）。
 * @param {string} alternates GeoNames 的 alternatenames 字段（逗号分隔）
 * @param {'province'|'city'} level
 */
function pickChineseName(alternates, level) {
  const table = level === 'province' ? PROVINCE_RANK : CITY_RANK
  const all = String(alternates || '').split(',').filter(isCjk)
  const prefer = all.filter(isChineseName)
  const zh = prefer.length ? prefer : all // 极端情况：只有日文变体，那就只能用它
  if (zh.length === 0) return ''
  zh.sort((a, b) => (rankOf(b, table) - rankOf(a, table)) || (b.length - a.length))
  return zh[0] || ''
}

/**
 * 同一记录在 GeoNames 里的**全部**中文候选（去掉与显示名重复的、按层级优先级排序）。
 *
 * 与 pickChineseName 的分工：那个挑**一个**用于显示的名字；这个留下其余候选供**匹配**。
 * 两者必须都来自 alternatenames 的同一批中文候选，否则"显示的名字"与"能匹配上的名字"
 * 会脱节——用户看到「毕节地区」而气象台写「毕节市」，一条真实预警就被判成归属不明。
 *
 * 上限 MAX_ALIASES：候选数量是长尾的（少量条目有几十个别名）。匹配是**最长命中**，
 * 砍掉的尾部候选都是短名，不会让"毕节市"这类完整建制名失效。
 * @param {string} alternates
 * @param {string} displayName pickChineseName 的结果（从别名里排除）
 * @param {'province'|'city'} level
 */
function aliasesOf(alternates, displayName, level) {
  const table = level === 'province' ? PROVINCE_RANK : CITY_RANK
  const all = String(alternates || '').split(',').filter(isCjk).filter(isChineseName)
  const seen = new Set()
  const out = []
  for (const n of all) {
    if (n === displayName || n.length < 2 || seen.has(n)) continue
    seen.add(n)
    out.push(n)
  }
  out.sort((a, b) => (rankOf(b, table) - rankOf(a, table)) || (b.length - a.length))
  return out.slice(0, MAX_ALIASES)
}
/** 别名上限：见 aliasesOf 的说明。 */
const MAX_ALIASES = 8

/** GeoNames 的 geoname 表（tab 分隔）→ 行数组。只留我们需要的列。 */
function parseGeonames(text) {
  const out = []
  for (const line of String(text).split('\n')) {
    if (!line) continue
    const c = line.split('\t')
    if (c.length < 15) continue
    out.push({
      name: c[1], alternates: c[3], lat: Number(c[4]), lon: Number(c[5]),
      feature: c[7], cc: c[8], admin1: c[10], admin2: c[11], pop: Number(c[14]) || 0,
    })
  }
  return out
}

async function readSource(file) {
  if (FROM_DIR) {
    const p = path.join(FROM_DIR, file)
    if (!existsSync(p)) throw new Error('--from 目录里没有 ' + file + '：' + p)
    const buf = readFileSync(p)
    return file.endsWith('.zip') ? unzip(buf) : buf.toString('utf8')
  }
  const res = await fetch(BASE + file, { signal: AbortSignal.timeout(120000) })
  if (!res.ok) throw new Error('HTTP ' + res.status + ' ' + file)
  const ab = await res.arrayBuffer()
  const buf = Buffer.from(ab)
  return file.endsWith('.zip') ? unzip(buf) : buf.toString('utf8')
}

function txtOf(entries, cc) {
  const hit = entries.find((f) => f.name === cc + '.txt')
  if (!hit) throw new Error(cc + '.zip 里没有 ' + cc + '.txt')
  return hit.data.toString('utf8')
}

// ---------------------------------------------------------------- 组装
/** 取一个国家的地理条目，切成 ADM1（省级）与 ADM2（地级）。 */
function admOf(rows) {
  const adm1 = []
  const adm2 = []
  for (const r of rows) {
    if (r.feature === 'ADM1') adm1.push(r)
    else if (r.feature === 'ADM2') adm2.push(r)
  }
  return { adm1, adm2 }
}

function build() {
  const problems = []
  const provinces = []
  return (async () => {
    // CN：ADM1 = 省级，ADM2 = 地级
    const cnEntries = await readSource('CN.zip')
    const cn = admOf(parseGeonames(txtOf(cnEntries, 'CN')))
    const byAdmin1 = new Map()
    for (const c of cn.adm2) {
      if (!byAdmin1.has(c.admin1)) byAdmin1.set(c.admin1, [])
      byAdmin1.get(c.admin1).push(c)
    }
    for (const p of cn.adm1) {
      const pname = pickChineseName(p.alternates, 'province')
      if (!pname) { problems.push('省级条目没有中文名：' + p.name); continue }
      const cities = []
      for (const c of (byAdmin1.get(p.admin1) || [])) {
        const cname = pickChineseName(c.alternates, 'city')
        if (!cname) { problems.push('地级条目没有中文名：' + c.name + '（' + pname + '）'); continue }
        if (cname === pname) continue // 直辖市：ADM2 与 ADM1 同名，避免级联里出现两个"北京市"
        cities.push({
          name: cname, aliases: aliasesOf(c.alternates, cname, 'city'),
          lat: round2(c.lat), lon: round2(c.lon),
        })
      }
      // 直辖市 / 没有地级条目的省：把省自己作为一个可选项，否则级联到第二级是空的。
      // 别名同样取该省级条目的候选（"上海市"这一条的候选里有"上海"，浦东新区的预警要靠它归属）。
      if (cities.length === 0) {
        cities.push({
          name: pname, aliases: aliasesOf(p.alternates, pname, 'province'),
          lat: round2(p.lat), lon: round2(p.lon),
        })
      }
      cities.sort((a, b) => a.name.localeCompare(b.name, 'zh'))
      provinces.push({
        code: 'CN.' + p.admin1, name: pname, aliases: aliasesOf(p.alternates, pname, 'province'),
        lat: round2(p.lat), lon: round2(p.lon), cities,
      })
    }

    // TW / HK / MO：GeoNames 里没有"省"这一层 → 各自合成一个省级条目。
    //
    // 台湾：ADM1 只有 4 条（台湾省 / 台北市 / 高雄市 / 福建省），真正有用的是 **ADM2 的 22 个县市**，
    //   所以把 22 条 ADM2 当作可选城市。金门 / 连江（马祖）在 GeoNames 里挂在「福建省」下，
    //   这里一并归到「台湾」——对"选我关心哪里"这个用途，把它们藏到另一个省级选项下只会让人找不到。
    {
      const tw = admOf(parseGeonames(txtOf(await readSource('TW.zip'), 'TW')))
      const cities = []
      for (const c of tw.adm2) {
        const cname = pickChineseName(c.alternates, 'city')
        if (!cname) { problems.push('台湾的 ADM2 没有中文名：' + c.name); continue }
        cities.push({
          name: cname, aliases: aliasesOf(c.alternates, cname, 'city'),
          lat: round2(c.lat), lon: round2(c.lon),
        })
      }
      if (cities.length === 0) problems.push('台湾没有任何可用条目')
      else {
        cities.sort((a, b) => a.name.localeCompare(b.name, 'zh'))
        const c = centroid(cities)
        // 台湾在 GeoNames 里没有"省"这一层（条目是合成的），所以别名写在这里：
        // 气象台的机构名会写「台湾省」或繁体「臺灣」，两种都要能匹配上。
        provinces.push({ code: 'TW', name: '台湾', aliases: ['臺灣', '台灣'], lat: c.lat, lon: c.lon, cities })
      }
    }

    // 香港 / 澳门：GeoNames 里只有区 / 堂区（18 / 8 条），其中 8 条连中文名都没有
    //   （Yuen Long District、Nossa Senhora de Fátima…）。对"关注点 + 半径"来说，
    //   这两个特别行政区**本身就是一个点**——再往下分只会让用户多选一次、还更容易选错。
    //   坐标取这些下级条目的中心点（由数据算出，不写死数字）。名称是港澳的自称：
    //   GeoNames 的这两份 dump 里没有"领土本身"这个条目，只能写在脚本里。
    for (const terr of [{ cc: 'HK', name: '香港' }, { cc: 'MO', name: '澳门' }]) {
      const rows = admOf(parseGeonames(txtOf(await readSource(terr.cc + '.zip'), terr.cc)))
      const pts = rows.adm1.map((r) => ({ lat: r.lat, lon: r.lon }))
      if (pts.length === 0) { problems.push(terr.cc + ' 没有任何条目'); continue }
      const c = centroid(pts)
      provinces.push({
        code: terr.cc, name: terr.name, aliases: [], lat: c.lat, lon: c.lon,
        cities: [{ name: terr.name, aliases: [], lat: c.lat, lon: c.lon }],
      })
    }

    provinces.sort((a, b) => a.code.localeCompare(b.code))
    const cityCount = provinces.reduce((n, p) => n + p.cities.length, 0)
    return { provinces, problems, cityCount }
  })()
}

/** 一组点的中心（算术平均）。用平均而不是取第一条：取第一条会让「香港」落在某一个区上。 */
function centroid(pts) {
  const n = pts.length || 1
  const sum = pts.reduce((a, p) => ({ lat: a.lat + p.lat, lon: a.lon + p.lon }), { lat: 0, lon: 0 })
  return { lat: round2(sum.lat / n), lon: round2(sum.lon / n) }
}

const round2 = (v) => (Number.isFinite(v) ? Math.round(v * 100) / 100 : 0)

// ---------------------------------------------------------------- 产物
/** 别名字段：为空时整段省略，免得产物里塞满 `aliases: []`（读起来全是噪音）。 */
function aliasField(list) {
  return (Array.isArray(list) && list.length) ? ' aliases: ' + JSON.stringify(list) + ',' : ''
}

function render(provinces) {
  const lines = []
  lines.push('// 中国行政区划表（省 → 地级市，带坐标 + 匹配别名）——由 scripts/build-cn-areas.mjs 生成，请勿直接编辑。')
  lines.push('//')
  lines.push('// 来源：GeoNames（CC BY 4.0）的 CN / TW / HK / MO dump 中的 ADM1 / ADM2 条目。')
  lines.push('// 坐标是**行政区中心点**（不是市政府驻地），用于「关注点 + 半径」匹配足够；')
  lines.push('// 更精确的位置由设置页的「用我的位置」按钮提供。')
  lines.push('//')
  lines.push('// 范围：省 / 特别行政区（' + provinces.length + '）+ 地级行政区（' + provinces.reduce((n, p) => n + p.cities.length, 0) + '）。')
  lines.push('// **县一级不在本表内**（0.5.2 的决策，理由与实测证据见 DESIGN 8.5）：气象源的预警标题')
  lines.push('// 自带完整机构链（省 + 市 + 县），不需要靠县名向上反查地级市；2900 条无法验证的数据不背。')
  lines.push('//')
  lines.push('// aliases（0.5.2）：同一记录的**其余中文候选**，只参与匹配、不进 UI。')
  lines.push('// 存在的理由：显示名只挑一个候选，而气象台写的是自己的建制名——实测 GeoNames 会挑到旧名')
  lines.push('//（「毕节地区」「思茅市」），而 nmc.cn 写「毕节市」「普洱市」，只按显示名匹配会让一条真实')
  lines.push('// 预警被判成"归属不明"。加入全部候选后，237 条实测样本的可定位率从 88% 升到 95%。')
  lines.push('//')
  lines.push('// 已知取舍（三条都只影响"精度"，不影响"位置对不对"）：')
  lines.push('//  ① 行政区的**中文名可能滞后**：GeoNames 里新旧名并存，脚本按「当前建制后缀」的优先级')
  lines.push('//     挑（市级：市 > 自治州 > 盟 > 地区），但只有旧名的条目只能沿用旧名（如「日喀则地区」）。')
  lines.push('//  ② 坐标是**行政区中心点**（GeoNames 的 ADM 记录点），不是市政府驻地。对一般地级市差')
  lines.push('//     几十公里；对面积极大的州 / 市（甘孜藏族自治州、哈尔滨市）可差 100 公里以上——')
  lines.push('//     那些地方"选一个点 + 半径"本身就不足以覆盖全境，要靠「用我的位置」或加大半径。')
  lines.push('//  ③ 台湾的县市沿用 GeoNames 的写法，简繁混排（澎湖县 / 雲林縣）——同一地名，不影响识别。')
  lines.push('')
  lines.push('export const CN_AREAS = [')
  for (const p of provinces) {
    lines.push('  { code: ' + JSON.stringify(p.code) + ', name: ' + JSON.stringify(p.name) + ',' +
      aliasField(p.aliases) + ' lat: ' + p.lat + ', lon: ' + p.lon + ', cities: [')
    for (const c of p.cities) {
      lines.push('    { name: ' + JSON.stringify(c.name) + ',' + aliasField(c.aliases) +
        ' lat: ' + c.lat + ', lon: ' + c.lon + ' },')
    }
    lines.push('  ] },')
  }
  lines.push(']')
  lines.push('')
  return lines.join('\n')
}

// ---------------------------------------------------------------- main
const { provinces, problems, cityCount } = await build()
if (problems.length) {
  console.error('构建中发现 ' + problems.length + ' 处问题：')
  for (const p of problems.slice(0, 20)) console.error('  · ' + p)
  if (problems.length > 20) console.error('  … 其余 ' + (problems.length - 20) + ' 条省略')
}
const code = render(provinces)
console.log('省级行政区 ' + provinces.length + '，地级行政区 ' + cityCount + '，产物 ' + code.length + ' 字符')

if (CHECK_ONLY) {
  let cur = ''
  try { cur = readFileSync(OUT, 'utf8') } catch { /* 不存在视为陈旧 */ }
  if (cur === code) { console.log('lib/data/cn-areas.js 已是最新。'); process.exit(problems.length ? 1 : 0) }
  console.error('lib/data/cn-areas.js 已陈旧：请运行 node scripts/build-cn-areas.mjs')
  process.exit(1)
}
writeFileSync(OUT, code, 'utf8')
console.log('已写入 lib/data/cn-areas.js')
process.exit(problems.length ? 1 : 0)
