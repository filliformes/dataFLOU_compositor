// dataflou discovery over mDNS / DNS-SD — interoperates with the library's
// desktop PAL (src/pal/desktop/mdns_mjansson.cpp) and the ESP32/Teensy PALs.
//
// Service: <label>-<sku8>._dataflou._tcp.local.  SRV port = TCP listen port
//   TXT: sku=<uuid> ver=<n> core_ver=<v> univ=<universe> started=<unix>
//
// What peers depend on:
//  - Exactly ONE A record per answer, and every peer must always see the SAME
//    one. The ESP32 W5500 PAL drops answers without an A record; the core
//    (node.cpp handle_peer_found, shared by every PAL) reconnects whenever a
//    later answer shows a different address.
//  - The OS's multicast routing can't be trusted: on Windows a route lookup
//    for 224.0.0.251 can resolve to loopback, so an unpinned multicast send
//    may never leave the machine. Every multicast send here is pinned to an
//    interface (setMulticastInterface).
//  - The W5500 PAL listens on a plain UDP socket: it only hears answers sent
//    straight to it.
// So:
//  - A "primary" IP (default route, else the mDNS route, never 127.x or
//    link-local, else the first real interface). Announcements go out on
//    loopback + the primary interface only, both carrying the primary IP —
//    local peers and peers on the primary LAN see one address.
//  - Remote queriers are always answered by unicast, with our IP on THEIR
//    subnet (a multi-homed show laptop: venue Wi-Fi + wired sensor LAN).
//    Peers on a secondary LAN never get our multicast, so they too only
//    ever see one address.
//  - Browse queries go out on every interface from ephemeral sockets, so
//    responders answer by unicast. Windows delivers one multicast query
//    twice (loopback + LAN membership); we answer once.
//  - Peers on this machine are dialled at the primary IP, never 127.0.0.1:
//    the C++ core records an inbound peer's TCP source address (HELLO) and
//    compares every later mDNS answer against it, so the source of our
//    connection must equal the A record we advertise.
//  - One service per packet: PTR, then SRV, TXT, A (the C++ parser attaches
//    SRV/TXT to the LAST PTR it has seen).

import { EventEmitter } from 'events'
import * as dgram from 'dgram'
import * as os from 'os'
import * as dnsPacket from 'dns-packet'
import makeMdns from 'multicast-dns'

const SERVICE = '_dataflou._tcp.local'
const META_QUERY = '_services._dns-sd._udp.local'
const MDNS_ADDR = '224.0.0.251'
const MDNS_PORT = 5353
const REQUERY_MS = 15000
const NET_REFRESH_MS = 10000
const TTL = 120
// Interface names that are almost never the show network.
const VIRTUAL_IF = /vethernet|virtualbox|vbox|vmware|hyper-v|wsl|docker|bridge100|utun|tailscale|zerotier|loopback/i

export interface MdnsPeer {
  name: string // instance name
  address: string
  port: number
  sku: string
  universe: string
  txt: Record<string, string>
}

type AnyRecord = { name: string; type: string; data: unknown; ttl?: number }
type Packet = {
  type: string
  id?: number
  questions?: { name: string; type: string }[]
  answers?: AnyRecord[]
  additionals?: AnyRecord[]
}

interface LocalIf {
  name: string
  address: string
  netmask: string
}

function localIfs(): LocalIf[] {
  const out: LocalIf[] = []
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    for (const a of list ?? []) {
      if (a.family === 'IPv4' && !a.internal) out.push({ name, address: a.address, netmask: a.netmask })
    }
  }
  return out
}

export function localAddresses(): Set<string> {
  const out = new Set<string>(['127.0.0.1'])
  for (const i of localIfs()) out.add(i.address)
  return out
}

function normIp(ip: string): string {
  return ip.startsWith('::ffff:') ? ip.slice(7) : ip
}

function isLocalAddress(ip: string): boolean {
  const a = normIp(ip)
  return a.startsWith('127.') || localAddresses().has(a)
}

const ip4 = (s: string): number =>
  s.split('.').reduce((acc, o) => (acc * 256 + (parseInt(o, 10) & 255)) >>> 0, 0)

