// Scene engine: per-track state machine + fixed-tick LFO + scene auto-advance.
//
// Playback model:
//  - Each Track has at most ONE active Cell at any time (across all scenes).
//  - Triggering a Cell:
//      * After its delayMs, morph the track's center value from whatever it is now
//        to the new Cell's value over transitionMs (linear). LFO phase for the track
//        continues uninterrupted.
//  - Stopping a Cell:
//      * Morph center from current → 0 over transitionMs, then disarm (no more OSC).
//  - Scene trigger: equivalent to triggering every non-empty cell in that column.
//  - Scene auto-advance: only driven by explicit scene triggers (individual cell
//    triggers do NOT start the scene duration timer). After durationSec, nextMode
//    picks the next scene (or off).

import type { Cell, EngineState, LfoShape, Modulation, Scene, Session } from '@shared/types'
import { META_KNOB_COUNT } from '@shared/types'
import {
  autoDetectOscArg,
  buildArpLadder,
  buildArpPattern,
  effectiveLfoHz,
  euclidean,
  hashSeedString,
  mulberry32,
  parseValueTokens,
  readNumber,
  scaleMetaValue
} from '@shared/factory'
import { OscSender, type OscErrorEvent, type OscSendEvent } from './osc'

type OscArg = { type: 'i' | 'f' | 's' | 'T' | 'F'; value: number | string | boolean }

const TWO_PI = Math.PI * 2

interface TrackState {
  // Phase in LFO cycles. Reset to 0 on each trigger so shapes restart cleanly.
  phase: number
  // hrtime ms when the current clip was last triggered (for envelope time math).
  triggerTime: number
  // Center morph — arrays so a multi-value cell morphs each slot independently.
  // Lengths may differ between triggers; padding with zeros for missing slots.
  fromCenter: number[]
  toCenter: number[]
  morphStart: number // hrtime ms
  morphMs: number
  // Stepped-random helpers
  rndStepLastTick: number
  rndStepValue: number
  rndSmoothPrev: number
  rndSmoothNext: number
  // Sequencer state
  seqStepIdx: number
  seqStepStart: number // hrtime ms when this step began
  // Arpeggiator state
  arpStepIdx: number        // current step index into the ladder (0..N-1)
  arpPatternIdx: number     // current index into the pattern array (deterministic modes)
  arpLastAdvanceAt: number  // hrtime ms — when the last arp step fired
  // Random-Generator state
  randRng: (() => number) | null // seeded PRNG; null until the clip is triggered
  randLastAdvanceAt: number       // hrtime ms — when the last random sample fired
  randCurrent: number[]           // last emitted sample (1 item for int/float, 3 for colour)
  // Sample & Hold state — one held value in [-1, 1] plus a "prev" for
  // cosine interpolation when smooth=true. shLastAdvanceAt tracks the
  // last clock tick in hrtime ms (shared with the LFO rate controls).
  shHeld: number
  shPrev: number
  shLastAdvanceAt: number
  // Slew state — one current interpolated value and one target in
  // [-1, 1]. Filter is a simple first-order IIR with different time
  // constants per direction.
  slewValue: number
  slewTarget: number
  slewLastAdvanceAt: number
  // Chaos (logistic map) state — current iterate in (0, 1). Seeded with
  // a small perturbation on each trigger so identical cells diverge.
  chaosX: number
  chaosLastAdvanceAt: number
  // Active cell ref (source of params)
  activeSceneId: string | null
  stopping: boolean
  armed: boolean
  delayTimer: NodeJS.Timeout | null
  // For non-numeric values we only send on change. The "source" key tracks
  // scene/step so we know when to re-send.
  lastSentString: string | null
  lastStringAtSceneId: string | null
  lastStringAtStep: number
}

function makeTrackState(): TrackState {
  return {
    phase: 0,
    triggerTime: 0,
    fromCenter: [],
    toCenter: [],
    morphStart: 0,
    morphMs: 0,
    rndStepLastTick: -1,
    rndStepValue: 0,
    rndSmoothPrev: 0,
    rndSmoothNext: 0,
    seqStepIdx: 0,
    seqStepStart: 0,
    arpStepIdx: 0,
    arpPatternIdx: 0,
    arpLastAdvanceAt: 0,
    randRng: null,
    randLastAdvanceAt: 0,
    randCurrent: [],
    shHeld: 0,
    shPrev: 0,
    shLastAdvanceAt: 0,
    slewValue: 0,
    slewTarget: 0,
    slewLastAdvanceAt: 0,
    chaosX: 0.5,
    chaosLastAdvanceAt: 0,
    activeSceneId: null,
    stopping: false,
    armed: false,
    delayTimer: null,
    lastSentString: null,
    lastStringAtSceneId: null,
    lastStringAtStep: -1
  }
}

function lfo(shape: LfoShape, phase: number, state: TrackState, tickIdx: number): number {
  // phase in [0,1). Returns [-1, 1]
  const p = phase - Math.floor(phase)
  switch (shape) {
    case 'sine':
      return Math.sin(p * TWO_PI)
    case 'triangle':
      return p < 0.5 ? p * 4 - 1 : 3 - p * 4
    case 'sawtooth':
      return p * 2 - 1
    case 'square':
      return p < 0.5 ? 1 : -1
    case 'rndStep': {
      // One new value per LFO period. The actual sample-and-hold update
      // happens in tick() when phase wraps (see `rndStepValue` assignment
      // there). Here we just return the held value.
      return state.rndStepValue
    }
    case 'rndSmooth': {
      // Cosine ease across the full period: k goes 0 → 1 monotonically
      // as p goes 0 → 1, so the output reaches `next` exactly at the wrap.
      // When the tick-loop rotates (prev ← next, next ← new random) at
      // phase wrap, the next cycle starts with k=0 and value = newPrev
      // = oldNext — continuous. Previous formulation used cos(p·2π)
      // which made k bounce back to 0 at p=1, producing a pop because
      // the output snapped from oldPrev back to oldNext at the wrap.
      const k = 0.5 - 0.5 * Math.cos(p * Math.PI)
      return state.rndSmoothPrev * (1 - k) + state.rndSmoothNext * k
    }
  }
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v
}

export class SceneEngine {
  private sender = new OscSender()
  private session: Session | null = null
  // Map by trackId (tracks are global rows)
  private tracks = new Map<string, TrackState>()
  private tickTimer: NodeJS.Timeout | null = null
  private lastTickAt = 0
  private activeSceneId: string | null = null
  private activeSceneStartedAt: number | null = null
  // Slot index (0-based into session.sequence) that actually fired the
  // current active scene — used by the Sequence view to pick which
  // specific slot to highlight when a scene is placed multiple times.
  // null when the trigger didn't come from a slot (palette, column
  // header, MIDI, cue, etc).
  private activeSequenceSlotIdx: number | null = null
  // Per-session "how many times has the active scene played so far?" counter.
  // Resets to 1 whenever activeSceneId CHANGES (fresh user trigger or follow
  // action to a different scene). Increments when the active scene re-triggers
  // itself (loop mode OR a multiplicator-driven internal repeat).
  private activeSceneRepeatCount = 0
  // While paused (sequence advance frozen), this is the wall-clock
  // timestamp pause was entered. On resume we shift activeSceneStartedAt
  // forward by the pause duration so the elapsed time picks up where it
  // left off rather than jumping ahead.
  private pauseStartedAt: number | null = null
  private sceneAdvanceTimer: NodeJS.Timeout | null = null
  private onStateChange: ((s: EngineState) => void) | null = null
  // Latest computed output per (sceneId, trackId). Populated every tick by the
  // numeric path; emitted throttled via emitCurrentValues().
  private liveValues: Record<string, Record<string, string>> = {}
  private lastValueEmitAt = 0

  async start(): Promise<void> {
    await this.sender.start()
    this.startTicker()
  }

  stop(): void {
    this.stopTicker()
    this.sender.stop()
    this.tracks.forEach((ts) => {
      if (ts.delayTimer) clearTimeout(ts.delayTimer)
    })
    this.tracks.clear()
    this.clearSceneAdvance()
  }

  setOnStateChange(cb: (s: EngineState) => void): void {
    this.onStateChange = cb
  }

