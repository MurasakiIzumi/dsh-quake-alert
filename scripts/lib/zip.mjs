// dsh-quake-alert · 最小 zip 读取器（零依赖）：把内存里的 zip 缓冲区解成 [{ name, data }]。
// 只支持 store(0) 与 deflate(8)（気象庁公开的 zip 与 xlsx 都用这两种），不支持 zip64。
// 用法：import { unzip } from './lib/zip.mjs'

import { inflateRawSync } from 'node:zlib'

/** 标准 CRC32（zip 用的多项式 0xEDB88320），表按需构建一次。 */
let crcTable = null
function crc32(buf) {
  if (!crcTable) {
    crcTable = new Int32Array(256)
    for (let n = 0; n < 256; n++) {
      let c = n
      for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1)
      crcTable[n] = c
    }
  }
  let crc = -1
  for (let i = 0; i < buf.length; i++) crc = (crc >>> 8) ^ crcTable[(crc ^ buf[i]) & 0xff]
  return (crc ^ -1) >>> 0
}

/** 解压后的内容与中央目录里的长度 / CRC 对不上就抛错（坏数据不许进 lib/data/）。 */
function verify(e, data) {
  if (typeof e.uncompSize === 'number' && e.uncompSize > 0 && data.length !== e.uncompSize) {
    throw new Error('zip 条目长度不符（' + e.name + '：期望 ' + e.uncompSize + '，实得 ' + data.length + '）')
  }
  if (typeof e.crc32 === 'number' && e.crc32 !== 0) {
    const got = crc32(data)
    if (got !== (e.crc32 >>> 0)) {
      throw new Error('zip 条目 CRC 不符（' + e.name + '：期望 ' + (e.crc32 >>> 0).toString(16) +
        '，实得 ' + got.toString(16) + '）')
    }
  }
  return data
}

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
    const crc = buf.readUInt32LE(p + 16)
    const compSize = buf.readUInt32LE(p + 20)
    const uncompSize = buf.readUInt32LE(p + 24)
    const nameLen = buf.readUInt16LE(p + 28)
    const extraLen = buf.readUInt16LE(p + 30)
    const commentLen = buf.readUInt16LE(p + 32)
    const localOffset = buf.readUInt32LE(p + 42)
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString('utf8')
    entries.push({ name, method, crc32: crc, compSize, uncompSize, localOffset, utf8: (flags & 0x800) !== 0 })
    p += 46 + nameLen + extraLen + commentLen
  }
  return entries.map((e) => ({ name: e.name, data: verify(e, readEntry(buf, e)) }))
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
