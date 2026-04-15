import { create } from 'zustand'
import type { Cell, EngineState, Scene, Session, Track } from '@shared/types'
import {
  DEFAULT_ARPEGGIATOR,
  DEFAULT_ENVELOPE,
  DEFAULT_MODULATION,
  DEFAULT_RANDOM,
  DEFAULT_SEQUENCER,
  makeCell,
  makeEmptySession,
  makeScene,
  makeTrack
} from '@shared/factory'

// ---- Clip templates: persisted in localStorage so they survive app restarts.

const TEMPLATES_KEY = 'dataflou:clipTemplates:v1'

function loadTemplates(): ClipTemplate[] {
  try {
    const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(TEMPLATES_KEY) : null
    if (!raw) return []
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    // Soft-validate: each entry needs id, name, cell.
    return parsed.filter(
      (t): t is ClipTemplate =>
        t && typeof t.id === 'string' && typeof t.name === 'string' && t.cell
    )
  } catch {
    return []
  }
}

function saveTemplates(templates: ClipTemplate[]): void {
  try {
    if (typeof localStorage === 'undefined') return
    localStorage.setItem(TEMPLATES_KEY, JSON.stringify(templates))
  } catch {
    /* quota exceeded / disabled storage — silently ignore */
  }
}

export interface ClipTemplate {
  id: string
  name: string
  cell: Cell
}

interface UiState {
  // UI-only
  view: 'edit' | 'sequence'
  selectedCell: { sceneId: string; trackId: string } | null
  selectedTrack: string | null
  currentFilePath: string | null
  engine: EngineState
  clipTemplates: ClipTemplate[]
  // Shared height of the scene-notes textarea in pixels. Drives header height
  // across all scene columns + the track sidebar so rows stay aligned.
  editorNotesHeight: number
  // Resizable layout dimensions.
  rowHeight: number // 40..220
  sceneColumnWidth: number // 140..480
  trackColumnWidth: number // 160..400
  inspectorWidth: number // 280..640
  // Sequence transport pause state (local — just UI; engine has its own flag).
  sequencePaused: boolean
  // Global MIDI Learn mode. When on, scene/track trigger clicks select that
  // element as the learn target; the next incoming MIDI message binds it.
  midiLearnMode: boolean
  midiLearnTarget:
    | { kind: 'scene'; id: string }
    | { kind: 'cell'; sceneId: string; trackId: string }
    | null
  // Theme is a UI preference, not saved in the session file.
  theme: ThemeName
  scenesCollapsed: boolean
  tracksCollapsed: boolean
}

export type ThemeName =
  | 'dark'
  | 'light'
  | 'pastel'
  | 'reaper'
  | 'smooth'
  | 'hydra'
  | 'darkside'
  | 'solaris'
  | 'flame'
  | 'analog'

interface Actions {
  // Session-level
  setSession: (s: Session) => void
  newSession: () => void
  setCurrentFilePath: (p: string | null) => void
  setName: (name: string) => void
  setTickRate: (hz: number) => void
  setDefaults: (fields: Partial<Pick<Session, 'defaultOscAddress' | 'defaultDestIp' | 'defaultDestPort'>>) => void
  setMidiInputName: (name: string | null) => void
  setFocusedScene: (id: string | null) => void
  setView: (v: 'edit' | 'sequence') => void

  // Tracks
  addTrack: () => void
  removeTrack: (id: string) => void
  renameTrack: (id: string, name: string) => void
  setTrackMidi: (id: string, binding: Track['midiTrigger']) => void
  setTrackDefaults: (
    id: string,
    fields: Partial<Pick<Track, 'defaultOscAddress' | 'defaultDestIp' | 'defaultDestPort'>>
  ) => void
  sendTrackDefaultsToClips: (id: string) => void

  // Scenes
  addScene: () => void
  removeScene: (id: string) => void
  updateScene: (id: string, patch: Partial<Scene>) => void
  setSceneMidi: (id: string, binding: Scene['midiTrigger']) => void

