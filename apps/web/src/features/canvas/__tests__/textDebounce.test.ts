import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  TEXT_UPDATE_DEBOUNCE_MS,
  type BoardObject,
  type ClientOp,
  type ObjectId,
} from '@coboard/shared'
import { boardStore } from '../../../stores/boardStore.js'
import {
  commitTextEdit,
  editExisting,
  flushPendingText,
  updateEditingText,
} from '../interaction/handlers/textEdit.js'
import { history } from '../history/history.js'

/**
 * Typing into an EXISTING note — FLOWS §8.2.2 step 3. The canvas updates on
 * every key; the network gets one op per TEXT_UPDATE_DEBOUNCE_MS pause, and
 * every exit flushes so nothing typed is ever lost.
 */

const emitted = vi.hoisted(() => [] as ClientOp[][])
vi.mock('../../sync/persistence.js', async importOriginal => ({
  ...(await importOriginal<typeof import('../../sync/persistence.js')>()),
  emitOps: (ops: readonly ClientOp[]) => emitted.push([...ops]),
}))

const ID = '00000001-0000-4000-8000-000000000000' as ObjectId

const note = (): BoardObject =>
  ({
    id: ID,
    type: 'sticky',
    x: 0,
    y: 0,
    width: 200,
    height: 200,
    rotation: 0,
    zIndex: 'a0',
    opacity: 1,
    createdBy: 'me',
    createdAt: 0,
    updatedAt: 0,
    text: 'hi',
    color: '#FEF08A',
    fontSize: 16,
    textAlign: 'left',
  }) as BoardObject

const text = () => (boardStore.getState().objects.get(ID) as { text: string }).text

beforeEach(() => {
  vi.useFakeTimers()
  emitted.length = 0
  history.clear()
  boardStore.getState().setReadOnly(false)
  boardStore.getState().setInteraction({ type: 'IDLE' })
  boardStore.getState().loadObjects([note()])
  editExisting(ID)
})

afterEach(() => {
  flushPendingText()
  boardStore.getState().endTextEdit()
  vi.useRealTimers()
})

describe('text edit — debounced emit', () => {
  it('renders every keystroke at once but emits one op per pause', () => {
    updateEditingText('hi t')
    updateEditingText('hi th')
    updateEditingText('hi the')
    expect(text()).toBe('hi the')
    expect(emitted).toHaveLength(0)

    vi.advanceTimersByTime(TEXT_UPDATE_DEBOUNCE_MS)
    expect(emitted).toHaveLength(1)
    const [op] = emitted[0]!
    expect(op).toMatchObject({ type: 'UPDATE', objectId: ID })
    expect(Object.keys(op!.payload as object).sort()).toEqual(['text', 'updatedAt'])
    expect((op!.payload as { text: string }).text).toBe('hi the')
  })

  it('commit flushes what was typed since the last pause', () => {
    updateEditingText('hi there')
    commitTextEdit()
    expect(emitted).toHaveLength(1)
    expect((emitted[0]![0]!.payload as { text: string }).text).toBe('hi there')
    // And no second op later from a stale timer.
    vi.advanceTimersByTime(TEXT_UPDATE_DEBOUNCE_MS * 2)
    expect(emitted).toHaveLength(1)
  })

  it('a burst is one undo entry back to the text before it', () => {
    updateEditingText('hi t')
    updateEditingText('hi there')
    commitTextEdit()
    history.undo()
    expect(text()).toBe('hi')
  })

  it('the flush sends only the text, never a field a teammate changed meanwhile', () => {
    updateEditingText('hi t')
    boardStore.getState().applyOps([
      {
        id: 'remote',
        type: 'UPDATE',
        objectId: ID,
        payload: { color: '#FBCFE8' },
        seq: 4,
      } as unknown as ClientOp,
    ])
    flushPendingText()
    expect(Object.keys(emitted[0]![0]!.payload as object).sort()).toEqual([
      'text',
      'updatedAt',
    ])
    expect((boardStore.getState().objects.get(ID) as { color: string }).color).toBe(
      '#FBCFE8',
    )
  })
})
