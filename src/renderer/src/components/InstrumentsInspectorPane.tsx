// Instruments Inspector pane — rightmost section of the OSC-monitor
// drawer. When a Pool item (Template or Function) is selected, this pane
// renders a form to edit its fields. Builtin templates render read-only.
//
// The fields mirror dataFLOU's `ParamMeta` vocabulary so the eventual
// import / export to the C++ library's JSON config is mechanical:
//   • paramType ↔ ParamType
//   • nature ↔ Nature
//   • streamMode ↔ StreamMode
//   • unit ↔ unit
//   • min / max / init ↔ range_min / range_max / range_init

import { useEffect, useState } from 'react'
import { useStore } from '../store'
import { BoundedNumberInput } from './BoundedNumberInput'
import { UncontrolledTextInput } from './UncontrolledInput'
import type {
  FunctionParamNature,
  FunctionParamType,
  FunctionStreamMode,
  InstrumentFunction,
  InstrumentTemplate,
  ParamArgSpec,
  ParameterTemplate
} from '@shared/types'

const PARAM_TYPES: { id: FunctionParamType; label: string }[] = [
  { id: 'bool', label: 'Bool' },
  { id: 'int', label: 'Int' },
  { id: 'float', label: 'Float' },
  { id: 'v2', label: 'V2 (xy)' },
  { id: 'v3', label: 'V3 (xyz)' },
  { id: 'v4', label: 'V4 (rgba/quat)' },
  { id: 'colour', label: 'Colour' },
  { id: 'string', label: 'String' }
]
const NATURES: { id: FunctionParamNature; label: string }[] = [
  { id: 'lin', label: 'Linear' },
  { id: 'log', label: 'Logarithmic' },
  { id: 'exp', label: 'Exponential' }
]
const STREAM_MODES: { id: FunctionStreamMode; label: string }[] = [
  { id: 'streaming', label: 'Streaming' },
  { id: 'discrete', label: 'Discrete' },
  { id: 'polling', label: 'Polling' }
]

export default function InstrumentsInspectorPane(): JSX.Element {
  const sel = useStore((s) => s.poolSelection)
  const templates = useStore((s) => s.session.pool.templates)
  if (!sel) {
    return (
      <div className="flex flex-col h-full min-h-0">
        <Header title="Instrument Inspector" />
        <div className="p-3 text-muted text-[11px]">
          Select a Template or Parameter in the Pool to edit it. Drag any item
          onto the Edit-view sidebar to instantiate it as an Instrument row.
        </div>
      </div>
    )
  }
  // SavedScene selections — fetched from the global library, rendered
  // with the SceneInspector-style metadata fields plus a read-only
  // breakdown of the Instruments + Parameters bundled with the scene.
  if (sel.kind === 'savedScene') {
    return <SavedSceneInspector savedSceneId={sel.savedSceneId} />
  }
  // ParameterTemplate selections handled below; Template / Function selections
  // both reference a template by templateId.
  if (sel.kind === 'parameter') {
    return <ParameterTemplateInspector parameterId={sel.parameterId} />
  }
  const template = templates.find((t) => t.id === sel.templateId)
  if (!template) {
    return (
      <div className="flex flex-col h-full min-h-0">
        <Header title="Instrument Inspector" />
        <div className="p-3 text-muted text-[11px]">Selection is stale — pick another item.</div>
      </div>
    )
  }
  if (sel.kind === 'template') {
    return <TemplateInspector template={template} />
  }
  const fn = template.functions.find((f) => f.id === sel.functionId)
  if (!fn) {
    return (
      <div className="flex flex-col h-full min-h-0">
        <Header title="Instrument Inspector" />
        <div className="p-3 text-muted text-[11px]">Parameter no longer exists.</div>
      </div>
    )
  }
  return <FunctionInspector template={template} fn={fn} />
}

function Header({ title }: { title: string }): JSX.Element {
  return (
    <div className="flex items-center gap-2 px-2 py-1 border-b border-border shrink-0">
      <span className="label">{title}</span>
    </div>
  )
}

function TemplateInspector({
  template
}: {
  template: InstrumentTemplate
}): JSX.Element {
  const updateTemplate = useStore((s) => s.updateTemplate)
  const readonly = !!template.builtin

  return (
    <div className="flex flex-col h-full min-h-0">
      <Header title={`Template — ${template.name}${readonly ? ' (built-in)' : ''}`} />
      <div className="flex-1 min-h-0 overflow-y-auto p-2 flex flex-col gap-2 text-[11px]">
        {readonly && (
          <div className="text-[10px] text-muted italic">
            Built-in templates are read-only. Use the ⎘ button in the Pool to
            clone this into an editable user template.
          </div>
        )}

        <Field label="Name">
          <UncontrolledTextInput
            className="input text-[11px] py-0.5 w-full"
            value={template.name}
            onChange={(v) => updateTemplate(template.id, { name: v })}
            disabled={readonly}
          />
        </Field>

        {/* Hardware Mode — sits directly under the name as the user
            specified. Visible (and editable) even on built-in
            templates because HW Mode is a per-session preference,
            not a definitional change to the template. */}
        <HardwareModeSection template={template} />

        <Field label="Description">
          <UncontrolledTextInput
            className="input text-[11px] py-0.5 w-full"
            value={template.description}
            onChange={(v) => updateTemplate(template.id, { description: v })}
            disabled={readonly}
            placeholder="What is this template for?"
          />
        </Field>

        <Field label="Color">
          <input
            type="color"
            className="w-full h-6 rounded border border-border bg-transparent cursor-pointer disabled:cursor-default"
            value={template.color}
            onChange={(e) => updateTemplate(template.id, { color: e.target.value })}
            disabled={readonly}
          />
        </Field>

        <Field label="Default IP : Port">
          <div className="flex items-center gap-1">
            <UncontrolledTextInput
              className="input text-[11px] py-0.5 flex-1 min-w-0"
              value={template.destIp}
              onChange={(v) => updateTemplate(template.id, { destIp: v })}
              disabled={readonly}
              placeholder="127.0.0.1"
            />
            <span className="text-muted">:</span>
            <BoundedNumberInput
              className="input text-[11px] py-0.5 w-16"
              value={template.destPort}
              onChange={(v) => updateTemplate(template.id, { destPort: v })}
              min={1}
              max={65535}
              integer
              disabled={readonly}
            />
          </div>
        </Field>

        <Field label="OSC base path">
          <UncontrolledTextInput
            className="input text-[11px] py-0.5 w-full font-mono"
            value={template.oscAddressBase}
            onChange={(v) => updateTemplate(template.id, { oscAddressBase: v })}
            disabled={readonly}
            placeholder="/instrument"
          />
        </Field>

        <Field label="Voices">
          <BoundedNumberInput
            className="input text-[11px] py-0.5 w-full"
            value={template.voices}
            onChange={(v) => updateTemplate(template.id, { voices: v })}
            min={1}
            max={32}
            integer
            disabled={readonly}
          />
        </Field>

        <div className="text-[10px] text-muted italic mt-1">
          Voices is informational for now — the engine treats every cell as
          monophonic. Polyphonic allocation lands with the Pool engine work.
        </div>
      </div>
    </div>
  )
}

