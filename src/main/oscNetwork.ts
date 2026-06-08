// Passive OSC network listener — opens a UDP port and records every
// incoming message's sender IP/port + OSC path. The Pool drawer's
// Network tab consumes the resulting `DiscoveredOscDevice[]` so the
// user can drag-drop a sender straight onto the Edit sidebar.
//
// Design choice: passive listening (no mDNS, no OSCQuery yet). The
// user picks an inbox port (default 9000 — the de facto OSC port) and
// any device on the network that sends to <localIP>:<port> shows up.
// This works for every OSC implementation in existence and needs no
// cooperation from the sender; the cost is the user has to tell their
// device "send to <our IP>:9000" themselves. Future: layer mDNS /
// OSCQuery discovery on top so cooperating devices auto-pair.

import * as osc from 'osc'
import * as os from 'os'
import * as dgram from 'dgram'
import type {
  DiscoveredOscAddress,
  DiscoveredOscDevice,
  ForwardDiagEntry,
  NetworkListenerStatus,
  OscForwardTarget
} from '@shared/types'

// 9000 is the canonical OSC inbox port (TouchOSC, Lemur, Max/MSP demos,
// SuperCollider's sclang default, etc.). The user can override.
const DEFAULT_PORT = 9000

// Hard cap on tracked addresses per device. A pathological streaming
// sender that sprays /pix/0/0/r ... /pix/1023/767/b would otherwise
// pile up megabytes in the map; the UI also can't render thousands of
// rows usefully. 256 is enough for any reasonable instrument layout.
const MAX_ADDRESSES_PER_DEVICE = 256

// Cap on total devices. Most LANs have <20 plausible senders; this
// bound is mostly defensive (against a misconfigured broadcast spammer).
const MAX_DEVICES = 64

// Time-to-live for an address — addresses unseen for this long fall off
// the per-device list so the UI doesn't accumulate stale paths from a
// long-running session. Devices themselves persist until manual clear.
const ADDRESS_TTL_MS = 60_000

export class OscNetworkListener {
  private udp: osc.UDPPort | null = null
  private port = DEFAULT_PORT
  private enabled = false
  private lastError = ''
  private devices = new Map<string, DiscoveredOscDevice>()
  // Set whenever observe() mutates state; `flush()` checks it on the
  // periodic IPC timer so we only push to the renderer when something
  // actually changed (cheap when the network is quiet).
  private dirty = false
  // OSC forward targets — every received UDP packet is byte-copied to
  // each enabled target. Mutated via setForwardTargets(); a dedicated
  // outbound dgram socket (lazy-created on first enabled target) does
  // the actual sendto. We deliberately use a SEPARATE socket from the
  // listener so the forwarded packet's source port is ephemeral and
  // downstream consumers can't accidentally reply into the listener.
  private forwardTargets: OscForwardTarget[] = []
  private forwardSocket: dgram.Socket | null = null
  // Rate-limit forward error logging so a single bad target doesn't
  // flood the console at the upstream sender's packet rate (which can
  // be hundreds of msg/sec for control surfaces).
  private forwardErrorThrottle = new Map<string, number>()
  // v0.5.10 -- per-source diagnostic counters for the HW Mode
  // Suppress-check panel in the renderer. For each `${ip}:${port}`
  // we count:
  //   - received: total UDP packets observed from this source
  //   - suppressed: those that the suppress hook claimed (= HW Mode
  //     absorbed them and the byte-forward path was skipped)
  //   - forwarded: those that ran through forwardPacket() (would
  //     reach Max/PD/etc if any target is enabled)
  // The forwarded counter increments WHETHER OR NOT any target is
  // actually enabled -- we want to surface "this source is unsuppressed"
  // even when Forward is empty so the user can see the bug before it
  // bites. Capped at MAX_DEVICES entries (same defensive bound as the
  // device map) so a broadcast spammer can't OOM us.
  private forwardDiag = new Map<
    string,
    {
      ip: string
      port: number
      received: number
      suppressed: number
      forwarded: number
      // (v0.5.12) wall-clock ms when this source most recently sent
      // any packet. Used by the renderer to surface "configured HW
      // Mode source is silent" warnings without relying on per-poll
      // counter-delta comparison.
      lastSeenAtMs: number
    }
  >()
  // Push callback invoked by external code on each tick of the IPC
  // batching timer (set up in main/index.ts). Same shape as OscSender.
  private onUpdate:
    | ((payload: {
        status: NetworkListenerStatus
        devices: DiscoveredOscDevice[]
      }) => void)
    | null = null

