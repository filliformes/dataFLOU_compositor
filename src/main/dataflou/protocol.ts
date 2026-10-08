// dataflou topology protocol — port of src/core/protocol.cpp (protocol v2)
// from 124_dataflou @ ead3801. The CODE is the reference, not docs/protocol.md
// (which still shows v1 string keys and older STREAMREQ field names).
//
// Wire: every message is a CBOR map, framed on TCP as
//   [4 bytes: payload length, big-endian uint32] [payload]
// Common keys: "msg" (text), "seq" (uint), "from" (text sku).
//
// Number kinds matter (QCBOR strict getters on the C++ side):
//   uint  — seq, proto, version, decl_version, listen_port, ack_seq,
//           dest_udp_port, version-vector values
//   int   — DECLARE enum keys, SETVAL vtype
//   float — rate, rate_hz, range min/max/init, smooth, SETVAL number/vector

import {
  cb,
  cborDecode,
  cborEncode,
  getArr,
  getBool,
  getMap,
  getNum,
  getStr,
  isMap,
  type CborItem,
  type CborMap
} from './cbor'
import {
  ParamKind,
  ParamType,
  STATE_NAMES,
  defaultMeta,
  parseNodeState,
  type NodeIdentity,
  type ParamMeta,
  type ParamStore,
  type ParamValue
} from './model'

export const PROTO_VERSION = 2

export type Msg =
  | { msg: 'HELLO'; seq: number; from: string; proto: number; identity: NodeIdentity; versions: Map<string, number>; listenPort: number }
  | { msg: 'DECLARE'; seq: number; from: string; about: string; declVersion: number; identity: NodeIdentity; params: DeclaredParam[] }
  | { msg: 'ACK'; seq: number; from: string; ackSeq: number }
  | { msg: 'LEAVE'; seq: number; from: string }
  | { msg: 'IDENTIFY'; seq: number; from: string }
  | { msg: 'DIGEST'; seq: number; from: string; versions: Map<string, number> }
  | { msg: 'FLUSH'; seq: number; from: string; target: string }
  | { msg: 'BLOB'; seq: number; from: string; target: string; key: string; data: Uint8Array }
  | { msg: 'BLOBREQ'; seq: number; from: string; target: string; key: string }
  | { msg: 'SUBREQ'; seq: number; from: string; sub: boolean; destSku: string; destPath: string; srcSku: string; srcPath: string }
  | { msg: 'SETVAL'; seq: number; from: string; target: string; path: string; value: ParamValue }
  | { msg: 'PADMIN'; seq: number; from: string; target: string; payload: string }
  | { msg: 'STREAMREQ'; seq: number; from: string; sourcePath: string; destPath: string; destSku: string; destUdpPort: number; rateHz: number }
  | { msg: 'STREAMSTOP'; seq: number; from: string; sourcePath: string; destPath: string; destSku: string }
  | { msg: 'SUBANNOUNCE'; seq: number; from: string; sub: boolean; destSku: string; destPath: string; sourceSku: string; sourcePath: string }

export interface DeclaredParam {
  path: string
  meta: ParamMeta
  subscriptions: { sourceSku: string; sourcePath: string }[]
}

// ── framing ─────────────────────────────────────────────────────────

export function frame(payload: Buffer): Buffer {
  const h = Buffer.alloc(4)
  h.writeUInt32BE(payload.length, 0)
  return Buffer.concat([h, payload])
}

// ── encode ──────────────────────────────────────────────────────────

function header(name: string, seq: number, from: string): [string, CborItem][] {
  return [
    ['msg', cb.text(name)],
    ['seq', cb.uint(seq)],
    ['from', cb.text(from)]
  ]
}

function identityItem(id: NodeIdentity): CborItem {
  return cb.map([
    ['sku', cb.text(id.sku)],
    ['label', cb.text(id.label)],
    ['product', cb.text(id.product)],
    ['version', cb.uint(id.version)],
    ['state', cb.text(STATE_NAMES[id.state] ?? 'active')]
  ])
}

