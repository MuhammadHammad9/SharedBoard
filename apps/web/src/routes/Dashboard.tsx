import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router'
import { Button } from '../components/ui/Button.js'
import { EmptyState } from '../components/ui/EmptyState.js'
import { useToast, TOAST_UNDO_MS } from '../components/ui/Toast.js'
import {
  DashboardHeader,
  DashboardSidebar,
  FilterTabs,
  SortMenu,
} from '../components/dashboard/DashboardChrome.js'
import { BoardCard } from '../features/boards/BoardCard.js'
import { BoardGrid, BoardGridSkeleton } from '../features/boards/BoardGrid.js'
import {
  useBoardList,
  useCreateBoard,
  useDuplicateBoard,
  useRenameBoard,
  useRestoreBoard,
  useTrashBoard,
  type BoardFilter,
  type BoardSort,
} from '../features/boards/useBoards.js'
import { useAuthStore } from '../stores/authStore.js'
import { actions, boards as boardStrings, emptyStates, errors } from '../lib/strings.js'

/**
 * S-07 Dashboard — FLOWS §6.
 *
 * ┌──────────────────────────────────────────────────────────────────────────┐
 * │  ALL SEVEN STATES ARE REQUIRED — R-UI-050, FLOWS §6.3.                   │
 * │                                                                          │
 * │  loading · loaded · empty-never · empty-filter · empty-search · error ·  │
 * │  partial error                                                           │
 * │                                                                          │
 * │  The three empty states are distinct on purpose. Telling a user with     │
 * │  forty boards that they have "nothing here yet" because their search     │
 * │  missed is the version of this that ships when they are collapsed into   │
 * │  one.                                                                    │
 * └──────────────────────────────────────────────────────────────────────────┘
 *
 * Filter, sort and search live in the URL, not in component state. That is
 * what makes the dashboard linkable and back-button-correct — and it is also
 * what `?next=/dashboard?sort=recent&filter=mine` in the auth guard was
 * preserving all along.
 *
 * Zone: product chrome. `ui-ux-pro-max` + `emil-design-eng`, dials 5/3/5.
 * Framer Motion is permitted and lazy (see BoardGrid); `gpt-taste` and
 * `high-end-visual-design` are forbidden — this is a file browser, not a
 * landing page.
 */

/** Long enough to stop typing, short enough not to feel laggy. */
const SEARCH_DEBOUNCE_MS = 250

