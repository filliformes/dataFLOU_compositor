import { useEffect, useState } from 'react'
import type { Scene } from '@shared/types'
import { useStore } from '../store'

// (v0.6.x) Motion Loop — record the live Hardware-Mode stream into this
// scene's cells (free-run), then loop it on playback. Rendered in BOTH
// scene surfaces: the Sequence view's Scene Inspector and the Grid view's
// scene header. Recording is global (one scene at a time); the shared
// store state keeps both surfaces in sync.
export function MotionLoopControls({ scene }: { scene: Scene }): JSX.Element {
  const recordingSceneId = useStore((s) => s.recordingLoopSceneId)
  const recordingStartedAt = useStore((s) => s.recordingLoopStartedAt)
  const startRec = useStore((s) => s.startMotionLoopRecord)
  const stopRec = useStore((s) => s.stopMotionLoopRecord)
  const clearLoop = useStore((s) => s.clearMotionLoop)
  const setEnabled = useStore((s) => s.setRecordedLoopEnabled)

  const isRecordingThis = recordingSceneId === scene.id
  const isRecordingOther = recordingSceneId != null && !isRecordingThis

  // Live elapsed clock while recording this scene.
  const [nowMs, setNowMs] = useState(() => Date.now())
  useEffect(() => {
    if (!isRecordingThis) return
    const id = setInterval(() => setNowMs(Date.now()), 100)
    return () => clearInterval(id)
  }, [isRecordingThis])

  // Summarise recorded loops on this scene.
  const loopCells = Object.values(scene.cells).filter((c) => c.recordedLoop)
  const hasLoop = loopCells.length > 0
  const anyEnabled = loopCells.some((c) => c.recordedLoop?.enabled)
  const durationMs = hasLoop
    ? Math.max(...loopCells.map((c) => c.recordedLoop?.durationMs ?? 0))
    : 0
  const elapsedS =
    isRecordingThis && recordingStartedAt != null
      ? (nowMs - recordingStartedAt) / 1000
      : 0

  return (
    <div className="flex flex-col gap-1 border border-border rounded p-1.5 bg-panel2/30">
      <div className="flex items-center gap-1.5">
        <span className="label">Motion Loop</span>
        <span
          className="inline-flex items-center justify-center w-3 h-3 rounded-full text-[8px] cursor-help select-none shrink-0"
          style={{ border: '1px solid rgb(var(--c-muted))', color: 'rgb(var(--c-muted))' }}
          aria-label="Help: Motion Loop"
          title={
            'Records the live hardware stream (conditioned + scaled) into THIS scene’s parameters over N seconds, then loops it back out when the scene plays.\n\n' +
            'Workflow: hit Record, move the controller, hit Stop. Every hardware-mapped parameter becomes a loop of the same length. Play the scene to hear the loops repeat.\n\n' +
            'While a recorded loop plays it is the source for those parameters (loop replaces live). Requires Hardware Mode bound + Input Scaling set on the instrument.'
          }
        >
          i
        </span>
        {isRecordingThis && (
          <span className="text-[9px] font-bold" style={{ color: 'rgb(var(--c-danger))' }}>
            REC
          </span>
        )}
      </div>
      <div className="flex items-center gap-1.5 flex-wrap">
        {isRecordingThis ? (
          <button
            className="btn text-[10px] py-0.5 px-2 leading-tight"
            style={{ color: 'rgb(var(--c-danger))' }}
            onClick={() => stopRec()}
            title="Stop recording — the captured movement becomes this scene's loop"
          >
            {'■'} Stop&nbsp;{elapsedS.toFixed(1)}s
          </button>
        ) : (
          <button
            className="btn text-[10px] py-0.5 px-2 leading-tight"
            disabled={isRecordingOther}
            style={{ color: isRecordingOther ? undefined : 'rgb(var(--c-danger))' }}
            title={
              isRecordingOther
                ? 'Another scene is currently recording — stop it first.'
                : 'Capture the live hardware stream into this scene'
            }
            onClick={() => startRec(scene.id)}
          >
            {'●'} Record from hardware
          </button>
        )}
        {hasLoop && !isRecordingThis && (
          <>
            <span className="text-[10px] text-muted tabular-nums">
              Loop {(durationMs / 1000).toFixed(1)}s · {loopCells.length} param
              {loopCells.length === 1 ? '' : 's'}
            </span>
            <label
              className="flex items-center gap-1 text-[10px] cursor-pointer"
              title="Play this recorded loop while the scene is active"
            >
              <input
                type="checkbox"
                checked={anyEnabled}
                onChange={(e) => setEnabled(scene.id, e.target.checked)}
              />
              <span className="text-muted">play</span>
            </label>
            <button
              className="btn text-[10px] py-0.5 px-1.5 leading-tight"
              onClick={() => clearLoop(scene.id)}
              title="Delete the recorded loop from this scene"
            >
              Clear
            </button>
          </>
        )}
      </div>
      {isRecordingThis && (
        <span className="text-[9px] text-muted">
          Recording all hardware-mapped parameters… press Stop when done.
        </span>
      )}
      <MotionLoopTriggerConfig />
    </div>
  )
}

