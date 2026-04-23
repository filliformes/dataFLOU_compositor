import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { useStore } from '../store'
import CellTile from './CellTile'
import { SCENE_COL_COLLAPSED_MIN_W, useEffectiveRowHeight, useHeaderHeight } from './EditView'
import { ResizeHandle } from './ResizeHandle'
import { UncontrolledTextInput } from './UncontrolledInput'
import { BoundedNumberInput } from './BoundedNumberInput'

export default function SceneColumn({ sceneId }: { sceneId: string }): JSX.Element {
  const scene = useStore((s) => s.session.scenes.find((sc) => sc.id === sceneId))
  const tracks = useStore((s) => s.session.tracks)
  const focusedSceneId = useStore((s) => s.session.focusedSceneId)
  const selectedSceneIds = useStore((s) => s.selectedSceneIds)
  const updateScene = useStore((s) => s.updateScene)
  const removeScene = useStore((s) => s.removeScene)
  const removeScenes = useStore((s) => s.removeScenes)
  const setFocusedScene = useStore((s) => s.setFocusedScene)
  const selectSceneRange = useStore((s) => s.selectSceneRange)
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
  const scenesCollapsedRaw = useStore((s) => s.scenesCollapsed)
  const showMode = useStore((s) => s.showMode)
  const isArmed = useStore((s) => s.armedSceneId === sceneId)
  // Show mode forces collapsed-header layout regardless of the user's pref.
  const scenesCollapsed = scenesCollapsedRaw || showMode
  const headerH = useHeaderHeight()

  // Right-click context menu state. HOISTED above the defensive early
  // return below so the hook order stays stable across the scene-exists
  // vs scene-just-deleted branches — otherwise React throws "Rendered
  // fewer hooks than during the previous render" the frame a scene gets
  // removed while its column is still being rendered by the parent.
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

  // Defensive: during the render just after a delete, React may still call us
  // before the parent re-renders. Bail out cleanly.
  if (!scene) return <></>

  const isPlaying = engineActiveScene === sceneId
  const isFocused = focusedSceneId === sceneId
  // Column is visually selected when it's part of the current multi-select.
  // Falls back to isFocused for the single-select case to keep old behavior
  // when nothing's been explicitly multi-selected yet.
  const isInSelection = selectedSceneIds.length > 0
    ? selectedSceneIds.includes(sceneId)
    : isFocused

  async function trigger(): Promise<void> {
    // In MIDI Learn mode, clicking the trigger selects it as the learn target
    // instead of firing the scene. Binding happens on the next MIDI message.
    if (midiLearnMode) {
      setMidiLearnTarget({ kind: 'scene', id: sceneId })
      return
    }
    if (isPlaying) await window.api.stopScene(sceneId)
    else useStore.getState().triggerSceneWithMorph(sceneId)
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

  // (Menu state hooks live at the top of the component so hook order
  // stays stable across scene-exists vs scene-just-deleted branches.)

  // Plain click = single select + new anchor. Shift-click = extend range
  // from anchor (focusedSceneId) through this scene inclusive. Matches the
  // Shift-click convention used for message rows.
  // Alt-click (or Option on Mac) = arm as next cue — fast-access path for
  // performers. Right-click menu + `A` key do the same thing.
  function onHeaderClick(e: React.MouseEvent): void {
    if (e.altKey) {
      const current = useStore.getState().armedSceneId
      useStore.getState().setArmedSceneId(current === sceneId ? null : sceneId)
      return
    }
    if (e.shiftKey) selectSceneRange(sceneId)
    else setFocusedScene(sceneId)
  }

  function onContextMenu(e: React.MouseEvent): void {
    // Don't hijack the browser's right-click inside input / textarea /
    // select / contenteditable — the user probably wants clipboard actions.
    const tag = (e.target as HTMLElement | null)?.tagName
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return
    e.preventDefault()
    const inSel = selectedSceneIds.includes(sceneId)
    // If this scene is part of a multi-selection, the menu acts on the
    // whole selection. Otherwise it targets just this one and we replace
    // the selection so the user's intent is unambiguous.
    const targets = inSel && selectedSceneIds.length > 1 ? selectedSceneIds : [sceneId]
    if (!inSel) setFocusedScene(sceneId)
    setMenu({ x: e.clientX, y: e.clientY, targets })
  }

  return (
    <div
      className={`shrink-0 border-r border-border flex flex-col relative ${
        isInSelection ? 'ring-1 ring-inset ring-accent/30' : ''
      }`}
      style={{
        // When scenes are collapsed, each column auto-sizes to its own
        // content (play button + scene name + whatever's in the cells)
        // instead of a fixed 132 px. Shorter names → tighter columns;
        // fits many more scenes on screen at once.
        width: scenesCollapsed ? 'fit-content' : sceneColumnWidth,
        minWidth: scenesCollapsed ? SCENE_COL_COLLAPSED_MIN_W : undefined,
        background: tint
      }}
      onClick={onHeaderClick}
      /* onContextMenu is attached ONLY to the scene-header divs below —
         right-click on a cell should reach CellTile's own menu without
         this column handler firing too. */
    >
      {/* 3px color strip on top — absolute so it doesn't affect layout height
          (which would misalign cells against the track sidebar rows). */}
      <div
        className="absolute top-0 left-0 right-0 h-[3px] z-10 pointer-events-none"
        style={{ background: scene.color }}
      />
      {/* Column-width resize handle on the right edge — global. */}
      {/* Column-width resize handle is hidden while scenes are collapsed —
          the column is locked to a compact preset width in that mode, and
          the handle would otherwise hit the name input at 132 px wide. */}
      <ResizeHandle
        direction="col"
        value={sceneColumnWidth}
        onChange={setSceneColumnWidth}
        min={180}
        max={480}
        className={`absolute top-0 right-0 bottom-0 w-[4px] z-10 ${scenesCollapsed ? 'hidden' : ''}`}
        title="Drag to resize all scene columns"
      />

      {/* Scene header — full vs collapsed layouts */}
      {scenesCollapsed ? (
        <div
          className="relative border-b border-border px-2 flex items-center gap-1.5 shrink-0"
          style={{ height: headerH }}
          onContextMenu={onContextMenu}
        >
          {isArmed && <div className="armed-ring absolute inset-0 pointer-events-none z-0" />}
          {isArmed && <span className="armed-chevron" aria-hidden>▶▶</span>}
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
            // `size` makes the input hug its own text (native <input size>
            // attribute). Minimum 3 so tiny names still leave room to click;
            // + 1 gives a trailing space so the caret doesn't clip on the
            // last character. Paired with the column's `fit-content` width,
            // this gives us per-scene adaptive widths.
            size={Math.max(3, scene.name.length + 1)}
            className="input text-[11px] font-semibold py-0.5"
            value={scene.name}
            disabled={showMode}
            onClick={(e) => e.stopPropagation()}
            onMouseDown={(e) => e.stopPropagation()}
            onChange={(e) => updateScene(sceneId, { name: e.target.value })}
          />
        </div>
      ) : (
      <div
        className="relative border-b border-border px-2 py-2 flex flex-col gap-1.5 shrink-0"
        style={{ height: headerH }}
        onContextMenu={onContextMenu}
      >
        {isArmed && <div className="armed-ring absolute inset-0 pointer-events-none z-0" />}
        {isArmed && <span className="armed-chevron" aria-hidden>▶▶</span>}
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

        {/* Italic notes textarea — shared height across all scenes.
            Uses a plain controlled <textarea> (not UncontrolledTextarea)
            because scene.notes is never updated by the 20Hz engine tick,
            so the controlled-input race UncontrolledTextarea guards against
            doesn't apply here. The uncontrolled version also had a quirk
            where switching OS windows + coming back could leave the
            element in a state where keystrokes didn't register. */}
        {notesHeight > 0 && (
          <textarea
            className="input italic text-[11px] leading-snug w-full"
            // overflow hidden = no scrollbar chrome cluttering a one-line
            // strip. If the user wants more room they drag the notes
            // handle bigger; content beyond the visible height just clips.
            style={{ height: notesHeight, resize: 'none', overflow: 'hidden' }}
            placeholder="Notes…"
            value={scene.notes ?? ''}
            onClick={(e) => e.stopPropagation()}
            onMouseDown={(e) => e.stopPropagation()}
            onChange={(e) => updateScene(sceneId, { notes: e.target.value })}
          />
        )}

        <div className="flex items-center gap-1 text-[10px]">
          <span className="label">Dur</span>
          <span
            onClick={(e) => e.stopPropagation()}
            onMouseDown={(e) => e.stopPropagation()}
          >
            <BoundedNumberInput
              className="input w-12 text-[11px] py-0.5"
              value={scene.durationSec}
              onChange={(v) => updateScene(sceneId, { durationSec: v })}
              min={0.5}
              max={300}
            />
          </span>
          <span className="text-muted">s</span>
          <span className="label ml-1">Next</span>
          <select
            className="input flex-1 min-w-0 text-[11px] py-0.5"
            value={scene.nextMode}
            onClick={(e) => e.stopPropagation()}
            onMouseDown={(e) => e.stopPropagation()}
            onChange={(e) =>
              updateScene(sceneId, {
                nextMode: e.target.value as
                  | 'stop'
                  | 'loop'
                  | 'next'
                  | 'prev'
                  | 'first'
                  | 'last'
                  | 'any'
                  | 'other'
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
        </div>

        {/* MIDI binding chip — Delete moved to the right-click context menu. */}
        {scene.midiTrigger && (
          <div className="flex items-center gap-1">
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
          </div>
        )}

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

      {/* Right-click context menu — portaled to <body> so it isn't clipped
          by the column's overflow boundary. Closes on click-outside or
          Escape (see useEffect above). */}
      {menu &&
        createPortal(
          <div
            className="fixed z-50 bg-panel border border-border rounded shadow-lg py-1 text-[12px] min-w-[180px]"
            style={{ left: menu.x, top: menu.y }}
            // Stop the window-level mousedown listener from closing before
            // the menu button's click fires.
            onMouseDown={(e) => e.stopPropagation()}
          >
            {/* Arm / clear cue — single-scene action (greyed out when a
                multi-selection is active to avoid ambiguity). */}
            {menu.targets.length === 1 && (
              <>
                {useStore.getState().armedSceneId === sceneId ? (
                  <button
                    className="w-full text-left px-3 py-1 hover:bg-panel2"
                    onClick={() => {
                      useStore.getState().setArmedSceneId(null)
                      setMenu(null)
                    }}
                  >
                    Clear arm
                  </button>
                ) : (
                  <button
                    className="w-full text-left px-3 py-1 hover:bg-panel2"
                    onClick={() => {
                      useStore.getState().setArmedSceneId(sceneId)
                      setMenu(null)
                    }}
                  >
                    Arm as next ▶▶
                  </button>
                )}
                <div className="border-t border-border my-1" />
              </>
            )}
            <button
              className="w-full text-left px-3 py-1 hover:bg-panel2 text-danger"
              onClick={() => {
                const ids = menu.targets
                setMenu(null)
                const n = ids.length
                if (n === 0) return
                const label =
                  n === 1
                    ? `Delete "${scene.name}"?`
                    : `Delete ${n} scenes?`
                if (!confirm(label)) return
                if (n === 1) removeScene(ids[0])
                else removeScenes(ids)
              }}
            >
              {menu.targets.length > 1
                ? `Delete ${menu.targets.length} scenes`
                : 'Delete scene'}
            </button>
          </div>,
          document.body
        )}
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
