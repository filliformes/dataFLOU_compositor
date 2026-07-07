// Shared types used by main, preload, and renderer.

export type LfoShape = 'sine' | 'triangle' | 'sawtooth' | 'square' | 'rndStep' | 'rndSmooth' | 'spastic'
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

// Per-slot overrides for the Sequence view. When the same scene is
// dropped into multiple slots, each placement can override the
// scene's duration and/or follow action without affecting the other
// slots. The scene's OSC/MIDI cells (its actual content) stay
// shared across slots — only the playback envelope differs.
//
// Each field is optional. Engine logic: read `override.durationSec ??
// scene.durationSec` when starting playback, and `override.nextMode
// ?? scene.nextMode` when the duration expires. A slot with an empty
// override object (both fields undefined) is semantically identical
// to having no override.
export interface SequenceSlotOverride {
  durationSec?: number
  nextMode?: NextMode
}

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
  | 'attractor'
  | 'gesture'

// Strange Attractor modulator — smooth correlated chaos via 3D or 4D
// ODE integration. Unlike 1-D Chaos (logistic map), the attractor's
// trajectory is bounded but never repeats, and its channels are
// correlated rather than independently random. For a multi-arg cell:
//   - 3D types: slot 0=X, 1=Y, 2=Z, 3=speed (|dx,dy,dz|, normalised)
//   - 4D types: slot 0=W, 1=X, 2=Y, 3=Z
// Slots ≥ 4 read the last channel (Z or W) — gracefully degrades.
export type AttractorType =
  | 'lorenz'
  | 'aizawa'
  | 'thomas'
  | 'rossler'
  | 'rossler4d'
  | 'lu4d'

export interface AttractorParams {
  type: AttractorType
  // Multiplier on the ODE integration step (1× = canonical speed for
  // that attractor at the engine's tick rate). Range exposed in
  // Inspector: 0.05..10. Higher = trajectory sweeps faster.
  speed: number
  // Per-attractor "chaos amount" knob. Maps to the attractor's most
  // expressive bifurcation parameter — Lorenz σ, Rössler c, etc.
  // 0..1; 0.5 = canonical chaos. Outside the chaotic band the
  // trajectory can converge to a fixed point or limit cycle, which
  // is a legitimate (if static) musical state.
  chaos: number
}

// Gesture playback direction.
//   'forward'  — playhead sweeps 0 → 1 each loop (default; matches
//                the recorded direction).
//   'backward' — playhead sweeps 1 → 0 each loop (reverse).
//   'pingpong' — playhead traces 0 → 1 → 0 each loop (triangle wave;
//                covers twice as much ground at the same Rate, so
//                halve the Rate if you want forward-and-back to feel
//                as slow as a single forward pass).
export type GesturePlayMode = 'forward' | 'backward' | 'pingpong'

// Gesture modulator — XY gesture recorder.
//
// The user RECORDS an X/Y stream by dragging across a square surface
// in the Inspector. Captured points are stored as a polyline in
// [0, 1]² with relative timestamps. Playback loops the gesture at
// the modulator's standard Rate (Hz or BPM-synced) and feeds the
// (x, y) stream to the cell's slots, with optional Wiggle that
// jitters the playhead back and forth between adjacent points (0 =
// smooth linear advance; 100 = chaotic dance within the local
// segment).
//
// Output routing — see GestureMode doc below.
//   'xy'     — slot 0 receives X, slot 1 receives Y; slots ≥ 2 read
//              the X channel (so they're musically related rather
//              than dead). Best for multi-arg cells where the two
//              channels are user-meaningful (XY pad, stereo position).
//   'merged' — both X + Y collapse to a single value via radial
//              distance √(x² + y²) / √2 (unit square → [0, 1]) and
//              broadcast to every slot. Best for single-arg cells
//              where you just want "how far from origin".
//
// Wiggle 0..100:
//   - 0    smooth linear advance through the recorded curve
//   - 100  the playhead is overlaid with a fast sinusoidal jitter
//          spanning roughly one inter-point gap; visually you see
//          the curve being "scrubbed" with a tremolo
//
// Mod 2's Shape target on Gesture sweeps Wiggle. Mod 2's Rate target
// uses the standard rateHz patch — no special handling.
export interface GestureParams {
  points: GesturePoint[]
  mode: GestureMode
  // Sinusoidal back-and-forth jitter overlaid on the linear advance.
  // 0..100; 0 = smooth, 100 = ±~one inter-point gap swing at ~5×
  // the loop rate.
  wiggle: number
  // Playhead direction. Optional + 'forward' default so sessions
  // saved before this field shipped behave identically.
  playMode?: GesturePlayMode
}
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
  // Distribution skew applied to each random draw, in [0, 1].
  //   0.0  → edge-weighted (values cluster near min and max)
  //   0.5  → uniform (raw rng, default)
  //   1.0  → centre-hugging (values cluster near the midpoint)
  // Implemented as a symmetric power-law warp around 0.5: see
  // `warpDistribution()` in engine.ts. Per-draw; takes effect mid-
  // play with no re-trigger. Inspired by the Buchla 266 "Stored
  // Random Voltages" probability-distribution control.
  distribution?: number
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
  // Same skew as `RandomParams.distribution` — applied to each new
  // S&H sample. 0.5 = uniform (default); see warpDistribution() in
  // engine.ts.
  distribution?: number
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
  // Mode: how the ramp behaves over time.
  //   'normal'   — one-shot 0 → 1 ramp, holds at 1 after completing (default)
  //   'inverted' — one-shot 1 → 0 ramp (mirror of normal), holds at 0
  //   'loop'     — repeats the 0 → 1 ramp forever, retriggering at every period
  //   'from'     — one-shot ramp interpolating fromValue → toValue over the
  //                ramp time (instead of the fixed 0 → 1). The base progress p
  //                is computed exactly like 'normal' (respecting curvePct and
  //                the rampMs/sync timing); the output is then mapped to
  //                fromValue + (toValue - fromValue) * p. depth/curve apply as
  //                in normal mode, so 'from' composes identically with depthPct
  //                and the cell's scaling.
  mode: 'normal' | 'inverted' | 'loop' | 'from'
  // 'from' mode endpoints. Defaults: fromValue 0, toValue 1 (which makes
  // 'from' identical to 'normal' until the user changes them). Allowed to be
  // negative or >1 — users may ramp raw OSC values, not just unit floats.
  fromValue?: number  // ramp start value (default 0)
  toValue?: number    // ramp end value (default 1)
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
  // Strange Attractor params (used when type='attractor'). Optional
  // for back-compat with sessions saved before the type existed —
  // the engine falls back to canonical defaults when reading from
  // an old session.
  attractor?: AttractorParams
  // Gesture modulator params (used when type='gesture'). Optional
  // for back-compat — engine treats a missing block as an empty
  // recording (modulator emits a quiet centre value of 0.5).
  gesture?: GestureParams
  // ── Two-stage modulator: stage-2 targeting ────────────────────────
  // These fields are READ only when a Modulation is in use as the
  // SECOND stage (i.e. assigned to Cell.modulation2). For stage-1
  // they're harmless dead weight. They describe how this modulator's
  // bipolar [-1,+1] output is applied to the first-stage modulator's
  // Rate, Depth, and a context-aware third parameter (called "Shape"
  // in the UI but the underlying field depends on the first-stage
  // type — LFO shape morph, S&H/Random distribution, Attractor chaos,
  // etc.). Optional + back-compat: undefined arrays mean "no target
  // active" so old sessions don't accidentally start modulating.
  targets?: ModulationTargets
  // Math mode for applying the stage-2 signal to stage-1's params.
  //   multiplicative - base * (1 + mod2 * amount/100)
  //   additive       - base + mod2 * (rangeMax * amount/100)
  //   mix            - rate/depth multiplicative, shape additive
  // Default 'multiplicative' (most musical for rate + depth).
  targetMode?: ModulationTargetMode
  // ── Stage-2 → Sequencer routing (parallel to `targets`) ───────────
  // When this Modulation acts as stage-2 (i.e. assigned to
  // Cell.modulation2), `targetsSeq` lets it also modulate the cell's
  // Sequencer params. Same shape as `targets` so the UI is mirrored.
  //   rate  → cell.sequencer.bpm (or stepMs if syncMode='free')
  //   shape → mode-dependent generative parameter (rotation for
  //           euclidean, seed for density, rule for cellular,
  //           ringALength for polyrhythm, bias for drift,
  //           ratchetProb for ratchet, bounceDecay for bounce)
  //   depth → cell.sequencer.genAmount (the Generative wildness knob)
  // Optional + back-compat: undefined / missing entries mean "no
  // sequencer target active" so v0.5.8 sessions load unchanged.
  targetsSeq?: ModulationTargets
  // ── Stage-2 → direct Value routing ────────────────────────────────
  // When this Modulation acts as stage-2 (i.e. assigned to
  // Cell.modulation2), these two fields configure the M2 → VALUE
  // direct route: Mod 2's bipolar [-1,+1] signal applied STRAIGHT to
  // the cell's per-arg value slots, exactly like Mod 1's contribution
  // — in addition to (not instead of) the M2>1 / M2>S routes above.
  // Gated per slot by `cell.routing.modulation2Direct[i]` (which,
  // unlike every other routing array, defaults FALSE — see the
  // comment on that field).
  //
  // `valueAmount` is the DEDICATED intensity for this route (0..1,
  // default 0.5). Deliberately NOT the Depth knob — Depth keeps
  // shaping Mod 2's own signal as before.
  //
  // `valueMath` picks how the M2-direct contribution combines with
  // the Mod 1-modulated value on slots where BOTH routes are active
  // (mirrors the M2>1 ModulationTargetMode trio's semantics):
  //   'add'  - sum the offsets: out = mod1Out + m2Offset    [default]
  //   'mult' - multiplicative:  out = mod1Out * (1 + mod2 * amount)
  //   'mix'  - 50/50 crossfade between the Mod 1-modulated value and
  //            the Mod 2-only-modulated value (center + m2Offset).
  // Optional + back-compat: missing fields read as the defaults.
  valueAmount?: number
  valueMath?: 'add' | 'mult' | 'mix'
}

// Two-stage routing — how Mod 2's bipolar signal touches each of
// Mod 1's three controllable params. Per-target enable + amount so
// you can deeply wiggle the Rate while only nudging the Shape.
export interface ModulationTargets {
  rate?: { enabled: boolean; amount: number /* 0..100 */ }
  depth?: { enabled: boolean; amount: number /* 0..100 */ }
  shape?: { enabled: boolean; amount: number /* 0..100 */ }
}

export type ModulationTargetMode = 'multiplicative' | 'additive' | 'mix'

// Sequencer tempo source:
//   'bpm'   — lock step rate to the session's global BPM
//   'tempo' — use the sequencer's own per-clip bpm slider
//   'free'  — use the per-clip stepMs value (independent of any BPM)
export type SeqSyncMode = 'bpm' | 'tempo' | 'free'

