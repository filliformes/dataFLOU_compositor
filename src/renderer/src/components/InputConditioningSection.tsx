// Input Conditioning section (v0.6) — per-Instrument smoothing chain
// for the incoming Hardware-Mode OSC stream. PiPo-style ordered stages
// (1€ / Smooth / Median / Slew Limit / Deadband / Auto Range), each a
// small unit with 1-2 knobs, plus a live before/after scope so tuning
// is a see-it job instead of guesswork.
//
// Each stage carries an optional OSC-address scope (default: all
// addresses). The stage title shows that address so you can tell at a
// glance which inputs are smoothed. The Parameter inspector reflects
// the matching stages + its own scope via ParameterConditioningReflection.
//
// Embedded in BOTH the Pool's TemplateInspector and the grid-side
// TrackInspector (same pattern as HardwareModeSection) — both surfaces
// edit the same template.inputConditioner blob via
// setTemplateInputConditioner.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useStore } from '../store'
import { BoundedNumberInput } from './BoundedNumberInput'
import { ResizeHandle } from './ResizeHandle'
import { scopePrefs } from '../scopePrefs'
import { INPUT_STAGE_INFO, makeInputStage } from '@shared/factory'
import type {
  InputConditionerConfig,
  InputStage,
  InputStageType,
  InstrumentTemplate,
  Track
} from '@shared/types'

const STAGE_TYPES: InputStageType[] = [
  'oneEuro',
  'smooth',
  'median',
  'slewLimit',
  'deadband',
  'autoRange'
]

function cssRgb(varName: string, fallback: string): string {
  const v = getComputedStyle(document.documentElement)
    .getPropertyValue(varName)
    .trim()
  return v ? `rgb(${v.replace(/ /g, ',')})` : fallback
}

// The list of OSC addresses an instrument's Parameter rows listen on —
// the menu for a stage's address scope and the scope's address picker.
function useTemplateAddresses(templateId: string): string[] {
  const tracks = useStore((s) => s.session.tracks)
  return useMemo(() => {
    const out: string[] = []
    for (const t of tracks) {
      if (
        t.sourceTemplateId === templateId &&
        t.kind === 'function' &&
        t.defaultOscAddress &&
        !out.includes(t.defaultOscAddress)
      ) {
        out.push(t.defaultOscAddress)
      }
    }
    return out
  }, [tracks, templateId])
}

// Short label for the last path segment, e.g. "/mpu/euler/roll" → "roll".
function tailOf(address: string): string {
  const parts = address.split('/').filter(Boolean)
  return parts.length ? parts[parts.length - 1] : address
}

