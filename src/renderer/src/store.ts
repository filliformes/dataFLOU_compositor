import { create } from 'zustand'
// Imported lazily-used (only referenced inside action bodies) so the
// undo.ts ↔ store.ts circular import resolves cleanly under ESM —
// no top-level reads of `resetUndoHistory` before it's bound.
import { resetUndoHistory } from './undo'
import type {
  Cell,
  EngineState,
  FunctionParamNature,
  FunctionParamType,
  FunctionStreamMode,
  GenerativeConfig,
  GenerativeMode,
  GenerativePoolSource,
  InputConditionerConfig,
  InstrumentFunction,
  InstrumentTemplate,
  MetaController,
  MetaCurve,
  MetaDest,
  MetaKnob,
  MidiBinding,
  NextMode,
  OscForwardTarget,
  ParameterTemplate,
  AttractorParams,
  GestureParams,
  Pool,
  RampParams,
  RandomParams,
  SampleHoldParams,
  Scene,
  SeqMode,
  SeqSyncMode,
  SequencerParams,
  SequenceSlotOverride,
  Session,
  StateTrigger,
  StateMidiAction,
  LearnedState,
  PoseSequence,
  PoseWaypoint,
  Track,
  TrackKind
} from '@shared/types'
import {
  GENERATIVE_AFFINITY_MAX,
  GENERATIVE_AFFINITY_MIN,
  GENERATIVE_DURATION_MAX_MS,
  GENERATIVE_DURATION_MIN_MS,
  META_KNOB_COUNT,
  META_MAX_DESTS,
  SCENE_WEIGHT_DEFAULT,
  SCENE_WEIGHT_MAX,
  SCENE_WEIGHT_MIN
} from '@shared/types'
import {
  DEFAULT_ARPEGGIATOR,
  DEFAULT_CHAOS,
  DEFAULT_ENVELOPE,
  DEFAULT_GENERATIVE_CONFIG,
  DEFAULT_MODULATION,
  DEFAULT_RAMP,
  DEFAULT_ATTRACTOR,
  DEFAULT_GESTURE,
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
  buildInitialValueFromArgSpec,
  inferParamTypeFromArgTypes,
  makeMetaController,
  makeMetaKnob,
  makeParameterSpec,
  makeScene,
  makeStateTrigger,
  makePoseSequence,
  makePoseWaypoint,
  makeTemplateSpec,
  makeTemplateTrack,
  makeTrack,
  parseValueTokens,
  TRANSFER_CURVES
} from '@shared/factory'

// (v0.6.4) Valid transfer-curve values, for the scaling sanitizer.
const TRANSFER_CURVE_SET = new Set<string>(TRANSFER_CURVES.map((c) => c.value))
import { checkSessionIntegrity } from './hooks/sessionIntegrity'
import { dumpScopePrefs, loadScopePrefs, pruneScopePrefs } from './scopePrefs'

// ---- Clip templates: persisted in localStorage so they survive app restarts.

const TEMPLATES_KEY = 'dataflou:clipTemplates:v1'

// ---- UI scale: persisted in localStorage. Controls Ctrl+wheel zoom of
// everything below the main toolbar. Clamped to [UI_SCALE_MIN, UI_SCALE_MAX]
// so the user can't accidentally render the app unusable (too small or huge).
//
// Default 1.35 (≈ 7 Ctrl-wheel ticks above the legacy 1.0) — at modern
// monitor DPIs the legacy scale rendered the toolbar/scene tiles tiny
// enough that a fresh install was unreadable until the user discovered
// the zoom. 1.35 keeps the layout dense without forcing immediate
// zoom on first launch. Users who prefer the old size can drop it
// back via Ctrl+wheel; their choice persists per the localStorage key
// below.
const UI_SCALE_KEY = 'dataflou:uiScale:v1'
export const UI_SCALE_MIN = 0.5
export const UI_SCALE_MAX = 2.0
export const UI_SCALE_STEP = 0.05
const UI_SCALE_DEFAULT = 1.35