// Sequencer drive mode:
//   'steps'      — classic 1..16 step cycle, each step plays stepValues[i].
//   'euclidean'  — Bjorklund pattern: `pulses` active hits distributed as
//                  evenly as possible over `steps` total, rotated by
//                  `rotation`. Active step i still emits stepValues[i];
//                  inactive steps are silent.
//   'polyrhythm' — Two independent ring clocks of length `ringALength` and
//                  `ringBLength`; each "fires" at multiples of its length
//                  inside the master cycle. Combined via `combine` (OR /
//                  XOR / AND) into a gate. Tiny inputs → long emergent
//                  patterns (3-against-7, etc.).
//   'density'    — Each step has an internal probability derived from
//                  hash(step, seed); fires when that probability falls
//                  under `density / 100`. Same seed = same personality;
//                  density is a master "how busy" knob.
//   'cellular'   — 1D Wolfram cellular automaton. Each cycle the row
//                  evolves: every step's next state is f(left, self,
//                  right) per the chosen `rule` (0..255). Rule 30 ≈
//                  quasi-random, Rule 90 ≈ Sierpinski symmetry, Rule 110
//                  ≈ gliders.
//   'drift'      — Brownian playhead. Step row is fixed; the head walks
//                  +1 / 0 / -1 each clock based on `bias` (-100..+100%).
//                  `edge` controls boundary behaviour (wrap or reflect).
//   'ratchet'    — Each step has a chance (`ratchetProb` %) of
//                  subdividing into a quick burst of 2..`ratchetMaxDiv`
//                  re-triggers within the step duration. Most audible on
//                  string / bool / int OSC targets that interpret each
//                  send as a fresh trigger.
//   'bounce'     — Real ball-bounce physics. Each cycle is one "drop":
//                  step 0 is the loud first impact, subsequent steps
//                  bounce at GEOMETRICALLY SHRINKING intervals with
//                  EXPONENTIALLY DECAYING amplitude. A single
//                  `bounceDecay` knob controls "bounciness" — both the
//                  time-acceleration and the value-decay come from the
//                  same coefficient so the gesture is unified.
//   'draw'       — Freely-drawn automation curve. The user sketches
//                  a curve on a rectangular canvas with the mouse;
//                  each x-position is a step, each y-position is the
//                  emitted value (normalised to [0, 1]). Step count
//                  caps higher than other modes (up to 64) so the
//                  curve has enough resolution to feel like a real
//                  DAW automation lane. Generative + Variation knobs
//                  don't apply — the curve IS the user's intention.
export type SeqMode =
  | 'steps'
  | 'euclidean'
  | 'polyrhythm'
  | 'density'
  | 'cellular'
  | 'drift'
  | 'ratchet'
  | 'bounce'
  | 'draw'
  | 'adresse'

// Gesture output routing — picks how the recorded (x, y) stream is
// mapped to the cell's argument slots.
//   xy     — slot 0 receives X, slot 1 receives Y; slots ≥ 2 fall
//            back to cell.value tokens. Best for multi-arg cells
//            where the two channels are user-meaningful (XY pad,
//            stereo position, etc.).
//   merged — both X + Y collapse to a single value via radial
//            distance √(x² + y²) / √2 (so the unit square maps to
//            [0, 1]). Broadcast to every slot. Best for single-arg
//            cells where you just want "how far from corner".
export type GestureMode = 'xy' | 'merged'

// A single sample in a recorded gesture. Time is RELATIVE to the
// recording's start (ms); x and y are normalised to [0, 1] inside the
// gesture canvas. Captured at the user's cursor at whatever rate the
// browser delivers pointermove events (usually 60 Hz).
export interface GesturePoint {
  t: number
  x: number
  y: number
}

// Adresse sub-mode — picks how the modulator and the addressed step
// value combine. Inspired by the Buchla 245 stage-addressing
// sequencer (modulation source IS the playhead, not the clock).
//   hijack    — Mod 1 ONLY addresses; the step's stored value emits
//               as-is (no further modulation on top). Default.
//   parallel  — Mod 1 addresses AND modulates the resulting step
//               value (double-effect, trippy in a good way).
//   stage2    — Two-stage modulator only: Mod 2 addresses, Mod 1
//               modulates the step value. Requires `stage2`
//               (otherwise falls back to `hijack` behaviour).
export type AdresseMode = 'hijack' | 'parallel' | 'stage2'

export type SeqCombine = 'or' | 'xor' | 'and'
export type SeqDriftEdge = 'wrap' | 'reflect'

export interface SequencerParams {
  enabled: boolean
  steps: number // 1..16, active count / master cycle length
  syncMode: SeqSyncMode
  bpm: number // 10..500 — used when syncMode='bpm' (1 step per beat)
  stepMs: number // used when syncMode='free'
  stepValues: string[] // fixed length 16; only first `steps` fire at runtime
  // Pattern dispatch.
  mode: SeqMode

  // Euclidean fields — only meaningful when mode === 'euclidean'.
  pulses: number   // 0..steps
  rotation: number // 0..steps-1

  // Polyrhythm fields — only meaningful when mode === 'polyrhythm'.
  ringALength: number // 1..16
  ringBLength: number // 1..16
  combine: SeqCombine

  // Density fields — only meaningful when mode === 'density'.
  density: number // 0..100, master probability scaler
  seed: number    // 0..255, picks the "personality" of which steps fire

  // Cellular fields — only meaningful when mode === 'cellular'.
  rule: number     // 0..255, Wolfram rule number
  cellSeed: number // 0..65535 bitmask of initial row; 0 = single center cell
  // Seed LFO — when depth > 0, the engine re-seeds the cellular
  // automaton on each cycle wrap with a value modulated around
  // cellSeed by a slow LFO. Lets the pattern slowly drift through
  // adjacent seed values over time, producing a generative
  // "wandering pattern" feel without manually changing seed.
  cellularSeedLfoDepth: number // 0..100 (% of full 0..65535 range)
  cellularSeedLfoRate: number  // 0.01..10 Hz

  // Drift fields — only meaningful when mode === 'drift'.
  bias: number       // -100..+100 (% forward bias; 0 = pure random walk)
  edge: SeqDriftEdge

  // Ratchet fields — only meaningful when mode === 'ratchet'.
  ratchetProb: number   // 0..100, per-step probability of subdividing
  ratchetMaxDiv: number // 2..16, max subdivision count (always integer)
  // Variation: 0 = every step uses the global Probability + MaxDiv
  // verbatim. 100 = each step's prob & maxDiv are hash-randomised
  // off the global value so bursts feel less uniform across the
  // cycle. Deterministic per (step, seed) so the same seed always
  // produces the same per-step variation.
  ratchetVariation: number // 0..100
  // Mode: shape of the sub-pulse values within each burst.
  //   'octaves'  — every sub-pulse emits stepValue / subdiv (proportional
  //                scaling, like dividing the tempo)
  //   'ramp'     — sub i emits stepValue × (i+1)/subdiv (snare-roll rise)
  //   'inverse'  — mirror of Ramp: stepValue × (subdiv-i)/subdiv (fall)
  //   'pingpong' — rises then falls within the burst (triangle window)
  //   'echo'     — exponential decay (each sub ≈ base × 0.7^i, like a
  //                ball-bounce or guitar palm-mute echo)
  //   'trill'    — alternates base / base*0.5 across sub-pulses (an
  //                ornamental two-note flicker)
  //   'random'   — hash-driven scatter (each sub-pulse different)
  ratchetMode:
    | 'octaves'
    | 'ramp'
    | 'inverse'
    | 'pingpong'
    | 'echo'
    | 'trill'
    | 'random'

  // Bounce fields — only meaningful when mode === 'bounce'.
  // Maps 0..100 → physical coefficient e ∈ [0.40, 0.95]:
  //   0   → "dead bounce" (e=0.40): quick collapse, last bounces nearly
  //         back-to-back, then the cycle resets.
  //   100 → "super bouncy" (e=0.95): bounces barely decay, intervals
  //         stay almost uniform, sustained train of pulses.
  // Drives BOTH the per-step duration (geometric shrink) and, in
  // generative mode, the per-step value decay — so what you see and
  // what you hear are tied to the same physical knob.
  bounceDecay: number   // 0..100

  // Generative mode — when true, per-step values are no longer read
  // from `stepValues[]`. Instead the cell's `value` becomes the seed
  // / base intention, and each step's emitted value is computed live
  // from a per-mode organic rule (Tide / Accent / Voicing / Wave /
  // Crowd / Terrain / Scatter — see factory.ts). `genAmount` is one
  // shared "Variation" knob that every mode reinterprets:
  //   Steps      — tide swell depth
  //   Euclidean  — accent strength on downbeat hits
  //   Polyrhythm — spread between Ring A / Ring B / coincidence
  //   Density    — sine-wave amplitude sampled by the gate
  //   Cellular   — excitement range from neighbour count
  //   Drift      — height of the terrain hills the walker samples
  //   Ratchet    — scatter width across a burst's sub-pulses
  // 0 = flat (every step at base); 100 = full swing (±1 around base
  // for Scale-0..1 cells, ±the base value otherwise).
  generative: boolean
  genAmount: number // 0..100

  // Rest behaviour — what the engine emits between sequencer step
  // boundaries (ticks where the value hasn't changed).
  //   'last' — re-send the same value every tick (default; useful
  //            for receivers that need a continuous stream).
  //   'hold' — send nothing until the value actually changes;
  //            receivers naturally hold their previous value. Cuts
  //            redundant OSC and lets receivers own the sample-and-
  //            hold semantics.
  restBehaviour: SeqRestBehaviour

  // Draw fields — only meaningful when mode === 'draw'. The user
  // sketches a curve directly with the mouse; each x-position is a
  // step, y-position is a normalised [0, 1] value. The canvas Y
  // axis is labelled with `drawValueMin` / `drawValueMax` so the
  // drawn 0..1 curve maps to whatever output range the user wants
  // (e.g. -1..1 bipolar, 0..127 MIDI, 0..100 percent). Cap is high
  // (up to 1024) so curves can be near-continuous for DAW-like
  // automation lanes.
  drawValues: number[] // length up to 1024, values in [0, 1]
  drawSteps: number    // 4..1024
  drawValueMin: number // value at curve y=0 (canvas floor)
  drawValueMax: number // value at curve y=1 (canvas ceiling)

  // Adresse mode — picks how the per-clip modulator interacts with
  // the addressed step value. See `AdresseMode` doc above. Optional
  // for back-compat with sessions saved before the mode existed;
  // falls back to 'hijack' when undefined.
  adresseMode?: AdresseMode
}

// Sequencer rest-behaviour alias.
export type SeqRestBehaviour = 'last' | 'hold'

