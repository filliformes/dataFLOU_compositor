import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { useSortable } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import type { NextMode } from '@shared/types'
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

  // Sortable hook — provides drag listeners that we wire onto the
  // top-edge color strip below (the strip becomes the drag handle).
  // Hook order must stay stable across the scene-deleted branch, so
  // this lives ABOVE the early return. The `id` namespace matches
  // EditView's SortableContext items prefix.
  const {
    attributes: sortAttributes,
    listeners: sortListeners,
    setNodeRef: setSortableRef,
    transform: sortTransform,
    transition: sortTransition,
    isDragging: sortIsDragging
  } = useSortable({ id: `scene-col:${sceneId}` })
  const sortableStyle: React.CSSProperties = {
    transform: CSS.Transform.toString(sortTransform),
    transition: sortTransition,
    // Lift the dragged column above its siblings so the preview
    // floats clearly over the static cells next door, and dim it a
    // little so the user can read where it's about to land.
    zIndex: sortIsDragging ? 30 : undefined,
    opacity: sortIsDragging ? 0.85 : undefined
  }

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
    // The scene-header div is the parent of every inline scene
    // editor input (name, duration, notes, next-mode select). After
    // a focus change, Chromium can leave any previously-focused
    // input — e.g. the cell editor's value input in the right
    // panel that just unmounted via setFocusedScene's mutex —
    // holding a sticky pseudo-focus that swallows the next click
    // on the freshly-rendered scene-header inputs. rAF blur +
    // body.focus releases it so the user can type into the scene
    // name / duration immediately without an alt-tab.
    requestAnimationFrame(() => {
      if (document.activeElement instanceof HTMLElement) {
        document.activeElement.blur()
      }
      document.body.focus?.()
    })
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
      ref={setSortableRef}
      className={`shrink-0 border-r border-border flex flex-col relative ${
        isInSelection ? 'ring-1 ring-inset ring-accent/30' : ''
      }`}
      style={{
        // Each column auto-sizes to its widest cell — multi-arg
        // bundles like OCTOCOSME's 12-float Voice Pots make a
        // wide cell, the column grows to fit. The user's slider
        // becomes a MINIMUM width (so single-value scenes still
        // honour the manual size) and `fit-content` lets the
        // column expand past it when content needs more room.
        width: 'fit-content',
        minWidth: scenesCollapsed ? SCENE_COL_COLLAPSED_MIN_W : sceneColumnWidth,
        background: tint,
        ...sortableStyle
      }}
      onClick={onHeaderClick}
      /* onContextMenu is attached ONLY to the scene-header divs below —
         right-click on a cell should reach CellTile's own menu without
         this column handler firing too. */
    >
      {/* 6px color strip on top — doubles as the drag handle for
          reordering scenes in the grid. cursor-grab on hover invites
          the user to drag; pointer-events:auto so the sortable
          listeners actually fire (the old strip was pointer-events-
          none for visual-only). Absolute positioning keeps it out of
          the layout flow so cells stay aligned with the track sidebar
          rows. The activation distance configured in EditView's
          DndContext prevents accidental drags on a click-through. */}
      <div
        {...sortAttributes}
        {...sortListeners}
        className="absolute top-0 left-0 right-0 h-[6px] z-10 cursor-grab active:cursor-grabbing"
        style={{ background: scene.color, touchAction: 'none' }}
        title="Drag to reorder this scene"
        onClick={(e) => e.stopPropagation()}
        onMouseDown={(e) => e.stopPropagation()}
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
            // Focusing the scene name input re-anchors selection
            // onto this scene. Without this, clicking the input
            // while a Pool / SavedScene was still selected left
            // the inspector pane's input as the truly-focused
            // element on the next render, and the user had to
            // alt-tab to break out — the original "have to go to
            // another window to edit" report.
            onFocus={() => {
              if (useStore.getState().session.focusedSceneId !== sceneId) {
                setFocusedScene(sceneId)
              }
            }}
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
            // select-compact swaps the bulky native dropdown arrow (~20 px
            // on Windows, ~24 px on macOS) for a small 8 px SVG chevron —
            // reclaims enough room that even "Previous" + chevron fit in
            // ~70 px without the overflowing-column look we had with the
            // native control. min-w-0 lets flex-1 shrink naturally.
            className="input select-compact flex-1 min-w-0 text-[11px] py-0.5"
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
          {/* MIDI binding chip — folded inline with DUR/NEXT so the
              scene header doesn't carry a separate orphan line for
              every bound scene. Compact "MIDI" prefix + note/CC
              label + channel; click ✕ to clear. Hidden when nothing
              is bound to this scene. */}
          {scene.midiTrigger && (
            <span
              className="flex items-center gap-0.5 text-[9px] text-muted shrink-0 px-1 rounded border border-border ml-1 whitespace-nowrap"
              title={`MIDI: ${
                scene.midiTrigger.kind === 'note'
                  ? noteName(scene.midiTrigger.number)
                  : `CC${scene.midiTrigger.number}`
              } on channel ${scene.midiTrigger.channel + 1}`}
              onClick={(e) => e.stopPropagation()}
              onMouseDown={(e) => e.stopPropagation()}
            >
              <span className="text-text">
                {scene.midiTrigger.kind === 'note'
                  ? noteName(scene.midiTrigger.number)
                  : `CC${scene.midiTrigger.number}`}
              </span>
              <span>ch{scene.midiTrigger.channel + 1}</span>
              <button
                className="text-muted hover:text-danger leading-none"
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

      {/* Cells — one per track, same height as track rows. Template
          rows are visual-only group headers (no clips of their own),
          but we render a centered group-trigger button at their
          intersection: clicking fires every child Parameter's clip
          on this scene at once. Stopping toggles them all off. */}
      {tracks.map((t) => {
        // A track is effectively disabled when its own enabled flag
        // is false OR when its parent Template's flag is. Visual:
        // dim the cell to match the sidebar row's grey-out.
        const parent = t.parentTrackId
          ? tracks.find((tt) => tt.id === t.parentTrackId)
          : null
        const dimmed = t.enabled === false || parent?.enabled === false
        return t.kind === 'template' ? (
          <div
            key={t.id}
            className={`border-b border-border shrink-0 bg-panel/40 ${
              dimmed ? 'opacity-40' : ''
            }`}
            style={{ height: rowHeight }}
          >
            <InstrumentTriggerCell sceneId={sceneId} templateRowId={t.id} />
          </div>
        ) : (
          <div
            key={t.id}
            className={`border-b border-border shrink-0 ${dimmed ? 'opacity-40' : ''}`}
            style={{ height: rowHeight }}
          >
            <CellTile sceneId={sceneId} trackId={t.id} />
          </div>
        )
      })}

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
            {/* Follow Action submenu — applies to ALL targets (the
                whole multi-selection when one is active, otherwise
                this scene). Inline list keeps the menu shallow; on
                small monitors a fly-out submenu would clip. */}
            <div className="px-3 py-1 text-[10px] text-muted">
              {menu.targets.length > 1
                ? `Set Follow Action (${menu.targets.length} scenes)`
                : 'Set Follow Action'}
            </div>
            <div className="grid grid-cols-2 gap-px px-2 pb-1">
              {[
                { id: 'stop', label: 'Stop' },
                { id: 'loop', label: 'Loop' },
                { id: 'next', label: 'Next' },
                { id: 'prev', label: 'Prev' },
                { id: 'first', label: 'First' },
                { id: 'last', label: 'Last' },
                { id: 'any', label: 'Any' },
                { id: 'other', label: 'Other' }
              ].map((m) => {
                const current =
                  menu.targets.length === 1 ? scene.nextMode : null
                const active = current === m.id
                return (
                  <button
                    key={m.id}
                    className={`text-[11px] px-2 py-0.5 rounded border ${
                      active
                        ? 'bg-accent text-black border-accent'
                        : 'border-border hover:bg-panel2'
                    }`}
                    onClick={() => {
                      const ids = menu.targets
                      setMenu(null)
                      ids.forEach((id) =>
                        useStore.getState().updateScene(id, { nextMode: m.id as NextMode })
                      )
                    }}
                  >
                    {m.label}
                  </button>
                )
              })}
            </div>
            <div className="border-t border-border my-1" />
            {/* Save to Pool + Duplicate — now multi-selection aware.
                Save loops over each target id and saves them as
                separate SavedScenes (each gets its own row in the
                Pool's Scenes tab). Duplicate does the same one-at-
                a-time then focuses the LAST new scene. */}
            <button
              className="w-full text-left px-3 py-1 hover:bg-panel2"
              onClick={() => {
                const ids = menu.targets
                setMenu(null)
                const st = useStore.getState()
                for (const id of ids) {
                  const cur = st.session.scenes.find((s) => s.id === id)
                  const suggestedName = cur?.name ?? 'Saved Scene'
                  void st.saveSceneToLibrary(id, suggestedName)
                }
              }}
              title={
                menu.targets.length > 1
                  ? `Snapshot each of the ${menu.targets.length} selected scenes into the Pool as separate saved scenes.`
                  : 'Snapshot this scene + its tracks + its Pool templates into the global Saved Scenes library.'
              }
            >
              {menu.targets.length > 1
                ? `Save ${menu.targets.length} Scenes to Pool`
                : 'Save Scene to Pool'}
            </button>
            <button
              className="w-full text-left px-3 py-1 hover:bg-panel2"
              onClick={() => {
                const ids = menu.targets
                setMenu(null)
                const st = useStore.getState()
                let lastNewId: string | null = null
                for (const id of ids) {
                  const newId = st.duplicateScene(id)
                  if (newId) lastNewId = newId
                }
                if (lastNewId) st.setFocusedScene(lastNewId)
              }}
              title={
                menu.targets.length > 1
                  ? `Create a copy of each selected scene — each new scene named "<orig> (copy)" (auto-incremented if duplicates exist).`
                  : "Create a copy of this scene (Ctrl+Alt+D) — same tracks + cloned cells, named '<orig> (copy)'."
              }
            >
              {menu.targets.length > 1
                ? `Duplicate ${menu.targets.length} Scenes`
                : 'Duplicate Scene'}
              {menu.targets.length === 1 && (
                <span className="text-muted text-[10px] ml-1">Ctrl+Alt+D</span>
              )}
            </button>
            <div className="border-t border-border my-1" />
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

// Group-trigger cell rendered at the intersection of a Template
// (Instrument) header row and a Scene column. Templates carry no
// clips of their own; this button fires every child Parameter's
// clip in this scene at once. State logic:
//   • Any child active   → button shows STOP, click stops all children.
//   • No children active → button shows PLAY, click triggers every
//                          child that has a cell on this scene.
// Sizing follows the row: full 36px in normal view, ~22px when the
// Instruments column is collapsed (so the row stays at its 32px
// height without overflow).
function InstrumentTriggerCell({
  sceneId,
  templateRowId
}: {
  sceneId: string
  templateRowId: string
}): JSX.Element {
  const tracks = useStore((s) => s.session.tracks)
  const cellsOnScene = useStore(
    (s) => s.session.scenes.find((sc) => sc.id === sceneId)?.cells ?? {}
  )
  const groupMidi = useStore(
    (s) => s.session.scenes.find((sc) => sc.id === sceneId)?.instrumentTriggers?.[templateRowId]
  )
  const activeBySceneAndTrack = useStore((s) => s.engine.activeBySceneAndTrack)
  const tracksCollapsed = useStore((s) => s.tracksCollapsed)
  const showMode = useStore((s) => s.showMode)
  const compact = tracksCollapsed || showMode
  const midiLearnMode = useStore((s) => s.midiLearnMode)
  const midiLearnTarget = useStore((s) => s.midiLearnTarget)
  const setMidiLearnTarget = useStore((s) => s.setMidiLearnTarget)
  const childTrackIds = tracks
    .filter((t) => t.parentTrackId === templateRowId)
    .map((t) => t.id)
  const childrenWithCells = childTrackIds.filter((id) => !!cellsOnScene[id])
  const sceneActive = activeBySceneAndTrack[sceneId] ?? {}
  const anyChildActive = childTrackIds.some((id) => !!sceneActive[id])
  const empty = childrenWithCells.length === 0
  // MIDI learn overlay class — same vocabulary as CellTile uses for
  // its own trigger square. Selected = orange ring, bound = green,
  // available = blue.
  const learnSelected =
    midiLearnTarget?.kind === 'instrument' &&
    midiLearnTarget.sceneId === sceneId &&
    midiLearnTarget.templateRowId === templateRowId
  const learnOverlayClass = !midiLearnMode
    ? ''
    : learnSelected
      ? 'midi-learn-selected'
      : groupMidi
        ? 'midi-learn-green'
        : 'midi-learn-blue'
  async function onClick(e: React.MouseEvent): Promise<void> {
    e.stopPropagation()
    if (midiLearnMode) {
      setMidiLearnTarget({ kind: 'instrument', sceneId, templateRowId })
      return
    }
    if (empty) return
    if (anyChildActive) {
      await Promise.all(
        childTrackIds
          .filter((id) => !!sceneActive[id])
          .map((id) => window.api.stopCell(sceneId, id))
      )
    } else {
      await Promise.all(
        childrenWithCells.map((id) => window.api.triggerCell(sceneId, id))
      )
    }
  }
  const sizeClass = compact ? 'w-5 h-5 rounded' : 'w-9 h-9 rounded-md'
  const iconPx = compact ? 8 : 14
  return (
    <div className="w-full h-full flex items-center justify-center">
      <button
        className={`relative border-2 flex items-center justify-center transition-colors ${sizeClass} ${
          empty
            ? 'border-border/50 bg-panel2/40 text-muted/40 cursor-not-allowed'
            : anyChildActive
              ? 'border-accent bg-accent text-black hover:brightness-110'
              : 'border-border bg-panel2 text-text hover:border-accent hover:text-accent'
        }`}
        onClick={onClick}
        title={
          midiLearnMode
            ? groupMidi
              ? 'Bound — click to re-learn this Instrument trigger'
              : 'Click then send a MIDI message to bind this Instrument trigger'
            : empty
              ? 'No Parameters on this scene yet — add cells under this Instrument first'
              : anyChildActive
                ? `Stop ${childrenWithCells.length} Parameter${childrenWithCells.length === 1 ? '' : 's'} of this Instrument`
                : `Trigger ${childrenWithCells.length} Parameter${childrenWithCells.length === 1 ? '' : 's'} of this Instrument`
        }
      >
        {anyChildActive ? (
          <svg width={iconPx} height={iconPx} viewBox="0 0 10 10">
            <rect x="1" y="1" width="8" height="8" fill="currentColor" />
          </svg>
        ) : (
          <svg width={iconPx} height={iconPx} viewBox="0 0 10 10">
            <polygon points="2,1 9,5 2,9" fill="currentColor" />
          </svg>
        )}
        {learnOverlayClass && (
          <div className={`midi-learn-overlay ${learnOverlayClass}`} aria-hidden />
        )}
      </button>
    </div>
  )
}
