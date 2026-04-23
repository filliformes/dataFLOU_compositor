import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { useStore } from '../store'
import { useHeaderHeight } from './EditView'
import { ResizeHandle } from './ResizeHandle'
import { UncontrolledTextInput } from './UncontrolledInput'

export default function TrackSidebar(): JSX.Element {
  const tracks = useStore((s) => s.session.tracks)
  const scenes = useStore((s) => s.session.scenes)
  const addTrack = useStore((s) => s.addTrack)
  const addScene = useStore((s) => s.addScene)
  const removeTracks = useStore((s) => s.removeTracks)
  const renameTrack = useStore((s) => s.renameTrack)
  const selectedTrackIds = useStore((s) => s.selectedTrackIds)
  const selectTrack = useStore((s) => s.selectTrack)
  const selectTrackRange = useStore((s) => s.selectTrackRange)
  const rowHeight = useStore((s) => s.rowHeight)
  const setRowHeight = useStore((s) => s.setRowHeight)
  const notesHeight = useStore((s) => s.editorNotesHeight)
  const setNotesHeight = useStore((s) => s.setEditorNotesHeight)
  const tracksCollapsedRaw = useStore((s) => s.tracksCollapsed)
  const scenesCollapsedRaw = useStore((s) => s.scenesCollapsed)
  const showMode = useStore((s) => s.showMode)
  // Show mode forces the compact layout even when the user had the bar
  // expanded pre-entry — performers see more rows/scenes at once and the
  // sprawling +Scene / +Message row is hidden anyway.
  const tracksCollapsed = tracksCollapsedRaw || showMode
  const scenesCollapsed = scenesCollapsedRaw || showMode
  const headerH = useHeaderHeight()

  // Right-click context menu — a single instance shared across all rows.
  // `targets` is the list of tracks the menu acts on (clicked track + any
  // other selected tracks if the clicked one is part of the selection).
  const [menu, setMenu] = useState<{ x: number; y: number; targets: string[] } | null>(
    null
  )
  useEffect(() => {
    if (!menu) return
    const close = (): void => setMenu(null)
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setMenu(null)
    }
    window.addEventListener('mousedown', close)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', close)
      window.removeEventListener('keydown', onKey)
    }
  }, [menu])

  const msgFull = tracks.length >= 128
  const sceneFull = scenes.length >= 128
  // Notes + Meta Controller toggles moved to the Inspector's top panel
  // (EditView's SettingsBox) — this box stays focused on scene/message
  // creation + counts, leaving display toggles grouped together on the right.

  return (
    <div className="bg-panel border-r border-border flex flex-col h-full">
      {/* Header — same height as scene column headers. Notes-resize handle is
          absolute-positioned at the bottom, inside the header, so it does NOT
          add to the total height (which would break alignment with cells).

          Two rows: Messages (N/128) [+] and Scenes (N/128) [+]. When scenes
          are collapsed the header shrinks to 32px, so we swap in a compact
          single-line layout that still surfaces both counts and both add
          buttons. */}
      <div
        className="relative border-b border-border px-2 py-2"
        style={{ height: headerH }}
      >
        {scenesCollapsed ? (
          <div className="flex items-center justify-between gap-1 h-full">
            <span className="label truncate text-[10px]">
              S {scenes.length} · M {tracks.length}
            </span>
            <div className="flex items-center gap-1">
              <button
                data-hide-in-show="true"
                className="btn"
                disabled={sceneFull}
                onClick={addScene}
                title={sceneFull ? 'Max 128 scenes' : 'Add scene'}
              >
                +S
              </button>
              <button
                data-hide-in-show="true"
                className="btn"
                disabled={msgFull}
                onClick={addTrack}
                title={msgFull ? 'Max 128 messages' : 'Add message'}
              >
                +M
              </button>
            </div>
          </div>
        ) : (
          <div className="flex flex-col justify-center gap-1.5 h-full">
            {/* Row 1 — Scenes counter + Add scene. */}
            <div className="flex items-center justify-between gap-2">
              <span className="label truncate">Scenes ({scenes.length}/128)</span>
              <button
                data-hide-in-show="true"
                className="btn shrink-0"
                disabled={sceneFull}
                onClick={addScene}
                title={sceneFull ? 'Max 128 scenes' : 'Add scene'}
              >
                + Scene
              </button>
            </div>
            {/* Row 2 — Messages counter + Add message. */}
            <div className="flex items-center justify-between gap-2">
              <span className="label truncate">Messages ({tracks.length}/128)</span>
              <button
                data-hide-in-show="true"
                className="btn shrink-0"
                disabled={msgFull}
                onClick={addTrack}
                title={msgFull ? 'Max 128 messages' : 'Add message'}
              >
                + Message
              </button>
            </div>
          </div>
        )}
        <ResizeHandle
          direction="row"
          value={notesHeight}
          onChange={setNotesHeight}
          min={0}
          max={220}
          className="absolute bottom-0 left-0 right-0 h-[4px]"
          title="Drag to resize scene notes"
        />
      </div>

      {tracks.map((t) => {
        const isSelected = selectedTrackIds.includes(t.id)
        const effectiveRowH = tracksCollapsed ? 32 : rowHeight
        return (
          <div
            key={t.id}
            className={`relative border-b border-border flex shrink-0 cursor-pointer overflow-hidden ${
              tracksCollapsed ? 'flex-row items-center px-2 gap-2' : 'flex-col justify-center gap-1 px-3'
            } ${isSelected ? 'bg-panel2' : 'hover:bg-panel3/30'}`}
            style={{ height: effectiveRowH }}
            onClick={(e) => {
              // Shift-click = extend selection from anchor to this row.
              // Plain click = single-select (and set new anchor).
              if (e.shiftKey) selectTrackRange(t.id)
              else selectTrack(t.id)
            }}
            onContextMenu={(e) => {
              // Don't override native right-click on editable text.
              const tag = (e.target as HTMLElement | null)?.tagName
              if (tag === 'INPUT' || tag === 'TEXTAREA') return
              e.preventDefault()
              // If this track is already in the selection, the menu targets
              // the whole selection (bulk delete). Otherwise it targets just
              // this row and makes it the new single-selection.
              const inSel = selectedTrackIds.includes(t.id)
              const targets = inSel && selectedTrackIds.length > 1 ? selectedTrackIds : [t.id]
              if (!inSel) selectTrack(t.id)
              setMenu({ x: e.clientX, y: e.clientY, targets })
            }}
          >
            <UncontrolledTextInput
              className={`input ${tracksCollapsed ? 'text-[11px] py-0.5 flex-1' : 'text-[12px] font-medium'}`}
              value={t.name}
              onClick={(e) => e.stopPropagation()}
              onMouseDown={(e) => e.stopPropagation()}
              onChange={(v) => renameTrack(t.id, v)}
              placeholder="Message name"
            />
            {/* Inline Del button removed — use right-click to delete
                (single or multi-select via shift-click). */}

            {!tracksCollapsed && (
              <ResizeHandle
                direction="row"
                value={rowHeight}
                onChange={setRowHeight}
                min={60}
                max={220}
                className="absolute bottom-0 left-0 right-0 h-[4px]"
                title="Drag to resize all message rows"
              />
            )}
          </div>
        )
      })}

      {/* Right-click menu. Portaled to body so it isn't clipped by any
          overflow boundary on the sidebar. Closes on click-outside /
          Escape (see useEffect above). */}
      {menu &&
        createPortal(
          <div
            className="fixed z-50 bg-panel border border-border rounded shadow-lg py-1 text-[12px] min-w-[160px]"
            style={{ left: menu.x, top: menu.y }}
            onMouseDown={(e) => e.stopPropagation()}
          >
            <button
              className="w-full text-left px-3 py-1 hover:bg-panel2 text-danger"
              onClick={() => {
                const ids = menu.targets
                setMenu(null)
                const n = ids.length
                if (n === 0) return
                const label =
                  n === 1
                    ? `Delete message "${tracks.find((t) => t.id === ids[0])?.name ?? ''}"?`
                    : `Delete ${n} messages?`
                if (confirm(label)) removeTracks(ids)
              }}
            >
              {menu.targets.length > 1
                ? `Delete ${menu.targets.length} messages`
                : 'Delete message'}
            </button>
          </div>,
          document.body
        )}
    </div>
  )
}

