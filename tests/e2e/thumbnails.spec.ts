import { expect, test } from '@playwright/test'
import {
  connected,
  createBoard,
  drawStroke,
  register,
  signIn,
} from './support/realtime.js'

/**
 * Thumbnails — FR-BOARD-003, Phase 13 exit gate: "thumbnails appear on
 * dashboard cards". The real path: draw, leave the board (the session end),
 * the editor's client renders and uploads, the dashboard shows it.
 */

test.describe.configure({ mode: 'serial' })
let email: string | null = null

test.beforeEach(async ({ page }) => {
  email ??= await register(page)
  await signIn(page, email)
})

test('leaving a board you drew on puts its picture on the dashboard card', async ({
  page,
}) => {
  const boardId = await createBoard(page, 'Thumbnail board')
  await page.goto(`/board/${boardId}`)
  await connected(page)
  await drawStroke(page, 400, 300)
  await drawStroke(page, 520, 360)

  // The session ends here — unmount and pagehide both send it.
  await page.goto('/dashboard')
  const card = page.locator(`[data-board-id="${boardId}"]`)
  const img = card.locator('img')
  await expect(img).toHaveAttribute('src', /\/thumbnails\/.+\.jpg$/, { timeout: 15_000 })
  // The picture really loads, at 640×400.
  await expect
    .poll(() => img.evaluate((el: HTMLImageElement) => el.complete && el.naturalWidth))
    .toBe(640)
  expect(await img.evaluate((el: HTMLImageElement) => el.naturalHeight)).toBe(400)
})

test('an untouched empty board keeps the placeholder graphic', async ({ page }) => {
  const boardId = await createBoard(page, 'Still empty')
  await page.goto(`/board/${boardId}`)
  await connected(page)
  await page.goto('/dashboard')
  const card = page.locator(`[data-board-id="${boardId}"]`)
  await expect(card.getByTestId('thumb-placeholder')).toBeVisible()
  await expect(card.locator('img')).toHaveCount(0)
})
