import type {
  ArpMode,
  ArpeggiatorParams,
  Cell,
  EnvelopeParams,
  MetaController,
  MetaCurve,
  MetaKnob,
  Modulation,
  MultMode,
  RampParams,
  RandomParams,
  Scene,
  SequencerParams,
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
  totalMs: 1000
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
  random: { ...DEFAULT_RANDOM }
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
  stepValues: ['0', '0', '0', '0', '0', '0', '0', '0', '', '', '', '', '', '', '', '']
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
      random: { ...DEFAULT_RANDOM }
    },
    sequencer: {
      ...DEFAULT_SEQUENCER,
      stepValues: [...DEFAULT_SEQUENCER.stepValues]
    },
    scaleToUnit: false
  }
}

// Value-string parsing helpers.
// Values are space-separated tokens; non-numeric tokens pass through as
// string/bool OSC args. Capped at MAX_VALUE_TOKENS.
export function parseValueTokens(raw: string, max = 16): string[] {
  return raw.trim().split(/\s+/).filter((s) => s.length > 0).slice(0, max)
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

export function makeTrack(index: number): Track {
  return {
    id: uid('t_'),
    name: `Message ${index + 1}`
  }
}

export function makeEmptySession(): Session {
  const track = makeTrack(0)
  const scene = makeScene(0)
  const session: Session = {
    version: 1,
    name: 'Untitled',
    tickRateHz: 120,
    globalBpm: 120,
    sequenceLength: 32,
    defaultOscAddress: '/dataflou/value',
    defaultDestIp: '127.0.0.1',
    defaultDestPort: 9000,
    tracks: [track],
    scenes: [scene],
    sequence: new Array(128).fill(null),
    focusedSceneId: scene.id,
    midiInputName: null,
    metaController: makeMetaController()
  }
  session.sequence[0] = scene.id
  scene.cells[track.id] = makeCell({
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