function loadUiScale(): number {
  try {
    const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(UI_SCALE_KEY) : null
    const n = raw == null ? NaN : parseFloat(raw)
    return Number.isFinite(n) && n >= UI_SCALE_MIN && n <= UI_SCALE_MAX
      ? n
      : UI_SCALE_DEFAULT
  } catch {
    return UI_SCALE_DEFAULT
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

// v0.5.10 -- per-toolbar zoom multiplier. Applied on top of `uiScale`
// so a user can scale up the main toolbar independently of the
// working area (use case: at uiScale 0.6 the toolbar buttons get
// hard to read; topBarScale lifts JUST the toolbar without
// rescaling every Scene column). Stored in session.ui so it
// travels with the file, mirrored to localStorage for fresh-session
// defaults. Effective toolbar zoom = uiScale * topBarScale.
const TOPBAR_SCALE_KEY = 'dataflou:topBarScale:v1'
export const TOPBAR_SCALE_MIN = 0.5
export const TOPBAR_SCALE_MAX = 2.5
export const TOPBAR_SCALE_STEP = 0.05
const TOPBAR_SCALE_DEFAULT = 1.0
function loadTopBarScale(): number {
  try {
    const raw =
      typeof localStorage !== 'undefined'
        ? localStorage.getItem(TOPBAR_SCALE_KEY)
        : null
    const n = raw == null ? NaN : parseFloat(raw)
    return Number.isFinite(n) && n >= TOPBAR_SCALE_MIN && n <= TOPBAR_SCALE_MAX
      ? n
      : TOPBAR_SCALE_DEFAULT
  } catch {
    return TOPBAR_SCALE_DEFAULT
  }
}
function saveTopBarScale(v: number): void {
  try {
    if (typeof localStorage === 'undefined') return
    localStorage.setItem(TOPBAR_SCALE_KEY, String(v))
  } catch {
    /* ignore */
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
  // Snapshot of the source track's argSpec at save time. Carries
  // the multi-arg structure (pinned prefixes + editable value slots)
  // so applying this template onto an empty Parameter — one with
  // no argSpec yet — fills it in. Without this, a multi-arg clip
  // template applied to a fresh Parameter would only see its
  // space-separated value string without knowing which tokens are
  // fixed and which are user-controllable. Optional + back-compat
  // for legacy templates saved before this field existed.
  argSpec?: import('@shared/types').ParamArgSpec[]
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
  // v0.5.10 -- per-toolbar zoom multiplier, applied on top of `uiScale`.
  // 1 = 100% (toolbar same size as everything else). Use case: at very
  // small uiScale (e.g. 0.6) the top toolbar gets unreadable; bumping
  // topBarScale to 1.4 brings JUST the toolbar back to legible size
  // without rescaling the Scene grid. Persisted in localStorage AND
  // mirrored into session.ui.topBarScale so it travels with the file.
  topBarScale: number
  // (v0.6) Revision counter bumped whenever a Parameter scope's frame
  // (time / value / height) changes. The scope prefs themselves live in
  // a module-scope Map (scopePrefs.ts) to avoid store churn, but they
  // must still trigger App's session-flush effect so autosave + the
  // main-process session copy stay current — this counter is that
  // trigger. See bumpScopePrefsRev.
  scopePrefsRev: number
  // Shared height of the scene-notes textarea in pixels. Drives header height
  // across all scene columns + the track sidebar so rows stay aligned.
  editorNotesHeight: number
  // Resizable layout dimensions.
  rowHeight: number // 40..220
  sceneColumnWidth: number // 140..480
  // Width of the Sequence view's left column (scene palette + info panel).
  // 200..480; default 280. Drag the handle on the column's right edge.
  scenePaletteWidth: number
  // Height of the Scene Info Panel below the scenes palette in the
  // Sequence view (v0.5.10). User-resizable via a drag handle on
  // its top edge. Clamped to a sensible band so it can't shrink
  // away entirely or push the palette grid offscreen.
  sceneInfoPanelHeight: number
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
    // Generative Scene Sequencer (v0.5.10) learn targets. Bindings
    // live on session.generative.{toggleMidi, noRepeatMidi,
    // affinityMidi, minDurationMidi, maxDurationMidi, useMorphMidi,
    // randomWeightsMidi}.
    | { kind: 'generativeToggle' }
    | { kind: 'generativeNoRepeat' }
    | { kind: 'generativeAffinity' }
    | { kind: 'generativeMinDuration' }
    | { kind: 'generativeMaxDuration' }
    | { kind: 'generativeUseMorph' }
    | { kind: 'generativeRandomWeights' }
    // (v0.6.x) Motion Loop record toggle (focused scene). Binding lives
    // on session.motionLoopRecordMidi.
    | { kind: 'motionLoopRecord' }
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
  // Generative Settings popover open flag (v0.5.10). UI-only -- not
  // persisted with the session. Lifted to the store so the G hotkey
  // can toggle visibility from anywhere in the app, not just from
  // the chevron next to the GENERATIVE button. Default false so a
  // fresh app load doesn't pop the popover unprompted.
  generativePopoverOpen: boolean
  // (v0.6.x) Motion Loop recording status (UI-only, not persisted). When
  // a scene is armed for hardware capture, this holds its id + start
  // wall-clock so the Scene inspector can show a live "Recording… N.Ns".
  recordingLoopSceneId: string | null
  recordingLoopStartedAt: number | null
  // (v0.6.4) Global Mappings view — overlays the main content when true.
  // Toggled from the transport bar. UI-only, not persisted.
  mappingsOpen: boolean
  setMappingsOpen: (v: boolean) => void
  // (v0.6.5) Global Signals view — overlays the main content when true.
  // "Mission control" for every State Trigger + Pose Sequence across the
  // session, grouped by instrument. Toggled by the "S" key + transport
  // bar. UI-only, not persisted.
  signalsOpen: boolean
  setSignalsOpen: (v: boolean) => void
  // (v0.6.5) True while ANY pose capture is running (a single-pose
  // Record or the whole-sequence companion recorder). The engine has a
  // single learn-recording slot, so a second concurrent capture would
  // corrupt the first — this gates the record buttons app-wide. UI-only.
  poseRecordBusy: boolean
  setPoseRecordBusy: (v: boolean) => void
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
    | { kind: 'savedScene'; savedSceneId: string }
    | null
  // Multi-selection set for the Pool's Scenes tab. Ctrl/Meta-click
  // toggles a row in/out of this set; plain click resets to just
  // that row. `poolSelection.kind === 'savedScene'` always points
  // at the most recently clicked (anchor) scene, which is also in
  // this set when non-empty. The Del key handler reads this list
  // to bulk-remove via the scene library IPC. Mirrors the
  // `selectedSceneIds` / `selectedTrackIds` pattern used for the
  // grid + sidebar selections.
  selectedSavedSceneIds: string[]
  // Undo/redo counters — published by undo.ts whenever its
  // module-scope past/future stacks change. UI buttons read these
  // to render enabled/disabled. The actual snapshot arrays live
  // outside Zustand because they hold deep-cloned Sessions
  // (potentially large) — there's no reason to make them reactive
  // beyond "stack non-empty / empty".
  undoCount: number
  redoCount: number
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
  // ── Network discovery (Pool drawer's Network tab) ─────────────────
  // Devices observed by the main-process passive UDP OSC listener.
  // Empty until the user enables the listener; updated on push from
  // the engine on a ~50ms cadence whenever the map changes. NOT
  // persisted in the session — discovery state is per-run.
  networkDevices: import('@shared/types').DiscoveredOscDevice[]
  // Listener bind status (enabled / port / lastError / local IPv4s).
  // Pulled on Network-tab mount + refreshed on every push update.
  networkStatus: import('@shared/types').NetworkListenerStatus
  // ── Saved scene library (global, across sessions) ──────────────
  // Mirrors the main-process `SceneLibrary` cache. Populated on
  // app start via `sceneLibraryList` + refreshed whenever main
  // pushes `scene-library:changed`. Not persisted in the session
  // (the source of truth is the on-disk file).
  sceneLibrary: import('@shared/types').SavedScene[]
  // Whether the Capture popup is currently open. Drives the modal
  // overlay rendered at app level. Set by the Pool's Capture
  // button + cleared by the popup's Save / Cancel.
  captureOpen: boolean
  // True while the "Save before opening a new session?" modal is up.
  // TopBar's New button sets this true instead of calling newSession
  // directly so the user gets a chance to save unsaved work; the
  // modal lives in App.tsx and runs save → newSession or just
  // newSession depending on the user's choice. Same UX as the quit
  // confirmation triggered by the OS X button.
  newSessionConfirmOpen: boolean
}

// Height (px) assigned to the scene-notes textarea when the Notes toggle
// turns notes ON. Matches one line of the textarea's line-height so the user
// gets a single-line strip by default; they can drag it taller from the
// in-editor handle if they want more.
export const NOTES_ONE_LINE_HEIGHT = 26

export type ThemeName =
  // Rainbow-Circuit-flavoured themes — these opt into rich UI controls
  // (bespoke arc sliders, icon-row mode pickers, card-wrap sections,
  // console-readout numerics) via `RICH_THEMES` below.
  | 'nature'   // Hopscotch palette — dark warm grey + olive→teal + orange
  // New themes (listed first in the picker).
  | 'studio-dark'
  | 'warm-charcoal'
  | 'graphite'
  | 'cream'    // repainted to match Peaks — cream paper + mustard ochre
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

// Themes that opt into the bespoke "rich" UI surface — custom arc
// sliders for Rate / Variation, mini-pictogram icon row in place of
// the Pattern dropdown, soft cards around inspector sections, and
// console-style numerical readouts. Other themes render the classic
// HTML form controls. Nature + Cream both use this surface (Cream's
// repainted Peaks look + Nature's Hopscotch palette).
export const RICH_THEMES: ReadonlySet<ThemeName> = new Set<ThemeName>([
  'nature',
  'cream'
])

export function isRichTheme(t: ThemeName): boolean {
  return RICH_THEMES.has(t)
}

// Bundle the renderer's runtime GUI layout into a `session.ui`
// snapshot so the next save (manual Save / Save As / autosave)
// captures the user's chosen zoom + sizes + collapse state. Called
// at every save site so the UI travels with the session file.
// On load, `setSession` reads `session.ui` back and applies each
// field to the matching top-level store key (the live source of
// truth at runtime).
export function buildSessionForSave(
  state: { session: Session; engine?: EngineState } & Partial<{
    uiScale: number
    topBarScale: number
    rowHeight: number
    sceneColumnWidth: number
    inspectorWidth: number
    trackColumnWidth: number
    editorNotesHeight: number
    oscMonitorHeight: number
    scenePaletteWidth: number
    sceneInfoPanelHeight: number
    tracksCollapsed: boolean
    scenesCollapsed: boolean
  }>
): Session {
  // Snapshot the live Hardware Mode catch state into the saved
  // session so reopening a show resumes with the same caught arg
  // slots highlighted red. Override VALUES are intentionally
  // omitted — they self-heal on the next OSC packet from the bound
  // device (usually within milliseconds).
  const caughtByTrack = state.engine?.hardwareCaughtByTrack
  const hardwareState =
    caughtByTrack && Object.keys(caughtByTrack).length > 0
      ? { caughtByTrack }
      : undefined
  return {
    ...state.session,
    ui: {
      uiScale: state.uiScale,
      topBarScale: state.topBarScale,
      rowHeight: state.rowHeight,
      sceneColumnWidth: state.sceneColumnWidth,
      inspectorWidth: state.inspectorWidth,
      trackColumnWidth: state.trackColumnWidth,
      editorNotesHeight: state.editorNotesHeight,
      oscMonitorHeight: state.oscMonitorHeight,
      // (#18) Persist the Sequence-view pane dimensions alongside their
      // siblings so they survive a save/reload.
      scenePaletteWidth: state.scenePaletteWidth,
      sceneInfoPanelHeight: state.sceneInfoPanelHeight,
      tracksCollapsed: state.tracksCollapsed,
      scenesCollapsed: state.scenesCollapsed,
      // (v0.6) Persist the per-scope frames (time/value/height per
      // Parameter). Read from the module-scope Map, not store state,
      // so height-drags don't churn the store — see scopePrefs.ts.
      scopePrefs: dumpScopePrefs()
    },
    // (#13) Always OVERWRITE the key with the CURRENT value (possibly
    // undefined) — spreading conditionally kept a stale file-loaded
    // catch blob alive after the engine released every catch, so dead
    // catches resurrected on reopen. JSON.stringify drops the undefined
    // key on save, so an empty catch state serializes to absent.
    hardwareState
  }
}

// Module-scope set of scene ids that originated from
// `instantiateSavedScene` (i.e. dropped onto the grid from the
// Pool's Scenes tab via Use / drag). App.tsx's auto-save effect
// checks this set to skip pushing these scenes BACK to the library
// — they already live there, otherwise clicking Use would silently
// create a sibling library entry on every recall.
//
// Set, not state: we don't render off it and we don't want it
// triggering re-renders. It only grows over a session's lifetime
// (bounded by the number of Use clicks); cleared implicitly on
// app restart.
export const sceneIdsFromLibrary = new Set<string>()

// Last-known pool library payload — kept in module scope so
// `newSession` can re-seed the fresh session's pool with the user's
// authored Instruments + Parameters. App.tsx fetches the library on
// mount and pushes updates here on every `pool-library:changed`
// IPC. Without this, hitting New wiped the User tab until the user
// saved something.
export const poolLibraryCache: {
  templates: import('@shared/types').InstrumentTemplate[]
  parameters: import('@shared/types').ParameterTemplate[]
} = { templates: [], parameters: [] }
export function setPoolLibraryCache(payload: {
  templates: import('@shared/types').InstrumentTemplate[]
  parameters: import('@shared/types').ParameterTemplate[]
}): void {
  poolLibraryCache.templates = payload.templates ?? []
  poolLibraryCache.parameters = payload.parameters ?? []
}

// Build a unique " (copy)" name for a duplicated Pool entry. The
// first duplicate is `<base> (copy)`; subsequent duplicates count
// up: `(copy 1)`, `(copy 2)`, …. Duplicating an already-numbered
// copy strips the existing suffix first so we don't accumulate
// `(copy) (copy) (copy)` chains.
// (#17) Generate a collision-free scene id. The old inline
// `s_${Math.random().toString(36).slice(2, 9)}` could produce a SHORT
// id (random base-36 can have leading-zero loss) with NO guard against
// reusing an id already on the grid. This loops until the fixed-length
// `s_` id is unique against the supplied existing-id set.
function makeSceneId(existingIds: Iterable<string>): string {
  const taken = existingIds instanceof Set ? existingIds : new Set(existingIds)
  for (;;) {
    // pad to a fixed 7-char suffix so the id is always `s_` + 7 chars.
    const suffix = Math.random().toString(36).slice(2, 9).padEnd(7, '0')
    const id = `s_${suffix}`
    if (!taken.has(id)) return id
  }
}

// (#20) Debounced disk persistence for the linked-SavedScene mirror.
// updateScene's mirror runs on every keystroke when editing a linked
// scene's name/notes/duration; the in-store set() must stay immediate
// (the UI reads it), but the window.api.sceneLibrarySave disk write is
// expensive and only the final value matters. Coalesce per savedSceneId
// with a 400ms trailing debounce — the latest payload wins, one write
// per edit-burst. Keyed by id so editing two linked scenes doesn't
// clobber each other's pending write.
const savedSceneSaveTimers = new Map<string, ReturnType<typeof setTimeout>>()
function debouncedSceneLibrarySave(saved: { id: string }): void {
  const existing = savedSceneSaveTimers.get(saved.id)
  if (existing) clearTimeout(existing)
  savedSceneSaveTimers.set(
    saved.id,
    setTimeout(() => {
      savedSceneSaveTimers.delete(saved.id)
      try {
        void window.api?.sceneLibrarySave?.(saved as never)
      } catch (e) {
        console.warn('[debouncedSceneLibrarySave] failed:', (e as Error).message)
      }
    }, 400)
  )
}

function uniqueCopyName(srcName: string, existingNames: string[]): string {
  const stripRe = /\s*\(copy(?:\s+\d+)?\)$/
  const base = srcName.replace(stripRe, '')
  const first = `${base} (copy)`
  if (!existingNames.includes(first)) return first
  let n = 1
  while (existingNames.includes(`${base} (copy ${n})`)) n += 1
  return `${base} (copy ${n})`
}

interface Actions {
  // Session-level
  setSession: (s: Session) => void
  newSession: () => void
  setCurrentFilePath: (p: string | null) => void
  setName: (name: string) => void
  setTickRate: (hz: number) => void
  setMidiEnabled: (enabled: boolean) => void
  setDefaults: (fields: Partial<Pick<Session, 'defaultOscAddress' | 'defaultDestIp' | 'defaultDestPort'>>) => void
  // OSC forwarding — every received UDP packet is byte-copied to each
  // ENABLED entry in the list. Replacing the whole list on every edit
  // is fine: the list is short (<10 typical) and main re-applies it
  // synchronously.
  addForwardTarget: (init?: Partial<OscForwardTarget>) => string
  updateForwardTarget: (id: string, fields: Partial<OscForwardTarget>) => void
  removeForwardTarget: (id: string) => void
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
  // Patch the Hardware Mode config on a template. Works on builtin
  // templates too (HW Mode is a user preference, not a definitional
  // change). Partial — only the keys you pass are updated.
  setTemplateHardwareMode: (
    id: string,
    patch: Partial<NonNullable<InstrumentTemplate['hardwareMode']>>
  ) => void
  // Input Conditioning (v0.6) — patch the template's smoothing chain.
  // Same contract as setTemplateHardwareMode: partial patch, works on
  // builtins (conditioning is a user preference, not definitional).
  setTemplateInputConditioner: (
    id: string,
    patch: Partial<InputConditionerConfig>
  ) => void
  // (v0.6.4) Derived Parameters — replace the whole list on a template.
  setTemplateDerivedParams: (
    id: string,
    derivedParams: import('@shared/types').DerivedParam[]
  ) => void
  // State Triggers (v0.6) — CRUD on template.stateTriggers.
  addStateTrigger: (templateId: string) => string | null // returns new state id
  updateStateTrigger: (
    templateId: string,
    stateId: string,
    patch: Partial<StateTrigger>
  ) => void
  removeStateTrigger: (templateId: string, stateId: string) => void
  // Pose Sequences (v0.6.5) — ordered learned-pose phrases on a template.
  addPoseSequence: (templateId: string) => string | null // returns new sequence id
  updatePoseSequence: (
    templateId: string,
    seqId: string,
    patch: Partial<PoseSequence>
  ) => void
  removePoseSequence: (templateId: string, seqId: string) => void
  addWaypoint: (templateId: string, seqId: string) => string | null // returns new waypoint id
  updateWaypoint: (
    templateId: string,
    seqId: string,
    waypointId: string,
    patch: Partial<PoseWaypoint>
  ) => void
  removeWaypoint: (templateId: string, seqId: string, waypointId: string) => void
  moveWaypoint: (
    templateId: string,
    seqId: string,
    waypointId: string,
    dir: -1 | 1
  ) => void
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
  // SavedScene multi-selection helpers. `selectSavedScene` is the
  // anchor setter (single click); `toggleSavedSceneSelection` is
  // Ctrl/Meta-click; `clearSavedSceneSelection` wipes the set.
  // All three keep `poolSelection` in sync — the inspector pane
  // always renders the anchor (last-clicked or single) scene.
  selectSavedScene: (savedSceneId: string) => void
  toggleSavedSceneSelection: (savedSceneId: string) => void
  clearSavedSceneSelection: () => void
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
  // Clone an existing Function (Parameter) sidebar row, inserting the
  // duplicate immediately after the source. Cells from every scene
  // are copied onto the new row so the duplicate plays the same
  // values as the source instead of being empty. Both rows still
  // point at the same Pool blueprint (sourceTemplateId +
  // sourceFunctionId) — duplicating doesn't fork the blueprint.
  duplicateFunctionTrack: (id: string) => string | null
  // Same as above for a Template (Instrument) row — clones the row
  // AND all of its Function children + all their cells on every
  // scene. Pool blueprint stays the same (multi-instance of the
  // template), so changes to the underlying Template apply to both.
  duplicateInstrumentTrack: (id: string) => string | null
  // Internal Ctrl+C / Ctrl+V clipboard. Lives in the store (not the
  // OS clipboard) so it can't conflict with text-field paste in other
  // apps and can carry rich Track/Cell payloads. Three payload kinds:
  //  - 'cell' → a single clip; paste target = selectedCell
  //  - 'function-track' → a Parameter row + cells on every scene
  //  - 'instrument-track' → Template row + child rows + cells
  clipboard:
    | { kind: 'cell'; cell: Cell }
    | {
        kind: 'function-track'
        track: Track
        cellsByScene: Record<string, Cell>
      }
    | {
        kind: 'instrument-track'
        track: Track
        children: Track[]
        // cellsByScene[sceneId][childTrackId] = Cell
        cellsByScene: Record<string, Record<string, Cell>>
      }
    | null
  copyToClipboard: () => void
  pasteFromClipboard: () => void
  renameTrack: (id: string, name: string) => void
  setTrackMidi: (id: string, binding: Track['midiTrigger']) => void
  setTrackDefaults: (
    id: string,
    fields: Partial<
      Pick<
        Track,
        | 'defaultOscAddress'
        | 'defaultDestIp'
        | 'defaultDestPort'
        // `oscEnabled` is technically not a "default" but it shares
        // the same per-track-shallow-patch shape, so the existing
        // action handles it without a new code path.
        | 'oscEnabled'
      >
    >
  ) => void
  // Set the Parameter-row's MIDI Output default. Patch-style so the
  // Inspector can flip individual fields (port, channel, kind, cc)
  // without sending the whole object. Pass `null` to clear.
  setTrackMidiOut: (
    id: string,
    patch: Partial<import('@shared/types').MidiOut> | null
  ) => void
  sendTrackDefaultsToClips: (id: string) => void
  // Broadcast a single transitionMs value to every existing cell on
  // the given track. v0.5.10 -- driven from the Parameter Inspector's
  // new Default Transition box. Doesn't touch `cell.timingEnabled` so
  // cells with Timing turned off keep their flag (they just remember
  // the new value for when re-enabled).
  broadcastTransitionMs: (trackId: string, transitionMs: number) => void
  // Switch an entire Instrument (template + every instantiated row +
  // every cell on those rows + every Function blueprint on the
  // template) to a new OSC destination port in one click. Use case:
  // two physical OCTOCOSME controllers on ports 1985 + 1986; flip
  // between them mid-show without touching individual cells. Lets
  // the user keep the rest of the Instrument's config (IP, OSC
  // address, sequencers, mods) intact -- only the port changes.
  // Clamped 0..65535.
  broadcastInstrumentPort: (templateId: string, port: number) => void
  // Session-wide outgoing OSC broadcast (v0.5.10). When the user
  // switches the downstream consumer's IP/port (e.g. Max moved to
  // a new laptop), this single action repoints EVERY layer at once:
  // session defaults, every Pool template, every Function override
  // (cleared so the template default wins), every Track default,
  // and every Cell's explicit destIp/destPort. The user can pass
  // ip-only, port-only, or both -- omitting a field leaves it
  // unchanged. Linkage flags are NOT touched (cells that were
  // linked stay linked + auto-follow; cells that were pinned get
  // their pinned value repointed to the new target).
  broadcastSessionDest: (next: { ip?: string; port?: number }) => void
  // Session-wide incoming OSC listener port (v0.5.10). Stored in
  // Session.listenerPort so the binding travels with the session
  // file. Setting via this action also pushes the new port to the
  // main-process OSC listener so it re-binds immediately.
  setListenerPort: (port: number) => void
  // Hardware Mode source-IP/port batch update (v0.5.10). For every
  // Pool template whose hardwareMode is configured (regardless of
  // its enabled flag), rebind to a single ip:port. Use case: the
  // user's controller moved to a new IP or port and they want every
  // HW-Moded Instrument in the Pool to follow at once. Invoked from
  // the Network discovery panel's right-click menu on a device.
  rebindAllHardwareModesToDevice: (ip: string, port: number) => void
  // Toggle a track's "enabled" flag (default: enabled). When false,
  // the engine skips this track on any trigger path.
  setTrackEnabled: (id: string, enabled: boolean) => void
  // Set the persistence flag for a single arg position on a track
  // that has an argSpec. Out-of-range indices are no-ops. When
  // pinning (persistent=true), pass the current cell-value token
  // for that slot so the engine has a concrete value to emit. The
  // captured value is stored on the track and used until unpinned.
  setTrackPersistentSlot: (
    id: string,
    slotIdx: number,
    persistent: boolean,
    capturedValue?: string
  ) => void
  // Edit the captured value for an already-pinned slot, without
  // touching the pin state. Used by the Parameter Inspector's
  // inline pinned-value editor. No-op if the slot isn't currently
  // pinned (avoids accidentally pinning a slot via a typo).
  setTrackPersistentValue: (id: string, slotIdx: number, value: string) => void
  // Per-CELL pin toggle. Overrides the track-level pin for that slot
  // on this specific scene's clip only. `persistent: true` → pin
  // (capture current value); `false` → explicit unpin; pass
  // `undefined` to clear the override and fall back to the
  // track-level default. Out-of-range indices are no-ops.
  setCellPersistentSlot: (
    sceneId: string,
    trackId: string,
    slotIdx: number,
    persistent: boolean | undefined,
    capturedValue?: string
  ) => void
  // Per-cell post-modulation Scaling — sets one slot's
  // `[min, max]` band. When `enabled` true the engine clamps that
  // slot's output to the configured range AFTER modulators /
  // sequencer but BEFORE Scale 0.0–1.0 + MIDI Scale. Pass `min` /
  // `max` to update a single slot; pass `enabled` separately to
  // toggle the whole feature.
  setCellScaling: (
    sceneId: string,
    trackId: string,
    patch: { enabled?: boolean; slotIdx?: number; min?: number; max?: number }
  ) => void
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
  // Reorder a scene by moving it from one position to another in the
  // `session.scenes[]` array. Used by drag-and-drop reordering in both
  // the Edit-view scene grid and the Sequence-view palette. The
  // `sequence[]` array (which holds scene IDs in slot positions) is
  // untouched — sequence slots reference scenes by ID, so reordering
  // the palette doesn't disturb the timeline.
  moveScene: (fromIndex: number, toIndex: number) => void
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
  // Per-slot duration / follow-action overrides. Lets the same scene
  // dropped in multiple slots have different playback envelopes
  // without affecting the scene itself or other slots.
  setSequenceSlotOverride: (
    index: number,
    patch: Partial<SequenceSlotOverride>
  ) => void
  clearSequenceSlotOverride: (index: number) => void

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
  setSceneInfoPanelHeight: (h: number) => void
  setTrackColumnWidth: (w: number) => void
  setInspectorWidth: (w: number) => void
  setSequencePaused: (paused: boolean) => void
  // Two-stage modulator — live snapshot of the effective Modulation 1
  // for whichever cell the Inspector is currently watching. Updated
  // at ~30 Hz from main via the `engine:mod1Live` IPC channel; null
  // when the engine isn't streaming (cell deselected / Mod 2 off /
  // cell not armed). Inspector controls overlay these values on top
  // of the stored ones so the user can see Mod 2's effect animate.
  mod1Live: import('@shared/types').Mod1LiveSample | null
  setMod1Live: (sample: import('@shared/types').Mod1LiveSample | null) => void
  setMidiLearnMode: (on: boolean) => void
  setMidiLearnTarget: (
    t:
      | { kind: 'scene'; id: string }
      | { kind: 'cell'; sceneId: string; trackId: string }
      | { kind: 'metaKnob'; index: number }
      | { kind: 'instrument'; sceneId: string; templateRowId: string }
      | { kind: 'go' }
      | { kind: 'morphTime' }
      | { kind: 'generativeToggle' }
      | { kind: 'generativeNoRepeat' }
      | { kind: 'generativeAffinity' }
      | { kind: 'generativeMinDuration' }
      | { kind: 'generativeMaxDuration' }
      | { kind: 'generativeUseMorph' }
      | { kind: 'generativeRandomWeights' }
      | { kind: 'motionLoopRecord' }
      | null
  ) => void
  // (v0.6.x) Motion Loop hands-free trigger config + focused-scene toggle.
  setMotionLoopRecordMidi: (binding: MidiBinding | null) => void
  setMotionLoopOscTrigger: (patch: {
    enabled?: boolean
    address?: string
  }) => void
  toggleMotionLoopRecordFocused: () => void
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
  setGenerativePopoverOpen: (v: boolean) => void
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
  // ── Generative Scene Sequencer (v0.5.10) ──────────────────────────
  // Single-cell setters on session.generative. Each one clones the
  // existing config (or seeds from DEFAULT_GENERATIVE_CONFIG when
  // session.generative is missing — back-compat for v0.5.9 sessions
  // loaded into v0.5.10) and writes the patched field. Preset writes
  // also clear `mode` to 'custom' when the user tweaks something
  // unrelated to the current preset's defaults (handled by
  // `applyGenerativeMode`).
  setGenerativeEnabled: (v: boolean) => void
  setGenerativePoolSource: (src: GenerativePoolSource) => void
  setSceneInPool: (sceneId: string, inPool: boolean) => void
  selectAllScenesForPool: (inPool: boolean) => void
  setGenerativeMode: (mode: GenerativeMode) => void
  setGenerativeAffinity: (affinity: number) => void
  setGenerativeNoRepeat: (v: boolean) => void
  setGenerativeShuffleCycle: (v: boolean) => void
  setGenerativeMinDurationMs: (ms: number) => void
  setGenerativeMaxDurationMs: (ms: number) => void
  setGenerativeUseMorph: (v: boolean) => void
  setSceneWeight: (sceneId: string, weight: number) => void
  rollRandomWeights: () => void
  // (v0.6.x) Motion Loop — record the live hardware stream into a
  // scene's cells (free-run), then loop it on playback.
  startMotionLoopRecord: (sceneId: string) => void
  stopMotionLoopRecord: () => void
  clearMotionLoop: (sceneId: string) => void
  setRecordedLoopEnabled: (sceneId: string, enabled: boolean) => void
  // Pick an initial scene id under generative mode for the Play
  // button's empty-timeline fallback. Walks the eligible pool
  // (poolSource + excluded[]) and returns a weight-biased random
  // pick. Returns null when generative is off OR the pool is empty
  // (so the Play button can fall back to its normal "do nothing"
  // path with a console hint). The engine takes over after this
  // initial trigger via advanceScene's generative branch -- this
  // helper exists just to bootstrap the flow when the user has no
  // timeline placed and no scene focused.
  pickGenerativeStarterId: () => string | null
  // MIDI binding setters (one per learnable control). Mirror the
  // existing setGoMidi / setMorphTimeMidi pattern: pass undefined to
  // clear, otherwise persist into session.generative.
  setGenerativeToggleMidi: (b: MidiBinding | undefined) => void
  setGenerativeNoRepeatMidi: (b: MidiBinding | undefined) => void
  setGenerativeAffinityMidi: (b: MidiBinding | undefined) => void
  setGenerativeMinDurationMidi: (b: MidiBinding | undefined) => void
  setGenerativeMaxDurationMidi: (b: MidiBinding | undefined) => void
  setGenerativeUseMorphMidi: (b: MidiBinding | undefined) => void
  setRandomWeightsMidi: (b: MidiBinding | undefined) => void
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
  // Optional `prefill` lets the Destination-header picker hand over a
  // resolved {destIp, destPort, oscAddress} for an active Instrument's
  // Parameter (and optionally a specific arg-slot). When omitted, the
  // destination is seeded from session defaults — same as the old
  // "+ Destination" button did.
  addMetaDestination: (knobIdx: number, prefill?: Partial<MetaDest>) => void
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
  // v0.5.10 -- per-toolbar zoom multiplier. Same range/step as uiScale.
  // Applied on top of `uiScale` so the toolbar's effective rendering
  // is `uiScale * topBarScale`.
  setTopBarScale: (s: number) => void
  // (v0.6) Bump the scope-prefs revision so App's session-flush effect
  // picks up a scope frame change (the prefs are stored out-of-band in
  // scopePrefs.ts). Cheap; called from ScopeCanvas on any frame edit.
  bumpScopePrefsRev: () => void

  // ── Network discovery ───────────────────────────────────────────
  // Replace the device list + status snapshot from a main-process
  // push or initial fetch. The Pool's Network tab calls
  // `networkRefresh()` on mount; subsequent updates come through
  // window.api.onNetworkDevices().
  setNetworkSnapshot: (
    devices: import('@shared/types').DiscoveredOscDevice[],
    status: import('@shared/types').NetworkListenerStatus
  ) => void
  // Materialise a discovered device into a user InstrumentTemplate
  // with one Parameter per observed OSC address. Returns the new
  // template's id so the caller (drag-start handler in PoolPane) can
  // embed it in the existing POOL_TEMPLATE_DRAG_MIME payload.
  materialiseNetworkDevice: (deviceId: string) => string | null

  // ── Scene library ───────────────────────────────────────────────
  // Mirror of the main-process cache. App.tsx subscribes to
  // `onSceneLibrary` and pipes pushes through this setter.
  setSceneLibrary: (scenes: import('@shared/types').SavedScene[]) => void
  // ── Pool library (User Instruments + Parameters) ──────────────
  // Merges entries from the on-disk Pool library into the current
  // session's pool. Called once on app start (and any time the
  // main-process pushes a `pool-library:changed` event). Only
  // User entries (non-builtin) are merged. Entries already in
  // the session's pool by id are skipped — the session's edits
  // win over the library's stale copy. New library entries get
  // added at the end of the User section.
  mergePoolLibrary: (payload: {
    templates: import('@shared/types').InstrumentTemplate[]
    parameters: import('@shared/types').ParameterTemplate[]
  }) => void
  // Capture-popup visibility — Pool's Capture button flips it true,
  // popup's Save/Cancel flips back.
  setCaptureOpen: (open: boolean) => void
  setNewSessionConfirmOpen: (open: boolean) => void
  // Snapshot a scene from `session.scenes` into the saved-scene
  // library. Includes the relevant Pool templates + sidebar tracks
  // + cell map so the saved entry is self-contained across
  // sessions. Returns the new SavedScene id.
  saveSceneToLibrary: (sceneId: string, name: string) => Promise<string | null>
  // Patch the metadata on a SavedScene (name / color / notes /
  // duration / nextMode / multiplicator / morphInMs). Library is
  // replaced by-id on disk; the renderer's local mirror updates
  // both immediately + again via the push-on-change channel.
  // Rebuild a SavedScene's full payload (tracks + templates + cells)
  // from a linked LIVE scene in the grid. Used by the Pool's
  // Scenes-tab right-click menu's "Update and save" action so the
  // user can iterate on a scene in the grid and push the latest
  // version back over the existing SavedScene WITHOUT creating a
  // duplicate library entry. Re-uses the SavedScene's existing id;
  // the linkedSavedSceneId on the grid scene picks the candidate.
  updateSavedSceneFromGrid: (savedSceneId: string) => Promise<boolean>
  updateSavedScene: (
    id: string,
    patch: Partial<import('@shared/types').SavedScene['sceneMeta']> & {
      name?: string
      color?: string
    }
  ) => Promise<void>
  // Remove a saved scene by id. Just forwards to the IPC bridge.
  removeSavedScene: (id: string) => Promise<void>
  // Drop a saved scene into the current session — instantiates any
  // missing Pool templates + missing sidebar tracks, then creates a
  // new Scene with cells linked to the new tracks. Returns the new
  // scene id so the caller can focus it.
  // `insertAtIndex` — when provided, splice the new Scene into
  // `session.scenes` at that position instead of appending at the
  // end. Used by the Edit-view grid drop handler so the user can
  // drop a saved Scene between two existing columns and have it
  // land there visually. Indices are clamped to [0, scenes.length];
  // omit (or pass `undefined`) to keep the legacy "append" behaviour.
  instantiateSavedScene: (
    savedSceneId: string,
    insertAtIndex?: number
  ) => string | null
  // Duplicate an in-session Scene. Clones every cell on the same
  // tracks (same trackIds, no new sidebar rows), names the copy
  // "<orig> (copy)". Returns the new scene id.
  duplicateScene: (sceneId: string) => string | null
  // (v0.5.12) Capture the engine's live emitted values (including
  // Hardware Mode catches) as a new scene cloned from sceneId. Returns
  // the new scene id, or null if sceneId doesn't exist. When sceneId
  // is not the currently-active scene, falls back to behaving like
  // duplicateScene (no live data to capture from).
  captureSceneStateAsNew: (sceneId: string) => string | null

  // (v0.5.14) Update sceneId IN PLACE with the engine's live emitted
  // values (including Hardware Mode overrides) — the in-place sibling
  // of captureSceneStateAsNew. Returns true when at least one cell
  // value actually changed. No fallback when the scene isn't active:
  // there are no live values to commit, so it's a no-op (the menu item
  // is disabled in that case).
  updateSceneToCurrent: (sceneId: string) => boolean

  // Engine state mirror
  setEngineState: (s: EngineState) => void
}

type State = { session: Session } & UiState & Actions

// Generative mode preset detector. The setGenerativeMode action
// WRITES the underlying knobs (affinity, noRepeat, shuffleCycle) to
// known values when the user picks Random / Drift / Surprise /
// Shuffle. The individual knob setters call this to detect whether
// the user's tweak keeps the existing preset's knob set intact (mode
// label sticks) or drifts away from it (mode label flips to
// 'custom'). Returns true if the candidate field=value combination
// is consistent with the current mode's defaults.
function matchesPresetMode(
  cur: GenerativeConfig,
  field: 'affinity' | 'noRepeat' | 'shuffleCycle',
  value: number | boolean
): boolean {
  if (cur.mode === 'custom') return false
  const presets: Record<
    Exclude<GenerativeMode, 'custom'>,
    { affinity: number; noRepeat: boolean; shuffleCycle: boolean }
  > = {
    random: { affinity: 0, noRepeat: true, shuffleCycle: false },
    drift: { affinity: 80, noRepeat: true, shuffleCycle: false },
    surprise: { affinity: -80, noRepeat: true, shuffleCycle: false },
    shuffle: { affinity: 0, noRepeat: true, shuffleCycle: true }
  }
  const expected = presets[cur.mode]
  // Build a hypothetical config with this field swapped in; compare.
  const hyp = { ...cur, [field]: value }
  return (
    hyp.affinity === expected.affinity &&
    hyp.noRepeat === expected.noRepeat &&
    hyp.shuffleCycle === expected.shuffleCycle
  )
}

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
  clipboard: null,
  // Scene notes height in the editor. 0 = hidden (default). The Notes
  // toggle in the TrackSidebar "buttons box" flips this between 0 and
  // NOTES_ONE_LINE_HEIGHT so the user sees exactly one line of text when
  // they turn notes on. They can drag the in-editor handle to grow it further.
  editorNotesHeight: 0,
  // Defaults to the smallest non-collapsed size (matches the
  // ResizeHandle's `min` of 60 px). User can drag taller; the
  // collapsed view uses a separate 32 px constant. Keeps a fresh
  // session compact so more rows fit on screen by default.
  // Default row height — sized to give a 12-float OCTOCOSME-style
  // multi-arg cell (3 rows × 4 columns of small floats) enough
  // vertical room to render its full value grid without cropping
  // the last row. Single-arg / vec3 cells happily live at this
  // height too. Users can drag the row-height slider in the sidebar
  // to shrink for single-arg-only sessions or grow further for
  // very deep bundles.
  rowHeight: 95,
  sceneColumnWidth: 200,
  // 360 px default — wide enough for DUR + NEXT + × multiplicator inputs
  // to all fit on one row in the Sequence-tab scene inspector. Users can
  // drag the right edge to grow / shrink (clamped 200..480).
  scenePaletteWidth: 360,
  sceneInfoPanelHeight: 360,
  trackColumnWidth: 240,
  inspectorWidth: 340,
  sequencePaused: false,
  // Live Mod 1 preview — populated by App.tsx's onMod1Live subscriber,
  // consumed by the Inspector's modulator sub-editors. Null at boot
  // and whenever the engine isn't streaming.
  mod1Live: null,
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
  generativePopoverOpen: false,
  recordingLoopSceneId: null,
  recordingLoopStartedAt: null,
  mappingsOpen: false,
  setMappingsOpen: (v) => set({ mappingsOpen: v }),
  signalsOpen: false,
  setSignalsOpen: (v) => set({ signalsOpen: v }),
  poseRecordBusy: false,
  setPoseRecordBusy: (v) => set({ poseRecordBusy: v }),
  oscMonitorHeight: 220,
  poolHidden: false,
  editInspectorVisible: true,
  sceneInspectorVisible: true,
  timelineMode: false,
  selectedSequenceSlot: null,
  selectedSequenceSlots: [],
  focusDurationToken: 0,
  poolSelection: null,
  selectedSavedSceneIds: [],
  undoCount: 0,
  redoCount: 0,
  pendingIntegrityLoad: null,
  armedSceneId: null,
  autoAdvanceArm: false,
  morphEnabled: false,
  morphMs: 2000,
  transportStartedAt: null,
  transportAccumulatedMs: 0,
  // Network discovery state — empty until the user enables the
  // listener from the Pool drawer's Network tab. Status defaults to
  // disabled on port 9000; the renderer fetches the real snapshot on
  // mount via window.api.networkList().
  networkDevices: [],
  networkStatus: {
    enabled: false,
    port: 9000,
    localAddresses: [],
    lastError: ''
  },
  // Saved-scene library mirror — populated on app start via
  // `window.api.sceneLibraryList()` and refreshed on every push.
  sceneLibrary: [],
  captureOpen: false,
  newSessionConfirmOpen: false,
  // Ephemeral per-knob display values, interpolated by metaSmooth.ts. Not
  // persisted — on session load we reset these to each knob's `value`
  // (see setSession below).
  metaKnobDisplayValues: Array.from({ length: META_KNOB_COUNT }, () => 0),
  uiScale: loadUiScale(),
  topBarScale: loadTopBarScale(),
  scopePrefsRev: 0,
  clipTemplates: loadTemplates(),

  setSession: (s) => {
    const propagated = applyV0512Migrations(
      backfillTrackArgSpecsFromPool(propagateDefaults(s))
    )
    // Apply session-level OSC listener port (v0.5.10). When the
    // session carries a listenerPort, push it to the main-process
    // listener immediately so reopening a saved session re-binds
    // to its previously-used port. Sessions saved before v0.5.10
    // have no listenerPort field and the localStorage fallback in
    // PoolPane keeps working unchanged.
    if (typeof propagated.listenerPort === 'number') {
      // Flat naming -- the preload exposes `networkSetEnabled`, not
      // a nested `network.setEnabled` object. Always pass true so
      // the listener auto-rebinds on session load even if it was
      // off; users can turn it off again via the Network tab.
      void window.api?.networkSetEnabled?.(true, propagated.listenerPort)
    }
    // Merge any User entries from the global pool library that the
    // loaded session doesn't already include — same rule as
    // newSession (library entries follow the user across sessions).
    // Loaded sessions usually carry their own pool already; this
    // only adds library entries the user has authored elsewhere.
    const existingTplIds = new Set(propagated.pool.templates.map((t) => t.id))
    const existingParIds = new Set(propagated.pool.parameters.map((p) => p.id))
    const mergedTpls = [
      ...propagated.pool.templates,
      ...poolLibraryCache.templates.filter(
        (t) => !existingTplIds.has(t.id) && !t.builtin
      )
    ]
    const mergedPars = [
      ...propagated.pool.parameters,
      ...poolLibraryCache.parameters.filter(
        (p) => !existingParIds.has(p.id) && !p.builtin
      )
    ]
    const next = {
      ...propagated,
      pool: {
        ...propagated.pool,
        templates: mergedTpls,
        parameters: mergedPars
      }
    }
    // Reset display values to each knob's persisted value so the UI opens
    // at the right position after loading a session.
    const display = next.metaController.knobs.map((k) => k.value)
    // Reset EVERY piece of ephemeral UI state so stale IDs from the
    // previous session (selection, armed cue, multi-selection arrays,
    // transport counter) can't point at objects that no longer exist —
    // those dangling refs were causing Inspector / GO / morph features
    // to act on a mix of old and new data after an Open / restore.
    // Apply persisted GUI layout from session.ui — clamped against
    // the same bounds the live UI sliders use, so a hand-edited
    // session file can't push the renderer into a broken state. Any
    // missing sub-field falls back to whatever's currently in the
    // store (i.e. the default or the previous session's value).
    const ui = next.ui ?? {}
    const cur = get()
    // (v0.6) Restore the per-scope frames into the module-scope Map so
    // reopening a Parameter's scope shows the saved time/value/height,
    // then drop any orphan frames (template/Parameter since deleted) so
    // they don't accumulate in the file across edits.
    loadScopePrefs(ui.scopePrefs)
    {
      const validPrefixes = new Set<string>()
      for (const t of next.tracks) {
        if (t.kind === 'function' && t.sourceTemplateId && t.defaultOscAddress) {
          validPrefixes.add(`${t.sourceTemplateId}|${t.defaultOscAddress}`)
        }
      }
      pruneScopePrefs(validPrefixes)
    }
    const uiPatch: Partial<UiState> = {}
    if (typeof ui.uiScale === 'number' && Number.isFinite(ui.uiScale)) {
      uiPatch.uiScale = Math.max(UI_SCALE_MIN, Math.min(UI_SCALE_MAX, ui.uiScale))
      // Mirror to localStorage so the runtime zoom hook stays in
      // sync with whatever the session restored.
      saveUiScale(uiPatch.uiScale)
    }
    // v0.5.10 -- topBarScale (toolbar-only zoom multiplier).
    // Optional; missing -> defaults to whatever's already in state.
    if (typeof ui.topBarScale === 'number' && Number.isFinite(ui.topBarScale)) {
      uiPatch.topBarScale = Math.max(
        TOPBAR_SCALE_MIN,
        Math.min(TOPBAR_SCALE_MAX, ui.topBarScale)
      )
      saveTopBarScale(uiPatch.topBarScale)
    }
    if (typeof ui.rowHeight === 'number' && Number.isFinite(ui.rowHeight)) {
      uiPatch.rowHeight = clampInt(ui.rowHeight, 45, 220)
    }
    if (
      typeof ui.sceneColumnWidth === 'number' &&
      Number.isFinite(ui.sceneColumnWidth)
    ) {
      uiPatch.sceneColumnWidth = clampInt(ui.sceneColumnWidth, 140, 480)
    }
    if (
      typeof ui.inspectorWidth === 'number' &&
      Number.isFinite(ui.inspectorWidth)
    ) {
      uiPatch.inspectorWidth = clampInt(ui.inspectorWidth, 280, 640)
    }
    if (
      typeof ui.trackColumnWidth === 'number' &&
      Number.isFinite(ui.trackColumnWidth)
    ) {
      uiPatch.trackColumnWidth = clampInt(ui.trackColumnWidth, 160, 400)
    }
    if (
      typeof ui.editorNotesHeight === 'number' &&
      Number.isFinite(ui.editorNotesHeight)
    ) {
      uiPatch.editorNotesHeight = clampInt(ui.editorNotesHeight, 0, 220)
    }
    if (
      typeof ui.oscMonitorHeight === 'number' &&
      Number.isFinite(ui.oscMonitorHeight)
    ) {
      uiPatch.oscMonitorHeight = clampInt(ui.oscMonitorHeight, 120, 800)
    }
    // (#18) Restore the Sequence-view pane dimensions, clamped to the
    // same bounds their live setters use.
    if (
      typeof ui.scenePaletteWidth === 'number' &&
      Number.isFinite(ui.scenePaletteWidth)
    ) {
      uiPatch.scenePaletteWidth = clampInt(ui.scenePaletteWidth, 200, 1200)
    }
    if (
      typeof ui.sceneInfoPanelHeight === 'number' &&
      Number.isFinite(ui.sceneInfoPanelHeight)
    ) {
      uiPatch.sceneInfoPanelHeight = clampInt(ui.sceneInfoPanelHeight, 80, 1600)
    }
    if (typeof ui.tracksCollapsed === 'boolean') {
      uiPatch.tracksCollapsed = ui.tracksCollapsed
    }
    if (typeof ui.scenesCollapsed === 'boolean') {
      uiPatch.scenesCollapsed = ui.scenesCollapsed
    }
    void cur // keep ref-stable for the inner closure below
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
      midiLearnTarget: null,
      ...uiPatch
    })
    // Loading a new session resets the undo timeline — the user
    // shouldn't be able to "undo" their way back into the previous
    // file's state by accident. Called AFTER the set so the
    // subscriber's eager pre-snapshot capture (above) is wiped.
    resetUndoHistory()
    // Defensive: re-pull the saved-scene library from main. The
    // initial fetch on app mount can race with the Pool drawer's
    // first paint; re-syncing whenever the user loads a session
    // guarantees the Scenes tab shows the full library after Open.
    void window.api?.sceneLibraryList?.().then((scenes) => {
      if (Array.isArray(scenes)) set({ sceneLibrary: scenes })
    })
  },
  newSession: () => {
    // Seed the fresh session's pool with the user's library of
    // authored Instruments + Parameters BEFORE we set state. Adding
    // them after the set would trigger App.tsx's auto-push effect
    // mid-way through (templates: [] → push empty → main writes
    // empty library) and wipe the library on every New.
    const empty = makeEmptySession()
    const existingTplIds = new Set(empty.pool.templates.map((t) => t.id))
    const existingParIds = new Set(empty.pool.parameters.map((p) => p.id))
    const mergedTpls = [
      ...empty.pool.templates,
      ...poolLibraryCache.templates.filter(
        (t) => !existingTplIds.has(t.id) && !t.builtin
      )
    ]
    const mergedPars = [
      ...empty.pool.parameters,
      ...poolLibraryCache.parameters.filter(
        (p) => !existingParIds.has(p.id) && !p.builtin
      )
    ]
    const seeded = {
      ...empty,
      pool: { ...empty.pool, templates: mergedTpls, parameters: mergedPars }
    }
    set({
      session: seeded,
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
    })
    resetUndoHistory()
    // Defensive sceneLibrary refresh — same rationale as setSession.
    void window.api?.sceneLibraryList?.().then((scenes) => {
      if (Array.isArray(scenes)) set({ sceneLibrary: scenes })
    })
  },
  setCurrentFilePath: (p) => set({ currentFilePath: p }),
  setName: (name) => set((st) => ({ session: { ...st.session, name } })),
  setTickRate: (hz) => set((st) => ({ session: { ...st.session, tickRateHz: clampInt(hz, 10, 300) } })),
  setMidiEnabled: (enabled) =>
    // Persists in the session — main process reads `session.midiEnabled`
    // on every `engine:updateSession` IPC and propagates the flag to the
    // MIDI sender (which closes all ports when flipped off).
    set((st) => ({ session: { ...st.session, midiEnabled: !!enabled } })),
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
  // ─── OSC forward target CRUD ─────────────────────────────────────
  // Every mutator pushes the resulting list to the main process via
  // `network:setForwardTargets` so the listener's hot path stays in
  // sync without any subscription dance. We send the FULL list (not a
  // delta) on every change — the list is bounded to ~10 entries in
  // practice and main re-applies it synchronously.
  addForwardTarget: (init) => {
    const id = `fwd_${Math.random().toString(36).slice(2, 10)}`
    set((st) => {
      const next: OscForwardTarget[] = [
        ...(st.session.forwardTargets ?? []),
        {
          id,
          enabled: init?.enabled ?? true,
          label: init?.label,
          // Default to loopback + a sensible OSC port so a freshly-
          // added row is "almost configured" — the user typically
          // just types the port their downstream consumer listens on.
          ip: init?.ip ?? '127.0.0.1',
          port: init?.port ?? 9001
        }
      ]
      window.api?.networkSetForwardTargets?.(next)
      return { session: { ...st.session, forwardTargets: next } }
    })
    return id
  },
  updateForwardTarget: (id, fields) =>
    set((st) => {
      const list = st.session.forwardTargets ?? []
      const next = list.map((t) => (t.id === id ? { ...t, ...fields } : t))
      window.api?.networkSetForwardTargets?.(next)
      return { session: { ...st.session, forwardTargets: next } }
    }),
  removeForwardTarget: (id) =>
    set((st) => {
      const next = (st.session.forwardTargets ?? []).filter((t) => t.id !== id)
      window.api?.networkSetForwardTargets?.(next)
      return { session: { ...st.session, forwardTargets: next } }
    }),
  setMidiInputName: (name) => set((st) => ({ session: { ...st.session, midiInputName: name } })),
  setFocusedScene: (id) =>
    set((st) => ({
      session: { ...st.session, focusedSceneId: id },
      selectedSceneIds: id ? [id] : [],
      // Explicit scene selection clears every other Pool / Edit
      // selection so the Del-key handler sees an unambiguous target.
      // Cell-tile clicks `e.stopPropagation` to avoid triggering
      // this path via bubble (which used to wipe the cell selection
      // the click had just made); the only entry points that now
      // call setFocusedScene are real scene-header clicks + a few
      // programmatic flows (instantiateSavedScene, focus after
      // duplicate, etc.).
      poolSelection: id ? null : st.poolSelection,
      selectedTrack: id ? null : st.selectedTrack,
      selectedTrackIds: id ? [] : st.selectedTrackIds,
      selectedCell: id ? null : st.selectedCell,
      selectedCells: id ? [] : st.selectedCells,
      selectedSavedSceneIds: id ? [] : st.selectedSavedSceneIds
    })),
  selectSceneRange: (id) =>
    set((st) => {
      const order = st.session.scenes.map((s) => s.id)
      const clickedIdx = order.indexOf(id)
      if (clickedIdx < 0) return st
      const anchor = st.session.focusedSceneId
      const anchorIdx = anchor ? order.indexOf(anchor) : -1
      // Range-select only clears POOL-side selections (templates /
      // parameters / saved scenes) — grid cell + track selections
      // can coexist with a focused scene. See `setFocusedScene` for
      // the explanation.
      const clearOthers = {
        poolSelection: null,
        selectedSavedSceneIds: []
      }
      // No anchor yet → behave like plain focus.
      if (anchorIdx < 0) {
        return {
          session: { ...st.session, focusedSceneId: id },
          selectedSceneIds: [id],
          ...clearOthers
        }
      }
      const from = Math.min(anchorIdx, clickedIdx)
      const to = Math.max(anchorIdx, clickedIdx)
      return {
        // Keep the anchor where it is so further Ctrl-clicks re-extend from it.
        session: { ...st.session, focusedSceneId: anchor },
        selectedSceneIds: order.slice(from, to + 1),
        ...clearOthers
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
  // Hardware Mode setter — unlike updateTemplate, this DOES work on
  // builtin templates because HW Mode is a per-session user preference
  // (which device a controller is bound to, which arg slots it can
  // drive), not a definitional change. The builtin template's
  // identity / functions / OSC addresses remain untouched; only the
  // hardwareMode field is patched. Persisted with the session.
  setTemplateHardwareMode: (id, patch) =>
    set((st) => {
      const t = st.session.pool.templates.find((tt) => tt.id === id)
      if (!t) return st
      const cur = t.hardwareMode
      const merged: NonNullable<InstrumentTemplate['hardwareMode']> = {
        enabled: false,
        deviceIp: '',
        devicePort: 0,
        mode: 'reset',
        catchTolerance: 0.02,
        movementThreshold: 0.005,
        movementWindowMs: 300,
        ...cur,
        ...patch
      }
      return {
        session: {
          ...st.session,
          pool: {
            ...st.session.pool,
            templates: st.session.pool.templates.map((tt) =>
              tt.id === id ? { ...tt, hardwareMode: merged } : tt
            )
          }
        }
      }
    }),
  setTemplateInputConditioner: (id, patch) =>
    set((st) => {
      const t = st.session.pool.templates.find((tt) => tt.id === id)
      if (!t) return st
      const merged: InputConditionerConfig = {
        enabled: false,
        stages: [],
        slotBypass: [],
        ...t.inputConditioner,
        ...patch
      }
      return {
        session: {
          ...st.session,
          pool: {
            ...st.session.pool,
            templates: st.session.pool.templates.map((tt) =>
              tt.id === id ? { ...tt, inputConditioner: merged } : tt
            )
          }
        }
      }
    }),
  setTemplateDerivedParams: (id, derivedParams) =>
    set((st) => ({
      session: {
        ...st.session,
        pool: {
          ...st.session.pool,
          templates: st.session.pool.templates.map((tt) =>
            tt.id === id ? { ...tt, derivedParams } : tt
          )
        }
      }
    })),
  addStateTrigger: (templateId) => {
    const t = get().session.pool.templates.find((tt) => tt.id === templateId)
    if (!t) return null
    const trigger = makeStateTrigger(t.stateTriggers?.length ?? 0)
    set((st) => ({
      session: {
        ...st.session,
        pool: {
          ...st.session.pool,
          templates: st.session.pool.templates.map((tt) =>
            tt.id === templateId
              ? { ...tt, stateTriggers: [...(tt.stateTriggers ?? []), trigger] }
              : tt
          )
        }
      }
    }))
    return trigger.id
  },
  updateStateTrigger: (templateId, stateId, patch) =>
    set((st) => ({
      session: {
        ...st.session,
        pool: {
          ...st.session.pool,
          templates: st.session.pool.templates.map((tt) =>
            tt.id === templateId
              ? {
                  ...tt,
                  stateTriggers: (tt.stateTriggers ?? []).map((s) =>
                    s.id === stateId ? { ...s, ...patch } : s
                  )
                }
              : tt
          )
        }
      }
    })),
  removeStateTrigger: (templateId, stateId) =>
    set((st) => ({
      session: {
        ...st.session,
        pool: {
          ...st.session.pool,
          templates: st.session.pool.templates.map((tt) =>
            tt.id === templateId
              ? {
                  ...tt,
                  stateTriggers: (tt.stateTriggers ?? []).filter(
                    (s) => s.id !== stateId
                  )
                }
              : tt
          )
        }
      }
    })),
  // ---- Pose Sequences (v0.6.5). Copy-on-write like State Triggers; works on
  // builtins too — the graft in sanitizePool keeps them across reloads.
  addPoseSequence: (templateId) => {
    const t = get().session.pool.templates.find((tt) => tt.id === templateId)
    if (!t) return null
    const seq = makePoseSequence(t.poseSequences?.length ?? 0)
    set((st) => ({
      session: {
        ...st.session,
        pool: {
          ...st.session.pool,
          templates: st.session.pool.templates.map((tt) =>
            tt.id === templateId
              ? { ...tt, poseSequences: [...(tt.poseSequences ?? []), seq] }
              : tt
          )
        }
      }
    }))
    return seq.id
  },
  updatePoseSequence: (templateId, seqId, patch) =>
    set((st) => ({
      session: {
        ...st.session,
        pool: {
          ...st.session.pool,
          templates: st.session.pool.templates.map((tt) =>
            tt.id === templateId
              ? {
                  ...tt,
                  poseSequences: (tt.poseSequences ?? []).map((s) =>
                    s.id === seqId ? { ...s, ...patch } : s
                  )
                }
              : tt
          )
        }
      }
    })),
  removePoseSequence: (templateId, seqId) =>
    set((st) => ({
      session: {
        ...st.session,
        pool: {
          ...st.session.pool,
          templates: st.session.pool.templates.map((tt) =>
            tt.id === templateId
              ? {
                  ...tt,
                  poseSequences: (tt.poseSequences ?? []).filter(
                    (s) => s.id !== seqId
                  )
                }
              : tt
          )
        }
      }
    })),
  addWaypoint: (templateId, seqId) => {
    const t = get().session.pool.templates.find((tt) => tt.id === templateId)
    const seq = t?.poseSequences?.find((s) => s.id === seqId)
    if (!t || !seq) return null
    const wp = makePoseWaypoint(seq.waypoints.length)
    set((st) => ({
      session: {
        ...st.session,
        pool: {
          ...st.session.pool,
          templates: st.session.pool.templates.map((tt) =>
            tt.id === templateId
              ? {
                  ...tt,
                  poseSequences: (tt.poseSequences ?? []).map((s) =>
                    s.id === seqId
                      ? { ...s, waypoints: [...s.waypoints, wp] }
                      : s
                  )
                }
              : tt
          )
        }
      }
    }))
    return wp.id
  },
  updateWaypoint: (templateId, seqId, waypointId, patch) =>
    set((st) => ({
      session: {
        ...st.session,
        pool: {
          ...st.session.pool,
          templates: st.session.pool.templates.map((tt) =>
            tt.id === templateId
              ? {
                  ...tt,
                  poseSequences: (tt.poseSequences ?? []).map((s) =>
                    s.id === seqId
                      ? {
                          ...s,
                          waypoints: s.waypoints.map((w) =>
                            w.id === waypointId ? { ...w, ...patch } : w
                          )
                        }
                      : s
                  )
                }
              : tt
          )
        }
      }
    })),
  removeWaypoint: (templateId, seqId, waypointId) =>
    set((st) => ({
      session: {
        ...st.session,
        pool: {
          ...st.session.pool,
          templates: st.session.pool.templates.map((tt) =>
            tt.id === templateId
              ? {
                  ...tt,
                  poseSequences: (tt.poseSequences ?? []).map((s) =>
                    s.id === seqId
                      ? {
                          ...s,
                          waypoints: s.waypoints.filter(
                            (w) => w.id !== waypointId
                          )
                        }
                      : s
                  )
                }
              : tt
          )
        }
      }
    })),
  moveWaypoint: (templateId, seqId, waypointId, dir) =>
    set((st) => ({
      session: {
        ...st.session,
        pool: {
          ...st.session.pool,
          templates: st.session.pool.templates.map((tt) => {
            if (tt.id !== templateId) return tt
            return {
              ...tt,
              poseSequences: (tt.poseSequences ?? []).map((s) => {
                if (s.id !== seqId) return s
                const idx = s.waypoints.findIndex((w) => w.id === waypointId)
                const swap = idx + dir
                if (idx < 0 || swap < 0 || swap >= s.waypoints.length) return s
                const wps = s.waypoints.slice()
                ;[wps[idx], wps[swap]] = [wps[swap], wps[idx]]
                return { ...s, waypoints: wps }
              })
            }
          })
        }
      }
    })),
  duplicateTemplate: (id) => {
    const src = get().session.pool.templates.find((t) => t.id === id)
    if (!src) return null
    const newId = `tpl_user_${Math.random().toString(36).slice(2, 9)}`
    const existingNames = get().session.pool.templates.map((t) => t.name)
    const cloned: InstrumentTemplate = {
      ...src,
      id: newId,
      name: uniqueCopyName(src.name, existingNames),
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
            selectedTrackIds: [],
            // Picking a non-SavedScene Pool entry wipes the multi-
            // scene selection so a stale Del-press doesn't act on
            // scenes the user can no longer see highlighted.
            selectedSavedSceneIds:
              sel.kind === 'savedScene'
                ? st.selectedSavedSceneIds
                : []
          }
        : { poolSelection: null, selectedSavedSceneIds: [] }
    ),
  selectSavedScene: (savedSceneId) =>
    set({
      poolSelection: { kind: 'savedScene', savedSceneId },
      selectedSavedSceneIds: [savedSceneId],
      selectedCell: null,
      selectedCells: [],
      selectedTrack: null,
      selectedTrackIds: []
    }),
  toggleSavedSceneSelection: (savedSceneId) =>
    set((st) => {
      const has = st.selectedSavedSceneIds.includes(savedSceneId)
      const nextIds = has
        ? st.selectedSavedSceneIds.filter((id) => id !== savedSceneId)
        : [...st.selectedSavedSceneIds, savedSceneId]
      // Anchor follows the last interaction. If the user is REMOVING
      // the currently anchored scene, fall back to the previous
      // anchor (last element of the new list) or null if empty.
      let nextPool: UiState['poolSelection']
      if (nextIds.length === 0) {
        nextPool = null
      } else if (has) {
        // We just removed `savedSceneId`. If it was the anchor,
        // move to the new last element. If it wasn't, keep the
        // existing anchor (it's still in the set).
        const wasAnchor =
          st.poolSelection?.kind === 'savedScene' &&
          st.poolSelection.savedSceneId === savedSceneId
        nextPool = wasAnchor
          ? { kind: 'savedScene', savedSceneId: nextIds[nextIds.length - 1] }
          : st.poolSelection
      } else {
        // Add path — the new scene becomes the anchor.
        nextPool = { kind: 'savedScene', savedSceneId }
      }
      return {
        poolSelection: nextPool,
        selectedSavedSceneIds: nextIds,
        selectedCell: null,
        selectedCells: [],
        selectedTrack: null,
        selectedTrackIds: []
      }
    }),
  clearSavedSceneSelection: () =>
    set((st) => ({
      selectedSavedSceneIds: [],
      poolSelection:
        st.poolSelection?.kind === 'savedScene' ? null : st.poolSelection
    })),

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
    const existingNames = get().session.pool.parameters.map((p) => p.name)
    const cloned: ParameterTemplate = {
      ...src,
      id: newId,
      name: uniqueCopyName(src.name, existingNames),
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
        defaultDestPort: p.destPort,
        // Snapshot the blueprint's argSpec onto the row.
        argSpec: p.argSpec ? p.argSpec.map((a) => ({ ...a })) : undefined
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
  duplicateFunctionTrack: (id) => {
    const st0 = get()
    const src = st0.session.tracks.find((t) => t.id === id)
    if (!src || src.kind !== 'function') return null
    if (st0.session.tracks.length >= 128) return null
    const newId = `t_${Math.random().toString(36).slice(2, 9)}`
    const existingNames = st0.session.tracks.map((t) => t.name)
    const cloned: Track = {
      ...src,
      id: newId,
      name: uniqueCopyName(src.name, existingNames)
    }
    const idx = st0.session.tracks.findIndex((t) => t.id === id)
    const newTracks = [...st0.session.tracks]
    newTracks.splice(idx + 1, 0, cloned)
    // Clone the source's cell from every scene onto the new track id so
    // the duplicate row plays the same values as the source instead of
    // being empty across the grid. Cells stored per-track on the scene.
    const newScenes = st0.session.scenes.map((sc) => {
      const srcCell = sc.cells[id]
      if (!srcCell) return sc
      return { ...sc, cells: { ...sc.cells, [newId]: { ...srcCell } } }
    })
    set((st) => ({
      session: {
        ...st.session,
        tracks: newTracks,
        scenes: newScenes
      }
    }))
    return newId
  },
  duplicateInstrumentTrack: (id) => {
    const st0 = get()
    const src = st0.session.tracks.find((t) => t.id === id)
    if (!src || src.kind !== 'template') return null
    if (st0.session.tracks.length >= 128) return null
    // Collect the contiguous block: Template row + its children.
    const idx = st0.session.tracks.findIndex((t) => t.id === id)
    const children = st0.session.tracks.filter((t) => t.parentTrackId === id)
    if (st0.session.tracks.length + 1 + children.length > 128) return null
    const newTplId = `t_${Math.random().toString(36).slice(2, 9)}`
    const existingNames = st0.session.tracks.map((t) => t.name)
    const newTpl: Track = {
      ...src,
      id: newTplId,
      name: uniqueCopyName(src.name, existingNames)
    }
    // Map oldChildId → newChildId so cells can be remapped scene-by-scene.
    const childIdMap = new Map<string, string>()
    const newChildren: Track[] = children.map((child) => {
      const newChildId = `t_${Math.random().toString(36).slice(2, 9)}`
      childIdMap.set(child.id, newChildId)
      return {
        ...child,
        id: newChildId,
        parentTrackId: newTplId
      }
    })
    // Insert the new block immediately after the source block (so the
    // sidebar reads source → duplicate left-to-right top-to-bottom).
    const srcBlockEnd = idx + 1 + children.length // exclusive
    const newTracks = [
      ...st0.session.tracks.slice(0, srcBlockEnd),
      newTpl,
      ...newChildren,
      ...st0.session.tracks.slice(srcBlockEnd)
    ]
    // Clone every cell on every scene from the source's children onto
    // the new children's ids. Template-row cells aren't a thing
    // (templates only carry group triggers), so just children.
    const newScenes = st0.session.scenes.map((sc) => {
      const nextCells = { ...sc.cells }
      childIdMap.forEach((newCId, oldCId) => {
        const cell = sc.cells[oldCId]
        if (cell) nextCells[newCId] = { ...cell }
      })
      return { ...sc, cells: nextCells }
    })
    set((st) => ({
      session: {
        ...st.session,
        tracks: newTracks,
        scenes: newScenes
      }
    }))
    return newTplId
  },
  copyToClipboard: () => {
    const st = get()
    // Cell takes priority — if the user has a cell selected, that's
    // almost always what they want to copy. Falls through to track-
    // level copy only when no cell is currently selected.
    if (st.selectedCell) {
      const { sceneId, trackId } = st.selectedCell
      const scene = st.session.scenes.find((s) => s.id === sceneId)
      const cell = scene?.cells[trackId]
      if (cell) {
        set({ clipboard: { kind: 'cell', cell: structuredClone(cell) } })
        return
      }
    }
    if (st.selectedTrack) {
      const src = st.session.tracks.find((t) => t.id === st.selectedTrack)
      if (!src) return
      if (src.kind === 'function') {
        const cellsByScene: Record<string, Cell> = {}
        for (const sc of st.session.scenes) {
          const c = sc.cells[src.id]
          if (c) cellsByScene[sc.id] = structuredClone(c)
        }
        set({
          clipboard: {
            kind: 'function-track',
            track: structuredClone(src),
            cellsByScene
          }
        })
      } else {
        const children = st.session.tracks.filter((t) => t.parentTrackId === src.id)
        const cellsByScene: Record<string, Record<string, Cell>> = {}
        for (const sc of st.session.scenes) {
          const row: Record<string, Cell> = {}
          for (const ch of children) {
            const c = sc.cells[ch.id]
            if (c) row[ch.id] = structuredClone(c)
          }
          if (Object.keys(row).length > 0) cellsByScene[sc.id] = row
        }
        set({
          clipboard: {
            kind: 'instrument-track',
            track: structuredClone(src),
            children: children.map((c) => structuredClone(c)),
            cellsByScene
          }
        })
      }
    }
  },
  pasteFromClipboard: () => {
    const st = get()
    const clip = st.clipboard
    if (!clip) return
    // Cell paste — drop the clipped cell into the currently focused
    // (sceneId, trackId). Overwrites any existing cell on that
    // position. User can undo if it wasn't what they wanted.
    if (clip.kind === 'cell') {
      if (!st.selectedCell) return
      const { sceneId, trackId } = st.selectedCell
      set((s) => ({
        session: {
          ...s.session,
          scenes: s.session.scenes.map((sc) =>
            sc.id === sceneId
              ? { ...sc, cells: { ...sc.cells, [trackId]: structuredClone(clip.cell) } }
              : sc
          )
        }
      }))
      return
    }
    // Track pastes use the Duplicate code paths conceptually — clone
    // the clipboard payload, generate fresh ids, insert right after
    // the currently-selected track (or at the end if no selection).
    if (st.session.tracks.length >= 128) return
    const targetIdx = st.selectedTrack
      ? st.session.tracks.findIndex((t) => t.id === st.selectedTrack)
      : st.session.tracks.length - 1
    const insertAfter = targetIdx < 0 ? st.session.tracks.length - 1 : targetIdx
    if (clip.kind === 'function-track') {
      const newId = `t_${Math.random().toString(36).slice(2, 9)}`
      const existingNames = st.session.tracks.map((t) => t.name)
      const cloned: Track = {
        ...structuredClone(clip.track),
        id: newId,
        name: uniqueCopyName(clip.track.name, existingNames)
      }
      const newTracks = [...st.session.tracks]
      newTracks.splice(insertAfter + 1, 0, cloned)
      const newScenes = st.session.scenes.map((sc) => {
        const cell = clip.cellsByScene[sc.id]
        if (!cell) return sc
        return { ...sc, cells: { ...sc.cells, [newId]: structuredClone(cell) } }
      })
      set((s) => ({
        session: { ...s.session, tracks: newTracks, scenes: newScenes }
      }))
      return
    }
    if (clip.kind === 'instrument-track') {
      if (st.session.tracks.length + 1 + clip.children.length > 128) return
      const newTplId = `t_${Math.random().toString(36).slice(2, 9)}`
      const existingNames = st.session.tracks.map((t) => t.name)
      const newTpl: Track = {
        ...structuredClone(clip.track),
        id: newTplId,
        name: uniqueCopyName(clip.track.name, existingNames)
      }
      const childIdMap = new Map<string, string>()
      const newChildren: Track[] = clip.children.map((child) => {
        const newChildId = `t_${Math.random().toString(36).slice(2, 9)}`
        childIdMap.set(child.id, newChildId)
        return {
          ...structuredClone(child),
          id: newChildId,
          parentTrackId: newTplId
        }
      })
      const newTracks = [
        ...st.session.tracks.slice(0, insertAfter + 1),
        newTpl,
        ...newChildren,
        ...st.session.tracks.slice(insertAfter + 1)
      ]
      const newScenes = st.session.scenes.map((sc) => {
        const row = clip.cellsByScene[sc.id]
        if (!row) return sc
        const nextCells = { ...sc.cells }
        childIdMap.forEach((newCId, oldCId) => {
          const c = row[oldCId]
          if (c) nextCells[newCId] = structuredClone(c)
        })
        return { ...sc, cells: nextCells }
      })
      set((s) => ({
        session: { ...s.session, tracks: newTracks, scenes: newScenes }
      }))
    }
  },
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
  setTrackMidiOut: (id, patch) =>
    set((st) => ({
      session: {
        ...st.session,
        tracks: st.session.tracks.map((t) => {
          if (t.id !== id) return t
          if (patch === null) {
            // Clear the MIDI default entirely (next cell created on
            // this row gets no inherited midiOut).
            const { midiOut: _drop, ...rest } = t
            void _drop
            return rest
          }
          const base = t.midiOut ?? {
            enabled: false,
            portName: '',
            channel: 1,
            kind: 'cc' as const,
            cc: 1,
            noteMode: 'velocity' as const,
            gateLengthMs: 0
          }
          return { ...t, midiOut: { ...base, ...patch } }
        })
      }
    })),
  setTrackEnabled: (id, enabled) =>
    set((st) => ({
      session: {
        ...st.session,
        tracks: st.session.tracks.map((t) =>
          t.id === id ? { ...t, enabled } : t
        )
      }
    })),
  setTrackPersistentSlot: (id, slotIdx, persistent, capturedValue) =>
    set((st) => ({
      session: {
        ...st.session,
        tracks: st.session.tracks.map((t) => {
          if (t.id !== id) return t
          // Allocate the arrays lazily; sparse for tracks that
          // never persist anything. Length stretches to slotIdx+1
          // so untouched entries stay undefined → falsy.
          const slots = t.persistentSlots ? t.persistentSlots.slice() : []
          const values = t.persistentValues ? t.persistentValues.slice() : []
          while (slots.length <= slotIdx) slots.push(false)
          while (values.length <= slotIdx) values.push('')
          slots[slotIdx] = persistent
          if (persistent) {
            // Capture the current cell-value token for this slot.
            // Caller (Inspector) reads it from the focused scene's
            // cell.value at pin time. Empty string is fine — engine
            // parses it as 0.
            values[slotIdx] = capturedValue ?? ''
          } else {
            // Unpin — clear the captured value so the next pin
            // captures fresh data instead of resurrecting a stale
            // snapshot.
            values[slotIdx] = ''
          }
          // Drop the arrays entirely when nothing's persistent so
          // saved sessions stay tidy.
          const anyPersistent = slots.some((b) => b)
          return {
            ...t,
            persistentSlots: anyPersistent ? slots : undefined,
            persistentValues: anyPersistent ? values : undefined
          }
        })
      }
    })),
  setTrackPersistentValue: (id, slotIdx, value) =>
    set((st) => ({
      session: {
        ...st.session,
        tracks: st.session.tracks.map((t) => {
          if (t.id !== id) return t
          // Only edit slots that are CURRENTLY pinned — a typo
          // shouldn't silently pin a fresh slot. Inspector UI only
          // exposes the editor when the slot's "pin" checkbox is
          // checked, so this guard is mostly belt-and-braces.
          if (!t.persistentSlots?.[slotIdx]) return t
          const values = t.persistentValues ? t.persistentValues.slice() : []
          while (values.length <= slotIdx) values.push('')
          values[slotIdx] = value
          return { ...t, persistentValues: values }
        })
      }
    })),
  setCellPersistentSlot: (sceneId, trackId, slotIdx, persistent, capturedValue) =>
    set((st) => ({
      session: {
        ...st.session,
        scenes: st.session.scenes.map((sc) => {
          if (sc.id !== sceneId) return sc
          const cell = sc.cells[trackId]
          if (!cell) return sc
          // Sparse-array semantics: persistent === undefined means
          // "no override" (track default applies). Stretching slots
          // up to slotIdx fills any gap with undefined → falsy.
          const slots = cell.persistentSlots ? cell.persistentSlots.slice() : []
          const values = cell.persistentValues ? cell.persistentValues.slice() : []
          while (slots.length <= slotIdx) slots.push(undefined)
          while (values.length <= slotIdx) values.push('')
          slots[slotIdx] = persistent
          if (persistent === true) {
            // Capture the current cell-value token (caller passes
            // it; empty string parses as 0 just like track-level
            // pinning).
            values[slotIdx] = capturedValue ?? ''
          } else if (persistent === false) {
            // Explicit unpin — clear the captured value but keep
            // the `false` entry so the engine knows this is an
            // OVERRIDE of the track default (not "no opinion").
            values[slotIdx] = ''
          } else {
            // undefined → drop the override entirely. Trim trailing
            // undefineds so the array stays compact.
            values[slotIdx] = ''
            while (slots.length > 0 && slots[slots.length - 1] === undefined) {
              slots.pop()
              values.pop()
            }
          }
          const anyDefined = slots.some((b) => b !== undefined)
          const nextCell: Cell = {
            ...cell,
            persistentSlots: anyDefined ? slots : undefined,
            persistentValues: anyDefined ? values : undefined
          }
          return { ...sc, cells: { ...sc.cells, [trackId]: nextCell } }
        })
      }
    })),
  setCellScaling: (sceneId, trackId, patch) =>
    set((st) => ({
      session: {
        ...st.session,
        scenes: st.session.scenes.map((sc) => {
          if (sc.id !== sceneId) return sc
          const cell = sc.cells[trackId]
          if (!cell) return sc
          let nextEnabled = cell.scalingEnabled
          let nextMin = cell.scalingMin ? cell.scalingMin.slice() : []
          let nextMax = cell.scalingMax ? cell.scalingMax.slice() : []
          if (typeof patch.enabled === 'boolean') {
            nextEnabled = patch.enabled
          }
          if (typeof patch.slotIdx === 'number') {
            // Stretch the per-slot arrays to cover the touched
            // index; gaps fill with 0 / 1 as sensible defaults so
            // an enabled clamp doesn't accidentally pin the slot
            // at NaN.
            while (nextMin.length <= patch.slotIdx) nextMin.push(0)
            while (nextMax.length <= patch.slotIdx) nextMax.push(1)
            if (typeof patch.min === 'number' && Number.isFinite(patch.min)) {
              nextMin[patch.slotIdx] = patch.min
            }
            if (typeof patch.max === 'number' && Number.isFinite(patch.max)) {
              nextMax[patch.slotIdx] = patch.max
            }
          }
          const nextCell: Cell = {
            ...cell,
            scalingEnabled: nextEnabled,
            // Drop empty arrays so saved sessions stay tidy when
            // the feature is off + nothing's been touched.
            scalingMin: nextMin.length > 0 ? nextMin : undefined,
            scalingMax: nextMax.length > 0 ? nextMax : undefined
          }
          return { ...sc, cells: { ...sc.cells, [trackId]: nextCell } }
        })
      }
    })),
  sendTrackDefaultsToClips: (id) =>
    set((st) => {
      const track = st.session.tracks.find((t) => t.id === id)
      if (!track) return st
      const addr = track.defaultOscAddress
      const ip = track.defaultDestIp
      const port = track.defaultDestPort
      const midiOut = track.midiOut
      // Fall back to session defaults for anything the Message didn't specify,
      // so newly-created cells still have valid destinations.
      const effIp = ip && ip !== '' ? ip : st.session.defaultDestIp
      const effPort = port && port > 0 ? port : st.session.defaultDestPort
      const effAddr = addr && addr !== '' ? addr : st.session.defaultOscAddress
      // Pinned-value broadcast — when the user edits track.persistentValues
      // in the Inspector and clicks Send to clips, the captured values
      // should appear in every clip's value string so the grid display
      // matches what the engine emits. We rebuild each cell's tokens
      // from argSpec, overwriting pinned positions with the captured
      // value. Cells with a per-cell pin override of EXPLICITLY false
      // ignore the broadcast (the user has deliberately unpinned that
      // slot on this clip — respect it).
      const argSpec = track.argSpec
      const pinSlots = track.persistentSlots
      const pinVals = track.persistentValues
      const hasPins = !!(
        argSpec &&
        argSpec.length > 0 &&
        pinSlots &&
        pinSlots.some((b) => b === true)
      )
      function applyPinsToCellValue(cell: Cell): string {
        if (!hasPins || !argSpec) return cell.value
        // Start from current cell tokens; pad to argSpec.length using
        // the argSpec's init defaults so freshly-created or short value
        // strings still receive a full token row after the broadcast.
        const cur = parseValueTokens(cell.value)
        const initStr = buildInitialValueFromArgSpec(argSpec).split(/\s+/)
        const out: string[] = new Array(argSpec.length)
        for (let i = 0; i < argSpec.length; i++) {
          out[i] = cur[i] ?? initStr[i] ?? '0'
        }
        for (let i = 0; i < argSpec.length; i++) {
          if (pinSlots?.[i] !== true) continue
          // Per-cell unpin overrides the track-level pin — leave that
          // slot's token alone.
          if (cell.persistentSlots?.[i] === false) continue
          const v = pinVals?.[i]
          if (v !== undefined && v !== '') out[i] = v
        }
        return out.join(' ')
      }
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
              // Inherit the Parameter's MIDI defaults on auto-create.
              if (midiOut) created.midiOut = { ...midiOut }
              // Pinned-value broadcast — stamp the captured pinned
              // tokens into the brand-new cell's value so the grid
              // shows what the engine is emitting.
              if (hasPins) created.value = applyPinsToCellValue(created)
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
            // Push the Parameter row's MIDI default down to every
            // clip. Overwrites the cell's existing midiOut so a
            // "Send to Clips" click pushes all current settings —
            // port + channel + kind + CC# + gate — in lockstep with
            // the OSC fields. That's what the button promises.
            if (midiOut) {
              next.midiOut = { ...midiOut }
            }
            if (hasPins) {
              next.value = applyPinsToCellValue(next)
            }
            return { ...s, cells: { ...s.cells, [id]: next } }
          })
        }
      }
    }),
  broadcastTransitionMs: (trackId, transitionMs) =>
    set((st) => {
      // Clamp to the legal range (0..10000 ms) so a hand-edited value
      // can't push the engine outside its expected glide window. The
      // round preserves the integer shape used elsewhere in the engine
      // for transitionMs.
      const clamped = Math.max(0, Math.min(10000, Math.round(transitionMs)))
      return {
        session: {
          ...st.session,
          scenes: st.session.scenes.map((sc) => {
            const cell = sc.cells[trackId]
            if (!cell) return sc
            // Same value -- skip the clone to keep React's reference
            // identity stable.
            if (cell.transitionMs === clamped) return sc
            return {
              ...sc,
              cells: {
                ...sc.cells,
                [trackId]: { ...cell, transitionMs: clamped }
              }
            }
          })
        }
      }
    }),
  broadcastInstrumentPort: (templateId, port) =>
    set((st) => {
      const clamped = Math.max(0, Math.min(65535, Math.round(port)))
      // 1. Pool template -- update its default destPort AND clear
      // every child Function's destPortOverride so the new template
      // default applies uniformly to any future instantiation.
      const nextPool = {
        ...st.session.pool,
        templates: st.session.pool.templates.map((t) => {
          if (t.id !== templateId) return t
          return {
            ...t,
            destPort: clamped,
            functions: t.functions.map((f) => ({
              ...f,
              // Clear the per-function port override -- under uniform
              // port broadcast we want every function to follow the
              // template's new port, not retain a stale override.
              destPortOverride: undefined
            }))
          }
        })
      }
      // 2. Build the set of affected tracks: every Template-row Track
      // whose sourceTemplateId === templateId, PLUS every child
      // Parameter Track whose parentTrackId is in that set.
      const templateRowIds = new Set<string>()
      for (const t of st.session.tracks) {
        if (t.kind === 'template' && t.sourceTemplateId === templateId) {
          templateRowIds.add(t.id)
        }
      }
      const affected = new Set<string>(templateRowIds)
      for (const t of st.session.tracks) {
        if (t.parentTrackId && templateRowIds.has(t.parentTrackId)) {
          affected.add(t.id)
        }
      }
      // 3. Tracks -- set the per-instance defaultDestPort. New cells
      // created later (via ensureCell) inherit this immediately.
      const nextTracks = st.session.tracks.map((t) =>
        affected.has(t.id) ? { ...t, defaultDestPort: clamped } : t
      )
      // 4. Cells -- patch destPort on every existing clip across all
      // scenes for affected tracks. We don't touch destLinkedToDefault
      // (the engine resolves the effective port via that flag + track
      // default + session default, so a true linkage just re-reads the
      // updated track default; an explicit cell port also lands on the
      // new value -- both paths converge).
      const nextScenes = st.session.scenes.map((sc) => {
        let changed = false
        const nextCells: typeof sc.cells = {}
        for (const [tid, cell] of Object.entries(sc.cells)) {
          if (affected.has(tid) && cell.destPort !== clamped) {
            nextCells[tid] = { ...cell, destPort: clamped }
            changed = true
          } else {
            nextCells[tid] = cell
          }
        }
        return changed ? { ...sc, cells: nextCells } : sc
      })
      return {
        session: {
          ...st.session,
          pool: nextPool,
          tracks: nextTracks,
          scenes: nextScenes
        }
      }
    }),
  broadcastSessionDest: (next) =>
    set((st) => {
      const ipPatch = typeof next.ip === 'string' ? next.ip.trim() : undefined
      const portPatch =
        typeof next.port === 'number' && Number.isFinite(next.port)
          ? Math.max(0, Math.min(65535, Math.round(next.port)))
          : undefined
      if (ipPatch === undefined && portPatch === undefined) return st
      // 1. Pool -- every template + every function. Clearing the
      // per-function destIp/destPortOverride ensures the new template
      // default wins uniformly.
      const nextPool = {
        ...st.session.pool,
        templates: st.session.pool.templates.map((t) => ({
          ...t,
          destIp: ipPatch !== undefined ? ipPatch : t.destIp,
          destPort: portPatch !== undefined ? portPatch : t.destPort,
          functions: t.functions.map((f) => ({
            ...f,
            destIpOverride: ipPatch !== undefined ? undefined : f.destIpOverride,
            destPortOverride:
              portPatch !== undefined ? undefined : f.destPortOverride
          }))
        }))
      }
      // 2. Tracks -- update defaultDestIp / defaultDestPort on every
      // row that has those fields (header rows + Parameter children).
      const nextTracks = st.session.tracks.map((t) => {
        const patch: Partial<Track> = {}
        if (ipPatch !== undefined) patch.defaultDestIp = ipPatch
        if (portPatch !== undefined) patch.defaultDestPort = portPatch
        return { ...t, ...patch }
      })
      // 3. Cells -- repoint every clip's destIp / destPort. We don't
      // touch destLinkedToDefault: linked cells will re-read the new
      // session default anyway; unlinked cells get their pinned
      // value moved to the new target (which is the user intent
      // when they say "the consumer's IP changed -- everything goes
      // there now").
      const nextScenes = st.session.scenes.map((sc) => {
        let changed = false
        const nextCells: typeof sc.cells = {}
        for (const [tid, cell] of Object.entries(sc.cells)) {
          let cellChanged = false
          let newCell = cell
          if (ipPatch !== undefined && cell.destIp !== ipPatch) {
            newCell = { ...newCell, destIp: ipPatch }
            cellChanged = true
          }
          if (portPatch !== undefined && cell.destPort !== portPatch) {
            newCell = { ...newCell, destPort: portPatch }
            cellChanged = true
          }
          nextCells[tid] = newCell
          if (cellChanged) changed = true
        }
        return changed ? { ...sc, cells: nextCells } : sc
      })
      // 4. Session defaults -- the base layer.
      return {
        session: {
          ...st.session,
          defaultDestIp:
            ipPatch !== undefined ? ipPatch : st.session.defaultDestIp,
          defaultDestPort:
            portPatch !== undefined ? portPatch : st.session.defaultDestPort,
          pool: nextPool,
          tracks: nextTracks,
          scenes: nextScenes
        }
      }
    }),
  setListenerPort: (port) =>
    set((st) => {
      if (!Number.isFinite(port)) return st
      const clamped = Math.max(0, Math.min(65535, Math.round(port)))
      // Push to the main-process OSC listener so it re-binds
      // immediately. We always pass enabled=true since the
      // listener is generally on in normal use -- users can still
      // disable it later via the Network tab if they want.
      void window.api?.networkSetEnabled?.(true, clamped)
      return {
        session: { ...st.session, listenerPort: clamped }
      }
    }),
  rebindAllHardwareModesToDevice: (ip, port) =>
    set((st) => {
      const ipTrim = typeof ip === 'string' ? ip.trim() : ''
      if (!ipTrim || !Number.isFinite(port) || port < 0 || port > 65535) {
        return st
      }
      const clamped = Math.max(0, Math.min(65535, Math.round(port)))
      const nextPool = {
        ...st.session.pool,
        templates: st.session.pool.templates.map((t) => {
          // Skip templates that have no hardwareMode at all -- don't
          // create one on a template the user never configured.
          if (!t.hardwareMode) return t
          if (
            t.hardwareMode.deviceIp === ipTrim &&
            t.hardwareMode.devicePort === clamped
          ) {
            return t
          }
          return {
            ...t,
            hardwareMode: {
              ...t.hardwareMode,
              deviceIp: ipTrim,
              devicePort: clamped
            }
          }
        })
      }
      return { session: { ...st.session, pool: nextPool } }
    }),

  addScene: () =>
    set((st) => {
      if (st.session.scenes.length >= 128) return st
      const scene = makeScene(st.session.scenes.length)
      // New scenes live only in the palette; users drag them explicitly into
      // the sequencer when they're ready.
      // (FEATURE B) Insert directly AFTER the currently-focused scene,
      // falling back to append when nothing is focused (or the focused
      // id no longer exists in the grid).
      const focusIdx = st.session.focusedSceneId
        ? st.session.scenes.findIndex((s) => s.id === st.session.focusedSceneId)
        : -1
      const next = st.session.scenes.slice()
      if (focusIdx >= 0) next.splice(focusIdx + 1, 0, scene)
      else next.push(scene)
      return { session: { ...st.session, scenes: next } }
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
  moveScene: (fromIndex, toIndex) =>
    set((st) => {
      const n = st.session.scenes.length
      // Clamp + sanity-check both indices. Same index or any out-of-range
      // input is a no-op — the dnd-kit handlers can occasionally fire
      // drop events where over === active (cursor never moved past the
      // activation distance) and we don't want to spuriously rewrite
      // `session.scenes` and the undo snapshot.
      const from = Math.max(0, Math.min(n - 1, Math.floor(fromIndex)))
      const to = Math.max(0, Math.min(n - 1, Math.floor(toIndex)))
      if (from === to) return st
      const next = st.session.scenes.slice()
      const [moved] = next.splice(from, 1)
      next.splice(to, 0, moved)
      return { session: { ...st.session, scenes: next } }
    }),
  updateScene: (id, patch) => {
    // Capture the PRIOR scene state before the patch so we can use
    // the old name as the legacy-match key (the user might be renaming
    // right now — we want to find the SavedScene by what it WAS).
    const prior = get().session.scenes.find((s) => s.id === id)
    set((st) => ({
      session: {
        ...st.session,
        scenes: st.session.scenes.map((s) => (s.id === id ? { ...s, ...patch } : s))
      }
    }))
    // Bidirectional Pool sync: if this scene is linked to a Pool
    // SavedScene (via linkedSavedSceneId), mirror the user-visible
    // header fields to that SavedScene so the Pool entry stays in
    // sync. Skips the mirror when the patch doesn't touch any of
    // those specific fields (e.g. cell edits or instrumentTriggers
    // shouldn't dirty the SavedScene).
    const HEADER_KEYS = [
      'color',
      'name',
      'notes',
      'durationSec',
      'nextMode',
      'multiplicator',
      'morphInMs'
    ] as const
    const touchesHeader = HEADER_KEYS.some((k) => k in patch)
    if (!touchesHeader) return
    const after = get()
    let scene = after.session.scenes.find((s) => s.id === id)
    if (!scene) return
    // Legacy backfill: scenes saved BEFORE the linkedSavedSceneId
    // field existed won't have it. Match the prior scene name (since
    // the user might be renaming RIGHT NOW) against the SavedScene
    // library; if exactly one matches, lazily link it. This keeps
    // pre-existing saved scenes mirroring without forcing the user to
    // re-save them.
    if (!scene.linkedSavedSceneId) {
      const matchName = prior?.name ?? scene.name
      const matches = after.sceneLibrary.filter(
        (sv) => (sv.sceneMeta?.name ?? sv.name) === matchName
      )
      if (matches.length === 1) {
        const link = matches[0].id
        set((st) => ({
          session: {
            ...st.session,
            scenes: st.session.scenes.map((s) =>
              s.id === id ? { ...s, linkedSavedSceneId: link } : s
            )
          }
        }))
        scene = { ...scene, linkedSavedSceneId: link }
      }
    }
    if (!scene.linkedSavedSceneId) return
    const saved = after.sceneLibrary.find(
      (sv) => sv.id === scene!.linkedSavedSceneId
    )
    if (!saved) return
    // Pull the new live values straight off the scene (already
    // updated by the set() above) — typed correctly, no `unknown`.
    const updatedSaved: typeof saved = {
      ...saved,
      color: scene.color,
      name: scene.name,
      sceneMeta: {
        ...saved.sceneMeta,
        name: scene.name,
        color: scene.color,
        notes: scene.notes,
        durationSec: scene.durationSec,
        nextMode: scene.nextMode,
        multiplicator: scene.multiplicator,
        morphInMs: scene.morphInMs
      }
    }
    set((s) => ({
      sceneLibrary: s.sceneLibrary.map((sv) =>
        sv.id === updatedSaved.id ? updatedSaved : sv
      )
    }))
    // (#20) In-store update above is immediate; disk write is debounced
    // per savedSceneId so a name/notes/duration edit-burst writes once.
    debouncedSceneLibrarySave(updatedSaved)
  },
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
    set((st) => {
      const track = st.session.tracks.find((t) => t.id === trackId)
      const def = resolveCellDefaults(st.session, track)
      return {
        session: {
          ...st.session,
          scenes: st.session.scenes.map((s) => {
            if (s.id !== sceneId) return s
            if (s.cells[trackId]) return s
            const cell = makeCell({
              destIp: def.destIp,
              destPort: def.destPort,
              oscAddress: def.oscAddress
            })
            // Override the linked flags — a cell sourced from a
            // track default is NOT tracking the session default.
            cell.destLinkedToDefault = def.destLinked
            cell.addressLinkedToDefault = def.addressLinked
            // If the track was instantiated from a multi-arg spec
            // (e.g. OCTOCOSME's /A/strips/pots which expects a
            // [sender] [ts] + 12 floats bundle), seed the cell's
            // value with the spec's fixed prefix + per-arg inits
            // joined by space. The user then edits N labeled
            // inputs in the inspector instead of one big string.
            if (track?.argSpec && track.argSpec.length > 0) {
              cell.value = buildInitialValueFromArgSpec(track.argSpec)
            }
            // Template-kind tracks (Instrument-template "header" rows)
            // host the group-trigger UI button, not a data-emitting
            // cell. Force oscEnabled=false at create time so the
            // serialized session data matches the engine's hard
            // invariant (template-kind tracks NEVER emit OSC — see
            // engine.ts oscEmitAllowed gate). Without this, legacy
            // session captures and any future bulk-create code path
            // would keep generating ghost cells that the engine
            // silently drops but show up as unrouted "/dataflou/value 0"
            // packets on downstream consumers when forwarded.
            if (track?.kind === 'template') {
              cell.oscEnabled = false
            }
            // Inherit the Parameter row's MIDI default. Lookup
            // order:
            //   1. The Parameter row's own `midiOut` (edited from
            //      the TrackInspector in the Edit view) — this is
            //      where the user does most of the wiring.
            //   2. The source Function in the Pool — for cells
            //      created on a row that was just instantiated from
            //      a built-in MIDI Parameter blueprint.
            if (track?.midiOut) {
              cell.midiOut = { ...track.midiOut }
            } else if (track?.sourceTemplateId && track?.sourceFunctionId) {
              const tpl = st.session.pool.templates.find(
                (t) => t.id === track.sourceTemplateId
              )
              const src = tpl?.functions.find((f) => f.id === track.sourceFunctionId)
              if (src?.midiOut) {
                cell.midiOut = { ...src.midiOut }
              }
            }
            return {
              ...s,
              cells: { ...s.cells, [trackId]: cell }
            }
          })
        }
      }
    }),
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
      // When a slot is cleared (sceneId === null), drop any override
      // it carried. Otherwise the override would orphan and cause
      // confusing behaviour if a different scene later landed in the
      // same slot.
      let nextOverrides = st.session.sequenceSlotOverrides
      if (sceneId === null && nextOverrides && nextOverrides[index]) {
        nextOverrides = { ...nextOverrides }
        delete nextOverrides[index]
      }
      return {
        session: {
          ...st.session,
          sequence: seq,
          sequenceSlotOverrides: nextOverrides
        }
      }
    }),
  setSequenceSlotOverride: (index, patch) =>
    set((st) => {
      const cur = st.session.sequenceSlotOverrides?.[index] ?? {}
      const merged = { ...cur, ...patch }
      // Strip undefined keys so an override of `{ durationSec: undefined }`
      // erases the field (rather than carrying a noise entry).
      for (const k of Object.keys(merged) as (keyof typeof merged)[]) {
        if (merged[k] === undefined) delete merged[k]
      }
      const next = { ...(st.session.sequenceSlotOverrides ?? {}) }
      if (Object.keys(merged).length === 0) {
        // Empty override = no override; drop the key entirely.
        delete next[index]
      } else {
        next[index] = merged
      }
      return { session: { ...st.session, sequenceSlotOverrides: next } }
    }),
  clearSequenceSlotOverride: (index) =>
    set((st) => {
      if (!st.session.sequenceSlotOverrides?.[index]) return st
      const next = { ...st.session.sequenceSlotOverrides }
      delete next[index]
      return { session: { ...st.session, sequenceSlotOverrides: next } }
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
  // Minimum 45 px: below that, the trigger button (20 px) + a
  // single line of the value grid (~11 px) wouldn't fit, leaving
  // the cell visually empty. Users who want extreme compactness
  // can collapse tracks via the sidebar toggle instead, which
  // switches to the 32-px single-line layout.
  setRowHeight: (h) => set({ rowHeight: clampInt(h, 45, 220) }),
  // v0.5.10 -- minimum lowered from 180 to 140 so a uiScale 0.6
  // user can pack more Scene columns onto a 1080p screen. At 140
  // the Dur row labels squeeze but the Scene name stays readable
  // and the Next dropdown (fixed 78px) still fits. Below 140 the
  // header starts wrapping and we lose the at-a-glance scan that
  // makes the Edit view useful.
  setSceneColumnWidth: (w) => set({ sceneColumnWidth: clampInt(w, 140, 480) }),
  setScenePaletteWidth: (w) => set({ scenePaletteWidth: clampInt(w, 200, 1200) }),
  setSceneInfoPanelHeight: (h) =>
    set({ sceneInfoPanelHeight: clampInt(h, 80, 1600) }),
  setTrackColumnWidth: (w) => set({ trackColumnWidth: clampInt(w, 160, 400) }),
  // v0.5.10 -- minimum lowered from 320 to 280. At 280 the
  // SettingsBox row of two buttons wraps to two rows (still
  // readable), all form sections reflow via flex-wrap, and the
  // user reclaims 40 layout-pixels for more Scene columns.
  setInspectorWidth: (w) => set({ inspectorWidth: clampInt(w, 280, 640) }),
  setSequencePaused: (paused) => set({ sequencePaused: paused }),
  setMidiLearnMode: (on) =>
    // Clear midiLearnTarget ONLY when turning OFF (cancelling).
    // Turning ON must PRESERVE the target so callers can pre-set it
    // before flipping mode on — e.g. the Learned panel's Edit button
    // does `setMidiLearnTarget(b.editTarget); setMidiLearnMode(true)`
    // and was getting its target wiped by an over-eager clear here.
    // After a successful bind, midi.ts itself clears the target while
    // mode stays on (Ableton-style: keep mapping the next control).
    set(on ? { midiLearnMode: true } : { midiLearnMode: false, midiLearnTarget: null }),
  setMidiLearnTarget: (t) => set({ midiLearnTarget: t }),
  setMod1Live: (sample) => set({ mod1Live: sample }),
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
  setGenerativePopoverOpen: (v) => set({ generativePopoverOpen: v }),
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
    // NOTE: this used to dynamic-`require` the integrity module, but Vite's
    // ESM-only renderer has no CommonJS `require` at runtime — the call
    // threw a silent ReferenceError that was swallowed by the IPC promise,
    // so Open looked like a no-op. Static import (top of file) fixes it.
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
  // ── Generative Scene Sequencer actions ────────────────────────────
  // All writers go through `patchGenerative` (defined inline) which
  // seeds DEFAULT_GENERATIVE_CONFIG when session.generative is missing
  // (back-compat with v0.5.9 sessions). After patching, the engine
  // sync is automatic via the existing `session` -> `window.api`
  // pipeline on the next update tick.
  setGenerativeEnabled: (v) =>
    set((st) => ({
      session: {
        ...st.session,
        generative: { ...DEFAULT_GENERATIVE_CONFIG, ...st.session.generative, enabled: v }
      }
    })),
  setGenerativePoolSource: (src) =>
    set((st) => ({
      session: {
        ...st.session,
        generative: { ...DEFAULT_GENERATIVE_CONFIG, ...st.session.generative, poolSource: src }
      }
    })),
  setSceneInPool: (sceneId, inPool) =>
    set((st) => {
      const cur = { ...DEFAULT_GENERATIVE_CONFIG, ...st.session.generative }
      const nextExcluded = { ...cur.excluded }
      // Sparse storage: only excluded scenes get an entry. Default
      // (not excluded == in pool) is the absence of the key.
      if (inPool) delete nextExcluded[sceneId]
      else nextExcluded[sceneId] = true
      return {
        session: { ...st.session, generative: { ...cur, excluded: nextExcluded } }
      }
    }),
  selectAllScenesForPool: (inPool) =>
    set((st) => {
      const cur = { ...DEFAULT_GENERATIVE_CONFIG, ...st.session.generative }
      const nextExcluded: Record<string, boolean> = {}
      if (!inPool) {
        for (const s of st.session.scenes) nextExcluded[s.id] = true
      }
      return {
        session: { ...st.session, generative: { ...cur, excluded: nextExcluded } }
      }
    }),
  setGenerativeMode: (mode) =>
    set((st) => {
      const cur = { ...DEFAULT_GENERATIVE_CONFIG, ...st.session.generative }
      // Mode picker WRITES the underlying knobs to known values --
      // it's a preset, not a separate code path. 'custom' is the only
      // mode that leaves the knobs untouched (used as a label when
      // the user has tweaked something away from a preset).
      let patch: Partial<GenerativeConfig> = { mode }
      if (mode === 'random')
        patch = { mode, affinity: 0, noRepeat: true, shuffleCycle: false }
      else if (mode === 'drift')
        patch = { mode, affinity: 80, noRepeat: true, shuffleCycle: false }
      else if (mode === 'surprise')
        patch = { mode, affinity: -80, noRepeat: true, shuffleCycle: false }
      else if (mode === 'shuffle')
        patch = { mode, affinity: 0, noRepeat: true, shuffleCycle: true }
      // 'custom' falls through with just { mode } so the user's
      // already-tweaked knobs are preserved.
      return {
        session: { ...st.session, generative: { ...cur, ...patch } }
      }
    }),
  setGenerativeAffinity: (affinity) =>
    set((st) => {
      const cur = { ...DEFAULT_GENERATIVE_CONFIG, ...st.session.generative }
      const clamped = Math.max(
        GENERATIVE_AFFINITY_MIN,
        Math.min(GENERATIVE_AFFINITY_MAX, affinity)
      )
      // Tweaking affinity away from a preset's value auto-switches
      // mode label to 'custom' so the dropdown reflects reality.
      const nextMode: GenerativeMode = matchesPresetMode(
        cur,
        'affinity',
        clamped
      )
        ? cur.mode
        : 'custom'
      return {
        session: {
          ...st.session,
          generative: { ...cur, affinity: clamped, mode: nextMode }
        }
      }
    }),
  setGenerativeNoRepeat: (v) =>
    set((st) => {
      const cur = { ...DEFAULT_GENERATIVE_CONFIG, ...st.session.generative }
      const nextMode: GenerativeMode = matchesPresetMode(cur, 'noRepeat', v)
        ? cur.mode
        : 'custom'
      return {
        session: {
          ...st.session,
          generative: { ...cur, noRepeat: v, mode: nextMode }
        }
      }
    }),
  setGenerativeShuffleCycle: (v) =>
    set((st) => {
      const cur = { ...DEFAULT_GENERATIVE_CONFIG, ...st.session.generative }
      const nextMode: GenerativeMode = matchesPresetMode(
        cur,
        'shuffleCycle',
        v
      )
        ? cur.mode
        : 'custom'
      return {
        session: {
          ...st.session,
          generative: { ...cur, shuffleCycle: v, mode: nextMode }
        }
      }
    }),
  setGenerativeMinDurationMs: (ms) =>
    set((st) => {
      if (!Number.isFinite(ms)) return st
      const cur = { ...DEFAULT_GENERATIVE_CONFIG, ...st.session.generative }
      const clamped = Math.max(
        GENERATIVE_DURATION_MIN_MS,
        Math.min(GENERATIVE_DURATION_MAX_MS, Math.round(ms))
      )
      // Keep max >= min by bumping max up if the user pushes min past it.
      const nextMax = Math.max(clamped, cur.maxDurationMs)
      return {
        session: {
          ...st.session,
          generative: { ...cur, minDurationMs: clamped, maxDurationMs: nextMax }
        }
      }
    }),
  setGenerativeMaxDurationMs: (ms) =>
    set((st) => {
      if (!Number.isFinite(ms)) return st
      const cur = { ...DEFAULT_GENERATIVE_CONFIG, ...st.session.generative }
      const clamped = Math.max(
        GENERATIVE_DURATION_MIN_MS,
        Math.min(GENERATIVE_DURATION_MAX_MS, Math.round(ms))
      )
      // Keep min <= max by pulling min down if the user drags max
      // below it.
      const nextMin = Math.min(clamped, cur.minDurationMs)
      return {
        session: {
          ...st.session,
          generative: { ...cur, maxDurationMs: clamped, minDurationMs: nextMin }
        }
      }
    }),
  setGenerativeUseMorph: (v) =>
    set((st) => ({
      session: {
        ...st.session,
        generative: { ...DEFAULT_GENERATIVE_CONFIG, ...st.session.generative, useMorph: v }
      }
    })),
  setSceneWeight: (sceneId, weight) =>
    set((st) => {
      if (!Number.isFinite(weight)) return st
      const clamped = Math.max(
        SCENE_WEIGHT_MIN,
        Math.min(SCENE_WEIGHT_MAX, weight)
      )
      return {
        session: {
          ...st.session,
          scenes: st.session.scenes.map((s) =>
            s.id === sceneId ? { ...s, weight: clamped } : s
          )
        }
      }
    }),
  // (v0.6.x) Motion Loop ---------------------------------------------
  startMotionLoopRecord: (sceneId) => {
    const st = get()
    if (!st.session.scenes.some((s) => s.id === sceneId)) return
    // Flip UI state FIRST so the button responds even if the IPC bridge is
    // stale (dev preload not reloaded). Side effect stays OUT of the set()
    // updater — a throw there would silently abort the state change.
    set({ recordingLoopSceneId: sceneId, recordingLoopStartedAt: Date.now() })
    window.api.motionLoopStartRecord?.(sceneId)
  },
  stopMotionLoopRecord: () => {
    set({ recordingLoopSceneId: null, recordingLoopStartedAt: null })
    const p = window.api.motionLoopStopRecord?.()
    if (!p) return
    void p.then((res) => {
      if (!res) return
      // Auto-create a clip for every captured parameter that doesn't have
      // one yet, so the recorded loops appear on the grid and play when the
      // scene is triggered. ensureCell inherits the track's OSC routing and
      // is a no-op when the cell already exists.
      const ensure = get().ensureCell
      for (const trackId of Object.keys(res.byTrack)) {
        ensure(res.sceneId, trackId)
      }
      set((st) => ({
        session: {
          ...st.session,
          scenes: st.session.scenes.map((s) => {
            if (s.id !== res.sceneId) return s
            const cells = { ...s.cells }
            for (const [trackId, frames] of Object.entries(res.byTrack)) {
              const cell = cells[trackId]
              if (!cell) continue
              cells[trackId] = {
                ...cell,
                recordedLoop: {
                  enabled: true,
                  durationMs: res.durationMs,
                  frames
                }
              }
            }
            // Sync the scene's timing to the loop so it repeats seamlessly
            // (the Scene IS the loop): duration = loop length, follow-action
            // = Loop. Re-recording re-sets both to the new take's length.
            return {
              ...s,
              cells,
              durationSec: Math.max(0.1, res.durationMs / 1000),
              nextMode: 'loop' as const
            }
          })
        }
      }))
    })
  },
  clearMotionLoop: (sceneId) =>
    set((st) => ({
      session: {
        ...st.session,
        scenes: st.session.scenes.map((s) => {
          if (s.id !== sceneId) return s
          const cells = { ...s.cells }
          for (const tid of Object.keys(cells)) {
            if (cells[tid].recordedLoop) {
              cells[tid] = { ...cells[tid], recordedLoop: undefined }
            }
          }
          return { ...s, cells }
        })
      }
    })),
  setRecordedLoopEnabled: (sceneId, enabled) =>
    set((st) => ({
      session: {
        ...st.session,
        scenes: st.session.scenes.map((s) => {
          if (s.id !== sceneId) return s
          const cells = { ...s.cells }
          for (const tid of Object.keys(cells)) {
            const rl = cells[tid].recordedLoop
            if (rl) {
              cells[tid] = { ...cells[tid], recordedLoop: { ...rl, enabled } }
            }
          }
          return { ...s, cells }
        })
      }
    })),
  setMotionLoopRecordMidi: (binding) =>
    set((st) => ({
      session: { ...st.session, motionLoopRecordMidi: binding ?? undefined }
    })),
  setMotionLoopOscTrigger: (patch) =>
    set((st) => {
      const cur = st.session.motionLoopOscTrigger ?? {
        enabled: false,
        address: '/mpu/btn1'
      }
      return {
        session: {
          ...st.session,
          motionLoopOscTrigger: {
            enabled: patch.enabled ?? cur.enabled,
            address: patch.address !== undefined ? patch.address : cur.address
          }
        }
      }
    }),
  toggleMotionLoopRecordFocused: () => {
    const st = get()
    if (st.recordingLoopSceneId != null) {
      st.stopMotionLoopRecord()
      return
    }
    const focusId = st.session.focusedSceneId
    if (focusId) st.startMotionLoopRecord(focusId)
  },
  rollRandomWeights: () =>
    set((st) => ({
      session: {
        ...st.session,
        scenes: st.session.scenes.map((s) => ({
          ...s,
          // Uniform random in [SCENE_WEIGHT_MIN, SCENE_WEIGHT_MAX].
          // Round to 1 decimal so the displayed value is readable
          // and the user can tweak from there without micro-noise.
          weight:
            Math.round(
              (SCENE_WEIGHT_MIN +
                Math.random() * (SCENE_WEIGHT_MAX - SCENE_WEIGHT_MIN)) *
                10
            ) / 10
        }))
      }
    })),
  pickGenerativeStarterId: () => {
    const st = get()
    const cfg = st.session.generative
    if (!cfg || !cfg.enabled) return null
    // Build eligible pool: scenes not excluded by the per-scene
    // checklist, narrowed by Timeline-only when configured. We
    // intentionally use the SAME pool rules as the engine selector
    // (see engine.pickGenerativeScene) so the starter looks
    // continuous with subsequent picks. Affinity is not applied --
    // there's no "current scene" yet to bias toward.
    let pool = st.session.scenes.filter((s) => cfg.excluded[s.id] !== true)
    if (cfg.poolSource === 'timeline') {
      const inTimeline = new Set(
        (st.session.sequence ?? []).filter(
          (id): id is string => typeof id === 'string'
        )
      )
      pool = pool.filter((s) => inTimeline.has(s.id))
    }
    if (pool.length === 0) return null
    if (pool.length === 1) return pool[0].id
    // Weighted random pick using scene.weight (default 1, clamped
    // 1..10). No repetition penalty -- this is the FIRST pick, no
    // history to bias against.
    const weights: number[] = pool.map((s) => {
      const w =
        typeof s.weight === 'number' && Number.isFinite(s.weight)
          ? Math.max(SCENE_WEIGHT_MIN, Math.min(SCENE_WEIGHT_MAX, s.weight))
          : SCENE_WEIGHT_DEFAULT
      return w
    })
    const total = weights.reduce((a, b) => a + b, 0)
    if (total <= 0) return pool[Math.floor(Math.random() * pool.length)].id
    const target = Math.random() * total
    let acc = 0
    for (let i = 0; i < pool.length; i++) {
      acc += weights[i]
      if (acc >= target) return pool[i].id
    }
    return pool[pool.length - 1].id
  },
  // MIDI bindings -- one shape, seven slots.
  setGenerativeToggleMidi: (b) =>
    set((st) => ({
      session: {
        ...st.session,
        generative: { ...DEFAULT_GENERATIVE_CONFIG, ...st.session.generative, toggleMidi: b }
      }
    })),
  setGenerativeNoRepeatMidi: (b) =>
    set((st) => ({
      session: {
        ...st.session,
        generative: { ...DEFAULT_GENERATIVE_CONFIG, ...st.session.generative, noRepeatMidi: b }
      }
    })),
  setGenerativeAffinityMidi: (b) =>
    set((st) => ({
      session: {
        ...st.session,
        generative: { ...DEFAULT_GENERATIVE_CONFIG, ...st.session.generative, affinityMidi: b }
      }
    })),
  setGenerativeMinDurationMidi: (b) =>
    set((st) => ({
      session: {
        ...st.session,
        generative: { ...DEFAULT_GENERATIVE_CONFIG, ...st.session.generative, minDurationMidi: b }
      }
    })),
  setGenerativeMaxDurationMidi: (b) =>
    set((st) => ({
      session: {
        ...st.session,
        generative: { ...DEFAULT_GENERATIVE_CONFIG, ...st.session.generative, maxDurationMidi: b }
      }
    })),
  setGenerativeUseMorphMidi: (b) =>
    set((st) => ({
      session: {
        ...st.session,
        generative: { ...DEFAULT_GENERATIVE_CONFIG, ...st.session.generative, useMorphMidi: b }
      }
    })),
  setRandomWeightsMidi: (b) =>
    set((st) => ({
      session: {
        ...st.session,
        generative: { ...DEFAULT_GENERATIVE_CONFIG, ...st.session.generative, randomWeightsMidi: b }
      }
    })),
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
      // Capture the source track's argSpec so a multi-arg clip
      // template can re-impose its structure on an empty Parameter
      // later. Single-arg cells have no argSpec — that's fine,
      // applyClipTemplate just skips the projection step.
      const track = st.session.tracks.find((t) => t.id === trackId)
      const argSpec = track?.argSpec ? track.argSpec.map((a) => ({ ...a })) : undefined
      const tpl: ClipTemplate = {
        id: 'tpl_' + Math.random().toString(36).slice(2, 10),
        name: name.trim() || 'Untitled',
        cell: cleaned,
        argSpec
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
      // template on top of a fresh makeCell() baseline with the right
      // defaults for THIS track — Pool-instantiated tracks have their
      // own default IP/port/address (e.g. OCTOCOSME's /A/strips/pots),
      // and the cell should inherit those if the template doesn't
      // override them. Any field the template doesn't carry falls back
      // to the resolved track / session default.
      const track = st.session.tracks.find((t) => t.id === trackId)
      const def = resolveCellDefaults(st.session, track)
      const base = makeCell({
        destIp: def.destIp,
        destPort: def.destPort,
        oscAddress: def.oscAddress
      })
      base.destLinkedToDefault = def.destLinked
      base.addressLinkedToDefault = def.addressLinked
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
      // Project the template's argSpec onto the target track if (a)
      // the template carries one (multi-arg clip) AND (b) the track
      // has no argSpec yet (empty / fresh Parameter row, or a row
      // instantiated from a single-arg source that the user now
      // wants to upgrade). When the track ALREADY has an argSpec,
      // we leave it alone — overwriting could clobber the user's
      // hand-tuned pin / value layout. Same rule for any track
      // that has cells already filled on OTHER scenes: changing
      // its argSpec here would re-interpret their value strings.
      const otherCellsExist = st.session.scenes.some(
        (s) => s.id !== sceneId && s.cells[trackId]
      )
      const shouldProjectArgSpec =
        tpl.argSpec && tpl.argSpec.length > 1 && track && !track.argSpec && !otherCellsExist
      const tracksUpdated = shouldProjectArgSpec
        ? st.session.tracks.map((t) =>
            t.id === trackId
              ? {
                  ...t,
                  argSpec: tpl.argSpec!.map((a) => ({ ...a }))
                }
              : t
          )
        : st.session.tracks
      return {
        session: {
          ...st.session,
          tracks: tracksUpdated,
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
  addMetaDestination: (knobIdx, prefill) =>
    set((st) => {
      if (knobIdx < 0 || knobIdx >= META_KNOB_COUNT) return st
      const knobs = st.session.metaController.knobs.map((k, i) => {
        if (i !== knobIdx) return k
        if (k.destinations.length >= META_MAX_DESTS) return k
        // Prefill from the Destination-header picker (resolved
        // Instrument → Parameter → optional Value), falling back to
        // session defaults + a /meta/N stub address otherwise. Each
        // field is overridable independently so a caller can pass
        // only an OSC address and inherit the IP/port defaults.
        const newDest: MetaDest = {
          destIp: prefill?.destIp ?? st.session.defaultDestIp,
          destPort: prefill?.destPort ?? st.session.defaultDestPort,
          oscAddress: prefill?.oscAddress ?? `/meta/${knobIdx + 1}`,
          enabled: prefill?.enabled ?? true
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
  setTopBarScale: (s) =>
    set({
      topBarScale: Math.max(
        TOPBAR_SCALE_MIN,
        Math.min(TOPBAR_SCALE_MAX, s)
      )
    }),
  bumpScopePrefsRev: () => set((s) => ({ scopePrefsRev: s.scopePrefsRev + 1 })),

  setNetworkSnapshot: (devices, status) =>
    set({ networkDevices: devices, networkStatus: status }),

  materialiseNetworkDevice: (deviceId) => {
    // Find the discovered device by id. Defensive about stale ids —
    // the user could keep a drag-start event mid-flight while the
    // device's TTL expires and it falls off the list.
    const dev = get().networkDevices.find((d) => d.id === deviceId)
    if (!dev) return null
    // Derive a short instrument name from the most common OSC root
    // (the first path component). e.g. "/octocosme/vol /octocosme/tilt"
    // → "octocosme". Falls back to the ip if there's no common prefix.
    const rootCounts = new Map<string, number>()
    for (const a of dev.addresses) {
      const m = /^\/?([^/]+)/.exec(a.path)
      if (m) rootCounts.set(m[1], (rootCounts.get(m[1]) ?? 0) + 1)
    }
    let bestRoot = ''
    let bestN = 0
    rootCounts.forEach((n, root) => {
      if (n > bestN) {
        bestN = n
        bestRoot = root
      }
    })
    // If half or more of the addresses share a root, use it as the
    // template's OSC base + display name. Otherwise leave the base
    // empty (each function's path stays absolute) and name by IP.
    const useRoot = bestN > 0 && bestN >= Math.ceil(dev.addresses.length / 2)
    const tplName = useRoot ? bestRoot : `OSC ${dev.ip}`
    const oscBase = useRoot ? `/${bestRoot}` : ''
    // Escape regex metacharacters in the discovered root before
    // injecting into RegExp — OSC addresses can legitimately contain
    // dots, parens, plus, etc., and an unescaped `/foo.bar/baz`
    // would otherwise match `/fooXbar/baz`.
    const escapedBest = bestRoot.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    // Build one InstrumentFunction per observed address. Strip the
    // shared root from each path when we adopt it as the base, so
    // /octocosme/vol becomes function path "vol" under base "/octocosme".
    const functions: InstrumentFunction[] = dev.addresses.map((addr, i) => {
      const paramType = inferParamTypeFromArgTypes(addr.argTypes)
      let oscPath = addr.path
      if (useRoot) {
        const stripped = oscPath.replace(new RegExp(`^/?${escapedBest}/?`), '')
        // If stripping leaves nothing (root address itself), keep the
        // last segment as the param name; otherwise use the stripped
        // remainder.
        oscPath = stripped || bestRoot
      } else if (oscPath.startsWith('/')) {
        oscPath = oscPath.slice(1)
      }
      // Friendly name = last path segment, title-cased.
      const last = oscPath.split('/').filter(Boolean).pop() ?? `param${i + 1}`
      const name = last
        .replace(/[-_]+/g, ' ')
        .replace(/\b\w/g, (c) => c.toUpperCase())
      // Multi-arg paramTypes (v2/v3/v4/colour) need an argSpec so the
      // cell editor's split-input strip can render one input per slot.
      // Without this, a v3 RGB clip would show only a single combined
      // input and the user couldn't edit individual channels. We
      // derive slot names from canonical conventions (x/y for v2,
      // x/y/z for v3, x/y/z/w for v4, r/g/b/a for colour) and pick a
      // sensible default min/max range.
      const argSpec = buildArgSpecForParamType(paramType, addr.argTypes)
      const isBool = paramType === 'bool'
      const fn: InstrumentFunction = {
        id: `fn_net_${Math.random().toString(36).slice(2, 9)}`,
        name,
        oscPath,
        paramType,
        nature: 'lin',
        streamMode: 'streaming',
        min: isBool ? 0 : 0,
        max: isBool ? 1 : 1,
        init: 0
      }
      if (argSpec) fn.argSpec = argSpec
      return fn
    })
    // Ensure at least one function — if the device emitted bundles only
    // (no top-level messages) we'd have an empty list. Fall back to a
    // single placeholder param the user can rename.
    if (functions.length === 0) {
      functions.push({
        id: `fn_net_${Math.random().toString(36).slice(2, 9)}`,
        name: 'Parameter 1',
        oscPath: 'param1',
        paramType: 'float',
        nature: 'lin',
        streamMode: 'streaming',
        min: 0,
        max: 1,
        init: 0
      })
    }
    const newId = `tpl_user_${Math.random().toString(36).slice(2, 9)}`
    const tpl: InstrumentTemplate = {
      id: newId,
      name: tplName,
      description: `Auto-discovered ${dev.ip}:${dev.port} — ${dev.addresses.length} address${
        dev.addresses.length === 1 ? '' : 'es'
      } observed.`,
      // Match the device's actual sender as the destination IP. The
      // sender's source port is rarely also its inbox, so default the
      // destination port to 9000 (common OSC inbox) — the user can
      // override on the template if their device listens elsewhere.
      color: pickAutoColor(newId),
      destIp: dev.ip,
      destPort: 9000,
      oscAddressBase: oscBase,
      voices: 1,
      builtin: false,
      functions
    }
    set((st) => ({
      session: {
        ...st.session,
        pool: { ...st.session.pool, templates: [...st.session.pool.templates, tpl] }
      },
      poolSelection: { kind: 'template', templateId: newId }
    }))
    return newId
  },

  // ── Scene library actions ────────────────────────────────────────
  setSceneLibrary: (scenes) => set({ sceneLibrary: scenes }),
  mergePoolLibrary: (payload) =>
    set((st) => {
      // Skip any library entry whose id is already in the
      // current session's pool. The session's data wins because
      // it may have local edits the library hasn't seen yet
      // (e.g. an entry that's in the middle of being renamed).
      const existingTplIds = new Set(st.session.pool.templates.map((t) => t.id))
      const existingParIds = new Set(st.session.pool.parameters.map((p) => p.id))
      const newTpls = (payload.templates ?? []).filter(
        (t) => !existingTplIds.has(t.id) && !t.builtin
      )
      const newPars = (payload.parameters ?? []).filter(
        (p) => !existingParIds.has(p.id) && !p.builtin
      )
      if (newTpls.length === 0 && newPars.length === 0) return st
      return {
        session: {
          ...st.session,
          pool: {
            ...st.session.pool,
            templates: [...st.session.pool.templates, ...newTpls],
            parameters: [...st.session.pool.parameters, ...newPars]
          }
        }
      }
    }),
  setCaptureOpen: (open) => set({ captureOpen: open }),
  setNewSessionConfirmOpen: (open) => set({ newSessionConfirmOpen: open }),

  saveSceneToLibrary: async (sceneId, name) => {
    const st = get()
    const scene = st.session.scenes.find((s) => s.id === sceneId)
    if (!scene) return null
    // Collect every track that actually has a cell on this scene
    // plus each of those tracks' parent Template (header) row so
    // the saved scene preserves the visual grouping when re-
    // instantiated. We work via a Set of needed track ids, then
    // walk session.tracks in its SIDEBAR ORDER to materialise the
    // list — this matters because the saved-scene instantiator
    // resolves parentTrackId by id-map lookup as it walks the list:
    // a parent header that lands AFTER its child function row would
    // come out with parentTrackId=undefined (orphan), which is the
    // bug that re-shuffled an OCTOCOSME scene onto a blank grid.
    const cellTrackIds = Object.keys(scene.cells).filter(
      (tid) => st.session.tracks.some((t) => t.id === tid)
    )
    const neededIds = new Set<string>(cellTrackIds)
    const usedTemplateIds = new Set<string>()
    for (const tid of cellTrackIds) {
      const tr = st.session.tracks.find((t) => t.id === tid)
      if (!tr) continue
      if (tr.parentTrackId) neededIds.add(tr.parentTrackId)
      if (tr.sourceTemplateId) usedTemplateIds.add(tr.sourceTemplateId)
    }
    // Pick up parent's sourceTemplateId too (header tracks carry
    // one even though they don't have cells), so the saved scene's
    // Pool block includes every needed Instrument template.
    for (const id of neededIds) {
      const tr = st.session.tracks.find((t) => t.id === id)
      if (tr?.sourceTemplateId) usedTemplateIds.add(tr.sourceTemplateId)
    }
    // Materialise in session.tracks order — preserves parent-before-
    // child invariant and the user's chosen Instrument grouping.
    const usedTracks: Track[] = st.session.tracks.filter((t) =>
      neededIds.has(t.id)
    )
    const usedTemplates: InstrumentTemplate[] = []
    usedTemplateIds.forEach((tplId) => {
      const tpl = st.session.pool.templates.find((t) => t.id === tplId)
      if (tpl) usedTemplates.push(tpl)
    })
    const savedSceneCells: Record<string, Cell> = {}
    for (const tid of cellTrackIds) {
      if (scene.cells[tid]) savedSceneCells[tid] = scene.cells[tid]
    }
    // Uniqueness: if the proposed name is already taken by another
    // saved scene in the library, append " _1" / " _2" / … so the
    // user doesn't accidentally end up with two indistinguishable
    // Saved Scenes. Doesn't suppress the save — the new entry just
    // gets a unique label. Numbered scenes that already exist
    // increment past their highest current suffix.
    const proposedName = (name.trim() || scene.name || 'Saved Scene').trim()
    const existingNames = new Set(st.sceneLibrary.map((s) => s.name))
    let finalName = proposedName
    if (existingNames.has(finalName)) {
      let n = 1
      // Strip an existing " _N" suffix so duplicating "X _2" yields
      // "X _3", not "X _2 _1".
      const base = finalName.replace(/ _\d+$/, '')
      while (existingNames.has(`${base} _${n}`)) n += 1
      finalName = `${base} _${n}`
    }
    const saved: import('@shared/types').SavedScene = {
      id: `scn_lib_${Math.random().toString(36).slice(2, 9)}`,
      name: finalName,
      color: scene.color,
      createdAt: Date.now(),
      origin: 'manual',
      templates: usedTemplates,
      tracks: usedTracks,
      cells: savedSceneCells,
      sceneMeta: {
        name: scene.name,
        color: scene.color,
        notes: scene.notes,
        durationSec: scene.durationSec,
        nextMode: scene.nextMode,
        multiplicator: scene.multiplicator,
        morphInMs: scene.morphInMs
      }
    }
    try {
      await window.api?.sceneLibrarySave?.(saved)
    } catch (e) {
      console.error('[saveSceneToLibrary] failed:', (e as Error).message)
      return null
    }
    // Link the live scene to the just-created SavedScene so later
    // updates to the live scene's color / name / notes mirror back
    // to the Pool entry. Sets linkedSavedSceneId on the scene; the
    // matching updateScene + updateSavedScene flows will then read
    // this link to keep the two in sync.
    set((s) => ({
      session: {
        ...s.session,
        scenes: s.session.scenes.map((sc) =>
          sc.id === sceneId
            ? { ...sc, linkedSavedSceneId: saved.id }
            : sc
        )
      }
    }))
    return saved.id
  },

  updateSavedSceneFromGrid: async (savedSceneId) => {
    const st = get()
    const cur = st.sceneLibrary.find((s) => s.id === savedSceneId)
    if (!cur) return false
    // Find the live Scene that's linked to this SavedScene. There can
    // only be one (the link is set on save / instantiate, and Pool
    // mirroring keeps them aligned).
    const scene = st.session.scenes.find((s) => s.linkedSavedSceneId === savedSceneId)
    if (!scene) return false
    // Rebuild the SavedScene exactly the way saveSceneToLibrary does,
    // but REUSING the existing id so the library entry is overwritten
    // rather than duplicated.
    const cellTrackIds = Object.keys(scene.cells).filter((tid) =>
      st.session.tracks.some((t) => t.id === tid)
    )
    const neededIds = new Set<string>(cellTrackIds)
    const usedTemplateIds = new Set<string>()
    for (const tid of cellTrackIds) {
      const tr = st.session.tracks.find((t) => t.id === tid)
      if (!tr) continue
      if (tr.parentTrackId) neededIds.add(tr.parentTrackId)
      if (tr.sourceTemplateId) usedTemplateIds.add(tr.sourceTemplateId)
    }
    for (const id of neededIds) {
      const tr = st.session.tracks.find((t) => t.id === id)
      if (tr?.sourceTemplateId) usedTemplateIds.add(tr.sourceTemplateId)
    }
    const usedTracks: Track[] = st.session.tracks.filter((t) => neededIds.has(t.id))
    const usedTemplates: InstrumentTemplate[] = []
    usedTemplateIds.forEach((tplId) => {
      const tpl = st.session.pool.templates.find((t) => t.id === tplId)
      if (tpl) usedTemplates.push(tpl)
    })
    const savedSceneCells: Record<string, Cell> = {}
    for (const tid of cellTrackIds) {
      if (scene.cells[tid]) savedSceneCells[tid] = scene.cells[tid]
    }
    const next: import('@shared/types').SavedScene = {
      ...cur,
      // Header travels with the live scene so the Pool entry stays
      // in sync with whatever the user renamed / re-coloured in the
      // grid since the original save.
      name: scene.name || cur.name,
      color: scene.color,
      templates: usedTemplates,
      tracks: usedTracks,
      cells: savedSceneCells,
      sceneMeta: {
        name: scene.name,
        color: scene.color,
        notes: scene.notes,
        durationSec: scene.durationSec,
        nextMode: scene.nextMode,
        multiplicator: scene.multiplicator,
        morphInMs: scene.morphInMs
      }
    }
    set({ sceneLibrary: st.sceneLibrary.map((s) => (s.id === savedSceneId ? next : s)) })
    try {
      await window.api?.sceneLibrarySave?.(next)
      return true
    } catch (e) {
      console.error('[updateSavedSceneFromGrid] failed:', (e as Error).message)
      return false
    }
  },
  updateSavedScene: async (id, patch) => {
    const st = get()
    const cur = st.sceneLibrary.find((s) => s.id === id)
    if (!cur) return
    // Top-level overrides for name + color travel separately from
    // the sceneMeta payload because instantiation reads them from
    // both locations (top-level for the row display; sceneMeta for
    // the instantiated Scene's defaults). Keep them in sync.
    const nextName = patch.name ?? cur.name
    const nextColor = patch.color ?? cur.color
    const nextMeta = {
      ...cur.sceneMeta,
      ...patch,
      name: nextName,
      color: nextColor
    }
    const next: import('@shared/types').SavedScene = {
      ...cur,
      name: nextName,
      color: nextColor,
      sceneMeta: nextMeta
    }
    // Optimistic local update so the UI reflects the change before
    // the IPC round-trip resolves — main will push the same scene
    // back via `scene-library:changed`, which is idempotent.
    set({ sceneLibrary: st.sceneLibrary.map((s) => (s.id === id ? next : s)) })
    try {
      await window.api?.sceneLibrarySave?.(next)
    } catch (e) {
      console.error('[updateSavedScene] failed:', (e as Error).message)
    }
  },

  removeSavedScene: async (id) => {
    // Cancel any pending debounced library write for this id BEFORE the
    // delete — otherwise a debounced save armed by a name/notes/duration
    // edit within the last 400ms would fire after sceneLibraryRemove and
    // rewrite the just-deleted file to disk (resurrecting it on next load).
    const pending = savedSceneSaveTimers.get(id)
    if (pending) {
      clearTimeout(pending)
      savedSceneSaveTimers.delete(id)
    }
    try {
      await window.api?.sceneLibraryRemove?.(id)
    } catch (e) {
      console.error('[removeSavedScene] failed:', (e as Error).message)
    }
  },

  instantiateSavedScene: (savedSceneId, insertAtIndex) => {
    const st = get()
    const saved = st.sceneLibrary.find((s) => s.id === savedSceneId)
    if (!saved) return null
    // Map oldTrackId → newTrackId so the cells map can be rewritten
    // to the freshly-created sidebar rows.
    const trackIdMap = new Map<string, string>()
    const newTracks: Track[] = []
    // Walk the saved tracks in their original order so Template
    // (header) rows land before their Function (child) rows — the
    // sidebar relies on that order to render the hierarchy.
    for (const oldTrack of saved.tracks) {
      // If a track with the same sourceTemplateId + sourceFunctionId
      // (or same sourceTemplateId for a Template row) already exists
      // in the sidebar, reuse it instead of creating a duplicate.
      // Keeps "drag the same saved scene twice" idempotent.
      const reusable = st.session.tracks.find((t) => {
        if (oldTrack.kind === 'template') {
          return t.kind === 'template' && t.sourceTemplateId === oldTrack.sourceTemplateId
        }
        return (
          t.kind === 'function' &&
          t.sourceTemplateId === oldTrack.sourceTemplateId &&
          t.sourceFunctionId === oldTrack.sourceFunctionId
        )
      })
      if (reusable) {
        trackIdMap.set(oldTrack.id, reusable.id)
        continue
      }
      // Fresh sidebar row, new id, parentTrackId remapped via the
      // map (which by now contains the parent's new id since we
      // walked templates first).
      const newId = `t_${Math.random().toString(36).slice(2, 9)}`
      trackIdMap.set(oldTrack.id, newId)
      const cloned: Track = {
        ...oldTrack,
        id: newId,
        parentTrackId: oldTrack.parentTrackId
          ? trackIdMap.get(oldTrack.parentTrackId) ?? undefined
          : undefined
      }
      newTracks.push(cloned)
    }
    // Pool templates: copy any that aren't already in this session
    // (by id). Existing entries with the same id win — we don't
    // overwrite the user's local Pool edits.
    const newPoolTemplates: InstrumentTemplate[] = []
    for (const tpl of saved.templates) {
      if (!st.session.pool.templates.find((t) => t.id === tpl.id)) {
        newPoolTemplates.push(tpl)
      }
    }
    // Rebuild the cells map with new track ids.
    const newCells: Record<string, Cell> = {}
    for (const [oldTid, cell] of Object.entries(saved.cells)) {
      const newTid = trackIdMap.get(oldTid)
      if (!newTid) continue
      newCells[newTid] = { ...cell }
    }
    // (#17) Collision-guarded fixed-length id instead of a raw random.
    const newSceneId = makeSceneId(st.session.scenes.map((s) => s.id))
    const newScene: Scene = {
      id: newSceneId,
      name: saved.sceneMeta.name,
      color: saved.sceneMeta.color,
      notes: saved.sceneMeta.notes ?? '',
      durationSec: saved.sceneMeta.durationSec,
      nextMode: saved.sceneMeta.nextMode,
      multiplicator: saved.sceneMeta.multiplicator,
      morphInMs: saved.sceneMeta.morphInMs,
      cells: newCells,
      // Link the new live scene back to the SavedScene it came from
      // so later edits (color / name / notes) on the grid scene
      // mirror to the Pool entry. Same link is used by saveSceneToLibrary
      // when the user saves a scene that came from the Pool — the
      // existing entry updates in place instead of creating a duplicate.
      linkedSavedSceneId: savedSceneId
    }
    // Mark this scene as coming from the library so App.tsx's
    // auto-save effect doesn't create a duplicate library entry
    // when it sees session.scenes grow. See `sceneIdsFromLibrary`.
    sceneIdsFromLibrary.add(newSceneId)
    set((s) => {
      // Compute the spliced `scenes` array. When the caller passed an
      // explicit `insertAtIndex`, clamp it to [0, length] and splice
      // the new scene in at that spot; otherwise append. The drop-on-
      // grid handler uses this to drop a scene between two existing
      // columns (the column's bounding-rect midpoint decides the
      // index).
      let nextScenes: Scene[]
      if (typeof insertAtIndex === 'number' && Number.isFinite(insertAtIndex)) {
        const idx = Math.max(0, Math.min(s.session.scenes.length, Math.floor(insertAtIndex)))
        nextScenes = s.session.scenes.slice()
        nextScenes.splice(idx, 0, newScene)
      } else {
        nextScenes = [...s.session.scenes, newScene]
      }
      return {
      session: {
        ...s.session,
        tracks: [...s.session.tracks, ...newTracks],
        scenes: nextScenes,
        pool: {
          ...s.session.pool,
          templates: [...s.session.pool.templates, ...newPoolTemplates]
        },
        // Focus the freshly-instantiated scene so the inspector
        // lands on it without callers having to remember a follow-
        // up `setFocusedScene`. Not all entry points did (Use button
        // did, drag-drop didn't), so the user had to click again
        // to inspect the new column.
        focusedSceneId: newSceneId
      },
      selectedSceneIds: [newSceneId],
      // Same selection-mutex rule as setFocusedScene — landing a
      // saved scene clears any active Pool selection.
      poolSelection: null,
      selectedSavedSceneIds: []
      }
    })
    return newSceneId
  },

  duplicateScene: (sceneId) => {
    const st = get()
    const scene = st.session.scenes.find((s) => s.id === sceneId)
    if (!scene) return null
    // (#17) Collision-guarded fixed-length id instead of a raw random.
    const newSceneId = makeSceneId(st.session.scenes.map((s) => s.id))
    // Clone cells one-by-one so a future field addition to Cell
    // doesn't accidentally skip a slot. Track ids stay the same —
    // duplicating a scene doesn't add sidebar rows.
    const newCells: Record<string, Cell> = {}
    for (const [tid, cell] of Object.entries(scene.cells)) {
      newCells[tid] = { ...cell }
    }
    const existingNames = st.session.scenes.map((s) => s.name)
    const newScene: Scene = {
      ...scene,
      id: newSceneId,
      name: uniqueCopyName(scene.name, existingNames),
      cells: newCells,
      // (#14) The `{...scene}` spread carries linkedSavedSceneId +
      // midiTrigger. Left intact, renaming the copy mirrors over the
      // SOURCE's Pool library entry (via updateScene) and both scenes
      // answer the same MIDI trigger. Sever both on the copy.
      linkedSavedSceneId: undefined,
      midiTrigger: undefined
    }
    // (FEATURE A) Insert the duplicate directly AFTER the source scene
    // (same splice pattern captureSceneStateAsNew uses) rather than
    // appending — the copy lands adjacent for immediate compare /
    // re-trigger instead of scrolling off the end on long sessions.
    set((s) => {
      const srcIdx = s.session.scenes.findIndex((x) => x.id === sceneId)
      const insertAt = srcIdx < 0 ? s.session.scenes.length : srcIdx + 1
      const next = s.session.scenes.slice()
      next.splice(insertAt, 0, newScene)
      return { session: { ...s.session, scenes: next } }
    })
    return newSceneId
  },

  // (v0.5.12) Like duplicateScene, but overwrites each cell's `value`
  // with the engine's currently-emitted live string for that scene+track.
  // The live string already reflects:
  //   • the source scene's cell.value (base)
  //   • sequencer step / modulator output
  //   • per-arg pins
  //   • Hardware Mode catch overrides (the controller's live values)
  // So the resulting new scene is a SNAPSHOT of what's coming out of
  // the engine at this instant — perfect for "tweak with the controller,
  // save the result" workflow without re-capturing OSC manually.
  //
  // When the source scene is NOT the currently-active scene, the engine
  // has no live values for it; fall back to copying the original cell
  // values (same as duplicateScene). The new scene name is suffixed
  // with " (capture)" instead of " (copy)" so the user can tell at a
  // glance which entries came from a live capture vs a plain dup.
  captureSceneStateAsNew: (sceneId) => {
    const st = get()
    const scene = st.session.scenes.find((s) => s.id === sceneId)
    if (!scene) return null
    const liveRow = st.engine.currentValueBySceneAndTrack[sceneId] ?? {}
    // (#17) Collision-guarded fixed-length id instead of a raw random.
    const newSceneId = makeSceneId(st.session.scenes.map((s) => s.id))
    const newCells: Record<string, Cell> = {}
    for (const [tid, cell] of Object.entries(scene.cells)) {
      const liveStr = liveRow[tid]
      // Only overwrite when the live string is non-empty AND looks like
      // a token list (the engine's recordLiveValue produces a space-
      // separated number string; defensive guard against any future
      // change that might put a status string here).
      const useLive =
        typeof liveStr === 'string' && liveStr.length > 0
      newCells[tid] = useLive ? { ...cell, value: liveStr } : { ...cell }
    }
    const existingNames = st.session.scenes.map((s) => s.name)
    const baseName = `${scene.name} (capture)`
    const newScene: Scene = {
      ...scene,
      id: newSceneId,
      name: uniqueCopyName(baseName, existingNames),
      cells: newCells,
      // (#14) Sever the source's Pool link + MIDI trigger so the
      // capture doesn't mirror over the source's library entry or
      // double-answer its trigger.
      linkedSavedSceneId: undefined,
      midiTrigger: undefined
    }
    // (v0.5.12) Insert the new scene directly AFTER the source scene
    // in the grid, not at the end. Workflow rationale: the user
    // captures while looking at the source; they expect the result to
    // appear adjacent for immediate compare / re-trigger. Appending to
    // the end would scroll-off-screen on long sessions and break the
    // visual association. (FEATURE A) duplicateScene now does the same
    // — both actions insert directly after the source.
    set((s) => {
      const srcIdx = s.session.scenes.findIndex((x) => x.id === sceneId)
      const insertAt = srcIdx < 0 ? s.session.scenes.length : srcIdx + 1
      const next = s.session.scenes.slice()
      next.splice(insertAt, 0, newScene)
      return { session: { ...s.session, scenes: next } }
    })
    return newSceneId
  },

  // (v0.5.14) In-place sibling of captureSceneStateAsNew: stamp the
  // engine's currently-emitted values (HW Mode overrides, sequencer
  // steps, modulator output, pins — everything live) into THIS scene's
  // cells instead of cloning a new scene. Only the active scene has
  // live rows in currentValueBySceneAndTrack, so this is a no-op for
  // inactive scenes by construction. Unchanged cells keep their object
  // identity; the scenes array is rebuilt immutably so the global undo
  // subscriber snapshots the change.
  updateSceneToCurrent: (sceneId) => {
    const st = get()
    const scene = st.session.scenes.find((s) => s.id === sceneId)
    if (!scene) return false
    const liveRow = st.engine.currentValueBySceneAndTrack[sceneId]
    if (!liveRow) return false
    let changed = false
    const cells: Record<string, Cell> = {}
    for (const [tid, cell] of Object.entries(scene.cells)) {
      const liveStr = liveRow[tid]
      if (typeof liveStr === 'string' && liveStr.length > 0 && liveStr !== cell.value) {
        cells[tid] = { ...cell, value: liveStr }
        changed = true
      } else {
        cells[tid] = cell
      }
    }
    if (!changed) return false
    set((s) => ({
      session: {
        ...s.session,
        scenes: s.session.scenes.map((x) => (x.id === sceneId ? { ...x, cells } : x))
      }
    }))
    // Cell-value writes don't trip updateScene's Pool mirror (it only
    // mirrors header fields like name/color), so refresh the linked
    // library entry explicitly — otherwise the saved scene in the Pool
    // would silently go stale relative to the grid.
    if (scene.linkedSavedSceneId) {
      void get().updateSavedSceneFromGrid(scene.linkedSavedSceneId)
    }
    return true
  },

  setEngineState: (s) => set({ engine: s })
}))

// Build an `argSpec` array for a multi-arg paramType derived from a
// Network-discovered device. Single-arg types (bool/int/float/string)
// don't need an argSpec — the cell editor renders a single input from
// the function's top-level min/max/init. Multi-arg types do: each
// slot becomes one labelled input in the cell editor's split strip.
function buildArgSpecForParamType(
  paramType: import('@shared/types').FunctionParamType,
  argTypes: string[]
): import('@shared/types').ParamArgSpec[] | null {
  // Map a discovered OSC type tag to the argSpec's `type` enum.
  // Anything we can't classify falls to 'float' — matches the
  // paramType inference helper's convention.
  function tag2type(t: string): 'float' | 'int' | 'bool' | 'string' {
    if (t === 'T' || t === 'F') return 'bool'
    if (t === 'i') return 'int'
    if (t === 's') return 'string'
    return 'float'
  }
  // Canonical slot names per vector kind. 'v2' → x/y, 'v3' → x/y/z,
  // 'v4' → x/y/z/w, 'colour' → r/g/b/a (or r/g/b for 3-arg colour,
  // though the paramType union doesn't distinguish).
  let names: string[] | null = null
  let defaultMax = 1
  switch (paramType) {
    case 'v2':
      names = ['x', 'y']
      break
    case 'v3':
      names = ['x', 'y', 'z']
      break
    case 'v4':
      names = ['x', 'y', 'z', 'w']
      break
    case 'colour':
      // Most OSC colour senders emit 4 bytes (RGBA) in 0..255. We
      // default max=255; the user can clamp later from the inspector.
      names = ['r', 'g', 'b', 'a']
      defaultMax = 255
      break
    default:
      return null
  }
  return names.map((name, i) => ({
    name,
    type: tag2type(argTypes[i] ?? 'f'),
    min: 0,
    max: defaultMax,
    init: 0
  }))
}

// Deterministic colour per template id — keeps the sidebar tint stable
// across drag-from-network actions instead of strobing on every re-add.
function pickAutoColor(seed: string): string {
  // Tiny hash → hue. Saturation + lightness fixed for a coherent
  // palette; matches the vibe of randomSceneColor() without pulling
  // it in (and without the side-effect of randomness in tests).
  let h = 0
  for (let i = 0; i < seed.length; i++) {
    h = (h * 31 + seed.charCodeAt(i)) >>> 0
  }
  const hue = h % 360
  return hslToHex(hue, 62, 56)
}

function hslToHex(h: number, s: number, l: number): string {
  s /= 100
  l /= 100
  const k = (n: number): number => (n + h / 30) % 12
  const a = s * Math.min(l, 1 - l)
  const f = (n: number): number =>
    l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)))
  const r = Math.round(f(0) * 255)
  const g = Math.round(f(8) * 255)
  const b = Math.round(f(4) * 255)
  const hex = (v: number): string => v.toString(16).padStart(2, '0')
  return `#${hex(r)}${hex(g)}${hex(b)}`
}

// Persist clipTemplates whenever they change. Referential check skips writes
// from unrelated state updates (engine ticks etc) — the templates array is
// always replaced when modified, so identity-equality is a reliable signal.
let lastTemplates: ClipTemplate[] = useStore.getState().clipTemplates
let lastUiScale: number = useStore.getState().uiScale
let lastTopBarScale: number = useStore.getState().topBarScale
useStore.subscribe((state) => {
  if (state.clipTemplates !== lastTemplates) {
    lastTemplates = state.clipTemplates
    saveTemplates(state.clipTemplates)
  }
  if (state.uiScale !== lastUiScale) {
    lastUiScale = state.uiScale
    saveUiScale(state.uiScale)
  }
  if (state.topBarScale !== lastTopBarScale) {
    lastTopBarScale = state.topBarScale
    saveTopBarScale(state.topBarScale)
  }
})

function clampInt(v: number, lo: number, hi: number): number {
  const n = Math.round(v)
  return n < lo ? lo : n > hi ? hi : n
}

// Resolve the right destIp / destPort / oscAddress for a freshly-
// created cell on `track`. Track-level defaults (set when a Pool
// Template instantiates) win over session defaults — so dropping an
// OCTOCOSME Instrument and then adding clips on its child Parameters
// inherits each Parameter's `/A/strips/pots` etc. without forcing
// the user to retype them on every cell.
//
// `linked` flags indicate "this cell tracks the SESSION default";
// they're false when we sourced from track defaults so a future
// session-default change doesn't silently rewrite this cell.
function resolveCellDefaults(
  session: Session,
  track: Track | undefined
): {
  destIp: string
  destPort: number
  oscAddress: string
  destLinked: boolean
  addressLinked: boolean
} {
  const trackIp = track?.defaultDestIp
  const trackPort = track?.defaultDestPort
  const trackAddr = track?.defaultOscAddress
  const trackHasIp = trackIp != null && trackIp !== ''
  const trackHasPort = trackPort != null && trackPort > 0
  const trackHasAddr = trackAddr != null && trackAddr !== ''
  // destLinkedToDefault covers ip+port together (matches the
  // existing freeze-on-change behavior in setDefaults). If the
  // track overrides EITHER, treat the cell as decoupled from the
  // session dest default.
  const trackHasDest = trackHasIp || trackHasPort
  return {
    destIp: trackHasIp ? (trackIp as string) : session.defaultDestIp,
    destPort: trackHasPort ? (trackPort as number) : session.defaultDestPort,
    oscAddress: trackHasAddr ? (trackAddr as string) : session.defaultOscAddress,
    destLinked: !trackHasDest,
    addressLinked: !trackHasAddr
  }
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
    // Global MIDI output — default true on legacy sessions so users
    // with new MIDI cells "just work" after upgrading. They can flip
    // it off from the prefs sub-toolbar if they don't want it.
    midiEnabled:
      typeof (s as Partial<Session>).midiEnabled === 'boolean'
        ? (s as Partial<Session>).midiEnabled!
        : true,
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
        midiTrigger: sanitizeMidiBinding(t.midiTrigger),
        // Parameter-row MIDI default. Optional; cells inherit it
        // at ensureCell-time. Legacy sessions have nothing here.
        midiOut: sanitizeMidiOut(
          (t as Partial<Track>).midiOut as import('@shared/types').MidiOut | undefined
        ),
        // Parameter-row OSC emission toggle. Default true — legacy
        // sessions keep firing. When false the engine skips OSC for
        // every cell on this track.
        oscEnabled:
          typeof (t as Partial<Track>).oscEnabled === 'boolean'
            ? (t as Partial<Track>).oscEnabled
            : true,
        // argSpec is initialized from the saved track if present.
        // A second pass below re-resolves it against the FINAL
        // (builtin-merged) pool so older OCTOCOSME rows pick up the
        // new schema without manual re-instantiation.
        argSpec: Array.isArray((t as Partial<Track>).argSpec)
          ? ((t as Partial<Track>).argSpec!
              .map((a) => sanitizeArgSpec(a))
              .filter((a): a is import('@shared/types').ParamArgSpec => a !== null))
          : undefined,
        enabled:
          typeof (t as Partial<Track>).enabled === 'boolean'
            ? (t as Partial<Track>).enabled
            : undefined,
        persistentSlots: Array.isArray((t as Partial<Track>).persistentSlots)
          ? (t as Partial<Track>).persistentSlots!.map((b) => b === true)
          : undefined,
        persistentValues: Array.isArray((t as Partial<Track>).persistentValues)
          ? (t as Partial<Track>).persistentValues!.map((v) =>
              typeof v === 'string' ? v : ''
            )
          : undefined
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
      // Generative weight — clamp & default for v0.5.10. v0.5.9 sessions
      // arrive with weight === undefined; treat that as the default.
      weight:
        typeof sc.weight === 'number' && Number.isFinite(sc.weight)
          ? Math.max(SCENE_WEIGHT_MIN, Math.min(SCENE_WEIGHT_MAX, sc.weight))
          : SCENE_WEIGHT_DEFAULT,
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
            // Soft-migrate sequencer for sessions saved before any of the
            // per-mode fields existed. Centralised in a helper to keep
            // adding new modes from blowing up this block.
            sequencer: migrateSequencer(c.sequencer),
            // (v0.6.x) Motion Loop capture — shape-validated so a
            // malformed buffer can't crash the engine sampler.
            recordedLoop: sanitizeRecordedLoop(
              (c as Partial<Cell>).recordedLoop
            ),
            scaleToUnit: typeof c.scaleToUnit === 'boolean' ? c.scaleToUnit : false,
            // OSC emission — default true so legacy cells keep firing.
            oscEnabled:
              typeof (c as Partial<Cell>).oscEnabled === 'boolean'
                ? (c as Partial<Cell>).oscEnabled
                : true,
            // MIDI output — backfill missing fields on legacy cells so
            // the engine + Inspector can read them unconditionally.
            // Default `enabled: false` keeps existing cells silent on
            // MIDI until the user explicitly opts in.
            midiOut: sanitizeMidiOut(
              (c as Partial<Cell>).midiOut as import('@shared/types').MidiOut | undefined
            ),
            velocity:
              typeof (c as Partial<Cell>).velocity === 'string'
                ? (c as Partial<Cell>).velocity
                : '100',
            velocityPersistent:
              typeof (c as Partial<Cell>).velocityPersistent === 'boolean'
                ? (c as Partial<Cell>).velocityPersistent
                : false,
            notePersistent:
              typeof (c as Partial<Cell>).notePersistent === 'boolean'
                ? (c as Partial<Cell>).notePersistent
                : false,
            midiScale:
              typeof (c as Partial<Cell>).midiScale === 'boolean'
                ? (c as Partial<Cell>).midiScale
                : false,
            // Pre-MIDI sessions had no Timing-collapse concept; the
            // delay + transition fields were always live. Migrate
            // legacy cells with `timingEnabled: true` when they have
            // non-zero values (preserves intent), `false` otherwise.
            timingEnabled:
              typeof (c as Partial<Cell>).timingEnabled === 'boolean'
                ? (c as Partial<Cell>).timingEnabled
                : (c.delayMs ?? 0) > 0 || (c.transitionMs ?? 0) > 0,
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
                    : DEFAULT_RAMP.totalMs,
                mode: (() => {
                  const raw = (m?.ramp as Partial<typeof DEFAULT_RAMP> | undefined)
                    ?.mode
                  return raw === 'inverted' || raw === 'loop' || raw === 'from'
                    ? raw
                    : 'normal'
                })(),
                // 'from' mode endpoints — round-trip these or the user's
                // From/To values get laundered to the defaults on every
                // load→save cycle. Default 0 / 1 (which makes 'from'
                // behave like 'normal' until the user edits them).
                fromValue:
                  typeof (m?.ramp as Partial<typeof DEFAULT_RAMP> | undefined)?.fromValue === 'number'
                    ? (m!.ramp as RampParams).fromValue
                    : DEFAULT_RAMP.fromValue,
                toValue:
                  typeof (m?.ramp as Partial<typeof DEFAULT_RAMP> | undefined)?.toValue === 'number'
                    ? (m!.ramp as RampParams).toValue
                    : DEFAULT_RAMP.toValue
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
                  DEFAULT_RANDOM.max,
                // distribution skew (Buchla 266 style) — optional; MUST
                // round-trip or the user's edge/centre warp reverts to
                // uniform on every load.
                ...(typeof (m?.random as Partial<typeof DEFAULT_RANDOM> | undefined)
                  ?.distribution === 'number' &&
                Number.isFinite(
                  (m!.random as RandomParams).distribution as number
                )
                  ? {
                      distribution: Math.max(
                        0,
                        Math.min(1, (m!.random as RandomParams).distribution as number)
                      )
                    }
                  : {})
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
                    : DEFAULT_SH.probability,
                // distribution skew — same round-trip fix as random above.
                ...(typeof (m?.sh as Partial<typeof DEFAULT_SH> | undefined)
                  ?.distribution === 'number' &&
                Number.isFinite(
                  (m!.sh as SampleHoldParams).distribution as number
                )
                  ? {
                      distribution: Math.max(
                        0,
                        Math.min(1, (m!.sh as SampleHoldParams).distribution as number)
                      )
                    }
                  : {})
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
              },
              // Strange Attractor (v0.5.7) — this reconstruction previously
              // omitted `attractor` entirely, so type/speed/chaos reverted
              // to canonical Lorenz on every load. Round-trip them.
              attractor: {
                type:
                  (m?.attractor as Partial<typeof DEFAULT_ATTRACTOR> | undefined)
                    ?.type ?? DEFAULT_ATTRACTOR.type,
                speed:
                  typeof (m?.attractor as Partial<typeof DEFAULT_ATTRACTOR> | undefined)
                    ?.speed === 'number' &&
                  Number.isFinite((m!.attractor as AttractorParams).speed)
                    ? (m!.attractor as AttractorParams).speed
                    : DEFAULT_ATTRACTOR.speed,
                chaos:
                  typeof (m?.attractor as Partial<typeof DEFAULT_ATTRACTOR> | undefined)
                    ?.chaos === 'number' &&
                  Number.isFinite((m!.attractor as AttractorParams).chaos)
                    ? (m!.attractor as AttractorParams).chaos
                    : DEFAULT_ATTRACTOR.chaos
              },
              // Gesture (v0.5.8) — CRITICAL: the recorded polyline lived
              // here and was being DESTROYED on every load (points -> [],
              // so the engine emitted a dead flat 0.5). Round-trip the
              // recording + play settings. Points are validated per-entry
              // ({t,x,y} finite) so a hand-edited file can't inject NaN.
              gesture: {
                points: Array.isArray(
                  (m?.gesture as Partial<typeof DEFAULT_GESTURE> | undefined)?.points
                )
                  ? ((m!.gesture as GestureParams).points as unknown[])
                      .filter(
                        (p): p is { t: number; x: number; y: number } =>
                          !!p &&
                          typeof p === 'object' &&
                          Number.isFinite((p as { t?: unknown }).t) &&
                          Number.isFinite((p as { x?: unknown }).x) &&
                          Number.isFinite((p as { y?: unknown }).y)
                      )
                      .map((p) => ({ t: p.t, x: p.x, y: p.y }))
                  : [...DEFAULT_GESTURE.points],
                mode:
                  (m?.gesture as Partial<typeof DEFAULT_GESTURE> | undefined)?.mode ??
                  DEFAULT_GESTURE.mode,
                wiggle:
                  typeof (m?.gesture as Partial<typeof DEFAULT_GESTURE> | undefined)
                    ?.wiggle === 'number' &&
                  Number.isFinite((m!.gesture as GestureParams).wiggle)
                    ? (m!.gesture as GestureParams).wiggle
                    : DEFAULT_GESTURE.wiggle,
                playMode:
                  (m?.gesture as Partial<typeof DEFAULT_GESTURE> | undefined)
                    ?.playMode ?? DEFAULT_GESTURE.playMode
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
    metaController: sanitizeMetaController(s.metaController),
    // OSC forward targets — new in v0.5, defaults to empty list. Sanitize
    // each entry so a hand-edited session file with garbage values doesn't
    // crash the main-process listener.
    forwardTargets: sanitizeForwardTargets(s.forwardTargets),
    // Generative Scene Sequencer (v0.5.10). Sanitize every field
    // independently so a hand-edited or partially-malformed session
    // can't introduce NaN ranges, out-of-bounds affinity, or
    // unrecognized mode strings into the engine. Missing entirely =>
    // seed from DEFAULT_GENERATIVE_CONFIG so older sessions load
    // with the feature disabled (no behaviour change).
    generative: sanitizeGenerativeConfig(s.generative),
    // Listener port (v0.5.10). Persisted on the session so reopen
    // re-binds automatically. Sanitize to a legal UDP port range; if
    // a hand-edited file has an out-of-range value, drop it back to
    // undefined and the renderer's localStorage fallback kicks in.
    listenerPort:
      typeof s.listenerPort === 'number' &&
      Number.isFinite(s.listenerPort) &&
      s.listenerPort >= 0 &&
      s.listenerPort <= 65535
        ? Math.round(s.listenerPort)
        : undefined
  }
}

// Sanitize the Generative Scene Sequencer config (v0.5.10). Pure
// function. Accepts unknown JSON shape and produces a fully-typed
// GenerativeConfig with every field clamped to its legal range.
// Unknown / missing fields fall back to DEFAULT_GENERATIVE_CONFIG.
// MIDI bindings go through sanitizeMidiBinding so a malformed
// channel / number can't crash midi.ts at session load.
function sanitizeGenerativeConfig(raw: unknown): GenerativeConfig {
  if (!raw || typeof raw !== 'object') return { ...DEFAULT_GENERATIVE_CONFIG }
  const r = raw as Partial<GenerativeConfig>
  const validModes: GenerativeMode[] = [
    'random',
    'drift',
    'surprise',
    'shuffle',
    'custom'
  ]
  const validSources: GenerativePoolSource[] = ['all', 'timeline']
  const clampDuration = (n: unknown): number => {
    if (typeof n !== 'number' || !Number.isFinite(n))
      return DEFAULT_GENERATIVE_CONFIG.minDurationMs
    return Math.max(
      GENERATIVE_DURATION_MIN_MS,
      Math.min(GENERATIVE_DURATION_MAX_MS, Math.round(n))
    )
  }
  // Excluded map — keep only string keys with true values. Anything
  // else gets dropped (sparse-by-design).
  const rawExcluded = (r.excluded ?? {}) as Record<string, unknown>
  const excluded: Record<string, boolean> = {}
  for (const k of Object.keys(rawExcluded)) {
    if (rawExcluded[k] === true) excluded[k] = true
  }
  const minMs = clampDuration(r.minDurationMs)
  let maxMs = clampDuration(r.maxDurationMs ?? DEFAULT_GENERATIVE_CONFIG.maxDurationMs)
  if (maxMs < minMs) maxMs = minMs
  return {
    enabled: r.enabled === true,
    poolSource:
      typeof r.poolSource === 'string' && validSources.includes(r.poolSource)
        ? r.poolSource
        : DEFAULT_GENERATIVE_CONFIG.poolSource,
    excluded,
    mode:
      typeof r.mode === 'string' && validModes.includes(r.mode)
        ? r.mode
        : DEFAULT_GENERATIVE_CONFIG.mode,
    affinity:
      typeof r.affinity === 'number' && Number.isFinite(r.affinity)
        ? Math.max(GENERATIVE_AFFINITY_MIN, Math.min(GENERATIVE_AFFINITY_MAX, r.affinity))
        : DEFAULT_GENERATIVE_CONFIG.affinity,
    noRepeat:
      typeof r.noRepeat === 'boolean'
        ? r.noRepeat
        : DEFAULT_GENERATIVE_CONFIG.noRepeat,
    shuffleCycle:
      typeof r.shuffleCycle === 'boolean'
        ? r.shuffleCycle
        : DEFAULT_GENERATIVE_CONFIG.shuffleCycle,
    minDurationMs: minMs,
    maxDurationMs: maxMs,
    useMorph:
      typeof r.useMorph === 'boolean'
        ? r.useMorph
        : DEFAULT_GENERATIVE_CONFIG.useMorph,
    toggleMidi: sanitizeMidiBinding(r.toggleMidi),
    noRepeatMidi: sanitizeMidiBinding(r.noRepeatMidi),
    affinityMidi: sanitizeMidiBinding(r.affinityMidi),
    minDurationMidi: sanitizeMidiBinding(r.minDurationMidi),
    maxDurationMidi: sanitizeMidiBinding(r.maxDurationMidi),
    useMorphMidi: sanitizeMidiBinding(r.useMorphMidi),
    randomWeightsMidi: sanitizeMidiBinding(r.randomWeightsMidi)
  }
}

// Sanitize a forward-targets array — drops entries with missing/empty
// IP, out-of-range port, or missing id. Falls back to [] for anything
// non-array. Pure function, called from session migration.
function sanitizeForwardTargets(raw: unknown): OscForwardTarget[] {
  if (!Array.isArray(raw)) return []
  const out: OscForwardTarget[] = []
  for (const r of raw) {
    if (!r || typeof r !== 'object') continue
    const rr = r as Record<string, unknown>
    const id = typeof rr.id === 'string' && rr.id.length > 0 ? rr.id : null
    const ip = typeof rr.ip === 'string' ? rr.ip.trim() : ''
    const port = Number.isFinite(rr.port) ? Math.floor(rr.port as number) : 0
    if (!id || ip.length === 0 || port < 1 || port > 65535) continue
    out.push({
      id,
      enabled: !!rr.enabled,
      label: typeof rr.label === 'string' ? rr.label : undefined,
      ip,
      port
    })
  }
  return out
}

// Second pass — once the pool has been merged with the builtin
// library (sanitizePool), walk every track and re-resolve its
// argSpec against the final pool. Tracks that already had a saved
// argSpec keep theirs (user data wins); tracks instantiated before
// argSpec existed (e.g. pre-this-commit OCTOCOSME rows) inherit the
// builtin Function's argSpec automatically.
function backfillTrackArgSpecsFromPool(s: Session): Session {
  const tracksUpdated = s.tracks.map((t) => {
    if (Array.isArray(t.argSpec) && t.argSpec.length > 0) return t
    if (!t.sourceTemplateId || !t.sourceFunctionId) return t
    const tpl = s.pool.templates.find((tt) => tt.id === t.sourceTemplateId)
    const fn = tpl?.functions.find((f) => f.id === t.sourceFunctionId)
    if (!fn?.argSpec || fn.argSpec.length === 0) return t
    return { ...t, argSpec: fn.argSpec.map((a) => ({ ...a })) }
  })
  return { ...s, tracks: tracksUpdated }
}

// (v0.5.12) Session-load migration that cleans up legacy data drift.
//
// SCOPE: template-kind cells with oscEnabled === true. The engine's
// hard invariant (engine.ts oscEmitAllowed gate) already blocks
// these from emitting at runtime regardless, but the on-disk flag
// misleadingly suggests they DO emit — confusing for anyone reading
// the JSON, grepping the file, or building tooling around it. Force
// false at load time so the data matches the semantics. Engine fix
// is the runtime defense; this is the data-cleanliness defense.
//
// NOT INCLUDED — and a CAUTIONARY TALE worth documenting because
// the candidate migration looked obviously good but was actively
// destructive:
//
//   ❌ "Strip legacy 'compositor 0 ' prefix from cell values."
//
// In v0.5.12 dev, this migration was implemented and reverted before
// shipping. The prefix LOOKS like a vestigial takeover-gate artifact
// (pre-v0.5.5 PD `[route compositor]` patterns required it), and at
// the OSC wire level the engine ignores it for `fixed`-spec slots
// (`spec.fixed` overrides the wire value at emit time). But the
// cell.value string is POSITIONALLY INDEXED against argSpec — every
// token's position in the space-separated string maps to argSpec[N]
// by index. For OCTOCOSME's /A/strips/pots, argSpec is:
//
//   [0] fixed string "compositor"   ← "structural" but indexed
//   [1] fixed int 0                  ← "structural" but indexed
//   [2] HAUTEUR1 (editable float)
//   ...
//   [13] MODB4 (editable float)
//
// Stripping tokens [0..1] shifts every editable slot by 2 — the
// Inspector then displays HAUTEUR1's UI binding showing MODA3's
// value, HAUTEUR2 shows MODA4's value, and so on. Editing through
// the Inspector writes the new value into the wrong argSpec slot,
// silently corrupting the cell. The fix for the original symptom
// (Capture mode showing alternating "compositor" / "192.168.101.191"
// senders) is instead the loopback flag on DiscoveredOscDevice, not
// touching cell.value.
//
// If you ever want to revisit this — the architecturally-correct
// path is to make cell.value carry ONLY editable-slot tokens and
// have the engine inject fixed-slot values at emit time. That's a
// data-model change touching every multi-arg consumer (Inspector,
// engine emit, capture, draw mode, MIDI mapping), not a session
// migration.
//
// The kept migration is IDEMPOTENT — re-running produces the same
// output. It only sets a flag to false; it cannot corrupt data.
function applyV0512Migrations(s: Session): Session {
  // Build a set of template-kind track ids in one pass so the per-cell
  // loop below is O(1) per cell.
  const templateTrackIds = new Set<string>()
  for (const t of s.tracks) {
    if (t.kind === 'template') templateTrackIds.add(t.id)
  }
  let templateCellsFixed = 0
  const scenes = s.scenes.map((sc) => {
    let sceneChanged = false
    const nextCells: typeof sc.cells = {}
    for (const [tid, cell] of Object.entries(sc.cells)) {
      let nextCell = cell
      if (templateTrackIds.has(tid) && nextCell.oscEnabled !== false) {
        nextCell = { ...nextCell, oscEnabled: false }
        templateCellsFixed += 1
        sceneChanged = true
      }
      nextCells[tid] = nextCell
    }
    return sceneChanged ? { ...sc, cells: nextCells } : sc
  })
  if (templateCellsFixed > 0) {
    console.info(
      `[v0.5.12 migration] template-cell oscEnabled forced false: ${templateCellsFixed}`
    )
  }
  return { ...s, scenes }
}

// Soft-migrate a saved sequencer block. Old sessions only carried steps
// + euclidean fields; this builds the full DEFAULT_SEQUENCER shape with
// each persisted field overlaid, clamped, and validated. Centralising
// keeps propagateDefaults from ballooning every time a new mode lands.
function sanitizeRecordedLoop(
  raw: unknown
): import('@shared/types').RecordedLoop | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const r = raw as Record<string, unknown>
  if (!Array.isArray(r.frames)) return undefined
  const durationMs =
    typeof r.durationMs === 'number' &&
    Number.isFinite(r.durationMs) &&
    r.durationMs > 0
      ? r.durationMs
      : 0
  if (durationMs <= 0) return undefined
  const frames: { t: number; v: number[] }[] = []
  for (const f of r.frames as unknown[]) {
    if (!f || typeof f !== 'object') continue
    const ff = f as Record<string, unknown>
    if (typeof ff.t !== 'number' || !Number.isFinite(ff.t)) continue
    if (!Array.isArray(ff.v)) continue
    const v = (ff.v as unknown[]).map((x) =>
      typeof x === 'number' && Number.isFinite(x) ? x : 0
    )
    frames.push({ t: ff.t, v })
  }
  if (frames.length === 0) return undefined
  return { enabled: r.enabled === true, durationMs, frames }
}

function migrateSequencer(raw: unknown): SequencerParams {
  const base: SequencerParams = {
    ...DEFAULT_SEQUENCER,
    stepValues: [...DEFAULT_SEQUENCER.stepValues]
  }
  if (!raw || typeof raw !== 'object') return base
  const r = raw as Partial<SequencerParams> & Record<string, unknown>

  const num = (v: unknown, def: number, lo: number, hi: number, integer = false): number => {
    if (typeof v !== 'number' || !Number.isFinite(v)) return def
    const x = integer ? Math.floor(v) : v
    return Math.max(lo, Math.min(hi, x))
  }

  // Legacy 'sync' value used the per-clip bpm slider — now 'tempo'.
  const syncMode: SeqSyncMode =
    (r.syncMode as string) === 'sync'
      ? 'tempo'
      : r.syncMode === 'free' || r.syncMode === 'tempo' || r.syncMode === 'bpm'
        ? r.syncMode
        : base.syncMode

  // Mode dispatch — be permissive on input but always emit a valid value.
  const VALID_MODES: SeqMode[] = [
    'steps',
    'euclidean',
    'polyrhythm',
    'density',
    'cellular',
    'drift',
    'ratchet',
    'bounce',
    'draw'
  ]
  const mode: SeqMode =
    typeof r.mode === 'string' && (VALID_MODES as string[]).includes(r.mode)
      ? (r.mode as SeqMode)
      : base.mode

  const combine: 'or' | 'xor' | 'and' =
    r.combine === 'xor' || r.combine === 'and' ? r.combine : 'or'
  const edge: 'wrap' | 'reflect' = r.edge === 'reflect' ? 'reflect' : 'wrap'

  const stepValues = Array.isArray(r.stepValues)
    ? r.stepValues.slice(0, 16).map((v) => (typeof v === 'string' ? v : String(v ?? '')))
    : [...base.stepValues]
  // Pad to 16 so engine indexing never goes off the end.
  while (stepValues.length < 16) stepValues.push('')

  return {
    enabled: !!r.enabled,
    steps: num(r.steps, base.steps, 1, 16, true),
    syncMode,
    // Allow up to 1024 in storage — Draw mode caps higher than other
    // sequencer modes. The UI clamps per-mode.
    bpm: num(r.bpm, base.bpm, 10, 1024, true),
    stepMs: num(r.stepMs, base.stepMs, 1, 60000, true),
    stepValues,
    mode,
    pulses: num(r.pulses, base.pulses, 0, 16, true),
    rotation: num(r.rotation, base.rotation, 0, 15, true),
    ringALength: num(r.ringALength, base.ringALength, 1, 16, true),
    ringBLength: num(r.ringBLength, base.ringBLength, 1, 16, true),
    combine,
    density: num(r.density, base.density, 0, 100),
    seed: num(r.seed, base.seed, 0, 255, true),
    rule: num(r.rule, base.rule, 0, 255, true),
    cellSeed: num(r.cellSeed, base.cellSeed, 0, 65535, true),
    bias: num(r.bias, base.bias, -100, 100),
    edge,
    ratchetProb: num(r.ratchetProb, base.ratchetProb, 0, 100),
    ratchetMaxDiv: num(r.ratchetMaxDiv, base.ratchetMaxDiv, 2, 16, true),
    ratchetVariation: num(r.ratchetVariation, base.ratchetVariation, 0, 100),
    ratchetMode:
      r.ratchetMode === 'ramp' ||
      r.ratchetMode === 'random' ||
      r.ratchetMode === 'inverse' ||
      r.ratchetMode === 'pingpong' ||
      r.ratchetMode === 'echo' ||
      r.ratchetMode === 'trill'
        ? r.ratchetMode
        : 'octaves',
    cellularSeedLfoDepth: num(
      r.cellularSeedLfoDepth,
      base.cellularSeedLfoDepth,
      0,
      100
    ),
    cellularSeedLfoRate: num(
      r.cellularSeedLfoRate,
      base.cellularSeedLfoRate,
      0.01,
      10
    ),
    bounceDecay: num(r.bounceDecay, base.bounceDecay, 0, 100),
    generative: !!r.generative,
    genAmount: num(r.genAmount, base.genAmount, 0, 100),
    restBehaviour: r.restBehaviour === 'hold' ? 'hold' : 'last',
    drawSteps: num(r.drawSteps, base.drawSteps, 4, 1024, true),
    drawValues: (() => {
      if (Array.isArray(r.drawValues)) {
        const vs = r.drawValues
          .slice(0, 1024)
          .map((v) =>
            typeof v === 'number' && Number.isFinite(v)
              ? Math.max(0, Math.min(1, v))
              : 0
          )
        while (vs.length < 1024) vs.push(0)
        return vs
      }
      return [...base.drawValues]
    })(),
    drawValueMin:
      typeof r.drawValueMin === 'number' && Number.isFinite(r.drawValueMin)
        ? r.drawValueMin
        : base.drawValueMin,
    drawValueMax:
      typeof r.drawValueMax === 'number' && Number.isFinite(r.drawValueMax)
        ? r.drawValueMax
        : base.drawValueMax
  }
}

// Shared defensive cleanup for MIDI bindings on Tracks, Scenes, and Cells.
// A binding must have kind ∈ {note, cc} and finite channel/number; anything
// else is treated as "no binding" rather than leaving a malformed object in
// state. Used in propagateDefaults to keep older / hand-edited session files
// from crashing the MIDI router.
// Sanitise a stored `MidiOut` blob from a session file — guarantees
// every field is present + in-range so the engine + Inspector can
// read them without conditional defaulting. Returns undefined when
// the input is null/undefined (the call site spreads from a default
// instead) and a fully-defaulted MidiOut when the input is malformed
// (the user keeps their port + channel choice even if other fields
// got corrupted).
function sanitizeMidiOut(
  raw: import('@shared/types').MidiOut | undefined
): import('@shared/types').MidiOut | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const r = raw as Partial<import('@shared/types').MidiOut>
  const kind = r.kind === 'note' ? 'note' : 'cc'
  return {
    enabled: r.enabled === true,
    portName: typeof r.portName === 'string' ? r.portName : '',
    channel:
      typeof r.channel === 'number' && Number.isFinite(r.channel)
        ? Math.max(1, Math.min(16, Math.floor(r.channel)))
        : 1,
    kind,
    cc:
      typeof r.cc === 'number' && Number.isFinite(r.cc)
        ? Math.max(0, Math.min(127, Math.floor(r.cc)))
        : 1,
    noteMode: r.noteMode === 'pitch' ? 'pitch' : 'velocity',
    gateLengthMs:
      typeof r.gateLengthMs === 'number' && Number.isFinite(r.gateLengthMs)
        ? Math.max(0, Math.min(60_000, Math.floor(r.gateLengthMs)))
        : 0,
    // noteMin/noteMax define the [0..1] -> note window for Note-kind
    // cells. Previously dropped here, so a custom note window reverted
    // to the engine's C2..C6 default on every save/load. Round-trip
    // them (clamped 0..127) only when present so back-compat is intact.
    ...(typeof r.noteMin === 'number' && Number.isFinite(r.noteMin)
      ? { noteMin: Math.max(0, Math.min(127, Math.floor(r.noteMin))) }
      : {}),
    ...(typeof r.noteMax === 'number' && Number.isFinite(r.noteMax)
      ? { noteMax: Math.max(0, Math.min(127, Math.floor(r.noteMax))) }
      : {})
  }
}

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

function sanitizeArgSpec(raw: unknown): import('@shared/types').ParamArgSpec | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Partial<import('@shared/types').ParamArgSpec>
  const t = r.type
  if (t !== 'float' && t !== 'int' && t !== 'bool' && t !== 'string') return null
  return {
    name: typeof r.name === 'string' ? r.name : '',
    type: t,
    fixed: r.fixed,
    min: typeof r.min === 'number' ? r.min : undefined,
    max: typeof r.max === 'number' ? r.max : undefined,
    init: r.init
  }
}

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

// Input Conditioning (v0.6) — shape-validated copy so hand-edited /
// malformed session files can't inject a broken chain. Same rationale
// as the hardwareMode block in sanitizeTemplate (v0.5.9 lesson: every
// persisted Template field must round-trip through BOTH sanitizers).
const VALID_INPUT_STAGE_TYPES = new Set([
  'oneEuro',
  'smooth',
  'median',
  'slewLimit',
  'deadband',
  'autoRange'
])
function sanitizeInputConditioner(
  raw: unknown
): InputConditionerConfig | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const r = raw as Record<string, unknown>
  const stages = (Array.isArray(r.stages) ? r.stages : [])
    .filter(
      (s): s is Record<string, unknown> =>
        !!s &&
        typeof s === 'object' &&
        typeof (s as Record<string, unknown>).type === 'string' &&
        VALID_INPUT_STAGE_TYPES.has((s as Record<string, unknown>).type as string)
    )
    .map((s, i) => ({
      id: typeof s.id === 'string' ? s.id : `istg_load_${i}`,
      type: s.type as InputConditionerConfig['stages'][number]['type'],
      enabled: s.enabled !== false,
      ...(typeof s.address === 'string' && s.address ? { address: s.address } : {}),
      // Number.isFinite (not typeof === 'number') so a hand-edited/
      // corrupt file can't smuggle NaN into a filter coefficient.
      ...(Number.isFinite(s.minCutoffHz) ? { minCutoffHz: s.minCutoffHz as number } : {}),
      ...(Number.isFinite(s.beta) ? { beta: s.beta as number } : {}),
      ...(Number.isFinite(s.halfLifeMs) ? { halfLifeMs: s.halfLifeMs as number } : {}),
      ...(Number.isFinite(s.window) ? { window: s.window as number } : {}),
      ...(Number.isFinite(s.maxPerSec) ? { maxPerSec: s.maxPerSec as number } : {}),
      ...(Number.isFinite(s.epsilon) ? { epsilon: s.epsilon as number } : {}),
      ...(Number.isFinite(s.contractHalfLifeMs)
        ? { contractHalfLifeMs: s.contractHalfLifeMs as number }
        : {})
    }))
  return {
    enabled: r.enabled === true,
    stages,
    slotBypass: Array.isArray(r.slotBypass)
      ? (r.slotBypass as unknown[]).filter(
          (x): x is number => typeof x === 'number' && Number.isInteger(x)
        )
      : []
  }
}

