// Global transport bar — always visible at the bottom of the app, in both
// Edit and Sequence views, and in show mode. Holds:
//   • Play / Pause / Stop buttons (fire the active scene; identical semantics
//     to the old StatusBar that lived inside SequenceView).
//   • "Selected" scene readout (name + color + message count).
//   • Edit ↔ Sequence view toggle (visible everywhere including show mode
//     so a performer can flip to the other view during a show).
//   • Running HH:MM:SS:MS time counter (Play starts/resumes, Pause freezes,
//     Stop resets). Purely a performance-timing display — doesn't drive the
//     engine, which has its own per-scene duration timer.

import { useEffect, useState } from 'react'
import { useStore } from '../store'
import { formatRemaining, useSceneCountdown } from '../hooks/useSceneCountdown'
import { BoundedNumberInput } from './BoundedNumberInput'

export default function TransportBar(): JSX.Element {
  const session = useStore((s) => s.session)
  const focusedSceneId = session.focusedSceneId
  const focusedScene = session.scenes.find((s) => s.id === focusedSceneId) ?? null
  const activeSceneId = useStore((s) => s.engine.activeSceneId)
  const paused = useStore((s) => s.sequencePaused)
  const setPaused = useStore((s) => s.setSequencePaused)

  const transportPlay = useStore((s) => s.transportPlay)
  const transportPause = useStore((s) => s.transportPause)
  const transportStop = useStore((s) => s.transportStop)

  const trackCountInFocused = focusedScene
    ? Object.keys(focusedScene.cells).length
    : 0

  async function onPlay(): Promise<void> {
    if (paused && activeSceneId) {
      await window.api.resumeSequence()
      setPaused(false)
      transportPlay()
      return
    }
    const st = useStore.getState()
    // In the Sequence view, Play is a SEQUENCE TRANSPORT button, not
    // a scene trigger. The selected sequence slot (set by clicking a
    // slot or Timeline segment) becomes the start point; otherwise
    // the sequence starts from the first non-empty slot. The
    // currently-focused scene is no longer used as a start point —
    // Play in Sequence view should never fire whatever the inspector
    // happens to be displaying.
    if (st.view === 'sequence') {
      const seq = session.sequence
      const seqLen = session.sequenceLength
      const sel = st.selectedSequenceSlot
      let startSlot: number | null = null
      if (sel !== null && sel >= 0 && sel < seqLen && seq[sel]) {
        startSlot = sel
      } else {
        const idx = seq.findIndex((id, i) => i < seqLen && !!id)
        startSlot = idx >= 0 ? idx : null
      }
      if (startSlot !== null) {
        const sceneId = seq[startSlot]
        if (sceneId) {
          st.triggerSceneWithMorph(sceneId, startSlot)
          setPaused(false)
          transportPlay()
        }
      }
      return
    }
    // Edit view — keep the legacy "play focused scene" behavior so
    // the user can audition a single scene without leaving Edit.
    let startId = focusedSceneId
    if (!startId) {
      const first = session.sequence.find((id) => !!id) ?? null
      startId = first
    }
    if (startId) {
      st.triggerSceneWithMorph(startId)
      setPaused(false)
      transportPlay()
    }
  }

  async function onPause(): Promise<void> {
    await window.api.pauseSequence()
    setPaused(true)
    transportPause()
  }

  async function onStop(): Promise<void> {
    await window.api.stopAll()
    setPaused(false)
    transportStop()
    // Drop the slot selection on Stop so the next Play starts from
    // the beginning, matching the user's "transport reset" mental
    // model. The focused scene (inspector) is left alone.
    useStore.getState().setSelectedSequenceSlot(null)
  }

  return (
    <div className="relative border-t border-border bg-panel px-3 py-2 flex items-center gap-3 text-[12px] shrink-0">
      <MorphProgressBar />
      {/* Active-state coloring:
            Play  — grey by default, accent (orange) only while a scene is
                    actively playing (not paused). Mirrors the TopBar's
                    "playing" semantics.
            Pause — grey by default, accent2 (blue) while in pause —
                    matches the "⏸ paused" readout further right.
            Stop  — always grey; resets the transport time too.
      */}
      {(() => {
        const playing = !!activeSceneId && !paused
        return (
          <div className="flex items-center gap-1">
            <button
              className={`w-8 h-7 flex items-center justify-center rounded-sm border ${
                playing
                  ? 'bg-accent border-accent text-black'
                  : 'bg-panel2 border-border text-muted hover:text-text'
              }`}
              onClick={onPlay}
              title={
                paused
                  ? 'Resume'
                  : 'Play sequence (from selected slot, or from the start)'
              }
            >
              <svg width="10" height="10" viewBox="0 0 10 10">
                <polygon points="2,1 9,5 2,9" fill="currentColor" />
              </svg>
            </button>
            <button
              className={`w-8 h-7 flex items-center justify-center rounded-sm border ${
                paused
                  ? 'border-accent2 text-accent2 bg-panel2'
                  : 'bg-panel2 border-border text-muted hover:text-text'
              }`}
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
        )
      })()}

      <div className="h-6 w-px bg-border" />

      {/* Cue section — GO button fires the armed scene; Spacebar is the
          keyboard twin. "Next" toggle auto-arms the following non-empty
          sequence slot after each GO (turns a linear show into a single-
          finger walkthrough). */}
      <CueGoSection />

      <div className="h-6 w-px bg-border" />

      {/* Morph section — per-trigger glide from scene-to-scene. When on,
          every scene fire morphs every cell (and fades orphans) over the
          configured duration. Per-scene morphInMs (set in the Sequence
          view's SceneInfoPanel) takes precedence. */}
      <MorphSection />

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
            <span className="text-muted shrink-0">
              · {trackCountInFocused} message{trackCountInFocused === 1 ? '' : 's'}
            </span>
          </>
        ) : (
          <span className="text-muted">(none)</span>
        )}
      </div>

      <div className="flex-1" />

      <div className="flex items-center gap-2 text-muted">
        {activeSceneId && !paused && <span className="text-accent">● playing</span>}
        {paused && <span className="text-accent2">⏸ paused</span>}
        {/* Live countdown on the currently-playing scene. Reads from the
            engine's active-scene-started-at timestamp; hides when nothing
            is playing or the sequence is paused (duration is frozen). */}
        {activeSceneId && !paused && <ActiveSceneCountdown sceneId={activeSceneId} />}
      </div>

      <div className="h-6 w-px bg-border" />

      <TransportTime />
    </div>
  )
}

