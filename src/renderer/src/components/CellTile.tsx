import { useEffect, useMemo, useRef, useState } from 'react'
import { useStore } from '../store'
import { createPortal } from 'react-dom'
import {
  cellularInitialRow,
  effectiveLfoHz,
  generateStepValue
} from '@shared/factory'
import type { ParamArgSpec } from '@shared/types'
import { DestHealthDot } from './DestHealthDot'

const DRAG_MIME = 'application/x-dataflou-cell'

// Cap the rendered length of a single numeric token in the clip
// tile. OCTOCOSME-style 12-float bundles with 7-decimal mantissas
// otherwise blow the column width way out (`0.7895432` * 12 ≈ 130
// chars). Inspector still sees the full precision. Strings, bool
// tokens, and ints pass through unchanged.
const CLIP_TOKEN_MAX_CHARS = 5
function truncateClipToken(tok: string): string {
  // Only trim numeric-looking tokens. Leave anything with non-digit
  // / non-decimal-separator characters alone (OSC addresses, sender
  // names, etc.).
  if (!/^-?\d+(\.\d+)?$/.test(tok)) return tok
  if (tok.length <= CLIP_TOKEN_MAX_CHARS) return tok
  const n = parseFloat(tok)
  if (!Number.isFinite(n)) return tok
  // Integers: show as-is (cropping digits would change the
  // magnitude, which is much worse than a wide column).
  if (Number.isInteger(n)) return tok
  // Floats: clip the trailing decimals so the whole string fits in
  // CLIP_TOKEN_MAX_CHARS. Min one digit after the dot.
  const sign = n < 0 ? '-' : ''
  const abs = Math.abs(n)
  const intStr = String(Math.trunc(abs))
  // Budget for after the dot = MAX - sign - intStr - "." sep, ≥ 1.
  const budget = CLIP_TOKEN_MAX_CHARS - sign.length - intStr.length - 1
  if (budget <= 0) return tok // integer part already too big — punt
  const fixed = abs.toFixed(budget)
  return sign + fixed
}

// Render `cell.value` for the GRID TILE only. Three transforms:
//   1. Drop fixed argSpec slots — the engine re-prepends them at
//      send time, but the user doesn't care about seeing
//      `192.168.x.x 17` before every float on their OCTOCOSME cells.
//   2. Round numeric tokens longer than CLIP_TOKEN_MAX_CHARS.
//   3. Pass everything through unchanged when there's no argSpec
//      (single-arg cells render verbatim).
// The Inspector, the engine, and `cell.value` itself are unchanged.
function formatCellDisplayValue(
  raw: string,
  argSpec: ParamArgSpec[] | undefined
): string {
  const tokens = raw.trim().split(/\s+/).filter((t) => t.length > 0)
  if (!argSpec || argSpec.length === 0) {
    return tokens.map(truncateClipToken).join(' ')
  }
  const out: string[] = []
  for (let i = 0; i < tokens.length; i++) {
    const spec = argSpec[i]
    if (spec && spec.fixed !== undefined) continue
    out.push(truncateClipToken(tokens[i]))
  }
  return out.join(' ')
}

// How many tokens per row in the value grid. Past 4, tokens wrap to
// a new row instead of stretching the column horizontally — keeps a
// 12-float OCTOCOSME cell readable inside a normal-width column.
const CELL_TOKENS_PER_ROW = 4

// Cell value renderer. Splits the post-formatter display string back
// into tokens and lays them out in an auto-sizing CSS grid with up
// to 4 columns. ≤4 tokens render as a single row (matching the old
// inline look); >4 wrap into two or more rows. The whole grid sits
// inside an overflow-hidden parent so the wrapped rows stay within
// the clip's box — if the user wants more vertical room, they can
// drag the row-height slider up. Live engine values get the accent
// color, same as before.
function CellValueGrid({
  display,
  isLiveDisplay
}: {
  display: string
  isLiveDisplay: boolean
}): JSX.Element {
  const tokens = display.trim().split(/\s+/).filter((t) => t.length > 0)
  if (tokens.length === 0) {
    return (
      <span
        className={`text-[14px] font-mono font-semibold ${
          isLiveDisplay ? 'text-accent' : ''
        }`}
      >
        &nbsp;
      </span>
    )
  }
  // ≤4 tokens: single line — keeps the legacy compact look so simple
  // single-arg or vec3/vec4 cells don't suddenly take more vertical
  // space than they used to.
  if (tokens.length <= CELL_TOKENS_PER_ROW) {
    return (
      <span
        className={`text-[14px] font-mono font-semibold whitespace-nowrap ${
          isLiveDisplay ? 'text-accent' : ''
        }`}
      >
        {tokens.join(' ')}
      </span>
    )
  }
  // >4 tokens: render as a 4-column CSS grid. `auto` columns size to
  // the widest token in each column (so floats with different
  // magnitudes line up vertically). Compact font + tight line height
  // + zero row gap so a 12-arg OCTOCOSME bundle (3 rows of 4) fits
  // in the default row height without cropping the bottom row.
  // User can still drag the row-height slider for even more
  // headroom on deeply-nested cells.
  return (
    <div
      className={`grid gap-x-1.5 font-mono text-[9px] font-semibold w-full leading-none ${
        isLiveDisplay ? 'text-accent' : ''
      }`}
      style={{
        gridTemplateColumns: `repeat(${CELL_TOKENS_PER_ROW}, minmax(0, auto))`,
        justifyContent: 'start',
        rowGap: '2px'
      }}
    >
      {tokens.map((t, i) => (
        <span key={i} className="truncate py-px" title={t}>
          {t}
        </span>
      ))}
    </div>
  )
}

