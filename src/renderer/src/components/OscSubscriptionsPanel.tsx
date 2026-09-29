// (v0.6.6) Device Subscriptions — Pool → Network. Asks OSC hardware that
// only streams on request (Pandore's daemon: IMU, encoder, pins) to send
// to this listener, on session load, with a heartbeat. Find discovers
// Pandore daemons on this machine / the LAN; one click subscribes. The
// data then shows up like any sender, ready for Capture.

import { useEffect, useMemo, useRef, useState } from 'react'
import { useStore } from '../store'
import type {
  OscSubscription,
  OscSubscriptionState,
  OscSubscriptionStatus,
  OscSubsProbeEndpoint,
  OscSubsProbeResult
} from '@shared/types'
import { BoundedNumberInput } from './BoundedNumberInput'
import { UncontrolledTextInput } from './UncontrolledInput'

const PANDORE_PORT = 9000
const PANDORE_REPLY_PORT = 9001

const STATE_COLOR: Record<OscSubscriptionState, string> = {
  off: 'rgb(var(--c-muted))',
  waiting: '#facc15',
  connected: '#facc15',
  streaming: '#4ade80',
  unreachable: 'rgb(var(--c-danger))',
  error: 'rgb(var(--c-danger))'
}

// Outputs (screen, leds) never stream; everything else can.
function subscribable(e: OscSubsProbeEndpoint): boolean {
  if (e.kind === 'device') return e.name !== 'screen' && e.name !== 'leds'
  return e.mode === 'in' || e.mode === 'in_pullup' || e.mode === 'in_pulldown' || e.mode === 'adc'
}

// IMU values never stand still — a fixed rate is the useful default.
function defaultRate(endpoint: string): number {
  return endpoint === 'imu' ? 50 : 0
}

function useSubStatus(active: boolean): Map<string, OscSubscriptionStatus> {
  const [status, setStatus] = useState<Map<string, OscSubscriptionStatus>>(() => new Map())
  useEffect(() => {
    if (!active) return
    let cancelled = false
    async function poll(): Promise<void> {
      const list = await window.api?.oscSubsGetStatus?.()
      if (cancelled || !Array.isArray(list)) return
      setStatus(new Map(list.map((s) => [s.id, s])))
    }
    void poll()
    const id = setInterval(() => void poll(), 1000)
    return () => {
      cancelled = true
      clearInterval(id)
    }
  }, [active])
  return status
}

