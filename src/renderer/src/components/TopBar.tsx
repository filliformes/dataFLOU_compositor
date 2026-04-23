import { useEffect, useRef, useState } from 'react'
import { useStore, type ThemeName } from '../store'
import { midi, type MidiDevice } from '../midi'
import { BoundedNumberInput } from './BoundedNumberInput'

// Theme picker options. Order = order shown in the dropdown. New themes first.
const THEMES: { id: ThemeName; label: string }[] = [
  { id: 'studio-dark', label: 'Studio Dark' },
  { id: 'warm-charcoal', label: 'Warm Charcoal' },
  { id: 'graphite', label: 'Graphite' },
  { id: 'cream', label: 'Cream' },
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
  const setDefaults = useStore((s) => s.setDefaults)
  const setMidiInputName = useStore((s) => s.setMidiInputName)
  const setSession = useStore((s) => s.setSession)
  const setCurrentFilePath = useStore((s) => s.setCurrentFilePath)
  const newSession = useStore((s) => s.newSession)
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
    setSession(res.session)
    setCurrentFilePath(res.path)
  }
  async function onSave(): Promise<void> {
    if (currentFilePath) {
      const ok = await window.api.sessionSave(session, currentFilePath)
      if (ok) flash(saveRef.current, 'flash-blue')
    } else {
      const p = await onSaveAs()
      // First-time save promotes Save As → Save; flash Save when that succeeds too.
      if (p) flash(saveRef.current, 'flash-blue')
    }
  }
  async function onSaveAs(): Promise<string | null> {
    const p = await window.api.sessionSaveAs(session)
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
        <button className="btn" onClick={newSession}>New</button>
        <button className="btn" onClick={onOpen}>Open</button>
        <button ref={saveRef} className="btn" onClick={onSave}>Save</button>
        <button className="btn" onClick={onSaveAs}>Save As</button>
      </div>

      <div data-hide-in-show="true" className="h-6 w-px bg-border" />

      <div data-hide-in-show="true" className="flex items-center gap-1.5">
        <span className="label">Default OSC</span>
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

      <div className="flex-1" />

      <button
        className="btn min-w-[76px]"
        onClick={() => setView(view === 'edit' ? 'sequence' : 'edit')}
        title={`Go to ${view === 'edit' ? 'Sequence' : 'Edit'} view`}
      >
        {view === 'edit' ? 'Sequence' : 'Edit'}
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
function OscMonitorToggle(): JSX.Element {
  const open = useStore((s) => s.oscMonitorOpen)
  const setOpen = useStore((s) => s.setOscMonitorOpen)
  return (
    <button
      className={`btn text-[10px] py-0.5 ${open ? 'bg-accent text-black border-accent' : ''}`}
      onClick={() => setOpen(!open)}
      title="Toggle OSC monitor drawer"
    >
      OSC
    </button>
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