export default function CellTile({
  sceneId,
  trackId
}: {
  sceneId: string
  trackId: string
}): JSX.Element {
  const scene = useStore((s) => s.session.scenes.find((sc) => sc.id === sceneId))
  const cell = scene?.cells[trackId]
  // Track lookup — used to read argSpec so we can hide the
  // auto-prefix (fixed) tokens from the clip-tile display + round
  // long floats. The Inspector still shows full precision; only
  // the grid tile is cosmetic.
  const track = useStore((s) => s.session.tracks.find((t) => t.id === trackId))
  // Row height drives adaptive layout: at very small heights we
  // drop the ip:port row + footer chips entirely so the value grid
  // gets every available pixel. Avoids mid-letter clipping when
  // the user pulls the row-height slider all the way down.
  const rowHeight = useStore((s) => s.rowHeight)
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

  // What text gets painted in the cell tile's value slot. Three branches:
  //   1. Cell is playing AND the engine has emitted a live value for it
  //      → show the engine's actual emitted value (post-modulation,
  //      post-scaling, post-generative). This is the source of truth.
  //   2. Sequencer + Generative are on (but cell isn't playing yet)
  //      → preview-render the value the engine WOULD emit at the
  //      current sequencer step, computed in the renderer using the
  //      same `generateStepValue` helper the engine uses. This is
  //      what makes the tile reflect Variation / Seed / mode tweaks
  //      instantly, even before triggering — without this branch the
  //      tile would just show the raw seed (cell.value) and feel
  //      disconnected from the generative knobs.
  //   3. Otherwise → show the cell's static value field (the seed,
  //      or the literal value if the sequencer is off).
  // Memo guards against re-running generateStepValue on every render
  // when none of the inputs changed.
  const generativePreview = useMemo(() => {
    if (!cell?.sequencer.enabled || !cell.sequencer.generative) return null
    const seq = cell.sequencer
    const steps = Math.max(1, Math.min(16, Math.floor(seq.steps)))
    const idx =
      typeof currentStep === 'number' && currentStep >= 0
        ? currentStep
        : 0
    return generateStepValue({
      baseRaw: cell.value,
      mode: seq.mode,
      stepIdx: idx,
      steps,
      amount: seq.genAmount,
      seed: seq.seed,
      ringALength: seq.ringALength,
      ringBLength: seq.ringBLength,
      // Renderer doesn't have access to the engine's evolving
      // cellular row, so we use the deterministic initial row.
      // This makes the preview match what the engine emits at the
      // start of each cycle; later in the cycle it may differ
      // (live engine reading wins via branch 1 above).
      cellRow: cellularInitialRow(seq.cellSeed, steps),
      bounceDecay: seq.bounceDecay,
      // Sub-pulse 0 of 1 = "treat as a normal step, not mid-burst".
      subIdx: 0,
      subdiv: 1,
      scaleToUnit: cell.scaleToUnit
    })
  }, [
    cell?.value,
    cell?.scaleToUnit,
    cell?.sequencer.enabled,
    cell?.sequencer.generative,
    cell?.sequencer.mode,
    cell?.sequencer.steps,
    cell?.sequencer.genAmount,
    cell?.sequencer.seed,
    cell?.sequencer.ringALength,
    cell?.sequencer.ringBLength,
    cell?.sequencer.cellSeed,
    cell?.sequencer.bounceDecay,
    currentStep
  ])
  const rawDisplayValue =
    isPlaying && liveValue !== undefined
      ? liveValue
      : generativePreview ?? cell?.value ?? ''
  // Cosmetic transform — drop the auto-prefix tokens (`fixed`
  // argSpec entries; usually an IP / sequence-id the engine
  // re-prepends at send time) and trim per-token precision so a
  // 12-float OCTOCOSME-style bundle doesn't blow the column width
  // out to fit `0.7895432 0.7895432 …`. The Inspector keeps full
  // precision; this is the grid tile's display only.
  const displayValue = formatCellDisplayValue(rawDisplayValue, track?.argSpec)
  // Whether the displayed value comes from the engine (live) or from
  // either the generative preview or the static seed. Drives the
  // accent-tinted styling so live values pop visually.
  const isLiveDisplay = isPlaying && liveValue !== undefined
  const tracksCollapsedRaw = useStore((s) => s.tracksCollapsed)
  const showMode = useStore((s) => s.showMode)
  // Show mode always uses the compact single-line tile — no "expanded"
  // variant exists in show mode so we never paint the oversized card.
  const compact = tracksCollapsedRaw || showMode
  const templates = useStore((s) => s.clipTemplates)
  const applyClipTemplate = useStore((s) => s.applyClipTemplate)
  const saveClipAsTemplate = useStore((s) => s.saveClipAsTemplate)
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
  // Move the play-edge detection into a useEffect so a re-render
  // during the isPlaying transition doesn't re-stamp triggerAtRef
  // with a later `Date.now()` (which previously caused the ramp
  // progress dot to micro-jitter at the moment of trigger).
  useEffect(() => {
    if (isPlaying && !wasPlayingRef.current) {
      triggerAtRef.current = Date.now()
    }
    if (!isPlaying && wasPlayingRef.current) {
      triggerAtRef.current = null
    }
    wasPlayingRef.current = isPlaying
  }, [isPlaying])

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
  //
  // stopPropagation prevents the SceneColumn root's `onClick` from
  // firing setFocusedScene as a side effect — that bubble used to
  // co-set `selectedSceneIds = [id]` on every cell click, which made
  // the Del-key handler think the user wanted to delete the WHOLE
  // SCENE rather than the cell's track. Cell clicks should be
  // exclusively about the cell; if the user wants to focus the
  // scene, they click the header.
  function onClickCell(e: React.MouseEvent): void {
    e.stopPropagation()
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
        <DestHealthDot ip={cell.destIp} port={cell.destPort} />
        <span className="text-[10px] text-muted truncate flex-1 min-w-0">
          {cell.oscAddress}
        </span>
        <span
          className={`text-[12px] font-mono font-semibold whitespace-nowrap shrink-0 text-right ${
            isLiveDisplay ? 'text-accent' : ''
          }`}
        >
          {displayValue}
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
          onSaveAsTemplate={() => {
            // Save the FIRST target's cell as a new clip template.
            // Multi-selection saves only one — saving N copies of
            // the same template at once isn't useful, and asking
            // for N names would be a wall of modals. Auto-name from
            // the track + scene so the user sees something
            // meaningful in the Apply-template list; rename via
            // the Inspector after the fact if needed.
            const first = filledMenu.targets[0]
            const st = useStore.getState()
            const tr = st.session.tracks.find((t) => t.id === first.trackId)
            const sc = st.session.scenes.find((s) => s.id === first.sceneId)
            const autoName =
              `${tr?.name ?? 'Clip'} — ${sc?.name ?? ''}`.trim().replace(/\s+—\s+$/, '')
            saveClipAsTemplate(first.sceneId, first.trackId, autoName)
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
      className={`relative h-full flex flex-col px-1.5 py-0.5 cursor-pointer ${
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
      {/* Row 2: ip:port — secondary info, smaller, allowed to truncate.
          Health dot appears when this destination has had a send failure
          in the last 5 s (from main's oscErrors IPC stream). Tightened
          to leading-tight + 9px text so multi-arg cells get more
          vertical room for their wrapped 4-col value grid.
          Hidden below 75 px row height — the ip:port is rarely
          glanced at compared to the value, and the row gains ~12 px
          of room for the multi-arg grid without it. The OSC address
          row above still carries the addressing info, and the
          Inspector still shows the full destination. */}
      {rowHeight >= 75 && (
        <div
          className="text-[9px] text-muted truncate flex items-center gap-1 leading-tight"
          title={`${cell.destIp}:${cell.destPort}`}
        >
          <DestHealthDot ip={cell.destIp} port={cell.destPort} />
          <span className="truncate">
            {cell.destIp}:{cell.destPort}
          </span>
        </div>
      )}
      <div className="flex-1 min-h-0 flex items-start overflow-hidden mt-0.5">
        <CellValueGrid
          display={displayValue}
          isLiveDisplay={isLiveDisplay}
        />
      </div>
      {/* Modulator / sequencer / timing / transport-badge footer.
          Hidden below 60 px row height so the value grid grabs the
          last ~12 px — at that size the user has explicitly chosen
          a compact view and the chips are the lowest-priority info
          (still editable via the inspector). The transport badge
          stays visible at any row height >=60 since OSC/MIDI mute
          state is the most actionable footer info. */}
      {rowHeight >= 60 && (
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
        {modOn && cell.modulation.type === 'sh' && (
          <span className="text-accent2">
            S&amp;H {cell.modulation.depthPct}%
          </span>
        )}
        {modOn && cell.modulation.type === 'slew' && (
          <span className="text-accent2">
            SLEW {cell.modulation.depthPct}%
          </span>
        )}
        {modOn && cell.modulation.type === 'chaos' && (
          <span
            className="text-accent2"
            title={`Logistic map r = ${cell.modulation.chaos.r.toFixed(2)}`}
          >
            CHAOS {cell.modulation.depthPct}%
          </span>
        )}
        {seqOn && (
          <span
            className="text-accent"
            title={
              cell.sequencer.mode === 'euclidean'
                ? `Euclidean ${cell.sequencer.pulses}/${cell.sequencer.steps}${
                    cell.sequencer.rotation ? ` +${cell.sequencer.rotation}` : ''
                  }`
                : `Sequencer ${cell.sequencer.steps} steps`
            }
          >
            {cell.sequencer.mode === 'euclidean'
              ? `EUC${cell.sequencer.pulses}/${cell.sequencer.steps}`
              : `SEQ${cell.sequencer.steps}`}
          </span>
        )}
        {cell.timingEnabled === true && cell.delayMs > 0 && (
          <span title="Delay before trigger (ms)">⟲{cell.delayMs}ms</span>
        )}
        {cell.timingEnabled === true && cell.transitionMs > 0 && (
          <span title="Trigger transition — morph time from current output to the clip's value when the clip is triggered. Unrelated to the modulator; change it in the inspector's Transition field.">
            ~{cell.transitionMs}ms
          </span>
        )}
        <span className="flex-1" />
        {/* Right edge stack — when MIDI is enabled, the live MIDI
            byte sits ABOVE the transport badge so the user can read
            "what's currently going out on the MIDI wire" at a glance.
            For CC mode → the 0..127 byte; for Note mode → "note→vel".
            Distinct violet/teal hue from the orange accent used by
            the OSC live value above the row. */}
        <div className="flex flex-col items-end shrink-0 gap-0.5">
          <ClipMidiLiveValue
            cell={cell}
            displayValue={isLiveDisplay ? displayValue : null}
          />
          <ClipTransportBadge
            oscOn={(cell.oscEnabled ?? true) && !!cell.oscAddress}
            midiOn={!!cell.midiOut?.enabled && !!cell.midiOut.portName}
          />
        </div>
      </div>
      )}
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
        onSaveAsTemplate={() => {
          const first = filledMenu.targets[0]
          const st = useStore.getState()
          const tr = st.session.tracks.find((t) => t.id === first.trackId)
          const sc = st.session.scenes.find((s) => s.id === first.sceneId)
          const autoName =
            `${tr?.name ?? 'Clip'} — ${sc?.name ?? ''}`.trim().replace(/\s+—\s+$/, '')
          saveClipAsTemplate(first.sceneId, first.trackId, autoName)
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
  onSaveAsTemplate,
  onClose
}: {
  x: number
  y: number
  targets: { sceneId: string; trackId: string }[]
  templates: { id: string; name: string }[]
  onApplyTemplate: (id: string) => void
  onUseDefaultOsc: () => void
  onSaveAsTemplate: () => void
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
      <div className="border-t border-border my-1" />
      {/* Save the (first) clip as a reusable Clip template. The new
          template shows up in the Apply-template list above + in the
          Inspector's Templates section, ready to drop onto any other
          empty clip slot. */}
      <button
        className="w-full text-left px-3 py-1 hover:bg-panel2"
        onClick={onSaveAsTemplate}
        title={
          plural
            ? 'Save the FIRST selected clip as a reusable Clip template (multi-save would create N identical copies — skipped). Rename via the Inspector after.'
            : 'Save this clip’s value + modulation + sequencer as a reusable Clip template'
        }
      >
        Save Clip as Template
        {plural && (
          <span className="text-muted text-[10px] ml-1">(first only)</span>
        )}
      </button>
    </div>,
    document.body
  )
}

// Tiny coloured badge at the bottom-right of every clip tile so the
// user can scan the grid and see which clips fire which transport.
// Three states: OSC only (slate), MIDI only (violet), both (teal).
// When the clip has neither (a Parameter with a blank OSC address +
// disabled MIDI), no badge is rendered.
// Live MIDI byte for the cell tile. Renders just above the
// transport badge in the bottom-right of the clip. When MIDI is
// configured + the cell is currently playing (displayValue
// non-null), shows the byte the engine is about to put on the MIDI
// wire. Distinct violet (CC) / teal (Note) colour so it doesn't
// blend with the orange OSC live value above the row.
function ClipMidiLiveValue({
  cell,
  displayValue
}: {
  cell: import('@shared/types').Cell
  // Live OSC display string — null when the cell isn't playing yet
  // (we don't render a frozen "what would the byte be" tease when
  // nothing's emitting).
  displayValue: string | null
}): JSX.Element | null {
  const m = cell.midiOut
  if (!m || !m.enabled || !m.portName) return null
  if (displayValue == null) return null
  // Extract the first numeric token from the displayValue. For
  // multi-arg cells like OCTOCOSME's "compositor 0 0.5 0.5 ...", the
  // first parseable float is the user's actual sequenced/modulated
  // value — the prefix strings get skipped.
  const tokens = displayValue.trim().split(/\s+/)
  let firstNum: number | null = null
  for (const tok of tokens) {
    const n = parseFloat(tok)
    if (Number.isFinite(n)) {
      firstNum = n
      break
    }
  }
  if (firstNum === null) return null
  // Same mapping the engine uses: scaleToUnit OR midiScale → multiply
  // by 127. Otherwise the value is already in MIDI range (0..127).
  const wantMap = !!cell.midiScale || cell.scaleToUnit
  const ccByte = Math.max(
    0,
    Math.min(127, Math.round(wantMap ? firstNum * 127 : firstNum))
  )
  // For Note mode the same value drives the NOTE NUMBER; velocity
  // comes from the separate cell.velocity field.
  if (m.kind === 'note') {
    const noteMap = wantMap
      ? Math.round(36 + firstNum * (84 - 36))
      : Math.round(firstNum)
    const note = Math.max(0, Math.min(127, noteMap))
    const velRaw = parseFloat(cell.velocity ?? '100')
    const vel = Number.isFinite(velRaw)
      ? Math.max(0, Math.min(127, Math.round(velRaw)))
      : 100
    return (
      <span
        className="text-[10px] font-mono font-semibold leading-none tabular-nums"
        style={{ color: 'rgb(195 150 240)' }} /* violet — matches MIDI badge */
        title={`MIDI Note ${note}, velocity ${vel} on ch${m.channel}`}
      >
        {note}→{vel}
      </span>
    )
  }
  // CC mode — single byte 0..127.
  return (
    <span
      className="text-[10px] font-mono font-semibold leading-none tabular-nums"
      style={{ color: 'rgb(120 220 200)' }} /* teal — matches OSC/MIDI mix */
      title={`MIDI CC ${m.cc ?? 0} = ${ccByte} on ch${m.channel}`}
    >
      {ccByte}
    </span>
  )
}

function ClipTransportBadge({
  oscOn,
  midiOn
}: {
  oscOn: boolean
  midiOn: boolean
}): JSX.Element | null {
  if (!oscOn && !midiOn) return null
  const label = oscOn && midiOn ? 'OSC/MIDI' : oscOn ? 'OSC' : 'MIDI'
  // Distinct color per state — none of these are the orange accent
  // or the cyan accent2 already used for live values + modulator
  // chips. Keeps the visual layer cleanly distinct.
  const bg =
    oscOn && midiOn
      ? 'rgb(80 200 180 / 0.18)' // teal tint
      : midiOn
        ? 'rgb(170 110 220 / 0.18)' // violet tint
        : 'rgb(150 165 185 / 0.18)' // slate tint
  const fg =
    oscOn && midiOn
      ? 'rgb(120 220 200)'
      : midiOn
        ? 'rgb(195 150 240)'
        : 'rgb(175 185 200)'
  return (
    <span
      className="text-[8px] font-mono font-semibold px-1 py-px rounded leading-none shrink-0"
      style={{ background: bg, color: fg, letterSpacing: '0.04em' }}
      title={`Transport: ${label}`}
    >
      {label}
    </span>
  )
}
