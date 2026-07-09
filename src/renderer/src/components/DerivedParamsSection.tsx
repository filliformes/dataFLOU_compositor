// (v0.6.4) Derived Parameters — cross-input math for an Instrument.
// Combine several source addresses (magnitude, sum, …) into a synthetic
// input address that flows through the normal pipeline. Solves the
// "gyro magnitude" case that per-address conditioning couldn't.

import { useEffect, useState } from 'react'
import type { DerivedOp, DerivedParam, InstrumentTemplate } from '@shared/types'
import { useStore } from '../store'
import { BoundedNumberInput } from './BoundedNumberInput'

const OPS: { value: DerivedOp; label: string; desc: string }[] = [
  {
    value: 'magnitude',
    label: 'Magnitude',
    desc: 'Vector length √(a²+b²+…). The classic “total energy / speed” from x·y·z axes — e.g. gyro magnitude = how vigorously you move, regardless of direction.'
  },
  { value: 'sum', label: 'Sum', desc: 'Adds every source together: a + b + c …' },
  {
    value: 'difference',
    label: 'Difference',
    desc: 'First source minus all the rest: a − b − c … (with two sources, a − b).'
  },
  {
    value: 'average',
    label: 'Average',
    desc: 'The mean of all sources: (a + b + …) ÷ count.'
  },
  { value: 'min', label: 'Min', desc: 'The smallest of the source values.' },
  { value: 'max', label: 'Max', desc: 'The largest of the source values.' },
  {
    value: 'scaleOffset',
    label: 'Single source (a)',
    desc: 'Passes the first source straight through — use the Output ×/+ below to rescale it on its own (e.g. 0..360° → 0..1).'
  }
]

function fnAddress(tpl: InstrumentTemplate, oscPath: string): string {
  if (oscPath.startsWith('/')) return oscPath
  const base = tpl.oscAddressBase || ''
  return `${base.endsWith('/') ? base.slice(0, -1) : base}/${oscPath}`
}