export interface Cell {
  // Destination. If `destLinkedToDefault` is true, destIp/destPort track the session default.
  destIp: string
  destPort: number
  destLinkedToDefault: boolean
  // OSC address path. If `addressLinkedToDefault`, tracks session default.
  oscAddress: string
  addressLinkedToDefault: boolean
  // Raw value string — type auto-detected at send time (bool → int → float → string).
  // When the cell's `midiOut.kind === 'note'`, the parsed value is
  // interpreted as the MIDI note number (0..127); a separate
  // `velocity` token below drives Note On velocity.
  value: string
  delayMs: number // 0..10000
  transitionMs: number // 0..10000
  modulation: Modulation
  // Optional second-stage modulator. When enabled, Mod 2 evaluates
  // every tick (same code path as Mod 1) and its bipolar output is
  // applied to Mod 1's Rate / Depth / context-aware Shape param per
  // the targeting fields on the Mod 2 Modulation itself. Mod 1's
  // stored Modulation is NEVER mutated — the engine builds a fresh
  // "effective Mod 1" each tick. Optional + back-compat: cells with
  // no modulation2 behave exactly as before.
  modulation2?: Modulation
  sequencer: SequencerParams
  // If true, each numeric output (post-modulation) is clamped to [0, 1].
  // Applies to each token when `value` contains space-separated values.
  scaleToUnit: boolean
  // OSC emission toggle. When false the engine skips the OSC send for
  // this cell entirely (MIDI keeps firing if its own enable is on).
  // Default true via migration so legacy sessions keep their OSC.
  // The Inspector renders a checkbox at the head of the Destination
  // section; unticking it visually collapses Destination + OSC
  // Address sub-sections too.
  oscEnabled?: boolean
  // If true, the MIDI emit path scales the cell's final 0..1 output
  // up to 0..127. Independent of `scaleToUnit` (which only affects
  // OSC). Lets the user send raw OSC values while still getting a
  // proper 0..127 MIDI range, or use both together so a scaleToUnit-
  // normalised colour byte maps cleanly to MIDI.
  midiScale?: boolean
  // If true, every per-arg numeric output is rounded to integer AFTER
  // Scale 0.0–1.0 but BEFORE MIDI Scale. Lets the user force integer
  // OSC values regardless of the argSpec.type — useful for receivers
  // that expect ints in slots the compositor would otherwise drive as
  // floats (Spastic LFO + scaleToUnit, etc.). Per-cell toggle; applied
  // to each arg independently.
  intScale?: boolean
  // Timing section enable. When false (default), the cell's
  // `delayMs` + `transitionMs` are bypassed at trigger (treated as 0)
  // and the Inspector's Timing section renders collapsed. When true
  // the values apply as before. The UI shows a checkbox on the
  // Timing section header that flips this flag.
  timingEnabled?: boolean
  // MIDI binding that triggers/stops just this clip (one per cell).
  midiTrigger?: MidiBinding
  // Optional MIDI output destination — fires in PARALLEL with the
  // OSC send (or alone if the OSC fields are empty). Inherits from
  // the track's `midiOut` defaults at cell creation; per-cell
  // overrides are stored here.
  midiOut?: MidiOut
  // Note-mode velocity (0..127). Only meaningful when
  // `midiOut.kind === 'note'`; rendered as a second pinnable slot
  // beneath the Value field in the Inspector. Stored as a raw
  // string so it round-trips through the same parser as `value`
  // and can be modulated / sequenced just like a regular numeric
  // arg. The pin flags live in `velocityPersistent`.
  velocity?: string
  // Pin for the velocity slot. Mirrors the per-arg pin array on
  // multi-arg Parameters but lives on the cell so the velocity
  // pin is per-clip rather than per-parameter.
  velocityPersistent?: boolean
  // Humanization for the Note-On velocity, 0..100 (percent of full
  // range jitter). 0 = velocity emitted verbatim from cell.velocity.
  // 100 = velocity randomized in [0, 127] regardless of the user's
  // value. A typical "musical" setting is 5..15%.
  //
  // Math (in engine.ts::emitMidiForCell): if humanize > 0, the
  // engine adds `(rand() - 0.5) * humanize * 1.27` to the parsed
  // velocity, then clamps to [0, 127]. So at 10% humanize, each
  // Note On's velocity drifts up to ±6.35 from the user's value —
  // enough to keep a synth from sounding mechanical, not enough
  // to lose the user's intended dynamic.
  velocityHumanize?: number
  // Pin for the value slot when in MIDI Note mode — lets the
  // user freeze the note number while sequencer/modulator drives
  // velocity (or vice versa via `velocityPersistent`).
  notePersistent?: boolean
  // ── Per-arg pin/freeze, CELL-level ────────────────────────────
  // Mirrors `Track.persistentSlots` / `Track.persistentValues` but
  // PER CLIP, so the user can pin specific arg positions on a
  // single scene without affecting other scenes on the same track.
  // When `persistentSlots[i] === true`, the engine emits
  // `persistentValues[i]` for that slot regardless of modulators
  // / sequencer / scene triggers. When `persistentSlots[i] === false`,
  // the cell explicitly UN-PINS that slot even if the track-level
  // pin is on. When the cell entry is `undefined`, the track-level
  // pin (if any) applies as the default.
  //
  // Capture writes these on every captured cell so a saved Scene
  // reproduces its frozen state verbatim — that's what "Scenes are
  // presets" means in practice.
  persistentSlots?: (boolean | undefined)[]
  persistentValues?: string[]
  // ── Per-arg post-modulation Scaling ───────────────────────────
  // When `scalingEnabled` is true, every editable arg position is
  // CLAMPED to `[scalingMin[i], scalingMax[i]]` AFTER modulators /
  // sequencer compute the live value but BEFORE `scaleToUnit` and
  // `midiScale`. Lets the user tame extreme values from a Random
  // / Chaos / Generative source — "give me numbers between 0.2 and
  // 0.8 even if the LFO swings to 0..1". Per-cell, per-arg; pinned
  // slots bypass the clamp (a pin is an explicit override and the
  // user's pinned value should fire verbatim).
  //
  // Arrays index parallel to argSpec / cell.value tokens. Missing
  // entries (or `undefined`) on a slot mean "no clamp on this
  // slot" — useful when the user wants to tame only some args
  // of a multi-arg bundle.
  scalingEnabled?: boolean
  scalingMin?: number[]
  scalingMax?: number[]
  // Per-slot routing matrix — gates which arg slots the Modulator
  // and Sequencer are allowed to drive. Each boolean array indexes
  // parallel to argSpec / cell.value tokens. `true` (default) =
  // routed (modulator / sequencer affects this slot). `false` =
  // skipped (slot emits its `cell.value` seed instead of the
  // modulated / step value). When BOTH directions are unrouted on a
  // slot, the slot is effectively frozen at its seed (similar to
  // Pin, but using cell.value as the source).
  //
  // Engine precedence on a slot:
  //   argSpec.fixed                  > everything else
  //   cell.persistentSlots[i] (Pin)  > everything else (after fixed)
  //   routing.{mod,seq}[i] === false → strip the corresponding
  //                                     contribution from `out`
  //   otherwise                       → modulator + sequencer as usual
  //
  // Both fields optional + missing entries default to true so legacy
  // sessions (no `routing` field, or shorter arrays than argSpec)
  // behave identically to before this feature shipped.
  routing?: {
    modulator?: boolean[]
    // Per-slot Modulation 2 gate. Default true (= Modulation 2 affects
    // Modulation 1 for this slot, current behaviour). When false, the
    // slot bypasses Modulation 2's effect on the per-slot modulator
    // output — the slot reads from the ORIGINAL Modulation 1 params
    // (Rate is shared globally and can't be "unmodulated" per-slot
    // because the engine keeps a single phase; Depth and Shape do
    // revert). Lets multi-arg cells route Modulation 2 to specific
    // slots only.
    modulation2?: boolean[]
    // Per-slot Modulation 2 → Sequencer gate. Default true. When false,
    // the slot's sequencer params (bpm, per-mode shape key, genAmount)
    // are not modulated by Mod 2 — the cell still uses the sequencer's
    // un-modulated values for that slot. Mirrors `modulation2` but
    // governs the Stage-2 → Sequencer routing instead of the Mod 1
    // routing. Lets a multi-arg bundle have, say, slot 0 = full
    // Mod 2 → Seq wildness while slot 1 stays metronomic.
    modulation2Seq?: boolean[]
    // Per-slot Modulation 2 → VALUE direct gate.
    //
    // ⚠️ INVERTED DEFAULT — READ THIS BEFORE TOUCHING ⚠️
    // Unlike EVERY other routing array in this struct (where a
    // missing entry / missing array means `true` = routed), this one
    // defaults FALSE: a missing array or missing entry means
    // UNROUTED. Only an explicit `modulation2Direct[i] === true`
    // routes Mod 2's signal directly into slot i's value. Rationale:
    // the feature shipped after v0.5.14, and the owner wants (a) the
    // new "M2" matrix column all-unchecked on fresh + legacy cells,
    // and (b) free backward compat — old sessions must load with
    // zero behaviour change without any migration. Engine + UI must
    // both check `=== true`, never `!== false`.
    //
    // When true, Mod 2's bipolar output modulates the slot's value
    // directly (same pipeline stage as Mod 1's contribution), scaled
    // by `modulation2.valueAmount` and combined with the Mod 1-
    // modulated value per `modulation2.valueMath`. The per-slot
    // `delays` / `variations` below apply to this contribution
    // exactly as they do to the Mod 1 / Sequencer ones. May be
    // ticked TOGETHER with `modulation2[i]` (M2>1) — no mutual
    // exclusion — which stacks Mod 2's influence on that slot.
    modulation2Direct?: boolean[]
    sequencer?: boolean[]
    // Per-slot Delay (ms) — gates the modulator + sequencer
    // contribution for this slot until `delay` ms have elapsed
    // since the cell's trigger. Lets multi-arg cells stagger their
    // modulation onset (e.g. slot 0 starts immediately, slot 1
    // joins at +100ms, slot 2 at +200ms — a wave across the
    // bundle). Default 0 = no delay (legacy behavior).
    delays?: number[]
    // Per-slot Variation (0-100%) — random multiplier on the
    // modulator contribution, sampled ONCE at trigger time so each
    // slot's modulation feels "similar but a bit different" across
    // a multi-arg cell. 0 = all slots identical (legacy). 100 =
    // each slot's modulator amplitude ranges over [0, 2× the
    // computed value]. Stable for the lifetime of the trigger.
    variations?: number[]
  }
  // Where in the value pipeline the scaling clamp runs:
  //   'post' (default) → AFTER modulators + sequencer, BEFORE Scale
  //                       0.0–1.0 and MIDI Scale. Tames extreme
  //                       outputs from generative sources.
  //   'pre'            → BEFORE modulators + sequencer pick up the
  //                       seed value. The whole downstream chain
  //                       then operates within the clamped band.
  // Optional + 'post' is the legacy behavior so older sessions still
  // behave identically.
  scalingMode?: 'pre' | 'post'
  // ── Pitch snap — quantise to a musical scale ──────────────────
  // When `pitchSnap.enabled` is true, the cell's modulated /
  // sequenced output (after Scaling + scaleToUnit) is mapped into
  // the MIDI note window defined by `cell.midiOut.noteMin/noteMax`,
  // snapped to the NEAREST in-scale semitone for the chosen
  // (`scale`, `root`) combo, then written BACK into the unified
  // `finalVal` slot — so OSC + MIDI both emit the same scale-
  // locked event. OSC sees the snapped value re-normalised to the
  // window so downstream consumers (Pure Data / Max / a custom
  // hardware controller in [0..1]) get a quantised stepped output.
  // MIDI Note emits the snapped MIDI note number directly.
  //
  // `slotIdx` picks which arg slot gets snapped (default 0). The
  // other slots in a multi-arg bundle pass through unchanged so
  // pitch can be quantised while velocity / duration / etc stay
  // continuous.
  //
  // Requires `cell.scaleToUnit` OR `cell.midiScale` to be on (the
  // engine needs a [0..1]-domain value to do the note-window
  // mapping). Inspector hides the section otherwise.
  pitchSnap?: {
    enabled: boolean
    root: number   // 0..11, 0 = C
    scale: ScaleId
    slotIdx?: number // default 0
  }
}

// Musical scale identifier. The intervals live in `SCALE_INTERVALS`
// (semitone offsets from the root, 0 included). Adding a new scale
// is one line in the const map + one entry here.
export type ScaleId =
  // Diatonic modes
  | 'major' | 'dorian' | 'phrygian' | 'lydian' | 'mixolydian'
  | 'minor' | 'locrian'
  // Minor variants
  | 'harmonicMinor' | 'melodicMinor'
  // Pentatonic / blues
  | 'pentatonicMajor' | 'pentatonicMinor' | 'bluesMinor' | 'bluesMajor'
  // Symmetric
  | 'chromatic' | 'wholeTone' | 'diminished'
  // Chord tones
  | 'majorTriad' | 'minorTriad' | 'dominant7' | 'major7' | 'minor7'
  // World / exotic
  | 'hirajoshi' | 'insen' | 'hungarianMinor' | 'phrygianDominant'
  | 'doubleHarmonic'