function FunctionInspector({
  template,
  fn
}: {
  template: InstrumentTemplate
  fn: InstrumentFunction
}): JSX.Element {
  const updateFunction = useStore((s) => s.updateFunction)
  const readonly = !!template.builtin
  function patch(p: Partial<InstrumentFunction>): void {
    updateFunction(template.id, fn.id, p)
  }
  return (
    <div className="flex flex-col h-full min-h-0">
      <Header title={`Parameter — ${template.name} ▸ ${fn.name}${readonly ? ' (built-in)' : ''}`} />
      <div className="flex-1 min-h-0 overflow-y-auto p-2 flex flex-col gap-2 text-[11px]">
        {readonly && (
          <div className="text-[10px] text-muted italic">
            Built-in parameters are read-only. Clone the parent Template to edit.
          </div>
        )}

        <Field label="Name">
          <UncontrolledTextInput
            className="input text-[11px] py-0.5 w-full"
            value={fn.name}
            onChange={(v) => patch({ name: v })}
            disabled={readonly}
          />
        </Field>

        <Field label="OSC path">
          <UncontrolledTextInput
            className="input text-[11px] py-0.5 w-full font-mono"
            value={fn.oscPath}
            onChange={(v) => patch({ oscPath: v })}
            disabled={readonly}
            placeholder="volume"
          />
        </Field>
        <div className="text-[10px] text-muted -mt-1">
          Resolved address: <span className="font-mono">{resolveOsc(template, fn)}</span>
        </div>

        <Field label="Type">
          <select
            className="input text-[11px] py-0.5 w-full"
            value={fn.paramType}
            onChange={(e) => patch({ paramType: e.target.value as FunctionParamType })}
            disabled={readonly}
          >
            {PARAM_TYPES.map((t) => (
              <option key={t.id} value={t.id}>
                {t.label}
              </option>
            ))}
          </select>
        </Field>

        <div className="grid grid-cols-3 gap-1">
          <Field label="Min">
            <BoundedNumberInput
              className="input text-[11px] py-0.5 w-full"
              value={fn.min ?? 0}
              onChange={(v) => patch({ min: v })}
              min={-1e9}
              max={1e9}
              disabled={readonly}
            />
          </Field>
          <Field label="Max">
            <BoundedNumberInput
              className="input text-[11px] py-0.5 w-full"
              value={fn.max ?? 1}
              onChange={(v) => patch({ max: v })}
              min={-1e9}
              max={1e9}
              disabled={readonly}
            />
          </Field>
          <Field label="Init">
            <BoundedNumberInput
              className="input text-[11px] py-0.5 w-full"
              value={fn.init ?? 0}
              onChange={(v) => patch({ init: v })}
              min={-1e9}
              max={1e9}
              disabled={readonly}
            />
          </Field>
        </div>

        <Field label="Nature">
          <select
            className="input text-[11px] py-0.5 w-full"
            value={fn.nature}
            onChange={(e) => patch({ nature: e.target.value as FunctionParamNature })}
            disabled={readonly}
          >
            {NATURES.map((n) => (
              <option key={n.id} value={n.id}>
                {n.label}
              </option>
            ))}
          </select>
        </Field>

        <Field label="Stream mode">
          <select
            className="input text-[11px] py-0.5 w-full"
            value={fn.streamMode}
            onChange={(e) => patch({ streamMode: e.target.value as FunctionStreamMode })}
            disabled={readonly}
            title="Streaming = continuous (e.g. position). Discrete = events. Polling = read-on-demand."
          >
            {STREAM_MODES.map((m) => (
              <option key={m.id} value={m.id}>
                {m.label}
              </option>
            ))}
          </select>
        </Field>

        <Field label="Unit">
          <UncontrolledTextInput
            className="input text-[11px] py-0.5 w-full"
            value={fn.unit ?? ''}
            onChange={(v) => patch({ unit: v || undefined })}
            disabled={readonly}
            placeholder="Hz, dB, °, RGBA…"
          />
        </Field>

        <Field label="Notes">
          <UncontrolledTextInput
            className="input text-[11px] py-0.5 w-full"
            value={fn.notes ?? ''}
            onChange={(v) => patch({ notes: v || undefined })}
            disabled={readonly}
            placeholder="Free-form note about this parameter"
          />
        </Field>

        {/* Arg Layout — the multi-arg argSpec editor. Lets the user
            split a Parameter's outgoing OSC bundle into pinned
            (fixed protocol prefix) and editable (value) slots, then
            edit each slot's name / type / fixed value or init value.
            Required for OCTOCOSME-style parameters whose every
            address fires `siffffff` with the first two args being
            an IP + sequence-int that we pin, and the trailing
            floats being modulatable values. */}
        <ParameterArgSpecSection fn={fn} onChange={patch} readonly={readonly} />

        {/* MIDI Output default — sets what every new cell on this
            Parameter inherits at creation. Per-cell overrides go on
            Cell.midiOut. Setting this here means: create a Parameter
            with MIDI pre-wired, drag it into a Scene, the new cell
            already has the MIDI section configured (enable/disable
            per cell from the cell inspector). */}
        <ParameterMidiSection fn={fn} onChange={patch} readonly={readonly} />
      </div>
    </div>
  )
}

