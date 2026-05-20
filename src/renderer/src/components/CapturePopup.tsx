// Capture popup — modal triggered by the Pool drawer's Capture
// button. Three capture modes:
//
//   1. **New OSC Instrument** — snapshot the currently-discovered
//      Network devices into a fresh user Instrument Template in
//      the Pool. Uses the existing `OscNetworkListener` cache, so
//      whatever OSC traffic has hit our listening port shows up
//      here; the user picks a device, names the Instrument, hits
//      Save.
//
//   2. **New Scene** — same OSC capture flow, but ALSO instantiates
//      the resulting Instrument as sidebar Tracks and creates a
//      Scene in `session.scenes` with cell values pre-populated
//      from the latest observed args. So a working OCTOCOSME patch
//      can be snapshotted into a live, ready-to-trigger scene.
//
//   3. **New MIDI Instrument** — subscribes to incoming MIDI CC +
//      Note events via the renderer's `midi.MidiManager.setCaptureCb`.
//      The user wiggles knobs / hits notes; each unique CC# /
//      note becomes a Parameter on the resulting Instrument with
//      pre-configured `midiOut` defaults (CC kind + cc number for
//      CCs; Note kind + the note number for notes).
//
// Save at the bottom commits the buffered capture to the right
// destination (Pool / session) and closes the popup. Cancel /
// overlay click discards the buffer.

import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useStore } from '../store'
import { midi, type MidiCaptureMessage } from '../midi'
import type {
  Cell,
  DiscoveredOscAddress,
  DiscoveredOscDevice,
  InstrumentFunction,
  InstrumentTemplate,
  MidiOut,
  ParamArgSpec,
  Track
} from '@shared/types'
import {
  inferParamTypeFromArgTypes,
  makeCell,
  randomSceneColor
} from '@shared/factory'
import { ResizeHandle } from './ResizeHandle'

type CaptureMode =
  | 'osc-instrument'
  | 'osc-scene'
  | 'osc-scene-for-instrument'
  | 'midi-instrument'

interface CapturedMidiSlot {
  // Discriminates CC vs Note Parameters. Note Off events count
  // toward the same slot as Note On (so playing+releasing the
  // same pad still registers as one Parameter, not two).
  kind: 'cc' | 'note'
  channel: number  // 1..16 (UI-facing — wire is 0..15)
  number: number   // CC number or note number
  count: number    // how many events have hit this slot — drives
                   // the "vigorousness" cue in the live preview
  lastValue: number // last observed value/velocity, 0..127
  lastSeen: number
}

export default function CapturePopup(): JSX.Element | null {
  const open = useStore((s) => s.captureOpen)
  const setOpen = useStore((s) => s.setCaptureOpen)
  if (!open) return null
  // On close, ALSO blur whatever input the popup left focused +
  // re-anchor focus on <body>. Same fix as the saved-scene drop
  // handlers: Electron / Chromium leaves a sticky pseudo-focus on
  // the popup's inputs when the modal unmounts, which then
  // swallowed every subsequent click on the grid until the user
  // alt-tabbed. rAF puts the blur AFTER the unmount so the next
  // click on a cell input lands cleanly.
  function handleClose(): void {
    setOpen(false)
    requestAnimationFrame(() => {
      if (document.activeElement instanceof HTMLElement) {
        document.activeElement.blur()
      }
      document.body.focus?.()
    })
  }
  return <CapturePopupBody onClose={handleClose} />
}

// Default Capture-popup window size. Always opens at this size — the
// previous version persisted the user's last drag-resized dimensions
// to localStorage, but that made the popup "auto-resize" on open
// which felt jarring. The user can still drag the bottom-right grip
// to resize within the session; the size just doesn't survive close.
const CAPTURE_DEFAULT_W = 640
const CAPTURE_DEFAULT_H = 'min(700px, 88vh)' as const

