import { expect, test } from '@playwright/test'

/**
 * Phase 1 smoke test.
 *
 * Deliberately minimal: it proves the app boots, the PRD §15 tokens are
 * actually applied in the browser, and the Playwright two-context setup that
 * Phase 11's convergence harness depends on is working.
 */

test('app boots and renders', async ({ page }) => {
  await page.goto('/')
  await expect(page.getByRole('heading', { name: 'CoBoard', level: 1 })).toBeVisible()
})

test('PRD §15 accent token is applied in the browser', async ({ page }) => {
  await page.goto('/')
  const swatch = page.locator('.bg-accent').first()
  await expect(swatch).toBeVisible()
  // #4F46E5 — conflict C-7. If this is teal, someone pasted the generator output.
  await expect(swatch).toHaveCSS('background-color', 'rgb(79, 70, 229)')
})

test('two independent browser contexts can load the app', async ({ browser }) => {
  // Phase 11's convergence test drives two contexts through 200 random
  // operations and asserts matching state hashes. Prove the plumbing now.
  const a = await browser.newContext()
  const b = await browser.newContext()
  const pageA = await a.newPage()
  const pageB = await b.newPage()

  await Promise.all([pageA.goto('/'), pageB.goto('/')])
  await expect(pageA.getByRole('heading', { level: 1 })).toBeVisible()
  await expect(pageB.getByRole('heading', { level: 1 })).toBeVisible()

  await a.close()
  await b.close()
})