  /** Forward every successful OSC send to `cb`. Pass null to detach. */
  setOnOscError(cb: ((e: OscErrorEvent) => void) | null): void {
    this.sender.setOnError(cb)
  }
  setOnOscSend(cb: ((e: OscSendEvent) => void) | null): void {
    this.sender.setOnSent(cb)
  }

  private emitState(): void {
    if (!this.onStateChange || !this.session) return
    const active: Record<string, Record<string, boolean>> = {}
    const seq: Record<string, Record<string, number>> = {}
    for (const s of this.session.scenes) {
      active[s.id] = {}
      seq[s.id] = {}
    }
    this.tracks.forEach((ts, trackId) => {
      if (ts.armed && ts.activeSceneId && active[ts.activeSceneId]) {
        active[ts.activeSceneId][trackId] = true
        // Report current sequencer step only when the cell has sequencer enabled.
        const scene = this.session!.scenes.find((sc) => sc.id === ts.activeSceneId)
        const cell = scene?.cells[trackId]
        if (cell?.sequencer.enabled) {
          seq[ts.activeSceneId][trackId] = ts.seqStepIdx
        }
      }
    })
    this.onStateChange({
      activeBySceneAndTrack: active,
      seqStepBySceneAndTrack: seq,
      currentValueBySceneAndTrack: this.liveValues,
      activeSceneId: this.activeSceneId,
      activeSceneStartedAt: this.activeSceneStartedAt,
      activeSequenceSlotIdx: this.activeSequenceSlotIdx,
      pausedAt: this.pauseStartedAt,
      tickRateHz: this.session.tickRateHz
    })
  }

  updateSession(next: Session): void {
    const prevTickRate = this.session?.tickRateHz
    this.session = next
    // Ensure per-track state exists for each track; drop stale.
    const keep = new Set(next.tracks.map((t) => t.id))
    for (const id of this.tracks.keys()) {
      if (!keep.has(id)) {
        const ts = this.tracks.get(id)
        if (ts?.delayTimer) clearTimeout(ts.delayTimer)
        this.tracks.delete(id)
      }
    }
    for (const t of next.tracks) {
      if (!this.tracks.has(t.id)) this.tracks.set(t.id, makeTrackState())
    }
    // Prune liveValues entries for scenes or tracks that no longer exist.
    // Without this, switching between sessions with lots of scenes over an
    // app lifetime leaks O(scenes × tracks) string entries in `liveValues`
    // — the engine holds refs forever because the emitState loop only
    // writes, never removes when a scene disappears.
    const sceneKeep = new Set(next.scenes.map((s) => s.id))
    for (const sid of Object.keys(this.liveValues)) {
      if (!sceneKeep.has(sid)) {
        delete this.liveValues[sid]
        continue
      }
      const row = this.liveValues[sid]
      for (const tid of Object.keys(row)) {
        if (!keep.has(tid)) delete row[tid]
      }
    }
    // If the currently-active scene was deleted, clear the ref so the
    // engine doesn't keep pointing at a ghost scene. Running cells have
    // already been safely ignored by getActiveCell returning null, but
    // the stale activeSceneId would leak through emitState.
    if (this.activeSceneId && !sceneKeep.has(this.activeSceneId)) {
      this.activeSceneId = null
      this.activeSceneStartedAt = null
      this.activeSequenceSlotIdx = null
      this.activeSceneRepeatCount = 0
      this.clearSceneAdvance()
    }
    // Only restart the tick interval if the rate actually changed. Otherwise
    // rapid session updates (e.g., the user typing in a text field) would
    // tear down and recreate setInterval on every keystroke, which stalls the
    // renderer under load. Don't emitState either — nothing engine-runtime
    // related changed.
    if (prevTickRate !== next.tickRateHz) this.restartTicker()
  }

  setTickRate(hz: number): void {
    if (!this.session) return
    this.session.tickRateHz = clamp(hz, 10, 300)
    this.restartTicker()
  }

  /**
   * Meta Controller live output. Called by the renderer on every interpolated
   * frame (drag, MIDI CC — both tweened renderer-side so the UI and the OSC
   * output match exactly). This method just scales through the knob's curve
   * and fires OSC to every enabled destination. No smoothing is applied here
   * — it's entirely the renderer's responsibility so what you see on the
   * knob is what leaves the socket.
   *
   * Values always go out as floats (`f`) — knob outputs are always numeric.
   */
  sendMetaValue(knobIdx: number, normalizedValue: number): void {
    if (!this.session) return
    if (knobIdx < 0 || knobIdx >= META_KNOB_COUNT) return
    const knob = this.session.metaController?.knobs?.[knobIdx]
    if (!knob) return
    const t = clamp(normalizedValue, 0, 1)
    const scaled = scaleMetaValue(t, knob.min, knob.max, knob.curve)
    for (const d of knob.destinations) {
      if (!d.enabled) continue
      this.sender.send(d.destIp, d.destPort, d.oscAddress, { type: 'f', value: scaled })
    }
  }

  // `morphMsOverride` — when set, this transition uses the given duration
  // in milliseconds instead of the cell's own `transitionMs`. Lets the
  // scene-to-scene Morph feature glide every track in a scene over the
  // same time. null / undefined = use cell's transitionMs as before.
  // `silent` — skip emitState. Callers batching many triggers (scene
  // fire) can emit once at the end instead of N times.
  triggerCell(
    sceneId: string,
    trackId: string,
    morphMsOverride?: number | null,
    silent?: boolean
  ): void {
    if (!this.session) return
    const scene = this.session.scenes.find((s) => s.id === sceneId)
    if (!scene) return
    const cell = scene.cells[trackId]
    if (!cell) return
    const ts = this.tracks.get(trackId)
    if (!ts) return

    if (ts.delayTimer) {
      clearTimeout(ts.delayTimer)
      ts.delayTimer = null
    }

    const start = (): void => {
      const curOut = this.computeCurrentOutputs(trackId)
      // Target centers: sequencer step 0 if sequencer enabled, else cell.value.
      const baseRaw = cell.sequencer.enabled
        ? cell.sequencer.stepValues[0] ?? cell.value
        : cell.value
      const rawTargets = numericBasesFromRaw(baseRaw)
      const targets = cell.scaleToUnit ? rawTargets.map((v) => clamp01(v)) : rawTargets
      // Pad from/to to the same length so element-wise interpolation is clean.
      const len = Math.max(curOut.length, targets.length)
      ts.fromCenter = pad(curOut, len, 0)
      ts.toCenter = pad(targets, len, 0)
      ts.morphStart = now()
      ts.morphMs =
        typeof morphMsOverride === 'number' && morphMsOverride >= 0
          ? morphMsOverride
          : cell.transitionMs
      ts.activeSceneId = sceneId
      ts.armed = true
      ts.stopping = false
      // Reset LFO phase + envelope clock on every trigger so modulation shapes
      // restart cleanly from their t=0 value.
      ts.phase = 0
      ts.triggerTime = now()
      // Reset stepped-random state so a fresh random value fires at trigger.
      ts.rndStepLastTick = -1
      ts.rndStepValue = Math.random() * 2 - 1
      ts.rndSmoothPrev = 0
      ts.rndSmoothNext = Math.random() * 2 - 1
      // Reset sequencer to step 0 on trigger.
      ts.seqStepIdx = 0
      ts.seqStepStart = now()
      // Reset arp: start index depends on mode (Down starts at the top, etc.).
      ts.arpPatternIdx = 0
      ts.arpStepIdx = arpStartStep(cell.modulation.arpeggiator)
      ts.arpLastAdvanceAt = now()
      // Seed the Random Generator's PRNG from the cell's Value so the same
      // Value produces a reproducible stream. Fire the first sample now,
      // with one draw per whitespace-separated entry (3 per entry for colour).
      ts.randRng = mulberry32(hashSeedString(cell.value))
      ts.randLastAdvanceAt = now()
      {
        const initCount = Math.max(1, parseValueTokens(cell.value).length)
        ts.randCurrent = sampleRandom(ts.randRng, cell.modulation.random, initCount)
      }
      // Fresh S&H sample at trigger so the first tick has a real value
      // rather than zero (avoids a dead-air slot on the downbeat).
      ts.shHeld = Math.random() * 2 - 1
      ts.shPrev = 0
      ts.shLastAdvanceAt = now()
      // Slew: start at current center target to avoid a pop, pick a new
      // random target immediately so motion is audible.
      ts.slewValue = 0
      ts.slewTarget = Math.random() * 2 - 1
      ts.slewLastAdvanceAt = now()
      // Chaos: seed close to 0.5 with a small per-trigger jitter so two
      // adjacent cells running the same settings produce different
      // trajectories. Values exactly at 0 or 1 are fixed points; keep
      // clear of both.
      ts.chaosX = 0.1 + Math.random() * 0.8
      ts.chaosLastAdvanceAt = now()
      ts.lastSentString = null
      ts.lastStringAtSceneId = null
      ts.lastStringAtStep = -1
      if (!silent) this.emitState()
    }

    if (cell.delayMs > 0) {
      ts.delayTimer = setTimeout(() => {
        ts.delayTimer = null
        start()
      }, cell.delayMs)
    } else {
      start()
    }
  }