export default function Dashboard() {
  const [params, setParams] = useSearchParams()
  const navigate = useNavigate()
  const toast = useToast()
  const userId = useAuthStore(s => s.user?.id)

  const filter = (params.get('filter') ?? 'all') as BoardFilter
  const sort = (params.get('sort') ?? 'lastEdited') as BoardSort
  const urlQuery = params.get('q') ?? ''

  // Two pieces of search state: what is typed, and what has been committed to
  // the URL. Without the split, every keystroke would push a history entry.
  const [typed, setTyped] = useState(urlQuery)
  useEffect(() => setTyped(urlQuery), [urlQuery])

  useEffect(() => {
    if (typed === urlQuery) return
    const timer = setTimeout(() => {
      const next = new URLSearchParams(params)
      if (typed) next.set('q', typed)
      else next.delete('q')
      setParams(next, { replace: true })
    }, SEARCH_DEBOUNCE_MS)
    return () => clearTimeout(timer)
  }, [typed, urlQuery, params, setParams])

  const setParam = (key: string, value: string | null) => {
    const next = new URLSearchParams(params)
    if (value === null || value === '') next.delete(key)
    else next.set(key, value)
    setParams(next)
  }

  const listParams = useMemo(
    () => ({ filter, sort, q: urlQuery }),
    [filter, sort, urlQuery],
  )
  const query = useBoardList(listParams)

  const create = useCreateBoard()
  const rename = useRenameBoard()
  const trash = useTrashBoard()
  const restore = useRestoreBoard()
  const duplicate = useDuplicateBoard()

  /*
   * E-16: one board per double-click.
   *
   * The latch is released on FAILURE only, never on success — and that is the
   * whole fix. `create.isPending` disables the button during the request, but
   * a fast server resolves in under the ~80 ms between the two clicks of a
   * real double-click, so the second lands after `isPending` has already gone
   * false and creates a second board. Clearing on `onSettled` has exactly the
   * same hole; the test caught it doing precisely that.
   *
   * Success means we are navigating away, so there is no state to restore.
   * Failure means the user is still here and must be able to try again.
   */
  const creatingRef = useRef(false)

  const onCreate = () => {
    if (creatingRef.current) return
    creatingRef.current = true
    create.mutate(undefined, {
      // No optimistic navigation: routing to a board that then fails to be
      // created strands the user on a 404 they cannot explain (FLOWS §6.5).
      onSuccess: ({ board }) => navigate(`/board/${board.id}?new=1`),
      onError: () => {
        creatingRef.current = false
        toast.show({ message: boardStrings.createFailed, variant: 'danger' })
      },
    })
  }

  const onTrash = (id: string) => {
    trash.mutate(id, {
      onSuccess: () =>
        toast.show({
          message: boardStrings.movedToTrash,
          durationMs: TOAST_UNDO_MS,
          action: {
            label: actions.undo,
            onAction: () =>
              restore.mutate(id, {
                onSuccess: () => toast.show({ message: boardStrings.restored }),
              }),
          },
        }),
      onError: () =>
        toast.show({ message: errors.genericServerError, variant: 'danger' }),
    })
  }

  const pages = query.data?.pages ?? []
  const boards = pages.flatMap(page => page.boards)
  const filtering = filter !== 'all'
  const searching = urlQuery.length > 0

  return (
    <div className="min-h-[100dvh] bg-subtle">
      <DashboardHeader
        search={typed}
        onSearch={setTyped}
        onCreate={onCreate}
        creating={create.isPending}
      />

      <div className="mx-auto flex w-full max-w-7xl gap-8 px-4 py-6">
        <DashboardSidebar />

        <main className="min-w-0 flex-1">
          <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
            <FilterTabs value={filter} onChange={value => setParam('filter', value)} />
            <SortMenu value={sort} onChange={value => setParam('sort', value)} />
          </div>

          {/* 1 — LOADING. Skeletons, never a spinner (R-UI-051). */}
          {query.isPending ? <BoardGridSkeleton /> : null}

          {/* 6 — ERROR. The header and sidebar above are untouched. */}
          {query.isError ? (
            <div
              role="alert"
              data-testid="dashboard-error"
              className="flex flex-col items-center gap-3 rounded-lg border border-danger/30 bg-app px-6 py-16 text-center"
            >
              <p className="text-base font-medium text-primary">
                {errors.genericServerError}
              </p>
              <Button variant="secondary" onClick={() => void query.refetch()}>
                {actions.retry}
              </Button>
            </div>
          ) : null}

          {query.isSuccess && boards.length === 0 ? (
            /* 3, 4, 5 — the three empty states, kept distinct. */
            searching ? (
              <EmptyState
                testId="empty-search"
                headline={emptyStates.searchNoResults.headline(urlQuery)}
                action={
                  <Button variant="secondary" onClick={() => setParam('q', null)}>
                    {emptyStates.searchNoResults.cta}
                  </Button>
                }
              />
            ) : filtering ? (
              <EmptyState
                testId="empty-filter"
                headline={emptyStates.dashboardFilterEmpty.headline}
                action={
                  <Button variant="secondary" onClick={() => setParam('filter', 'all')}>
                    {emptyStates.dashboardFilterEmpty.cta}
                  </Button>
                }
              />
            ) : (
              <EmptyState
                testId="dashboard-empty"
                headline={emptyStates.dashboardNoBoards.headline}
                body={emptyStates.dashboardNoBoards.body}
                action={
                  <Button onClick={onCreate} loading={create.isPending}>
                    {emptyStates.dashboardNoBoards.cta}
                  </Button>
                }
              />
            )
          ) : null}

          {/* 2 — LOADED. 7 — PARTIAL: a card whose thumbnail is missing still
              renders, with the placeholder. One failed image never fails the
              page (FLOWS §6.3). */}
          {boards.length > 0 ? (
            <BoardGrid>
              {boards.map(board => (
                <BoardCard
                  key={board.id}
                  board={board}
                  currentUserId={userId}
                  onRename={name =>
                    rename.mutate(
                      { id: board.id, name },
                      {
                        onError: () =>
                          toast.show({
                            message: boardStrings.renameFailed,
                            variant: 'danger',
                          }),
                      },
                    )
                  }
                  onTrash={() => onTrash(board.id)}
                  onDuplicate={() =>
                    duplicate.mutate(board.id, {
                      onError: () =>
                        toast.show({
                          message: errors.genericServerError,
                          variant: 'danger',
                        }),
                    })
                  }
                />
              ))}
            </BoardGrid>
          ) : null}

          {query.hasNextPage ? (
            <div className="mt-6 flex justify-center">
              <Button
                variant="secondary"
                loading={query.isFetchingNextPage}
                onClick={() => void query.fetchNextPage()}
                data-testid="load-more"
              >
                Load more
              </Button>
            </div>
          ) : null}
        </main>
      </div>
    </div>
  )
}
