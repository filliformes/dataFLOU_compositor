// Mode-icon row — rich-theme replacement for the Pattern <select> in
// the Sequencer panel. Renders one small SVG button per sequencer
// mode; the active mode glows in the accent hue. Each icon is an
// abstract pictogram of the mode's behaviour (vertical bars for
// Steps, dots-on-a-circle for Euclidean, two interlocking rings for
// Polyrhythm, etc.). Click any button to switch.
//
// Pattern matches Rainbow Circuit's three-icon spectrum/oscilloscope/
// keyboard toggle on Peaks — each mode is its own little instrument
// you can pick by clicking its picture.

import type { SeqMode } from '@shared/types'

type IconRender = () => JSX.Element

// Each icon is a 16×16 SVG that uses currentColor so the parent's
// `color` (set by CSS based on .is-active) tints the strokes.
const ICONS: Record<SeqMode, IconRender> = {
  // Steps — four vertical bars of varying height (a static cycle).
  steps: () => (
    <svg width={16} height={16} viewBox="0 0 16 16" fill="none">
      <rect x={2} y={9} width={2} height={5} fill="currentColor" />
      <rect x={6} y={5} width={2} height={9} fill="currentColor" />
      <rect x={10} y={7} width={2} height={7} fill="currentColor" />
      <rect x={14} y={3} width={2} height={11} fill="currentColor" transform="translate(-1.5 0)" />
    </svg>
  ),
  // Euclidean — eight dots evenly placed on a circle, three lit (a
  // tresillo pattern like 3-over-8).
  euclidean: () => (
    <svg width={16} height={16} viewBox="0 0 16 16" fill="none">
      <circle cx={8} cy={8} r={5.5} stroke="currentColor" strokeWidth={0.8} opacity={0.45} />
      {[0, 1, 2, 3, 4, 5, 6, 7].map((i) => {
        const ang = (i / 8) * Math.PI * 2 - Math.PI / 2
        const x = 8 + Math.cos(ang) * 5.5
        const y = 8 + Math.sin(ang) * 5.5
        const lit = i === 0 || i === 3 || i === 6 // tresillo
        return (
          <circle
            key={i}
            cx={x}
            cy={y}
            r={lit ? 1.4 : 0.9}
            fill={lit ? 'currentColor' : 'currentColor'}
            opacity={lit ? 1 : 0.35}
          />
        )
      })}
    </svg>
  ),
  // Polyrhythm — two interlocking rings (3 vs 4) overlapping in the
  // middle. Reads instantly as cross-rhythm.
  polyrhythm: () => (
    <svg width={16} height={16} viewBox="0 0 16 16" fill="none">
      <circle cx={6} cy={8} r={4.2} stroke="currentColor" strokeWidth={1.2} fill="none" />
      <circle cx={10} cy={8} r={4.2} stroke="currentColor" strokeWidth={1.2} fill="none" opacity={0.7} />
    </svg>
  ),
  // Density — a row of dots at varying opacity (probability per step).
  density: () => (
    <svg width={16} height={16} viewBox="0 0 16 16" fill="none">
      {[0.45, 1, 0.3, 0.85, 0.5, 1, 0.7].map((op, i) => (
        <circle
          key={i}
          cx={2 + i * 2}
          cy={8}
          r={1.1}
          fill="currentColor"
          opacity={op}
        />
      ))}
    </svg>
  ),
  // Cellular — a small Sierpinski-like triangle (Rule 90 silhouette).
  cellular: () => (
    <svg width={16} height={16} viewBox="0 0 16 16" fill="none">
      {/* Row 0 — single centre cell. */}
      <rect x={7} y={2} width={2} height={2} fill="currentColor" />
      {/* Row 1 — two cells. */}
      <rect x={5} y={5} width={2} height={2} fill="currentColor" />
      <rect x={9} y={5} width={2} height={2} fill="currentColor" />
      {/* Row 2 — three cells with a gap. */}
      <rect x={3} y={8} width={2} height={2} fill="currentColor" />
      <rect x={7} y={8} width={2} height={2} fill="currentColor" />
      <rect x={11} y={8} width={2} height={2} fill="currentColor" />
      {/* Row 3 — four corner cells. */}
      <rect x={1} y={11} width={2} height={2} fill="currentColor" />
      <rect x={5} y={11} width={2} height={2} fill="currentColor" />
      <rect x={9} y={11} width={2} height={2} fill="currentColor" />
      <rect x={13} y={11} width={2} height={2} fill="currentColor" />
    </svg>
  ),
  // Drift — a wavy meandering line ending in a small dot (the walker).
  drift: () => (
    <svg width={16} height={16} viewBox="0 0 16 16" fill="none">
      <path
        d="M 1 12 Q 3 6, 5 9 T 9 7 T 13 10"
        stroke="currentColor"
        strokeWidth={1.2}
        fill="none"
        strokeLinecap="round"
      />
      <circle cx={13} cy={10} r={1.6} fill="currentColor" />
    </svg>
  ),
  // Ratchet — three diagonal stripes inside a frame (a burst of
  // sub-pulses).
  ratchet: () => (
    <svg width={16} height={16} viewBox="0 0 16 16" fill="none">
      <rect x={1.5} y={3} width={13} height={10} rx={1.5} stroke="currentColor" strokeWidth={0.8} fill="none" opacity={0.4} />
      <line x1={3.5} y1={11} x2={6} y2={5} stroke="currentColor" strokeWidth={1.4} strokeLinecap="round" />
      <line x1={7} y1={11} x2={9.5} y2={5} stroke="currentColor" strokeWidth={1.4} strokeLinecap="round" />
      <line x1={10.5} y1={11} x2={13} y2={5} stroke="currentColor" strokeWidth={1.4} strokeLinecap="round" />
    </svg>
  ),
  // Bounce — a single parabolic arc with a landing dot.
  bounce: () => (
    <svg width={16} height={16} viewBox="0 0 16 16" fill="none">
      <line x1={1} y1={13} x2={15} y2={13} stroke="currentColor" strokeWidth={0.8} opacity={0.4} />
      <path
        d="M 2 13 Q 8 1, 14 13"
        stroke="currentColor"
        strokeWidth={1.4}
        fill="none"
        strokeLinecap="round"
      />
      <circle cx={2} cy={13} r={1.2} fill="currentColor" />
      <circle cx={14} cy={13} r={1.2} fill="currentColor" />
    </svg>
  ),
  // Draw — a hand-drawn squiggle inside a frame, with a tiny pencil
  // dot at the tip.
  draw: () => (
    <svg width={16} height={16} viewBox="0 0 16 16" fill="none">
      <rect x={1.5} y={3} width={13} height={10} rx={1.5} stroke="currentColor" strokeWidth={0.8} fill="none" opacity={0.4} />
      <path
        d="M 3 11 Q 5 5, 7 8 T 11 6 L 13 9"
        stroke="currentColor"
        strokeWidth={1.4}
        fill="none"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <circle cx={13} cy={9} r={1.2} fill="currentColor" />
    </svg>
  ),
  // Adresse — an arrow pointing INTO a row of steps (CV addresses
  // the row instead of a clock walking it). Buchla 245 vibe.
  adresse: () => (
    <svg width={16} height={16} viewBox="0 0 16 16" fill="none">
      <rect x={2} y={10} width={2} height={4} fill="currentColor" opacity={0.5} />
      <rect x={5} y={7} width={2} height={7} fill="currentColor" opacity={0.5} />
      <rect x={8} y={9} width={2} height={5} fill="currentColor" />
      <rect x={11} y={6} width={2} height={8} fill="currentColor" opacity={0.5} />
      <path
        d="M 9 2 L 9 6 M 7 4 L 9 6 L 11 4"
        stroke="currentColor"
        strokeWidth={1.2}
        fill="none"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

const MODE_LABELS: Record<SeqMode, string> = {
  steps: 'Steps',
  euclidean: 'Euclidean',
  polyrhythm: 'Polyrhythm',
  density: 'Density',
  cellular: 'Cellular',
  drift: 'Drift',
  ratchet: 'Ratchet',
  bounce: 'Bounce',
  draw: 'Draw',
  adresse: 'Address'
}

const MODE_ORDER: SeqMode[] = [
  'steps',
  'euclidean',
  'polyrhythm',
  'density',
  'cellular',
  'drift',
  'ratchet',
  'bounce',
  'draw'
]

export function RcModeIcons({
  value,
  onChange
}: {
  value: SeqMode
  onChange: (v: SeqMode) => void
}): JSX.Element {
  return (
    // Always a single row, right-justified. `flex-nowrap` + tight gap
    // keep the 9 pictograms on one line regardless of which mode is
    // selected, so the layout stays stable as the user clicks
    // through. `justify-end` aligns the cluster to the right edge so
    // it sits nicely under the "Sequencer" label that hangs off the
    // left of the inspector's grid column.
    // `flex-wrap` allows the 9 pictograms to fold onto a second row
    // at narrow inspector widths / high uiScale (~168px minimum was
    // exceeding the inspector column at scale ≥ 1.5). Cluster still
    // right-justifies and groups together by line-breaking. Set
    // `min-w-0` upstream so the inspector column can shrink and
    // trigger the wrap rather than clipping silently.
    <div className="flex items-center gap-[3px] flex-wrap justify-end">
      {MODE_ORDER.map((m) => {
        const Icon = ICONS[m]
        const isActive = m === value
        return (
          <button
            key={m}
            type="button"
            className={`rc-mode-btn ${isActive ? 'is-active' : ''}`}
            onClick={() => onChange(m)}
            title={MODE_LABELS[m]}
            aria-label={MODE_LABELS[m]}
            aria-pressed={isActive}
          >
            <Icon />
          </button>
        )
      })}
    </div>
  )
}