export function OscSubscriptionsPanel(): JSX.Element {
  const subs = useStore((s) => s.session.oscSubscriptions) ?? []
  const listener = useStore((s) => s.networkStatus)
  const setListenerPort = useStore((s) => s.setListenerPort)
  const addSub = useStore((s) => s.addOscSubscription)
  const setCaptureOpen = useStore((s) => s.setCaptureOpen)
  const status = useSubStatus(subs.length > 0)
  const [probing, setProbing] = useState<'local' | 'network' | null>(null)
  const [found, setFound] = useState<OscSubsProbeResult | null>(null)

  async function find(network: boolean): Promise<void> {
    setProbing(network ? 'network' : 'local')
    try {
      const r = await window.api?.oscSubsProbe?.({
        network,
        port: PANDORE_PORT,
        replyPort: PANDORE_REPLY_PORT
      })
      setFound(r ?? { devices: [], error: 'Search failed.' })
    } finally {
      setProbing(null)
    }
  }

  function subscribe(host: string, port: number, endpoint: string): void {
    addSub({
      enabled: true,
      kind: 'pandore',
      host,
      port,
      endpoint,
      rateHz: defaultRate(endpoint),
      replyPort: PANDORE_REPLY_PORT
    })
  }

  const has = (host: string, port: number, endpoint: string): boolean =>
    subs.some((s) => s.kind === 'pandore' && s.host === host && s.port === port && s.endpoint === endpoint)

  // The daemon owns 9000 on a Pandore, and answers (heartbeat, Find) on 9001.
  const pandoreSubs = subs.filter((s) => s.kind === 'pandore')
  const portClash = pandoreSubs.some(
    (s) => (s.host === '127.0.0.1' || s.host === 'localhost') && s.port === listener.port
  )
  const replyPortMismatch =
    pandoreSubs.length > 0 &&
    !pandoreSubs.some((s) => (s.replyPort ?? PANDORE_REPLY_PORT) === listener.port)
  const anyStreaming = [...status.values()].some((s) => s.state === 'streaming')

  return (
    <div className="border border-border rounded p-2 bg-panel2/30 flex flex-col gap-1.5">
      <div className="flex items-center gap-1">
        <span
          className="label"
          title={
            'Some OSC devices only stream after you ask. dataFLOU sends their ' +
            '"subscribe" message when the session loads, keeps it alive with a ' +
            'heartbeat, and re-subscribes if the device restarts. The data then ' +
            'arrives at this listener like any sender — ready for Capture.'
          }
        >
          Device Subscriptions
        </span>
        <div className="flex-1" />
        <button
          className="btn text-[10px] py-0 px-1.5 leading-tight"
          disabled={probing !== null}
          onClick={() => void find(false)}
          title={`Ask a Pandore daemon on this machine (127.0.0.1:${PANDORE_PORT}) what it exposes`}
        >
          {probing === 'local' ? 'Searching…' : 'Find on this machine'}
        </button>
        <button
          className="btn text-[10px] py-0 px-1.5 leading-tight"
          disabled={probing !== null}
          onClick={() => void find(true)}
          title={`Broadcast on the LAN for Pandore daemons (port ${PANDORE_PORT})`}
        >
          {probing === 'network' ? 'Searching…' : 'Network'}
        </button>
      </div>

      {portClash && (
        <Warning>
          The listener is on port {listener.port}, which the Pandore daemon on this
          machine uses. Listen on {PANDORE_REPLY_PORT} instead.{' '}
          <InlineButton onClick={() => setListenerPort(PANDORE_REPLY_PORT)}>
            Listen on {PANDORE_REPLY_PORT}
          </InlineButton>
        </Warning>
      )}
      {!portClash && replyPortMismatch && (
        <Warning>
          Data still arrives on port {listener.port}, but Pandore sends its
          heartbeat replies to port {PANDORE_REPLY_PORT}, so dataFLOU can't check the
          link.{' '}
          <InlineButton onClick={() => setListenerPort(PANDORE_REPLY_PORT)}>
            Listen on {PANDORE_REPLY_PORT}
          </InlineButton>
        </Warning>
      )}

      {found && (
        <FindResults
          found={found}
          has={has}
          onSubscribe={subscribe}
          onClose={() => setFound(null)}
        />
      )}

      {subs.length === 0 ? (
        <div className="text-[9px] text-muted leading-snug">
          None. Use Find to discover a Pandore, or add one by hand.
        </div>
      ) : (
        <div className="flex flex-col gap-1">
          {subs.map((s) => (
            <SubscriptionRow key={s.id} sub={s} status={status.get(s.id)} />
          ))}
        </div>
      )}

      <div className="flex items-center gap-1">
        <button
          className="btn text-[10px] py-0 px-1.5 leading-tight"
          onClick={() =>
            addSub({
              enabled: true,
              kind: 'pandore',
              host: '127.0.0.1',
              port: PANDORE_PORT,
              endpoint: 'imu',
              rateHz: defaultRate('imu'),
              replyPort: PANDORE_REPLY_PORT
            })
          }
          title="Add a Pandore subscription by hand (edit host / endpoint in the row)"
        >
          + Pandore
        </button>
        <button
          className="btn text-[10px] py-0 px-1.5 leading-tight"
          onClick={() =>
            addSub({
              enabled: false,
              kind: 'custom',
              host: '127.0.0.1',
              port: PANDORE_PORT,
              endpoint: '/subscribe',
              rateHz: 0,
              customArgs: '{rate} {host} {port}',
              customUnsubscribe: ''
            })
          }
          title="Any other device: your own subscribe address + arguments, re-sent every 30 s"
        >
          + Custom
        </button>
        <div className="flex-1" />
        {anyStreaming && (
          <button
            className="btn text-[10px] py-0 px-1.5 leading-tight"
            onClick={() => setCaptureOpen(true)}
            title="Open Capture to turn the incoming stream into an Instrument / scene"
          >
            Capture…
          </button>
        )}
      </div>
    </div>
  )
}

function Warning({ children }: { children: React.ReactNode }): JSX.Element {
  return (
    <div className="text-[9px] leading-snug" style={{ color: '#facc15' }}>
      ⚠ {children}
    </div>
  )
}

function InlineButton({
  onClick,
  children
}: {
  onClick: () => void
  children: React.ReactNode
}): JSX.Element {
  return (
    <button className="underline hover:text-text" onClick={onClick}>
      {children}
    </button>
  )
}

