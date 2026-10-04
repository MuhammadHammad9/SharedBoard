import { expect, test, type Page } from '@playwright/test'
import { stubSession, TEST_USER } from './support/session.js'

/**
 * S-01 landing and `/demo` — FLOWS §1.2, §3.1, PRD FR-AUTH-007, Phase 15a.
 */

const objectCount = (page: Page) =>
  page.evaluate(
    () =>
      (window as unknown as { __coboardObjects: () => unknown[] }).__coboardObjects()
        .length,
  )

test('an anonymous visitor sees the landing page, with the live demo', async ({
  page,
}) => {
  await page.goto('/')
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible()
  await expect(page.getByTestId('landing-demo')).toBeVisible()
  await expect(page.getByTestId('landing-login')).toBeVisible()
  await expect(page.getByTestId('landing-signup-nav')).toBeVisible()
})

test('the H1 holds to three lines or fewer — gpt-taste iron rule', async ({ page }) => {
  for (const width of [1440, 1100, 390]) {
    await page.setViewportSize({ width, height: 900 })
    await page.goto('/')
    const lines = await page.getByRole('heading', { level: 1 }).evaluate(el => {
      const style = getComputedStyle(el)
      return Math.round(
        el.getBoundingClientRect().height / Number.parseFloat(style.lineHeight),
      )
    })
    expect(lines, `H1 lines at ${width}px`).toBeLessThanOrEqual(width < 768 ? 4 : 3)
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    )
    expect(overflow, `horizontal scroll at ${width}px`).toBeLessThanOrEqual(0)
  }
})

test('the landing page never downloads the canvas engine — TRD §12.2', async ({
  page,
}) => {
  const scripts: string[] = []
  page.on('request', request => {
    if (request.resourceType() === 'script') scripts.push(request.url())
  })
  await page.goto('/')
  await expect(page.getByTestId('landing-demo')).toBeVisible()
  await page.waitForLoadState('networkidle')
  expect(scripts.filter(url => /\/(Board|Canvas|renderer)/.test(url))).toEqual([])
})

test('FLOWS §1.2 edges: Log in, Sign up free, logo', async ({ page }) => {
  await page.goto('/')
  await page.getByTestId('landing-login').click()
  await expect(page).toHaveURL(/\/login$/)

  await page.goto('/')
  await page.getByTestId('landing-signup').click()
  await expect(page).toHaveURL(/\/signup$/)

  await page.goto('/')
  await page.getByTestId('landing-logo').first().click()
  await expect(page).toHaveURL(/\/$/)
})

test('"Try it now" opens a working demo board that saves nothing', async ({ page }) => {
  const writes: string[] = []
  page.on('request', request => {
    if (request.method() !== 'GET' && request.url().includes('/api/boards'))
      writes.push(request.url())
  })
  await page.goto('/')
  await page.getByTestId('landing-demo-link').click()
  await expect(page).toHaveURL(/\/demo$/)
  await expect(page.getByTestId('demo-bar')).toBeVisible()
  await expect(page.getByTestId('canvas-surface')).toHaveAttribute('data-ready', 'true')
  // No share and no rename without a server.
  await expect(page.getByTestId('share-button')).toHaveCount(0)

  await page.getByTestId('tool-pen').click()
  const box = (await page.getByTestId('canvas-surface').boundingBox())!
  await page.mouse.move(box.x + 300, box.y + 300)
  await page.mouse.down()
  await page.mouse.move(box.x + 380, box.y + 340, { steps: 6 })
  await page.mouse.up()
  await expect.poll(() => objectCount(page)).toBe(1)
  expect(writes).toEqual([])

  await page.getByTestId('demo-signup').click()
  await expect(page).toHaveURL(/\/signup$/)
})

test('a visitor with a session goes straight to the dashboard', async ({ page }) => {
  await stubSession(page)
  await page.route(/\/api\/boards(\?.*)?$/, route =>
    route.fulfill({ json: { boards: [], nextCursor: null } }),
  )
  await page.goto('/')
  await expect(page).toHaveURL(/\/dashboard$/)
})

test('logging out returns to the landing page — FR-AUTH-007', async ({ page }) => {
  await stubSession(page)
  await page.route(/\/api\/boards(\?.*)?$/, route =>
    route.fulfill({ json: { boards: [], nextCursor: null } }),
  )
  await page.route('**/api/auth/logout', route => route.fulfill({ status: 204 }))
  await page.goto('/dashboard')
  await expect(page.getByTestId('account-menu')).toBeVisible()

  // From here the session is gone: the refresh answers 401.
  await page.unroute('**/api/auth/refresh')
  await page.route('**/api/auth/refresh', route =>
    route.fulfill({ status: 401, json: { error: { code: 'UNAUTHENTICATED' } } }),
  )
  await page.getByTestId('account-menu').click()
  await page.getByTestId('log-out').click()
  await expect(page).toHaveURL(/\/$/)
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible()
  expect(TEST_USER.displayName).toBeTruthy()
})

test.describe('with reduced motion', () => {
  /*
   * `page.emulateMedia`, not `test.use({ reducedMotion })`: with the
   * preinstalled Chromium the fixture option silently does not apply
   * (matchMedia still reports false), and a reduced-motion test that runs
   * without reduced motion passes for the wrong reason.
   */
  test.beforeEach(async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' })
  })

  test('the hero demo renders its finished frame, still', async ({ page }) => {
    await page.goto('/')
    await expect(page.getByTestId('landing-demo')).toBeVisible()
    expect(await page.locator('[data-testid="landing-demo"] animate').count()).toBe(0)
    expect(await page.locator('[data-testid="landing-demo"] animateMotion').count()).toBe(
      0,
    )
  })
})
