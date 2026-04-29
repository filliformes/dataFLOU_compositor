// 128-step drag-drop matrix + bottom transport/status bar.

import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  DndContext,
  DragEndEvent,
  DragOverlay,
  DragStartEvent,
  PointerSensor,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors
} from '@dnd-kit/core'
import { useStore } from '../store'
import { formatRemaining, useSceneCountdown } from '../hooks/useSceneCountdown'
import type { NextMode, Scene } from '@shared/types'
import { ResizeHandle } from './ResizeHandle'
import { BoundedNumberInput } from './BoundedNumberInput'

export default function SequenceView(): JSX.Element {
  const scenes = useStore((s) => s.session.scenes)
  const sequence = useStore((s) => s.session.sequence)
  const sequenceLength = useStore((s) => s.session.sequenceLength)
  const setSequenceLength = useStore((s) => s.setSequenceLength)
  const setSequenceSlot = useStore((s) => s.setSequenceSlot)
  const activeSceneId = useStore((s) => s.engine.activeSceneId)
  const activeSlotIdx = useStore((s) => s.engine.activeSequenceSlotIdx)
  const focusedSceneId = useStore((s) => s.session.focusedSceneId)
  const focusedScene = scenes.find((s) => s.id === focusedSceneId) ?? null
  const paletteWidth = useStore((s) => s.scenePaletteWidth)
  const setPaletteWidth = useStore((s) => s.setScenePaletteWidth)
  // S keyboard shortcut hides the focused-scene info panel so the
  // user can free up the palette area for scrolling through long
  // scene lists.
  const sceneInspectorVisible = useStore((s) => s.sceneInspectorVisible)

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }))

  const [clearMode, setClearMode] = useState(false)
  // Timeline mode lives in the store so it survives switching to
  // Edit view and back. Clear mode stays local since it's a
  // transient editing aid.
  const timelineMode = useStore((s) => s.timelineMode)
  const setTimelineMode = useStore((s) => s.setTimelineMode)
  // Tracks what's currently being dragged so <DragOverlay> can render a
  // floating preview. Null when nothing is active. Strings are dnd-kit ids
  // like `scene-<id>` (palette → slot) or `slot-<N>` (slot → slot swap).
  const [activeDragId, setActiveDragId] = useState<string | null>(null)
  // Right-click context menu for scenes — shared across PaletteItem
  // and SlotCell. Menu items: "Arm as next" (toggles armedSceneId) and
  // "Delete Scene" (with confirm). Slot cells fire a CustomEvent so we
  // don't have to thread setMenu through every prop chain.
  const [sceneMenu, setSceneMenu] = useState<{ sceneId: string; x: number; y: number } | null>(
    null
  )
  // Section-level menu — shown when the user right-clicks the blank
  // area in the palette below the pills. Items: Add Scene / Add
  // Scenes…  Same CustomEvent pattern as the per-scene menu.
  const [sectionMenu, setSectionMenu] = useState<{ x: number; y: number } | null>(null)
  // Slot-cell menu — distinct from the scene menu because the
  // actions are slot-scoped (Clear THIS slot + Set Follow Action on
  // the scene that occupies it). Fired by slot grids + Timeline
  // segments via `dataflou:scene-slot-menu`.
  const [slotMenu, setSlotMenu] = useState<{
    slotIdx: number
    sceneId: string
    x: number
    y: number
  } | null>(null)
  useEffect(() => {
    function onMenu(e: Event): void {
      const detail = (e as CustomEvent<{ sceneId: string; x: number; y: number }>).detail
      setSceneMenu({ sceneId: detail.sceneId, x: detail.x, y: detail.y })
    }
    function onSectionMenu(e: Event): void {
      const detail = (e as CustomEvent<{ x: number; y: number }>).detail
      setSectionMenu({ x: detail.x, y: detail.y })
    }
    function onSlotMenu(e: Event): void {
      const detail = (
        e as CustomEvent<{ slotIdx: number; sceneId: string; x: number; y: number }>
      ).detail
      setSlotMenu(detail)
    }
    window.addEventListener('dataflou:scene-menu', onMenu)
    window.addEventListener('dataflou:scene-section-menu', onSectionMenu)
    window.addEventListener('dataflou:scene-slot-menu', onSlotMenu)
    return () => {
      window.removeEventListener('dataflou:scene-menu', onMenu)
      window.removeEventListener('dataflou:scene-section-menu', onSectionMenu)
      window.removeEventListener('dataflou:scene-slot-menu', onSlotMenu)
    }
  }, [])
  const visible = sequence.slice(0, sequenceLength)
  const cols = Math.min(16, Math.max(1, sequenceLength))
  // Cell minimum width — drops once the sequence is long enough that
  // 16 cols × 52 px would force a wide row. With > 72 scenes the
  // user can drag the palette wider (or the window narrower) without
  // the grid pushing them around: cells shrink to fit, with 8 steps
  // visible at the absolute minimum row width.
  const cellMinPx = sequenceLength > 72 ? 28 : 52

  function handleDragStart(e: DragStartEvent): void {
    setActiveDragId(String(e.active.id))
  }

  function handleDragEnd(e: DragEndEvent): void {
    setActiveDragId(null)
    if (!e.over) return
    const overId = e.over.id as string
    const activeId = e.active.id as string

    const overMatch = overId.match(/^slot-(\d+)$/)
    if (!overMatch) return
    const overIdx = Number(overMatch[1])

    const slotMatch = activeId.match(/^slot-(\d+)$/)
    if (slotMatch) {
      const fromIdx = Number(slotMatch[1])
      const from = sequence[fromIdx]
      const to = sequence[overIdx]
      setSequenceSlot(fromIdx, to)
      setSequenceSlot(overIdx, from)
    } else if (activeId.startsWith('scene-')) {
      const draggedSceneId = activeId.slice(6)
      // If the dragged scene is part of a multi-selection in the
      // palette, drop the WHOLE selection into consecutive slots
      // starting at `overIdx`. Selection order is the scene order
      // in `scenes` (so the user gets predictable left-to-right
      // placement). Slots beyond `sequenceLength` aren't touched —
      // the caller can extend the sequence first if they want more.
      const st = useStore.getState()
      const sel = st.selectedSceneIds
      if (sel.length > 1 && sel.includes(draggedSceneId)) {
        const orderedIds = scenes.map((s) => s.id).filter((id) => sel.includes(id))
        for (let k = 0; k < orderedIds.length; k++) {
          const slot = overIdx + k
          if (slot >= sequenceLength) break
          setSequenceSlot(slot, orderedIds[k])
        }
        // Anchor the inspector on the first dropped scene + that
        // slot so the user can tweak its Duration immediately.
        st.setFocusedScene(orderedIds[0])
        st.setSelectedSequenceSlot(overIdx)
      } else {
        setSequenceSlot(overIdx, draggedSceneId)
        st.setFocusedScene(draggedSceneId)
        st.setSelectedSequenceSlot(overIdx)
      }
      // Bump the focus token so the SceneInfoPanel's Duration field
      // grabs focus + selects-all on the next render. Lets the user
      // type a number right after dropping without clicking the
      // input first.
      st.requestFocusDuration()
    }
  }

  function sceneById(id: string): Scene | undefined {
    return scenes.find((s) => s.id === id)
  }

  // Resolve the currently-dragged scene (whether from the palette or a
  // sequencer slot) so we can preview it in the DragOverlay below.
  function draggedScene(): Scene | null {
    if (!activeDragId) return null
    if (activeDragId.startsWith('scene-')) {
      return sceneById(activeDragId.slice(6)) ?? null
    }
    const m = activeDragId.match(/^slot-(\d+)$/)
    if (m) {
      const sid = sequence[Number(m[1])]
      return sid ? sceneById(sid) ?? null : null
    }
    return null
  }

  return (
    <DndContext
      sensors={sensors}
      onDragStart={handleDragStart}
      onDragEnd={handleDragEnd}
      onDragCancel={() => setActiveDragId(null)}
    >
      <div className="flex flex-col h-full min-h-0">
        <div className="flex flex-1 min-h-0">
          {/* Single left column holding the scene list on top and — when a
              scene is focused — its info panel directly below. User-resizable
              via the handle on the right edge (200–480 px). The sequencer
              grid sits to the right and reflows automatically. */}
          <div
            className="shrink-0 bg-panel border-r border-border flex flex-col relative"
            style={{ width: paletteWidth }}
          >
            <div className="px-2 py-2 border-b border-border shrink-0 flex items-center gap-2">
              <span className="label flex-1 truncate">Scenes ({scenes.length})</span>
              {/* + Silence: a regular scene with no cells (no OSC fires)
                  + a recognisable name + gray color. Lets the user wedge
                  a timed gap between scenes in the sequence. */}
              <button
                className="btn text-[10px] py-0 px-1.5 leading-tight shrink-0"
                onClick={() => useStore.getState().addSilenceScene()}
                title="Add a Silence scene (delay / blank)"
              >
                + Silence
              </button>
              <button
                className="btn text-[10px] py-0 px-1.5 leading-tight shrink-0"
                onClick={() => useStore.getState().addScene()}
                title="Add a new scene (Alt+S)"
              >
                + Scene
              </button>
            </div>
            {/* Multi-column palette: 12 scenes per column, up to 4
                columns. Beyond 48 the grid stays at 4 columns and pill
                text shrinks via min-w/auto-size. CSS Grid with column-
                first auto-flow keeps the visual order natural — top of
                column 1 is scene 1, bottom of column 4 is scene 48. */}
            <PaletteGrid scenes={scenes} focusedSceneId={focusedSceneId} />
            {focusedScene && sceneInspectorVisible && (
              <div className="shrink-0 border-t border-border overflow-y-auto max-h-[60%]">
                <SceneInfoPanel scene={focusedScene} />
              </div>
            )}
            {/* Drag the right edge to resize. Matches the pattern used for
                scene column width + Inspector width elsewhere. */}
            <ResizeHandle
              direction="col"
              value={paletteWidth}
              onChange={setPaletteWidth}
              min={200}
              max={1200}
              className="absolute top-0 right-0 bottom-0 w-[4px] z-10"
              title="Drag to resize the Scenes panel"
            />
          </div>

          {/* Grid */}
          <div className="flex-1 overflow-auto bg-bg p-4">
            <div data-hide-in-show="true" className="flex items-center gap-2 mb-3">
              <span className="label">Scene steps</span>
              <BoundedNumberInput
                className="input w-16 text-[12px] py-0.5"
                value={sequenceLength}
                onChange={(v) => setSequenceLength(v)}
                min={1}
                max={128}
                integer
              />
              <span className="text-muted text-[11px]">/ 128</span>
              <div className="flex-1" />
              <button
                className={`btn ${clearMode ? 'bg-danger text-black border-danger' : ''}`}
                onClick={() => setClearMode((v) => !v)}
              >
                {clearMode ? 'Click slots to clear' : 'Clear mode'}
              </button>
              {/* Timeline: each occupied slot becomes a proportional-
                  width block (flex: durationSec). Read-only view; drop
                  back to the grid to edit. */}
              <button
                className={`btn ${timelineMode ? 'bg-accent text-black border-accent' : ''}`}
                onClick={() => setTimelineMode(!timelineMode)}
                title="Visualise the sequence as a duration-proportional timeline"
              >
                {timelineMode ? 'Timeline ✓' : 'Timeline'}
              </button>
            </div>
            {timelineMode ? (
              <SequenceTimeline
                visible={visible}
                sceneById={sceneById}
                activeSceneId={activeSceneId}
                activeSlotIdx={activeSlotIdx}
              />
            ) : (
              <div
                className="grid gap-1"
                style={{ gridTemplateColumns: `repeat(${cols}, minmax(${cellMinPx}px, 1fr))` }}
              >
                {visible.map((sceneId, i) => (
                  <SlotCell
                    key={i}
                    index={i}
                    scene={sceneId ? sceneById(sceneId) : undefined}
                    // Only the source slot lights up. When the scene
                    // was fired from the palette / MIDI / external
                    // (activeSlotIdx === null), no slot highlights —
                    // scenes placed multiple times in the sequence no
                    // longer all light up at once. The palette pill
                    // remains the "this scene is playing" indicator
                    // for those external triggers.
                    active={
                      activeSceneId === sceneId && activeSlotIdx === i
                    }
                    onClear={clearMode ? () => setSequenceSlot(i, null) : undefined}
                  />
                ))}
              </div>
            )}
          </div>
        </div>

        {/* StatusBar removed — transport now lives globally at the bottom
            of App.tsx (see TransportBar) so it's also visible in Edit view. */}
      </div>

      {/* Drag preview — floats with the cursor during drag, so the user
          can see the scene they're moving before dropping it. The overlay
          is portaled by dnd-kit to document.body, so it doesn't get
          clipped by the column / grid overflow. */}
      <DragOverlay dropAnimation={null}>
        {(() => {
          const s = draggedScene()
          if (!s) return null
          // No minWidth — let the overlay hug its content the same way
          // the source PaletteItem does (truncate / fit-content).
          // dnd-kit auto-sizes the overlay box to the source element,
          // but the inner JSX still has to mimic the source styling so
          // the visual matches in either context (grid slot vs palette).
          return (
            <div
              className="px-2 py-1.5 rounded border text-[12px] font-medium shadow-lg cursor-grabbing whitespace-nowrap"
              style={{
                borderColor: s.color,
                background: s.color + '44',
                color: 'rgb(var(--c-text))'
              }}
            >
              {s.name}
            </div>
          )
        })()}
      </DragOverlay>

      {sceneMenu && (
        <SceneContextMenu
          sceneId={sceneMenu.sceneId}
          x={sceneMenu.x}
          y={sceneMenu.y}
          onClose={() => setSceneMenu(null)}
        />
      )}
      {sectionMenu && (
        <SceneSectionMenu
          x={sectionMenu.x}
          y={sectionMenu.y}
          onClose={() => setSectionMenu(null)}
        />
      )}
      {slotMenu && (
        <SceneSlotContextMenu
          slotIdx={slotMenu.slotIdx}
          sceneId={slotMenu.sceneId}
          x={slotMenu.x}
          y={slotMenu.y}
          onClose={() => setSlotMenu(null)}
        />
      )}
    </DndContext>
  )
}

