// dsh-quake-alert · GeoNames 加工工具的公共部分
//
// 给 build-cn-areas.mjs（中国行政区划表）与 build-world-cities.mjs（全球主要城市表）提供同一套纯工具：
//       dump 的读取、解压与按列解析（两个脚本各自的**挑选规则**不同，解析器只有这一份）。
// 来源与许可：GeoNames dump，CC BY 4.0（出典明記で利用可）；列序与字段含义见 dump 的 readme.txt。
//
// 用法：import { createGeoReader, parseGeonames } from './lib/geonames.mjs'

import { readFileSync, existsSync } from 'node:fs'
import path from 'node:path'
import { unzip } from './zip.mjs'

export const GEONAMES_BASE = 'https://download.geonames.org/export/dump/'

/** 纯汉字（CJK 基本区）。 GeoNames 的 alternatenames 是几十种语言的混排，必须显式筛。 */
export const isCjk = (s) => /^[\u4e00-\u9fff]+$/.test(s)

/**
 * 全球城市表用的城市名：统一取 GeoNames 的拉丁字母名（`asciiname`，缺失时退回 `name`）；城市名不做
 * 本地化，国家 / 地区名另由 ICU 算出四种语言（见 `build-world-cities.mjs` 的 LANGS）。
 */
export function latinCityNameOf(row) {
  const r = row || {}
  return String(r.ascii || r.name || '').trim()
}

/** GeoNames 的 geoname 表（tab 分隔）→ 行数组，只留用得到的列；少于 15 列的行跳过（存在被截断的坏行）。
 *  列序（readme.txt）：0 geonameid / 1 name / 2 asciiname / 3 alternatenames / 4 latitude / 5 longitude /
 *  7 feature code / 8 country code / 10 admin1 / 11 admin2 / 14 population。 */
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
 * 建一个 dump 读取器：`--from <目录>` 时读本地已下载的文件（离线 / 回归），否则联网取。
 * 联网只发生在构建数据表时，运行期不联网。
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
