import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ServerMessage } from '@coboard/shared'

/**
 * The board session's outbox lifecycle — a viewer promoted mid-session must
 * get one, and only once, and never before the snapshot (R-SYNC-035).
 */

const boards = vi.hoisted(() => ({
  getBoardState: vi.fn(),
  getOpsSince: vi.fn(),
  appendOps: vi.fn(),
}))
vi.mock('../../boards/api.js', () => boards)

const sockets = vi.hoisted(() => ({
  last: null as null | { handlers: Record<string, unknown> },
}))
vi.mock('../SocketClient.js', () => ({
  SocketClient: class {
    connectionState = 'connected'
    isOpen = true
    constructor(
      _boardId: string,
      readonly handlers: Record<string, unknown>,
    ) {
      sockets.last = this
    }
    connect = vi.fn(async () => {})
    send = vi.fn(() => true)
    close = vi.fn()
    resume = vi.fn()
    goOffline = vi.fn()
    checkNow = vi.fn()
    markSynced = vi.fn()
    restart = vi.fn()
    simulateDrop = vi.fn()
    sendRaw = vi.fn()
  },
}))

const { BoardSession } = await import('../session.js')
const { activeSession } = await import('../persistence.js')

const state = (myRole: 'VIEWER' | 'EDITOR') => ({
  objects: [],
  seq: 7,
  myRole,
  name: 'Q3 planning',
})

const callbacks = () => ({
  onState: vi.fn(),
  onRole: vi.fn(),
  onNack: vi.fn(),
  onFatal: vi.fn(),
})

describe('BoardSession — role changes and the outbox', () => {
  let session: InstanceType<typeof BoardSession> | null = null

  beforeEach(() => {
    vi.stubGlobal('localStorage', {
      getItem: () => null,
      setItem: () => {},
      removeItem: () => {},
    })
    vi.stubGlobal('navigator', { onLine: true })
    boards.getBoardState.mockReset()
  })

  afterEach(() => {
    session?.dispose()
    session = null
    vi.unstubAllGlobals()
  })

  it('a viewer has no outbox', async () => {
    boards.getBoardState.mockResolvedValue(state('VIEWER'))
    session = new BoardSession('board-1', callbacks())
    await session.start()
    expect(activeSession()).toBeNull()
  })

  it('starts the outbox the first time a viewer is promoted', async () => {
    boards.getBoardState.mockResolvedValue(state('VIEWER'))
    const cb = callbacks()
    session = new BoardSession('board-1', cb)
    await session.start()
    expect(activeSession()).toBeNull()

    session.sync.handle({ t: 'role_changed', role: 'EDITOR' } as ServerMessage)
    const first = activeSession()
    expect(first).not.toBeNull()
    expect(cb.onRole).toHaveBeenCalledWith('EDITOR')

    // A later report (every rejoin sends one) does not restart it.
    session.sync.handle({ t: 'role_changed', role: 'EDITOR' } as ServerMessage)
    expect(activeSession()).toBe(first)
  })

  it('a promotion reported before the snapshot waits for it — R-SYNC-035', async () => {
    let resolve: (v: ReturnType<typeof state>) => void = () => {}
    boards.getBoardState.mockReturnValue(new Promise(r => (resolve = r)))
    session = new BoardSession('board-1', callbacks())
    const started = session.start()

    // join_ack races ahead of the snapshot.
    session.sync.handle({ t: 'join_ack', role: 'EDITOR', seq: 7 } as ServerMessage)
    expect(activeSession()).toBeNull()

    resolve(state('VIEWER'))
    await started
    expect(activeSession()).not.toBeNull()
  })

  it('an editor gets the outbox at load, once', async () => {
    boards.getBoardState.mockResolvedValue(state('EDITOR'))
    session = new BoardSession('board-1', callbacks())
    await session.start()
    const first = activeSession()
    expect(first).not.toBeNull()
    session.sync.handle({ t: 'join_ack', role: 'EDITOR', seq: 7 } as ServerMessage)
    expect(activeSession()).toBe(first)
  })
})

describe('BoardSession — room capacity, FR-RT-011 (D-26)', () => {
  let session: InstanceType<typeof BoardSession> | null = null

  beforeEach(() => {
    vi.stubGlobal('localStorage', {
      getItem: () => null,
      setItem: () => {},
      removeItem: () => {},
    })
    vi.stubGlobal('navigator', { onLine: true })
    boards.getBoardState.mockReset()
  })

  afterEach(() => {
    session?.dispose()
    session = null
    vi.unstubAllGlobals()
  })

  it('an over-capacity join_ack raises the notice and makes the board view-only', async () => {
    let resolve: (v: ReturnType<typeof state>) => void = () => {}
    boards.getBoardState.mockReturnValue(new Promise(r => (resolve = r)))
    const cb = { ...callbacks(), onOverCapacity: vi.fn() }
    session = new BoardSession('board-1', cb)
    const started = session.start()

    session.sync.handle({
      t: 'join_ack',
      role: 'VIEWER',
      seq: 7,
      overCapacity: true,
    } as ServerMessage)
    expect(cb.onOverCapacity).toHaveBeenCalledTimes(1)
    expect(cb.onRole).toHaveBeenCalledWith('VIEWER')

    // The membership says EDITOR; the socket's word wins.
    resolve(state('EDITOR'))
    expect((await started).role).toBe('VIEWER')
  })

  it('an ordinary join_ack raises no notice', async () => {
    boards.getBoardState.mockResolvedValue(state('EDITOR'))
    const cb = { ...callbacks(), onOverCapacity: vi.fn() }
    session = new BoardSession('board-1', cb)
    await session.start()
    session.sync.handle({ t: 'join_ack', role: 'EDITOR', seq: 7 } as ServerMessage)
    expect(cb.onOverCapacity).not.toHaveBeenCalled()
  })
})

describe('BoardSession — presence sweep', () => {
  it('sweeps stale cursors about once a second, and stops on dispose', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('localStorage', {
      getItem: () => null,
      setItem: () => {},
      removeItem: () => {},
    })
    const { presenceStore } = await import('../../presence/presenceStore.js')
    const { PRESENCE_SWEEP_IDLE_MS } = await import('@coboard/shared')
    const session = new BoardSession('board-1', callbacks())
    try {
      presenceStore.moveCursor('ghost', 10, 10, Date.now() - PRESENCE_SWEEP_IDLE_MS - 1)
      expect(presenceStore.allCursors()).toHaveLength(1)
      vi.advanceTimersByTime(1_000)
      expect(presenceStore.allCursors()).toHaveLength(0)

      const sweep = vi.spyOn(presenceStore, 'sweep')
      session.dispose()
      vi.advanceTimersByTime(5_000)
      expect(sweep).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
      vi.unstubAllGlobals()
    }
  })
})