/** Our address on the querier's subnet, if we have one. */
function ifFor(querier: string): string | null {
  const q = ip4(querier)
  for (const i of localIfs()) {
    const m = ip4(i.netmask)
    if (((ip4(i.address) & m) >>> 0) === ((q & m) >>> 0)) return i.address
  }
  return null
}

const usable = (ip: string | null): ip is string =>
  !!ip && ip !== '0.0.0.0' && !ip.startsWith('127.') && !ip.startsWith('169.254.')

/** Source IP the OS would use towards `host` (UDP connect = route lookup, sends nothing). */
function routeSource(host: string, port: number): Promise<string | null> {
  return new Promise((resolve) => {
    const s = dgram.createSocket('udp4')
    const done = (ip: string | null): void => {
      try {
        s.close()
      } catch {
        /* closed */
      }
      resolve(ip)
    }
    s.on('error', () => done(null))
    try {
      s.connect(port, host, (err?: Error) => done(err ? null : s.address().address))
    } catch {
      done(null)
    }
  })
}

/** The address we advertise: default route, else mDNS route, else the first real interface. */
async function primaryAddress(): Promise<string> {
  const mine = localIfs()
  const ok = (ip: string | null): ip is string => usable(ip) && mine.some((i) => i.address === ip)
  const viaDefault = await routeSource('8.8.8.8', 53)
  if (ok(viaDefault)) return viaDefault
  const viaMdns = await routeSource(MDNS_ADDR, MDNS_PORT)
  if (ok(viaMdns)) return viaMdns
  const real = mine.filter((i) => usable(i.address) && !VIRTUAL_IF.test(i.name))
  return (real[0] ?? mine.find((i) => usable(i.address)))?.address ?? '127.0.0.1'
}

const lc = (s: string): string => s.toLowerCase().replace(/\.$/, '')

export class DataflouMdns extends EventEmitter {
  private mdns: ReturnType<typeof makeMdns> | null = null
  // Multicast senders pinned to an interface (loopback + primary), and
  // browse senders (every interface), keyed by local IP.
  private announceSocks = new Map<string, dgram.Socket>()
  private querySocks = new Map<string, dgram.Socket>()
  private instance = ''
  private hostname = ''
  private port = 0
  private txt: string[] = []
  private primaryIp = ''
  private netKey = ''
  private timers: ReturnType<typeof setInterval>[] = []
  private recentQueries = new Map<string, number>()

  start(instance: string, hostTag: string, port: number, txt: string[]): void {
    this.stop()
    this.instance = `${instance}.${SERVICE}`
    this.hostname = `dataflou-${hostTag}.local`
    this.port = port
    this.txt = txt
    // Receiver for multicast queries/announcements (joins every interface);
    // also sends our unicast answers (source port 5353).
    const mdns = makeMdns({ reuseAddr: true, loopback: true })
    this.mdns = mdns
    mdns.on('error', (e: Error) => this.emit('log', `mDNS error: ${e.message}`))
    mdns.on('warning', () => {
      /* per-interface membership noise */
    })
    mdns.on('query', (q, rinfo) => this.onQuery(q as never, rinfo))
    mdns.on('response', (r, rinfo) => this.onResponse(r as never, rinfo))
    mdns.on('ready', () => void this.refreshNet(true))
    this.timers.push(setInterval(() => this.browse(), REQUERY_MS))
    this.timers.push(setInterval(() => void this.refreshNet(false), NET_REFRESH_MS))
  }

  stop(): void {
    for (const t of this.timers) clearInterval(t)
    this.timers = []
    const m = this.mdns
    this.mdns = null
    // Goodbye (TTL 0) — the C++ side treats it as a hint only.
    if (this.primaryIp) this.multicast({ type: 'response', answers: [{ name: SERVICE, type: 'PTR', ttl: 0, data: this.instance }] })
    // Let the goodbye leave before the sockets close.
    const socks = [...this.announceSocks.values(), ...this.querySocks.values()]
    this.announceSocks.clear()
    this.querySocks.clear()
    this.primaryIp = ''
    this.netKey = ''
    setTimeout(() => {
      for (const s of socks) {
        try {
          s.close()
        } catch {
          /* closed */
        }
      }
      m?.destroy()
    }, 50)
  }

  // ── sockets ──────────────────────────────────────────────────────

