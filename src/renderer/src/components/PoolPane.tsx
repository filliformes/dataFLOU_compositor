// Pool pane — middle section of the OSC-monitor drawer. Lists every
// (non-draft) Instrument Template and its Parameters, plus a separate
// browser for standalone Parameter blueprints. Three filter modes:
//
//   • Built-in  — only `builtin: true` Templates AND Parameters
//   • Templates — user-authored Instrument Templates
//   • Parameters — user-authored Parameter blueprints (single-Param
//                  building blocks like RGB Light, Knob, Motor, etc.)
//
// Selection drives the Edit-view's right-side Inspector (Pool selection
// reuses that real-estate because it needs more vertical room than the
// drawer can provide). Drafts (auto-created backing Templates behind
// "Add Instrument" sidebar rows) are hidden until "Save as Template".

import { useState } from 'react'
import { useStore } from '../store'
import type {
  InstrumentFunction,
  InstrumentTemplate,
  ParameterTemplate
} from '@shared/types'

// MIME types for the HTML5 drag-and-drop handoff. Each shape is JSON-
// encoded into the dataTransfer payload; the drop target picks the one
// it cares about. Custom types so a stray drag from somewhere else
// can't accidentally land in our drop zones.
export const POOL_TEMPLATE_DRAG_MIME = 'application/x-dataflou-pool-template'
export const POOL_FUNCTION_DRAG_MIME = 'application/x-dataflou-pool-function'
export const POOL_PARAMETER_DRAG_MIME = 'application/x-dataflou-pool-parameter'

export interface PoolTemplateDragPayload {
  templateId: string
}
export interface PoolFunctionDragPayload {
  templateId: string
  functionId: string
}
export interface PoolParameterDragPayload {
  parameterId: string
}

// Persisted Pool tab + pop-out flag are local UI — they don't belong in
// the session file. localStorage is enough.
//
// Two tabs after the simplification: Built-in (everything shipped) and
// User (everything authored — Instruments AND Parameter blueprints
// rendered as two labelled sections in the same scrollable list).
const POOL_TAB_KEY = 'dataflou:poolTab:v2'
type PoolTab = 'builtin' | 'user'
function loadPoolTab(): PoolTab {
  try {
    const v = typeof localStorage !== 'undefined' ? localStorage.getItem(POOL_TAB_KEY) : null
    if (v === 'builtin' || v === 'user') return v
  } catch {
    /* ignore */
  }
  return 'user'
}