  stopCell(sceneId: string, trackId: string): void {
    const ts = this.tracks.get(trackId)
    if (!ts || !this.session) return
    // Only stop if this cell is actually the active one for the track.
    if (ts.activeSceneId !== sceneId) return
    this.beginStop(trackId)
  }

  // `silent` suppresses the per-call emitState() — the caller is
  // responsible for emitting once after batching multiple beginStops
  // (e.g. scene-level orphan fade). Keeps IPC volume bounded no matter
  // how many tracks are involved in the morph.
  private beginStop(
    trackId: string,
    morphMsOverride?: number,
    silent?: boolean
  ): void {
    const ts = this.tracks.get(trackId)
    if (!ts || !this.session) return
    if (ts.delayTimer) {
      clearTimeout(ts.delayTimer)
      ts.delayTimer = null
    }
    const cell = this.getActiveCell(trackId)
    const curOut = this.computeCurrentOutputs(trackId)
    ts.fromCenter = [...curOut]
    ts.toCenter = curOut.map(() => 0)
    ts.morphStart = now()
    // Morph override lets the scene-to-scene Morph feature fade orphan
    // tracks out over the same duration the new tracks fade in.
    ts.morphMs =
      typeof morphMsOverride === 'number' && morphMsOverride >= 0
        ? morphMsOverride
        : cell?.transitionMs ?? 0
    ts.stopping = true
    if (!silent) this.emitState()
  }

  stopScene(sceneId: string): void {
    if (!this.session) return
    // Stop any track whose active cell is currently in this scene — silent
    // per-track, single emit at the end.
    for (const [tid, ts] of this.tracks.entries()) {
      if (ts.armed && ts.activeSceneId === sceneId) {
        this.beginStop(tid, undefined, /* silent */ true)
      }
    }
    if (this.activeSceneId === sceneId) {
      this.activeSceneId = null
      this.activeSceneStartedAt = null
      this.activeSequenceSlotIdx = null
      this.clearSceneAdvance()
    }
    this.emitState()
  }

  pauseSequence(): void {
    // Freeze auto-advance without stopping cells. Cells keep
    // playing/modulating, but the active scene's elapsed time stops
    // accumulating (we mark pauseStartedAt; on resume we offset
    // activeSceneStartedAt by the pause duration). The renderer's
    // countdown reads activeSceneStartedAt and the pause flag, so
    // freezing on this side is enough to also freeze the visual
    // remaining-time display.
    this.clearSceneAdvance()
    if (this.activeSceneStartedAt !== null && this.pauseStartedAt === null) {
      this.pauseStartedAt = Date.now()
      this.emitState()
    }
  }

  resumeSequence(): void {
    if (!this.session) return
    // Apply the pause-shift: activeSceneStartedAt += (now - pauseStartedAt)
    // so elapsed picks up exactly where it left off.
    if (this.pauseStartedAt !== null && this.activeSceneStartedAt !== null) {
      const pauseDur = Date.now() - this.pauseStartedAt
      this.activeSceneStartedAt += pauseDur
    }
    this.pauseStartedAt = null
    // Re-arm from the current active scene's full duration (simple approach).
    const id = this.activeSceneId
    if (!id) {
      this.emitState()
      return
    }
    const scene = this.session.scenes.find((s) => s.id === id)
    if (scene) this.armSceneAdvance(scene)
    this.emitState()
  }

  // `opts.morphMs` — when set, every cell in the scene morphs over this
  // duration (ms) instead of its own transitionMs. Tracks that were active
  // in the previous scene but have no cell in this new scene will ALSO
  // fade out over the same duration, so the whole sonic picture glides
  // from scene-A's state into scene-B's state in lockstep.
  // `opts.sourceSlotIdx` — when the trigger originated from a specific
  // slot in the Sequence grid (1..9 / 0 hotkey, follow-action advance,
  // slot-click), pass the slot index. The Sequence view uses it to
  // highlight ONLY that instance of the scene in the grid, even when
  // the scene is placed multiple times.
  triggerScene(
    sceneId: string,
    opts?: { morphMs?: number; sourceSlotIdx?: number | null }
  ): void {
    if (!this.session) return
    const scene = this.session.scenes.find((s) => s.id === sceneId)
    if (!scene) return
    const morphMs = opts?.morphMs
    const useMorph = typeof morphMs === 'number' && morphMs >= 0

    // Orphan stop — tracks that were playing a cell from the PREVIOUS
    // scene but have no cell in the new scene. Ableton Session View
    // convention: new scene fires mean the OLD scene's other cells stop,
    // period. Previous build only did this in Morph mode; everything
    // else let a looping clip drone on forever unless the user manually
    // stopped it. Morph time (when set) becomes the fade duration;
    // without Morph, each cell falls back to its own transitionMs.
    // Silent so the per-track emitState doesn't fan out into N IPCs;
    // coalesced emit lands at the end of this method.
    {
      const newTrackIds = new Set(Object.keys(scene.cells))
      for (const [trackId, ts] of this.tracks.entries()) {
        if (ts.armed && !newTrackIds.has(trackId)) {
          this.beginStop(
            trackId,
            useMorph ? morphMs : undefined,
            /* silent */ true
          )
        }
      }
    }

    // If this is the SAME scene as what's already active, we're here via a
    // loop follow-action or a multiplicator-driven internal repeat — bump
    // the repeat counter. Otherwise reset to 1 (fresh play).
    if (this.activeSceneId === sceneId) this.activeSceneRepeatCount += 1
    else this.activeSceneRepeatCount = 1
    for (const trackId of Object.keys(scene.cells)) {
      // Silent per-cell emits — one coalesced emit happens after the
      // loop. Keeps IPC volume + renderer reconciliation bounded.
      this.triggerCell(
        sceneId,
        trackId,
        useMorph ? morphMs : undefined,
        /* silent */ true
      )
    }
    this.activeSceneId = sceneId
    this.activeSceneStartedAt = Date.now()
    // If the caller passed a specific slot, use it; otherwise clear
    // (palette / column / MIDI / cue triggers aren't tied to a slot).
    this.activeSequenceSlotIdx =
      typeof opts?.sourceSlotIdx === 'number' ? opts.sourceSlotIdx : null
    this.armSceneAdvance(scene)
    this.emitState()
  }

  private armSceneAdvance(scene: Scene): void {
    this.clearSceneAdvance()
    // Capture the scene's id, NOT the scene object itself, so that edits
    // made while the duration timer is ticking (user changes nextMode,
    // multiplicator, or duration via the UI — which replaces this.session
    // via updateSession) are actually respected by the follow-action.
    // Prior bug: once A -> B ping-pong started, switching A's nextMode to
    // "stop" had no effect because the still-scheduled timer held a
    // reference to A's OLD data.
    const sceneId = scene.id
    this.sceneAdvanceTimer = setTimeout(() => {
      // Re-fetch the current version of this scene off the live session.
      const cur =
        this.session?.scenes.find((s) => s.id === sceneId) ?? null
      if (!cur) return
      // Multiplicator gate — if the scene hasn't yet played the requested
      // number of times, re-trigger itself (counter bumps in triggerScene)
      // before the real follow action fires. Applies to every mode: stop
      // with mult=3 plays 3x then stops; next with mult=2 plays 2x then
      // advances; loop is unchanged (it already re-triggers forever).
      const mult = Math.max(1, Math.floor(cur.multiplicator || 1))
      if (this.activeSceneRepeatCount < mult) {
        this.triggerScene(cur.id)
        return
      }
      // Stop now *actually* stops everything. Previously the engine kept
      // the scene "alive" as long as any cell had modulation or sequencer
      // enabled — useful in theory, but the user's intent with Stop is
      // "end the scene here." Morph every active cell back to 0 over its
      // own transitionMs and clear the active-scene state.
      if (cur.nextMode === 'stop') {
        this.stopScene(cur.id)
      } else {
        this.advanceScene(cur)
      }
    }, Math.max(10, scene.durationSec * 1000))
  }