function versionsItem(vv: Map<string, number>): CborItem {
  // etl::map iterates in key order; keep the same for byte-stable output.
  return cb.map([...vv.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([k, v]) => [k, cb.uint(v)]))
}

// Vectors travel as one element per component (the C++ core decodes a
// plain number for a vector as a range shared by all components, but older
// cores read it as garbage — an array degrades to "no range" there instead).
function rangeValue(type: number, v: number): CborItem {
  if (type === ParamType.Bool) return cb.bool(v !== 0)
  const n = type === ParamType.V2 ? 2 : type === ParamType.V3 ? 3 : type === ParamType.V4 ? 4 : 0
  if (n) return cb.array(Array.from({ length: n }, () => cb.float(v)))
  return cb.float(v)
}

// One range bound → the port's scalar range: a vector bound (array) folds
// to its lowest (min) / highest (max) / first (init) component.
function rangeBound(range: CborMap, key: 'min' | 'max' | 'init'): number {
  const v = range.get(key)
  if (Array.isArray(v)) {
    const nums = v.filter((x): x is number => typeof x === 'number')
    if (!nums.length) return 0
    return key === 'min' ? Math.min(...nums) : key === 'max' ? Math.max(...nums) : nums[0]
  }
  return getNum(range, key)
}

function paramItem(path: string, m: ParamMeta): CborItem {
  return cb.map([
    [1, cb.text(path)],
    [2, cb.int(m.kind)],
    [3, cb.int(m.type)],
    [4, cb.int(m.mode)],
    [5, cb.int(m.flow)],
    [6, cb.float(m.rate)],
    [7, cb.int(m.access)],
    [8, cb.bool(m.ground)],
    [9, cb.bool(m.hardware)],
    [
      10,
      cb.map([
        ['min', rangeValue(m.type, m.rangeMin)],
        ['max', rangeValue(m.type, m.rangeMax)],
        ['init', rangeValue(m.type, m.rangeInit)]
      ])
    ],
    [11, cb.array([cb.float(m.smoothUp), cb.float(m.smoothDown)])],
    [13, cb.int(m.nature)],
    [17, cb.int(m.topology)],
    [12, cb.text(m.unit)],
    [14, cb.text(m.label)],
    [15, cb.text(m.desc)]
  ])
}

export function encodeHello(seq: number, from: string, identity: NodeIdentity, versions: Map<string, number>, listenPort: number): Buffer {
  return cborEncode(
    cb.map([
      ...header('HELLO', seq, from),
      ['proto', cb.uint(PROTO_VERSION)],
      ['identity', identityItem(identity)],
      ['versions', versionsItem(versions)],
      ['listen_port', cb.uint(listenPort)]
    ])
  )
}

export function encodeDeclare(seq: number, from: string, about: string, declVersion: number, identity: NodeIdentity, params: ParamStore): Buffer {
  const items: CborItem[] = []
  params.walk((path, node) => items.push(paramItem(path, node.meta)))
  return cborEncode(
    cb.map([
      ...header('DECLARE', seq, from),
      ['about', cb.text(about)],
      ['decl_version', cb.uint(declVersion)],
      ['identity', identityItem(identity)],
      ['params', cb.array(items)]
    ])
  )
}

export function encodeAck(seq: number, from: string, ackSeq: number): Buffer {
  return cborEncode(cb.map([...header('ACK', seq, from), ['ack_seq', cb.uint(ackSeq)]]))
}

export function encodeLeave(seq: number, from: string): Buffer {
  return cborEncode(cb.map(header('LEAVE', seq, from)))
}

/** IDENTIFY ("that's me"): visualizers highlight `from`. No payload. */
export function encodeIdentify(seq: number, from: string): Buffer {
  return cborEncode(cb.map(header('IDENTIFY', seq, from)))
}

export function encodeDigest(seq: number, from: string, versions: Map<string, number>): Buffer {
  return cborEncode(cb.map([...header('DIGEST', seq, from), ['versions', versionsItem(versions)]]))
}

