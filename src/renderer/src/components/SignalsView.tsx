// (v0.6.5) Signals view — "mission control" for every State Trigger and
// Pose Sequence across the whole session, grouped by instrument. A State
// Trigger is a single pose → MIDI; a Pose Sequence is an ordered phrase
// of poses. Both only evaluate while their instrument's Hardware Mode is
// ON, so this view surfaces that front-and-center (the LIVE badge per
// lane) alongside live match meters and playheads.
//
// A full-height overlay like MappingsView, toggled by the "S" key + a
// transport-bar button. Reuses the exact card components from the
// inspector sections (StateTriggerCard / PoseSequenceCard) so editing
// here is identical to editing in the inspector — this view just gathers
// them all in one place and lights them up live.

import { useEffect, useMemo, useState } from 'react'
import { useStore } from '../store'
import type { InstrumentTemplate } from '@shared/types'
import { StateTriggerCard } from './StateTriggersSection'
import { PoseSequenceCard, poseColor } from './PoseSequencesSection'

interface Live {
  scores: Record<string, number>
  active: Record<string, boolean>
  seqSteps: Record<string, number>
  seqScores: Record<string, number>
}

export function SignalsView(): JSX.Element {
  const templates = useStore((s) => s.session.pool.templates)
  const tracks = useStore((s) => s.session.tracks)
  const setSignalsOpen = useStore((s) => s.setSignalsOpen)

  // Card width (px) — drives the min column size of both the State
  // Trigger and Pose Sequence grids. Widen it so a MIDI editor's Note +
  // Vel sit on the same line as MIDI + Ch. Persisted so it sticks.
  const [cardW, setCardW] = useState(() => {
    try {
      const v = parseInt(localStorage.getItem('signals.cardW') ?? '', 10)
      return Number.isFinite(v) && v >= 280 && v <= 900 ? v : 340
    } catch {
      return 340
    }
  })
  function changeCardW(v: number): void {
    setCardW(v)
    try {
      localStorage.setItem('signals.cardW', String(v))
    } catch {
      /* ignore */
    }
  }

  // Which templates are actually placed in the session (have a track).
  const usedTemplateIds = useMemo(
    () =>
      new Set(
        tracks.map((t) => t.sourceTemplateId).filter((id): id is string => !!id)
      ),
    [tracks]
  )
  // Show instruments that are placed OR already carry signals — so a
  // configured trigger/sequence never hides, even mid-setup. Skip the
  // hidden `draft` backing templates.
  const instruments = useMemo(
    () =>
      templates.filter(
        (t) =>
          !t.draft &&
          (usedTemplateIds.has(t.id) ||
            (t.stateTriggers?.length ?? 0) > 0 ||
            (t.poseSequences?.length ?? 0) > 0)
      ),
    [templates, usedTemplateIds]
  )

  // One poll for the whole view (State-Trigger scores/active + Pose-
  // Sequence playheads), ~10 Hz. Only while something exists to watch.
  const [live, setLive] = useState<Live>({
    scores: {},
    active: {},
    seqSteps: {},
    seqScores: {}
  })
  const hasAny = instruments.some(
    (t) => (t.stateTriggers?.length ?? 0) + (t.poseSequences?.length ?? 0) > 0
  )
  useEffect(() => {
    if (!hasAny) return
    let alive = true
    const iv = setInterval(async () => {
      const r = await window.api?.stateTriggerGetLive?.()
      if (alive && r) {
        setLive({
          scores: r.scores ?? {},
          active: r.active ?? {},
          seqSteps: r.seqSteps ?? {},
          seqScores: r.seqScores ?? {}
        })
      }
    }, 100)
    return () => {
      alive = false
      clearInterval(iv)
    }
  }, [hasAny])

  // Session-wide tallies for the header.
  const totalStates = instruments.reduce(
    (n, t) => n + (t.stateTriggers?.length ?? 0),
    0
  )
  const totalSeqs = instruments.reduce(
    (n, t) => n + (t.poseSequences?.length ?? 0),
    0
  )
  const liveInstruments = instruments.filter(
    (t) => t.hardwareMode?.enabled
  ).length
  const firingNow = Object.values(live.active).filter(Boolean).length

  return (
    <div className="h-full overflow-auto bg-bg">
      {/* Header — sticky, with an accent wash + live tallies */}
      <div
        className="sticky top-0 z-10 border-b border-border px-4 py-2.5 flex items-center gap-3 bg-panel/95 backdrop-blur"
        style={{
          backgroundImage:
            'linear-gradient(90deg, rgb(var(--c-accent) / 0.16), rgb(var(--c-accent2) / 0.06) 40%, transparent 75%)'
        }}
      >
        <span
          className="text-[15px] shrink-0 select-none"
          style={{ color: 'rgb(var(--c-accent))' }}
          aria-hidden
        >
          ◉
        </span>
        <div className="flex flex-col leading-tight">
          <span className="text-sm font-semibold tracking-wide">Signals</span>
          <span className="text-[10px] text-muted">
            every trigger &amp; sequence — live, across the session
          </span>
        </div>
        <div className="flex-1" />
        {/* Card-width control — widen cards so Note/Vel fit on one line
            with MIDI/Ch. */}
        <label
          className="flex items-center gap-1 shrink-0"
          title="Card width — drag to widen the trigger / sequence cards (e.g. so Note + Vel sit on the same line as MIDI + Ch)."
        >
          <span className="text-[11px] text-muted select-none" aria-hidden>
            ⇔
          </span>
          <input
            type="range"
            min={280}
            max={900}
            step={20}
            value={cardW}
            onChange={(e) => changeCardW(parseInt(e.target.value, 10))}
            style={{ width: 84 }}
          />
        </label>
        <div className="flex items-center gap-1.5">
          <StatChip label="states" value={totalStates} />
          <StatChip label="sequences" value={totalSeqs} />
          <StatChip
            label="HW live"
            value={`${liveInstruments}/${instruments.length}`}
            accent={liveInstruments > 0}
          />
          <StatChip label="firing" value={firingNow} pulse={firingNow > 0} />
        </div>
        <button
          className="btn text-[11px] py-0.5 px-2 ml-1"
          onClick={() => setSignalsOpen(false)}
          title="Close the Signals view (S)"
        >
          ✕ Close
        </button>
      </div>

      <HowTo />

      {instruments.length === 0 && (
        <div className="p-8 text-center flex flex-col items-center gap-2">
          <span className="text-2xl opacity-40">◉</span>
          <div className="text-[12px] text-muted max-w-md">
            No instruments in this session yet. Add an Instrument (Pool → drag a
            template, or Capture a device from the Network tab), enable its{' '}
            <span className="text-accent">Hardware Mode</span>, and its State
            Triggers &amp; Pose Sequences will light up here as you perform.
          </div>
        </div>
      )}

      <div className="p-3 flex flex-col gap-3">
        {instruments.map((tpl) => (
          <InstrumentLane key={tpl.id} tpl={tpl} live={live} cardW={cardW} />
        ))}
      </div>
    </div>
  )
}

