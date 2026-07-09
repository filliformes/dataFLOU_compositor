// (v0.6.4) Connection Health UI — a full panel (Pool → Network) and a
// compact pill (transport bottom bar) over the shared health model in
// connectionHealth.ts. Answers "why is nothing happening?" at a glance.

import { useEffect, useRef, useState } from 'react'
import {
  destUnreachable,
  useConnectionHealth,
  type HealthSnapshot
} from '../connectionHealth'

const STATUS_COLOR: Record<HealthSnapshot['overall'], string> = {
  ok: '#4ade80',
  warn: '#facc15',
  error: 'rgb(var(--c-danger))'
}
const STATUS_LABEL: Record<HealthSnapshot['overall'], string> = {
  ok: 'OSC flowing',
  warn: 'check OSC',
  error: 'OSC problem'
}

function ago(ms: number): string {
  if (ms <= 0) return 'never'
  const s = (Date.now() - ms) / 1000
  if (s < 1) return 'now'
  if (s < 60) return `${s.toFixed(0)}s ago`
  return `${(s / 60).toFixed(0)}m ago`
}

// The full breakdown — used inside the Network tab and inside the pill's
// popover. `dense` tightens padding for the popover.
export function ConnectionHealthBody({
  h,
  dense = false
}: {
  h: HealthSnapshot
  dense?: boolean
}): JSX.Element {
  const pad = dense ? 'gap-1' : 'gap-1.5'
  return (
    <div className={`flex flex-col ${pad} text-[10px]`}>
      {/* Listener */}
      <div className="flex items-center gap-1.5">
        <Dot on={h.listenerOn && !h.listenerError} warn={!h.listenerOn} err={!!h.listenerError} />
        <span className="text-muted">Listener</span>
        {h.listenerOn ? (
          <span className="tabular-nums">
            :{h.listenerPort} · {h.inRatePerSec} pkt/s in
          </span>
        ) : (
          <span style={{ color: '#facc15' }}>off — nothing can be received</span>
        )}
        {h.listenerError && (
          <span style={{ color: 'rgb(var(--c-danger))' }} title={h.listenerError}>
            {h.listenerError}
          </span>
        )}
      </div>

      {/* Incoming sources */}
      <div className="flex flex-col gap-0.5">
        <span className="text-muted uppercase tracking-wider text-[8px]">
          Incoming ({h.sources.length})
        </span>
        {h.sources.length === 0 ? (
          <span className="text-muted italic pl-3">
            {h.listenerOn
              ? 'no packets — is your device sending to this machine on this port?'
              : 'listener off'}
          </span>
        ) : (
          h.sources.slice(0, 6).map((s) => (
            <div key={s.key} className="flex items-center gap-1.5 pl-3 tabular-nums">
              <Dot on warn={false} err={false} />
              <span className="truncate">
                {s.ip}:{s.port}
              </span>
              <span className="text-muted">· {ago(s.lastSeenMs)}</span>
            </div>
          ))
        )}
      </div>

      {/* Outgoing destinations */}
      <div className="flex flex-col gap-0.5">
        <span className="text-muted uppercase tracking-wider text-[8px]">
          Destinations ({h.destinations.length})
        </span>
        {h.destinations.length === 0 ? (
          <span className="text-muted italic pl-3">
            nothing sent yet (play a scene / enable Direct Output)
          </span>
        ) : (
          h.destinations.slice(0, 8).map((d) => {
            const bad = destUnreachable(d)
            return (
              <div
                key={d.key}
                className="flex items-center gap-1.5 pl-3 tabular-nums"
                title={bad ? d.lastError : `${d.ip}:${d.port}`}
              >
                <Dot on={!bad} warn={false} err={bad} />
                <span
                  className="truncate"
                  style={bad ? { color: 'rgb(var(--c-danger))' } : undefined}
                >
                  {d.ip}:{d.port}
                </span>
                {bad ? (
                  <span style={{ color: 'rgb(var(--c-danger))' }}>
                    unreachable — {d.lastError}
                  </span>
                ) : (
                  <span className="text-muted">· {ago(d.lastSeenMs)}</span>
                )}
              </div>
            )
          })
        )}
      </div>
    </div>
  )
}

function Dot({ on, warn, err }: { on: boolean; warn: boolean; err: boolean }): JSX.Element {
  const color = err ? 'rgb(var(--c-danger))' : warn ? '#facc15' : on ? '#4ade80' : 'rgb(var(--c-muted))'
  return (
    <span
      className="inline-block w-2 h-2 rounded-full shrink-0"
      style={{ background: color }}
    />
  )
}

// Full panel for the Network tab.
export function ConnectionHealthPanel(): JSX.Element {
  const h = useConnectionHealth()
  return (
    <div className="border border-border rounded p-2 bg-panel2/30 flex flex-col gap-1.5">
      <div className="flex items-center gap-1.5">
        <span
          className="inline-block w-2.5 h-2.5 rounded-full shrink-0"
          style={{ background: STATUS_COLOR[h.overall] }}
        />
        <span className="label">Connection Health</span>
        <span className="text-[9px] text-muted">— {STATUS_LABEL[h.overall]}</span>
      </div>
      <ConnectionHealthBody h={h} />
    </div>
  )
}

// Compact pill for the transport bottom bar. Click opens the full body in
// a popover that grows UPWARD (the bar sits at the bottom of the window).
export function ConnectionHealthPill(): JSX.Element {
  const h = useConnectionHealth()
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent): void => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    window.addEventListener('mousedown', onDown)
    return () => window.removeEventListener('mousedown', onDown)
  }, [open])
  return (
    <div className="relative shrink-0" ref={ref}>
      <button
        className="flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded hover:bg-panel2"
        onClick={() => setOpen((v) => !v)}
        title="Connection health — click for details"
      >
        <span
          className="inline-block w-2 h-2 rounded-full"
          style={{ background: STATUS_COLOR[h.overall] }}
        />
        <span className="text-muted">OSC</span>
      </button>
      {open && (
        <div
          className="absolute right-0 bottom-full mb-1 z-50 w-[300px] rounded border border-border bg-panel shadow-lg p-2"
          style={{ boxShadow: '0 -4px 16px rgb(0 0 0 / 0.35)' }}
        >
          <div className="flex items-center gap-1.5 mb-1">
            <span
              className="inline-block w-2.5 h-2.5 rounded-full shrink-0"
              style={{ background: STATUS_COLOR[h.overall] }}
            />
            <span className="label text-[11px]">Connection Health</span>
            <span className="text-[9px] text-muted">— {STATUS_LABEL[h.overall]}</span>
          </div>
          <ConnectionHealthBody h={h} dense />
        </div>
      )}
    </div>
  )
}
