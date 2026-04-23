import { create } from 'zustand'
import type {
  Cell,
  EngineState,
  MetaController,
  MetaCurve,
  MetaDest,
  MetaKnob,
  MidiBinding,
  NextMode,
  RampParams,
  Scene,
  Session,
  Track
} from '@shared/types'
import { META_KNOB_COUNT, META_MAX_DESTS } from '@shared/types'
import {
  DEFAULT_ARPEGGIATOR,
  DEFAULT_ENVELOPE,
  DEFAULT_MODULATION,
  DEFAULT_RAMP,
  DEFAULT_RANDOM,
  DEFAULT_SEQUENCER,
  META_DEFAULT_SMOOTH_MS,
  META_MAX_HEIGHT,
  META_MAX_SMOOTH_MS,
  META_MIN_HEIGHT,
  makeCell,
  makeEmptySession,
  makeMetaController,
  makeMetaKnob,
  makeScene,
  makeTrack
} from '@shared/factory'

// ---- Clip templates: persisted in localStorage so they survive app restarts.

const TEMPLATES_KEY = 'dataflou:clipTemplates:v1'

// ---- UI scale: persisted in localStorage. Controls Ctrl+wheel zoom of
// everything below the main toolbar. Clamped to [UI_SCALE_MIN, UI_SCALE_MAX]
// so the user can't accidentally render the app unusable (too small or huge).
const UI_SCALE_KEY = 'dataflou:uiScale:v1'
export const UI_SCALE_MIN = 0.5
export const UI_SCALE_MAX = 2.0
export const UI_SCALE_STEP = 0.05

function loadUiScale(): number {
  try {
    const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(UI_SCALE_KEY) : null
    const n = raw == null ? NaN : parseFloat(raw)
    return Number.isFinite(n) && n >= UI_SCALE_MIN && n <= UI_SCALE_MAX ? n : 1
  } catch {
    return 1
  }
}
function saveUiScale(v: number): void {
  try {
    if (typeof localStorage === 'undefined') return
    localStorage.setItem(UI_SCALE_KEY, String(v))
  } catch {
    /* quota / disabled — ignore */
  }
}

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
  // Primary (anchor) selected message — used by Inspector etc. Null when
  // no message is selected or when a cell is selected instead.
  selectedTrack: string | null
  // Full multi-selection set (shift-click extends range). Always contains
  // `selectedTrack` when non-empty. Empty = nothing selected.
  selectedTrackIds: string[]
  // Full multi-selection set for scenes (Ctrl-click extends range). Always
  // contains `session.focusedSceneId` when non-empty. Anchor lives in the
  // session because it survives save/load; the set is ephemeral UI state.
  selectedSceneIds: string[]
  // Multi-selection set for clips (Ctrl+click toggles disjoint membership).
  // Always contains `selectedCell` when non-empty. Used for bulk template
  // apply + "Use Default OSC" from the clip right-click menu.
  selectedCells: { sceneId: string; trackId: string }[]
  currentFilePath: string | null
  engine: EngineState
  clipTemplates: ClipTemplate[]
  // Per-knob displayed position (normalized 0..1) as interpolated by the
  // renderer-side smoothing module. The engine doesn't see this — the
  // smoother passes interpolated values to main via sendMetaValue on each
  // tween frame. Separate from session.metaController.knobs[i].value so we
  // don't fire a zustand session update on every animation frame.
  metaKnobDisplayValues: number[]
  // Global UI zoom (Ctrl+wheel). 1 = 100%. Applied to everything below the
  // main toolbar via a `zoom` CSS wrapper so the top bar stays at its
  // natural size. Persisted in localStorage.
  uiScale: number
  // Shared height of the scene-notes textarea in pixels. Drives header height
  // across all scene columns + the track sidebar so rows stay aligned.
  editorNotesHeight: number
  // Resizable layout dimensions.
  rowHeight: number // 40..220
  sceneColumnWidth: number // 140..480
  // Width of the Sequence view's left column (scene palette + info panel).
  // 200..480; default 280. Drag the handle on the column's right edge.
  scenePaletteWidth: number
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
    | { kind: 'metaKnob'; index: number }
    // Global transport-level learn targets. Bindings live on the Session
    // itself (goMidi, morphTimeMidi) so they travel with the project file.
    | { kind: 'go' }
    | { kind: 'morphTime' }
    | null
  // Theme is a UI preference, not saved in the session file.
  theme: ThemeName
  scenesCollapsed: boolean
  tracksCollapsed: boolean
  showMode: boolean
  // OSC monitor drawer — bottom-of-app panel that streams outgoing OSC
  // messages (address, ip:port, args) for debugging. Off by default; when
  // closed the monitor component unmounts so no state accumulates.
  oscMonitorOpen: boolean
  // Live-performance "cue" — the scene primed to fire on the next GO. UI-
  // only (not saved in the session) because arming is a concern of the
  // current run, not of the composition. Re-opening a session the next day
  // should leave nothing armed.
  armedSceneId: string | null
  // When true, firing the armed scene automatically arms the next non-empty
  // slot in the sequence. Turns a linear show into Space-Space-Space.
  autoAdvanceArm: boolean
  // Transport-level Morph — when enabled, every scene trigger glides each
  // cell's output over this many milliseconds instead of snapping. Scene-
  // level `morphInMs` (per-scene) takes precedence if set. UI-only (not
  // persisted in the session — it's a performance setting). The enabled
  // flag separates "off / no morph" from "0 ms" (an intentional snap).
  morphEnabled: boolean
  morphMs: number
  // Transport time counter (bottom-right of the StatusBar). Play starts /
  // resumes the counter; Pause freezes it; Stop resets to 0. Stored as
  // (startedAt, accumulatedMs) — when running, current elapsed is
  // accumulatedMs + (now - startedAt). When paused/stopped, startedAt is
  // null and elapsed is just accumulatedMs (or 0 after Stop).
  transportStartedAt: number | null
  transportAccumulatedMs: number
}

// Height (px) assigned to the scene-notes textarea when the Notes toggle
// turns notes ON. Matches one line of the textarea's line-height so the user
// gets a single-line strip by default; they can drag it taller from the
// in-editor handle if they want more.
export const NOTES_ONE_LINE_HEIGHT = 26

