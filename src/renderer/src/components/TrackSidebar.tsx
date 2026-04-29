// Edit-view left sidebar — used to be a flat "Messages" column. With the
// merger toward dataFLOU, every row is now an INSTRUMENT, and each
// instrument is one of two kinds:
//
//   • template  — a Reaper-style group header. Owns no clips of its own;
//                 visually owns the Function rows that follow it (matched
//                 via parentTrackId).
//   • function  — a child row of a template (or an "orphan" if no parent).
//                 Holds clips like the old Messages did. Engine-side
//                 nothing changes — clips still live in scene.cells[trackId].
//
// Drop-target accepts drags from the Pool drawer (Templates or Functions)
// and instantiates them via the store actions. Right-click menu offers the
// authoring path.
//
// Visual hierarchy: Template rows get a 4-px color stripe on their left
// edge and a bolder name. Function rows that have a parent Template get a
// thinner tinted stripe + a left indent so the group reads at a glance.

import { useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import { useStore } from '../store'
import { useHeaderHeight } from './EditView'
import { ResizeHandle } from './ResizeHandle'
import { UncontrolledTextInput } from './UncontrolledInput'
import {
  POOL_FUNCTION_DRAG_MIME,
  POOL_TEMPLATE_DRAG_MIME,
  type PoolFunctionDragPayload,
  type PoolTemplateDragPayload
} from './PoolPane'
import type { InstrumentTemplate } from '@shared/types'

export default function TrackSidebar(): JSX.Element {
  const tracks = useStore((s) => s.session.tracks)
  const scenes = useStore((s) => s.session.scenes)
  const pool = useStore((s) => s.session.pool)
  const addTrack = useStore((s) => s.addTrack)
  const addScene = useStore((s) => s.addScene)
  const removeTracks = useStore((s) => s.removeTracks)
  const renameTrack = useStore((s) => s.renameTrack)
  const selectedTrackIds = useStore((s) => s.selectedTrackIds)
  const selectTrack = useStore((s) => s.selectTrack)
  const selectTrackRange = useStore((s) => s.selectTrackRange)
  const rowHeight = useStore((s) => s.rowHeight)
  const setRowHeight = useStore((s) => s.setRowHeight)
  const notesHeight = useStore((s) => s.editorNotesHeight)
  const setNotesHeight = useStore((s) => s.setEditorNotesHeight)
  const tracksCollapsedRaw = useStore((s) => s.tracksCollapsed)
  const scenesCollapsedRaw = useStore((s) => s.scenesCollapsed)
  const showMode = useStore((s) => s.showMode)
  const instantiateTemplate = useStore((s) => s.instantiateTemplate)
  const instantiateFunction = useStore((s) => s.instantiateFunction)
  const addFunctionToTemplate = useStore((s) => s.addFunctionToTemplate)
  const setOscMonitorOpen = useStore((s) => s.setOscMonitorOpen)
  // Show mode forces the compact layout even when the user had the bar
  // expanded pre-entry — performers see more rows/scenes at once and the
  // sprawling +Scene / +Instrument row is hidden anyway.
  const tracksCollapsed = tracksCollapsedRaw || showMode
  const scenesCollapsed = scenesCollapsedRaw || showMode
  const headerH = useHeaderHeight()

  // Lookup map: sourceTemplateId → Pool template (for color resolution).
  // Memoised against pool.templates so we don't rebuild on every render
  // pass even when the templates haven't changed.
  const templateById = useMemo(() => {
    const m = new Map<string, InstrumentTemplate>()
    for (const t of pool.templates) m.set(t.id, t)
    return m
  }, [pool.templates])

  // Right-click context menu. `targets` is the list of tracks the menu
  // acts on; `kind` drives which menu items show (Add Function only when
  // right-clicked on / inside a template group, etc.).
  const [menu, setMenu] = useState<
    | {
        x: number
        y: number
        targets: string[]
        anchorTrackId: string | null     // the row right-clicked, null = empty space
      }
    | null
  >(null)
  useEffect(() => {
    if (!menu) return
    const close = (): void => setMenu(null)
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setMenu(null)
    }
    window.addEventListener('mousedown', close)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', close)
      window.removeEventListener('keydown', onKey)
    }
  }, [menu])

  const instrFull = tracks.length >= 128
  const sceneFull = scenes.length >= 128

  // ─── Drag-and-drop from the Pool ───────────────────────────────────
  // Accept Pool drags. Hover state lights the sidebar's outline so the
  // user knows it's a valid drop target.
  const [dragHover, setDragHover] = useState(false)
  function onDragOverSidebar(e: React.DragEvent): void {
    if (
      !e.dataTransfer.types.includes(POOL_TEMPLATE_DRAG_MIME) &&
      !e.dataTransfer.types.includes(POOL_FUNCTION_DRAG_MIME)
    )
      return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'copy'
    setDragHover(true)
  }
  function onDragLeaveSidebar(): void {
    setDragHover(false)
  }
  // Find the track id whose row contains a given clientY, so drops insert
  // *after* that row. null = drop in empty space → append at end.
  function trackIdAt(clientY: number, container: HTMLElement): string | null {
    const rows = container.querySelectorAll<HTMLElement>('[data-track-id]')
    let last: string | null = null
    for (const row of Array.from(rows)) {
      const r = row.getBoundingClientRect()
      if (clientY < r.top + r.height / 2) return last
      last = row.dataset.trackId ?? null
    }
    return last
  }
  function onDropSidebar(e: React.DragEvent): void {
    setDragHover(false)
    const tplRaw = e.dataTransfer.getData(POOL_TEMPLATE_DRAG_MIME)
    const fnRaw = e.dataTransfer.getData(POOL_FUNCTION_DRAG_MIME)
    if (!tplRaw && !fnRaw) return
    e.preventDefault()
    const container = e.currentTarget as HTMLElement
    const insertAfter = trackIdAt(e.clientY, container)
    if (tplRaw) {
      try {
        const p = JSON.parse(tplRaw) as PoolTemplateDragPayload
        instantiateTemplate(p.templateId, insertAfter)
      } catch {
        /* ignore */
      }
    } else if (fnRaw) {
      try {
        const p = JSON.parse(fnRaw) as PoolFunctionDragPayload
        // If the drop landed on / inside an existing instantiated Template
        // group, nest the new Function under it. Otherwise create an
        // orphan Function row.
        let parentTrackId: string | null = null
        if (insertAfter) {
          const here = tracks.find((t) => t.id === insertAfter)
          if (here?.kind === 'template') parentTrackId = here.id
          else if (here?.kind === 'function' && here.parentTrackId)
            parentTrackId = here.parentTrackId
        }
        instantiateFunction(p.templateId, p.functionId, insertAfter, parentTrackId)
      } catch {
        /* ignore */
      }
    }
  }

  return (
    <div
      className={`bg-panel border-r border-border flex flex-col h-full ${
        dragHover ? 'outline outline-2 outline-accent2 -outline-offset-2' : ''
      }`}
      onDragOver={onDragOverSidebar}
      onDragLeave={onDragLeaveSidebar}
      onDrop={onDropSidebar}
      onContextMenu={(e) => {
        // Right-click on empty space below the rows — show the "add" menu.
        // Per-row right-click handlers stop propagation so they don't get here.
        e.preventDefault()
        setMenu({ x: e.clientX, y: e.clientY, targets: [], anchorTrackId: null })
      }}
    >
      {/* Header — same height as scene column headers. */}
      <div
        className="relative border-b border-border px-2 py-2"
        style={{ height: headerH }}
      >
        {scenesCollapsed ? (
          <div className="flex items-center justify-between gap-1 h-full">
            <span className="label truncate text-[10px]">
              S {scenes.length} · I {tracks.length}
            </span>
            <div className="flex items-center gap-1">
              <button
                data-hide-in-show="true"
                className="btn"
                disabled={sceneFull}
                onClick={addScene}
                title={sceneFull ? 'Max 128 scenes' : 'Add scene'}
              >
                +S
              </button>
              <button
                data-hide-in-show="true"
                className="btn"
                disabled={instrFull}
                onClick={addTrack}
                title={instrFull ? 'Max 128 instruments' : 'Add Instrument (orphan Function)'}
              >
                +I
              </button>
            </div>
          </div>
        ) : (
          <div className="flex flex-col justify-center gap-1.5 h-full">
            {/* Row 1 — Scenes counter + Add scene. */}
            <div className="flex items-center justify-between gap-2">
              <span className="label truncate">Scenes ({scenes.length}/128)</span>
              <button
                data-hide-in-show="true"
                className="btn shrink-0"
                disabled={sceneFull}
                onClick={addScene}
                title={sceneFull ? 'Max 128 scenes' : 'Add scene'}
              >
                + Scene
              </button>
            </div>
            {/* Row 2 — Instruments counter + Add. The "+ Instrument"
                button creates an orphan Function (the old "+ Message"
                behavior). Templates land here via the Pool drawer
                (drag-drop) or the right-click menu. */}
            <div className="flex items-center justify-between gap-2">
              <span className="label truncate">Instruments ({tracks.length}/128)</span>
              <div className="flex items-center gap-1 shrink-0">
                <button
                  data-hide-in-show="true"
                  className="btn"
                  disabled={instrFull}
                  onClick={addTrack}
                  title={instrFull ? 'Max 128 instruments' : 'Add an orphan Function row'}
                >
                  + Instrument
                </button>
                <button
                  data-hide-in-show="true"
                  className="btn"
                  onClick={() => setOscMonitorOpen(true)}
                  title="Open the OSC monitor + Pool drawer to drag in Templates"
                >
                  Pool…
                </button>
              </div>
            </div>
          </div>
        )}
        <ResizeHandle
          direction="row"
          value={notesHeight}
          onChange={setNotesHeight}
          min={0}
          max={220}
          className="absolute bottom-0 left-0 right-0 h-[4px]"
          title="Drag to resize scene notes"
        />
      </div>

      {tracks.map((t) => {
        const isSelected = selectedTrackIds.includes(t.id)
        const effectiveRowH = tracksCollapsed ? 32 : rowHeight
        const isTemplate = t.kind === 'template'
        // Resolve the color stripe. Template-row → its own template's
        // color. Function-row with a parent → look up parent's
        // sourceTemplateId. Function-row without a parent → no stripe.
        const tplForColor = (() => {
          if (isTemplate && t.sourceTemplateId) return templateById.get(t.sourceTemplateId)
          if (t.parentTrackId) {
            const parent = tracks.find((tt) => tt.id === t.parentTrackId)
            if (parent?.sourceTemplateId) return templateById.get(parent.sourceTemplateId)
          }
          if (!isTemplate && t.sourceTemplateId) return templateById.get(t.sourceTemplateId)
          return undefined
        })()
        const stripeColor = tplForColor?.color ?? null
        // Indent for Function rows that live inside a Template group.
        const isNestedFunction = !isTemplate && !!t.parentTrackId
        return (
          <div
            key={t.id}
            data-track-id={t.id}
            className={`relative border-b border-border flex shrink-0 cursor-pointer overflow-hidden ${
              tracksCollapsed
                ? 'flex-row items-center px-2 gap-2'
                : 'flex-col justify-center gap-1 px-3'
            } ${isSelected ? 'bg-panel2' : 'hover:bg-panel3/30'} ${
              isTemplate ? 'bg-panel/80' : ''
            }`}
            style={{
              height: effectiveRowH,
              // Color stripe on the left edge — solid for templates,
              // 33%-alpha tint for child functions, none for orphans.
              borderLeft: stripeColor
                ? `${isTemplate ? 4 : 2}px solid ${stripeColor}${isTemplate ? '' : '88'}`
                : undefined,
              paddingLeft: isNestedFunction ? 18 : undefined
            }}
            onClick={(e) => {
              if (e.shiftKey) selectTrackRange(t.id)
              else selectTrack(t.id)
            }}
            onContextMenu={(e) => {
              const tag = (e.target as HTMLElement | null)?.tagName
              if (tag === 'INPUT' || tag === 'TEXTAREA') return
              e.preventDefault()
              e.stopPropagation()
              const inSel = selectedTrackIds.includes(t.id)
              const targets =
                inSel && selectedTrackIds.length > 1 ? selectedTrackIds : [t.id]
              if (!inSel) selectTrack(t.id)
              setMenu({ x: e.clientX, y: e.clientY, targets, anchorTrackId: t.id })
            }}
          >
            <UncontrolledTextInput
              className={`input ${
                tracksCollapsed
                  ? 'text-[11px] py-0.5 flex-1'
                  : isTemplate
                    ? 'text-[12px] font-bold'
                    : 'text-[12px] font-medium'
              }`}
              value={t.name}
              onClick={(e) => e.stopPropagation()}
              onMouseDown={(e) => e.stopPropagation()}
              onChange={(v) => renameTrack(t.id, v)}
              placeholder={isTemplate ? 'Template name' : 'Function name'}
            />
            {isTemplate && !tracksCollapsed && (
              <span className="text-[9px] text-muted">TEMPLATE</span>
            )}
            {!tracksCollapsed && (
              <ResizeHandle
                direction="row"
                value={rowHeight}
                onChange={setRowHeight}
                min={60}
                max={220}
                className="absolute bottom-0 left-0 right-0 h-[4px]"
                title="Drag to resize all instrument rows"
              />
            )}
          </div>
        )
      })}

      {/* Right-click menu. Portaled to body so it isn't clipped. */}
      {menu &&
        createPortal(
          <div
            className="fixed z-50 bg-panel border border-border rounded shadow-lg py-1 text-[12px] min-w-[200px]"
            style={{ left: menu.x, top: menu.y }}
            onMouseDown={(e) => e.stopPropagation()}
          >
            {/* Add Template / Add Function — always available. Both open
                the Pool drawer because that's where authoring lives. */}
            <button
              className="w-full text-left px-3 py-1 hover:bg-panel2"
              onClick={() => {
                setMenu(null)
                setOscMonitorOpen(true)
              }}
            >
              Open Pool drawer…
            </button>
            <div className="border-t border-border my-1" />
            <button
              className="w-full text-left px-3 py-1 hover:bg-panel2"
              onClick={() => {
                setMenu(null)
                addTrack() // orphan Function row, default name
              }}
            >
              Add orphan Function (blank row)
            </button>
            {/* Add a Function inside an existing template group. Available
                when the right-click anchor was a Template row OR a
                Function row that already has a parent. */}
            {(() => {
              if (!menu.anchorTrackId) return null
              const anchor = tracks.find((tt) => tt.id === menu.anchorTrackId)
              if (!anchor) return null
              const groupTpl =
                anchor.kind === 'template'
                  ? anchor
                  : anchor.parentTrackId
                    ? tracks.find((tt) => tt.id === anchor.parentTrackId)
                    : null
              if (!groupTpl) return null
              const tplDef = groupTpl.sourceTemplateId
                ? templateById.get(groupTpl.sourceTemplateId)
                : null
              return (
                <button
                  className="w-full text-left px-3 py-1 hover:bg-panel2"
                  disabled={!tplDef}
                  onClick={() => {
                    setMenu(null)
                    if (!tplDef) return
                    // Add a NEW function spec to the source Template,
                    // then instantiate it into the live group.
                    const newFnId = addFunctionToTemplate(tplDef.id)
                    if (!newFnId) return
                    instantiateFunction(
                      tplDef.id,
                      newFnId,
                      groupTpl.id,
                      groupTpl.id
                    )
                  }}
                  title={
                    tplDef
                      ? `Adds a new Function to "${tplDef.name}" and instantiates it here`
                      : 'Source template no longer in the Pool'
                  }
                >
                  Add Function to "{groupTpl.name}"…
                </button>
              )
            })()}
            {menu.targets.length > 0 && (
              <>
                <div className="border-t border-border my-1" />
                <button
                  className="w-full text-left px-3 py-1 hover:bg-panel2 text-danger"
                  onClick={() => {
                    const ids = menu.targets
                    setMenu(null)
                    const n = ids.length
                    if (n === 0) return
                    const label =
                      n === 1
                        ? `Delete "${tracks.find((t) => t.id === ids[0])?.name ?? ''}"?` +
                          (tracks.find((t) => t.id === ids[0])?.kind === 'template'
                            ? ' (Will also delete its Function children.)'
                            : '')
                        : `Delete ${n} instruments?`
                    if (confirm(label)) removeTracks(ids)
                  }}
                >
                  {menu.targets.length > 1
                    ? `Delete ${menu.targets.length} instruments`
                    : 'Delete instrument'}
                </button>
              </>
            )}
          </div>,
          document.body
        )}
    </div>
  )
}
