// Global Pool library — persistent across sessions.
//
// Stores the user's authored Instrument Templates + Parameter
// Templates (the contents of the Pool drawer's "User" tab) on disk
// at `<userData>/pool-library.json` so they survive session changes,
// new-session, and even "Open Other .dflou file" flows.
//
// Lifecycle:
//   - On every renderer change to `session.pool` (User entries), the
//     renderer sends the FULL current set of User templates +
//     parameters via `pool-library:setAll`. We replace the cache +
//     atomic-rewrite the JSON file (single-flight queue).
//   - On app start / session load, the renderer fetches the cache via
//     `pool-library:get` and merges any library entries that aren't
//     already present in the freshly-loaded session.pool. So opening
//     a brand-new session still gets your authored Instruments back.
//   - Edits propagate to the library in real time; deletes do too,
//     so the library is the union of "currently authored User
//     entries across all sessions you've touched", not a write-only
//     archive. If the user wants to permanently keep an entry, the
//     manual "Save as User" path still pushes it explicitly.

import { app } from 'electron'
import { promises as fs, existsSync } from 'fs'
import { join } from 'path'
import type { InstrumentTemplate, ParameterTemplate } from '@shared/types'

const FILE_NAME = 'pool-library.json'

// Hard caps. Two orders of magnitude over what any reasonable user
// will accumulate, but small enough that a runaway loop somewhere
// can't OOM the disk write.
const MAX_TEMPLATES = 1024
const MAX_PARAMETERS = 1024

function libraryPath(): string {
  return join(app.getPath('userData'), FILE_NAME)
}

export interface PoolLibraryPayload {
  templates: InstrumentTemplate[]
  parameters: ParameterTemplate[]
}

export class PoolLibrary {
  private templates: InstrumentTemplate[] = []
  private parameters: ParameterTemplate[] = []
  private loaded = false
  private onChange: ((payload: PoolLibraryPayload) => void) | null = null
  private writeInFlight: Promise<void> | null = null
  private writePending = false

  setOnChange(cb: ((payload: PoolLibraryPayload) => void) | null): void {
    this.onChange = cb
  }

  /** Load the on-disk file into the in-memory cache. Idempotent. */
  async ensureLoaded(): Promise<void> {
    if (this.loaded) return
    this.loaded = true
    const path = libraryPath()
    if (!existsSync(path)) {
      this.templates = []
      this.parameters = []
      return
    }
    try {
      const raw = await fs.readFile(path, 'utf8')
      const parsed = JSON.parse(raw) as unknown
      // Permissive parse: missing arrays default to [].
      const obj = (parsed ?? {}) as Partial<PoolLibraryPayload>
      this.templates = Array.isArray(obj.templates)
        ? obj.templates.filter((t): t is InstrumentTemplate => {
            if (!t || typeof t !== 'object') return false
            const x = t as Partial<InstrumentTemplate>
            return typeof x.id === 'string' && typeof x.name === 'string'
          })
        : []
      this.parameters = Array.isArray(obj.parameters)
        ? obj.parameters.filter((p): p is ParameterTemplate => {
            if (!p || typeof p !== 'object') return false
            const x = p as Partial<ParameterTemplate>
            return typeof x.id === 'string' && typeof x.name === 'string'
          })
        : []
    } catch (e) {
      console.error('[poolLibrary] read failed:', (e as Error).message)
      this.templates = []
      this.parameters = []
    }
  }

  /** Return a copy of the in-memory cache. */
  async get(): Promise<PoolLibraryPayload> {
    await this.ensureLoaded()
    return {
      templates: [...this.templates],
      parameters: [...this.parameters]
    }
  }

  /** Replace the WHOLE library with the renderer's view of User
   *  Pool entries. The renderer is the source of truth — it watches
   *  its session.pool and pushes the deduplicated User-entry set
   *  here on every change. We drop entries past the caps so a
   *  runaway state doesn't blow disk space. */
  async setAll(payload: PoolLibraryPayload): Promise<void> {
    await this.ensureLoaded()
    this.templates = (Array.isArray(payload.templates) ? payload.templates : [])
      .filter(
        (t): t is InstrumentTemplate =>
          !!t && typeof t === 'object' && typeof t.id === 'string'
      )
      .slice(0, MAX_TEMPLATES)
    this.parameters = (Array.isArray(payload.parameters) ? payload.parameters : [])
      .filter(
        (p): p is ParameterTemplate =>
          !!p && typeof p === 'object' && typeof p.id === 'string'
      )
      .slice(0, MAX_PARAMETERS)
    this.notifyChange()
    void this.flushSoon()
  }

  // ── Internals ──────────────────────────────────────────────────

  private notifyChange(): void {
    if (this.onChange) {
      this.onChange({
        templates: [...this.templates],
        parameters: [...this.parameters]
      })
    }
  }

  private async flushSoon(): Promise<void> {
    if (this.writeInFlight) {
      this.writePending = true
      return
    }
    this.writeInFlight = this.flushNow()
    await this.writeInFlight
    this.writeInFlight = null
    if (this.writePending) {
      this.writePending = false
      void this.flushSoon()
    }
  }

  private async flushNow(): Promise<void> {
    const path = libraryPath()
    const tmp = `${path}.tmp`
    try {
      const json = JSON.stringify(
        { templates: this.templates, parameters: this.parameters },
        null,
        2
      )
      await fs.writeFile(tmp, json, 'utf8')
      await fs.rename(tmp, path)
    } catch (e) {
      console.error('[poolLibrary] write failed:', (e as Error).message)
    }
  }
}