export function InputConditioningSection({
  template
}: {
  template: InstrumentTemplate
}): JSX.Element {
  const setConditioner = useStore((s) => s.setTemplateInputConditioner)
  const cfg: InputConditionerConfig = template.inputConditioner ?? {
    enabled: false,
    stages: [],
    slotBypass: []
  }
  const [addType, setAddType] = useState<InputStageType>('oneEuro')
  const [addAddress, setAddAddress] = useState<string>('') // '' = all
  const addresses = useTemplateAddresses(template.id)

  function patchStage(stageId: string, patch: Partial<InputStage>): void {
    setConditioner(template.id, {
      stages: cfg.stages.map((s) => (s.id === stageId ? { ...s, ...patch } : s))
    })
  }
  function moveStage(stageId: string, dir: -1 | 1): void {
    const idx = cfg.stages.findIndex((s) => s.id === stageId)
    const to = idx + dir
    if (idx < 0 || to < 0 || to >= cfg.stages.length) return
    const next = cfg.stages.slice()
    const [st] = next.splice(idx, 1)
    next.splice(to, 0, st)
    setConditioner(template.id, { stages: next })
  }

  return (
    <div className="border border-border rounded p-1.5 flex flex-col gap-1.5 bg-panel2/30">
      <label
        className="flex items-center gap-1.5 cursor-pointer"
        title={
          'Input Conditioning smooths/filters the INCOMING Hardware-Mode OSC stream before anything else sees it: catch gates, overrides, State Triggers, the red live display, and MIDI out.\n\n' +
          'Stages run top to bottom. Each stage targets one OSC address (or all). Typical IMU chain per address: Median (kills spikes) then 1€ Filter (kills jitter without lag).\n\n' +
          'Auto Range rescales any raw sensor to 0..1 — no firmware normalization needed.'
        }
      >
        <input
          type="checkbox"
          checked={cfg.enabled}
          onChange={(e) =>
            setConditioner(template.id, { enabled: e.target.checked })
          }
        />
        <span
          className="label"
          style={{ color: cfg.enabled ? 'rgb(var(--c-accent))' : undefined }}
        >
          Input Conditioning
        </span>
        <span
          className="inline-flex items-center justify-center w-3 h-3 rounded-full text-[8px] cursor-help select-none shrink-0"
          style={{
            border: '1px solid rgb(var(--c-muted))',
            color: 'rgb(var(--c-muted))'
          }}
          aria-label="Help: Input Conditioning"
        >
          i
        </span>
        {cfg.enabled && cfg.stages.some((s) => s.enabled) && (
          <span
            className="text-[9px] font-bold"
            style={{ color: 'rgb(var(--c-accent))' }}
          >
            {cfg.stages.filter((s) => s.enabled).length} STAGE
            {cfg.stages.filter((s) => s.enabled).length > 1 ? 'S' : ''}
          </span>
        )}
      </label>
      {cfg.enabled && (
        <>
          <div className="flex flex-col gap-1">
            {cfg.stages.length === 0 && (
              <div className="text-[10px] text-muted italic">
                No stages yet — add one below. Signal passes through
                untouched.
              </div>
            )}
            {cfg.stages.map((stage, i) => (
              <StageRow
                key={stage.id}
                stage={stage}
                addresses={addresses}
                first={i === 0}
                last={i === cfg.stages.length - 1}
                onPatch={(p) => patchStage(stage.id, p)}
                onMove={(d) => moveStage(stage.id, d)}
                onRemove={() =>
                  setConditioner(template.id, {
                    stages: cfg.stages.filter((s) => s.id !== stage.id)
                  })
                }
              />
            ))}
          </div>
          <div className="flex items-center gap-1 flex-wrap">
            <select
              className="input text-[10px]"
              value={addType}
              onChange={(e) => setAddType(e.target.value as InputStageType)}
              title={INPUT_STAGE_INFO[addType].hint}
            >
              {STAGE_TYPES.map((t) => (
                <option key={t} value={t} title={INPUT_STAGE_INFO[t].hint}>
                  {INPUT_STAGE_INFO[t].label}
                </option>
              ))}
            </select>
            <span className="label">on</span>
            <select
              className="input text-[10px] min-w-0"
              style={{ maxWidth: 150 }}
              value={addAddress}
              onChange={(e) => setAddAddress(e.target.value)}
              title="Which OSC address this stage smooths. 'All addresses' applies it to every input of this instrument."
            >
              <option value="">All addresses</option>
              {addresses.map((a) => (
                <option key={a} value={a}>
                  {a}
                </option>
              ))}
            </select>
            <button
              className="btn text-[10px]"
              onClick={() =>
                setConditioner(template.id, {
                  stages: [
                    ...cfg.stages,
                    {
                      ...makeInputStage(addType),
                      ...(addAddress ? { address: addAddress } : {})
                    }
                  ]
                })
              }
              title={INPUT_STAGE_INFO[addType].hint}
            >
              + Add
            </button>
          </div>
          {/* Slot bypass — comma-separated arg-slot indices that skip
              the chain (keep a switch raw while smoothing the floats). */}
          <label className="flex items-center gap-1.5">
            <span
              className="label shrink-0"
              title="Arg-slot indices (comma-separated, 0-based) that BYPASS the chain entirely — e.g. keep a button/int slot raw while the float slots are smoothed. Applies across all addresses."
            >
              Bypass slots
            </span>
            <input
              className="input text-[10px] flex-1"
              placeholder="e.g. 0, 3"
              defaultValue={(cfg.slotBypass ?? []).join(', ')}
              onBlur={(e) => {
                const parsed = e.target.value
                  .split(',')
                  .map((s) => parseInt(s.trim(), 10))
                  .filter((n) => Number.isInteger(n) && n >= 0)
                setConditioner(template.id, { slotBypass: parsed })
              }}
            />
          </label>
          <TemplateScope template={template} addresses={addresses} />
        </>
      )}
    </div>
  )
}

