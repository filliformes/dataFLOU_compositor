// (v0.6.4) Mappings view — one legible place to see and shape every
// input → output mapping across the session. Each Instrument Parameter
// gets an "input address → transfer curve → output range" card, mirroring
// the per-Parameter inspector (both edit hardwareMode.scaling[fnId]).
// Toggled from the transport bar.

import type { HardwareScaleConfig, InstrumentFunction, InstrumentTemplate } from '@shared/types'
import { useStore } from '../store'
import { MappingEditor } from './MappingEditor'
import { ParameterInputConditioning } from './InputConditioningSection'

function fnAddress(tpl: InstrumentTemplate, fn: InstrumentFunction): string {
  const path = fn.oscPath ?? ''
  if (path.startsWith('/')) return path
  const base = tpl.oscAddressBase ?? ''
  return `${base.endsWith('/') ? base.slice(0, -1) : base}/${path}`
}

export function MappingsView(): JSX.Element {
  const templates = useStore((s) => s.session.pool.templates)
  const tracks = useStore((s) => s.session.tracks)
  const setHw = useStore((s) => s.setTemplateHardwareMode)
  const setMappingsOpen = useStore((s) => s.setMappingsOpen)

  // Only the Instruments actually PLACED in this session — i.e. templates
  // that have an instantiated track. Pool blueprints / built-ins that
  // haven't been added to the grid are not "mappings" and shouldn't show.
  const usedTemplateIds = new Set(
    tracks.map((t) => t.sourceTemplateId).filter((id): id is string => !!id)
  )
  const withParams = templates.filter(
    (t) => t.functions.length > 0 && usedTemplateIds.has(t.id)
  )

  return (
    <div className="h-full overflow-auto">
      <div className="sticky top-0 z-10 bg-panel/95 backdrop-blur border-b border-border px-3 py-2 flex items-center gap-2">
        <span className="text-sm font-medium">Mappings</span>
        <span className="text-[10px] text-muted">
          input → transfer curve → output, for every Parameter
        </span>
        <div className="flex-1" />
        <button
          className="btn text-[11px] py-0.5 px-2"
          onClick={() => setMappingsOpen(false)}
          title="Close the Mappings view"
        >
          ✕ Close
        </button>
      </div>

      {withParams.length === 0 && (
        <div className="p-6 text-[11px] text-muted">
          No Instruments with Parameters yet. Add an Instrument (Pool → drag a
          template, or Capture a device from the Network tab), then its
          Parameters show up here with an input → curve → output mapping.
        </div>
      )}

      <div className="p-3 flex flex-col gap-4">
        {withParams.map((tpl) => {
          // Only the Parameters actually PLACED in the grid — the template
          // may define more (a captured device has every address), but the
          // Mappings view shows what's instantiated, matching the grid.
          const usedFnIds = new Set(
            tracks
              .filter((t) => t.sourceTemplateId === tpl.id && t.sourceFunctionId)
              .map((t) => t.sourceFunctionId)
          )
          const fns = tpl.functions.filter((f) => usedFnIds.has(f.id))
          if (fns.length === 0) return null
          return (
          <section key={tpl.id} className="flex flex-col gap-1.5">
            <div className="flex items-center gap-1.5">
              <span
                className="inline-block w-2.5 h-2.5 rounded-sm shrink-0"
                style={{ background: tpl.color }}
              />
              <span className="text-[12px] font-medium">{tpl.name}</span>
              <span className="text-[9px] text-muted">
                {fns.length} Parameter{fns.length === 1 ? '' : 's'}
              </span>
            </div>
            <div
              className="grid gap-2 items-start"
              style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))' }}
            >
              {fns.map((fn) => {
                const addr = fnAddress(tpl, fn)
                const fnTrack = tracks.find(
                  (t) =>
                    t.sourceTemplateId === tpl.id && t.sourceFunctionId === fn.id
                )
                const sc = tpl.hardwareMode?.scaling?.[fn.id]
                const enabled = sc?.enabled === true
                const patchScale = (p: Partial<HardwareScaleConfig>): void => {
                  setHw(tpl.id, {
                    scaling: {
                      ...(tpl.hardwareMode?.scaling ?? {}),
                      [fn.id]: {
                        enabled: false,
                        inMin: 0,
                        inMax: 1,
                        outMin: fn.min ?? 0,
                        outMax: fn.max ?? 1,
                        ...sc,
                        ...p
                      }
                    }
                  })
                }
                return (
                  <div
                    key={fn.id}
                    className="border border-border rounded p-2 bg-panel2/30 flex flex-col gap-1.5"
                  >
                    <div className="flex items-baseline gap-1.5">
                      <span className="text-[11px] font-medium truncate">
                        {fn.name}
                      </span>
                      <span
                        className="text-[9px] text-muted font-mono truncate"
                        title={addr}
                      >
                        {addr}
                        {fn.unit ? ` · ${fn.unit}` : ''}
                      </span>
                    </div>

                    {/* Full chain, top to bottom: condition → curve+scale,
                        mirroring the OCTOCOSME DataScale patch. */}
                    {fnTrack && (
                      <ParameterInputConditioning track={fnTrack} template={tpl} />
                    )}

                    <div className="flex flex-col gap-1">
                      <label
                        className="flex items-center gap-1.5 cursor-pointer"
                        title="Scale + shape the (conditioned) value into the Parameter's output range"
                      >
                        <input
                          type="checkbox"
                          checked={enabled}
                          onChange={(e) => patchScale({ enabled: e.target.checked })}
                        />
                        <span
                          className="label"
                          style={{
                            color: enabled ? 'rgb(var(--c-accent))' : undefined
                          }}
                        >
                          Scale + curve
                        </span>
                      </label>
                      <div
                        className={enabled ? '' : 'opacity-45'}
                        title={
                          enabled ? undefined : 'Tick the box to apply this mapping'
                        }
                      >
                        <MappingEditor
                          scale={sc}
                          onChange={patchScale}
                          address={addr}
                        />
                      </div>
                    </div>
                  </div>
                )
              })}
            </div>
          </section>
          )
        })}
      </div>
    </div>
  )
}
