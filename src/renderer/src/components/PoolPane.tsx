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

import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useStore } from '../store'
import type {
  DiscoveredOscDevice,
  ForwardDiagEntry,
  InstrumentFunction,
  InstrumentTemplate,
  NetworkListenerStatus,
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
// Four tabs: Built-in (shipped library), User (authored Instruments +
// Parameters), Network (auto-discovered OSC senders), Scenes
// (cross-session saved scenes from the on-disk library).
//
// Bumped the storage key (poolTab:v4) when adding "scenes" so a stale
// localStorage value can't poison the union. Old keys parse to 'user'.
const POOL_TAB_KEY = 'dataflou:poolTab:v4'
type PoolTab = 'builtin' | 'user' | 'network' | 'scenes'
function loadPoolTab(): PoolTab {
  try {
    const v = typeof localStorage !== 'undefined' ? localStorage.getItem(POOL_TAB_KEY) : null
    if (v === 'builtin' || v === 'user' || v === 'network' || v === 'scenes') return v
  } catch {
    /* ignore */
  }
  return 'user'
}

// MIME type for dragging a saved scene from the Pool onto the
// Scenes palette / a sequence slot. The drop target reads the
// payload, calls instantiateSavedScene, and (optionally) drops the
// new scene into a specific sequence slot.
export const POOL_SAVED_SCENE_DRAG_MIME =
  'application/x-dataflou-pool-saved-scene'
export interface PoolSavedSceneDragPayload {
  savedSceneId: string
}

// Listening-port for the network discovery UDP socket. Persisted so the
// user's choice (e.g. 8000 if 9000 conflicts) survives app restarts.
const NETWORK_PORT_KEY = 'dataflou:networkPort:v1'
function loadNetworkPort(): number {
  try {
    const raw =
      typeof localStorage !== 'undefined' ? localStorage.getItem(NETWORK_PORT_KEY) : null
    const n = raw == null ? NaN : parseInt(raw, 10)
    if (Number.isFinite(n) && n >= 1 && n <= 65535) return n
  } catch {
    /* ignore */
  }
  return 9000
}
function saveNetworkPort(p: number): void {
  try {
    localStorage.setItem(NETWORK_PORT_KEY, String(p))
  } catch {
    /* ignore */
  }
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
  // Network discovery state — devices + listener status pushed from main.
  const networkDevices = useStore((s) => s.networkDevices)
  const networkStatus = useStore((s) => s.networkStatus)
  const setNetworkSnapshot = useStore((s) => s.setNetworkSnapshot)
  // Saved-scene library — pushed from main on every save/remove.
  // Subscription is hoisted to App.tsx so the cache stays fresh even
  // when the Pool drawer is collapsed.
  const sceneLibrary = useStore((s) => s.sceneLibrary)
  const setCaptureOpen = useStore((s) => s.setCaptureOpen)
  const instantiateSavedScene = useStore((s) => s.instantiateSavedScene)
  const removeSavedScene = useStore((s) => s.removeSavedScene)

  // Which view: built-in / user / network. Persisted so the user's
  // filter choice carries across drawer toggles.
  const [tab, setTabState] = useState<PoolTab>(loadPoolTab)
  const clearSavedSceneSelection = useStore((s) => s.clearSavedSceneSelection)
  function setTab(t: PoolTab): void {
    // Leaving the Scenes tab? Clear the Saved-Scene multi-selection
    // so a stale Del-press from another tab can't silently delete
    // scenes the user can no longer see highlighted.
    if (tab === 'scenes' && t !== 'scenes') {
      clearSavedSceneSelection()
    }
    setTabState(t)
    try {
      localStorage.setItem(POOL_TAB_KEY, t)
    } catch {
      /* quota exceeded — ignore */
    }
  }

  // Subscribe to main-process network device pushes whenever the
  // Pool pane is mounted. Cheap (~250ms cadence, only when devices
  // change), and unsubscribes cleanly on unmount so re-mounting the
  // Pool drawer doesn't double-bind handlers.
  // Network listener subscription lives in App.tsx now — keeping it
  // at app-level means the title-bar status dot can reflect live bind
  // errors even when the Pool drawer is collapsed. This component
  // just reads the resulting Zustand state.
  // (The previous subscription in this effect leaked tear-down on
  // every PoolPane mount/unmount and stopped updating the dot when
  // the user hid the drawer.)

  // Drafts back the live "Add Instrument" sidebar rows; keep them out
  // of the Pool browser until the user explicitly Saves-as-Template.
  // Filter the currently visible items based on the tab. Network tab
  // doesn't show templates/parameters — it renders its own list below.
  let visibleTemplates: InstrumentTemplate[] = []
  let visibleParameters: ParameterTemplate[] = []
  if (tab === 'builtin') {
    visibleTemplates = allTemplates.filter((t) => !t.draft && t.builtin)
    visibleParameters = allParameters.filter((p) => p.builtin)
  } else if (tab === 'user') {
    // User tab — both user Instruments and user Parameter blueprints
    // share the same scrollable list, separated by section headers.
    visibleTemplates = allTemplates.filter((t) => !t.draft && !t.builtin)
    visibleParameters = allParameters.filter((p) => !p.builtin)
  }
  // tab === 'network' → templates/parameters stay empty; NetworkTab
  // handles the rendering itself.

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
        // `flex-nowrap` + `whitespace-nowrap` on every child guarantees
        // the title bar stays single-line at the User tab's wider
        // trailing cluster (+ Instrument / + Parameter / ⤢ / Hide) —
        // without it "Built-in" wrapped onto two rows. Right-side
        // buttons use the compact `text-[9px]` + `px-1` sizing so all
        // four can sit next to the tabs even at narrow drawer widths.
        // `min-h-[28px]` matches the Monitor's toolbar height so the
        // two sit on the same visual line.
        className="flex items-center gap-1.5 px-2 py-1 border-b border-border shrink-0 cursor-default select-none flex-nowrap min-h-[28px]"
        onDoubleClick={() => onTogglePopOut?.()}
        title={poppedOut ? 'Drag to move · Double-click to dock' : 'Double-click to pop out'}
        style={{ touchAction: titleBarHandlers ? 'none' : undefined, ...titleBarHandlers?.style }}
      >
        <span className="label shrink-0">Pool</span>
        {/* Vertical separator between the static "Pool" label and the
            clickable tab strip — otherwise the label reads as a
            disabled 5th tab. */}
        <span className="h-4 w-px bg-border shrink-0" />
        <div className="flex items-center gap-0.5 shrink-0">
          <FilterTab label="Built-in" active={tab === 'builtin'} onClick={() => setTab('builtin')} />
          <FilterTab label="User" active={tab === 'user'} onClick={() => setTab('user')} />
          <FilterTab
            label="Scenes"
            active={tab === 'scenes'}
            onClick={() => setTab('scenes')}
          />
          <FilterTab
            label="Network"
            active={tab === 'network'}
            onClick={() => setTab('network')}
            // Tiny green dot when the passive listener is bound — same
            // visual language as the OSC monitor's "wire alive" cue.
            dot={networkStatus.enabled ? 'on' : networkStatus.lastError ? 'err' : 'off'}
          />
        </div>
        {tab === 'network' ? (
          <span
            className="text-muted text-[10px] shrink-0 whitespace-nowrap"
            title="Discovered OSC senders"
          >
            {networkDevices.length}D
          </span>
        ) : tab === 'scenes' ? (
          <span
            className="text-muted text-[10px] shrink-0 whitespace-nowrap"
            title="Saved scenes in the global library"
          >
            {sceneLibrary.length}S
          </span>
        ) : (
          <span className="text-muted text-[10px] shrink-0 whitespace-nowrap">
            {visibleTemplates.length}I · {visibleParameters.length}P
          </span>
        )}
        <div className="flex-1 min-w-0" />
        {/* Listening pill — shows EXACTLY what IP:port to point an
            incoming OSC sender (OCTOCOSME, TouchOSC, etc.) at so the
            Capture popup will see its packets. Placed immediately to
            the LEFT of the Capture button so the two read as a unit:
            "this is what we're listening to → capture from it". */}
        <ListeningPill
          status={networkStatus}
          devicesCount={networkDevices.length}
          onToggle={() => {
            window.api
              ?.networkSetEnabled?.(!networkStatus.enabled, networkStatus.port)
              .then((next) => {
                if (next) setNetworkSnapshot(networkDevices, next)
              })
          }}
          onDoubleClick={() => setCaptureOpen(true)}
        />
        {/* Capture button — opens the modal that snapshots a live
            OSC or MIDI device into the Pool (and optionally builds a
            Scene from it). Visible on every tab so the user doesn't
            have to switch tabs first. */}
        <button
          className="btn text-[9px] py-0 px-1.5 leading-tight shrink-0 whitespace-nowrap"
          onClick={() => setCaptureOpen(true)}
          title="Snapshot an incoming OSC or MIDI device — choose between New OSC Instrument, New Scene, or New MIDI Instrument"
          style={{ borderColor: 'rgb(var(--c-accent))', color: 'rgb(var(--c-accent))' }}
        >
          ● Capture
        </button>
        {tab === 'user' && (
          <>
            <button
              className="btn text-[9px] py-0 px-1 leading-tight shrink-0 whitespace-nowrap"
              onClick={() => addTemplate()}
              title="Create a new empty Instrument"
            >
              + Instr
            </button>
            <button
              className="btn text-[9px] py-0 px-1 leading-tight shrink-0 whitespace-nowrap"
              onClick={() => addParameter()}
              title="Create a new Parameter blueprint"
            >
              + Param
            </button>
          </>
        )}
        {onTogglePopOut && (
          <button
            className="btn text-[9px] py-0 px-1 leading-tight shrink-0"
            onClick={onTogglePopOut}
            title={poppedOut ? 'Dock back into the drawer' : 'Pop out to a centered window'}
          >
            {poppedOut ? '⤓' : '⤢'}
          </button>
        )}
        {onHide && (
          <button
            className="btn text-[9px] py-0 px-1 leading-tight shrink-0"
            onClick={onHide}
            title="Hide the Pool (P to toggle)"
          >
            Hide
          </button>
        )}
      </div>

      {/* Body — scrollable list. Built-in / User tabs render the
          two-section structure (Instruments + Parameters). Network
          and Scenes tabs render their own bodies. */}
      <div className="flex-1 min-h-0 overflow-y-auto py-1">
        {tab === 'network' ? (
          <NetworkTab devices={networkDevices} />
        ) : tab === 'scenes' ? (
          <ScenesTab
            scenes={sceneLibrary}
            onInstantiate={(id) => {
              const newSceneId = instantiateSavedScene(id)
              if (newSceneId) {
                // Focus the freshly-instantiated scene in the
                // session so the inspector lands on it.
                useStore.getState().setFocusedScene(newSceneId)
              }
            }}
            onRemove={(id, name) => {
              if (confirm(`Delete saved scene "${name}"?`)) {
                void removeSavedScene(id)
              }
            }}
          />
        ) : (
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
        )}
      </div>
    </div>
  )
}

