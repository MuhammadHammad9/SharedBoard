import type { BoardObject, ClientOp, Role } from '@coboard/shared'
import { api } from '../../lib/api.js'

/**
 * Board REST calls — TRD §4.2.
 *
 * A thin, typed layer over `api`, so no component builds a URL or knows the
 * response shape. The types here mirror the server's responses; they are not
 * duplicated from it, because the object and op types they are built from come
 * from `@coboard/shared` (R-ARCH-007).
 */

export interface BoardSummary {
  id: string
  name: string
  ownerId: string
  ownerName: string
  myRole: Role
  thumbnailUrl: string | null
  objectCount: number
  createdAt: string
  updatedAt: string
  lastActivityAt: string
  deletedAt: string | null
  daysUntilPurge?: number
}

export interface BoardState {
  objects: BoardObject[]
  /** The sequence number this state is current as of — R-SYNC-035. */
  seq: number
  myRole: Role
  meta: { fromSnapshot: boolean; replayed: number }
}

export interface AppendResult {
  applied: Array<{ id: string; seq: number; duplicate: boolean }>
  currentSeq: number
}

export const listBoards = (query = '') =>
  api.get<{ boards: BoardSummary[]; nextCursor: string | null }>(`/boards${query}`)

export const listTrash = () => api.get<{ boards: BoardSummary[] }>('/boards/trash')

export const createBoard = (name?: string) =>
  api.post<{ board: BoardSummary }>('/boards', name === undefined ? {} : { name })

export const getBoard = (id: string) =>
  api.get<{ board: BoardSummary; myRole: Role }>(`/boards/${id}`)

/** The guard's probe. Deliberately returns no board name — R-SEC-018. */
export const getBoardAccess = (id: string, signal?: AbortSignal) =>
  api.get<{ role: Role | 'none'; joinable?: boolean }>(`/boards/${id}/access`, { signal })

export const getBoardState = (id: string, signal?: AbortSignal) =>
  api.get<BoardState>(`/boards/${id}/snapshot`, { signal })

export const getOpsSince = (id: string, since: number) =>
  api.get<{ ops: Array<ClientOp & { seq: number }>; currentSeq: number }>(
    `/boards/${id}/operations?sinceSeq=${since}`,
  )

export const appendOps = (id: string, ops: readonly ClientOp[]) =>
  api.post<AppendResult>(`/boards/${id}/operations`, { ops })

export const renameBoard = (id: string, name: string) =>
  api.patch<{ board: BoardSummary }>(`/boards/${id}`, { name })

export const trashBoard = (id: string) => api.del<{ board: BoardSummary }>(`/boards/${id}`)

export const restoreBoard = (id: string) =>
  api.post<{ board: BoardSummary }>(`/boards/${id}/restore`)

export const permanentlyDeleteBoard = (id: string, confirmName: string) =>
  api.post<void>(`/boards/${id}/permanent-delete`, { confirmName })

export const duplicateBoard = (id: string) =>
  api.post<{ board: BoardSummary }>(`/boards/${id}/duplicate`)
