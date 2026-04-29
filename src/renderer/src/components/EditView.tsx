import { useEffect, useRef, useState } from 'react'
import { NOTES_ONE_LINE_HEIGHT, useStore } from '../store'
import TrackSidebar from './TrackSidebar'
import SceneColumn from './SceneColumn'
import Inspector from './Inspector'
import InstrumentsInspectorPane from './InstrumentsInspectorPane'
import { ResizeHandle } from './ResizeHandle'
import { Modal } from './Modal'

// Header height in the Edit view.
// The TrackSidebar's "Buttons box" now holds only two rows (Scenes, Messages) —
// the display toggles (Notes, Meta Controller) moved to the Inspector's top
// SettingsBox. 80 px leaves each row ~24 px tall with py-2 container padding
// and comfortable breathing room so no button sits flush against the edge.
// Scene column headers use the same base so the top-of-matrix alignment stays
// pixel-perfect.
export const HEADER_BASE = 80
export const HEADER_COLLAPSED = 32

export function useHeaderHeight(): number {
  const notesH = useStore((s) => s.editorNotesHeight)
  const collapsed = useStore((s) => s.scenesCollapsed)
  const showMode = useStore((s) => s.showMode)
  // Show mode forces the tightest layout so performers see more scenes /
  // tracks on screen at once without editing chrome getting in the way.
  if (showMode) return HEADER_COLLAPSED
  return collapsed ? HEADER_COLLAPSED : HEADER_BASE + notesH
}

// Minimum column width (px) when scenes are collapsed. The column uses
// `fit-content` sizing, so its effective width depends on the widest piece
// of its content (header with play button + name, or a filled clip's
// contents). This just guarantees a floor so extremely short names still
// show a legible play button + room to click in.
export const SCENE_COL_COLLAPSED_MIN_W = 56

export function useEffectiveRowHeight(): number {
  const rowH = useStore((s) => s.rowHeight)
  const collapsed = useStore((s) => s.tracksCollapsed)
  const showMode = useStore((s) => s.showMode)
  if (showMode) return 32
  return collapsed ? 32 : rowH
}

export default function EditView(): JSX.Element {
  const scenes = useStore((s) => s.session.scenes)
  const selectedCell = useStore((s) => s.selectedCell)
  const selectedTrack = useStore((s) => s.selectedTrack)
  // Pool selection (an item picked in the Pool drawer) takes priority
  // over cell / track selection because it's the most-recent-action and
  // because clicking a Pool item explicitly clears the others (see
  // setPoolSelection in store.ts). The right-side Inspector's switch
  // therefore reads: poolSelection > selectedCell > selectedTrack.
  const poolSelection = useStore((s) => s.poolSelection)
  const tracks = useStore((s) => s.session.tracks)
  const rowHeight = useEffectiveRowHeight()
  const trackColumnWidth = useStore((s) => s.trackColumnWidth)
  const setTrackColumnWidth = useStore((s) => s.setTrackColumnWidth)
  const inspectorWidth = useStore((s) => s.inspectorWidth)
  const setInspectorWidth = useStore((s) => s.setInspectorWidth)
  const headerH = useHeaderHeight()
  // Show mode strips the Inspector + SettingsBox entirely so the scene
  // grid gets the full width for triggers. Edit chrome (delete, edit
  // parameters) is not a performance affordance.
  const showMode = useStore((s) => s.showMode)

  const gridHeight = headerH + tracks.length * rowHeight

  return (
    <div className="flex h-full min-h-0">
      <div className="flex-1 min-w-0 overflow-auto bg-bg">
        <div
          className="flex items-stretch"
          style={{ minHeight: gridHeight, width: 'max-content' }}
        >
          <div
            className="sticky left-0 z-20 shrink-0 relative"
            style={{ width: trackColumnWidth }}
          >
            <TrackSidebar />
            <ResizeHandle
              direction="col"
              value={trackColumnWidth}
              onChange={setTrackColumnWidth}
              min={160}
              max={400}
              className="absolute top-0 right-0 bottom-0 w-[4px] z-30"
              title="Drag to resize messages column"
            />
          </div>

          {scenes.map((sc) => (
            <SceneColumn key={sc.id} sceneId={sc.id} />
          ))}
          {/* Trailing "+ Scene" button removed — the one in the Buttons box
              (TrackSidebar header) is the single entry point now. */}
        </div>
      </div>

      {!showMode && (
        <EditInspector
          inspectorWidth={inspectorWidth}
          setInspectorWidth={setInspectorWidth}
          poolSelection={poolSelection}
          selectedCell={selectedCell}
          selectedTrack={selectedTrack}
        />
      )}
    </div>
  )
}