function FilterTab({
  label,
  active,
  onClick,
  dot
}: {
  label: string
  active: boolean
  onClick: () => void
  // Optional status dot — used by the Network tab to indicate whether
  // the passive UDP listener is bound. 'on' = green, 'err' = red,
  // 'off' = no dot.
  dot?: 'on' | 'off' | 'err'
}): JSX.Element {
  return (
    <button
      // `whitespace-nowrap` is the critical bit — without it the
      // "Built-in" label wraps onto two rows once the User-tab's
      // trailing cluster (+ Instr / + Param / ⤢ / Hide) takes its
      // share of the title-bar width.
      className={`text-[10px] px-1.5 py-0 leading-tight rounded border inline-flex items-center gap-1 whitespace-nowrap shrink-0 ${
        active
          ? 'bg-accent text-black border-accent'
          : 'border-border text-muted hover:text-text'
      }`}
      onClick={onClick}
    >
      {label}
      {dot === 'on' && (
        <span
          className="inline-block w-1.5 h-1.5 rounded-full"
          style={{ background: 'rgb(var(--c-success))' }}
        />
      )}
      {dot === 'err' && (
        <span
          className="inline-block w-1.5 h-1.5 rounded-full"
          style={{ background: 'rgb(var(--c-danger))' }}
        />
      )}
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
        // `min-h-[20px]` + `items-center` matches the Monitor's
        // column-header row (OSC `time | kind | …` / MIDI `time |
        // kind | …`) so the INSTRUMENTS divider sits on the same
        // visual line. `border-b` mirrors the Monitor's header
        // separator for visual symmetry.
        <div className="flex items-center px-2 text-[9px] uppercase tracking-wide text-muted border-b border-border min-h-[20px]">
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
        // PARAMETERS divider — same height contract as INSTRUMENTS
        // above. Slight `mt-1` keeps a breath of space between the
        // Instruments list and the Parameters section without
        // breaking the row-height match.
        <div className="flex items-center px-2 mt-1 text-[9px] uppercase tracking-wide text-muted border-y border-border min-h-[20px]">
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
        {/* Transport summary for the Template — aggregates across
            children. OSC is on if any child has a non-empty oscPath
            (true for every existing built-in); MIDI is on if any
            child has midiOut.enabled. */}
        <TransportPill
          oscOn={template.functions.some((f) => !!f.oscPath)}
          midiOn={template.functions.some((f) => !!f.midiOut?.enabled)}
        />
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
      <TransportPill
        oscOn={!!fn.oscPath}
        midiOn={!!fn.midiOut?.enabled}
      />
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
      <TransportPill
        oscOn={!!param.oscPath}
        midiOn={!!param.midiOut?.enabled}
      />
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

// ─────────────────────────────────────────────────────────────────────
// Network tab — passive OSC discovery. Shows the listener status +
// every (ip:port) we've ever seen a packet from since enabling.
// Drag a device onto the Edit sidebar → materialised as a user
// Instrument with one Parameter per observed OSC address.
// ─────────────────────────────────────────────────────────────────────

function NetworkTab({ devices }: { devices: DiscoveredOscDevice[] }): JSX.Element {
  const status = useStore((s) => s.networkStatus)
  const setNetworkSnapshot = useStore((s) => s.setNetworkSnapshot)
  const materialise = useStore((s) => s.materialiseNetworkDevice)
  // v0.5.10 -- session.listenerPort takes priority over the
  // localStorage fallback. When set, the TopBar's "Listen on" input
  // and this NetworkTab input show the same value and write through
  // the same store action so the two surfaces stay in sync.
  const sessionListenerPort = useStore((s) => s.session.listenerPort)
  const setListenerPort = useStore((s) => s.setListenerPort)
  const rebindAllHardwareModes = useStore(
    (s) => s.rebindAllHardwareModesToDevice
  )
  // (v0.5.12) Per-template right-click bind feeds these into the
  // NetworkDeviceRow menu so each Pool template appears as its own
  // "Bind to <name>" action.
  const poolTemplates = useStore((s) => s.session.pool.templates)
  const setTemplateHardwareMode = useStore((s) => s.setTemplateHardwareMode)
  // Port input is local (mirrored from session.listenerPort if set,
  // else status.port from main, else the localStorage fallback). We
  // don't bind it directly to any of those because the user edits
  // free-form before hitting "Apply".
  const [portInput, setPortInput] = useState<number>(() =>
    sessionListenerPort || status.port || loadNetworkPort()
  )
  // Track whether the port input is currently focused so external
  // status pushes don't overwrite the user's in-progress typing. The
  // ref is updated synchronously by the input's focus / blur handlers.
  const portInputFocused = useRef(false)
  // Pending-rebind spinner — set true between dispatch and the next
  // status update so the user can tell the listener is restarting.
  const [busy, setBusy] = useState(false)
  // Track which devices are expanded (show address list). Default
  // collapsed so the list stays scannable; one click expands.
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set())
  function toggleExpand(id: string): void {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }
  // Tick at 1Hz so the "last seen" age labels refresh between
  // network pushes. Without this the row would read "5s" frozen
  // until the next device-map change forces a re-render.
  const [, ageTick] = useState(0)
  useEffect(() => {
    const id = setInterval(() => ageTick((n) => n + 1), 1000)
    return () => clearInterval(id)
  }, [])

  // Keep the port input synced when status pushes change the bound
  // port (e.g. another tab applied a different port, or the user re-
  // enabled the listener and we picked up the persisted port from
  // main). Skip the sync while the user is actively focused on the
  // input — otherwise typing "9001" right when a status push arrives
  // for the same port snaps the field mid-edit.
  useEffect(() => {
    if (portInputFocused.current) return
    if (status.port && status.port !== portInput) setPortInput(status.port)
    // We don't include portInput in the deps — we only want to react
    // to external port changes, not to the user's own typing.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status.port])

  // v0.5.10 -- also keep in sync with session.listenerPort, which
  // can be changed from the TopBar's "Listen on" input or by
  // loading a session file. Same focus-guard rules.
  useEffect(() => {
    if (portInputFocused.current) return
    if (sessionListenerPort && sessionListenerPort !== portInput) {
      setPortInput(sessionListenerPort)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionListenerPort])

  async function applyToggle(): Promise<void> {
    setBusy(true)
    try {
      const next = await window.api?.networkSetEnabled?.(
        !status.enabled,
        portInput
      )
      if (next) {
        // Push the post-action status into the store so the dot + port
        // display stay in sync without waiting for the next periodic
        // push (which won't fire if no devices changed).
        setNetworkSnapshot(devices, next)
        if (next.port !== portInput) setPortInput(next.port)
      }
    } finally {
      setBusy(false)
    }
  }
  async function applyPort(): Promise<void> {
    if (!Number.isFinite(portInput) || portInput < 1 || portInput > 65535) return
    saveNetworkPort(portInput)
    // v0.5.10 -- write through to session.listenerPort so the
    // binding survives save/load AND the TopBar's "Listen on"
    // input reflects the same value. setListenerPort also pushes
    // to the main-process listener via IPC, so we don't need to
    // call networkSetEnabled separately when the listener is
    // already enabled.
    setListenerPort(portInput)
    setBusy(true)
    try {
      // Re-bind on the new port. Pass current enabled state so we
      // stay on if already listening, or stay off if we weren't.
      // (setListenerPort always passes enabled=true, but if the
      // user had the listener OFF we want to preserve that here.)
      const next = await window.api?.networkSetEnabled?.(
        status.enabled,
        portInput
      )
      if (next) setNetworkSnapshot(devices, next)
    } finally {
      setBusy(false)
    }
  }
  async function clearAll(): Promise<void> {
    await window.api?.networkClear?.()
    // The clear handler pushes an empty snapshot immediately, so no
    // local state mutation needed — the store update will re-render us.
  }

  return (
    <div className="flex flex-col">
      {/* Status header — toggle, port input, "send to" hint. */}
      <div className="px-2 pt-1 pb-2 border-b border-border/60 flex flex-col gap-1">
        <div className="flex items-center gap-1">
          <button
            className={`text-[10px] px-2 py-0 leading-tight rounded border ${
              status.enabled
                ? 'bg-accent text-black border-accent'
                : 'border-border text-muted hover:text-text'
            }`}
            disabled={busy}
            onClick={applyToggle}
            title={
              status.enabled
                ? 'Stop listening for OSC packets'
                : 'Bind a UDP port and watch for incoming OSC senders'
            }
          >
            {status.enabled ? 'Listening' : 'Listen'}
          </button>
          <span className="text-[10px] text-muted">on port</span>
          <input
            type="number"
            min={1}
            max={65535}
            className="bg-panel2 border border-border rounded text-[10px] px-1 py-0 w-[58px] leading-tight"
            // Render empty when the cleared field would otherwise show
            // "0". The actual numeric port stays at the last valid
            // value in state so `applyPort` doesn't try to bind on 0.
            value={portInput > 0 ? portInput : ''}
            onChange={(e) => {
              // Keep portInput at the last valid value if the user
              // clears the field — display goes empty but the bind
              // target doesn't flip to 0. Re-parse on every keystroke.
              const parsed = parseInt(e.target.value, 10)
              if (Number.isFinite(parsed) && parsed >= 1 && parsed <= 65535) {
                setPortInput(parsed)
              } else if (e.target.value === '') {
                // Sentinel value 0 → renders as empty (above) but
                // applyPort() rejects (below).
                setPortInput(0)
              }
            }}
            onFocus={() => {
              portInputFocused.current = true
            }}
            onBlur={() => {
              portInputFocused.current = false
              if (portInput >= 1 && portInput !== status.port) applyPort()
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') (e.currentTarget as HTMLInputElement).blur()
            }}
          />
          <div className="flex-1" />
          <button
            className="btn text-[10px] py-0 px-1.5 leading-tight"
            onClick={clearAll}
            disabled={devices.length === 0}
            title="Forget every discovered device — useful after moving networks"
          >
            Clear
          </button>
        </div>
        {/* Local-IP hint — tells the user where to point their device. */}
        {status.enabled && status.localAddresses.length > 0 && (
          <div className="text-[9px] text-muted leading-snug">
            Tell your OSC sender to target{' '}
            <span className="font-mono text-text">
              {status.localAddresses.join(' or ')}
              {':'}
              {status.port}
            </span>
          </div>
        )}
        {!!status.lastError && (
          <div
            className="text-[9px] leading-snug"
            style={{ color: 'rgb(var(--c-danger))' }}
            title={status.lastError}
          >
            Bind error: {status.lastError}
          </div>
        )}
        {!status.enabled && !status.lastError && (
          <div className="text-[9px] text-muted leading-snug">
            Passive discovery — click Listen to start watching for OSC
            senders on this machine&apos;s LAN.
          </div>
        )}
      </div>

      {/* Device list — one row per (ip:port), expandable to show
          observed addresses. Drag onto the Edit sidebar to materialise
          as a user Instrument Template. */}
      {devices.length === 0 ? (
        <div className="p-3 text-muted text-[11px]">
          {status.enabled
            ? 'Waiting for OSC packets…'
            : 'Enable Listen to start discovering senders.'}
        </div>
      ) : (
        <>
          <div className="px-2 pt-2 pb-0.5 text-[9px] uppercase tracking-wide text-muted">
            Discovered
          </div>
          {devices.map((d) => (
            <NetworkDeviceRow
              key={d.id}
              device={d}
              expanded={expanded.has(d.id)}
              onToggleExpand={() => toggleExpand(d.id)}
              onMaterialiseForDrag={() => materialise(d.id)}
              // Drag-cancel cleanup — used by the row's onDragEnd
              // handler to remove the just-materialised template when
              // the drop didn't land on a valid target.
              onCancelMaterialise={(tplId) => useStore.getState().removeTemplate(tplId)}
              // v0.5.10 -- right-click batch rebind. Sweeps every
              // Pool template whose hardwareMode is configured
              // and points it at this device's ip:port. Use case:
              // the user's controller moved to a new address and
              // they want every HW-Moded Instrument to follow at
              // once without editing each template by hand.
              onRebindAllHardwareModes={() =>
                rebindAllHardwareModes(d.ip, d.port)
              }
              // (v0.5.12) Per-template bind data + handler. Pass
              // every NON-DRAFT Pool template (built-in OR user) so
              // the right-click menu lists them all — built-ins are
              // HW-Mode configurable even though their definition is
              // read-only (per HardwareModeSection comment, HW Mode
              // is a per-session preference, not a template-
              // definition change). Hidden draft templates (mid-
              // materialise drag artifacts) are excluded — they're
              // not visible anywhere else in the UI.
              bindableTemplates={poolTemplates.filter((t) => !t.draft)}
              onBindTemplate={(tid, ip, port) =>
                setTemplateHardwareMode(tid, {
                  enabled: true,
                  deviceIp: ip,
                  devicePort: port
                })
              }
            />
          ))}
        </>
      )}
      {/* v0.5.10 -- HW Mode Suppress diagnostic panel. Shows whether
          the byte-forward path is being correctly suppressed for
          packets coming from HW-Moded controllers. Critical for
          show-night diagnosis of "is Max getting dual-emission
          packets that will crash it after 5 minutes". */}
      <HwModeSuppressPanel />
    </div>
  )
}

// v0.5.10 -- HW Mode Suppress diagnostic panel.
//
// THE PROBLEM IT DIAGNOSES:
//   When a HW Mode controller (e.g. OCTOCOSME) sends OSC to dataFLOU's
//   listener AND any Forward target is enabled, every packet should
//   be suppressed from the byte-forward path -- HW Mode emits a clean
//   single value via the normal cell-emit path, and re-forwarding the
//   raw packet too would land at downstream consumers (Max, PD) as a
//   DUPLICATE for the same OSC address, causing message-queue pressure
//   that crashes Max after ~5 minutes.
//
//   The suppress hook gates this. It matches on (sourceIp, sourcePort)
//   against every configured `template.hardwareMode.{deviceIp,devicePort}`.
//   If the user's HW controller's actual UDP source port DOESN'T match
//   the configured port (common when the controller binds an ephemeral
//   source rather than 8888), the suppress hook silently misses every
//   packet -- HW Mode itself ALSO misses, but Forward still fires raw.
//
// WHAT THIS PANEL SHOWS:
//   For each HW-Moded template:
//     - Configured source ip:port
//     - Live counter of received / suppressed / forwarded packets
//     - Status badge: ✓ healthy / ⚠ port mismatch / ✕ no packets / 🔥 dual-emission
//   Plus a "Suspect mismatch?" section listing any source whose IP
//   matches a HW Mode template's IP but whose PORT does not -- the
//   smoking gun for the source-port-mismatch class of bugs.
function HwModeSuppressPanel(): JSX.Element {
  const templates = useStore((s) => s.session.pool.templates)
  // Polled diagnostic counters. Re-fetched at ~2 Hz while the panel
  // is mounted. Cheap (single IPC return of <=64 small objects).
  const [diag, setDiag] = useState<ForwardDiagEntry[]>([])
  const [collapsed, setCollapsed] = useState(true)
  // Only enumerate templates that have an enabled HW Mode block --
  // the panel is dead weight when nothing is configured.
  const hwTemplates = useMemo(
    () => templates.filter((t) => t.hardwareMode && t.hardwareMode.enabled),
    [templates]
  )
  useEffect(() => {
    if (collapsed) return
    let cancelled = false
    async function poll(): Promise<void> {
      const next = await window.api?.networkGetForwardDiag?.()
      if (cancelled) return
      if (Array.isArray(next)) setDiag(next)
    }
    void poll()
    const id = setInterval(() => void poll(), 500)
    return () => {
      cancelled = true
      clearInterval(id)
    }
  }, [collapsed])
  async function reset(): Promise<void> {
    await window.api?.networkClearForwardDiag?.()
    setDiag([])
  }
  // Build a quick index of seen sources for cross-reference. Keys:
  // both `ip:port` (exact match) and `ip` (fuzzy / port-agnostic).
  const byExact = useMemo(() => {
    const m = new Map<string, ForwardDiagEntry>()
    for (const e of diag) m.set(`${e.ip}:${e.port}`, e)
    return m
  }, [diag])
  const byIp = useMemo(() => {
    const m = new Map<string, ForwardDiagEntry[]>()
    for (const e of diag) {
      const arr = m.get(e.ip) ?? []
      arr.push(e)
      m.set(e.ip, arr)
    }
    return m
  }, [diag])
  // Total dual-emission count across all configured templates --
  // surfaces a "everything's fine" / "danger" headline on the
  // collapsed pill.
  const totalDualEmission = useMemo(() => {
    let n = 0
    for (const t of hwTemplates) {
      const hw = t.hardwareMode
      if (!hw) continue
      const e = byExact.get(`${hw.deviceIp}:${hw.devicePort}`)
      if (e) n += e.forwarded
    }
    return n
  }, [hwTemplates, byExact])
  if (hwTemplates.length === 0) {
    // No HW Mode templates configured -- panel is informational only.
    // Render a tiny stub so the surface is discoverable when the
    // user enables their first HW Mode block.
    return (
      <div className="px-2 pt-3 pb-2 border-t border-border/60">
        <div className="text-[10px] text-muted leading-snug">
          <span className="font-semibold text-text">HW Mode Suppress:</span>{' '}
          no Hardware Mode templates configured -- nothing to diagnose
          here. Enable Hardware Mode on a Pool Instrument to surface
          per-source suppress counters.
        </div>
      </div>
    )
  }
  return (
    <div className="px-2 pt-2 pb-2 border-t border-border/60 flex flex-col gap-1">
      <div className="flex items-center gap-1">
        <button
          className="text-muted hover:text-text text-[10px] leading-none w-4 shrink-0"
          onClick={() => setCollapsed((v) => !v)}
          title={collapsed ? 'Expand' : 'Collapse'}
        >
          {collapsed ? '▸' : '▾'}
        </button>
        <span className="text-[10px] uppercase tracking-wide text-muted">
          HW Mode Suppress
        </span>
        <span
          className="inline-block w-1.5 h-1.5 rounded-full ml-1"
          style={{
            background:
              totalDualEmission > 0
                ? 'rgb(var(--c-danger))'
                : 'rgb(var(--c-success))'
          }}
          title={
            totalDualEmission > 0
              ? `${totalDualEmission} unsuppressed packets from HW-Moded sources -- Max/PD may receive duplicates`
              : 'No dual-emission detected from configured HW-Moded sources'
          }
        />
        <div className="flex-1" />
        {!collapsed && (
          <button
            className="text-[9px] text-muted hover:text-text px-1 leading-tight"
            onClick={reset}
            title="Reset per-source counters without clearing the device list"
          >
            Reset
          </button>
        )}
      </div>
      {!collapsed && (
        <>
          <div className="text-[9px] text-muted leading-snug">
            For each HW Mode template, counts packets from its
            configured source ip:port. `suppressed` is good (no dual
            emission). `forwarded` from a HW-Moded source is BAD --
            Max/PD will see duplicate values per OSC address.
          </div>
          {hwTemplates.map((t) => {
            const hw = t.hardwareMode!
            const exactKey = `${hw.deviceIp}:${hw.devicePort}`
            const exact = byExact.get(exactKey)
            const sameIp = byIp.get(hw.deviceIp) ?? []
            const mismatches = sameIp.filter(
              (e) => e.port !== hw.devicePort
            )
            // Status badge selection. Priority: dual emission > port
            // mismatch (no exact match but IP seen on other port) > no
            // packets > healthy.
            let badge: { label: string; color: string; tip: string }
            if (exact && exact.forwarded > 0) {
              badge = {
                label: '🔥 DUAL EMISSION',
                color: 'rgb(var(--c-danger))',
                tip: `${exact.forwarded} packets reached Forward without being suppressed. Max/PD will see duplicate values per OSC address -- expect crashes after sustained streaming.`
              }
            } else if (!exact && mismatches.length > 0) {
              badge = {
                label: '⚠ PORT MISMATCH',
                color: 'rgb(var(--c-warning, 234 179 8))',
                tip: `No packets at the configured ${hw.deviceIp}:${hw.devicePort}, but packets arrived from ${hw.deviceIp} on a DIFFERENT source port. Suppress hook never fires. Likely the controller's UDP source port is ephemeral -- update the HW Mode device port to match the actually-seen one (below), or pin the source port on the controller firmware.`
              }
            } else if (!exact) {
              badge = {
                label: '✕ NO PACKETS',
                color: 'rgb(var(--c-muted))',
                tip: `No packets observed from ${hw.deviceIp}:${hw.devicePort}. Either the controller is offline, addressed at the wrong listener port, or unreachable on the network.`
              }
            } else {
              badge = {
                label: '✓ HEALTHY',
                color: 'rgb(var(--c-success))',
                tip: `${exact.suppressed} packets suppressed. No dual-emission risk.`
              }
            }
            return (
              <div
                key={t.id}
                className="flex flex-col gap-0.5 px-1.5 py-1 border border-border/40 rounded text-[10px]"
              >
                <div className="flex items-center gap-1">
                  <span className="font-semibold text-text truncate flex-1">
                    {t.name}
                  </span>
                  <span
                    className="text-[9px] px-1 py-0 rounded-sm font-mono shrink-0"
                    style={{ color: badge.color, borderColor: badge.color }}
                    title={badge.tip}
                  >
                    {badge.label}
                  </span>
                </div>
                <div className="text-[9px] text-muted leading-tight">
                  Configured:{' '}
                  <span className="font-mono text-text">
                    {hw.deviceIp}:{hw.devicePort}
                  </span>
                </div>
                <div className="flex items-center gap-3 text-[9px] tabular-nums font-mono">
                  <span title="UDP packets observed from the configured source">
                    recv:{' '}
                    <span className="text-text">{exact?.received ?? 0}</span>
                  </span>
                  <span
                    title="Packets the suppress hook claimed (= HW Mode absorbed them, no dual-emission risk)"
                    style={{ color: 'rgb(var(--c-success))' }}
                  >
                    supp: {exact?.suppressed ?? 0}
                  </span>
                  <span
                    title="Packets the suppress hook did NOT claim (= would reach Max/PD via Forward, dual-emission risk)"
                    style={{
                      color:
                        (exact?.forwarded ?? 0) > 0
                          ? 'rgb(var(--c-danger))'
                          : 'rgb(var(--c-muted))'
                    }}
                  >
                    fwd: {exact?.forwarded ?? 0}
                  </span>
                  {/* (v0.5.12) Last-seen wall-clock. Stale lastSeen
                      reveals the "configured source is silent"
                      condition even when the counter is healthy
                      (counters never decrease — they could be
                      historical). */}
                  {typeof exact?.lastSeenAtMs === 'number' && exact.lastSeenAtMs > 0 && (
                    <span
                      className="ml-auto"
                      title={`Wall-clock of most recent packet from ${hw.deviceIp}:${hw.devicePort}.`}
                      style={{
                        color:
                          Date.now() - exact.lastSeenAtMs < 5000
                            ? 'rgb(var(--c-success))'
                            : 'rgb(var(--c-warning, 234 179 8))'
                      }}
                    >
                      {formatAge(Date.now() - exact.lastSeenAtMs)} ago
                    </span>
                  )}
                </div>
                {mismatches.length > 0 && (
                  <div
                    className="text-[9px] leading-snug border-t border-border/40 pt-1 mt-0.5"
                    style={{ color: 'rgb(var(--c-warning, 234 179 8))' }}
                  >
                    Suspect: same IP on other source port(s):{' '}
                    {mismatches.map((m, i) => (
                      <span key={`${m.ip}:${m.port}`} className="font-mono">
                        {i > 0 && ', '}
                        {m.ip}:{m.port}
                        <span className="text-muted">
                          {' '}
                          ({m.received} pkt)
                        </span>
                      </span>
                    ))}
                    . Update the template's device port to match if
                    this is the same physical device.
                  </div>
                )}
              </div>
            )
          })}
        </>
      )}
    </div>
  )
}

function NetworkDeviceRow({
  device,
  expanded,
  onToggleExpand,
  onMaterialiseForDrag,
  onCancelMaterialise,
  onRebindAllHardwareModes,
  bindableTemplates,
  onBindTemplate
}: {
  device: DiscoveredOscDevice
  expanded: boolean
  onToggleExpand: () => void
  // Synchronously creates an InstrumentTemplate in the Pool from this
  // device and returns the new template id, ready to embed in the
  // existing POOL_TEMPLATE_DRAG_MIME drag payload. Drag-start calls
  // this so the drop target (Edit sidebar) sees a real template id.
  onMaterialiseForDrag: () => string | null
  // Drag-cancel cleanup. Without this, every aborted drag (Esc, drop
  // outside any handler, dropped onto a non-accepting zone) would
  // leave the just-materialised template stranded in the Pool. We
  // call this on dragend when dataTransfer.dropEffect === 'none'.
  onCancelMaterialise: (tplId: string) => void
  // v0.5.10 -- right-click action: rebind every Pool template's
  // HW Mode source to this device's ip:port. The store action
  // walks templates with `hardwareMode` set and updates them in
  // place. No-op on templates without a hardwareMode block.
  onRebindAllHardwareModes: () => void
  // (v0.5.12) All Pool templates the user might want to bind THIS
  // device to (per-template right-click action). Already filtered
  // upstream to skip hidden draft templates; built-ins ARE included
  // (HW Mode is a per-session preference, not a template-definition
  // edit). Empty array hides the per-template section of the menu.
  bindableTemplates: import('@shared/types').InstrumentTemplate[]
  // (v0.5.12) Per-template bind handler — sets the chosen template's
  // hardwareMode.{deviceIp, devicePort, enabled} to this device's
  // ip:port and true, auto-enabling HW Mode if it was off.
  onBindTemplate: (templateId: string, ip: string, port: number) => void
}): JSX.Element {
  // Right-click context menu. We track the mouse coords so the
  // floating menu lands where the user clicked. State lives here
  // (per-row) because the menu only affects this device. Closed
  // by clicking outside, pressing Esc, or invoking an action.
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number } | null>(null)
  useEffect(() => {
    if (!ctxMenu) return
    const close = (): void => setCtxMenu(null)
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setCtxMenu(null)
    }
    window.addEventListener('mousedown', close)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', close)
      window.removeEventListener('keydown', onKey)
    }
  }, [ctxMenu])
  // Track the id committed at drag-start so onDragEnd can roll back
  // if the drop didn't take. Using a ref instead of state keeps the
  // value stable across React renders that happen between dragstart
  // and dragend.
  const materialisedIdRef = useRef<string | null>(null)
  function onDragStart(e: React.DragEvent): void {
    // Materialise into the Pool right now so the drop target can
    // treat us as a normal POOL_TEMPLATE_DRAG_MIME source. Zustand's
    // set() is synchronous so the new template is visible immediately.
    const newId = onMaterialiseForDrag()
    if (!newId) {
      e.preventDefault()
      return
    }
    materialisedIdRef.current = newId
    const payload: PoolTemplateDragPayload = { templateId: newId }
    e.dataTransfer.setData(POOL_TEMPLATE_DRAG_MIME, JSON.stringify(payload))
    e.dataTransfer.effectAllowed = 'copy'
  }
  function onDragEnd(e: React.DragEvent): void {
    // `dropEffect` is 'none' when the user pressed Esc, dropped over
    // a non-accepting target, or released outside the window. In any
    // of those cases the template is orphaned in the Pool — remove
    // it so the user doesn't accumulate junk Instruments across
    // aborted drags. A successful drop leaves dropEffect = 'copy'.
    const tplId = materialisedIdRef.current
    materialisedIdRef.current = null
    if (!tplId) return
    if (e.dataTransfer.dropEffect === 'none') {
      onCancelMaterialise(tplId)
    }
  }

  // Time since last packet — rough freshness indicator. We render
  // text rather than relying on a live ticker so the row doesn't
  // re-paint on every status push when nothing else changed.
  const ageMs = Date.now() - device.lastSeen
  const ageLabel = formatAge(ageMs)
  const isFresh = ageMs < 2000

  return (
    <div className="flex flex-col">
      <div
        draggable
        onDragStart={onDragStart}
        onDragEnd={onDragEnd}
        onClick={onToggleExpand}
        onContextMenu={(e) => {
          // v0.5.10 -- right-click opens the HW Mode batch-rebind
          // menu. Keep the action small + obvious so we don't grow
          // into a kitchen-sink menu.
          e.preventDefault()
          e.stopPropagation()
          setCtxMenu({ x: e.clientX, y: e.clientY })
        }}
        className="relative flex items-center gap-1 px-1 py-[1px] cursor-grab text-[12px] leading-tight hover:bg-panel2/60"
        style={{ borderLeft: `3px solid rgb(var(--c-accent))` }}
        title="Drag onto the Edit sidebar to add as an Instrument (one Parameter per address). Right-click for HW Mode actions."
      >
        <button
          className="text-muted hover:text-text text-[15px] font-bold leading-none w-5 shrink-0"
          onClick={(e) => {
            e.stopPropagation()
            onToggleExpand()
          }}
          title={expanded ? 'Collapse' : `Expand (${device.addresses.length} addresses)`}
        >
          {expanded ? '▾' : '▸'}
        </button>
        <span
          className="font-mono text-[11px] truncate"
          style={device.isLoopback ? { opacity: 0.55, fontStyle: 'italic' } : undefined}
        >
          {device.id}
        </span>
        {/* (v0.5.12) Loopback tag — packets from 127.0.0.1 / ::1 are
            dataFLOU's own scene-to-listener-bus emissions, not a
            real external device. De-emphasize visually so the user
            doesn't pick them by mistake. */}
        {device.isLoopback && (
          <span
            className="text-[9px] uppercase px-1 rounded-sm shrink-0"
            style={{
              color: 'rgb(var(--c-muted))',
              border: '1px solid rgb(var(--c-border, 60 60 60) / 0.6)'
            }}
            title="Source IP is loopback (127.0.0.1 or ::1). This is dataFLOU's own scene-to-listener-bus pattern echoing back. Not bindable to Hardware Mode."
          >
            self loopback
          </span>
        )}
        {/* Activity dot — green when we just heard from the device,
            grey once it's been quiet for >2s. */}
        <span
          className="inline-block w-1.5 h-1.5 rounded-full shrink-0"
          style={{
            background: isFresh
              ? 'rgb(var(--c-success))'
              : 'rgb(var(--c-muted) / 0.5)'
          }}
          title={`Last packet ${ageLabel} ago`}
        />
        <span className="text-muted text-[10px] shrink-0">
          {device.addresses.length} addr · {device.packetCount} pkt
        </span>
        <div className="flex-1" />
        <span className="text-muted text-[9px] shrink-0">{ageLabel}</span>
      </div>
      {expanded && device.addresses.length > 0 && (
        <div className="flex flex-col">
          {device.addresses
            // Stable ordering by path for readability — without this
            // the list reshuffles every push as `count` ticks up.
            .slice()
            .sort((a, b) => a.path.localeCompare(b.path))
            .map((a) => (
              <div
                key={a.path}
                className="flex items-center gap-2 pl-7 pr-1 py-0 leading-tight text-[11px] hover:bg-panel2/40"
                title={`Type tags: ${a.argTypes.join('') || '∅'}  ·  ${a.count} packets`}
              >
                <span className="font-mono truncate">{a.path}</span>
                <span
                  className="text-[9px] text-muted shrink-0 px-1 rounded-sm border border-border font-mono"
                  title="OSC type tags"
                >
                  {a.argTypes.join('') || '∅'}
                </span>
                <div className="flex-1" />
                <span className="text-muted text-[10px] font-mono truncate max-w-[120px]">
                  {a.argsPreview}
                </span>
              </div>
            ))}
        </div>
      )}
      {/* v0.5.10 right-click context menu -- portalled to body so
          it isn't clipped by the Pool drawer's overflow. Single
          action for now: rebind every HW-Moded Instrument to this
          device. */}
      {ctxMenu &&
        createPortal(
          <div
            className="fixed z-[1000] bg-panel border border-border rounded shadow-lg text-[11px] py-1"
            style={{ left: ctxMenu.x, top: ctxMenu.y, minWidth: 260 }}
            onMouseDown={(e) => e.stopPropagation()}
          >
            <div className="px-2 py-1 text-[10px] text-muted border-b border-border/60">
              <span className="font-mono">{device.id}</span>
              {device.isLoopback && (
                <span className="ml-2 italic">(self loopback — HW Mode binding disabled)</span>
              )}
            </div>
            <button
              className="block w-full text-left px-3 py-1.5 hover:bg-panel2 disabled:opacity-40 disabled:cursor-not-allowed"
              disabled={!!device.isLoopback}
              onClick={() => {
                onRebindAllHardwareModes()
                setCtxMenu(null)
              }}
              title={
                device.isLoopback
                  ? 'Loopback sources cannot drive Hardware Mode — binding to one would suppress your scene\'s own emissions, breaking your forward-bus pattern.'
                  : 'For every Pool template that has Hardware Mode configured, set its source device to this ip:port. Templates without HW Mode are untouched.'
              }
            >
              Rebind every HW-Moded Instrument to this device
            </button>
            {/* (v0.5.12) Per-template bind. Shows every Pool template;
                clicking one binds JUST THAT template to this device's
                ip:port (auto-enabling HW Mode if it wasn't on yet).
                Eliminates the manual-typing-port trap that bit Vincent
                this session — the user picks the device they SEE, no
                guessing source ports. */}
            {!device.isLoopback && bindableTemplates.length > 0 && (
              <>
                <div className="border-t border-border/60 mt-1 pt-1" />
                <div className="px-2 py-0.5 text-[9px] uppercase tracking-wide text-muted">
                  Bind to template
                </div>
                {bindableTemplates.map((t) => {
                  const alreadyBound =
                    t.hardwareMode?.deviceIp === device.ip &&
                    t.hardwareMode?.devicePort === device.port
                  return (
                    <button
                      key={t.id}
                      className="block w-full text-left px-3 py-1 hover:bg-panel2 truncate"
                      onClick={() => {
                        onBindTemplate(t.id, device.ip, device.port)
                        setCtxMenu(null)
                      }}
                      title={`Set ${t.name}.hardwareMode = { deviceIp: '${device.ip}', devicePort: ${device.port}, enabled: true }. Auto-enables HW Mode if disabled.`}
                    >
                      {alreadyBound ? '✓ ' : '  '}
                      {t.name}
                      {t.hardwareMode?.enabled === false && (
                        <span className="text-muted text-[9px] ml-1">(HW Mode off)</span>
                      )}
                    </button>
                  )
                })}
              </>
            )}
          </div>,
          document.body
        )}
    </div>
  )
}

// Compact "5s", "12m", "2h" formatting for the last-seen column. Tight
// so the device row stays single-line at narrow drawer widths.
function formatAge(ms: number): string {
  if (ms < 1000) return 'now'
  if (ms < 60_000) return `${Math.floor(ms / 1000)}s`
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m`
  return `${Math.floor(ms / 3_600_000)}h`
}

// Listening pill — shows the local IPv4 + port that the OSC
// listener is bound to so the user knows EXACTLY what to point an
// incoming sender (OCTOCOSME, TouchOSC, etc.) at. Green dot bound,
// red dot bind error, grey dot off. Click toggles the listener,
// double-click opens the Capture popup. Lives in PoolPane (next
// to the Capture button) instead of the top toolbar so the top
// toolbar stays compact.
function ListeningPill({
  status,
  devicesCount,
  onToggle,
  onDoubleClick
}: {
  status: NetworkListenerStatus
  devicesCount: number
  onToggle: () => void
  onDoubleClick: () => void
}): JSX.Element {
  // Pick the first non-loopback IPv4 for display. Multiple NICs all
  // route to the same listener, but the user only needs to see ONE
  // address to configure their device.
  const ipDisplay =
    status.localAddresses.length > 0 ? status.localAddresses[0] : '127.0.0.1'
  const dotColor =
    status.lastError && !status.enabled
      ? 'rgb(var(--c-danger))'
      : status.enabled
        ? 'rgb(var(--c-success))'
        : 'rgb(var(--c-muted) / 0.5)'
  const tooltip = status.enabled
    ? `Listening — point your OSC sender (OCTOCOSME, TouchOSC, etc.) at ${ipDisplay}:${status.port}. Other local IPs: ${status.localAddresses.join(', ') || '(none detected)'}. Click to stop listening, double-click to open Capture.`
    : status.lastError
      ? `Listener failed to bind on port ${status.port}: ${status.lastError}. Most likely another app already owns this port — change the "Listen on" port in the top toolbar to one that's free, then configure your sender to match.`
      : 'Click to start listening for incoming OSC on the "Listen on" port (top toolbar).'
  // Single-click toggles the listener; double-click opens Capture.
  // A raw onClick + onDoubleClick pair fires the click handler TWICE
  // before the dblclick lands — the listener socket would bounce
  // off/on (churn) right before Capture opened. Standard fix: delay
  // the single-click action past the double-click window and cancel
  // it when a dblclick arrives.
  const clickTimer = useRef<number | null>(null)
  useEffect(
    () => () => {
      if (clickTimer.current !== null) window.clearTimeout(clickTimer.current)
    },
    []
  )
  return (
    <button
      className="flex items-center gap-1 px-1.5 py-0 rounded border border-border bg-panel2 hover:bg-panel3 text-[9px] leading-tight shrink-0 whitespace-nowrap"
      onClick={() => {
        if (clickTimer.current !== null) window.clearTimeout(clickTimer.current)
        clickTimer.current = window.setTimeout(() => {
          clickTimer.current = null
          onToggle()
        }, 250)
      }}
      onDoubleClick={() => {
        if (clickTimer.current !== null) {
          window.clearTimeout(clickTimer.current)
          clickTimer.current = null
        }
        onDoubleClick()
      }}
      title={tooltip}
    >
      <span
        className="inline-block w-1.5 h-1.5 rounded-full shrink-0"
        style={{ background: dotColor }}
      />
      <span className="text-muted">Listening</span>
      <span className="font-mono text-text tabular-nums">
        {ipDisplay}:{status.port}
      </span>
      {devicesCount > 0 && status.enabled && (
        <span
          className="text-accent text-[9px] font-semibold"
          title={`${devicesCount} sender${devicesCount === 1 ? '' : 's'} discovered. Double-click to open Capture.`}
        >
          {devicesCount}D
        </span>
      )}
    </button>
  )
}

// Pool transport pill — small badge next to every row labelling
// what the entry sends: OSC, MIDI, or both. Same palette as the
// CellTile transport badge (slate / violet / teal) so the user
// builds a consistent mental colour-map. Hidden when neither
// transport is configured (rare; usually means a stub blueprint).
function TransportPill({
  oscOn,
  midiOn
}: {
  oscOn: boolean
  midiOn: boolean
}): JSX.Element | null {
  if (!oscOn && !midiOn) return null
  const label = oscOn && midiOn ? 'OSC/MIDI' : oscOn ? 'OSC' : 'MIDI'
  const bg =
    oscOn && midiOn
      ? 'rgb(80 200 180 / 0.18)'
      : midiOn
        ? 'rgb(170 110 220 / 0.18)'
        : 'rgb(150 165 185 / 0.18)'
  const fg =
    oscOn && midiOn
      ? 'rgb(120 220 200)'
      : midiOn
        ? 'rgb(195 150 240)'
        : 'rgb(175 185 200)'
  return (
    <span
      className="text-[8px] font-mono font-semibold px-1 py-px rounded leading-none shrink-0"
      style={{ background: bg, color: fg, letterSpacing: '0.04em' }}
      title={`Transport: ${label}`}
    >
      {label}
    </span>
  )
}

// ─────────────────────────────────────────────────────────────────
// Scenes tab — lists every entry in the global saved-scene library.
// Empty state nudges the user toward the Capture button + the
// right-click "Save to Pool" path. Each row is draggable onto the
// Scenes palette / a sequence slot; double-click instantiates
// in-place.
// ─────────────────────────────────────────────────────────────────

function ScenesTab({
  scenes,
  onInstantiate,
  onRemove
}: {
  scenes: import('@shared/types').SavedScene[]
  onInstantiate: (id: string) => void
  onRemove: (id: string, name: string) => void
}): JSX.Element {
  const selectedIds = useStore((s) => s.selectedSavedSceneIds)
  const selectSavedScene = useStore((s) => s.selectSavedScene)
  const toggleSavedSceneSelection = useStore((s) => s.toggleSavedSceneSelection)
  // Row highlight: a row is "selected" when it's in the multi-set.
  // Single-click resets the set to that one id; Ctrl/Meta-click
  // toggles. Del key (handled in App.tsx) reads the same list.
  const selectedSet = new Set(selectedIds)
  if (scenes.length === 0) {
    return (
      <div className="p-3 text-muted text-[11px] leading-snug">
        No saved scenes yet. Click <span className="label">● Capture</span> in
        the header (or right-click a Scene in the palette → Save to Pool) to
        add one. Saved scenes live in a global library that persists across
        sessions.
      </div>
    )
  }
  return (
    <>
      <div className="px-2 pt-1 pb-0.5 text-[9px] uppercase tracking-wide text-muted">
        Saved Scenes
      </div>
      {scenes.map((s) => (
        <SavedSceneRow
          key={s.id}
          scene={s}
          selected={selectedSet.has(s.id)}
          onSelect={() => selectSavedScene(s.id)}
          onToggleSelect={() => toggleSavedSceneSelection(s.id)}
          onInstantiate={() => onInstantiate(s.id)}
          onRemove={() => onRemove(s.id, s.name)}
        />
      ))}
    </>
  )
}

function SavedSceneRow({
  scene,
  selected,
  onSelect,
  onToggleSelect,
  onInstantiate,
  onRemove
}: {
  scene: import('@shared/types').SavedScene
  selected: boolean
  onSelect: () => void
  // Called when the user holds Ctrl/Meta to extend the multi-selection.
  onToggleSelect: () => void
  onInstantiate: () => void
  onRemove: () => void
}): JSX.Element {
  // Right-click context menu — Rename + Update from Grid.
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null)
  // Inline-rename state. When non-null, the name span swaps for a
  // text input prefilled with this draft. Enter / blur commits; Esc
  // discards.
  const [renaming, setRenaming] = useState<string | null>(null)
  const updateSavedScene = useStore((s) => s.updateSavedScene)
  const updateSavedSceneFromGrid = useStore((s) => s.updateSavedSceneFromGrid)
  // Live grid scene linked to this SavedScene — drives whether
  // "Update and save" is enabled or greyed out.
  const linkedGridScene = useStore((s) =>
    s.session.scenes.find((sc) => sc.linkedSavedSceneId === scene.id)
  )
  useEffect(() => {
    if (!menu) return
    const close = (): void => setMenu(null)
    const onEsc = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setMenu(null)
    }
    window.addEventListener('mousedown', close)
    window.addEventListener('keydown', onEsc)
    return () => {
      window.removeEventListener('mousedown', close)
      window.removeEventListener('keydown', onEsc)
    }
  }, [menu])
  function commitRename(): void {
    if (renaming === null) return
    const trimmed = renaming.trim()
    if (trimmed && trimmed !== scene.name) {
      void updateSavedScene(scene.id, { name: trimmed })
    }
    setRenaming(null)
  }
  function onDragStart(e: React.DragEvent): void {
    const payload: PoolSavedSceneDragPayload = { savedSceneId: scene.id }
    e.dataTransfer.setData(POOL_SAVED_SCENE_DRAG_MIME, JSON.stringify(payload))
    e.dataTransfer.effectAllowed = 'copy'
  }
  const trackCount = scene.tracks.filter((t) => t.kind === 'function').length
  const ageMs = Date.now() - (scene.createdAt ?? 0)
  return (
    <div
      draggable
      onDragStart={onDragStart}
      onContextMenu={(e) => {
        e.preventDefault()
        e.stopPropagation()
        setMenu({ x: e.clientX, y: e.clientY })
      }}
      onClick={(e) => {
        if (e.ctrlKey || e.metaKey) onToggleSelect()
        else onSelect()
        // Clicking a draggable element in Chromium leaves a sticky
        // pseudo-focus on the row, which then swallows the next
        // click on the SavedSceneInspector's Name / Notes inputs
        // until the user alt-tabs. rAF blur + body focus releases
        // it so the inspector inputs accept clicks immediately.
        requestAnimationFrame(() => {
          if (document.activeElement instanceof HTMLElement) {
            document.activeElement.blur()
          }
          document.body.focus?.()
        })
      }}
      onDoubleClick={onInstantiate}
      className={`relative flex items-center gap-1 px-1 py-[1px] cursor-grab text-[12px] leading-tight ${
        selected ? 'bg-accent/20' : 'hover:bg-panel2/60'
      }`}
      style={{ borderLeft: `3px solid ${scene.color}` }}
      title="Click to inspect · Ctrl/⌘-click to add to a multi-selection (Del deletes the set) · Drag onto the grid · Double-click to instantiate."
    >
      <span className="w-5 shrink-0" />
      {renaming !== null ? (
        <input
          autoFocus
          className="input text-[12px] py-0 px-1 font-semibold min-w-0 flex-1"
          value={renaming}
          onChange={(e) => setRenaming(e.target.value)}
          onClick={(e) => e.stopPropagation()}
          onMouseDown={(e) => e.stopPropagation()}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              commitRename()
            } else if (e.key === 'Escape') {
              setRenaming(null)
            }
          }}
          onBlur={commitRename}
        />
      ) : (
        <span className="font-semibold truncate">{scene.name}</span>
      )}
      {scene.origin && scene.origin !== 'manual' && (
        <span
          className="text-[9px] text-muted shrink-0 px-1 rounded-sm border border-border"
          title={`Origin: ${scene.origin}`}
        >
          {scene.origin === 'capture-osc'
            ? 'OSC'
            : scene.origin === 'capture-midi'
              ? 'MIDI'
              : 'copy'}
        </span>
      )}
      <span className="text-muted text-[10px] shrink-0">
        {trackCount} param · {Object.keys(scene.cells).length} cell
      </span>
      <div className="flex-1" />
      <span className="text-muted text-[9px] shrink-0">{formatAge(ageMs)}</span>
      <button
        className="btn text-[10px] py-0 px-1.5 leading-tight shrink-0"
        onClick={(e) => {
          e.stopPropagation()
          onInstantiate()
        }}
        title="Instantiate this scene at the end of the scenes list"
      >
        Use
      </button>
      <button
        className="btn text-[10px] py-0 px-1.5 leading-tight shrink-0"
        onClick={(e) => {
          e.stopPropagation()
          onRemove()
        }}
        title="Delete this saved scene from the library"
        style={{ borderColor: 'rgb(var(--c-danger))', color: 'rgb(var(--c-danger))' }}
      >
        ✕
      </button>
      {menu &&
        createPortal(
          <div
            className="fixed z-50 bg-panel border border-border rounded shadow-lg py-1 text-[12px] min-w-[200px]"
            style={{ left: menu.x, top: menu.y }}
            onMouseDown={(e) => e.stopPropagation()}
          >
            {/* Rename — swaps the name span into an inline input. */}
            <button
              className="w-full text-left px-3 py-1 hover:bg-panel2"
              onClick={() => {
                setMenu(null)
                setRenaming(scene.name)
              }}
            >
              Rename
            </button>
            {/* Update and save — overwrites THIS SavedScene's full
                payload from the linked grid scene's current state.
                Greyed out when no grid scene is linked. */}
            <button
              className={`w-full text-left px-3 py-1 ${
                linkedGridScene ? 'hover:bg-panel2' : 'opacity-40 cursor-not-allowed'
              }`}
              disabled={!linkedGridScene}
              onClick={() => {
                setMenu(null)
                if (linkedGridScene) {
                  void updateSavedSceneFromGrid(scene.id)
                }
              }}
              title={
                linkedGridScene
                  ? `Overwrite this Saved Scene with the latest state of "${linkedGridScene.name}" from the grid.`
                  : 'No live grid scene is linked to this Saved Scene. Drag this Saved Scene onto the grid first to establish the link.'
              }
            >
              Update and save
            </button>
          </div>,
          document.body
        )}
    </div>
  )
}