export default function PoolPane({
  poppedOut,
  onTogglePopOut,
  onHide,
  titleBarHandlers
}: {
  // When the Pool is rendered inside the pop-out modal we hide the
  // pop-out trigger to avoid double-up; in the embedded drawer we show
  // it. Both render the SAME PoolPane component so behavior stays in
  // sync.
  poppedOut?: boolean
  onTogglePopOut?: () => void
  // "Hide" closes the Pool view entirely (in either context). The OSC
  // log keeps running; a "Show Pool" button lights up next to it so
  // the user can bring the Pool back. P shortcut also toggles.
  onHide?: () => void
  // Optional pointer event handlers spread onto the title bar div —
  // used by the floating pop-out window to make the bar a drag handle.
  // The drawer-embedded PoolPane omits this and the bar behaves
  // normally.
  titleBarHandlers?: React.HTMLAttributes<HTMLDivElement>
} = {}): JSX.Element {
  const allTemplates = useStore((s) => s.session.pool.templates)
  const allParameters = useStore((s) => s.session.pool.parameters)
  const selection = useStore((s) => s.poolSelection)
  const setSelection = useStore((s) => s.setPoolSelection)
  const addTemplate = useStore((s) => s.addTemplate)
  const addFunction = useStore((s) => s.addFunctionToTemplate)
  const removeTemplate = useStore((s) => s.removeTemplate)
  const removeFunction = useStore((s) => s.removeFunction)
  const duplicateTemplate = useStore((s) => s.duplicateTemplate)
  const addParameter = useStore((s) => s.addParameter)
  const duplicateParameter = useStore((s) => s.duplicateParameter)
  const removeParameter = useStore((s) => s.removeParameter)

  // Which view: built-in / user templates / parameters. Persisted so
  // the user's filter choice carries across drawer toggles.
  const [tab, setTabState] = useState<PoolTab>(loadPoolTab)
  function setTab(t: PoolTab): void {
    setTabState(t)
    try {
      localStorage.setItem(POOL_TAB_KEY, t)
    } catch {
      /* quota exceeded — ignore */
    }
  }

  // Drafts back the live "Add Instrument" sidebar rows; keep them out
  // of the Pool browser until the user explicitly Saves-as-Template.
  // Filter the currently visible items based on the tab.
  let visibleTemplates: InstrumentTemplate[] = []
  let visibleParameters: ParameterTemplate[] = []
  if (tab === 'builtin') {
    visibleTemplates = allTemplates.filter((t) => !t.draft && t.builtin)
    visibleParameters = allParameters.filter((p) => p.builtin)
  } else {
    // User tab — both user Instruments and user Parameter blueprints
    // share the same scrollable list, separated by section headers.
    visibleTemplates = allTemplates.filter((t) => !t.draft && !t.builtin)
    visibleParameters = allParameters.filter((p) => !p.builtin)
  }

  // Per-template expand/collapse — local UI state, not persisted. By
  // default everything is COLLAPSED; you click the chevron to peek
  // inside a template's Parameter list.
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set())
  function toggleExpand(id: string): void {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  // Track a "double-click on title bar" gesture to pop the Pool out
  // into a centered modal. Use a 300 ms window to count two clicks as a
  // double-click — React's `onDoubleClick` on the bar fires reliably
  // but skipping it lets us also bind to the title-only span if needed.
  return (
    <div className="flex flex-col h-full min-h-0">
      {/* Header — title + filter tabs + Add buttons. Fast double-click
          on the bar (or the title) pops the Pool out into a centered
          modal that's easier to scan when the library grows. */}
      <div
        {...titleBarHandlers}
        className="flex items-center gap-2 px-2 py-1 border-b border-border shrink-0 cursor-default select-none"
        onDoubleClick={() => onTogglePopOut?.()}
        title={poppedOut ? 'Drag to move · Double-click to dock' : 'Double-click to pop out'}
        style={{ touchAction: titleBarHandlers ? 'none' : undefined, ...titleBarHandlers?.style }}
      >
        <span className="label">Pool</span>
        <div className="flex items-center gap-0.5">
          <FilterTab label="Built-in" active={tab === 'builtin'} onClick={() => setTab('builtin')} />
          <FilterTab label="User" active={tab === 'user'} onClick={() => setTab('user')} />
        </div>
        <span className="text-muted text-[10px]">
          {visibleTemplates.length}I · {visibleParameters.length}P
        </span>
        <div className="flex-1" />
        {tab === 'user' && (
          <>
            <button
              className="btn text-[10px] py-0 px-1.5 leading-tight"
              onClick={() => addTemplate()}
              title="Create a new empty Instrument"
            >
              + Instrument
            </button>
            <button
              className="btn text-[10px] py-0 px-1.5 leading-tight"
              onClick={() => addParameter()}
              title="Create a new Parameter blueprint"
            >
              + Parameter
            </button>
          </>
        )}
        {onTogglePopOut && (
          <button
            className="btn text-[10px] py-0 px-1.5 leading-tight shrink-0"
            onClick={onTogglePopOut}
            title={poppedOut ? 'Dock back into the drawer' : 'Pop out to a centered window'}
          >
            {poppedOut ? '⤓' : '⤢'}
          </button>
        )}
        {onHide && (
          <button
            className="btn text-[10px] py-0 px-1.5 leading-tight shrink-0"
            onClick={onHide}
            title="Hide the Pool (P to toggle)"
          >
            Hide
          </button>
        )}
      </div>

      {/* Body — scrollable list. Both tabs render the same two-section
          structure: an Instruments section (Templates) on top, then a
          Parameters section. Empty sections render nothing. */}
      <div className="flex-1 min-h-0 overflow-y-auto py-1">
        <SectionedList
          mode={tab}
          templates={visibleTemplates}
          params={visibleParameters}
          expanded={expanded}
          onToggleExpand={toggleExpand}
          selection={selection}
          onSelect={(sel) => setSelection(sel)}
          onAddFunction={(tplId) => addFunction(tplId)}
          onRemoveTemplate={(tplId, name) => {
            if (confirm(`Delete instrument "${name}"?`)) removeTemplate(tplId)
          }}
          onRemoveFunction={(tplId, fnId, fnName) => {
            if (confirm(`Delete parameter "${fnName}"?`)) removeFunction(tplId, fnId)
          }}
          onDuplicateTemplate={(id) => duplicateTemplate(id)}
          onDuplicateParam={(id) => duplicateParameter(id)}
          onRemoveParam={(id, name) => {
            if (confirm(`Delete parameter "${name}"?`)) removeParameter(id)
          }}
        />
      </div>
    </div>
  )
}

