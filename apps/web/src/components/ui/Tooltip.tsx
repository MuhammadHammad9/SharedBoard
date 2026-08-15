import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from 'react'

/**
 * Tooltip — board chrome. Zone skills: ui-ux-pro-max + emil-design-eng.
 *
 * Three decisions, all from the emil-design-eng framework, all specifically
 * about a vertical toolbar the user sweeps a pointer down constantly:
 *
 * 1. DELAY FIRST, THEN INSTANT. A tooltip that appears the moment the pointer
 *    grazes a button turns a sweep down eleven tools into eleven flashes. So
 *    the first one waits. But once one is open the user has declared intent,
 *    and every adjacent trigger opens with no delay AND no animation — a
 *    transition replayed per button as the pointer travels is the same noise
 *    in a different costume. The grace window survives a short gap so moving
 *    between neighbours stays instant.
 *
 * 2. ORIGIN-AWARE, NOT CENTRED. These sit to the right of their trigger, so
 *    they scale from `left center`. A tooltip growing out of its own middle
 *    reads as unanchored. (Modals are the documented exception to this and
 *    stay centred; a tooltip is not a modal.)
 *
 * 3. TRANSITIONS, NOT KEYFRAMES. A fast sweep retargets a transition
 *    mid-flight; a keyframe restarts from zero and stutters.
 *
 * Enter 125 ms, exit 100 ms — R-MOTION-020 puts tooltips at 125–200 ms, and
 * exit is faster than enter because by then the user has stopped caring.
 * `ease-out` throughout; never `ease-in` (R-MOTION-010).
 *
 * R-MOTION-061: hover is gated behind a fine pointer. On touch, tapping a
 * button would otherwise fire hover and leave a tooltip stranded on screen.
 * Keyboard focus always shows it — that is the only way a keyboard user
 * discovers a shortcut (R-A11Y-002 gives the name; this gives the key).
 */

const OPEN_DELAY_MS = 400
/** How long after a close the next tooltip still counts as "adjacent". */
const GRACE_MS = 300

/**
 * Shared across every tooltip instance, deliberately module-level: "has one
 * been open recently" is a property of the toolbar as a whole, not of any one
 * button, and threading it through context would make eleven buttons re-render
 * whenever the twelfth opened.
 */
let groupActive = false
let graceTimer: ReturnType<typeof setTimeout> | undefined

export interface TooltipProps {
  /** The tooltip body. Keep it to a name; pass the key via `shortcut`. */
  label: string
  /** Optional shortcut key, rendered as a dim suffix. */
  shortcut?: string
  /** Exactly one focusable child — the trigger. */
  children: ReactNode
  /** Disable without unmounting, e.g. for a tool that has no tooltip yet. */
  disabled?: boolean
}

export function Tooltip({ label, shortcut, children, disabled = false }: TooltipProps) {
  const [open, setOpen] = useState(false)
  const [instant, setInstant] = useState(false)
  const openTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const id = useId()

  const clearOpenTimer = () => {
    if (openTimer.current !== undefined) {
      clearTimeout(openTimer.current)
      openTimer.current = undefined
    }
  }

  const show = useCallback(
    (immediate: boolean) => {
      if (disabled) return
      clearOpenTimer()
      if (immediate || groupActive) {
        setInstant(true)
        setOpen(true)
        groupActive = true
        return
      }
      openTimer.current = setTimeout(() => {
        setInstant(false)
        setOpen(true)
        groupActive = true
      }, OPEN_DELAY_MS)
    },
    [disabled],
  )

  const hide = useCallback(() => {
    clearOpenTimer()
    setOpen(false)
    // Keep the group "warm" briefly so the next neighbour opens instantly.
    if (graceTimer) clearTimeout(graceTimer)
    graceTimer = setTimeout(() => {
      groupActive = false
    }, GRACE_MS)
  }, [])

  // R-STATE-007: a pending timer outliving its component is a leak, and a
  // setState on an unmounted node.
  useEffect(() => clearOpenTimer, [])

  // Escape dismisses without moving the pointer — R-A11Y-009 keeps Escape live
  // even where other shortcuts are suppressed.
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') hide()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, hide])

  return (
    <span
      className="relative inline-flex"
      onPointerEnter={e => {
        // R-MOTION-061: fine pointers only. A tap on touch reports as hover.
        if (e.pointerType === 'mouse') show(false)
      }}
      onPointerLeave={hide}
      onPointerDown={hide}
      onFocus={() => show(true)}
      onBlur={hide}
    >
      <span aria-describedby={open ? id : undefined} className="inline-flex">
        {children}
      </span>

      {open && (
        <span
          id={id}
          role="tooltip"
          // The transition and its @starting-style live in index.css: an entry
          // animation on a freshly mounted node needs a start state, and
          // @starting-style is the one mechanism that gives a TRANSITION one.
          // A keyframe would work too and would stutter on every re-trigger.
          data-tooltip=""
          data-instant={instant ? 'true' : undefined}
          data-testid="tooltip"
          className={
            'pointer-events-none absolute left-full top-1/2 z-tooltip ml-2 ' +
            'whitespace-nowrap rounded-sm bg-primary px-2 py-1 text-xs text-white shadow-panel'
          }
        >
          {label}
          {shortcut && <kbd className="ml-2 font-sans text-white/60">{shortcut}</kbd>}
        </span>
      )}
    </span>
  )
}
