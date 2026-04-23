// Meta Controller bar — renders above Scenes/Messages/Inspector when
// `session.metaController.visible` is true. Split horizontally into:
//   - Left: bank of 8 circular knobs (drag to change, click to select)
//   - Right: details panel for the selected knob (name, min/max, curve,
//            up to 8 OSC destinations).
//
// Toggled via the "Meta Controller" button in the preferences sub-toolbar
// (TopBar.tsx). Pushes the rest of the app down by sitting in the
// App's flex-column. State lives in the session so it persists with .dflou.json.

import { useLayoutEffect, useRef } from 'react'
import { useStore } from '../store'
import { META_BANK_COUNT, META_KNOBS_PER_BANK, META_MAX_DESTS } from '@shared/types'
import type { MetaCurve, MetaKnob as MetaKnobModel } from '@shared/types'
import { META_MAX_HEIGHT, META_MAX_SMOOTH_MS, META_MIN_HEIGHT } from '@shared/factory'
import { BoundedNumberInput } from './BoundedNumberInput'
import MetaKnob from './MetaKnob'
import { ResizeHandle } from './ResizeHandle'

// Dropdown order — grouped loosely from simplest to most specialized so
// users scan top-to-bottom for "the obvious one" before reaching niche
// perceptual / utility curves.
const CURVES: { id: MetaCurve; label: string }[] = [
  { id: 'linear', label: 'Linear' },
  { id: 'log', label: 'Log' },
  { id: 'exp', label: 'Exp' },
  { id: 'geom', label: 'Geom (log-space)' },
  { id: 'easeIn', label: 'Ease-in (t²)' },
  { id: 'easeOut', label: 'Ease-out' },
  { id: 'cubic', label: 'Cubic (t³)' },
  { id: 'sqrt', label: 'Square root' },
  { id: 'sigmoid', label: 'Sigmoid (S)' },
  { id: 'smoothstep', label: 'Smoothstep' },
  { id: 'db', label: 'dB taper (audio)' },
  { id: 'gamma', label: 'Gamma 2.2 (brightness)' },
  { id: 'step', label: 'Step (8 levels)' },
  { id: 'invert', label: 'Invert (1 − t)' }
]

// One-line descriptions shown under the Curve dropdown — help users pick
// the right shape without having to memorize the math.
const CURVE_DESCRIPTIONS: Record<MetaCurve, string> = {
  linear: 'Straight line — uniform response across the whole range.',
  log: 'Fast rise at the start, slow tail near the top (concave down).',
  exp: 'Slow rise at the start, fast climb near the top (concave up).',
  geom: 'Constant-ratio (log-space). Best for frequency (20→20000 Hz) or amplitude — needs min > 0.',
  easeIn: 'Gentle accelerating curve (y = t²). Mild version of exp.',
  easeOut: 'Gentle decelerating curve (y = 1 − (1−t)²). Mild version of log.',
  cubic: 'Stronger accelerating curve (y = t³). Sharp take-off near the top.',
  sqrt: 'Stronger decelerating curve (y = √t). Fast rise, long plateau.',
  sigmoid: 'S-curve: slow → fast → slow. Eased at both ends — great for cross-fades.',
  smoothstep: 'Milder S-curve (Hermite polynomial). Classic CG / video crossfade shape.',
  db: '60 dB audio taper — perceived-linear volume. Most action lives in the top half.',
  gamma: 'Perceptual brightness (γ = 2.2). Knob midpoint feels like mid-bright on a display.',
  step: 'Quantized to 8 discrete levels. Useful for grid snapping / pitch classes.',
  invert: 'Flips the range: knob at min outputs max, and vice-versa.'
}