// State Triggers (v0.6) — same shape-validated round-trip contract.
function sanitizeStateTriggers(raw: unknown): StateTrigger[] | undefined {
  if (!Array.isArray(raw)) return undefined
  const out: StateTrigger[] = []
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue
    const r = item as Record<string, unknown>
    if (typeof r.id !== 'string' || typeof r.name !== 'string') continue
    const rules = (Array.isArray(r.rules) ? r.rules : [])
      .filter(
        (ru): ru is Record<string, unknown> =>
          !!ru &&
          typeof ru === 'object' &&
          typeof (ru as Record<string, unknown>).address === 'string' &&
          // Number.isFinite so a NaN comparison value can't slip into
          // the detector (would make every match test NaN-false).
          Number.isFinite((ru as Record<string, unknown>).a)
      )
      .map((ru, ri) => ({
        id: typeof ru.id === 'string' ? ru.id : `srule_load_${ri}`,
        address: ru.address as string,
        slot:
          typeof ru.slot === 'number' && Number.isInteger(ru.slot)
            ? (ru.slot as number)
            : 0,
        op: (ru.op === 'range' || ru.op === 'gt' || ru.op === 'lt'
          ? ru.op
          : 'eq') as StateTrigger['rules'][number]['op'],
        a: ru.a as number,
        ...(Number.isFinite(ru.b) ? { b: ru.b as number } : {}),
        ...(Number.isFinite(ru.tol) ? { tol: ru.tol as number } : {})
      }))
    const learnedRaw = r.learned as Record<string, unknown> | undefined
    let learned: StateTrigger['learned']
    if (
      learnedRaw &&
      typeof learnedRaw === 'object' &&
      Array.isArray(learnedRaw.dims) &&
      Array.isArray(learnedRaw.centroid) &&
      Array.isArray(learnedRaw.variance)
    ) {
      const dims = (learnedRaw.dims as unknown[])
        .filter(
          (d): d is Record<string, unknown> =>
            !!d &&
            typeof d === 'object' &&
            typeof (d as Record<string, unknown>).address === 'string'
        )
        .map((d) => ({
          address: d.address as string,
          slot:
            typeof d.slot === 'number' && Number.isInteger(d.slot)
              ? (d.slot as number)
              : 0,
          // enabled defaults true; only carry an explicit false so the
          // user's excluded-channel choices round-trip.
          ...(d.enabled === false ? { enabled: false } : {})
        }))
      const centroid = (learnedRaw.centroid as unknown[]).filter(
        (x): x is number => typeof x === 'number' && Number.isFinite(x)
      )
      const variance = (learnedRaw.variance as unknown[]).filter(
        (x): x is number => typeof x === 'number' && Number.isFinite(x)
      )
      // Dims / centroid / variance must be index-aligned; a truncated
      // or hand-edited mismatch invalidates the whole model.
      if (dims.length > 0 && dims.length === centroid.length && dims.length === variance.length) {
        learned = {
          dims,
          centroid,
          variance,
          threshold:
            typeof learnedRaw.threshold === 'number'
              ? Math.max(0, Math.min(1, learnedRaw.threshold))
              : 0.8,
          ...(Number.isFinite(learnedRaw.tolerance)
            ? {
                tolerance: Math.max(
                  0.01,
                  Math.min(1, learnedRaw.tolerance as number)
                )
              }
            : {})
        }
      }
    }
    const midiRaw = (r.actions as Record<string, unknown> | undefined)?.midi as
      | Record<string, unknown>
      | undefined
    out.push({
      id: r.id,
      name: r.name,
      enabled: r.enabled !== false,
      detector: r.detector === 'learned' ? 'learned' : 'rules',
      mode:
        r.mode === 'oneShot' || r.mode === 'continuous'
          ? (r.mode as StateTrigger['mode'])
          : 'enterExit',
      hysteresisPct:
        Number.isFinite(r.hysteresisPct)
          ? Math.max(0, Math.min(0.5, r.hysteresisPct as number))
          : 0.1,
      dwellMs:
        Number.isFinite(r.dwellMs) ? Math.max(0, r.dwellMs as number) : 80,
      ...(Number.isFinite(r.holdMs)
        ? { holdMs: Math.max(0, Math.min(10000, r.holdMs as number)) }
        : {}),
      rules,
      ...(learned ? { learned } : {}),
      actions: {
        ...(midiRaw && typeof midiRaw === 'object'
          ? {
              midi: {
                enabled: midiRaw.enabled !== false,
                portName:
                  typeof midiRaw.portName === 'string' ? midiRaw.portName : '',
                channel:
                  typeof midiRaw.channel === 'number'
                    ? Math.max(1, Math.min(16, Math.round(midiRaw.channel)))
                    : 1,
                kind: midiRaw.kind === 'cc' ? 'cc' : 'note',
                ...(typeof midiRaw.note === 'number' ? { note: midiRaw.note } : {}),
                ...(typeof midiRaw.velocity === 'number'
                  ? { velocity: midiRaw.velocity }
                  : {}),
                ...(typeof midiRaw.cc === 'number' ? { cc: midiRaw.cc } : {}),
                ...(typeof midiRaw.ccEnterValue === 'number'
                  ? { ccEnterValue: midiRaw.ccEnterValue }
                  : {}),
                ...(typeof midiRaw.ccExitValue === 'number'
                  ? { ccExitValue: midiRaw.ccExitValue }
                  : {})
              }
            }
          : {}),
        ...(typeof (r.actions as Record<string, unknown> | undefined)
          ?.triggerSceneId === 'string'
          ? {
              triggerSceneId: (r.actions as Record<string, unknown>)
                .triggerSceneId as string
            }
          : {})
      }
    })
  }
  return out.length > 0 ? out : undefined
}

