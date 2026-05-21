// GestureRecorder — XY surface for the Gesture modulator.
//
// The user clicks RECORD, then drags on the square SVG canvas. Every
// pointermove during the recording is captured as a GesturePoint
// (relative ms timestamp + x/y in [0, 1] inside the canvas). When the
// user releases the pointer, recording stops and the captured path
// becomes the gesture.
//
// Live drawing — the in-progress polyline AND a small "crayon" dot
// at the current pointer position render as the user drags, so the
// gesture is visible while it's being drawn (same feel as the Draw
// sequencer canvas).
//
// Once a gesture is stored, the canvas shows:
//   - the committed polyline drawn as an SVG path
//   - the live engine playhead position (driven from the engine's
//     currentValue stream, parsed as "x y" tokens) as a moving dot
//
// Modes (set in the Inspector, not here):
//   - 'xy'     — engine emits x → slot 0, y → slot 1
//   - 'merged' — engine emits radial distance √(x²+y²)/√2 broadcast
//                to every slot

import { useEffect, useRef, useState } from 'react'
import type { GesturePoint } from '@shared/types'

interface Props {
  points: GesturePoint[]
  onChange: (next: GesturePoint[]) => void
  // Live playhead position from the engine (parsed from the cell's
  // currentValue string). undefined when the cell isn't armed.
  livePlayhead?: { x: number; y: number }
}

const SIZE = 220

