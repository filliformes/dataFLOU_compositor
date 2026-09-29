// Device subscriptions (v0.6.6) — the outgoing "subscribe" handshake some
// OSC hardware needs before it streams anything, sent on session load and
// kept alive with a heartbeat. The data itself then arrives at the regular
// network listener, so Capture / Hardware Mode / the monitor see it like
// any other sender.
//
// Reference device: the Pandore daemon (677_pandore, daemon/src/plugins/
// osc.cpp + docs/specs/osc.md):
//   /pandore/{endpoint}/subscribe  i rate  s host  i port   (rate 0 = on-change)
//   events arrive on /pandore/{endpoint} (the subscribe ack too: i rate i armed)
//   subscriptions expire after 60 s unless the client sends anything;
//   /pandore/subscriptions renews that AND replies with this client's list.
//   Replies go to the sender's IP on the daemon's reply port (9001), so
//   heartbeat replies are only seen when the listener is on that port.
//   (/pandore/connect only opts into system events — not needed here.)
// A stopgap until the dataFLOU library mesh handles device discovery.
// Re-subscribing replaces the daemon's sink, which moves the data to a new
// source port, so we only re-send when the heartbeat says we're missing
// (daemon restarted) — never on a timer.

import * as dgram from 'dgram'
import * as os from 'os'
import * as osc from 'osc'
import type {
  OscEvent,
  OscSubscription,
  OscSubscriptionStatus,
  OscSubsProbeEndpoint,
  OscSubsProbeResult
} from '@shared/types'

type Arg = OscEvent['args'][number]

const TICK_MS = 1000
const HEARTBEAT_MS = 5000
const ALIVE_MS = 12000 // no reply for this long → unreachable
const DATA_FRESH_MS = 3000
const ACK_WINDOW_MS = 3000
const RETRY_MS = 10000 // re-send while nothing answers
const CUSTOM_RENEW_MS = 30000
const ERROR_SHOW_MS = 15000
const DEFAULT_REPLY_PORT = 9001
// Addresses we send ourselves — never count them as device data (a
// listener on the device port would otherwise hear our own broadcast).
const OWN_VERBS = /\/(subscribe|unsubscribe|subscriptions|ping|describe|connect)$/

interface Runtime {
  sub: OscSubscription
  sig: string
  sentAt: number | null
  // First send of the current unanswered streak — retries don't move it,
  // so a silent device reads "unreachable" instead of "waiting" forever.
  unansweredSince: number | null
  sentListenerPort: number | null
  replyHost: string
  target: string
  lastReplyAt: number | null
  lastAckAt: number | null
  lastDataAt: number | null
  dataCount: number
  rateWindowStart: number
  dataRateHz: number
  confirmed: boolean
  lastError: string | null
  lastErrorAt: number
}

interface ListenerInfo {
  enabled: boolean
  port: number
}

function normIp(ip: string): string {
  const s = ip.trim()
  if (s === 'localhost') return '127.0.0.1'
  return s.startsWith('::ffff:') ? s.slice(7) : s
}

function localIPv4s(): Set<string> {
  const out = new Set<string>()
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list ?? []) if (a.family === 'IPv4') out.add(a.address)
  }
  return out
}

function isLocal(ip: string, locals: Set<string>): boolean {
  return ip.startsWith('127.') || ip === '::1' || locals.has(ip)
}

// Subnet-directed broadcast for every external IPv4 interface. More
// reliable than 255.255.255.255, which Windows sends out one NIC only.
function broadcastAddresses(): string[] {
  const out = new Set<string>()
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list ?? []) {
      if (a.family !== 'IPv4' || a.internal) continue
      const ip = a.address.split('.').map(Number)
      const mask = a.netmask.split('.').map(Number)
      if (ip.length !== 4 || mask.length !== 4) continue
      out.add(ip.map((o, i) => (o | (~mask[i] & 255)) & 255).join('.'))
    }
  }
  out.add('255.255.255.255')
  return [...out]
}

