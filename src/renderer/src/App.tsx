import { useEffect, useRef } from 'react'
import { useStore, UI_SCALE_MAX, UI_SCALE_MIN, UI_SCALE_STEP } from './store'
import { midi } from './midi'
import TopBar from './components/TopBar'
import EditView from './components/EditView'
import MetaControllerBar from './components/MetaControllerBar'
import SequenceView from './components/SequenceView'
import OscMonitor from './components/OscMonitor'
import { attachOscErrorStream } from './hooks/oscHealth'
import { IntegrityPromptHost } from './components/IntegrityPromptHost'
import CrashRecoveryPrompt from './components/CrashRecoveryPrompt'
import TransportBar from './components/TransportBar'

export default function App(): JSX.Element {
  const session = useStore((s) => s.session)
  const view = useStore((s) => s.view)
  const setView = useStore((s) => s.setView)
  const setEngineState = useStore((s) => s.setEngineState)
  const theme = useStore((s) => s.theme)

  // Apply theme at the document root so CSS variables cascade everywhere.
  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme)
  }, [theme])

  // Mirror show-mode to <html data-show-mode> so CSS can hide edit chrome
  // selectively. Styling lives in styles.css under [data-show-mode='true'].
  const showMode = useStore((s) => s.showMode)
  useEffect(() => {
    document.documentElement.setAttribute('data-show-mode', String(showMode))
  }, [showMode])

  // Push session to engine whenever it changes. Coalesced on one paint
  // frame so a burst of session mutations (typing into a field, default-
  // link migration, the new-scene-plus-re-render storm, etc.) produces
  // ONE IPC call per frame carrying the latest session snapshot. Prior
  // behavior was one IPC per mutation — under certain scene additions
  // with many cells we saw Electron's IPC pipe back-pressure and freeze
  // the main process (and with it, anything reading its stdout).
  const sessionIpcPendingRef = useRef(false)
  useEffect(() => {
    if (sessionIpcPendingRef.current) return
    sessionIpcPendingRef.current = true
    requestAnimationFrame(() => {
      sessionIpcPendingRef.current = false
      // Always read the freshest session at flush time, not the one
      // captured in this effect's closure.
      window.api.updateSession(useStore.getState().session)
    })
  }, [session])

  // Subscribe to engine state events.
  useEffect(() => {
    const off = window.api.onEngineState((s) => setEngineState(s))
    return off
  }, [setEngineState])

  // Init MIDI once.
  useEffect(() => {
    midi.init()
  }, [])

  // Attach the main → renderer OSC-error stream once on startup. This
  // populates the per-destination health map that `useOscDestHealth()`
  // reads from; the IPC listener stays attached for the process lifetime
  // (App never unmounts in practice).
  useEffect(() => {
    attachOscErrorStream()
  }, [])

  // Global Ctrl+wheel zoom for everything below the main toolbar. Scroll
  // down = zoom out (smaller), scroll up = zoom in (larger). Intercepts at
  // window level so the gesture works no matter where the cursor sits —
  // including over the zoom wrapper where a normal wheel would still
  // scroll the view. We grab state + setter via getState() so the handler
  // never needs re-registering.
  useEffect(() => {
    function onWheel(e: WheelEvent): void {
      if (!e.ctrlKey) return
      e.preventDefault()
      const cur = useStore.getState().uiScale
      const dir = e.deltaY > 0 ? -1 : 1
      const next = Math.max(UI_SCALE_MIN, Math.min(UI_SCALE_MAX, cur + dir * UI_SCALE_STEP))
      if (next !== cur) useStore.getState().setUiScale(next)
    }
    // `passive: false` required so preventDefault actually stops any
    // browser-side Ctrl+wheel behavior.
    window.addEventListener('wheel', onWheel, { passive: false })
    return () => window.removeEventListener('wheel', onWheel)
  }, [])

  // Global keyboard shortcuts.
  //
  // Authoring (suppressed inside text fields):
  //   Tab           → toggle Edit ↔ Sequence
  //   Ctrl+T        → add a new Instrument (draft Template + sidebar header)
  //   Ctrl+P        → add a new Parameter to the selected Instrument
  //                   group (or to the parent of a selected Parameter row).
  //                   No-op when nothing's selected.
  //   Alt+S         → add a Scene
  //   M             → toggle the Meta Controller bar
  //   O             → toggle the OSC Monitor drawer
  //   P             → toggle the Pool inside the OSC Monitor (also opens
  //                   the drawer if it's closed). Modifier-less so the
  //                   user can flick it on/off mid-edit.
  //   I             → toggle the right-side Inspector panel (Edit view)
  //   S             → toggle the focused-Scene info panel (Sequence view)
  //   Delete        → Sequence view: remove focused scene (with confirm)
  //                   Edit view:     remove selected Instrument row(s)
  //
  // Performance (always active, even in show mode):
  //   1–9           → trigger scenes 1–9 in the sequence (sequenceLength slots)
  //   0             → trigger scene 10
  //   Space         → trigger next non-empty slot after the currently-active
  //                   scene (or the first non-empty slot if none is active)
  //   .             → Stop All (graceful morph to 0)
  //   Shift+.       → Panic (instant kill)
  //
  // Show mode:
  //   F11           → toggle show / edit mode
  //   Escape (hold) → exit show mode (press and hold ~800 ms). Short taps
  //                   of Escape still close modals / menus etc.
  const addScene = useStore((s) => s.addScene)
  const removeScene = useStore((s) => s.removeScene)
  useEffect(() => {
    function isEditableTarget(t: EventTarget | null): boolean {
      const el = t as HTMLElement | null
      const tag = el?.tagName
      return (
        tag === 'INPUT' ||
        tag === 'TEXTAREA' ||
        tag === 'SELECT' ||
        el?.isContentEditable === true
      )
    }
    // Figure out which scene id lives at slot N (0-based) in the current
    // sequence. Returns null if the slot is empty or beyond sequenceLength.
    function sceneIdAtSlot(idx: number): string | null {
      const st = useStore.getState()
      const len = st.session.sequenceLength
      if (idx < 0 || idx >= len) return null
      return st.session.sequence[idx] ?? null
    }
    // Next non-empty slot after the currently-playing scene, wrapping. Used
    // by Space bar.
    function nextSceneId(): string | null {
      const st = useStore.getState()
      const len = st.session.sequenceLength
      const seq = st.session.sequence.slice(0, len)
      const active = st.engine.activeSceneId
      const start = active ? seq.findIndex((id) => id === active) : -1
      for (let i = 1; i <= seq.length; i++) {
        const id = seq[(start + i + seq.length) % seq.length]
        if (id) return id
      }
      return null
    }

    // Hold-to-exit state for Escape in show mode.
    let escDownAt = 0
    let escTimer: ReturnType<typeof setTimeout> | null = null

    function onKey(e: KeyboardEvent): void {
      // ------- F11: toggle show mode (always, even inside inputs so a
      //             performer tapping into a field can still flip it)
      if (e.key === 'F11') {
        e.preventDefault()
        const st = useStore.getState()
        st.setShowMode(!st.showMode)
        return
      }

      // ------- Escape hold-to-exit show mode. Short taps still propagate
      //             to menus/modals (they own their own Esc handlers).
      if (e.key === 'Escape') {
        const st = useStore.getState()
        if (!st.showMode) return
        if (e.repeat) return // only arm once per physical press
        escDownAt = Date.now()
        if (escTimer) clearTimeout(escTimer)
        escTimer = setTimeout(() => {
          // Still pressed ~800 ms later? Exit show mode.
          const stillHeld = Date.now() - escDownAt >= 750
          if (stillHeld) useStore.getState().setShowMode(false)
        }, 800)
        return
      }

      // ------- Performance hotkeys — active everywhere, including inside
      //             text fields (musicians' typing habits notwithstanding,
      //             these are live-fire keys). Guarded only against typing
      //             spaces in a text field.
      //
      // Space → GO. If a scene is armed, fire it (and optionally
      // auto-arm the next non-empty slot). Otherwise fall back to the
      // legacy behavior: trigger the next non-empty sequence slot.
      // Never fires inside text fields so normal space-in-text still works.
      if (e.key === ' ' || e.code === 'Space') {
        if (isEditableTarget(e.target)) return
        e.preventDefault()
        const st = useStore.getState()
        if (st.armedSceneId) {
          st.fireArmed()
        } else {
          const id = nextSceneId()
          if (id) st.triggerSceneWithMorph(id)
        }
        return
      }
      // "." → Stop All; Shift+"." → Panic.
      if (e.key === '.' && !e.ctrlKey && !e.metaKey && !e.altKey) {
        if (isEditableTarget(e.target)) return
        e.preventDefault()
        if (e.shiftKey) window.api.panic()
        else window.api.stopAll()
        return
      }
      // 1–9 → fire scenes 1–9 in the sequence; 0 → scene 10.
      if (!e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey) {
        if (isEditableTarget(e.target)) return
        if (e.key >= '1' && e.key <= '9') {
          e.preventDefault()
          const slot = Number(e.key) - 1
          const id = sceneIdAtSlot(slot)
          if (id) useStore.getState().triggerSceneWithMorph(id, slot)
          return
        }
        if (e.key === '0') {
          e.preventDefault()
          const id = sceneIdAtSlot(9)
          if (id) useStore.getState().triggerSceneWithMorph(id, 9)
          return
        }
      }

      // ------- Authoring hotkeys (suppressed in show mode)
      const showMode = useStore.getState().showMode

      // Ctrl/Cmd + T → add a new Instrument (draft Template + header
      // row). Replaces the older "+Message" path; orphan Parameters are
      // created via the right-click "Add orphan Parameter" menu or by
      // dragging a Parameter blueprint from the Pool.
      if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 't') {
        if (showMode) return
        if (isEditableTarget(e.target)) return
        e.preventDefault()
        useStore.getState().addInstrumentRow(null)
        return
      }
      // Ctrl/Cmd + P → add a Parameter to the currently-selected
      // Instrument's group. Resolves the target template-row from
      // selection: if the selected row IS a Template, use it; if it's
      // a Function with a parent Template, use the parent. No-op if
      // selection is empty or points at an orphan Function.
      if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'p') {
        if (showMode) return
        if (isEditableTarget(e.target)) return
        const st = useStore.getState()
        const selId = st.selectedTrack
        if (!selId) return
        const sel = st.session.tracks.find((t) => t.id === selId)
        const groupRowId =
          sel?.kind === 'template'
            ? sel.id
            : sel?.parentTrackId
              ? sel.parentTrackId
              : null
        if (!groupRowId) return
        e.preventDefault()
        st.addFunctionToInstrumentRow(groupRowId)
        return
      }
      // `A` → arm the focused scene as the next cue (or clear if it's
      // already armed). Works everywhere except inside text inputs.
      // Intentionally allowed in show mode — arming is a performance op.
      if (
        !e.ctrlKey &&
        !e.metaKey &&
        !e.altKey &&
        !e.shiftKey &&
        e.key.toLowerCase() === 'a'
      ) {
        if (isEditableTarget(e.target)) return
        const st = useStore.getState()
        const focusedId = st.session.focusedSceneId
        if (!focusedId) return
        e.preventDefault()
        st.setArmedSceneId(st.armedSceneId === focusedId ? null : focusedId)
        return
      }
      // Alt + S → add Scene
      if (e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey && e.key.toLowerCase() === 's') {
        if (showMode) return
        e.preventDefault()
        addScene()
        return
      }
      // M → toggle Meta Controller bar visibility.
      if (
        !e.ctrlKey &&
        !e.metaKey &&
        !e.altKey &&
        !e.shiftKey &&
        e.key.toLowerCase() === 'm'
      ) {
        if (isEditableTarget(e.target)) return
        if (showMode) return
        e.preventDefault()
        const st = useStore.getState()
        st.setMetaControllerVisible(!st.session.metaController.visible)
        return
      }
      // O → toggle OSC Monitor drawer.
      if (
        !e.ctrlKey &&
        !e.metaKey &&
        !e.altKey &&
        !e.shiftKey &&
        e.key.toLowerCase() === 'o'
      ) {
        if (isEditableTarget(e.target)) return
        if (showMode) return
        e.preventDefault()
        const st = useStore.getState()
        st.setOscMonitorOpen(!st.oscMonitorOpen)
        return
      }
      // P → toggle Pool visibility inside the OSC Monitor. If the
      // drawer is currently closed, opens it AND shows the Pool — one
      // keystroke gets the user from "I want to drag a Template" to a
      // ready-to-grab Pool, regardless of starting state.
      if (
        !e.ctrlKey &&
        !e.metaKey &&
        !e.altKey &&
        !e.shiftKey &&
        e.key.toLowerCase() === 'p'
      ) {
        if (isEditableTarget(e.target)) return
        if (showMode) return
        e.preventDefault()
        const st = useStore.getState()
        if (!st.oscMonitorOpen) {
          st.setOscMonitorOpen(true)
          if (st.poolHidden) st.setPoolHidden(false)
        } else {
          st.setPoolHidden(!st.poolHidden)
        }
        return
      }
      // I → toggle the Edit-view Inspector panel. Only meaningful in
      // Edit view (the Sequence view doesn't render it), but harmless
      // anywhere — flipping it doesn't move the visible UI.
      if (
        !e.ctrlKey &&
        !e.metaKey &&
        !e.altKey &&
        !e.shiftKey &&
        e.key.toLowerCase() === 'i'
      ) {
        if (isEditableTarget(e.target)) return
        if (showMode) return
        e.preventDefault()
        const st = useStore.getState()
        st.setEditInspectorVisible(!st.editInspectorVisible)
        return
      }
      // S → toggle the Sequence view's focused-Scene info panel. The
      // panel only renders when a scene is focused, so this is a
      // no-op when nothing's focused.
      if (
        !e.ctrlKey &&
        !e.metaKey &&
        !e.altKey &&
        !e.shiftKey &&
        e.key.toLowerCase() === 's'
      ) {
        if (isEditableTarget(e.target)) return
        if (showMode) return
        e.preventDefault()
        const st = useStore.getState()
        st.setSceneInspectorVisible(!st.sceneInspectorVisible)
        return
      }
      // Delete →
      //   Multi-selected Scenes (either view) : remove all selected scenes
      //   Sequence view, no scene selection   : remove focused scene
      //   Edit view, track selection          : remove selected Instrument(s)
      //                                         (Templates cascade to their
      //                                         child Parameters)
      // All paths prompt for confirm before destroying anything.
      if (e.key === 'Delete' || e.key === 'Del') {
        if (isEditableTarget(e.target)) return
        const st = useStore.getState()
        if (st.showMode) return
        // Scene multi-selection wins in both views — the user is
        // clearly acting on scenes if they've selected several.
        if (st.selectedSceneIds.length > 1) {
          e.preventDefault()
          const n = st.selectedSceneIds.length
          if (confirm(`Delete ${n} scenes?`)) st.removeScenes(st.selectedSceneIds)
          return
        }
        if (st.view === 'sequence') {
          // Fall back to the focused scene (or the single-element
          // selection that matches it). Both paths produce one id.
          const id =
            st.selectedSceneIds.length === 1
              ? st.selectedSceneIds[0]
              : st.session.focusedSceneId
          if (!id) return
          e.preventDefault()
          const focused = st.session.scenes.find((s) => s.id === id)
          if (confirm(`Delete scene "${focused?.name ?? ''}"?`)) {
            removeScene(id)
          }
          return
        }
        // Edit view — delete selected Instrument rows. selectedTrackIds
        // is the multi-selection (shift-click range / single-click);
        // selectedTrack is the single-selection fallback when nothing's
        // multi-selected. Use whichever is non-empty.
        const ids =
          st.selectedTrackIds.length > 0
            ? st.selectedTrackIds
            : st.selectedTrack
              ? [st.selectedTrack]
              : []
        if (ids.length === 0) return
        e.preventDefault()
        // Mirror the right-click "Delete" path: if it's a single row, name
        // it; otherwise show the bulk count. Templates cascade to their
        // children — flag that in the prompt so the user is warned.
        const tracks = st.session.tracks
        const target = tracks.find((t) => t.id === ids[0])
        const label =
          ids.length === 1
            ? `Delete "${target?.name ?? ''}"?` +
              (target?.kind === 'template'
                ? ' (Will also delete its child Parameters.)'
                : '')
            : `Delete ${ids.length} instruments?`
        if (confirm(label)) st.removeTracks(ids)
        return
      }
      // Tab → toggle view, period. We dedicate Tab to view-switch
      // even from inside text inputs (where the browser would
      // otherwise step to the next focusable element) — the user
      // explicitly asked for Tab to ONLY do this. Pair it with
      // Shift+Tab → reverse direction, also handled here so the
      // browser can't reclaim it. Modifier keys other than Shift
      // fall through (Ctrl+Tab is the OS-level window/tab cycler
      // and we shouldn't hijack that).
      if (e.key === 'Tab' && !e.ctrlKey && !e.metaKey && !e.altKey) {
        e.preventDefault()
        setView(useStore.getState().view === 'edit' ? 'sequence' : 'edit')
        return
      }
    }
    function onKeyUp(e: KeyboardEvent): void {
      if (e.key === 'Escape') {
        // Short Esc tap — clear the pending hold-timer so we don't exit.
        if (escTimer) {
          clearTimeout(escTimer)
          escTimer = null
        }
      }
    }
    window.addEventListener('keydown', onKey)
    window.addEventListener('keyup', onKeyUp)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('keyup', onKeyUp)
      if (escTimer) clearTimeout(escTimer)
    }
  }, [setView, addScene, removeScene])

  const uiScale = useStore((s) => s.uiScale)

  return (
    <div className="flex flex-col h-full">
      <TopBar />
      {/* Everything below the main toolbar lives inside a zoom wrapper so
          Ctrl+wheel rescales the whole working area (Meta Controller bar,
          Scenes, Messages, Inspector, Sequence grid) while the top toolbar
          stays at 100%. `zoom` is a Chromium-supported CSS property that
          reflows layout at the scaled factor, unlike `transform: scale`
          which would just visually squish content. */}
      <div
        className="flex flex-col flex-1 min-h-0"
        style={{ zoom: uiScale }}
      >
        <MetaControllerBar />
        <div className="flex-1 min-h-0">
          {view === 'edit' ? <EditView /> : <SequenceView />}
        </div>
        {/* Global transport bar — play/pause/stop, view toggle, selected
            scene readout, and running time counter. Sits inside the zoom
            wrapper so Ctrl+wheel scales it alongside the rest of the app. */}
        <TransportBar />
      </div>
      {/* Optional OSC monitor drawer — renders null when closed, so there
          is no subscription / memory cost while off. Outside the zoom
          wrapper so the log stays crisp at 100 % regardless of UI scale. */}
      <OscMonitor />
      {/* Shown once at startup if we detect the previous run crashed
          (autosave sentinel file was left behind). No-op otherwise. */}
      <CrashRecoveryPrompt />
      {/* Integrity-check modal — shown by the store when a session load
          (Open dialog or crash recovery restore) finds malformed fields.
          Idle / null when there's nothing to resolve. */}
      <IntegrityPromptHost />
    </div>
  )
}
