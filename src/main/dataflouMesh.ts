// dataFLOU_compositor as a node of the dataflou mesh (v0.6.7).
//
// Wraps a DataflouNode (./dataflou — the TypeScript port of 124_dataflou)
// and maps the open session onto its parameter tree:
//
//   transport/scene    string  source       name of the playing scene
//   transport/playing  bool    source
//   transport/bpm      number  source       session BPM
//   transport/go       bool    destination  true = GO (fire armed cue)
//   transport/stop     bool    destination  true = Stop all
//   scenes/<scene>     bool    bidir        true while playing; true triggers it
//                      (a SETVAL true always fires; a streamed bool on its
//                      rising edge only)
//   meta/<A1..D8>      number  bidir 0..1   Meta Controller knobs (bank A always,
//                                           other banks once they have a destination)
//   instruments/<instrument>/<parameter>
//                      source  what that Parameter row emits (OSC on or off):
//                              1 numeric arg → number, 2–4 → v2/v3/v4,
//                              1 bool → bool, 1 string → string,
//                              anything else → one child per arg
//
// Ranges come from the Parameter's arg min/max (0..1 when unset: the
// library maps by range, a zero span would read as constant 0). Cells with
// Scale 0.0–1.0 on are mapped back into that range before publishing.
//
// The tree is capped at the library's fixed sizes (128 entries, 32
// children per group) so C++/ESP32 peers can hold all of it. It fills in
// order transport → instruments → meta → scenes; what doesn't fit is
// counted in `dropped` and shown in the Mesh tab.

import { app } from 'electron'
import { randomUUID } from 'crypto'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import {
  META_KNOB_COUNT,
  META_KNOBS_PER_BANK,
  type EngineState,
  type MeshAction,
  type MeshConfig,
  type MeshNodeView,
  type MeshParamView,
  type MeshSnapshot,
  type Session,
  type Track
} from '@shared/types'
import type { OscArg } from './engine'
import { DataflouNode, type LocalDecl, type ValueOrigin } from './dataflou/node'
import {
  Access,
  ACCESS_NAMES,
  FLOW_NAMES,
  FlowDir,
  ParamKind,
  ParamType,
  StreamMode,
  TYPE_NAMES,
  defaultMeta,
  type ParamMeta,
  type ParamNode,
  type ParamStore,
  type ParamTypeT,
  type ParamValue
} from './dataflou/model'

const MAX_NODES = 127 // DATAFLOU_MAX_PARAM_NODES (128) minus the root
const MAX_CHILDREN = 32 // DATAFLOU_MAX_CHILDREN
const NAME_MAX = 32 // ParamMeta name / label: etl::string<32>
const META_ALWAYS = META_KNOBS_PER_BANK // bank A is always published
const BANKS = 'ABCD'

interface StoredConfig extends MeshConfig {
  sku: string
}

// How one Parameter row's emitted args become mesh values.
interface TrackBinding {
  editable: number[] | null // arg indices that aren't fixed (null = all)
  min: number
  max: number
  // Single param at `path` (scalar / vector / bool / string)…
  path?: string
  type?: ParamTypeT
  // …or one child param per editable arg.
  split?: { path: string; type: ParamTypeT }[]
}

interface Built {
  decls: LocalDecl[]
  tracks: Map<string, TrackBinding>
  scenes: Map<string, string> // mesh path → scene id
  sceneNames: Map<string, string> // scene id → mesh path
  knobs: Map<string, number> // mesh path → knob index
  dropped: number
  signature: string
}

