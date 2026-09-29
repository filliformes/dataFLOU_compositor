// Session file I/O. Plain JSON, .dflou.json extension.

import { app, dialog, BrowserWindow } from 'electron'
import { promises as fs, existsSync } from 'fs'
import { join } from 'path'
import type { Session } from '@shared/types'

const FILTERS = [{ name: 'dataFLOU Session', extensions: ['dflou.json', 'json'] }]

/**
 * Atomic save: write to `<path>.tmp`, fsync the file handle, then
 * rename onto the final path. `fs.rename` is atomic on the same
 * filesystem (POSIX guarantee; NTFS via MoveFileEx ditto), so a
 * crash mid-write can only leave the .tmp around — the original
 * file stays intact. The fsync matters: without it a power loss
 * right after the rename can leave the NEW name pointing at data
 * that never reached the disk (a zero-length / truncated file).
 * Shared by session, autosave and the scene / pool libraries.
 */
export async function atomicWriteFile(path: string, data: string): Promise<void> {
  const tmpPath = `${path}.tmp`
  const fh = await fs.open(tmpPath, 'w')
  try {
    await fh.writeFile(data, 'utf8')
    try {
      await fh.sync()
    } catch {
      /* fsync unsupported on this filesystem — rename is still atomic */
    }
  } finally {
    await fh.close()
  }
  // If the rename fails we leave the .tmp; the next save overwrites it.
  await fs.rename(tmpPath, path)
}

/** Rename an unparseable JSON store (scene / pool library) to
 *  `<path>.corrupt-<ts>` so it survives for manual recovery instead of
 *  being overwritten by the next write of the (now empty) cache. */
export async function backupCorruptFile(
  path: string,
  logTag: string,
  reason: string
): Promise<void> {
  const backup = `${path}.corrupt-${Date.now()}`
  try {
    await fs.rename(path, backup)
    console.error(`${logTag} unparseable (${reason}); moved to ${backup}`)
  } catch (e) {
    console.error(`${logTag} could not back up corrupt file:`, (e as Error).message)
  }
}

async function atomicWriteJson(path: string, session: Session): Promise<void> {
  await atomicWriteFile(path, JSON.stringify(session, null, 2))
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
 * Resolve the default "Sessions" folder — somewhere the user can
 * find, not buried in `<userData>`. Cases:
 *   - DEV (electron-vite dev / `npm run dev`): `process.cwd()` is
 *     the project root (e.g. `C:\Users\filli\Projects\dataFLOU_Merge`).
 *     The folder is `<root>/Sessions`.
 *   - PORTABLE .exe (electron-builder `portable`): the exe runs from
 *     a temp extraction dir that is deleted on exit, so use the
 *     folder the user launched the portable exe from
 *     (`PORTABLE_EXECUTABLE_DIR`) → `<that-dir>/Sessions`.
 *   - Other packaged builds: `<Documents>/dataFLOU/Sessions`. NOT
 *     next to the exe — the NSIS uninstaller/updater wipes the
 *     install dir and on macOS that would be inside the signed .app.
 * If the chosen folder can't be created, saveToDefault falls back to
 * `<userData>/Sessions` so the save doesn't fail silently.
 */
function sessionsFolderPath(): string {
  if (app.isPackaged) {
    const portableDir = process.env.PORTABLE_EXECUTABLE_DIR
    if (portableDir) return join(portableDir, 'Sessions')
    return join(app.getPath('documents'), 'dataFLOU', 'Sessions')
  }
  return join(process.cwd(), 'Sessions')
}

/**
 * Save the session to the app's default Sessions directory
 * (`<Sessions folder>/<name>.dflou.json`, see sessionsFolderPath).
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
    // Sessions folder not writable (read-only share / managed
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
