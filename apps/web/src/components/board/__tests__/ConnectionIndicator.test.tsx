/**
 * @vitest-environment happy-dom
 *
 * The connection indicator and the offline banner — FR-RT-009, FLOWS §9.4,
 * P11-T9/T10.
 *
 * The copy is asserted against strings.ts rather than retyped, so a test
 * cannot pass by agreeing with a typo (R-UI-052).
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { OFFLINE_WARNING_MS, OUTBOX_WARNING_THRESHOLD } from '@coboard/shared'
import { actions, errors, presence } from '../../../lib/strings.js'
import { ConnectionIndicator, describeConnection } from '../ConnectionIndicator.js'
import { OfflineBanner, shouldWarnOffline } from '../OfflineBanner.js'

afterEach(cleanup)

describe('ConnectionIndicator — five visible states', () => {
  it('connected is a green dot with no visible text, but an accessible label', () => {
    render(<ConnectionIndicator state="connected" />)
    const el = screen.getByTestId('connection-indicator')
    expect(el.dataset.tone).toBe('success')
    expect(screen.queryByTestId('connection-label')).toBeNull()
    expect(el.textContent).toContain('Connected')
  })

  it('connecting is amber, with text', () => {
    expect(describeConnection('connecting')).toMatchObject({
      tone: 'warning',
      label: 'Connecting…',
    })
  })

  it('reconnecting names the attempt', () => {
    render(<ConnectionIndicator state="reconnecting" attempt={3} />)
    expect(screen.getByTestId('connection-label').textContent).toBe(
      errors.reconnecting(3),
    )
  })

  it('syncing is blue and counts the changes', () => {
    render(<ConnectionIndicator state="syncing" pending={12} />)
    expect(screen.getByTestId('connection-indicator').dataset.tone).toBe('accent')
    expect(screen.getByTestId('connection-label').textContent).toBe(errors.syncing(12))
  })

  it('syncing with nothing to send reads as connecting, not "Syncing 0 changes…"', () => {
    expect(describeConnection('syncing', 0, 0).label).toBe('Connecting…')
  })

  it('offline is red, says the work is safe, and offers "Retry now"', async () => {
    const onRetry = vi.fn()
    render(<ConnectionIndicator state="offline" onRetry={onRetry} />)
    expect(screen.getByTestId('connection-indicator').dataset.tone).toBe('danger')
    expect(screen.getByTestId('connection-label').textContent).toBe(errors.disconnected)

    const retry = screen.getByRole('button', { name: actions.retryNow })
    await userEvent.click(retry)
    expect(onRetry).toHaveBeenCalledTimes(1)
  })

  it('offers "Retry now" only when offline', () => {
    render(<ConnectionIndicator state="reconnecting" attempt={1} onRetry={() => {}} />)
    expect(screen.queryByTestId('connection-retry')).toBeNull()
  })

  it('is a polite live region, so a drop is announced', () => {
    render(<ConnectionIndicator state="connected" />)
    const el = screen.getByRole('status')
    expect(el.getAttribute('aria-live')).toBe('polite')
  })
})

describe('OfflineBanner — 500 changes or 10 minutes', () => {
  it('warns on either threshold, and not before', () => {
    expect(shouldWarnOffline(0, 0)).toBe(false)
    expect(shouldWarnOffline(OFFLINE_WARNING_MS - 1, OUTBOX_WARNING_THRESHOLD - 1)).toBe(
      false,
    )
    expect(shouldWarnOffline(OFFLINE_WARNING_MS, 0)).toBe(true)
    expect(shouldWarnOffline(0, OUTBOX_WARNING_THRESHOLD)).toBe(true)
  })

  it('shows the PRD copy while down with a big backlog', () => {
    render(<OfflineBanner state="offline" pending={OUTBOX_WARNING_THRESHOLD} />)
    expect(screen.getByTestId('offline-banner').textContent).toBe(presence.offlineAWhile)
  })

  it('stays hidden while connected, whatever the backlog', () => {
    render(<OfflineBanner state="connected" pending={10_000} />)
    expect(screen.queryByTestId('offline-banner')).toBeNull()
  })

  it('appears after ten minutes down even with nothing queued', () => {
    let t = 0
    const now = () => t
    const { rerender } = render(
      <OfflineBanner state="reconnecting" pending={0} now={now} />,
    )
    expect(screen.queryByTestId('offline-banner')).toBeNull()
    t = OFFLINE_WARNING_MS
    rerender(<OfflineBanner state="offline" pending={1} now={now} />)
    expect(screen.getByTestId('offline-banner')).toBeTruthy()
  })
})