export function encodeFlush(seq: number, from: string, target: string): Buffer {
  return cborEncode(cb.map([...header('FLUSH', seq, from), ['target', cb.text(target)]]))
}

export function encodeBlob(seq: number, from: string, target: string, key: string, data: Uint8Array): Buffer {
  return cborEncode(
    cb.map([...header('BLOB', seq, from), ['target', cb.text(target)], ['key', cb.text(key)], ['data', cb.bytes(data)]])
  )
}

export function encodeBlobReq(seq: number, from: string, target: string, key: string): Buffer {
  return cborEncode(cb.map([...header('BLOBREQ', seq, from), ['target', cb.text(target)], ['key', cb.text(key)]]))
}

export function encodeSubRequest(seq: number, from: string, sub: boolean, destSku: string, destPath: string, srcSku: string, srcPath: string): Buffer {
  return cborEncode(
    cb.map([
      ...header('SUBREQ', seq, from),
      ['sub', cb.bool(sub)],
      ['dest_sku', cb.text(destSku)],
      ['dest_path', cb.text(destPath)],
      ['src_sku', cb.text(srcSku)],
      ['src_path', cb.text(srcPath)]
    ])
  )
}

function valueItem(v: ParamValue): CborItem | null {
  switch (v.tag) {
    case ParamType.Bool:
      return cb.bool(!!v.b)
    case ParamType.Number:
      return cb.float(v.n ?? 0)
    case ParamType.String:
      return cb.text(v.s ?? '')
    case ParamType.V2:
    case ParamType.V3:
    case ParamType.V4: {
      const dim = v.tag === ParamType.V2 ? 2 : v.tag === ParamType.V3 ? 3 : 4
      const c = v.v ?? []
      return cb.array(Array.from({ length: dim }, (_, i) => cb.float(c[i] ?? 0)))
    }
    case ParamType.Colour: {
      const c = v.v ?? [0, 0, 0, 255]
      return cb.array([0, 1, 2, 3].map((i) => cb.int(c[i] ?? 0)))
    }
  }
  return null
}

export function encodeSetValue(seq: number, from: string, target: string, path: string, value: ParamValue): Buffer {
  const entries: [string, CborItem][] = [
    ...header('SETVAL', seq, from),
    ['target', cb.text(target)],
    ['path', cb.text(path)],
    ['vtype', cb.int(value.tag)]
  ]
  const vi = valueItem(value)
  if (vi) entries.push(['val', vi])
  return cborEncode(cb.map(entries))
}

export function encodeParamAdmin(seq: number, from: string, target: string, payload: string): Buffer {
  return cborEncode(cb.map([...header('PADMIN', seq, from), ['target', cb.text(target)], ['payload', cb.text(payload)]]))
}

export function encodeStreamRequest(seq: number, from: string, sourcePath: string, destPath: string, destSku: string, destUdpPort: number, rateHz: number): Buffer {
  return cborEncode(
    cb.map([
      ...header('STREAMREQ', seq, from),
      ['source_path', cb.text(sourcePath)],
      ['dest_path', cb.text(destPath)],
      ['dest_sku', cb.text(destSku)],
      ['dest_udp_port', cb.uint(destUdpPort)],
      ['rate_hz', cb.float(rateHz)]
    ])
  )
}

export function encodeStreamStop(seq: number, from: string, sourcePath: string, destPath: string, destSku: string): Buffer {
  return cborEncode(
    cb.map([
      ...header('STREAMSTOP', seq, from),
      ['source_path', cb.text(sourcePath)],
      ['dest_path', cb.text(destPath)],
      ['dest_sku', cb.text(destSku)]
    ])
  )
}

