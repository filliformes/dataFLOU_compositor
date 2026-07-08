// Web MIDI integration. Runs entirely in the renderer.
//
// Responsibilities:
//  - Request MIDI access once on app start
//  - Enumerate & track connected inputs (react to devices added/removed)
//  - Route incoming messages: either feed a pending "learn" resolver OR
//    match against track/scene bindings and fire IPC triggers via window.api
//  - Simple pub-sub so components can re-render when device list changes

import type { MidiBinding } from '@shared/types'
import { useStore } from './store'
import { setKnobTarget } from './metaSmooth'

export interface MidiDevice {
  id: string
  name: string
}

type LearnResolver = (b: MidiBinding) => void

/** Raw MIDI message forwarded to the Capture popup. Strips down to
 *  the fields the capture buffer cares about: status nibble (CC vs
 *  Note On vs Note Off), channel 0..15, number (CC# or note), and
 *  value (CC value or velocity). */
export interface MidiCaptureMessage {
  kind: 'cc' | 'noteOn' | 'noteOff'
  channel: number
  number: number
  value: number
}

class MidiManager {
  private access: MIDIAccess | null = null
  private openedId: string | null = null
  private learnCb: LearnResolver | null = null
  // Capture popup subscriber. When non-null, every incoming MIDI
  // CC / Note On / Note Off is forwarded here in addition to the
  // normal routing (so the user can still see real-time feedback
  // on bound knobs while the popup buffers events).
  private captureCb: ((m: MidiCaptureMessage) => void) | null = null
  private listeners = new Set<(devs: MidiDevice[]) => void>()

  async init(): Promise<boolean> {
    if (!navigator.requestMIDIAccess) {
      console.warn('[MIDI] Web MIDI not available')
      return false
    }
    try {
      this.access = await navigator.requestMIDIAccess({ sysex: false })
    } catch (e) {
      console.warn('[MIDI] access denied', e)
      return false
    }
    this.access.onstatechange = (): void => this.notifyListeners()
    // Re-open persisted device if name matches.
    const prev = useStore.getState().session.midiInputName
    if (prev) this.open(prev)
    this.notifyListeners()
    return true
  }

  listDevices(): MidiDevice[] {
    if (!this.access) return []
    const out: MidiDevice[] = []
    this.access.inputs.forEach((input) => {
      out.push({ id: input.id, name: input.name ?? input.id })
    })
    return out
  }

  open(name: string | null): boolean {
    if (!this.access) return false
    // Close previously opened.
    this.access.inputs.forEach((inp) => {
      if (inp.id === this.openedId) inp.onmidimessage = null
    })
    this.openedId = null
    if (!name) return true
    let found: MIDIInput | null = null
    this.access.inputs.forEach((inp) => {
      if ((inp.name ?? inp.id) === name) found = inp
    })
    if (!found) return false
    ;(found as MIDIInput).onmidimessage = (e: MIDIMessageEvent): void => this.onMessage(e)
    this.openedId = (found as MIDIInput).id
    return true
  }

  subscribe(cb: (devs: MidiDevice[]) => void): () => void {
    this.listeners.add(cb)
    return () => this.listeners.delete(cb)
  }

  private notifyListeners(): void {
    const devs = this.listDevices()
    this.listeners.forEach((l) => l(devs))
  }

  beginLearn(cb: LearnResolver): void {
    this.learnCb = cb
  }

  cancelLearn(): void {
    this.learnCb = null
  }

  /** Subscribe to raw CC / Note events for the Capture popup. Pass
   *  null to unsubscribe. Only one capture subscriber at a time
   *  (the popup is a singleton). */
  setCaptureCb(cb: ((m: MidiCaptureMessage) => void) | null): void {
    this.captureCb = cb
  }

