// OSC sender — one UDP socket bound locally, messages sent per-destination.

import * as osc from 'osc'

type Arg = { type: 'i' | 'f' | 's' | 'T' | 'F'; value: number | string | boolean }

export class OscSender {
  private udp: osc.UDPPort | null = null
  private ready = false
  private queue: Array<() => void> = []

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
        // Log but don't crash — send errors are non-fatal
        console.error('[OSC] error:', err.message)
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
      } catch (e) {
        console.error('[OSC] send failed', ip, port, (e as Error).message)
      }
    }
    if (this.ready) doSend()
    else this.queue.push(doSend)
  }
}
