// Session integrity check — scans a loaded session for fields that
// would silently misbehave at runtime. Designed to run right after
// Open / Crash Recovery restore, BEFORE committing the session to the
// store, so the user can auto-fix or cancel instead of loading a broken
// file mid-show.
//
// What counts as a "problem" here: anything that would either cause no
// OSC to go out, or send garbled OSC, that the user can't see from the
// UI at a glance. Fields within hard type bounds but with weird values
// (e.g. OSC address missing leading slash) are flagged but still loaded
// — the user can accept.

import type { Cell, Scene, Session } from '@shared/types'

export type IssueSeverity = 'error' | 'warn'

export interface IntegrityIssue {
  severity: IssueSeverity
  /** Human-readable location — "Scene 'Intro' · Message 'Synth 1'". */
  where: string
  /** Which field or concept has the problem. */
  field: string
  /** What's wrong, in user-facing language. */
  problem: string
  /** Proposed auto-fix (applied when the user clicks Auto-fix). */
  suggested: string
  /** The actual fix function. Receives a DRAFT session and mutates it
   *  to apply the fix. Pure of side effects outside the draft. */
  fix: (draft: Session) => void
}

/** Rough dotted-IPv4 check + "localhost" acceptance. Not a real validator
 *  — we trust the user mostly; this only catches obvious typos and empty
 *  strings. */
function looksLikeIp(s: string): boolean {
  if (!s) return false
  if (s === 'localhost') return true
  // 1–3-digit octets separated by dots. No range check (224.x.x.x is
  // valid multicast for OSC). Just structural.
  return /^(\d{1,3}\.){3}\d{1,3}$/.test(s)
}

function looksLikeOscAddress(s: string): boolean {
  return typeof s === 'string' && s.startsWith('/') && s.length >= 2
}

function checkCell(
  sceneId: string,
  sceneName: string,
  trackName: string,
  trackId: string,
  cell: Cell,
  issues: IntegrityIssue[]
): void {
  const where = `Scene "${sceneName || '(unnamed)'}" · Message "${trackName || '(unnamed)'}"`
  // IP
  if (!looksLikeIp(cell.destIp)) {
    issues.push({
      severity: 'error',
      where,
      field: 'destIp',
      problem: `Destination IP "${cell.destIp}" doesn't look like a valid IP address or "localhost".`,
      suggested: 'Reset to 127.0.0.1',
      fix: (draft) => {
        const sc = draft.scenes.find((s) => s.id === sceneId)
        const c = sc?.cells?.[trackId]
        if (c) c.destIp = '127.0.0.1'
      }
    })
  }
  // Port
  if (
    !Number.isFinite(cell.destPort) ||
    cell.destPort < 1 ||
    cell.destPort > 65535
  ) {
    issues.push({
      severity: 'error',
      where,
      field: 'destPort',
      problem: `Port ${cell.destPort} is out of range (1–65535).`,
      suggested: 'Reset to 9000',
      fix: (draft) => {
        const sc = draft.scenes.find((s) => s.id === sceneId)
        const c = sc?.cells?.[trackId]
        if (c) c.destPort = 9000
      }
    })
  }
  // OSC address
  if (!looksLikeOscAddress(cell.oscAddress)) {
    issues.push({
      severity: 'warn',
      where,
      field: 'oscAddress',
      problem: `OSC address "${cell.oscAddress}" doesn't start with "/".`,
      suggested: `Prepend "/"`,
      fix: (draft) => {
        const sc = draft.scenes.find((s) => s.id === sceneId)
        const c = sc?.cells?.[trackId]
        if (c) c.oscAddress = '/' + String(c.oscAddress ?? '').replace(/^\/+/, '')
      }
    })
  }
  // Timing bounds
  if (cell.delayMs < 0 || cell.delayMs > 60000) {
    issues.push({
      severity: 'warn',
      where,
      field: 'delayMs',
      problem: `Delay ${cell.delayMs} ms is outside the typical range (0–60000).`,
      suggested: 'Clamp to range',
      fix: (draft) => {
        const sc = draft.scenes.find((s) => s.id === sceneId)
        const c = sc?.cells?.[trackId]
        if (c) c.delayMs = Math.max(0, Math.min(60000, c.delayMs))
      }
    })
  }
  if (cell.transitionMs < 0 || cell.transitionMs > 60000) {
    issues.push({
      severity: 'warn',
      where,
      field: 'transitionMs',
      problem: `Transition ${cell.transitionMs} ms is outside the typical range (0–60000).`,
      suggested: 'Clamp to range',
      fix: (draft) => {
        const sc = draft.scenes.find((s) => s.id === sceneId)
        const c = sc?.cells?.[trackId]
        if (c) c.transitionMs = Math.max(0, Math.min(60000, c.transitionMs))
      }
    })
  }
  // Modulation depth sanity. Optional chaining: this runs on the RAW
  // file (before propagateDefaults back-fills `modulation`), so a legacy
  // cell may not have one.
  if (
    cell.modulation?.enabled &&
    (cell.modulation.depthPct < 0 || cell.modulation.depthPct > 100)
  ) {
    issues.push({
      severity: 'warn',
      where,
      field: 'modulation.depthPct',
      problem: `Modulation depth ${cell.modulation.depthPct}% is out of [0, 100].`,
      suggested: 'Clamp to [0, 100]',
      fix: (draft) => {
        const sc = draft.scenes.find((s) => s.id === sceneId)
        const c = sc?.cells?.[trackId]
        if (c?.modulation) {
          c.modulation.depthPct = Math.max(0, Math.min(100, c.modulation.depthPct))
        }
      }
    })
  }
}

