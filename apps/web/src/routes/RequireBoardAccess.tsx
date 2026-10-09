import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'
import { Link, useLocation, useNavigate, type NavigateFunction } from 'react-router'
import { ApiError, setGuestCredential } from '../lib/api.js'
import { actions, states, strings } from '../lib/strings.js'
import { useAuthStore } from '../stores/authStore.js'
import { getBoardAccess } from '../features/boards/api.js'
import { joinAsGuest } from '../features/sharing/api.js'
import {
  readGuest,
  shareTokenFor,
  type GuestIdentity,
} from '../features/auth/guestIdentity.js'
import { Button } from '../components/ui/Button.js'
import { BoardShell } from '../components/board/BoardShell.js'
import { BackHome, FullScreenState } from '../components/ui/FullScreenState.js'
import { loginUrlFor } from './nextParam.js'
import { RequireAuth, useSessionBootstrap } from './guards.js'
import { logout } from '../features/auth/api.js'

/**
 * `requireBoardAccess` — FLOWS §2.3, "the most important guard in the app".
 *
 *   STEP 1  the board shell renders at once; never a blank page
 *   STEP 2  identity: a user (token or silent refresh), else a guest from
 *           `localStorage.coboard.guest`, else anonymous
 *   STEP 3  GET /boards/:id/access, with the share token from this tab
 *   STEP 4  branch — member · joinable · S-17 · S-18 · inline retry
 *
 * STEP 5 onward is the board route's own `useBoardLoad`.
 *
 * An anonymous visitor — no session, no guest identity, no link — still asks
 * `/access`, so the §2.4 tree holds exactly: a missing board is S-18, a
 * deleted one S-18 (deleted), anything else S-17. S-17 then offers "Log in"
 * with `?next=` back to this board, which is how a logged-out member gets in
 * and how deep links survive login (FLOWS §4).
 */

export interface BoardEntry {
  /** Acting as this guest, or null for a signed-in user. */
  guest: GuestIdentity | null
  /** True when S-11 was skipped for a returning guest — show the chip (§7.2). */
  returning: boolean
  /** The share token this tab arrived with, if any. */
  shareToken: string | null
  /** The board's object count from `/access` — FLOWS §8.1's loading copy. */
  objectCount: number | null
}

const BoardEntryContext = createContext<BoardEntry>({
  guest: null,
  returning: false,
  shareToken: null,
  objectCount: null,
})

export const useBoardEntry = (): BoardEntry => useContext(BoardEntryContext)

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

type Decision =
  | { kind: 'resolving' }
  | { kind: 'enter'; entry: BoardEntry }
  | { kind: 'denied'; reason: 'no_access' | 'link_revoked' }
  | { kind: 'not-found' }
  | { kind: 'deleted' }
  | { kind: 'error' }

export function RequireBoardAccess({
  boardId,
  children,
}: {
  boardId: string
  children: ReactNode
}) {
  // A dev scratch board never talks to the server — see useBoardLoad.
  if (import.meta.env.DEV && !UUID.test(boardId))
    return <RequireAuth>{children}</RequireAuth>
  return <Guard boardId={boardId}>{children}</Guard>
}

