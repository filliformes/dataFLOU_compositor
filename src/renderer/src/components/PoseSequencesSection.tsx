// Pose Sequences section (v0.6.5) — an ordered "phrase" of learned
// poses ("waypoints"). As the performer moves THROUGH the poses in
// order, each one fires its MIDI note/CC (and/or a dataFLOU scene) when
// reached. Think of a State Trigger as a single freeze-frame; a Pose
// Sequence is the whole video: pose A → note, pose B → note, pose C → …
//
// Strict order (only the next expected waypoint can fire), Wait-in-place
// (a stray pose never rewinds the playhead), Loop (wrap to the start) or
// one-shot (park on the last, until Reset). The engine runs the state
// machine per incoming packet AFTER Input Conditioning
// (engine.ts evaluatePoseSequences); this component is the config
// surface + the live playhead / match meter (polled ~10 Hz).
//
// Each waypoint's pose is recorded by demonstration exactly like a
// learned State Trigger (same stateTriggerRecord round-trip, keyed by
// the waypoint id). Embedded in BOTH the Pool TemplateInspector and the
// grid-side TrackInspector, right under State Triggers.

import { useEffect, useRef, useState, type CSSProperties } from 'react'
import { useStore } from '../store'
import { BoundedNumberInput } from './BoundedNumberInput'
import { UncontrolledTextInput } from './UncontrolledInput'
import type {
  InstrumentTemplate,
  PoseSequence,
  PoseWaypoint,
  StateMidiAction
} from '@shared/types'

// A distinct, stable hue per pose index so each "pose number" reads as
// its own color across the whole sequence (golden-angle spacing keeps
// adjacent poses far apart on the wheel). Exported so the Signals view
// can match the palette. Mid-lightness so dark text stays legible.
export function poseColor(index: number): string {
  const hue = (index * 47) % 360
  return `hsl(${hue}, 68%, 58%)`
}

// Companion-recorder phase for a waypoint row: where it sits in the
// hands-free record cycle.
type RecState = 'idle' | 'pending' | 'ready' | 'rec' | 'done'

// Await `ms`, calling onTick(msRemaining) ~20 Hz so a countdown/progress
// bar animates, and bailing early if the cancel token trips. Renderer-
// side (Date.now is fine here — the restriction is Workflow scripts only).
function waitTicks(
  ms: number,
  token: { cancelled: boolean },
  onTick: (left: number) => void
): Promise<void> {
  return new Promise((resolve) => {
    const start = Date.now()
    const iv = setInterval(() => {
      const left = Math.max(0, ms - (Date.now() - start))
      onTick(left)
      if (left <= 0 || token.cancelled) {
        clearInterval(iv)
        resolve()
      }
    }, 50)
  })
}

export function PoseSequencesSection({
  template
}: {
  template: InstrumentTemplate
}): JSX.Element {
  const addPoseSequence = useStore((s) => s.addPoseSequence)
  const sequences = template.poseSequences ?? []
  // Live playhead (current waypoint index) + current-step match score,
  // one poll for the whole section. seqSteps[key] === waypoint count
  // means a non-looping phrase has completed.
  const [live, setLive] = useState<{
    seqSteps: Record<string, number>
    seqScores: Record<string, number>
  }>({ seqSteps: {}, seqScores: {} })
  useEffect(() => {
    if (sequences.length === 0) return
    let alive = true
    const iv = setInterval(async () => {
      const r = await window.api?.stateTriggerGetLive?.()
      if (alive && r) {
        setLive({ seqSteps: r.seqSteps ?? {}, seqScores: r.seqScores ?? {} })
      }
    }, 100)
    return () => {
      alive = false
      clearInterval(iv)
    }
  }, [sequences.length])

  return (
    <div className="border border-border rounded p-1.5 flex flex-col gap-1.5 bg-panel2/30">
      <div
        className="flex items-center gap-1.5"
        title={
          'A Pose Sequence is an ordered phrase of poses. As you move THROUGH them in order, each fires its MIDI (and/or a dataFLOU scene) when reached — pose A → note, then pose B → note, then C…\n\n' +
          'Strict order: only the next expected pose fires (skipping ahead does nothing).\n' +
          'Wait-in-place: a stray pose never rewinds — the playhead simply waits.\n' +
          'Loop: wrap back to the first pose after the last. One-shot: park on the last until Reset.\n\n' +
          'Each pose is recorded by demonstration (hold it, hit Record) exactly like a learned State Trigger, and runs on the CONDITIONED stream — add smoothing in Input Conditioning above for stable steps.'
        }
      >
        <span className="label">Pose Sequences</span>
        <span
          className="inline-flex items-center justify-center w-3 h-3 rounded-full text-[8px] cursor-help select-none shrink-0"
          style={{
            border: '1px solid rgb(var(--c-muted))',
            color: 'rgb(var(--c-muted))'
          }}
          aria-label="Help: Pose Sequences"
        >
          i
        </span>
        <div className="flex-1" />
        <button
          className="btn text-[10px]"
          onClick={() => addPoseSequence(template.id)}
          title="Add a new pose sequence"
        >
          + Sequence
        </button>
      </div>
      {sequences.length === 0 && (
        <div className="text-[10px] text-muted italic">
          No sequences yet. A sequence is an ordered set of poses you move
          through — each one fires a MIDI event as you pass it.
        </div>
      )}
      {sequences.map((seq) => {
        const key = `${template.id}|${seq.id}`
        return (
          <PoseSequenceCard
            key={seq.id}
            template={template}
            seq={seq}
            liveStep={live.seqSteps[key]}
            liveScore={live.seqScores[key] ?? 0}
          />
        )
      })}
    </div>
  )
}

