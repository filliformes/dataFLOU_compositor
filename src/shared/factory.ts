import type {
  ArpMode,
  ArpeggiatorParams,
  Cell,
  ChaosParams,
  EnvelopeParams,
  InstrumentFunction,
  InstrumentTemplate,
  MetaController,
  MetaCurve,
  MetaKnob,
  Modulation,
  MultMode,
  ParamArgSpec,
  Pool,
  RampParams,
  RandomParams,
  SampleHoldParams,
  Scene,
  SeqMode,
  SequencerParams,
  SlewParams,
  Session,
  Track
} from './types'
import { META_KNOB_COUNT } from './types'

export function uid(prefix = ''): string {
  return prefix + Math.random().toString(36).slice(2, 10)
}

// BPM-synced LFO time divisions. Beats in quarter-note-at-1 units: so '1/4'
// = 1 beat (quarter note), '1/1' = 4 beats (whole note), '2/1' = 8 beats.
export interface DivisionEntry { label: string; beats: number }
export const DIVISIONS: DivisionEntry[] = [
  { label: '1/128', beats: 4 / 128 },
  { label: '1/64', beats: 4 / 64 },
  { label: '1/32', beats: 4 / 32 },
  { label: '1/16', beats: 4 / 16 },
  { label: '1/8', beats: 4 / 8 },
  { label: '1/4', beats: 1 },
  { label: '1/2', beats: 2 },
  { label: '1/1', beats: 4 },
  { label: '2/1', beats: 8 },
  { label: '4/1', beats: 16 },
  { label: '8/1', beats: 32 },
  { label: '16/1', beats: 64 },
  { label: '32/1', beats: 128 },
  { label: '64/1', beats: 256 },
  { label: '128/1', beats: 512 }
]

// ---- LFO rate helpers (shared by engine + renderer visuals) ----

/** Compute the effective LFO frequency in Hz, respecting Sync mode + dotted/triplet. */
export function effectiveLfoHz(
  m: { sync: 'free' | 'bpm'; rateHz: number; divisionIdx: number; dotted: boolean; triplet: boolean },
  bpm: number
): number {
  if (m.sync !== 'bpm') return m.rateHz
  const entry = DIVISIONS[Math.max(0, Math.min(DIVISIONS.length - 1, m.divisionIdx))]
  let beats = entry.beats
  if (m.dotted) beats *= 1.5
  if (m.triplet) beats *= 2 / 3
  const periodSec = beats * (60 / Math.max(1, bpm))
  return periodSec > 0 ? 1 / periodSec : 0
}

// ---- Free-Hz slider log-mapping ----
//
// The raw slider runs 0..100 (integer). Bottom half (0..50) covers 0.01..20 Hz,
// top half (50..100) covers 20..100 Hz. Gives finer control in the musically
// useful low range without losing reach into the fast region.

const RATE_MIN = 0.01
const RATE_MID = 20
const RATE_MAX = 100

export function sliderToRateHz(s: number): number {
  const x = Math.max(0, Math.min(100, s))
  if (x <= 50) return RATE_MIN + (x / 50) * (RATE_MID - RATE_MIN)
  return RATE_MID + ((x - 50) / 50) * (RATE_MAX - RATE_MID)
}

export function rateHzToSlider(hz: number): number {
  const r = Math.max(RATE_MIN, Math.min(RATE_MAX, hz))
  if (r <= RATE_MID) return ((r - RATE_MIN) / (RATE_MID - RATE_MIN)) * 50
  return 50 + ((r - RATE_MID) / (RATE_MAX - RATE_MID)) * 50
}

export const DEFAULT_ENVELOPE: EnvelopeParams = {
  attackMs: 500,
  decayMs: 1000,
  sustainMs: 2000,
  releaseMs: 1000,
  attackPct: 0.1,
  decayPct: 0.2,
  sustainPct: 0.5,
  releasePct: 0.2,
  sustainLevel: 0.7,
  sync: 'synced',
  // Used only in sync='freeSync' mode; safe fallback for other modes.
  totalMs: 2000
}

export const DEFAULT_RAMP: RampParams = {
  rampMs: 1000,
  curvePct: 0, // linear
  sync: 'free',
  totalMs: 1000,
  mode: 'normal'
}

export const DEFAULT_ARPEGGIATOR: ArpeggiatorParams = {
  steps: 8,
  arpMode: 'up',
  multMode: 'div'
}

export const DEFAULT_RANDOM: RandomParams = {
  valueType: 'float',
  min: 0,
  max: 1
}

export const DEFAULT_SH: SampleHoldParams = {
  smooth: false,
  probability: 1.0
}

export const DEFAULT_SLEW: SlewParams = {
  riseMs: 200,
  fallMs: 200,
  randomTarget: true
}

export const DEFAULT_CHAOS: ChaosParams = {
  r: 3.8
}

export const DEFAULT_ATTRACTOR: import('./types').AttractorParams = {
  type: 'lorenz',
  speed: 1,
  chaos: 0.5
}

// Gesture modulator defaults — empty recording (engine emits a quiet
// centre value of 0.5 until the user records something), XY output
// routing, no wiggle. Rate is driven by the parent Modulation's
// rateHz / sync fields, not by Gesture's own params.
export const DEFAULT_GESTURE: import('./types').GestureParams = {
  points: [],
  mode: 'xy',
  wiggle: 0,
  playMode: 'forward'
}

export const DEFAULT_MODULATION: Modulation = {
  enabled: false,
  type: 'lfo',
  shape: 'sine',
  mode: 'unipolar',
  depthPct: 10,
  rateHz: 1,
  sync: 'free',
  divisionIdx: 5, // 1/4
  dotted: false,
  triplet: false,
  envelope: { ...DEFAULT_ENVELOPE },
  ramp: { ...DEFAULT_RAMP },
  arpeggiator: { ...DEFAULT_ARPEGGIATOR },
  random: { ...DEFAULT_RANDOM },
  sh: { ...DEFAULT_SH },
  slew: { ...DEFAULT_SLEW },
  chaos: { ...DEFAULT_CHAOS },
  attractor: { ...DEFAULT_ATTRACTOR },
  gesture: { ...DEFAULT_GESTURE }
}

// Two-stage modulator default. Same shape as DEFAULT_MODULATION
// (sine LFO at 1 Hz) PLUS the targeting fields filled in with
// "moderate impact on rate + depth, no shape modulation yet". Off by
// default so adding cells doesn't silently introduce a second
// modulator — the user opts in via the Inspector toggle.
export const DEFAULT_MODULATION2: Modulation = {
  ...DEFAULT_MODULATION,
  // Slightly slower so the rate-on-rate modulation reads as
  // "shape-shifting" rather than chaotic. Bipolar so the swing is
  // symmetric around the base Mod 1 values.
  rateHz: 0.5,
  mode: 'bipolar',
  envelope: { ...DEFAULT_ENVELOPE },
  ramp: { ...DEFAULT_RAMP },
  arpeggiator: { ...DEFAULT_ARPEGGIATOR },
  random: { ...DEFAULT_RANDOM },
  sh: { ...DEFAULT_SH },
  slew: { ...DEFAULT_SLEW },
  chaos: { ...DEFAULT_CHAOS },
  attractor: { ...DEFAULT_ATTRACTOR },
  gesture: { ...DEFAULT_GESTURE },
  // Sensible starter routing: Rate and Depth each receive a 50%
  // amount, Shape disabled (user opts in once they understand the
  // context-aware target for their Mod 1 type).
  targets: {
    rate: { enabled: true, amount: 50 },
    depth: { enabled: true, amount: 50 },
    shape: { enabled: false, amount: 0 }
  },
  targetMode: 'multiplicative'
}

// ---- Arpeggiator helpers ----

/**
 * Build the ladder of step values from a base Value, given N steps and a
 * multiplication mode. The ladder is the ordered set of values the arp will
 * emit — step indexing here is 0-based.
 *
 *  - 'div'     — Value = max; evenly-spaced fractions of Value.
 *                e.g. V=10, N=8 → [1.25, 2.5, 3.75, 5, 6.25, 7.5, 8.75, 10]
 *  - 'mult'    — Value = step 1; each next step doubles.
 *                e.g. V=10, N=8 → [10, 20, 40, 80, 160, 320, 640, 1280]
 *  - 'divMult' — Value at the true middle (or just-above-middle for even N);
 *                halvings below, doublings above.
 *                e.g. V=10, N=8 → [0.625, 1.25, 2.5, 5, 10, 20, 40, 80]
 *                e.g. V=10, N=7 → [1.25, 2.5, 5, 10, 20, 40, 80]
 */
export function buildArpLadder(value: number, steps: number, multMode: MultMode): number[] {
  const N = Math.max(1, Math.min(8, Math.round(steps)))
  if (multMode === 'div') {
    return Array.from({ length: N }, (_, i) => (value * (i + 1)) / N)
  }
  if (multMode === 'mult') {
    return Array.from({ length: N }, (_, i) => value * Math.pow(2, i))
  }
  // divMult: true middle for odd N; just-above-middle for even N (idx = N/2).
  const midIdx = Math.floor(N / 2)
  return Array.from({ length: N }, (_, i) => {
    const off = i - midIdx
    if (off === 0) return value
    return off < 0 ? value / Math.pow(2, -off) : value * Math.pow(2, off)
  })
}

/**
 * Precomputed traversal pattern for deterministic arp modes. Each entry is
 * a step index into the ladder. The engine iterates this array cyclically.
 *
 *  - up         — [0, 1, …, N-1]                      (N positions)
 *  - down       — [N-1, …, 0]                         (N positions)
 *  - upDown     — [0, 1, …, N-1, N-1, …, 1, 0]        (2N; both ends doubled)
 *  - downUp     — [N-1, …, 0, 0, …, N-1]              (2N)
 *  - exclusion  — [0, 1, …, N-1, N-2, …, 1]           (2N-2; neither end repeated)
 *
 * walk / drunk / random don't use patterns — the engine advances them
 * stochastically each step.
 */
