import { contextBridge, ipcRenderer } from 'electron'
import type {
  DiscoveredOscDevice,
  EngineState,
  ExposedApi,
  InstrumentTemplate,
  MidiErrorEvent,
  MidiSendEvent,
  NetworkListenerStatus,
  OscErrorEvent,
  OscEvent,
  ParameterTemplate,
  SavedScene,
  Session
} from '@shared/types'

const api: ExposedApi = {
  triggerCell: (sceneId, trackId) => ipcRenderer.invoke('engine:triggerCell', sceneId, trackId),
  stopCell: (sceneId, trackId) => ipcRenderer.invoke('engine:stopCell', sceneId, trackId),
  triggerScene: (sceneId, opts) => ipcRenderer.invoke('engine:triggerScene', sceneId, opts),
  stopScene: (sceneId) => ipcRenderer.invoke('engine:stopScene', sceneId),
  stopAll: () => ipcRenderer.invoke('engine:stopAll'),
  panic: () => ipcRenderer.invoke('engine:panic'),
  pauseSequence: () => ipcRenderer.invoke('engine:pauseSequence'),
  resumeSequence: () => ipcRenderer.invoke('engine:resumeSequence'),
  setTickRate: (hz) => ipcRenderer.invoke('engine:setTickRate', hz),
  updateSession: (s: Session) => ipcRenderer.invoke('engine:updateSession', s),
  sendMetaValue: (knobIdx, v) => ipcRenderer.invoke('engine:sendMetaValue', knobIdx, v),
  setSelectedCellForLive: (sel) =>
    ipcRenderer.invoke('engine:setSelectedCellForLive', sel),

  sessionSaveAs: (s: Session) => ipcRenderer.invoke('session:saveAs', s),
  sessionSave: (s: Session, path: string) => ipcRenderer.invoke('session:saveTo', s, path),
  sessionOpen: () => ipcRenderer.invoke('session:open'),

  autosaveCrashCheck: () => ipcRenderer.invoke('autosave:crashCheck'),
  autosaveList: () => ipcRenderer.invoke('autosave:list'),
  autosaveLoad: (path: string) => ipcRenderer.invoke('autosave:load', path),

  onEngineState: (cb) => {
    const h = (_e: Electron.IpcRendererEvent, s: EngineState): void => cb(s)
    ipcRenderer.on('engine:state', h)
    return () => ipcRenderer.off('engine:state', h)
  },
  onOscEvents: (cb) => {
    const h = (_e: Electron.IpcRendererEvent, batch: OscEvent[]): void => cb(batch)
    ipcRenderer.on('engine:oscEvents', h)
    return () => ipcRenderer.off('engine:oscEvents', h)
  },
  onOscErrors: (cb) => {
    const h = (_e: Electron.IpcRendererEvent, batch: OscErrorEvent[]): void =>
      cb(batch)
    ipcRenderer.on('engine:oscErrors', h)
    return () => ipcRenderer.off('engine:oscErrors', h)
  },
  onMidiEvents: (cb) => {
    const h = (_e: Electron.IpcRendererEvent, batch: MidiSendEvent[]): void =>
      cb(batch)
    ipcRenderer.on('engine:midiEvents', h)
    return () => ipcRenderer.off('engine:midiEvents', h)
  },
  onMidiErrors: (cb) => {
    const h = (_e: Electron.IpcRendererEvent, batch: MidiErrorEvent[]): void =>
      cb(batch)
    ipcRenderer.on('engine:midiErrors', h)
    return () => ipcRenderer.off('engine:midiErrors', h)
  },
  onMod1Live: (cb) => {
    const h = (
      _e: Electron.IpcRendererEvent,
      sample: import('@shared/types').Mod1LiveSample | null
    ): void => cb(sample)
    ipcRenderer.on('engine:mod1Live', h)
    return () => ipcRenderer.off('engine:mod1Live', h)
  },

  // ── MIDI output ──────────────────────────────────────────────────
  midiListPorts: () => ipcRenderer.invoke('midi:listPorts'),

  // ── Network discovery ────────────────────────────────────────────
  networkSetEnabled: (enabled, port) =>
    ipcRenderer.invoke('network:setEnabled', enabled, port),
  networkList: () => ipcRenderer.invoke('network:list'),
  networkClear: () => ipcRenderer.invoke('network:clear'),
  networkSetForwardTargets: (targets) =>
    ipcRenderer.invoke('network:setForwardTargets', targets),
  // v0.5.10 -- HW Mode Suppress diagnostic panel polling
  networkGetForwardDiag: () => ipcRenderer.invoke('network:getForwardDiag'),
  networkClearForwardDiag: () =>
    ipcRenderer.invoke('network:clearForwardDiag'),
  // v0.5.10 -- package version (sourced from package.json via
  // Electron's app.getVersion()). Renderer reads this once on mount
  // to populate the window title.
  appGetVersion: () => ipcRenderer.invoke('app:getVersion'),
  onNetworkDevices: (cb) => {
    const h = (
      _e: Electron.IpcRendererEvent,
      payload: { status: NetworkListenerStatus; devices: DiscoveredOscDevice[] }
    ): void => cb(payload)
    ipcRenderer.on('network:devices', h)
    return () => ipcRenderer.off('network:devices', h)
  },

  // ── Scene library ────────────────────────────────────────────────
  sceneLibraryList: () => ipcRenderer.invoke('sceneLibrary:list'),
  sceneLibrarySave: (scene) => ipcRenderer.invoke('sceneLibrary:save', scene),
  sceneLibraryRemove: (id) => ipcRenderer.invoke('sceneLibrary:remove', id),
  onSceneLibrary: (cb) => {
    const h = (_e: Electron.IpcRendererEvent, scenes: SavedScene[]): void => cb(scenes)
    ipcRenderer.on('scene-library:changed', h)
    return () => ipcRenderer.off('scene-library:changed', h)
  },

  // ── Pool library ─────────────────────────────────────────────────
  poolLibraryGet: () => ipcRenderer.invoke('pool-library:get'),
  poolLibrarySetAll: (payload) =>
    ipcRenderer.invoke('pool-library:setAll', payload),
  onPoolLibrary: (cb) => {
    const h = (
      _e: Electron.IpcRendererEvent,
      payload: { templates: InstrumentTemplate[]; parameters: ParameterTemplate[] }
    ): void => cb(payload)
    ipcRenderer.on('pool-library:changed', h)
    return () => ipcRenderer.off('pool-library:changed', h)
  },

  // ── App lifecycle ────────────────────────────────────────────────
  // Save without prompting — writes to the app's Sessions folder.
  // Returns the absolute path the file landed on (or null on error).
  sessionSaveToDefault: (s) => ipcRenderer.invoke('session:saveToDefault', s),
  // Renderer signals main: "ok to close the window, I'm done with
  // the Save-before-quit modal." Main sets its appQuitting flag
  // and re-issues window.close().
  appCloseProceed: () => ipcRenderer.invoke('app:close-proceed'),
  // Main asks renderer to show the save-before-quit modal. The
  // renderer's listener replies by calling `appCloseProceed`.
  onAppBeforeClose: (cb) => {
    const h = (): void => cb()
    ipcRenderer.on('app:before-close', h)
    return () => ipcRenderer.off('app:before-close', h)
  }
}

contextBridge.exposeInMainWorld('api', api)

declare global {
  interface Window {
    api: ExposedApi
  }
}
