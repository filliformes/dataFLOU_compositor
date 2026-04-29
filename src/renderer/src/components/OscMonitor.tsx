// OSC monitor — bottom drawer that hosts THREE panes side-by-side:
//   1. OSC log (left)            — outgoing OSC traffic, the original use.
//   2. Pool (center)              — Instrument Templates + Functions library.
//   3. Instruments Inspector (right) — edit the Pool selection's params.
//
// All three live in the same drawer so the user has one place to manage
// "what instruments exist + what they're sending." Pool drag handles
// instantiate Templates / Functions into the Edit-view sidebar.
//
// Default-off (per the simplex principle). The toggle lives in the top
// toolbar. When closed, this component unmounts entirely — no subscription,
// no memory cost.

import { useEffect, useMemo, useRef, useState } from 'react'
import type { OscErrorEvent, OscEvent } from '@shared/types'
import { useStore } from '../store'
import PoolPane from './PoolPane'
import InstrumentsInspectorPane from './InstrumentsInspectorPane'

// Discriminated-union row so the log can interleave successful sends
// with failures. Kind is the only distinguishing field; everything else
// lines up with OscEvent / OscErrorEvent structurally.
type MonitorRow =
  | ({ kind: 'ok' } & OscEvent)
  | ({ kind: 'err' } & OscErrorEvent)

// Hard cap on in-memory rows. At 120Hz × 4 active cells we see ~500 msg/sec,
// so 1000 rows ≈ 2 seconds of history. Enough to eyeball, small enough to
// render cheaply in the DOM. If we need longer history later, switch to a
// virtualized list.
const MAX_ROWS = 1000

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
  // Store raw events in a ref so the subscriber doesn't trigger a re-render
  // per batch (would stall the UI at high send rates). We bump `tick` on each
  // flush to force a render, throttled to ~10Hz.
  const bufferRef = useRef<MonitorRow[]>([])
  const [, setTick] = useState(0)
  const scrollRef = useRef<HTMLDivElement>(null)
  const stickToBottomRef = useRef(true)

  // Subscribe to batched OSC events AND errors from main. Both streams
  // feed the same ring buffer — errors render as red [ERR] rows with
  // the failure message as the "args" column.
  useEffect(() => {
    let pendingRender = false
    const scheduleRender = (): void => {
      if (pendingRender) return
      pendingRender = true
      setTimeout(() => {
        pendingRender = false
        setTick((n) => n + 1)
      }, 100)
    }
    const offEvents = window.api.onOscEvents((batch) => {
      if (paused) return
      const buf = bufferRef.current
      for (const e of batch) buf.push({ kind: 'ok', ...e })
      if (buf.length > MAX_ROWS) buf.splice(0, buf.length - MAX_ROWS)
      scheduleRender()
    })
    const offErrors = window.api.onOscErrors((batch) => {
      if (paused) return
      const buf = bufferRef.current
      for (const e of batch) buf.push({ kind: 'err', ...e })
      if (buf.length > MAX_ROWS) buf.splice(0, buf.length - MAX_ROWS)
      scheduleRender()
    })
    return () => {
      offEvents()
      offErrors()
    }
  }, [paused])

  // Auto-scroll to bottom when new rows arrive, unless the user has scrolled
  // up. Detect intent via the scroll handler below.
  useEffect(() => {
    if (!stickToBottomRef.current) return
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  })

  function onScroll(): void {
    const el = scrollRef.current
    if (!el) return
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 20
    stickToBottomRef.current = atBottom
  }

  function clearLog(): void {
    bufferRef.current = []
    setTick((n) => n + 1)
  }

  const rows = useMemo(() => {
    const buf = bufferRef.current
    if (!filter.trim()) return buf
    const f = filter.trim().toLowerCase()
    return buf.filter(
      (e) =>
        e.address.toLowerCase().includes(f) ||
        `${e.ip}:${e.port}`.includes(f)
    )
    // rows recomputes on every tick because we mutate buf in place; a stable
    // deps list is fine — React re-renders when setTick fires.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filter, bufferRef.current.length])

  return (
    <div
      // Bumped from 168 → 260 because we now host 3 panes side-by-side:
      // OSC log | Pool | Instruments Inspector. The Pool needs vertical
      // room to comfortably show 3-4 templates expanded, and the Inspector
      // needs to fit the typical Function form (~9 fields).
      className="border-t border-border bg-panel flex flex-col shrink-0"
      style={{ height: 260 }}
    >
      {/* Top header strip — close button on the right; per-pane controls
          live inside each pane's own header so each is self-contained. */}
      <div className="flex items-center gap-2 px-2 py-1 border-b border-border">
        <span className="label shrink-0">OSC Monitor + Pool</span>
        <div className="flex-1" />
        <button className="btn text-[11px] py-0.5" onClick={onClose} title="Close drawer">
          ×
        </button>
      </div>

      {/* Three-pane body. Borders between panes give the user a clear
          read on "this is one widget with three sections." Each pane
          owns its own scroll. */}
      <div className="flex-1 min-h-0 flex">
        {/* Pane 1 — OSC log (left, ~50%). */}
        <div className="flex flex-col min-h-0 border-r border-border" style={{ flex: '2 1 0' }}>
          {/* Log toolbar */}
          <div className="flex items-center gap-2 px-2 py-1 border-b border-border shrink-0">
            <span className="label">Log</span>
            <span className="text-muted text-[10px]">
              {rows.length} / {bufferRef.current.length}
            </span>
            <input
              className="input flex-1 min-w-0 text-[11px] py-0.5"
              placeholder="Filter by address or ip:port"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
            />
            <button
              className={`btn text-[10px] py-0.5 ${paused ? 'bg-accent text-black border-accent' : ''}`}
              onClick={() => setPaused((v) => !v)}
              title={paused ? 'Resume capture' : 'Pause capture (events still flow, just not displayed)'}
            >
              {paused ? 'Paused' : 'Live'}
            </button>
            <button className="btn text-[10px] py-0.5" onClick={clearLog}>
              Clear
            </button>
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
              <span className="text-muted shrink-0 w-16 tabular-nums">
                {formatTime(e.timestamp)}
              </span>
              <span className="text-muted shrink-0">|</span>
              <span
                className={`shrink-0 w-10 ${e.kind === 'err' ? 'text-danger font-bold' : 'text-muted'}`}
              >
                {e.kind === 'err' ? '[ERR]' : 'send'}
              </span>
              <span
                className={`shrink-0 w-28 truncate ${
                  e.kind === 'err' ? 'text-danger' : 'text-muted'
                }`}
                title={e.ip === '*' ? 'Socket-level error' : `${e.ip}:${e.port}`}
              >
                {e.ip === '*' ? '(socket)' : `${e.ip}:${e.port}`}
              </span>
              <span
                className={`shrink-0 w-40 truncate ${
                  e.kind === 'err' ? 'text-muted' : 'text-accent'
                }`}
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

        {/* Pane 2 — Pool (center). Lists Templates + Functions, drag
            sources for the Edit-view sidebar. */}
        <div
          className="flex flex-col min-h-0 border-r border-border"
          style={{ flex: '1 1 0', minWidth: 220 }}
        >
          <PoolPane />
        </div>

        {/* Pane 3 — Instruments Inspector (right). Edits the Pool's
            current selection. */}
        <div className="flex flex-col min-h-0" style={{ flex: '1 1 0', minWidth: 240 }}>
          <InstrumentsInspectorPane />
        </div>
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