export function encodeSubAnnounce(seq: number, from: string, sub: boolean, destSku: string, destPath: string, sourceSku: string, sourcePath: string): Buffer {
  return cborEncode(
    cb.map([
      ...header('SUBANNOUNCE', seq, from),
      ['sub', cb.bool(sub)],
      ['dest_sku', cb.text(destSku)],
      ['dest_path', cb.text(destPath)],
      ['source_sku', cb.text(sourceSku)],
      ['source_path', cb.text(sourcePath)]
    ])
  )
}

// ── decode ──────────────────────────────────────────────────────────

function decodeIdentity(m: CborMap | null): NodeIdentity {
  return {
    sku: m ? getStr(m, 'sku') : '',
    label: m ? getStr(m, 'label') : '',
    product: m ? getStr(m, 'product') : '',
    version: m ? getNum(m, 'version') : 0,
    state: m ? parseNodeState(getStr(m, 'state', 'active')) : 0
  }
}

function decodeVersions(m: CborMap | null): Map<string, number> {
  const out = new Map<string, number>()
  if (!m) return out
  for (const [k, v] of m) if (typeof k === 'string' && typeof v === 'number') out.set(k, v)
  return out
}

function decodeValue(vtype: number, raw: unknown): ParamValue {
  switch (vtype) {
    case ParamType.Bool:
      return { tag: ParamType.Bool, b: raw === true || (typeof raw === 'number' && raw !== 0) }
    case ParamType.Number:
      return { tag: ParamType.Number, n: typeof raw === 'number' ? raw : 0 }
    case ParamType.String:
      return { tag: ParamType.String, s: typeof raw === 'string' ? raw : '' }
    case ParamType.V2:
    case ParamType.V3:
    case ParamType.V4: {
      const dim = vtype === ParamType.V2 ? 2 : vtype === ParamType.V3 ? 3 : 4
      const a = Array.isArray(raw) ? raw : []
      return {
        tag: vtype,
        v: Array.from({ length: dim }, (_, i) => Math.fround(typeof a[i] === 'number' ? (a[i] as number) : 0))
      }
    }
    case ParamType.Colour: {
      const a = Array.isArray(raw) ? raw : []
      return { tag: ParamType.Colour, v: [0, 1, 2, 3].map((i) => (typeof a[i] === 'number' ? (a[i] as number) & 0xff : 0)) }
    }
  }
  return { tag: ParamType.Number, n: 0 }
}

function decodeParam(m: CborMap): DeclaredParam {
  const path = getStr(m, 1)
  const name = path.split('/').filter(Boolean).pop() ?? ''
  const meta = defaultMeta(name)
  meta.kind = getNum(m, 2) as ParamMeta['kind']
  meta.type = getNum(m, 3, ParamType.Number) as ParamMeta['type']
  meta.mode = getNum(m, 4) as ParamMeta['mode']
  meta.flow = getNum(m, 5) as ParamMeta['flow']
  meta.rate = getNum(m, 6)
  meta.access = getNum(m, 7) as ParamMeta['access']
  meta.ground = getBool(m, 8)
  meta.hardware = getBool(m, 9)
  const range = getMap(m, 10)
  if (range) {
    meta.rangeMin = rangeBound(range, 'min')
    meta.rangeMax = rangeBound(range, 'max')
    meta.rangeInit = rangeBound(range, 'init')
  }
  const smooth = getArr(m, 11)
  if (smooth) {
    meta.smoothUp = typeof smooth[0] === 'number' ? smooth[0] : 0
    meta.smoothDown = typeof smooth[1] === 'number' ? smooth[1] : 0
  }
  meta.nature = getNum(m, 13) as ParamMeta['nature']
  meta.topology = getNum(m, 17) as ParamMeta['topology']
  meta.unit = getStr(m, 12)
  meta.label = getStr(m, 14) || name
  meta.desc = getStr(m, 15)
  const subs: DeclaredParam['subscriptions'] = []
  for (const s of getArr(m, 16) ?? []) {
    if (isMap(s)) subs.push({ sourceSku: getStr(s, 'sku'), sourcePath: getStr(s, 'path') })
  }
  return { path, meta, subscriptions: subs }
}

