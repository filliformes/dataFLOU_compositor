// MIDI binding conflict detection.
//
// Multiple targets (scenes, clips, Instrument group triggers, Meta
// knobs, GO, Morph time, Motion Loop record, Generative controls) can
// accidentally end up bound to the same MIDI message — e.g. the user
// learns a pad for Scene 1 and later learns the same pad for GO. When
// the MIDI arrives, midi.ts routes to the FIRST match it finds, so one
// of them silently fails to trigger. This module indexes every binding
// in the current session and returns the sets that collide.
//
// Runs on-demand (store subscribe) from the banner UI rather than
// every-tick, since it's O(scenes × tracks + knobs) and session changes
// are relatively rare.

import type { MidiBinding, Session } from '@shared/types'

export interface MidiConflictTarget {
  /** Human-readable label, e.g. "Scene: Ramp Up" or "Clip: Intro · Synth 1". */
  label: string
  /** Where to navigate the user to resolve the conflict (optional). */
  navigate?:
    | { kind: 'scene'; id: string }
    | { kind: 'cell'; sceneId: string; trackId: string }
    | { kind: 'metaKnob'; index: number }
    | { kind: 'go' }
    | { kind: 'morphTime' }
}

export interface MidiConflict {
  /** Stable key identifying the colliding MIDI message, e.g. "cc:0:1". */
  key: string
  /** Human-readable representation: "CC 1 · ch 1" or "Note 60 · ch 1". */
  binding: string
  /** All targets currently bound to this message. */
  targets: MidiConflictTarget[]
}

function bindingKey(b: MidiBinding): string {
  return `${b.kind}:${b.channel}:${b.number}`
}

function bindingLabel(b: MidiBinding): string {
  const prefix = b.kind === 'cc' ? `CC ${b.number}` : `Note ${b.number}`
  return `${prefix} · ch ${b.channel + 1}`
}

/**
 * Walk every MIDI-routable target in the session and group them by their
 * binding key. Keys with 2+ targets are conflicts. Returns an empty array
 * when there are no conflicts.
 */
export function detectMidiConflicts(session: Session): MidiConflict[] {
  const byKey = new Map<string, { binding: MidiBinding; targets: MidiConflictTarget[] }>()

  function add(b: MidiBinding | undefined, target: MidiConflictTarget): void {
    if (!b) return
    const key = bindingKey(b)
    const bucket = byKey.get(key) ?? { binding: b, targets: [] }
    bucket.targets.push(target)
    byKey.set(key, bucket)
  }

  // Scene triggers
  for (const s of session.scenes) {
    add(s.midiTrigger, {
      label: `Scene: ${s.name || '(unnamed)'}`,
      navigate: { kind: 'scene', id: s.id }
    })
    // Clip triggers (nested)
    for (const [trackId, cell] of Object.entries(s.cells)) {
      const track = session.tracks.find((t) => t.id === trackId)
      add(cell.midiTrigger, {
        label: `Clip: ${s.name || '(scene)'} · ${track?.name ?? '(msg)'}`,
        navigate: { kind: 'cell', sceneId: s.id, trackId }
      })
    }
    // Instrument group triggers (header-row × scene). No per-cell
    // target to jump to — focus the scene.
    for (const [templateRowId, b] of Object.entries(s.instrumentTriggers ?? {})) {
      const row = session.tracks.find((t) => t.id === templateRowId)
      add(b, {
        label: `Instrument trigger: ${s.name || '(scene)'} · ${row?.name ?? '(instrument)'}`,
        navigate: { kind: 'scene', id: s.id }
      })
    }
  }

  // Meta knobs
  session.metaController.knobs.forEach((k, i) => {
    add(k.midiCc, {
      label: `Knob ${i + 1}${k.name ? ` · ${k.name}` : ''}`,
      navigate: { kind: 'metaKnob', index: i }
    })
  })

  // Transport bindings
  add(session.goMidi, {
    label: 'Transport: GO',
    navigate: { kind: 'go' }
  })
  add(session.morphTimeMidi, {
    label: 'Transport: Morph time',
    navigate: { kind: 'morphTime' }
  })
  add(session.motionLoopRecordMidi, { label: 'Transport: Motion Loop record' })

  // Generative controls (popover / transport — no navigation target)
  const gen = session.generative
  add(gen?.toggleMidi, { label: 'Generative: On/Off' })
  add(gen?.noRepeatMidi, { label: 'Generative: No repeat' })
  add(gen?.useMorphMidi, { label: 'Generative: Use Morph' })
  add(gen?.randomWeightsMidi, { label: 'Generative: Random Weights' })
  add(gen?.affinityMidi, { label: 'Generative: Affinity' })
  add(gen?.minDurationMidi, { label: 'Generative: Min duration' })
  add(gen?.maxDurationMidi, { label: 'Generative: Max duration' })

  const conflicts: MidiConflict[] = []
  for (const [key, { binding, targets }] of byKey) {
    if (targets.length > 1) {
      conflicts.push({ key, binding: bindingLabel(binding), targets })
    }
  }
  return conflicts
}
