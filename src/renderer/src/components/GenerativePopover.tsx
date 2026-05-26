// Generative Scene Sequencer button + popover (v0.5.10). Lives at
// the top of the Scene Inspector area in the Sequence view.
//
// Layout:
//   [ GENERATIVE on/off | ▾ chevron ]   <- the button row
//
// Clicking the chevron opens a popover with:
//   - Pool Source dropdown (All / Timeline-only)
//   - Per-scene checklist with Select all / none
//   - Selection Mode dropdown (Random / Drift / Surprise / Shuffle / Custom)
//   - Affinity slider (bipolar -100 Contrast .. +100 Coherence)
//   - No-Repeat toggle
//   - Shuffle Cycle toggle (visible when in Custom)
//   - Min / Max duration sliders + editable float boxes
//   - Use Morph toggle
//   - Random Weights button
//
// All seven learnable controls can be right-clicked OR clicked while
// MIDI Learn mode is on to arm a binding. The pattern mirrors the
// existing GO / morphTime / scene-trigger learn flow.

import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useStore } from '../store'
import { BoundedNumberInput } from './BoundedNumberInput'
import {
  GENERATIVE_AFFINITY_MAX,
  GENERATIVE_AFFINITY_MIN,
  GENERATIVE_DURATION_MAX_MS,
  GENERATIVE_DURATION_MIN_MS,
  type GenerativeMode,
  type GenerativePoolSource
} from '@shared/types'
import { DEFAULT_GENERATIVE_CONFIG } from '@shared/factory'

// MIDI Learn target tags that the popover surfaces. Right-clicking
// or clicking-while-learn-on arms the matching target; matched-on-
// incoming MIDI writes the binding into session.generative.
type LearnKind =
  | 'generativeToggle'
  | 'generativeNoRepeat'
  | 'generativeAffinity'
  | 'generativeMinDuration'
  | 'generativeMaxDuration'
  | 'generativeUseMorph'
  | 'generativeRandomWeights'

// Helper hook: returns a stable handler that arms the given learn
// target on right-click or click-while-learn-mode-on. Suppresses the
// browser's native context menu so the right-click doesn't pop the
// system menu instead.
function useArmLearn(
  kind: LearnKind
): {
  onContextMenu: (e: React.MouseEvent) => void
  onMouseDown: (e: React.MouseEvent) => void
  armed: boolean
} {
  const learnMode = useStore((s) => s.midiLearnMode)
  const learnTarget = useStore((s) => s.midiLearnTarget)
  const setLearnTarget = useStore((s) => s.setMidiLearnTarget)
  const setLearnMode = useStore((s) => s.setMidiLearnMode)
  const armed =
    learnMode && learnTarget !== null && learnTarget.kind === kind
  return {
    onContextMenu: (e) => {
      e.preventDefault()
      setLearnMode(true)
      setLearnTarget({ kind })
    },
    onMouseDown: (e) => {
      // Only intercept the LEFT click WHEN learn mode is already on
      // -- right-click is handled by onContextMenu above. This lets
      // the L hotkey + click-anywhere flow work consistently.
      if (e.button !== 0) return
      if (!learnMode) return
      e.preventDefault()
      e.stopPropagation()
      setLearnTarget({ kind })
    },
    armed
  }
}

