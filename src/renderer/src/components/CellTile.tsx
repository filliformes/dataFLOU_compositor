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
  // Disjoint multi-selection (Ctrl+click). A cell is "in multi" if it's in
  // the `selectedCells` list. When the list is empty we fall back to the
  // single-anchor highlight above.
  const inMulti = useStore((s) =>
    s.selectedCells.some((r) => r.sceneId === sceneId && r.trackId === trackId)
  )
  const toggleCellSelection = useStore((s) => s.toggleCellSelection)
  const applyDefaultOscToCells = useStore((s) => s.applyDefaultOscToCells)
  const isPlaying = useStore((s) => !!s.engine.activeBySceneAndTrack[sceneId]?.[trackId])
  const currentStep = useStore(
    (s) => s.engine.seqStepBySceneAndTrack[sceneId]?.[trackId]
  )
  const liveValue = useStore((s) => s.engine.currentValueBySceneAndTrack[sceneId]?.[trackId])
  const tracksCollapsedRaw = useStore((s) => s.tracksCollapsed)
  const showMode = useStore((s) => s.showMode)
  // Show mode always uses the compact single-line tile — no "expanded"
  // variant exists in show mode so we never paint the oversized card.
  const compact = tracksCollapsedRaw || showMode
  const templates = useStore((s) => s.clipTemplates)
  const applyClipTemplate = useStore((s) => s.applyClipTemplate)
  const midiLearnMode = useStore((s) => s.midiLearnMode)
  const midiLearnTarget = useStore((s) => s.midiLearnTarget)
  const setMidiLearnTarget = useStore((s) => s.setMidiLearnTarget)
  const globalBpm = useStore((s) => s.session.globalBpm)

  // ---- Ramp-timing state (hoisted above the early return so hook order
  // stays stable across empty-cell vs filled-cell renders). We record
  // Date.now() the instant isPlaying flips on for this cell — can't rely
  // on engine.activeSceneStartedAt because that only updates for full-
  // scene triggers and stays stale when a single clip is fired. A 30 Hz
  // interval keeps us re-rendering during the ramp so the completion
  // moment is detected even after the engine output stabilizes (at which
  // point zustand would otherwise stop pushing updates).
  const triggerAtRef = useRef<number | null>(null)
  const wasPlayingRef = useRef(false)
  if (isPlaying && !wasPlayingRef.current) {
    triggerAtRef.current = Date.now()
  }
  if (!isPlaying && wasPlayingRef.current) {
    triggerAtRef.current = null
  }
  wasPlayingRef.current = isPlaying

  const isRampCell = cell?.modulation.enabled && cell.modulation.type === 'ramp'
  // Compute an upper bound on the ramp length here (at the top of the
  // component, above the early return) so we can auto-terminate the
  // timer as soon as we're clearly past the ramp finish line. Prevents
  // the interval from burning indefinitely on a completed-but-still-
  // playing ramp cell.
  const rampBoundMs = (() => {
    if (!cell || !isRampCell) return 0
    const r = cell.modulation.ramp
    if (!r) return 0
    if (r.sync === 'free') return r.rampMs
    if (r.sync === 'freeSync') return r.totalMs
    return (scene?.durationSec ?? 0) * 1000
  })()
  const [rampNowMs, setRampNowMs] = useState<number>(() => Date.now())
  const triggerAt = triggerAtRef.current
  const rampDoneByTime =
    isRampCell &&
    isPlaying &&
    triggerAt !== null &&
    rampBoundMs > 0 &&
    rampNowMs - triggerAt >= rampBoundMs
  const needsRampTimer = !!(isRampCell && isPlaying && !rampDoneByTime)
  useEffect(() => {
    if (!needsRampTimer) return
    const id = setInterval(() => setRampNowMs(Date.now()), 33)
    return () => clearInterval(id)
  }, [needsRampTimer])

  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null)
  // Separate context menu for FILLED cells (the `menu` state above is for
  // the empty-cell + clip picker). Targets either this single cell or the
  // multi-selection set.
  const [filledMenu, setFilledMenu] = useState<
    { x: number; y: number; targets: { sceneId: string; trackId: string }[] } | null
  >(null)
  useEffect(() => {
    if (!filledMenu) return
    const close = (): void => setFilledMenu(null)
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setFilledMenu(null)
    }
    window.addEventListener('mousedown', close)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', close)
      window.removeEventListener('keydown', onKey)
    }
  }, [filledMenu])

  // Plain click on a filled clip: single-select. Ctrl+click: toggle this
  // cell in the disjoint multi-selection. Keeps right-click's "act on
  // everything that's selected" semantics straightforward.
  function onClickCell(e: React.MouseEvent): void {
    if (e.ctrlKey || e.metaKey) {
      toggleCellSelection(sceneId, trackId)
    } else {
      selectCell(sceneId, trackId)
    }
  }

  // Right-click on a filled clip opens a context menu with Apply Template
  // + Use Default OSC. If the clicked cell is already part of a multi-
  // selection (ctrl-click set), the menu targets the whole set. Otherwise
  // it targets just this cell and replaces the current selection so the
  // user's intent is unambiguous.
  function onContextMenuCell(e: React.MouseEvent): void {
    const tag = (e.target as HTMLElement | null)?.tagName
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return
    e.preventDefault()
    e.stopPropagation()
    const here = { sceneId, trackId }
    let targets: { sceneId: string; trackId: string }[]
    const st = useStore.getState()
    const inSel = st.selectedCells.some(
      (r) => r.sceneId === sceneId && r.trackId === trackId
    )
    if (inSel && st.selectedCells.length > 1) {
      targets = st.selectedCells
    } else {
      targets = [here]
      if (!inSel) selectCell(sceneId, trackId)
    }
    setFilledMenu({ x: e.clientX, y: e.clientY, targets })
  }
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
  const isRamp = modOn && cell.modulation.type === 'ramp'
  // Defensive `?.` on `.ramp` — a freshly-loaded session migrated from an
  // older version without the ramp field should have been back-filled by
  // sanitizeMetaController, but if something sneaks through we'd rather
  // read 0 than crash the whole tree.
  const rampRef = cell.modulation.ramp
  const rampLenMs =
    isRamp && rampRef
      ? rampRef.sync === 'free'
        ? rampRef.rampMs
        : rampRef.sync === 'freeSync'
          ? rampRef.totalMs
          : (scene?.durationSec ?? 0) * 1000
      : 0

  // Timer state + trigger-at ref are hoisted to the top of the component
  // (see above) so hook order stays stable across branches. Here we just
  // read the derived values.
  const rampElapsedMs =
    isRamp && isPlaying && triggerAtRef.current !== null
      ? rampNowMs - triggerAtRef.current
      : 0
  const rampComplete = isRamp && rampElapsedMs >= rampLenMs && rampLenMs > 0
  // Envelope doesn't loop, so don't animate the sweep for it.
  const showSweep =
    isPlaying && (isLfo || isArp || isRnd || seqOn || (isRamp && !rampComplete))
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
      : isRamp
        ? // One sweep = the full ramp length. showSweep flips off when the
          // ramp finishes, so the animation truncates at the settled state.
          Math.max(0.03, rampLenMs / 1000)
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

  // Scene color piped as a CSS custom property so theme CSS can paint a
  // per-theme top bar / rail using it.
  const sceneColorStyle = { ['--scene-color' as string]: scene?.color ?? 'transparent' } as React.CSSProperties

  // Compact (Tracks Collapsed) layout: trigger + OSC address + value, one line.
  if (compact) {
    return (
      <>
      <div
        className={`relative h-full flex items-center gap-1.5 px-1.5 cursor-pointer ${
          inMulti || selected ? 'bg-panel2 border-l-2 border-l-accent2' : 'hover:bg-panel3/30'
        }`}
        draggable
        onDragStart={onDragStart}
        onClick={onClickCell}
        onContextMenu={onContextMenuCell}
        title="Ctrl+click to multi-select · Ctrl+drag to duplicate to empty cell · Right-click for actions"
        style={sceneColorStyle}
      >
        <div
          ref={pulseRef}
          aria-hidden
          className="absolute inset-0 pointer-events-none"
          style={{ animationDuration: seqOn && isPlaying ? pulseDurationMs(cell, globalBpm) : undefined }}
        />
        <div className="clip-top-bar" aria-hidden />
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
      {filledMenu && (
        <FilledCellMenu
          x={filledMenu.x}
          y={filledMenu.y}
          targets={filledMenu.targets}
          templates={templates}
          onApplyTemplate={(id) => {
            filledMenu.targets.forEach((r) => applyClipTemplate(r.sceneId, r.trackId, id))
            setFilledMenu(null)
          }}
          onUseDefaultOsc={() => {
            applyDefaultOscToCells(filledMenu.targets)
            setFilledMenu(null)
          }}
          onClose={() => setFilledMenu(null)}
        />
      )}
      </>
    )
  }

  return (
    <>
    <div
      className={`relative h-full flex flex-col px-1.5 py-1 cursor-pointer ${
        inMulti || selected ? 'bg-panel2 border-l-2 border-l-accent2' : 'hover:bg-panel3/30'
      }`}
      draggable
      onDragStart={onDragStart}
      onClick={onClickCell}
      onContextMenu={onContextMenuCell}
      title="Ctrl+click to multi-select · Ctrl+drag to duplicate to empty cell · Right-click for actions"
      style={sceneColorStyle}
    >
      <div
        ref={pulseRef}
        aria-hidden
        className="absolute inset-0 pointer-events-none"
        style={{ animationDuration: seqOn && isPlaying ? pulseDurationMs(cell, globalBpm) : undefined }}
      />
      <div className="clip-top-bar" aria-hidden />
      {/* Row 1: trigger + OSC address (the primary debugging identifier,
          promoted here so it never clips at the min column width). */}
      <div className="flex items-center gap-1.5 min-w-0">
        {triggerBtn}
        <span
          className="text-[10px] truncate flex-1 min-w-0"
          title={cell.oscAddress + (cell.addressLinkedToDefault ? ' (linked to default)' : '')}
        >
          {cell.oscAddress}
          {cell.addressLinkedToDefault && (
            <span className="text-accent2 ml-1">~def~</span>
          )}
        </span>
        <button
          className="text-muted hover:text-danger text-[10px] shrink-0"
          onClick={(e) => {
            e.stopPropagation()
            removeCell(sceneId, trackId)
          }}
          title="Remove cell"
        >
          ✕
        </button>
      </div>
      {/* Row 2: ip:port — secondary info, smaller, allowed to truncate. */}
      <div
        className="text-[10px] text-muted truncate mt-0.5"
        title={`${cell.destIp}:${cell.destPort}`}
      >
        {cell.destIp}:{cell.destPort}
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
        {modOn && cell.modulation.type === 'ramp' && (
          <span className="text-accent2">
            RAMP {cell.modulation.depthPct}%
          </span>
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
        {cell.delayMs > 0 && (
          <span title="Delay before trigger (ms)">⟲{cell.delayMs}ms</span>
        )}
        {cell.transitionMs > 0 && (
          <span title="Trigger transition — morph time from current output to the clip's value when the clip is triggered. Unrelated to the modulator; change it in the inspector's Transition field.">
            ~{cell.transitionMs}ms
          </span>
        )}
      </div>
    </div>
    {filledMenu && (
      <FilledCellMenu
        x={filledMenu.x}
        y={filledMenu.y}
        targets={filledMenu.targets}
        templates={templates}
        onApplyTemplate={(id) => {
          filledMenu.targets.forEach((r) => applyClipTemplate(r.sceneId, r.trackId, id))
          setFilledMenu(null)
        }}
        onUseDefaultOsc={() => {
          applyDefaultOscToCells(filledMenu.targets)
          setFilledMenu(null)
        }}
        onClose={() => setFilledMenu(null)}
      />
    )}
    </>
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

// Right-click context menu for FILLED clips. Actions apply to every ref
// in `targets` — that's either just the clicked clip OR the whole current
// multi-selection (see CellTile.onContextMenuCell for the resolution).
function FilledCellMenu({
  x,
  y,
  targets,
  templates,
  onApplyTemplate,
  onUseDefaultOsc,
  onClose
}: {
  x: number
  y: number
  targets: { sceneId: string; trackId: string }[]
  templates: { id: string; name: string }[]
  onApplyTemplate: (id: string) => void
  onUseDefaultOsc: () => void
  onClose: () => void
}): JSX.Element {
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
  const plural = targets.length > 1
  return createPortal(
    <div
      className="fixed z-50 bg-panel border border-border rounded shadow-lg py-1 text-[12px] min-w-[200px]"
      style={{ left: x, top: y }}
      onMouseDown={(e) => e.stopPropagation()}
    >
      <div className="px-3 py-0.5 text-[10px] text-muted">
        {plural ? `${targets.length} clips selected` : 'Clip'}
      </div>
      <div className="border-t border-border my-1" />
      {templates.length > 0 ? (
        <>
          <div className="px-3 py-0.5 text-[10px] text-muted">Apply template</div>
          {templates.map((t) => (
            <button
              key={t.id}
              className="w-full text-left px-3 py-1 hover:bg-panel2"
              onClick={() => onApplyTemplate(t.id)}
            >
              {t.name}
            </button>
          ))}
          <div className="border-t border-border my-1" />
        </>
      ) : (
        <div className="px-3 py-1 text-[10px] text-muted italic">
          No saved templates yet
        </div>
      )}
      <button
        className="w-full text-left px-3 py-1 hover:bg-panel2"
        onClick={onUseDefaultOsc}
        title="Overwrite OSC address + destination on every selected clip with the session's current defaults"
      >
        Use Default OSC
      </button>
    </div>,
    document.body
  )
}
