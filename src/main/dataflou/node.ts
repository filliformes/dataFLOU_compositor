// DataflouNode — a full dataflou mesh node in TypeScript. Port of
// src/core/node.cpp from 124_dataflou @ ead3801 (core_ver 8, protocol v2),
// on Node.js sockets instead of the tick-driven PAL:
//   discovery  mDNS/DNS-SD (mdns.ts)
//   topology   TCP, length-prefixed CBOR (protocol.ts): HELLO / DECLARE /
//              ACK / LEAVE / DIGEST / FLUSH / BLOB / BLOBREQ / SUBREQ /
//              SETVAL / PADMIN / STREAMREQ / STREAMSTOP / SUBANNOUNCE /
//              IDENTIFY
//   data plane UDP on TCP port + 1 (streamCodec.ts), destination-driven,
//              keepalive 15 s / expiry 30 s, receiver-side range mapping;
//              visualizer monitors (STREAMREQ with an empty dest_path)
//
// Behaviour follows the C++ node; deliberate differences are marked "TS:".

import { EventEmitter } from 'events'
import * as dgram from 'dgram'
import * as fs from 'fs'
import * as net from 'net'
import * as path from 'path'
import { DataflouMdns, type MdnsPeer } from './mdns'
import {
  ParamKind,
  FlowDir,
  WorldView,
  normalizeValue,
  sameValue,
  type NodeIdentity,
  type ParamMeta,
  type ParamNode,
  type ParamSubscription,
  type ParamValue,
  ParamStore
} from './model'
import * as P from './protocol'
import { crc32Sku, decodeStreamPacket, encodeStreamPacket } from './streamCodec'

export const CORE_VERSION = '8' // library DATAFLOU_VERSION this port tracks

const DIGEST_INTERVAL_MS = 10000
const PERSIST_DEBOUNCE_MS = 2000
const PEER_TIMEOUT_MS = 30000
const MAX_RECV_FRAME = 32768 // DATAFLOU_RECV_BUF_SIZE
const KEEPALIVE_INTERVAL_MS = 15000 // STREAM_KEEPALIVE_INTERVAL_MS
const KEEPALIVE_TIMEOUT_MS = 30000 // STREAM_KEEPALIVE_TIMEOUT_MS
const STREAM_TICK_MS = 4
// TS: refresh an unchanged streamed value once a second so a receiver that
// lost a packet (UDP) or joined late converges (C++ resends every tick at
// `rate` while the dirty flag — never cleared in the core — stays set).
const STREAM_REFRESH_MS = 1000
// TS: if the lower-SKU peer hasn't dialled us within this window (it may
// have missed our mDNS record), dial it ourselves.
const PENDING_FALLBACK_MS = 5000
const CONNECT_TIMEOUT_MS = 5000
const MAX_STREAM_TARGETS = 128 // DATAFLOU_MAX_STREAM_TARGETS
const MAX_MONITOR_TARGETS = MAX_STREAM_TARGETS / 2 // DATAFLOU_MAX_MONITOR_TARGETS
const MAX_MONITORS = 256 // DATAFLOU_MAX_MONITORS (requester side, desktop)
const MONITOR_RATE_HZ = 10 // Node::MONITOR_RATE_HZ

interface Peer {
  socket: net.Socket
  sku: string
  address: string
  port: number
  helloSent: boolean
  helloReceived: boolean
  lastMsgMs: number
  recv: Buffer
  closed: boolean
}

interface StreamTarget {
  destSku: string
  destAddress: string
  destUdpPort: number
  localPath: string
  destPath: string
  rateHz: number
  lastSentMs: number
  lastSentEpoch: number
  lastRequestMs: number // 0 = local-to-local (never expires)
  monitor: boolean // visualizer monitor (empty destPath): lowest priority
}

interface MonitorEntry {
  sku: string
  skuHash: number
  path: string
}

interface InboundEntry {
  sourceSkuHash: number
  sourceSku: string
  sourcePath: string
  localPath: string
}

export interface LocalDecl {
  path: string
  meta: ParamMeta
}

export interface DataflouNodeOptions {
  identity: NodeIdentity
  universe: string
  storageDir: string // base; state goes in <base>/<universe>/<sku>/
  extraTxt?: string[]
}

export type ValueOrigin = 'setval' | 'stream'

export class DataflouNode extends EventEmitter {
  readonly world = new WorldView()
  readonly local = new ParamStore()
  identity: NodeIdentity
  universe: string
  listenPort = 0
  running = false

  private storageBase: string
  private extraTxt: string[]
  private declVersion = 1
  private seq = 0
  private server: net.Server | null = null
  private udp: dgram.Socket | null = null
  private mdns = new DataflouMdns()
  private peers: Peer[] = []
  private pending = new Map<string, { address: string; port: number; since: number }>()
  private targets: StreamTarget[] = []
  private inbound: InboundEntry[] = []
  // Subscriptions live by local path so they survive the local tree being
  // rebuilt (an app may re-declare its whole tree whenever its state changes).
  private subs = new Map<string, ParamSubscription[]>()
  private skuHash = 0
  private timers: ReturnType<typeof setInterval>[] = []
  private lastDigest = 0
  private lastKeepalive = 0
  private persistTimer: ReturnType<typeof setTimeout> | null = null
  private monitorOn = false
  private monitors: MonitorEntry[] = []
  private lastMonitorKeepalive = 0
  readonly logLines: string[] = []

