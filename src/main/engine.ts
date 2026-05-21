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

import type { Cell, EngineState, LfoShape, Modulation, Scene, SequencerParams, Session } from '@shared/types'
import { META_KNOB_COUNT, SCALE_INTERVALS } from '@shared/types'
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
  prevRampMode: 'normal' | 'inverted' | 'loop' | null
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
  // Cached flag: true when at least one template in the session has
  // `hardwareMode.enabled === true`. `handleHardwareInput` consults
  // this BEFORE doing any per-packet work, so when HW Mode is off
  // session-wide (the common case), the OSC hook is effectively a
  // no-op and doesn't allocate or scan templates on every incoming
  // packet. Recomputed on every `updateSession`.
  private hasAnyHardwareModeEnabled = false

  async start(): Promise<void> {
    await this.sender.start()
    this.startTicker()
  }

  stop(): void {
    this.stopTicker()
    this.sender.stop()
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
      lastEmittedVelocityByCell: lastVel
    })
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
    numericArgs: number[]
  ): void {
    if (!this.session) return
    // Fast path: avoid any per-packet work when no template has HW
    // Mode enabled session-wide. The hook fires on EVERY incoming
    // OSC packet (200 Hz+ from a continuous controller), so the
    // filter + array allocation below was non-trivial overhead even
    // when HW Mode was off. Cached on session update via
    // `this.hasAnyHardwareModeEnabled`.
    if (!this.hasAnyHardwareModeEnabled) return
    const deviceKey = `${ip}:${port}`
    const now = Date.now()
    // Find matching templates whose HW Mode is enabled + bound to
    // this device. Most sessions have 0-1 such templates so this
    // scan is cheap; if it ever becomes hot we can pre-index it.
    const matchedTemplates = this.session.pool.templates.filter((tpl) => {
      const hw = tpl.hardwareMode
      return (
        !!hw &&
        hw.enabled &&
        hw.deviceIp === ip &&
        hw.devicePort === port
      )
    })
    if (matchedTemplates.length === 0) return
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
    for (let i = 0; i < numericArgs.length; i++) {
      const prev = prevVals[i]
      const prevTs = prevChange[i] ?? 0
      const cur = numericArgs[i]
      if (typeof prev !== 'number' || typeof cur !== 'number') {
        movingPerSlot.push(false)
      } else {
        // Use any matching template's movementThreshold (they SHOULD
        // all be similar; pick the first). MovementWindowMs gates
        // the "treat static streams as not moving" behaviour.
        const hw = matchedTemplates[0].hardwareMode!
        const delta = Math.abs(cur - prev)
        const aged = now - prevTs > hw.movementWindowMs
        // Moving if the delta crossed the threshold OR if we've gone
        // movementWindowMs without any change AND the new value
        // differs from the cached one (an end-of-static-burst
        // movement). For a controller that streams 200 Hz the same
        // value, prev === cur for every packet → no movement.
        const moving = delta > hw.movementThreshold && !aged
        movingPerSlot.push(moving)
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
    for (let i = 0; i < numericArgs.length; i++) {
      if (typeof prevVals[i] !== 'number') {
        prevVals[i] = numericArgs[i]
        prevChange[i] = now
      }
    }
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
        for (let i = 0; i < numericArgs.length; i++) {
          if (lockedSlots && !lockedSlots.includes(i)) continue
          if (!movingPerSlot[i]) continue
          const hwVal = numericArgs[i]
          const catchKey = `${track.id}|${i}`
          if (this.hardwareCaught.get(catchKey)) {
            // Already caught — just refresh the override value.
            this.hardwareOverride.set(catchKey, hwVal)
            continue
          }
          // Not yet caught — check against currently-emitted scene
          // value. Pull from the most recent ts.lastSentNumeric for
          // this track. If nothing's been emitted yet, skip until
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
  }

  /** Clear all hardware catch state. Called on scene change when any
   *  active HW Mode is in 'reset' mode (the default). In 'persist'
   *  mode the catch state survives scene changes so a knob mid-turn
   *  keeps driving the new scene's parameter. */
  private clearHardwareCatchIfReset(): void {
    if (!this.session) return
    // Only clear when AT LEAST ONE active HW template is in 'reset'
    // mode. If every active template is 'persist', skip the clear.
    const hasResetMode = this.session.pool.templates.some((tpl) => {
      const hw = tpl.hardwareMode
      return !!hw && hw.enabled && hw.mode === 'reset'
    })
    if (!hasResetMode) return
    this.hardwareCaught.clear()
    this.hardwareOverride.clear()
  }

  updateSession(next: Session): void {
    const prevTickRate = this.session?.tickRateHz
    const prevMidiEnabled = this.session?.midiEnabled
    // Detect "fresh session load" so we can prime the HW catch state
    // from `next.hardwareState` exactly once. Heuristic: the engine's
    // own catch map is currently EMPTY (which is true at boot and
    // after an explicit `stop()`, but also after every catch has
    // been released — fine, priming an empty session into an empty
    // map is a no-op). Subsequent updateSession calls (autosave,
    // undo, in-flight session edits) leave the live map alone.
    const liveMapEmpty = this.hardwareCaught.size === 0
    this.session = next
    // Refresh the fast-path flag for handleHardwareInput. Cheap to
    // recompute on session updates (a few-dozen templates max), and
    // saves the per-packet filter+allocation when HW Mode is off
    // session-wide — which is the common case.
    this.hasAnyHardwareModeEnabled = next.pool.templates.some(
      (t) => t.hardwareMode?.enabled === true
    )
    // Restore persisted HW catch state on a fresh session load. The
    // override VALUES are not restored — they self-heal on the next
    // OSC packet from the bound device (handleHardwareInput refreshes
    // hardwareOverride every packet). What we restore is the BINARY
    // "this slot is caught" so the renderer's red highlight comes
    // back immediately, and the engine substitutes the HW value
    // (once it arrives) instead of waiting for a fresh re-catch.
    if (liveMapEmpty && next.hardwareState?.caughtByTrack) {
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
    // Propagate the global MIDI on/off to the sender. Flipping off
    // closes every open port (zero CPU); flipping on lets the next
    // emit lazy-open ports as needed.
    if (prevMidiEnabled !== next.midiEnabled) {
      this.midiSender.setEnabled(!!next.midiEnabled)
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
    opts?: { morphMs?: number; sourceSlotIdx?: number | null }
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
    this.armSceneAdvance(scene)
    this.emitState()
  }

  private armSceneAdvance(scene: Scene): void {
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
    const effectiveDuration =
      slotOverride?.durationSec !== undefined &&
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
      // Stop now *actually* stops everything. Previously the engine kept
      // the scene "alive" as long as any cell had modulation or sequencer
      // enabled — useful in theory, but the user's intent with Stop is
      // "end the scene here." Morph every active cell back to 0 over its
      // own transitionMs and clear the active-scene state.
      if (effectiveNextMode === 'stop') {
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

  private advanceScene(current: Scene, modeOverride?: Scene['nextMode']): void {
    if (!this.session) return
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
      const oscEmitAllowed =
        (cell.oscEnabled ?? true) && (track?.oscEnabled ?? true)
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
        const mod2NormBipolar = evalMod2Bipolar(
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
        // Shallow-clone the cell with the patched modulation so any
        // downstream code reading `cell.modulation` sees the
        // effective version. The original cell in the session stays
        // untouched.
        cell = { ...cell, modulation: effMod1 }
        // ── Live preview emit ─────────────────────────────────────
        // If the Inspector is watching this exact (scene, track), send
        // the effective Mod 1 to it at ~30 Hz. Throttled so we don't
        // bury the renderer in IPC chatter at high tick rates. Only
        // emits the params Mod 2 can target — see Mod1LiveSample.
        const sel = this.selectedCellForLive
        if (
          this.onMod1Live &&
          sel &&
          sel.trackId === trackId &&
          ts.activeSceneId === sel.sceneId &&
          t - this.lastMod1LiveEmitAt >= 33
        ) {
          this.lastMod1LiveEmitAt = t
          const sample: import('@shared/types').Mod1LiveSample = {
            sceneId: sel.sceneId,
            trackId: sel.trackId,
            rateHz: effMod1.rateHz,
            depthPct: effMod1.depthPct
          }
          // Populate the type-specific Shape readout so the Inspector
          // can overlay the live value on the relevant control.
          switch (effMod1.type) {
            case 'lfo':
              sample.lfoShape = effMod1.shape
              break
            case 'sh':
              sample.shDistribution = effMod1.sh.distribution
              break
            case 'random':
              sample.randomDistribution = effMod1.random.distribution
              break
            case 'attractor':
              sample.attractorChaos = effMod1.attractor?.chaos
              // Also surface the effective speed so the AttractorEditor
              // can animate its Speed slider when Modulation 2 →
              // Rate target is on.
              sample.attractorSpeed = effMod1.attractor?.speed
              break
            case 'chaos':
              sample.chaosR = effMod1.chaos.r
              break
            case 'slew':
              sample.slewRiseMs = effMod1.slew.riseMs
              sample.slewFallMs = effMod1.slew.fallMs
              break
            case 'envelope':
              sample.envelopeSustain = effMod1.envelope.sustainLevel
              break
            case 'ramp':
              sample.rampCurvePct = effMod1.ramp.curvePct
              // Effective ramp length (ms) — Modulation 2's Rate
              // target inverts time, so this can feel completely
              // different from the stored rampMs.
              sample.rampMs = effMod1.ramp.rampMs
              break
            case 'arpeggiator':
              sample.arpMode = effMod1.arpeggiator.arpMode
              break
          }
          this.onMod1Live(sample)
        }
      }

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
              // 3. Default — random-generated value (the original logic).
              if (rnd.valueType === 'float') {
                if (cell.scaleToUnit) {
                  return { type: 'f' as const, value: normalise(v) }
                }
                // Quantize to 1e-11 for stable output.
                const q = Math.round(v * 1e11) / 1e11
                return { type: 'f' as const, value: q }
              }
              // int or colour — integer output in [rndLo, rndHi].
              // Under scaleToUnit we emit a FLOAT in [0, 1] (matching
              // the rest of the engine's scaleToUnit convention) so
              // the receiver sees actual proportions instead of a
              // collapsed 0/1.
              const n = Math.round(v)
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
        // Adresse mode — clock is bypassed entirely; the playhead is
        // READ from the modulator's normalised output. floor(mod * N)
        // picks the active step, so a smooth modulator (LFO, Strange
        // Attractor) scrubs through the step values like a quantised
        // wavetable scanner; a stepped modulator (S&H, Random)
        // teleports between steps. Inspired by the Buchla 245
        // sequential voltage source.
        const stepsA = effectiveSteps(cell)
        let modAddrUnit = 0.5
        if (cell.modulation.enabled) {
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
            const depth01 = cell.modulation.depthPct / 100
            out = center * (1 - depth01 + depth01 * envGain)
          } else if (cell.modulation.type === 'ramp') {
            // One-shot 0→1 ramp, depth-mixed identically to envelope. Once
            // the ramp completes, rampGain stays at 1 so the output settles
            // at `center` (modulator becomes neutral, as requested).
            const depth01 = cell.modulation.depthPct / 100
            out = center * (1 - depth01 + depth01 * rampGain)
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
          !hwActiveForSlot
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

function arpStartStep(arp: {
  steps: number
  arpMode: import('@shared/types').ArpMode
}): number {
  const N = Math.max(1, Math.min(8, arp.steps))
  if (arp.arpMode === 'random') return Math.floor(Math.random() * N)
  if (arp.arpMode === 'walk' || arp.arpMode === 'drunk') return 0
  // Deterministic: start at pattern[0].
  const pat = buildArpPattern(arp.arpMode, N)
  return pat[0] ?? 0
}

function advanceArpStep(
  ts: TrackState,
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
    mode?: 'normal' | 'inverted' | 'loop'
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
  // Loop mode: take elapsed time modulo the ramp period so the curve
  // retriggers every period instead of holding at 1 after completing.
  // Normal/Inverted: clamp at edges (0 before, 1/0 after).
  let lin: number
  if (mode === 'loop') {
    if (elapsedSec <= 0) lin = 0
    else lin = (elapsedSec % lenSec) / lenSec
  } else {
    if (elapsedSec <= 0) return mode === 'inverted' ? 1 : 0
    if (elapsedSec >= lenSec) return mode === 'inverted' ? 0 : 1
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
  return mode === 'inverted' ? 1 - shaped : shaped
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
  // Envelope / Ramp / Arpeggiator / Random → handled by evalMod2Bipolar
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
    case 'ramp':
    case 'arpeggiator':
    case 'random':
      // Not supported as Mod 2 — treat as no-op so the user doesn't
      // get surprising "Mod 2 silently zeroed Mod 1" behaviour.
      return 0
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
      // Inverted multiplier: mod2 = +1 with amount = 100 % → time × 0
      // (clamped to safe min); mod2 = -1 → time × 2 (twice as slow).
      const factor =
        mode === 'additive'
          ? 1 - mod2NormBipolar * amt
          : 1 - mod2NormBipolar * amt
      const clampedFactor = Math.max(0.01, factor)
      const nextRampMs = Math.max(
        0.1,
        Math.min(300000, m1.ramp.rampMs * clampedFactor)
      )
      const nextTotalMs = Math.max(
        0.1,
        Math.min(300000, (m1.ramp.totalMs ?? m1.ramp.rampMs) * clampedFactor)
      )
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
