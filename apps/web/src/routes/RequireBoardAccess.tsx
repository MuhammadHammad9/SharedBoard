import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'
import { Navigate, useLocation, useNavigate } from 'react-router'
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
import { Spinner } from '../components/ui/Spinner.js'
import { BackToDashboard, FullScreenState } from '../components/ui/FullScreenState.js'
import { loginUrlFor } from './nextParam.js'
import { RequireAuth, useSessionBootstrap } from './guards.js'

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
 * ONE INTERPRETATION, flagged per the ambiguity rule: the FLOWS §2.4 tree
 * sends a fully anonymous visitor with no share link to S-17. Phase 7's exit
 * gate — "deep-link preserved" — sends them to log in with `?next=`, and its
 * e2e tests still hold. A logged-out MEMBER is far likelier than a stranger
 * at that URL, and "You don't have access" would be wrong for them, so the
 * login redirect stays for that one case. Anyone identified still gets S-17.
 */

export interface BoardEntry {
  /** Acting as this guest, or null for a signed-in user. */
  guest: GuestIdentity | null
  /** True when S-11 was skipped for a returning guest — show the chip (§7.2). */
  returning: boolean
  /** The share token this tab arrived with, if any. */
  shareToken: string | null
}

const BoardEntryContext = createContext<BoardEntry>({
  guest: null,
  returning: false,
  shareToken: null,
})

export const useBoardEntry = (): BoardEntry => useContext(BoardEntryContext)

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

type Decision =
  | { kind: 'resolving' }
  | { kind: 'enter'; entry: BoardEntry }
  | { kind: 'login' }
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

    if (status !== 'authenticated' && !guest && !shareToken) {
      setDecision({ kind: 'login' })
      return
    }

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
    case 'login':
      return <Navigate to={loginUrlFor(location.pathname, location.search)} replace />
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
          action={<BackToDashboard label={actions.backToDashboard} />}
          testId="board-forbidden"
        />
      )
    }
    case 'not-found':
      return (
        <FullScreenState
          headline={states.boardNotFound.headline}
          body={states.boardNotFound.body}
          action={<BackToDashboard label={actions.backToDashboard} />}
          testId="board-not-found"
        />
      )
    case 'deleted':
      return (
        <FullScreenState
          headline={states.boardGone.headline}
          body={states.boardGone.body}
          action={<BackToDashboard label={actions.backToDashboard} />}
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

/**
 * STEP 1 — the board's frame while access resolves: header skeleton, a
 * disabled toolbar placeholder, and the canvas area with a centred spinner.
 */
function BoardShell({ children }: { children?: ReactNode }) {
  return (
    <main
      className="relative h-[100dvh] min-h-[100dvh] w-full overflow-hidden bg-canvas"
      data-testid="board-shell"
      aria-busy={children ? undefined : true}
    >
      <div className="absolute inset-x-4 top-4 flex items-center gap-2">
        <div className="h-8 w-48 rounded-md bg-app/90 shadow-panel" />
        <div className="ml-auto h-8 w-24 rounded-md bg-app/90 shadow-panel" />
      </div>
      <div className="absolute left-4 top-1/2 h-64 w-12 -translate-y-1/2 rounded-md bg-app/90 opacity-60 shadow-panel" />
      <div className="grid h-full place-items-center" role="status" aria-live="polite">
        {children ?? <Spinner size={28} className="text-accent" />}
      </div>
    </main>
  )
}