// Arg Layout editor — drives a Parameter's `argSpec`. When the array
// is missing (or single-entry), the Parameter emits a single value
// inferred from `paramType`. When it has 2+ entries, each entry is
// either PINNED (a fixed protocol prefix invisibly prepended) or
// EDITABLE (a user-controllable slot the cell can modulate/sequence).
//
// OCTOCOSME's `/A/strips/pots` for example becomes:
//   [{ type: 'string', fixed: '192.168.101.191' },  // IP prefix
//    { type: 'int',    fixed: 17 },                  // sequence id
//    { type: 'float',  init: 0, min: 0, max: 1 },    // pot 1
//    { type: 'float',  init: 0, min: 0, max: 1 },    // pot 2
//    … ]
//
// Capture's `buildOscTemplate` writes argSpec automatically when
// observing multi-arg traffic — this UI lets the user adjust or
// hand-author it after the fact.
const ARG_TYPES: { id: ParamArgSpec['type']; label: string }[] = [
  { id: 'float', label: 'Float' },
  { id: 'int', label: 'Int' },
  { id: 'string', label: 'String' },
  { id: 'bool', label: 'Bool' }
]
function ParameterArgSpecSection({
  fn,
  onChange,
  readonly
}: {
  fn: InstrumentFunction
  onChange: (patch: Partial<InstrumentFunction>) => void
  readonly: boolean
}): JSX.Element {
  const spec = fn.argSpec ?? []
  const [open, setOpen] = useState<boolean>(spec.length > 1)
  function setSpec(next: ParamArgSpec[]): void {
    onChange({ argSpec: next.length > 0 ? next : undefined })
  }
  function addSlot(): void {
    setSpec([
      ...spec,
      {
        name: `Value ${spec.filter((s) => s.fixed === undefined).length + 1}`,
        type: 'float',
        init: 0,
        min: 0,
        max: 1
      }
    ])
  }
  function removeSlot(i: number): void {
    setSpec(spec.filter((_, idx) => idx !== i))
  }
  function patchSlot(i: number, p: Partial<ParamArgSpec>): void {
    setSpec(spec.map((s, idx) => (idx === i ? { ...s, ...p } : s)))
  }
  function togglePinned(i: number, pinned: boolean): void {
    const s = spec[i]
    if (!s) return
    if (pinned) {
      // Convert editable → pinned. Capture the current init as the
      // fixed value so the in-flight bundle keeps emitting the same
      // token the user has been seeing live.
      const defaultFixed: number | string | boolean =
        s.type === 'string'
          ? typeof s.init === 'string'
            ? s.init
            : ''
          : s.type === 'bool'
            ? !!s.init
            : typeof s.init === 'number'
              ? s.init
              : 0
      patchSlot(i, { fixed: defaultFixed, init: undefined, min: undefined, max: undefined })
    } else {
      // Convert pinned → editable. Move the fixed value into init.
      const moveBack: number | string | boolean | undefined = s.fixed
      const isNum = typeof moveBack === 'number'
      patchSlot(i, {
        fixed: undefined,
        init:
          typeof moveBack === 'number' || typeof moveBack === 'string' || typeof moveBack === 'boolean'
            ? moveBack
            : 0,
        min: isNum ? 0 : undefined,
        max: isNum ? 1 : undefined
      })
    }
  }
  return (
    <div className="flex flex-col gap-1 pt-2 mt-1 border-t border-border">
      <button
        type="button"
        className="flex items-center justify-between w-full text-left"
        onClick={() => setOpen((v) => !v)}
        title="Argument layout for the outgoing OSC bundle — split into pinned protocol prefixes (fixed) and editable value slots."
      >
        <span className="label">Arg Layout</span>
        <span className="text-muted text-[10px]">
          {spec.length === 0
            ? 'single-arg (default)'
            : `${spec.length} slot${spec.length === 1 ? '' : 's'} · ${spec.filter((s) => s.fixed !== undefined).length} pinned`}{' '}
          {open ? '▾' : '▸'}
        </span>
      </button>
      {open && (
        <>
          <div className="text-[10px] text-muted leading-snug">
            Define each slot of the outgoing OSC bundle. Pin a slot
            to send a constant token (typically a protocol prefix
            like an IP or sequence id). Leave a slot un-pinned to
            make it user-editable + modulatable per cell.
          </div>
          {spec.length === 0 ? (
            <div className="text-[10px] text-muted italic">
              No multi-arg layout — Parameter uses its single Type
              setting above. Click <span className="text-text">+ Add slot</span> to
              start building a layout.
            </div>
          ) : (
            <div className="flex flex-col gap-0.5">
              {/* Header row */}
              <div className="grid grid-cols-[1fr_72px_64px_1fr_18px] gap-1 text-[9px] uppercase tracking-wide text-muted px-0.5">
                <span>Name</span>
                <span>Type</span>
                <span title="Pinned = fixed protocol prefix (invisible in cells). Un-pinned = editable value.">
                  Pinned
                </span>
                <span>Value</span>
                <span />
              </div>
              {spec.map((s, i) => {
                const isPinned = s.fixed !== undefined
                return (
                  <div
                    key={i}
                    className="grid grid-cols-[1fr_72px_64px_1fr_18px] gap-1 items-center"
                  >
                    <UncontrolledTextInput
                      className="input text-[10px] py-0.5 w-full"
                      value={s.name}
                      onChange={(v) => patchSlot(i, { name: v })}
                      disabled={readonly}
                      placeholder={isPinned ? `Prefix ${i + 1}` : `Value ${i + 1}`}
                    />
                    <select
                      className="input text-[10px] py-0.5 w-full"
                      value={s.type}
                      onChange={(e) =>
                        patchSlot(i, { type: e.target.value as ParamArgSpec['type'] })
                      }
                      disabled={readonly}
                    >
                      {ARG_TYPES.map((t) => (
                        <option key={t.id} value={t.id}>
                          {t.label}
                        </option>
                      ))}
                    </select>
                    <label className="flex items-center justify-center cursor-pointer">
                      <input
                        type="checkbox"
                        checked={isPinned}
                        onChange={(e) => togglePinned(i, e.target.checked)}
                        disabled={readonly}
                        title={
                          isPinned
                            ? 'Un-pin: make this slot user-editable on every cell'
                            : 'Pin: emit a fixed token regardless of cell value'
                        }
                      />
                    </label>
                    {isPinned ? (
                      <ArgFixedInput
                        type={s.type}
                        value={s.fixed!}
                        onChange={(v) => patchSlot(i, { fixed: v })}
                        readonly={readonly}
                      />
                    ) : (
                      <ArgEditableInput
                        type={s.type}
                        value={s.init}
                        onChange={(v) => patchSlot(i, { init: v })}
                        readonly={readonly}
                      />
                    )}
                    <button
                      className="text-muted hover:text-danger text-[14px] leading-none px-1"
                      onClick={() => removeSlot(i)}
                      disabled={readonly}
                      title="Remove this slot"
                    >
                      ×
                    </button>
                  </div>
                )
              })}
            </div>
          )}
          <div className="flex items-center gap-1.5 pt-1">
            <button
              type="button"
              className="btn text-[10px] py-0.5"
              onClick={addSlot}
              disabled={readonly}
              title="Append a new editable slot"
            >
              + Add slot
            </button>
            {spec.length > 0 && (
              <button
                type="button"
                className="btn text-[10px] py-0.5"
                onClick={() => setSpec([])}
                disabled={readonly}
                title="Clear the entire arg layout (Parameter falls back to single-arg via the Type select above)"
              >
                Clear all
              </button>
            )}
          </div>
        </>
      )}
    </div>
  )
}

