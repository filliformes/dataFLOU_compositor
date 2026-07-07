// State Triggers section (v0.6) — "Wekinator-lite" pose/state
// detectors on the Instrument's incoming Hardware-Mode stream.
//
// Each State has a detector (explicit Rules, AND-combined, or a
// Learned centroid+variance model recorded by demonstration), a
// trigger mode (Enter+Exit / One-shot / Continuous match→CC), and
// actions (MIDI note or CC out + optionally trigger a dataFLOU scene).
//
// The engine evaluates states per incoming packet AFTER Input
// Conditioning (engine.ts evaluateStateTriggers); this component is
// the config surface + live match meters (polled ~10 Hz while
// rendered — same discipline as the HW Suppress panel).
//
// Embedded in BOTH the Pool TemplateInspector and the grid-side
// TrackInspector, like HardwareModeSection.

import { useEffect, useMemo, useState } from 'react'
import { useStore } from '../store'
import { BoundedNumberInput } from './BoundedNumberInput'
import { UncontrolledTextInput } from './UncontrolledInput'
import type {
  InstrumentTemplate,
  StateRule,
  StateRuleOp,
  StateTrigger,
  StateTriggerMode
} from '@shared/types'

const MODES: { id: StateTriggerMode; label: string; hint: string }[] = [
  {
    id: 'enterExit',
    label: 'Enter + Exit',
    hint: 'Note-on / CC-enter when the state is reached, note-off / CC-exit when it is left. Holding the pose = holding the effect.'
  },
  {
    id: 'oneShot',
    label: 'One-shot',
    hint: 'Fire once when the state is reached; re-arms after the state is left.'
  },
  {
    id: 'continuous',
    label: 'Continuous (match → CC)',
    hint: "Stream the live match score (0..1) as a CC (0..127) — 'how close am I to the pose' becomes an expressive controller."
  }
]

const OPS: { id: StateRuleOp; label: string }[] = [
  { id: 'eq', label: '=' },
  { id: 'range', label: 'in [a,b]' },
  { id: 'gt', label: '>' },
  { id: 'lt', label: '<' }
]

export function StateTriggersSection({
  template
}: {
  template: InstrumentTemplate
}): JSX.Element {
  const addStateTrigger = useStore((s) => s.addStateTrigger)
  const triggers = template.stateTriggers ?? []
  // Live match scores + active flags — one poll for the whole section.
  const [live, setLive] = useState<{
    scores: Record<string, number>
    active: Record<string, boolean>
  }>({ scores: {}, active: {} })
  useEffect(() => {
    if (triggers.length === 0) return
    let alive = true
    const iv = setInterval(async () => {
      const r = await window.api?.stateTriggerGetLive?.()
      if (alive && r) setLive(r)
    }, 100)
    return () => {
      alive = false
      clearInterval(iv)
    }
  }, [triggers.length])

  return (
    <div className="border border-border rounded p-1.5 flex flex-col gap-1.5 bg-panel2/30">
      <div
        className="flex items-center gap-1.5"
        title={
          'State Triggers watch the incoming Hardware-Mode stream and fire MIDI (and/or a dataFLOU scene) when the instrument reaches a defined state.\n\n' +
          'Two detector flavors per state:\n' +
          '• Rules — explicit per-address conditions, AND-combined. Deterministic.\n' +
          '• Learned — hold the pose, hit Record: the engine memorizes it (centroid + variance) and matches by distance, Wekinator-style.\n\n' +
          'Detection runs on the CONDITIONED stream — add smoothing in Input Conditioning above for stable triggers.'
        }
      >
        <span className="label">State Triggers</span>
        <span
          className="inline-flex items-center justify-center w-3 h-3 rounded-full text-[8px] cursor-help select-none shrink-0"
          style={{
            border: '1px solid rgb(var(--c-muted))',
            color: 'rgb(var(--c-muted))'
          }}
          aria-label="Help: State Triggers"
        >
          i
        </span>
        <div className="flex-1" />
        <button
          className="btn text-[10px]"
          onClick={() => addStateTrigger(template.id)}
          title="Add a new state"
        >
          + State
        </button>
      </div>
      {triggers.length === 0 && (
        <div className="text-[10px] text-muted italic">
          No states yet. A state is a combination of incoming OSC values
          (a pose, a zone, a gesture endpoint) that fires MIDI when
          reached.
        </div>
      )}
      {triggers.map((trig) => (
        <StateTriggerCard
          key={trig.id}
          template={template}
          trig={trig}
          score={live.scores[`${template.id}|${trig.id}`] ?? 0}
          isActive={live.active[`${template.id}|${trig.id}`] === true}
        />
      ))}
    </div>
  )
}