function CapturePopupBody({ onClose }: { onClose: () => void }): JSX.Element {
  // Default mode = "New Scene for Instrument" — the most common
  // workflow: a Pool Instrument already exists (Built-in OCTOCOSME
  // or a previously-captured one), and the user wants to snapshot
  // the current OSC values flowing into it as a new saved Scene.
  // "New OSC Instrument" is the rare bootstrap path, moved to the
  // bottom row.
  const [mode, setMode] = useState<CaptureMode>('osc-scene-for-instrument')
  // `name` doubles as Instrument name (for `osc-instrument` /
  // `osc-scene` / `midi-instrument`) AND Scene name (for
  // `osc-scene-for-instrument`). `sceneName` is ONLY used by
  // `osc-scene` mode, which needs both: an Instrument name for the
  // Pool entry + a separate Scene name for the saved Scene.
  const [name, setName] = useState<string>('')
  const [sceneName, setSceneName] = useState<string>('')
  // Selected device id for OSC captures — the user picks one of
  // the currently-discovered senders from the dropdown. We default
  // to the most-recently-active device when the popup opens.
  const networkDevices = useStore((s) => s.networkDevices)
  const networkStatus = useStore((s) => s.networkStatus)
  const setNetworkSnapshot = useStore((s) => s.setNetworkSnapshot)
  const poolTemplates = useStore((s) => s.session.pool.templates)
  const [selectedDeviceId, setSelectedDeviceId] = useState<string>('')
  // Set of OSC paths the user has clicked X to remove from the capture
  // BEFORE saving — buildOscTemplate filters them out so the resulting
  // Pool Instrument only contains the addresses the user wants.
  // Cleared whenever the selected device changes (paths are device-scoped).
  const [removedPaths, setRemovedPaths] = useState<Set<string>>(() => new Set())
  // For 'osc-scene-for-instrument' mode — which existing Pool template
  // are we snapshotting current values into? Default to the first user
  // template; if there's only builtins, pick the first builtin.
  const [selectedExistingTemplateId, setSelectedExistingTemplateId] =
    useState<string>('')
  // Persisted height of the captured-addresses scroll box so the user
  // can pull it taller to see all values for an OCTOCOSME-sized device
  // (10+ addresses × multi-value rows would otherwise need a tiny
  // 256-px-tall scroll).
  const [addrBoxHeight, setAddrBoxHeight] = useState<number>(() => {
    try {
      const v = parseInt(
        localStorage.getItem('dataflou:capture:addrBoxHeight:v1') ?? '',
        10
      )
      if (Number.isFinite(v) && v >= 120 && v <= 700) return v
    } catch {
      /* ignore */
    }
    return 256
  })
  function persistAddrBoxHeight(v: number): void {
    const clamped = Math.max(120, Math.min(700, v))
    setAddrBoxHeight(clamped)
    try {
      localStorage.setItem('dataflou:capture:addrBoxHeight:v1', String(clamped))
    } catch {
      /* ignore */
    }
  }

  // Resizable popup window — `popupRef` is bound to the modal panel
  // so the user can drag the bottom-right grip to resize WITHIN the
  // session. We deliberately do NOT persist the dragged size to
  // localStorage anymore: every open starts at the default, so the
  // popup never appears to "auto-resize" on open.
  const popupRef = useRef<HTMLDivElement | null>(null)

  // Auto-pick the freshest device on mount + when the listener
  // surfaces a new device (the user may need to start a packet
  // flowing from their hardware before any device shows up).
  useEffect(() => {
    if (!selectedDeviceId && networkDevices.length > 0) {
      setSelectedDeviceId(networkDevices[0].id)
    }
  }, [networkDevices, selectedDeviceId])
  // Reset the per-address X-delete set when the user switches devices —
  // removed paths are device-scoped, not global.
  useEffect(() => {
    setRemovedPaths(new Set())
  }, [selectedDeviceId])
  // Seed the existing-template picker once the pool has entries —
  // pick the FIRST non-draft entry in the Pool, which is whichever
  // Instrument the dropdown lists first (Built-in OCTOCOSME etc.).
  // Matches the visible order so the popup opens on the same row
  // the user would see at the top of the select.
  useEffect(() => {
    if (!selectedExistingTemplateId && poolTemplates.length > 0) {
      const firstNonDraft =
        poolTemplates.find((t) => !t.draft) ?? poolTemplates[0]
      setSelectedExistingTemplateId(firstNonDraft.id)
    }
  }, [poolTemplates, selectedExistingTemplateId])

  // OSC listener needs to be ON for the Network-tab cache to fill.
  // The popup auto-enables it on open (in OSC modes) and remembers
  // whether we had to enable it so we can restore the prior state
  // on Cancel/Save if the user explicitly had it off.
  const listenerWasOnAtOpen = useRef<boolean>(networkStatus.enabled)
  useEffect(() => {
    listenerWasOnAtOpen.current = networkStatus.enabled
  }, [])
  useEffect(() => {
    if (mode === 'midi-instrument') return
    if (!networkStatus.enabled) {
      window.api?.networkSetEnabled?.(true).then((next) => {
        if (next) setNetworkSnapshot(networkDevices, next)
      })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode])

  // MIDI capture buffer — only filled when mode === 'midi-instrument'.
  // Key format: `${kind}|${channel}|${number}` so a CC#7 on ch1 is
  // distinct from a Note 7 on ch1, and channels stay separable.
  const [midiSlots, setMidiSlots] = useState<Map<string, CapturedMidiSlot>>(
    () => new Map()
  )
  useEffect(() => {
    if (mode !== 'midi-instrument') {
      midi.setCaptureCb(null)
      return
    }
    midi.setCaptureCb((msg: MidiCaptureMessage) => {
      // Map noteOff into the same slot as noteOn — releasing a pad
      // shouldn't double-count the Parameter. Skip noteOff entirely
      // for the capture buffer; it carries no useful info beyond
      // "the user stopped holding the note."
      if (msg.kind === 'noteOff') return
      setMidiSlots((prev) => {
        const slotKind: 'cc' | 'note' = msg.kind === 'cc' ? 'cc' : 'note'
        const channel = msg.channel + 1 // UI 1..16
        const key = `${slotKind}|${channel}|${msg.number}`
        const existing = prev.get(key)
        const next = new Map(prev)
        next.set(key, {
          kind: slotKind,
          channel,
          number: msg.number,
          count: (existing?.count ?? 0) + 1,
          lastValue: msg.value,
          lastSeen: Date.now()
        })
        return next
      })
    })
    return () => {
      midi.setCaptureCb(null)
    }
  }, [mode])

  // The currently-selected device's snapshot (OSC capture only).
  const selectedDevice: DiscoveredOscDevice | undefined = useMemo(
    () => networkDevices.find((d) => d.id === selectedDeviceId),
    [networkDevices, selectedDeviceId]
  )

  // Save handler — branches on mode.
  const setSessionStore = useStore.setState
  const sessionRef = useStore((s) => s.session)
  function commitSave(): void {
    const trimmedName = name.trim()
    if (!trimmedName) {
      // Friendly nudge: focus the name input. (No alert; the input
      // visually signals the requirement.)
      nameInputRef.current?.focus()
      return
    }
    if (mode === 'osc-instrument') {
      if (!selectedDevice) return
      const tpl = buildOscTemplate(trimmedName, selectedDevice, removedPaths)
      addTemplateToPool(setSessionStore, tpl)
    } else if (mode === 'osc-scene') {
      if (!selectedDevice) return
      // osc-scene needs BOTH names: Instrument name for the Pool
      // entry, Scene name for the SavedScene library entry. Fall
      // back to the Instrument name when the user didn't fill in a
      // Scene name (Save button requires the Instrument name but
      // Scene name is allowed to be blank).
      const trimmedScene = sceneName.trim() || trimmedName
      const tpl = buildOscTemplate(trimmedName, selectedDevice, removedPaths)
      // Save to BOTH the Pool (Instrument) AND the Scenes library
      // (reusable Scene). Does NOT touch session.tracks / scenes —
      // the user drags the saved Scene onto the grid when they want
      // it, like any other library Scene. Fire-and-forget; library
      // updates push back via the IPC change channel.
      void saveOscCaptureAsLibraryScene(
        setSessionStore,
        tpl,
        selectedDevice,
        trimmedScene
      )
    } else if (mode === 'osc-scene-for-instrument') {
      // New mode: pick an existing Pool Instrument, watch incoming
      // OSC traffic that matches its addresses, and snapshot the
      // current values as a SavedScene (no new Instrument created).
      if (!selectedExistingTemplateId) return
      void saveSceneForExistingInstrument(
        setSessionStore,
        selectedExistingTemplateId,
        networkDevices,
        trimmedName
      )
    } else if (mode === 'midi-instrument') {
      const tpl = buildMidiTemplate(trimmedName, Array.from(midiSlots.values()))
      addTemplateToPool(setSessionStore, tpl)
    }
    onClose()
  }

  // ESC closes the popup.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const nameInputRef = useRef<HTMLInputElement>(null)
  // Focus the name input on mount so the user can just type.
  useEffect(() => {
    nameInputRef.current?.focus()
    nameInputRef.current?.select()
  }, [])

  // Name input is intentionally left BLANK on open / mode change.
  // The previous version auto-filled it with the captured device
  // name or "MIDI Capture", which the user then had to delete every
  // time they saved a capture — annoying for a workflow that
  // captures many scenes in a row. Now the user types a name (or
  // leaves blank and Save uses a sensible fallback derived at
  // commit time). `userTouchedName` is retained for any future
  // auto-suggest UX that opts in, but the effect below is a no-op.
  const userTouchedName = useRef(false)

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center"
      style={{ background: 'rgba(0,0,0,0.45)' }}
      // Only close when the mousedown ORIGINATED on the backdrop. A
      // plain `onClick` was firing the close handler when the user
      // drag-selected text inside the Name input and the mouseup
      // landed on the backdrop — the synthetic click bubbles to the
      // nearest common ancestor (this div), which then closed the
      // popup mid-select. mousedown-on-target avoids that since the
      // press starts inside the panel.
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div
        ref={popupRef}
        className="bg-panel border border-border rounded-md shadow-xl flex flex-col"
        // Native CSS `resize: both` adds an OS-drawn grip in the
        // bottom-right corner — drag it to grow / shrink the popup
        // within the session. Opens at a fixed default size so the
        // first paint matches user expectation (no jarring layout
        // shift from a persisted size). Min/max clamps keep the
        // popup from getting too small (mode buttons clip below
        // ~480 px wide) or larger than the viewport.
        style={{
          width: CAPTURE_DEFAULT_W,
          height: CAPTURE_DEFAULT_H,
          minWidth: 480,
          minHeight: 400,
          maxWidth: '95vw',
          maxHeight: '95vh',
          resize: 'both',
          overflow: 'hidden'
        }}
        // Belt + suspenders: also stop mousedown propagation so the
        // backdrop's check above never even runs for in-panel drags.
        onMouseDown={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center gap-2 px-3 py-2 border-b border-border">
          <span className="label">Capture</span>
          <span className="text-[10px] text-muted">
            Snapshot a live OSC or MIDI device into the Pool
          </span>
          <div className="flex-1" />
          <button
            className="btn text-[10px] py-0.5"
            onClick={onClose}
            title="Cancel — discards the capture buffer"
          >
            ×
          </button>
        </div>

        {/* Mode picker */}
        <div className="px-3 pt-3 pb-2 flex flex-col gap-2">
          <span className="label">Capture as:</span>
          <div className="grid grid-cols-2 gap-1">
            {/* Top row — common Scene-snapshot workflows. */}
            <ModeButton
              active={mode === 'osc-scene-for-instrument'}
              label="New Scene for Instrument"
              hint="Pick an EXISTING Pool Instrument and snapshot the current OSC values flowing into it as a new saved Scene."
              onClick={() => setMode('osc-scene-for-instrument')}
            />
            <ModeButton
              active={mode === 'osc-scene'}
              label="New Instrument + Scene"
              hint="Add the Instrument to the Pool AND save a Scene with the captured values to the Scenes library (no grid changes)."
              onClick={() => setMode('osc-scene')}
            />
            {/* Bottom row — bootstrap "new Instrument" paths. */}
            <ModeButton
              active={mode === 'osc-instrument'}
              label="New OSC Instrument"
              hint="Snapshot a sender's addresses + current values as a Pool Instrument."
              onClick={() => setMode('osc-instrument')}
            />
            <ModeButton
              active={mode === 'midi-instrument'}
              label="New MIDI Instrument"
              hint="Listen for incoming CC + Note events; each becomes a Parameter on the new Instrument."
              onClick={() => setMode('midi-instrument')}
            />
          </div>
          {/* Name input(s) — depend on mode:
              - osc-instrument          → ONE input: Instrument name ("My OSC Instrument").
              - osc-scene               → TWO inputs: Instrument name + Scene name.
              - osc-scene-for-instrument → ONE input: Scene name only ("New Scene"). No new Instrument is created.
              - midi-instrument         → ONE input: Instrument name ("My MIDI Controller"). */}
          {mode === 'osc-scene' ? (
            <>
              <label className="flex items-center gap-2">
                <span className="label">Instrument</span>
                <input
                  ref={nameInputRef}
                  className="input flex-1 text-[12px]"
                  value={name}
                  onChange={(e) => {
                    userTouchedName.current = true
                    setName(e.target.value)
                  }}
                  placeholder="My OSC Instrument"
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') commitSave()
                  }}
                />
              </label>
              <label className="flex items-center gap-2">
                <span className="label">Scene</span>
                <input
                  className="input flex-1 text-[12px]"
                  value={sceneName}
                  onChange={(e) => setSceneName(e.target.value)}
                  placeholder="New Scene"
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') commitSave()
                  }}
                />
              </label>
            </>
          ) : (
            <label className="flex items-center gap-2">
              <span className="label">
                {mode === 'osc-scene-for-instrument' ? 'Scene' : 'Name'}
              </span>
              <input
                ref={nameInputRef}
                className="input flex-1 text-[12px]"
                value={name}
                onChange={(e) => {
                  userTouchedName.current = true
                  setName(e.target.value)
                }}
                placeholder={
                  mode === 'midi-instrument'
                    ? 'My MIDI Controller'
                    : mode === 'osc-scene-for-instrument'
                      ? 'New Scene'
                      : 'My OSC Instrument'
                }
                onKeyDown={(e) => {
                  if (e.key === 'Enter') commitSave()
                }}
              />
            </label>
          )}
        </div>

        {/* Body */}
        <div className="flex-1 min-h-0 overflow-y-auto px-3 py-2 flex flex-col gap-2">
          {(mode === 'osc-instrument' || mode === 'osc-scene') && (
            <OscCaptureBody
              devices={networkDevices}
              status={networkStatus}
              selectedDeviceId={selectedDeviceId}
              onSelect={setSelectedDeviceId}
              removedPaths={removedPaths}
              onRemovePath={(p) => {
                setRemovedPaths((prev) => {
                  const next = new Set(prev)
                  next.add(p)
                  return next
                })
              }}
              onRestorePath={(p) => {
                setRemovedPaths((prev) => {
                  const next = new Set(prev)
                  next.delete(p)
                  return next
                })
              }}
              addrBoxHeight={addrBoxHeight}
              onResizeAddrBox={persistAddrBoxHeight}
            />
          )}
          {mode === 'osc-scene-for-instrument' && (
            <SceneForInstrumentBody
              templates={poolTemplates}
              selectedTemplateId={selectedExistingTemplateId}
              onSelectTemplate={setSelectedExistingTemplateId}
              devices={networkDevices}
              status={networkStatus}
              addrBoxHeight={addrBoxHeight}
              onResizeAddrBox={persistAddrBoxHeight}
            />
          )}
          {mode === 'midi-instrument' && (
            <MidiCaptureBody
              slots={Array.from(midiSlots.values())}
              onClear={() => setMidiSlots(new Map())}
            />
          )}
        </div>

        {/* Footer — Save / Cancel */}
        <div className="flex items-center gap-2 px-3 py-2 border-t border-border">
          <span className="text-[10px] text-muted">
            {mode === 'midi-instrument'
              ? `${midiSlots.size} unique slot${midiSlots.size === 1 ? '' : 's'} captured`
              : mode === 'osc-scene-for-instrument'
                ? selectedExistingTemplateId
                  ? (() => {
                      const tpl = poolTemplates.find(
                        (t) => t.id === selectedExistingTemplateId
                      )
                      return tpl
                        ? `${tpl.functions.length} Parameter${tpl.functions.length === 1 ? '' : 's'} on "${tpl.name}"`
                        : 'No instrument selected'
                    })()
                  : 'No instrument selected'
                : selectedDevice
                  ? (() => {
                      const kept =
                        selectedDevice.addresses.length - removedPaths.size
                      return `${kept} address${kept === 1 ? '' : 'es'} kept${
                        removedPaths.size > 0
                          ? ` (${removedPaths.size} removed)`
                          : ''
                      }`
                    })()
                  : 'No device selected'}
          </span>
          <div className="flex-1" />
          <button className="btn text-[11px]" onClick={onClose}>
            Cancel
          </button>
          <button
            className="btn-accent text-[11px]"
            onClick={commitSave}
            disabled={
              !name.trim() ||
              (mode === 'midi-instrument'
                ? midiSlots.size === 0
                : mode === 'osc-scene-for-instrument'
                  ? !selectedExistingTemplateId
                  : !selectedDevice ||
                    selectedDevice.addresses.length - removedPaths.size === 0)
            }
            title="Save the capture to the Pool / Scenes library"
          >
            Save
          </button>
        </div>
        {/* Suppress unused-warning for sessionRef — we read it to
            keep the popup re-rendering when the session changes
            (e.g. another window adding a Pool entry while the
            popup is open). */}
        {void sessionRef}
      </div>
    </div>,
    document.body
  )
}

