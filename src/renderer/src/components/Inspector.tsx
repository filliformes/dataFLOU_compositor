import { useEffect, useRef, useState } from 'react'
import { useStore } from '../store'
import type {
  ArpMode,
  EnvSync,
  LfoMode,
  LfoShape,
  LfoSync,
  ModType,
  MultMode,
  RandomValueType,
  SeqSyncMode
} from '@shared/types'
import { DIVISIONS, rateHzToSlider, sliderToRateHz } from '@shared/factory'
import { BoundedNumberInput } from './BoundedNumberInput'
import { UncontrolledTextInput } from './UncontrolledInput'

export default function Inspector({ mode }: { mode: 'cell' | 'track' }): JSX.Element {
  if (mode === 'track') return <TrackInspector />
  return <CellInspector />
}

function TrackInspector(): JSX.Element {
  const trackId = useStore((s) => s.selectedTrack)!
  const track = useStore((s) => s.session.tracks.find((t) => t.id === trackId))
  const renameTrack = useStore((s) => s.renameTrack)
  const setTrackDefaults = useStore((s) => s.setTrackDefaults)
  const sendTrackDefaultsToClips = useStore((s) => s.sendTrackDefaultsToClips)
  const scenesCount = useStore((s) => s.session.scenes.length)
  const cellsCount = useStore((s) =>
    s.session.scenes.reduce((n, sc) => n + (sc.cells[trackId] ? 1 : 0), 0)
  )

  if (!track) return <div className="p-4 text-muted text-[12px]">Message removed.</div>

  return (
    <div className="p-3 flex flex-col gap-3 text-[12px]">
      <Section title="Message name">
        <UncontrolledTextInput
          className="input w-full"
          value={track.name}
          onChange={(v) => renameTrack(trackId, v)}
          placeholder="Message name"
        />
      </Section>

      <Section title="Message default destination">
        <div className="flex gap-1 items-center">
          <UncontrolledTextInput
            className="input flex-1"
            value={track.defaultDestIp ?? ''}
            placeholder="(inherit)"
            onChange={(v) => setTrackDefaults(trackId, { defaultDestIp: v || undefined })}
          />
          <span className="text-muted">:</span>
          <UncontrolledTextInput
            className="input w-16"
            value={track.defaultDestPort === undefined ? '' : String(track.defaultDestPort)}
            placeholder="port"
            onChange={(v) => {
              if (v === '') {
                setTrackDefaults(trackId, { defaultDestPort: undefined })
                return
              }
              if (!/^\d+$/.test(v)) return
              const n = parseInt(v, 10)
              if (n >= 0 && n <= 65535) setTrackDefaults(trackId, { defaultDestPort: n })
            }}
          />
        </div>
      </Section>

      <Section title="Message default OSC address">
        <UncontrolledTextInput
          className="input w-full"
          value={track.defaultOscAddress ?? ''}
          placeholder="(inherit)"
          onChange={(v) => setTrackDefaults(trackId, { defaultOscAddress: v || undefined })}
        />
      </Section>

      <button
        className="btn-accent"
        onClick={() => {
          const msg =
            cellsCount === scenesCount
              ? `Apply this message's defaults to all ${cellsCount} clip(s) on this row? Overwrites existing values.`
              : `Apply this message's defaults to all ${scenesCount} scenes on this row? Overwrites the ${cellsCount} existing clip(s) and auto-creates clips on the ${scenesCount - cellsCount} empty scene(s).`
          if (scenesCount === 0) return
          if (confirm(msg)) sendTrackDefaultsToClips(trackId)
        }}
        disabled={scenesCount === 0}
      >
        Send to clips ({cellsCount}/{scenesCount})
      </button>

      <div className="text-[10px] text-muted leading-snug">
        Only fields with a value get sent. Leave a field blank to skip it.
      </div>
    </div>
  )
}

