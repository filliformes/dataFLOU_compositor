// Undo / redo history for the session.
//
// Strategy:
//   - Module-scope ring buffers (max MAX each) hold Session SNAPSHOTS.
//     (FEATURE C) These are now session REFERENCES, not deep clones:
//     the store is strictly copy-on-write (verified — no in-place
//     mutation anywhere), so every edit produces a fresh `session`
//     object that structurally shares all unchanged branches with the
//     prior one. Storing references therefore costs only the changed
//     branch per level, which is what lets MAX rise to 100 cheaply.
//     Anything in the SESSION object is undoable — pool, scenes,
//     tracks, sequence, meta-controller bindings, etc. — except the
//     few view-state fields stored there (focused scene, Meta bar
//     visibility / height / selected knob; see isUiOnlyChange) and
//     MIDI-driven Meta knob moves (withoutUndoSnapshot). Pure UI state
//     (selection sets, drawer widths, transport timers) lives outside
//     session and is NOT in undo.
//   - A Zustand `subscribe(selector, listener)` watches `session`
//     identity. The FIRST change inside a 500 ms window captures
//     the PRE state into `pastSessions`; subsequent rapid changes
//     within the window are coalesced into the same undo step.
//     This is the right granularity for typing: hitting "x", "y", "z"
//     fast in a name field is one undoable edit, not three.
//   - `undo()` / `redo()` swap the session reference and set a
//     suppression flag so the subscriber doesn't re-record the restore
//     as a fresh edit. After the swap they (#15) sanitize selection
//     state and (#16) re-sync any linked SavedScenes from the restored
//     grid.
//   - Counters (`undoCount`, `redoCount`) live in Zustand state so
//     toolbar buttons can render disabled when the stack is empty.
//   - `resetUndoHistory()` is called from `setSession` / `newSession`
//     in the store — the freshly-loaded session is a clean slate.

import type { Session } from '@shared/types'
import { useStore } from './store'
import { setKnobDisplayImmediate } from './metaSmooth'

// (FEATURE C) Raised from 3 to 100: snapshots are now references with
// structural sharing, so deep history is cheap.
const MAX = 100
const SNAPSHOT_COALESCE_MS = 500

const pastSessions: Session[] = []
const futureSessions: Session[] = []

// True while undo() / redo() is rewriting session — prevents the
// subscriber from recording the restored state as a new edit.
let suppressSnapshot = false

// True while a coalesce window is open — the first change within
// the window captures, subsequent ones within `SNAPSHOT_COALESCE_MS`
// are ignored (treated as the same logical edit).
let coalesceOpen = false
let coalesceTimer: ReturnType<typeof setTimeout> | null = null

// (V18) > 0 while `withoutUndoSnapshot` runs — session writes made inside
// are live-performance state, not edits (a MIDI CC riding a Meta knob
// commits its value dozens of times a second), so they never open an
// undo step.
let bypassDepth = 0

/** Run `fn` without its session writes being recorded as an undo step. */
export function withoutUndoSnapshot(fn: () => void): void {
  bypassDepth++
  try {
    fn()
  } finally {
    bypassDepth--
  }
}

// (S11) Session fields that are VIEW state, not content: the focused
// scene anchor and the Meta Controller bar's visibility / height /
// selected knob (setShowMode flips `visible` too). A change touching only
// these is not an undo step.
const UI_ONLY_META_KEYS: ReadonlySet<string> = new Set(['visible', 'height', 'selectedKnob'])
function isUiOnlyChange(prev: Session, cur: Session): boolean {
  const p = prev as unknown as Record<string, unknown>
  const c = cur as unknown as Record<string, unknown>
  for (const k of new Set([...Object.keys(p), ...Object.keys(c)])) {
    if (p[k] === c[k] || k === 'focusedSceneId') continue
    if (k !== 'metaController' || !p[k] || !c[k]) return false
    const pm = p[k] as Record<string, unknown>
    const cm = c[k] as Record<string, unknown>
    for (const mk of new Set([...Object.keys(pm), ...Object.keys(cm)])) {
      if (pm[mk] !== cm[mk] && !UI_ONLY_META_KEYS.has(mk)) return false
    }
  }
  return true
}

