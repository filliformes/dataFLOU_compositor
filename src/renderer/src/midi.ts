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
    if (!data || data.length < 2) return
    const status = data[0] & 0xf0
    const channel = data[0] & 0x0f
    let binding: MidiBinding | null = null
    if (status === 0x90 && (data[2] ?? 0) > 0) {
      binding = { kind: 'note', channel, number: data[1] }
    } else if (status === 0xb0 && (data[2] ?? 0) > 0) {
      binding = { kind: 'cc', channel, number: data[1] }
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
      } else {
        st.updateCell(target.sceneId, target.trackId, { midiTrigger: binding })
      }
      st.setMidiLearnTarget(null)
      return
    }
    // While in learn mode with no target selected, ignore normal triggers so
    // the user's controller doesn't fire scenes unexpectedly.
    if (st.midiLearnMode) return

    // Normal mode — match against bindings in current session.
    const session = st.session
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
          window.api.triggerScene(s.id)
        }
        return
      }
    }
    // (Message rows are NOT routable via MIDI — per the app spec, only scene
    // triggers and individual clip triggers are MIDI-bindable.)
  }
}

function matches(a: MidiBinding | undefined, b: MidiBinding): boolean {
  if (!a) return false
  return a.kind === b.kind && a.channel === b.channel && a.number === b.number
}

export const midi = new MidiManager()