// Section menu for the Scenes palette empty area. Two items:
//   Add Scene   — single-shot, calls addScene().
//   Add Scenes… — prompts for a count, calls addScenes(N). Clamped
//                 against the 128 cap by the store action.
function SceneSectionMenu({
  x,
  y,
  onClose
}: {
  x: number
  y: number
  onClose: () => void
}): JSX.Element {
  const addScene = useStore((s) => s.addScene)
  const addScenes = useStore((s) => s.addScenes)
  useEffect(() => {
    const close = (): void => onClose()
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('mousedown', close)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', close)
      window.removeEventListener('keydown', onKey)
    }
  }, [onClose])
  return createPortal(
    <div
      className="fixed z-50 bg-panel border border-border rounded shadow-lg py-1 text-[12px] min-w-[180px]"
      style={{ left: x, top: y }}
      onMouseDown={(e) => e.stopPropagation()}
    >
      <button
        className="w-full text-left px-3 py-1 hover:bg-panel2"
        onClick={() => {
          onClose()
          addScene()
        }}
      >
        Add Scene
      </button>
      <button
        className="w-full text-left px-3 py-1 hover:bg-panel2"
        onClick={() => {
          onClose()
          const raw = prompt('Create how many scenes?', '8')
          if (raw === null) return
          const n = Math.floor(Number(raw))
          if (!Number.isFinite(n) || n <= 0) return
          addScenes(n)
        }}
      >
        Add Scenes…
      </button>
    </div>,
    document.body
  )
}