  private sceneHasOngoingActivity(sceneId: string): boolean {
    if (!this.session) return false
    const scene = this.session.scenes.find((s) => s.id === sceneId)
    if (!scene) return false
    for (const [trackId, ts] of this.tracks.entries()) {
      if (ts.armed && ts.activeSceneId === sceneId) {
        const cell = scene.cells[trackId]
        if (cell?.modulation.enabled || cell?.sequencer.enabled) return true
      }
    }
    return false
  }

  private clearSceneAdvance(): void {
    if (this.sceneAdvanceTimer) {
      clearTimeout(this.sceneAdvanceTimer)
      this.sceneAdvanceTimer = null
    }
  }

  private advanceScene(current: Scene): void {
    if (!this.session) return
    // Loop bypasses the sequence entirely — it re-triggers the current
    // scene regardless of whether it's placed in any sequencer slot. The
    // repeat-counter increments on re-trigger, but stays capped at its own
    // count so it keeps looping forever.
    if (current.nextMode === 'loop') {
      this.triggerScene(current.id)
      return
    }
    // Build the "walk list" for follow actions. Primary: scenes placed
    // in the Sequence grid, in grid order. Fallback: the palette (every
    // scene in session.scenes), so follow actions still work before the
    // user has arranged anything in the Sequence view. Without the
    // fallback, non-loop follow actions silently terminated whenever the
    // grid was empty — the user experienced this as "only Stop and Loop
    // work; every other follow action just stops after completion."
    const len = Math.max(1, Math.min(128, this.session.sequenceLength ?? 128))
    const gridSeq = this.session.sequence.slice(0, len)
    const gridPresent = gridSeq.filter((id): id is string => !!id)
    const usingPalette = gridPresent.length === 0
    // `seq` is whatever we walk. slotIdx in the result points into
    // `gridSeq` when we're using the grid, or stays null when we're
    // walking the palette (the Sequence view won't have a matching slot
    // to highlight). Either way we pass just the scene id through
    // triggerScene, so behavior is identical downstream except for the
    // highlight in the Sequence grid.
    const seq: (string | null)[] = usingPalette
      ? this.session.scenes.map((s) => s.id)
      : gridSeq
    const filledIdxs: number[] = []
    seq.forEach((id, i) => {
      if (id) filledIdxs.push(i)
    })
    // Still nothing? Genuinely empty session — fall through to Stop so
    // cells don't drone indefinitely.
    if (filledIdxs.length === 0) {
      this.stopScene(current.id)
      return
    }

    // Track (nextId, nextSlotIdx) together so the highlight in the
    // Sequence view follows the SPECIFIC slot the advance landed on,
    // not every instance of the scene in the grid. `nextSlotIdx` stays
    // null when we fall back to walking the palette (no grid slot to
    // highlight).
    let nextId: string | null = null
    let nextSlotIdx: number | null = null
    const start = seq.findIndex((id) => id === current.id)

    // When walking the palette, the "slot index" we pick is meaningless
    // for the Sequence view's highlight — so null it out before firing
    // triggerScene. The grid path keeps real slot indices so clicking
    // Next on scene-at-slot-5 highlights slot 6, not every instance of
    // scene 6 in the grid.
    const slotOrNull = (idx: number | undefined): number | null =>
      usingPalette ? null : typeof idx === 'number' ? idx : null

    switch (current.nextMode) {
      case 'next': {
        if (start < 0) {
          const pick = filledIdxs[0]
          nextSlotIdx = slotOrNull(pick)
          nextId = seq[pick] ?? null
        } else {
          for (let i = 1; i <= seq.length; i++) {
            const idx = (start + i) % seq.length
            if (seq[idx]) {
              nextId = seq[idx]
              nextSlotIdx = slotOrNull(idx)
              break
            }
          }
        }
        break
      }
      case 'prev': {
        if (start < 0) {
          const pick = filledIdxs[filledIdxs.length - 1]
          nextSlotIdx = slotOrNull(pick)
          nextId = seq[pick] ?? null
        } else {
          for (let i = 1; i <= seq.length; i++) {
            const idx = (start - i + seq.length) % seq.length
            if (seq[idx]) {
              nextId = seq[idx]
              nextSlotIdx = slotOrNull(idx)
              break
            }
          }
        }
        break
      }
      case 'first': {
        const pick = filledIdxs[0]
        nextSlotIdx = slotOrNull(pick)
        nextId = seq[pick] ?? null
        break
      }
      case 'last': {
        const pick = filledIdxs[filledIdxs.length - 1]
        nextSlotIdx = slotOrNull(pick)
        nextId = seq[pick] ?? null
        break
      }
      case 'any': {
        // Random pick from every present slot (including self).
        const pick = filledIdxs[Math.floor(Math.random() * filledIdxs.length)]
        nextSlotIdx = slotOrNull(pick)
        nextId = seq[pick] ?? null
        break
      }
      case 'other': {
        // Random pick excluding the current scene. If only self is
        // present, fall back to self so the follow doesn't stall.
        const otherIdxs = filledIdxs.filter((i) => seq[i] !== current.id)
        const pick =
          otherIdxs.length > 0
            ? otherIdxs[Math.floor(Math.random() * otherIdxs.length)]
            : filledIdxs[0]
        nextSlotIdx = slotOrNull(pick)
        nextId = seq[pick] ?? null
        break
      }
      default:
        // 'stop' and 'loop' are handled above / earlier; anything else is a
        // no-op on purpose.
        break
    }
    if (nextId) {
      this.triggerScene(nextId, { sourceSlotIdx: nextSlotIdx })
    } else {
      // Every code path above that reached here without finding a next
      // (e.g. default case) falls back to Stop so the current scene
      // doesn't hang.
      this.stopScene(current.id)
    }
  }

  stopAll(): void {
    for (const [tid, ts] of this.tracks.entries()) {
      if (ts.armed || ts.delayTimer) this.beginStop(tid, undefined, /* silent */ true)
    }
    this.clearSceneAdvance()
    this.activeSceneId = null
    this.activeSceneStartedAt = null
    this.activeSequenceSlotIdx = null
    this.activeSceneRepeatCount = 0
    this.emitState()
  }

  panic(): void {
    for (const ts of this.tracks.values()) {
      if (ts.delayTimer) {
        clearTimeout(ts.delayTimer)
        ts.delayTimer = null
      }
      ts.armed = false
      ts.stopping = false
      ts.activeSceneId = null
      ts.morphMs = 0
      ts.fromCenter = []
      ts.toCenter = []
    }
    this.clearSceneAdvance()
    this.activeSceneId = null
    this.activeSceneStartedAt = null
    this.activeSequenceSlotIdx = null
    this.activeSceneRepeatCount = 0
    this.emitState()
  }

  // ----- Ticking -----

  private startTicker(): void {
    if (!this.session) {
      // Kick off at 120Hz default until session arrives (matches the
      // renderer's default from factory.makeEmptySession).
      this.tickTimer = setInterval(() => this.tick(), 1000 / 120)
      return
    }
    // Keep this range in sync with setTickRate() above and with the
    // renderer's clamp in store.setTickRate. Drifting apart silently caps
    // the engine to a lower rate than the UI advertises.
    const hz = clamp(this.session.tickRateHz, 10, 300)
    this.tickTimer = setInterval(() => this.tick(), 1000 / hz)
  }

  private stopTicker(): void {
    if (this.tickTimer) {
      clearInterval(this.tickTimer)
      this.tickTimer = null
    }
  }

