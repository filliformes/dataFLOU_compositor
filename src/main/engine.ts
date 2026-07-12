// Scene engine: per-track state machine + fixed-tick LFO + scene auto-advance.
//
// Playback model:
//  - Each Track has at most ONE active Cell at any time (across all scenes).
//  - Triggering a Cell:
//      * After its delayMs, morph the track's center value from whatever it is now
//        to the new Cell's value over transitionMs (linear). LFO phase for the track
//        continues uninterrupted.
//  - Stopping a Cell:
//      * Morph center from current → 0 over transitionMs, then disarm (no more OSC).
//  - Scene trigger: equivalent to triggering every non-empty cell in that column.
//  - Scene auto-advance: only driven by explicit scene triggers (individual cell
//    triggers do NOT start the scene duration timer). After durationSec, nextMode
//    picks the next scene (or off).

import type {
  Cell,
  DerivedOp,
  EngineState,
  GenerativeConfig,
  InputConditionerConfig,
  InputStage,
  InstrumentTemplate,
  LearnedState,
  LfoShape,
  Modulation,
  OscEvent,
  PoseSequence,
  PoseWaypoint,
  Scene,
  SequencerParams,
  Session,
  StateTrigger,
  Track
} from '@shared/types'
import {
  META_KNOB_COUNT,
  SCALE_INTERVALS,
  SCENE_WEIGHT_DEFAULT,
  SCENE_WEIGHT_MAX,
  SCENE_WEIGHT_MIN
} from '@shared/types'

// ── Input Conditioning runtime shapes (v0.6) ─────────────────────────
// One entry per arg slot per conditioner key; `stages[i]` is the
// filter state for the template chain's i-th stage. Every field is
// optional — lazily initialised on first sample per stage type.
interface ConditionerStageState {
  // oneEuro
  xHat?: number
  dxHat?: number
  // smooth
  y?: number
  // median — ring of the last `window` samples (newest at end)
  ring?: number[]
  // slewLimit
  out?: number
  // deadband
  lastOut?: number
  // autoRange — leaky min/max envelope
  min?: number
  max?: number
}
interface ConditionerSlotState {
  lastT: number
  // Ordered stage-type signature (e.g. "median,oneEuro"); re-warm when
  // it changes so stale per-stage state can't bleed across a type swap.
  sig: string
  stages: ConditionerStageState[]
}
// (v0.6) Per-parameter hardware scaling uses the SHARED `scaleHardwareValue`
// from factory (imported below) so the engine's catch pipeline and the
// renderer's live track readout can never drift.

// Hard cap on distinct (template|device|address) conditioner keys so a
// port-churning source can't grow the map unbounded (same rationale as
// MAX_HW_MOVEMENT_DEVICES).
const MAX_CONDITIONER_KEYS = 512
// Hard cap on distinct OSC addresses tracked PER device (inner maps of
// hardwareLastValues / hardwareLastChangeMs / stateInputLatest). Real
// controllers use a fixed address set well under this; the cap only
// bounds a source that encodes data in the address path. FIFO-evicts
// the oldest address (Map preserves insertion order).
const MAX_ADDRESSES_PER_DEVICE = 512
function capInnerAddressMap(m: Map<string, unknown>, address: string): void {
  if (m.size >= MAX_ADDRESSES_PER_DEVICE && !m.has(address)) {
    const oldest = m.keys().next().value
    if (oldest !== undefined) m.delete(oldest)
  }
}
// (v0.6.4) Derived Parameter combiner ops. `vals` are the latest RAW
// source values (already finite-filtered by the caller). The universal
// Output ×scale+offset is applied by the CALLER, so `scaleOffset` here is
// just "pass source[0] through" — its transform IS that universal post.
function computeDerived(op: DerivedOp, vals: number[]): number {
  if (vals.length === 0) return Number.NaN
  switch (op) {
    case 'magnitude':
      return Math.sqrt(vals.reduce((s, x) => s + x * x, 0))
    case 'sum':
      return vals.reduce((s, x) => s + x, 0)
    case 'difference':
      return vals.slice(1).reduce((s, x) => s - x, vals[0])
    case 'average':
      return vals.reduce((s, x) => s + x, 0) / vals.length
    case 'min':
      return Math.min(...vals)
    case 'max':
      return Math.max(...vals)
    case 'scaleOffset':
      return vals[0]
    default:
      return Number.NaN
  }
}
// Scope ring length: ~40 s of 50 Hz packets, so the UI can offer an
// editable time window up to ~30 s without starving. Each poll can
// request a windowMs to bound how much of this it actually ships.
const CONDITIONER_SCOPE_LEN = 2000
// How long a scope watch survives without being polled. Long enough
// that leaving a Parameter inspector and coming back within 5 minutes
// finds the scope still populated + rolling (the engine keeps
// collecting samples for live watches even while nobody is looking —
// it's a cheap array push per matching packet). After this it's
// pruned and its buffer freed.
const CONDITIONER_SCOPE_TTL_MS = 5 * 60 * 1000
// Gate length for a State Trigger note in 'oneShot' mode — there is no
// exit event to release it, so it auto-releases after this.
const STATE_ONESHOT_GATE_MS = 200

// Generative history ring buffer length. Caps the no-repeat memory
// and the shuffle-cycle "already played" set. ~24 entries covers a
// typical session's worth of scene plays without growing unbounded
// during long installations.
const GENERATIVE_HISTORY_LEN = 24
import {
  advanceDrift,
  autoDetectOscArg,
  bounceStepDuration,
  buildArpLadder,
  buildArpPattern,
  cellularInitialRow,
  densityGate,
  effectiveLfoHz,
  euclidean,
  evolveCellular,
  generateDrawCurveFromValues,
  generateStepValue,
  stepHash,
  hashSeedString,
  mulberry32,
  parseValueTokens,
  polyrhythmGate,
  readNumber,
  scaleHardwareValue,
  scaleMetaValue
} from '@shared/factory'
import { OscSender, type OscErrorEvent, type OscSendEvent } from './osc'
import { MidiOutSender } from './midiOut'
import type { MidiSendEvent, MidiErrorEvent } from '@shared/types'

type OscArg = { type: 'i' | 'f' | 's' | 'T' | 'F'; value: number | string | boolean }

const TWO_PI = Math.PI * 2

/**
 * Snap a continuous MIDI note number to the nearest in-scale semitone
 * for the given (`scale`, `root`) combo. Returns the snapped note as
 * an integer.
 *
 * The picker walks outward symmetrically from `Math.round(floatNote)`
 * until it finds an in-scale degree, so a value EXACTLY between two
 * scale degrees rounds to the lower one (consistent — no jitter on
 * the boundary). Out-of-range search is bounded at ±12 semitones
 * (one octave); if no in-scale note exists within that radius —
 * impossible for any non-empty scale — we fall back to the
 * non-snapped rounded value.
 *
 * `intervals` is the precomputed semitone offset list from
 * SCALE_INTERVALS (e.g. major = [0,2,4,5,7,9,11]). `root` is a
 * pitch class 0..11 where 0 = C.
 *
 * The bitmask trick: we pre-shift each interval by `root` and OR them
 * into a 12-bit `pcMask`, then test membership of a candidate note's
 * pitch-class via a single AND. Avoids a per-candidate Array.includes
 * inside the engine's per-tick hot loop.
 */
function snapToScale(floatNote: number, intervals: number[], root: number): number {
  if (intervals.length === 0) return Math.round(floatNote)
  // Build the 12-bit pitch-class mask for (intervals, root). Cheap to
  // recompute every call (≤12 ORs); we could memoise on (scaleId, root)
  // but the cost is so low this is fine.
  let pcMask = 0
  const rootMod = ((root % 12) + 12) % 12
  for (const semi of intervals) {
    pcMask |= 1 << (((semi + rootMod) % 12 + 12) % 12)
  }
  const baseNote = Math.round(floatNote)
  // Walk outward: 0, +1, -1, +2, -2, … up to ±12. The first in-scale
  // candidate wins. Ties (a value at the midpoint between two scale
  // degrees) round DOWN by construction since `+offset` is checked
  // BEFORE `-offset`.
  for (let offset = 0; offset <= 12; offset++) {
    const tryHi = baseNote + offset
    if (tryHi >= 0 && tryHi <= 127 && (pcMask & (1 << (((tryHi % 12) + 12) % 12)))) {
      return tryHi
    }
    if (offset > 0) {
      const tryLo = baseNote - offset
      if (tryLo >= 0 && tryLo <= 127 && (pcMask & (1 << (((tryLo % 12) + 12) % 12)))) {
        return tryLo
      }
    }
  }
  return baseNote
}

// ─────────────────────────────────────────────────────────────────
// Two-stage modulator — the SECOND stage needs its own copy of all
// the modulator-state fields the first stage uses (phase, S&H held
// value, attractor trajectory, etc.) so both stages can run in
// parallel without trampling each other. We keep this struct
// separate from TrackState so the per-tick advance + eval helpers
// can be parameterised over either view via structural subtyping.
// ─────────────────────────────────────────────────────────────────
interface Mod2State {
  phase: number
  rndStepLastTick: number
  rndStepValue: number
  rndSmoothPrev: number
  rndSmoothNext: number
  shHeld: number
  shPrev: number
  shLastAdvanceAt: number
  slewValue: number
  slewTarget: number
  slewLastAdvanceAt: number
  chaosX: number
  chaosLastAdvanceAt: number
  attractorW: number
  attractorX: number
  attractorY: number
  attractorZ: number
  attractorRawX: number
  attractorRawY: number
  attractorRawZ: number
  attractorRawW: number
  attractorLastUpdateMs: number
  attractorSpeed: number
  // Random modulator state (used when Mod 2's type is 'random'). The
  // engine's Mod 1 Random emits a value array (one per slot); for
  // Mod 2 we only need ONE bipolar sample per advance, so we store a
  // single number here. Clock-driven via standard rateHz + sync.
  randCurrent: number
  randLastAdvanceAt: number
  // Arpeggiator state (used when Mod 2's type is 'arpeggiator').
  // Walks through a 0..N-1 step ladder per Mod 2's rate; the bipolar
  // output is the step's normalised position. Mirrors the Mod 1 arp
  // state fields exactly.
  arpStepIdx: number
  arpPatternIdx: number
  arpLastAdvanceAt: number
  // Stage 2's own PRNG so consuming the random stream doesn't shift
  // Mod 1's behaviour — toggling Mod 2 on/off must not change what
  // Mod 1 produces given the same cell value seed.
  rng: (() => number) | null
}

function makeMod2State(): Mod2State {
  return {
    phase: 0,
    rndStepLastTick: -1,
    rndStepValue: 0,
    rndSmoothPrev: 0,
    rndSmoothNext: 0,
    shHeld: 0,
    shPrev: 0,
    shLastAdvanceAt: 0,
    slewValue: 0,
    slewTarget: 0,
    slewLastAdvanceAt: 0,
    chaosX: 0.5,
    chaosLastAdvanceAt: 0,
    attractorW: 0.5,
    attractorX: 0.5,
    attractorY: 0.5,
    attractorZ: 0.5,
    attractorRawX: 0.1,
    attractorRawY: 0,
    attractorRawZ: 0,
    attractorRawW: 0,
    attractorLastUpdateMs: 0,
    attractorSpeed: 0,
    randCurrent: 0,
    randLastAdvanceAt: 0,
    arpStepIdx: 0,
    arpPatternIdx: 0,
    arpLastAdvanceAt: 0,
    rng: null
  }
}

interface TrackState {
  // Phase in LFO cycles. Reset to 0 on each trigger so shapes restart cleanly.
  phase: number
  // hrtime ms when the current clip was last triggered (for envelope time math).
  triggerTime: number
  // Center morph — arrays so a multi-value cell morphs each slot independently.
  // Lengths may differ between triggers; padding with zeros for missing slots.
  fromCenter: number[]
  toCenter: number[]
  morphStart: number // hrtime ms
  morphMs: number
  // Stepped-random helpers
  rndStepLastTick: number
  rndStepValue: number
  rndSmoothPrev: number
  rndSmoothNext: number
  // Sequencer state
  seqStepIdx: number
  seqStepStart: number // hrtime ms when this step began
  // Polyrhythm / density / cellular / drift / ratchet — one shared
  // bookkeeping block. Only the fields relevant to the current mode
  // are touched per tick; the rest are dormant.
  // - cellRow: current Wolfram row (bitmask), evolves each cycle
  // - driftPos: current Brownian playhead position (0..steps-1)
  // - seqRng: per-track PRNG used by drift + ratchet for determinism
  //   across triggers; seeded once at trigger time
  // - ratchetSubdiv: 1 = no ratchet, 2..maxDiv = currently bursting
  // - ratchetSubIdx: which sub-pulse we're on (0..ratchetSubdiv-1)
  // - ratchetSubStart: hrtime ms when the current sub-pulse started
  seqCellRow: number
  seqDriftPos: number
  seqRng: (() => number) | null
  seqRatchetSubdiv: number
  seqRatchetSubIdx: number
  seqRatchetSubStart: number
  // Tracks the previous step idx so we can detect cycle-wrap (idx → 0)
  // and trigger cellular evolution + ratchet re-rolls there.
  seqLastStepIdx: number
  // Draw + generative — at each cycle wrap, the engine generates a
  // fresh per-step curve BASED on the user's drawn curve (with
  // hash-driven jitter). The user's drawValues stay intact so they
  // can revert by turning Generative off. -1 cycle id forces an
  // initial generation at trigger time.
  drawGeneratedValues: number[]
  drawGenCycle: number
  // Per-token min/max across one full cycle's worth of generated
  // values — populated at trigger AND at cycle wrap (so cellular's
  // evolving row gets a fresh range each cycle). Drives the
  // scaleToUnit auto-range path: instead of blunt clamp([0, 1]),
  // we remap the cycle's value range to [0, 1] so the user sees
  // full-range output even when their seed produces values that
  // would otherwise saturate at 0 or 1.
  seqGenRanges: Array<{ min: number; max: number }>
  // Last-seen `cell.scaleToUnit` for this track. When the user
  // toggles the checkbox mid-play, the per-tick loop notices the
  // flip and recomputes `seqGenRanges` so auto-range takes effect
  // immediately (no need to stop + re-trigger the clip).
  prevScaleToUnit: boolean | null
  // Set true the first time the engine emits a numeric OSC payload
  // for this track. Used by Hold rest-behaviour to allow the
  // initial emit (so the receiver sees SOMETHING) before deduping
  // subsequent identical sends.
  hasEmittedNumeric: boolean
  // Previous Ramp mode — used to auto-retrigger the ramp when the
  // user flips Mode mid-flight. Without this, switching Normal →
  // Inverted while a cell is playing would leave elapsedSec past
  // lenSec, so the new mode settles at its final value immediately
  // and the change "doesn't seem to do anything." Resetting
  // triggerTime makes the new ramp fire from t=0.
  prevRampMode: 'normal' | 'inverted' | 'loop' | 'from' | null
  // Arpeggiator state
  arpStepIdx: number        // current step index into the ladder (0..N-1)
  arpPatternIdx: number     // current index into the pattern array (deterministic modes)
  arpLastAdvanceAt: number  // hrtime ms — when the last arp step fired
  // Random-Generator state
  randRng: (() => number) | null // seeded PRNG; null until the clip is triggered
  randLastAdvanceAt: number       // hrtime ms — when the last random sample fired
  randCurrent: number[]           // last emitted sample (1 item for int/float, 3 for colour)
  // Sample & Hold state — one held value in [-1, 1] plus a "prev" for
  // cosine interpolation when smooth=true. shLastAdvanceAt tracks the
  // last clock tick in hrtime ms (shared with the LFO rate controls).
  shHeld: number
  shPrev: number
  shLastAdvanceAt: number
  // Slew state — one current interpolated value and one target in
  // [-1, 1]. Filter is a simple first-order IIR with different time
  // constants per direction.
  slewValue: number
  slewTarget: number
  slewLastAdvanceAt: number
  // Chaos (logistic map) state — current iterate in (0, 1). Seeded with
  // a small perturbation on each trigger so identical cells diverge.
  chaosX: number
  chaosLastAdvanceAt: number
  // Strange Attractor state — 4 channels (W/X/Y/Z) so 3D attractors
  // can fan out X/Y/Z + speed and 4D types map W/X/Y/Z natively.
  // All values pre-normalised to [0, 1] after each integration step;
  // raw integration uses a separate scratchpad on the modulator.
  // `attractorLastUpdateMs` is hrtime ms so step deltas are stable
  // independent of the engine's tick rate.
  attractorW: number
  attractorX: number
  attractorY: number
  attractorZ: number
  // Raw (un-normalised) state — kept so each tick's integration
  // continues from the previous trajectory point in the attractor's
  // native units rather than from the [0,1]-clamped renderable values.
  attractorRawX: number
  attractorRawY: number
  attractorRawZ: number
  attractorRawW: number
  attractorLastUpdateMs: number
  // Instantaneous speed (Euclidean norm of (dx,dy,dz) per integration
  // step) normalised to [0, 1] — used as the 4th channel for 3D
  // attractor types. EMA-smoothed so it doesn't look spasmodic.
  attractorSpeed: number
  // Per-slot Variation factor — stable random in [-1, 1] sampled at
  // trigger time, scaled later by the per-slot variation% in the
  // emit loop. Fixed for the lifetime of the trigger so each slot's
  // modulator amplitude has a consistent character (vs jittery
  // tick-to-tick noise). Array length matches the cell's arg count.
  routingVariationFactors: number[]
  // ── Gesture modulator playback ──────────────────────────────────
  // Sampled X / Y of the recorded gesture at the current playhead
  // position. Updated once per tick in the Gesture modulator advance
  // block (when `cell.modulation.type === 'gesture'`); read by
  // `gestureChannelFor` in the per-slot emit loop. Default 0.5 =
  // centre of the unit square so an unrecorded gesture emits a
  // quiet centre value rather than (0, 0).
  gestureX: number
  gestureY: number
  // Per-tick cache for the merged-mode radial distance, so multi-arg
  // cells in merged mode don't re-compute sqrt() per slot. The cache
  // is valid when gestureMergedCacheTickIdx === gestureCacheTickStamp;
  // the stamp is bumped at the top of every tick (just below the
  // gesture-advance block).
  gestureMergedCache: number
  gestureMergedCacheTickIdx: number
  gestureCacheTickStamp: number
  // Active cell ref (source of params)
  activeSceneId: string | null
  stopping: boolean
  armed: boolean
  delayTimer: NodeJS.Timeout | null
  // ── MIDI Note tracking ───────────────────────────────────────────
  // Last (note, channel, port) of a Note On still hanging (no Note
  // Off sent yet). Null when no note is currently held. The engine
  // uses these on every new Note On / cell stop / scene change to
  // emit the corresponding Note Off so we never leave stuck notes.
  midiHeldNote: number | null
  midiHeldChannel: number
  midiHeldPort: string
  // Last CC value sent per (port + channel + cc) — used to suppress
  // redundant CC sends in Hold rest-behaviour. Key format is
  // "<port>|<ch>|<cc>" (string) → last 0..127 int. Lives on the
  // track state (not global) so two cells targeting the same CC
  // don't fight each other's dedup cache.
  midiLastCc: Map<string, number>
  // Pending Note Off scheduler — when `gateLengthMs > 0` we set a
  // setTimeout to fire the Note Off after the gate. Cleared (or
  // re-scheduled) on every new Note On / stop so a quick re-trigger
  // doesn't leave a stale timer firing the Note Off after the new
  // note has already started.
  midiGateTimer: NodeJS.Timeout | null
  // For non-numeric values we only send on change. The "source" key tracks
  // scene/step so we know when to re-send.
  lastSentString: string | null
  lastStringAtSceneId: string | null
  lastStringAtStep: number
  // Last numeric value sent per arg position. Persistence reads from
  // here on every tick to freeze pinned slots at their last value.
  // Grows on demand to match the sent-out array length.
  lastSentNumeric: number[]
  // Last velocity actually pushed out on a noteOn — including any
  // humanize jitter the engine added. The renderer reads this so the
  // displayed velocity in the cell tile reflects what the wire saw,
  // not the static cell.velocity field. `null` until the first
  // noteOn has fired.
  lastEmittedVelocity: number | null
  // ── Two-stage modulator state ───────────────────────────────────
  // Parallel modulator-state slot used when `cell.modulation2` is
  // enabled. Same fields as the Mod 1 modulator-state subset on
  // TrackState, kept separate so both stages can run independent
  // LFOs / S&H / Attractor trajectories at the same time. Always
  // allocated even when Mod 2 is off (cheap struct; saves a guard
  // on every tick).
  m2: Mod2State
}

function makeTrackState(): TrackState {
  return {
    phase: 0,
    triggerTime: 0,
    fromCenter: [],
    toCenter: [],
    morphStart: 0,
    morphMs: 0,
    rndStepLastTick: -1,
    rndStepValue: 0,
    rndSmoothPrev: 0,
    rndSmoothNext: 0,
    seqStepIdx: 0,
    seqStepStart: 0,
    seqCellRow: 0,
    seqDriftPos: 0,
    seqRng: null,
    seqRatchetSubdiv: 1,
    seqRatchetSubIdx: 0,
    seqRatchetSubStart: 0,
    seqLastStepIdx: -1,
    seqGenRanges: [],
    prevScaleToUnit: null,
    hasEmittedNumeric: false,
    prevRampMode: null,
    drawGeneratedValues: [],
    drawGenCycle: 0,
    arpStepIdx: 0,
    arpPatternIdx: 0,
    arpLastAdvanceAt: 0,
    randRng: null,
    randLastAdvanceAt: 0,
    randCurrent: [],
    shHeld: 0,
    shPrev: 0,
    shLastAdvanceAt: 0,
    slewValue: 0,
    slewTarget: 0,
    slewLastAdvanceAt: 0,
    chaosX: 0.5,
    chaosLastAdvanceAt: 0,
    // Attractor — start at a non-fixed-point seed so the trajectory
    // doesn't immediately converge. Lorenz / Rössler / etc. seeds
    // are explicitly chosen to land on the chaotic regime; the
    // per-attractor reseed at trigger time overrides these.
    attractorW: 0.5,
    attractorX: 0.5,
    attractorY: 0.5,
    attractorZ: 0.5,
    attractorRawX: 0.1,
    attractorRawY: 0,
    attractorRawZ: 0,
    attractorRawW: 0,
    attractorLastUpdateMs: 0,
    attractorSpeed: 0,
    routingVariationFactors: [],
    gestureX: 0.5,
    gestureY: 0.5,
    gestureMergedCache: 0.5,
    gestureMergedCacheTickIdx: -1,
    gestureCacheTickStamp: 0,
    activeSceneId: null,
    stopping: false,
    armed: false,
    delayTimer: null,
    midiHeldNote: null,
    midiHeldChannel: 0,
    midiHeldPort: '',
    midiLastCc: new Map(),
    midiGateTimer: null,
    lastSentString: null,
    lastSentNumeric: [],
    lastStringAtSceneId: null,
    lastStringAtStep: -1,
    lastEmittedVelocity: null,
    m2: makeMod2State()
  }
}

/** Effective step count for value lookup. `draw` mode uses drawSteps
 *  (caps at 1024 for DAW-grade automation curves); every other mode
 *  uses `steps` (1..16). The advance loop modulus matches this. */
function effectiveSteps(cell: Cell): number {
  if (cell.sequencer.mode === 'draw') {
    return Math.max(4, Math.min(1024, Math.floor(cell.sequencer.drawSteps)))
  }
  return Math.max(1, Math.min(16, Math.floor(cell.sequencer.steps)))
}

/** Resolve the base value string for a given step index. Encapsulates
 *  the four-way branch (sequencer off / draw / generative / classic).
 *  Pulled out so the same logic feeds the per-tick render path,
 *  scene-morph computation, trigger-time morph target, AND the cycle-
 *  range precompute below. */
// Sample a recorded gesture at a normalised playhead position in
// [0, 1]. Linear interpolation between adjacent stored points.
// Returns (0.5, 0.5) for an empty / single-point recording (centre
// value — keeps Gesture mode quiet until the user records).
export function sampleGesture(
  points: import('@shared/types').GesturePoint[],
  playhead01: number
): { x: number; y: number } {
  if (!points || points.length === 0) return { x: 0.5, y: 0.5 }
  if (points.length === 1) return { x: points[0].x, y: points[0].y }
  const lastT = points[points.length - 1].t
  if (lastT <= 0) return { x: points[0].x, y: points[0].y }
  const clamped01 = Math.max(0, Math.min(1, playhead01))
  const targetT = clamped01 * lastT
  // Binary search — `points` is time-ordered by construction (the
  // recorder pushes monotonically-increasing timestamps). Drops
  // the per-tick sample cost from O(N) → O(log N), which matters
  // at 120 Hz engine ticks × multi-second recordings (500+ points).
  let lo = 0
  let hi = points.length - 1
  while (lo + 1 < hi) {
    const mid = (lo + hi) >>> 1
    if (points[mid].t <= targetT) lo = mid
    else hi = mid
  }
  // Postconditions: points[lo].t <= targetT <= points[hi].t,
  // where hi === lo + 1 (or both === 0 if the array is tiny —
  // caught by the early returns above).
  const pLo = points[lo]
  const pHi = points[hi]
  const span = pHi.t - pLo.t
  const k = span > 0 ? (targetT - pLo.t) / span : 0
  return {
    x: pLo.x + (pHi.x - pLo.x) * k,
    y: pLo.y + (pHi.y - pLo.y) * k
  }
}

function resolveStepBaseRaw(
  cell: Cell,
  ts: TrackState,
  stepIdx: number,
  subIdx: number,
  subdiv: number
): string {
  if (!cell.sequencer.enabled) return cell.value
  if (cell.sequencer.mode === 'draw') {
    // Draw mode: the drawn 0..1 curve maps onto [drawValueMin,
    // drawValueMax]. When Generative is on, the engine substitutes
    // a per-cycle hash-varied curve (BASED on the user's drawing)
    // so the pattern doesn't repeat identically across cycles. The
    // user's drawValues stay untouched in storage.
    const drawSteps = Math.max(4, Math.min(1024, Math.floor(cell.sequencer.drawSteps)))
    const idx = ((stepIdx % drawSteps) + drawSteps) % drawSteps
    const source =
      cell.sequencer.generative && ts.drawGeneratedValues.length > 0
        ? ts.drawGeneratedValues
        : cell.sequencer.drawValues
    const curve = source[idx] ?? 0
    const xv = Number.isFinite(cell.sequencer.drawValueMin)
      ? cell.sequencer.drawValueMin
      : 0
    const yv = Number.isFinite(cell.sequencer.drawValueMax)
      ? cell.sequencer.drawValueMax
      : 1
    const v = xv + curve * (yv - xv)
    const tokens = parseValueTokens(cell.value)
    // Format: if both X and Y are integers AND the result rounds
    // cleanly, emit as integer; otherwise 4-decimal float.
    const intRange =
      Number.isInteger(xv) &&
      Number.isInteger(yv) &&
      Math.abs(v - Math.round(v)) < 0.0001
    const formatted = intRange
      ? String(Math.round(v))
      : Number(v.toFixed(4)).toString()
    if (tokens.length === 0) return formatted
    return tokens.map((tok) => (Number.isFinite(parseFloat(tok)) ? formatted : tok)).join(' ')
  }
  if (cell.sequencer.generative) {
    return generateStepValue({
      baseRaw: cell.value,
      mode: cell.sequencer.mode,
      stepIdx,
      steps: Math.max(1, Math.min(16, cell.sequencer.steps)),
      amount: cell.sequencer.genAmount,
      seed: cell.sequencer.seed,
      ringALength: cell.sequencer.ringALength,
      ringBLength: cell.sequencer.ringBLength,
      cellRow: ts.seqCellRow,
      bounceDecay: cell.sequencer.bounceDecay,
      subIdx,
      subdiv,
      scaleToUnit: cell.scaleToUnit
    })
  }
  // Classic (non-generative) mode. For most modes we read directly
  // from the user-edited stepValues grid. Density mode is special —
  // every step fires (no gating in classic) with a per-step
  // multiplier of (density/100) × stepHash(i, seed). So slider +
  // hash combine to produce the per-step density value visible in
  // the preview, multiplied into the step's value.
  const baseRaw = cell.sequencer.stepValues[stepIdx] ?? cell.value
  if (cell.sequencer.mode === 'density') {
    const sliderFrac = Math.max(0, Math.min(100, cell.sequencer.density)) / 100
    const mult = sliderFrac * stepHash(stepIdx, cell.sequencer.seed)
    const tokens = parseValueTokens(baseRaw)
    return tokens
      .map((tok) => {
        const num = parseFloat(tok)
        if (!Number.isFinite(num)) return tok
        const v = num * mult
        return Number.isInteger(num) && Math.abs(v - Math.round(v)) < 0.0001
          ? String(Math.round(v))
          : Number(v.toFixed(4)).toString()
      })
      .join(' ')
  }
  // Ratchet classic mode — apply per-mode sub-pulse shaping so the
  // burst is actually audible on numeric receivers, not just a held
  // value re-fired identically subdiv times. The shape applies to
  // EVERY sub-pulse of the burst (including sub 0) so the entire
  // step is replaced with the ratchet-mode value sequence.
  if (cell.sequencer.mode === 'ratchet' && subdiv > 1) {
    const tokens = parseValueTokens(baseRaw)
    return tokens
      .map((tok) => {
        const num = parseFloat(tok)
        if (!Number.isFinite(num)) return tok
        const v = applyRatchetMode(num, subIdx, subdiv, cell.sequencer)
        return Number.isInteger(num) && Math.abs(v - Math.round(v)) < 0.0001
          ? String(Math.round(v))
          : Number(v.toFixed(4)).toString()
      })
      .join(' ')
  }
  return baseRaw
}

/** Generate a fresh per-step curve for Draw + Generative mode.
 *  Each generated value is the user's drawn value PLUS a hash-driven
 *  jitter scaled by genAmount. So the new curve has the same shape
 *  as the user's drawing but wobbles around it; genAmount controls
 *  how far the wobble can travel. cycle index is folded into the
 *  hash so each cycle produces a different curve. Clamped to [0, 1]
 *  so the canvas representation stays valid. */
function generateDrawCurve(cell: Cell, cycle: number): number[] {
  return generateDrawCurveFromValues(
    cell.sequencer.drawValues,
    effectiveSteps(cell),
    cell.sequencer.seed,
    cell.sequencer.genAmount,
    cycle
  )
}

/** Predict the [min, max] range of a modulator's output given the
 *  current center value. Used by scaleToUnit auto-range when a
 *  modulator is active — instead of blunt clamp01 (which collapses
 *  anything > 1 to 1), we remap the modulator's expected output
 *  range into [0, 1]. Different modulator types have different
 *  natural ranges:
 *   - LFO/RandomGen/S&H/Slew/Chaos: bipolar = center ± magnitude,
 *     unipolar = center..center+magnitude
 *   - Envelope/Ramp: multiplicative — range = [center×(1-depth), center]
 *   - Arpeggiator: bracketed by the ladder min/max scaled by depth
 *  Returns a degenerate {min:center, max:center} when no modulator
 *  is active (caller falls back to plain clamp01).
 */
// Serialise a `ParamArgSpec.fixed` value into the OSC arg shape the
// engine emits. Strings stay 's'; booleans become 0/1 int (matches
// the token format produced by `buildInitialValueFromArgSpec`);
// numbers respect the spec's declared `type` so an `{ type: 'int',
// fixed: 0 }` round-trips as `i 0` and not `f 0.0`.
function formatFixedAsOscArg(spec: import('@shared/types').ParamArgSpec): {
  type: 'i' | 'f' | 's' | 'T' | 'F'
  value: number | string | boolean
} {
  const fv = spec.fixed
  if (typeof fv === 'string') return { type: 's', value: fv }
  if (typeof fv === 'boolean') return { type: 'i', value: fv ? 1 : 0 }
  const n = Number(fv ?? 0)
  const isInt = Number.isInteger(n) || spec.type === 'int'
  return isInt
    ? { type: 'i', value: Math.round(n) }
    : { type: 'f', value: n }
}

function predictModRange(m: Modulation, center: number): { min: number; max: number } {
  if (!m.enabled) return { min: center, max: center }
  const depth01 = Math.max(0, Math.min(1, m.depthPct / 100))
  const magnitude = Math.max(Math.abs(center), 1) * depth01
  switch (m.type) {
    case 'lfo':
    case 'random':
    case 'sh':
    case 'slew':
    case 'chaos': {
      // The chaos / random / S&H modulators produce values in
      // roughly [-1, 1] post-conversion; the additive magnitude
      // around center applies either symmetrically (bipolar) or
      // only upward (unipolar).
      return m.mode === 'unipolar'
        ? { min: center, max: center + magnitude }
        : { min: center - magnitude, max: center + magnitude }
    }
    case 'envelope':
    case 'ramp': {
      // Multiplicative — gain ∈ [1-depth, 1]. Min is center×(1-depth),
      // max is center. Handle negative centers gracefully.
      const a = center * (1 - depth01)
      const b = center
      return { min: Math.min(a, b), max: Math.max(a, b) }
    }
    case 'arpeggiator': {
      // Arp ladder spans roughly [center/N, center×N] for mult mode,
      // [center×(1-depth), center×(1+depth)] in the limit. Use the
      // same magnitude formula as LFO to keep things predictable.
      return { min: center - magnitude, max: center + magnitude }
    }
    default:
      return { min: center, max: center }
  }
}

/** Effective cellular seed at the current moment — base cellSeed
 *  plus an LFO modulation when depth > 0. Used at trigger AND at
 *  each cycle wrap so the cellular pattern slowly drifts across
 *  adjacent seed values over time. */
function modulatedCellSeed(seq: SequencerParams, tMs: number): number {
  const d = Math.max(0, Math.min(100, seq.cellularSeedLfoDepth)) / 100
  if (d <= 0) return seq.cellSeed
  const rate = Math.max(0.01, Math.min(10, seq.cellularSeedLfoRate))
  // tMs is high-resolution but rate is in Hz — convert.
  const phase = (tMs / 1000) * rate * Math.PI * 2
  const offset = Math.round(Math.sin(phase) * d * 32767) // half of 65535
  return Math.max(0, Math.min(65535, seq.cellSeed + offset))
}

/** Per-step Ratchet probability + subdivision count, accounting for
 *  the Variation knob. Variation 0 returns the global values; 100 lets
 *  each step's hash drive its own randomised values. Deterministic
 *  per (step, seed). */
function ratchetStepParams(
  seq: SequencerParams,
  step: number
): { prob: number; maxDiv: number } {
  const variation = Math.max(0, Math.min(100, seq.ratchetVariation)) / 100
  // Always integer subdivs in [2, 16]. Variation blends the global
  // and per-step hashed values, then we round to keep timing clean.
  if (variation <= 0) {
    return {
      prob: Math.max(0, Math.min(100, seq.ratchetProb)),
      maxDiv: Math.max(2, Math.min(16, Math.round(seq.ratchetMaxDiv)))
    }
  }
  const probHash = stepHash(step, seq.seed) // 0..1
  const divHash = stepHash(step + 1000, seq.seed * 7 + 13) // independent
  const prob = (1 - variation) * seq.ratchetProb + variation * probHash * 100
  // Per-step maxDiv blends global with a fresh roll in [2, 16]; round
  // at the end so the engine always uses whole-number subdivisions.
  const maxDivRaw =
    (1 - variation) * seq.ratchetMaxDiv + variation * (2 + divHash * 14)
  return {
    prob: Math.max(0, Math.min(100, prob)),
    maxDiv: Math.max(2, Math.min(16, Math.round(maxDivRaw)))
  }
}

/** Sub-pulse value shaping for Ratchet bursts. The mode dropdown
 *  picks which formula:
 *   - 'octaves': all sub-pulses emit value / subdiv (so subdivisions
 *     of the tempo emit proportionally-scaled values — a 4-burst at
 *     value 100 emits 25 four times)
 *   - 'ramp': sub i emits value × (i+1)/subdiv (linear rise from
 *     value/subdiv to value, like a snare roll building up)
 *   - 'random': hash-driven scatter (different per (step, sub) pair)
 *  Applied to BOTH classic and generative Ratchet so the dropdown
 *  governs sub-pulse shape regardless of generative mode. */
function applyRatchetMode(
  base: number,
  subIdx: number,
  subdiv: number,
  seq: SequencerParams
): number {
  // Outside a burst → emit the raw step value.
  if (subdiv <= 1) return base
  const mode = seq.ratchetMode ?? 'octaves'
  // Sub-pulse fraction in [0, 1] across the burst.
  const t = subIdx / Math.max(1, subdiv - 1)
  switch (mode) {
    case 'octaves':
      // Every sub-pulse emits stepValue / subdiv — uniformly scaled.
      return base / subdiv
    case 'ramp':
      // Linear rise from base/subdiv (sub 0) to base (sub subdiv-1).
      return base * ((subIdx + 1) / subdiv)
    case 'inverse':
      // Mirror of Ramp: starts at base, falls linearly to base/subdiv.
      return base * ((subdiv - subIdx) / subdiv)
    case 'pingpong': {
      // Triangle window — rise from base/subdiv to base at the midpoint,
      // then fall back. Smooth "swell-and-recede" ornament.
      const tri = 1 - Math.abs(t - 0.5) * 2
      const min = 1 / subdiv
      return base * (min + tri * (1 - min))
    }
    case 'echo': {
      // Exponential decay (palm-mute echo / bouncing-ball feel). Each
      // sub-pulse keeps ~70% of the previous amplitude.
      const k = Math.pow(0.7, subIdx)
      return base * k
    }
    case 'trill':
      // Alternating ornament — even sub-pulses fire at base, odd ones
      // at base × 0.5. Reads as a fast two-note flicker.
      return subIdx % 2 === 0 ? base : base * 0.5
    case 'random':
    default: {
      const h = stepHash(subIdx * 31 + 7, seq.seed)
      return base * (0.25 + 0.75 * h)
    }
  }
}

/** Compute per-token {min, max} across one full cycle's worth of
 *  generated step values. Used by the scaleToUnit auto-range path
 *  so output covers the full [0, 1] range based on the actual values
 *  the cycle will produce — instead of blindly clamping anything > 1
 *  down to 1 (which left the user staring at a row of "1.000").
 *
 *  Called at trigger AND at every cycle wrap. For Ratchet, we sample
 *  the full sub-pulse space too so the scatter's wider variation is
 *  captured. For Cellular, the current `ts.seqCellRow` is used (each
 *  cycle's range reflects that cycle's row, not the initial one). */
function computeCycleRanges(
  cell: Cell,
  ts: TrackState
): Array<{ min: number; max: number }> {
  const tokenCount = parseValueTokens(cell.value).length
  if (tokenCount === 0) return []
  const ranges = Array.from({ length: tokenCount }, () => ({
    min: Infinity,
    max: -Infinity
  }))
  const stepCount = effectiveSteps(cell)
  // For Ratchet, sample (step × subIdx ∈ [0, maxDiv)) so the scatter's
  // sub-pulse range counts toward the cycle min/max. Other modes
  // collapse subIdx=0, subdiv=1. Cap matches the runtime cap in
  // `ratchetStepParams` (16) — earlier this was 8 and Ratchet bursts
  // with maxDiv ∈ (8, 16] were under-sampled, causing scaleToUnit
  // auto-range to clip the loudest sub-pulses.
  const maxDiv =
    cell.sequencer.mode === 'ratchet'
      ? Math.max(2, Math.min(16, Math.floor(cell.sequencer.ratchetMaxDiv)))
      : 1
  for (let i = 0; i < stepCount; i++) {
    for (let sub = 0; sub < maxDiv; sub++) {
      const raw = resolveStepBaseRaw(cell, ts, i, sub, maxDiv)
      const toks = parseValueTokens(raw)
      toks.forEach((tok, idx) => {
        if (idx >= ranges.length) return
        const n = parseFloat(tok)
        if (!Number.isFinite(n)) return
        if (n < ranges[idx].min) ranges[idx].min = n
        if (n > ranges[idx].max) ranges[idx].max = n
      })
    }
  }
  // Replace Infinity with sentinel zeros when no numeric token at
  // that position (the caller's normalize path checks span >0 and
  // falls through, so this just keeps the array shape clean).
  return ranges.map((r) =>
    Number.isFinite(r.min) && Number.isFinite(r.max) ? r : { min: 0, max: 0 }
  )
}

function lfo(
  shape: LfoShape,
  phase: number,
  // Only reads the stepped/smooth random scratch slots. Typed
  // structurally so both TrackState (Mod 1) and Mod2State (Mod 2)
  // can be passed without a refactor — they each carry these three
  // fields, even though their broader shapes differ.
  state: { rndStepValue: number; rndSmoothPrev: number; rndSmoothNext: number },
  tickIdx: number
): number {
  // phase in [0,1). Returns [-1, 1]
  const p = phase - Math.floor(phase)
  switch (shape) {
    case 'sine':
      return Math.sin(p * TWO_PI)
    case 'triangle':
      return p < 0.5 ? p * 4 - 1 : 3 - p * 4
    case 'sawtooth':
      return p * 2 - 1
    case 'square':
      return p < 0.5 ? 1 : -1
    case 'rndStep': {
      // One new value per LFO period. The actual sample-and-hold update
      // happens in tick() when phase wraps (see `rndStepValue` assignment
      // there). Here we just return the held value.
      return state.rndStepValue
    }
    case 'spastic': {
      // Same held-value pattern as rndStep, but tick() resamples to
      // exactly ±1 on every wrap (see the spastic branch in the
      // resample block). Held value persists between wraps so the
      // unipolar pipeline reads stable 0/1 across the whole step.
      return state.rndStepValue
    }
    case 'rndSmooth': {
      // Cosine ease across the full period: k goes 0 → 1 monotonically
      // as p goes 0 → 1, so the output reaches `next` exactly at the wrap.
      // When the tick-loop rotates (prev ← next, next ← new random) at
      // phase wrap, the next cycle starts with k=0 and value = newPrev
      // = oldNext — continuous. Previous formulation used cos(p·2π)
      // which made k bounce back to 0 at p=1, producing a pop because
      // the output snapped from oldPrev back to oldNext at the wrap.
      const k = 0.5 - 0.5 * Math.cos(p * Math.PI)
      return state.rndSmoothPrev * (1 - k) + state.rndSmoothNext * k
    }
  }
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v
}

export class SceneEngine {
  private sender = new OscSender()
  // Native MIDI output sender. Stays idle until a cell's `midiOut.enabled`
  // is true AND the session's global `midiEnabled` is on. Lazy-opens
  // ports per name on first send.
  private midiSender = new MidiOutSender()
  private session: Session | null = null
  // Map by trackId (tracks are global rows)
  private tracks = new Map<string, TrackState>()
  private tickTimer: NodeJS.Timeout | null = null
  private lastTickAt = 0
  private activeSceneId: string | null = null
  private activeSceneStartedAt: number | null = null
  // Slot index (0-based into session.sequence) that actually fired the
  // current active scene — used by the Sequence view to pick which
  // specific slot to highlight when a scene is placed multiple times.
  // null when the trigger didn't come from a slot (palette, column
  // header, MIDI, cue, etc).
  private activeSequenceSlotIdx: number | null = null
  // Per-session "how many times has the active scene played so far?" counter.
  // Resets to 1 whenever activeSceneId CHANGES (fresh user trigger or follow
  // action to a different scene). Increments when the active scene re-triggers
  // itself (loop mode OR a multiplicator-driven internal repeat).
  private activeSceneRepeatCount = 0
  // While paused (sequence advance frozen), this is the wall-clock
  // timestamp pause was entered. On resume we shift activeSceneStartedAt
  // forward by the pause duration so the elapsed time picks up where it
  // left off rather than jumping ahead.
  private pauseStartedAt: number | null = null
  private sceneAdvanceTimer: NodeJS.Timeout | null = null
  private onStateChange: ((s: EngineState) => void) | null = null
  // ── Two-stage modulator: live Mod 1 preview ─────────────────────
  // The renderer's Inspector tells the engine which cell it's watching
  // via setSelectedCellForLive(); the engine then emits effective
  // Mod 1 values for that cell at ~30 Hz so the Inspector sliders /
  // numbers can animate while Modulation 2 is driving. Cleared to
  // null when the user collapses the Inspector or clicks elsewhere.
  private selectedCellForLive: { sceneId: string; trackId: string } | null = null
  private onMod1Live:
    | ((sample: import('@shared/types').Mod1LiveSample | null) => void)
    | null = null
  private lastMod1LiveEmitAt = 0
  // Latest computed output per (sceneId, trackId). Populated every tick by the
  // numeric path; emitted throttled via emitCurrentValues().
  private liveValues: Record<string, Record<string, string>> = {}
  private lastValueEmitAt = 0
  // ── Hardware Mode state ──────────────────────────────────────────
  // Per-device cache of the last-seen value of each OSC address path.
  // Key: `${ip}:${port}` (matches the Network discovery device key).
  // Value: per-address arg arrays (numeric only — strings / blobs are
  // ignored). Used for movement detection: a hardware input only
  // counts as "the user is touching the control" if the new value
  // differs from the cached one by more than movementThreshold.
  private hardwareLastValues: Map<string, Map<string, number[]>> = new Map()
  private hardwareLastChangeMs: Map<string, Map<string, number[]>> = new Map()
  // Per-(trackId, slotIdx) caught state. Once a hardware control has
  // matched the currently-emitted scene value within catchTolerance,
  // this flag becomes true and the engine uses the hardware value
  // for that slot until either the scene changes (in 'reset' mode)
  // or HW Mode is disabled. Pinned slots bypass HW entirely.
  // Key: `${trackId}|${slotIdx}`. Mirrored to renderer via engine
  // state for the red-value / red-dot visual feedback.
  private hardwareCaught: Map<string, boolean> = new Map()
  // Per-(trackId, slotIdx) current override value. Updated on every
  // hardware OSC message after movement + catch checks pass. The
  // per-slot emit loop reads this between pitch snap and pin to
  // override the scene's computed value.
  private hardwareOverride: Map<string, number> = new Map()
  // (v0.6.4) Derived Parameters. `derivedSourceLatest` holds the latest
  // RAW slot-0 value per real source address (global-by-address; a single
  // bound device per template in practice). `derivedLatest` holds the
  // computed value per synthetic derived address, for the inspector's
  // live readout. `hasAnyDerived` fast-paths the recompute block.
  private derivedSourceLatest: Map<string, number> = new Map()
  private derivedLatest: Map<string, number> = new Map()
  private hasAnyDerived = false
  // (v0.6.x) Motion Loop recording. Non-null while a scene is armed for
  // capture: every matching hardware packet appends a conditioned+scaled
  // frame per trackId. stopMotionLoopRecord() drains this and hands the
  // buffers back to the renderer, which writes them into the cells.
  private recordingLoop: {
    sceneId: string
    startMs: number
    frames: Map<string, { t: number; v: number[] }[]>
  } | null = null
  // Cached flag: true when at least one template in the session has
  // `hardwareMode.enabled === true`. `handleHardwareInput` consults
  // this BEFORE doing any per-packet work, so when HW Mode is off
  // session-wide (the common case), the OSC hook is effectively a
  // no-op and doesn't allocate or scan templates on every incoming
  // packet. Recomputed on every `updateSession`.
  private hasAnyHardwareModeEnabled = false
  // (Bug 5) One-shot flag set by `markSessionLoaded()` (called from the
  // session-load IPC handlers in main/index.ts). The NEXT updateSession
  // restores HW catch state from `session.hardwareState`, then the flag
  // clears. Replaces the old `liveMapEmpty` heuristic, which would
  // resurrect just-cleared catches whenever a routine session push
  // (autosave, undo, an in-flight edit) raced a scene-trigger clear.
  private sessionLoadPending = false

  // ── Generative Scene Sequencer state (v0.5.10) ───────────────────
  // Ring of recently-played scene IDs (newest at end). Drives the
  // repetition penalty + no-repeat constraint + shuffleCycle's
  // "every scene once before any repeats" guarantee. Capped at
  // GENERATIVE_HISTORY_LEN entries.
  private generativeHistory: string[] = []
  // Per-scene most-recent generative auto-roll, in ms. Mirrored
  // into EngineState so the Scene Inspector can overlay the rolled
  // duration on the Dur input for ANY focused scene that's been
  // played under generative mode -- not just the currently-active
  // one. Scenes that have never been played under generative are
  // absent from this map; the renderer falls back to the authored
  // Dur for those. Cleared on session reload (updateSession
  // invalidates the map when the scene list changes) so stale ids
  // can't accumulate.
  private generativeRolledBySceneId: Map<string, number> = new Map()
  // Cached scene-similarity matrix. Sparse: only contains rows for
  // scenes that have been queried since the last invalidation. Both
  // axes index by sceneId. Lazily filled by selectGenerativeScene()
  // when it needs `sim[currentSceneId]`. Invalidated wholesale on
  // updateSession() when scenes / cells / tracks change (we don't
  // attempt diff-based invalidation -- a session typically holds
  // <100 scenes so a full rebuild is sub-millisecond).
  private generativeSimilarity: Map<string, Map<string, number>> = new Map()
  // True when the similarity matrix needs rebuilding. Set on
  // updateSession when the session changes; cleared on first read.
  private generativeSimDirty = true

  // ── Input Conditioning runtime state (v0.6) ──────────────────────
  // Per (templateId | deviceKey | address) → per-slot array of
  // per-stage filter states (index-parallel to the template's
  // conditioner.stages). All numeric fields lazily initialised on the
  // first sample so a chain edit mid-stream re-warms cleanly.
  private conditionerState: Map<string, ConditionerSlotState[]> = new Map()
  // Live scope taps for the Input Conditioning UI. Keyed
  // `${templateId}|${address}|${slot}` so MULTIPLE surfaces can watch
  // at once (the Instrument section's scope AND a Parameter
  // inspector's scope). TTL model: polling a watch refreshes its
  // lastPollMs; handleHardwareInput prunes watches not polled in
  // ~1.5s, so a closed/unmounted scope stops costing anything without
  // any explicit teardown. Empty map = zero per-packet cost.
  private conditionerScopes: Map<
    string,
    {
      templateId: string
      address: string
      slot: number
      lastPollMs: number
      buf: { t: number; raw: number; cond: number }[]
    }
  > = new Map()

  // ── Live hardware input readout (v0.6) ───────────────────────────
  // Latest RAW incoming values per OSC address (across all HW-Mode
  // devices), with a wall-clock stamp for freshness. Emitted (pruned
  // by age) in EngineState so each Parameter row's sidebar can show a
  // red dot + the value the controller is currently sending to its
  // address — a live monitor independent of catch state. Keyed by
  // address; multiple devices sharing an address is a non-issue in
  // practice (last write wins).
  private hardwareLiveByAddress: Map<
    string,
    { raw: number[]; cond: number[]; atMs: number }
  > = new Map()

  // ── State Trigger runtime state (v0.6) ───────────────────────────
  // Latest CONDITIONED values per device, per address — the working
  // memory rules/learned detectors match against. A state can span
  // several addresses; each packet refreshes one address and the
  // detector reads the latest snapshot of all of them.
  private stateInputLatest: Map<string, Map<string, number[]>> = new Map()
  // Per `${templateId}|${stateId}` detector state machine.
  private stateTriggerRuntime: Map<
    string,
    {
      active: boolean
      matchSince: number
      lastCcSent: number
      // Wall-clock when the (active) match first dropped below the exit
      // region — the exit-hold debounce measures from here. 0 = matching.
      unmatchedSince: number
    }
  > = new Map()
  // Live match score per `${templateId}|${stateId}` — polled by the
  // renderer's State Triggers section (10 Hz while expanded) rather
  // than pushed through emitState, keeping the 50 Hz packet path off
  // the heavyweight state-emit.
  private stateTriggerLive: Map<string, number> = new Map()
  // Held Note-kind output per trigger key `${tplId}|${stateId}` so a
  // note can be released on exit / disable / delete / stop / panic and
  // never hangs. Records the EXACT (port, channel, note) sent so the
  // Note Off matches even if the config changed since. `oneShot` notes
  // also get a gate timer here.
  private stateTriggerHeldNote: Map<
    string,
    { port: string; channel: number; note: number }
  > = new Map()
  private stateTriggerGateTimers: Map<string, NodeJS.Timeout> = new Map()
  // ── Pose Sequences (v0.6.5) — kept in their own maps (parallel to the
  // State-Trigger ones) so the state machine, live readout, held notes
  // and pruning stay cleanly separate. Keyed `${templateId}|${seqId}`.
  //   step        = index of the waypoint we're currently waiting to hit
  //   matchSince  = wall-clock the current step's pose started matching (0=no)
  //   ready       = must LEAVE a pose before the next can fire (rising-edge)
  //   done        = finished a non-looping phrase; parked until reset
  private poseSequenceRuntime: Map<
    string,
    { step: number; matchSince: number; ready: boolean; done: boolean }
  > = new Map()
  // Live {step, score} per sequence, polled by the UI alongside the
  // State-Trigger live scores (getStateTriggerLive).
  private poseSequenceLive: Map<string, { step: number; score: number }> =
    new Map()
  // Gated held Note per sequence (mono) so a waypoint's momentary note
  // is always released — on the next waypoint, reset, stop, or panic.
  private poseSequenceHeldNote: Map<
    string,
    { port: string; channel: number; note: number }
  > = new Map()
  private poseSequenceGateTimers: Map<string, NodeJS.Timeout> = new Map()
  // Sequences (`${templateId}|${seqId}`) the companion recorder is
  // currently cycling through — their live evaluation is paused so a
  // hands-free record doesn't fire the sequence's own MIDI.
  private suppressedSeqKeys: Set<string> = new Set()
  // In-flight learn-by-demonstration recording session, or null.
  private stateRecording: {
    templateId: string
    stateId: string
    until: number
    samples: Map<string, number[][]>
    finalize: (result: LearnedState | null) => void
    timer: NodeJS.Timeout
  } | null = null

  async start(): Promise<void> {
    await this.sender.start()
    this.startTicker()
  }

  stop(): void {
    this.stopTicker()
    this.sender.stop()
    // Release held State-Trigger notes + gate timers, and abort any
    // in-flight learn-recording (its safety timer would otherwise fire
    // after teardown and resolve a stale promise).
    this.releaseAllStateNotes()
    this.releaseAllSeqNotes()
    this.suppressedSeqKeys.clear()
    if (this.stateRecording) {
      clearTimeout(this.stateRecording.timer)
      this.stateRecording.finalize(null)
      this.stateRecording = null
    }
    // Fire Note Off for every held MIDI note + tear down all open
    // ports before clearing tracks — without this, app shutdown
    // would leak ringing notes on every connected MIDI device.
    this.tracks.forEach((ts) => this.sendMidiNoteOff(ts))
    this.midiSender.stop()
    this.tracks.forEach((ts) => {
      if (ts.delayTimer) clearTimeout(ts.delayTimer)
      if (ts.midiGateTimer) clearTimeout(ts.midiGateTimer)
    })
    this.tracks.clear()
    this.clearSceneAdvance()
    // Reset every ephemeral tick-state field so a subsequent start()
    // doesn't compute dt against a stale lastTickAt or carry stale
    // live-value rows / active-scene bookkeeping into the new run.
    this.liveValues = {}
    this.lastTickAt = 0
    this.lastValueEmitAt = 0
    this.tickIdx = 0
    this.activeSceneId = null
    this.activeSceneStartedAt = null
    this.activeSequenceSlotIdx = null
    this.activeSceneRepeatCount = 0
    this.pauseStartedAt = null
  }

  setOnStateChange(cb: (s: EngineState) => void): void {
    this.onStateChange = cb
  }

  // Inspector tells us which cell is open so we can stream its
  // effective Modulation 1 (post-Mod 2 patch) at ~30 Hz. Pass null
  // to stop the stream (e.g. user clicks elsewhere). Calling with a
  // new selection clears the throttle timer so the first sample fires
  // immediately for snappy feedback.
  setSelectedCellForLive(sel: { sceneId: string; trackId: string } | null): void {
    this.selectedCellForLive = sel
    this.lastMod1LiveEmitAt = 0
    // If the new selection has no Modulation 2 enabled, push a null
    // sample right away so the Inspector clears any stale live values.
    if (sel === null && this.onMod1Live) {
      this.onMod1Live(null)
    }
  }
  setOnMod1Live(
    cb: ((sample: import('@shared/types').Mod1LiveSample | null) => void) | null
  ): void {
    this.onMod1Live = cb
  }

  // (v0.6.x) Motion Loop hands-free OSC trigger — fired on a rising edge
  // of the configured trigger address (e.g. the antenna's /mpu/btn1).
  private onMotionLoopTrigger: (() => void) | null = null
  private motionLoopTriggerLast = 0
  setOnMotionLoopTrigger(cb: (() => void) | null): void {
    this.onMotionLoopTrigger = cb
  }

  // (v0.6.4) Fired each time a Derived Parameter is (re)computed, so the
  // renderer can show it in the OSC In monitor. Wired to the oscInBuffer
  // in main/index.ts.
  private onDerived: ((e: OscEvent) => void) | null = null
  setOnDerived(cb: ((e: OscEvent) => void) | null): void {
    this.onDerived = cb
  }
  // Snapshot of the latest computed Derived Parameter values, keyed by
  // synthetic address — polled by the Instrument inspector.
  getDerivedLive(): Record<string, number> {
    const out: Record<string, number> = {}
    this.derivedLatest.forEach((v, k) => {
      out[k] = v
    })
    return out
  }

  /** Forward every successful OSC send to `cb`. Pass null to detach. */
  setOnOscError(cb: ((e: OscErrorEvent) => void) | null): void {
    this.sender.setOnError(cb)
  }
  setOnOscSend(cb: ((e: OscSendEvent) => void) | null): void {
    this.sender.setOnSent(cb)
  }
  setOnMidiSend(cb: ((e: MidiSendEvent) => void) | null): void {
    this.midiSender.setOnSent(cb)
  }
  setOnMidiError(cb: ((e: MidiErrorEvent) => void) | null): void {
    this.midiSender.setOnError(cb)
  }
  /** Enumerate currently-visible MIDI output ports + report native
   *  module availability + last error. Renderer reads this on mount
   *  and whenever the user re-opens the MIDI section of a cell. */
  listMidiPorts(): { ports: string[]; available: boolean; lastError: string } {
    return {
      ports: this.midiSender.listPorts(),
      available: this.midiSender.isAvailable(),
      lastError: this.midiSender.getLastError()
    }
  }

  private emitState(): void {
    if (!this.onStateChange || !this.session) return
    const active: Record<string, Record<string, boolean>> = {}
    const seq: Record<string, Record<string, number>> = {}
    // Per-track last-emitted MIDI velocity (after humanize jitter).
    // Keyed `${sceneId}|${trackId}` so the renderer's cell tile can
    // resolve it by the same identity it already uses for live values.
    const lastVel: Record<string, number> = {}
    for (const s of this.session.scenes) {
      active[s.id] = {}
      seq[s.id] = {}
    }
    this.tracks.forEach((ts, trackId) => {
      if (ts.armed && ts.activeSceneId && active[ts.activeSceneId]) {
        active[ts.activeSceneId][trackId] = true
        // Report current sequencer step only when the cell has sequencer enabled.
        const scene = this.session!.scenes.find((sc) => sc.id === ts.activeSceneId)
        const cell = scene?.cells[trackId]
        if (cell?.sequencer.enabled) {
          seq[ts.activeSceneId][trackId] = ts.seqStepIdx
        }
        if (ts.lastEmittedVelocity !== null) {
          lastVel[`${ts.activeSceneId}|${trackId}`] = ts.lastEmittedVelocity
        }
      }
    })
    // Bucket the hardwareCaught Map into a Record<trackId, number[]>
    // so each CellTile only needs `state[trackId]` (O(1)) instead of
    // scanning every key looking for a prefix match. Saves the per-tile
    // `Object.keys` + `.startsWith` work that used to fire on every
    // engine emit — measurable hot path with many cells on screen.
    const hardwareCaughtByTrack: Record<string, number[]> = {}
    this.hardwareCaught.forEach((v, k) => {
      if (!v) return
      const pipe = k.indexOf('|')
      if (pipe <= 0) return
      const trackId = k.slice(0, pipe)
      const slotIdx = Number(k.slice(pipe + 1))
      if (!Number.isFinite(slotIdx)) return
      let arr = hardwareCaughtByTrack[trackId]
      if (!arr) {
        arr = []
        hardwareCaughtByTrack[trackId] = arr
      }
      arr.push(slotIdx)
    })
    // Sort each track's slot list so structural identity is stable
    // (`[0,2,3]` always serialises the same way) — lets renderer
    // selectors do shallow equality and skip re-renders when the set
    // didn't actually change.
    for (const k of Object.keys(hardwareCaughtByTrack)) {
      hardwareCaughtByTrack[k].sort((a, b) => a - b)
    }
    // (v0.6) Flatten the live hardware readout, pruning addresses not
    // seen in the last 5 s so a controller that stops streaming stops
    // showing a stale value. Only emitted when non-empty.
    let hardwareLiveByAddress:
      | Record<string, { raw: number[]; cond: number[]; t: number }>
      | undefined
    if (this.hardwareLiveByAddress.size > 0) {
      const nowMs = Date.now()
      for (const [addr, entry] of this.hardwareLiveByAddress) {
        if (nowMs - entry.atMs > 5000) {
          this.hardwareLiveByAddress.delete(addr)
          continue
        }
        if (!hardwareLiveByAddress) hardwareLiveByAddress = {}
        hardwareLiveByAddress[addr] = {
          raw: entry.raw,
          cond: entry.cond,
          t: entry.atMs
        }
      }
    }
    // Flatten the per-scene rolled-duration map into a Record only
    // when non-empty -- keeps the IPC payload tight at boot and
    // when generative mode has never been used.
    let generativeRolledBySceneId: Record<string, number> | undefined
    if (this.generativeRolledBySceneId.size > 0) {
      generativeRolledBySceneId = {}
      this.generativeRolledBySceneId.forEach((ms, sid) => {
        generativeRolledBySceneId![sid] = ms
      })
    }
    this.onStateChange({
      activeBySceneAndTrack: active,
      seqStepBySceneAndTrack: seq,
      currentValueBySceneAndTrack: this.liveValues,
      activeSceneId: this.activeSceneId,
      activeSceneStartedAt: this.activeSceneStartedAt,
      activeSequenceSlotIdx: this.activeSequenceSlotIdx,
      pausedAt: this.pauseStartedAt,
      tickRateHz: this.session.tickRateHz,
      hardwareCaughtByTrack,
      lastEmittedVelocityByCell: lastVel,
      ...(generativeRolledBySceneId
        ? { generativeRolledBySceneId }
        : {}),
      ...(hardwareLiveByAddress ? { hardwareLiveByAddress } : {})
    })
  }

  /**
   * Returns true when the given source ip:port matches any Pool
   * InstrumentTemplate's `hardwareMode` config with `enabled: true`.
   *
   * Used by `oscNetwork.setOnShouldSuppressForward()` to suppress the
   * raw-bytes forward path for sources Hardware Mode is actively
   * absorbing — preventing double-emission to scene-output targets
   * (e.g. the Teensy controller broadcasting to dataFLOU's listener
   * would otherwise both be HW-Mode-consumed AND independently
   * byte-forwarded to Max/PD, causing two competing values per OSC
   * address per packet).
   *
   * Cheap by design: fast-paths on `hasAnyHardwareModeEnabled` so it
   * costs nothing per packet when no HW Mode template is configured.
   * When at least one is, scans the templates linearly — sessions
   * typically have <10 templates so a Map index isn't worth the
   * coherency overhead vs. updateSession.
   */
  /** (Bug 7) True while any track is still fading out ('stopping'
   *  morph-out in progress). Used by the 'whenIdle' forward policy so
   *  the controller stays suppressed until the fade actually finishes,
   *  not just until activeSceneId is nulled. */
  private isAnyTrackStopping(): boolean {
    for (const ts of this.tracks.values()) {
      if (ts.stopping) return true
    }
    return false
  }

  isHardwareModeSource(ip: string, port: number): boolean {
    if (!this.hasAnyHardwareModeEnabled) return false
    if (!this.session) return false
    for (const tpl of this.session.pool.templates) {
      const hw = tpl.hardwareMode
      if (!hw || !hw.enabled) continue
      if (hw.deviceIp !== ip) continue
      // (v0.5.12) deviceMatch: 'ipOnly' skips the port-equality check
      // for controllers with ephemeral source ports. Default ('ipPort'
      // or undefined) keeps the strict per-port match — correct for
      // fixed-source-port firmware like the OCTOCOSME Teensy.
      if ((hw.deviceMatch ?? 'ipPort') === 'ipPort' && hw.devicePort !== port) {
        continue
      }
      // (v0.5.12.1) forwardMode replaces v0.5.12's binary alwaysForward
      // with three policies: 'suppress' (default, current v0.5.11
      // behaviour — never forward), 'always' (never suppress — opt
      // out of forward-suppression entirely, v0.5.12 alwaysForward=true
      // behaviour), and 'whenIdle' (forward only when no scene is
      // currently playing — best of both worlds for live workflows
      // where the user wants clean single-emission during scene
      // playback AND controller-reaches-downstream during rehearsal /
      // soundcheck / between scenes).
      //
      // Legacy alwaysForward boolean (from v0.5.12 sessions) is
      // honored as 'always' when forwardMode is undefined; new
      // sessions set forwardMode directly and the UI clears
      // alwaysForward whenever the user picks any forwardMode option.
      const fwdMode: 'suppress' | 'always' | 'whenIdle' =
        hw.forwardMode ?? (hw.alwaysForward ? 'always' : 'suppress')
      if (fwdMode === 'always') continue
      // (Bug 7 FIX) 'whenIdle' must treat a scene that's still fading
      // out as NOT idle. stopScene() nulls activeSceneId immediately,
      // but tracks linger in 'stopping' state (morph-out, up to several
      // seconds). If we un-suppressed during that fade, the controller
      // would byte-forward downstream WHILE the engine is still emitting
      // the fading cell values → dual emission. Idle = no active scene
      // AND no track currently stopping.
      if (
        fwdMode === 'whenIdle' &&
        this.activeSceneId === null &&
        !this.isAnyTrackStopping()
      ) {
        continue
      }
      return true
    }
    return false
  }

  /**
   * Hardware Mode entry point — called by the OSC network listener
   * for EVERY incoming OSC message. Routes the message through:
   *
   *   1. Find which (if any) InstrumentTemplate's hardwareMode is
   *      enabled AND matches this device's ip:port.
   *   2. Find which Tracks instantiated from that template the user
   *      wants HW-controlled (appliesToTrackIds narrowing if set).
   *   3. Match the OSC address against each Track's Parameter
   *      addresses. Skip if no Parameter matches.
   *   4. For each arg slot the user enabled for HW control (via
   *      hardwareMode.args[fnId]):
   *      a. Movement detection — value must have changed by
   *         movementThreshold within movementWindowMs.
   *      b. Catch — value must be within catchTolerance of the
   *         currently-emitted scene value before override engages.
   *      c. Once caught, store the override; the per-slot emit
   *         loop reads it and uses it as the final value.
   *
   * Designed to be called at HIGH frequency (the OSC listener fires
   * `observe()` on every UDP packet). All lookups are Map-based to
   * keep per-message cost bounded.
   */
  handleHardwareInput(
    ip: string,
    port: number,
    address: string,
    numericArgs: number[],
    // (v0.6.4) True when this call is a Derived Parameter injecting its
    // computed value back through the pipeline. Suppresses the derived
    // recompute block at the end so a derived can't recurse or derive
    // from another derived.
    fromDerived = false
  ): void {
    if (!this.session) return
    // Fast path: avoid any per-packet work when no template has HW
    // Mode enabled session-wide. The hook fires on EVERY incoming
    // OSC packet (200 Hz+ from a continuous controller), so the
    // filter + array allocation below was non-trivial overhead even
    // when HW Mode was off. Cached on session update via
    // `this.hasAnyHardwareModeEnabled`.
    if (!this.hasAnyHardwareModeEnabled) return
    const now = Date.now()
    // Find matching templates whose HW Mode is enabled + bound to
    // this device. Most sessions have 0-1 such templates so this
    // scan is cheap; if it ever becomes hot we can pre-index it.
    let anyIpOnly = false
    const matchedTemplates = this.session.pool.templates.filter((tpl) => {
      const hw = tpl.hardwareMode
      if (!hw || !hw.enabled) return false
      if (hw.deviceIp !== ip) return false
      // (v0.5.12) deviceMatch: 'ipOnly' allows any source port for
      // this IP. See HardwareModeConfig.deviceMatch docstring.
      if ((hw.deviceMatch ?? 'ipPort') === 'ipPort' && hw.devicePort !== port) {
        return false
      }
      if ((hw.deviceMatch ?? 'ipPort') === 'ipOnly') anyIpOnly = true
      return true
    })
    if (matchedTemplates.length === 0) return
    // (Bug 1 FIX) When ANY matching template is 'ipOnly', key movement
    // state by ip ALONE — an ephemeral-port sender churns its source
    // port every packet, so an `${ip}:${port}` key would give every
    // packet a fresh (empty) movement map (movingPerSlot / changedPerSlot
    // forever false → nothing ever catches) and leak one map entry per
    // port. The ip-only key keeps a single stable baseline per device.
    const deviceKey = anyIpOnly ? ip : `${ip}:${port}`
    // (v0.6.x) Motion Loop hands-free OSC trigger — a rising edge on the
    // configured address (default the antenna's /mpu/btn1) toggles record.
    // Checked on the RAW value (pre-conditioning) so a smoothing chain
    // can't blur the button edge; one press = toggle. The renderer owns
    // the actual start/stop (it writes cells), so we just notify it.
    const mlTrig = this.session.motionLoopOscTrigger
    if (mlTrig && mlTrig.enabled && mlTrig.address && address === mlTrig.address) {
      const v =
        numericArgs.length > 0 && Number.isFinite(numericArgs[0])
          ? numericArgs[0]
          : 0
      if (v > 0.5 && this.motionLoopTriggerLast <= 0.5 && this.onMotionLoopTrigger) {
        this.onMotionLoopTrigger()
      }
      this.motionLoopTriggerLast = v
    }
    // ── Input Conditioning (v0.6) ─────────────────────────────────
    // Apply the FIRST matched template's enabled conditioner chain to
    // the raw args BEFORE movement detection, so catch gates, override
    // values, State Triggers, and the red live display all see the
    // conditioned stream. "First matched" follows the existing
    // matchedTemplates[0] precedent used for movement thresholds —
    // one device is bound to one template in every real session.
    const rawArgs = numericArgs
    // (v0.6.4) Record this real address's latest RAW slot-0 value so
    // Derived Parameters that source it can recompute below.
    if (!fromDerived && this.hasAnyDerived && rawArgs.length > 0) {
      const v0 = rawArgs[0]
      if (Number.isFinite(v0)) {
        // Bound the map (delete oldest-inserted) so a device that sprays
        // thousands of distinct addresses can't grow it unbounded.
        if (
          this.derivedSourceLatest.size >= MAX_ADDRESSES_PER_DEVICE &&
          !this.derivedSourceLatest.has(address)
        ) {
          const oldest = this.derivedSourceLatest.keys().next().value
          if (oldest !== undefined) this.derivedSourceLatest.delete(oldest)
        }
        this.derivedSourceLatest.set(address, v0)
      }
    }
    const condTpl = matchedTemplates.find(
      (t) =>
        t.inputConditioner?.enabled &&
        t.inputConditioner.stages.some((s) => s.enabled)
    )
    if (condTpl) {
      numericArgs = this.applyInputConditioning(
        condTpl,
        deviceKey,
        address,
        numericArgs,
        now
      )
    }
    // Live readout: stash the RAW incoming values for this address so
    // the Parameter sidebar can show "what the controller is sending".
    // Capped so a flood of distinct addresses can't grow it unbounded.
    if (this.hardwareLiveByAddress.size >= 256 && !this.hardwareLiveByAddress.has(address)) {
      const oldest = this.hardwareLiveByAddress.keys().next().value
      if (oldest !== undefined) this.hardwareLiveByAddress.delete(oldest)
    }
    // Store BOTH raw and conditioned (post-Input-Conditioning) so the
    // track readout can show the raw stream OR the scaled-of-conditioned
    // value (scaling is applied to the conditioned value in the catch
    // loop below, so the renderer scales `cond` to match exactly).
    this.hardwareLiveByAddress.set(address, {
      raw: rawArgs.slice(),
      cond: numericArgs.slice(),
      atMs: now
    })
    // Scope taps for the conditioning UI — push raw vs conditioned for
    // every LIVE watch on this (template, address, slot). Taps even
    // when no chain is enabled (cond === raw) so the scope shows the
    // live signal while the user is still assembling the chain. Prune
    // stale watches (not polled recently) so a closed scope stops
    // costing anything.
    if (this.conditionerScopes.size > 0) {
      for (const [k, w] of this.conditionerScopes) {
        if (now - w.lastPollMs > CONDITIONER_SCOPE_TTL_MS) {
          this.conditionerScopes.delete(k)
          continue
        }
        if (
          w.address === address &&
          w.slot >= 0 &&
          w.slot < rawArgs.length &&
          matchedTemplates.some((t) => t.id === w.templateId)
        ) {
          w.buf.push({ t: now, raw: rawArgs[w.slot], cond: numericArgs[w.slot] })
          if (w.buf.length > CONDITIONER_SCOPE_LEN) {
            w.buf.splice(0, w.buf.length - CONDITIONER_SCOPE_LEN)
          }
        }
      }
    }
    // (Bug 1 FIX) Cap the per-device movement maps and evict oldest —
    // nothing ever clears these, so without a bound a churning source
    // (or many devices) grows them unbounded. Map preserves insertion
    // order, so the first key is the oldest.
    const MAX_HW_MOVEMENT_DEVICES = 256
    if (
      !this.hardwareLastValues.has(deviceKey) &&
      this.hardwareLastValues.size >= MAX_HW_MOVEMENT_DEVICES
    ) {
      const oldest = this.hardwareLastValues.keys().next().value
      if (oldest !== undefined) {
        this.hardwareLastValues.delete(oldest)
        this.hardwareLastChangeMs.delete(oldest)
      }
    }
    // Update movement state regardless of template match (so future
    // matches don't have to re-prime). Per-device, per-address.
    let perDevValues = this.hardwareLastValues.get(deviceKey)
    let perDevChange = this.hardwareLastChangeMs.get(deviceKey)
    if (!perDevValues) {
      perDevValues = new Map()
      this.hardwareLastValues.set(deviceKey, perDevValues)
    }
    if (!perDevChange) {
      perDevChange = new Map()
      this.hardwareLastChangeMs.set(deviceKey, perDevChange)
    }
    const prevVals = perDevValues.get(address) ?? []
    const prevChange = perDevChange.get(address) ?? []
    // Pre-compute per-slot "is moving?" flags so each template can
    // check movement independently of which template's parameters
    // it's working with. Movement is a property of the hardware
    // input, not of the override target.
    const movingPerSlot: boolean[] = []
    // (v0.5.13) Parallel per-slot "value changed at all?" flags, used
    // as the catch gate for DISCRETE (int/bool) slots. Distinct from
    // movingPerSlot: no movementThreshold scaling, no movementWindowMs
    // aging — a delta of >= 1 integer step IS the user's intent, no
    // matter how long ago the previous change was. Crucially, a
    // re-send of an UNCHANGED value (static stream from a controller
    // that broadcasts state continuously, or a multi-arg packet where
    // only a sibling slot flipped) is NOT a change — so it can't
    // re-catch slots right after a scene trigger cleared them.
    const changedPerSlot: boolean[] = []
    for (let i = 0; i < numericArgs.length; i++) {
      const prev = prevVals[i]
      const prevTs = prevChange[i] ?? 0
      const cur = numericArgs[i]
      // (Bug 6 FIX) Number.isFinite() instead of typeof === 'number':
      // typeof NaN === 'number', so a non-numeric arg (which the
      // network layer maps to NaN) would otherwise store NaN as the
      // baseline; |cur − NaN| is NaN, NaN > threshold is false forever,
      // and the slot never recovers. Treat non-finite prev/cur as "no
      // delta to measure" so the slot re-baselines cleanly below.
      if (!Number.isFinite(prev) || !Number.isFinite(cur)) {
        movingPerSlot.push(false)
        // First-ever observation of this slot: baseline only, no
        // delta to measure. (For streaming controllers the baseline
        // warms within one packet of app start, so this is invisible
        // in practice.)
        changedPerSlot.push(false)
      } else {
        // Use any matching template's movementThreshold (they SHOULD
        // all be similar; pick the first). MovementWindowMs gates
        // the "treat static streams as not moving" behaviour.
        const hw = matchedTemplates[0].hardwareMode!
        const delta = Math.abs(cur - prev)
        const aged = now - prevTs > hw.movementWindowMs
        // (Bug 3 FIX) Per the comment contract: moving when the delta
        // crossed the threshold OR when we've gone movementWindowMs
        // without a change AND the value now differs (end-of-static-
        // burst / slow knob turn). The old `delta > threshold && !aged`
        // meant slow turns (packets > movementWindowMs apart) could
        // never catch. For a controller that streams the same value at
        // 200 Hz, delta === 0 for every packet → still no movement.
        const moving = delta > hw.movementThreshold || (aged && delta > 0)
        movingPerSlot.push(moving)
        changedPerSlot.push(delta > 0)
        if (delta > 0) {
          // Always update the cache when value changed, so the next
          // packet sees a fresh baseline. (If we only updated on
          // moving, a slow drift could starve the cache and trigger
          // false movement on the eventual large delta.)
          prevVals[i] = cur
          prevChange[i] = now
        }
      }
    }
    // Initialise any uninitialised slots so the next packet has a
    // baseline to compare against. Don't classify them as moving on
    // the first observation (no delta to measure).
    // (Bug 6 FIX) Number.isFinite() on both the existing baseline AND
    // the incoming value: a non-finite incoming arg must NOT be stored
    // as a baseline (it would poison every future |cur − NaN| compare),
    // and a previously-poisoned NaN baseline must re-initialise.
    for (let i = 0; i < numericArgs.length; i++) {
      if (!Number.isFinite(prevVals[i]) && Number.isFinite(numericArgs[i])) {
        prevVals[i] = numericArgs[i]
        prevChange[i] = now
      }
    }
    capInnerAddressMap(perDevValues, address)
    capInnerAddressMap(perDevChange, address)
    perDevValues.set(address, prevVals)
    perDevChange.set(address, prevChange)
    // For each matching template, walk its parameters + arg locks
    // and check catch / store overrides.
    for (const tpl of matchedTemplates) {
      const hw = tpl.hardwareMode!
      // Find Track instances of this template (filtered by
      // appliesToTrackIds if narrowed). Empty narrowing = all
      // instances of the template are HW-controllable.
      const tracks = this.session.tracks.filter((t) => {
        if (t.sourceTemplateId !== tpl.id) return false
        if (!hw.appliesToTrackIds || hw.appliesToTrackIds.length === 0) return true
        return hw.appliesToTrackIds.includes(t.id)
      })
      if (tracks.length === 0) continue
      // For each track, find the Function/Parameter whose address
      // matches this OSC message's path. Compare against the live
      // cell.oscAddress (which inherits the function's default if
      // not overridden).
      for (const track of tracks) {
        if (!this.activeSceneId) continue
        const scene = this.session.scenes.find(
          (s) => s.id === this.activeSceneId
        )
        const cell = scene?.cells[track.id]
        if (!cell) continue
        if (cell.oscAddress !== address) continue
        // Resolve which arg slots the HW is locked to. Default =
        // every slot. Narrowing via hw.args[functionId] when set.
        const fnId = track.sourceFunctionId ?? track.id
        const lockedSlots =
          hw.args && hw.args[fnId] && hw.args[fnId].length > 0
            ? hw.args[fnId]
            : null  // null = unlocked, hardware controls all slots
        // (v0.6) Per-parameter hardware scaling — resolved once per
        // track, applied to every slot's hwVal below. MUST happen
        // before the catch-tolerance comparison so catches are
        // evaluated in the parameter's OUTPUT space (a 0..360°
        // device could otherwise never approach a 0..1 scene value).
        const hwScale =
          hw.scaling && hw.scaling[fnId]?.enabled ? hw.scaling[fnId] : null
        for (let i = 0; i < numericArgs.length; i++) {
          if (lockedSlots && !lockedSlots.includes(i)) continue
          // Resolve argType BEFORE the movement gate. Discrete slots
          // (int/bool) use their own gate — see below.
          const argType =
            track.argSpec && track.argSpec[i]
              ? track.argSpec[i].type
              : undefined
          const isDiscrete = argType === 'int' || argType === 'bool'
          // Takeover mode (Feature: Catch / Jump). 'catch' (default,
          // or absent for back-compat) keeps the classic soft-takeover
          // for FLOAT slots: the controller value must approach the
          // scene value within catchTolerance before it takes over.
          // 'jump' makes FLOAT slots catch on the first detected VALUE
          // CHANGE — exactly like the discrete (int/bool) path always
          // has — so any controller movement takes over instantly with
          // no tolerance/approach required. Discrete slots are already
          // instant; jump leaves them untouched.
          const jumpMode = hw.takeover === 'jump'
          // A slot uses the "changed → catch instantly, no tolerance"
          // rule when it's discrete OR when jump mode is on. Otherwise
          // it uses the classic float soft-takeover (movement + tol).
          const instantCatch = isDiscrete || jumpMode
          // Two different gates (v0.5.13):
          //
          // FLOAT slots → movingPerSlot: movementThreshold +
          // movementWindowMs aging, the classic soft-takeover
          // movement detector. Unchanged since v0.5.5.
          //
          // DISCRETE slots → changedPerSlot: did the value change AT
          // ALL since the device's previous transmission? No
          // threshold (integer deltas are always >= 1), no aging
          // window (a switch flipped after an hour idle is exactly as
          // intentional as one flipped immediately — the aged gate
          // was why slow single increments felt dead in v0.5.12).
          //
          // History of this gate, because we got it wrong twice
          // while iterating on the v0.5.13 fix:
          // - v0.5.12: discrete catch behind movingPerSlot → the aged
          //   window killed slow single increments ("fast turn works,
          //   slow press doesn't").
          // - v0.5.13 first build (withdrawn): discrete catch on ANY
          //   packet, no gate → a controller that STREAMS its state
          //   (OCTOCOSME broadcasts continuously) re-caught every
          //   discrete slot on the first packet after a scene trigger
          //   cleared catches, so scenes could never assert their
          //   saved switch data ("works TOO good").
          // - v0.5.13 final: discrete catch on VALUE CHANGE. Static
          //   streams and sibling-slot multi-arg updates don't
          //   re-catch; an actual flip catches instantly regardless
          //   of timing.
          const hwVal = hwScale
            ? scaleHardwareValue(hwScale, numericArgs[i])
            : numericArgs[i]
          const catchKey = `${track.id}|${i}`
          // (Bug 33 FIX) Already-caught refresh runs BEFORE the
          // movement/change gate. Catches restored from
          // session.hardwareState carry NO override value, so if the
          // refresh sat below the gate, a streaming-but-static
          // controller (delta 0 every packet → gate continues) could
          // never populate hardwareOverride and the slot stayed frozen
          // at the scene value. An already-caught slot must self-heal
          // its override on ANY packet, regardless of movement.
          if (this.hardwareCaught.get(catchKey)) {
            if (Number.isFinite(hwVal)) this.hardwareOverride.set(catchKey, hwVal)
            continue
          }
          // Movement/change gate applies only to NOT-yet-caught slots:
          // a fresh catch still requires the user to actually move
          // (float) or change (discrete) the control. In jump mode a
          // float slot uses the discrete changedPerSlot gate so the
          // very first value change qualifies (no movementThreshold /
          // aging window needed).
          if (instantCatch ? !changedPerSlot[i] : !movingPerSlot[i]) continue
          // (v0.5.12 fix) Integer-aware catch path. For discrete slots
          // (encoder positions, instrument selectors, KILL switches,
          // bool flags), the percentage-based tolerance breaks UX —
          // integer deltas are always ≥1, but a tolerance like 5% on
          // a 0-7 range maps to 0.35 absolute, so |hwVal - sceneVal|
          // is either 0 (exact match → catches) or ≥1 (any miss →
          // fails). The encoder feels dead unless the user lands
          // exactly on the scene's int, which breaks "turn the
          // encoder and it takes over" for switches/selectors.
          //
          // Semantic argument: soft-takeover exists to prevent
          // audible/visible jumps on continuous params (smooth
          // floats). Discrete params have no smooth handoff to
          // protect — any VALUE CHANGE is the user's intentional
          // input (changedPerSlot gated us above, v0.5.13). In a
          // multi-arg packet (e.g. /B/strips/switches with 8 bools)
          // only the slots that actually flipped catch; the siblings
          // stay under scene control.
          //
          // Jump-mode float slots take the SAME branch: changedPerSlot
          // gated us above, so reaching here means the user moved the
          // control — catch it instantly with no tolerance check, just
          // like a discrete flip. (catchTolerance is unused in jump.)
          if (instantCatch) {
            this.hardwareCaught.set(catchKey, true)
            this.hardwareOverride.set(catchKey, hwVal)
            continue
          }
          // Float-typed slot (or unknown — fall back to existing
          // tolerance check). Pull the most recent ts.lastSentNumeric
          // for this track. If nothing's been emitted yet, skip until
          // the scene actually produces a value.
          const ts = this.tracks.get(track.id)
          const sceneVal = ts?.lastSentNumeric?.[i]
          if (typeof sceneVal !== 'number') continue
          // Catch tolerance is a fraction of the param's RANGE. For
          // scaled-to-unit params the range is [0,1]; otherwise we
          // fall back to a generous absolute tolerance derived from
          // the value's magnitude.
          const range = cell.scaleToUnit ? 1 : Math.max(1, Math.abs(sceneVal) * 2)
          const tol = hw.catchTolerance * range
          if (Math.abs(hwVal - sceneVal) <= tol) {
            this.hardwareCaught.set(catchKey, true)
            this.hardwareOverride.set(catchKey, hwVal)
          }
        }
      }
    }

    // ── Direct Output (v0.6.x) — conditioned + scaled passthrough ──
    // Re-emit the conditioned + per-Parameter-scaled value straight to
    // a destination on EVERY packet, with NO scene and NO catch. The
    // "just scale my hardware and send it out" path for continuous
    // controllers (IMU → Max/Ableton). numericArgs is already the
    // conditioned stream at this point; we apply the same per-parameter
    // scaling the catch loop uses, then send on the incoming address.
    for (const tpl of matchedTemplates) {
      const hw = tpl.hardwareMode!
      const dout = hw.directOutput
      if (!dout || !dout.enabled) continue
      if (!dout.destIp || !(dout.destPort > 0)) continue
      // Match the incoming address to one of the template's Parameters
      // (resolving relative oscPaths against the template base, exactly
      // as instantiation does) to find its scaling + arg types.
      const base = tpl.oscAddressBase || ''
      const fn = tpl.functions.find((f) => {
        const a = f.oscPath.startsWith('/')
          ? f.oscPath
          : base.endsWith('/')
            ? base + f.oscPath
            : `${base}/${f.oscPath}`
        return a === address
      })
      if (!fn) continue
      // Yield to a playing recorded loop (Motion Loop). If the active
      // scene has an enabled recordedLoop on a track for THIS Parameter,
      // the loop is the source (loop replaces live) and the engine tick
      // is already emitting it to the cell's destination. Skip the live
      // passthrough for this address so the two don't race on the M4L.
      // Non-looped parameters keep flowing live, automatically.
      if (this.activeSceneId) {
        const activeScene = this.session.scenes.find(
          (s) => s.id === this.activeSceneId
        )
        if (
          activeScene &&
          this.session.tracks.some(
            (t) =>
              t.sourceTemplateId === tpl.id &&
              (t.sourceFunctionId ?? '') === fn.id &&
              activeScene.cells[t.id]?.recordedLoop?.enabled === true
          )
        ) {
          continue
        }
      }
      // Respect per-arg locks: when hw.args[fn.id] is a non-empty list,
      // only those slots pass through (matches the catch loop). null =
      // all slots.
      const locked =
        hw.args && hw.args[fn.id] && hw.args[fn.id].length > 0
          ? hw.args[fn.id]
          : null
      const scale =
        hw.scaling && hw.scaling[fn.id]?.enabled ? hw.scaling[fn.id] : null
      const outArgs: { type: 'f' | 'i'; value: number }[] = []
      for (let i = 0; i < numericArgs.length; i++) {
        if (locked && !locked.includes(i)) continue
        const v = numericArgs[i]
        if (!Number.isFinite(v)) continue
        const scaled = scale ? scaleHardwareValue(scale, v) : v
        // Scaling always yields a float in the mapped range. Only emit
        // an int token when the arg is declared int AND no scaling is
        // active (an unscaled discrete slot — e.g. /mpu/btn1).
        const declaredInt =
          fn.argSpec && fn.argSpec[i] && fn.argSpec[i].type === 'int'
        outArgs.push(
          declaredInt && !scale
            ? { type: 'i', value: Math.round(scaled) }
            : { type: 'f', value: scaled }
        )
      }
      if (outArgs.length > 0) {
        this.sender.sendMany(dout.destIp, dout.destPort, address, outArgs)
      }
    }

    // ── Motion Loop recording (v0.6.x) ────────────────────────────
    // While a scene is armed for capture, append the conditioned +
    // per-Parameter-scaled value of every matching Parameter to the
    // record buffer, keyed by trackId. Same conditioned stream Direct
    // Output uses — here it's written into cells instead of sent out.
    const recLoop = this.recordingLoop
    if (recLoop) {
      const recScene = this.session.scenes.find((s) => s.id === recLoop.sceneId)
      if (recScene) {
        for (const tpl of matchedTemplates) {
          const hw = tpl.hardwareMode!
          const base = tpl.oscAddressBase || ''
          const fn = tpl.functions.find((f) => {
            const a = f.oscPath.startsWith('/')
              ? f.oscPath
              : base.endsWith('/')
                ? base + f.oscPath
                : `${base}/${f.oscPath}`
            return a === address
          })
          if (!fn) continue
          const scale =
            hw.scaling && hw.scaling[fn.id]?.enabled ? hw.scaling[fn.id] : null
          const vals = numericArgs.map((x) =>
            Number.isFinite(x) ? (scale ? scaleHardwareValue(scale, x) : x) : 0
          )
          const tRel = now - recLoop.startMs
          for (const track of this.session.tracks) {
            if (track.sourceTemplateId !== tpl.id) continue
            if ((track.sourceFunctionId ?? '') !== fn.id) continue
            // NOTE: capture even when the scene has no clip yet for this
            // parameter — stopMotionLoopRecord() auto-creates the clips on
            // the renderer side so an empty scene records into fresh clips.
            let arr = recLoop.frames.get(track.id)
            if (!arr) {
              arr = []
              recLoop.frames.set(track.id, arr)
            }
            // Cap ~20 min at 50 Hz to bound memory on a runaway record.
            if (arr.length < 60000) arr.push({ t: tRel, v: vals })
          }
        }
      }
    }

    // ── State Triggers + learn-recording (v0.6) ───────────────────
    // Refresh the per-device latest-values snapshot with the
    // CONDITIONED args, feed an in-flight Record session, then run
    // every matched template's state detectors against the snapshot.
    let latestByAddress = this.stateInputLatest.get(deviceKey)
    if (!latestByAddress) {
      latestByAddress = new Map()
      this.stateInputLatest.set(deviceKey, latestByAddress)
      // Same eviction discipline as the movement maps.
      if (this.stateInputLatest.size > MAX_CONDITIONER_KEYS) {
        const oldest = this.stateInputLatest.keys().next().value
        if (oldest !== undefined && oldest !== deviceKey) {
          this.stateInputLatest.delete(oldest)
        }
      }
    }
    capInnerAddressMap(latestByAddress, address)
    latestByAddress.set(address, numericArgs.slice())
    const rec = this.stateRecording
    if (rec && matchedTemplates.some((t) => t.id === rec.templateId)) {
      if (now <= rec.until) {
        let arr = rec.samples.get(address)
        if (!arr) {
          arr = []
          rec.samples.set(address, arr)
        }
        arr.push(numericArgs.slice())
      } else {
        this.finishStateRecording()
      }
    }
    for (const tpl of matchedTemplates) {
      // Don't fire triggers on the template being recorded — the user
      // is deliberately holding a pose; firing mid-record is noise.
      if (rec && rec.templateId === tpl.id) continue
      if (tpl.stateTriggers && tpl.stateTriggers.length > 0) {
        this.evaluateStateTriggers(tpl, latestByAddress, now)
      }
      if (tpl.poseSequences && tpl.poseSequences.length > 0) {
        this.evaluatePoseSequences(tpl, latestByAddress, now)
      }
    }

    // ── Derived Parameters (v0.6.4) ───────────────────────────────
    // If this real address feeds any derived param, recompute it from
    // the latest RAW source values and INJECT the result as a synthetic
    // incoming packet — so the derived address flows through the whole
    // pipeline (conditioning / catch / Direct Output / states) like a
    // real one, and shows up in the OSC In monitor. The `fromDerived`
    // guard blocks recursion + derived-of-derived.
    if (!fromDerived && this.hasAnyDerived) {
      for (const tpl of matchedTemplates) {
        const derived = tpl.derivedParams
        if (!derived || derived.length === 0) continue
        for (const dp of derived) {
          if (!dp.address || dp.sources.length === 0) continue
          if (!dp.sources.includes(address)) continue
          const vals = dp.sources.map((s) => this.derivedSourceLatest.get(s))
          if (vals.some((v) => v === undefined || !Number.isFinite(v))) continue
          const combined = computeDerived(dp.op, vals as number[])
          if (!Number.isFinite(combined)) continue
          // Universal Output transform — applies to every op.
          const out = combined * (dp.scale ?? 1) + (dp.offset ?? 0)
          if (!Number.isFinite(out)) continue
          this.derivedLatest.set(dp.address, out)
          if (this.onDerived) {
            this.onDerived({
              timestamp: now,
              ip,
              port,
              address: dp.address,
              args: [{ type: 'f', value: out }]
            })
          }
          this.handleHardwareInput(ip, port, dp.address, [out], true)
        }
      }
    }
  }

  // ── Input Conditioning chain (v0.6) ───────────────────────────────
  // Runs the template's enabled stages over every arg slot. Filter
  // state is keyed (templateId | deviceKey | address); slot states are
  // index-parallel to the chain so edits re-warm from scratch when the
  // stage count changes.
  private applyInputConditioning(
    tpl: InstrumentTemplate,
    deviceKey: string,
    address: string,
    args: number[],
    now: number
  ): number[] {
    const cfg = tpl.inputConditioner as InputConditionerConfig
    const key = `${tpl.id}|${deviceKey}|${address}`
    let slots = this.conditionerState.get(key)
    if (!slots) {
      slots = []
      if (this.conditionerState.size >= MAX_CONDITIONER_KEYS) {
        const oldest = this.conditionerState.keys().next().value
        if (oldest !== undefined) this.conditionerState.delete(oldest)
      }
      this.conditionerState.set(key, slots)
    }
    const bypass = cfg.slotBypass ?? []
    const out = args.slice()
    for (let i = 0; i < out.length; i++) {
      if (!Number.isFinite(out[i])) continue
      if (bypass.includes(i)) continue
      let st = slots[i]
      // Re-warm when the chain SHAPE changed — not just the count, but
      // also any in-place stage TYPE swap or reorder. A stale `ring`
      // (median) or `min/max` (autoRange) surviving into a different
      // stage type would produce a glitch, so key the re-warm on the
      // ordered type signature.
      const sig = cfg.stages.map((s) => s.type).join(',')
      if (!st || st.sig !== sig) {
        st = {
          lastT: now,
          sig,
          stages: cfg.stages.map(() => ({}))
        }
        slots[i] = st
      }
      // dt in seconds, clamped: a long gap (sensor unplugged) re-warms
      // rather than producing one giant integration step.
      const dtSec = Math.min(2, Math.max(0.001, (now - st.lastT) / 1000))
      let v = out[i]
      for (let s = 0; s < cfg.stages.length; s++) {
        const stage = cfg.stages[s]
        if (!stage.enabled) continue
        // (v0.6) Address targeting — a stage with an explicit address
        // only touches that address. Empty/undefined = all addresses.
        if (stage.address && stage.address !== address) continue
        v = this.applyStage(stage, st.stages[s], v, dtSec)
      }
      st.lastT = now
      out[i] = v
    }
    return out
  }

  // One stage, one slot, one sample. `ss` is this stage's persistent
  // state for the slot; mutated in place.
  private applyStage(
    stage: InputStage,
    ss: ConditionerStageState,
    x: number,
    dtSec: number
  ): number {
    switch (stage.type) {
      case 'oneEuro': {
        // Casiez 1€: EMA whose cutoff rises with speed.
        //   alpha(dt, fc) = 1 / (1 + tau/dt), tau = 1/(2π·fc)
        const minCutoff = Math.max(0.01, stage.minCutoffHz ?? 1.0)
        const beta = Math.max(0, stage.beta ?? 0.02)
        if (ss.xHat === undefined || !Number.isFinite(ss.xHat)) {
          ss.xHat = x
          ss.dxHat = 0
          return x
        }
        const alphaFor = (fc: number): number => {
          const tau = 1 / (2 * Math.PI * fc)
          return 1 / (1 + tau / dtSec)
        }
        const dx = (x - ss.xHat) / dtSec
        // Derivative low-passed at a fixed 1 Hz (paper's dcutoff).
        const aD = alphaFor(1.0)
        ss.dxHat = (ss.dxHat ?? 0) + aD * (dx - (ss.dxHat ?? 0))
        const cutoff = minCutoff + beta * Math.abs(ss.dxHat)
        const aX = alphaFor(cutoff)
        ss.xHat = ss.xHat + aX * (x - ss.xHat)
        return ss.xHat
      }
      case 'smooth': {
        // Same one-pole shape as the Slew modulator's filter:
        //   y += (x − y) · (1 − 2^(−dtMs / halfLife))
        const hl = Math.max(1, stage.halfLifeMs ?? 60)
        if (ss.y === undefined || !Number.isFinite(ss.y)) {
          ss.y = x
          return x
        }
        const alpha = 1 - Math.pow(2, (-dtSec * 1000) / hl)
        ss.y += (x - ss.y) * alpha
        return ss.y
      }
      case 'median': {
        const w = Math.max(3, Math.min(9, Math.floor(stage.window ?? 3)) | 1)
        if (!ss.ring) ss.ring = []
        ss.ring.push(x)
        if (ss.ring.length > w) ss.ring.splice(0, ss.ring.length - w)
        const sorted = ss.ring.slice().sort((a, b) => a - b)
        return sorted[Math.floor(sorted.length / 2)]
      }
      case 'slewLimit': {
        const rate = Math.max(0, stage.maxPerSec ?? 2)
        if (ss.out === undefined || !Number.isFinite(ss.out)) {
          ss.out = x
          return x
        }
        const maxStep = rate * dtSec
        const delta = x - ss.out
        ss.out += Math.max(-maxStep, Math.min(maxStep, delta))
        return ss.out
      }
      case 'deadband': {
        const eps = Math.max(0, stage.epsilon ?? 0.002)
        if (ss.lastOut === undefined || !Number.isFinite(ss.lastOut)) {
          ss.lastOut = x
          return x
        }
        if (Math.abs(x - ss.lastOut) < eps) return ss.lastOut
        ss.lastOut = x
        return x
      }
      case 'autoRange': {
        // Leaky min/max envelope → rescale to 0..1. Expansion is
        // instant; contraction (when configured) forgets old extremes
        // with a half-life so one historic spike doesn't squash the
        // live range forever.
        if (ss.min === undefined || !Number.isFinite(ss.min)) ss.min = x
        if (ss.max === undefined || !Number.isFinite(ss.max)) ss.max = x
        if (x < ss.min) ss.min = x
        if (x > ss.max) ss.max = x
        const hl = stage.contractHalfLifeMs ?? 0
        if (hl > 0) {
          const k = 1 - Math.pow(2, (-dtSec * 1000) / Math.max(1, hl))
          ss.min += (x - ss.min) * k
          ss.max -= (ss.max - x) * k
          if (ss.min > ss.max) {
            ss.min = x
            ss.max = x
          }
        }
        const range = ss.max - ss.min
        // Degenerate range (first samples of a static stream): center.
        if (range < 1e-9) return 0.5
        return (x - ss.min) / range
      }
      default:
        // Unknown stage type (session saved by a newer build, or
        // corrupt data) — pass the value through untouched rather than
        // returning `undefined` into the conditioned stream.
        return x
    }
  }

  // ── State Trigger evaluation (v0.6) ───────────────────────────────
  // Runs every enabled trigger of one template against the device's
  // latest conditioned snapshot. Enter requires the detector to match
  // continuously for dwellMs; exit uses a hysteresis-expanded region
  // so boundary jitter can't machine-gun MIDI.
  private evaluateStateTriggers(
    tpl: InstrumentTemplate,
    latestByAddress: Map<string, number[]>,
    now: number
  ): void {
    const midiOk = this.session?.midiEnabled === true
    for (const trig of tpl.stateTriggers ?? []) {
      const key = `${tpl.id}|${trig.id}`
      if (!trig.enabled) {
        this.stateTriggerLive.delete(key)
        // Disabled while active with a held note → release it (else it
        // hangs) and reset the runtime so re-enabling starts clean.
        const rtOff = this.stateTriggerRuntime.get(key)
        if (rtOff?.active) {
          this.releaseStateNote(key)
          rtOff.active = false
          rtOff.matchSince = 0
          rtOff.unmatchedSince = 0
          rtOff.lastCcSent = -1
        }
        continue
      }
      let rt = this.stateTriggerRuntime.get(key)
      if (!rt) {
        rt = { active: false, matchSince: 0, lastCcSent: -1, unmatchedSince: 0 }
        this.stateTriggerRuntime.set(key, rt)
      }
      const { score, matched, matchedWithHysteresis } = this.computeStateMatch(
        trig,
        latestByAddress
      )
      this.stateTriggerLive.set(key, score)
      const m = trig.actions.midi
      const canMidi = midiOk && m?.enabled === true && !!m.portName
      // Continuous mode: stream the live score as a CC, change-gated so
      // a static pose doesn't spam identical bytes at packet rate.
      if (trig.mode === 'continuous' && canMidi && m!.kind === 'cc') {
        const ccVal = Math.max(0, Math.min(127, Math.round(score * 127)))
        if (ccVal !== rt.lastCcSent) {
          rt.lastCcSent = ccVal
          this.midiSender.sendCc(
            m!.portName,
            m!.channel,
            Math.max(0, Math.min(127, Math.floor(m!.cc ?? 20))),
            ccVal
          )
        }
      }
      if (!rt.active) {
        if (matched) {
          if (rt.matchSince === 0) rt.matchSince = now
          if (now - rt.matchSince >= Math.max(0, trig.dwellMs)) {
            rt.active = true
            rt.matchSince = 0
            rt.unmatchedSince = 0
            this.fireStateEnter(trig, canMidi, key)
          }
        } else {
          rt.matchSince = 0
        }
      } else {
        // Active. Exit only after the match has stayed below the
        // hysteresis-widened threshold continuously for holdMs — so a
        // brief dip / noise spike / drift excursion doesn't drop the
        // note. Any moment back inside the region resets the hold.
        if (matchedWithHysteresis) {
          rt.unmatchedSince = 0
        } else {
          if (rt.unmatchedSince === 0) rt.unmatchedSince = now
          if (now - rt.unmatchedSince >= Math.max(0, trig.holdMs ?? 0)) {
            rt.active = false
            rt.matchSince = 0
            rt.unmatchedSince = 0
            this.fireStateExit(trig, canMidi, key)
          }
        }
      }
    }
  }

  // Detector → {score 0..1, matched, matchedWithHysteresis}. Rules give
  // a graded score (mean closeness across rules) so continuous mode is
  // useful with rules too; learned gives a Gaussian-ish closeness to
  // the recorded centroid.
  private computeStateMatch(
    trig: StateTrigger,
    latestByAddress: Map<string, number[]>
  ): { score: number; matched: boolean; matchedWithHysteresis: boolean } {
    const hyst = Math.max(0, Math.min(0.5, trig.hysteresisPct))
    if (trig.detector === 'learned') {
      const L = trig.learned
      if (!L || L.dims.length === 0) {
        return { score: 0, matched: false, matchedWithHysteresis: false }
      }
      const score = this.matchLearned(L, latestByAddress)
      const thr = Math.max(0.001, Math.min(1, L.threshold))
      return {
        score,
        matched: score >= thr,
        matchedWithHysteresis: score >= thr * (1 - hyst)
      }
    }
    // Rules — AND-combined. Each rule contributes a "distance outside
    // the accepted region" normalized by the rule's span; hysteresis
    // widens the region for the exit test.
    if (trig.rules.length === 0) {
      return { score: 0, matched: false, matchedWithHysteresis: false }
    }
    let all = true
    let allH = true
    let closeness = 0
    for (const rule of trig.rules) {
      const args = latestByAddress.get(rule.address)
      const v = args?.[rule.slot]
      if (typeof v !== 'number' || !Number.isFinite(v)) {
        all = false
        allH = false
        continue
      }
      // Per-op span used to normalize distance + scale hysteresis.
      const tol =
        rule.tol ?? Math.max(0.02 * Math.max(Math.abs(rule.a), 0.5), 1e-4)
      let dist = 0 // 0 = inside the region
      let span = 1
      switch (rule.op) {
        case 'eq': {
          dist = Math.max(0, Math.abs(v - rule.a) - tol)
          span = Math.max(tol, 1e-9)
          break
        }
        case 'range': {
          const lo = Math.min(rule.a, rule.b ?? rule.a)
          const hi = Math.max(rule.a, rule.b ?? rule.a)
          dist = v < lo ? lo - v : v > hi ? v - hi : 0
          span = Math.max(hi - lo, 1e-9)
          break
        }
        case 'gt': {
          dist = v > rule.a ? 0 : rule.a - v
          span = Math.max(Math.abs(rule.a) * 0.1, tol)
          break
        }
        case 'lt': {
          dist = v < rule.a ? 0 : v - rule.a
          span = Math.max(Math.abs(rule.a) * 0.1, tol)
          break
        }
      }
      const dNorm = dist / span
      if (dNorm > 0) all = false
      if (dNorm > hyst) allH = false
      closeness += Math.max(0, 1 - Math.min(1, dNorm))
    }
    return {
      score: closeness / trig.rules.length,
      matched: all,
      // Exit only when some rule leaves the hysteresis-widened region.
      matchedWithHysteresis: allH
    }
  }

  // ── Robust, forgiving learned-pose match (v0.6.x rework) ──────────
  // Returns a closeness score in [0, 1] for a recorded pose against the
  // live conditioned stream. Shared by State Triggers AND Pose Sequence
  // waypoints. Old formula was exp(-0.5·MEAN z²): one drifting dimension
  // (large z²) collapsed the whole score, and a held-still recording
  // gave a razor-thin acceptance band — unusable ("triggers then dies").
  // New formula: the MEAN of per-dimension Gaussian memberships, each
  // bounded in (0, 1], so one drifting input can only drop the score by
  // ~1/N. Acceptance width per dim = max(recorded stddev, tolerance ·
  // |centroid|): the Tolerance knob sets how loose the match is, recorded
  // jitter only matters if wider. Disabled dims are skipped.
  private matchLearned(
    L: LearnedState,
    latestByAddress: Map<string, number[]>
  ): number {
    if (!L || L.dims.length === 0) return 0
    const tol = Math.max(0.01, Math.min(1, L.tolerance ?? 0.25))
    const MIN_SCALE = 0.05 // floor so a zero-centred dim still has a band
    let sum = 0
    let count = 0
    for (let i = 0; i < L.dims.length; i++) {
      const d = L.dims[i]
      if (d.enabled === false) continue // excluded channel (drifty/irrelevant)
      count++
      const args = latestByAddress.get(d.address)
      const v = args?.[d.slot]
      if (typeof v !== 'number' || !Number.isFinite(v)) continue // membership 0
      const c = L.centroid[i]
      const recSigma = Math.sqrt(Math.max(0, L.variance[i] ?? 0))
      const sigma = Math.max(recSigma, tol * Math.max(Math.abs(c), MIN_SCALE))
      const z = (v - c) / sigma
      sum += Math.exp(-0.5 * z * z) // per-dim membership in (0, 1]
    }
    return count > 0 ? sum / count : 0
  }

  // ── Pose Sequences (v0.6.5) ───────────────────────────────────────
  // A sequence is an ordered list of learned poses ("waypoints"). Strict
  // order: only the CURRENT waypoint can fire. When it's matched (score ≥
  // its threshold) and held for dwellMs, we fire its MIDI/scene and
  // advance. Wait-in-place: a stray pose never resets the playhead — we
  // simply keep waiting on the current waypoint. Loop wraps to 0; a
  // non-looping phrase parks on the last step (`done`) until reset. The
  // `ready` flag enforces a rising edge — you must LEAVE a pose (drop
  // below threshold) before the next waypoint can fire, so two similar
  // adjacent poses can't cascade in one gesture.
  private evaluatePoseSequences(
    tpl: InstrumentTemplate,
    latestByAddress: Map<string, number[]>,
    now: number
  ): void {
    const midiOk = this.session?.midiEnabled === true
    for (const seq of tpl.poseSequences ?? []) {
      const key = `${tpl.id}|${seq.id}`
      // While the companion recorder owns this sequence, don't fire or
      // advance the playhead in the get-ready gaps between per-pose
      // records — a "record" operation shouldn't emit the sequence's MIDI.
      if (this.suppressedSeqKeys.has(key)) {
        this.releaseSeqNote(key)
        continue
      }
      if (!seq.enabled || seq.waypoints.length === 0) {
        if (this.poseSequenceRuntime.has(key)) {
          this.releaseSeqNote(key)
          this.poseSequenceRuntime.delete(key)
          this.poseSequenceLive.delete(key)
        }
        continue
      }
      let rt = this.poseSequenceRuntime.get(key)
      if (!rt) {
        rt = { step: 0, matchSince: 0, ready: true, done: false }
        this.poseSequenceRuntime.set(key, rt)
      }
      // Finished a non-looping phrase → park (show "complete") until a
      // manual reset. step === length signals completion to the UI. But
      // un-park automatically if the sequence was since made looping, or
      // grew new waypoints past the parked end — the user clearly wants
      // it to keep playing rather than stay frozen.
      if (rt.done) {
        if (seq.loop || rt.step < seq.waypoints.length - 1) {
          rt.done = false
          rt.step = seq.loop ? 0 : rt.step + 1
          rt.matchSince = 0
          rt.ready = true
        } else {
          this.poseSequenceLive.set(key, { step: seq.waypoints.length, score: 0 })
          continue
        }
      }
      // Clamp the step if waypoints were edited/shortened out from under us.
      if (rt.step >= seq.waypoints.length) {
        rt.step = 0
        rt.matchSince = 0
        rt.ready = true
      }
      const wp = seq.waypoints[rt.step]
      const L = wp.learned
      // A waypoint with no recorded pose can never match — hold here so
      // the performer can't skip an unrecorded step (strict order).
      const score = L && L.dims.length > 0 ? this.matchLearned(L, latestByAddress) : 0
      this.poseSequenceLive.set(key, { step: rt.step, score })
      const thr = L ? Math.max(0.001, Math.min(1, L.threshold)) : 1.1
      if (score >= thr) {
        if (rt.matchSince === 0) rt.matchSince = now
        if (rt.ready && now - rt.matchSince >= Math.max(0, seq.dwellMs)) {
          const m = wp.midi
          const canMidi = midiOk && m?.enabled === true && !!m.portName
          this.fireWaypoint(wp, canMidi, key)
          const nextStep = rt.step + 1
          if (nextStep >= seq.waypoints.length) {
            if (seq.loop) {
              rt.step = 0
            } else {
              rt.step = seq.waypoints.length - 1
              rt.done = true
            }
          } else {
            rt.step = nextStep
          }
          rt.matchSince = 0
          rt.ready = false // must leave the (new current) pose before it fires
        }
      } else {
        rt.matchSince = 0
        rt.ready = true // left a pose → next entry is a fresh rising edge
      }
    }
  }

  // Fire a single waypoint's action: a momentary (gated) Note or a CC,
  // plus an optional scene trigger. Mono per sequence — a new fire
  // releases the previous waypoint's note first.
  private fireWaypoint(wp: PoseWaypoint, canMidi: boolean, key: string): void {
    const m = wp.midi
    if (canMidi && m) {
      if (m.kind === 'note') {
        const note = Math.max(0, Math.min(127, Math.floor(m.note ?? 60)))
        const vel = Math.max(1, Math.min(127, Math.floor(m.velocity ?? 100)))
        this.releaseSeqNote(key)
        this.midiSender.sendNoteOn(m.portName, m.channel, note, vel)
        this.poseSequenceHeldNote.set(key, {
          port: m.portName,
          channel: m.channel,
          note
        })
        // Waypoints are momentary (no exit event) → schedule a gated
        // Note Off so the note never hangs.
        const port = m.portName
        const ch = m.channel
        const timer = setTimeout(() => {
          this.poseSequenceGateTimers.delete(key)
          const held = this.poseSequenceHeldNote.get(key)
          if (held && held.note === note && held.port === port) {
            this.midiSender.sendNoteOff(port, ch, note)
            this.poseSequenceHeldNote.delete(key)
          }
        }, STATE_ONESHOT_GATE_MS)
        this.poseSequenceGateTimers.set(key, timer)
      } else {
        const cc = Math.max(0, Math.min(127, Math.floor(m.cc ?? 20)))
        const val = Math.max(0, Math.min(127, Math.floor(m.ccEnterValue ?? 127)))
        this.midiSender.sendCc(m.portName, m.channel, cc, val)
      }
    }
    const sceneId = wp.triggerSceneId
    if (sceneId && this.session?.scenes.some((s) => s.id === sceneId)) {
      this.triggerScene(sceneId)
    }
  }

  /** Release a sequence's held note (if any) + clear its gate timer.
   *  Returns true if a note was actually released. */
  private releaseSeqNote(key: string): boolean {
    const timer = this.poseSequenceGateTimers.get(key)
    if (timer) {
      clearTimeout(timer)
      this.poseSequenceGateTimers.delete(key)
    }
    const held = this.poseSequenceHeldNote.get(key)
    if (!held) return false
    this.poseSequenceHeldNote.delete(key)
    this.midiSender.sendNoteOff(held.port, held.channel, held.note)
    return true
  }

  /** Release every held Pose-Sequence note. Called on stop()/panic. */
  private releaseAllSeqNotes(): void {
    for (const key of Array.from(this.poseSequenceHeldNote.keys())) {
      this.releaseSeqNote(key)
    }
    for (const t of this.poseSequenceGateTimers.values()) clearTimeout(t)
    this.poseSequenceGateTimers.clear()
  }

  /** Pause/resume a sequence's live evaluation while the companion
   *  recorder cycles through its poses — so a hands-free record doesn't
   *  fire the sequence's own MIDI in the get-ready gaps. Releases any
   *  held note when paused. */
  setPoseSequenceSuppressed(templateId: string, seqId: string, on: boolean): void {
    const key = `${templateId}|${seqId}`
    if (on) {
      this.suppressedSeqKeys.add(key)
      this.releaseSeqNote(key)
    } else {
      this.suppressedSeqKeys.delete(key)
    }
  }

  /** Rewind a sequence to its first waypoint (and clear a `done` park).
   *  Exposed over IPC for the UI's per-sequence Reset button. */
  resetPoseSequence(templateId: string, seqId: string): void {
    const key = `${templateId}|${seqId}`
    this.releaseSeqNote(key)
    const rt = this.poseSequenceRuntime.get(key)
    if (rt) {
      rt.step = 0
      rt.matchSince = 0
      rt.ready = true
      rt.done = false
    } else {
      this.poseSequenceRuntime.set(key, {
        step: 0,
        matchSince: 0,
        ready: true,
        done: false
      })
    }
    this.poseSequenceLive.set(key, { step: 0, score: 0 })
  }

  private fireStateEnter(trig: StateTrigger, canMidi: boolean, key: string): void {
    const m = trig.actions.midi
    if (canMidi && m && trig.mode !== 'continuous') {
      if (m.kind === 'note') {
        const note = Math.max(0, Math.min(127, Math.floor(m.note ?? 60)))
        const vel = Math.max(1, Math.min(127, Math.floor(m.velocity ?? 100)))
        // Release any note still held for this trigger before the new
        // one (mono per trigger) — also clears a pending gate timer.
        this.releaseStateNote(key)
        this.midiSender.sendNoteOn(m.portName, m.channel, note, vel)
        this.stateTriggerHeldNote.set(key, {
          port: m.portName,
          channel: m.channel,
          note
        })
        // oneShot has no exit event to release the note, so schedule a
        // gated Note Off — otherwise the note hangs forever.
        if (trig.mode === 'oneShot') {
          const port = m.portName
          const ch = m.channel
          const timer = setTimeout(() => {
            this.stateTriggerGateTimers.delete(key)
            const held = this.stateTriggerHeldNote.get(key)
            if (held && held.note === note && held.port === port) {
              this.midiSender.sendNoteOff(port, ch, note)
              this.stateTriggerHeldNote.delete(key)
            }
          }, STATE_ONESHOT_GATE_MS)
          this.stateTriggerGateTimers.set(key, timer)
        }
      } else {
        const cc = Math.max(0, Math.min(127, Math.floor(m.cc ?? 20)))
        const val = Math.max(0, Math.min(127, Math.floor(m.ccEnterValue ?? 127)))
        this.midiSender.sendCc(m.portName, m.channel, cc, val)
      }
    }
    // Scene trigger fires at enter for EVERY mode — it's a trigger,
    // not a gate; the scene lives its own lifecycle afterwards.
    const sceneId = trig.actions.triggerSceneId
    if (sceneId && this.session?.scenes.some((s) => s.id === sceneId)) {
      this.triggerScene(sceneId)
    }
  }

  private fireStateExit(trig: StateTrigger, canMidi: boolean, key: string): void {
    if (trig.mode !== 'enterExit') return
    const m = trig.actions.midi
    if (!m) return
    if (m.kind === 'note') {
      // Always release the exact held note (even if MIDI was disabled
      // meanwhile — the Note Off is a cleanup, harmless if the port is
      // gone). Falls back to the configured note if nothing tracked.
      if (!this.releaseStateNote(key) && canMidi) {
        const note = Math.max(0, Math.min(127, Math.floor(m.note ?? 60)))
        this.midiSender.sendNoteOff(m.portName, m.channel, note)
      }
    } else if (canMidi) {
      const cc = Math.max(0, Math.min(127, Math.floor(m.cc ?? 20)))
      const val = Math.max(0, Math.min(127, Math.floor(m.ccExitValue ?? 0)))
      this.midiSender.sendCc(m.portName, m.channel, cc, val)
    }
  }

  /** Send Note Off for a trigger's held note (if any) and clear its
   *  gate timer. Returns true if a note was actually released. Used on
   *  exit, disable, delete, stop, and panic so state notes never hang. */
  private releaseStateNote(key: string): boolean {
    const timer = this.stateTriggerGateTimers.get(key)
    if (timer) {
      clearTimeout(timer)
      this.stateTriggerGateTimers.delete(key)
    }
    const held = this.stateTriggerHeldNote.get(key)
    if (!held) return false
    this.stateTriggerHeldNote.delete(key)
    this.midiSender.sendNoteOff(held.port, held.channel, held.note)
    return true
  }

  /** Release every held State-Trigger note. Called on stop()/panic. */
  private releaseAllStateNotes(): void {
    for (const key of Array.from(this.stateTriggerHeldNote.keys())) {
      this.releaseStateNote(key)
    }
    // Clear any orphan gate timers too.
    for (const t of this.stateTriggerGateTimers.values()) clearTimeout(t)
    this.stateTriggerGateTimers.clear()
  }

  // ── State Trigger public API (IPC surface) ────────────────────────

  /** Live match scores + active flags (State Triggers) PLUS the current
   *  step + live score of every Pose Sequence, polled by the renderer's
   *  State Triggers / Pose Sequences sections (~10 Hz while expanded).
   *  `seqSteps[key]` === waypoint count means a non-looping phrase has
   *  completed (parked). Keys for both are `${templateId}|${id}`. */
  getStateTriggerLive(): {
    scores: Record<string, number>
    active: Record<string, boolean>
    seqSteps: Record<string, number>
    seqScores: Record<string, number>
  } {
    const scores: Record<string, number> = {}
    const active: Record<string, boolean> = {}
    const seqSteps: Record<string, number> = {}
    const seqScores: Record<string, number> = {}
    this.stateTriggerLive.forEach((v, k) => {
      scores[k] = v
    })
    this.stateTriggerRuntime.forEach((rt, k) => {
      if (rt.active) active[k] = true
    })
    this.poseSequenceLive.forEach((v, k) => {
      seqSteps[k] = v.step
      seqScores[k] = v.score
    })
    return { scores, active, seqSteps, seqScores }
  }

  /** Learn-by-demonstration: collect the device's conditioned stream
   *  for `durationMs`, then reduce to centroid + variance per
   *  (address, slot). Resolves null when nothing was received (device
   *  silent / not bound). One recording at a time — a new call
   *  finalizes the previous one immediately. */
  recordStateTrigger(
    templateId: string,
    stateId: string,
    durationMs: number
  ): Promise<LearnedState | null> {
    if (this.stateRecording) this.finishStateRecording()
    return new Promise((resolve) => {
      const ms = Math.max(250, Math.min(30000, durationMs))
      // Safety timer: finalize even if the stream stops mid-recording
      // (small grace past the window so the packet path usually wins).
      const timer = setTimeout(() => this.finishStateRecording(), ms + 400)
      this.stateRecording = {
        templateId,
        stateId,
        until: Date.now() + ms,
        samples: new Map(),
        finalize: resolve,
        timer
      }
    })
  }

  // ── Motion Loop (v0.6.x) ────────────────────────────────────────
  // Arm the given scene for hardware capture. Frames accumulate in
  // handleHardwareInput until stopMotionLoopRecord() is called. Returns
  // false if the scene doesn't exist.
  startMotionLoopRecord(sceneId: string): boolean {
    if (!this.session) return false
    if (!this.session.scenes.some((s) => s.id === sceneId)) return false
    this.recordingLoop = { sceneId, startMs: Date.now(), frames: new Map() }
    return true
  }

  // Stop capture and hand the buffers back to the renderer, which writes
  // them into the scene's cells (keeping the store authoritative). Loop
  // length = elapsed record time (free-run). Null when nothing captured.
  stopMotionLoopRecord(): {
    sceneId: string
    durationMs: number
    byTrack: Record<string, { t: number; v: number[] }[]>
  } | null {
    const rec = this.recordingLoop
    this.recordingLoop = null
    if (!rec) return null
    const durationMs = Date.now() - rec.startMs
    const byTrack: Record<string, { t: number; v: number[] }[]> = {}
    for (const [trackId, frames] of rec.frames) {
      if (frames.length > 0) byTrack[trackId] = frames
    }
    if (Object.keys(byTrack).length === 0) return null
    return { sceneId: rec.sceneId, durationMs, byTrack }
  }

  // Sample a cell's recorded Motion Loop at the current wall-clock time,
  // returning the per-slot values (linearly interpolated between frames)
  // or null when there's no active loop. Phase is anchored to the active
  // scene's start so the loop restarts cleanly when the scene (re)fires.
  private sampleRecordedLoop(cell: Cell, tNowMs: number): number[] | null {
    const rl = cell.recordedLoop
    if (!rl || !rl.enabled || rl.durationMs <= 0 || rl.frames.length === 0) {
      return null
    }
    if (this.activeSceneStartedAt == null) return null
    let phase = (tNowMs - this.activeSceneStartedAt) % rl.durationMs
    if (phase < 0) phase += rl.durationMs
    const frames = rl.frames
    const last = frames.length - 1
    // Locate the last frame at or before `phase` (binary search).
    let idx = 0
    if (phase <= frames[0].t) {
      idx = 0
    } else if (phase >= frames[last].t) {
      idx = last
    } else {
      let lo = 0
      let hi = last
      while (lo <= hi) {
        const mid = (lo + hi) >> 1
        if (frames[mid].t <= phase) {
          idx = mid
          lo = mid + 1
        } else {
          hi = mid - 1
        }
      }
    }
    const f0 = frames[idx]
    const f1 = frames[Math.min(idx + 1, last)]
    if (f1 === f0 || f1.t <= f0.t) return f0.v
    const a = (phase - f0.t) / (f1.t - f0.t)
    const n = Math.max(f0.v.length, f1.v.length)
    const out: number[] = []
    for (let i = 0; i < n; i++) {
      const v0 = f0.v[i] ?? 0
      const v1 = f1.v[i] ?? v0
      out.push(v0 + (v1 - v0) * a)
    }
    return out
  }

  private finishStateRecording(): void {
    const rec = this.stateRecording
    if (!rec) return
    this.stateRecording = null
    clearTimeout(rec.timer)
    const dims: { address: string; slot: number; enabled?: boolean }[] = []
    const centroid: number[] = []
    const variance: number[] = []
    const addresses = Array.from(rec.samples.keys()).sort()
    for (const address of addresses) {
      const rows = rec.samples.get(address)!
      if (rows.length === 0) continue
      const slotCount = rows.reduce((m, r) => Math.max(m, r.length), 0)
      for (let slot = 0; slot < slotCount; slot++) {
        let n = 0
        let mean = 0
        for (const r of rows) {
          const v = r[slot]
          if (typeof v === 'number' && Number.isFinite(v)) {
            n++
            mean += v
          }
        }
        if (n === 0) continue
        mean /= n
        let varSum = 0
        for (const r of rows) {
          const v = r[slot]
          if (typeof v === 'number' && Number.isFinite(v)) {
            const d = v - mean
            varSum += d * d
          }
        }
        dims.push({ address, slot, enabled: true })
        centroid.push(mean)
        variance.push(varSum / n)
      }
    }
    // Evaluation was frozen for this template while recording (the
    // skip-during-record `continue`). Clear any stale dwell timer on its
    // Pose Sequences so a waypoint that was mid-dwell when Record started
    // can't fire the instant recording ends — force a fresh rising edge.
    const prefix = `${rec.templateId}|`
    for (const [k, rt] of this.poseSequenceRuntime) {
      if (k.startsWith(prefix)) {
        rt.matchSince = 0
        rt.ready = false
      }
    }
    rec.finalize(
      dims.length > 0
        ? // Forgiving defaults out of the box: tolerance 0.3 (wide
          // acceptance band) + threshold 0.6 with the new robust
          // mean-membership score. The user tunes both live via the
          // match meter and can exclude drifty dims.
          { dims, centroid, variance, threshold: 0.6, tolerance: 0.3 }
        : null
    )
  }

  // ── Conditioner scope public API (IPC surface) ────────────────────

  // Poll (and implicitly register/refresh) a scope watch. Returns the
  // watch's ring buffer of {t, raw, cond} samples. Multiple watchers
  // coexist; each is keyed by (templateId, address, slot) and kept
  // alive by polling — stop polling and handleHardwareInput prunes it.
  getConditionerScope(
    watch: { templateId: string; address: string; slot: number } | null,
    windowMs?: number
  ): { t: number; raw: number; cond: number }[] {
    if (!watch) return []
    const key = `${watch.templateId}|${watch.address}|${watch.slot}`
    let w = this.conditionerScopes.get(key)
    if (!w) {
      // Cap the number of concurrent watches — a UI bug spamming fresh
      // keys can't grow this unbounded.
      if (this.conditionerScopes.size >= 32) {
        const oldest = this.conditionerScopes.keys().next().value
        if (oldest !== undefined) this.conditionerScopes.delete(oldest)
      }
      w = {
        templateId: watch.templateId,
        address: watch.address,
        slot: watch.slot,
        lastPollMs: Date.now(),
        buf: []
      }
      this.conditionerScopes.set(key, w)
    }
    w.lastPollMs = Date.now()
    // Ship only the requested time window (bounds IPC regardless of
    // how much history the ring holds). Absent/invalid = whole buffer.
    if (typeof windowMs === 'number' && windowMs > 0 && w.buf.length > 0) {
      const cutoff = Date.now() - windowMs
      // buf is time-ordered; find the first in-window index.
      let i = w.buf.length
      while (i > 0 && w.buf[i - 1].t >= cutoff) i--
      return i > 0 ? w.buf.slice(i) : w.buf
    }
    return w.buf
  }

  /** Clear all hardware catch state. Called on scene change when any
   *  active HW Mode is in 'reset' mode (the default). In 'persist'
   *  mode the catch state survives scene changes so a knob mid-turn
   *  keeps driving the new scene's parameter. */
  private clearHardwareCatchIfReset(): void {
    if (!this.session) return
    // (Bug 4 FIX) Clear ONLY the catches whose track belongs to an
    // enabled reset-mode template. The old code wiped the WHOLE maps as
    // soon as any one template was reset-mode, which also cleared
    // persist-mode templates' catches (their whole point is to survive
    // scene changes). Build the set of reset-mode source-template ids,
    // resolve which tracks descend from them, and delete only those
    // `${trackId}|${slot}` entries.
    const resetTemplateIds = new Set<string>()
    for (const tpl of this.session.pool.templates) {
      const hw = tpl.hardwareMode
      if (hw && hw.enabled && hw.mode === 'reset') resetTemplateIds.add(tpl.id)
    }
    if (resetTemplateIds.size === 0) return
    const resetTrackIds = new Set<string>()
    for (const t of this.session.tracks) {
      if (t.sourceTemplateId && resetTemplateIds.has(t.sourceTemplateId)) {
        resetTrackIds.add(t.id)
      }
    }
    if (resetTrackIds.size === 0) return
    for (const k of Array.from(this.hardwareCaught.keys())) {
      const pipe = k.indexOf('|')
      const trackId = pipe > 0 ? k.slice(0, pipe) : k
      if (resetTrackIds.has(trackId)) this.hardwareCaught.delete(k)
    }
    for (const k of Array.from(this.hardwareOverride.keys())) {
      const pipe = k.indexOf('|')
      const trackId = pipe > 0 ? k.slice(0, pipe) : k
      if (resetTrackIds.has(trackId)) this.hardwareOverride.delete(k)
    }
  }

  /**
   * (Bug 5) Signal that the NEXT `updateSession` carries a freshly
   * LOADED session (file open / autosave restore), so its
   * `hardwareState.caughtByTrack` should prime the engine's catch map
   * exactly once. Called from the session-load IPC handlers in
   * main/index.ts. Every OTHER updateSession (autosave snapshot, undo,
   * in-flight edits) leaves the flag unset and never resurrects
   * just-cleared catches.
   */
  markSessionLoaded(): void {
    this.sessionLoadPending = true
  }

  updateSession(next: Session): void {
    const prevTickRate = this.session?.tickRateHz
    const prevMidiEnabled = this.session?.midiEnabled
    // (Bug 5 FIX) Restore HW catch state from `next.hardwareState` only
    // when a real session LOAD signalled `markSessionLoaded()`. The old
    // `liveMapEmpty` heuristic fired on ANY updateSession whose catch
    // map happened to be empty, so a session push racing a scene-trigger
    // clear could resurrect catches the trigger had just released.
    const restoreHwState = this.sessionLoadPending
    this.sessionLoadPending = false
    this.session = next
    // Refresh the fast-path flag for handleHardwareInput. Cheap to
    // recompute on session updates (a few-dozen templates max), and
    // saves the per-packet filter+allocation when HW Mode is off
    // session-wide — which is the common case.
    this.hasAnyHardwareModeEnabled = next.pool.templates.some(
      (t) => t.hardwareMode?.enabled === true
    )
    // (v0.6.4) Fast-path flag for the Derived Parameter recompute block.
    this.hasAnyDerived = next.pool.templates.some(
      (t) => (t.derivedParams?.length ?? 0) > 0
    )
    // Restore persisted HW catch state on a fresh session load. The
    // override VALUES are not restored — they self-heal on the next
    // OSC packet from the bound device (handleHardwareInput refreshes
    // hardwareOverride every packet). What we restore is the BINARY
    // "this slot is caught" so the renderer's red highlight comes
    // back immediately, and the engine substitutes the HW value
    // (once it arrives) instead of waiting for a fresh re-catch.
    if (restoreHwState && next.hardwareState?.caughtByTrack) {
      const map = next.hardwareState.caughtByTrack
      for (const trackId of Object.keys(map)) {
        const slots = map[trackId] ?? []
        for (const slotIdx of slots) {
          if (Number.isFinite(slotIdx)) {
            this.hardwareCaught.set(`${trackId}|${slotIdx}`, true)
          }
        }
      }
    }
    // (Bug 2 FIX) Drop caught/override entries for any track whose
    // source template's Hardware Mode is missing or DISABLED. Without
    // this, disabling HW Mode (or deleting/disabling its template) left
    // the slot frozen at the last hardware value forever — the emit
    // loop reads hardwareCaught with no enabled-check, and
    // clearHardwareCatchIfReset only runs on scene change when an
    // ENABLED reset template still exists. Recomputed cheaply on every
    // session update so a HW-Mode-off toggle releases its slots at once.
    {
      const hwEnabledTemplateIds = new Set<string>()
      for (const tpl of next.pool.templates) {
        if (tpl.hardwareMode?.enabled === true) hwEnabledTemplateIds.add(tpl.id)
      }
      const hwActiveTrackIds = new Set<string>()
      for (const t of next.tracks) {
        if (t.sourceTemplateId && hwEnabledTemplateIds.has(t.sourceTemplateId)) {
          hwActiveTrackIds.add(t.id)
        }
      }
      for (const k of Array.from(this.hardwareCaught.keys())) {
        const pipe = k.indexOf('|')
        const trackId = pipe > 0 ? k.slice(0, pipe) : k
        if (!hwActiveTrackIds.has(trackId)) this.hardwareCaught.delete(k)
      }
      for (const k of Array.from(this.hardwareOverride.keys())) {
        const pipe = k.indexOf('|')
        const trackId = pipe > 0 ? k.slice(0, pipe) : k
        if (!hwActiveTrackIds.has(trackId)) this.hardwareOverride.delete(k)
      }
    }
    // Propagate the global MIDI on/off to the sender. Flipping off
    // closes every open port (zero CPU); flipping on lets the next
    // emit lazy-open ports as needed.
    if (prevMidiEnabled !== next.midiEnabled) {
      this.midiSender.setEnabled(!!next.midiEnabled)
    }
    // Invalidate the generative similarity matrix on every session
    // update. The matrix is sparse + lazily filled, so re-marking
    // dirty is cheap; the rebuild happens at most once per natural
    // advance (and only when generative mode is on). Avoids tracking
    // per-cell change diffs.
    this.generativeSimDirty = true
    // Drop history entries for scenes that no longer exist so the
    // no-repeat / shuffle-cycle constraints don't lock on phantom
    // scene ids forever. Also prune the rolled-duration map for
    // the same reason -- removed scenes shouldn't keep their last
    // rolled value lingering in engine state.
    if (
      this.generativeHistory.length > 0 ||
      this.generativeRolledBySceneId.size > 0
    ) {
      const sceneIdSet = new Set(next.scenes.map((s) => s.id))
      this.generativeHistory = this.generativeHistory.filter((id) =>
        sceneIdSet.has(id)
      )
      for (const sid of Array.from(this.generativeRolledBySceneId.keys())) {
        if (!sceneIdSet.has(sid)) this.generativeRolledBySceneId.delete(sid)
      }
    }
    // Ensure per-track state exists for each track; drop stale.
    const keep = new Set(next.tracks.map((t) => t.id))
    for (const id of this.tracks.keys()) {
      if (!keep.has(id)) {
        const ts = this.tracks.get(id)
        if (ts?.delayTimer) clearTimeout(ts.delayTimer)
        // Note Off for any held note before forgetting the track.
        const tsRef = this.tracks.get(id)
        if (tsRef) this.sendMidiNoteOff(tsRef)
        this.tracks.delete(id)
      }
    }
    for (const t of next.tracks) {
      if (!this.tracks.has(t.id)) this.tracks.set(t.id, makeTrackState())
    }
    // Prune Hardware Mode state for tracks that no longer exist.
    // `hardwareCaught` / `hardwareOverride` are keyed `${trackId}|${slot}`;
    // delete every entry whose track has been removed. Without this,
    // long sessions with churning tracks leaked these maps forever
    // (each removed track left its slot entries behind).
    for (const k of Array.from(this.hardwareCaught.keys())) {
      const pipe = k.indexOf('|')
      const trackId = pipe > 0 ? k.slice(0, pipe) : k
      if (!keep.has(trackId)) this.hardwareCaught.delete(k)
    }
    for (const k of Array.from(this.hardwareOverride.keys())) {
      const pipe = k.indexOf('|')
      const trackId = pipe > 0 ? k.slice(0, pipe) : k
      if (!keep.has(trackId)) this.hardwareOverride.delete(k)
    }
    // `hardwareLastValues` and `hardwareLastChangeMs` are keyed by
    // device (`${ip}:${port}`), NOT trackId — they cache per-device
    // movement-detection state and are independent of tracks. They
    // only grow when new devices appear; safe to leave across track
    // changes. (Cleared explicitly on session load via stop()/start()
    // if needed.)
    // (v0.6) Prune Input Conditioning + State Trigger runtime for
    // templates/triggers that no longer exist — same leak discipline
    // as the hardware maps above. conditionerState keys are
    // `${tplId}|${deviceKey}|${address}`; trigger keys `${tplId}|${trigId}`.
    {
      const tplIds = new Set(next.pool.templates.map((t) => t.id))
      const trigKeys = new Set<string>()
      const seqKeys = new Set<string>()
      for (const t of next.pool.templates) {
        for (const trg of t.stateTriggers ?? []) {
          trigKeys.add(`${t.id}|${trg.id}`)
        }
        for (const sq of t.poseSequences ?? []) {
          seqKeys.add(`${t.id}|${sq.id}`)
        }
      }
      for (const k of Array.from(this.conditionerState.keys())) {
        const pipe = k.indexOf('|')
        const tplId = pipe > 0 ? k.slice(0, pipe) : k
        if (!tplIds.has(tplId)) this.conditionerState.delete(k)
      }
      for (const k of Array.from(this.stateTriggerRuntime.keys())) {
        if (!trigKeys.has(k)) this.stateTriggerRuntime.delete(k)
      }
      for (const k of Array.from(this.stateTriggerLive.keys())) {
        if (!trigKeys.has(k)) this.stateTriggerLive.delete(k)
      }
      // Release (and stop tracking) any held note whose trigger was
      // deleted while active — otherwise it hangs forever.
      for (const k of Array.from(this.stateTriggerHeldNote.keys())) {
        if (!trigKeys.has(k)) this.releaseStateNote(k)
      }
      for (const k of Array.from(this.stateTriggerGateTimers.keys())) {
        if (!trigKeys.has(k)) {
          const t = this.stateTriggerGateTimers.get(k)
          if (t) clearTimeout(t)
          this.stateTriggerGateTimers.delete(k)
        }
      }
      // Same discipline for Pose Sequences (v0.6.5).
      for (const k of Array.from(this.poseSequenceRuntime.keys())) {
        if (!seqKeys.has(k)) this.poseSequenceRuntime.delete(k)
      }
      for (const k of Array.from(this.poseSequenceLive.keys())) {
        if (!seqKeys.has(k)) this.poseSequenceLive.delete(k)
      }
      for (const k of Array.from(this.poseSequenceHeldNote.keys())) {
        if (!seqKeys.has(k)) this.releaseSeqNote(k)
      }
      for (const k of Array.from(this.poseSequenceGateTimers.keys())) {
        if (!seqKeys.has(k)) {
          const t = this.poseSequenceGateTimers.get(k)
          if (t) clearTimeout(t)
          this.poseSequenceGateTimers.delete(k)
        }
      }
      for (const k of Array.from(this.suppressedSeqKeys)) {
        if (!seqKeys.has(k)) this.suppressedSeqKeys.delete(k)
      }
    }
    // Prune liveValues entries for scenes or tracks that no longer exist.
    // Without this, switching between sessions with lots of scenes over an
    // app lifetime leaks O(scenes × tracks) string entries in `liveValues`
    // — the engine holds refs forever because the emitState loop only
    // writes, never removes when a scene disappears.
    const sceneKeep = new Set(next.scenes.map((s) => s.id))
    for (const sid of Object.keys(this.liveValues)) {
      if (!sceneKeep.has(sid)) {
        delete this.liveValues[sid]
        continue
      }
      const row = this.liveValues[sid]
      for (const tid of Object.keys(row)) {
        if (!keep.has(tid)) delete row[tid]
      }
    }
    // If the currently-active scene was deleted, clear the ref so the
    // engine doesn't keep pointing at a ghost scene. Running cells have
    // already been safely ignored by getActiveCell returning null, but
    // the stale activeSceneId would leak through emitState.
    if (this.activeSceneId && !sceneKeep.has(this.activeSceneId)) {
      this.activeSceneId = null
      this.activeSceneStartedAt = null
      this.activeSequenceSlotIdx = null
      this.activeSceneRepeatCount = 0
      this.clearSceneAdvance()
    }
    // Only restart the tick interval if the rate actually changed. Otherwise
    // rapid session updates (e.g., the user typing in a text field) would
    // tear down and recreate setInterval on every keystroke, which stalls the
    // renderer under load. Don't emitState either — nothing engine-runtime
    // related changed.
    if (prevTickRate !== next.tickRateHz) this.restartTicker()
  }

  setTickRate(hz: number): void {
    if (!this.session) return
    this.session.tickRateHz = clamp(hz, 10, 300)
    this.restartTicker()
  }

  /**
   * Meta Controller live output. Called by the renderer on every interpolated
   * frame (drag, MIDI CC — both tweened renderer-side so the UI and the OSC
   * output match exactly). This method just scales through the knob's curve
   * and fires OSC to every enabled destination. No smoothing is applied here
   * — it's entirely the renderer's responsibility so what you see on the
   * knob is what leaves the socket.
   *
   * Values always go out as floats (`f`) — knob outputs are always numeric.
   */
  sendMetaValue(knobIdx: number, normalizedValue: number): void {
    if (!this.session) return
    if (knobIdx < 0 || knobIdx >= META_KNOB_COUNT) return
    const knob = this.session.metaController?.knobs?.[knobIdx]
    if (!knob) return
    const t = clamp(normalizedValue, 0, 1)
    const scaled = scaleMetaValue(t, knob.min, knob.max, knob.curve)
    for (const d of knob.destinations) {
      if (!d.enabled) continue
      this.sender.send(d.destIp, d.destPort, d.oscAddress, { type: 'f', value: scaled })
    }
  }

  // `morphMsOverride` — when set, this transition uses the given duration
  // in milliseconds instead of the cell's own `transitionMs`. Lets the
  // scene-to-scene Morph feature glide every track in a scene over the
  // same time. null / undefined = use cell's transitionMs as before.
  // `silent` — skip emitState. Callers batching many triggers (scene
  // fire) can emit once at the end instead of N times.
  triggerCell(
    sceneId: string,
    trackId: string,
    morphMsOverride?: number | null,
    silent?: boolean
  ): void {
    if (!this.session) return
    const scene = this.session.scenes.find((s) => s.id === sceneId)
    if (!scene) return
    const cell = scene.cells[trackId]
    if (!cell) return
    const ts = this.tracks.get(trackId)
    if (!ts) return
    // Track may be explicitly disabled from the Instrument Inspector
    // — skip every trigger path so no OSC fires until re-enabled.
    // Disabling a Template (Instrument) also silences its children
    // (their own enabled flag may still be true; parent overrides).
    if (this.isTrackEffectivelyDisabled(trackId)) return

    if (ts.delayTimer) {
      clearTimeout(ts.delayTimer)
      ts.delayTimer = null
    }

    const start = (): void => {
      const curOut = this.computeCurrentOutputs(trackId)
      // Reset sequencer to step 0 + per-mode state on trigger. Done
      // BEFORE the baseRaw lookup below so generative mode's seeded
      // cellRow / PRNG are already populated when we ask for the
      // first step's value.
      ts.seqStepIdx = 0
      ts.seqStepStart = now()
      ts.seqLastStepIdx = -1
      // Cellular: seed the row from cellSeed (0 = single center cell).
      // When the Seed LFO is active, the effective seed is modulated
      // around cellSeed by a slow sine — different cycles get
      // different starting patterns.
      ts.seqCellRow = cellularInitialRow(
        modulatedCellSeed(cell.sequencer, now()),
        cell.sequencer.steps
      )
      // Drift: start at step 0 (matches the visual playhead for the
      // first emitted value).
      ts.seqDriftPos = 0
      // Per-track sequencer PRNG. Seeded from cell.value + seed so a
      // given clip+seed combination is reproducible across triggers.
      ts.seqRng = mulberry32(
        hashSeedString(`${cell.value}|${cell.sequencer.seed}`)
      )
      // Ratchet: not bursting at the start of a clip.
      ts.seqRatchetSubdiv = 1
      ts.seqRatchetSubIdx = 0
      ts.seqRatchetSubStart = now()
      // Reset Hold-mode dedup flag so the first emit after a fresh
      // trigger always sends, regardless of whether the value happens
      // to match a stale lastSentNumeric from a previous play.
      ts.hasEmittedNumeric = false
      // Fresh ramp lifecycle — clear the previous-mode tracker so
      // the first tick after trigger uses the cell's CURRENT mode
      // without thinking it just changed.
      ts.prevRampMode = null
      // Draw + Generative — produce the first variation curve from
      // the user's drawing. Each subsequent cycle wrap re-generates
      // (see per-tick loop). With Generative off, the user's
      // drawValues are used directly and these stay empty.
      ts.drawGenCycle = 0
      if (cell.sequencer.mode === 'draw' && cell.sequencer.generative) {
        ts.drawGeneratedValues = generateDrawCurve(cell, 0)
      } else {
        ts.drawGeneratedValues = []
      }
      // Pre-compute the cycle's per-token value range. Feeds the
      // scaleToUnit auto-range path so output covers [0, 1] based on
      // actual generated values, not blunt clipping.
      ts.seqGenRanges = computeCycleRanges(cell, ts)
      // Target centres at step 0 — same path the per-tick loop uses.
      const baseRaw = resolveStepBaseRaw(cell, ts, 0, 0, 1)
      const rawTargets = numericBasesFromRaw(baseRaw)
      const targets = cell.scaleToUnit ? rawTargets.map((v) => clamp01(v)) : rawTargets
      // Pad from/to to the same length so element-wise interpolation is clean.
      const len = Math.max(curOut.length, targets.length)
      ts.fromCenter = pad(curOut, len, 0)
      ts.toCenter = pad(targets, len, 0)
      ts.morphStart = now()
      // Timing section can be disabled per-cell. When `timingEnabled`
      // is false, ignore the stored transition (treat as 0) so the
      // user can collapse + bypass the section without zeroing the
      // values. A scene-trigger `morphMsOverride` still wins.
      const effectiveTransition =
        cell.timingEnabled === false ? 0 : cell.transitionMs
      ts.morphMs =
        typeof morphMsOverride === 'number' && morphMsOverride >= 0
          ? morphMsOverride
          : effectiveTransition
      ts.activeSceneId = sceneId
      ts.armed = true
      ts.stopping = false
      // Reset LFO phase + envelope clock on every trigger so modulation shapes
      // restart cleanly from their t=0 value.
      ts.phase = 0
      ts.triggerTime = now()
      // Reset stepped-random state so a fresh random value fires at
      // trigger. Use the per-track seqRng (deterministic from the
      // cell's value seed) instead of Math.random() so two triggers
      // of the same cell with the same seed produce identical
      // modulator trajectories — the rest of the modulator state
      // tries to be reproducible and Math.random() defeated that.
      const seedRng = ts.seqRng ?? Math.random
      ts.rndStepLastTick = -1
      ts.rndStepValue = seedRng() * 2 - 1
      ts.rndSmoothPrev = 0
      ts.rndSmoothNext = seedRng() * 2 - 1
      // Reset arp: start index depends on mode (Down starts at the top, etc.).
      ts.arpPatternIdx = 0
      ts.arpStepIdx = arpStartStep(cell.modulation.arpeggiator)
      ts.arpLastAdvanceAt = now()
      // Seed the Random Generator's PRNG from the cell's Value so the same
      // Value produces a reproducible stream. Fire the first sample now,
      // with one draw per whitespace-separated entry (3 per entry for colour).
      ts.randRng = mulberry32(hashSeedString(cell.value))
      ts.randLastAdvanceAt = now()
      {
        const initCount = Math.max(1, parseValueTokens(cell.value).length)
        ts.randCurrent = sampleRandom(ts.randRng, cell.modulation.random, initCount)
      }
      // Fresh S&H sample at trigger so the first tick has a real value
      // rather than zero (avoids a dead-air slot on the downbeat).
      // seqRng (cell-seed-driven) keeps these reproducible across
      // re-triggers — same as rndStep/rndSmooth above. Distribution
      // skew honoured here too so the very first sample respects the
      // user's centre-hug / edge-weight setting.
      {
        const shDist = cell.modulation.sh.distribution
        const seedDraw = seedRng()
        const u = shDist !== undefined && shDist !== 0.5 ? warpDistribution(seedDraw, shDist) : seedDraw
        ts.shHeld = u * 2 - 1
      }
      ts.shPrev = 0
      ts.shLastAdvanceAt = now()
      // Slew: start at current center target to avoid a pop, pick a new
      // random target immediately so motion is audible.
      ts.slewValue = 0
      ts.slewTarget = seedRng() * 2 - 1
      ts.slewLastAdvanceAt = now()
      // Chaos: seed close to 0.5 with a small per-trigger jitter so two
      // adjacent cells running the same settings produce different
      // trajectories. Values exactly at 0 or 1 are fixed points; keep
      // clear of both.
      ts.chaosX = 0.1 + seedRng() * 0.8
      ts.chaosLastAdvanceAt = now()
      // Routing per-slot Variation factors — stable random in [-1, 1]
      // sampled once per trigger from the seqRng so each clip's slot
      // characters are reproducible. The actual scale (× variation%)
      // happens in the per-slot emit loop. Sized to the cell's arg
      // count so the array indices line up with `cell.routing.variations`.
      {
        const trackForSlots = this.session?.tracks.find((tt) => tt.id === trackId)
        const slotCount = Math.max(
          1,
          trackForSlots?.argSpec?.length ?? parseValueTokens(cell.value).length
        )
        const factors: number[] = new Array(slotCount)
        for (let i = 0; i < slotCount; i++) factors[i] = seedRng() * 2 - 1
        ts.routingVariationFactors = factors
      }
      // Strange Attractor: reseed near a known chaotic-band starting
      // point with a tiny per-trigger jitter (so identical cells
      // diverge after a few seconds). Each attractor type has its
      // own preferred inner-region seed.
      {
        const ap = cell.modulation.attractor
        const jitter = (): number => (seedRng() - 0.5) * 0.2
        switch (ap?.type ?? 'lorenz') {
          case 'aizawa':
            ts.attractorRawX = 0.1 + jitter()
            ts.attractorRawY = jitter()
            ts.attractorRawZ = 0.01 + jitter() * 0.5
            ts.attractorRawW = 0
            break
          case 'thomas':
            ts.attractorRawX = 0.5 + jitter()
            ts.attractorRawY = 0.5 + jitter()
            ts.attractorRawZ = 0.5 + jitter()
            ts.attractorRawW = 0
            break
          case 'rossler':
            ts.attractorRawX = 0.1 + jitter()
            ts.attractorRawY = jitter()
            ts.attractorRawZ = jitter()
            ts.attractorRawW = 0
            break
          case 'rossler4d':
            ts.attractorRawX = 0.5 + jitter()
            ts.attractorRawY = jitter()
            ts.attractorRawZ = jitter()
            ts.attractorRawW = jitter()
            break
          case 'lu4d':
            ts.attractorRawX = 0.5 + jitter()
            ts.attractorRawY = 0.5 + jitter()
            ts.attractorRawZ = 0.5 + jitter()
            ts.attractorRawW = jitter()
            break
          default:
            // lorenz
            ts.attractorRawX = 1 + jitter()
            ts.attractorRawY = 1 + jitter()
            ts.attractorRawZ = 1 + jitter()
            ts.attractorRawW = 0
            break
        }
        ts.attractorX = 0.5
        ts.attractorY = 0.5
        ts.attractorZ = 0.5
        ts.attractorW = 0.5
        ts.attractorSpeed = 0
        ts.attractorLastUpdateMs = 0
      }
      // ── Mod 2 trigger reseed ────────────────────────────────────
      // Same reseed pattern as Mod 1 above, but writing into ts.m2.
      // Mod 2 has its own PRNG so consuming its random stream doesn't
      // affect Mod 1's reproducibility. Seeded from a derived string
      // (cell.value + '_m2') so the seed still rides the cell's
      // identity — same Value produces the same Mod 2 trajectory on
      // re-trigger, but it's independent of Mod 1's RNG.
      {
        const m2 = ts.m2
        m2.rng = mulberry32(hashSeedString(cell.value + '_m2'))
        const rngM2 = m2.rng
        m2.phase = 0
        m2.rndStepLastTick = -1
        m2.rndStepValue = rngM2() * 2 - 1
        m2.rndSmoothPrev = 0
        m2.rndSmoothNext = rngM2() * 2 - 1
        const m2Cfg = cell.modulation2
        const shDist2 = m2Cfg?.sh.distribution
        const seedDraw2 = rngM2()
        const u2 =
          shDist2 !== undefined && shDist2 !== 0.5
            ? warpDistribution(seedDraw2, shDist2)
            : seedDraw2
        m2.shHeld = u2 * 2 - 1
        m2.shPrev = 0
        m2.shLastAdvanceAt = now()
        m2.slewValue = 0
        m2.slewTarget = rngM2() * 2 - 1
        m2.slewLastAdvanceAt = now()
        m2.chaosX = 0.1 + rngM2() * 0.8
        m2.chaosLastAdvanceAt = now()
        // Random — fire a fresh sample at trigger so the first emit
        // has a real value rather than 0. Honour distribution warp
        // if set.
        {
          const randDist2 = m2Cfg?.random.distribution
          const rDraw = rngM2()
          const rU =
            randDist2 !== undefined && randDist2 !== 0.5
              ? warpDistribution(rDraw, randDist2)
              : rDraw
          m2.randCurrent = rU * 2 - 1
          m2.randLastAdvanceAt = now()
        }
        // Arpeggiator — start at the mode-appropriate first step
        // (Up at 0, Down at N-1, etc.) so the first advance fires
        // from a musical position rather than a stale leftover.
        // Pass Mod 2's seeded RNG so the 'random' arp mode reseed
        // is reproducible across re-triggers of the same cell.
        if (m2Cfg) {
          m2.arpPatternIdx = 0
          m2.arpStepIdx = arpStartStep(m2Cfg.arpeggiator, rngM2)
          m2.arpLastAdvanceAt = now()
        }
        // Strange Attractor — reseed near the chaotic band for Mod
        // 2's chosen attractor type. Same per-type seeds as Mod 1.
        const ap2 = m2Cfg?.attractor
        const jitter2 = (): number => (rngM2() - 0.5) * 0.2
        switch (ap2?.type ?? 'lorenz') {
          case 'aizawa':
            m2.attractorRawX = 0.1 + jitter2()
            m2.attractorRawY = jitter2()
            m2.attractorRawZ = 0.01 + jitter2() * 0.5
            m2.attractorRawW = 0
            break
          case 'thomas':
            m2.attractorRawX = 0.5 + jitter2()
            m2.attractorRawY = 0.5 + jitter2()
            m2.attractorRawZ = 0.5 + jitter2()
            m2.attractorRawW = 0
            break
          case 'rossler':
            m2.attractorRawX = 0.1 + jitter2()
            m2.attractorRawY = jitter2()
            m2.attractorRawZ = jitter2()
            m2.attractorRawW = 0
            break
          case 'rossler4d':
            m2.attractorRawX = 0.5 + jitter2()
            m2.attractorRawY = jitter2()
            m2.attractorRawZ = jitter2()
            m2.attractorRawW = jitter2()
            break
          case 'lu4d':
            m2.attractorRawX = 0.5 + jitter2()
            m2.attractorRawY = 0.5 + jitter2()
            m2.attractorRawZ = 0.5 + jitter2()
            m2.attractorRawW = jitter2()
            break
          default:
            m2.attractorRawX = 1 + jitter2()
            m2.attractorRawY = 1 + jitter2()
            m2.attractorRawZ = 1 + jitter2()
            m2.attractorRawW = 0
            break
        }
        m2.attractorX = 0.5
        m2.attractorY = 0.5
        m2.attractorZ = 0.5
        m2.attractorW = 0.5
        m2.attractorSpeed = 0
        m2.attractorLastUpdateMs = 0
      }
      ts.lastSentString = null
      ts.lastStringAtSceneId = null
      ts.lastStringAtStep = -1
      if (!silent) this.emitState()
    }

    // Honour `timingEnabled`: when false, skip the delay even if a
    // non-zero `delayMs` is stored (collapsed Timing section =
    // bypass). When true the stored value applies as before.
    const effectiveDelay = cell.timingEnabled === false ? 0 : cell.delayMs
    if (effectiveDelay > 0) {
      ts.delayTimer = setTimeout(() => {
        ts.delayTimer = null
        start()
      }, effectiveDelay)
    } else {
      start()
    }
  }

  stopCell(sceneId: string, trackId: string): void {
    const ts = this.tracks.get(trackId)
    if (!ts || !this.session) return
    // Only stop if this cell is actually the active one for the track.
    if (ts.activeSceneId !== sceneId) return
    this.beginStop(trackId)
  }

  // `silent` suppresses the per-call emitState() — the caller is
  // responsible for emitting once after batching multiple beginStops
  // (e.g. scene-level orphan fade). Keeps IPC volume bounded no matter
  // how many tracks are involved in the morph.
  private beginStop(
    trackId: string,
    morphMsOverride?: number,
    silent?: boolean
  ): void {
    const ts = this.tracks.get(trackId)
    if (!ts || !this.session) return
    if (ts.delayTimer) {
      clearTimeout(ts.delayTimer)
      ts.delayTimer = null
    }
    const cell = this.getActiveCell(trackId)
    const curOut = this.computeCurrentOutputs(trackId)
    ts.fromCenter = [...curOut]
    ts.toCenter = curOut.map(() => 0)
    ts.morphStart = now()
    // Morph override lets the scene-to-scene Morph feature fade orphan
    // tracks out over the same duration the new tracks fade in.
    ts.morphMs =
      typeof morphMsOverride === 'number' && morphMsOverride >= 0
        ? morphMsOverride
        : cell?.transitionMs ?? 0
    ts.stopping = true
    if (!silent) this.emitState()
  }

  stopScene(sceneId: string): void {
    if (!this.session) return
    // Stop any track whose active cell is currently in this scene — silent
    // per-track, single emit at the end.
    for (const [tid, ts] of this.tracks.entries()) {
      if (ts.armed && ts.activeSceneId === sceneId) {
        this.beginStop(tid, undefined, /* silent */ true)
      }
    }
    if (this.activeSceneId === sceneId) {
      this.activeSceneId = null
      this.activeSceneStartedAt = null
      this.activeSequenceSlotIdx = null
      this.clearSceneAdvance()
    }
    this.emitState()
  }

  pauseSequence(): void {
    // Freeze auto-advance without stopping cells. Cells keep
    // playing/modulating, but the active scene's elapsed time stops
    // accumulating (we mark pauseStartedAt; on resume we offset
    // activeSceneStartedAt by the pause duration). The renderer's
    // countdown reads activeSceneStartedAt and the pause flag, so
    // freezing on this side is enough to also freeze the visual
    // remaining-time display.
    this.clearSceneAdvance()
    if (this.activeSceneStartedAt !== null && this.pauseStartedAt === null) {
      this.pauseStartedAt = Date.now()
      this.emitState()
    }
  }

  resumeSequence(): void {
    if (!this.session) return
    // Apply the pause-shift: activeSceneStartedAt += (now - pauseStartedAt)
    // so elapsed picks up exactly where it left off.
    if (this.pauseStartedAt !== null && this.activeSceneStartedAt !== null) {
      const pauseDur = Date.now() - this.pauseStartedAt
      this.activeSceneStartedAt += pauseDur
    }
    this.pauseStartedAt = null
    // Re-arm from the current active scene's full duration (simple approach).
    const id = this.activeSceneId
    if (!id) {
      this.emitState()
      return
    }
    const scene = this.session.scenes.find((s) => s.id === id)
    if (scene) this.armSceneAdvance(scene)
    this.emitState()
  }

  // `opts.morphMs` — when set, every cell in the scene morphs over this
  // duration (ms) instead of its own transitionMs. Tracks that were active
  // in the previous scene but have no cell in this new scene will ALSO
  // fade out over the same duration, so the whole sonic picture glides
  // from scene-A's state into scene-B's state in lockstep.
  // `opts.sourceSlotIdx` — when the trigger originated from a specific
  // slot in the Sequence grid (1..9 / 0 hotkey, follow-action advance,
  // slot-click), pass the slot index. The Sequence view uses it to
  // highlight ONLY that instance of the scene in the grid, even when
  // the scene is placed multiple times.
  triggerScene(
    sceneId: string,
    opts?: {
      morphMs?: number
      sourceSlotIdx?: number | null
      // v0.5.10 -- when the generative selector picks this scene, it
      // overrides the scene's authored durationSec for this play so
      // the auto-advance timer respects the min/max duration window.
      // Manual triggers (Cue/GO, scene clicks, MIDI, kbd, palette)
      // never pass this -- they keep the scene's own duration so the
      // user-precise trigger feels precise.
      generativeDurationSec?: number
    }
  ): void {
    if (!this.session) return
    const scene = this.session.scenes.find((s) => s.id === sceneId)
    if (!scene) return
    const morphMs = opts?.morphMs
    const useMorph = typeof morphMs === 'number' && morphMs >= 0

    // Orphan stop — tracks that were playing a cell from the PREVIOUS
    // scene but have no cell in the new scene. Ableton Session View
    // convention: new scene fires mean the OLD scene's other cells stop,
    // period. Previous build only did this in Morph mode; everything
    // else let a looping clip drone on forever unless the user manually
    // stopped it. Morph time (when set) becomes the fade duration;
    // without Morph, each cell falls back to its own transitionMs.
    // Silent so the per-track emitState doesn't fan out into N IPCs;
    // coalesced emit lands at the end of this method.
    {
      const newTrackIds = new Set(Object.keys(scene.cells))
      for (const [trackId, ts] of this.tracks.entries()) {
        if (ts.armed && !newTrackIds.has(trackId)) {
          this.beginStop(
            trackId,
            useMorph ? morphMs : undefined,
            /* silent */ true
          )
        }
      }
    }

    // If this is the SAME scene as what's already active, we're here via a
    // loop follow-action or a multiplicator-driven internal repeat — bump
    // the repeat counter. Otherwise reset to 1 (fresh play).
    if (this.activeSceneId === sceneId) this.activeSceneRepeatCount += 1
    else this.activeSceneRepeatCount = 1
    // Hardware Mode catch lifecycle — on a NEW scene (id changed),
    // clear catch state if any active template is in 'reset' mode
    // (default). 'persist'-mode templates keep their catch across
    // scene boundaries so the user can mid-turn a knob through a
    // scene change without losing override.
    if (this.activeSceneId !== sceneId) {
      this.clearHardwareCatchIfReset()
    }
    for (const trackId of Object.keys(scene.cells)) {
      // Silent per-cell emits — one coalesced emit happens after the
      // loop. Keeps IPC volume + renderer reconciliation bounded.
      this.triggerCell(
        sceneId,
        trackId,
        useMorph ? morphMs : undefined,
        /* silent */ true
      )
    }
    this.activeSceneId = sceneId
    this.activeSceneStartedAt = Date.now()
    // If the caller passed a specific slot, use it; otherwise clear
    // (palette / column / MIDI / cue triggers aren't tied to a slot).
    this.activeSequenceSlotIdx =
      typeof opts?.sourceSlotIdx === 'number' ? opts.sourceSlotIdx : null
    // Push to the Generative history ring buffer when generative mode
    // is enabled. Tracks BOTH manual triggers AND auto-advances so
    // the no-repeat / shuffle-cycle constraints respect every play,
    // not just the selector's picks. Capped at GENERATIVE_HISTORY_LEN.
    if (this.session.generative?.enabled === true) {
      this.generativeHistory.push(sceneId)
      while (this.generativeHistory.length > GENERATIVE_HISTORY_LEN) {
        this.generativeHistory.shift()
      }
    }
    // Auto-roll a min/max duration under generative mode (v0.5.10).
    // When the caller doesn't pass an explicit generativeDurationSec
    // (Play button, scene click, Cue/GO, MIDI scene trigger, kbd
    // 1-0/Space all skip it), generate one from session.generative.
    // {min,max}DurationMs so the FIRST scene played after flipping
    // Generative ON respects the duration window immediately. The
    // selector's own picks already pass an explicit value; this
    // bridges the "manual entry into generative flow" case.
    let effectiveGenerativeDurationSec = opts?.generativeDurationSec
    if (
      effectiveGenerativeDurationSec === undefined &&
      this.session.generative?.enabled === true
    ) {
      const cfg = this.session.generative
      const minMs = Math.min(cfg.minDurationMs, cfg.maxDurationMs)
      const maxMs = Math.max(cfg.minDurationMs, cfg.maxDurationMs)
      effectiveGenerativeDurationSec =
        (minMs + Math.random() * (maxMs - minMs)) / 1000
    }
    // Per-scene rolled-duration tracking (v0.5.10). Each time the
    // engine triggers a scene under generative mode with a rolled
    // duration, stash it under that sceneId. The Scene Inspector
    // reads from this map to overlay the rolled value on whichever
    // scene the user has focused -- so they can switch between
    // scenes and see each one's last-rolled Dur without needing
    // the scene to be the currently-active one.
    if (typeof effectiveGenerativeDurationSec === 'number') {
      this.generativeRolledBySceneId.set(
        sceneId,
        Math.round(effectiveGenerativeDurationSec * 1000)
      )
    }
    this.armSceneAdvance(scene, effectiveGenerativeDurationSec)
    this.emitState()
  }

  private armSceneAdvance(scene: Scene, generativeDurationSec?: number): void {
    this.clearSceneAdvance()
    // Capture the scene's id, NOT the scene object itself, so that edits
    // made while the duration timer is ticking (user changes nextMode,
    // multiplicator, or duration via the UI — which replaces this.session
    // via updateSession) are actually respected by the follow-action.
    // Prior bug: once A -> B ping-pong started, switching A's nextMode to
    // "stop" had no effect because the still-scheduled timer held a
    // reference to A's OLD data.
    const sceneId = scene.id
    // Per-slot duration override — if the scene was triggered from a
    // specific sequence slot AND that slot has its own duration set,
    // use it. Otherwise fall back to the scene's own durationSec. Lets
    // the same Scene play with different durations in different slots.
    const slotIdx = this.activeSequenceSlotIdx
    const slotOverride =
      slotIdx !== null
        ? this.session?.sequenceSlotOverrides?.[slotIdx]
        : undefined
    // Precedence (highest wins):
    //   1. generativeDurationSec  (this play was picked by the
    //      Generative selector -- rolled fresh from [min, max])
    //   2. slot override          (per-slot duration set by the user
    //      on the Sequence view)
    //   3. scene's own durationSec
    const effectiveDuration =
      typeof generativeDurationSec === 'number' &&
      Number.isFinite(generativeDurationSec)
        ? generativeDurationSec
        : slotOverride?.durationSec !== undefined &&
            Number.isFinite(slotOverride.durationSec)
          ? slotOverride.durationSec
          : scene.durationSec
    this.sceneAdvanceTimer = setTimeout(() => {
      // Re-fetch the current version of this scene off the live session.
      const cur =
        this.session?.scenes.find((s) => s.id === sceneId) ?? null
      if (!cur) return
      // Multiplicator gate — if the scene hasn't yet played the requested
      // number of times, re-trigger itself (counter bumps in triggerScene)
      // before the real follow action fires. Applies to every mode: stop
      // with mult=3 plays 3x then stops; next with mult=2 plays 2x then
      // advances; loop is unchanged (it already re-triggers forever).
      const mult = Math.max(1, Math.floor(cur.multiplicator || 1))
      if (this.activeSceneRepeatCount < mult) {
        // Preserve the slot index so the Sequence view's per-slot
        // progress bar restarts cleanly on the SAME slot instead of
        // disappearing for the duration of the repeat (same issue as
        // the 'loop' case fixed elsewhere).
        this.triggerScene(cur.id, { sourceSlotIdx: slotIdx })
        return
      }
      // Per-slot follow-action override — same slot lookup pattern as
      // the duration. Lets two placements of the same scene have
      // different follow actions (e.g. first instance loops back,
      // second instance stops). The lookup happens at timer-fire time
      // so live UI edits to the override take effect on the next
      // play, not the current one.
      const liveOverride =
        slotIdx !== null
          ? this.session?.sequenceSlotOverrides?.[slotIdx]
          : undefined
      const effectiveNextMode = liveOverride?.nextMode ?? cur.nextMode
      // Generative override (v0.5.10): when generative is ON, the
      // scene's authored nextMode is ignored -- the selector picks
      // the next scene unconditionally. Without this, a scene with
      // nextMode='stop' (the default!) would stop the engine after
      // its first play instead of advancing into generative flow.
      // Loop is still respected when set per-slot (slot override
      // wins) so the user can pin one slot to loop under generative.
      const generativeOn = this.session?.generative?.enabled === true
      if (effectiveNextMode === 'stop' && !generativeOn) {
        // Stop now *actually* stops everything. Previously the engine kept
        // the scene "alive" as long as any cell had modulation or sequencer
        // enabled — useful in theory, but the user's intent with Stop is
        // "end the scene here." Morph every active cell back to 0 over its
        // own transitionMs and clear the active-scene state.
        this.stopScene(cur.id)
      } else {
        this.advanceScene(cur, effectiveNextMode)
      }
    }, Math.max(10, effectiveDuration * 1000))
  }

  private sceneHasOngoingActivity(sceneId: string): boolean {
    if (!this.session) return false
    const scene = this.session.scenes.find((s) => s.id === sceneId)
    if (!scene) return false
    for (const [trackId, ts] of this.tracks.entries()) {
      if (ts.armed && ts.activeSceneId === sceneId) {
        const cell = scene.cells[trackId]
        if (cell?.modulation.enabled || cell?.sequencer.enabled) return true
      }
    }
    return false
  }

  private clearSceneAdvance(): void {
    if (this.sceneAdvanceTimer) {
      clearTimeout(this.sceneAdvanceTimer)
      this.sceneAdvanceTimer = null
    }
  }

  // ── Generative Scene Sequencer: similarity matrix lazy build ──────
  // Walks every track × scene pair ONCE and fills the matrix. Cost is
  // O(scenes^2 × tracks × avg-tokens-per-cell) -- typically <1 ms for
  // a 30-scene × 30-track session. Only runs when the matrix is dirty
  // AND the current advance actually needs a row (selector requests
  // sim[currentSceneId]). Avoids rebuilding on every cell edit.
  private ensureGenerativeSimilarity(): void {
    if (!this.generativeSimDirty) return
    if (!this.session) return
    const scenes = this.session.scenes
    const tracks = this.session.tracks
    this.generativeSimilarity = new Map<string, Map<string, number>>()
    // Pre-parse every (sceneId, trackId) -> token-vector so the
    // pairwise loop reads from a cache instead of re-tokenizing the
    // same cell string for every comparison.
    const cellTokens = new Map<string, number[] | null>()
    const cellActive = new Map<string, boolean>()
    for (const sc of scenes) {
      for (const tr of tracks) {
        const key = `${sc.id}|${tr.id}`
        const cell = sc.cells[tr.id]
        if (!cell) {
          cellActive.set(key, false)
          cellTokens.set(key, null)
          continue
        }
        const trimmed = cell.value.trim()
        cellActive.set(key, trimmed.length > 0)
        if (trimmed.length === 0) {
          cellTokens.set(key, null)
          continue
        }
        // Parse each whitespace-separated token. Non-numeric tokens
        // (e.g. OCTOCOSME's `compositor` protocol prefix, or string
        // labels) get filtered out via Number.isFinite -- they don't
        // contribute to similarity arithmetic. The resulting vector
        // may be empty if every token is non-numeric; that case is
        // handled in cellSimilarityFromTokens.
        const numeric: number[] = []
        for (const tok of trimmed.split(/\s+/)) {
          const n = parseFloat(tok)
          if (Number.isFinite(n)) numeric.push(n)
        }
        cellTokens.set(key, numeric.length > 0 ? numeric : null)
      }
    }
    // Fill the full symmetric matrix. sim[A][B] === sim[B][A] so we
    // could halve the work, but the constant factor isn't worth the
    // bookkeeping for sessions this small. Diagonal entry (A === B)
    // is always 1.0.
    for (const a of scenes) {
      const row = new Map<string, number>()
      for (const b of scenes) {
        if (a.id === b.id) {
          row.set(b.id, 1)
          continue
        }
        let trackScoreSum = 0
        let trackScoreCount = 0
        for (const tr of tracks) {
          const aActive = cellActive.get(`${a.id}|${tr.id}`) === true
          const bActive = cellActive.get(`${b.id}|${tr.id}`) === true
          if (!aActive && !bActive) {
            trackScoreSum += 1 // matched silence
            trackScoreCount += 1
            continue
          }
          if (aActive !== bActive) {
            trackScoreSum += 0 // one active, one not
            trackScoreCount += 1
            continue
          }
          // Both active -- compare token vectors element-wise.
          const aTok = cellTokens.get(`${a.id}|${tr.id}`) ?? null
          const bTok = cellTokens.get(`${b.id}|${tr.id}`) ?? null
          trackScoreSum += cellSimilarityFromTokens(aTok, bTok)
          trackScoreCount += 1
        }
        row.set(b.id, trackScoreCount > 0 ? trackScoreSum / trackScoreCount : 1)
      }
      this.generativeSimilarity.set(a.id, row)
    }
    this.generativeSimDirty = false
  }

  // ── Generative Scene Sequencer: pick the next scene ───────────────
  // Returns the next scene id under generative mode, or null when the
  // pool is empty (no eligible scenes). Reads:
  //   - session.generative (config: pool source, mode/affinity knobs,
  //     no-repeat, shuffleCycle, weights via scene.weight)
  //   - generativeHistory (recent plays)
  //   - generativeSimilarity (lazy-built when Affinity != 0)
  private pickGenerativeScene(currentSceneId: string): string | null {
    if (!this.session) return null
    const cfg = this.session.generative
    if (!cfg || !cfg.enabled) return null
    // Build eligible pool: scenes that exist, not explicitly excluded,
    // and (when poolSource === 'timeline') currently present in the
    // sequence array. We materialize an array so we can iterate
    // multiple times without rebuilding the filter.
    let pool: Scene[] = this.session.scenes.filter(
      (s) => cfg.excluded[s.id] !== true
    )
    if (cfg.poolSource === 'timeline') {
      const inTimeline = new Set(
        (this.session.sequence ?? []).filter(
          (id): id is string => typeof id === 'string'
        )
      )
      pool = pool.filter((s) => inTimeline.has(s.id))
    }
    if (pool.length === 0) return null
    if (pool.length === 1) return pool[0].id
    // No-immediate-repeat: drop the current scene from the pool when
    // the toggle is on AND removing it still leaves at least one
    // candidate. Lone-scene pools fall through (the user clearly
    // wants the same scene every time).
    let candidates = pool
    if (cfg.noRepeat) {
      const filtered = pool.filter((s) => s.id !== currentSceneId)
      if (filtered.length > 0) candidates = filtered
    }
    // Shuffle Cycle: every scene in the eligible pool must play once
    // before any repeat. Track the "already played this cycle" set
    // by scanning generativeHistory back until we hit an entry NOT
    // in the eligible pool (that's the marker of a previous cycle's
    // end) OR we've covered the whole pool. Reset is automatic:
    // when all eligible scenes are in the recent history, drop them
    // all and start fresh.
    if (cfg.shuffleCycle) {
      const eligibleSet = new Set(candidates.map((s) => s.id))
      const playedThisCycle = new Set<string>()
      for (let i = this.generativeHistory.length - 1; i >= 0; i--) {
        const id = this.generativeHistory[i]
        if (!eligibleSet.has(id)) break
        playedThisCycle.add(id)
        // Stop once we've covered every eligible scene -- earlier
        // history is from prior cycles and shouldn't constrain
        // current picks.
        if (playedThisCycle.size >= eligibleSet.size) break
      }
      if (playedThisCycle.size >= eligibleSet.size) {
        // Cycle complete -- reset (allow every scene again).
      } else {
        const remaining = candidates.filter((s) => !playedThisCycle.has(s.id))
        if (remaining.length > 0) candidates = remaining
      }
    }
    if (candidates.length === 0) return null
    if (candidates.length === 1) return candidates[0].id
    // Compute affinity-biased weights. |affinity|/100 maps to an
    // exponent in [0, 4] applied to similarity^exp. Positive
    // affinity = bias toward similar (high sim values amplified);
    // negative affinity = bias toward DISSIMILAR (we invert the
    // similarity via 1 - sim). Affinity = 0 reduces to pure weight-
    // based pick.
    const affinity = cfg.affinity ?? 0
    const exp = (Math.abs(affinity) / 100) * 4
    let simRow: Map<string, number> | undefined
    if (exp > 0) {
      this.ensureGenerativeSimilarity()
      simRow = this.generativeSimilarity.get(currentSceneId)
    }
    // Repetition penalty: each scene in the recent history (excluding
    // the absolute newest, which the noRepeat clause already handled)
    // gets a weight shrink proportional to its recency. The freshest
    // history entries cut weight by 50%; older entries by less.
    const recencyPenalty = new Map<string, number>()
    const histLen = this.generativeHistory.length
    for (let i = 0; i < histLen; i++) {
      const id = this.generativeHistory[i]
      // Newest entry (last in array) gets the strongest penalty.
      const recency = (i + 1) / histLen // 0..1, newer = higher
      const penalty = 0.5 * recency // newest: 0.5, oldest: ~0
      const prev = recencyPenalty.get(id) ?? 0
      // Stack penalty for repeat appearances: a scene that played
      // twice in the history window gets BOTH penalties combined
      // (capped at 0.95 so its weight never collapses entirely).
      recencyPenalty.set(id, Math.min(0.95, prev + penalty))
    }
    const weights: number[] = new Array(candidates.length)
    let totalWeight = 0
    for (let i = 0; i < candidates.length; i++) {
      const s = candidates[i]
      // Base weight (1..10), clamped + defaulted for back-compat.
      let w =
        typeof s.weight === 'number' && Number.isFinite(s.weight)
          ? Math.max(SCENE_WEIGHT_MIN, Math.min(SCENE_WEIGHT_MAX, s.weight))
          : SCENE_WEIGHT_DEFAULT
      // Affinity bias.
      if (exp > 0 && simRow) {
        const sim = simRow.get(s.id) ?? 0
        const biased = affinity > 0 ? sim : 1 - sim
        // Add a tiny floor (0.01) so an exactly-zero biased value
        // doesn't permanently zero out the candidate -- the user
        // still has a sliver of variety even at max affinity.
        w *= Math.pow(biased + 0.01, exp)
      }
      // Repetition penalty.
      const pen = recencyPenalty.get(s.id) ?? 0
      w *= 1 - pen
      // Floor to avoid totalWeight===0 in extreme cases.
      if (!Number.isFinite(w) || w < 0) w = 0
      weights[i] = w
      totalWeight += w
    }
    if (totalWeight <= 0) {
      // Every candidate ended up at weight 0 (extreme penalty +
      // bias). Fall back to uniform random over candidates so we
      // never return null when there ARE eligible scenes.
      return candidates[Math.floor(Math.random() * candidates.length)].id
    }
    // Weighted random pick.
    const target = Math.random() * totalWeight
    let acc = 0
    for (let i = 0; i < candidates.length; i++) {
      acc += weights[i]
      if (acc >= target) return candidates[i].id
    }
    // Floating-point fallthrough (shouldn't happen but be safe).
    return candidates[candidates.length - 1].id
  }

  private advanceScene(current: Scene, modeOverride?: Scene['nextMode']): void {
    if (!this.session) return
    // ── Generative Scene Sequencer early-out (v0.5.10) ────────────
    // When generative mode is on, bypass EVERY follow action --
    // including Loop -- and let the selector pick the next scene
    // from the weighted pool. Manual triggers (Cue/GO, scene clicks,
    // MIDI scene triggers, keyboard 1-0/Space) funnel through
    // triggerScene() so the user can preempt at any time; the
    // engine auto-rolls a fresh min/max duration for those too.
    // If the user wants a specific scene to loop, the answer is to
    // either turn Generative off OR add only that scene to the
    // generative pool (the no-repeat clause auto-disables when the
    // pool is size-1, so the scene plays forever).
    if (this.session.generative?.enabled === true) {
      const pickedId = this.pickGenerativeScene(current.id)
      if (pickedId) {
        // Roll a fresh duration in [minSec, maxSec] for this play.
        const cfg = this.session.generative
        const minMs = Math.min(cfg.minDurationMs, cfg.maxDurationMs)
        const maxMs = Math.max(cfg.minDurationMs, cfg.maxDurationMs)
        const durMs = minMs + Math.random() * (maxMs - minMs)
        // Honour Use Morph -- pass through transport morphMs when on,
        // 0 (snap) when off. The renderer's "Use Morph" toggle is the
        // single source of truth; the engine just opts in or out.
        const opts: {
          morphMs?: number
          sourceSlotIdx?: number | null
          generativeDurationSec?: number
        } = { generativeDurationSec: durMs / 1000 }
        if (cfg.useMorph) {
          // Read morphMs from the session-level transport-morph
          // binding only when set. The renderer doesn't currently
          // mirror its UI-only morphMs into the session, so for v1
          // we rely on a per-scene morphInMs OR fall back to a
          // sensible default (1500 ms) when useMorph is on. Future
          // work: surface a transport.morphMs field on Session so
          // the engine can read it directly.
          const morphIn =
            this.session.scenes.find((s) => s.id === pickedId)?.morphInMs
          opts.morphMs = typeof morphIn === 'number' ? morphIn : 1500
        } else {
          opts.morphMs = 0
        }
        this.triggerScene(pickedId, opts)
        return
      }
      // Selector returned null (empty pool, paused, etc.) -- fall
      // through to Stop so the engine doesn't drone indefinitely.
      this.stopScene(current.id)
      return
    }
    // Use the slot's override nextMode if armSceneAdvance passed one;
    // otherwise fall back to the scene's own nextMode. Lets per-slot
    // overrides redirect playback differently for each placement of
    // the same scene.
    const effectiveMode = modeOverride ?? current.nextMode
    // Loop bypasses the sequence entirely — it re-triggers the current
    // scene regardless of whether it's placed in any sequencer slot. The
    // repeat-counter increments on re-trigger, but stays capped at its own
    // count so it keeps looping forever. Preserve activeSequenceSlotIdx
    // so the Sequence view's per-slot status bar restarts on the SAME
    // slot — without this the slot index nulled out on loop and the
    // bar disappeared because TimelineSegment's `playing` check (which
    // gates the progress fill) requires activeSequenceSlotIdx === slotIdx.
    if (effectiveMode === 'loop') {
      this.triggerScene(current.id, { sourceSlotIdx: this.activeSequenceSlotIdx })
      return
    }
    // Build the "walk list" for follow actions. Primary: scenes placed
    // in the Sequence grid, in grid order. Fallback: the palette (every
    // scene in session.scenes), so follow actions still work before the
    // user has arranged anything in the Sequence view. Without the
    // fallback, non-loop follow actions silently terminated whenever the
    // grid was empty — the user experienced this as "only Stop and Loop
    // work; every other follow action just stops after completion."
    const len = Math.max(1, Math.min(128, this.session.sequenceLength ?? 128))
    const gridSeq = this.session.sequence.slice(0, len)
    const gridPresent = gridSeq.filter((id): id is string => !!id)
    const usingPalette = gridPresent.length === 0
    // `seq` is whatever we walk. slotIdx in the result points into
    // `gridSeq` when we're using the grid, or stays null when we're
    // walking the palette (the Sequence view won't have a matching slot
    // to highlight). Either way we pass just the scene id through
    // triggerScene, so behavior is identical downstream except for the
    // highlight in the Sequence grid.
    const seq: (string | null)[] = usingPalette
      ? this.session.scenes.map((s) => s.id)
      : gridSeq
    const filledIdxs: number[] = []
    seq.forEach((id, i) => {
      if (id) filledIdxs.push(i)
    })
    // Still nothing? Genuinely empty session — fall through to Stop so
    // cells don't drone indefinitely.
    if (filledIdxs.length === 0) {
      this.stopScene(current.id)
      return
    }

    // Track (nextId, nextSlotIdx) together so the highlight in the
    // Sequence view follows the SPECIFIC slot the advance landed on,
    // not every instance of the scene in the grid. `nextSlotIdx` stays
    // null when we fall back to walking the palette (no grid slot to
    // highlight).
    let nextId: string | null = null
    let nextSlotIdx: number | null = null
    // CRITICAL: use the live activeSequenceSlotIdx when present (the
    // ACTUAL slot the engine is currently playing) instead of
    // findIndex(scene.id), which always returns the FIRST occurrence
    // and breaks any sequence with the same scene placed twice
    // (advance always walked from the first instance instead of the
    // currently-playing one). Fallback to findIndex only when we're
    // walking the palette (no grid slot to anchor on).
    const liveSlot = this.activeSequenceSlotIdx
    const start =
      !usingPalette && liveSlot !== null && seq[liveSlot] === current.id
        ? liveSlot
        : seq.findIndex((id) => id === current.id)

    // When walking the palette, the "slot index" we pick is meaningless
    // for the Sequence view's highlight — so null it out before firing
    // triggerScene. The grid path keeps real slot indices so clicking
    // Next on scene-at-slot-5 highlights slot 6, not every instance of
    // scene 6 in the grid.
    const slotOrNull = (idx: number | undefined): number | null =>
      usingPalette ? null : typeof idx === 'number' ? idx : null

    switch (effectiveMode) {
      case 'next': {
        if (start < 0) {
          const pick = filledIdxs[0]
          nextSlotIdx = slotOrNull(pick)
          nextId = seq[pick] ?? null
        } else {
          for (let i = 1; i <= seq.length; i++) {
            const idx = (start + i) % seq.length
            if (seq[idx]) {
              nextId = seq[idx]
              nextSlotIdx = slotOrNull(idx)
              break
            }
          }
        }
        break
      }
      case 'prev': {
        if (start < 0) {
          const pick = filledIdxs[filledIdxs.length - 1]
          nextSlotIdx = slotOrNull(pick)
          nextId = seq[pick] ?? null
        } else {
          for (let i = 1; i <= seq.length; i++) {
            const idx = (start - i + seq.length) % seq.length
            if (seq[idx]) {
              nextId = seq[idx]
              nextSlotIdx = slotOrNull(idx)
              break
            }
          }
        }
        break
      }
      case 'first': {
        const pick = filledIdxs[0]
        nextSlotIdx = slotOrNull(pick)
        nextId = seq[pick] ?? null
        break
      }
      case 'last': {
        const pick = filledIdxs[filledIdxs.length - 1]
        nextSlotIdx = slotOrNull(pick)
        nextId = seq[pick] ?? null
        break
      }
      case 'any': {
        // Random pick from every present slot (including self).
        const pick = filledIdxs[Math.floor(Math.random() * filledIdxs.length)]
        nextSlotIdx = slotOrNull(pick)
        nextId = seq[pick] ?? null
        break
      }
      case 'other': {
        // Random pick excluding the current scene. If only self is
        // present, fall back to self so the follow doesn't stall.
        const otherIdxs = filledIdxs.filter((i) => seq[i] !== current.id)
        const pick =
          otherIdxs.length > 0
            ? otherIdxs[Math.floor(Math.random() * otherIdxs.length)]
            : filledIdxs[0]
        nextSlotIdx = slotOrNull(pick)
        nextId = seq[pick] ?? null
        break
      }
      default:
        // 'stop' and 'loop' are handled above / earlier; anything else is a
        // no-op on purpose.
        break
    }
    if (nextId) {
      this.triggerScene(nextId, { sourceSlotIdx: nextSlotIdx })
    } else {
      // Every code path above that reached here without finding a next
      // (e.g. default case) falls back to Stop so the current scene
      // doesn't hang.
      this.stopScene(current.id)
    }
  }

  stopAll(): void {
    for (const [tid, ts] of this.tracks.entries()) {
      if (ts.armed || ts.delayTimer) this.beginStop(tid, undefined, /* silent */ true)
    }
    // Release any held State-Trigger + Pose-Sequence notes too — "stop
    // everything".
    this.releaseAllStateNotes()
    this.releaseAllSeqNotes()
    this.clearSceneAdvance()
    this.activeSceneId = null
    this.activeSceneStartedAt = null
    this.activeSequenceSlotIdx = null
    this.activeSceneRepeatCount = 0
    this.emitState()
  }

  panic(): void {
    for (const ts of this.tracks.values()) {
      if (ts.delayTimer) {
        clearTimeout(ts.delayTimer)
        ts.delayTimer = null
      }
      // Send Note Off for any held note + clear the gate scheduler
      // BEFORE the global midi panic sweep. Both layers fire All
      // Notes Off + All Sound Off — belt-and-braces so no note can
      // hang regardless of which path got us here.
      this.sendMidiNoteOff(ts)
      ts.armed = false
      ts.stopping = false
      ts.activeSceneId = null
      ts.morphMs = 0
      ts.fromCenter = []
      ts.toCenter = []
    }
    // Release + forget any held State-Trigger + Pose-Sequence notes and
    // their gate timers (the global sweep below also silences them, but
    // this clears our tracking so nothing fires later).
    this.releaseAllStateNotes()
    this.releaseAllSeqNotes()
    // Global MIDI panic — All Notes Off + All Sound Off + Reset All
    // Controllers on every open port and every channel. The
    // midiSender stays alive (panic doesn't tear it down) so
    // subsequent triggers can still emit.
    this.midiSender.panic()
    this.clearSceneAdvance()
    this.activeSceneId = null
    this.activeSceneStartedAt = null
    this.activeSequenceSlotIdx = null
    this.activeSceneRepeatCount = 0
    this.emitState()
  }

  // ----- Ticking -----

  private startTicker(): void {
    if (!this.session) {
      // Kick off at 120Hz default until session arrives (matches the
      // renderer's default from factory.makeEmptySession).
      this.tickTimer = setInterval(() => this.tick(), 1000 / 120)
      return
    }
    // Keep this range in sync with setTickRate() above and with the
    // renderer's clamp in store.setTickRate. Drifting apart silently caps
    // the engine to a lower rate than the UI advertises.
    const hz = clamp(this.session.tickRateHz, 10, 300)
    this.tickTimer = setInterval(() => this.tick(), 1000 / hz)
  }

  private stopTicker(): void {
    if (this.tickTimer) {
      clearInterval(this.tickTimer)
      this.tickTimer = null
    }
  }

  private restartTicker(): void {
    this.stopTicker()
    this.startTicker()
  }

  private tickIdx = 0

  private tick(): void {
    if (!this.session) return
    const t = now()
    // Cap dt at 50 ms. If the system hiccups (GC pause, CPU spike, sleep
    // wake-up), a raw dt could be several hundred ms — enough to overshoot
    // phase, fire multiple clock advances in a single tick for S&H / Slew
    // / Chaos / Random, or make the one-pole IIR filter in Slew go unstable.
    // Treating the backlog as "just one frame's worth" keeps DSP sane at
    // the cost of a visible catch-up delay after real stalls (preferable).
    const rawDt = this.lastTickAt === 0 ? 0 : (t - this.lastTickAt) / 1000
    const dt = Math.min(0.05, rawDt)
    this.lastTickAt = t
    this.tickIdx++

    for (const [trackId, ts] of this.tracks.entries()) {
      if (!ts.armed && !ts.stopping) continue
      let cell = this.getActiveCell(trackId)
      if (!cell) continue
      // Resolve the session-side Track entry for engine-aware flags
      // (enabled, persistentSlots, oscEnabled) read further down the
      // loop.
      const track = this.session.tracks.find((tt) => tt.id === trackId)
      // OSC emission gate. The user can disable OSC at two levels:
      //   - per-Parameter (track.oscEnabled === false)  → applies to every cell on that row
      //   - per-cell (cell.oscEnabled === false)        → applies to just this clip
      // Either being explicitly false silences OSC for this cell on
      // this tick. Undefined / true means "emit" (default). MIDI is
      // independent — a cell with OSC off + MIDI on still emits
      // MIDI normally.
      //
      // Hard invariant: template-kind tracks (Instrument-template
      // headers, e.g. "OCTOCOSME" row) NEVER emit OSC. Their cells
      // are group-trigger buttons in the UI — they fire all child
      // Parameter cells in their column, but the template-track cell
      // itself is a UI container, not a data emitter. Older session
      // data (and a since-fixed cell-create path) sometimes
      // backfilled template-kind cells with `oscEnabled: true` + a
      // placeholder address/value (e.g. "/dataflou/value 0"), which
      // then leaked one packet per scene trigger to whatever
      // destination got defaulted in. Gating at the engine layer
      // makes the fix robust against any present-or-future data
      // model drift: even if cell.oscEnabled is true, kind ===
      // 'template' wins. MIDI emission is intentionally NOT gated
      // here — template tracks could theoretically host a MIDI
      // group-trigger pattern in a future revision; the bug is
      // OSC-specific.
      const oscEmitAllowed =
        track?.kind !== 'template' &&
        (cell.oscEnabled ?? true) &&
        (track?.oscEnabled ?? true)
      if (this.isTrackEffectivelyDisabled(trackId)) continue

      // Live-recompute `seqGenRanges` when the user toggles
      // `scaleToUnit` mid-play. Without this, the auto-range path
      // would stay on stale cached values (from when the cell was
      // triggered with scaleToUnit off) until the next cycle wrap
      // or a fresh trigger — visibly mis-scaling for that interval.
      // Cheap: computeCycleRanges walks the cell's value once.
      if (
        ts.prevScaleToUnit !== null &&
        ts.prevScaleToUnit !== cell.scaleToUnit
      ) {
        if (cell.scaleToUnit && cell.sequencer.enabled) {
          ts.seqGenRanges = computeCycleRanges(cell, ts)
        } else if (!cell.scaleToUnit) {
          // scaleToUnit just turned OFF — drop the ranges so the
          // non-scaled path doesn't try to use them.
          ts.seqGenRanges = []
        }
      }
      ts.prevScaleToUnit = cell.scaleToUnit

      // ── Two-stage modulator — Mod 2 advance + apply ──────────────
      // Mod 2 runs every tick when enabled. We advance its parallel
      // state, evaluate its bipolar [-1, +1] signal, then build an
      // "effective Mod 1" Modulation by applying Mod 2's signal to
      // Mod 1's Rate / Depth / context-aware Shape per the user's
      // targets + targetMode. The rest of the tick loop reads from
      // `cell.modulation`, so we swap the cell reference to the
      // patched version — Mod 1's stored Modulation is NEVER mutated.
      // When Mod 2 is off, we skip everything (zero overhead).
      //
      // We also stash the ORIGINAL Modulation 1 in
      // `mod1OriginalForSlots` so the per-slot loop can fall back to
      // it when a slot has Modulation 2 routed off in the Routing
      // matrix (see routing.modulation2[idx] checks below).
      let mod1OriginalForSlots: Modulation = cell.modulation
      // Hoisted so the Address sequencer mode's `stage2` sub-mode can
      // read it later in this iteration — Mod 2 drives the playhead
      // instead of Mod 1 in that sub-mode. Stays 0 when Mod 2 is off.
      let mod2NormBipolar = 0
      if (cell.modulation2?.enabled) {
        mod1OriginalForSlots = cell.modulation
        advanceMod2State(
          cell.modulation2,
          ts.m2,
          dt,
          t,
          this.session.globalBpm,
          this.tickIdx
        )
        // Scene duration (seconds) for envelope-as-Mod2. Best-effort
        // — falls back to 1 s if we can't resolve it cheaply (the
        // duration is mainly used by Envelope which is a rare Mod 2
        // pick anyway).
        const sceneDurSec = 1
        mod2NormBipolar = evalMod2Bipolar(
          cell.modulation2,
          ts.m2,
          ts.triggerTime,
          t,
          this.session.globalBpm,
          this.tickIdx,
          sceneDurSec
        )
        const effMod1 = applyMod2ToMod1(
          cell.modulation,
          cell.modulation2,
          mod2NormBipolar
        )
        // Compute effective Sequencer too -- Mod 2 -> Seq routes
        // through `targetsSeq` (parallel to `targets` for Mod 1).
        // Same skip-when-no-target fast path keeps cells that don't
        // use this feature at zero cost. The cell-level routing gate
        // (`cell.routing.modulation2Seq`) is honoured too: if EVERY
        // slot in the array is explicitly false, skip the seq patch
        // (visual cue: user has turned off Mod 2 -> Seq for every
        // slot in the routing matrix). Any true entry => apply
        // cell-wide; the seq state (step idx, timing) is global per
        // cell so true per-slot gating isn't meaningful here.
        let effSeq = cell.sequencer
        if (cell.sequencer?.enabled) {
          const m2SeqRouting = cell.routing?.modulation2Seq
          const allSlotsOff =
            Array.isArray(m2SeqRouting) &&
            m2SeqRouting.length > 0 &&
            m2SeqRouting.every((b) => b === false)
          if (!allSlotsOff) {
            effSeq = applyMod2ToSeq(
              cell.sequencer,
              cell.modulation2,
              mod2NormBipolar
            )
          }
        }
        // Shallow-clone the cell with the patched modulation +
        // sequencer so any downstream code reading `cell.modulation`
        // / `cell.sequencer` sees the effective version. The
        // original cell in the session stays untouched.
        cell = { ...cell, modulation: effMod1, sequencer: effSeq }
      }
      // NOTE: live-preview emit moved out of the Mod 2 gate — it now
      // fires unconditionally for the watched cell so the Inspector
      // can animate things that don't depend on Mod 2 either (e.g.
      // the Gesture playhead dot, which traces the recorded curve
      // any time the cell is armed). See block below the per-tick
      // modulator advances.

      // Advance LFO phase (only for LFO modulation; envelope uses real time).
      if (cell.modulation.enabled && cell.modulation.type === 'lfo') {
        const effHz = effectiveLfoHz(cell.modulation, this.session.globalBpm)
        const prevPhase = ts.phase
        ts.phase += effHz * dt
        // Resample stepped / smooth noise on every full-cycle wrap.
        // Multiple wraps in a single tick (effHz × dt > 1.0, possible
        // after a sync-mode toggle that jumps effHz way up) iterate
        // the resampler `wraps` times so we don't silently miss
        // intermediate samples — visible as a frozen "stuck" value
        // at high rates otherwise.
        const wraps = Math.floor(ts.phase) - Math.floor(prevPhase)
        if (wraps > 0) {
          const rng = ts.seqRng ?? Math.random
          // `spastic` is rndStep quantised to exactly {-1, +1} — under
          // unipolar mode + 100% depth + base 0, this gives the user
          // a binary 0/1 LFO with naturally varying run lengths (back-
          // to-back same samples extend the run). Other shapes resample
          // to continuous [-1, 1] floats on every wrap as before.
          const spastic = cell.modulation.shape === 'spastic'
          for (let w = 0; w < wraps; w++) {
            ts.rndSmoothPrev = ts.rndSmoothNext
            ts.rndSmoothNext = rng() * 2 - 1
            ts.rndStepValue = spastic ? (rng() < 0.5 ? -1 : 1) : rng() * 2 - 1
          }
          ts.rndStepLastTick = this.tickIdx
        }
      }

      // Sample & Hold — clock-driven stair (or cosine-smoothed stair).
      // Each clock period, optionally pick a fresh sample in [-1, 1].
      // `probability` below 1.0 gives the pattern a chance to "hold" a
      // sample for multiple clocks (Turing-machine-ish locked feel).
      if (cell.modulation.enabled && cell.modulation.type === 'sh' && !ts.stopping) {
        const effHz = effectiveLfoHz(cell.modulation, this.session.globalBpm)
        if (effHz > 0) {
          const rng = ts.seqRng ?? Math.random
          const period = 1000 / effHz
          // Distribution skew (0..1) — same warp as the Random
          // modulator. Pulls samples toward centre (>0.5), pushes
          // toward edges (<0.5), or passes through uniform (=0.5).
          const dist = cell.modulation.sh.distribution
          const drawShVal = (): number => {
            if (dist === undefined || dist === 0.5) return rng() * 2 - 1
            const warped = warpDistribution(rng(), dist) // [0, 1]
            return warped * 2 - 1
          }
          while (t - ts.shLastAdvanceAt >= period) {
            ts.shLastAdvanceAt += period
            if (rng() < Math.max(0, Math.min(1, cell.modulation.sh.probability))) {
              ts.shPrev = ts.shHeld
              ts.shHeld = drawShVal()
            }
            // If the die rolls against us, no change — held + prev stay put.
          }
        }
      }

      // Slew — generate a clock-rate target, then per-tick low-pass the
      // current value toward it using independent rise/fall time constants.
      if (cell.modulation.enabled && cell.modulation.type === 'slew' && !ts.stopping) {
        const effHz = effectiveLfoHz(cell.modulation, this.session.globalBpm)
        if (effHz > 0) {
          const rng = ts.seqRng ?? Math.random
          const period = 1000 / effHz
          while (t - ts.slewLastAdvanceAt >= period) {
            ts.slewLastAdvanceAt += period
            if (cell.modulation.slew.randomTarget) {
              ts.slewTarget = rng() * 2 - 1
            } else {
              // Bipolar square: flip the existing target's sign each clock.
              // A previous version used a tick-local counter that reset
              // every tick, so with exactly one clock advance per tick the
              // target got stuck at -1 forever (first increment → 1 → odd
              // → -1, reset to 0 next tick, same again). Flipping in-place
              // preserves alternation across tick boundaries.
              ts.slewTarget = ts.slewTarget >= 0 ? -1 : 1
            }
          }
        }
        // Per-tick filter: exponential toward target, different HL for rise vs fall.
        const goingUp = ts.slewTarget > ts.slewValue
        const halfLifeMs = Math.max(1, goingUp ? cell.modulation.slew.riseMs : cell.modulation.slew.fallMs)
        // One-pole IIR: y += (target - y) * (1 - 2^(-dt / halfLife))
        const alpha = 1 - Math.pow(2, (-dt * 1000) / halfLifeMs)
        ts.slewValue += (ts.slewTarget - ts.slewValue) * alpha
      }

      // Chaos — logistic map iterate at clock rate. Stored state stays in
      // (0, 1); output is scaled to bipolar [-1, 1] in computeModNorm.
      if (cell.modulation.enabled && cell.modulation.type === 'chaos' && !ts.stopping) {
        const effHz = effectiveLfoHz(cell.modulation, this.session.globalBpm)
        if (effHz > 0) {
          const period = 1000 / effHz
          const r = Math.max(3.4, Math.min(4.0, cell.modulation.chaos.r))
          const rng = ts.seqRng ?? Math.random
          while (t - ts.chaosLastAdvanceAt >= period) {
            ts.chaosLastAdvanceAt += period
            let x = ts.chaosX
            x = r * x * (1 - x)
            // Clamp away from fixed points so the trajectory never
            // stalls on a degenerate input. Reseed via the per-track
            // PRNG (not Math.random) so the recovery is reproducible
            // across re-triggers of the same cell.
            if (!Number.isFinite(x) || x <= 0 || x >= 1) x = 0.1 + rng() * 0.8
            ts.chaosX = x
          }
        }
      }

      // Strange Attractor — continuous ODE integration. Unlike the
      // 1-D logistic Chaos above, the trajectory is bounded but never
      // periodic, and the channels (X/Y/Z[/W]) are CORRELATED, giving
      // an "organic, intentional" feel — exactly what installation
      // work asks for.
      //
      // Per-tick integration with adaptive sub-steps so high `speed`
      // settings don't unphysically jump across the attractor in one
      // big step (which would diverge most of these systems). All raw
      // state lives in `attractorRaw*`; the renderable `attractor*`
      // mirror is the same trajectory normalised into [0, 1] per axis.
      //
      // ── Gesture modulator advance ────────────────────────────────
      // Reads the cell's recorded XY polyline + the standard
      // Modulation rate controls (effectiveLfoHz handles Free / BPM
      // sync). Advances a [0, 1) playhead through `loopMs = 1000/effHz`
      // each tick, applies an optional sinusoidal Wiggle that jitters
      // the playhead back and forth between adjacent recorded points,
      // and samples (x, y) on the curve. Result is stashed in
      // ts.gestureX/Y for the slot loop + computeModNorm + Mod 1 live
      // emit to read.
      if (
        cell.modulation.enabled &&
        cell.modulation.type === 'gesture' &&
        !ts.stopping
      ) {
        const gp = cell.modulation.gesture
        const pts = gp?.points ?? []
        if (pts.length === 0) {
          // No recording — emit a quiet centre value (0.5, 0.5).
          // Don't advance phase so the modulator stays steady.
          ts.gestureX = 0.5
          ts.gestureY = 0.5
        } else {
          const effHz = effectiveLfoHz(cell.modulation, this.session.globalBpm)
          // Advance the shared phase counter at effHz. Phase wraps in
          // [0, 1) so we can use it directly as the playhead position.
          ts.phase += effHz * dt
          const phaseFrac = ts.phase - Math.floor(ts.phase)
          // Play-mode mapping: forward = phase as-is, backward = 1 -
          // phase (reverse sweep), pingpong = triangle wave (0 → 1 →
          // 0 per loop). Wiggle is overlaid on whatever this mapping
          // produces, so jitter feels coherent in any direction.
          const playMode = gp?.playMode ?? 'forward'
          let basePlayhead: number
          if (playMode === 'backward') {
            basePlayhead = 1 - phaseFrac
          } else if (playMode === 'pingpong') {
            basePlayhead = 1 - Math.abs(2 * phaseFrac - 1)
          } else {
            basePlayhead = phaseFrac
          }
          // Wiggle — sinusoidal jitter overlaid on the basePlayhead.
          // At 100 % the swing covers roughly one inter-point gap.
          // Direction reverses 5× per loop so the user hears a clear
          // "back-and-forth" against the smooth flow.
          const wigglePct = Math.max(0, Math.min(100, gp?.wiggle ?? 0)) / 100
          let playhead01 = basePlayhead
          if (wigglePct > 0) {
            // span = 0..0.5 of the full loop at 100% wiggle. 0.5 of
            // the loop is enough to noticeably ping-pong around any
            // point without skipping past the whole curve.
            const span = wigglePct * 0.5
            const wiggleHz = Math.max(0.05, effHz) * 5
            const offset =
              Math.sin(((t - ts.triggerTime) / 1000) * wiggleHz * Math.PI * 2) *
              span
            playhead01 = basePlayhead + offset
            // Wrap into [0, 1).
            playhead01 = ((playhead01 % 1) + 1) % 1
          }
          const sample = sampleGesture(pts, playhead01)
          ts.gestureX = sample.x
          ts.gestureY = sample.y
        }
        // Invalidate the merged-mode sqrt cache so the per-slot loop
        // re-computes it once with the new X/Y, then reuses the
        // result across the remaining slots this tick.
        ts.gestureCacheTickStamp++
      }
      if (
        cell.modulation.enabled &&
        cell.modulation.type === 'attractor' &&
        !ts.stopping &&
        cell.modulation.attractor
      ) {
        const ap = cell.modulation.attractor
        if (ts.attractorLastUpdateMs === 0) ts.attractorLastUpdateMs = t
        const dtMs = Math.max(0, t - ts.attractorLastUpdateMs)
        ts.attractorLastUpdateMs = t
        // Total integration time this tick (in attractor "seconds").
        // 1× speed = 60 ms of wall-clock maps to 0.012 of integration
        // time — slow enough that Lorenz reads as a clear, lazy
        // butterfly at 0.5×, frenetic at 10×.
        const tIntegrate = Math.min(0.5, dtMs * 0.0002 * Math.max(0.05, ap.speed))
        // Sub-steps so the largest single integration is <= 0.005 to
        // keep Euler stable. Most attractors are robust to slightly
        // larger but ~0.005 is the safe floor.
        const subSteps = Math.max(1, Math.ceil(tIntegrate / 0.005))
        const h = tIntegrate / subSteps
        let x = ts.attractorRawX
        let y = ts.attractorRawY
        let z = ts.attractorRawZ
        let w = ts.attractorRawW
        const chaosKnob = Math.max(0, Math.min(1, ap.chaos))
        let dx = 0
        let dy = 0
        let dz = 0
        let dw = 0
        for (let s = 0; s < subSteps; s++) {
          switch (ap.type) {
            case 'lorenz': {
              // Canonical Lorenz at σ=10, β=8/3, ρ varied by chaos
              // knob from 14 (limit cycle) → 28 (classic butterfly)
              // → 50 (jagged wings).
              const sigma = 10
              const beta = 8 / 3
              const rho = 14 + chaosKnob * 36
              dx = sigma * (y - x)
              dy = x * (rho - z) - y
              dz = x * y - beta * z
              break
            }
            case 'rossler': {
              // Canonical Rössler at a=b=0.2, c varied by chaos.
              const a = 0.2
              const b = 0.2
              const c = 4 + chaosKnob * 10 // 4..14, chaotic ~5.7+
              dx = -y - z
              dy = x + a * y
              dz = b + z * (x - c)
              break
            }
            case 'aizawa': {
              // Aizawa: smooth toroidal trajectory with a spiral hole.
              const a = 0.95
              const b = 0.7
              const c = 0.6
              const d = 3.5
              const e = 0.25
              const f = 0.1 + chaosKnob * 0.3
              dx = (z - b) * x - d * y
              dy = d * x + (z - b) * y
              dz = c + a * z - (z * z * z) / 3 - (x * x + y * y) * (1 + e * z) + f * z * (x * x * x)
              break
            }
            case 'thomas': {
              // Thomas' cyclically symmetric attractor.
              const b = 0.05 + chaosKnob * 0.3 // damping; lower = more chaotic
              dx = Math.sin(y) - b * x
              dy = Math.sin(z) - b * y
              dz = Math.sin(x) - b * z
              break
            }
            case 'rossler4d': {
              // 4D hyperchaotic Rössler.
              const a = 0.25
              const b = 3
              const c = 0.05 + chaosKnob * 0.15
              const d = 0.5
              dx = -y - z
              dy = x + a * y + w
              dz = b + x * z
              dw = -c * z + d * w
              break
            }
            case 'lu4d': {
              // 4D Lü hyperchaotic. Tight, dense trajectory.
              const a = 36
              const b = 3
              const c = 20
              const d = 1 + chaosKnob * 2.5 // bifurcation knob
              dx = a * (y - x) + w
              dy = c * y - x * z
              dz = x * y - b * z
              dw = -x * z + d * w
              break
            }
          }
          x += h * dx
          y += h * dy
          z += h * dz
          w += h * dw
          // Inside-loop safety clamps. Aizawa (and to a lesser extent
          // Lorenz/Rössler at extreme chaos values) can produce a
          // single huge dx after a state escape, which then feeds
          // back as x → ±∞ → NaN within the same tick. Clamping to
          // ±SAFE_MAX after every sub-step keeps the trajectory in
          // the realm where dy / dz computations remain finite. The
          // bound is well above every attractor's natural extent so
          // it never affects the canonical orbits.
          const SAFE_MAX = 200
          if (!Number.isFinite(x) || Math.abs(x) > SAFE_MAX)
            x = Number.isFinite(x) ? Math.sign(x) * SAFE_MAX : 0.1
          if (!Number.isFinite(y) || Math.abs(y) > SAFE_MAX)
            y = Number.isFinite(y) ? Math.sign(y) * SAFE_MAX : 0
          if (!Number.isFinite(z) || Math.abs(z) > SAFE_MAX)
            z = Number.isFinite(z) ? Math.sign(z) * SAFE_MAX : 0
          if (!Number.isFinite(w) || Math.abs(w) > SAFE_MAX)
            w = Number.isFinite(w) ? Math.sign(w) * SAFE_MAX : 0
        }
        // End-of-loop divergence guard — if the trajectory is still
        // way out after clamping, reseed to a canonical inner point.
        if (
          !Number.isFinite(x) ||
          !Number.isFinite(y) ||
          !Number.isFinite(z) ||
          !Number.isFinite(w)
        ) {
          x = 0.1
          y = 0
          z = 0
          w = 0
        }
        ts.attractorRawX = x
        ts.attractorRawY = y
        ts.attractorRawZ = z
        ts.attractorRawW = w
        // Normalise to [0, 1] per axis using known canonical bounds
        // for each attractor. The mapping is intentionally generous
        // so chaos-knob extremes still land mostly in-range. NaN/Inf
        // protection at the top returns the midpoint instead of
        // letting a degenerate value reach the renderer / per-slot
        // emit math.
        const norm01 = (v: number, range: number): number => {
          if (!Number.isFinite(v)) return 0.5
          const u = 0.5 + v / (2 * range)
          return u < 0 ? 0 : u > 1 ? 1 : u
        }
        // Per-attractor half-ranges (v in ±range maps to [0, 1] of
        // output). Tuned against published phase-space bounds for
        // each system at chaos=0.5. Aizawa z can reach ~2 so the
        // z-range is widened from the previous 1.5. 4D systems have
        // larger w-ranges because they're hyperchaotic.
        let rngX = 25
        let rngY = 30
        let rngZ = 30
        let rngW = 10
        switch (ap.type) {
          case 'lorenz':
            // Classic ρ=28: x,y ∈ ±20, z ∈ [0, 50]. Widened so
            // chaos=1 (ρ=50) still fits.
            rngX = 30
            rngY = 30
            rngZ = 50
            break
          case 'rossler':
            // At c=5.7: x,y ∈ ±10, z ∈ [0, 25]. Widened for c=14.
            rngX = 15
            rngY = 15
            rngZ = 25
            break
          case 'aizawa':
            // Aizawa: x,y ∈ ±1.5, z ∈ [-0.5, 2]. The previous 1.5
            // range on z was too tight (z reaches 2) — value got
            // pinned at 1.0 and bracketed the NaN region. Bumping
            // to 2 fixes the clip.
            rngX = 1.5
            rngY = 1.5
            rngZ = 2
            break
          case 'thomas':
            // Bounded: x,y,z ∈ ±5 across the chaos sweep.
            rngX = 5
            rngY = 5
            rngZ = 5
            break
          case 'rossler4d':
            // Hyperchaotic Rössler 4D: x,y ∈ ±15, z ∈ [0, 35], w
            // can swing wider. Previous ranges were too tight.
            rngX = 15
            rngY = 15
            rngZ = 30
            rngW = 50
            break
          case 'lu4d':
            // Lü 4D hyperchaotic: aggressive constants → large
            // raw values. Previous estimates were close but z + w
            // tended to clip. Widened.
            rngX = 50
            rngY = 50
            rngZ = 80
            rngW = 150
            break
        }
        ts.attractorX = norm01(x, rngX)
        ts.attractorY = norm01(y, rngY)
        ts.attractorZ = norm01(z, rngZ)
        // For 3D attractors, the W channel is the speed of the
        // trajectory (|d/dt|) — gives a "breathing" 4th channel
        // that's correlated with the X/Y/Z motion. EMA-smoothed so
        // it doesn't pulse spasmodically every tick.
        if (ap.type === 'rossler4d' || ap.type === 'lu4d') {
          ts.attractorW = norm01(w, rngW)
        } else {
          const speedRaw = Math.sqrt(dx * dx + dy * dy + dz * dz)
          // Soft-clip to a reasonable normalised range. Different
          // attractors have wildly different natural speeds; the
          // arctan keeps it bounded with a gentle knee.
          const speedN = Math.atan(speedRaw / 30) / (Math.PI / 2)
          // EMA smoothing — α=0.1 = ~10-tick time constant.
          ts.attractorSpeed = ts.attractorSpeed * 0.9 + speedN * 0.1
          ts.attractorW = ts.attractorSpeed
        }
      }

      // Random Generator path — bypasses the normal token logic. Emits
      // a new OSC payload on its own rate, seeded from the cell's Value.
      // Number of samples per tick scales with the number of whitespace-
      // separated entries in the Value field (1 per entry for int/float,
      // 3 per entry for colour — each entry becomes its own RGB triplet).
      if (
        cell.modulation.enabled &&
        cell.modulation.type === 'random' &&
        !ts.stopping &&
        ts.randRng
      ) {
        const effHz = effectiveLfoHz(cell.modulation, this.session.globalBpm)
        if (effHz > 0) {
          const period = 1000 / effHz
          const rawTokens = parseValueTokens(cell.value)
          const tokenCount = Math.max(1, rawTokens.length)
          let advanced = false
          while (t - ts.randLastAdvanceAt >= period) {
            ts.randLastAdvanceAt += period
            ts.randCurrent = sampleRandom(
              ts.randRng,
              cell.modulation.random,
              tokenCount
            )
            advanced = true
          }
          if (advanced) {
            const rnd = cell.modulation.random
            // Pre-compute the configured output span so scaleToUnit
            // can NORMALISE int / colour samples (which live in
            // [rnd.min, rnd.max] — typically 0..255 for colour, 0..127
            // for MIDI, etc.) into [0, 1] rather than blunt-clamping
            // every byte > 1 down to 1. Float values already live in
            // [rnd.min, rnd.max] so the same normalisation works.
            const rndLo = Math.min(rnd.min, rnd.max)
            const rndHi = Math.max(rnd.min, rnd.max)
            const rndSpan = rndHi - rndLo
            const normalise = (v: number): number => {
              if (rndSpan <= 1e-9) return 0
              return Math.max(0, Math.min(1, (v - rndLo) / rndSpan))
            }
            // Pin + fixed-arg respect for the Random emit. The per-
            // slot loop (which handles these for every OTHER emit
            // path) gets skipped via the `continue` at the bottom of
            // the Random branch, so we have to apply the same
            // overrides here before sendMany. Three cases per slot:
            //   - argSpec.fixed → emit the declared fixed value
            //   - cell.persistentSlots[i] === true → use cell pin
            //   - cell.persistentSlots[i] === undefined && track pinned → use track pin
            //   - otherwise → random sample (existing behaviour)
            const cellPinArr = cell.persistentSlots
            const cellPinVals = cell.persistentValues
            const trackPinArr = track?.persistentSlots
            const trackPinVals = track?.persistentValues
            const argSpecRnd = track?.argSpec
            // (Bug 34 FIX) The Random path previously `continue`d past
            // the per-slot routing logic, so the routing matrix was
            // ignored — the Random modulator drove ALL slots regardless
            // of the MOD column checkboxes. Replicate the main path's
            // per-slot routing here: modulator-off → emit the cell.value
            // seed token; routing delays gate the slot until elapsed;
            // variation factors scale the contribution; and the new
            // M2-direct column contributes when routed.
            const rnd2 = cell.modulation2
            const mod2Enabled = rnd2?.enabled === true && !ts.stopping
            const m2Amt = (() => {
              const raw = rnd2?.valueAmount ?? 0.5
              return raw < 0 ? 0 : raw > 1 ? 1 : raw
            })()
            const m2Math = rnd2?.valueMath ?? 'add'
            const args: Array<{
              type: 'i' | 'f' | 's' | 'T' | 'F'
              value: number | string | boolean
            }> = ts.randCurrent.map((v, i) => {
              // 1. Fixed argSpec slot — emit the declared value.
              const spec = argSpecRnd?.[i]
              if (spec?.fixed !== undefined) {
                return formatFixedAsOscArg(spec)
              }
              // 2. Pin resolution (cell beats track; explicit false
              //    overrides track default to "unpinned").
              const cellOverride = cellPinArr?.[i]
              let pinnedRaw: string | undefined
              let isPinned = false
              if (cellOverride === true) {
                isPinned = true
                pinnedRaw = cellPinVals?.[i]
              } else if (cellOverride === false) {
                isPinned = false
              } else if (trackPinArr?.[i] === true) {
                isPinned = true
                pinnedRaw = trackPinVals?.[i]
              }
              if (isPinned && pinnedRaw !== undefined) {
                const parsed = parseFloat(pinnedRaw)
                if (Number.isFinite(parsed)) {
                  // Honour scaleToUnit on the pinned value too — same
                  // contract as the per-slot loop's pin branch.
                  const pinnedFinal = cell.scaleToUnit
                    ? Math.max(0, Math.min(1, parsed))
                    : parsed
                  // Match output type to what Random would have emitted:
                  // float for float-mode or scaleToUnit; int otherwise.
                  if (rnd.valueType === 'float' || cell.scaleToUnit) {
                    return { type: 'f' as const, value: pinnedFinal }
                  }
                  return { type: 'i' as const, value: Math.round(pinnedFinal) }
                }
              }
              // (Bug 34 FIX) Per-slot routing gates — mirror the main
              // per-slot loop. Slot index `i` is the emit slot; the
              // routing arrays are indexed the same way. Delay acts as a
              // gate until `triggerTime + delayMs`; modulator-off swaps
              // the random value for the seed token; variation scales
              // the contribution.
              const slotDelayMs = cell.routing?.delays?.[i] ?? 0
              const slotPostDelay =
                slotDelayMs <= 0 || t - ts.triggerTime >= slotDelayMs
              const routingModOn =
                slotPostDelay && cell.routing?.modulator?.[i] !== false
              const variationPct = cell.routing?.variations?.[i] ?? 0
              const variationFactor =
                variationPct > 0
                  ? 1 + (ts.routingVariationFactors[i] ?? 0) * (variationPct / 100)
                  : 1
              // Seed token for this slot. Colour expands each value
              // token into an RGB triplet (3 entries per token), so map
              // entry index → token index accordingly; int/float are 1:1.
              const tokenIdx =
                rnd.valueType === 'colour' ? Math.floor(i / 3) : i
              const seedVal = readNumber(rawTokens[tokenIdx] ?? '') ?? 0
              // (Bug 34 FIX) Modulator routed OFF for this slot → emit
              // the cell.value seed token instead of the random sample
              // (matches the main path's "modulator-off → use seed").
              if (!routingModOn) {
                if (rnd.valueType === 'float' || cell.scaleToUnit) {
                  const sv = cell.scaleToUnit ? normalise(seedVal) : seedVal
                  return { type: 'f' as const, value: sv }
                }
                return { type: 'i' as const, value: Math.round(seedVal) }
              }
              // 3. Default — random-generated value, with per-slot
              //    variation applied to the deviation from the seed so
              //    the routing Variation knob behaves like the main path
              //    (0% = identical across slots, higher = more spread).
              let rv = seedVal + (v - seedVal) * variationFactor
              // (Bug 34 FIX) Modulation 2 → Value (direct) contribution,
              // gated per slot by `routing.modulation2Direct[i] === true`
              // (defaults FALSE, so the explicit check is load-bearing).
              // Mirrors the main path: intensity from M2's valueAmount,
              // combined per valueMath, scaled by the same variation.
              if (
                mod2Enabled &&
                slotPostDelay &&
                cell.routing?.modulation2Direct?.[i] === true
              ) {
                const m2Offset =
                  mod2NormBipolar * Math.max(Math.abs(rv), 1) * m2Amt * variationFactor
                if (m2Math === 'mult') {
                  rv = rv * (1 + mod2NormBipolar * m2Amt * variationFactor)
                } else if (m2Math === 'mix') {
                  rv = 0.5 * rv + 0.5 * (rv + m2Offset)
                } else {
                  rv = rv + m2Offset
                }
              }
              if (rnd.valueType === 'float') {
                if (cell.scaleToUnit) {
                  return { type: 'f' as const, value: normalise(rv) }
                }
                // Quantize to 1e-11 for stable output.
                const q = Math.round(rv * 1e11) / 1e11
                return { type: 'f' as const, value: q }
              }
              // int or colour — integer output in [rndLo, rndHi].
              // Under scaleToUnit we emit a FLOAT in [0, 1] (matching
              // the rest of the engine's scaleToUnit convention) so
              // the receiver sees actual proportions instead of a
              // collapsed 0/1.
              const n = Math.round(rv)
              if (cell.scaleToUnit) {
                return { type: 'f' as const, value: normalise(n) }
              }
              return { type: 'i' as const, value: n }
            })
            if (oscEmitAllowed) {
              this.sender.sendMany(cell.destIp, cell.destPort, cell.oscAddress, args)
            }
            this.recordLiveValue(
              ts.activeSceneId ?? '',
              trackId,
              args
                .map((a) =>
                  typeof a.value === 'number' && a.type === 'f'
                    ? (a.value as number).toFixed(4)
                    : String(a.value)
                )
                .join(' ')
            )
          }
        }
        if (ts.stopping) this.disarm(ts)
        continue
      }

      // Advance arpeggiator step (per the modulation's rate sync settings).
      if (
        cell.modulation.enabled &&
        cell.modulation.type === 'arpeggiator' &&
        !ts.stopping
      ) {
        const effHz = effectiveLfoHz(cell.modulation, this.session.globalBpm)
        if (effHz > 0) {
          const period = 1000 / effHz
          // While-loop catches up if we missed multiple step boundaries
          // (e.g., a tick took unusually long).
          while (t - ts.arpLastAdvanceAt >= period) {
            ts.arpLastAdvanceAt += period
            advanceArpStep(ts, cell.modulation.arpeggiator)
          }
        }
      }

      // ── Live preview emit (~30 Hz) ─────────────────────────────────
      // Inspector subscribes via `engine:setSelectedCellForLive`; the
      // engine streams the EFFECTIVE Modulation 1 values (post-Mod 2
      // patch) so the Inspector's modulator sub-editor can overlay
      // live values on sliders, dropdowns, and (for Gesture) on the
      // playhead dot in the XY canvas. Runs unconditionally for the
      // watched cell — gesture playback wants to animate even when
      // Mod 2 is off, so we can't gate this on Mod 2 enabled.
      //
      // Placed AFTER all per-tick modulator advances so ts.gestureX/Y
      // and the other modulator state slots are fresh this tick.
      {
        const sel = this.selectedCellForLive
        if (
          this.onMod1Live &&
          sel &&
          sel.trackId === trackId &&
          ts.activeSceneId === sel.sceneId &&
          // Don't emit while the cell is stopping (fading out) or
          // while Mod 1 is disabled — the watched values are stale
          // or meaningless, and the Inspector's playhead dot
          // shouldn't keep ticking. The IPC channel still exists;
          // we just skip the per-tick send.
          !ts.stopping &&
          cell.modulation.enabled &&
          t - this.lastMod1LiveEmitAt >= 33
        ) {
          this.lastMod1LiveEmitAt = t
          // cell.modulation is either the stored Modulation (Mod 2 off)
          // or the patched effMod1 (Mod 2 on) — we swapped above.
          const m = cell.modulation
          const sample: import('@shared/types').Mod1LiveSample = {
            sceneId: sel.sceneId,
            trackId: sel.trackId,
            rateHz: m.rateHz,
            depthPct: m.depthPct
          }
          switch (m.type) {
            case 'lfo':
              sample.lfoShape = m.shape
              break
            case 'sh':
              sample.shDistribution = m.sh.distribution
              break
            case 'random':
              sample.randomDistribution = m.random.distribution
              break
            case 'attractor':
              sample.attractorChaos = m.attractor?.chaos
              sample.attractorSpeed = m.attractor?.speed
              break
            case 'chaos':
              sample.chaosR = m.chaos.r
              break
            case 'slew':
              sample.slewRiseMs = m.slew.riseMs
              sample.slewFallMs = m.slew.fallMs
              break
            case 'envelope':
              sample.envelopeSustain = m.envelope.sustainLevel
              break
            case 'ramp':
              sample.rampCurvePct = m.ramp.curvePct
              sample.rampMs = m.ramp.rampMs
              break
            case 'arpeggiator':
              sample.arpMode = m.arpeggiator.arpMode
              break
            case 'gesture':
              sample.gestureWiggle = m.gesture?.wiggle
              // Live playhead position — GestureEditor draws a dot at
              // (gesturePlayheadX, gesturePlayheadY) on the XY canvas
              // so the user sees the curve being traced in real time.
              sample.gesturePlayheadX = ts.gestureX
              sample.gesturePlayheadY = ts.gestureY
              break
          }
          this.onMod1Live(sample)
        }
      }

      // Advance sequencer step. The advance logic is mode-aware: most
      // modes just count seqStepIdx upward (mod steps) like classic
      // step / euclidean; Drift replaces the counter with a Brownian
      // playhead; Cellular mutates the row at every cycle wrap; Ratchet
      // re-rolls its subdivision count at every step.
      let ratchetForceRetrigger = false
      // Hoisted out of the sequencer-advance block so the MIDI Note
      // edge detector at the bottom of this iteration can read it —
      // any step advance (sequencer enabled or not) qualifies as a
      // Note On edge for cells with MIDI Note kind.
      let stepChanged = false
      if (cell.sequencer.enabled && !ts.stopping && cell.sequencer.mode === 'adresse') {
        // Address mode — clock is bypassed entirely; the playhead is
        // READ from a modulator's normalised output. floor(mod * N)
        // picks the active step, so a smooth modulator (LFO, Strange
        // Attractor) scrubs through the step values like a quantised
        // wavetable scanner; a stepped modulator (S&H, Random)
        // teleports between steps. Inspired by the Buchla 245
        // sequential voltage source.
        //
        // Sub-mode picks WHICH modulator drives the playhead:
        //   'hijack'  (default) — Modulation 1 is consumed entirely as
        //                         the playhead; addressed step emits
        //                         as-is (no extra modulation on top).
        //   'parallel'          — Modulation 1 drives the playhead AND
        //                         continues modulating the addressed
        //                         step's value (set in the slot loop).
        //   'stage2'            — Modulation 2 drives the playhead
        //                         while Modulation 1 modulates the
        //                         addressed step's value as normal.
        //                         Falls back to Mod 1 if Mod 2 is off
        //                         so the dropdown is never a silent
        //                         no-op.
        const stepsA = effectiveSteps(cell)
        const subMode = cell.sequencer.adresseMode ?? 'hijack'
        const useMod2ForAddress =
          subMode === 'stage2' && cell.modulation2?.enabled === true
        let modAddrUnit = 0.5
        if (useMod2ForAddress) {
          // mod2NormBipolar was computed above (hoisted). Map [-1,+1]
          // → [0,1].
          modAddrUnit = (mod2NormBipolar + 1) / 2
        } else if (cell.modulation.enabled) {
          const norm = computeModNorm(
            cell.modulation,
            ts,
            this.tickIdx,
            (t - ts.triggerTime) / 1000,
            this.currentSceneDurationSec(ts.activeSceneId),
            this.session.globalBpm
          )
          // Map bipolar -1..1 to 0..1; unipolar already 0..1.
          modAddrUnit = cell.modulation.mode === 'bipolar' ? (norm + 1) / 2 : norm
        }
        const clampedAddr = Math.max(0, Math.min(0.99999, modAddrUnit))
        const newIdx = Math.max(0, Math.min(stepsA - 1, Math.floor(clampedAddr * stepsA)))
        if (newIdx !== ts.seqStepIdx) {
          ts.seqLastStepIdx = ts.seqStepIdx
          ts.seqStepIdx = newIdx
          stepChanged = true
        }
      } else if (cell.sequencer.enabled && !ts.stopping) {
        // Resolve the step duration based on the sequencer's Sync mode.
        //   'bpm'   — lock to the session's global BPM
        //   'tempo' — use the sequencer's per-clip bpm slider
        //   'free'  — use the per-clip stepMs
        const syncMode = cell.sequencer.syncMode as 'bpm' | 'tempo' | 'free'
        const stepDurMs =
          syncMode === 'bpm'
            ? 60000 / Math.max(1, this.session.globalBpm)
            : syncMode === 'tempo'
              ? 60000 / Math.max(1, cell.sequencer.bpm)
              : Math.max(1, cell.sequencer.stepMs)
        // Effective step count — Draw mode uses drawSteps (up to 64);
        // other modes use steps (up to 16). Drives the wrap modulus
        // and the cycle-range precompute.
        const steps = effectiveSteps(cell)
        // Per-iteration step duration. Most modes use a uniform
        // stepDurMs; Bounce substitutes a geometrically-shrinking
        // duration tied to the current step index, producing the
        // accelerating "ball settling on the floor" cadence.
        const currentStepDur = (idx: number): number =>
          cell.sequencer.mode === 'bounce'
            ? bounceStepDuration(
                stepDurMs,
                Math.max(1, Math.min(16, cell.sequencer.steps)),
                cell.sequencer.bounceDecay,
                idx
              )
            : stepDurMs
        while (t - ts.seqStepStart >= currentStepDur(ts.seqStepIdx)) {
          ts.seqStepStart += currentStepDur(ts.seqStepIdx)
          ts.seqLastStepIdx = ts.seqStepIdx
          if (cell.sequencer.mode === 'drift') {
            // Brownian playhead — the visible "current step" is the
            // walker's position, not a fixed counter. Reuse seqStepIdx
            // for emitState so the inspector preview can highlight it.
            const rng = ts.seqRng ?? Math.random
            ts.seqDriftPos = advanceDrift(
              ts.seqDriftPos,
              steps,
              cell.sequencer.bias,
              cell.sequencer.edge,
              rng
            )
            ts.seqStepIdx = ts.seqDriftPos
          } else {
            ts.seqStepIdx = (ts.seqStepIdx + 1) % steps
            // Cellular: at the wrap point, evolve the row through one
            // Wolfram iteration. Done at wrap (not every step) so the
            // row stays stable through one full cycle of values, then
            // mutates audibly at the cycle boundary.
            // Draw + Generative — regenerate the variation curve at
            // each cycle wrap so the user hears a new pattern based
            // on their drawing, not the same loop repeating.
            if (
              cell.sequencer.mode === 'draw' &&
              cell.sequencer.generative &&
              ts.seqStepIdx === 0 &&
              ts.seqLastStepIdx >= 0
            ) {
              ts.drawGenCycle++
              ts.drawGeneratedValues = generateDrawCurve(cell, ts.drawGenCycle)
              if (cell.scaleToUnit) ts.seqGenRanges = computeCycleRanges(cell, ts)
            }
            if (
              cell.sequencer.mode === 'cellular' &&
              ts.seqStepIdx === 0 &&
              ts.seqLastStepIdx >= 0
            ) {
              // If the Seed LFO is on, re-seed the row from the
              // modulated seed instead of evolving — this is what
              // produces the "slowly wandering pattern" feel. With
              // the LFO off, evolve via the Wolfram rule as before.
              if (cell.sequencer.cellularSeedLfoDepth > 0) {
                ts.seqCellRow = cellularInitialRow(
                  modulatedCellSeed(cell.sequencer, t),
                  Math.max(1, Math.min(16, cell.sequencer.steps))
                )
              } else {
                ts.seqCellRow = evolveCellular(
                  ts.seqCellRow,
                  cell.sequencer.rule,
                  Math.max(1, Math.min(16, cell.sequencer.steps))
                )
              }
              // Cycle wrap → recompute the cycle's value range so
              // scaleToUnit auto-range tracks the evolving pattern.
              if (cell.scaleToUnit) ts.seqGenRanges = computeCycleRanges(cell, ts)
            }
          }
          // Ratchet — roll a fresh subdivision count for this new step.
          // Per-step probability + maxDiv blend the global values with
          // per-step hashes, shaped by the Variation knob (0 = uniform,
          // 100 = fully random per step). The PRNG roll still decides
          // whether to actually fire a burst.
          if (cell.sequencer.mode === 'ratchet') {
            const rng = ts.seqRng ?? Math.random
            const stepParams = ratchetStepParams(cell.sequencer, ts.seqStepIdx)
            const prob = stepParams.prob / 100
            const maxDiv = stepParams.maxDiv
            if (prob > 0 && rng() < prob) {
              ts.seqRatchetSubdiv = 2 + Math.floor(rng() * (maxDiv - 1))
            } else {
              ts.seqRatchetSubdiv = 1
            }
            ts.seqRatchetSubIdx = 0
            ts.seqRatchetSubStart = ts.seqStepStart
          }
          stepChanged = true
        }
        // Ratchet sub-pulse loop — within a step that's currently
        // bursting, fire a "force retrigger" pulse at every subdivision
        // boundary. The send paths below honour ratchetForceRetrigger
        // by bypassing string-dedupe (so a held string value re-fires)
        // and re-emitting numerics even when value math says no change.
        if (
          cell.sequencer.mode === 'ratchet' &&
          ts.seqRatchetSubdiv > 1 &&
          !ts.stopping
        ) {
          // Use the CURRENT step's actual duration — Bounce mode
          // shrinks step duration geometrically as the ball
          // "settles", so a sub-pulse divided against the constant
          // `stepDurMs` would overshoot the real step boundary on
          // bouncier steps. Asking `currentStepDur(ts.seqStepIdx)`
          // returns either stepDurMs (most modes) or the
          // bounce-shaped duration (bounce mode), so this works
          // uniformly across modes.
          const subDur = currentStepDur(ts.seqStepIdx) / ts.seqRatchetSubdiv
          while (
            ts.seqRatchetSubIdx < ts.seqRatchetSubdiv - 1 &&
            t - ts.seqRatchetSubStart >= subDur
          ) {
            ts.seqRatchetSubStart += subDur
            ts.seqRatchetSubIdx++
            ratchetForceRetrigger = true
          }
        }
        if (stepChanged) this.emitState()
      }

      // Per-mode gate evaluation. Some modes (steps, drift, ratchet)
      // never mute on their own; others (euclidean, polyrhythm, density,
      // cellular) gate based on the current step.
      const seqMuted =
        cell.sequencer.enabled &&
        (() => {
          const steps = Math.max(1, Math.min(16, cell.sequencer.steps))
          const idx = ts.seqStepIdx % steps
          switch (cell.sequencer.mode) {
            case 'euclidean': {
              const pulses = Math.max(0, Math.min(steps, cell.sequencer.pulses))
              const pat = euclidean(pulses, steps, cell.sequencer.rotation)
              return !pat[idx]
            }
            case 'polyrhythm':
              return !polyrhythmGate(
                idx,
                cell.sequencer.ringALength,
                cell.sequencer.ringBLength,
                cell.sequencer.combine
              )
            case 'density':
              return !densityGate(idx, cell.sequencer.seed, cell.sequencer.density)
            case 'cellular':
              return ((ts.seqCellRow >>> idx) & 1) === 0
            // steps / drift / ratchet always emit (subject to value parsing).
            default:
              return false
          }
        })()
      if (seqMuted) {
        // No OSC output this tick. Advance stopping-morph so Stop still
        // resolves on schedule, and move on to the next track.
        if (ts.stopping) {
          const morphP = ts.morphMs > 0 ? clamp((t - ts.morphStart) / ts.morphMs, 0, 1) : 1
          if (morphP >= 1) this.disarm(ts)
        }
        continue
      }

      // Resolve the base value string. Four branches handled in the
      // shared helper: sequencer off → cell.value; Draw mode →
      // drawValues[i] × token; generative → per-mode live rule;
      // classic → stepValues[i] lookup.
      const baseRaw = resolveStepBaseRaw(
        cell,
        ts,
        ts.seqStepIdx,
        ts.seqRatchetSubIdx,
        ts.seqRatchetSubdiv
      )

      // Morph progress (transition only applies on scene change, not step changes).
      const morphP = ts.morphMs > 0 ? clamp((t - ts.morphStart) / ts.morphMs, 0, 1) : 1

      // Parse tokens. Each token becomes one OSC arg; modulation & scaling
      // apply per-token for numeric ones, strings/bools pass through.
      const tokens = parseValueTokens(baseRaw)
      if (tokens.length === 0) {
        if (ts.stopping && morphP >= 1) this.disarm(ts)
        continue
      }
      const perTokenSeq = tokens.map((t) => autoDetectOscArg(t))

      // ── Multi-arg + sequencer + pin merge ──────────────────────────
      // When a Track snapshots an argSpec with N slots (e.g. OCTOCOSME
      // "Voice Pots" with four pots per voice), the cell normally
      // emits N OSC args. But the sequencer's per-step value is a
      // single string — typically with FEWER tokens than the slot
      // count (the user types "0.5" not "0.5 0.5 0.5 0.5"). Left
      // alone, the engine would only emit one arg per step and the
      // multi-arg cell's pinned slots would never be re-asserted.
      //
      // Fix: pad `perToken` up to argSpec.length when the cell is
      // multi-arg AND a sequencer is active. For each slot:
      //   - pinned slot          → token sourced from
      //                            track.persistentValues[i] so the
      //                            pin survives the sequencer entirely
      //   - present in seq value → use the sequenced token at that
      //                            slot (per-slot variation when the
      //                            user types a multi-token step)
      //   - single seq token     → broadcast to every unpinned slot
      //                            (the common case — one step value
      //                             drives all unpinned pots together)
      //   - otherwise            → fall back to the cell's original
      //                            multi-arg value at that slot
      //
      // The per-arg pin override at l.~1920 still runs and re-asserts
      // the pinned value AFTER modulation, so even if a modulator
      // wobbles the padded token mid-tick the emitted value stays
      // frozen. The padding here only guarantees that ALL slots get
      // iterated in the emit loop below.
      const slotCount = track?.argSpec?.length ?? 0
      const persistArrPad = track?.persistentSlots
      const persistValsPad = track?.persistentValues
      const cellPersistArrPad = cell.persistentSlots
      const cellPersistValsPad = cell.persistentValues
      let perToken = perTokenSeq
      if (
        cell.sequencer.enabled &&
        slotCount > perTokenSeq.length &&
        slotCount > 0
      ) {
        const originalTokens = parseValueTokens(cell.value)
        const padded: typeof perTokenSeq = new Array(slotCount)
        const specForPad = track?.argSpec
        for (let i = 0; i < slotCount; i++) {
          // Fixed argSpec slot (protocol header like 'compositor' or
          // 0) — emit the declared fixed value regardless of what the
          // sequencer or pin says. The per-token emit loop below ALSO
          // checks `fixed` and re-asserts the value, but stamping it
          // here keeps the rest of the pipeline (stepTargets,
          // modulator center, lastSentNumeric) consistent.
          const specEntryPad = specForPad?.[i]
          if (specEntryPad?.fixed !== undefined) {
            padded[i] = formatFixedAsOscArg(specEntryPad)
            continue
          }
          // Cell-level pin override beats track-level. Three states
          // per slot — true (use cell value), false (unpinned even
          // if track says pinned), undefined (track default).
          const cellOverridePad = cellPersistArrPad?.[i]
          let pinned = false
          let pinnedRaw: string | undefined
          if (cellOverridePad === true) {
            pinned = cellPersistValsPad?.[i] !== undefined
            pinnedRaw = cellPersistValsPad?.[i]
          } else if (cellOverridePad === false) {
            pinned = false
          } else {
            pinned =
              persistArrPad?.[i] === true &&
              persistValsPad?.[i] !== undefined
            if (pinned) pinnedRaw = persistValsPad?.[i]
          }
          if (pinned && pinnedRaw !== undefined) {
            // Slot is pinned — seed perToken from the pinned token so
            // the slot is present in the emit loop. The pin override
            // at l.~1920 will re-clamp `out` back to this value after
            // modulation runs.
            padded[i] = autoDetectOscArg(pinnedRaw)
          } else if (i < perTokenSeq.length) {
            // Sequencer produced a per-slot token — use it.
            padded[i] = perTokenSeq[i]
          } else if (perTokenSeq.length === 1) {
            // Single sequenced value: broadcast it to every unpinned
            // slot. This is the common case ("sequence all pots
            // together") and matches what the inspector preview shows
            // when the step value is a single number.
            padded[i] = perTokenSeq[0]
          } else if (i < originalTokens.length) {
            // Fewer sequencer tokens than slots, but more than one —
            // fall back to the cell's original multi-arg value for
            // the trailing slots so the OSC bundle keeps its full
            // arg count.
            padded[i] = autoDetectOscArg(originalTokens[i])
          } else {
            // No source for this slot — emit a neutral 0 float rather
            // than a malformed short bundle.
            padded[i] = { type: 'f', value: 0 }
          }
        }
        perToken = padded
      }
      const hasNumeric = perToken.some((a) => a.type === 'i' || a.type === 'f')

      // Pure string/bool path — send on change, no morph math.
      if (!hasNumeric) {
        const stepKey = cell.sequencer.enabled ? ts.seqStepIdx : -1
        const changed =
          ts.lastSentString !== baseRaw ||
          ts.lastStringAtSceneId !== ts.activeSceneId ||
          ts.lastStringAtStep !== stepKey
        // Ratchet sub-pulses retrigger the same step value: bypass dedupe
        // so the string/bool re-fires within the step.
        if (morphP >= 1 && (changed || ratchetForceRetrigger)) {
          if (oscEmitAllowed) {
            this.sender.sendMany(
              cell.destIp,
              cell.destPort,
              cell.oscAddress,
              perToken.map((a) => ({ type: a.type, value: a.value }))
            )
          }
          ts.lastSentString = baseRaw
          ts.lastStringAtSceneId = ts.activeSceneId
          ts.lastStringAtStep = stepKey
        }
        this.recordLiveValue(ts.activeSceneId ?? '', trackId, baseRaw)
        if (ts.stopping && morphP >= 1) this.disarm(ts)
        continue
      }

      // Mixed / numeric path.
      // Compute the modulation signal. LFO uses an additive signal (modNorm
      // in -1..1 or 0..1 depending on mode). Envelope is multiplicative —
      // naturally 0..1 (a VCA-style gain). Multi-arg Value entries all share
      // the same signal.
      let modNorm = 0
      let envGain = 1
      let rampGain = 1
      if (cell.modulation.enabled && !ts.stopping) {
        if (cell.modulation.type === 'envelope') {
          envGain = computeEnvelopeGain(
            cell.modulation.envelope,
            (t - ts.triggerTime) / 1000,
            this.currentSceneDurationSec(ts.activeSceneId)
          )
        } else if (cell.modulation.type === 'ramp') {
          // Mode change while playing → reset triggerTime so the new
          // mode's curve fires from t=0 immediately. Without this,
          // toggling Normal → Inverted on a clip that's already past
          // its rampMs would settle at the new mode's END value and
          // never visibly transition — looks like "Inverted does
          // nothing" to the user.
          const currentMode = cell.modulation.ramp.mode ?? 'normal'
          if (
            ts.prevRampMode !== null &&
            ts.prevRampMode !== currentMode
          ) {
            ts.triggerTime = t
          }
          ts.prevRampMode = currentMode
          rampGain = computeRampGain(
            cell.modulation.ramp,
            (t - ts.triggerTime) / 1000,
            this.currentSceneDurationSec(ts.activeSceneId)
          )
        } else {
          // Modulator isn't Ramp — clear the tracker so a future
          // re-enable of Ramp triggers a fresh ramp regardless of
          // history.
          ts.prevRampMode = null
          modNorm = computeModNorm(
            cell.modulation,
            ts,
            this.tickIdx,
            (t - ts.triggerTime) / 1000,
            this.currentSceneDurationSec(ts.activeSceneId),
            this.session.globalBpm
          )
        }
      }
      // Routing matrix per-slot "Modulation 2" gate. When Modulation 2
      // is enabled AND any slot has its Modulation 2 routing ticked
      // OFF, we compute a SECOND modNorm using the ORIGINAL
      // Modulation 1 (pre-Mod 2-apply). Per-slot the loop below
      // picks which one drives that slot. We bail out of the
      // computation when nothing routes to "original" so the common
      // path stays a single computeModNorm call.
      let modNormOriginal = modNorm
      // Original-ramp gain for unrouted slots. Mod 2 → Rate patches the
      // ramp timing (rampMs / totalMs), so a slot with Mod 2 routing
      // OFF needs the gain recomputed from the ORIGINAL ramp params.
      // Envelope needs no equivalent — its shape is never patched, so
      // `envGain` is already Mod-2-independent (only depth is gated, in
      // the per-slot loop). Defaults to `rampGain` so the common path is
      // untouched.
      let rampGainOriginal = rampGain
      const anySlotBypassesMod2 =
        cell.modulation2?.enabled === true &&
        Array.isArray(cell.routing?.modulation2) &&
        cell.routing!.modulation2!.some((b) => b === false)
      if (anySlotBypassesMod2) {
        if (
          cell.modulation.enabled &&
          !ts.stopping &&
          cell.modulation.type !== 'envelope' &&
          cell.modulation.type !== 'ramp'
        ) {
          modNormOriginal = computeModNorm(
            mod1OriginalForSlots,
            ts,
            this.tickIdx,
            (t - ts.triggerTime) / 1000,
            this.currentSceneDurationSec(ts.activeSceneId),
            this.session.globalBpm
          )
        } else if (
          cell.modulation.enabled &&
          !ts.stopping &&
          cell.modulation.type === 'ramp'
        ) {
          rampGainOriginal = computeRampGain(
            mod1OriginalForSlots.ramp,
            (t - ts.triggerTime) / 1000,
            this.currentSceneDurationSec(ts.activeSceneId)
          )
        }
      }

      // Per-token targets (numeric) — baseline for center computation.
      // When scaleToUnit is on AND a sequencer is active, DON'T pre-
      // clamp here — the auto-range path below will normalise the
      // value into [0, 1] using the cycle's actual min/max. Pre-
      // clamping would zero out anything > 1 before auto-range ever
      // saw it, defeating the whole "scale 0..2 to 0..1" intent.
      const stepTargetsRaw = perToken.map((a) =>
        a.type === 'i' || a.type === 'f' ? (a.value as number) : null
      )
      const stepTargets =
        cell.scaleToUnit && !cell.sequencer.enabled
          ? stepTargetsRaw.map((v) => (v === null ? null : clamp01(v)))
          : stepTargetsRaw

      const outs: Array<{ type: 'i' | 'f' | 's' | 'T' | 'F'; value: unknown }> = []
      const liveParts: string[] = []

      // Track whether ANY token's emitted value differs from the
      // last sent. Drives the Hold rest-behaviour gate below — when
      // restBehaviour='hold' AND nothing changed, skip the OSC send
      // so the receiver naturally holds its previous value (no
      // redundant traffic, no re-triggering).
      const sentValuesBefore = ts.lastSentNumeric.slice()
      const newFinalVals: number[] = []
      const trackArgSpec = track?.argSpec
      // (v0.6.x) Motion Loop — sample this cell's recorded data loop
      // once per emit (returns per-slot values or null). Applied per
      // slot in the loop below, after the HW override.
      const loopSample = this.sampleRecordedLoop(cell, t)
      for (let idx = 0; idx < perToken.length; idx++) {
        const a = perToken[idx]
        // ── Fixed argSpec slot — protocol header ──────────────────
        // `argSpec[idx].fixed` declares "this slot ALWAYS emits this
        // value" (Pure Data's `list split 2` etc.). Sequencer and
        // modulator must not touch it; the slot bypasses the entire
        // center / morph / mod / scaleToUnit pipeline and emits the
        // declared `fixed` token verbatim. Without this short-circuit
        // the multi-arg sequencer pad would broadcast its step value
        // over fixed slots, breaking the receiver's split.
        const specEntry = trackArgSpec?.[idx]
        if (specEntry?.fixed !== undefined) {
          const fv = specEntry.fixed
          if (typeof fv === 'string') {
            outs.push({ type: 's', value: fv })
            liveParts.push(fv)
          } else if (typeof fv === 'boolean') {
            // Pure Data + most splitters expect 0/1 for booleans —
            // serialise as int rather than osc 'T'/'F' to match the
            // `buildInitialValueFromArgSpec` token format.
            const n = fv ? 1 : 0
            outs.push({ type: 'i', value: n })
            liveParts.push(String(n))
            newFinalVals.push(n)
          } else {
            const n = Number(fv)
            const isInt = Number.isInteger(n) || specEntry.type === 'int'
            outs.push({ type: isInt ? 'i' : 'f', value: isInt ? Math.round(n) : n })
            liveParts.push(isInt ? String(Math.round(n)) : n.toFixed(3))
            newFinalVals.push(isInt ? Math.round(n) : n)
          }
          continue
        }
        if (a.type === 's' || a.type === 'T' || a.type === 'F') {
          outs.push({ type: a.type, value: a.value })
          liveParts.push(String(a.value))
          continue
        }
        // Routing matrix lookups. `routing.sequencer[i]` and
        // `routing.modulator[i]` each default to `true` (= routed).
        // The user can untick either to gate that direction OUT for
        // the slot — sequencer-off means "use cell.value seed
        // instead of the step value"; modulator-off means "skip the
        // modulator contribution to `out`". argSpec.fixed and pin
        // still beat both routings (handled elsewhere).
        //
        // Per-slot Delay (ms) acts as a SECOND gate on both
        // directions: the slot is considered "not routed yet" until
        // `delay` ms have elapsed since the trigger. After that the
        // user's tick state takes over.
        const slotDelayMs = cell.routing?.delays?.[idx] ?? 0
        const slotPostDelay =
          slotDelayMs <= 0 || t - ts.triggerTime >= slotDelayMs
        const routingSeqOn =
          slotPostDelay && cell.routing?.sequencer?.[idx] !== false
        const routingModOn =
          slotPostDelay && cell.routing?.modulator?.[idx] !== false
        // Variation multiplier — stable random in [-1, 1] sampled at
        // trigger, scaled by the user's 0..100% knob. 0% = identical
        // across slots; 100% = each slot's modulator amplitude varies
        // randomly in [0×, 2×] the base contribution. Adds slight
        // de-tune across multi-arg cells without affecting the
        // direction (a positive factor brightens, negative darkens).
        const variationPct = cell.routing?.variations?.[idx] ?? 0
        const variationFactor =
          variationPct > 0
            ? 1 + (ts.routingVariationFactors[idx] ?? 0) * (variationPct / 100)
            : 1
        // When the sequencer is on AND routed for this slot, use the
        // step value as the target. Otherwise (sequencer off OR
        // unrouted), fall back to the cell.value seed parsed from
        // the user's static value field.
        const seqDrivesSlot = cell.sequencer.enabled && routingSeqOn
        const seedArg = perToken[idx]
        const seedVal =
          seedArg && (seedArg.type === 'i' || seedArg.type === 'f')
            ? (seedArg.value as number)
            : 0
        const target = seqDrivesSlot ? stepTargets[idx] ?? 0 : seedVal
        // Center: with sequencer driving this slot, center jumps to
        // step value (still honoring the initial morph-in after
        // trigger). Otherwise center follows the morph between the
        // cell.value seed endpoints.
        let center: number
        if (seqDrivesSlot) {
          const from = ts.fromCenter[idx] ?? 0
          center = morphP < 1 ? from + (target - from) * morphP : target
        } else {
          const from = ts.fromCenter[idx] ?? 0
          const to = ts.toCenter[idx] ?? target
          center = from + (to - from) * morphP
        }

        // Scaling PRE — clamp the raw seed BEFORE the modulator /
        // sequencer ever sees it. The whole downstream chain then
        // operates within the clamped band. Counterpart to the POST
        // clamp further down (which clamps the FINAL `out`).
        if (cell.scalingEnabled && (cell.scalingMode ?? 'post') === 'pre') {
          const sMin = cell.scalingMin?.[idx]
          const sMax = cell.scalingMax?.[idx]
          if (
            typeof sMin === 'number' &&
            Number.isFinite(sMin) &&
            typeof sMax === 'number' &&
            Number.isFinite(sMax)
          ) {
            const lo = sMin <= sMax ? sMin : sMax
            const hi = sMin <= sMax ? sMax : sMin
            if (center < lo) center = lo
            else if (center > hi) center = hi
          }
        }

        // scaleToUnit auto-range — instead of blunt clamp([0, 1]),
        // remap the cycle's value range to [0, 1] so the user sees
        // full-range output even when the seed produces values >1
        // (or <0). Range is precomputed at trigger + at every cycle
        // wrap, so cellular's evolving pattern stays in scope.
        // Only applies when sequencer is enabled — non-sequencer
        // cells use the classic clamp01 path below.
        if (
          cell.scaleToUnit &&
          cell.sequencer.enabled &&
          ts.seqGenRanges[idx]
        ) {
          const r = ts.seqGenRanges[idx]
          const span = r.max - r.min
          if (span > 1e-9) {
            center = (center - r.min) / span
          } else {
            // Degenerate (all step values identical, OR a single
            // repeated step). Previously we forced 0.5 so SOMETHING
            // showed up — but that was misleading when the user
            // intended e.g. a constant 0 or 1. Instead, clamp the
            // user's actual value into [0, 1] and emit that, so a
            // sequencer with one repeated "1" stays at 1, a repeated
            // "0" stays at 0, and a repeated "0.42" stays at 0.42.
            center = center < 0 ? 0 : center > 1 ? 1 : center
          }
        }

        let out = center
        // Routing-modulator OFF for this slot short-circuits every
        // modulator branch below — `out` stays at `center` (the
        // seed / step value). We still enter the block so the
        // sequencer's step-change side effects (e.g. liveDisplay)
        // fire normally elsewhere; just the contribution to `out`
        // is suppressed.
        if (cell.modulation.enabled && !ts.stopping && routingModOn) {
          if (cell.modulation.type === 'envelope') {
            // Multiplicative envelope, depth-mixed. depth=0% → no effect
            // (output = center); depth=100% → full VCA shape (out = center * env).
            // Routing.modulation2 per-slot gate — see arpeggiator branch
            // below. Mod 2 only patches `depthPct` for envelope (the
            // envelope shape itself is never patched, so `envGain` is
            // already Mod-2-independent); using the original depth for an
            // unrouted slot fully removes Mod 2's effect there.
            const slotMod2On =
              cell.modulation2?.enabled !== true ||
              cell.routing?.modulation2?.[idx] !== false
            const depthSlot = slotMod2On
              ? cell.modulation.depthPct
              : mod1OriginalForSlots.depthPct
            const depth01 = depthSlot / 100
            out = center * (1 - depth01 + depth01 * envGain)
          } else if (cell.modulation.type === 'ramp') {
            // One-shot 0→1 ramp, depth-mixed identically to envelope. Once
            // the ramp completes, rampGain stays at 1 so the output settles
            // at `center` (modulator becomes neutral, as requested).
            // Routing.modulation2 per-slot gate — Mod 2 can patch BOTH the
            // ramp depth (`depthPct`) AND the ramp timing (`ramp.rampMs` /
            // `totalMs`, which feeds `rampGain`). For an unrouted slot use
            // the original depth AND the original-ramp gain so Mod 2 has
            // zero effect there.
            const slotMod2On =
              cell.modulation2?.enabled !== true ||
              cell.routing?.modulation2?.[idx] !== false
            const depthSlot = slotMod2On
              ? cell.modulation.depthPct
              : mod1OriginalForSlots.depthPct
            const rampGainSlot = slotMod2On ? rampGain : rampGainOriginal
            const depth01 = depthSlot / 100
            out = center * (1 - depth01 + depth01 * rampGainSlot)
          } else if (cell.modulation.type === 'arpeggiator') {
            // Arp: ladder built fresh per token from this token's center so
            // multi-arg Value ("10 20") arps each token independently.
            const arp = cell.modulation.arpeggiator
            const N = Math.max(1, Math.min(8, arp.steps))
            let ladder = buildArpLadder(center, N, arp.multMode)
            let dryCenter = center
            // When Scale 0.0-1.0 is on with arp, NORMALIZE the ladder so the
            // largest magnitude maps to 1.0. Keeps the proportional shape of
            // Multiplication/Div/Mult mode intact instead of collapsing to a
            // flat 1.000 when any ladder value > 1.
            if (cell.scaleToUnit) {
              const maxAbs = ladder.reduce(
                (m, v) => (Math.abs(v) > m ? Math.abs(v) : m),
                0
              )
              if (maxAbs > 0) {
                ladder = ladder.map((v) => v / maxAbs)
                dryCenter = center / maxAbs
              }
            }
            const stepVal =
              ladder[Math.max(0, Math.min(N - 1, ts.arpStepIdx))] ?? dryCenter
            // Routing.modulation2 per-slot gate: pick the original
            // (pre-Mod 2) depthPct for this slot when Mod 2 routing
            // is unticked. Default (undefined / true) keeps the
            // effective depth — current behavior.
            const slotMod2On =
              cell.modulation2?.enabled !== true ||
              cell.routing?.modulation2?.[idx] !== false
            const depthSlot = slotMod2On
              ? cell.modulation.depthPct
              : mod1OriginalForSlots.depthPct
            const depth01 = depthSlot / 100
            // depth=100% replaces base with arp value; depth=0% leaves base.
            // Routing-modulator OFF for this slot → bypass the arp
            // contribution entirely, emit the dry centre. Variation
            // scales the arp-vs-dry mix amount.
            out = routingModOn
              ? dryCenter * (1 - depth01 * variationFactor) +
                stepVal * depth01 * variationFactor
              : dryCenter
          } else {
            // Routing.modulation2 per-slot gate — see arpeggiator
            // branch above for the same idea. When the slot has
            // Modulation 2 routed OFF, the magnitude uses the
            // original (pre-Mod 2) depthPct and the modNorm comes
            // from the original-Modulation-1 computation we ran
            // earlier in the tick.
            const slotMod2On =
              cell.modulation2?.enabled !== true ||
              cell.routing?.modulation2?.[idx] !== false
            const depthSlot = slotMod2On
              ? cell.modulation.depthPct
              : mod1OriginalForSlots.depthPct
            const magnitude =
              Math.max(Math.abs(center), 1) * (depthSlot / 100)
            const modNormForSlot = slotMod2On ? modNorm : modNormOriginal
            // Strange Attractor — per-slot channel fan-out. Slot 0
            // gets X (the primary motion axis); slot 1 Y, slot 2 Z,
            // slot 3 W (= speed-breath for 3D types, native W for
            // 4D). Slots ≥ 4 keep the last channel. Mode (uni / bi)
            // travels through the channel helper.
            const slotModNorm =
              cell.modulation.type === 'attractor'
                ? attractorChannelFor(ts, idx, cell.modulation.mode)
                : cell.modulation.type === 'gesture'
                  ? gestureChannelFor(
                      ts,
                      idx,
                      cell.modulation.mode,
                      cell.modulation.gesture?.mode ?? 'xy'
                    )
                  : modNormForSlot
            // Adresse mode `hijack` (default) — the modulator is
            // CONSUMED entirely as the playhead position; the step
            // value emits as-is, NO additional modulation. `parallel`
            // adds the modulator on top of the addressed step.
            const adresseMode = cell.sequencer.adresseMode ?? 'hijack'
            const adresseHijack =
              cell.sequencer.enabled &&
              cell.sequencer.mode === 'adresse' &&
              adresseMode === 'hijack'
            // Routing gates the modulator contribution out for this
            // slot when the user unticked the Modulator row in the
            // Routing matrix. Combined with the sequencer-routing
            // toggle above, the user can dial individual slots
            // independent of either driver.
            // Per-slot Variation multiplier scales the contribution
            // so multi-arg cells get "similar but slightly different"
            // motion across slots.
            if (adresseHijack || !routingModOn) {
              out = center
            } else {
              out = center + slotModNorm * magnitude * variationFactor
            }
          }
        }
        // ── Modulation 2 → Value (direct) ─────────────────────────
        // Mod 2's bipolar signal applied STRAIGHT to this slot's
        // value — same pipeline stage as Mod 1's contribution above
        // (before Scaling POST / scaleToUnit / Int Scale / pitch
        // snap / HW override / pin, and scalingMode 'pre' already
        // clamped `center` upstream exactly as it does for Mod 1).
        // Gated per slot by `routing.modulation2Direct[idx]`, which —
        // UNLIKE every other routing array — defaults FALSE
        // (missing = unrouted), so the explicit `=== true` check is
        // load-bearing. The per-slot Delay gate (slotPostDelay) and
        // Variation factor apply to this contribution exactly as
        // they do to the Mod 1 / Sequencer ones.
        //
        // Intensity comes from Mod 2's DEDICATED `valueAmount`
        // (0..1, default 0.5) — NOT its Depth knob. The magnitude
        // scaling mirrors Mod 1's non-arp branch:
        // max(|center|, 1) so near-zero seeds still move.
        //
        // Combination with the Mod 1-modulated value follows
        // `valueMath`, mirroring the M2>1 ModulationTargetMode
        // semantics (applyMod2ToMod1):
        //   add  — sum the offsets:  out += m2Offset
        //          (additive: base + mod2 × range × amount)
        //   mult — multiplicative:   out ×= 1 + mod2 × amount
        //          (base × (1 + mod2 × amount))
        //   mix  — 50/50 crossfade between the Mod 1-modulated value
        //          and the Mod 2-only-modulated value (center +
        //          m2Offset).
        // A slot with BOTH M2-direct and M2>1 routed receives Mod 2
        // twice (directly + through Mod 1's params) — documented
        // stacking, no mutual exclusion.
        if (
          cell.modulation2?.enabled === true &&
          !ts.stopping &&
          slotPostDelay &&
          cell.routing?.modulation2Direct?.[idx] === true
        ) {
          const m2cfg = cell.modulation2
          const amtRaw = m2cfg.valueAmount ?? 0.5
          const amt = amtRaw < 0 ? 0 : amtRaw > 1 ? 1 : amtRaw
          const m2Offset =
            mod2NormBipolar *
            Math.max(Math.abs(center), 1) *
            amt *
            variationFactor
          const math = m2cfg.valueMath ?? 'add'
          if (math === 'mult') {
            out = out * (1 + mod2NormBipolar * amt * variationFactor)
          } else if (math === 'mix') {
            out = 0.5 * out + 0.5 * (center + m2Offset)
          } else {
            out = out + m2Offset
          }
        }
        // Smart scaleToUnit auto-range.
        // - Sequencer + scaleToUnit: normalise `out` to the cycle's
        //   actual value range (already handled — center was
        //   normalised above before modulation; final clamp01 keeps
        //   modulator wobble inside [0, 1]).
        // - Modulator + scaleToUnit (no sequencer): predict the
        // Per-arg Scaling clamp. Modes:
        //   POST (default) — clamps `out` AFTER modulator + sequencer
        //                    but BEFORE scaleToUnit + MIDI Scale. Tames
        //                    extreme outputs from generative sources.
        //   PRE            — handled earlier in the per-slot loop on
        //                    `center` (the raw seed) so the entire
        //                    downstream chain operates within the
        //                    clamped band. Skipped here.
        // Disabled by default. Arrays index parallel to argSpec slots;
        // missing entries skip the clamp.
        const scalingModeNow = cell.scalingMode ?? 'post'
        if (cell.scalingEnabled && scalingModeNow === 'post') {
          const sMin = cell.scalingMin?.[idx]
          const sMax = cell.scalingMax?.[idx]
          if (
            typeof sMin === 'number' &&
            Number.isFinite(sMin) &&
            typeof sMax === 'number' &&
            Number.isFinite(sMax)
          ) {
            // Tolerate min > max (user-typo): swap on the fly so
            // the clamp is always non-degenerate.
            const lo = sMin <= sMax ? sMin : sMax
            const hi = sMin <= sMax ? sMax : sMin
            if (out < lo) out = lo
            else if (out > hi) out = hi
          }
        }

        //   modulator's output range and normalise `out` into [0, 1]
        //   using THAT range. Means a Chaos modulator on a base of
        //   100 spans the full [0, 1] visually rather than clipping.
        // - Plain scaleToUnit (no mod, no seq): classic clamp01.
        if (cell.scaleToUnit) {
          const seqAutoRanged =
            cell.sequencer.enabled && ts.seqGenRanges[idx]
          if (!seqAutoRanged && cell.modulation.enabled && !ts.stopping) {
            const r = predictModRange(cell.modulation, center)
            const span = r.max - r.min
            if (span > 1e-9) {
              out = (out - r.min) / span
            }
          }
          out = clamp01(out)
        }

        // ── Int Scale ─────────────────────────────────────────────
        // Round to integer AFTER `scaleToUnit` but BEFORE pitch-snap /
        // HW override / pin / MIDI Scale. Per-cell toggle applied to
        // every arg slot independently. Combined with scaleToUnit it
        // produces a binary 0/1 OSC output (useful with the Spastic
        // LFO); without scaleToUnit it rounds the raw value to its
        // nearest integer (e.g. a 0..127 modulated value emits as
        // discrete int steps).
        if (cell.intScale) {
          out = Math.round(out)
        }

        // ── Pitch snap ────────────────────────────────────────────
        // After Scaling + scaleToUnit but BEFORE the pin override
        // (a pin is the user's explicit final-say and should ignore
        // the snap), quantise `out` to the nearest in-scale semitone
        // for the configured (root, scale) pair. We need a [0..1]
        // domain value for the note-window math, so the snap is
        // gated on `scaleToUnit || midiScale` exactly like the
        // MIDI emit path.
        //
        // After snapping, `out` is rewritten in the same [0..1]
        // space (snappedNote → (snappedNote - lo) / (hi - lo)). That
        // way:
        //   - OSC sees the quantised [0..1] value (stepped, one
        //     position per scale degree in the window).
        //   - MIDI Note's emit-time mapping rounds back to EXACTLY
        //     the same snappedNote we just computed — round-trip
        //     identity guaranteed.
        const ps = cell.pitchSnap
        const snapSlotIdx = ps?.slotIdx ?? 0
        if (
          ps &&
          ps.enabled &&
          idx === snapSlotIdx &&
          (cell.scaleToUnit || cell.midiScale)
        ) {
          // Resolve the note window from the cell's MidiOut. Use
          // sane defaults (C2..C6) when the user hasn't configured
          // a window yet — same behaviour as the MIDI emit path.
          const m = cell.midiOut
          const rawLo = typeof m?.noteMin === 'number' && Number.isFinite(m.noteMin) ? m.noteMin : 36
          const rawHi = typeof m?.noteMax === 'number' && Number.isFinite(m.noteMax) ? m.noteMax : 84
          const lo = Math.max(0, Math.min(127, Math.min(rawLo, rawHi)))
          const hi = Math.max(0, Math.min(127, Math.max(rawLo, rawHi)))
          const span = hi - lo
          if (span > 0) {
            const intervals = SCALE_INTERVALS[ps.scale] ?? SCALE_INTERVALS.chromatic
            const floatNote = lo + out * span
            const snapped = snapToScale(floatNote, intervals, ps.root | 0)
            // Renormalise back to [0..1] of the window. Clamp guards
            // against the snapper landing slightly outside the
            // window on edge cases (the search radius extends ±12
            // semitones even when the window is narrower).
            const reNorm = (snapped - lo) / span
            out = reNorm < 0 ? 0 : reNorm > 1 ? 1 : reNorm
          }
        }

        // ── Hardware Mode override ────────────────────────────────
        // If the user has Hardware Mode enabled on this track's
        // template AND this slot's catch state is `true`, the most
        // recent hardware value wins — overrides whatever the scene
        // / sequencer / modulator computed above. Sits AFTER pitch
        // snap (so the snap doesn't override a knob position the
        // user is dialing in) and BEFORE the pin (a pinned slot is
        // the user's explicit final-say and always wins).
        //
        // handleHardwareInput() populates hardwareCaught + hardwareOverride
        // on every incoming OSC packet from a bound device. This
        // emit-loop just reads the latest snapshot.
        const hwKey = `${trackId}|${idx}`
        const hwActiveForSlot = this.hardwareCaught.get(hwKey) === true
        if (hwActiveForSlot) {
          const hwVal = this.hardwareOverride.get(hwKey)
          if (typeof hwVal === 'number' && Number.isFinite(hwVal)) {
            out = hwVal
          }
        }

        // ── Recorded loop (Motion Loop) playback ──────────────────
        // When this scene's cell holds a playing recorded data loop,
        // the sampled value for this slot is the source (loop replaces
        // live). After the HW override so a recorded scene isn't fought
        // by a live catch; before the pin (the user's explicit final say).
        let loopActiveForSlot = false
        if (
          loopSample &&
          idx < loopSample.length &&
          Number.isFinite(loopSample[idx])
        ) {
          out = loopSample[idx]
          loopActiveForSlot = true
        }

        // Per-arg-position persistence — cell-level pin overrides
        // track-level pin overrides nothing. Three states per slot:
        //   cell.persistentSlots[idx] === true  → pinned, use cell.persistentValues[idx]
        //   cell.persistentSlots[idx] === false → forced UNpin (overrides track)
        //   cell.persistentSlots[idx] === undefined → track default applies
        // The track-level pin (Parameter Inspector) is the "default for
        // every clip on this row"; the cell-level (Cell Inspector) is
        // the per-clip override. Lets the user pin every captured slot
        // on Scene A and selectively unpin on Scene B without
        // affecting the other.
        const cellPersistArr = cell.persistentSlots
        const cellPersistVals = cell.persistentValues
        const cellOverride = cellPersistArr?.[idx]
        const trackPersistArr = track?.persistentSlots
        const trackPersistVals = track?.persistentValues
        let persistThis = false
        let pinnedTokenRaw: string | undefined
        if (cellOverride === true) {
          persistThis = true
          pinnedTokenRaw = cellPersistVals?.[idx]
        } else if (cellOverride === false) {
          // Explicit unpin — no pin regardless of track default.
          persistThis = false
        } else {
          // No cell-level opinion — fall back to track default.
          persistThis = !!trackPersistArr && trackPersistArr[idx] === true
          if (persistThis) pinnedTokenRaw = trackPersistVals?.[idx]
        }
        if (persistThis && pinnedTokenRaw !== undefined) {
          const parsed = parseFloat(pinnedTokenRaw)
          if (Number.isFinite(parsed)) {
            out = cell.scaleToUnit ? clamp01(parsed) : parsed
          }
        }

        // Pick send type. Default = argSpec.type unless modulation
        // / scaleToUnit force float. Hardware Mode override ALSO
        // forces float so a continuous knob 0..1 can produce
        // fractional values even when the captured argSpec said
        // 'i' — user reported the knob only outputting 0 or 1 on
        // int-typed slots before this carve-out.
        const sendType: 'i' | 'f' =
          a.type === 'i' &&
          !cell.modulation.enabled &&
          !cell.scaleToUnit &&
          !hwActiveForSlot &&
          !loopActiveForSlot
            ? 'i'
            : 'f'
        const finalVal = sendType === 'i' ? Math.round(out) : out
        // Cache the value we just decided to send — non-persistent
        // slots update freely. (Pinned slots are sourced from the
        // track's stored persistentValues, not from this cache, so
        // we don't need to keep the cache in sync for them.)
        if (!persistThis) ts.lastSentNumeric[idx] = finalVal
        newFinalVals.push(finalVal)
        outs.push({ type: sendType, value: finalVal })
        liveParts.push(sendType === 'i' ? String(finalVal) : finalVal.toFixed(3))
      }

      // Hold rest-behaviour gate: when restBehaviour='hold', skip
      // the OSC send if every numeric token matches what we sent
      // last tick — receivers naturally hold their previous value,
      // so re-sending the same payload is just redundant traffic.
      // Always send the FIRST emit after a trigger (regardless of
      // dedup), so receivers get an initial value to hold.
      const hold = cell.sequencer.restBehaviour === 'hold'
      let valuesChanged = false
      if (newFinalVals.length === 0) {
        valuesChanged = true // pure string/bool — fall through to send
      } else {
        for (let i = 0; i < newFinalVals.length; i++) {
          if (sentValuesBefore[i] !== newFinalVals[i]) {
            valuesChanged = true
            break
          }
        }
      }
      const shouldSend =
        !hold ||
        valuesChanged ||
        ratchetForceRetrigger ||
        !ts.hasEmittedNumeric
      if (shouldSend) {
        if (oscEmitAllowed) {
          this.sender.sendMany(
            cell.destIp,
            cell.destPort,
            cell.oscAddress,
            outs as OscArg[]
          )
        }
        // Track "we've emitted at least once" regardless of whether
        // OSC actually went out — the Hold rest-behaviour dedup +
        // the MIDI Note edge detector both read this flag and the
        // semantics should be "the value pipeline has fired", not
        // "an OSC packet has been delivered."
        ts.hasEmittedNumeric = true
      }
      // ── MIDI parallel emit ──────────────────────────────────────
      // Fires after OSC so the wall-clock order in the Monitor
      // matches "what the user expects" (OSC first, then MIDI).
      // `isNoteEdge` captures the three Note On trigger moments:
      //   1. First numeric emit after a fresh cell trigger
      //      (`!sentValuesBefore.length` would be the strict test;
      //       we use `!hadEmittedAtTickStart` so a Hold-mode
      //       re-trigger still fires a note).
      //   2. Sequencer step advance this tick (`stepChanged` was
      //      set by the advance loop above).
      //   3. Ratchet sub-pulse boundary (`ratchetForceRetrigger`).
      // For CC kind, every shouldSend emits — same cadence as OSC.
      if (
        this.session?.midiEnabled &&
        cell.midiOut?.enabled &&
        cell.midiOut.portName
      ) {
        const hadEmittedAtTickStart = sentValuesBefore.length > 0
        const isNoteEdge =
          !hadEmittedAtTickStart || stepChanged || ratchetForceRetrigger
        this.emitMidiForCell(ts, cell, newFinalVals, isNoteEdge, shouldSend)
      }
      // Always record liveValue for the UI — even if we suppressed
      // the OSC send for Hold, the cell tile + step previews should
      // still reflect the current generated state.
      this.recordLiveValue(ts.activeSceneId ?? '', trackId, liveParts.join(' '))

      if (ts.stopping && morphP >= 1) this.disarm(ts)
    }

    // Throttle live-value emits to ~20Hz to keep IPC cheap.
    if (t - this.lastValueEmitAt >= 50) {
      this.lastValueEmitAt = t
      this.emitState()
    }
  }

  private recordLiveValue(sceneId: string, trackId: string, value: string): void {
    if (!sceneId) return
    let row = this.liveValues[sceneId]
    if (!row) {
      row = {}
      this.liveValues[sceneId] = row
    }
    row[trackId] = value
  }

  /**
   * Emit a MIDI message for `cell` after its OSC send (or instead
   * of, if the user only enabled MIDI on this cell). Two paths:
   *
   *   - CC kind: continuous send, gated by Hold rest-behaviour the
   *     same way OSC is. Maps the cell's first final numeric value
   *     into 0..127.
   *   - Note kind: edge-triggered. `isNoteEdge` is true at fresh
   *     cell triggers, sequencer step advances, and ratchet sub-pulse
   *     boundaries. On each edge we send Note Off for the previously
   *     held note (if any), then Note On with the current note number
   *     (= newFinalVals[0] clamped) and velocity (= cell.velocity
   *     parsed, with `velocityPersistent` overriding modulator). An
   *     optional `gateLengthMs` schedules an explicit Note Off after
   *     N ms; otherwise the next edge or `sendMidiNoteOff()` fires it.
   *
   * Returns early if MIDI is globally disabled, the cell doesn't
   * opt in, or the port name is empty.
   */
  private emitMidiForCell(
    ts: TrackState,
    cell: Cell,
    newFinalVals: number[],
    isNoteEdge: boolean,
    oscSentThisTick: boolean
  ): void {
    const m = cell.midiOut
    if (!m || !m.enabled || !m.portName) return
    if (!this.session?.midiEnabled) return
    if (newFinalVals.length === 0) return
    const noteOrCcSourceVal = newFinalVals[0] ?? 0
    if (m.kind === 'cc') {
      const ccNum = Math.max(0, Math.min(127, Math.floor(m.cc ?? 0)))
      // Re-clamp to [0, 127]. `midiScale` (MIDI-specific 0..1 → 0..127
      // mapping, independent of `scaleToUnit`) is the new way to opt
      // into the multiply; `scaleToUnit` ALSO triggers it for
      // backwards-compatibility — a session built before midiScale
      // existed shouldn't suddenly emit raw OSC numbers (e.g. 255)
      // straight to MIDI just because the user upgrades.
      const wantMidiMap = !!cell.midiScale || cell.scaleToUnit
      const raw = wantMidiMap
        ? noteOrCcSourceVal * 127
        : noteOrCcSourceVal
      const value = Math.max(0, Math.min(127, Math.round(raw)))
      // Dedup under Hold rest-behaviour same as OSC. Skip the dedup
      // when OSC didn't send either (consistency) and on the first
      // emit after a trigger (always send so the receiver has a
      // starting value to hold).
      const cacheKey = `${m.portName}|${m.channel}|${ccNum}`
      const last = ts.midiLastCc.get(cacheKey)
      const hold = cell.sequencer.restBehaviour === 'hold'
      if (hold && last === value && oscSentThisTick === false) return
      if (hold && last === value && ts.hasEmittedNumeric) return
      ts.midiLastCc.set(cacheKey, value)
      this.midiSender.sendCc(m.portName, m.channel, ccNum, value)
      return
    }
    // Note kind — fire on edges OR when the computed note number
    // CHANGED (modulator drove the OSC value across a note boundary).
    // Without the note-number edge detector, modulator-only Note cells
    // would fire one noteOn at trigger time and then hold forever,
    // even as the OSC value swept up and down — and Humanize would
    // never re-roll because there was no new noteOn. With it, each
    // note-number change retriggers (which also re-rolls Humanize at
    // the SAME rate as the audible MIDI notes, matching the user's
    // "they should have the same rate" expectation).
    //
    // Resolve the note number FIRST so we can compare it against the
    // held note (the edge test below depends on it).
    const wantNoteMap = !!cell.midiScale || cell.scaleToUnit
    const rawLo = typeof m.noteMin === 'number' && Number.isFinite(m.noteMin) ? m.noteMin : 36
    const rawHi = typeof m.noteMax === 'number' && Number.isFinite(m.noteMax) ? m.noteMax : 84
    // Tolerate swapped min/max — pick the lower as lo, the higher as hi.
    const lo = Math.max(0, Math.min(127, Math.min(rawLo, rawHi)))
    const hi = Math.max(0, Math.min(127, Math.max(rawLo, rawHi)))
    const rawNote = wantNoteMap
      ? Math.round(lo + noteOrCcSourceVal * (hi - lo))
      : Math.round(noteOrCcSourceVal)
    const noteNum = Math.max(0, Math.min(127, rawNote))
    // Effective edge: caller-supplied (trigger / sequencer step /
    // ratchet) OR note-number change from the last held note.
    // `midiHeldNote === null` is treated as "different" so the cell
    // re-triggers after a gate-timer noteOff (otherwise modulator-
    // only cells with a non-zero gate would go silent forever once
    // their gate elapsed — no edge would ever fire again).
    const noteNumberChanged = ts.midiHeldNote !== noteNum
    if (!isNoteEdge && !noteNumberChanged) return
    // Resolve velocity. Pinned velocity always reads from the cell's
    // velocity field; unpinned velocity also reads from the field
    // (full per-velocity modulation is a v0.6 feature — for v0.5
    // the velocity slot is a static or hand-edited value).
    const velRaw = parseFloat(cell.velocity ?? '100')
    let velocity = Number.isFinite(velRaw)
      ? Math.max(0, Math.min(127, Math.round(velRaw)))
      : 100
    // Humanization — adds random jitter around the user's velocity
    // value. 0..100% maps to ±(humanize / 100) × 127 / 2 of variation.
    // Each Note On rolls a fresh random offset so repeated triggers
    // don't sound mechanical. Disabled when humanize is 0 or unset.
    const humanize = cell.velocityHumanize ?? 0
    if (humanize > 0) {
      const span = (humanize / 100) * 127
      const jitter = (Math.random() - 0.5) * span
      velocity = Math.max(0, Math.min(127, Math.round(velocity + jitter)))
    }
    // Send Note Off for the previously held note BEFORE the new
    // Note On (mono per cell — no overlap).
    if (ts.midiHeldNote !== null) {
      this.midiSender.sendNoteOff(
        ts.midiHeldPort,
        ts.midiHeldChannel,
        ts.midiHeldNote
      )
      ts.midiHeldNote = null
    }
    if (ts.midiGateTimer) {
      clearTimeout(ts.midiGateTimer)
      ts.midiGateTimer = null
    }
    if (velocity <= 0) {
      // velocity 0 is technically Note Off — skip the Note On so
      // we don't leave a phantom "held" note on the wire. Don't
      // update lastEmittedVelocity here either: the renderer's badge
      // should keep showing the LAST real wire value, not a phantom
      // zero from a humanize jitter that clipped below 0.
      return
    }
    this.midiSender.sendNoteOn(m.portName, m.channel, noteNum, velocity)
    // Cache the jittered velocity ONLY after the noteOn actually hit
    // the wire — so the renderer's badge mirrors what was sent (and
    // stays at the last real value during gaps, instead of getting
    // "stuck" at a clipped zero or a stale jitter result).
    ts.lastEmittedVelocity = velocity
    ts.midiHeldNote = noteNum
    ts.midiHeldChannel = m.channel
    ts.midiHeldPort = m.portName
    // Explicit gate length — schedule Note Off so the receiver gets
    // a defined release time. Without it the note rings until the
    // next edge (sequencer step / scene change / cell stop).
    const gateMs = Math.max(0, m.gateLengthMs ?? 0)
    if (gateMs > 0) {
      const port = m.portName
      const ch = m.channel
      const note = noteNum
      ts.midiGateTimer = setTimeout(() => {
        // Only Note Off if we're still the held note — a quick
        // re-trigger may have replaced it before the timer fired.
        if (ts.midiHeldNote === note && ts.midiHeldPort === port) {
          this.midiSender.sendNoteOff(port, ch, note)
          ts.midiHeldNote = null
        }
        ts.midiGateTimer = null
      }, gateMs)
    }
  }

  /** Send Note Off for any held MIDI note on `ts` and clear the
   *  scheduler. Called from `disarm()` and `panic()` so a stopped
   *  cell or hard-stop never leaves a stuck note. */
  private sendMidiNoteOff(ts: TrackState): void {
    if (ts.midiHeldNote !== null) {
      this.midiSender.sendNoteOff(
        ts.midiHeldPort,
        ts.midiHeldChannel,
        ts.midiHeldNote
      )
      ts.midiHeldNote = null
    }
    if (ts.midiGateTimer) {
      clearTimeout(ts.midiGateTimer)
      ts.midiGateTimer = null
    }
  }

  private disarm(ts: TrackState): void {
    const wasScene = ts.activeSceneId
    // Drop the live-value entry so the cell tile stops "ghost-displaying".
    if (wasScene && this.liveValues[wasScene]) {
      for (const tid of Object.keys(this.liveValues[wasScene])) {
        if (this.tracks.get(tid) === ts) delete this.liveValues[wasScene][tid]
      }
    }
    // Send Note Off for any held MIDI note before tearing the track
    // state down — without this a stopped cell could leave a note
    // ringing forever on the wire.
    this.sendMidiNoteOff(ts)
    ts.armed = false
    ts.stopping = false
    ts.activeSceneId = null
    // If a scene was "held open" (duration expired but modulation kept it alive),
    // clear activeSceneId now that the last active cell has stopped.
    if (
      wasScene &&
      this.activeSceneId === wasScene &&
      this.sceneAdvanceTimer === null &&
      !this.sceneHasOngoingActivity(wasScene)
    ) {
      this.activeSceneId = null
      this.activeSceneStartedAt = null
      this.activeSequenceSlotIdx = null
    }
    this.emitState()
  }

  private currentSceneDurationSec(sceneId: string | null): number {
    if (!this.session || !sceneId) return 5
    const sc = this.session.scenes.find((s) => s.id === sceneId)
    return sc?.durationSec ?? 5
  }

  private getActiveCell(trackId: string): Cell | null {
    const ts = this.tracks.get(trackId)
    if (!ts || !ts.activeSceneId || !this.session) return null
    const scene = this.session.scenes.find((s) => s.id === ts.activeSceneId)
    return scene?.cells[trackId] ?? null
  }

  // True when this track is disabled, OR its parent Template is.
  // Disabling an Instrument cascades to all its child Parameters
  // (their own enabled flag may still be true — parent overrides).
  private isTrackEffectivelyDisabled(trackId: string): boolean {
    if (!this.session) return false
    const t = this.session.tracks.find((tt) => tt.id === trackId)
    if (!t) return false
    if (t.enabled === false) return true
    if (t.parentTrackId) {
      const parent = this.session.tracks.find((tt) => tt.id === t.parentTrackId)
      if (parent && parent.enabled === false) return true
    }
    return false
  }

  private computeCurrentOutputs(trackId: string): number[] {
    const ts = this.tracks.get(trackId)
    if (!ts || !this.session) return []
    const cell = this.getActiveCell(trackId)
    const t = now()
    const morphP = ts.morphMs > 0 ? clamp((t - ts.morphStart) / ts.morphMs, 0, 1) : 1

    if (!cell) {
      // No active cell — interpolate existing fromCenter → toCenter.
      return ts.fromCenter.map((from, i) => {
        const to = ts.toCenter[i] ?? 0
        return from + (to - from) * morphP
      })
    }

    const baseRaw = resolveStepBaseRaw(
      cell,
      ts,
      ts.seqStepIdx,
      ts.seqRatchetSubIdx,
      ts.seqRatchetSubdiv
    )
    const targetsRaw = numericBasesFromRaw(baseRaw)
    const targets = cell.scaleToUnit ? targetsRaw.map(clamp01) : targetsRaw

    let modNorm = 0
    let envGain = 1
    let rampGain = 1
    if (cell.modulation.enabled) {
      if (cell.modulation.type === 'envelope') {
        envGain = computeEnvelopeGain(
          cell.modulation.envelope,
          (t - ts.triggerTime) / 1000,
          this.currentSceneDurationSec(ts.activeSceneId)
        )
      } else if (cell.modulation.type === 'ramp') {
        rampGain = computeRampGain(
          cell.modulation.ramp,
          (t - ts.triggerTime) / 1000,
          this.currentSceneDurationSec(ts.activeSceneId)
        )
      } else {
        modNorm = computeModNorm(
          cell.modulation,
          ts,
          this.tickIdx,
          (t - ts.triggerTime) / 1000,
          this.currentSceneDurationSec(ts.activeSceneId),
          this.session.globalBpm
        )
      }
    }
    const depth = cell.modulation.depthPct / 100

    const outs: number[] = []
    for (let i = 0; i < targets.length; i++) {
      let center: number
      if (cell.sequencer.enabled) {
        const from = ts.fromCenter[i] ?? 0
        center = morphP < 1 ? from + (targets[i] - from) * morphP : targets[i]
      } else {
        const from = ts.fromCenter[i] ?? 0
        const to = ts.toCenter[i] ?? targets[i]
        center = from + (to - from) * morphP
      }
      let out = center
      if (cell.modulation.enabled) {
        if (cell.modulation.type === 'envelope') {
          out = center * (1 - depth + depth * envGain)
        } else if (cell.modulation.type === 'ramp') {
          out = center * (1 - depth + depth * rampGain)
        } else if (cell.modulation.type === 'arpeggiator') {
          const arp = cell.modulation.arpeggiator
          const N = Math.max(1, Math.min(8, arp.steps))
          let ladder = buildArpLadder(center, N, arp.multMode)
          let dryCenter = center
          if (cell.scaleToUnit) {
            const maxAbs = ladder.reduce(
              (m, v) => (Math.abs(v) > m ? Math.abs(v) : m),
              0
            )
            if (maxAbs > 0) {
              ladder = ladder.map((v) => v / maxAbs)
              dryCenter = center / maxAbs
            }
          }
          const stepVal =
            ladder[Math.max(0, Math.min(N - 1, ts.arpStepIdx))] ?? dryCenter
          out = dryCenter * (1 - depth) + stepVal * depth
        } else {
          const magnitude = Math.max(Math.abs(center), 1) * depth
          out = center + modNorm * magnitude
        }
      }
      if (cell.scaleToUnit) out = clamp01(out)
      outs.push(out)
    }
    return outs
  }
}

function now(): number {
  const t = process.hrtime()
  return t[0] * 1000 + t[1] / 1e6
}

function clamp01(v: number): number {
  if (!Number.isFinite(v)) return 0
  return v < 0 ? 0 : v > 1 ? 1 : v
}

function pad(arr: number[], length: number, fill: number): number[] {
  if (arr.length >= length) return arr.slice(0, length)
  const out = arr.slice()
  while (out.length < length) out.push(fill)
  return out
}

function numericBasesFromRaw(raw: string): number[] {
  return parseValueTokens(raw).map((t) => readNumber(t) ?? 0)
}

// ---- Random Generator ----

/**
 * Draw the next sample from a seeded PRNG.
 *  - int / float: returns `tokenCount` numbers (one per space-separated entry
 *    in the cell's Value field).
 *  - colour: returns `3 * tokenCount` numbers — each entry becomes its own
 *    r, g, b triplet.
 *
 * Values are in raw "rng-space" (pre-rounding / pre-scale); the caller rounds
 * to int / quantizes to the OSC type + applies Scale 0.0-1.0 clamping.
 */
// Symmetric power-law warp on a uniform [0, 1] draw, parameterised by
// a "distribution" knob in [0, 1]:
//   0.0  → edge-weighted (values pushed toward 0 and 1)
//   0.5  → uniform (raw rng, pass-through)
//   1.0  → centre-hugging (values pulled toward 0.5)
// Implementation: anchor at 0.5, take distance |u - 0.5| ∈ [0, 0.5],
// re-shape the distance with x^k (centre-hug, k > 1) or x^(1/k)
// (edge-spread, k > 1), then re-attach the original sign side. Smooth
// at u = 0.5 and continuous at u = 0/1.
function warpDistribution(u: number, distribution: number): number {
  const d = Math.max(0, Math.min(1, distribution))
  if (d === 0.5) return u
  const c = u - 0.5 // [-0.5, 0.5]
  const sign = c < 0 ? -1 : 1
  const absC = Math.abs(c) * 2 // [0, 1]
  // k = 1..4 strength. d=1 → strong centre-hug, d=0 → strong edge-weight.
  const strength = 1 + Math.abs(d - 0.5) * 6
  const warped = d > 0.5 ? Math.pow(absC, strength) : Math.pow(absC, 1 / strength)
  return 0.5 + sign * warped * 0.5
}

function sampleRandom(
  rng: () => number,
  rnd: {
    valueType: 'int' | 'float' | 'colour'
    min: number
    max: number
    distribution?: number
  },
  tokenCount: number
): number[] {
  const lo = Math.min(rnd.min, rnd.max)
  const hi = Math.max(rnd.min, rnd.max)
  const range = hi - lo
  const dist = rnd.distribution
  const pick = (): number => {
    const u = dist !== undefined && dist !== 0.5 ? warpDistribution(rng(), dist) : rng()
    return lo + u * range
  }
  const total = rnd.valueType === 'colour' ? 3 * Math.max(1, tokenCount) : Math.max(1, tokenCount)
  const out: number[] = new Array(total)
  for (let i = 0; i < total; i++) out[i] = pick()
  return out
}

// ---- Arpeggiator advance / init ----

function arpStartStep(
  arp: {
    steps: number
    arpMode: import('@shared/types').ArpMode
  },
  // Optional seeded RNG so callers in reproducibility-sensitive
  // contexts (Mod 2 trigger reseed, deterministic cells with the
  // same Value seed) get the same starting step. Falls back to
  // Math.random for legacy callers that don't care.
  rng?: () => number
): number {
  const N = Math.max(1, Math.min(8, arp.steps))
  const draw = rng ?? Math.random
  if (arp.arpMode === 'random') return Math.floor(draw() * N)
  if (arp.arpMode === 'walk' || arp.arpMode === 'drunk') return 0
  // Deterministic: start at pattern[0].
  const pat = buildArpPattern(arp.arpMode, N)
  return pat[0] ?? 0
}

function advanceArpStep(
  // Structural: only reads / writes arpStepIdx + arpPatternIdx, so
  // both TrackState (Mod 1) and Mod2State (Mod 2) can be passed.
  ts: { arpStepIdx: number; arpPatternIdx: number },
  arp: { steps: number; arpMode: import('@shared/types').ArpMode }
): void {
  const N = Math.max(1, Math.min(8, arp.steps))
  if (arp.arpMode === 'random') {
    ts.arpStepIdx = Math.floor(Math.random() * N)
    return
  }
  if (arp.arpMode === 'walk') {
    // ±1 with reflection at the edges.
    const dir = Math.random() < 0.5 ? -1 : 1
    let next = ts.arpStepIdx + dir
    if (next < 0) next = 1 < N ? 1 : 0
    else if (next >= N) next = N >= 2 ? N - 2 : 0
    ts.arpStepIdx = next
    return
  }
  if (arp.arpMode === 'drunk') {
    // Jump by ±1..3, reflect within bounds.
    const mag = 1 + Math.floor(Math.random() * 3)
    const dir = Math.random() < 0.5 ? -1 : 1
    let next = ts.arpStepIdx + mag * dir
    while (next < 0 || next >= N) {
      if (next < 0) next = -next
      if (next >= N) next = 2 * (N - 1) - next
    }
    ts.arpStepIdx = Math.max(0, Math.min(N - 1, next))
    return
  }
  // Deterministic pattern-based advance.
  const pat = buildArpPattern(arp.arpMode, N)
  if (pat.length === 0) return
  ts.arpPatternIdx = (ts.arpPatternIdx + 1) % pat.length
  ts.arpStepIdx = pat[ts.arpPatternIdx] ?? 0
}

// Combined modulation output, mapped to the cell's mode:
//   unipolar → [0, 1]   → pushes output from `center` up to `center+magnitude`
//   bipolar  → [-1, 1]  → pushes output within [center-magnitude, center+magnitude]
function computeModNorm(
  m: Modulation,
  ts: TrackState,
  tickIdx: number,
  elapsedSec: number,
  sceneDurSec: number,
  _bpm: number
): number {
  if (m.type === 'envelope') {
    // Envelope is naturally unipolar 0..1.
    const g = computeEnvelopeGain(m.envelope, elapsedSec, sceneDurSec)
    return m.mode === 'bipolar' ? 2 * g - 1 : g
  }
  // S&H — emit held value (optionally cosine-smoothed from prev → held).
  // Tick-loop advances the clock/sample; here we just read the state.
  if (m.type === 'sh') {
    let raw: number
    if (m.sh.smooth) {
      const effHz = effectiveLfoHz(m, _bpm)
      const periodMs = effHz > 0 ? 1000 / effHz : 1
      // Approximate progress across the current step using time since last
      // advance. ts.shLastAdvanceAt was set to the start of the current
      // sample; phase-in over the full period via cosine.
      // NB: we can't read `t` here; computeModNorm is called from inside
      // the tick, so elapsed-since-advance is the step progress.
      const nowMs = elapsedSec * 1000 + ts.triggerTime
      const into = nowMs - ts.shLastAdvanceAt
      // Half-period cosine so k goes 0 → 1 monotonically across the step.
      // Previously multiplied by 2π, which made k return to 0 at t=1 —
      // output oscillated prev → held → prev inside every sample period
      // instead of smoothly interpolating prev → held.
      const k = 0.5 - 0.5 * Math.cos(Math.max(0, Math.min(1, into / periodMs)) * Math.PI)
      raw = ts.shPrev * (1 - k) + ts.shHeld * k
    } else {
      raw = ts.shHeld
    }
    if (m.mode === 'bipolar') return raw
    return (raw + 1) / 2
  }
  if (m.type === 'slew') {
    const raw = ts.slewValue
    if (m.mode === 'bipolar') return raw
    return (raw + 1) / 2
  }
  if (m.type === 'chaos') {
    // Map (0, 1) to (-1, 1). chaosX stays away from the endpoints thanks to
    // the sanity clamp in the tick-loop advancement.
    const raw = ts.chaosX * 2 - 1
    if (m.mode === 'bipolar') return raw
    return ts.chaosX // already 0..1
  }
  if (m.type === 'attractor') {
    // Default channel = X. Multi-arg cells get per-slot channels via
    // `attractorChannelFor(ts, slotIdx, mode)` in the per-slot emit
    // loop; single-arg / single-channel readers use this fallback.
    return attractorChannelFor(ts, 1, m.mode)
  }
  if (m.type === 'gesture') {
    // Default channel = X (slot 0 in xy mode). Multi-arg cells get
    // per-slot channels via `gestureChannelFor(ts, slotIdx, mode,
    // gestureMode)` in the per-slot emit loop; single-arg / single-
    // channel readers use this fallback.
    const gMode = m.gesture?.mode ?? 'xy'
    return gestureChannelFor(ts, 0, m.mode, gMode)
  }
  // LFO (default fallthrough)
  const raw = lfo(m.shape, ts.phase, ts, tickIdx) // -1..1
  if (m.mode === 'bipolar') return raw
  return (raw + 1) / 2 // 0..1
}

// Resolve which attractor channel feeds a given arg slot.
//   slotIdx 0 → W (4D) or X (3D, since W=speed sits at slot 3)
//   slotIdx 1 → X
//   slotIdx 2 → Y
//   slotIdx 3 → Z
//   slotIdx 4+ → Z (graceful degrade — keeps the last channel mod
//                  active rather than zeroing)
// For 3D attractors the user-facing mental model is X/Y/Z fan-out to
// the first three slots + a "speed breath" on slot 3. For 4D the
// canonical channel labels W/X/Y/Z all participate. Mode (uni/bi)
// just maps the stored [0,1] value into the right output range.
function attractorChannelFor(
  ts: TrackState,
  slotIdx: number,
  mode: 'unipolar' | 'bipolar'
): number {
  let v01 = 0.5
  // Slot mapping. Slot 0 wants the "first" channel: X for 3D
  // attractors, W for 4D. We don't carry attractor type here, but
  // the 3D vs 4D distinction was already encoded at integration
  // time — when type was 4D, ts.attractorW holds the canonical W
  // channel; when 3D, ts.attractorW holds the speed. Slot 0 takes
  // X in both cases so the user-facing fan-out is consistent
  // (slot 0 = primary motion).
  switch (slotIdx) {
    case 0:
      v01 = ts.attractorX
      break
    case 1:
      v01 = ts.attractorY
      break
    case 2:
      v01 = ts.attractorZ
      break
    case 3:
      v01 = ts.attractorW
      break
    default:
      v01 = ts.attractorZ
      break
  }
  if (mode === 'unipolar') return v01
  return v01 * 2 - 1 // bipolar
}

// Resolve which channel of the recorded gesture feeds a given slot.
//   GestureMode 'xy':
//     slot 0 → X, slot 1 → Y, slot ≥ 2 → X (so trailing slots aren't
//     dead — they read the X channel which keeps the cell musically
//     coherent rather than silent).
//   GestureMode 'merged':
//     every slot reads the same radial distance √(x² + y²) / √2.
// `mode` is the standard LFO Unipolar / Bipolar — the gesture sample
// is naturally unipolar [0, 1]; bipolar remaps to [-1, +1].
function gestureChannelFor(
  ts: TrackState,
  slotIdx: number,
  mode: 'unipolar' | 'bipolar',
  gestureMode: import('@shared/types').GestureMode
): number {
  let v01: number
  if (gestureMode === 'merged') {
    // sqrt(2) divisor so the unit square's max distance (1, 1) maps
    // to 1. Same formula as the old sequencer-mode merged value.
    // Cached on the track state per tick so multi-arg cells in
    // merged mode don't re-compute sqrt() per slot (8 slots × 120 Hz
    // × 10 cells × sqrt() adds up). gestureMergedCacheTickIdx tracks
    // whether the cache is fresh for the current tick.
    if (ts.gestureMergedCacheTickIdx !== ts.gestureCacheTickStamp) {
      ts.gestureMergedCache =
        Math.sqrt(ts.gestureX * ts.gestureX + ts.gestureY * ts.gestureY) /
        Math.SQRT2
      ts.gestureMergedCacheTickIdx = ts.gestureCacheTickStamp
    }
    v01 = ts.gestureMergedCache
  } else {
    switch (slotIdx) {
      case 0:
        v01 = ts.gestureX
        break
      case 1:
        v01 = ts.gestureY
        break
      default:
        v01 = ts.gestureX
        break
    }
  }
  v01 = Math.max(0, Math.min(1, v01))
  if (mode === 'unipolar') return v01
  return v01 * 2 - 1
}

// ADSR with A, D, S (hold), R. Times in seconds (converted from ms or scene %).
function computeEnvelopeGain(
  env: { attackMs: number; decayMs: number; sustainMs: number; releaseMs: number;
         attackPct: number; decayPct: number; sustainPct: number; releasePct: number;
         sustainLevel: number; sync: 'synced' | 'free' | 'freeSync'; totalMs: number },
  elapsedSec: number,
  sceneDurSec: number
): number {
  let a: number, d: number, s: number, r: number
  if (env.sync === 'synced' || env.sync === 'freeSync') {
    // Fractions of a reference duration — scene for 'synced', a user-picked
    // Total(ms) for 'freeSync'. Same math, different base.
    const baseSec =
      env.sync === 'synced'
        ? sceneDurSec
        : Math.max(0.0001, (env.totalMs ?? 0) / 1000)
    const totalPct = Math.max(
      0.0001,
      env.attackPct + env.decayPct + env.sustainPct + env.releasePct
    )
    const scale = totalPct > 1 ? 1 / totalPct : 1
    a = env.attackPct * scale * baseSec
    d = env.decayPct * scale * baseSec
    s = env.sustainPct * scale * baseSec
    r = env.releasePct * scale * baseSec
  } else {
    a = env.attackMs / 1000
    d = env.decayMs / 1000
    s = env.sustainMs / 1000
    r = env.releaseMs / 1000
  }
  const sl = Math.max(0, Math.min(1, env.sustainLevel))
  const t = elapsedSec
  if (t <= 0) return 0
  if (t < a) return a > 0 ? t / a : 1 // attack 0→1
  const tAfterA = t - a
  if (tAfterA < d) return d > 0 ? 1 + (sl - 1) * (tAfterA / d) : sl // decay 1→sl
  const tAfterD = tAfterA - d
  if (tAfterD < s) return sl // sustain hold
  const tAfterS = tAfterD - s
  if (tAfterS < r) return r > 0 ? sl * (1 - tAfterS / r) : 0 // release sl→0
  return 0
}

// One-shot ramp modulator. 0 → 1 over the configured ramp length, then
// holds at 1 forever. `curvePct` bends the interpolation via a power curve:
//    curve = 1                 → linear (curvePct = 0)
//    curve = 1 + curvePct/100  → ease-in / ease-out shaped pow
//  positive curvePct = ease-out (fast start, slow finish)
//  negative curvePct = ease-in (slow start, fast finish)
// The caller multiplies the result by the cell's depth % (see main tick).
function computeRampGain(
  ramp: {
    rampMs: number
    curvePct: number
    sync: 'synced' | 'free' | 'freeSync'
    totalMs: number
    mode?: 'normal' | 'inverted' | 'loop' | 'from'
    fromValue?: number
    toValue?: number
  },
  elapsedSec: number,
  sceneDurSec: number
): number {
  let lenSec: number
  if (ramp.sync === 'synced') {
    lenSec = Math.max(0.0001, sceneDurSec)
  } else if (ramp.sync === 'freeSync') {
    lenSec = Math.max(0.0001, (ramp.totalMs ?? 0) / 1000)
  } else {
    lenSec = Math.max(0.0001, (ramp.rampMs ?? 0) / 1000)
  }
  const mode = ramp.mode ?? 'normal'
  // 'from' mode endpoints. Defaults (0 → 1) make 'from' identical to
  // 'normal' until the user overrides them. The base progress p below
  // is computed EXACTLY like 'normal' (same edge clamps, same curve);
  // only the final output mapping differs, so 'from' threads into the
  // caller's depth/scaling pipeline identically to 'normal'.
  // Number.isFinite (not ??) so a malformed/NaN value from a hand-edited
  // session can't propagate NaN through the ramp output for this slot.
  const fromValue = Number.isFinite(ramp.fromValue) ? (ramp.fromValue as number) : 0
  const toValue = Number.isFinite(ramp.toValue) ? (ramp.toValue as number) : 1
  // Loop mode: take elapsed time modulo the ramp period so the curve
  // retriggers every period instead of holding at 1 after completing.
  // Normal/Inverted/From: clamp at edges (start before, end after).
  let lin: number
  if (mode === 'loop') {
    if (elapsedSec <= 0) lin = 0
    else lin = (elapsedSec % lenSec) / lenSec
  } else {
    // Edge clamps. 'from' uses the same 0/1 progress edges as 'normal'
    // (then maps p through fromValue→toValue): before start → progress
    // 0 → fromValue; after end → progress 1 → toValue.
    if (elapsedSec <= 0)
      return mode === 'inverted' ? 1 : mode === 'from' ? fromValue : 0
    if (elapsedSec >= lenSec)
      return mode === 'inverted' ? 0 : mode === 'from' ? toValue : 1
    lin = elapsedSec / lenSec
  }
  const curve = ramp.curvePct ?? 0
  const shaped =
    curve === 0
      ? lin
      : curve > 0
        ? 1 - Math.pow(1 - lin, 1 + (Math.abs(curve) / 100) * 4)
        : Math.pow(lin, 1 + (Math.abs(curve) / 100) * 4)
  // Inverted mode flips the ramp vertically so it falls 1 → 0 instead
  // of rising 0 → 1 (curve shape preserved, just mirrored).
  if (mode === 'inverted') return 1 - shaped
  // 'from' mode: map the base progress p (= shaped, exactly the value
  // 'normal' returns) onto the user's endpoints. depth/scaling apply
  // downstream identically to normal mode.
  if (mode === 'from') return fromValue + (toValue - fromValue) * shaped
  return shaped
}

// ─────────────────────────────────────────────────────────────────
// Two-stage modulator — helper functions
//
// Mod 2's per-tick advance + eval mirror Mod 1's code but read/write
// from a `Mod2State` (see top of file) instead of the TrackState's
// modulator-state fields. They're concentrated here so the per-tick
// loop above stays readable: one call advances Mod 2's state, one
// returns its bipolar [-1, +1] norm value, and one builds an
// "effective Mod 1" Modulation by applying Mod 2's output to Mod 1's
// Rate / Depth / context-aware Shape per the user's targets +
// targetMode.
//
// Supported Mod 2 types (subset of full ModType): LFO, S&H, Slew,
// Chaos, Strange Attractor. The remaining types (Envelope, Ramp,
// Arpeggiator, Random) are time/note/multi-channel constructs that
// don't map cleanly to "continuous bipolar modulator signal", and
// are treated as no-op when assigned to Mod 2 (eval returns 0).
// ─────────────────────────────────────────────────────────────────

function advanceMod2State(
  m: import('@shared/types').Modulation,
  m2: Mod2State,
  dt: number,
  t: number,
  bpm: number,
  tickIdx: number
): void {
  if (!m.enabled) return
  // LFO — same phase advance + stepped/smooth shape resampling as
  // the Mod 1 LFO block above, just writing into m2 fields.
  if (m.type === 'lfo') {
    const effHz = effectiveLfoHz(m, bpm)
    const prevPhase = m2.phase
    m2.phase += effHz * dt
    const wraps = Math.floor(m2.phase) - Math.floor(prevPhase)
    if (wraps > 0) {
      const rng = m2.rng ?? Math.random
      const spastic = m.shape === 'spastic'
      for (let w = 0; w < wraps; w++) {
        m2.rndSmoothPrev = m2.rndSmoothNext
        m2.rndSmoothNext = rng() * 2 - 1
        m2.rndStepValue = spastic ? (rng() < 0.5 ? -1 : 1) : rng() * 2 - 1
      }
      m2.rndStepLastTick = tickIdx
    }
    return
  }
  // S&H — clock-driven hold/draw with optional distribution warp.
  if (m.type === 'sh') {
    const effHz = effectiveLfoHz(m, bpm)
    if (effHz > 0) {
      const rng = m2.rng ?? Math.random
      const period = 1000 / effHz
      const dist = m.sh.distribution
      const drawShVal = (): number => {
        if (dist === undefined || dist === 0.5) return rng() * 2 - 1
        const warped = warpDistribution(rng(), dist)
        return warped * 2 - 1
      }
      while (t - m2.shLastAdvanceAt >= period) {
        m2.shLastAdvanceAt += period
        if (rng() < Math.max(0, Math.min(1, m.sh.probability))) {
          m2.shPrev = m2.shHeld
          m2.shHeld = drawShVal()
        }
      }
    }
    return
  }
  // Slew — clock-driven target + one-pole IIR low-pass per tick.
  if (m.type === 'slew') {
    const effHz = effectiveLfoHz(m, bpm)
    if (effHz > 0) {
      const rng = m2.rng ?? Math.random
      const period = 1000 / effHz
      while (t - m2.slewLastAdvanceAt >= period) {
        m2.slewLastAdvanceAt += period
        if (m.slew.randomTarget) {
          m2.slewTarget = rng() * 2 - 1
        } else {
          m2.slewTarget = m2.slewTarget >= 0 ? -1 : 1
        }
      }
    }
    const goingUp = m2.slewTarget > m2.slewValue
    const halfLifeMs = Math.max(1, goingUp ? m.slew.riseMs : m.slew.fallMs)
    const alpha = 1 - Math.pow(2, (-dt * 1000) / halfLifeMs)
    m2.slewValue += (m2.slewTarget - m2.slewValue) * alpha
    return
  }
  // Chaos — logistic map iterate at clock rate.
  if (m.type === 'chaos') {
    const effHz = effectiveLfoHz(m, bpm)
    if (effHz > 0) {
      const period = 1000 / effHz
      const r = Math.max(3.4, Math.min(4.0, m.chaos.r))
      const rng = m2.rng ?? Math.random
      while (t - m2.chaosLastAdvanceAt >= period) {
        m2.chaosLastAdvanceAt += period
        let x = m2.chaosX
        x = r * x * (1 - x)
        if (!Number.isFinite(x) || x <= 0 || x >= 1) x = 0.1 + rng() * 0.8
        m2.chaosX = x
      }
    }
    return
  }
  // Strange Attractor — same ODE integration as Mod 1's block, just
  // updating m2.attractor* fields. Code intentionally duplicated
  // rather than abstracted so each branch can stay small + fast.
  if (m.type === 'attractor' && m.attractor) {
    const ap = m.attractor
    if (m2.attractorLastUpdateMs === 0) m2.attractorLastUpdateMs = t
    const dtMs = Math.max(0, t - m2.attractorLastUpdateMs)
    m2.attractorLastUpdateMs = t
    const tIntegrate = Math.min(0.5, dtMs * 0.0002 * Math.max(0.05, ap.speed))
    const subSteps = Math.max(1, Math.ceil(tIntegrate / 0.005))
    const h = tIntegrate / subSteps
    let x = m2.attractorRawX
    let y = m2.attractorRawY
    let z = m2.attractorRawZ
    let w = m2.attractorRawW
    const chaosKnob = Math.max(0, Math.min(1, ap.chaos))
    const SAFE_MAX = 200
    let lastDx = 0
    let lastDy = 0
    let lastDz = 0
    for (let s = 0; s < subSteps; s++) {
      let dx = 0
      let dy = 0
      let dz = 0
      let dw = 0
      switch (ap.type) {
        case 'aizawa': {
          const a = 0.95
          const b = 0.7
          const c = 0.6
          const d = 3.5
          const e = 0.25 + chaosKnob * 0.5
          const f = 0.1
          dx = (z - b) * x - d * y
          dy = d * x + (z - b) * y
          dz = c + a * z - (z * z * z) / 3 - (x * x + y * y) * (1 + e * z) + f * z * x * x * x
          break
        }
        case 'thomas': {
          const b = 0.1 + chaosKnob * 0.3
          dx = Math.sin(y) - b * x
          dy = Math.sin(z) - b * y
          dz = Math.sin(x) - b * z
          break
        }
        case 'rossler': {
          const a = 0.2
          const b = 0.2
          const c = 5 + chaosKnob * 8
          dx = -y - z
          dy = x + a * y
          dz = b + z * (x - c)
          break
        }
        case 'rossler4d': {
          const a = 0.25
          const b = 3
          const c = 0.5 + chaosKnob * 0.5
          const d = 0.05
          dx = -y - z
          dy = x + a * y + w
          dz = b + x * z
          dw = -c * z + d * w
          break
        }
        case 'lu4d': {
          const a = 36
          const b = 3
          const c = 20
          const d = 1.3 + chaosKnob * 0.5
          dx = a * (y - x) + w
          dy = c * y - x * z
          dz = x * y - b * z
          dw = -x * z + d * w
          break
        }
        default: {
          // lorenz
          const sigma = 10
          const rho = 28 + chaosKnob * 12
          const beta = 8 / 3
          dx = sigma * (y - x)
          dy = x * (rho - z) - y
          dz = x * y - beta * z
          break
        }
      }
      x += h * dx
      y += h * dy
      z += h * dz
      w += h * dw
      if (!Number.isFinite(x) || Math.abs(x) > SAFE_MAX) x = (Math.random() - 0.5) * 2
      if (!Number.isFinite(y) || Math.abs(y) > SAFE_MAX) y = (Math.random() - 0.5) * 2
      if (!Number.isFinite(z) || Math.abs(z) > SAFE_MAX) z = (Math.random() - 0.5) * 2
      if (!Number.isFinite(w) || Math.abs(w) > SAFE_MAX) w = (Math.random() - 0.5) * 2
      lastDx = dx
      lastDy = dy
      lastDz = dz
    }
    m2.attractorRawX = x
    m2.attractorRawY = y
    m2.attractorRawZ = z
    m2.attractorRawW = w
    // Normalise to [0, 1]. Per-attractor scales chosen empirically
    // to keep the canonical orbit inside [0, 1] without saturating.
    const norm01 = (v: number, scale: number): number => {
      if (!Number.isFinite(v)) return 0.5
      return Math.max(0, Math.min(1, (v / scale + 1) / 2))
    }
    switch (ap.type) {
      case 'aizawa':
        m2.attractorX = norm01(m2.attractorRawX, 1.5)
        m2.attractorY = norm01(m2.attractorRawY, 1.5)
        m2.attractorZ = norm01(m2.attractorRawZ, 2)
        break
      case 'thomas':
        m2.attractorX = norm01(m2.attractorRawX, 5)
        m2.attractorY = norm01(m2.attractorRawY, 5)
        m2.attractorZ = norm01(m2.attractorRawZ, 5)
        break
      case 'rossler':
        m2.attractorX = norm01(m2.attractorRawX, 15)
        m2.attractorY = norm01(m2.attractorRawY, 15)
        m2.attractorZ = norm01(m2.attractorRawZ, 30)
        break
      case 'rossler4d':
        m2.attractorX = norm01(m2.attractorRawX, 15)
        m2.attractorY = norm01(m2.attractorRawY, 15)
        m2.attractorZ = norm01(m2.attractorRawZ, 30)
        m2.attractorW = norm01(m2.attractorRawW, 50)
        break
      case 'lu4d':
        m2.attractorX = norm01(m2.attractorRawX, 50)
        m2.attractorY = norm01(m2.attractorRawY, 50)
        m2.attractorZ = norm01(m2.attractorRawZ, 80)
        m2.attractorW = norm01(m2.attractorRawW, 150)
        break
      default:
        m2.attractorX = norm01(m2.attractorRawX, 30)
        m2.attractorY = norm01(m2.attractorRawY, 30)
        m2.attractorZ = norm01(m2.attractorRawZ, 50)
        break
    }
    // 3D-only: store speed in W channel (Euclidean norm of last
    // derivative, EMA-smoothed). 4D types overwrote W above.
    if (ap.type !== 'rossler4d' && ap.type !== 'lu4d') {
      const speed = Math.sqrt(lastDx * lastDx + lastDy * lastDy + lastDz * lastDz)
      const normSpeed = Math.max(0, Math.min(1, speed / 100))
      m2.attractorSpeed = m2.attractorSpeed * 0.9 + normSpeed * 0.1
      m2.attractorW = m2.attractorSpeed
    }
    return
  }
  // Arpeggiator — clock-driven step advance. Uses the loosened
  // advanceArpStep helper (structural typing) so Mod 2's
  // arpStepIdx/arpPatternIdx update in place.
  if (m.type === 'arpeggiator') {
    const effHz = effectiveLfoHz(m, bpm)
    if (effHz > 0) {
      const period = 1000 / effHz
      while (t - m2.arpLastAdvanceAt >= period) {
        m2.arpLastAdvanceAt += period
        advanceArpStep(m2, m.arpeggiator)
      }
    }
    return
  }
  // Random — clock-driven fresh sample at the modulator's effective
  // rate, with distribution warp honoured. Mod 2 emits ONE bipolar
  // value (not the multi-channel array Mod 1's Random does), so we
  // collapse to a single number per advance.
  if (m.type === 'random') {
    if (!m2.rng) return
    const effHz = effectiveLfoHz(m, bpm)
    if (effHz > 0) {
      const period = 1000 / effHz
      const dist = m.random.distribution
      const rng = m2.rng
      while (t - m2.randLastAdvanceAt >= period) {
        m2.randLastAdvanceAt += period
        const draw = rng()
        const u =
          dist !== undefined && dist !== 0.5
            ? warpDistribution(draw, dist)
            : draw
        m2.randCurrent = u * 2 - 1
      }
    }
    return
  }
  // Envelope / Ramp / Arpeggiator → handled by evalMod2Bipolar
  // directly (no per-tick state advance needed beyond what Mod 1
  // already does on the shared triggerTime).
}

function evalMod2Bipolar(
  m: import('@shared/types').Modulation,
  m2: Mod2State,
  triggerTimeMs: number,
  nowMs: number,
  bpm: number,
  tickIdx: number,
  sceneDurSec: number
): number {
  if (!m.enabled) return 0
  const elapsedSec = (nowMs - triggerTimeMs) / 1000
  switch (m.type) {
    case 'envelope': {
      const g = computeEnvelopeGain(m.envelope, elapsedSec, sceneDurSec)
      // Force bipolar interpretation for stage-2 use regardless of
      // m.mode — we want symmetric ± swing around Mod 1's base
      // values, not an asymmetric "always pulls toward higher".
      return 2 * g - 1
    }
    case 'sh': {
      let raw: number
      if (m.sh.smooth) {
        const effHz = effectiveLfoHz(m, bpm)
        const periodMs = effHz > 0 ? 1000 / effHz : 1
        const into = nowMs - m2.shLastAdvanceAt
        const k =
          0.5 -
          0.5 * Math.cos(Math.max(0, Math.min(1, into / periodMs)) * Math.PI)
        raw = m2.shPrev * (1 - k) + m2.shHeld * k
      } else {
        raw = m2.shHeld
      }
      return raw
    }
    case 'slew':
      return m2.slewValue
    case 'chaos':
      return m2.chaosX * 2 - 1
    case 'attractor':
      // Use X channel by default — single bipolar value drives the
      // targeting math. (4-channel fan-out would be for Mod 1's
      // per-slot output, but at this stage we just need ONE number.)
      return m2.attractorX * 2 - 1
    case 'lfo': {
      const raw = lfo(m.shape, m2.phase, m2, tickIdx)
      return raw
    }
    case 'random':
      // Random — return the last drawn bipolar sample. advanceMod2State
      // pulls a fresh sample at the modulator's effective rate.
      return m2.randCurrent
    case 'ramp': {
      // Ramp is one-shot: rampGain rises 0 → 1 (or 1 → 0 inverted)
      // over the configured time, then HOLDS at the final value
      // forever. As Mod 2 we map it to bipolar so the held tail
      // settles Mod 1's params at the swing endpoints rather than
      // around the base. Loop mode in m.ramp.mode === 'loop' keeps
      // restarting the ramp, which gives Mod 2 a slow saw-tooth.
      const g = computeRampGain(m.ramp, elapsedSec, sceneDurSec)
      return 2 * g - 1
    }
    case 'arpeggiator': {
      // Arpeggiator — emit the current step's NORMALISED position
      // as a bipolar value. With N steps, step k → 2*(k/(N-1)) - 1;
      // so an "up" pattern sweeps -1 → +1 across the ladder, a
      // "down" pattern sweeps +1 → -1, "upDown" makes a triangle.
      // Single-step ladder (N=1) emits 0.
      const N = Math.max(1, Math.min(8, m.arpeggiator.steps))
      if (N <= 1) return 0
      const k = Math.max(0, Math.min(N - 1, m2.arpStepIdx))
      return (k / (N - 1)) * 2 - 1
    }
    default:
      return 0
  }
}

// Build an "effective Mod 1" Modulation by applying Mod 2's bipolar
// signal (in [-1, +1]) to Mod 1's Rate, Depth, and a context-aware
// "Shape" parameter, per the targeting fields on `m2cfg`. The
// returned Modulation shares all referenced sub-objects (envelope,
// arpeggiator, etc.) with the input — only the patched scalar fields
// differ. Cheap to call every tick.
function applyMod2ToMod1(
  m1: import('@shared/types').Modulation,
  m2cfg: import('@shared/types').Modulation,
  mod2NormBipolar: number
): import('@shared/types').Modulation {
  const targets = m2cfg.targets
  if (!targets) return m1
  // Fast path — if no target is enabled, skip the per-tick clones.
  // The user-facing toggle UI defaults amounts > 0 but enable=false,
  // so this branch fires whenever the Mod 2 section is "on" but the
  // user hasn't checked any target yet.
  if (
    targets.rate?.enabled !== true &&
    targets.depth?.enabled !== true &&
    targets.shape?.enabled !== true
  ) {
    return m1
  }
  const mode = m2cfg.targetMode ?? 'multiplicative'
  let out: import('@shared/types').Modulation = m1
  // ── Rate ─────────────────────────────────────────────────────────
  // "Rate" maps to whatever drives modulator speed for the current
  // type. For LFO / S&H / Slew / Chaos / Random / Arp the rate
  // control is `rateHz` (or its BPM-synced equivalent, which is also
  // resolved from rateHz). For Strange Attractor the rate control is
  // `attractor.speed` — patching rateHz on an attractor is a silent
  // no-op because the attractor integration block never reads it.
  // We patch BOTH fields (the LFO-family field AND the attractor
  // speed) so the user's "Rate" knob always has an audible effect
  // regardless of Mod 1's type.
  if (targets.rate?.enabled) {
    const amt = (targets.rate.amount ?? 0) / 100
    // LFO-family rate (rateHz) — used by LFO, S&H, Slew, Chaos,
    // Random, Arpeggiator. Clamp to the engine's 0.01..20 Hz band.
    const baseRate = m1.rateHz
    let nextRate: number
    if (mode === 'additive') {
      // Bipolar swing ±(20 Hz × amount) around the base, clamped to
      // a sane LFO band. 20 Hz is the engine's upper LFO limit; the
      // additive math feels right when the swing is a fixed slice of
      // the legal range.
      nextRate = baseRate + mod2NormBipolar * 20 * amt
    } else {
      // multiplicative + mix
      nextRate = baseRate * (1 + mod2NormBipolar * amt)
    }
    nextRate = Math.max(0.01, Math.min(20, nextRate))
    out = { ...out, rateHz: nextRate }
    // Strange Attractor — patch `attractor.speed` too. The engine
    // ignores rateHz for attractor and reads `attractor.speed`
    // exclusively; without this branch the Rate knob would be a
    // silent no-op when Modulation 1 = Strange Attractor.
    if (m1.type === 'attractor' && m1.attractor) {
      const baseSpeed = m1.attractor.speed
      let nextSpeed: number
      if (mode === 'additive') {
        // Speed sits in [0.05, 10] roughly; ±5× amount feels like
        // the LFO Rate's ±20 Hz at amount 100%.
        nextSpeed = baseSpeed + mod2NormBipolar * 5 * amt
      } else {
        nextSpeed = baseSpeed * (1 + mod2NormBipolar * amt)
      }
      nextSpeed = Math.max(0.05, Math.min(10, nextSpeed))
      out = {
        ...out,
        attractor: { ...m1.attractor, speed: nextSpeed }
      }
    }
    // Ramp — patch `ramp.rampMs` AND `ramp.totalMs`. Both are time
    // params (ms); rampMs feeds sync='free', totalMs feeds
    // sync='freeSync', so patching both lets the user pick either
    // sync mode and still feel the Rate target. INVERTED scaling:
    // higher Rate = SHORTER time, so the user's mental model "Rate
    // up = modulator faster" stays consistent across types.
    if (m1.type === 'ramp') {
      // Two paths so additive and multiplicative actually differ:
      //  multiplicative — INVERTED multiplier on the stored time so
      //    "higher Rate signal = shorter ramp" stays consistent across
      //    types. mod2=+1 @ amount=100% → time × 0 (clamped to a safe
      //    min); mod2=-1 → time × 2 (twice as slow).
      //  additive — bipolar swing of ±(2000 ms × amount) ADDED on top
      //    of the base, clamped to [0.1, 300000]. Lets short ramps
      //    survive (multiplicative pinches them to near-zero at high
      //    amounts; additive holds the floor at base − 2000 ms).
      let nextRampMs: number
      let nextTotalMs: number
      if (mode === 'additive') {
        const delta = -mod2NormBipolar * 2000 * amt
        nextRampMs = Math.max(0.1, Math.min(300000, m1.ramp.rampMs + delta))
        nextTotalMs = Math.max(
          0.1,
          Math.min(300000, (m1.ramp.totalMs ?? m1.ramp.rampMs) + delta)
        )
      } else {
        const factor = Math.max(0.01, 1 - mod2NormBipolar * amt)
        nextRampMs = Math.max(0.1, Math.min(300000, m1.ramp.rampMs * factor))
        nextTotalMs = Math.max(
          0.1,
          Math.min(300000, (m1.ramp.totalMs ?? m1.ramp.rampMs) * factor)
        )
      }
      out = {
        ...out,
        ramp: { ...m1.ramp, rampMs: nextRampMs, totalMs: nextTotalMs }
      }
    }
  }
  // ── Depth ────────────────────────────────────────────────────────
  if (targets.depth?.enabled) {
    const amt = (targets.depth.amount ?? 0) / 100
    const baseDepth = m1.depthPct
    let nextDepth: number
    if (mode === 'additive') {
      // ±(100 × amount) around base, clamped to 0..100.
      nextDepth = baseDepth + mod2NormBipolar * 100 * amt
    } else {
      // multiplicative + mix
      nextDepth = baseDepth * (1 + mod2NormBipolar * amt)
    }
    nextDepth = Math.max(0, Math.min(100, nextDepth))
    out = { ...out, depthPct: nextDepth }
  }
  // ── Shape — context-aware per Mod 1's type ───────────────────────
  if (targets.shape?.enabled) {
    const amt = (targets.shape.amount ?? 0) / 100
    // Use mod2 in [0, 1] for distribution-like targets, [-1, +1]
    // (signed) for symmetric morphs.
    const u01 = (mod2NormBipolar + 1) * 0.5
    switch (m1.type) {
      case 'lfo': {
        // Morph the existing shape via a "shape index" sweep over
        // the ordered shape list. Crude but musical — moves through
        // sine → tri → square → saw → rev-saw → stepped → smooth
        // → spastic as mod2 swings. Centre = current shape.
        const order: import('@shared/types').LfoShape[] = [
          'sine',
          'triangle',
          'square',
          'sawtooth',
          'rndStep',
          'rndSmooth',
          'spastic'
        ]
        const curIdx = Math.max(0, order.indexOf(m1.shape))
        const offset = Math.round(mod2NormBipolar * amt * (order.length - 1))
        const nextIdx = Math.max(0, Math.min(order.length - 1, curIdx + offset))
        out = { ...out, shape: order[nextIdx] }
        break
      }
      case 'sh': {
        const baseDist = m1.sh.distribution ?? 0.5
        let nextDist: number
        if (mode === 'multiplicative' || mode === 'mix') {
          nextDist = baseDist + (u01 - 0.5) * amt
        } else {
          nextDist = baseDist + mod2NormBipolar * amt * 0.5
        }
        nextDist = Math.max(0, Math.min(1, nextDist))
        out = { ...out, sh: { ...(out.sh ?? m1.sh), distribution: nextDist } }
        break
      }
      case 'attractor': {
        const baseChaos = m1.attractor?.chaos ?? 0.5
        let nextChaos: number
        if (mode === 'multiplicative' || mode === 'mix') {
          nextChaos = baseChaos * (1 + mod2NormBipolar * amt)
        } else {
          nextChaos = baseChaos + mod2NormBipolar * amt
        }
        nextChaos = Math.max(0, Math.min(1, nextChaos))
        // Spread from `out.attractor` (which carries any Rate-target
        // patch to `speed` made earlier in this function) rather than
        // `m1.attractor`. Reading from `m1` would overwrite the
        // already-patched speed back to its base value — Speed and
        // Chaos targets must compose.
        out = {
          ...out,
          attractor: {
            ...(out.attractor ?? m1.attractor ?? { type: 'lorenz', speed: 1, chaos: 0.5 }),
            chaos: nextChaos
          }
        }
        break
      }
      case 'chaos': {
        const baseR = m1.chaos.r
        // r is a stability knob in [3.4, 4.0]; multiplicative is too
        // jumpy at this narrow range, so always additive for chaos.r.
        const nextR = Math.max(3.4, Math.min(4.0, baseR + mod2NormBipolar * amt * 0.6))
        out = { ...out, chaos: { ...(out.chaos ?? m1.chaos), r: nextR } }
        break
      }
      case 'random': {
        const baseDist = m1.random.distribution ?? 0.5
        const nextDist = Math.max(0, Math.min(1, baseDist + (u01 - 0.5) * amt))
        out = {
          ...out,
          random: { ...(out.random ?? m1.random), distribution: nextDist }
        }
        break
      }
      case 'slew': {
        // No obvious "shape" knob — morph between rise and fall
        // times symmetrically so positive mod2 lengthens both.
        const factor = 1 + mod2NormBipolar * amt
        const rise = Math.max(1, m1.slew.riseMs * factor)
        const fall = Math.max(1, m1.slew.fallMs * factor)
        out = {
          ...out,
          slew: { ...(out.slew ?? m1.slew), riseMs: rise, fallMs: fall }
        }
        break
      }
      case 'gesture': {
        // Gesture's continuous "personality" knob is Wiggle (0..100).
        // Multiplicative around the base feels natural — amount 100 %
        // with mod2 = +1 doubles wiggle, mod2 = -1 zeros it. Additive
        // does a ±100 × amount swing on top of the base.
        //
        // Special case: when baseWiggle === 0 (the factory default!),
        // multiplicative math is `0 * (1 + anything) = 0` → Mod 2 →
        // Shape silently does nothing. Fall through to additive so
        // the user gets a visible effect without having to set
        // baseWiggle > 0 manually.
        const baseWiggle = m1.gesture?.wiggle ?? 0
        let nextWiggle: number
        if (mode === 'additive' || baseWiggle === 0) {
          nextWiggle = baseWiggle + mod2NormBipolar * 100 * amt
        } else {
          nextWiggle = baseWiggle * (1 + mod2NormBipolar * amt)
        }
        nextWiggle = Math.max(0, Math.min(100, nextWiggle))
        // Spread from out.gesture (which carries any earlier
        // patches) and use DEFAULT_GESTURE as the final fallback so
        // we don't drift from the canonical shape if a new field
        // gets added to GestureParams later.
        out = {
          ...out,
          gesture: {
            ...(out.gesture ?? m1.gesture ?? {
              points: [],
              mode: 'xy',
              wiggle: 0,
              playMode: 'forward'
            }),
            wiggle: nextWiggle
          }
        }
        break
      }
      case 'envelope': {
        // Envelope's continuous "personality" knob is sustainLevel
        // (0..1). Multiplicative around the base feels natural —
        // amount 100 % with mod2 = +1 doubles sustain, mod2 = -1
        // zeros it. Additive uses the full 0..1 range as the swing.
        const baseSus = m1.envelope.sustainLevel
        let nextSus: number
        if (mode === 'additive') {
          nextSus = baseSus + mod2NormBipolar * amt
        } else {
          nextSus = baseSus * (1 + mod2NormBipolar * amt)
        }
        nextSus = Math.max(0, Math.min(1, nextSus))
        out = {
          ...out,
          envelope: {
            ...(out.envelope ?? m1.envelope),
            sustainLevel: nextSus
          }
        }
        break
      }
      case 'ramp': {
        // Ramp's "Curve" param is signed: -100 (ease-in / slow start)
        // to +100 (ease-out / fast start), 0 = linear. Always additive
        // because the base sits around 0 and a multiplicative swing
        // doesn't move past the sign barrier cleanly. ±100 × amount
        // around the base, clamped to the legal range.
        const baseCurve = m1.ramp.curvePct ?? 0
        const nextCurve = Math.max(
          -100,
          Math.min(100, baseCurve + mod2NormBipolar * 100 * amt)
        )
        // Spread from `out.ramp` so the Rate target's earlier patch
        // of rampMs / totalMs survives the curve patch. Reading from
        // `m1.ramp` would silently overwrite both back to their base
        // values.
        out = {
          ...out,
          ramp: { ...(out.ramp ?? m1.ramp), curvePct: nextCurve }
        }
        break
      }
      case 'arpeggiator': {
        // Arpeggiator's continuous-ish knob is the Mode picker — an
        // ordered enum of musical-feeling step patterns. We map
        // mod2's [-1, +1] swing across the enum, centred on the base
        // mode's index. Amount = 100 % covers the full enum span;
        // smaller amounts keep nearby modes. Cosmetic note: mode
        // changes happen at the per-tick eval rate, which can be
        // fast — typically the user dials amount low.
        const order: import('@shared/types').ArpMode[] = [
          'up',
          'down',
          'upDown',
          'downUp',
          'exclusion',
          'walk',
          'drunk',
          'random'
        ]
        const baseIdx = Math.max(0, order.indexOf(m1.arpeggiator.arpMode))
        const span = order.length - 1
        const offset = Math.round(mod2NormBipolar * amt * span)
        const nextIdx = Math.max(0, Math.min(span, baseIdx + offset))
        out = {
          ...out,
          arpeggiator: {
            ...(out.arpeggiator ?? m1.arpeggiator),
            arpMode: order[nextIdx]
          }
        }
        break
      }
      default:
        // Any future modulator type without a shape param falls here
        // silently. Add a case above when you add a new ModType.
        break
    }
  }
  return out
}

// Build an "effective Sequencer" by applying Mod 2's bipolar signal
// to the cell's sequencer params, per the m2cfg.targetsSeq routing.
// Same model as applyMod2ToMod1 (Rate / Shape / Depth) but the actual
// fields patched depend on the sequencer mode:
//
//   Rate  -> bpm (when syncMode='bpm' or 'tempo') OR stepMs (free).
//            Both are patched so the user can flip syncMode without
//            losing the Mod 2 effect. Engine clamps to legal ranges.
//   Shape -> per-mode "musical personality" knob:
//              euclidean   -> rotation        (0..steps-1)
//              density     -> seed            (0..255)
//              cellular    -> rule            (0..255)
//              polyrhythm  -> ringALength     (1..16)
//              drift       -> bias            (-100..+100)
//              ratchet     -> ratchetProb     (0..100)
//              bounce      -> bounceDecay     (0..100)
//              steps/draw/adresse -> no-op (no single "personality"
//                                    knob that's musically dominant)
//   Depth -> genAmount (the universal Generative wildness slider,
//            0..100). Drives how far the generative variations stray
//            from the baseline pattern. Mod 2 -> Depth gives the
//            user a generative-wildness modulator -- swing genAmount
//            from 0 to 100 with an LFO for "calm/chaotic" breathing.
//
// Compare two numeric-token vectors and return a similarity score
// in [0, 1]. Used by the Generative Scene Sequencer's scene-pair
// similarity computation. Both inputs are pre-parsed numeric arrays
// (non-numeric tokens like 'compositor' have already been stripped
// upstream). Either side can be null when the cell had no numeric
// content; in that case we treat them as "matched non-numerics" and
// return 1.0 (vacuous match).
//
// The metric is symmetric element-wise normalized absolute
// difference: per token, 1 - |va - vb| / max(1, |va| + |vb|) -- a
// scale-aware difference that's robust to whether the values are
// 0..1, 0..127, or 60..127. Padding: when vectors differ in length,
// the shorter one is treated as zeros for the missing tail. That
// makes a 1-arg cell more similar to a 1-arg cell than to a 4-arg
// cell, which is the musical intuition we want.
function cellSimilarityFromTokens(
  a: number[] | null,
  b: number[] | null
): number {
  if (a === null && b === null) return 1
  if (a === null || b === null) return 0
  const n = Math.max(a.length, b.length)
  if (n === 0) return 1
  let sum = 0
  for (let i = 0; i < n; i++) {
    const va = a[i] ?? 0
    const vb = b[i] ?? 0
    const norm = Math.max(1, Math.abs(va) + Math.abs(vb))
    sum += 1 - Math.abs(va - vb) / norm
  }
  return sum / n
}

// Returns the same SequencerParams object reference when no target
// is enabled (cheap no-op when the user hasn't checked any box).
function applyMod2ToSeq(
  seq: import('@shared/types').SequencerParams,
  m2cfg: import('@shared/types').Modulation,
  mod2NormBipolar: number
): import('@shared/types').SequencerParams {
  const targets = m2cfg.targetsSeq
  if (!targets) return seq
  if (
    targets.rate?.enabled !== true &&
    targets.depth?.enabled !== true &&
    targets.shape?.enabled !== true
  ) {
    return seq
  }
  const mode = m2cfg.targetMode ?? 'multiplicative'
  let out: import('@shared/types').SequencerParams = seq
  // ── Rate -> bpm + stepMs ────────────────────────────────────────
  if (targets.rate?.enabled) {
    const amt = (targets.rate.amount ?? 0) / 100
    // BPM: 10..500. Multiplicative is musical (LFO ±100% halves /
    // doubles the tempo). Additive ±240 BPM × amount lets the user
    // pull base tempo all the way to the edges of the legal range.
    const baseBpm = seq.bpm
    let nextBpm: number
    if (mode === 'additive') {
      nextBpm = baseBpm + mod2NormBipolar * 240 * amt
    } else {
      nextBpm = baseBpm * (1 + mod2NormBipolar * amt)
    }
    nextBpm = Math.max(10, Math.min(500, nextBpm))
    // stepMs: 1..60000. Inverse relationship with rate (higher rate
    // = shorter step). Mirror BPM's signed-positive direction by
    // INVERTING the bipolar input on stepMs so "mod up = faster"
    // stays consistent across syncMode flips.
    const baseStepMs = seq.stepMs
    let nextStepMs: number
    if (mode === 'additive') {
      nextStepMs = baseStepMs - mod2NormBipolar * 500 * amt
    } else {
      nextStepMs = baseStepMs * (1 - mod2NormBipolar * amt)
    }
    nextStepMs = Math.max(1, Math.min(60000, nextStepMs))
    out = { ...out, bpm: nextBpm, stepMs: nextStepMs }
  }
  // ── Shape -> per-mode musical personality knob ──────────────────
  if (targets.shape?.enabled) {
    const amt = (targets.shape.amount ?? 0) / 100
    switch (seq.mode) {
      case 'euclidean': {
        // rotation in [0, steps-1]. Map mod2 swing across a span of
        // up to ±steps with the amount slider. Wraps so the rotation
        // stays in legal range even at extreme swings.
        const steps = Math.max(1, Math.min(16, seq.steps))
        const swing = Math.round(mod2NormBipolar * steps * amt)
        const next = ((seq.rotation % steps) + swing + steps * 4) % steps
        out = { ...out, rotation: next }
        break
      }
      case 'density': {
        // seed in [0, 2^32-1]. Add a swing of up to ±10000 × amount.
        // 10000 is enough to materially change the pseudorandom hits
        // pattern at full amount but small enough that low amounts
        // give micro-variations.
        const baseSeed = seq.seed >>> 0
        const swing = Math.round(mod2NormBipolar * 10000 * amt)
        const next = ((baseSeed + swing) >>> 0) % 4294967296
        out = { ...out, seed: next }
        break
      }
      case 'cellular': {
        // Wolfram rule in [0, 255]. Swing across ±255 × amount,
        // wrapped. Each rule produces a totally different evolving
        // pattern so this is a *strong* shape target -- low amounts
        // recommended for musical use.
        const baseRule = seq.rule
        const swing = Math.round(mod2NormBipolar * 255 * amt)
        let next = (baseRule + swing) % 256
        if (next < 0) next += 256
        out = { ...out, rule: next }
        break
      }
      case 'polyrhythm': {
        // ringALength in [1, 16]. Swing across ±15 × amount.
        const base = Math.max(1, Math.min(16, seq.ringALength))
        const swing = Math.round(mod2NormBipolar * 15 * amt)
        const next = Math.max(1, Math.min(16, base + swing))
        out = { ...out, ringALength: next }
        break
      }
      case 'drift': {
        // bias in [-100, +100]. Additive feels right -- the user
        // sets a base bias and Mod 2 swings around it.
        const baseBias = seq.bias
        const next = Math.max(-100, Math.min(100, baseBias + mod2NormBipolar * 100 * amt))
        out = { ...out, bias: next }
        break
      }
      case 'ratchet': {
        // ratchetProb in [0, 100]. Multiplicative would null out at
        // 0 base; additive ±100 × amount lets bursts breathe in /
        // out independent of the baseline.
        const base = seq.ratchetProb
        let next: number
        if (mode === 'additive') {
          next = base + mod2NormBipolar * 100 * amt
        } else {
          next = base * (1 + mod2NormBipolar * amt)
        }
        next = Math.max(0, Math.min(100, next))
        out = { ...out, ratchetProb: next }
        break
      }
      case 'bounce': {
        // bounceDecay in [0, 100]. Same shape as ratchetProb.
        const base = seq.bounceDecay
        let next: number
        if (mode === 'additive') {
          next = base + mod2NormBipolar * 100 * amt
        } else {
          next = base * (1 + mod2NormBipolar * amt)
        }
        next = Math.max(0, Math.min(100, next))
        out = { ...out, bounceDecay: next }
        break
      }
      default:
        // 'steps', 'draw', 'adresse' -- no single dominant
        // "personality" knob worth modulating here. Silent no-op so
        // future modes can be added above without touching this.
        break
    }
  }
  // ── Depth -> genAmount (universal Generative wildness knob) ─────
  if (targets.depth?.enabled) {
    const amt = (targets.depth.amount ?? 0) / 100
    const base = seq.genAmount
    let next: number
    if (mode === 'additive') {
      next = base + mod2NormBipolar * 100 * amt
    } else {
      next = base * (1 + mod2NormBipolar * amt)
    }
    next = Math.max(0, Math.min(100, next))
    out = { ...out, genAmount: next }
  }
  return out
}