// Right-click menu for scenes — single component used from both the
// palette (via prop callback) and the slot grid (via CustomEvent).
// Menu items: "Arm as next" toggles the armed cue; "Delete Scene"
// confirms before removing.
// Follow-action option list — shared between every context menu
// that exposes "Set Follow Action". Order matches the Scene
// Inspector dropdown; "stop" is first (default), then loop, then
// linear-step actions, then random.
const FOLLOW_ACTIONS: { id: NextMode; label: string }[] = [
  { id: 'stop', label: 'Stop' },
  { id: 'loop', label: 'Loop' },
  { id: 'next', label: 'Next' },
  { id: 'prev', label: 'Previous' },
  { id: 'first', label: 'First' },
  { id: 'last', label: 'Last' },
  { id: 'any', label: 'Any' },
  { id: 'other', label: 'Other' }
]

function useCloseOnOutside(onClose: () => void): void {
  useEffect(() => {
    const close = (): void => onClose()
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('mousedown', close)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', close)
      window.removeEventListener('keydown', onKey)
    }
  }, [onClose])
}

function SceneContextMenu({
  sceneId,
  x,
  y,
  onClose
}: {
  sceneId: string
  x: number
  y: number
  onClose: () => void
}): JSX.Element | null {
  const scene = useStore((s) => s.session.scenes.find((sc) => sc.id === sceneId))
  const isArmed = useStore((s) => s.armedSceneId === sceneId)
  const setArmedSceneId = useStore((s) => s.setArmedSceneId)
  const removeScene = useStore((s) => s.removeScene)
  const removeScenes = useStore((s) => s.removeScenes)
  const updateScene = useStore((s) => s.updateScene)
  // If the right-clicked scene is part of an active multi-selection,
  // every action — Arm, Set Follow Action, Delete — acts on the
  // whole set. Otherwise it acts on just this scene.
  const selectedSceneIds = useStore((s) => s.selectedSceneIds)
  const bulkTargets =
    selectedSceneIds.length > 1 && selectedSceneIds.includes(sceneId)
      ? selectedSceneIds
      : null
  useCloseOnOutside(onClose)
  if (!scene) return null
  function applyFollowAction(mode: NextMode): void {
    if (bulkTargets) {
      bulkTargets.forEach((id) => updateScene(id, { nextMode: mode }))
    } else {
      updateScene(sceneId, { nextMode: mode })
    }
    onClose()
  }
  return createPortal(
    <div
      className="fixed z-50 bg-panel border border-border rounded shadow-lg py-1 text-[12px] min-w-[180px]"
      style={{ left: x, top: y }}
      onMouseDown={(e) => e.stopPropagation()}
    >
      <button
        className="w-full text-left px-3 py-1 hover:bg-panel2"
        onClick={() => {
          setArmedSceneId(isArmed ? null : sceneId)
          onClose()
        }}
      >
        {isArmed ? 'Disarm' : 'Arm as next'}
      </button>
      <div className="border-t border-border my-1" />
      <FollowActionSubmenu
        currentMode={bulkTargets ? null : scene.nextMode}
        label={
          bulkTargets
            ? `Set Follow Action (${bulkTargets.length} scenes)`
            : 'Set Follow Action'
        }
        onPick={applyFollowAction}
      />
      <div className="border-t border-border my-1" />
      <button
        className="w-full text-left px-3 py-1 hover:bg-panel2 text-danger"
        onClick={() => {
          onClose()
          if (bulkTargets) {
            const n = bulkTargets.length
            if (confirm(`Delete ${n} scenes?`)) removeScenes(bulkTargets)
          } else {
            if (confirm(`Delete scene "${scene.name}"?`)) removeScene(sceneId)
          }
        }}
      >
        {bulkTargets ? `Delete ${bulkTargets.length} scenes` : 'Delete Scene'}
      </button>
    </div>,
    document.body
  )
}

