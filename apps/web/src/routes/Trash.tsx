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
import { usePermanentlyDelete, useRestoreBoard, useTrash } from '../features/boards/useBoards.js'
import { absoluteTime, relativeTime } from '../lib/relativeTime.js'
import { actions, boards as boardStrings, emptyStates, errors } from '../lib/strings.js'
import type { BoardSummary } from '../features/boards/api.js'

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
      <DashboardHeader search="" onSearch={() => {}} onCreate={() => {}} creating={false} />

      <div className="mx-auto flex w-full max-w-7xl gap-8 px-4 py-6">
        <DashboardSidebar />

        <main className="min-w-0 flex-1">
          <h1 className="mb-1 text-lg font-semibold text-primary">Trash</h1>
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
              <p className="text-sm text-primary">{errors.genericServerError}</p>
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
                  className="flex items-center gap-4 rounded-lg border border-border bg-app px-4 py-3"
                >
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium text-primary">
                      {board.name}
                    </p>
                    <p className="text-xs text-muted">
                      <time
                        dateTime={board.deletedAt ?? undefined}
                        title={board.deletedAt ? absoluteTime(board.deletedAt) : undefined}
                      >
                        Deleted {board.deletedAt ? relativeTime(board.deletedAt) : ''}
                      </time>
                      {' · '}
                      <span data-testid="days-remaining">
                        {board.daysUntilPurge ?? 0} days left
                      </span>
                    </p>
                  </div>

                  <Button
                    variant="secondary"
                    data-testid="restore"
                    onClick={() =>
                      restore.mutate(board.id, {
                        onSuccess: () => toast.show({ message: boardStrings.restored }),
                        onError: () =>
                          toast.show({
                            message: errors.genericServerError,
                            variant: 'danger',
                          }),
                      })
                    }
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
        title={`Delete '${target?.name ?? ''}' forever?`}
        testId="permanent-delete-modal"
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
                    onError: () =>
                      toast.show({
                        message: errors.genericServerError,
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
        <p>
          This cannot be undone. Every stroke, note and shape on this board will be
          removed permanently.
        </p>
        <label className="mt-4 block text-sm text-primary">
          Type <span className="font-medium">{target?.name}</span> to confirm
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
