import { PRESENCE_COLOURS } from '@coboard/shared'

/**
 * The guest identity — FR-AUTH-006, FLOWS §7.
 *
 * `localStorage.coboard.guest` holds `{ id, name, colour }`, so a guest who
 * comes back to a board keeps the same identity (FLOWS §7.2 — S-11 is skipped).
 *
 * ┌──────────────────────────────────────────────────────────────────────────┐
 * │  THE ID IS A CREDENTIAL (decision D-1).                                  │
 * │                                                                          │
 * │  `crypto.randomUUID()` gives 122 random bits, and the server treats the │
 * │  id as the guest's bearer secret: it is sent on the `x-coboard-guest`   │
 * │  header and nowhere else. It never appears in presence or member lists, │
 * │  so nobody else in the room ever learns it. Do not log it.              │
 * └──────────────────────────────────────────────────────────────────────────┘
 *
 * E-18: if storage is blocked (private mode, cookies off) the identity lives
 * in memory for the tab. The guest can still join and draw; it just does not
 * survive a reload. No error is shown.
 */

export interface GuestIdentity {
  id: string
  name: string
  /** A display hint for the join card. The ROOM assigns the real presence colour. */
  colour: string
}

const KEY = 'coboard.guest'
let memory: GuestIdentity | null = null

export function readGuest(): GuestIdentity | null {
  try {
    const store = globalThis.localStorage
    // No storage API at all is the E-18 case too.
    if (!store) return memory
    const raw = store.getItem(KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as Partial<GuestIdentity>
    if (
      typeof parsed.id === 'string' &&
      /^[0-9a-f-]{36}$/i.test(parsed.id) &&
      typeof parsed.name === 'string' &&
      parsed.name.trim().length > 0 &&
      typeof parsed.colour === 'string'
    ) {
      return { id: parsed.id, name: parsed.name, colour: parsed.colour }
    }
    return null
  } catch {
    return memory
  }
}

/** Create — or rename — this browser's guest identity. The id never changes. */
export function saveGuest(name: string): GuestIdentity {
  const existing = readGuest()
  const id = existing?.id ?? crypto.randomUUID()
  const identity: GuestIdentity = {
    id,
    name: name.trim(),
    colour: existing?.colour ?? colourFor(id),
  }
  memory = identity
  try {
    globalThis.localStorage?.setItem(KEY, JSON.stringify(identity))
  } catch {
    // E-18: in memory only. Deliberately silent.
  }
  return identity
}

/** "Not you?" (FLOWS §7.2), or the account took over (§7.4). */
export function clearGuest(): void {
  memory = null
  try {
    globalThis.localStorage?.removeItem(KEY)
  } catch {
    // Nothing to clear.
  }
}

function colourFor(id: string): string {
  let h = 0
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) | 0
  return PRESENCE_COLOURS[Math.abs(h) % PRESENCE_COLOURS.length]!
}

/* ── The share token the visitor arrived with ─────────────────────────────── */

/**
 * FLOWS §7.1 step 2: the token is kept in `sessionStorage` — this tab only,
 * gone when it closes — so the board guard can present it to `/access`.
 * Keyed by board, because a tab can visit two shared boards in turn.
 */
const shareKey = (boardId: string) => `coboard.share.${boardId}`
const shareMemory = new Map<string, string>()

export function rememberShareToken(boardId: string, token: string): void {
  shareMemory.set(boardId, token)
  try {
    globalThis.sessionStorage?.setItem(shareKey(boardId), token)
  } catch {
    // In memory for this tab.
  }
}

export function shareTokenFor(boardId: string): string | null {
  try {
    const store = globalThis.sessionStorage
    if (!store) return shareMemory.get(boardId) ?? null
    return store.getItem(shareKey(boardId))
  } catch {
    return shareMemory.get(boardId) ?? null
  }
}