function CellInspector(): JSX.Element {
  const sel = useStore((s) => s.selectedCell)!
  const scene = useStore((s) => s.session.scenes.find((sc) => sc.id === sel.sceneId))
  const track = useStore((s) => s.session.tracks.find((t) => t.id === sel.trackId))
  const cell = scene?.cells[sel.trackId]
  const updateCell = useStore((s) => s.updateCell)
  const setAddressToDefault = useStore((s) => s.setAddressToDefault)
  const setDestToDefault = useStore((s) => s.setDestToDefault)
  const currentStep = useStore(
    (s) => s.engine.seqStepBySceneAndTrack[sel.sceneId]?.[sel.trackId]
  )

  if (!scene || !track || !cell) {
    return <div className="p-4 text-muted text-[12px]">Cell removed.</div>
  }
  const c = cell

  function u(patch: Partial<typeof c>): void {
    updateCell(sel.sceneId, sel.trackId, patch)
  }
  function uSeq(patch: Partial<typeof c.sequencer>): void {
    u({ sequencer: { ...c.sequencer, ...patch } })
  }

  return (
    <div className="p-3 flex flex-col gap-3 text-[12px]">
      {/* Shared BPM-sync tick marks — referenced by list="dataflou-division-ticks"
          from every modulation editor. Hoisted here so it's mounted no matter
          which editor (LFO / Arp / Random) is currently visible. */}
      <datalist id="dataflou-division-ticks">
        {DIVISIONS.map((_, i) => (
          <option key={i} value={i} />
        ))}
      </datalist>

      <div>
        <div className="label mb-1">Cell</div>
        <div className="text-[11px]">
          <span className="text-muted">{scene.name} → {track.name}</span>
        </div>
      </div>

      <Section title="Destination">
        <div className="flex gap-1 items-center">
          <UncontrolledTextInput
            className="input flex-1 min-w-0"
            value={cell.destIp}
            onChange={(v) => u({ destIp: v })}
            placeholder="IP"
            maxLength={15}
          />
          <span className="text-muted">:</span>
          <UncontrolledTextInput
            className="input w-14"
            value={String(cell.destPort)}
            placeholder="port"
            onChange={(v) => {
              if (!/^\d*$/.test(v)) return
              const n = v === '' ? 0 : parseInt(v, 10)
              if (Number.isFinite(n) && n <= 65535) u({ destPort: n })
            }}
          />
          {cell.destLinkedToDefault ? (
            <span className="chip text-accent2 shrink-0">~def~</span>
          ) : (
            <button
              className="btn text-[10px] px-1.5 py-0.5 shrink-0"
              onClick={() => setDestToDefault(sel.sceneId, sel.trackId)}
            >
              Default
            </button>
          )}
        </div>
      </Section>

      <Section title="OSC Address">
        <div className="flex gap-1 items-center">
          <UncontrolledTextInput
            className="input flex-1 min-w-0"
            value={cell.oscAddress}
            onChange={(v) => u({ oscAddress: v })}
            placeholder="/path"
          />
          {cell.addressLinkedToDefault ? (
            <span className="chip text-accent2 shrink-0">~def~</span>
          ) : (
            <button
              className="btn text-[10px] px-1.5 py-0.5 shrink-0"
              onClick={() => setAddressToDefault(sel.sceneId, sel.trackId)}
            >
              Default
            </button>
          )}
        </div>
      </Section>

      <Section title="Value">
        <div className="flex items-center gap-2">
          <UncontrolledTextInput
            className="input flex-1 font-mono"
            value={cell.value}
            onChange={(v) => u({ value: capTokens(v, 16) })}
            placeholder="0"
            disabled={cell.sequencer.enabled}
          />
          <label className="flex items-center gap-1 text-[11px] shrink-0" title="Clamp every output to [0.0, 1.0]">
            <input
              type="checkbox"
              checked={cell.scaleToUnit}
              onChange={(e) => u({ scaleToUnit: e.target.checked })}
            />
            <span>Scale 0.0–1.0</span>
          </label>
        </div>
        <div className="text-[10px] text-muted mt-1">
          {(() => {
            const tokens = cell.value.trim().split(/\s+/).filter((t) => t)
            const tokenCount = tokens.length
            const types = tokens.map(detectedLabel)
            return (
              <>
                {tokenCount === 1
                  ? `auto-detected: ${types[0] || 'string (empty)'}`
                  : `${tokenCount} values: ${types.join(', ')}`}
                {tokenCount >= 16 && <span className="text-danger ml-2">(max 16)</span>}
                {cell.sequencer.enabled && (
                  <span className="text-accent ml-2">(ignored — sequencer on)</span>
                )}
              </>
            )
          })()}
        </div>
      </Section>

      <Section title="Timing">
        <div className="grid grid-cols-[auto_1fr_auto] gap-x-2 gap-y-1 items-center">
          <span className="label">Delay</span>
          <input
            className="input"
            type="number"
            min={0}
            max={10000}
            step={10}
            value={cell.delayMs}
            onChange={(e) => u({ delayMs: clamp(Number(e.target.value), 0, 10000) })}
          />
          <span className="text-muted text-[11px]">ms</span>
          <span className="label">Transition</span>
          <input
            className="input"
            type="number"
            min={0}
            max={10000}
            step={10}
            value={cell.transitionMs}
            onChange={(e) => u({ transitionMs: clamp(Number(e.target.value), 0, 10000) })}
          />
          <span className="text-muted text-[11px]">ms</span>
        </div>
      </Section>

      <CollapsibleSection
        title="Modulation"
        enabled={cell.modulation.enabled}
        onToggle={(v) => u({ modulation: { ...cell.modulation, enabled: v } })}
        headerRight={
          cell.modulation.enabled ? (
            <select
              className="input text-[11px] py-0.5"
              style={{ width: 120 }}
              value={cell.modulation.type}
              onChange={(e) =>
                u({ modulation: { ...cell.modulation, type: e.target.value as ModType } })
              }
              onClick={(e) => e.stopPropagation()}
            >
              <option value="lfo">LFO</option>
              <option value="envelope">Envelope</option>
              <option value="arpeggiator">Arpeggiator</option>
              <option value="random">Random</option>
            </select>
          ) : null
        }
      >
        {cell.modulation.type === 'lfo' ? (
          <LfoEditor cell={c} u={u} />
        ) : cell.modulation.type === 'envelope' ? (
          <EnvelopeEditor cell={c} u={u} />
        ) : cell.modulation.type === 'arpeggiator' ? (
          <ArpEditor cell={c} u={u} />
        ) : (
          <RandomEditor cell={c} u={u} />
        )}
      </CollapsibleSection>

      <CollapsibleSection
        title="Sequencer"
        enabled={cell.sequencer.enabled}
        onToggle={(v) => uSeq({ enabled: v })}
      >
        <div className="grid grid-cols-[auto_1fr_auto] gap-x-2 gap-y-1 items-center">
          <span className="label">Steps</span>
          <input
            type="range"
            min={1}
            max={16}
            step={1}
            value={cell.sequencer.steps}
            onChange={(e) => uSeq({ steps: clamp(Math.round(Number(e.target.value)), 1, 16) })}
          />
          <input
            className="input w-14 text-right"
            type="number"
            min={1}
            max={16}
            step={1}
            value={cell.sequencer.steps}
            onChange={(e) => uSeq({ steps: clamp(Math.round(Number(e.target.value)), 1, 16) })}
          />

          <span className="label">Mode</span>
          <select
            className="input col-span-2"
            value={cell.sequencer.syncMode}
            onChange={(e) => {
              const mode = e.target.value as SeqSyncMode
              if (mode === 'free') {
                uSeq({ syncMode: 'free', stepMs: Math.round(60000 / cell.sequencer.bpm) })
              } else if (mode === 'tempo') {
                uSeq({
                  syncMode: 'tempo',
                  bpm: clamp(Math.round(60000 / Math.max(1, cell.sequencer.stepMs)), 10, 500)
                })
              } else {
                // bpm — lock to session global BPM; clear per-clip tempo slider
                uSeq({ syncMode: 'bpm' })
              }
            }}
          >
            <option value="bpm">Sync (BPM)</option>
            <option value="tempo">Sync (Tempo)</option>
            <option value="free">Free (ms)</option>
          </select>

          {cell.sequencer.syncMode === 'bpm' ? (
            <>
              <span className="label">Source</span>
              <span className="text-muted text-[11px] col-span-2">
                Locked to session BPM.
              </span>
            </>
          ) : cell.sequencer.syncMode === 'tempo' ? (
            <>
              <span className="label">Tempo</span>
              <input
                type="range"
                min={10}
                max={500}
                step={1}
                value={cell.sequencer.bpm}
                onChange={(e) => uSeq({ bpm: clamp(Number(e.target.value), 10, 500) })}
              />
              <input
                className="input w-14 text-right"
                type="number"
                min={10}
                max={500}
                step={1}
                value={cell.sequencer.bpm}
                onChange={(e) => uSeq({ bpm: clamp(Number(e.target.value), 10, 500) })}
              />
            </>
          ) : (
            <>
              <span className="label">Step</span>
              <input
                type="range"
                min={10}
                max={5000}
                step={10}
                value={Math.min(5000, cell.sequencer.stepMs)}
                onChange={(e) => uSeq({ stepMs: clamp(Number(e.target.value), 1, 60000) })}
              />
              <input
                className="input w-16 text-right"
                type="number"
                min={1}
                max={60000}
                step={1}
                value={cell.sequencer.stepMs}
                onChange={(e) => uSeq({ stepMs: clamp(Number(e.target.value), 1, 60000) })}
              />
            </>
          )}
        </div>

        <div className="mt-2 flex flex-col gap-1">
          <div className="label">Step values (1…{cell.sequencer.steps})</div>
          <div className="grid grid-cols-4 gap-1">
            {Array.from({ length: cell.sequencer.steps }, (_, i) => (
              <StepInput
                key={i}
                index={i}
                active={currentStep === i && cell.sequencer.enabled}
                value={cell.sequencer.stepValues[i] ?? ''}
                onChange={(v) => {
                  const next = [...cell.sequencer.stepValues]
                  next[i] = v
                  uSeq({ stepValues: next })
                }}
              />
            ))}
          </div>
          <div className="text-[10px] text-muted mt-1">
            Auto-detect per step (bool / int / float / string). With Modulation also on, the LFO
            oscillates around the current step value.
          </div>
        </div>
      </CollapsibleSection>
    </div>
  )
}

