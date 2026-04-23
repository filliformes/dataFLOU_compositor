// Crash-recovery prompt — shown once at startup if the previous run didn't
// exit cleanly (sentinel file was left behind). Lists the most recent
// autosaves; a click on one loads it into the current session (without a
// file path, so the next Save pops a Save-As dialog — we don't assume the
// user wants to overwrite any specific on-disk session).

import { useEffect, useState } from 'react'
import type { AutosaveEntry } from '@shared/types'
import { useStore } from '../store'
import { Modal } from './Modal'

export default function CrashRecoveryPrompt(): JSX.Element | null {
  const setSession = useStore((s) => s.setSession)
  const [state, setState] = useState<{
    visible: boolean
    entries: AutosaveEntry[]
  }>({ visible: false, entries: [] })

  useEffect(() => {
    let cancelled = false
    void window.api.autosaveCrashCheck().then((r) => {
      if (cancelled) return
      if (r.crashed && r.entries.length > 0) {
        setState({ visible: true, entries: r.entries.slice(0, 10) })
      }
    })
    return () => {
      cancelled = true
    }
  }, [])

  if (!state.visible) return null

  function dismiss(): void {
    setState({ visible: false, entries: [] })
  }

  async function restore(path: string): Promise<void> {
    try {
      const s = await window.api.autosaveLoad(path)
      setSession(s)
    } catch (e) {
      console.error('[restore] failed', (e as Error).message)
      alert(`Failed to load autosave:\n${(e as Error).message}`)
    } finally {
      dismiss()
    }
  }

  return (
    <Modal title="Restore from autosave?" onClose={dismiss}>
      <div className="flex flex-col gap-3">
        <p className="text-[12px] text-muted">
          The previous run of dataFLOU didn&apos;t exit cleanly. Pick an autosave
          to restore, or dismiss to start fresh.
        </p>
        <div className="flex flex-col gap-1 max-h-[300px] overflow-y-auto">
          {state.entries.map((e) => (
            <button
              key={e.path}
              className="btn text-left flex items-center gap-3 py-1.5"
              onClick={() => void restore(e.path)}
              title={e.path}
            >
              <span className="font-medium truncate flex-1">{e.sessionName}</span>
              <span className="text-muted text-[11px] shrink-0">
                {formatWhen(e.mtimeMs)}
              </span>
            </button>
          ))}
        </div>
        <div className="flex items-center justify-end gap-2 mt-1">
          <button className="btn" onClick={dismiss}>
            Dismiss
          </button>
        </div>
      </div>
    </Modal>
  )
}

function formatWhen(ms: number): string {
  const diff = Date.now() - ms
  const m = Math.floor(diff / 60_000)
  if (m < 1) return 'just now'
  if (m < 60) return `${m} min ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h} h ago`
  const d = new Date(ms)
  return d.toLocaleString()
}