function ModeButton({
  active,
  label,
  hint,
  onClick
}: {
  active: boolean
  label: string
  hint: string
  onClick: () => void
}): JSX.Element {
  return (
    <button
      type="button"
      className={`flex flex-col items-start text-left gap-1 px-2 py-1.5 rounded border transition-colors ${
        active
          ? 'bg-accent text-black border-accent'
          : 'border-border bg-panel2 hover:bg-panel3'
      }`}
      onClick={onClick}
    >
      <span className="text-[11px] font-semibold leading-tight">{label}</span>
      <span
        className={`text-[9px] leading-snug ${active ? 'text-black/70' : 'text-muted'}`}
      >
        {hint}
      </span>
    </button>
  )
}

function OscCaptureBody({
  devices,
  status,
  selectedDeviceId,
  onSelect,
  removedPaths,
  onRemovePath,
  onRestorePath,
  addrBoxHeight,
  onResizeAddrBox
}: {
  devices: DiscoveredOscDevice[]
  status: import('@shared/types').NetworkListenerStatus
  selectedDeviceId: string
  onSelect: (id: string) => void
  removedPaths: Set<string>
  onRemovePath: (path: string) => void
  onRestorePath: (path: string) => void
  addrBoxHeight: number
  onResizeAddrBox: (h: number) => void
}): JSX.Element {
  const selected = devices.find((d) => d.id === selectedDeviceId)
  return (
    <div className="flex flex-col gap-2">
      {/* Listener status hint */}
      {!status.enabled && (
        <div className="text-[10px] text-danger">
          The passive OSC listener is starting on port {status.port}…
          Make sure your device is sending to{' '}
          <span className="font-mono">
            {status.localAddresses[0] ?? '<local-ip>'}:{status.port}
          </span>
          .
        </div>
      )}
      {status.enabled && devices.length === 0 && (
        <div className="text-[10px] text-muted">
          Listening on port {status.port}. Waiting for incoming OSC
          packets — start your hardware / patch sending now.
        </div>
      )}
      {/* Device picker */}
      <label className="flex items-center gap-2">
        <span className="label">Device</span>
        <select
          className="input flex-1 text-[12px] min-w-0"
          value={selectedDeviceId}
          onChange={(e) => onSelect(e.target.value)}
          disabled={devices.length === 0}
        >
          {devices.length === 0 && <option value="">— no devices yet —</option>}
          {devices.map((d) => (
            <option key={d.id} value={d.id}>
              {d.id} · {d.addresses.length} addr · {d.packetCount} pkt
            </option>
          ))}
        </select>
      </label>
      {/* Address preview — resizable height so the user can pull it
          taller to see all values for many-address devices. Each row
          shows the FULL multi-arg payload from the last-seen packet
          (not the 4-arg truncated preview), with per-arg type tags
          so the user can verify what's actually arriving. Updates
          live as packets flow in. */}
      {selected && (
        <div className="relative flex flex-col">
          <div
            className="overflow-y-auto font-mono text-[11px] border border-border rounded p-1 bg-panel2"
            style={{ height: addrBoxHeight }}
          >
            {selected.addresses.length === 0 ? (
              <span className="text-muted text-[10px] p-1">
                No addresses captured yet. Wiggle a control.
              </span>
            ) : (
              selected.addresses
                .slice()
                .sort((a, b) => a.path.localeCompare(b.path))
                .map((a) => (
                  <CaptureAddressRow
                    key={a.path}
                    addr={a}
                    removed={removedPaths.has(a.path)}
                    onRemove={() => onRemovePath(a.path)}
                    onRestore={() => onRestorePath(a.path)}
                  />
                ))
            )}
          </div>
          {/* Bottom-edge resize handle — drag DOWN to grow the box. */}
          <ResizeHandle
            direction="row"
            value={addrBoxHeight}
            onChange={onResizeAddrBox}
            min={120}
            max={700}
            className="absolute bottom-[-2px] left-0 right-0 h-[4px] cursor-row-resize"
            title="Drag to resize the address list"
          />
        </div>
      )}
    </div>
  )
}