// (v0.6.5) Shared learned-pose + MIDI-action sanitizers, reused by both
// State Triggers and Pose Sequence waypoints.
function sanitizeStateMidiAction(raw: unknown): StateMidiAction | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const m = raw as Record<string, unknown>
  return {
    enabled: m.enabled !== false,
    portName: typeof m.portName === 'string' ? m.portName : '',
    channel:
      typeof m.channel === 'number' && Number.isFinite(m.channel)
        ? Math.max(1, Math.min(16, Math.round(m.channel)))
        : 1,
    kind: m.kind === 'cc' ? 'cc' : 'note',
    ...(typeof m.note === 'number' && Number.isFinite(m.note) ? { note: m.note } : {}),
    ...(typeof m.velocity === 'number' && Number.isFinite(m.velocity)
      ? { velocity: m.velocity }
      : {}),
    ...(typeof m.cc === 'number' && Number.isFinite(m.cc) ? { cc: m.cc } : {}),
    ...(typeof m.ccEnterValue === 'number' && Number.isFinite(m.ccEnterValue)
      ? { ccEnterValue: m.ccEnterValue }
      : {}),
    ...(typeof m.ccExitValue === 'number' && Number.isFinite(m.ccExitValue)
      ? { ccExitValue: m.ccExitValue }
      : {})
  }
}