function StateTriggerCard({
  template,
  trig,
  score,
  isActive
}: {
  template: InstrumentTemplate
  trig: StateTrigger
  score: number
  isActive: boolean
}): JSX.Element {
  const updateStateTrigger = useStore((s) => s.updateStateTrigger)
  const removeStateTrigger = useStore((s) => s.removeStateTrigger)
  const tracks = useStore((s) => s.session.tracks)
  const scenes = useStore((s) => s.session.scenes)
  const [expanded, setExpanded] = useState(true)
  const [recording, setRecording] = useState(false)
  const [recordMs, setRecordMs] = useState(2000)
  const patch = (p: Partial<StateTrigger>): void =>
    updateStateTrigger(template.id, trig.id, p)

  const addresses = useMemo(() => {
    const out: string[] = []
    for (const t of tracks) {
      if (
        t.sourceTemplateId === template.id &&
        t.kind === 'function' &&
        t.defaultOscAddress &&
        !out.includes(t.defaultOscAddress)
      ) {
        out.push(t.defaultOscAddress)
      }
    }
    return out
  }, [tracks, template.id])

  async function record(): Promise<void> {
    setRecording(true)
    try {
      const result = await window.api?.stateTriggerRecord?.(
        template.id,
        trig.id,
        recordMs
      )
      if (result) {
        // Preserve a user-tuned threshold across re-records.
        patch({
          detector: 'learned',
          learned: {
            ...result,
            threshold: trig.learned?.threshold ?? result.threshold
          }
        })
      } else {
        window.alert(
          'Nothing recorded — the bound Hardware-Mode device sent no packets during the window. Check that HW Mode is enabled and the device is streaming.'
        )
      }
    } finally {
      setRecording(false)
    }
  }

  return (
    <div
      className="border border-border rounded px-1.5 py-1 flex flex-col gap-1"
      style={{
        opacity: trig.enabled ? 1 : 0.55,
        outline: isActive ? '1px solid rgb(var(--c-accent))' : undefined
      }}
    >
      {/* Header: enable, name, live meter, active pill, expand, delete */}
      <div className="flex items-center gap-1.5">
        <input
          type="checkbox"
          checked={trig.enabled}
          onChange={(e) => patch({ enabled: e.target.checked })}
          title="Enable / disable this state"
        />
        <UncontrolledTextInput
          size={2}
          className="input flex-1 min-w-0 text-[11px] font-semibold"
          value={trig.name}
          onChange={(v) => patch({ name: v })}
        />
        {/* Live match meter — the tuning feedback loop. */}
        <div
          className="w-16 h-2 rounded overflow-hidden border border-border shrink-0"
          title={`Live match: ${(score * 100).toFixed(0)}%`}
          style={{ background: 'rgb(var(--c-panel))' }}
        >
          <div
            className="h-full"
            style={{
              width: `${Math.round(score * 100)}%`,
              background: isActive
                ? 'rgb(var(--c-accent))'
                : 'rgb(var(--c-muted))'
            }}
          />
        </div>
        {isActive && (
          <span
            className="text-[9px] font-bold shrink-0"
            style={{ color: 'rgb(var(--c-accent))' }}
          >
            IN
          </span>
        )}
        <button
          className="btn text-[9px] px-1"
          onClick={() => setExpanded((x) => !x)}
          title={expanded ? 'Collapse' : 'Expand'}
        >
          {expanded ? '▾' : '▸'}
        </button>
        <button
          className="btn text-[9px] px-1"
          onClick={() => {
            if (window.confirm(`Delete state "${trig.name}"?`)) {
              removeStateTrigger(template.id, trig.id)
            }
          }}
          title="Delete state"
        >
          ✕
        </button>
      </div>
      {expanded && (
        <>
          {/* Detector + mode row */}
          <div className="flex items-center gap-2 flex-wrap">
            <label className="flex items-center gap-1">
              <span className="label">Detector</span>
              <select
                className="input text-[10px]"
                value={trig.detector}
                onChange={(e) =>
                  patch({ detector: e.target.value as 'rules' | 'learned' })
                }
              >
                <option value="rules">Rules</option>
                <option value="learned">Learned</option>
              </select>
            </label>
            <label className="flex items-center gap-1">
              <span className="label">Mode</span>
              <select
                className="input text-[10px]"
                value={trig.mode}
                onChange={(e) =>
                  patch({ mode: e.target.value as StateTriggerMode })
                }
                title={MODES.find((x) => x.id === trig.mode)?.hint}
              >
                {MODES.map((x) => (
                  <option key={x.id} value={x.id} title={x.hint}>
                    {x.label}
                  </option>
                ))}
              </select>
            </label>
            <label
              className="flex items-center gap-1"
              title="The state must match continuously for this long before it enters — debounces glancing passes through the zone."
            >
              <span className="label">Dwell ms</span>
              <BoundedNumberInput
                className="input w-12 text-[10px] text-right tabular-nums"
                value={trig.dwellMs}
                min={0}
                max={5000}
                integer
                commitOn="blur"
                onChange={(v) => patch({ dwellMs: v })}
              />
            </label>
            <label
              className="flex items-center gap-1"
              title="Exit hysteresis — the region is widened by this fraction for the exit test so a value dancing on the boundary can't machine-gun triggers."
            >
              <span className="label">Hyst</span>
              <BoundedNumberInput
                className="input w-12 text-[10px] text-right tabular-nums"
                value={trig.hysteresisPct}
                min={0}
                max={0.5}
                commitOn="blur"
                onChange={(v) => patch({ hysteresisPct: v })}
              />
            </label>
          </div>
          {/* Detector editor */}
          {trig.detector === 'rules' ? (
            <RulesEditor trig={trig} addresses={addresses} onPatch={patch} />
          ) : (
            <div className="flex flex-col gap-1">
              <div className="flex items-center gap-1.5 flex-wrap">
                <button
                  className="btn text-[10px]"
                  disabled={recording}
                  onClick={() => void record()}
                  style={
                    recording
                      ? { color: 'rgb(var(--c-danger))', borderColor: 'rgb(var(--c-danger))' }
                      : undefined
                  }
                  title="Hold the instrument in the target state, click, and KEEP HOLDING until the window ends. The engine memorizes the pose (centroid + variance across every address the device sends)."
                >
                  {recording ? '● Recording…' : '● Record'}
                </button>
                <BoundedNumberInput
                  className="input w-14 text-[10px] text-right tabular-nums"
                  value={recordMs}
                  min={250}
                  max={30000}
                  integer
                  commitOn="blur"
                  onChange={(v) => setRecordMs(v)}
                  title="Recording window in ms"
                />
                <span className="text-[10px] text-muted">
                  {trig.learned
                    ? `${trig.learned.dims.length} dims captured`
                    : 'nothing recorded yet'}
                </span>
              </div>
              {trig.learned && (
                <label
                  className="flex items-center gap-1.5"
                  title="Match threshold — the live score must reach this to enter the state. Watch the meter while holding the pose and set the threshold comfortably below what you see."
                >
                  <span className="label shrink-0">Threshold</span>
                  <input
                    type="range"
                    className="flex-1"
                    min={0.05}
                    max={0.99}
                    step={0.01}
                    value={trig.learned.threshold}
                    onChange={(e) =>
                      patch({
                        learned: {
                          ...trig.learned!,
                          threshold: parseFloat(e.target.value)
                        }
                      })
                    }
                  />
                  <span className="text-[10px] tabular-nums w-8 text-right">
                    {(trig.learned.threshold * 100).toFixed(0)}%
                  </span>
                </label>
              )}
            </div>
          )}
          <StateActionsEditor trig={trig} scenes={scenes} onPatch={patch} />
        </>
      )}
    </div>
  )
}

