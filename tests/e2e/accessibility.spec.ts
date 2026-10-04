import AxeBuilder from '@axe-core/playwright'
import { expect, test, type Page } from '@playwright/test'
import { stubSession } from './support/session.js'

/**
 * Accessibility — PRD §7.6, rules R-A11Y-*, Phase 14e.
 *
 * axe-core against every route at WCAG 2.1 AA, zero violations. The canvas
 * itself is a single labelled surface (TRD §7); axe sees it as one element
 * with an accessible name, which is all it can judge.
 */

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

async function stubApi(page: Page) {
  await stubSession(page)
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
  await page.route('**/api/share/a11y-token', route =>
    route.fulfill({
      json: {
        boardId: BOARD.id,
        boardName: BOARD.name,
        ownerName: 'Priya Raman',
        role: 'EDITOR',
        activeCount: 2,
        present: [
          { name: 'Marcus Lee', colour: '#3B82F6' },
          { name: 'Ana Souza', colour: '#EC4899' },
        ],
      },
    }),
  )
}

async function expectNoViolations(page: Page) {
  // Let entrance transitions settle first: axe measures contrast on what is
  // painted, and a CTA caught mid-fade reads as a contrast failure it is not.
  // Infinite and scroll-driven animations are excluded — they never end.
  await page.waitForFunction(() =>
    document.getAnimations().every(
      a =>
        a.playState !== 'running' ||
        a.effect?.getTiming().iterations === Infinity ||
        // Scroll-driven (the landing word reveal) follows the scroll
        // position, not the clock: it is never "finished".
        !(a.timeline instanceof DocumentTimeline),
    ),
  )
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze()
  const summary = results.violations.map(
    v =>
      `${v.id} (${v.impact}): ${v.nodes.map(n => `${n.target.join(' ')} ${n.any[0]?.message ?? ''}`).join(' | ')}`,
  )
  expect(summary, 'axe violations').toEqual([])
}

const PUBLIC = [
  { path: '/', ready: 'h1' },
  { path: '/demo', ready: '[data-testid="demo-bar"]' },
  { path: '/login', ready: 'form' },
  { path: '/signup', ready: 'form' },
  { path: '/forgot-password', ready: 'form' },
  { path: '/reset-password?token=abc', ready: 'main' },
]

for (const { path, ready } of PUBLIC) {
  test(`axe: ${path}`, async ({ page }) => {
    await page.goto(path)
    await expect(page.locator(ready).first()).toBeVisible()
    await expectNoViolations(page)
  })
}

const SIGNED_IN = [
  { path: '/dashboard', ready: () => `text=${BOARD.name}` },
  { path: '/trash', ready: () => `text=${BOARD.name}` },
  { path: '/settings', ready: () => 'main' },
]

for (const { path, ready } of SIGNED_IN) {
  test(`axe: ${path}`, async ({ page }) => {
    await stubApi(page)
    await page.goto(path)
    await expect(page.locator(ready()).first()).toBeVisible()
    await expectNoViolations(page)
  })
}

test('axe: board, with the shortcuts modal open', async ({ page }) => {
  await stubSession(page)
  await page.goto('/board/e2e')
  await expect(page.getByTestId('canvas-surface')).toHaveAttribute('data-ready', 'true')
  await expectNoViolations(page)
  await page.getByTestId('shortcuts-button').click()
  await expect(page.getByRole('dialog')).toBeVisible()
  await expectNoViolations(page)
})

test('axe: guest join card', async ({ page }) => {
  await stubApi(page)
  await page.goto('/join/a11y-token')
  await expect(page.getByTestId('join-name')).toBeVisible()
  await expectNoViolations(page)
})