  constructor(opts: DataflouNodeOptions) {
    super()
    this.identity = { ...opts.identity }
    this.universe = opts.universe || 'default'
    this.storageBase = opts.storageDir
    this.extraTxt = opts.extraTxt ?? []
    this.skuHash = crc32Sku(this.identity.sku)
  }

  // ── lifecycle ─────────────────────────────────────────────────────

  async start(): Promise<void> {
    if (this.running) return
    this.loadSubscriptions()
    const self = this.world.upsert(this.identity.sku)
    self.identity = { ...this.identity }
    self.declVersion = this.declVersion
    self.isLocal = true
    self.online = true
    self.firstSeenMs = self.lastSeenMs = Date.now()
    self.params = this.local // TS: shared, not copied (no sync step needed)

    // TCP listener on an ephemeral port, UDP on port + 1 (the library's
    // convention — peers derive our data port from it). Retry until both bind.
    for (let attempt = 0; attempt < 12; attempt++) {
      const server = net.createServer((s) => this.onInbound(s))
      const port = await new Promise<number>((resolve, reject) => {
        server.once('error', reject)
        server.listen(0, '0.0.0.0', () => resolve((server.address() as net.AddressInfo).port))
      })
      const udp = dgram.createSocket({ type: 'udp4', reuseAddr: false })
      const ok = await new Promise<boolean>((resolve) => {
        udp.once('error', () => resolve(false))
        udp.bind(port + 1, '0.0.0.0', () => resolve(true))
      })
      if (ok) {
        this.server = server
        this.udp = udp
        this.listenPort = port
        break
      }
      server.close()
      try {
        udp.close()
      } catch {
        /* never bound */
      }
    }
    if (!this.server || !this.udp) throw new Error('dataflou: could not bind TCP/UDP ports')
    this.server.on('error', (e) => this.log(`TCP server error: ${e.message}`))
    this.udp.on('error', (e) => this.log(`UDP error: ${e.message}`))
    this.udp.on('message', (buf) => this.onUdp(buf))

    this.mdns.on('peer', (p: MdnsPeer) => this.onPeerFound(p))
    this.mdns.on('log', (m: string) => this.log(m))
    this.advertise()

    this.running = true
    this.lastDigest = this.lastKeepalive = Date.now()
    this.timers.push(setInterval(() => this.housekeeping(), 500))
    this.timers.push(setInterval(() => this.pollStream(), STREAM_TICK_MS))
    this.rebuildInbound()
    this.log(`Node started: ${this.identity.label} (port ${this.listenPort}, udp ${this.listenPort + 1}, universe ${this.universe})`)
  }

  stop(): void {
    if (!this.running) return
    this.running = false
    this.monitors = [] // the sources drop our targets when we disconnect
    const leave = P.frame(P.encodeLeave(++this.seq, this.identity.sku))
    for (const p of this.peers) {
      try {
        p.socket.end(leave)
      } catch {
        /* closing anyway */
      }
    }
    for (const p of this.peers) p.closed = true
    this.peers = []
    for (const t of this.timers) clearInterval(t)
    this.timers = []
    this.mdns.stop()
    this.mdns.removeAllListeners('peer')
    this.mdns.removeAllListeners('log')
    this.server?.close()
    this.server = null
    try {
      this.udp?.close()
    } catch {
      /* already closed */
    }
    this.udp = null
    this.flushPersist()
    this.log('Node stopped')
  }

  private advertise(): void {
    const sku8 = this.identity.sku.slice(0, 8)
    const txt = [
      `sku=${this.identity.sku}`,
      `ver=${this.identity.version}`,
      `core_ver=${CORE_VERSION}`,
      `univ=${this.universe}`,
      `started=${Math.floor(Date.now() / 1000)}`,
      ...this.extraTxt.slice(0, 3)
    ]
    this.mdns.start(`${this.identity.label}-${sku8}`, sku8, this.listenPort, txt)
  }

  // ── identity / universe ───────────────────────────────────────────

  setLabel(label: string): void {
    if (!label || label === this.identity.label) return
    this.identity.label = label
    const self = this.world.find(this.identity.sku)
    if (self) self.identity.label = label
    this.bumpAndRedeclare()
    if (this.running) this.advertise()
  }

  /** Universe switch with the library's purge (topology.md). */
  setUniverse(name: string): void {
    const next = name || 'default'
    if (next === this.universe) return
    const old = this.universe
    this.universe = next
    if (!this.running) return
    this.log(`Universe changed: ${old} -> ${next} — purging`)
    this.flushPersist()
    for (const p of [...this.peers]) this.disconnect(p, false)
    this.peers = []
    this.pending.clear()
    this.targets = []
    this.monitors = [] // re-requested from the new universe's peers
    for (const n of [...this.world.nodes]) if (!n.isLocal) this.world.remove(n.identity.sku)
    this.loadSubscriptions()
    this.applySubscriptionsToTree()
    this.rebuildInbound()
    this.advertise()
    this.bumpAndRedeclare()
    this.emit('topology')
  }

  // ── local declarations / values ──────────────────────────────────

  /**
   * Replace the local parameter tree in one go (one decl_version bump, one
   * DECLARE per peer). Values survive for paths whose type is unchanged;
   * subscriptions are re-attached by path.
   */
  replaceLocalParams(decls: LocalDecl[]): void {
    const keep = new Map<string, ParamValue>()
    this.local.walk((p, n) => keep.set(p, n.value))
    this.local.clear()
    for (const d of decls) {
      const node =
        d.meta.kind === ParamKind.Group ? this.local.declareGroup(d.path, d.meta) : this.local.declareParam(d.path, d.meta)
      const old = keep.get(d.path)
      if (node && old && old.tag === node.meta.type) node.value = old
    }
    this.applySubscriptionsToTree()
    // Stream targets whose source param vanished stop here.
    this.targets = this.targets.filter((t) => this.local.resolve(t.localPath)?.meta.kind === ParamKind.Param)
    this.rebuildInbound()
    this.bumpAndRedeclare()
    this.emit('topology')
  }

