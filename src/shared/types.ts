// Shared types used by main, preload, and renderer.

export type LfoShape = 'sine' | 'triangle' | 'sawtooth' | 'square' | 'rndStep' | 'rndSmooth'
// NextMode — the "follow action" executed when a scene's duration ends
// AND the per-scene play counter has reached `multiplicator`.
// Modelled on Ableton Live's clip follow actions.
//
//   stop   — do nothing (active flag clears unless cells are still running)
//   loop   — re-trigger this same scene (indefinite playback)
//   next   — next non-null slot in the sequence (wraps around)
//   prev   — previous non-null slot in the sequence (wraps around)
//   first  — jump to the first non-null slot in the sequence
//   last   — jump to the last non-null slot in the sequence
//   any    — random pick from every scene present in the sequence (including self)
//   other  — random pick from every scene present in the sequence EXCEPT self
//
// Migration: pre-rework sessions used 'off' | 'next' | 'random' which map to
// 'stop' | 'next' | 'any' respectively (handled in propagateDefaults).
export type NextMode =
  | 'stop'
  | 'loop'
  | 'next'
  | 'prev'
  | 'first'
  | 'last'
  | 'any'
  | 'other'

// Order here matters for the Inspector dropdown order: Ramp sits second,
// right before Envelope, so the "one-shot" options are grouped. The
// three modular-synth-inspired additions (sh / slew / chaos) live at the
// end, after Random, since they're kindred spirits.
export type ModType =
  | 'lfo'
  | 'ramp'
  | 'envelope'
  | 'arpeggiator'
  | 'random'
  | 'sh'
  | 'slew'
  | 'chaos'
export type LfoMode = 'unipolar' | 'bipolar'
export type LfoSync = 'free' | 'bpm'
// Envelope / Ramp sync:
//   'synced'   — stages are fractions of scene duration (A+D+S+R ≤ 100%).
//   'free'     — stages are absolute milliseconds (each max 10 000 ms).
//   'freeSync' — stages are fractions of a user-specified Total (ms). Same
//                feel as 'synced' (stages as %) but decoupled from the scene.
export type EnvSync = 'synced' | 'free' | 'freeSync'

// Arpeggiator — walks through a computed "ladder" of N steps derived from
// the user's Value, at the modulation rate.
export type ArpMode =
  | 'up'
  | 'down'
  | 'upDown'
  | 'downUp'
  | 'exclusion'
  | 'walk'
  | 'drunk'
  | 'random'
export type MultMode = 'div' | 'mult' | 'divMult'

export interface ArpeggiatorParams {
  steps: number // 1..8
  arpMode: ArpMode
  multMode: MultMode
}

// Random Generator — seeded PRNG that emits random values at the modulation
// rate. Seed is derived from the cell's Value string (so the same Value gives
// a reproducible stream).
export type RandomValueType = 'int' | 'float' | 'colour'
export interface RandomParams {
  valueType: RandomValueType
  min: number // inclusive
  max: number // inclusive (applies per channel for 'colour')
}

export interface EnvelopeParams {
  // Free-mode times (ms); each max 10 000.
  attackMs: number
  decayMs: number
  sustainMs: number
  releaseMs: number
  // Synced-mode fractions of scene duration; A+D+S+R should sum to <= 1.
  // Also used as the fraction of `totalMs` when sync='freeSync'.
  attackPct: number
  decayPct: number
  sustainPct: number
  releasePct: number
  // Held value between decay and release (0..1).
  sustainLevel: number
  sync: EnvSync
  // Total envelope length (ms) in sync='freeSync' mode. 0.1..300 000. The
  // Pct fields scale by this instead of the scene duration — gives a
  // synced-feel envelope whose length is independent of the scene.
  totalMs: number
}

// Sample & Hold — emits a fresh sample on every clock tick, holds between.
// Additive: the held value is scaled by depthPct and added to center (same
// signal path as the LFO). Mode picks bipolar (-1..1) vs unipolar (0..1)
// range, shared with LFO semantics.
export interface SampleHoldParams {
  // Smooth between samples (cosine-interpolated, like LFO's rndSmooth) vs
  // hard step. Smooth = analog S&H with built-in slew; step = classic
  // digital stair.
  smooth: boolean
  // Probability in [0, 1] that a clock tick produces a NEW sample. Below
  // 1.0 the output occasionally "holds" across multiple ticks, giving
  // that Music-Thing-Turing-Machine locked-in feel without the full state
  // machine.
  probability: number
}