export function buildArpPattern(mode: ArpMode, steps: number): number[] {
  const N = Math.max(1, Math.min(8, Math.round(steps)))
  if (mode === 'up') return Array.from({ length: N }, (_, i) => i)
  if (mode === 'down') return Array.from({ length: N }, (_, i) => N - 1 - i)
  if (mode === 'upDown') {
    const pat: number[] = []
    for (let i = 0; i < N; i++) pat.push(i)
    for (let i = N - 1; i >= 0; i--) pat.push(i)
    return pat
  }
  if (mode === 'downUp') {
    const pat: number[] = []
    for (let i = N - 1; i >= 0; i--) pat.push(i)
    for (let i = 0; i < N; i++) pat.push(i)
    return pat
  }
  if (mode === 'exclusion') {
    const pat: number[] = []
    for (let i = 0; i < N; i++) pat.push(i)
    for (let i = N - 2; i >= 1; i--) pat.push(i)
    return pat.length > 0 ? pat : [0]
  }
  // walk/drunk/random — fall back to identity pattern; engine handles advance.
  return [0]
}

// ---- Random Generator helpers ----

/** FNV-1a-ish string hash for PRNG seeding. Stable across runs. */
export function hashSeedString(s: string): number {
  let h = 2166136261 >>> 0
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 16777619) >>> 0
  }
  // Ensure non-zero
  return h === 0 ? 0x9e3779b9 : h
}

/** Mulberry32 — tiny, decent-quality seedable PRNG. Returns 0..1. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export const DEFAULT_SEQUENCER: SequencerParams = {
  enabled: false,
  steps: 8,
  syncMode: 'tempo',
  bpm: 120,
  stepMs: 500,
  stepValues: ['0', '0', '0', '0', '0', '0', '0', '0', '', '', '', '', '', '', '', ''],
  mode: 'steps',
  // Classic Euclidean default: 3 pulses over 8 steps gives you the
  // cuban tresillo / Cinquillo pattern — useful out of the box.
  pulses: 3,
  rotation: 0,
  // Polyrhythm: 3-against-4 is the friendliest "interesting" cross-rhythm.
  ringALength: 3,
  ringBLength: 4,
  combine: 'or',
  // Density: 50% on a fresh seed gives audible variation without being
  // either too sparse or saturated.
  density: 50,
  seed: 42,
  // Cellular: rule 90 (Sierpinski) is the most visually rewarding default;
  // rule 30 is more chaotic; rule 110 has gliders. cellSeed defaults to
  // a multi-bit pattern (0b0010110100110010 = 11570) so the first cycle
  // already has several hits — a single-bit seed (cellSeed=0 special
  // case) plays only ONE step in cycle 1, which felt broken to users.
  rule: 90,
  cellSeed: 11570,
  cellularSeedLfoDepth: 0,
  cellularSeedLfoRate: 0.5,
  // Drift: pure random walk by default with wrap edges — safe + organic.
  bias: 0,
  edge: 'wrap',
  // Ratchet: 25% chance of 2..3 subdivisions = subtle burst flavour.
  ratchetProb: 25,
  ratchetMaxDiv: 3,
  ratchetVariation: 0,
  ratchetMode: 'octaves',
  // Bounce: 60% maps to e ≈ 0.73 — a clearly-bouncy ball that
  // settles audibly without dying off after one or two bounces.
  bounceDecay: 60,
  // Generative: off by default — opting in is the whole point.
  // 50% Variation lands a balanced default for the seven modes (none
  // of them feel either silent or maxed out at 50%).
  generative: false,
  genAmount: 50,
  // Rest behaviour: Hold by default — receivers don't get spammed
  // with redundant identical values; they hold their last sample
  // naturally. Was 'last' (continuous re-send) which generated a
  // lot of redundant OSC traffic for the common case.
  restBehaviour: 'hold',
  // Draw — default to a 32-step curve preset to a gentle rising-then-
  // falling sine across [0.1, 0.9]. Gives the user an immediately
  // recognisable shape to refine, instead of a dead-flat row.
  // drawValues backs 1024 cells; the engine only consumes the first
  // `drawSteps` entries.
  drawSteps: 32,
  drawValues: Array.from({ length: 1024 }, (_, i) => {
    if (i >= 32) return 0
    const phase = (i / 32) * Math.PI
    return 0.1 + 0.8 * Math.sin(phase)
  }),
  // Default X/Y range: [0, 1]. Maps the drawn 0..1 curve directly to
  // 0..1 output — drop-in compatible with the previous behaviour.
  drawValueMin: 0,
  drawValueMax: 1
}

export function makeCell(defaults: {
  destIp: string
  destPort: number
  oscAddress: string
}): Cell {
  return {
    destIp: defaults.destIp,
    destPort: defaults.destPort,
    destLinkedToDefault: true,
    oscAddress: defaults.oscAddress,
    addressLinkedToDefault: true,
    value: '0',
    delayMs: 0,
    transitionMs: 0,
    modulation: {
      ...DEFAULT_MODULATION,
      envelope: { ...DEFAULT_ENVELOPE },
      ramp: { ...DEFAULT_RAMP },
      arpeggiator: { ...DEFAULT_ARPEGGIATOR },
      random: { ...DEFAULT_RANDOM },
      sh: { ...DEFAULT_SH },
      slew: { ...DEFAULT_SLEW },
      chaos: { ...DEFAULT_CHAOS }
    },
    sequencer: {
      ...DEFAULT_SEQUENCER,
      stepValues: [...DEFAULT_SEQUENCER.stepValues]
    },
    scaleToUnit: false,
    // MIDI output starts disabled on a freshly-created cell — the
    // user opts in from the Inspector's MIDI section. Velocity slot
    // defaults to a safe 100 (musical mezzo-forte) so the first
    // Note On after the user flips MIDI on isn't a ghost-quiet zero.
    velocity: '100',
    velocityPersistent: false,
    notePersistent: false,
    // MIDI Scale starts OFF — only affects the MIDI emit path
    // (multiplies 0..1 by 127 for CC / note range mapping). User
    // opts in via the Inspector checkbox next to Scale 0.0–1.0.
    midiScale: false,
    // OSC emission ON by default — clips wire to OSC out of the
    // box. Inspector checkbox flips this off when the user wants a
    // MIDI-only cell (e.g. a Note trigger that doesn't also blast
    // an unused OSC address).
    oscEnabled: true,
    // Timing section starts collapsed AND disabled. The user
    // explicitly ticks the checkbox on the Timing header to enable
    // delay + transition. Keeps fresh cells light + uncluttered.
    timingEnabled: false
  }
}

// Default MIDI output binding — what a cell or Parameter snapshot
// reads when the user first toggles MIDI on. CC kind on channel 1
// with CC 1 (mod wheel) is the safest "the MIDI works at all" probe.
export const DEFAULT_MIDI_OUT: import('./types').MidiOut = {
  enabled: false,
  portName: '',
  channel: 1,
  kind: 'cc',
  cc: 1,
  noteMode: 'velocity',
  gateLengthMs: 0
}

// Build a Euclidean rhythm pattern — `pulses` active hits distributed as
// evenly as possible across `steps` total slots, then rotated by
// `rotation` (modulo `steps`). Returns a boolean[] of length `steps`
// where `true` = hit, `false` = rest.
//
// Uses the "angle method" (Toussaint): step i is a hit iff
//   floor((i+1) · p / s) − floor(i · p / s) === 1.
// This produces the same even-as-possible distribution as Bjorklund for
// our purposes (up to rotation), in clean O(steps).
//
// Examples (before rotation):
//   euclidean(3, 8) = [F F T F F T F T]   (tresillo, rotated)
//   euclidean(5, 8) = [F T F T T F T T]   (cinquillo, rotated)
//   euclidean(4, 4) = [T T T T]           (four on the floor)
//
// Memoized per (pulses, steps, rotation) triple — the engine calls this
// every sequencer step. The key space is bounded by 16³ = 4096 max.
const euclideanCache = new Map<string, boolean[]>()
export function euclidean(pulses: number, steps: number, rotation: number): boolean[] {
  const s = Math.max(1, Math.floor(steps))
  const p = Math.max(0, Math.min(s, Math.floor(pulses)))
  const r = ((Math.floor(rotation) % s) + s) % s
  const key = `${p}:${s}:${r}`
  const cached = euclideanCache.get(key)
  if (cached) return cached

  const base = new Array<boolean>(s)
  if (p <= 0) base.fill(false)
  else if (p >= s) base.fill(true)
  else {
    for (let i = 0; i < s; i++) {
      base[i] = Math.floor(((i + 1) * p) / s) - Math.floor((i * p) / s) === 1
    }
  }

  let out = base
  if (r !== 0) {
    out = new Array<boolean>(s)
    for (let i = 0; i < s; i++) out[(i + r) % s] = base[i]
  }
  euclideanCache.set(key, out)
  return out
}

// ─────────────────────────────────────────────────────────────────────────
// New sequencer-mode helpers (polyrhythm / density / cellular / drift).
//
// All of these are PURE: deterministic given their inputs. State that
// has to live across ticks (the cellular row, the drift playhead) is
// owned by the engine's TrackState; these functions just describe one
// step of the math.

/** Polyrhythm gate at master step `i`. Each ring is a clock divider —
 *  ring A "fires" at clocks where `i mod ringALength === 0`, ring B at
 *  multiples of `ringBLength`. The combine op produces the gate.
 *
 *  Examples (ringA=3, ringB=4):
 *    OR  fires at 0, 3, 4, 6, 8, 9, 12, 15
 *    XOR fires at 3, 4, 6, 8, 9, 15
 *    AND fires at 0, 12 (every LCM-many clocks)
 */
