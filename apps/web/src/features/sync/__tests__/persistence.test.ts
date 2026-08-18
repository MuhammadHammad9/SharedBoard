import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BoardObject, ClientOp } from '@coboard/shared'
import { boardStore } from '../../../stores/boardStore.js'
import { history } from '../../canvas/history/history.js'
import { applyAndEmit, createOps } from '../../canvas/history/apply.js'
import { applyRemoteOp } from '../../canvas/history/applyRemote.js'
import { activeSession, startPersistence, stopPersistence } from '../persistence.js'

/**
 * The emit seam — where the local write path meets the outbox.
 *
 * Two claims are under test, and both are the kind that only fail after a
 * reload, which is to say the kind nobody notices in manual QA:
 *
 *   1. Undo and redo REACH the server. An undo that is only local means the
 *      undone work comes back on the next load.
 *   2. Remote ops do NOT. Echoing an op back to the server would be an
 *      infinite loop between two clients from Phase 9 onward.
 */

let ids = 0
const sticky = (): BoardObject =>
  ({
    id: `00000000-0000-4000-8000-${String(++ids).padStart(12, '0')}`,
    type: 'sticky',
    x: 0,
    y: 0,
    width: 200,
    height: 200,
    rotation: 0,
    zIndex: `a${String(ids).padStart(6, '0')}`,
    opacity: 1,
    createdBy: 'test',
    createdAt: 1,
    updatedAt: 1,
    text: 'note',
    color: '#FEF08A',
    fontSize: 16,
    textAlign: 'left',
  }) as BoardObject

const sent: ClientOp[][] = []

beforeEach(() => {
  ids = 0
  sent.length = 0
  vi.stubGlobal('localStorage', {
    getItem: () => null,
    setItem: () => {},
    removeItem: () => {},
  })
  vi.stubGlobal('navigator', { onLine: true })
  boardStore.getState().loadObjects([])
  history.clear()

  const session = startPersistence('board-1')
  // Intercept at the outbox rather than at fetch: what matters is which ops
  // were handed to the transport, not how they were serialised.
  vi.spyOn(session.outbox, 'enqueue').mockImplementation(ops => {
    sent.push([...ops])
  })
})

afterEach(() => {
  stopPersistence()
  vi.restoreAllMocks()
})

describe('emit', () => {
  it('sends a local change', () => {
    applyAndEmit(createOps([sticky()]), 'Draw')
    expect(sent).toHaveLength(1)
    expect(sent[0]![0]).toMatchObject({ type: 'CREATE' })
  })

  it('sends the inverse when the user undoes — R-UNDO-003', () => {
    applyAndEmit(createOps([sticky()]), 'Draw')
    history.undo()

    expect(sent).toHaveLength(2)
    // An undo is an ORDINARY op. There is no "undo" message type, and the
    // server must see the delete or the object survives the next reload.
    expect(sent[1]![0]).toMatchObject({ type: 'DELETE' })
  })

  it('gives every re-emit a FRESH op id — R-SYNC-014', () => {
    applyAndEmit(createOps([sticky()]), 'Draw')
    history.undo()
    history.redo()
    history.undo()

    const wireIds = sent.flat().map(op => op.id)
    /*
     * A history entry holds ONE inverse array, replayed on every undo. Sending
     * the same op id twice is re-acked as a duplicate and writes nothing — the
     * second undo would be visible locally and absent from the database. The
     * ids must differ even though the objectId and payload do not.
     */
    expect(new Set(wireIds).size).toBe(wireIds.length)
    expect(sent[1]![0]!.objectId).toBe(sent[3]![0]!.objectId)
  })

  it('does NOT send a remote op back to the server', () => {
    const object = sticky()
    applyRemoteOp([
      { id: 'remote-1', type: 'CREATE', objectId: object.id, payload: object } as ClientOp,
    ])
    // Echoing would be an infinite loop between two clients, and it would put
    // a teammate's change into our outbox as if it were ours.
    expect(sent).toHaveLength(0)
  })

  it('drops ops silently when no board session is open', () => {
    stopPersistence()
    expect(activeSession()).toBeNull()
    // The Phase 2-6 canvas suites and `pnpm dev` on a scratch board both run
    // with no session. Drawing must still work.
    expect(() => applyAndEmit(createOps([sticky()]), 'Draw')).not.toThrow()
  })
})
