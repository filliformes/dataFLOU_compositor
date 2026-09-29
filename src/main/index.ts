// Electron main entry. Creates the window, wires IPC to the engine and sessions.
// MIDI INPUT (learn, triggers, Meta knobs) is Web MIDI in the renderer;
// MIDI OUTPUT is native (@julusian/midi, see midiOut.ts) driven by the engine.

import {
  app,
  BrowserWindow,
  ipcMain,
  Menu,
  shell,
  session as electronSession,
  type MenuItemConstructorOptions
} from 'electron'
import { join } from 'path'
import type {
  EngineState,
  MidiErrorEvent,
  MidiSendEvent,
  OscErrorEvent,
  OscEvent,
  OscForwardTarget,
  Session
} from '@shared/types'
import { SceneEngine } from './engine'
import * as sessionIO from './session'
import * as autosave from './autosave'
import { OscNetworkListener } from './oscNetwork'
import { OscSubscriptionManager } from './oscSubscriptions'
import { SceneLibrary } from './sceneLibrary'
import { PoolLibrary } from './poolLibrary'

let mainWindow: BrowserWindow | null = null

// Safe IPC push to the renderer. `mainWindow?.` only guards NULL — but
// between the window's webContents being torn down and the 'closed'
// event firing (and, on macOS, while the engine keeps ticking with the
// window closed — see window-all-closed), `mainWindow` is a truthy but
// DESTROYED reference, so `mainWindow.webContents.send()` throws
// "Object has been destroyed" from the engine tick (emitState). Guard
// both the window and its webContents with isDestroyed() before every
// send. Fixes the macOS quit/close crash.
function sendToRenderer(channel: string, ...args: unknown[]): void {
  if (
    mainWindow &&
    !mainWindow.isDestroyed() &&
    !mainWindow.webContents.isDestroyed()
  ) {
    mainWindow.webContents.send(channel, ...args)
  }
}

const engine = new SceneEngine()
// Passive OSC discovery listener. Bound lazily — stays closed until
// the renderer's Pool drawer Network tab flips it on, so we don't fight
// other apps for port 9000 unless the user actually asked for it.
const networkListener = new OscNetworkListener()
// (v0.6.6) Device subscriptions (Pandore IMU, …) — asks devices to stream
// to the listener's current port, heartbeats, re-subscribes on recovery.
const oscSubs = new OscSubscriptionManager(() => {
  const s = networkListener.getStatus()
  return { enabled: s.enabled, port: s.port }
})
// Persistent saved-scenes library — lives in
// `<userData>/scene-library.json`, separate from any session file
// so the user can drag scenes across sessions.
const sceneLibrary = new SceneLibrary()
// Persistent User Pool library — the user's authored Instrument
// Templates + Parameter Templates, mirrored across every session.
// Lives at `<userData>/pool-library.json`. Renderer pushes the
// FULL current User-entry set on every store change.
const poolLibrary = new PoolLibrary()
// Set true once the renderer signals "ok to close" via the
// `app:close-proceed` IPC. The first window 'close' event is
// preempted (e.preventDefault()) so the renderer can show its
// Save-before-quit modal; on user choice the renderer calls
// proceed-close which flips this flag and re-issues window.close()
// — the second pass falls through to the OS close. Reset in
// createWindow so a window reopened from the macOS dock prompts again.
let appQuitting = false
// Set by 'before-quit' (Cmd+Q, app.quit()), which fires BEFORE the
// window 'close' events. Each close event consumes it into
// `pendingCloseIsQuit`, so a quit the user cancels in the save prompt
// can't turn a later plain window-close into a full quit.
let quitRequested = false
// Whether the close currently awaiting the renderer's answer was part
// of a quit (→ app.quit() after Save/Discard) or a plain window close
// (→ macOS keeps the app + engine resident in the dock).
let pendingCloseIsQuit = false
// Watchdog for the save prompt: the preload acks `app:before-close` as
// soon as the renderer's listener has run. No ack within this window
// (renderer hung / never mounted its listener) → close as Discard, so
// the window can't become unclosable.
const CLOSE_ACK_TIMEOUT_MS = 3000
let closeAckTimer: ReturnType<typeof setTimeout> | null = null
// Hoisted here (rather than inside whenReady()) so the module-level
// will-quit handler can clear it alongside the rest of the shutdown
// work. Previously there were TWO before-quit handlers and the one that
// cleared this timer ran in isolation from the one that stopped the
// engine + autosave — so shutdown sequencing depended on registration
// order and ran stopAutosave twice.
let oscFlushTimer: ReturnType<typeof setInterval> | null = null
// Whether the previous run exited uncleanly. Detected when the autosave
// sentinel file still exists at startup; surfaced to the renderer on demand
// via the `autosave:crashCheck` IPC so it can offer a "Restore?" prompt.
// Reported for the FIRST page load only (see crashCheckAnswered).
let prevRunCrashed = false
// Set once the renderer has asked crashCheck. The next page load (window
// reopened from the dock, dev reload) clears prevRunCrashed so the
// restore prompt doesn't reappear for a crash already dealt with. Keyed
// to page loads rather than cleared on the first call so React
// StrictMode's double-mount in dev still sees `crashed: true`.
let crashCheckAnswered = false

