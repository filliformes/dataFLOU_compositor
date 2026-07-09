// OSC monitor — bottom drawer hosting two panes:
//   1. OSC log (left, larger)  — outgoing OSC traffic, the original use.
//   2. Pool (right)            — Instrument Templates + Functions library.
//
// The Instruments Inspector lives in the EDIT VIEW's right-side Inspector
// panel (not in this drawer) — it needs more vertical room than a bottom
// drawer can give, and it's where every other inspector already lives.
// Selecting an item in the Pool re-points that Inspector at the Pool item.
//
// Default-off (per the simplex principle). The toggle lives in the top
// toolbar. When closed, this component unmounts entirely — no subscription,
// no memory cost.

import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type {
  MidiBinding,
  MidiErrorEvent,
  MidiSendEvent,
  OscErrorEvent,
  OscEvent,
  Session
} from '@shared/types'
import { useStore } from '../store'
import PoolPane from './PoolPane'
import { ResizeHandle } from './ResizeHandle'

// Discriminated-union row so the log can interleave successful sends
// with failures. Kind is the only distinguishing field; everything else
// lines up with OscEvent / OscErrorEvent structurally.
type MonitorRow =
  | ({ kind: 'ok' } & OscEvent)
  | ({ kind: 'err' } & OscErrorEvent)

// Same idea for the parallel MIDI stream — `ok` for successful sends,
// `err` for port-open or send failures from the native sender.
// `rowKind` (not `kind`) because MidiSendEvent already has a `kind`
// field (cc / noteOn / noteOff) and TypeScript can't discriminate
// against a field both halves share.
type MidiMonitorRow =
  | ({ rowKind: 'ok' } & MidiSendEvent)
  | ({ rowKind: 'err' } & MidiErrorEvent)

// Hard cap on in-memory rows. At 120Hz × 4 active cells we see ~500 msg/sec,
// so 1000 rows ≈ 2 seconds of history. Enough to eyeball, small enough to
// render cheaply in the DOM. If we need longer history later, switch to a
// virtualized list.
const MAX_ROWS = 1000

// ─────────────────────────────────────────────────────────────────
// Module-scope buffers. The Monitor drawer unmounts when the user
// closes it, so React state would lose the captured history. Hoist
// the ring buffers + the IPC subscription up to module scope so:
//   - closing + reopening the drawer keeps the previous history
//     visible (only the explicit Clear button wipes it)
//   - capture keeps running while the drawer is closed so reopening
//     immediately shows the messages that fired during the closure
//   - only ONE IPC listener exists across mount/unmount cycles
// ─────────────────────────────────────────────────────────────────
const oscBuffer: MonitorRow[] = []
const oscInBuffer: MonitorRow[] = []
const midiBuffer: MidiMonitorRow[] = []
let bufferPaused = false
// React `setState` setters from the currently-mounted Monitor
// instance. Subscribers we install at module load (below) call
// these via the registered listener set so the Monitor re-renders
// when new batches arrive. Set/null'd by Monitor's mount effect.
const bumpListeners = new Set<() => void>()
function scheduleBump(): void {
  // Coalesce — the same setTimeout pattern as the original was
  // doing. ~10 Hz render is plenty for a live log.
  if (bumpPending) return
  bumpPending = true
  setTimeout(() => {
    bumpPending = false
    bumpListeners.forEach((b) => b())
  }, 100)
}
let bumpPending = false

// Install IPC subscribers exactly once at module load so capture
// runs even while the drawer is closed. window.api is only present
// in the Electron renderer — guard for SSR/test environments.
//
// Vite's HMR can re-evaluate this module on hot updates; without
// disposing the previous round's listeners, every reload would
// double-bind the IPC channels and duplicate every Monitor row.
// We capture each unsubscribe and run them on `import.meta.hot.dispose`.
// Trim helper: only splice when the buffer has grown WELL past the
// cap. Doing splice() on every push was O(rows-removed) per push;
// letting the buffer overshoot to ~2× before trimming amortises one
// splice across MAX_ROWS additions, turning the steady-state work
// from O(n) per push to O(1) per push (with an occasional O(n)
// trim). Display path uses `oscBuffer.slice(-MAX_ROWS)` when reading
// to keep the visual cap at MAX_ROWS.
const BUF_HIGH_WATERMARK = MAX_ROWS * 2
function trimBuffer<T>(buf: T[]): void {
  if (buf.length >= BUF_HIGH_WATERMARK) {
    buf.splice(0, buf.length - MAX_ROWS)
  }
}
const ipcOffFns: Array<() => void> = []
if (typeof window !== 'undefined' && window.api) {
  const offOsc = window.api.onOscEvents?.((batch) => {
    if (bufferPaused) return
    for (const e of batch) oscBuffer.push({ kind: 'ok', ...e })
    trimBuffer(oscBuffer)
    scheduleBump()
  })
  // (v0.6.4) Incoming OSC — the network listener's received messages.
  const offOscIn = window.api.onOscInEvents?.((batch) => {
    if (bufferPaused) return
    for (const e of batch) oscInBuffer.push({ kind: 'ok', ...e })
    trimBuffer(oscInBuffer)
    scheduleBump()
  })
  const offOscErr = window.api.onOscErrors?.((batch) => {
    if (bufferPaused) return
    for (const e of batch) oscBuffer.push({ kind: 'err', ...e })
    trimBuffer(oscBuffer)
    scheduleBump()
  })
  const offMidi = window.api.onMidiEvents?.((batch) => {
    if (bufferPaused) return
    for (const e of batch) midiBuffer.push({ rowKind: 'ok', ...e })
    trimBuffer(midiBuffer)
    scheduleBump()
  })
  const offMidiErr = window.api.onMidiErrors?.((batch) => {
    if (bufferPaused) return
    for (const e of batch) midiBuffer.push({ rowKind: 'err', ...e })
    trimBuffer(midiBuffer)
    scheduleBump()
  })
  if (offOsc) ipcOffFns.push(offOsc)
  if (offOscIn) ipcOffFns.push(offOscIn)
  if (offOscErr) ipcOffFns.push(offOscErr)
  if (offMidi) ipcOffFns.push(offMidi)
  if (offMidiErr) ipcOffFns.push(offMidiErr)
}
// Vite HMR cleanup — drops the previous round's IPC listeners
// before the new module instance attaches its own. No-op in prod.
// `import.meta.hot` is injected by Vite; we cast through unknown so
// the typecheck stays clean without pulling in `vite/client` types
// (which would bring in DOM globals the main build doesn't want).
const hot = (import.meta as unknown as { hot?: { dispose: (cb: () => void) => void } })
  .hot
if (hot) {
  hot.dispose(() => {
    for (const off of ipcOffFns) {
      try {
        off()
      } catch {
        /* listener already gone — ignore */
      }
    }
    ipcOffFns.length = 0
  })
}

// localStorage keys for the persisted Monitor preferences.
const SHOW_OSC_KEY = 'dataflou:monitor:showOsc:v1'
const SHOW_MIDI_KEY = 'dataflou:monitor:showMidi:v1'

function loadShowOsc(): boolean {
  try {
    const v = localStorage.getItem(SHOW_OSC_KEY)
    return v === null ? true : v === '1'
  } catch {
    return true
  }
}
function loadShowMidi(): boolean {
  try {
    const v = localStorage.getItem(SHOW_MIDI_KEY)
    return v === null ? true : v === '1'
  } catch {
    return true
  }
}
function loadOscColPx(): number {
  try {
    const v = parseInt(localStorage.getItem('dataflou:monitor:oscColPx:v1') ?? '', 10)
    if (Number.isFinite(v) && v >= 160 && v <= 1600) return v
  } catch {
    /* ignore */
  }
  return 480
}
// Pool pane width (right pane of the Monitor drawer). User drags the
// vertical resize bar between Monitor and Pool to set it. Persisted so
// the user's preferred Pool width survives drawer toggles and app
// restarts. The clamp range matches the layout's min Pool / min Monitor
// constraints — 200 px keeps the Pool's tabs + Hide button readable;
// 1200 px is a sane upper bound on ultra-wide monitors.
const POOL_WIDTH_KEY = 'dataflou:monitor:poolWidthPx:v1'
function loadPoolWidthPx(): number {
  try {
    const v = parseInt(localStorage.getItem(POOL_WIDTH_KEY) ?? '', 10)
    if (Number.isFinite(v) && v >= 200 && v <= 1200) return v
  } catch {
    /* ignore */
  }
  return 360
}

