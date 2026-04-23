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

class MidiManager {
  private access: MIDIAccess | null = null
  private openedId: string | null = null
  private learnCb: LearnResolver | null = null
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

  private onMessage(e: MIDIMessageEvent): void {
    const data = e.data
    if (!data || data.length < 3) return
    const status = data[0] & 0xf0
    const channel = data[0] & 0x0f
    const number = data[1]
    const value = data[2] ?? 0
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
