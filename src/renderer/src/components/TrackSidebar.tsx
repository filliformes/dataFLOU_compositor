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
  POOL_PARAMETER_DRAG_MIME,
  POOL_TEMPLATE_DRAG_MIME,
  type PoolFunctionDragPayload,
  type PoolParameterDragPayload,
  type PoolTemplateDragPayload
} from './PoolPane'
import type { InstrumentTemplate } from '@shared/types'

// MIME for in-sidebar row reorder drags. Keeps row drags from being
// mistaken for Pool drags (different shape, different drop target).
const TRACK_REORDER_DRAG_MIME = 'application/x-dataflou-track-reorder'

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
  const addInstrumentRow = useStore((s) => s.addInstrumentRow)
  const addFunctionToInstrumentRow = useStore((s) => s.addFunctionToInstrumentRow)
  const saveAsTemplate = useStore((s) => s.saveAsTemplate)
  const oscMonitorOpen = useStore((s) => s.oscMonitorOpen)
  const poolHidden = useStore((s) => s.poolHidden)
  const moveTrack = useStore((s) => s.moveTrack)
  const instantiateParameterTemplate = useStore((s) => s.instantiateParameterTemplate)
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

  // ─── Drag-and-drop from the Pool + in-sidebar row reorder ──────────
  // Accept Pool drags AND row-reorder drags. Hover state lights the
  // sidebar's outline so the user knows it's a valid drop target.
  const [dragHover, setDragHover] = useState(false)
  function onDragOverSidebar(e: React.DragEvent): void {
    const types = e.dataTransfer.types
    const isPool =
      types.includes(POOL_TEMPLATE_DRAG_MIME) ||
      types.includes(POOL_FUNCTION_DRAG_MIME) ||
      types.includes(POOL_PARAMETER_DRAG_MIME)
    const isReorder = types.includes(TRACK_REORDER_DRAG_MIME)
    if (!isPool && !isReorder) return
    e.preventDefault()
    e.dataTransfer.dropEffect = isReorder ? 'move' : 'copy'
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
    const paramRaw = e.dataTransfer.getData(POOL_PARAMETER_DRAG_MIME)
    const reorderRaw = e.dataTransfer.getData(TRACK_REORDER_DRAG_MIME)
    if (!tplRaw && !fnRaw && !paramRaw && !reorderRaw) return
    e.preventDefault()
    const container = e.currentTarget as HTMLElement
    const insertAfter = trackIdAt(e.clientY, container)
    if (reorderRaw) {
      // In-sidebar row reorder. moveTrack handles all the cascade /
      // group-stay-together rules.
      const dragId = reorderRaw
      if (dragId !== insertAfter) moveTrack(dragId, insertAfter)
      return
    }
    if (paramRaw) {
      try {
        const p = JSON.parse(paramRaw) as PoolParameterDragPayload
        // Same parent-resolution rule as Function drops: dropping into a
        // Template group nests under it; otherwise create an orphan row.
        let parentTrackId: string | null = null
        if (insertAfter) {
          const here = tracks.find((t) => t.id === insertAfter)
          if (here?.kind === 'template') parentTrackId = here.id
          else if (here?.kind === 'function' && here.parentTrackId)
            parentTrackId = here.parentTrackId
        }
        instantiateParameterTemplate(p.parameterId, insertAfter, parentTrackId)
      } catch {
        /* ignore */
      }
      return
    }
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
                onClick={() => addInstrumentRow(null)}
                title={instrFull ? 'Max 128 instruments' : 'Add Instrument (template header row)'}
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
                button creates a fresh draft Template (header row +
                Pool entry) the user can populate with Parameters.
                Pool drawer drag-drop and the right-click menu offer
                the alternate paths (orphan Parameter, instantiate
                existing Template). */}
            <div className="flex items-center justify-between gap-2">
              <span className="label truncate">Instruments ({tracks.length}/128)</span>
              <div className="flex items-center gap-1 shrink-0">
                <button
                  data-hide-in-show="true"
                  className="btn"
                  disabled={instrFull}
                  onClick={() => addInstrumentRow(null)}
                  title={instrFull ? 'Max 128 instruments' : 'Add a new Instrument (Ctrl+T)'}
                >
                  + Instrument
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
            draggable
            onDragStart={(e) => {
              // Don't intercept drags that start inside the inline rename
              // input — let the user select text without snatching the
              // mouse for a row reorder.
              const tag = (e.target as HTMLElement | null)?.tagName
              if (tag === 'INPUT' || tag === 'TEXTAREA') {
                e.preventDefault()
                return
              }
              // Sidebar rows are also drag SOURCES for reordering. We set
              // a row-reorder MIME so the sidebar drop handler can
              // distinguish reorders from Pool drops.
              e.dataTransfer.setData(TRACK_REORDER_DRAG_MIME, t.id)
              e.dataTransfer.effectAllowed = 'move'
            }}
            className={`relative border-b border-border flex shrink-0 cursor-grab overflow-hidden ${
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
              placeholder={isTemplate ? 'Template name' : 'Parameter name'}
            />
            {/* TEMPLATE label + +PARAM trigger share the baseline
                row under the name input. Both use text-[9px] so they
                read as one strip. The trigger keeps a button outline
                (1 px border + tiny padding) so it reads as
                clickable, but stays the same height as the label. */}
            {isTemplate && !tracksCollapsed && (
              <div className="flex items-center justify-between text-[9px] text-muted leading-none -mt-0.5">
                <span>TEMPLATE</span>
                <button
                  data-hide-in-show="true"
                  className="text-[9px] leading-none px-1 py-[1px] rounded-sm border border-border text-muted hover:text-text hover:border-text"
                  onClick={(e) => {
                    e.stopPropagation()
                    addFunctionToInstrumentRow(t.id)
                  }}
                  onMouseDown={(e) => e.stopPropagation()}
                  title="Add a Parameter to this Instrument (Ctrl+P)"
                >
                  +PARAM
                </button>
              </div>
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
            className="fixed z-50 bg-panel border border-border rounded shadow-lg py-1 text-[12px] min-w-[220px]"
            style={{ left: menu.x, top: menu.y }}
            onMouseDown={(e) => e.stopPropagation()}
          >
            {/* Resolve the "anchor template" once — i.e. the Template
                row this right-click is "inside" (either it WAS a
                Template row, or it was a Function row whose parent is
                a Template row). Drives the conditional menu items. */}
            {(() => {
              const anchor = menu.anchorTrackId
                ? tracks.find((tt) => tt.id === menu.anchorTrackId) ?? null
                : null
              const groupTpl =
                anchor?.kind === 'template'
                  ? anchor
                  : anchor?.parentTrackId
                    ? tracks.find((tt) => tt.id === anchor.parentTrackId) ?? null
                    : null
              const groupTplName = groupTpl?.name ?? ''
              return (
                <>
                  {/* 1. Add Instrument — creates an empty draft Template
                         row in the sidebar (Pool gets a hidden draft entry
                         behind it). Always available. */}
                  <button
                    className="w-full text-left px-3 py-1 hover:bg-panel2"
                    onClick={() => {
                      const insertAfter = menu.anchorTrackId
                      setMenu(null)
                      addInstrumentRow(insertAfter)
                    }}
                  >
                    Add Instrument
                  </button>

                  {/* 2. Add orphan Parameter — the old "+ Message" path,
                         creates a no-parent Parameter row. */}
                  <button
                    className="w-full text-left px-3 py-1 hover:bg-panel2"
                    onClick={() => {
                      setMenu(null)
                      addTrack()
                    }}
                  >
                    Add orphan Parameter
                  </button>

                  {/* 3. Add Parameter to <Instrument> — only when right-
                         clicked inside an Instrument group. */}
                  {groupTpl && (
                    <button
                      className="w-full text-left px-3 py-1 hover:bg-panel2"
                      onClick={() => {
                        setMenu(null)
                        addFunctionToInstrumentRow(groupTpl.id)
                      }}
                      title={`Add a new Parameter to "${groupTplName}"`}
                    >
                      Add Parameter to "{groupTplName}"
                    </button>
                  )}

                  {/* 4. Save as Template — only when the anchor is a
                         Template row (i.e. the user right-clicked the
                         header itself). Prompts for a name and flips
                         the linked Pool entry from draft → saved. */}
                  {anchor?.kind === 'template' && anchor.sourceTemplateId && (
                    <>
                      <div className="border-t border-border my-1" />
                      <button
                        className="w-full text-left px-3 py-1 hover:bg-panel2"
                        onClick={() => {
                          setMenu(null)
                          const proposed = anchor.name || 'My Instrument'
                          const name = prompt(
                            'Save Instrument as Template — name?',
                            proposed
                          )
                          if (name && name.trim()) {
                            saveAsTemplate(anchor.id, name.trim())
                          }
                        }}
                        title="Save this Instrument + all its Parameters as a reusable Template in the Pool"
                      >
                        Save as Template…
                      </button>
                    </>
                  )}

                  {/* Show / Hide Pool — replaces the old top-bar Pool
                      button. Toggles the OSC monitor drawer (and
                      ensures the Pool pane inside it is visible) so
                      the user can drag Templates / Parameters from
                      the Pool onto the sidebar. P keyboard shortcut
                      does the same thing. */}
                  <div className="border-t border-border my-1" />
                  <button
                    className="w-full text-left px-3 py-1 hover:bg-panel2"
                    onClick={() => {
                      setMenu(null)
                      const st = useStore.getState()
                      const poolVisible = st.oscMonitorOpen && !st.poolHidden
                      if (poolVisible) {
                        st.setPoolHidden(true)
                      } else {
                        if (!st.oscMonitorOpen) st.setOscMonitorOpen(true)
                        if (st.poolHidden) st.setPoolHidden(false)
                      }
                    }}
                    title="Toggle the Pool drawer (P)"
                  >
                    {oscMonitorOpen && !poolHidden ? 'Hide Pool' : 'Show Pool'}
                  </button>

                  {/* 5. Delete (existing). */}
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
                          const target = tracks.find((t) => t.id === ids[0])
                          const label =
                            n === 1
                              ? `Delete "${target?.name ?? ''}"?` +
                                (target?.kind === 'template'
                                  ? ' (Will also delete its Parameter children.)'
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
                </>
              )
            })()}
          </div>,
          document.body
        )}
    </div>
  )
}