export type ThemeName =
  // New themes (listed first in the picker).
  | 'studio-dark'
  | 'warm-charcoal'
  | 'graphite'
  | 'cream'
  | 'paper-light'
  // Original themes.
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
  // Ctrl-click: add/remove this clip from the disjoint multi-selection.
  // The primary selection (`selectedCell`) follows the most recent toggle
  // so the Inspector etc. stay in sync.
  toggleCellSelection: (sceneId: string, trackId: string) => void
  // Replace OSC address + destination on every cell in `refs` with the
  // session's CURRENT defaults. Used by the right-click "Use Default OSC"
  // menu item on multi-selected clips. Also re-sets `addressLinkedToDefault`
  // / `destLinkedToDefault` to true so a future default change still
  // follows the freeze-on-change rule (i.e., next default change freezes
  // them at the value we just wrote).
  applyDefaultOscToCells: (refs: { sceneId: string; trackId: string }[]) => void
  selectTrack: (id: string | null) => void
  // Shift-click: selects all tracks from the current anchor (selectedTrack)
  // through `id` inclusive. If there's no anchor yet, behaves like a plain
  // selectTrack.
  selectTrackRange: (id: string) => void
  // Bulk delete — used by the right-click context menu when N tracks are
  // selected. Safer than calling removeTrack in a loop because it also
  // clears selection state in one pass.
  removeTracks: (ids: string[]) => void
  // Ctrl-click range selection for scenes. Extends from the current
  // focusedSceneId (anchor) through `id` inclusive. If there's no anchor
  // yet, behaves like a plain setFocusedScene.
  selectSceneRange: (id: string) => void
  // Bulk delete scenes — used by the right-click context menu when N scenes
  // are selected. Clears each scene from the sequence array too.
  removeScenes: (ids: string[]) => void
  setEditorNotesHeight: (h: number) => void
  setRowHeight: (h: number) => void
  setSceneColumnWidth: (w: number) => void
  setScenePaletteWidth: (w: number) => void
  setTrackColumnWidth: (w: number) => void
  setInspectorWidth: (w: number) => void
  setSequencePaused: (paused: boolean) => void
  setMidiLearnMode: (on: boolean) => void
  setMidiLearnTarget: (
    t:
      | { kind: 'scene'; id: string }
      | { kind: 'cell'; sceneId: string; trackId: string }
      | { kind: 'metaKnob'; index: number }
      | { kind: 'go' }
      | { kind: 'morphTime' }
      | null
  ) => void
  // Write/clear transport-level MIDI bindings (stored on the session so
  // they persist with the project).
  setGoMidi: (b: MidiBinding | undefined) => void
  setMorphTimeMidi: (b: MidiBinding | undefined) => void
  setTheme: (t: ThemeName) => void
  setScenesCollapsed: (v: boolean) => void
  setTracksCollapsed: (v: boolean) => void
  setShowMode: (v: boolean) => void
  setOscMonitorOpen: (v: boolean) => void
  // Arm a scene for the next GO. Pass null to clear.
  setArmedSceneId: (id: string | null) => void
  setAutoAdvanceArm: (v: boolean) => void
  setMorphEnabled: (v: boolean) => void
  setMorphMs: (ms: number) => void
  // Resolve the morph-ms that should apply when triggering `sceneId` right
  // now: per-scene override > transport > undefined. Exposed so call sites
  // (fireArmed, keyboard triggers, click triggers) all follow the same
  // precedence rules.
  resolveMorphMs: (sceneId: string) => number | undefined
  // Fire-and-forget scene trigger that always applies the current morph
  // resolution. Every scene-firing call site (Space, 1-0 keys, GO button,
  // scene-column play button, palette play, MIDI-triggered scene, etc.)
  // should go through this so users get consistent morph behavior.
  triggerSceneWithMorph: (sceneId: string) => void
  // Fire the armed scene (if any) and clear the arm. If autoAdvanceArm is
  // on, find the next non-empty sequence slot after the one we just fired
  // and arm it immediately. Returns the scene id that was fired, or null.
  fireArmed: () => string | null
  // Transport-time control. Each corresponds to the Play/Pause/Stop button
  // in the StatusBar. `transportPlay` is idempotent — a second Play while
  // already running is a no-op (doesn't reset the clock).
  transportPlay: () => void
  transportPause: () => void
  transportStop: () => void
  setGlobalBpm: (bpm: number) => void
  setSequenceLength: (n: number) => void

  // Clip templates
  saveClipAsTemplate: (sceneId: string, trackId: string, name: string) => void
  applyClipTemplate: (sceneId: string, trackId: string, templateId: string) => void
  deleteClipTemplate: (id: string) => void

  // Meta Controller — global knob bank with up to 8 OSC destinations per knob.
  setMetaControllerVisible: (v: boolean) => void
  setMetaControllerHeight: (h: number) => void
  setMetaSelectedKnob: (idx: number) => void
  updateMetaKnob: (idx: number, patch: Partial<MetaKnob>) => void
  addMetaDestination: (knobIdx: number) => void
  removeMetaDestination: (knobIdx: number, destIdx: number) => void
  updateMetaDestination: (knobIdx: number, destIdx: number, patch: Partial<MetaDest>) => void
  // MIDI-learn bind / clear for a knob. Binding is always a CC in practice
  // (see MetaKnob.midiCc); the helper accepts `null` to clear.
  setMetaKnobMidi: (knobIdx: number, binding: MidiBinding | null) => void
  // Normalized 0..1 value written by the MIDI router when a bound CC comes
  // in. Commits the knob to session state so it persists and re-renders
  // update. Does NOT itself fire OSC — the midi router calls
  // window.api.sendMetaValue() alongside this to push OSC.
  setMetaKnobValueFromMidi: (knobIdx: number, value: number) => void
  // Batch-replace the ephemeral display values (drives the knob UI). Called
  // by metaSmooth.ts on every tween frame.
  setMetaKnobDisplayValues: (values: number[]) => void
  setUiScale: (s: number) => void

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
  selectedCells: [],
  selectedTrack: null,
  selectedTrackIds: [],
  selectedSceneIds: [],
  currentFilePath: null,
  engine: emptyEngineState,
  // Scene notes height in the editor. 0 = hidden (default). The Notes
  // toggle in the TrackSidebar "buttons box" flips this between 0 and
  // NOTES_ONE_LINE_HEIGHT so the user sees exactly one line of text when
  // they turn notes on. They can drag the in-editor handle to grow it further.
  editorNotesHeight: 0,
  rowHeight: 76,
  sceneColumnWidth: 200,
  // 360 px default — wide enough for DUR + NEXT + × multiplicator inputs
  // to all fit on one row in the Sequence-tab scene inspector. Users can
  // drag the right edge to grow / shrink (clamped 200..480).
  scenePaletteWidth: 360,
  trackColumnWidth: 240,
  inspectorWidth: 340,
  sequencePaused: false,
  midiLearnMode: false,
  midiLearnTarget: null,
  theme: 'studio-dark',
  scenesCollapsed: false,
  tracksCollapsed: false,
  // Show / kiosk mode — hides all editing chrome and forces the Sequence
  // view + transport so the app can't be accidentally edited mid-show.
  // Toggled via F11 (global hotkey) or the Show button in prefs.
  // Exit: hold Escape for ~1 second while in show mode.
  showMode: false,
  oscMonitorOpen: false,
  armedSceneId: null,
  autoAdvanceArm: false,
  morphEnabled: false,
  morphMs: 2000,
  transportStartedAt: null,
  transportAccumulatedMs: 0,
  // Ephemeral per-knob display values, interpolated by metaSmooth.ts. Not
  // persisted — on session load we reset these to each knob's `value`
  // (see setSession below).
  metaKnobDisplayValues: Array.from({ length: META_KNOB_COUNT }, () => 0),
  uiScale: loadUiScale(),
  clipTemplates: loadTemplates(),

  setSession: (s) => {
    const next = propagateDefaults(s)
    // Reset display values to each knob's persisted value so the UI opens
    // at the right position after loading a session.
    const display = next.metaController.knobs.map((k) => k.value)
    // Reset EVERY piece of ephemeral UI state so stale IDs from the
    // previous session (selection, armed cue, multi-selection arrays,
    // transport counter) can't point at objects that no longer exist —
    // those dangling refs were causing Inspector / GO / morph features
    // to act on a mix of old and new data after an Open / restore.
    set({
      session: next,
      metaKnobDisplayValues: display,
      selectedCell: null,
      selectedCells: [],
      selectedSceneIds: [],
      selectedTrackIds: [],
      selectedTrack: null,
      armedSceneId: null,
      sequencePaused: false,
      transportStartedAt: null,
      transportAccumulatedMs: 0,
      // Leave midiLearnMode alone — it's a performer-facing toggle that
      // shouldn't flip unexpectedly mid-session-load.
      midiLearnTarget: null
    })
  },
  newSession: () =>
    set({
      session: makeEmptySession(),
      currentFilePath: null,
      metaKnobDisplayValues: Array.from({ length: META_KNOB_COUNT }, () => 0),
      // Same ephemeral reset as setSession — see comment there.
      selectedCell: null,
      selectedCells: [],
      selectedSceneIds: [],
      selectedTrackIds: [],
      selectedTrack: null,
      armedSceneId: null,
      sequencePaused: false,
      transportStartedAt: null,
      transportAccumulatedMs: 0,
      midiLearnTarget: null
    }),
  setCurrentFilePath: (p) => set({ currentFilePath: p }),
  setName: (name) => set((st) => ({ session: { ...st.session, name } })),
  setTickRate: (hz) => set((st) => ({ session: { ...st.session, tickRateHz: clampInt(hz, 10, 300) } })),
  setDefaults: (fields) =>
    set((st) => {
      // Bug fix: changing a session default used to rewrite EVERY currently-
      // linked clip's address / destination because `propagateDefaults`
      // re-applies `defaultXxx` into cells whose `addressLinkedToDefault` /
      // `destLinkedToDefault` flag is on. That meant "edit default OSC
      // address" was effectively a global find-and-replace across every
      // existing clip — which is exactly the opposite of what a user wants.
      //
      // Fix: before applying the new default, FREEZE every linked clip at
      // the OLD default (materialize the current effective value into the
      // cell and clear the link flag). Future default changes then leave
      // these clips alone. Only NEW clips created after this change inherit
      // the new default — they stay linked until the next default change,
      // at which point they too get frozen.
      const oldAddr = st.session.defaultOscAddress
      const oldIp = st.session.defaultDestIp
      const oldPort = st.session.defaultDestPort
      const addrChanged =
        fields.defaultOscAddress !== undefined && fields.defaultOscAddress !== oldAddr
      const destChanged =
        (fields.defaultDestIp !== undefined && fields.defaultDestIp !== oldIp) ||
        (fields.defaultDestPort !== undefined && fields.defaultDestPort !== oldPort)

      const scenes = !addrChanged && !destChanged
        ? st.session.scenes
        : st.session.scenes.map((sc) => ({
            ...sc,
            cells: Object.fromEntries(
              Object.entries(sc.cells).map(([tid, c]) => {
                let out: Cell = c
                if (addrChanged && c.addressLinkedToDefault) {
                  out = {
                    ...out,
                    oscAddress: oldAddr,
                    addressLinkedToDefault: false
                  }
                }
                if (destChanged && c.destLinkedToDefault) {
                  out = {
                    ...out,
                    destIp: oldIp,
                    destPort: oldPort,
                    destLinkedToDefault: false
                  }
                }
                return [tid, out]
              })
            )
          }))

      return {
        session: propagateDefaults({
          ...st.session,
          scenes,
          ...fields
        })
      }
    }),
  setMidiInputName: (name) => set((st) => ({ session: { ...st.session, midiInputName: name } })),
  setFocusedScene: (id) =>
    set((st) => ({
      session: { ...st.session, focusedSceneId: id },
      selectedSceneIds: id ? [id] : []
    })),
  selectSceneRange: (id) =>
    set((st) => {
      const order = st.session.scenes.map((s) => s.id)
      const clickedIdx = order.indexOf(id)
      if (clickedIdx < 0) return st
      const anchor = st.session.focusedSceneId
      const anchorIdx = anchor ? order.indexOf(anchor) : -1
      // No anchor yet → behave like plain focus.
      if (anchorIdx < 0) {
        return {
          session: { ...st.session, focusedSceneId: id },
          selectedSceneIds: [id]
        }
      }
      const from = Math.min(anchorIdx, clickedIdx)
      const to = Math.max(anchorIdx, clickedIdx)
      return {
        // Keep the anchor where it is so further Ctrl-clicks re-extend from it.
        session: { ...st.session, focusedSceneId: anchor },
        selectedSceneIds: order.slice(from, to + 1)
      }
    }),
  removeScenes: (ids) =>
    set((st) => {
      if (ids.length === 0) return st
      const idSet = new Set(ids)
      const scenes = st.session.scenes.filter((s) => !idSet.has(s.id))
      const sequence = st.session.sequence.map((v) => (v && idSet.has(v) ? null : v))
      return {
        session: {
          ...st.session,
          scenes,
          sequence,
          focusedSceneId:
            st.session.focusedSceneId && idSet.has(st.session.focusedSceneId)
              ? null
              : st.session.focusedSceneId
        },
        selectedSceneIds: st.selectedSceneIds.filter((sid) => !idSet.has(sid)),
        // Clear cell selection if it pointed at one of the deleted scenes.
        selectedCell:
          st.selectedCell && idSet.has(st.selectedCell.sceneId) ? null : st.selectedCell,
        selectedCells: st.selectedCells.filter((r) => !idSet.has(r.sceneId)),
        // Clear the cue if the armed scene was deleted — firing a dead id
        // would be a no-op and leaving the chevron on a missing scene is
        // confusing.
        armedSceneId:
          st.armedSceneId && idSet.has(st.armedSceneId) ? null : st.armedSceneId
      }
    }),
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
        selectedTrackIds: st.selectedTrackIds.filter((tid) => tid !== id),
        selectedCell: st.selectedCell?.trackId === id ? null : st.selectedCell,
        selectedCells: st.selectedCells.filter((r) => r.trackId !== id)
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
      // New scenes live only in the palette; users drag them explicitly into
      // the sequencer when they're ready.
      return { session: { ...st.session, scenes: [...st.session.scenes, scene] } }
    }),
  removeScene: (id) =>
    set((st) => ({
      session: {
        ...st.session,
        scenes: st.session.scenes.filter((s) => s.id !== id),
        sequence: st.session.sequence.map((v) => (v === id ? null : v)),
        focusedSceneId: st.session.focusedSceneId === id ? null : st.session.focusedSceneId
      },
      selectedSceneIds: st.selectedSceneIds.filter((sid) => sid !== id),
      // Clear selection if it pointed at this scene — otherwise Inspector crashes.
      selectedCell: st.selectedCell?.sceneId === id ? null : st.selectedCell,
      selectedCells: st.selectedCells.filter((r) => r.sceneId !== id),
      // Drop arm if the armed scene is the one being deleted.
      armedSceneId: st.armedSceneId === id ? null : st.armedSceneId
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
    set((st) => {
      const matches = (r: { sceneId: string; trackId: string }): boolean =>
        r.sceneId === sceneId && r.trackId === trackId
      return {
        session: {
          ...st.session,
          scenes: st.session.scenes.map((s) => {
            if (s.id !== sceneId) return s
            const { [trackId]: _drop, ...rest } = s.cells
            return { ...s, cells: rest }
          })
        },
        // Drop the removed cell from any active selection state so stale
        // refs can't linger (and break the Inspector).
        selectedCell: st.selectedCell && matches(st.selectedCell) ? null : st.selectedCell,
        selectedCells: st.selectedCells.filter((r) => !matches(r))
      }
    }),
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
    set({
      selectedCell: { sceneId, trackId },
      selectedCells: [{ sceneId, trackId }],
      selectedTrack: null,
      selectedTrackIds: []
    }),
  toggleCellSelection: (sceneId, trackId) =>
    set((st) => {
      const exists = st.selectedCells.some(
        (r) => r.sceneId === sceneId && r.trackId === trackId
      )
      const nextCells = exists
        ? st.selectedCells.filter(
            (r) => !(r.sceneId === sceneId && r.trackId === trackId)
          )
        : [...st.selectedCells, { sceneId, trackId }]
      // The most recent addition becomes the primary / anchor so the
      // Inspector snaps to it. When you ctrl-click to remove the anchor,
      // primary drops to the last remaining entry (or null).
      const primary = exists
        ? nextCells[nextCells.length - 1] ?? null
        : { sceneId, trackId }
      return {
        selectedCell: primary,
        selectedCells: nextCells,
        selectedTrack: null,
        selectedTrackIds: []
      }
    }),
  applyDefaultOscToCells: (refs) =>
    set((st) => {
      if (refs.length === 0) return st
      const touched = new Set(refs.map((r) => `${r.sceneId}\0${r.trackId}`))
      const scenes = st.session.scenes.map((sc) => {
        const cells = Object.fromEntries(
          Object.entries(sc.cells).map(([tid, c]) => {
            if (!touched.has(`${sc.id}\0${tid}`)) return [tid, c]
            return [
              tid,
              {
                ...c,
                oscAddress: st.session.defaultOscAddress,
                addressLinkedToDefault: true,
                destIp: st.session.defaultDestIp,
                destPort: st.session.defaultDestPort,
                destLinkedToDefault: true
              } satisfies Cell
            ]
          })
        )
        return { ...sc, cells }
      })
      return { session: { ...st.session, scenes } }
    }),
  selectTrack: (id) =>
    set({
      selectedTrack: id,
      selectedTrackIds: id ? [id] : [],
      selectedCell: null,
      selectedCells: []
    }),
  selectTrackRange: (id) =>
    set((st) => {
      const order = st.session.tracks.map((t) => t.id)
      const clickedIdx = order.indexOf(id)
      if (clickedIdx < 0) return st
      const anchorIdx = st.selectedTrack ? order.indexOf(st.selectedTrack) : -1
      // No anchor yet → behave like a normal click.
      if (anchorIdx < 0) {
        return { selectedTrack: id, selectedTrackIds: [id], selectedCell: null }
      }
      const from = Math.min(anchorIdx, clickedIdx)
      const to = Math.max(anchorIdx, clickedIdx)
      return {
        selectedTrack: st.selectedTrack,       // keep anchor intact
        selectedTrackIds: order.slice(from, to + 1),
        selectedCell: null
      }
    }),
  removeTracks: (ids) =>
    set((st) => {
      if (ids.length === 0) return st
      const idSet = new Set(ids)
      const tracks = st.session.tracks.filter((t) => !idSet.has(t.id))
      // Drop cells that referred to any of the deleted tracks, on every scene.
      const scenes = st.session.scenes.map((s) => {
        const cells: typeof s.cells = {}
        for (const [tid, c] of Object.entries(s.cells)) {
          if (!idSet.has(tid)) cells[tid] = c
        }
        return { ...s, cells }
      })
      return {
        session: { ...st.session, tracks, scenes },
        selectedTrack: st.selectedTrack && idSet.has(st.selectedTrack) ? null : st.selectedTrack,
        selectedTrackIds: st.selectedTrackIds.filter((tid) => !idSet.has(tid)),
        selectedCell:
          st.selectedCell && idSet.has(st.selectedCell.trackId) ? null : st.selectedCell,
        selectedCells: st.selectedCells.filter((r) => !idSet.has(r.trackId))
      }
    }),
  setEditorNotesHeight: (h) => set({ editorNotesHeight: clampInt(h, 0, 240) }),
  setRowHeight: (h) => set({ rowHeight: clampInt(h, 30, 220) }),
  setSceneColumnWidth: (w) => set({ sceneColumnWidth: clampInt(w, 180, 480) }),
  setScenePaletteWidth: (w) => set({ scenePaletteWidth: clampInt(w, 200, 480) }),
  setTrackColumnWidth: (w) => set({ trackColumnWidth: clampInt(w, 160, 400) }),
  setInspectorWidth: (w) => set({ inspectorWidth: clampInt(w, 320, 640) }),
  setSequencePaused: (paused) => set({ sequencePaused: paused }),
  setMidiLearnMode: (on) =>
    set({ midiLearnMode: on, midiLearnTarget: on ? null : null }),
  setMidiLearnTarget: (t) => set({ midiLearnTarget: t }),
  setTheme: (t) => set({ theme: t }),
  // By default each toggle is independent (scenes only OR messages only).
  // The "linked compact mode" (both at once) is surfaced via a right-click
  // on either toggle in EditView, which calls both setters together.
  setScenesCollapsed: (v) => set({ scenesCollapsed: v }),
  setShowMode: (v) =>
    set((st) =>
      v
        ? // Entering show mode:
          //  - force Sequence view as the default landing pane (Tab still
          //    flips to Edit in show mode, see App.tsx keyboard router);
          //  - force the Meta Controller bar visible — in show mode knobs
          //    are the only live-tweakable thing, so hiding them would
          //    strip the performer of their most useful control.
          {
            showMode: true,
            view: 'sequence',
            session: {
              ...st.session,
              metaController: { ...st.session.metaController, visible: true }
            }
          }
        : { showMode: false }
    ),
  setTracksCollapsed: (v) => set({ tracksCollapsed: v }),
  setOscMonitorOpen: (v) => set({ oscMonitorOpen: v }),
  setArmedSceneId: (id) =>
    set((st) => {
      // Defensive — don't arm a scene that doesn't exist.
      if (id && !st.session.scenes.some((s) => s.id === id)) return { armedSceneId: null }
      return { armedSceneId: id }
    }),
  setAutoAdvanceArm: (v) => set({ autoAdvanceArm: v }),
  setMorphEnabled: (v) => set({ morphEnabled: v }),
  setGoMidi: (b) =>
    set((st) => ({
      session: { ...st.session, goMidi: b }
    })),
  setMorphTimeMidi: (b) =>
    set((st) => ({
      session: { ...st.session, morphTimeMidi: b }
    })),
  setMorphMs: (ms) => {
    if (!Number.isFinite(ms)) return
    set({ morphMs: Math.max(0, Math.min(300000, ms)) })
  },
  resolveMorphMs: (sceneId) => {
    const st = get()
    const scene = st.session.scenes.find((s) => s.id === sceneId)
    // Per-scene override wins if set (and ≥ 0).
    if (scene && typeof scene.morphInMs === 'number' && scene.morphInMs >= 0) {
      return scene.morphInMs
    }
    if (st.morphEnabled) return st.morphMs
    return undefined
  },
  triggerSceneWithMorph: (sceneId) => {
    const morphMs = get().resolveMorphMs(sceneId)
    void window.api.triggerScene(
      sceneId,
      morphMs !== undefined ? { morphMs } : undefined
    )
  },
  fireArmed: () => {
    const st = get()
    const id = st.armedSceneId
    if (!id) return null
    // Trigger via the morph-aware helper so GO goes through the same
    // precedence rules as Space / click / MIDI.
    st.triggerSceneWithMorph(id)
    // Optionally arm the next non-empty slot so Space-Space-Space walks
    // the sequence. Uses the slot the fired scene was in (or slot 0 if
    // it isn't in the current sequence) as the starting point.
    let nextArm: string | null = null
    if (st.autoAdvanceArm) {
      const seq = st.session.sequence
      const len = Math.min(seq.length, st.session.sequenceLength)
      const here = seq.findIndex((sid) => sid === id)
      const start = here >= 0 ? here : -1
      for (let i = 1; i <= len; i++) {
        const idx = (start + i + len) % len
        const candidate = seq[idx]
        if (candidate && candidate !== id) {
          nextArm = candidate
          break
        }
      }
    }
    set({ armedSceneId: nextArm })
    return id
  },
  transportPlay: () =>
    set((st) =>
      // Already running? Leave state alone — second Play should feel like
      // a no-op on the timer (real play-scene logic is handled separately
      // by the caller via window.api.triggerScene / resumeSequence).
      st.transportStartedAt !== null
        ? st
        : { transportStartedAt: Date.now() }
    ),
  transportPause: () =>
    set((st) => {
      if (st.transportStartedAt === null) return st
      const dt = Date.now() - st.transportStartedAt
      return {
        transportStartedAt: null,
        transportAccumulatedMs: st.transportAccumulatedMs + dt
      }
    }),
  transportStop: () =>
    set({ transportStartedAt: null, transportAccumulatedMs: 0 }),
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
      // Templates persist in localStorage across app versions, so an old
      // template may be missing fields the current Cell schema requires
      // (e.g. `modulation.envelope`, `sequencer`, `scaleToUnit`). Merge the
      // template on top of a fresh makeCell() baseline with this session's
      // defaults — any missing field falls back to a sensible default
      // instead of crashing the renderer when components read it.
      const base = makeCell({
        destIp: st.session.defaultDestIp,
        destPort: st.session.defaultDestPort,
        oscAddress: st.session.defaultOscAddress
      })
      const tc = tpl.cell as Partial<Cell>
      const tm = tc.modulation as Partial<Cell['modulation']> | undefined
      const ts = tc.sequencer as Partial<Cell['sequencer']> | undefined
      const cell: Cell = {
        ...base,
        ...tc,
        modulation: {
          ...base.modulation,
          ...(tm ?? {}),
          envelope: { ...base.modulation.envelope, ...(tm?.envelope ?? {}) },
          // Ramp was added later; always deep-clone so the new cell never
          // shares a reference with either the factory default or the
          // template's own ramp object. Without this, editing the new
          // clip's ramp mutates whichever object the spread kept alive.
          ramp: { ...base.modulation.ramp, ...(tm?.ramp ?? {}) },
          arpeggiator: { ...base.modulation.arpeggiator, ...(tm?.arpeggiator ?? {}) },
          random: { ...base.modulation.random, ...(tm?.random ?? {}) }
        },
        sequencer: {
          ...base.sequencer,
          ...(ts ?? {}),
          stepValues: Array.isArray(ts?.stepValues)
            ? [...ts!.stepValues]
            : [...base.sequencer.stepValues]
        }
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

  // ---- Meta Controller ----
  setMetaControllerVisible: (v) =>
    set((st) => ({
      session: {
        ...st.session,
        metaController: { ...st.session.metaController, visible: v }
      }
    })),
  setMetaControllerHeight: (h) =>
    set((st) => {
      const clamped = Math.max(META_MIN_HEIGHT, Math.min(META_MAX_HEIGHT, Math.round(h)))
      return {
        session: {
          ...st.session,
          metaController: { ...st.session.metaController, height: clamped }
        }
      }
    }),
  setMetaSelectedKnob: (idx) =>
    set((st) => {
      const clamped = Math.max(0, Math.min(META_KNOB_COUNT - 1, Math.floor(idx)))
      return {
        session: {
          ...st.session,
          metaController: { ...st.session.metaController, selectedKnob: clamped }
        }
      }
    }),
  updateMetaKnob: (idx, patch) =>
    set((st) => {
      if (idx < 0 || idx >= META_KNOB_COUNT) return st
      const knobs = st.session.metaController.knobs.map((k, i) => (i === idx ? { ...k, ...patch } : k))
      return {
        session: { ...st.session, metaController: { ...st.session.metaController, knobs } }
      }
    }),
  addMetaDestination: (knobIdx) =>
    set((st) => {
      if (knobIdx < 0 || knobIdx >= META_KNOB_COUNT) return st
      const knobs = st.session.metaController.knobs.map((k, i) => {
        if (i !== knobIdx) return k
        if (k.destinations.length >= META_MAX_DESTS) return k
        const newDest: MetaDest = {
          destIp: st.session.defaultDestIp,
          destPort: st.session.defaultDestPort,
          oscAddress: `/meta/${knobIdx + 1}`,
          enabled: true
        }
        return { ...k, destinations: [...k.destinations, newDest] }
      })
      // Auto-growing the bar is handled in the MetaControllerBar component
      // via a useLayoutEffect that measures real rendered content — avoids
      // brittle hard-coded row-height math.
      return {
        session: { ...st.session, metaController: { ...st.session.metaController, knobs } }
      }
    }),
  removeMetaDestination: (knobIdx, destIdx) =>
    set((st) => {
      if (knobIdx < 0 || knobIdx >= META_KNOB_COUNT) return st
      const knobs = st.session.metaController.knobs.map((k, i) => {
        if (i !== knobIdx) return k
        return { ...k, destinations: k.destinations.filter((_, di) => di !== destIdx) }
      })
      return {
        session: { ...st.session, metaController: { ...st.session.metaController, knobs } }
      }
    }),
  updateMetaDestination: (knobIdx, destIdx, patch) =>
    set((st) => {
      if (knobIdx < 0 || knobIdx >= META_KNOB_COUNT) return st
      const knobs = st.session.metaController.knobs.map((k, i) => {
        if (i !== knobIdx) return k
        const destinations = k.destinations.map((d, di) => (di === destIdx ? { ...d, ...patch } : d))
        return { ...k, destinations }
      })
      return {
        session: { ...st.session, metaController: { ...st.session.metaController, knobs } }
      }
    }),
  setMetaKnobMidi: (knobIdx, binding) =>
    set((st) => {
      if (knobIdx < 0 || knobIdx >= META_KNOB_COUNT) return st
      const knobs = st.session.metaController.knobs.map((k, i) => {
        if (i !== knobIdx) return k
        if (binding) return { ...k, midiCc: binding }
        // Remove midiCc key entirely when clearing (rather than setting to
        // undefined) so JSON serialization stays tidy.
        const { midiCc: _drop, ...rest } = k
        void _drop
        return rest as MetaKnob
      })
      return {
        session: { ...st.session, metaController: { ...st.session.metaController, knobs } }
      }
    }),
  setMetaKnobValueFromMidi: (knobIdx, value) =>
    set((st) => {
      if (knobIdx < 0 || knobIdx >= META_KNOB_COUNT) return st
      const v = Math.max(0, Math.min(1, value))
      const knobs = st.session.metaController.knobs.map((k, i) =>
        i === knobIdx ? { ...k, value: v } : k
      )
      return {
        session: { ...st.session, metaController: { ...st.session.metaController, knobs } }
      }
    }),
  setMetaKnobDisplayValues: (values) => set({ metaKnobDisplayValues: values }),
  setUiScale: (s) =>
    set({ uiScale: Math.max(UI_SCALE_MIN, Math.min(UI_SCALE_MAX, s)) }),

  setEngineState: (s) => set({ engine: s })
}))

// Persist clipTemplates whenever they change. Referential check skips writes
// from unrelated state updates (engine ticks etc) — the templates array is
// always replaced when modified, so identity-equality is a reliable signal.
let lastTemplates: ClipTemplate[] = useStore.getState().clipTemplates
let lastUiScale: number = useStore.getState().uiScale
useStore.subscribe((state) => {
  if (state.clipTemplates !== lastTemplates) {
    lastTemplates = state.clipTemplates
    saveTemplates(state.clipTemplates)
  }
  if (state.uiScale !== lastUiScale) {
    lastUiScale = state.uiScale
    saveUiScale(state.uiScale)
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

// Pad or truncate a sequence array to exactly `length` slots. Used by
// propagateDefaults to defend against sessions saved with a shorter or
// corrupted sequence array.
function padSequence(seq: (string | null)[], length: number): (string | null)[] {
  const out: (string | null)[] = seq.slice(0, length)
  while (out.length < length) out.push(null)
  return out
}

function propagateDefaults(s: Session): Session {
  // Defensive defaults for every top-level Session field. Current session
  // files always include these, but applying the same pattern everywhere
  // means future schema additions can't silently leave fields as undefined
  // for older saves. If you add a Session field, add its fallback here.
  const SEQUENCE_LEN = 128
  return {
    ...s,
    version: 1,
    name: typeof s.name === 'string' ? s.name : 'Untitled',
    tickRateHz:
      typeof s.tickRateHz === 'number' ? clampInt(s.tickRateHz, 10, 300) : 120,
    globalBpm: typeof s.globalBpm === 'number' ? s.globalBpm : 120,
    sequenceLength:
      typeof s.sequenceLength === 'number' ? clampInt(s.sequenceLength, 1, 128) : 32,
    defaultOscAddress:
      typeof s.defaultOscAddress === 'string' ? s.defaultOscAddress : '/dataflou/value',
    defaultDestIp: typeof s.defaultDestIp === 'string' ? s.defaultDestIp : '127.0.0.1',
    defaultDestPort: typeof s.defaultDestPort === 'number' ? s.defaultDestPort : 9000,
    // Soft-migrate tracks: guarantee every Track has a proper shape, and
    // validate optional per-track fields (defaults, midiTrigger). Previously
    // we just passed through `s.tracks` unchanged, so older files' optional
    // fields were whatever shape they happened to have (or missing entirely).
    // Tracks missing an `id` are DROPPED — fabricating a new id would orphan
    // every cell that referenced the original, which is worse than losing
    // one malformed row.
    tracks: (Array.isArray(s.tracks) ? s.tracks : [])
      .filter((t): t is Track => !!t && typeof t.id === 'string')
      .map((t) => ({
        id: t.id,
        name: typeof t.name === 'string' ? t.name : 'Message',
        defaultOscAddress:
          typeof t.defaultOscAddress === 'string' ? t.defaultOscAddress : undefined,
        defaultDestIp: typeof t.defaultDestIp === 'string' ? t.defaultDestIp : undefined,
        defaultDestPort:
          typeof t.defaultDestPort === 'number' ? t.defaultDestPort : undefined,
        midiTrigger: sanitizeMidiBinding(t.midiTrigger)
      })),
    focusedSceneId: typeof s.focusedSceneId === 'string' ? s.focusedSceneId : null,
    midiInputName: typeof s.midiInputName === 'string' ? s.midiInputName : null,
    // Transport-level bindings — optional and CC/note shape-validated
    // through the same sanitizer used for scene/cell/track bindings. Older
    // sessions simply don't have the field; default to undefined (no
    // binding) so no routing happens.
    goMidi: sanitizeMidiBinding(s.goMidi),
    morphTimeMidi: sanitizeMidiBinding(s.morphTimeMidi),
    sequence:
      Array.isArray(s.sequence) && s.sequence.length === SEQUENCE_LEN
        ? s.sequence
        : padSequence(Array.isArray(s.sequence) ? s.sequence : [], SEQUENCE_LEN),
    // Soft-migrate scenes: `notes` is new; fall back to '' if missing.
    // Also run scene.midiTrigger through the validator so hand-edited /
    // older session files can't inject a malformed binding object.
    // Follow-action rename: pre-rework sessions used 'off'/'random'; those
    // map to 'stop'/'any' in the new NextMode union. 'next' is kept.
    // `multiplicator` is new; default to 1.
    scenes: (Array.isArray(s.scenes) ? s.scenes : []).map((sc) => ({
      ...sc,
      notes: sc.notes ?? '',
      nextMode: migrateNextMode(sc.nextMode),
      multiplicator:
        typeof sc.multiplicator === 'number' && Number.isFinite(sc.multiplicator)
          ? Math.max(1, Math.min(128, Math.floor(sc.multiplicator)))
          : 1,
      // Morph-in is optional and brand-new. Keep undefined in old sessions
      // rather than forcing a default so "no per-scene override" still
      // behaves as "follow transport".
      morphInMs:
        typeof sc.morphInMs === 'number' && Number.isFinite(sc.morphInMs)
          ? Math.max(0, Math.min(300000, Math.floor(sc.morphInMs)))
          : undefined,
      midiTrigger: sanitizeMidiBinding(sc.midiTrigger),
      cells: Object.fromEntries(
        Object.entries(sc.cells).map(([tid, c]) => {
          const m = c.modulation as Partial<typeof DEFAULT_MODULATION> | undefined
          const env = m?.envelope as Partial<typeof DEFAULT_ENVELOPE> | undefined
          const out: Cell = {
            ...c,
            // Validate midiTrigger shape — spread from `...c` brings it
            // through, but if the saved file has a malformed binding it'd
            // crash midi.ts. Normalizing here is cheap and safe.
            midiTrigger: sanitizeMidiBinding(c.midiTrigger),
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
                sync: env?.sync ?? DEFAULT_ENVELOPE.sync,
                // New field for the Free(synced) mode. Back-fill to the
                // default so older sessions don't send NaN through the math.
                totalMs: typeof env?.totalMs === 'number' ? env.totalMs : DEFAULT_ENVELOPE.totalMs
              },
              // Ramp is a NEW modulator type; older sessions lack this field
              // entirely. Default to the factory ramp so the engine + UI
              // always have valid numbers to work with.
              ramp: {
                rampMs:
                  typeof (m?.ramp as Partial<typeof DEFAULT_RAMP> | undefined)?.rampMs === 'number'
                    ? (m!.ramp as RampParams).rampMs
                    : DEFAULT_RAMP.rampMs,
                curvePct:
                  typeof (m?.ramp as Partial<typeof DEFAULT_RAMP> | undefined)?.curvePct === 'number'
                    ? (m!.ramp as RampParams).curvePct
                    : DEFAULT_RAMP.curvePct,
                sync:
                  (m?.ramp as Partial<typeof DEFAULT_RAMP> | undefined)?.sync ?? DEFAULT_RAMP.sync,
                totalMs:
                  typeof (m?.ramp as Partial<typeof DEFAULT_RAMP> | undefined)?.totalMs === 'number'
                    ? (m!.ramp as RampParams).totalMs
                    : DEFAULT_RAMP.totalMs
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
    })),
    // Soft-migrate Meta Controller for sessions saved before this feature.
    // Fill any missing fields with factory defaults and clamp the array to
    // META_KNOB_COUNT. Destinations are capped at META_MAX_DESTS.
    metaController: sanitizeMetaController(s.metaController)
  }
}

// Shared defensive cleanup for MIDI bindings on Tracks, Scenes, and Cells.
// A binding must have kind ∈ {note, cc} and finite channel/number; anything
// else is treated as "no binding" rather than leaving a malformed object in
// state. Used in propagateDefaults to keep older / hand-edited session files
// from crashing the MIDI router.
function sanitizeMidiBinding(
  b: unknown
): { kind: 'note' | 'cc'; channel: number; number: number } | undefined {
  if (!b || typeof b !== 'object') return undefined
  const x = b as { kind?: unknown; channel?: unknown; number?: unknown }
  if (x.kind !== 'note' && x.kind !== 'cc') return undefined
  if (typeof x.channel !== 'number' || !Number.isFinite(x.channel)) return undefined
  if (typeof x.number !== 'number' || !Number.isFinite(x.number)) return undefined
  return {
    kind: x.kind,
    channel: Math.max(0, Math.min(15, Math.floor(x.channel))),
    number: Math.max(0, Math.min(127, Math.floor(x.number)))
  }
}

// Valid values for the current NextMode union. Translate legacy values
// from pre-rework sessions: 'off' → 'stop', 'random' → 'any'. 'next' is
// unchanged. Anything unrecognized falls back to 'stop' (safe default).
const VALID_NEXT_MODES: ReadonlySet<string> = new Set([
  'stop',
  'loop',
  'next',
  'prev',
  'first',
  'last',
  'any',
  'other'
])
function migrateNextMode(raw: unknown): NextMode {
  if (raw === 'off') return 'stop'
  if (raw === 'random') return 'any'
  if (typeof raw === 'string' && VALID_NEXT_MODES.has(raw)) return raw as NextMode
  return 'stop'
}

// Single source of truth for "is this string a valid curve id". Mirrors the
// MetaCurve union in shared/types.ts — if you add a new curve there, add
// its id here too.
const VALID_META_CURVES: ReadonlySet<string> = new Set([
  'linear',
  'log',
  'exp',
  'geom',
  'easeIn',
  'easeOut',
  'cubic',
  'sqrt',
  'sigmoid',
  'smoothstep',
  'db',
  'gamma',
  'step',
  'invert'
])
function isValidMetaCurve(c: unknown): c is MetaCurve {
  return typeof c === 'string' && VALID_META_CURVES.has(c)
}

function sanitizeMetaController(mc: MetaController | undefined): MetaController {
  if (!mc || typeof mc !== 'object') return makeMetaController()
  const defaults = makeMetaController()
  const knobsIn = Array.isArray(mc.knobs) ? mc.knobs : []
  const knobs: MetaKnob[] = Array.from({ length: META_KNOB_COUNT }, (_, i) => {
    const k = knobsIn[i] as Partial<MetaKnob> | undefined
    if (!k) return makeMetaKnob(i)
    const dests = Array.isArray(k.destinations) ? k.destinations : []
    // Soft-migrate midiCc: older sessions don't have it, which is fine — the
    // field is optional. If present, validate shape before trusting it.
    const rawCc = (k as Partial<MetaKnob>).midiCc
    const midiCc =
      rawCc &&
      (rawCc.kind === 'cc' || rawCc.kind === 'note') &&
      typeof rawCc.channel === 'number' &&
      typeof rawCc.number === 'number'
        ? { kind: rawCc.kind, channel: rawCc.channel, number: rawCc.number }
        : undefined
    return {
      name: typeof k.name === 'string' ? k.name : `Knob ${i + 1}`,
      min: typeof k.min === 'number' ? k.min : 0,
      max: typeof k.max === 'number' ? k.max : 1,
      curve: isValidMetaCurve(k.curve) ? k.curve : 'linear',
      value: typeof k.value === 'number' ? Math.max(0, Math.min(1, k.value)) : 0,
      smoothMs:
        typeof k.smoothMs === 'number' && Number.isFinite(k.smoothMs)
          ? Math.max(0, Math.min(META_MAX_SMOOTH_MS, k.smoothMs))
          : META_DEFAULT_SMOOTH_MS,
      destinations: dests.slice(0, META_MAX_DESTS).map((d: Partial<MetaDest>) => ({
        destIp: typeof d.destIp === 'string' ? d.destIp : '127.0.0.1',
        destPort: typeof d.destPort === 'number' ? d.destPort : 9000,
        oscAddress: typeof d.oscAddress === 'string' ? d.oscAddress : `/meta/${i + 1}`,
        enabled: typeof d.enabled === 'boolean' ? d.enabled : true
      })),
      midiCc
    }
  })
  return {
    visible: typeof mc.visible === 'boolean' ? mc.visible : defaults.visible,
    selectedKnob:
      typeof mc.selectedKnob === 'number' && mc.selectedKnob >= 0 && mc.selectedKnob < META_KNOB_COUNT
        ? Math.floor(mc.selectedKnob)
        : 0,
    height:
      typeof mc.height === 'number' && Number.isFinite(mc.height)
        ? Math.max(META_MIN_HEIGHT, Math.min(META_MAX_HEIGHT, mc.height))
        : defaults.height,
    knobs
  }
}
