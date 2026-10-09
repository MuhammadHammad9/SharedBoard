import { expect, test, type Page } from '@playwright/test'

/**
 * PRD §7.1 budgets that need the real stack — Phase 15b.
 *
 *   Board first paint, 500 objects       ≤ 1.5 s
 *   Board first paint, 5,000 objects     ≤ 3.0 s
 *   Local input to remote render, p95    ≤ 250 ms
 *
 * First paint is the renderer's own `coboard:board-first-paint` mark (see
 * features/canvas/renderer/firstPaint.ts): the first layer-1 frame after the
 * document lands, timed from navigation start of a direct load.
 *
 * The remote-render measurement uses two contexts on one machine, so both
 * sides read the same clock: A's pointerup time from Node, B's arrival time
 * from an in-page rAF loop that stamps each new object on the frame it first
 * renders.
 */

const password = 'correct-horse-1'
test.describe.configure({ mode: 'serial' })
let account: { email: string } | null = null

async function register(page: Page) {
  const email = `budget.${Date.now()}.${Math.random().toString(36).slice(2, 8)}@example.com`
  await page.goto('/login')
  const status = await page.evaluate(
    async ({ email, password }) =>
      (
        await fetch('/api/auth/register', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({ email, password, displayName: 'Ana Souza' }),
        })
      ).status,
    { email, password },
  )
  expect(status).toBe(201)
  return { email }
}

async function signIn(page: Page, email: string) {
  await page.goto('/login')
  const status = await page.evaluate(
    async ({ email, password }) =>
      (
        await fetch('/api/auth/login', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({ email, password }),
        })
      ).status,
    { email, password },
  )
  expect(status).toBe(200)
}

/** A board holding `count` stickies, built through the real append path. */
async function boardWith(page: Page, count: number): Promise<string> {
  const result = await page.evaluate(async (count: number) => {
    const refresh = await fetch('/api/auth/refresh', {
      method: 'POST',
      credentials: 'include',
    })
    const { accessToken } = (await refresh.json()) as { accessToken: string }
    const headers = {
      'content-type': 'application/json',
      authorization: `Bearer ${accessToken}`,
    }
    const created = await fetch('/api/boards', {
      method: 'POST',
      headers,
      credentials: 'include',
      body: JSON.stringify({ name: `Budget ${count}` }),
    })
    if (!created.ok) return { error: `board ${created.status}` }
    const { board } = (await created.json()) as { board: { id: string } }
    const BATCH = 200
    for (let start = 0; start < count; start += BATCH) {
      const ops = Array.from({ length: Math.min(BATCH, count - start) }, (_, i) => {
        const n = start + i
        const objectId = crypto.randomUUID()
        return {
          id: crypto.randomUUID(),
          type: 'CREATE',
          objectId,
          payload: {
            id: objectId,
            type: 'sticky',
            x: (n % 50) * 220,
            y: Math.floor(n / 50) * 220,
            width: 200,
            height: 200,
            rotation: 0,
            zIndex: `a${n.toString(36).padStart(6, '0')}`,
            opacity: 1,
            createdBy: 'budget',
            createdAt: 1_760_000_000_000,
            updatedAt: 1_760_000_000_000,
            text: `Note ${n}`,
            color: '#FEF08A',
            fontSize: 16,
            textAlign: 'left',
          },
        }
      })
      const response = await fetch(`/api/boards/${board.id}/operations`, {
        method: 'POST',
        headers,
        credentials: 'include',
        body: JSON.stringify({ ops }),
      })
      if (!response.ok) return { error: `append ${response.status}` }
    }
    return { boardId: board.id }
  }, count)
  expect(result.error).toBeUndefined()
  return result.boardId!
}

async function firstPaintMs(page: Page): Promise<number> {
  await page.waitForFunction(
    () => performance.getEntriesByName('coboard:board-first-paint').length > 0,
    undefined,
    { timeout: 20_000 },
  )
  return page.evaluate(
    () => performance.getEntriesByName('coboard:board-first-paint')[0]!.startTime,
  )
}