// (S11) Since view-state changes are no longer undo steps, undo/redo must
// not rewind them either: the restored session keeps the CURRENT focus
// (when that scene still exists in it) and Meta bar view state.
function carryUiState(target: Session, cur: Session): Session {
  const focusedSceneId =
    cur.focusedSceneId && target.scenes.some((s) => s.id === cur.focusedSceneId)
      ? cur.focusedSceneId
      : target.focusedSceneId
  const tm = target.metaController
  const cm = cur.metaController
  const sameMeta =
    tm.visible === cm.visible && tm.height === cm.height && tm.selectedKnob === cm.selectedKnob
  if (focusedSceneId === target.focusedSceneId && sameMeta) return target
  return {
    ...target,
    focusedSceneId,
    metaController: sameMeta
      ? tm
      : { ...tm, visible: cm.visible, height: cm.height, selectedKnob: cm.selectedKnob }
  }
}

// (V18) A restored knob value must reach the dial AND the engine — the
// session swap alone left the display (metaSmooth) and the OSC output at
// the pre-undo position. Same IPC path as a knob edit.
function syncMetaKnobs(from: Session, to: Session): void {
  const a = from.metaController.knobs
  const b = to.metaController.knobs
  if (a === b) return
  for (let i = 0; i < b.length; i++) {
    const v = b[i]?.value
    if (typeof v !== 'number' || a[i]?.value === v) continue
    setKnobDisplayImmediate(i, v, true)
  }
}

// (FEATURE C) Dev-only flag — Vite injects `import.meta.env.DEV`. We
// cast through unknown so the typecheck stays clean without pulling in
// `vite/client` types (matches the existing `import.meta.hot` cast in
// OscMonitor.tsx). Production builds must NOT pay the freeze cost.
const IS_DEV =
  (import.meta as unknown as { env?: { DEV?: boolean } }).env?.DEV === true

// (FEATURE C) Recursively Object.freeze the session tree as it enters
// the undo stack, DEV ONLY. The store is strictly copy-on-write, so a
// frozen snapshot should never be touched again; if some future code
// mutates an undo-held object in place, the write throws loudly in dev
// (strict mode) instead of silently corrupting history. No-op in prod.
function deepFreezeDev<T>(value: T, seen = new WeakSet<object>()): T {
  if (!IS_DEV) return value
  if (value === null || typeof value !== 'object') return value
  if (seen.has(value as object)) return value
  seen.add(value as object)
  // Freeze children before the parent so the whole reachable tree is
  // immutable once the top object is frozen.
  for (const key of Object.keys(value as object)) {
    deepFreezeDev((value as Record<string, unknown>)[key], seen)
  }
  Object.freeze(value)
  return value
}

// (FEATURE C) Snapshot = take a reference, dev-freeze it. No clone.
function snapshot(s: Session): Session {
  return deepFreezeDev(s)
}

// (#15) Drop any selection / arm state that references a scene, track,
// or cell absent from the restored session — mirrors removeScene's
// cleanup (store.ts ~3088) so a restored timeline can't leave the
// Inspector pointing at a vanished object (its non-null assertion would
// otherwise crash). Returns a partial patch to merge into setState.
function sanitizeSelections(session: Session): {
  selectedCell: { sceneId: string; trackId: string } | null
  selectedCells: { sceneId: string; trackId: string }[]
  armedSceneId: string | null
  selectedSceneIds: string[]
} {
  const st = useStore.getState()
  const sceneIds = new Set(session.scenes.map((s) => s.id))
  const trackIds = new Set(session.tracks.map((t) => t.id))
  // A cell ref is valid only if its scene exists, the track exists, AND
  // that scene actually has a cell for that track in the restored grid.
  const cellExists = (r: { sceneId: string; trackId: string }): boolean => {
    if (!sceneIds.has(r.sceneId) || !trackIds.has(r.trackId)) return false
    const scene = session.scenes.find((s) => s.id === r.sceneId)
    return !!scene && !!scene.cells[r.trackId]
  }
  return {
    selectedCell:
      st.selectedCell && cellExists(st.selectedCell) ? st.selectedCell : null,
    selectedCells: st.selectedCells.filter(cellExists),
    armedSceneId:
      st.armedSceneId && sceneIds.has(st.armedSceneId) ? st.armedSceneId : null,
    selectedSceneIds: st.selectedSceneIds.filter((id) => sceneIds.has(id))
  }
}

