import { useState } from 'react'
import { X } from '@phosphor-icons/react'
import { actions, guest } from '../../lib/strings.js'
import { Button } from '../ui/Button.js'
import { useBreakpoint } from '../../lib/breakpoints.js'

/**
 * "You're a guest. Sign up to save your boards." — FLOWS §7.4.
 *
 * Persistent but non-intrusive: a bar along the bottom, never a modal over
 * the canvas the guest came to draw on. Sign up opens S-02 in a NEW TAB so
 * the board session survives; that tab reports back (useGuestConversion) and
 * this one upgrades in place.
 *
 * Dismissing hides it for this board for 7 days.
 */

const DISMISS_DAYS = 7
const key = (boardId: string) => `coboard.guestBar.${boardId}`

function dismissedRecently(boardId: string): boolean {
  try {
    const at = Number(globalThis.localStorage?.getItem(key(boardId)) ?? 0)
    return Date.now() - at < DISMISS_DAYS * 24 * 60 * 60 * 1000
  } catch {
    return false
  }
}

export function GuestBar({ boardId }: { boardId: string }) {
  const [hidden, setHidden] = useState(() => dismissedRecently(boardId))
  // Above the bottom toolbar on tablet and mobile (PRD §7.7).
  const breakpoint = useBreakpoint()
  if (hidden) return null

  const signUp = () => {
    const next = encodeURIComponent(`/board/${boardId}`)
    // NOT noopener: the new tab must be able to post back to this one.
    window.open(`/signup?from=guest&next=${next}`, '_blank')
  }

  const dismiss = () => {
    try {
      globalThis.localStorage?.setItem(key(boardId), String(Date.now()))
    } catch {
      // E-18: hidden for this visit only.
    }
    setHidden(true)
  }

  return (
    <div
      role="region"
      aria-label={guest.conversionBar}
      className={`pointer-events-auto absolute ${breakpoint === 'desktop' || breakpoint === 'laptop' ? 'bottom-4' : 'bottom-20'} left-1/2 z-guestbar flex -translate-x-1/2 items-center gap-3 rounded-md border border-border bg-app px-4 py-2 text-sm text-primary shadow-panel`}
      data-testid="guest-bar"
    >
      <span>{guest.conversionBar}</span>
      <Button onClick={signUp} data-testid="guest-signup">
        {actions.signUp}
      </Button>
      <button
        type="button"
        onClick={dismiss}
        aria-label={actions.dismiss}
        className="cursor-pointer rounded-sm p-1 text-muted outline-none hover:text-primary focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
        data-testid="guest-bar-dismiss"
      >
        <X size={14} weight="bold" aria-hidden="true" />
      </button>
    </div>
  )
}