  private restartTicker(): void {
    this.stopTicker()
    this.startTicker()
  }

  private tickIdx = 0

  private tick(): void {
    if (!this.session) return
    const t = now()
    // Cap dt at 50 ms. If the system hiccups (GC pause, CPU spike, sleep
    // wake-up), a raw dt could be several hundred ms — enough to overshoot
    // phase, fire multiple clock advances in a single tick for S&H / Slew
    // / Chaos / Random, or make the one-pole IIR filter in Slew go unstable.
    // Treating the backlog as "just one frame's worth" keeps DSP sane at
    // the cost of a visible catch-up delay after real stalls (preferable).
    const rawDt = this.lastTickAt === 0 ? 0 : (t - this.lastTickAt) / 1000
    const dt = Math.min(0.05, rawDt)
    this.lastTickAt = t
    this.tickIdx++

    for (const [trackId, ts] of this.tracks.entries()) {
      if (!ts.armed && !ts.stopping) continue
      const cell = this.getActiveCell(trackId)
      if (!cell) continue

      // Advance LFO phase (only for LFO modulation; envelope uses real time).
      if (cell.modulation.enabled && cell.modulation.type === 'lfo') {
        const effHz = effectiveLfoHz(cell.modulation, this.session.globalBpm)
        const prevPhase = ts.phase
        ts.phase += effHz * dt
        if (Math.floor(ts.phase) !== Math.floor(prevPhase)) {
          ts.rndSmoothPrev = ts.rndSmoothNext
          ts.rndSmoothNext = Math.random() * 2 - 1
          ts.rndStepValue = Math.random() * 2 - 1
          ts.rndStepLastTick = this.tickIdx
        }
      }

      // Sample & Hold — clock-driven stair (or cosine-smoothed stair).
      // Each clock period, optionally pick a fresh sample in [-1, 1].
      // `probability` below 1.0 gives the pattern a chance to "hold" a
      // sample for multiple clocks (Turing-machine-ish locked feel).
      if (cell.modulation.enabled && cell.modulation.type === 'sh' && !ts.stopping) {
        const effHz = effectiveLfoHz(cell.modulation, this.session.globalBpm)
        if (effHz > 0) {
          const period = 1000 / effHz
          while (t - ts.shLastAdvanceAt >= period) {
            ts.shLastAdvanceAt += period
            if (Math.random() < Math.max(0, Math.min(1, cell.modulation.sh.probability))) {
              ts.shPrev = ts.shHeld
              ts.shHeld = Math.random() * 2 - 1
            }
            // If the die rolls against us, no change — held + prev stay put.
          }
        }
      }

      // Slew — generate a clock-rate target, then per-tick low-pass the
      // current value toward it using independent rise/fall time constants.
      if (cell.modulation.enabled && cell.modulation.type === 'slew' && !ts.stopping) {
        const effHz = effectiveLfoHz(cell.modulation, this.session.globalBpm)
        if (effHz > 0) {
          const period = 1000 / effHz
          while (t - ts.slewLastAdvanceAt >= period) {
            ts.slewLastAdvanceAt += period
            if (cell.modulation.slew.randomTarget) {
              ts.slewTarget = Math.random() * 2 - 1
            } else {
              // Bipolar square: flip the existing target's sign each clock.
              // A previous version used a tick-local counter that reset
              // every tick, so with exactly one clock advance per tick the
              // target got stuck at -1 forever (first increment → 1 → odd
              // → -1, reset to 0 next tick, same again). Flipping in-place
              // preserves alternation across tick boundaries.
              ts.slewTarget = ts.slewTarget >= 0 ? -1 : 1
            }
          }
        }
        // Per-tick filter: exponential toward target, different HL for rise vs fall.
        const goingUp = ts.slewTarget > ts.slewValue
        const halfLifeMs = Math.max(1, goingUp ? cell.modulation.slew.riseMs : cell.modulation.slew.fallMs)
        // One-pole IIR: y += (target - y) * (1 - 2^(-dt / halfLife))
        const alpha = 1 - Math.pow(2, (-dt * 1000) / halfLifeMs)
        ts.slewValue += (ts.slewTarget - ts.slewValue) * alpha
      }

      // Chaos — logistic map iterate at clock rate. Stored state stays in
      // (0, 1); output is scaled to bipolar [-1, 1] in computeModNorm.
      if (cell.modulation.enabled && cell.modulation.type === 'chaos' && !ts.stopping) {
        const effHz = effectiveLfoHz(cell.modulation, this.session.globalBpm)
        if (effHz > 0) {
          const period = 1000 / effHz
          const r = Math.max(3.4, Math.min(4.0, cell.modulation.chaos.r))
          while (t - ts.chaosLastAdvanceAt >= period) {
            ts.chaosLastAdvanceAt += period
            let x = ts.chaosX
            x = r * x * (1 - x)
            // Clamp away from fixed points so the trajectory never stalls
            // on a degenerate input.
            if (!Number.isFinite(x) || x <= 0 || x >= 1) x = 0.1 + Math.random() * 0.8
            ts.chaosX = x
          }
        }
      }

      // Random Generator path — bypasses the normal token logic. Emits
      // a new OSC payload on its own rate, seeded from the cell's Value.
      // Number of samples per tick scales with the number of whitespace-
      // separated entries in the Value field (1 per entry for int/float,
      // 3 per entry for colour — each entry becomes its own RGB triplet).
      if (
        cell.modulation.enabled &&
        cell.modulation.type === 'random' &&
        !ts.stopping &&
        ts.randRng
      ) {
        const effHz = effectiveLfoHz(cell.modulation, this.session.globalBpm)
        if (effHz > 0) {
          const period = 1000 / effHz
          const rawTokens = parseValueTokens(cell.value)
          const tokenCount = Math.max(1, rawTokens.length)
          let advanced = false
          while (t - ts.randLastAdvanceAt >= period) {
            ts.randLastAdvanceAt += period
            ts.randCurrent = sampleRandom(
              ts.randRng,
              cell.modulation.random,
              tokenCount
            )
            advanced = true
          }
          if (advanced) {
            const rnd = cell.modulation.random
            const args: Array<{
              type: 'i' | 'f' | 's' | 'T' | 'F'
              value: number | string | boolean
            }> = ts.randCurrent.map((v) => {
              if (rnd.valueType === 'float') {
                // Quantize to 1e-11 for stable output.
                const q = Math.round(v * 1e11) / 1e11
                const final = cell.scaleToUnit ? clamp01(q) : q
                return { type: 'f' as const, value: final }
              }
              // int or colour — integer output
              const n = Math.round(v)
              const final = cell.scaleToUnit ? clamp01(n) : n
              return { type: 'i' as const, value: final }
            })
            this.sender.sendMany(cell.destIp, cell.destPort, cell.oscAddress, args)
            this.recordLiveValue(
              ts.activeSceneId ?? '',
              trackId,
              args
                .map((a) =>
                  typeof a.value === 'number' && a.type === 'f'
                    ? (a.value as number).toFixed(4)
                    : String(a.value)
                )
                .join(' ')
            )
          }
        }
        if (ts.stopping) this.disarm(ts)
        continue
      }

      // Advance arpeggiator step (per the modulation's rate sync settings).
      if (
        cell.modulation.enabled &&
        cell.modulation.type === 'arpeggiator' &&
        !ts.stopping
      ) {
        const effHz = effectiveLfoHz(cell.modulation, this.session.globalBpm)
        if (effHz > 0) {
          const period = 1000 / effHz
          // While-loop catches up if we missed multiple step boundaries
          // (e.g., a tick took unusually long).
          while (t - ts.arpLastAdvanceAt >= period) {
            ts.arpLastAdvanceAt += period
            advanceArpStep(ts, cell.modulation.arpeggiator)
          }
        }
      }

      // Advance sequencer step
      if (cell.sequencer.enabled && !ts.stopping) {
        // Resolve the step duration based on the sequencer's Sync mode.
        //   'bpm'   — lock to the session's global BPM
        //   'tempo' — use the sequencer's per-clip bpm slider
        //   'free'  — use the per-clip stepMs
        const syncMode = cell.sequencer.syncMode as 'bpm' | 'tempo' | 'free'
        const stepDurMs =
          syncMode === 'bpm'
            ? 60000 / Math.max(1, this.session.globalBpm)
            : syncMode === 'tempo'
              ? 60000 / Math.max(1, cell.sequencer.bpm)
              : Math.max(1, cell.sequencer.stepMs)
        let stepChanged = false
        while (t - ts.seqStepStart >= stepDurMs) {
          ts.seqStepStart += stepDurMs
          const steps = Math.max(1, Math.min(16, cell.sequencer.steps))
          ts.seqStepIdx = (ts.seqStepIdx + 1) % steps
          stepChanged = true
        }
        if (stepChanged) this.emitState()
      }

      // Euclidean gate — when the sequencer is in 'euclidean' mode, the
      // current step is either a HIT (emit normally) or a MISS (suppress
      // OSC send so the receiver's current value is held).
      const seqMuted =
        cell.sequencer.enabled &&
        cell.sequencer.mode === 'euclidean' &&
        (() => {
          const steps = Math.max(1, Math.min(16, cell.sequencer.steps))
          const pulses = Math.max(0, Math.min(steps, cell.sequencer.pulses))
          const pat = euclidean(pulses, steps, cell.sequencer.rotation)
          return !pat[ts.seqStepIdx % steps]
        })()
      if (seqMuted) {
        // No OSC output this tick. Advance stopping-morph so Stop still
        // resolves on schedule, and move on to the next track.
        if (ts.stopping) {
          const morphP = ts.morphMs > 0 ? clamp((t - ts.morphStart) / ts.morphMs, 0, 1) : 1
          if (morphP >= 1) this.disarm(ts)
        }
        continue
      }

      // Resolve the base value string: sequencer step value if enabled, else cell.value.
      const baseRaw = cell.sequencer.enabled
        ? cell.sequencer.stepValues[ts.seqStepIdx] ?? cell.value
        : cell.value

      // Morph progress (transition only applies on scene change, not step changes).
      const morphP = ts.morphMs > 0 ? clamp((t - ts.morphStart) / ts.morphMs, 0, 1) : 1

      // Parse tokens. Each token becomes one OSC arg; modulation & scaling
      // apply per-token for numeric ones, strings/bools pass through.
      const tokens = parseValueTokens(baseRaw)
      if (tokens.length === 0) {
        if (ts.stopping && morphP >= 1) this.disarm(ts)
        continue
      }
      const perToken = tokens.map((t) => autoDetectOscArg(t))
      const hasNumeric = perToken.some((a) => a.type === 'i' || a.type === 'f')

      // Pure string/bool path — send on change, no morph math.
      if (!hasNumeric) {
        const stepKey = cell.sequencer.enabled ? ts.seqStepIdx : -1
        const changed =
          ts.lastSentString !== baseRaw ||
          ts.lastStringAtSceneId !== ts.activeSceneId ||
          ts.lastStringAtStep !== stepKey
        if (morphP >= 1 && changed) {
          this.sender.sendMany(
            cell.destIp,
            cell.destPort,
            cell.oscAddress,
            perToken.map((a) => ({ type: a.type, value: a.value }))
          )
          ts.lastSentString = baseRaw
          ts.lastStringAtSceneId = ts.activeSceneId
          ts.lastStringAtStep = stepKey
        }
        this.recordLiveValue(ts.activeSceneId ?? '', trackId, baseRaw)
        if (ts.stopping && morphP >= 1) this.disarm(ts)
        continue
      }

      // Mixed / numeric path.
      // Compute the modulation signal. LFO uses an additive signal (modNorm
      // in -1..1 or 0..1 depending on mode). Envelope is multiplicative —
      // naturally 0..1 (a VCA-style gain). Multi-arg Value entries all share
      // the same signal.
      let modNorm = 0
      let envGain = 1
      let rampGain = 1
      if (cell.modulation.enabled && !ts.stopping) {
        if (cell.modulation.type === 'envelope') {
          envGain = computeEnvelopeGain(
            cell.modulation.envelope,
            (t - ts.triggerTime) / 1000,
            this.currentSceneDurationSec(ts.activeSceneId)
          )
        } else if (cell.modulation.type === 'ramp') {
          rampGain = computeRampGain(
            cell.modulation.ramp,
            (t - ts.triggerTime) / 1000,
            this.currentSceneDurationSec(ts.activeSceneId)
          )
        } else {
          modNorm = computeModNorm(
            cell.modulation,
            ts,
            this.tickIdx,
            (t - ts.triggerTime) / 1000,
            this.currentSceneDurationSec(ts.activeSceneId),
            this.session.globalBpm
          )
        }
      }

      // Per-token targets (numeric) — baseline for center computation.
      const stepTargetsRaw = perToken.map((a) =>
        a.type === 'i' || a.type === 'f' ? (a.value as number) : null
      )
      const stepTargets = cell.scaleToUnit
        ? stepTargetsRaw.map((v) => (v === null ? null : clamp01(v)))
        : stepTargetsRaw

      const outs: Array<{ type: 'i' | 'f' | 's' | 'T' | 'F'; value: unknown }> = []
      const liveParts: string[] = []

      for (let idx = 0; idx < perToken.length; idx++) {
        const a = perToken[idx]
        if (a.type === 's' || a.type === 'T' || a.type === 'F') {
          outs.push({ type: a.type, value: a.value })
          liveParts.push(String(a.value))
          continue
        }
        const target = stepTargets[idx] ?? 0
        // Center: with sequencer, center jumps to step value (still honoring
        // the initial morph-in after trigger). Without sequencer, center
        // follows the morph from fromCenter[idx] → toCenter[idx].
        let center: number
        if (cell.sequencer.enabled) {
          const from = ts.fromCenter[idx] ?? 0
          center = morphP < 1 ? from + (target - from) * morphP : target
        } else {
          const from = ts.fromCenter[idx] ?? 0
          const to = ts.toCenter[idx] ?? target
          center = from + (to - from) * morphP
        }

        let out = center
        if (cell.modulation.enabled && !ts.stopping) {
          if (cell.modulation.type === 'envelope') {
            // Multiplicative envelope, depth-mixed. depth=0% → no effect
            // (output = center); depth=100% → full VCA shape (out = center * env).
            const depth01 = cell.modulation.depthPct / 100
            out = center * (1 - depth01 + depth01 * envGain)
          } else if (cell.modulation.type === 'ramp') {
            // One-shot 0→1 ramp, depth-mixed identically to envelope. Once
            // the ramp completes, rampGain stays at 1 so the output settles
            // at `center` (modulator becomes neutral, as requested).
            const depth01 = cell.modulation.depthPct / 100
            out = center * (1 - depth01 + depth01 * rampGain)
          } else if (cell.modulation.type === 'arpeggiator') {
            // Arp: ladder built fresh per token from this token's center so
            // multi-arg Value ("10 20") arps each token independently.
            const arp = cell.modulation.arpeggiator
            const N = Math.max(1, Math.min(8, arp.steps))
            let ladder = buildArpLadder(center, N, arp.multMode)
            let dryCenter = center
            // When Scale 0.0-1.0 is on with arp, NORMALIZE the ladder so the
            // largest magnitude maps to 1.0. Keeps the proportional shape of
            // Multiplication/Div/Mult mode intact instead of collapsing to a
            // flat 1.000 when any ladder value > 1.
            if (cell.scaleToUnit) {
              const maxAbs = ladder.reduce(
                (m, v) => (Math.abs(v) > m ? Math.abs(v) : m),
                0
              )
              if (maxAbs > 0) {
                ladder = ladder.map((v) => v / maxAbs)
                dryCenter = center / maxAbs
              }
            }
            const stepVal =
              ladder[Math.max(0, Math.min(N - 1, ts.arpStepIdx))] ?? dryCenter
            const depth01 = cell.modulation.depthPct / 100
            // depth=100% replaces base with arp value; depth=0% leaves base.
            out = dryCenter * (1 - depth01) + stepVal * depth01
          } else {
            const magnitude =
              Math.max(Math.abs(center), 1) * (cell.modulation.depthPct / 100)
            out = center + modNorm * magnitude
          }
        }
        if (cell.scaleToUnit) out = clamp01(out)

        const sendType: 'i' | 'f' =
          a.type === 'i' && !cell.modulation.enabled && !cell.scaleToUnit ? 'i' : 'f'
        const finalVal = sendType === 'i' ? Math.round(out) : out
        outs.push({ type: sendType, value: finalVal })
        liveParts.push(sendType === 'i' ? String(finalVal) : finalVal.toFixed(3))
      }

      this.sender.sendMany(cell.destIp, cell.destPort, cell.oscAddress, outs as OscArg[])
      this.recordLiveValue(ts.activeSceneId ?? '', trackId, liveParts.join(' '))

      if (ts.stopping && morphP >= 1) this.disarm(ts)
    }

    // Throttle live-value emits to ~20Hz to keep IPC cheap.
    if (t - this.lastValueEmitAt >= 50) {
      this.lastValueEmitAt = t
      this.emitState()
    }
  }