// Running HH:MM:SS:MS counter + live remaining-time-in-scene readout.
// Pulls transport state from the store on every ~50 ms tick while
// running so the millisecond field actually animates; otherwise only
// re-renders when play/pause/stop mutate the store. The scene-time
// readout sits right next to the main Time so the performer can see
// both together without hunting around the bar.
function TransportTime(): JSX.Element {
  const startedAt = useStore((s) => s.transportStartedAt)
  const accumulated = useStore((s) => s.transportAccumulatedMs)
  const activeSceneId = useStore((s) => s.engine.activeSceneId)
  const running = startedAt !== null
  // Local "now" bumped on a timer while running. Not stored in the global
  // store because it'd trigger a 20Hz re-render of everything subscribed.
  const [now, setNow] = useState<number>(() => Date.now())
  useEffect(() => {
    if (!running) return
    const id = setInterval(() => setNow(Date.now()), 50)
    return () => clearInterval(id)
  }, [running])

  const elapsed = running ? accumulated + (now - (startedAt as number)) : accumulated
  return (
    <div className="flex items-center gap-2 shrink-0">
      <div className="flex items-center gap-1.5">
        <span className="label">Time</span>
        <span
          className={`font-mono tabular-nums text-[12px] ${
            running ? 'text-accent' : 'text-muted'
          }`}
          title="HH:MM:SS:MS — runs on Play, pauses on Pause, resets on Stop"
        >
          {formatHHMMSSMS(elapsed)}
        </span>
      </div>
      {activeSceneId && <ActiveSceneRemaining sceneId={activeSceneId} />}
    </div>
  )
}

