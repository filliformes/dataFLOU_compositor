// (v0.6.7) Pool → Mesh. dataFLOU_compositor as a node of the dataflou mesh
// (124_dataflou, protocol v2): switch the node on, see every node in the
// universe with its live parameter tree, bind any destination to any
// source (on any node — the library forwards the request), set values,
// flush offline nodes. The compositor's own tree (Parameters, scenes,
// transport, Meta knobs) is built from the session in main.

import { useEffect, useMemo, useState } from 'react'
import type { MeshNodeView, MeshParamView, MeshSnapshot } from '@shared/types'
import { CommitTextInput } from './OscSubscriptionsPanel'

const POLL_MS = 500

const FLOW_GLYPH: Record<MeshParamView['flow'], string> = {
  source: '→',
  destination: '←',
  bidir: '↔'
}
const FLOW_TITLE: Record<MeshParamView['flow'], string> = {
  source: 'Source — publishes values',
  destination: 'Destination — accepts values',
  bidir: 'Bidirectional — publishes and accepts'
}

function useMeshSnapshot(): [MeshSnapshot | null, (s: MeshSnapshot) => void] {
  const [snap, setSnap] = useState<MeshSnapshot | null>(null)
  useEffect(() => {
    let cancelled = false
    async function poll(): Promise<void> {
      const s = await window.api?.meshGetSnapshot?.()
      if (!cancelled && s) setSnap(s)
    }
    void poll()
    const id = setInterval(() => void poll(), POLL_MS)
    return () => {
      cancelled = true
      clearInterval(id)
    }
  }, [])
  return [snap, setSnap]
}

interface SourceOption {
  sku: string
  path: string
  label: string // "node / path"
  type: string
}

export function MeshPanel(): JSX.Element {
  const [snap, setSnap] = useMeshSnapshot()
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)
  const [open, setOpen] = useState<Set<string>>(() => new Set())

  const sources = useMemo<SourceOption[]>(() => {
    const out: SourceOption[] = []
    for (const n of snap?.nodes ?? []) {
      if (!n.online) continue
      for (const p of n.params) {
        if (p.group || p.flow === 'destination') continue
        out.push({ sku: n.sku, path: p.path, label: `${n.label} / ${p.path}`, type: p.type })
      }
    }
    return out
  }, [snap])

  if (!snap) return <div className="text-[10px] text-muted px-2 py-1">Loading…</div>
  const { config, running } = snap
  const peers = snap.nodes.filter((n) => !n.isLocal)
  const online = peers.filter((n) => n.online).length

  async function setConfig(patch: Partial<MeshSnapshot['config']>): Promise<void> {
    setBusy(true)
    try {
      const next = await window.api?.meshSetConfig?.(patch)
      if (next) setSnap(next)
    } finally {
      setBusy(false)
    }
  }

  async function run(p: Promise<string | null> | undefined): Promise<void> {
    const err = await p
    setMsg(err ?? null)
  }

  function toggle(sku: string): void {
    setOpen((prev) => {
      const next = new Set(prev)
      if (next.has(sku)) next.delete(sku)
      else next.add(sku)
      return next
    })
  }

  return (
    <div className="flex flex-col gap-1.5 px-2 py-1">
      <div className="border border-border rounded p-2 bg-panel2/30 flex flex-col gap-1.5">
        <div className="flex items-center gap-1.5 min-w-0">
          <span
            className="label shrink-0"
            title={
              'dataflou mesh node. Other dataflou nodes (ESP32 / Teensy sensors, ' +
              'other apps) discover dataFLOU over mDNS and see its Parameters, ' +
              'scenes, transport and Meta knobs. Bind any destination to any ' +
              'source; values stream peer-to-peer over UDP, range-mapped.'
            }
          >
            dataflou Mesh
          </span>
          <button
            className="text-[10px] px-1.5 py-0 leading-tight rounded border shrink-0"
            disabled={busy}
            onClick={() => void setConfig({ enabled: !config.enabled })}
            style={
              config.enabled
                ? { background: '#4ade80', borderColor: '#4ade80', color: 'black' }
                : undefined
            }
            title={config.enabled ? 'Leave the mesh' : 'Join the mesh as a node'}
          >
            {config.enabled ? 'On' : 'Off'}
          </button>
          <span className="text-[9px] text-muted truncate min-w-0">
            {snap.error
              ? `⚠ ${snap.error}`
              : running
                ? `${online} node${online === 1 ? '' : 's'} online · TCP ${snap.port} / UDP ${snap.port + 1}`
                : 'Not on the mesh'}
          </span>
        </div>
        <div className="flex items-center gap-1.5 text-[10px]">
          <span className="text-muted shrink-0">Name</span>
          <CommitTextInput
            className="input text-[10px] py-0 px-1 min-w-0 flex-1"
            value={config.label}
            onCommit={(v) => void setConfig({ label: v })}
          />
          <span
            className="text-muted shrink-0"
            title="Only nodes in the same universe see each other"
          >
            Universe
          </span>
          <CommitTextInput
            className="input text-[10px] py-0 px-1 min-w-0 w-28"
            value={config.universe}
            onCommit={(v) => void setConfig({ universe: v })}
          />
        </div>
        {snap.dropped > 0 && (
          <div className="text-[9px] leading-snug" style={{ color: '#facc15' }}>
            ⚠ {snap.dropped} session entr{snap.dropped === 1 ? 'y is' : 'ies are'} not
            published: a dataflou node holds at most 128 parameters (32 per group).
          </div>
        )}
        {msg && (
          <div className="text-[9px] leading-snug" style={{ color: 'rgb(var(--c-danger))' }}>
            ⚠ {msg}
          </div>
        )}
      </div>

      {running &&
        snap.nodes.map((n) => (
          <NodeCard
            key={n.sku}
            node={n}
            open={open.has(n.sku) === n.isLocal /* peers start open, self collapsed */}
            onToggle={() => toggle(n.sku)}
            sources={sources}
            onBind={(p, src) =>
              void run(window.api?.meshSubscribe?.(n.sku, p.path, src.sku, src.path, true))
            }
            onUnbind={(p, sku, path) =>
              void run(window.api?.meshSubscribe?.(n.sku, p.path, sku, path, false))
            }
            onSet={(p, v) => void run(window.api?.meshSetValue?.(n.sku, p.path, v))}
            onFlush={() => void window.api?.meshFlush?.(n.sku)}
          />
        ))}
      {running && peers.length === 0 && (
        <div className="text-[9px] text-muted leading-snug">
          No other nodes in universe “{config.universe}” yet. dataflou nodes on this
          machine or the LAN appear here automatically.
        </div>
      )}
    </div>
  )
}

