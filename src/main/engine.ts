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
import {
  autoDetectOscArg,
  buildArpLadder,
  buildArpPattern,
  effectiveLfoHz,
  hashSeedString,
  mulberry32,
  parseValueTokens,
  readNumber
} from '@shared/factory'
import { OscSender } from './osc'

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
      // One new value per LFO period. "Period" is measured in ticks because
      // rate is already incorporated into phase; a new step fires when phase wraps.
      // Tracked via tick index the last time we wrapped.
      if (state.rndStepLastTick !== tickIdx) {
        // This check is not perfect but good enough; reset on phase wrap.
      }
      return state.rndStepValue
    }
    case 'rndSmooth': {
      // Cosine interpolation between prev and next over one period.
      const k = 0.5 - 0.5 * Math.cos(p * TWO_PI)
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

  triggerCell(sceneId: string, trackId: string): void {
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
      ts.morphMs = cell.transitionMs
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
      ts.lastSentString = null
      ts.lastStringAtSceneId = null
      ts.lastStringAtStep = -1
      this.emitState()
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

  private beginStop(trackId: string): void {
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
    ts.morphMs = cell?.transitionMs ?? 0
    ts.stopping = true
    this.emitState()
  }

  stopScene(sceneId: string): void {
    if (!this.session) return
    // Stop any track whose active cell is currently in this scene.
    for (const [tid, ts] of this.tracks.entries()) {
      if (ts.armed && ts.activeSceneId === sceneId) this.beginStop(tid)
    }
    if (this.activeSceneId === sceneId) {
      this.activeSceneId = null
      this.clearSceneAdvance()
    }
    this.emitState()
  }

  pauseSequence(): void {
    // Freeze auto-advance without stopping cells. Cells keep playing/modulating.
    this.clearSceneAdvance()
  }

  resumeSequence(): void {
    if (!this.session) return
    // Re-arm from the current active scene's full duration (simple approach).
    const id = this.activeSceneId
    if (!id) return
    const scene = this.session.scenes.find((s) => s.id === id)
    if (scene) this.armSceneAdvance(scene)
  }

  triggerScene(sceneId: string): void {
    if (!this.session) return
    const scene = this.session.scenes.find((s) => s.id === sceneId)
    if (!scene) return
    for (const trackId of Object.keys(scene.cells)) {
      this.triggerCell(sceneId, trackId)
    }
    this.activeSceneId = sceneId
    this.activeSceneStartedAt = Date.now()
    this.armSceneAdvance(scene)
    this.emitState()
  }

  private armSceneAdvance(scene: Scene): void {
    this.clearSceneAdvance()
    this.sceneAdvanceTimer = setTimeout(() => {
      if (scene.nextMode === 'off') {
        // Only clear the active-scene flag if no cell in this scene is still
        // "doing something" (modulating or sequencing). Otherwise keep it held
        // until the last active cell stops — matches the user's requested
        // "except when modulation or sequencer is playing" carve-out.
        if (!this.sceneHasOngoingActivity(scene.id)) {
          this.activeSceneId = null
          this.activeSceneStartedAt = null
        }
        this.emitState()
      } else {
        this.advanceScene(scene)
      }
    }, scene.durationSec * 1000)
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
    const len = Math.max(1, Math.min(128, this.session.sequenceLength ?? 128))
    const seq = this.session.sequence.slice(0, len)
    const presentInSeq = seq.filter((id): id is string => !!id)
    if (presentInSeq.length === 0) return
    let nextId: string | null = null
    if (current.nextMode === 'next') {
      const start = seq.findIndex((id) => id === current.id)
      if (start < 0) {
        nextId = presentInSeq[0]
      } else {
        for (let i = 1; i <= seq.length; i++) {
          const idx = (start + i) % seq.length
          if (seq[idx]) {
            nextId = seq[idx]
            break
          }
        }
      }
    } else if (current.nextMode === 'random') {
      const pool = presentInSeq.filter((id) => id !== current.id)
      const pick = pool.length ? pool[Math.floor(Math.random() * pool.length)] : presentInSeq[0]
      nextId = pick
    }
    if (nextId) this.triggerScene(nextId)
  }

  stopAll(): void {
    for (const [tid, ts] of this.tracks.entries()) {
      if (ts.armed || ts.delayTimer) this.beginStop(tid)
    }
    this.clearSceneAdvance()
    this.activeSceneId = null
    this.activeSceneStartedAt = null
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
    this.emitState()
  }

  // ----- Ticking -----

  private startTicker(): void {
    if (!this.session) {
      // Kick off at 30Hz default until session arrives.
      this.tickTimer = setInterval(() => this.tick(), 1000 / 30)
      return
    }
    const hz = clamp(this.session.tickRateHz, 10, 100)
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
    const dt = this.lastTickAt === 0 ? 0 : (t - this.lastTickAt) / 1000
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
      if (cell.modulation.enabled && !ts.stopping) {
        if (cell.modulation.type === 'envelope') {
          envGain = computeEnvelopeGain(
            cell.modulation.envelope,
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
    if (cell.modulation.enabled) {
      if (cell.modulation.type === 'envelope') {
        envGain = computeEnvelopeGain(
          cell.modulation.envelope,
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
  // LFO
  const raw = lfo(m.shape, ts.phase, ts, tickIdx) // -1..1
  if (m.mode === 'bipolar') return raw
  return (raw + 1) / 2 // 0..1
}

// ADSR with A, D, S (hold), R. Times in seconds (converted from ms or scene %).
function computeEnvelopeGain(
  env: { attackMs: number; decayMs: number; sustainMs: number; releaseMs: number;
         attackPct: number; decayPct: number; sustainPct: number; releasePct: number;
         sustainLevel: number; sync: 'synced' | 'free' },
  elapsedSec: number,
  sceneDurSec: number
): number {
  let a: number, d: number, s: number, r: number
  if (env.sync === 'synced') {
    // Fractions of scene duration. Normalize so they never exceed the scene.
    const totalPct = Math.max(
      0.0001,
      env.attackPct + env.decayPct + env.sustainPct + env.releasePct
    )
    const scale = totalPct > 1 ? 1 / totalPct : 1
    a = env.attackPct * scale * sceneDurSec
    d = env.decayPct * scale * sceneDurSec
    s = env.sustainPct * scale * sceneDurSec
    r = env.releasePct * scale * sceneDurSec
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