/** Path segment: no '/', no spaces, ≤ 32 chars. */
function seg(name: string, fallback: string): string {
  const s = name
    .trim()
    .replace(/[\s/]+/g, '_')
    .replace(/[^A-Za-z0-9_.\-+#]/g, '')
    .slice(0, NAME_MAX)
  return s || fallback
}

function uniqueSeg(base: string, used: Set<string>): string {
  let s = base
  for (let i = 2; used.has(s.toLowerCase()); i++) s = `${base.slice(0, NAME_MAX - 3)}_${i}`
  used.add(s.toLowerCase())
  return s
}

function paramMeta(
  name: string,
  label: string,
  type: ParamTypeT,
  flow: number,
  opts: { min?: number; max?: number; rate?: number; streaming?: boolean } = {}
): ParamMeta {
  const m = defaultMeta(name)
  m.type = type
  m.flow = flow as ParamMeta['flow']
  m.access = flow === FlowDir.Source ? Access.Read : flow === FlowDir.Destination ? Access.Write : Access.ReadWrite
  m.mode = opts.streaming ? StreamMode.Streaming : StreamMode.Discrete
  m.rate = opts.rate ?? 0
  m.label = label.slice(0, NAME_MAX)
  if (type === ParamType.Number || type === ParamType.V2 || type === ParamType.V3 || type === ParamType.V4) {
    m.rangeMin = opts.min ?? 0
    m.rangeMax = opts.max ?? 1
    if (m.rangeMax === m.rangeMin) m.rangeMax = m.rangeMin + 1
    m.rangeInit = m.rangeMin
  }
  return m
}

const groupMeta = (name: string, label = name): ParamMeta => {
  const m = defaultMeta(name, ParamKind.Group)
  m.label = label.slice(0, NAME_MAX)
  return m
}

function knobPath(i: number): string {
  return `${BANKS[Math.floor(i / META_KNOBS_PER_BANK)] ?? 'X'}${(i % META_KNOBS_PER_BANK) + 1}`
}

function argType(t: string | undefined): 'num' | 'bool' | 'str' {
  return t === 'bool' ? 'bool' : t === 'string' ? 'str' : 'num'
}

/** Session → local declarations (pure; tested by signature for changes). */
export function buildDecls(session: Session): Built {
  const decls: LocalDecl[] = []
  const tracks = new Map<string, TrackBinding>()
  const scenes = new Map<string, string>()
  const sceneNames = new Map<string, string>()
  const knobs = new Map<string, number>()
  let dropped = 0
  let budget = MAX_NODES
  const add = (d: LocalDecl): boolean => {
    if (budget <= 0) return false
    budget--
    decls.push(d)
    return true
  }
  const rate = Math.max(1, Math.min(300, session.tickRateHz || 60))

  // transport
  add({ path: 'transport', meta: groupMeta('transport') })
  add({ path: 'transport/scene', meta: paramMeta('scene', 'Playing scene', ParamType.String, FlowDir.Source) })
  add({ path: 'transport/playing', meta: paramMeta('playing', 'Playing', ParamType.Bool, FlowDir.Source) })
  add({
    path: 'transport/bpm',
    meta: paramMeta('bpm', 'BPM', ParamType.Number, FlowDir.Source, { min: 10, max: 500 })
  })
  add({ path: 'transport/go', meta: paramMeta('go', 'GO (fire cue)', ParamType.Bool, FlowDir.Destination) })
  add({ path: 'transport/stop', meta: paramMeta('stop', 'Stop all', ParamType.Bool, FlowDir.Destination) })

  // instruments
  const fnTracks = session.tracks.filter((t) => t.kind === 'function')
  if (fnTracks.length && add({ path: 'instruments', meta: groupMeta('instruments') })) {
    const byId = new Map(session.tracks.map((t) => [t.id, t]))
    const instSegs = new Map<string, string>() // parent id ('' = none) → path
    const instUsed = new Set<string>()
    const childUsed = new Map<string, Set<string>>()
    for (const t of fnTracks) {
      const parent = t.parentTrackId ? byId.get(t.parentTrackId) : undefined
      let base = 'instruments'
      if (parent) {
        let ip = instSegs.get(parent.id)
        if (!ip) {
          if (instUsed.size >= MAX_CHILDREN) {
            dropped++
            continue
          }
          const name = uniqueSeg(seg(parent.name, 'instrument'), instUsed)
          ip = `instruments/${name}`
          if (!add({ path: ip, meta: groupMeta(name, parent.name || name) })) {
            dropped++
            continue
          }
          instSegs.set(parent.id, ip)
        }
        base = ip
      }
      let used = childUsed.get(base)
      if (!used) childUsed.set(base, (used = base === 'instruments' ? instUsed : new Set()))
      if (used.size >= MAX_CHILDREN) {
        dropped++
        continue
      }
      const binding = bindTrack(t, base, used, rate, add)
      if (binding) tracks.set(t.id, binding)
      else dropped++
    }
  } else dropped += fnTracks.length

  // meta knobs
  const mk = session.metaController?.knobs ?? []
  const knobIdx: number[] = []
  for (let i = 0; i < Math.min(mk.length, META_KNOB_COUNT); i++) {
    if (i < META_ALWAYS || (mk[i].destinations?.length ?? 0) > 0) knobIdx.push(i)
  }
  if (knobIdx.length && add({ path: 'meta', meta: groupMeta('meta', 'Meta Controller') })) {
    for (const i of knobIdx) {
      const p = `meta/${knobPath(i)}`
      const ok = add({
        path: p,
        meta: paramMeta(knobPath(i), mk[i].name || knobPath(i), ParamType.Number, FlowDir.Bidir, {
          rate: 60,
          streaming: true
        })
      })
      if (ok) knobs.set(p, i)
      else dropped++
    }
  } else dropped += knobIdx.length

  // scenes
  if (session.scenes.length && add({ path: 'scenes', meta: groupMeta('scenes') })) {
    const used = new Set<string>()
    session.scenes.forEach((sc, i) => {
      if (used.size >= MAX_CHILDREN) {
        dropped++
        return
      }
      const name = uniqueSeg(seg(sc.name, `scene${i + 1}`), used)
      const p = `scenes/${name}`
      if (add({ path: p, meta: paramMeta(name, sc.name || name, ParamType.Bool, FlowDir.Bidir) })) {
        scenes.set(p, sc.id)
        sceneNames.set(sc.id, p)
      } else dropped++
    })
  } else dropped += session.scenes.length

  const signature = JSON.stringify(decls.map((d) => [d.path, d.meta]))
  return { decls, tracks, scenes, sceneNames, knobs, dropped, signature }
}

function bindTrack(
  t: Track,
  base: string,
  used: Set<string>,
  rate: number,
  add: (d: LocalDecl) => boolean
): TrackBinding | null {
  const spec = t.argSpec ?? []
  const editable = spec.length ? spec.map((a, i) => (a.fixed === undefined ? i : -1)).filter((i) => i >= 0) : null
  const eSpec = editable ? editable.map((i) => spec[i]) : []
  const kinds = eSpec.map((a) => argType(a.type))
  const nums = eSpec.filter((a) => argType(a.type) === 'num')
  const mins = nums.map((a) => a.min).filter((v): v is number => typeof v === 'number')
  const maxs = nums.map((a) => a.max).filter((v): v is number => typeof v === 'number')
  const min = mins.length ? Math.min(...mins) : 0
  const max = maxs.length ? Math.max(...maxs) : 1
  const name = uniqueSeg(seg(t.name, 'param'), used)
  const p = `${base}/${name}`
  const label = t.name || name
  const numOpts = { min, max: max === min ? min + 1 : max, rate, streaming: true }

  const single = (type: ParamTypeT, opts = {}): TrackBinding | null =>
    add({ path: p, meta: paramMeta(name, label, type, FlowDir.Source, opts) })
      ? { editable, min, max: numOpts.max, path: p, type }
      : null

  if (!editable || editable.length === 0) return single(ParamType.Number, numOpts)
  if (kinds.every((k) => k === 'num') && kinds.length <= 4) {
    const type = [ParamType.Number, ParamType.V2, ParamType.V3, ParamType.V4][kinds.length - 1]
    return single(type, numOpts)
  }
  if (kinds.length === 1) return single(kinds[0] === 'bool' ? ParamType.Bool : ParamType.String)
  // Mixed / long lists: a group with one child per editable arg.
  if (!add({ path: p, meta: groupMeta(name, label) })) return null
  const childUsed = new Set<string>()
  const split: { path: string; type: ParamTypeT }[] = []
  for (let k = 0; k < eSpec.length && k < MAX_CHILDREN; k++) {
    const a = eSpec[k]
    const cn = uniqueSeg(seg(a.name || '', `a${k + 1}`), childUsed)
    const type = kinds[k] === 'bool' ? ParamType.Bool : kinds[k] === 'str' ? ParamType.String : ParamType.Number
    const cOpts =
      type === ParamType.Number
        ? { min: a.min ?? 0, max: a.max ?? (a.min ?? 0) + 1, rate, streaming: true }
        : {}
    if (!add({ path: `${p}/${cn}`, meta: paramMeta(cn, a.name || cn, type, FlowDir.Source, cOpts) })) break
    split.push({ path: `${p}/${cn}`, type })
  }
  return { editable, min, max: numOpts.max, split }
}

// ── values ──────────────────────────────────────────────────────────

function argNum(a: OscArg | undefined): number | null {
  if (!a) return null
  if (a.type === 'T') return 1
  if (a.type === 'F') return 0
  const n = typeof a.value === 'number' ? a.value : Number(a.value)
  return Number.isFinite(n) ? n : null
}

function toValue(type: ParamTypeT, args: (OscArg | undefined)[], unit: boolean, min: number, max: number): ParamValue | null {
  const num = (a: OscArg | undefined): number | null => {
    const n = argNum(a)
    return n === null ? null : unit ? min + n * (max - min) : n
  }
  switch (type) {
    case ParamType.Number: {
      const n = num(args[0])
      return n === null ? null : { tag: type, n }
    }
    case ParamType.V2:
    case ParamType.V3:
    case ParamType.V4: {
      const len = type - ParamType.V2 + 2
      const v: number[] = []
      for (let i = 0; i < len; i++) v.push(num(args[i]) ?? 0)
      return { tag: type, v }
    }
    case ParamType.Bool: {
      const a = args[0]
      if (!a) return null
      return { tag: type, b: a.type === 'T' || (a.type !== 'F' && !!a.value && a.value !== '0' && a.value !== 'false') }
    }
    case ParamType.String:
      return args[0] ? { tag: type, s: String(args[0].value).slice(0, 127) } : null
  }
  return null
}

export function formatValue(v: ParamValue | undefined | null): string {
  if (!v) return ''
  const f = (n: number): string => (Number.isInteger(n) ? String(n) : n.toFixed(Math.abs(n) >= 100 ? 1 : 3))
  switch (v.tag) {
    case ParamType.Bool:
      return v.b ? 'true' : 'false'
    case ParamType.Number:
      return f(v.n ?? 0)
    case ParamType.String:
      return v.s ?? ''
    case ParamType.V2:
    case ParamType.V3:
    case ParamType.V4:
    case ParamType.Colour:
      return (v.v ?? []).map(f).join(' ')
    default:
      return ''
  }
}

/** Parse user text for a SETVAL against the target's type. */
export function parseValue(type: number, text: string): ParamValue | null {
  const t = text.trim()
  if (type === ParamType.Bool) {
    const l = t.toLowerCase()
    if (['true', '1', 'on', 'yes'].includes(l)) return { tag: ParamType.Bool, b: true }
    if (['false', '0', 'off', 'no'].includes(l)) return { tag: ParamType.Bool, b: false }
    return null
  }
  if (type === ParamType.String) return { tag: ParamType.String, s: t.slice(0, 127) }
  const nums = t
    .split(/[\s,]+/)
    .filter(Boolean)
    .map(Number)
  if (!nums.length || nums.some((n) => !Number.isFinite(n))) return null
  if (type === ParamType.Number) return { tag: ParamType.Number, n: nums[0] }
  if (type === ParamType.V2 || type === ParamType.V3 || type === ParamType.V4 || type === ParamType.Colour) {
    const len = type === ParamType.Colour ? 4 : type - ParamType.V2 + 2
    const v = Array.from({ length: len }, (_, i) => nums[i] ?? nums[nums.length - 1])
    return { tag: type as ParamTypeT, v }
  }
  return null
}

function treeView(store: ParamStore, labelOf: (sku: string) => string): MeshParamView[] {
  const out: MeshParamView[] = []
  store.walk((p, n: ParamNode) => {
    const group = n.meta.kind !== ParamKind.Param
    out.push({
      path: p,
      name: n.meta.name,
      label: n.meta.label || n.meta.name,
      depth: p.split('/').length - 1,
      group,
      type: group ? 'group' : (TYPE_NAMES[n.meta.type] ?? 'number'),
      flow: FLOW_NAMES[n.meta.flow] ?? 'source',
      access: ACCESS_NAMES[n.meta.access] ?? 'read',
      min: n.meta.rangeMin,
      max: n.meta.rangeMax,
      unit: n.meta.unit,
      value: group ? '' : formatValue(n.value),
      subs: n.subscriptions.map((s) => ({ sku: s.sourceSku, path: s.sourcePath, label: labelOf(s.sourceSku) }))
    })
  })
  return out
}

// ── agent ───────────────────────────────────────────────────────────

export class MeshAgent {
  private node: DataflouNode | null = null
  private config: StoredConfig
  private session: Session | null = null
  private built: Built | null = null
  private declareTimer: ReturnType<typeof setTimeout> | null = null
  private error: string | null = null
  private lastBool = new Map<string, boolean>()
  private pendingKnobs = new Map<number, number>()
  private knobFlush: ReturnType<typeof setTimeout> | null = null
  private lastSceneId: string | null | undefined = undefined
  private starting: Promise<void> | null = null

  constructor(
    private readonly hooks: {
      triggerScene: (sceneId: string) => void
      stopAll: () => void
      action: (a: MeshAction) => void
    }
  ) {
    this.config = this.loadConfig()
  }

  private configPath(): string {
    return path.join(app.getPath('userData'), 'dataflou-mesh.json')
  }

  private loadConfig(): StoredConfig {
    const host = seg(os.hostname(), 'host').slice(0, 20)
    const def: StoredConfig = { enabled: false, label: `compositor-${host}`.slice(0, NAME_MAX), universe: 'default', sku: randomUUID() }
    try {
      const raw = JSON.parse(fs.readFileSync(this.configPath(), 'utf8')) as Partial<StoredConfig>
      return {
        enabled: raw.enabled === true,
        label: typeof raw.label === 'string' && raw.label.trim() ? raw.label.trim().slice(0, NAME_MAX) : def.label,
        universe: typeof raw.universe === 'string' && raw.universe.trim() ? raw.universe.trim().slice(0, 32) : def.universe,
        sku: typeof raw.sku === 'string' && /^[0-9a-f-]{36}$/i.test(raw.sku) ? raw.sku.toLowerCase() : def.sku
      }
    } catch {
      this.saveConfig(def)
      return def
    }
  }

  private saveConfig(c: StoredConfig): void {
    try {
      fs.mkdirSync(path.dirname(this.configPath()), { recursive: true })
      fs.writeFileSync(this.configPath(), JSON.stringify(c, null, 2))
    } catch {
      /* read-only profile — keep running with the in-memory config */
    }
  }

  async init(): Promise<void> {
    if (this.config.enabled) await this.startNode()
  }

  private appVersion(): number {
    const [a, b, c] = app
      .getVersion()
      .split('.')
      .map((x) => parseInt(x, 10) || 0)
    return a * 10000 + b * 100 + c
  }

  private async startNode(): Promise<void> {
    if (this.node || this.starting) return this.starting ?? undefined
    const node = new DataflouNode({
      identity: {
        sku: this.config.sku,
        label: this.config.label,
        product: 'dataFLOU_compositor',
        version: this.appVersion(),
        state: 0
      },
      universe: this.config.universe,
      storageDir: path.join(app.getPath('userData'), 'dataflou')
    })
    node.on('localValue', (p: string, v: ParamValue, origin: ValueOrigin) => this.onInbound(p, v, origin))
    this.starting = (async () => {
      try {
        await node.start()
        // After start: `built` may have changed while the sockets bound.
        if (this.built) node.replaceLocalParams(this.built.decls)
        this.node = node
        this.error = null
        this.lastSceneId = undefined
        this.publishStatic()
      } catch (e) {
        this.error = (e as Error).message
        node.stop()
      } finally {
        this.starting = null
      }
    })()
    return this.starting
  }

  private stopNode(): void {
    this.node?.stop()
    this.node?.removeAllListeners()
    this.node = null
  }

  shutdown(): void {
    if (this.declareTimer) clearTimeout(this.declareTimer)
    if (this.knobFlush) clearTimeout(this.knobFlush)
    this.stopNode()
  }

  async setConfig(patch: Partial<MeshConfig>): Promise<MeshSnapshot> {
    const next: StoredConfig = { ...this.config }
    if (typeof patch.label === 'string' && patch.label.trim()) next.label = patch.label.trim().slice(0, NAME_MAX)
    if (typeof patch.universe === 'string' && patch.universe.trim()) next.universe = patch.universe.trim().slice(0, 32)
    if (typeof patch.enabled === 'boolean') next.enabled = patch.enabled
    const prev = this.config
    this.config = next
    this.saveConfig(next)
    if (!next.enabled) this.stopNode()
    else if (!this.node) await this.startNode()
    else {
      if (next.label !== prev.label) this.node.setLabel(next.label)
      if (next.universe !== prev.universe) this.node.setUniverse(next.universe)
    }
    return this.snapshot()
  }

  // ── session → tree ───────────────────────────────────────────────

  updateSession(s: Session): void {
    this.session = s
    if (this.declareTimer) return
    // Session pushes arrive on every edit (incl. knob moves): coalesce and
    // only re-DECLARE when the tree's shape actually changed.
    this.declareTimer = setTimeout(() => {
      this.declareTimer = null
      if (!this.session) return
      const b = buildDecls(this.session)
      const changed = !this.built || b.signature !== this.built.signature
      this.built = b
      if (changed && this.node) {
        this.node.replaceLocalParams(b.decls)
        this.lastSceneId = undefined // republish transport/scenes on next state
      }
      this.publishStatic()
    }, 250)
  }

  private publishStatic(): void {
    const n = this.node
    const s = this.session
    if (!n || !s) return
    n.setLocalValue('transport/bpm', { tag: ParamType.Number, n: s.globalBpm })
    for (const [p, i] of this.built?.knobs ?? []) {
      const k = s.metaController?.knobs[i]
      if (k) n.setLocalValue(p, { tag: ParamType.Number, n: k.value })
    }
  }

  // ── engine → mesh ────────────────────────────────────────────────

  onTrackOutput(trackId: string, args: OscArg[], scaleToUnit: boolean): void {
    const n = this.node
    const b = this.built?.tracks.get(trackId)
    if (!n || !b) return
    const picked = b.editable && args.length > Math.max(...b.editable, -1) ? b.editable.map((i) => args[i]) : args
    if (b.path && b.type !== undefined) {
      const v = toValue(b.type, picked, scaleToUnit, b.min, b.max)
      if (v) n.setLocalValue(b.path, v)
      return
    }
    b.split?.forEach((c, i) => {
      const v = toValue(c.type, [picked[i]], scaleToUnit && c.type === ParamType.Number, b.min, b.max)
      if (v) n.setLocalValue(c.path, v)
    })
  }

  onEngineState(st: EngineState): void {
    const n = this.node
    if (!n || !this.built) return
    const id = st.activeSceneId
    if (id === this.lastSceneId) return
    this.lastSceneId = id
    const sc = id ? this.session?.scenes.find((x) => x.id === id) : undefined
    n.setLocalValue('transport/scene', { tag: ParamType.String, s: sc?.name ?? '' })
    n.setLocalValue('transport/playing', { tag: ParamType.Bool, b: !!id })
    for (const [sid, p] of this.built.sceneNames) {
      const on = sid === id
      this.lastBool.set(p, on)
      n.setLocalValue(p, { tag: ParamType.Bool, b: on })
    }
  }

  onMetaValue(index: number, value: number): void {
    const p = `meta/${knobPath(index)}`
    if (this.built?.knobs.has(p)) this.node?.setLocalValue(p, { tag: ParamType.Number, n: value })
  }

  // ── mesh → app ───────────────────────────────────────────────────

  private onInbound(p: string, v: ParamValue, origin: ValueOrigin): void {
    const b = this.built
    if (!b) return
    if (v.tag === ParamType.Bool || p.startsWith('scenes/') || p.startsWith('transport/')) {
      const on = v.tag === ParamType.Bool ? !!v.b : (v.n ?? 0) >= 0.5
      const was = this.lastBool.get(p) ?? false
      this.lastBool.set(p, on)
      // A SETVAL true is a press — it always fires. A streamed bool fires
      // on its rising edge only (it repeats while held).
      if (!on || (was && origin === 'stream')) return
      if (p === 'transport/go' || p === 'transport/stop') {
        if (p === 'transport/go') this.hooks.action({ type: 'go' })
        else this.hooks.stopAll()
        if (origin === 'setval') {
          // Momentary: back to false so the tree reads as a button.
          this.lastBool.set(p, false)
          this.node?.setLocalValue(p, { tag: ParamType.Bool, b: false })
        }
      } else {
        const sceneId = b.scenes.get(p)
        if (sceneId) this.hooks.triggerScene(sceneId)
      }
      return
    }
    const k = b.knobs.get(p)
    if (k !== undefined && v.tag === ParamType.Number) {
      // Coalesce stream bursts into ~60 Hz renderer updates.
      this.pendingKnobs.set(k, Math.max(0, Math.min(1, v.n ?? 0)))
      if (!this.knobFlush) {
        this.knobFlush = setTimeout(() => {
          this.knobFlush = null
          for (const [index, value] of this.pendingKnobs) this.hooks.action({ type: 'metaKnob', index, value })
          this.pendingKnobs.clear()
        }, 16)
      }
    }
  }

  // ── renderer API ─────────────────────────────────────────────────

  subscribe(destSku: string, destPath: string, srcSku: string, srcPath: string, sub: boolean): string | null {
    if (!this.node) return 'Mesh node is off'
    return this.node.subscribeRemote(destSku, destPath, srcSku, srcPath, sub)
  }

  setValue(sku: string, p: string, text: string): string | null {
    const n = this.node
    if (!n) return 'Mesh node is off'
    const target = sku === n.identity.sku ? n.local.resolve(p) : n.world.find(sku)?.params.resolve(p)
    if (!target || target.meta.kind !== ParamKind.Param) return 'Parameter not found'
    const v = parseValue(target.meta.type, text)
    if (!v) return `Not a ${TYPE_NAMES[target.meta.type]} value`
    return n.setValueRemote(sku, p, v)
  }

  flush(sku: string): void {
    this.node?.flushNode(sku)
  }

  snapshot(): MeshSnapshot {
    const n = this.node
    const { sku, ...config } = this.config
    const base: MeshSnapshot = {
      config,
      running: !!n,
      sku,
      port: n?.listenPort ?? 0,
      error: this.error,
      dropped: this.built?.dropped ?? 0,
      streamTargets: 0,
      inbound: 0,
      nodes: [],
      log: []
    }
    if (!n) return base
    const stats = n.stats()
    const labelOf = (s: string): string => n.world.find(s)?.identity.label ?? ''
    const nodes: MeshNodeView[] = []
    for (const e of n.world.nodes) {
      const peer = stats.peers.find((p) => p.sku === e.identity.sku)
      nodes.push({
        sku: e.identity.sku,
        label: e.identity.label,
        product: e.identity.product,
        version: e.identity.version,
        online: e.online,
        isLocal: e.isLocal,
        connected: e.isLocal || !!peer?.connected,
        address: peer ? `${peer.address}:${peer.port}` : '',
        params: treeView(e.params, labelOf)
      })
    }
    nodes.sort((a, b) => Number(b.isLocal) - Number(a.isLocal) || Number(b.online) - Number(a.online) || a.label.localeCompare(b.label))
    return {
      ...base,
      streamTargets: stats.streamTargets,
      inbound: stats.inbound,
      nodes,
      log: n.logLines.slice(-60)
    }
  }
}