  private bumpAndRedeclare(): void {
    this.declVersion++
    const self = this.world.find(this.identity.sku)
    if (self) self.declVersion = this.declVersion
    for (const p of this.peers) if (p.helloReceived && !p.closed) this.sendDeclareSelf(p)
  }

  /** Set a local value (the app producing data). No-op if unchanged. */
  setLocalValue(path: string, value: ParamValue): void {
    const node = this.local.resolve(path)
    if (!node || node.meta.kind !== ParamKind.Param) return
    if (node.value.tag === value.tag && sameValue(node.value, value)) return
    this.local.setValue(path, value)
  }

  getLocalValue(path: string): ParamValue | null {
    return this.local.resolve(path)?.value ?? null
  }

  // ── subscriptions (node.cpp subscribe / unsubscribe) ────────────

  subscribe(localPath: string, sourceSku: string, sourcePath: string): boolean {
    const node = this.local.resolve(localPath)
    if (!node || node.meta.kind !== ParamKind.Param) return false
    // Convention: only Destination / Bidir params subscribe.
    if (node.meta.flow !== FlowDir.Destination && node.meta.flow !== FlowDir.Bidir) return false
    const list = this.subs.get(localPath) ?? []
    if (!list.some((s) => s.sourceSku === sourceSku && s.sourcePath === sourcePath)) {
      if (list.length >= 4) return false // DATAFLOU_MAX_SUBS_PER_PARAM
      list.push({ sourceSku, sourcePath })
      this.subs.set(localPath, list)
    }
    node.subscriptions = list.map((s) => ({ ...s }))
    this.rebuildInbound()
    if (sourceSku === this.identity.sku) {
      if (
        this.local.resolve(sourcePath)?.meta.kind === ParamKind.Param &&
        !this.targets.some((t) => t.destSku === this.identity.sku && t.localPath === sourcePath && t.destPath === localPath)
      ) {
        this.targets.push({
          destSku: this.identity.sku,
          destAddress: '127.0.0.1',
          destUdpPort: this.listenPort + 1,
          localPath: sourcePath,
          destPath: localPath,
          rateHz: this.local.resolve(sourcePath)?.meta.rate ?? 0,
          lastSentMs: 0,
          lastSentEpoch: -1,
          lastRequestMs: 0,
          monitor: false
        })
      }
    } else {
      this.sendStreamRequest(sourceSku, sourcePath, localPath, node.meta.rate)
    }
    this.broadcastSubAnnounce(true, localPath, sourceSku, sourcePath)
    this.schedulePersist()
    this.emit('topology')
    return true
  }

  unsubscribe(localPath: string, sourceSku: string, sourcePath: string): boolean {
    const list = this.subs.get(localPath) ?? []
    const next = list.filter((s) => !(s.sourceSku === sourceSku && s.sourcePath === sourcePath))
    if (next.length === list.length) return false
    if (next.length) this.subs.set(localPath, next)
    else this.subs.delete(localPath)
    const node = this.local.resolve(localPath)
    if (node) node.subscriptions = next.map((s) => ({ ...s }))
    this.rebuildInbound()
    if (sourceSku !== this.identity.sku) this.sendStreamStop(sourceSku, sourcePath, localPath)
    else {
      this.targets = this.targets.filter(
        (t) => !(t.destSku === this.identity.sku && t.localPath === sourcePath && t.destPath === localPath)
      )
    }
    this.broadcastSubAnnounce(false, localPath, sourceSku, sourcePath)
    this.schedulePersist()
    this.emit('topology')
    return true
  }

  /** Bind dest ← src anywhere in the mesh (SUBREQ to the dest's owner). */
  subscribeRemote(destSku: string, destPath: string, sourceSku: string, sourcePath: string, sub = true): string | null {
    if (destSku === this.identity.sku) {
      const ok = sub ? this.subscribe(destPath, sourceSku, sourcePath) : this.unsubscribe(destPath, sourceSku, sourcePath)
      return ok ? null : 'Parameter not found or not a destination'
    }
    const peer = this.peerBySku(destSku)
    if (!peer) return 'Node not connected'
    this.send(peer, P.encodeSubRequest(++this.seq, this.identity.sku, sub, destSku, destPath, sourceSku, sourcePath))
    return null
  }

  setValueRemote(targetSku: string, path: string, value: ParamValue): string | null {
    if (targetSku === this.identity.sku) {
      if (!this.local.setValue(path, value)) return 'Parameter not found'
      this.emit('localValue', path, value, 'setval')
      return null
    }
    const peer = this.peerBySku(targetSku)
    if (!peer) return 'Node not connected'
    this.send(peer, P.encodeSetValue(++this.seq, this.identity.sku, targetSku, path, value))
    // Optimistic mirror so the UI reflects the edit immediately.
    const wn = this.world.find(targetSku)?.params.resolve(path)
    if (wn) wn.value = value
    return null
  }

