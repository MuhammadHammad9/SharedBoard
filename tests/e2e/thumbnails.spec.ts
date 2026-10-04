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

async function expectThumbnail(card: import('@playwright/test').Locator) {
  const img = card.locator('img')
  await expect(img).toHaveAttribute('src', /\/thumbnails\/.+\.jpg$/, { timeout: 15_000 })
  // The picture really loads, at 640×400.
  await expect
    .poll(() => img.evaluate((el: HTMLImageElement) => el.complete && el.naturalWidth))
    .toBe(640)
  expect(await img.evaluate((el: HTMLImageElement) => el.naturalHeight)).toBe(400)
}

test('leaving a board through the app puts its picture on the dashboard card', async ({
  page,
}) => {
  const boardId = await createBoard(page, 'Thumbnail board')
  await page.goto(`/board/${boardId}`)
  await connected(page)
  await drawStroke(page, 400, 300)
  await drawStroke(page, 520, 360)

  // The in-app way back: the board unmounts (the session end), the upload
  // lands, and its success invalidates the list the dashboard is showing.
  await page.getByTestId('board-back').click()
  await expect(page).toHaveURL(/\/dashboard$/)
  await expectThumbnail(page.locator(`[data-board-id="${boardId}"]`))
})

test('leaving by full page navigation still uploads the picture', async ({ page }) => {
  /*
   * pagehide sends the upload with keepalive, but the NEW page's board list
   * can be fetched before that upload lands — and the cache invalidation ran
   * on the page that unloaded. That race is inherent to leaving by URL (it
   * was this suite's recurring flake under load). What must hold is that the
   * upload completes: the picture is there by the next load.
   */
  const boardId = await createBoard(page, 'Thumbnail board, hard exit')
  await page.goto(`/board/${boardId}`)
  await connected(page)
  await drawStroke(page, 400, 300)
  await page.goto('/dashboard')
  const card = page.locator(`[data-board-id="${boardId}"]`)
  await expect
    .poll(
      async () => {
        if ((await card.locator('img').count()) === 0) await page.reload()
        return card.locator('img').count()
      },
      { timeout: 20_000, intervals: [500, 1_000, 2_000] },
    )
    .toBe(1)
  await expectThumbnail(card)
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
