// OSC monitor — bottom drawer that streams outgoing OSC messages for
// debugging. Subscribes to `onOscEvents` (batched from main every 50ms),
// keeps a ring buffer of the last MAX_ROWS messages, and renders them in a
// scrollable log. Autoscroll sticks to the bottom unless the user scrolls up.
//
// Default-off (per the simplex principle). The toggle lives in the prefs
// sub-toolbar. When closed, this component unmounts entirely — no
// subscription, no memory cost.

import { useEffect, useMemo, useRef, useState } from 'react'
import type { OscEvent } from '@shared/types'
import { useStore } from '../store'

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
  const bufferRef = useRef<OscEvent[]>([])
  const [, setTick] = useState(0)
  const scrollRef = useRef<HTMLDivElement>(null)
  const stickToBottomRef = useRef(true)

  // Subscribe to batched OSC events from main.
  useEffect(() => {
    let pendingRender = false
    const off = window.api.onOscEvents((batch) => {
      if (paused) return
      const buf = bufferRef.current
      for (const e of batch) buf.push(e)
      if (buf.length > MAX_ROWS) buf.splice(0, buf.length - MAX_ROWS)
      // Throttle re-renders to ~10Hz. requestAnimationFrame would be
      // too eager at 60Hz when batches arrive every 50ms.
      if (!pendingRender) {
        pendingRender = true
        setTimeout(() => {
          pendingRender = false
          setTick((n) => n + 1)
        }, 100)
      }
    })
    return off
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
      className="border-t border-border bg-panel flex flex-col shrink-0"
      style={{ height: 168 }}
    >
      {/* Header strip */}
      <div className="flex items-center gap-2 px-2 py-1.5 border-b border-border">
        <span className="label shrink-0">OSC Monitor</span>
        <span className="text-muted text-[10px] shrink-0">
          {rows.length} / {bufferRef.current.length}
        </span>
        <input
          className="input w-48 text-[11px] py-0.5"
          placeholder="Filter by address or ip:port"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
        <button
          className={`btn text-[11px] py-0.5 ${paused ? 'bg-accent text-black border-accent' : ''}`}
          onClick={() => setPaused((v) => !v)}
          title={paused ? 'Resume capture' : 'Pause capture (events still flow, just not displayed)'}
        >
          {paused ? 'Paused' : 'Live'}
        </button>
        <button className="btn text-[11px] py-0.5" onClick={clearLog}>
          Clear
        </button>
        <div className="flex-1" />
        <button className="btn text-[11px] py-0.5" onClick={onClose} title="Close monitor">
          ×
        </button>
      </div>

      {/* Log — monospace, fixed row height, pre-truncated args. */}
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
              className="flex gap-2 px-2 py-[1px] hover:bg-panel2 whitespace-nowrap"
            >
              <span className="text-muted shrink-0 w-16 tabular-nums">
                {formatTime(e.timestamp)}
              </span>
              <span className="text-muted shrink-0">|</span>
              <span className="text-muted shrink-0 w-28 truncate" title={`${e.ip}:${e.port}`}>
                {e.ip}:{e.port}
              </span>
              <span className="text-accent shrink-0 w-40 truncate" title={e.address}>
                {e.address}
              </span>
              <span className="truncate" title={formatArgs(e.args)}>
                {formatArgs(e.args)}
              </span>
            </div>
          ))
        )}
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
