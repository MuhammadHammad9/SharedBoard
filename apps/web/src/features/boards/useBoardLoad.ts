import { useEffect, useRef, useState } from 'react'
import type { Role } from '@coboard/shared'
import { ApiError } from '../../lib/api.js'
import { boardStore } from '../../stores/boardStore.js'
import { history } from '../canvas/history/history.js'
import { startPersistence, stopPersistence } from '../sync/persistence.js'
import { getBoardState } from './api.js'

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
  /** Server sequence the loaded document is current as of. */
  seq: number
  objectCount: number
  retry: () => void
}

export function useBoardLoad(boardId: string | undefined): BoardLoad {
  const [status, setStatus] = useState<BoardLoadStatus>('loading')
  const [role, setRole] = useState<Role | null>(null)
  const [seq, setSeq] = useState(0)
  const [objectCount, setObjectCount] = useState(0)
  const [attempt, setAttempt] = useState(0)
  const mounted = useRef(true)

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])

  useEffect(() => {
    if (!boardId) return

    if (isScratchBoard(boardId)) {
      setRole('OWNER')
      setStatus('ready')
      return
    }

    const controller = new AbortController()
    setStatus('loading')

    void (async () => {
      try {
        const state = await getBoardState(boardId, controller.signal)
        if (controller.signal.aborted) return

        boardStore.getState().loadObjects(state.objects)
        /*
         * A fresh document means a fresh stack — R-UNDO-006. Carrying entries
         * across a load would leave undo holding inverses that name objects
         * this board has never heard of.
         */
        history.clear()

        setRole(state.myRole)
        setSeq(state.seq)
        setObjectCount(state.objects.length)
        setStatus('ready')

        // Only editors get an outbox. A viewer cannot write, so queueing their
        // ops would be building a pile of work the server will always refuse.
        if (state.myRole !== 'VIEWER') startPersistence(boardId)
      } catch (error) {
        if (controller.signal.aborted) return
        if (!(error instanceof ApiError)) {
          setStatus('error')
          return
        }
        /*
         * 404 covers both "no such board" and "not yours" — the server answers
         * 404 to a board the caller cannot see, on purpose (R-SEC-018). The
         * 'forbidden' branch is reachable only once share links exist and a
         * revoked member hits it.
         */
        setStatus(error.status === 404 ? 'not-found' : error.status === 403 ? 'forbidden' : 'error')
      }
    })()

    return () => {
      controller.abort()
      stopPersistence()
      // Leave the document in the store on unmount rather than clearing it:
      // React StrictMode mounts twice in development, and clearing here would
      // blank a board that the second mount is about to reuse.
    }
  }, [boardId, attempt])

  return { status, role, seq, objectCount, retry: () => setAttempt(n => n + 1) }
}
