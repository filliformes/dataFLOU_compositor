// UDP data plane — port of src/core/stream_codec.cpp from 124_dataflou.
//
// Packet (little-endian):
//   [0xDF 0x01] [u32 sku_hash] [u16 count] [u32 timestamp_ms]   (12-byte header)
//   per entry: [u16 path_len] [path bytes] [u8 type tag] [value]
// Values: Bool 1 byte · Number f64 · V2/V3/V4 f32×N · Colour 4 bytes RGBA ·
//         String/Blob u16 length + bytes.
// The sender is identified by crc32(sku) (crc32Sku below); paths are the
// SOURCE param's path on the sending node.

import { ParamType, type ParamValue } from './model'

const MAGIC0 = 0xdf
const MAGIC1 = 0x01
const HEADER = 12
export const UDP_BUF_SIZE = 1400 // DATAFLOU_UDP_BUF_SIZE

export interface StreamEntry {
  path: string
  value: ParamValue
}

/** CRC-32 (reflected, poly 0xEDB88320) of the SKU's bytes — Node::crc32_sku. */
export function crc32Sku(sku: string): number {
  let crc = 0xffffffff
  for (const byte of Buffer.from(sku, 'utf8')) {
    crc ^= byte
    for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1))
  }
  return (crc ^ 0xffffffff) >>> 0
}

function valueSize(v: ParamValue): number {
  switch (v.tag) {
    case ParamType.Bool:
      return 1
    case ParamType.Number:
      return 8
    case ParamType.V2:
      return 8
    case ParamType.V3:
      return 12
    case ParamType.V4:
      return 16
    case ParamType.Colour:
      return 4
    default:
      return 2 + Buffer.byteLength(v.s ?? '', 'utf8')
  }
}

export function encodeStreamPacket(skuHash: number, timestampMs: number, entries: StreamEntry[]): Buffer | null {
  if (entries.length === 0 || entries.length > 0xffff) return null
  let size = HEADER
  for (const e of entries) size += 2 + Buffer.byteLength(e.path, 'utf8') + 1 + valueSize(e.value)
  if (size > UDP_BUF_SIZE) return null
  const b = Buffer.alloc(size)
  b[0] = MAGIC0
  b[1] = MAGIC1
  b.writeUInt32LE(skuHash >>> 0, 2)
  b.writeUInt16LE(entries.length, 6)
  b.writeUInt32LE(timestampMs >>> 0, 8)
  let p = HEADER
  for (const e of entries) {
    const path = Buffer.from(e.path, 'utf8')
    b.writeUInt16LE(path.length, p)
    p += 2
    path.copy(b, p)
    p += path.length
    b[p++] = e.value.tag
    const v = e.value
    switch (v.tag) {
      case ParamType.Bool:
        b[p++] = v.b ? 1 : 0
        break
      case ParamType.Number:
        b.writeDoubleLE(v.n ?? 0, p)
        p += 8
        break
      case ParamType.V2:
      case ParamType.V3:
      case ParamType.V4: {
        const dim = v.tag === ParamType.V2 ? 2 : v.tag === ParamType.V3 ? 3 : 4
        for (let i = 0; i < dim; i++) {
          b.writeFloatLE(v.v?.[i] ?? 0, p)
          p += 4
        }
        break
      }
      case ParamType.Colour:
        for (let i = 0; i < 4; i++) b[p++] = (v.v?.[i] ?? 0) & 0xff
        break
      default: {
        const s = Buffer.from(v.s ?? '', 'utf8')
        b.writeUInt16LE(s.length, p)
        p += 2
        s.copy(b, p)
        p += s.length
      }
    }
  }
  return b
}

export function decodeStreamPacket(d: Buffer): { skuHash: number; timestampMs: number; entries: StreamEntry[] } | null {
  if (d.length < HEADER || d[0] !== MAGIC0 || d[1] !== MAGIC1) return null
  const skuHash = d.readUInt32LE(2)
  const count = d.readUInt16LE(6)
  const timestampMs = d.readUInt32LE(8)
  const entries: StreamEntry[] = []
  let p = HEADER
  for (let i = 0; i < count; i++) {
    if (p + 2 > d.length) break
    const plen = d.readUInt16LE(p)
    p += 2
    if (p + plen + 1 > d.length) break
    const path = d.toString('utf8', p, p + plen)
    p += plen
    const tag = d[p++]
    let value: ParamValue | null = null
    switch (tag) {
      case ParamType.Bool:
        if (p + 1 > d.length) break
        value = { tag, b: d[p++] !== 0 }
        break
      case ParamType.Number:
        if (p + 8 > d.length) break
        value = { tag, n: d.readDoubleLE(p) }
        p += 8
        break
      case ParamType.V2:
      case ParamType.V3:
      case ParamType.V4: {
        const dim = tag === ParamType.V2 ? 2 : tag === ParamType.V3 ? 3 : 4
        if (p + dim * 4 > d.length) break
        const v: number[] = []
        for (let k = 0; k < dim; k++) {
          v.push(d.readFloatLE(p))
          p += 4
        }
        value = { tag, v }
        break
      }
      case ParamType.Colour:
        if (p + 4 > d.length) break
        value = { tag, v: [d[p], d[p + 1], d[p + 2], d[p + 3]] }
        p += 4
        break
      case ParamType.String:
      case ParamType.Blob: {
        if (p + 2 > d.length) break
        const slen = d.readUInt16LE(p)
        p += 2
        if (p + slen > d.length) break
        value = { tag, s: d.toString('utf8', p, p + slen) }
        p += slen
        break
      }
    }
    if (!value) break
    entries.push({ path, value })
  }
  return { skuHash, timestampMs, entries }
}