function sanitizeLearnedState(raw: unknown): LearnedState | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const L = raw as Record<string, unknown>
  if (!Array.isArray(L.dims) || !Array.isArray(L.centroid) || !Array.isArray(L.variance)) {
    return undefined
  }
  const dims = (L.dims as unknown[])
    .filter(
      (d): d is Record<string, unknown> =>
        !!d && typeof d === 'object' && typeof (d as Record<string, unknown>).address === 'string'
    )
    .map((d) => ({
      address: d.address as string,
      slot: typeof d.slot === 'number' && Number.isInteger(d.slot) ? (d.slot as number) : 0,
      ...(d.enabled === false ? { enabled: false as const } : {})
    }))
  const centroid = (L.centroid as unknown[]).map((x) =>
    typeof x === 'number' && Number.isFinite(x) ? x : 0
  )
  const variance = (L.variance as unknown[]).map((x) =>
    typeof x === 'number' && Number.isFinite(x) ? x : 0
  )
  if (dims.length === 0 || dims.length !== centroid.length || dims.length !== variance.length) {
    return undefined
  }
  return {
    dims,
    centroid,
    variance,
    threshold:
      typeof L.threshold === 'number' && Number.isFinite(L.threshold)
        ? Math.max(0, Math.min(1, L.threshold))
        : 0.6,
    ...(typeof L.tolerance === 'number' && Number.isFinite(L.tolerance)
      ? { tolerance: Math.max(0.01, Math.min(1, L.tolerance)) }
      : {})
  }
}

