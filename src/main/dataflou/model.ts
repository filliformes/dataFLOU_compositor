// dataflou data model — port of include/dataflou/types.h, param.h/param.cpp
// (ParamStore), world_view.h/.cpp (WorldView) and value_cast.h, from
// 124_dataflou @ ead3801. Enum ORDINALS are wire values (DECLARE int keys,
// SETVAL vtype, UDP type tag) — never reorder them.

export const ParamKind = { Class: 0, Group: 1, Param: 2 } as const
export const ParamType = {
  Bool: 0,
  Number: 1,
  String: 2,
  V2: 3,
  V3: 4,
  V4: 5,
  Blob: 6,
  Colour: 7
} as const
export const FlowDir = { Source: 0, Destination: 1, Bidir: 2 } as const
export const StreamMode = { Streaming: 0, Discrete: 1, Polling: 2 } as const
export const Access = { Read: 0, Write: 1, ReadWrite: 2 } as const
export const Nature = { Lin: 0, Log: 1, Exp: 2 } as const
export const Topology = { Span: 0, Centered: 1, Cyclic: 2, Free: 3 } as const
export const NodeState = { Active: 0, Idle: 1, Disabled: 2, Error: 3 } as const

export type ParamKindT = (typeof ParamKind)[keyof typeof ParamKind]
export type ParamTypeT = (typeof ParamType)[keyof typeof ParamType]
export type FlowDirT = (typeof FlowDir)[keyof typeof FlowDir]
export type StreamModeT = (typeof StreamMode)[keyof typeof StreamMode]
export type AccessT = (typeof Access)[keyof typeof Access]
export type NatureT = (typeof Nature)[keyof typeof Nature]
export type TopologyT = (typeof Topology)[keyof typeof Topology]

export const TYPE_NAMES = ['bool', 'number', 'string', 'v2', 'v3', 'v4', 'blob', 'colour'] as const
export const FLOW_NAMES = ['source', 'destination', 'bidir'] as const
export const MODE_NAMES = ['streaming', 'discrete', 'polling'] as const
export const ACCESS_NAMES = ['read', 'write', 'readwrite'] as const
export const NATURE_NAMES = ['lin', 'log', 'exp'] as const
export const STATE_NAMES = ['active', 'idle', 'disabled', 'error'] as const

export function parseNodeState(s: string): number {
  const i = (STATE_NAMES as readonly string[]).indexOf(s)
  return i < 0 ? NodeState.Active : i
}

// Tagged value. `v` holds the components for V2/V3/V4 (float32 on the
// UDP wire) and the 0..255 bytes for Colour; `s` holds String/Blob.
export interface ParamValue {
  tag: ParamTypeT
  b?: boolean
  n?: number
  v?: number[]
  s?: string
}

export function defaultValue(tag: ParamTypeT, init = 0): ParamValue {
  switch (tag) {
    case ParamType.Bool:
      return { tag, b: init !== 0 }
    case ParamType.Number:
      return { tag, n: init }
    case ParamType.String:
    case ParamType.Blob:
      return { tag, s: '' }
    case ParamType.V2:
      return { tag, v: [init, init] }
    case ParamType.V3:
      return { tag, v: [init, init, init] }
    case ParamType.V4:
      return { tag, v: [init, init, init, init] }
    case ParamType.Colour:
      return { tag, v: [0, 0, 0, 255] }
  }
  return { tag: ParamType.Number, n: 0 }
}

export function sameValue(a: ParamValue, b: ParamValue): boolean {
  if (a.tag !== b.tag) return false
  switch (a.tag) {
    case ParamType.Bool:
      return a.b === b.b
    case ParamType.Number:
      return a.n === b.n
    case ParamType.String:
    case ParamType.Blob:
      return a.s === b.s
    default: {
      const x = a.v ?? []
      const y = b.v ?? []
      return x.length === y.length && x.every((c, i) => c === y[i])
    }
  }
}