  private recordLiveValue(sceneId: string, trackId: string, value: string): void {
    if (!sceneId) return
    let row = this.liveValues[sceneId]
    if (!row) {
      row = {}
      this.liveValues[sceneId] = row
    }
    row[trackId] = value
  }

  private disarm(ts: TrackState): void {
    const wasScene = ts.activeSceneId
    // Drop the live-value entry so the cell tile stops "ghost-displaying".
    if (wasScene && this.liveValues[wasScene]) {
      for (const tid of Object.keys(this.liveValues[wasScene])) {
        if (this.tracks.get(tid) === ts) delete this.liveValues[wasScene][tid]
      }
    }
    ts.armed = false
    ts.stopping = false
    ts.activeSceneId = null
    // If a scene was "held open" (duration expired but modulation kept it alive),
    // clear activeSceneId now that the last active cell has stopped.
    if (
      wasScene &&
      this.activeSceneId === wasScene &&
      this.sceneAdvanceTimer === null &&
      !this.sceneHasOngoingActivity(wasScene)
    ) {
      this.activeSceneId = null
      this.activeSceneStartedAt = null
      this.activeSequenceSlotIdx = null
    }
    this.emitState()
  }

  private currentSceneDurationSec(sceneId: string | null): number {
    if (!this.session || !sceneId) return 5
    const sc = this.session.scenes.find((s) => s.id === sceneId)
    return sc?.durationSec ?? 5
  }