// (v0.6.5) Pose Sequence — an ordered list of learned poses ("waypoints"),
// each firing MIDI as the performer passes through it. Grafted onto builtins
// in sanitizePool (the v0.5.9 persistence law).
function sanitizePoseSequences(raw: unknown): PoseSequence[] | undefined {
  if (!Array.isArray(raw)) return undefined
  const out: PoseSequence[] = []
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue
    const s = item as Record<string, unknown>
    if (typeof s.id !== 'string' || typeof s.name !== 'string') continue
    const wpsRaw = Array.isArray(s.waypoints) ? s.waypoints : []
    const waypoints: PoseWaypoint[] = []
    for (const w of wpsRaw) {
      if (!w || typeof w !== 'object') continue
      const wp = w as Record<string, unknown>
      if (typeof wp.id !== 'string') continue
      const learned = sanitizeLearnedState(wp.learned)
      const midi = sanitizeStateMidiAction(wp.midi)
      waypoints.push({
        id: wp.id,
        name: typeof wp.name === 'string' ? wp.name : 'Pose',
        ...(learned ? { learned } : {}),
        ...(midi ? { midi } : {}),
        ...(typeof wp.triggerSceneId === 'string' ? { triggerSceneId: wp.triggerSceneId } : {})
      })
    }
    out.push({
      id: s.id,
      name: s.name,
      enabled: s.enabled !== false,
      loop: s.loop !== false,
      dwellMs:
        typeof s.dwellMs === 'number' && Number.isFinite(s.dwellMs)
          ? Math.max(0, s.dwellMs)
          : 80,
      ...(typeof s.recordHoldMs === 'number' && Number.isFinite(s.recordHoldMs)
        ? { recordHoldMs: Math.max(250, Math.min(30000, s.recordHoldMs)) }
        : {}),
      waypoints
    })
  }
  return out.length > 0 ? out : undefined
}