// Persisted popover position (localStorage). Saved on drag-end so a
// reload restores the window where the user last parked it. null /
// missing = "anchor below the button row" (default first-open
// behaviour). Stored as JSON {x, y}.
const POPOVER_POS_KEY = 'dataflou.generativePopoverPos'
function loadPopoverPos(): { x: number; y: number } | null {
  try {
    const raw = localStorage.getItem(POPOVER_POS_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as unknown
    if (
      parsed &&
      typeof parsed === 'object' &&
      typeof (parsed as { x: unknown }).x === 'number' &&
      typeof (parsed as { y: unknown }).y === 'number'
    ) {
      return parsed as { x: number; y: number }
    }
  } catch {
    /* ignore malformed JSON or no localStorage */
  }
  return null
}
function savePopoverPos(p: { x: number; y: number }): void {
  try {
    localStorage.setItem(POPOVER_POS_KEY, JSON.stringify(p))
  } catch {
    /* ignore localStorage failures */
  }
}

// Standalone GENERATIVE pill button + adjacent chevron. The pill
// toggles the master flag; the chevron opens the popover. Pill has
// a live dot indicator (off / on / active-playing) and is itself
// MIDI-learnable via right-click.
//
// Popover open state lives in the store (UI-only, not persisted with
// the session) so the global G hotkey in App.tsx can toggle it from
// anywhere. Popover position is persisted in localStorage so the
// user's chosen drag spot survives a reload.
export function GenerativeButton(): JSX.Element {
  const gen = useStore(
    (s) => s.session.generative ?? DEFAULT_GENERATIVE_CONFIG
  )
  const setEnabled = useStore((s) => s.setGenerativeEnabled)
  const open = useStore((s) => s.generativePopoverOpen)
  const setOpen = useStore((s) => s.setGenerativePopoverOpen)
  const buttonRowRef = useRef<HTMLDivElement | null>(null)
  const popoverRef = useRef<HTMLDivElement | null>(null)
  // Position state. null = "use the button-row anchor" (first open
  // after fresh app load with no saved pos, OR after the user
  // explicitly resets via the Reset button in the title bar). Set to
  // a {x, y} via drag or by restoring from localStorage on first
  // mount.
  const [position, setPosition] = useState<{ x: number; y: number } | null>(
    () => loadPopoverPos()
  )
  const [anchor, setAnchor] = useState<{ x: number; y: number } | null>(null)
  // Drag state. While dragging, every mousemove updates `position`.
  // Captures the offset between the cursor and the popover's
  // top-left so the popover follows the cursor naturally instead of
  // jumping to position the corner at the cursor.
  const dragRef = useRef<{ dx: number; dy: number } | null>(null)

  // Compute the button-anchor on open + on window resize -- used
  // ONLY when `position` is null (first-time or after Reset).
  useEffect(() => {
    if (!open || !buttonRowRef.current) return
    if (position !== null) return // user has dragged -- skip auto-anchor
    const update = (): void => {
      const rect = buttonRowRef.current!.getBoundingClientRect()
      setAnchor({ x: rect.left, y: rect.bottom + 4 })
    }
    update()
    window.addEventListener('resize', update)
    return () => window.removeEventListener('resize', update)
  }, [open, position])

  // Click-outside + Escape to close. The G hotkey also toggles via
  // setOpen; we intentionally don't intercept it here so the
  // App-level handler stays the single source of truth.
  useEffect(() => {
    if (!open) return
    function onDown(e: MouseEvent): void {
      const t = e.target as Node | null
      if (!t) return
      if (buttonRowRef.current?.contains(t)) return
      if (popoverRef.current?.contains(t)) return
      setOpen(false)
    }
    function onKey(e: KeyboardEvent): void {
      if (e.key === 'Escape') setOpen(false)
    }
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey)
    }
  }, [open, setOpen])

  // Drag handlers. Installed only while dragging so we don't pay for
  // a global mousemove listener when the popover is idle.
  useEffect(() => {
    if (!dragRef.current) return
    function onMove(e: MouseEvent): void {
      if (!dragRef.current) return
      // Clamp to keep the popover at least partially on-screen
      // (16px margin) so it can't be dragged completely off the
      // edge into oblivion.
      const w = popoverRef.current?.offsetWidth ?? 340
      const h = popoverRef.current?.offsetHeight ?? 200
      const maxX = window.innerWidth - 32
      const maxY = window.innerHeight - 32
      const x = Math.max(-(w - 32), Math.min(maxX, e.clientX - dragRef.current.dx))
      const y = Math.max(8, Math.min(maxY, e.clientY - dragRef.current.dy))
      setPosition({ x, y })
    }
    function onUp(): void {
      // Persist final position so a reload puts the window back
      // where the user dropped it.
      if (popoverRef.current) {
        const rect = popoverRef.current.getBoundingClientRect()
        savePopoverPos({ x: rect.left, y: rect.top })
      }
      dragRef.current = null
      // Force a re-render so the effect cleanup fires and removes
      // the listeners until the next drag.
      setPosition((p) => (p ? { ...p } : null))
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    return () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
    // Re-run when position changes only to capture the post-drag
    // listener cleanup; dragRef.current presence gates the effect.
  }, [position])

  const toggleLearn = useArmLearn('generativeToggle')
  const dotColor = gen.enabled
    ? 'rgb(var(--c-accent))'
    : 'rgb(var(--c-muted) / 0.4)'
  // Final on-screen position: persisted/dragged position wins;
  // anchor is the fallback for first-open with no saved pos.
  const effectivePos = position ?? anchor
  return (
    <div
      ref={buttonRowRef}
      className="px-2 py-1.5 border-b border-border shrink-0 flex items-center gap-1"
    >
      <button
        className={`flex-1 flex items-center justify-center gap-1.5 px-2 py-1 rounded border text-[11px] font-semibold tracking-wider uppercase transition-colors ${
          gen.enabled
            ? 'bg-accent text-black border-accent'
            : 'bg-panel2 hover:bg-panel3 border-border text-text'
        } ${toggleLearn.armed ? 'ring-2 ring-accent2 animate-pulse' : ''}`}
        onClick={() => {
          if (useStore.getState().midiLearnMode) return
          setEnabled(!gen.enabled)
        }}
        onMouseDown={toggleLearn.onMouseDown}
        onContextMenu={toggleLearn.onContextMenu}
        title={
          gen.enabled
            ? 'Generative ON - engine picks the next scene randomly from the pool. Right-click to MIDI Learn.'
            : 'Generative OFF - engine follows each scene\'s Follow Action as usual. Click to flip to generative; right-click to MIDI Learn.'
        }
      >
        <span
          className="inline-block w-2 h-2 rounded-full"
          style={{ background: dotColor }}
        />
        Generative
      </button>
      <button
        className={`btn text-[10px] py-0.5 px-1.5 shrink-0 ${
          open ? 'bg-panel3' : ''
        }`}
        onClick={() => setOpen(!open)}
        title="Generative settings (G to toggle): pool, mode, affinity, duration, weights"
      >
        ▾
      </button>
      {open &&
        effectivePos &&
        createPortal(
          <div
            ref={popoverRef}
            className="fixed z-50 bg-panel border border-border rounded shadow-lg text-[11px] flex flex-col"
            style={{
              left: Math.max(8, effectivePos.x),
              top: effectivePos.y,
              width: 340,
              maxHeight: 'calc(100vh - 80px)'
            }}
          >
            {/* Drag handle / title bar. Pressing here starts a drag;
                the close + reset buttons stop the mousedown from
                bubbling so they don't accidentally start a drag. */}
            <div
              className="flex items-center justify-between px-3 py-1.5 border-b border-border bg-panel2 rounded-t cursor-move select-none"
              onMouseDown={(e) => {
                if (e.button !== 0) return
                const rect = popoverRef.current?.getBoundingClientRect()
                if (!rect) return
                dragRef.current = {
                  dx: e.clientX - rect.left,
                  dy: e.clientY - rect.top
                }
                // Seed position so the drag handler has a valid
                // starting point (avoid undefined offset math when
                // position was null and the popover was rendered
                // via the auto-anchor).
                setPosition({ x: rect.left, y: rect.top })
              }}
              title="Drag to move. Right-click the X to reset to the default position next to the button."
            >
              <span className="font-semibold text-[12px]">
                Generative Settings
              </span>
              <div className="flex items-center gap-1">
                <button
                  className="text-muted hover:text-text text-[10px] px-1"
                  onMouseDown={(e) => e.stopPropagation()}
                  onClick={(e) => {
                    e.stopPropagation()
                    // Right-click on X would also fire onClick on
                    // some browsers; the second binding (oncontext)
                    // handles the reset explicitly.
                  }}
                  onContextMenu={(e) => {
                    e.preventDefault()
                    e.stopPropagation()
                    setPosition(null)
                    try {
                      localStorage.removeItem(POPOVER_POS_KEY)
                    } catch {
                      /* ignore */
                    }
                  }}
                  title="Right-click to reset position to default (next to the GENERATIVE button)"
                >
                  ⟲
                </button>
                <button
                  className="text-muted hover:text-text text-[12px] px-1"
                  onMouseDown={(e) => e.stopPropagation()}
                  onClick={() => setOpen(false)}
                  title="Close (Esc or G)"
                  aria-label="Close"
                >
                  ✕
                </button>
              </div>
            </div>
            <div className="p-3 flex flex-col gap-2.5 overflow-y-auto">
              <GenerativePopoverBody onClose={() => setOpen(false)} />
            </div>
          </div>,
          document.body
        )}
    </div>
  )
}