// The local address the OS would route through to reach `host` — what a
// LAN device must send its data back to.
function localIpFacing(host: string): Promise<string | null> {
  return new Promise((resolve) => {
    const s = dgram.createSocket('udp4')
    const done = (v: string | null): void => {
      try {
        s.close()
      } catch {
        /* already closed */
      }
      resolve(v)
    }
    s.on('error', () => done(null))
    try {
      s.connect(9, host, () => {
        try {
          done(s.address().address)
        } catch {
          done(null)
        }
      })
    } catch {
      done(null)
    }
  })
}

function customArgs(template: string, rate: number, host: string, port: number): Arg[] {
  const out: Arg[] = []
  for (const tok of template.trim().split(/\s+/)) {
    if (!tok) continue
    if (tok === '{rate}') out.push({ type: 'i', value: Math.round(rate) })
    else if (tok === '{port}') out.push({ type: 'i', value: port })
    else if (tok === '{host}') out.push({ type: 's', value: host })
    else if (/^-?\d+$/.test(tok)) out.push({ type: 'i', value: parseInt(tok, 10) })
    else if (/^-?\d*\.\d+$/.test(tok)) out.push({ type: 'f', value: parseFloat(tok) })
    else out.push({ type: 's', value: tok })
  }
  return out
}

function sigOf(s: OscSubscription): string {
  return JSON.stringify([
    s.enabled,
    s.kind,
    normIp(s.host),
    s.port,
    s.endpoint,
    s.rateHz,
    s.replyPort ?? DEFAULT_REPLY_PORT,
    s.customArgs ?? '',
    s.customUnsubscribe ?? ''
  ])
}

// Same endpoint the daemon would stream to us on.
function pandoreDataMatch(endpoint: string, address: string): boolean {
  if (!address.startsWith('/pandore/')) return false
  const rest = address.slice(9)
  if (endpoint === '*') return !/^(pong|error|system|describe|subscriptions|connected|disconnected|status)\b/.test(rest)
  if (endpoint.endsWith('/*')) return rest.startsWith(endpoint.slice(0, -1))
  return rest === endpoint
}

export class OscSubscriptionManager {
  private udp: osc.UDPPort | null = null
  private ready = false
  private runtimes = new Map<string, Runtime>()
  private timer: ReturnType<typeof setInterval> | null = null
  private lastHeartbeat = new Map<string, number>() // per pandore device host:port
  private onSent: ((e: OscEvent) => void) | null = null
  private probeReplies: Map<string, { json: string; port: number }> | null = null
  private locals = localIPv4s()
  private localsAt = Date.now()

  constructor(private getListener: () => ListenerInfo) {}

  setOnSent(cb: ((e: OscEvent) => void) | null): void {
    this.onSent = cb
  }

  start(): void {
    if (this.udp) return
    const port = new osc.UDPPort({
      localAddress: '0.0.0.0',
      localPort: 0,
      metadata: true,
      broadcast: true
    })
    port.on('ready', () => {
      this.ready = true
      this.tick()
    })
    port.on('error', (err: Error) => {
      console.error('[OSC Subs] socket error:', err.message)
    })
    try {
      port.open()
      this.udp = port
    } catch (e) {
      console.error('[OSC Subs] open failed:', (e as Error).message)
    }
    this.timer = setInterval(() => this.tick(), TICK_MS)
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
    // Best effort — the daemon's TTL cleans up anything this misses.
    for (const rt of this.runtimes.values()) {
      if (rt.sub.enabled && rt.sentAt !== null) this.sendUnsubscribe(rt)
    }
    this.runtimes.clear()
    const udp = this.udp
    this.udp = null
    this.ready = false
    if (udp) {
      // Let the unsubscribes leave before the socket goes.
      setTimeout(() => {
        try {
          udp.close()
        } catch {
          /* ignore */
        }
      }, 100)
    }
  }

  /** Apply the session's list. Cheap when nothing changed (called on every session push). */
  update(list: OscSubscription[] | undefined): void {
    const next = new Map<string, OscSubscription>()
    for (const s of list ?? []) next.set(s.id, s)
    for (const [id, rt] of this.runtimes) {
      if (!next.has(id)) {
        if (rt.sub.enabled && rt.sentAt !== null) this.sendUnsubscribe(rt)
        this.runtimes.delete(id)
      }
    }
    let changed = false
    for (const [id, sub] of next) {
      const sig = sigOf(sub)
      const rt = this.runtimes.get(id)
      if (rt && rt.sig === sig) {
        rt.sub = sub // label-only edits
        continue
      }
      if (rt && rt.sub.enabled && rt.sentAt !== null) this.sendUnsubscribe(rt)
      this.runtimes.set(id, this.freshRuntime(sub, sig))
      changed = true
    }
    if (changed) this.tick()
  }

