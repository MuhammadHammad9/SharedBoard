/**
 * @vitest-environment happy-dom
 *
 * S-21 — FLOWS §12.4.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { ErrorBoundary } from '../ErrorBoundary.js'
import { actions, states } from '../../../lib/strings.js'

function Boom(): never {
  throw new Error('renderer exploded')
}

let fetchMock: ReturnType<typeof vi.fn>

beforeEach(() => {
  fetchMock = vi.fn(async () => new Response(null, { status: 204 }))
  vi.stubGlobal('fetch', fetchMock)
  // React logs caught render errors; they are expected here.
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('ErrorBoundary', () => {
  it('shows the S-21 copy, both actions, and ONLY a short Ref — never the error', () => {
    render(
      <ErrorBoundary variant="app">
        <Boom />
      </ErrorBoundary>,
    )
    const screenEl = screen.getByTestId('error-boundary')
    expect(screenEl.textContent).toContain(states.errorBoundary.headline)
    expect(screenEl.textContent).toContain(states.errorBoundary.body)
    expect(screen.getByText(actions.reloadPage)).toBeTruthy()
    expect(screen.getByText(actions.backToDashboard)).toBeTruthy()
    expect(screen.getByTestId('error-ref').textContent).toMatch(/^Ref: [0-9a-f]{8}$/)
    // PRD §8.1: no internal detail on screen.
    expect(screenEl.textContent).not.toContain('renderer exploded')
  })

  it('reports the full error under the same id it shows', () => {
    render(
      <ErrorBoundary variant="canvas">
        <Boom />
      </ErrorBoundary>,
    )
    const shown = screen.getByTestId('error-ref').textContent!.replace('Ref: ', '')
    const [url, init] = fetchMock.mock.calls[0]!
    expect(url).toBe('/api/client-errors')
    const body = JSON.parse((init as RequestInit).body as string)
    expect(body).toMatchObject({
      correlationId: shown,
      message: 'renderer exploded',
      source: 'canvas-boundary',
      component: 'Boom',
    })
    expect(body.componentStack).toContain('Boom')
  })

  it('the canvas boundary contains the crash — siblings keep rendering', () => {
    render(
      <div>
        <header data-testid="header">Board header</header>
        <ErrorBoundary variant="canvas">
          <Boom />
        </ErrorBoundary>
      </div>,
    )
    expect(screen.getByTestId('header')).toBeTruthy()
    expect(screen.getByTestId('canvas-error-boundary')).toBeTruthy()
  })
})
