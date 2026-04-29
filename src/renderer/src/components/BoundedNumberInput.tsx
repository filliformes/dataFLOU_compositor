// A controlled number input that:
//  - accepts floats (or just ints when integer=true)
//  - allows the field to be EMPTY during editing (instead of snapping to 0)
//  - clamps to [min, max] and reverts to the previous value on blur if invalid
//  - hides spinner arrows (handled globally in styles.css)
//
// Use this anywhere a typical <input type="number"> would otherwise hijack
// the user's keystrokes (delete-everything snaps to 0, etc.).

import { useEffect, useRef, useState } from 'react'

interface Props {
  value: number
  onChange: (v: number) => void
  min?: number
  max?: number
  integer?: boolean
  step?: number
  placeholder?: string
  className?: string
  title?: string
  // Pass-through to the native input. Lets the Inspector pane render
  // builtin / read-only Templates without forking the component.
  disabled?: boolean
  // Bumping this number focuses the input and selects all its text on
  // the next render — used by the Sequence view to "land" on the
  // Duration field after the user drops a scene into a Scene Step.
  autoFocusToken?: number
}

export function BoundedNumberInput({
  value,
  onChange,
  min = -Infinity,
  max = Infinity,
  integer = false,
  placeholder,
  className,
  title,
  disabled,
  autoFocusToken
}: Props): JSX.Element {
  const [str, setStr] = useState(formatValue(value, integer))
  const focused = useRef(false)
  // Latest str — read inside onBlur to avoid stale-closure issues
  // (the previous version closed over the str captured at handler-
  // creation time, which intermittently caused onBlur to "restore"
  // an old value after a fast type-then-blur sequence).
  const strRef = useRef(str)
  strRef.current = str
  // DOM ref for autoFocusToken handling.
  const inputRef = useRef<HTMLInputElement | null>(null)
  // Capture the initial token so we skip the on-mount fire — only
  // INCREMENTS of the token from the parent should pull focus, not
  // the first paint after the panel mounts.
  const initialTokenRef = useRef(autoFocusToken)
  useEffect(() => {
    if (autoFocusToken === undefined) return
    if (autoFocusToken === initialTokenRef.current) return
    // Defer to a microtask so any in-flight focus events from the
    // upstream gesture (drop's mouseup, dnd-kit drag-end cleanup,
    // React's commit phase) finish before we claim focus. Without
    // this the input ends up visually selected but the browser
    // keeps focus elsewhere, so keystrokes don't actually edit it.
    const id = setTimeout(() => {
      const el = inputRef.current
      if (!el) return
      el.focus()
      el.select()
      // Mark the input as "edit-ready" — focused.current is what
      // the on-blur and value-sync paths gate on. Without this, a
      // value re-sync arriving on the same tick would clobber str.
      focused.current = true
    }, 0)
    return () => clearTimeout(id)
  }, [autoFocusToken])

  // Sync external value into local string. Runs on every `value`
  // change. The rule: if the str the user is typing currently parses
  // to the external value (after clamping), leave it alone — that
  // means the typing is up-to-date. Otherwise overwrite str with the
  // formatted value. This keeps unfocused fields fresh AND lets a
  // focused field accept external updates that don't conflict (e.g.,
  // switching the focused scene in the inspector while a stale
  // Dur=5 was being typed) without clobbering an in-progress edit
  // that already targets the new value.
  useEffect(() => {
    const cur = strRef.current
    const parsed = integer ? parseInt(cur, 10) : parseFloat(cur)
    if (Number.isFinite(parsed)) {
      const clamped = Math.max(min, Math.min(max, parsed))
      if (clamped === value) return
    }
    setStr(formatValue(value, integer))
  }, [value, integer, min, max])

  const re = integer ? /^-?\d*$/ : /^-?\d*\.?\d*([eE][-+]?\d*)?$/

  function commit(raw: string): void {
    if (raw === '' || raw === '-' || raw === '.' || raw === '-.') {
      setStr(formatValue(value, integer))
      return
    }
    const n = integer ? parseInt(raw, 10) : parseFloat(raw)
    if (!Number.isFinite(n)) {
      setStr(formatValue(value, integer))
      return
    }
    const clamped = Math.max(min, Math.min(max, n))
    if (clamped !== value) onChange(clamped)
    setStr(formatValue(clamped, integer))
  }

  return (
    <input
      ref={inputRef}
      className={className ?? 'input'}
      type="text"
      inputMode={integer ? 'numeric' : 'decimal'}
      value={str}
      placeholder={placeholder}
      title={title}
      disabled={disabled}
      onFocus={() => {
        focused.current = true
      }}
      onChange={(e) => {
        const v = e.target.value
        // Reject invalid characters but DON'T early-return on empty —
        // we still want the input to clear when the user backspaces
        // everything, so they can retype from scratch.
        if (!re.test(v)) return
        setStr(v)
        // Live commit only for a fully-parsable value. Empty / sign-
        // only / dot-only intermediaries leave the parent value
        // untouched until blur.
        if (v === '' || v === '-' || v === '.' || v === '-.') return
        const n = integer ? parseInt(v, 10) : parseFloat(v)
        if (!Number.isFinite(n)) return
        const clamped = Math.max(min, Math.min(max, n))
        if (clamped !== value) onChange(clamped)
      }}
      onBlur={() => {
        focused.current = false
        commit(strRef.current)
      }}
      onKeyDown={(e) => {
        // Enter commits-and-blurs so the user gets the same "value
        // settles" feedback as clicking elsewhere. Escape reverts to
        // the last-good external value without committing.
        if (e.key === 'Enter') {
          ;(e.currentTarget as HTMLInputElement).blur()
        } else if (e.key === 'Escape') {
          setStr(formatValue(value, integer))
          ;(e.currentTarget as HTMLInputElement).blur()
        }
      }}
    />
  )
}

function formatValue(v: number, integer: boolean): string {
  if (!Number.isFinite(v)) return ''
  return integer ? String(Math.round(v)) : String(v)
}