// Modulation sub-editors. Both receive the current Cell and the update helper
// so they can build partial patches against `cell.modulation`.
type CellUpdate = (patch: Partial<import('@shared/types').Cell>) => void

function LfoEditor({
  cell,
  u
}: {
  cell: import('@shared/types').Cell
  u: CellUpdate
}): JSX.Element {
  const m = cell.modulation
  function uMod(patch: Partial<typeof m>): void {
    u({ modulation: { ...m, ...patch } })
  }
  return (
    // Fixed right column (88px) so the Hz/% unit column never gets pushed off
    // by a narrow inspector. Middle column is `minmax(0, 1fr)` so the slider
    // can shrink gracefully instead of forcing overflow.
    <div className="grid grid-cols-[64px_minmax(0,1fr)_88px] gap-x-2 gap-y-1 items-center">
      {/* Shape + Mode on the same row — Shape is width-capped so its menu
          sits exactly as wide as "Random Smoothed". */}
      <span className="label">Shape</span>
      <div className="flex items-center gap-1 min-w-0">
        <select
          className="input text-[11px] py-0.5"
          style={{ width: 130 }}
          value={m.shape}
          onChange={(e) => uMod({ shape: e.target.value as LfoShape })}
        >
          <option value="sine">Sine</option>
          <option value="triangle">Triangle</option>
          <option value="sawtooth">Sawtooth</option>
          <option value="square">Square</option>
          <option value="rndStep">Random Stepped</option>
          <option value="rndSmooth">Random Smoothed</option>
        </select>
        <select
          className="input text-[11px] py-0.5 flex-1 min-w-0"
          value={m.mode}
          onChange={(e) => uMod({ mode: e.target.value as LfoMode })}
          title="Unipolar = one-sided positive sweep. Bipolar = swings around center."
        >
          <option value="unipolar">Unipolar</option>
          <option value="bipolar">Bipolar</option>
        </select>
      </div>
      <span />

      <span className="label">Depth</span>
      <input
        type="range"
        min={0}
        max={100}
        step={1}
        value={m.depthPct}
        onChange={(e) => uMod({ depthPct: clamp(Number(e.target.value), 0, 100) })}
      />
      <div className="flex items-center gap-1 justify-end">
        <BoundedNumberInput
          className="input w-14 text-right"
          integer
          min={0}
          max={100}
          value={m.depthPct}
          onChange={(v) => uMod({ depthPct: v })}
        />
        <span className="text-muted text-[11px] w-5 shrink-0">%</span>
      </div>

      <span className="label">Rate</span>
      {m.sync === 'free' ? (
        <>
          {/* Log-mapped: 0..50 of the slider → 0.01..20 Hz (musically useful
              low range), 50..100 → 20..100 Hz. Values bind through the helper
              functions in factory.ts. */}
          <input
            type="range"
            min={0}
            max={100}
            step={0.1}
            list="dataflou-rate-ticks"
            value={rateHzToSlider(m.rateHz)}
            onChange={(e) =>
              uMod({ rateHz: sliderToRateHz(Number(e.target.value)) })
            }
          />
          <datalist id="dataflou-rate-ticks">
            <option value={0} />
            <option value={25} />
            <option value={50} />
            <option value={75} />
            <option value={100} />
          </datalist>
          <div className="flex items-center gap-1 justify-end">
            <BoundedNumberInput
              className="input w-14 text-right"
              min={0.01}
              max={100}
              value={m.rateHz}
              onChange={(v) => uMod({ rateHz: v })}
            />
            <span className="text-muted text-[11px] w-5 shrink-0">Hz</span>
          </div>
        </>
      ) : (
        <>
          {/* Tick-marked slider mapped to the DIVISIONS table. The datalist
              makes the browser draw small tick marks under the thumb. */}
          <input
            type="range"
            min={0}
            max={DIVISIONS.length - 1}
            step={1}
            value={m.divisionIdx}
            list="dataflou-division-ticks"
            onChange={(e) => uMod({ divisionIdx: Number(e.target.value) })}
          />
          <div className="flex items-center justify-end">
            <span className="text-muted text-[11px] font-mono w-full text-right">
              {DIVISIONS[m.divisionIdx]?.label ?? '—'}
            </span>
          </div>
        </>
      )}

      <span className="label">Sync</span>
      <div className="flex items-center gap-2 text-[11px] min-w-0 flex-wrap">
        <select
          className="input text-[11px] py-0.5 shrink-0"
          style={{ width: 82 }}
          value={m.sync}
          onChange={(e) => uMod({ sync: e.target.value as LfoSync })}
        >
          <option value="free">Free (Hz)</option>
          <option value="bpm">BPM</option>
        </select>
        <label
          className={`flex items-center gap-1 shrink-0 ${
            m.sync !== 'bpm' ? 'opacity-40' : ''
          }`}
        >
          <input
            type="checkbox"
            disabled={m.sync !== 'bpm'}
            checked={m.dotted}
            onChange={(e) => uMod({ dotted: e.target.checked })}
          />
          <span>Dotted</span>
        </label>
        <label
          className={`flex items-center gap-1 shrink-0 ${
            m.sync !== 'bpm' ? 'opacity-40' : ''
          }`}
        >
          <input
            type="checkbox"
            disabled={m.sync !== 'bpm'}
            checked={m.triplet}
            onChange={(e) => uMod({ triplet: e.target.checked })}
          />
          <span>Triplet</span>
        </label>
      </div>
      <span />
    </div>
  )
}

