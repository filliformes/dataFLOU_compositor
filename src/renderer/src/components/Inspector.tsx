import { Fragment, useEffect, useMemo, useRef, useState } from 'react'
import { useStore, isRichTheme } from '../store'
import { RcArcSlider, RcFlatBar } from './RcArcSlider'
import { RcModeIcons } from './RcModeIcons'
import type {
  ArpMode,
  Cell,
  EnvSync,
  GestureMode,
  GesturePlayMode,
  LfoMode,
  LfoShape,
  LfoSync,
  MidiOut,
  Modulation,
  ModulationTargetMode,
  ModulationTargets,
  ModType,
  MultMode,
  ParamArgSpec,
  RandomValueType,
  SeqCombine,
  SeqDriftEdge,
  SeqMode,
  SeqSyncMode,
  ScaleId,
  Track
} from '@shared/types'
import { SCALE_GROUPS, SCALE_LABELS, SCALE_INTERVALS, ROOT_LABELS } from '@shared/types'
import {
  DEFAULT_MIDI_OUT,
  DEFAULT_MODULATION2,
  DIVISIONS,
  cellularInitialRow,
  euclidean,
  evolveCellular,
  generateStepValue,
  polyrhythmGate,
  rateHzToSlider,
  sliderToRateHz,
  stepHash
} from '@shared/factory'
import { BoundedNumberInput } from './BoundedNumberInput'
import { UncontrolledTextInput } from './UncontrolledInput'
import { DrawCanvas } from './DrawCanvas'
import { GestureRecorder } from './GestureRecorder'
import { HardwareModeSection } from './InstrumentsInspectorPane'
import {
  ArpVisual,
  AttractorVisual,
  ChaosVisual,
  EnvelopeVisual,
  LfoVisual,
  RampVisual,
  RandomVisual,
  SampleHoldVisual,
  SlewVisual
} from './ModulatorVisuals'

// Two-segment piecewise-linear mapping for the sequencer's Free (ms)
// step-duration slider. A pure-linear slider over [10, 60000] ms gave
// the useful sub-second range (10–1000 ms) only ~1.5% of the slider's
// travel, which made it almost impossible to dial in musical step
// times. This mapping gives 10–1000 ms the LEFT HALF of the slider
// and 1000–60000 ms the RIGHT HALF — so subtle changes near the
// downbeat are easy, and very slow steps stay reachable.
//
// Position space: integer 0..1000 (what the <input type="range"> sees).
// Value space: integer 10..60000 ms (what the engine stores).
function sliderToStepMs(pos: number): number {
  const p = Math.max(0, Math.min(1000, pos))
  if (p <= 500) return Math.round(10 + (p / 500) * (1000 - 10))
  return Math.round(1000 + ((p - 500) / 500) * (60000 - 1000))
}
function stepMsToSlider(ms: number): number {
  const m = Math.max(10, Math.min(60000, ms))
  if (m <= 1000) return Math.round(((m - 10) / (1000 - 10)) * 500)
  return Math.round(500 + ((m - 1000) / (60000 - 1000)) * 500)
}

// Same trick for the Ramp's "Ramp time" slider: position 0..1000
// maps to 0..30000 ms with the fast band (0..5000 ms) taking the
// left half of the slider. Right half is 5000..30000 ms.
function sliderToRampMs(pos: number): number {
  const p = Math.max(0, Math.min(1000, pos))
  if (p <= 500) return Math.round((p / 500) * 5000 * 10) / 10
  return Math.round(5000 + ((p - 500) / 500) * (30000 - 5000))
}
function rampMsToSlider(ms: number): number {
  const m = Math.max(0, Math.min(30000, ms))
  if (m <= 5000) return Math.round((m / 5000) * 500)
  return Math.round(500 + ((m - 5000) / (30000 - 5000)) * 500)
}

// Returns true when step `i` is gated OFF in the current cycle for
// the given sequencer mode + params. Used by the step-values grid
// to grey-glow muted steps (instead of orange) when the playhead
// lands on them, so the user can see which steps would actually
// fire vs which the receiver will hold past.
function isStepGateMuted(
  seq: import('@shared/types').SequencerParams,
  i: number
): boolean {
  const s = Math.max(1, Math.min(16, Math.floor(seq.steps)))
  const idx = ((i % s) + s) % s
  switch (seq.mode) {
    case 'euclidean': {
      const p = Math.max(0, Math.min(s, seq.pulses))
      const pat = euclidean(p, s, seq.rotation)
      return !pat[idx]
    }
    case 'polyrhythm':
      return !polyrhythmGate(idx, seq.ringALength, seq.ringBLength, seq.combine)
    case 'density':
      // Density classic mode no longer gates (every step fires with
      // a per-step multiplier); only generative Density gates.
      if (!seq.generative) return false
      return stepHash(idx, seq.seed) >= seq.density / 100
    case 'cellular': {
      const row = cellularInitialRow(seq.cellSeed, s)
      return ((row >>> idx) & 1) === 0
    }
    default:
      return false
  }
}

// Cellular Seed slider that, when its LFO is active, auto-animates
// its displayed position by computing the same modulated seed value
// the engine uses. Drag → user takes over; release → LFO resumes.
function CellularSeedSlider({
  seed,
  lfoDepth,
  lfoRate,
  onChange
}: {
  seed: number
  lfoDepth: number
  lfoRate: number
  onChange: (v: number) => void
}): JSX.Element {
  // Re-render at ~30 Hz while LFO is active so the slider visibly
  // moves. requestAnimationFrame would be ~60 Hz which is wasteful
  // for this — setInterval(33ms) is plenty smooth visually.
  const [, tick] = useState(0)
  const dragging = useRef(false)
  // Mirror lfoDepth into a ref so the setInterval body always reads
  // the latest value, not the closure-captured one. Without this,
  // toggling depth to 0 from a parent re-render while an interval
  // tick is in flight could fire one extra tick that recomputes
  // `modulated` from a stale > 0 depth — visible as a one-frame
  // "snap" of the slider after the user releases.
  const lfoDepthRef = useRef(lfoDepth)
  lfoDepthRef.current = lfoDepth
  useEffect(() => {
    if (lfoDepth <= 0) return
    const id = setInterval(() => {
      // Re-check depth inside the tick body — the dep-array cleanup
      // covers the steady-state case, this covers the transient
      // race when the React commit hasn't yet torn the interval down.
      if (lfoDepthRef.current <= 0) return
      if (!dragging.current) tick((n) => n + 1)
    }, 33)
    return () => clearInterval(id)
  }, [lfoDepth])
  // Modulated seed value at "now" — matches the engine's formula in
  // modulatedCellSeed (factory-side, see engine.ts).
  const modulated = (() => {
    if (lfoDepth <= 0 || dragging.current) return seed
    const phase = (Date.now() / 1000) * Math.max(0.01, lfoRate) * Math.PI * 2
    const offset = Math.round(Math.sin(phase) * (lfoDepth / 100) * 32767)
    return Math.max(0, Math.min(65535, seed + offset))
  })()
  return (
    <>
      <input
        type="range"
        min={0}
        max={65535}
        step={1}
        value={modulated}
        onChange={(e) =>
          onChange(clamp(Math.round(Number(e.target.value)), 0, 65535))
        }
        onPointerDown={() => (dragging.current = true)}
        onPointerUp={() => (dragging.current = false)}
        title="Initial bit pattern of the row. 0 = single center cell on; nonzero = each bit i seeds step i. Auto-animates when Seed LFO Depth > 0."
      />
      <BoundedNumberInput
        className="input w-14 text-right"
        value={modulated}
        onChange={(v) => onChange(v)}
        min={0}
        max={65535}
        integer
      />
    </>
  )
}

// Per-mode tooltip for the Generative-mode Variation slider. Each
// sequencer mode reinterprets the same 0..100% knob as its own
// natural metaphor, so the title attribute names the metaphor
// concretely rather than just saying "Variation".
function genVariationTitle(mode: SeqMode): string {
  switch (mode) {
    case 'steps':
      return 'Tide depth — how high the swell rises and how low it falls across one cycle.'
    case 'euclidean':
      return 'Accent strength — how much harder the downbeat hits land vs the off-beats.'
    case 'polyrhythm':
      return 'Voicing spread — distance between Ring A (low), Ring B (high), and the coincidence resonance.'
    case 'density':
      return 'Wave amplitude — how tall the sine the gate samples through.'
    case 'cellular':
      return 'Excitement range — how loud crowded cells get vs lonely ones.'
    case 'drift':
      return 'Hill height — how tall the terrain the walker samples.'
    case 'ratchet':
      return 'Scatter width — how widely each sub-pulse in a burst lands from the base.'
    case 'bounce':
      return 'Decay strength — how much the seed amplitude drops with each bounce. Combines with the Decay knob (timing) to shape the gesture.'
    default:
      return 'Variation amount.'
  }
}

// Short single-word label for the rich-theme arc slider — appears
// below the arc, complementing the % readout in the centre. Mirrors
// `genVariationTitle` but tighter so the label fits the arc footprint.
function genVariationLabel(mode: SeqMode): string {
  switch (mode) {
    case 'steps':
      return 'Tide'
    case 'euclidean':
      return 'Accent'
    case 'polyrhythm':
      return 'Voicing'
    case 'density':
      return 'Wave'
    case 'cellular':
      return 'Crowd'
    case 'drift':
      return 'Terrain'
    case 'ratchet':
      return 'Scatter'
    case 'bounce':
      return 'Bounce'
    default:
      return 'Variation'
  }
}

export default function Inspector({ mode }: { mode: 'cell' | 'track' }): JSX.Element {
  if (mode === 'track') return <TrackInspector />
  return <CellInspector />
}

function TrackInspector(): JSX.Element {
  const trackId = useStore((s) => s.selectedTrack)!
  const track = useStore((s) => s.session.tracks.find((t) => t.id === trackId))
  const renameTrack = useStore((s) => s.renameTrack)
  const setTrackDefaults = useStore((s) => s.setTrackDefaults)
  const sendTrackDefaultsToClips = useStore((s) => s.sendTrackDefaultsToClips)
  const setTrackEnabled = useStore((s) => s.setTrackEnabled)
  const setTrackPersistentSlot = useStore((s) => s.setTrackPersistentSlot)
  const setTrackPersistentValue = useStore((s) => s.setTrackPersistentValue)
  const scenesCount = useStore((s) => s.session.scenes.length)
  const cellsCount = useStore((s) =>
    s.session.scenes.reduce((n, sc) => n + (sc.cells[trackId] ? 1 : 0), 0)
  )
  // For Parameter-row inspector: pull the focused scene's cell so we
  // can show the current per-arg values + per-slot persistence
  // toggles. When no scene is focused, fall back to whatever scene
  // currently has a clip on this track (if any).
  const focusedSceneId = useStore((s) => s.session.focusedSceneId)
  const cellOnFocused = useStore((s) => {
    const sc = s.session.scenes.find((x) => x.id === focusedSceneId)
    return sc?.cells[trackId]
  })
  // Children of a Template row — used only when track.kind === 'template'.
  const children = useStore((s) =>
    s.session.tracks.filter((t) => t.parentTrackId === trackId)
  )
  // Look up the source template so the grid-side inspector can show
  // the same Hardware Mode controls as the Pool's TemplateInspector.
  // Mirrors the same store action (setTemplateHardwareMode) so edits
  // on either surface stay in sync — they're operating on the same
  // `session.pool.templates[i].hardwareMode` blob.
  const templateForRow = useStore((s) =>
    track?.kind === 'template' && track.sourceTemplateId
      ? s.session.pool.templates.find((t) => t.id === track.sourceTemplateId)
      : undefined
  )

  if (!track) return <div className="p-4 text-muted text-[12px]">Track removed.</div>

  const isTemplate = track.kind === 'template'
  const enabled = track.enabled !== false
  const noun = isTemplate ? 'Instrument' : 'Parameter'

  return (
    <div className="p-3 flex flex-col gap-3 text-[12px]">
      <Section title={`${noun} name`}>
        <div className="flex items-center gap-2 flex-wrap">
          <UncontrolledTextInput
            className="input flex-1 min-w-[120px]"
            value={track.name}
            onChange={(v) => renameTrack(trackId, v)}
            placeholder={`${noun} name`}
          />
          <label
            className="flex items-center gap-1 text-[11px] shrink-0"
            title={
              enabled
                ? `Disable this ${noun.toLowerCase()} — engine will skip every trigger path until re-enabled`
                : `Re-enable this ${noun.toLowerCase()}`
            }
          >
            <input
              type="checkbox"
              checked={enabled}
              onChange={(e) => setTrackEnabled(trackId, e.target.checked)}
            />
            <span>Enabled</span>
          </label>
          {/* OSC Output toggle — when off, every cell on this
              Parameter row stops emitting OSC. MIDI is independent
              (governed by each cell's `midiOut.enabled` + the global
              MIDI toggle). Default true via migration so legacy
              sessions keep their OSC. */}
          <label
            className="flex items-center gap-1 text-[11px] shrink-0"
            title={
              (track.oscEnabled ?? true)
                ? `Disable OSC output for every cell on this ${noun.toLowerCase()}. MIDI keeps firing if configured.`
                : `Re-enable OSC output for every cell on this ${noun.toLowerCase()}.`
            }
          >
            <input
              type="checkbox"
              checked={track.oscEnabled ?? true}
              onChange={(e) =>
                setTrackDefaults(trackId, { oscEnabled: e.target.checked })
              }
            />
            <span>OSC Output</span>
          </label>
        </div>
      </Section>

      {/* Hardware Mode — only for Template (Instrument) rows. Shows
          the same controls as the Pool's TemplateInspector. Both
          surfaces edit the SAME template.hardwareMode blob via
          setTemplateHardwareMode, so flipping the toggle here is
          identical to flipping it in the Pool. Lets the user enable
          HW Mode without leaving the grid. HardwareModeSection
          carries its own "Hardware Mode" enable-label so we don't
          wrap in a Section (would be a redundant double-title). */}
      {isTemplate && templateForRow && (
        <HardwareModeSection template={templateForRow} />
      )}

      {/* Parameter list — only for Template (Instrument) rows. Each
          child gets its own enable/disable toggle, mirroring the
          per-track flag. Disabled children grey out in the sidebar
          and the engine skips them on every trigger. */}
      {isTemplate && (
        <Section title={`Parameters (${children.length})`}>
          {children.length === 0 ? (
            <div className="text-[10px] text-muted">
              No Parameters yet. Click the +PARAM chip on this Instrument's
              row, or right-click → Add Parameter.
            </div>
          ) : (
            <div className="flex flex-col gap-1">
              {children.map((child) => {
                const childEnabled = child.enabled !== false
                return (
                  <label
                    key={child.id}
                    className={`flex items-center gap-2 px-2 py-1 rounded border ${
                      childEnabled ? 'border-border' : 'border-border/40 opacity-60'
                    }`}
                  >
                    <input
                      type="checkbox"
                      checked={childEnabled}
                      onChange={(e) => setTrackEnabled(child.id, e.target.checked)}
                    />
                    <span className="flex-1 truncate">{child.name}</span>
                    {child.argSpec && child.argSpec.length > 0 && (
                      <span
                        className="text-[9px] text-muted shrink-0"
                        title={`${child.argSpec.length} args (${child.argSpec.filter((a) => a.fixed === undefined).length} editable)`}
                      >
                        {child.argSpec.filter((a) => a.fixed === undefined).length}-arg
                      </span>
                    )}
                  </label>
                )
              })}
            </div>
          )}
        </Section>
      )}

      {/* Per-slot persistence — always shown for Parameter rows
          that have an argSpec, even when the focused scene has no
          clip on this track yet. Without a clip we fall back to the
          argSpec's own `init` values so the user still sees the
          captured multi-arg layout the moment they click the row
          (matters for fresh Captures: drop the Instrument, click a
          row → see all the slots immediately instead of having to
          create a clip first). Persistent slots ignore scene
          triggers and modulators, freezing at their last-sent value. */}
      {!isTemplate && track.argSpec && track.argSpec.length > 0 && (
        <Section title="Values · pin to freeze">
          <PersistentSlotList
            argSpec={track.argSpec}
            cellValue={cellOnFocused?.value ?? argSpecInitTokens(track.argSpec)}
            persistentSlots={track.persistentSlots ?? []}
            persistentValues={track.persistentValues ?? []}
            onToggle={(idx, persistent, capturedValue) =>
              setTrackPersistentSlot(trackId, idx, persistent, capturedValue)
            }
            onEditValue={(idx, value) =>
              setTrackPersistentValue(trackId, idx, value)
            }
          />
          <div className="text-[10px] text-muted mt-1 leading-snug">
            {cellOnFocused
              ? 'Pin captures the value shown next to it and the engine emits THAT value forever — modulators don\'t drive it, scene triggers don\'t overwrite it. Edit pinned values inline; the engine picks them up live. Click "Send to clips" below to also stamp the pinned values into every clip\'s value string.'
              : 'No clip on the focused scene yet — the values above are the argSpec defaults. Pinning here works once a clip exists.'}
          </div>
        </Section>
      )}

      <Section title={`${noun} default destination`}>
        <div className="flex gap-1 items-center">
          <UncontrolledTextInput
            className="input flex-1"
            value={track.defaultDestIp ?? ''}
            placeholder="(inherit)"
            onChange={(v) => setTrackDefaults(trackId, { defaultDestIp: v || undefined })}
          />
          <span className="text-muted">:</span>
          <UncontrolledTextInput
            className="input w-16"
            value={track.defaultDestPort === undefined ? '' : String(track.defaultDestPort)}
            placeholder="port"
            onChange={(v) => {
              if (v === '') {
                setTrackDefaults(trackId, { defaultDestPort: undefined })
                return
              }
              if (!/^\d+$/.test(v)) return
              const n = parseInt(v, 10)
              if (n >= 0 && n <= 65535) setTrackDefaults(trackId, { defaultDestPort: n })
            }}
          />
        </div>
      </Section>

      <Section title={`${noun} default OSC address`}>
        <UncontrolledTextInput
          className="input w-full"
          value={track.defaultOscAddress ?? ''}
          placeholder="(inherit)"
          onChange={(v) => setTrackDefaults(trackId, { defaultOscAddress: v || undefined })}
        />
      </Section>

      {/* MIDI Output default for this Parameter row. Cells created
          on this track (via the empty-cell click flow) snapshot the
          settings onto cell.midiOut. So: configure MIDI here once
          per Parameter, then every new Scene's cell on this row
          gets MIDI pre-wired. */}
      <TrackMidiOutSection track={track} noun={noun} />

      <button
        className="btn-accent"
        onClick={() => {
          const pinnedCount = (track.persistentSlots ?? []).filter(
            (b) => b === true
          ).length
          const pinnedSuffix =
            pinnedCount > 0
              ? `\n\nPinned values (${pinnedCount}) will also be written into each clip's value tokens.`
              : ''
          const msg =
            (cellsCount === scenesCount
              ? `Apply this ${noun.toLowerCase()}'s defaults to all ${cellsCount} clip(s) on this row? Overwrites existing values.`
              : `Apply this ${noun.toLowerCase()}'s defaults to all ${scenesCount} scenes on this row? Overwrites the ${cellsCount} existing clip(s) and auto-creates clips on the ${scenesCount - cellsCount} empty scene(s).`) +
            pinnedSuffix
          if (scenesCount === 0) return
          if (confirm(msg)) sendTrackDefaultsToClips(trackId)
        }}
        disabled={scenesCount === 0}
      >
        Send to clips ({cellsCount}/{scenesCount})
      </button>

      <div className="text-[10px] text-muted leading-snug">
        Only fields with a value get sent. Leave a field blank to skip it.
        Pinned values, when present, are also broadcast to every clip on this row.
      </div>
    </div>
  )
}

// MIDI Output default editor for the Parameter/Instrument row
// (TrackInspector). Stored on `track.midiOut`. New cells created
// on this track inherit it at ensureCell-time so a fresh Scene's
// cell on a MIDI-wired Parameter is already configured — the user
// just flips Enable per-cell.
function TrackMidiOutSection({
  track,
  noun
}: {
  track: Track
  noun: string
}): JSX.Element {
  const setTrackMidiOut = useStore((s) => s.setTrackMidiOut)
  const m =
    track.midiOut ??
    ({
      enabled: false,
      portName: '',
      channel: 1,
      kind: 'cc' as const,
      cc: 1,
      noteMode: 'velocity' as const,
      gateLengthMs: 0
    } satisfies NonNullable<Track['midiOut']>)
  function patchMidi(p: Partial<NonNullable<Track['midiOut']>>): void {
    setTrackMidiOut(track.id, p)
  }
  const [ports, setPorts] = useState<string[]>([])
  const [available, setAvailable] = useState<boolean>(true)
  useEffect(() => {
    let cancelled = false
    window.api?.midiListPorts?.().then((r) => {
      if (cancelled) return
      setPorts(r.ports)
      setAvailable(r.available)
    })
    return () => {
      cancelled = true
    }
  }, [m.enabled])
  return (
    <Section title={`${noun} default MIDI output`}>
      <label
        className="flex items-center gap-2 cursor-pointer select-none mb-1"
        title="When ON, every new cell created on this Parameter row will inherit these MIDI settings — port, channel, CC/Note, etc. Per-cell can flip enable + override."
      >
        <input
          type="checkbox"
          checked={m.enabled}
          onChange={(e) => {
            patchMidi({ enabled: e.target.checked })
            // Drop-focus stickiness fix (same pattern as v0.4.1's
            // Pool drop handler): when this checkbox flips enabled
            // TRUE, the conditional body below mounts a fresh
            // <select> + CH input. Chromium-on-Electron sometimes
            // keeps `document.activeElement` glued to the checkbox
            // after a programmatic re-render, so the user's next
            // click on the CH input wouldn't actually transfer
            // focus (looked focused, didn't accept keystrokes
            // until a window-switch reset the state). Blurring on
            // the next animation frame releases the stale focus.
            if (e.target.checked) {
              requestAnimationFrame(() => {
                const ae = document.activeElement as HTMLElement | null
                ae?.blur?.()
              })
            }
          }}
        />
        <span className="text-[11px]">Enabled by default on new cells</span>
        {!available && (
          <span className="text-[10px] text-danger">MIDI unavailable</span>
        )}
      </label>
      {m.enabled && (
        <div className="flex flex-col gap-1 text-[11px]">
          <div className="grid grid-cols-[auto_minmax(0,1fr)_auto_auto] gap-x-2 gap-y-1 items-center">
            <span className="label">Port</span>
            <select
              className="input text-[11px] py-0.5 min-w-0 max-w-full"
              style={{ textOverflow: 'ellipsis' }}
              value={m.portName}
              onChange={(e) => patchMidi({ portName: e.target.value })}
            >
              <option value="">— select port —</option>
              {m.portName && !ports.includes(m.portName) && (
                <option value={m.portName}>{m.portName} (disconnected)</option>
              )}
              {ports.map((p) => (
                <option key={p} value={p}>
                  {p}
                </option>
              ))}
            </select>
            <span className="label">Ch</span>
            <BoundedNumberInput
              className="input w-10 text-center tabular-nums"
              value={m.channel}
              onChange={(v) => patchMidi({ channel: v })}
              min={1}
              max={16}
              integer
            />
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            <span className="label">Kind</span>
            <div className="flex items-center gap-0.5">
              <button
                className={`text-[10px] px-2 py-0 leading-tight rounded border ${
                  m.kind === 'cc'
                    ? 'bg-accent text-black border-accent'
                    : 'border-border text-muted hover:text-text'
                }`}
                onClick={() => patchMidi({ kind: 'cc' })}
              >
                CC
              </button>
              <button
                className={`text-[10px] px-2 py-0 leading-tight rounded border ${
                  m.kind === 'note'
                    ? 'bg-accent text-black border-accent'
                    : 'border-border text-muted hover:text-text'
                }`}
                onClick={() => patchMidi({ kind: 'note' })}
              >
                Note
              </button>
            </div>
            {m.kind === 'cc' ? (
              <>
                <span className="label">CC #</span>
                <BoundedNumberInput
                  className="input w-14"
                  value={m.cc ?? 0}
                  onChange={(v) => patchMidi({ cc: v })}
                  min={0}
                  max={127}
                  integer
                />
              </>
            ) : (
              <>
                <span className="label">Gate</span>
                <BoundedNumberInput
                  className="input w-16"
                  value={m.gateLengthMs ?? 0}
                  onChange={(v) => patchMidi({ gateLengthMs: v })}
                  min={0}
                  max={60000}
                  integer
                  title="Note Off fires this many ms after Note On. 0 = until next trigger / scene change."
                />
                <span className="text-[10px] text-muted">ms</span>
              </>
            )}
          </div>
          <div className="text-[10px] text-muted leading-snug mt-1">
            These settings populate <span className="text-text">cell.midiOut</span> on every
            new clip you author on this {noun.toLowerCase()}. Existing cells aren&apos;t
            rewritten — to push current defaults to live clips, edit the cell
            directly from its Inspector.
          </div>
        </div>
      )}
    </Section>
  )
}

// Per-arg persistence toggle list. One row per editable arg in the
// Render a space-joined string of the editable slots' init values
// from an argSpec. Used as a fallback "cell value" for the
// Parameter Inspector's pin-list when no clip exists on the focused
// scene yet — gives the user a preview of the multi-arg layout
// immediately instead of forcing them to create a clip first.
function argSpecInitTokens(argSpec: ParamArgSpec[]): string {
  const out: string[] = []
  for (const a of argSpec) {
    if (a.fixed !== undefined) continue
    const v = a.init
    if (typeof v === 'number') out.push(String(v))
    else if (typeof v === 'string') out.push(v)
    else if (typeof v === 'boolean') out.push(v ? '1' : '0')
    else out.push('0')
  }
  return out.join(' ')
}

// Per-arg post-modulation Scaling editor in the Cell Inspector.
// Renders a CollapsibleSection between Value(s) and Timing. The
// checkbox on the header doubles as the engine-side enable flag —
// when off, no clamping happens; when on, each slot's `out` is
// clamped to `[scalingMin[i], scalingMax[i]]` BEFORE Scale 0.0–1.0
// and MIDI Scale (handled in the engine emit pipeline).
//
// Multi-arg cells (track.argSpec.length > 1) render one row per
// EDITABLE slot (fixed protocol prefixes don't have a clamp — the
// engine emits their fixed value verbatim regardless). Single-arg
// cells render a single "Value" row. Defaults come from the
// source InstrumentFunction's min/max (or 0/1 if missing) so an
// "enable" tick gives the user a sensible starting band.
function CellScalingSection({
  cell,
  track,
  onChange
}: {
  cell: Cell
  track: Track | undefined
  onChange: (patch: Partial<Cell>) => void
}): JSX.Element {
  const setCellScaling = useStore((s) => s.setCellScaling)
  const selectedCell = useStore((s) => s.selectedCell)
  if (!selectedCell) {
    // Shouldn't reach here — the inspector only renders when a cell
    // is selected — but guard so the section never crashes the pane.
    return <></>
  }
  // Slot list: editable argSpec entries for multi-arg cells, or a
  // single synthetic "Value" entry for single-arg cells (so the UI
  // shape is identical regardless of token count).
  type SlotMeta = { name: string; idx: number; defaultMin: number; defaultMax: number }
  const slots: SlotMeta[] = []
  if (track?.argSpec && track.argSpec.length > 0) {
    track.argSpec.forEach((a, i) => {
      if (a.fixed !== undefined) return
      slots.push({
        name: a.name || `Value ${i + 1}`,
        idx: i,
        defaultMin: typeof a.min === 'number' ? a.min : 0,
        defaultMax: typeof a.max === 'number' ? a.max : 1
      })
    })
  } else {
    slots.push({ name: 'Value', idx: 0, defaultMin: 0, defaultMax: 1 })
  }
  const enabled = cell.scalingEnabled === true
  return (
    <CollapsibleSection
      title="Scaling"
      titleTooltip={
        'Clamps each value to [min, max].\n\n' +
        'POST (default): AFTER modulators / sequencer but BEFORE Scale 0.0–1.0 and MIDI Scale. Tames extreme outputs (a Random / Chaos source overshooting, an LFO swinging too wide, etc.).\n\n' +
        'PRE: BEFORE modulators / sequencer pick up the value — clamps the seed first so the entire downstream chain operates within your band.\n\n' +
        'Pinned slots bypass either mode.'
      }
      enabled={enabled}
      onToggle={(v) => {
        // Toggling ON: seed default min/max from argSpec for every
        // slot that doesn't already have a clamp, so the engine
        // has concrete numbers to clamp against straight away.
        // Otherwise an "enable" with empty arrays would no-op.
        if (v && !cell.scalingEnabled) {
          const seedMin: number[] = cell.scalingMin ? cell.scalingMin.slice() : []
          const seedMax: number[] = cell.scalingMax ? cell.scalingMax.slice() : []
          for (const s of slots) {
            if (typeof seedMin[s.idx] !== 'number') seedMin[s.idx] = s.defaultMin
            if (typeof seedMax[s.idx] !== 'number') seedMax[s.idx] = s.defaultMax
          }
          onChange({
            scalingEnabled: true,
            scalingMin: seedMin,
            scalingMax: seedMax
          })
        } else {
          onChange({ scalingEnabled: v })
        }
      }}
      headerRight={
        enabled ? (
          <select
            className="input text-[10px] py-0 px-1 leading-tight"
            value={cell.scalingMode ?? 'post'}
            onChange={(e) =>
              onChange({ scalingMode: e.target.value as 'pre' | 'post' })
            }
            title="PRE: clamp the raw seed BEFORE modulator + sequencer.\nPOST (default): clamp the final value AFTER modulator + sequencer, before Scale 0.0–1.0 + MIDI Scale."
            onClick={(e) => e.stopPropagation()}
          >
            <option value="post">POST</option>
            <option value="pre">PRE</option>
          </select>
        ) : undefined
      }
    >
      <div className="grid grid-cols-[1fr_auto_auto] gap-x-2 gap-y-1 items-center">
        <span className="text-[9px] uppercase tracking-wide text-muted">
          Slot
        </span>
        <span className="text-[9px] uppercase tracking-wide text-muted">
          Min
        </span>
        <span className="text-[9px] uppercase tracking-wide text-muted">
          Max
        </span>
        {slots.map((s) => {
          const min =
            typeof cell.scalingMin?.[s.idx] === 'number'
              ? cell.scalingMin![s.idx]
              : s.defaultMin
          const max =
            typeof cell.scalingMax?.[s.idx] === 'number'
              ? cell.scalingMax![s.idx]
              : s.defaultMax
          return (
            <Fragment key={s.idx}>
              <span className="text-[11px] truncate" title={s.name}>
                {s.name}
              </span>
              <BoundedNumberInput
                className="input text-[11px] py-0.5 w-[72px]"
                value={min}
                onChange={(v) =>
                  setCellScaling(selectedCell.sceneId, selectedCell.trackId, {
                    slotIdx: s.idx,
                    min: v
                  })
                }
                min={-1e9}
                max={1e9}
              />
              <BoundedNumberInput
                className="input text-[11px] py-0.5 w-[72px]"
                value={max}
                onChange={(v) =>
                  setCellScaling(selectedCell.sceneId, selectedCell.trackId, {
                    slotIdx: s.idx,
                    max: v
                  })
                }
                min={-1e9}
                max={1e9}
              />
            </Fragment>
          )
        })}
      </div>
    </CollapsibleSection>
  )
}

