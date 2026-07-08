// Native MIDI output — wraps `@julusian/midi` (RtMidi) so the engine
// can fire CC + Note On/Off in parallel with OSC at tick rate, from
// the same loop that emits OSC. Native module is loaded lazily (the
// `require()` is wrapped in try/catch) so a broken prebuild doesn't
// crash the whole engine — just disables MIDI output and surfaces an
// error via `lastError`.
//
// Design mirrors `osc.ts`:
//   - `MidiOutSender` class with start() / send*() / stop()
//   - observers `setOnSent(cb)` + `setOnError(cb)` for the Monitor stream
//   - rate-limited stderr to keep tick-rate floods off the pipe
//   - the engine treats a missing native binding the same as a typo'd
//     port: surface the error, drop the message, keep ticking.

import type { MidiSendEvent, MidiErrorEvent } from '@shared/types'

// Native module bound lazily so a broken / missing prebuild
// degrades to "MIDI disabled" instead of crashing the engine.
// `@julusian/midi` ships prebuilds for win32-x64, darwin-x64,
// darwin-arm64; if any other platform shows up we just stay off.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let midiNative: any | null = null
let nativeLoadError: string | null = null
try {
  // Dynamic require so esbuild leaves the path alone and Electron
  // resolves it at runtime against `prebuilds/<platform>-<arch>/`.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  midiNative = require('@julusian/midi')
} catch (e) {
  nativeLoadError = (e as Error)?.message ?? String(e)
  console.error('[MIDI] native module load failed:', nativeLoadError)
}

// ── Rate-limited stderr (same pattern as osc.ts) ───────────────────
let lastErrorLogAt = 0
let suppressedErrors = 0
function rateLimitedError(...args: unknown[]): void {
  const now = Date.now()
  if (now - lastErrorLogAt >= 1000) {
    if (suppressedErrors > 0) {
      console.error(`[MIDI] (previous ${suppressedErrors} similar errors suppressed)`)
      suppressedErrors = 0
    }
    lastErrorLogAt = now
    console.error(...args)
  } else {
    suppressedErrors++
  }
}

// MIDI status nibbles for the three event types we currently emit.
const STATUS_NOTE_OFF = 0x80
const STATUS_NOTE_ON = 0x90
const STATUS_CC = 0xb0

// Clamp + integer-coerce a value to the 7-bit MIDI range. Handles
// NaN / Infinity / negative inputs from the engine's float pipeline.
function midi7(v: number): number {
  if (!Number.isFinite(v)) return 0
  const n = Math.round(v)
  return n < 0 ? 0 : n > 127 ? 127 : n
}

// MIDI channels are 0..15 on the wire but presented to the user as
// 1..16. Coerce + clamp; treat undefined as channel 1 (the most
// common single-device case).
function midiChannel(ch: number | undefined): number {
  // Number.isFinite guard: `??` only catches null/undefined, so a NaN
  // channel would otherwise flow through Math.floor as NaN and surface
  // as "NaN" in the Monitor (the wire nibble silently coerces to 1).
  const raw = Number.isFinite(ch) ? (ch as number) : 1
  const n = Math.floor(raw) - 1
  return n < 0 ? 0 : n > 15 ? 15 : n
}

export class MidiOutSender {
  /** Map keyed by port name → open RtMidi Output instance. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private ports = new Map<string, any>()
  /** Tracks "we tried to open this and it failed" so we don't
   *  re-attempt the open on every send (which would log a flood). */
  private failedPorts = new Set<string>()
  /** Global on/off — when false every send is a no-op and any open
   *  ports are closed. Matches `session.midiEnabled`. */
  private enabled = true
  /** Most recent native error message, surfaced to the UI. */
  private lastError = nativeLoadError ?? ''
  private onSent: ((e: MidiSendEvent) => void) | null = null
  private onError: ((e: MidiErrorEvent) => void) | null = null

  setOnSent(cb: ((e: MidiSendEvent) => void) | null): void {
    this.onSent = cb
  }
  setOnError(cb: ((e: MidiErrorEvent) => void) | null): void {
    this.onError = cb
  }

  /** Whether the native module loaded successfully. The renderer
   *  reads this to grey out MIDI controls when MIDI just isn't
   *  available on this platform. */
  isAvailable(): boolean {
    return midiNative !== null
  }

  getLastError(): string {
    return this.lastError
  }

  /** Enumerate output ports currently visible to the OS. Returns an
   *  empty list if the native module didn't load. Safe to call as
   *  often as the UI wants — RtMidi rescans on every read. */
  listPorts(): string[] {
    if (!midiNative) return []
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let probe: any = null
    try {
      probe = new midiNative.Output()
      const out: string[] = []
      const n = probe.getPortCount()
      for (let i = 0; i < n; i++) out.push(probe.getPortName(i))
      // A port that previously failed to open but is now visible again
      // (device re-plugged) should get a fresh chance — clear it from
      // the failed set so openOrGet retries instead of short-circuiting.
      for (const name of out) this.failedPorts.delete(name)
      return out
    } catch (e) {
      this.lastError = (e as Error).message
      return []
    } finally {
      // Always free the probe, even if getPortName threw mid-loop.
      try {
        probe?.destroy?.()
      } catch {
        /* ignore */
      }
    }
  }

  /** Global on/off. When flipping to OFF, close every open port so
   *  the OS hands them back to other software. When flipping to ON,
   *  ports re-open lazily on the next send. */
  setEnabled(enabled: boolean): void {
    if (enabled === this.enabled) return
    this.enabled = enabled
    if (!enabled) this.closeAll()
  }