  /** Remove a node from the world everywhere (the only way to forget one). */
  flushNode(sku: string): void {
    if (sku === this.identity.sku) return
    this.world.remove(sku)
    const payload = P.encodeFlush(++this.seq, this.identity.sku, sku)
    for (const p of this.peers) if (p.helloReceived && !p.closed) this.send(p, payload)
    this.log(`Flushed node: ${sku}`)
    this.emit('topology')
  }

  /** BLOB: store `data` under `key` on the target node (it persists it). */
  sendBlob(targetSku: string, key: string, data: Uint8Array): string | null {
    const peer = this.peerBySku(targetSku)
    if (!peer) return 'Node not connected'
    this.send(peer, P.encodeBlob(++this.seq, this.identity.sku, targetSku, key, data))
    return null
  }

  /** BLOBREQ: ask the target for a stored blob; it arrives as a 'blob' event. */
  requestBlob(targetSku: string, key: string): string | null {
    const peer = this.peerBySku(targetSku)
    if (!peer) return 'Node not connected'
    this.send(peer, P.encodeBlobReq(++this.seq, this.identity.sku, targetSku, key))
    return null
  }

  /** PADMIN: opaque admin payload, handed to the target's application. */
  sendParamAdmin(targetSku: string, payload: string): string | null {
    const peer = this.peerBySku(targetSku)
    if (!peer) return 'Node not connected'
    this.send(peer, P.encodeParamAdmin(++this.seq, this.identity.sku, targetSku, payload))
    return null
  }

  /** IDENTIFY: ask every visualizer on the mesh (and our own app, via 'identify') to highlight this node. */
  identify(): void {
    if (!this.running) return
    // Peers form a full mesh: a direct send reaches every node.
    const payload = P.encodeIdentify(++this.seq, this.identity.sku)
    for (const p of this.peers) if (p.helloReceived && !p.closed) this.send(p, payload)
    this.emit('identify', this.identity.sku)
  }

  /**
   * Visualizer monitoring (node.cpp set_monitoring): while on, every param of
   * every connected node streams into `world` at 10 Hz, on change — a
   * STREAMREQ with an empty dest_path, lowest priority at the source. Turn it
   * on while a UI shows remote values; off sends STREAMSTOP for all of them.
   */
  setMonitoring(on: boolean): void {
    if (on === this.monitorOn) return
    this.monitorOn = on
    if (on) this.lastMonitorKeepalive = 0
    else this.stopMonitors()
    this.log(`Monitoring remote values: ${on ? 'on' : 'off'}`)
  }

  get monitoring(): boolean {
    return this.monitorOn
  }

  get monitorCount(): number {
    return this.monitors.length
  }

  // ── peers / TCP ──────────────────────────────────────────────────

  private peerBySku(sku: string): Peer | null {
    return this.peers.find((p) => p.sku === sku && !p.closed) ?? null
  }

  private onPeerFound(ev: MdnsPeer): void {
    if (!this.running || !ev.sku || !ev.port) return
    if (ev.universe !== this.universe) return
    if (ev.sku === this.identity.sku) return
    const existing = this.peerBySku(ev.sku)
    if (existing) {
      if (existing.port === ev.port && (existing.address === ev.address || existing.helloReceived)) return
      if (existing.port !== ev.port) {
        this.log(`Peer ${ev.sku} port changed (${existing.port} -> ${ev.port}), reconnecting`)
        const entry = this.world.find(ev.sku)
        if (entry && !entry.isLocal) entry.declVersion = 0
        this.disconnect(existing, false)
      } else return
    }
    // Lower SKU dials; the higher one waits (deterministic dedup).
    if (this.identity.sku > ev.sku) {
      if (!this.pending.has(ev.sku)) this.log(`Peer found (waiting for inbound): ${ev.sku} at ${ev.address}:${ev.port}`)
      const prev = this.pending.get(ev.sku)
      this.pending.set(ev.sku, { address: ev.address, port: ev.port, since: prev?.since ?? Date.now() })
      return
    }
    this.connect(ev.sku, ev.address, ev.port)
  }

  private connect(sku: string, address: string, port: number): void {
    if (this.peerBySku(sku)) return
    this.log(`Peer found (connecting): ${sku} at ${address}:${port}`)
    const socket = net.connect({ host: address, port })
    socket.setNoDelay(true)
    socket.setTimeout(CONNECT_TIMEOUT_MS, () => {
      if (!peer.helloSent) socket.destroy(new Error('connect timeout'))
    })
    const peer: Peer = { socket, sku, address, port, helloSent: false, helloReceived: false, lastMsgMs: 0, recv: Buffer.alloc(0), closed: false }
    this.peers.push(peer)
    socket.on('connect', () => {
      socket.setTimeout(0)
      this.sendHello(peer)
    })
    this.wireSocket(peer)
  }

  private onInbound(socket: net.Socket): void {
    socket.setNoDelay(true)
    const peer: Peer = {
      socket,
      sku: '',
      address: normIp(socket.remoteAddress ?? ''),
      port: 0,
      helloSent: false,
      helloReceived: false,
      lastMsgMs: 0,
      recv: Buffer.alloc(0),
      closed: false
    }
    this.peers.push(peer)
    this.log('Accepted inbound connection')
    this.wireSocket(peer)
  }

