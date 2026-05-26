import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { buildSessionForSave, useStore, type ThemeName } from '../store'
import { midi, type MidiDevice } from '../midi'
import { BoundedNumberInput } from './BoundedNumberInput'
import { Modal } from './Modal'
import { detectMidiConflicts } from '../hooks/midiConflicts'
import type { OscForwardTarget } from '@shared/types'
import { undo, redo } from '../undo'

// Theme picker options. Order = order shown in the dropdown. New themes first.
const THEMES: { id: ThemeName; label: string }[] = [
  // Rainbow-Circuit-flavoured themes — opt into rich UI controls
  // (bespoke arc sliders, icon-row mode pickers, card-wrap inspector
  // sections, console-readout numerics).
  { id: 'nature', label: 'Nature ✦' },
  { id: 'cream', label: 'Cream ✦' },
  // Standard themes.
  { id: 'studio-dark', label: 'Studio Dark' },
  { id: 'warm-charcoal', label: 'Warm Charcoal' },
  { id: 'graphite', label: 'Graphite' },
  { id: 'paper-light', label: 'Paper Light' },
  { id: 'dark', label: 'Dark' },
  { id: 'light', label: 'Light' },
  { id: 'pastel', label: 'Pastel' },
  { id: 'reaper', label: 'Classic' },
  { id: 'smooth', label: 'Smooth' },
  { id: 'hydra', label: 'Hydra' },
  { id: 'darkside', label: 'DarkSide' },
  { id: 'solaris', label: 'Solaris' },
  { id: 'flame', label: 'Flame' },
  { id: 'analog', label: 'Analog' }
]

