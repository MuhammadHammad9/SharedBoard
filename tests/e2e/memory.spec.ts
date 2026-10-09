import { expect, test, type CDPSession, type Page } from '@playwright/test'

/**
 * Memory soak — TRD §12.3, PRD §7.1 (≤ 300 MB at 5,000 objects), Phase 15c.
 *
 * "Open a board, use it for 30 minutes, heap snapshot, close and reopen 10
 * times, force GC, snapshot again. Growth should be near zero."
 *
 * The board is used for SOAK_MINUTES (default 3, so CI can afford it; run
 * `SOAK_MINUTES=30` for the full protocol) — drawing, moving, undo/redo, pan
 * and zoom, the shortcuts modal — then closed and reopened ten times through
 * the app's own navigation. A `page.goto` would reload the document and
 * reset the heap, which is exactly the leak this test exists to see.
 *
 * Heap readings come from CDP after `HeapProfiler.collectGarbage`, so a
 * number is live objects, not garbage the collector has not reached yet.
 * The first reopen is the baseline: it warms every lazy chunk and cache, and
 * growth is judged across the nine that follow.
 */

const SOAK_MS = Number(process.env.SOAK_MINUTES ?? 3) * 60_000
/** Growth allowed across nine reopen cycles once warm. "Near zero." */
const GROWTH_CEILING_MB = 3
const password = 'correct-horse-1'

async function heapMB(cdp: CDPSession): Promise<number> {
  await cdp.send('HeapProfiler.collectGarbage')
  await cdp.send('HeapProfiler.collectGarbage')
  const { usedSize } = (await cdp.send('Runtime.getHeapUsage')) as { usedSize: number }
  return usedSize / 1024 / 1024
}

async function signUpAndCreateBoard(page: Page): Promise<string> {
  const email = `soak.${Date.now()}.${Math.random().toString(36).slice(2, 8)}@example.com`
  await page.goto('/login')
  return page.evaluate(
    async ({ email, password }) => {
      const reg = await fetch('/api/auth/register', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ email, password, displayName: 'Rafael Ortiz' }),
      })
      const { accessToken } = (await reg.json()) as { accessToken: string }
      const created = await fetch('/api/boards', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${accessToken}`,
        },
        credentials: 'include',
        body: JSON.stringify({ name: 'Sprint 42 planning' }),
      })
      const { board } = (await created.json()) as { board: { id: string } }
      return board.id
    },
    { email, password },
  )
}

async function surface(page: Page) {
  await expect(page.getByTestId('canvas-surface')).toHaveAttribute('data-ready', 'true')
  return (await page.getByTestId('canvas-surface').boundingBox())!
}

/** One pass of ordinary use. */
async function useBoard(page: Page, round: number) {
  const box = await surface(page)
  const x = box.x + 200 + (round % 6) * 70
  const y = box.y + 180 + (round % 4) * 60

  await page.getByTestId('tool-pen').click()
  await page.mouse.move(x, y)
  await page.mouse.down()
  for (let i = 1; i <= 8; i++) await page.mouse.move(x + i * 9, y + Math.sin(i) * 14)
  await page.mouse.up()

  await page.keyboard.press('r')
  await page.mouse.move(x, y + 120)
  await page.mouse.down()
  await page.mouse.move(x + 80, y + 180, { steps: 4 })
  await page.mouse.up()

  await page.getByTestId('tool-select').click()
  await page.mouse.move(x + 40, y + 150)
  await page.mouse.down()
  await page.mouse.move(x + 90, y + 170, { steps: 4 })
  await page.mouse.up()

  await page.keyboard.press('ControlOrMeta+z')
  await page.keyboard.press('ControlOrMeta+Shift+z')

  // Pan and zoom.
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await page.mouse.down({ button: 'middle' })
  await page.mouse.move(box.x + box.width / 2 + 60, box.y + box.height / 2 + 30, {
    steps: 4,
  })
  await page.mouse.up({ button: 'middle' })
  await page.mouse.wheel(0, round % 2 ? -200 : 200)

  // A modal, opened and closed.
  await page.keyboard.press('Shift+Slash')
  await expect(page.getByTestId('shortcuts-modal')).toBeVisible()
  await page.keyboard.press('Escape')
}

test('heap growth is near zero across ten close-and-reopen cycles — TRD §12.3', async ({
  page,
}) => {
  test.setTimeout(SOAK_MS + 5 * 60_000)
  const boardId = await signUpAndCreateBoard(page)
  const cdp = await page.context().newCDPSession(page)

  await page.goto(`/board/${boardId}`)
  await surface(page)

  // Use it.
  const until = Date.now() + SOAK_MS
  let round = 0
  while (Date.now() < until) await useBoard(page, round++)
  const afterUse = await heapMB(cdp)

  // Close and reopen ten times, through the app.
  const readings: number[] = []
  for (let cycle = 0; cycle < 10; cycle++) {
    await page.getByTestId('board-back').click()
    await expect(page).toHaveURL(/\/dashboard$/)
    await page.getByTestId('board-card').first().click()
    await expect(page).toHaveURL(new RegExp(`/board/${boardId}`))
    await surface(page)
    readings.push(await heapMB(cdp))
  }

  // Exactly the three canvas layers (FLOWS §14.3; the grid layer is P2 and
  // unbuilt): an unmounted board left no canvas behind.
  expect(await page.locator('canvas').count()).toBe(3)

  const growth = readings.at(-1)! - readings[0]!
  console.log(
    `[memory] ${round} rounds of use over ${(SOAK_MS / 60_000).toFixed(0)} min → ${afterUse.toFixed(1)} MB; ` +
      `reopen cycles ${readings.map(r => r.toFixed(1)).join(' → ')} MB; growth ${growth.toFixed(2)} MB`,
  )
  expect(afterUse, 'heap under the PRD §7.1 ceiling').toBeLessThan(300)
  expect(growth, 'growth across nine warm reopen cycles').toBeLessThan(GROWTH_CEILING_MB)
})