function StageRow({
  stage,
  addresses,
  first,
  last,
  onPatch,
  onMove,
  onRemove
}: {
  stage: InputStage
  addresses: string[]
  first: boolean
  last: boolean
  onPatch: (p: Partial<InputStage>) => void
  onMove: (dir: -1 | 1) => void
  onRemove: () => void
}): JSX.Element {
  const info = INPUT_STAGE_INFO[stage.type]
  return (
    <div
      className="border border-border rounded px-1.5 py-1 flex flex-col gap-1"
      style={{ opacity: stage.enabled ? 1 : 0.5 }}
    >
      <div className="flex items-center gap-1.5 flex-wrap">
        <input
          type="checkbox"
          checked={stage.enabled}
          onChange={(e) => onPatch({ enabled: e.target.checked })}
          title="Enable / bypass this stage"
        />
        <span className="text-[10px] font-semibold shrink-0" title={info.hint}>
          {info.label}
        </span>
        {/* Address scope IS the title — shows exactly which input this
            stage smooths. */}
        <select
          className="input text-[10px] min-w-0"
          style={{
            maxWidth: 150,
            color: stage.address
              ? 'rgb(var(--c-accent))'
              : 'rgb(var(--c-muted))'
          }}
          value={stage.address ?? ''}
          onChange={(e) =>
            onPatch({ address: e.target.value || undefined })
          }
          title={
            stage.address
              ? `This stage smooths ${stage.address} only.`
              : 'This stage smooths EVERY address of the instrument. Pick one to scope it.'
          }
        >
          <option value="">◎ all addresses</option>
          {/* Keep showing a configured-but-now-missing address rather
              than silently reverting to "all". */}
          {stage.address && !addresses.includes(stage.address) && (
            <option value={stage.address}>{stage.address} (missing)</option>
          )}
          {addresses.map((a) => (
            <option key={a} value={a}>
              {a}
            </option>
          ))}
        </select>
        <div className="flex-1" />
        <button
          className="btn text-[9px] px-1"
          disabled={first}
          onClick={() => onMove(-1)}
          title="Move earlier in the chain"
        >
          ↑
        </button>
        <button
          className="btn text-[9px] px-1"
          disabled={last}
          onClick={() => onMove(1)}
          title="Move later in the chain"
        >
          ↓
        </button>
        <button
          className="btn text-[9px] px-1"
          onClick={onRemove}
          title="Remove stage"
        >
          ✕
        </button>
      </div>
      <StageParams stage={stage} onPatch={onPatch} />
    </div>
  )
}

function StageParams({
  stage,
  onPatch
}: {
  stage: InputStage
  onPatch: (p: Partial<InputStage>) => void
}): JSX.Element {
  return (
    <div className="flex items-center gap-2 flex-wrap">
      {stage.type === 'oneEuro' && (
        <>
          <MiniNum
            label="Min cutoff"
            title="Baseline smoothing at rest (Hz). LOWER = smoother but laggier on slow moves. Tune first with Beta = 0 until rest jitter disappears."
            value={stage.minCutoffHz ?? 1}
            min={0.01}
            max={20}
            onChange={(v) => onPatch({ minCutoffHz: v })}
          />
          <MiniNum
            label="Beta"
            title="Speed coefficient. HIGHER = less lag on fast moves. Tune second: raise until fast gestures stop feeling behind."
            value={stage.beta ?? 0.02}
            min={0}
            max={1}
            onChange={(v) => onPatch({ beta: v })}
          />
        </>
      )}
      {stage.type === 'smooth' && (
        <MiniNum
          label="Half-life ms"
          title="Time for the output to close half the distance to the input. Same one-pole math as the Slew modulator."
          value={stage.halfLifeMs ?? 60}
          min={1}
          max={5000}
          integer
          onChange={(v) => onPatch({ halfLifeMs: v })}
        />
      )}
      {stage.type === 'median' && (
        <label className="flex items-center gap-1">
          <span
            className="label"
            title="Window length — longer = stronger spike rejection, ~window/2 samples of latency."
          >
            Window
          </span>
          <select
            className="input text-[10px]"
            value={stage.window ?? 3}
            onChange={(e) => onPatch({ window: parseInt(e.target.value, 10) })}
          >
            {[3, 5, 7, 9].map((w) => (
              <option key={w} value={w}>
                {w}
              </option>
            ))}
          </select>
        </label>
      )}
      {stage.type === 'slewLimit' && (
        <MiniNum
          label="Max / sec"
          title="Hard cap on change rate, in the value's own units per second."
          value={stage.maxPerSec ?? 2}
          min={0.001}
          max={100000}
          onChange={(v) => onPatch({ maxPerSec: v })}
        />
      )}
      {stage.type === 'deadband' && (
        <MiniNum
          label="Epsilon"
          title="Changes smaller than this (from the last output) are ignored. Kills idle chatter from streaming sensors."
          value={stage.epsilon ?? 0.002}
          min={0}
          max={1000}
          onChange={(v) => onPatch({ epsilon: v })}
        />
      )}
      {stage.type === 'autoRange' && (
        <MiniNum
          label="Contract HL ms"
          title="How fast the tracked min/max forgets old extremes (half-life, ms). 0 = never forget (pure running min/max). Output is always rescaled to 0..1."
          value={stage.contractHalfLifeMs ?? 0}
          min={0}
          max={120000}
          integer
          onChange={(v) => onPatch({ contractHalfLifeMs: v })}
        />
      )}
    </div>
  )
}

