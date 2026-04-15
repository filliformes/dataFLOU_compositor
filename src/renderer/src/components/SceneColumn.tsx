import { useStore } from '../store'
import CellTile from './CellTile'
import { useEffectiveRowHeight, useHeaderHeight } from './EditView'
import { ResizeHandle } from './ResizeHandle'
import { UncontrolledTextarea, UncontrolledTextInput } from './UncontrolledInput'

export default function SceneColumn({ sceneId }: { sceneId: string }): JSX.Element {
  const scene = useStore((s) => s.session.scenes.find((sc) => sc.id === sceneId))
  const tracks = useStore((s) => s.session.tracks)
  const focusedSceneId = useStore((s) => s.session.focusedSceneId)
  const updateScene = useStore((s) => s.updateScene)
  const removeScene = useStore((s) => s.removeScene)
  const setFocusedScene = useStore((s) => s.setFocusedScene)
  const setSceneMidi = useStore((s) => s.setSceneMidi)
  const engineActiveScene = useStore((s) => s.engine.activeSceneId)
  const activeSceneStartedAt = useStore((s) => s.engine.activeSceneStartedAt)
  const midiLearnMode = useStore((s) => s.midiLearnMode)
  const midiLearnTarget = useStore((s) => s.midiLearnTarget)
  const setMidiLearnTarget = useStore((s) => s.setMidiLearnTarget)
  const notesHeight = useStore((s) => s.editorNotesHeight)
  const setNotesHeight = useStore((s) => s.setEditorNotesHeight)
  const rowHeight = useEffectiveRowHeight()
  const sceneColumnWidth = useStore((s) => s.sceneColumnWidth)
  const setSceneColumnWidth = useStore((s) => s.setSceneColumnWidth)
  const scenesCollapsed = useStore((s) => s.scenesCollapsed)
  const headerH = useHeaderHeight()


  // Defensive: during the render just after a delete, React may still call us
  // before the parent re-renders. Bail out cleanly.
  if (!scene) return <></>

  const isPlaying = engineActiveScene === sceneId
  const isFocused = focusedSceneId === sceneId

  async function trigger(): Promise<void> {
    // In MIDI Learn mode, clicking the trigger selects it as the learn target
    // instead of firing the scene. Binding happens on the next MIDI message.
    if (midiLearnMode) {
      setMidiLearnTarget({ kind: 'scene', id: sceneId })
      return
    }
    if (isPlaying) await window.api.stopScene(sceneId)
    else await window.api.triggerScene(sceneId)
  }

  const learnOverlayClass = !midiLearnMode
    ? ''
    : midiLearnTarget?.kind === 'scene' && midiLearnTarget.id === sceneId
      ? 'midi-learn-selected'
      : scene.midiTrigger
        ? 'midi-learn-green'
        : 'midi-learn-blue'

  // Column-wide tint using the scene color at low alpha.
  const tint = scene.color + '14'

  return (
    <div
      className={`shrink-0 border-r border-border flex flex-col relative ${
        isFocused ? 'ring-1 ring-inset ring-accent/30' : ''
      }`}
      style={{ width: sceneColumnWidth, background: tint }}
      onClick={() => setFocusedScene(sceneId)}
    >
      {/* 3px color strip on top — absolute so it doesn't affect layout height
          (which would misalign cells against the track sidebar rows). */}
      <div
        className="absolute top-0 left-0 right-0 h-[3px] z-10 pointer-events-none"
        style={{ background: scene.color }}
      />
      {/* Column-width resize handle on the right edge — global. */}
      <ResizeHandle
        direction="col"
        value={sceneColumnWidth}
        onChange={setSceneColumnWidth}
        min={180}
        max={480}
        className="absolute top-0 right-0 bottom-0 w-[4px] z-10"
        title="Drag to resize all scene columns"
      />

      {/* Scene header — full vs collapsed layouts */}
      {scenesCollapsed ? (
        <div
          className="relative border-b border-border px-2 flex items-center gap-1.5 shrink-0"
          style={{ height: headerH }}
        >
          <SceneTriggerButton
            isPlaying={isPlaying}
            durationSec={scene.durationSec}
            startedAt={isPlaying ? activeSceneStartedAt : null}
            overlayClass={learnOverlayClass}
            onClick={(e) => {
              e.stopPropagation()
              trigger()
            }}
          />
          <input
            className="input flex-1 text-[11px] font-semibold min-w-0 py-0.5"
            value={scene.name}
            onClick={(e) => e.stopPropagation()}
            onMouseDown={(e) => e.stopPropagation()}
            onChange={(e) => updateScene(sceneId, { name: e.target.value })}
          />
        </div>
      ) : (
      <div
        className="relative border-b border-border px-2 py-2 flex flex-col gap-1.5 shrink-0"
        style={{ height: headerH }}
      >
        <div className="flex items-center gap-1.5">
          <SceneTriggerButton
            isPlaying={isPlaying}
            durationSec={scene.durationSec}
            startedAt={isPlaying ? activeSceneStartedAt : null}
            overlayClass={learnOverlayClass}
            onClick={(e) => {
              e.stopPropagation()
              trigger()
            }}
          />
          <UncontrolledTextInput
            className="input flex-1 text-[12px] font-semibold min-w-0"
            value={scene.name}
            onClick={(e) => e.stopPropagation()}
            onMouseDown={(e) => e.stopPropagation()}
            onChange={(v) => updateScene(sceneId, { name: v })}
          />
          <input
            type="color"
            className="w-5 h-5 bg-transparent border border-border rounded cursor-pointer shrink-0"
            value={scene.color}
            onClick={(e) => e.stopPropagation()}
            onChange={(e) => updateScene(sceneId, { color: e.target.value })}
            title="Scene color"
          />
        </div>

        {/* Italic notes textarea — shared height across all scenes. */}
        <UncontrolledTextarea
          className="input italic text-[11px] leading-snug w-full"
          style={{ height: notesHeight, resize: 'none' }}
          placeholder="Notes…"
          value={scene.notes ?? ''}
          onClick={(e) => e.stopPropagation()}
          onMouseDown={(e) => e.stopPropagation()}
          onChange={(v) => updateScene(sceneId, { notes: v })}
        />

        <div className="flex items-center gap-1 text-[10px]">
          <span className="label">Dur</span>
          <input
            className="input w-12 text-[11px] py-0.5"
            type="number"
            min={0.5}
            max={300}
            step={0.5}
            value={scene.durationSec}
            onClick={(e) => e.stopPropagation()}
            onMouseDown={(e) => e.stopPropagation()}
            onChange={(e) =>
              updateScene(sceneId, { durationSec: clamp(Number(e.target.value), 0.5, 300) })
            }
          />
          <span className="text-muted">s</span>
          <span className="label ml-1">Next</span>
          <select
            className="input flex-1 min-w-0 text-[11px] py-0.5"
            value={scene.nextMode}
            onClick={(e) => e.stopPropagation()}
            onMouseDown={(e) => e.stopPropagation()}
            onChange={(e) =>
              updateScene(sceneId, { nextMode: e.target.value as 'off' | 'next' | 'random' })
            }
          >
            <option value="off">Off</option>
            <option value="next">Next</option>
            <option value="random">Random</option>
          </select>
        </div>

        <div className="flex items-center gap-1">
          {scene.midiTrigger && (
            <span className="chip">
              {scene.midiTrigger.kind === 'note'
                ? noteName(scene.midiTrigger.number)
                : `CC${scene.midiTrigger.number}`}
              <span className="text-muted">ch{scene.midiTrigger.channel + 1}</span>
              <button
                className="ml-1 text-muted hover:text-danger"
                onClick={(e) => {
                  e.stopPropagation()
                  setSceneMidi(sceneId, undefined)
                }}
                title="Clear MIDI binding"
              >
                ✕
              </button>
            </span>
          )}
          <div className="flex-1" />
          <button
            className="btn text-[10px] px-1.5 py-0.5 text-danger hover:bg-danger hover:text-black"
            onClick={(e) => {
              e.stopPropagation()
              if (confirm(`Delete "${scene.name}"?`)) removeScene(sceneId)
            }}
          >
            Del
          </button>
        </div>

        {/* Notes resize handle on the bottom border of the header — identical
            placement to the handle in TrackSidebar to keep alignment. */}
        <ResizeHandle
          direction="row"
          value={notesHeight}
          onChange={setNotesHeight}
          min={0}
          max={220}
          className="absolute bottom-0 left-0 right-0 h-[4px]"
          title="Drag to resize notes area"
        />
      </div>
      )}

      {/* Cells — one per track, same height as track rows. */}
      {tracks.map((t) => (
        <div
          key={t.id}
          className="border-b border-border shrink-0"
          style={{ height: rowHeight }}
        >
          <CellTile sceneId={sceneId} trackId={t.id} />
        </div>
      ))}
    </div>
  )
}

