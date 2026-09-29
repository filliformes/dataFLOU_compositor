// Circular knob for the Meta Controller.
//
// The knob's DISPLAYED position comes from metaKnobDisplayValues[index] in
// the store — populated by the renderer-side smoothing module (metaSmooth.ts)
// as it tweens between targets. The knob itself NEVER sends OSC directly;
// it just calls setKnobTarget(index, t, smoothMs) on every pointer move,
// and the smoother takes care of interpolating + firing IPC.
//
// That keeps one source of truth: the value you see on the dial is exactly
// the value being sent. When smoothMs > 0 you'll literally watch the dial
// tween toward the target after each MIDI CC or drag step.
//
// Drag sensitivity: 200 px of vertical travel = full 0..1 range. Shift = 4×
// slower. Double-click resets to 0.

import { memo, useEffect, useRef } from 'react'
import { useStore } from '../store'
import { scaleMetaValue } from '@shared/factory'
import type { MetaKnob as MetaKnobModel } from '@shared/types'
import { setKnobTarget } from '../metaSmooth'

const KNOB_PX = 56
const ARC_SWEEP_DEG = 270 // arc spans ±135° from bottom
const DRAG_PIXELS_FOR_FULL_RANGE = 200

function formatValue(v: number): string {
  if (!Number.isFinite(v)) return '—'
  const abs = Math.abs(v)
  if (abs >= 1000) return v.toFixed(0)
  if (abs >= 10) return v.toFixed(1)
  if (abs >= 1) return v.toFixed(2)
  return v.toFixed(3)
}