export function DerivedParamsSection({
  template
}: {
  template: InstrumentTemplate
}): JSX.Element {
  const setDerived = useStore((s) => s.setTemplateDerivedParams)
  const list = template.derivedParams ?? []
  // Candidate source addresses = every real Parameter address on this
  // Instrument (derived params source real addresses only).
  const sourceOptions = template.functions.map((fn) => fnAddress(template, fn.oscPath))

  // Live computed values, polled from the engine while the section shows.
  const [live, setLive] = useState<Record<string, number>>({})
  useEffect(() => {
    let alive = true
    const poll = (): void => {
      window.api?.derivedGetLive?.().then((v) => {
        if (alive) setLive(v)
      })
    }
    poll()
    const id = setInterval(poll, 250)
    return () => {
      alive = false
      clearInterval(id)
    }
  }, [])

  function patch(id: string, p: Partial<DerivedParam>): void {
    setDerived(
      template.id,
      list.map((d) => (d.id === id ? { ...d, ...p } : d))
    )
  }
  function add(): void {
    const base = template.oscAddressBase || '/derived'
    const dp: DerivedParam = {
      id:
        typeof crypto !== 'undefined' && crypto.randomUUID
          ? `dp_${crypto.randomUUID().slice(0, 8)}`
          : `dp_${Date.now().toString(36)}`,
      address: `${base.endsWith('/') ? base.slice(0, -1) : base}/derived${list.length + 1}`,
      op: 'magnitude',
      sources: sourceOptions.slice(0, 3)
    }
    setDerived(template.id, [...list, dp])
  }
  function remove(id: string): void {
    setDerived(
      template.id,
      list.filter((d) => d.id !== id)
    )
  }
  function toggleSource(d: DerivedParam, addr: string): void {
    const has = d.sources.includes(addr)
    patch(d.id, {
      sources: has ? d.sources.filter((s) => s !== addr) : [...d.sources, addr]
    })
  }

  return (
    <div className="border border-border rounded p-1.5 flex flex-col gap-1.5 bg-panel2/30">
      <div className="flex items-center gap-1.5">
        <span className="label">Derived Parameters</span>
        <span
          className="inline-flex items-center justify-center w-3 h-3 rounded-full text-[8px] cursor-help select-none shrink-0"
          style={{ border: '1px solid rgb(var(--c-muted))', color: 'rgb(var(--c-muted))' }}
          aria-label="Help: Derived Parameters"
          title={
            'Compute a new input from several of this Instrument’s addresses — e.g. gyro magnitude √(x²+y²+z²).\n\n' +
            'The result is published on a synthetic OSC address that behaves like any real one: it appears in the OSC In monitor, and you can add a Parameter with that address (or Capture it) to map / scale / drive cells from it.\n\n' +
            'Sources are read at slot 0 (raw). Requires Hardware Mode bound so the source packets are seen.'
          }
        >
          i
        </span>
        <div className="flex-1" />
        <button
          className="btn text-[10px] py-0.5 px-1.5"
          onClick={add}
          disabled={sourceOptions.length === 0}
          title={
            sourceOptions.length === 0
              ? 'Add Parameters to this Instrument first'
              : 'Add a derived parameter'
          }
        >
          + Add
        </button>
      </div>
      {list.length === 0 && (
        <span className="text-[9px] text-muted italic">
          None yet. Combine axes (e.g. gyro x/y/z → magnitude) into one input.
        </span>
      )}
      {list.map((d) => {
        const val = live[d.address]
        return (
          <div key={d.id} className="flex flex-col gap-0.5 border-t border-border/60 pt-1">
            {/* address · op · live value · remove — one tight line */}
            <div className="flex items-center gap-1 text-[10px]">
              <input
                className="input text-[10px] flex-1 min-w-0"
                value={d.address}
                onChange={(e) => patch(d.id, { address: e.target.value })}
                title="Synthetic output address"
              />
              <select
                className="input text-[10px] shrink-0"
                value={d.op}
                title={OPS.find((o) => o.value === d.op)?.desc}
                onChange={(e) => patch(d.id, { op: e.target.value as DerivedOp })}
              >
                {OPS.map((o) => (
                  <option key={o.value} value={o.value} title={o.desc}>
                    {o.label}
                  </option>
                ))}
              </select>
              <span
                className="tabular-nums shrink-0 text-right"
                style={{
                  minWidth: 40,
                  color:
                    typeof val === 'number' && Number.isFinite(val)
                      ? 'rgb(var(--c-accent2))'
                      : 'rgb(var(--c-muted))'
                }}
                title="Live computed value (needs the device streaming)"
              >
                {typeof val === 'number' && Number.isFinite(val)
                  ? val.toFixed(2)
                  : '–'}
              </span>
              <button
                className="shrink-0 leading-none px-0.5"
                style={{ color: 'rgb(var(--c-danger))' }}
                title="Remove"
                onClick={() => remove(d.id)}
              >
                ✕
              </button>
            </div>
            {/* per-op explanation */}
            <span className="text-[9px] text-muted leading-snug">
              {OPS.find((o) => o.value === d.op)?.desc}
            </span>
            {/* Output transform + sources — crammed onto one wrapping row */}
            <div className="flex items-center gap-x-2 gap-y-1 text-[10px] flex-wrap">
              <span
                className="flex items-center gap-1"
                title="Applied to the result: value × scale + offset. Leave ×1 +0 for no change (e.g. °/s → 0..1)."
              >
                <span className="text-muted text-[9px]">out ×</span>
                <BoundedNumberInput
                  className="input w-12 text-[10px] text-right tabular-nums"
                  value={d.scale ?? 1}
                  min={-1e9}
                  max={1e9}
                  commitOn="blur"
                  onChange={(v) => patch(d.id, { scale: v })}
                  title="Scale (multiply the result)"
                />
                <span className="text-muted text-[9px]">+</span>
                <BoundedNumberInput
                  className="input w-12 text-[10px] text-right tabular-nums"
                  value={d.offset ?? 0}
                  min={-1e9}
                  max={1e9}
                  commitOn="blur"
                  onChange={(v) => patch(d.id, { offset: v })}
                  title="Offset (add to the result)"
                />
              </span>
              <span className="flex items-center gap-1.5 flex-wrap">
                <span className="text-muted text-[9px]">from:</span>
                {sourceOptions.map((addr) => (
                  <label
                    key={addr}
                    className="flex items-center gap-0.5 text-[9px] cursor-pointer"
                    title={addr}
                  >
                    <input
                      type="checkbox"
                      checked={d.sources.includes(addr)}
                      onChange={() => toggleSource(d, addr)}
                    />
                    <span className="truncate max-w-[80px]">
                      {addr.split('/').pop()}
                    </span>
                  </label>
                ))}
              </span>
            </div>
          </div>
        )
      })}
    </div>
  )
}