function FilterTab({
  label,
  active,
  onClick
}: {
  label: string
  active: boolean
  onClick: () => void
}): JSX.Element {
  return (
    <button
      className={`text-[10px] px-1.5 py-0 leading-tight rounded border ${
        active
          ? 'bg-accent text-black border-accent'
          : 'border-border text-muted hover:text-text'
      }`}
      onClick={onClick}
    >
      {label}
    </button>
  )
}

// Unified list rendering for both Built-in and User tabs. Same shape:
// section header → Instruments, optional section header → Parameters.
// Buttons (Add Param to template, Delete template, Delete parameter,
// etc.) gate themselves on `mode` so the Built-in tab stays read-only
// for shipped entries.
function SectionedList({
  mode,
  templates,
  params,
  expanded,
  onToggleExpand,
  selection,
  onSelect,
  onAddFunction,
  onRemoveTemplate,
  onRemoveFunction,
  onDuplicateTemplate,
  onDuplicateParam,
  onRemoveParam
}: {
  mode: 'builtin' | 'user'
  templates: InstrumentTemplate[]
  params: ParameterTemplate[]
  expanded: Set<string>
  onToggleExpand: (id: string) => void
  selection: ReturnType<typeof useStore.getState>['poolSelection']
  onSelect: (sel: ReturnType<typeof useStore.getState>['poolSelection']) => void
  onAddFunction: (tplId: string) => string | null
  onRemoveTemplate: (tplId: string, name: string) => void
  onRemoveFunction: (tplId: string, fnId: string, fnName: string) => void
  onDuplicateTemplate: (id: string) => string | null
  onDuplicateParam: (id: string) => string | null
  onRemoveParam: (id: string, name: string) => void
}): JSX.Element {
  const editable = mode === 'user'
  if (templates.length === 0 && params.length === 0) {
    return (
      <div className="p-3 text-muted text-[11px]">
        {mode === 'builtin' ? (
          'No built-ins shipped.'
        ) : (
          <>
            No user entries yet. Click <span className="label">+ Instrument</span>{' '}
            or <span className="label">+ Parameter</span> to author one — or save
            an Instrument from the sidebar (right-click → Save as Template). The
            <span className="label"> Built-in</span> tab has the shipped library.
          </>
        )}
      </div>
    )
  }
  return (
    <>
      {templates.length > 0 && (
        <div className="px-2 pt-1 pb-0.5 text-[9px] uppercase tracking-wide text-muted">
          Instruments
        </div>
      )}
      {templates.map((t) => (
        <TemplateRow
          key={t.id}
          template={t}
          expanded={expanded.has(t.id)}
          onToggleExpand={() => onToggleExpand(t.id)}
          selection={selection}
          onSelect={onSelect}
          onAddFunction={editable ? () => onAddFunction(t.id) : () => null}
          onRemoveTemplate={editable ? () => onRemoveTemplate(t.id, t.name) : () => undefined}
          onRemoveFunction={
            editable
              ? (fnId, fnName) => onRemoveFunction(t.id, fnId, fnName)
              : () => undefined
          }
          onDuplicate={() => onDuplicateTemplate(t.id)}
        />
      ))}
      {params.length > 0 && (
        <div className="px-2 pt-2 pb-0.5 text-[9px] uppercase tracking-wide text-muted">
          Parameters
        </div>
      )}
      {params.map((p) => (
        <ParameterRow
          key={p.id}
          param={p}
          isSelected={selection?.kind === 'parameter' && selection.parameterId === p.id}
          onSelect={() => onSelect({ kind: 'parameter', parameterId: p.id })}
          onDuplicate={() => onDuplicateParam(p.id)}
          onRemove={editable ? () => onRemoveParam(p.id, p.name) : undefined}
        />
      ))}
    </>
  )
}