// Collapsible "how do I do this?" panel. The whole feature is a bit of
// a workflow (arm HW → build a sequence → companion-record → perform),
// so spell it out. Collapse state persists in localStorage so it only
// nags once.
function HowTo(): JSX.Element {
  const [open, setOpen] = useState(() => {
    try {
      return localStorage.getItem('signals.help') !== 'closed'
    } catch {
      return true
    }
  })
  function toggle(): void {
    setOpen((v) => {
      const nv = !v
      try {
        localStorage.setItem('signals.help', nv ? 'open' : 'closed')
      } catch {
        /* ignore */
      }
      return nv
    })
  }
  const steps: { title: string; body: string }[] = [
    {
      title: 'Arm the instrument',
      body: 'Turn Hardware Mode ON for the instrument (the badge in its lane should read ● LIVE). Signals only fire while HW Mode is on and the device is streaming. Add smoothing under Input Conditioning if the sensor is jittery.'
    },
    {
      title: 'A State is one pose',
      body: 'Under State Triggers, add a state, hold a pose, and hit ● Record. It memorises the pose and fires a MIDI note/CC whenever you return to it. Raise Tolerance if the match is too fussy.'
    },
    {
      title: 'A Sequence is a phrase',
      body: 'Under Pose Sequences, add a sequence and set how many poses you want with + Pose. Each pose is a step; you fire its note by moving THROUGH it in order.'
    },
    {
      title: 'Record hands-free',
      body: 'Set Hold ms (time per pose), then hit ⏺ Rec Seq. It counts you into pose 1, records while you hold still, then advances — move into pose 2, hold, and so on. The banner + the glowing pose number show exactly where you are.'
    },
    {
      title: 'Assign the notes',
      body: 'Open each pose and set its MIDI note/CC (and optionally a dataFLOU scene). Adjacent poses default to an ascending line you can re-map.'
    },
    {
      title: 'Perform',
      body: 'Move through the poses in order. Each fires as you reach it; the playhead (n/N) tracks you. Looping wraps to the start; one-shot parks on the last until you hit ↺ Reset.'
    }
  ]
  return (
    <div className="px-3 pt-2">
      <div
        className="rounded-md border overflow-hidden"
        style={{
          borderColor: 'rgb(var(--c-accent) / 0.5)',
          background: 'rgb(var(--c-accent) / 0.06)'
        }}
      >
        <button
          className="w-full flex items-center gap-2 px-2.5 py-1.5 text-left"
          onClick={toggle}
          title={open ? 'Hide the how-to' : 'Show the how-to'}
        >
          <span style={{ color: 'rgb(var(--c-accent))' }}>💡</span>
          <span className="text-[11px] font-semibold">
            How to turn poses into MIDI — a quick walkthrough
          </span>
          <div className="flex-1" />
          <span className="text-[10px] text-muted">{open ? '▾ hide' : '▸ show'}</span>
        </button>
        {open && (
          <div
            className="grid gap-2 px-3 pb-3 pt-1"
            style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))' }}
          >
            {steps.map((s, i) => (
              <div key={i} className="flex gap-2">
                <span
                  className="inline-flex items-center justify-center w-5 h-5 rounded-full text-[10px] font-bold shrink-0 mt-0.5"
                  style={{ background: poseColor(i), color: '#0a0a0a' }}
                >
                  {i + 1}
                </span>
                <div className="flex flex-col">
                  <span className="text-[11px] font-semibold">{s.title}</span>
                  <span className="text-[10px] text-muted leading-snug">{s.body}</span>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

function StatChip({
  label,
  value,
  accent,
  pulse
}: {
  label: string
  value: number | string
  accent?: boolean
  pulse?: boolean
}): JSX.Element {
  const on = accent || pulse
  return (
    <div
      className={`flex flex-col items-center rounded px-2 py-0.5 border leading-none ${
        pulse ? 'animate-pulse' : ''
      }`}
      style={{
        borderColor: on ? 'rgb(var(--c-accent))' : 'rgb(var(--c-border))',
        background: on ? 'rgb(var(--c-accent) / 0.12)' : 'rgb(var(--c-panel2) / 0.4)'
      }}
    >
      <span
        className="text-[13px] font-bold tabular-nums"
        style={{ color: on ? 'rgb(var(--c-accent))' : undefined }}
      >
        {value}
      </span>
      <span className="text-[8px] uppercase tracking-wider text-muted">
        {label}
      </span>
    </div>
  )
}

function InstrumentLane({
  tpl,
  live,
  cardW
}: {
  tpl: InstrumentTemplate
  live: Live
  cardW: number
}): JSX.Element {
  const addStateTrigger = useStore((s) => s.addStateTrigger)
  const addPoseSequence = useStore((s) => s.addPoseSequence)
  const setHw = useStore((s) => s.setTemplateHardwareMode)

  const triggers = tpl.stateTriggers ?? []
  const sequences = tpl.poseSequences ?? []
  const hwOn = tpl.hardwareMode?.enabled === true
  const hasDevice = !!tpl.hardwareMode?.deviceIp
  // Is any of this instrument's signals firing right now? (header glow)
  const laneActive = triggers.some(
    (t) => live.active[`${tpl.id}|${t.id}`] === true
  )
  const empty = triggers.length + sequences.length === 0

  return (
    <section
      className="rounded-md border border-border overflow-hidden"
      style={{
        // Left color stripe = the instrument's own color.
        borderLeft: `3px solid ${tpl.color}`,
        background: laneActive
          ? 'rgb(var(--c-accent) / 0.05)'
          : 'rgb(var(--c-panel2) / 0.25)'
      }}
    >
      {/* Lane header */}
      <div className="flex items-center gap-2 px-2.5 py-1.5 border-b border-border/60 flex-wrap">
        <span
          className="inline-block w-3 h-3 rounded-sm shrink-0"
          style={{ background: tpl.color }}
        />
        <span className="text-[12px] font-semibold">{tpl.name}</span>
        {/* HW Mode status — the gate for whether ANY signal here fires */}
        <button
          className="text-[9px] font-bold px-1.5 py-0.5 rounded-full border inline-flex items-center gap-1 shrink-0"
          onClick={() => setHw(tpl.id, { enabled: !hwOn })}
          title={
            hwOn
              ? hasDevice
                ? 'Hardware Mode is ON — signals are live. Click to disable.'
                : 'Hardware Mode is ON but no device is bound yet — bind one in the instrument inspector. Click to disable.'
              : 'Hardware Mode is OFF — signals here will NOT fire. Click to enable.'
          }
          style={
            hwOn
              ? {
                  color: hasDevice ? 'rgb(var(--c-success))' : 'rgb(var(--c-danger))',
                  borderColor: hasDevice
                    ? 'rgb(var(--c-success))'
                    : 'rgb(var(--c-danger))',
                  background: hasDevice
                    ? 'rgb(var(--c-success) / 0.12)'
                    : 'rgb(var(--c-danger) / 0.12)'
                }
              : {
                  color: 'rgb(var(--c-muted))',
                  borderColor: 'rgb(var(--c-border))'
                }
          }
        >
          <span
            className={`inline-block w-1.5 h-1.5 rounded-full ${
              hwOn && hasDevice ? 'animate-pulse' : ''
            }`}
            style={{
              background: hwOn
                ? hasDevice
                  ? 'rgb(var(--c-success))'
                  : 'rgb(var(--c-danger))'
                : 'rgb(var(--c-muted))'
            }}
          />
          {hwOn ? (hasDevice ? 'LIVE' : 'NO DEVICE') : 'HW OFF'}
        </button>
        <span className="text-[9px] text-muted">
          {triggers.length} state{triggers.length === 1 ? '' : 's'} ·{' '}
          {sequences.length} sequence{sequences.length === 1 ? '' : 's'}
        </span>
        <div className="flex-1" />
        <button
          className="btn text-[10px]"
          onClick={() => addStateTrigger(tpl.id)}
          title="Add a State Trigger to this instrument"
        >
          + State
        </button>
        <button
          className="btn text-[10px]"
          onClick={() => addPoseSequence(tpl.id)}
          title="Add a Pose Sequence to this instrument"
        >
          + Sequence
        </button>
      </div>

      {/* Lane body — the cards */}
      {empty ? (
        <div className="px-2.5 py-3 text-[10px] text-muted italic">
          No signals yet. A State Trigger fires MIDI when a pose is reached; a
          Pose Sequence fires a note at each pose as you move through an ordered
          phrase.
        </div>
      ) : (
        <div className="p-2 flex flex-col gap-3">
          {triggers.length > 0 && (
            <div className="flex flex-col gap-1.5">
              <div className="text-[9px] uppercase tracking-wider text-muted px-0.5">
                State Triggers
              </div>
              <div
                className="grid gap-2 items-start"
                style={{
                  gridTemplateColumns: `repeat(auto-fill, minmax(${cardW}px, 1fr))`
                }}
              >
                {triggers.map((trig) => (
                  <StateTriggerCard
                    key={trig.id}
                    template={tpl}
                    trig={trig}
                    score={live.scores[`${tpl.id}|${trig.id}`] ?? 0}
                    isActive={live.active[`${tpl.id}|${trig.id}`] === true}
                  />
                ))}
              </div>
            </div>
          )}
          {sequences.length > 0 && (
            <div className="flex flex-col gap-1.5">
              <div className="text-[9px] uppercase tracking-wider text-muted px-0.5">
                Pose Sequences
              </div>
              <div
                className="grid gap-2 items-start"
                style={{
                  gridTemplateColumns: `repeat(auto-fill, minmax(${cardW}px, 1fr))`
                }}
              >
                {sequences.map((seq) => {
                  const key = `${tpl.id}|${seq.id}`
                  return (
                    <PoseSequenceCard
                      key={seq.id}
                      template={tpl}
                      seq={seq}
                      liveStep={live.seqSteps[key]}
                      liveScore={live.seqScores[key] ?? 0}
                    />
                  )
                })}
              </div>
            </div>
          )}
        </div>
      )}
    </section>
  )
}