// Live row in the Capture popup's address list — renders the FULL
// multi-arg payload from the last-seen packet, one chip per arg with
// type-tag colouring (s = string, i = int, f/d = float, T/F = bool,
// N = nil, b = blob). Updates as the main process pushes fresh
// DiscoveredOscDevice snapshots into the store. Includes per-arg
// chips so the user can verify the bundle shape at a glance even
// for 8+ arg OCTOCOSME-style messages.
function CaptureAddressRow({
  addr,
  removed,
  onRemove,
  onRestore
}: {
  addr: DiscoveredOscAddress
  removed: boolean
  onRemove: () => void
  onRestore: () => void
}): JSX.Element {
  // Freshness: how long since the last packet hit this address. Drives
  // the dot colour so the user can tell which addresses are LIVE vs
  // stale (e.g. a knob they touched once a minute ago).
  const ageMs = Date.now() - addr.lastSeen
  const fresh = ageMs < 500
  const dotColor = fresh
    ? 'rgb(var(--c-success))'
    : ageMs < 3000
      ? 'rgb(var(--c-accent))'
      : 'rgb(var(--c-muted) / 0.5)'
  return (
    <div
      className={`flex items-start gap-2 px-1 py-0.5 ${
        removed ? 'opacity-40 line-through' : 'hover:bg-panel3/60'
      }`}
      title={`${addr.argTypes.join('') || '∅'} · ${addr.count} packets · last seen ${Math.round(ageMs)} ms ago`}
    >
      {/* Freshness dot. */}
      <span
        className="inline-block w-1.5 h-1.5 rounded-full shrink-0 mt-1.5"
        style={{ background: dotColor }}
      />
      {/* Path. */}
      <span className="truncate text-[11px] shrink-0 min-w-[160px] max-w-[260px]">
        {addr.path}
      </span>
      {/* Type-tag badge. */}
      <span className="text-[9px] text-muted shrink-0 px-1 rounded-sm border border-border mt-0.5">
        {addr.argTypes.join('') || '∅'}
      </span>
      {/* Full arg list — one chip per slot. Wraps to multiple lines
          for long bundles (12-float OCTOCOSME pots etc.). */}
      <div className="flex flex-wrap gap-1 flex-1 min-w-0">
        {(addr.argValues ?? []).map((a, i) => (
          <ArgChip key={i} type={a.type} value={a.value} />
        ))}
        {(!addr.argValues || addr.argValues.length === 0) && (
          <span className="text-muted text-[10px]">{addr.argsPreview}</span>
        )}
      </div>
      {/* Packet count + remove button. */}
      <span
        className="text-[9px] text-muted shrink-0 tabular-nums mt-0.5"
        title={`${addr.count} packets seen`}
      >
        ×{addr.count}
      </span>
      <button
        className={`shrink-0 w-4 h-4 leading-none flex items-center justify-center rounded text-[12px] mt-0.5 ${
          removed
            ? 'text-muted hover:text-text'
            : 'text-muted hover:text-danger'
        }`}
        title={
          removed
            ? 'Restore this address to the capture'
            : 'Remove this address from the capture'
        }
        onClick={() => (removed ? onRestore() : onRemove())}
      >
        {removed ? '↺' : '×'}
      </button>
    </div>
  )
}

// One arg slot rendered as a tiny chip with type-coloured borders.
// String args get quoted; bools render as T/F; floats round to 3 decimals
// (the underlying capture keeps full precision — display only).
function ArgChip({
  type,
  value
}: {
  type: string
  value: number | string | boolean | null
}): JSX.Element {
  let body: string
  let color: string
  if (type === 's') {
    body = `"${String(value).slice(0, 24)}"`
    color = 'rgb(var(--c-accent2))'
  } else if (type === 'i') {
    body = String(value)
    color = 'rgb(var(--c-accent))'
  } else if (type === 'T') {
    body = 'true'
    color = 'rgb(var(--c-success))'
  } else if (type === 'F') {
    body = 'false'
    color = 'rgb(var(--c-muted))'
  } else if (type === 'N') {
    body = 'nil'
    color = 'rgb(var(--c-muted))'
  } else if (type === 'b') {
    body = '[blob]'
    color = 'rgb(var(--c-muted))'
  } else if (type === 'f' || type === 'd') {
    const n = typeof value === 'number' ? value : Number(value)
    body = Number.isFinite(n) ? n.toFixed(3) : String(value)
    color = 'rgb(var(--c-text))'
  } else {
    body = String(value)
    color = 'rgb(var(--c-muted))'
  }
  return (
    <span
      className="font-mono text-[10px] tabular-nums px-1 py-px rounded border whitespace-nowrap"
      style={{ borderColor: color, color }}
      title={`${type}: ${value}`}
    >
      {body}
    </span>
  )
}