export function polyrhythmGate(
  i: number,
  ringALength: number,
  ringBLength: number,
  combine: 'or' | 'xor' | 'and'
): boolean {
  const a = Math.max(1, Math.min(16, Math.floor(ringALength)))
  const b = Math.max(1, Math.min(16, Math.floor(ringBLength)))
  const hitA = i % a === 0
  const hitB = i % b === 0
  if (combine === 'or') return hitA || hitB
  if (combine === 'and') return hitA && hitB
  return hitA !== hitB // xor
}

/** Per-step deterministic hash → [0, 1). Used by Density mode to assign
 *  each step its own personality without any per-cell RNG state.
 *  Rolling: bit-mix `step` and `seed` into a 32-bit space. Same inputs
 *  always return the same number, which is exactly what we want — the
 *  user can lock a "feel" and just ride the Density knob.
 */
export function stepHash(step: number, seed: number): number {
  // Constant XOR'd into the pre-mix so step=0+seed=0 doesn't collapse
  // the entire imul cascade to 0 (which would make every density gate
  // fire at step 0 regardless of the density slider). 0x9E3779B9 is
  // the canonical golden-ratio mixer used by SplitMix etc.
  let x =
    ((Math.floor(step) * 2654435761) ^
      (Math.floor(seed) * 1597334677) ^
      0x9e3779b9) >>>
    0
  x = (x ^ (x >>> 16)) >>> 0
  x = Math.imul(x, 2246822507) >>> 0
  x = (x ^ (x >>> 13)) >>> 0
  x = Math.imul(x, 3266489909) >>> 0
  x = (x ^ (x >>> 16)) >>> 0
  return x / 4294967296
}

/** Density gate: step fires when its personality < density / 100.
 *  density=0 silences everything, density=100 fires every step. */
export function densityGate(i: number, seed: number, densityPct: number): boolean {
  const d = Math.max(0, Math.min(100, densityPct)) / 100
  if (d <= 0) return false
  if (d >= 1) return true
  return stepHash(i, seed) < d
}

/** One Wolfram-rule iteration of a 1D cellular automaton with cyclic
 *  boundary conditions. `row` is a bitmask (bit i = step i state),
 *  `rule` is 0..255. Returns the next-cycle row.
 *
 *  Each cell's next state is f(left, self, right) where f is encoded
 *  by the 8-bit rule number — bit `(L<<2)|(C<<1)|R` of `rule`.
 */
export function evolveCellular(row: number, rule: number, steps: number): number {
  const s = Math.max(1, Math.min(16, Math.floor(steps)))
  const r = Math.max(0, Math.min(255, Math.floor(rule))) >>> 0
  // Mask off any high bits that aren't part of this row.
  const mask = s >= 32 ? 0xffffffff : (1 << s) - 1
  const cur = (row >>> 0) & mask
  let next = 0
  for (let i = 0; i < s; i++) {
    const left = (cur >>> ((i - 1 + s) % s)) & 1
    const center = (cur >>> i) & 1
    const right = (cur >>> ((i + 1) % s)) & 1
    const idx = (left << 2) | (center << 1) | right
    if ((r >>> idx) & 1) next |= 1 << i
  }
  return next >>> 0
}

/** Initial cellular row. cellSeed=0 is treated specially as "single
 *  center cell on" so the automaton always has somewhere to start. */
export function cellularInitialRow(cellSeed: number, steps: number): number {
  const s = Math.max(1, Math.min(16, Math.floor(steps)))
  const rawSeed = Math.floor(cellSeed) >>> 0
  // At very low step counts (esp. s=1) the user's full cellSeed gets
  // masked down to a single bit — `cellSeed=11570 & 1 = 0`, falling
  // through to "center cell". Result: any even cellSeed at steps=1
  // silently lost the user's setting. Re-fold the high bits into
  // the visible window so the user's seed still influences the row.
  const mask = (1 << s) - 1 || 0xffffffff
  let folded = rawSeed & mask
  let shift = s
  while (shift < 32) {
    folded ^= (rawSeed >>> shift) & mask
    shift += s
  }
  if (folded !== 0) return folded
  // Center cell — for even step counts there is no exact center, so
  // bias to the right of the midpoint to avoid a useless 0 at i=0.
  const center = Math.floor(s / 2)
  return (1 << center) >>> 0
}

/** One step of the Brownian playhead. `bias` ∈ [-100, +100] sets the
 *  forward-skew of a 3-way coin (back / stay / forward). `edge` decides
 *  whether the head wraps or reflects at the row boundaries. */
export function advanceDrift(
  pos: number,
  steps: number,
  bias: number,
  edge: 'wrap' | 'reflect',
  rng: () => number
): number {
  const s = Math.max(1, Math.min(16, Math.floor(steps)))
  if (s <= 1) return 0
  const b = Math.max(-100, Math.min(100, bias)) / 100 // -1..1
  // Three-way distribution: pBack + pStay + pFwd = 1, all in [0, 1].
  // bias=0 → uniform 1/3 each; bias=+1 → fully forward (pFwd=1);
  // bias=-1 → fully back (pBack=1). pStay shrinks toward 0 at the
  // extremes so the walker can become monotonic. Previously pStay
  // was hardcoded to 1/3 regardless of bias, which capped pFwd at
  // 2/3 and made the most-aggressive bias still leave the head in
  // place a third of the time.
  const absB = Math.abs(b)
  const pStay = (1 - absB) / 3
  const pFwd = b >= 0 ? pStay + b * (1 - pStay) : pStay * (1 + b)
  const pBack = 1 - pStay - pFwd
  const r = rng()
  let dir: -1 | 0 | 1
  if (r < pBack) dir = -1
  else if (r < pBack + pStay) dir = 0
  else dir = 1
  let next = pos + dir
  if (edge === 'wrap') {
    next = ((next % s) + s) % s
  } else {
    // Reflect: bounce off both boundaries.
    if (next < 0) next = -next
    else if (next >= s) next = s - 1 - (next - (s - 1))
    next = Math.max(0, Math.min(s - 1, next))
  }
  return next
}

// Value-string parsing helpers.
// Values are space-separated tokens; non-numeric tokens pass through as
// string/bool OSC args. Capped at MAX_VALUE_TOKENS.
export function parseValueTokens(raw: string, max = 16): string[] {
  return raw.trim().split(/\s+/).filter((s) => s.length > 0).slice(0, max)
}

/** Generate a per-step Draw curve from the user's drawValues + a
 *  cycle index. Each output value = base + hash-driven jitter
 *  scaled by genAmount (0..1). Each cycle produces a different
 *  curve because the seed is folded with the cycle index. The
 *  user's drawValues stay untouched — generation reads from them
 *  and returns a fresh array.
 *
 *  Shared by the engine (mid-playback regeneration) and the
 *  renderer (live preview when generative is enabled). */
export function generateDrawCurveFromValues(
  drawValues: number[],
  drawSteps: number,
  seed: number,
  genAmount: number,
  cycle: number
): number[] {
  const steps = Math.max(4, Math.min(1024, Math.floor(drawSteps)))
  const amount = Math.max(0, Math.min(100, genAmount)) / 100
  const cycleSeed = seed + cycle * 137
  const out: number[] = new Array(steps)
  for (let i = 0; i < steps; i++) {
    const base = drawValues[i] ?? 0
    const jitter = (stepHash(i, cycleSeed) - 0.5) * 2 * amount
    out[i] = Math.max(0, Math.min(1, base + jitter))
  }
  return out
}

// ─────────────────────────────────────────────────────────────────────────
// Generative-mode helpers — one rule per sequencer mode, each rooted in
// a real-world / physical metaphor. All take a numeric base (the seed
// from the cell's Value field), the current step index + relevant
// per-mode params, and return the per-step value as a number.
//
// The wrapping helper `generateStepValue` walks the cell's Value tokens
// and applies the mode's rule to each numeric token (non-numeric tokens
// pass through unchanged), producing a space-separated string the
// engine can plug into its existing send path.
//
// `amount` is the shared Variation knob in [0, 1]. Each rule scales it
// to its own natural range. `seed` reuses the existing `seed` field
// (0..255) so all modes share a single roll-the-dice control.

/** Per-rule helpers for handling the cell's `scaleToUnit` flag.
 *  When the cell clamps its output to [0, 1], two adjustments are
 *  needed so generative rules don't immediately saturate at 1:
 *   - Treat the seed as a [0, 1] value (clamp to that range so a
 *     user who typed "10" still gets a valid base of 1).
 *   - Use `1` as the variation reference magnitude instead of
 *     |base| — at amount=1 the variation is ±1 (full swing across
 *     the entire 0..1 range), at amount=0.5 it's ±0.5, etc. Without
 *     this, |base| inflates the variation past the [0, 1] window
 *     and everything clamps to a single value.
 *  When scaleToUnit is off, both helpers fall back to the original
 *  behaviour: variation magnitude = |base| (so a base of 100 swings
 *  ±50 at 50% amount, which is what feels musical for un-clamped
 *  ranges like BPM, MIDI velocity, frequency, etc.). */
function genBase(base: number, scaleToUnit: boolean): number {
  return scaleToUnit ? Math.max(0, Math.min(1, base)) : base
}
function genMag(base: number, scaleToUnit: boolean): number {
  return scaleToUnit ? 1 : Math.abs(base || 1)
}