export interface ParamMeta {
  name: string // tree key (path segment), no spaces
  kind: ParamKindT
  type: ParamTypeT
  mode: StreamModeT
  flow: FlowDirT
  access: AccessT
  nature: NatureT
  topology: TopologyT
  rate: number
  ground: boolean
  hardware: boolean
  smoothUp: number
  smoothDown: number
  // Ranges travel as scalars on the wire (DECLARE key 10 = {min,max,init}
  // doubles); vectors share one scalar range across components.
  rangeMin: number
  rangeMax: number
  rangeInit: number
  unit: string
  label: string
  desc: string
}

export function defaultMeta(name: string, kind: ParamKindT = ParamKind.Param): ParamMeta {
  return {
    name,
    kind,
    type: ParamType.Number,
    mode: StreamMode.Discrete,
    flow: FlowDir.Source,
    access: Access.Read,
    nature: Nature.Lin,
    topology: Topology.Span,
    rate: 0,
    ground: false,
    hardware: false,
    smoothUp: 0,
    smoothDown: 0,
    rangeMin: 0,
    rangeMax: 0,
    rangeInit: 0,
    unit: '',
    label: name,
    desc: ''
  }
}

export interface ParamSubscription {
  sourceSku: string
  sourcePath: string
}

export interface ParamNode {
  meta: ParamMeta
  value: ParamValue
  timestampMs: number
  changeEpoch: number
  dirty: boolean
  parent: ParamNode | null
  children: ParamNode[]
  subscriptions: ParamSubscription[]
}

const MAX_SUBS_PER_PARAM = 4 // DATAFLOU_MAX_SUBS_PER_PARAM

function newNode(meta: ParamMeta, parent: ParamNode | null): ParamNode {
  return {
    meta,
    value: defaultValue(meta.type, meta.rangeInit),
    timestampMs: 0,
    changeEpoch: 0,
    dirty: false,
    parent,
    children: [],
    subscriptions: []
  }
}

function segments(path: string): string[] {
  return path.split('/').filter((s) => s.length > 0)
}

// ── ParamStore (param.cpp) ──────────────────────────────────────────

export class ParamStore {
  readonly root: ParamNode = newNode(defaultMeta('root', ParamKind.Group), null)

  clear(): void {
    this.root.children = []
  }

  resolve(path: string): ParamNode | null {
    let cur: ParamNode | null = this.root
    for (const seg of segments(path)) {
      cur = cur?.children.find((c) => c.meta.name === seg) ?? null
      if (!cur) return null
    }
    return cur
  }

  private findOrCreateGroup(segs: string[]): ParamNode {
    let cur = this.root
    for (const seg of segs) {
      let next = cur.children.find((c) => c.meta.name === seg)
      if (!next) {
        next = newNode(defaultMeta(seg, ParamKind.Group), cur)
        cur.children.push(next)
      }
      cur = next
    }
    return cur
  }

  // Path = full location; parents auto-created; an existing child with the
  // same name has its meta replaced in place (value / subscriptions kept).
  private declare(path: string, meta: ParamMeta, kind: ParamKindT): ParamNode | null {
    const segs = segments(path)
    const name = segs.pop()
    if (!name) return null
    const parent = this.findOrCreateGroup(segs)
    const m: ParamMeta = { ...meta, kind, name: meta.name || name }
    if (!m.label) m.label = name
    const existing = parent.children.find((c) => c.meta.name === name)
    if (existing) {
      const typeChanged = existing.meta.type !== m.type
      existing.meta = m
      if (typeChanged && kind === ParamKind.Param) existing.value = defaultValue(m.type, m.rangeInit)
      return existing
    }
    const node = newNode(m, parent)
    parent.children.push(node)
    return node
  }

  declareGroup(path: string, meta: ParamMeta): ParamNode | null {
    return this.declare(path, meta, ParamKind.Group)
  }

  declareParam(path: string, meta: ParamMeta): ParamNode | null {
    return this.declare(path, meta, ParamKind.Param)
  }