  // Cells
  ensureCell: (sceneId: string, trackId: string) => void
  removeCell: (sceneId: string, trackId: string) => void
  updateCell: (sceneId: string, trackId: string, patch: Partial<Cell>) => void
  duplicateCell: (
    fromSceneId: string,
    fromTrackId: string,
    toSceneId: string,
    toTrackId: string
  ) => void
  // Address / dest default linking helpers
  setAddressToDefault: (sceneId: string, trackId: string) => void
  setDestToDefault: (sceneId: string, trackId: string) => void

  // Sequence matrix
  setSequenceSlot: (index: number, sceneId: string | null) => void

  // UI
  selectCell: (sceneId: string, trackId: string) => void
  selectTrack: (id: string | null) => void
  setEditorNotesHeight: (h: number) => void
  setRowHeight: (h: number) => void
  setSceneColumnWidth: (w: number) => void
  setTrackColumnWidth: (w: number) => void
  setInspectorWidth: (w: number) => void
  setSequencePaused: (paused: boolean) => void
  setMidiLearnMode: (on: boolean) => void
  setMidiLearnTarget: (
    t:
      | { kind: 'scene'; id: string }
      | { kind: 'cell'; sceneId: string; trackId: string }
      | null
  ) => void
  setTheme: (t: ThemeName) => void
  setScenesCollapsed: (v: boolean) => void
  setTracksCollapsed: (v: boolean) => void
  setGlobalBpm: (bpm: number) => void
  setSequenceLength: (n: number) => void

  // Clip templates
  saveClipAsTemplate: (sceneId: string, trackId: string, name: string) => void
  applyClipTemplate: (sceneId: string, trackId: string, templateId: string) => void
  deleteClipTemplate: (id: string) => void

  // Engine state mirror
  setEngineState: (s: EngineState) => void
}

type State = { session: Session } & UiState & Actions

const emptyEngineState: EngineState = {
  activeBySceneAndTrack: {},
  seqStepBySceneAndTrack: {},
  currentValueBySceneAndTrack: {},
  activeSceneId: null,
  activeSceneStartedAt: null,
  tickRateHz: 30
}

