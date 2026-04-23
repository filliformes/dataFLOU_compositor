// Autosave + crash recovery.
//
// Every 60 seconds, if the session has changed since our last write, drop a
// silent backup into `<userData>/autosave/<name>-<timestamp>.dflou.json`.
// Keep the last N=30 copies; older files are pruned on each save.
//
// Crash detection: a sentinel file `<userData>/.running` is created on
// app.ready and deleted on before-quit / window-all-closed. If it still
// exists at next startup, the previous process didn't exit cleanly and we
// surface the most recent autosaves so the user can restore.
//
// The renderer is the source of truth for the current session — it pushes
// updates via `engine:updateSession`, which we also route through
// `setCurrentSession()` below. Dirty tracking is "current JSON !== last
// saved JSON". A stringify-per-60s hit is trivial even for big sessions.

import { app } from 'electron'
import { promises as fs, existsSync, writeFileSync, unlinkSync } from 'fs'
import { join } from 'path'
import type { Session } from '@shared/types'

const AUTOSAVE_MAX_COPIES = 30
const AUTOSAVE_INTERVAL_MS = 60_000

const userData = (): string => app.getPath('userData')
const autosaveDir = (): string => join(userData(), 'autosave')
const sentinelPath = (): string => join(userData(), '.running')

let currentSession: Session | null = null
let lastWrittenJson: string | null = null
let timer: ReturnType<typeof setInterval> | null = null

export interface AutosaveEntry {
  path: string
  mtimeMs: number
  sessionName: string
  sizeBytes: number
}

/** Record the latest session coming from the renderer. Called on every
 *  `engine:updateSession` IPC so the autosave timer always has the freshest
 *  copy to write. */
export function setCurrentSession(s: Session): void {
  currentSession = s
}

/** Ensure the autosave directory exists (sync — only called once at startup). */
function ensureDir(): void {
  try {
    if (!existsSync(autosaveDir())) {
      require('fs').mkdirSync(autosaveDir(), { recursive: true })
    }
  } catch (e) {
    console.error('[autosave] failed to create dir', (e as Error).message)
  }
}

/** Called on app.ready — writes the sentinel file AFTER reporting whether
 *  the previous run crashed, and starts the 60-second save loop. */
export function startAutosave(): { crashed: boolean } {
  ensureDir()
  const crashed = existsSync(sentinelPath())
  try {
    writeFileSync(sentinelPath(), String(Date.now()), 'utf8')
  } catch (e) {
    console.error('[autosave] could not write sentinel', (e as Error).message)
  }
  if (timer) clearInterval(timer)
  timer = setInterval(() => {
    void tickAutosave()
  }, AUTOSAVE_INTERVAL_MS)
  return { crashed }
}

/** Called on before-quit / window-all-closed. Removes the sentinel so the
 *  next startup knows we exited cleanly. Also writes one final autosave so
 *  last-minute changes aren't lost. */
export function stopAutosave(): void {
  if (timer) {
    clearInterval(timer)
    timer = null
  }
  // Best-effort final write — fire-and-forget since app is shutting down.
  void tickAutosave().catch(() => {
    /* swallow */
  })
  try {
    if (existsSync(sentinelPath())) unlinkSync(sentinelPath())
  } catch {
    /* swallow */
  }
}

async function tickAutosave(): Promise<void> {
  if (!currentSession) return
  let json: string
  try {
    json = JSON.stringify(currentSession, null, 2)
  } catch {
    return
  }
  if (json === lastWrittenJson) return
  const name = sanitizeFileName(currentSession.name || 'session')
  const stamp = timestampForFilename()
  const file = join(autosaveDir(), `${name}-${stamp}.dflou.json`)
  try {
    await fs.writeFile(file, json, 'utf8')
    lastWrittenJson = json
    await pruneOldAutosaves()
  } catch (e) {
    console.error('[autosave] write failed', (e as Error).message)
  }
}

async function pruneOldAutosaves(): Promise<void> {
  try {
    const entries = await listAutosaves()
    // Newest first → drop everything beyond the cap.
    const excess = entries.slice(AUTOSAVE_MAX_COPIES)
    for (const e of excess) {
      try {
        await fs.unlink(e.path)
      } catch {
        /* ignore individual failures */
      }
    }
  } catch (e) {
    console.error('[autosave] prune failed', (e as Error).message)
  }
}

/** Return every autosave on disk, newest first. Used by the crash-recovery
 *  prompt and any future "restore" UI. */
export async function listAutosaves(): Promise<AutosaveEntry[]> {
  try {
    const dir = autosaveDir()
    if (!existsSync(dir)) return []
    const names = await fs.readdir(dir)
    const out: AutosaveEntry[] = []
    for (const n of names) {
      if (!n.endsWith('.dflou.json')) continue
      const full = join(dir, n)
      try {
        const st = await fs.stat(full)
        // Strip trailing `-YYYYMMDD-HHMMSS` to recover the session name.
        const base = n.replace(/\.dflou\.json$/, '')
        const sessionName = base.replace(/-\d{8}-\d{6}$/, '')
        out.push({
          path: full,
          mtimeMs: st.mtimeMs,
          sessionName,
          sizeBytes: st.size
        })
      } catch {
        /* skip unreadable files */
      }
    }
    out.sort((a, b) => b.mtimeMs - a.mtimeMs)
    return out
  } catch (e) {
    console.error('[autosave] list failed', (e as Error).message)
    return []
  }
}

/** Read an autosave file and return its session payload. */
export async function loadAutosave(path: string): Promise<Session> {
  const text = await fs.readFile(path, 'utf8')
  const s = JSON.parse(text) as Session
  if (s.version !== 1) throw new Error(`Unsupported session version: ${s.version}`)
  return s
}

function sanitizeFileName(s: string): string {
  // Windows-safe: strip <>:"/\\|?* and collapse whitespace.
  return s
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '')
    .replace(/\s+/g, '_')
    .slice(0, 64) || 'session'
}

function timestampForFilename(): string {
  const d = new Date()
  const p = (n: number, w = 2): string => String(n).padStart(w, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
}