function FindResults({
  found,
  has,
  onSubscribe,
  onClose
}: {
  found: OscSubsProbeResult
  has: (host: string, port: number, endpoint: string) => boolean
  onSubscribe: (host: string, port: number, endpoint: string) => void
  onClose: () => void
}): JSX.Element {
  return (
    <div className="border border-border/60 rounded p-1.5 flex flex-col gap-1">
      <div className="flex items-center">
        <span className="text-[9px] uppercase tracking-wide text-muted">Found</span>
        <div className="flex-1" />
        <button className="text-[10px] text-muted hover:text-text" onClick={onClose} title="Hide">
          ✕
        </button>
      </div>
      {found.devices.length === 0 && (
        <div className="text-[9px] text-muted leading-snug">
          {found.error ??
            `No Pandore answered. Is the daemon running, and is UDP ${PANDORE_PORT} reachable?`}
        </div>
      )}
      {found.devices.map((d) => {
        const eps = d.endpoints.filter(subscribable)
        // Wildcards — one stream for a whole group of input pins.
        const groups = ['aio', 'dio'].filter((g) =>
          d.endpoints.some((e) => e.kind === 'pin' && e.name.startsWith(`${g}/`))
        )
        return (
          <div key={`${d.host}:${d.port}`} className="flex flex-col gap-0.5">
            <div className="text-[10px]">
              Pandore <span className="font-mono">{d.host}:{d.port}</span>
              {Object.entries(d.mcus).map(([name, on]) => (
                <span key={name} className="text-[9px] text-muted ml-1.5">
                  {name} <span style={{ color: on ? '#4ade80' : 'rgb(var(--c-danger))' }}>●</span>
                </span>
              ))}
            </div>
            {[...eps.map((e) => ({ name: e.name, hint: e.kind === 'pin' ? e.mode ?? '' : e.online ? '' : 'offline' })),
              ...groups.map((g) => ({ name: `${g}/*`, hint: 'all input pins' }))].map(({ name, hint }) => {
              const already = has(d.host, d.port, name)
              return (
                <div key={name} className="flex items-center gap-1 pl-2">
                  <span className="font-mono text-[10px]">{name}</span>
                  {hint && <span className="text-[9px] text-muted">{hint}</span>}
                  <div className="flex-1" />
                  <button
                    className="btn text-[10px] py-0 px-1.5 leading-tight"
                    disabled={already}
                    onClick={() => onSubscribe(d.host, d.port, name)}
                  >
                    {already ? '✓ Subscribed' : 'Subscribe'}
                  </button>
                </div>
              )
            })}
            {eps.length === 0 && groups.length === 0 && (
              <div className="text-[9px] text-muted pl-2">No streamable endpoints listed.</div>
            )}
          </div>
        )
      })}
    </div>
  )
}

function SubscriptionRow({
  sub,
  status
}: {
  sub: OscSubscription
  status: OscSubscriptionStatus | undefined
}): JSX.Element {
  const update = useStore((s) => s.updateOscSubscription)
  const remove = useStore((s) => s.removeOscSubscription)
  const [open, setOpen] = useState(false)
  const state: OscSubscriptionState = sub.enabled ? status?.state ?? 'waiting' : 'off'
  const title = sub.kind === 'pandore' ? sub.endpoint : sub.endpoint || '(no address)'
  const detail = useMemo(() => {
    if (!sub.enabled) return 'Off'
    const parts = [status?.message ?? 'Starting…']
    if (status?.target) parts.push(`→ ${status.target}`)
    if (sub.kind === 'pandore' && status?.confirmed) parts.push('listed by device')
    return parts.join(' · ')
  }, [sub.enabled, sub.kind, status])

  return (
    <div className="flex flex-col gap-0.5 border-t border-border/40 pt-1">
      <div className="flex items-center gap-1">
        <span
          className="inline-block w-2 h-2 rounded-full shrink-0"
          style={{ background: STATE_COLOR[state] }}
          title={state}
        />
        <button
          className="font-mono text-[10px] truncate text-left hover:underline"
          onClick={() => setOpen((v) => !v)}
          title="Edit"
        >
          {title}
        </button>
        <span className="text-[9px] text-muted font-mono truncate">
          {sub.host}:{sub.port}
        </span>
        <div className="flex-1" />
        <BoundedNumberInput
          className="bg-panel2 border border-border rounded text-[10px] px-1 py-0 w-[42px] leading-tight"
          value={sub.rateHz}
          min={0}
          max={1000}
          integer
          commitOn="blur"
          onChange={(v) => update(sub.id, { rateHz: v })}
          title="Rate in Hz — 0 = on-change"
        />
        <span className="text-[9px] text-muted">Hz</span>
        <input
          type="checkbox"
          checked={sub.enabled}
          onChange={(e) => update(sub.id, { enabled: e.target.checked })}
          title={sub.enabled ? 'Unsubscribe' : 'Subscribe'}
        />
        <button
          className="text-[11px] text-muted hover:text-text px-0.5"
          disabled={!sub.enabled}
          onClick={() => void window.api?.oscSubsResubscribe?.(sub.id)}
          title="Send the subscribe message again now"
        >
          ↻
        </button>
        <button
          className="text-[11px] text-muted hover:text-text px-0.5"
          onClick={() => remove(sub.id)}
          title="Unsubscribe and remove"
        >
          ✕
        </button>
      </div>
      <div className="text-[9px] text-muted leading-snug pl-3 truncate" title={detail}>
        {detail}
      </div>
      {open && <SubscriptionEditor sub={sub} />}
    </div>
  )
}

