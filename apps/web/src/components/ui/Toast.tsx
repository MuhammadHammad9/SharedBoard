import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import { createPortal } from 'react-dom'
import { actions, toastStrings } from '../../lib/strings.js'

/**
 * Toast — FLOWS §6.7, §12.
 *
 * The interesting requirement is the **8-second Undo** after moving a board to
 * trash. That number is not decoration: it is how long the user has to notice
 * they hit the wrong card. So three things follow from it.
 *
 * 1. **The timer pauses on hover and on focus.** A toast that expires while
 *    the user is moving the pointer toward Undo has failed at its one job.
 * 2. **`role="status"`, not `role="alert"`.** Alert interrupts a screen reader
 *    mid-sentence; a confirmation is not an interruption. The Undo button is
 *    reachable by Tab, which is what makes the affordance real rather than
 *    mouse-only.
 * 3. **Dismissing is not undoing.** Closing the toast leaves the action done.
 *    Only Undo reverses it.
 *
 * MOTION: enters from below, 200 ms; leaves in 150 ms. Asymmetric on purpose
 * (`R-MOTION-036`) — slow where the user is deciding, fast where the system is
 * responding. Exit is driven by a `data-leaving` attribute and a matching
 * timeout rather than `AnimatePresence`, so the toast host stays free of any
 * animation library and can be imported from anywhere, including the board.
 */

const ENTER_MS = 200
const EXIT_MS = 150
/** FLOWS §13.1: info and success, 3 s. */
export const TOAST_DEFAULT_MS = 3_000
/** FLOWS §13.1: an error, 6 s. */
export const TOAST_ERROR_MS = 6_000
/** FLOWS §13.1: an error with an action, 8 s. */
export const TOAST_ERROR_ACTION_MS = 8_000
/** FLOWS §6.7: the trash toast specifically gets eight seconds. */
export const TOAST_UNDO_MS = 8_000

/** How long a toast stays when the caller does not say — FLOWS §13.1. */
export function durationFor(
  toast: Pick<ToastOptions, 'durationMs' | 'variant' | 'action'>,
): number {
  if (toast.durationMs !== undefined) return toast.durationMs
  if (toast.variant === 'danger')
    return toast.action ? TOAST_ERROR_ACTION_MS : TOAST_ERROR_MS
  return TOAST_DEFAULT_MS
}

/**
 * Where toasts sit — FLOWS §13.1: bottom-LEFT on the board, so a toast never
 * covers the properties panel on the right; bottom-centre everywhere else.
 * The board route claims the left while it is mounted.
 */
type Placement = 'centre' | 'board'
const placement = { current: 'centre' as Placement, listeners: new Set<() => void>() }

export function useBoardToastPlacement(): void {
  useEffect(() => {
    placement.current = 'board'
    placement.listeners.forEach(l => l())
    return () => {
      placement.current = 'centre'
      placement.listeners.forEach(l => l())
    }
  }, [])
}

function usePlacement(): Placement {
  const [value, setValue] = useState(placement.current)
  useEffect(() => {
    const update = () => setValue(placement.current)
    placement.listeners.add(update)
    update()
    return () => {
      placement.listeners.delete(update)
    }
  }, [])
  return value
}

/** R-UI-055 — beyond this the oldest collapse into a "+N more" row. */
const MAX_VISIBLE = 3

export interface ToastAction {
  label: string
  onAction: () => void
}

export interface ToastOptions {
  message: string
  action?: ToastAction
  durationMs?: number
  variant?: 'default' | 'danger'
}

interface ToastRecord extends ToastOptions {
  id: number
  leaving: boolean
}

interface ToastApi {
  show: (options: ToastOptions) => number
  dismiss: (id: number) => void
}

const ToastContext = createContext<ToastApi | null>(null)

/**
 * Read the toast API.
 *
 * Returns a no-op outside a provider rather than throwing. The board route and
 * the dashboard both raise toasts, and a component rendered in a test without
 * the provider should not explode over a notification — the alternative is
 * wrapping every test tree in a provider it does not care about.
 */
export function useToast(): ToastApi {
  const context = useContext(ToastContext)
  return context ?? NOOP_TOASTS
}