// Semitone intervals from root, ascending and inclusive of 0.
// Engine reduces a candidate note's `(note - root) mod 12` to test
// scale membership; the `snapToScale` helper picks the nearest
// in-scale semitone (in either direction) when the candidate
// isn't a member. Lookup is O(1) for membership thanks to the
// fixed 12-bit mask cached per scale at module load time.
export const SCALE_INTERVALS: Record<ScaleId, number[]> = {
  // Diatonic modes
  major:           [0, 2, 4, 5, 7, 9, 11],
  dorian:          [0, 2, 3, 5, 7, 9, 10],
  phrygian:        [0, 1, 3, 5, 7, 8, 10],
  lydian:          [0, 2, 4, 6, 7, 9, 11],
  mixolydian:      [0, 2, 4, 5, 7, 9, 10],
  minor:           [0, 2, 3, 5, 7, 8, 10],
  locrian:         [0, 1, 3, 5, 6, 8, 10],
  // Minor variants
  harmonicMinor:   [0, 2, 3, 5, 7, 8, 11],
  melodicMinor:    [0, 2, 3, 5, 7, 9, 11],
  // Pentatonic / blues
  pentatonicMajor: [0, 2, 4, 7, 9],
  pentatonicMinor: [0, 3, 5, 7, 10],
  bluesMinor:      [0, 3, 5, 6, 7, 10],
  bluesMajor:      [0, 2, 3, 4, 7, 9],
  // Symmetric
  chromatic:       [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
  wholeTone:       [0, 2, 4, 6, 8, 10],
  diminished:      [0, 2, 3, 5, 6, 8, 9, 11],
  // Chord tones
  majorTriad:      [0, 4, 7],
  minorTriad:      [0, 3, 7],
  dominant7:       [0, 4, 7, 10],
  major7:          [0, 4, 7, 11],
  minor7:          [0, 3, 7, 10],
  // World / exotic
  hirajoshi:       [0, 2, 3, 7, 8],
  insen:           [0, 1, 5, 7, 10],
  hungarianMinor:  [0, 2, 3, 6, 7, 8, 11],
  phrygianDominant:[0, 1, 4, 5, 7, 8, 10],
  doubleHarmonic:  [0, 1, 4, 5, 7, 8, 11]
}

/**
 * Human-readable label for a ScaleId — used in the Inspector
 * dropdown. Kept here (not in the renderer) so the same labels
 * round-trip into engine logs / debug prints if needed.
 */
export const SCALE_LABELS: Record<ScaleId, string> = {
  major: 'Major (Ionian)',
  dorian: 'Dorian',
  phrygian: 'Phrygian',
  lydian: 'Lydian',
  mixolydian: 'Mixolydian',
  minor: 'Natural Minor (Aeolian)',
  locrian: 'Locrian',
  harmonicMinor: 'Harmonic Minor',
  melodicMinor: 'Melodic Minor',
  pentatonicMajor: 'Pentatonic Major',
  pentatonicMinor: 'Pentatonic Minor',
  bluesMinor: 'Blues Minor',
  bluesMajor: 'Blues Major',
  chromatic: 'Chromatic (no snap)',
  wholeTone: 'Whole Tone',
  diminished: 'Diminished (W–H)',
  majorTriad: 'Major Triad',
  minorTriad: 'Minor Triad',
  dominant7: 'Dominant 7th',
  major7: 'Major 7th',
  minor7: 'Minor 7th',
  hirajoshi: 'Hirajoshi (Japanese)',
  insen: 'Insen (Japanese)',
  hungarianMinor: 'Hungarian Minor',
  phrygianDominant: 'Phrygian Dominant',
  doubleHarmonic: 'Double Harmonic'
}

/**
 * Scale picker dropdown groups — used by the Inspector to wrap
 * the 26 scales into `<optgroup>` blocks. Keeps the dropdown
 * legible.
 */
export const SCALE_GROUPS: { label: string; scales: ScaleId[] }[] = [
  {
    label: 'Diatonic modes',
    scales: ['major', 'dorian', 'phrygian', 'lydian', 'mixolydian', 'minor', 'locrian']
  },
  {
    label: 'Minor variants',
    scales: ['harmonicMinor', 'melodicMinor']
  },
  {
    label: 'Pentatonic + Blues',
    scales: ['pentatonicMajor', 'pentatonicMinor', 'bluesMinor', 'bluesMajor']
  },
  {
    label: 'Symmetric',
    scales: ['chromatic', 'wholeTone', 'diminished']
  },
  {
    label: 'Chord tones',
    scales: ['majorTriad', 'minorTriad', 'dominant7', 'major7', 'minor7']
  },
  {
    label: 'World / exotic',
    scales: ['hirajoshi', 'insen', 'hungarianMinor', 'phrygianDominant', 'doubleHarmonic']
  }
]

/** Pretty name for a root index 0..11 — used in the Inspector. */
export const ROOT_LABELS = [
  'C', 'C♯/D♭', 'D', 'D♯/E♭', 'E', 'F', 'F♯/G♭', 'G', 'G♯/A♭', 'A', 'A♯/B♭', 'B'
] as const

// MIDI output binding. Sits on Cell.midiOut and on
// InstrumentFunction.midiOut (the per-Parameter default). The cell
// inherits the function's defaults at instantiation; subsequent
// edits go to the cell-level field so changes to the Parameter
// blueprint don't retroactively rewrite live cells (same contract
// as OSC destinations and argSpec).
export interface MidiOut {
  // Toggle. When false the engine skips MIDI emission for this
  // cell — the Inspector still renders the MIDI section so the
  // user can edit defaults while the destination is muted.
  enabled: boolean
  // RtMidi port name as reported by `MidiOutSender.listPorts()`.
  // Empty string = no port selected; sends are skipped.
  portName: string
  // MIDI channel 1..16 (UI-facing; engine subtracts 1 for the wire).
  channel: number
  // Message kind. `cc` emits one Control Change per tick; `note`
  // emits a Note On at every sequencer / modulator clock and a
  // Note Off when the next trigger fires (mono per cell).
  kind: 'cc' | 'note'
  // CC number 0..127 when `kind === 'cc'`. Ignored for `note`.
  cc?: number
  // For `kind === 'note'` only — picks whether the modulated /
  // sequenced output drives the note NUMBER (pitch) or the
  // velocity. `velocity` is the natural fit when the value field
  // holds a fixed pitch (e.g. drum trigger on note 36); `pitch`
  // when the value field holds a melodic line and a separate
  // Velocity slot drives loudness.
  noteMode?: 'velocity' | 'pitch'
  // Note-Off gate length in ms. 0 = "until next trigger" (the
  // engine schedules Note Off on the next Note On / cell stop /
  // scene change). Positive value schedules an explicit Note Off
  // `gateLengthMs` after each Note On.
  gateLengthMs?: number
  // Note range used by the [0..1] → MIDI-note mapping when
  // `midiScale` or `scaleToUnit` is enabled on the cell. Without
  // these, the engine falls back to its historical default of
  // C2..C6 (36..84) so older sessions keep behaving the same. With
  // them set, a generative / modulated value in [0..1] is mapped
  // linearly to [noteMin..noteMax] before the int round + Note On
  // — lets the user pick the octave + width of their melodic
  // window (e.g. 60..72 for one chromatic octave starting at C4,
  // or 36..60 for a two-octave bass spread).
  //
  // Only meaningful when `kind === 'note'`. Inclusive on both ends.
  noteMin?: number
  noteMax?: number
}

/** Range / bound check for MIDI channel — 1..16 inclusive. */
export const MIDI_CHANNEL_MIN = 1
export const MIDI_CHANNEL_MAX = 16

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
  // Snapshot of the source Function/Parameter's argSpec at
  // instantiation time. Drives the cell editor's split-input UI and
  // seeds initial cell values. Tracks are snapshots — Pool edits
  // don't propagate retroactively (drag the entry again to refresh).
  argSpec?: ParamArgSpec[]
  // MIDI output default for this Parameter row. Cells freshly
  // created on this track (via ensureCell or the empty-cell click
  // flow) snapshot this onto `cell.midiOut`. Editing here in the
  // Parameter Inspector is the natural place to wire up a Parameter
  // for MIDI once, before authoring per-scene clips.
  midiOut?: MidiOut
  // OSC emission toggle at the Parameter-row level. When false, the
  // engine skips OSC for EVERY cell on this row (independent of
  // each cell's own `oscEnabled`). Per-cell flag still applies on
  // top: cell off + track on → cell muted; track off → all cells
  // muted. Default true via migration.
  oscEnabled?: boolean
  // Disable flag — when explicitly false, the engine skips this
  // track on any trigger path (cell or scene). Sidebar row renders
  // greyed out. Undefined / true means enabled (default). Used by
  // the Instrument-row Inspector's "enable/disable each Parameter"
  // toggles. On a Template (header) row, disabling cascades to its
  // Parameter children visually but each child still has its own
  // independent flag.
  enabled?: boolean
  // Per-arg-position persistence flags. Same length / order as
  // argSpec when present. When persistentSlots[i] is true, the
  // engine emits persistentValues[i] for that slot regardless of
  // scene triggers, modulators, or sequencer steps. Lets the
  // performer "pin" a few knobs while letting the rest morph.
  persistentSlots?: boolean[]
  // Captured pinned values, parallel to persistentSlots. Stored as
  // raw token strings so they round-trip cleanly through the
  // existing value parser (autoDetectOscArg). Captured at pin time
  // from the focused scene's cell.value[i]; cleared when unpinned.
  persistentValues?: string[]
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
  // Multi-arg bundle spec — when present, every clip on a row
  // instantiated from this Function expects exactly `argSpec.length`
  // OSC args in this order. The cell editor renders one labeled
  // input per non-fixed entry; entries with `fixed` are invisibly
  // prepended on send (useful for protocol header pairs like the
  // Octocosme Pure Data patch's `[sender] [timestamp]` prefix that
  // its `list split 2` discards).
  argSpec?: ParamArgSpec[]
  // Default MIDI output binding for cells instantiated from this
  // Parameter. Cells snapshot this at creation time; per-cell
  // overrides go on `Cell.midiOut`. When undefined, cells render
  // a blank MIDI section the user can fill in by hand.
  midiOut?: MidiOut
}

// Per-arg spec for a multi-arg OSC bundle. Drives the UI's split
// data-entry strip + initial value seeding.
export interface ParamArgSpec {
  // Display label shown above the input (or used as a tooltip on
  // fixed args). Free text, e.g. "HAUTEUR1".
  name: string
  // Type drives the input widget choice (number / bool / text) and
  // the value-token formatting at send time.
  type: 'float' | 'int' | 'bool' | 'string'
  // When set, this arg is invisibly prepended to every clip's value
  // string and never shown as an editable input. Used for protocol
  // prefixes the receiver discards (see Octocosme `list split 2`).
  fixed?: number | string | boolean
  // For editable numeric args.
  min?: number
  max?: number
  // Initial value used to seed a freshly-created cell. If omitted,
  // falls back to 0 / "" depending on `type`.
  init?: number | string | boolean
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
  // True for the auto-created backing template behind an "Add Instrument"
  // sidebar row that hasn't been Saved-as-Template yet. The Pool drawer
  // hides drafts; they exist only to give the live Instrument row a
  // place to store function specs. "Save as Template" flips this to
  // undefined and the user can give the entry a name.
  draft?: boolean
  // Hardware Mode — lets a physical OSC controller (recognised via
  // the Network discovery tab) override this Instrument's parameter
  // values while a scene is playing. Implements soft-takeover (catch
  // mode): the hardware control has to reach the currently-emitted
  // value before its movement starts contributing. Movement detection
  // filters out devices that stream constant values when idle (so
  // dataFLOU only listens when the user is actually moving a knob).
  hardwareMode?: HardwareModeConfig
  // Input Conditioning (v0.6) — ordered smoothing/filter chain applied
  // to this Instrument's incoming Hardware-Mode stream before catch
  // logic + State Triggers. See InputConditionerConfig.
  inputConditioner?: InputConditionerConfig
  // State Triggers (v0.6) — "Wekinator-lite" pose/state detectors on
  // the incoming Hardware-Mode stream firing MIDI + scene actions.
  stateTriggers?: StateTrigger[]
}

