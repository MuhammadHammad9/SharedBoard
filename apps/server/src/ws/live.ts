import { CLOSE_CODES, type Role } from '@coboard/shared'
import { identityKey, type Identity } from '../lib/identity.js'
import { liveRooms } from './RoomManager.js'
import type { Session } from './Session.js'

/**
 * Telling connected sockets that the ground moved — FLOWS §9.5.
 *
 * These are UX, not security. Enforcement is the per-op role check
 * (`assertCanEdit`, defect P-1): a socket that never receives one of these
 * messages is still refused on its next write. What these buy is that the
 * person finds out NOW — the toolbar disables, the ejection screen appears —
 * rather than on their next stroke.
 *
 * Delivered to sockets on THIS instance (decision D-6). Cross-instance push
 * is a Phase 15 scaling item; correctness does not depend on it.
 */

const sessionsOf = (boardId: string, identity: Identity): Session[] => {
  const key = identityKey(identity)
  return liveRooms()
    .sessions(boardId)
    .filter(s => identityKey(s.identity) === key)
}

/** `role:changed` — do NOT eject; the client disables its toolbar. */
export function pushRoleChanged(boardId: string, identity: Identity, role: Role): void {
  for (const session of sessionsOf(boardId, identity)) {
    session.role = role
    session.send({ t: 'role_changed', role })
  }
}

/** `access:revoked` — S-17, then the socket is closed with 4003. */
export function revokeLive(boardId: string, identity: Identity): void {
  for (const session of sessionsOf(boardId, identity)) {
    session.send({ t: 'access_revoked' })
    session.close(CLOSE_CODES.FORBIDDEN, 'Access revoked')
  }
}

/** `board:deleted` — S-19 for everyone in the room, then 4004. */
export function boardDeletedLive(boardId: string): void {
  for (const session of liveRooms().sessions(boardId)) {
    session.send({ t: 'board_deleted' })
    session.close(CLOSE_CODES.NOT_FOUND, 'Board deleted')
  }
}

/** `board:renamed` — the header updates live, no toast. */
export function boardRenamedLive(boardId: string, name: string): void {
  liveRooms().broadcast(boardId, { t: 'board_renamed', name })
}