export default function MetaControllerBar(): JSX.Element | null {
  const visible = useStore((s) => s.session.metaController.visible)
  const knobs = useStore((s) => s.session.metaController.knobs)
  const selectedIdx = useStore((s) => s.session.metaController.selectedKnob)
  const height = useStore((s) => s.session.metaController.height)
  const setHeight = useStore((s) => s.setMetaControllerHeight)
  const setMetaVisible = useStore((s) => s.setMetaControllerVisible)
  const setSelectedKnob = useStore((s) => s.setMetaSelectedKnob)
  const showMode = useStore((s) => s.showMode)

  const detailsRef = useRef<HTMLDivElement>(null)

  const selected = knobs[selectedIdx] ?? knobs[0]
  const destCount = selected?.destinations.length ?? 0

  // Derive the current bank from the globally-selected knob — clicking a
  // bank letter just jumps `selectedKnob` to the equivalent slot in that
  // bank (preserving the within-bank position). This keeps all persistence
  // in the session (no ephemeral UI state needed) and means the selector
  // "follows" the user when they click a specific knob across banks.
  const bankIdx = Math.floor(selectedIdx / META_KNOBS_PER_BANK)
  const bankStart = bankIdx * META_KNOBS_PER_BANK
  const visibleKnobs = knobs.slice(bankStart, bankStart + META_KNOBS_PER_BANK)
  function switchBank(newBank: number): void {
    const within = selectedIdx % META_KNOBS_PER_BANK
    setSelectedKnob(newBank * META_KNOBS_PER_BANK + within)
  }

  // Measurement-based auto-grow. After the details panel renders with the
  // new content, compare scrollHeight (total needed) to clientHeight
  // (currently visible). If there's overflow, bump the bar height by the
  // missing amount. Idempotent: once content fits, overflow becomes 0 and
  // the effect stops growing.
  // Only GROWS — user can still drag smaller with the resize handle once
  // the dependency (destCount, selectedIdx) stays constant.
  useLayoutEffect(() => {
    if (!visible) return
    const el = detailsRef.current
    if (!el) return
    const overflow = el.scrollHeight - el.clientHeight
    if (overflow > 0) {
      // A couple of pixels of slop so we clear the scrollbar threshold even
      // if sub-pixel rounding trims us short.
      setHeight(Math.min(META_MAX_HEIGHT, height + overflow + 4))
    }
  }, [visible, destCount, selectedIdx, height, setHeight])

  if (!visible) return null

  return (
    <div
      className="relative border-b border-border bg-panel flex shrink-0"
      style={{ height }}
    >
      {/* Left: knob bank — tight horizontal padding, zero vertical so the
          knobs + labels + values fill the bar height without dead space.
          Only the currently-selected bank's 8 knobs are rendered; the
          bank selector to the right flips between A..D. */}
      <div className="flex items-center gap-0.5 px-2 py-1 overflow-x-auto">
        {visibleKnobs.map((k, i) => {
          const globalIdx = bankStart + i
          return (
            <MetaKnob
              key={globalIdx}
              knob={k}
              index={globalIdx}
              selected={globalIdx === selectedIdx}
            />
          )
        })}
      </div>

      {/* Bank selector — 4 letters (A/B/C/D) stacked vertically. Each knob
          bank holds 8 knobs, so 32 total. Click a letter to swap the bank
          shown to the left while keeping the within-bank position. */}
      <div
        data-hide-in-show="true"
        className="flex flex-col items-stretch justify-start gap-0.5 px-1.5 py-1 border-l border-border shrink-0"
      >
        <span className="label text-[9px] text-center leading-none mb-0.5">BANKS</span>
        <div className="grid grid-cols-2 grid-rows-2 gap-0.5">
          {Array.from({ length: META_BANK_COUNT }, (_, i) => {
            const letter = String.fromCharCode(65 + i)
            const active = i === bankIdx
            return (
              <button
                key={i}
                className={`btn text-[10px] px-1.5 py-0 leading-tight ${
                  active ? 'bg-accent text-black border-accent' : ''
                }`}
                onClick={() => switchBank(i)}
                title={`Knobs ${i * META_KNOBS_PER_BANK + 1}–${(i + 1) * META_KNOBS_PER_BANK}`}
              >
                {letter}
              </button>
            )
          })}
        </div>
      </div>

      <div className="w-px bg-border shrink-0" />

      {/* Right: details panel — compact padding; rows still breathe via
          their own gap-2 inside KnobDetails. Extra right padding leaves
          room for the Hide button floating in the corner. */}
      <div
        ref={detailsRef}
        className="flex-1 min-w-0 overflow-y-auto px-3 py-2 pr-16"
      >
        <KnobDetails knobIndex={selectedIdx} knob={selected} readOnly={showMode} />
      </div>

      {/* Hide button — floats in the lower-right of the bar, just above the
          "Meta Controller" toggle in the prefs sub-toolbar. Click to hide
          the bar without removing state. Hidden in show mode (performers
          can't toggle chrome — they just turn knobs). */}
      {!showMode && (
        <button
          className="btn text-[10px] py-0.5 px-2 absolute bottom-2 right-2"
          onClick={() => setMetaVisible(false)}
          title="Hide the Meta Controller bar"
        >
          Hide
        </button>
      )}

      {/* Drag strip along the bottom edge — grab-and-drag to resize the
          whole Meta Controller bar. Height persists with the session. */}
      <ResizeHandle
        direction="row"
        value={height}
        onChange={setHeight}
        min={META_MIN_HEIGHT}
        max={META_MAX_HEIGHT}
        className="absolute bottom-0 left-0 right-0 h-[4px]"
        title="Drag to resize the Meta Controller bar"
      />
    </div>
  )
}