function MiniNum({
  label,
  title,
  value,
  min,
  max,
  integer,
  onChange
}: {
  label: string
  title: string
  value: number
  min: number
  max: number
  integer?: boolean
  onChange: (v: number) => void
}): JSX.Element {
  return (
    <label className="flex items-center gap-1" title={title}>
      <span className="label">{label}</span>
      <BoundedNumberInput
        className="input w-16 text-[10px] text-right tabular-nums"
        value={value}
        min={min}
        max={max}
        integer={integer}
        commitOn="blur"
        onChange={onChange}
      />
    </label>
  )
}

// ── Reusable scope canvas ────────────────────────────────────────────
// Polls getConditionerScope({templateId,address,slot}) at ~15 Hz and
// draws raw (muted) vs conditioned (accent) traces. The poll itself
// keeps the engine-side watch alive; on unmount it just stops polling
// and the watch expires. Multiple canvases (template section + param
// inspector) coexist because watches are keyed per (template,address,
// slot).
export function ScopeCanvas({
  templateId,
  address,
  slot,
  height: initialHeight = 72
}: {
  templateId: string
  address: string
  slot: number
  height?: number
}): JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const scopeKey = `${templateId}|${address}|${slot}`
  const saved0 = scopePrefs.get(scopeKey)
  // Editable axes. windowSec = X span (seconds of history). yMin/yMax =
  // Y range. Both default from the first observed data (see fitToData)
  // then stay FIXED so the trace neither scrolls out nor jumps as the
  // range auto-recomputes — the user pins the frame and edits it.
  // Initial values come from this scope's saved prefs (if any) so each
  // Parameter restores its own frame.
  const [height, setHeight] = useState(saved0?.height ?? initialHeight)
  const [windowSec, setWindowSec] = useState(saved0?.windowSec ?? 5)
  const [yMin, setYMin] = useState(saved0?.yMin ?? 0)
  const [yMax, setYMax] = useState(saved0?.yMax ?? 1)
  const initedRef = useRef(saved0?.inited ?? false)
  const bufRef = useRef<{ t: number; raw: number; cond: number }[]>([])
  // Refs mirror the draw-time params so the single stable draw() closure
  // reads current values without the poll interval restarting.
  const paramsRef = useRef({ windowSec, yMin, yMax })
  paramsRef.current = { windowSec, yMin, yMax }

  const fitToData = useCallback(
    (buf: { raw: number; cond: number }[]) => {
      if (!buf.length) return
      let lo = Infinity
      let hi = -Infinity
      for (const p of buf) {
        lo = Math.min(lo, p.raw, p.cond)
        hi = Math.max(hi, p.raw, p.cond)
      }
      if (!Number.isFinite(lo) || !Number.isFinite(hi)) return
      if (!(hi > lo)) {
        lo -= 0.5
        hi += 0.5
      }
      const pad = (hi - lo) * 0.08
      const r = (n: number): number => Math.round(n * 1000) / 1000
      // Fitting counts as "framed" — so a saved/restored frame is never
      // clobbered by an auto-fit on the next data packet.
      initedRef.current = true
      setYMin(r(lo - pad))
      setYMax(r(hi + pad))
    },
    []
  )

  const draw = useCallback((): void => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    const W = canvas.width
    const H = canvas.height
    ctx.clearRect(0, 0, W, H)
    const buf = bufRef.current
    const { windowSec: winS, yMin: lo, yMax: hi } = paramsRef.current
    const span = hi > lo ? hi - lo : 1
    // Zero / mid gridline.
    ctx.strokeStyle = cssRgb('--c-border', 'rgb(80,80,80)')
    ctx.lineWidth = 1
    const yOf = (v: number): number => H - 2 - ((v - lo) / span) * (H - 4)
    if (lo < 0 && hi > 0) {
      const zy = yOf(0)
      ctx.beginPath()
      ctx.moveTo(0, zy)
      ctx.lineTo(W, zy)
      ctx.stroke()
    }
    if (buf.length < 2) return
    const tEnd = buf[buf.length - 1].t
    const tStart = tEnd - winS * 1000
    const xOf = (t: number): number =>
      ((t - tStart) / (winS * 1000)) * (W - 2) + 1
    const trace = (key: 'raw' | 'cond', color: string, w: number): void => {
      ctx.strokeStyle = color
      ctx.lineWidth = w
      ctx.beginPath()
      let started = false
      for (const p of buf) {
        if (p.t < tStart) continue
        const x = xOf(p.t)
        const y = yOf(p[key])
        if (!started) {
          ctx.moveTo(x, y)
          started = true
        } else ctx.lineTo(x, y)
      }
      ctx.stroke()
    }
    trace('raw', cssRgb('--c-muted', 'rgb(120,120,120)'), 1)
    trace('cond', cssRgb('--c-accent', 'rgb(255,140,0)'), 1.5)
  }, [])

  // Poll loop — restarts only when the watch identity or windowSec
  // (which bounds the requested history) changes.
  useEffect(() => {
    if (!address) return
    let alive = true
    const iv = setInterval(async () => {
      const buf = await window.api?.conditionerGetScope?.(
        { templateId, address, slot },
        windowSec * 1000
      )
      if (!alive || !buf) return
      bufRef.current = buf
      if (!initedRef.current && buf.length >= 2) {
        initedRef.current = true
        fitToData(buf)
      }
      draw()
    }, 66)
    return () => {
      alive = false
      clearInterval(iv)
    }
  }, [templateId, address, slot, windowSec, draw, fitToData])

  // Redraw immediately when a control changes (no need to wait for the
  // next poll tick), and when the canvas height changes.
  useEffect(() => {
    draw()
  }, [yMin, yMax, height, windowSec, draw])

  // Persist this scope's frame so it restores when the user comes back
  // to this Parameter (survives the remount switching Parameters does)
  // AND across sessions. Bumping scopePrefsRev flags App's session-flush
  // effect so autosave + saves capture the module-Map change.
  const bumpScopePrefsRev = useStore((s) => s.bumpScopePrefsRev)
  const bumpTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => {
    scopePrefs.set(scopeKey, {
      windowSec,
      yMin,
      yMax,
      height,
      inited: initedRef.current
    })
    // Debounce the store rev-bump: a HEIGHT DRAG fires onChange at
    // ~60-120 Hz, and each bump re-renders App + schedules a session
    // flush. Coalesce them into one bump ~250 ms after the last change.
    // The Map write above is immediate, so a manual save mid-drag still
    // captures the current frame.
    if (bumpTimerRef.current) clearTimeout(bumpTimerRef.current)
    bumpTimerRef.current = setTimeout(() => {
      bumpTimerRef.current = null
      bumpScopePrefsRev()
    }, 250)
  }, [scopeKey, windowSec, yMin, yMax, height, bumpScopePrefsRev])
  // Flush a pending bump on unmount so the final tweak still reaches
  // autosave even if the user navigates away right after changing it.
  useEffect(() => {
    return () => {
      if (bumpTimerRef.current) {
        clearTimeout(bumpTimerRef.current)
        bumpScopePrefsRev()
      }
    }
  }, [bumpScopePrefsRev])

  return (
    <div className="flex flex-col gap-1">
      {/* Axis controls */}
      <div className="flex items-center gap-1.5 flex-wrap text-[10px]">
        <label className="flex items-center gap-1" title="Time window shown, in seconds (X axis).">
          <span className="label">Time</span>
          <BoundedNumberInput
            className="input w-12 text-[10px] text-right tabular-nums"
            value={windowSec}
            min={0.5}
            max={30}
            commitOn="blur"
            onChange={(v) => setWindowSec(v)}
          />
          <span className="text-muted">s</span>
        </label>
        <label className="flex items-center gap-1" title="Value axis minimum (Y). Defaulted from the incoming data; edit to pin the frame.">
          <span className="label">Min</span>
          <BoundedNumberInput
            className="input w-14 text-[10px] text-right tabular-nums"
            value={yMin}
            min={-1e9}
            max={1e9}
            commitOn="blur"
            onChange={(v) => {
              initedRef.current = true
              setYMin(v)
            }}
          />
        </label>
        <label className="flex items-center gap-1" title="Value axis maximum (Y). Defaulted from the incoming data; edit to pin the frame.">
          <span className="label">Max</span>
          <BoundedNumberInput
            className="input w-14 text-[10px] text-right tabular-nums"
            value={yMax}
            min={-1e9}
            max={1e9}
            commitOn="blur"
            onChange={(v) => {
              initedRef.current = true
              setYMax(v)
            }}
          />
        </label>
        <button
          className="btn text-[9px] px-1"
          onClick={() => fitToData(bufRef.current)}
          title="Re-fit the value axis to the data currently on screen."
        >
          Auto
        </button>
      </div>
      {/* Canvas + vertical resize handle */}
      <div className="relative" style={{ height }}>
        <canvas
          ref={canvasRef}
          width={600}
          height={height}
          className="w-full border border-border rounded"
          style={{ height, background: 'rgb(var(--c-panel) / 0.6)' }}
        />
        <ResizeHandle
          direction="row"
          value={height}
          onChange={setHeight}
          min={40}
          max={480}
          className="absolute bottom-0 left-0 right-0 h-[6px] cursor-ns-resize"
          title="Drag to resize the scope height"
        />
      </div>
    </div>
  )
}