  remove(path: string): boolean {
    const node = this.resolve(path)
    if (!node || !node.parent) return false
    node.parent.children = node.parent.children.filter((c) => c !== node)
    return true
  }

  setValue(path: string, val: ParamValue, nowMs = Date.now()): ParamNode | null {
    const node = this.resolve(path)
    if (!node || node.meta.kind !== ParamKind.Param) return null
    node.value = val
    node.dirty = true
    node.changeEpoch++
    node.timestampMs = nowMs
    return node
  }

  subscribe(localPath: string, sourceSku: string, sourcePath: string): boolean {
    const node = this.resolve(localPath)
    if (!node || node.meta.kind !== ParamKind.Param) return false
    if (node.subscriptions.some((s) => s.sourceSku === sourceSku && s.sourcePath === sourcePath)) {
      return true
    }
    if (node.subscriptions.length >= MAX_SUBS_PER_PARAM) return false
    node.subscriptions.push({ sourceSku, sourcePath })
    return true
  }

  unsubscribe(localPath: string, sourceSku: string, sourcePath: string): boolean {
    const node = this.resolve(localPath)
    if (!node) return false
    const before = node.subscriptions.length
    node.subscriptions = node.subscriptions.filter(
      (s) => !(s.sourceSku === sourceSku && s.sourcePath === sourcePath)
    )
    return node.subscriptions.length < before
  }

  // Pre-order walk in DECLARE order: each child, then its children.
  walk(fn: (path: string, node: ParamNode) => void): void {
    const rec = (node: ParamNode, prefix: string): void => {
      for (const c of node.children) {
        const p = prefix ? `${prefix}/${c.meta.name}` : c.meta.name
        fn(p, c)
        if (c.children.length) rec(c, p)
      }
    }
    rec(this.root, '')
  }

  // Deep copy (what C++ does with `self->params = local_params_`).
  clone(): ParamStore {
    const out = new ParamStore()
    const rec = (src: ParamNode, dst: ParamNode): void => {
      for (const c of src.children) {
        const n: ParamNode = {
          meta: { ...c.meta },
          value: { ...c.value, ...(c.value.v ? { v: [...c.value.v] } : {}) },
          timestampMs: c.timestampMs,
          changeEpoch: c.changeEpoch,
          dirty: c.dirty,
          parent: dst,
          children: [],
          subscriptions: c.subscriptions.map((s) => ({ ...s }))
        }
        dst.children.push(n)
        rec(c, n)
      }
    }
    rec(this.root, out.root)
    return out
  }

  pathOf(node: ParamNode): string {
    const parts: string[] = []
    let p: ParamNode | null = node
    while (p && p.parent) {
      parts.unshift(p.meta.name)
      p = p.parent
    }
    return parts.join('/')
  }
}

// ── WorldView (world_view.cpp) ──────────────────────────────────────

export interface NodeIdentity {
  sku: string
  label: string
  product: string
  version: number
  state: number
}

export interface NodeEntry {
  identity: NodeIdentity
  declVersion: number
  isLocal: boolean
  online: boolean
  lastSeenMs: number
  firstSeenMs: number
  params: ParamStore
}

export class WorldView {
  readonly nodes: NodeEntry[] = []

  find(sku: string): NodeEntry | null {
    return this.nodes.find((n) => n.identity.sku === sku) ?? null
  }

  upsert(sku: string): NodeEntry {
    const e = this.find(sku)
    if (e) return e
    const entry: NodeEntry = {
      identity: { sku, label: '', product: '', version: 0, state: NodeState.Active },
      declVersion: 0,
      isLocal: false,
      online: false,
      lastSeenMs: 0,
      firstSeenMs: 0,
      params: new ParamStore()
    }
    this.nodes.push(entry)
    return entry
  }

  remove(sku: string): boolean {
    const i = this.nodes.findIndex((n) => n.identity.sku === sku)
    if (i < 0) return false
    this.nodes.splice(i, 1)
    return true
  }

