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
  MidiErrorEvent,
  MidiSendEvent,
  OscErrorEvent,
  OscEvent
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
const ipcOffFns: Array<() => void> = []
if (typeof window !== 'undefined' && window.api) {
  const offOsc = window.api.onOscEvents?.((batch) => {
    if (bufferPaused) return
    for (const e of batch) oscBuffer.push({ kind: 'ok', ...e })
    if (oscBuffer.length > MAX_ROWS) oscBuffer.splice(0, oscBuffer.length - MAX_ROWS)
    scheduleBump()
  })
  const offOscErr = window.api.onOscErrors?.((batch) => {
    if (bufferPaused) return
    for (const e of batch) oscBuffer.push({ kind: 'err', ...e })
    if (oscBuffer.length > MAX_ROWS) oscBuffer.splice(0, oscBuffer.length - MAX_ROWS)
    scheduleBump()
  })
  const offMidi = window.api.onMidiEvents?.((batch) => {
    if (bufferPaused) return
    for (const e of batch) midiBuffer.push({ rowKind: 'ok', ...e })
    if (midiBuffer.length > MAX_ROWS) midiBuffer.splice(0, midiBuffer.length - MAX_ROWS)
    scheduleBump()
  })
  const offMidiErr = window.api.onMidiErrors?.((batch) => {
    if (bufferPaused) return
    for (const e of batch) midiBuffer.push({ rowKind: 'err', ...e })
    if (midiBuffer.length > MAX_ROWS) midiBuffer.splice(0, midiBuffer.length - MAX_ROWS)
    scheduleBump()
  })
  if (offOsc) ipcOffFns.push(offOsc)
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
  // Pool pane width — same pattern. Drives `style={{ width: poolWidthPx }}`
  // on the right pane and `style={{ width: '100% - poolWidthPx' }}` on the
  // left pane (via flex: 1). The resize bar between them uses an inverse
  // drag because the Pool is RIGHT-anchored (dragging right shrinks it).
  const [poolWidthPx, setPoolWidthPxState] = useState<number>(() =>
    loadPoolWidthPx()
  )
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
  // Buffers live at module scope (top of this file) so closing +
  // reopening the drawer keeps the captured history visible. We just
  // re-render this component on every coalesced bump via the
  // `bumpListeners` registry.
  const [, setTick] = useState(0)
  const scrollRef = useRef<HTMLDivElement>(null)
  const midiScrollRef = useRef<HTMLDivElement>(null)
  const stickToBottomRef = useRef(true)
  const midiStickToBottomRef = useRef(true)

  // Mirror the local `paused` state into the module-scope flag so
  // the IPC subscribers (which can't see component state) can skip
  // their pushes. Both halves stay in sync.
  useEffect(() => {
    bufferPaused = paused
  }, [paused])

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
  function onMidiScroll(): void {
    const el = midiScrollRef.current
    if (!el) return
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 20
    midiStickToBottomRef.current = atBottom
  }

  function clearLog(): void {
    oscBuffer.length = 0
    midiBuffer.length = 0
    setTick((n) => n + 1)
  }

  const rows = useMemo(() => {
    if (!filter.trim()) return oscBuffer
    const f = filter.trim().toLowerCase()
    return oscBuffer.filter(
      (e) =>
        e.address.toLowerCase().includes(f) ||
        `${e.ip}:${e.port}`.includes(f)
    )
    // rows recomputes on every tick because we mutate the module
    // buffer in place; the length dep is enough since we never
    // splice in the middle. React re-renders on the bump listener.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filter, oscBuffer.length])
  // MIDI rows mirror the OSC rows. Filter matches against the port
  // name, the message kind, or "ch N" — same UX as OSC's ip:port +
  // address filter but adapted to the MIDI fields.
  const midiRows = useMemo(() => {
    if (!filter.trim()) return midiBuffer
    const f = filter.trim().toLowerCase()
    return midiBuffer.filter((e) => {
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
      <div className="flex-1 min-h-0 flex relative">
        {/* Pane 1 — Monitor (OSC + MIDI in parallel columns). */}
        <div className="flex flex-col min-h-0 border-r border-border flex-1 min-w-0">
          {/* Single combined toolbar. Order:
              ✕ close · Monitor label · OSC + MIDI checkboxes ·
              counts · filter · Live · Clear. */}
          <div className="flex items-center gap-2 px-2 py-1 border-b border-border shrink-0">
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
              title="Show OSC events column"
            >
              <input
                type="checkbox"
                checked={showOsc}
                onChange={(e) => setShowOsc(e.target.checked)}
              />
              <span>OSC</span>
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
              When only one column is on, it takes the full width. */}
          <div className="flex-1 min-h-0 flex relative">
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
                <div className="flex gap-2 px-2 py-0.5 text-[9px] uppercase tracking-wider text-muted border-b border-border shrink-0 select-none">
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
                max={1600}
                className="w-[4px] cursor-col-resize z-10 bg-border/40 hover:bg-accent/40"
                title="Drag to resize OSC vs MIDI columns"
              />
            )}
            {showMidi && (
              <div className="flex flex-col min-h-0" style={{ flex: '1 1 0' }}>
                {/* MIDI header — same per-column resize pattern as OSC. */}
                <div className="flex gap-2 px-2 py-0.5 text-[9px] uppercase tracking-wider text-muted border-b border-border shrink-0 select-none">
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
            {!showOsc && !showMidi && (
              <div className="flex-1 p-3 text-muted text-[11px]">
                Both columns are hidden — toggle OSC or MIDI in the toolbar above to view traffic.
              </div>
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
              max={1200}
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