// Live remaining-time on the currently-playing scene, rendered as
// "Scene 1.2s left". Uses the shared useSceneCountdown which reads
// engine.pausedAt — when pause is on, the countdown freezes at the
// pause moment instead of continuing to tick.
function ActiveSceneRemaining({ sceneId }: { sceneId: string }): JSX.Element | null {
  const scene = useStore((s) => s.session.scenes.find((sc) => sc.id === sceneId))
  const durationSec = scene?.durationSec ?? 0
  const { active, remainingMs } = useSceneCountdown(sceneId, durationSec)
  if (!active || !scene) return null
  return (
    <div
      className="flex items-center gap-1.5 px-2 py-0.5 rounded border"
      style={{
        borderColor: scene.color,
        background: scene.color + '22'
      }}
      title={`Scene "${scene.name}" — time remaining in its duration`}
    >
      <span
        className="w-2 h-2 rounded-full shrink-0"
        style={{ background: scene.color }}
        aria-hidden
      />
      <span className="font-mono tabular-nums text-[12px] text-accent">
        {formatRemaining(remainingMs)}
      </span>
    </div>
  )
}

// GO button + auto-advance arm toggle. Sits in the middle of the transport
// bar alongside play/pause/stop so performers have one logical "cue + fire"
// cluster. GO is disabled when nothing is armed.
function CueGoSection(): JSX.Element {
  const armedSceneId = useStore((s) => s.armedSceneId)
  const armedScene = useStore((s) =>
    armedSceneId ? s.session.scenes.find((sc) => sc.id === armedSceneId) ?? null : null
  )
  const autoAdvance = useStore((s) => s.autoAdvanceArm)
  const setAutoAdvance = useStore((s) => s.setAutoAdvanceArm)
  const fireArmed = useStore((s) => s.fireArmed)
  const hasArm = !!armedSceneId

  // MIDI learn wiring — clicking GO while in learn mode picks it as the
  // target; the next MIDI message binds. Right-click clears a binding.
  const learnMode = useStore((s) => s.midiLearnMode)
  const learnTarget = useStore((s) => s.midiLearnTarget)
  const setLearnTarget = useStore((s) => s.setMidiLearnTarget)
  const goMidi = useStore((s) => s.session.goMidi)
  const setGoMidi = useStore((s) => s.setGoMidi)
  const learnSelected = learnMode && learnTarget?.kind === 'go'
  const learnOverlay = learnMode
    ? learnSelected
      ? 'midi-learn-selected'
      : goMidi
        ? 'midi-learn-green'
        : 'midi-learn-blue'
    : ''

  return (
    <div className="flex items-center gap-1 shrink-0">
      <button
        className={`relative h-7 px-3 rounded-sm border font-semibold text-[12px] tracking-wide ${
          hasArm
            ? 'border-accent2 text-accent2 bg-panel2 hover:bg-accent2 hover:text-black'
            : 'border-border text-muted cursor-not-allowed opacity-60'
        }`}
        onClick={() => {
          // In learn mode, click picks GO as the target instead of firing.
          if (learnMode) {
            setLearnTarget({ kind: 'go' })
            return
          }
          if (hasArm) fireArmed()
        }}
        onContextMenu={(e) => {
          // Right-click in learn mode clears any existing binding.
          if (!learnMode || !goMidi) return
          e.preventDefault()
          setGoMidi(undefined)
        }}
        disabled={!learnMode && !hasArm}
        title={
          learnMode
            ? goMidi
              ? `MIDI: ${bindingLabel(goMidi)} — click to re-bind · right-click to clear`
              : 'Click to select GO, then send a MIDI message to bind'
            : hasArm
              ? `GO — fire "${armedScene?.name ?? 'armed scene'}" (also Space)`
              : 'No scene armed — Alt-click / right-click / press A to arm'
        }
      >
        GO
        {learnOverlay && (
          <div className={`midi-learn-overlay ${learnOverlay}`} aria-hidden />
        )}
      </button>
      {goMidi && !learnMode && (
        <span
          className="text-[9px] font-mono px-1 py-0 rounded border shrink-0"
          style={{
            color: 'rgb(var(--c-accent2))',
            borderColor: 'rgb(var(--c-accent2))'
          }}
          title={`MIDI: ${bindingLabel(goMidi)}`}
        >
          {bindingShort(goMidi)}
        </span>
      )}
      {hasArm && armedScene && (
        <div
          className="flex items-center gap-1 text-[10px] text-muted max-w-[140px] truncate"
          title={`Armed: ${armedScene.name}`}
        >
          <span
            className="inline-block w-2 h-2 rounded-sm shrink-0"
            style={{ background: armedScene.color }}
          />
          <span className="truncate">{armedScene.name}</span>
        </div>
      )}
      <label
        className="flex items-center gap-1 text-[10px] text-muted cursor-pointer ml-1 select-none"
        title="After firing the armed scene, auto-arm the next non-empty slot in the sequence"
      >
        <input
          type="checkbox"
          checked={autoAdvance}
          onChange={(e) => setAutoAdvance(e.target.checked)}
        />
        <span>Next</span>
      </label>
    </div>
  )
}

