// Bespoke visualisations for the modulator panel — one per
// modulator type. Each visual is a small SVG that reacts to the
// modulator's parameters in real time, so the user can see what a
// shape/depth/rate change actually does to the signal.

import type { ReactNode } from 'react'
import { buildArpLadder, buildArpPattern, effectiveLfoHz } from '@shared/factory'
import type {
  ArpeggiatorParams,
  ChaosParams,
  EnvelopeParams,
  LfoShape,
  Modulation,
  RampParams,
  RandomParams,
  SampleHoldParams,
  SlewParams
} from '@shared/types'

// ─────────────────────────────────────────────────────────────────
// LFO visual — shows one full period of the selected waveform.
// Reactive to:
//   • Shape (sine, triangle, sawtooth, square, rndStep, rndSmooth)
//   • Depth (vertical amplitude — taller = more wobble)
//   • Mode  (bipolar = -1..+1 around centre, unipolar = 0..+1)
//   • Rate  (we show ~2 cycles when rate's "fast", ~0.5 when "slow"
//     so the visual gives a sense of cycle density)
// ─────────────────────────────────────────────────────────────────

export function LfoVisual({
  modulation,
  globalBpm
}: {
  modulation: Modulation
  /** Session global BPM — needed so the visual reacts to non-Free
   *  sync modes (BPM-synced + division). When the modulator is
   *  synced to a beat division, the effective rate is derived from
   *  globalBpm × division — we want the displayed cycle count to
   *  reflect THAT, not the dormant rateHz field. */
  globalBpm: number
}): JSX.Element {
  const W = 200
  const H = 56
  const padX = 4
  const padY = 4
  const midY = H / 2
  // Depth controls amplitude of the visual ON TOP of a small baseline
  // so even depth=0 shows a flat line (not nothing).
  const depth01 = Math.max(0, Math.min(1, modulation.depthPct / 100))
  const amp = padY + depth01 * ((H - padY * 2) / 2 - 1)
  // Use the engine's effectiveLfoHz so the visual reacts to ALL sync
  // modes (Free / BPM-synced + division). Without this it would only
  // respond to the Free-mode rateHz slider.
  const effHz = effectiveLfoHz(modulation, globalBpm)
  const cycles = Math.max(
    0.5,
    Math.min(4, Math.log10(Math.max(0.1, effHz) + 1) * 1.7)
  )
  // Sample the shape at ~120 points across the visible width.
  const N = 120
  const samples: Array<{ x: number; y: number }> = []
  // Deterministic random sequence for rndStep / rndSmooth shapes so
  // the visual is stable across renders (not flickering on each
  // re-render). Mulberry32-style seeded off the effective rate so
  // changing rate (even via BPM division) "rolls" the noise.
  const rng = mulberry(Math.floor(Math.max(0.1, effHz) * 100) * 9301 + 49297)
  // For random shapes we ALWAYS want a healthy number of visible
  // stairs even at low cycle counts (low effHz, slow BPM-sync
  // divisions). Without this floor, cycles<1 collapsed the visual
  // to a single flat random value. We keep at least 8 visible stairs
  // for rnd shapes, and let cycles drive density at higher rates.
  const isRandom =
    modulation.shape === 'rndStep' ||
    modulation.shape === 'rndSmooth' ||
    modulation.shape === 'spastic'
  const visibleStairs = isRandom ? Math.max(8, cycles * 8) : cycles * 8
  const rndSteps = Math.max(2, Math.round(visibleStairs))
  // Spastic samples to exactly ±1 — every other rnd shape is continuous
  // [-1, 1] floats. Visual matches the wire shape so the user can see
  // the binary stair pattern instead of a noisy float curve.
  const rndVals =
    modulation.shape === 'spastic'
      ? Array.from({ length: rndSteps + 2 }, () => (rng() < 0.5 ? -1 : 1))
      : Array.from({ length: rndSteps + 2 }, () => rng() * 2 - 1)
  for (let i = 0; i < N; i++) {
    const t = i / (N - 1)
    // For rnd shapes, the "global" time used to step through rndVals
    // is t × visibleStairs (always producing a visible stair pattern).
    // For other shapes, fall back to t × cycles so the sine/triangle
    // cadence still reflects the effective rate.
    const globalT = isRandom ? t * visibleStairs : t * cycles
    const p = (isRandom ? t * cycles : t * cycles) % 1
    let v = lfoSample(modulation.shape, p, rndVals, globalT)
    if (modulation.mode === 'unipolar') {
      // Map [-1, 1] → [0, 1] then re-centre so visual baseline is
      // at the bottom of the wobble band, not the middle.
      v = (v + 1) / 2
    }
    const x = padX + t * (W - padX * 2)
    const y =
      modulation.mode === 'unipolar'
        ? H - padY - v * (H - padY * 2)
        : midY - v * amp
    samples.push({ x, y })
  }
  const path = samples
    .map((s, i) => `${i === 0 ? 'M' : 'L'} ${s.x.toFixed(2)} ${s.y.toFixed(2)}`)
    .join(' ')

  return (
    <div className="mt-2 flex flex-col items-center gap-1">
      <svg
        width={W}
        height={H}
        viewBox={`0 0 ${W} ${H}`}
        style={{
          background: 'rgb(var(--c-input-bg) / 0.7)',
          border: '1px solid rgb(var(--c-border) / 0.7)',
          borderRadius: 6
        }}
      >
        {/* Centre line (bipolar) / floor line (unipolar) */}
        <line
          x1={padX}
          y1={modulation.mode === 'unipolar' ? H - padY : midY}
          x2={W - padX}
          y2={modulation.mode === 'unipolar' ? H - padY : midY}
          stroke="rgb(var(--c-border) / 0.7)"
          strokeWidth={1}
          strokeDasharray="2 3"
        />
        {/* Waveform — gradient stroke warm→cool to echo the rest of
            the visuals. Wider stroke at full depth, thinner when
            shallow, so the line itself encodes "intensity". */}
        <defs>
          <linearGradient id="rc-lfo-stroke" x1="0" y1="0" x2="1" y2="0">
            <stop offset="0%" stopColor="rgb(var(--c-accent))" />
            <stop offset="100%" stopColor="rgb(var(--c-accent2))" />
          </linearGradient>
        </defs>
        <path
          d={path}
          fill="none"
          stroke="url(#rc-lfo-stroke)"
          strokeWidth={1.5 + depth01 * 1.5}
          strokeLinecap="round"
          strokeLinejoin="round"
          style={{
            transition: 'stroke-width 220ms ease-out',
            filter: `drop-shadow(0 0 ${2 + depth01 * 4}px rgb(var(--c-accent) / ${0.3 + depth01 * 0.4}))`
          }}
        />
      </svg>
    </div>
  )
}

