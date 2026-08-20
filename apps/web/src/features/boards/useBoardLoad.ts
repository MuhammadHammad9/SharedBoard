import { useEffect, useRef, useState } from 'react'
import type { ConnectionState, Role } from '@coboard/shared'
import { ApiError } from '../../lib/api.js'
import { useToast } from '../../components/ui/Toast.js'
import { errors } from '../../lib/strings.js'
import { BoardSession } from '../sync/session.js'

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

export type BoardLoadStatus = 'loading' | 'ready' | 'not-found' | 'forbidden' | 'error'

export interface BoardLoad {
  status: BoardLoadStatus
  role: Role | null
  name: string
  /** Live socket state, for the header indicator — FR-RT-009. */
  connection: ConnectionState
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
  const sessionRef = useRef<BoardSession | null>(null)
  const toast = useToast()

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
      onRole: next => setRole(next),
      onNack: () => toast.show({ message: errors.opRejected, variant: 'danger' }),
      onFatal: kind => setStatus(kind === 'deleted' ? 'not-found' : 'forbidden'),
      onBoardRenamed: next => setName(next),
    })
    sessionRef.current = session

    setStatus('loading')

    void (async () => {
      try {
        const result = await session.start()
        if (sessionRef.current !== session) return
        setRole(result.role)
        setName(result.name)
        setSeq(result.seq)
        setObjectCount(result.objects)
        setStatus('ready')
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
          error.status === 404 ? 'not-found' : error.status === 403 ? 'forbidden' : 'error',
        )
      }
    })()

    // Flush and reconnect the moment the browser says it is back, rather than
    // waiting out whatever backoff was in flight.
    const onOnline = () => session.resume()
    window.addEventListener('online', onOnline)

    return () => {
      window.removeEventListener('online', onOnline)
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
    retry: () => setAttempt(n => n + 1),
  }
}