function Guard({ boardId, children }: { boardId: string; children: ReactNode }) {
  useSessionBootstrap()
  const status = useAuthStore(s => s.status)
  const location = useLocation()
  const navigate = useNavigate()
  const [decision, setDecision] = useState<Decision>({ kind: 'resolving' })
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    // STEP 2a–b still in flight.
    if (status === 'unknown' || status === 'refreshing') return

    let cancelled = false
    const shareToken = shareTokenFor(boardId)
    const guest = status === 'authenticated' ? null : readGuest()
    // A user's token always wins; otherwise the guest header, if any.
    setGuestCredential(guest?.id ?? null)

    setDecision({ kind: 'resolving' })
    void (async () => {
      try {
        let access = await getBoardAccess(boardId, shareToken)
        let returning = false

        if (access.role === 'none' && access.joinable && shareToken) {
          if (!guest) {
            // §2.3: "redirect to /join/:token (S-11)".
            if (!cancelled) navigate(`/join/${shareToken}`, { replace: true })
            return
          }
          // §7.2: a returning guest with a valid token skips S-11 entirely.
          await joinAsGuest(shareToken, guest.id, guest.name)
          access = await getBoardAccess(boardId, shareToken)
          returning = true
        }
        if (cancelled) return
        if (access.role === 'none') {
          setDecision({ kind: 'denied', reason: 'no_access' })
          return
        }
        const fromCard = Boolean(
          (location.state as { joinedAs?: string } | null)?.joinedAs,
        )
        setDecision({
          kind: 'enter',
          entry: {
            guest,
            returning: returning || (guest !== null && !fromCard),
            shareToken,
            objectCount: access.objectCount ?? null,
          },
        })
      } catch (error) {
        if (cancelled) return
        setDecision(decisionFor(error))
      }
    })()

    return () => {
      cancelled = true
    }
    // `location.state` is read once per resolution, deliberately.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [boardId, status, attempt, navigate])

  switch (decision.kind) {
    case 'resolving':
      return <BoardShell />
    case 'enter':
      return (
        <BoardEntryContext.Provider value={decision.entry}>
          {children}
        </BoardEntryContext.Provider>
      )
    case 'denied': {
      // R-SEC-018: no board name on S-17. The guard never received one.
      const copy =
        decision.reason === 'link_revoked' ? states.accessRemoved : states.accessDenied
      return (
        <FullScreenState
          headline={copy.headline}
          body={copy.body}
          action={<BackHome />}
          footer={
            <AccountLine
              next={loginUrlFor(location.pathname, location.search)}
              navigate={navigate}
            />
          }
          testId="board-forbidden"
        />
      )
    }
    case 'not-found':
      return (
        <FullScreenState
          headline={states.boardNotFound.headline}
          body={states.boardNotFound.body}
          action={<BackHome />}
          testId="board-not-found"
        />
      )
    case 'deleted':
      return (
        <FullScreenState
          headline={states.boardGone.headline}
          body={states.boardGone.body}
          action={<BackHome />}
          testId="board-deleted"
        />
      )
    case 'error':
      // §2.3: an inline retry INSIDE the canvas area. The URL is valid; do
      // not navigate away from it.
      return (
        <BoardShell>
          <div
            className="flex flex-col items-center gap-3"
            data-testid="board-access-error"
          >
            <p className="text-sm text-muted">{strings.validation.networkFailure}</p>
            <Button variant="secondary" onClick={() => setAttempt(n => n + 1)}>
              {actions.retry}
            </Button>
          </div>
        </BoardShell>
      )
  }
}

/**
 * S-17's account line — FLOWS §12.1. Signed in: who, and a way to switch
 * (sign out, then log in and come straight back here). Not signed in: a way
 * to log in that returns here.
 */
function AccountLine({ next, navigate }: { next: string; navigate: NavigateFunction }) {
  const email = useAuthStore(s => s.user?.email)
  if (!email) {
    return (
      <Link
        to={next}
        className="rounded-sm font-medium text-accent outline-none hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
        data-testid="forbidden-log-in"
      >
        {actions.logIn}
      </Link>
    )
  }
  const switchAccount = async () => {
    await logout()
    navigate(next, { replace: true })
  }
  return (
    <span data-testid="forbidden-account">
      {states.accessDenied.signedInAs(email)} —{' '}
      <button
        type="button"
        onClick={() => void switchAccount()}
        className="cursor-pointer rounded-sm font-medium text-accent outline-none hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
      >
        {actions.switchAccount}
      </button>
    </span>
  )
}

function decisionFor(error: unknown): Decision {
  if (!(error instanceof ApiError)) return { kind: 'error' }
  const reason = (error.details as { reason?: string } | undefined)?.reason
  if (error.status === 403) {
    return {
      kind: 'denied',
      reason: reason === 'link_revoked' ? 'link_revoked' : 'no_access',
    }
  }
  if (error.status === 404) return { kind: 'not-found' }
  if (error.status === 410) return { kind: 'deleted' }
  return { kind: 'error' }
}