// Template-level scope with address + slot pickers, collapsed by default.
function TemplateScope({
  template,
  addresses
}: {
  template: InstrumentTemplate
  addresses: string[]
}): JSX.Element {
  const [open, setOpen] = useState(false)
  const [address, setAddress] = useState(addresses[0] ?? '')
  const [slot, setSlot] = useState(0)
  useEffect(() => {
    if (!addresses.includes(address)) setAddress(addresses[0] ?? '')
  }, [addresses, address])
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center gap-1.5">
        <button
          className="btn text-[10px]"
          onClick={() => setOpen((o) => !o)}
          title="Live raw-vs-conditioned scope. Grey = raw input, accent = after the chain. Wiggle the sensor and tune until the accent trace is as calm as you want without lagging."
        >
          {open ? '▾ Scope' : '▸ Scope'}
        </button>
        {open && (
          <>
            <select
              className="input text-[10px] flex-1 min-w-0"
              value={address}
              onChange={(e) => setAddress(e.target.value)}
              title="Which incoming OSC address to watch"
            >
              {addresses.length === 0 && (
                <option value="">(no addresses)</option>
              )}
              {addresses.map((a) => (
                <option key={a} value={a}>
                  {a}
                </option>
              ))}
            </select>
            <BoundedNumberInput
              className="input w-10 text-[10px] text-center tabular-nums"
              value={slot}
              min={0}
              max={31}
              integer
              onChange={(v) => setSlot(v)}
              title="Arg slot index to watch (0 for single-value addresses)"
            />
          </>
        )}
      </div>
      {open && address && (
        <ScopeCanvas
          key={`${template.id}|${address}|${slot}`}
          templateId={template.id}
          address={address}
          slot={slot}
        />
      )}
    </div>
  )
}