  private wireSocket(peer: Peer): void {
    peer.socket.on('data', (chunk) => {
      peer.lastMsgMs = Date.now()
      peer.recv = peer.recv.length ? Buffer.concat([peer.recv, chunk]) : chunk
      while (peer.recv.length >= 4) {
        const len = peer.recv.readUInt32BE(0)
        if (len > MAX_RECV_FRAME) {
          this.log(`Corrupt frame from ${peer.sku} (len ${len})`)
          this.disconnect(peer, true)
          return
        }
        if (peer.recv.length < 4 + len) break
        const payload = peer.recv.subarray(4, 4 + len)
        peer.recv = peer.recv.subarray(4 + len)
        try {
          this.handleMessage(peer, payload)
        } catch (e) {
          this.log(`Message error from ${peer.sku}: ${(e as Error).message}`)
        }
        if (peer.closed) return
      }
    })
    peer.socket.on('error', (e) => this.log(`Peer ${peer.sku || peer.address} socket error: ${e.message}`))
    peer.socket.on('close', () => {
      if (peer.closed) return
      this.log(`Peer disconnected: ${peer.sku}`)
      this.disconnect(peer, true)
    })
  }

  private disconnect(peer: Peer, markOffline: boolean): void {
    if (peer.closed) return
    peer.closed = true
    try {
      peer.socket.destroy()
    } catch {
      /* gone */
    }
    this.peers = this.peers.filter((p) => p !== peer)
    if (peer.sku) {
      this.targets = this.targets.filter((t) => t.destSku !== peer.sku)
      const stillConnected = this.peers.some((p) => p.sku === peer.sku && p.helloReceived)
      if (markOffline && !stillConnected) {
        const entry = this.world.find(peer.sku)
        if (entry?.online) {
          this.world.markOffline(peer.sku)
          this.emit('peerLeft', entry.identity)
        }
        this.emit('topology')
      }
    }
  }

  private send(peer: Peer, payload: Buffer): void {
    if (peer.closed) return
    try {
      peer.socket.write(P.frame(payload))
    } catch (e) {
      this.log(`send to ${peer.sku} failed: ${(e as Error).message}`)
    }
  }

  private sendHello(peer: Peer): void {
    this.send(peer, P.encodeHello(++this.seq, this.identity.sku, this.identity, this.world.versionVector(), this.listenPort))
    peer.helloSent = true
  }

  private sendDeclareSelf(peer: Peer): void {
    this.send(peer, P.encodeDeclare(++this.seq, this.identity.sku, this.identity.sku, this.declVersion, this.identity, this.local))
  }

  private sendDeclareAbout(peer: Peer, sku: string): void {
    const e = this.world.find(sku)
    if (!e) return
    if (e.isLocal) return this.sendDeclareSelf(peer)
    this.send(peer, P.encodeDeclare(++this.seq, this.identity.sku, sku, e.declVersion, e.identity, e.params))
  }

  private sendMissingDeclares(peer: Peer, theirs: Map<string, number>): void {
    for (const [sku, ours] of this.world.versionVector()) {
      const t = theirs.get(sku)
      if (t === undefined || t < ours) this.sendDeclareAbout(peer, sku)
    }
  }

  // ── message handling (node.cpp handle_message) ──────────────────