function checkScene(scene: Scene, issues: IntegrityIssue[]): void {
  const where = `Scene "${scene.name || '(unnamed)'}"`
  if (!Number.isFinite(scene.durationSec) || scene.durationSec <= 0) {
    issues.push({
      severity: 'error',
      where,
      field: 'durationSec',
      problem: `Duration ${scene.durationSec}s is not a positive number.`,
      suggested: 'Reset to 5s',
      fix: (draft) => {
        const sc = draft.scenes.find((s) => s.id === scene.id)
        if (sc) sc.durationSec = 5
      }
    })
  } else if (scene.durationSec > 3600) {
    issues.push({
      severity: 'warn',
      where,
      field: 'durationSec',
      problem: `Duration ${scene.durationSec}s is over an hour — probably a typo.`,
      suggested: 'Clamp to 300s',
      fix: (draft) => {
        const sc = draft.scenes.find((s) => s.id === scene.id)
        if (sc) sc.durationSec = 300
      }
    })
  }
  if (scene.multiplicator < 1 || scene.multiplicator > 128) {
    issues.push({
      severity: 'warn',
      where,
      field: 'multiplicator',
      problem: `Multiplicator ${scene.multiplicator} is out of [1, 128].`,
      suggested: 'Clamp',
      fix: (draft) => {
        const sc = draft.scenes.find((s) => s.id === scene.id)
        if (sc) sc.multiplicator = Math.max(1, Math.min(128, sc.multiplicator))
      }
    })
  }
}

/** Run every check and return the aggregated issue list. Callers that
 *  want to auto-fix can pipe the list through `applyFixes`. */
export function checkSessionIntegrity(session: Session): IntegrityIssue[] {
  const issues: IntegrityIssue[] = []
  // Session-level
  if (!Number.isFinite(session.globalBpm) || session.globalBpm < 10 || session.globalBpm > 500) {
    issues.push({
      severity: 'warn',
      where: 'Session',
      field: 'globalBpm',
      problem: `Global BPM ${session.globalBpm} is out of [10, 500].`,
      suggested: 'Reset to 120',
      fix: (draft) => {
        draft.globalBpm = 120
      }
    })
  }
  if (
    !Number.isFinite(session.tickRateHz) ||
    session.tickRateHz < 10 ||
    session.tickRateHz > 300
  ) {
    issues.push({
      severity: 'warn',
      where: 'Session',
      field: 'tickRateHz',
      problem: `Tick rate ${session.tickRateHz} Hz is out of [10, 300].`,
      suggested: 'Reset to 120',
      fix: (draft) => {
        draft.tickRateHz = 120
      }
    })
  }
  // Scene-level + cell-level. Runs on the RAW file (before
  // propagateDefaults), so a legacy / hand-edited file may lack arrays or
  // hold null entries — guard every structural deref instead of throwing
  // out of Open.
  const tracks = Array.isArray(session.tracks) ? session.tracks : []
  for (const scene of Array.isArray(session.scenes) ? session.scenes : []) {
    if (!scene || typeof scene !== 'object') continue
    checkScene(scene, issues)
    for (const [trackId, cell] of Object.entries(scene.cells ?? {})) {
      if (!cell || typeof cell !== 'object') continue
      const track = tracks.find((t) => t?.id === trackId)
      checkCell(scene.id, scene.name, track?.name ?? '', trackId, cell, issues)
    }
  }
  return issues
}

/** Apply every `fix` in the list to a deep-cloned draft, return the
 *  fixed session. Original untouched. */
export function applyFixes(session: Session, issues: IntegrityIssue[]): Session {
  // Structured clone so we can mutate freely. Every Electron v11+ has it.
  const draft: Session = structuredClone(session)
  for (const issue of issues) {
    try {
      issue.fix(draft)
    } catch {
      // Swallow — a broken fix shouldn't prevent the others.
    }
  }
  return draft
}