// ── Per-Parameter input scaling ──────────────────────────────────────
// Toggle-able device→output scaling for ONE Parameter, meant to sit
// right under the Parameter Name line in the grid inspector. Only
// rendered when the parent Instrument's Hardware Mode is ON ("enabled
// by Hardware Mode"). Edits the SAME template.hardwareMode.scaling[fnId]
// blob as the per-Parameter rows in HardwareModeSection — both stay in
// sync. Out bounds seed from the Parameter's declared min/max.
export function ParameterInputScaling({
  track,
  template
}: {
  track: Track
  template: InstrumentTemplate
}): JSX.Element | null {
  const setHardwareMode = useStore((s) => s.setTemplateHardwareMode)
  const fnId = track.sourceFunctionId ?? ''
  const fn = template.functions.find((f) => f.id === fnId)
  const sc = template.hardwareMode?.scaling?.[fnId]
  const enabled = sc?.enabled === true

  if (!fnId) return null

  const patchScale = (
    p: Partial<NonNullable<typeof sc>>
  ): void => {
    setHardwareMode(template.id, {
      scaling: {
        ...(template.hardwareMode?.scaling ?? {}),
        [fnId]: {
          enabled: false,
          inMin: 0,
          inMax: 1,
          outMin: fn?.min ?? 0,
          outMax: fn?.max ?? 1,
          ...sc,
          ...p
        }
      }
    })
  }

  return (
    <div className="border border-border rounded px-2 py-1 flex flex-col gap-1 bg-panel2/30">
      <label
        className="flex items-center gap-1.5 cursor-pointer"
        title={
          "Input Scaling maps this Parameter's incoming hardware values from the DEVICE range (In) to its OUTPUT range (Out), applied BEFORE the catch comparison — so e.g. a 0..360° sensor can catch and drive a 0..1 parameter. Swap the Out bounds to invert. Output is clamped to the Out range."
        }
      >
        <input
          type="checkbox"
          checked={enabled}
          onChange={(e) => patchScale({ enabled: e.target.checked })}
        />
        <span
          className="label"
          style={{ color: enabled ? 'rgb(var(--c-accent))' : undefined }}
        >
          Input Scaling
        </span>
        <span
          className="inline-flex items-center justify-center w-3 h-3 rounded-full text-[8px] cursor-help select-none shrink-0"
          style={{
            border: '1px solid rgb(var(--c-muted))',
            color: 'rgb(var(--c-muted))'
          }}
          aria-label="Help: Input Scaling"
        >
          i
        </span>
      </label>
      {enabled && sc && (
        <div className="flex items-center gap-1 flex-wrap text-[10px]">
          <span className="label">In</span>
          <BoundedNumberInput
            className="input w-14 text-[10px] text-right tabular-nums"
            value={sc.inMin}
            min={-1e9}
            max={1e9}
            commitOn="blur"
            onChange={(v) => patchScale({ inMin: v })}
            title="Device range low (what the controller sends)"
          />
          <BoundedNumberInput
            className="input w-14 text-[10px] text-right tabular-nums"
            value={sc.inMax}
            min={-1e9}
            max={1e9}
            commitOn="blur"
            onChange={(v) => patchScale({ inMax: v })}
            title="Device range high"
          />
          <span className="text-muted">→</span>
          <span className="label">Out</span>
          <BoundedNumberInput
            className="input w-14 text-[10px] text-right tabular-nums"
            value={sc.outMin}
            min={-1e9}
            max={1e9}
            commitOn="blur"
            onChange={(v) => patchScale({ outMin: v })}
            title="Output range low (swap with high to invert)"
          />
          <BoundedNumberInput
            className="input w-14 text-[10px] text-right tabular-nums"
            value={sc.outMax}
            min={-1e9}
            max={1e9}
            commitOn="blur"
            onChange={(v) => patchScale({ outMax: v })}
            title="Output range high (swap with low to invert)"
          />
        </div>
      )}
    </div>
  )
}