// Routing matrix — per-slot gates for the Modulator and Sequencer.
// Renders a 2-row × N-column grid where rows = {Modulator, Sequencer}
// and columns = each NON-FIXED arg slot of the cell. Default state
// is "all checked" (current legacy behavior — both drivers affect
// every slot). Unticking a cell prevents that direction from
// touching the slot at engine emit time.
//
// Engine precedence (lower index wins):
//   argSpec.fixed → declared value, routing ignored
//   Pin           → pinned value, routing ignored
//   Routing       → gates Modulator + Sequencer contributions
//
// Always rendered (not collapsible behind an enable flag) so the
// user can dial individual slots without having to "turn it on"
// first — the default-all-checked state IS the unconfigured state.
//
// ─────────────────────────────────────────────────────────────────
// RoutingMiniKnob — 16-px circular knob used inside the Routing
// matrix's Variation column. Two views, one value: this knob and
// the adjacent BoundedNumberInput both drive the same 0..100 %
// `variations[idx]` field, so the user can scrub OR type.
//
// Interaction model copied from MetaKnob (the bigger Meta
// Controller dial) but stripped down: vertical drag = adjust,
// Shift = 4× fine, double-click = reset to 0. 200 px of vertical
// travel maps to the full 0..100 % range, matching MetaKnob feel.
// SVG arc + indicator are accent-tinted so the knob picks up any
// active theme automatically.
// ─────────────────────────────────────────────────────────────────
function RoutingMiniKnob({
  value,
  onChange,
  title
}: {
  value: number // 0..100
  onChange: (v: number) => void
  title?: string
}): JSX.Element {
  const dragRef = useRef<{
    startY: number
    startValue: number
    pointerId: number
  } | null>(null)
  const size = 16
  const cx = size / 2
  const cy = size / 2
  const radius = size / 2 - 2
  const startDeg = 225
  const sweep = 270
  const norm = Math.max(0, Math.min(1, value / 100))
  const currentDeg = startDeg + norm * sweep
  const rad = (deg: number): number => ((deg - 90) * Math.PI) / 180
  const arcStart = rad(startDeg)
  const arcEnd = rad(currentDeg)
  const largeArc = currentDeg - startDeg > 180 ? 1 : 0
  const bgEnd = rad(startDeg + sweep)
  const bgLarge = sweep > 180 ? 1 : 0
  const indicatorInner = radius - 3
  const indicatorOuter = radius
  function onPointerDown(e: React.PointerEvent<SVGSVGElement>): void {
    if (e.button !== 0) return
    try {
      ;(e.currentTarget as unknown as Element).setPointerCapture?.(e.pointerId)
    } catch {
      /* ignore */
    }
    dragRef.current = {
      startY: e.clientY,
      startValue: value,
      pointerId: e.pointerId
    }
    document.body.style.cursor = 'ns-resize'
  }
  function onPointerMove(e: React.PointerEvent<SVGSVGElement>): void {
    const d = dragRef.current
    if (!d || e.pointerId !== d.pointerId) return
    const dy = d.startY - e.clientY // drag up = increase
    const sensitivity = e.shiftKey ? 4 : 1
    const delta = (dy / (200 * sensitivity)) * 100
    // 0.01 % resolution — matches the BoundedNumberInput's step and
    // the parent's two-decimal rounding so the knob can dial in
    // values like 65.50 % without "snap to integer" steps.
    const raw = Math.max(0, Math.min(100, d.startValue + delta))
    const next = Math.round(raw * 100) / 100
    if (next !== value) onChange(next)
  }
  function onPointerUp(e: React.PointerEvent<SVGSVGElement>): void {
    const d = dragRef.current
    if (!d || e.pointerId !== d.pointerId) return
    try {
      ;(e.currentTarget as unknown as Element).releasePointerCapture?.(e.pointerId)
    } catch {
      /* ignore */
    }
    dragRef.current = null
    document.body.style.cursor = ''
  }
  return (
    <svg
      width={size}
      height={size}
      viewBox={`0 0 ${size} ${size}`}
      className="cursor-ns-resize select-none shrink-0"
      style={{ touchAction: 'none' }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onDoubleClick={() => onChange(0)}
    >
      <title>{title ?? `Variation ${value}% — drag vertically · shift = fine · dbl-click = 0`}</title>
      {/* Background track */}
      <path
        d={`M ${cx + radius * Math.cos(arcStart)} ${cy + radius * Math.sin(arcStart)} A ${radius} ${radius} 0 ${bgLarge} 1 ${cx + radius * Math.cos(bgEnd)} ${cy + radius * Math.sin(bgEnd)}`}
        fill="none"
        stroke="rgb(var(--c-panel3))"
        strokeWidth={2}
        strokeLinecap="round"
      />
      {/* Value arc */}
      {norm > 0.001 && (
        <path
          d={`M ${cx + radius * Math.cos(arcStart)} ${cy + radius * Math.sin(arcStart)} A ${radius} ${radius} 0 ${largeArc} 1 ${cx + radius * Math.cos(arcEnd)} ${cy + radius * Math.sin(arcEnd)}`}
          fill="none"
          stroke="rgb(var(--c-accent))"
          strokeWidth={2}
          strokeLinecap="round"
        />
      )}
      {/* Indicator line */}
      <line
        x1={cx + indicatorInner * Math.cos(rad(currentDeg))}
        y1={cy + indicatorInner * Math.sin(rad(currentDeg))}
        x2={cx + indicatorOuter * Math.cos(rad(currentDeg))}
        y2={cy + indicatorOuter * Math.sin(rad(currentDeg))}
        stroke="rgb(var(--c-accent))"
        strokeWidth={1.5}
        strokeLinecap="round"
      />
    </svg>
  )
}

function CellRoutingSection({
  cell,
  track,
  onChange
}: {
  cell: Cell
  track: Track | undefined
  onChange: (patch: Partial<Cell>) => void
}): JSX.Element {
  // Slot list — same shape as CellScalingSection above: non-fixed
  // argSpec entries for multi-arg cells, or a single synthetic
  // "Value" row for single-arg cells.
  type SlotMeta = { name: string; idx: number }
  const slots: SlotMeta[] = []
  if (track?.argSpec && track.argSpec.length > 0) {
    track.argSpec.forEach((a, i) => {
      if (a.fixed !== undefined) return
      slots.push({ name: a.name || `${i + 1}`, idx: i })
    })
  } else {
    slots.push({ name: 'Value', idx: 0 })
  }
  // Read current per-slot booleans, default true (= routed).
  const modOn = (i: number): boolean => cell.routing?.modulator?.[i] !== false
  const mod2On = (i: number): boolean =>
    cell.routing?.modulation2?.[i] !== false
  const mod2SeqOn = (i: number): boolean =>
    cell.routing?.modulation2Seq?.[i] !== false
  const seqOn = (i: number): boolean => cell.routing?.sequencer?.[i] !== false
  // Whether the Modulation 2 column is active — gates the new column
  // visually + functionally. When Modulation 2 is disabled on the
  // cell, the column is greyed out + the ticks are no-ops (the
  // engine ignores them anyway, but we want the UI to read as
  // "irrelevant right now" rather than "go ahead and change me").
  const mod2Enabled = cell.modulation2?.enabled === true
  // Type alias for the per-slot routing direction we mutate. New
  // 'modulation2Seq' branch covers the Mod 2 -> Sequencer column.
  type RoutingDir = 'modulator' | 'modulation2' | 'modulation2Seq' | 'sequencer'
  // Set a tick to an explicit value (used by both click and the
  // click+drag paint mode). Lazily initialises the arrays so old
  // sessions don't carry empty arrays around.
  function setTick(direction: RoutingDir, slotIdx: number, value: boolean): void {
    const curMod = cell.routing?.modulator ? cell.routing.modulator.slice() : []
    const curMod2 = cell.routing?.modulation2
      ? cell.routing.modulation2.slice()
      : []
    const curMod2Seq = cell.routing?.modulation2Seq
      ? cell.routing.modulation2Seq.slice()
      : []
    const curSeq = cell.routing?.sequencer ? cell.routing.sequencer.slice() : []
    const arr =
      direction === 'modulator'
        ? curMod
        : direction === 'modulation2'
          ? curMod2
          : direction === 'modulation2Seq'
            ? curMod2Seq
            : curSeq
    arr[slotIdx] = value
    onChange({
      routing: {
        modulator: direction === 'modulator' ? curMod : cell.routing?.modulator,
        modulation2:
          direction === 'modulation2' ? curMod2 : cell.routing?.modulation2,
        modulation2Seq:
          direction === 'modulation2Seq'
            ? curMod2Seq
            : cell.routing?.modulation2Seq,
        sequencer: direction === 'sequencer' ? curSeq : cell.routing?.sequencer,
        delays: cell.routing?.delays,
        variations: cell.routing?.variations
      }
    })
  }
  // Bulk "all on / all off" per row — quick way to disable an entire
  // driver without unticking each slot.
  function setAll(direction: RoutingDir, value: boolean): void {
    const arr: boolean[] = new Array(slots.length)
    for (const s of slots) arr[s.idx] = value
    onChange({
      routing: {
        modulator: direction === 'modulator' ? arr : cell.routing?.modulator,
        modulation2:
          direction === 'modulation2' ? arr : cell.routing?.modulation2,
        modulation2Seq:
          direction === 'modulation2Seq'
            ? arr
            : cell.routing?.modulation2Seq,
        sequencer: direction === 'sequencer' ? arr : cell.routing?.sequencer,
        delays: cell.routing?.delays,
        variations: cell.routing?.variations
      }
    })
  }
  // Per-slot Delay (ms) and Variation (%) — write helpers that
  // grow / shrink the backing arrays lazily.
  function setDelayAt(slotIdx: number, value: number): void {
    const arr = cell.routing?.delays ? cell.routing.delays.slice() : []
    arr[slotIdx] = Math.max(0, Math.round(value))
    onChange({
      routing: {
        modulator: cell.routing?.modulator,
        modulation2: cell.routing?.modulation2,
        modulation2Seq: cell.routing?.modulation2Seq,
        sequencer: cell.routing?.sequencer,
        delays: arr,
        variations: cell.routing?.variations
      }
    })
  }
  function setVariationAt(slotIdx: number, value: number): void {
    const arr = cell.routing?.variations ? cell.routing.variations.slice() : []
    // Two-decimal float — "up to 4 digits" in the user's words
    // (e.g. 65.50 %). Round here so the displayed token matches what's
    // stored, and so the engine doesn't tickle float-noise into the
    // variation factor.
    const clamped = Math.min(100, Math.max(0, value))
    arr[slotIdx] = Math.round(clamped * 100) / 100
    onChange({
      routing: {
        modulator: cell.routing?.modulator,
        modulation2: cell.routing?.modulation2,
        modulation2Seq: cell.routing?.modulation2Seq,
        sequencer: cell.routing?.sequencer,
        delays: cell.routing?.delays,
        variations: arr
      }
    })
  }
  const delayAt = (i: number): number => cell.routing?.delays?.[i] ?? 0
  const variationAt = (i: number): number => cell.routing?.variations?.[i] ?? 0
  // Click+drag paint mode. When the user mouses DOWN on a tick we
  // remember which direction they're painting and what value they're
  // painting in (the opposite of the tick they hit). As long as the
  // mouse button is held, entering any other tick in the SAME
  // direction sets it to that captured value too. Releases anywhere
  // on the window clear the state.
  const [dragMode, setDragMode] = useState<{
    direction: RoutingDir
    setTo: boolean
  } | null>(null)
  useEffect(() => {
    if (!dragMode) return
    const onUp = (): void => setDragMode(null)
    window.addEventListener('mouseup', onUp)
    return () => window.removeEventListener('mouseup', onUp)
  }, [dragMode])
  // Hover-only description for the section heading. Lives on the
  // section wrapper (CollapsibleViewSection renders the title as a
  // <span> with no `title` attr) so hovering anywhere on the header
  // row surfaces it.
  const sectionTitleTooltip =
    'Per-slot routing matrix. Columns:\n' +
    '  Mod         - Modulation 1 -> this slot (untick -> slot uses cell.value seed)\n' +
    '  Mod 2 -> 1  - Modulation 2 modulates Modulation 1 on this slot (untick ->\n' +
    '                slot reads the ORIGINAL Modulation 1 params, bypassing Mod 2)\n' +
    '  Mod 2 -> S  - Modulation 2 modulates the Sequencer (bpm / shape / genAmount).\n' +
    '                If EVERY slot is unticked, the Mod 2 -> Seq routing is\n' +
    '                disabled cell-wide. Any ticked slot enables the routing.\n' +
    '  Seq         - Sequencer -> this slot\n' +
    '  Delay       - ms before Mod / Seq engage after each trigger\n' +
    '  Var         - random 0..100 % scaling of the modulator amplitude per trigger\n\n' +
    'Default (all ticked, Delay 0, Variation 0) = previous behaviour.\n\n' +
    'Beaten by:\n' +
    '  - argSpec.fixed (protocol prefixes always emit their declared value)\n' +
    '  - Pin (a pinned slot ignores routing entirely and emits the captured value)\n\n' +
    'Tip: click a tick and drag across the column to paint several at once.\n\n' +
    'Click the section title to collapse / expand.'
  return (
    <div title={sectionTitleTooltip}>
    <CollapsibleViewSection
      title="Routing"
      rightContent={
        <span className="text-[10px] text-muted">
          {slots.length === 1 ? '1 slot' : `${slots.length} slots`}
        </span>
      }
    >
      {/* Per-row routing matrix. One ROW per arg slot. Columns:
          [slot-name | Mod | Seq | Delay-ms | Variation-%]. The two
          tick columns are adjacent (PD-vradio-style filled squares)
          and the whole grid is horizontally centred inside the
          Inspector so the name column hugs the ticks. Click+drag on
          ticks paints in the same direction. Theme-aware via CSS
          variables (c-accent for filled, c-border for empty). */}
      <div
        className="grid gap-x-1.5 gap-y-0.5 items-center text-[10px] mx-auto"
        style={{
          // Columns: [slot name | Mod | Mod 2 -> Mod 1 | spacer | Mod 2 -> Seq | Seq | Delay | Var].
          // The two "Mod 2" columns are kept close but separated by
          // a slim spacer column so the user reads them as TWO
          // distinct features (Mod 2 -> Mod 1 vs Mod 2 -> Sequencer).
          // Left-to-right reading order is Mod 1 -> Mod 2 chain ->
          // Sequencer chain -> per-slot timing controls.
          gridTemplateColumns: 'auto 22px 22px 12px 22px 22px 56px 76px'
        }}
        onMouseLeave={() => {
          // If the user leaves the matrix while still painting we
          // keep dragMode (window mouseup clears it) — they may come
          // back. No-op here on purpose.
        }}
      >
        {/* Header row 1 — bulk-toggle row */}
        <span className="text-muted text-[9px] uppercase tracking-wide text-right pr-1">
          All
        </span>
        <button
          className="routing-bulk"
          onClick={() => {
            const allOn = slots.every((s) => modOn(s.idx))
            setAll('modulator', !allOn)
          }}
          title="Toggle every Modulation 1 slot on / off"
        >
          ⇆
        </button>
        <button
          className="routing-bulk"
          onClick={() => {
            const allOn = slots.every((s) => mod2On(s.idx))
            setAll('modulation2', !allOn)
          }}
          title={
            mod2Enabled
              ? 'Toggle every Modulation 2 -> Mod 1 slot on / off'
              : 'Modulation 2 is disabled on this cell - enable it in the Modulation 2 section above'
          }
          disabled={!mod2Enabled}
          style={mod2Enabled ? undefined : { opacity: 0.4, cursor: 'default' }}
        >
          ⇆
        </button>
        {/* Spacer between the two Mod 2 columns — visual separation
            so the user reads the columns as distinct features. */}
        <span />
        <button
          className="routing-bulk"
          onClick={() => {
            const allOn = slots.every((s) => mod2SeqOn(s.idx))
            setAll('modulation2Seq', !allOn)
          }}
          title={
            mod2Enabled
              ? 'Toggle every Modulation 2 -> Sequencer slot on / off'
              : 'Modulation 2 is disabled on this cell - column is inert until you enable it'
          }
          disabled={!mod2Enabled}
          style={mod2Enabled ? undefined : { opacity: 0.4, cursor: 'default' }}
        >
          ⇆
        </button>
        <button
          className="routing-bulk"
          onClick={() => {
            const allOn = slots.every((s) => seqOn(s.idx))
            setAll('sequencer', !allOn)
          }}
          title="Toggle every Sequencer slot on / off"
        >
          ⇆
        </button>
        <span className="text-muted text-[9px] uppercase tracking-wide text-center">
          Delay
        </span>
        <span className="text-muted text-[9px] uppercase tracking-wide text-center">
          Var
        </span>
        {/* Header row 2 — column labels */}
        <span />
        <span className="text-muted text-[9px] uppercase tracking-wide text-center">
          Mod
        </span>
        <span
          className={`text-[9px] uppercase tracking-wide text-center ${mod2Enabled ? 'text-muted' : 'text-muted/40'}`}
          title={
            mod2Enabled
              ? 'Modulation 2 -> Modulation 1 per slot'
              : 'Modulation 2 disabled on this cell - column is inert until you enable it.'
          }
        >
          M2&gt;1
        </span>
        {/* Spacer between Mod2>1 and Mod2>Seq column labels */}
        <span />
        <span
          className={`text-[9px] uppercase tracking-wide text-center ${mod2Enabled ? 'text-muted' : 'text-muted/40'}`}
          title={
            mod2Enabled
              ? 'Modulation 2 -> Sequencer per slot. If EVERY slot is unticked, the Mod 2 -> Seq routing is disabled cell-wide.'
              : 'Modulation 2 disabled on this cell - column is inert until you enable it.'
          }
        >
          M2&gt;S
        </span>
        <span className="text-muted text-[9px] uppercase tracking-wide text-center">
          Seq
        </span>
        <span className="text-muted text-[9px] uppercase tracking-wide text-center">
          ms
        </span>
        <span className="text-muted text-[9px] uppercase tracking-wide text-center">
          %
        </span>
        {/* One row per arg slot */}
        {slots.map((s) => (
          <Fragment key={s.idx}>
            <span className="truncate text-right pr-1" title={s.name}>
              {s.name}
            </span>
            <button
              className={`routing-tick ${modOn(s.idx) ? 'routing-tick-on' : ''}`}
              onMouseDown={(e) => {
                if (e.button !== 0) return
                const next = !modOn(s.idx)
                setTick('modulator', s.idx, next)
                setDragMode({ direction: 'modulator', setTo: next })
              }}
              onMouseEnter={() => {
                if (
                  dragMode &&
                  dragMode.direction === 'modulator' &&
                  modOn(s.idx) !== dragMode.setTo
                ) {
                  setTick('modulator', s.idx, dragMode.setTo)
                }
              }}
              title={`Modulation 1 → ${s.name}${modOn(s.idx) ? ' (routed)' : ' (gated off)'} · drag to paint`}
              aria-pressed={modOn(s.idx)}
            />
            {/* Modulation 2 -> Modulation 1 per-slot gate. Inert
                when Modulation 2 is disabled on the cell (still
                renders so the column layout doesn't jump). */}
            <button
              className={`routing-tick ${mod2On(s.idx) ? 'routing-tick-on' : ''}`}
              onMouseDown={(e) => {
                if (e.button !== 0) return
                if (!mod2Enabled) return
                const next = !mod2On(s.idx)
                setTick('modulation2', s.idx, next)
                setDragMode({ direction: 'modulation2', setTo: next })
              }}
              onMouseEnter={() => {
                if (!mod2Enabled) return
                if (
                  dragMode &&
                  dragMode.direction === 'modulation2' &&
                  mod2On(s.idx) !== dragMode.setTo
                ) {
                  setTick('modulation2', s.idx, dragMode.setTo)
                }
              }}
              disabled={!mod2Enabled}
              style={mod2Enabled ? undefined : { opacity: 0.35, cursor: 'default' }}
              title={
                mod2Enabled
                  ? `Modulation 2 -> Mod 1 on ${s.name}${mod2On(s.idx) ? ' (active)' : ' (bypassed - slot reads original Modulation 1)'} - drag to paint`
                  : 'Modulation 2 is disabled on this cell - enable it in the Modulation 2 section above first'
              }
              aria-pressed={mod2On(s.idx)}
            />
            {/* Visual spacer column between the two Mod 2 sub-columns. */}
            <span />
            {/* Modulation 2 -> Sequencer per-slot gate. Cell-level
                semantics: if EVERY slot's flag is false, Mod 2 ->
                Seq is bypassed cell-wide (the engine skips
                applyMod2ToSeq). Any ticked slot enables routing. */}
            <button
              className={`routing-tick ${mod2SeqOn(s.idx) ? 'routing-tick-on' : ''}`}
              onMouseDown={(e) => {
                if (e.button !== 0) return
                if (!mod2Enabled) return
                const next = !mod2SeqOn(s.idx)
                setTick('modulation2Seq', s.idx, next)
                setDragMode({ direction: 'modulation2Seq', setTo: next })
              }}
              onMouseEnter={() => {
                if (!mod2Enabled) return
                if (
                  dragMode &&
                  dragMode.direction === 'modulation2Seq' &&
                  mod2SeqOn(s.idx) !== dragMode.setTo
                ) {
                  setTick('modulation2Seq', s.idx, dragMode.setTo)
                }
              }}
              disabled={!mod2Enabled}
              style={mod2Enabled ? undefined : { opacity: 0.35, cursor: 'default' }}
              title={
                mod2Enabled
                  ? `Modulation 2 -> Sequencer on ${s.name}${mod2SeqOn(s.idx) ? ' (active)' : ' (untick all slots to disable Mod 2 -> Seq cell-wide)'} - drag to paint`
                  : 'Modulation 2 is disabled on this cell - enable it in the Modulation 2 section above first'
              }
              aria-pressed={mod2SeqOn(s.idx)}
            />
            <button
              className={`routing-tick ${seqOn(s.idx) ? 'routing-tick-on' : ''}`}
              onMouseDown={(e) => {
                if (e.button !== 0) return
                const next = !seqOn(s.idx)
                setTick('sequencer', s.idx, next)
                setDragMode({ direction: 'sequencer', setTo: next })
              }}
              onMouseEnter={() => {
                if (
                  dragMode &&
                  dragMode.direction === 'sequencer' &&
                  seqOn(s.idx) !== dragMode.setTo
                ) {
                  setTick('sequencer', s.idx, dragMode.setTo)
                }
              }}
              title={`Sequencer → ${s.name}${seqOn(s.idx) ? ' (routed)' : ' (gated off)'} · drag to paint`}
              aria-pressed={seqOn(s.idx)}
            />
            <BoundedNumberInput
              className="input w-full text-center tabular-nums px-1 py-0 text-[10px] leading-tight"
              value={delayAt(s.idx)}
              onChange={(v) => setDelayAt(s.idx, v)}
              min={0}
              max={60000}
              integer
              title={`Delay (ms) before Mod / Seq engage on ${s.name} after each trigger`}
            />
            <div className="flex items-center gap-1 w-full">
              <RoutingMiniKnob
                value={variationAt(s.idx)}
                onChange={(v) => setVariationAt(s.idx, v)}
                title={`Variation on ${s.name} — drag vertically · shift = fine · dbl-click resets to 0`}
              />
              <BoundedNumberInput
                className="input flex-1 min-w-0 text-center tabular-nums px-1 py-0 text-[10px] leading-tight"
                value={variationAt(s.idx)}
                onChange={(v) => setVariationAt(s.idx, v)}
                min={0}
                max={100}
                step={0.01}
                title={`Variation (%) — random ± scaling of the modulator depth on ${s.name}, reseeded per trigger (decimals allowed, e.g. 65.50)`}
              />
            </div>
          </Fragment>
        ))}
      </div>
    </CollapsibleViewSection>
    </div>
  )
}

// track's argSpec — shows the current value (from the focused
// scene's cell when not pinned, or the captured pinned value when
// pinned) + a checkbox that pins/unpins the slot. Pin captures the
// CURRENT VALUE at toggle time; that captured value is what the
// engine emits forever until unpinned.
function PersistentSlotList({
  argSpec,
  cellValue,
  persistentSlots,
  persistentValues,
  onToggle,
  onEditValue
}: {
  argSpec: ParamArgSpec[]
  cellValue: string
  persistentSlots: boolean[]
  persistentValues: string[]
  onToggle: (idx: number, persistent: boolean, capturedValue?: string) => void
  // Optional inline edit handler — when provided, pinned values
  // become editable text inputs and typing fires onEditValue with
  // the new token. The Parameter Inspector passes this; the cell
  // inspector (which doesn't use a PersistentSlotList right now)
  // omits it. Default-undefined keeps both call sites compatible.
  onEditValue?: (idx: number, value: string) => void
}): JSX.Element {
  const tokens = cellValue.trim().split(/\s+/).filter((t) => t.length > 0)
  return (
    <div className="grid grid-cols-[auto_1fr_auto] gap-x-2 gap-y-1 items-center">
      {argSpec.map((a, i) => {
        // Fixed argSpec entries (protocol headers like 'compositor'
        // or 0) are always emitted as their declared `fixed` token
        // by the engine — they bypass sequencer + modulator. Show
        // them in the pin list as locked rows so the user can SEE
        // what's being prepended on every send. The "pin" checkbox
        // is replaced with a static FIXED badge: pinning is
        // meaningless because the engine already treats `fixed`
        // exactly the way a pin would.
        if (a.fixed !== undefined) {
          const fixedDisplay =
            typeof a.fixed === 'boolean'
              ? a.fixed ? '1' : '0'
              : String(a.fixed)
          return (
            <Fragment key={i}>
              <span
                className="text-[10px] text-muted truncate"
                title={`${a.name} — protocol header (${a.type}); always emits this value`}
              >
                {a.name}
              </span>
              <span
                className="font-mono text-[11px] text-right truncate text-accent"
                title={`Fixed at ${fixedDisplay}`}
              >
                🔒 {fixedDisplay || '—'}
              </span>
              <span
                className="text-[9px] text-muted shrink-0 px-1 rounded-sm border border-border whitespace-nowrap"
                title="Sequencer + modulators never touch this slot — it's a protocol header declared in the Parameter's argSpec."
              >
                FIXED
              </span>
            </Fragment>
          )
        }
        const cellVal = tokens[i] ?? ''
        const pinned = persistentSlots[i] === true
        const pinnedVal = persistentValues[i] ?? ''
        // While pinned, show the captured value (what the engine is
        // emitting). While unpinned, show the live cell token.
        const displayVal = pinned ? pinnedVal : cellVal
        return (
          <Fragment key={i}>
            <span
              className="text-[10px] text-muted truncate"
              title={a.name}
            >
              {a.name}
            </span>
            {pinned && onEditValue ? (
              // Inline editor — clicking the field lets the user
              // type a new pinned value. The engine picks it up the
              // next time it emits this track (live), and "Send to
              // clips" stamps the value into every clip's value
              // string. Padlock prefix kept so the row still reads
              // as "this is pinned".
              <span
                className="flex items-center gap-1 justify-end font-mono text-[11px] text-accent"
                title={`Pinned value — edit and click "Send to clips" to broadcast to all clips on this row`}
              >
                <span aria-hidden>🔒</span>
                <UncontrolledTextInput
                  className="input font-mono text-[11px] text-right tabular-nums w-20 px-1 py-0 leading-tight"
                  value={pinnedVal}
                  onChange={(v) => onEditValue(i, v)}
                  title="Pinned value — engine emits this verbatim. Send to clips broadcasts it to every clip on this row."
                />
              </span>
            ) : (
              <span
                className={`font-mono text-[11px] text-right truncate ${
                  pinned ? 'text-accent' : ''
                }`}
                title={
                  pinned
                    ? `pinned at ${pinnedVal || '(empty)'}`
                    : displayVal || '(empty)'
                }
              >
                {pinned && '🔒 '}
                {displayVal || '—'}
              </span>
            )}
            <label
              className="flex items-center gap-1 text-[10px] shrink-0"
              title={
                pinned
                  ? 'Unpin — re-enable scene triggers + modulators on this slot'
                  : 'Pin — freeze this slot at the value shown'
              }
            >
              <input
                type="checkbox"
                checked={pinned}
                onChange={(e) => {
                  if (e.target.checked) {
                    // Capture the live cell value at pin moment.
                    onToggle(i, true, cellVal)
                  } else {
                    onToggle(i, false)
                  }
                }}
              />
              <span>pin</span>
            </label>
          </Fragment>
        )
      })}
    </div>
  )
}

function CellInspector(): JSX.Element {
  const sel = useStore((s) => s.selectedCell)!
  const scene = useStore((s) => s.session.scenes.find((sc) => sc.id === sel.sceneId))
  const track = useStore((s) => s.session.tracks.find((t) => t.id === sel.trackId))
  const cell = scene?.cells[sel.trackId]
  const updateCell = useStore((s) => s.updateCell)
  const setAddressToDefault = useStore((s) => s.setAddressToDefault)
  const setDestToDefault = useStore((s) => s.setDestToDefault)
  const setCellPersistentSlot = useStore((s) => s.setCellPersistentSlot)
  const currentStep = useStore(
    (s) => s.engine.seqStepBySceneAndTrack[sel.sceneId]?.[sel.trackId]
  )
  // Rich theme flag — drives whether bespoke arc sliders, mode-icon
  // rows, card-wrap sections, and console-readout numbers render in
  // place of the classic HTML controls. Reactive: switching theme
  // flips the entire inspector instantly.
  const rich = useStore((s) => isRichTheme(s.theme))

  if (!scene || !track || !cell) {
    return <div className="p-4 text-muted text-[12px]">Cell removed.</div>
  }
  const c = cell

  function u(patch: Partial<typeof c>): void {
    updateCell(sel.sceneId, sel.trackId, patch)
  }
  function uSeq(patch: Partial<typeof c.sequencer>): void {
    u({ sequencer: { ...c.sequencer, ...patch } })
  }

  // Tell the engine which cell to stream live Modulation 1 updates
  // for. ALWAYS request the stream while the Inspector is mounted on
  // a cell — even when Modulation 2 is off, the renderer wants the
  // live data for things like the Gesture playhead dot (which traces
  // the recorded curve at the modulator's rate regardless of Mod 2).
  // Engine throttles to ~30 Hz and the payload is small, so the
  // always-on stream is cheap. Clears on unmount so the engine stops
  // emitting when the user closes / navigates away from the Inspector.
  useEffect(() => {
    const api = window.api as typeof window.api & {
      setSelectedCellForLive?: (
        sel: { sceneId: string; trackId: string } | null
      ) => Promise<void>
    }
    if (!api.setSelectedCellForLive) return
    // Clear any leftover live sample from the PREVIOUS cell so the
    // current cell's editors don't briefly render the wrong overlay
    // / playhead. The engine will push a fresh sample on its next
    // tick (~30 ms later).
    useStore.getState().setMod1Live(null)
    api.setSelectedCellForLive({
      sceneId: sel.sceneId,
      trackId: sel.trackId
    })
    return () => {
      api.setSelectedCellForLive?.(null)
      // Also clear on unmount so the next time the Inspector mounts
      // on a different cell it starts clean.
      useStore.getState().setMod1Live(null)
    }
  }, [sel.sceneId, sel.trackId])

  return (
    <div className="p-3 flex flex-col gap-3 text-[12px]">
      {/* Shared BPM-sync tick marks — referenced by list="dataflou-division-ticks"
          from every modulation editor. Hoisted here so it's mounted no matter
          which editor (LFO / Arp / Random) is currently visible. */}
      <datalist id="dataflou-division-ticks">
        {DIVISIONS.map((_, i) => (
          <option key={i} value={i} />
        ))}
      </datalist>

      {/* Single line saves a row of vertical space — the label sits inline
          with the scene→message breadcrumb. */}
      <div className="flex items-baseline gap-2">
        <span className="label shrink-0">Cell</span>
        <span className="text-[11px] text-muted truncate">
          {scene.name} → {track.name}
        </span>
      </div>

      <CollapsibleViewSection
        title="Destination"
        forceCollapsed={cell.oscEnabled === false}
        headerEnd={
          // OSC Output toggle parked at the FAR RIGHT of the
          // section header (label first, checkbox second). Keeping
          // the chevron in the leftmost column means every section
          // header's collapse arrow lines up in the same vertical
          // column down the inspector. Unticking auto-collapses
          // Destination + OSC Address (via `forceCollapsed` on both).
          <label
            className="flex items-center gap-1.5 text-[11px] cursor-pointer select-none"
            title={
              (cell.oscEnabled ?? true)
                ? 'Disable OSC output for this clip (MIDI still fires if enabled). Collapses the Destination + OSC Address sections.'
                : 'Re-enable OSC output for this clip.'
            }
            onClick={(e) => e.stopPropagation()}
          >
            <span>OSC Output</span>
            <input
              type="checkbox"
              checked={cell.oscEnabled ?? true}
              onChange={(e) => u({ oscEnabled: e.target.checked })}
            />
          </label>
        }
      >
        <div className="flex gap-1 items-center">
          <UncontrolledTextInput
            className="input flex-1 min-w-0"
            value={cell.destIp}
            onChange={(v) => u({ destIp: v })}
            placeholder="IP"
            maxLength={15}
          />
          <span className="text-muted">:</span>
          <UncontrolledTextInput
            className="input w-14"
            value={String(cell.destPort)}
            placeholder="port"
            onChange={(v) => {
              if (!/^\d*$/.test(v)) return
              const n = v === '' ? 0 : parseInt(v, 10)
              if (Number.isFinite(n) && n <= 65535) u({ destPort: n })
            }}
          />
          {cell.destLinkedToDefault ? (
            <span className="chip text-accent2 shrink-0">~def~</span>
          ) : (
            <button
              className="btn text-[10px] px-1.5 py-0.5 shrink-0"
              onClick={() => setDestToDefault(sel.sceneId, sel.trackId)}
            >
              Default
            </button>
          )}
        </div>
      </CollapsibleViewSection>

      <CollapsibleViewSection
        title="OSC Address"
        forceCollapsed={cell.oscEnabled === false}
      >
        <div className="flex gap-1 items-center">
          <UncontrolledTextInput
            className="input flex-1 min-w-0"
            value={cell.oscAddress}
            onChange={(v) => u({ oscAddress: v })}
            placeholder="/path"
          />
          {cell.addressLinkedToDefault ? (
            <span className="chip text-accent2 shrink-0">~def~</span>
          ) : (
            <button
              className="btn text-[10px] px-1.5 py-0.5 shrink-0"
              onClick={() => setAddressToDefault(sel.sceneId, sel.trackId)}
            >
              Default
            </button>
          )}
        </div>
      </CollapsibleViewSection>

      {/* When the track was instantiated from a multi-arg spec
          (e.g. OCTOCOSME's /A/strips/pots — 2-arg fixed prefix +
          12 floats), render N labeled inputs instead of a single
          space-separated string. Each input edits its position in
          the cell's value tokens; fixed prefix tokens are auto-
          prepended on save. Sequencer mode disables the editor
          since per-step values can't yet be split across args. */}
      {track.argSpec && track.argSpec.length > 0 ? (
        <CollapsibleViewSection
          title={
            track.argSpec.filter((a) => a.fixed === undefined).length > 1
              ? 'Values'
              : 'Value'
          }
          rightContent={<ArgPrefixLabel argSpec={track.argSpec} />}
        >
          <MultiArgValueEditor
            cell={c}
            argSpec={track.argSpec}
            trackPersistentSlots={track.persistentSlots}
            disabled={cell.sequencer.enabled && !cell.sequencer.generative}
            onChange={(v) => u({ value: v })}
            onCommitTrigger={() => {
              const { sceneId, trackId } = sel
              setTimeout(() => {
                window.api.triggerCell(sceneId, trackId)
              }, 0)
            }}
            onTogglePin={(idx, nextPinned, capturedValue) =>
              setCellPersistentSlot(
                sel.sceneId,
                sel.trackId,
                idx,
                nextPinned,
                capturedValue
              )
            }
          />
          <div className="flex items-center gap-2 mt-2 flex-wrap">
            <label
              className="flex items-center gap-1 text-[11px] shrink-0"
              title="Clamp every output to [0.0, 1.0]"
            >
              <input
                type="checkbox"
                checked={cell.scaleToUnit}
                onChange={(e) => u({ scaleToUnit: e.target.checked })}
              />
              <span>Scale 0.0–1.0</span>
            </label>
            <label
              className="flex items-center gap-1 text-[10px] shrink-0"
              title="Scale the MIDI emit only — maps 0.0–1.0 to 0–127. Independent of Scale 0.0–1.0 (OSC). Live."
            >
              <input
                type="checkbox"
                checked={!!cell.midiScale}
                onChange={(e) => u({ midiScale: e.target.checked })}
              />
              {/* Stack "MIDI" / "Scale" on two lines, centered to the
                  checkbox, so the badge takes ~30 px wide instead of
                  ~70. Keeps the Scale-row tidy when both checkboxes
                  are visible alongside the muted hint span. */}
              <span className="flex flex-col leading-[1.05] text-center">
                <span>MIDI</span>
                <span>Scale</span>
              </span>
            </label>
            <label
              className="flex items-center gap-1 text-[10px] shrink-0"
              title="Round every arg's value to integer AFTER Scale 0.0–1.0 but BEFORE MIDI Scale. With scaleToUnit on, this snaps to 0 or 1 (binary). Without it, rounds the raw value to its nearest integer. Live."
            >
              <input
                type="checkbox"
                checked={!!cell.intScale}
                onChange={(e) => u({ intScale: e.target.checked })}
              />
              <span className="flex flex-col leading-[1.05] text-center">
                <span>Int</span>
                <span>Scale</span>
              </span>
            </label>
            {cell.sequencer.enabled && cell.sequencer.generative ? (
              <span className="text-success text-[10px]">
                (seed — generative mode on)
              </span>
            ) : cell.sequencer.enabled ? (
              <span className="text-accent text-[10px]">
                (ignored — sequencer on)
              </span>
            ) : null}
          </div>
        </CollapsibleViewSection>
      ) : (
        <CollapsibleViewSection title="Value">
          <div className="flex items-center gap-2">
            <UncontrolledTextInput
              className="input flex-1 font-mono"
              value={cell.value}
              onChange={(v) => u({ value: capTokens(v, 16) })}
              onKeyDown={(e) => {
                // Enter commits + re-triggers the clip. Engine.triggerCell
                // is a full restart — it resets LFO phase, envelope clock,
                // sequencer step, arp index, and the random-generator seed,
                // so the new value plays cleanly from the beginning of its
                // modulation/sequence cycle. Falling edge of the keystroke
                // (keyDown → blur → onChange will have run for the final
                // character); call triggerCell on a micro-delay so the
                // updateSession IPC flushes to main first.
                if (e.key === 'Enter') {
                  e.preventDefault()
                  // Force onChange to fire before we trigger — native input
                  // only dispatches onChange on value change, so if the
                  // user types then hits Enter without losing focus the
                  // last keystroke IS already committed; we just need the
                  // session push to land in main. setTimeout(0) defers the
                  // trigger past this tick so updateSession wins the race.
                  const { sceneId, trackId } = sel
                  setTimeout(() => {
                    window.api.triggerCell(sceneId, trackId)
                  }, 0)
                }
              }}
              placeholder="0"
              disabled={cell.sequencer.enabled && !cell.sequencer.generative}
            />
            <label className="flex items-center gap-1 text-[11px] shrink-0" title="Clamp every output to [0.0, 1.0]">
              <input
                type="checkbox"
                checked={cell.scaleToUnit}
                onChange={(e) => u({ scaleToUnit: e.target.checked })}
              />
              <span>Scale 0.0–1.0</span>
            </label>
            <label
              className="flex items-center gap-1 text-[10px] shrink-0"
              title="Scale the MIDI emit only — maps the cell's 0.0–1.0 float to 0–127. Independent of Scale 0.0–1.0 (which only affects OSC). Live: takes effect mid-play with no re-trigger."
            >
              <input
                type="checkbox"
                checked={!!cell.midiScale}
                onChange={(e) => u({ midiScale: e.target.checked })}
              />
              <span className="flex flex-col leading-[1.05] text-center">
                <span>MIDI</span>
                <span>Scale</span>
              </span>
            </label>
            <label
              className="flex items-center gap-1 text-[10px] shrink-0"
              title="Round every arg's value to integer AFTER Scale 0.0–1.0 but BEFORE MIDI Scale. With scaleToUnit on, this snaps to 0 or 1 (binary). Without it, rounds the raw value to its nearest integer. Live."
            >
              <input
                type="checkbox"
                checked={!!cell.intScale}
                onChange={(e) => u({ intScale: e.target.checked })}
              />
              <span className="flex flex-col leading-[1.05] text-center">
                <span>Int</span>
                <span>Scale</span>
              </span>
            </label>
          </div>
          <div className="text-[10px] text-muted mt-1">
            {(() => {
              const tokens = cell.value.trim().split(/\s+/).filter((t) => t)
              const tokenCount = tokens.length
              const types = tokens.map(detectedLabel)
              return (
                <>
                  {tokenCount === 1
                    ? `auto-detected: ${types[0] || 'string (empty)'}`
                    : `${tokenCount} values: ${types.join(', ')}`}
                  {tokenCount >= 16 && <span className="text-danger ml-2">(max 16)</span>}
                  {cell.sequencer.enabled && cell.sequencer.generative ? (
                    <span className="text-success ml-2">
                      (seed — generative mode on)
                    </span>
                  ) : cell.sequencer.enabled ? (
                    <span className="text-accent ml-2">(ignored — sequencer on)</span>
                  ) : null}
                </>
              )
            })()}
          </div>
        </CollapsibleViewSection>
      )}

      {/* Scaling — per-arg post-modulation clamp, applied BEFORE
          Scale 0.0–1.0 and MIDI Scale. Lets the user tame extreme
          values from a Random / Chaos / Generative source: "I want
          numbers between 0.2 and 0.8 even if the LFO swings to 0..1".
          Multi-arg cells get a row per editable slot (fixed protocol
          prefixes don't appear). Single-arg cells get one row labelled
          "Value". Collapsed + disabled by default. */}
      <CellScalingSection cell={c} track={track} onChange={u} />

      {/* Timing is collapsible + default-disabled. Checkbox on the
          section header flips `cell.timingEnabled`; when OFF the
          engine bypasses delay + transition entirely (treated as 0)
          but the stored values stick around for re-enable. */}
      <CollapsibleSection
        title="Timing"
        enabled={cell.timingEnabled === true}
        onToggle={(v) => u({ timingEnabled: v })}
      >
        <div className="grid grid-cols-[auto_1fr_auto] gap-x-2 gap-y-1 items-center">
          <span className="label">Delay</span>
          <BoundedNumberInput
            className="input"
            value={cell.delayMs}
            onChange={(v) => u({ delayMs: v })}
            min={0}
            max={10000}
            integer
          />
          <span className="text-muted text-[11px]">ms</span>
          <span className="label">Transition</span>
          <BoundedNumberInput
            className="input"
            value={cell.transitionMs}
            onChange={(v) => u({ transitionMs: v })}
            min={0}
            max={10000}
            integer
          />
          <span className="text-muted text-[11px]">ms</span>
        </div>
      </CollapsibleSection>

      {/* MIDI Output — fires in PARALLEL with the OSC destination
          above. When `kind === 'note'`, the cell's Value field is
          interpreted as the MIDI note number and a new Velocity
          field appears below; both go through the modulator +
          sequencer pipeline and each can be independently pinned. */}
      <MidiOutputSection
        cell={cell}
        onChange={(patch) =>
          u({ midiOut: { ...(cell.midiOut ?? DEFAULT_MIDI_OUT), ...patch } })
        }
        onVelocityChange={(v) => u({ velocity: v })}
        onVelocityHumanizeChange={(pct) =>
          u({
            velocityHumanize: Math.max(0, Math.min(100, Math.round(pct)))
          })
        }
        onPinVelocity={(p) => u({ velocityPersistent: p })}
        onPinNote={(p) => u({ notePersistent: p })}
        onPitchSnapChange={(patch) =>
          u({
            pitchSnap: {
              enabled: cell.pitchSnap?.enabled ?? false,
              root: cell.pitchSnap?.root ?? 0,
              scale: cell.pitchSnap?.scale ?? 'major',
              slotIdx: cell.pitchSnap?.slotIdx ?? 0,
              ...patch
            }
          })
        }
      />

      <CollapsibleSection
        title="Modulation 1"
        enabled={cell.modulation.enabled}
        onToggle={(v) => u({ modulation: { ...cell.modulation, enabled: v } })}
        headerRight={
          cell.modulation.enabled ? (
            <select
              // 148 px fits the widest entry ("Sample & Hold") plus the
              // native dropdown arrow across Win + macOS + Linux font
              // renderings. Previous 120 px was cropping "Sample & Hol…".
              className="input text-[11px] py-0.5"
              style={{ width: 148 }}
              value={cell.modulation.type}
              onChange={(e) => {
                const nextType = e.target.value as ModType
                // Ramp is a "full-range" modulator by design — at
                // depth < 100% only part of the 0→target travel happens.
                // Default the user into 100% the first time they pick
                // Ramp so the visualizer + audible behavior match the
                // intuitive "goes from 0 to the value" expectation.
                // Leaves depth alone on re-selection so manual tweaks
                // stick.
                const wasRamp = cell.modulation.type === 'ramp'
                const depthPct =
                  nextType === 'ramp' && !wasRamp ? 100 : cell.modulation.depthPct
                u({
                  modulation: { ...cell.modulation, type: nextType, depthPct }
                })
              }}
              onClick={(e) => e.stopPropagation()}
            >
              <option value="lfo">LFO</option>
              <option value="ramp">Ramp</option>
              <option value="envelope">Envelope</option>
              <option value="arpeggiator">Arpeggiator</option>
              <option value="random">Random</option>
              <option value="sh">Sample &amp; Hold</option>
              <option value="slew">Slew</option>
              <option value="chaos">Chaos</option>
              <option value="attractor">Strange Attractor</option>
              <option value="gesture">Gesture</option>
            </select>
          ) : null
        }
      >
        {cell.modulation.type === 'lfo' ? (
          <LfoEditor cell={c} u={u} />
        ) : cell.modulation.type === 'ramp' ? (
          <RampEditor cell={c} u={u} />
        ) : cell.modulation.type === 'envelope' ? (
          <EnvelopeEditor cell={c} u={u} />
        ) : cell.modulation.type === 'arpeggiator' ? (
          <ArpEditor cell={c} u={u} />
        ) : cell.modulation.type === 'random' ? (
          <RandomEditor cell={c} u={u} />
        ) : cell.modulation.type === 'sh' ? (
          <SampleHoldEditor cell={c} u={u} />
        ) : cell.modulation.type === 'slew' ? (
          <SlewEditor cell={c} u={u} />
        ) : cell.modulation.type === 'chaos' ? (
          <ChaosEditor cell={c} u={u} />
        ) : cell.modulation.type === 'gesture' ? (
          <GestureEditor cell={c} u={u} />
        ) : (
          <AttractorEditor cell={c} u={u} />
        )}
      </CollapsibleSection>

      <Mod2Section cell={c} u={u} />

      <CollapsibleSection
        title="Sequencer"
        enabled={cell.sequencer.enabled}
        onToggle={(v) => uSeq({ enabled: v })}
        headerRight={
          cell.sequencer.enabled ? (
            <label
              className="flex items-center gap-1 text-[11px] cursor-pointer select-none"
              title={
                'Generative: ignore the Step Values grid and live-generate per-step values from the cell\'s Value field as a seed.\n' +
                'Each mode reinterprets the seed organically:\n' +
                '  Steps      → Tide (sine swell)\n' +
                '  Euclidean  → Accent (downbeat hits land harder)\n' +
                '  Polyrhythm → Voicing (Ring A low / Ring B high / coincidence resonates)\n' +
                '  Density    → Wave (continuous sine, gate samples)\n' +
                '  Cellular   → Crowd (cells with more on-neighbours excite)\n' +
                '  Drift      → Terrain (1D landscape the walker samples)\n' +
                '  Ratchet    → Scatter (each sub-pulse a startled bird)'
              }
            >
              <input
                type="checkbox"
                checked={cell.sequencer.generative}
                onChange={(e) => uSeq({ generative: e.target.checked })}
              />
              <span
                className={
                  cell.sequencer.generative ? 'text-success' : 'text-muted'
                }
              >
                Generative
              </span>
            </label>
          ) : undefined
        }
      >
        <div className="grid grid-cols-[auto_1fr_auto] gap-x-2 gap-y-1 items-center">
          {cell.sequencer.generative &&
            (rich ? (
              <>
                {/* The Variation slider's label changes per
                    sequencer mode — Tide for Steps, Accent for
                    Euclidean, Voicing for Polyrhythm, etc. — so the
                    Inspector reads as "what musical idea am I
                    actually dialling in" rather than the generic
                    "Variation". Tooltip preserves the long-form
                    metaphor explanation. */}
                <span
                  className="label"
                  title={genVariationTitle(cell.sequencer.mode)}
                >
                  {genVariationLabel(cell.sequencer.mode)}
                </span>
                <div className="col-span-2">
                  <RcFlatBar
                    value={cell.sequencer.genAmount}
                    onChange={(v) => uSeq({ genAmount: v })}
                    min={0}
                    max={100}
                    step={1}
                    label={genVariationLabel(cell.sequencer.mode)}
                    format={(v) => `${Math.round(v)}%`}
                  />
                </div>
              </>
            ) : (
              <>
                <span
                  className="label"
                  title={genVariationTitle(cell.sequencer.mode)}
                >
                  {genVariationLabel(cell.sequencer.mode)}
                </span>
                <input
                  type="range"
                  min={0}
                  max={100}
                  step={1}
                  value={cell.sequencer.genAmount}
                  onChange={(e) =>
                    uSeq({ genAmount: clamp(Number(e.target.value), 0, 100) })
                  }
                  title={genVariationTitle(cell.sequencer.mode)}
                />
                <BoundedNumberInput
                  className="input w-14 text-right"
                  value={cell.sequencer.genAmount}
                  onChange={(v) => uSeq({ genAmount: v })}
                  min={0}
                  max={100}
                />
              </>
            ))}
          <span className="label">Sequencer</span>
          {rich ? (
            <div className="col-span-2">
              {/* Single right-justified row of 9 pictograms. Locks
                  the row to one line regardless of which mode is
                  selected so the layout stays stable. The cells
                  hug the right edge so the "Sequencer" label hangs
                  off the left and the icons cluster nicely. */}
              <RcModeIcons
                value={cell.sequencer.mode}
                onChange={(m) => uSeq({ mode: m })}
              />
            </div>
          ) : (
            <select
              className="input col-span-2"
              value={cell.sequencer.mode}
              onChange={(e) => uSeq({ mode: e.target.value as SeqMode })}
              title={
                'Steps: classic cycle.\n' +
                'Euclidean: N pulses spread evenly across Steps.\n' +
                'Polyrhythm: two ring clocks combined (3 vs 8, etc.).\n' +
                'Density: per-step probability driven by a Seed.\n' +
                'Cellular: 1D Wolfram automaton evolves the row each cycle.\n' +
                'Drift: Brownian playhead wanders the step row.\n' +
                'Ratchet: each step may burst into 2..N retriggers.\n' +
                'Bounce: real ball-bounce physics — accelerating intervals + decaying amplitude.\n' +
                'Draw: sketch an automation curve directly with the mouse.\n' +
                'Address: clock is bypassed — the cell\'s modulator picks the step (Buchla 245 style). Pairs best with smooth modulators (LFO, Strange Attractor, Slew, Chaos, S&H, Envelope).'
              }
            >
              <option value="steps">Steps (cycle)</option>
              <option value="euclidean">Euclidean</option>
              <option value="polyrhythm">Polyrhythm</option>
              <option value="density">Density</option>
              <option value="cellular">Cellular</option>
              <option value="drift">Drift</option>
              <option value="ratchet">Ratchet</option>
              <option value="bounce">Bounce (physics)</option>
              <option value="draw">Draw (curve)</option>
              <option value="adresse">Address</option>
            </select>
          )}

          {/* Address sub-mode picker — only shown when mode = address.
              Hijack (default) consumes Modulation 1 entirely; Parallel
              uses Modulation 1 for BOTH the address AND extra modulation;
              Stage 2 (v0.5.8) keeps Modulation 1 modulating the value
              while Modulation 2 picks the address. Stage 2 falls back to
              Modulation 1 when Modulation 2 is disabled on the cell,
              so the dropdown is never a silent no-op. */}
          {cell.sequencer.mode === 'adresse' && (
            <>
              <span className="label">Sub-mode</span>
              <select
                className="input text-[11px] py-0.5 min-w-0 col-span-2"
                value={cell.sequencer.adresseMode ?? 'hijack'}
                onChange={(e) =>
                  uSeq({ adresseMode: e.target.value as 'hijack' | 'parallel' | 'stage2' })
                }
                title={
                  'Hijack: Modulation 1 ONLY picks the playhead, step value emits as-is.\n' +
                  'Parallel: Modulation 1 picks the playhead AND modulates the resulting step value.\n' +
                  'Stage 2: Modulation 2 picks the playhead, Modulation 1 modulates the addressed step value.\n' +
                  '         Requires Modulation 2 to be enabled on the cell; falls back to Hijack if not.\n\n' +
                  'Pairs best with continuous modulators: LFO, S&H, Envelope, Strange Attractor, Slew, Chaos.\n' +
                  'Ramp is one-shot (sweeps the steps once then holds at the last).\n' +
                  'Arpeggiator outputs are quantised to the ladder pattern (uses only a few steps).'
                }
              >
                <option value="hijack">Hijack — Mod 1 picks only</option>
                <option value="parallel">Parallel — Mod 1 picks + modulates</option>
                <option value="stage2">Stage 2 — Mod 2 picks, Mod 1 modulates</option>
              </select>
              <div className="col-span-3 text-[10px] text-muted italic leading-snug">
                Best with continuous modulators (LFO, S&amp;H, Envelope, Strange Attractor, Slew, Chaos). Ramp sweeps once then holds; Arp jumps between only a few steps.
                {(cell.sequencer.adresseMode ?? 'hijack') === 'stage2' &&
                  cell.modulation2?.enabled !== true && (
                    <>
                      <br />
                      <span className="text-accent">Stage 2 picked but Modulation 2 is off on this cell — engine falls back to Modulation 1 driving the playhead.</span>
                    </>
                  )}
              </div>
            </>
          )}

          {/* Steps slider — hidden in Draw mode (Resolution IS the
              step count there; having both was confusing). */}
          {cell.sequencer.mode !== 'draw' && (
            <>
              <span className="label">Steps</span>
              <input
                type="range"
                min={1}
                max={16}
                step={1}
                value={cell.sequencer.steps}
                onChange={(e) =>
                  uSeq({ steps: clamp(Math.round(Number(e.target.value)), 1, 16) })
                }
              />
              <BoundedNumberInput
                className="input w-14 text-right"
                value={cell.sequencer.steps}
                onChange={(v) => uSeq({ steps: v })}
                min={1}
                max={16}
                integer
              />
            </>
          )}

          {cell.sequencer.mode === 'euclidean' && (
            <>
              <span className="label">Pulses</span>
              <input
                type="range"
                min={0}
                max={cell.sequencer.steps}
                step={1}
                value={Math.min(cell.sequencer.pulses, cell.sequencer.steps)}
                onChange={(e) =>
                  uSeq({ pulses: clamp(Math.round(Number(e.target.value)), 0, 16) })
                }
              />
              <BoundedNumberInput
                className="input w-14 text-right"
                value={cell.sequencer.pulses}
                onChange={(v) => uSeq({ pulses: v })}
                min={0}
                max={cell.sequencer.steps}
                integer
              />

              <span className="label">Rotate</span>
              <input
                type="range"
                min={0}
                max={Math.max(0, cell.sequencer.steps - 1)}
                step={1}
                value={Math.min(
                  cell.sequencer.rotation,
                  Math.max(0, cell.sequencer.steps - 1)
                )}
                onChange={(e) =>
                  uSeq({ rotation: clamp(Math.round(Number(e.target.value)), 0, 15) })
                }
              />
              <BoundedNumberInput
                className="input w-14 text-right"
                value={cell.sequencer.rotation}
                onChange={(v) => uSeq({ rotation: v })}
                min={0}
                max={Math.max(0, cell.sequencer.steps - 1)}
                integer
              />
            </>
          )}

          {cell.sequencer.mode === 'polyrhythm' && (
            <>
              <span className="label">Ring A</span>
              <input
                type="range"
                min={1}
                max={16}
                step={1}
                value={cell.sequencer.ringALength}
                onChange={(e) =>
                  uSeq({ ringALength: clamp(Math.round(Number(e.target.value)), 1, 16) })
                }
              />
              <BoundedNumberInput
                className="input w-14 text-right"
                value={cell.sequencer.ringALength}
                onChange={(v) => uSeq({ ringALength: v })}
                min={1}
                max={16}
                integer
              />

              <span className="label">Ring B</span>
              <input
                type="range"
                min={1}
                max={16}
                step={1}
                value={cell.sequencer.ringBLength}
                onChange={(e) =>
                  uSeq({ ringBLength: clamp(Math.round(Number(e.target.value)), 1, 16) })
                }
              />
              <BoundedNumberInput
                className="input w-14 text-right"
                value={cell.sequencer.ringBLength}
                onChange={(v) => uSeq({ ringBLength: v })}
                min={1}
                max={16}
                integer
              />

              <span className="label">Combine</span>
              <select
                className="input col-span-2"
                value={cell.sequencer.combine}
                onChange={(e) => uSeq({ combine: e.target.value as SeqCombine })}
                title="OR fires when either ring hits. XOR fires when exactly one hits (phasing feel). AND fires only at coincidence (sparse highlights)."
              >
                <option value="or">OR (either ring)</option>
                <option value="xor">XOR (one but not both)</option>
                <option value="and">AND (coincidence only)</option>
              </select>
            </>
          )}

          {cell.sequencer.mode === 'density' && (
            <>
              <span className="label">Density</span>
              <input
                type="range"
                min={0}
                max={100}
                step={1}
                value={cell.sequencer.density}
                onChange={(e) =>
                  uSeq({ density: clamp(Number(e.target.value), 0, 100) })
                }
              />
              <BoundedNumberInput
                className="input w-14 text-right"
                value={cell.sequencer.density}
                onChange={(v) => uSeq({ density: v })}
                min={0}
                max={100}
              />

              <span className="label">Seed</span>
              <input
                type="range"
                min={0}
                max={255}
                step={1}
                value={cell.sequencer.seed}
                onChange={(e) =>
                  uSeq({ seed: clamp(Math.round(Number(e.target.value)), 0, 255) })
                }
              />
              <BoundedNumberInput
                className="input w-14 text-right"
                value={cell.sequencer.seed}
                onChange={(v) => uSeq({ seed: v })}
                min={0}
                max={255}
                integer
              />
            </>
          )}

          {cell.sequencer.mode === 'cellular' && (
            <>
              <span className="label">Rule</span>
              <input
                type="range"
                min={0}
                max={255}
                step={1}
                value={cell.sequencer.rule}
                onChange={(e) =>
                  uSeq({ rule: clamp(Math.round(Number(e.target.value)), 0, 255) })
                }
                title="Wolfram rule (0-255). Try 30 (chaos), 90 (Sierpinski), 110 (gliders), 184 (traffic)."
              />
              <BoundedNumberInput
                className="input w-14 text-right"
                value={cell.sequencer.rule}
                onChange={(v) => uSeq({ rule: v })}
                min={0}
                max={255}
                integer
              />

              <span className="label">Seed</span>
              <CellularSeedSlider
                seed={cell.sequencer.cellSeed}
                lfoDepth={cell.sequencer.cellularSeedLfoDepth}
                lfoRate={cell.sequencer.cellularSeedLfoRate}
                onChange={(v) => uSeq({ cellSeed: v })}
              />

              <span className="label">Seed LFO</span>
              <input
                type="range"
                min={0}
                max={100}
                step={1}
                value={cell.sequencer.cellularSeedLfoDepth}
                onChange={(e) =>
                  uSeq({
                    cellularSeedLfoDepth: clamp(Number(e.target.value), 0, 100)
                  })
                }
                title="Depth of the Seed LFO (0 = off). When >0, the cellular row is re-seeded each cycle around the base Seed value, drifting the pattern over time."
              />
              <BoundedNumberInput
                className="input w-14 text-right"
                value={cell.sequencer.cellularSeedLfoDepth}
                onChange={(v) => uSeq({ cellularSeedLfoDepth: v })}
                min={0}
                max={100}
              />

              <span className="label">LFO Rate</span>
              <input
                type="range"
                min={0.01}
                max={10}
                step={0.01}
                value={cell.sequencer.cellularSeedLfoRate}
                onChange={(e) =>
                  uSeq({
                    cellularSeedLfoRate: clamp(Number(e.target.value), 0.01, 10)
                  })
                }
                title="LFO speed in Hz (0.01–10). 0.5 ≈ 2-second cycle, 2 ≈ 500-ms cycle."
              />
              <BoundedNumberInput
                className="input w-14 text-right"
                value={cell.sequencer.cellularSeedLfoRate}
                onChange={(v) => uSeq({ cellularSeedLfoRate: v })}
                min={0.01}
                max={10}
              />
            </>
          )}

          {cell.sequencer.mode === 'drift' && (
            <>
              <span className="label">Bias</span>
              <input
                type="range"
                min={-100}
                max={100}
                step={1}
                value={cell.sequencer.bias}
                onChange={(e) =>
                  uSeq({ bias: clamp(Number(e.target.value), -100, 100) })
                }
                title="-100% always backward, 0 pure random walk, +100% always forward."
              />
              <BoundedNumberInput
                className="input w-14 text-right"
                value={cell.sequencer.bias}
                onChange={(v) => uSeq({ bias: v })}
                min={-100}
                max={100}
              />

              <span className="label">Edge</span>
              <select
                className="input col-span-2"
                value={cell.sequencer.edge}
                onChange={(e) => uSeq({ edge: e.target.value as SeqDriftEdge })}
                title="Wrap loops the playhead around the row. Reflect bounces off the boundaries."
              >
                <option value="wrap">Wrap</option>
                <option value="reflect">Reflect</option>
              </select>
            </>
          )}

          {cell.sequencer.mode === 'ratchet' && (
            <>
              <span className="label">Probability</span>
              <input
                type="range"
                min={0}
                max={100}
                step={1}
                value={cell.sequencer.ratchetProb}
                onChange={(e) =>
                  uSeq({ ratchetProb: clamp(Number(e.target.value), 0, 100) })
                }
              />
              <BoundedNumberInput
                className="input w-14 text-right"
                value={cell.sequencer.ratchetProb}
                onChange={(v) => uSeq({ ratchetProb: v })}
                min={0}
                max={100}
              />

              <span className="label">Max Div.</span>
              <input
                type="range"
                min={2}
                max={16}
                step={1}
                value={cell.sequencer.ratchetMaxDiv}
                onChange={(e) =>
                  uSeq({
                    ratchetMaxDiv: clamp(
                      Math.round(Number(e.target.value)),
                      2,
                      16
                    )
                  })
                }
                title="Maximum subdivisions per ratchet hit (2–16). Always whole-number divisions — each burst fires 2..N evenly-spaced re-triggers within the step."
              />
              <BoundedNumberInput
                className="input w-14 text-right"
                value={cell.sequencer.ratchetMaxDiv}
                onChange={(v) => uSeq({ ratchetMaxDiv: Math.round(v) })}
                min={2}
                max={16}
                integer
              />

              <span className="label">Variation</span>
              <input
                type="range"
                min={0}
                max={100}
                step={1}
                value={cell.sequencer.ratchetVariation}
                onChange={(e) =>
                  uSeq({
                    ratchetVariation: clamp(Number(e.target.value), 0, 100)
                  })
                }
                title="0% = every step uses the same Probability + Max Div. 100% = each step's probability AND subdivision count are randomised (deterministic per seed) so the burst pattern varies across the cycle."
              />
              <BoundedNumberInput
                className="input w-14 text-right"
                value={cell.sequencer.ratchetVariation}
                onChange={(v) => uSeq({ ratchetVariation: v })}
                min={0}
                max={100}
              />

              <span className="label">Mode</span>
              <select
                className="input col-span-2"
                value={cell.sequencer.ratchetMode}
                onChange={(e) =>
                  uSeq({
                    ratchetMode: e.target.value as
                      | 'octaves'
                      | 'ramp'
                      | 'inverse'
                      | 'pingpong'
                      | 'echo'
                      | 'trill'
                      | 'random'
                  })
                }
                title={
                  'Octaves: every sub-pulse emits stepValue / subdiv (proportional scaling).\n' +
                  'Ramp: linear rise stepValue/subdiv → stepValue (snare-roll build).\n' +
                  'Inverse: mirror of Ramp — falls from stepValue to stepValue/subdiv.\n' +
                  'Pingpong: rises then falls inside the burst (triangle window).\n' +
                  'Echo: exponential decay ~0.7^i (palm-mute / ball-bounce).\n' +
                  'Trill: alternates stepValue / stepValue×0.5 (two-note ornament).\n' +
                  'Random: hash-driven scatter.'
                }
              >
                <option value="octaves">Octaves — value / subdiv</option>
                <option value="ramp">Ramp — rising values</option>
                <option value="inverse">Inverse — falling values</option>
                <option value="pingpong">Pingpong — rise + fall</option>
                <option value="echo">Echo — exp decay</option>
                <option value="trill">Trill — two-note flicker</option>
                <option value="random">Random — scattered</option>
              </select>
            </>
          )}

          {cell.sequencer.mode === 'bounce' && (
            <>
              <span className="label">Decay</span>
              <input
                type="range"
                min={0}
                max={100}
                step={1}
                value={cell.sequencer.bounceDecay}
                onChange={(e) =>
                  uSeq({ bounceDecay: clamp(Number(e.target.value), 0, 100) })
                }
                title="Bounciness — 0% = dead bounce (quick collapse, last bounces nearly back-to-back); 100% = super bouncy (intervals barely decay, sustained pulse train). Drives both timing and (in generative mode) value decay."
              />
              <BoundedNumberInput
                className="input w-14 text-right"
                value={cell.sequencer.bounceDecay}
                onChange={(v) => uSeq({ bounceDecay: v })}
                min={0}
                max={100}
              />
            </>
          )}

          {cell.sequencer.mode === 'draw' && (
            <>
              <span className="label">Resolution</span>
              <input
                type="range"
                min={4}
                max={1024}
                step={1}
                value={cell.sequencer.drawSteps}
                onChange={(e) =>
                  uSeq({
                    drawSteps: clamp(
                      Math.round(Number(e.target.value)),
                      4,
                      1024
                    )
                  })
                }
                title="Cells across the drawing canvas (4–1024). Higher = finer automation; past ~128 the curve reads as a continuous line."
              />
              <BoundedNumberInput
                className="input w-14 text-right"
                value={cell.sequencer.drawSteps}
                onChange={(v) => uSeq({ drawSteps: v })}
                min={4}
                max={1024}
                integer
              />

              {/* X Value (bottom of canvas) + Y Value (top of canvas)
                  — the output range the drawn 0..1 curve maps onto.
                  Default [0, 1] preserves classic behaviour; set to
                  [-1, 1] for bipolar, [0, 127] for MIDI, etc. */}
              <span className="label">X Value</span>
              <BoundedNumberInput
                className="input col-span-2 w-full text-right"
                value={cell.sequencer.drawValueMin}
                onChange={(v) => uSeq({ drawValueMin: v })}
                title="Output value at the bottom of the canvas (curve y=0). Default 0."
              />

              <span className="label">Y Value</span>
              <BoundedNumberInput
                className="input col-span-2 w-full text-right"
                value={cell.sequencer.drawValueMax}
                onChange={(v) => uSeq({ drawValueMax: v })}
                title="Output value at the top of the canvas (curve y=1). Default 1."
              />
            </>
          )}

          <span className="label">Mode</span>
          <select
            className="input col-span-2"
            value={cell.sequencer.syncMode}
            onChange={(e) => {
              const mode = e.target.value as SeqSyncMode
              if (mode === 'free') {
                uSeq({ syncMode: 'free', stepMs: Math.round(60000 / cell.sequencer.bpm) })
              } else if (mode === 'tempo') {
                uSeq({
                  syncMode: 'tempo',
                  bpm: clamp(Math.round(60000 / Math.max(1, cell.sequencer.stepMs)), 10, 500)
                })
              } else {
                // bpm — lock to session global BPM; clear per-clip tempo slider
                uSeq({ syncMode: 'bpm' })
              }
            }}
          >
            <option value="bpm">Sync (BPM)</option>
            <option value="tempo">Sync (Tempo)</option>
            <option value="free">Free (ms)</option>
          </select>

          {cell.sequencer.syncMode === 'bpm' ? (
            <>
              <span className="label">Source</span>
              <span className="text-muted text-[11px] col-span-2">
                Locked to session BPM.
              </span>
            </>
          ) : cell.sequencer.syncMode === 'tempo' ? (
            <>
              <span className="label">Tempo</span>
              {(() => {
                // Draw mode unlocks a higher tempo cap (1024 BPM) so
                // drawn-curve automation can run at very fast clock
                // rates. Other modes stay at the musical 500 cap.
                const bpmMax = cell.sequencer.mode === 'draw' ? 1024 : 500
                return (
                  <>
                    <input
                      type="range"
                      min={10}
                      max={bpmMax}
                      step={1}
                      value={Math.min(bpmMax, cell.sequencer.bpm)}
                      onChange={(e) =>
                        uSeq({ bpm: clamp(Number(e.target.value), 10, bpmMax) })
                      }
                    />
                    <BoundedNumberInput
                      className="input w-14 text-right"
                      value={cell.sequencer.bpm}
                      onChange={(v) => uSeq({ bpm: v })}
                      min={10}
                      max={bpmMax}
                      integer
                    />
                  </>
                )
              })()}
            </>
          ) : (
            <>
              <span className="label">MS</span>
              {/* Piecewise-linear mapping: left half = 10–1000 ms
                  (the musically useful range), right half = 1000–
                  60000 ms. Slider position 0..1000 → ms 10..60000. */}
              <input
                type="range"
                min={0}
                max={1000}
                step={1}
                value={stepMsToSlider(cell.sequencer.stepMs)}
                onChange={(e) =>
                  uSeq({ stepMs: sliderToStepMs(Number(e.target.value)) })
                }
                title={`${cell.sequencer.stepMs} ms — slider midpoint = 1000 ms`}
              />
              <BoundedNumberInput
                className="input w-16 text-right"
                value={cell.sequencer.stepMs}
                onChange={(v) => uSeq({ stepMs: v })}
                min={1}
                max={60000}
                integer
              />
            </>
          )}
        </div>

        {cell.sequencer.mode === 'euclidean' && (
          <EuclideanPreview
            steps={cell.sequencer.steps}
            pulses={cell.sequencer.pulses}
            rotation={cell.sequencer.rotation}
            currentStep={
              cell.sequencer.enabled && currentStep !== undefined ? currentStep : -1
            }
          />
        )}
        {cell.sequencer.mode === 'polyrhythm' && (
          <PolyrhythmPreview
            steps={cell.sequencer.steps}
            ringALength={cell.sequencer.ringALength}
            ringBLength={cell.sequencer.ringBLength}
            combine={cell.sequencer.combine}
            currentStep={
              cell.sequencer.enabled && currentStep !== undefined ? currentStep : -1
            }
          />
        )}
        {cell.sequencer.mode === 'density' && (
          <DensityPreview
            steps={cell.sequencer.steps}
            seed={cell.sequencer.seed}
            density={cell.sequencer.density}
            currentStep={
              cell.sequencer.enabled && currentStep !== undefined ? currentStep : -1
            }
          />
        )}
        {cell.sequencer.mode === 'cellular' && (
          <CellularPreview
            steps={cell.sequencer.steps}
            rule={cell.sequencer.rule}
            cellSeed={cell.sequencer.cellSeed}
            seedLfoDepth={cell.sequencer.cellularSeedLfoDepth}
            seedLfoRate={cell.sequencer.cellularSeedLfoRate}
            currentStep={
              cell.sequencer.enabled && currentStep !== undefined ? currentStep : -1
            }
          />
        )}
        {cell.sequencer.mode === 'drift' && (
          <DriftPreview
            steps={cell.sequencer.steps}
            currentStep={
              cell.sequencer.enabled && currentStep !== undefined ? currentStep : -1
            }
          />
        )}
        {cell.sequencer.mode === 'ratchet' && (
          <RatchetPreview
            steps={cell.sequencer.steps}
            ratchetProb={cell.sequencer.ratchetProb}
            ratchetMaxDiv={cell.sequencer.ratchetMaxDiv}
            ratchetVariation={cell.sequencer.ratchetVariation}
            seed={cell.sequencer.seed}
            currentStep={
              cell.sequencer.enabled && currentStep !== undefined ? currentStep : -1
            }
          />
        )}
        {cell.sequencer.mode === 'bounce' && (
          <BouncePreview
            cell={cell}
            currentStep={
              cell.sequencer.enabled && currentStep !== undefined ? currentStep : -1
            }
          />
        )}
        {cell.sequencer.mode === 'draw' && (
          <DrawCanvas
            values={cell.sequencer.drawValues}
            drawSteps={cell.sequencer.drawSteps}
            drawValueMin={cell.sequencer.drawValueMin}
            drawValueMax={cell.sequencer.drawValueMax}
            currentStep={
              cell.sequencer.enabled && currentStep !== undefined ? currentStep : -1
            }
            generative={cell.sequencer.generative}
            genAmount={cell.sequencer.genAmount}
            seed={cell.sequencer.seed}
            onChange={(next) => uSeq({ drawValues: next })}
          />
        )}

        {cell.sequencer.mode !== 'draw' && (
        <div className="mt-1 flex flex-col gap-0.5">
          <div className="label">
            {cell.sequencer.generative
              ? `Live values (1…${cell.sequencer.steps}) — generated from the seed`
              : cell.sequencer.mode === 'euclidean'
                ? `Step values (1…${cell.sequencer.steps}) — hits emit, misses skip`
                : `Step values (1…${cell.sequencer.steps})`}
          </div>
          {cell.sequencer.generative ? (
            <GenerativeStepPreview
              steps={cell.sequencer.steps}
              cell={cell}
              currentStep={
                cell.sequencer.enabled && currentStep !== undefined ? currentStep : -1
              }
            />
          ) : (
            <div className="grid grid-cols-4 gap-1">
              {Array.from({ length: cell.sequencer.steps }, (_, i) => (
                <StepInput
                  key={i}
                  index={i}
                  active={currentStep === i && cell.sequencer.enabled}
                  muted={isStepGateMuted(cell.sequencer, i)}
                  value={cell.sequencer.stepValues[i] ?? ''}
                  onChange={(v) => {
                    // Read fresh state from the store inside the
                    // callback instead of spreading `cell.sequencer`
                    // captured at render time. Two rapid keystrokes
                    // across a re-render boundary would otherwise
                    // race and the second write would clobber the
                    // first using stale stepValues.
                    const fresh = useStore.getState()
                    const cur = fresh.session.scenes
                      .find((s) => s.id === sel.sceneId)
                      ?.cells[sel.trackId]
                    if (!cur) return
                    const next = [...cur.sequencer.stepValues]
                    next[i] = v
                    updateCell(sel.sceneId, sel.trackId, {
                      sequencer: { ...cur.sequencer, stepValues: next }
                    })
                  }}
                />
              ))}
            </div>
          )}
          <div className="text-[10px] text-muted">
            {cell.sequencer.generative
              ? genHelpText(cell.sequencer.mode)
              : cell.sequencer.mode === 'euclidean'
                ? 'Euclidean: active ("hit") steps emit their value; inactive steps emit nothing (receiver holds last value). With Modulation also on, the modulator affects hit values only.'
                : cell.sequencer.mode === 'polyrhythm'
                  ? 'Polyrhythm: two ring clocks fire at multiples of their length within the cycle. Combined gate decides which steps emit; misses hold last value.'
                  : cell.sequencer.mode === 'density'
                    ? 'Density: each step has its own personality from the Seed. The Density knob shapes the curve from silence to constant.'
                    : cell.sequencer.mode === 'cellular'
                      ? 'Cellular: the row evolves at every full cycle via the Wolfram rule. Active bits emit; inactive bits hold. Try rules 30, 90, 110.'
                      : cell.sequencer.mode === 'drift'
                        ? 'Drift: every clock the playhead steps +1 / 0 / -1 weighted by Bias, then plays that step\'s value. Edge controls boundary behaviour.'
                        : cell.sequencer.mode === 'ratchet'
                          ? 'Ratchet: each step has a chance of bursting into 2..N quick re-triggers. Most audible on string / bool / int OSC targets that re-fire on each send.'
                          : cell.sequencer.mode === 'bounce'
                            ? 'Bounce: cycles physically — each cycle is one drop, with step 0 the loud first impact and subsequent bounces accelerating + decaying. Decay sets the bounciness.'
                            : 'Auto-detect per step (bool / int / float / string). With Modulation also on, the LFO oscillates around the current step value.'}
          </div>
        </div>
        )}

        {/* Behaviour — controls what the engine emits between value
            changes. 'Last' re-sends the same value every tick (a
            continuous stream); 'Hold' sends nothing until the value
            changes, so the receiver naturally holds its previous
            value. Tight row at the bottom of the section — the
            mt-1/pt-1 keeps the whole section short enough to clear
            the inspector viewport for the bigger modes (Cellular's
            3-row preview etc.) without scrolling. */}
        <div className="mt-1 grid grid-cols-[auto_1fr] gap-x-2 items-center pt-1 border-t border-border/40">
          <span className="label">Behaviour</span>
          <select
            className="input text-[11px] py-0.5"
            value={cell.sequencer.restBehaviour}
            onChange={(e) =>
              uSeq({
                restBehaviour: e.target.value === 'hold' ? 'hold' : 'last'
              })
            }
            title={
              cell.sequencer.restBehaviour === 'hold'
                ? 'Hold — engine sends only when the value changes; receivers naturally hold their previous value (no redundant OSC, no re-triggers).'
                : 'Last — engine re-sends the same value every tick so receivers always have a fresh sample to act on (continuous stream).'
            }
          >
            <option value="last">Last — re-send same value</option>
            <option value="hold">Hold — send only on change</option>
          </select>
        </div>
      </CollapsibleSection>

      {/* Routing matrix — per-slot gates for the Modulator and
          Sequencer. Default state (all checked) reproduces the
          legacy behavior. Unchecking a cell prevents that direction
          from touching the slot, which then emits its cell.value
          seed. Pin still beats both (argSpec.fixed beats Pin). */}
      <CellRoutingSection cell={c} track={track} onChange={u} />
    </div>
  )
}

// Modulation sub-editors. Both receive the current Cell and the update helper
// so they can build partial patches against `cell.modulation`.
type CellUpdate = (patch: Partial<import('@shared/types').Cell>) => void

// ─────────────────────────────────────────────────────────────────
// Mod 2 section — second-stage modulator.
//
// Renders the same Type picker + sub-editors as Mod 1 by passing a
// "Mod 2 view" of the cell down: the sub-editors read `cell.modulation`
// and write `u({ modulation: ... })`, so we present them a cell whose
// `modulation` field IS cell.modulation2, and a `u` that re-routes
// `modulation` patches to `modulation2`. The sub-editors don't know
// they're editing the second stage — that's the trick.
//
// On top of the existing modulator UI, this section adds:
//   - A Targets sub-block: math-mode dropdown + 3 enable checkboxes +
//     3 amount knobs (Rate / Depth / context-aware Shape). The Shape
//     label is taken from Mod 1's type — "Shape" for LFO, "Distribution"
//     for S&H / Random, "Chaos" for Attractor, etc.
// ─────────────────────────────────────────────────────────────────
function Mod2Section({
  cell,
  u
}: {
  cell: import('@shared/types').Cell
  u: CellUpdate
}): JSX.Element {
  const m2 = cell.modulation2 ?? { ...DEFAULT_MODULATION2, enabled: false }
  // Translate updates: any patch whose key is `modulation` should
  // actually write `modulation2`. Other keys pass through untouched.
  const u2: CellUpdate = (patch) => {
    const { modulation, ...rest } = patch
    const next: Partial<import('@shared/types').Cell> = { ...rest }
    if (modulation !== undefined) next.modulation2 = modulation
    u(next)
  }
  // Mod 2 view of the cell — the sub-editor reads `modulation` so we
  // shove modulation2 into that slot. cell-level fields (value, etc.)
  // are unchanged.
  const m2Cell: Cell = { ...cell, modulation: m2 }
  // Patch helper for the Targets sub-block — keeps `targets` rooted
  // on modulation2 so the engine reads them from the right place.
  function patchTargets(
    branch: 'rate' | 'depth' | 'shape',
    next: { enabled?: boolean; amount?: number }
  ): void {
    const cur = m2.targets ?? {}
    const prev = cur[branch] ?? { enabled: false, amount: 0 }
    u({
      modulation2: {
        ...m2,
        targets: {
          ...cur,
          [branch]: { ...prev, ...next }
        }
      }
    })
  }
  // Companion of `patchTargets` for the Mod 2 -> Sequencer routing.
  // Writes into `modulation2.targetsSeq` (parallel to `targets`).
  function patchTargetsSeq(
    branch: 'rate' | 'depth' | 'shape',
    next: { enabled?: boolean; amount?: number }
  ): void {
    const cur = m2.targetsSeq ?? {}
    const prev = cur[branch] ?? { enabled: false, amount: 0 }
    u({
      modulation2: {
        ...m2,
        targetsSeq: {
          ...cur,
          [branch]: { ...prev, ...next }
        }
      }
    })
  }
  function patchTargetMode(mode: ModulationTargetMode): void {
    u({ modulation2: { ...m2, targetMode: mode } })
  }
  // Context-aware label for the third target. Reads Modulation 1's
  // current type so the label changes live as the user switches
  // Modulation 1's type. Each label names the ACTUAL knob being
  // modulated on Mod 1, prefixed with the Mod 1 type so the user can
  // tell at a glance which underlying param is being driven —
  // e.g. "LFO · Shape" makes it obvious that this is Mod 1's LFO
  // shape, NOT Mod 2's own Shape dropdown a few rows above.
  function shapeLabelForMod1(): { label: string; tooltip: string; usable: boolean } {
    switch (cell.modulation.type) {
      case 'lfo':
        return {
          label: 'LFO · Shape',
          tooltip:
            "Sweep Modulation 1's LFO shape (sine → triangle → square → sawtooth → rndStep → rndSmooth → spastic) as Modulation 2 swings.",
          usable: true
        }
      case 'sh':
        return {
          label: 'S&H · Distribution',
          tooltip:
            "Sweep Modulation 1's Sample & Hold distribution (centre-hug ↔ uniform ↔ edge-weight) as Modulation 2 swings.",
          usable: true
        }
      case 'attractor':
        return {
          label: 'Attractor · Chaos',
          tooltip:
            "Sweep Modulation 1's Strange Attractor chaos knob as Modulation 2 swings.",
          usable: true
        }
      case 'chaos':
        return {
          label: 'Chaos · r',
          tooltip:
            "Sweep Modulation 1's logistic-map r parameter (3.4..4.0) as Modulation 2 swings.",
          usable: true
        }
      case 'random':
        return {
          label: 'Random · Distribution',
          tooltip:
            "Sweep Modulation 1's Random Generator distribution warp as Modulation 2 swings.",
          usable: true
        }
      case 'slew':
        return {
          label: 'Slew · Rise/Fall',
          tooltip:
            "Stretch / compress Modulation 1's Slew rise + fall times symmetrically as Modulation 2 swings.",
          usable: true
        }
      case 'envelope':
        return {
          label: 'Envelope · Sustain',
          tooltip:
            "Sweep Modulation 1's Envelope Sustain Level (0..1) as Modulation 2 swings. Multiplicative around the base; ±100 % amount fully drains or doubles the held level.",
          usable: true
        }
      case 'ramp':
        return {
          label: 'Ramp · Curve',
          tooltip:
            "Sweep Modulation 1's Ramp Curve (-100..+100, signed) as Modulation 2 swings. Additive: ±100 × amount around the base, so negative pulls toward ease-in, positive toward ease-out.",
          usable: true
        }
      case 'arpeggiator':
        return {
          label: 'Arpeggiator · Mode',
          tooltip:
            "Cycle Modulation 1's Arpeggiator Mode (up → down → upDown → downUp → exclusion → walk → drunk → random) as Modulation 2 swings. Mode picks happen at the eval rate — keep amount low if the resulting pattern jitter is too busy.",
          usable: true
        }
      case 'gesture':
        return {
          label: 'Gesture · Wiggle',
          tooltip:
            "Sweep Modulation 1's Gesture Wiggle (0..100 %) as Modulation 2 swings. 0 = smooth playhead, 100 = playhead jitters back and forth between adjacent recorded points.",
          usable: true
        }
      default:
        return {
          label: 'Shape',
          tooltip:
            'No continuous shape parameter on this Modulation 1 type - Shape target is a no-op.',
          usable: false
        }
    }
  }
  // Sequencer-side Shape label is mode-aware. Each seq mode has a
  // single parameter that most strongly defines its musical
  // personality (rotation for euclidean, seed for density, rule for
  // cellular, ringALength for polyrhythm, etc). Modes without a
  // dominant single knob ('steps', 'draw', 'adresse') grey out the
  // row so the user sees the option exists but can't enable a
  // no-op.
  function shapeLabelForSeq(): { label: string; tooltip: string; usable: boolean } {
    const seqMode = cell.sequencer?.mode ?? 'steps'
    switch (seqMode) {
      case 'euclidean':
        return {
          label: 'Euclidean - Rotation',
          tooltip:
            "Sweep the sequencer's Euclidean rotation (which step the pattern starts on) as Modulation 2 swings. Up to +/- the full step count at 100 % amount.",
          usable: true
        }
      case 'density':
        return {
          label: 'Density - Seed',
          tooltip:
            "Sweep the sequencer's density seed as Modulation 2 swings. Tiny offsets give micro-variations; big offsets give wholly different hit patterns.",
          usable: true
        }
      case 'cellular':
        return {
          label: 'Cellular - Rule',
          tooltip:
            "Sweep the Wolfram rule (0..255) as Modulation 2 swings. Each rule produces a totally different evolving pattern - this is a STRONG target, keep amount low for musical use.",
          usable: true
        }
      case 'polyrhythm':
        return {
          label: 'Polyrhythm - Ring A Length',
          tooltip:
            "Sweep the polyrhythm's first ring length as Modulation 2 swings. Cross-rhythm density breathes in and out.",
          usable: true
        }
      case 'drift':
        return {
          label: 'Drift - Bias',
          tooltip:
            "Sweep the random walker's directional bias (-100..+100) as Modulation 2 swings. Pull the walk toward one end of the step range.",
          usable: true
        }
      case 'ratchet':
        return {
          label: 'Ratchet - Probability',
          tooltip:
            "Sweep the per-step ratchet probability (0..100 %) as Modulation 2 swings. Bursts breathe in and out.",
          usable: true
        }
      case 'bounce':
        return {
          label: 'Bounce - Decay',
          tooltip:
            "Sweep the bounce decay (0..100) as Modulation 2 swings. Long bounces taper to short bounces and back.",
          usable: true
        }
      default:
        return {
          label: 'Shape',
          tooltip:
            'No dominant generative knob on this sequencer mode (steps / draw / address) - Shape target is a no-op.',
          usable: false
        }
    }
  }
  const shapeMeta = shapeLabelForMod1()
  const shapeMetaSeq = shapeLabelForSeq()
  return (
    <CollapsibleSection
      title="Modulation 2"
      titleTooltip={
        "Second-stage modulator. Its bipolar output modulates Modulation 1's\n" +
        'Rate, Depth, and a context-aware third parameter (called\n' +
        '"Shape" here — actually LFO shape morph, S&H distribution,\n' +
        "Attractor chaos, etc., depending on Modulation 1's type).\n\n" +
        "Modulation 1's stored values aren't mutated — each tick the engine\n" +
        'builds an "effective Modulation 1" from Modulation 2\'s signal +\n' +
        'the targets below.\n\n' +
        'Types: LFO, S&H, Slew, Chaos, Strange Attractor work as\n' +
        "second-stage signals. Envelope, Ramp, Arp, Random are not\n" +
        "available — they're note/time-targeted, not continuous."
      }
      enabled={m2.enabled}
      onToggle={(v) => u({ modulation2: { ...m2, enabled: v } })}
      headerRight={
        m2.enabled ? (
          <select
            className="input text-[11px] py-0.5"
            style={{ width: 148 }}
            value={m2.type}
            onChange={(e) => {
              const nextType = e.target.value as ModType
              u({ modulation2: { ...m2, type: nextType } })
            }}
            onClick={(e) => e.stopPropagation()}
            title="Modulation 2 type. Continuous types breathe; Ramp gives a one-shot evolve-then-hold; Arpeggiator walks Modulation 1 through quantised steps."
          >
            <option value="lfo">LFO</option>
            <option value="sh">Sample &amp; Hold</option>
            <option value="slew">Slew</option>
            <option value="chaos">Chaos</option>
            <option value="attractor">Strange Attractor</option>
            <option value="envelope">Envelope</option>
            <option value="random">Random</option>
            <option value="ramp">Ramp</option>
            <option value="arpeggiator">Arpeggiator</option>
          </select>
        ) : null
      }
    >
      {/* Modulator sub-editor — same components Mod 1 uses, pointed
          at modulation2 via the u2/m2Cell translation above. The
          isMod2 prop suppresses the "live effective Mod 1" overlay
          inside these editors — they're editing Mod 2 itself, not
          watching Mod 1 animate. */}
      {m2.type === 'lfo' ? (
        <LfoEditor cell={m2Cell} u={u2} isMod2 />
      ) : m2.type === 'sh' ? (
        <SampleHoldEditor cell={m2Cell} u={u2} isMod2 />
      ) : m2.type === 'slew' ? (
        <SlewEditor cell={m2Cell} u={u2} isMod2 />
      ) : m2.type === 'chaos' ? (
        <ChaosEditor cell={m2Cell} u={u2} isMod2 />
      ) : m2.type === 'attractor' ? (
        <AttractorEditor cell={m2Cell} u={u2} isMod2 />
      ) : m2.type === 'envelope' ? (
        <EnvelopeEditor cell={m2Cell} u={u2} isMod2 />
      ) : m2.type === 'random' ? (
        <RandomEditor cell={m2Cell} u={u2} isMod2 />
      ) : m2.type === 'ramp' ? (
        <RampEditor cell={m2Cell} u={u2} isMod2 />
      ) : m2.type === 'arpeggiator' ? (
        <ArpEditor cell={m2Cell} u={u2} isMod2 />
      ) : (
        <div className="text-[11px] text-muted italic">
          This modulator type isn&apos;t supported as a second stage.
        </div>
      )}

      {/* ── Targets sub-block (Mod 2 -> Mod 1) ────────────────────── */}
      <Mod2TargetsBlock
        title="Mod 1 Targets"
        titleTooltip={
          "How Modulation 2 modulates Modulation 1's targets:\n\n" +
          'Multiplicative - base x (1 + mod2 x amount). Smooth, musical, works for everything.\n' +
          'Additive       - base + mod2 x range x amount. Fixed-range swing, easier to predict.\n' +
          'Mix            - rate + depth multiplicative; shape additive.'
        }
        targets={m2.targets}
        onPatchTarget={patchTargets}
        rateLabel="Rate"
        rateTooltip="Modulate Modulation 1's Rate (LFO Hz / clock division)."
        depthLabel="Depth"
        depthTooltip="Modulate Modulation 1's Depth (0..100 %)."
        shapeLabel={shapeMeta.label}
        shapeTooltip={shapeMeta.tooltip}
        shapeUsable={shapeMeta.usable}
        modeSelector={
          <select
            // Auto-width so the select shrinks to its widest entry
            // ("Multiplicative") plus the native dropdown arrow.
            className="input text-[10px] py-0.5 w-auto"
            style={{ width: 'fit-content' }}
            value={m2.targetMode ?? 'multiplicative'}
            onChange={(e) =>
              patchTargetMode(e.target.value as ModulationTargetMode)
            }
            title="Math mode for Modulation 2 -> Modulation 1 application (also applies to Sequencer targets below)"
          >
            <option value="multiplicative">Multiplicative</option>
            <option value="additive">Additive</option>
            <option value="mix">Mix</option>
          </select>
        }
      />
      {/* ── Sequencer Targets sub-block (Mod 2 -> Sequencer) ──────── */}
      {/* Parallel branch -- modulates the cell's sequencer params
          (bpm, per-mode shape key, genAmount). Same math mode as
          the Mod 1 block above (single source of truth). Shape
          label is reactive to cell.sequencer.mode so the user
          sees, e.g., "Cellular - Rule" or "Euclidean - Rotation"
          depending on the current sequencer mode. */}
      <Mod2TargetsBlock
        title="Seq Targets"
        titleTooltip={
          'How Modulation 2 modulates the cell\'s Sequencer params:\n\n' +
          'Rate  -> bpm (or stepMs when syncMode = free).\n' +
          'Shape -> per-mode "personality" knob (Rotation for Euclidean, Seed for Density, Rule for Cellular, etc).\n' +
          "Depth -> genAmount (the Generative wildness slider). Modulate this for breathing 'calm <-> chaotic' generative variations.\n\n" +
          "Math mode is shared with the Mod 1 block above. Targets off by default -- the user opts in per branch."
        }
        targets={m2.targetsSeq}
        onPatchTarget={patchTargetsSeq}
        rateLabel="Rate"
        rateTooltip="Modulate the sequencer's tempo (bpm or stepMs)."
        depthLabel="Depth"
        depthTooltip="Modulate the sequencer's Generative wildness (genAmount, 0..100 %)."
        shapeLabel={shapeMetaSeq.label}
        shapeTooltip={shapeMetaSeq.tooltip}
        shapeUsable={shapeMetaSeq.usable}
        modeSelector={null}
      />
    </CollapsibleSection>
  )
}

// Generic 3-row Rate / Depth / Shape target block. Used twice in
// the Mod 2 section: once for "Mod 2 -> Mod 1" (header "Targets")
// and once for "Mod 2 -> Sequencer" (header "Seq Targets"). The
// math-mode dropdown is rendered ONLY in the Mod 1 block since both
// blocks share the same `targetMode` on the Modulation object.
function Mod2TargetsBlock({
  title,
  titleTooltip,
  targets,
  onPatchTarget,
  rateLabel,
  rateTooltip,
  depthLabel,
  depthTooltip,
  shapeLabel,
  shapeTooltip,
  shapeUsable,
  modeSelector
}: {
  title: string
  titleTooltip: string
  targets: ModulationTargets | undefined
  onPatchTarget: (
    branch: 'rate' | 'depth' | 'shape',
    next: { enabled?: boolean; amount?: number }
  ) => void
  rateLabel: string
  rateTooltip: string
  depthLabel: string
  depthTooltip: string
  shapeLabel: string
  shapeTooltip: string
  // When the target's underlying parameter doesn't exist on the
  // current Mod 1 type / Sequencer mode, the third target row greys
  // out and the engine is a no-op. The UI signals "this branch is
  // dead for now" without hiding the row entirely.
  shapeUsable: boolean
  // Optional math-mode dropdown rendered inline with the header.
  // The Mod 1 block owns the dropdown (it controls both blocks'
  // math); the Seq block passes null so its header is just text.
  modeSelector?: JSX.Element | null
}): JSX.Element {
  const rate = targets?.rate ?? { enabled: false, amount: 0 }
  const depth = targets?.depth ?? { enabled: false, amount: 0 }
  const shape = targets?.shape ?? { enabled: false, amount: 0 }
  return (
    <div className="flex flex-col gap-2 pt-2 border-t border-border mt-1">
      <div className="flex items-center gap-2">
        <span className="label" title={titleTooltip}>
          {title}
        </span>
        {modeSelector}
      </div>
      <Mod2TargetRow
        label={rateLabel}
        tooltip={rateTooltip}
        enabled={rate.enabled}
        amount={rate.amount}
        onToggle={(v) => onPatchTarget('rate', { enabled: v })}
        onAmount={(v) => onPatchTarget('rate', { amount: v })}
      />
      <Mod2TargetRow
        label={depthLabel}
        tooltip={depthTooltip}
        enabled={depth.enabled}
        amount={depth.amount}
        onToggle={(v) => onPatchTarget('depth', { enabled: v })}
        onAmount={(v) => onPatchTarget('depth', { amount: v })}
      />
      <Mod2TargetRow
        label={shapeLabel}
        tooltip={shapeTooltip}
        enabled={shape.enabled}
        amount={shape.amount}
        onToggle={(v) => onPatchTarget('shape', { enabled: v })}
        onAmount={(v) => onPatchTarget('shape', { amount: v })}
        disabled={!shapeUsable}
      />
    </div>
  )
}

function Mod2TargetRow({
  label,
  tooltip,
  enabled,
  amount,
  onToggle,
  onAmount,
  disabled
}: {
  label: string
  tooltip: string
  enabled: boolean
  amount: number
  onToggle: (v: boolean) => void
  onAmount: (v: number) => void
  // When `disabled` is true (e.g. Shape row while Mod 1 = Envelope),
  // the entire row greys out and the checkbox + knob + input
  // pre-empt the user's clicks. The engine ignores this target's
  // amount when disabled anyway, but we want the UI to read
  // unambiguously inert.
  disabled?: boolean
}): JSX.Element {
  return (
    <div
      className={`flex items-center gap-2 text-[11px] ${disabled ? 'opacity-50' : ''}`}
      title={tooltip}
    >
      <label className="flex items-center gap-1 cursor-pointer select-none w-32 shrink-0">
        <input
          type="checkbox"
          checked={enabled}
          onChange={(e) => onToggle(e.target.checked)}
          disabled={disabled}
        />
        <span className={enabled && !disabled ? '' : 'text-muted'}>{label}</span>
      </label>
      <RoutingMiniKnob
        value={amount}
        onChange={(v) => {
          if (disabled) return
          onAmount(v)
        }}
        title={`${label} amount — drag vertically, dbl-click resets to 0`}
      />
      {/* Narrow number entry sized to fit the widest legal value
          ("100.00") plus a hair for padding. Previous flex-1 stole
          the rest of the row width, which the user didn't want. */}
      <BoundedNumberInput
        className="input w-14 text-center tabular-nums px-1 py-0 text-[11px] leading-tight"
        value={amount}
        onChange={(v) => {
          if (disabled) return
          onAmount(v)
        }}
        min={0}
        max={100}
        step={0.01}
        disabled={disabled}
        title="Amount (0..100 %) — how strongly Modulation 2 affects this target"
      />
      <span className="text-[10px] text-muted">%</span>
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────
// GestureEditor — Modulator sub-editor for the Gesture modulator type.
//
// Renders the modulator's standard Depth + Mode (uni/bi) + Rate +
// Sync controls (via CompactDepthMode + CompactRateControls so live
// overlay from Mod 2 applies), then a CENTERED GestureRecorder
// canvas + Output dropdown (XY / merged) + a Wiggle slider (0..100).
//
// Wiggle is the third "Shape" target Mod 2 can sweep (label flips
// to "Wiggle" when Mod 1 is Gesture). Rate is the standard modulator
// rate — Mod 2's Rate target patches rateHz normally, so Gesture
// inherits Rate-sweeping for free.
//
// `isMod2` suppresses the live overlay (same convention as the
// other modulator editors).
// ─────────────────────────────────────────────────────────────────
function GestureEditor({
  cell,
  u,
  isMod2
}: {
  cell: Cell
  u: CellUpdate
  isMod2?: boolean
}): JSX.Element {
  const m = cell.modulation
  const gp = m.gesture ?? { points: [], mode: 'xy' as GestureMode, wiggle: 0 }
  function uMod(patch: Partial<typeof m>): void {
    u({ modulation: { ...m, ...patch } })
  }
  function uGesture(patch: Partial<typeof gp>): void {
    u({ modulation: { ...m, gesture: { ...gp, ...patch } } })
  }
  // Live store — used for BOTH the playhead dot (which animates any
  // time the cell is armed and Mod 1 is gesture, regardless of
  // Mod 2) AND the Wiggle overlay tint (which should only orange-
  // out when Mod 2 is actually driving Wiggle).
  const liveStore = useStore((s) => s.mod1Live)
  // Playhead reads from the always-flowing live stream — gated only
  // on isMod2 (Mod 2's own gesture playback isn't surfaced via
  // mod1Live, so the dot is meaningless there). Independent of
  // whether Mod 2 is enabled on the cell.
  const livePlayheadSrc = isMod2 ? null : liveStore
  const livePlayheadX = livePlayheadSrc?.gesturePlayheadX
  const livePlayheadY = livePlayheadSrc?.gesturePlayheadY
  const hasPlayhead =
    livePlayheadSrc !== null &&
    gp.points.length > 1 &&
    livePlayheadX !== undefined &&
    livePlayheadY !== undefined
  // Memoised so the child <GestureRecorder> sees a STABLE object
  // reference unless the numeric coords actually changed — keeps a
  // future React.memo on the recorder useful, and prevents fresh
  // allocations on every Inspector render (which fires whenever
  // ANY of the parent's many useStore subscribers ticks).
  const livePlayhead = useMemo<{ x: number; y: number } | undefined>(() => {
    if (!hasPlayhead) return undefined
    return {
      x: Math.max(0, Math.min(1, livePlayheadX as number)),
      y: Math.max(0, Math.min(1, livePlayheadY as number))
    }
  }, [hasPlayhead, livePlayheadX, livePlayheadY])
  // Wiggle overlay — only tints orange when Mod 2 is enabled AND
  // could actually be modulating wiggle. Same gate the other
  // editors use.
  const liveOverlay =
    isMod2 || cell.modulation2?.enabled !== true ? null : liveStore
  const liveWiggle = liveOverlay?.gestureWiggle
  return (
    <div className="grid grid-cols-[64px_minmax(0,1fr)_88px] gap-x-2 gap-y-1 items-center">
      <CompactDepthMode
        m={m}
        uMod={uMod}
        isMod2={isMod2}
        mod2Enabled={cell.modulation2?.enabled}
      />
      <CompactRateControls
        m={m}
        uMod={uMod}
        isMod2={isMod2}
        mod2Enabled={cell.modulation2?.enabled}
      />

      {/* Centred XY canvas spanning all 3 grid columns. */}
      <div className="col-span-3 flex justify-center pt-1">
        <GestureRecorder
          points={gp.points}
          onChange={(next) => uGesture({ points: next })}
          livePlayhead={livePlayhead}
        />
      </div>

      <span className="label">Output</span>
      <select
        className="input text-[11px] py-0.5 min-w-0 col-span-2"
        value={gp.mode}
        onChange={(e) => uGesture({ mode: e.target.value as GestureMode })}
        title={
          'XY: X → slot 0, Y → slot 1 (slots ≥ 2 read X).\n' +
          'Merged: combine X + Y into a single radial value √(x² + y²) / √2, broadcast to every slot.'
        }
      >
        <option value="xy">XY — X → slot 0, Y → slot 1</option>
        <option value="merged">Merged — √(x² + y²) → all slots</option>
      </select>

      <span className="label">Play</span>
      <select
        className="input text-[11px] py-0.5 min-w-0 col-span-2"
        value={gp.playMode ?? 'forward'}
        onChange={(e) =>
          uGesture({ playMode: e.target.value as GesturePlayMode })
        }
        title={
          'Forward: 0 → 1 each loop (recorded direction).\n' +
          'Backward: 1 → 0 each loop (reverse).\n' +
          'Ping-Pong: 0 → 1 → 0 each loop (triangle). Covers twice as much ground at the same Rate.'
        }
      >
        <option value="forward">Forward</option>
        <option value="backward">Backward</option>
        <option value="pingpong">Ping-Pong</option>
      </select>

      <span className="label">Wiggle</span>
      <input
        type="range"
        min={0}
        max={100}
        step={1}
        value={Math.round(liveWiggle ?? gp.wiggle)}
        onChange={(e) =>
          uGesture({ wiggle: clamp(Number(e.target.value), 0, 100) })
        }
        className={liveWiggle !== undefined ? 'live-overlay' : ''}
        title="0 % = smooth advance through the curve · 100 % = playhead jitters back and forth between adjacent points (sinusoidal at ~5× the loop rate)."
      />
      <div className="flex items-center gap-1 justify-end">
        <BoundedNumberInput
          className={`input w-14 text-right ${liveWiggle !== undefined ? 'live-overlay' : ''}`}
          integer={liveWiggle === undefined}
          min={0}
          max={100}
          value={
            liveWiggle !== undefined
              ? Math.round(liveWiggle * 10) / 10
              : gp.wiggle
          }
          onChange={(v) => uGesture({ wiggle: v })}
          title={
            liveWiggle !== undefined
              ? `Live: ${liveWiggle.toFixed(1)} · Base: ${gp.wiggle}`
              : undefined
          }
        />
        <span className="text-muted text-[11px] w-5 shrink-0">%</span>
      </div>

      <div className="col-span-3 text-[10px] text-muted italic leading-snug">
        {gp.points.length === 0
          ? 'Empty gesture — modulator emits a quiet 0.5 centre value until you record. Drag inside the square above to capture an X / Y path.'
          : gp.mode === 'xy'
            ? `${gp.points.length} points · multi-arg cells: slot 0 ← X, slot 1 ← Y, slots ≥ 2 ← X. Rate sets the loop speed.`
            : `${gp.points.length} points · √(x² + y²) / √2 broadcast to every slot. Rate sets the loop speed.`}
      </div>
    </div>
  )
}

function LfoEditor({
  cell,
  u,
  isMod2
}: {
  cell: import('@shared/types').Cell
  u: CellUpdate
  // When this editor is rendered inside the Mod 2 section, it's
  // editing Modulation 2 itself — so the live overlay (which only
  // makes sense for Modulation 1, the one being modulated) is
  // suppressed. Default false = Mod 1 path (overlay active).
  isMod2?: boolean
}): JSX.Element {
  const m = cell.modulation
  const globalBpm = useStore((s) => s.session.globalBpm)
  // Live effective-Mod-1 sample for the cell currently being watched
  // by the Inspector. The hook always runs (rules of hooks); we just
  // null it out when this editor is for Mod 2 so its controls don't
  // animate against unrelated data.
  // Selector returns a STABLE null when the overlay should be off
  // (Mod 2 disabled on this cell, or this editor is editing Mod 2
  // itself) — Zustand's default reference-equality then skips the
  // re-render at the engine's 30 Hz live-emit cadence. When the
  // overlay is on, the editor re-renders each live sample as
  // intended.
  const live = useStore((s) =>
    isMod2 || cell.modulation2?.enabled !== true ? null : s.mod1Live
  )
  // Pull the values we'll overlay. `??` falls back to the stored
  // values when the engine isn't streaming (cell not armed, Mod 2
  // off, or the streamed sample doesn't have this field populated).
  const liveRateHz = live?.rateHz
  const liveDepthPct = live?.depthPct
  const liveShape = live?.lfoShape
  function uMod(patch: Partial<typeof m>): void {
    u({ modulation: { ...m, ...patch } })
  }
  return (
    // Fixed right column (88px) so the Hz/% unit column never gets pushed off
    // by a narrow inspector. Middle column is `minmax(0, 1fr)` so the slider
    // can shrink gracefully instead of forcing overflow.
    <div className="grid grid-cols-[64px_minmax(0,1fr)_88px] gap-x-2 gap-y-1 items-center">
      {/* Shape on its own row — full middle column width so the
          longest label ("Random Smoothed") fits without truncation. */}
      <span className="label">Shape</span>
      <select
        className={`input text-[11px] py-0.5 min-w-0 ${liveShape !== undefined && liveShape !== m.shape ? 'live-overlay' : ''}`}
        // Live overlay — when Mod 2 is animating Shape, show the
        // live shape so the user SEES the morph. Typing / picking
        // still writes the STORED shape (base value).
        value={liveShape ?? m.shape}
        onChange={(e) => uMod({ shape: e.target.value as LfoShape })}
        title={
          liveShape !== undefined && liveShape !== m.shape
            ? `Live: ${liveShape} · Base: ${m.shape} (the dropdown shows the live shape; picking a value sets the BASE that Modulation 2 swings around).`
            : undefined
        }
      >
        <option value="sine">Sine</option>
        <option value="triangle">Triangle</option>
        <option value="sawtooth">Sawtooth</option>
        <option value="square">Square</option>
        <option value="rndStep">Random Stepped</option>
        <option value="rndSmooth">Random Smoothed</option>
        <option value="spastic">Spastic (binary 0/1)</option>
      </select>
      <span />

      {/* Mode (Unipolar / Bipolar) on its own row, so it has space
          for the full label without crowding the Shape dropdown. */}
      <span className="label">Mode</span>
      <select
        className="input text-[11px] py-0.5 min-w-0"
        value={m.mode}
        onChange={(e) => uMod({ mode: e.target.value as LfoMode })}
        title="Unipolar = one-sided positive sweep. Bipolar = swings around center."
      >
        <option value="unipolar">Unipolar</option>
        <option value="bipolar">Bipolar</option>
      </select>
      <span />

      <span className="label">Depth</span>
      <input
        type="range"
        min={0}
        max={100}
        step={1}
        // Live overlay: slider thumb tracks the effective depth so
        // the user sees Modulation 2 modulating it. onChange still
        // writes the BASE depth (m.depthPct) — dragging the thumb
        // sets the base that Modulation 2 swings around.
        value={liveDepthPct ?? m.depthPct}
        onChange={(e) => uMod({ depthPct: clamp(Number(e.target.value), 0, 100) })}
        className={liveDepthPct !== undefined ? 'live-overlay' : ''}
      />
      <div className="flex items-center gap-1 justify-end">
        <BoundedNumberInput
          className={`input w-14 text-right ${liveDepthPct !== undefined ? 'live-overlay' : ''}`}
          integer={liveDepthPct === undefined}
          min={0}
          max={100}
          // Show 1-decimal live readout when overlaying; integer base
          // value when not.
          value={
            liveDepthPct !== undefined
              ? Math.round(liveDepthPct * 10) / 10
              : m.depthPct
          }
          onChange={(v) => uMod({ depthPct: v })}
          title={
            liveDepthPct !== undefined
              ? `Live: ${liveDepthPct.toFixed(1)} · Base: ${m.depthPct}`
              : undefined
          }
        />
        <span className="text-muted text-[11px] w-5 shrink-0">%</span>
      </div>

      <span className="label">Rate</span>
      {m.sync === 'free' ? (
        <>
          {/* Log-mapped: 0..50 of the slider → 0.01..20 Hz (musically useful
              low range), 50..100 → 20..100 Hz. Values bind through the helper
              functions in factory.ts. */}
          <input
            type="range"
            min={0}
            max={100}
            step={0.1}
            list="dataflou-rate-ticks"
            value={rateHzToSlider(liveRateHz ?? m.rateHz)}
            onChange={(e) =>
              uMod({ rateHz: sliderToRateHz(Number(e.target.value)) })
            }
            className={liveRateHz !== undefined ? 'live-overlay' : ''}
          />
          <datalist id="dataflou-rate-ticks">
            <option value={0} />
            <option value={25} />
            <option value={50} />
            <option value={75} />
            <option value={100} />
          </datalist>
          <div className="flex items-center gap-1 justify-end">
            <BoundedNumberInput
              className={`input w-14 text-right ${liveRateHz !== undefined ? 'live-overlay' : ''}`}
              min={0.01}
              max={100}
              value={
                liveRateHz !== undefined
                  ? Math.round(liveRateHz * 100) / 100
                  : m.rateHz
              }
              onChange={(v) => uMod({ rateHz: v })}
              title={
                liveRateHz !== undefined
                  ? `Live: ${liveRateHz.toFixed(2)} Hz · Base: ${m.rateHz} Hz`
                  : undefined
              }
            />
            <span className="text-muted text-[11px] w-5 shrink-0">Hz</span>
          </div>
        </>
      ) : (
        <>
          {/* Tick-marked slider mapped to the DIVISIONS table. The datalist
              makes the browser draw small tick marks under the thumb. */}
          <input
            type="range"
            min={0}
            max={DIVISIONS.length - 1}
            step={1}
            // Slider is INVERTED: visually left = slow (large
            // division → low Hz), right = fast (small division →
            // high Hz). Matches the Free-mode slider direction
            // (left = low rate, right = high rate) so toggling
            // Sync mode doesn't flip the user's mental model. The
            // stored `divisionIdx` is still the canonical
            // small-to-large index into DIVISIONS — we just
            // present it back-to-front.
            value={DIVISIONS.length - 1 - m.divisionIdx}
            list="dataflou-division-ticks"
            onChange={(e) =>
              uMod({
                divisionIdx: DIVISIONS.length - 1 - Number(e.target.value)
              })
            }
          />
          <div className="flex items-center justify-end">
            <span className="text-muted text-[11px] font-mono w-full text-right">
              {DIVISIONS[m.divisionIdx]?.label ?? '—'}
            </span>
          </div>
        </>
      )}

      <span className="label">Sync</span>
      {/* Keep Free (Hz) / Dotted / Triplet on a single line — dropped
          flex-wrap and bumped the select width enough to show the full
          "Free (Hz)" label without truncation. */}
      <div className="flex items-center gap-2 text-[11px] min-w-0">
        <select
          className="input text-[11px] py-0.5 shrink-0"
          style={{ width: 96 }}
          value={m.sync}
          onChange={(e) => uMod({ sync: e.target.value as LfoSync })}
        >
          <option value="free">Free (Hz)</option>
          <option value="bpm">BPM</option>
        </select>
        <label
          className={`flex items-center gap-1 shrink-0 ${
            m.sync !== 'bpm' ? 'opacity-40' : ''
          }`}
        >
          <input
            type="checkbox"
            disabled={m.sync !== 'bpm'}
            checked={m.dotted}
            onChange={(e) => uMod({ dotted: e.target.checked })}
          />
          <span>Dotted</span>
        </label>
        <label
          className={`flex items-center gap-1 shrink-0 ${
            m.sync !== 'bpm' ? 'opacity-40' : ''
          }`}
        >
          <input
            type="checkbox"
            disabled={m.sync !== 'bpm'}
            checked={m.triplet}
            onChange={(e) => uMod({ triplet: e.target.checked })}
          />
          <span>Triplet</span>
        </label>
      </div>
      <span />
      {/* Span the full grid width — visual reacts to shape / depth /
          rate / mode / sync so dragging any of them re-renders the
          curve. Pass globalBpm so the visual respects BPM-synced
          rate when sync mode isn't Free. */}
      <div className="col-span-3">
        <LfoVisual modulation={m} globalBpm={globalBpm} />
      </div>
    </div>
  )
}

function ArpEditor({
  cell,
  u,
  isMod2
}: {
  cell: import('@shared/types').Cell
  u: CellUpdate
  isMod2?: boolean
}): JSX.Element {
  const m = cell.modulation
  const arp = m.arpeggiator
  // Live Mod 1 sample — suppressed when this editor is editing Mod 2
  // itself (Mod 2's own arpMode isn't modulated by anything).
  // Selector returns a STABLE null when the overlay should be off
  // (Mod 2 disabled on this cell, or this editor is editing Mod 2
  // itself) — Zustand's default reference-equality then skips the
  // re-render at the engine's 30 Hz live-emit cadence. When the
  // overlay is on, the editor re-renders each live sample as
  // intended.
  const live = useStore((s) =>
    isMod2 || cell.modulation2?.enabled !== true ? null : s.mod1Live
  )
  const liveArpMode = live?.arpMode
  const liveRateHz = live?.rateHz
  const liveDepthPct = live?.depthPct
  function uMod(patch: Partial<typeof m>): void {
    u({ modulation: { ...m, ...patch } })
  }
  function uArp(patch: Partial<typeof arp>): void {
    u({ modulation: { ...m, arpeggiator: { ...arp, ...patch } } })
  }

  return (
    // Same grid template as LFO so everything aligns to the right.
    <div className="grid grid-cols-[64px_minmax(0,1fr)_88px] gap-x-2 gap-y-1 items-center">
      <span className="label">Steps</span>
      <input
        type="range"
        min={1}
        max={8}
        step={1}
        value={arp.steps}
        onChange={(e) => uArp({ steps: clamp(Math.round(Number(e.target.value)), 1, 8) })}
      />
      <div className="flex items-center gap-1 justify-end">
        <BoundedNumberInput
          className="input w-14 text-right"
          integer
          min={1}
          max={8}
          value={arp.steps}
          onChange={(v) => uArp({ steps: clamp(Math.round(v), 1, 8) })}
        />
        <span className="text-muted text-[11px] w-5 shrink-0">/8</span>
      </div>

      <span className="label">Mode</span>
      <select
        className={`input text-[11px] py-0.5 min-w-0 ${liveArpMode !== undefined && liveArpMode !== arp.arpMode ? 'live-overlay' : ''}`}
        value={liveArpMode ?? arp.arpMode}
        onChange={(e) => uArp({ arpMode: e.target.value as ArpMode })}
        title={
          liveArpMode !== undefined && liveArpMode !== arp.arpMode
            ? `Live: ${liveArpMode} · Base: ${arp.arpMode}`
            : undefined
        }
      >
        <option value="up">Up</option>
        <option value="down">Down</option>
        <option value="upDown">Up/Down</option>
        <option value="downUp">Down/Up</option>
        <option value="exclusion">Exclusion</option>
        <option value="walk">Walk</option>
        <option value="drunk">Drunk</option>
        <option value="random">Random</option>
      </select>
      <span />

      <span className="label">Mult</span>
      <select
        className="input text-[11px] py-0.5 min-w-0"
        value={arp.multMode}
        onChange={(e) => uArp({ multMode: e.target.value as MultMode })}
        title="Division: Value is the max; lower steps are fractions.
Multiplication: Value is step 1; each step doubles.
Div/Mult: Value in the middle; halvings below, doublings above."
      >
        <option value="div">Division</option>
        <option value="mult">Multiplication</option>
        <option value="divMult">Div/Mult</option>
      </select>
      <span />

      <span className="label">Depth</span>
      <input
        type="range"
        min={0}
        max={100}
        step={1}
        value={liveDepthPct ?? m.depthPct}
        onChange={(e) => uMod({ depthPct: clamp(Number(e.target.value), 0, 100) })}
        className={liveDepthPct !== undefined ? 'live-overlay' : ''}
      />
      <div className="flex items-center gap-1 justify-end">
        <BoundedNumberInput
          className={`input w-14 text-right ${liveDepthPct !== undefined ? 'live-overlay' : ''}`}
          integer={liveDepthPct === undefined}
          min={0}
          max={100}
          value={
            liveDepthPct !== undefined
              ? Math.round(liveDepthPct * 10) / 10
              : m.depthPct
          }
          onChange={(v) => uMod({ depthPct: v })}
          title={
            liveDepthPct !== undefined
              ? `Live: ${liveDepthPct.toFixed(1)} · Base: ${m.depthPct}`
              : undefined
          }
        />
        <span className="text-muted text-[11px] w-5 shrink-0">%</span>
      </div>

      <span className="label">Rate</span>
      {m.sync === 'free' ? (
        <>
          <input
            type="range"
            min={0}
            max={100}
            step={0.1}
            value={rateHzToSlider(liveRateHz ?? m.rateHz)}
            onChange={(e) => uMod({ rateHz: sliderToRateHz(Number(e.target.value)) })}
            className={liveRateHz !== undefined ? 'live-overlay' : ''}
          />
          <div className="flex items-center gap-1 justify-end">
            <BoundedNumberInput
              className={`input w-14 text-right ${liveRateHz !== undefined ? 'live-overlay' : ''}`}
              min={0.01}
              max={100}
              value={
                liveRateHz !== undefined
                  ? Math.round(liveRateHz * 100) / 100
                  : m.rateHz
              }
              onChange={(v) => uMod({ rateHz: v })}
              title={
                liveRateHz !== undefined
                  ? `Live: ${liveRateHz.toFixed(2)} Hz · Base: ${m.rateHz} Hz`
                  : undefined
              }
            />
            <span className="text-muted text-[11px] w-5 shrink-0">Hz</span>
          </div>
        </>
      ) : (
        <>
          <input
            type="range"
            min={0}
            max={DIVISIONS.length - 1}
            step={1}
            // Slider is INVERTED: visually left = slow (large
            // division → low Hz), right = fast (small division →
            // high Hz). Matches the Free-mode slider direction
            // (left = low rate, right = high rate) so toggling
            // Sync mode doesn't flip the user's mental model. The
            // stored `divisionIdx` is still the canonical
            // small-to-large index into DIVISIONS — we just
            // present it back-to-front.
            value={DIVISIONS.length - 1 - m.divisionIdx}
            list="dataflou-division-ticks"
            onChange={(e) =>
              uMod({
                divisionIdx: DIVISIONS.length - 1 - Number(e.target.value)
              })
            }
          />
          <div className="flex items-center justify-end">
            <span className="text-muted text-[11px] font-mono w-full text-right">
              {DIVISIONS[m.divisionIdx]?.label ?? '—'}
            </span>
          </div>
        </>
      )}

      <span className="label">Sync</span>
      {/* Keep Free (Hz) / Dotted / Triplet on a single line — dropped
          flex-wrap and bumped the select width enough to show the full
          "Free (Hz)" label without truncation. */}
      <div className="flex items-center gap-2 text-[11px] min-w-0">
        <select
          className="input text-[11px] py-0.5 shrink-0"
          style={{ width: 96 }}
          value={m.sync}
          onChange={(e) => uMod({ sync: e.target.value as LfoSync })}
        >
          <option value="free">Free (Hz)</option>
          <option value="bpm">BPM</option>
        </select>
        <label
          className={`flex items-center gap-1 shrink-0 ${
            m.sync !== 'bpm' ? 'opacity-40' : ''
          }`}
        >
          <input
            type="checkbox"
            disabled={m.sync !== 'bpm'}
            checked={m.dotted}
            onChange={(e) => uMod({ dotted: e.target.checked })}
          />
          <span>Dotted</span>
        </label>
        <label
          className={`flex items-center gap-1 shrink-0 ${
            m.sync !== 'bpm' ? 'opacity-40' : ''
          }`}
        >
          <input
            type="checkbox"
            disabled={m.sync !== 'bpm'}
            checked={m.triplet}
            onChange={(e) => uMod({ triplet: e.target.checked })}
          />
          <span>Triplet</span>
        </label>
      </div>
      <span />

      <div className="col-span-3 text-[10px] text-muted">
        Depth 100% = ladder step replaces the base value; 0% leaves it untouched. The ladder is
        built independently per space-separated value in the Value box. Scale 0.0–1.0 clamps each
        output to [0, 1] as usual. If there are no numeric tokens in the Value field, the
        arpeggiator is skipped.
      </div>
      <div className="col-span-3">
        <ArpVisual arp={cell.modulation.arpeggiator} depthPct={cell.modulation.depthPct} />
      </div>
    </div>
  )
}

function RandomEditor({
  cell,
  u,
  isMod2
}: {
  cell: import('@shared/types').Cell
  u: CellUpdate
  isMod2?: boolean
}): JSX.Element {
  // Live overlay (suppressed for Mod 2 self-editing). Random's
  // continuous param Mod 2 targets is `distribution`.
  // Selector returns a STABLE null when the overlay should be off
  // (Mod 2 disabled on this cell, or this editor is editing Mod 2
  // itself) — Zustand's default reference-equality then skips the
  // re-render at the engine's 30 Hz live-emit cadence. When the
  // overlay is on, the editor re-renders each live sample as
  // intended.
  const live = useStore((s) =>
    isMod2 || cell.modulation2?.enabled !== true ? null : s.mod1Live
  )
  const liveDist = live?.randomDistribution
  const liveRateHz = live?.rateHz
  const liveDepthPct = live?.depthPct
  const globalBpm = useStore((s) => s.session.globalBpm)
  const m = cell.modulation
  const rnd = m.random
  function uMod(patch: Partial<typeof m>): void {
    u({ modulation: { ...m, ...patch } })
  }
  function uRnd(patch: Partial<typeof rnd>): void {
    u({ modulation: { ...m, random: { ...rnd, ...patch } } })
  }

  // Sensible range defaults when the user switches value type.
  function onValueTypeChange(next: RandomValueType): void {
    // Only reset min/max if the user is sitting on the previous type's defaults.
    const defaults: Record<RandomValueType, { min: number; max: number }> = {
      int: { min: 0, max: 127 },
      float: { min: 0, max: 1 },
      colour: { min: 0, max: 255 }
    }
    uRnd({ valueType: next, ...defaults[next] })
  }

  const isColour = rnd.valueType === 'colour'

  return (
    <div className="grid grid-cols-[64px_minmax(0,1fr)_88px] gap-x-2 gap-y-1 items-center">
      <span className="label">Type</span>
      <select
        className="input text-[11px] py-0.5 min-w-0"
        value={rnd.valueType}
        onChange={(e) => onValueTypeChange(e.target.value as RandomValueType)}
        title="Int = one integer per tick. Float = one float per tick (1e-11 precision). Colour = three ints (r, g, b) per tick."
      >
        <option value="int">Int</option>
        <option value="float">Float</option>
        <option value="colour">Colour (r,g,b)</option>
      </select>
      <span />

      <span className="label">Min</span>
      <BoundedNumberInput
        className="input"
        min={-1000000}
        max={1000000}
        integer={rnd.valueType !== 'float'}
        value={rnd.min}
        onChange={(v) => uRnd({ min: v })}
      />
      <span />

      <span className="label">Max</span>
      <BoundedNumberInput
        className="input"
        min={-1000000}
        max={1000000}
        integer={rnd.valueType !== 'float'}
        value={rnd.max}
        onChange={(v) => uRnd({ max: v })}
      />
      <span />

      {/* Distribution skew applied to each random draw. 0 = edge-
          weighted (cluster at min/max), 0.5 = uniform, 1 = centre-
          hugging. Inspired by Buchla 266 "Stored Random Voltages". */}
      <span className="label">Dist.</span>
      <input
        type="range"
        min={0}
        max={100}
        step={1}
        value={Math.round((liveDist ?? rnd.distribution ?? 0.5) * 100)}
        onChange={(e) =>
          uRnd({ distribution: clamp(Number(e.target.value), 0, 100) / 100 })
        }
        className={liveDist !== undefined ? 'live-overlay' : ''}
      />
      <div className="flex items-center gap-1 justify-end">
        <BoundedNumberInput
          className={`input w-14 text-right ${liveDist !== undefined ? 'live-overlay' : ''}`}
          integer={liveDist === undefined}
          min={0}
          max={100}
          value={Math.round((liveDist ?? rnd.distribution ?? 0.5) * 100)}
          onChange={(v) => uRnd({ distribution: v / 100 })}
          title={
            liveDist !== undefined
              ? `Live: ${Math.round(liveDist * 100)}% · Base: ${Math.round((rnd.distribution ?? 0.5) * 100)}%`
              : undefined
          }
        />
        <span className="text-muted text-[11px] w-5 shrink-0">%</span>
      </div>
      <div className="col-span-3 text-[10px] text-muted italic">
        0 % = edges only · 50 % = uniform · 100 % = centre-hugging.
      </div>

      <span className="label">Rate</span>
      {m.sync === 'free' ? (
        <>
          <input
            type="range"
            min={0}
            max={100}
            step={0.1}
            value={rateHzToSlider(liveRateHz ?? m.rateHz)}
            onChange={(e) => uMod({ rateHz: sliderToRateHz(Number(e.target.value)) })}
            className={liveRateHz !== undefined ? 'live-overlay' : ''}
          />
          <div className="flex items-center gap-1 justify-end">
            <BoundedNumberInput
              className={`input w-14 text-right ${liveRateHz !== undefined ? 'live-overlay' : ''}`}
              min={0.01}
              max={100}
              value={
                liveRateHz !== undefined
                  ? Math.round(liveRateHz * 100) / 100
                  : m.rateHz
              }
              onChange={(v) => uMod({ rateHz: v })}
              title={
                liveRateHz !== undefined
                  ? `Live: ${liveRateHz.toFixed(2)} Hz · Base: ${m.rateHz} Hz`
                  : undefined
              }
            />
            <span className="text-muted text-[11px] w-5 shrink-0">Hz</span>
          </div>
        </>
      ) : (
        <>
          <input
            type="range"
            min={0}
            max={DIVISIONS.length - 1}
            step={1}
            // Slider is INVERTED: visually left = slow (large
            // division → low Hz), right = fast (small division →
            // high Hz). Matches the Free-mode slider direction
            // (left = low rate, right = high rate) so toggling
            // Sync mode doesn't flip the user's mental model. The
            // stored `divisionIdx` is still the canonical
            // small-to-large index into DIVISIONS — we just
            // present it back-to-front.
            value={DIVISIONS.length - 1 - m.divisionIdx}
            list="dataflou-division-ticks"
            onChange={(e) =>
              uMod({
                divisionIdx: DIVISIONS.length - 1 - Number(e.target.value)
              })
            }
          />
          <div className="flex items-center justify-end">
            <span className="text-muted text-[11px] font-mono w-full text-right">
              {DIVISIONS[m.divisionIdx]?.label ?? '—'}
            </span>
          </div>
        </>
      )}

      <span className="label">Sync</span>
      {/* Keep Free (Hz) / Dotted / Triplet on a single line — dropped
          flex-wrap and bumped the select width enough to show the full
          "Free (Hz)" label without truncation. */}
      <div className="flex items-center gap-2 text-[11px] min-w-0">
        <select
          className="input text-[11px] py-0.5 shrink-0"
          style={{ width: 96 }}
          value={m.sync}
          onChange={(e) => uMod({ sync: e.target.value as LfoSync })}
        >
          <option value="free">Free (Hz)</option>
          <option value="bpm">BPM</option>
        </select>
        <label
          className={`flex items-center gap-1 shrink-0 ${
            m.sync !== 'bpm' ? 'opacity-40' : ''
          }`}
        >
          <input
            type="checkbox"
            disabled={m.sync !== 'bpm'}
            checked={m.dotted}
            onChange={(e) => uMod({ dotted: e.target.checked })}
          />
          <span>Dotted</span>
        </label>
        <label
          className={`flex items-center gap-1 shrink-0 ${
            m.sync !== 'bpm' ? 'opacity-40' : ''
          }`}
        >
          <input
            type="checkbox"
            disabled={m.sync !== 'bpm'}
            checked={m.triplet}
            onChange={(e) => uMod({ triplet: e.target.checked })}
          />
          <span>Triplet</span>
        </label>
      </div>
      <span />

      <div className="col-span-3 text-[10px] text-muted">
        The clip's Value is used as the PRNG seed — the same Value produces a reproducible stream.
        {isColour
          ? ' Colour mode sends three integer OSC args (r, g, b), each independently drawn from [Min, Max].'
          : rnd.valueType === 'int'
            ? ' One int OSC arg per sample, in [Min, Max].'
            : ' One float OSC arg per sample, in [Min, Max], rounded to 1e-11.'}
        {' '}Scale 0.0–1.0 clamps each channel to [0, 1].
      </div>
      <div className="col-span-3">
        <RandomVisual modulation={cell.modulation} globalBpm={globalBpm} />
      </div>
    </div>
  )
}

// Reusable rate controls (Free Hz / BPM-synced with dotted/triplet). The
// LFO editor has its own expanded version; the new modulators (S&H,
// Slew, Chaos) share this compact one so the rate controls feel
// identical across all clock-driven modulators.
function CompactRateControls({
  m,
  uMod,
  isMod2,
  mod2Enabled
}: {
  m: import('@shared/types').Modulation
  uMod: (patch: Partial<import('@shared/types').Modulation>) => void
  // Suppresses the live-Mod-1 overlay when this row sits inside the
  // Mod 2 section (Mod 2's rate is the modulator, it isn't itself
  // being modulated by anything we surface here).
  isMod2?: boolean
  // Whether Modulation 2 is enabled on the parent cell — when false,
  // the live stream is still flowing (it carries other data like
  // the Gesture playhead) but the orange overlay shouldn't tint
  // these controls, because nothing is actually modulating them.
  mod2Enabled?: boolean
}): JSX.Element {
  // Live effective Mod 1 from the store. Suppressed when this helper
  // is rendered inside Modulation 2's section (isMod2) OR when Mod 2
  // is disabled on the cell (mod2Enabled false) — the stored values
  // and the live values are identical in that case, so any orange
  // tint would be misleading "modulation off but UI says it's on".
  // Selector returns stable null when overlay should be off — see
  // matching comment in the per-modulator editors. Cuts the 30 Hz
  // re-render of every parent that uses this helper down to 0 Hz
  // whenever Mod 2 is disabled on the cell.
  const live = useStore((s) =>
    isMod2 || !mod2Enabled ? null : s.mod1Live
  )
  const liveRateHz = live?.rateHz
  return (
    <>
      <span className="label">Rate</span>
      {m.sync === 'free' ? (
        <input
          type="range"
          min={0}
          max={100}
          step={0.1}
          value={rateHzToSlider(liveRateHz ?? m.rateHz)}
          onChange={(e) => uMod({ rateHz: sliderToRateHz(Number(e.target.value)) })}
          className={liveRateHz !== undefined ? 'live-overlay' : ''}
        />
      ) : (
        // BPM-synced rate doesn't expose a continuous Hz to overlay
        // (divisionIdx is the stored value, and Modulation 2's Rate
        // target patches rateHz, not divisionIdx). Slider stays on
        // the stored division. The Hz readout below still flashes
        // when free-mode is on; in BPM mode the user reads the
        // division label.
        <input
          type="range"
          min={0}
          max={DIVISIONS.length - 1}
          step={1}
          // Inverted division slider — see comment on the LFO
          // instance above. Left = slow, right = fast.
          value={DIVISIONS.length - 1 - m.divisionIdx}
          onChange={(e) =>
            uMod({
              divisionIdx: DIVISIONS.length - 1 - Number(e.target.value)
            })
          }
        />
      )}
      <div className="flex items-center gap-1 justify-end">
        {m.sync === 'free' ? (
          <>
            <BoundedNumberInput
              className={`input w-14 text-right ${liveRateHz !== undefined ? 'live-overlay' : ''}`}
              min={0.01}
              max={100}
              value={
                liveRateHz !== undefined
                  ? Math.round(liveRateHz * 100) / 100
                  : m.rateHz
              }
              onChange={(v) => uMod({ rateHz: v })}
              title={
                liveRateHz !== undefined
                  ? `Live: ${liveRateHz.toFixed(2)} Hz · Base: ${m.rateHz} Hz`
                  : undefined
              }
            />
            <span className="text-muted text-[11px] w-5 shrink-0">Hz</span>
          </>
        ) : (
          <span
            className="text-[11px] font-mono text-right w-full"
            title="BPM-synced division"
          >
            {DIVISIONS[m.divisionIdx]?.label ?? ''}
          </span>
        )}
      </div>

      <span className="label">Sync</span>
      <div className="flex items-center gap-2 text-[11px] min-w-0 col-span-2">
        <select
          className="input text-[11px] py-0.5 shrink-0"
          style={{ width: 96 }}
          value={m.sync}
          onChange={(e) => uMod({ sync: e.target.value as LfoSync })}
        >
          <option value="free">Free (Hz)</option>
          <option value="bpm">BPM</option>
        </select>
        <label
          className={`flex items-center gap-1 shrink-0 ${m.sync !== 'bpm' ? 'opacity-40' : ''}`}
        >
          <input
            type="checkbox"
            disabled={m.sync !== 'bpm'}
            checked={m.dotted}
            onChange={(e) => uMod({ dotted: e.target.checked })}
          />
          <span>Dotted</span>
        </label>
        <label
          className={`flex items-center gap-1 shrink-0 ${m.sync !== 'bpm' ? 'opacity-40' : ''}`}
        >
          <input
            type="checkbox"
            disabled={m.sync !== 'bpm'}
            checked={m.triplet}
            onChange={(e) => uMod({ triplet: e.target.checked })}
          />
          <span>Triplet</span>
        </label>
      </div>
    </>
  )
}

// Depth + bipolar/unipolar mode controls, also shared by the clock-driven
// modulators.
function CompactDepthMode({
  m,
  uMod,
  isMod2,
  mod2Enabled
}: {
  m: import('@shared/types').Modulation
  uMod: (patch: Partial<import('@shared/types').Modulation>) => void
  isMod2?: boolean
  mod2Enabled?: boolean
}): JSX.Element {
  // Suppress the orange overlay when Mod 2 is off (live values equal
  // base values, so no actual modulation to highlight) or when this
  // helper is rendered inside Modulation 2's section.
  // Selector returns stable null when overlay should be off — see
  // matching comment in the per-modulator editors. Cuts the 30 Hz
  // re-render of every parent that uses this helper down to 0 Hz
  // whenever Mod 2 is disabled on the cell.
  const live = useStore((s) =>
    isMod2 || !mod2Enabled ? null : s.mod1Live
  )
  const liveDepthPct = live?.depthPct
  return (
    <>
      <span className="label">Depth</span>
      <input
        type="range"
        min={0}
        max={100}
        step={1}
        value={liveDepthPct ?? m.depthPct}
        onChange={(e) => uMod({ depthPct: clamp(Number(e.target.value), 0, 100) })}
        className={liveDepthPct !== undefined ? 'live-overlay' : ''}
      />
      <div className="flex items-center gap-1 justify-end">
        <BoundedNumberInput
          className={`input w-14 text-right ${liveDepthPct !== undefined ? 'live-overlay' : ''}`}
          integer={liveDepthPct === undefined}
          min={0}
          max={100}
          value={
            liveDepthPct !== undefined
              ? Math.round(liveDepthPct * 10) / 10
              : m.depthPct
          }
          onChange={(v) => uMod({ depthPct: v })}
          title={
            liveDepthPct !== undefined
              ? `Live: ${liveDepthPct.toFixed(1)} · Base: ${m.depthPct}`
              : undefined
          }
        />
        <span className="text-muted text-[11px] w-5 shrink-0">%</span>
      </div>

      <span className="label">Mode</span>
      {/* Just-as-wide-as-the-longest-word — was col-span-2 which
          stretched the dropdown across the full middle + right
          columns. 88 px fits "Unipolar" with the native arrow. */}
      <select
        className="input text-[11px] py-0.5"
        style={{ width: 88 }}
        value={m.mode}
        onChange={(e) => uMod({ mode: e.target.value as LfoMode })}
        title="Unipolar = one-sided positive sweep. Bipolar = swings around center."
      >
        <option value="unipolar">Unipolar</option>
        <option value="bipolar">Bipolar</option>
      </select>
      <span />
    </>
  )
}

// Sample & Hold editor — held-value stair / cosine-smoothed stair with
// a probability knob that holds samples across multiple clocks.
function SampleHoldEditor({
  cell,
  u,
  isMod2
}: {
  cell: import('@shared/types').Cell
  u: CellUpdate
  isMod2?: boolean
}): JSX.Element {
  const m = cell.modulation
  const sh = m.sh
  const globalBpm = useStore((s) => s.session.globalBpm)
  // Live overlay (suppressed when this editor is editing Mod 2 itself).
  // Selector returns a STABLE null when the overlay should be off
  // (Mod 2 disabled on this cell, or this editor is editing Mod 2
  // itself) — Zustand's default reference-equality then skips the
  // re-render at the engine's 30 Hz live-emit cadence. When the
  // overlay is on, the editor re-renders each live sample as
  // intended.
  const live = useStore((s) =>
    isMod2 || cell.modulation2?.enabled !== true ? null : s.mod1Live
  )
  const liveDist = live?.shDistribution
  function uMod(patch: Partial<typeof m>): void {
    u({ modulation: { ...m, ...patch } })
  }
  function uSh(patch: Partial<typeof sh>): void {
    u({ modulation: { ...m, sh: { ...sh, ...patch } } })
  }
  return (
    <div className="grid grid-cols-[64px_minmax(0,1fr)_88px] gap-x-2 gap-y-1 items-center">
      <CompactDepthMode
        m={m}
        uMod={uMod}
        isMod2={isMod2}
        mod2Enabled={cell.modulation2?.enabled}
      />
      <CompactRateControls
        m={m}
        uMod={uMod}
        isMod2={isMod2}
        mod2Enabled={cell.modulation2?.enabled}
      />

      <span className="label">Smooth</span>
      <label className="flex items-center gap-1 col-span-2 text-[11px]">
        <input
          type="checkbox"
          checked={sh.smooth}
          onChange={(e) => uSh({ smooth: e.target.checked })}
        />
        <span>Cosine-interpolate between samples (analog S&amp;H)</span>
      </label>

      <span className="label">Prob.</span>
      <input
        type="range"
        min={0}
        max={100}
        step={1}
        value={Math.round(sh.probability * 100)}
        onChange={(e) => uSh({ probability: clamp(Number(e.target.value), 0, 100) / 100 })}
      />
      <div className="flex items-center gap-1 justify-end">
        <BoundedNumberInput
          className="input w-14 text-right"
          integer
          min={0}
          max={100}
          value={Math.round(sh.probability * 100)}
          onChange={(v) => uSh({ probability: v / 100 })}
        />
        <span className="text-muted text-[11px] w-5 shrink-0">%</span>
      </div>

      <div className="col-span-3 text-[10px] text-muted italic">
        Below 100 % the modulator sometimes holds its previous sample
        across clocks — Turing-Machine-style locked-in feel.
      </div>

      {/* Distribution skew on each new S&H sample. 0 = edge-weighted
          (samples cluster at the rails), 0.5 = uniform, 1 = centre-
          hugging. Inspired by Buchla 266 "Stored Random Voltages". */}
      <span className="label">Dist.</span>
      <input
        type="range"
        min={0}
        max={100}
        step={1}
        value={Math.round((liveDist ?? sh.distribution ?? 0.5) * 100)}
        onChange={(e) =>
          uSh({ distribution: clamp(Number(e.target.value), 0, 100) / 100 })
        }
        className={liveDist !== undefined ? 'live-overlay' : ''}
      />
      <div className="flex items-center gap-1 justify-end">
        <BoundedNumberInput
          className={`input w-14 text-right ${liveDist !== undefined ? 'live-overlay' : ''}`}
          integer={liveDist === undefined}
          min={0}
          max={100}
          value={Math.round((liveDist ?? sh.distribution ?? 0.5) * 100)}
          onChange={(v) => uSh({ distribution: v / 100 })}
        />
        <span className="text-muted text-[11px] w-5 shrink-0">%</span>
      </div>
      <div className="col-span-3 text-[10px] text-muted italic">
        0 % = edges only (samples near min / max) · 50 % = uniform · 100 % = centre-hugging.
      </div>

      <div className="col-span-3">
        <SampleHoldVisual modulation={cell.modulation} globalBpm={globalBpm} />
      </div>
    </div>
  )
}

// Slew editor — random target at the clock rate, exponential glide.
function SlewEditor({
  cell,
  u,
  isMod2
}: {
  cell: import('@shared/types').Cell
  u: CellUpdate
  isMod2?: boolean
}): JSX.Element {
  const m = cell.modulation
  const s = m.slew
  // Live overlay (suppressed in Mod 2 self-edit).
  // Selector returns stable null when overlay should be off — see
  // matching comment in the other editors.
  const live = useStore((st) =>
    isMod2 || cell.modulation2?.enabled !== true ? null : st.mod1Live
  )
  const liveRise = live?.slewRiseMs
  const liveFall = live?.slewFallMs
  const globalBpm = useStore((st) => st.session.globalBpm)
  function uMod(patch: Partial<typeof m>): void {
    u({ modulation: { ...m, ...patch } })
  }
  function uSlew(patch: Partial<typeof s>): void {
    u({ modulation: { ...m, slew: { ...s, ...patch } } })
  }
  return (
    <div className="grid grid-cols-[64px_minmax(0,1fr)_88px] gap-x-2 gap-y-1 items-center">
      <CompactDepthMode
        m={m}
        uMod={uMod}
        isMod2={isMod2}
        mod2Enabled={cell.modulation2?.enabled}
      />
      <CompactRateControls
        m={m}
        uMod={uMod}
        isMod2={isMod2}
        mod2Enabled={cell.modulation2?.enabled}
      />

      <span className="label">Rise</span>
      <input
        type="range"
        min={1}
        max={5000}
        step={1}
        value={Math.round(liveRise ?? s.riseMs)}
        onChange={(e) => uSlew({ riseMs: clamp(Number(e.target.value), 1, 60000) })}
        className={liveRise !== undefined ? 'live-overlay' : ''}
      />
      <div className="flex items-center gap-1 justify-end">
        <BoundedNumberInput
          className={`input w-14 text-right ${liveRise !== undefined ? 'live-overlay' : ''}`}
          integer
          min={1}
          max={60000}
          value={Math.round(liveRise ?? s.riseMs)}
          onChange={(v) => uSlew({ riseMs: v })}
          title={
            liveRise !== undefined ? `Live: ${Math.round(liveRise)} · Base: ${s.riseMs}` : undefined
          }
        />
        <span className="text-muted text-[11px] w-5 shrink-0">ms</span>
      </div>

      <span className="label">Fall</span>
      <input
        type="range"
        min={1}
        max={5000}
        step={1}
        value={Math.round(liveFall ?? s.fallMs)}
        onChange={(e) => uSlew({ fallMs: clamp(Number(e.target.value), 1, 60000) })}
        className={liveFall !== undefined ? 'live-overlay' : ''}
      />
      <div className="flex items-center gap-1 justify-end">
        <BoundedNumberInput
          className={`input w-14 text-right ${liveFall !== undefined ? 'live-overlay' : ''}`}
          integer
          min={1}
          max={60000}
          value={Math.round(liveFall ?? s.fallMs)}
          onChange={(v) => uSlew({ fallMs: v })}
          title={
            liveFall !== undefined ? `Live: ${Math.round(liveFall)} · Base: ${s.fallMs}` : undefined
          }
        />
        <span className="text-muted text-[11px] w-5 shrink-0">ms</span>
      </div>

      <span className="label">Target</span>
      <label className="flex items-center gap-1 col-span-2 text-[11px]">
        <input
          type="checkbox"
          checked={s.randomTarget}
          onChange={(e) => uSlew({ randomTarget: e.target.checked })}
        />
        <span>Random target each clock (off = ±1 square)</span>
      </label>

      <div className="col-span-3 text-[10px] text-muted italic">
        Rise / Fall are half-life times (63 % of the move). Tune them
        asymmetrically for slow-rise / fast-fall envelope feel, or both
        equal for smooth symmetric glide.
      </div>
      <div className="col-span-3">
        <SlewVisual modulation={cell.modulation} globalBpm={globalBpm} />
      </div>
    </div>
  )
}

// Chaos editor — logistic map r parameter. 3.5..4.0 covers period-doubling
// cascade through full chaos; below 3.5 the map converges to a stable
// cycle (boring). Above 4.0 it escapes (0..1 invariant fails).
function ChaosEditor({
  cell,
  u,
  isMod2
}: {
  cell: import('@shared/types').Cell
  u: CellUpdate
  isMod2?: boolean
}): JSX.Element {
  const m = cell.modulation
  const c = m.chaos
  // Selector returns a STABLE null when the overlay should be off
  // (Mod 2 disabled on this cell, or this editor is editing Mod 2
  // itself) — Zustand's default reference-equality then skips the
  // re-render at the engine's 30 Hz live-emit cadence. When the
  // overlay is on, the editor re-renders each live sample as
  // intended.
  const live = useStore((s) =>
    isMod2 || cell.modulation2?.enabled !== true ? null : s.mod1Live
  )
  const liveR = live?.chaosR
  function uMod(patch: Partial<typeof m>): void {
    u({ modulation: { ...m, ...patch } })
  }
  function uChaos(patch: Partial<typeof c>): void {
    u({ modulation: { ...m, chaos: { ...c, ...patch } } })
  }
  return (
    <div className="grid grid-cols-[64px_minmax(0,1fr)_88px] gap-x-2 gap-y-1 items-center">
      <CompactDepthMode
        m={m}
        uMod={uMod}
        isMod2={isMod2}
        mod2Enabled={cell.modulation2?.enabled}
      />
      <CompactRateControls
        m={m}
        uMod={uMod}
        isMod2={isMod2}
        mod2Enabled={cell.modulation2?.enabled}
      />

      <span className="label">r</span>
      <input
        type="range"
        min={3.4}
        max={4.0}
        step={0.001}
        value={liveR ?? c.r}
        onChange={(e) => uChaos({ r: clamp(Number(e.target.value), 3.4, 4.0) })}
        title="3.5 ~ stable 4-cycle · 3.57 onset of chaos · 3.83 period-3 window · 4.0 fully chaotic"
        className={liveR !== undefined ? 'live-overlay' : ''}
      />
      <div className="flex items-center gap-1 justify-end">
        <BoundedNumberInput
          className={`input w-14 text-right ${liveR !== undefined ? 'live-overlay' : ''}`}
          min={3.4}
          max={4.0}
          value={Number((liveR ?? c.r).toFixed(3))}
          onChange={(v) => uChaos({ r: v })}
          title={
            liveR !== undefined ? `Live: ${liveR.toFixed(3)} · Base: ${c.r.toFixed(3)}` : undefined
          }
        />
        <span className="text-muted text-[11px] w-5 shrink-0" />
      </div>

      <div className="col-span-3 text-[10px] text-muted italic">
        Logistic map x ← r · x · (1 − x). 3.57 is the onset of chaos;
        3.83 hides a brief period-3 window (audible structure in a sea
        of noise); 4.0 is fully chaotic.
      </div>
      <div className="col-span-3">
        <ChaosVisual chaos={cell.modulation.chaos} depthPct={cell.modulation.depthPct} />
      </div>
    </div>
  )
}

// Strange Attractor editor — pick the ODE system, set its sweep
// Speed, and the bifurcation Chaos knob. Channel fan-out (slot 0=X,
// 1=Y, 2=Z, 3=W/speed) is implicit on multi-arg cells.
function AttractorEditor({
  cell,
  u,
  isMod2
}: {
  cell: import('@shared/types').Cell
  u: CellUpdate
  isMod2?: boolean
}): JSX.Element {
  const m = cell.modulation
  // Selector returns a STABLE null when the overlay should be off
  // (Mod 2 disabled on this cell, or this editor is editing Mod 2
  // itself) — Zustand's default reference-equality then skips the
  // re-render at the engine's 30 Hz live-emit cadence. When the
  // overlay is on, the editor re-renders each live sample as
  // intended.
  const live = useStore((s) =>
    isMod2 || cell.modulation2?.enabled !== true ? null : s.mod1Live
  )
  const liveChaos = live?.attractorChaos
  const liveSpeed = live?.attractorSpeed
  // Defensive fallback for sessions saved before the Attractor type
  // existed (the field is optional on the Modulation union).
  const ap = m.attractor ?? {
    type: 'lorenz' as const,
    speed: 1,
    chaos: 0.5
  }
  function uMod(patch: Partial<typeof m>): void {
    u({ modulation: { ...m, ...patch } })
  }
  function uAp(patch: Partial<typeof ap>): void {
    u({ modulation: { ...m, attractor: { ...ap, ...patch } } })
  }
  return (
    <div className="grid grid-cols-[64px_minmax(0,1fr)_88px] gap-x-2 gap-y-1 items-center">
      <CompactDepthMode
        m={m}
        uMod={uMod}
        isMod2={isMod2}
        mod2Enabled={cell.modulation2?.enabled}
      />

      <span className="label">Type</span>
      <select
        className="input text-[11px] py-0.5 min-w-0"
        value={ap.type}
        onChange={(e) =>
          uAp({ type: e.target.value as typeof ap.type })
        }
        title="3D: Lorenz / Aizawa / Thomas / Rössler. 4D hyperchaotic: Rössler 4D / Lü 4D."
      >
        <option value="lorenz">Lorenz (butterfly)</option>
        <option value="aizawa">Aizawa (toroidal)</option>
        <option value="thomas">Thomas (cyclic)</option>
        <option value="rossler">Rössler</option>
        <option value="rossler4d">Rössler 4D (hyperchaotic)</option>
        <option value="lu4d">Lü 4D (hyperchaotic)</option>
      </select>
      <span />

      <span className="label">Speed</span>
      <input
        type="range"
        min={5}
        max={1000}
        step={1}
        value={Math.round((liveSpeed ?? ap.speed) * 100)}
        onChange={(e) => uAp({ speed: clamp(Number(e.target.value), 5, 1000) / 100 })}
        className={liveSpeed !== undefined ? 'live-overlay' : ''}
      />
      <div className="flex items-center gap-1 justify-end">
        <BoundedNumberInput
          className={`input w-14 text-right ${liveSpeed !== undefined ? 'live-overlay' : ''}`}
          min={0.05}
          max={10}
          value={Number((liveSpeed ?? ap.speed).toFixed(2))}
          onChange={(v) => uAp({ speed: v })}
          title={
            liveSpeed !== undefined
              ? `Live: ${liveSpeed.toFixed(2)}× · Base: ${ap.speed.toFixed(2)}×`
              : undefined
          }
        />
        <span className="text-muted text-[11px] w-5 shrink-0">×</span>
      </div>

      <span className="label">Chaos</span>
      <input
        type="range"
        min={0}
        max={100}
        step={1}
        value={Math.round((liveChaos ?? ap.chaos) * 100)}
        onChange={(e) => uAp({ chaos: clamp(Number(e.target.value), 0, 100) / 100 })}
        title="Drives the attractor's most expressive bifurcation parameter — Lorenz ρ, Rössler c, etc. 50% = canonical chaotic regime."
        className={liveChaos !== undefined ? 'live-overlay' : ''}
      />
      <div className="flex items-center gap-1 justify-end">
        <BoundedNumberInput
          className={`input w-14 text-right ${liveChaos !== undefined ? 'live-overlay' : ''}`}
          integer={liveChaos === undefined}
          min={0}
          max={100}
          value={Math.round((liveChaos ?? ap.chaos) * 100)}
          onChange={(v) => uAp({ chaos: v / 100 })}
          title={
            liveChaos !== undefined
              ? `Live: ${Math.round(liveChaos * 100)}% · Base: ${Math.round(ap.chaos * 100)}%`
              : undefined
          }
        />
        <span className="text-muted text-[11px] w-5 shrink-0">%</span>
      </div>

      <div className="col-span-3 text-[10px] text-muted italic leading-snug">
        Multi-arg cells fan out: slot&nbsp;0=X, slot&nbsp;1=Y, slot&nbsp;2=Z,
        slot&nbsp;3={ap.type === 'rossler4d' || ap.type === 'lu4d' ? 'W' : 'speed'}.
        Single-arg cells read X only.
      </div>
      <div className="col-span-3">
        <AttractorVisual modulation={m} />
      </div>
    </div>
  )
}

// One-shot ramp modulator editor. Layout mirrors the Envelope editor so
// the two feel like siblings: sync picker on top, then the time field,
// curve, depth, and a small live visualizer.
function RampEditor({
  cell,
  u,
  isMod2
}: {
  cell: import('@shared/types').Cell
  u: CellUpdate
  isMod2?: boolean
}): JSX.Element {
  const m = cell.modulation
  // Selector returns a STABLE null when the overlay should be off
  // (Mod 2 disabled on this cell, or this editor is editing Mod 2
  // itself) — Zustand's default reference-equality then skips the
  // re-render at the engine's 30 Hz live-emit cadence. When the
  // overlay is on, the editor re-renders each live sample as
  // intended.
  const live = useStore((s) =>
    isMod2 || cell.modulation2?.enabled !== true ? null : s.mod1Live
  )
  const liveCurve = live?.rampCurvePct
  const liveDepthPct = live?.depthPct
  const liveRampMs = live?.rampMs
  // Defensive fallback — if a session predating the Ramp feature somehow
  // slips past sanitizeMetaController without a `ramp` field, use factory
  // defaults for display so the editor renders instead of blanking the app.
  const ramp = m.ramp ?? {
    rampMs: 1000,
    curvePct: 0,
    sync: 'free' as const,
    totalMs: 1000,
    mode: 'normal' as const
  }
  function uRamp(patch: Partial<typeof ramp>): void {
    u({ modulation: { ...m, ramp: { ...ramp, ...patch } } })
  }
  function uMod(patch: Partial<typeof m>): void {
    u({ modulation: { ...m, ...patch } })
  }

  // Live-progress tracking.
  //
  // We subscribe directly to `selectedCell` + the active map so the dot
  // repaints the instant the user's selected clip becomes (or stops
  // being) active. Can't rely on engine.activeSceneStartedAt because it
  // only updates for whole-scene triggers — clicking a single clip's
  // play button leaves that value stale. Instead, stamp Date.now() the
  // frame isPlaying flips on.
  const selectedCell = useStore((s) => s.selectedCell)
  const isPlaying = useStore(
    (s) =>
      !!selectedCell &&
      !!s.engine.activeBySceneAndTrack?.[selectedCell.sceneId]?.[selectedCell.trackId]
  )
  const triggerAtRef = useRef<number | null>(null)
  const wasPlayingRef = useRef(false)
  if (isPlaying && !wasPlayingRef.current) {
    triggerAtRef.current = Date.now()
  }
  if (!isPlaying && wasPlayingRef.current) {
    triggerAtRef.current = null
  }
  wasPlayingRef.current = isPlaying

  const rampLenMs =
    ramp.sync === 'free'
      ? ramp.rampMs
      : ramp.sync === 'freeSync'
        ? ramp.totalMs
        : 0 // synced — we don't have scene duration here, visualizer uses rampMs as proxy
  const lenForVis = Math.max(1, rampLenMs > 0 ? rampLenMs : ramp.rampMs)
  const [nowMs, setNowMs] = useState<number>(() => Date.now())
  // Stop the interval once the ramp is visually complete — otherwise it
  // would keep re-rendering the dot at 30 Hz forever while the cell stays
  // armed (engine keeps the cell active after the ramp; zustand no longer
  // pushes state after the output stabilizes, so our timer is the only
  // thing driving renders). Left running = pure waste.
  const triggerAtVal = triggerAtRef.current
  // Loop mode never "completes" — the timer needs to keep running
  // for the whole time the cell's playing so the dot cycles. For
  // Normal/Inverted we stop driving renders once the ramp finishes.
  const rampDoneByTime =
    ramp.mode !== 'loop' &&
    isPlaying &&
    triggerAtVal !== null &&
    lenForVis > 0 &&
    nowMs - triggerAtVal >= lenForVis
  const needsTimer = isPlaying && !rampDoneByTime
  useEffect(() => {
    if (!needsTimer) return
    const id = setInterval(() => setNowMs(Date.now()), 33)
    return () => clearInterval(id)
  }, [needsTimer])

  // In Loop mode the engine retriggers every period — the visual
  // dot mirrors that by taking progress % 1 instead of clamping.
  const rampMode = ramp.mode ?? 'normal'
  const progress =
    isPlaying && triggerAtRef.current !== null
      ? (() => {
          const raw = (nowMs - triggerAtRef.current) / lenForVis
          if (rampMode === 'loop') {
            return Math.max(0, raw % 1)
          }
          return clamp01(raw)
        })()
      : 0

  return (
    <div className="flex flex-col gap-2">
      <div className="grid grid-cols-[64px_1fr_88px] gap-x-2 gap-y-1 items-center">
        <span className="label">Sync</span>
        <select
          className="input text-[11px] py-0.5"
          value={ramp.sync}
          onChange={(e) => uRamp({ sync: e.target.value as EnvSync })}
          title={
            ramp.sync === 'synced'
              ? 'Ramp lasts the full scene duration.'
              : ramp.sync === 'freeSync'
                ? 'Ramp length = Total (ms) — independent of scene.'
                : 'Ramp length in milliseconds (Ramp time).'
          }
        >
          <option value="synced">Synced (scene)</option>
          <option value="free">Free (ms)</option>
          <option value="freeSync">Free (synced)</option>
        </select>
        <span />

        <span className="label">Mode</span>
        <select
          className="input text-[11px] py-0.5"
          value={ramp.mode ?? 'normal'}
          onChange={(e) =>
            uRamp({
              mode: e.target.value as 'normal' | 'inverted' | 'loop'
            })
          }
          title={
            'Normal: one-shot 0 → 1 (default).\n' +
            'Inverted: one-shot 1 → 0 (mirror of Normal).\n' +
            'Loop: 0 → 1 ramp repeats forever (retriggers each period).'
          }
        >
          <option value="normal">Normal</option>
          <option value="inverted">Inverted</option>
          <option value="loop">Loop</option>
        </select>
        <span />

        {ramp.sync === 'free' && (
          <>
            <span className="label">Ramp time</span>
            {/* Piecewise-linear mapping: position 0..500 = 0..5000 ms,
                500..1000 = 5000..30000 ms. The fast / "tight" range
                gets half the slider's travel so it's actually
                dialable; longer rampts stay reachable on the right. */}
            <input
              type="range"
              min={0}
              max={1000}
              step={1}
              value={rampMsToSlider(liveRampMs ?? ramp.rampMs)}
              onChange={(e) =>
                uRamp({ rampMs: sliderToRampMs(Number(e.target.value)) })
              }
              title={
                liveRampMs !== undefined
                  ? `Live: ${liveRampMs.toFixed(1)} ms · Base: ${ramp.rampMs.toFixed(1)} ms`
                  : `${ramp.rampMs.toFixed(1)} ms — slider midpoint = 5000 ms`
              }
              className={liveRampMs !== undefined ? 'live-overlay' : ''}
            />
            <div className="flex items-center gap-1 justify-end">
              <BoundedNumberInput
                className={`input w-14 text-right ${liveRampMs !== undefined ? 'live-overlay' : ''}`}
                min={0.1}
                max={300000}
                value={
                  liveRampMs !== undefined
                    ? Math.round(liveRampMs * 10) / 10
                    : ramp.rampMs
                }
                onChange={(v) => uRamp({ rampMs: v })}
                title={
                  liveRampMs !== undefined
                    ? `Live: ${liveRampMs.toFixed(1)} ms · Base: ${ramp.rampMs.toFixed(1)} ms`
                    : undefined
                }
              />
              <span className="text-muted text-[11px] w-5 shrink-0">ms</span>
            </div>
          </>
        )}
        {ramp.sync === 'freeSync' && (
          <>
            <span className="label">Total</span>
            <input
              type="range"
              min={0.1}
              max={300000}
              step={0.1}
              value={ramp.totalMs}
              onChange={(e) =>
                uRamp({ totalMs: clamp(Number(e.target.value), 0.1, 300000) })
              }
            />
            <div className="flex items-center gap-1 justify-end">
              <BoundedNumberInput
                className="input w-14 text-right"
                min={0.1}
                max={300000}
                value={ramp.totalMs}
                onChange={(v) => uRamp({ totalMs: v })}
              />
              <span className="text-muted text-[11px] w-5 shrink-0">ms</span>
            </div>
          </>
        )}

        <span className="label">Curve</span>
        <input
          type="range"
          min={-100}
          max={100}
          step={1}
          value={Math.round(liveCurve ?? ramp.curvePct)}
          onChange={(e) => uRamp({ curvePct: clamp(Number(e.target.value), -100, 100) })}
          title="-100 = ease-in (slow start) · 0 = linear · +100 = ease-out (fast start)"
          className={liveCurve !== undefined ? 'live-overlay' : ''}
        />
        <div className="flex items-center gap-1 justify-end">
          <BoundedNumberInput
            className={`input w-14 text-right ${liveCurve !== undefined ? 'live-overlay' : ''}`}
            min={-100}
            max={100}
            value={
              liveCurve !== undefined
                ? Math.round(liveCurve * 10) / 10
                : ramp.curvePct
            }
            onChange={(v) => uRamp({ curvePct: v })}
            title={
              liveCurve !== undefined
                ? `Live: ${liveCurve.toFixed(1)} · Base: ${ramp.curvePct}`
                : undefined
            }
          />
          <span className="text-muted text-[11px] w-5 shrink-0">%</span>
        </div>

        <span className="label">Depth</span>
        <input
          type="range"
          min={0}
          max={100}
          step={1}
          value={liveDepthPct ?? m.depthPct}
          onChange={(e) => uMod({ depthPct: clamp(Number(e.target.value), 0, 100) })}
          className={liveDepthPct !== undefined ? 'live-overlay' : ''}
        />
        <div className="flex items-center gap-1 justify-end">
          <BoundedNumberInput
            className={`input w-14 text-right ${liveDepthPct !== undefined ? 'live-overlay' : ''}`}
            min={0}
            max={100}
            value={
              liveDepthPct !== undefined
                ? Math.round(liveDepthPct * 10) / 10
                : m.depthPct
            }
            onChange={(v) => uMod({ depthPct: v })}
            title={
              liveDepthPct !== undefined
                ? `Live: ${liveDepthPct.toFixed(1)} · Base: ${m.depthPct}`
                : undefined
            }
          />
          <span className="text-muted text-[11px] w-5 shrink-0">%</span>
        </div>
      </div>

      <div className="text-[10px] text-muted italic">
        Ramp goes 0 → target in the configured time, then holds. Once the
        ramp completes the modulator becomes neutral (output = value).
      </div>

      {/* Visualizer — same spec as LFO + Envelope: gradient stroke,
          depth-reactive width + glow, full-width frame matching the
          rest of the modulator panel. Replaces the older squashed
          curve-only readout. */}
      <RampVisual
        ramp={ramp}
        depthPct={cell.modulation.depthPct}
        progress={isPlaying ? progress : undefined}
      />
    </div>
  )
}

// Tiny SVG visualizer. Draws the chosen power curve from (0,0) → (1,1) and
// a playhead dot at `progress ∈ [0, 1]` on that curve. Purely presentational.
function RampVisualizer({
  curvePct,
  progress
}: {
  curvePct: number
  progress: number
}): JSX.Element {
  // Mirror engine.ts's computeRampGain — rotationally-symmetric ease-in /
  // ease-out pair so ±curve produce mirror-image shapes in the view.
  const k = 1 + (Math.abs(curvePct) / 100) * 4
  function gain(t: number): number {
    if (curvePct === 0) return t
    return curvePct > 0 ? 1 - Math.pow(1 - t, k) : Math.pow(t, k)
  }
  const W = 200
  const H = 50
  const pad = 4
  const innerW = W - pad * 2
  const innerH = H - pad * 2
  const N = 40
  const pts: string[] = []
  for (let i = 0; i <= N; i++) {
    const x = i / N
    const y = gain(x)
    pts.push(`${pad + x * innerW},${pad + (1 - y) * innerH}`)
  }
  const dotX = pad + progress * innerW
  const dotY = pad + (1 - gain(progress)) * innerH
  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      className="w-full border border-border rounded-sm bg-panel2"
      style={{ height: H }}
      aria-label="Ramp curve visualizer"
    >
      {/* 0/1 gridlines */}
      <line x1={pad} y1={pad + innerH} x2={pad + innerW} y2={pad + innerH}
        stroke="rgb(var(--c-border))" strokeWidth={0.5} />
      <line x1={pad} y1={pad} x2={pad + innerW} y2={pad}
        stroke="rgb(var(--c-border))" strokeWidth={0.5} strokeDasharray="2 3" />
      <polyline
        points={pts.join(' ')}
        fill="none"
        stroke="rgb(var(--c-accent2))"
        strokeWidth={1.5}
      />
      {progress > 0 && (
        <>
          {/* Soft glow ring so the dot is easy to track against the curve. */}
          <circle
            cx={dotX}
            cy={dotY}
            r={6}
            fill="rgb(var(--c-accent) / 0.25)"
          />
          <circle cx={dotX} cy={dotY} r={3.5} fill="rgb(var(--c-accent))" />
        </>
      )}
    </svg>
  )
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v
}

function EnvelopeEditor({
  cell,
  u,
  isMod2
}: {
  cell: import('@shared/types').Cell
  u: CellUpdate
  isMod2?: boolean
}): JSX.Element {
  // Selector returns a STABLE null when the overlay should be off
  // (Mod 2 disabled on this cell, or this editor is editing Mod 2
  // itself) — Zustand's default reference-equality then skips the
  // re-render at the engine's 30 Hz live-emit cadence. When the
  // overlay is on, the editor re-renders each live sample as
  // intended.
  const live = useStore((s) =>
    isMod2 || cell.modulation2?.enabled !== true ? null : s.mod1Live
  )
  const liveSus = live?.envelopeSustain
  const liveDepthPct = live?.depthPct
  const m = cell.modulation
  const env = m.envelope
  function uEnv(patch: Partial<typeof env>): void {
    u({ modulation: { ...m, envelope: { ...env, ...patch } } })
  }
  function uMod(patch: Partial<typeof m>): void {
    u({ modulation: { ...m, ...patch } })
  }
  // Live progress dot — same trick as RampEditor. Stamp triggerAt
  // when isPlaying flips on, integrate at 30 Hz while the envelope's
  // total time hasn't yet elapsed, pass 0..1 progress to the visual.
  const selectedCell = useStore((s) => s.selectedCell)
  const isPlaying = useStore(
    (s) =>
      !!selectedCell &&
      !!s.engine.activeBySceneAndTrack?.[selectedCell.sceneId]?.[selectedCell.trackId]
  )
  const envTriggerAtRef = useRef<number | null>(null)
  const envWasPlayingRef = useRef(false)
  if (isPlaying && !envWasPlayingRef.current) envTriggerAtRef.current = Date.now()
  if (!isPlaying && envWasPlayingRef.current) envTriggerAtRef.current = null
  envWasPlayingRef.current = isPlaying
  // Total envelope time in ms — sync-mode aware. For synced mode we
  // need the active scene's duration to convert the A/D/S/R
  // fractions into real ms. We grab it from the selected cell's
  // scene (the same one the inspector is displaying).
  const sceneDurMs = useStore((st) => {
    const cellSel = st.selectedCell
    if (!cellSel) return 0
    const sc = st.session.scenes.find((x) => x.id === cellSel.sceneId)
    return sc ? sc.durationSec * 1000 : 0
  })
  const envTotalMs =
    env.sync === 'synced'
      ? Math.max(
          1,
          (env.attackPct + env.decayPct + env.sustainPct + env.releasePct) *
            sceneDurMs
        )
      : env.sync === 'freeSync'
        ? Math.max(1, env.totalMs)
        : Math.max(
            1,
            env.attackMs + env.decayMs + env.sustainMs + env.releaseMs
          )
  const [envNowMs, setEnvNowMs] = useState<number>(() => Date.now())
  const envProgress01 =
    isPlaying && envTriggerAtRef.current !== null
      ? clamp01((envNowMs - envTriggerAtRef.current) / envTotalMs)
      : 0
  const envNeedsTimer = isPlaying && envProgress01 < 1
  useEffect(() => {
    if (!envNeedsTimer) return
    const id = setInterval(() => setEnvNowMs(Date.now()), 33)
    return () => clearInterval(id)
  }, [envNeedsTimer])

  // Percentage modes (synced, freeSync) edit stages as 0.01..100 %; free
  // mode uses absolute ms 0..10 000. Internally the Pct fields always live
  // as 0..1 fractions, Ms fields as ms.
  const pctMode = env.sync === 'synced' || env.sync === 'freeSync'
  const displayMin = pctMode ? 0.01 : 0
  const displayMax = pctMode ? 100 : 10000
  const displayStep = pctMode ? 0.01 : 10
  const unit = pctMode ? '%' : 'ms'
  const scaleToDisplay = (v: number): number => (pctMode ? v * 100 : v)
  const displayToScale = (v: number): number => (pctMode ? v / 100 : v)

  return (
    <div className="flex flex-col gap-2">
      <div className="grid grid-cols-[64px_1fr_88px] gap-x-2 gap-y-1 items-center">
        <span className="label">Sync</span>
        <select
          className="input text-[11px] py-0.5"
          value={env.sync}
          onChange={(e) => uEnv({ sync: e.target.value as EnvSync })}
          title={
            env.sync === 'synced'
              ? 'Times are fractions of scene duration (A+D+S+R ≤ 100%).'
              : env.sync === 'freeSync'
                ? 'Times are fractions of Total (ms) — independent of scene.'
                : 'Times in milliseconds (each max 10000ms).'
          }
        >
          <option value="synced">Synced (scene)</option>
          <option value="free">Free (ms)</option>
          <option value="freeSync">Free (synced)</option>
        </select>
        <span />

        {env.sync === 'freeSync' && (
          <>
            <span className="label">Total</span>
            <input
              type="range"
              min={0.1}
              max={300000}
              step={0.1}
              value={env.totalMs}
              onChange={(e) =>
                uEnv({ totalMs: clamp(Number(e.target.value), 0.1, 300000) })
              }
            />
            <div className="flex items-center gap-1 justify-end">
              <BoundedNumberInput
                className="input w-14 text-right"
                min={0.1}
                max={300000}
                value={env.totalMs}
                onChange={(v) => uEnv({ totalMs: v })}
              />
              <span className="text-muted text-[11px] w-5 shrink-0">ms</span>
            </div>
          </>
        )}

        <span className="label">Depth</span>
        <input
          type="range"
          min={0}
          max={100}
          step={1}
          value={liveDepthPct ?? m.depthPct}
          onChange={(e) => uMod({ depthPct: clamp(Number(e.target.value), 0, 100) })}
          className={liveDepthPct !== undefined ? 'live-overlay' : ''}
        />
        <div className="flex items-center gap-1 justify-end">
          <BoundedNumberInput
            className={`input w-14 text-right ${liveDepthPct !== undefined ? 'live-overlay' : ''}`}
            min={0}
            max={100}
            value={
              liveDepthPct !== undefined
                ? Math.round(liveDepthPct * 10) / 10
                : m.depthPct
            }
            onChange={(v) => uMod({ depthPct: v })}
            title={
              liveDepthPct !== undefined
                ? `Live: ${liveDepthPct.toFixed(1)} · Base: ${m.depthPct}`
                : undefined
            }
          />
          <span className="text-muted text-[11px] w-5 shrink-0">%</span>
        </div>
      </div>

      {(['attack', 'decay', 'sustain', 'release'] as const).map((seg) => {
        const key = pctMode ? (`${seg}Pct` as const) : (`${seg}Ms` as const)
        const val = env[key] as number
        const disp = scaleToDisplay(val)
        return (
          <div
            key={seg}
            className="grid grid-cols-[64px_1fr_88px] gap-x-2 items-center"
          >
            <span className="label capitalize">{seg}</span>
            <input
              type="range"
              min={displayMin}
              max={displayMax}
              step={displayStep}
              value={disp}
              onChange={(e) => {
                const d = clamp(Number(e.target.value), displayMin, displayMax)
                uEnv({ [key]: displayToScale(d) } as unknown as Partial<typeof env>)
              }}
            />
            <div className="flex items-center gap-1 justify-end">
              <BoundedNumberInput
                className="input w-14 text-right"
                min={displayMin}
                max={displayMax}
                value={disp}
                onChange={(v) =>
                  uEnv({ [key]: displayToScale(v) } as unknown as Partial<typeof env>)
                }
              />
              <span className="text-muted text-[11px] w-5 shrink-0">{unit}</span>
            </div>
          </div>
        )
      })}

      <div className="grid grid-cols-[64px_1fr_88px] gap-x-2 items-center">
        <span className="label">Sus lvl</span>
        <input
          type="range"
          min={0}
          max={100}
          step={1}
          value={Math.round((liveSus ?? env.sustainLevel) * 100)}
          onChange={(e) =>
            uEnv({ sustainLevel: clamp(Number(e.target.value), 0, 100) / 100 })
          }
          className={liveSus !== undefined ? 'live-overlay' : ''}
        />
        <div className="flex items-center gap-1 justify-end">
          <BoundedNumberInput
            className={`input w-14 text-right ${liveSus !== undefined ? 'live-overlay' : ''}`}
            min={0}
            max={100}
            value={Math.round((liveSus ?? env.sustainLevel) * 100)}
            onChange={(v) => uEnv({ sustainLevel: v / 100 })}
            title={
              liveSus !== undefined
                ? `Live: ${Math.round(liveSus * 100)}% · Base: ${Math.round(env.sustainLevel * 100)}%`
                : undefined
            }
          />
          <span className="text-muted text-[11px] w-5 shrink-0">%</span>
        </div>
      </div>

      <div className="text-[10px] text-muted">
        {pctMode
          ? env.sync === 'freeSync'
            ? 'A+D+S+R fractions auto-normalize to Total (ms).'
            : 'A+D+S+R fractions are auto-normalized if they exceed 100% of scene duration.'
          : 'Each stage in milliseconds (0–10 000).'}{' '}
        Envelope applies to every space-separated value in the clip.
      </div>

      {/* ADSR visual — reacts to all four stage times + sustain level
          + modulation depth. Drag any of them and the curve reshapes
          immediately so the user can see the envelope's geometry. */}
      <EnvelopeVisual
        envelope={env}
        depthPct={cell.modulation.depthPct}
        progress={isPlaying ? envProgress01 : undefined}
      />
      {/* Live total-duration readout. Sync-mode aware: synced uses
          scene duration × Σstages, freeSync uses totalMs, free
          sums the four stages directly. Updates in real time as
          the user adjusts any time field. */}
      <div className="text-[10px] text-muted text-center">
        Envelope time:{' '}
        <span className="text-text font-mono">
          {formatEnvelopeTime(envTotalMs)}
        </span>
      </div>
    </div>
  )
}

/** Format a duration in ms as a readable string. Switches units
 *  automatically so the readout stays compact: `123 ms`, `2.45 s`,
 *  `1:23.4` for longer envelopes. */
function formatEnvelopeTime(ms: number): string {
  const safe = Math.max(0, ms)
  if (safe < 1000) return `${Math.round(safe)} ms`
  if (safe < 60000) return `${(safe / 1000).toFixed(2)} s`
  const totalSec = safe / 1000
  const min = Math.floor(totalSec / 60)
  const sec = totalSec - min * 60
  return `${min}:${sec.toFixed(1).padStart(4, '0')}`
}

function Section({
  title,
  children,
  rightContent
}: {
  title: string
  children: React.ReactNode
  // Optional inline content rendered to the right of the title on
  // the same row. Used by the multi-arg Value editor to show its
  // "Auto-prefix:" badges next to the section header instead of
  // wasting a full row on them.
  rightContent?: React.ReactNode
}): JSX.Element {
  return (
    <div className="flex flex-col gap-1 pt-2 border-t border-border first:border-t-0 first:pt-0">
      <div className="flex items-center gap-2 min-w-0">
        <span className="label shrink-0">{title}</span>
        {rightContent && <span className="flex items-center gap-1 min-w-0 truncate">{rightContent}</span>}
      </div>
      {children}
    </div>
  )
}

// Click-to-view collapsible section. Same visual shape as `Section`
// but the header is a button that toggles the body's visibility.
// Starts EXPANDED — the user clicks the chevron / title to collapse,
// then the section's body hides. Differs from `CollapsibleSection`:
//   - no enable/disable checkbox (no engine-state semantics);
//   - the underlying setting is always "on" — this only hides the
//     editing chrome to declutter the inspector.
// Local component state; doesn't persist across navigations (each
// time you open the inspector, the section re-expands — matches the
// "always on by default" promise).
function CollapsibleViewSection({
  title,
  rightContent,
  headerLeft,
  forceCollapsed,
  headerEnd,
  children
}: {
  title: string
  rightContent?: React.ReactNode
  // Optional control rendered BEFORE the chevron / title on the
  // header row. DEPRECATED for new sections — `headerEnd` parks
  // the same kind of control at the far right of the row so
  // chevrons stay column-aligned across every collapsible section
  // in the inspector. Kept here so older callers still compile.
  headerLeft?: React.ReactNode
  // Optional control rendered AT THE FAR RIGHT of the header row,
  // OUTSIDE the toggle button. Used by the Destination section's
  // OSC Output checkbox so it sits flush right and the chevron
  // stays in the leftmost column, aligned with every other section's
  // chevron in the cell inspector. Clicks on this slot don't bubble
  // up to the toggle.
  headerEnd?: React.ReactNode
  // When true, the section is forced collapsed regardless of the
  // user's local open state. Used to auto-collapse Destination + OSC
  // Address when the cell's OSC Output is disabled. The chevron
  // greys out so the user knows clicking won't help.
  forceCollapsed?: boolean
  children: React.ReactNode
}): JSX.Element {
  const [open, setOpen] = useState(true)
  const effectiveOpen = forceCollapsed ? false : open
  return (
    <div className="flex flex-col gap-1 pt-2 border-t border-border first:border-t-0 first:pt-0">
      <div className="flex items-center gap-2 min-w-0">
        {headerLeft && (
          // Stop click propagation so toggling the headerLeft
          // checkbox doesn't also flip the collapse state via the
          // toggle button below.
          <span
            onClick={(e) => e.stopPropagation()}
            className="shrink-0 flex items-center"
          >
            {headerLeft}
          </span>
        )}
        <button
          type="button"
          className={`flex flex-1 items-center gap-2 min-w-0 text-left bg-transparent border-0 p-0 select-none ${
            forceCollapsed ? 'cursor-default opacity-60' : 'cursor-pointer hover:opacity-80'
          }`}
          onClick={() => {
            if (forceCollapsed) return
            setOpen((v) => !v)
          }}
          title={
            forceCollapsed
              ? 'Section is auto-collapsed because OSC Output is disabled'
              : effectiveOpen
                ? 'Click to collapse this section'
                : 'Click to expand this section'
          }
        >
          {/* Chevron — same character set the Pool's template chevrons
              use so the affordance reads consistently. */}
          <span className="text-muted text-[12px] font-bold leading-none w-3 shrink-0">
            {effectiveOpen ? '▾' : '▸'}
          </span>
          <span className="label shrink-0">{title}</span>
          {rightContent && (
            <span className="flex items-center gap-1 min-w-0 truncate">
              {rightContent}
            </span>
          )}
        </button>
        {headerEnd && (
          // Stop click propagation so toggling the headerEnd
          // checkbox doesn't flip the collapse state via the
          // toggle button.
          <span
            onClick={(e) => e.stopPropagation()}
            className="shrink-0 flex items-center"
          >
            {headerEnd}
          </span>
        )}
      </div>
      {effectiveOpen && children}
    </div>
  )
}

// Shows only the enable checkbox when disabled; expands to reveal children when on.
// `headerRight` is an optional slot rendered aligned to the right of the title.
function CollapsibleSection({
  title,
  titleTooltip,
  enabled,
  onToggle,
  headerRight,
  children
}: {
  title: string
  // Optional hover-only help text — rendered as the `title` attr on
  // the section heading so the description shows up as a native
  // tooltip on hover, INSTEAD of taking up vertical space inside the
  // expanded body. Use this for sections whose description is
  // explanatory rather than action-driving (e.g. Scaling).
  titleTooltip?: string
  enabled: boolean
  onToggle: (v: boolean) => void
  headerRight?: React.ReactNode
  children: React.ReactNode
}): JSX.Element {
  // Rich themes wrap each section in a soft rounded card; classic
  // themes keep the existing top-border divider. The CSS class
  // `.rich-card` provides background, border, padding, and an inner
  // shadow that reads as "small instrument-panel module".
  const rich = useStore((s) => isRichTheme(s.theme))
  const wrapClass = rich
    ? 'rich-card flex flex-col gap-1'
    : 'flex flex-col gap-1 pt-2 border-t border-border'
  return (
    <div className={wrapClass}>
      <div className="flex items-center gap-2">
        <label className="flex items-center gap-2 cursor-pointer select-none">
          <input
            type="checkbox"
            checked={enabled}
            onChange={(e) => onToggle(e.target.checked)}
          />
          <span className="label" title={titleTooltip}>
            {title}
          </span>
          {!enabled && <span className="text-[10px] text-muted">(click to enable)</span>}
        </label>
        <div className="flex-1" />
        {headerRight}
      </div>
      {enabled && <div className="flex flex-col gap-2 mt-1">{children}</div>}
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────
// Sequencer preview building blocks (Rainbow-Circuit-flavoured).
//
// Each step in a row is laid across the rainbow wheel so adjacent
// cells phase smoothly through hue space. The visual states (hit /
// playhead) bloom in the cell's hue, with a soft halo that bleeds
// onto the next-door cell — Tinge-style colour overlap. Animations
// + transitions live in styles.css under the .rc-cell rules; this
// component just renders the divs and sets `--rc-hue` per cell.
// ─────────────────────────────────────────────────────────────────

/** Hue for step `i` of `n`, spread across the full rainbow.
 *  Slightly offset so step 0 sits at "warm orange" rather than pure
 *  red — matches the existing accent palette better. */
function hueForStep(i: number, n: number): number {
  const wrap = Math.max(1, n)
  return (((i / wrap) * 360 + 18) % 360 + 360) % 360
}

/** Rainbow-Circuit step cell. Pure presentational — caller decides
 *  hit/now booleans, optional round variant, and per-cell hue (via
 *  `hue` prop, falling back to step-index spread). */
function RcCell({
  hue,
  hit,
  now,
  round,
  faded,
  title
}: {
  hue: number
  hit: boolean
  now: boolean
  round?: boolean
  faded?: boolean
  title?: string
}): JSX.Element {
  const cls = ['rc-cell']
  if (round) cls.push('is-round')
  if (faded) cls.push('is-faded')
  if (hit) cls.push('is-hit')
  if (now) cls.push('is-now')
  return (
    <div
      className={cls.join(' ')}
      style={{ ['--rc-hue' as string]: String(hue) }}
      title={title}
    />
  )
}

// Euclidean pattern preview — row of N rainbow cells; hits glow in
// their hue, misses sit ghosted; the playhead bumps + pulses.
function EuclideanPreview({
  steps,
  pulses,
  rotation,
  currentStep
}: {
  steps: number
  pulses: number
  rotation: number
  currentStep: number
}): JSX.Element {
  const s = Math.max(1, Math.min(16, Math.floor(steps)))
  const p = Math.max(0, Math.min(s, Math.floor(pulses)))
  const r = Math.max(0, Math.min(s - 1, Math.floor(rotation)))
  const pat = euclidean(p, s, r)
  return (
    <div className="mt-2 flex items-center gap-2">
      <span className="label shrink-0">Pattern</span>
      <div className="flex gap-[5px] flex-wrap items-center">
        {pat.map((hit, i) => (
          <RcCell
            key={`${i}-${currentStep === i ? 'now' : ''}`}
            hue={hueForStep(i, s)}
            hit={hit}
            now={i === currentStep}
            title={`Step ${i + 1} — ${hit ? 'hit' : 'rest'}`}
          />
        ))}
      </div>
    </div>
  )
}

// Three-row preview for Polyrhythm. Ring A and Ring B each sit in
// a single tonal family — A in the warm half of the wheel, B in the
// cool half — so the eye can tell which ring fires what without
// reading labels. The Combined row spreads the full rainbow so the
// emergent gate pattern reads at a glance, especially with XOR
// (which is otherwise hard to predict).
function PolyrhythmPreview({
  steps,
  ringALength,
  ringBLength,
  combine,
  currentStep
}: {
  steps: number
  ringALength: number
  ringBLength: number
  combine: SeqCombine
  currentStep: number
}): JSX.Element {
  const s = Math.max(1, Math.min(16, Math.floor(steps)))
  const a = Math.max(1, Math.min(16, Math.floor(ringALength)))
  const b = Math.max(1, Math.min(16, Math.floor(ringBLength)))
  const ringA = Array.from({ length: s }, (_, i) => i % a === 0)
  const ringB = Array.from({ length: s }, (_, i) => i % b === 0)
  const combined = Array.from({ length: s }, (_, i) =>
    polyrhythmGate(i, a, b, combine)
  )
  // Two complementary tonal families: warm-orange for Ring A, cyan-blue
  // for Ring B. The combined row uses the full rainbow spread.
  const hueA = (i: number): number => 18 + (i / Math.max(1, s)) * 60 // 18..78
  const hueB = (i: number): number => 190 + (i / Math.max(1, s)) * 60 // 190..250
  const Row = ({
    pat,
    label,
    hueFn
  }: {
    pat: boolean[]
    label: string
    hueFn: (i: number) => number
  }): JSX.Element => (
    <div className="flex items-center gap-2">
      <span className="label shrink-0 w-14 text-right">{label}</span>
      <div className="flex gap-[5px] flex-wrap items-center">
        {pat.map((hit, i) => (
          <RcCell
            key={`${i}-${currentStep === i ? 'now' : ''}`}
            hue={hueFn(i)}
            hit={hit}
            now={i === currentStep}
            round
            title={`Step ${i + 1} — ${hit ? 'hit' : 'rest'}`}
          />
        ))}
      </div>
    </div>
  )
  return (
    <div className="mt-2 flex flex-col gap-1.5">
      <Row pat={ringA} label="Ring A" hueFn={hueA} />
      <Row pat={ringB} label="Ring B" hueFn={hueB} />
      <Row
        pat={combined}
        label="Combined"
        hueFn={(i) => hueForStep(i, s)}
      />
    </div>
  )
}

// Density preview — each step is a glass tube whose fill height
// reflects how "easy" that step is to fire (1 - personality). Hits
// are tinted in their hue and gain a halo; misses fade to grey. As
// the user drags Density, the tubes recolour smoothly because the
// hit/miss class flips with a 220ms transition under the hood.
function DensityPreview({
  steps,
  seed,
  density,
  currentStep
}: {
  steps: number
  seed: number
  density: number
  currentStep: number
}): JSX.Element {
  const s = Math.max(1, Math.min(16, Math.floor(steps)))
  const d = Math.max(0, Math.min(100, density)) / 100
  const cells = Array.from({ length: s }, (_, i) => {
    const personality = stepHash(i, seed)
    const hit = personality < d
    return { personality, hit }
  })
  return (
    <div className="mt-2 flex items-end gap-2">
      <span className="label shrink-0 mb-1">Pattern</span>
      <div className="flex gap-[5px] flex-wrap items-end">
        {cells.map(({ personality, hit }, i) => {
          const heightPct = Math.round((1 - personality) * 100)
          const hue = hueForStep(i, s)
          const cls = ['rc-bar-cell']
          if (hit) cls.push('is-hit')
          if (i === currentStep) cls.push('is-now')
          return (
            <div
              key={`${i}-${currentStep === i ? 'now' : ''}`}
              className={cls.join(' ')}
              style={{ ['--rc-hue' as string]: String(hue) }}
              title={`Step ${i + 1} — personality ${personality.toFixed(2)}, ${hit ? 'hit' : 'rest'}`}
            >
              <div
                className={hit ? 'rc-bar-fill' : 'rc-bar-fill is-rest'}
                style={{ height: `${heightPct}%` }}
              />
            </div>
          )
        })}
      </div>
    </div>
  )
}

// Cellular preview — top row is the live state; the eight rows below
// are the next-generation projections stacked downward. Older rows
// fade toward the background so the eye sees evolutionary direction
// at a glance, while the topmost row carries the playhead glow.
// Live-animating cellular preview. When the Seed LFO is on (depth>0),
// the displayed seed value drifts via the same sine formula the
// engine uses for `modulatedCellSeed`, and the rendered row patterns
// follow — so what you SEE in the preview matches what the engine
// WOULD play if the sequencer were triggered now.
function useCellularModulatedSeed(
  baseSeed: number,
  depth: number,
  rate: number
): number {
  const [, tick] = useState(0)
  useEffect(() => {
    if (depth <= 0) return
    const id = setInterval(() => tick((n) => n + 1), 60)
    return () => clearInterval(id)
  }, [depth, rate])
  if (depth <= 0) return baseSeed
  const d = Math.max(0, Math.min(100, depth)) / 100
  const r = Math.max(0.01, Math.min(10, rate))
  const phase = (Date.now() / 1000) * r * Math.PI * 2
  const offset = Math.round(Math.sin(phase) * d * 32767)
  return Math.max(0, Math.min(65535, baseSeed + offset))
}

function CellularPreview({
  steps,
  rule,
  cellSeed,
  seedLfoDepth,
  seedLfoRate,
  currentStep
}: {
  steps: number
  rule: number
  cellSeed: number
  seedLfoDepth: number
  seedLfoRate: number
  currentStep: number
}): JSX.Element {
  const s = Math.max(1, Math.min(16, Math.floor(steps)))
  // Modulated seed — matches the engine's `modulatedCellSeed` so the
  // preview shows EXACTLY the pattern the engine would play. When
  // the LFO is off, `effectiveSeed === cellSeed` (no animation).
  const effectiveSeed = useCellularModulatedSeed(cellSeed, seedLfoDepth, seedLfoRate)
  // 3 generations shown — top row is the current cycle, two below
  // are projected futures. Was 4; user asked for less vertical so
  // the Behaviour row stays in view without scrolling.
  const generations: number[] = [cellularInitialRow(effectiveSeed, s)]
  for (let g = 1; g < 3; g++) {
    generations.push(evolveCellular(generations[g - 1], rule, s))
  }
  return (
    <div className="mt-2 flex items-start gap-2">
      <span className="label shrink-0">Pattern</span>
      <div className="flex flex-col gap-[3px]">
        {generations.map((row, gi) => {
          const isTop = gi === 0
          // Older rows fade toward the panel background so the eye
          // reads downward = older. Top row stays full-strength and
          // is the only one that gets the live playhead bump.
          const rowOpacity = isTop ? 1 : Math.max(0.25, 1 - gi / 5)
          return (
            <div key={gi} className="flex gap-[5px]" style={{ opacity: rowOpacity }}>
              {Array.from({ length: s }, (_, i) => {
                const hit = ((row >>> i) & 1) === 1
                return (
                  <RcCell
                    key={`${i}-${isTop && currentStep === i ? 'now' : ''}`}
                    hue={hueForStep(i, s)}
                    hit={hit}
                    now={isTop && i === currentStep}
                    faded={!isTop}
                    title={`Gen ${gi}, step ${i + 1} — ${hit ? 'on' : 'off'}`}
                  />
                )
              })}
            </div>
          )
        })}
      </div>
    </div>
  )
}

// Drift preview — clock-ring of rainbow dots arranged around a
// circle, with the playhead glowing in its current-step's hue and
// the previous N positions fading back behind it as a comet trail.
// Reads as a watch face the user can stare at while drift wanders.
function DriftPreview({
  steps,
  currentStep
}: {
  steps: number
  currentStep: number
}): JSX.Element {
  const s = Math.max(1, Math.min(16, Math.floor(steps)))
  // Track the last N playhead positions in a small ring buffer so we
  // can render a fading comet-trail behind the active dot. Using a
  // ref + state combo keeps the trail across renders without forcing
  // the whole inspector to re-render every tick.
  const trailRef = useRef<number[]>([])
  // currentStep changes ~every step boundary; push it onto the trail.
  // De-dup consecutive identical positions so a paused playhead
  // doesn't fill the trail with one repeated value.
  useEffect(() => {
    if (currentStep < 0) {
      trailRef.current = []
      return
    }
    const last = trailRef.current[trailRef.current.length - 1]
    if (last === currentStep) return
    trailRef.current = [...trailRef.current, currentStep].slice(-6)
  }, [currentStep])
  // Position N dots evenly around a circle. Radius + size chosen so
  // 16 dots still don't overlap; the SVG keeps the layout
  // 100 px ring centred horizontally — label sits above so the
  // whole assembly is symmetric across the inspector width. Was
  // 86 px sideways; this is just enough bigger to read without
  // dominating vertical space.
  const ringSize = 100
  const cx = ringSize / 2
  const cy = ringSize / 2
  const r = ringSize / 2 - 10
  const dotRadius = 4.5
  return (
    <div className="mt-2 flex flex-col items-center justify-center gap-1">
      <span className="label">Playhead</span>
      <svg
        width={ringSize}
        height={ringSize}
        viewBox={`0 0 ${ringSize} ${ringSize}`}
        style={{ overflow: 'visible' }}
      >
        {/* Faint guide circle so the eye reads "ring" even when no
            dot is lit at a given angle. Opacity-low so it doesn't
            dominate. */}
        <circle
          cx={cx}
          cy={cy}
          r={r}
          fill="none"
          stroke="rgb(var(--c-border) / 0.6)"
          strokeWidth={1}
        />
        {Array.from({ length: s }, (_, i) => {
          // Step 0 sits at 12 o'clock (-π/2 offset).
          const ang = (i / s) * Math.PI * 2 - Math.PI / 2
          const dx = cx + r * Math.cos(ang)
          const dy = cy + r * Math.sin(ang)
          const hue = hueForStep(i, s)
          const isNow = i === currentStep
          // Trail position 0..n-1 (smaller idx = older)
          const trailIdx = trailRef.current.indexOf(i)
          const trailLen = trailRef.current.length
          const isTrail = trailIdx >= 0 && !isNow
          const trailOpacity =
            isTrail && trailLen > 0
              ? 0.18 + ((trailIdx + 1) / trailLen) * 0.4
              : 0.85
          return (
            <g key={`${i}-${isNow ? 'now' : ''}`}>
              <circle
                cx={dx}
                cy={dy}
                r={dotRadius}
                fill={
                  isNow
                    ? `hsl(${hue} 90% 65%)`
                    : isTrail
                      ? `hsl(${hue} 70% 55%)`
                      : `hsl(${hue} 35% 35%)`
                }
                stroke={
                  isNow
                    ? `hsl(${hue} 95% 75%)`
                    : `hsl(${hue} 50% 35% / 0.7)`
                }
                strokeWidth={isNow ? 2 : 1}
                opacity={isNow ? 1 : isTrail ? trailOpacity : 0.65}
                style={{
                  filter: isNow
                    ? `drop-shadow(0 0 6px hsl(${hue} 95% 70% / 0.9)) drop-shadow(0 0 14px hsl(${hue} 90% 65% / 0.5))`
                    : isTrail
                      ? `drop-shadow(0 0 3px hsl(${hue} 75% 55% / ${trailOpacity * 0.6}))`
                      : 'none',
                  transition:
                    'r 220ms ease-out, opacity 220ms ease-out, fill 220ms ease-out'
                }}
              >
                <title>{`Step ${i + 1}`}</title>
              </circle>
            </g>
          )
        })}
        {/* Centre marker — a small dim disc that hints "this is a
            wheel" on first read. */}
        <circle
          cx={cx}
          cy={cy}
          r={2.5}
          fill="rgb(var(--c-muted) / 0.5)"
        />
      </svg>
    </div>
  )
}

// Ratchet preview — each step is a square framing a small dot whose
// size grows with the burst probability. The bigger / brighter the
// dot, the more likely the step will fan out into a sub-pulse burst.
// The label above the row spells out "P × 2..N" so the numeric meaning
// stays at a glance.
function RatchetPreview({
  steps,
  ratchetProb,
  ratchetMaxDiv,
  ratchetVariation,
  seed,
  currentStep
}: {
  steps: number
  ratchetProb: number
  ratchetMaxDiv: number
  ratchetVariation: number
  seed: number
  currentStep: number
}): JSX.Element {
  const s = Math.max(1, Math.min(16, Math.floor(steps)))
  const variation01 = Math.max(0, Math.min(100, ratchetVariation)) / 100
  return (
    <div className="mt-2 flex flex-col items-center gap-1">
      <span className="label whitespace-nowrap">
        {variation01 > 0
          ? `Bursts varied · ${Math.round(variation01 * 100)}% spread`
          : `Bursts ${Math.round(ratchetProb)}% · ×2..${ratchetMaxDiv}`}
      </span>
      <div className="grid grid-cols-8 gap-[5px] items-center justify-items-center">
        {Array.from({ length: s }, (_, i) => {
          const hue = hueForStep(i, s)
          const isNow = i === currentStep
          const cls = ['rc-ratchet-cell']
          if (isNow) cls.push('is-now')
          // Per-step prob + maxDiv — mirrors engine `ratchetStepParams`.
          // At variation=0, every step uses the global value. At 100,
          // each step's hash drives its own.
          const probHash = stepHash(i, seed)
          const divHash = stepHash(i + 1000, seed * 7 + 13)
          const stepProb =
            (1 - variation01) * ratchetProb + variation01 * probHash * 100
          const stepDiv = Math.max(
            2,
            Math.min(
              8,
              Math.round(
                (1 - variation01) * ratchetMaxDiv + variation01 * (2 + divHash * 6)
              )
            )
          )
          const stepProbClamped = Math.max(0, Math.min(100, stepProb))
          // Dot size encodes the per-step probability so the variation
          // visibly translates into different dot sizes per step.
          const dotPx = 3 + Math.round((stepProbClamped / 100) * 11)
          return (
            <div
              key={`${i}-${isNow ? 'now' : ''}`}
              className={cls.join(' ')}
              style={{ ['--rc-hue' as string]: String(hue) }}
              title={`Step ${i + 1} — ${Math.round(stepProbClamped)}% · ×2..${stepDiv}`}
            >
              <div
                className="rc-ratchet-dot"
                style={{
                  width: `${dotPx}px`,
                  height: `${dotPx}px`,
                  boxShadow: isNow
                    ? `0 0 8px hsl(${hue} 95% 70% / 0.9)`
                    : stepProbClamped > 0
                      ? `0 0 4px hsl(${hue} 80% 60% / 0.5)`
                      : 'none'
                }}
              />
            </div>
          )
        })}
      </div>
    </div>
  )
}

// Bounce preview — animated. Static arcs (one per bounce, geometrically
// shrinking widths + decaying heights) form the visual scaffolding;
// over them, an SVG ball traces the active arc in real time, splashing
// into a coloured ring at every landing. Timing is matched to the
// engine's actual per-arc duration (derived from the cell's sync
// mode + global BPM) so what you see is what you hear.
function BouncePreview({
  cell,
  currentStep
}: {
  cell: import('@shared/types').Cell
  currentStep: number
}): JSX.Element {
  const seq = cell.sequencer
  const globalBpm = useStore((st) => st.session.globalBpm)
  const s = Math.max(1, Math.min(16, Math.floor(seq.steps)))
  // Same formulas as bounceCoeff / bounceStepDuration in factory.ts —
  // mirrored here so the preview can compute both per-arc duration AND
  // amplitude in one pass without round-tripping through the helper.
  const e = 0.4 + (Math.max(0, Math.min(100, seq.bounceDecay)) / 100) * 0.55
  const sumGeom = e === 1 ? s : (1 - Math.pow(e, s)) / (1 - e)
  // Cycle's average step duration in ms — depends on which sync mode
  // the user picked. Drives the SMIL `dur` so the ball's animation
  // duration matches the engine's actual step boundary.
  const stepDurMs =
    seq.syncMode === 'bpm'
      ? 60000 / Math.max(1, globalBpm)
      : seq.syncMode === 'tempo'
        ? 60000 / Math.max(1, seq.bpm)
        : Math.max(1, seq.stepMs)
  const cycleMs = stepDurMs * s
  // Per-arc duration in seconds (for SMIL). Floored at 0.05s so the
  // last few tiny bounces in a quick-decay cycle still register
  // visually instead of teleporting. Capped at 4s for sanity in
  // very-slow tempos.
  const arcDurSec = (i: number): number =>
    Math.max(0.05, Math.min(4, (cycleMs * Math.pow(e, i) / sumGeom) / 1000))
  // Layout: 240px wide × 60px tall, with a 4px floor margin so arcs
  // can land on a baseline without touching the edge.
  const W = 240
  const H = 60
  const baseline = H - 4
  const maxArcHeight = baseline - 4
  // Compute every arc's geometry up-front so we know cumulative x.
  const arcs: {
    x0: number
    x1: number
    peakY: number
    hue: number
    pathD: string
  }[] = []
  let cursor = 0
  for (let i = 0; i < s; i++) {
    const stepFrac = Math.pow(e, i) / sumGeom
    const w = stepFrac * W
    const x0 = cursor
    const x1 = cursor + w
    const amp = Math.pow(e, i) // 1 → e^(s-1)
    const peakY = baseline - amp * maxArcHeight
    const midX = (x0 + x1) / 2
    // Lift the Bézier control above the visual peak so the curve apex
    // reaches peakY (quadratic Bézier maxes at half-way between mid
    // control and endpoints).
    const ctrlY = 2 * peakY - baseline
    const pathD = `M ${x0} ${baseline} Q ${midX} ${ctrlY} ${x1} ${baseline}`
    arcs.push({ x0, x1, peakY, hue: hueForStep(i, s), pathD })
    cursor = x1
  }

  // The ball + splash live inside a keyed <g> so React unmounts +
  // remounts (and therefore restarts the SMIL timeline) every time
  // the engine advances to a new step. Without the key, the SMIL
  // animations would only fire once per BouncePreview lifetime.
  const liveArc = currentStep >= 0 && currentStep < arcs.length ? arcs[currentStep] : null

  return (
    // Constrained-width wrapper so the SVG can never poke past the
    // inspector's right edge at narrow widths. The SVG itself
    // scales via viewBox + width=100% so the arcs reshape with the
    // available space (small inspectors get a denser bounce, wide
    // ones get a roomy one). overflow: visible was leaking the
    // splash rings past the right edge — clipped now.
    <div className="mt-2 flex items-center gap-2 min-w-0">
      <span className="label shrink-0">Bounce</span>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        preserveAspectRatio="xMidYMid meet"
        style={{
          width: '100%',
          height: 'auto',
          maxWidth: W,
          minWidth: 0,
          overflow: 'hidden'
        }}
      >
        {/* Floor line — gives the eye a "ground" to land on. */}
        <line
          x1={0}
          y1={baseline}
          x2={W}
          y2={baseline}
          stroke="rgb(var(--c-border) / 0.7)"
          strokeWidth={1}
        />
        {arcs.map((arc, i) => {
          const isNow = i === currentStep
          const stroke = isNow
            ? `hsl(${arc.hue} 95% 70%)`
            : `hsl(${arc.hue} 70% 55%)`
          const opacity = isNow ? 1 : 0.4 + (1 - i / s) * 0.35
          return (
            <g
              key={i}
              style={{
                filter: isNow
                  ? `drop-shadow(0 0 6px hsl(${arc.hue} 95% 70% / 0.85)) drop-shadow(0 0 14px hsl(${arc.hue} 90% 65% / 0.5))`
                  : undefined,
                transition: 'opacity 220ms ease-out'
              }}
            >
              <path
                d={arc.pathD}
                fill="none"
                stroke={stroke}
                strokeWidth={isNow ? 2.5 : 1.5}
                strokeLinecap="round"
                opacity={opacity}
              >
                <title>{`Bounce ${i + 1} — amplitude ${Math.pow(e, i).toFixed(2)}`}</title>
                {/* Active-arc breathing pulse — subtle stroke-width
                    swell timed to the bounce so the arc "breathes"
                    in sync with the ball flight. Re-keyed on
                    currentStep below so it restarts each step. */}
                {isNow && (
                  <animate
                    attributeName="stroke-width"
                    values="2.5; 3.6; 2.5"
                    dur={`${arcDurSec(i)}s`}
                    repeatCount="1"
                  />
                )}
              </path>
              {/* Landing dot — quiet guidepost where each bounce
                  kisses the floor (the splash ring above will
                  bloom from this same point in real time). */}
              <circle
                cx={arc.x1}
                cy={baseline}
                r={isNow ? 2.5 : 2}
                fill={stroke}
                opacity={opacity}
              />
            </g>
          )
        })}

        {/* Live ball + splash. Keyed on currentStep so React unmounts
            and remounts the whole group every step boundary, which
            restarts the SMIL animations from t=0 — exactly the timing
            we want for the visual to follow the engine's playhead. */}
        {liveArc && (
          <g key={`bounce-live-${currentStep}`}>
            {/* Ghost trail — three dimmer balls that begin slightly
                later than the leader, producing a comet-tail along
                the same parabolic path. Each starts at arc.x0 / floor
                so it doesn't flash in the SVG corner before its
                animation begins. */}
            {[0.05, 0.1, 0.15].map((delaySec, gi) => (
              <circle
                key={gi}
                cx={liveArc.x0}
                cy={baseline}
                r={4 - gi * 0.9}
                fill={`hsl(${liveArc.hue} 90% 65%)`}
                opacity={0}
                style={{ pointerEvents: 'none' }}
              >
                <animateMotion
                  dur={`${arcDurSec(currentStep)}s`}
                  path={liveArc.pathD}
                  fill="freeze"
                  begin={`${delaySec}s`}
                />
                {/* Fade in once the ghost actually starts moving (so
                    it doesn't sit visible at arc.x0 during its delay). */}
                <animate
                  attributeName="opacity"
                  from={0}
                  to={0.55 - gi * 0.15}
                  dur="0.04s"
                  begin={`${delaySec}s`}
                  fill="freeze"
                />
                {/* Fade out as the ghost approaches the landing so
                    the trail dissolves into the splash. */}
                <animate
                  attributeName="opacity"
                  values="0.55; 0"
                  keyTimes="0; 1"
                  dur={`${arcDurSec(currentStep) - delaySec}s`}
                  begin={`${delaySec + arcDurSec(currentStep) * 0.6}s`}
                  fill="freeze"
                />
              </circle>
            ))}

            {/* The leader — the loud, glowing main ball. */}
            <circle
              r={5}
              fill={`hsl(${liveArc.hue} 95% 72%)`}
              style={{
                filter: `drop-shadow(0 0 7px hsl(${liveArc.hue} 95% 72% / 0.95)) drop-shadow(0 0 16px hsl(${liveArc.hue} 90% 65% / 0.55))`,
                pointerEvents: 'none'
              }}
            >
              <animateMotion
                dur={`${arcDurSec(currentStep)}s`}
                path={liveArc.pathD}
                fill="freeze"
              />
              {/* Tiny scale pop on landing so the impact reads. */}
              <animate
                attributeName="r"
                values="5; 6.5; 4.5; 5"
                keyTimes="0; 0.92; 0.97; 1"
                dur={`${arcDurSec(currentStep)}s`}
                fill="freeze"
              />
            </circle>

            {/* Splash ring at the landing — three layered concentric
                rings expanding + fading at slightly staggered rates,
                giving the landing a satisfying water-droplet feel.
                Begin at arcDur so they trigger right when the ball
                kisses the floor. */}
            {[0, 0.04, 0.08].map((delay, ri) => (
              <circle
                key={`splash-${ri}`}
                cx={liveArc.x1}
                cy={baseline}
                fill="none"
                stroke={`hsl(${liveArc.hue} 95% ${75 - ri * 5}%)`}
                strokeWidth={2 - ri * 0.5}
                opacity={0}
                style={{ pointerEvents: 'none' }}
              >
                <animate
                  attributeName="r"
                  from={2}
                  to={18 - ri * 2}
                  dur="0.55s"
                  begin={`${arcDurSec(currentStep) + delay}s`}
                  fill="freeze"
                />
                <animate
                  attributeName="opacity"
                  values="0; 0.95; 0"
                  keyTimes="0; 0.2; 1"
                  dur="0.55s"
                  begin={`${arcDurSec(currentStep) + delay}s`}
                  fill="freeze"
                />
                <animate
                  attributeName="stroke-width"
                  from={2 - ri * 0.5}
                  to={0.3}
                  dur="0.55s"
                  begin={`${arcDurSec(currentStep) + delay}s`}
                  fill="freeze"
                />
              </circle>
            ))}

            {/* A short floor-flash directly under the landing point —
                a brief horizontal bar that brightens, then fades, like
                the ground briefly registering the impact. */}
            <line
              x1={liveArc.x1 - 8}
              y1={baseline}
              x2={liveArc.x1 + 8}
              y2={baseline}
              stroke={`hsl(${liveArc.hue} 95% 75%)`}
              strokeWidth={2}
              strokeLinecap="round"
              opacity={0}
              style={{ pointerEvents: 'none' }}
            >
              <animate
                attributeName="opacity"
                values="0; 0.9; 0"
                keyTimes="0; 0.15; 1"
                dur="0.45s"
                begin={`${arcDurSec(currentStep)}s`}
                fill="freeze"
              />
              <animate
                attributeName="x1"
                values={`${liveArc.x1 - 4}; ${liveArc.x1 - 14}`}
                keyTimes="0; 1"
                dur="0.45s"
                begin={`${arcDurSec(currentStep)}s`}
                fill="freeze"
              />
              <animate
                attributeName="x2"
                values={`${liveArc.x1 + 4}; ${liveArc.x1 + 14}`}
                keyTimes="0; 1"
                dur="0.45s"
                begin={`${arcDurSec(currentStep)}s`}
                fill="freeze"
              />
            </line>
          </g>
        )}
      </svg>
    </div>
  )
}

// Per-mode help text shown under the live-values grid in Generative
// mode. Spells out what the seed becomes for each mode, in the same
// organic / hardware-sequencer language as the title-attr metaphors.
function genHelpText(mode: SeqMode): string {
  switch (mode) {
    case 'steps':
      return 'Tide: the seed value swells through one cycle like a wave rising and breaking. Variation sets the swell depth; Seed shifts where the peak lands.'
    case 'euclidean':
      return 'Accent: every Euclidean hit lands harder on the downbeat than off-beat — natural drummer-emphasis from the same single seed value.'
    case 'polyrhythm':
      return 'Voicing: Ring A hits sit below the seed (root), Ring B hits sit above (harmony), coincidence peaks at full resonance.'
    case 'density':
      return 'Wave: a continuous sine runs through the row. The gate fires sparsely or densely; each fired step samples the wave\'s height at its position.'
    case 'cellular':
      return 'Crowd: each on-cell\'s value tracks how many of its neighbours are alive. Lonely cells dim, crowded cells excite.'
    case 'drift':
      return 'Terrain: a fixed 1D landscape (smooth hills + valleys) is generated from the Seed. The Brownian walker samples the elevation at each landing.'
    case 'ratchet':
      return 'Scatter: the first sub-pulse of each burst is the loud first impact; subsequent sub-pulses scatter from the seed into a flock of values.'
    case 'bounce':
      return 'Bounce: each cycle is one drop. Step 0 hits the floor at the seed value; subsequent bounces decay in amplitude (and time) until the cycle resets.'
    default:
      return 'Generative mode: each step\'s value is computed live from the cell\'s Value field as a seed.'
  }
}

// Read-only preview of the values the engine is currently generating
// for each step. Replaces the editable StepInput grid when generative
// mode is on. Uses the same generateStepValue() the engine calls, so
// the preview is always exactly what's being sent.
//
// For modes that wrap a sub-pulse layer (Ratchet → Scatter) we render
// only the first sub-pulse value per step — visiting all sub-values
// would clutter the grid; the live preview is meant to give the user
// a snapshot of the cycle's "shape", not every micro-event.
function GenerativeStepPreview({
  steps,
  cell,
  currentStep
}: {
  steps: number
  cell: import('@shared/types').Cell
  currentStep: number
}): JSX.Element {
  const seq = cell.sequencer
  // Read engine live value for the currently selected cell. For
  // Ratchet specifically (and any other mode where sub-pulse/state
  // makes the active step's value differ from the precomputed
  // generative result), substitute the live value at the active
  // step so the preview reflects real-time playback.
  const sel = useStore((st) => st.selectedCell)
  const liveValue = useStore((st) =>
    sel ? st.engine.currentValueBySceneAndTrack[sel.sceneId]?.[sel.trackId] : undefined
  )
  // Look up the source track to read its argSpec. The preview hides
  // any tokens at positions where `argSpec[i].fixed !== undefined`
  // — those are protocol headers (OCTOCOSME's "compositor" + "0"
  // for the Pure Data `list split 2`) that always emit the same
  // value and just add noise to the user-facing preview grid.
  const track = useStore((st) =>
    sel ? st.session.tracks.find((t) => t.id === sel.trackId) : undefined
  )
  const fixedMask = (track?.argSpec ?? []).map((a) => a.fixed !== undefined)
  // Strip fixed-position tokens from a generated value string. Splits
  // on whitespace, drops tokens whose corresponding argSpec entry is
  // marked fixed, and rejoins. Returns the original string when the
  // track has no argSpec (or no fixed entries) so single-arg cells
  // are unchanged.
  function stripFixed(raw: string): string {
    if (!fixedMask.some((f) => f)) return raw
    const toks = raw.trim().split(/\s+/)
    return toks.filter((_, i) => !fixedMask[i]).join(' ')
  }
  const values = Array.from({ length: steps }, (_, i) =>
    stripFixed(
      generateStepValue({
        baseRaw: cell.value,
        mode: seq.mode,
        stepIdx: i,
        steps,
        amount: seq.genAmount,
        seed: seq.seed,
        ringALength: seq.ringALength,
        ringBLength: seq.ringBLength,
        cellRow: cellularInitialRow(seq.cellSeed, steps),
        bounceDecay: seq.bounceDecay,
        subIdx: 0,
        subdiv: 1,
        scaleToUnit: cell.scaleToUnit
      })
    )
  )
  return (
    <div className="grid grid-cols-4 gap-1">
      {values.map((v, i) => {
        const isActive = i === currentStep
        // Active step → show engine's live emitted value (captures
        // Ratchet sub-pulse scatter, Cellular evolved row, etc).
        // Live value also passes through the fixed-token strip so
        // the active cell stays visually consistent with siblings.
        const display =
          isActive && liveValue !== undefined ? stripFixed(liveValue) : v
        return (
          <div
            key={`${i}-${display}-${isActive ? 'now' : ''}`}
            className={`px-1 py-1 rounded text-[10px] font-mono text-center border truncate transition-all duration-200 ${
              isActive
                ? 'border-success bg-success/20 text-success'
                : 'border-border bg-panel2/40 text-muted'
            }`}
            title={`Step ${i + 1}: ${display}`}
          >
            {display}
          </div>
        )
      })}
    </div>
  )
}

// A step input that pulses orange each time it becomes the active step.
// Uncontrolled (defaultValue + ref): the DOM owns the value while focused, so
// engine state updates (which fire at sequencer rate) cannot clobber typing.
// External value changes are synced into the DOM only when the input is not
// focused. Auto-selects on focus so typing replaces the existing value (e.g. "0").
function StepInput({
  index,
  active,
  muted,
  value,
  onChange
}: {
  index: number
  active: boolean
  /** When the playhead is here but the step is gated off (Euclidean
   *  miss, Polyrhythm gap, Cellular dead bit, Density rest), the
   *  step glows grey instead of orange — visual feedback that the
   *  receiver will hold rather than fire. */
  muted?: boolean
  value: string
  onChange: (v: string) => void
}): JSX.Element {
  const inputRef = useRef<HTMLInputElement>(null)
  const pulseRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const el = inputRef.current
    if (!el) return
    if (document.activeElement !== el && el.value !== value) {
      el.value = value
    }
  }, [value])

  useEffect(() => {
    if (!active) return
    const el = pulseRef.current
    if (!el) return
    el.classList.remove('seq-pulse')
    el.classList.remove('seq-pulse-muted')
    void el.offsetWidth
    el.classList.add(muted ? 'seq-pulse-muted' : 'seq-pulse')
  }, [active, muted])

  return (
    <div className="relative">
      <span className="text-[9px] text-muted px-1">{index + 1}</span>
      <input
        ref={inputRef}
        defaultValue={value}
        className={`input text-[11px] py-0.5 px-1 font-mono w-full ${
          active && !muted ? 'border-accent' : active && muted ? 'border-muted' : ''
        }`}
        placeholder="–"
        onFocus={(e) => e.currentTarget.select()}
        onChange={(e) => onChange(e.target.value)}
      />
      <div
        ref={pulseRef}
        aria-hidden
        className="absolute inset-x-0 bottom-0 top-[14px] pointer-events-none rounded-sm"
      />
    </div>
  )
}

function clamp(v: number, lo: number, hi: number): number {
  if (!Number.isFinite(v)) return lo
  return v < lo ? lo : v > hi ? hi : v
}

// Trim whitespace-delimited tokens to `max` while preserving the trailing
// space if the user is still typing (so mid-word typing is not jumpy).
function capTokens(raw: string, max: number): string {
  const endsWithSpace = /\s$/.test(raw)
  const parts = raw.trim().split(/\s+/).filter((s) => s.length > 0)
  if (parts.length <= max) return raw
  return parts.slice(0, max).join(' ') + (endsWithSpace ? ' ' : '')
}

function detectedLabel(s: string): string {
  const t = s.trim()
  if (t === '') return 'string (empty)'
  if (/^(true|TRUE|True|false|FALSE|False)$/.test(t)) return 'bool'
  if (/^-?\d+$/.test(t)) return 'int'
  if (/^-?(\d+\.\d*|\.\d+|\d+)([eE][-+]?\d+)?$/.test(t)) return 'float'
  return 'string'
}

// Cell value editor for tracks instantiated from a multi-arg
// ParamArgSpec. Renders one labeled input per non-fixed entry plus
// a small read-only "prefix" strip showing the fixed header tokens
// (so the user knows what's being prepended even though they can't
// edit it). Cell.value is stored as a single space-joined string —
// this component just parses → renders → joins on commit, leaving
// the engine and persistence paths unchanged.
function MultiArgValueEditor({
  cell,
  argSpec,
  trackPersistentSlots,
  disabled,
  onChange,
  onCommitTrigger,
  onTogglePin
}: {
  cell: Cell
  argSpec: ParamArgSpec[]
  // Track-level pin defaults — used to compute the EFFECTIVE pin
  // state for each slot when the cell hasn't set its own override.
  trackPersistentSlots?: boolean[]
  disabled: boolean
  onChange: (newValue: string) => void
  onCommitTrigger: () => void
  // Toggle the per-cell pin for slot `idx`. Passes `nextPinned` so
  // the caller (CellInspector) can branch on the desired state +
  // capture the current value if pinning. Pass `undefined` to clear
  // the cell-level override entirely (fall back to track default).
  onTogglePin: (idx: number, nextPinned: boolean | undefined, capturedValue: string) => void
}): JSX.Element {
  const tokens = tokensWithDefaults(tokensFromValue(cell.value), argSpec)
  function setAt(i: number, raw: string): void {
    const next = tokens.slice()
    next[i] = raw
    // Re-coerce fixed positions back to their declared values in
    // case anything in the chain corrupted them. Belt-and-braces.
    const final = next.map((t, idx) => {
      const a = argSpec[idx]
      if (!a) return t
      if (a.fixed !== undefined) return formatTok(a.fixed)
      return t
    })
    onChange(final.join(' '))
  }
  return (
    <div className="grid grid-cols-2 gap-x-2 gap-y-1.5">
      {argSpec.map((a, i) => {
        if (a.fixed !== undefined) return null
        // Effective pin state: cell override beats track default.
        // - cell.persistentSlots[i] === true  → pinned (source: cell)
        // - cell.persistentSlots[i] === false → forced unpin (source: cell)
        // - cell.persistentSlots[i] === undefined → fall back to track
        const cellOverride = cell.persistentSlots?.[i]
        const trackPinned = trackPersistentSlots?.[i] === true
        const effectivePinned =
          cellOverride === true
            ? true
            : cellOverride === false
              ? false
              : trackPinned
        // "source" drives the badge: did the cell explicitly pin /
        // unpin, or are we inheriting the track default?
        const source: 'cell' | 'track' | 'none' =
          cellOverride !== undefined
            ? 'cell'
            : trackPinned
              ? 'track'
              : 'none'
        return (
          <ArgInput
            key={i}
            spec={a}
            value={tokens[i] ?? ''}
            disabled={disabled || effectivePinned}
            pinned={effectivePinned}
            pinSource={source}
            onTogglePin={() =>
              // Flip the EFFECTIVE state. If we're inheriting track
              // pinned-true and the user clicks, set explicit false
              // on the cell (override). Same logic in reverse for
              // unpinning a cell-level pin while track default is
              // unpinned.
              onTogglePin(
                i,
                effectivePinned ? false : true,
                tokens[i] ?? ''
              )
            }
            onClearPinOverride={
              source === 'cell'
                ? () => onTogglePin(i, undefined, tokens[i] ?? '')
                : undefined
            }
            onChange={(v) => setAt(i, v)}
            onCommitTrigger={onCommitTrigger}
          />
        )
      })}
    </div>
  )
}

// Inline label rendered next to the Value/Values section title:
//   "Auto-prefix: [compositor] [0]"
// Each fixed token is shown as a tiny read-only chip so the user
// sees what's being silently prepended.
function ArgPrefixLabel({ argSpec }: { argSpec: ParamArgSpec[] }): JSX.Element | null {
  const fixedTokens = argSpec.filter((a) => a.fixed !== undefined)
  if (fixedTokens.length === 0) return null
  return (
    <span className="flex items-center gap-1 text-[10px] text-muted truncate">
      <span className="shrink-0">Auto-prefix:</span>
      {fixedTokens.map((a, k) => (
        <span
          key={k}
          className="font-mono px-1 py-px rounded bg-panel2 border border-border shrink-0"
          title={`${a.name} (${a.type}, fixed)`}
        >
          {formatTok(a.fixed!)}
        </span>
      ))}
    </span>
  )
}

function ArgInput({
  spec,
  value,
  disabled,
  pinned,
  pinSource,
  onTogglePin,
  onClearPinOverride,
  onChange,
  onCommitTrigger
}: {
  spec: ParamArgSpec
  value: string
  disabled: boolean
  // Effective pin state (cell override OR inherited from track).
  // When pinned, the input is grey-disabled and the badge shows
  // who pinned it (cell vs track default).
  pinned: boolean
  pinSource: 'cell' | 'track' | 'none'
  // Flip the effective pin state — captures the current displayed
  // token at pin time so the engine emits it.
  onTogglePin: () => void
  // Defined only when the cell has an EXPLICIT override (source = 'cell').
  // Clicking the small "(cell)" badge clears the override and falls
  // back to the track default.
  onClearPinOverride?: () => void
  onChange: (v: string) => void
  onCommitTrigger: () => void
}): JSX.Element {
  // Bools use a numeric editor (0..1, integer) — same widget as int
  // — so modulators and sequencer-step values can drive them too.
  // The engine still emits the underlying int as an OSC arg; the
  // receiver coerces 0/1 → bool. Modulating a "bool" continuously
  // alternates 0 and 1 (or stays at the modulated value, clamped),
  // letting the user wire e.g. an LFO to a kill switch.
  // Tiny label row shared by both branches — name on the left, pin
  // checkbox + source-badge on the right. The pin captures the
  // current value at toggle time; the badge tells the user whether
  // this slot's pin came from the cell-level override or the
  // track-level default ("(track)" = inherited, click to override
  // explicitly; "(cell)" = explicit override, click × to clear and
  // fall back).
  const labelRow = (
    <div className="flex items-baseline gap-1 min-w-0">
      <span className="text-[9px] text-muted uppercase tracking-wide truncate flex-1">
        {spec.name}
        {spec.type === 'bool' && <span className="ml-1 text-[8px]">(0/1)</span>}
      </span>
      <label
        className="flex items-center gap-0.5 cursor-pointer shrink-0"
        title={
          pinned
            ? pinSource === 'cell'
              ? 'Pinned for this clip — engine emits the captured value regardless of modulators / sequencer. Click to unpin.'
              : 'Pinned by the Parameter Inspector (applies to every clip on this row). Click to override + unpin for this clip only.'
            : pinSource === 'cell'
              ? 'Explicitly unpinned for this clip — overrides the track default. Click × to clear the override.'
              : 'Unpinned. Click to freeze this slot at the value shown.'
        }
      >
        <input
          type="checkbox"
          checked={pinned}
          onChange={onTogglePin}
          disabled={disabled && !pinned}
        />
        <span
          className={`text-[8px] ${
            pinSource === 'cell'
              ? 'text-accent'
              : pinSource === 'track'
                ? 'text-muted'
                : 'text-muted'
          }`}
        >
          {pinSource === 'cell' ? 'cell' : pinSource === 'track' ? 'track' : 'pin'}
        </span>
      </label>
      {onClearPinOverride && (
        <button
          className="text-muted hover:text-text text-[10px] leading-none shrink-0"
          onClick={onClearPinOverride}
          title="Clear this clip's pin override (revert to the Parameter Inspector default)"
        >
          ×
        </button>
      )}
    </div>
  )
  if (spec.type === 'string') {
    return (
      <label className="flex flex-col gap-0.5 min-w-0">
        {labelRow}
        <UncontrolledTextInput
          className="input text-[11px] py-0.5 font-mono"
          value={value}
          onChange={onChange}
          disabled={disabled}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              onCommitTrigger()
            }
          }}
        />
      </label>
    )
  }
  // float / int / bool — bool is rendered as an integer 0/1 editor so
  // modulators can drive it like any other numeric arg.
  const integer = spec.type === 'int' || spec.type === 'bool'
  const parsed = integer ? parseInt(value, 10) : parseFloat(value)
  // Bool defaults to a 0..1 range when not explicitly set, and falls
  // back to its boolean init coerced to 0/1.
  const minBound =
    spec.min !== undefined ? spec.min : spec.type === 'bool' ? 0 : undefined
  const maxBound =
    spec.max !== undefined ? spec.max : spec.type === 'bool' ? 1 : undefined
  let initFallback: number
  if (typeof spec.init === 'number') initFallback = spec.init
  else if (typeof spec.init === 'boolean') initFallback = spec.init ? 1 : 0
  else if (typeof spec.min === 'number') initFallback = spec.min
  else initFallback = 0
  const safeNum = Number.isFinite(parsed) ? parsed : initFallback
  return (
    <label className="flex flex-col gap-0.5 min-w-0">
      {labelRow}
      <BoundedNumberInput
        className="input text-[11px] py-0.5"
        value={safeNum}
        onChange={(v) => onChange(integer ? String(Math.round(v)) : String(v))}
        min={minBound}
        max={maxBound}
        integer={integer}
        disabled={disabled}
      />
    </label>
  )
}

