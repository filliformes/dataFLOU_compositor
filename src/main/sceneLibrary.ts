// Global Scene library — persistent across sessions.
//
// Saved scenes captured by the Pool's Capture popup (or "Save to
// Pool" right-click on a scene in the palette) live in
// `<userData>/scene-library.json`. They're independent of any
// single .dflou.json session file: drag a saved scene from the Pool
// into ANY open session, the loader copies the missing Instrument
// Templates + Tracks into that session's Pool/sidebar and
// reconstructs the Scene.
//
// In-memory cache + atomic disk writes via .tmp + rename (same
// pattern as session.ts / autosave.ts). The renderer subscribes to
// the in-memory cache via `setOnChange`; main pushes a fresh array
// after every save / remove so the Pool's Scenes tab updates
// without polling.

import { app } from 'electron'
import { promises as fs, existsSync } from 'fs'
import { join } from 'path'
import type { SavedScene } from '@shared/types'

const FILE_NAME = 'scene-library.json'

// Hard cap on stored scenes. 256 is plenty for live performance
// libraries (most users will have <50); guards against a runaway
// auto-capture script blowing the file size.
const MAX_LIBRARY_SIZE = 256

function libraryPath(): string {
  return join(app.getPath('userData'), FILE_NAME)
}

export class SceneLibrary {
  private scenes: SavedScene[] = []
  private loaded = false
  private onChange: ((scenes: SavedScene[]) => void) | null = null
  // Single-flight write guard — the in-memory cache is mutated
  // synchronously, but disk writes can pile up if the user spam-
  // saves. Queue at most one pending write at a time; if another
  // arrives while one's in flight, we just re-write the latest
  // cache contents when the in-flight finishes.
  private writeInFlight: Promise<void> | null = null
  private writePending = false

  setOnChange(cb: ((scenes: SavedScene[]) => void) | null): void {
    this.onChange = cb
  }

  /** Read the file from disk into the in-memory cache. Idempotent —
   *  subsequent calls return the cached array. Called lazily by
   *  `list()` so app startup doesn't pay the I/O cost if the
   *  library is never opened. */
  async ensureLoaded(): Promise<void> {
    if (this.loaded) return
    this.loaded = true
    const path = libraryPath()
    if (!existsSync(path)) {
      this.scenes = []
      return
    }
    try {
      const raw = await fs.readFile(path, 'utf8')
      const parsed = JSON.parse(raw) as unknown
      // Defensive sanitise — a hand-edited or truncated file
      // shouldn't crash the renderer. We accept what's recognisable
      // and drop the rest.
      if (Array.isArray(parsed)) {
        this.scenes = parsed.filter((s): s is SavedScene => {
          if (!s || typeof s !== 'object') return false
          const x = s as Partial<SavedScene>
          return (
            typeof x.id === 'string' &&
            typeof x.name === 'string' &&
            Array.isArray(x.templates) &&
            Array.isArray(x.tracks) &&
            typeof x.cells === 'object' &&
            !!x.sceneMeta
          )
        })
      } else {
        this.scenes = []
      }
    } catch (e) {
      console.error('[sceneLibrary] read failed:', (e as Error).message)
      this.scenes = []
    }
  }

  /** Return a copy of the in-memory cache, most-recent first. */
  async list(): Promise<SavedScene[]> {
    await this.ensureLoaded()
    return [...this.scenes].sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0))
  }

  /** Add or replace a scene in the library (matches by `id`).
   *  Triggers a disk write + onChange notification. */
  async save(scene: SavedScene): Promise<void> {
    await this.ensureLoaded()
    const idx = this.scenes.findIndex((s) => s.id === scene.id)
    if (idx >= 0) {
      this.scenes[idx] = scene
    } else {
      // Enforce the hard cap by dropping the oldest entry if we're
      // about to exceed it. Sorts by createdAt to find the victim.
      if (this.scenes.length >= MAX_LIBRARY_SIZE) {
        const sorted = [...this.scenes].sort(
          (a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0)
        )
        const oldest = sorted[0]
        if (oldest) {
          this.scenes = this.scenes.filter((s) => s.id !== oldest.id)
        }
      }
      this.scenes.push(scene)
    }
    this.notifyChange()
    void this.flushSoon()
  }

  /** Remove a scene by id. No-op if not found. */
  async remove(id: string): Promise<void> {
    await this.ensureLoaded()
    const before = this.scenes.length
    this.scenes = this.scenes.filter((s) => s.id !== id)
    if (this.scenes.length === before) return
    this.notifyChange()
    void this.flushSoon()
  }

  // ── Internals ──────────────────────────────────────────────────

  private notifyChange(): void {
    if (this.onChange) {
      // Send the same sorted view as `list()` so the renderer
      // doesn't have to re-sort.
      const sorted = [...this.scenes].sort(
        (a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0)
      )
      this.onChange(sorted)
    }
  }

  /** Schedule a disk write. Coalesces back-to-back saves: while one
   *  write is in flight any subsequent `save()` calls just set
   *  `writePending` so a single follow-up write captures the
   *  latest cache state. */
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
      const json = JSON.stringify(this.scenes, null, 2)
      await fs.writeFile(tmp, json, 'utf8')
      await fs.rename(tmp, path)
    } catch (e) {
      console.error('[sceneLibrary] write failed:', (e as Error).message)
    }
  }
}
