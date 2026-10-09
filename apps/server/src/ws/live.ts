import type { Role } from '@coboard/shared'
import { identityKey, type Identity } from '../lib/identity.js'
import { liveRooms } from './RoomManager.js'

/**
 * Telling connected sockets that the ground moved — FLOWS §9.5.
 *
 * These are UX, not security. Enforcement is the per-op role check
 * (`assertCanEdit`, defect P-1): a socket that never receives one of these
 * messages is still refused on its next write. What these buy is that the
 * person finds out NOW — the toolbar disables, the ejection screen appears —
 * rather than on their next stroke.
 *
 * Each goes to this instance's sockets and, through the room manager's relay,
 * to every other instance's (TRD §15.2) — the person may be connected to a
 * different process from the one that served the owner's request.
 */

/** `role:changed` — do NOT eject; the client disables its toolbar. */
export function pushRoleChanged(boardId: string, identity: Identity, role: Role): void {
  liveRooms().control(boardId, {
    action: 'role',
    identityKey: identityKey(identity),
    role,
  })
}

/** `access:revoked` — S-17, then the socket is closed with 4003. */
export function revokeLive(boardId: string, identity: Identity): void {
  liveRooms().control(boardId, { action: 'revoke', identityKey: identityKey(identity) })
}

/** `board:deleted` — S-19 for everyone in the room, then 4004. */
export function boardDeletedLive(boardId: string): void {
  liveRooms().control(boardId, { action: 'deleted' })
}

/** `board:renamed` — the header updates live, no toast. */
export function boardRenamedLive(boardId: string, name: string): void {
  liveRooms().broadcast(boardId, { t: 'board_renamed', name })
}
