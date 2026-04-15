import { useEffect, useRef, useState } from 'react'
import { useStore } from '../store'
import { createPortal } from 'react-dom'
import { effectiveLfoHz } from '@shared/factory'

const DRAG_MIME = 'application/x-dataflou-cell'

export default function CellTile({
  sceneId,
  trackId
}: {
  sceneId: string
  trackId: string
}): JSX.Element {
  const scene = useStore((s) => s.session.scenes.find((sc) => sc.id === sceneId))
  const cell = scene?.cells[trackId]
  const ensureCell = useStore((s) => s.ensureCell)
  const removeCell = useStore((s) => s.removeCell)
  const selectCell = useStore((s) => s.selectCell)
  const duplicateCell = useStore((s) => s.duplicateCell)
  const selected = useStore(
    (s) => s.selectedCell?.sceneId === sceneId && s.selectedCell?.trackId === trackId
  )
  const isPlaying = useStore((s) => !!s.engine.activeBySceneAndTrack[sceneId]?.[trackId])
  const currentStep = useStore(
    (s) => s.engine.seqStepBySceneAndTrack[sceneId]?.[trackId]
  )
  const liveValue = useStore((s) => s.engine.currentValueBySceneAndTrack[sceneId]?.[trackId])
  const compact = useStore((s) => s.tracksCollapsed)
  const templates = useStore((s) => s.clipTemplates)
  const applyClipTemplate = useStore((s) => s.applyClipTemplate)
  const midiLearnMode = useStore((s) => s.midiLearnMode)
  const midiLearnTarget = useStore((s) => s.midiLearnTarget)
  const setMidiLearnTarget = useStore((s) => s.setMidiLearnTarget)
  const globalBpm = useStore((s) => s.session.globalBpm)
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null)
  // Replay the blink keyframe on every step change by toggling the class.
  const pulseRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (currentStep === undefined) return
    const el = pulseRef.current
    if (!el) return
    el.classList.remove('seq-pulse')
    void el.offsetWidth // force reflow to restart animation
    el.classList.add('seq-pulse')
  }, [currentStep, sceneId, trackId])

  // Accept a dropped cell reference on an empty slot.
  function onDropEmpty(e: React.DragEvent): void {
    e.preventDefault()
    e.stopPropagation()
    const raw = e.dataTransfer.getData(DRAG_MIME)
    if (!raw) return
    try {
      const { sceneId: srcScene, trackId: srcTrack } = JSON.parse(raw) as {
        sceneId: string
        trackId: string
      }
      if (srcScene === sceneId && srcTrack === trackId) return
      duplicateCell(srcScene, srcTrack, sceneId, trackId)
      selectCell(sceneId, trackId)
    } catch {
      /* ignore */
    }
  }

  function onDragOverEmpty(e: React.DragEvent): void {
    if (!e.dataTransfer.types.includes(DRAG_MIME)) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'copy'
  }

  if (!cell) {
    return (
      <>
        <div
          className="w-full h-full flex items-center justify-center text-muted hover:bg-panel2 text-[11px] cursor-pointer"
          onClick={() => {
            ensureCell(sceneId, trackId)
            selectCell(sceneId, trackId)
          }}
          onContextMenu={(e) => {
            e.preventDefault()
            setMenu({ x: e.clientX, y: e.clientY })
          }}
          onDragOver={onDragOverEmpty}
          onDrop={onDropEmpty}
        >
          + clip
        </div>
        {menu && (
          <ClipTemplateMenu
            x={menu.x}
            y={menu.y}
            templates={templates}
            onPick={(id) => {
              ensureCell(sceneId, trackId)
              if (id) applyClipTemplate(sceneId, trackId, id)
              selectCell(sceneId, trackId)
              setMenu(null)
            }}
            onClose={() => setMenu(null)}
          />
        )}
      </>
    )
  }

  async function trigger(e: React.MouseEvent): Promise<void> {
    e.stopPropagation()
    // In MIDI Learn mode, selecting the clip trigger makes it the learn
    // target; the next MIDI message binds it. Normal firing resumes when
    // learn mode is turned off.
    if (midiLearnMode) {
      setMidiLearnTarget({ kind: 'cell', sceneId, trackId })
      return
    }
    if (isPlaying) await window.api.stopCell(sceneId, trackId)
    else await window.api.triggerCell(sceneId, trackId)
  }

  // Build the MIDI-learn overlay class for the clip's trigger square.
  const learnOverlayClass = !midiLearnMode
    ? ''
    : midiLearnTarget?.kind === 'cell' &&
        midiLearnTarget.sceneId === sceneId &&
        midiLearnTarget.trackId === trackId
      ? 'midi-learn-selected'
      : cell.midiTrigger
        ? 'midi-learn-green'
        : 'midi-learn-blue'

  // HTML5 drag — only proceeds if Ctrl was held at dragstart.
  function onDragStart(e: React.DragEvent): void {
    if (!e.ctrlKey && !e.metaKey) {
      e.preventDefault()
      return
    }
    e.dataTransfer.setData(DRAG_MIME, JSON.stringify({ sceneId, trackId }))
    e.dataTransfer.effectAllowed = 'copy'
  }

  const modOn = cell.modulation.enabled
  const seqOn = cell.sequencer.enabled
  const isLfo = modOn && cell.modulation.type === 'lfo'
  const isArp = modOn && cell.modulation.type === 'arpeggiator'
  const isRnd = modOn && cell.modulation.type === 'random'
  // Envelope doesn't loop, so don't animate the sweep for it.
  const showSweep = isPlaying && (isLfo || isArp || isRnd || seqOn)
  // Use the effective rate (respects BPM sync, dotted, triplet) so the visual
  // matches what the engine actually runs. Clamp minimum period to 30 ms
  // (~33 Hz visual) so very fast LFOs/arps are still visible as motion.
  const effHz = isLfo || isArp || isRnd ? effectiveLfoHz(cell.modulation, globalBpm) : 0
  // Arp sweep represents the FULL ladder cycle (N steps), so one sweep = the
  // time to traverse all steps. LFO/Random still sweep per cycle/tick.
  const arpCycleSec = isArp
    ? Math.max(1, cell.modulation.arpeggiator.steps) / Math.max(0.01, effHz)
    : 0
  const sweepPeriod = isArp
    ? Math.max(0.03, arpCycleSec)
    : isLfo || isRnd
      ? Math.max(0.03, 1 / Math.max(0.01, effHz))
      : seqOn
      ? cell.sequencer.syncMode === 'bpm'
        ? (60 / Math.max(1, globalBpm)) * Math.max(1, cell.sequencer.steps)
        : cell.sequencer.syncMode === 'tempo'
          ? (60 / Math.max(1, cell.sequencer.bpm)) * Math.max(1, cell.sequencer.steps)
          : (cell.sequencer.stepMs / 1000) * Math.max(1, cell.sequencer.steps)
      : 1

  const triggerBtn = (
    <button
      className={`relative w-5 h-5 rounded-sm border flex items-center justify-center shrink-0 overflow-hidden ${
        isPlaying
          ? showSweep
            ? 'bg-panel2 border-accent text-accent'
            : 'bg-accent border-accent text-black'
          : 'border-border bg-panel2 hover:border-accent'
      }`}
      onClick={trigger}
    >
      {showSweep && (
        <span
          aria-hidden
          className="lfo-sweep absolute inset-0 pointer-events-none"
          style={{ animationDuration: `${sweepPeriod}s` }}
        />
      )}
      {isPlaying ? (
        <svg width="8" height="8" viewBox="0 0 10 10" className="relative z-10">
          <rect x="1" y="1" width="8" height="8" fill="currentColor" />
        </svg>
      ) : (
        <svg width="8" height="8" viewBox="0 0 10 10">
          <polygon points="2,1 9,5 2,9" fill="currentColor" />
        </svg>
      )}
      {learnOverlayClass && (
        <div className={`midi-learn-overlay ${learnOverlayClass}`} aria-hidden />
      )}
    </button>
  )

  // Compact (Tracks Collapsed) layout: trigger + OSC address + value, one line.
  if (compact) {
    return (
      <div
        className={`relative h-full flex items-center gap-1.5 px-1.5 cursor-pointer ${
          selected ? 'bg-panel2 border-l-2 border-l-accent2' : 'hover:bg-panel3/30'
        }`}
        draggable
        onDragStart={onDragStart}
        onClick={() => selectCell(sceneId, trackId)}
        title="Ctrl+drag to duplicate to an empty cell"
      >
        <div
          ref={pulseRef}
          aria-hidden
          className="absolute inset-0 pointer-events-none"
          style={{ animationDuration: seqOn && isPlaying ? pulseDurationMs(cell, globalBpm) : undefined }}
        />
        {triggerBtn}
        <span className="text-[10px] text-muted truncate flex-1 min-w-0">
          {cell.oscAddress}
        </span>
        <span
          className={`text-[12px] font-mono font-semibold truncate shrink-0 max-w-[40%] text-right ${
            isPlaying && liveValue !== undefined ? 'text-accent' : ''
          }`}
        >
          {isPlaying && liveValue !== undefined ? liveValue : cell.value}
        </span>
      </div>
    )
  }

  return (
    <div
      className={`relative h-full flex flex-col px-1.5 py-1 cursor-pointer ${
        selected ? 'bg-panel2 border-l-2 border-l-accent2' : 'hover:bg-panel3/30'
      }`}
      draggable
      onDragStart={onDragStart}
      onClick={() => selectCell(sceneId, trackId)}
      title="Ctrl+drag to duplicate to an empty cell"
    >
      <div
        ref={pulseRef}
        aria-hidden
        className="absolute inset-0 pointer-events-none"
        style={{ animationDuration: seqOn && isPlaying ? pulseDurationMs(cell, globalBpm) : undefined }}
      />
      <div className="flex items-center gap-1.5">
        {triggerBtn}
        <span className="text-[10px] text-muted truncate flex-1">
          {cell.destIp}:{cell.destPort}
        </span>
        <button
          className="text-muted hover:text-danger text-[10px]"
          onClick={(e) => {
            e.stopPropagation()
            removeCell(sceneId, trackId)
          }}
          title="Remove cell"
        >
          ✕
        </button>
      </div>
      <div className="text-[10px] text-muted truncate mt-0.5">
        {cell.oscAddress}
        {cell.addressLinkedToDefault && <span className="text-accent2 ml-1">~def~</span>}
      </div>
      <div className="flex-1 flex items-center">
        <span
          className={`text-[14px] font-mono font-semibold truncate ${
            isPlaying && liveValue !== undefined ? 'text-accent' : ''
          }`}
        >
          {isPlaying && liveValue !== undefined ? liveValue : cell.value}
        </span>
      </div>
      <div className="flex items-center gap-1 text-[9px] text-muted">
        {modOn && cell.modulation.type === 'lfo' && (
          <span className="text-accent2">
            {shapeLabel(cell.modulation.shape)} {cell.modulation.depthPct}%
          </span>
        )}
        {modOn && cell.modulation.type === 'envelope' && (
          <span className="text-accent2">ENV {cell.modulation.depthPct}%</span>
        )}
        {modOn && cell.modulation.type === 'arpeggiator' && (
          <span className="text-accent2">
            ARP{cell.modulation.arpeggiator.steps}
          </span>
        )}
        {modOn && cell.modulation.type === 'random' && (
          <span className="text-accent2">
            RND {cell.modulation.random.valueType === 'colour' ? 'rgb' : cell.modulation.random.valueType}
          </span>
        )}
        {seqOn && <span className="text-accent">SEQ{cell.sequencer.steps}</span>}
        {cell.delayMs > 0 && <span>⟲{cell.delayMs}ms</span>}
        {cell.transitionMs > 0 && <span>~{cell.transitionMs}ms</span>}
      </div>
    </div>
  )
}