  /** Re-resolve interfaces + primary IP; rebuild sockets and re-announce on change. */
  private async refreshNet(force: boolean): Promise<void> {
    const primary = await primaryAddress()
    if (!this.mdns) return
    const ifs = localIfs().map((i) => i.address)
    const key = `${primary}|${ifs.sort().join(',')}`
    if (key === this.netKey && !force) return
    if (this.primaryIp && primary !== this.primaryIp) this.emit('log', `mDNS address ${this.primaryIp} -> ${primary}`)
    this.netKey = key
    this.primaryIp = primary
    const announceOn = new Set(['127.0.0.1', ...(primary !== '127.0.0.1' ? [primary] : [])])
    const queryOn = new Set(['127.0.0.1', ...ifs])
    await Promise.all([
      this.syncSockets(this.announceSocks, announceOn, true),
      this.syncSockets(this.querySocks, queryOn, false)
    ])
    if (!this.mdns) return
    this.announce()
    this.browse()
  }

  private async syncSockets(map: Map<string, dgram.Socket>, want: Set<string>, announce: boolean): Promise<void> {
    for (const [ip, s] of map) {
      if (want.has(ip)) continue
      map.delete(ip)
      try {
        s.close()
      } catch {
        /* closed */
      }
    }
    const opens: Promise<void>[] = []
    for (const ip of want) if (!map.has(ip)) opens.push(this.openPinned(ip, announce).then((s) => void (s && map.set(ip, s))))
    await Promise.all(opens)
  }

  /**
   * A UDP socket whose multicast leaves through `ip`. Announcers bind port
   * 5353 when they can (strict receivers ignore responses from other ports);
   * browse sockets bind an ephemeral port so answers come back by unicast.
   * Anything arriving on them is handled like traffic on the main socket.
   */
  private openPinned(ip: string, announce: boolean): Promise<dgram.Socket | null> {
    const tryBind = (port: number): Promise<dgram.Socket | null> =>
      new Promise((resolve) => {
        const s = dgram.createSocket({ type: 'udp4', reuseAddr: true })
        let bound = false
        s.on('error', (e) => {
          if (!bound) {
            try {
              s.close()
            } catch {
              /* closed */
            }
            resolve(null)
          } else this.emit('log', `mDNS socket ${ip}: ${e.message}`)
        })
        s.on('message', (buf, rinfo) => this.onPacket(buf, rinfo))
        s.bind(port, ip, () => {
          bound = true
          try {
            s.setMulticastInterface(ip)
            s.setMulticastTTL(255)
          } catch {
            /* best effort */
          }
          resolve(s)
        })
      })
    return announce ? tryBind(MDNS_PORT).then((s) => s ?? tryBind(0)) : tryBind(0)
  }

  private onPacket(buf: Buffer, rinfo: dgram.RemoteInfo): void {
    try {
      const p = dnsPacket.decode(buf) as unknown as Packet
      if (p.type === 'response') this.onResponse(p, rinfo)
      else if (p.type === 'query') this.onQuery(p, rinfo)
    } catch {
      /* not DNS */
    }
  }

  private multicast(p: Packet): void {
    const buf = dnsPacket.encode(p as never)
    for (const s of this.announceSocks.values()) s.send(buf, MDNS_PORT, MDNS_ADDR, () => undefined)
  }

  /** PTR query for _dataflou._tcp out of every interface (answers come back unicast). */
  browse(): void {
    const buf = dnsPacket.encode({
      type: 'query',
      id: 0,
      flags: 0,
      questions: [{ name: SERVICE, type: 'PTR', class: 'IN' }]
    } as never)
    for (const s of this.querySocks.values()) s.send(buf, MDNS_PORT, MDNS_ADDR, () => undefined)
  }

  // ── answering ────────────────────────────────────────────────────

  private records(ip: string): { answers: AnyRecord[]; additionals: AnyRecord[] } {
    return {
      answers: [{ name: SERVICE, type: 'PTR', ttl: TTL, data: this.instance }],
      additionals: [
        { name: this.instance, type: 'SRV', ttl: TTL, data: { port: this.port, target: this.hostname, priority: 0, weight: 0 } },
        { name: this.instance, type: 'TXT', ttl: TTL, data: this.txt.map((t) => Buffer.from(t, 'utf8')) },
        { name: this.hostname, type: 'A', ttl: TTL, data: ip }
      ]
    }
  }