// ─────────────────────────────────────────────────────────────────
// All generative helpers below produce values in [base, base + amount·mag].
// The variation LIFTS the output above the seed/base instead of
// swinging around it — so base=0 gives a meaningful [0, amount·mag]
// range instead of half-zeros from a clipped ±swing. Musical
// interpretation: the user's `cell.value` is the floor of the cycle
// and Variation adds an upward expressive lift. Reverted from the
// "swing both ways" original at user request (no negative values
// in any generative output).
// ─────────────────────────────────────────────────────────────────

/** Steps → Tide. Smooth sine swell across one cycle, peak position
 *  shifted by the seed (low seed = peak early, high = late). At
 *  amount=0 every step equals the base; at amount=1 the cycle lifts
 *  from base up to base+mag at the peak and back. */
export function tideValue(
  base: number,
  i: number,
  steps: number,
  amount: number,
  seed: number,
  scaleToUnit: boolean
): number {
  const s = Math.max(1, steps)
  // Phase offset across seed 0..255 — slides where the swell crests
  // across the cycle.
  const phase = ((seed / 255) - 0.5) * Math.PI
  const t = (i / s) * Math.PI * 2
  // Half-cycle sine remapped to [0, 1] — the swell always lifts
  // above the baseline, never dips below.
  const swell = (Math.sin(t * 0.5 + phase) + 1) / 2
  return genBase(base, scaleToUnit) + swell * amount * genMag(base, scaleToUnit)
}

/** Euclidean → Accent. Hits land harder on the downbeat — a cosine
 *  envelope already in [0, 1], so this naturally never dips below base. */
export function accentValue(
  base: number,
  i: number,
  steps: number,
  amount: number,
  scaleToUnit: boolean
): number {
  const s = Math.max(1, steps)
  const w = (Math.cos((i / s) * Math.PI * 2) + 1) / 2
  return genBase(base, scaleToUnit) + w * amount * genMag(base, scaleToUnit)
}

/** Polyrhythm → Voicing. Three voices, all lifted ABOVE the base:
 *    - Ring A only  → +33%  (low voice, subtle lift)
 *    - Ring B only  → +66%  (high voice)
 *    - both rings   → +100% (resonance peak)
 *    - neither      → base  (no lift)
 *  The "root sits below the seed" reading from the old formula went
 *  negative when base=0, so we now treat the base as the floor. */
export function voicingValue(
  base: number,
  i: number,
  ringALength: number,
  ringBLength: number,
  amount: number,
  scaleToUnit: boolean
): number {
  const a = Math.max(1, Math.min(16, Math.floor(ringALength)))
  const b = Math.max(1, Math.min(16, Math.floor(ringBLength)))
  const hitA = i % a === 0
  const hitB = i % b === 0
  const b0 = genBase(base, scaleToUnit)
  const swing = amount * genMag(base, scaleToUnit)
  if (hitA && hitB) return b0 + swing            // peak
  if (hitB) return b0 + swing * 0.66             // high voice
  if (hitA) return b0 + swing * 0.33             // low voice (lift, not dip)
  return b0
}

/** Density → Wave. Continuous sine, remapped to [0, 1] so its trough
 *  sits AT the baseline rather than below. The wave's amplitude is
 *  driven by `amount`. */
export function waveValue(
  base: number,
  i: number,
  steps: number,
  amount: number,
  seed: number,
  scaleToUnit: boolean
): number {
  const s = Math.max(1, steps)
  const phase = (seed / 255) * Math.PI * 2
  const t = (i / s) * Math.PI * 2
  const wave = (Math.sin(t + phase) + 1) / 2
  return genBase(base, scaleToUnit) + wave * amount * genMag(base, scaleToUnit)
}

/** Cellular → Crowd. Crowdedness counts on-neighbours (0, 1, or 2)
 *  and maps to a [0, 1] lift — lonely cells stay at base, crowded
 *  cells get the full lift. Previously this was [-1, 0, +1] which
 *  sent lonely cells below the floor; reverted to a pure-positive
 *  excitement scale. */
export function crowdValue(
  base: number,
  i: number,
  row: number,
  steps: number,
  amount: number,
  scaleToUnit: boolean
): number {
  const s = Math.max(1, steps)
  const left = (row >>> ((i - 1 + s) % s)) & 1
  const right = (row >>> ((i + 1) % s)) & 1
  const neighbours = left + right // 0, 1, or 2
  const w = neighbours / 2 // 0, 0.5, or 1
  return genBase(base, scaleToUnit) + w * amount * genMag(base, scaleToUnit)
}

/** Drift → Terrain. Smooth 1D value-noise generated from the seed.
 *  Control points live in [0, 1] (was [-1, +1]) so the walker
 *  samples a non-negative height field — the hills rise above the
 *  baseline, never dig below it. */
export function terrainValue(
  base: number,
  i: number,
  steps: number,
  amount: number,
  seed: number,
  scaleToUnit: boolean
): number {
  const s = Math.max(1, steps)
  const ctrl = [
    stepHash(0, seed),
    stepHash(1, seed * 37 + 1),
    stepHash(2, seed * 61 + 2),
    stepHash(3, seed * 89 + 3)
  ]
  const u = (i / s) * (ctrl.length - 1)
  const lo = Math.floor(u)
  const hi = Math.min(lo + 1, ctrl.length - 1)
  const f = u - lo
  const t = f * f * (3 - 2 * f)
  const h = ctrl[lo] * (1 - t) + ctrl[hi] * t // [0, 1]
  return genBase(base, scaleToUnit) + h * amount * genMag(base, scaleToUnit)
}

/** Ratchet → Scatter. The first sub-pulse of every burst lands at
 *  the peak (base + amount·mag); subsequent sub-pulses scatter
 *  somewhere in [base, base + amount·mag] by a seeded hash. Previously
 *  the first sub-pulse was the base and the rest swung ± around it,
 *  which gave a constant 0 when base=0; the new shape always emits
 *  audible non-zero values. */
export function scatterValue(
  base: number,
  stepIdx: number,
  subIdx: number,
  subdiv: number,
  seed: number,
  amount: number,
  scaleToUnit: boolean
): number {
  const b0 = genBase(base, scaleToUnit)
  const mag = amount * genMag(base, scaleToUnit)
  // Peak at the start of every burst — the "loud first impact".
  if (subIdx <= 0 || subdiv <= 1) return b0 + mag
  // Subsequent sub-pulses land at a hashed [0, 1] fraction of the
  // peak height — never below baseline.
  const h = stepHash(stepIdx * 32 + subIdx, seed)
  return b0 + h * mag
}

/** Map the user-facing 0..100 `bounceDecay` knob to a physical
 *  coefficient of restitution e ∈ [0.40, 0.95]. The clamped range
 *  keeps the cycle musically useful — pure 0 would collapse to a
 *  single hit, pure 1 would never decay at all. */
export function bounceCoeff(bounceDecay: number): number {
  const v = Math.max(0, Math.min(100, bounceDecay)) / 100
  return 0.4 + v * 0.55
}

/** Duration of bounce-step `i` in ms, given the cycle's average
 *  step duration `stepDurMs`, total step count `steps`, and the
 *  decay coefficient.
 *
 *  Cycle total time = `stepDurMs * steps` (fixed by the existing
 *  Tempo / Step / BPM controls). Within that window, step i takes
 *  T₀ · e^i where T₀ is chosen so the geometric series sums to the
 *  cycle total. Result: bouncier balls (high e) get nearly-uniform
 *  intervals; dead bounces (low e) collapse to a long first beat
 *  followed by tightly clustered last beats — exactly the sound a
 *  real ball makes settling on the ground.
 */
export function bounceStepDuration(
  stepDurMs: number,
  steps: number,
  bounceDecay: number,
  i: number
): number {
  const s = Math.max(1, Math.floor(steps))
  const e = bounceCoeff(bounceDecay)
  const total = Math.max(1, stepDurMs) * s
  // Sum of geometric series e^0 + e^1 + ... + e^(s-1).
  // Closed form: (1 - e^s) / (1 - e). Falls back to s when e === 1.
  const sumGeom = e === 1 ? s : (1 - Math.pow(e, s)) / (1 - e)
  const t0 = total / sumGeom
  // Step i has duration t0 · e^i. Floor to 1 ms so the engine never
  // gets stuck on a zero-length step.
  return Math.max(1, t0 * Math.pow(e, ((i % s) + s) % s))
}

/** Bounce → Bounce. Step i's amplitude is the physical decay
 *  envelope ABOVE the baseline (not multiplicative-ON-baseline as
 *  before — that gave a hard 0 whenever base was 0). With base=0:
 *  step 0 lifts up by amount·mag, step 1 by amount·mag·e, step 2 by
 *  amount·mag·e², ... settling back down to base. Musically: a hand
 *  bouncing a ball — the FIRST impact is loud, each subsequent
 *  impact softer. */
export function bounceValue(
  base: number,
  i: number,
  bounceDecay: number,
  amount: number,
  scaleToUnit: boolean
): number {
  const e = bounceCoeff(bounceDecay) // [0.40, 0.95]
  const envelope = Math.pow(e, i) // [e^N, ..., e, 1] — decays toward 0
  return (
    genBase(base, scaleToUnit) +
    envelope * amount * genMag(base, scaleToUnit)
  )
}

/** Single dispatcher: given a cell's base value string and the
 *  sequencer mode + per-mode params, return the live string to send
 *  for the current step. Walks each token, applies the rule to
 *  numerics, leaves strings/bools alone, and rejoins with spaces.
 *
 *  Caller passes `subIdx + subdiv` for ratchet bursts (default 0/1
 *  means "no ratchet sub-pulse, treat the step normally"). */
