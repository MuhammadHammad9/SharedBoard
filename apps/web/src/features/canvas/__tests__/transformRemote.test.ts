import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { BoardObject, ClientOp, ObjectId, ShapeObject } from '@coboard/shared'
import { boardStore } from '../../../stores/boardStore.js'
import {
  beginDrag,
  beginResize,
  beginRotate,
  cancelDrag,
  cancelResize,
  cancelRotate,
  endDrag,
  endResize,
  endRotate,
  updateDrag,
  updateResize,
  updateRotate,
} from '../interaction/handlers/transform.js'
import { applyRemoteOp } from '../history/applyRemote.js'
import { history } from '../history/history.js'

/**
 * Remote ops merged MID-GESTURE — R-CONV-002.
 *
 * A drag, resize or rotate writes only the geometry it changes onto the
 * CURRENT store object. A teammate's recolour that lands between two
 * pointermoves must survive the next frame, the cancel and the commit — and
 * must not ride out in our UPDATE as if we had made it.
 */

const emitted = vi.hoisted(() => [] as ClientOp[][])
vi.mock('../../sync/persistence.js', async importOriginal => ({
  ...(await importOriginal<typeof import('../../sync/persistence.js')>()),
  emitOps: (ops: readonly ClientOp[]) => emitted.push([...ops]),
}))

const ID = '00000001-0000-4000-8000-000000000000' as ObjectId

function rect(): ShapeObject {
  return {
    id: ID,
    type: 'rect',
    x: 0,
    y: 0,
    width: 100,
    height: 100,
    rotation: 0,
    zIndex: 'a0',
    opacity: 1,
    createdBy: 'me',
    createdAt: 0,
    updatedAt: 0,
    stroke: '#18181B',
    strokeWidth: 2,
    fill: 'none',
  } as ShapeObject
}

const current = () => boardStore.getState().objects.get(ID) as ShapeObject

/** A teammate's recolour, arriving through the remote path. */
function remoteRecolour(seq: number) {
  applyRemoteOp([
    {
      id: `remote-${seq}`,
      type: 'UPDATE',
      objectId: ID,
      payload: { stroke: '#DC2626', updatedAt: 999 },
      seq,
    } as unknown as ClientOp,
  ])
}

beforeEach(() => {
  emitted.length = 0
  history.clear()
  boardStore.getState().setReadOnly(false)
  boardStore.getState().setInteraction({ type: 'IDLE' })
  boardStore.getState().loadObjects([rect() as BoardObject])
  boardStore.getState().setSelection([ID])
})

describe('drag — remote writes mid-gesture', () => {
  it('keeps a remote recolour across later pointermoves', () => {
    beginDrag(1, 0, 0)
    updateDrag(10, 10)
    remoteRecolour(5)
    updateDrag(20, 20)
    expect(current().stroke).toBe('#DC2626')
    expect(current().x).toBe(20)
  })

  it('cancel restores geometry only, keeping the remote recolour', () => {
    beginDrag(1, 0, 0)
    updateDrag(10, 10)
    remoteRecolour(5)
    updateDrag(20, 20)
    cancelDrag(null)
    expect(current().x).toBe(0)
    expect(current().y).toBe(0)
    expect(current().stroke).toBe('#DC2626')
    expect(current().updatedAt).toBe(999)
  })

  it('commits exactly the changed geometry keys, never the remote field', () => {
    beginDrag(1, 0, 0)
    updateDrag(10, 10)
    remoteRecolour(5)
    updateDrag(30, 0)
    endDrag(null)
    expect(emitted).toHaveLength(1)
    const [op] = emitted[0]!
    expect(op!.type).toBe('UPDATE')
    expect(Object.keys(op!.payload as object).sort()).toEqual(['updatedAt', 'x'])
    expect(current().stroke).toBe('#DC2626')
    // Undo returns the geometry and leaves the teammate's colour alone.
    history.undo()
    expect(current().x).toBe(0)
    expect(current().stroke).toBe('#DC2626')
  })

  it('a remote MOVE mid-drag becomes the base a cancel returns to', () => {
    beginDrag(1, 0, 0)
    updateDrag(10, 10)
    applyRemoteOp([
      {
        id: 'remote-move',
        type: 'UPDATE',
        objectId: ID,
        payload: { x: 500 },
        seq: 6,
      } as unknown as ClientOp,
    ])
    updateDrag(20, 20)
    expect(current().x).toBe(520)
    cancelDrag(null)
    expect(current().x).toBe(500)
    expect(current().y).toBe(0)
  })
})

describe('resize and rotate — remote writes mid-gesture', () => {
  it('resize keeps the recolour, cancels to geometry only, and commits geometry only', () => {
    beginResize(1, 'se')
    updateResize(150, 150, { aspect: false, fromCentre: false })
    remoteRecolour(5)
    updateResize(200, 200, { aspect: false, fromCentre: false })
    expect(current().stroke).toBe('#DC2626')
    expect(current().width).toBe(200)
    cancelResize(null)
    expect(current().width).toBe(100)
    expect(current().stroke).toBe('#DC2626')

    beginResize(1, 'se')
    updateResize(200, 150, { aspect: false, fromCentre: false })
    endResize(null)
    const [op] = emitted[0]!
    expect(Object.keys(op!.payload as object).sort()).toEqual([
      'height',
      'updatedAt',
      'width',
    ])
  })

  it('rotate keeps the recolour and commits geometry only', () => {
    beginRotate(1, 50, -100)
    updateRotate(150, 50, false)
    remoteRecolour(5)
    updateRotate(150, 50, false)
    expect(current().stroke).toBe('#DC2626')
    expect(current().rotation).toBeCloseTo(90, 6)
    cancelRotate(null)
    expect(current().rotation).toBe(0)
    expect(current().stroke).toBe('#DC2626')

    beginRotate(1, 50, -100)
    updateRotate(150, 50, false)
    endRotate(null)
    const [op] = emitted[0]!
    const keys = Object.keys(op!.payload as object)
    expect(keys).toContain('rotation')
    expect(keys).not.toContain('stroke')
    expect(keys.every(k => ['x', 'y', 'rotation', 'updatedAt'].includes(k))).toBe(true)
  })
})
