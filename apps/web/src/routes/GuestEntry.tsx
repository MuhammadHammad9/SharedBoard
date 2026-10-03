import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react'
import { useNavigate, useParams } from 'react-router'
import { ApiError, setGuestCredential } from '../lib/api.js'
import { actions, guest, states, strings } from '../lib/strings.js'
import { Button } from '../components/ui/Button.js'
import { Input } from '../components/ui/Input.js'
import { BackToDashboard, FullScreenState } from '../components/ui/FullScreenState.js'
import { useAuthStore } from '../stores/authStore.js'
import { getShareCard, joinAsGuest, type ShareCard } from '../features/sharing/api.js'
import {
  readGuest,
  rememberShareToken,
  saveGuest,
} from '../features/auth/guestIdentity.js'
import { useSessionBootstrap } from './guards.js'
import { track } from '../lib/analytics.js'

/**
 * S-11 — the guest join card, `/join/:token`. FLOWS §7, FR-AUTH-006.
 *
 * Persona B's entire first impression: a stranger clicks a link in Slack and
 * must be drawing within ten seconds without an account. One field — a name —
 * is the only friction allowed (FR-AUTH-006).
 *
 * Who arrives here, and where each goes:
 *
 *   signed-in user        → straight to the board; `/access` makes them a
 *                           member at the link's role (FLOWS §2.4)
 *   returning guest       → straight to the board, S-11 skipped (§7.2)
 *   new guest             → the card, then the board
 *   dead link             → S-17 / S-18 with the §7.3 copy
 *
 * Every navigation to the board uses `replace` (§7.1 step 7) so Back does not
 * return to a join screen that has already done its job.
 *
 * Zone: Guest. `high-end-visual-design` is permitted for this card only
 * (R-SKILL-040) — the Double-Bezel shell below — and the 400 ms entry is the
 * one first-impression flourish the motion table allows. See index.css.
 */

type Phase =
  | { kind: 'loading' }
  | { kind: 'card'; card: ShareCard }
  | { kind: 'invalid' | 'revoked' | 'deleted' }
  | { kind: 'network' }

/** FLOWS §7.3: the counter appears from 30 characters on. */
const COUNTER_FROM = 30
const NAME_MAX = 40