// Slew limiter — generates an internal random target on each clock tick,
// then slews from the current value toward that target at independent
// rise/fall rates. Feels like a tamed random LFO with analog glide.
// Additive like LFO.
export interface SlewParams {
  // Rise / fall half-life in ms (time for 63 % of the move, exponential).
  // Split so you can dial in a slow-up / fast-down envelope feel.
  riseMs: number
  fallMs: number
  // Whether each clock tick draws a fresh random target (true) or just
  // follows a bipolar square wave at the clock rate (false — useful for
  // predictable glide ramps).
  randomTarget: boolean
}

// Chaos — iterates the logistic map x ← r · x · (1 − x) at the clock rate.
// Parameter `r` in [3.4, 4.0] tips the map from stable 2-/4-/8-cycles
// through the period-doubling cascade into full chaos. Produces values in
// (0, 1), mapped to bipolar at output.
export interface ChaosParams {
  r: number // 3.4 .. 4.0
}

// Ramp modulator — one-shot 0→target ramp over `rampMs` (or scene fraction
// when synced). Curve bends the interpolation: 0% = linear, +100% = strong
// ease-out (fast rise, long tail), -100% = strong ease-in (slow rise,
// sharp finish). When the ramp completes, modulation is effectively done
// and the clip's play-button sweep stops animating.
export interface RampParams {
  rampMs: number      // free-mode ramp length (ms), 0.1..300 000
  curvePct: number    // -100..100, linear at 0
  sync: EnvSync       // reuses envelope sync modes: synced / free / freeSync
  totalMs: number     // length (ms) used when sync='freeSync'. Same range as rampMs.
}

export interface Modulation {
  enabled: boolean
  type: ModType
  // LFO params
  shape: LfoShape
  mode: LfoMode
  depthPct: number // 0..100
  rateHz: number // 0.01..10 (used when sync='free')
  sync: LfoSync
  divisionIdx: number // 0..11 index into the BPM-synced time division table
  dotted: boolean
  triplet: boolean
  // Envelope params (used when type='envelope')
  envelope: EnvelopeParams
  // Ramp params (used when type='ramp')
  ramp: RampParams
  // Arpeggiator params (used when type='arpeggiator').
  // Rate is shared with the LFO (rateHz/sync/divisionIdx/dotted/triplet).
  arpeggiator: ArpeggiatorParams
  // Random Generator params (used when type='random'). Rate also shared.
  random: RandomParams
  // S&H / Slew / Chaos params (all share the LFO's rate controls).
  sh: SampleHoldParams
  slew: SlewParams
  chaos: ChaosParams
}

// Sequencer tempo source:
//   'bpm'   — lock step rate to the session's global BPM
//   'tempo' — use the sequencer's own per-clip bpm slider
//   'free'  — use the per-clip stepMs value (independent of any BPM)
export type SeqSyncMode = 'bpm' | 'tempo' | 'free'

// Sequencer drive mode:
//   'steps'     — classic 1..16 step cycle, each step plays stepValues[i].
//   'euclidean' — Bjorklund pattern: `pulses` active hits distributed as
//                 evenly as possible over `steps` total, rotated by
//                 `rotation`. Active step i still emits stepValues[i];
//                 inactive steps are silent (no OSC sent, cell output
//                 stays at its last sent value).
export type SeqMode = 'steps' | 'euclidean'

export interface SequencerParams {
  enabled: boolean
  steps: number // 1..16, active count (also euclidean total steps)
  syncMode: SeqSyncMode
  bpm: number // 10..500 — used when syncMode='sync' (1 step per beat)
  stepMs: number // used when syncMode='free'
  stepValues: string[] // fixed length 16; only first `steps` fire at runtime
  // Euclidean fields — only meaningful when mode === 'euclidean'.
  mode: SeqMode
  pulses: number   // 1..steps
  rotation: number // 0..steps-1
}

export interface Cell {
  // Destination. If `destLinkedToDefault` is true, destIp/destPort track the session default.
  destIp: string
  destPort: number
  destLinkedToDefault: boolean
  // OSC address path. If `addressLinkedToDefault`, tracks session default.
  oscAddress: string
  addressLinkedToDefault: boolean
  // Raw value string — type auto-detected at send time (bool → int → float → string).
  value: string
  delayMs: number // 0..10000
  transitionMs: number // 0..10000
  modulation: Modulation
  sequencer: SequencerParams
  // If true, each numeric output (post-modulation) is clamped to [0, 1].
  // Applies to each token when `value` contains space-separated values.
  scaleToUnit: boolean
  // MIDI binding that triggers/stops just this clip (one per cell).
  midiTrigger?: MidiBinding
}

/** Max number of space-separated values allowed in a single Value box. */
export const MAX_VALUE_TOKENS = 16