  setOnUpdate(
    cb:
      | ((payload: {
          status: NetworkListenerStatus
          devices: DiscoveredOscDevice[]
        }) => void)
      | null
  ): void {
    this.onUpdate = cb
  }

  getStatus(): NetworkListenerStatus {
    return {
      enabled: this.enabled,
      port: this.port,
      localAddresses: getLocalIPv4Addresses(),
      lastError: this.lastError
    }
  }

  list(): DiscoveredOscDevice[] {
    // Trim stale addresses on every fetch — cheap (max 256 entries per
    // device, max 64 devices) and saves a separate sweeper timer.
    const now = Date.now()
    const out: DiscoveredOscDevice[] = []
    this.devices.forEach((dev) => {
      const fresh = dev.addresses.filter((a) => now - a.lastSeen <= ADDRESS_TTL_MS)
      out.push({ ...dev, addresses: fresh })
    })
    // Most-recent first so freshly-active senders pop to the top.
    out.sort((a, b) => b.lastSeen - a.lastSeen)
    return out
  }

  clear(): void {
    this.devices.clear()
    // Also wipe the diagnostic counters -- they only make sense
    // alongside the device list. Clearing one without the other
    // would surface stale "this source had dual-emission packets"
    // warnings for a device the user just forgot about.
    this.forwardDiag.clear()
    this.dirty = true
    // Immediately push the empty snapshot so the UI updates without
    // waiting for the next periodic flush.
    if (this.onUpdate) {
      this.onUpdate({ status: this.getStatus(), devices: [] })
    }
  }

  // v0.5.10 -- snapshot of the per-source forward diagnostic
  // counters. The renderer polls this from the HW Mode Suppress
  // panel in Pool > Network. Returned as a flat array so the UI
  // can sort it without an extra Object.entries() pass.
  getForwardDiag(): ForwardDiagEntry[] {
    const out: ForwardDiagEntry[] = []
    this.forwardDiag.forEach((e) => {
      out.push({
        ip: e.ip,
        port: e.port,
        received: e.received,
        suppressed: e.suppressed,
        forwarded: e.forwarded,
        lastSeenAtMs: e.lastSeenAtMs
      })
    })
    // Most-active first so the source we care about (typically a
    // HW controller streaming at high rate) pops to the top.
    out.sort((a, b) => b.received - a.received)
    return out
  }

  // v0.5.10 -- reset the diagnostic counters without clearing the
  // device map. Used by the "Reset counters" button in the panel
  // when the user wants to measure a fresh window (e.g. after
  // flipping a HW Mode toggle).
  clearForwardDiag(): void {
    this.forwardDiag.clear()
  }

  /**
   * Toggle the listener on/off and optionally re-bind on a different
   * port. Returns a status snapshot describing the post-action state
   * (so the renderer can read back the actual port + any bind error).
   */
  async setEnabled(enabled: boolean, port?: number): Promise<NetworkListenerStatus> {
    // Port-change first — if the user only wanted to change ports
    // while staying enabled, we close + re-open. Same code path
    // handles the "off → on with new port" case.
    if (port !== undefined && Number.isFinite(port) && port >= 1 && port <= 65535) {
      const intPort = Math.floor(port)
      if (intPort !== this.port) {
        this.port = intPort
        if (this.enabled) {
          // Hot re-bind. Close + open is simpler than trying to
          // mutate the bound port in place (the osc package doesn't
          // expose that anyway).
          await this.closeUdp()
          await this.openUdp()
          return this.getStatus()
        }
      }
    }
    if (enabled === this.enabled) return this.getStatus()
    if (enabled) await this.openUdp()
    else await this.closeUdp()
    return this.getStatus()
  }