// Row variant for the "New Scene for Instrument" mode. Like
// `CaptureAddressRow` but driven by a Pool Function (the user picked
// a known Instrument), with the matched `DiscoveredOscAddress`
// folded in when traffic exists. When no packet has arrived yet for
// this Parameter, the chips list is empty and a muted "(no traffic
// yet)" placeholder takes its place — but the row layout matches
// `CaptureAddressRow` so the two modes feel identical.
function SceneForInstrumentRow({
  paramName,
  resolvedPath,
  match
}: {
  paramName: string
  resolvedPath: string
  match: DiscoveredOscAddress | null
}): JSX.Element {
  const ageMs = match ? Date.now() - match.lastSeen : Infinity
  const fresh = ageMs < 500
  const dotColor = match
    ? fresh
      ? 'rgb(var(--c-success))'
      : ageMs < 3000
        ? 'rgb(var(--c-accent))'
        : 'rgb(var(--c-muted) / 0.5)'
    : 'rgb(var(--c-muted) / 0.3)'
  return (
    <div
      className="flex items-start gap-2 px-1 py-0.5 hover:bg-panel3/60"
      title={`${match?.argTypes.join('') || 'no traffic seen'} · ${
        match ? `${match.count} packets · last seen ${Math.round(ageMs)} ms ago` : ''
      }`}
    >
      {/* Freshness dot — grey-faded when no traffic has been seen
          for this Parameter at all (helps the user spot Parameters
          that haven't been touched yet). */}
      <span
        className="inline-block w-1.5 h-1.5 rounded-full shrink-0 mt-1.5"
        style={{ background: dotColor }}
      />
      {/* Param name + resolved path in muted small text underneath.
          Two-line layout because the path may be long. */}
      <div className="flex flex-col min-w-[160px] max-w-[260px] shrink-0">
        <span className="truncate text-[11px]">{paramName}</span>
        <span className="text-[9px] text-muted truncate">{resolvedPath}</span>
      </div>
      <span className="text-[9px] text-muted shrink-0 px-1 rounded-sm border border-border mt-0.5">
        {match?.argTypes.join('') || '—'}
      </span>
      <div className="flex flex-wrap gap-1 flex-1 min-w-0">
        {match && (match.argValues ?? []).length > 0 ? (
          (match.argValues ?? []).map((a, i) => (
            <ArgChip key={i} type={a.type} value={a.value} />
          ))
        ) : (
          <span className="text-muted text-[10px]">
            {match?.argsPreview || '(no traffic yet)'}
          </span>
        )}
      </div>
      {match && (
        <span
          className="text-[9px] text-muted shrink-0 tabular-nums mt-0.5"
          title={`${match.count} packets seen`}
        >
          ×{match.count}
        </span>
      )}
    </div>
  )
}

// Body for 'osc-scene-for-instrument' mode — picks an existing Pool
// Instrument and lists its functions side-by-side with the latest
// observed value from each matching network address. The Save action
// snapshots those values as a new SavedScene (the resulting Scene
// references the existing Instrument by id, no new Pool entry).
function SceneForInstrumentBody({
  templates,
  selectedTemplateId,
  onSelectTemplate,
  devices,
  status,
  addrBoxHeight,
  onResizeAddrBox
}: {
  templates: InstrumentTemplate[]
  selectedTemplateId: string
  onSelectTemplate: (id: string) => void
  devices: DiscoveredOscDevice[]
  status: import('@shared/types').NetworkListenerStatus
  addrBoxHeight: number
  onResizeAddrBox: (h: number) => void
}): JSX.Element {
  const tpl = templates.find((t) => t.id === selectedTemplateId)
  // Walk every function on the picked template and try to find the
  // matching DiscoveredOscAddress (across ALL listening devices).
  // Falls back to the unresolved path display + "no traffic" if no
  // device has emitted to that address yet.
  const rows = (tpl?.functions ?? []).map((fn) => {
    const base = tpl?.oscAddressBase ?? ''
    const path = fn.oscPath ?? ''
    const resolved = path.startsWith('/')
      ? path
      : (base.endsWith('/') ? base.slice(0, -1) : base) + '/' + path
    let match: DiscoveredOscAddress | null = null
    for (const dev of devices) {
      const addr = dev.addresses.find(
        (a) =>
          a.path === resolved ||
          a.path.endsWith(resolved) ||
          a.path.endsWith('/' + fn.oscPath)
      )
      if (addr) {
        match = addr
        break
      }
    }
    return { fn, resolved, match }
  })
  return (
    <div className="flex flex-col gap-2">
      {!status.enabled && (
        <div className="text-[10px] text-danger">
          The passive OSC listener is starting on port {status.port}…
        </div>
      )}
      <label className="flex items-center gap-2">
        <span className="label">Instrument</span>
        <select
          className="input flex-1 text-[12px] min-w-0"
          value={selectedTemplateId}
          onChange={(e) => onSelectTemplate(e.target.value)}
          disabled={templates.length === 0}
        >
          {templates.length === 0 && (
            <option value="">— no instruments in the Pool —</option>
          )}
          {templates
            .filter((t) => !t.draft)
            .map((t) => (
              <option key={t.id} value={t.id}>
                {t.builtin ? '[Built-in] ' : ''}
                {t.name} · {t.functions.length} param
                {t.functions.length === 1 ? '' : 's'}
              </option>
            ))}
        </select>
      </label>
      {tpl && (
        <div className="relative flex flex-col">
          <div
            className="overflow-y-auto font-mono text-[11px] border border-border rounded p-1 bg-panel2"
            style={{ height: addrBoxHeight }}
          >
            {rows.length === 0 ? (
              <span className="text-muted text-[10px] p-1">
                This instrument has no Parameters.
              </span>
            ) : (
              rows.map(({ fn, resolved, match }) => (
                <SceneForInstrumentRow
                  key={fn.id}
                  paramName={fn.name}
                  resolvedPath={resolved}
                  match={match}
                />
              ))
            )}
          </div>
          <ResizeHandle
            direction="row"
            value={addrBoxHeight}
            onChange={onResizeAddrBox}
            min={120}
            max={700}
            className="absolute bottom-[-2px] left-0 right-0 h-[4px] cursor-row-resize"
            title="Drag to resize the parameter list"
          />
        </div>
      )}
      <span className="text-[10px] text-muted">
        Save will create a new entry in the Pool's Scenes tab,
        referencing this Instrument and seeded with each Parameter's
        currently-observed value. Drag it onto the grid when you want
        to use it.
      </span>
    </div>
  )
}

