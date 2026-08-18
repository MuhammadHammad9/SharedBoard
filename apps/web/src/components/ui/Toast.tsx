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
export const TOAST_DEFAULT_MS = 5_000
/** FLOWS §6.7: the trash toast specifically gets eight seconds. */
export const TOAST_UNDO_MS = 8_000

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

  return (
    <ToastContext.Provider value={api}>
      {children}
      {createPortal(
        <div
          // Bottom-centre, above everything. Not a live region on the
          // container: each toast announces itself, and a live region wrapping
          // a list re-announces the whole list when one item leaves.
          className="pointer-events-none fixed inset-x-0 bottom-6 z-50 flex flex-col items-center gap-2"
          data-testid="toast-host"
        >
          {toasts.map(toast => (
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
  const remaining = useRef(toast.durationMs ?? TOAST_DEFAULT_MS)
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
      remaining.current = Math.max(0, remaining.current - (Date.now() - startedAt.current))
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
      role="status"
      aria-live="polite"
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
        aria-label="Dismiss"
        data-testid="toast-dismiss"
        onClick={() => onDismiss(toast.id)}
        className="cursor-pointer rounded-sm px-1 text-muted outline-none transition-colors duration-fast hover:text-primary focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
      >
        ×
      </button>
    </div>
  )
}