  /**
   * Replace the forward-target list. The next received packet will
   * use the new list. Lazy-creates the outbound socket on first
   * enabled target; tears it down when the list becomes empty (or
   * all entries are disabled) so we don't hold a socket for nothing.
   */
  setForwardTargets(targets: OscForwardTarget[]): void {
    // Defensive copy + sanitisation. Bad ip/port get filtered out so
    // the hot path doesn't have to re-validate per packet. We keep
    // disabled targets in the list (the user might re-enable them
    // mid-session) but `forwardPacket` skips them.
    this.forwardTargets = targets
      .filter((t) => typeof t.id === 'string' && t.id.length > 0)
      .map((t) => ({
        id: t.id,
        enabled: !!t.enabled,
        label: t.label,
        ip: typeof t.ip === 'string' ? t.ip.trim() : '',
        port: Number.isFinite(t.port) ? Math.floor(t.port) : 0
      }))
      .filter((t) => t.ip.length > 0 && t.port >= 1 && t.port <= 65535)
    const anyEnabled = this.forwardTargets.some((t) => t.enabled)
    if (!anyEnabled && this.forwardSocket) {
      // No work to do — close the send socket so we're not holding
      // an unnecessary fd. Lazily reopened on the next enabled add.
      try {
        this.forwardSocket.close()
      } catch {
        /* ignore */
      }
      this.forwardSocket = null
    }
    // Clear the per-target error throttle on every config change so
    // a fresh "Pd at 127.0.0.1:1987" can log its first error even if
    // a previous "Pd at 127.0.0.1:1986" had hit the throttle.
    this.forwardErrorThrottle.clear()
  }

  /**
   * Byte-perfect copy of a received datagram to every enabled forward
   * target. Called from the raw dgram 'message' hook so we don't go
   * through osc-js's parse + re-encode (which can shift float bit
   * patterns and re-pad blobs). Errors are rate-limited per target.
   */
  private forwardPacket(buf: Buffer): void {
    if (this.forwardTargets.length === 0) return
    // Lazy-create the outbound socket on first send. Bound to port 0
    // so the OS picks an ephemeral source port. Bind to 0.0.0.0 so
    // routing follows the host's normal outbound table — same NIC
    // selection any other UDP send from this process gets.
    if (!this.forwardSocket) {
      try {
        this.forwardSocket = dgram.createSocket('udp4')
        this.forwardSocket.on('error', (err) => {
          console.error('[OSC Forward] outbound socket error:', err.message)
        })
      } catch (e) {
        console.error(
          '[OSC Forward] failed to create outbound socket:',
          (e as Error).message
        )
        this.forwardSocket = null
        return
      }
    }
    const sock = this.forwardSocket
    for (const t of this.forwardTargets) {
      if (!t.enabled) continue
      // Re-check the socket reference INSIDE the loop — a parallel
      // `setForwardTargets([])` between iterations can null
      // `this.forwardSocket` and close the underlying dgram, and
      // calling `.send` on a closed socket throws synchronously
      // (`ERR_SOCKET_DGRAM_NOT_RUNNING`). The try/catch absorbs the
      // tail of the race window where the listener fires this hot
      // path one more time after the user disabled forwarding.
      if (this.forwardSocket !== sock) break
      try {
        sock.send(buf, 0, buf.length, t.port, t.ip, (err) => {
          if (err) {
            // Rate-limit to 1 log per target per second — at high
            // packet rates an unreachable target would otherwise
            // bury the console.
            const now = Date.now()
            const last = this.forwardErrorThrottle.get(t.id) ?? 0
            if (now - last > 1000) {
              this.forwardErrorThrottle.set(t.id, now)
              console.error(
                `[OSC Forward] ${t.label || t.id} → ${t.ip}:${t.port} failed:`,
                err.message
              )
            }
          }
        })
      } catch (e) {
        // Synchronous throw — almost always the socket-not-running
        // case after a parallel close. One log, then bail the loop
        // since further targets would just hit the same error.
        console.error(
          '[OSC Forward] send threw, dropping batch:',
          (e as Error).message
        )
        break
      }
    }
  }

  /**
   * Called externally on the same 50ms timer the OSC sender uses to
   * batch outgoing-event IPC. Pushes only when something changed.
   */
  flush(): void {
    if (!this.dirty) return
    this.dirty = false
    if (this.onUpdate) {
      this.onUpdate({ status: this.getStatus(), devices: this.list() })
    }
  }

  // ── Internals ────────────────────────────────────────────────────

