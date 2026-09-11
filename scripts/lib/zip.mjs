// dsh-quake-alert · 最小 zip 读取器（零依赖）
//
// 作用：把内存里的 zip 缓冲区解成 [{ name, data }]。只支持 store(0) 与 deflate(8)——
//       JMA 公开的 zip 与 xlsx 都用这两种，够用；不支持 zip64（这些包远小于 4GB）。
//
// 为什么自写而不引依赖：构建脚本要能从気象庁的公开 zip 直接取源（河川区域 CSV），
// 而本插件至今只用 Node 内置能力做工具链（build-client.mjs 用 rollup 是因为必须打包，
// check-imports.mjs 纯手写）。为此引入 unzip/xlsx 这类依赖不划算，且手写部分可被测试覆盖。
//
// 用法：import { unzip } from './lib/zip.mjs'

import { inflateRawSync } from 'node:zlib'

/**
 * 解出 zip 内的所有条目。
 * @param {Buffer} buf zip 文件内容
 * @returns {{ name: string, data: Buffer }[]}
 */
export function unzip(buf) {
  const eocd = findEocd(buf)
  const count = buf.readUInt16LE(eocd + 10)
  const cdOffset = buf.readUInt32LE(eocd + 16)
  if (cdOffset === 0xffffffff) throw new Error('不支持 zip64 格式')
  const entries = []
  let p = cdOffset
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('zip 中央目录损坏（第 ' + i + ' 项）')
    const flags = buf.readUInt16LE(p + 8)
    const method = buf.readUInt16LE(p + 10)
    const compSize = buf.readUInt32LE(p + 20)
    const nameLen = buf.readUInt16LE(p + 28)
    const extraLen = buf.readUInt16LE(p + 30)
    const commentLen = buf.readUInt16LE(p + 32)
    const localOffset = buf.readUInt32LE(p + 42)
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString('utf8')
    entries.push({ name, method, compSize, localOffset, utf8: (flags & 0x800) !== 0 })
    p += 46 + nameLen + extraLen + commentLen
  }
  return entries.map((e) => ({ name: e.name, data: readEntry(buf, e) }))
}

/** 从尾部向前找 End of Central Directory（注释最长 65535 字节，所以搜索窗口是 22+65535）。 */
function findEocd(buf) {
  if (buf.length < 22) throw new Error('不是有效的 zip：文件太短')
  const floor = Math.max(0, buf.length - 22 - 65535)
  for (let i = buf.length - 22; i >= floor; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) return i
  }
  throw new Error('不是有效的 zip：找不到 End of Central Directory')
}

/** 按中央目录记录的偏移读本地文件头，再按压缩方法解出内容。 */
function readEntry(buf, e) {
  const lp = e.localOffset
  if (buf.readUInt32LE(lp) !== 0x04034b50) throw new Error('zip 本地文件头损坏：' + e.name)
  const nameLen = buf.readUInt16LE(lp + 26)
  const extraLen = buf.readUInt16LE(lp + 28)
  const start = lp + 30 + nameLen + extraLen
  const raw = buf.subarray(start, start + e.compSize)
  if (e.method === 0) return Buffer.from(raw)
  if (e.method === 8) return inflateRawSync(raw)
  throw new Error('不支持的压缩方法 ' + e.method + '：' + e.name)
}
