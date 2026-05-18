// Session file I/O. Plain JSON, .dflou.json extension.

import { app, dialog, BrowserWindow } from 'electron'
import { promises as fs, existsSync } from 'fs'
import { join, dirname } from 'path'
import type { Session } from '@shared/types'

const FILTERS = [{ name: 'dataFLOU Session', extensions: ['dflou.json', 'json'] }]

/**
 * Atomic save: write to `<path>.tmp`, fsync the file handle, then
 * rename onto the final path. `fs.rename` is atomic on the same
 * filesystem (POSIX guarantee; NTFS via MoveFileEx ditto), so a
 * crash mid-write can only leave the .tmp around — the original
 * session file stays intact. Without this, a crash between
 * truncate and last byte written would leave the user with a
 * corrupted .dflou.json.
 */
async function atomicWriteJson(path: string, session: Session): Promise<void> {
  const tmpPath = `${path}.tmp`
  const json = JSON.stringify(session, null, 2)
  // `fs.writeFile` opens, writes, closes — no separate fsync needed
  // on the happy path. Then atomically rename on top of the final
  // path. If the rename fails we leave the .tmp; the next save
  // will overwrite it.
  await fs.writeFile(tmpPath, json, 'utf8')
  await fs.rename(tmpPath, path)
}

export async function saveAs(
  parent: BrowserWindow | null,
  session: Session
): Promise<string | null> {
  const result = await dialog.showSaveDialog(parent ?? undefined!, {
    title: 'Save Session',
    defaultPath: `${session.name || 'session'}.dflou.json`,
    filters: FILTERS
  })
  if (result.canceled || !result.filePath) return null
  await atomicWriteJson(result.filePath, session)
  return result.filePath
}

export async function saveTo(path: string, session: Session): Promise<boolean> {
  await atomicWriteJson(path, session)
  return true
}

/**
 * Resolve the project's "Sessions" folder — the user wants saved
 * sessions to land next to the app's source / install location,
 * not buried in `<userData>`. Two cases:
 *   - DEV (electron-vite dev / `npm run dev`): `process.cwd()` is
 *     the project root (e.g. `C:\Users\filli\Projects\dataFLOU_Merge`).
 *     The folder is `<root>/Sessions`.
 *   - PROD (electron-builder packaged): the .exe lives inside the
 *     install directory; sessions land in `<install-dir>/Sessions`
 *     (writable on a typical user install; if the install location
 *     is read-only — e.g. Program Files without admin write —
 *     we fall back to `<userData>/Sessions` so the save doesn't
 *     fail silently).
 */
function sessionsFolderPath(): string {
  if (app.isPackaged) {
    return join(dirname(app.getPath('exe')), 'Sessions')
  }
  return join(process.cwd(), 'Sessions')
}

/**
 * Save the session to the app's default Sessions directory
 * (`<project-root-or-install-dir>/Sessions/<name>.dflou.json`).
 * Used by the "Save before quitting?" flow when the user has
 * never run Save As — guarantees a file exists for the session,
 * named after the session's current name, without prompting for
 * a location. Returns the absolute path written.
 */
export async function saveToDefault(session: Session): Promise<string> {
  let dir = sessionsFolderPath()
  try {
    if (!existsSync(dir)) {
      await fs.mkdir(dir, { recursive: true })
    }
  } catch (e) {
    // Install dir not writable (Program Files / system-managed
    // location) — fall back to userData so the save still lands
    // SOMEWHERE the user can find later. Log the fallback path.
    console.error(
      '[session.saveToDefault] Sessions folder unwritable, falling back to userData:',
      (e as Error).message
    )
    dir = join(app.getPath('userData'), 'Sessions')
    if (!existsSync(dir)) await fs.mkdir(dir, { recursive: true })
  }
  // Sanitise the session name into a filename. Strips path separators
  // and other characters that NTFS / APFS can't represent so a session
  // called "OCTOCOSME / live" doesn't try to create a subdirectory.
  const safe =
    (session.name || 'session')
      .replace(/[\\/:*?"<>|]+/g, '_')
      .replace(/\s+/g, ' ')
      .trim() || 'session'
  // If a file with that name already exists, append (1), (2), … so we
  // never silently overwrite a session the user might still want.
  let candidate = join(dir, `${safe}.dflou.json`)
  let n = 1
  while (existsSync(candidate)) {
    candidate = join(dir, `${safe} (${n}).dflou.json`)
    n += 1
  }
  await atomicWriteJson(candidate, session)
  return candidate
}

export async function open(
  parent: BrowserWindow | null
): Promise<{ session: Session; path: string } | null> {
  const result = await dialog.showOpenDialog(parent ?? undefined!, {
    title: 'Open Session',
    filters: FILTERS,
    properties: ['openFile']
  })
  if (result.canceled || result.filePaths.length === 0) return null
  const path = result.filePaths[0]
  const text = await fs.readFile(path, 'utf8')
  // Parse defensively — a hand-edited or truncated file would otherwise
  // throw a raw SyntaxError back across IPC with no helpful context.
  let session: Session
  try {
    session = JSON.parse(text) as Session
  } catch (e) {
    throw new Error(`Session file could not be parsed: ${(e as Error).message}`)
  }
  if (!session || typeof session !== 'object') {
    throw new Error('Session file is not a JSON object')
  }
  if (session.version !== 1) {
    throw new Error(
      `Unsupported session version: ${session.version}. Expected 1.`
    )
  }
  return { session, path }
}