  resubscribe(id: string): void {
    const rt = this.runtimes.get(id)
    if (!rt) return
    this.runtimes.set(id, this.freshRuntime(rt.sub, rt.sig))
    this.tick()
  }

  getStatus(): OscSubscriptionStatus[] {
    const now = Date.now()
    const listener = this.getListener()
    const out: OscSubscriptionStatus[] = []
    for (const rt of this.runtimes.values()) {
      out.push(this.statusOf(rt, now, listener))
    }
    return out
  }

  /** Per incoming packet (network listener hook) — keep it cheap. */
  handleIncoming(e: OscEvent): void {
    if (this.runtimes.size === 0 && !this.probeReplies) return
    const addr = e.address
    const ip = normIp(e.ip)
    const now = Date.now()
    this.refreshLocals(now)
    // Replies reuse the request's address; only a reply carries args.
    if (addr === '/pandore/describe') {
      const json = e.args[0]?.value
      if (this.probeReplies && typeof json === 'string') {
        // This machine may answer on loopback AND on its LAN address.
        this.probeReplies.set(isLocal(ip, this.locals) ? '127.0.0.1' : ip, { json, port: e.port })
      }
      return
    }
    if (OWN_VERBS.test(addr) && addr !== '/pandore/subscriptions') return
    for (const rt of this.runtimes.values()) {
      const sub = rt.sub
      if (!sub.enabled || !this.hostMatches(sub.host, ip)) continue
      if (sub.kind === 'custom') {
        rt.lastReplyAt = now
        this.countData(rt, now)
        continue
      }
      if (addr === '/pandore/subscriptions') {
        rt.lastReplyAt = now
        const list = e.args
          .map((a) => (typeof a.value === 'string' ? a.value.split('@')[0] : ''))
          .filter(Boolean)
        rt.confirmed = list.includes(sub.endpoint)
        continue
      }
      if (addr === '/pandore/pong' || addr.startsWith('/pandore/system/')) {
        rt.lastReplyAt = now
        continue
      }
      if (addr === '/pandore/error') {
        const about = typeof e.args[0]?.value === 'string' ? (e.args[0].value as string) : ''
        if (about.startsWith(`/pandore/${sub.endpoint}`)) {
          const code = typeof e.args[1]?.value === 'string' ? e.args[1].value : 'ERROR'
          const msg = typeof e.args[2]?.value === 'string' ? e.args[2].value : ''
          rt.lastError = `${code}${msg ? ` — ${msg}` : ''}`
          rt.lastErrorAt = now
          rt.lastReplyAt = now
        }
        continue
      }
      if (!pandoreDataMatch(sub.endpoint, addr)) continue
      rt.lastReplyAt = now
      // Arg-less replies on the data address (unsubscribe ack) aren't data.
      if (e.args.length === 0) continue
      // The subscribe ack comes back on the data address: `i rate i armed`.
      if (
        rt.sentAt !== null &&
        now - rt.sentAt < ACK_WINDOW_MS &&
        e.args.length === 2 &&
        e.args[0].type === 'i' &&
        e.args[1].type === 'i' &&
        e.args[0].value === Math.round(sub.rateHz)
      ) {
        rt.lastAckAt = now
        rt.confirmed = true
        continue
      }
      this.countData(rt, now)
    }
  }

