import { useEffect, useRef, useState } from 'react'
import {
  buildSessionForSave,
  setPoolLibraryCache,
  useStore,
  UI_SCALE_MAX,
  UI_SCALE_MIN,
  UI_SCALE_STEP
} from './store'
import { midi } from './midi'
import TopBar from './components/TopBar'
import EditView from './components/EditView'
import MetaControllerBar from './components/MetaControllerBar'
import SequenceView from './components/SequenceView'
import { MappingsView } from './components/MappingsView'
import { SignalsView } from './components/SignalsView'
import OscMonitor from './components/OscMonitor'
import { attachOscErrorStream } from './hooks/oscHealth'
import { IntegrityPromptHost } from './components/IntegrityPromptHost'
import CrashRecoveryPrompt from './components/CrashRecoveryPrompt'
import CapturePopup from './components/CapturePopup'
import { Modal } from './components/Modal'
import { initUndo, undo, redo } from './undo'
import TransportBar from './components/TransportBar'
import { GenerativePopoverHost } from './components/GenerativePopover'

export default function App(): JSX.Element {
  const session = useStore((s) => s.session)
  const view = useStore((s) => s.view)
  const mappingsOpen = useStore((s) => s.mappingsOpen)
  const signalsOpen = useStore((s) => s.signalsOpen)
  const setView = useStore((s) => s.setView)
  const setEngineState = useStore((s) => s.setEngineState)
  const theme = useStore((s) => s.theme)

  // Apply theme at the document root so CSS variables cascade everywhere.
  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme)
  }, [theme])

  // Initialise the undo/redo subscriber exactly once. The module
  // watches `session` identity changes and captures pre-states into
  // a 3-deep ring buffer (debounced 500 ms so a typing burst counts
  // as one undoable step). Buttons + Ctrl+Z hotkey read off the
  // resulting `undoCount` / `redoCount` published into the store.
  useEffect(() => {
    initUndo()
  }, [])

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
  // GUI layout fields tracked so a change to zoom / row height /
  // column widths also triggers a flush — autosave needs to capture
  // these inside the session payload, not just per-session-content
  // edits.
  const uiScaleW = useStore((s) => s.uiScale)
  const topBarScaleW = useStore((s) => s.topBarScale)
  const rowHeightW = useStore((s) => s.rowHeight)
  const sceneColumnWidthW = useStore((s) => s.sceneColumnWidth)
  const inspectorWidthW = useStore((s) => s.inspectorWidth)
  const trackColumnWidthW = useStore((s) => s.trackColumnWidth)
  const editorNotesHeightW = useStore((s) => s.editorNotesHeight)
  const oscMonitorHeightW = useStore((s) => s.oscMonitorHeight)
  const tracksCollapsedW = useStore((s) => s.tracksCollapsed)
  const scenesCollapsedW = useStore((s) => s.scenesCollapsed)
  // (v0.6) Scope frames persist out-of-band (scopePrefs.ts module Map);
  // this counter changes whenever one does, so the flush below re-runs
  // and buildSessionForSave (which reads dumpScopePrefs) reaches main.
  const scopePrefsRevW = useStore((s) => s.scopePrefsRev)
  const sessionIpcPendingRef = useRef(false)
  useEffect(() => {
    if (sessionIpcPendingRef.current) return
    sessionIpcPendingRef.current = true
    requestAnimationFrame(() => {
      sessionIpcPendingRef.current = false
      // Always read the freshest session at flush time, not the one
      // captured in this effect's closure. Bundle the current GUI
      // layout (zoom + sizes + collapse flags) so autosave + every
      // ordinary save carries it along — `setSession` on load
      // re-applies the layout to the store.
      window.api.updateSession(buildSessionForSave(useStore.getState()))
    })
  }, [
    session,
    uiScaleW,
    topBarScaleW,
    rowHeightW,
    sceneColumnWidthW,
    inspectorWidthW,
    trackColumnWidthW,
    editorNotesHeightW,
    oscMonitorHeightW,
    tracksCollapsedW,
    scenesCollapsedW,
    scopePrefsRevW
  ])

  // v0.5.10 -- bake the package version + the current session name
  // into `document.title`. Electron auto-syncs the BrowserWindow
  // title from document.title, so the OS title bar reflects both
  // bits in real time as the user opens different sessions.
  // The version is fetched from main once on mount (sourced from
  // package.json via `app.getVersion()`); the session name reacts
  // live to `session.name` + `currentFilePath` changes.
  const [appVersion, setAppVersion] = useState<string>('')
  useEffect(() => {
    let cancelled = false
    void window.api?.appGetVersion?.().then((v) => {
      if (!cancelled && typeof v === 'string') setAppVersion(v)
    })
    return () => {
      cancelled = true
    }
  }, [])
  const sessionNameForTitle = useStore((s) => s.session.name)
  const currentFilePathForTitle = useStore((s) => s.currentFilePath)
  useEffect(() => {
    // Prefer the human-typed session name; fall back to the
    // filename basename (without `.dflou.json`) when the user
    // hasn't named it. Empty -> "Untitled".
    let sessionPart = (sessionNameForTitle || '').trim()
    if (!sessionPart && currentFilePathForTitle) {
      const parts = currentFilePathForTitle.split(/[\\/]/)
      sessionPart = (parts[parts.length - 1] || '').replace(
        /\.dflou\.json$/i,
        ''
      )
    }
    if (!sessionPart) sessionPart = 'Untitled'
    const verPart = appVersion ? ` v${appVersion}` : ''
    document.title = `dataFLOU_compositor${verPart} : ${sessionPart}`
  }, [appVersion, sessionNameForTitle, currentFilePathForTitle])

  // Subscribe to engine state events.
  useEffect(() => {
    const off = window.api.onEngineState((s) => setEngineState(s))
    return off
  }, [setEngineState])

  // Two-stage modulator live preview — the engine ships ~30 Hz
  // snapshots of the currently-watched cell's effective Modulation 1
  // (post-Mod 2 patch). Store them in the renderer slice; the
  // Inspector reads from there to overlay live values onto sliders /
  // numbers without clobbering the user's stored authoring values.
  useEffect(() => {
    if (!window.api.onMod1Live) return
    const off = window.api.onMod1Live((sample) => {
      useStore.getState().setMod1Live(sample)
    })
    return off
  }, [])

  // Init MIDI once. The manager will also open the persisted
  // `session.midiInputName` if one is set — but only if init runs
  // AFTER session-load. In practice init runs early on mount with
  // the empty default session, so the open-on-init call no-ops; the
  // session-load reopener below is what actually re-binds the
  // device every time the session changes.
  useEffect(() => {
    midi.init()
  }, [])
  // Re-open the persisted MIDI input device whenever the session's
  // `midiInputName` changes (load / new / autosave restore all
  // funnel through here). Without this, all the per-cell /
  // per-scene / per-knob MIDI bindings stored in the session were
  // recalled correctly but the renderer had no MIDI input attached
  // — so the bindings looked "missing" until the user manually
  // re-picked their device from the top-toolbar select.
  const midiInputName = useStore((s) => s.session.midiInputName)
  useEffect(() => {
    // `open()` no-ops if the access handle isn't ready yet (init()
    // races with this effect on the very first paint); when access
    // arrives, init()'s own open call covers the initial case.
    midi.open(midiInputName ?? null)
  }, [midiInputName])

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
      // Ctrl+wheel = UI zoom.
      if (e.ctrlKey) {
        e.preventDefault()
        const cur = useStore.getState().uiScale
        const dir = e.deltaY > 0 ? -1 : 1
        const next = Math.max(UI_SCALE_MIN, Math.min(UI_SCALE_MAX, cur + dir * UI_SCALE_STEP))
        if (next !== cur) useStore.getState().setUiScale(next)
        return
      }
      // Shift+wheel = horizontal scroll on the nearest overflow-x
      // container. Lets users without a horizontal scroll wheel
      // navigate wide views (Edit grid, Sequence timeline).
      if (e.shiftKey && e.deltaY !== 0 && e.deltaX === 0) {
        let el = e.target as Element | null
        while (el && el !== document.body) {
          const style = window.getComputedStyle(el)
          const ox = style.overflowX
          if ((ox === 'auto' || ox === 'scroll') && el.scrollWidth > el.clientWidth) {
            ;(el as HTMLElement).scrollLeft += e.deltaY
            e.preventDefault()
            return
          }
          el = el.parentElement
        }
      }
      // v0.5.10 -- explicit horizontal-wheel handling for users
      // WITH a horizontal scroll wheel (Logitech MX Master / VX
      // thumb wheels). Previously we relied on Chromium's native
      // deltaX → overflow-x propagation, but that only works when
      // the event target itself is the scrollable element; when
      // the cursor sits over a child (e.g. a cell tile inside a
      // scrollable Edit grid), Chromium doesn't bubble the deltaX
      // up to find a scrollable ancestor. Walk up to the nearest
      // overflow-x container ourselves and apply scrollLeft there.
      // Triggers only when (a) no modifier is held (Ctrl+wheel
      // and Shift+wheel are claimed above) and (b) deltaX is the
      // dominant axis -- so a primarily-vertical wheel still goes
      // through Chromium's native vertical scroll, untouched.
      if (
        !e.ctrlKey &&
        !e.shiftKey &&
        !e.metaKey &&
        e.deltaX !== 0 &&
        Math.abs(e.deltaX) >= Math.abs(e.deltaY)
      ) {
        let el = e.target as Element | null
        while (el && el !== document.body) {
          const style = window.getComputedStyle(el)
          const ox = style.overflowX
          if (
            (ox === 'auto' || ox === 'scroll') &&
            el.scrollWidth > el.clientWidth
          ) {
            ;(el as HTMLElement).scrollLeft += e.deltaX
            e.preventDefault()
            return
          }
          el = el.parentElement
        }
      }
    }
    // `passive: false` required so preventDefault actually stops any
    // browser-side Ctrl+wheel behavior.
    window.addEventListener('wheel', onWheel, { passive: false })
    return () => window.removeEventListener('wheel', onWheel)
  }, [])

  // v0.5.10 -- intercept Chromium's built-in zoom keyboard shortcuts
  // (Ctrl+= / Ctrl+- / Ctrl+0) and route them through dataFLOU's
  // own `uiScale`. Without this, those shortcuts hit webContents
  // zoom (a separate Chromium-level zoom system) which ISN'T
  // persisted in the session -- so a user who occasionally hits
  // Ctrl+= would see two competing zoom values drift apart.
  // Now there's exactly one zoom (uiScale) and it travels with
  // the session file via `session.ui.uiScale`.
  useEffect(() => {
    function onZoomKey(e: KeyboardEvent): void {
      // Match Ctrl OR Cmd (Mac users). Shift+Ctrl+= is the same
      // physical key on US layouts (Ctrl+Plus), so we accept both.
      if (!(e.ctrlKey || e.metaKey)) return
      // Skip when the user is typing in an input/textarea/select
      // so Ctrl+= inside a number field stays usable for browsers
      // that bind it (rare, but safer to skip).
      const t = e.target as HTMLElement | null
      const tag = t?.tagName
      const isEditable =
        tag === 'INPUT' ||
        tag === 'TEXTAREA' ||
        tag === 'SELECT' ||
        t?.isContentEditable
      if (isEditable) return
      const key = e.key
      // Plus / equals on US layouts (Ctrl+= without Shift typically
      // sends "="; Ctrl+Shift+= sends "+"; some layouts send
      // "Add" on numpad).
      const isZoomIn = key === '+' || key === '=' || key === 'Add'
      const isZoomOut = key === '-' || key === '_' || key === 'Subtract'
      const isZoomReset = key === '0' || key === 'Numpad0'
      if (!isZoomIn && !isZoomOut && !isZoomReset) return
      e.preventDefault()
      const store = useStore.getState()
      if (isZoomReset) {
        // Reset to a sensible 1.0 baseline. Matches "Actual size"
        // in most browsers/apps.
        store.setUiScale(1.0)
        return
      }
      const cur = store.uiScale
      const dir = isZoomIn ? 1 : -1
      const next = Math.max(
        UI_SCALE_MIN,
        Math.min(UI_SCALE_MAX, cur + dir * UI_SCALE_STEP)
      )
      if (next !== cur) store.setUiScale(next)
    }
    window.addEventListener('keydown', onZoomKey)
    return () => window.removeEventListener('keydown', onZoomKey)
  }, [])

  // Global keyboard shortcuts.
  //
  // Authoring (suppressed inside text fields):
  //   Tab           → toggle Edit ↔ Sequence
  //   Ctrl+S        → save the session (Save if path known, else Save As)
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

      // ------- Ctrl/Cmd+Z = Undo, Ctrl/Cmd+Shift+Z (or Ctrl+Y) = Redo.
      //              Works inside text fields too — the snapshotting
      //              treats a typing burst as one undoable step, so
      //              hitting Ctrl+Z mid-edit rolls back the burst
      //              cleanly. preventDefault stops the browser's
      //              own "undo last text edit" intercept from
      //              shadowing the session-level undo.
      if ((e.ctrlKey || e.metaKey) && (e.key === 'z' || e.key === 'Z')) {
        e.preventDefault()
        if (e.shiftKey) redo()
        else undo()
        return
      }
      if ((e.ctrlKey || e.metaKey) && (e.key === 'y' || e.key === 'Y')) {
        e.preventDefault()
        redo()
        return
      }

      // Ctrl/⌘+C / Ctrl/⌘+V — internal clipboard for Instruments,
      // Parameters, and clips. Suppressed inside text fields so
      // normal native text copy/paste still works there. Outside
      // editable targets, copy captures the currently-selected cell
      // (priority) or selected track; paste drops the payload at
      // the focused destination. See store.copyToClipboard /
      // pasteFromClipboard for the routing rules.
      if (
        (e.ctrlKey || e.metaKey) &&
        !e.altKey &&
        !e.shiftKey &&
        e.key.toLowerCase() === 'c'
      ) {
        if (isEditableTarget(e.target)) return
        e.preventDefault()
        useStore.getState().copyToClipboard()
        return
      }
      if (
        (e.ctrlKey || e.metaKey) &&
        !e.altKey &&
        !e.shiftKey &&
        e.key.toLowerCase() === 'v'
      ) {
        if (isEditableTarget(e.target)) return
        e.preventDefault()
        useStore.getState().pasteFromClipboard()
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
      // "C" → Open the Capture window (whether closed or already
      // open is fine, the modal toggles back on the same press).
      // Guarded against text-field input so typing "c" in a name
      // field doesn't pop the modal.
      if ((e.key === 'c' || e.key === 'C') && !e.ctrlKey && !e.metaKey && !e.altKey) {
        if (isEditableTarget(e.target)) return
        e.preventDefault()
        useStore.getState().setCaptureOpen(true)
        return
      }
      // "N" → toggle the Mappings view.
      if ((e.key === 'n' || e.key === 'N') && !e.ctrlKey && !e.metaKey && !e.altKey) {
        if (isEditableTarget(e.target)) return
        e.preventDefault()
        const st = useStore.getState()
        const opening = !st.mappingsOpen
        st.setMappingsOpen(opening)
        // Mutually exclusive with the Signals overlay so we never stack.
        if (opening && st.signalsOpen) st.setSignalsOpen(false)
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

      // Ctrl/Cmd + S → save the current session. If we have a known
      // file path, write to it directly (Save). Otherwise prompt for a
      // location (Save As) and remember the path. Suppressed in show
      // mode and inside text fields so a performer typing into a name
      // field doesn't accidentally save with every keystroke.
      if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 's') {
        if (showMode) return
        if (isEditableTarget(e.target)) return
        e.preventDefault()
        const st = useStore.getState()
        // Same buildSessionForSave bundle as the manual Save button
        // — Ctrl+S also captures the GUI layout into session.ui.
        const sess = buildSessionForSave(st)
        const path = st.currentFilePath
        // Briefly flash the Save button so the user gets the same visual
        // confirmation they'd get from clicking it. Located by data-attr
        // on the toolbar's Save button.
        const flashSave = (): void => {
          const el = document.querySelector<HTMLElement>('[data-save-button="true"]')
          if (!el) return
          el.classList.remove('flash-blue')
          void el.offsetWidth
          el.classList.add('flash-blue')
        }
        if (path) {
          void window.api.sessionSave(sess, path).then((ok) => {
            if (ok) flashSave()
          })
        } else {
          void window.api.sessionSaveAs(sess).then((p) => {
            if (p) {
              useStore.getState().setCurrentFilePath(p)
              flashSave()
            }
          })
        }
        return
      }
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
      // Ctrl+Alt+D → duplicate the focused scene. The right-click
      // menu also offers this; the shortcut is for hands-on-keyboard
      // workflows. No-op when no scene is focused or in show mode.
      if (
        (e.ctrlKey || e.metaKey) &&
        e.altKey &&
        !e.shiftKey &&
        e.key.toLowerCase() === 'd'
      ) {
        if (showMode) return
        if (isEditableTarget(e.target)) return
        const st = useStore.getState()
        const focusedId = st.session.focusedSceneId
        if (!focusedId) return
        e.preventDefault()
        const newId = st.duplicateScene(focusedId)
        if (newId) st.setFocusedScene(newId)
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
      // L → toggle MIDI Learn mode. Same effect as clicking the MIDI
      // Learn button in the TopBar. Hardware performers can flip in
      // and out of learn mode without reaching for the mouse.
      if (
        !e.ctrlKey &&
        !e.metaKey &&
        !e.altKey &&
        !e.shiftKey &&
        e.key.toLowerCase() === 'l'
      ) {
        if (isEditableTarget(e.target)) return
        if (showMode) return
        e.preventDefault()
        const st = useStore.getState()
        st.setMidiLearnMode(!st.midiLearnMode)
        return
      }
      // G → toggle the Generative Settings popover (v0.5.10). Lets
      // the performer flip the window in / out without finding the
      // chevron next to the GENERATIVE button. Popover is draggable
      // and remembers its position across opens, so G + drag once =
      // permanent "Generative HUD" wherever the user parked it.
      if (
        !e.ctrlKey &&
        !e.metaKey &&
        !e.altKey &&
        !e.shiftKey &&
        e.key.toLowerCase() === 'g'
      ) {
        if (isEditableTarget(e.target)) return
        if (showMode) return
        e.preventDefault()
        const st = useStore.getState()
        st.setGenerativePopoverOpen(!st.generativePopoverOpen)
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
      // S → toggle the Signals view (v0.6.5) — "mission control" for every
      // State Trigger + Pose Sequence across the session. Full-area overlay
      // like Mappings (N).
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
        const opening = !st.signalsOpen
        st.setSignalsOpen(opening)
        // Mutually exclusive with the Mappings overlay so we never stack.
        if (opening && st.mappingsOpen) st.setMappingsOpen(false)
        return
      }
      // Shift+S → toggle the Sequence view's focused-Scene info panel
      // (relocated from plain "S" when Signals claimed it). The panel only
      // renders when a scene is focused, so this is a no-op otherwise.
      if (
        !e.ctrlKey &&
        !e.metaKey &&
        !e.altKey &&
        e.shiftKey &&
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
        // Saved-Scene multi-selection (Pool · Scenes tab) wins first
        // because the highlight visually pulls focus there. Single
        // OR multi — both go through removeSavedScene in a loop.
        if (st.selectedSavedSceneIds.length > 0) {
          e.preventDefault()
          const ids = [...st.selectedSavedSceneIds]
          const n = ids.length
          const first = st.sceneLibrary.find((s) => s.id === ids[0])
          const label =
            n === 1
              ? `Delete saved scene "${first?.name ?? ''}" from the Pool?`
              : `Delete ${n} saved scenes from the Pool?`
          if (confirm(label)) {
            for (const id of ids) void st.removeSavedScene(id)
            st.clearSavedSceneSelection()
          }
          return
        }
        // Scene selection wins in BOTH views (sequence + edit) as
        // long as no track/cell is selected. The selection mutex
        // in `setFocusedScene` guarantees that clicking a scene
        // header clears track + cell selections, so this branch is
        // unambiguously "user is acting on scenes". Multi or single,
        // same path — confirm tag changes with count.
        if (
          st.selectedSceneIds.length >= 1 &&
          st.selectedTrackIds.length === 0 &&
          !st.selectedTrack &&
          !st.selectedCell
        ) {
          e.preventDefault()
          const ids = st.selectedSceneIds
          const n = ids.length
          if (n > 1) {
            if (confirm(`Delete ${n} scenes?`)) st.removeScenes(ids)
          } else {
            const sc = st.session.scenes.find((s) => s.id === ids[0])
            if (confirm(`Delete scene "${sc?.name ?? ''}"?`)) removeScene(ids[0])
          }
          return
        }
        // Sequence view fallback — focused scene with no selection
        // set (e.g. after launching the app and tapping a slot).
        if (st.view === 'sequence') {
          const id = st.session.focusedSceneId
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
  const topBarScale = useStore((s) => s.topBarScale)

  // Network discovery: subscribe to main-process device updates at
  // app-level (not inside PoolPane) so the Pool drawer's title-bar
  // status dot can reflect live bind errors even when the user has
  // collapsed the drawer. Previously the subscription was tied to
  // PoolPane mount/unmount and stopped firing the moment the drawer
  // was hidden.
  const setNetworkSnapshot = useStore((s) => s.setNetworkSnapshot)
  // Default destination port — used as the listener's port too.
  // Sending and listening converge on a single "compositor OSC
  // port" the user reads off the top toolbar, so when they
  // configure their OCTOCOSME controller to send to that port the
  // Capture popup picks it up automatically.
  const defaultDestPort = useStore((s) => s.session.defaultDestPort)
  // The EXPLICIT listen port (set via the Network tab / TopBar "Listen on")
  // is authoritative when present. Without this, the auto-bind effect below
  // forces the listener onto defaultDestPort (the default SEND port) every
  // time it re-runs — e.g. when a Forward target is added/edited — which
  // silently drags the listener off the port the user set (the "listener
  // jumps to 9001" bug). Listen (incoming) and default-send (outgoing) are
  // different concerns and must not be coupled.
  const listenerPort = useStore((s) => s.session.listenerPort)
  // Persisted OSC forward targets — every received UDP packet is
  // byte-copied onward to each enabled entry. We push the whole list
  // to main once on app load so a freshly-opened session immediately
  // resumes forwarding without the user having to touch the popover.
  // Subsequent edits route through the store's CRUD actions, which
  // push their own updates.
  const forwardTargets = useStore((s) => s.session.forwardTargets)
  useEffect(() => {
    let cancelled = false
    // Initial fetch + AUTO-ENABLE the listener bound to the
    // session's default OSC port. If the user has never changed
    // it, that's the conventional 9000. Auto-enable means the
    // Capture popup will see incoming devices without a manual
    // toggle — the most common workflow.
    window.api?.networkList?.().then((payload) => {
      if (cancelled) return
      setNetworkSnapshot(payload.devices, payload.status)
      // If the listener is already on (e.g. a hot-reload), don't
      // re-bind. If it's off OR bound on a different port than
      // the session's default, kick it on at the right port.
      const wantPort =
        listenerPort && listenerPort > 0
          ? listenerPort
          : defaultDestPort > 0
            ? defaultDestPort
            : 9000
      if (!payload.status.enabled || payload.status.port !== wantPort) {
        window.api?.networkSetEnabled?.(true, wantPort).then((next) => {
          if (cancelled || !next) return
          setNetworkSnapshot([], next)
        })
      }
      // Replay persisted forward targets to main. Safe to call with
      // [] — main treats that as "forwarding off".
      window.api?.networkSetForwardTargets?.(forwardTargets ?? [])
    })
    const off = window.api?.onNetworkDevices?.((payload) => {
      setNetworkSnapshot(payload.devices, payload.status)
    })
    return () => {
      cancelled = true
      if (off) off()
    }
    // Re-run when the session's defaultDestPort changes so the
    // listener re-binds onto the new port automatically. The
    // forwardTargets dep handles the rare case where opening a
    // different session file changes the persisted targets — the
    // store CRUD actions cover ordinary edits.
  }, [setNetworkSnapshot, defaultDestPort, listenerPort, forwardTargets])

  // Saved-scene library subscription — also at app level so the
  // Pool's Scenes tab is up to date the instant the user opens it,
  // and stays fresh while the drawer is collapsed (e.g. another
  // window saving a scene). Initial fetch + push-on-change.
  const setSceneLibrary = useStore((s) => s.setSceneLibrary)
  useEffect(() => {
    let cancelled = false
    window.api?.sceneLibraryList?.().then((scenes) => {
      if (cancelled) return
      setSceneLibrary(scenes)
    })
    const off = window.api?.onSceneLibrary?.((scenes) => {
      setSceneLibrary(scenes)
    })
    return () => {
      cancelled = true
      if (off) off()
    }
  }, [setSceneLibrary])

  // Motion Loop hands-free OSC trigger (v0.6.x) — the engine fires this on
  // a rising edge of the configured trigger address (the antenna's BTN1);
  // toggle record on the focused scene, same as clicking ●REC.
  useEffect(() => {
    const off = window.api?.onMotionLoopTrigger?.(() => {
      useStore.getState().toggleMotionLoopRecordFocused()
    })
    return () => {
      if (off) off()
    }
  }, [])

  // Pool library — User Instruments + Parameters persisted across
  // sessions. On mount we fetch the cache + merge any entries we
  // don't already have (so a freshly-opened blank session inherits
  // the user's library). After mount, we watch the session's pool
  // for changes and push the full User-entry set back to main on
  // every change so the on-disk file stays in sync.
  const mergePoolLibrary = useStore((s) => s.mergePoolLibrary)
  const poolTemplates = useStore((s) => s.session.pool.templates)
  const poolParameters = useStore((s) => s.session.pool.parameters)
  // Track whether we've completed the initial merge — auto-push
  // must NOT run before the merge or we'd overwrite the library
  // with the session's stale "empty" pool on first paint.
  const [poolLibraryReady, setPoolLibraryReady] = useState(false)
  useEffect(() => {
    let cancelled = false
    window.api?.poolLibraryGet?.().then((payload) => {
      if (cancelled || !payload) return
      // Mirror the payload into the module-scope cache used by
      // `newSession` / `setSession` to re-seed a fresh session's
      // pool with the user's library, then merge into the current
      // session as well.
      setPoolLibraryCache(payload)
      mergePoolLibrary(payload)
      setPoolLibraryReady(true)
    })
    const off = window.api?.onPoolLibrary?.((payload) => {
      // Other windows touching the same library push updates here.
      setPoolLibraryCache(payload)
      mergePoolLibrary(payload)
    })
    return () => {
      cancelled = true
      if (off) off()
    }
  }, [mergePoolLibrary])
  // Auto-push: whenever the session's User-pool entries change,
  // mirror them to the global library. Filter out builtin /
  // draft entries so the library only stores finished User work.
  useEffect(() => {
    if (!poolLibraryReady) return
    const userTemplates = poolTemplates.filter((t) => !t.builtin && !t.draft)
    const userParameters = poolParameters.filter((p) => !p.builtin)
    window.api?.poolLibrarySetAll?.({
      templates: userTemplates,
      parameters: userParameters
    })
  }, [poolTemplates, poolParameters, poolLibraryReady])

  // Scenes are NOT auto-saved to the library. Adding a fresh empty
  // column on the grid is a working-session action, not a library
  // commitment — auto-saving polluted the Pool with placeholder
  // entries every time the user clicked "+ Scene". The library now
  // only grows via the explicit paths: right-click → Save Scene to
  // Pool (in the grid or the palette), and Capture (which builds a
  // SavedScene as part of its flow). `sceneIdsFromLibrary` still
  // exists so future re-introduction of auto-save can skip
  // library-originated instantiations cleanly.

  // Save-before-quit modal. Main intercepts the window-close event
  // and pushes `app:before-close`; we show a 3-button confirm and
  // signal main back via `appCloseProceed` (Save / Discard / Cancel
  // are the choices — Cancel keeps the window open).
  const [closeConfirmOpen, setCloseConfirmOpen] = useState(false)
  const [closeSaving, setCloseSaving] = useState(false)
  useEffect(() => {
    const off = window.api?.onAppBeforeClose?.(() => {
      setCloseConfirmOpen(true)
    })
    return () => {
      if (off) off()
    }
  }, [])
  const [quitSaveError, setQuitSaveError] = useState<string | null>(null)
  async function handleQuitSave(): Promise<void> {
    if (closeSaving) return
    setCloseSaving(true)
    setQuitSaveError(null)
    try {
      const st = useStore.getState()
      // Bundle GUI layout so the saved file restores zoom + sizes
      // on next open. See buildSessionForSave in the store.
      const session = buildSessionForSave(st)
      const path = st.currentFilePath
      if (path) {
        await window.api?.sessionSave?.(session, path)
      } else {
        // No file path yet — write into the app's Sessions folder
        // with the session's current name (no Save-As dialog).
        const newPath = await window.api?.sessionSaveToDefault?.(session)
        if (newPath) st.setCurrentFilePath(newPath)
      }
    } catch (e) {
      // SAVE FAILED — surface the error and DO NOT close. Previously
      // we logged + proceeded, which silently dropped the session
      // on disk-full / read-only / permission errors. Keep the
      // modal open with the error visible; the user can retry or
      // choose No (discard) to close anyway.
      console.error('[quit-save] failed:', (e as Error).message)
      setQuitSaveError((e as Error).message || 'Save failed.')
      setCloseSaving(false)
      return
    }
    setCloseSaving(false)
    setCloseConfirmOpen(false)
    await window.api?.appCloseProceed?.()
  }
  async function handleQuitDiscard(): Promise<void> {
    setQuitSaveError(null)
    setCloseConfirmOpen(false)
    await window.api?.appCloseProceed?.()
  }
  function handleQuitCancel(): void {
    setQuitSaveError(null)
    setCloseConfirmOpen(false)
  }

  // ── New-session confirmation ────────────────────────────────────
  // TopBar's New button sets `newSessionConfirmOpen` true so we can
  // ask "Save before opening a new session?" first. Same UX as the
  // quit-confirm modal: Yes saves (overwrite path or write into the
  // Sessions folder) then proceeds, No discards then proceeds,
  // Cancel keeps the current session.
  const newSessionConfirmOpen = useStore((s) => s.newSessionConfirmOpen)
  const setNewSessionConfirmOpen = useStore((s) => s.setNewSessionConfirmOpen)
  const newSessionFromStore = useStore((s) => s.newSession)
  const [newSessionSaving, setNewSessionSaving] = useState(false)
  const [newSessionSaveError, setNewSessionSaveError] = useState<string | null>(null)
  async function handleNewSessionSave(): Promise<void> {
    if (newSessionSaving) return
    setNewSessionSaving(true)
    setNewSessionSaveError(null)
    try {
      const st = useStore.getState()
      const session = st.session
      const path = st.currentFilePath
      if (path) {
        await window.api?.sessionSave?.(session, path)
      } else {
        const newPath = await window.api?.sessionSaveToDefault?.(session)
        if (newPath) st.setCurrentFilePath(newPath)
      }
    } catch (e) {
      console.error('[new-session-save] failed:', (e as Error).message)
      setNewSessionSaveError((e as Error).message || 'Save failed.')
      setNewSessionSaving(false)
      return
    }
    setNewSessionSaving(false)
    setNewSessionConfirmOpen(false)
    newSessionFromStore()
  }
  function handleNewSessionDiscard(): void {
    setNewSessionSaveError(null)
    setNewSessionConfirmOpen(false)
    newSessionFromStore()
  }
  function handleNewSessionCancel(): void {
    setNewSessionSaveError(null)
    setNewSessionConfirmOpen(false)
  }

  return (
    // v0.5.10 -- the zoom wrapper now wraps the ENTIRE app, including
    // the top toolbar. Previously the toolbar was kept at a fixed
    // size so its buttons stayed readable when content shrank, and
    // users who wanted everything to scale relied on Chromium's
    // Ctrl+= keyboard zoom as an escape hatch. Now that Ctrl+= is
    // routed through `uiScale` for persistence, the toolbar would
    // have stayed pinned -- so we move the wrapper up here so a
    // single `uiScale` value scales every pixel uniformly. CSS
    // `zoom` keeps layout reflowing at the scaled size.
    <div
      className="flex flex-col h-full"
      style={{ zoom: uiScale }}
    >
      {/* v0.5.10 -- TopBar gets an additional `topBarScale` zoom
          (default 1.0) on top of uiScale, so users running a small
          uiScale (e.g. 0.6) can bump JUST the toolbar back to a
          legible size without rescaling the Scene grid. The wrapper
          uses width: 100% / no negative margin so the toolbar still
          spans the full window width even when scaled below 1.0. */}
      <div style={{ zoom: topBarScale }}>
        <TopBar />
      </div>
      <div className="flex flex-col flex-1 min-h-0">
        <MetaControllerBar />
        <div className="flex-1 min-h-0">
          {signalsOpen ? (
            <SignalsView />
          ) : mappingsOpen ? (
            <MappingsView />
          ) : view === 'edit' ? (
            <EditView />
          ) : (
            <SequenceView />
          )}
        </div>
        {/* Global transport bar — play/pause/stop, view toggle, selected
            scene readout, and running time counter. Sits inside the zoom
            wrapper so Ctrl+wheel scales it alongside the rest of the app. */}
        <TransportBar />
        {/* Optional OSC monitor drawer — renders null when closed, so
            there is no subscription / memory cost while off. Lives
            inside the zoom wrapper so Ctrl+wheel scales the Pool tabs
            and the OSC log alongside the rest of the app (previously
            it sat outside so the log read at 100% regardless of zoom —
            but users expect Ctrl+wheel to scale the entire workspace,
            drawer included). */}
        <OscMonitor />
      </div>
      {/* Shown once at startup if we detect the previous run crashed
          (autosave sentinel file was left behind). No-op otherwise. */}
      <CrashRecoveryPrompt />
      {/* Integrity-check modal — shown by the store when a session load
          (Open dialog or crash recovery restore) finds malformed fields.
          Idle / null when there's nothing to resolve. */}
      <IntegrityPromptHost />
      {/* Capture popup — modal triggered by the Pool's Capture
          button. Lives at app-root level so it renders above every
          other panel including the Pool drawer. Null when closed
          (no subscription / no cost). */}
      <CapturePopup />
      {/* Generative Settings popover (v0.5.10). Mounted here at App
          level (not inside GenerativeButton) so the popover is
          available in BOTH Grid and Sequence views, and the G
          hotkey can toggle it from anywhere. Renders null when
          closed. */}
      <GenerativePopoverHost />
      {closeConfirmOpen && (
        <Modal title="Save before quitting?" onClose={handleQuitCancel}>
          <div className="flex flex-col gap-3 text-[12px]">
            <p className="text-text">
              Save the current session before closing the app?
            </p>
            <p className="text-muted text-[11px]">
              {useStore.getState().currentFilePath
                ? `Saving will overwrite "${useStore.getState().currentFilePath}".`
                : 'No file path is associated yet — saving will create a new file in the dataFLOU Sessions folder named after the session.'}
            </p>
            {quitSaveError && (
              <p
                className="text-[11px] px-2 py-1 rounded border"
                style={{
                  borderColor: 'rgb(var(--c-danger))',
                  color: 'rgb(var(--c-danger))'
                }}
              >
                Save failed: {quitSaveError}. Retry, or click No to close
                without saving.
              </p>
            )}
            <div className="flex items-center justify-end gap-2 pt-1">
              <button
                className="btn text-[11px]"
                onClick={handleQuitCancel}
                disabled={closeSaving}
              >
                Cancel
              </button>
              <button
                className="btn text-[11px]"
                onClick={handleQuitDiscard}
                disabled={closeSaving}
                title="Close without saving"
              >
                No
              </button>
              <button
                className="btn-accent text-[11px]"
                onClick={handleQuitSave}
                disabled={closeSaving}
                title="Save the session, then close"
              >
                {closeSaving ? 'Saving…' : 'Yes'}
              </button>
            </div>
          </div>
        </Modal>
      )}
      {newSessionConfirmOpen && (
        <Modal
          title="Save before opening a new session?"
          onClose={handleNewSessionCancel}
        >
          <div className="flex flex-col gap-3 text-[12px]">
            <p className="text-text">
              The current session will be replaced by a fresh one.
              Save it first?
            </p>
            <p className="text-muted text-[11px]">
              {useStore.getState().currentFilePath
                ? `Saving will overwrite "${useStore.getState().currentFilePath}".`
                : 'No file path is associated yet — saving will create a new file in the dataFLOU Sessions folder named after the session.'}
            </p>
            {newSessionSaveError && (
              <p
                className="text-[11px] px-2 py-1 rounded border"
                style={{
                  borderColor: 'rgb(var(--c-danger))',
                  color: 'rgb(var(--c-danger))'
                }}
              >
                Save failed: {newSessionSaveError}. Retry, or click No
                to discard and start fresh.
              </p>
            )}
            <div className="flex items-center justify-end gap-2 pt-1">
              <button
                className="btn text-[11px]"
                onClick={handleNewSessionCancel}
                disabled={newSessionSaving}
              >
                Cancel
              </button>
              <button
                className="btn text-[11px]"
                onClick={handleNewSessionDiscard}
                disabled={newSessionSaving}
                title="Discard the current session and start fresh"
              >
                No
              </button>
              <button
                className="btn-accent text-[11px]"
                onClick={handleNewSessionSave}
                disabled={newSessionSaving}
                title="Save the session, then start fresh"
              >
                {newSessionSaving ? 'Saving…' : 'Yes'}
              </button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  )
}
