// 128-step drag-drop matrix + bottom transport/status bar.

import { useState } from 'react'
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
  const focusedSceneId = useStore((s) => s.session.focusedSceneId)
  const focusedScene = scenes.find((s) => s.id === focusedSceneId) ?? null
  const paletteWidth = useStore((s) => s.scenePaletteWidth)
  const setPaletteWidth = useStore((s) => s.setScenePaletteWidth)

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }))

  const [clearMode, setClearMode] = useState(false)
  // Tracks what's currently being dragged so <DragOverlay> can render a
  // floating preview. Null when nothing is active. Strings are dnd-kit ids
  // like `scene-<id>` (palette → slot) or `slot-<N>` (slot → slot swap).
  const [activeDragId, setActiveDragId] = useState<string | null>(null)
  const visible = sequence.slice(0, sequenceLength)
  const cols = Math.min(16, Math.max(1, sequenceLength))

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
      const sceneId = activeId.slice(6)
      setSequenceSlot(overIdx, sceneId)
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
            <div className="px-3 py-2 border-b border-border label shrink-0">
              Scenes ({scenes.length})
            </div>
            {/* items-start on the flex column makes each palette pill hug
                its own text (instead of stretching to full column width).
                Short names → tiny pills, long names → wider — naturally
                adaptive per scene. */}
            <div className="flex-1 min-h-0 overflow-y-auto p-2 flex flex-col items-start gap-1">
              {scenes.map((s) => (
                <PaletteItem key={s.id} scene={s} focused={s.id === focusedSceneId} />
              ))}
            </div>
            {focusedScene && (
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
              max={480}
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
            </div>
            <div
              className="grid gap-1"
              style={{ gridTemplateColumns: `repeat(${cols}, minmax(52px, 1fr))` }}
            >
              {visible.map((sceneId, i) => (
                <SlotCell
                  key={i}
                  index={i}
                  scene={sceneId ? sceneById(sceneId) : undefined}
                  active={activeSceneId === sceneId}
                  onClear={clearMode ? () => setSequenceSlot(i, null) : undefined}
                />
              ))}
            </div>
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
          return (
            <div
              className="px-2 py-1.5 rounded border text-[12px] font-medium shadow-lg cursor-grabbing"
              style={{
                borderColor: s.color,
                background: s.color + '44',
                color: 'rgb(var(--c-text))',
                minWidth: 140
              }}
            >
              {s.name}
            </div>
          )
        })()}
      </DragOverlay>
    </DndContext>
  )
}

function StatusBar(): JSX.Element {
  const session = useStore((s) => s.session)
  const focusedSceneId = session.focusedSceneId
  const focusedScene = session.scenes.find((s) => s.id === focusedSceneId) ?? null
  const activeSceneId = useStore((s) => s.engine.activeSceneId)
  const paused = useStore((s) => s.sequencePaused)
  const setPaused = useStore((s) => s.setSequencePaused)

  const trackCountInFocused = focusedScene
    ? Object.keys(focusedScene.cells).length
    : 0

  async function onPlay(): Promise<void> {
    if (paused && activeSceneId) {
      await window.api.resumeSequence()
      setPaused(false)
      return
    }
    // Start from focused scene if present, else first non-empty sequence slot.
    let startId = focusedSceneId
    if (!startId) {
      const first = session.sequence.find((id) => !!id) ?? null
      startId = first
    }
    if (startId) {
      useStore.getState().triggerSceneWithMorph(startId)
      setPaused(false)
    }
  }

  async function onPause(): Promise<void> {
    await window.api.pauseSequence()
    setPaused(true)
  }

  async function onStop(): Promise<void> {
    await window.api.stopAll()
    setPaused(false)
  }

  return (
    <div className="border-t border-border bg-panel px-3 py-2 flex items-center gap-3 text-[12px] shrink-0">
      <div className="flex items-center gap-1">
        <button
          className="btn-accent w-8 h-7 flex items-center justify-center"
          onClick={onPlay}
          title={paused ? 'Resume' : 'Play focused scene'}
        >
          <svg width="10" height="10" viewBox="0 0 10 10">
            <polygon points="2,1 9,5 2,9" fill="currentColor" />
          </svg>
        </button>
        <button
          className="btn w-8 h-7 flex items-center justify-center"
          onClick={onPause}
          title="Pause auto-advance (cells keep playing)"
          disabled={!activeSceneId || paused}
        >
          <svg width="10" height="10" viewBox="0 0 10 10">
            <rect x="2" y="1" width="2" height="8" fill="currentColor" />
            <rect x="6" y="1" width="2" height="8" fill="currentColor" />
          </svg>
        </button>
        <button
          className="btn w-8 h-7 flex items-center justify-center"
          onClick={onStop}
          title="Stop all"
        >
          <svg width="10" height="10" viewBox="0 0 10 10">
            <rect x="1" y="1" width="8" height="8" fill="currentColor" />
          </svg>
        </button>
      </div>

      <div className="h-6 w-px bg-border" />

      <div className="flex items-center gap-2 min-w-0">
        <span className="label shrink-0">Selected</span>
        {focusedScene ? (
          <>
            <span
              className="inline-block w-2.5 h-2.5 rounded-sm shrink-0"
              style={{ background: focusedScene.color }}
            />
            <span className="font-medium truncate">{focusedScene.name}</span>
            <span className="text-muted shrink-0">· {trackCountInFocused} message{trackCountInFocused === 1 ? '' : 's'}</span>
          </>
        ) : (
          <span className="text-muted">(none)</span>
        )}
      </div>

      <div className="flex-1" />

      <div className="flex items-center gap-2 text-muted">
        {activeSceneId && !paused && <span className="text-accent">● playing</span>}
        {paused && <span className="text-accent2">⏸ paused</span>}
      </div>
    </div>
  )
}