// Per-data-column widths. The user drags the right edge of a column
// header to resize it; widths persist to localStorage so they
// survive drawer close/reopen and app restart. Args column has no
// dedicated width — it flexes to fill the remainder of the row.
interface OscColWidths {
  time: number
  kind: number
  dest: number
  address: number
}
interface MidiColWidths {
  time: number
  kind: number
  port: number
  channel: number
}
const DEFAULT_OSC_COLS: OscColWidths = { time: 64, kind: 40, dest: 112, address: 160 }
const DEFAULT_MIDI_COLS: MidiColWidths = { time: 64, kind: 48, port: 112, channel: 48 }
function loadOscColWidths(): OscColWidths {
  try {
    const raw = localStorage.getItem('dataflou:monitor:oscCols:v1')
    if (raw) {
      const v = JSON.parse(raw) as Partial<OscColWidths>
      return {
        time: clampColWidth(v.time, DEFAULT_OSC_COLS.time),
        kind: clampColWidth(v.kind, DEFAULT_OSC_COLS.kind),
        dest: clampColWidth(v.dest, DEFAULT_OSC_COLS.dest),
        address: clampColWidth(v.address, DEFAULT_OSC_COLS.address)
      }
    }
  } catch {
    /* ignore */
  }
  return DEFAULT_OSC_COLS
}
function loadMidiColWidths(): MidiColWidths {
  try {
    const raw = localStorage.getItem('dataflou:monitor:midiCols:v1')
    if (raw) {
      const v = JSON.parse(raw) as Partial<MidiColWidths>
      return {
        time: clampColWidth(v.time, DEFAULT_MIDI_COLS.time),
        kind: clampColWidth(v.kind, DEFAULT_MIDI_COLS.kind),
        port: clampColWidth(v.port, DEFAULT_MIDI_COLS.port),
        channel: clampColWidth(v.channel, DEFAULT_MIDI_COLS.channel)
      }
    }
  } catch {
    /* ignore */
  }
  return DEFAULT_MIDI_COLS
}
function clampColWidth(v: unknown, fallback: number): number {
  if (typeof v === 'number' && Number.isFinite(v) && v >= 24 && v <= 800) return v
  return fallback
}

// ── Learned MIDI bindings panel — types + helpers ───────────────────
// Persisted width of the Learned column (px). Defaults to 180 — narrow
// enough not to crowd the OSC/MIDI logs but wide enough for "CC NN
// ch NN" plus the Edit/X buttons. User can drag wider up to 600.
const LEARNED_COL_KEY = 'dataflou:monitor:learnedColPx:v1'
const LEARNED_COL_MIN = 140
const LEARNED_COL_MAX = 600
const LEARNED_COL_DEFAULT = 180
function loadLearnedColPx(): number {
  try {
    const raw = localStorage.getItem(LEARNED_COL_KEY)
    if (raw) {
      const n = Number(raw)
      if (Number.isFinite(n) && n >= LEARNED_COL_MIN && n <= LEARNED_COL_MAX)
        return Math.round(n)
    }
  } catch {
    /* ignore */
  }
  return LEARNED_COL_DEFAULT
}

// One row in the Learned panel. `editTarget` is what we pass to
// setMidiLearnTarget when the user clicks Edit — re-learning rebinds.
// `onDelete` is a tiny lambda that calls the appropriate clear
// action; this avoids a giant switch at render time.
type LearnedBinding = {
  id: string
  label: string
  source: string // sub-label: 'Scene', 'Clip', 'Meta', 'Cue GO', etc.
  binding: MidiBinding
  editTarget:
    | { kind: 'scene'; id: string }
    | { kind: 'cell'; sceneId: string; trackId: string }
    | { kind: 'metaKnob'; index: number }
    | { kind: 'instrument'; sceneId: string; templateRowId: string }
    | { kind: 'go' }
    | { kind: 'morphTime' }
    | { kind: 'generativeToggle' }
    | { kind: 'generativeNoRepeat' }
    | { kind: 'generativeAffinity' }
    | { kind: 'generativeMinDuration' }
    | { kind: 'generativeMaxDuration' }
    | { kind: 'generativeUseMorph' }
    | { kind: 'generativeRandomWeights' }
    | { kind: 'motionLoopRecord' }
    | null
  onDelete: () => void
  // Apply a manually-edited binding (note/CC number and channel can
  // both be typed inline). Lets the user fix typos or pick a precise
  // CC number without going through a learn pass. Each call updates
  // the appropriate store binding for this row's source.
  onUpdate: (next: MidiBinding) => void
}

// Walk the session and enumerate every MIDI binding that's currently
// set. Returns rows ready for display, with edit/delete handlers
// bound to the right store actions. Sort: transport first, then
// metas, then scenes (and within scenes: scene-fire → instrument →
// per-clip), so the list reads top-down from "global controls" to
// "specific clip triggers."
function collectLearnedBindings(
  session: Session,
  trackNameById: Record<string, string>,
  templateNameById: Record<string, string>,
  store: {
    setSceneMidi: (id: string, b: MidiBinding | undefined) => void
    setInstrumentTriggerMidi: (
      sceneId: string,
      templateRowId: string,
      b: MidiBinding | undefined
    ) => void
    updateCell: (
      sceneId: string,
      trackId: string,
      patch: { midiTrigger?: MidiBinding | undefined }
    ) => void
    setGoMidi: (b: MidiBinding | undefined) => void
    setMorphTimeMidi: (b: MidiBinding | undefined) => void
    setMetaKnobMidi: (knobIdx: number, binding: MidiBinding | null) => void
    // Generative Scene Sequencer setters (v0.5.10).
    setGenerativeToggleMidi: (b: MidiBinding | undefined) => void
    setGenerativeNoRepeatMidi: (b: MidiBinding | undefined) => void
    setGenerativeAffinityMidi: (b: MidiBinding | undefined) => void
    setGenerativeMinDurationMidi: (b: MidiBinding | undefined) => void
    setGenerativeMaxDurationMidi: (b: MidiBinding | undefined) => void
    setGenerativeUseMorphMidi: (b: MidiBinding | undefined) => void
    setRandomWeightsMidi: (b: MidiBinding | undefined) => void
    setMotionLoopRecordMidi: (b: MidiBinding | null) => void
  }
): LearnedBinding[] {
  const out: LearnedBinding[] = []
  // Transport.
  if (session.goMidi) {
    out.push({
      id: 'transport-go',
      label: 'Cue GO',
      source: 'Transport',
      binding: session.goMidi,
      editTarget: { kind: 'go' },
      onDelete: () => store.setGoMidi(undefined),
      onUpdate: (next) => store.setGoMidi(next)
    })
  }
  if (session.motionLoopRecordMidi) {
    out.push({
      id: 'transport-motionloop',
      label: 'Motion Loop REC',
      source: 'Transport',
      binding: session.motionLoopRecordMidi,
      editTarget: { kind: 'motionLoopRecord' },
      onDelete: () => store.setMotionLoopRecordMidi(null),
      onUpdate: (next) => store.setMotionLoopRecordMidi(next)
    })
  }
  if (session.morphTimeMidi) {
    out.push({
      id: 'transport-morph',
      label: 'Morph time',
      source: 'Transport',
      binding: session.morphTimeMidi,
      editTarget: { kind: 'morphTime' },
      onDelete: () => store.setMorphTimeMidi(undefined),
      onUpdate: (next) => store.setMorphTimeMidi(next)
    })
  }
  // Generative Scene Sequencer bindings (v0.5.10). All seven slots
  // live on session.generative; emit a row for each one that's set.
  const gen = session.generative
  if (gen?.toggleMidi) {
    out.push({
      id: 'gen-toggle',
      label: 'Generative on/off',
      source: 'Generative',
      binding: gen.toggleMidi,
      editTarget: { kind: 'generativeToggle' },
      onDelete: () => store.setGenerativeToggleMidi(undefined),
      onUpdate: (next) => store.setGenerativeToggleMidi(next)
    })
  }
  if (gen?.noRepeatMidi) {
    out.push({
      id: 'gen-no-repeat',
      label: 'No-repeat',
      source: 'Generative',
      binding: gen.noRepeatMidi,
      editTarget: { kind: 'generativeNoRepeat' },
      onDelete: () => store.setGenerativeNoRepeatMidi(undefined),
      onUpdate: (next) => store.setGenerativeNoRepeatMidi(next)
    })
  }
  if (gen?.affinityMidi) {
    out.push({
      id: 'gen-affinity',
      label: 'Affinity',
      source: 'Generative',
      binding: gen.affinityMidi,
      editTarget: { kind: 'generativeAffinity' },
      onDelete: () => store.setGenerativeAffinityMidi(undefined),
      onUpdate: (next) => store.setGenerativeAffinityMidi(next)
    })
  }
  if (gen?.minDurationMidi) {
    out.push({
      id: 'gen-min-dur',
      label: 'Min duration',
      source: 'Generative',
      binding: gen.minDurationMidi,
      editTarget: { kind: 'generativeMinDuration' },
      onDelete: () => store.setGenerativeMinDurationMidi(undefined),
      onUpdate: (next) => store.setGenerativeMinDurationMidi(next)
    })
  }
  if (gen?.maxDurationMidi) {
    out.push({
      id: 'gen-max-dur',
      label: 'Max duration',
      source: 'Generative',
      binding: gen.maxDurationMidi,
      editTarget: { kind: 'generativeMaxDuration' },
      onDelete: () => store.setGenerativeMaxDurationMidi(undefined),
      onUpdate: (next) => store.setGenerativeMaxDurationMidi(next)
    })
  }
  if (gen?.useMorphMidi) {
    out.push({
      id: 'gen-use-morph',
      label: 'Use Morph',
      source: 'Generative',
      binding: gen.useMorphMidi,
      editTarget: { kind: 'generativeUseMorph' },
      onDelete: () => store.setGenerativeUseMorphMidi(undefined),
      onUpdate: (next) => store.setGenerativeUseMorphMidi(next)
    })
  }
  if (gen?.randomWeightsMidi) {
    out.push({
      id: 'gen-random-weights',
      label: 'Random Weights',
      source: 'Generative',
      binding: gen.randomWeightsMidi,
      editTarget: { kind: 'generativeRandomWeights' },
      onDelete: () => store.setRandomWeightsMidi(undefined),
      onUpdate: (next) => store.setRandomWeightsMidi(next)
    })
  }
  // Meta knobs.
  session.metaController?.knobs?.forEach((knob, idx) => {
    if (!knob.midiCc) return
    out.push({
      id: `meta-knob-${idx}`,
      label: knob.name?.trim() || `Knob ${idx + 1}`,
      source: 'Meta knob',
      binding: knob.midiCc,
      editTarget: { kind: 'metaKnob', index: idx },
      onDelete: () => store.setMetaKnobMidi(idx, null),
      onUpdate: (next) => store.setMetaKnobMidi(idx, next)
    })
  })
  // Per-scene bindings (fire, instrument-fire, per-clip).
  for (const scene of session.scenes) {
    if (scene.midiTrigger) {
      out.push({
        id: `scene-${scene.id}`,
        label: scene.name || '(unnamed)',
        source: 'Scene',
        binding: scene.midiTrigger,
        editTarget: { kind: 'scene', id: scene.id },
        onDelete: () => store.setSceneMidi(scene.id, undefined),
        onUpdate: (next) => store.setSceneMidi(scene.id, next)
      })
    }
    if (scene.instrumentTriggers) {
      for (const [templateRowId, binding] of Object.entries(
        scene.instrumentTriggers
      )) {
        out.push({
          id: `instr-${scene.id}-${templateRowId}`,
          label: `${scene.name} / ${templateNameById[templateRowId] ?? '(?)'}`,
          source: 'Instrument',
          binding,
          editTarget: {
            kind: 'instrument',
            sceneId: scene.id,
            templateRowId
          },
          onDelete: () =>
            store.setInstrumentTriggerMidi(scene.id, templateRowId, undefined),
          onUpdate: (next) =>
            store.setInstrumentTriggerMidi(scene.id, templateRowId, next)
        })
      }
    }
    for (const [trackId, cell] of Object.entries(scene.cells)) {
      if (!cell.midiTrigger) continue
      out.push({
        id: `cell-${scene.id}-${trackId}`,
        label: `${scene.name} / ${trackNameById[trackId] ?? '(?)'}`,
        source: 'Clip',
        binding: cell.midiTrigger,
        editTarget: { kind: 'cell', sceneId: scene.id, trackId },
        onDelete: () =>
          store.updateCell(scene.id, trackId, { midiTrigger: undefined }),
        onUpdate: (next) =>
          store.updateCell(scene.id, trackId, { midiTrigger: next })
      })
    }
  }
  return out
}