// Input for a PINNED slot's fixed value. Picks the right widget per
// type — number input for float/int, text input for string, checkbox
// for bool.
function ArgFixedInput({
  type,
  value,
  onChange,
  readonly
}: {
  type: ParamArgSpec['type']
  value: number | string | boolean
  onChange: (v: number | string | boolean) => void
  readonly: boolean
}): JSX.Element {
  if (type === 'bool') {
    return (
      <input
        type="checkbox"
        checked={!!value}
        onChange={(e) => onChange(e.target.checked)}
        disabled={readonly}
      />
    )
  }
  if (type === 'string') {
    return (
      <UncontrolledTextInput
        className="input text-[10px] py-0.5 w-full font-mono"
        value={typeof value === 'string' ? value : String(value)}
        onChange={(v) => onChange(v)}
        disabled={readonly}
      />
    )
  }
  return (
    <BoundedNumberInput
      className="input text-[10px] py-0.5 w-full tabular-nums"
      value={typeof value === 'number' ? value : 0}
      onChange={(v) => onChange(v)}
      min={-1e9}
      max={1e9}
      integer={type === 'int'}
      disabled={readonly}
    />
  )
}

// Input for an EDITABLE slot's init value. Same widget rules as
// ArgFixedInput, but stored to `init` instead of `fixed`. The
// per-cell value at instantiation seeds from this.
function ArgEditableInput({
  type,
  value,
  onChange,
  readonly
}: {
  type: ParamArgSpec['type']
  value: number | string | boolean | undefined
  onChange: (v: number | string | boolean) => void
  readonly: boolean
}): JSX.Element {
  if (type === 'bool') {
    return (
      <input
        type="checkbox"
        checked={!!value}
        onChange={(e) => onChange(e.target.checked)}
        disabled={readonly}
      />
    )
  }
  if (type === 'string') {
    return (
      <UncontrolledTextInput
        className="input text-[10px] py-0.5 w-full font-mono"
        value={typeof value === 'string' ? value : ''}
        onChange={(v) => onChange(v)}
        disabled={readonly}
        placeholder="init"
      />
    )
  }
  return (
    <BoundedNumberInput
      className="input text-[10px] py-0.5 w-full tabular-nums"
      value={typeof value === 'number' ? value : 0}
      onChange={(v) => onChange(v)}
      min={-1e9}
      max={1e9}
      integer={type === 'int'}
      disabled={readonly}
    />
  )
}

