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
import type { OscErrorEvent, OscEvent } from '@shared/types'
import { useStore } from '../store'
import PoolPane from './PoolPane'
import { ResizeHandle } from './ResizeHandle'

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
  const poolHidden = useStore((s) => s.poolHidden)
  const setPoolHidden = useStore((s) => s.setPoolHidden)
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
        min={120}
        max={600}
        inverse
        className="absolute top-0 left-0 right-0 h-[4px] z-20 cursor-row-resize"
        title="Drag to resize the OSC monitor drawer"
      />
      {/* Two-pane body. Border between panes gives the user a clear read
          on "this is one widget with two sections." Each pane owns its
          own scroll. The previous "OSC Monitor + Pool" wrapper title bar
          has been folded into the log toolbar to save vertical space:
          close button → OSC Monitor label → counters → filter → Live →
          Clear. */}
      <div className="flex-1 min-h-0 flex">
        {/* Pane 1 — OSC log (left, ~65%). */}
        <div className="flex flex-col min-h-0 border-r border-border" style={{ flex: '2 1 0' }}>
          {/* Log toolbar — single strip carrying everything that used to
              live in two stacked title bars. Order: ✕ close, OSC Monitor
              label, "Log N/M" counter, filter input, Live, Clear. The
              filter shrinks to fit (min-w-0) so all the trailing buttons
              still have room on a narrow window. */}
          <div className="flex items-center gap-2 px-2 py-1 border-b border-border shrink-0">
            <button
              className="btn text-[11px] py-0 leading-tight px-1.5 shrink-0"
              onClick={onClose}
              title="Close drawer"
            >
              ×
            </button>
            <span className="label shrink-0">OSC Monitor</span>
            <span className="text-muted text-[10px] shrink-0">
              Log {rows.length}/{bufferRef.current.length}
            </span>
            {poolHidden && (
              // Mini-toggle to bring the Pool back. Lives in the log
              // toolbar so it's always visible while the Pool is dismissed.
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
              placeholder="Filter by address or ip:port"
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

        {/* Pane 2 — Pool (right). Lists Templates + Parameters, drag
            sources for the Edit-view sidebar. Selecting an item here
            re-points the Edit-view's right-side Inspector at it. When
            popped out, the embedded slot shows a placeholder so the
            drawer layout stays stable. When poolHidden is true, the
            entire pane is removed from the layout — the OSC log gets
            the full drawer width. */}
        {!poolHidden && (
          <div className="flex flex-col min-h-0" style={{ flex: '1 1 0', minWidth: 240 }}>
            {poolPoppedOut ? (
              <PoolPoppedOutPlaceholder onDock={() => setPoolPoppedOut(false)} />
            ) : (
              <PoolPane
                onTogglePopOut={() => setPoolPoppedOut(true)}
                onHide={() => setPoolHidden(true)}
              />
            )}
          </div>
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