function NodeCard({
  node,
  open,
  onToggle,
  sources,
  onBind,
  onUnbind,
  onSet,
  onFlush
}: {
  node: MeshNodeView
  open: boolean
  onToggle: () => void
  sources: SourceOption[]
  onBind: (p: MeshParamView, src: SourceOption) => void
  onUnbind: (p: MeshParamView, sku: string, path: string) => void
  onSet: (p: MeshParamView, v: string) => void
  onFlush: () => void
}): JSX.Element {
  const count = node.params.filter((p) => !p.group).length
  return (
    <div className="border border-border rounded bg-panel2/30">
      <div
        className="flex items-center gap-1.5 px-2 py-1 cursor-pointer select-none min-w-0"
        onClick={onToggle}
      >
        <span className="text-[9px] text-muted w-2 shrink-0">{open ? '▾' : '▸'}</span>
        <span
          className="inline-block w-1.5 h-1.5 rounded-full shrink-0"
          style={{
            background: node.online
              ? node.connected
                ? '#4ade80'
                : '#facc15'
              : 'rgb(var(--c-muted))'
          }}
          title={node.online ? (node.connected ? 'Online' : 'Online (via gossip)') : 'Offline'}
        />
        <span className="text-[11px] font-medium truncate">{node.label}</span>
        {node.isLocal && <span className="text-[9px] text-muted shrink-0">this app</span>}
        <span className="text-[9px] text-muted truncate min-w-0" title={node.sku}>
          {node.product}
          {node.address ? ` · ${node.address}` : ''}
        </span>
        <div className="flex-1" />
        <span className="text-[9px] text-muted shrink-0">{count}P</span>
        {!node.online && !node.isLocal && (
          <button
            className="btn text-[9px] py-0 px-1 leading-tight shrink-0"
            onClick={(e) => {
              e.stopPropagation()
              onFlush()
            }}
            title="Forget this offline node on every peer (FLUSH)"
          >
            Flush
          </button>
        )}
      </div>
      {open && (
        <div className="border-t border-border py-0.5">
          {node.params.length === 0 && (
            <div className="text-[9px] text-muted px-2">No parameters declared.</div>
          )}
          {node.params.map((p) => (
            <ParamRow
              key={p.path}
              p={p}
              writable={node.online && p.access !== 'read'}
              sources={sources.filter((s) => !(s.sku === node.sku && s.path === p.path))}
              onBind={(src) => onBind(p, src)}
              onUnbind={(sku, path) => onUnbind(p, sku, path)}
              onSet={(v) => onSet(p, v)}
            />
          ))}
        </div>
      )}
    </div>
  )
}