  private handleMessage(peer: Peer, payload: Buffer): void {
    const m = P.decodeMsg(payload)
    if (!m) return
    const now = Date.now()
    switch (m.msg) {
      case 'HELLO': {
        // A second live connection to the same node (dial race) is kept, as
        // the C++ node does: closing either socket makes the C++ side mark
        // us offline even though the other connection is still up.
        peer.sku = m.from
        peer.helloReceived = true
        peer.address = normIp(peer.socket.remoteAddress ?? peer.address)
        if (m.listenPort) peer.port = m.listenPort
        this.pending.delete(m.from)
        const entry = this.world.upsert(m.from)
        if (!entry.isLocal) entry.declVersion = 0 // accept the fresh DECLARE after a reboot
        entry.identity = { ...m.identity, sku: m.from }
        entry.online = true
        entry.lastSeenMs = now
        if (!entry.firstSeenMs) entry.firstSeenMs = now
        this.log(`HELLO from ${m.identity.label} (${m.from})`)
        if (!peer.helloSent) this.sendHello(peer)
        this.sendMissingDeclares(peer, m.versions)
        this.sendDeclareSelf(peer)
        this.resendStreamRequests(m.from)
        this.emit('peerJoined', entry.identity)
        this.emit('topology')
        return
      }
      case 'DECLARE': {
        if (m.about === this.identity.sku) return // TS: never overwrite our own tree from a relay
        const entry = this.world.upsert(m.about)
        if (m.declVersion > entry.declVersion) {
          entry.identity = { ...m.identity, sku: m.about }
          entry.declVersion = m.declVersion
          const prev = entry.params
          P.applyDeclared(entry.params, m.params)
          // TS: keep last-known values for unchanged params (UI continuity).
          prev.walk((p, n) => {
            const nn = entry.params.resolve(p)
            if (nn && nn !== n && nn.meta.type === n.meta.type) nn.value = n.value
          })
          if (m.about === m.from) entry.online = true
          entry.lastSeenMs = now
          if (!entry.firstSeenMs) entry.firstSeenMs = now
          this.log(`Received DECLARE about ${m.about} (v${m.declVersion}) from ${m.from}`)
          this.emit('topology')
        }
        return
      }
      case 'ACK':
        return
      case 'IDENTIFY':
        this.log(`IDENTIFY from ${m.from}`)
        this.emit('identify', m.from)
        return
      case 'LEAVE': {
        this.log(`LEAVE from ${m.from}`)
        const entry = this.world.find(m.from)
        this.world.markOffline(m.from)
        if (entry) this.emit('peerLeft', entry.identity)
        this.emit('topology')
        return
      }
      case 'DIGEST':
        this.sendMissingDeclares(peer, m.versions)
        return
      case 'FLUSH':
        if (m.target === this.identity.sku) return
        this.log(`FLUSH for ${m.target} from ${m.from}`)
        this.world.remove(m.target)
        this.emit('topology')
        return
      case 'SUBREQ':
        if (m.destSku !== this.identity.sku) return
        if (m.sub) this.subscribe(m.destPath, m.srcSku, m.srcPath)
        else this.unsubscribe(m.destPath, m.srcSku, m.srcPath)
        return
      case 'SETVAL':
        if (m.target !== this.identity.sku) return
        if (this.local.setValue(m.path, m.value)) this.emit('localValue', m.path, m.value, 'setval' satisfies ValueOrigin)
        return
      case 'PADMIN':
        if (m.target === this.identity.sku) this.emit('paramAdmin', m.payload)
        return
      case 'BLOB':
        if (m.target !== this.identity.sku) return
        this.writeBlob(m.key, m.data)
        this.emit('blob', m.key, m.data)
        return
      case 'BLOBREQ': {
        if (m.target !== this.identity.sku) return
        const data = this.readBlob(m.key)
        if (data) this.send(peer, P.encodeBlob(++this.seq, this.identity.sku, m.from, m.key, data))
        return
      }
      case 'STREAMREQ': {
        // An empty dest_path is a visualizer monitor: best effort, lowest
        // priority, re-requested every keepalive — not logged.
        const monitor = m.destPath === ''
        const node = this.local.resolve(m.sourcePath)
        if (!node || node.meta.kind !== ParamKind.Param) {
          if (!monitor) this.log(`StreamRequest: source param '${m.sourcePath}' not found`)
          return
        }
        const rate =
          m.rateHz > 0 && node.meta.rate > 0 ? Math.min(m.rateHz, node.meta.rate) : Math.max(m.rateHz, node.meta.rate)
        const t = this.targets.find((x) => x.destSku === m.destSku && x.localPath === m.sourcePath && x.destPath === m.destPath)
        if (t) {
          t.destAddress = peer.address
          t.destUdpPort = m.destUdpPort
          t.rateHz = rate
          t.lastRequestMs = now
        } else {
          if (monitor) {
            if (this.targets.filter((x) => x.monitor).length >= MAX_MONITOR_TARGETS) return // best effort
          } else if (this.targets.length >= MAX_STREAM_TARGETS) {
            // Real subscriptions take priority over visualizer monitors.
            const i = this.targets.findIndex((x) => x.monitor)
            if (i >= 0) this.targets.splice(i, 1)
          }
          if (this.targets.length >= MAX_STREAM_TARGETS) return
          this.targets.push({
            destSku: m.destSku,
            destAddress: peer.address,
            destUdpPort: m.destUdpPort,
            localPath: m.sourcePath,
            destPath: m.destPath,
            rateHz: rate,
            lastSentMs: 0,
            lastSentEpoch: -1,
            lastRequestMs: now,
            monitor
          })
          if (!monitor) {
            this.log(`StreamTarget added: ${m.sourcePath} -> ${peer.address}:${m.destUdpPort} (rate=${rate.toFixed(1)})`)
            this.emit('topology')
          }
        }
        return
      }
      case 'STREAMSTOP':
        this.targets = this.targets.filter(
          (t) => !(t.destSku === m.destSku && t.localPath === m.sourcePath && t.destPath === m.destPath)
        )
        this.emit('topology')
        return
      case 'SUBANNOUNCE': {
        const wn = this.world.find(m.destSku)?.params.resolve(m.destPath)
        if (wn && m.destSku !== this.identity.sku) {
          if (m.sub) {
            if (!wn.subscriptions.some((s) => s.sourceSku === m.sourceSku && s.sourcePath === m.sourcePath)) {
              wn.subscriptions.push({ sourceSku: m.sourceSku, sourcePath: m.sourcePath })
            }
          } else {
            wn.subscriptions = wn.subscriptions.filter((s) => !(s.sourceSku === m.sourceSku && s.sourcePath === m.sourcePath))
          }
        }
        this.emit('topology')
        return
      }
    }
  }

  // ── streaming ────────────────────────────────────────────────────

  private sendStreamRequest(sourceSku: string, sourcePath: string, localPath: string, rateHz: number): void {
    const peer = this.peerBySku(sourceSku)
    if (!peer || !peer.helloReceived) return // resent on (re)connect
    this.send(peer, P.encodeStreamRequest(++this.seq, this.identity.sku, sourcePath, localPath, this.identity.sku, this.listenPort + 1, rateHz))
  }

  private sendStreamStop(sourceSku: string, sourcePath: string, localPath: string): void {
    const peer = this.peerBySku(sourceSku)
    if (!peer) return
    this.send(peer, P.encodeStreamStop(++this.seq, this.identity.sku, sourcePath, localPath, this.identity.sku))
  }

  private broadcastSubAnnounce(sub: boolean, destPath: string, sourceSku: string, sourcePath: string): void {
    const payload = P.encodeSubAnnounce(++this.seq, this.identity.sku, sub, this.identity.sku, destPath, sourceSku, sourcePath)
    for (const p of this.peers) if (p.helloReceived && !p.closed) this.send(p, payload)
  }

  private resendStreamRequests(peerSku: string): void {
    for (const ie of this.inbound) {
      if (ie.sourceSku !== peerSku) continue
      this.sendStreamRequest(peerSku, ie.sourcePath, ie.localPath, this.local.resolve(ie.localPath)?.meta.rate ?? 0)
    }
  }

