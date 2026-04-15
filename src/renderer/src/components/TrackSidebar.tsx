import { useStore } from '../store'
import { useHeaderHeight } from './EditView'
import { ResizeHandle } from './ResizeHandle'
import { UncontrolledTextInput } from './UncontrolledInput'

export default function TrackSidebar(): JSX.Element {
  const tracks = useStore((s) => s.session.tracks)
  const addTrack = useStore((s) => s.addTrack)
  const removeTrack = useStore((s) => s.removeTrack)
  const renameTrack = useStore((s) => s.renameTrack)
  const selectedTrack = useStore((s) => s.selectedTrack)
  const selectTrack = useStore((s) => s.selectTrack)
  const rowHeight = useStore((s) => s.rowHeight)
  const setRowHeight = useStore((s) => s.setRowHeight)
  const notesHeight = useStore((s) => s.editorNotesHeight)
  const setNotesHeight = useStore((s) => s.setEditorNotesHeight)
  const tracksCollapsed = useStore((s) => s.tracksCollapsed)
  const headerH = useHeaderHeight()

  return (
    <div className="bg-panel border-r border-border flex flex-col h-full">
      {/* Header — same height as scene column headers. Notes-resize handle is
          absolute-positioned at the bottom, inside the header, so it does NOT
          add to the total height (which would break alignment with cells). */}
      <div
        className="relative border-b border-border flex items-center justify-between px-3 gap-2"
        style={{ height: headerH }}
      >
        <span className="label">Messages ({tracks.length}/128)</span>
        <button className="btn" disabled={tracks.length >= 128} onClick={addTrack}>
          +
        </button>
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
        const isSelected = selectedTrack === t.id
        const effectiveRowH = tracksCollapsed ? 32 : rowHeight
        return (
          <div
            key={t.id}
            className={`relative border-b border-border flex shrink-0 cursor-pointer overflow-hidden ${
              tracksCollapsed ? 'flex-row items-center px-2 gap-2' : 'flex-col justify-center gap-1 px-3'
            } ${isSelected ? 'bg-panel2' : 'hover:bg-panel3/30'}`}
            style={{ height: effectiveRowH }}
            onClick={() => selectTrack(t.id)}
          >
            <UncontrolledTextInput
              className={`input ${tracksCollapsed ? 'text-[11px] py-0.5 flex-1' : 'text-[12px] font-medium'}`}
              value={t.name}
              onClick={(e) => e.stopPropagation()}
              onMouseDown={(e) => e.stopPropagation()}
              onChange={(v) => renameTrack(t.id, v)}
              placeholder="Message name"
            />
            {!tracksCollapsed && (
              <div className="flex items-center gap-1">
                <div className="flex-1" />
                <button
                  className="btn text-[10px] px-1.5 py-0.5 text-danger hover:bg-danger hover:text-black"
                  onClick={(e) => {
                    e.stopPropagation()
                    if (confirm(`Delete message "${t.name}"?`)) removeTrack(t.id)
                  }}
                >
                  Del
                </button>
              </div>
            )}

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
    </div>
  )
}

