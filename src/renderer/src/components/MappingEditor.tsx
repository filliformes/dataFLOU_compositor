// (v0.6.4) Mapping editor — the unified "input → transform → output" body:
// In range · transfer curve (with live plot) · Out range. Edits a
// HardwareScaleConfig. Shared by the per-Parameter inspector and the
// global Mappings view so they mirror each other exactly. The caller owns
// the enable toggle + header (address / parameter name).

import { useEffect, useState } from 'react'
import type { HardwareScaleConfig } from '@shared/types'
import { BoundedNumberInput } from './BoundedNumberInput'
import { TransferCurve } from './TransferCurve'
import { latestForAddress } from '../connectionHealth'

const DEFAULT_SCALE: HardwareScaleConfig = {
  enabled: false,
  inMin: 0,
  inMax: 1,
  outMin: 0,
  outMax: 1
}

export function MappingEditor({
  scale,
  onChange,
  address,
  compact = false
}: {
  scale: HardwareScaleConfig | undefined
  onChange: (patch: Partial<HardwareScaleConfig>) => void
  // Incoming address, used to show the live input dot on the curve.
  address?: string
  compact?: boolean
}): JSX.Element {
  const s = scale ?? DEFAULT_SCALE
  const [liveV, setLiveV] = useState<number | undefined>(undefined)
  useEffect(() => {
    if (!address) return
    const tick = (): void => setLiveV(latestForAddress(address))
    tick()
    const id = setInterval(tick, 200)
    return () => clearInterval(id)
  }, [address])
  const inSpan = s.inMax - s.inMin
  const liveT =
    liveV !== undefined && Math.abs(inSpan) > 1e-9
      ? (liveV - s.inMin) / inSpan
      : undefined

  const numCls = 'input w-11 text-[10px] text-right tabular-nums px-1'
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center gap-0.5 text-[10px]">
        <span className="text-muted text-[9px] shrink-0">in</span>
        <BoundedNumberInput
          className={numCls}
          value={s.inMin}
          min={-1e9}
          max={1e9}
          commitOn="blur"
          onChange={(v) => onChange({ inMin: v })}
          title="Device range low (what the controller sends)"
        />
        <BoundedNumberInput
          className={numCls}
          value={s.inMax}
          min={-1e9}
          max={1e9}
          commitOn="blur"
          onChange={(v) => onChange({ inMax: v })}
          title="Device range high"
        />
        <span className="text-muted shrink-0 px-0.5">→</span>
        <span className="text-muted text-[9px] shrink-0">out</span>
        <BoundedNumberInput
          className={numCls}
          value={s.outMin}
          min={-1e9}
          max={1e9}
          commitOn="blur"
          onChange={(v) => onChange({ outMin: v })}
          title="Output range low"
        />
        <BoundedNumberInput
          className={numCls}
          value={s.outMax}
          min={-1e9}
          max={1e9}
          commitOn="blur"
          onChange={(v) => onChange({ outMax: v })}
          title="Output range high"
        />
      </div>
      <TransferCurve
        curve={s.curve ?? 'linear'}
        amount={s.curveAmount ?? 0.5}
        invert={s.invert ?? false}
        liveT={liveT}
        compact={compact}
        onChange={(patch) => onChange(patch)}
      />
    </div>
  )
}