  private rebuildInbound(): void {
    this.inbound = []
    for (const [localPath, list] of this.subs) {
      const node = this.local.resolve(localPath)
      if (!node || node.meta.kind !== ParamKind.Param) continue
      for (const s of list) {
        this.inbound.push({ sourceSkuHash: crc32Sku(s.sourceSku), sourceSku: s.sourceSku, sourcePath: s.sourcePath, localPath })
      }
    }
  }

  private applySubscriptionsToTree(): void {
    this.local.walk((p, n) => {
      n.subscriptions = (this.subs.get(p) ?? []).map((s) => ({ ...s }))
    })
  }

  private pollStream(): void {
    if (!this.udp) return
    const now = Date.now()
    for (const t of this.targets) {
      const node = this.local.resolve(t.localPath)
      if (!node || node.meta.kind !== ParamKind.Param) continue
      if (node.changeEpoch === 0 && t.lastSentEpoch === -1 && node.timestampMs === 0) {
        // Never written: nothing meaningful to stream yet.
        continue
      }
      const changed = node.changeEpoch !== t.lastSentEpoch
      if (!changed && now - t.lastSentMs < STREAM_REFRESH_MS) continue
      if (t.rateHz > 0 && now - t.lastSentMs < 1000 / t.rateHz) continue
      t.lastSentMs = now
      t.lastSentEpoch = node.changeEpoch
      if (t.destSku === this.identity.sku) {
        this.deliver(this.identity.sku, t.localPath, node.value, now, t.destPath)
        continue
      }
      const pkt = encodeStreamPacket(this.skuHash, now & 0xffffffff, [{ path: t.localPath, value: node.value }])
      if (!pkt || !t.destAddress) continue
      this.udp.send(pkt, t.destUdpPort, t.destAddress)
      if (t.monitor) continue
      const wn = this.world.find(t.destSku)?.params.resolve(t.destPath)
      if (wn) wn.value = node.value
    }
  }

  private onUdp(buf: Buffer): void {
    if (!this.inbound.length && !this.monitors.length) return
    const pkt = decodeStreamPacket(buf)
    if (!pkt) return
    const now = Date.now()
    for (const e of pkt.entries) {
      // Visualizer monitor: the raw value goes to the world view only.
      const mon = this.monitors.length ? this.monitors.find((x) => x.skuHash === pkt.skuHash && x.path === e.path) : undefined
      if (mon) {
        const wn = this.world.find(mon.sku)?.params.resolve(mon.path)
        if (wn) wn.value = e.value
      }
      for (const ie of this.inbound) {
        if (ie.sourceSkuHash !== pkt.skuHash || ie.sourcePath !== e.path) continue
        this.deliver(ie.sourceSku, e.path, e.value, now, ie.localPath)
      }
    }
  }

  // Apply a value arriving from `sourceSku/sourcePath` to every local
  // destination subscribed to it (or to `onlyLocal`), with range mapping.
  private deliver(sourceSku: string, sourcePath: string, value: ParamValue, now: number, onlyLocal?: string): void {
    const srcNode =
      sourceSku === this.identity.sku ? this.local.resolve(sourcePath) : this.world.find(sourceSku)?.params.resolve(sourcePath)
    if (srcNode && sourceSku !== this.identity.sku) srcNode.value = value // mirror raw source value
    for (const ie of this.inbound) {
      if (ie.sourceSku !== sourceSku || ie.sourcePath !== sourcePath) continue
      if (onlyLocal && ie.localPath !== onlyLocal) continue
      const dst = this.local.resolve(ie.localPath)
      if (!dst) continue
      const mapped = srcNode ? normalizeValue(value, srcNode.meta, dst.meta) : value
      this.local.setValue(ie.localPath, mapped, now)
      this.emit('localValue', ie.localPath, mapped, 'stream' satisfies ValueOrigin)
    }
  }

  // ── visualizer monitors (requester side, node.cpp poll_monitors) ──

  private stopMonitors(): void {
    for (const m of this.monitors) this.sendStreamStop(m.sku, m.path, '')
    this.monitors = []
  }

  /** Every param of every connected node, minus those a local subscription already streams. */
  private pollMonitors(now: number): void {
    if (!this.monitorOn) return
    const keepalive = now - this.lastMonitorKeepalive >= KEEPALIVE_INTERVAL_MS
    const wanted: MonitorEntry[] = []
    for (const e of this.world.nodes) {
      if (e.isLocal || !e.online) continue
      const sku = e.identity.sku
      const peer = this.peerBySku(sku)
      if (!peer || !peer.helloReceived || peer.closed) continue
      const skuHash = crc32Sku(sku)
      e.params.walk((path, n) => {
        if (n.meta.kind !== ParamKind.Param || wanted.length >= MAX_MONITORS) return
        if (this.inbound.some((ie) => ie.sourceSku === sku && ie.sourcePath === path)) return
        wanted.push({ sku, skuHash, path })
      })
    }
    const key = (m: MonitorEntry): string => `${m.sku}\n${m.path}`
    const had = new Set(this.monitors.map(key))
    const want = new Set(wanted.map(key))
    for (const m of this.monitors) if (!want.has(key(m))) this.sendStreamStop(m.sku, m.path, '')
    for (const m of wanted) if (keepalive || !had.has(key(m))) this.sendStreamRequest(m.sku, m.path, '', MONITOR_RATE_HZ)
    this.monitors = wanted
    if (keepalive) this.lastMonitorKeepalive = now
  }