function ClipTemplateMenu({
  x,
  y,
  templates,
  onPick,
  onClose
}: {
  x: number
  y: number
  templates: { id: string; name: string }[]
  onPick: (id: string | null) => void
  onClose: () => void
}): JSX.Element {
  // Close on any outside click / escape.
  useEffect(() => {
    const onDoc = (): void => onClose()
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('mousedown', onDoc)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDoc)
      document.removeEventListener('keydown', onKey)
    }
  }, [onClose])

  return createPortal(
    <div
      className="fixed z-50 bg-panel border border-border rounded shadow-xl py-1 min-w-[160px]"
      style={{ left: x, top: y }}
      onMouseDown={(e) => e.stopPropagation()}
    >
      <div className="px-3 py-1 text-[10px] uppercase text-muted">From template</div>
      <button
        className="w-full text-left px-3 py-1 text-[12px] hover:bg-panel2"
        onClick={() => onPick(null)}
      >
        Empty
      </button>
      {templates.length === 0 && (
        <div className="px-3 py-1 text-[11px] text-muted italic">
          No templates yet — save one from the inspector.
        </div>
      )}
      {templates.map((t) => (
        <button
          key={t.id}
          className="w-full text-left px-3 py-1 text-[12px] hover:bg-panel2"
          onClick={() => onPick(t.id)}
        >
          {t.name}
        </button>
      ))}
    </div>,
    document.body
  )
}

function shapeLabel(s: string): string {
  return { sine: '∿', triangle: '△', sawtooth: '⩘', square: '⊓', rndStep: '⋯', rndSmooth: '∽' }[s] || s
}

function pulseDurationMs(
  cell: {
    sequencer: { syncMode: 'bpm' | 'tempo' | 'free'; bpm: number; stepMs: number }
  },
  globalBpm: number
): string {
  const ms =
    cell.sequencer.syncMode === 'bpm'
      ? 60000 / Math.max(1, globalBpm)
      : cell.sequencer.syncMode === 'tempo'
        ? 60000 / Math.max(1, cell.sequencer.bpm)
        : Math.max(1, cell.sequencer.stepMs)
  // Cap blink animation to the step length but clamp so it's visible.
  return `${Math.min(600, Math.max(120, ms))}ms`
}