export default function TopBar(): JSX.Element {
  const session = useStore((s) => s.session)
  const view = useStore((s) => s.view)
  const setView = useStore((s) => s.setView)
  const setName = useStore((s) => s.setName)
  const setTickRate = useStore((s) => s.setTickRate)
  // setDefaults moved into the DefaultOscGroup helper (the only place
  // the OSC default inputs live now that the group is collapsible).
  const setMidiInputName = useStore((s) => s.setMidiInputName)
  const setSession = useStore((s) => s.setSession)
  const setCurrentFilePath = useStore((s) => s.setCurrentFilePath)
  // newSession is invoked from the App-level new-session-confirm
  // modal instead of directly here.
  const currentFilePath = useStore((s) => s.currentFilePath)
  const setGlobalBpm = useStore((s) => s.setGlobalBpm)

  const [midiDevices, setMidiDevices] = useState<MidiDevice[]>([])
  // Click-to-toggle preferences sub-toolbar (lives under the main toolbar and
  // currently houses the theme picker). Triggered by clicking the dataFLOU
  // brand label at the top-left.
  const [prefsOpen, setPrefsOpen] = useState(false)
  const theme = useStore((s) => s.theme)
  const setTheme = useStore((s) => s.setTheme)

  useEffect(() => {
    setMidiDevices(midi.listDevices())
    return midi.subscribe(setMidiDevices)
  }, [])

  function onMidiChange(name: string | null): void {
    midi.open(name)
    setMidiInputName(name)
  }

  async function onOpen(): Promise<void> {
    const res = await window.api.sessionOpen()
    if (!res) return
    // Route through requestSessionLoad so an integrity check can
    // interpose an "Auto-fix?" modal for malformed sessions. Clean
    // sessions are committed immediately with no extra click.
    useStore.getState().requestSessionLoad(res.session, res.path)
  }
  async function onSave(): Promise<void> {
    if (currentFilePath) {
      // Bundle current GUI layout into the session before save so
      // the file captures the user's chosen zoom + sizes + collapse
      // state. `setSession` on next load re-applies these via the
      // ui sub-field.
      const sess = buildSessionForSave(useStore.getState())
      const ok = await window.api.sessionSave(sess, currentFilePath)
      if (ok) flash(saveRef.current, 'flash-blue')
    } else {
      const p = await onSaveAs()
      // First-time save promotes Save As → Save; flash Save when that succeeds too.
      if (p) flash(saveRef.current, 'flash-blue')
    }
  }
  async function onSaveAs(): Promise<string | null> {
    const sess = buildSessionForSave(useStore.getState())
    const p = await window.api.sessionSaveAs(sess)
    if (p) setCurrentFilePath(p)
    return p
  }

  // One-shot flash helpers — restart animation on each click via class re-add.
  const stopAllRef = useRef<HTMLButtonElement>(null)
  const panicRef = useRef<HTMLButtonElement>(null)
  const saveRef = useRef<HTMLButtonElement>(null)
  function flash(el: HTMLElement | null, cls: 'flash-red' | 'flash-blue' = 'flash-red'): void {
    if (!el) return
    el.classList.remove(cls)
    void el.offsetWidth
    el.classList.add(cls)
  }


  return (
    <>
    <div className={`relative flex items-center gap-2 px-2 py-2 bg-panel ${prefsOpen ? '' : 'border-b border-border'}`}>
      {/* Show-mode banner — absolute so it doesn't shift the flex layout,
          centered both axes inside the toolbar band. Only rendered in
          show mode; the CSS `show-badge` class handles colors + pulse. */}
      {useStore((s) => s.showMode) && (
        <div
          className="show-badge absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 pointer-events-none z-10"
          aria-hidden
        >
          SHOW — hold Esc to exit
        </div>
      )}
      <div className="flex items-center gap-1.5">
        <button
          className={`text-accent font-semibold tracking-tight px-1 rounded-sm hover:bg-panel2 transition-colors ${prefsOpen ? 'bg-panel2' : ''}`}
          onClick={() => setPrefsOpen((v) => !v)}
          title={prefsOpen ? 'Hide preferences' : 'Show preferences'}
          aria-expanded={prefsOpen}
        >
          dataFLOU
        </button>
        {/* OSC Monitor lives on the main toolbar — useful mid-performance,
            so it stays visible in show mode (no data-hide-in-show). */}
        <OscMonitorToggle />
        {/* MIDI conflicts warning — only renders when detectMidiConflicts
            finds overlaps. Click to open a modal listing the colliding
            targets. Stays visible in show mode so a performer can see
            at a glance that two pads share a binding. */}
        <MidiConflictsBanner />
        <input
          data-hide-in-show="true"
          className="input w-24"
          value={session.name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Session"
        />
      </div>

      <div data-hide-in-show="true" className="h-6 w-px bg-border" />

      <div data-hide-in-show="true" className="flex items-center gap-1">
        {/* New routes through the App-level "Save before opening a
            new session?" modal — same UX as the OS X-button quit
            confirm. The store flag triggers the modal; the modal's
            handlers run newSession() after the user picks save /
            discard / cancel. */}
        <button
          className="btn"
          onClick={() => useStore.getState().setNewSessionConfirmOpen(true)}
        >
          New
        </button>
        <button className="btn" onClick={onOpen}>Open</button>
        <button ref={saveRef} data-save-button="true" className="btn" onClick={onSave}>Save</button>
        <button className="btn" onClick={onSaveAs}>Save As</button>
      </div>

      <div data-hide-in-show="true" className="h-6 w-px bg-border" />

      <div data-hide-in-show="true" className="flex items-center gap-1.5">
        {/* Default OSC group is collapsible (and collapsed by default)
            so the toolbar stays compact and the Panic button stays
            visible on narrow windows. Expand by clicking the "Default
            OSC ▸" chip — the state persists in localStorage. */}
        <DefaultOscGroup />
        {/* Listening pill lives in the Pool drawer's header (next to
            the Capture button) so this toolbar stays compact. */}
        {/* OSC Forward — popover that lets the user fan out every
            received UDP packet to N downstream consumers (Pure Data,
            Ableton, another machine). Kept OUTSIDE the collapsible
            chip so its enabled/total status dot is always visible. */}
        <ForwardPopoverButton />
      </div>

      <div data-hide-in-show="true" className="h-6 w-px bg-border" />

      <div data-hide-in-show="true" className="flex items-center gap-1">
        <span className="label">Tick</span>
        <BoundedNumberInput
          className="input w-10"
          integer
          min={10}
          max={300}
          value={session.tickRateHz}
          onChange={(hz) => {
            setTickRate(hz)
            window.api.setTickRate(hz)
          }}
        />
        <span className="text-muted text-[10px]">Hz</span>
        <span className="label ml-0.5">BPM</span>
        <BoundedNumberInput
          className="input w-12"
          min={10}
          max={500}
          value={session.globalBpm}
          onChange={(v) => setGlobalBpm(v)}
          title="Global tempo (accepts floats)"
        />
      </div>

      <div data-hide-in-show="true" className="h-6 w-px bg-border" />

      <div data-hide-in-show="true" className="flex items-center gap-1.5">
        <span className="label">MIDI</span>
        <select
          className="input w-32"
          value={session.midiInputName ?? ''}
          onChange={(e) => onMidiChange(e.target.value || null)}
        >
          <option value="">(none)</option>
          {midiDevices.map((d) => (
            <option key={d.id} value={d.name}>
              {d.name}
            </option>
          ))}
        </select>
        <MidiLearnButton />
      </div>

      {/* Generative ON status badge (v0.5.10) -- visible only when
          session.generative.enabled is true. Sits centered between
          MIDI Learn and the view toggle so the performer can see at
          a glance that auto-advance is being driven by the selector
          instead of follow-actions. Red because that mirrors how
          performance-critical "this is firing" indicators show up
          elsewhere in the app (Hardware Mode caught dots). */}
      <div className="flex-1 flex items-center justify-center">
        <GenerativeStatusBadge />
      </div>

      <button
        className="btn min-w-[76px]"
        onClick={() => setView(view === 'edit' ? 'sequence' : 'edit')}
        title={`Go to ${view === 'edit' ? 'Sequence' : 'Grid'} view`}
      >
        {view === 'edit' ? 'Sequence' : 'Grid'}
      </button>

      <button
        ref={stopAllRef}
        className="btn"
        onClick={() => {
          flash(stopAllRef.current)
          window.api.stopAll()
        }}
        title="Stop all (with morph)"
      >
        Stop All
      </button>
      <button
        ref={panicRef}
        className="btn"
        style={{
          borderColor: 'rgb(var(--c-danger))',
          color: 'rgb(var(--c-danger))'
        }}
        onClick={() => {
          flash(panicRef.current)
          window.api.panic()
        }}
        title="Panic (instant stop)"
      >
        Panic
      </button>
    </div>

    {/* Preferences sub-toolbar — toggled by clicking the dataFLOU brand
        label. Sits immediately below the main toolbar and pushes the rest
        of the app down (normal flex-column flow in App.tsx). */}
    {prefsOpen && (
      <div
        data-hide-in-show="true"
        className="flex items-center gap-2 px-2 py-2 bg-panel border-b border-border"
      >
        <span className="label shrink-0 ml-1">Theme</span>
        <select
          className="input w-44"
          value={theme}
          onChange={(e) => {
            setTheme(e.target.value as ThemeName)
            // Release focus so global Tab-toggles-view fires on next press
            // instead of being intercepted by the <select>'s native focus.
            e.target.blur()
          }}
        >
          {THEMES.map((t) => (
            <option key={t.id} value={t.id}>
              {t.label}
            </option>
          ))}
        </select>

        <span className="h-5 w-px bg-border mx-1" />

        {/* MIDI Output global toggle. When OFF, the engine skips
            every cell's MIDI emission (zero CPU cost, every open
            port closes); when ON, cells that opt in via their
            MIDI section start firing again. Default ON. */}
        <MidiEnabledToggle />

        <span className="h-5 w-px bg-border mx-1" />

        {/* Show mode — locks the UI into a performance-only view. Exit with
            F11 or by holding Escape for ~800 ms (see App.tsx keyboard router). */}
        <button
          className="btn"
          style={{
            borderColor: 'rgb(var(--c-danger))',
            color: 'rgb(var(--c-danger))'
          }}
          onClick={() => {
            useStore.getState().setShowMode(true)
            setPrefsOpen(false)
          }}
          title="Enter Show Mode — hides all edit controls. Hold Escape or press F11 to exit."
        >
          Enter Show Mode
        </button>

        <span className="flex-1" />
        {/* Undo / Redo — three-deep session history. Undo rewinds
            the last logical edit (typing bursts coalesce into one
            step); Redo replays it. Disabled state reads off the
            counters that undo.ts publishes into the store. */}
        <UndoRedoButtons />
        <button
          className="btn"
          onClick={() => setPrefsOpen(false)}
          title="Close preferences"
        >
          Close
        </button>
      </div>
    )}
    </>
  )
}

// Toggle for the OSC monitor drawer (bottom-of-app scrollable log of
// outgoing OSC traffic). Default off; lit when open.
// MIDI conflicts warning. Indexes every MIDI-routable binding in the
// current session; if any (kind, channel, number) collides, shows a
// warning badge that opens a modal listing the colliding targets. The
// detection is memoized per session reference so it re-runs only when
// the session changes (not on every render of the top bar).
function MidiConflictsBanner(): JSX.Element | null {
  const session = useStore((s) => s.session)
  const setSelectedCell = useStore((s) => s.selectCell)
  const setFocusedScene = useStore((s) => s.setFocusedScene)
  const setMetaSelectedKnob = useStore((s) => s.setMetaSelectedKnob)
  const setMetaControllerVisible = useStore((s) => s.setMetaControllerVisible)
  const conflicts = useMemo(() => detectMidiConflicts(session), [session])
  const [open, setOpen] = useState(false)
  if (conflicts.length === 0) return null
  const total = conflicts.reduce((n, c) => n + c.targets.length, 0)
  return (
    <>
      <button
        className="btn text-[10px] py-0.5 px-1.5 shrink-0"
        style={{
          borderColor: 'rgb(var(--c-danger))',
          color: 'rgb(var(--c-danger))'
        }}
        onClick={() => setOpen(true)}
        title={`${conflicts.length} MIDI binding${conflicts.length === 1 ? '' : 's'} bound to multiple targets — click for details`}
      >
        ⚠ MIDI ×{conflicts.length}
      </button>
      {open && (
        <Modal title={`MIDI binding conflicts (${total} targets)`} onClose={() => setOpen(false)}>
          <div className="flex flex-col gap-3 max-h-[60vh] overflow-y-auto">
            <p className="text-[12px] text-muted">
              The bindings below fire the FIRST matching target when a
              MIDI message arrives — the others never trigger. Click a
              target to jump to it, then re-learn or clear its binding.
            </p>
            {conflicts.map((c) => (
              <div
                key={c.key}
                className="border border-border rounded p-2 flex flex-col gap-1"
              >
                <div className="font-mono text-[11px] text-accent2">{c.binding}</div>
                {c.targets.map((t, i) => (
                  <button
                    key={i}
                    className="text-left text-[12px] px-2 py-1 rounded hover:bg-panel2"
                    onClick={() => {
                      // Navigate to the conflicting target so the user
                      // can re-bind or clear it. Closes the modal.
                      const nav = t.navigate
                      if (nav?.kind === 'scene') setFocusedScene(nav.id)
                      else if (nav?.kind === 'cell')
                        setSelectedCell(nav.sceneId, nav.trackId)
                      else if (nav?.kind === 'metaKnob') {
                        setMetaControllerVisible(true)
                        setMetaSelectedKnob(nav.index)
                      }
                      // 'go' and 'morphTime' have no navigation target —
                      // the Transport bar is always visible already.
                      setOpen(false)
                    }}
                  >
                    {t.label}
                  </button>
                ))}
              </div>
            ))}
          </div>
        </Modal>
      )}
    </>
  )
}

// Default OSC group — the /path · IP · port inputs that every newly
// dropped clip inherits from. Collapsible (and COLLAPSED by default)
// so the toolbar's right side (Stop All, Panic) stays visible on
// narrow windows. The collapsed chip shows the current dest + port
// at-a-glance ("Default OSC 127.0.0.1:9000 ▸"); clicking expands the
// full inputs.
//
// Always starts collapsed on app launch — the open/close state is
// session-local (not persisted across restarts). Lets the toolbar
// boot up in its compact form every time, even if the user had it
// expanded in the previous session.
function DefaultOscGroup(): JSX.Element {
  const session = useStore((s) => s.session)
  const setDefaults = useStore((s) => s.setDefaults)
  const [open, setOpen] = useState<boolean>(false)
  if (!open) {
    // Collapsed chip — clicking expands. The dest + port readout means
    // the user can verify their current default without opening the
    // group (which is the main reason to look at it once configured).
    return (
      <button
        className="flex items-center gap-1 px-1.5 py-0.5 rounded border border-border bg-panel2 hover:bg-panel3 text-[10px] leading-tight shrink-0"
        onClick={() => setOpen(true)}
        title="Default OSC — click to expand and edit the address / IP / port that newly-dropped clips inherit."
      >
        <span className="text-muted">Default OSC</span>
        <span className="font-mono text-text tabular-nums">
          {session.defaultDestIp}:{session.defaultDestPort}
        </span>
        <span className="text-muted">▸</span>
      </button>
    )
  }
  // Expanded — full inputs + a collapse button at the end.
  return (
    <div className="flex items-center gap-1.5">
      <button
        className="label hover:text-text"
        onClick={() => setOpen(false)}
        title="Collapse Default OSC"
      >
        Default OSC ▾
      </button>
      <input
        className="input w-36"
        value={session.defaultOscAddress}
        onChange={(e) => setDefaults({ defaultOscAddress: e.target.value })}
        placeholder="/path"
      />
      <input
        className="input w-[112px]"
        value={session.defaultDestIp}
        onChange={(e) => setDefaults({ defaultDestIp: e.target.value })}
        placeholder="127.0.0.1"
        maxLength={15}
      />
      <span className="text-muted">:</span>
      <PortInput
        value={session.defaultDestPort}
        onChange={(p) => setDefaults({ defaultDestPort: p })}
      />
    </div>
  )
}

// OSC Forward popover button. Sits inside the Default OSC group of
// the top toolbar. Clicking it opens a portaled dropdown that lets
// the user manage the list of forward targets — IP, port, label, and
// per-row enable. Each edit pushes the full list to main via the
// store's CRUD actions; main re-applies it on the listener's hot path
// so the next received packet uses the new config.
//
// UX choices:
//   - Button label shows "Forward N/M" where N = enabled, M = total.
//     Hidden 0/0 case shows just "Forward" with an off-state dot.
//   - Green dot = at least one enabled, grey = none. No red state —
//     individual target send errors get logged in main, not surfaced
//     up here, because at high packet rates an unreachable downstream
//     would flicker the whole top toolbar red.
//   - Popover closes on click-outside or Escape. Click-inside doesn't
//     close so the user can tweak multiple rows in sequence.
function ForwardPopoverButton(): JSX.Element {
  const targets = useStore((s) => s.session.forwardTargets ?? [])
  const addForwardTarget = useStore((s) => s.addForwardTarget)
  const updateForwardTarget = useStore((s) => s.updateForwardTarget)
  const removeForwardTarget = useStore((s) => s.removeForwardTarget)
  const [open, setOpen] = useState(false)
  const buttonRef = useRef<HTMLButtonElement | null>(null)
  const popoverRef = useRef<HTMLDivElement | null>(null)
  const [anchor, setAnchor] = useState<{ x: number; y: number } | null>(null)
  // Compute the popover's screen position from the button's rect on
  // open. We pin its TOP-RIGHT to the button's BOTTOM-RIGHT so a
  // wide popover doesn't overflow the right edge of the window.
  useEffect(() => {
    if (!open || !buttonRef.current) return
    const rect = buttonRef.current.getBoundingClientRect()
    setAnchor({ x: rect.right, y: rect.bottom + 4 })
  }, [open])
  // Click-outside + Escape to close. Listener installed only while
  // the popover is open so we don't pay for it otherwise.
  useEffect(() => {
    if (!open) return
    function onDown(e: MouseEvent): void {
      const t = e.target as Node | null
      if (!t) return
      if (buttonRef.current?.contains(t)) return
      if (popoverRef.current?.contains(t)) return
      setOpen(false)
    }
    function onKey(e: KeyboardEvent): void {
      if (e.key === 'Escape') setOpen(false)
    }
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey)
    }
  }, [open])
  const enabledCount = targets.filter((t) => t.enabled).length
  const dotColor =
    enabledCount > 0
      ? 'rgb(var(--c-success))'
      : targets.length > 0
        ? 'rgb(var(--c-muted))'
        : 'rgb(var(--c-muted) / 0.5)'
  const tooltip =
    targets.length === 0
      ? 'OSC Forward — fan out every received UDP packet to one or more downstream consumers (Pd, Ableton, another machine). Click to configure.'
      : `OSC Forward — ${enabledCount} of ${targets.length} target${
          targets.length === 1 ? '' : 's'
        } enabled. Click to manage.`
  return (
    <>
      <button
        ref={buttonRef}
        className="flex items-center gap-1 px-1.5 py-0.5 rounded border border-border bg-panel2 hover:bg-panel3 text-[10px] leading-tight shrink-0"
        onClick={() => setOpen((v) => !v)}
        title={tooltip}
      >
        <span
          className="inline-block w-1.5 h-1.5 rounded-full"
          style={{ background: dotColor }}
        />
        <span className="text-muted">Forward</span>
        {targets.length > 0 && (
          <span className="font-mono text-text tabular-nums">
            {enabledCount}/{targets.length}
          </span>
        )}
      </button>
      {open &&
        anchor &&
        createPortal(
          <div
            ref={popoverRef}
            className="fixed z-50 bg-panel border border-border rounded shadow-lg text-[11px]"
            style={{
              left: Math.max(8, anchor.x - 320),
              top: anchor.y,
              width: 320
            }}
            onMouseDown={(e) => e.stopPropagation()}
          >
            <div className="px-3 py-2 border-b border-border flex items-center justify-between">
              <span className="label">OSC Forward</span>
              <button
                className="text-muted hover:text-text text-[14px] leading-none"
                onClick={() => setOpen(false)}
                title="Close"
              >
                ×
              </button>
            </div>
            <div className="px-3 py-2 text-[10px] text-muted leading-snug">
              Every UDP packet received on the Default OSC port is
              byte-copied to each enabled target below. Lets dataFLOU
              sit in front of Pure Data, Ableton, or another machine
              when the upstream sender's port is fixed.
            </div>
            <div className="max-h-64 overflow-y-auto">
              {targets.length === 0 ? (
                <div className="px-3 py-4 text-[11px] text-muted text-center">
                  No forward targets yet.
                  <br />
                  <span className="text-[10px]">
                    Click <span className="text-text">+ Add</span> below to add one.
                  </span>
                </div>
              ) : (
                targets.map((t) => (
                  <ForwardTargetRow
                    key={t.id}
                    target={t}
                    onUpdate={(fields) => updateForwardTarget(t.id, fields)}
                    onRemove={() => removeForwardTarget(t.id)}
                  />
                ))
              )}
            </div>
            <div className="px-3 py-2 border-t border-border flex items-center justify-between">
              <button
                className="btn text-[10px] py-0.5"
                onClick={() => addForwardTarget()}
                title="Add a new forward target"
              >
                + Add target
              </button>
              <span className="text-[10px] text-muted">
                {enabledCount}/{targets.length} enabled
              </span>
            </div>
          </div>,
          document.body
        )}
    </>
  )
}

