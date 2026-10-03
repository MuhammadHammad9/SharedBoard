import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BoardObject, ClientMessage } from '@coboard/shared'
import { boardStore } from '../../../stores/boardStore.js'
import { history } from '../../canvas/history/history.js'
import { applyAndEmit, createOps } from '../../canvas/history/apply.js'
import { applyRemoteOp } from '../../canvas/history/applyRemote.js'
import { recordedEvents } from '../../../lib/analytics.js'
import {
  createSocketTransport,
  startPersistence,
  stopPersistence,
} from '../persistence.js'

/**
 * PRD §9 object_created and op_rejected.
 *
 * object_created fires for the local user's own creations only — not for an
 * undo/redo replay and not for a remote op. op_rejected fires per refused op,
 * carrying the server's nack code.
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

const eventsSince = (from: number, name: string) =>
  recordedEvents()
    .slice(from)
    .filter(e => e.event === name)

beforeEach(() => {
  ids = 0
  vi.stubGlobal('localStorage', {
    getItem: () => null,
    setItem: () => {},
    removeItem: () => {},
  })
  vi.stubGlobal('navigator', { onLine: true })
  boardStore.getState().setReadOnly(false)
  boardStore.getState().loadObjects([])
  history.clear()
})

afterEach(() => {
  stopPersistence()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('object_created', () => {
  it('fires once per CREATE of a local action, with the board id', () => {
    const session = startPersistence('board-1')
    vi.spyOn(session.outbox, 'enqueue').mockImplementation(() => {})
    const start = recordedEvents().length

    applyAndEmit(createOps([sticky(), sticky()]), 'Paste')

    expect(eventsSince(start, 'object_created').map(e => e.props)).toEqual([
      { type: 'sticky', board_id: 'board-1' },
      { type: 'sticky', board_id: 'board-1' },
    ])
  })

  it('does not fire for undo/redo replays or remote ops', () => {
    const session = startPersistence('board-1')
    vi.spyOn(session.outbox, 'enqueue').mockImplementation(() => {})
    applyAndEmit(createOps([sticky()]), 'Draw')
    const start = recordedEvents().length

    history.undo()
    history.redo()
    const remote = sticky()
    applyRemoteOp([
      {
        id: '10000000-0000-4000-8000-000000000001',
        type: 'CREATE',
        objectId: remote.id,
        payload: remote,
      },
    ])

    expect(eventsSince(start, 'object_created')).toEqual([])
  })
})

describe('op_rejected', () => {
  it('fires on a socket nack with the op type and the server code', async () => {
    const sent: ClientMessage[] = []
    const session = startPersistence('board-1')
    const binding = createSocketTransport(
      message => {
        sent.push(message)
        return true
      },
      () => true,
    )
    session.bindSocket(binding)
    const start = recordedEvents().length

    applyAndEmit(createOps([sticky()]), 'Draw')
    await vi.waitFor(() => expect(sent).toHaveLength(1))
    const batch = sent[0] as { t: 'op_batch'; ops: Array<{ id: string }> }
    binding.settle({ t: 'nack', id: batch.ops[0]!.id, code: 'FORBIDDEN', message: 'no' })

    await vi.waitFor(() =>
      expect(eventsSince(start, 'op_rejected').map(e => e.props)).toEqual([
        { op_type: 'CREATE', reason: 'FORBIDDEN' },
      ]),
    )
  })
})