// Slot-grid / Timeline right-click menu — only Clear Slot + Set
// Follow Action. Distinct from the palette/timeline-segment scene
// menu because slot-targeted actions are positional ("clear THIS
// slot from the sequence", not "delete the scene from the palette").
function SceneSlotContextMenu({
  slotIdx,
  sceneId,
  x,
  y,
  onClose
}: {
  slotIdx: number
  sceneId: string
  x: number
  y: number
  onClose: () => void
}): JSX.Element | null {
  const scene = useStore((s) => s.session.scenes.find((sc) => sc.id === sceneId))
  const setSequenceSlot = useStore((s) => s.setSequenceSlot)
  const updateScene = useStore((s) => s.updateScene)
  // If the right-clicked slot is part of an active slot multi-
  // selection, every action acts on the whole set: Clear Scene
  // empties every selected slot, Set Follow Action applies to every
  // scene that occupies one. Otherwise we fall back to single-slot
  // behavior.
  const sequence = useStore((s) => s.session.sequence)
  const selectedSlots = useStore((s) => s.selectedSequenceSlots)
  const slots =
    selectedSlots.length > 1 && selectedSlots.includes(slotIdx) ? selectedSlots : null
  // Distinct scene ids covered by the selected slots — used for the
  // bulk Set Follow Action update so we touch each scene once.
  const targetSceneIds = slots
    ? Array.from(new Set(slots.map((i) => sequence[i]).filter((id): id is string => !!id)))
    : [sceneId]
  useCloseOnOutside(onClose)
  if (!scene) return null
  return createPortal(
    <div
      className="fixed z-50 bg-panel border border-border rounded shadow-lg py-1 text-[12px] min-w-[200px]"
      style={{ left: x, top: y }}
      onMouseDown={(e) => e.stopPropagation()}
    >
      <button
        className="w-full text-left px-3 py-1 hover:bg-panel2"
        onClick={() => {
          if (slots) {
            for (const i of slots) setSequenceSlot(i, null)
          } else {
            setSequenceSlot(slotIdx, null)
          }
          onClose()
        }}
        title={
          slots
            ? `Clear ${slots.length} slots`
            : 'Remove this scene from the slot (the scene itself stays in the palette)'
        }
      >
        {slots ? `Clear Scene from ${slots.length} slots` : `Clear Scene from slot ${slotIdx + 1}`}
      </button>
      <div className="border-t border-border my-1" />
      <FollowActionSubmenu
        currentMode={slots ? null : scene.nextMode}
        label={
          slots
            ? `Set Follow Action (${targetSceneIds.length} scenes)`
            : 'Set Follow Action'
        }
        onPick={(mode) => {
          for (const id of targetSceneIds) updateScene(id, { nextMode: mode })
          onClose()
        }}
      />
    </div>,
    document.body
  )
}