// Right-side Inspector panel for the Edit view. Wraps the existing
// inner pieces (SettingsBox + Inspector / InstrumentsInspectorPane /
// Empty) in a visibility gate so the I keyboard shortcut can hide
// the whole panel without touching the grid layout.
function EditInspector({
  inspectorWidth,
  setInspectorWidth,
  poolSelection,
  selectedCell,
  selectedTrack
}: {
  inspectorWidth: number
  setInspectorWidth: (w: number) => void
  poolSelection: ReturnType<typeof useStore.getState>['poolSelection']
  selectedCell: ReturnType<typeof useStore.getState>['selectedCell']
  selectedTrack: ReturnType<typeof useStore.getState>['selectedTrack']
}): JSX.Element | null {
  const visible = useStore((s) => s.editInspectorVisible)
  if (!visible) return null
  return (
    <div
      className="relative bg-panel border-l border-border shrink-0 flex flex-col"
      style={{ width: inspectorWidth }}
    >
      <ResizeHandle
        direction="col"
        value={inspectorWidth}
        onChange={setInspectorWidth}
        min={320}
        max={640}
        inverse
        className="absolute top-0 left-0 bottom-0 w-[4px] z-30"
        title="Drag to resize inspector"
      />
      <SettingsBox />
      <div className="flex-1 min-h-0 overflow-y-auto">
        {poolSelection ? (
          <InstrumentsInspectorPane />
        ) : selectedCell ? (
          <Inspector mode="cell" />
        ) : selectedTrack ? (
          <Inspector mode="track" />
        ) : (
          <InspectorEmpty />
        )}
      </div>
    </div>
  )
}

function InspectorEmpty(): JSX.Element {
  return (
    <div className="p-4 text-muted text-[12px]">
      Select a clip or a message to edit its parameters.
    </div>
  )
}