function PaletteItem({ scene, focused }: { scene: Scene; focused: boolean }): JSX.Element {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: `scene-${scene.id}`
  })
  const setFocusedScene = useStore((s) => s.setFocusedScene)
  const selectSceneRange = useStore((s) => s.selectSceneRange)
  const selectedSceneIds = useStore((s) => s.selectedSceneIds)
  const isArmed = useStore((s) => s.armedSceneId === scene.id)
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
      onContextMenu={(e) => {
        e.preventDefault()
        const cur = useStore.getState().armedSceneId
        useStore.getState().setArmedSceneId(cur === scene.id ? null : scene.id)
      }}
      className={`relative px-2 py-1.5 rounded border cursor-pointer text-[12px] ${
        isDragging ? 'opacity-50 cursor-grab' : ''
      } ${highlighted ? 'ring-2 ring-accent' : ''}`}
      // A scene inside the multi-selection gets a deeper tint so the set
      // reads at a glance in the palette.
      style={{
        borderColor: scene.color,
        background: scene.color + (highlighted ? '33' : '1a')
      }}
      title="Click: select · Shift-click: extend · Alt-click / right-click: arm as next cue"
    >
      {isArmed && <div className="armed-ring absolute inset-0 pointer-events-none" />}
      {isArmed && <span className="armed-chevron" aria-hidden>▶▶</span>}
      <span className="font-medium">{scene.name}</span>
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
          />
          <span className="text-muted text-[11px]">s</span>
        </div>

        <div className="flex items-center gap-1.5">
          <span className="label">Next</span>
          <select
            className="input text-[12px] py-0.5"
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
  const selectSceneRange = useStore((s) => s.selectSceneRange)
  const isArmed = useStore((s) => !!scene && s.armedSceneId === scene.id)

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
                // Shift-click extends the scene multi-selection from the
                // anchor — handy for bulk operations from the grid too.
                if (e.shiftKey) selectSceneRange(scene.id)
                else setFocusedScene(scene.id)
              }
          : undefined
      }
      onContextMenu={
        scene
          ? (e) => {
              e.preventDefault()
              const cur = useStore.getState().armedSceneId
              useStore.getState().setArmedSceneId(cur === scene.id ? null : scene.id)
            }
          : undefined
      }
      title={
        scene
          ? 'Click: focus · Shift-click: extend selection · Alt-click / right-click: arm as next cue'
          : undefined
      }
      className={`relative h-12 rounded border text-[10px] flex flex-col items-center justify-center ${
        isOver ? 'border-accent' : scene ? '' : 'border-border bg-panel/30'
      } ${active ? 'ring-2 ring-accent' : ''} ${isDragging ? 'opacity-50' : ''} ${
        onClear && scene ? 'cursor-pointer hover:brightness-75' : scene ? 'cursor-grab' : ''
      }`}
      style={scene ? { background: scene.color + '33', borderColor: scene.color } : undefined}
    >
      {isArmed && <div className="armed-ring absolute inset-0 pointer-events-none" />}
      {isArmed && <span className="armed-chevron" aria-hidden>▶▶</span>}
      <div className="absolute top-0 left-0.5 text-[8px] text-muted">{index + 1}</div>
      {scene && <div className="font-medium truncate max-w-full px-1">{scene.name}</div>}
    </div>
  )
}