// Transport-level Morph knob — a single glide-duration for scene triggers.
// Off by default (snaps, same as classic behavior). When on, the engine
// override kicks in for every scene fire: cells morph from their current
// output to the new target over `morphMs`, and orphan tracks (active in
// the previous scene but absent from the new one) fade to 0 over the same
// duration. Per-scene overrides still win (see SceneInfoPanel).
function MorphSection(): JSX.Element {
  const enabled = useStore((s) => s.morphEnabled)
  const setEnabled = useStore((s) => s.setMorphEnabled)
  const ms = useStore((s) => s.morphMs)
  const setMs = useStore((s) => s.setMorphMs)

  // MIDI learn wiring — the ms INPUT itself is the learn target (clicking
  // the Morph toggle is reserved for enabling the feature). The second
  // button below accepts the learn click.
  const learnMode = useStore((s) => s.midiLearnMode)
  const learnTarget = useStore((s) => s.midiLearnTarget)
  const setLearnTarget = useStore((s) => s.setMidiLearnTarget)
  const midi = useStore((s) => s.session.morphTimeMidi)
  const setMidi = useStore((s) => s.setMorphTimeMidi)
  const learnSelected = learnMode && learnTarget?.kind === 'morphTime'
  const learnOverlay = learnMode
    ? learnSelected
      ? 'midi-learn-selected'
      : midi
        ? 'midi-learn-green'
        : 'midi-learn-blue'
    : ''

  return (
    <div className="flex items-center gap-1 shrink-0">
      <button
        className={`h-7 px-2 rounded-sm border text-[11px] ${
          enabled
            ? 'border-accent2 text-accent2 bg-panel2'
            : 'border-border text-muted'
        }`}
        onClick={() => setEnabled(!enabled)}
        title={
          enabled
            ? 'Morph enabled — scene triggers glide over the duration to the right'
            : 'Morph disabled — scene triggers snap to their new values'
        }
      >
        Morph
      </button>
      {/* The ms field itself is not clickable-to-learn (would break the
          bounded-number-input click-to-edit behavior). Instead, a tiny
          adjacent "M" button is the learn target when learn mode is on,
          hidden otherwise. In normal mode a small CC chip shows what's
          bound (parallel pattern to the MetaKnob CC chip). */}
      <div className="relative">
        <BoundedNumberInput
          className={`input w-16 text-[11px] py-0.5 ${enabled ? '' : 'opacity-60'}`}
          value={ms}
          min={0}
          max={300000}
          integer
          onChange={(v) => setMs(v)}
          title="Scene-to-scene morph duration (ms). 0–300 000. Bind a CC via the M button to sweep it live."
        />
      </div>
      <span className="text-[10px] text-muted">ms</span>
      {learnMode ? (
        <button
          className={`relative h-7 w-5 text-[10px] rounded-sm border shrink-0 ${
            learnSelected ? 'bg-panel2' : ''
          }`}
          onClick={() => setLearnTarget({ kind: 'morphTime' })}
          onContextMenu={(e) => {
            if (!midi) return
            e.preventDefault()
            setMidi(undefined)
          }}
          title={
            midi
              ? `MIDI: ${bindingLabel(midi)} — click to re-bind · right-click to clear`
              : 'Click to select Morph time as learn target, then send a CC to bind'
          }
        >
          M
          {learnOverlay && (
            <div className={`midi-learn-overlay ${learnOverlay}`} aria-hidden />
          )}
        </button>
      ) : (
        midi && (
          <span
            className="text-[9px] font-mono px-1 py-0 rounded border shrink-0"
            style={{
              color: 'rgb(var(--c-accent2))',
              borderColor: 'rgb(var(--c-accent2))'
            }}
            title={`MIDI: ${bindingLabel(midi)} (0..127 → 0..10 000 ms)`}
          >
            {bindingShort(midi)}
          </span>
        )
      )}
    </div>
  )
}

