import type { BoardSummary } from '../../../packages/shared/src/schemas/board.js'

/**
 * A complete `BoardSummary` for specs that stub `/api/boards`. Typed against
 * the shared schema, so a field the dashboard starts to rely on cannot go
 * missing from the stub unnoticed (two specs once stubbed a stale shape and
 * the card crashed on `members`).
 */
export const STUB_BOARD: BoardSummary = {
  id: '11111111-1111-4111-8111-111111111111',
  name: 'Q3 launch retro — product and design',
  ownerId: '00000000-0000-4000-8000-000000000001',
  ownerName: 'Priya Raman',
  ownerAvatarUrl: null,
  myRole: 'OWNER',
  thumbnailUrl: null,
  objectCount: 42,
  createdAt: '2026-09-01T09:00:00.000Z',
  updatedAt: '2026-09-30T16:20:00.000Z',
  lastActivityAt: '2026-09-30T16:20:00.000Z',
  deletedAt: null,
  members: [
    { id: 'u-marcus', displayName: 'Marcus Lee', avatarUrl: null, guest: false },
    { id: 'u-ana', displayName: 'Ana Souza', avatarUrl: null, guest: false },
  ],
  memberCount: 2,
}
