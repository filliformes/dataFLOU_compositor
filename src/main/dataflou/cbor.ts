// Minimal CBOR (RFC 8949) codec for the dataflou topology protocol.
//
// The encoder takes explicitly TYPED items: JavaScript has one number type,
// but the C++ library decodes with QCBOR's strict getters — GetUInt64 rejects
// a float, GetDouble rejects an integer — so every number on the wire must be
// emitted as exactly the CBOR kind the peer will ask for (see protocol.ts).
// Floats are always written as float64; QCBOR reads any float width.
//
// The decoder is lenient (accepts any int/float width, indefinite lengths,
// tags) and returns plain values: maps become Map<string | number, unknown>.

export type CborItem =
  | { t: 'uint'; v: number }
  | { t: 'int'; v: number }
  | { t: 'float'; v: number }
  | { t: 'text'; v: string }
  | { t: 'bytes'; v: Uint8Array }
  | { t: 'bool'; v: boolean }
  | { t: 'null' }
  | { t: 'array'; v: CborItem[] }
  | { t: 'map'; v: [string | number, CborItem][] }

export const cb = {
  uint: (v: number): CborItem => ({ t: 'uint', v: Math.max(0, Math.floor(v)) }),
  int: (v: number): CborItem => ({ t: 'int', v: Math.trunc(v) }),
  float: (v: number): CborItem => ({ t: 'float', v: Number.isFinite(v) ? v : 0 }),
  text: (v: string): CborItem => ({ t: 'text', v }),
  bytes: (v: Uint8Array): CborItem => ({ t: 'bytes', v }),
  bool: (v: boolean): CborItem => ({ t: 'bool', v }),
  array: (v: CborItem[]): CborItem => ({ t: 'array', v }),
  map: (v: [string | number, CborItem][]): CborItem => ({ t: 'map', v })
}

// ── encode ─────────────────────────────────────────────────────────

class Writer {
  private buf = Buffer.alloc(256)
  private pos = 0
  private ensure(n: number): void {
    if (this.pos + n <= this.buf.length) return
    let size = this.buf.length * 2
    while (size < this.pos + n) size *= 2
    const next = Buffer.alloc(size)
    this.buf.copy(next, 0, 0, this.pos)
    this.buf = next
  }
  byte(b: number): void {
    this.ensure(1)
    this.buf[this.pos++] = b
  }
  head(major: number, arg: number): void {
    const m = major << 5
    if (arg < 24) this.byte(m | arg)
    else if (arg < 0x100) {
      this.byte(m | 24)
      this.byte(arg)
    } else if (arg < 0x10000) {
      this.ensure(3)
      this.buf[this.pos++] = m | 25
      this.buf.writeUInt16BE(arg, this.pos)
      this.pos += 2
    } else if (arg < 0x100000000) {
      this.ensure(5)
      this.buf[this.pos++] = m | 26
      this.buf.writeUInt32BE(arg, this.pos)
      this.pos += 4
    } else {
      this.ensure(9)
      this.buf[this.pos++] = m | 27
      this.buf.writeBigUInt64BE(BigInt(arg), this.pos)
      this.pos += 8
    }
  }
  raw(b: Uint8Array): void {
    this.ensure(b.length)
    this.buf.set(b, this.pos)
    this.pos += b.length
  }
  float64(v: number): void {
    this.ensure(9)
    this.buf[this.pos++] = 0xfb
    this.buf.writeDoubleBE(v, this.pos)
    this.pos += 8
  }
  result(): Buffer {
    return this.buf.subarray(0, this.pos)
  }
}

function encodeItem(w: Writer, it: CborItem): void {
  switch (it.t) {
    case 'uint':
      w.head(0, it.v)
      return
    case 'int':
      if (it.v >= 0) w.head(0, it.v)
      else w.head(1, -1 - it.v)
      return
    case 'float':
      w.float64(it.v)
      return
    case 'text': {
      const b = Buffer.from(it.v, 'utf8')
      w.head(3, b.length)
      w.raw(b)
      return
    }
    case 'bytes':
      w.head(2, it.v.length)
      w.raw(it.v)
      return
    case 'bool':
      w.byte(it.v ? 0xf5 : 0xf4)
      return
    case 'null':
      w.byte(0xf6)
      return
    case 'array':
      w.head(4, it.v.length)
      for (const x of it.v) encodeItem(w, x)
      return
    case 'map':
      w.head(5, it.v.length)
      for (const [k, x] of it.v) {
        if (typeof k === 'number') encodeItem(w, { t: 'int', v: k })
        else encodeItem(w, { t: 'text', v: k })
        encodeItem(w, x)
      }
      return
  }
}

export function cborEncode(it: CborItem): Buffer {
  const w = new Writer()
  encodeItem(w, it)
  return w.result()
}

// ── decode ─────────────────────────────────────────────────────────

export type CborValue =
  | number
  | string
  | boolean
  | null
  | undefined
  | Uint8Array
  | CborValue[]
  | Map<string | number, CborValue>

const BREAK = Symbol('break')