// One instance only: two processes would share (and fight over) the
// `.running` crash marker, the autosave folder and the scene / pool
// library files. A second launch just focuses the running window.
const hasSingleInstanceLock = app.requestSingleInstanceLock()
if (!hasSingleInstanceLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.show()
      mainWindow.focus()
    } else if (app.isReady()) {
      // macOS: app resident in the dock with its window closed.
      createWindow()
    }
  })
}

/**
 * Single shutdown path, run on 'will-quit' — i.e. only once the quit is
 * certain (every window has closed, the save prompt was answered).
 * Running it on 'before-quit' tore the engine / OSC / autosave down and
 * deleted the crash marker BEFORE the save prompt, so a Cancel left a
 * live-looking app with a dead engine. Idempotent.
 */
let shutdownComplete = false
function shutdown(): void {
  if (shutdownComplete) return
  shutdownComplete = true
  // A non-lock-holding second instance never started anything — and
  // must not delete the running instance's crash marker.
  if (!hasSingleInstanceLock) return
  if (closeAckTimer) {
    clearTimeout(closeAckTimer)
    closeAckTimer = null
  }
  if (oscFlushTimer) {
    clearInterval(oscFlushTimer)
    oscFlushTimer = null
  }
  // Unsubscribe from devices (best effort — their TTL covers the rest).
  oscSubs.stop()
  // Tear down the discovery listener so its UDP socket is released
  // before the process exits. Fire-and-forget — setEnabled(false)
  // returns a Promise but app shutdown can't wait on it.
  networkListener.setEnabled(false).catch(() => {
    /* ignore — already torn down */
  })
  engine.stop()
  autosave.stopAutosave()
}

/**
 * The renderer answered the save prompt (Save done / Discard), or can't
 * answer at all (watchdog / renderer gone): let the window close. Quit
 * the app for a Cmd+Q-initiated close and on Windows / Linux; on macOS a
 * plain window close keeps the app + engine alive in the dock.
 */
function proceedWithClose(): void {
  if (closeAckTimer) {
    clearTimeout(closeAckTimer)
    closeAckTimer = null
  }
  const shouldQuit = pendingCloseIsQuit || process.platform !== 'darwin'
  pendingCloseIsQuit = false
  appQuitting = true
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.close()
  if (shouldQuit) app.quit()
}

/**
 * Packaged builds: the default menu's View > Reload (Ctrl/Cmd+R),
 * Force Reload and Toggle DevTools would wipe the live renderer state
 * mid-show. Rebuild it without those; keep the macOS app menu, the Edit
 * roles (copy / paste / undo / select-all accelerators in text fields
 * depend on them), zoom / full screen and the Window menu. Dev builds
 * keep Electron's default menu.
 */
function installPackagedMenu(): void {
  const template: MenuItemConstructorOptions[] = [
    ...(process.platform === 'darwin' ? [{ role: 'appMenu' as const }] : []),
    { role: 'fileMenu' },
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' }
      ]
    },
    { role: 'windowMenu' }
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