// Inline submenu component used inside multiple context menus. Hover
// the parent row to reveal the Follow Action options to the right.
// `currentMode` shows a check next to the active option; pass null
// when applying to a multi-selection (no single "current" exists).
function FollowActionSubmenu({
  currentMode,
  label,
  onPick
}: {
  currentMode: NextMode | null
  label: string
  onPick: (mode: NextMode) => void
}): JSX.Element {
  const [hover, setHover] = useState(false)
  return (
    <div
      className="relative"
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
    >
      <button className="w-full text-left px-3 py-1 hover:bg-panel2 flex items-center justify-between">
        <span>{label}</span>
        <span className="text-muted">▸</span>
      </button>
      {hover && (
        <div
          className="absolute left-full top-0 -mt-1 ml-px bg-panel border border-border rounded shadow-lg py-1 min-w-[140px]"
          onMouseDown={(e) => e.stopPropagation()}
        >
          {FOLLOW_ACTIONS.map((m) => (
            <button
              key={m.id}
              className="w-full text-left px-3 py-1 hover:bg-panel2 flex items-center justify-between"
              onClick={() => onPick(m.id)}
            >
              <span>{m.label}</span>
              {currentMode === m.id && <span className="text-accent">✓</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

// Adaptive scene palette. Auto-fills as many columns as the panel
// width allows (each pill hugs its own text), so resizing the
// palette horizontally adds columns rather than scrolling. No
// vertical scrollbar — flowing rows/columns are how more scenes get
// shown. `auto-flow: row` + `min-content` rows keeps scene 1 at the
// top-left and continues left-to-right then wraps.
function PaletteGrid({
  scenes,
  focusedSceneId
}: {
  scenes: Scene[]
  focusedSceneId: string | null
}): JSX.Element {
  function onPaletteContextMenu(sceneId: string, e: React.MouseEvent): void {
    e.preventDefault()
    window.dispatchEvent(
      new CustomEvent('dataflou:scene-menu', {
        detail: { sceneId, x: e.clientX, y: e.clientY }
      })
    )
  }
  function onSectionContextMenu(e: React.MouseEvent): void {
    e.preventDefault()
    window.dispatchEvent(
      new CustomEvent('dataflou:scene-section-menu', {
        detail: { x: e.clientX, y: e.clientY }
      })
    )
  }
  // Click on the blank palette area (not on a pill — pills
  // stopPropagation onClick) clears the scene selection and the
  // focused scene so the inspector falls back to its empty state.
  // Per-pill clicks set the focus directly via setFocusedScene.
  function onBlankClick(e: React.MouseEvent): void {
    if (e.target !== e.currentTarget) return
    const st = useStore.getState()
    st.setFocusedScene(null)
    st.setSelectedSequenceSlot(null)
  }
  return (
    <div
      className="flex-1 min-h-0 overflow-y-auto p-2 flex flex-wrap items-start content-start gap-1"
      onContextMenu={onSectionContextMenu}
      onClick={onBlankClick}
    >
      {scenes.map((s) => (
        <PaletteItem
          key={s.id}
          scene={s}
          focused={s.id === focusedSceneId}
          onContextMenu={(e) => {
            // Stop the section-menu wrapper from firing when the
            // right-click landed on a pill — the per-scene menu wins.
            e.stopPropagation()
            onPaletteContextMenu(s.id, e)
          }}
        />
      ))}
    </div>
  )
}

// Timeline visualisation — each non-null sequence slot renders as a
// flex item whose width is proportional to the scene's durationSec.
// Empty slots are skipped (a 0-second blank in a duration timeline
// would just be invisible). Click a segment to highlight it; the
// segment that's CURRENTLY playing (matched by activeSlotIdx, the
// engine's source-slot tracker) gets a separate accent ring.
function SequenceTimeline({
  visible,
  sceneById,
  activeSceneId,
  activeSlotIdx
}: {
  visible: (string | null)[]
  sceneById: (id: string) => Scene | undefined
  activeSceneId: string | null
  activeSlotIdx: number | null
}): JSX.Element {
  const selectedSlots = useStore((s) => s.selectedSequenceSlots)
  const selectedSlot = useStore((s) => s.selectedSequenceSlot)
  const setSelectedSlot = useStore((s) => s.setSelectedSequenceSlot)
  const selectSlotRange = useStore((s) => s.selectSequenceSlotRange)
  const setFocusedScene = useStore((s) => s.setFocusedScene)
  const occupied = visible
    .map((sceneId, i) => ({ sceneId, i, scene: sceneId ? sceneById(sceneId) : undefined }))
    .filter((e): e is { sceneId: string; i: number; scene: Scene } => !!e.scene)
  if (occupied.length === 0) {
    return (
      <div className="text-muted text-[11px] p-3">
        Timeline is empty — drop scenes into the grid first, then re-enable Timeline.
      </div>
    )
  }
  const totalSec = occupied.reduce((sum, e) => sum + e.scene.durationSec, 0)
  return (
    <div className="flex flex-col gap-2">
      <div className="text-muted text-[10px]">
        Total: {totalSec.toFixed(1)}s · {occupied.length} scene{occupied.length === 1 ? '' : 's'}
      </div>
      <div className="flex gap-[2px] h-14 rounded overflow-hidden border border-border">
        {occupied.map(({ sceneId, i, scene }) => (
          <TimelineSegment
            key={i}
            slotIdx={i}
            scene={scene}
            active={activeSceneId === sceneId && activeSlotIdx === i}
            highlighted={selectedSlots.includes(i)}
            onClick={(e) => {
              if (e.shiftKey) {
                selectSlotRange(i)
                return
              }
              if (selectedSlot === i) {
                setSelectedSlot(null)
                return
              }
              setSelectedSlot(i)
              setFocusedScene(sceneId)
            }}
            onContextMenu={(e) => {
              e.preventDefault()
              window.dispatchEvent(
                new CustomEvent('dataflou:scene-slot-menu', {
                  detail: { slotIdx: i, sceneId, x: e.clientX, y: e.clientY }
                })
              )
            }}
          />
        ))}
      </div>
    </div>
  )
}

// One segment in the Timeline strip. Renders the scene's name, a
// duration badge in the top-right, and a live elapsed/remaining
// counter while the segment is the active source. Counter ticks
// only while active so 100 idle segments don't spawn intervals.
function TimelineSegment({
  slotIdx,
  scene,
  active,
  highlighted,
  onClick,
  onContextMenu
}: {
  slotIdx: number
  scene: Scene
  active: boolean
  highlighted: boolean
  onClick: (e: React.MouseEvent) => void
  onContextMenu: (e: React.MouseEvent) => void
}): JSX.Element {
  const playing = useStore((s) => s.engine.activeSceneId === scene.id)
  const { remainingMs, progress } = useSceneCountdown(scene.id, scene.durationSec)
  return (
    <div
      onClick={onClick}
      onContextMenu={onContextMenu}
      className={`relative flex items-center justify-center px-2 text-[11px] font-medium overflow-hidden cursor-pointer ${
        active
          ? 'ring-2 ring-accent ring-inset'
          : highlighted
            ? 'ring-2 ring-text/40 ring-inset'
            : ''
      }`}
      style={{
        flex: scene.durationSec,
        background: scene.color + '55',
        borderLeft: `3px solid ${scene.color}`,
        color: 'rgb(var(--c-text))'
      }}
      title={`${scene.name} — ${scene.durationSec}s (slot ${slotIdx + 1})`}
    >
      {/* Progress fill — orange wash from left to right while the
          scene is playing. Shown on EVERY instance of the active
          scene, not just the source slot, so the user sees the
          countdown wherever the scene is placed. The accent ring
          (above) still only marks the source slot. */}
      {playing && (
        <div
          className="absolute left-0 top-0 bottom-0 pointer-events-none"
          style={{
            width: `${progress * 100}%`,
            background: 'rgb(var(--c-accent) / 0.35)',
            transition: 'width 50ms linear'
          }}
          aria-hidden
        />
      )}
      <span className="relative z-10 truncate">{scene.name}</span>
      <span className="absolute top-[2px] right-1 text-[8px] text-muted tabular-nums z-10">
        {scene.durationSec}s
      </span>
      {playing && (
        <span className="absolute bottom-[2px] right-1 text-[9px] font-mono tabular-nums text-accent z-10">
          {formatRemaining(remainingMs)}
        </span>
      )}
    </div>
  )
}

function PaletteItem({
  scene,
  focused,
  onContextMenu
}: {
  scene: Scene
  focused: boolean
  onContextMenu: (e: React.MouseEvent) => void
}): JSX.Element {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: `scene-${scene.id}`
  })
  const setFocusedScene = useStore((s) => s.setFocusedScene)
  const selectSceneRange = useStore((s) => s.selectSceneRange)
  const selectedSceneIds = useStore((s) => s.selectedSceneIds)
  const isArmed = useStore((s) => s.armedSceneId === scene.id)
  // Live countdown while this pill is the engine's active scene.
  const { active, remainingMs, progress } = useSceneCountdown(scene.id, scene.durationSec)
  // Highlight if part of the multi-selection (same logic as SceneColumn).
  const inMulti = selectedSceneIds.length > 0 && selectedSceneIds.includes(scene.id)
  const highlighted = inMulti || (selectedSceneIds.length === 0 && focused)
  return (
    <div
      ref={setNodeRef}
      {...attributes}
      {...listeners}
      onClick={(e) => {
        // Alt-click arms this scene as the next cue (toggle).
        if (e.altKey) {
          const cur = useStore.getState().armedSceneId
          useStore.getState().setArmedSceneId(cur === scene.id ? null : scene.id)
          return
        }
        // Shift-click extends the multi-selection from the current anchor.
        if (e.shiftKey) selectSceneRange(scene.id)
        else setFocusedScene(scene.id)
      }}
      onContextMenu={onContextMenu}
      className={`relative px-2 py-1.5 rounded border cursor-pointer text-[12px] overflow-hidden ${
        isDragging ? 'opacity-50 cursor-grab' : ''
      } ${highlighted ? 'ring-2 ring-accent' : ''}`}
      // A scene inside the multi-selection gets a deeper tint so the set
      // reads at a glance in the palette.
      style={{
        borderColor: scene.color,
        background: scene.color + (highlighted ? '33' : '1a')
      }}
      title="Click: select · Shift-click: extend · Alt-click: arm · Right-click: menu"
    >
      {isArmed && <div className="armed-ring absolute inset-0 pointer-events-none" />}
      {isArmed && <span className="armed-chevron" aria-hidden>▶▶</span>}
      {/* Scene-duration progress strip along the bottom edge of the pill.
          Only rendered while this scene is actively playing. Accent orange
          matches the trigger-square "playing" color. Thin (2 px) so it
          doesn't compete with the armed-ring (blue) visually. */}
      {active && (
        <div
          className="absolute left-0 bottom-0 h-[2px] pointer-events-none"
          style={{
            width: `${progress * 100}%`,
            background: 'rgb(var(--c-accent))',
            transition: 'width 50ms linear'
          }}
          aria-hidden
        />
      )}
      <div className="flex items-center gap-1.5 min-w-0">
        <span className="font-medium truncate flex-1">{scene.name}</span>
        {active && (
          <span
            className="text-[10px] font-mono tabular-nums text-accent shrink-0"
            title="Time remaining in this scene's duration"
          >
            {formatRemaining(remainingMs)}
          </span>
        )}
      </div>
    </div>
  )
}

/**
 * Scene info / edit panel. Shown in the Sequence view when a scene is focused
 * (clicked in the palette or in a sequencer slot). Lets the user edit name /
 * color / notes / duration / nextMode and delete the scene. Pressing the
 * Delete key with the view focused on a scene (handled in App.tsx globally)
 * also deletes the scene.
 */
function SceneInfoPanel({ scene }: { scene: Scene }): JSX.Element {
  const updateScene = useStore((s) => s.updateScene)
  const removeScene = useStore((s) => s.removeScene)
  const showMode = useStore((s) => s.showMode)
  // After a scene is dropped into a Scene Step, SequenceView bumps
  // this token so the Duration input below grabs focus and selects
  // its content. The user can then type a fresh number without
  // clicking — typical "just landed it, now set the timing" flow.
  const focusDurationToken = useStore((s) => s.focusDurationToken)
  const messageCount = Object.keys(scene.cells).length
  const nextModes: { id: NextMode; label: string }[] = [
    { id: 'stop', label: 'Stop' },
    { id: 'loop', label: 'Loop' },
    { id: 'next', label: 'Next' },
    { id: 'prev', label: 'Previous' },
    { id: 'first', label: 'First' },
    { id: 'last', label: 'Last' },
    { id: 'any', label: 'Any' },
    { id: 'other', label: 'Other' }
  ]
  return (
    <fieldset
      disabled={showMode}
      className="p-3 flex flex-col gap-3 text-[12px] border-0 m-0 min-w-0"
    >
      <div className="flex items-center justify-between">
        <span className="label">Scene</span>
        {!showMode && (
          <button
            className="btn text-[11px] py-0.5"
            style={{ borderColor: 'rgb(var(--c-danger))', color: 'rgb(var(--c-danger))' }}
            onClick={() => {
              if (confirm(`Delete scene "${scene.name}"? This cannot be undone.`)) {
                removeScene(scene.id)
              }
            }}
            title="Delete scene (or press Delete key)"
          >
            Delete
          </button>
        )}
      </div>

      <div className="flex items-center gap-2">
        <input
          type="color"
          className="w-7 h-7 rounded border border-border bg-transparent cursor-pointer shrink-0"
          value={scene.color}
          onChange={(e) => updateScene(scene.id, { color: e.target.value })}
          title="Scene color"
        />
        <input
          className="input flex-1 min-w-0 text-[13px] font-medium"
          value={scene.name}
          onChange={(e) => updateScene(scene.id, { name: e.target.value })}
          placeholder="Scene name"
        />
      </div>

      <div className="flex flex-col gap-1">
        <span className="label">Notes</span>
        <textarea
          className="input text-[12px] resize-none"
          rows={3}
          value={scene.notes}
          onChange={(e) => updateScene(scene.id, { notes: e.target.value })}
          placeholder="Free-form notes"
        />
      </div>

      <div className="flex items-center gap-3">
        <div className="flex items-center gap-1.5">
          <span className="label">Dur</span>
          <BoundedNumberInput
            className="input w-16 text-[12px] py-0.5"
            value={scene.durationSec}
            onChange={(v) => updateScene(scene.id, { durationSec: v })}
            min={0.5}
            max={300}
            autoFocusToken={focusDurationToken}
          />
          <span className="text-muted text-[11px]">s</span>
        </div>

        <div className="flex items-center gap-1.5">
          <span className="label">Next</span>
          <select
            className="input text-[12px] py-0.5 min-w-[96px]"
            value={scene.nextMode}
            onChange={(e) => updateScene(scene.id, { nextMode: e.target.value as NextMode })}
          >
            {nextModes.map((m) => (
              <option key={m.id} value={m.id}>
                {m.label}
              </option>
            ))}
          </select>
        </div>

        {/* Multiplicator — only exposed here (Sequence-tab inspector) per
            the design. Engine replays the scene this many times before the
            follow action fires. 1 = classic behavior (advance after one play). */}
        <div className="flex items-center gap-1.5">
          <span className="label" title="How many times the scene plays before Next triggers">
            ×
          </span>
          <BoundedNumberInput
            className="input w-12 text-[12px] py-0.5"
            value={scene.multiplicator}
            onChange={(v) => updateScene(scene.id, { multiplicator: v })}
            min={1}
            max={128}
            integer
            title="Multiplicator: how many times the scene plays before the follow action fires (1–128)"
          />
        </div>
      </div>

      {/* Per-scene Morph-in override. Leave blank (empty field) to fall
          back to the transport-level Morph; set a number (incl. 0) to
          pin THIS scene's glide-in duration regardless of transport. */}
      <div className="flex items-center gap-2">
        <span
          className="label"
          title="Morph-in: when this scene is triggered, glide every cell over this duration. Overrides the transport Morph setting. Leave blank to follow transport."
        >
          Morph-in
        </span>
        <input
          className="input w-20 text-[12px] py-0.5"
          type="text"
          inputMode="numeric"
          placeholder="(transport)"
          value={scene.morphInMs !== undefined ? String(scene.morphInMs) : ''}
          onChange={(e) => {
            const raw = e.target.value.trim()
            if (raw === '') {
              updateScene(scene.id, { morphInMs: undefined })
              return
            }
            const n = Number(raw)
            if (!Number.isFinite(n)) return
            updateScene(scene.id, {
              morphInMs: Math.max(0, Math.min(300000, Math.floor(n)))
            })
          }}
        />
        <span className="text-muted text-[11px]">ms</span>
      </div>

      <div className="flex items-center gap-2">
        <span className="label">Messages</span>
        <span className="text-muted">
          {messageCount} message{messageCount === 1 ? '' : 's'} defined
        </span>
      </div>

      <div className="flex items-center gap-2 text-[11px] text-muted">
        <span>Tip: switch to the Edit view (Tab) to edit this scene's clips.</span>
      </div>
    </fieldset>
  )
}

function SlotCell({
  index,
  scene,
  active,
  onClear
}: {
  index: number
  scene: Scene | undefined
  active: boolean
  onClear?: () => void
}): JSX.Element {
  const { setNodeRef: setDropRef, isOver } = useDroppable({ id: `slot-${index}` })
  const {
    attributes,
    listeners,
    setNodeRef: setDragRef,
    isDragging
  } = useDraggable({ id: `slot-${index}`, disabled: !scene })
  const setFocusedScene = useStore((s) => s.setFocusedScene)
  const setSelectedSlot = useStore((s) => s.setSelectedSequenceSlot)
  const selectedSlot = useStore((s) => s.selectedSequenceSlot)
  const selectedSlots = useStore((s) => s.selectedSequenceSlots)
  const selectSlotRange = useStore((s) => s.selectSequenceSlotRange)
  const isArmed = useStore((s) => !!scene && s.armedSceneId === scene.id)
  const slotSelected = selectedSlots.includes(index)

  function setRef(n: HTMLDivElement | null): void {
    setDropRef(n)
    setDragRef(n)
  }

  return (
    <div
      ref={setRef}
      {...(scene ? attributes : {})}
      {...(scene ? listeners : {})}
      onClick={
        scene
          ? onClear
            ? onClear
            : (e) => {
                // Alt-click arms the scene occupying this slot.
                if (e.altKey) {
                  const cur = useStore.getState().armedSceneId
                  useStore.getState().setArmedSceneId(cur === scene.id ? null : scene.id)
                  return
                }
                // Shift-click extends a slot-range selection from
                // the current anchor — bulk follow-action edits +
                // batch slot operations work off this set. The
                // separate `selectSceneRange` (palette pill scope)
                // is left alone so the two views can have
                // independent selections.
                if (e.shiftKey) {
                  selectSlotRange(index)
                  return
                }
                // Plain click — focus the scene in the inspector AND
                // mark this slot as the "selected" sequence position
                // so Transport Play knows where to start. Toggle off
                // if the same slot is already selected.
                setFocusedScene(scene.id)
                setSelectedSlot(slotSelected && selectedSlot === index ? null : index)
              }
          : undefined
      }
      onContextMenu={
        scene
          ? (e) => {
              // Slot-cell right-click opens a SLOT menu — distinct
              // from the palette/timeline scene menu — with Clear
              // Scene + Set Follow Action only. The two surfaces
              // (slot grid + palette) act on the same scene id but
              // have different action verbs.
              e.preventDefault()
              window.dispatchEvent(
                new CustomEvent('dataflou:scene-slot-menu', {
                  detail: { slotIdx: index, sceneId: scene.id, x: e.clientX, y: e.clientY }
                })
              )
            }
          : undefined
      }
      title={
        scene
          ? 'Click: focus · Shift-click: extend selection · Alt-click: arm · Right-click: menu'
          : undefined
      }
      className={`relative h-12 rounded border text-[10px] flex flex-col items-center justify-center overflow-hidden ${
        isOver ? 'border-accent' : scene ? '' : 'border-border bg-panel/30'
      } ${active ? 'ring-2 ring-accent' : slotSelected ? 'ring-2 ring-text/40' : ''} ${
        isDragging ? 'opacity-50' : ''
      } ${
        onClear && scene ? 'cursor-pointer hover:brightness-75' : scene ? 'cursor-grab' : ''
      }`}
      style={scene ? { background: scene.color + '33', borderColor: scene.color } : undefined}
    >
      {isArmed && <div className="armed-ring absolute inset-0 pointer-events-none" />}
      {isArmed && <span className="armed-chevron" aria-hidden>▶▶</span>}
      {scene && <SlotProgressFill scene={scene} />}
      <div className="absolute top-0 left-0.5 text-[8px] text-muted z-10">{index + 1}</div>
      {scene && (
        <div className="font-medium truncate max-w-full px-1 relative z-10">{scene.name}</div>
      )}
    </div>
  )
}

// Live progress fill shown on every slot whose scene is the active
// scene — paints the pill orange from left to right over the scene's
// durationSec. Independent of `active` (which is "this is the
// SOURCE slot"); the fill shows on every visual instance of the
// playing scene so the user sees what's happening even when they
// fired the scene from the palette / a follow action and no source
// slot was tracked. useSceneCountdown is gated on activeSceneId so
// 100 idle slots cost nothing — only the playing one ticks.
function SlotProgressFill({ scene }: { scene: Scene }): JSX.Element | null {
  const playing = useStore((s) => s.engine.activeSceneId === scene.id)
  const { progress } = useSceneCountdown(scene.id, scene.durationSec)
  if (!playing) return null
  return (
    <div
      className="absolute left-0 top-0 bottom-0 pointer-events-none"
      style={{
        width: `${progress * 100}%`,
        background: 'rgb(var(--c-accent) / 0.35)',
        transition: 'width 50ms linear'
      }}
      aria-hidden
    />
  )
}