export function generateStepValue(args: {
  baseRaw: string
  mode: SeqMode
  stepIdx: number
  steps: number
  amount: number    // 0..100 — caller does NOT need to pre-scale
  seed: number
  ringALength: number
  ringBLength: number
  cellRow: number
  bounceDecay?: number
  subIdx?: number
  subdiv?: number
  /** When the cell's `scaleToUnit` is on, generative rules treat
   *  the seed as a [0, 1] value and use 1 as the variation reference
   *  magnitude (so amount swings ±amount within [0, 1] instead of
   *  ±|base| which would saturate). Caller passes the cell's
   *  scaleToUnit flag — defaults to false to keep external usage
   *  backwards-compatible. */
  scaleToUnit?: boolean
}): string {
  const tokens = parseValueTokens(args.baseRaw)
  if (tokens.length === 0) return args.baseRaw
  const amount = Math.max(0, Math.min(100, args.amount)) / 100
  const subIdx = args.subIdx ?? 0
  const subdiv = args.subdiv ?? 1
  const stu = !!args.scaleToUnit
  const out = tokens.map((tok) => {
    const num = parseFloat(tok)
    if (!Number.isFinite(num)) return tok // string / bool — pass through
    let v: number
    switch (args.mode) {
      case 'steps':
        v = tideValue(num, args.stepIdx, args.steps, amount, args.seed, stu)
        break
      case 'euclidean':
        v = accentValue(num, args.stepIdx, args.steps, amount, stu)
        break
      case 'polyrhythm':
        v = voicingValue(
          num,
          args.stepIdx,
          args.ringALength,
          args.ringBLength,
          amount,
          stu
        )
        break
      case 'density':
        v = waveValue(num, args.stepIdx, args.steps, amount, args.seed, stu)
        break
      case 'cellular':
        v = crowdValue(num, args.stepIdx, args.cellRow, args.steps, amount, stu)
        break
      case 'drift':
        v = terrainValue(num, args.stepIdx, args.steps, amount, args.seed, stu)
        break
      case 'ratchet':
        v = scatterValue(
          num,
          args.stepIdx,
          subIdx,
          subdiv,
          args.seed,
          amount,
          stu
        )
        break
      case 'bounce':
        v = bounceValue(num, args.stepIdx, args.bounceDecay ?? 60, amount, stu)
        break
      case 'draw':
        // Draw mode resolves its own per-step values via
        // `generateDrawCurveFromValues` (called by the engine /
        // inspector preview, not this dispatcher). If a caller hits
        // this branch they want the raw base — flag explicitly so
        // future readers know it's intentional, not a fallthrough.
        v = num
        break
      default:
        v = num
    }
    // Generative outputs are ALWAYS clamped to ≥ 0 regardless of
    // scaleToUnit. The Tide / Accent / Voicing / Wave / Crowd /
    // Terrain / Scatter / Bounce metaphors are amplitude-shaped
    // around the user's base value; negative excursions don't carry
    // musical meaning (a Density gate going below the floor is
    // nonsense, a CC sweep below 0 is silently clipped by the
    // receiver, etc.). User explicitly never wants negatives.
    if (v < 0) v = 0
    // Under scaleToUnit also clamp to ≤ 1 so the per-mode swing
    // can't smuggle out of the [0, 1] window the cell promises
    // downstream. Above 1 with scaleToUnit off is fine — the user
    // may be sequencing a 0..255 RGB byte or a 0..10000 ms knob.
    if (stu && v > 1) v = 1
    // Format: keep integer-ish bases as integers, otherwise round to
    // 4 decimals so the read-only display stays compact.
    if (Number.isInteger(num) && Math.abs(v - Math.round(v)) < 0.0001) {
      return String(Math.round(v))
    }
    return Number(v.toFixed(4)).toString()
  })
  return out.join(' ')
}

// Generate a fully random HSL color, constrained to reasonable saturation/lightness
// so scenes stay visually distinct and legible on the dark theme.
export function randomSceneColor(): string {
  const h = Math.floor(Math.random() * 360)
  const s = 55 + Math.floor(Math.random() * 30) // 55..85
  const l = 50 + Math.floor(Math.random() * 15) // 50..65
  return hslToHex(h, s, l)
}

function hslToHex(h: number, s: number, l: number): string {
  s /= 100
  l /= 100
  const k = (n: number): number => (n + h / 30) % 12
  const a = s * Math.min(l, 1 - l)
  const f = (n: number): number => {
    const c = l - a * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1))
    return Math.round(c * 255)
  }
  const r = f(0).toString(16).padStart(2, '0')
  const g = f(8).toString(16).padStart(2, '0')
  const b = f(4).toString(16).padStart(2, '0')
  return `#${r}${g}${b}`
}

export function makeScene(index: number): Scene {
  return {
    id: uid('s_'),
    name: `Scene ${index + 1}`,
    color: randomSceneColor(),
    notes: '',
    durationSec: 5,
    nextMode: 'stop',
    multiplicator: 1,
    cells: {}
  }
}

// Plain orphan-Function track — what the old "Add Message" produced.
// Kept as the default makeTrack() so other code paths that already call
// makeTrack(idx) without thinking about Templates keep working.
export function makeTrack(index: number): Track {
  return {
    id: uid('t_'),
    name: `Parameter ${index + 1}`,
    kind: 'function'
  }
}

// Header-row track for an instantiated Template. Holds no clips; just
// owns the visual group of Function rows below it via parentTrackId.
export function makeTemplateTrack(template: InstrumentTemplate): Track {
  return {
    id: uid('t_'),
    name: template.name,
    kind: 'template',
    sourceTemplateId: template.id,
    defaultOscAddress: template.oscAddressBase,
    defaultDestIp: template.destIp,
    defaultDestPort: template.destPort
  }
}

// Function-row track instantiated from a Template's Function spec. The
// row inherits IP/port from the template unless the function overrides;
// the resolved OSC address is "<template.base>/<function.oscPath>" with
// a single slash between (or just function.oscPath when it starts with /).
export function makeFunctionTrack(
  template: InstrumentTemplate,
  fn: InstrumentFunction,
  parentTrackId: string
): Track {
  const base = template.oscAddressBase ?? ''
  const path = fn.oscPath ?? ''
  const resolvedOscAddress = path.startsWith('/')
    ? path
    : (base.endsWith('/') ? base.slice(0, -1) : base) + '/' + path
  return {
    id: uid('t_'),
    name: fn.name,
    kind: 'function',
    parentTrackId,
    sourceTemplateId: template.id,
    sourceFunctionId: fn.id,
    defaultOscAddress: resolvedOscAddress,
    defaultDestIp: fn.destIpOverride ?? template.destIp,
    defaultDestPort: fn.destPortOverride ?? template.destPort,
    // Snapshot the Function's argSpec onto the Track so the cell
    // editor can read it without round-tripping through the Pool
    // (which may be edited / replaced / hidden behind a draft).
    argSpec: fn.argSpec ? fn.argSpec.map((a) => ({ ...a })) : undefined
  }
}

// Build the initial Cell.value string for a freshly-created cell on
// a track that has an argSpec. Fixed args use their `fixed` value;
// editable args use `init` (or 0 / "" / false based on `type`). The
// resulting tokens are space-joined the same way the cell value
// parser expects.
export function buildInitialValueFromArgSpec(spec: ParamArgSpec[]): string {
  return spec
    .map((a) => {
      let v: number | string | boolean
      if (a.fixed !== undefined) v = a.fixed
      else if (a.init !== undefined) v = a.init
      else if (a.type === 'string') v = ''
      else if (a.type === 'bool') v = false
      else v = 0
      // Bools serialise as 0/1 — that's what Pd's `unpack f f f f`
      // expects (and what auto-detect emits as int OSC args).
      if (typeof v === 'boolean') return v ? '1' : '0'
      return String(v)
    })
    .join(' ')
}

// Default for "Add Parameter" inside a Template authoring flow. Name
// reads as "Parameter N" so newly-added child rows match the renamed
// vocabulary in the UI.
export function makeFunctionSpec(
  index: number,
  paramType: InstrumentFunction['paramType'] = 'float'
): InstrumentFunction {
  return {
    id: uid('fn_'),
    name: `Parameter ${index + 1}`,
    oscPath: `param${index + 1}`,
    paramType,
    nature: 'lin',
    streamMode: 'streaming',
    min: paramType === 'bool' ? 0 : 0,
    max: paramType === 'bool' ? 1 : 1,
    init: 0
  }
}

// Default for "New Template" in the Pool authoring flow.
export function makeTemplateSpec(index: number): InstrumentTemplate {
  return {
    id: uid('tpl_'),
    name: `Template ${index + 1}`,
    description: '',
    color: randomSceneColor(),
    destIp: '127.0.0.1',
    destPort: 9000,
    oscAddressBase: `/instr${index + 1}`,
    voices: 1,
    builtin: false,
    functions: [makeFunctionSpec(0)]
  }
}

// Default for "New Parameter" in the Pool's Parameters tab.
export function makeParameterSpec(
  index: number,
  paramType: InstrumentFunction['paramType'] = 'float'
): import('./types').ParameterTemplate {
  return {
    id: uid('par_'),
    name: `Parameter ${index + 1}`,
    color: randomSceneColor(),
    oscPath: `param${index + 1}`,
    destIp: '127.0.0.1',
    destPort: 9000,
    paramType,
    nature: 'lin',
    streamMode: 'streaming',
    min: paramType === 'bool' ? 0 : 0,
    max: paramType === 'bool' ? 1 : 1,
    init: 0
  }
}