  /** Ask Pandore daemons what they expose. */
  async probe(opts: { network: boolean; port: number; replyPort: number }): Promise<OscSubsProbeResult> {
    const devPort = Number.isFinite(opts.port) && opts.port > 0 ? Math.round(opts.port) : 9000
    const replyPort =
      Number.isFinite(opts.replyPort) && opts.replyPort > 0 ? Math.round(opts.replyPort) : DEFAULT_REPLY_PORT
    if (this.probeReplies) return { devices: [], error: 'A search is already running.' }
    // A search right after launch can beat the socket's bind.
    for (let i = 0; i < 20 && !this.ready; i++) await new Promise((r) => setTimeout(r, 50))
    if (!this.ready) return { devices: [], error: 'Subscription socket is not open.' }
    this.probeReplies = new Map()
    // Replies go to <our IP>:replyPort. If the listener isn't there, hold
    // that port just for the probe window.
    let temp: osc.UDPPort | null = null
    let error: string | undefined
    const listener = this.getListener()
    if (!(listener.enabled && listener.port === replyPort)) {
      temp = await this.openTempReceiver(replyPort).catch((err: Error) => {
        error = `Port ${replyPort} is in use — Pandore replies there. Set the listener to ${replyPort}, or free the port.`
        console.error('[OSC Subs] probe receiver:', err.message)
        return null
      })
    }
    const targets = ['127.0.0.1', ...(opts.network ? broadcastAddresses() : [])]
    for (const host of targets) this.send(host, devPort, '/pandore/describe', [])
    await new Promise((r) => setTimeout(r, 1200))
    const replies = this.probeReplies
    this.probeReplies = null
    if (temp) {
      try {
        temp.close()
      } catch {
        /* ignore */
      }
    }
    const devices: OscSubsProbeResult['devices'] = []
    for (const [host, { json }] of replies) {
      try {
        const d = JSON.parse(json) as {
          endpoints?: { name?: unknown; kind?: unknown; mcu?: unknown; online?: unknown; mode?: unknown }[]
          mcus?: Record<string, unknown>
        }
        const endpoints: OscSubsProbeEndpoint[] = (d.endpoints ?? [])
          .filter((x) => typeof x?.name === 'string')
          .map((x) => ({
            name: x.name as string,
            kind: x.kind === 'pin' ? 'pin' : 'device',
            mcu: typeof x.mcu === 'string' ? x.mcu : '',
            online: x.online === true,
            ...(typeof x.mode === 'string' ? { mode: x.mode } : {})
          }))
        const mcus: Record<string, boolean> = {}
        for (const [k, v] of Object.entries(d.mcus ?? {})) mcus[k] = v === true
        devices.push({ host, port: devPort, endpoints, mcus })
      } catch {
        devices.push({ host, port: devPort, endpoints: [], mcus: {} })
      }
    }
    return { devices, ...(error && devices.length === 0 ? { error } : {}) }
  }

  // ── internals ─────────────────────────────────────────────────────

  private freshRuntime(sub: OscSubscription, sig: string): Runtime {
    return {
      sub,
      sig,
      sentAt: null,
      unansweredSince: null,
      sentListenerPort: null,
      replyHost: '',
      target: '',
      lastReplyAt: null,
      lastAckAt: null,
      lastDataAt: null,
      dataCount: 0,
      rateWindowStart: Date.now(),
      dataRateHz: 0,
      confirmed: false,
      lastError: null,
      lastErrorAt: 0
    }
  }

  private refreshLocals(now: number): void {
    if (now - this.localsAt > 10000) {
      this.locals = localIPv4s()
      this.localsAt = now
    }
  }

  private hostMatches(subHost: string, ip: string): boolean {
    const h = normIp(subHost)
    if (h === ip) return true
    return isLocal(h, this.locals) && isLocal(ip, this.locals)
  }

  private countData(rt: Runtime, now: number): void {
    rt.lastDataAt = now
    rt.dataCount++
  }

