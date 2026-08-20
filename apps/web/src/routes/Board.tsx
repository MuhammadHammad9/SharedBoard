import { useParams } from 'react-router'
import { Canvas } from '../features/canvas/Canvas.js'
import { BoardHeader } from '../components/board/BoardHeader.js'
import { SessionExpiredBanner } from '../components/board/SessionExpiredBanner.js'
import { FullScreenSpinner } from '../components/ui/Spinner.js'
import { BackToDashboard, FullScreenState } from '../components/ui/FullScreenState.js'
import { Button } from '../components/ui/Button.js'
import { useBoardLoad } from '../features/boards/useBoardLoad.js'
import { actions, states } from '../lib/strings.js'

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
      />
      <SessionExpiredBanner />
    </main>
  )
}