export const useStore = create<State>((set, get) => ({
  session: makeEmptySession(),
  view: 'edit',
  selectedCell: null,
  selectedTrack: null,
  currentFilePath: null,
  engine: emptyEngineState,
  editorNotesHeight: 36,
  rowHeight: 76,
  sceneColumnWidth: 200,
  trackColumnWidth: 240,
  inspectorWidth: 340,
  sequencePaused: false,
  midiLearnMode: false,
  midiLearnTarget: null,
  theme: 'dark',
  scenesCollapsed: false,
  tracksCollapsed: false,
  clipTemplates: loadTemplates(),

  setSession: (s) => set({ session: propagateDefaults(s) }),
  newSession: () =>
    set({
      session: makeEmptySession(),
      selectedCell: null,
      currentFilePath: null
    }),
  setCurrentFilePath: (p) => set({ currentFilePath: p }),
  setName: (name) => set((st) => ({ session: { ...st.session, name } })),
  setTickRate: (hz) => set((st) => ({ session: { ...st.session, tickRateHz: clampInt(hz, 10, 300) } })),
  setDefaults: (fields) =>
    set((st) => ({
      session: propagateDefaults({
        ...st.session,
        ...fields
      })
    })),
  setMidiInputName: (name) => set((st) => ({ session: { ...st.session, midiInputName: name } })),
  setFocusedScene: (id) => set((st) => ({ session: { ...st.session, focusedSceneId: id } })),
  setView: (v) => set({ view: v }),

  addTrack: () =>
    set((st) => {
      if (st.session.tracks.length >= 128) return st
      const track = makeTrack(st.session.tracks.length)
      return { session: { ...st.session, tracks: [...st.session.tracks, track] } }
    }),
  removeTrack: (id) =>
    set((st) => {
      const tracks = st.session.tracks.filter((t) => t.id !== id)
      const scenes = st.session.scenes.map((s) => {
        const { [id]: _drop, ...rest } = s.cells
        return { ...s, cells: rest }
      })
      return {
        session: { ...st.session, tracks, scenes },
        selectedTrack: st.selectedTrack === id ? null : st.selectedTrack,
        selectedCell: st.selectedCell?.trackId === id ? null : st.selectedCell
      }
    }),
  renameTrack: (id, name) =>
    set((st) => ({
      session: {
        ...st.session,
        tracks: st.session.tracks.map((t) => (t.id === id ? { ...t, name } : t))
      }
    })),
  setTrackMidi: (id, binding) =>
    set((st) => ({
      session: {
        ...st.session,
        tracks: st.session.tracks.map((t) => (t.id === id ? { ...t, midiTrigger: binding } : t))
      }
    })),
  setTrackDefaults: (id, fields) =>
    set((st) => ({
      session: {
        ...st.session,
        tracks: st.session.tracks.map((t) => (t.id === id ? { ...t, ...fields } : t))
      }
    })),
  sendTrackDefaultsToClips: (id) =>
    set((st) => {
      const track = st.session.tracks.find((t) => t.id === id)
      if (!track) return st
      const addr = track.defaultOscAddress
      const ip = track.defaultDestIp
      const port = track.defaultDestPort
      // Fall back to session defaults for anything the Message didn't specify,
      // so newly-created cells still have valid destinations.
      const effIp = ip && ip !== '' ? ip : st.session.defaultDestIp
      const effPort = port && port > 0 ? port : st.session.defaultDestPort
      const effAddr = addr && addr !== '' ? addr : st.session.defaultOscAddress
      return {
        session: {
          ...st.session,
          scenes: st.session.scenes.map((s) => {
            const existing = s.cells[id]
            if (!existing) {
              // Auto-create a new clip on this scene using the Message defaults.
              const created = makeCell({
                destIp: effIp,
                destPort: effPort,
                oscAddress: effAddr
              })
              // Mark fields as unlinked if the Message specified them explicitly,
              // so they don't silently re-link to the session defaults.
              if (ip) created.destLinkedToDefault = false
              if (port) created.destLinkedToDefault = false
              if (addr) created.addressLinkedToDefault = false
              return { ...s, cells: { ...s.cells, [id]: created } }
            }
            const next: Cell = { ...existing }
            if (addr !== undefined && addr !== '') {
              next.oscAddress = addr
              next.addressLinkedToDefault = false
            }
            if (ip !== undefined && ip !== '') {
              next.destIp = ip
              next.destLinkedToDefault = false
            }
            if (port !== undefined && port > 0) {
              next.destPort = port
              next.destLinkedToDefault = false
            }
            return { ...s, cells: { ...s.cells, [id]: next } }
          })
        }
      }
    }),

  addScene: () =>
    set((st) => {
      if (st.session.scenes.length >= 128) return st
      const scene = makeScene(st.session.scenes.length)
      const sequence = [...st.session.sequence]
      const idx = sequence.findIndex((v) => v === null)
      if (idx >= 0) sequence[idx] = scene.id
      return { session: { ...st.session, scenes: [...st.session.scenes, scene], sequence } }
    }),
  removeScene: (id) =>
    set((st) => ({
      session: {
        ...st.session,
        scenes: st.session.scenes.filter((s) => s.id !== id),
        sequence: st.session.sequence.map((v) => (v === id ? null : v)),
        focusedSceneId: st.session.focusedSceneId === id ? null : st.session.focusedSceneId
      },
      // Clear selection if it pointed at this scene — otherwise Inspector crashes.
      selectedCell: st.selectedCell?.sceneId === id ? null : st.selectedCell
    })),
  updateScene: (id, patch) =>
    set((st) => ({
      session: {
        ...st.session,
        scenes: st.session.scenes.map((s) => (s.id === id ? { ...s, ...patch } : s))
      }
    })),
  setSceneMidi: (id, binding) =>
    set((st) => ({
      session: {
        ...st.session,
        scenes: st.session.scenes.map((s) =>
          s.id === id ? { ...s, midiTrigger: binding } : s
        )
      }
    })),

  ensureCell: (sceneId, trackId) =>
    set((st) => ({
      session: {
        ...st.session,
        scenes: st.session.scenes.map((s) => {
          if (s.id !== sceneId) return s
          if (s.cells[trackId]) return s
          return {
            ...s,
            cells: {
              ...s.cells,
              [trackId]: makeCell({
                destIp: st.session.defaultDestIp,
                destPort: st.session.defaultDestPort,
                oscAddress: st.session.defaultOscAddress
              })
            }
          }
        })
      }
    })),
  removeCell: (sceneId, trackId) =>
    set((st) => ({
      session: {
        ...st.session,
        scenes: st.session.scenes.map((s) => {
          if (s.id !== sceneId) return s
          const { [trackId]: _drop, ...rest } = s.cells
          return { ...s, cells: rest }
        })
      }
    })),
  updateCell: (sceneId, trackId, patch) =>
    set((st) => ({
      session: {
        ...st.session,
        scenes: st.session.scenes.map((s) => {
          if (s.id !== sceneId) return s
          const cell = s.cells[trackId]
          if (!cell) return s
          const merged = { ...cell, ...patch }
          // If user edited address directly, unlink default.
          if (patch.oscAddress !== undefined) merged.addressLinkedToDefault = false
          if (patch.destIp !== undefined || patch.destPort !== undefined) {
            merged.destLinkedToDefault = false
          }
          return { ...s, cells: { ...s.cells, [trackId]: merged } }
        })
      }
    })),
  duplicateCell: (fromSceneId, fromTrackId, toSceneId, toTrackId) =>
    set((st) => {
      const src = st.session.scenes.find((s) => s.id === fromSceneId)?.cells[fromTrackId]
      if (!src) return st
      const copy: Cell = {
        ...src,
        modulation: { ...src.modulation },
        sequencer: { ...src.sequencer, stepValues: [...src.sequencer.stepValues] }
      }
      return {
        session: {
          ...st.session,
          scenes: st.session.scenes.map((s) => {
            if (s.id !== toSceneId) return s
            return { ...s, cells: { ...s.cells, [toTrackId]: copy } }
          })
        }
      }
    }),
  setAddressToDefault: (sceneId, trackId) =>
    set((st) => ({
      session: {
        ...st.session,
        scenes: st.session.scenes.map((s) => {
          if (s.id !== sceneId) return s
          const cell = s.cells[trackId]
          if (!cell) return s
          return {
            ...s,
            cells: {
              ...s.cells,
              [trackId]: {
                ...cell,
                oscAddress: st.session.defaultOscAddress,
                addressLinkedToDefault: true
              }
            }
          }
        })
      }
    })),
  setDestToDefault: (sceneId, trackId) =>
    set((st) => ({
      session: {
        ...st.session,
        scenes: st.session.scenes.map((s) => {
          if (s.id !== sceneId) return s
          const cell = s.cells[trackId]
          if (!cell) return s
          return {
            ...s,
            cells: {
              ...s.cells,
              [trackId]: {
                ...cell,
                destIp: st.session.defaultDestIp,
                destPort: st.session.defaultDestPort,
                destLinkedToDefault: true
              }
            }
          }
        })
      }
    })),

  setSequenceSlot: (index, sceneId) =>
    set((st) => {
      const seq = [...st.session.sequence]
      seq[index] = sceneId
      return { session: { ...st.session, sequence: seq } }
    }),

  selectCell: (sceneId, trackId) =>
    set({ selectedCell: { sceneId, trackId }, selectedTrack: null }),
  selectTrack: (id) => set({ selectedTrack: id, selectedCell: null }),
  setEditorNotesHeight: (h) => set({ editorNotesHeight: clampInt(h, 0, 240) }),
  setRowHeight: (h) => set({ rowHeight: clampInt(h, 30, 220) }),
  setSceneColumnWidth: (w) => set({ sceneColumnWidth: clampInt(w, 180, 480) }),
  setTrackColumnWidth: (w) => set({ trackColumnWidth: clampInt(w, 160, 400) }),
  setInspectorWidth: (w) => set({ inspectorWidth: clampInt(w, 320, 640) }),
  setSequencePaused: (paused) => set({ sequencePaused: paused }),
  setMidiLearnMode: (on) =>
    set({ midiLearnMode: on, midiLearnTarget: on ? null : null }),
  setMidiLearnTarget: (t) => set({ midiLearnTarget: t }),
  setTheme: (t) => set({ theme: t }),
  setScenesCollapsed: (v) => set({ scenesCollapsed: v }),
  setTracksCollapsed: (v) => set({ tracksCollapsed: v }),
  setGlobalBpm: (bpm) =>
    set((st) => ({
      session: { ...st.session, globalBpm: clampFloat(bpm, 10, 500) }
    })),
  setSequenceLength: (n) =>
    set((st) => ({ session: { ...st.session, sequenceLength: clampInt(n, 1, 128) } })),

  saveClipAsTemplate: (sceneId, trackId, name) =>
    set((st) => {
      const cell = st.session.scenes.find((s) => s.id === sceneId)?.cells[trackId]
      if (!cell) return st
      const cleaned: Cell = {
        ...cell,
        modulation: { ...cell.modulation },
        sequencer: { ...cell.sequencer, stepValues: [...cell.sequencer.stepValues] }
      }
      const tpl: ClipTemplate = {
        id: 'tpl_' + Math.random().toString(36).slice(2, 10),
        name: name.trim() || 'Untitled',
        cell: cleaned
      }
      return { clipTemplates: [...st.clipTemplates, tpl] }
    }),
  applyClipTemplate: (sceneId, trackId, templateId) =>
    set((st) => {
      const tpl = st.clipTemplates.find((t) => t.id === templateId)
      if (!tpl) return st
      const cell: Cell = {
        ...tpl.cell,
        modulation: { ...tpl.cell.modulation },
        sequencer: { ...tpl.cell.sequencer, stepValues: [...tpl.cell.sequencer.stepValues] }
      }
      return {
        session: {
          ...st.session,
          scenes: st.session.scenes.map((s) =>
            s.id === sceneId ? { ...s, cells: { ...s.cells, [trackId]: cell } } : s
          )
        }
      }
    }),
  deleteClipTemplate: (id) =>
    set((st) => ({ clipTemplates: st.clipTemplates.filter((t) => t.id !== id) })),

  setEngineState: (s) => set({ engine: s })
}))

