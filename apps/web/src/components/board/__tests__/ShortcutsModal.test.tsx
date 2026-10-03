/**
 * @vitest-environment happy-dom
 *
 * S-15 — every row of PRD Appendix A.
 */

import { afterEach, describe, expect, it } from 'vitest'
import { act, cleanup, render, screen } from '@testing-library/react'
import { ShortcutsModal } from '../ShortcutsModal.js'
import { openShortcuts, useShortcutsStore } from '../shortcutsStore.js'
import { shortcuts } from '../../../lib/strings.js'

afterEach(() => {
  cleanup()
  useShortcutsStore.setState({ open: false })
})

describe('ShortcutsModal', () => {
  it('lists all 32 Appendix A shortcuts with their actions and the rule', () => {
    render(<ShortcutsModal />)
    act(() => openShortcuts())
    const modal = screen.getByTestId('shortcuts-modal')
    expect(modal.querySelectorAll('tbody tr')).toHaveLength(32)
    for (const [, action] of shortcuts.rows) expect(modal.textContent).toContain(action)
    expect(modal.textContent).toContain(shortcuts.rule)
  })
})
