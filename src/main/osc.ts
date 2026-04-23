// OSC sender — one UDP socket bound locally, messages sent per-destination.

import * as osc from 'osc'

type Arg = { type: 'i' | 'f' | 's' | 'T' | 'F'; value: number | string | boolean }

export type OscSendEvent = {
  timestamp: number // Date.now() ms
  ip: string
  port: number
  address: string
  args: Arg[]
}

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

export class OscSender {
  private udp: osc.UDPPort | null = null
  private ready = false
  private queue: Array<() => void> = []
  // Optional observer invoked on every successful send — used by the OSC
  // monitor panel. Called AFTER the UDP write is handed off (i.e. on the
  // hot path), so it must be cheap: just push to an array.
  private onSent: ((e: OscSendEvent) => void) | null = null

  setOnSent(cb: ((e: OscSendEvent) => void) | null): void {
    this.onSent = cb
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
  }

  send(ip: string, port: number, address: string, arg: Arg): void {
    this.sendMany(ip, port, address, [arg])
  }

  /** Send an OSC message with multiple typed arguments. */
  sendMany(ip: string, port: number, address: string, args: Arg[]): void {
    const doSend = (): void => {
      if (!this.udp) return
      const osc_args = args.map((a) => ({ type: a.type, value: a.value }))
      try {
        this.udp.send({ address, args: osc_args }, ip, port)
        if (this.onSent) {
          this.onSent({ timestamp: Date.now(), ip, port, address, args })
        }
      } catch (e) {
        rateLimitedError('[OSC] send failed', ip, port, (e as Error).message)
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