// Single forward-target row inside the popover. Five fields:
//   ☑ enable · label · ip · port · ✕ remove
// Each field updates the store on every keystroke for now — the list
// is tiny (the IPC payload is at most a few hundred bytes), so we
// don't bother debouncing.
function ForwardTargetRow({
  target,
  onUpdate,
  onRemove
}: {
  target: OscForwardTarget
  onUpdate: (fields: Partial<OscForwardTarget>) => void
  onRemove: () => void
}): JSX.Element {
  return (
    <div className="px-3 py-1.5 border-b border-border last:border-b-0 flex items-center gap-1.5">
      <input
        type="checkbox"
        checked={target.enabled}
        onChange={(e) => onUpdate({ enabled: e.target.checked })}
        title={target.enabled ? 'Disable this target' : 'Enable this target'}
      />
      <input
        className="input text-[10px] py-0 flex-1 min-w-0"
        value={target.label ?? ''}
        onChange={(e) => onUpdate({ label: e.target.value })}
        placeholder="label (Pd, Ableton…)"
        title="Friendly label — for your reference only, not sent on the wire."
      />
      <input
        className="input text-[10px] py-0 w-[96px]"
        value={target.ip}
        onChange={(e) => onUpdate({ ip: e.target.value })}
        placeholder="127.0.0.1"
        title="Destination IP — 127.0.0.1 for an app on this machine, or a LAN address for another host."
        maxLength={15}
      />
      <span className="text-muted text-[10px]">:</span>
      <BoundedNumberInput
        className="input text-[10px] py-0 w-[52px] tabular-nums"
        integer
        min={1}
        max={65535}
        value={target.port}
        onChange={(p) => onUpdate({ port: p })}
      />
      <button
        className="text-muted hover:text-danger text-[12px] leading-none px-1"
        onClick={onRemove}
        title="Remove this target"
      >
        ×
      </button>
    </div>
  )
}

