// (v0.6.4) Transfer curve editor — shape · amount · invert + a live plot.
// Edits the curve fields of a HardwareScaleConfig; the plot uses the SAME
// `applyTransferCurve` the engine uses, so what you draw is what emits.
// Shared by the per-Parameter mapping editor and the global Mappings view.

import { applyTransferCurve, TRANSFER_CURVES } from '@shared/factory'
import type { TransferCurve as TC } from '@shared/types'

// Group the curves for the dropdown's <optgroup>s (Sine / Quad / …).
const CURVE_GROUPS: { group: string; items: { value: TC; label: string }[] }[] =
  (() => {
    const order: string[] = []
    const by: Record<string, { value: TC; label: string }[]> = {}
    for (const c of TRANSFER_CURVES) {
      if (!by[c.group]) {
        by[c.group] = []
        order.push(c.group)
      }
      by[c.group].push({ value: c.value, label: c.label })
    }
    return order.map((group) => ({ group, items: by[group] }))
  })()

const W = 128
const H = 56
const PAD = 4

function plotPoints(curve: TC, amount: number, invert: boolean): string {
  const n = 48
  const out: string[] = []
  for (let i = 0; i <= n; i++) {
    const x = i / n
    let t = invert ? 1 - x : x
    t = applyTransferCurve(curve, t, amount)
    const px = PAD + x * (W - 2 * PAD)
    const py = PAD + (1 - t) * (H - 2 * PAD)
    out.push(`${px.toFixed(1)},${py.toFixed(1)}`)
  }
  return out.join(' ')
}

export function TransferCurve({
  curve,
  amount,
  invert,
  onChange,
  liveT,
  compact = false
}: {
  curve: TC
  amount: number
  invert: boolean
  onChange: (patch: { curve?: TC; curveAmount?: number; invert?: boolean }) => void
  // Live normalized input 0..1 (optional dot on the plot).
  liveT?: number
  compact?: boolean
}): JSX.Element {
  const hasLive = typeof liveT === 'number' && Number.isFinite(liveT)
  const lt = hasLive ? Math.max(0, Math.min(1, liveT as number)) : 0
  const lout = applyTransferCurve(curve, invert ? 1 - lt : lt, amount)
  const dotX = PAD + lt * (W - 2 * PAD)
  const dotY = PAD + (1 - lout) * (H - 2 * PAD)

  return (
    <div className="flex flex-col gap-1">
      {/* Shape dropdown (grouped by easing family) + invert */}
      <div className="flex items-center gap-1">
        <select
          className="input text-[10px] flex-1 min-w-0"
          value={curve}
          onChange={(e) => onChange({ curve: e.target.value as TC })}
          title="Easing shape (Penner set, as in Max's ease object)"
        >
          {CURVE_GROUPS.map((g) =>
            g.group === 'Basic' ? (
              g.items.map((it) => (
                <option key={it.value} value={it.value}>
                  {it.label}
                </option>
              ))
            ) : (
              <optgroup key={g.group} label={g.group}>
                {g.items.map((it) => (
                  <option key={it.value} value={it.value}>
                    {g.group} · {it.label}
                  </option>
                ))}
              </optgroup>
            )
          )}
        </select>
        <label
          className="flex items-center gap-0.5 text-[9px] cursor-pointer shrink-0"
          title="Flip the response — input rising drives output falling"
        >
          <input
            type="checkbox"
            checked={invert}
            onChange={(e) => onChange({ invert: e.target.checked })}
          />
          <span className="text-muted">inv</span>
        </label>
      </div>

      {/* Plot */}
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="w-full rounded"
        style={{ background: 'rgb(var(--c-panel2) / 0.5)', maxWidth: W * 1.6 }}
        preserveAspectRatio="none"
      >
        {/* frame + diagonal reference */}
        <rect
          x={PAD}
          y={PAD}
          width={W - 2 * PAD}
          height={H - 2 * PAD}
          fill="none"
          stroke="rgb(var(--c-border))"
          strokeWidth={0.5}
        />
        <line
          x1={PAD}
          y1={H - PAD}
          x2={W - PAD}
          y2={PAD}
          stroke="rgb(var(--c-border))"
          strokeWidth={0.5}
          strokeDasharray="2 2"
        />
        <polyline
          points={plotPoints(curve, amount, invert)}
          fill="none"
          stroke="rgb(var(--c-accent))"
          strokeWidth={1.5}
        />
        {hasLive && (
          <>
            <line
              x1={dotX}
              y1={H - PAD}
              x2={dotX}
              y2={dotY}
              stroke="rgb(var(--c-accent2))"
              strokeWidth={0.5}
              strokeDasharray="1 1"
            />
            <circle cx={dotX} cy={dotY} r={2.2} fill="rgb(var(--c-accent2))" />
          </>
        )}
      </svg>

      {/* Amount — irrelevant for linear */}
      {curve !== 'linear' && (
        <label
          className="flex items-center gap-1 text-[9px]"
          title={
            curve === 'step'
              ? 'Number of steps (more = finer)'
              : 'Curve intensity (0 ≈ straight line)'
          }
        >
          <span className="text-muted">{curve === 'step' ? 'steps' : 'amount'}</span>
          <input
            type="range"
            min={0}
            max={1}
            step={0.01}
            value={amount}
            onChange={(e) => onChange({ curveAmount: parseFloat(e.target.value) })}
            className="flex-1"
          />
          {!compact && (
            <span className="tabular-nums text-muted w-6 text-right">
              {curve === 'step'
                ? Math.max(2, Math.round(2 + amount * 14))
                : amount.toFixed(2)}
            </span>
          )}
        </label>
      )}
    </div>
  )
}
