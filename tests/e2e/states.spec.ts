import { expect, test } from '@playwright/test'
import {
  connected,
  createBoard,
  drawStroke,
  register,
  signIn,
} from './support/realtime.js'

/**
 * Phase 14 — system states. E-21 (never a spinner forever) and S-19 as an
 * overlay on the frozen canvas (FLOWS §12.3).
 */

test.describe.configure({ mode: 'serial' })
let email: string | null = null

test.beforeEach(async ({ page }) => {
  email ??= await register(page)
  await signIn(page, email)
})

test('E-21: a board load that never answers gives up at 30 s with an inline retry', async ({
  page,
}) => {
  test.setTimeout(90_000)
  const boardId = await createBoard(page, 'Slow board')

  // The snapshot hangs, as on a dead 3G link.
  let release = false
  await page.route('**/snapshot', async route => {
    while (!release) await new Promise(r => setTimeout(r, 200))
    await route.continue()
  })

  const started = Date.now()
  await page.goto(`/board/${boardId}`)
  await expect(page.getByTestId('board-error')).toBeVisible({ timeout: 40_000 })
  const waited = Date.now() - started
  expect(waited).toBeGreaterThan(29_000)
  expect(waited).toBeLessThan(40_000)

  // Retry, now that the network is back: the board opens.
  release = true
  await page.getByRole('button', { name: 'Retry' }).click()
  await connected(page)
})

test('S-19 is an overlay on the frozen canvas, not a blank page', async ({ page }) => {
  const boardId = await createBoard(page, 'Doomed board')
  await page.goto(`/board/${boardId}`)
  await connected(page)
  await drawStroke(page, 400, 300)

  // Deleted from another tab of the same owner.
  const other = await page.context().newPage()
  await other.goto('/dashboard')
  await other.evaluate(async id => {
    const refresh = await navigator.locks.request('coboard:auth-refresh', () =>
      fetch('/api/auth/refresh', { method: 'POST', credentials: 'include' }),
    )
    const { accessToken } = (await refresh.json()) as { accessToken: string }
    await fetch(`/api/boards/${id}`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${accessToken}` },
    })
  }, boardId)

  await expect(page.getByTestId('board-deleted-live')).toBeVisible({ timeout: 10_000 })
  // The board is still there underneath, frozen: same objects, no toolbar.
  await expect(page.getByTestId('canvas-surface')).toHaveAttribute(
    'aria-label',
    'Whiteboard with 1 objects',
  )
  await expect(page.getByTestId('toolbar')).toHaveCount(0)
})