// Human-readable labels for a MidiBinding. `bindingLabel` is for tooltips
// (full info), `bindingShort` for compact chips.
// Live-countdown badge for the transport-bar "● playing" strip. Looks up
// the active scene in the session to read its duration, then uses the
// shared useSceneCountdown hook to self-tick.
function ActiveSceneCountdown({ sceneId }: { sceneId: string }): JSX.Element | null {
  const scene = useStore((s) => s.session.scenes.find((sc) => sc.id === sceneId))
  const durationSec = scene?.durationSec ?? 0
  const { active, remainingMs } = useSceneCountdown(sceneId, durationSec)
  if (!active || !scene) return null
  return (
    <span
      className="text-accent font-mono tabular-nums text-[11px]"
      title={`Scene "${scene.name}" — time remaining in its duration`}
    >
      {formatRemaining(remainingMs)} left
    </span>
  )
}

function bindingLabel(b: {
  kind: 'note' | 'cc'
  channel: number
  number: number
}): string {
  const prefix = b.kind === 'cc' ? `CC ${b.number}` : `Note ${b.number}`
  return `${prefix} · ch ${b.channel + 1}`
}
function bindingShort(b: {
  kind: 'note' | 'cc'
  channel: number
  number: number
}): string {
  return b.kind === 'cc' ? `CC${b.number}` : `N${b.number}`
}

// Thin progress bar along the top of the TransportBar while a Morph is in
// flight. Blue (accent2) to distinguish from "playing" (orange / accent).
// Computes elapsed locally — the engine doesn't expose per-morph progress
// but the renderer knows both triggeredAt and the duration that was in
// effect when it fired, which is enough.
function MorphProgressBar(): JSX.Element | null {
  const activeSceneId = useStore((s) => s.engine.activeSceneId)
  const activeSceneStartedAt = useStore((s) => s.engine.activeSceneStartedAt)
  // Resolve the morph that WOULD apply to this scene right now. This is an
  // approximation — if the user changed transport Morph mid-flight, the
  // engine's actual in-flight duration may differ — but it's close enough
  // for a UI indicator.
  const resolved = useStore((s) =>
    activeSceneId ? s.resolveMorphMs(activeSceneId) : undefined
  )
  const [nowMs, setNowMs] = useState<number>(() => Date.now())
  const active =
    activeSceneId !== null &&
    activeSceneStartedAt !== null &&
    typeof resolved === 'number' &&
    resolved > 0 &&
    nowMs - activeSceneStartedAt < resolved
  useEffect(() => {
    if (!active) return
    const id = setInterval(() => setNowMs(Date.now()), 33)
    return () => clearInterval(id)
  }, [active])
  if (!active || typeof resolved !== 'number' || resolved <= 0) return null
  const elapsed = nowMs - (activeSceneStartedAt as number)
  const pct = Math.max(0, Math.min(1, elapsed / resolved))
  return (
    <div
      className="absolute top-0 left-0 h-[2px] pointer-events-none"
      style={{
        width: `${pct * 100}%`,
        background: 'rgb(var(--c-accent2))',
        transition: 'width 33ms linear'
      }}
      aria-hidden
    />
  )
}

function formatHHMMSSMS(ms: number): string {
  const total = Math.max(0, Math.floor(ms))
  const msPart = total % 1000
  const sTotal = Math.floor(total / 1000)
  const s = sTotal % 60
  const mTotal = Math.floor(sTotal / 60)
  const m = mTotal % 60
  const h = Math.floor(mTotal / 60)
  const pad2 = (n: number): string => String(n).padStart(2, '0')
  const pad3 = (n: number): string => String(n).padStart(3, '0')
  return `${pad2(h)}:${pad2(m)}:${pad2(s)}:${pad3(msPart)}`
}