export function PoseSequenceCard({
  template,
  seq,
  liveStep,
  liveScore
}: {
  template: InstrumentTemplate
  seq: PoseSequence
  liveStep: number | undefined
  liveScore: number
}): JSX.Element {
  const updatePoseSequence = useStore((s) => s.updatePoseSequence)
  const removePoseSequence = useStore((s) => s.removePoseSequence)
  const addWaypoint = useStore((s) => s.addWaypoint)
  const updateWaypoint = useStore((s) => s.updateWaypoint)
  const poseRecordBusy = useStore((s) => s.poseRecordBusy)
  const setPoseRecordBusy = useStore((s) => s.setPoseRecordBusy)
  const [expanded, setExpanded] = useState(true)
  const patch = (p: Partial<PoseSequence>): void =>
    updatePoseSequence(template.id, seq.id, p)

  // ── Companion recorder — hands-free capture of the WHOLE sequence.
  // Cycles pose by pose: a get-ready countdown (move into position),
  // then records that pose for `recordHoldMs`, stores it, advances. The
  // banner + per-row highlights show exactly where you are.
  const [rec, setRec] = useState<{ phase: 'ready' | 'rec'; step: number } | null>(
    null
  )
  const [recMsLeft, setRecMsLeft] = useState(0)
  const cancelRef = useRef<{ cancelled: boolean } | null>(null)
  const aliveRef = useRef(true)
  useEffect(() => {
    aliveRef.current = true
    const tid = template.id
    const sid = seq.id
    return () => {
      aliveRef.current = false
      if (cancelRef.current) {
        cancelRef.current.cancelled = true
        // We owned an in-flight companion run → release its engine-side
        // suppression + busy flag so nothing stays paused after unmount.
        void window.api?.poseSequenceSuppress?.(tid, sid, false)
        setPoseRecordBusy(false)
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const total = seq.waypoints.length
  const holdMs = seq.recordHoldMs ?? 2000
  const READY_MS = 2500 // get-into-position countdown before each pose
  const completed = liveStep !== undefined && liveStep >= total && total > 0
  // The waypoint the live playhead is waiting on (perform mode). -1 = idle.
  const currentStep = completed ? -1 : liveStep ?? -1

  function stopCompanion(): void {
    if (cancelRef.current) cancelRef.current.cancelled = true
    // Un-suppress + release the app-wide record lock immediately; the
    // loop epilogue also does this, but a long record-await could delay
    // it, and the user just asked to stop.
    void window.api?.poseSequenceSuppress?.(template.id, seq.id, false)
    setPoseRecordBusy(false)
    setRec(null)
    setRecMsLeft(0)
  }

  async function runCompanion(): Promise<void> {
    // Bail if THIS card is running, or ANY capture is in flight anywhere
    // (single engine record slot — a second would corrupt the first).
    if (rec || total === 0 || poseRecordBusy) return
    setExpanded(true)
    const token = { cancelled: false }
    cancelRef.current = token
    setPoseRecordBusy(true)
    // Pause this sequence's live firing for the whole run, and rewind the
    // playhead so performing right after a record is clean.
    void window.api?.poseSequenceSuppress?.(template.id, seq.id, true)
    void window.api?.poseSequenceReset?.(template.id, seq.id)
    for (let k = 0; k < seq.waypoints.length; k++) {
      if (token.cancelled || !aliveRef.current) break
      const wp = seq.waypoints[k]
      // Only the loop that still owns cancelRef may write shared state —
      // otherwise a cancelled loop whose await is still settling could
      // clobber a newer run started after Stop → Rec-Seq.
      const tick = (l: number): void => {
        if (aliveRef.current && cancelRef.current === token) setRecMsLeft(l)
      }
      // 1) Get-ready countdown — move into the pose.
      setRec({ phase: 'ready', step: k })
      await waitTicks(READY_MS, token, tick)
      if (token.cancelled || !aliveRef.current) break
      // 2) Record — the engine collects the conditioned stream for holdMs.
      //    Animate the bar alongside the (slightly longer) await.
      setRec({ phase: 'rec', step: k })
      void waitTicks(holdMs, token, tick)
      const result = await window.api?.stateTriggerRecord?.(
        template.id,
        wp.id,
        holdMs
      )
      if (token.cancelled || !aliveRef.current) break
      if (result) {
        updateWaypoint(template.id, seq.id, wp.id, {
          learned: {
            ...result,
            threshold: wp.learned?.threshold ?? result.threshold
          }
        })
      } else {
        // Silent device → stop here. Mark the token cancelled so the
        // fire-and-forget record-bar ticker stops immediately instead of
        // running out the full hold window.
        token.cancelled = true
        if (aliveRef.current) {
          window.alert(
            `No data captured for "${wp.name}". Turn Hardware Mode ON for this instrument, make sure the device is streaming, then try again.`
          )
        }
        break
      }
    }
    // Tear down ONLY if we still own the run — a newer run may have
    // replaced us (Stop → Rec-Seq) while our final await was settling.
    if (cancelRef.current === token) {
      void window.api?.poseSequenceSuppress?.(template.id, seq.id, false)
      void window.api?.poseSequenceReset?.(template.id, seq.id)
      setPoseRecordBusy(false)
      if (aliveRef.current) {
        setRec(null)
        setRecMsLeft(0)
      }
      cancelRef.current = null
    }
  }

  const rowRecState = (i: number): RecState => {
    if (!rec) return 'idle'
    if (i < rec.step) return 'done'
    if (i === rec.step) return rec.phase
    return 'pending'
  }

  // Progress fraction for the banner bar: ready counts DOWN, rec FILLS.
  const phaseTotal = rec?.phase === 'rec' ? holdMs : READY_MS
  const frac = phaseTotal > 0 ? recMsLeft / phaseTotal : 0
  const barPct = rec?.phase === 'rec' ? (1 - frac) * 100 : frac * 100

  return (
    <div
      className="border rounded px-1.5 py-1 flex flex-col gap-1"
      style={{
        opacity: seq.enabled ? 1 : 0.55,
        borderColor: rec ? 'rgb(var(--c-accent))' : 'rgb(var(--c-border))',
        boxShadow: rec ? '0 0 0 1px rgb(var(--c-accent)), 0 0 12px rgb(var(--c-accent) / 0.3)' : undefined
      }}
    >
      {/* Header: enable, name, playhead, Rec-Seq, loop, reset, expand, delete */}
      <div className="flex items-center gap-1.5">
        <input
          type="checkbox"
          checked={seq.enabled}
          onChange={(e) => patch({ enabled: e.target.checked })}
          title="Enable / disable this sequence"
        />
        <UncontrolledTextInput
          size={2}
          className="input flex-1 min-w-0 text-[11px] font-semibold"
          value={seq.name}
          onChange={(v) => patch({ name: v })}
        />
        {/* Playhead readout — which step we're on / how far through. */}
        <span
          className="text-[9px] font-bold tabular-nums shrink-0"
          style={{
            color: completed
              ? 'rgb(var(--c-accent))'
              : currentStep >= 0
                ? 'rgb(var(--c-accent))'
                : 'rgb(var(--c-muted))'
          }}
          title={
            completed
              ? 'Sequence complete — hit ↺ to rewind.'
              : 'Current step of the sequence.'
          }
        >
          {completed ? '✓ done' : total > 0 ? `${currentStep + 1}/${total}` : '0/0'}
        </span>
        {/* Companion record — the whole-sequence hands-free recorder. */}
        <button
          className="btn text-[9px] px-1.5 font-semibold"
          disabled={total === 0 || (poseRecordBusy && !rec)}
          onClick={() => (rec ? stopCompanion() : void runCompanion())}
          style={
            rec
              ? { color: 'rgb(var(--c-danger))', borderColor: 'rgb(var(--c-danger))' }
              : { color: 'rgb(var(--c-accent))', borderColor: 'rgb(var(--c-accent))' }
          }
          title="Companion recorder — records the WHOLE sequence hands-free. It counts you in, records each pose for the Hold time, then advances. Just move into each pose as it comes up."
        >
          {rec ? '■ Stop' : '⏺ Rec Seq'}
        </button>
        <button
          className="btn text-[9px] px-1"
          onClick={() => patch({ loop: !seq.loop })}
          title={
            seq.loop
              ? 'Looping — wraps back to the first pose after the last. Click for one-shot.'
              : 'One-shot — parks on the last pose until Reset. Click to loop.'
          }
          style={
            seq.loop
              ? { color: 'rgb(var(--c-accent))', borderColor: 'rgb(var(--c-accent))' }
              : undefined
          }
        >
          ↻
        </button>
        <button
          className="btn text-[9px] px-1"
          onClick={() => void window.api?.poseSequenceReset?.(template.id, seq.id)}
          title="Rewind to the first pose (also clears a completed one-shot)."
        >
          ↺
        </button>
        <button
          className="btn text-[9px] px-1"
          onClick={() => setExpanded((x) => !x)}
          title={expanded ? 'Collapse' : 'Expand'}
        >
          {expanded ? '▾' : '▸'}
        </button>
        <button
          className="btn text-[9px] px-1"
          onClick={() => {
            if (window.confirm(`Delete sequence "${seq.name}"?`)) {
              removePoseSequence(template.id, seq.id)
            }
          }}
          title="Delete sequence"
        >
          ✕
        </button>
      </div>

      {/* Companion-recorder banner — the live "what's happening now". */}
      {rec && (
        <div
          className="rounded px-2 py-1.5 flex flex-col gap-1"
          style={{
            border: '1px solid rgb(var(--c-accent))',
            background: 'rgb(var(--c-accent) / 0.1)'
          }}
        >
          <div className="flex items-center gap-2">
            <span
              className="text-[11px] shrink-0"
              style={{ color: 'rgb(var(--c-danger))' }}
            >
              {rec.phase === 'rec' ? (
                <span className="animate-pulse font-bold">● REC</span>
              ) : (
                <span className="font-bold">◷</span>
              )}
            </span>
            <span className="text-[11px] font-semibold">
              {rec.phase === 'ready'
                ? `Get into Pose ${rec.step + 1} — ${seq.waypoints[rec.step]?.name ?? ''}`
                : `Recording Pose ${rec.step + 1} — ${seq.waypoints[rec.step]?.name ?? ''}`}
            </span>
            <span className="text-[10px] tabular-nums text-muted">
              {(recMsLeft / 1000).toFixed(1)}s
            </span>
            <div className="flex-1" />
            <span className="text-[9px] text-muted tabular-nums">
              {rec.step + 1}/{total}
            </span>
            <button
              className="btn text-[9px] px-1.5"
              onClick={stopCompanion}
              style={{
                color: 'rgb(var(--c-danger))',
                borderColor: 'rgb(var(--c-danger))'
              }}
            >
              ■ Stop
            </button>
          </div>
          <div
            className="h-1.5 rounded overflow-hidden"
            style={{ background: 'rgb(var(--c-panel))' }}
          >
            <div
              className="h-full transition-[width] duration-75"
              style={{
                width: `${barPct}%`,
                background:
                  rec.phase === 'rec'
                    ? 'rgb(var(--c-danger))'
                    : 'rgb(var(--c-accent))'
              }}
            />
          </div>
          <div className="text-[9px] text-muted">
            {rec.phase === 'ready'
              ? 'Move into the next pose and hold still…'
              : 'Hold the pose still until the bar fills.'}
          </div>
        </div>
      )}

      {expanded && (
        <>
          <div className="flex items-center gap-2 flex-wrap">
            <label
              className="flex items-center gap-1"
              title="Each pose must be held this long before it fires and the playhead advances — debounces glancing passes through a pose."
            >
              <span className="label">Dwell ms</span>
              <BoundedNumberInput
                className="input w-14 text-[10px] text-right tabular-nums"
                value={seq.dwellMs}
                min={0}
                max={5000}
                integer
                commitOn="blur"
                onChange={(v) => patch({ dwellMs: v })}
              />
            </label>
            <label
              className="flex items-center gap-1"
              title="Companion recorder: how long to hold & record EACH pose while cycling through the sequence."
            >
              <span className="label">Hold ms</span>
              <BoundedNumberInput
                className="input w-14 text-[10px] text-right tabular-nums"
                value={seq.recordHoldMs ?? 2000}
                min={250}
                max={30000}
                integer
                commitOn="blur"
                onChange={(v) => patch({ recordHoldMs: v })}
              />
            </label>
            <span className="text-[10px] text-muted">
              {total} pose{total === 1 ? '' : 's'}
            </span>
          </div>
          <div className="flex flex-col gap-1">
            {seq.waypoints.map((wp, i) => (
              <WaypointRow
                key={wp.id}
                template={template}
                seq={seq}
                wp={wp}
                index={i}
                isCurrent={currentStep === i}
                liveScore={currentStep === i ? liveScore : 0}
                recState={rowRecState(i)}
                recMsLeft={rec && rec.step === i ? recMsLeft : 0}
                recPhaseTotal={phaseTotal}
                busy={rec !== null}
              />
            ))}
          </div>
          <button
            className="btn text-[10px] self-start"
            disabled={rec !== null}
            onClick={() => addWaypoint(template.id, seq.id)}
            title="Add a pose to the end of the sequence."
          >
            + Pose
          </button>
        </>
      )}
    </div>
  )
}

function WaypointRow({
  template,
  seq,
  wp,
  index,
  isCurrent,
  liveScore,
  recState,
  recMsLeft,
  recPhaseTotal,
  busy
}: {
  template: InstrumentTemplate
  seq: PoseSequence
  wp: PoseWaypoint
  index: number
  isCurrent: boolean
  liveScore: number
  recState: RecState
  recMsLeft: number
  recPhaseTotal: number
  busy: boolean
}): JSX.Element {
  const updateWaypoint = useStore((s) => s.updateWaypoint)
  const removeWaypoint = useStore((s) => s.removeWaypoint)
  const moveWaypoint = useStore((s) => s.moveWaypoint)
  const scenes = useStore((s) => s.session.scenes)
  const poseRecordBusy = useStore((s) => s.poseRecordBusy)
  const setPoseRecordBusy = useStore((s) => s.setPoseRecordBusy)
  // Pose details open by default now — collapsed was confusing.
  const [expanded, setExpanded] = useState(true)
  const [recording, setRecording] = useState(false)
  const [recordMs, setRecordMs] = useState(2000)
  const aliveRef = useRef(true)
  useEffect(() => {
    aliveRef.current = true
    return () => {
      aliveRef.current = false
    }
  }, [])
  const patch = (p: Partial<PoseWaypoint>): void =>
    updateWaypoint(template.id, seq.id, wp.id, p)

  async function record(): Promise<void> {
    if (poseRecordBusy) return // another capture is already running
    setRecording(true)
    setPoseRecordBusy(true)
    try {
      // Reuse the State-Trigger learn round-trip — the engine keys the
      // recording by template only, so the waypoint id is just an id.
      const result = await window.api?.stateTriggerRecord?.(
        template.id,
        wp.id,
        recordMs
      )
      if (!aliveRef.current) return
      if (result) {
        patch({
          learned: {
            ...result,
            // Preserve a user-tuned threshold across re-records.
            threshold: wp.learned?.threshold ?? result.threshold
          }
        })
      } else {
        window.alert(
          'Nothing recorded — the bound Hardware-Mode device sent no packets during the window. Check that HW Mode is enabled and the device is streaming.'
        )
      }
    } finally {
      setPoseRecordBusy(false)
      if (aliveRef.current) setRecording(false)
    }
  }

  const dimCount = wp.learned?.dims.length ?? 0
  const hue = poseColor(index)
  const isRec = recState === 'rec'
  const isReady = recState === 'ready'
  const isDone = recState === 'done'
  // Companion recording dominates the row visual; otherwise the live
  // perform playhead (isCurrent) provides the subtle highlight.
  const rowStyle: React.CSSProperties = isRec
    ? {
        outline: '2px solid rgb(var(--c-danger))',
        background: 'rgb(var(--c-danger) / 0.14)',
        boxShadow: '0 0 12px rgb(var(--c-danger) / 0.35)'
      }
    : isReady
      ? {
          outline: '2px dashed rgb(var(--c-accent))',
          background: 'rgb(var(--c-accent) / 0.1)'
        }
      : isDone
        ? {
            outline: '1px solid rgb(var(--c-success))',
            background: 'rgb(var(--c-success) / 0.08)'
          }
        : recState === 'pending'
          ? { opacity: 0.5 }
          : {
              outline: isCurrent ? '1px solid rgb(var(--c-accent))' : undefined,
              background: isCurrent ? 'rgb(var(--c-accent) / 0.08)' : undefined
            }

  return (
    <div
      className="border border-border rounded px-1 py-0.5 flex flex-col gap-1"
      style={{ borderLeft: `3px solid ${hue}`, ...rowStyle }}
    >
      <div className="flex items-center gap-1.5">
        {/* Step number badge — its own color per pose, with a ring while
            it's the live playhead or the pose being recorded. */}
        <span
          className={`inline-flex items-center justify-center w-5 h-5 rounded-full text-[10px] font-bold shrink-0 ${
            isRec ? 'animate-pulse' : ''
          }`}
          style={{
            background: hue,
            color: '#0a0a0a',
            boxShadow:
              isRec || isReady
                ? '0 0 0 2px rgb(var(--c-danger))'
                : isCurrent
                  ? '0 0 0 2px rgb(var(--c-accent))'
                  : `0 0 0 1px ${hue}`
          }}
          title={`Pose ${index + 1}`}
        >
          {index + 1}
        </span>
        <UncontrolledTextInput
          size={2}
          className="input flex-1 min-w-0 text-[10px]"
          value={wp.name}
          onChange={(v) => patch({ name: v })}
        />
        {/* Companion-record status chip, or the live match meter. */}
        {recState !== 'idle' ? (
          <span
            className="text-[9px] font-bold tabular-nums shrink-0 w-14 text-center"
            style={{
              color: isRec
                ? 'rgb(var(--c-danger))'
                : isDone
                  ? 'rgb(var(--c-success))'
                  : isReady
                    ? 'rgb(var(--c-accent))'
                    : 'rgb(var(--c-muted))'
            }}
          >
            {isRec
              ? `● ${(recMsLeft / 1000).toFixed(1)}s`
              : isReady
                ? `◷ ${(recMsLeft / 1000).toFixed(1)}s`
                : isDone
                  ? '✓ saved'
                  : 'waiting'}
          </span>
        ) : (
          <div
            className="w-14 h-2 rounded overflow-hidden border border-border shrink-0"
            title={
              isCurrent
                ? `Live match: ${(liveScore * 100).toFixed(0)}% (this is the current step)`
                : 'Only the current step is being matched'
            }
            style={{ background: 'rgb(var(--c-panel))', opacity: isCurrent ? 1 : 0.4 }}
          >
            <div
              className="h-full"
              style={{
                width: `${Math.round(liveScore * 100)}%`,
                background: 'rgb(var(--c-accent))'
              }}
            />
          </div>
        )}
        <button
          className="btn text-[9px] px-1"
          disabled={index === 0 || busy}
          onClick={() => moveWaypoint(template.id, seq.id, wp.id, -1)}
          title="Move earlier"
        >
          ↑
        </button>
        <button
          className="btn text-[9px] px-1"
          disabled={index === seq.waypoints.length - 1 || busy}
          onClick={() => moveWaypoint(template.id, seq.id, wp.id, 1)}
          title="Move later"
        >
          ↓
        </button>
        <button
          className="btn text-[9px] px-1"
          onClick={() => setExpanded((x) => !x)}
          title={expanded ? 'Collapse' : 'Expand'}
        >
          {expanded ? '▾' : '▸'}
        </button>
        <button
          className="btn text-[9px] px-1"
          disabled={busy}
          onClick={() => removeWaypoint(template.id, seq.id, wp.id)}
          title="Delete this pose"
        >
          ✕
        </button>
      </div>
      {expanded && (
        <div className="flex flex-col gap-1 pl-1">
          {/* Record + captured-dims readout */}
          <div className="flex items-center gap-1.5 flex-wrap">
            <button
              className="btn text-[10px]"
              disabled={recording || busy || (poseRecordBusy && !recording)}
              onClick={() => void record()}
              style={
                recording
                  ? { color: 'rgb(var(--c-danger))', borderColor: 'rgb(var(--c-danger))' }
                  : undefined
              }
              title="Record just this one pose. (For the whole sequence at once, use ⏺ Rec Seq at the top.) Hold the pose, click, and KEEP HOLDING until the window ends."
            >
              {recording ? '● Recording…' : '● Record pose'}
            </button>
            <BoundedNumberInput
              className="input w-14 text-[10px] text-right tabular-nums"
              value={recordMs}
              min={250}
              max={30000}
              integer
              commitOn="blur"
              onChange={(v) => setRecordMs(v)}
              title="Recording window in ms"
            />
            <span className="text-[10px] text-muted">
              {dimCount > 0 ? `${dimCount} dims captured` : 'nothing recorded yet'}
            </span>
          </div>
          {wp.learned && (
            <>
              <label
                className="flex items-center gap-1.5"
                title="Forgiveness — how loose the pose match is. Higher = a wider acceptance band (you don't have to be exact, and small sensor drift is tolerated). Usually the knob to turn if a step is too fussy."
              >
                <span className="label shrink-0">Tolerance</span>
                <input
                  type="range"
                  className="flex-1"
                  min={0.02}
                  max={1}
                  step={0.01}
                  value={wp.learned.tolerance ?? 0.3}
                  onChange={(e) =>
                    patch({
                      learned: { ...wp.learned!, tolerance: parseFloat(e.target.value) }
                    })
                  }
                />
                <span className="text-[10px] tabular-nums w-8 text-right">
                  {Math.round((wp.learned.tolerance ?? 0.3) * 100)}%
                </span>
              </label>
              <label
                className="flex items-center gap-1.5"
                title="Match threshold — the live score must reach this for the step to fire. Hold the pose, read the meter's peak, set this a bit below it."
              >
                <span className="label shrink-0">Threshold</span>
                <input
                  type="range"
                  className="flex-1"
                  min={0.05}
                  max={0.99}
                  step={0.01}
                  value={wp.learned.threshold}
                  onChange={(e) =>
                    patch({
                      learned: { ...wp.learned!, threshold: parseFloat(e.target.value) }
                    })
                  }
                />
                <span className="text-[10px] tabular-nums w-8 text-right">
                  {(wp.learned.threshold * 100).toFixed(0)}%
                </span>
              </label>
              <WaypointDimsEditor wp={wp} onPatch={patch} />
            </>
          )}
          <WaypointMidiEditor wp={wp} scenes={scenes} onPatch={patch} />
        </div>
      )}
    </div>
  )
}

// Dimension checklist for a waypoint's learned pose — pick which
// incoming channels define it. Untick drifty / irrelevant ones (yaw,
// gyro, magnetometer, buttons) so the match doesn't decay as they
// drift. Mirror of StateTriggersSection's LearnedDimsEditor.
function WaypointDimsEditor({
  wp,
  onPatch
}: {
  wp: PoseWaypoint
  onPatch: (p: Partial<PoseWaypoint>) => void
}): JSX.Element | null {
  const [open, setOpen] = useState(false)
  const L = wp.learned
  if (!L || L.dims.length === 0) return null
  const enabledCount = L.dims.filter((d) => d.enabled !== false).length
  const multiSlot = new Set(
    L.dims
      .filter((d, _i, arr) => arr.filter((x) => x.address === d.address).length > 1)
      .map((d) => d.address)
  )
  const patchDims = (dims: typeof L.dims): void => onPatch({ learned: { ...L, dims } })
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center gap-1.5">
        <button
          className="btn text-[10px]"
          onClick={() => setOpen((o) => !o)}
          title="Pick which inputs define this pose. Untick drifty / irrelevant channels (yaw, gyro, magnetometer, buttons) so the step doesn't decay as they drift."
        >
          {open ? '▾' : '▸'} Inputs ({enabledCount}/{L.dims.length})
        </button>
        {open && (
          <>
            <button
              className="btn text-[9px] px-1"
              onClick={() => patchDims(L.dims.map((d) => ({ ...d, enabled: true })))}
            >
              all
            </button>
            <button
              className="btn text-[9px] px-1"
              onClick={() => patchDims(L.dims.map((d) => ({ ...d, enabled: false })))}
            >
              none
            </button>
          </>
        )}
      </div>
      {open && (
        <div className="flex flex-col gap-0.5 max-h-40 overflow-y-auto border border-border rounded p-1">
          {L.dims.map((d, i) => (
            <label
              key={`${d.address}|${d.slot}`}
              className="flex items-center gap-1 text-[10px]"
              title={`${d.address} slot ${d.slot}`}
            >
              <input
                type="checkbox"
                checked={d.enabled !== false}
                onChange={(e) =>
                  patchDims(
                    L.dims.map((dd, j) =>
                      j === i ? { ...dd, enabled: e.target.checked } : dd
                    )
                  )
                }
              />
              <span className="truncate">
                {d.address}
                {multiSlot.has(d.address) ? ` [${d.slot}]` : ''}
              </span>
            </label>
          ))}
        </div>
      )}
    </div>
  )
}

// MIDI (+ scene) action for a single waypoint. Momentary: a Note fires
// a short gated note as the pose is passed; a CC sends its "enter"
// value. Mirror of StateActionsEditor, minus the enter/exit split
// (waypoints have no exit event).
function WaypointMidiEditor({
  wp,
  scenes,
  onPatch
}: {
  wp: PoseWaypoint
  scenes: { id: string; name: string }[]
  onPatch: (p: Partial<PoseWaypoint>) => void
}): JSX.Element {
  const m = wp.midi
  const [ports, setPorts] = useState<string[]>([])
  useEffect(() => {
    void window.api
      ?.midiListPorts?.()
      .then((r) => setPorts(r?.ports ?? []))
      .catch(() => setPorts([]))
  }, [])
  function patchMidi(p: Partial<StateMidiAction>): void {
    onPatch({
      midi: {
        enabled: true,
        portName: '',
        channel: 1,
        kind: 'note',
        note: 60,
        velocity: 100,
        cc: 20,
        ccEnterValue: 127,
        ccExitValue: 0,
        ...m,
        ...p
      }
    })
  }
  return (
    <div className="border-t border-border pt-1 flex flex-col gap-1">
      <div className="flex items-center gap-1.5 flex-wrap">
        <label className="flex items-center gap-1" title="Send MIDI when this pose is reached">
          <input
            type="checkbox"
            checked={m?.enabled === true}
            onChange={(e) => patchMidi({ enabled: e.target.checked })}
          />
          <span className="label">MIDI</span>
        </label>
        {m?.enabled && (
          <>
            <select
              className="input text-[10px] min-w-0"
              style={{ maxWidth: 120 }}
              value={m.portName}
              onChange={(e) => patchMidi({ portName: e.target.value })}
              title="MIDI output port"
            >
              <option value="">(pick a port)</option>
              {!ports.includes(m.portName) && m.portName && (
                <option value={m.portName}>{m.portName}</option>
              )}
              {ports.map((p) => (
                <option key={p} value={p}>
                  {p}
                </option>
              ))}
            </select>
            <label className="flex items-center gap-1">
              <span className="label">Ch</span>
              <BoundedNumberInput
                className="input w-8 text-[10px] text-center tabular-nums"
                value={m.channel}
                min={1}
                max={16}
                integer
                commitOn="blur"
                onChange={(v) => patchMidi({ channel: v })}
              />
            </label>
            <select
              className="input text-[10px]"
              value={m.kind}
              onChange={(e) => patchMidi({ kind: e.target.value as 'note' | 'cc' })}
              title="Note: a short gated note fires as the pose is passed. CC: sends the value below."
            >
              <option value="note">Note</option>
              <option value="cc">CC</option>
            </select>
            {m.kind === 'note' ? (
              <>
                <label className="flex items-center gap-1">
                  <span className="label">Note</span>
                  <BoundedNumberInput
                    className="input w-10 text-[10px] text-center tabular-nums"
                    value={m.note ?? 60}
                    min={0}
                    max={127}
                    integer
                    commitOn="blur"
                    onChange={(v) => patchMidi({ note: v })}
                  />
                </label>
                <label className="flex items-center gap-1">
                  <span className="label">Vel</span>
                  <BoundedNumberInput
                    className="input w-10 text-[10px] text-center tabular-nums"
                    value={m.velocity ?? 100}
                    min={1}
                    max={127}
                    integer
                    commitOn="blur"
                    onChange={(v) => patchMidi({ velocity: v })}
                  />
                </label>
              </>
            ) : (
              <>
                <label className="flex items-center gap-1">
                  <span className="label">CC</span>
                  <BoundedNumberInput
                    className="input w-10 text-[10px] text-center tabular-nums"
                    value={m.cc ?? 20}
                    min={0}
                    max={127}
                    integer
                    commitOn="blur"
                    onChange={(v) => patchMidi({ cc: v })}
                  />
                </label>
                <label className="flex items-center gap-1" title="CC value sent when the pose is reached">
                  <span className="label">Val</span>
                  <BoundedNumberInput
                    className="input w-10 text-[10px] text-center tabular-nums"
                    value={m.ccEnterValue ?? 127}
                    min={0}
                    max={127}
                    integer
                    commitOn="blur"
                    onChange={(v) => patchMidi({ ccEnterValue: v })}
                  />
                </label>
              </>
            )}
          </>
        )}
      </div>
      <label
        className="flex items-center gap-1.5"
        title="Also trigger a dataFLOU scene when this pose is reached. The scene runs its own lifecycle afterward."
      >
        <span className="label shrink-0">Scene</span>
        <select
          className="input text-[10px] flex-1 min-w-0"
          value={wp.triggerSceneId ?? ''}
          onChange={(e) =>
            onPatch(
              e.target.value
                ? { triggerSceneId: e.target.value }
                : { triggerSceneId: undefined }
            )
          }
        >
          <option value="">(none)</option>
          {scenes.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>
      </label>
    </div>
  )
}
