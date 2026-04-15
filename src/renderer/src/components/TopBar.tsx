import { useEffect, useRef, useState } from 'react'
import { useStore } from '../store'
import { midi, type MidiDevice } from '../midi'
import { BoundedNumberInput } from './BoundedNumberInput'

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
    <div className="flex items-center gap-2 px-2 py-2 bg-panel border-b border-border">
      <div className="flex items-center gap-1.5">
        <div className="text-accent font-semibold tracking-tight">dataFLOU</div>
        <input
          className="input w-32"
          value={session.name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Session"
        />
      </div>

      <div className="h-6 w-px bg-border" />

      <div className="flex items-center gap-1">
        <button className="btn" onClick={newSession}>New</button>
        <button className="btn" onClick={onOpen}>Open</button>
        <button ref={saveRef} className="btn" onClick={onSave}>Save</button>
        <button className="btn" onClick={onSaveAs}>Save As</button>
      </div>

      <div className="h-6 w-px bg-border" />

      <div className="flex items-center gap-1.5">
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

      <div className="h-6 w-px bg-border" />

      <div className="flex items-center gap-1.5">
        <span className="label">Tick</span>
        <BoundedNumberInput
          className="input w-12"
          integer
          min={10}
          max={300}
          value={session.tickRateHz}
          onChange={(hz) => {
            setTickRate(hz)
            window.api.setTickRate(hz)
          }}
        />
        <span className="text-muted text-[11px]">Hz</span>
        <span className="label ml-1">BPM</span>
        <BoundedNumberInput
          className="input w-16"
          min={10}
          max={500}
          value={session.globalBpm}
          onChange={(v) => setGlobalBpm(v)}
          title="Global tempo (accepts floats)"
        />
      </div>

      <div className="h-6 w-px bg-border" />

      <div className="flex items-center gap-1.5">
        <span className="label">MIDI</span>
        <select
          className="input w-44"
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
        className="btn"
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