export function GestureRecorder({ points, onChange, livePlayhead }: Props): JSX.Element {
  const [recording, setRecording] = useState(false)
  // In-progress points — the source of truth lives in a REF so each
  // pointer event reads / writes the freshest array (avoids stale-
  // closure bugs in pointer-up where React's batched setState for
  // pointer-move might not have flushed yet). A second `tick` state
  // forces a re-render whenever the ref changes — that re-render
  // reads `drawingRef.current` directly. Net: zero per-move array
  // allocations beyond a single push, with the same visual cadence
  // as a state-backed list.
  const drawingRef = useRef<GesturePoint[] | null>(null)
  const [drawingTick, setDrawingTick] = useState(0)
  // Current pointer position (in canvas coords [0, 1]²) — drives
  // the "crayon dot" overlay while recording.
  const [crayon, setCrayon] = useState<{ x: number; y: number } | null>(null)
  const captureRef = useRef<{
    startMs: number
    pointerId: number
  } | null>(null)
  const svgRef = useRef<SVGSVGElement | null>(null)

  // Hot-key escape: if the user closes the inspector mid-recording,
  // make sure we don't leak the pointer-capture state or the
  // in-progress drawing.
  useEffect(() => {
    return () => {
      captureRef.current = null
      drawingRef.current = null
    }
  }, [])

  function localXY(e: React.PointerEvent<SVGSVGElement>): { x: number; y: number } {
    const svg = svgRef.current
    if (!svg) return { x: 0.5, y: 0.5 }
    const rect = svg.getBoundingClientRect()
    const x = (e.clientX - rect.left) / rect.width
    const y = (e.clientY - rect.top) / rect.height
    return {
      x: Math.max(0, Math.min(1, x)),
      y: Math.max(0, Math.min(1, y))
    }
  }

  function startRecord(e: React.PointerEvent<SVGSVGElement>): void {
    if (e.button !== 0) return
    e.preventDefault()
    const xy = localXY(e)
    try {
      ;(e.currentTarget as Element).setPointerCapture?.(e.pointerId)
    } catch {
      /* ignore */
    }
    captureRef.current = {
      startMs: performance.now(),
      pointerId: e.pointerId
    }
    // Reset the ref-backed array. push() into it from move/end
    // without re-allocating on every event — only the tick counter
    // toggles to trigger a re-render.
    drawingRef.current = [{ t: 0, x: xy.x, y: xy.y }]
    setDrawingTick((n) => n + 1)
    setCrayon(xy)
    setRecording(true)
  }

  function moveRecord(e: React.PointerEvent<SVGSVGElement>): void {
    const cap = captureRef.current
    if (!cap || e.pointerId !== cap.pointerId) return
    const xy = localXY(e)
    const t = performance.now() - cap.startMs
    setCrayon(xy)
    // In-place push into the ref. No O(N) copy per pointermove —
    // important for long recordings where the spread pattern
    // becomes quadratic.
    if (drawingRef.current) {
      drawingRef.current.push({ t, x: xy.x, y: xy.y })
    } else {
      drawingRef.current = [{ t, x: xy.x, y: xy.y }]
    }
    // Bump the tick counter so React re-renders. The render reads
    // drawingRef.current directly; the new point shows up in the
    // SVG polyline.
    setDrawingTick((n) => n + 1)
  }

  function endRecord(e: React.PointerEvent<SVGSVGElement>): void {
    const cap = captureRef.current
    if (!cap || e.pointerId !== cap.pointerId) return
    try {
      ;(e.currentTarget as Element).releasePointerCapture?.(e.pointerId)
    } catch {
      /* ignore */
    }
    // Commit from the REF (always fresh) — not from a closed-over
    // state variable that might be stale if React batched the last
    // pointermove's setState. Slice to clone before handing to
    // onChange so downstream mutations don't poison our local ref.
    const finalPts = drawingRef.current ? drawingRef.current.slice() : []
    onChange(finalPts)
    captureRef.current = null
    drawingRef.current = null
    setDrawingTick((n) => n + 1)
    setRecording(false)
    setCrayon(null)
  }

  function clearRecording(): void {
    onChange([])
  }

  // Visible polyline = the live in-progress drawing (while recording)
  // OR the committed points (while idle). drawingTick is read so the
  // hook tracks it for re-render purposes — the actual data comes
  // from drawingRef.current.
  void drawingTick
  const visiblePts = drawingRef.current ?? points
  const pathD =
    visiblePts.length === 0
      ? ''
      : visiblePts
          .map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.x * SIZE} ${p.y * SIZE}`)
          .join(' ')

  const totalMs =
    visiblePts.length > 0 ? visiblePts[visiblePts.length - 1].t : 0

  return (
    // Pin the root container to the canvas width so the button-row
    // text changing ("Draw to record" → "● Recording") can't reflow
    // the wrapper and shift the SVG horizontally. Centring the
    // GestureRecorder lives in the parent (GestureEditor) via
    // flex justify-center — that centring depends on a stable
    // outer-width here.
    <div
      className="flex flex-col gap-1 items-stretch"
      style={{ width: SIZE }}
    >
      <div className="flex items-center gap-2">
        <button
          className={`text-[10px] px-2 py-0 leading-tight rounded border ${
            recording
              ? 'bg-accent text-black border-accent'
              : 'border-border text-text hover:bg-panel2'
          }`}
          onClick={() => {
            if (recording) {
              // Cancel by clearing the capture and the in-progress
              // drawing without committing.
              captureRef.current = null
              drawingRef.current = null
              setDrawingTick((n) => n + 1)
              setRecording(false)
              setCrayon(null)
              return
            }
            clearRecording()
          }}
          title={
            recording
              ? 'Recording in progress — release the pointer on the canvas to commit. Click to cancel.'
              : 'Clear the current recording. Then drag on the canvas to record a new gesture.'
          }
        >
          {recording ? '● Recording' : visiblePts.length > 0 ? 'Clear' : 'Draw to record'}
        </button>
        <span className="text-[10px] text-muted">
          {visiblePts.length === 0
            ? 'empty'
            : `${visiblePts.length} pts · ${(totalMs / 1000).toFixed(2)} s`}
        </span>
      </div>
      <svg
        ref={svgRef}
        width={SIZE}
        height={SIZE}
        viewBox={`0 0 ${SIZE} ${SIZE}`}
        className="rounded border border-border bg-panel2"
        style={{ touchAction: 'none', cursor: recording ? 'crosshair' : 'cell' }}
        onPointerDown={startRecord}
        onPointerMove={moveRecord}
        onPointerUp={endRecord}
        onPointerCancel={endRecord}
      >
        {/* Centre crosshair — helps the user visually orient at (0.5, 0.5). */}
        <line
          x1={SIZE / 2}
          y1={0}
          x2={SIZE / 2}
          y2={SIZE}
          stroke="rgb(var(--c-border))"
          strokeWidth={1}
          strokeDasharray="2 4"
          opacity={0.6}
        />
        <line
          x1={0}
          y1={SIZE / 2}
          x2={SIZE}
          y2={SIZE / 2}
          stroke="rgb(var(--c-border))"
          strokeWidth={1}
          strokeDasharray="2 4"
          opacity={0.6}
        />
        {/* Gesture polyline — live (while recording) or committed
            (while idle). Stroke gets slightly more opaque while
            recording so the user feels the line "ink in". */}
        {pathD && (
          <path
            d={pathD}
            fill="none"
            stroke="rgb(var(--c-accent))"
            strokeWidth={1.5}
            strokeLinejoin="round"
            strokeLinecap="round"
            opacity={recording ? 0.95 : 0.8}
          />
        )}
        {/* Start + end markers so the user can tell which direction
            the gesture was drawn. */}
        {visiblePts.length > 1 && (
          <>
            <circle
              cx={visiblePts[0].x * SIZE}
              cy={visiblePts[0].y * SIZE}
              r={3}
              fill="rgb(var(--c-accent))"
            />
            {!recording && (
              <circle
                cx={visiblePts[visiblePts.length - 1].x * SIZE}
                cy={visiblePts[visiblePts.length - 1].y * SIZE}
                r={3}
                fill="rgb(var(--c-text))"
                opacity={0.6}
              />
            )}
          </>
        )}
        {/* Crayon dot — drawn at the current pointer position while
            recording. Filled accent circle with a thin outline so it
            reads clearly against any background. Disappears the
            instant the user releases the pointer. */}
        {crayon && recording && (
          <>
            <circle
              cx={crayon.x * SIZE}
              cy={crayon.y * SIZE}
              r={5}
              fill="rgb(var(--c-accent))"
              stroke="rgb(var(--c-panel))"
              strokeWidth={1.5}
            />
            {/* Subtle pulse ring — gives the crayon a "drawing" feel. */}
            <circle
              cx={crayon.x * SIZE}
              cy={crayon.y * SIZE}
              r={9}
              fill="none"
              stroke="rgb(var(--c-accent))"
              strokeWidth={1}
              opacity={0.35}
            />
          </>
        )}
        {/* Live engine playhead dot — moves along the curve at the
            engine's playback rate while the cell is armed AND the
            user isn't recording. */}
        {livePlayhead && !recording && (
          <circle
            cx={livePlayhead.x * SIZE}
            cy={livePlayhead.y * SIZE}
            r={5}
            fill="rgb(var(--c-accent2, var(--c-accent)))"
            stroke="rgb(var(--c-panel))"
            strokeWidth={1.5}
          />
        )}
      </svg>
      {visiblePts.length === 0 && (
        <div className="text-[10px] text-muted italic leading-snug">
          Drag inside the square to record an X/Y gesture. Loop length, output
          mode (XY / merged), and playback timing are set below.
        </div>
      )}
    </div>
  )
}