function KnobDetails({
  knobIndex,
  knob,
  readOnly = false
}: {
  knobIndex: number
  knob: MetaKnobModel
  // Show mode: all inputs disabled, destination add/remove hidden, MIDI
  // clear hidden. The knob itself stays interactive (rotatable) — that's
  // the whole point of keeping the Meta Controller visible during a show.
  readOnly?: boolean
}): JSX.Element {
  const updateMetaKnob = useStore((s) => s.updateMetaKnob)
  const addMetaDestination = useStore((s) => s.addMetaDestination)
  const removeMetaDestination = useStore((s) => s.removeMetaDestination)
  const updateMetaDestination = useStore((s) => s.updateMetaDestination)
  const setMetaKnobMidi = useStore((s) => s.setMetaKnobMidi)

  const destFull = knob.destinations.length >= META_MAX_DESTS

  // fieldset[disabled] cascades disabled=true to every nested input/select/
  // button — cheap way to lock the whole panel without threading a prop
  // through each field. `min-w-0` fights fieldset's default min-content
  // sizing so flex children still ellipsize correctly.
  return (
    <fieldset
      disabled={readOnly}
      className={`flex flex-col gap-2 text-[12px] min-w-0 border-0 p-0 m-0 ${
        readOnly ? 'opacity-90' : ''
      }`}
    >
      {/* Row 1 — name + min/max + smooth + curve + MIDI binding readout.
          MIDI Learn itself lives on the main toolbar (global learn mode),
          so we don't duplicate the Learn button here — only the readout +
          Clear affordance for the currently bound CC.
          Numeric fields use BoundedNumberInput so the user can completely
          clear them while editing (the stock <input type=number> snaps to
          0 on delete). */}
      <div className="flex items-center gap-1.5 flex-wrap">
        {/* Fixed-width knob-index badge. tabular-nums + an explicit width
            keep the label the same size for digits 1–8 so selecting a
            different knob doesn't shift everything to its right. */}
        <span className="label shrink-0 text-[10px] tabular-nums w-5 text-center">
          #{knobIndex + 1}
        </span>
        <input
          className="input flex-1 min-w-[120px] max-w-[200px]"
          value={knob.name}
          onChange={(e) => updateMetaKnob(knobIndex, { name: e.target.value })}
          placeholder="Knob name"
        />
        <span className="h-5 w-px bg-border mx-0.5" />
        <span className="label shrink-0">Min</span>
        <BoundedNumberInput
          className="input w-14 text-[12px]"
          value={knob.min}
          onChange={(v) => updateMetaKnob(knobIndex, { min: v })}
        />
        <span className="label shrink-0">Max</span>
        <BoundedNumberInput
          className="input w-14 text-[12px]"
          value={knob.max}
          onChange={(v) => updateMetaKnob(knobIndex, { max: v })}
        />
        <span className="label shrink-0">Smooth</span>
        <BoundedNumberInput
          className="input w-14 text-[12px]"
          value={knob.smoothMs}
          onChange={(v) => updateMetaKnob(knobIndex, { smoothMs: v })}
          min={0}
          max={META_MAX_SMOOTH_MS}
          integer
          title="Milliseconds the engine takes to tween from the old value to the new one (smooths MIDI stair-stepping). 0 disables smoothing."
        />
        <span className="label shrink-0 text-muted">ms</span>
        <span className="h-5 w-px bg-border mx-0.5" />
        <span className="label shrink-0">Curve</span>
        <select
          className="input text-[12px] w-44"
          value={knob.curve}
          onChange={(e) => updateMetaKnob(knobIndex, { curve: e.target.value as MetaCurve })}
          title="Scaling curve applied to the knob position before sending OSC"
        >
          {CURVES.map((c) => (
            <option key={c.id} value={c.id}>
              {c.label}
            </option>
          ))}
        </select>
        <span className="h-5 w-px bg-border mx-0.5" />
        <span className="label shrink-0">MIDI</span>
        {knob.midiCc ? (
          <span
            className="text-[11px] font-mono px-2 py-0.5 rounded border"
            style={{
              color: 'rgb(var(--c-accent2))',
              borderColor: 'rgb(var(--c-accent2))'
            }}
            title={`CC ${knob.midiCc.number} on channel ${knob.midiCc.channel + 1}`}
          >
            CC {knob.midiCc.number} · ch {knob.midiCc.channel + 1}
          </span>
        ) : (
          <span className="text-muted text-[11px]">Unassigned</span>
        )}
        {knob.midiCc && (
          <button
            className="btn text-[11px]"
            onClick={() => setMetaKnobMidi(knobIndex, null)}
            title="Remove the MIDI binding"
          >
            Clear
          </button>
        )}
      </div>

      {/* Row 2 — OSC destinations header. The curve description lives on
          this same line (right-aligned via flex-1 spacer) so it sits
          roughly under the Curve dropdown above and doesn't eat a full
          extra row. */}
      <div className="flex items-center gap-2">
        <span className="label shrink-0">
          Destinations ({knob.destinations.length}/{META_MAX_DESTS})
        </span>
        <button
          className="btn text-[11px] shrink-0"
          onClick={() => addMetaDestination(knobIndex)}
          disabled={destFull}
          title={destFull ? `Max ${META_MAX_DESTS} destinations` : 'Add another OSC destination'}
        >
          + Destination
        </button>
        <span className="flex-1" />
        <span
          className="text-[11px] text-muted italic truncate"
          title={CURVE_DESCRIPTIONS[knob.curve]}
        >
          {CURVE_DESCRIPTIONS[knob.curve]}
        </span>
      </div>

      {knob.destinations.length === 0 ? (
        <div className="text-muted text-[11px] italic pl-1">
          No destinations — add one so the knob has somewhere to send its value.
        </div>
      ) : (
        <div className="flex flex-col gap-1">
          {knob.destinations.map((d, di) => (
            <div key={di} className="flex items-center gap-1.5 flex-wrap">
              <input
                type="checkbox"
                checked={d.enabled}
                onChange={(e) => updateMetaDestination(knobIndex, di, { enabled: e.target.checked })}
                title={d.enabled ? 'Destination enabled' : 'Destination muted'}
                className="shrink-0"
              />
              <input
                className="input w-[140px]"
                value={d.destIp}
                onChange={(e) => updateMetaDestination(knobIndex, di, { destIp: e.target.value })}
                placeholder="127.0.0.1"
                title="Destination IP"
              />
              <span className="text-muted">:</span>
              <BoundedNumberInput
                className="input w-[80px]"
                value={d.destPort}
                onChange={(v) => updateMetaDestination(knobIndex, di, { destPort: v })}
                min={0}
                max={65535}
                integer
                title="Destination port"
              />
              <input
                className="input flex-1 min-w-[160px]"
                value={d.oscAddress}
                onChange={(e) => updateMetaDestination(knobIndex, di, { oscAddress: e.target.value })}
                placeholder="/osc/address"
                title="OSC address"
              />
              <button
                className="btn text-[11px]"
                style={{ color: 'rgb(var(--c-danger))', borderColor: 'rgb(var(--c-danger))' }}
                onClick={() => removeMetaDestination(knobIndex, di)}
                title="Remove this destination"
              >
                ×
              </button>
            </div>
          ))}
        </div>
      )}
    </fieldset>
  )
}

