import { expect, test, type Page } from '@playwright/test'
import { stubSession } from './support/session.js'

/**
 * Responsive layout — PRD §7.7, FLOWS §14.5, Phase 14d.
 *
 * At each breakpoint (desktop ≥1280, laptop 1024–1279, tablet 768–1023,
 * mobile <768): no page scrolls sideways, and the toolbar takes the
 * layout that width specifies. The dashboard and trash run against stubbed
 * lists; what is under test is the layout, not the data.
 */

const WIDTHS = [
  { width: 1440, toolbar: 'left' },
  { width: 1100, toolbar: 'left' },
  { width: 900, toolbar: 'bottom' },
  { width: 390, toolbar: 'mobile' },
] as const

const BOARD = {
  id: '11111111-1111-4111-8111-111111111111',
  name: 'Q3 launch retro — product and design',
  ownerId: '00000000-0000-4000-8000-000000000001',
  thumbnailUrl: null,
  createdAt: '2026-09-01T09:00:00.000Z',
  updatedAt: '2026-09-30T16:20:00.000Z',
  deletedAt: null,
  role: 'OWNER',
}

async function stubLists(page: Page) {
  await page.route('**/api/boards/trash', route =>
    route.fulfill({
      json: {
        boards: [{ ...BOARD, deletedAt: '2026-10-01T10:00:00.000Z', daysUntilPurge: 28 }],
      },
    }),
  )
  await page.route(/\/api\/boards(\?.*)?$/, route =>
    route.fulfill({ json: { boards: [BOARD], nextCursor: null } }),
  )
}

async function expectNoHorizontalScroll(page: Page) {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  )
  expect(overflow, 'page scrolls horizontally').toBeLessThanOrEqual(0)
}

for (const { width, toolbar } of WIDTHS) {
  test.describe(`at ${width}px`, () => {
    test.use({ viewport: { width, height: 844 } })

    test('dashboard and trash do not scroll sideways', async ({ page }) => {
      await stubSession(page)
      await stubLists(page)
      await page.goto('/dashboard')
      await expect(page.getByText(BOARD.name).first()).toBeVisible()
      await expectNoHorizontalScroll(page)

      await page.goto('/trash')
      await expect(page.getByText(BOARD.name).first()).toBeVisible()
      await expectNoHorizontalScroll(page)
    })

    test(`board shows the ${toolbar} toolbar`, async ({ page }) => {
      await stubSession(page)
      await page.goto('/board/e2e')
      await expect(page.getByTestId('canvas-surface')).toHaveAttribute(
        'data-ready',
        'true',
      )
      await expect(page.getByTestId('toolbar')).toHaveAttribute('data-layout', toolbar)
      await expectNoHorizontalScroll(page)

      if (toolbar === 'mobile') {
        // FLOWS §14.5: the header's extra actions live behind `⋯`.
        await expect(page.getByTestId('shortcuts-button')).toHaveCount(0)
        await page.getByTestId('header-more').click()
        await expect(page.getByTestId('export-button')).toBeVisible()
        // The tools that do not fit the bar are one tap away.
        await page.getByTestId('tool-more').click()
        await expect(page.getByTestId('tool-sheet')).toBeVisible()
        await page.getByTestId('tool-rect').click()
        await expect(page.getByTestId('tool-sheet')).toHaveCount(0)
      } else {
        await expect(page.getByTestId('export-button')).toBeVisible()
      }
    })
  })
}