/** Sample one period of an LFO shape at phase p ∈ [0, 1). For random
 *  shapes, takes a precomputed `rndVals` table and a global cycle
 *  position so the random values stay coherent across calls. */
function lfoSample(
  shape: LfoShape,
  p: number,
  rndVals: number[],
  globalT: number
): number {
  switch (shape) {
    case 'sine':
      return Math.sin(p * Math.PI * 2)
    case 'triangle':
      return p < 0.5 ? p * 4 - 1 : 3 - p * 4
    case 'sawtooth':
      return p * 2 - 1
    case 'square':
      return p < 0.5 ? 1 : -1
    case 'rndStep':
    case 'spastic': {
      // Pick the rnd-table entry indexed by the integer part of the
      // global cycle position — flat steps that hop on the boundary.
      // Spastic uses the same lookup; its table was already filled with
      // ±1 values so the rendered stairs sit on the rails.
      const idx = Math.floor(globalT) % rndVals.length
      return rndVals[idx]
    }
    case 'rndSmooth': {
      // Cosine-ease between adjacent rnd entries.
      const idx = Math.floor(globalT) % rndVals.length
      const next = (idx + 1) % rndVals.length
      const f = globalT - Math.floor(globalT)
      const k = (1 - Math.cos(f * Math.PI)) / 2
      return rndVals[idx] * (1 - k) + rndVals[next] * k
    }
    default:
      return 0
  }
}

/** Small mulberry32 PRNG. Local because the LFO visual needs a stable
 *  seed-dependent sequence for the random shapes; importing from
 *  factory.ts would pull in CommonJS-style requires. */
function mulberry(seed: number): () => number {
  let t = seed >>> 0
  return () => {
    t = (t + 0x6d2b79f5) >>> 0
    let x = t
    x = Math.imul(x ^ (x >>> 15), x | 1)
    x ^= x + Math.imul(x ^ (x >>> 7), x | 61)
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296
  }
}

// ─────────────────────────────────────────────────────────────────
// Envelope visual — full ADSR shape drawn from the four time params
// + sustain level. Reactive to every param so dragging Attack widens
// the rise, Sustain raises the plateau, Release shortens the tail, etc.
// ─────────────────────────────────────────────────────────────────