  /** Send a CC. Opens the port lazily on first use. Drops silently
   *  if globally disabled, native module missing, or the port name
   *  has previously failed to open. */
  sendCc(portName: string, channel: number, cc: number, value: number): void {
    if (!this.enabled || !midiNative) return
    if (!portName) return
    const port = this.openOrGet(portName)
    if (!port) return
    const ch = midiChannel(channel)
    const ccByte = midi7(cc)
    const v = midi7(value)
    const msg = [STATUS_CC | ch, ccByte, v]
    this.sendRaw(port, portName, msg, {
      kind: 'cc',
      channel: ch + 1,
      data1: ccByte,
      data2: v
    })
  }

  /** Send Note On. velocity=0 is technically a Note Off per the MIDI
   *  spec — callers that want a true Note Off should call sendNoteOff
   *  instead so the message status nibble is unambiguous on the wire. */
  sendNoteOn(portName: string, channel: number, note: number, velocity: number): void {
    if (!this.enabled || !midiNative) return
    if (!portName) return
    const port = this.openOrGet(portName)
    if (!port) return
    const ch = midiChannel(channel)
    const n = midi7(note)
    const v = midi7(velocity)
    const msg = [STATUS_NOTE_ON | ch, n, v]
    this.sendRaw(port, portName, msg, {
      kind: 'noteOn',
      channel: ch + 1,
      data1: n,
      data2: v
    })
  }

  /** Send Note Off (status 0x8n, velocity 0). */
  sendNoteOff(portName: string, channel: number, note: number): void {
    if (!this.enabled || !midiNative) return
    if (!portName) return
    const port = this.openOrGet(portName)
    if (!port) return
    const ch = midiChannel(channel)
    const n = midi7(note)
    const msg = [STATUS_NOTE_OFF | ch, n, 0]
    this.sendRaw(port, portName, msg, {
      kind: 'noteOff',
      channel: ch + 1,
      data1: n,
      data2: 0
    })
  }

  /** Emergency stop — every open port, every channel, "All Notes
   *  Off" (CC 123) + "All Sound Off" (CC 120) + "Reset All
   *  Controllers" (CC 121). Called by engine.panic(). */
  panic(): void {
    if (!midiNative) return
    this.ports.forEach((port, name) => {
      try {
        for (let ch = 0; ch < 16; ch++) {
          port.send([STATUS_CC | ch, 120, 0]) // All Sound Off
          port.send([STATUS_CC | ch, 123, 0]) // All Notes Off
          port.send([STATUS_CC | ch, 121, 0]) // Reset All Controllers
        }
      } catch (e) {
        rateLimitedError(`[MIDI] panic on ${name} failed:`, (e as Error).message)
      }
    })
  }

  /** Close every open port. Called by setEnabled(false) and stop(). */
  closeAll(): void {
    this.ports.forEach((port, name) => {
      try {
        port.closePort()
        port.destroy?.()
      } catch {
        /* ignore */
      }
      void name
    })
    this.ports.clear()
    this.failedPorts.clear()
  }

  /** Engine shutdown — same as closeAll. */
  stop(): void {
    this.closeAll()
  }

  // ── Internals ──────────────────────────────────────────────────

  /** Lazy open. Returns the RtMidi Output for `portName` or null if
   *  the port doesn't exist (we record the failure so subsequent
   *  sends to the same name short-circuit without re-trying). */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private openOrGet(portName: string): any | null {
    if (!midiNative) return null
    const existing = this.ports.get(portName)
    if (existing) return existing
    if (this.failedPorts.has(portName)) return null
    try {
      const out = new midiNative.Output()
      out.openPortByName(portName)
      this.ports.set(portName, out)
      return out
    } catch (e) {
      this.failedPorts.add(portName)
      const message = `Could not open MIDI port "${portName}": ${(e as Error).message}`
      rateLimitedError('[MIDI]', message)
      this.lastError = message
      if (this.onError) {
        this.onError({
          timestamp: Date.now(),
          portName,
          channel: 0,
          message
        })
      }
      return null
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private sendRaw(
    port: any,
    portName: string,
    message: number[],
    meta: {
      kind: 'cc' | 'noteOn' | 'noteOff'
      channel: number
      data1: number
      data2: number
    }
  ): void {
    try {
      port.send(message)
      if (this.onSent) {
        this.onSent({
          timestamp: Date.now(),
          portName,
          kind: meta.kind,
          channel: meta.channel,
          data1: meta.data1,
          data2: meta.data2
        })
      }
    } catch (e) {
      const message = (e as Error).message
      rateLimitedError(`[MIDI] send to ${portName} failed:`, message)
      this.lastError = message
      // The handle is dead (device unplugged mid-show). Close + forget
      // it so the NEXT send re-opens lazily via openOrGet — otherwise
      // we'd keep sending to the same dead handle forever and the port
      // would never recover even after the device is re-plugged. We do
      // NOT add it to failedPorts (that's for open failures); a
      // reconnect should just re-open cleanly.
      try {
        port.closePort?.()
        port.destroy?.()
      } catch {
        /* already dead */
      }
      this.ports.delete(portName)
      if (this.onError) {
        this.onError({
          timestamp: Date.now(),
          portName,
          channel: meta.channel,
          message
        })
      }
    }
  }
}