  private getActiveCell(trackId: string): Cell | null {
    const ts = this.tracks.get(trackId)
    if (!ts || !ts.activeSceneId || !this.session) return null
    const scene = this.session.scenes.find((s) => s.id === ts.activeSceneId)
    return scene?.cells[trackId] ?? null
  }

  private computeCurrentOutputs(trackId: string): number[] {
    const ts = this.tracks.get(trackId)
    if (!ts || !this.session) return []
    const cell = this.getActiveCell(trackId)
    const t = now()
    const morphP = ts.morphMs > 0 ? clamp((t - ts.morphStart) / ts.morphMs, 0, 1) : 1

    if (!cell) {
      // No active cell — interpolate existing fromCenter → toCenter.
      return ts.fromCenter.map((from, i) => {
        const to = ts.toCenter[i] ?? 0
        return from + (to - from) * morphP
      })
    }

    const baseRaw = cell.sequencer.enabled
      ? cell.sequencer.stepValues[ts.seqStepIdx] ?? cell.value
      : cell.value
    const targetsRaw = numericBasesFromRaw(baseRaw)
    const targets = cell.scaleToUnit ? targetsRaw.map(clamp01) : targetsRaw

    let modNorm = 0
    let envGain = 1
    let rampGain = 1
    if (cell.modulation.enabled) {
      if (cell.modulation.type === 'envelope') {
        envGain = computeEnvelopeGain(
          cell.modulation.envelope,
          (t - ts.triggerTime) / 1000,
          this.currentSceneDurationSec(ts.activeSceneId)
        )
      } else if (cell.modulation.type === 'ramp') {
        rampGain = computeRampGain(
          cell.modulation.ramp,
          (t - ts.triggerTime) / 1000,
          this.currentSceneDurationSec(ts.activeSceneId)
        )
      } else {
        modNorm = computeModNorm(
          cell.modulation,
          ts,
          this.tickIdx,
          (t - ts.triggerTime) / 1000,
          this.currentSceneDurationSec(ts.activeSceneId),
          this.session.globalBpm
        )
      }
    }
    const depth = cell.modulation.depthPct / 100

    const outs: number[] = []
    for (let i = 0; i < targets.length; i++) {
      let center: number
      if (cell.sequencer.enabled) {
        const from = ts.fromCenter[i] ?? 0
        center = morphP < 1 ? from + (targets[i] - from) * morphP : targets[i]
      } else {
        const from = ts.fromCenter[i] ?? 0
        const to = ts.toCenter[i] ?? targets[i]
        center = from + (to - from) * morphP
      }
      let out = center
      if (cell.modulation.enabled) {
        if (cell.modulation.type === 'envelope') {
          out = center * (1 - depth + depth * envGain)
        } else if (cell.modulation.type === 'ramp') {
          out = center * (1 - depth + depth * rampGain)
        } else if (cell.modulation.type === 'arpeggiator') {
          const arp = cell.modulation.arpeggiator
          const N = Math.max(1, Math.min(8, arp.steps))
          let ladder = buildArpLadder(center, N, arp.multMode)
          let dryCenter = center
          if (cell.scaleToUnit) {
            const maxAbs = ladder.reduce(
              (m, v) => (Math.abs(v) > m ? Math.abs(v) : m),
              0
            )
            if (maxAbs > 0) {
              ladder = ladder.map((v) => v / maxAbs)
              dryCenter = center / maxAbs
            }
          }
          const stepVal =
            ladder[Math.max(0, Math.min(N - 1, ts.arpStepIdx))] ?? dryCenter
          out = dryCenter * (1 - depth) + stepVal * depth
        } else {
          const magnitude = Math.max(Math.abs(center), 1) * depth
          out = center + modNorm * magnitude
        }
      }
      if (cell.scaleToUnit) out = clamp01(out)
      outs.push(out)
    }
    return outs
  }
}

function now(): number {
  const t = process.hrtime()
  return t[0] * 1000 + t[1] / 1e6
}

function clamp01(v: number): number {
  if (!Number.isFinite(v)) return 0
  return v < 0 ? 0 : v > 1 ? 1 : v
}

function pad(arr: number[], length: number, fill: number): number[] {
  if (arr.length >= length) return arr.slice(0, length)
  const out = arr.slice()
  while (out.length < length) out.push(fill)
  return out
}

function numericBasesFromRaw(raw: string): number[] {
  return parseValueTokens(raw).map((t) => readNumber(t) ?? 0)
}

// ---- Random Generator ----

/**
 * Draw the next sample from a seeded PRNG.
 *  - int / float: returns `tokenCount` numbers (one per space-separated entry
 *    in the cell's Value field).
 *  - colour: returns `3 * tokenCount` numbers — each entry becomes its own
 *    r, g, b triplet.
 *
 * Values are in raw "rng-space" (pre-rounding / pre-scale); the caller rounds
 * to int / quantizes to the OSC type + applies Scale 0.0-1.0 clamping.
 */
function sampleRandom(
  rng: () => number,
  rnd: { valueType: 'int' | 'float' | 'colour'; min: number; max: number },
  tokenCount: number
): number[] {
  const lo = Math.min(rnd.min, rnd.max)
  const hi = Math.max(rnd.min, rnd.max)
  const range = hi - lo
  const pick = (): number => lo + rng() * range
  const total = rnd.valueType === 'colour' ? 3 * Math.max(1, tokenCount) : Math.max(1, tokenCount)
  const out: number[] = new Array(total)
  for (let i = 0; i < total; i++) out[i] = pick()
  return out
}

// ---- Arpeggiator advance / init ----

function arpStartStep(arp: {
  steps: number
  arpMode: import('@shared/types').ArpMode
}): number {
  const N = Math.max(1, Math.min(8, arp.steps))
  if (arp.arpMode === 'random') return Math.floor(Math.random() * N)
  if (arp.arpMode === 'walk' || arp.arpMode === 'drunk') return 0
  // Deterministic: start at pattern[0].
  const pat = buildArpPattern(arp.arpMode, N)
  return pat[0] ?? 0
}