// Hands-free trigger config (global — records whichever scene is focused).
// Lives inside the Motion Loop box; the transport ●REC button is the other
// face of the same binding.
function MotionLoopTriggerConfig(): JSX.Element {
  const recMidi = useStore((s) => s.session.motionLoopRecordMidi)
  const oscTrig = useStore((s) => s.session.motionLoopOscTrigger)
  const setLearnTarget = useStore((s) => s.setMidiLearnTarget)
  const setLearnMode = useStore((s) => s.setMidiLearnMode)
  const learnTarget = useStore((s) => s.midiLearnTarget)
  const setRecMidi = useStore((s) => s.setMotionLoopRecordMidi)
  const setOscTrig = useStore((s) => s.setMotionLoopOscTrigger)
  const isArming = learnTarget?.kind === 'motionLoopRecord'
  const oscEnabled = oscTrig?.enabled === true
  const oscAddr = oscTrig?.address ?? '/mpu/btn1'

  return (
    <div className="flex flex-col gap-1 mt-1 pt-1 border-t border-border/60">
      <span className="text-[9px] text-muted">
        Hands-free trigger (global — records the focused scene)
      </span>
      <div className="flex items-center gap-1.5 flex-wrap text-[10px]">
        <button
          className="btn text-[10px] py-0.5 px-1.5"
          style={{ outline: isArming ? '1px solid rgb(var(--c-accent))' : undefined }}
          onClick={() => {
            setLearnTarget(isArming ? null : { kind: 'motionLoopRecord' })
            setLearnMode(!isArming)
          }}
          title="MIDI-Learn a footswitch/pad to toggle recording"
        >
          {isArming ? 'Learning… press control' : 'MIDI Learn'}
        </button>
        {recMidi && (
          <span className="text-muted tabular-nums">
            {recMidi.kind.toUpperCase()} {recMidi.number} ch{recMidi.channel}
            <button
              className="ml-1"
              style={{ color: 'rgb(var(--c-danger))' }}
              title="Clear MIDI binding"
              onClick={() => setRecMidi(null)}
            >
              ✕
            </button>
          </span>
        )}
      </div>
      <label
        className="flex items-center gap-1 text-[10px] cursor-pointer"
        title="Toggle recording when this OSC address rises 0→1 — e.g. the antenna's own BTN1 button (short taps only; a 5s hold triggers the board's magnetometer calibration)."
      >
        <input
          type="checkbox"
          checked={oscEnabled}
          onChange={(e) => setOscTrig({ enabled: e.target.checked })}
        />
        <span className="text-muted">Trigger from OSC</span>
        <input
          className="input text-[10px] w-24"
          value={oscAddr}
          onChange={(e) => setOscTrig({ address: e.target.value })}
          disabled={!oscEnabled}
          title="OSC address (default the antenna's /mpu/btn1)"
        />
      </label>
    </div>
  )
}

// The bindable ●REC for the transport bar — same toggle as the Scene
// Inspector's Record button, but it acts on the currently-focused scene so
// a single MIDI/OSC binding drives it during performance.
export function MotionLoopRecButton(): JSX.Element {
  const recordingSceneId = useStore((s) => s.recordingLoopSceneId)
  const focusedSceneId = useStore((s) => s.session.focusedSceneId)
  const toggle = useStore((s) => s.toggleMotionLoopRecordFocused)
  const setLearnTarget = useStore((s) => s.setMidiLearnTarget)
  const setLearnMode = useStore((s) => s.setMidiLearnMode)
  const learnTarget = useStore((s) => s.midiLearnTarget)
  const recMidi = useStore((s) => s.session.motionLoopRecordMidi)

  const isRecording = recordingSceneId != null
  const isArming = learnTarget?.kind === 'motionLoopRecord'
  const canStart = focusedSceneId != null

  return (
    <button
      className="btn text-[11px] py-0.5 px-2 flex items-center gap-1 shrink-0"
      style={{
        color: isRecording ? 'rgb(var(--c-danger))' : undefined,
        outline: isArming ? '1px solid rgb(var(--c-accent))' : undefined
      }}
      disabled={!isRecording && !canStart}
      title={
        (isRecording
          ? 'Recording the focused scene — click to stop.'
          : canStart
            ? 'Record the focused scene from hardware (toggle).'
            : 'Select a scene first.') +
        '\n\nRight-click to MIDI-Learn a footswitch/pad.' +
        (recMidi
          ? `\nBound: ${recMidi.kind.toUpperCase()} ${recMidi.number} ch${recMidi.channel}`
          : '')
      }
      onClick={() => toggle()}
      onContextMenu={(e) => {
        e.preventDefault()
        setLearnTarget({ kind: 'motionLoopRecord' })
        setLearnMode(true)
      }}
    >
      <span style={{ color: 'rgb(var(--c-danger))' }}>●</span>
      {isRecording ? 'REC' : 'Rec'}
    </button>
  )
}