  private openUdp(): Promise<void> {
    return new Promise((resolve) => {
      const port = new osc.UDPPort({
        localAddress: '0.0.0.0',
        localPort: this.port,
        metadata: true
      })
      let settled = false
      port.on('ready', () => {
        this.enabled = true
        this.lastError = ''
        this.udp = port
        // Attach a RAW-bytes listener to the underlying dgram socket so
        // the forward path can byte-copy each datagram before osc-js
        // parses it. osc.UDPPort exposes `socket` after open(). Two
        // 'message' listeners coexist fine — dgram fans events out.
        const rawSock = (port as unknown as { socket?: dgram.Socket })
          .socket
        if (rawSock && typeof rawSock.on === 'function') {
          rawSock.on('message', (buf: Buffer, rinfo: dgram.RemoteInfo) => {
            if (!this.enabled) return
            // v0.5.10 -- update per-source diagnostic counters first,
            // BEFORE the no-forward-targets fast-out, so the panel
            // can still show "this source is unsuppressed" even when
            // no Forward target is enabled. Bounded by MAX_DEVICES.
            const diagIp =
              rinfo && typeof rinfo.address === 'string' ? rinfo.address : ''
            const diagPort =
              rinfo && typeof rinfo.port === 'number' ? rinfo.port : 0
            const suppressed =
              !!this.onShouldSuppressForwardHook &&
              diagIp.length > 0 &&
              diagPort > 0 &&
              this.onShouldSuppressForwardHook(diagIp, diagPort)
            if (diagIp.length > 0 && diagPort > 0) {
              const key = `${diagIp}:${diagPort}`
              let entry = this.forwardDiag.get(key)
              if (!entry) {
                if (this.forwardDiag.size < MAX_DEVICES) {
                  entry = {
                    ip: diagIp,
                    port: diagPort,
                    received: 0,
                    suppressed: 0,
                    forwarded: 0,
                    lastSeenAtMs: 0
                  }
                  this.forwardDiag.set(key, entry)
                }
              }
              if (entry) {
                entry.received += 1
                if (suppressed) entry.suppressed += 1
                else entry.forwarded += 1
                // (v0.5.12) timestamp every observation so the UI can
                // detect "this source has been silent for >5s" and
                // show the HardwareModeSection yellow warning badge.
                entry.lastSeenAtMs = Date.now()
              }
            }
            // Skip if no forward targets — avoids a Buffer copy and
            // the for-loop on every quiet packet.
            if (this.forwardTargets.length === 0) return
            // Hardware-Mode suppression: when the engine has Hardware
            // Mode enabled for a template bound to this source's
            // ip:port, skip the raw byte-forward. The engine consumes
            // the packet via the onMessageHook path and emits a clean
            // single-source value per parameter; relaying the raw
            // packet too would cause downstream consumers (Max, PD)
            // to receive the same OSC address with two competing
            // values per packet, producing flicker and message-queue
            // pressure that crashes Max after ~5 minutes of sustained
            // dual-emission. The hook itself early-returns when no HW
            // Mode template is enabled session-wide, so this check is
            // O(1) in the common case.
            if (suppressed) return
            this.forwardPacket(buf)
          })
        }
        if (!settled) {
          settled = true
          resolve()
        }
      })
      port.on('error', (err: Error) => {
        // EADDRINUSE / EACCES — surface to the UI via lastError, keep
        // enabled=false so the user can pick another port. We DON'T
        // reject so the renderer's `setEnabled` promise resolves with
        // a status snapshot describing the failure.
        console.error('[OSC Network] listener error:', err.message)
        this.lastError = err.message
        if (!settled) {
          // Bind failed during open — drop the half-built port and
          // surface failure via the resolved status snapshot.
          settled = true
          this.enabled = false
          this.udp = null
          try {
            port.close()
          } catch {
            /* ignore — already failed */
          }
          resolve()
        } else {
          // Post-ready error (ICMP "destination unreachable", socket
          // suddenly closed by another process, etc.) — tear down so
          // the next packet doesn't try to use a dead socket. The
          // status push the next flush() emits will show enabled=false
          // with the error message so the UI can prompt the user.
          this.enabled = false
          if (this.udp === port) {
            try {
              port.close()
            } catch {
              /* ignore */
            }
            this.udp = null
          }
          this.dirty = true
        }
      })
      // osc.js types `EventEmitter.on` with `(...args: unknown[]) => void`,
      // so cast inside instead of typing the params (TS won't narrow the
      // overload picked from a string literal).
      port.on('message', (...args: unknown[]) => {
        const msg = args[0] as
          | { address?: unknown; args?: unknown }
          | undefined
        const info = args[2] as { address?: unknown; port?: unknown } | undefined
        if (!msg || typeof msg.address !== 'string') return
        if (!info || typeof info.address !== 'string' || typeof info.port !== 'number') {
          return
        }
        const rawArgs = Array.isArray(msg.args) ? msg.args : []
        const normalised = rawArgs.map((a) => {
          const aa = a as { type?: unknown; value?: unknown }
          return {
            type: String(aa.type ?? ''),
            value: aa.value
          }
        })
        this.observe(info.address, info.port, {
          address: msg.address,
          args: normalised
        })
      })
      try {
        port.open()
      } catch (e) {
        // Synchronous throw — same handling as the async error path.
        console.error('[OSC Network] open failed:', (e as Error).message)
        this.lastError = (e as Error).message
        this.enabled = false
        this.udp = null
        if (!settled) {
          settled = true
          resolve()
        }
      }
    })
  }