function MidiCaptureBody({
  slots,
  onClear
}: {
  slots: CapturedMidiSlot[]
  onClear: () => void
}): JSX.Element {
  // Sort: CCs first (by ch then number), then Notes (same order).
  const sorted = slots.slice().sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === 'cc' ? -1 : 1
    if (a.channel !== b.channel) return a.channel - b.channel
    return a.number - b.number
  })
  return (
    <div className="flex flex-col gap-2">
      <div className="text-[10px] text-muted leading-snug">
        Wiggle every knob + press every button / pad you want captured.
        Each unique <span className="font-mono">CC#</span> /{' '}
        <span className="font-mono">note</span> becomes a Parameter on
        the resulting Instrument, pre-wired to fire MIDI back through
        the same channel + number.
      </div>
      <div className="flex items-center gap-2">
        <span className="text-[10px] text-muted">
          {slots.length} captured slot{slots.length === 1 ? '' : 's'}
        </span>
        <div className="flex-1" />
        <button
          className="btn text-[10px] py-0.5 px-1.5"
          onClick={onClear}
          disabled={slots.length === 0}
          title="Empty the capture buffer and start over"
        >
          Clear
        </button>
      </div>
      <div className="flex flex-col gap-0.5 max-h-72 overflow-y-auto font-mono text-[11px] border border-border rounded p-1 bg-panel2">
        {sorted.length === 0 ? (
          <span className="text-muted text-[10px] p-1">
            Listening for MIDI… wiggle a knob or press a pad.
          </span>
        ) : (
          sorted.map((s) => (
            <div
              key={`${s.kind}|${s.channel}|${s.number}`}
              className="flex items-center gap-2 px-1 py-0.5 hover:bg-panel3/60"
              title={`${s.count} events seen · last value ${s.lastValue}`}
            >
              <span
                className={`shrink-0 w-10 text-[10px] ${
                  s.kind === 'cc' ? 'text-accent2' : 'text-accent'
                }`}
              >
                {s.kind === 'cc' ? 'CC' : 'Note'}
              </span>
              <span className="shrink-0 w-10 text-muted">ch{s.channel}</span>
              <span className="shrink-0 w-12 tabular-nums">
                {s.kind === 'cc' ? `${s.number}` : noteName(s.number)}
              </span>
              <span className="text-muted tabular-nums w-12">
                = {s.lastValue}
              </span>
              <div className="flex-1" />
              <span className="text-[9px] text-muted tabular-nums">
                ×{s.count}
              </span>
            </div>
          ))
        )}
      </div>
    </div>
  )
}

// ── Builders ─────────────────────────────────────────────────────

function buildOscTemplate(
  name: string,
  dev: DiscoveredOscDevice,
  removedPaths: Set<string> = new Set()
): InstrumentTemplate {
  // Filter out the X-removed addresses BEFORE any further work so
  // root-detection + the resulting Function set match what the user
  // saw in the preview list.
  const keptAddresses = dev.addresses.filter((a) => !removedPaths.has(a.path))
  const rootCounts = new Map<string, number>()
  for (const a of keptAddresses) {
    const m = /^\/?([^/]+)/.exec(a.path)
    if (m) rootCounts.set(m[1], (rootCounts.get(m[1]) ?? 0) + 1)
  }
  let bestRoot = ''
  let bestN = 0
  rootCounts.forEach((n, root) => {
    if (n > bestN) {
      bestN = n
      bestRoot = root
    }
  })
  const useRoot = bestN > 0 && bestN >= Math.ceil(keptAddresses.length / 2)
  const oscBase = useRoot ? `/${bestRoot}` : ''
  const escapedBest = bestRoot.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const functions: InstrumentFunction[] = keptAddresses.map((addr) => {
    let oscPath = addr.path
    if (useRoot) {
      // Path is under the dominant root — strip the root prefix
      // so the Function holds a relative path (joined back via
      // `oscAddressBase` at send time). A path that DOESN'T match
      // the root keeps its absolute form (starts with /), which
      // `resolveOsc` then passes through unchanged.
      const stripped = oscPath.replace(
        new RegExp(`^/?${escapedBest}/?`),
        ''
      )
      // Replace consumed → keep stripped. Replace yielded same
      // string (no match) → leave absolute path WITH its leading /
      // so the engine treats it as fully qualified.
      if (stripped !== oscPath) {
        oscPath = stripped || bestRoot
      }
    }
    // Capture treats EVERY path that didn't match the root as
    // absolute (keeps the leading /). Previously the no-root branch
    // stripped the / unconditionally, which broke paths like
    // `/touches`, `/switches_change`, `/touches_change` that don't
    // share any other root — they showed up as `touches` in the
    // Inspector with no leading slash, and the engine resolved them
    // against an empty base which still worked, but read as a bug
    // to the user inspecting the captured Instrument.
    //
    // Parameter name == FULL OSC address (e.g. `/A/strips/pots`).
    // Previously we picked the last path segment ("Pots"), which lost
    // grouping for senders with /A/.../pots vs /B/.../pots etc.
    // Using the full path makes each captured Parameter uniquely
    // labelled in the sidebar + inspector without further work.
    const niceName = addr.path
    // Multi-arg addresses (OCTOCOSME-style siffffff = string + int
    // + 6 floats) need an argSpec[] so the engine knows which
    // tokens are fixed prefixes and which are user-controllable
    // values. Single-arg addresses use the old inferParamTypeFromArgTypes
    // path — no argSpec means the engine streams a single value.
    const argSpec = addr.argTypes.length > 1 ? buildArgSpecFromAddress(addr) : undefined
    const editableSpecs = argSpec?.filter((a) => a.fixed === undefined) ?? []
    const paramType: InstrumentFunction['paramType'] =
      argSpec && argSpec.length > 1
        ? // For multi-arg: prefer 'float' (the engine handles the
          //  multi-value bundle via argSpec). 'v2'/'v3'/'v4' would
          //  also work but lose the per-slot pin behaviour.
          'float'
        : inferParamTypeFromArgTypes(addr.argTypes)
    // Seed init from the FIRST editable arg (so a freshly-instantiated
    // cell uses the captured value, not 0). For multi-arg the engine
    // reads each slot's `init` from argSpec anyway, but this keeps
    // the Function-level `init` in sync for the inspector display.
    const seedInit =
      editableSpecs.length > 0 && typeof editableSpecs[0].init === 'number'
        ? editableSpecs[0].init
        : 0
    return {
      id: `fn_cap_${Math.random().toString(36).slice(2, 9)}`,
      name: niceName,
      oscPath,
      paramType,
      nature: 'lin',
      streamMode: 'streaming',
      min: 0,
      max: paramType === 'bool' ? 1 : 1,
      init: seedInit,
      argSpec
    }
  })
  return {
    id: `tpl_user_${Math.random().toString(36).slice(2, 9)}`,
    name,
    description: `Captured from ${dev.ip}:${dev.port} — ${keptAddresses.length} address${
      keptAddresses.length === 1 ? '' : 'es'
    }.`,
    color: pickColor(name),
    destIp: dev.ip,
    // Mirror the device's own source port back to it as the
    // destination. OSC devices that listen + send on the same
    // socket (Teensy, TouchOSC, most installations) want messages
    // routed to that port. The user can override afterwards in the
    // Pool Inspector if their listen port differs from their send
    // port. Previously hardcoded to 9000, which broke Captures from
    // any device not configured for the canonical inbox.
    destPort: dev.port,
    oscAddressBase: oscBase,
    voices: 1,
    builtin: false,
    functions
  }
}

// Derive the cell.value string to seed onto a newly-instantiated
// cell from a captured OSC address. The cell stores tokens
// POSITIONALLY — index i in cell.value maps to argSpec[i] — so we
// emit a token for EVERY slot, including the `fixed` protocol
// prefixes (Inspector's `tokensWithDefaults` re-coerces them to
// their declared values on every read, but having the placeholders
// in cell.value keeps the editable values at the right indices).
// The clip-tile display strips fixed tokens cosmetically; the
// underlying value carries them.
function cellValueFromAddr(
  addr: DiscoveredOscAddress,
  fn: InstrumentFunction
): string {
  const argSpec = fn.argSpec
  if (argSpec && argSpec.length > 1) {
    const out: string[] = []
    for (let s = 0; s < argSpec.length; s++) {
      const spec = argSpec[s]
      if (spec.fixed !== undefined) {
        // Fixed slot — emit the declared value as the placeholder.
        out.push(
          typeof spec.fixed === 'boolean'
            ? spec.fixed ? '1' : '0'
            : String(spec.fixed)
        )
        continue
      }
      const v = addr.argValues?.[s]?.value
      if (typeof v === 'number') out.push(String(v))
      else if (typeof v === 'string') out.push(v)
      else if (typeof v === 'boolean') out.push(v ? '1' : '0')
      else out.push('0')
    }
    return out.join(' ')
  }
  // Single-arg branch — argValues is more reliable than argsPreview
  // (which truncates after 4 args and quotes strings with `"…"`).
  const v0 = addr.argValues?.[0]?.value
  if (typeof v0 === 'number') return String(v0)
  if (typeof v0 === 'string') return v0
  if (typeof v0 === 'boolean') return v0 ? '1' : '0'
  if (addr.argsPreview) {
    const firstToken = addr.argsPreview.split(/\s+/)[0]
    return firstToken.replace(/^"|"$/g, '')
  }
  return '0'
}