function OscMonitorToggle(): JSX.Element {
  const open = useStore((s) => s.oscMonitorOpen)
  const setOpen = useStore((s) => s.setOscMonitorOpen)
  return (
    <button
      className={`btn text-[10px] py-0.5 ${open ? 'bg-accent text-black border-accent' : ''}`}
      onClick={() => setOpen(!open)}
      title="Toggle Monitor drawer (OSC + MIDI live)"
    >
      Monitor
    </button>
  )
}

// Global MIDI output enable. Lives in the prefs sub-toolbar.
// When OFF the engine bypasses every cell's MIDI emit path and
// closes every open native port — zero CPU cost for shows that
// don't use MIDI. Default ON.
// Undo / Redo pair for the prefs sub-toolbar. Reads the counters
// undo.ts publishes into the Zustand store so the buttons render
// disabled when the past / future stack is empty (max 3 each).
// Tooltip includes the keyboard shortcut as a hint.
function UndoRedoButtons(): JSX.Element {
  const undoCount = useStore((s) => s.undoCount)
  const redoCount = useStore((s) => s.redoCount)
  return (
    <>
      <button
        className="btn"
        onClick={() => undo()}
        disabled={undoCount === 0}
        title={`Undo (Ctrl+Z) — ${undoCount} step${undoCount === 1 ? '' : 's'} available, max 3`}
      >
        ↶ Undo
        {undoCount > 0 && (
          <span className="text-muted text-[10px] ml-1">{undoCount}</span>
        )}
      </button>
      <button
        className="btn"
        onClick={() => redo()}
        disabled={redoCount === 0}
        title={`Redo (Ctrl+Shift+Z) — ${redoCount} step${redoCount === 1 ? '' : 's'} available, max 3`}
      >
        ↷ Redo
        {redoCount > 0 && (
          <span className="text-muted text-[10px] ml-1">{redoCount}</span>
        )}
      </button>
    </>
  )
}

