import { contextBridge, ipcRenderer } from 'electron'
import type { EngineState, ExposedApi, OscEvent, Session } from '@shared/types'

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
  }
}

contextBridge.exposeInMainWorld('api', api)

declare global {
  interface Window {
    api: ExposedApi
  }
}