// Commits on blur / Enter only: every committed edit re-sends the
// subscribe message, so half-typed hosts must never reach the store.
function CommitTextInput({
  value,
  onCommit,
  className
}: {
  value: string
  onCommit: (v: string) => void
  className: string
}): JSX.Element {
  const draft = useRef(value)
  return (
    <UncontrolledTextInput
      className={className}
      value={value}
      spellCheck={false}
      onChange={(v) => {
        draft.current = v
      }}
      onBlur={() => {
        if (draft.current !== value) onCommit(draft.current)
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') (e.currentTarget as HTMLInputElement).blur()
        if (e.key === 'Escape') {
          draft.current = value
          e.currentTarget.value = value
          e.currentTarget.blur()
        }
      }}
    />
  )
}

function SubscriptionEditor({ sub }: { sub: OscSubscription }): JSX.Element {
  const update = useStore((s) => s.updateOscSubscription)
  const field = 'bg-panel2 border border-border rounded text-[10px] px-1 py-0 leading-tight'
  const text = (
    label: string,
    value: string,
    onCommit: (v: string) => void,
    hint: string
  ): JSX.Element => (
    <label className="flex items-center gap-1" title={hint}>
      <span className="text-[9px] text-muted w-[52px] shrink-0">{label}</span>
      <CommitTextInput className={`${field} flex-1 font-mono`} value={value} onCommit={onCommit} />
    </label>
  )
  return (
    <div className="pl-3 flex flex-col gap-0.5">
      {text('Host', sub.host, (v) => v.trim() && update(sub.id, { host: v.trim() }), 'Device IP — 127.0.0.1 = this machine')}
      <label className="flex items-center gap-1" title="Device OSC port (Pandore daemon: 9000)">
        <span className="text-[9px] text-muted w-[52px] shrink-0">Port</span>
        <BoundedNumberInput
          className={`${field} w-[58px]`}
          value={sub.port}
          min={1}
          max={65535}
          integer
          commitOn="blur"
          onChange={(v) => update(sub.id, { port: v })}
        />
      </label>
      {sub.kind === 'pandore' ? (
        <>
          {text(
            'Endpoint',
            sub.endpoint,
            (v) => v.trim() && update(sub.id, { endpoint: v.trim().replace(/^\/?(pandore\/)?/, '') }),
            'imu, encoder, aio/2, aio/* … → /pandore/{endpoint}/subscribe'
          )}
          <label
            className="flex items-center gap-1"
            title="Where the daemon sends its replies (its --osc-reply, default 9001)"
          >
            <span className="text-[9px] text-muted w-[52px] shrink-0">Replies on</span>
            <BoundedNumberInput
              className={`${field} w-[58px]`}
              value={sub.replyPort ?? PANDORE_REPLY_PORT}
              min={1}
              max={65535}
              integer
              commitOn="blur"
              onChange={(v) => update(sub.id, { replyPort: v })}
            />
          </label>
        </>
      ) : (
        <>
          {text('Address', sub.endpoint, (v) => update(sub.id, { endpoint: v.trim() }), 'Subscribe address, e.g. /sensor/subscribe')}
          {text(
            'Args',
            sub.customArgs ?? '',
            (v) => update(sub.id, { customArgs: v }),
            '{rate} {port} → int, {host} → string (this machine as the device sees it); numbers and words as-is'
          )}
          {text(
            'Unsub',
            sub.customUnsubscribe ?? '',
            (v) => update(sub.id, { customUnsubscribe: v.trim() }),
            'Address sent (same args) when disabled or removed — empty = none'
          )}
        </>
      )}
    </div>
  )
}