function ArpEditor({
  cell,
  u
}: {
  cell: import('@shared/types').Cell
  u: CellUpdate
}): JSX.Element {
  const m = cell.modulation
  const arp = m.arpeggiator
  function uMod(patch: Partial<typeof m>): void {
    u({ modulation: { ...m, ...patch } })
  }
  function uArp(patch: Partial<typeof arp>): void {
    u({ modulation: { ...m, arpeggiator: { ...arp, ...patch } } })
  }

  return (
    // Same grid template as LFO so everything aligns to the right.
    <div className="grid grid-cols-[64px_minmax(0,1fr)_88px] gap-x-2 gap-y-1 items-center">
      <span className="label">Steps</span>
      <input
        type="range"
        min={1}
        max={8}
        step={1}
        value={arp.steps}
        onChange={(e) => uArp({ steps: clamp(Math.round(Number(e.target.value)), 1, 8) })}
      />
      <div className="flex items-center gap-1 justify-end">
        <BoundedNumberInput
          className="input w-14 text-right"
          integer
          min={1}
          max={8}
          value={arp.steps}
          onChange={(v) => uArp({ steps: clamp(Math.round(v), 1, 8) })}
        />
        <span className="text-muted text-[11px] w-5 shrink-0">/8</span>
      </div>

      <span className="label">Mode</span>
      <select
        className="input text-[11px] py-0.5 min-w-0"
        value={arp.arpMode}
        onChange={(e) => uArp({ arpMode: e.target.value as ArpMode })}
      >
        <option value="up">Up</option>
        <option value="down">Down</option>
        <option value="upDown">Up/Down</option>
        <option value="downUp">Down/Up</option>
        <option value="exclusion">Exclusion</option>
        <option value="walk">Walk</option>
        <option value="drunk">Drunk</option>
        <option value="random">Random</option>
      </select>
      <span />

      <span className="label">Mult</span>
      <select
        className="input text-[11px] py-0.5 min-w-0"
        value={arp.multMode}
        onChange={(e) => uArp({ multMode: e.target.value as MultMode })}
        title="Division: Value is the max; lower steps are fractions.
Multiplication: Value is step 1; each step doubles.
Div/Mult: Value in the middle; halvings below, doublings above."
      >
        <option value="div">Division</option>
        <option value="mult">Multiplication</option>
        <option value="divMult">Div/Mult</option>
      </select>
      <span />

      <span className="label">Depth</span>
      <input
        type="range"
        min={0}
        max={100}
        step={1}
        value={m.depthPct}
        onChange={(e) => uMod({ depthPct: clamp(Number(e.target.value), 0, 100) })}
      />
      <div className="flex items-center gap-1 justify-end">
        <BoundedNumberInput
          className="input w-14 text-right"
          integer
          min={0}
          max={100}
          value={m.depthPct}
          onChange={(v) => uMod({ depthPct: v })}
        />
        <span className="text-muted text-[11px] w-5 shrink-0">%</span>
      </div>

      <span className="label">Rate</span>
      {m.sync === 'free' ? (
        <>
          <input
            type="range"
            min={0}
            max={100}
            step={0.1}
            value={rateHzToSlider(m.rateHz)}
            onChange={(e) => uMod({ rateHz: sliderToRateHz(Number(e.target.value)) })}
          />
          <div className="flex items-center gap-1 justify-end">
            <BoundedNumberInput
              className="input w-14 text-right"
              min={0.01}
              max={100}
              value={m.rateHz}
              onChange={(v) => uMod({ rateHz: v })}
            />
            <span className="text-muted text-[11px] w-5 shrink-0">Hz</span>
          </div>
        </>
      ) : (
        <>
          <input
            type="range"
            min={0}
            max={DIVISIONS.length - 1}
            step={1}
            value={m.divisionIdx}
            list="dataflou-division-ticks"
            onChange={(e) => uMod({ divisionIdx: Number(e.target.value) })}
          />
          <div className="flex items-center justify-end">
            <span className="text-muted text-[11px] font-mono w-full text-right">
              {DIVISIONS[m.divisionIdx]?.label ?? '—'}
            </span>
          </div>
        </>
      )}

      <span className="label">Sync</span>
      <div className="flex items-center gap-2 text-[11px] min-w-0 flex-wrap">
        <select
          className="input text-[11px] py-0.5 shrink-0"
          style={{ width: 82 }}
          value={m.sync}
          onChange={(e) => uMod({ sync: e.target.value as LfoSync })}
        >
          <option value="free">Free (Hz)</option>
          <option value="bpm">BPM</option>
        </select>
        <label
          className={`flex items-center gap-1 shrink-0 ${
            m.sync !== 'bpm' ? 'opacity-40' : ''
          }`}
        >
          <input
            type="checkbox"
            disabled={m.sync !== 'bpm'}
            checked={m.dotted}
            onChange={(e) => uMod({ dotted: e.target.checked })}
          />
          <span>Dotted</span>
        </label>
        <label
          className={`flex items-center gap-1 shrink-0 ${
            m.sync !== 'bpm' ? 'opacity-40' : ''
          }`}
        >
          <input
            type="checkbox"
            disabled={m.sync !== 'bpm'}
            checked={m.triplet}
            onChange={(e) => uMod({ triplet: e.target.checked })}
          />
          <span>Triplet</span>
        </label>
      </div>
      <span />

      <div className="col-span-3 text-[10px] text-muted">
        Depth 100% = ladder step replaces the base value; 0% leaves it untouched. The ladder is
        built independently per space-separated value in the Value box. Scale 0.0–1.0 clamps each
        output to [0, 1] as usual. If there are no numeric tokens in the Value field, the
        arpeggiator is skipped.
      </div>
    </div>
  )
}