export function EnvelopeVisual({
  envelope,
  depthPct,
  progress
}: {
  envelope: EnvelopeParams
  depthPct: number
  /** 0..1 progress through the envelope's total duration. Drives the
   *  live dot riding along the ADSR shape. */
  progress?: number
}): JSX.Element {
  const W = 200
  const H = 56
  const padX = 4
  const padY = 4
  const innerW = W - padX * 2
  const innerH = H - padY * 2
  const depth01 = Math.max(0, Math.min(1, depthPct / 100))

  // Pull the four stage times + sustain level out of envelope. Both
  // synced (fractions) and free (ms) modes use the same shape — we
  // just normalise totals so the curve always fits the visual box.
  const isPct = envelope.sync === 'synced' || envelope.sync === 'freeSync'
  const a = isPct ? envelope.attackPct : envelope.attackMs
  const d = isPct ? envelope.decayPct : envelope.decayMs
  const s = isPct ? envelope.sustainPct : envelope.sustainMs
  const r = isPct ? envelope.releasePct : envelope.releaseMs
  const total = Math.max(1e-6, a + d + s + r)
  // Sustain level ∈ [0, 1] — height of the plateau between decay end
  // and release start. Scaled by depth so the visual narrows at
  // depth=0 and fully expresses at depth=100%.
  const sLevel = Math.max(0, Math.min(1, envelope.sustainLevel ?? 0.7)) * depth01
  // Peak (top of attack) is always 1 × depth01 — modulation depth
  // controls how high the attack reaches.
  const peak = depth01

  // Compute 5 anchor points: start, attack-end, decay-end (sustain
  // plateau start), sustain-plateau-end (release start), release-end.
  const startX = padX
  const aX = padX + (a / total) * innerW
  const dX = aX + (d / total) * innerW
  const sX = dX + (s / total) * innerW
  const rX = sX + (r / total) * innerW
  const baselineY = padY + innerH
  const peakY = baselineY - peak * innerH
  const sustainY = baselineY - sLevel * innerH

  const path =
    `M ${startX} ${baselineY} ` +
    `L ${aX.toFixed(2)} ${peakY.toFixed(2)} ` +
    `L ${dX.toFixed(2)} ${sustainY.toFixed(2)} ` +
    `L ${sX.toFixed(2)} ${sustainY.toFixed(2)} ` +
    `L ${rX.toFixed(2)} ${baselineY}`
  // Fill region underneath the envelope so it reads as "amplitude
  // available" rather than just a hairline.
  const fillPath =
    path + ` L ${rX.toFixed(2)} ${baselineY} L ${startX} ${baselineY} Z`

  return (
    <div className="mt-2 flex flex-col items-center gap-1">
      <svg
        width={W}
        height={H}
        viewBox={`0 0 ${W} ${H}`}
        style={{
          background: 'rgb(var(--c-input-bg) / 0.7)',
          border: '1px solid rgb(var(--c-border) / 0.7)',
          borderRadius: 6
        }}
      >
        {/* Floor line. */}
        <line
          x1={padX}
          y1={baselineY}
          x2={W - padX}
          y2={baselineY}
          stroke="rgb(var(--c-border) / 0.7)"
          strokeWidth={1}
        />
        <defs>
          <linearGradient id="rc-env-fill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="rgb(var(--c-accent))" stopOpacity={0.5} />
            <stop offset="100%" stopColor="rgb(var(--c-accent2))" stopOpacity={0.1} />
          </linearGradient>
        </defs>
        <path d={fillPath} fill="url(#rc-env-fill)" />
        <path
          d={path}
          fill="none"
          stroke="rgb(var(--c-accent))"
          strokeWidth={1.7}
          strokeLinecap="round"
          strokeLinejoin="round"
          style={{
            transition: 'stroke 220ms ease-out',
            filter: `drop-shadow(0 0 ${2 + depth01 * 3}px rgb(var(--c-accent) / ${0.3 + depth01 * 0.4}))`
          }}
        />
        {/* Small markers at the four stage boundaries — help the eye
            see where Attack ends, Sustain plateau starts, etc. */}
        {[
          { x: aX, y: peakY, label: 'A' },
          { x: dX, y: sustainY, label: 'D' },
          { x: sX, y: sustainY, label: 'S' },
          { x: rX, y: baselineY, label: 'R' }
        ].map((m) => (
          <g key={m.label}>
            <circle
              cx={m.x}
              cy={m.y}
              r={2}
              fill="rgb(var(--c-accent2))"
              opacity={0.85}
            />
          </g>
        ))}
        {/* Live progress dot riding the ADSR curve. The `progress`
            input is 0..1 across the envelope's total time (a+d+s+r).
            Recompute the (x, y) position from the four anchor times
            so the dot lands exactly on the segment that matches the
            current phase. */}
        {typeof progress === 'number' && progress >= 0 && progress <= 1 && (
          (() => {
            const pTime = progress * total
            let dx = 0
            let dy = baselineY
            if (pTime < a) {
              const f = pTime / Math.max(1e-9, a)
              dx = startX + (aX - startX) * f
              dy = baselineY + (peakY - baselineY) * f
            } else if (pTime < a + d) {
              const f = (pTime - a) / Math.max(1e-9, d)
              dx = aX + (dX - aX) * f
              dy = peakY + (sustainY - peakY) * f
            } else if (pTime < a + d + s) {
              const f = (pTime - a - d) / Math.max(1e-9, s)
              dx = dX + (sX - dX) * f
              dy = sustainY
            } else {
              const f = Math.min(1, (pTime - a - d - s) / Math.max(1e-9, r))
              dx = sX + (rX - sX) * f
              dy = sustainY + (baselineY - sustainY) * f
            }
            return (
              <circle
                cx={dx}
                cy={dy}
                r={3.5}
                fill="rgb(var(--c-accent))"
                style={{
                  filter:
                    'drop-shadow(0 0 6px rgb(var(--c-accent) / 0.9)) drop-shadow(0 0 12px rgb(var(--c-accent) / 0.45))'
                }}
              />
            )
          })()
        )}
      </svg>
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────
// Shared SVG frame — every visual uses the same 200×56 box with
// matching background + border so the modulator panel reads as a
// coherent column of small instrument readouts.
// ─────────────────────────────────────────────────────────────────
const VW = 200
const VH = 56
const VPad = 4

function VisFrame({ children }: { children: ReactNode }): JSX.Element {
  return (
    <div className="mt-2 flex flex-col items-center gap-1">
      <svg
        width={VW}
        height={VH}
        viewBox={`0 0 ${VW} ${VH}`}
        style={{
          background: 'rgb(var(--c-input-bg) / 0.7)',
          border: '1px solid rgb(var(--c-border) / 0.7)',
          borderRadius: 6
        }}
      >
        <defs>
          <linearGradient id="rc-mod-stroke" x1="0" y1="0" x2="1" y2="0">
            <stop offset="0%" stopColor="rgb(var(--c-accent))" />
            <stop offset="100%" stopColor="rgb(var(--c-accent2))" />
          </linearGradient>
          <linearGradient id="rc-mod-fill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="rgb(var(--c-accent))" stopOpacity={0.4} />
            <stop offset="100%" stopColor="rgb(var(--c-accent2))" stopOpacity={0.1} />
          </linearGradient>
        </defs>
        {children}
      </svg>
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────
// Ramp — one-shot 0 → 1 ramp shape. Curve choice (linear, exp,
// log, etc) is implicit in the user's `curve` setting; we draw a
// representative shape per option. Glow + thickness scale with
// modulation depth, matching LFO + Envelope.
// ─────────────────────────────────────────────────────────────────

export function RampVisual({
  ramp,
  depthPct,
  progress
}: {
  ramp: RampParams
  depthPct: number
  /** 0..1 progress through the ramp's lifetime — engine computes
   *  this from (now - triggerTime) / rampMs. When undefined, the
   *  visual draws only the static curve. When defined, a small
   *  accent dot rides the curve at the live position. */
  progress?: number
}): JSX.Element {
  const depth01 = Math.max(0, Math.min(1, depthPct / 100))
  const innerW = VW - VPad * 2
  const innerH = VH - VPad * 2
  const baseline = VPad + innerH
  // Sample the ramp curve at ~80 points. Different `curve` strings
  // (linear / exp / log / sshape / etc) shape the rise; default
  // linear for unknown values.
  // For Loop mode, draw three repetitions of the ramp so the
  // looping nature is obvious at a glance. Otherwise just one period.
  const mode = ramp.mode ?? 'normal'
  const repeats = mode === 'loop' ? 3 : 1
  const N = 80 * repeats
  const pts: Array<{ x: number; y: number }> = []
  // curvePct ∈ [-100, +100] — negative = log-ish (fast start), 0 =
  // linear, positive = exp-ish (slow start). Convert to a single
  // power exponent that bends the unit interval.
  const cp = Math.max(-100, Math.min(100, ramp.curvePct))
  const exponent = cp >= 0 ? 1 + (cp / 100) * 2.5 : 1 / (1 + (-cp / 100) * 2.5)
  for (let i = 0; i < N; i++) {
    const t = i / (N - 1) // 0..1 across whole visual
    const periodT = (t * repeats) % 1 // 0..1 within one period
    let v = Math.pow(periodT, exponent)
    // Inverted mode flips the curve vertically.
    if (mode === 'inverted') v = 1 - v
    const x = VPad + t * innerW
    const y = baseline - v * innerH * depth01
    pts.push({ x, y })
  }
  const path = pts
    .map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.x.toFixed(2)} ${p.y.toFixed(2)}`)
    .join(' ')
  const fillPath =
    path + ` L ${(VPad + innerW).toFixed(2)} ${baseline} L ${VPad} ${baseline} Z`
  return (
    <VisFrame>
      <line
        x1={VPad}
        y1={baseline}
        x2={VW - VPad}
        y2={baseline}
        stroke="rgb(var(--c-border) / 0.7)"
        strokeWidth={1}
      />
      <path d={fillPath} fill="url(#rc-mod-fill)" />
      <path
        d={path}
        fill="none"
        stroke="url(#rc-mod-stroke)"
        strokeWidth={1.5 + depth01 * 1.5}
        strokeLinecap="round"
        strokeLinejoin="round"
        style={{
          filter: `drop-shadow(0 0 ${2 + depth01 * 4}px rgb(var(--c-accent) / ${0.3 + depth01 * 0.4}))`,
          transition: 'stroke-width 220ms ease-out'
        }}
      />
      {/* Live progress dot — rides the curve at the engine's reported
          position. For Loop mode, `progress` is already wrapped per
          period by the editor's clamp so we just compute the right
          y at that t. Inverted mode mirrors the y the same way the
          curve drawing does. */}
      {typeof progress === 'number' && progress >= 0 && progress <= 1 && (
        (() => {
          let v = Math.pow(progress, exponent)
          if (mode === 'inverted') v = 1 - v
          const x = VPad + progress * innerW
          const y = baseline - v * innerH * depth01
          return (
            <circle
              cx={x}
              cy={y}
              r={3.5}
              fill="rgb(var(--c-accent))"
              style={{
                filter:
                  'drop-shadow(0 0 6px rgb(var(--c-accent) / 0.9)) drop-shadow(0 0 12px rgb(var(--c-accent) / 0.45))'
              }}
            />
          )
        })()
      )}
    </VisFrame>
  )
}

// ─────────────────────────────────────────────────────────────────
// Arpeggiator — render the ladder as vertical bars. Each bar's
// height encodes its value relative to the others; the bars use
// a hue spread across the row so the user can see the pattern
// shape at a glance.
// ─────────────────────────────────────────────────────────────────

export function ArpVisual({
  arp,
  depthPct
}: {
  arp: ArpeggiatorParams
  depthPct: number
}): JSX.Element {
  const depth01 = Math.max(0, Math.min(1, depthPct / 100))
  const N = Math.max(2, Math.min(8, arp.steps))
  // Get the actual ladder values (multiplier multipliers per step
  // index) for the current multMode — same call the engine uses.
  // Base value = 1 so the ladder reads as "× multiplier per step".
  const ladder = buildArpLadder(1, N, arp.multMode)
  // Playback order determined by arpMode. For walk/drunk/random
  // we synthesise a representative pattern so the visual shows
  // SOMETHING plausible (vs the engine's stochastic advance which
  // we can't perfectly preview).
  const playbackPattern = (() => {
    if (
      arp.arpMode === 'up' ||
      arp.arpMode === 'down' ||
      arp.arpMode === 'upDown' ||
      arp.arpMode === 'downUp' ||
      arp.arpMode === 'exclusion'
    ) {
      return buildArpPattern(arp.arpMode, N)
    }
    if (arp.arpMode === 'walk') {
      // Walk = ±1 each step. Show a meandering line: 0, 1, 0, 1, 2, 1, 2, 3.
      const pat: number[] = [0]
      let cur = 0
      for (let i = 1; i < Math.max(N * 2, 8); i++) {
        const dir = ((i * 7 + 3) % 5 < 2 ? -1 : 1)
        cur = Math.max(0, Math.min(N - 1, cur + dir))
        pat.push(cur)
      }
      return pat
    }
    if (arp.arpMode === 'drunk') {
      // Drunk = up to ±2 each step. Show a wilder swing.
      const pat: number[] = [0]
      let cur = 0
      for (let i = 1; i < Math.max(N * 2, 8); i++) {
        const dir = ((i * 11 + 5) % 7) - 3 // -3..3
        cur = Math.max(0, Math.min(N - 1, cur + dir))
        pat.push(cur)
      }
      return pat
    }
    // random — scatter through the ladder.
    const pat: number[] = []
    for (let i = 0; i < Math.max(N * 2, 8); i++) {
      pat.push((i * 13 + 7) % N)
    }
    return pat
  })()
  const totalSteps = playbackPattern.length
  const innerW = VW - VPad * 2
  const innerH = VH - VPad * 2 - 12 // leave 12 px at bottom for labels
  const baseline = VPad + innerH
  const cellW = innerW / totalSteps
  // Normalise ladder values to [0, 1] for the visual bar heights so
  // the largest multiplier reaches the top regardless of multMode.
  const ladderMax = ladder.reduce((m, v) => (Math.abs(v) > m ? Math.abs(v) : m), 0)
  const normBar = (idx: number): number =>
    ladderMax > 0 ? Math.abs(ladder[idx] ?? 0) / ladderMax : 0
  // Label formatter — what to write under each step. For 'mult' the
  // numbers grow fast (×1, ×2, ×4, ×8…), 'div' shows fractions
  // (1/N..N/N), 'divMult' shows the ×2^off pattern. Drop trailing
  // zeros for a tidy display.
  const labelFor = (mult: number): string => {
    if (arp.multMode === 'mult') return `×${Math.round(mult)}`
    if (arp.multMode === 'div') {
      // Format as N/M fraction in lowest terms (rounded).
      const denom = N
      const numer = Math.round(mult * N)
      const g = gcd(numer, denom)
      return `${numer / g}/${denom / g}`
    }
    // divMult — multiplier can be 1, 2, 4 (up) or 0.5, 0.25 (down).
    if (mult >= 1) return `×${Math.round(mult)}`
    return `÷${Math.round(1 / mult)}`
  }
  return (
    <VisFrame>
      <line
        x1={VPad}
        y1={baseline}
        x2={VW - VPad}
        y2={baseline}
        stroke="rgb(var(--c-border) / 0.7)"
        strokeWidth={1}
      />
      {playbackPattern.map((ladderIdx, i) => {
        const hue = (ladderIdx / N) * 200 + 30
        const x = VPad + i * cellW + cellW * 0.15
        const w = cellW * 0.7
        const h = normBar(ladderIdx)
        const hh = h * innerH * depth01
        return (
          <g key={i}>
            <rect
              x={x}
              y={baseline - hh}
              width={w}
              height={hh}
              rx={2}
              fill={`hsl(${hue} 75% 60%)`}
              opacity={0.85}
              style={{
                filter: `drop-shadow(0 0 ${1 + depth01 * 3}px hsl(${hue} 90% 65% / ${0.3 + depth01 * 0.4}))`,
                transition: 'height 220ms ease-out, y 220ms ease-out'
              }}
            />
            {/* Per-step multiplier label — real ×N / fraction / etc.
                Only shown when there's at least ~8 px of cell width
                per label so they don't overlap into illegibility. */}
            {cellW >= 14 && (
              <text
                x={x + w / 2}
                y={VH - 2}
                textAnchor="middle"
                fontSize={7.5}
                fontFamily="ui-monospace, monospace"
                fill="rgb(var(--c-muted))"
                opacity={0.85}
              >
                {labelFor(ladder[ladderIdx] ?? 0)}
              </text>
            )}
          </g>
        )
      })}
      {/* Polyline through every bar's top — exposes the playback
          shape (up/down/walk/etc) at a glance. */}
      <path
        d={playbackPattern
          .map((ladderIdx, i) => {
            const x = VPad + i * cellW + cellW / 2
            const y = baseline - normBar(ladderIdx) * innerH * depth01
            return `${i === 0 ? 'M' : 'L'} ${x.toFixed(2)} ${y.toFixed(2)}`
          })
          .join(' ')}
        fill="none"
        stroke="rgb(var(--c-accent2))"
        strokeWidth={1.5}
        strokeLinecap="round"
        strokeLinejoin="round"
        opacity={0.7}
        style={{
          filter: `drop-shadow(0 0 ${1 + depth01 * 2}px rgb(var(--c-accent2) / ${0.3 + depth01 * 0.3}))`
        }}
      />
    </VisFrame>
  )
}

function gcd(a: number, b: number): number {
  a = Math.abs(a)
  b = Math.abs(b)
  while (b !== 0) {
    const t = b
    b = a % b
    a = t
  }
  return a || 1
}

// ─────────────────────────────────────────────────────────────────
// Random Generator — show a scatter of dots within a band whose
// width tracks depth + valueType (float = continuous, int = stepped,
// colour = three rows of dots like an RGB lane). Deterministic from
// the rate seed so it doesn't flicker on every render.
// ─────────────────────────────────────────────────────────────────

export function RandomVisual({
  modulation,
  globalBpm
}: {
  modulation: Modulation
  globalBpm: number
}): JSX.Element {
  const random = modulation.random
  const depth01 = Math.max(0, Math.min(1, modulation.depthPct / 100))
  const effHz = effectiveLfoHz(modulation, globalBpm)
  const innerW = VW - VPad * 2
  const innerH = VH - VPad * 2
  const midY = VPad + innerH / 2
  // Density of dots scales with effective rate (faster rate = more
  // samples per visible window). Tracks BPM-synced rate changes too.
  const N = Math.max(6, Math.min(40, Math.round(effHz * 4 + 8)))
  const rng = mulberry(Math.floor(effHz * 100) + 17)
  const isColor = random.valueType === 'colour'
  return (
    <VisFrame>
      <line
        x1={VPad}
        y1={midY}
        x2={VW - VPad}
        y2={midY}
        stroke="rgb(var(--c-border) / 0.5)"
        strokeWidth={1}
        strokeDasharray="2 3"
      />
      {Array.from({ length: N }, (_, i) => {
        const x = VPad + (i / Math.max(1, N - 1)) * innerW
        if (isColor) {
          // Three RGB lanes — each dot offset vertically into one
          // of three rows.
          return [0, 1, 2].map((lane) => {
            const laneY = VPad + (lane + 0.5) * (innerH / 3)
            const r = 1.5 + rng() * 1.5
            const hue = lane === 0 ? 0 : lane === 1 ? 120 : 240
            return (
              <circle
                key={`${i}-${lane}`}
                cx={x}
                cy={laneY + (rng() - 0.5) * (innerH / 3) * 0.8 * depth01}
                r={r}
                fill={`hsl(${hue} 75% 60%)`}
                opacity={0.7 + 0.3 * depth01}
              />
            )
          })
        }
        const y = midY + (rng() - 0.5) * innerH * 0.9 * depth01
        const r = 1.8 + rng() * 1.2
        return (
          <circle
            key={i}
            cx={x}
            cy={y}
            r={r}
            fill="rgb(var(--c-accent))"
            opacity={0.7 + 0.3 * depth01}
            style={{
              filter: `drop-shadow(0 0 ${1 + depth01 * 2}px rgb(var(--c-accent) / ${0.4 + depth01 * 0.4}))`
            }}
          />
        )
      })}
    </VisFrame>
  )
}

// ─────────────────────────────────────────────────────────────────
// Sample & Hold — stair-step waveform. Each step holds for one
// clock period before jumping to a new random value. Smooth mode
// rounds the corners into a cosine-eased curve.
// ─────────────────────────────────────────────────────────────────

export function SampleHoldVisual({
  modulation,
  globalBpm
}: {
  modulation: Modulation
  globalBpm: number
}): JSX.Element {
  const sh = modulation.sh
  const depth01 = Math.max(0, Math.min(1, modulation.depthPct / 100))
  const effHz = effectiveLfoHz(modulation, globalBpm)
  const innerW = VW - VPad * 2
  const innerH = VH - VPad * 2
  const midY = VPad + innerH / 2
  // 8 stair steps across the box. Step count is a function of rate
  // so faster rates show more stair-steps in the same window.
  const N = Math.max(4, Math.min(16, Math.round(effHz * 2 + 4)))
  const cellW = innerW / N
  const rng = mulberry(Math.floor(effHz * 100) + 23)
  const samples: number[] = []
  // Apply probability: per the engine, probability is the chance of
  // TAKING A NEW SAMPLE this clock (< probability → grab fresh).
  // Previous implementation had this inverted, so at 100% prob the
  // visual went flat. Fixed: 100% prob now means new sample every
  // step (maximum variation), 0% means hold forever.
  for (let i = 0; i < N + 1; i++) {
    if (i === 0 || rng() < sh.probability) {
      samples.push(rng() * 2 - 1)
    } else {
      samples.push(samples[i - 1])
    }
  }
  const path: string[] = []
  for (let i = 0; i < N; i++) {
    const x0 = VPad + i * cellW
    const x1 = x0 + cellW
    const y = midY - samples[i] * (innerH / 2) * depth01
    if (sh.smooth && i > 0) {
      // Cosine ease from previous y to current y across the cell.
      const yPrev =
        midY - samples[i - 1] * (innerH / 2) * depth01
      const easeN = 8
      for (let j = 0; j <= easeN; j++) {
        const t = j / easeN
        const k = (1 - Math.cos(t * Math.PI)) / 2
        const xx = x0 + t * cellW
        const yy = yPrev + (y - yPrev) * k
        path.push(`${i === 0 && j === 0 ? 'M' : 'L'} ${xx.toFixed(2)} ${yy.toFixed(2)}`)
      }
    } else {
      path.push(`${i === 0 ? 'M' : 'L'} ${x0.toFixed(2)} ${y.toFixed(2)}`)
      path.push(`L ${x1.toFixed(2)} ${y.toFixed(2)}`)
    }
  }
  return (
    <VisFrame>
      <line
        x1={VPad}
        y1={midY}
        x2={VW - VPad}
        y2={midY}
        stroke="rgb(var(--c-border) / 0.5)"
        strokeWidth={1}
        strokeDasharray="2 3"
      />
      <path
        d={path.join(' ')}
        fill="none"
        stroke="url(#rc-mod-stroke)"
        strokeWidth={1.5 + depth01 * 1.5}
        strokeLinecap="round"
        strokeLinejoin="round"
        style={{
          filter: `drop-shadow(0 0 ${2 + depth01 * 3}px rgb(var(--c-accent) / ${0.3 + depth01 * 0.4}))`
        }}
      />
    </VisFrame>
  )
}

// ─────────────────────────────────────────────────────────────────
// Slew — smooth glide. Show a curve that moves from one random
// target to another with independent rise / fall time constants
// reflected in the curvature.
// ─────────────────────────────────────────────────────────────────

export function SlewVisual({
  modulation,
  globalBpm
}: {
  modulation: Modulation
  globalBpm: number
}): JSX.Element {
  const slew = modulation.slew
  const depth01 = Math.max(0, Math.min(1, modulation.depthPct / 100))
  const effHz = effectiveLfoHz(modulation, globalBpm)
  const innerW = VW - VPad * 2
  const innerH = VH - VPad * 2
  const midY = VPad + innerH / 2
  const N = 200
  const rng = mulberry(Math.floor(effHz * 100) + 31)
  // Random targets every "rate" period across visible band. Segments
  // scale with effective rate so BPM-synced changes are reflected.
  const segments = Math.max(2, Math.round(effHz * 2 + 2))
  const targets: number[] = Array.from({ length: segments + 1 }, () => rng() * 2 - 1)
  // Time constants: convert half-life ms to a per-step decay factor.
  const totalMs = (innerW / 200) * 1000 // ~1s visible window
  const dtMs = totalMs / N
  const riseTau = Math.max(1, slew.riseMs)
  const fallTau = Math.max(1, slew.fallMs)
  const segLen = N / segments
  const pts: Array<{ x: number; y: number }> = []
  let value = targets[0]
  for (let i = 0; i < N; i++) {
    const t = i / (N - 1)
    const segIdx = Math.min(segments - 1, Math.floor(i / segLen))
    const target = targets[segIdx + 1]
    const tau = target > value ? riseTau : fallTau
    const k = 1 - Math.exp(-dtMs / tau)
    value = value + (target - value) * k
    const x = VPad + t * innerW
    const y = midY - value * (innerH / 2) * depth01
    pts.push({ x, y })
  }
  const path = pts
    .map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.x.toFixed(2)} ${p.y.toFixed(2)}`)
    .join(' ')
  return (
    <VisFrame>
      <line
        x1={VPad}
        y1={midY}
        x2={VW - VPad}
        y2={midY}
        stroke="rgb(var(--c-border) / 0.5)"
        strokeWidth={1}
        strokeDasharray="2 3"
      />
      <path
        d={path}
        fill="none"
        stroke="url(#rc-mod-stroke)"
        strokeWidth={1.5 + depth01 * 1.5}
        strokeLinecap="round"
        strokeLinejoin="round"
        style={{
          filter: `drop-shadow(0 0 ${2 + depth01 * 3}px rgb(var(--c-accent) / ${0.3 + depth01 * 0.4}))`
        }}
      />
    </VisFrame>
  )
}

// ─────────────────────────────────────────────────────────────────
// Chaos — logistic-map iteration trace. Show several hundred
// iterations as a thin connected line, revealing the period-3
// window structure / chaos depending on the r value.
// ─────────────────────────────────────────────────────────────────

export function ChaosVisual({
  chaos,
  depthPct
}: {
  chaos: ChaosParams
  depthPct: number
}): JSX.Element {
  const depth01 = Math.max(0, Math.min(1, depthPct / 100))
  const innerW = VW - VPad * 2
  const innerH = VH - VPad * 2
  const baseline = VPad + innerH
  // Iterate the logistic map from x0=0.5 + jitter for `r` and skip
  // the first 32 iterations so the trace lands on the attractor.
  const N = 200
  const skip = 32
  let x = 0.5 + 0.01 * Math.sin(chaos.r * 7) // tiny deterministic offset
  for (let i = 0; i < skip; i++) x = chaos.r * x * (1 - x)
  const pts: Array<{ x: number; y: number }> = []
  for (let i = 0; i < N; i++) {
    x = chaos.r * x * (1 - x)
    const sx = VPad + (i / (N - 1)) * innerW
    const sy = baseline - x * innerH * depth01
    pts.push({ x: sx, y: sy })
  }
  const path = pts
    .map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.x.toFixed(2)} ${p.y.toFixed(2)}`)
    .join(' ')
  return (
    <VisFrame>
      <line
        x1={VPad}
        y1={baseline}
        x2={VW - VPad}
        y2={baseline}
        stroke="rgb(var(--c-border) / 0.7)"
        strokeWidth={1}
      />
      <path
        d={path}
        fill="none"
        stroke="url(#rc-mod-stroke)"
        strokeWidth={1 + depth01 * 1.5}
        strokeLinecap="round"
        strokeLinejoin="round"
        opacity={0.85}
        style={{
          filter: `drop-shadow(0 0 ${2 + depth01 * 3}px rgb(var(--c-accent) / ${0.3 + depth01 * 0.4}))`
        }}
      />
    </VisFrame>
  )
}
