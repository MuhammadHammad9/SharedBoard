import { useState } from 'react'
import { Button } from '../components/ui/Button.js'
import { EmptyState } from '../components/ui/EmptyState.js'
import { Modal } from '../components/ui/Modal.js'
import { Skeleton } from '../components/ui/Skeleton.js'
import { useToast } from '../components/ui/Toast.js'
import {
  DashboardHeader,
  DashboardSidebar,
} from '../components/dashboard/DashboardChrome.js'
import {
  usePermanentlyDelete,
  useRestoreBoard,
  useTrash,
} from '../features/boards/useBoards.js'
import { absoluteTime, relativeTime } from '../lib/relativeTime.js'
import {
  actions,
  boards as boardStrings,
  dashboard,
  emptyStates,
} from '../lib/strings.js'
import type { BoardSummary } from '../features/boards/api.js'
import { EmptyBoardGraphic } from '../features/boards/EmptyBoardGraphic.js'
import { serverErrorMessage } from '../lib/errorCopy.js'

const RESTORE_FADE_MS = 200

/**
 * S-08 Trash — FR-BOARD-006, FLOWS §6.
 *
 * A list rather than a grid, and deliberately: what you scan Trash for is
 * "which one did I delete and how long have I got", and that is a row of text,
 * not a thumbnail. The days-remaining figure is the whole reason the screen
 * exists — a Trash that does not say when things vanish is just a second
 * inbox.
 *
 * Permanent delete is the one irreversible action in the product, so it is
 * gated behind typing the board's exact name. The confirm button stays
 * DISABLED until the text matches, which makes the requirement visible rather
 * than only enforced: the user can see why nothing is happening.
 */