function ParamRow({
  p,
  writable,
  sources,
  onBind,
  onUnbind,
  onSet
}: {
  p: MeshParamView
  writable: boolean
  sources: SourceOption[]
  onBind: (src: SourceOption) => void
  onUnbind: (sku: string, path: string) => void
  onSet: (v: string) => void
}): JSX.Element {
  const [binding, setBinding] = useState(false)
  const [editing, setEditing] = useState(false)
  const indent = { paddingLeft: 8 + p.depth * 10 }
  if (p.group) {
    return (
      <div className="text-[9px] uppercase tracking-wide text-muted pt-1" style={indent}>
        {p.label || p.name}
      </div>
    )
  }
  const accepts = p.flow !== 'source'
  const range =
    p.type === 'number' || p.type.startsWith('v') ? `${trim(p.min)}…${trim(p.max)}` : ''
  // Numbers show just their range (the most useful bit in a narrow Pool).
  const typeLabel =
    p.type === 'number' ? range : p.type === 'string' ? 'str' : range ? `${p.type} ${range}` : p.type
  return (
    <div className="pr-2" style={indent}>
      <div className="flex items-center gap-1.5 min-w-0 h-[18px]">
        <span className="text-[10px] text-muted w-3 shrink-0" title={FLOW_TITLE[p.flow]}>
          {FLOW_GLYPH[p.flow]}
        </span>
        <span
          className="text-[10px] truncate min-w-0"
          title={`${p.path}${p.label && p.label !== p.name ? ` — ${p.label}` : ''}`}
        >
          {p.name}
          {p.label && p.label !== p.name && p.label.replace(/\s+/g, '_') !== p.name && (
            <span className="text-muted"> · {p.label}</span>
          )}
        </span>
        <div className="flex-1" />
        {editing ? (
          <CommitTextInput
            className="input text-[10px] py-0 px-1 w-20 font-mono"
            value={p.value}
            onCommit={(v) => {
              setEditing(false)
              onSet(v)
            }}
          />
        ) : (
          <span
            className={`text-[10px] font-mono truncate max-w-[45%] text-right ${
              writable ? 'cursor-text hover:underline' : ''
            }`}
            onClick={() => writable && setEditing(true)}
            title={writable ? 'Click to set (SETVAL)' : undefined}
          >
            {p.value || '—'}
          </span>
        )}
        <span
          className="text-[8px] text-muted shrink-0 w-14 text-right truncate"
          title={`${p.type}${range ? ` ${range}` : ''}${p.unit ? ` ${p.unit}` : ''} · ${p.access}`}
        >
          {typeLabel}
        </span>
        {accepts && (
          <button
            className="text-[10px] leading-none text-muted hover:text-text shrink-0 w-3"
            onClick={() => setBinding((b) => !b)}
            title="Bind a source to this parameter"
          >
            {binding ? '×' : '+'}
          </button>
        )}
      </div>
      {p.subs.map((s) => (
        <div
          key={`${s.sku}/${s.path}`}
          className="flex items-center gap-1 text-[9px] text-muted pl-4 min-w-0"
        >
          <span className="truncate min-w-0" title={`${s.sku} / ${s.path}`}>
            ← {s.label || s.sku.slice(0, 8)} / {s.path}
          </span>
          <button
            className="hover:text-text shrink-0"
            onClick={() => onUnbind(s.sku, s.path)}
            title="Unbind"
          >
            ×
          </button>
        </div>
      ))}
      {binding && (
        <select
          className="input text-[10px] py-0 px-1 w-full my-0.5"
          defaultValue=""
          onChange={(e) => {
            const src = sources[Number(e.target.value)]
            if (src) onBind(src)
            setBinding(false)
          }}
        >
          <option value="" disabled>
            {sources.length ? 'Pick a source…' : 'No sources online'}
          </option>
          {sources.map((s, i) => (
            <option key={`${s.sku}/${s.path}`} value={i}>
              {s.label} ({s.type})
            </option>
          ))}
        </select>
      )}
    </div>
  )
}

function trim(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(2)
}
