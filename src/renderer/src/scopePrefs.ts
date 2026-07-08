// Per-scope frame settings (Input Conditioning scope): keyed
// `${templateId}|${address}|${slot}` so every Parameter / template-scope
// address keeps its own time window, value range, and height. Lives in a
// module-scope Map (fast, no store churn during height-drags) and is
// mirrored into the session file's `ui.scopePrefs` on save + restored on
// load. Shared by ScopeCanvas (reads/writes) and the store (dump/load) —
// a standalone module so neither has to import the other.

export interface ScopePrefs {
  windowSec: number
  yMin: number
  yMax: number
  height: number
  // Whether the value axis has been auto-fitted to data yet. Persisted
  // so a reopened session doesn't re-fit over the user's saved frame.
  inited: boolean
}

export const scopePrefs = new Map<string, ScopePrefs>()

// Snapshot to a plain object for `buildSessionForSave`.
export function dumpScopePrefs(): Record<string, ScopePrefs> {
  const out: Record<string, ScopePrefs> = {}
  scopePrefs.forEach((v, k) => {
    out[k] = v
  })
  return out
}

// Drop scope-pref entries whose `${templateId}|${address}` prefix is no
// longer live (template or Parameter deleted). Keeps orphan frame
// settings from accumulating in the session file across edits. Called
// from setSession after loadScopePrefs with the current valid prefixes.
export function pruneScopePrefs(validPrefixes: Set<string>): void {
  for (const k of Array.from(scopePrefs.keys())) {
    const firstPipe = k.indexOf('|')
    const lastPipe = k.lastIndexOf('|')
    // key = templateId|address|slot -> prefix = templateId|address
    const prefix = firstPipe >= 0 && lastPipe > firstPipe ? k.slice(0, lastPipe) : k
    if (!validPrefixes.has(prefix)) scopePrefs.delete(k)
  }
}

// Replace the live Map from a loaded session (validating each entry so a
// hand-edited file can't inject NaNs that would break the canvas math).
export function loadScopePrefs(raw: unknown): void {
  scopePrefs.clear()
  if (!raw || typeof raw !== 'object') return
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!v || typeof v !== 'object') continue
    const r = v as Record<string, unknown>
    const num = (x: unknown, fallback: number): number =>
      typeof x === 'number' && Number.isFinite(x) ? x : fallback
    scopePrefs.set(k, {
      windowSec: Math.max(0.5, Math.min(30, num(r.windowSec, 5))),
      yMin: num(r.yMin, 0),
      yMax: num(r.yMax, 1),
      height: Math.max(40, Math.min(480, num(r.height, 72))),
      inited: r.inited === true
    })
  }
}