function clamp(v: number, lo: number, hi: number): number {
  if (Number.isNaN(v)) return lo
  return v < lo ? lo : v > hi ? hi : v
}

// Scene trigger button with a clockwise fill that animates over `durationSec`.
// Using `animation-delay: calc(-{elapsed}s)` so the CSS animation lines up with
// actual elapsed time (useful when the scene was triggered by MIDI/auto-advance
// rather than a click on this exact button).
function SceneTriggerButton({
  isPlaying,
  durationSec,
  startedAt,
  overlayClass,
  onClick
}: {
  isPlaying: boolean
  durationSec: number
  startedAt: number | null
  overlayClass?: string
  onClick: (e: React.MouseEvent) => void
}): JSX.Element {
  const elapsedSec = isPlaying && startedAt ? Math.max(0, (Date.now() - startedAt) / 1000) : 0
  return (
    <button
      className={`relative w-6 h-6 rounded-sm border flex items-center justify-center shrink-0 overflow-hidden ${
        isPlaying
          ? 'bg-accent border-accent text-black'
          : 'border-border bg-panel2 hover:border-accent'
      }`}
      onClick={onClick}
      title={isPlaying ? 'Stop scene' : 'Trigger scene'}
    >
      {isPlaying && startedAt !== null && (
        <span
          key={startedAt}
          aria-hidden
          className="scene-fill absolute inset-0 pointer-events-none"
          style={{
            animationDuration: `${Math.max(0.1, durationSec)}s`,
            animationDelay: `-${elapsedSec}s`
          }}
        />
      )}
      {isPlaying ? (
        <svg width="10" height="10" viewBox="0 0 10 10" className="relative z-10">
          <rect x="1" y="1" width="8" height="8" fill="currentColor" />
        </svg>
      ) : (
        <svg width="10" height="10" viewBox="0 0 10 10">
          <polygon points="2,1 9,5 2,9" fill="currentColor" />
        </svg>
      )}
      {overlayClass && <div className={`midi-learn-overlay ${overlayClass}`} aria-hidden />}
    </button>
  )
}

function noteName(n: number): string {
  const names = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']
  return names[n % 12] + (Math.floor(n / 12) - 1)
}
