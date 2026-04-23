// Electron main entry. Creates the window, wires IPC to the engine and sessions.
// MIDI is handled in the renderer via Web MIDI API — no native module needed.

import { app, BrowserWindow, ipcMain, shell, session as electronSession } from 'electron'
import { join } from 'path'
import type { EngineState, OscEvent, Session } from '@shared/types'
import { SceneEngine } from './engine'
import * as sessionIO from './session'
import * as autosave from './autosave'

let mainWindow: BrowserWindow | null = null
const engine = new SceneEngine()
// Whether the previous run exited uncleanly. Detected when the autosave
// sentinel file still exists at startup; surfaced to the renderer on demand
// via the `session:crashCheck` IPC so it can offer a "Restore?" prompt.
let prevRunCrashed = false

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1024,
    minHeight: 640,
    show: false,
    backgroundColor: '#1d1d1d',
    autoHideMenuBar: true,
    title: 'dataFLOU_compositor',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  mainWindow.on('ready-to-show', () => mainWindow?.show())

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
    mainWindow?.webContents.send('engine:state', s)
  })

  // OSC monitor — batch outgoing sends and flush every 50ms to the renderer.
  // Guards against IPC floods (120 Hz × many cells). A hard cap keeps us safe
  // when a burst overflows one flush window; overflow is dropped with a
  // one-off warning per flush to keep the UI responsive.
  let oscBuffer: OscEvent[] = []
  const OSC_BUFFER_MAX = 2000
  engine.setOnOscSend((e) => {
    if (oscBuffer.length < OSC_BUFFER_MAX) oscBuffer.push(e)
  })
  const oscFlushTimer = setInterval(() => {
    if (oscBuffer.length === 0) return
    const batch = oscBuffer
    oscBuffer = []
    mainWindow?.webContents.send('engine:oscEvents', batch)
  }, 50)
  app.on('before-quit', () => clearInterval(oscFlushTimer))

  // ---------- IPC: Engine ----------
  ipcMain.handle('engine:triggerCell', (_e, sceneId: string, trackId: string) => {
    engine.triggerCell(sceneId, trackId)
  })
  ipcMain.handle('engine:stopCell', (_e, sceneId: string, trackId: string) => {
    engine.stopCell(sceneId, trackId)
  })
  ipcMain.handle('engine:triggerScene', (_e, sceneId: string, opts?: { morphMs?: number }) => {
    engine.triggerScene(sceneId, opts)
  })
  ipcMain.handle('engine:stopScene', (_e, sceneId: string) => {
    engine.stopScene(sceneId)
  })
  ipcMain.handle('engine:stopAll', () => engine.stopAll())
  ipcMain.handle('engine:panic', () => engine.panic())
  ipcMain.handle('engine:pauseSequence', () => engine.pauseSequence())
  ipcMain.handle('engine:resumeSequence', () => engine.resumeSequence())
  ipcMain.handle('engine:setTickRate', (_e, hz: number) => engine.setTickRate(hz))
  ipcMain.handle('engine:updateSession', (_e, s: Session) => {
    engine.updateSession(s)
    // Mirror to autosave so the 60s timer always has the freshest session.
    autosave.setCurrentSession(s)
  })
  ipcMain.handle('engine:sendMetaValue', (_e, knobIdx: number, v: number) =>
    engine.sendMetaValue(knobIdx, v)
  )

  // ---------- IPC: Session I/O ----------
  ipcMain.handle('session:saveAs', (_e, s: Session) => sessionIO.saveAs(mainWindow, s))
  ipcMain.handle('session:saveTo', (_e, s: Session, path: string) => sessionIO.saveTo(path, s))
  ipcMain.handle('session:open', () => sessionIO.open(mainWindow))

  // ---------- IPC: Autosave / crash recovery ----------
  // `crashCheck` — renderer calls this on mount to decide whether to show
  // the restore prompt. Returns the flag + the latest autosave entries.
  ipcMain.handle('autosave:crashCheck', async () => {
    const entries = await autosave.listAutosaves()
    return { crashed: prevRunCrashed, entries }
  })
  ipcMain.handle('autosave:list', () => autosave.listAutosaves())
  ipcMain.handle('autosave:load', (_e, path: string) => autosave.loadAutosave(path))

  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  engine.stop()
  autosave.stopAutosave()
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', () => {
  engine.stop()
  autosave.stopAutosave()
})