function TemplateRow({
  template,
  expanded,
  onToggleExpand,
  selection,
  onSelect,
  onAddFunction,
  onRemoveTemplate,
  onRemoveFunction,
  onDuplicate
}: {
  template: InstrumentTemplate
  expanded: boolean
  onToggleExpand: () => void
  selection: ReturnType<typeof useStore.getState>['poolSelection']
  onSelect: (
    sel: ReturnType<typeof useStore.getState>['poolSelection']
  ) => void
  onAddFunction: () => void
  onRemoveTemplate: () => void
  onRemoveFunction: (fnId: string, fnName: string) => void
  onDuplicate: () => void
}): JSX.Element {
  const isSelectedTemplate =
    selection?.kind === 'template' && selection.templateId === template.id

  function onTemplateDragStart(e: React.DragEvent): void {
    const payload: PoolTemplateDragPayload = { templateId: template.id }
    e.dataTransfer.setData(POOL_TEMPLATE_DRAG_MIME, JSON.stringify(payload))
    e.dataTransfer.effectAllowed = 'copy'
  }

  return (
    <div className="flex flex-col">
      {/* Template header — parent row, drag source. Compact vertical
          padding so more rows fit on screen at typical drawer height. */}
      <div
        draggable
        onDragStart={onTemplateDragStart}
        onClick={() => onSelect({ kind: 'template', templateId: template.id })}
        className={`relative flex items-center gap-1 px-1 py-[1px] cursor-grab text-[12px] leading-tight ${
          isSelectedTemplate ? 'bg-panel2' : 'hover:bg-panel2/60'
        }`}
        style={{ borderLeft: `3px solid ${template.color}` }}
        title="Drag onto the Edit-view sidebar to instantiate. Click to edit in the right Inspector."
      >
        {/* Chevron — explicit toggle, never auto-expands on selection.
            Sized 50% larger + bold so the affordance reads at a glance
            even at typical zoom levels. */}
        <button
          className="text-muted hover:text-text text-[15px] font-bold leading-none w-5 shrink-0"
          onClick={(e) => {
            e.stopPropagation()
            onToggleExpand()
          }}
          title={expanded ? 'Collapse' : `Expand (${template.functions.length} param)`}
        >
          {expanded ? '▾' : '▸'}
        </button>
        <span className="font-semibold truncate">{template.name}</span>
        {template.builtin && (
          <span
            className="text-[9px] text-muted px-1 py-0 rounded-sm border border-border shrink-0"
            title="Built-in template — clone to edit"
          >
            BUILT-IN
          </span>
        )}
        <span className="text-muted text-[10px] shrink-0">
          {template.functions.length} param
        </span>
        <div className="flex-1" />
        <button
          className="btn text-[10px] py-0 px-1.5 leading-tight shrink-0"
          onClick={(e) => {
            e.stopPropagation()
            onDuplicate()
          }}
          title="Duplicate as a user-editable Template"
        >
          Dupl
        </button>
        {!template.builtin && (
          <>
            <button
              className="btn text-[10px] py-0 px-1.5 leading-tight shrink-0"
              onClick={(e) => {
                e.stopPropagation()
                onAddFunction()
              }}
              title="Add a Parameter to this Template"
            >
              + Param
            </button>
            <button
              className="btn text-[10px] py-0 px-1.5 leading-tight shrink-0"
              onClick={(e) => {
                e.stopPropagation()
                onRemoveTemplate()
              }}
              title="Delete this Template"
              style={{ borderColor: 'rgb(var(--c-danger))', color: 'rgb(var(--c-danger))' }}
            >
              ✕
            </button>
          </>
        )}
      </div>

      {/* Parameters — child rows, hidden when collapsed. */}
      {expanded &&
        template.functions.map((fn) => (
          <FunctionRow
            key={fn.id}
            template={template}
            fn={fn}
            isSelected={
              selection?.kind === 'function' &&
              selection.templateId === template.id &&
              selection.functionId === fn.id
            }
            onSelect={() =>
              onSelect({
                kind: 'function',
                templateId: template.id,
                functionId: fn.id
              })
            }
            onRemove={() => onRemoveFunction(fn.id, fn.name)}
            allowRemove={!template.builtin}
          />
        ))}
    </div>
  )
}