// Track / Instrument vocabulary
// ────────────────────────────────────────────────────────────────────────
// Pre-merger naming: "Messages" = the rows in the Edit grid. Each row was
// a flat OSC sender.
//
// Merger naming (this build): "Instruments". Each row is either:
//   • a TEMPLATE header — a parent group à la Reaper, holds no clips itself
//     but visually owns the rows below it; or
//   • a FUNCTION row — child of a Template, owns clips like the old Messages.
//
// We keep the storage shape as a flat `tracks: Track[]` so the engine,
// scene cell maps, MIDI bindings, etc. stay untouched. The new `kind` /
// `parentTrackId` fields just describe the visual hierarchy.
//
// Old sessions (pre-merger) load with every track defaulted to
// `kind: 'function'` / no parent — they render as orphan Functions, exactly
// matching the previous look.
export type TrackKind = 'template' | 'function'

export interface Track {
  id: string
  name: string
  // Reaper-style hierarchy. Templates are header rows that don't carry
  // their own clips; Functions are the child rows that do.
  kind: TrackKind
  // Function rows point at their owning template (nullable for orphan
  // functions instantiated outside any template).
  parentTrackId?: string
  // Source-of-truth for instantiated rows: the Pool template they came
  // from. Lets us refresh defaults if the template definition changes.
  // Both Template and Function rows can carry this.
  sourceTemplateId?: string
  sourceFunctionId?: string
  // Optional per-track defaults used by "Send to clips".
  defaultOscAddress?: string
  defaultDestIp?: string
  defaultDestPort?: number
  // MIDI binding for triggering this track's cell in the focused scene.
  midiTrigger?: MidiBinding
}

// Pool / Instrument Templates
// ────────────────────────────────────────────────────────────────────────
// A Template = a named bundle of pre-mapped Functions (e.g. OCTOCOSME with
// volume / tilt / colour). Functions inside a Template inherit IP/port +
// OSC base path from the template unless they override.
//
// This deliberately mirrors dataFLOU's `ParamMeta` vocabulary so the
// eventual merger can import C++ library configs as Templates and export
// the user's authored Templates back out:
//   - paramType ↔ ParamType (Bool, Number, Vector, Colour, String…)
//   - nature ↔ Nature (Lin / Log / Exp)
//   - streamMode ↔ StreamMode (Streaming / Discrete / Polling)
//   - unit ↔ unit
//   - min/max/init ↔ range_min / range_max / range_init
export type FunctionParamType =
  | 'bool'
  | 'int'
  | 'float'
  | 'v2'
  | 'v3'
  | 'v4'
  | 'colour'
  | 'string'

export type FunctionParamNature = 'lin' | 'log' | 'exp'

export type FunctionStreamMode = 'streaming' | 'discrete' | 'polling'

export interface InstrumentFunction {
  id: string
  name: string                  // e.g. "Volume", "Tilt", "Colour"
  // OSC path. May start with "/" or be relative to the template's base
  // path (resolved at instantiation). e.g. "volume" + base "/octocosme"
  // → "/octocosme/volume".
  oscPath: string
  // Optional per-function destination override. Inherits from template
  // when absent.
  destIpOverride?: string
  destPortOverride?: number
  // Typed parameter metadata — informational today, drives auto-rendered
  // UI controls in a future iteration. Already useful for the merger
  // conversation: every Function is self-describing.
  paramType: FunctionParamType
  nature: FunctionParamNature
  streamMode: FunctionStreamMode
  min?: number
  max?: number
  init?: number
  unit?: string                 // "Hz", "dB", "°", "RGBA", "m/s", …
  smoothMs?: number
  // Free-form notes for the player.
  notes?: string
}

export interface InstrumentTemplate {
  id: string
  name: string                  // e.g. "OCTOCOSME"
  description: string
  color: string                 // hex; drives the Pool / sidebar nesting tint
  // Defaults inherited by every Function unless overridden.
  destIp: string
  destPort: number
  oscAddressBase: string        // e.g. "/octocosme"
  // Polyphony hint (informational for now; voice allocation is a later
  // engine feature). 1 = monophonic.
  voices: number
  functions: InstrumentFunction[]
  // True when this template is shipped by the app rather than authored
  // by the user. Read-only in the inspector.
  builtin?: boolean
}

export interface Pool {
  templates: InstrumentTemplate[]
}