  private statusOf(rt: Runtime, now: number, listener: ListenerInfo): OscSubscriptionStatus {
    const base = {
      id: rt.sub.id,
      target: rt.target,
      confirmed: rt.confirmed,
      lastReplyAt: rt.lastReplyAt,
      lastDataAt: rt.lastDataAt,
      dataRateHz: rt.dataRateHz
    }
    const fresh = (t: number | null, ms: number): boolean => t !== null && now - t < ms
    if (!rt.sub.enabled) return { ...base, state: 'off', message: 'Off' }
    if (!listener.enabled) {
      return { ...base, state: 'error', message: 'Listener is off — turn on Listen to receive the data.' }
    }
    if (rt.lastError && now - rt.lastErrorAt < ERROR_SHOW_MS) {
      return { ...base, state: 'error', message: rt.lastError }
    }
    if (fresh(rt.lastDataAt, DATA_FRESH_MS)) {
      return { ...base, state: 'streaming', message: `Streaming ${rt.dataRateHz.toFixed(rt.dataRateHz < 10 ? 1 : 0)} msg/s` }
    }
    if (fresh(rt.lastReplyAt, ALIVE_MS) || fresh(rt.lastAckAt, ALIVE_MS)) {
      return {
        ...base,
        state: 'connected',
        message:
          rt.sub.kind === 'pandore' && rt.sub.rateHz === 0
            ? 'Device answers — waiting for a change (on-change)'
            : 'Device answers — no data yet'
      }
    }
    if (rt.sentAt === null) return { ...base, state: 'waiting', message: 'Not sent yet' }
    const since = rt.unansweredSince ?? rt.sentAt
    if (now - since < ALIVE_MS) {
      return { ...base, state: 'waiting', message: 'Subscribed — waiting for an answer' }
    }
    const replyPort = rt.sub.replyPort ?? DEFAULT_REPLY_PORT
    return {
      ...base,
      state: 'unreachable',
      message:
        rt.sub.kind === 'pandore' && listener.port !== replyPort
          ? `No data. Pandore answers on port ${replyPort} — listen there to see its heartbeat.`
          : 'No answer — device off, wrong address, or firewall.'
    }
  }

  private tick(): void {
    if (!this.ready || !this.udp) return
    const now = Date.now()
    const listener = this.getListener()
    const heartbeatDue = new Map<string, Runtime>() // pandore device key → a runtime on it
    for (const rt of this.runtimes.values()) {
      // Message rate over ~1 s windows.
      const span = now - rt.rateWindowStart
      if (span >= 1000) {
        rt.dataRateHz = (rt.dataCount * 1000) / span
        rt.dataCount = 0
        rt.rateWindowStart = now
      }
      if (!rt.sub.enabled || !listener.enabled) continue
      const listenerMoved = rt.sentListenerPort !== null && rt.sentListenerPort !== listener.port
      const answering =
        (rt.lastReplyAt !== null && now - rt.lastReplyAt < ALIVE_MS) ||
        (rt.lastDataAt !== null && now - rt.lastDataAt < DATA_FRESH_MS)
      let due = rt.sentAt === null || listenerMoved
      if (!due && rt.sub.kind === 'custom') due = now - rt.sentAt! >= CUSTOM_RENEW_MS
      if (!due && rt.sub.kind === 'pandore') {
        const sinceSent = now - rt.sentAt!
        const streaming = rt.lastDataAt !== null && now - rt.lastDataAt < DATA_FRESH_MS
        if (listener.port === (rt.sub.replyPort ?? DEFAULT_REPLY_PORT)) {
          // We hear the heartbeat. The daemon answers but doesn't list us
          // (it restarted / expired us) → re-send; silent device → retry.
          const listFresh = rt.lastReplyAt !== null && now - rt.lastReplyAt < HEARTBEAT_MS + 2000
          due =
            (listFresh && !rt.confirmed && !streaming && sinceSent >= HEARTBEAT_MS) ||
            (!answering && sinceSent >= RETRY_MS)
        } else {
          // Blind (replies go to another port): only data tells us anything.
          due = !streaming && sinceSent >= RETRY_MS
        }
      }
      if (due) void this.sendSubscribe(rt, listener.port)
      if (rt.sub.kind === 'pandore') {
        const key = `${normIp(rt.sub.host)}:${rt.sub.port}`
        if (!heartbeatDue.has(key)) heartbeatDue.set(key, rt)
      }
    }
    for (const [key, rt] of heartbeatDue) {
      const last = this.lastHeartbeat.get(key) ?? 0
      if (now - last < HEARTBEAT_MS) continue
      this.lastHeartbeat.set(key, now)
      // Renews the daemon's TTL for every subscription we hold there and
      // answers with the list (see handleIncoming).
      this.send(normIp(rt.sub.host), rt.sub.port, '/pandore/subscriptions', [])
    }
  }