for (const [count, budget] of [
  [500, 1_500],
  [5_000, 3_000],
] as const) {
  test(`board first paint, ${count} objects, within ${budget} ms`, async ({ page }) => {
    test.slow()
    account ??= await register(page)
    await signIn(page, account.email)
    const boardId = await boardWith(page, count)

    // A direct load: a fresh document, so the mark is timed from navigation start.
    await page.goto('about:blank')
    await page.goto(`/board/${boardId}?debug=1`)
    const ms = await firstPaintMs(page)
    // The object hook exists in dev builds only; the production run (the one
    // the budget is judged on) relies on the mark, which follows the load.
    const loaded = await page.evaluate(() => {
      const hook = (window as unknown as { __coboardObjects?: () => unknown[] })
        .__coboardObjects
      return hook ? hook().length : null
    })
    console.log(
      `[perf] board first paint, ${count} objects — ${ms.toFixed(0)} ms (budget ${budget})`,
    )
    if (loaded !== null) expect(loaded).toBe(count)
    expect(ms).toBeLessThan(budget)
  })
}

test('local input to remote render, p95 within 250 ms', async ({ browser, page }) => {
  test.slow()
  account ??= await register(page)
  await signIn(page, account.email)
  const boardId = await boardWith(page, 0)

  const contextB = await browser.newContext()
  const b = await contextB.newPage()
  await signIn(b, account.email)
  await page.goto(`/board/${boardId}?debug=1`)
  await b.goto(`/board/${boardId}?debug=1`)
  for (const p of [page, b]) {
    await expect(p.getByTestId('canvas-surface')).toHaveAttribute('data-ready', 'true')
    await expect(p.getByTestId('connection-indicator')).toHaveAttribute(
      'data-state',
      'connected',
    )
  }

  /*
   * Needs the dev/test object hook, so it runs in the dev-server suite. That
   * path adds the Vite proxy hop on both legs, so it is the STRICTER of the
   * two measurements. A per-op production mark was rejected: marks accumulate
   * in the Performance timeline for the life of the tab — a leak by design.
   */
  const hooked = await b.evaluate(() => '__coboardObjects' in window)
  test.skip(!hooked, 'production build: no object hook; measured in the dev-server run')

  // B stamps each object on the first animation frame it exists.
  await b.evaluate(() => {
    const w = window as unknown as {
      __coboardObjects: () => { id: string }[]
      __arrivals: number[]
    }
    w.__arrivals = []
    const seen = new Set<string>()
    const tick = () => {
      for (const o of w.__coboardObjects()) {
        if (!seen.has(o.id)) {
          seen.add(o.id)
          w.__arrivals.push(Date.now())
        }
      }
      requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
  })

  await page.getByTestId('tool-pen').click()
  const box = (await page.getByTestId('canvas-surface').boundingBox())!
  const sent: number[] = []
  const STROKES = 20
  for (let i = 0; i < STROKES; i++) {
    const x = box.x + 200 + (i % 5) * 120
    const y = box.y + 200 + Math.floor(i / 5) * 90
    await page.mouse.move(x, y)
    await page.mouse.down()
    for (let s = 1; s <= 4; s++) await page.mouse.move(x + s * 12, y + s * 6)
    sent.push(Date.now())
    await page.mouse.up()
    // Let it land before the next, so each sample is one round trip.
    await expect
      .poll(() =>
        b.evaluate(
          () => (window as unknown as { __arrivals: number[] }).__arrivals.length,
        ),
      )
      .toBe(i + 1)
  }

  const arrivals = await b.evaluate(
    () => (window as unknown as { __arrivals: number[] }).__arrivals,
  )
  const latencies = arrivals.map((t, i) => t - sent[i]!).sort((x, y) => x - y)
  const p95 = latencies[Math.ceil(latencies.length * 0.95) - 1]!
  const p50 = latencies[Math.floor(latencies.length / 2)]!
  console.log(
    `[perf] local input to remote render — p50 ${p50} ms, p95 ${p95} ms (budget 250)`,
  )
  expect(p95).toBeLessThanOrEqual(250)
  await contextB.close()
})

test('the prerendered landing stays on `/` and hands over to the SPA', async ({
  page,
}) => {
  /*
   * On the production build, dist/index.html carries S-01's markup. It must
   * never show on another route (the inline guard), and once the app JS
   * loads after first paint, navigation must be client-side.
   */
  const errors: string[] = []
  page.on('pageerror', e => errors.push(e.message))
  await page.goto('/login')
  await expect(page.getByTestId('landing-demo')).toHaveCount(0)
  await page.goto('/')
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible()
  await page.waitForLoadState('networkidle')
  await page.evaluate(() => ((window as unknown as { __marker: number }).__marker = 1))
  await page.getByTestId('landing-login').click()
  await expect(page).toHaveURL(/\/login$/)
  expect(
    await page.evaluate(() => (window as unknown as { __marker?: number }).__marker),
  ).toBe(1)
  expect(errors).toEqual([])
})