// Pretty-print a MIDI binding: "CC#43 ch3" or "C4 ch1". Channel is
// stored 0..15 in the binding; UI is 1..16.
function formatBinding(b: MidiBinding): string {
  const ch = `ch${b.channel + 1}`
  if (b.kind === 'cc') return `CC ${b.number} ${ch}`
  // Note name: C-2..G8 via the standard "MIDI 60 = C4" convention.
  const NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']
  const safe = Math.max(0, Math.min(127, b.number))
  const name = NAMES[safe % 12] + (Math.floor(safe / 12) - 1)
  return `${name} ${ch}`
}

// Inline editor for a single Learned binding's note/CC number and
// channel. Used in the Learned panel when a row is in edit mode.
// kind toggle (CC / Note), number 0..127, channel 1..16 (display
// is 1..16, storage 0..15). Each change immediately calls onChange
// with the new binding — no commit button needed; the parent persists
// to the appropriate store binding setter.
function LearnedBindingInlineEditor({
  binding,
  onChange
}: {
  binding: MidiBinding
  onChange: (next: MidiBinding) => void
}): JSX.Element {
  return (
    <span className="flex items-center gap-1 font-mono">
      <select
        className="input text-[9px] py-0 px-1"
        value={binding.kind}
        onChange={(e) =>
          onChange({ ...binding, kind: e.target.value as 'note' | 'cc' })
        }
        title="Binding kind — CC (continuous controller) or Note (key)"
      >
        <option value="cc">CC</option>
        <option value="note">N</option>
      </select>
      <input
        type="number"
        className="input text-[9px] py-0 px-1 tabular-nums"
        style={{ width: 44 }}
        min={0}
        max={127}
        value={binding.number}
        onChange={(e) => {
          const n = Number(e.target.value)
          if (!Number.isFinite(n)) return
          onChange({
            ...binding,
            number: Math.max(0, Math.min(127, Math.round(n)))
          })
        }}
        title={binding.kind === 'cc' ? 'CC number (0..127)' : 'Note number (0..127, 60 = C4)'}
      />
      <span className="text-muted text-[9px]">ch</span>
      <input
        type="number"
        className="input text-[9px] py-0 px-1 tabular-nums"
        style={{ width: 32 }}
        min={1}
        max={16}
        value={binding.channel + 1}
        onChange={(e) => {
          const n = Number(e.target.value)
          if (!Number.isFinite(n)) return
          onChange({
            ...binding,
            channel: Math.max(0, Math.min(15, Math.round(n) - 1))
          })
        }}
        title="MIDI channel (1..16)"
      />
    </span>
  )
}

export default function OscMonitor(): JSX.Element | null {
  const open = useStore((s) => s.oscMonitorOpen)
  const setOpen = useStore((s) => s.setOscMonitorOpen)
  if (!open) return null
  return <OscMonitorDrawer onClose={() => setOpen(false)} />
}

