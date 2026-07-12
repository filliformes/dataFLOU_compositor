// Electron main entry. Creates the window, wires IPC to the engine and sessions.
// MIDI is handled in the renderer via Web MIDI API — no native module needed.

import { app, BrowserWindow, ipcMain, shell, session as electronSession } from 'electron'
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
// — the second pass falls through to the OS close.
let appQuitting = false
// Hoisted here (rather than inside whenReady()) so the module-level
// before-quit / window-all-closed handlers can clear it alongside the
// rest of the shutdown work. Previously there were TWO before-quit
// handlers and the one that cleared this timer ran in isolation from
// the one that stopped the engine + autosave — so shutdown sequencing
// depended on registration order and ran stopAutosave twice.
let oscFlushTimer: ReturnType<typeof setInterval> | null = null
// Whether the previous run exited uncleanly. Detected when the autosave
// sentinel file still exists at startup; surfaced to the renderer on demand
// via the `session:crashCheck` IPC so it can offer a "Restore?" prompt.
let prevRunCrashed = false

/**
 * Single shutdown path. Safe to call twice (before-quit + window-all-closed
 * can both fire depending on platform / how the user exited), so every step
 * is idempotent. The old two-handler arrangement ran autosave.stopAutosave
 * twice on a normal quit — which wrote the .running sentinel-file unlink
 * twice and fired a final autosave snapshot twice.
 */
let shutdownComplete = false
function shutdown(): void {
  if (shutdownComplete) return
  shutdownComplete = true
  if (oscFlushTimer) {
    clearInterval(oscFlushTimer)
    oscFlushTimer = null
  }
  // Tear down the discovery listener so its UDP socket is released
  // before the process exits. Fire-and-forget — setEnabled(false)
  // returns a Promise but app shutdown can't wait on it.
  networkListener.setEnabled(false).catch(() => {
    /* ignore — already torn down */
  })
  engine.stop()
  autosave.stopAutosave()
}

function createWindow(): void {
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

  // Close intercept — send the "Save before quitting?" question to
  // the renderer first; renderer responds via `app:close-proceed`
  // which sets `appQuitting=true` and re-issues close(). On the
  // second close pass we let it through. Without this guard the X
  // button would slam the window shut with no chance to save.
  mainWindow.on('close', (e) => {
    if (appQuitting) return
    e.preventDefault()
    sendToRenderer('app:before-close')
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
  })
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
  // No-dialog save into `<userData>/sessions/<name>.dflou.json`.
  // Used by the renderer's Save-before-quit flow when no file path
  // is associated with the session yet.
  ipcMain.handle('session:saveToDefault', (_e, s: Session) =>
    sessionIO.saveToDefault(s as Session)
  )

  // App close coordination — renderer calls this from its modal's
  // Yes / No buttons. Setting `appQuitting=true` makes the next
  // window.close() bypass the preventDefault guard installed above.
  safeHandle('app:close-proceed', () => {
    appQuitting = true
    mainWindow?.close()
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
  safeHandle('autosave:crashCheck', async () => {
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
  // On non-macOS, closing the last window quits the app (teardown here).
  // On macOS, the standard pattern is to STAY resident in the dock: do
  // NOT shut down the engine / autosave / OSC socket, so reopening from
  // the dock ('activate' -> createWindow) reconnects to a still-live
  // engine (its webContents.send calls read the reassigned mainWindow).
  // Teardown for macOS happens in 'before-quit' (Cmd+Q). Previously this
  // ran shutdown() unconditionally, leaving a reopened window wired to a
  // dead engine (no OSC/MIDI, no autosave).
  if (process.platform !== 'darwin') {
    shutdown()
    app.quit()
  }
})

app.on('before-quit', shutdown)