// Memoized: the parent re-renders the whole knob row whenever ANY bank-wide
// state changes (e.g. a different knob's tween ticks metaKnobDisplayValues).
// With 8 visible knobs each subscribing to ~6 store slices, an un-memoized
// MetaKnob re-rendered all 8 tiles every tween frame. memo() with the
// default shallow-prop comparison means only the knob whose parent props
// actually changed renders — and each knob's own useStore subscriptions
// still trigger its individual re-renders when its slice updates.
function MetaKnobImpl({
  knob,
  index,
  selected
}: {
  knob: MetaKnobModel
  index: number
  selected: boolean
}): JSX.Element {
  const updateMetaKnob = useStore((s) => s.updateMetaKnob)
  const setSelected = useStore((s) => s.setMetaSelectedKnob)
  const midiLearnMode = useStore((s) => s.midiLearnMode)
  const midiLearnTarget = useStore((s) => s.midiLearnTarget)
  const setMidiLearnTarget = useStore((s) => s.setMidiLearnTarget)
  // The currently-interpolated display position for this knob. Updated at
  // ~60 Hz by metaSmooth.ts — drives both the dial angle and the value text.
  const displayValue = useStore(
    (s) => s.metaKnobDisplayValues[index] ?? knob.value
  )

  // Learn overlay: blue = unbound, bright blue = currently selected as the
  // learn target, green = already has a CC binding. Matches the color key
  // used on scenes + cells so the app has one consistent learn vocabulary.
  const learnOverlayClass = !midiLearnMode
    ? ''
    : midiLearnTarget?.kind === 'metaKnob' && midiLearnTarget.index === index
      ? 'midi-learn-selected'
      : knob.midiCc
        ? 'midi-learn-green'
        : 'midi-learn-blue'

  const dragRef = useRef<{
    startY: number
    startValue: number
    pointerId: number
    lastTarget: number
    // Shift (fine mode) state the current anchor was taken with.
    fine: boolean
  } | null>(null)

  // Unmount mid-drag (bank switch via MIDI, bar hidden, …): no pointerup
  // will ever reach us, so give the cursor back.
  useEffect(() => {
    return () => {
      if (dragRef.current) document.body.style.cursor = ''
    }
  }, [])

  const display = displayValue
  const scaled = scaleMetaValue(display, knob.min, knob.max, knob.curve)

  // Angle convention in this file: deg=0 points straight up (12 o'clock),
  // clockwise. So 90 = 3 o'clock, 180 = 6, 270 = 9.
  // Min sits at 7:30 and max at 4:30, sweeping CLOCKWISE through the top
  // (LaunchControl XL convention). 225° + 270° sweep = 135° (4:30). ✓
  const startDeg = 225
  const currentDeg = startDeg + display * ARC_SWEEP_DEG

  function onPointerDown(e: React.PointerEvent<HTMLDivElement>): void {
    if (e.button !== 0) return
    // In learn mode a click just selects this knob as the learn target —
    // skip drag setup so we don't also fire values.
    if (midiLearnMode) {
      setMidiLearnTarget({ kind: 'metaKnob', index })
      setSelected(index)
      return
    }
    // Capture on the knob container (currentTarget), NOT e.target: the
    // press often lands on the value-arc <path>, which unmounts when the
    // value drops to 0 — taking the capture (and the pointerup) with it.
    e.currentTarget.setPointerCapture(e.pointerId)
    dragRef.current = {
      startY: e.clientY,
      // Start the drag from the currently-displayed value so the knob
      // doesn't jump if a tween was mid-flight.
      startValue: displayValue,
      pointerId: e.pointerId,
      lastTarget: displayValue,
      fine: e.shiftKey
    }
    // Hide the cursor while dragging — matches Ableton / hardware DAW
    // convention where the pointer "lives inside" the knob during edit.
    // We restore it on pointerup / cancel.
    document.body.style.cursor = 'none'
    setSelected(index)
  }

  function onPointerMove(e: React.PointerEvent<HTMLDivElement>): void {
    const d = dragRef.current
    if (!d || e.pointerId !== d.pointerId) return
    // Shift pressed / released mid-drag: re-anchor at the current
    // position + value so only FUTURE travel uses the new sensitivity.
    // Otherwise the whole drag distance so far was rescaled and the
    // knob jumped.
    if (e.shiftKey !== d.fine) {
      d.startY = e.clientY
      d.startValue = d.lastTarget
      d.fine = e.shiftKey
    }
    const dy = d.startY - e.clientY // drag up = increase
    const sensitivity = d.fine ? 4 : 1
    const delta = dy / (DRAG_PIXELS_FOR_FULL_RANGE * sensitivity)
    const next = Math.max(0, Math.min(1, d.startValue + delta))
    d.lastTarget = next
    // Route through the smoother — tweens from the current display to `next`
    // over knob.smoothMs and fires OSC on each frame. The knob UI will
    // re-render as displayValue updates.
    setKnobTarget(index, next, knob.smoothMs)
  }

  // Ends the drag. Reached from pointerup / pointercancel AND from
  // lostpointercapture (capture yanked without an up — the old code then
  // left the cursor hidden and the drag armed). Idempotent: whichever
  // fires first commits, the rest no-op.
  function endDrag(pointerId: number): void {
    const d = dragRef.current
    if (!d || pointerId !== d.pointerId) return
    // Commit the final target to the session so it persists. The smoother
    // may still be finishing the last tween — that's fine, display will
    // settle on the same value.
    updateMetaKnob(index, { value: d.lastTarget })
    dragRef.current = null
    // Restore the cursor (we hid it on pointerdown).
    document.body.style.cursor = ''
  }

  function onPointerUp(e: React.PointerEvent<HTMLDivElement>): void {
    const d = dragRef.current
    if (!d || e.pointerId !== d.pointerId) return
    try {
      e.currentTarget.releasePointerCapture(e.pointerId)
    } catch {
      /* ignore */
    }
    endDrag(e.pointerId)
  }

  function onDoubleClick(): void {
    updateMetaKnob(index, { value: 0 })
    setKnobTarget(index, 0, knob.smoothMs)
  }

  const cx = KNOB_PX / 2
  const cy = KNOB_PX / 2
  const radius = KNOB_PX / 2 - 6
  const indicatorInner = radius - 4
  const indicatorOuter = radius
  const rad = (deg: number): number => ((deg - 90) * Math.PI) / 180

  const arcStart = rad(startDeg)
  const arcEnd = rad(currentDeg)
  const largeArc = currentDeg - startDeg > 180 ? 1 : 0
  const bgArcStart = rad(startDeg)
  const bgArcEnd = rad(startDeg + ARC_SWEEP_DEG)
  const bgLargeArc = ARC_SWEEP_DEG > 180 ? 1 : 0

  return (
    <div
      className={`flex flex-col items-center gap-0.5 select-none cursor-pointer px-1 py-0.5 rounded ${
        selected ? 'bg-panel2 ring-1 ring-accent' : 'hover:bg-panel2/40'
      }`}
      onClick={() => setSelected(index)}
      title={`${knob.name} — drag vertically · Shift = fine · double-click to reset`}
    >
      <div
        className="relative"
        style={{ width: KNOB_PX, height: KNOB_PX, touchAction: 'none' }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onLostPointerCapture={(e) => endDrag(e.pointerId)}
        onDoubleClick={onDoubleClick}
      >
        {learnOverlayClass && (
          <div className={`midi-learn-overlay ${learnOverlayClass}`} aria-hidden />
        )}
        <svg width={KNOB_PX} height={KNOB_PX} className="absolute inset-0">
          {/* Background track */}
          <path
            d={`M ${cx + radius * Math.cos(bgArcStart)} ${cy + radius * Math.sin(bgArcStart)}
                A ${radius} ${radius} 0 ${bgLargeArc} 1 ${cx + radius * Math.cos(bgArcEnd)} ${cy + radius * Math.sin(bgArcEnd)}`}
            fill="none"
            stroke="rgb(var(--c-panel3))"
            strokeWidth={3}
            strokeLinecap="round"
          />
          {/* Value arc */}
          {display > 0.001 && (
            <path
              d={`M ${cx + radius * Math.cos(arcStart)} ${cy + radius * Math.sin(arcStart)}
                  A ${radius} ${radius} 0 ${largeArc} 1 ${cx + radius * Math.cos(arcEnd)} ${cy + radius * Math.sin(arcEnd)}`}
              fill="none"
              stroke="rgb(var(--c-accent))"
              strokeWidth={3}
              strokeLinecap="round"
            />
          )}
          {/* Knob body */}
          <circle
            cx={cx}
            cy={cy}
            r={radius - 4}
            fill="rgb(var(--c-panel))"
            stroke="rgb(var(--c-border))"
          />
          {/* Indicator line */}
          <line
            x1={cx + indicatorInner * Math.cos(rad(currentDeg))}
            y1={cy + indicatorInner * Math.sin(rad(currentDeg))}
            x2={cx + indicatorOuter * Math.cos(rad(currentDeg))}
            y2={cy + indicatorOuter * Math.sin(rad(currentDeg))}
            stroke="rgb(var(--c-accent))"
            strokeWidth={2}
            strokeLinecap="round"
          />
        </svg>
      </div>
      <div className="text-[10px] text-muted truncate max-w-[80px] text-center">
        {knob.name}
      </div>
      <div className="flex items-center gap-1">
        <div className="text-[11px] font-mono tabular-nums">{formatValue(scaled)}</div>
        {knob.midiCc && (
          <span
            className="text-[9px] font-mono px-1 py-px rounded border leading-none"
            style={{
              color: 'rgb(var(--c-accent2))',
              borderColor: 'rgb(var(--c-accent2))'
            }}
            title={`Bound to MIDI CC ${knob.midiCc.number} (ch ${knob.midiCc.channel + 1})`}
          >
            CC{knob.midiCc.number}
          </span>
        )}
      </div>
    </div>
  )
}

const MetaKnob = memo(MetaKnobImpl)
export default MetaKnob
