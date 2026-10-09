/**
 * @vitest-environment happy-dom
 *
 * useBoardLoad — what survives a board switch (nothing of the board's), and
 * what a 404/403 load leaves running (nothing at all).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, renderHook, waitFor } from '@testing-library/react'
import type { BoardObject, ObjectId } from '@coboard/shared'
import { ApiError } from '../../../lib/api.js'

const sessions = vi.hoisted(() => ({
  start: vi.fn(),
  dispose: vi.fn(),
}))
vi.mock('../../sync/session.js', () => ({
  BoardSession: class {
    socket = { restart: vi.fn() }
    start = sessions.start
    dispose = sessions.dispose
    resume = vi.fn()
  },
}))

const { useBoardLoad, DEMO_BOARD_ID } = await import('../useBoardLoad.js')
const { boardStore } = await import('../../../stores/boardStore.js')
const { history } = await import('../../canvas/history/history.js')

const BOARD = '00000000-0000-4000-8000-000000000001'
const ID = '00000009-0000-4000-8000-000000000000' as ObjectId

const leftover = () =>
  ({
    id: ID,
    type: 'rect',
    x: 0,
    y: 0,
    width: 10,
    height: 10,
    rotation: 0,
    zIndex: 'a0',
    opacity: 1,
    createdBy: 't',
    createdAt: 0,
    updatedAt: 0,
    stroke: '#18181B',
    strokeWidth: 2,
    fill: 'none',
  }) as unknown as BoardObject

/** State a real board leaves behind. */
function dirtyTheStore() {
  const s = boardStore.getState()
  s.loadObjects([leftover()])
  s.setSelection([ID])
  s.setViewport({ x: 300, y: -120, zoom: 2 })
  s.setEraseCandidate(ID)
  s.startDraft({ id: 'd', points: [0, 0, 0.5] } as never)
  s.setInteraction({ type: 'ERASING', pointerId: 1 })
  history.push({ forward: [], inverse: [], label: 'x' } as never)
}

beforeEach(() => {
  sessions.start.mockReset()
  sessions.dispose.mockReset()
})

afterEach(() => cleanup())

describe('board switch — nothing of the last board survives', () => {
  it('/demo opens an EMPTY document with a fresh selection, viewport and gesture', () => {
    dirtyTheStore()
    renderHook(() => useBoardLoad(DEMO_BOARD_ID))
    const s = boardStore.getState()
    expect(s.objects.size).toBe(0)
    expect(s.sortedIds).toEqual([])
    expect(s.selection).toEqual([])
    expect(s.viewport).toEqual({ x: 0, y: 0, zoom: 1 })
    expect(s.interaction).toEqual({ type: 'IDLE' })
    expect(s.draft).toBeNull()
    expect(s.eraseCandidate).toBeNull()
    expect(s.editingTextId).toBeNull()
    expect(history.canUndo()).toBe(false)
  })

  it('leaving a board clears it on unmount — after every other cleanup has read it', async () => {
    const view = renderHook(() => useBoardLoad(DEMO_BOARD_ID))
    dirtyTheStore()
    view.unmount()
    // Still there for the rest of the route's cleanups (the thumbnail capture).
    expect(boardStore.getState().objects.size).toBeGreaterThan(0)
    await Promise.resolve()
    expect(boardStore.getState().objects.size).toBe(0)
    expect(boardStore.getState().selection).toEqual([])
  })

  it('a deferred clear never lands on the board that replaced it', async () => {
    const view = renderHook(({ id }) => useBoardLoad(id), {
      initialProps: { id: DEMO_BOARD_ID },
    })
    view.rerender({ id: 'scratch-two' })
    dirtyTheStore()
    await Promise.resolve()
    expect(boardStore.getState().objects.size).toBeGreaterThan(0)
  })
})

describe('a load that fails for good stops the session', () => {
  it.each([404, 403])('disposes the session on %i', async status => {
    sessions.start.mockRejectedValue(new ApiError('X', 'no', status))
    const view = renderHook(() => useBoardLoad(BOARD))
    await waitFor(() =>
      expect(view.result.current.status).toBe(status === 404 ? 'not-found' : 'forbidden'),
    )
    // Disposed by the failure itself, not only later by unmount.
    expect(sessions.dispose).toHaveBeenCalled()
  })
})