  private closeUdp(): Promise<void> {
    return new Promise((resolve) => {
      // Always release the outbound forward socket on listener close.
      // It's a child of the listener session — keeping it open across
      // a listener restart would leak an fd if the user later disables
      // forwarding entirely.
      if (this.forwardSocket) {
        try {
          this.forwardSocket.close()
        } catch {
          /* ignore */
        }
        this.forwardSocket = null
      }
      const port = this.udp
      if (!port) {
        this.enabled = false
        resolve()
        return
      }
      // Detach from `this.udp` first so observe() rejects late packets
      // (it now checks enabled before touching the device map).
      this.udp = null
      this.enabled = false
      // Wait for the underlying socket's 'close' event before
      // resolving so a fast re-bind on a new port can't race the OS
      // releasing the old socket. The osc.UDPPort wraps a dgram
      // socket; we hook 'close' on either the port or its inner
      // socket if available. A safety timeout resolves anyway after
      // 500ms in case the close event never fires (e.g. socket
      // already closed, listener leak).
      let settled = false
      const finish = (): void => {
        if (settled) return
        settled = true
        clearTimeout(timeoutId)
        resolve()
      }
      const timeoutId = setTimeout(finish, 500)
      try {
        // osc.UDPPort re-emits 'close' from its inner dgram socket.
        // Hook listenerCallback on the port object — if it lacks
        // event support (unlikely), the timeout above still resolves.
        ;(port as unknown as { once?: (e: string, cb: () => void) => void }).once?.(
          'close',
          finish
        )
        port.close()
      } catch {
        /* ignore — fallback to the timeout */
      }
    })
  }

  // Optional per-message hook fired BEFORE the device-map update.
  // Used by the engine for Hardware Mode to react to every OSC
  // packet in real time (no 50ms flush latency). The hook receives
  // only numeric arg values — strings/blobs are stripped so the
  // engine doesn't have to mass-coerce on the hot path.
  private onMessageHook:
    | ((ip: string, port: number, address: string, numericArgs: number[]) => void)
    | null = null
  setOnMessage(
    fn: (ip: string, port: number, address: string, numericArgs: number[]) => void
  ): void {
    this.onMessageHook = fn
  }

  // Optional gate for the raw-bytes forward path. When set, the
  // listener will SKIP byte-forwarding any packet whose source
  // ip:port returns true from this predicate. Used by the engine to
  // suppress forwarding of packets coming from Hardware-Mode-bound
  // controllers — without this, the controller's raw OSC would be
  // both consumed by Hardware Mode (clean catch-mode emission) AND
  // independently relayed by the forward path, causing the same
  // OSC address to arrive at downstream consumers (PD, Max) with
  // two competing values per packet. The predicate is called inside
  // the dgram 'message' handler so it must be cheap (a Map lookup
  // or short linear scan); engines should return true only when
  // Hardware Mode actually wants to absorb the source.
  private onShouldSuppressForwardHook:
    | ((ip: string, port: number) => boolean)
    | null = null
  setOnShouldSuppressForward(
    fn: ((ip: string, port: number) => boolean) | null
  ): void {
    this.onShouldSuppressForwardHook = fn
  }

