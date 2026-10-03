import { useCallback, useEffect, useId, useRef, type ReactNode } from 'react'
import { createPortal } from 'react-dom'

/**
 * Modal — FLOWS §6.7, `R-A11Y-004`.
 *
 * The animation is the least interesting thing here. What makes a modal
 * correct is the focus contract, and it has four parts, each of which is a
 * real bug when missing:
 *
 * 1. Focus MOVES IN on open. Without it a keyboard user's caret is still
 *    behind the backdrop, tabbing through a page they cannot see.
 * 2. Focus is TRAPPED. Tab from the last control wraps to the first.
 * 3. Focus RETURNS to the trigger on close. Otherwise it falls to the top of
 *    the document and the user has to navigate all the way back.
 * 4. Escape closes, and the backdrop click closes — but a click that STARTED
 *    inside the panel and ended on the backdrop does not. Dragging to select
 *    text and releasing outside is not a request to discard the dialog.
 *
 * MOTION: centred, not origin-aware. Popovers scale from their trigger because
 * they are anchored to one; a modal is not, and `emil-design-eng` names it as
 * the explicit exemption. 200 ms, opacity + `translateY(8px)`, `--ease-out`.
 *
 * Rendered through a portal so no ancestor's `overflow` or `transform` can
 * clip it or break `position: fixed`.
 *
 * STACKING: a confirmation may open over another modal (Reset link over the
 * share modal, FLOWS §10.2). Only the TOPMOST open modal answers Escape and
 * traps Tab; without that, one Escape would close both, and Tab would be
 * fought over by two traps.
 */

/** Open modals, oldest first. Only the last one handles keys. */
const openStack: symbol[] = []
/** The body's overflow before the first modal opened. */
let previousOverflow = ''

/** True while any modal is open — the canvas shortcuts stand down (P14-1). */
export const isModalOpen = (): boolean => openStack.length > 0

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

export interface ModalProps {
  open: boolean
  onClose: () => void
  title: string
  children: ReactNode
  /** Buttons. Rendered right-aligned; the primary action goes last. */
  footer?: ReactNode
  testId?: string
  /** A wider panel — the share modal's three sections need the room. */
  wide?: boolean
  /**
   * FLOWS §13.2: a destructive modal does not close on a backdrop click — a
   * stray click must not be what decides whether a board is deleted.
   */
  destructive?: boolean
  /**
   * False while a destructive action is in flight: Escape and the backdrop
   * do nothing until it settles (FLOWS §13.2).
   */
  dismissible?: boolean
}

export function Modal({
  open,
  onClose,
  title,
  children,
  footer,
  testId,
  wide = false,
  destructive = false,
  dismissible = true,
}: ModalProps) {
  const panel = useRef<HTMLDivElement | null>(null)
  const returnFocusTo = useRef<HTMLElement | null>(null)
  const pointerDownInside = useRef(false)
  const titleId = useId()
  // Read by the key handler without re-binding it on every busy change.
  const dismissibleRef = useRef(dismissible)
  dismissibleRef.current = dismissible

  const focusFirst = useCallback(() => {
    const node = panel.current
    if (!node) return
    // FLOWS §13.2: the first interactive element — or, for a confirmation,
    // the primary action, which marks itself `data-autofocus`.
    const target =
      node.querySelector<HTMLElement>('[data-autofocus]:not([disabled])') ??
      node.querySelector<HTMLElement>(FOCUSABLE)
    // The panel itself is focusable as a fallback, so a dialog with no
    // controls still receives focus rather than leaving it outside.
    ;(target ?? node).focus()
  }, [])

  useEffect(() => {
    if (!open) return

    returnFocusTo.current = document.activeElement as HTMLElement | null
    focusFirst()
    const self = Symbol('modal')
    openStack.push(self)
    // FLOWS §13.2: the page behind does not scroll. Restored when the LAST
    // open modal closes, so a stacked confirmation does not unlock it early.
    if (openStack.length === 1) {
      previousOverflow = document.body.style.overflow
      document.body.style.overflow = 'hidden'
    }

    const onKeyDown = (event: KeyboardEvent) => {
      if (openStack[openStack.length - 1] !== self) return
      if (event.key === 'Escape') {
        event.stopPropagation()
        if (dismissibleRef.current) onClose()
        return
      }
      if (event.key !== 'Tab') return

      const node = panel.current
      if (!node) return
      const items = [...node.querySelectorAll<HTMLElement>(FOCUSABLE)]
      if (items.length === 0) return

      const first = items[0]!
      const last = items[items.length - 1]!
      const active = document.activeElement

      // Wrapping in both directions. Shift+Tab off the first control is the
      // half people forget, and it drops the user behind the backdrop.
      if (event.shiftKey && (active === first || !node.contains(active))) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && active === last) {
        event.preventDefault()
        first.focus()
      }
    }

    document.addEventListener('keydown', onKeyDown, true)
    return () => {
      document.removeEventListener('keydown', onKeyDown, true)
      openStack.splice(openStack.indexOf(self), 1)
      if (openStack.length === 0) document.body.style.overflow = previousOverflow
      returnFocusTo.current?.focus?.()
    }
  }, [open, onClose, focusFirst])

  if (!open) return null

  return createPortal(
    <div
      data-modal-backdrop
      className="fixed inset-0 z-50 flex items-center justify-center bg-primary/40 p-4"
      onPointerDown={event => {
        pointerDownInside.current = panel.current?.contains(event.target as Node) ?? false
      }}
      onClick={() => {
        // Only a click that both started and ended on the backdrop closes —
        // and never on a destructive modal, or while one is busy.
        if (!pointerDownInside.current && !destructive && dismissibleRef.current)
          onClose()
        pointerDownInside.current = false
      }}
    >
      <div
        ref={panel}
        data-modal-panel
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        data-testid={testId}
        className={`w-full ${wide ? 'max-w-lg' : 'max-w-md'} rounded-lg border border-border bg-app p-6 shadow-panel outline-none`}
        onClick={event => event.stopPropagation()}
      >
        <h2 id={titleId} className="text-base font-semibold text-primary">
          {title}
        </h2>
        <div className="mt-3 text-sm text-muted">{children}</div>
        {footer ? <div className="mt-6 flex justify-end gap-2">{footer}</div> : null}
      </div>
    </div>,
    document.body,
  )
}
