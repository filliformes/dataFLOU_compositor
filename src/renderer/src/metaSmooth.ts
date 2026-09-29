// Renderer-side smoothing for Meta Controller knobs.
//
// Both drag input and MIDI CC feed `setKnobTarget(idx, value, smoothMs)`.
// If smoothMs > 0, we tween the knob's DISPLAYED position from wherever
// it is right now toward `value` over `smoothMs` ms, firing:
//   - a store write (updates metaKnobDisplayValues[idx]) → drives the knob UI
//   - an IPC call (window.api.sendMetaValue) → drives the OSC output
// on every tween frame (~60 Hz via requestAnimationFrame).
//
// Smoothing lives here, NOT in the main-process engine, so the dial + the
// numeric readout + the value over the wire are all the same thing. The
// engine just scales through min/max/curve and emits whatever it receives.
//
// When a new target arrives mid-tween, we snapshot the current interpolated
// position and start a fresh tween from it — keeps the motion continuous
// even if the user rapidly wiggles a controller.

import { META_KNOB_COUNT } from '@shared/types'
import { useStore } from './store'

interface Tween {
  startValue: number
  target: number
  startTime: number // performance.now() when the tween began
  smoothMs: number
}

const tweens = new Map<number, Tween>()
let raf: number | null = null

// Latch a single console.warn the first time an IPC rejection surfaces
// from sendMetaValue — main may have crashed / be restarting and we
// don't want to flood devtools at ~60Hz per active knob. Resets on
// each module load.
let metaIpcWarned = false
function warnOnce(e: unknown): void {
  if (metaIpcWarned) return
  metaIpcWarned = true
  console.warn('[meta] sendMetaValue IPC failed:', (e as Error)?.message ?? e)
}

function currentOf(t: Tween, now: number): number {
  if (t.smoothMs <= 0) return t.target
  const elapsed = now - t.startTime
  if (elapsed >= t.smoothMs) return t.target
  const progress = elapsed / t.smoothMs
  return t.startValue + (t.target - t.startValue) * progress
}

function tick(): void {
  const now = performance.now()
  const store = useStore.getState()
  const display = [...store.metaKnobDisplayValues]
  let anyActive = false
  for (const [idx, t] of tweens) {
    const v = currentOf(t, now)
    display[idx] = v
    // Fire OSC for this frame — main scales via curve + blasts destinations.
    // IPC rejections are silent — they fire ~60Hz per active knob and
    // logging every one would flood devtools when main is restarting.
    // A single warn on the first rejection is enough to surface
    // engine-side problems without spamming.
    window.api.sendMetaValue(idx, v).catch(warnOnce)
    if (v === t.target) tweens.delete(idx)
    else anyActive = true
  }
  store.setMetaKnobDisplayValues(display)
  raf = anyActive ? requestAnimationFrame(tick) : null
}

/**
 * Schedule the knob to move toward `target` (normalized 0..1) over `smoothMs`
 * milliseconds, starting from wherever it visibly is right now. Pass
 * smoothMs = 0 for instant jump (no tween, no OSC ramp).
 */
export function setKnobTarget(idx: number, target: number, smoothMs: number): void {
  if (idx < 0 || idx >= META_KNOB_COUNT) return
  const clamped = target < 0 ? 0 : target > 1 ? 1 : target
  const store = useStore.getState()

  // Snapshot where the knob is RIGHT NOW so the new tween starts from the
  // actual visible position (rather than some stale startValue).
  const now = performance.now()
  const prev = tweens.get(idx)
  const currentVisible = prev
    ? currentOf(prev, now)
    : store.metaKnobDisplayValues[idx] ?? clamped

  if (smoothMs <= 0 || currentVisible === clamped) {
    // Instant path: update display + fire IPC, no timer needed.
    tweens.delete(idx)
    const display = [...store.metaKnobDisplayValues]
    display[idx] = clamped
    store.setMetaKnobDisplayValues(display)
    window.api.sendMetaValue(idx, clamped).catch(warnOnce)
    return
  }

  tweens.set(idx, {
    startValue: currentVisible,
    target: clamped,
    startTime: now,
    smoothMs
  })
  if (raf == null) raf = requestAnimationFrame(tick)
}

/**
 * Force the displayed value for a knob (e.g. session load, external reset,
 * undo/redo). Cancels any running tween. `send` also pushes the value to
 * the engine exactly like a knob edit does, so OSC output follows the
 * restored position instead of staying at the pre-reset one.
 */
export function setKnobDisplayImmediate(idx: number, value: number, send = false): void {
  if (idx < 0 || idx >= META_KNOB_COUNT) return
  tweens.delete(idx)
  const store = useStore.getState()
  const display = [...store.metaKnobDisplayValues]
  display[idx] = value
  store.setMetaKnobDisplayValues(display)
  if (send) window.api.sendMetaValue(idx, value).catch(warnOnce)
}