export default function Trash() {
  const query = useTrash()
  const restore = useRestoreBoard()
  const destroy = usePermanentlyDelete()
  const toast = useToast()

  const [target, setTarget] = useState<BoardSummary | null>(null)
  // Rows fading out after Restore — Phase 13 motion: 200 ms, --ease-out.
  const [leaving, setLeaving] = useState<ReadonlySet<string>>(new Set())

  const onRestore = (id: string) => {
    setLeaving(s => new Set(s).add(id))
    // The fade runs first; the list refetch then removes the row for real.
    window.setTimeout(() => {
      restore.mutate(id, {
        onSuccess: () => toast.show({ message: boardStrings.restored }),
        onError: error => {
          // Back into view: it is still in Trash.
          setLeaving(s => {
            const next = new Set(s)
            next.delete(id)
            return next
          })
          toast.show({ message: serverErrorMessage(error), variant: 'danger' })
        },
      })
    }, RESTORE_FADE_MS)
  }
  const [confirmName, setConfirmName] = useState('')

  const closeModal = () => {
    setTarget(null)
    setConfirmName('')
  }

  const matches = target !== null && confirmName.trim() === target.name

  return (
    <div className="min-h-[100dvh] bg-subtle">
      {/* Search and create are meaningless here, so they are inert rather
          than absent — removing the header entirely would make Trash feel
          like a different application. */}
      <DashboardHeader
        search=""
        onSearch={() => {}}
        onCreate={() => {}}
        creating={false}
      />

      <div className="mx-auto flex w-full max-w-7xl gap-8 px-4 py-6">
        <DashboardSidebar />

        <main className="min-w-0 flex-1">
          <h1 className="mb-1 text-lg font-semibold text-primary">
            {dashboard.trashTitle}
          </h1>
          <p className="mb-6 text-sm text-muted">{emptyStates.trashEmpty.body}</p>

          {query.isPending ? (
            <div className="flex flex-col gap-2" aria-busy="true">
              {Array.from({ length: 3 }, (_, i) => (
                <Skeleton key={i} className="h-16 w-full" />
              ))}
            </div>
          ) : null}

          {query.isError ? (
            <div
              role="alert"
              data-testid="trash-error"
              className="flex flex-col items-center gap-3 rounded-lg border border-danger/30 bg-app px-6 py-12 text-center"
            >
              <p className="text-sm text-primary">{serverErrorMessage(query.error)}</p>
              <Button variant="secondary" onClick={() => void query.refetch()}>
                {actions.retry}
              </Button>
            </div>
          ) : null}

          {query.isSuccess && query.data.boards.length === 0 ? (
            <EmptyState
              testId="trash-empty"
              headline={emptyStates.trashEmpty.headline}
              body={emptyStates.trashEmpty.body}
            />
          ) : null}

          {query.data?.boards.length ? (
            <ul className="flex flex-col gap-2" data-testid="trash-list">
              {query.data.boards.map(board => (
                <li
                  key={board.id}
                  data-testid="trash-row"
                  data-trash-row
                  data-leaving={leaving.has(board.id) ? 'true' : 'false'}
                  className="flex items-center gap-4 rounded-lg border border-border bg-app px-4 py-3"
                >
                  {/* Phase 13 UI: the row carries the board's thumbnail. */}
                  <div className="flex h-12 w-20 shrink-0 items-center justify-center overflow-hidden rounded-sm bg-subtle">
                    {board.thumbnailUrl ? (
                      <img
                        src={board.thumbnailUrl}
                        alt=""
                        loading="lazy"
                        className="h-full w-full object-cover"
                      />
                    ) : (
                      <EmptyBoardGraphic />
                    )}
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium text-primary">
                      {board.name}
                    </p>
                    <p className="text-xs text-muted">
                      <time
                        dateTime={board.deletedAt ?? undefined}
                        title={
                          board.deletedAt ? absoluteTime(board.deletedAt) : undefined
                        }
                      >
                        {boardStrings.deletedAgo(
                          board.deletedAt ? relativeTime(board.deletedAt) : '',
                        )}
                      </time>
                      {' · '}
                      <span data-testid="days-remaining">
                        {boardStrings.daysLeft(board.daysUntilPurge ?? 0)}
                      </span>
                    </p>
                  </div>

                  <Button
                    variant="secondary"
                    data-testid="restore"
                    onClick={() => onRestore(board.id)}
                  >
                    {actions.restore}
                  </Button>
                  <Button
                    variant="danger"
                    data-testid="delete-forever"
                    onClick={() => setTarget(board)}
                  >
                    {actions.deleteForever}
                  </Button>
                </li>
              ))}
            </ul>
          ) : null}
        </main>
      </div>

      <Modal
        open={target !== null}
        onClose={closeModal}
        title={boardStrings.deleteForeverTitle(target?.name ?? '')}
        testId="permanent-delete-modal"
        // FLOWS §13.2: no backdrop dismissal on a destructive modal, and no
        // dismissal at all while the delete is in flight.
        destructive
        dismissible={!destroy.isPending}
        footer={
          <>
            <Button variant="secondary" onClick={closeModal}>
              {actions.cancel}
            </Button>
            <Button
              variant="danger"
              disabled={!matches}
              loading={destroy.isPending}
              data-testid="confirm-delete"
              onClick={() => {
                if (!target) return
                destroy.mutate(
                  { id: target.id, confirmName },
                  {
                    onSuccess: closeModal,
                    onError: error =>
                      toast.show({
                        message: serverErrorMessage(error),
                        variant: 'danger',
                      }),
                  },
                )
              }}
            >
              {actions.deleteForever}
            </Button>
          </>
        }
      >
        <p>{boardStrings.deleteForeverBody}</p>
        <label className="mt-4 block text-sm text-primary">
          {boardStrings.deleteForeverPrompt}:{' '}
          <span className="font-medium">{target?.name}</span>
          <input
            value={confirmName}
            onChange={event => setConfirmName(event.target.value)}
            data-testid="confirm-name"
            autoComplete="off"
            className="mt-1 w-full rounded-md border border-border bg-app px-3 py-2 text-sm text-primary outline-none transition-colors duration-fast focus-visible:border-danger"
          />
        </label>
      </Modal>
    </div>
  )
}