// (#16) updateScene's linked-SavedScene mirror lives OUTSIDE the undo
// timeline (it writes the Pool library + disk directly, not via
// `session`). So an undo that reverts a linked scene's grid state would
// leave the Pool entry showing the post-edit value. After a restore,
// re-sync every linked SavedScene from the now-restored grid via the
// existing updateSavedSceneFromGrid path so the Pool matches the grid.
function resyncLinkedSavedScenes(session: Session): void {
  const seen = new Set<string>()
  const resync = useStore.getState().updateSavedSceneFromGrid
  for (const scene of session.scenes) {
    const id = scene.linkedSavedSceneId
    if (!id || seen.has(id)) continue
    seen.add(id)
    void resync(id)
  }
}

function publishCounts(): void {
  useStore.setState({
    undoCount: pastSessions.length,
    redoCount: futureSessions.length
  })
}

/** Reset both stacks. Called by `setSession` / `newSession`. */
export function resetUndoHistory(): void {
  pastSessions.length = 0
  futureSessions.length = 0
  publishCounts()
  // Cancel any pending coalesce window — the new session is a
  // brand-new baseline; subsequent edits should record cleanly.
  if (coalesceTimer) {
    clearTimeout(coalesceTimer)
    coalesceTimer = null
  }
  coalesceOpen = false
}

/** Rewind one step. No-op if the past stack is empty. */
export function undo(): void {
  if (pastSessions.length === 0) return
  const cur = useStore.getState().session
  futureSessions.push(snapshot(cur))
  if (futureSessions.length > MAX) futureSessions.shift()
  const prev = carryUiState(pastSessions.pop()!, cur)
  // Zustand v4 fires subscribers SYNCHRONOUSLY inside setState, so
  // raising and lowering the flag around the call is sufficient.
  // The microtask-deferred release used to leak the suppression
  // into any unrelated synchronous setState that landed right after
  // (e.g. an engine-state IPC push), causing a real edit to be
  // silently swallowed by the next coalesce window.
  suppressSnapshot = true
  try {
    // (#15) Sanitize selections against the restored session in the
    // SAME setState so the UI never observes a dangling ref mid-flight.
    useStore.setState({ session: prev, ...sanitizeSelections(prev) })
  } finally {
    suppressSnapshot = false
  }
  syncMetaKnobs(cur, prev)
  // (#16) Re-sync linked SavedScenes from the restored grid.
  resyncLinkedSavedScenes(prev)
  publishCounts()
}

/** Step forward one undone change. No-op if the redo stack is empty. */
export function redo(): void {
  if (futureSessions.length === 0) return
  const cur = useStore.getState().session
  pastSessions.push(snapshot(cur))
  if (pastSessions.length > MAX) pastSessions.shift()
  const next = carryUiState(futureSessions.pop()!, cur)
  suppressSnapshot = true
  try {
    // (#15) Same selection sanitation on the forward step.
    useStore.setState({ session: next, ...sanitizeSelections(next) })
  } finally {
    suppressSnapshot = false
  }
  syncMetaKnobs(cur, next)
  // (#16) Re-sync linked SavedScenes from the restored grid.
  resyncLinkedSavedScenes(next)
  publishCounts()
}

/** Hook the session subscriber. Call once at app startup. */
export function initUndo(): void {
  // We capture the pre-change state (passed as the second arg by
  // Zustand v4's subscribe-with-selector). The selector returns the
  // session reference; the listener fires only when it changes.
  useStore.subscribe((state, prevState) => {
    if (suppressSnapshot || bypassDepth > 0) return
    const cur = state.session
    const prev = prevState.session
    if (cur === prev) return
    // (S11) View-state-only change — not an edit, don't open (or extend)
    // an undo step for it.
    if (isUiOnlyChange(prev, cur)) return
    if (coalesceOpen) {
      // Inside the coalesce window — extend it so a stream of
      // rapid edits (typing, dragging a slider) lands as one step.
      if (coalesceTimer) clearTimeout(coalesceTimer)
      coalesceTimer = setTimeout(() => {
        coalesceOpen = false
        coalesceTimer = null
      }, SNAPSHOT_COALESCE_MS)
      return
    }
    // First change of a fresh window — capture the PRE state.
    // (FEATURE C) Reference snapshot (+ dev-only deep freeze), no clone.
    pastSessions.push(snapshot(prev))
    if (pastSessions.length > MAX) pastSessions.shift()
    // Any new edit drops the redo stack: branching from past has
    // diverged the timeline.
    if (futureSessions.length > 0) futureSessions.length = 0
    publishCounts()
    coalesceOpen = true
    coalesceTimer = setTimeout(() => {
      coalesceOpen = false
      coalesceTimer = null
    }, SNAPSHOT_COALESCE_MS)
  })
}