// ── Parameter editable Input Conditioning ────────────────────────────
// Editable smoothing chain scoped to ONE Parameter's OSC address, shown
// in the grid Parameter inspector. Edits the SAME
// template.inputConditioner.stages the Instrument inspector does (each
// stage added here carries address = this Parameter's address), so the
// two surfaces stay perfectly in sync and it all saves with the session.
// Global (all-address) stages that also touch this Parameter are shown
// read-only with a pointer to the Instrument inspector.
export function ParameterInputConditioning({
  track,
  template
}: {
  track: Track
  template: InstrumentTemplate
}): JSX.Element | null {
  const setConditioner = useStore((s) => s.setTemplateInputConditioner)
  const addresses = useTemplateAddresses(template.id)
  const address = track.defaultOscAddress ?? ''
  const [addType, setAddType] = useState<InputStageType>('oneEuro')
  if (!address) return null

  const cfg: InputConditionerConfig = template.inputConditioner ?? {
    enabled: false,
    stages: [],
    slotBypass: []
  }
  const mine = cfg.stages.filter((s) => s.address === address)
  const globals = cfg.stages.filter((s) => !s.address)

  const patchStage = (id: string, patch: Partial<InputStage>): void =>
    setConditioner(template.id, {
      stages: cfg.stages.map((s) => (s.id === id ? { ...s, ...patch } : s))
    })
  const removeStage = (id: string): void =>
    setConditioner(template.id, {
      stages: cfg.stages.filter((s) => s.id !== id)
    })
  const moveStage = (id: string, dir: -1 | 1): void => {
    const idx = cfg.stages.findIndex((s) => s.id === id)
    const to = idx + dir
    if (idx < 0 || to < 0 || to >= cfg.stages.length) return
    const next = cfg.stages.slice()
    const [st] = next.splice(idx, 1)
    next.splice(to, 0, st)
    setConditioner(template.id, { stages: next })
  }
  const addStage = (): void =>
    setConditioner(template.id, {
      // Adding a stage auto-enables the master switch so it actually
      // runs — otherwise a freshly-added stage would silently do nothing.
      enabled: true,
      stages: [...cfg.stages, { ...makeInputStage(addType), address }]
    })

  return (
    <div className="border border-border rounded p-1.5 flex flex-col gap-1.5 bg-panel2/30">
      <div className="flex items-center gap-1.5">
        <span
          className="label"
          style={{
            color:
              cfg.enabled && mine.some((s) => s.enabled)
                ? 'rgb(var(--c-accent))'
                : undefined
          }}
        >
          Input Conditioning
        </span>
        <span
          className="inline-flex items-center justify-center w-3 h-3 rounded-full text-[8px] cursor-help select-none shrink-0"
          style={{
            border: '1px solid rgb(var(--c-muted))',
            color: 'rgb(var(--c-muted))'
          }}
          title={`Smoothing for this Parameter's input (${address}). Same chain as the "${template.name}" instrument inspector — add it here or there, it stays in sync and saves with the session.`}
          aria-label="Help: Input Conditioning"
        >
          i
        </span>
      </div>
      {!cfg.enabled && cfg.stages.length > 0 && (
        <div className="text-[9px] text-muted italic">
          Instrument conditioning is switched OFF — these stages won't run
          until it's re-enabled (adding one turns it back on).
        </div>
      )}
      {mine.length === 0 && (
        <div className="text-[10px] text-muted italic">
          No smoothing on this input. Add a stage below.
        </div>
      )}
      {mine.map((stage, i) => (
        <StageRow
          key={stage.id}
          stage={stage}
          addresses={addresses}
          first={i === 0}
          last={i === mine.length - 1}
          onPatch={(p) => patchStage(stage.id, p)}
          onMove={(d) => moveStage(stage.id, d)}
          onRemove={() => removeStage(stage.id)}
        />
      ))}
      {globals.length > 0 && (
        <div className="text-[9px] text-muted">
          Also applied to all inputs:{' '}
          {globals.map((g) => INPUT_STAGE_INFO[g.type].label).join(', ')} —
          edit in the Instrument inspector.
        </div>
      )}
      <div className="flex items-center gap-1">
        <select
          className="input text-[10px] flex-1 min-w-0"
          value={addType}
          onChange={(e) => setAddType(e.target.value as InputStageType)}
          title={INPUT_STAGE_INFO[addType].hint}
        >
          {STAGE_TYPES.map((t) => (
            <option key={t} value={t} title={INPUT_STAGE_INFO[t].hint}>
              {INPUT_STAGE_INFO[t].label}
            </option>
          ))}
        </select>
        <button
          className="btn text-[10px]"
          onClick={addStage}
          title={`Add a ${INPUT_STAGE_INFO[addType].label} stage on ${address}.`}
        >
          + Add
        </button>
      </div>
    </div>
  )
}

