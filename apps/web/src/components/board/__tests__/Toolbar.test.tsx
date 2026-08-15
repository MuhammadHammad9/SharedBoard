/**
 * @vitest-environment happy-dom
 *
 * Toolbar and properties panel — FLOWS §14.2, §14.4, R-STATE-005.
 *
 * The only DOM suite in the project so far. The environment is scoped
 * per-file rather than switched on globally: the geometry, renderer and sync
 * suites are pure logic, they run faster in `node`, and a DOM they never touch
 * is a DOM that can hide a missing guard.
 *
 * happy-dom rather than jsdom, and not by preference: jsdom 30 declares
 * `engines: ^22.22.2 || ^24.15.0 || >=26` and pulls `undici@8`, whose
 * `require('node:worker_threads').markAsUncloneable` is undefined on the
 * Node 20 LTS that TRD §1.1 pins and CI runs. It installs and passes on a
 * Node 22 dev machine, then dies in CI. happy-dom declares `>=20` and has no
 * undici dependency at all, so the whole class of problem goes away.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { PEN_COLOURS } from '@coboard/shared'
import { boardStore } from '../../../stores/boardStore.js'
import { PREFS_KEY } from '../../../lib/persist.js'
import { Toolbar } from '../Toolbar.js'
import { PropertiesPanel } from '../PropertiesPanel.js'

function Board() {
  return (
    <>
      <Toolbar />
      <PropertiesPanel />
    </>
  )
}

beforeEach(() => {
  localStorage.clear()
  boardStore.setState({
    activeTool: 'select',
    pen: { color: PEN_COLOURS[0], strokeWidth: 3, opacity: 1 },
    interaction: { type: 'IDLE' },
  })
})

afterEach(cleanup)

describe('Toolbar — FLOWS §14.2', () => {
  it('renders all eleven tools in the specified order', () => {
    render(<Board />)
    const buttons = within(screen.getByRole('toolbar', { name: 'Tools' })).getAllByRole('button')
    expect(buttons.map(b => b.getAttribute('aria-label'))).toEqual([
      'Select',
      'Hand',
      'Pen',
      'Eraser',
      'Rectangle',
      'Ellipse',
      'Line',
      'Arrow',
      'Sticky note',
      'Text',
      'Image',
    ])
  })

  it('gives every icon-only button an accessible name — R-A11Y-002', () => {
    render(<Board />)
    for (const button of screen.getAllByRole('button')) {
      expect(button.getAttribute('aria-label')?.trim()).toBeTruthy()
    }
  })

  it('exposes the active tool through aria-pressed, not colour alone', () => {
    render(<Board />)
    // The ATTRIBUTE, not the IDL reflection — the attribute is what assistive
    // technology reads, and not every DOM implementation reflects it.
    expect(screen.getByRole('button', { name: 'Select' }).getAttribute('aria-pressed')).toBe('true')
    expect(screen.getByRole('button', { name: 'Pen' }).getAttribute('aria-pressed')).toBe('false')
  })

  it('disables the tools that have no implementation yet', () => {
    render(<Board />)
    const disabled = (name: string) =>
      (screen.getByRole('button', { name }) as HTMLButtonElement).disabled

    for (const name of ['Select', 'Hand', 'Pen']) expect(disabled(name)).toBe(false)
    for (const name of [
      'Eraser',
      'Rectangle',
      'Ellipse',
      'Line',
      'Arrow',
      'Sticky note',
      'Text',
      'Image',
    ]) {
      expect(disabled(name)).toBe(true)
    }
  })

  it('cannot activate a disabled tool by clicking it', async () => {
    const user = userEvent.setup()
    render(<Board />)
    await user.click(screen.getByRole('button', { name: 'Rectangle' }))
    expect(boardStore.getState().activeTool).toBe('select')
  })

  it('locks tool switching while an interaction is running — R-CANVAS-055', () => {
    boardStore.setState({ interaction: { type: 'DRAWING', pointerId: 1, opId: 'x' } })
    boardStore.setState({ activeTool: 'pen' })
    render(<Board />)
    // The active tool stays enabled so it never looks broken mid-stroke; every
    // other tool locks until the interaction returns to IDLE.
    expect((screen.getByRole('button', { name: 'Pen' }) as HTMLButtonElement).disabled).toBe(false)
    expect((screen.getByRole('button', { name: 'Hand' }) as HTMLButtonElement).disabled).toBe(true)
    expect((screen.getByRole('button', { name: 'Select' }) as HTMLButtonElement).disabled).toBe(
      true,
    )
  })
})

describe('Tooltips', () => {
  it('shows the tool name and its shortcut on keyboard focus', async () => {
    const user = userEvent.setup()
    render(<Board />)

    // Keyboard focus is the only route by which a keyboard user can discover
    // a shortcut key, so it must show the tooltip — not just hover.
    await user.tab()
    const tip = await screen.findByRole('tooltip')
    expect(tip.textContent).toContain('Select')
    expect(tip.textContent).toContain('V')
  })

  it('links the tooltip to its trigger with aria-describedby', async () => {
    const user = userEvent.setup()
    render(<Board />)

    await user.tab()
    const tip = await screen.findByRole('tooltip')
    const describedBy = screen
      .getByRole('button', { name: 'Select' })
      .closest('[aria-describedby]')
    expect(describedBy?.getAttribute('aria-describedby')).toBe(tip.id)
  })

  it('opens adjacent tooltips instantly once one is already open', async () => {
    const user = userEvent.setup()
    render(<Board />)

    await user.tab()
    await screen.findByRole('tooltip')
    await user.tab()

    // data-instant is what suppresses the transition. Replaying a 125 ms fade
    // per button as the pointer sweeps eleven tools is noise, not polish.
    const tip = await screen.findByRole('tooltip')
    expect(tip.getAttribute('data-instant')).toBe('true')
  })
})

describe('PropertiesPanel — FLOWS §14.4', () => {
  it('is hidden entirely for the select tool with nothing selected', () => {
    render(<Board />)
    expect(screen.queryByTestId('properties-panel')).toBeNull()
  })

  it('swaps to the pen context when the pen is chosen', async () => {
    const user = userEvent.setup()
    render(<Board />)

    await user.click(screen.getByRole('button', { name: 'Pen' }))

    const panel = screen.getByTestId('properties-panel')
    expect(panel.getAttribute('data-context')).toBe('pen')
    expect(within(panel).getByTestId('pen-properties')).toBeTruthy()
  })

  it('offers the ten frozen pen colours plus a custom input', async () => {
    const user = userEvent.setup()
    render(<Board />)
    await user.click(screen.getByRole('button', { name: 'Pen' }))

    const group = screen.getByRole('group', { name: 'Pen colour' })
    expect(within(group).getAllByRole('button')).toHaveLength(PEN_COLOURS.length)
    expect(screen.getByLabelText('Custom pen colour')).toBeTruthy()
  })

  it('marks the selected colour with aria-pressed, not colour alone', async () => {
    const user = userEvent.setup()
    render(<Board />)
    await user.click(screen.getByRole('button', { name: 'Pen' }))

    const red = screen.getByRole('button', { name: `Colour ${PEN_COLOURS[2]}` })
    await user.click(red)

    expect(boardStore.getState().pen.color).toBe(PEN_COLOURS[2])
    expect(
      screen.getByRole('button', { name: `Colour ${PEN_COLOURS[2]}` }).getAttribute('aria-pressed'),
    ).toBe('true')
  })

  it('binds the thickness presets and the slider to the same value', async () => {
    const user = userEvent.setup()
    render(<Board />)
    await user.click(screen.getByRole('button', { name: 'Pen' }))

    await user.click(screen.getByRole('button', { name: 'Thickness 12 pixels' }))
    expect(boardStore.getState().pen.strokeWidth).toBe(12)
    expect((screen.getByTestId('pen-width-slider') as HTMLInputElement).value).toBe('12')
  })
})

describe('R-STATE-005 — the tool choice survives a refresh', () => {
  it('writes the tool and pen settings to localStorage', async () => {
    const user = userEvent.setup()
    render(<Board />)

    await user.click(screen.getByRole('button', { name: 'Pen' }))
    await user.click(screen.getByRole('button', { name: 'Thickness 6 pixels' }))

    const stored = JSON.parse(localStorage.getItem(PREFS_KEY)!)
    expect(stored.activeTool).toBe('pen')
    expect(stored.pen.strokeWidth).toBe(6)
  })
})