export interface Scene {
  id: string
  name: string
  color: string // hex like "#ff7a3d"
  notes: string // free-form text shown italic under the name
  durationSec: number // 0.5..300
  nextMode: NextMode
  // How many times the scene plays before its follow action fires. 1 = play
  // once and advance (classic behavior). 2 = play twice then advance, etc.
  // Setting >1 with nextMode='loop' is effectively redundant (still loops
  // forever), but harmless.
  multiplicator: number
  // Optional per-scene Morph-in duration (ms). When this scene is
  // triggered by the user via GO / Space / trigger button, every cell
  // glides to its new target over this duration instead of using the
  // cell's own transitionMs. Overridden by an explicit transport-level
  // morph time if one is set at trigger time. Omitted = no per-scene
  // preference.
  morphInMs?: number
  // Sparse: key is trackId. Missing = empty cell.
  cells: Record<string, Cell>
  // MIDI binding for triggering the whole scene.
  midiTrigger?: MidiBinding
}

export interface MidiBinding {
  kind: 'note' | 'cc'
  channel: number // 0..15
  number: number // note number or CC number
}

// ---- Meta Controller ----
// A global bank of 8 circular knobs. Each knob scales a normalized 0..1
// position into [min, max] via a curve (linear / log / exp), then blasts the
// value to up to 8 OSC destinations simultaneously. Live positions + config
// are saved with the session.

// All curve shapes applied by scaleMetaValue. See that function for the
// exact math of each. Grouped loosely:
//   Mathematical     linear log exp geom
//   Eased            easeIn easeOut cubic sqrt
//   S-shapes         sigmoid smoothstep
//   Perceptual       db gamma
//   Utility          step invert
export type MetaCurve =
  | 'linear'
  | 'log'
  | 'exp'
  | 'geom'
  | 'easeIn'
  | 'easeOut'
  | 'cubic'
  | 'sqrt'
  | 'sigmoid'
  | 'smoothstep'
  | 'db'
  | 'gamma'
  | 'step'
  | 'invert'

export interface MetaDest {
  destIp: string
  destPort: number
  oscAddress: string
  enabled: boolean
}

export interface MetaKnob {
  name: string // user-assignable ("Volume", "Color R", …)
  min: number // scaled output lower bound
  max: number // scaled output upper bound
  curve: MetaCurve
  value: number // normalized position 0..1 (what the UI shows; scaled at send)
  // Smoothing time (ms) applied to value changes in the engine — the knob
  // tweens from its current position toward the new target over this many
  // milliseconds, firing OSC at ~60 Hz. Smooths out the 1/127 quantization
  // steps of MIDI CC input so receivers see a continuous ramp rather than
  // a staircase. 0 = no smoothing (instant).
  smoothMs: number
  destinations: MetaDest[] // up to META_MAX_DESTS entries
  // Optional MIDI CC binding. While bound, incoming CC values (0..127) map
  // directly to normalized 0..1 knob position and broadcast to destinations.
  // Set via global MIDI Learn (same flow as scene / clip triggers). Although
  // the MidiBinding type supports notes, knobs are CC-only by convention.
  midiCc?: MidiBinding
}

export interface MetaController {
  visible: boolean // whether the bar is currently expanded in the UI
  selectedKnob: number // 0..7 — which knob's details are shown on the right
  height: number // pixels — user-resizable via drag handle at the bottom
  knobs: MetaKnob[] // fixed length META_KNOB_COUNT
}

// 32 knobs arranged as 4 banks of 8 (A/B/C/D). Only one bank is shown in
// the Meta Controller bar at a time; the bank selector lives to the right of
// the knob row. `selectedKnob` is a GLOBAL index (0..31).
export const META_KNOB_COUNT = 32
export const META_BANK_COUNT = 4
export const META_KNOBS_PER_BANK = 8
export const META_MAX_DESTS = 8

export interface Session {
  version: 1
  name: string
  tickRateHz: number // 10..300
  globalBpm: number // 10..500, default for sync-mode sequencers
  sequenceLength: number // 1..128, number of visible slots in the Sequence view
  defaultOscAddress: string
  defaultDestIp: string
  defaultDestPort: number
  tracks: Track[] // rows (Templates + Functions, see Track interface)
  scenes: Scene[] // columns
  // Pool of authored Instrument Templates. Sourced from a builtin
  // library + user-authored entries; persisted with the session so a
  // session is self-contained. Templates instantiate into rows of the
  // `tracks` array via the Pool drawer.
  pool: Pool
  sequence: (string | null)[] // 128-length array; only first `sequenceLength` are used
  focusedSceneId: string | null
  midiInputName: string | null
  // Transport-level MIDI bindings. These fire the cue GO (identical to
  // clicking the GO button / hitting Space) and set the transport-level
  // morph time (CC value 0..127 → 0..10 000 ms, linear). Both are
  // optional and CC/note-bindable via the global MIDI Learn workflow.
  goMidi?: MidiBinding
  morphTimeMidi?: MidiBinding
  // Global Meta Controller bank — 8 user-assignable knobs that broadcast a
  // scaled value to up to 8 OSC destinations each. Persisted with the session.
  metaController: MetaController
}

