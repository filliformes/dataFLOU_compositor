// Thin wrapper around <input>/<textarea> that's uncontrolled internally:
// the DOM owns the value while focused, and external prop changes are only
// pushed into the element when it's NOT the active element. This prevents
// controlled-component re-render races (engine ticking at 20–30Hz) from
// swallowing keystrokes or resetting focus.

import { forwardRef, useEffect, useRef } from 'react'

type InputProps = Omit<React.InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange' | 'defaultValue'> & {
  value: string
  onChange: (v: string) => void
}
type TextareaProps = Omit<
  React.TextareaHTMLAttributes<HTMLTextAreaElement>,
  'value' | 'onChange' | 'defaultValue'
> & {
  value: string
  onChange: (v: string) => void
}

export const UncontrolledTextInput = forwardRef<HTMLInputElement, InputProps>(
  function UncontrolledTextInput({ value, onChange, ...rest }, forwardedRef) {
    const inner = useRef<HTMLInputElement | null>(null)
    const setRef = (el: HTMLInputElement | null): void => {
      inner.current = el
      if (typeof forwardedRef === 'function') forwardedRef(el)
      else if (forwardedRef) (forwardedRef as { current: typeof el }).current = el
    }
    useEffect(() => {
      const el = inner.current
      if (!el) return
      if (document.activeElement !== el && el.value !== value) el.value = value
    }, [value])
    return (
      <input
        ref={setRef}
        defaultValue={value}
        onChange={(e) => onChange(e.target.value)}
        {...rest}
      />
    )
  }
)

export const UncontrolledTextarea = forwardRef<HTMLTextAreaElement, TextareaProps>(
  function UncontrolledTextarea({ value, onChange, ...rest }, forwardedRef) {
    const inner = useRef<HTMLTextAreaElement | null>(null)
    const setRef = (el: HTMLTextAreaElement | null): void => {
      inner.current = el
      if (typeof forwardedRef === 'function') forwardedRef(el)
      else if (forwardedRef) (forwardedRef as { current: typeof el }).current = el
    }
    useEffect(() => {
      const el = inner.current
      if (!el) return
      if (document.activeElement !== el && el.value !== value) el.value = value
    }, [value])
    return (
      <textarea
        ref={setRef}
        defaultValue={value}
        onChange={(e) => onChange(e.target.value)}
        {...rest}
      />
    )
  }
)