function MidiEnabledToggle(): JSX.Element {
  const enabled = useStore((s) => s.session.midiEnabled)
  const setMidiEnabled = useStore((s) => s.setMidiEnabled)
  return (
    <label
      className="flex items-center gap-1.5 cursor-pointer select-none text-[12px]"
      title={
        enabled
          ? 'Disable MIDI output globally — closes every open port + skips all per-cell MIDI emits (zero CPU)'
          : 'Enable MIDI output globally — cells with MIDI enabled start firing again'
      }
    >
      <input
        type="checkbox"
        checked={enabled}
        onChange={(e) => setMidiEnabled(e.target.checked)}
      />
      <span className="label">MIDI Output</span>
      <span
        className={
          enabled ? 'text-success text-[10px]' : 'text-muted text-[10px]'
        }
      >
        {enabled ? 'on' : 'off'}
      </span>
    </label>
  )
}

// Global MIDI Learn button. Pressed state = learn mode on (Ableton-style:
// blue overlays appear on all learnable elements, click one and hit a MIDI
// control to bind; green overlay confirms). Press again to exit.
function MidiLearnButton(): JSX.Element {
  const on = useStore((s) => s.midiLearnMode)
  const setMode = useStore((s) => s.setMidiLearnMode)
  return (
    <button
      className="btn"
      onClick={() => setMode(!on)}
      style={
        on
          ? {
              background: 'rgba(90, 150, 255, 0.6)',
              color: '#fff',
              borderColor: 'rgba(90, 150, 255, 1)'
            }
          : undefined
      }
      title={
        on
          ? 'MIDI Learn ON — click a scene/message trigger, then move a control. Click again to exit.'
          : 'Enter MIDI Learn mode'
      }
    >
      MIDI Learn
    </button>
  )
}

