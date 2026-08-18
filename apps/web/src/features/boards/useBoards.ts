import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
  type QueryClient,
} from '@tanstack/react-query'
import {
  createBoard,
  duplicateBoard,
  listBoards,
  listTrash,
  permanentlyDeleteBoard,
  renameBoard,
  restoreBoard,
  trashBoard,
  type BoardSummary,
} from './api.js'

/**
 * Board queries and mutations — FLOWS §6.
 *
 * TanStack Query rather than hand-rolled `useEffect` fetching, and the reason
 * is the dashboard's specific shape: cursor pagination, four filter tabs,
 * three sorts and a debounced search all vary the same query, and every
 * mutation has to invalidate whichever combinations are cached. Written by
 * hand that is a fetch-cancellation bug per control.
 *
 * The query KEY is the whole point. `['boards', filter, sort, q]` means
 * switching tabs shows a cached page instantly and re-fetches in the
 * background, and a stale response from the tab you just left can never
 * overwrite the one you are looking at.
 */

export type BoardFilter = 'all' | 'owned' | 'shared' | 'starred'
export type BoardSort = 'lastEdited' | 'created' | 'name'

export interface BoardListParams {
  filter: BoardFilter
  sort: BoardSort
  q: string
}

interface BoardPage {
  boards: BoardSummary[]
  nextCursor: string | null
}

export const boardsKey = (params: BoardListParams) =>
  ['boards', params.filter, params.sort, params.q] as const

export const trashKey = ['boards', 'trash'] as const

function queryString(params: BoardListParams, cursor?: string): string {
  const search = new URLSearchParams({ filter: params.filter, sort: params.sort })
  if (params.q) search.set('q', params.q)
  if (cursor) search.set('cursor', cursor)
  return `?${search.toString()}`
}

export function useBoardList(params: BoardListParams) {
  return useInfiniteQuery({
    queryKey: boardsKey(params),
    queryFn: ({ pageParam }) =>
      listBoards(queryString(params, pageParam as string | undefined)),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last: BoardPage) => last.nextCursor ?? undefined,
    /*
     * Thirty seconds. Long enough that switching tabs back and forth does not
     * hammer the API, short enough that a board renamed in another tab shows
     * its new name without a hard reload.
     */
    staleTime: 30_000,
  })
}

export function useTrash() {
  return useQuery({
    queryKey: trashKey,
    queryFn: () => listTrash(),
    staleTime: 30_000,
  })
}

/**
 * Invalidate every board list, whatever its filter/sort/search.
 *
 * A prefix match on `['boards']`, not the one key that produced the mutation.
 * A board moved to trash disappears from All, Owned and Shared and appears in
 * Trash; invalidating only the visible list leaves four stale caches waiting
 * to be shown the moment the user clicks a tab.
 */
const invalidateBoards = (client: QueryClient) =>
  client.invalidateQueries({ queryKey: ['boards'] })

export function useCreateBoard() {
  const client = useQueryClient()
  return useMutation({
    mutationFn: (name?: string) => createBoard(name),
    onSuccess: () => invalidateBoards(client),
  })
}

/**
 * Rename, optimistically — FLOWS §6.6.
 *
 * The new name is written into every cached list before the request goes out,
 * because the user typed it and there is no reason to make them watch a
 * spinner to see their own text. On failure the snapshot is restored and the
 * caller toasts.
 *
 * `E-19`, two people renaming at once: last write wins, and both converge on
 * the server's answer at the next invalidation. No merge, no conflict dialog —
 * a board name is not worth one.
 */
export function useRenameBoard() {
  const client = useQueryClient()
  return useMutation({
    mutationFn: ({ id, name }: { id: string; name: string }) => renameBoard(id, name),
    onMutate: async ({ id, name }) => {
      await client.cancelQueries({ queryKey: ['boards'] })
      const previous = client.getQueriesData({ queryKey: ['boards'] })

      client.setQueriesData({ queryKey: ['boards'] }, (data: unknown) =>
        mapCachedBoards(data, board => (board.id === id ? { ...board, name } : board)),
      )
      return { previous }
    },
    onError: (_error, _variables, context) => {
      for (const [key, data] of context?.previous ?? []) client.setQueryData(key, data)
    },
    onSettled: () => invalidateBoards(client),
  })
}

export function useTrashBoard() {
  const client = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => trashBoard(id),
    /*
     * Removed from the list immediately. The card animating out IS the
     * feedback; waiting for a round trip before it moves makes the click feel
     * unheard, and the 8-second Undo toast is what covers the failure case.
     */
    onMutate: async (id: string) => {
      await client.cancelQueries({ queryKey: ['boards'] })
      const previous = client.getQueriesData({ queryKey: ['boards'] })
      client.setQueriesData({ queryKey: ['boards'] }, (data: unknown) =>
        filterCachedBoards(data, board => board.id !== id),
      )
      return { previous }
    },
    onError: (_error, _id, context) => {
      for (const [key, data] of context?.previous ?? []) client.setQueryData(key, data)
    },
    onSettled: () => invalidateBoards(client),
  })
}

export function useRestoreBoard() {
  const client = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => restoreBoard(id),
    onSuccess: () => invalidateBoards(client),
  })
}

export function usePermanentlyDelete() {
  const client = useQueryClient()
  return useMutation({
    mutationFn: ({ id, confirmName }: { id: string; confirmName: string }) =>
      permanentlyDeleteBoard(id, confirmName),
    onSuccess: () => invalidateBoards(client),
  })
}

export function useDuplicateBoard() {
  const client = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => duplicateBoard(id),
    onSuccess: () => invalidateBoards(client),
  })
}

/* ── Cache shape helpers ───────────────────────────────────────────────────── */

/**
 * The list cache is an infinite query, so it is `{ pages: [{ boards }] }`, and
 * Trash is a plain `{ boards }`. Both are updated by the same mutations, so
 * these two helpers handle either shape rather than making every mutation
 * branch on it.
 */
type Pages = { pages?: BoardPage[]; boards?: BoardSummary[] }

function mapCachedBoards(
  data: unknown,
  fn: (board: BoardSummary) => BoardSummary,
): unknown {
  const cache = data as Pages | undefined
  if (!cache) return data
  if (cache.pages) {
    return {
      ...cache,
      pages: cache.pages.map(page => ({ ...page, boards: page.boards.map(fn) })),
    }
  }
  if (cache.boards) return { ...cache, boards: cache.boards.map(fn) }
  return data
}

function filterCachedBoards(
  data: unknown,
  keep: (board: BoardSummary) => boolean,
): unknown {
  const cache = data as Pages | undefined
  if (!cache) return data
  if (cache.pages) {
    return {
      ...cache,
      pages: cache.pages.map(page => ({
        ...page,
        boards: page.boards.filter(keep),
      })),
    }
  }
  if (cache.boards) return { ...cache, boards: cache.boards.filter(keep) }
  return data
}