// Per-Instrument Hardware Mode configuration. When enabled, dataFLOU
// listens for OSC from `deviceIp:devicePort` (one of the senders in
// the Network discovery list) and uses incoming values to override
// the scene's per-arg-slot output for this Instrument's Parameters.
//
// Override pipeline (engine.ts, per-slot loop):
//   1. Movement detection — value must have changed by `movementThreshold`
//      within `movementWindowMs` to be considered "moving."
//   2. Catch mode — until the hardware value matches the
//      currently-emitted scene value within `catchTolerance`, the
//      hardware is ignored. Once caught, hardware wins.
//   3. Mode lifecycle:
//        - 'reset' (default): scene-change clears caught state. User
//          must re-catch the new scene's value to take over again.
//        - 'persist': scene-change keeps caught state. If the user
//          is mid-knob-turn when a new scene fires, hardware
//          continues to dominate the parameter.
//   4. Per-arg locking: by default the hardware controls all arg
//      slots of every Parameter under this Instrument. The `args`
//      map narrows control to specific slot indices per Parameter,
//      so e.g. only arg[2] of /B/strips/pots is HW-controlled while
//      the scene drives args 0-1 and 3..N.
export interface HardwareModeConfig {
  enabled: boolean
  // Device discovered via the Pool's Network tab. Persisted with the
  // session so the binding survives reload. Empty string = not yet
  // bound (the UI shows "(pick a device)" until the user selects).
  deviceIp: string
  devicePort: number
  // (v0.5.12) How strict the source-match is for inbound packets.
  //   'ipPort' (default) — packet must match BOTH deviceIp AND
  //       devicePort. Correct when the controller binds a fixed
  //       source port (OCTOCOSME Teensy uses udp.begin(8888) which
  //       fixes its source port).
  //   'ipOnly' — packet matches when source IP matches, regardless
  //       of source port. Use when the controller sends from an
  //       ephemeral source port (most software OSC senders: Lemur,
  //       TouchOSC, ad-hoc Max/PD patches, scripts). Without this
  //       option the engine.isHardwareModeSource() check would
  //       silently miss every packet because rinfo.port keeps
  //       changing per packet — visible in the HwModeSuppressPanel
  //       as ⚠ PORT MISMATCH.
  deviceMatch?: 'ipPort' | 'ipOnly'
  // (v0.5.12, DEPRECATED in v0.5.12.1) Boolean toggle that maps to
  // `forwardMode: 'always'` when true. Kept for back-compat: when
  // forwardMode is undefined AND alwaysForward is true, the engine
  // treats it as forwardMode === 'always'. New sessions should set
  // forwardMode directly; the UI clears alwaysForward whenever the
  // user picks any forwardMode option.
  alwaysForward?: boolean
  // (v0.5.12.1) Forward-path suppression policy. Three modes:
  //   'suppress' (default) — never forward HW-Moded packets to
  //       downstream consumers (v0.5.11 behaviour). The engine's
  //       catch-mode emission via cells is the SINGLE source of
  //       truth per parameter. Clean single emission, no flicker.
  //       Trade-off: the controller is invisible at downstream
  //       consumers (PD, Max) whenever no scene is playing — the
  //       cell-emit path has nothing to do without an active scene.
  //   'always' — never suppress. Raw controller bytes always pass
  //       through. Engine STILL consumes packets via
  //       handleHardwareInput so catch-mode works during playback,
  //       but downstream also receives the raw bytes. Trade-off:
  //       during scene playback, downstream sees both the raw
  //       forward AND the engine's caught value (dual emission;
  //       visible as flicker on consumers that don't tolerate
  //       duplicate OSC).
  //   'whenIdle' — forward only when engine.activeSceneId === null
  //       (no scene currently playing). Best of both worlds for
  //       OCTOCOSME-shape live workflows: clean single emission
  //       DURING scene playback, controller-reaches-downstream
  //       BETWEEN scenes (rehearsal, soundcheck, idle moments).
  //       The engine consults its own activeSceneId at
  //       isHardwareModeSource() call time, so the suppression
  //       state flips automatically on scene start/stop without
  //       any UI action from the user.
  forwardMode?: 'suppress' | 'always' | 'whenIdle'
  // 'reset' (default) re-arms catch on every scene change; 'persist'
  // keeps the caught state across scene transitions so a knob-turn
  // mid-show keeps overriding the new scene's value until released.
  mode: 'reset' | 'persist'
  // Takeover behaviour for FLOAT slots.
  //   'catch' (default, or absent for back-compat) — soft-takeover: a
  //       controller value only assumes control of a parameter once it
  //       approaches the scene's current value within catchTolerance.
  //       Prevents audible/visible jumps when grabbing a knob whose
  //       physical position differs from the scene value.
  //   'jump' — instant takeover: any controller VALUE CHANGE takes over
  //       immediately, with no tolerance/approach required (exactly how
  //       discrete int/bool slots already behave). catchTolerance is
  //       irrelevant in this mode.
  // Discrete (int/bool) slots are always instant regardless of this
  // setting — there is no smooth handoff to protect.
  takeover?: 'catch' | 'jump'
  // Catch tolerance — fraction of the param's full range. 0.02 = 2%.
  // Unused when takeover === 'jump'.
  catchTolerance: number
  // Movement detection — value must change by ≥ movementThreshold
  // within `movementWindowMs` to be treated as "user is moving the
  // control." Filters out devices that stream a static value 200+ Hz
  // (the original OCTOCOSME firmware, for example).
  movementThreshold: number
  movementWindowMs: number
  // Per-parameter arg-slot lock map. Key: InstrumentFunction.id.
  // Value: array of arg slot indices the HW controls. Missing key OR
  // empty array = HW controls ALL slots. Use this to surgically
  // limit which slots of a multi-arg bundle the hardware can drive.
  args?: Record<string, number[]>
  // (v0.6) Per-parameter input→output scaling. Key:
  // InstrumentFunction.id. Maps the device's native value range onto
  // the parameter's output range BEFORE the catch-tolerance
  // comparison and override storage — so a controller sending
  // 0..360° can catch (and drive) a parameter whose scene values
  // live in 0..1. Applied AFTER Input Conditioning. Inversion is
  // supported by swapping out bounds (e.g. out 1..0); the result is
  // always clamped to the out range. Movement Δ detection stays in
  // DEVICE units (it runs per-address before per-parameter resolution).
  scaling?: Record<string, HardwareScaleConfig>
  // Which Track instances this HW Mode applies to. Empty / undefined
  // = applies to EVERY Track instantiated from this template (every
  // copy in the grid). Listing specific track ids narrows the scope
  // to those instances only. Lets the user have two copies of the
  // same Instrument template, one HW-driven and one scene-driven.
  appliesToTrackIds?: string[]
}

// (v0.6) One Parameter's hardware-input scaling. `in` bounds describe
// what the DEVICE sends (after Input Conditioning); `out` bounds are
// the range the parameter's scene values live in. Linear map + clamp:
//   out = outMin + (v − inMin) / (inMax − inMin) · (outMax − outMin)
// Swapped out bounds invert the response. Degenerate in-range
// (inMax ≈ inMin) outputs outMin.
export interface HardwareScaleConfig {
  enabled: boolean
  inMin: number
  inMax: number
  outMin: number
  outMax: number
}

// ── Input Conditioning (v0.6) ────────────────────────────────────────
// A PiPo-style ordered chain of stream-processing stages applied to
// incoming OSC values from this Instrument's Hardware-Mode device,
// BEFORE movement detection / catch logic / overrides / State
// Triggers. Each stage is a small named unit with 1-2 knobs
// (Plaquette-style); the chain runs top-to-bottom per arg slot.
//
// Applied at the top of engine.handleHardwareInput(), so everything
// downstream (catch gates, red cell display, MIDI emission, State
// Trigger matching) sees the conditioned stream.

export type InputStageType =
  | 'oneEuro'    // adaptive low-pass (Casiez 1€): smooth when slow, fast when fast
  | 'smooth'     // one-pole EMA with half-life (same math as the Slew modulator)
  | 'median'     // windowed median — spike / outlier killer
  | 'slewLimit'  // hard max rate clamp in units/sec (bounds worst-case jumps)
  | 'deadband'   // ignore changes smaller than epsilon (kills idle chatter)
  | 'autoRange'  // adaptive min/max tracker, outputs 0..1 (MinMaxScaler-style)

export interface InputStage {
  id: string
  type: InputStageType
  enabled: boolean
  // (v0.6) OSC-address scope. undefined / '' = apply to EVERY address
  // the instrument's HW device sends (the original behaviour). A
  // specific address (e.g. "/mpu/euler/roll", matching a Parameter's
  // resolved OSC address) = only that address's slots pass through
  // this stage. Lets one instrument smooth some inputs and not others,
  // and lets the Parameter inspector reflect exactly which stages
  // touch a given Parameter.
  address?: string
  // oneEuro — minCutoffHz: baseline smoothing at rest (lower = smoother,
  // more lag on slow moves; typical 1.0). beta: speed coefficient (higher
  // = less lag on fast moves; typical 0.005-0.1). Tuning recipe: set
  // beta 0, lower minCutoff until rest jitter is gone; then raise beta
  // until fast-move lag is acceptable.
  minCutoffHz?: number
  beta?: number
  // smooth — exponential half-life in ms. y += (x - y) · (1 - 2^(-dt/HL))
  halfLifeMs?: number
  // median — window length (odd, 3/5/7). Longer = stronger spike
  // rejection, more latency (window/2 samples).
  window?: number
  // slewLimit — max change per second, in the value's own units.
  maxPerSec?: number
  // deadband — minimum |delta| from the last OUTPUT value before the
  // output moves. In the value's own units.
  epsilon?: number
  // autoRange — how fast the tracked min/max CONTRACT toward the
  // recent signal, as a half-life in ms. Expansion is instantaneous
  // (a new peak immediately widens the range); contraction forgets
  // old extremes so a sensor that once spiked doesn't stay squashed
  // forever. 0 = never contract (pure running min/max).
  contractHalfLifeMs?: number
}

export interface InputConditionerConfig {
  enabled: boolean
  // Ordered chain — runs top to bottom. Empty = pass-through.
  stages: InputStage[]
  // Per-arg-slot opt-out: slot indices listed here bypass the whole
  // chain (e.g. keep a button/int slot raw while smoothing the floats).
  slotBypass?: number[]
}

// ── State Triggers (v0.6) ────────────────────────────────────────────
// "Wekinator-lite": named states of the Hardware-Mode device's incoming
// OSC values. When the live (conditioned) input matches a state's
// detector, the state ENTERS and fires its actions; when it stops
// matching (with hysteresis + dwell debouncing) it EXITS. Detectors
// come in two flavors:
//   'rules'   — explicit per-address/slot conditions, AND-combined.
//               Deterministic + debuggable.
//   'learned' — captured by demonstration: hold the pose, hit Record,
//               the engine stores centroid + per-dim variance over the
//               recorded snapshots. At runtime a variance-weighted
//               normalized distance yields a 0..1 match score; entering
//               = score >= threshold. Nearest-centroid classification's
//               practical little sibling (k-NN à la Wekinator, distilled).

