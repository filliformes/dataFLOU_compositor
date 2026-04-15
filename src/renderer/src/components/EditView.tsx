import { useEffect, useRef, useState } from 'react'
import { useStore } from '../store'
import TrackSidebar from './TrackSidebar'
import SceneColumn from './SceneColumn'
import Inspector from './Inspector'
import { ResizeHandle } from './ResizeHandle'
import { Modal } from './Modal'

export const HEADER_BASE = 88
export const HEADER_COLLAPSED = 32

export function useHeaderHeight(): number {
  const notesH = useStore((s) => s.editorNotesHeight)
  const collapsed = useStore((s) => s.scenesCollapsed)
  return collapsed ? HEADER_COLLAPSED : HEADER_BASE + notesH
}

export function useEffectiveRowHeight(): number {
  const rowH = useStore((s) => s.rowHeight)
  const collapsed = useStore((s) => s.tracksCollapsed)
  return collapsed ? 32 : rowH
}

export default function EditView(): JSX.Element {
  const scenes = useStore((s) => s.session.scenes)
  const addScene = useStore((s) => s.addScene)
  const selectedCell = useStore((s) => s.selectedCell)
  const selectedTrack = useStore((s) => s.selectedTrack)
  const tracks = useStore((s) => s.session.tracks)
  const rowHeight = useEffectiveRowHeight()
  const trackColumnWidth = useStore((s) => s.trackColumnWidth)
  const setTrackColumnWidth = useStore((s) => s.setTrackColumnWidth)
  const inspectorWidth = useStore((s) => s.inspectorWidth)
  const setInspectorWidth = useStore((s) => s.setInspectorWidth)
  const headerH = useHeaderHeight()

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

          <div className="flex items-start p-2">
            <button
              className="btn h-9 whitespace-nowrap"
              onClick={addScene}
              disabled={scenes.length >= 128}
              title={scenes.length >= 128 ? 'Max 128 scenes' : 'Add scene'}
            >
              + Scene
            </button>
          </div>
        </div>
      </div>

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
          {selectedCell ? (
            <Inspector mode="cell" />
          ) : selectedTrack ? (
            <Inspector mode="track" />
          ) : (
            <InspectorEmpty />
          )}
        </div>
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
      <div className="flex items-center gap-1">
        <button
          className={`btn text-[10px] py-0.5 flex-1 ${
            scenesCollapsed ? 'bg-accent/20 border-accent text-accent' : ''
          }`}
          onClick={() => setScenesCollapsed(!scenesCollapsed)}
          title="Toggle compact scene headers"
        >
          {scenesCollapsed ? '⇲ Scenes' : '⇱ Collapse Scenes'}
        </button>
        <button
          className={`btn text-[10px] py-0.5 flex-1 ${
            tracksCollapsed ? 'bg-accent/20 border-accent text-accent' : ''
          }`}
          onClick={() => setTracksCollapsed(!tracksCollapsed)}
          title="Toggle compact message rows"
        >
          {tracksCollapsed ? '⇲ Messages' : '⇱ Collapse Messages'}
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