  // ── timers ───────────────────────────────────────────────────────

  private housekeeping(): void {
    const now = Date.now()
    for (const p of [...this.peers]) {
      if (p.helloReceived && p.lastMsgMs > 0 && now - p.lastMsgMs > PEER_TIMEOUT_MS) {
        this.log(`Peer timeout: ${p.sku}`)
        this.disconnect(p, true)
      }
    }
    if (now - this.lastDigest >= DIGEST_INTERVAL_MS) {
      this.lastDigest = now
      const vv = this.world.versionVector()
      for (const p of this.peers) if (p.helloReceived && !p.closed) this.send(p, P.encodeDigest(++this.seq, this.identity.sku, vv))
    }
    if (this.inbound.length && now - this.lastKeepalive >= KEEPALIVE_INTERVAL_MS) {
      this.lastKeepalive = now
      for (const ie of this.inbound) {
        if (ie.sourceSku === this.identity.sku) continue
        this.sendStreamRequest(ie.sourceSku, ie.sourcePath, ie.localPath, this.local.resolve(ie.localPath)?.meta.rate ?? 0)
      }
    }
    const expired = this.targets.filter((t) => t.lastRequestMs !== 0 && now - t.lastRequestMs > KEEPALIVE_TIMEOUT_MS)
    if (expired.length) {
      this.targets = this.targets.filter((t) => !expired.includes(t))
      if (expired.some((t) => !t.monitor)) {
        this.log('StreamTarget expired (keepalive timeout)')
        this.emit('topology')
      }
    }
    this.pollMonitors(now)
    for (const [sku, pp] of this.pending) {
      if (this.peerBySku(sku)) {
        this.pending.delete(sku)
        continue
      }
      if (now - pp.since > PENDING_FALLBACK_MS) {
        this.pending.delete(sku)
        this.connect(sku, pp.address, pp.port)
      }
    }
  }

  // ── persistence: <base>/<universe>/<sku>/ ────────────────────────

  private nodeDir(): string {
    return path.join(this.storageBase, this.universe, this.identity.sku)
  }

  private loadSubscriptions(): void {
    this.subs.clear()
    try {
      const raw = JSON.parse(fs.readFileSync(path.join(this.nodeDir(), 'subscriptions.json'), 'utf8')) as unknown
      if (Array.isArray(raw)) {
        for (const r of raw) {
          const o = r as Record<string, unknown>
          if (typeof o.localPath !== 'string' || typeof o.sourceSku !== 'string' || typeof o.sourcePath !== 'string') continue
          const list = this.subs.get(o.localPath) ?? []
          list.push({ sourceSku: o.sourceSku, sourcePath: o.sourcePath })
          this.subs.set(o.localPath, list)
        }
      }
    } catch {
      /* none yet */
    }
  }

  private schedulePersist(): void {
    if (this.persistTimer) return
    this.persistTimer = setTimeout(() => this.flushPersist(), PERSIST_DEBOUNCE_MS)
  }

  private flushPersist(): void {
    if (this.persistTimer) clearTimeout(this.persistTimer)
    this.persistTimer = null
    const rows: { localPath: string; sourceSku: string; sourcePath: string }[] = []
    for (const [localPath, list] of this.subs) for (const s of list) rows.push({ localPath, ...s })
    try {
      fs.mkdirSync(this.nodeDir(), { recursive: true })
      fs.writeFileSync(path.join(this.nodeDir(), 'subscriptions.json'), JSON.stringify(rows, null, 1))
    } catch (e) {
      this.log(`persist failed: ${(e as Error).message}`)
    }
  }

  private blobPath(key: string): string {
    return path.join(this.nodeDir(), 'blobs', key.replace(/[^a-zA-Z0-9._-]/g, '_'))
  }

  private writeBlob(key: string, data: Uint8Array): void {
    try {
      fs.mkdirSync(path.dirname(this.blobPath(key)), { recursive: true })
      fs.writeFileSync(this.blobPath(key), data)
    } catch (e) {
      this.log(`blob write failed: ${(e as Error).message}`)
    }
  }

  private readBlob(key: string): Uint8Array | null {
    try {
      return fs.readFileSync(this.blobPath(key))
    } catch {
      return null
    }
  }

  // ── introspection ────────────────────────────────────────────────

  stats(): { peers: { sku: string; address: string; port: number; connected: boolean }[]; streamTargets: number; inbound: number } {
    return {
      peers: this.peers.map((p) => ({ sku: p.sku, address: p.address, port: p.port, connected: p.helloReceived })),
      streamTargets: this.targets.length,
      inbound: this.inbound.length
    }
  }

  subscriptionsOf(localPath: string): ParamSubscription[] {
    return (this.subs.get(localPath) ?? []).map((s) => ({ ...s }))
  }

  streamTargetsList(): { localPath: string; destSku: string; destPath: string; rateHz: number }[] {
    return this.targets.map((t) => ({ localPath: t.localPath, destSku: t.destSku, destPath: t.destPath, rateHz: t.rateHz }))
  }

  private log(msg: string): void {
    const line = `${new Date().toISOString().slice(11, 23)} ${msg}`
    this.logLines.push(line)
    if (this.logLines.length > 300) this.logLines.splice(0, this.logLines.length - 300)
    this.emit('log', msg)
  }
}

export function normIp(ip: string): string {
  return ip.startsWith('::ffff:') ? ip.slice(7) : ip
}

export type { ParamNode }