export type StateTriggerMode =
  | 'enterExit'  // note-on / CC-A at enter, note-off / CC-B at exit (default)
  | 'oneShot'    // fire once at enter, re-arm after exit
  | 'continuous' // stream the live match score as a CC (0..127), change-gated

export type StateRuleOp = 'eq' | 'range' | 'gt' | 'lt'

export interface StateRule {
  // OSC address as seen from the device (matches Track.defaultOscAddress
  // resolution, e.g. "/mpu/euler/roll").
  address: string
  // Arg slot index within that address's bundle. 0 for single-value.
  slot: number
  op: StateRuleOp
  // eq: value == a (within tol). range: a <= value <= b. gt: value > a.
  // lt: value < a.
  a: number
  b?: number
  // Absolute tolerance for 'eq' (defaults handled engine-side).
  tol?: number
}

export interface LearnedState {
  // Dimensions in centroid/variance order. Captured at Record time from
  // every address+slot the device emitted during the window.
  dims: { address: string; slot: number }[]
  centroid: number[]
  // Per-dim variance from the recording (floored engine-side so a
  // perfectly-still dim doesn't produce a divide-by-zero razor edge).
  variance: number[]
  // Match threshold 0..1 — live score >= threshold = state entered.
  threshold: number
}

export interface StateMidiAction {
  enabled: boolean
  portName: string
  channel: number
  kind: 'note' | 'cc'
  // kind 'note': note number + velocity; enter = noteOn, exit = noteOff.
  note?: number
  velocity?: number
  // kind 'cc': cc number; enter sends ccEnterValue, exit sends
  // ccExitValue. In 'continuous' mode the live match score streams to
  // this CC instead (0..127) and enter/exit values are ignored.
  cc?: number
  ccEnterValue?: number
  ccExitValue?: number
}

export interface StateTrigger {
  id: string
  name: string
  enabled: boolean
  detector: 'rules' | 'learned'
  mode: StateTriggerMode
  // Exit hysteresis as a fraction of the enter condition (0..0.5):
  // rules exit when any rule misses by more than hysteresis × its span;
  // learned exits when score < threshold × (1 - hysteresis). Prevents
  // boundary chatter.
  hysteresisPct: number
  // The state must match continuously for this long before entering.
  dwellMs: number
  rules: StateRule[]
  learned?: LearnedState
  actions: {
    midi?: StateMidiAction
    // Fire a dataFLOU scene at enter (the IMU literally plays the
    // compositor). Exit does not stop the scene — scenes have their own
    // lifecycle; this is a trigger, not a gate.
    triggerSceneId?: string
  }
}

// Standalone Parameter template — a single-Function blueprint that lives
// directly in the Pool, separate from the Instrument Templates. Useful
// for catch-all building blocks ("RGB light", "Knob", "Motor speed")
// that the user wants to drag straight onto the Edit-view sidebar as an
// orphan Function row without first wrapping them in an Instrument.
//
// Shape mirrors InstrumentFunction (same paramType / nature / streamMode
// vocabulary) plus a few presentation hints — `color` for the row stripe
// in the Edit sidebar after instantiation, and `builtin` so the shipped
// blueprints render read-only in the inspector. Unlike InstrumentFunction,
// `oscPath` here is a default (the user can override at instantiation
// time), and `destIp` / `destPort` give the parameter its own destination
// when there's no parent Template to inherit from.
export interface ParameterTemplate {
  id: string
  name: string                  // e.g. "RGB Light", "Knob", "Motor"
  description?: string
  color: string                 // hex; used for the orphan row's tint
  oscPath: string               // default OSC path when instantiated
  destIp: string
  destPort: number
  paramType: FunctionParamType
  nature: FunctionParamNature
  streamMode: FunctionStreamMode
  min?: number
  max?: number
  init?: number
  unit?: string
  smoothMs?: number
  notes?: string
  builtin?: boolean
  // See InstrumentFunction.argSpec — same semantics applied to a
  // standalone Parameter blueprint. Drag-drop instantiation
  // snapshots this onto the resulting Track.
  argSpec?: ParamArgSpec[]
  // Default MIDI output binding — copied to cells created from this
  // blueprint at instantiation, same contract as on
  // InstrumentFunction. Builtin MIDI blueprints (CC, Note, Drum Pad,
  // etc.) set this so the user only needs to pick the port to wire
  // up actual hardware.
  midiOut?: MidiOut
}

export interface Pool {
  templates: InstrumentTemplate[]
  // Standalone single-parameter blueprints. Sourced from the builtin
  // library + user-authored entries. Persisted with the session for
  // self-containment.
  parameters: ParameterTemplate[]
}

// ─────────────────────────────────────────────────────────────────────
// Saved Scene library — persistent across sessions.
//
// Lives in `<userData>/scene-library.json` on disk, not inside the
// session file, so the user can drag a saved Scene from the Pool
// into ANY open session. The payload is self-contained: it embeds
// the Instrument Templates + Track definitions + Cells needed to
// reconstruct the scene cold.
//
// When the user drops a saved Scene onto the grid:
//   1. For each `templates[]` entry not already in the target
//      session's Pool (by id), copy it in.
//   2. For each `tracks[]` entry, instantiate a fresh sidebar row
//      linked to the corresponding Pool template/function. The
//      mapping `oldTrackId → newTrackId` is kept in scope so the
//      cell map can be rewritten.
//   3. Create a new Scene in `session.scenes` whose cells reference
//      the freshly-created tracks with the embedded Cell values.
//
// Captured via the Capture popup in the Pool drawer — see
// `src/renderer/src/components/CapturePopup.tsx`.
// ─────────────────────────────────────────────────────────────────────
export interface SavedScene {
  // Stable id across all sessions. Generated at save time and used
  // as the React key / drag payload.
  id: string
  // User-facing name + optional notes.
  name: string
  description?: string
  // Hex colour for the Pool row stripe + the resulting scene's
  // colour swatch when instantiated.
  color: string
  // When this entry was written. Used by the Pool list to sort
  // most-recent-first.
  createdAt: number
  // Free-form tag for "kind of thing this came from" — purely
  // informational, lets the Pool show a small badge.
  origin?: 'manual' | 'capture-osc' | 'capture-midi' | 'duplicate'
  // ── Embedded payload ─────────────────────────────────────────
  // The Pool templates this scene references. Copied to the
  // target session's Pool on instantiation if missing.
  templates: InstrumentTemplate[]
  // The sidebar tracks the scene's cells live on. Each carries
  // its sourceTemplateId/sourceFunctionId so the loader can match
  // it against the templates above.
  tracks: Track[]
  // Per-trackId cell snapshot. Same shape as `Scene.cells`.
  cells: Record<string, Cell>
  // The scene's own properties — name, color, notes, duration,
  // nextMode, multiplicator, morphInMs. Stored separately from
  // the Pool entry's `name`/`color` so the user can rename the
  // saved entry without affecting how the instantiated scene
  // looks.
  sceneMeta: {
    name: string
    color: string
    notes?: string
    durationSec: number
    nextMode: NextMode
    multiplicator: number
    morphInMs?: number
  }
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
  // Generative selection weight (v0.5.10). Used ONLY when the session's
  // generative mode is on -- otherwise inert. Range SCENE_WEIGHT_MIN..
  // SCENE_WEIGHT_MAX, default SCENE_WEIGHT_DEFAULT. A scene with
  // weight 10 is 10x more likely to be picked than a scene with
  // weight 1 (modified by Affinity bias + repetition penalty). The
  // "Random Weights" button in the Generative popover rolls fresh
  // weights into every scene at once.
  weight?: number
  // Sparse: key is trackId. Missing = empty cell.
  cells: Record<string, Cell>
  // MIDI binding for triggering the whole scene.
  midiTrigger?: MidiBinding
  // MIDI bindings for the per-Instrument group-trigger button shown
  // at each Template-row × Scene-column intersection. Key is the
  // Template (Instrument header) track id. Optional / sparse — the
  // engine only reacts to a binding when one is present.
  instrumentTriggers?: Record<string, MidiBinding>
  // ID of the Pool SavedScene this live scene is linked to. Set in
  // two cases:
  //   - User clicked "Save Scene to Pool" — link points at the new
  //     library entry. Later changes to color / name / notes on the
  //     live scene mirror back to that entry.
  //   - User dragged a SavedScene from the Pool onto the grid —
  //     link points at the SavedScene the instance came from.
  // Bidirectional sync: updateScene mirrors to the SavedScene;
  // updateSavedScene mirrors back to the live scene if linked.
  // Optional / sparse — most scenes don't link.
  linkedSavedSceneId?: string
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

// ---- Generative Scene Sequencer (v0.5.10) ------------------------------
// A session-level "shuffle button" for the scene timeline. When
// `enabled === true`, the engine's auto-advance path bypasses each
// scene's authored `nextMode` and instead picks a random next scene
// from an eligible pool, with the picker shaped by Affinity, Weights,
// and a few constraints. Manual triggers (Cue/GO, scene clicks, MIDI
// scene triggers, keyboard 1-0 + Space) still use the scene's own
// duration + nextMode -- only natural advances are diverted, so the
// user can preempt the generative flow at any time.

// Pool source: which scenes are eligible before the per-scene
// `excluded` flags narrow it further.
//   'all'      -- every scene in session.scenes (Spotify-shuffle the
//                 whole library)
//   'timeline' -- only scenes currently placed in session.sequence
//                 (shuffle the songs you queued)
export type GenerativePoolSource = 'all' | 'timeline'

// Selection mode preset. The engine's selector reads the underlying
// knobs (affinity, noRepeat, shuffleCycle) directly -- modes are UI
// shortcuts that write those knobs to a known feel. 'custom' is the
// auto-applied label when the user tweaks any knob away from the
// preset's defaults.
//   'random'   -- affinity=0, noRepeat=true, shuffleCycle=false
//   'drift'    -- affinity=+80, noRepeat=true, shuffleCycle=false
//                 (strong pull toward similar scenes)
//   'surprise' -- affinity=-80, noRepeat=true, shuffleCycle=false
//                 (strong pull toward dissimilar scenes)
//   'shuffle'  -- affinity=0, noRepeat=true, shuffleCycle=true
//                 (every scene once before any repeats)
//   'custom'   -- knobs don't match any preset's exact values
export type GenerativeMode =
  | 'random'
  | 'drift'
  | 'surprise'
  | 'shuffle'
  | 'custom'

export interface GenerativeConfig {
  // Master toggle. Flipping this true diverts the engine's
  // auto-advance into the generative selector.
  enabled: boolean
  poolSource: GenerativePoolSource
  // Per-scene exclude flags. Default false (= in pool) for any scene
  // not listed. Sparse storage keyed by sceneId, only entries that are
  // true get persisted. The Generative popover's checklist writes
  // here.
  excluded: Record<string, boolean>
  mode: GenerativeMode
  // Bipolar similarity bias.
  //   -100 = always pick most dissimilar (Contrast)
  //      0 = ignore similarity (pure weighted random)
  //   +100 = always pick most similar (Coherence)
  // Engine maps |affinity|/100 to an exponent in [0, 4] applied to
  // each candidate's similarity^exp, then negates the sign of the
  // exponent for negative affinity (so Contrast picks the inverse).
  affinity: number
  // No immediate repeat hard constraint. Even with affinity = 0 this
  // prevents back-to-back duplicates of the same scene (when the
  // pool has more than one eligible scene).
  noRepeat: boolean
  // Shuffle Cycle: every scene plays once before any can repeat. The
  // engine keeps a per-cycle "already played" set; resets when
  // exhausted. Weights still bias which scene plays NEXT within the
  // cycle, but every scene is guaranteed at least one play per cycle.
  shuffleCycle: boolean
  // Auto-advance duration range. Stored in milliseconds (matches the
  // rest of the engine's time math). Engine rolls a fresh duration in
  // [min, max] each time it auto-advances under generative mode.
  minDurationMs: number // default 5000 (5 s)
  maxDurationMs: number // default 600000 (10 min)
  // When true, generative auto-advances pass the TransportBar's
  // current morphMs through to triggerScene so transitions glide.
  // When false, generative picks pass morphMs=0 (snap behavior)
  // regardless of TransportBar.
  useMorph: boolean
  // MIDI Learn bindings. All seven are independently learnable via
  // the existing L-hotkey + Learned-panel flow.
  toggleMidi?: MidiBinding
  noRepeatMidi?: MidiBinding
  affinityMidi?: MidiBinding
  minDurationMidi?: MidiBinding
  maxDurationMidi?: MidiBinding
  useMorphMidi?: MidiBinding
  randomWeightsMidi?: MidiBinding
}

// Generative mode legal ranges -- imported by the engine + UI for
// clamping. Exposed as constants so a future migration can widen them
// without touching both ends of the codebase.
export const GENERATIVE_DURATION_MIN_MS = 100
export const GENERATIVE_DURATION_MAX_MS = 600000
export const GENERATIVE_AFFINITY_MIN = -100
export const GENERATIVE_AFFINITY_MAX = 100
export const SCENE_WEIGHT_MIN = 1
export const SCENE_WEIGHT_MAX = 10
export const SCENE_WEIGHT_DEFAULT = 1

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
  // Per-slot overrides for the Sequence view. Keyed by slot index
  // (0..sequenceLength-1). Each override is a partial of the scene's
  // own playback fields — when an override is present, the engine
  // uses it; otherwise the scene's default applies. Lets the user
  // drop the same Scene into multiple slots and give EACH placement
  // its own duration / follow action while sharing the underlying
  // OSC/MIDI cells.
  //
  // Sparse storage — only slots with at least one override field
  // get an entry. Missing slots / fields fall through to the
  // scene's defaults. Removing a slot from the sequence cleans up
  // its override automatically (via setSequenceSlot).
  sequenceSlotOverrides?: Record<number, SequenceSlotOverride>
  focusedSceneId: string | null
  midiInputName: string | null
  // Global MIDI OUTPUT enable. When false the engine skips every
  // `midiOut.enabled` cell entirely — no port opens, no native send
  // happens, zero CPU cost for live shows that don't need MIDI.
  // Default true (on) so a freshly-installed app with MIDI hardware
  // attached just works. Toggle lives in the top toolbar's prefs
  // sub-toolbar next to the theme picker.
  midiEnabled: boolean
  // Transport-level MIDI bindings. These fire the cue GO (identical to
  // clicking the GO button / hitting Space) and set the transport-level
  // morph time (CC value 0..127 → 0..10 000 ms, linear). Both are
  // optional and CC/note-bindable via the global MIDI Learn workflow.
  goMidi?: MidiBinding
  morphTimeMidi?: MidiBinding
  // Global Meta Controller bank — 8 user-assignable knobs that broadcast a
  // scaled value to up to 8 OSC destinations each. Persisted with the session.
  metaController: MetaController
  // OSC forwarding — dataFLOU listens on `defaultDestPort` and, for
  // every enabled target in this list, copies each received UDP packet
  // onward. Lets dataFLOU sit in front of Pd / Ableton / second machine
  // when the upstream sender (e.g. a Teensy-firmware-locked controller)
  // can only target one port and we still need multiple consumers.
  // Optional + defaults to `[]` for back-compat with v0.4 sessions.
  forwardTargets?: OscForwardTarget[]
  // Persisted GUI layout — captures Ctrl+wheel zoom, row height,
  // column widths, drawer heights, and collapse flags so a saved
  // session re-opens at exactly the size + shape the user left it.
  // Optional + every sub-field is also optional, so older sessions
  // without this field fall back to the renderer's runtime defaults.
  ui?: SessionUiState
  // Persisted Hardware Mode runtime state. Captures which arg slots
  // were caught by hardware at save time so a reopened session
  // resumes red-highlighted catches WITHOUT needing the user to
  // re-wiggle every knob. Override VALUES aren't persisted (they
  // self-heal on the next incoming OSC packet from the bound
  // device — usually within milliseconds). Optional + per-track
  // empty arrays simply mean "no slots caught".
  hardwareState?: {
    caughtByTrack: Record<string, number[]>
  }
  // Generative Scene Sequencer config (v0.5.10). When enabled, the
  // engine's auto-advance path picks the next scene from a weighted
  // pool instead of following each scene's authored nextMode. Manual
  // triggers (Cue/GO, scene clicks, MIDI scene triggers, Space, 1-0)
  // still play the scene at its authored duration -- only natural
  // advances are diverted. Optional + back-compat: older sessions
  // without this field default to disabled.
  generative?: GenerativeConfig
  // Incoming OSC listener port (v0.5.10). Stored on the session so
  // the binding travels with the file -- when you reopen the
  // session, dataFLOU re-binds to the same port automatically.
  // Optional + back-compat: when missing, the renderer falls back
  // to its localStorage value (`dataflou.networkPort:v1`) or 9000.
  listenerPort?: number
}

