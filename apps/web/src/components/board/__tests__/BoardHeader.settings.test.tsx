/**
 * @vitest-environment happy-dom
 *
 * FLOWS §1.2 "Title menu → Settings" — owner only (FR-SHARE-001).
 */

import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { Role } from '@coboard/shared'
import { BoardHeader } from '../BoardHeader.js'
import { boardSettings } from '../../../lib/strings.js'

function renderHeader(role: Role, demo = false) {
  render(
    <QueryClientProvider client={new QueryClient()}>
      <MemoryRouter>
        <BoardHeader
          boardId="11111111-1111-4111-8111-111111111111"
          name="Q3 Retro"
          role={role}
          connection="connected"
          demo={demo}
        />
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

afterEach(cleanup)

describe('board title menu → S-13', () => {
  it('the owner gets a ▾ menu whose Settings item opens the modal', () => {
    renderHeader('OWNER')
    fireEvent.click(screen.getByTestId('board-title-menu'))
    fireEvent.click(screen.getByTestId('board-settings-open'))
    expect(screen.getByRole('dialog', { name: boardSettings.title })).toBeTruthy()
  })

  it.each(['EDITOR', 'VIEWER'] as const)('a %s has no settings menu', role => {
    renderHeader(role)
    expect(screen.queryByTestId('board-title-menu')).toBeNull()
  })

  it('/demo has no settings — there is no server to save to', () => {
    renderHeader('OWNER', true)
    expect(screen.queryByTestId('board-title-menu')).toBeNull()
  })
})
