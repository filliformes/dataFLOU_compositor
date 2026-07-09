// (v0.6.4) Connection Health — a single shared model of "is my OSC
// flowing?", consumed by BOTH the Pool → Network panel and the transport
// bottom-bar pill. Answers the recurring "why is nothing happening?"
// question: is the listener bound, are packets arriving, and is every
// destination we send to actually reachable (or throwing EHOSTDOWN)?
//
// Module-scope subscribers install ONCE at load (same pattern as the OSC
// Monitor) so the health model keeps updating regardless of which UI is
// mounted. `getHealthSnapshot()` is pure over the accumulated state; the
// `useConnectionHealth` hook re-renders its caller at ~2 Hz.

import { useEffect, useState } from 'react'
import { useStore } from './store'

export interface HealthSource {
  key: string
  ip: string
  port: number
  lastSeenMs: number
}
export interface HealthDest {
  key: string
  ip: string
  port: number
  lastSeenMs: number
  lastErrorMs: number
  lastError?: string
}
export interface HealthSnapshot {
  overall: 'ok' | 'warn' | 'error'
  listenerOn: boolean
  listenerPort: number
  listenerError: string
  inRatePerSec: number
  sources: HealthSource[]
  destinations: HealthDest[]
}

const RATE_WINDOW_MS = 1000 // packets counted over the trailing 1s
const ERROR_FRESH_MS = 3000 // a send error this recent = "unreachable now"
const PRUNE_MS = 60_000 // drop sources/dests unseen for a minute

const inTimestamps: number[] = []
const sources = new Map<string, HealthSource>()
const dests = new Map<string, HealthDest>()
// (v0.6.4) Latest slot-0 value per incoming OSC address — feeds the live
// dot on the Mapping transfer-curve plots.
const latestByAddress = new Map<string, number>()

// Latest incoming value at slot 0 for an OSC address (undefined if unseen).
export function latestForAddress(address: string): number | undefined {
  return latestByAddress.get(address)
}

// Cap distinct-address tracking so a device that sprays thousands of
// unique paths can't grow the map unbounded (delete oldest-inserted).
const MAX_ADDR = 512
function capAddr(): void {
  if (latestByAddress.size > MAX_ADDR) {
    const oldest = latestByAddress.keys().next().value
    if (oldest !== undefined) latestByAddress.delete(oldest)
  }
}

// Install the IPC taps once. window.api is absent in SSR/test envs. We
// collect the unsubscribe fns and dispose them on Vite HMR — otherwise
// editing this module double-subscribes and inflates the packet counts.
if (typeof window !== 'undefined' && window.api) {
  const offs: Array<(() => void) | undefined> = []
  offs.push(
    window.api.onOscInEvents?.((batch) => {
      for (const e of batch) {
        const t = e.timestamp || Date.now()
        inTimestamps.push(t)
        const key = `${e.ip}:${e.port}`
        sources.set(key, { key, ip: e.ip, port: e.port, lastSeenMs: t })
        const v0 = e.args?.[0]?.value
        if (typeof v0 === 'number' && Number.isFinite(v0)) {
          latestByAddress.set(e.address, v0)
          capAddr()
        } else if (typeof v0 === 'boolean') {
          latestByAddress.set(e.address, v0 ? 1 : 0)
          capAddr()
        }
      }
    })
  )
  offs.push(
    window.api.onOscEvents?.((batch) => {
      for (const e of batch) {
        if (!e.ip || e.ip === '*') continue
        const key = `${e.ip}:${e.port}`
        const d = dests.get(key)
        dests.set(key, {
          key,
          ip: e.ip,
          port: e.port,
          lastSeenMs: e.timestamp,
          lastErrorMs: d?.lastErrorMs ?? 0,
          lastError: d?.lastError
        })
      }
    })
  )
  offs.push(
    window.api.onOscErrors?.((batch) => {
      for (const e of batch) {
        if (!e.ip || e.ip === '*') continue
        const key = `${e.ip}:${e.port}`
        const d = dests.get(key)
        dests.set(key, {
          key,
          ip: e.ip,
          port: e.port,
          lastSeenMs: d?.lastSeenMs ?? 0,
          lastErrorMs: e.timestamp,
          lastError: e.message
        })
      }
    })
  )
  // `import.meta.hot` is injected by Vite; cast through unknown (same as
  // OscMonitor.tsx) since it isn't in the ImportMeta type here.
  const hot = (
    import.meta as unknown as { hot?: { dispose: (cb: () => void) => void } }
  ).hot
  if (hot) {
    hot.dispose(() => {
      for (const off of offs) off?.()
    })
  }
}

export function getHealthSnapshot(
  listenerOn: boolean,
  listenerPort: number,
  listenerError: string
): HealthSnapshot {
  const now = Date.now()
  // Trailing-window packet rate.
  while (inTimestamps.length && now - inTimestamps[0] > RATE_WINDOW_MS) {
    inTimestamps.shift()
  }
  const inRatePerSec = inTimestamps.length
  // Prune stale entries so the maps stay bounded.
  for (const [k, s] of sources) if (now - s.lastSeenMs > PRUNE_MS) sources.delete(k)
  for (const [k, d] of dests) {
    if (now - Math.max(d.lastSeenMs, d.lastErrorMs) > PRUNE_MS) dests.delete(k)
  }
  const srcArr = Array.from(sources.values()).sort(
    (a, b) => b.lastSeenMs - a.lastSeenMs
  )
  const destArr = Array.from(dests.values()).sort(
    (a, b) => b.lastSeenMs - a.lastSeenMs
  )
  // A destination is "unreachable now" if its most recent event was an
  // error within the freshness window (EHOSTDOWN, etc.).
  const anyDestError = destArr.some(
    (d) =>
      d.lastErrorMs > 0 &&
      now - d.lastErrorMs < ERROR_FRESH_MS &&
      d.lastErrorMs >= d.lastSeenMs
  )
  let overall: 'ok' | 'warn' | 'error'
  if (listenerError.length > 0 || anyDestError) overall = 'error'
  else if (!listenerOn || inRatePerSec === 0) overall = 'warn'
  else overall = 'ok'
  return {
    overall,
    listenerOn,
    listenerPort,
    listenerError,
    inRatePerSec,
    sources: srcArr,
    destinations: destArr
  }
}

// True when a destination's latest event is a fresh error (used by the UI
// to red-flag a single row).
export function destUnreachable(d: HealthDest): boolean {
  return (
    d.lastErrorMs > 0 &&
    Date.now() - d.lastErrorMs < ERROR_FRESH_MS &&
    d.lastErrorMs >= d.lastSeenMs
  )
}

export function useConnectionHealth(): HealthSnapshot {
  const status = useStore((s) => s.networkStatus)
  const [, setTick] = useState(0)
  useEffect(() => {
    const id = setInterval(() => setTick((n) => (n + 1) % 1_000_000), 500)
    return () => clearInterval(id)
  }, [])
  return getHealthSnapshot(status.enabled, status.port, status.lastError)
}
