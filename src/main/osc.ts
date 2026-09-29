// OSC sender — one UDP socket bound locally, messages sent per-destination.

import * as osc from 'osc'
import type { OscErrorEvent, OscEvent } from '@shared/types'

type Arg = OscEvent['args'][number]

// One successful send, as surfaced to the OSC monitor. Same shape as the
// shared OscEvent (re-exported under the sender-side name).
export type OscSendEvent = OscEvent

// Fired when a send fails (synchronous throw in dgram.send, async 'error'
// on the UDP socket from ICMP unreachable on Windows, etc.). Socket-level
// errors that can't be attributed to a specific destination use ip='*',
// port=0, address='' — the UI treats them as system-wide warnings.
export type { OscErrorEvent }

// Rate-limit stderr output so the engine can't flood the dev-server /
// PowerShell pipe with identical "send failed" lines at tick rate. The
// old unconditional console.error at 120 Hz × N cells was enough to
// block Node's stdout write on Windows once the pipe buffer filled,
// which manifested as BOTH the Electron main process and the terminal
// hosting the dev server freezing simultaneously.
let lastErrorLogAt = 0
let suppressedErrors = 0
function rateLimitedError(...args: unknown[]): void {
  const now = Date.now()
  if (now - lastErrorLogAt >= 1000) {
    if (suppressedErrors > 0) {
      console.error(
        `[OSC] (previous ${suppressedErrors} similar errors suppressed)`
      )
      suppressedErrors = 0
    }
    lastErrorLogAt = now
    console.error(...args)
  } else {
    suppressedErrors++
  }
}

// Accept dotted IPv4, "localhost", or simple broadcast/multicast
// addresses. This is a fast pre-check so typo'd destinations ("127.O.O.1"
// with capital O instead of zero) fire an instant onError → red dot,
// rather than silently dropping the packet inside dgram.
function isPlausibleIpLiteral(ip: string): boolean {
  if (!ip) return false
  if (ip === 'localhost') return true
  // Dotted quad with each octet 0..255.
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip)
  if (!m) return false
  for (let i = 1; i <= 4; i++) {
    const n = Number(m[i])
    if (!Number.isFinite(n) || n < 0 || n > 255) return false
  }
  return true
}

export class OscSender {
  private udp: osc.UDPPort | null = null
  private ready = false
  private queue: Array<() => void> = []
  // Optional observer invoked on every successful send — used by the OSC
  // monitor panel. Called AFTER the UDP write is handed off (i.e. on the
  // hot path), so it must be cheap: just push to an array.
  private onSent: ((e: OscSendEvent) => void) | null = null
  private onError: ((e: OscErrorEvent) => void) | null = null
  // Last (ip, port, address) handed to dgram.send — used to attribute
  // ASYNC port 'error' events back to a specific destination. UDP errors
  // come through the socket's error event some ms after the failing send,
  // so we don't have a perfect mapping, but for the "dot on failure" UX
  // it's good enough: persistently-bad destinations always match.
  private lastSendDest: { ip: string; port: number; address: string } | null = null

  setOnSent(cb: ((e: OscSendEvent) => void) | null): void {
    this.onSent = cb
  }
  setOnError(cb: ((e: OscErrorEvent) => void) | null): void {
    this.onError = cb
  }

  async start(localPort = 0): Promise<void> {
    return new Promise((resolve, reject) => {
      const port = new osc.UDPPort({
        localAddress: '0.0.0.0',
        localPort,
        metadata: true
      })
      port.on('ready', () => {
        this.ready = true
        this.queue.forEach((fn) => fn())
        this.queue.length = 0
        resolve()
      })
      port.on('error', (err: Error) => {
        // Log but don't crash — send errors are non-fatal. Rate-limited
        // so a persistently-bad destination can't flood stderr. Also
        // drain the pre-ready queue on hard errors so a port that never
        // opens doesn't grow the queue unboundedly (tick-rate sends
        // would otherwise keep piling up and leak memory).
        rateLimitedError('[OSC] error:', err.message)
        if (!this.ready) this.queue.length = 0
        // Attribute the async error to the most recently attempted
        // destination. Not perfect if many sends are in flight at once,
        // but persistently-bad destinations (unreachable host, port
        // closed) always fail on the SAME dest, so the dot lights up
        // correctly in practice.
        const dest = this.lastSendDest
        if (this.onError) {
          this.onError({
            timestamp: Date.now(),
            ip: dest?.ip ?? '*',
            port: dest?.port ?? 0,
            address: dest?.address ?? '',
            message: err.message
          })
        }
      })
      try {
        port.open()
      } catch (e) {
        reject(e)
        return
      }
      this.udp = port
    })
  }

  stop(): void {
    if (this.udp) {
      try {
        this.udp.close()
      } catch {
        /* ignore */
      }
      this.udp = null
      this.ready = false
    }
    // Always drain the pre-ready queue — stopping before 'ready' fires
    // would otherwise leak the deferred doSend closures forever
    // (next `start()` opens a NEW UDPPort with its own 'ready' that
    // never sees them). Cheap to clear regardless.
    this.queue.length = 0
  }

  send(ip: string, port: number, address: string, arg: Arg): void {
    this.sendMany(ip, port, address, [arg])
  }

  /** Send an OSC message with multiple typed arguments. */
  sendMany(ip: string, port: number, address: string, args: Arg[]): void {
    // Fast-path validation BEFORE queuing / sending so UI gets a red dot
    // the moment the user introduces a typo, instead of silently failing
    // inside dgram. UDP drops to unreachable hosts are asynchronous and
    // caught separately via port.on('error').
    if (!isPlausibleIpLiteral(ip)) {
      const message = `Invalid IP address: "${ip}"`
      rateLimitedError('[OSC]', message)
      if (this.onError) {
        this.onError({ timestamp: Date.now(), ip, port, address, message })
      }
      return
    }
    if (!Number.isFinite(port) || port < 1 || port > 65535) {
      const message = `Invalid port: ${port}`
      rateLimitedError('[OSC]', message)
      if (this.onError) {
        this.onError({ timestamp: Date.now(), ip, port, address, message })
      }
      return
    }

    const doSend = (): void => {
      if (!this.udp) return
      const osc_args = args.map((a) => ({ type: a.type, value: a.value }))
      // Stamp the last-send destination BEFORE handing to dgram so any
      // async 'error' that fires a few ms later can be attributed.
      this.lastSendDest = { ip, port, address }
      try {
        this.udp.send({ address, args: osc_args }, ip, port)
        if (this.onSent) {
          this.onSent({ timestamp: Date.now(), ip, port, address, args })
        }
      } catch (e) {
        const message = (e as Error).message
        rateLimitedError('[OSC] send failed', ip, port, message)
        if (this.onError) {
          this.onError({ timestamp: Date.now(), ip, port, address, message })
        }
      }
    }
    if (this.ready) doSend()
    else {
      // Cap the pre-ready queue to prevent runaway memory growth if the
      // UDP socket is slow to bind (or never does). At 120 Hz × multiple
      // cells we can buffer a lot in a second; 1024 is plenty.
      if (this.queue.length < 1024) this.queue.push(doSend)
    }
  }
}