  // Grounding: params declared `ground` fall back to their init value when
  // their owner goes offline.
  markOffline(sku: string): void {
    const e = this.find(sku)
    if (!e) return
    e.online = false
    e.params.walk((_p, n) => {
      if (n.meta.kind === ParamKind.Param && n.meta.ground) {
        n.value = defaultValue(n.meta.type, n.meta.rangeInit)
        n.dirty = true
        n.changeEpoch++
      }
    })
  }

  markOnline(sku: string, nowMs: number): void {
    const e = this.find(sku)
    if (!e) return
    e.online = true
    e.lastSeenMs = nowMs
    if (e.firstSeenMs === 0) e.firstSeenMs = nowMs
  }

  versionVector(): Map<string, number> {
    const vv = new Map<string, number>()
    for (const n of this.nodes) vv.set(n.identity.sku, n.declVersion)
    return vv
  }
}

// ── value_cast.h ────────────────────────────────────────────────────

export function canCast(src: number, dst: number): boolean {
  if (src === dst) return true
  if (src === ParamType.String || src === ParamType.Blob) return false
  if (dst === ParamType.String || dst === ParamType.Blob) return false
  return true
}

const f32 = Math.fround
const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v)
const clampU8 = (v: number): number => (v < 0 ? 0 : v > 255 ? 255 : Math.round(v))

function toNumber(v: ParamValue): number {
  switch (v.tag) {
    case ParamType.Bool:
      return v.b ? 1 : 0
    case ParamType.Number:
      return v.n ?? 0
    case ParamType.V2:
    case ParamType.V3:
    case ParamType.V4:
      return v.v?.[0] ?? 0
    case ParamType.Colour:
      return (v.v?.[0] ?? 0) / 255
  }
  return 0
}

function toBool(v: ParamValue): boolean {
  switch (v.tag) {
    case ParamType.Bool:
      return !!v.b
    case ParamType.Number:
      return (v.n ?? 0) !== 0
    case ParamType.V2:
    case ParamType.V3:
    case ParamType.V4:
    case ParamType.Colour:
      return (v.v ?? []).some((c) => c !== 0)
  }
  return false
}

function toFloats(v: ParamValue): { f: number[]; count: number } {
  switch (v.tag) {
    case ParamType.Bool: {
      const x = v.b ? 1 : 0
      return { f: [x, x, x, x], count: 1 }
    }
    case ParamType.Number: {
      const x = f32(v.n ?? 0)
      return { f: [x, x, x, x], count: 1 }
    }
    case ParamType.V2:
      return { f: [v.v?.[0] ?? 0, v.v?.[1] ?? 0, 0, 0], count: 2 }
    case ParamType.V3:
      return { f: [v.v?.[0] ?? 0, v.v?.[1] ?? 0, v.v?.[2] ?? 0, 0], count: 3 }
    case ParamType.V4:
      return { f: [v.v?.[0] ?? 0, v.v?.[1] ?? 0, v.v?.[2] ?? 0, v.v?.[3] ?? 0], count: 4 }
    case ParamType.Colour:
      return { f: (v.v ?? [0, 0, 0, 0]).slice(0, 4).map((c) => f32(c / 255)), count: 4 }
  }
  return { f: [0, 0, 0, 0], count: 0 }
}