function RandomEditor({
  cell,
  u
}: {
  cell: import('@shared/types').Cell
  u: CellUpdate
}): JSX.Element {
  const m = cell.modulation
  const rnd = m.random
  function uMod(patch: Partial<typeof m>): void {
    u({ modulation: { ...m, ...patch } })
  }
  function uRnd(patch: Partial<typeof rnd>): void {
    u({ modulation: { ...m, random: { ...rnd, ...patch } } })
  }

  // Sensible range defaults when the user switches value type.
  function onValueTypeChange(next: RandomValueType): void {
    // Only reset min/max if the user is sitting on the previous type's defaults.
    const defaults: Record<RandomValueType, { min: number; max: number }> = {
      int: { min: 0, max: 127 },
      float: { min: 0, max: 1 },
      colour: { min: 0, max: 255 }
    }
    uRnd({ valueType: next, ...defaults[next] })
  }

  const isColour = rnd.valueType === 'colour'

  return (
    <div className="grid grid-cols-[64px_minmax(0,1fr)_88px] gap-x-2 gap-y-1 items-center">
      <span className="label">Type</span>
      <select
        className="input text-[11px] py-0.5 min-w-0"
        value={rnd.valueType}
        onChange={(e) => onValueTypeChange(e.target.value as RandomValueType)}
        title="Int = one integer per tick. Float = one float per tick (1e-11 precision). Colour = three ints (r, g, b) per tick."
      >
        <option value="int">Int</option>
        <option value="float">Float</option>
        <option value="colour">Colour (r,g,b)</option>
      </select>
      <span />

      <span className="label">Min</span>
      <BoundedNumberInput
        className="input"
        min={-1000000}
        max={1000000}
        integer={rnd.valueType !== 'float'}
        value={rnd.min}
        onChange={(v) => uRnd({ min: v })}
      />
      <span />

      <span className="label">Max</span>
      <BoundedNumberInput
        className="input"
        min={-1000000}
        max={1000000}
        integer={rnd.valueType !== 'float'}
        value={rnd.max}
        onChange={(v) => uRnd({ max: v })}
      />
      <span />

      <span className="label">Rate</span>
      {m.sync === 'free' ? (
        <>
          <input
            type="range"
            min={0}
            max={100}
            step={0.1}
            value={rateHzToSlider(m.rateHz)}
            onChange={(e) => uMod({ rateHz: sliderToRateHz(Number(e.target.value)) })}
          />
          <div className="flex items-center gap-1 justify-end">
            <BoundedNumberInput
              className="input w-14 text-right"
              min={0.01}
              max={100}
              value={m.rateHz}
              onChange={(v) => uMod({ rateHz: v })}
            />
            <span className="text-muted text-[11px] w-5 shrink-0">Hz</span>
          </div>
        </>
      ) : (
        <>
          <input
            type="range"
            min={0}
            max={DIVISIONS.length - 1}
            step={1}
            value={m.divisionIdx}
            list="dataflou-division-ticks"
            onChange={(e) => uMod({ divisionIdx: Number(e.target.value) })}
          />
          <div className="flex items-center justify-end">
            <span className="text-muted text-[11px] font-mono w-full text-right">
              {DIVISIONS[m.divisionIdx]?.label ?? '—'}
            </span>
          </div>
        </>
      )}

      <span className="label">Sync</span>
      <div className="flex items-center gap-2 text-[11px] min-w-0 flex-wrap">
        <select
          className="input text-[11px] py-0.5 shrink-0"
          style={{ width: 82 }}
          value={m.sync}
          onChange={(e) => uMod({ sync: e.target.value as LfoSync })}
        >
          <option value="free">Free (Hz)</option>
          <option value="bpm">BPM</option>
        </select>
        <label
          className={`flex items-center gap-1 shrink-0 ${
            m.sync !== 'bpm' ? 'opacity-40' : ''
          }`}
        >
          <input
            type="checkbox"
            disabled={m.sync !== 'bpm'}
            checked={m.dotted}
            onChange={(e) => uMod({ dotted: e.target.checked })}
          />
          <span>Dotted</span>
        </label>
        <label
          className={`flex items-center gap-1 shrink-0 ${
            m.sync !== 'bpm' ? 'opacity-40' : ''
          }`}
        >
          <input
            type="checkbox"
            disabled={m.sync !== 'bpm'}
            checked={m.triplet}
            onChange={(e) => uMod({ triplet: e.target.checked })}
          />
          <span>Triplet</span>
        </label>
      </div>
      <span />

      <div className="col-span-3 text-[10px] text-muted">
        The clip's Value is used as the PRNG seed — the same Value produces a reproducible stream.
        {isColour
          ? ' Colour mode sends three integer OSC args (r, g, b), each independently drawn from [Min, Max].'
          : rnd.valueType === 'int'
            ? ' One int OSC arg per sample, in [Min, Max].'
            : ' One float OSC arg per sample, in [Min, Max], rounded to 1e-11.'}
        {' '}Scale 0.0–1.0 clamps each channel to [0, 1].
      </div>
    </div>
  )
}

