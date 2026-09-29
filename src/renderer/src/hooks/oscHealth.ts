// OSC destination health tracker.
//
// Subscribes to main's batched OSC error stream and maintains a "last
// failed at" map keyed by `${ip}:${port}`. UI components call
// `useOscDestHealth(ip, port)` to get a boolean "currently failing" flag
// that auto-clears 5 s after the last failure.
//
// The failing set lives outside zustand (module-scope Map) so we don't
// trigger a session-wide re-render every time a new error batch arrives
// — only components actually using `useOscDestHealth` re-render, via a
// local tick.

import { useEffect, useState } from 'react'

const FAIL_WINDOW_MS = 5000

interface FailInfo {
  at: number
  message: string
}

const failures = new Map<string, FailInfo>()
const subscribers = new Set<() => void>()

function destKey(ip: string, port: number): string {
  return `${ip}:${port}`
}

function notify(): void {
  subscribers.forEach((fn) => fn())
}

// One-time wire-up: attach the main → renderer OSC-error stream. Safe to
// call multiple times — re-entrant guarded via the `attached` flag.
let attached = false
export function attachOscErrorStream(): void {
  if (attached) return
  attached = true
  window.api.onOscErrors((batch) => {
    for (const e of batch) {
      // Socket-level errors (ip '*') have no destination to flag.
      if (e.ip === '*') continue
      failures.set(destKey(e.ip, e.port), {
        at: e.timestamp,
        message: e.message
      })
    }
    notify()
  })
  // Prune expired entries once per second so the UI reflects the 5 s
  // window even when no new events arrive.
  setInterval(() => {
    const now = Date.now()
    let changed = false
    for (const [k, v] of failures) {
      if (now - v.at > FAIL_WINDOW_MS) {
        failures.delete(k)
        changed = true
      }
    }
    if (changed) notify()
  }, 1000)
}

/** Returns true if the given destination has seen a send failure in the
 *  last FAIL_WINDOW_MS. Components re-render when the set changes. */
export function useOscDestHealth(ip: string, port: number): {
  failing: boolean
  lastMessage: string | null
  lastAt: number | null
} {
  const [, forceRender] = useState(0)
  useEffect(() => {
    const tick = (): void => forceRender((n) => n + 1)
    subscribers.add(tick)
    return () => {
      subscribers.delete(tick)
    }
  }, [])
  const info = failures.get(destKey(ip, port))
  if (!info) return { failing: false, lastMessage: null, lastAt: null }
  const age = Date.now() - info.at
  if (age > FAIL_WINDOW_MS) return { failing: false, lastMessage: null, lastAt: null }
  return { failing: true, lastMessage: info.message, lastAt: info.at }
}
