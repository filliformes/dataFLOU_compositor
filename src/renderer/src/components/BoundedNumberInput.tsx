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
  disabled
}: Props): JSX.Element {
  const [str, setStr] = useState(formatValue(value, integer))
  const focused = useRef(false)

  // Sync external value into local string (skipped while focused so we don't
  // clobber the user's in-progress typing).
  useEffect(() => {
    if (!focused.current) setStr(formatValue(value, integer))
  }, [value, integer])

  const re = integer ? /^-?\d*$/ : /^-?\d*\.?\d*([eE][-+]?\d*)?$/

  return (
    <input
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
        if (!re.test(v)) return
        setStr(v)
        if (v === '' || v === '-' || v === '.' || v === '-.') return
        const n = integer ? parseInt(v, 10) : parseFloat(v)
        if (!Number.isFinite(n)) return
        const clamped = Math.max(min, Math.min(max, n))
        onChange(clamped)
      }}
      onBlur={() => {
        focused.current = false
        // Empty/invalid → restore last good value.
        if (str === '' || str === '-' || str === '.' || str === '-.') {
          setStr(formatValue(value, integer))
          return
        }
        const n = integer ? parseInt(str, 10) : parseFloat(str)
        if (!Number.isFinite(n)) {
          setStr(formatValue(value, integer))
          return
        }
        const clamped = Math.max(min, Math.min(max, n))
        if (clamped !== n) onChange(clamped)
        setStr(formatValue(clamped, integer))
      }}
    />
  )
}

function formatValue(v: number, integer: boolean): string {
  if (!Number.isFinite(v)) return ''
  return integer ? String(Math.round(v)) : String(v)
}