function EnvelopeEditor({
  cell,
  u
}: {
  cell: import('@shared/types').Cell
  u: CellUpdate
}): JSX.Element {
  const m = cell.modulation
  const env = m.envelope
  function uEnv(patch: Partial<typeof env>): void {
    u({ modulation: { ...m, envelope: { ...env, ...patch } } })
  }
  function uMod(patch: Partial<typeof m>): void {
    u({ modulation: { ...m, ...patch } })
  }
  const synced = env.sync === 'synced'
  // Display values: synced shows 0.01..100 (%), free shows 0..10000 (ms).
  // Internal storage keeps synced values as 0..1 fractions.
  const displayMin = synced ? 0.01 : 0
  const displayMax = synced ? 100 : 10000
  const displayStep = synced ? 0.01 : 10
  const unit = synced ? '%' : 'ms'
  const scaleToDisplay = (v: number): number => (synced ? v * 100 : v)
  const displayToScale = (v: number): number => (synced ? v / 100 : v)

  return (
    <div className="flex flex-col gap-2">
      <div className="grid grid-cols-[64px_1fr_88px] gap-x-2 gap-y-1 items-center">
        <span className="label">Sync</span>
        <select
          className="input text-[11px] py-0.5"
          value={env.sync}
          onChange={(e) => uEnv({ sync: e.target.value as EnvSync })}
          title={
            synced
              ? 'Times are fractions of scene duration (A+D+S+R ≤ 100%).'
              : 'Times in milliseconds (each max 10000ms).'
          }
        >
          <option value="synced">Synced (scene)</option>
          <option value="free">Free (ms)</option>
        </select>
        <span />

        <span className="label">Depth</span>
        <input
          type="range"
          min={0}
          max={100}
          step={1}
          value={m.depthPct}
          onChange={(e) => uMod({ depthPct: clamp(Number(e.target.value), 0, 100) })}
        />
        <div className="flex items-center gap-1 justify-end">
          <BoundedNumberInput
            className="input w-14 text-right"
            min={0}
            max={100}
            value={m.depthPct}
            onChange={(v) => uMod({ depthPct: v })}
          />
          <span className="text-muted text-[11px] w-5 shrink-0">%</span>
        </div>
      </div>

      {(['attack', 'decay', 'sustain', 'release'] as const).map((seg) => {
        const key = synced ? (`${seg}Pct` as const) : (`${seg}Ms` as const)
        const val = env[key] as number
        const disp = scaleToDisplay(val)
        return (
          <div
            key={seg}
            className="grid grid-cols-[64px_1fr_88px] gap-x-2 items-center"
          >
            <span className="label capitalize">{seg}</span>
            <input
              type="range"
              min={displayMin}
              max={displayMax}
              step={displayStep}
              value={disp}
              onChange={(e) => {
                const d = clamp(Number(e.target.value), displayMin, displayMax)
                uEnv({ [key]: displayToScale(d) } as unknown as Partial<typeof env>)
              }}
            />
            <div className="flex items-center gap-1 justify-end">
              <BoundedNumberInput
                className="input w-14 text-right"
                min={displayMin}
                max={displayMax}
                value={disp}
                onChange={(v) =>
                  uEnv({ [key]: displayToScale(v) } as unknown as Partial<typeof env>)
                }
              />
              <span className="text-muted text-[11px] w-5 shrink-0">{unit}</span>
            </div>
          </div>
        )
      })}

      <div className="grid grid-cols-[64px_1fr_88px] gap-x-2 items-center">
        <span className="label">Sus lvl</span>
        <input
          type="range"
          min={0}
          max={100}
          step={1}
          value={Math.round(env.sustainLevel * 100)}
          onChange={(e) =>
            uEnv({ sustainLevel: clamp(Number(e.target.value), 0, 100) / 100 })
          }
        />
        <div className="flex items-center gap-1 justify-end">
          <BoundedNumberInput
            className="input w-14 text-right"
            min={0}
            max={100}
            value={Math.round(env.sustainLevel * 100)}
            onChange={(v) => uEnv({ sustainLevel: v / 100 })}
          />
          <span className="text-muted text-[11px] w-5 shrink-0">%</span>
        </div>
      </div>

      <div className="text-[10px] text-muted">
        {synced
          ? 'A+D+S+R fractions are auto-normalized if they exceed 100% of scene duration.'
          : 'Each stage in milliseconds (0–10 000).'}{' '}
        Envelope applies to every space-separated value in the clip.
      </div>
    </div>
  )
}