// GUI layout snapshot saved with each session. Mirrors the
// runtime fields in the renderer's store; loaded back into the
// store via `setSession` so the user's layout travels with the
// session file. Every field is optional — partial UI snapshots
// (e.g. a hand-edited session file) just inherit defaults for any
// missing pieces.
export interface SessionUiState {
  uiScale?: number
  // v0.5.10 -- per-toolbar zoom multiplier (default 1.0). Applied on
  // top of uiScale so the toolbar's effective rendering is
  // `uiScale * topBarScale`. Lets users bump up just the toolbar
  // when uiScale is small (e.g. 0.6) without rescaling the grid.
  topBarScale?: number
  rowHeight?: number
  sceneColumnWidth?: number
  inspectorWidth?: number
  trackColumnWidth?: number
  editorNotesHeight?: number
  oscMonitorHeight?: number
  // (#18) Sequence-view left-column width + scene info panel height —
  // resizable but previously never persisted. Optional for back-compat.
  scenePaletteWidth?: number
  sceneInfoPanelHeight?: number
  tracksCollapsed?: boolean
  scenesCollapsed?: boolean
  // (v0.6) Per-scope frame settings for the Input Conditioning scopes,
  // keyed `${templateId}|${address}|${slot}`. Each Parameter's scope
  // keeps its own time window / value range / height. View state, not
  // undo-tracked; mirrored from the module-scope scopePrefs Map at
  // save time.
  scopePrefs?: Record<
    string,
    { windowSec: number; yMin: number; yMax: number; height: number; inited: boolean }
  >
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
  // Wall-clock ms when pause was entered (Date.now()), or null if
  // running. Renderer countdowns use this to freeze their elapsed
  // calculation at this timestamp instead of Date.now() so the
  // visual display also pauses.
  pausedAt: number | null
  tickRateHz: number
  // Per-track Hardware Mode catch state. Keyed by trackId, value is
  // the sorted array of arg-slot indices currently overridden by
  // hardware. Empty / missing = no override. Lets the renderer's
  // CellTile do a single O(1) lookup by trackId instead of iterating
  // every key looking for a prefix match — was a measurable hot path
  // when many cells were on screen.
  hardwareCaughtByTrack?: Record<string, number[]>
  // Per-cell last-emitted MIDI velocity (after humanize jitter has
  // been applied). Key format: `${sceneId}|${trackId}`. Only present
  // for cells that have actually fired a noteOn — undefined for cells
  // that haven't played yet. Lets the renderer show the jittered
  // velocity in the cell tile so Humanize "moves" visibly.
  lastEmittedVelocityByCell?: Record<string, number>
  // (v0.6) Live hardware-input readout, keyed by OSC address. `raw` =
  // the values the controller last sent, `cond` = those values after
  // Input Conditioning, `t` = wall-clock ms of arrival (freshness).
  // Only present for addresses seen from a Hardware-Mode device in the
  // last ~5s. The Parameter sidebar shows a red dot + value: `raw` when
  // that Parameter's Input Scaling is off, or scale(`cond`) when it's
  // on (matching exactly what drives the parameter). Absent when no
  // HW-Mode device is active.
  hardwareLiveByAddress?: Record<
    string,
    { raw: number[]; cond: number[]; t: number }
  >
  // Per-scene most-recent generative auto-rolled duration (ms).
  // Each entry = the duration the engine rolled the last time it
  // triggered that scene under generative mode. The Scene Inspector
  // overlays this on the focused scene's Dur input so the user can
  // see "this scene last played for X seconds under the current
  // min/max window." Scenes that have never played under generative
  // are absent from the map. Engine prunes entries on session
  // reload + scene removal. Undefined when the map is empty.
  generativeRolledBySceneId?: Record<string, number>
}

