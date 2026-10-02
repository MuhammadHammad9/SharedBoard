import type { Role } from '@coboard/shared'
import { api } from '../../lib/api.js'

/**
 * Sharing — FR-SHARE-002/003/004, FLOWS §7 and §10. The server half is
 * apps/server/src/http/routes/{share,members,boards}.ts.
 */

export type LinkRole = 'EDITOR' | 'VIEWER'

export interface ShareCard {
  boardId: string
  boardName: string
  ownerName: string
  role: LinkRole
  activeCount: number
  present: Array<{ name: string; colour: string }>
}

export interface ShareLinkView {
  token: string
  role: LinkRole
  /** Path only (`/join/…`); the origin is the page's own. */
  url: string
}

export interface Member {
  id: string
  kind: 'user' | 'guest'
  name: string
  email: string | null
  role: Role
  isOwner: boolean
}

export interface PendingInvite {
  email: string
  role: LinkRole
}

/* ── Public — S-11 ────────────────────────────────────────────────────────── */

export const getShareCard = (token: string) =>
  api.get<ShareCard>(`/share/${encodeURIComponent(token)}`)

export const joinAsGuest = (token: string, guestId: string, name: string) =>
  api.post<{ boardId: string; role: Role }>(`/share/${encodeURIComponent(token)}/join`, {
    guestId,
    name,
  })

/* ── The link — owner only ────────────────────────────────────────────────── */

export const getShareLink = (boardId: string) =>
  api.get<{ link: ShareLinkView | null }>(`/boards/${boardId}/share-link`)

export const setShareLink = (boardId: string, role: LinkRole) =>
  api.put<{ link: ShareLinkView }>(`/boards/${boardId}/share-link`, { role })

export const disableShareLink = (boardId: string) =>
  api.del<{ link: null }>(`/boards/${boardId}/share-link`)

export const resetShareLink = (boardId: string) =>
  api.post<{ link: ShareLinkView }>(`/boards/${boardId}/share-link/reset`, {})

/* ── Members ──────────────────────────────────────────────────────────────── */

export const listMembers = (boardId: string) =>
  api.get<{ members: Member[]; invites: PendingInvite[] }>(`/boards/${boardId}/members`)

export const inviteMembers = (boardId: string, emails: string[], role: LinkRole) =>
  api.post<{ added: string[]; invited: string[] }>(`/boards/${boardId}/members`, {
    emails,
    role,
  })

export const setMemberRole = (boardId: string, memberId: string, role: LinkRole) =>
  api.patch<{ id: string; role: LinkRole }>(`/boards/${boardId}/members/${memberId}`, {
    role,
  })

export const removeMember = (boardId: string, memberId: string) =>
  api.del<void>(`/boards/${boardId}/members/${memberId}`)

export const claimGuestSeat = (boardId: string, guestId: string) =>
  api.post<{ role: Role }>(`/boards/${boardId}/members/claim-guest`, { guestId })