function advanceArpStep(
  ts: TrackState,
  arp: { steps: number; arpMode: import('@shared/types').ArpMode }
): void {
  const N = Math.max(1, Math.min(8, arp.steps))
  if (arp.arpMode === 'random') {
    ts.arpStepIdx = Math.floor(Math.random() * N)
    return
  }
  if (arp.arpMode === 'walk') {
    // ±1 with reflection at the edges.
    const dir = Math.random() < 0.5 ? -1 : 1
    let next = ts.arpStepIdx + dir
    if (next < 0) next = 1 < N ? 1 : 0
    else if (next >= N) next = N >= 2 ? N - 2 : 0
    ts.arpStepIdx = next
    return
  }
  if (arp.arpMode === 'drunk') {
    // Jump by ±1..3, reflect within bounds.
    const mag = 1 + Math.floor(Math.random() * 3)
    const dir = Math.random() < 0.5 ? -1 : 1
    let next = ts.arpStepIdx + mag * dir
    while (next < 0 || next >= N) {
      if (next < 0) next = -next
      if (next >= N) next = 2 * (N - 1) - next
    }
    ts.arpStepIdx = Math.max(0, Math.min(N - 1, next))
    return
  }
  // Deterministic pattern-based advance.
  const pat = buildArpPattern(arp.arpMode, N)
  if (pat.length === 0) return
  ts.arpPatternIdx = (ts.arpPatternIdx + 1) % pat.length
  ts.arpStepIdx = pat[ts.arpPatternIdx] ?? 0
}

// Combined modulation output, mapped to the cell's mode:
//   unipolar → [0, 1]   → pushes output from `center` up to `center+magnitude`
//   bipolar  → [-1, 1]  → pushes output within [center-magnitude, center+magnitude]
function computeModNorm(
  m: Modulation,
  ts: TrackState,
  tickIdx: number,
  elapsedSec: number,
  sceneDurSec: number,
  _bpm: number
): number {
  if (m.type === 'envelope') {
    // Envelope is naturally unipolar 0..1.
    const g = computeEnvelopeGain(m.envelope, elapsedSec, sceneDurSec)
    return m.mode === 'bipolar' ? 2 * g - 1 : g
  }
  // S&H — emit held value (optionally cosine-smoothed from prev → held).
  // Tick-loop advances the clock/sample; here we just read the state.
  if (m.type === 'sh') {
    let raw: number
    if (m.sh.smooth) {
      const effHz = effectiveLfoHz(m, _bpm)
      const periodMs = effHz > 0 ? 1000 / effHz : 1
      // Approximate progress across the current step using time since last
      // advance. ts.shLastAdvanceAt was set to the start of the current
      // sample; phase-in over the full period via cosine.
      // NB: we can't read `t` here; computeModNorm is called from inside
      // the tick, so elapsed-since-advance is the step progress.
      const nowMs = elapsedSec * 1000 + ts.triggerTime
      const into = nowMs - ts.shLastAdvanceAt
      // Half-period cosine so k goes 0 → 1 monotonically across the step.
      // Previously multiplied by 2π, which made k return to 0 at t=1 —
      // output oscillated prev → held → prev inside every sample period
      // instead of smoothly interpolating prev → held.
      const k = 0.5 - 0.5 * Math.cos(Math.max(0, Math.min(1, into / periodMs)) * Math.PI)
      raw = ts.shPrev * (1 - k) + ts.shHeld * k
    } else {
      raw = ts.shHeld
    }
    if (m.mode === 'bipolar') return raw
    return (raw + 1) / 2
  }
  if (m.type === 'slew') {
    const raw = ts.slewValue
    if (m.mode === 'bipolar') return raw
    return (raw + 1) / 2
  }
  if (m.type === 'chaos') {
    // Map (0, 1) to (-1, 1). chaosX stays away from the endpoints thanks to
    // the sanity clamp in the tick-loop advancement.
    const raw = ts.chaosX * 2 - 1
    if (m.mode === 'bipolar') return raw
    return ts.chaosX // already 0..1
  }
  // LFO (default fallthrough)
  const raw = lfo(m.shape, ts.phase, ts, tickIdx) // -1..1
  if (m.mode === 'bipolar') return raw
  return (raw + 1) / 2 // 0..1
}

// ADSR with A, D, S (hold), R. Times in seconds (converted from ms or scene %).
function computeEnvelopeGain(
  env: { attackMs: number; decayMs: number; sustainMs: number; releaseMs: number;
         attackPct: number; decayPct: number; sustainPct: number; releasePct: number;
         sustainLevel: number; sync: 'synced' | 'free' | 'freeSync'; totalMs: number },
  elapsedSec: number,
  sceneDurSec: number
): number {
  let a: number, d: number, s: number, r: number
  if (env.sync === 'synced' || env.sync === 'freeSync') {
    // Fractions of a reference duration — scene for 'synced', a user-picked
    // Total(ms) for 'freeSync'. Same math, different base.
    const baseSec =
      env.sync === 'synced'
        ? sceneDurSec
        : Math.max(0.0001, (env.totalMs ?? 0) / 1000)
    const totalPct = Math.max(
      0.0001,
      env.attackPct + env.decayPct + env.sustainPct + env.releasePct
    )
    const scale = totalPct > 1 ? 1 / totalPct : 1
    a = env.attackPct * scale * baseSec
    d = env.decayPct * scale * baseSec
    s = env.sustainPct * scale * baseSec
    r = env.releasePct * scale * baseSec
  } else {
    a = env.attackMs / 1000
    d = env.decayMs / 1000
    s = env.sustainMs / 1000
    r = env.releaseMs / 1000
  }
  const sl = Math.max(0, Math.min(1, env.sustainLevel))
  const t = elapsedSec
  if (t <= 0) return 0
  if (t < a) return a > 0 ? t / a : 1 // attack 0→1
  const tAfterA = t - a
  if (tAfterA < d) return d > 0 ? 1 + (sl - 1) * (tAfterA / d) : sl // decay 1→sl
  const tAfterD = tAfterA - d
  if (tAfterD < s) return sl // sustain hold
  const tAfterS = tAfterD - s
  if (tAfterS < r) return r > 0 ? sl * (1 - tAfterS / r) : 0 // release sl→0
  return 0
}

// One-shot ramp modulator. 0 → 1 over the configured ramp length, then
// holds at 1 forever. `curvePct` bends the interpolation via a power curve:
//    curve = 1                 → linear (curvePct = 0)
//    curve = 1 + curvePct/100  → ease-in / ease-out shaped pow
//  positive curvePct = ease-out (fast start, slow finish)
//  negative curvePct = ease-in (slow start, fast finish)
// The caller multiplies the result by the cell's depth % (see main tick).
function computeRampGain(
  ramp: { rampMs: number; curvePct: number; sync: 'synced' | 'free' | 'freeSync'; totalMs: number },
  elapsedSec: number,
  sceneDurSec: number
): number {
  let lenSec: number
  if (ramp.sync === 'synced') {
    lenSec = Math.max(0.0001, sceneDurSec)
  } else if (ramp.sync === 'freeSync') {
    lenSec = Math.max(0.0001, (ramp.totalMs ?? 0) / 1000)
  } else {
    lenSec = Math.max(0.0001, (ramp.rampMs ?? 0) / 1000)
  }
  if (elapsedSec <= 0) return 0
  if (elapsedSec >= lenSec) return 1
  const lin = elapsedSec / lenSec
  const curve = ramp.curvePct ?? 0
  if (curve === 0) return lin
  // Classic power-curve pair — rotationally symmetric around (0.5, 0.5):
  //   curve > 0 → ease-out  y = 1 - (1-t)^k   (fast start, slow tail)
  //   curve < 0 → ease-in   y = t^k           (slow start, fast finish)
  // Both grow the exponent the same way (k = 1..5) so ±curve magnitudes
  // produce mirror-image shapes, not mathematical inverses (which looked
  // lopsided when rendered next to each other in the visualizer).
  const k = 1 + (Math.abs(curve) / 100) * 4
  return curve > 0 ? 1 - Math.pow(1 - lin, k) : Math.pow(lin, k)
}