function RulesEditor({
  trig,
  addresses,
  onPatch
}: {
  trig: StateTrigger
  addresses: string[]
  onPatch: (p: Partial<StateTrigger>) => void
}): JSX.Element {
  function patchRule(idx: number, p: Partial<StateRule>): void {
    onPatch({
      rules: trig.rules.map((r, i) => (i === idx ? { ...r, ...p } : r))
    })
  }
  return (
    <div className="flex flex-col gap-1">
      {trig.rules.map((rule, i) => (
        <div key={i} className="flex items-center gap-1 flex-wrap">
          <select
            className="input text-[10px] min-w-0"
            style={{ maxWidth: 130 }}
            value={rule.address}
            onChange={(e) => patchRule(i, { address: e.target.value })}
          >
            {!addresses.includes(rule.address) && rule.address && (
              <option value={rule.address}>{rule.address}</option>
            )}
            {addresses.map((a) => (
              <option key={a} value={a}>
                {a}
              </option>
            ))}
          </select>
          <BoundedNumberInput
            className="input w-8 text-[10px] text-center tabular-nums"
            value={rule.slot}
            min={0}
            max={31}
            integer
            commitOn="blur"
            onChange={(v) => patchRule(i, { slot: v })}
            title="Arg slot index (0 for single-value addresses)"
          />
          <select
            className="input text-[10px]"
            value={rule.op}
            onChange={(e) => patchRule(i, { op: e.target.value as StateRuleOp })}
          >
            {OPS.map((o) => (
              <option key={o.id} value={o.id}>
                {o.label}
              </option>
            ))}
          </select>
          <BoundedNumberInput
            className="input w-14 text-[10px] text-right tabular-nums"
            value={rule.a}
            min={-1e9}
            max={1e9}
            commitOn="blur"
            onChange={(v) => patchRule(i, { a: v })}
            title={rule.op === 'range' ? 'Range low bound' : 'Comparison value'}
          />
          {rule.op === 'range' && (
            <BoundedNumberInput
              className="input w-14 text-[10px] text-right tabular-nums"
              value={rule.b ?? rule.a}
              min={-1e9}
              max={1e9}
              commitOn="blur"
              onChange={(v) => patchRule(i, { b: v })}
              title="Range high bound"
            />
          )}
          {rule.op === 'eq' && (
            <BoundedNumberInput
              className="input w-12 text-[10px] text-right tabular-nums"
              value={rule.tol ?? 0.02}
              min={0}
              max={1e9}
              commitOn="blur"
              onChange={(v) => patchRule(i, { tol: v })}
              title="Tolerance — |value − a| must be within this"
            />
          )}
          <button
            className="btn text-[9px] px-1"
            onClick={() =>
              onPatch({ rules: trig.rules.filter((_, j) => j !== i) })
            }
            title="Remove rule"
          >
            ✕
          </button>
        </div>
      ))}
      <button
        className="btn text-[10px] self-start"
        onClick={() =>
          onPatch({
            rules: [
              ...trig.rules,
              {
                address: addresses[0] ?? '',
                slot: 0,
                op: 'range',
                a: 0,
                b: 1
              }
            ]
          })
        }
        title="Add a condition. ALL conditions must hold for the state to match."
      >
        + Rule
      </button>
    </div>
  )
}

