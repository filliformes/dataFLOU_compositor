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

import { useStore } from '../store'
import { BoundedNumberInput } from './BoundedNumberInput'
import { UncontrolledTextInput } from './UncontrolledInput'
import type {
  FunctionParamNature,
  FunctionParamType,
  FunctionStreamMode,
  InstrumentFunction,
  InstrumentTemplate
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
          Select a Template or Function in the Pool to edit it. Drag any item
          onto the Edit-view sidebar to instantiate it as an Instrument row.
        </div>
      </div>
    )
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
        <div className="p-3 text-muted text-[11px]">Function no longer exists.</div>
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
      <Header title={`Function — ${template.name} ▸ ${fn.name}${readonly ? ' (built-in)' : ''}`} />
      <div className="flex-1 min-h-0 overflow-y-auto p-2 flex flex-col gap-2 text-[11px]">
        {readonly && (
          <div className="text-[10px] text-muted italic">
            Built-in functions are read-only. Clone the parent Template to edit.
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
            placeholder="Free-form note about this function"
          />
        </Field>
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

function resolveOsc(t: InstrumentTemplate, fn: InstrumentFunction): string {
  const path = fn.oscPath
  if (path.startsWith('/')) return path
  const base = t.oscAddressBase ?? ''
  const trimmed = base.endsWith('/') ? base.slice(0, -1) : base
  return `${trimmed}/${path}`
}