// Build a ParamArgSpec[] for a multi-arg observed address. Every
// arg becomes an EDITABLE `Value N` slot whose type matches the
// observed OSC tag and whose init is the last-seen value. No
// auto-pinning — the user pins any protocol-prefix slots they want
// fixed (typically the leading string/IP and sequence-int for
// OCTOCOSME-style senders) from the Pool Inspector's Arg Layout
// section. Picking the wrong slot to pin used to require a
// roundtrip through the Inspector anyway; keeping pinning manual
// gives the user clean Value 1..N slots straight out of Capture.
function buildArgSpecFromAddress(addr: DiscoveredOscAddress): ParamArgSpec[] {
  const out: ParamArgSpec[] = []
  for (let i = 0; i < addr.argTypes.length; i++) {
    const t = addr.argTypes[i]
    const isFloat = t === 'f' || t === 'd'
    const v = addr.argValues?.[i]?.value
    const specType: ParamArgSpec['type'] = isFloat
      ? 'float'
      : t === 'i'
        ? 'int'
        : t === 's'
          ? 'string'
          : 'bool'
    const initVal: number | string | boolean =
      typeof v === 'number' || typeof v === 'string' || typeof v === 'boolean'
        ? v
        : isFloat || t === 'i'
          ? 0
          : t === 's'
            ? ''
            : false
    out.push({
      name: `Value ${i + 1}`,
      type: specType,
      init: initVal,
      min: 0,
      max: 1
    })
  }
  return out
}

function buildMidiTemplate(
  name: string,
  slots: CapturedMidiSlot[]
): InstrumentTemplate {
  // Sort CCs first then notes (same as the UI preview), so the
  // resulting Pool template lists Parameters in an order that
  // matches what the user saw while capturing.
  const sorted = slots.slice().sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === 'cc' ? -1 : 1
    if (a.channel !== b.channel) return a.channel - b.channel
    return a.number - b.number
  })
  const functions: InstrumentFunction[] = sorted.map((s) => {
    const labelKind = s.kind === 'cc' ? 'CC' : 'Note'
    const labelNum =
      s.kind === 'cc' ? `${s.number}` : noteName(s.number)
    const midiOut: MidiOut = {
      enabled: true,
      portName: '', // user picks the OUTPUT port per cell
      channel: s.channel,
      kind: s.kind,
      cc: s.kind === 'cc' ? s.number : undefined,
      noteMode: 'velocity',
      gateLengthMs: s.kind === 'note' ? 80 : 0
    }
    return {
      id: `fn_cap_${Math.random().toString(36).slice(2, 9)}`,
      name: `${labelKind} ${labelNum} ch${s.channel}`,
      oscPath:
        s.kind === 'cc'
          ? `cc/${s.channel}/${s.number}`
          : `note/${s.channel}/${s.number}`,
      paramType: 'int',
      nature: 'lin',
      streamMode: s.kind === 'cc' ? 'streaming' : 'discrete',
      min: 0,
      max: 127,
      init: s.kind === 'cc' ? s.lastValue : s.number,
      unit: s.kind === 'cc' ? 'CC' : 'note',
      midiOut
    }
  })
  return {
    id: `tpl_user_${Math.random().toString(36).slice(2, 9)}`,
    name,
    description: `Captured from MIDI input — ${slots.length} slot${slots.length === 1 ? '' : 's'}.`,
    color: pickColor(name),
    destIp: '127.0.0.1',
    destPort: 9000,
    oscAddressBase: '',
    voices: 1,
    builtin: false,
    functions
  }
}

function addTemplateToPool(
  setStore: (
    fn:
      | ((s: ReturnType<typeof useStore.getState>) => Partial<ReturnType<typeof useStore.getState>>)
      | Partial<ReturnType<typeof useStore.getState>>
  ) => void,
  tpl: InstrumentTemplate
): void {
  setStore((s) => ({
    session: {
      ...s.session,
      pool: { ...s.session.pool, templates: [...s.session.pool.templates, tpl] }
    },
    poolSelection: { kind: 'template', templateId: tpl.id }
  }))
}

// Save the captured device as BOTH an Instrument in the Pool AND a
// reusable Scene in the saved-scene library — but do NOT add it to
// the current session's grid (sidebar tracks + scene column). The
// user drags the new Scene from the Pool's Scenes tab onto the grid
// when they want it, exactly like any other saved Scene.
//
// Previous behaviour auto-instantiated on save, which surprised the
// user: dropping a capture immediately reshuffled their working
// session's layout. Saving to the library is the conservative path —
// the capture lives in the Pool until the user explicitly drops it.
async function saveOscCaptureAsLibraryScene(
  setStore: (
    fn: (s: ReturnType<typeof useStore.getState>) => Partial<ReturnType<typeof useStore.getState>>
  ) => void,
  tpl: InstrumentTemplate,
  dev: DiscoveredOscDevice,
  sceneName: string
): Promise<void> {
  // Build the SavedScene payload (tracks + cells live INSIDE the
  // SavedScene, not in session.tracks/scenes). instantiateSavedScene
  // later recreates them as a new column when the user drags it.
  const headerRowId = `t_${Math.random().toString(36).slice(2, 9)}`
  const headerRow: Track = {
    id: headerRowId,
    name: tpl.name,
    kind: 'template',
    sourceTemplateId: tpl.id,
    defaultOscAddress: tpl.oscAddressBase,
    defaultDestIp: tpl.destIp,
    defaultDestPort: tpl.destPort
  }
  const childRows: Track[] = tpl.functions.map((fn) => {
    const base = tpl.oscAddressBase ?? ''
    const path = fn.oscPath ?? ''
    const resolvedOsc = path.startsWith('/')
      ? path
      : (base.endsWith('/') ? base.slice(0, -1) : base) + '/' + path
    return {
      id: `t_${Math.random().toString(36).slice(2, 9)}`,
      name: fn.name,
      kind: 'function',
      parentTrackId: headerRowId,
      sourceTemplateId: tpl.id,
      sourceFunctionId: fn.id,
      defaultOscAddress: resolvedOsc,
      defaultDestIp: tpl.destIp,
      defaultDestPort: tpl.destPort
    }
  })
  const cells: Record<string, Cell> = {}
  for (let i = 0; i < tpl.functions.length; i++) {
    const fn = tpl.functions[i]
    const childRow = childRows[i]
    const addr = dev.addresses.find((a) =>
      a.path.endsWith(fn.oscPath) ||
      a.path.endsWith(`/${fn.oscPath}`) ||
      a.path === fn.oscPath
    )
    const cell = makeCell({
      destIp: childRow.defaultDestIp!,
      destPort: childRow.defaultDestPort!,
      oscAddress: childRow.defaultOscAddress!
    })
    cell.destLinkedToDefault = false
    cell.addressLinkedToDefault = false
    if (addr) {
      // For multi-arg Parameters, write the EDITABLE-slot tokens
      // (skipping pinned protocol prefixes like an IP-string). The
      // engine re-prepends fixed tokens at send time. Without this
      // the cell ended up holding e.g. "192.168.101.191" (the
      // captured IP string from /A/strips/pots' first arg) and the
      // user saw their captured Scene playing back the IP instead
      // of the actual float values.
      cell.value = cellValueFromAddr(addr, fn)
    }
    cells[childRow.id] = cell
  }
  // Give every captured Scene a fresh random colour so the grid stays
  // visually distinct after multiple captures. The Pool entry itself
  // (the Instrument tpl) keeps its name-derived deterministic colour so
  // re-capturing the same device produces a recognisable template, but
  // every saved-scene snapshot gets a new colour — composers usually
  // want to read each captured moment as a separate musical event.
  const sceneColor = randomSceneColor()
  const saved: import('@shared/types').SavedScene = {
    id: `scn_lib_${Math.random().toString(36).slice(2, 9)}`,
    name: sceneName,
    color: sceneColor,
    createdAt: Date.now(),
    origin: 'capture-osc',
    templates: [tpl],
    tracks: [headerRow, ...childRows],
    cells,
    sceneMeta: {
      name: sceneName,
      color: sceneColor,
      notes: `Captured from ${dev.ip}:${dev.port}`,
      durationSec: 8,
      nextMode: 'stop',
      multiplicator: 1
    }
  }
  // Add the Instrument to the Pool synchronously — the user wants
  // to see it in the Pool's Built-in/User tab right away. The
  // Scene push to disk is async (atomic write) but the in-memory
  // sceneLibrary list updates via the main → renderer push channel.
  setStore((s) => ({
    session: {
      ...s.session,
      pool: { ...s.session.pool, templates: [...s.session.pool.templates, tpl] }
    },
    poolSelection: { kind: 'template', templateId: tpl.id }
  }))
  try {
    await window.api?.sceneLibrarySave?.(saved)
  } catch (e) {
    console.error('[Capture] saveSceneLibrary failed:', (e as Error).message)
  }
}