function sanitizeTemplate(raw: unknown): InstrumentTemplate | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  if (typeof r.id !== 'string' || typeof r.name !== 'string') return null
  const fns = (Array.isArray(r.functions) ? r.functions : [])
    .map((f, i) => sanitizeFunction(f, i))
    .filter((f): f is InstrumentFunction => f !== null)
  // Carry over hardwareMode if the saved entry has one — without
  // this, sanitizePool sees a stripped saved entry whose hardwareMode
  // is undefined and the user's saved Hardware Mode config gets lost
  // every load. Light shape check + light field-by-field copy so
  // hand-edited / malformed files can't inject a broken blob.
  const hwRaw = r.hardwareMode as Record<string, unknown> | undefined
  let hardwareMode: InstrumentTemplate['hardwareMode']
  if (hwRaw && typeof hwRaw === 'object') {
    hardwareMode = {
      enabled: hwRaw.enabled === true,
      deviceIp: typeof hwRaw.deviceIp === 'string' ? hwRaw.deviceIp : '',
      devicePort:
        typeof hwRaw.devicePort === 'number' ? hwRaw.devicePort : 0,
      mode: hwRaw.mode === 'persist' ? 'persist' : 'reset',
      catchTolerance:
        typeof hwRaw.catchTolerance === 'number'
          ? hwRaw.catchTolerance
          : 0.02,
      movementThreshold:
        typeof hwRaw.movementThreshold === 'number'
          ? hwRaw.movementThreshold
          : 0.005,
      movementWindowMs:
        typeof hwRaw.movementWindowMs === 'number'
          ? hwRaw.movementWindowMs
          : 300,
      // Optional fields - copy through as-is if present.
      ...(Array.isArray(hwRaw.appliesToTrackIds)
        ? {
            appliesToTrackIds: (hwRaw.appliesToTrackIds as unknown[]).filter(
              (x): x is string => typeof x === 'string'
            )
          }
        : {}),
      ...(typeof hwRaw.args === 'object' && hwRaw.args
        ? { args: hwRaw.args as Record<string, number[]> }
        : {}),
      // (#12) Forward-routing fields MUST round-trip — the prior copy
      // block dropped them, laundering the user's real session on every
      // load→save cycle. Validate each against its allowed value(s).
      ...(hwRaw.forwardMode === 'suppress' ||
      hwRaw.forwardMode === 'always' ||
      hwRaw.forwardMode === 'whenIdle'
        ? { forwardMode: hwRaw.forwardMode }
        : {}),
      ...(hwRaw.deviceMatch === 'ipOnly' ? { deviceMatch: hwRaw.deviceMatch } : {}),
      ...(hwRaw.alwaysForward === true ? { alwaysForward: true } : {}),
      // Takeover (catch / jump) MUST round-trip too — a prior bug
      // dropped new hardwareMode fields on load. Only copy through a
      // recognised value; absent/invalid falls back to 'catch' at use.
      ...(hwRaw.takeover === 'catch' || hwRaw.takeover === 'jump'
        ? { takeover: hwRaw.takeover }
        : {}),
      // (v0.6) Per-parameter HW scaling — shape-validated per entry so
      // a malformed record can't survive into the engine.
      ...(hwRaw.scaling && typeof hwRaw.scaling === 'object'
        ? {
            scaling: Object.fromEntries(
              Object.entries(hwRaw.scaling as Record<string, unknown>)
                .filter(
                  (
                    e
                  ): e is [
                    string,
                    { enabled?: unknown; inMin?: unknown; inMax?: unknown; outMin?: unknown; outMax?: unknown }
                  ] =>
                    !!e[1] &&
                    typeof e[1] === 'object' &&
                    typeof (e[1] as Record<string, unknown>).inMin === 'number' &&
                    typeof (e[1] as Record<string, unknown>).inMax === 'number' &&
                    typeof (e[1] as Record<string, unknown>).outMin === 'number' &&
                    typeof (e[1] as Record<string, unknown>).outMax === 'number'
                )
                .map(([fnId, s]) => {
                  const sr = s as Record<string, unknown>
                  const curve = sr.curve
                  return [
                    fnId,
                    {
                      enabled: s.enabled === true,
                      inMin: s.inMin as number,
                      inMax: s.inMax as number,
                      outMin: s.outMin as number,
                      outMax: s.outMax as number,
                      // (v0.6.4) transfer curve — optional, round-tripped.
                      ...(typeof curve === 'string' && TRANSFER_CURVE_SET.has(curve)
                        ? { curve: curve as import('@shared/types').TransferCurve }
                        : {}),
                      ...(typeof sr.curveAmount === 'number' &&
                      Number.isFinite(sr.curveAmount)
                        ? { curveAmount: sr.curveAmount }
                        : {}),
                      ...(sr.invert === true ? { invert: true } : {})
                    }
                  ]
                })
            )
          }
        : {}),
      // (v0.6.x) Direct Output — shape-validated so a malformed blob
      // can't survive into the engine. Requires a numeric port.
      ...(hwRaw.directOutput &&
      typeof hwRaw.directOutput === 'object' &&
      typeof (hwRaw.directOutput as Record<string, unknown>).destPort === 'number'
        ? {
            directOutput: {
              enabled:
                (hwRaw.directOutput as Record<string, unknown>).enabled === true,
              destIp:
                typeof (hwRaw.directOutput as Record<string, unknown>).destIp ===
                'string'
                  ? ((hwRaw.directOutput as Record<string, unknown>)
                      .destIp as string)
                  : '127.0.0.1',
              destPort: (hwRaw.directOutput as Record<string, unknown>)
                .destPort as number
            }
          }
        : {})
    }
  }
  // v0.6 fields — same round-trip contract as hardwareMode.
  const inputConditioner = sanitizeInputConditioner(r.inputConditioner)
  const stateTriggers = sanitizeStateTriggers(r.stateTriggers)
  const derivedParams = sanitizeDerivedParams(r.derivedParams)
  const poseSequences = sanitizePoseSequences(r.poseSequences)
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
    functions: fns,
    ...(hardwareMode ? { hardwareMode } : {}),
    ...(inputConditioner ? { inputConditioner } : {}),
    ...(stateTriggers ? { stateTriggers } : {}),
    ...(derivedParams ? { derivedParams } : {}),
    ...(poseSequences ? { poseSequences } : {})
  }
}