export function valueCast(src: ParamValue, dst: ParamTypeT): ParamValue | null {
  if (src.tag === dst) return src
  if (!canCast(src.tag, dst)) return null
  const { f, count: fc } = toFloats(src)
  switch (dst) {
    case ParamType.Bool:
      return { tag: dst, b: toBool(src) }
    case ParamType.Number:
      return { tag: dst, n: toNumber(src) }
    case ParamType.V2:
      return { tag: dst, v: [f[0], fc >= 2 ? f[1] : f[0]] }
    case ParamType.V3:
      return { tag: dst, v: [f[0], fc >= 2 ? f[1] : f[0], fc >= 3 ? f[2] : fc === 1 ? f[0] : 0] }
    case ParamType.V4:
      return {
        tag: dst,
        v: [
          f[0],
          fc >= 2 ? f[1] : f[0],
          fc >= 3 ? f[2] : fc === 1 ? f[0] : 0,
          fc >= 4 ? f[3] : fc === 1 ? f[0] : 0
        ]
      }
    case ParamType.Colour:
      if (src.tag === ParamType.Bool) {
        const x = src.b ? 255 : 0
        return { tag: dst, v: [x, x, x, 255] }
      }
      return {
        tag: dst,
        v: [
          clampU8(clamp01(f[0]) * 255),
          clampU8(clamp01(f[1]) * 255),
          clampU8(clamp01(fc >= 3 ? f[2] : f[0]) * 255),
          clampU8(clamp01(fc >= 4 ? f[3] : 1) * 255)
        ]
      }
  }
  return null
}

// ── receiver-side range mapping (node.cpp normalize_value) ──────────
//
// Same type: map the source range onto the destination range per
// component. Cross type: normalize the source to 0-1, value_cast, scale to
// the destination range. A zero-span source range maps to the destination
// minimum — exactly as the C++ node does.
//
// One deliberate divergence: the wire carries ONE scalar range, which the
// C++ decoder stores in the union's `n` and then reads back as float
// components for vectors (garbage ranges). Here vectors use the scalar
// range for every component, which is what the declaration means.

// Range mapping, as node.cpp normalize_value. A zero-width range (min ==
// max) means "no range declared": the value passes through unchanged rather
// than collapsing to the destination minimum.
const emptySpan = (min: number, max: number): boolean => max === min
const mapRange = (v: number, s0: number, s1: number, d0: number, d1: number): number =>
  emptySpan(s0, s1) || emptySpan(d0, d1) ? v : d0 + clamp01((v - s0) / (s1 - s0)) * (d1 - d0)
const toUnit = (v: number, s0: number, s1: number): number => (emptySpan(s0, s1) ? v : clamp01((v - s0) / (s1 - s0)))
const fromUnit = (t: number, d0: number, d1: number): number => (emptySpan(d0, d1) ? t : d0 + t * (d1 - d0))

export function normalizeValue(val: ParamValue, src: ParamMeta, dst: ParamMeta): ParamValue {
  const isVec = (t: number): boolean => t === ParamType.V2 || t === ParamType.V3 || t === ParamType.V4
  if (src.type === dst.type) {
    if (src.type === ParamType.Number) {
      return { tag: val.tag, n: mapRange(val.n ?? 0, src.rangeMin, src.rangeMax, dst.rangeMin, dst.rangeMax) }
    }
    if (isVec(src.type)) {
      return {
        tag: val.tag,
        v: (val.v ?? []).map((c) => f32(mapRange(c, src.rangeMin, src.rangeMax, dst.rangeMin, dst.rangeMax)))
      }
    }
    return val
  }
  if (!canCast(src.type, dst.type)) return val
  let normalized: ParamValue = val
  if (src.type === ParamType.Number) {
    normalized = { tag: val.tag, n: toUnit(val.n ?? 0, src.rangeMin, src.rangeMax) }
  } else if (isVec(src.type)) {
    normalized = { tag: val.tag, v: (val.v ?? []).map((c) => f32(toUnit(c, src.rangeMin, src.rangeMax))) }
  }
  const casted = valueCast(normalized, dst.type)
  if (!casted) return val
  // Scale the casted 0..1 value into the destination range once.
  if (dst.type === ParamType.Number) {
    return { tag: casted.tag, n: fromUnit(casted.n ?? 0, dst.rangeMin, dst.rangeMax) }
  }
  if (isVec(dst.type)) {
    return { tag: casted.tag, v: (casted.v ?? []).map((c) => f32(fromUnit(c, dst.rangeMin, dst.rangeMax))) }
  }
  return casted
}