function Section({ title, children }: { title: string; children: React.ReactNode }): JSX.Element {
  return (
    <div className="flex flex-col gap-1 pt-2 border-t border-border first:border-t-0 first:pt-0">
      <div className="label">{title}</div>
      {children}
    </div>
  )
}

// Shows only the enable checkbox when disabled; expands to reveal children when on.
// `headerRight` is an optional slot rendered aligned to the right of the title.
function CollapsibleSection({
  title,
  enabled,
  onToggle,
  headerRight,
  children
}: {
  title: string
  enabled: boolean
  onToggle: (v: boolean) => void
  headerRight?: React.ReactNode
  children: React.ReactNode
}): JSX.Element {
  return (
    <div className="flex flex-col gap-1 pt-2 border-t border-border">
      <div className="flex items-center gap-2">
        <label className="flex items-center gap-2 cursor-pointer select-none">
          <input
            type="checkbox"
            checked={enabled}
            onChange={(e) => onToggle(e.target.checked)}
          />
          <span className="label">{title}</span>
          {!enabled && <span className="text-[10px] text-muted">(click to enable)</span>}
        </label>
        <div className="flex-1" />
        {headerRight}
      </div>
      {enabled && <div className="flex flex-col gap-2 mt-1">{children}</div>}
    </div>
  )
}