// ── Parameter live scope + HW-bound badge ────────────────────────────
// The live "Hardware Input" monitor for a single Parameter: the
// HW-bound badge + the raw-vs-conditioned scope locked to this
// Parameter's address. Editing of smoothing/scaling happens in the
// dedicated panels above; this is the see-it surface.
export function ParameterConditioningReflection({
  track,
  template
}: {
  track: Track
  template: InstrumentTemplate
}): JSX.Element | null {
  const hw = template.hardwareMode
  const cond = template.inputConditioner
  const address = track.defaultOscAddress ?? ''
  const argCount = track.argSpec?.length ?? 1
  const [slot, setSlot] = useState(0)

  // Nothing to reflect if this instrument has no HW config at all.
  if (!hw && !cond) return null

  const hwBound = hw?.enabled === true
  const showScope = hwBound && address.length > 0

  return (
    <div className="border border-border rounded p-1.5 flex flex-col gap-1.5 bg-panel2/30">
      <div className="flex items-center gap-1.5">
        <span className="label">Hardware Input</span>
        <span className="text-[10px] text-muted truncate" title={address}>
          {address || '(no address)'}
        </span>
        <div className="flex-1" />
        <span
          className="text-[9px] font-bold shrink-0"
          style={{
            color: hwBound ? 'rgb(var(--c-danger))' : 'rgb(var(--c-muted))'
          }}
          title={
            hwBound
              ? `Hardware Mode is ON for the "${template.name}" instrument, bound to ${hw?.deviceIp}:${hw?.devicePort}. This Parameter's incoming values can drive its cells.`
              : `Hardware Mode is OFF for the "${template.name}" instrument. Enable it there to drive this Parameter from a controller.`
          }
        >
          {hwBound ? '● HW BOUND' : '○ no HW'}
        </span>
      </div>

      {/* Live scope for this parameter — locked to its address. */}
      {showScope ? (
        <div className="flex flex-col gap-1">
          <div className="flex items-center gap-1.5">
            <span className="label">Live</span>
            <span className="text-[9px] text-muted">
              grey = raw · accent = conditioned
            </span>
            <div className="flex-1" />
            {argCount > 1 && (
              <label className="flex items-center gap-1 text-[10px]">
                <span className="label">slot</span>
                <BoundedNumberInput
                  className="input w-10 text-[10px] text-center tabular-nums"
                  value={slot}
                  min={0}
                  max={argCount - 1}
                  integer
                  onChange={(v) => setSlot(v)}
                />
              </label>
            )}
          </div>
          <ScopeCanvas
            key={`${template.id}|${address}|${slot}`}
            templateId={template.id}
            address={address}
            slot={slot}
            height={56}
          />
        </div>
      ) : (
        <div className="text-[9px] text-muted italic">
          Enable Hardware Mode on the “{template.name}” instrument to see
          live input here.
        </div>
      )}
    </div>
  )
}