// Snapshot the currently-observed OSC values flowing into an EXISTING
// Pool instrument as a new SavedScene. No new Pool entry is created —
// the SavedScene references the existing Instrument by id. On
// instantiation later, the user gets fresh tracks + cells pre-filled
// with the values that were live at capture time.
async function saveSceneForExistingInstrument(
  setStore: (
    fn: (s: ReturnType<typeof useStore.getState>) => Partial<ReturnType<typeof useStore.getState>>
  ) => void,
  templateId: string,
  devices: DiscoveredOscDevice[],
  sceneName: string
): Promise<void> {
  const st = useStore.getState()
  const tpl = st.session.pool.templates.find((t) => t.id === templateId)
  if (!tpl) return
  // Build fresh track ids (one header + one child per function) so
  // the SavedScene reconstructs cleanly via instantiateSavedScene's
  // remapping logic.
  const headerRowId = `t_${Math.random().toString(36).slice(2, 9)}`
  const headerRow: Track = {
    id: headerRowId,
    name: tpl.name,
    kind: 'template',
    sourceTemplateId: tpl.id,
    defaultOscAddress: tpl.oscAddressBase,
    defaultDestIp: tpl.destIp,
    defaultDestPort: tpl.destPort
  }
  const childRows: Track[] = tpl.functions.map((fn) => {
    const base = tpl.oscAddressBase ?? ''
    const path = fn.oscPath ?? ''
    const resolvedOsc = path.startsWith('/')
      ? path
      : (base.endsWith('/') ? base.slice(0, -1) : base) + '/' + path
    return {
      id: `t_${Math.random().toString(36).slice(2, 9)}`,
      name: fn.name,
      kind: 'function',
      parentTrackId: headerRowId,
      sourceTemplateId: tpl.id,
      sourceFunctionId: fn.id,
      defaultOscAddress: resolvedOsc,
      defaultDestIp: tpl.destIp,
      defaultDestPort: tpl.destPort
    }
  })
  const cells: Record<string, Cell> = {}
  for (let i = 0; i < tpl.functions.length; i++) {
    const fn = tpl.functions[i]
    const childRow = childRows[i]
    // Hunt across ALL listening devices for an address that matches
    // this function's resolved OSC path — capture mode for an
    // existing instrument is sender-agnostic (the user may have
    // multiple senders feeding the same instrument).
    let match: DiscoveredOscAddress | null = null
    for (const dev of devices) {
      const addr = dev.addresses.find(
        (a) =>
          a.path === childRow.defaultOscAddress ||
          a.path.endsWith(childRow.defaultOscAddress!) ||
          a.path.endsWith('/' + fn.oscPath) ||
          a.path === fn.oscPath
      )
      if (addr) {
        match = addr
        break
      }
    }
    const cell = makeCell({
      destIp: childRow.defaultDestIp!,
      destPort: childRow.defaultDestPort!,
      oscAddress: childRow.defaultOscAddress!
    })
    cell.destLinkedToDefault = false
    cell.addressLinkedToDefault = false
    if (match) {
      cell.value = cellValueFromAddr(match, fn)
    }
    cells[childRow.id] = cell
  }
  // Random scene colour per capture — same rationale as the
  // "new Instrument + Scene" mode above: distinct snapshots want
  // distinct colours, the Instrument template's own colour is
  // independent of the per-capture moment.
  const sceneColor = randomSceneColor()
  const saved: import('@shared/types').SavedScene = {
    id: `scn_lib_${Math.random().toString(36).slice(2, 9)}`,
    name: sceneName,
    color: sceneColor,
    createdAt: Date.now(),
    origin: 'capture-osc',
    // No new templates — the existing one stays in the Pool. Empty
    // array is fine; instantiateSavedScene re-uses pool templates
    // referenced by sourceTemplateId.
    templates: [],
    tracks: [headerRow, ...childRows],
    cells,
    sceneMeta: {
      name: sceneName,
      color: sceneColor,
      notes: `Captured for ${tpl.name}`,
      durationSec: 8,
      nextMode: 'stop',
      multiplicator: 1
    }
  }
  try {
    await window.api?.sceneLibrarySave?.(saved)
  } catch (e) {
    console.error('[Capture] sceneLibrarySave failed:', (e as Error).message)
  }
  // Suppress unused-warning in case the setStore param is dropped
  // by a future refactor — currently we don't need to mutate the
  // store here because the saved scene push back arrives via IPC.
  void setStore
}

// ── Misc helpers ─────────────────────────────────────────────────

function defaultOscName(dev: DiscoveredOscDevice): string {
  // Lift the most-common root path segment as the suggested name.
  const rootCounts = new Map<string, number>()
  for (const a of dev.addresses) {
    const m = /^\/?([^/]+)/.exec(a.path)
    if (m) rootCounts.set(m[1], (rootCounts.get(m[1]) ?? 0) + 1)
  }
  let bestRoot = ''
  let bestN = 0
  rootCounts.forEach((n, root) => {
    if (n > bestN) {
      bestN = n
      bestRoot = root
    }
  })
  return bestRoot || `OSC ${dev.ip}`
}

function pickColor(seed: string): string {
  // Tiny deterministic hash → HSL → hex.
  let h = 0
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0
  const hue = h % 360
  return hslToHex(hue, 62, 56)
}

function hslToHex(h: number, s: number, l: number): string {
  s /= 100
  l /= 100
  const k = (n: number): number => (n + h / 30) % 12
  const a = s * Math.min(l, 1 - l)
  const f = (n: number): number =>
    l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)))
  const r = Math.round(f(0) * 255)
  const g = Math.round(f(8) * 255)
  const b = Math.round(f(4) * 255)
  const hex = (v: number): string => v.toString(16).padStart(2, '0')
  return `#${hex(r)}${hex(g)}${hex(b)}`
}

function noteName(n: number): string {
  const names = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']
  const octave = Math.floor(n / 12) - 1
  return `${names[n % 12]}${octave}`
}