// ─────────────────────────────────────────────────────────────────────
// Discovery → Instrument paramType inference. Used by the renderer
// when the user drags a Network-tab device into the Pool: we map the
// most-recently-observed OSC type tags at each address to one of our
// FunctionParamType enum values.
//
// Conservative — anything we can't classify becomes 'float'. The user
// can refine in the inspector after instantiation.
//
//   1× 'f' or 'd' / unknown numeric  → float
//   1× 'i'                           → int
//   1× 'T' or 'F'                    → bool
//   1× 's'                           → string
//   2× 'f' | 'd' | 'i'               → v2
//   3× 'f' | 'd' | 'i'               → v3
//   4× 'f' | 'd' | 'i'               → v4
//
// Colour detection (v3 with values in 0..1) requires runtime sample
// numbers — left out for now, the user can flip the type to 'colour'
// from the inspector.
// ─────────────────────────────────────────────────────────────────────
export function inferParamTypeFromArgTypes(
  argTypes: string[]
): 'bool' | 'int' | 'float' | 'v2' | 'v3' | 'v4' | 'string' {
  if (argTypes.length === 0) return 'float'
  if (argTypes.length === 1) {
    const t = argTypes[0]
    if (t === 'T' || t === 'F') return 'bool'
    if (t === 'i') return 'int'
    if (t === 's') return 'string'
    return 'float'
  }
  const allNumeric = argTypes.every((t) => t === 'f' || t === 'd' || t === 'i')
  if (!allNumeric) return 'float'
  if (argTypes.length === 2) return 'v2'
  if (argTypes.length === 3) return 'v3'
  if (argTypes.length === 4) return 'v4'
  return 'float'
}

// Pre-shipped Parameter templates — small palette of common building
// blocks the user can drag onto the sidebar as orphan Parameter rows
// without authoring a full Instrument first.
export function makeBuiltinParameters(): import('./types').ParameterTemplate[] {
  return [
    {
      id: 'par_rgb_light',
      name: 'RGB Light',
      description: 'Single RGB lamp / LED — three 0..255 channels.',
      color: '#ff5d6c',
      oscPath: 'rgb',
      destIp: '127.0.0.1',
      destPort: 9000,
      paramType: 'v3',
      nature: 'lin',
      streamMode: 'streaming',
      min: 0,
      max: 255,
      init: 0,
      unit: 'RGB',
      builtin: true
    },
    {
      id: 'par_knob',
      name: 'Knob',
      description: 'Generic continuous controller, 0..1 float.',
      color: '#5dd6c4',
      oscPath: 'knob',
      destIp: '127.0.0.1',
      destPort: 9000,
      paramType: 'float',
      nature: 'lin',
      streamMode: 'streaming',
      min: 0,
      max: 1,
      init: 0,
      builtin: true
    },
    {
      id: 'par_motor',
      name: 'Motor',
      description: 'Bipolar motor speed, -1..1.',
      color: '#9b6dff',
      oscPath: 'motor',
      destIp: '127.0.0.1',
      destPort: 9000,
      paramType: 'float',
      nature: 'lin',
      streamMode: 'streaming',
      min: -1,
      max: 1,
      init: 0,
      unit: 'rev/s',
      builtin: true
    },
    {
      id: 'par_button',
      name: 'Button',
      description: 'Discrete on/off — sends bool / int events.',
      color: '#f7c948',
      oscPath: 'button',
      destIp: '127.0.0.1',
      destPort: 9000,
      paramType: 'bool',
      nature: 'lin',
      streamMode: 'discrete',
      min: 0,
      max: 1,
      init: 0,
      builtin: true
    },
    {
      id: 'par_xy',
      name: 'XY Pad',
      description: 'Two-axis pad as a v2.',
      color: '#7ec8e3',
      oscPath: 'xy',
      destIp: '127.0.0.1',
      destPort: 9000,
      paramType: 'v2',
      nature: 'lin',
      streamMode: 'streaming',
      min: 0,
      max: 1,
      init: 0.5,
      builtin: true
    },
    // ── MIDI Parameter blueprints ──────────────────────────────
    // Each ships with `midiOut` defaults pre-wired so dragging one
    // onto the sidebar instantiates a cell with MIDI ready to go
    // (user still picks the actual port from the dropdown). The
    // OSC fields stay populated too — both transports fire in
    // parallel if the user enables both. To use as MIDI-only,
    // just clear the OSC address on the resulting cell.
    {
      id: 'par_midi_cc',
      name: 'MIDI CC',
      description:
        'Generic MIDI Control Change. Continuous stream — every tick maps the value to 0..127 and sends.',
      color: '#7ad6ff',
      oscPath: 'cc',
      destIp: '127.0.0.1',
      destPort: 9000,
      paramType: 'int',
      nature: 'lin',
      streamMode: 'streaming',
      min: 0,
      max: 127,
      init: 64,
      unit: 'CC',
      builtin: true,
      midiOut: {
        enabled: true,
        portName: '',
        channel: 1,
        kind: 'cc',
        cc: 1,
        noteMode: 'velocity',
        gateLengthMs: 0
      }
    },
    {
      id: 'par_midi_note',
      name: 'MIDI Note',
      description:
        'Generic MIDI Note. Note On at every trigger / sequencer step; Note Off at next trigger, cell stop, scene change, or after Gate ms.',
      color: '#ff9d5d',
      oscPath: 'note',
      destIp: '127.0.0.1',
      destPort: 9000,
      paramType: 'int',
      nature: 'lin',
      streamMode: 'discrete',
      min: 0,
      max: 127,
      init: 60, // C4
      unit: 'note',
      builtin: true,
      midiOut: {
        enabled: true,
        portName: '',
        channel: 1,
        kind: 'note',
        noteMode: 'velocity',
        gateLengthMs: 0
      }
    },
    {
      id: 'par_midi_cc_pair',
      name: 'MIDI CC Pair (X/Y)',
      description:
        'Two-CC bundle — drives an XY-pad-style mapping. Sends two CCs in lockstep.',
      color: '#7ec8e3',
      oscPath: 'cc/xy',
      destIp: '127.0.0.1',
      destPort: 9000,
      paramType: 'v2',
      nature: 'lin',
      streamMode: 'streaming',
      min: 0,
      max: 127,
      init: 64,
      unit: 'CC pair',
      builtin: true,
      argSpec: [
        { name: 'x', type: 'int', min: 0, max: 127, init: 64 },
        { name: 'y', type: 'int', min: 0, max: 127, init: 64 }
      ],
      midiOut: {
        enabled: true,
        portName: '',
        channel: 1,
        kind: 'cc',
        cc: 1,
        noteMode: 'velocity',
        gateLengthMs: 0
      }
    },
    {
      id: 'par_midi_drum',
      name: 'MIDI Drum Pad',
      description:
        'Single drum trigger on channel 10 (GM drum convention). Value field = note number (36 kick / 38 snare / etc.); the cell value is the velocity.',
      color: '#f7c948',
      oscPath: 'drum',
      destIp: '127.0.0.1',
      destPort: 9000,
      paramType: 'int',
      nature: 'lin',
      streamMode: 'discrete',
      min: 0,
      max: 127,
      init: 36, // GM kick
      unit: 'note',
      builtin: true,
      midiOut: {
        enabled: true,
        portName: '',
        channel: 10,
        kind: 'note',
        noteMode: 'velocity',
        gateLengthMs: 80
      }
    },
    {
      id: 'par_midi_daw_macro_bank',
      name: 'MIDI DAW Macro Bank',
      description:
        '8-CC bundle mapped to Ableton/Logic macro slots (CCs 20..27). Drives all eight macros in lockstep — pin individual slots to freeze them.',
      color: '#a87cff',
      oscPath: 'macro/bank',
      destIp: '127.0.0.1',
      destPort: 9000,
      paramType: 'int',
      nature: 'lin',
      streamMode: 'streaming',
      min: 0,
      max: 127,
      init: 0,
      unit: 'macro',
      builtin: true,
      argSpec: Array.from({ length: 8 }, (_, i) => ({
        name: `m${i + 1}`,
        type: 'int' as const,
        min: 0,
        max: 127,
        init: 0
      })),
      midiOut: {
        enabled: true,
        portName: '',
        channel: 1,
        kind: 'cc',
        cc: 20, // bank starts at CC 20; engine sends only one CC for now,
                // but with the argSpec the user can sequence each slot
                // independently and the cell-level multi-arg pinning
                // works as expected.
        noteMode: 'velocity',
        gateLengthMs: 0
      }
    }
  ]
}

