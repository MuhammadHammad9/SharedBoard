import { expect, test, type Page } from '@playwright/test'

/**
 * Canvas performance — PRD G-3, §7.1, rule R-PERF-025.
 *
 * Drives a scripted pan across the committed 10,000-object stress board and
 * reads the renderer's own frame-time ring buffer. Using the renderer's
 * instrumentation rather than a separate timer means the number reported here
 * is the same one the debug overlay shows — there is no second measurement
 * path that could drift from reality.
 *
 * ASSERTION POLICY, agreed with the project owner:
 *   - The real p50/p95 are ALWAYS printed, so the number is in the CI log.
 *   - CI asserts only a loose floor (p95 < 33 ms ≈ 30 fps). GitHub runners are
 *     shared and variable; asserting the full 55 fps target here would produce
 *     intermittent red builds unrelated to real regressions.
 *   - The ≥55 fps target from PRD G-3 is judged from the figure measured on a
 *     real machine and recorded in the PR.
 * The loose floor still catches a catastrophic regression, which is what an
 * automated gate is actually good at.
 */

const CI_P95_CEILING_MS = 33
const STRESS_BOARD = '/?stress=1&debug=1'

interface Metrics {
  p50: number
  p95: number
  last: number
  count: number
  painted: number
}

async function readMetrics(page: Page): Promise<Metrics> {
  return page.evaluate(() => {
    const fn = (window as unknown as { __coboardMetrics?: () => Metrics }).__coboardMetrics
    if (!fn) throw new Error('__coboardMetrics not exposed — is this a dev/test build?')
    return fn()
  })
}

async function resetMetrics(page: Page): Promise<void> {
  await page.evaluate(() => {
    ;(window as unknown as { __coboardResetMetrics?: () => void }).__coboardResetMetrics?.()
  })
}

test('pans the 10,000-object stress board within the frame budget', async ({ page }) => {
  test.slow() // fixture is ~5.5 MB; give it room on a cold runner

  await page.goto(STRESS_BOARD)
  await expect(page.getByTestId('canvas-surface')).toHaveAttribute('data-ready', 'true')

  // Wait for the fixture to land — the object count in the overlay proves it.
  await expect(page.getByTestId('dbg-objects')).toContainText('/ 10000', { timeout: 30_000 })

  const box = (await page.getByTestId('canvas-surface').boundingBox())!

  // Discard load-time frames; measure steady-state panning only.
  await resetMetrics(page)

  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await page.mouse.down({ button: 'middle' })
  for (let i = 0; i < 60; i++) {
    await page.mouse.move(
      box.x + box.width / 2 + Math.sin(i / 6) * 220,
      box.y + box.height / 2 + Math.cos(i / 9) * 160,
    )
  }
  await page.mouse.up({ button: 'middle' })

  const m = await readMetrics(page)

  // Always report, pass or fail. This line is the deliverable.
  console.log(
    `[perf] stress board pan — p50 ${m.p50.toFixed(2)}ms (~${(1000 / Math.max(m.p50, 0.01)).toFixed(0)}fps), ` +
      `p95 ${m.p95.toFixed(2)}ms, frames ${m.count}, painted ${m.painted}`,
  )

  expect(m.count, 'renderer painted frames during the pan').toBeGreaterThan(10)
  expect(m.p95, `p95 frame time ${m.p95.toFixed(2)}ms exceeded the CI floor`).toBeLessThan(
    CI_P95_CEILING_MS,
  )
})

test('culls off-screen objects rather than drawing all 10,000', async ({ page }) => {
  test.slow()

  await page.goto(STRESS_BOARD)
  await expect(page.getByTestId('dbg-objects')).toContainText('/ 10000', { timeout: 30_000 })

  const text = (await page.getByTestId('dbg-objects').textContent()) ?? ''
  const visible = Number.parseInt(text.split('/')[0]!.trim(), 10)

  console.log(`[perf] visible at 100% zoom: ${visible} of 10000`)

  // The fixture spreads objects over ±12,000 canvas units, so a default
  // viewport should see a small fraction. If culling regressed to a no-op this
  // would be 10,000.
  expect(visible).toBeGreaterThan(0)
  expect(visible).toBeLessThan(3_000)
})