export default function GuestEntry() {
  const { token = '' } = useParams<{ token: string }>()
  const navigate = useNavigate()
  useSessionBootstrap()
  const authStatus = useAuthStore(s => s.status)

  const [phase, setPhase] = useState<Phase>({ kind: 'loading' })
  const [attempt, setAttempt] = useState(0)
  const [name, setName] = useState('')
  const [nameError, setNameError] = useState<string | null>(null)
  const [full, setFull] = useState(false)
  const [joining, setJoining] = useState(false)
  const autoJoined = useRef(false)

  const enterBoard = useCallback(
    (boardId: string, joinedAs?: string) => {
      rememberShareToken(boardId, token)
      navigate(`/board/${boardId}`, {
        replace: true,
        ...(joinedAs ? { state: { joinedAs } } : {}),
      })
    },
    [navigate, token],
  )

  const join = useCallback(
    /**
     * `returning` is the §7.2 path: no "You're in as" toast (that is for a
     * first join from the card); the board shows the "Not you?" chip instead.
     */
    async (card: ShareCard, rawName: string, returning = false) => {
      const trimmed = rawName.trim()
      if (!trimmed) {
        setNameError(guest.nameRequired)
        return
      }
      setJoining(true)
      setFull(false)
      const identity = saveGuest(trimmed)
      setGuestCredential(identity.id)
      try {
        await joinAsGuest(token, identity.id, identity.name)
        if (!returning) track('board_joined_as_guest', { board_id: card.boardId })
        enterBoard(card.boardId, returning ? undefined : identity.name)
      } catch (error) {
        setJoining(false)
        if (error instanceof ApiError && error.status === 403) {
          setFull(true) // "This board is full right now"
          return
        }
        if (error instanceof ApiError && (error.status === 404 || error.status === 410)) {
          setPhase(phaseFor(error))
          return
        }
        setPhase({ kind: 'network' })
      }
    },
    [enterBoard, token],
  )

  // Validate the token — FLOWS §7.1 step 2.
  useEffect(() => {
    const controller = new AbortController()
    setPhase({ kind: 'loading' })
    getShareCard(token)
      .then(card => setPhase({ kind: 'card', card }))
      .catch((error: unknown) => {
        if (controller.signal.aborted) return
        setPhase(error instanceof ApiError ? phaseFor(error) : { kind: 'network' })
      })
    return () => controller.abort()
  }, [token, attempt])

  // The two arrivals that skip the card.
  useEffect(() => {
    if (phase.kind !== 'card' || autoJoined.current) return
    if (authStatus === 'unknown' || authStatus === 'refreshing') return
    if (authStatus === 'authenticated') {
      autoJoined.current = true
      enterBoard(phase.card.boardId)
      return
    }
    const returning = readGuest()
    if (returning) {
      autoJoined.current = true
      void join(phase.card, returning.name, true)
    }
  }, [phase, authStatus, enterBoard, join])

  if (phase.kind === 'invalid' || phase.kind === 'revoked' || phase.kind === 'deleted') {
    const copy =
      phase.kind === 'invalid'
        ? states.linkInvalid
        : phase.kind === 'revoked'
          ? states.linkTurnedOff
          : states.boardGone
    return (
      <FullScreenState
        headline={copy.headline}
        body={copy.body}
        action={<BackToDashboard label={actions.backToHome} />}
        testId={`join-${phase.kind}`}
      />
    )
  }

  if (phase.kind === 'network') {
    return (
      <FullScreenState
        headline={strings.errors.genericServerError}
        body={strings.validation.networkFailure}
        action={
          <Button variant="secondary" onClick={() => setAttempt(n => n + 1)}>
            {actions.retry}
          </Button>
        }
        testId="join-network"
      />
    )
  }

  const card = phase.kind === 'card' ? phase.card : null
  // A returning guest or signed-in user is on their way; the card would flash.
  const passingThrough =
    card !== null && (autoJoined.current || joining) && !full && !nameError

  const onSubmit = (event: FormEvent) => {
    event.preventDefault()
    if (card) void join(card, name)
  }

  return (
    <main className="grid min-h-[100dvh] place-items-center bg-subtle px-4 py-12">
      {/* The Double-Bezel: a hairline outer shell, an inner core with its own
          surface and a concentric radius (12 px outer − 4 px gap = 8 px). */}
      <div
        data-join-card
        className="w-full max-w-sm rounded-lg border border-border bg-subtle p-1 shadow-panel"
        data-testid="join-card"
      >
        <div className="rounded-md bg-app px-6 py-8">
          {card === null || passingThrough ? (
            <div
              aria-busy="true"
              className="flex flex-col gap-3"
              data-testid="join-loading"
            >
              <div className="h-6 w-2/3 rounded-sm bg-subtle" />
              <div className="h-4 w-1/3 rounded-sm bg-subtle" />
              <div className="mt-6 h-10 rounded-md bg-subtle" />
            </div>
          ) : (
            <form onSubmit={onSubmit} noValidate className="flex flex-col gap-6">
              <header className="flex flex-col gap-1">
                <h1
                  className="text-lg font-semibold text-primary"
                  data-testid="join-board-name"
                >
                  {card.boardName}
                </h1>
                <p className="text-sm text-muted">{guest.sharedBy(card.ownerName)}</p>
              </header>

              {card.activeCount > 0 && (
                <div className="flex items-center gap-3" data-testid="join-present">
                  <ul className="flex" aria-hidden="true">
                    {card.present.map((p, i) => (
                      <li
                        key={`${p.name}-${i}`}
                        data-join-avatar
                        style={{ '--i': i } as React.CSSProperties}
                        className={`flex h-7 w-7 items-center justify-center rounded-full border-2 border-app text-[10px] font-semibold text-app ${i > 0 ? '-ml-2' : ''}`}
                      >
                        <span
                          className="flex h-full w-full items-center justify-center rounded-full"
                          style={{ backgroundColor: p.colour }}
                        >
                          {initial(p.name)}
                        </span>
                      </li>
                    ))}
                  </ul>
                  <span className="text-sm text-muted">
                    {guest.hereNow(card.activeCount)}
                  </span>
                </div>
              )}

              <Input
                label={strings.auth.fields.displayName}
                value={name}
                autoFocus
                autoComplete="nickname"
                maxLength={NAME_MAX}
                onChange={e => {
                  setName(e.target.value.slice(0, NAME_MAX))
                  if (nameError) setNameError(null)
                }}
                error={nameError}
                hint={
                  name.length >= COUNTER_FROM ? (
                    <span data-testid="join-counter">
                      {guest.nameCounter(name.length)}
                    </span>
                  ) : undefined
                }
                data-testid="join-name"
              />

              {full && (
                <div
                  role="alert"
                  className="flex items-center justify-between gap-3 text-sm text-danger"
                >
                  <span>{guest.boardFull}</span>
                  <Button variant="secondary" type="submit">
                    {actions.retry}
                  </Button>
                </div>
              )}

              <Button type="submit" fullWidth loading={joining} data-testid="join-submit">
                {actions.joinBoard}
              </Button>
            </form>
          )}
        </div>
      </div>
    </main>
  )
}

function phaseFor(error: ApiError): Phase {
  const reason = (error.details as { reason?: string } | undefined)?.reason
  if (error.status === 410) return { kind: reason === 'deleted' ? 'deleted' : 'revoked' }
  if (error.status === 404) return { kind: 'invalid' }
  return { kind: 'network' }
}

const initial = (name: string) => name.trim().charAt(0).toUpperCase() || '?'