// Popover contents extracted as a sub-component so the parent can
// stay focused on positioning logic.
function GenerativePopoverBody({
  onClose
}: {
  onClose: () => void
}): JSX.Element {
  const gen = useStore(
    (s) => s.session.generative ?? DEFAULT_GENERATIVE_CONFIG
  )
  const scenes = useStore((s) => s.session.scenes)
  const setPoolSource = useStore((s) => s.setGenerativePoolSource)
  const setSceneInPool = useStore((s) => s.setSceneInPool)
  const selectAllScenesForPool = useStore((s) => s.selectAllScenesForPool)
  const setMode = useStore((s) => s.setGenerativeMode)
  const setAffinity = useStore((s) => s.setGenerativeAffinity)
  const setNoRepeat = useStore((s) => s.setGenerativeNoRepeat)
  const setShuffleCycle = useStore((s) => s.setGenerativeShuffleCycle)
  const setMinMs = useStore((s) => s.setGenerativeMinDurationMs)
  const setMaxMs = useStore((s) => s.setGenerativeMaxDurationMs)
  const setUseMorph = useStore((s) => s.setGenerativeUseMorph)
  const rollRandomWeights = useStore((s) => s.rollRandomWeights)

  const noRepeatLearn = useArmLearn('generativeNoRepeat')
  const affinityLearn = useArmLearn('generativeAffinity')
  const minLearn = useArmLearn('generativeMinDuration')
  const maxLearn = useArmLearn('generativeMaxDuration')
  const useMorphLearn = useArmLearn('generativeUseMorph')
  const randomWeightsLearn = useArmLearn('generativeRandomWeights')

  // Reference to keep the `onClose` prop satisfied even though the
  // new draggable title bar owns the close button. Calling onClose
  // when the user picks a value from the keyboard would be wrong --
  // we only close on the explicit X click or Escape.
  void onClose
  return (
    <>
      {/* ── Pool Source ───────────────────────────────────────────── */}
      <div className="flex items-center gap-2">
        <span className="label flex-1">Pool source</span>
        <select
          className="input text-[11px] py-0.5"
          value={gen.poolSource}
          onChange={(e) =>
            setPoolSource(e.target.value as GenerativePoolSource)
          }
          title="Which scenes are eligible. All = every scene in the session. Timeline = only scenes currently placed in the timeline grid."
        >
          <option value="all">All scenes</option>
          <option value="timeline">Timeline only</option>
        </select>
      </div>

      {/* ── Scene checklist ───────────────────────────────────────── */}
      <div className="flex flex-col gap-1 border border-border rounded p-1.5 bg-panel2">
        <div className="flex items-center justify-between">
          <span className="text-muted text-[10px] uppercase tracking-wide">
            Include scenes
          </span>
          <div className="flex gap-1">
            <button
              className="btn text-[9px] py-0 px-1 leading-tight"
              onClick={() => selectAllScenesForPool(true)}
              title="Include every scene in the pool"
            >
              All
            </button>
            <button
              className="btn text-[9px] py-0 px-1 leading-tight"
              onClick={() => selectAllScenesForPool(false)}
              title="Exclude every scene from the pool"
            >
              None
            </button>
          </div>
        </div>
        <div className="flex flex-col gap-0.5 max-h-32 overflow-y-auto">
          {scenes.length === 0 && (
            <span className="text-muted text-[10px] italic">No scenes yet.</span>
          )}
          {scenes.map((s) => {
            const inPool = gen.excluded[s.id] !== true
            return (
              <label
                key={s.id}
                className="flex items-center gap-1.5 cursor-pointer hover:bg-panel3 px-1 py-0.5 rounded"
              >
                <input
                  type="checkbox"
                  checked={inPool}
                  onChange={(e) => setSceneInPool(s.id, e.target.checked)}
                />
                <span
                  className="inline-block w-2 h-2 rounded-sm shrink-0"
                  style={{ background: s.color }}
                />
                <span className="truncate text-[10px]">{s.name}</span>
              </label>
            )
          })}
        </div>
      </div>

      {/* ── Selection Mode + Affinity ─────────────────────────────── */}
      <div className="flex items-center gap-2">
        <span className="label flex-1">Selection mode</span>
        <select
          className="input text-[11px] py-0.5"
          value={gen.mode}
          onChange={(e) => setMode(e.target.value as GenerativeMode)}
          title={
            'How scenes are picked from the pool:\n' +
            '  Random   - weight-biased random with No-Repeat\n' +
            '  Drift    - strongly biased toward similar scenes\n' +
            '  Surprise - strongly biased toward dissimilar scenes\n' +
            '  Shuffle  - every scene plays once before any repeats\n' +
            '  Custom   - you tweaked a knob away from a preset'
          }
        >
          <option value="random">Random</option>
          <option value="drift">Drift</option>
          <option value="surprise">Surprise</option>
          <option value="shuffle">Shuffle</option>
          <option value="custom">Custom</option>
        </select>
      </div>

      {/* Affinity slider (bipolar) */}
      <div
        className={`flex flex-col gap-1 ${affinityLearn.armed ? 'ring-2 ring-accent2 rounded animate-pulse p-1' : ''}`}
        onContextMenu={affinityLearn.onContextMenu}
        onMouseDown={affinityLearn.onMouseDown}
      >
        <div className="flex items-center justify-between text-[10px]">
          <span className="text-muted">Contrast</span>
          <span className="font-semibold tabular-nums">
            Affinity {gen.affinity > 0 ? '+' : ''}
            {Math.round(gen.affinity)}
          </span>
          <span className="text-muted">Coherence</span>
        </div>
        <input
          type="range"
          min={GENERATIVE_AFFINITY_MIN}
          max={GENERATIVE_AFFINITY_MAX}
          step={1}
          value={gen.affinity}
          onChange={(e) => setAffinity(parseFloat(e.target.value))}
          className="w-full"
          title="-100 = always pick most-different scene · 0 = ignore similarity · +100 = always pick most-similar scene. Right-click to MIDI Learn."
        />
      </div>

      {/* ── No-Repeat + Shuffle Cycle toggles ─────────────────────── */}
      <div className="flex items-center gap-3">
        <label
          className={`flex items-center gap-1.5 cursor-pointer ${noRepeatLearn.armed ? 'ring-2 ring-accent2 rounded animate-pulse px-1' : ''}`}
          onContextMenu={noRepeatLearn.onContextMenu}
          onMouseDown={noRepeatLearn.onMouseDown}
        >
          <input
            type="checkbox"
            checked={gen.noRepeat}
            onChange={(e) => setNoRepeat(e.target.checked)}
          />
          <span title="When ON, the same scene can never play twice in a row. Right-click to MIDI Learn.">
            No immediate repeat
          </span>
        </label>
        <label className="flex items-center gap-1.5 cursor-pointer">
          <input
            type="checkbox"
            checked={gen.shuffleCycle}
            onChange={(e) => setShuffleCycle(e.target.checked)}
          />
          <span title="When ON, every scene in the pool plays once before any can repeat. Automatically resets each cycle.">
            Shuffle cycle
          </span>
        </label>
      </div>

      {/* ── Min / Max duration ────────────────────────────────────── */}
      <div className="flex flex-col gap-1.5">
        <div
          className={`flex items-center gap-2 ${minLearn.armed ? 'ring-2 ring-accent2 rounded animate-pulse p-1' : ''}`}
          onContextMenu={minLearn.onContextMenu}
          onMouseDown={minLearn.onMouseDown}
        >
          <span className="label w-10 shrink-0">Min</span>
          <input
            type="range"
            min={GENERATIVE_DURATION_MIN_MS}
            max={GENERATIVE_DURATION_MAX_MS}
            step={100}
            value={gen.minDurationMs}
            onChange={(e) => setMinMs(parseFloat(e.target.value))}
            className="flex-1"
            title="Minimum auto-advance duration. Right-click to MIDI Learn."
          />
          <BoundedNumberInput
            className="input w-16 text-[10px] py-0 text-center tabular-nums"
            value={gen.minDurationMs / 1000}
            onChange={(v) => setMinMs(v * 1000)}
            min={GENERATIVE_DURATION_MIN_MS / 1000}
            max={GENERATIVE_DURATION_MAX_MS / 1000}
            step={0.1}
          />
          <span className="text-muted text-[9px] w-3 shrink-0">s</span>
        </div>
        <div
          className={`flex items-center gap-2 ${maxLearn.armed ? 'ring-2 ring-accent2 rounded animate-pulse p-1' : ''}`}
          onContextMenu={maxLearn.onContextMenu}
          onMouseDown={maxLearn.onMouseDown}
        >
          <span className="label w-10 shrink-0">Max</span>
          <input
            type="range"
            min={GENERATIVE_DURATION_MIN_MS}
            max={GENERATIVE_DURATION_MAX_MS}
            step={100}
            value={gen.maxDurationMs}
            onChange={(e) => setMaxMs(parseFloat(e.target.value))}
            className="flex-1"
            title="Maximum auto-advance duration. Right-click to MIDI Learn."
          />
          <BoundedNumberInput
            className="input w-16 text-[10px] py-0 text-center tabular-nums"
            value={gen.maxDurationMs / 1000}
            onChange={(v) => setMaxMs(v * 1000)}
            min={GENERATIVE_DURATION_MIN_MS / 1000}
            max={GENERATIVE_DURATION_MAX_MS / 1000}
            step={0.1}
          />
          <span className="text-muted text-[9px] w-3 shrink-0">s</span>
        </div>
      </div>

      {/* ── Use Morph + Random Weights ────────────────────────────── */}
      <div className="flex items-center justify-between gap-2">
        <label
          className={`flex items-center gap-1.5 cursor-pointer ${useMorphLearn.armed ? 'ring-2 ring-accent2 rounded animate-pulse px-1' : ''}`}
          onContextMenu={useMorphLearn.onContextMenu}
          onMouseDown={useMorphLearn.onMouseDown}
        >
          <input
            type="checkbox"
            checked={gen.useMorph}
            onChange={(e) => setUseMorph(e.target.checked)}
          />
          <span title="When ON, generative auto-advances glide between scenes (uses each scene's Morph In time, or 1500 ms default). When OFF, scenes snap. Right-click to MIDI Learn.">
            Use Morph
          </span>
        </label>
        <button
          className={`btn text-[10px] py-0.5 px-2 ${randomWeightsLearn.armed ? 'ring-2 ring-accent2 animate-pulse' : ''}`}
          onClick={() => rollRandomWeights()}
          onContextMenu={randomWeightsLearn.onContextMenu}
          onMouseDown={randomWeightsLearn.onMouseDown}
          title="Roll fresh random weights (1-10) into every scene. Right-click to MIDI Learn."
        >
          🎲 Random Weights
        </button>
      </div>
    </>
  )
}
