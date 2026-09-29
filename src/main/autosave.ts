// Autosave + crash recovery.
//
// Every 60 seconds, if the session has changed since our last write, drop a
// silent backup into `<userData>/autosave/<name>-<timestamp>.dflou.json`.
// Keep the last N=30 copies; older files are pruned on each save.
//
// Crash detection: a sentinel file `<userData>/.running` is created on
// app.ready and deleted on will-quit (main's shutdown()). If it still
// exists at next startup, the previous process didn't exit cleanly and we
// surface the most recent autosaves so the user can restore.
//
// The renderer is the source of truth for the current session — it pushes
// updates via `engine:updateSession`, which we also route through
// `setCurrentSession()` below. Dirty tracking is "current JSON !== last
// saved JSON". A stringify-per-60s hit is trivial even for big sessions.

import { app } from 'electron'
import {
  promises as fs,
  existsSync,
  writeFileSync,
  unlinkSync,
  readdirSync,
  openSync,
  writeSync,
  fsyncSync,
  closeSync,
  renameSync
} from 'fs'
import { join } from 'path'
import type { AutosaveEntry, Session } from '@shared/types'
import { atomicWriteFile } from './session'

const AUTOSAVE_MAX_COPIES = 30
const AUTOSAVE_INTERVAL_MS = 60_000
// A `.tmp` older than this can't belong to a write in progress (writes
// take milliseconds and are serialised) — it's the leftover of a crash
// or a quit mid-write. Pruned so they don't pile up forever.
const STALE_TMP_MS = 60_000

const userData = (): string => app.getPath('userData')
const autosaveDir = (): string => join(userData(), 'autosave')
const sentinelPath = (): string => join(userData(), '.running')

let currentSession: Session | null = null
let lastWrittenJson: string | null = null
let timer: ReturnType<typeof setInterval> | null = null
// Mutex: only one tickAutosave() ever runs at a time, so a slow write +
// pruneOldAutosaves can't overlap the next interval tick (duplicate
// write + an ENOENT during prune on Windows). The shutdown flush is
// synchronous (flushAutosaveSync) and doesn't go through here.
let inFlight: Promise<void> | null = null

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
  // Nothing can be mid-write at startup (single-instance lock), so every
  // `.tmp` here is the leftover of a crash / quit mid-write.
  removeStaleTmpFilesSync()
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

/** Called from main's shutdown() on will-quit. Writes one final autosave
 *  so last-minute changes aren't lost, then removes the sentinel so the
 *  next startup knows we exited cleanly. */
export function stopAutosave(): void {
  if (timer) {
    clearInterval(timer)
    timer = null
  }
  // Final write is SYNCHRONOUS — the process exits right after
  // will-quit, so an async write would be cut off mid-file (leaving a
  // partial .tmp and losing the last changes).
  flushAutosaveSync()
  try {
    if (existsSync(sentinelPath())) unlinkSync(sentinelPath())
  } catch {
    /* swallow */
  }
}

/** Synchronous twin of tickAutosave's write, for shutdown. Skips when
 *  the session is unchanged since the last successful write. */
function flushAutosaveSync(): void {
  if (!currentSession) return
  let json: string
  try {
    json = JSON.stringify(currentSession, null, 2)
  } catch {
    return
  }
  if (json === lastWrittenJson) return
  const name = sanitizeFileName(currentSession.name || 'session')
  const file = join(autosaveDir(), `${name}-${timestampForFilename()}.dflou.json`)
  // Own tmp name so it can't interleave with an async tick still in
  // flight on the thread pool (which writes `${file}.tmp`).
  const tmp = `${file}.final.tmp`
  try {
    const fd = openSync(tmp, 'w')
    try {
      writeSync(fd, json, null, 'utf8')
      try {
        fsyncSync(fd)
      } catch {
        /* fsync unsupported on this filesystem — rename is still atomic */
      }
    } finally {
      closeSync(fd)
    }
    renameSync(tmp, file)
    lastWrittenJson = json
  } catch (e) {
    console.error('[autosave] final write failed', (e as Error).message)
  }
}

/** Delete every `*.tmp` in the autosave dir (startup only). */
function removeStaleTmpFilesSync(): void {
  try {
    for (const n of readdirSync(autosaveDir())) {
      if (!n.endsWith('.tmp')) continue
      try {
        unlinkSync(join(autosaveDir(), n))
      } catch {
        /* ignore individual failures */
      }
    }
  } catch {
    /* dir missing / unreadable — nothing to clean */
  }
}

async function tickAutosave(): Promise<void> {
  // Serialise concurrent calls. Waiting on the prior run keeps
  // writes single-threaded and lets the second caller see the
  // updated `lastWrittenJson` (so it skips redundant work).
  if (inFlight) {
    await inFlight
    return
  }
  const work = (async (): Promise<void> => {
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
      // Atomic write — same helper as session.ts. A crash mid-write
      // leaves only the .tmp; the autosave directory keeps the
      // previous snapshot intact for restore.
      await atomicWriteFile(file, json)
      lastWrittenJson = json
      await pruneOldAutosaves()
    } catch (e) {
      console.error('[autosave] write failed', (e as Error).message)
    }
  })()
  inFlight = work
  try {
    await work
  } finally {
    inFlight = null
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
    // Orphaned `.tmp` files (crash / quit mid-write). Age-gated so a
    // write that is genuinely in progress is never touched.
    const dir = autosaveDir()
    const now = Date.now()
    for (const n of await fs.readdir(dir)) {
      if (!n.endsWith('.tmp')) continue
      const full = join(dir, n)
      try {
        const st = await fs.stat(full)
        if (now - st.mtimeMs > STALE_TMP_MS) await fs.unlink(full)
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