  private observe(
    ip: string,
    port: number,
    msg: { address: string; args: Array<{ type: string; value: unknown }> }
  ): void {
    // Guard: when the listener has been torn down (closeUdp set
    // `enabled=false` + nulled `udp`), late packets still in the
    // dgram queue can hit this handler. Dropping them here avoids
    // mutating the device map after the user has explicitly stopped
    // listening.
    if (!this.enabled) return
    // Fire the per-message hook FIRST so Hardware Mode reacts at the
    // packet's actual arrival time, not at the 50ms device-map
    // flush cadence. Engine handler is responsible for its own
    // filtering (per-template ip:port match + per-slot lock).
    if (this.onMessageHook) {
      // Extract just numeric values into a flat array. Trill /
      // pots / faders are float; switches are int. Anything else
      // (strings like the OCTOCOSME IP prefix) becomes NaN which
      // the engine treats as non-finite and skips.
      const nums: number[] = msg.args.map((a) =>
        typeof a.value === 'number'
          ? a.value
          : typeof a.value === 'boolean'
            ? a.value
              ? 1
              : 0
            : Number.NaN
      )
      this.onMessageHook(ip, port, msg.address, nums)
    }
    const key = `${ip}:${port}`
    const now = Date.now()
    let dev = this.devices.get(key)
    if (!dev) {
      // New sender. Refuse to grow past MAX_DEVICES so a broadcast
      // flood can't OOM the listener.
      if (this.devices.size >= MAX_DEVICES) return
      dev = {
        id: key,
        ip,
        port,
        firstSeen: now,
        lastSeen: now,
        packetCount: 0,
        addresses: [],
        // (v0.5.12) Flag loopback sources so the UI can de-emphasize
        // them. dataFLOU's own scene-to-loopback-bus pattern shows
        // up as packets from 127.0.0.1:<ephemeral>; without this
        // flag the user sees a "discovered device" that's actually
        // themselves.
        isLoopback: ip === '127.0.0.1' || ip === '::1'
      }
      this.devices.set(key, dev)
    }
    dev.lastSeen = now
    dev.packetCount += 1
    const argTypes = msg.args.map((a) => String(a.type))
    const argsPreview = msg.args
      .slice(0, 4)
      .map((a) => formatArgPreview(String(a.type), a.value))
      .join(' ')
    // Full last-seen values (capped) so the Capture popup can wire
    // up multi-arg argSpec[] entries correctly. The cap matches the
    // engine's typical max for a single OSC bundle — beyond this
    // we'd be looking at a streaming pathological case the UI
    // can't render usefully anyway.
    const MAX_RECORDED_ARGS = 16
    const argValues = msg.args.slice(0, MAX_RECORDED_ARGS).map((a) => {
      const v = a.value
      let coerced: number | string | boolean | null
      if (typeof v === 'number' || typeof v === 'string' || typeof v === 'boolean') {
        coerced = v
      } else if (v === null || v === undefined) {
        coerced = null
      } else {
        // Blob / bigint / etc. — stringify so the renderer at least
        // sees something printable.
        coerced = String(v)
      }
      return { type: String(a.type), value: coerced }
    })
    let addr = dev.addresses.find((a) => a.path === msg.address)
    if (!addr) {
      // Cap distinct addresses per device. The pathological case is a
      // sender that encodes a unique path per pixel/voxel/whatever —
      // we'd rather show the first 256 than blow the IPC payload.
      if (dev.addresses.length >= MAX_ADDRESSES_PER_DEVICE) {
        this.dirty = true
        return
      }
      addr = {
        path: msg.address,
        lastSeen: now,
        count: 0,
        argTypes,
        argsPreview,
        argValues
      }
      dev.addresses.push(addr)
    }
    addr.lastSeen = now
    addr.count += 1
    addr.argTypes = argTypes
    addr.argsPreview = argsPreview
    addr.argValues = argValues
    this.dirty = true
  }
}

/**
 * IPv4 addresses bound to the host's external NICs — the "send to me"
 * targets the user can configure on their OSC sender. Skips internal
 * loopback (127.0.0.1) because that's already obvious and isn't
 * routable from other machines on the LAN.
 */
function getLocalIPv4Addresses(): string[] {
  const out: string[] = []
  const ifs = os.networkInterfaces()
  for (const name in ifs) {
    const list = ifs[name]
    if (!list) continue
    for (const ni of list) {
      // Newer Node typings expose `family` as 'IPv4' (string); older
      // ones used the number 4. Accept both.
      const fam = ni.family as unknown
      const isV4 = fam === 'IPv4' || fam === 4
      if (isV4 && !ni.internal) out.push(ni.address)
    }
  }
  return out
}

function formatArgPreview(type: string, value: unknown): string {
  if (type === 'f' || type === 'd') {
    const n = Number(value)
    if (Number.isFinite(n)) {
      // Trim trailing zeros so 1.000 reads as 1.
      const s = n.toFixed(3)
      return s.replace(/\.?0+$/, '') || '0'
    }
    return String(value)
  }
  if (type === 'i') return String(value)
  if (type === 's') return `"${String(value).slice(0, 32)}"`
  if (type === 'T') return 'true'
  if (type === 'F') return 'false'
  if (type === 'N') return 'nil'
  if (type === 'b') return `[blob]`
  return String(value)
}

// The inference helper that maps a discovered address's OSC type tags
// to an `InstrumentFunction['paramType']` lives in `@shared/factory.ts`
// (`inferParamTypeFromArgTypes`) so the renderer can import it
// directly when materialising a Network tab device into a Pool
// Instrument Template.