  private async resolveReplyHost(sub: OscSubscription): Promise<string> {
    const h = normIp(sub.host)
    this.refreshLocals(Date.now())
    if (isLocal(h, this.locals)) return '127.0.0.1'
    return (await localIpFacing(h)) ?? ''
  }

  private async sendSubscribe(rt: Runtime, listenerPort: number): Promise<void> {
    const sub = rt.sub
    rt.sentAt = Date.now()
    const answered =
      (rt.lastReplyAt !== null && rt.sentAt - rt.lastReplyAt < ALIVE_MS) ||
      (rt.lastAckAt !== null && rt.sentAt - rt.lastAckAt < ALIVE_MS)
    if (answered) rt.unansweredSince = null
    else if (rt.unansweredSince === null) rt.unansweredSince = rt.sentAt
    rt.sentListenerPort = listenerPort
    rt.confirmed = false
    const replyHost = await this.resolveReplyHost(sub)
    // A newer update() may have replaced this runtime while we awaited.
    if (this.runtimes.get(sub.id) !== rt) return
    rt.replyHost = replyHost
    rt.target = `${replyHost || '(this machine)'}:${listenerPort}`
    const host = normIp(sub.host)
    if (sub.kind === 'custom') {
      this.send(host, sub.port, sub.endpoint, customArgs(sub.customArgs ?? '', sub.rateHz, replyHost, listenerPort))
      return
    }
    const rate = Math.max(0, Math.min(1000, Math.round(sub.rateHz)))
    const args: Arg[] = [{ type: 'i', value: rate }]
    if (replyHost) args.push({ type: 's', value: replyHost })
    args.push({ type: 'i', value: listenerPort })
    this.send(host, sub.port, `/pandore/${sub.endpoint}/subscribe`, args)
  }

  private sendUnsubscribe(rt: Runtime): void {
    const sub = rt.sub
    const host = normIp(sub.host)
    if (sub.kind === 'custom') {
      const addr = (sub.customUnsubscribe ?? '').trim()
      if (addr) {
        const port = rt.sentListenerPort ?? 0
        this.send(host, sub.port, addr, customArgs(sub.customArgs ?? '', sub.rateHz, rt.replyHost, port))
      }
      return
    }
    this.send(host, sub.port, `/pandore/${sub.endpoint}/unsubscribe`, [])
  }

  private send(host: string, port: number, address: string, args: Arg[]): void {
    if (!this.udp || !this.ready) return
    if (!address.startsWith('/') || !Number.isFinite(port) || port < 1 || port > 65535) return
    try {
      this.udp.send({ address, args: args.map((a) => ({ type: a.type, value: a.value })) }, host, port)
      this.onSent?.({ timestamp: Date.now(), ip: host, port, address, args })
    } catch (e) {
      console.error('[OSC Subs] send failed', host, port, address, (e as Error).message)
    }
  }

  private openTempReceiver(port: number): Promise<osc.UDPPort> {
    return new Promise((resolve, reject) => {
      const p = new osc.UDPPort({ localAddress: '0.0.0.0', localPort: port, metadata: true })
      let settled = false
      p.on('ready', () => {
        settled = true
        resolve(p)
      })
      p.on('error', (err: Error) => {
        if (!settled) {
          settled = true
          try {
            p.close()
          } catch {
            /* ignore */
          }
          reject(err)
        }
      })
      p.on('message', (...args: unknown[]) => {
        const msg = args[0] as { address?: unknown; args?: { type?: unknown; value?: unknown }[] } | undefined
        const info = args[2] as { address?: unknown; port?: unknown } | undefined
        if (!msg || typeof msg.address !== 'string' || typeof info?.address !== 'string') return
        this.handleIncoming({
          timestamp: Date.now(),
          ip: info.address,
          port: typeof info.port === 'number' ? info.port : 0,
          address: msg.address,
          args: (msg.args ?? []).map((a) => ({
            type: (a.type === 'i' || a.type === 'f' || a.type === 's' || a.type === 'T' || a.type === 'F'
              ? a.type
              : 's') as Arg['type'],
            value: a.value as Arg['value']
          }))
        })
      })
      try {
        p.open()
      } catch (e) {
        if (!settled) {
          settled = true
          reject(e as Error)
        }
      }
    })
  }
}