class Reader {
  pos = 0
  constructor(private b: Uint8Array) {}
  private need(n: number): void {
    if (this.pos + n > this.b.length) throw new Error('cbor: truncated')
  }
  u8(): number {
    this.need(1)
    return this.b[this.pos++]
  }
  arg(info: number): number {
    if (info < 24) return info
    const v = new DataView(this.b.buffer, this.b.byteOffset, this.b.byteLength)
    if (info === 24) return this.u8()
    if (info === 25) {
      this.need(2)
      const r = v.getUint16(this.pos)
      this.pos += 2
      return r
    }
    if (info === 26) {
      this.need(4)
      const r = v.getUint32(this.pos)
      this.pos += 4
      return r
    }
    if (info === 27) {
      this.need(8)
      const r = Number(v.getBigUint64(this.pos))
      this.pos += 8
      return r
    }
    throw new Error('cbor: bad length encoding')
  }
  bytes(n: number): Uint8Array {
    this.need(n)
    const r = this.b.subarray(this.pos, this.pos + n)
    this.pos += n
    return r
  }
  float(info: number): number {
    const v = new DataView(this.b.buffer, this.b.byteOffset, this.b.byteLength)
    if (info === 25) {
      this.need(2)
      const h = v.getUint16(this.pos)
      this.pos += 2
      return halfToFloat(h)
    }
    if (info === 26) {
      this.need(4)
      const r = v.getFloat32(this.pos)
      this.pos += 4
      return r
    }
    this.need(8)
    const r = v.getFloat64(this.pos)
    this.pos += 8
    return r
  }
}

function halfToFloat(h: number): number {
  const s = h & 0x8000 ? -1 : 1
  const e = (h >> 10) & 0x1f
  const f = h & 0x3ff
  if (e === 0) return s * 2 ** -14 * (f / 1024)
  if (e === 31) return f ? NaN : s * Infinity
  return s * 2 ** (e - 15) * (1 + f / 1024)
}

function decodeItem(r: Reader): CborValue | typeof BREAK {
  const ib = r.u8()
  const major = ib >> 5
  const info = ib & 0x1f
  if (ib === 0xff) return BREAK
  switch (major) {
    case 0:
      return r.arg(info)
    case 1:
      return -1 - r.arg(info)
    case 2:
    case 3: {
      let out: Uint8Array
      if (info === 31) {
        const parts: Uint8Array[] = []
        for (;;) {
          const p = decodeItem(r)
          if (p === BREAK) break
          parts.push(typeof p === 'string' ? Buffer.from(p, 'utf8') : (p as Uint8Array))
        }
        out = Buffer.concat(parts)
      } else {
        out = r.bytes(r.arg(info))
      }
      return major === 3 ? Buffer.from(out).toString('utf8') : Uint8Array.from(out)
    }
    case 4: {
      const arr: CborValue[] = []
      if (info === 31) {
        for (;;) {
          const x = decodeItem(r)
          if (x === BREAK) break
          arr.push(x)
        }
      } else {
        const n = r.arg(info)
        for (let i = 0; i < n; i++) arr.push(decodeItem(r) as CborValue)
      }
      return arr
    }
    case 5: {
      const m = new Map<string | number, CborValue>()
      const readPair = (): boolean => {
        const k = decodeItem(r)
        if (k === BREAK) return false
        const val = decodeItem(r) as CborValue
        if (typeof k === 'string' || typeof k === 'number') m.set(k, val)
        return true
      }
      if (info === 31) {
        while (readPair()) {
          /* until break */
        }
      } else {
        const n = r.arg(info)
        for (let i = 0; i < n; i++) readPair()
      }
      return m
    }
    case 6:
      r.arg(info) // tag number — ignored, decode the tagged content
      return decodeItem(r)
    case 7:
      if (info === 20) return false
      if (info === 21) return true
      if (info === 22) return null
      if (info === 23) return undefined
      if (info === 24) {
        r.u8()
        return undefined
      }
      if (info >= 25 && info <= 27) return r.float(info)
      return undefined
  }
  throw new Error('cbor: bad major type')
}

export function cborDecode(data: Uint8Array): CborValue {
  const r = new Reader(data)
  const v = decodeItem(r)
  if (v === BREAK) throw new Error('cbor: unexpected break')
  return v
}

// ── typed getters for decoded maps (lenient, like the C++ side's
//    "read, reset error, use default" pattern) ───────────────────────

export type CborMap = Map<string | number, CborValue>

export function isMap(v: CborValue): v is CborMap {
  return v instanceof Map
}
export function getStr(m: CborMap, k: string | number, d = ''): string {
  const v = m.get(k)
  return typeof v === 'string' ? v : d
}
export function getNum(m: CborMap, k: string | number, d = 0): number {
  const v = m.get(k)
  if (typeof v === 'number') return v
  if (typeof v === 'boolean') return v ? 1 : 0
  return d
}
export function getBool(m: CborMap, k: string | number, d = false): boolean {
  const v = m.get(k)
  if (typeof v === 'boolean') return v
  if (typeof v === 'number') return v !== 0
  return d
}
export function getMap(m: CborMap, k: string | number): CborMap | null {
  const v = m.get(k)
  return isMap(v) ? v : null
}
export function getArr(m: CborMap, k: string | number): CborValue[] | null {
  const v = m.get(k)
  return Array.isArray(v) ? v : null
}