function tokensFromValue(value: string): string[] {
  return value.trim().split(/\s+/).filter((t) => t.length > 0)
}

// Pad the parsed token list out to argSpec.length, filling missing
// slots with the spec's defaults (init / fixed / type-zero). Used
// both for first-render of an under-filled cell and for assembling
// the commit value after edits.
function tokensWithDefaults(tokens: string[], spec: ParamArgSpec[]): string[] {
  return spec.map((a, i) => {
    if (a.fixed !== undefined) return formatTok(a.fixed)
    if (i < tokens.length && tokens[i] !== undefined) return tokens[i]
    if (a.init !== undefined) return formatTok(a.init)
    if (a.type === 'string') return ''
    return '0'
  })
}

function formatTok(v: number | string | boolean): string {
  if (typeof v === 'boolean') return v ? '1' : '0'
  return String(v)
}

// ─────────────────────────────────────────────────────────────────
// MIDI Output — parallel destination alongside OSC. Shown as a
// CollapsibleSection in the cell editor; toggle the section header
// to enable / disable. In Note mode, the Value field above this
// section is interpreted as the MIDI note number (0..127) and we
// render a separate Velocity field below with its own pin.
// ─────────────────────────────────────────────────────────────────
function MidiOutputSection({
  cell,
  onChange,
  onVelocityChange,
  onVelocityHumanizeChange,
  onPinVelocity,
  onPinNote,
  onPitchSnapChange
}: {
  cell: Cell
  onChange: (patch: Partial<MidiOut>) => void
  onVelocityChange: (v: string) => void
  onVelocityHumanizeChange: (pct: number) => void
  onPinVelocity: (pinned: boolean) => void
  onPinNote: (pinned: boolean) => void
  // Patch the cell.pitchSnap object — keeps the section signature
  // tidy without exposing the full Cell setter to the MidiOut UI.
  onPitchSnapChange: (
    patch: Partial<NonNullable<Cell['pitchSnap']>>
  ) => void
}): JSX.Element {
  const m = cell.midiOut ?? DEFAULT_MIDI_OUT
  const [ports, setPorts] = useState<string[]>([])
  const [available, setAvailable] = useState<boolean>(true)
  const [lastError, setLastError] = useState<string>('')
  // Refresh ports on mount + every time the section opens. Cheap
  // (RtMidi rescans synchronously) so we just re-poll on every
  // toggle rather than subscribing to a hot-plug stream.
  useEffect(() => {
    let cancelled = false
    window.api?.midiListPorts?.().then((r) => {
      if (cancelled) return
      setPorts(r.ports)
      setAvailable(r.available)
      setLastError(r.lastError)
    })
    return () => {
      cancelled = true
    }
  }, [m.enabled])
  return (
    <CollapsibleSection
      title="MIDI Output"
      enabled={m.enabled}
      onToggle={(v) => onChange({ enabled: v })}
      headerRight={
        !available ? (
          <span className="text-[10px] text-danger" title={lastError}>
            unavailable
          </span>
        ) : null
      }
    >
      {/* Port + channel row. The port dropdown lists everything
          RtMidi sees right now; an empty list means no MIDI
          interfaces are attached. `min-w-0` lets the dropdown
          shrink so long device names ("Komplete Audio 6 MIDI") get
          truncated to ellipsis instead of pushing the CH spinner
          off-screen. The CH input on the right is fixed-width. */}
      <div className="grid grid-cols-[auto_minmax(0,1fr)_auto_auto] gap-x-2 gap-y-1 items-center">
        <span className="label">Port</span>
        <select
          className="input text-[12px] min-w-0 max-w-full"
          style={{ textOverflow: 'ellipsis' }}
          value={m.portName}
          onChange={(e) => onChange({ portName: e.target.value })}
          disabled={!available}
        >
          <option value="">— select port —</option>
          {/* Show the currently-stored port even if it's not in
              the live list (cable might be unplugged), so the user
              doesn't lose their selection. */}
          {m.portName && !ports.includes(m.portName) && (
            <option value={m.portName}>{m.portName} (disconnected)</option>
          )}
          {ports.map((p) => (
            <option key={p} value={p}>
              {p}
            </option>
          ))}
        </select>
        <span className="label">Ch</span>
        {/* CH input is 2-digit (channels 1..16) so it doesn't eat the
            row width — gives the PORT dropdown more room to display
            long device names without clipping. */}
        <BoundedNumberInput
          className="input w-10 text-center tabular-nums"
          value={m.channel}
          onChange={(v) => onChange({ channel: v })}
          min={1}
          max={16}
          integer
        />
      </div>

      {/* Message kind toggle. Switching between CC and Note re-
          interprets the cell's Value field (CC value vs note number)
          and reveals the Velocity slot below for Note mode. */}
      <div className="flex items-center gap-2 mt-1">
        <span className="label">Kind</span>
        <div className="flex items-center gap-0.5">
          <button
            className={`text-[10px] px-2 py-0 leading-tight rounded border ${
              m.kind === 'cc'
                ? 'bg-accent text-black border-accent'
                : 'border-border text-muted hover:text-text'
            }`}
            onClick={() => onChange({ kind: 'cc' })}
          >
            CC
          </button>
          <button
            className={`text-[10px] px-2 py-0 leading-tight rounded border ${
              m.kind === 'note'
                ? 'bg-accent text-black border-accent'
                : 'border-border text-muted hover:text-text'
            }`}
            onClick={() => onChange({ kind: 'note' })}
          >
            Note
          </button>
        </div>
        {m.kind === 'cc' ? (
          <>
            <span className="label">CC #</span>
            <BoundedNumberInput
              className="input w-14"
              value={m.cc ?? 0}
              onChange={(v) => onChange({ cc: v })}
              min={0}
              max={127}
              integer
            />
            <span className="text-[10px] text-muted">
              Value field drives the CC value (0–127).
            </span>
          </>
        ) : (
          <>
            <span className="label">Gate</span>
            <BoundedNumberInput
              className="input w-16"
              value={m.gateLengthMs ?? 0}
              onChange={(v) => onChange({ gateLengthMs: v })}
              min={0}
              max={60000}
              integer
              title="Note Off fires this many ms after Note On. 0 = until next trigger / scene change."
            />
            <span className="text-[10px] text-muted">ms (0 = until next trigger)</span>
          </>
        )}
      </div>

      {/* Note mode: explicit Note Number + Velocity slots, each
          with its own pin. Value above this section drives the
          note number; Velocity is a separate cell field. The pin
          machinery freezes either slot independently so the user
          can modulate / sequence ONE while keeping the OTHER
          locked. */}
      {m.kind === 'note' && (
        <div className="flex flex-col gap-1 mt-1 text-[10px]">
          {/* Note row — same vertical alignment as the velocity row below. */}
          <div className="flex items-center gap-2">
            <span className="text-muted shrink-0" title="MIDI note 0..127">
              Note (= Value)
            </span>
            <span className="font-mono text-[11px] text-muted flex-1 text-right">
              see Value field above ↑
            </span>
            <label className="flex items-center gap-1 shrink-0">
              <input
                type="checkbox"
                checked={!!cell.notePersistent}
                onChange={(e) => onPinNote(e.target.checked)}
                title="Pin — freeze the note number; sequencer / modulator only drives Velocity below."
              />
              <span>pin</span>
            </label>
          </div>

          {/* Velocity row — compact input + Humanize slider + pin
              all on one line. Velocity capped at 3 chars (max value
              127). Humanize slider 0..100% randomises the Note On
              velocity around the user's value on each trigger; engine
              applies the jitter inside emitMidiForCell. */}
          <div className="flex items-center gap-2">
            <span className="text-muted shrink-0" title="MIDI velocity 0..127">
              Velocity
            </span>
            <UncontrolledTextInput
              className="input font-mono text-center"
              style={{ width: 40 }}
              value={cell.velocity ?? '100'}
              onChange={(v) => onVelocityChange(v.trim() || '0')}
              placeholder="100"
              maxLength={3}
            />
            <span
              className="text-muted shrink-0"
              title="Humanize: random ± variation around the velocity, applied per Note On. 0 = exact velocity. 100 = full random in 0..127."
            >
              Humanize
            </span>
            <input
              type="range"
              min={0}
              max={100}
              step={1}
              value={cell.velocityHumanize ?? 0}
              onChange={(e) =>
                onVelocityHumanizeChange(Number(e.target.value))
              }
              className="flex-1 min-w-0"
              title="Random jitter around the velocity (0..100%)"
            />
            <span
              className="text-muted tabular-nums shrink-0"
              style={{ width: 26 }}
            >
              {cell.velocityHumanize ?? 0}%
            </span>
            <label className="flex items-center gap-1 shrink-0">
              <input
                type="checkbox"
                checked={!!cell.velocityPersistent}
                onChange={(e) => onPinVelocity(e.target.checked)}
                title="Pin — freeze the velocity; sequencer / modulator only drives the note number above."
              />
              <span>pin</span>
            </label>
          </div>
        </div>
      )}

      {/* Melodic window — only meaningful in Note mode AND when the
          cell has midiScale / scaleToUnit ON (the path that maps a
          [0..1] sequencer / modulator output to a MIDI note number).
          Defaults to C2..C6 (36..84) when unset; the engine reads
          these via `cell.midiOut.noteMin/noteMax`. Use this to set
          your melodic octave window: 60..72 = one chromatic octave
          starting at C4, 48..72 = two octaves, etc. */}
      {m.kind === 'note' && (cell.midiScale || cell.scaleToUnit) && (
        <div className="flex items-center gap-2 text-[10px] mt-1">
          <span
            className="label shrink-0"
            title="When midiScale / scaleToUnit is on, the [0..1] output gets mapped linearly to this MIDI note window. Both ends inclusive. Tip: set Min/Max to the lowest/highest note of your target range, then use the Scaling section to clamp the raw value if you want a tighter melodic band."
          >
            Note range
          </span>
          <BoundedNumberInput
            className="input w-14"
            value={m.noteMin ?? 36}
            onChange={(v) => onChange({ noteMin: v })}
            min={0}
            max={127}
            integer
            title="Lowest MIDI note. Default 36 = C2."
          />
          <span className="text-muted">→</span>
          <BoundedNumberInput
            className="input w-14"
            value={m.noteMax ?? 84}
            onChange={(v) => onChange({ noteMax: v })}
            min={0}
            max={127}
            integer
            title="Highest MIDI note. Default 84 = C6."
          />
          <span className="text-muted text-[10px]">
            {midiNoteName(m.noteMin ?? 36)} – {midiNoteName(m.noteMax ?? 84)}
          </span>
        </div>
      )}

      {/* Scale snap — quantises the modulated / sequenced value to
          the nearest in-scale semitone, in BOTH the OSC and MIDI
          paths (snap happens in the unified pipeline, BEFORE the
          pin override). OSC ends up emitting a stepped [0..1]
          where each step is a scale degree of the Note range
          window; MIDI Note emits the matching snapped note number.
          Lets a single generative source drive a synth (MIDI) and a
          Pure Data / Max patch (OSC) with the SAME melody. Gated
          on (midiScale || scaleToUnit) so the engine has a [0..1]
          domain to map. */}
      {m.kind === 'note' && (cell.midiScale || cell.scaleToUnit) && (
        <PitchSnapEditor
          snap={cell.pitchSnap}
          noteMin={m.noteMin ?? 36}
          noteMax={m.noteMax ?? 84}
          onChange={onPitchSnapChange}
        />
      )}
    </CollapsibleSection>
  )
}