function OscMonitorDrawer({ onClose }: { onClose: () => void }): JSX.Element {
  const [paused, setPaused] = useState(false)
  // Free-form substring filter applied to address; empty = pass-through.
  const [filter, setFilter] = useState('')
  // Pop the Pool out into a centered window. While popped, the drawer
  // shows a placeholder where the Pool used to be so the OSC log keeps
  // its layout. Toggled from PoolPane's title-bar double-click + ⤢
  // button.
  const [poolPoppedOut, setPoolPoppedOut] = useState(false)
  // Drawer height + Pool visibility live in the store so the keyboard
  // shortcut handler in App.tsx can flip them, and so the height
  // survives a drawer toggle.
  const drawerHeight = useStore((s) => s.oscMonitorHeight)
  const setDrawerHeight = useStore((s) => s.setOscMonitorHeight)
  // The drawer lives inside the Ctrl+wheel zoom wrapper now (so the
  // Pool tabs + OSC log scale alongside the rest of the app), which
  // means a 600px max at uiScale=2 would eat 1200 device pixels. Cap
  // the resize handle's max by 1/uiScale so the drawer can never
  // grow past ~600 device pixels regardless of zoom. The min mirrors
  // the same logic so the drawer's smallest CSS height shrinks at
  // higher zoom (otherwise the user can't bring it below 240 device
  // pixels at uiScale=2).
  const uiScale = useStore((s) => s.uiScale)
  const effectiveMaxDrawer = Math.max(160, Math.round(600 / Math.max(0.5, uiScale)))
  const effectiveMinDrawer = Math.max(60, Math.round(120 / Math.max(0.5, uiScale)))
  // Clamp the stored height back into the new effective range when
  // zoom changes — without this a 600 px height set at scale=1 would
  // remain 600 css px (= 1200 device px) after zooming to 2.
  useEffect(() => {
    if (drawerHeight > effectiveMaxDrawer) setDrawerHeight(effectiveMaxDrawer)
    else if (drawerHeight < effectiveMinDrawer) setDrawerHeight(effectiveMinDrawer)
  }, [effectiveMaxDrawer, effectiveMinDrawer, drawerHeight, setDrawerHeight])
  const poolHidden = useStore((s) => s.poolHidden)
  const setPoolHidden = useStore((s) => s.setPoolHidden)
  // OSC and MIDI columns each have their own visibility toggle —
  // both ON by default per the design discussion. Persisted to
  // localStorage so the user's preference survives a restart.
  const [showOsc, setShowOscState] = useState<boolean>(() => loadShowOsc())
  const [showMidi, setShowMidiState] = useState<boolean>(() => loadShowMidi())
  // (v0.6.4) OSC In column — incoming traffic. Default ON: for an OSC
  // playground, seeing what arrives is as important as what's sent.
  const [showOscIn, setShowOscInState] = useState<boolean>(() => {
    try {
      return (localStorage.getItem('dataflou:monitor:showOscIn:v1') ?? '1') !== '0'
    } catch {
      return true
    }
  })
  function setShowOscIn(v: boolean): void {
    setShowOscInState(v)
    try {
      localStorage.setItem('dataflou:monitor:showOscIn:v1', v ? '1' : '0')
    } catch {
      /* ignore */
    }
  }
  function setShowOsc(v: boolean): void {
    setShowOscState(v)
    try {
      localStorage.setItem('dataflou:monitor:showOsc:v1', v ? '1' : '0')
    } catch {
      /* ignore */
    }
  }
  function setShowMidi(v: boolean): void {
    setShowMidiState(v)
    try {
      localStorage.setItem('dataflou:monitor:showMidi:v1', v ? '1' : '0')
    } catch {
      /* ignore */
    }
  }
  // Resizable split between the OSC and MIDI columns when both are
  // visible. Persisted as the OSC column's width in CSS px so the
  // ResizeHandle (which works on pixel deltas) can drive it
  // directly — translating a drag into a fraction would require a
  // ref to the parent container, which is more wiring than it's
  // worth here.
  const [oscColPx, setOscColPxState] = useState<number>(() => loadOscColPx())
  function setOscColPx(v: number): void {
    const clamped = Math.max(160, Math.min(1600, v))
    setOscColPxState(clamped)
    try {
      localStorage.setItem('dataflou:monitor:oscColPx:v1', String(clamped))
    } catch {
      /* ignore */
    }
  }
  // (v0.6.4) OSC In column width (px) when it isn't the last visible
  // column — mirrors oscColPx.
  const [oscInColPx, setOscInColPxState] = useState<number>(() => {
    try {
      const v = parseInt(localStorage.getItem('dataflou:monitor:oscInColPx:v1') ?? '', 10)
      return Number.isFinite(v) && v >= 160 ? v : 320
    } catch {
      return 320
    }
  })
  function setOscInColPx(v: number): void {
    const clamped = Math.max(160, Math.min(1600, v))
    setOscInColPxState(clamped)
    try {
      localStorage.setItem('dataflou:monitor:oscInColPx:v1', String(clamped))
    } catch {
      /* ignore */
    }
  }
  // Pool pane width — same pattern. Drives `style={{ width: poolWidthPx }}`
  // on the right pane and `style={{ width: '100% - poolWidthPx' }}` on the
  // left pane (via flex: 1). The resize bar between them uses an inverse
  // drag because the Pool is RIGHT-anchored (dragging right shrinks it).
  const [poolWidthPx, setPoolWidthPxState] = useState<number>(() =>
    loadPoolWidthPx()
  )
  // Outer pane-row ref — used to measure available width so the Pool's
  // resize max can be clamped dynamically against the Learned panel +
  // a min Monitor area. Without this clamp the user can drag the Pool
  // wide enough that the Learned panel (flex 0 0 Npx) overflows behind
  // it — visible in the screenshot the user posted.
  const paneRowRef = useRef<HTMLDivElement | null>(null)
  const [paneRowWidth, setPaneRowWidth] = useState<number>(0)
  useEffect(() => {
    const el = paneRowRef.current
    if (!el) return
    const ro = new ResizeObserver((entries) => {
      for (const e of entries) {
        const w = e.contentRect.width
        if (Number.isFinite(w)) setPaneRowWidth(Math.round(w))
      }
    })
    ro.observe(el)
    // Prime immediately so the first paint has a measurement.
    setPaneRowWidth(Math.round(el.getBoundingClientRect().width))
    return () => ro.disconnect()
  }, [])
  function setPoolWidthPx(v: number): void {
    const clamped = Math.max(200, Math.min(1200, v))
    setPoolWidthPxState(clamped)
    try {
      localStorage.setItem(POOL_WIDTH_KEY, String(clamped))
    } catch {
      /* ignore */
    }
  }
  // Per-column widths inside each log column. Default values match
  // the original Tailwind w-N classes (w-16 = 64 px, w-10 = 40,
  // w-28 = 112, w-40 = 160). The "args" column has no fixed width
  // (it flexes to fill the rest of the row). User drags any
  // header's right edge to resize.
  const [oscCols, setOscCols] = useState<OscColWidths>(() => loadOscColWidths())
  function patchOscCols(p: Partial<OscColWidths>): void {
    setOscCols((c) => {
      const next = { ...c, ...p }
      try {
        localStorage.setItem('dataflou:monitor:oscCols:v1', JSON.stringify(next))
      } catch {
        /* ignore */
      }
      return next
    })
  }
  const [midiCols, setMidiCols] = useState<MidiColWidths>(() => loadMidiColWidths())
  function patchMidiCols(p: Partial<MidiColWidths>): void {
    setMidiCols((c) => {
      const next = { ...c, ...p }
      try {
        localStorage.setItem('dataflou:monitor:midiCols:v1', JSON.stringify(next))
      } catch {
        /* ignore */
      }
      return next
    })
  }
  // ── Learned bindings panel ────────────────────────────────────────
  // Read everything we need from the session up front; recompute the
  // binding list whenever the session changes via useMemo. Persisted
  // width so the user's preferred Learned column size survives the
  // drawer being closed + reopened.
  const session = useStore((s) => s.session)
  const setMidiLearnMode = useStore((s) => s.setMidiLearnMode)
  const setMidiLearnTarget = useStore((s) => s.setMidiLearnTarget)
  const setSceneMidi = useStore((s) => s.setSceneMidi)
  const setInstrumentTriggerMidi = useStore((s) => s.setInstrumentTriggerMidi)
  const updateCellStore = useStore((s) => s.updateCell)
  const setGoMidi = useStore((s) => s.setGoMidi)
  const setMorphTimeMidi = useStore((s) => s.setMorphTimeMidi)
  const setMetaKnobMidi = useStore((s) => s.setMetaKnobMidi)
  // Generative Scene Sequencer MIDI setters (v0.5.10).
  const setGenerativeToggleMidi = useStore((s) => s.setGenerativeToggleMidi)
  const setGenerativeNoRepeatMidi = useStore((s) => s.setGenerativeNoRepeatMidi)
  const setGenerativeAffinityMidi = useStore((s) => s.setGenerativeAffinityMidi)
  const setGenerativeMinDurationMidi = useStore(
    (s) => s.setGenerativeMinDurationMidi
  )
  const setGenerativeMaxDurationMidi = useStore(
    (s) => s.setGenerativeMaxDurationMidi
  )
  const setGenerativeUseMorphMidi = useStore((s) => s.setGenerativeUseMorphMidi)
  const setRandomWeightsMidi = useStore((s) => s.setRandomWeightsMidi)
  const setMotionLoopRecordMidi = useStore((s) => s.setMotionLoopRecordMidi)
  const [learnedColPx, setLearnedColPxState] = useState<number>(() =>
    loadLearnedColPx()
  )
  // Which Learned-row is currently in inline-edit mode. Click "Edit"
  // on a row to enter (toggles MIDI Learn on with this binding as
  // the target — so wiggling a MIDI control rebinds). Click again
  // to exit (turns Learn off). While editing, the binding's
  // CC/Note number + channel can be typed manually instead of
  // waiting for a MIDI message.
  const [editingBindingId, setEditingBindingId] = useState<string | null>(
    null
  )
  function setLearnedColPx(v: number): void {
    const clamped = Math.max(LEARNED_COL_MIN, Math.min(LEARNED_COL_MAX, Math.round(v)))
    setLearnedColPxState(clamped)
    try {
      localStorage.setItem(LEARNED_COL_KEY, String(clamped))
    } catch {
      /* ignore */
    }
  }
  const learnedBindings = useMemo(() => {
    const trackNames: Record<string, string> = {}
    session.tracks.forEach((t) => {
      trackNames[t.id] = t.name
    })
    const templateNames: Record<string, string> = {}
    session.tracks.forEach((t) => {
      if (t.kind === 'template') templateNames[t.id] = t.name
    })
    return collectLearnedBindings(session, trackNames, templateNames, {
      setSceneMidi: (id, b) => setSceneMidi(id, b),
      setInstrumentTriggerMidi: (sceneId, templateRowId, b) =>
        setInstrumentTriggerMidi(sceneId, templateRowId, b),
      updateCell: (sceneId, trackId, patch) =>
        updateCellStore(sceneId, trackId, patch),
      setGoMidi: (b) => setGoMidi(b),
      setMorphTimeMidi: (b) => setMorphTimeMidi(b),
      setMetaKnobMidi: (knobIdx, b) => setMetaKnobMidi(knobIdx, b),
      setGenerativeToggleMidi: (b) => setGenerativeToggleMidi(b),
      setGenerativeNoRepeatMidi: (b) => setGenerativeNoRepeatMidi(b),
      setGenerativeAffinityMidi: (b) => setGenerativeAffinityMidi(b),
      setGenerativeMinDurationMidi: (b) => setGenerativeMinDurationMidi(b),
      setGenerativeMaxDurationMidi: (b) => setGenerativeMaxDurationMidi(b),
      setGenerativeUseMorphMidi: (b) => setGenerativeUseMorphMidi(b),
      setRandomWeightsMidi: (b) => setRandomWeightsMidi(b),
      setMotionLoopRecordMidi: (b) => setMotionLoopRecordMidi(b)
    })
  }, [
    session,
    setSceneMidi,
    setInstrumentTriggerMidi,
    updateCellStore,
    setGoMidi,
    setMorphTimeMidi,
    setMetaKnobMidi,
    setGenerativeToggleMidi,
    setGenerativeNoRepeatMidi,
    setGenerativeAffinityMidi,
    setGenerativeMinDurationMidi,
    setGenerativeMaxDurationMidi,
    setGenerativeUseMorphMidi,
    setRandomWeightsMidi,
    setMotionLoopRecordMidi
  ])
  // Buffers live at module scope (top of this file) so closing +
  // reopening the drawer keeps the captured history visible. We just
  // re-render this component on every coalesced bump via the
  // `bumpListeners` registry.
  const [, setTick] = useState(0)
  const scrollRef = useRef<HTMLDivElement>(null)
  const oscInScrollRef = useRef<HTMLDivElement>(null)
  const midiScrollRef = useRef<HTMLDivElement>(null)
  const stickToBottomRef = useRef(true)
  const oscInStickToBottomRef = useRef(true)
  const midiStickToBottomRef = useRef(true)

  // Mirror the local `paused` state into the module-scope flag so
  // the IPC subscribers (which can't see component state) can skip
  // their pushes. Both halves stay in sync.
  useEffect(() => {
    bufferPaused = paused
  }, [paused])

  // ── Pool max width clamp ────────────────────────────────────────
  // The pane row holds: [Monitor (flex-1)] | [ResizeHandle 4px] |
  // [Learned (optional, fixed)] | [ResizeHandle 4px] | [Pool (fixed)].
  // Compute the largest Pool width that still leaves a usable Monitor
  // pane (MIN_MONITOR px) when Learned is visible. Without this the
  // Pool could be dragged so wide that the Learned panel overflowed
  // behind it.
  const learnedVisible = learnedBindings.length > 0 && showMidi
  const MIN_MONITOR = 220
  const RESIZE_HANDLE_PX = 4
  const effectivePoolMax = useMemo(() => {
    if (paneRowWidth <= 0) return 1200
    const reserved =
      MIN_MONITOR +
      RESIZE_HANDLE_PX + // between Pool and (Monitor or Learned)
      (learnedVisible ? learnedColPx + RESIZE_HANDLE_PX : 0)
    return Math.max(200, Math.min(1200, paneRowWidth - reserved))
  }, [paneRowWidth, learnedVisible, learnedColPx])
  // If the effective max shrinks (e.g. window resized smaller, or
  // Learned panel appeared), shrink the stored pool width to match
  // so the layout never breaks. This is the clamp the user actually
  // sees: dragging the resize bar can't push past effectivePoolMax,
  // and an unrelated viewport shrink retroactively narrows the Pool.
  useEffect(() => {
    if (poolWidthPx > effectivePoolMax) {
      setPoolWidthPx(effectivePoolMax)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [effectivePoolMax])

  // ── OSC column max width clamp ───────────────────────────────────
  // Same idea as `effectivePoolMax` but for the OSC ↔ MIDI resize
  // handle. The Monitor pane's interior is partitioned:
  //   [OSC fixed-px] | [4px handle] | [MIDI flex] | ([4px handle] |
  //                                                 [Learned fixed-px])?
  // Without a dynamic cap the OSC col could be widened past Pane 1
  // until the MIDI + Learned cols got pushed behind the Pool.
  const MIN_MIDI = 200
  const OSC_MIN = 160
  const effectiveOscMax = useMemo(() => {
    if (paneRowWidth <= 0) return 1600
    const pane1Width =
      paneRowWidth - (poolHidden ? 0 : poolWidthPx + RESIZE_HANDLE_PX)
    const reserved =
      MIN_MIDI +
      RESIZE_HANDLE_PX + // OSC/MIDI handle
      (learnedVisible ? learnedColPx + RESIZE_HANDLE_PX : 0)
    return Math.max(OSC_MIN, Math.min(1600, pane1Width - reserved))
  }, [paneRowWidth, poolHidden, poolWidthPx, learnedVisible, learnedColPx])
  useEffect(() => {
    if (oscColPx > effectiveOscMax) {
      setOscColPx(effectiveOscMax)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [effectiveOscMax])

  // ── Learned column max width clamp ───────────────────────────────
  // Same pattern: limit Learned so OSC + handle + MIN_MIDI + handle
  // + Learned + handle + Pool all fit inside paneRowWidth. Without
  // it, dragging Learned wider would push its right edge (Edit / X
  // buttons) past Pane 1's overflow-hidden boundary and the buttons
  // would slip behind the Pool.
  const effectiveLearnedMax = useMemo(() => {
    if (paneRowWidth <= 0) return LEARNED_COL_MAX
    const reserved =
      (poolHidden ? 0 : poolWidthPx + RESIZE_HANDLE_PX) +
      OSC_MIN +
      RESIZE_HANDLE_PX + // OSC/MIDI handle
      MIN_MIDI +
      RESIZE_HANDLE_PX // MIDI/Learned handle
    return Math.max(LEARNED_COL_MIN, Math.min(LEARNED_COL_MAX, paneRowWidth - reserved))
  }, [paneRowWidth, poolHidden, poolWidthPx])
  useEffect(() => {
    if (learnedColPx > effectiveLearnedMax) {
      setLearnedColPx(effectiveLearnedMax)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [effectiveLearnedMax])

  // Subscribe to module-scope bump notifications so the component
  // re-renders when new batches arrive. The actual IPC listeners
  // are installed once at module load (above) and stay alive
  // regardless of mount/unmount.
  useEffect(() => {
    const bump = (): void => setTick((n) => n + 1)
    bumpListeners.add(bump)
    return () => {
      bumpListeners.delete(bump)
    }
  }, [])

  // IPC listeners live at module scope so the buffers keep growing
  // while the drawer is closed — no per-component subscription
  // block needed here anymore.

  // Auto-scroll to bottom when new rows arrive, unless the user has scrolled
  // up. Detect intent via the scroll handler below.
  useEffect(() => {
    if (stickToBottomRef.current) {
      const el = scrollRef.current
      if (el) el.scrollTop = el.scrollHeight
    }
    if (oscInStickToBottomRef.current) {
      const el = oscInScrollRef.current
      if (el) el.scrollTop = el.scrollHeight
    }
    if (midiStickToBottomRef.current) {
      const el = midiScrollRef.current
      if (el) el.scrollTop = el.scrollHeight
    }
  })

  function onScroll(): void {
    const el = scrollRef.current
    if (!el) return
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 20
    stickToBottomRef.current = atBottom
  }
  function onOscInScroll(): void {
    const el = oscInScrollRef.current
    if (!el) return
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 20
    oscInStickToBottomRef.current = atBottom
  }
  function onMidiScroll(): void {
    const el = midiScrollRef.current
    if (!el) return
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 20
    midiStickToBottomRef.current = atBottom
  }

  function clearLog(): void {
    oscBuffer.length = 0
    oscInBuffer.length = 0
    midiBuffer.length = 0
    setTick((n) => n + 1)
  }

  const rows = useMemo(() => {
    // Cap the visible window at MAX_ROWS even when the underlying
    // buffer overshoots to BUF_HIGH_WATERMARK before being trimmed.
    // `slice(-MAX_ROWS)` is O(MAX_ROWS) and only fires on bump.
    const view = oscBuffer.length > MAX_ROWS ? oscBuffer.slice(-MAX_ROWS) : oscBuffer
    if (!filter.trim()) return view
    const f = filter.trim().toLowerCase()
    return view.filter(
      (e) =>
        e.address.toLowerCase().includes(f) ||
        `${e.ip}:${e.port}`.includes(f)
    )
    // rows recomputes on every tick because we mutate the module
    // buffer in place; the length dep is enough since we never
    // splice in the middle. React re-renders on the bump listener.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filter, oscBuffer.length])
  // (v0.6.4) Incoming-OSC rows — same filter + windowing as outgoing.
  const oscInRows = useMemo(() => {
    const view =
      oscInBuffer.length > MAX_ROWS ? oscInBuffer.slice(-MAX_ROWS) : oscInBuffer
    if (!filter.trim()) return view
    const f = filter.trim().toLowerCase()
    return view.filter(
      (e) =>
        e.address.toLowerCase().includes(f) || `${e.ip}:${e.port}`.includes(f)
    )
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filter, oscInBuffer.length])
  // MIDI rows mirror the OSC rows. Filter matches against the port
  // name, the message kind, or "ch N" — same UX as OSC's ip:port +
  // address filter but adapted to the MIDI fields.
  const midiRows = useMemo(() => {
    const view = midiBuffer.length > MAX_ROWS ? midiBuffer.slice(-MAX_ROWS) : midiBuffer
    if (!filter.trim()) return view
    const f = filter.trim().toLowerCase()
    return view.filter((e) => {
      if (e.portName.toLowerCase().includes(f)) return true
      if (`ch${e.channel}`.toLowerCase().includes(f)) return true
      if (e.rowKind === 'ok') {
        return (
          e.kind.toLowerCase().includes(f) ||
          `cc${e.data1}`.includes(f) ||
          `note${e.data1}`.includes(f)
        )
      }
      return e.message.toLowerCase().includes(f)
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filter, midiBuffer.length])

  return (
    <div
      // Two-pane drawer: OSC log + Pool. Inspector for Pool selection
      // lives in the Edit-view Inspector instead. Default 220 px tall
      // (~10 log rows + a couple of expanded Templates). User can grab
      // the top edge handle to grow the drawer up to 600 px.
      className="relative border-t border-border bg-panel flex flex-col shrink-0"
      style={{ height: drawerHeight }}
    >
      {/* Top edge resize handle — drag UP to grow the drawer, DOWN to
          shrink. Inverted so the visual move matches the value change
          (drawer pinned to bottom, height = container.bottom -
          drag.y). */}
      <ResizeHandle
        direction="row"
        value={drawerHeight}
        onChange={setDrawerHeight}
        min={effectiveMinDrawer}
        max={effectiveMaxDrawer}
        inverse
        className="absolute top-0 left-0 right-0 h-[4px] z-20 cursor-row-resize"
        title="Drag to resize the OSC monitor drawer"
      />
      {/* Two-pane body. Left pane is the unified Monitor (OSC +
          MIDI columns side by side); right pane is the Pool. The
          Pool is a FIXED pixel width set by `poolWidthPx`; the
          Monitor pane grows to fill the remaining space. A vertical
          ResizeHandle sits on the boundary so the user can pull the
          Pool narrower (giving the Monitor toolbar more room — its
          buttons must always be visible) or wider. */}
      <div ref={paneRowRef} className="flex-1 min-h-0 flex relative">
        {/* Pane 1 — Monitor (OSC + MIDI in parallel columns).
            `overflow-hidden` is the hard cap that keeps the MIDI /
            Learned columns from bleeding rightward into the Pool when
            the user enlarges the window — without it, the OSC column's
            fixed-px width + the MIDI column's flex-grow could push
            past Pane 1's right edge if the inner content's intrinsic
            min-width exceeded the allotted space. */}
        <div className="flex flex-col min-h-0 border-r border-border flex-1 min-w-0 overflow-hidden">
          {/* Single combined toolbar. Order:
              ✕ close · Monitor label · OSC + MIDI checkboxes ·
              counts · filter · Live · Clear.
              `min-h-[28px]` keeps this row's height locked to the
              Pool title bar's height so the two toolbars sit on the
              same visual line (per the "uniformize toolbar" request). */}
          <div className="flex items-center gap-2 px-2 py-1 border-b border-border shrink-0 min-h-[28px]">
            <button
              className="btn text-[11px] py-0 leading-tight px-1.5 shrink-0"
              onClick={onClose}
              title="Close drawer"
            >
              ×
            </button>
            <span className="label shrink-0">Monitor</span>
            {/* OSC + MIDI visibility toggles. Both default ON; the
                user can collapse either column to focus on the
                other. Persisted to localStorage. */}
            <label
              className="flex items-center gap-1 text-[10px] shrink-0 cursor-pointer select-none"
              title="Show incoming OSC column (what the network listener receives)"
            >
              <input
                type="checkbox"
                checked={showOscIn}
                onChange={(e) => setShowOscIn(e.target.checked)}
              />
              <span>OSC In</span>
              <span className="text-muted">
                {oscInRows.length}/{oscInBuffer.length}
              </span>
            </label>
            <label
              className="flex items-center gap-1 text-[10px] shrink-0 cursor-pointer select-none"
              title="Show outgoing OSC events column"
            >
              <input
                type="checkbox"
                checked={showOsc}
                onChange={(e) => setShowOsc(e.target.checked)}
              />
              <span>OSC Out</span>
              <span className="text-muted">
                {rows.length}/{oscBuffer.length}
              </span>
            </label>
            <label
              className="flex items-center gap-1 text-[10px] shrink-0 cursor-pointer select-none"
              title="Show MIDI events column"
            >
              <input
                type="checkbox"
                checked={showMidi}
                onChange={(e) => setShowMidi(e.target.checked)}
              />
              <span>MIDI</span>
              <span className="text-muted">
                {midiRows.length}/{midiBuffer.length}
              </span>
            </label>
            {poolHidden && (
              <button
                className="btn text-[10px] py-0.5 shrink-0"
                onClick={() => setPoolHidden(false)}
                title="Show the Pool (P)"
              >
                Show Pool
              </button>
            )}
            <input
              className="input flex-1 min-w-0 text-[11px] py-0.5"
              placeholder="Filter — address, ip:port, MIDI port, ch1, cc7, note60…"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
            />
            <button
              className={`btn text-[10px] py-0.5 shrink-0 ${paused ? 'bg-accent text-black border-accent' : ''}`}
              onClick={() => setPaused((v) => !v)}
              title={paused ? 'Resume capture' : 'Pause capture (events still flow, just not displayed)'}
            >
              {paused ? 'Paused' : 'Live'}
            </button>
            <button className="btn text-[10px] py-0.5 shrink-0" onClick={clearLog}>
              Clear
            </button>
          </div>
          {/* Dual-column body. When both columns are visible, the
              OSC column takes `oscColFrac` of the width and the MIDI
              column gets the rest — split by a vertical ResizeHandle.
              When only one column is on, it takes the full width.
              `min-w-0` lets the flex children shrink below their
              intrinsic content width so MIDI/Learned can't push past
              Pane 1's boundary (which is anchored to Pool's left
              edge). */}
          <div className="flex-1 min-h-0 min-w-0 flex relative">
            {/* (v0.6.4) OSC In column — incoming traffic. Reads left-to-right
                as signal flow: In → Out → MIDI. Shares the oscCols field
                widths with the Out column. */}
            {showOscIn && (
              <div
                className="flex flex-col min-h-0"
                style={{
                  flex: showOsc || showMidi ? `0 0 ${oscInColPx}px` : '1 1 0',
                  borderRight:
                    showOsc || showMidi ? '1px solid rgb(var(--c-border))' : undefined
                }}
              >
                <div className="flex items-center gap-2 px-2 py-0.5 text-[9px] uppercase tracking-wider text-muted border-b border-border shrink-0 select-none min-h-[20px]">
                  <ColHeader
                    label="time"
                    width={oscCols.time}
                    onResize={(w) => patchOscCols({ time: w })}
                  />
                  <span className="text-border shrink-0">|</span>
                  <ColHeader
                    label="src ip:port"
                    width={oscCols.dest}
                    onResize={(w) => patchOscCols({ dest: w })}
                  />
                  <ColHeader
                    label="address"
                    width={oscCols.address}
                    onResize={(w) => patchOscCols({ address: w })}
                  />
                  <span className="flex-1 text-muted">args</span>
                </div>
                <div
                  ref={oscInScrollRef}
                  onScroll={onOscInScroll}
                  className="flex-1 min-h-0 overflow-y-auto font-mono text-[11px] leading-[14px]"
                >
                  {oscInRows.length === 0 ? (
                    <div className="p-3 text-muted text-[11px]">
                      No incoming OSC yet. Is the listener on the right port, and
                      is your device sending to this machine? (See Pool → Network.)
                    </div>
                  ) : (
                    oscInRows.map((e, i) => (
                      <div
                        key={i}
                        className="flex gap-2 px-2 py-[1px] whitespace-nowrap hover:bg-panel2"
                      >
                        <span
                          className="text-muted shrink-0 tabular-nums"
                          style={{ width: oscCols.time }}
                        >
                          {formatTime(e.timestamp)}
                        </span>
                        <span className="text-muted shrink-0">|</span>
                        <span
                          className="shrink-0 truncate text-muted"
                          style={{ width: oscCols.dest }}
                          title={`${e.ip}:${e.port}`}
                        >
                          {e.ip}:{e.port}
                        </span>
                        <span
                          className="shrink-0 truncate"
                          style={{ width: oscCols.address, color: 'rgb(var(--c-accent2))' }}
                          title={e.address}
                        >
                          {e.address || '—'}
                        </span>
                        <span
                          className="truncate"
                          title={e.kind === 'err' ? undefined : formatArgs(e.args)}
                        >
                          {e.kind === 'err' ? '' : formatArgs(e.args)}
                        </span>
                      </div>
                    ))
                  )}
                </div>
              </div>
            )}
            {showOscIn && (showOsc || showMidi) && (
              <ResizeHandle
                direction="col"
                value={oscInColPx}
                onChange={setOscInColPx}
                min={160}
                max={effectiveOscMax}
                className="w-[4px] cursor-col-resize z-10 bg-border/40 hover:bg-accent/40"
                title="Drag to resize the OSC In column"
              />
            )}
            {showOsc && (
              <div
                className="flex flex-col min-h-0"
                style={{
                  flex: showMidi ? `0 0 ${oscColPx}px` : '1 1 0',
                  borderRight: showMidi ? '1px solid rgb(var(--c-border))' : undefined
                }}
              >
                {/* Header row — column labels with draggable right
                    edges. Drag a label's right edge to widen / narrow
                    that column. All log rows below pick up the same
                    widths. */}
                <div className="flex items-center gap-2 px-2 py-0.5 text-[9px] uppercase tracking-wider text-muted border-b border-border shrink-0 select-none min-h-[20px]">
                  <ColHeader
                    label="time"
                    width={oscCols.time}
                    onResize={(w) => patchOscCols({ time: w })}
                  />
                  <span className="text-border shrink-0">|</span>
                  <ColHeader
                    label="kind"
                    width={oscCols.kind}
                    onResize={(w) => patchOscCols({ kind: w })}
                  />
                  <ColHeader
                    label="ip:port"
                    width={oscCols.dest}
                    onResize={(w) => patchOscCols({ dest: w })}
                  />
                  <ColHeader
                    label="address"
                    width={oscCols.address}
                    onResize={(w) => patchOscCols({ address: w })}
                  />
                  <span className="flex-1 text-muted">args</span>
                </div>
                <div
                  ref={scrollRef}
                  onScroll={onScroll}
                  className="flex-1 min-h-0 overflow-y-auto font-mono text-[11px] leading-[14px]"
                >
                  {rows.length === 0 ? (
                    <div className="p-3 text-muted text-[11px]">
                      No OSC traffic yet. Trigger a scene or clip to see messages here.
                    </div>
                  ) : (
                    rows.map((e, i) => (
                      <div
                        key={i}
                        className={`flex gap-2 px-2 py-[1px] whitespace-nowrap ${
                          e.kind === 'err' ? 'bg-danger/10 hover:bg-danger/20' : 'hover:bg-panel2'
                        }`}
                      >
                        <span
                          className="text-muted shrink-0 tabular-nums"
                          style={{ width: oscCols.time }}
                        >
                          {formatTime(e.timestamp)}
                        </span>
                        <span className="text-muted shrink-0">|</span>
                        <span
                          className={`shrink-0 ${e.kind === 'err' ? 'text-danger font-bold' : 'text-muted'}`}
                          style={{ width: oscCols.kind }}
                        >
                          {e.kind === 'err' ? '[ERR]' : 'send'}
                        </span>
                        <span
                          className={`shrink-0 truncate ${
                            e.kind === 'err' ? 'text-danger' : 'text-muted'
                          }`}
                          style={{ width: oscCols.dest }}
                          title={e.ip === '*' ? 'Socket-level error' : `${e.ip}:${e.port}`}
                        >
                          {e.ip === '*' ? '(socket)' : `${e.ip}:${e.port}`}
                        </span>
                        <span
                          className={`shrink-0 truncate ${
                            e.kind === 'err' ? 'text-muted' : 'text-accent'
                          }`}
                          style={{ width: oscCols.address }}
                          title={e.address}
                        >
                          {e.address || '—'}
                        </span>
                        <span
                          className={`truncate ${e.kind === 'err' ? 'text-danger' : ''}`}
                          title={e.kind === 'err' ? e.message : formatArgs(e.args)}
                        >
                          {e.kind === 'err' ? e.message : formatArgs(e.args)}
                        </span>
                      </div>
                    ))
                  )}
                </div>
              </div>
            )}
            {showOsc && showMidi && (
              // Vertical resize handle between the two columns. Drag
              // RIGHT to widen OSC (and shrink MIDI), LEFT to widen
              // MIDI. The handle works on the OSC column's pixel
              // width so the delta is direct — no parent-width math.
              <ResizeHandle
                direction="col"
                value={oscColPx}
                onChange={setOscColPx}
                min={160}
                max={effectiveOscMax}
                className="w-[4px] cursor-col-resize z-10 bg-border/40 hover:bg-accent/40"
                title="Drag to resize OSC vs MIDI columns"
              />
            )}
            {showMidi && (
              <div className="flex flex-col min-h-0" style={{ flex: '1 1 0' }}>
                {/* MIDI header — same per-column resize pattern as OSC. */}
                <div className="flex items-center gap-2 px-2 py-0.5 text-[9px] uppercase tracking-wider text-muted border-b border-border shrink-0 select-none min-h-[20px]">
                  <ColHeader
                    label="time"
                    width={midiCols.time}
                    onResize={(w) => patchMidiCols({ time: w })}
                  />
                  <span className="text-border shrink-0">|</span>
                  <ColHeader
                    label="kind"
                    width={midiCols.kind}
                    onResize={(w) => patchMidiCols({ kind: w })}
                  />
                  <ColHeader
                    label="port"
                    width={midiCols.port}
                    onResize={(w) => patchMidiCols({ port: w })}
                  />
                  <ColHeader
                    label="ch"
                    width={midiCols.channel}
                    onResize={(w) => patchMidiCols({ channel: w })}
                  />
                  <span className="flex-1 text-muted">data</span>
                </div>
                <div
                  ref={midiScrollRef}
                  onScroll={onMidiScroll}
                  className="flex-1 min-h-0 overflow-y-auto font-mono text-[11px] leading-[14px]"
                >
                  {midiRows.length === 0 ? (
                    <div className="p-3 text-muted text-[11px]">
                      No MIDI traffic yet. Enable MIDI on a cell + pick a port to see messages here.
                    </div>
                  ) : (
                    midiRows.map((e, i) => (
                      <div
                        key={i}
                        className={`flex gap-2 px-2 py-[1px] whitespace-nowrap ${
                          e.rowKind === 'err' ? 'bg-danger/10 hover:bg-danger/20' : 'hover:bg-panel2'
                        }`}
                      >
                        <span
                          className="text-muted shrink-0 tabular-nums"
                          style={{ width: midiCols.time }}
                        >
                          {formatTime(e.timestamp)}
                        </span>
                        <span className="text-muted shrink-0">|</span>
                        <span
                          className={`shrink-0 ${
                            e.rowKind === 'err'
                              ? 'text-danger font-bold'
                              : e.kind === 'noteOn'
                                ? 'text-accent'
                                : 'text-muted'
                          }`}
                          style={{ width: midiCols.kind }}
                        >
                          {e.rowKind === 'err'
                            ? '[ERR]'
                            : e.kind === 'noteOn'
                              ? 'noteOn'
                              : e.kind === 'noteOff'
                                ? 'noteOff'
                                : 'cc'}
                        </span>
                        <span
                          className={`shrink-0 truncate ${
                            e.rowKind === 'err' ? 'text-danger' : 'text-muted'
                          }`}
                          style={{ width: midiCols.port }}
                          title={e.portName || '(no port)'}
                        >
                          {e.portName || '—'}
                        </span>
                        <span
                          className="shrink-0 text-muted tabular-nums"
                          style={{ width: midiCols.channel }}
                        >
                          ch{e.channel}
                        </span>
                        {e.rowKind === 'ok' ? (
                          <span className="truncate font-mono">
                            {e.kind === 'cc' ? 'CC ' : 'N '}
                            {e.data1}
                            <span className="text-muted"> = </span>
                            {e.data2}
                          </span>
                        ) : (
                          <span className="truncate text-danger" title={e.message}>
                            {e.message}
                          </span>
                        )}
                      </div>
                    ))
                  )}
                </div>
              </div>
            )}
            {!showOscIn && !showOsc && !showMidi && (
              <div className="flex-1 p-3 text-muted text-[11px]">
                All columns are hidden — toggle OSC In / OSC Out / MIDI in the toolbar above to view traffic.
              </div>
            )}
            {/* "Learned" panel — far right of the MIDI Monitor. Only
                rendered when (a) at least one MIDI binding exists in
                the session AND (b) the MIDI column toolbar checkbox
                is on (no point showing learned MIDI bindings when
                the user has hidden MIDI traffic entirely). Resizable
                via the ResizeHandle on its left edge. Lists every
                binding with its source label, CC/Note + channel, and
                edit / delete buttons. Width persists via
                localStorage. */}
            {learnedBindings.length > 0 && showMidi && (
              <>
                <ResizeHandle
                  direction="col"
                  value={learnedColPx}
                  onChange={setLearnedColPx}
                  min={LEARNED_COL_MIN}
                  max={effectiveLearnedMax}
                  inverse
                  className="shrink-0 w-[4px] bg-border/30 hover:bg-accent cursor-col-resize"
                  title="Drag to resize Learned panel"
                />
                <div
                  className="flex flex-col min-h-0"
                  style={{ flex: `0 0 ${learnedColPx}px` }}
                >
                  <div className="flex items-center gap-2 px-2 py-0.5 text-[9px] uppercase tracking-wider text-muted border-b border-border shrink-0 select-none min-h-[20px]">
                    <span className="font-semibold text-text">Learned</span>
                    <span className="text-muted">
                      {learnedBindings.length} binding
                      {learnedBindings.length === 1 ? '' : 's'}
                    </span>
                  </div>
                  <div className="flex-1 min-h-0 overflow-y-auto font-mono text-[11px] leading-[14px]">
                    {learnedBindings.map((b) => {
                      const isEditing = editingBindingId === b.id
                      return (
                        <div
                          key={b.id}
                          className={`flex items-center gap-1 px-2 py-[2px] group ${
                            isEditing ? 'bg-accent/10' : 'hover:bg-panel2'
                          }`}
                        >
                          <div className="flex flex-col min-w-0 flex-1">
                            <span className="truncate text-text" title={b.label}>
                              {b.label}
                            </span>
                            <span className="text-[9px] text-muted flex items-center gap-1">
                              <span className="uppercase tracking-wider">
                                {b.source}
                              </span>
                              <span>·</span>
                              {isEditing ? (
                                <LearnedBindingInlineEditor
                                  binding={b.binding}
                                  onChange={b.onUpdate}
                                />
                              ) : (
                                <span className="text-accent">
                                  {formatBinding(b.binding)}
                                </span>
                              )}
                            </span>
                          </div>
                          <button
                            className={`btn text-[9px] py-0 px-1 ${
                              isEditing
                                ? 'bg-accent text-black border-accent'
                                : 'opacity-50 group-hover:opacity-100'
                            }`}
                            title={
                              isEditing
                                ? 'Exit edit mode — disables MIDI Learn for this binding.'
                                : 'Toggle edit mode — turns MIDI Learn on (wiggle a control to rebind) AND lets you type the note/CC + channel directly.'
                            }
                            onClick={() => {
                              if (isEditing) {
                                // Exit — clear edit state + clear learn
                                // target + turn learn mode off.
                                setEditingBindingId(null)
                                setMidiLearnTarget(null)
                                setMidiLearnMode(false)
                              } else {
                                // Enter — set this binding as the learn
                                // target (so a MIDI wiggle still rebinds)
                                // AND arm the inline editor for manual
                                // entry.
                                setEditingBindingId(b.id)
                                if (b.editTarget) setMidiLearnTarget(b.editTarget)
                                setMidiLearnMode(true)
                              }
                            }}
                          >
                            {isEditing ? 'Done' : 'Edit'}
                          </button>
                          <button
                            className="btn text-[9px] py-0 px-1 opacity-50 group-hover:opacity-100"
                            style={{
                              color: 'rgb(var(--c-danger))',
                              borderColor: 'rgb(var(--c-danger))'
                            }}
                            title="Delete this MIDI binding (the bound trigger / knob stays — just the MIDI link is removed)"
                            onClick={() => {
                              // Clear edit mode for this row if we
                              // happen to be editing it when deleted.
                              if (editingBindingId === b.id) {
                                setEditingBindingId(null)
                                setMidiLearnTarget(null)
                                setMidiLearnMode(false)
                              }
                              b.onDelete()
                            }}
                          >
                            ✕
                          </button>
                        </div>
                      )
                    })}
                  </div>
                </div>
              </>
            )}
          </div>
        </div>

        {/* Pane 2 — Pool (right). Lists Templates + Parameters, drag
            sources for the Edit-view sidebar. Selecting an item here
            re-points the Edit-view's right-side Inspector at it. When
            popped out, the embedded slot shows a placeholder so the
            drawer layout stays stable. When poolHidden is true, the
            entire pane is removed from the layout — the OSC log gets
            the full drawer width. */}
        {!poolHidden && (
          <>
            {/* Vertical resize bar between Monitor and Pool. Inverse
                drag because the Pool is right-anchored — dragging
                LEFT widens it, dragging RIGHT narrows it. */}
            <ResizeHandle
              direction="col"
              value={poolWidthPx}
              onChange={setPoolWidthPx}
              min={200}
              max={effectivePoolMax}
              inverse
              className="w-[4px] cursor-col-resize z-10 -mr-[2px] -ml-[2px]"
              title="Drag to resize the Pool · narrower Pool = more room for the Monitor toolbar"
            />
            <div
              className="flex flex-col min-h-0 shrink-0"
              style={{ width: poolWidthPx }}
            >
              {poolPoppedOut ? (
                <PoolPoppedOutPlaceholder onDock={() => setPoolPoppedOut(false)} />
              ) : (
                <PoolPane
                  onTogglePopOut={() => setPoolPoppedOut(true)}
                  onHide={() => setPoolHidden(true)}
                />
              )}
            </div>
          </>
        )}
      </div>
      {poolPoppedOut && !poolHidden && (
        <PoolPopOut
          onClose={() => setPoolPoppedOut(false)}
          onHide={() => {
            setPoolPoppedOut(false)
            setPoolHidden(true)
          }}
        />
      )}
    </div>
  )
}

// Floating Pool window — opens centered at ~30% of the viewport and
// the user can drag it anywhere by its title bar. Backdrop is fully
// click-through (pointer-events-none on the overlay, restored on the
// card) so it doesn't block editing the rest of the app.
function PoolPopOut({
  onClose,
  onHide
}: {
  onClose: () => void
  onHide: () => void
}): JSX.Element {
  // Initial geometry — computed once on mount so window resize after
  // pop-out doesn't yank the box around. State is { x, y, w, h } in
  // CSS pixels relative to the viewport top-left.
  const [box, setBox] = useState(() => {
    const w = clamp(window.innerWidth * 0.3, 420, window.innerWidth * 0.9)
    const h = clamp(window.innerHeight * 0.3, 360, window.innerHeight * 0.9)
    return {
      x: Math.round((window.innerWidth - w) / 2),
      y: Math.round((window.innerHeight - h) / 2),
      w: Math.round(w),
      h: Math.round(h)
    }
  })
  // Pointer-driven drag. Snapshot the offset between cursor and the
  // box's top-left at pointerdown so the drag tracks the cursor
  // smoothly (no jump even if the user grabs the bar at the right
  // edge).
  const dragRef = useRef<{ dx: number; dy: number } | null>(null)
  function onTitleBarPointerDown(e: React.PointerEvent): void {
    // Don't start a drag from buttons / inputs inside the bar (Pop-out
    // toggle, Add buttons). They should keep their normal click path.
    const tag = (e.target as HTMLElement | null)?.tagName
    if (tag === 'BUTTON' || tag === 'INPUT' || tag === 'TEXTAREA') return
    e.preventDefault()
    dragRef.current = { dx: e.clientX - box.x, dy: e.clientY - box.y }
    ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
  }
  function onTitleBarPointerMove(e: React.PointerEvent): void {
    const d = dragRef.current
    if (!d) return
    // Clamp so at least 40 px of the title bar stays on-screen — the
    // user can still grab it back.
    const minX = 40 - box.w
    const maxX = window.innerWidth - 40
    const minY = 0
    const maxY = window.innerHeight - 28
    setBox((b) => ({
      ...b,
      x: clamp(e.clientX - d.dx, minX, maxX),
      y: clamp(e.clientY - d.dy, minY, maxY)
    }))
  }
  function onTitleBarPointerUp(e: React.PointerEvent): void {
    dragRef.current = null
    try {
      ;(e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId)
    } catch {
      /* ignore — pointer wasn't captured */
    }
  }

  return createPortal(
    <div className="fixed inset-0 z-[90] pointer-events-none">
      <div
        className="absolute bg-panel border border-border rounded shadow-2xl flex flex-col pointer-events-auto overflow-hidden"
        style={{ left: box.x, top: box.y, width: box.w, height: box.h }}
      >
        {/* Drag handle is the PoolPane's own title bar. We pass the
            pointer event handlers through as props so PoolPane stays
            otherwise unchanged in either context (drawer / popped). */}
        <PoolPane
          poppedOut
          onTogglePopOut={onClose}
          onHide={onHide}
          titleBarHandlers={{
            onPointerDown: onTitleBarPointerDown,
            onPointerMove: onTitleBarPointerMove,
            onPointerUp: onTitleBarPointerUp,
            onPointerCancel: onTitleBarPointerUp,
            style: { cursor: 'grab' }
          }}
        />
      </div>
    </div>,
    document.body
  )
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v))
}

function PoolPoppedOutPlaceholder({
  onDock
}: {
  onDock: () => void
}): JSX.Element {
  return (
    <div className="flex flex-col h-full min-h-0">
      <div className="flex items-center gap-2 px-2 py-1 border-b border-border shrink-0">
        <span className="label">Pool</span>
        <span className="text-muted text-[10px]">popped out</span>
        <div className="flex-1" />
        <button
          className="btn text-[10px] py-0 px-1.5 leading-tight"
          onClick={onDock}
          title="Dock the Pool back into the drawer"
        >
          ⤓ Dock
        </button>
      </div>
      <div className="p-3 text-muted text-[11px]">
        The Pool is open in a floating window. Close it (or click{' '}
        <span className="label">⤓ Dock</span>) to return it here.
      </div>
    </div>
  )
}

// HH:MM:SS.mmm
function formatTime(ms: number): string {
  const d = new Date(ms)
  const hh = String(d.getHours()).padStart(2, '0')
  const mm = String(d.getMinutes()).padStart(2, '0')
  const ss = String(d.getSeconds()).padStart(2, '0')
  const mmm = String(d.getMilliseconds()).padStart(3, '0')
  return `${hh}:${mm}:${ss}.${mmm}`
}

function formatArgs(args: OscEvent['args']): string {
  return args
    .map((a) => {
      if (a.type === 'f' && typeof a.value === 'number') return a.value.toFixed(4)
      if (a.type === 'T' || a.type === 'F') return a.type === 'T' ? 'true' : 'false'
      return String(a.value)
    })
    .join(' ')
}

// Column-header cell with a draggable right edge. The user grabs
// the 3-px strip at the right of the label and drags horizontally
// to resize the column. Width persists via the caller's onResize
// callback. Min 24 px (so a column never collapses past its
// label) and max 800 px (so one column can't eat the whole drawer).
function ColHeader({
  label,
  width,
  onResize
}: {
  label: string
  width: number
  onResize: (w: number) => void
}): JSX.Element {
  function onMouseDown(e: React.MouseEvent): void {
    e.preventDefault()
    e.stopPropagation()
    const startX = e.clientX
    const startW = width
    const onMove = (ev: MouseEvent): void => {
      const next = Math.max(24, Math.min(800, startW + (ev.clientX - startX)))
      onResize(next)
    }
    const onUp = (): void => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }
  return (
    <span
      className="shrink-0 relative truncate"
      style={{ width }}
      title={`${label} — drag right edge to resize`}
    >
      {label}
      <span
        onMouseDown={onMouseDown}
        className="absolute right-[-2px] top-0 bottom-0 w-[4px] cursor-col-resize hover:bg-accent/40"
        // No content — just a hover target.
      />
    </span>
  )
}