// Orange "Generative ON" status badge (v0.5.10). Renders only when
// session.generative.enabled is true. Same accent colour as the
// GENERATIVE button in the Scene Inspector so the visual identity
// of the generative system stays consistent across the app. Click
// toggles generative OFF so the performer can kill the selector
// from the top toolbar without hunting for the popover. When OFF
// the badge hides entirely so the toolbar stays clean.
function GenerativeStatusBadge(): JSX.Element | null {
  const enabled = useStore((s) => s.session.generative?.enabled === true)
  const setEnabled = useStore((s) => s.setGenerativeEnabled)
  if (!enabled) return null
  return (
    <button
      className="flex items-center gap-1.5 px-2 py-0.5 rounded text-[11px] font-semibold tracking-wide uppercase transition-colors bg-accent text-black border border-accent"
      onClick={() => setEnabled(false)}
      title="Generative mode is ON - engine picks the next scene from the pool. Click to turn off."
    >
      <span
        className="inline-block w-2 h-2 rounded-full bg-black/70 animate-pulse"
      />
      Generative ON
    </button>
  )
}

// Port input that allows the field to be empty during editing (instead of
// snapping to 0). Caps at 65535. Only digits accepted.
function PortInput({
  value,
  onChange
}: {
  value: number
  onChange: (n: number) => void
}): JSX.Element {
  const [str, setStr] = useState(String(value))
  // Sync external changes (e.g., loading a session) into the local string.
  useEffect(() => setStr(String(value)), [value])

  return (
    <input
      className="input w-14"
      type="text"
      inputMode="numeric"
      placeholder="9000"
      value={str}
      onChange={(e) => {
        const v = e.target.value
        if (!/^\d*$/.test(v)) return
        setStr(v)
        if (v === '') return
        const n = parseInt(v, 10)
        if (Number.isFinite(n) && n >= 0 && n <= 65535) onChange(n)
      }}
      onBlur={() => {
        if (str === '') setStr(String(value))
      }}
    />
  )
}