// Persist clipTemplates whenever they change. Referential check skips writes
// from unrelated state updates (engine ticks etc) — the templates array is
// always replaced when modified, so identity-equality is a reliable signal.
let lastTemplates: ClipTemplate[] = useStore.getState().clipTemplates
useStore.subscribe((state) => {
  if (state.clipTemplates !== lastTemplates) {
    lastTemplates = state.clipTemplates
    saveTemplates(state.clipTemplates)
  }
})

function clampInt(v: number, lo: number, hi: number): number {
  const n = Math.round(v)
  return n < lo ? lo : n > hi ? hi : n
}

function clampFloat(v: number, lo: number, hi: number): number {
  if (!Number.isFinite(v)) return lo
  return v < lo ? lo : v > hi ? hi : v
}

function propagateDefaults(s: Session): Session {
  return {
    ...s,
    globalBpm: typeof s.globalBpm === 'number' ? s.globalBpm : 120,
    sequenceLength: typeof s.sequenceLength === 'number' ? s.sequenceLength : 32,
    // Soft-migrate scenes: `notes` is new; fall back to '' if missing.
    scenes: s.scenes.map((sc) => ({
      ...sc,
      notes: sc.notes ?? '',
      cells: Object.fromEntries(
        Object.entries(sc.cells).map(([tid, c]) => {
          const m = c.modulation as Partial<typeof DEFAULT_MODULATION> | undefined
          const env = m?.envelope as Partial<typeof DEFAULT_ENVELOPE> | undefined
          const out: Cell = {
            ...c,
            // Soft-migrate sequencer for sessions saved before this feature existed.
            sequencer: c.sequencer
              ? {
                  ...c.sequencer,
                  // Legacy 'sync' value used the per-clip bpm slider — that's
                  // now 'tempo'. Preserve old behavior for existing sessions.
                  syncMode:
                    (c.sequencer.syncMode as string) === 'sync'
                      ? 'tempo'
                      : c.sequencer.syncMode,
                  stepValues: [...c.sequencer.stepValues]
                }
              : { ...DEFAULT_SEQUENCER, stepValues: [...DEFAULT_SEQUENCER.stepValues] },
            scaleToUnit: typeof c.scaleToUnit === 'boolean' ? c.scaleToUnit : false,
            // Migrate modulation fields — older sessions lack type/mode/sync/etc.
            modulation: {
              enabled: !!m?.enabled,
              type: m?.type ?? 'lfo',
              shape: m?.shape ?? DEFAULT_MODULATION.shape,
              mode: m?.mode ?? DEFAULT_MODULATION.mode,
              depthPct: typeof m?.depthPct === 'number' ? m.depthPct : DEFAULT_MODULATION.depthPct,
              rateHz: typeof m?.rateHz === 'number' ? m.rateHz : DEFAULT_MODULATION.rateHz,
              sync: m?.sync ?? DEFAULT_MODULATION.sync,
              divisionIdx:
                typeof m?.divisionIdx === 'number' ? m.divisionIdx : DEFAULT_MODULATION.divisionIdx,
              dotted: !!m?.dotted,
              triplet: !!m?.triplet,
              envelope: {
                attackMs: env?.attackMs ?? DEFAULT_ENVELOPE.attackMs,
                decayMs: env?.decayMs ?? DEFAULT_ENVELOPE.decayMs,
                sustainMs: env?.sustainMs ?? DEFAULT_ENVELOPE.sustainMs,
                releaseMs: env?.releaseMs ?? DEFAULT_ENVELOPE.releaseMs,
                attackPct: env?.attackPct ?? DEFAULT_ENVELOPE.attackPct,
                decayPct: env?.decayPct ?? DEFAULT_ENVELOPE.decayPct,
                sustainPct: env?.sustainPct ?? DEFAULT_ENVELOPE.sustainPct,
                releasePct: env?.releasePct ?? DEFAULT_ENVELOPE.releasePct,
                sustainLevel: env?.sustainLevel ?? DEFAULT_ENVELOPE.sustainLevel,
                sync: env?.sync ?? DEFAULT_ENVELOPE.sync
              },
              arpeggiator: {
                steps: (m?.arpeggiator as Partial<typeof DEFAULT_ARPEGGIATOR> | undefined)?.steps ?? DEFAULT_ARPEGGIATOR.steps,
                arpMode:
                  (m?.arpeggiator as Partial<typeof DEFAULT_ARPEGGIATOR> | undefined)?.arpMode ??
                  DEFAULT_ARPEGGIATOR.arpMode,
                multMode:
                  (m?.arpeggiator as Partial<typeof DEFAULT_ARPEGGIATOR> | undefined)?.multMode ??
                  DEFAULT_ARPEGGIATOR.multMode
              },
              random: {
                valueType:
                  (m?.random as Partial<typeof DEFAULT_RANDOM> | undefined)?.valueType ??
                  DEFAULT_RANDOM.valueType,
                min:
                  (m?.random as Partial<typeof DEFAULT_RANDOM> | undefined)?.min ??
                  DEFAULT_RANDOM.min,
                max:
                  (m?.random as Partial<typeof DEFAULT_RANDOM> | undefined)?.max ??
                  DEFAULT_RANDOM.max
              }
            }
          }
          if (c.addressLinkedToDefault) out.oscAddress = s.defaultOscAddress
          if (c.destLinkedToDefault) {
            out.destIp = s.defaultDestIp
            out.destPort = s.defaultDestPort
          }
          return [tid, out]
        })
      )
    }))
  }
}