// Pre-shipped templates. Deliberately small + concrete — these
// double as documentation of the Pool concept. `builtin: true` makes
// them read-only in the Inspector but still cloneable.
export function makeBuiltinPool(): Pool {
  return {
    parameters: makeBuiltinParameters(),
    templates: [
      {
        id: 'tpl_octocosme',
        name: 'OCTOCOSME',
        description:
          'Octocosme V9 — sends OSC to the Pure Data software (port 1986). ' +
          'Each Parameter is a complete bundle the patch\'s else/osc.route ' +
          'receivers expect. The Teensy hardware controller and the compositor ' +
          'can both feed the same patch in parallel without conflict; ' +
          'just don\'t fight over the same control at the same moment. ' +
          'Every bundle prepends a 2-arg [sender, timestamp] header (the patch ' +
          'discards them via `list split 2`); the cell editor handles the ' +
          'header automatically — you only see the musical fields.',
        color: '#ff7a3d',
        destIp: '127.0.0.1',
        destPort: 1986,
        oscAddressBase: '',
        voices: 1,
        builtin: true,
        functions: [
          {
            id: 'fn_octo_voice_pots',
            name: 'Voice Pots',
            oscPath: '/A/strips/pots',
            paramType: 'float',
            nature: 'lin',
            streamMode: 'streaming',
            min: 0,
            max: 1,
            init: 0.5,
            notes:
              'HAUTEUR1-4, MODA1-4, MODB1-4 — per-voice pitch + ModA + ModB ' +
              '(0–1 each). Voices 1–4.',
            argSpec: [
              { name: 'sender', type: 'string', fixed: 'compositor' },
              { name: 'timestamp', type: 'int', fixed: 0 },
              { name: 'HAUTEUR1', type: 'float', min: 0, max: 1, init: 0.5 },
              { name: 'HAUTEUR2', type: 'float', min: 0, max: 1, init: 0.5 },
              { name: 'HAUTEUR3', type: 'float', min: 0, max: 1, init: 0.5 },
              { name: 'HAUTEUR4', type: 'float', min: 0, max: 1, init: 0.5 },
              { name: 'MODA1', type: 'float', min: 0, max: 1, init: 0 },
              { name: 'MODA2', type: 'float', min: 0, max: 1, init: 0 },
              { name: 'MODA3', type: 'float', min: 0, max: 1, init: 0 },
              { name: 'MODA4', type: 'float', min: 0, max: 1, init: 0 },
              { name: 'MODB1', type: 'float', min: 0, max: 1, init: 0 },
              { name: 'MODB2', type: 'float', min: 0, max: 1, init: 0 },
              { name: 'MODB3', type: 'float', min: 0, max: 1, init: 0 },
              { name: 'MODB4', type: 'float', min: 0, max: 1, init: 0 }
            ]
          },
          {
            id: 'fn_octo_voice_volumes',
            name: 'Voice Volumes',
            oscPath: '/B/strips/pots',
            paramType: 'float',
            nature: 'lin',
            streamMode: 'streaming',
            min: 0,
            max: 1,
            init: 0.5,
            notes: 'VOLUME1-4 — per-voice gain (0–1).',
            argSpec: [
              { name: 'sender', type: 'string', fixed: 'compositor' },
              { name: 'timestamp', type: 'int', fixed: 0 },
              { name: 'VOLUME1', type: 'float', min: 0, max: 1, init: 0.5 },
              { name: 'VOLUME2', type: 'float', min: 0, max: 1, init: 0.5 },
              { name: 'VOLUME3', type: 'float', min: 0, max: 1, init: 0.5 },
              { name: 'VOLUME4', type: 'float', min: 0, max: 1, init: 0.5 }
            ]
          },
          {
            id: 'fn_octo_voice_instruments',
            name: 'Voice Instruments',
            oscPath: '/A/strips/switches',
            paramType: 'int',
            nature: 'lin',
            streamMode: 'discrete',
            min: 0,
            max: 7,
            init: 0,
            notes:
              'INSTRU1-4 — picks one of 8 instruments per voice ' +
              '(0=SuperMorpher, 1=MeloWave, 2=TremWave, 3=VibeWave, ' +
              '4=Electric, 5=ResoNoise, 6=TremNoise, 7=RandomNoise).',
            argSpec: [
              { name: 'sender', type: 'string', fixed: 'compositor' },
              { name: 'timestamp', type: 'int', fixed: 0 },
              { name: 'INSTRU1', type: 'int', min: 0, max: 7, init: 0 },
              { name: 'INSTRU2', type: 'int', min: 0, max: 7, init: 0 },
              { name: 'INSTRU3', type: 'int', min: 0, max: 7, init: 0 },
              { name: 'INSTRU4', type: 'int', min: 0, max: 7, init: 0 }
            ]
          },
          {
            id: 'fn_octo_voice_kills',
            name: 'Voice Kills',
            oscPath: '/B/strips/switches',
            paramType: 'bool',
            nature: 'lin',
            streamMode: 'discrete',
            min: 0,
            max: 1,
            init: 0,
            notes: 'KILL1-4 — bool flag per voice.',
            argSpec: [
              { name: 'sender', type: 'string', fixed: 'compositor' },
              { name: 'timestamp', type: 'int', fixed: 0 },
              { name: 'KILL1', type: 'bool', init: false },
              { name: 'KILL2', type: 'bool', init: false },
              { name: 'KILL3', type: 'bool', init: false },
              { name: 'KILL4', type: 'bool', init: false }
            ]
          },
          {
            id: 'fn_octo_global_fx',
            name: 'Global FX',
            oscPath: '/A/global/pots',
            paramType: 'float',
            nature: 'lin',
            streamMode: 'streaming',
            min: 0,
            max: 1,
            init: 0.5,
            notes: 'Master FX chain (0–1 each).',
            argSpec: [
              { name: 'sender', type: 'string', fixed: 'compositor' },
              { name: 'timestamp', type: 'int', fixed: 0 },
              { name: 'VOLUME', type: 'float', min: 0, max: 1, init: 0.5 },
              { name: 'FILTRE', type: 'float', min: 0, max: 1, init: 0.5 },
              { name: 'MOUVEMENT', type: 'float', min: 0, max: 1, init: 0 },
              { name: 'DELAI', type: 'float', min: 0, max: 1, init: 0 },
              { name: 'AMBIANCE', type: 'float', min: 0, max: 1, init: 0.2 },
              { name: 'DISTORSION', type: 'float', min: 0, max: 1, init: 0 }
            ]
          },
          {
            id: 'fn_octo_global_notes',
            name: 'Notes / Variation / Vitesse',
            oscPath: '/B/global/pots',
            paramType: 'float',
            nature: 'lin',
            streamMode: 'streaming',
            min: 0,
            max: 1,
            init: 0,
            notes: 'Global note generation / arpeggiation.',
            argSpec: [
              { name: 'sender', type: 'string', fixed: 'compositor' },
              { name: 'timestamp', type: 'int', fixed: 0 },
              { name: 'NOTES', type: 'float', min: 0, max: 1, init: 0.5 },
              { name: 'VARIATION', type: 'float', min: 0, max: 1, init: 0 },
              { name: 'VITESSE', type: 'float', min: 0, max: 1, init: 0 }
            ]
          },
          {
            id: 'fn_octo_intervalle',
            name: 'Intervalle',
            oscPath: '/A/global/switches',
            paramType: 'int',
            nature: 'lin',
            streamMode: 'discrete',
            min: 0,
            max: 15,
            init: 0,
            notes: 'INTERVALLE — 16 chord/scale presets (0–15).',
            argSpec: [
              { name: 'sender', type: 'string', fixed: 'compositor' },
              { name: 'timestamp', type: 'int', fixed: 0 },
              { name: 'INTERVALLE', type: 'int', min: 0, max: 15, init: 0 }
            ]
          },
          {
            id: 'fn_octo_modes',
            name: 'Global / Touch Mode',
            oscPath: '/B/global/switches',
            paramType: 'bool',
            nature: 'lin',
            streamMode: 'discrete',
            min: 0,
            max: 1,
            init: 0,
            notes: 'GLOBAL_MODE + TOUCH_MODE — bool flags.',
            argSpec: [
              { name: 'sender', type: 'string', fixed: 'compositor' },
              { name: 'timestamp', type: 'int', fixed: 0 },
              { name: 'GLOBAL_MODE', type: 'bool', init: false },
              { name: 'TOUCH_MODE', type: 'bool', init: false }
            ]
          }
        ]
      },
      {
        id: 'tpl_xyz',
        name: 'Generic XYZ',
        description: 'Three-axis pad. Common controller for any X/Y/Z device.',
        color: '#5dd6c4',
        destIp: '127.0.0.1',
        destPort: 9000,
        oscAddressBase: '/xyz',
        voices: 1,
        builtin: true,
        functions: [
          {
            id: 'fn_xyz_x',
            name: 'X',
            oscPath: 'x',
            paramType: 'float',
            nature: 'lin',
            streamMode: 'streaming',
            min: 0,
            max: 1,
            init: 0.5,
            unit: ''
          },
          {
            id: 'fn_xyz_y',
            name: 'Y',
            oscPath: 'y',
            paramType: 'float',
            nature: 'lin',
            streamMode: 'streaming',
            min: 0,
            max: 1,
            init: 0.5
          },
          {
            id: 'fn_xyz_z',
            name: 'Z',
            oscPath: 'z',
            paramType: 'float',
            nature: 'lin',
            streamMode: 'streaming',
            min: 0,
            max: 1,
            init: 0.5
          }
        ]
      },
      {
        id: 'tpl_pandore',
        name: 'Pandore',
        description: 'Pandore digital instrument prototyping platform — placeholder until DECLARE import lands.',
        color: '#9b6dff',
        destIp: '127.0.0.1',
        destPort: 9001,
        oscAddressBase: '/pandore',
        voices: 1,
        builtin: true,
        functions: [
          {
            id: 'fn_pandore_value',
            name: 'Value',
            oscPath: 'value',
            paramType: 'float',
            nature: 'lin',
            streamMode: 'streaming',
            min: 0,
            max: 1,
            init: 0
          }
        ]
      },
      // ── MIDI Instrument: generic 8-CC controller ────────────────
      // A starter "Instrument" wired to 8 MIDI CCs on channel 1.
      // Matches the layout of MIDI fighter / launch-style desktop
      // controllers — drop onto the sidebar and pick the port in
      // each child cell to control eight CCs in parallel. Specific
      // controllers (LaunchControl XL, MIDI Fighter, etc.) can be
      // saved by the user as their own Templates from this base.
      {
        id: 'tpl_midi_cc8',
        name: 'MIDI 8× CC',
        description:
          'Eight MIDI CCs on channel 1 (CC 21–28). Generic starter for any 8-knob / 8-fader controller — duplicate to retarget at a specific device (LaunchControl XL, MIDI Fighter, etc.).',
        color: '#7ad6ff',
        destIp: '127.0.0.1',
        destPort: 9000,
        // OSC base intentionally empty — this template is MIDI-first.
        // Cells can still emit OSC if the user types an address.
        oscAddressBase: '',
        voices: 1,
        builtin: true,
        functions: Array.from({ length: 8 }, (_, i) => ({
          id: `fn_midi_cc8_${i + 1}`,
          name: `CC ${21 + i}`,
          oscPath: `cc${21 + i}`,
          paramType: 'int' as const,
          nature: 'lin' as const,
          streamMode: 'streaming' as const,
          min: 0,
          max: 127,
          init: 64,
          unit: 'CC',
          midiOut: {
            enabled: true,
            portName: '',
            channel: 1,
            kind: 'cc' as const,
            cc: 21 + i,
            noteMode: 'velocity' as const,
            gateLengthMs: 0
          }
        }))
      }
    ]
  }
}

