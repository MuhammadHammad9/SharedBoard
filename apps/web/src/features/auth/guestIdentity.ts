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

/**
 * The message a signup tab opened from the guest bar posts back to the board
 * tab — FLOWS §7.4. Same-origin only, checked on both ends.
 */
export const ACCOUNT_CREATED_MESSAGE = 'coboard:account-created'

/**
 * Two routes, because neither alone always arrives:
 *
 *   window.opener.postMessage   the guest bar opens signup with window.open,
 *                               so the email path has an opener
 *   BroadcastChannel            the Google path leaves for accounts.google.com
 *                               and back; a cross-origin opener policy on the
 *                               way can sever `window.opener` for good. A
 *                               channel needs no opener — same origin only.
 *
 * The receiver acts once however many copies arrive (useGuestConversion).
 */
const CHANNEL = 'coboard:guest'

/** Set by a signup tab from the guest bar before it leaves for Google. */
const FROM_GUEST_KEY = 'coboard.signup.fromGuest'

export function markSignupFromGuest(): void {
  try {
    sessionStorage.setItem(FROM_GUEST_KEY, '1')
  } catch {
    // E-18: the board tab stays a guest; nothing on it is lost.
  }
}

/** True once, in the tab that started signup from the guest bar. */
export function takeSignupFromGuest(): boolean {
  try {
    const marked = sessionStorage.getItem(FROM_GUEST_KEY) === '1'
    sessionStorage.removeItem(FROM_GUEST_KEY)
    return marked
  } catch {
    return false
  }
}

export function announceAccountCreated(): void {
  const message = { type: ACCOUNT_CREATED_MESSAGE }
  try {
    ;(window.opener as Window | null)?.postMessage(message, window.location.origin)
  } catch {
    // The opener went away.
  }
  try {
    const channel = new BroadcastChannel(CHANNEL)
    channel.postMessage(message)
    channel.close()
  } catch {
    // No BroadcastChannel: the opener route above is all there is.
  }
}

/** Calls `onCreated` for either route. Returns the unsubscribe. */
export function onAccountCreated(onCreated: () => void): () => void {
  const isOurs = (data: unknown) =>
    (data as { type?: unknown } | null)?.type === ACCOUNT_CREATED_MESSAGE

  const onMessage = (event: MessageEvent) => {
    if (event.origin !== window.location.origin || !isOurs(event.data)) return
    onCreated()
  }
  window.addEventListener('message', onMessage)

  let channel: BroadcastChannel | null = null
  try {
    channel = new BroadcastChannel(CHANNEL)
    channel.onmessage = event => {
      if (isOurs(event.data)) onCreated()
    }
  } catch {
    channel = null
  }

  return () => {
    window.removeEventListener('message', onMessage)
    channel?.close()
  }
}