// ---- IPC payloads ----

export interface EngineState {
  activeBySceneAndTrack: Record<string, Record<string, boolean>>
  // Per (sceneId, trackId) → current sequencer step index (0-based).
  seqStepBySceneAndTrack: Record<string, Record<string, number>>
  // Per (sceneId, trackId) → the current output value as a string, for live
  // display in the cell tile. Updated at ~20Hz while any cell is armed.
  currentValueBySceneAndTrack: Record<string, Record<string, string>>
  activeSceneId: string | null
  activeSceneStartedAt: number | null
  // Which sequence slot was the source of the current activeSceneId.
  // Used by the Sequence-view grid to highlight ONLY the specific slot
  // that fired — a scene placed at multiple positions in the grid should
  // not highlight every instance simultaneously. `null` when the scene
  // was triggered from the palette / column header / MIDI / cue and
  // didn't originate from a specific sequence slot.
  activeSequenceSlotIdx: number | null
  tickRateHz: number
}

// One outgoing OSC message as surfaced to the renderer (OSC monitor panel).
// Batched in main on a 50ms timer to keep IPC cheap — the monitor may see
// thousands of sends per second at 120Hz ticks × multiple active cells.
export interface AutosaveEntry {
  path: string
  mtimeMs: number
  sessionName: string
  sizeBytes: number
}

export interface OscEvent {
  timestamp: number // Date.now() ms
  ip: string
  port: number
  address: string
  args: { type: 'i' | 'f' | 's' | 'T' | 'F'; value: number | string | boolean }[]
}

// Fired when a send fails — surfaced in the UI as a red health dot next
// to destinations and as [ERR] rows in the OSC monitor. Socket-level
// errors that can't be attributed to one destination use ip='*', port=0.
export interface OscErrorEvent {
  timestamp: number
  ip: string
  port: number
  address: string
  message: string
}

// Window.api signature — consumed by renderer.
// MIDI is handled via Web MIDI in the renderer (not through IPC).
export interface ExposedApi {
  // Engine
  triggerCell: (sceneId: string, trackId: string) => Promise<void>
  stopCell: (sceneId: string, trackId: string) => Promise<void>
  // `opts.morphMs` — optional scene-to-scene morph duration in ms. When
  //   set, every cell in the scene glides over this time, and any tracks
  //   active from the previous scene that don't exist in this one fade
  //   out over the same duration.
  // `opts.sourceSlotIdx` — slot index (0-based into session.sequence) the
  //   trigger originated from. Sequence view uses it to highlight the
  //   specific slot that fired when a scene is placed multiple times.
  triggerScene: (
    sceneId: string,
    opts?: { morphMs?: number; sourceSlotIdx?: number | null }
  ) => Promise<void>
  stopScene: (sceneId: string) => Promise<void>
  stopAll: () => Promise<void>
  panic: () => Promise<void>
  pauseSequence: () => Promise<void>
  resumeSequence: () => Promise<void>
  setTickRate: (hz: number) => Promise<void>
  updateSession: (session: Session) => Promise<void>
  // Meta Controller live output — continuous while the user drags a knob.
  // Renderer sends the normalized 0..1 position; main scales via the knob's
  // min/max/curve (fetched from the last pushed session) and blasts OSC to
  // every enabled destination.
  sendMetaValue: (knobIndex: number, normalizedValue: number) => Promise<void>
  // Session I/O
  sessionSaveAs: (session: Session) => Promise<string | null> // returns filepath
  sessionSave: (session: Session, path: string) => Promise<boolean>
  sessionOpen: () => Promise<{ session: Session; path: string } | null>
  // Autosave / crash recovery
  autosaveCrashCheck: () => Promise<{ crashed: boolean; entries: AutosaveEntry[] }>
  autosaveList: () => Promise<AutosaveEntry[]>
  autosaveLoad: (path: string) => Promise<Session>
  // Events from main
  onEngineState: (cb: (s: EngineState) => void) => () => void
  // Batched outgoing OSC events (for the OSC monitor panel). Each callback
  // fire delivers a batch of messages accumulated on the main side.
  onOscEvents: (cb: (batch: OscEvent[]) => void) => () => void
  // Batched OSC send errors. Rendered as the health dot next to each
  // destination + as [ERR] rows in the OSC monitor drawer.
  onOscErrors: (cb: (batch: OscErrorEvent[]) => void) => () => void
}