// (v0.6.4) Shape-validate Derived Parameters on load.
function sanitizeDerivedParams(
  raw: unknown
): import('@shared/types').DerivedParam[] | undefined {
  if (!Array.isArray(raw)) return undefined
  const OPS = new Set([
    'magnitude',
    'sum',
    'difference',
    'average',
    'min',
    'max',
    'scaleOffset'
  ])
  const out: import('@shared/types').DerivedParam[] = []
  for (const d of raw) {
    if (!d || typeof d !== 'object') continue
    const r = d as Record<string, unknown>
    if (typeof r.id !== 'string' || typeof r.address !== 'string') continue
    if (typeof r.op !== 'string' || !OPS.has(r.op)) continue
    const sources = Array.isArray(r.sources)
      ? (r.sources as unknown[]).filter((s): s is string => typeof s === 'string')
      : []
    out.push({
      id: r.id,
      address: r.address,
      op: r.op as import('@shared/types').DerivedOp,
      sources,
      ...(typeof r.scale === 'number' && Number.isFinite(r.scale)
        ? { scale: r.scale }
        : {}),
      ...(typeof r.offset === 'number' && Number.isFinite(r.offset)
        ? { offset: r.offset }
        : {})
    })
  }
  return out.length > 0 ? out : undefined
}

function sanitizePool(raw: unknown): Pool {
  const builtin = makeBuiltinPool()
  const userTemplates = raw && typeof raw === 'object' && Array.isArray((raw as Pool).templates)
    ? (raw as Pool).templates
        .map((t) => sanitizeTemplate(t))
        .filter((t): t is InstrumentTemplate => t !== null)
    : []
  // Index saved entries by id so we can graft USER-OVERRIDABLE fields
  // onto the fresh builtin when ids collide (currently just
  // `hardwareMode`: which OSC controller is bound, catch mode,
  // tolerance, etc. — that's per-session user state, not part of the
  // builtin's definition). Without this graft, the merge below
  // silently drops any saved hardwareMode on a builtin (Hardware Mode
  // configured on OCTOCOSME disappears every reload).
  const savedById = new Map<string, InstrumentTemplate>()
  for (const t of userTemplates) savedById.set(t.id, t)
  // Merge: dedupe by id, builtin always wins its CORE DEFINITION so
  // argSpec / oscPath / channelCount etc. can't be accidentally
  // drifted by an old session file. The grafted user-overridable
  // fields ride along on top.
  const seen = new Set<string>(builtin.templates.map((t) => t.id))
  const merged: InstrumentTemplate[] = builtin.templates.map((b) => {
    const saved = savedById.get(b.id)
    // Graft EVERY user-overridable field (hardwareMode +
    // inputConditioner + stateTriggers + derivedParams + poseSequences)
    // — per-session user state that rides on top of the builtin's core
    // definition.
    if (
      saved &&
      (saved.hardwareMode ||
        saved.inputConditioner ||
        saved.stateTriggers ||
        saved.derivedParams ||
        saved.poseSequences)
    ) {
      return {
        ...b,
        ...(saved.hardwareMode ? { hardwareMode: saved.hardwareMode } : {}),
        ...(saved.inputConditioner
          ? { inputConditioner: saved.inputConditioner }
          : {}),
        ...(saved.stateTriggers ? { stateTriggers: saved.stateTriggers } : {}),
        ...(saved.derivedParams ? { derivedParams: saved.derivedParams } : {}),
        ...(saved.poseSequences ? { poseSequences: saved.poseSequences } : {})
      }
    }
    return b
  })
  // User-authored entries with NEW ids (no collision with a builtin)
  // are appended verbatim.
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
