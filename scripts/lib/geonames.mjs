// dsh-quake-alert · GeoNames 加工工具的公共部分
//
// 作用：给 build-cn-areas.mjs（中国行政区划表）与 build-world-cities.mjs（全球主要城市表）
//       提供同一套纯工具：dump 的读取、解压与按列解析。
//
// 为什么抽出来：两个脚本都要"下载 zip → 取出里面的 .txt → 按 tab 拆列"，这段逻辑与各自的
// **挑选规则**无关（一个是中文建制名的优先级，一个是全球城市的中文名回退链），放在一起才不会
// 出现两份会各自漂移的解析器——而"列序变了"这种事一旦只在一边修好，另一边会静默产出错数据。
//
// 来源与许可：GeoNames dump，CC BY 4.0（出典明記で利用可）。
//   https://download.geonames.org/export/dump/readme.txt   （列序与字段含义）
//
// 用法：import { createGeoReader, parseGeonames } from './lib/geonames.mjs'

import { readFileSync, existsSync } from 'node:fs'
import path from 'node:path'
import { unzip } from './zip.mjs'

export const GEONAMES_BASE = 'https://download.geonames.org/export/dump/'

/** 纯汉字（CJK 基本区）。 GeoNames 的 alternatenames 是几十种语言的混排，必须显式筛。 */
export const isCjk = (s) => /^[\u4e00-\u9fff]+$/.test(s)

/**
 * GeoNames 的 geoname 表（tab 分隔）→ 行数组。只留用得到的列。
 *
 * 列序（readme.txt）：0 geonameid / 1 name / 2 asciiname / 3 alternatenames / 4 latitude /
 * 5 longitude / 6 feature class / 7 feature code / 8 country code / 9 cc2 / 10 admin1 code /
 * 11 admin2 code / 12 admin3 / 13 admin4 / 14 population / …
 * 少于 15 列的行直接跳过（dump 里存在字段被截断的坏行）。
 */
export function parseGeonames(text) {
  const out = []
  for (const line of String(text).split('\n')) {
    if (!line) continue
    const c = line.split('\t')
    if (c.length < 15) continue
    out.push({
      id: Number(c[0]) || 0,
      name: c[1],
      ascii: c[2],
      alternates: c[3],
      lat: Number(c[4]),
      lon: Number(c[5]),
      feature: c[7], // ADM1 / ADM2 / PPL…（class 在 c[6]，这里只留 code）
      cc: c[8],
      admin1: c[10],
      admin2: c[11],
      pop: Number(c[14]) || 0,
    })
  }
  return out
}

/**
 * 建一个 dump 读取器。
 *
 * `--from <目录>` 时读本地已下载的文件（离线 / 回归用），否则联网取——
 * 运行期（插件工作的时候）永远不联网，联网只发生在构建数据表时。
 *
 * @param {{ fromDir?: string|null, base?: string, timeoutMs?: number }} [opts]
 */
export function createGeoReader(opts) {
  const o = opts || {}
  const base = o.base || GEONAMES_BASE
  const fromDir = o.fromDir || null
  const timeoutMs = o.timeoutMs || 180000

  /** 取一个 dump 文件；`.zip` 自动解压成条目数组，其余按 utf8 文本返回。 */
  const readSource = async (file) => {
    if (fromDir) {
      const p = path.join(fromDir, file)
      if (!existsSync(p)) throw new Error('--from 目录里没有 ' + file + '：' + p)
      const buf = readFileSync(p)
      return file.endsWith('.zip') ? unzip(buf) : buf.toString('utf8')
    }
    const res = await fetch(base + file, { signal: AbortSignal.timeout(timeoutMs) })
    if (!res.ok) throw new Error('HTTP ' + res.status + ' ' + file)
    const buf = Buffer.from(await res.arrayBuffer())
    return file.endsWith('.zip') ? unzip(buf) : buf.toString('utf8')
  }

  /** 从解压结果里取 `<cc>.txt` 的文本。 */
  const txtOf = (entries, cc) => {
    const hit = entries.find((f) => f.name === cc + '.txt')
    if (!hit) throw new Error(cc + '.zip 里没有 ' + cc + '.txt')
    return hit.data.toString('utf8')
  }

  return { readSource, txtOf }
}