  private onMessage(e: MIDIMessageEvent): void {
    const data = e.data
    if (!data || data.length < 3) return
    const status = data[0] & 0xf0
    const channel = data[0] & 0x0f
    const number = data[1]
    const value = data[2] ?? 0
    // Capture forwarding — fires for every CC + Note On + Note Off
    // regardless of whether anything is bound. The popup buffers
    // events into its UI list; normal routing below continues so
    // the user's live MIDI control isn't interrupted while they
    // capture.
    if (this.captureCb) {
      if (status === 0xb0) {
        this.captureCb({ kind: 'cc', channel, number, value })
      } else if (status === 0x90 && value > 0) {
        this.captureCb({ kind: 'noteOn', channel, number, value })
      } else if (status === 0x80 || (status === 0x90 && value === 0)) {
        this.captureCb({ kind: 'noteOff', channel, number, value })
      }
    }
    let binding: MidiBinding | null = null
    // Build a binding from any Note-On or CC message. We do NOT filter out
    // CC value 0 here — knobs need the full 0..127 range (CC0 = knob fully
    // down). Trigger routing below still only acts on value > 0 so a
    // controller button's release edge doesn't double-fire scenes/cells.
    if (status === 0x90 && value > 0) {
      binding = { kind: 'note', channel, number }
    } else if (status === 0xb0) {
      binding = { kind: 'cc', channel, number }
    }
    if (!binding) return

    // Explicit per-element learn (legacy) wins first.
    if (this.learnCb) {
      const cb = this.learnCb
      this.learnCb = null
      cb(binding)
      return
    }

    const st = useStore.getState()

    // Global Ableton-style MIDI Learn: if a target is selected, bind it and
    // stay in learn mode so the user can immediately map the next control.
    if (st.midiLearnMode && st.midiLearnTarget) {
      const target = st.midiLearnTarget
      if (target.kind === 'scene') {
        st.setSceneMidi(target.id, binding)
      } else if (target.kind === 'cell') {
        st.updateCell(target.sceneId, target.trackId, { midiTrigger: binding })
      } else if (target.kind === 'instrument') {
        st.setInstrumentTriggerMidi(target.sceneId, target.templateRowId, binding)
      } else if (target.kind === 'metaKnob') {
        // Knobs are CC-only in practice. If someone hits a note while a knob
        // is the learn target we ignore it so they can keep trying.
        if (binding.kind !== 'cc') return
        st.setMetaKnobMidi(target.index, binding)
      } else if (target.kind === 'go') {
        // GO can be fired by either a pad (note) or a button/CC — accept both.
        st.setGoMidi(binding)
      } else if (target.kind === 'morphTime') {
        // Morph time is a continuous value — only CCs make sense. Ignore
        // notes so the user can keep trying with a knob/slider.
        if (binding.kind !== 'cc') return
        st.setMorphTimeMidi(binding)
      } else if (target.kind === 'generativeToggle') {
        // Toggle target accepts notes (pad) or CCs (button). Engine
        // reads value > 0 in the fire path so it acts on press, not
        // release.
        st.setGenerativeToggleMidi(binding)
      } else if (target.kind === 'generativeNoRepeat') {
        st.setGenerativeNoRepeatMidi(binding)
      } else if (target.kind === 'generativeUseMorph') {
        st.setGenerativeUseMorphMidi(binding)
      } else if (target.kind === 'generativeRandomWeights') {
        // Random Weights is a momentary fire (any press rolls fresh
        // weights). Accept either kind so a pad or button works.
        st.setRandomWeightsMidi(binding)
      } else if (target.kind === 'generativeAffinity') {
        // Continuous slider -- only CCs make sense.
        if (binding.kind !== 'cc') return
        st.setGenerativeAffinityMidi(binding)
      } else if (target.kind === 'generativeMinDuration') {
        if (binding.kind !== 'cc') return
        st.setGenerativeMinDurationMidi(binding)
      } else if (target.kind === 'generativeMaxDuration') {
        if (binding.kind !== 'cc') return
        st.setGenerativeMaxDurationMidi(binding)
      } else if (target.kind === 'motionLoopRecord') {
        // Record toggle — accept a pad (note) or a footswitch/button (CC).
        // Fires on press (value > 0) in the match path below.
        st.setMotionLoopRecordMidi(binding)
      }
      st.setMidiLearnTarget(null)
      return
    }
    // While in learn mode with no target selected, ignore normal triggers so
    // the user's controller doesn't fire scenes unexpectedly.
    if (st.midiLearnMode) return

    // Normal mode — match against bindings in current session.
    const session = st.session

    // Meta Controller knobs — check FIRST so knob CCs don't also match a
    // scene/cell bound to the same CC number (knob routing is continuous;
    // trigger routing would be wrong here). Only CC messages match knobs.
    //
    // Routing goes through the renderer-side smoother: commit the new target
    // to the session so it persists (and the knob's logical `value` stays
    // in sync), then call setKnobTarget which tweens the display + fires
    // OSC at each frame. The dial you see on screen is the same value the
    // engine is sending — smoothing is visible everywhere.
    if (binding.kind === 'cc') {
      const knobs = session.metaController.knobs
      for (let i = 0; i < knobs.length; i++) {
        if (matches(knobs[i].midiCc, binding)) {
          const normalized = value / 127
          st.setMetaKnobValueFromMidi(i, normalized)
          setKnobTarget(i, normalized, knobs[i].smoothMs)
          return
        }
      }
      // Morph-time CC — continuous mapping from 0..127 to 0..10 000 ms.
      // 10 seconds is a sensible live-performance maximum. Users wanting
      // longer glides set the time manually in the transport. (Could
      // become a curve/range setting later if someone asks.)
      if (session.morphTimeMidi && matches(session.morphTimeMidi, binding)) {
        const ms = Math.round((value / 127) * 10000)
        st.setMorphMs(ms)
        // Auto-enable Morph so twisting the mapped CC actually has effect
        // the first time. Users can still disable manually; we only flip
        // ON, never OFF, on a CC event.
        if (!st.morphEnabled) st.setMorphEnabled(true)
        return
      }
      // ── Generative continuous-control CCs (v0.5.10) ──────────
      // Affinity: 0..127 mapped linearly to -100..+100, with the
      // midpoint snapping exactly to 0 (so a centred-knob controller
      // gives "pure random" instead of slightly biased).
      const gen = session.generative
      if (gen?.affinityMidi && matches(gen.affinityMidi, binding)) {
        // 0..127 -> -100..+100 with 64 snapping to 0.
        let affinity: number
        if (value === 64) affinity = 0
        else affinity = Math.round(((value - 64) / 63) * 100)
        st.setGenerativeAffinity(
          Math.max(-100, Math.min(100, affinity))
        )
        return
      }
      if (gen?.minDurationMidi && matches(gen.minDurationMidi, binding)) {
        // 0..127 -> [GENERATIVE_DURATION_MIN_MS, GENERATIVE_DURATION_MAX_MS].
        // Use a quadratic curve so the bottom of the range has more
        // resolution (5s precision in the first half, 5min..10min in
        // the top half).
        const t = value / 127
        const ms = 100 + Math.round(t * t * (600000 - 100))
        st.setGenerativeMinDurationMs(ms)
        return
      }
      if (gen?.maxDurationMidi && matches(gen.maxDurationMidi, binding)) {
        const t = value / 127
        const ms = 100 + Math.round(t * t * (600000 - 100))
        st.setGenerativeMaxDurationMs(ms)
        return
      }
    }

    // Triggers (scenes/cells) only fire on value > 0 so a CC's release edge
    // (or zero-velocity note-off smuggled through) doesn't double-fire.
    if (value <= 0) return

    // Transport GO — a bound note/CC fires the armed cue (if any) via the
    // same path as clicking the button. No-op when nothing's armed so a
    // footswitch press with no cue doesn't do anything surprising.
    if (session.goMidi && matches(session.goMidi, binding)) {
      if (st.armedSceneId) st.fireArmed()
      return
    }

    // Motion Loop record toggle (v0.6.x) — a bound pad/footswitch toggles
    // recording on the focused scene, identical to clicking the transport
    // ●REC. Fires on press (value > 0 gated above).
    if (
      session.motionLoopRecordMidi &&
      matches(session.motionLoopRecordMidi, binding)
    ) {
      st.toggleMotionLoopRecordFocused()
      return
    }

    // ── Generative discrete-control bindings (v0.5.10) ─────────────
    // Note/CC bindings on the toggles + Random Weights. Each fires
    // on press (value > 0 is already gated above).
    {
      const gen = session.generative
      if (gen?.toggleMidi && matches(gen.toggleMidi, binding)) {
        st.setGenerativeEnabled(!(gen.enabled === true))
        return
      }
      if (gen?.noRepeatMidi && matches(gen.noRepeatMidi, binding)) {
        st.setGenerativeNoRepeat(!(gen.noRepeat === true))
        return
      }
      if (gen?.useMorphMidi && matches(gen.useMorphMidi, binding)) {
        st.setGenerativeUseMorph(!(gen.useMorph === true))
        return
      }
      if (gen?.randomWeightsMidi && matches(gen.randomWeightsMidi, binding)) {
        st.rollRandomWeights()
        return
      }
    }

    // Cell triggers first (per-clip binding).
    for (const sc of session.scenes) {
      for (const [trackId, cell] of Object.entries(sc.cells)) {
        if (matches(cell.midiTrigger, binding)) {
          const active = !!st.engine.activeBySceneAndTrack[sc.id]?.[trackId]
          if (active) window.api.stopCell(sc.id, trackId)
          else window.api.triggerCell(sc.id, trackId)
          return
        }
      }
    }
    // Instrument-group triggers — fire every child Parameter cell on
    // the scene at once. Mirrors the click handler in
    // InstrumentTriggerCell. Stops if any child is active, otherwise
    // triggers every child that has a clip on this scene.
    for (const sc of session.scenes) {
      const groupMap = sc.instrumentTriggers
      if (!groupMap) continue
      for (const [templateRowId, b] of Object.entries(groupMap)) {
        if (!matches(b, binding)) continue
        const childIds = session.tracks
          .filter((t) => t.parentTrackId === templateRowId)
          .map((t) => t.id)
        const active = childIds.some(
          (id) => !!st.engine.activeBySceneAndTrack[sc.id]?.[id]
        )
        if (active) {
          for (const id of childIds) {
            if (st.engine.activeBySceneAndTrack[sc.id]?.[id]) {
              window.api.stopCell(sc.id, id)
            }
          }
        } else {
          for (const id of childIds) {
            if (sc.cells[id]) window.api.triggerCell(sc.id, id)
          }
        }
        return
      }
    }
    // Scene triggers
    for (const s of session.scenes) {
      if (matches(s.midiTrigger, binding)) {
        if (st.engine.activeSceneId === s.id) {
          window.api.stopAll()
        } else {
          // Go through the morph-aware helper so MIDI-triggered scenes
          // honor the transport-level / per-scene Morph settings too.
          useStore.getState().triggerSceneWithMorph(s.id)
        }
        return
      }
    }
    // (Message rows are NOT routable via MIDI — per the app spec, only scene
    // triggers, individual clip triggers, and Meta Controller knobs are
    // MIDI-bindable.)
  }
}

function matches(a: MidiBinding | undefined, b: MidiBinding): boolean {
  if (!a) return false
  return a.kind === b.kind && a.channel === b.channel && a.number === b.number
}

export const midi = new MidiManager()