function StateActionsEditor({
  trig,
  scenes,
  onPatch
}: {
  trig: StateTrigger
  scenes: { id: string; name: string }[]
  onPatch: (p: Partial<StateTrigger>) => void
}): JSX.Element {
  const m = trig.actions.midi
  const [ports, setPorts] = useState<string[]>([])
  useEffect(() => {
    void window.api
      ?.midiListPorts?.()
      .then((r) => setPorts(r?.ports ?? []))
      .catch(() => setPorts([]))
  }, [])
  function patchMidi(p: Partial<NonNullable<StateTrigger['actions']['midi']>>): void {
    onPatch({
      actions: {
        ...trig.actions,
        midi: {
          enabled: true,
          portName: '',
          channel: 1,
          kind: 'note',
          note: 60,
          velocity: 100,
          cc: 20,
          ccEnterValue: 127,
          ccExitValue: 0,
          ...m,
          ...p
        }
      }
    })
  }
  return (
    <div className="border-t border-border pt-1 flex flex-col gap-1">
      <div className="flex items-center gap-1.5 flex-wrap">
        <label className="flex items-center gap-1" title="Send MIDI when the state fires">
          <input
            type="checkbox"
            checked={m?.enabled === true}
            onChange={(e) => patchMidi({ enabled: e.target.checked })}
          />
          <span className="label">MIDI</span>
        </label>
        {m?.enabled && (
          <>
            <select
              className="input text-[10px] min-w-0"
              style={{ maxWidth: 120 }}
              value={m.portName}
              onChange={(e) => patchMidi({ portName: e.target.value })}
              title="MIDI output port"
            >
              <option value="">(pick a port)</option>
              {!ports.includes(m.portName) && m.portName && (
                <option value={m.portName}>{m.portName}</option>
              )}
              {ports.map((p) => (
                <option key={p} value={p}>
                  {p}
                </option>
              ))}
            </select>
            <label className="flex items-center gap-1">
              <span className="label">Ch</span>
              <BoundedNumberInput
                className="input w-8 text-[10px] text-center tabular-nums"
                value={m.channel}
                min={1}
                max={16}
                integer
                commitOn="blur"
                onChange={(v) => patchMidi({ channel: v })}
              />
            </label>
            <select
              className="input text-[10px]"
              value={m.kind}
              onChange={(e) => patchMidi({ kind: e.target.value as 'note' | 'cc' })}
              // Continuous mode streams the match score to the CC — the
              // kind selector still matters for enter/exit modes.
              title={
                trig.mode === 'continuous'
                  ? 'Continuous mode streams the match score to the CC number below (kind Note is ignored in continuous mode).'
                  : 'Note: noteOn at enter / noteOff at exit. CC: enter/exit values below.'
              }
            >
              <option value="note">Note</option>
              <option value="cc">CC</option>
            </select>
            {m.kind === 'note' ? (
              <>
                <label className="flex items-center gap-1">
                  <span className="label">Note</span>
                  <BoundedNumberInput
                    className="input w-10 text-[10px] text-center tabular-nums"
                    value={m.note ?? 60}
                    min={0}
                    max={127}
                    integer
                    commitOn="blur"
                    onChange={(v) => patchMidi({ note: v })}
                  />
                </label>
                <label className="flex items-center gap-1">
                  <span className="label">Vel</span>
                  <BoundedNumberInput
                    className="input w-10 text-[10px] text-center tabular-nums"
                    value={m.velocity ?? 100}
                    min={1}
                    max={127}
                    integer
                    commitOn="blur"
                    onChange={(v) => patchMidi({ velocity: v })}
                  />
                </label>
              </>
            ) : (
              <>
                <label className="flex items-center gap-1">
                  <span className="label">CC</span>
                  <BoundedNumberInput
                    className="input w-10 text-[10px] text-center tabular-nums"
                    value={m.cc ?? 20}
                    min={0}
                    max={127}
                    integer
                    commitOn="blur"
                    onChange={(v) => patchMidi({ cc: v })}
                  />
                </label>
                {trig.mode !== 'continuous' && (
                  <>
                    <label className="flex items-center gap-1" title="CC value sent at enter">
                      <span className="label">In</span>
                      <BoundedNumberInput
                        className="input w-10 text-[10px] text-center tabular-nums"
                        value={m.ccEnterValue ?? 127}
                        min={0}
                        max={127}
                        integer
                        commitOn="blur"
                        onChange={(v) => patchMidi({ ccEnterValue: v })}
                      />
                    </label>
                    {trig.mode === 'enterExit' && (
                      <label className="flex items-center gap-1" title="CC value sent at exit">
                        <span className="label">Out</span>
                        <BoundedNumberInput
                          className="input w-10 text-[10px] text-center tabular-nums"
                          value={m.ccExitValue ?? 0}
                          min={0}
                          max={127}
                          integer
                          commitOn="blur"
                          onChange={(v) => patchMidi({ ccExitValue: v })}
                        />
                      </label>
                    )}
                  </>
                )}
              </>
            )}
          </>
        )}
      </div>
      <label
        className="flex items-center gap-1.5"
        title="Also trigger a dataFLOU scene when the state enters (a pose literally plays the compositor). The scene runs its own lifecycle — exiting the state does not stop it."
      >
        <span className="label shrink-0">Scene</span>
        <select
          className="input text-[10px] flex-1 min-w-0"
          value={trig.actions.triggerSceneId ?? ''}
          onChange={(e) =>
            onPatch({
              actions: {
                ...trig.actions,
                ...(e.target.value
                  ? { triggerSceneId: e.target.value }
                  : { triggerSceneId: undefined })
              }
            })
          }
        >
          <option value="">(none)</option>
          {scenes.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>
      </label>
    </div>
  )
}
