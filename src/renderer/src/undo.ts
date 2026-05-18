// Three-deep undo / redo history for the session.
//
// Strategy:
//   - Module-scope ring buffers (max 3 each) hold deep-cloned Session
//     snapshots. Anything in the SESSION object is undoable —
//     pool, scenes, tracks, sequence, meta-controller bindings, etc.
//     Pure UI state (selection sets, focused scene, drawer widths,
//     transport timers) lives outside session and is NOT in undo.
//   - A Zustand `subscribe(selector, listener)` watches `session`
//     identity. The FIRST change inside a 500 ms window captures
//     the PRE state into `pastSessions`; subsequent rapid changes
//     within the window are coalesced into the same undo step.
//     This is the right granularity for typing: hitting "x", "y", "z"
//     fast in a name field is one undoable edit, not three.
//   - `undo()` / `redo()` mutate the session and set a suppression
//     flag so the subscriber doesn't re-record the restore as a
//     fresh edit.
//   - Counters (`undoCount`, `redoCount`) live in Zustand state so
//     toolbar buttons can render disabled when the stack is empty.
//   - `resetUndoHistory()` is called from `setSession` / `newSession`
//     in the store — the freshly-loaded session is a clean slate.

import type { Session } from '@shared/types'
import { useStore } from './store'

const MAX = 3
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

function deepClone(s: Session): Session {
  // structuredClone is the modern path — handles Maps, Sets, Dates,
  // ArrayBuffers, etc. Falls back to JSON for environments that
  // don't have it (older test runners), accepting the loss of
  // those exotic types — none of which appear in our Session shape.
  if (typeof structuredClone === 'function') {
    return structuredClone(s)
  }
  return JSON.parse(JSON.stringify(s)) as Session
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
  futureSessions.push(deepClone(cur))
  if (futureSessions.length > MAX) futureSessions.shift()
  const prev = pastSessions.pop()!
  // Zustand v4 fires subscribers SYNCHRONOUSLY inside setState, so
  // raising and lowering the flag around the call is sufficient.
  // The microtask-deferred release used to leak the suppression
  // into any unrelated synchronous setState that landed right after
  // (e.g. an engine-state IPC push), causing a real edit to be
  // silently swallowed by the next coalesce window.
  suppressSnapshot = true
  try {
    useStore.setState({ session: prev })
  } finally {
    suppressSnapshot = false
  }
  publishCounts()
}

/** Step forward one undone change. No-op if the redo stack is empty. */
export function redo(): void {
  if (futureSessions.length === 0) return
  const cur = useStore.getState().session
  pastSessions.push(deepClone(cur))
  if (pastSessions.length > MAX) pastSessions.shift()
  const next = futureSessions.pop()!
  suppressSnapshot = true
  try {
    useStore.setState({ session: next })
  } finally {
    suppressSnapshot = false
  }
  publishCounts()
}

/** Hook the session subscriber. Call once at app startup. */
export function initUndo(): void {
  // We capture the pre-change state (passed as the second arg by
  // Zustand v4's subscribe-with-selector). The selector returns the
  // session reference; the listener fires only when it changes.
  useStore.subscribe((state, prevState) => {
    if (suppressSnapshot) return
    const cur = state.session
    const prev = prevState.session
    if (cur === prev) return
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
    pastSessions.push(deepClone(prev))
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
