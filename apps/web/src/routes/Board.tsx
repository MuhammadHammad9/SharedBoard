import { useEffect, useRef, useState } from 'react'
import { X } from '@phosphor-icons/react'
import { useLocation, useNavigate, useParams } from 'react-router'
import { Canvas } from '../features/canvas/Canvas.js'
import { BoardHeader } from '../components/board/BoardHeader.js'
import { SessionExpiredBanner } from '../components/board/SessionExpiredBanner.js'
import { OfflineBanner } from '../components/board/OfflineBanner.js'
import { FullScreenSpinner } from '../components/ui/Spinner.js'
import { BackToDashboard, FullScreenState } from '../components/ui/FullScreenState.js'
import { Button } from '../components/ui/Button.js'
import { useBoardLoad } from '../features/boards/useBoardLoad.js'
import { useJoinLeaveToasts } from '../features/presence/useJoinLeaveToasts.js'
import { actions, guest, states } from '../lib/strings.js'
import { setGuestCredential } from '../lib/api.js'
import { useToast } from '../components/ui/Toast.js'
import { boardStore } from '../stores/boardStore.js'
import { clearGuest } from '../features/auth/guestIdentity.js'
import { useBoardEntry } from './RequireBoardAccess.js'

/**
 * S-10 Board shell.
 *
 * Phase 8a gave the route its content: the board's objects are fetched, the
 * outbox is started, and the four states FLOWS §12 specifies are rendered —
 * loading, ready, not-found and error. Phase 8b adds the header, with its
 * inline rename and the `?new=1` naming hand-off from Create. Presence
 * avatars, share and export are Phase 9 onward.
 *
 * Lazy-loaded from App.tsx (TRD §12.2) so the auth screens never pull in the
 * canvas engine.
 */
export default function Board() {
  const { boardId } = useParams<{ boardId: string }>()
  const load = useBoardLoad(boardId)
  // "Marcus joined" / "Marcus left" — FR-RT-008. Derived from roster diffs,
  // so a second tab from the same person does not announce itself.
  useJoinLeaveToasts()
  const entry = useBoardEntry()
  const location = useLocation()
  const navigate = useNavigate()
  const toast = useToast()

  // Viewer mode — FR-SHARE-006. Follows the role live, so a role:changed to
  // viewer disables the canvas on the spot (FLOWS §9.5).
  useEffect(() => {
    boardStore.getState().setReadOnly(load.role === 'VIEWER')
  }, [load.role])
  useEffect(() => () => boardStore.getState().setReadOnly(false), [])

  // FLOWS §7.1 step 9: "You're in as Marcus" — once, when arriving from S-11.
  const joinedAs = (location.state as { joinedAs?: string } | null)?.joinedAs
  const announced = useRef(false)
  useEffect(() => {
    if (!joinedAs || announced.current || load.status !== 'ready') return
    announced.current = true
    toast.show({ message: guest.joinedAs(joinedAs) })
  }, [joinedAs, load.status, toast])

  if (load.status === 'loading') {
    return <FullScreenSpinner label="Opening board" />
  }

  if (load.status === 'not-found') {
    return (
      <FullScreenState
        headline={states.boardNotFound.headline}
        body={states.boardNotFound.body}
        action={<BackToDashboard label={actions.backToDashboard} />}
        testId="board-not-found"
      />
    )
  }

  if (load.status === 'forbidden') {
    return (
      <FullScreenState
        // R-SEC-018 — no board name reaches this screen, and the hook does not
        // have one to give it.
        headline={states.accessDenied.headline}
        body={states.accessDenied.body}
        action={<BackToDashboard label={actions.backToDashboard} />}
        testId="board-forbidden"
      />
    )
  }

  // FLOWS §9.5 — the board was deleted while open: S-19.
  if (load.status === 'deleted') {
    return (
      <FullScreenState
        headline={states.boardDeleted.headline}
        body={states.boardDeleted.body}
        action={<BackToDashboard label={actions.backToDashboard} />}
        testId="board-deleted-live"
      />
    )
  }

  // FLOWS §9.5 — access removed while open: S-17, "access removed" copy.
  if (load.status === 'revoked') {
    return (
      <FullScreenState
        headline={states.accessRemoved.headline}
        body={states.accessRemoved.body}
        action={<BackToDashboard label={actions.backToDashboard} />}
        testId="board-access-removed"
      />
    )
  }

  if (load.status === 'error') {
    return (
      <FullScreenState
        headline={states.errorBoundary.headline}
        body={states.errorBoundary.body}
        action={
          <Button variant="secondary" onClick={load.retry}>
            {actions.retry}
          </Button>
        }
        testId="board-error"
      />
    )
  }

  return (
    <main
      className="relative h-[100dvh] min-h-[100dvh] w-full overflow-hidden bg-canvas"
      data-board-role={load.role ?? 'OWNER'}
    >
      <Canvas />
      <BoardHeader
        boardId={boardId ?? ''}
        name={load.name}
        role={load.role ?? 'OWNER'}
        connection={load.connection}
        attempt={load.attempt}
        pending={load.pending}
        onRetry={load.retryConnection}
      />
      <OfflineBanner state={load.connection} pending={load.pending} />
      <SessionExpiredBanner />
      {entry.guest && entry.returning && (
        <ReturningGuestChip
          name={entry.guest.name}
          {...(entry.shareToken
            ? {
                onNotYou: () => {
                  // FLOWS §7.2: forget this identity and go back to S-11.
                  clearGuest()
                  setGuestCredential(null)
                  navigate(`/join/${entry.shareToken}`, { replace: true })
                },
              }
            : {})}
        />
      )}
    </main>
  )
}

/**
 * "Joined as Marcus — Not you?" — FLOWS §7.2. Small, in a corner, dismissible:
 * it exists for the one person on a shared computer who is not Marcus.
 */
function ReturningGuestChip({ name, onNotYou }: { name: string; onNotYou?: () => void }) {
  const [open, setOpen] = useState(true)
  if (!open) return null
  return (
    <div
      className="pointer-events-auto absolute bottom-4 right-4 z-panel flex items-center gap-2 rounded-md border border-border bg-app px-3 py-2 text-xs text-primary shadow-panel"
      data-testid="returning-guest-chip"
    >
      <span>{guest.joinedChip(name)}</span>
      {onNotYou && (
        <button
          type="button"
          onClick={onNotYou}
          className="cursor-pointer rounded-sm font-medium text-accent outline-none hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
        >
          {actions.notYou}
        </button>
      )}
      <button
        type="button"
        onClick={() => setOpen(false)}
        aria-label={actions.dismiss}
        className="cursor-pointer rounded-sm px-1 text-muted outline-none hover:text-primary focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
      >
        <X size={12} weight="bold" aria-hidden="true" />
      </button>
    </div>
  )
}