// Scale snap editor — three controls (enable, root, scale) plus a
// live readout of the in-scale notes that fall inside the configured
// MIDI note window. The readout doubles as a sanity check: if the
// user picks a 4-note window and a 7-note scale, they instantly see
// "only 2 notes available" and can widen the window.
function PitchSnapEditor({
  snap,
  noteMin,
  noteMax,
  onChange
}: {
  snap: Cell['pitchSnap']
  noteMin: number
  noteMax: number
  onChange: (patch: Partial<NonNullable<Cell['pitchSnap']>>) => void
}): JSX.Element {
  const enabled = !!snap?.enabled
  const root = snap?.root ?? 0
  const scaleId: ScaleId = snap?.scale ?? 'major'
  // Compute the in-scale notes that fall inside the window. Drives
  // the readout AND helps catch the "no notes in window" footgun.
  const intervals = SCALE_INTERVALS[scaleId] ?? SCALE_INTERVALS.chromatic
  const lo = Math.max(0, Math.min(127, Math.min(noteMin, noteMax)))
  const hi = Math.max(0, Math.min(127, Math.max(noteMin, noteMax)))
  const inWindow: number[] = []
  const rootMod = ((root % 12) + 12) % 12
  let pcMask = 0
  for (const semi of intervals) pcMask |= 1 << (((semi + rootMod) % 12 + 12) % 12)
  for (let n = lo; n <= hi; n++) {
    if (pcMask & (1 << (((n % 12) + 12) % 12))) inWindow.push(n)
  }
  return (
    <div className="mt-1 border-t border-border pt-1.5 flex flex-col gap-1">
      <label
        className="flex items-center gap-2 text-[10px] cursor-pointer"
        title="Quantise the modulated / sequenced output to the nearest in-scale semitone. Acts on BOTH OSC (which sees a stepped [0..1] value, one position per scale degree) and MIDI Note (which receives the snapped note number). Lets a single generative source drive an audio synth AND a Pure Data / Max patch with the same melody. Requires the Note range above + midiScale or Scale 0.0–1.0."
      >
        <input
          type="checkbox"
          checked={enabled}
          onChange={(e) => onChange({ enabled: e.target.checked })}
        />
        <span className="label">Scale snap</span>
      </label>
      {enabled && (
        <>
          <div className="flex items-center gap-2 text-[10px]">
            <span className="label shrink-0" title="Tonic / root note of the scale.">
              Root
            </span>
            <select
              className="input select-compact text-[11px] py-0.5"
              style={{ width: 84 }}
              value={root}
              onChange={(e) => onChange({ root: Number(e.target.value) })}
            >
              {ROOT_LABELS.map((label, idx) => (
                <option key={idx} value={idx}>
                  {label}
                </option>
              ))}
            </select>
            <span className="label shrink-0 ml-1" title="Scale / mode. Chromatic = no snap.">
              Scale
            </span>
            <select
              className="input select-compact text-[11px] py-0.5 flex-1 min-w-0"
              value={scaleId}
              onChange={(e) => onChange({ scale: e.target.value as ScaleId })}
            >
              {SCALE_GROUPS.map((g) => (
                <optgroup key={g.label} label={g.label}>
                  {g.scales.map((id) => (
                    <option key={id} value={id}>
                      {SCALE_LABELS[id]}
                    </option>
                  ))}
                </optgroup>
              ))}
            </select>
          </div>
          {/* Live readout — "8 notes: C4 D4 E4 F4 G4 A4 B4 C5" etc.
              Hidden when the window has zero in-scale notes (the
              warning below takes over). */}
          {inWindow.length > 0 ? (
            <div className="text-[10px] text-muted leading-tight">
              <span className="text-text">{inWindow.length}</span>{' '}
              note{inWindow.length === 1 ? '' : 's'} in window:{' '}
              <span className="font-mono">
                {inWindow.slice(0, 16).map((n) => midiNoteName(n)).join(' ')}
                {inWindow.length > 16 ? ` … (+${inWindow.length - 16})` : ''}
              </span>
            </div>
          ) : (
            <div className="text-[10px] text-danger leading-tight">
              No notes of {SCALE_LABELS[scaleId]} fall inside the Note
              range. Widen Note range or pick a different scale.
            </div>
          )}
        </>
      )}
    </div>
  )
}

// Pretty name for a MIDI note number — "C4", "F#3", etc. Octave
// numbering follows the "middle C = C4" convention used by most DAWs.
function midiNoteName(n: number): string {
  const names = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']
  const safe = Math.max(0, Math.min(127, Math.round(n)))
  return names[safe % 12] + (Math.floor(safe / 12) - 1)
}
