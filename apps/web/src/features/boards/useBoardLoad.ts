import { useCallback, useEffect, useRef, useState } from 'react'
import type { ConnectionState, Role } from '@coboard/shared'
import { ApiError } from '../../lib/api.js'
import { useToast } from '../../components/ui/Toast.js'
import { errors, presence } from '../../lib/strings.js'
import { BoardSession } from '../sync/session.js'
import { abandonPersistence } from '../sync/persistence.js'
import { track } from '../../lib/analytics.js'

/**
 * A board id the server could never own — anything that is not a uuid.
 *
 * In DEVELOPMENT that is a scratch board: no fetch, no outbox, just the canvas
 * over an empty document (or the `?stress=1` fixture). It is what lets the
 * Phase 2-6 canvas suites drive the renderer and the interaction machine
 * without a database, and what makes `pnpm dev` usable before you have signed
 * in anywhere.
 *
 * In PRODUCTION there is no such thing: the id goes to the server, which
 * answers 404 to a malformed one, and the user gets S-20.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const isScratchBoard = (id: string): boolean => import.meta.env.DEV && !UUID.test(id)

/**
 * Load a board's content and start persisting changes back — FLOWS §2.3 step 5.
 *
 * ┌──────────────────────────────────────────────────────────────────────────┐
 * │  ORDER MATTERS — R-SYNC-035.                                             │
 * │                                                                          │
 * │  State is fetched FIRST and persistence starts only once it has landed.  │
 * │  Starting the outbox first would let a queued op from a previous session │
 * │  flush and be reflected in a `/state` response that was already in       │
 * │  flight, or — worse in Phase 9 — let a live op apply to a document that  │
 * │  has not loaded yet. The symptom is objects flickering in and then       │
 * │  vanishing, which is the classic version of this bug.                    │
 * └──────────────────────────────────────────────────────────────────────────┘
 */

/**
 * `deleted` and `revoked` are the LIVE ejections of FLOWS §9.5 — the board
 * went away, or the person's access did, while it was open. `not-found` and
 * `forbidden` are what loading it answered.
 */
export type BoardLoadStatus =
  'loading' | 'ready' | 'not-found' | 'forbidden' | 'deleted' | 'revoked' | 'error'

export interface BoardLoad {
  status: BoardLoadStatus
  role: Role | null
  name: string
  /** Live socket state, for the header indicator — FR-RT-009. */
  connection: ConnectionState
  /** Reconnect attempt in flight. */
  attempt: number
  /** Changes the server has not acknowledged yet. */
  pending: number
  /** "Retry now" — restarts the backoff. */
  retryConnection: () => void
  /** Reconnect under a new identity — guest → account (FLOWS §7.4). */
  reconnect: () => void
  /** Server sequence the loaded document is current as of. */
  seq: number
  objectCount: number
  retry: () => void
}

export function useBoardLoad(boardId: string | undefined): BoardLoad {
  const [status, setStatus] = useState<BoardLoadStatus>('loading')
  const [role, setRole] = useState<Role | null>(null)
  const [name, setName] = useState('')
  const [seq, setSeq] = useState(0)
  const [objectCount, setObjectCount] = useState(0)
  const [attempt, setAttempt] = useState(0)
  const [connection, setConnection] = useState<ConnectionState>('connecting')
  const [attemptN, setAttemptN] = useState(0)
  const [pending, setPending] = useState(0)
  const sessionRef = useRef<BoardSession | null>(null)
  const roleRef = useRef<Role | null>(null)
  const toast = useToast()
  // Stable, so effects that depend on it (useGuestConversion) subscribe once.
  const reconnect = useCallback(() => sessionRef.current?.socket.restart(), [])

  useEffect(() => {
    if (!boardId) return

    if (isScratchBoard(boardId)) {
      setRole('OWNER')
      setName('Scratch board')
      setStatus('ready')
      return
    }

    /*
     * ONE session owns the snapshot fetch, the socket and the outbox, and it
     * runs them in the order FLOWS §2.3 STEP 5 requires — see
     * features/sync/session.ts. The hook's job is only to translate its
     * outcome into the four screens this route can render.
     */
    const session = new BoardSession(boardId, {
      onState: next => setConnection(next),
      onRole: next => {
        // FLOWS §9.5: demoted to viewer live — do not eject; say so once.
        // Outside the state updater, which StrictMode runs twice.
        const previous = roleRef.current
        if (previous && previous !== 'VIEWER' && next === 'VIEWER') {
          toast.show({ message: presence.nowViewer })
        }
        roleRef.current = next
        setRole(next)
      },
      onNack: () => toast.show({ message: errors.opRejected, variant: 'danger' }),
      onFatal: kind => {
        /*
         * FLOWS §9.5: freeze, close the socket, full-screen state — and do NOT
         * try to sync the outbox, because the target is gone. Its queue is
         * discarded so a later visit does not replay into a board that no
         * longer exists or no longer lets this person write.
         */
        abandonPersistence(boardId)
        setStatus(kind === 'deleted' ? 'deleted' : 'revoked')
      },
      onBoardRenamed: next => setName(next),
      onAttempt: n => setAttemptN(n),
      onPending: n => setPending(n),
      // "Back online — 12 changes synced". Silent when nothing was waiting:
      // a blip the user never noticed needs no announcement.
      onBackOnline: synced => {
        if (synced > 0) toast.show({ message: presence.backOnline(synced) })
      },
    })
    sessionRef.current = session

    setStatus('loading')
    const startedAt = performance.now()

    void (async () => {
      try {
        const result = await session.start()
        if (sessionRef.current !== session) return
        roleRef.current = result.role
        setRole(result.role)
        setName(result.name)
        setSeq(result.seq)
        setObjectCount(result.objects)
        setStatus('ready')
        // FLOWS §2.3 STEP 6 — with the measured load time (PRD §9).
        track('board_opened', { load_ms: Math.round(performance.now() - startedAt) })
      } catch (error) {
        if (sessionRef.current !== session) return
        if (!(error instanceof ApiError)) {
          setStatus('error')
          return
        }
        /*
         * 404 covers both "no such board" and "not yours" — the server answers
         * 404 to a board the caller cannot see, on purpose (R-SEC-018).
         */
        setStatus(
          error.status === 404
            ? 'not-found'
            : error.status === 403
              ? 'forbidden'
              : 'error',
        )
      }
    })()

    // The `online`, `offline` and `visibilitychange` triggers belong to the
    // session itself (features/sync/session.ts) — they are sync policy.
    return () => {
      sessionRef.current = null
      session.dispose()
    }
  }, [boardId, attempt, toast])

  return {
    status,
    role,
    name,
    seq,
    objectCount,
    connection,
    attempt: attemptN,
    pending,
    retryConnection: () => sessionRef.current?.resume(),
    reconnect,
    retry: () => setAttempt(n => n + 1),
  }
}
