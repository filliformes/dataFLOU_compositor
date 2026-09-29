// Lightweight centered modal — overlay + card. Closes on backdrop click or
// Esc. Use for things that benefit from a real form (vs. the native prompt).

import { useEffect } from 'react'
import { createPortal } from 'react-dom'

export function Modal({
  title,
  onClose,
  children
}: {
  title: string
  onClose: () => void
  children: React.ReactNode
}): JSX.Element {
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  return createPortal(
    // `data-modal-open` lets App's global hotkey router stand down while
    // any Modal is up (so Space / digits / Delete can't act behind it).
    <div
      data-modal-open="true"
      className="fixed inset-0 z-[100] bg-black/60 flex items-center justify-center"
      onMouseDown={onClose}
    >
      <div
        className="bg-panel border border-border rounded shadow-2xl min-w-[320px] max-w-[460px]"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="px-4 py-2 border-b border-border flex items-center justify-between">
          <span className="font-semibold text-[13px]">{title}</span>
          <button
            className="text-muted hover:text-text text-[14px] leading-none"
            onClick={onClose}
            aria-label="Close"
          >
            ✕
          </button>
        </div>
        <div className="p-4">{children}</div>
      </div>
    </div>,
    document.body
  )
}