  private announce(): void {
    if (this.primaryIp) this.multicast({ type: 'response', ...this.records(this.primaryIp) })
  }

  private onQuery(q: Packet, rinfo: { address: string; port: number }): void {
    if (!this.mdns || !this.instance || !this.primaryIp) return
    const qs = q.questions ?? []
    let wanted = false
    let meta = false
    for (const x of qs) {
      const n = lc(x.name)
      if ((x.type === 'PTR' || x.type === 'ANY') && n === SERVICE) wanted = true
      if ((x.type === 'SRV' || x.type === 'TXT' || x.type === 'ANY') && n === lc(this.instance)) wanted = true
      if ((x.type === 'A' || x.type === 'ANY') && n === lc(this.hostname)) wanted = true
      if ((x.type === 'PTR' || x.type === 'ANY') && n === META_QUERY) meta = true
    }
    if (!wanted && !meta) return
    const src = normIp(rinfo.address)
    const local = isLocalAddress(src)
    // One answer per query (the same datagram arrives once per membership).
    const key = `${q.id ?? 0}|${local ? 'local' : src}|${rinfo.port}|${qs.map((x) => x.name + x.type).join(',')}`
    const now = Date.now()
    if ((this.recentQueries.get(key) ?? 0) > now - 250) return
    this.recentQueries.set(key, now)
    if (this.recentQueries.size > 64) {
      for (const [k, t] of this.recentQueries) if (t < now - 1000) this.recentQueries.delete(k)
    }
    const answers: Packet[] = []
    if (meta) answers.push({ type: 'response', answers: [{ name: META_QUERY, type: 'PTR', ttl: 4500, data: SERVICE }] })
    if (wanted) answers.push({ type: 'response', ...this.records(local ? this.primaryIp : (ifFor(src) ?? this.primaryIp)) })
    const legacy = rinfo.port !== MDNS_PORT ? { id: q.id ?? 0, questions: qs } : {}
    for (const a of answers) {
      if (local && rinfo.port === MDNS_PORT) this.multicast(a) // another responder on this machine
      else {
        const dest = { address: local ? '127.0.0.1' : src, port: rinfo.port }
        this.mdns.respond({ ...a, ...legacy } as never, dest as never)
      }
    }
  }

  /** Where to dial a peer: same-machine peers at our primary IP (see header). */
  private reachable(ip: string): string {
    const a = normIp(ip)
    return isLocalAddress(a) ? this.primaryIp || '127.0.0.1' : a
  }

  private onResponse(r: Packet, rinfo: { address: string }): void {
    if (!this.primaryIp) return // addresses not resolvable yet; the next browse retries
    const all = [...(r.answers ?? []), ...(r.additionals ?? [])]
    const instances = all
      .filter((x) => x.type === 'PTR' && lc(x.name) === SERVICE && typeof x.data === 'string' && (x.ttl ?? 1) > 0)
      .map((x) => x.data as string)
    for (const inst of instances) {
      if (lc(inst) === lc(this.instance)) continue // ourselves
      const srv = all.find((x) => x.type === 'SRV' && lc(x.name) === lc(inst))
      if (!srv) continue
      const sd = srv.data as { port: number; target: string }
      // Same rule as the C++ parser: an A record wins, else the source.
      const a = all.find((x) => x.type === 'A' && lc(x.name) === lc(sd.target))
      const txt: Record<string, string> = {}
      for (const rec of all) {
        if (rec.type !== 'TXT' || lc(rec.name) !== lc(inst)) continue
        const parts = Array.isArray(rec.data) ? rec.data : [rec.data]
        for (const p of parts) {
          const s = Buffer.isBuffer(p) ? p.toString('utf8') : String(p)
          const eq = s.indexOf('=')
          if (eq > 0) txt[s.slice(0, eq)] = s.slice(eq + 1)
        }
      }
      this.emit('peer', {
        name: inst.replace(`.${SERVICE}`, ''),
        address: this.reachable(typeof a?.data === 'string' ? (a.data as string) : rinfo.address),
        port: sd.port,
        sku: txt.sku ?? '',
        universe: txt.univ ?? '',
        txt
      } satisfies MdnsPeer)
    }
  }
}
