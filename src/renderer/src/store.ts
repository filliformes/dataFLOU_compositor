import { create } from 'zustand'
import type {
  Cell,
  EngineState,
  FunctionParamNature,
  FunctionParamType,
  FunctionStreamMode,
  InstrumentFunction,
  InstrumentTemplate,
  MetaController,
  MetaCurve,
  MetaDest,
  MetaKnob,
  MidiBinding,
  NextMode,
  ParameterTemplate,
  Pool,
  RampParams,
  Scene,
  Session,
  Track,
  TrackKind
} from '@shared/types'
import { META_KNOB_COUNT, META_MAX_DESTS } from '@shared/types'
import {
  DEFAULT_ARPEGGIATOR,
  DEFAULT_CHAOS,
  DEFAULT_ENVELOPE,
  DEFAULT_MODULATION,
  DEFAULT_RAMP,
  DEFAULT_RANDOM,
  DEFAULT_SEQUENCER,
  DEFAULT_SH,
  DEFAULT_SLEW,
  META_DEFAULT_SMOOTH_MS,
  META_MAX_HEIGHT,
  META_MAX_SMOOTH_MS,
  META_MIN_HEIGHT,
  makeBuiltinPool,
  makeCell,
  makeEmptySession,
  makeFunctionSpec,
  makeFunctionTrack,
  makeMetaController,
  makeMetaKnob,
  makeParameterSpec,
  makeScene,
  makeTemplateSpec,
  makeTemplateTrack,
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
    | { kind: 'instrument'; sceneId: string; templateRowId: string }
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
  // Drawer height (px). User-resizable via the handle on top edge,
  // 120..600 (clamped). Persisted as part of the in-session UI prefs so
  // the height survives a drawer toggle.
  oscMonitorHeight: number
  // Hide the Pool pane within the OSC drawer. When true, the OSC log
  // takes the full drawer width and a "Show Pool" button appears in
  // the log toolbar so the user can bring it back.
  poolHidden: boolean
  // Inspector visibility — UI-only, not persisted with the session.
  // `editInspectorVisible` controls the right-side Inspector panel in
  // the Edit view; `sceneInspectorVisible` controls the SceneInfoPanel
  // strip below the palette in the Sequence view. I / S keyboard
  // shortcuts toggle each. Both default ON so first-time users see
  // the editing affordances without hunting.
  editInspectorVisible: boolean
  sceneInspectorVisible: boolean
  // Sequence view's "Timeline" alternate visualisation. Persisted on
  // the store (not session) so toggling Tab → Edit → Tab → Sequence
  // returns the user to whichever mode they had selected. Off by
  // default — the grid is the editing surface.
  timelineMode: boolean
  // Increment-only counter — bumping it asks the SceneInfoPanel's
  // Duration input to focus + select. Used after a drop into a
  // Scene Step so the user can immediately type a new duration.
  // Token semantics (not a boolean) so consecutive drops re-fire
  // the focus even when nothing else changed.
  focusDurationToken: number
  // Currently-clicked sequence slot — shared between the Scene Steps
  // grid and the Timeline visualisation. Drives:
  //   • the highlight ring around the picked slot,
  //   • the Transport Play button's "start from here" behavior, and
  //   • the inspector focus (focusedSceneId is set in lockstep).
  // Null when no slot is picked; cleared on transport Stop.
  selectedSequenceSlot: number | null
  // Multi-slot selection — shift-click extends a contiguous range
  // from `selectedSequenceSlot` (the anchor). Drives the right-click
  // "Set Follow Action" path's bulk apply across slots. Always
  // contains `selectedSequenceSlot` when non-empty. Drops to empty
  // when the slot anchor is cleared.
  selectedSequenceSlots: number[]
  // Pool drawer pane selection. The drawer hosts three panes side-by-side
  // (OSC log | Pool | Instruments Inspector). The selection drives what
  // the inspector pane renders: a Template-level form, a Function-level
  // form, or empty state.
  poolSelection:
    | { kind: 'template'; templateId: string }
    | { kind: 'function'; templateId: string; functionId: string }
    | { kind: 'parameter'; parameterId: string }
    | null
  // Integrity-check hand-off. When the user triggers Open or restores
  // from autosave, the incoming session is scanned; if issues turn up,
  // we stash it here (session + path + issues) and render the global
  // IntegrityPrompt modal instead of committing. Null = nothing pending.
  pendingIntegrityLoad: {
    session: Session
    path: string | null
    issues: import('./hooks/sessionIntegrity').IntegrityIssue[]
  } | null
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

  // Pool — Instrument Templates + Functions library
  // ────────────────────────────────────────────────────────────────────
  // The Pool lives on the session (so a session is self-contained) and
  // is also the source-of-truth that the Edit-view sidebar instantiates
  // FROM. CRUD against it is what the Pool drawer drives.
  addTemplate: () => string                      // returns new template id
  updateTemplate: (id: string, patch: Partial<InstrumentTemplate>) => void
  duplicateTemplate: (id: string) => string | null
  removeTemplate: (id: string) => void
  addFunctionToTemplate: (templateId: string) => string | null  // returns new fn id
  updateFunction: (
    templateId: string,
    functionId: string,
    patch: Partial<InstrumentFunction>
  ) => void
  removeFunction: (templateId: string, functionId: string) => void
  setPoolSelection: (sel: UiState['poolSelection']) => void
  // Drag a Template from the Pool into the Edit sidebar — adds one
  // header row + one row per Function under it. `insertAfterTrackId`
  // null means append at end of the tracks list.
  instantiateTemplate: (
    templateId: string,
    insertAfterTrackId: string | null
  ) => void
  // Drag a single Function from the Pool — creates an orphan Function
  // row (no parent template header) by default. If the user drops it
  // into an existing instantiated Template's group, pass that
  // template-row's id as `parentTrackId` to nest it.
  instantiateFunction: (
    templateId: string,
    functionId: string,
    insertAfterTrackId: string | null,
    parentTrackId?: string | null
  ) => void
  // Sidebar authoring (no Pool browse needed). "Add Instrument" creates
  // a fresh draft Template in the Pool (hidden from the Pool drawer
  // until the user runs "Save as Template") and instantiates it. The
  // returned id is the new sidebar header row, useful for selection.
  addInstrumentRow: (insertAfterTrackId: string | null) => string
  // "Add Function" right-clicked on an Instrument header row (or a
  // Function row that already lives inside one). Adds a new Function
  // spec to the linked Pool template AND instantiates it as a child row.
  addFunctionToInstrumentRow: (templateRowId: string) => void
  // "Save as Template" — finds the draft Template behind a sidebar
  // header row, gives it the user's chosen name, flips draft → false
  // so the Pool drawer surfaces it for re-use across scenes / sessions.
  saveAsTemplate: (templateRowId: string, name: string) => void

  // ParameterTemplate CRUD — single-Parameter blueprints in the Pool.
  // Mirrors the Template CRUD shape so the PoolPane can use the same
  // patterns (built-in entries are read-only, user entries editable).
  addParameter: () => string
  updateParameter: (id: string, patch: Partial<ParameterTemplate>) => void
  duplicateParameter: (id: string) => string | null
  removeParameter: (id: string) => void
  // Drag a Parameter blueprint into the Edit-view sidebar — adds one
  // orphan Function row whose defaults come from the blueprint.
  instantiateParameterTemplate: (
    parameterId: string,
    insertAfterTrackId: string | null,
    parentTrackId?: string | null
  ) => void

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
  // Reorder a track. `dragId` is dropped immediately AFTER `targetId` (or
  // at the very top of the list when `targetId` is null). When `dragId`
  // is a Template-header, every child Function row tagged with
  // parentTrackId === dragId is moved as a contiguous block so the visual
  // group stays intact. When `dragId` is a Function row that has a parent
  // Template, the move is constrained to within that Template's group
  // (drops outside the group are clamped to the group's range) so we
  // can't accidentally orphan a Function by dragging it across a Template
  // boundary.
  moveTrack: (dragId: string, targetId: string | null) => void

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
      | { kind: 'instrument'; sceneId: string; templateRowId: string }
      | { kind: 'go' }
      | { kind: 'morphTime' }
      | null
  ) => void
  // Bind / clear an Instrument-group MIDI trigger on a specific
  // (sceneId, templateRowId). Pass undefined to clear.
  setInstrumentTriggerMidi: (
    sceneId: string,
    templateRowId: string,
    binding: MidiBinding | undefined
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
  setOscMonitorHeight: (h: number) => void
  setPoolHidden: (v: boolean) => void
  setEditInspectorVisible: (v: boolean) => void
  setSceneInspectorVisible: (v: boolean) => void
  setTimelineMode: (v: boolean) => void
  setSelectedSequenceSlot: (i: number | null) => void
  // Shift-click range pick. Extends from the current anchor through
  // `i` inclusive (any direction). With no anchor, behaves like a
  // plain selectedSequenceSlot pick.
  selectSequenceSlotRange: (i: number) => void
  requestFocusDuration: () => void
  // Convenience: create a "Silence" scene (blank cells, gray color) so
  // the user can use it as a delay between scenes in the sequence.
  addSilenceScene: () => void
  // Add N scenes at once (clamped against the 128-scene cap). Used by
  // the right-click "Add Scenes…" prompt in the Sequence view's
  // palette area.
  addScenes: (count: number) => void
  // Entry point for any code path that wants to load a session (Open
  // dialog, crash recovery, future: drag-and-drop). Runs the integrity
  // check synchronously; commits immediately if clean, otherwise stages
  // the session in `pendingIntegrityLoad` for the modal to resolve.
  requestSessionLoad: (session: Session, path: string | null) => void
  // Called by IntegrityPrompt — either commits the staged (possibly
  // fixed) session or cancels.
  resolveIntegrityLoad: (commit: Session | null) => void
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
  // `sourceSlotIdx` — forwarded to the engine so the Sequence view
  // highlights the specific slot that fired (useful when the scene
  // appears in multiple slots). Omit for palette / column / cue triggers.
  triggerSceneWithMorph: (sceneId: string, sourceSlotIdx?: number | null) => void
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
  activeSequenceSlotIdx: null,
  pausedAt: null,
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
  // Defaults to the smallest non-collapsed size (matches the
  // ResizeHandle's `min` of 60 px). User can drag taller; the
  // collapsed view uses a separate 32 px constant. Keeps a fresh
  // session compact so more rows fit on screen by default.
  rowHeight: 60,
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
  oscMonitorHeight: 220,
  poolHidden: false,
  editInspectorVisible: true,
  sceneInspectorVisible: true,
  timelineMode: false,
  selectedSequenceSlot: null,
  selectedSequenceSlots: [],
  focusDurationToken: 0,
  poolSelection: null,
  pendingIntegrityLoad: null,
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

  // ─── Pool: Templates + Functions library ─────────────────────────────
  addTemplate: () => {
    const id = `tpl_user_${Math.random().toString(36).slice(2, 9)}`
    set((st) => {
      const idx = st.session.pool.templates.filter((t) => !t.builtin).length
      const tpl = { ...makeTemplateSpec(idx), id }
      return {
        session: {
          ...st.session,
          pool: { ...st.session.pool, templates: [...st.session.pool.templates, tpl] }
        },
        poolSelection: { kind: 'template', templateId: id }
      }
    })
    return id
  },
  updateTemplate: (id, patch) =>
    set((st) => {
      const t = st.session.pool.templates.find((tt) => tt.id === id)
      if (!t || t.builtin) return st
      return {
        session: {
          ...st.session,
          pool: {
            ...st.session.pool,
            templates: st.session.pool.templates.map((tt) =>
              tt.id === id ? { ...tt, ...patch } : tt
            )
          }
        }
      }
    }),
  duplicateTemplate: (id) => {
    const src = get().session.pool.templates.find((t) => t.id === id)
    if (!src) return null
    const newId = `tpl_user_${Math.random().toString(36).slice(2, 9)}`
    const cloned: InstrumentTemplate = {
      ...src,
      id: newId,
      name: `${src.name} (copy)`,
      builtin: false,
      // Re-id every function so the new template's functions don't
      // collide with the source template's functions if both are
      // instantiated into the same session.
      functions: src.functions.map((f) => ({
        ...f,
        id: `fn_user_${Math.random().toString(36).slice(2, 9)}`
      }))
    }
    set((st) => ({
      session: {
        ...st.session,
        pool: { ...st.session.pool, templates: [...st.session.pool.templates, cloned] }
      },
      poolSelection: { kind: 'template', templateId: newId }
    }))
    return newId
  },
  removeTemplate: (id) =>
    set((st) => {
      const t = st.session.pool.templates.find((tt) => tt.id === id)
      if (!t || t.builtin) return st
      return {
        session: {
          ...st.session,
          pool: {
            ...st.session.pool,
            templates: st.session.pool.templates.filter((tt) => tt.id !== id)
          }
        },
        poolSelection:
          st.poolSelection &&
          'templateId' in st.poolSelection &&
          st.poolSelection.templateId === id
            ? null
            : st.poolSelection
      }
    }),
  addFunctionToTemplate: (templateId) => {
    const t = get().session.pool.templates.find((tt) => tt.id === templateId)
    if (!t || t.builtin) return null
    const fn = makeFunctionSpec(t.functions.length)
    set((st) => ({
      session: {
        ...st.session,
        pool: {
          ...st.session.pool,
          templates: st.session.pool.templates.map((tt) =>
            tt.id === templateId ? { ...tt, functions: [...tt.functions, fn] } : tt
          )
        }
      },
      poolSelection: { kind: 'function', templateId, functionId: fn.id }
    }))
    return fn.id
  },
  updateFunction: (templateId, functionId, patch) =>
    set((st) => {
      const t = st.session.pool.templates.find((tt) => tt.id === templateId)
      if (!t || t.builtin) return st
      return {
        session: {
          ...st.session,
          pool: {
            ...st.session.pool,
            templates: st.session.pool.templates.map((tt) =>
              tt.id === templateId
                ? {
                    ...tt,
                    functions: tt.functions.map((f) =>
                      f.id === functionId ? { ...f, ...patch } : f
                    )
                  }
                : tt
            )
          }
        }
      }
    }),
  removeFunction: (templateId, functionId) =>
    set((st) => {
      const t = st.session.pool.templates.find((tt) => tt.id === templateId)
      if (!t || t.builtin) return st
      return {
        session: {
          ...st.session,
          pool: {
            ...st.session.pool,
            templates: st.session.pool.templates.map((tt) =>
              tt.id === templateId
                ? { ...tt, functions: tt.functions.filter((f) => f.id !== functionId) }
                : tt
            )
          }
        },
        poolSelection:
          st.poolSelection &&
          st.poolSelection.kind === 'function' &&
          st.poolSelection.templateId === templateId &&
          st.poolSelection.functionId === functionId
            ? { kind: 'template', templateId }
            : st.poolSelection
      }
    }),
  // Pool selection is mutually exclusive with cell/track selection. The
  // right-side Edit-view Inspector renders whichever is current, so
  // exclusivity keeps the inspector unambiguous (no "I picked a cell
  // AND a Pool template, what should the inspector show?").
  setPoolSelection: (sel) =>
    set((st) =>
      sel
        ? {
            poolSelection: sel,
            selectedCell: null,
            selectedCells: [],
            selectedTrack: null,
            selectedTrackIds: []
          }
        : { poolSelection: null }
    ),

  // ─── Pool → Edit-view instantiation ───────────────────────────────────
  instantiateTemplate: (templateId, insertAfterTrackId) =>
    set((st) => {
      const tpl = st.session.pool.templates.find((t) => t.id === templateId)
      if (!tpl) return st
      // Cap: don't blow past the 128-row limit. Total rows added =
      // 1 header + N functions.
      const headRoom = 128 - st.session.tracks.length
      if (headRoom < 1 + tpl.functions.length) return st

      const headerRow = makeTemplateTrack(tpl)
      const fnRows = tpl.functions.map((f) => makeFunctionTrack(tpl, f, headerRow.id))
      const newRows = [headerRow, ...fnRows]

      const idx = insertAfterTrackId
        ? st.session.tracks.findIndex((t) => t.id === insertAfterTrackId)
        : -1
      const tracks =
        idx >= 0
          ? [
              ...st.session.tracks.slice(0, idx + 1),
              ...newRows,
              ...st.session.tracks.slice(idx + 1)
            ]
          : [...st.session.tracks, ...newRows]
      return { session: { ...st.session, tracks } }
    }),
  instantiateFunction: (templateId, functionId, insertAfterTrackId, parentTrackId) =>
    set((st) => {
      const tpl = st.session.pool.templates.find((t) => t.id === templateId)
      const fn = tpl?.functions.find((f) => f.id === functionId)
      if (!tpl || !fn) return st
      if (st.session.tracks.length >= 128) return st

      const row = makeFunctionTrack(tpl, fn, parentTrackId ?? '')
      // Empty parentTrackId = orphan function (visual: no nesting). Keep
      // it as undefined rather than empty string so downstream can simply
      // truthy-check.
      if (!parentTrackId) row.parentTrackId = undefined

      const idx = insertAfterTrackId
        ? st.session.tracks.findIndex((t) => t.id === insertAfterTrackId)
        : -1
      const tracks =
        idx >= 0
          ? [
              ...st.session.tracks.slice(0, idx + 1),
              row,
              ...st.session.tracks.slice(idx + 1)
            ]
          : [...st.session.tracks, row]
      return { session: { ...st.session, tracks } }
    }),

  addInstrumentRow: (insertAfterTrackId) => {
    // Allocate ids up-front so we can return the row id synchronously.
    const tplId = `tpl_user_${Math.random().toString(36).slice(2, 9)}`
    const rowId = `t_${Math.random().toString(36).slice(2, 9)}`
    set((st) => {
      // We add 2 rows (header + 1 child Parameter) so check for the
      // 128 cap with that headroom, not 1. If there's only room for
      // one we still create the header — the user can deal with it
      // explicitly by removing other rows before adding the param.
      if (st.session.tracks.length >= 128) return st
      const headRoom = 128 - st.session.tracks.length
      // How many user (non-builtin) Templates exist? Used for the
      // default "Instrument N" name. Drafts count too so the numbering
      // matches what the user sees in the sidebar.
      const userIdx = st.session.pool.templates.filter((t) => !t.builtin).length
      const tplSpec = makeTemplateSpec(userIdx)
      // Seed one child Parameter so the new Instrument arrives in a
      // useful state — the user gets a sendable row immediately
      // instead of an empty Template header. Numbered "Parameter 1"
      // (matches makeFunctionSpec's default).
      const seedFn = makeFunctionSpec(0)
      const tpl: InstrumentTemplate = {
        ...tplSpec,
        id: tplId,
        name: `Instrument ${userIdx + 1}`,
        functions: headRoom >= 2 ? [seedFn] : [],
        draft: true
      }
      const headerRow: Track = {
        id: rowId,
        name: tpl.name,
        kind: 'template',
        sourceTemplateId: tplId,
        defaultOscAddress: tpl.oscAddressBase,
        defaultDestIp: tpl.destIp,
        defaultDestPort: tpl.destPort
      }
      const newRows: Track[] = [headerRow]
      if (headRoom >= 2) {
        newRows.push(makeFunctionTrack(tpl, seedFn, rowId))
      }
      const idx = insertAfterTrackId
        ? st.session.tracks.findIndex((t) => t.id === insertAfterTrackId)
        : -1
      const tracks =
        idx >= 0
          ? [
              ...st.session.tracks.slice(0, idx + 1),
              ...newRows,
              ...st.session.tracks.slice(idx + 1)
            ]
          : [...st.session.tracks, ...newRows]
      return {
        session: {
          ...st.session,
          tracks,
          pool: { ...st.session.pool, templates: [...st.session.pool.templates, tpl] }
        }
      }
    })
    return rowId
  },
  addFunctionToInstrumentRow: (templateRowId) =>
    set((st) => {
      const row = st.session.tracks.find((t) => t.id === templateRowId)
      if (!row || row.kind !== 'template' || !row.sourceTemplateId) return st
      const tpl = st.session.pool.templates.find((t) => t.id === row.sourceTemplateId)
      if (!tpl || tpl.builtin) return st
      if (st.session.tracks.length >= 128) return st
      const fn = makeFunctionSpec(tpl.functions.length)
      // Insert the new Function row immediately after the LAST existing
      // child of this Instrument header (so groups stay contiguous), or
      // immediately after the header itself if it has no children yet.
      const tracks = st.session.tracks
      const headerIdx = tracks.findIndex((t) => t.id === templateRowId)
      let insertIdx = headerIdx + 1
      while (
        insertIdx < tracks.length &&
        tracks[insertIdx].parentTrackId === templateRowId
      ) {
        insertIdx++
      }
      const fnRow = makeFunctionTrack(tpl, fn, templateRowId)
      const newTracks = [
        ...tracks.slice(0, insertIdx),
        fnRow,
        ...tracks.slice(insertIdx)
      ]
      const newTemplates = st.session.pool.templates.map((t) =>
        t.id === tpl.id ? { ...t, functions: [...t.functions, fn] } : t
      )
      return {
        session: {
          ...st.session,
          tracks: newTracks,
          pool: { ...st.session.pool, templates: newTemplates }
        }
      }
    }),
  saveAsTemplate: (templateRowId, name) =>
    set((st) => {
      const row = st.session.tracks.find((t) => t.id === templateRowId)
      if (!row || row.kind !== 'template' || !row.sourceTemplateId) return st
      const trimmed = name.trim()
      if (!trimmed) return st
      // Flip the draft flag off and apply the user's chosen name. The
      // template now appears in the Pool drawer's main list so it can be
      // re-instantiated elsewhere.
      const newTemplates = st.session.pool.templates.map((t) =>
        t.id === row.sourceTemplateId ? { ...t, draft: false, name: trimmed } : t
      )
      // Also rename the live Instrument row in the sidebar so it
      // matches the saved Template name.
      const newTracks = st.session.tracks.map((t) =>
        t.id === templateRowId ? { ...t, name: trimmed } : t
      )
      return {
        session: {
          ...st.session,
          tracks: newTracks,
          pool: { ...st.session.pool, templates: newTemplates }
        }
      }
    }),

  addParameter: () => {
    const id = `par_user_${Math.random().toString(36).slice(2, 9)}`
    set((st) => {
      const idx = st.session.pool.parameters.filter((p) => !p.builtin).length
      const param: ParameterTemplate = { ...makeParameterSpec(idx), id, builtin: false }
      return {
        session: {
          ...st.session,
          pool: { ...st.session.pool, parameters: [...st.session.pool.parameters, param] }
        },
        poolSelection: { kind: 'parameter', parameterId: id }
      }
    })
    return id
  },
  updateParameter: (id, patch) =>
    set((st) => {
      const p = st.session.pool.parameters.find((pp) => pp.id === id)
      if (!p || p.builtin) return st
      return {
        session: {
          ...st.session,
          pool: {
            ...st.session.pool,
            parameters: st.session.pool.parameters.map((pp) =>
              pp.id === id ? { ...pp, ...patch } : pp
            )
          }
        }
      }
    }),
  duplicateParameter: (id) => {
    const src = get().session.pool.parameters.find((p) => p.id === id)
    if (!src) return null
    const newId = `par_user_${Math.random().toString(36).slice(2, 9)}`
    const cloned: ParameterTemplate = {
      ...src,
      id: newId,
      name: `${src.name} (copy)`,
      builtin: false
    }
    set((st) => ({
      session: {
        ...st.session,
        pool: { ...st.session.pool, parameters: [...st.session.pool.parameters, cloned] }
      },
      poolSelection: { kind: 'parameter', parameterId: newId }
    }))
    return newId
  },
  removeParameter: (id) =>
    set((st) => {
      const p = st.session.pool.parameters.find((pp) => pp.id === id)
      if (!p || p.builtin) return st
      return {
        session: {
          ...st.session,
          pool: {
            ...st.session.pool,
            parameters: st.session.pool.parameters.filter((pp) => pp.id !== id)
          }
        },
        poolSelection:
          st.poolSelection &&
          st.poolSelection.kind === 'parameter' &&
          st.poolSelection.parameterId === id
            ? null
            : st.poolSelection
      }
    }),
  instantiateParameterTemplate: (parameterId, insertAfterTrackId, parentTrackId) =>
    set((st) => {
      const p = st.session.pool.parameters.find((pp) => pp.id === parameterId)
      if (!p) return st
      if (st.session.tracks.length >= 128) return st
      // A Parameter blueprint becomes an orphan-Function track row (or a
      // child-Function row if dropped into an existing Template group).
      const row: Track = {
        id: `t_${Math.random().toString(36).slice(2, 9)}`,
        name: p.name,
        kind: 'function',
        parentTrackId: parentTrackId || undefined,
        defaultOscAddress: p.oscPath.startsWith('/') ? p.oscPath : `/${p.oscPath}`,
        defaultDestIp: p.destIp,
        defaultDestPort: p.destPort
      }
      const tracks = st.session.tracks
      const idx = insertAfterTrackId
        ? tracks.findIndex((t) => t.id === insertAfterTrackId)
        : -1
      const insertAt = idx < 0 ? tracks.length : idx + 1
      const newTracks = [...tracks.slice(0, insertAt), row, ...tracks.slice(insertAt)]
      return { session: { ...st.session, tracks: newTracks } }
    }),

  addTrack: () =>
    set((st) => {
      if (st.session.tracks.length >= 128) return st
      const track = makeTrack(st.session.tracks.length)
      return { session: { ...st.session, tracks: [...st.session.tracks, track] } }
    }),
  moveTrack: (dragId, targetId) =>
    set((st) => {
      const tracks = st.session.tracks
      const dragIdx = tracks.findIndex((t) => t.id === dragId)
      if (dragIdx < 0 || dragId === targetId) return st
      const dragged = tracks[dragIdx]
      // Build the contiguous block being moved. A Template carries all its
      // child Function rows along; everything else moves as a single row.
      const blockIds: string[] = [dragId]
      if (dragged.kind === 'template') {
        for (let i = dragIdx + 1; i < tracks.length; i++) {
          if (tracks[i].parentTrackId === dragId) blockIds.push(tracks[i].id)
          else break
        }
      }
      const blockSet = new Set(blockIds)
      const without = tracks.filter((t) => !blockSet.has(t.id))
      const block = tracks.filter((t) => blockSet.has(t.id))
      // Translate `targetId` (id in the original list) to an insertion
      // index in `without`. null = top of list.
      let insertIdx: number
      if (targetId === null) {
        insertIdx = 0
      } else {
        const tIdx = without.findIndex((t) => t.id === targetId)
        // If target was inside the block (shouldn't happen because the
        // block's own ids are excluded from `without`), fall back to end.
        insertIdx = tIdx < 0 ? without.length : tIdx + 1
      }
      // If the dragged row is a child Function with a parent, clamp the
      // insertion so the row stays inside its Template group. Otherwise
      // dragging a Function out of a Template can leave it dangling above
      // a Template header it doesn't belong to.
      if (dragged.kind === 'function' && dragged.parentTrackId) {
        const parentId = dragged.parentTrackId
        const parentIdx = without.findIndex((t) => t.id === parentId)
        if (parentIdx >= 0) {
          // Group spans [parentIdx + 1 .. parentIdx + 1 + childCount - 1].
          let groupEnd = parentIdx
          for (let i = parentIdx + 1; i < without.length; i++) {
            if (without[i].parentTrackId === parentId) groupEnd = i
            else break
          }
          // Allow insertion at any position within [parentIdx + 1 .. groupEnd + 1].
          const minInsert = parentIdx + 1
          const maxInsert = groupEnd + 1
          if (insertIdx < minInsert) insertIdx = minInsert
          if (insertIdx > maxInsert) insertIdx = maxInsert
        }
      }
      const next = [...without.slice(0, insertIdx), ...block, ...without.slice(insertIdx)]
      return { session: { ...st.session, tracks: next } }
    }),
  removeTrack: (id) =>
    set((st) => {
      // Cascade: removing a Template header also removes every Function
      // row that lists it as parent — Reaper-style "delete track folder"
      // semantics. Avoids leaving orphan rows that visually float in the
      // sidebar with no group context.
      const target = st.session.tracks.find((t) => t.id === id)
      const cascade = new Set<string>([id])
      if (target?.kind === 'template') {
        for (const t of st.session.tracks) {
          if (t.parentTrackId === id) cascade.add(t.id)
        }
      }
      const tracks = st.session.tracks.filter((t) => !cascade.has(t.id))
      const scenes = st.session.scenes.map((s) => {
        const cells: typeof s.cells = {}
        for (const [tid, cell] of Object.entries(s.cells)) {
          if (!cascade.has(tid)) cells[tid] = cell
        }
        return { ...s, cells }
      })
      return {
        session: { ...st.session, tracks, scenes },
        selectedTrack:
          st.selectedTrack && cascade.has(st.selectedTrack) ? null : st.selectedTrack,
        selectedTrackIds: st.selectedTrackIds.filter((tid) => !cascade.has(tid)),
        selectedCell:
          st.selectedCell && cascade.has(st.selectedCell.trackId)
            ? null
            : st.selectedCell,
        selectedCells: st.selectedCells.filter((r) => !cascade.has(r.trackId))
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
  addSilenceScene: () =>
    set((st) => {
      if (st.session.scenes.length >= 128) return st
      // A "Silence" scene is just a regular scene with no cells (so the
      // engine sends nothing) and a recognisable name + gray color.
      // nextMode defaults to 'next' because a Silence is almost
      // always a delay between two playable scenes — sticking on
      // 'stop' would silently break the sequence flow on first use.
      const base = makeScene(st.session.scenes.length)
      const scene: Scene = {
        ...base,
        name: 'Silence',
        color: '#666666',
        nextMode: 'next'
      }
      return { session: { ...st.session, scenes: [...st.session.scenes, scene] } }
    }),
  addScenes: (count) =>
    set((st) => {
      const room = 128 - st.session.scenes.length
      const n = Math.max(0, Math.min(room, Math.floor(count)))
      if (n === 0) return st
      const created: Scene[] = []
      for (let i = 0; i < n; i++) {
        created.push(makeScene(st.session.scenes.length + i))
      }
      return {
        session: { ...st.session, scenes: [...st.session.scenes, ...created] }
      }
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
  setInstrumentTriggerMidi: (sceneId, templateRowId, binding) =>
    set((st) => ({
      session: {
        ...st.session,
        scenes: st.session.scenes.map((s) => {
          if (s.id !== sceneId) return s
          const map = { ...(s.instrumentTriggers ?? {}) }
          if (binding) map[templateRowId] = binding
          else delete map[templateRowId]
          // Drop the field entirely when empty so save files stay
          // tidy / round-trip cleanly through propagateDefaults.
          const next = Object.keys(map).length > 0 ? map : undefined
          return { ...s, instrumentTriggers: next }
        })
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
      selectedTrackIds: [],
      // Mutually exclusive with Pool selection — see setPoolSelection for
      // the explanation.
      poolSelection: null
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
        selectedTrackIds: [],
        poolSelection: null
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
    set((st) => ({
      selectedTrack: id,
      selectedTrackIds: id ? [id] : [],
      selectedCell: null,
      selectedCells: [],
      // Selecting a track drives the Edit-view Inspector AWAY from a
      // Pool selection so the right pane reflects the row the user just
      // clicked. If they wanted to keep editing the Pool item, they can
      // re-select it from the Pool drawer.
      poolSelection: id ? null : st.poolSelection
    })),
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
      // Cascade Template-header deletes to their child Function rows
      // (same semantics as removeTrack singular).
      const idSet = new Set(ids)
      for (const id of ids) {
        const t = st.session.tracks.find((tt) => tt.id === id)
        if (t?.kind === 'template') {
          for (const c of st.session.tracks) {
            if (c.parentTrackId === id) idSet.add(c.id)
          }
        }
      }
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
  setScenePaletteWidth: (w) => set({ scenePaletteWidth: clampInt(w, 200, 1200) }),
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
  setOscMonitorHeight: (h) => set({ oscMonitorHeight: clampInt(h, 120, 600) }),
  setPoolHidden: (v) => set({ poolHidden: v }),
  setEditInspectorVisible: (v) => set({ editInspectorVisible: v }),
  setSceneInspectorVisible: (v) => set({ sceneInspectorVisible: v }),
  setTimelineMode: (v) => set({ timelineMode: v }),
  setSelectedSequenceSlot: (i) =>
    set({ selectedSequenceSlot: i, selectedSequenceSlots: i === null ? [] : [i] }),
  selectSequenceSlotRange: (i) =>
    set((st) => {
      const anchor = st.selectedSequenceSlot
      if (anchor === null) {
        return { selectedSequenceSlot: i, selectedSequenceSlots: [i] }
      }
      const lo = Math.min(anchor, i)
      const hi = Math.max(anchor, i)
      const range: number[] = []
      for (let k = lo; k <= hi; k++) range.push(k)
      return { selectedSequenceSlot: anchor, selectedSequenceSlots: range }
    }),
  requestFocusDuration: () => set((s) => ({ focusDurationToken: s.focusDurationToken + 1 })),
  requestSessionLoad: (session, path) => {
    // Lazy-import to avoid a circular dep (sessionIntegrity is a hook
    // module that might reference store types in the future).
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { checkSessionIntegrity } = require('./hooks/sessionIntegrity') as typeof import('./hooks/sessionIntegrity')
    const issues = checkSessionIntegrity(session)
    if (issues.length === 0) {
      get().setSession(session)
      get().setCurrentFilePath(path)
      return
    }
    set({ pendingIntegrityLoad: { session, path, issues } })
  },
  resolveIntegrityLoad: (commit) => {
    const st = get()
    const pending = st.pendingIntegrityLoad
    if (!pending) return
    set({ pendingIntegrityLoad: null })
    if (!commit) return // cancel path
    st.setSession(commit)
    st.setCurrentFilePath(pending.path)
  },
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
  triggerSceneWithMorph: (sceneId, sourceSlotIdx) => {
    const morphMs = get().resolveMorphMs(sceneId)
    const opts: { morphMs?: number; sourceSlotIdx?: number | null } = {}
    if (morphMs !== undefined) opts.morphMs = morphMs
    if (sourceSlotIdx !== undefined) opts.sourceSlotIdx = sourceSlotIdx
    void window.api.triggerScene(
      sceneId,
      opts.morphMs !== undefined || opts.sourceSlotIdx !== undefined ? opts : undefined
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
          random: { ...base.modulation.random, ...(tm?.random ?? {}) },
          // S&H / Slew / Chaos — same deep-clone rule. Templates saved
          // before these modulators existed spread in as undefined and
          // we fall through to the base defaults.
          sh: { ...base.modulation.sh, ...(tm?.sh ?? {}) },
          slew: { ...base.modulation.slew, ...(tm?.slew ?? {}) },
          chaos: { ...base.modulation.chaos, ...(tm?.chaos ?? {}) }
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
        name: typeof t.name === 'string' ? t.name : 'Instrument',
        // New `kind` field. Pre-merger sessions don't have it → all
        // existing tracks load as orphan Functions (the previous
        // visual). Templates are only created via the Pool flow.
        kind:
          (t as { kind?: TrackKind }).kind === 'template' ? 'template' : 'function',
        parentTrackId:
          typeof (t as { parentTrackId?: string }).parentTrackId === 'string'
            ? (t as { parentTrackId: string }).parentTrackId
            : undefined,
        sourceTemplateId:
          typeof (t as { sourceTemplateId?: string }).sourceTemplateId === 'string'
            ? (t as { sourceTemplateId: string }).sourceTemplateId
            : undefined,
        sourceFunctionId:
          typeof (t as { sourceFunctionId?: string }).sourceFunctionId === 'string'
            ? (t as { sourceFunctionId: string }).sourceFunctionId
            : undefined,
        defaultOscAddress:
          typeof t.defaultOscAddress === 'string' ? t.defaultOscAddress : undefined,
        defaultDestIp: typeof t.defaultDestIp === 'string' ? t.defaultDestIp : undefined,
        defaultDestPort:
          typeof t.defaultDestPort === 'number' ? t.defaultDestPort : undefined,
        midiTrigger: sanitizeMidiBinding(t.midiTrigger)
      })),
    // Pool — pre-merger sessions don't have one; ship the builtin library
    // so the user sees the OCTOCOSME / XYZ / Pandore starter templates
    // even on a fresh open of an old file.
    pool: sanitizePool(s.pool),
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
                  stepValues: [...c.sequencer.stepValues],
                  // Euclidean fields — new in this build. Older sessions
                  // default to classic 'steps' mode with sensible pulses /
                  // rotation (factory default tresillo 3-over-8).
                  mode:
                    (c.sequencer as Partial<typeof DEFAULT_SEQUENCER>).mode === 'euclidean'
                      ? 'euclidean'
                      : 'steps',
                  pulses:
                    typeof (c.sequencer as Partial<typeof DEFAULT_SEQUENCER>).pulses === 'number'
                      ? Math.max(
                          0,
                          Math.min(
                            16,
                            Math.floor(
                              (c.sequencer as Partial<typeof DEFAULT_SEQUENCER>).pulses as number
                            )
                          )
                        )
                      : DEFAULT_SEQUENCER.pulses,
                  rotation:
                    typeof (c.sequencer as Partial<typeof DEFAULT_SEQUENCER>).rotation ===
                    'number'
                      ? Math.max(
                          0,
                          Math.min(
                            15,
                            Math.floor(
                              (c.sequencer as Partial<typeof DEFAULT_SEQUENCER>)
                                .rotation as number
                            )
                          )
                        )
                      : DEFAULT_SEQUENCER.rotation
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
              },
              // S&H / Slew / Chaos — all three brand-new; back-fill on
              // load so older session files still satisfy the type and
              // the engine has valid numbers to work with.
              sh: {
                smooth:
                  typeof (m?.sh as Partial<typeof DEFAULT_SH> | undefined)?.smooth === 'boolean'
                    ? (m!.sh as typeof DEFAULT_SH).smooth
                    : DEFAULT_SH.smooth,
                probability:
                  typeof (m?.sh as Partial<typeof DEFAULT_SH> | undefined)?.probability === 'number'
                    ? Math.max(
                        0,
                        Math.min(1, (m!.sh as typeof DEFAULT_SH).probability)
                      )
                    : DEFAULT_SH.probability
              },
              slew: {
                riseMs:
                  typeof (m?.slew as Partial<typeof DEFAULT_SLEW> | undefined)?.riseMs === 'number'
                    ? Math.max(0, (m!.slew as typeof DEFAULT_SLEW).riseMs)
                    : DEFAULT_SLEW.riseMs,
                fallMs:
                  typeof (m?.slew as Partial<typeof DEFAULT_SLEW> | undefined)?.fallMs === 'number'
                    ? Math.max(0, (m!.slew as typeof DEFAULT_SLEW).fallMs)
                    : DEFAULT_SLEW.fallMs,
                randomTarget:
                  typeof (m?.slew as Partial<typeof DEFAULT_SLEW> | undefined)?.randomTarget ===
                  'boolean'
                    ? (m!.slew as typeof DEFAULT_SLEW).randomTarget
                    : DEFAULT_SLEW.randomTarget
              },
              chaos: {
                r:
                  typeof (m?.chaos as Partial<typeof DEFAULT_CHAOS> | undefined)?.r === 'number'
                    ? Math.max(
                        3.4,
                        Math.min(4.0, (m!.chaos as typeof DEFAULT_CHAOS).r)
                      )
                    : DEFAULT_CHAOS.r
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

// Sanitize the Pool slice. Pre-merger sessions don't have one; we always
// at least seed with the builtin library so the user can see what the
// Pool concept looks like even on an empty session. User-authored
// templates from the saved session are merged on top, deduped by id.
const VALID_PARAM_TYPES = new Set<FunctionParamType>([
  'bool', 'int', 'float', 'v2', 'v3', 'v4', 'colour', 'string'
])
const VALID_NATURES = new Set<FunctionParamNature>(['lin', 'log', 'exp'])
const VALID_STREAM_MODES = new Set<FunctionStreamMode>([
  'streaming', 'discrete', 'polling'
])

function sanitizeFunction(raw: unknown, idx: number): InstrumentFunction | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  if (typeof r.id !== 'string' || typeof r.name !== 'string') return null
  return {
    id: r.id,
    name: r.name,
    oscPath: typeof r.oscPath === 'string' ? r.oscPath : `param${idx + 1}`,
    destIpOverride:
      typeof r.destIpOverride === 'string' ? r.destIpOverride : undefined,
    destPortOverride:
      typeof r.destPortOverride === 'number' ? r.destPortOverride : undefined,
    paramType:
      typeof r.paramType === 'string' && VALID_PARAM_TYPES.has(r.paramType as FunctionParamType)
        ? (r.paramType as FunctionParamType)
        : 'float',
    nature:
      typeof r.nature === 'string' && VALID_NATURES.has(r.nature as FunctionParamNature)
        ? (r.nature as FunctionParamNature)
        : 'lin',
    streamMode:
      typeof r.streamMode === 'string' &&
      VALID_STREAM_MODES.has(r.streamMode as FunctionStreamMode)
        ? (r.streamMode as FunctionStreamMode)
        : 'streaming',
    min: typeof r.min === 'number' ? r.min : undefined,
    max: typeof r.max === 'number' ? r.max : undefined,
    init: typeof r.init === 'number' ? r.init : undefined,
    unit: typeof r.unit === 'string' ? r.unit : undefined,
    smoothMs: typeof r.smoothMs === 'number' ? r.smoothMs : undefined,
    notes: typeof r.notes === 'string' ? r.notes : undefined
  }
}

function sanitizeTemplate(raw: unknown): InstrumentTemplate | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  if (typeof r.id !== 'string' || typeof r.name !== 'string') return null
  const fns = (Array.isArray(r.functions) ? r.functions : [])
    .map((f, i) => sanitizeFunction(f, i))
    .filter((f): f is InstrumentFunction => f !== null)
  return {
    id: r.id,
    name: r.name,
    description: typeof r.description === 'string' ? r.description : '',
    color: typeof r.color === 'string' ? r.color : '#888888',
    destIp: typeof r.destIp === 'string' ? r.destIp : '127.0.0.1',
    destPort: typeof r.destPort === 'number' ? r.destPort : 9000,
    oscAddressBase: typeof r.oscAddressBase === 'string' ? r.oscAddressBase : '/instrument',
    voices:
      typeof r.voices === 'number' && r.voices >= 1 ? Math.floor(r.voices) : 1,
    builtin: r.builtin === true,
    draft: r.draft === true,
    functions: fns
  }
}

function sanitizePool(raw: unknown): Pool {
  const builtin = makeBuiltinPool()
  const userTemplates = raw && typeof raw === 'object' && Array.isArray((raw as Pool).templates)
    ? (raw as Pool).templates
        .map((t) => sanitizeTemplate(t))
        .filter((t): t is InstrumentTemplate => t !== null)
    : []
  // Merge: dedupe by id, builtin always wins so its definition can't be
  // accidentally drifted by an old session file. User-authored entries
  // (no id collision with builtins) are appended in order.
  const seen = new Set<string>(builtin.templates.map((t) => t.id))
  const merged: InstrumentTemplate[] = [...builtin.templates]
  for (const t of userTemplates) {
    if (seen.has(t.id)) continue
    seen.add(t.id)
    merged.push({ ...t, builtin: false })
  }
  // Same merge strategy for Parameter blueprints. Pre-Parameters
  // sessions don't have the field — `parameters` is undefined and we
  // fall back to just the builtin set.
  const userParameters =
    raw && typeof raw === 'object' && Array.isArray((raw as Pool).parameters)
      ? (raw as Pool).parameters
          .map((p) => sanitizeParameter(p))
          .filter((p): p is ParameterTemplate => p !== null)
      : []
  const seenP = new Set<string>(builtin.parameters.map((p) => p.id))
  const mergedParams: ParameterTemplate[] = [...builtin.parameters]
  for (const p of userParameters) {
    if (seenP.has(p.id)) continue
    seenP.add(p.id)
    mergedParams.push({ ...p, builtin: false })
  }
  return { templates: merged, parameters: mergedParams }
}

function sanitizeParameter(raw: unknown): ParameterTemplate | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Partial<ParameterTemplate>
  if (typeof r.id !== 'string' || typeof r.name !== 'string') return null
  return {
    id: r.id,
    name: r.name,
    description: typeof r.description === 'string' ? r.description : undefined,
    color: typeof r.color === 'string' ? r.color : '#888888',
    oscPath: typeof r.oscPath === 'string' ? r.oscPath : 'param',
    destIp: typeof r.destIp === 'string' ? r.destIp : '127.0.0.1',
    destPort: typeof r.destPort === 'number' ? r.destPort : 9000,
    paramType:
      typeof r.paramType === 'string' && VALID_PARAM_TYPES.has(r.paramType as FunctionParamType)
        ? (r.paramType as FunctionParamType)
        : 'float',
    nature: r.nature === 'log' || r.nature === 'exp' ? r.nature : 'lin',
    streamMode:
      r.streamMode === 'discrete' || r.streamMode === 'polling'
        ? r.streamMode
        : 'streaming',
    min: typeof r.min === 'number' ? r.min : undefined,
    max: typeof r.max === 'number' ? r.max : undefined,
    init: typeof r.init === 'number' ? r.init : undefined,
    unit: typeof r.unit === 'string' ? r.unit : undefined,
    smoothMs: typeof r.smoothMs === 'number' ? r.smoothMs : undefined,
    notes: typeof r.notes === 'string' ? r.notes : undefined,
    builtin: r.builtin === true
  }
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
