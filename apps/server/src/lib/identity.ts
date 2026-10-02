/**
 * Who is asking: a signed-in user or a guest. Exactly one.
 *
 * A guest is identified by the id it generated for itself and keeps in
 * `localStorage.coboard.guest` (FR-AUTH-006). That id is a 122-bit random
 * bearer secret — decision D-1 in docs/REMAINING-WORK.md — so it
 * authenticates the guest and must never be echoed to anyone else.
 */
export type Identity =
  { kind: 'user'; userId: string } | { kind: 'guest'; guestId: string }

export const userIdentity = (userId: string): Identity => ({ kind: 'user', userId })

/** Stable string form, for cache keys and room lookups. Never sent to clients. */
export const identityKey = (identity: Identity): string =>
  identity.kind === 'user' ? `u:${identity.userId}` : `g:${identity.guestId}`