const NOOP_TOASTS: ToastApi = { show: () => -1, dismiss: () => {} }

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastRecord[]>([])
  const nextId = useRef(1)

  const remove = useCallback((id: number) => {
    setToasts(list => list.filter(toast => toast.id !== id))
  }, [])

  const dismiss = useCallback(
    (id: number) => {
      // Mark leaving first so the exit transition runs, then unmount.
      setToasts(list =>
        list.map(toast => (toast.id === id ? { ...toast, leaving: true } : toast)),
      )
      setTimeout(() => remove(id), EXIT_MS)
    },
    [remove],
  )

  const show = useCallback((options: ToastOptions) => {
    const id = nextId.current++
    setToasts(list => [...list, { ...options, id, leaving: false }])
    return id
  }, [])

  const api = useMemo(() => ({ show, dismiss }), [show, dismiss])
  const where = usePlacement()

  // Newest three are shown; anything older is counted.
  const visible = toasts.slice(-MAX_VISIBLE)
  const collapsed = toasts.length - visible.length

  return (
    <ToastContext.Provider value={api}>
      {children}
      {createPortal(
        <div
          // Bottom-centre, above everything. Not a live region on the
          // container: each toast announces itself, and a live region wrapping
          // a list re-announces the whole list when one item leaves.
          className={`pointer-events-none fixed z-50 flex flex-col gap-2 ${
            // On the board: above the undo controls and any bottom toolbar.
            where === 'board' ? 'bottom-20 left-6 items-start' : 'bottom-6 inset-x-0 items-center'
          }`}
          data-testid="toast-host"
          data-placement={where}
        >
          {/*
           * R-UI-055: at most three at once, and the oldest collapse into a
           * count. A join/leave storm — five people arriving as a meeting
           * starts — would otherwise stack five notifications up the screen
           * and cover the properties panel.
           */}
          {collapsed > 0 ? (
            <div
              data-testid="toast-collapsed"
              className="pointer-events-none rounded-md border border-border bg-app px-3 py-1 text-xs text-muted shadow-panel"
            >
              {toastStrings.more(collapsed)}
            </div>
          ) : null}
          {visible.map(toast => (
            <ToastItem key={toast.id} toast={toast} onDismiss={dismiss} />
          ))}
        </div>,
        document.body,
      )}
    </ToastContext.Provider>
  )
}

function ToastItem({
  toast,
  onDismiss,
}: {
  toast: ToastRecord
  onDismiss: (id: number) => void
}) {
  const paused = useRef(false)
  const remaining = useRef(durationFor(toast))
  const startedAt = useRef(Date.now())

  useEffect(() => {
    if (toast.leaving) return
    let timer: ReturnType<typeof setTimeout>

    const run = () => {
      startedAt.current = Date.now()
      timer = setTimeout(() => onDismiss(toast.id), remaining.current)
    }
    run()

    /*
     * Pause on hover and focus. The timer is not restarted on leave — the
     * remaining time is what resumes, so hovering for six seconds of an
     * eight-second toast still leaves two, not another eight.
     */
    const node = document.getElementById(`toast-${toast.id}`)
    const pause = () => {
      if (paused.current) return
      paused.current = true
      clearTimeout(timer)
      remaining.current = Math.max(
        0,
        remaining.current - (Date.now() - startedAt.current),
      )
    }
    const resume = () => {
      if (!paused.current) return
      paused.current = false
      run()
    }

    node?.addEventListener('pointerenter', pause)
    node?.addEventListener('pointerleave', resume)
    node?.addEventListener('focusin', pause)
    node?.addEventListener('focusout', resume)

    return () => {
      clearTimeout(timer)
      node?.removeEventListener('pointerenter', pause)
      node?.removeEventListener('pointerleave', resume)
      node?.removeEventListener('focusin', pause)
      node?.removeEventListener('focusout', resume)
    }
  }, [toast.id, toast.leaving, onDismiss])

  return (
    <div
      id={`toast-${toast.id}`}
      data-toast
      data-leaving={toast.leaving}
      data-testid="toast"
      // FLOWS §13.1: errors interrupt (assertive); everything else waits
      // its turn (polite).
      role={toast.variant === 'danger' ? 'alert' : 'status'}
      aria-live={toast.variant === 'danger' ? 'assertive' : 'polite'}
      style={{ transitionDuration: `${ENTER_MS}ms` }}
      className={`pointer-events-auto flex items-center gap-4 rounded-md border px-4 py-3 text-sm shadow-panel ${
        toast.variant === 'danger'
          ? 'border-danger/30 bg-app text-danger'
          : 'border-border bg-app text-primary'
      }`}
    >
      <span>{toast.message}</span>
      {toast.action ? (
        <button
          type="button"
          data-testid="toast-action"
          onClick={() => {
            toast.action?.onAction()
            onDismiss(toast.id)
          }}
          className="cursor-pointer rounded-sm font-medium text-accent underline-offset-2 outline-none transition-colors duration-fast hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
        >
          {toast.action.label}
        </button>
      ) : null}
      <button
        type="button"
        aria-label={actions.dismiss}
        data-testid="toast-dismiss"
        onClick={() => onDismiss(toast.id)}
        className="cursor-pointer rounded-sm px-1 text-muted outline-none transition-colors duration-fast hover:text-primary focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
      >
        ×
      </button>
    </div>
  )
}
