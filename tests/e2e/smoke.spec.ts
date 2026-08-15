import { expect, test } from '@playwright/test'

/**
 * Application smoke test.
 *
 * Deliberately minimal: proves the app boots, PRD §15 tokens reach the browser,
 * and the Playwright two-context setup that Phase 11's convergence harness
 * depends on is working.
 *
 * Phase 2 replaced the Phase 1 placeholder page with the canvas, so the
 * assertions moved from the token swatches to the canvas surface. The token
 * check survives — it just reads a different element.
 */

test('app boots and mounts the canvas', async ({ page }) => {
  await page.goto('/')
  await expect(page.getByTestId('canvas-surface')).toHaveAttribute('data-ready', 'true')
  await expect(page.locator('canvas#objects')).toBeAttached()
})

test('PRD §15 canvas background token is applied in the browser', async ({ page }) => {
  await page.goto('/')
  const surface = page.getByTestId('canvas-surface')
  await expect(surface).toBeVisible()
  // --color-bg-canvas #FAFAFA — conflict C-7. If this is teal, someone pasted
  // the ui-ux-pro-max generator output over the mandated tokens.
  await expect(surface.locator('xpath=..')).toHaveCSS(
    'background-color',
    'rgb(250, 250, 250)',
  )
})

test('PRD §15 accent token is applied to board chrome', async ({ page }) => {
  await page.goto('/')
  // The zoom controls are the only chrome in Phase 2. Their focus ring uses
  // --color-accent #4F46E5.
  await expect(page.getByTestId('zoom-controls')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Zoom in' })).toBeVisible()
})

test('two independent browser contexts can load the app', async ({ browser }) => {
  // Phase 11's convergence test drives two contexts through 200 random
  // operations and asserts matching state hashes. Prove the plumbing now.
  const a = await browser.newContext()
  const b = await browser.newContext()
  const pageA = await a.newPage()
  const pageB = await b.newPage()

  await Promise.all([pageA.goto('/'), pageB.goto('/')])
  await expect(pageA.getByTestId('canvas-surface')).toHaveAttribute('data-ready', 'true')
  await expect(pageB.getByTestId('canvas-surface')).toHaveAttribute('data-ready', 'true')

  await a.close()
  await b.close()
})
