// Rainbow-Circuit-flavoured slider for rich themes (Nature,
// Cream-as-Peaks), used in place of <input type="range">. The file
// once also held the half-circle RcArcSlider; it was never rendered
// anywhere and has been removed — RcFlatBar is what the Inspector uses.

import { useCallback, useRef } from 'react'

// ─────────────────────────────────────────────────────────────────
// RcFlatBar — Rainbow-Circuit-flavoured but LESS theatrical than an
// arc. Horizontal gradient-fill bar with a value readout under it.
// No segmentation, no pump animation — just a clean tonal sweep that
// reflects the value. Used for parameters where the arc's footprint
// + drama was too much (Sequencer Variation specifically — the user
// asked for something more restrained).
// ─────────────────────────────────────────────────────────────────

export function RcFlatBar({
  value,
  min,
  max,
  step = 1,
  label,
  format,
  onChange,
  onCommit
}: {
  value: number
  min: number
  max: number
  step?: number
  label?: string
  format?: (v: number) => string
  onChange: (v: number) => void
  onCommit?: (v: number) => void
}): JSX.Element {
  const wrapRef = useRef<HTMLDivElement>(null)
  const span = max - min
  const norm = span === 0 ? 0 : Math.max(0, Math.min(1, (value - min) / span))
  const setFromClient = useCallback(
    (clientX: number, commit: boolean): void => {
      const el = wrapRef.current
      if (!el) return
      const rect = el.getBoundingClientRect()
      const frac = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width))
      const raw = min + frac * span
      const stepped = step > 0 ? Math.round(raw / step) * step : raw
      const clamped = Math.max(min, Math.min(max, stepped))
      onChange(clamped)
      if (commit && onCommit) onCommit(clamped)
    },
    [max, min, onChange, onCommit, span, step]
  )
  return (
    <div className="flex flex-col items-stretch gap-1 w-full">
      <div
        ref={wrapRef}
        role="slider"
        aria-valuemin={min}
        aria-valuemax={max}
        aria-valuenow={value}
        aria-label={label}
        onPointerDown={(e) => {
          try {
            ;(e.currentTarget as Element).setPointerCapture?.(e.pointerId)
          } catch {
            /* some browsers throw on capture w/o button — ignore */
          }
          setFromClient(e.clientX, false)
        }}
        onPointerMove={(e) => {
          if ((e.buttons & 1) === 0) return
          setFromClient(e.clientX, false)
        }}
        onPointerUp={(e) => {
          // Release the capture even if pointerup fires outside the
          // element (browsers do route it back when captured). Wrap
          // in try/catch because releasing an already-released
          // pointer throws InvalidStateError in some Chromium builds.
          try {
            ;(e.currentTarget as Element).releasePointerCapture?.(e.pointerId)
          } catch {
            /* ignore */
          }
          setFromClient(e.clientX, true)
        }}
        // pointercancel fires when the OS yanks the pointer mid-drag
        // (touch interrupted, context menu, window blur with
        // pointer-events disabled). Treat it the same as pointerup
        // so the slider doesn't keep scrubbing on subsequent moves.
        onPointerCancel={(e) => {
          try {
            ;(e.currentTarget as Element).releasePointerCapture?.(e.pointerId)
          } catch {
            /* ignore */
          }
          if (onCommit) onCommit(value)
        }}
        style={{
          position: 'relative',
          height: 18,
          borderRadius: 6,
          background: 'rgb(var(--c-input-bg) / 0.7)',
          border: '1px solid rgb(var(--c-border) / 0.6)',
          cursor: 'pointer',
          userSelect: 'none',
          touchAction: 'none',
          overflow: 'hidden'
        }}
      >
        {/* Filled portion — tonal gradient warm→cool. Width scales
            smoothly with value; no pump, no scale animation. */}
        <div
          style={{
            position: 'absolute',
            left: 0,
            top: 0,
            bottom: 0,
            width: `${norm * 100}%`,
            background:
              'linear-gradient(90deg, rgb(var(--c-rich-warm)) 0%, rgb(var(--c-rich-cool)) 100%)',
            transition: 'width 180ms ease-out',
            boxShadow: 'inset 0 0 8px rgb(var(--c-rich-warm) / 0.25)'
          }}
        />
        {/* Tip indicator — thin vertical line at the fill edge so
            the eye finds the value at a glance. */}
        <div
          style={{
            position: 'absolute',
            left: `calc(${norm * 100}% - 1px)`,
            top: 1,
            bottom: 1,
            width: 2,
            borderRadius: 1,
            background: 'rgb(var(--c-rich-cool) / 0.95)',
            transition: 'left 180ms ease-out',
            boxShadow: '0 0 4px rgb(var(--c-rich-cool) / 0.45)'
          }}
        />
      </div>
      {(label || format) && (
        <div className="flex items-center justify-between text-[10px] font-mono">
          <span className="text-muted">{label ?? ''}</span>
          <span className="text-accent">
            {format ? format(value) : String(value)}
          </span>
        </div>
      )}
    </div>
  )
}