// Compact strip at the very top of the right-side panel — Collapse toggles
// + Clip Template dropdown (only when a cell is selected).
function SettingsBox(): JSX.Element {
  const scenesCollapsed = useStore((s) => s.scenesCollapsed)
  const setScenesCollapsed = useStore((s) => s.setScenesCollapsed)
  const tracksCollapsed = useStore((s) => s.tracksCollapsed)
  const setTracksCollapsed = useStore((s) => s.setTracksCollapsed)
  const selectedCell = useStore((s) => s.selectedCell)
  const templates = useStore((s) => s.clipTemplates)
  const applyClipTemplate = useStore((s) => s.applyClipTemplate)
  const saveClipAsTemplate = useStore((s) => s.saveClipAsTemplate)
  const deleteClipTemplate = useStore((s) => s.deleteClipTemplate)
  // Notes + Meta Controller toggles live here (top of the Inspector) rather
  // than in the TrackSidebar header — keeps the "Buttons box" focused on
  // scene/message creation + count, and gathers display toggles in one spot.
  const notesHeight = useStore((s) => s.editorNotesHeight)
  const setNotesHeight = useStore((s) => s.setEditorNotesHeight)
  const notesOn = notesHeight > 0
  const toggleNotes = (): void => setNotesHeight(notesOn ? 0 : NOTES_ONE_LINE_HEIGHT)
  const metaVisible = useStore((s) => s.session.metaController.visible)
  const setMetaVisible = useStore((s) => s.setMetaControllerVisible)

  const [namingOpen, setNamingOpen] = useState(false)

  function onSaveTemplate(): void {
    if (!selectedCell) return
    setNamingOpen(true)
  }

  function commitTemplate(name: string): void {
    if (!selectedCell) return
    const trimmed = name.trim()
    if (!trimmed) return
    saveClipAsTemplate(selectedCell.sceneId, selectedCell.trackId, trimmed)
    setNamingOpen(false)
  }

  return (
    <>
    <div className="border-b border-border bg-panel2 px-3 py-2 flex flex-col gap-1.5 shrink-0">
      {/* Row 1 — display toggles that affect the whole editor (global).
          Notes = show/hide scene-notes strip (one line by default); Meta
          Controller = show/hide the knob bank. Both sit above the collapse
          toggles because they're the broader-impact controls. */}
      <div className="flex items-center gap-1">
        <button
          className={`btn text-[10px] py-0.5 flex-1 ${
            notesOn ? 'bg-accent text-black border-accent' : ''
          }`}
          onClick={toggleNotes}
          title={notesOn ? 'Hide scene notes' : 'Show scene notes (one line)'}
        >
          Notes
        </button>
        <button
          // Meta Controller keeps an orange border at all times so it's
          // discoverable as the toggle; when active it fills fully orange
          // with black text. Border/background/color go inline because the
          // `.btn` class uses `border:` shorthand, which overrides Tailwind
          // `border-accent` via CSS source order.
          className="btn text-[10px] py-0.5 flex-1"
          style={{
            borderColor: 'rgb(var(--c-accent))',
            background: metaVisible ? 'rgb(var(--c-accent))' : undefined,
            color: metaVisible ? '#000' : 'rgb(var(--c-accent))'
          }}
          onClick={() => setMetaVisible(!metaVisible)}
          title="Toggle the Meta Controller bank"
        >
          Meta Controller
        </button>
      </div>
      <div className="flex items-center gap-1">
        {/* Left-click toggles each axis independently. Right-click on
            either button toggles BOTH in lockstep — handy for the common
            "go fully compact / fully expanded" case. The new linked state
            is derived from whichever axis was clicked, so right-clicking
            an inactive button turns both ON, an active button turns both
            OFF. */}
        <button
          className={`btn text-[10px] py-0.5 flex-1 ${
            scenesCollapsed ? 'bg-accent/20 border-accent text-accent' : ''
          }`}
          onClick={() => setScenesCollapsed(!scenesCollapsed)}
          onContextMenu={(e) => {
            e.preventDefault()
            const next = !scenesCollapsed
            setScenesCollapsed(next)
            setTracksCollapsed(next)
          }}
          title="Click: toggle scenes only · Right-click: toggle both scenes + instruments"
        >
          {scenesCollapsed ? '⇲ Scenes' : '⇱ Collapse Scenes'}
        </button>
        <button
          className={`btn text-[10px] py-0.5 flex-1 ${
            tracksCollapsed ? 'bg-accent/20 border-accent text-accent' : ''
          }`}
          onClick={() => setTracksCollapsed(!tracksCollapsed)}
          onContextMenu={(e) => {
            e.preventDefault()
            const next = !tracksCollapsed
            setScenesCollapsed(next)
            setTracksCollapsed(next)
          }}
          title="Click: toggle instruments only · Right-click: toggle both scenes + instruments"
        >
          {tracksCollapsed ? '⇲ Instruments' : '⇱ Collapse Instruments'}
        </button>
      </div>

      {selectedCell && (
        <div className="flex items-center gap-1">
          <span className="label shrink-0">Template</span>
          <select
            className="input text-[11px] py-0.5 flex-1 min-w-0"
            value=""
            onChange={(e) => {
              const id = e.target.value
              if (!id) return
              if (id.startsWith('__del:')) {
                const realId = id.slice(6)
                const t = templates.find((tt) => tt.id === realId)
                if (t && confirm(`Delete template "${t.name}"?`)) deleteClipTemplate(realId)
              } else {
                applyClipTemplate(selectedCell.sceneId, selectedCell.trackId, id)
              }
              ;(e.target as HTMLSelectElement).value = ''
            }}
          >
            <option value="">Empty</option>
            {templates.length > 0 && (
              <optgroup label="Apply">
                {templates.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                  </option>
                ))}
              </optgroup>
            )}
            {templates.length > 0 && (
              <optgroup label="Delete">
                {templates.map((t) => (
                  <option key={'del-' + t.id} value={'__del:' + t.id}>
                    ✕ {t.name}
                  </option>
                ))}
              </optgroup>
            )}
          </select>
          <button
            className="btn text-[10px] py-0.5 px-2 shrink-0"
            onClick={onSaveTemplate}
            title="Save the current clip as a new template"
          >
            Save
          </button>
        </div>
      )}
    </div>
    {namingOpen && (
      <SaveTemplateModal
        onCancel={() => setNamingOpen(false)}
        onSave={commitTemplate}
      />
    )}
    </>
  )
}

function SaveTemplateModal({
  onSave,
  onCancel
}: {
  onSave: (name: string) => void
  onCancel: () => void
}): JSX.Element {
  const [name, setName] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)
  // Focus the input on mount so the user can start typing immediately.
  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  function trySave(): void {
    if (name.trim()) onSave(name)
  }

  return (
    <Modal title="Save Clip Template" onClose={onCancel}>
      <form
        onSubmit={(e) => {
          e.preventDefault()
          trySave()
        }}
        className="flex flex-col gap-3"
      >
        <label className="flex flex-col gap-1">
          <span className="label">Template name</span>
          <input
            ref={inputRef}
            className="input"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Slow LFO bass"
            maxLength={80}
          />
        </label>
        <div className="flex items-center justify-end gap-2 mt-1">
          <button type="button" className="btn" onClick={onCancel}>
            Cancel
          </button>
          <button
            type="submit"
            className="btn-accent"
            disabled={name.trim() === ''}
          >
            Save
          </button>
        </div>
      </form>
    </Modal>
  )
}