// A step input that pulses orange each time it becomes the active step.
// Uncontrolled (defaultValue + ref): the DOM owns the value while focused, so
// engine state updates (which fire at sequencer rate) cannot clobber typing.
// External value changes are synced into the DOM only when the input is not
// focused. Auto-selects on focus so typing replaces the existing value (e.g. "0").
function StepInput({
  index,
  active,
  value,
  onChange
}: {
  index: number
  active: boolean
  value: string
  onChange: (v: string) => void
}): JSX.Element {
  const inputRef = useRef<HTMLInputElement>(null)
  const pulseRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const el = inputRef.current
    if (!el) return
    if (document.activeElement !== el && el.value !== value) {
      el.value = value
    }
  }, [value])

  useEffect(() => {
    if (!active) return
    const el = pulseRef.current
    if (!el) return
    el.classList.remove('seq-pulse')
    void el.offsetWidth
    el.classList.add('seq-pulse')
  }, [active])

  return (
    <div className="relative">
      <span className="text-[9px] text-muted px-1">{index + 1}</span>
      <input
        ref={inputRef}
        defaultValue={value}
        className={`input text-[11px] py-0.5 px-1 font-mono w-full ${active ? 'border-accent' : ''}`}
        placeholder="–"
        onFocus={(e) => e.currentTarget.select()}
        onChange={(e) => onChange(e.target.value)}
      />
      <div
        ref={pulseRef}
        aria-hidden
        className="absolute inset-x-0 bottom-0 top-[14px] pointer-events-none rounded-sm"
      />
    </div>
  )
}

function clamp(v: number, lo: number, hi: number): number {
  if (!Number.isFinite(v)) return lo
  return v < lo ? lo : v > hi ? hi : v
}

// Trim whitespace-delimited tokens to `max` while preserving the trailing
// space if the user is still typing (so mid-word typing is not jumpy).
function capTokens(raw: string, max: number): string {
  const endsWithSpace = /\s$/.test(raw)
  const parts = raw.trim().split(/\s+/).filter((s) => s.length > 0)
  if (parts.length <= max) return raw
  return parts.slice(0, max).join(' ') + (endsWithSpace ? ' ' : '')
}

function detectedLabel(s: string): string {
  const t = s.trim()
  if (t === '') return 'string (empty)'
  if (/^(true|TRUE|True|false|FALSE|False)$/.test(t)) return 'bool'
  if (/^-?\d+$/.test(t)) return 'int'
  if (/^-?(\d+\.\d*|\.\d+|\d+)([eE][-+]?\d+)?$/.test(t)) return 'float'
  return 'string'
}