// Live snapshot of Modulation 1's EFFECTIVE values for the cell
// currently being watched by the Inspector. Produced by the engine
// each tick (throttled to ~30 Hz) by running `applyMod2ToMod1` and
// extracting the user-facing knobs Mod 2 can target. The renderer
// overlays these onto the Modulator section's controls so the slider
// thumbs + number readouts animate at the modulation rate.
//
// Only the params Mod 2 can actually target appear here — keeps the
// payload tiny (5 numbers + a couple of strings per tick). Renderer
// falls back to stored values when a field is undefined.
export interface Mod1LiveSample {
  sceneId: string
  trackId: string
  rateHz: number
  depthPct: number
  // Per-type Rate readout — Attractor's speed and Ramp's time aren't
  // tracked by rateHz. Populated only when the relevant Mod 1 type is
  // active so the renderer doesn't overlay stale values on the wrong
  // editor.
  attractorSpeed?: number
  rampMs?: number
  // Per-type shape param (only the relevant one for the current
  // Modulation 1 type is populated; the rest are undefined).
  lfoShape?: LfoShape
  shDistribution?: number
  randomDistribution?: number
  attractorChaos?: number
  chaosR?: number
  slewRiseMs?: number
  slewFallMs?: number
  envelopeSustain?: number
  rampCurvePct?: number
  arpMode?: ArpMode
  gestureWiggle?: number
  // Gesture playhead position — the engine's current sample of the
  // recorded XY curve at the modulator's playback position. The
  // GestureEditor's canvas overlays a dot at this position so the
  // user sees the playhead trace the curve in real time. Populated
  // only when Modulation 1 type === 'gesture'.
  gesturePlayheadX?: number
  gesturePlayheadY?: number
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

// ─────────────────────────────────────────────────────────────────────
// MIDI output telemetry — streamed to the Monitor drawer in parallel
// with OSC events. Same batching cadence (50 ms) as the OSC monitor.
// ─────────────────────────────────────────────────────────────────────

export interface MidiSendEvent {
  timestamp: number
  portName: string
  kind: 'cc' | 'noteOn' | 'noteOff'
  channel: number // 1..16, UI-facing
  data1: number   // cc number or note number
  data2: number   // cc value or velocity (Note Off = 0)
}

export interface MidiErrorEvent {
  timestamp: number
  portName: string
  channel: number // 0 for port-open errors
  message: string
}

// ─────────────────────────────────────────────────────────────────────
// Network discovery — passive OSC listener.
//
// The Pool drawer's Network tab surfaces every OSC sender on the local
// network that has hit our listening port. Each unique (ip, port)
// becomes a `DiscoveredOscDevice`; every distinct OSC address path that
// device has emitted becomes a `DiscoveredOscAddress`. The user can then
// drag a device onto the Edit sidebar to materialise it as an
// Instrument with one Parameter per observed address.
// ─────────────────────────────────────────────────────────────────────

// One OSC address path observed from a particular sender, with a tiny
// fingerprint of the latest arg shape so the UI can infer paramType.
export interface DiscoveredOscAddress {
  path: string
  lastSeen: number
  count: number
  // OSC type tags of the most recent message at this path. Drives
  // paramType inference when materialising as an Instrument
  // (e.g. one 'f' → float, three 'f' → v3, four 'f' → colour, etc.).
  argTypes: string[]
  // Truncated string-rendered preview of the latest args, for display.
  argsPreview: string
  // Full last-seen values, one per argType. Capture's `buildOscTemplate`
  // reads this to wire up argSpec[] correctly for multi-arg addresses
  // like OCTOCOSME's `siffffff` (string + int + 6 floats) — without
  // it we could only ever see the first 4 args (the preview cap).
  // Capped to MAX_RECORDED_ARGS in main to bound IPC payload growth.
  argValues?: Array<{ type: string; value: number | string | boolean | null }>
}

// One sender on the local network — keyed by `${ip}:${port}` so a
// single device that uses two source ports shows up as two rows
// (rare, but unambiguous and easy to reason about).
export interface DiscoveredOscDevice {
  id: string // `${ip}:${port}`
  ip: string
  port: number
  // When we first / most recently saw a packet from this sender.
  firstSeen: number
  lastSeen: number
  packetCount: number
  // Optional friendly name — for now the UI just shows the ip:port,
  // but reserving the field keeps mDNS / OSCQuery integration easy
  // later (a service announcement can fill this in).
  name?: string
  // Set of OSC paths this device has emitted. Capped at 256 to keep
  // pathological floods (e.g. a streaming bundle per pixel) bounded.
  addresses: DiscoveredOscAddress[]
  // (v0.5.12) True when the source IP is loopback (127.0.0.1 or ::1).
  // Loopback sources are typically dataFLOU itself: scene cells that
  // target 127.0.0.1:<listenerPort> as a "broadcast bus" pattern
  // loop right back into the listener with an ephemeral source port.
  // The UI flags these with "(self loopback)" to disambiguate them
  // from real external devices, and Hardware Mode's device picker
  // hard-excludes them — you should never bind HW Mode to your own
  // loopback by accident (the v0.5.11 forward-suppression would then
  // suppress your scene's own emissions, breaking the bus pattern).
  isLoopback?: boolean
}

// Status snapshot pushed to the renderer alongside the device list —
// tells the Network tab whether the listener is bound, what port it
// chose, and what local IPv4 addresses the user should point their
// sender at to be picked up.
export interface NetworkListenerStatus {
  enabled: boolean
  port: number
  localAddresses: string[]
  // Most recent bind error message ('' if none).
  lastError: string
}

// v0.5.10 -- per-source diagnostic counter for the HW Mode Suppress
// panel in Pool > Network. One entry per (ip, port) UDP source the
// listener has heard from. `suppressed` increments when the engine's
// HW Mode suppress hook claimed the packet (= no dual-emission risk);
// `forwarded` increments when the packet passed through the forward
// path (= would reach Max/PD if any target is enabled). When a HW
// Mode template is configured for this source but `forwarded > 0`,
// the panel flags dual-emission danger.
export interface ForwardDiagEntry {
  ip: string
  port: number
  received: number
  suppressed: number
  forwarded: number
  // (v0.5.12) Wall-clock ms of the most recent packet observed from
  // this source. Lets the UI distinguish "configured source has gone
  // silent" (stale lastSeenAtMs > 5s ago) from "actively streaming"
  // even when the counter snapshot looks identical between polls.
  // Optional for backward compatibility with renderer code that
  // doesn't yet read it.
  lastSeenAtMs?: number
}

// One OSC forward destination. dataFLOU listens on `session.defaultDestPort`
// and, if any forward target is enabled, byte-copies every received UDP
// packet onward to that target's ip:port. Lets dataFLOU sit in front of
// downstream consumers (Pure Data, Ableton, TouchDesigner, another
// machine on the LAN) that used to share the listener port directly.
//
// The forward path is byte-perfect — no parsing, no re-encoding, no
// rewriting of source IP. Downstream sees packets coming FROM this
// machine (not from the original sender), which is normally fine
// because consumers care about content, not origin.
export interface OscForwardTarget {
  id: string
  enabled: boolean
  // Optional friendly label — "Pd", "Ableton", "TD machine" — for the UI.
  label?: string
  ip: string
  port: number
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
  // Two-stage modulator — tells the engine which cell the Inspector
  // is currently watching so it can publish that cell's effective
  // Mod 1 values at ~30 Hz. `null` deselects (engine stops emitting).
  setSelectedCellForLive: (
    sel: { sceneId: string; trackId: string } | null
  ) => Promise<void>
  // Session I/O
  sessionSaveAs: (session: Session) => Promise<string | null> // returns filepath
  sessionSave: (session: Session, path: string) => Promise<boolean>
  // No-dialog save to `<userData>/sessions/<name>.dflou.json`.
  // Used by the Save-before-quit modal when no path is associated.
  sessionSaveToDefault: (session: Session) => Promise<string>
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
  // Batched outgoing MIDI events (Monitor drawer). Same cadence as
  // OSC events — main side batches at 50 ms.
  onMidiEvents: (cb: (batch: MidiSendEvent[]) => void) => () => void
  // Batched MIDI send / port-open errors.
  onMidiErrors: (cb: (batch: MidiErrorEvent[]) => void) => () => void
  // Two-stage modulator — live effective-Mod-1 values for the cell
  // the Inspector is currently watching (see setSelectedCellForLive).
  // Emits at ~30 Hz while Modulation 2 is enabled and any target is
  // active. Null sample = "no live data" (engine cleared the selection
  // or the cell isn't armed). Renderer overlays these values onto the
  // sliders / number inputs in the Modulator section so the user sees
  // Mod 2's modulation animating.
  onMod1Live: (cb: (sample: Mod1LiveSample | null) => void) => () => void

  // ── MIDI output ──────────────────────────────────────────────────
  // Returns the list of MIDI output ports currently visible to the
  // OS. UI calls this on mount + after the global enable toggle.
  midiListPorts: () => Promise<{ ports: string[]; available: boolean; lastError: string }>

  // ── Scene library (global, persists across sessions) ────────────
  // The library lives in `<userData>/scene-library.json`. Reads are
  // cached in main; writes go through atomic .tmp + rename. The
  // renderer's Pool · Scenes tab subscribes to changes via
  // `onSceneLibrary` for instant updates after a save.
  sceneLibraryList: () => Promise<SavedScene[]>
  sceneLibrarySave: (scene: SavedScene) => Promise<void>
  sceneLibraryRemove: (id: string) => Promise<void>
  onSceneLibrary: (cb: (scenes: SavedScene[]) => void) => () => void

  // ── Pool library (User Instruments + Parameters) ────────────────
  // Cross-session persistent store of the user's authored Pool
  // entries. Renderer fetches the current set on mount + pushes
  // back the full User-entry set on every store change. Other
  // windows (if any) hear updates via `onPoolLibrary`.
  poolLibraryGet: () => Promise<{
    templates: InstrumentTemplate[]
    parameters: ParameterTemplate[]
  }>
  poolLibrarySetAll: (payload: {
    templates: InstrumentTemplate[]
    parameters: ParameterTemplate[]
  }) => Promise<void>
  onPoolLibrary: (
    cb: (payload: {
      templates: InstrumentTemplate[]
      parameters: ParameterTemplate[]
    }) => void
  ) => () => void

  // ── App lifecycle (close coordination) ───────────────────────────
  // Main fires `app:before-close` when the OS X button is pressed;
  // renderer shows the Save-before-quit modal, then signals back
  // via `appCloseProceed` to let the window actually close.
  onAppBeforeClose: (cb: () => void) => () => void
  appCloseProceed: () => Promise<void>

  // ── Network discovery ────────────────────────────────────────────
  // Enable / disable the passive UDP OSC listener. Optional `port`
  // re-binds on a different inbox (default 9000). Resolves with the
  // post-action status snapshot. Bind failures surface in `lastError`
  // and `enabled` stays false.
  networkSetEnabled: (
    enabled: boolean,
    port?: number
  ) => Promise<NetworkListenerStatus>
  // Snapshot fetch — initial list + current status. Called once on
  // mount; subsequent updates arrive via `onNetworkDevices`.
  networkList: () => Promise<{
    status: NetworkListenerStatus
    devices: DiscoveredOscDevice[]
  }>
  // Wipe the device cache — useful when the user wants to re-scan
  // without restarting the app.
  networkClear: () => Promise<void>
  // Push the current set of forward targets to the main process. The
  // listener re-emits every received UDP packet to each ENABLED target
  // in the list. Pass `[]` (or all disabled) to turn forwarding off.
  // Called from the store on any add/remove/enable/edit so main always
  // mirrors the renderer's session state.
  networkSetForwardTargets: (targets: OscForwardTarget[]) => Promise<void>
  // v0.5.10 -- per-source diagnostic counter snapshot for the HW
  // Mode Suppress panel. Polled by the renderer at ~2 Hz while the
  // panel is visible. Returns the full set in one go so the UI
  // can show every recently-seen source, not just the HW-Moded ones.
  networkGetForwardDiag: () => Promise<ForwardDiagEntry[]>
  // v0.5.10 -- reset the diagnostic counters without clearing the
  // device list. Lets the user measure a fresh window after
  // flipping a HW Mode toggle to verify the fix took.
  networkClearForwardDiag: () => Promise<void>
  // v0.5.10 -- package version string (e.g. "0.5.10"). Resolves
  // to the value Electron's `app.getVersion()` returns, which is
  // sourced from package.json at app start. Renderer reads this
  // once on mount to bake the version into `document.title`.
  appGetVersion: () => Promise<string>
  // v0.6 -- Input Conditioning live scope. Poll with the watch you
  // want; the call itself registers/refreshes that watch (TTL-kept,
  // multiple concurrent watchers supported) and returns its ring
  // buffer of {t, raw, cond} samples. Stop polling and the watch
  // expires within ~1.5s → zero per-packet cost. Pass null to poll
  // nothing (returns []).
  conditionerGetScope: (
    watch: { templateId: string; address: string; slot: number } | null,
    windowMs?: number
  ) => Promise<{ t: number; raw: number; cond: number }[]>
  // v0.6 -- State Triggers: live match scores + active flags, keyed
  // `${templateId}|${stateId}`. Polled ~10 Hz while the section is
  // expanded.
  stateTriggerGetLive: () => Promise<{
    scores: Record<string, number>
    active: Record<string, boolean>
  }>
  // v0.6 -- learn-by-demonstration recording. Engine collects the
  // bound device's conditioned stream for durationMs and resolves with
  // the reduced model (or null when the device stayed silent).
  stateTriggerRecord: (
    templateId: string,
    stateId: string,
    durationMs: number
  ) => Promise<LearnedState | null>
  // Push channel — fired on a 250ms timer whenever the device map has
  // changed (new sender, new address, or fresh packet count). Status
  // is bundled in so port-rebinds and bind errors round-trip too.
  onNetworkDevices: (
    cb: (payload: {
      status: NetworkListenerStatus
      devices: DiscoveredOscDevice[]
    }) => void
  ) => () => void
}