export function makeEmptySession(): Session {
  // Default new session — one Scene + one Instrument with one child
  // Parameter. The Instrument is a draft Template (not surfaced in the
  // Pool until the user runs Save as Template); the Parameter is its
  // sole child Function row. Mirrors what `addInstrumentRow` produces
  // so the empty-session shape is identical to what the user gets by
  // pressing Ctrl+T on a blank app.
  const scene = makeScene(0)
  const draftTpl: InstrumentTemplate = {
    id: 'tpl_user_default',
    name: 'Instrument 1',
    description: '',
    color: randomSceneColor(),
    destIp: '127.0.0.1',
    destPort: 9000,
    oscAddressBase: '/instr1',
    voices: 1,
    builtin: false,
    draft: true,
    functions: [makeFunctionSpec(0)]
  }
  const headerRow: Track = {
    id: 't_default_header',
    name: draftTpl.name,
    kind: 'template',
    sourceTemplateId: draftTpl.id,
    defaultOscAddress: draftTpl.oscAddressBase,
    defaultDestIp: draftTpl.destIp,
    defaultDestPort: draftTpl.destPort
  }
  const childRow = makeFunctionTrack(draftTpl, draftTpl.functions[0], headerRow.id)
  const builtinPool = makeBuiltinPool()
  const session: Session = {
    version: 1,
    name: 'Untitled',
    tickRateHz: 120,
    globalBpm: 120,
    sequenceLength: 32,
    defaultOscAddress: '/dataflou/value',
    defaultDestIp: '127.0.0.1',
    defaultDestPort: 9000,
    tracks: [headerRow, childRow],
    scenes: [scene],
    sequence: new Array(128).fill(null),
    focusedSceneId: scene.id,
    midiInputName: null,
    // MIDI output globally ON by default — the engine only touches
    // the native module for cells whose own `midiOut.enabled` is
    // true, so an empty session pays zero MIDI cost even though the
    // global toggle is on.
    midiEnabled: true,
    metaController: makeMetaController(),
    pool: { ...builtinPool, templates: [...builtinPool.templates, draftTpl] }
  }
  // Pre-populate a clip on the default scene for the child Parameter
  // row so the user has something to trigger immediately. The
  // sequence array stays empty — slots are filled explicitly.
  scene.cells[childRow.id] = makeCell({
    destIp: session.defaultDestIp,
    destPort: session.defaultDestPort,
    oscAddress: session.defaultOscAddress
  })
  return session
}

export function autoDetectOscArg(
  raw: string
): { type: 'i' | 'f' | 's' | 'T' | 'F'; value: number | string | boolean } {
  const s = raw.trim()
  if (s === '') return { type: 's', value: '' }
  if (/^(true|TRUE|True)$/.test(s)) return { type: 'T', value: true }
  if (/^(false|FALSE|False)$/.test(s)) return { type: 'F', value: false }
  if (/^-?\d+$/.test(s)) {
    const n = Number(s)
    if (Number.isSafeInteger(n) && n >= -2147483648 && n <= 2147483647) {
      return { type: 'i', value: n }
    }
  }
  if (/^-?(\d+\.\d*|\.\d+|\d+)([eE][-+]?\d+)?$/.test(s)) {
    const n = Number(s)
    if (Number.isFinite(n)) return { type: 'f', value: n }
  }
  return { type: 's', value: raw }
}

export function readNumber(raw: string): number | null {
  const s = raw.trim()
  if (s === '') return null
  if (/^(true|TRUE|True)$/.test(s)) return 1
  if (/^(false|FALSE|False)$/.test(s)) return 0
  const n = Number(s)
  return Number.isFinite(n) ? n : null
}

// ---------- Meta Controller ----------

/** Number of quantization levels for the 'step' curve. */
export const META_STEP_COUNT = 8

/**
 * Map a normalized position t ∈ [0, 1] into [min, max] using the given curve.
 *
 * Each curve except `geom` is a SHAPE on the 0..1 axis; the shaped value is
 * then lerped linearly into [min, max]. `geom` is a true log-space mapping
 * that requires both endpoints on the same side of zero; otherwise it falls
 * back to the `exp` shape so the curve still bends visibly.
 *
 *   linear     y = t                              straight
 *   log        y = ln(1+9·t) / ln(10)             concave down — fast rise, slow tail
 *   exp        y = (e^(3t)−1) / (e^3−1)           concave up — slow rise, fast tail
 *   geom       y = min·(max/min)^t                log-space / const-ratio (freq, amp)
 *   easeIn     y = t²                             gentle ease-in (mirror of easeOut)
 *   easeOut    y = 1 − (1−t)²                     gentle ease-out (mirror of easeIn)
 *   cubic      y = t³                             stronger ease-in than easeIn
 *   sqrt       y = √t                             stronger ease-out than easeOut
 *   sigmoid    logistic S, k=6                    slow → fast → slow (even ends)
 *   smoothstep y = 3t² − 2t³                      gentler S than sigmoid (Hermite)
 *   db         60 dB audio taper                  perceived-linear volume
 *   gamma      y = t^2.2                          perceived-linear brightness (sRGB-ish)
 *   step       quantize to META_STEP_COUNT levels snap to grid
 *   invert     y = 1 − t                          shorthand for flipping a range
 *
 * Every curve is monotone t=0 → y=0 and t=1 → y=1 (except `invert` which is
 * the opposite by design and `geom` which bypasses the shape step entirely).
 * So `min + y·(max−min)` always lands on `min` at t=0 and `max` at t=1
 * (or vice-versa for invert / descending ranges).
 */
export function scaleMetaValue(t: number, min: number, max: number, curve: MetaCurve): number {
  const tc = t < 0 ? 0 : t > 1 ? 1 : t
  if (min === max) return min
  // Geom is log-space — not a shape on t, bypass the lerp.
  if (curve === 'geom' && ((min > 0 && max > 0) || (min < 0 && max < 0))) {
    return min * Math.pow(max / min, tc)
  }
  let shaped: number
  switch (curve) {
    case 'linear':
      shaped = tc
      break
    case 'log': {
      const k = 9
      shaped = Math.log(1 + k * tc) / Math.log(1 + k)
      break
    }
    case 'easeIn':
      shaped = tc * tc
      break
    case 'easeOut': {
      const u = 1 - tc
      shaped = 1 - u * u
      break
    }
    case 'cubic':
      shaped = tc * tc * tc
      break
    case 'sqrt':
      shaped = Math.sqrt(tc)
      break
    case 'sigmoid': {
      // Logistic curve centred at t=0.5, normalized so y(0)=0 and y(1)=1.
      const k = 6
      const s = (x: number): number => 1 / (1 + Math.exp(-k * (x - 0.5)))
      const s0 = s(0)
      const s1 = s(1)
      shaped = (s(tc) - s0) / (s1 - s0)
      break
    }
    case 'smoothstep':
      shaped = tc * tc * (3 - 2 * tc)
      break
    case 'db': {
      // −60 dB floor at t=0, 0 dB (unity) at t=1.
      // Raw:   r(t) = 10^(−3(1−t))       r(0) = 10^−3 = 0.001, r(1) = 1
      // Normalize so r(0) → 0:
      const r = Math.pow(10, -3 * (1 - tc))
      const floor = Math.pow(10, -3)
      shaped = (r - floor) / (1 - floor)
      break
    }
    case 'gamma':
      shaped = Math.pow(tc, 2.2)
      break
    case 'step': {
      // Quantize to META_STEP_COUNT distinct output levels evenly spread
      // across [0, 1]. Clamping tc just below 1 keeps the top step
      // reachable without floor(1 * N) producing N (out of range).
      const N = META_STEP_COUNT
      const clamped = tc >= 1 ? N - 1 : Math.floor(tc * N)
      shaped = clamped / (N - 1)
      break
    }
    case 'invert':
      shaped = 1 - tc
      break
    case 'exp':
    case 'geom': // geom with endpoints spanning zero → fall through to exp shape
    default: {
      const k = 3
      shaped = (Math.exp(k * tc) - 1) / (Math.exp(k) - 1)
      break
    }
  }
  return min + shaped * (max - min)
}

/** Default smoothing for Meta Controller knobs (ms). 10 ms is enough to mask
 * MIDI's 1/127 quantization without adding perceptible lag. Max ~1 s. */
export const META_DEFAULT_SMOOTH_MS = 10
export const META_MAX_SMOOTH_MS = 1000

export function makeMetaKnob(index: number): MetaKnob {
  return {
    name: `Knob ${index + 1}`,
    min: 0,
    max: 1,
    curve: 'linear',
    value: 0,
    smoothMs: META_DEFAULT_SMOOTH_MS,
    destinations: [
      {
        destIp: '127.0.0.1',
        destPort: 9000,
        oscAddress: `/meta/${index + 1}`,
        enabled: true
      }
    ]
  }
}

// Meta Controller bar height clamps.
// The default starts tight — knobs + first destination row fit without any
// wasted vertical space. Users can drag the bottom edge to grow it. Min is
// generous enough to still show the knob bank and the first row of details.
export const META_DEFAULT_HEIGHT = 128
export const META_MIN_HEIGHT = 108
export const META_MAX_HEIGHT = 520

export function makeMetaController(): MetaController {
  return {
    visible: false,
    selectedKnob: 0,
    height: META_DEFAULT_HEIGHT,
    knobs: Array.from({ length: META_KNOB_COUNT }, (_, i) => makeMetaKnob(i))
  }
}