/** Decode one framed payload. Returns null for an unknown/garbled message. */
export function decodeMsg(payload: Uint8Array): Msg | null {
  let root: unknown
  try {
    root = cborDecode(payload)
  } catch {
    return null
  }
  if (!isMap(root as never)) return null
  const m = root as CborMap
  const msg = getStr(m, 'msg')
  const seq = getNum(m, 'seq')
  const from = getStr(m, 'from')
  switch (msg) {
    case 'HELLO':
      return {
        msg,
        seq,
        from,
        proto: getNum(m, 'proto', 1),
        identity: decodeIdentity(getMap(m, 'identity')),
        versions: decodeVersions(getMap(m, 'versions')),
        listenPort: getNum(m, 'listen_port')
      }
    case 'DECLARE':
      return {
        msg,
        seq,
        from,
        about: getStr(m, 'about'),
        declVersion: getNum(m, 'decl_version'),
        identity: decodeIdentity(getMap(m, 'identity')),
        params: (getArr(m, 'params') ?? []).filter(isMap).map((p) => decodeParam(p as CborMap))
      }
    case 'ACK':
      return { msg, seq, from, ackSeq: getNum(m, 'ack_seq') }
    case 'LEAVE':
    case 'IDENTIFY':
      return { msg, seq, from }
    case 'DIGEST':
      return { msg, seq, from, versions: decodeVersions(getMap(m, 'versions')) }
    case 'FLUSH':
      return { msg, seq, from, target: getStr(m, 'target') }
    case 'BLOB': {
      const d = m.get('data')
      return { msg, seq, from, target: getStr(m, 'target'), key: getStr(m, 'key'), data: d instanceof Uint8Array ? d : new Uint8Array() }
    }
    case 'BLOBREQ':
      return { msg, seq, from, target: getStr(m, 'target'), key: getStr(m, 'key') }
    case 'SUBREQ':
      return {
        msg,
        seq,
        from,
        sub: getBool(m, 'sub', true),
        destSku: getStr(m, 'dest_sku'),
        destPath: getStr(m, 'dest_path'),
        srcSku: getStr(m, 'src_sku'),
        srcPath: getStr(m, 'src_path')
      }
    case 'SETVAL': {
      const vtype = getNum(m, 'vtype', ParamType.Number)
      return { msg, seq, from, target: getStr(m, 'target'), path: getStr(m, 'path'), value: decodeValue(vtype, m.get('val')) }
    }
    case 'PADMIN':
      return { msg, seq, from, target: getStr(m, 'target'), payload: getStr(m, 'payload') }
    case 'STREAMREQ':
      return {
        msg,
        seq,
        from,
        sourcePath: getStr(m, 'source_path'),
        destPath: getStr(m, 'dest_path'),
        destSku: getStr(m, 'dest_sku'),
        destUdpPort: getNum(m, 'dest_udp_port'),
        rateHz: getNum(m, 'rate_hz')
      }
    case 'STREAMSTOP':
      return { msg, seq, from, sourcePath: getStr(m, 'source_path'), destPath: getStr(m, 'dest_path'), destSku: getStr(m, 'dest_sku') }
    case 'SUBANNOUNCE':
      return {
        msg,
        seq,
        from,
        sub: getBool(m, 'sub', true),
        destSku: getStr(m, 'dest_sku'),
        destPath: getStr(m, 'dest_path'),
        sourceSku: getStr(m, 'source_sku'),
        sourcePath: getStr(m, 'source_path')
      }
  }
  return null
}

/** Rebuild a ParamStore from a DECLARE's flat param list (groups + params). */
export function applyDeclared(store: ParamStore, params: DeclaredParam[]): void {
  store.clear()
  for (const p of params) {
    const node =
      p.meta.kind === ParamKind.Group ? store.declareGroup(p.path, p.meta) : store.declareParam(p.path, p.meta)
    if (node && p.subscriptions.length) node.subscriptions = p.subscriptions.map((s) => ({ ...s }))
  }
}
