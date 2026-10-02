/**
 * @vitest-environment happy-dom
 *
 * Viewer mode — FR-SHARE-006, defect P-2.
 *
 * The server already refuses a viewer's ops (AT-20). These tests are about
 * the other half: that a viewer is never SHOWN an edit that then snaps back,
 * because nothing on the client lets one start.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import type { BoardObject, ObjectId } from '@coboard/shared'
import { boardStore } from '../../../stores/boardStore.js'
import { history } from '../../../features/canvas/history/history.js'
import {
  applyAndEmit,
  createOps,
  deleteOps,
} from '../../../features/canvas/history/apply.js'
import { guest } from '../../../lib/strings.js'
import { Toolbar } from '../Toolbar.js'

const sticky = (): BoardObject =>
  ({
    id: '00000000-0000-4000-8000-000000000001',
    type: 'sticky',
    x: 0,
    y: 0,
    width: 200,
    height: 200,
    rotation: 0,
    zIndex: 'a0',
    opacity: 1,
    createdBy: 'test',
    createdAt: 1,
    updatedAt: 1,
    text: 'note',
    color: '#FEF08A',
    fontSize: 16,
    textAlign: 'left',
  }) as BoardObject

beforeEach(() => {
  boardStore.getState().setReadOnly(false)
  boardStore.getState().loadObjects([])
  history.clear()
})

afterEach(() => {
  cleanup()
  boardStore.getState().setReadOnly(false)
})

describe('viewer mode', () => {
  it('replaces the toolbar with the View only badge', () => {
    boardStore.getState().setReadOnly(true)
    render(<Toolbar />)
    expect(screen.queryByTestId('toolbar')).toBeNull()
    expect(screen.getByTestId('view-only-badge').textContent).toContain(guest.viewOnly)
  })

  it('shows the toolbar again when promoted', () => {
    boardStore.getState().setReadOnly(true)
    boardStore.getState().setReadOnly(false)
    render(<Toolbar />)
    expect(screen.getByTestId('toolbar')).toBeTruthy()
  })

  it('refuses every local change at the commit backstop', () => {
    boardStore.getState().loadObjects([sticky()])
    boardStore.getState().setReadOnly(true)

    expect(applyAndEmit(createOps([{ ...sticky(), id: 'x' as ObjectId }]), 'Draw')).toBe(
      false,
    )
    expect(applyAndEmit(deleteOps([sticky().id as ObjectId]), 'Delete')).toBe(false)
    expect(boardStore.getState().objects.size).toBe(1)
    expect(history.canUndo()).toBe(false)
  })

  it('makes undo inert, so a demoted editor cannot write through history', () => {
    applyAndEmit(createOps([sticky()]), 'Draw')
    expect(boardStore.getState().objects.size).toBe(1)

    boardStore.getState().setReadOnly(true)
    history.undo()
    expect(boardStore.getState().objects.size).toBe(1)
  })

  it('cancels an in-progress gesture when demoted live — FLOWS §9.5', () => {
    boardStore.getState().loadObjects([sticky()])
    boardStore.getState().setInteraction({ type: 'DRAGGING' } as never)
    boardStore.getState().setSelection([sticky().id as ObjectId])

    boardStore.getState().setReadOnly(true)
    expect(boardStore.getState().interaction.type).toBe('IDLE')
    expect(boardStore.getState().selection).toEqual([])
  })
})