// MIDI Output section for the Parameter (InstrumentFunction)
// Inspector. Mirrors the cell-level MidiOutputSection — Port +
// Channel + CC/Note + CC number / Note gate — but stores defaults
// on the Parameter so freshly-created cells inherit them.
function ParameterMidiSection({
  fn,
  onChange,
  readonly
}: {
  fn: InstrumentFunction
  onChange: (patch: Partial<InstrumentFunction>) => void
  readonly: boolean
}): JSX.Element {
  // Default to the canonical "disabled CC on ch 1 / CC 1" so the
  // section renders intelligibly even when the Parameter has never
  // had MIDI configured before.
  const m =
    fn.midiOut ??
    ({
      enabled: false,
      portName: '',
      channel: 1,
      kind: 'cc' as const,
      cc: 1,
      noteMode: 'velocity' as const,
      gateLengthMs: 0
    } satisfies InstrumentFunction['midiOut'])
  function setMidi(p: Partial<NonNullable<InstrumentFunction['midiOut']>>): void {
    onChange({ midiOut: { ...m, ...p } })
  }
  const [ports, setPorts] = useState<string[]>([])
  const [available, setAvailable] = useState<boolean>(true)
  useEffect(() => {
    let cancelled = false
    window.api?.midiListPorts?.().then((r) => {
      if (cancelled) return
      setPorts(r.ports)
      setAvailable(r.available)
    })
    return () => {
      cancelled = true
    }
  }, [m.enabled])
  return (
    <div className="flex flex-col gap-1 pt-2 mt-1 border-t border-border">
      <label
        className="flex items-center gap-2 cursor-pointer select-none"
        title="Default MIDI Output for cells created on this Parameter. Per-cell can override."
      >
        <input
          type="checkbox"
          checked={m.enabled}
          onChange={(e) => setMidi({ enabled: e.target.checked })}
          disabled={readonly}
        />
        <span className="label">MIDI Output (default)</span>
        {!available && (
          <span className="text-[10px] text-danger">unavailable</span>
        )}
      </label>
      {m.enabled && (
        <div className="flex flex-col gap-1 mt-1 text-[11px]">
          <div className="grid grid-cols-[auto_minmax(0,1fr)_auto_auto] gap-x-2 gap-y-1 items-center">
            <span className="label">Port</span>
            <select
              className="input text-[11px] py-0.5 min-w-0 max-w-full"
              style={{ textOverflow: 'ellipsis' }}
              value={m.portName}
              onChange={(e) => setMidi({ portName: e.target.value })}
              disabled={readonly}
            >
              <option value="">— select port —</option>
              {m.portName && !ports.includes(m.portName) && (
                <option value={m.portName}>{m.portName} (disconnected)</option>
              )}
              {ports.map((p) => (
                <option key={p} value={p}>
                  {p}
                </option>
              ))}
            </select>
            <span className="label">Ch</span>
            <BoundedNumberInput
              className="input text-[11px] py-0.5 w-10 text-center tabular-nums"
              value={m.channel}
              onChange={(v) => setMidi({ channel: v })}
              min={1}
              max={16}
              integer
              disabled={readonly}
            />
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            <span className="label">Kind</span>
            <div className="flex items-center gap-0.5">
              <button
                className={`text-[10px] px-2 py-0 leading-tight rounded border ${
                  m.kind === 'cc'
                    ? 'bg-accent text-black border-accent'
                    : 'border-border text-muted hover:text-text'
                }`}
                onClick={() => setMidi({ kind: 'cc' })}
                disabled={readonly}
              >
                CC
              </button>
              <button
                className={`text-[10px] px-2 py-0 leading-tight rounded border ${
                  m.kind === 'note'
                    ? 'bg-accent text-black border-accent'
                    : 'border-border text-muted hover:text-text'
                }`}
                onClick={() => setMidi({ kind: 'note' })}
                disabled={readonly}
              >
                Note
              </button>
            </div>
            {m.kind === 'cc' ? (
              <>
                <span className="label">CC #</span>
                <BoundedNumberInput
                  className="input text-[11px] py-0.5 w-14"
                  value={m.cc ?? 0}
                  onChange={(v) => setMidi({ cc: v })}
                  min={0}
                  max={127}
                  integer
                  disabled={readonly}
                />
              </>
            ) : (
              <>
                <span className="label">Gate</span>
                <BoundedNumberInput
                  className="input text-[11px] py-0.5 w-16"
                  value={m.gateLengthMs ?? 0}
                  onChange={(v) => setMidi({ gateLengthMs: v })}
                  min={0}
                  max={60000}
                  integer
                  disabled={readonly}
                />
                <span className="text-[10px] text-muted">ms</span>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

// Editor for a standalone Parameter blueprint (user-authored or built-
// in). Mirrors the field set of FunctionInspector — the two share the
// same ParamMeta-derived vocabulary (paramType, nature, streamMode,
// range, unit, smooth) — plus the destination IP/port and color that
// only matter when a ParameterTemplate stands alone (no parent
// Instrument to inherit from).
function ParameterTemplateInspector({
  parameterId
}: {
  parameterId: string
}): JSX.Element {
  const parameter = useStore((s) =>
    s.session.pool.parameters.find((p) => p.id === parameterId)
  )
  const updateParameter = useStore((s) => s.updateParameter)
  if (!parameter) {
    return (
      <div className="flex flex-col h-full min-h-0">
        <Header title="Parameter Inspector" />
        <div className="p-3 text-muted text-[11px]">
          Parameter no longer exists — pick another item.
        </div>
      </div>
    )
  }
  const readonly = !!parameter.builtin
  function patch(p: Partial<ParameterTemplate>): void {
    updateParameter(parameterId, p)
  }
  return (
    <div className="flex flex-col h-full min-h-0">
      <Header
        title={`Parameter — ${parameter.name}${readonly ? ' (built-in)' : ''}`}
      />
      <div className="flex-1 min-h-0 overflow-y-auto p-2 flex flex-col gap-2 text-[11px]">
        {readonly && (
          <div className="text-[10px] text-muted italic">
            Built-in parameters are read-only. Use the{' '}
            <span className="label">Dupl</span> button in the Pool to clone
            this into an editable user parameter.
          </div>
        )}

        <Field label="Name">
          <UncontrolledTextInput
            className="input text-[11px] py-0.5 w-full"
            value={parameter.name}
            onChange={(v) => patch({ name: v })}
            disabled={readonly}
          />
        </Field>

        <Field label="Description">
          <UncontrolledTextInput
            className="input text-[11px] py-0.5 w-full"
            value={parameter.description ?? ''}
            onChange={(v) => patch({ description: v || undefined })}
            disabled={readonly}
            placeholder="What is this parameter for?"
          />
        </Field>

        <Field label="Color">
          <input
            type="color"
            className="w-full h-6 rounded border border-border bg-transparent cursor-pointer disabled:cursor-default"
            value={parameter.color}
            onChange={(e) => patch({ color: e.target.value })}
            disabled={readonly}
          />
        </Field>

        <Field label="Default IP : Port">
          <div className="flex items-center gap-1">
            <UncontrolledTextInput
              className="input text-[11px] py-0.5 flex-1 min-w-0"
              value={parameter.destIp}
              onChange={(v) => patch({ destIp: v })}
              disabled={readonly}
              placeholder="127.0.0.1"
            />
            <span className="text-muted">:</span>
            <BoundedNumberInput
              className="input text-[11px] py-0.5 w-16"
              value={parameter.destPort}
              onChange={(v) => patch({ destPort: v })}
              min={1}
              max={65535}
              integer
              disabled={readonly}
            />
          </div>
        </Field>

        <Field label="OSC path">
          <UncontrolledTextInput
            className="input text-[11px] py-0.5 w-full font-mono"
            value={parameter.oscPath}
            onChange={(v) => patch({ oscPath: v })}
            disabled={readonly}
            placeholder="param"
          />
        </Field>

        <Field label="Type">
          <select
            className="input text-[11px] py-0.5 w-full"
            value={parameter.paramType}
            onChange={(e) => patch({ paramType: e.target.value as FunctionParamType })}
            disabled={readonly}
          >
            {PARAM_TYPES.map((t) => (
              <option key={t.id} value={t.id}>
                {t.label}
              </option>
            ))}
          </select>
        </Field>

        <div className="grid grid-cols-3 gap-1">
          <Field label="Min">
            <BoundedNumberInput
              className="input text-[11px] py-0.5 w-full"
              value={parameter.min ?? 0}
              onChange={(v) => patch({ min: v })}
              min={-1e9}
              max={1e9}
              disabled={readonly}
            />
          </Field>
          <Field label="Max">
            <BoundedNumberInput
              className="input text-[11px] py-0.5 w-full"
              value={parameter.max ?? 1}
              onChange={(v) => patch({ max: v })}
              min={-1e9}
              max={1e9}
              disabled={readonly}
            />
          </Field>
          <Field label="Init">
            <BoundedNumberInput
              className="input text-[11px] py-0.5 w-full"
              value={parameter.init ?? 0}
              onChange={(v) => patch({ init: v })}
              min={-1e9}
              max={1e9}
              disabled={readonly}
            />
          </Field>
        </div>

        <Field label="Nature">
          <select
            className="input text-[11px] py-0.5 w-full"
            value={parameter.nature}
            onChange={(e) => patch({ nature: e.target.value as FunctionParamNature })}
            disabled={readonly}
          >
            {NATURES.map((n) => (
              <option key={n.id} value={n.id}>
                {n.label}
              </option>
            ))}
          </select>
        </Field>

        <Field label="Stream mode">
          <select
            className="input text-[11px] py-0.5 w-full"
            value={parameter.streamMode}
            onChange={(e) => patch({ streamMode: e.target.value as FunctionStreamMode })}
            disabled={readonly}
            title="Streaming = continuous (e.g. position). Discrete = events. Polling = read-on-demand."
          >
            {STREAM_MODES.map((m) => (
              <option key={m.id} value={m.id}>
                {m.label}
              </option>
            ))}
          </select>
        </Field>

        <Field label="Unit">
          <UncontrolledTextInput
            className="input text-[11px] py-0.5 w-full"
            value={parameter.unit ?? ''}
            onChange={(v) => patch({ unit: v || undefined })}
            disabled={readonly}
            placeholder="Hz, dB, °, RGBA…"
          />
        </Field>

        <Field label="Notes">
          <UncontrolledTextInput
            className="input text-[11px] py-0.5 w-full"
            value={parameter.notes ?? ''}
            onChange={(v) => patch({ notes: v || undefined })}
            disabled={readonly}
            placeholder="Free-form note about this parameter"
          />
        </Field>
      </div>
    </div>
  )
}

// Saved-Scene Inspector — renders when the user clicks a row in the
// Pool's Scenes tab. Mirrors the in-grid Scene controls (name / color
// / notes / duration / next mode / multiplicator / morph-in time)
// so the user can curate the saved scene before re-instantiating it,
// plus a read-only breakdown of which Pool Instruments + Parameters
// this scene was authored against. Edits push back to the global
// library via `updateSavedScene`.
function SavedSceneInspector({
  savedSceneId
}: {
  savedSceneId: string
}): JSX.Element {
  const sceneLibrary = useStore((s) => s.sceneLibrary)
  const updateSavedScene = useStore((s) => s.updateSavedScene)
  const removeSavedScene = useStore((s) => s.removeSavedScene)
  const instantiateSavedScene = useStore((s) => s.instantiateSavedScene)
  const setFocusedScene = useStore((s) => s.setFocusedScene)
  const setPoolSelection = useStore((s) => s.setPoolSelection)
  const poolTemplates = useStore((s) => s.session.pool.templates)
  const sc = sceneLibrary.find((s) => s.id === savedSceneId)
  if (!sc) {
    return (
      <div className="flex flex-col h-full min-h-0">
        <Header title="Saved Scene Inspector" />
        <div className="p-3 text-muted text-[11px]">
          Selection is stale — pick another Saved Scene.
        </div>
      </div>
    )
  }
  // Build the Instruments / orphan-Parameters breakdown by walking
  // saved.tracks. Templates already in the local Pool show their
  // current name (in case the user has renamed them since saving);
  // templates that ONLY exist in the saved scene fall back to the
  // saved.templates copy's name.
  const headerTracks = sc.tracks.filter((t) => t.kind === 'template')
  const childTracks = sc.tracks.filter((t) => t.kind === 'function')
  const tplNameById = new Map<string, string>()
  for (const t of poolTemplates) tplNameById.set(t.id, t.name)
  for (const t of sc.templates) {
    if (!tplNameById.has(t.id)) tplNameById.set(t.id, t.name)
  }
  return (
    <div className="flex flex-col h-full min-h-0">
      <Header title={`Saved Scene — ${sc.name}`} />
      <div className="flex-1 min-h-0 overflow-y-auto p-2 flex flex-col gap-2 text-[11px]">
        <Field label="Name">
          <UncontrolledTextInput
            className="input text-[11px] py-0.5 w-full"
            value={sc.name}
            onChange={(v) => updateSavedScene(sc.id, { name: v })}
          />
        </Field>
        <div className="grid grid-cols-2 gap-1">
          <Field label="Color">
            <input
              type="color"
              className="input p-0 h-6 w-full cursor-pointer"
              value={sc.color}
              onChange={(e) => updateSavedScene(sc.id, { color: e.target.value })}
            />
          </Field>
          <Field label="Created">
            <span className="text-muted text-[10px] py-0.5">
              {sc.createdAt ? new Date(sc.createdAt).toLocaleString() : '—'}
            </span>
          </Field>
        </div>
        <Field label="Notes">
          <textarea
            className="input italic text-[11px] leading-snug w-full"
            style={{ height: 56, resize: 'vertical' }}
            placeholder="Notes…"
            value={sc.sceneMeta.notes ?? ''}
            onChange={(e) =>
              updateSavedScene(sc.id, { notes: e.target.value })
            }
          />
        </Field>
        <div className="grid grid-cols-3 gap-1">
          <Field label="Duration (s)">
            <BoundedNumberInput
              className="input text-[11px] py-0.5 w-full"
              value={sc.sceneMeta.durationSec}
              onChange={(v) => updateSavedScene(sc.id, { durationSec: v })}
              min={0.5}
              max={300}
            />
          </Field>
          <Field label="Multiplier">
            <BoundedNumberInput
              className="input text-[11px] py-0.5 w-full"
              value={sc.sceneMeta.multiplicator}
              onChange={(v) => updateSavedScene(sc.id, { multiplicator: v })}
              min={1}
              max={128}
              integer
            />
          </Field>
          <Field label="Morph (ms)">
            <BoundedNumberInput
              className="input text-[11px] py-0.5 w-full"
              value={sc.sceneMeta.morphInMs ?? 0}
              onChange={(v) => updateSavedScene(sc.id, { morphInMs: v })}
              min={0}
              max={60000}
              integer
            />
          </Field>
        </div>
        <Field label="Next mode">
          <select
            className="input select-compact text-[11px] py-0.5 w-full"
            value={sc.sceneMeta.nextMode}
            onChange={(e) =>
              updateSavedScene(sc.id, {
                nextMode: e.target.value as typeof sc.sceneMeta.nextMode
              })
            }
          >
            <option value="stop">Stop</option>
            <option value="loop">Loop</option>
            <option value="next">Next</option>
            <option value="prev">Previous</option>
            <option value="first">First</option>
            <option value="last">Last</option>
            <option value="any">Any</option>
            <option value="other">Other</option>
          </select>
        </Field>

        {/* Instruments + Parameters breakdown — read-only. Shows what
            the saved scene will pull into the Pool / sidebar when
            re-instantiated. Clicking an Instrument name jumps the
            Pool selection to its Template Inspector. */}
        <div className="flex flex-col gap-1 pt-2 mt-1 border-t border-border">
          <div className="flex items-baseline justify-between">
            <span className="label">Contents</span>
            <span className="text-muted text-[10px]">
              {headerTracks.length} instr · {childTracks.length} param ·{' '}
              {Object.keys(sc.cells).length} cell
              {Object.keys(sc.cells).length === 1 ? '' : 's'}
            </span>
          </div>
          {headerTracks.length === 0 && childTracks.length === 0 ? (
            <span className="text-[10px] text-muted italic">
              No tracks — this scene was saved empty.
            </span>
          ) : (
            <div className="flex flex-col gap-0.5">
              {headerTracks.map((h) => {
                const tplName = h.sourceTemplateId
                  ? tplNameById.get(h.sourceTemplateId) ?? h.name
                  : h.name
                const kids = childTracks.filter(
                  (c) => c.parentTrackId === h.id
                )
                const inPool = h.sourceTemplateId
                  ? poolTemplates.find((t) => t.id === h.sourceTemplateId)
                  : null
                return (
                  <div
                    key={h.id}
                    className="flex flex-col gap-0.5 border border-border rounded p-1 bg-panel2"
                  >
                    <div className="flex items-center gap-1">
                      <button
                        className="font-semibold text-[11px] truncate flex-1 text-left hover:text-accent"
                        onClick={() => {
                          if (h.sourceTemplateId && inPool) {
                            setPoolSelection({
                              kind: 'template',
                              templateId: h.sourceTemplateId
                            })
                          }
                        }}
                        disabled={!inPool}
                        title={
                          inPool
                            ? 'Open this Instrument in the Pool Inspector'
                            : "This Instrument isn't in the current Pool yet — instantiating the scene will add it."
                        }
                      >
                        {tplName}
                      </button>
                      {!inPool && (
                        <span
                          className="text-[8px] text-muted px-1 rounded border border-border shrink-0"
                          title="Will be added to your Pool on instantiate"
                        >
                          new
                        </span>
                      )}
                      <span className="text-[9px] text-muted shrink-0">
                        {kids.length} param
                      </span>
                    </div>
                    {kids.length > 0 && (
                      <div className="flex flex-col gap-px pl-2 text-[10px]">
                        {kids.map((c) => {
                          const cell = sc.cells[c.id]
                          return (
                            <div
                              key={c.id}
                              className="flex items-center gap-1"
                              title={
                                cell
                                  ? `OSC: ${cell.oscAddress || '—'}  →  value: ${cell.value}`
                                  : 'No cell saved for this parameter'
                              }
                            >
                              <span className="truncate flex-1">{c.name}</span>
                              <span className="font-mono text-muted shrink-0">
                                {cell ? cell.value || '∅' : '—'}
                              </span>
                            </div>
                          )
                        })}
                      </div>
                    )}
                  </div>
                )
              })}
              {/* Orphan Parameter tracks (no header — rare) */}
              {childTracks
                .filter((c) => !c.parentTrackId)
                .map((c) => {
                  const cell = sc.cells[c.id]
                  return (
                    <div
                      key={c.id}
                      className="flex items-center gap-1 border border-border rounded px-1 py-0.5 text-[10px] bg-panel2"
                    >
                      <span className="truncate flex-1 font-semibold">
                        {c.name}
                      </span>
                      <span className="font-mono text-muted shrink-0">
                        {cell ? cell.value || '∅' : '—'}
                      </span>
                    </div>
                  )
                })}
            </div>
          )}
        </div>

        {/* Action row — Use (instantiate) + Delete from library. */}
        <div className="flex items-center gap-1.5 pt-2 mt-1 border-t border-border">
          <button
            className="btn text-[11px]"
            onClick={() => {
              const newId = instantiateSavedScene(sc.id)
              if (newId) setFocusedScene(newId)
            }}
            title="Instantiate this scene at the end of the grid"
          >
            Use
          </button>
          <div className="flex-1" />
          <button
            className="btn text-[11px]"
            style={{
              borderColor: 'rgb(var(--c-danger))',
              color: 'rgb(var(--c-danger))'
            }}
            onClick={() => {
              if (window.confirm(`Delete saved scene "${sc.name}" from the Pool?`)) {
                void removeSavedScene(sc.id)
                setPoolSelection(null)
              }
            }}
            title="Permanently delete from the saved-scene library"
          >
            Delete
          </button>
        </div>
      </div>
    </div>
  )
}

function Field({
  label,
  children
}: {
  label: string
  children: React.ReactNode
}): JSX.Element {
  return (
    <label className="flex flex-col gap-0.5">
      <span className="label">{label}</span>
      {children}
    </label>
  )
}

// ──────────────────────────────────────────────────────────────────
// Hardware Mode section — appears in the Pool's Instrument Template
// Inspector under the Name field. Lets the user bind a physical OSC
// controller (recognised via the Network discovery tab) to this
// Instrument so the controller can override scene playback in
// real time, with soft-takeover ("catch") so values can't snap.
//
// The engine reads `template.hardwareMode` on every incoming OSC
// packet (via handleHardwareInput in engine.ts) — see that file for
// the actual override pipeline. This UI is purely the config
// surface.
// ──────────────────────────────────────────────────────────────────
export function HardwareModeSection({
  template
}: {
  template: InstrumentTemplate
}): JSX.Element {
  const setHardwareMode = useStore((s) => s.setTemplateHardwareMode)
  const networkDevices = useStore((s) => s.networkDevices)
  const tracks = useStore((s) => s.session.tracks)
  const hw = template.hardwareMode ?? {
    enabled: false,
    deviceIp: '',
    devicePort: 0,
    mode: 'reset' as const,
    catchTolerance: 0.02,
    movementThreshold: 0.005,
    movementWindowMs: 300
  }
  const deviceKey = hw.deviceIp ? `${hw.deviceIp}:${hw.devicePort}` : ''
  // Which Track instances are spawned from this template — the
  // "applies to" selector listing.
  const trackInstances = tracks.filter(
    (t) => t.sourceTemplateId === template.id
  )
  const appliesToAll =
    !hw.appliesToTrackIds || hw.appliesToTrackIds.length === 0
  return (
    <div className="border border-border rounded p-1.5 flex flex-col gap-1.5 bg-panel2/30">
      <label className="flex items-center gap-1.5 cursor-pointer">
        <input
          type="checkbox"
          checked={!!hw.enabled}
          onChange={(e) =>
            setHardwareMode(template.id, { enabled: e.target.checked })
          }
        />
        <span className="label" style={{ color: hw.enabled ? 'rgb(var(--c-danger))' : undefined }}>
          Hardware Mode
        </span>
        {hw.enabled && (
          <span
            className="text-[9px] font-bold"
            style={{ color: 'rgb(var(--c-danger))' }}
          >
            ON
          </span>
        )}
      </label>
      {hw.enabled && (
        <>
          {/* Device picker — pulls discovered senders from Network tab.
              Empty list = nothing has broadcast OSC at us yet; the
              hint text tells the user where to look. */}
          <Field label="Device (Network discovery)">
            <select
              className="input text-[11px] py-0.5 w-full"
              value={deviceKey}
              onChange={(e) => {
                const v = e.target.value
                if (!v) {
                  setHardwareMode(template.id, { deviceIp: '', devicePort: 0 })
                  return
                }
                const lastColon = v.lastIndexOf(':')
                const ip = v.slice(0, lastColon)
                const port = Number(v.slice(lastColon + 1))
                setHardwareMode(template.id, {
                  deviceIp: ip,
                  devicePort: port
                })
              }}
            >
              <option value="">— pick a discovered device —</option>
              {networkDevices.map((d) => (
                <option key={d.id} value={`${d.ip}:${d.port}`}>
                  {d.ip}:{d.port} ({d.addresses.length} addr)
                </option>
              ))}
            </select>
            {networkDevices.length === 0 && (
              <span className="text-[9px] text-muted italic mt-0.5">
                No devices discovered yet. Make sure the controller is
                broadcasting OSC to dataFLOU's listen port — check the
                Network tab in the Pool drawer.
              </span>
            )}
          </Field>
          {/* Mode — 'reset' (default) re-arms catch on every scene
              change; 'persist' lets a mid-show knob-turn keep
              overriding through scene transitions. */}
          <Field label="Catch lifecycle">
            <select
              className="input text-[11px] py-0.5 w-full"
              value={hw.mode}
              onChange={(e) =>
                setHardwareMode(template.id, {
                  mode: e.target.value as 'reset' | 'persist'
                })
              }
            >
              <option value="reset">Reset on scene change (default)</option>
              <option value="persist">Persist across scene changes</option>
            </select>
          </Field>
          {/* Tolerances — sensible defaults shown; advanced users can
              tighten / loosen. */}
          <div className="grid grid-cols-2 gap-1">
            <Field label="Catch tol (% range)">
              <BoundedNumberInput
                className="input text-[11px] py-0.5 w-full"
                value={Math.round(hw.catchTolerance * 1000) / 10}
                onChange={(v) =>
                  setHardwareMode(template.id, {
                    catchTolerance: Math.max(0, Math.min(100, v)) / 100
                  })
                }
                min={0}
                max={100}
              />
            </Field>
            <Field label="Movement Δ (% range)">
              <BoundedNumberInput
                className="input text-[11px] py-0.5 w-full"
                value={Math.round(hw.movementThreshold * 1000) / 10}
                onChange={(v) =>
                  setHardwareMode(template.id, {
                    movementThreshold: Math.max(0, Math.min(100, v)) / 100
                  })
                }
                min={0}
                max={100}
              />
            </Field>
          </div>
          {/* Multi-instance selector — empty list = all instances of
              this template are HW-controllable. Listing specific
              track IDs narrows the scope. */}
          {trackInstances.length > 1 && (
            <Field label="Apply to">
              <div className="flex flex-col gap-0.5">
                <label className="flex items-center gap-1 text-[10px]">
                  <input
                    type="checkbox"
                    checked={appliesToAll}
                    onChange={(e) => {
                      setHardwareMode(template.id, {
                        appliesToTrackIds: e.target.checked ? [] : trackInstances.map((t) => t.id)
                      })
                    }}
                  />
                  <span>All instances ({trackInstances.length})</span>
                </label>
                {!appliesToAll &&
                  trackInstances.map((t) => (
                    <label
                      key={t.id}
                      className="flex items-center gap-1 text-[10px] pl-3"
                    >
                      <input
                        type="checkbox"
                        checked={hw.appliesToTrackIds!.includes(t.id)}
                        onChange={(e) => {
                          const next = e.target.checked
                            ? [...(hw.appliesToTrackIds ?? []), t.id]
                            : (hw.appliesToTrackIds ?? []).filter(
                                (id) => id !== t.id
                              )
                          setHardwareMode(template.id, {
                            appliesToTrackIds: next
                          })
                        }}
                      />
                      <span>{t.name}</span>
                    </label>
                  ))}
              </div>
            </Field>
          )}
          {/* Per-function arg lock — granular. For each Parameter,
              user can pick specific arg slots HW controls. Empty
              row = HW controls ALL slots of that Parameter. */}
          <Field label="Per-parameter arg slot lock">
            <div className="flex flex-col gap-0.5">
              {template.functions
                .filter((fn) => (fn.argSpec?.length ?? 0) > 1)
                .map((fn) => {
                  const locked = hw.args?.[fn.id] ?? []
                  const argCount = fn.argSpec!.length
                  return (
                    <div
                      key={fn.id}
                      className="flex items-center gap-1 text-[10px]"
                    >
                      <span className="text-muted shrink-0" style={{ width: 80 }}>
                        {fn.name}
                      </span>
                      {Array.from({ length: argCount }).map((_, i) => (
                        <label
                          key={i}
                          className="flex items-center gap-0.5"
                          title={`Slot ${i}: ${fn.argSpec![i]?.name ?? 'arg ' + i}`}
                        >
                          <input
                            type="checkbox"
                            checked={locked.length === 0 || locked.includes(i)}
                            onChange={(e) => {
                              const isAll = locked.length === 0
                              const startList = isAll
                                ? Array.from({ length: argCount }, (_, k) => k)
                                : locked
                              const next = e.target.checked
                                ? [...startList, i].filter(
                                    (v, idx, a) => a.indexOf(v) === idx
                                  )
                                : startList.filter((v) => v !== i)
                              const allChecked = next.length === argCount
                              setHardwareMode(template.id, {
                                args: {
                                  ...(hw.args ?? {}),
                                  // Empty array = "all" (the default).
                                  // Storing [0..N-1] explicitly is equivalent
                                  // semantically — we normalise to empty.
                                  [fn.id]: allChecked ? [] : next
                                }
                              })
                            }}
                          />
                          <span className="tabular-nums">{i}</span>
                        </label>
                      ))}
                    </div>
                  )
                })}
              {template.functions.every((fn) => (fn.argSpec?.length ?? 0) <= 1) && (
                <span className="text-[9px] text-muted italic">
                  All Parameters are single-arg — hardware controls each
                  Parameter's only slot. No per-slot lock UI needed.
                </span>
              )}
            </div>
          </Field>
        </>
      )}
    </div>
  )
}

function resolveOsc(t: InstrumentTemplate, fn: InstrumentFunction): string {
  const path = fn.oscPath
  if (path.startsWith('/')) return path
  const base = t.oscAddressBase ?? ''
  const trimmed = base.endsWith('/') ? base.slice(0, -1) : base
  return `${trimmed}/${path}`
}
