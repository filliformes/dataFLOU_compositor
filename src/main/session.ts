// Session file I/O. Plain JSON, .dflou.json extension.

import { dialog, BrowserWindow } from 'electron'
import { promises as fs } from 'fs'
import type { Session } from '@shared/types'

const FILTERS = [{ name: 'dataFLOU Session', extensions: ['dflou.json', 'json'] }]

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
  await fs.writeFile(result.filePath, JSON.stringify(session, null, 2), 'utf8')
  return result.filePath
}

export async function saveTo(path: string, session: Session): Promise<boolean> {
  await fs.writeFile(path, JSON.stringify(session, null, 2), 'utf8')
  return true
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