function createWindow(): void {
  appQuitting = false
  // v0.5.10 -- bake the package version into the window title.
  // The renderer further appends the loaded session name via
  // `document.title`, which Electron auto-syncs back to the
  // window chrome.
  const appVersion = app.getVersion()
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1024,
    minHeight: 640,
    show: false,
    backgroundColor: '#1d1d1d',
    autoHideMenuBar: true,
    title: `dataFLOU_compositor v${appVersion}`,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  mainWindow.on('ready-to-show', () => mainWindow?.show())

  const win = mainWindow
  // Set when this window's renderer process dies — it can never answer
  // the save prompt, so a close must go straight through.
  let rendererGone = false

  // Close intercept — send the "Save before quitting?" question to
  // the renderer first; renderer responds via `app:close-proceed`
  // which sets `appQuitting=true` and re-issues close(). On the
  // second close pass we let it through. Without this guard the X
  // button would slam the window shut with no chance to save.
  win.on('close', (e) => {
    if (appQuitting) return
    // Consume the quit flag for THIS close cycle (see quitRequested).
    pendingCloseIsQuit = quitRequested
    quitRequested = false
    const wc = win.webContents
    if (rendererGone || wc.isDestroyed() || wc.isCrashed()) {
      // Nobody can show the prompt — treat as Discard and let it close.
      return
    }
    e.preventDefault()
    sendToRenderer('app:before-close')
    if (closeAckTimer) clearTimeout(closeAckTimer)
    closeAckTimer = setTimeout(() => {
      closeAckTimer = null
      console.warn(
        `[main] renderer did not acknowledge app:before-close within ${CLOSE_ACK_TIMEOUT_MS} ms — closing without saving`
      )
      proceedWithClose()
    }, CLOSE_ACK_TIMEOUT_MS)
  })

  win.webContents.on('render-process-gone', (_e, details) => {
    console.error(
      `[main] renderer process gone (${details.reason}, exit code ${details.exitCode})`
    )
    rendererGone = true
    // A save prompt it hadn't acknowledged yet will never be answered.
    if (closeAckTimer) proceedWithClose()
  })

  // Block in-window navigation — e.g. a .json file dropped on the window
  // would otherwise replace the app with the file's text, losing the
  // live session. http(s) links open in the system browser instead. A
  // same-URL navigation (dev-server full reload) is allowed.
  win.webContents.on('will-navigate', (details) => {
    if (details.url === win.webContents.getURL()) return
    details.preventDefault()
    if (/^https?:/i.test(details.url)) void shell.openExternal(details.url)
  })

  // Crash-restore prompt is offered on the first page load only: any
  // later load of a renderer (dock reopen, reload) reports no crash.
  win.webContents.on('did-start-loading', () => {
    if (crashCheckAnswered) prevRunCrashed = false
  })

  // Null the reference once the window is gone so sendToRenderer
  // short-circuits (and macOS 'activate' can recreate it cleanly).
  // The isDestroyed() guard in sendToRenderer covers the brief window
  // between webContents teardown and this event; this handler is the
  // steady-state half of the same fix.
  mainWindow.on('closed', () => {
    mainWindow = null
  })

  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  if (process.env.ELECTRON_RENDERER_URL) {
    mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

app.whenReady().then(async () => {
  // Second instance: already quitting (see requestSingleInstanceLock).
  if (!hasSingleInstanceLock) return

  if (app.isPackaged) installPackagedMenu()

  // Allow Web MIDI in the renderer.
  electronSession.defaultSession.setPermissionRequestHandler((_wc, permission, cb) => {
    if (permission === 'midi' || permission === 'midiSysex') return cb(true)
    cb(false)
  })

  await engine.start()

  // Autosave + crash detection. startAutosave() writes the sentinel file and
  // schedules the 60s save loop; we stash `crashed` for the renderer to read.
  prevRunCrashed = autosave.startAutosave().crashed

  engine.setOnStateChange((s: EngineState) => {
    sendToRenderer('engine:state', s)
  })

  // Two-stage modulator — push the engine's per-tick effective
  // Modulation 1 for the cell the Inspector is watching. Throttled
  // engine-side to ~30 Hz; this just forwards each sample to the
  // renderer. `null` samples (selection cleared) flow through too so
  // the Inspector knows to drop stale overlay values.
  engine.setOnMod1Live((sample) => {
    sendToRenderer('engine:mod1Live', sample)
  })

  // Motion Loop hands-free OSC trigger (v0.6.x) — the engine fires this on
  // a rising edge of the configured trigger address (e.g. the antenna's
  // /mpu/btn1); the renderer toggles record on the focused scene.
  engine.setOnMotionLoopTrigger(() => {
    sendToRenderer('engine:motionLoopTrigger')
  })

  // OSC monitor — batch outgoing sends and flush every 50ms to the renderer.
  // Guards against IPC floods (120 Hz × many cells). A hard cap keeps us safe
  // when a burst overflows one flush window; overflow is dropped with a
  // one-off warning per flush to keep the UI responsive.
  let oscBuffer: OscEvent[] = []
  let oscInBuffer: OscEvent[] = []
  let oscErrBuffer: OscErrorEvent[] = []
  let midiBuffer: MidiSendEvent[] = []
  let midiErrBuffer: MidiErrorEvent[] = []
  const OSC_BUFFER_MAX = 2000
  const MIDI_BUFFER_MAX = 2000
  engine.setOnOscSend((e) => {
    if (oscBuffer.length < OSC_BUFFER_MAX) oscBuffer.push(e)
  })
  // (v0.6.4) Incoming OSC — every received message, same cap + cadence as
  // outgoing. Feeds the Monitor "OSC In" column + Connection Health.
  networkListener.setOnIncoming((e) => {
    if (oscInBuffer.length < OSC_BUFFER_MAX) oscInBuffer.push(e)
    oscSubs.handleIncoming(e)
  })
  // dataFLOU's own send sockets — their packets looping back through the
  // listener are "self", not a device (see oscNetwork isSelfSource).
  networkListener.setSelfPortsProvider(() => [
    engine.getOscLocalPort(),
    oscSubs.getLocalPort()
  ])
  // Subscribe / heartbeat sends show in the Monitor's OSC Out column.
  oscSubs.setOnSent((e) => {
    if (oscBuffer.length < OSC_BUFFER_MAX) oscBuffer.push(e)
  })
  oscSubs.start()
  // (v0.6.4) Derived Parameters also appear in the OSC In stream so the
  // computed synthetic address is as visible as a real one.
  engine.setOnDerived((e) => {
    if (oscInBuffer.length < OSC_BUFFER_MAX) oscInBuffer.push(e)
  })
  engine.setOnOscError((e) => {
    // Much lower cap on errors — if something is pathologically wrong
    // (destination down, UDP socket thrashing) we don't need to flood
    // the renderer with thousands of identical entries. Rate-limit in
    // osc.ts already throttles the console log; cap here is a safety
    // net for the IPC channel.
    if (oscErrBuffer.length < 256) oscErrBuffer.push(e)
  })
  // Same batching + caps for the MIDI side so a CC sweep at 120 Hz ×
  // multiple destinations can't flood IPC.
  engine.setOnMidiSend((e) => {
    if (midiBuffer.length < MIDI_BUFFER_MAX) midiBuffer.push(e)
  })
  engine.setOnMidiError((e) => {
    if (midiErrBuffer.length < 256) midiErrBuffer.push(e)
  })
  oscFlushTimer = setInterval(() => {
    if (oscBuffer.length > 0) {
      const batch = oscBuffer
      oscBuffer = []
      sendToRenderer('engine:oscEvents', batch)
    }
    if (oscInBuffer.length > 0) {
      const batch = oscInBuffer
      oscInBuffer = []
      sendToRenderer('engine:oscInEvents', batch)
    }
    if (oscErrBuffer.length > 0) {
      const errBatch = oscErrBuffer
      oscErrBuffer = []
      sendToRenderer('engine:oscErrors', errBatch)
    }
    if (midiBuffer.length > 0) {
      const batch = midiBuffer
      midiBuffer = []
      sendToRenderer('engine:midiEvents', batch)
    }
    if (midiErrBuffer.length > 0) {
      const errBatch = midiErrBuffer
      midiErrBuffer = []
      sendToRenderer('engine:midiErrors', errBatch)
    }
    // Piggy-back the discovery flush on the same timer so the Network
    // tab gets fresh device updates at ~20Hz without a second loop.
    // `flush()` is a no-op when nothing changed since the last call.
    networkListener.flush()
  }, 50)

  // Push channel — the listener calls this whenever the device map
  // changes. flush() routes through here on its 50ms cadence.
  networkListener.setOnUpdate((payload) => {
    sendToRenderer('network:devices', payload)
  })

  // Hardware Mode — pipe every incoming OSC message into the engine
  // so it can react at packet-arrival time (sub-millisecond, not the
  // 50ms device-map flush). The engine filters by which templates
  // have Hardware Mode enabled + bound to this device's ip:port —
  // most packets are no-ops and return early.
  networkListener.setOnMessage((ip, port, address, numericArgs) => {
    engine.handleHardwareInput(ip, port, address, numericArgs)
  })

  // Forward-path suppression — when Hardware Mode is consuming a
  // controller's OSC, the raw byte-forward path MUST skip those
  // packets. Otherwise downstream consumers (Max, PD) receive both
  // the engine's clean catch-mode emission AND the raw passthrough
  // for the same OSC address, producing flicker (two competing
  // values per packet) and message-queue buildup that crashes the
  // downstream after ~5 min of sustained dual-emission. The hook
  // returns false (fast-path) when no template has HW Mode enabled,
  // so existing forward-only setups are unaffected.
  networkListener.setOnShouldSuppressForward((ip, port) =>
    engine.isHardwareModeSource(ip, port)
  )

  // Wrapper that catches thrown errors inside an IPC handler, logs
  // them with the channel name, and returns undefined to the renderer
  // instead of propagating a generic IPC failure. Without this, a
  // malformed session payload or an engine bug could leave engine
  // state half-mutated AND surface as an unhelpful "An object could
  // not be cloned" error on the renderer side.
  function safeHandle(
    channel: string,
    handler: (...args: unknown[]) => unknown
  ): void {
    ipcMain.handle(channel, async (event, ...args) => {
      try {
        return await handler(event, ...args)
      } catch (e) {
        console.error(`[ipc] ${channel} threw:`, (e as Error).message)
        return undefined
      }
    })
  }

  // ---------- IPC: Engine ----------
  safeHandle('engine:triggerCell', (_e, sceneId, trackId) =>
    engine.triggerCell(sceneId as string, trackId as string)
  )
  safeHandle('engine:stopCell', (_e, sceneId, trackId) =>
    engine.stopCell(sceneId as string, trackId as string)
  )
  safeHandle('engine:triggerScene', (_e, sceneId, opts) =>
    engine.triggerScene(
      sceneId as string,
      opts as { morphMs?: number; sourceSlotIdx?: number | null } | undefined
    )
  )
  safeHandle('engine:stopScene', (_e, sceneId) => engine.stopScene(sceneId as string))
  safeHandle('engine:stopAll', () => engine.stopAll())
  safeHandle('engine:panic', () => engine.panic())
  safeHandle('engine:pauseSequence', () => engine.pauseSequence())
  safeHandle('engine:resumeSequence', () => engine.resumeSequence())
  safeHandle('engine:setTickRate', (_e, hz) => engine.setTickRate(hz as number))
  safeHandle('engine:updateSession', (_e, s) => {
    // Snapshot to autosave FIRST so even if the engine bails partway
    // through propagating defaults, the next 60s tick captures the
    // renderer's intent. Engine call comes second.
    autosave.setCurrentSession(s as Session)
    engine.updateSession(s as Session)
    oscSubs.update((s as Session).oscSubscriptions)
  })
  safeHandle('engine:sendMetaValue', (_e, knobIdx, v) =>
    engine.sendMetaValue(knobIdx as number, v as number)
  )
  // Inspector selection feed for the live Modulation 1 stream. `null`
  // tells the engine to stop emitting (Inspector closed / cleared).
  safeHandle('engine:setSelectedCellForLive', (_e, sel) =>
    engine.setSelectedCellForLive(
      sel as { sceneId: string; trackId: string } | null
    )
  )

  // ---------- IPC: Session I/O ----------
  // Save/open paths DO want to propagate errors back to the renderer
  // so the user sees "could not save" instead of a silent no-op. We
  // still wrap with safeHandle but rethrow inside — Electron's handle
  // promise rejection mechanism still forwards the error message.
  ipcMain.handle('session:saveAs', (_e, s: Session) => sessionIO.saveAs(mainWindow, s))
  ipcMain.handle('session:saveTo', (_e, s: Session, path: string) => sessionIO.saveTo(path, s))
  // No-dialog save into the default Sessions folder (see
  // session.ts sessionsFolderPath). Used by the renderer's
  // Save-before-quit flow when no file path is associated with the
  // session yet.
  ipcMain.handle('session:saveToDefault', (_e, s: Session) =>
    sessionIO.saveToDefault(s as Session)
  )

  // App close coordination — renderer calls this from its modal's
  // Yes / No buttons. Setting `appQuitting=true` makes the next
  // window.close() bypass the preventDefault guard installed above;
  // a Cmd+Q-initiated close (or any close off macOS) then quits.
  safeHandle('app:close-proceed', () => {
    proceedWithClose()
  })
  // Sent by the preload as soon as the renderer's app:before-close
  // listener has run (the modal is up) — disarms the close watchdog.
  // From then on the prompt waits for the user as long as it takes.
  ipcMain.on('app:before-close-ack', () => {
    if (closeAckTimer) {
      clearTimeout(closeAckTimer)
      closeAckTimer = null
    }
  })
  ipcMain.handle('session:open', async () => {
    const result = await sessionIO.open(mainWindow)
    // (Bug 5) Mark the upcoming session push as a real LOAD so the
    // engine primes HW catch state from `hardwareState` exactly once.
    // Only when a session was actually returned (user didn't cancel the
    // dialog and the file parsed).
    if (result) engine.markSessionLoaded()
    return result
  })

  // ---------- IPC: Network discovery ----------
  // Pool drawer's Network tab uses these to bind/unbind the passive
  // listener, fetch the initial device snapshot, and clear the cache.
  safeHandle('network:setEnabled', (_e, enabled, port) =>
    networkListener.setEnabled(enabled as boolean, port as number | undefined)
  )
  safeHandle('network:list', () => ({
    status: networkListener.getStatus(),
    devices: networkListener.list()
  }))
  safeHandle('network:clear', () => networkListener.clear())
  // OSC forwarding — the renderer pushes the current set of targets
  // any time the user adds/removes/edits/toggles one. Main re-applies
  // synchronously; the next received packet goes through the new list.
  safeHandle('network:setForwardTargets', (_e, targets) => {
    networkListener.setForwardTargets(
      Array.isArray(targets) ? (targets as OscForwardTarget[]) : []
    )
  })
  // v0.5.10 -- HW Mode Suppress diagnostic panel. Renderer polls
  // these at ~2 Hz while the Pool > Network tab's panel is visible.
  // Cheap: returns a flat array from a Map of at most MAX_DEVICES (64)
  // entries.
  safeHandle('network:getForwardDiag', () => networkListener.getForwardDiag())
  safeHandle('network:clearForwardDiag', () => networkListener.clearForwardDiag())
  // (v0.6.6) Device subscriptions — the list arrives with the session.
  safeHandle('oscSubs:getStatus', () => oscSubs.getStatus())
  safeHandle('oscSubs:probe', (_e, opts) =>
    oscSubs.probe(opts as { network: boolean; port: number; replyPort: number })
  )
  safeHandle('oscSubs:resubscribe', (_e, id) => oscSubs.resubscribe(id as string))
  // v0.5.10 -- expose package version to the renderer so it can
  // include it in `document.title` (which Electron auto-syncs back
  // to the window chrome). Sync to a Promise return so the renderer
  // can render before this resolves and update on resolution.
  safeHandle('app:getVersion', () => app.getVersion())

  // ---------- IPC: Input Conditioning + State Triggers (v0.6) ------
  // Scope tap: a UI surface polls getScope with the (template, address,
  // slot) it wants at ~15 Hz; the poll registers/refreshes that watch
  // (TTL-kept, multiple watchers supported) and returns its ring
  // buffer. Stop polling → the watch expires → zero per-packet cost.
  safeHandle('conditioner:getScope', (_e, watch, windowMs) =>
    engine.getConditionerScope(
      watch && typeof watch === 'object'
        ? (watch as { templateId: string; address: string; slot: number })
        : null,
      typeof windowMs === 'number' ? windowMs : undefined
    )
  )
  // State Triggers: live match scores + active flags (polled ~10 Hz
  // while the section is expanded) and the learn-by-demonstration
  // recording round-trip (resolves with centroid/variance or null).
  safeHandle('stateTrigger:getLive', () => engine.getStateTriggerLive())
  safeHandle('stateTrigger:record', (_e, templateId, stateId, durationMs) =>
    engine.recordStateTrigger(
      String(templateId),
      String(stateId),
      Number(durationMs) || 2000
    )
  )
  // Pose Sequences (v0.6.5): rewind a sequence to its first waypoint
  // (also clears a completed non-looping phrase's parked state).
  safeHandle('stateTrigger:resetSeq', (_e, templateId, seqId) => {
    engine.resetPoseSequence(String(templateId), String(seqId))
    return true
  })
  // Pause/resume a sequence's live firing while the companion recorder
  // cycles through its poses (so a hands-free record stays silent).
  safeHandle('stateTrigger:suppressSeq', (_e, templateId, seqId, on) => {
    engine.setPoseSequenceSuppressed(String(templateId), String(seqId), on === true)
    return true
  })
  // Motion Loop (v0.6.x): arm a scene for hardware capture, then drain
  // the recorded buffers back to the renderer on stop.
  safeHandle('motionLoop:startRecord', (_e, sceneId) =>
    engine.startMotionLoopRecord(String(sceneId))
  )
  safeHandle('motionLoop:stopRecord', () => engine.stopMotionLoopRecord())
  // (v0.6.4) Derived Parameter live values, polled by the inspector.
  safeHandle('derived:getLive', () => engine.getDerivedLive())

  // ---------- IPC: MIDI ----------
  // Enumerate currently-visible MIDI output ports. Renderer calls
  // this on mount + every time it opens the MIDI section of a cell
  // (so freshly-attached devices show up without a restart).
  safeHandle('midi:listPorts', () => engine.listMidiPorts())

  // ---------- IPC: Scene library ----------
  // The Pool's Scenes tab reads the saved-scene library from disk
  // on mount + subscribes to updates via `scene-library:changed`.
  // Save / Remove go through atomic writes (.tmp + rename).
  safeHandle('sceneLibrary:list', () => sceneLibrary.list())
  safeHandle('sceneLibrary:save', (_e, scene) =>
    sceneLibrary.save(scene as import('@shared/types').SavedScene)
  )
  safeHandle('sceneLibrary:remove', (_e, id) => sceneLibrary.remove(id as string))
  sceneLibrary.setOnChange((scenes) => {
    sendToRenderer('scene-library:changed', scenes)
  })

  // ---------- IPC: Pool library ----------
  // Renderer fetches the persisted User-Pool entries once on mount
  // (via `pool-library:get`) then pushes the full set back on every
  // change via `pool-library:setAll`. Pool library notifications
  // also propagate to OTHER renderers via `pool-library:changed`
  // so multi-window installations stay in sync (no current use,
  // but cheap to support).
  safeHandle('pool-library:get', () => poolLibrary.get())
  safeHandle('pool-library:setAll', (_e, payload) =>
    poolLibrary.setAll(
      payload as import('./poolLibrary').PoolLibraryPayload
    )
  )
  poolLibrary.setOnChange((payload) => {
    sendToRenderer('pool-library:changed', payload)
  })

  // ---------- IPC: Autosave / crash recovery ----------
  // `crashCheck` — renderer calls this on mount to decide whether to show
  // the restore prompt. Returns the flag + the latest autosave entries.
  // `crashed` is only reported to the first page load (see
  // crashCheckAnswered + the window's did-start-loading hook).
  safeHandle('autosave:crashCheck', async () => {
    crashCheckAnswered = true
    const entries = await autosave.listAutosaves()
    return { crashed: prevRunCrashed, entries }
  })
  // Load DOES want to propagate failures (so the user sees the parse
  // error in the integrity dialog). Leave it on the raw ipcMain.handle.
  ipcMain.handle('autosave:load', async (_e, path: string) => {
    const session = await autosave.loadAutosave(path)
    // (Bug 5) A crash-recovery restore is a real session LOAD — prime
    // the engine's HW catch state from `hardwareState` exactly once on
    // the renderer's follow-up updateSession.
    engine.markSessionLoaded()
    return session
  })

  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  // On non-macOS, closing the last window quits the app (teardown runs
  // on will-quit). On macOS, the standard pattern is to STAY resident in
  // the dock: do NOT shut down the engine / autosave / OSC socket, so
  // reopening from the dock ('activate' -> createWindow) reconnects to a
  // still-live engine (its webContents.send calls read the reassigned
  // mainWindow). Previously this ran shutdown() unconditionally, leaving
  // a reopened window wired to a dead engine (no OSC/MIDI, no autosave).
  if (process.platform !== 'darwin') app.quit()
})

// 'before-quit' fires BEFORE the windows are asked to close — i.e. before
// the save prompt, which can still cancel the quit. Only record intent.
app.on('before-quit', () => {
  quitRequested = true
})

// 'will-quit' fires once every window has closed and the quit is
// certain — the one safe place to tear the engine / OSC / autosave down.
app.on('will-quit', shutdown)