function FunctionRow({
  template,
  fn,
  isSelected,
  onSelect,
  onRemove,
  allowRemove
}: {
  template: InstrumentTemplate
  fn: InstrumentFunction
  isSelected: boolean
  onSelect: () => void
  onRemove: () => void
  allowRemove: boolean
}): JSX.Element {
  function onFunctionDragStart(e: React.DragEvent): void {
    const payload: PoolFunctionDragPayload = {
      templateId: template.id,
      functionId: fn.id
    }
    e.dataTransfer.setData(POOL_FUNCTION_DRAG_MIME, JSON.stringify(payload))
    e.dataTransfer.effectAllowed = 'copy'
    e.stopPropagation()
  }
  return (
    <div
      draggable
      onDragStart={onFunctionDragStart}
      onClick={(e) => {
        e.stopPropagation()
        onSelect()
      }}
      className={`flex items-center gap-2 pl-7 pr-1 py-0 leading-tight cursor-grab text-[11px] ${
        isSelected ? 'bg-panel2' : 'hover:bg-panel2/60'
      }`}
      style={{ borderLeft: `3px solid ${template.color}33` }}
      title="Drag onto the Edit-view sidebar to instantiate just this Parameter."
    >
      <span className="truncate">{fn.name}</span>
      <span
        className="text-[9px] text-muted shrink-0 px-1 rounded-sm border border-border"
        title={`${fn.paramType.toUpperCase()} · ${fn.nature} · ${fn.streamMode}${
          fn.unit ? ` · ${fn.unit}` : ''
        }`}
      >
        {fn.paramType}
      </span>
      <div className="flex-1" />
      {allowRemove && (
        <button
          className="btn text-[10px] py-0 px-1.5 leading-tight shrink-0"
          onClick={(e) => {
            e.stopPropagation()
            onRemove()
          }}
          title="Delete this Parameter"
          style={{ borderColor: 'rgb(var(--c-danger))', color: 'rgb(var(--c-danger))' }}
        >
          ✕
        </button>
      )}
    </div>
  )
}

function ParameterRow({
  param,
  isSelected,
  onSelect,
  onDuplicate,
  onRemove
}: {
  param: ParameterTemplate
  isSelected: boolean
  onSelect: () => void
  onDuplicate: () => void
  onRemove?: () => void
}): JSX.Element {
  function onParamDragStart(e: React.DragEvent): void {
    const payload: PoolParameterDragPayload = { parameterId: param.id }
    e.dataTransfer.setData(POOL_PARAMETER_DRAG_MIME, JSON.stringify(payload))
    e.dataTransfer.effectAllowed = 'copy'
  }
  return (
    <div
      draggable
      onDragStart={onParamDragStart}
      onClick={onSelect}
      className={`relative flex items-center gap-1 px-1 py-[1px] cursor-grab text-[12px] leading-tight ${
        isSelected ? 'bg-panel2' : 'hover:bg-panel2/60'
      }`}
      style={{ borderLeft: `3px solid ${param.color}` }}
      title="Drag onto the Edit-view sidebar to instantiate as an orphan Parameter row."
    >
      <span className="w-5 shrink-0" />
      <span className="font-semibold truncate">{param.name}</span>
      {param.builtin && (
        <span
          className="text-[9px] text-muted px-1 py-0 rounded-sm border border-border shrink-0"
          title="Built-in parameter — clone to edit"
        >
          BUILT-IN
        </span>
      )}
      <span
        className="text-[9px] text-muted shrink-0 px-1 rounded-sm border border-border"
        title={`${param.paramType.toUpperCase()} · ${param.nature} · ${param.streamMode}${
          param.unit ? ` · ${param.unit}` : ''
        }`}
      >
        {param.paramType}
      </span>
      <div className="flex-1" />
      <button
        className="btn text-[10px] py-0 px-1.5 leading-tight shrink-0"
        onClick={(e) => {
          e.stopPropagation()
          onDuplicate()
        }}
        title="Duplicate as a user-editable Parameter"
      >
        Dupl
      </button>
      {onRemove && (
        <button
          className="btn text-[10px] py-0 px-1.5 leading-tight shrink-0"
          onClick={(e) => {
            e.stopPropagation()
            onRemove()
          }}
          title="Delete this Parameter blueprint"
          style={{ borderColor: 'rgb(var(--c-danger))', color: 'rgb(var(--c-danger))' }}
        >
          ✕
        </button>
      )}
    </div>
  )
}
