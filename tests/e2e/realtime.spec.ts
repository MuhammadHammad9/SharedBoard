import { expect, test, type BrowserContext, type Page } from '@playwright/test'

/**
 * Two windows, live — AT-01 … AT-05, AT-40, AT-41. FR-RT-001/002/007.
 *
 * Phase 9's exit gate, and the first test in the project where the answer
 * depends on two clients agreeing. Everything runs against the real stack:
 * two browser contexts, a real WebSocket, a real Express gateway, a real
 * Postgres.
 *
 * The assertion style throughout is a STATE HASH rather than an object count.
 * "Both have three objects" is satisfied by two boards holding three different
 * objects; convergence means the documents are identical, and only comparing
 * the whole thing says so.
 */

const password = 'correct-horse-1'

/*
 * ONE account, shared. Registration is rate-limited per IP (R-SEC-013) and
 * every test here needs two authenticated contexts; a signup per context
 * spends the budget in one pass.
 */
test.describe.configure({ mode: 'serial' })

let account: { email: string } | null = null

async function register(page: Page): Promise<{ email: string }> {
  const email = `rt.${Date.now()}.${Math.random().toString(36).slice(2, 8)}@example.com`
  await page.goto('/login')
  const result = await page.evaluate(
    async ({ email, password }) => {
      const response = await fetch('/api/auth/register', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ email, password, displayName: 'Priya Raman' }),
      })
      return response.ok ? {} : { error: `register ${response.status}` }
    },
    { email, password },
  )
  expect(result.error, 'registration should succeed').toBeUndefined()
  return { email }
}

async function signIn(page: Page, email: string): Promise<void> {
  await page.goto('/login')
  const result = await page.evaluate(
    async ({ email, password }) => {
      const response = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ email, password }),
      })
      return response.ok ? {} : { error: `login ${response.status}` }
    },
    { email, password },
  )
  expect(result.error, 'login should succeed').toBeUndefined()
}

async function createBoard(page: Page): Promise<string> {
  const result = await page.evaluate(async () => {
    const refresh = await fetch('/api/auth/refresh', {
      method: 'POST',
      credentials: 'include',
    })
    const { accessToken } = (await refresh.json()) as { accessToken: string }
    const response = await fetch('/api/boards', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${accessToken}`,
      },
      credentials: 'include',
      body: JSON.stringify({ name: 'Convergence' }),
    })
    if (!response.ok) return { error: `board ${response.status}` }
    const { board } = (await response.json()) as { board: { id: string } }
    return { boardId: board.id }
  })
  expect(result.error, 'board creation should succeed').toBeUndefined()
  return result.boardId!
}

interface TestObject {
  id: string
  type: string
  x: number
  y: number
  zIndex: string
  color?: string
}

const objects = (page: Page): Promise<TestObject[]> =>
  page.evaluate(() =>
    (window as unknown as { __coboardObjects: () => TestObject[] }).__coboardObjects(),
  )

/**
 * The state hash from `?debug=1` — every object, sorted by id, floats rounded.
 *
 * CLAUDE.md §5.1: two clients at the same `lastAppliedSeq` must show the same
 * hash. It is the fastest divergence check that exists, and comparing it is
 * the only assertion in this file that actually means "converged".
 */
async function hash(page: Page): Promise<string> {
  const list = await objects(page)
  return JSON.stringify(
    list
      .slice()
      .sort((a, b) => (a.id < b.id ? -1 : 1))
      .map(o => [
        o.id,
        o.type,
        Math.round(o.x * 100),
        Math.round(o.y * 100),
        o.zIndex,
        o.color ?? '',
      ]),
  )
}

/**
 * Poll until both documents are identical.
 *
 * `expect.poll(() => hash(b)).toBe(await hash(a))` looks equivalent and is
 * not: the `await hash(a)` is evaluated once, when the assertion is built, so
 * it freezes A at an instant that may be mid-settle. B then converges on a
 * LATER state of A and the comparison never matches — a false failure that
 * looks exactly like a real divergence, and one that cost a debugging round
 * on AT-03.
 *
 * Comparing both sides on every tick is the only version that means
 * "converged" rather than "matched a stale snapshot". On failure the returned
 * string carries both hashes, so the report shows what actually differed.
 */
async function expectConverged(a: Page, b: Page, timeout = 20_000) {
  await expect
    .poll(
      async () => {
        const [ha, hb] = await Promise.all([hash(a), hash(b)])
        return ha === hb ? 'converged' : `DIVERGED\n  A: ${ha}\n  B: ${hb}`
      },
      { timeout },
    )
    .toBe('converged')
}

async function surface(page: Page) {
  await expect(page.getByTestId('canvas-surface')).toHaveAttribute('data-ready', 'true')
  // Connected, not merely painted: an assertion that races the handshake would
  // be measuring the load, not the sync.
  await expect(page.getByTestId('connection-indicator')).toHaveAttribute(
    'data-state',
    'connected',
  )
}

async function drawStroke(page: Page, x: number, y: number) {
  await page.getByTestId('tool-pen').click()
  await page.mouse.move(x, y)
  await page.mouse.down()
  for (let i = 1; i <= 6; i++) await page.mouse.move(x + i * 10, y + i * 6)
  await page.mouse.up()
}

/** Two pages on the same board, both connected. */
async function twoWindows(
  browser: import('@playwright/test').Browser,
  page: Page,
): Promise<{ a: Page; b: Page; boardId: string; contextB: BrowserContext }> {
  account ??= await register(page)
  await signIn(page, account.email)
  const boardId = await createBoard(page)

  const contextB = await browser.newContext()
  const b = await contextB.newPage()
  await signIn(b, account.email)

  await page.goto(`/board/${boardId}?debug=1`)
  await b.goto(`/board/${boardId}?debug=1`)
  await surface(page)
  await surface(b)

  return { a: page, b, boardId, contextB }
}

/* ── AT-01 … AT-05 ────────────────────────────────────────────────────────── */

test('AT-01: a stroke drawn by A appears in B', async ({ browser, page }) => {
  const { a, b, contextB } = await twoWindows(browser, page)

  const started = Date.now()
  await drawStroke(a, 250, 250)

  await expect.poll(async () => (await objects(b)).length).toBe(1)
  const elapsed = Date.now() - started

  // Printed rather than asserted tightly: the p95 ≤ 250 ms budget is measured
  // with instrumentation in Phase 11, and a shared CI runner is not the place
  // to judge it. A loose ceiling still catches a sync that is simply broken.
  console.log(`[sync] AT-01 local-to-remote — ${elapsed} ms (budget p95 250 ms)`)
  expect(elapsed).toBeLessThan(5_000)

  await expectConverged(a, b)
  await contextB.close()
})

test('AT-02: both draw, and the documents are identical', async ({ browser, page }) => {
  const { a, b, contextB } = await twoWindows(browser, page)

  for (let i = 0; i < 4; i++) {
    await drawStroke(a, 150 + i * 60, 200)
    await drawStroke(b, 150 + i * 60, 400)
  }

  await expect.poll(async () => (await objects(a)).length).toBe(8)
  await expect.poll(async () => (await objects(b)).length).toBe(8)

  // Eight each is not convergence. The same eight is.
  await expectConverged(a, b)
  await contextB.close()
})

test('AT-03: A moves an object while B recolours it — both survive', async ({
  browser,
  page,
}) => {
  const { a, b, contextB } = await twoWindows(browser, page)

  await drawStroke(a, 300, 300)
  await expect.poll(async () => (await objects(b)).length).toBe(1)

  // B recolours the stroke through the properties panel.
  await b.getByTestId('tool-select').click()
  await b.keyboard.press('Control+a')
  await b.getByTestId('swatch-#ef4444').click()
  await expect.poll(async () => (await objects(b))[0]!.color).toBe('#EF4444')

  // A moves it. A different FIELD of the same object.
  const before = (await objects(a))[0]!
  await a.getByTestId('tool-select').click()
  await a.keyboard.press('Control+a')
  for (let i = 0; i < 5; i++) await a.keyboard.press('ArrowRight')

  await expectConverged(a, b)

  /*
   * R-CONV-002: partial UPDATE payloads merge field-wise, so the move and the
   * recolour both land. Sending the whole object on update would make this a
   * lost update — whichever arrived second would silently undo the other.
   */
  const after = (await objects(a))[0]!
  expect(after.x).toBeGreaterThan(before.x)
  expect(after.color).toBe('#EF4444')

  await contextB.close()
})

test('AT-04: A deletes while B moves — gone on both, no zombie', async ({
  browser,
  page,
}) => {
  const { a, b, contextB } = await twoWindows(browser, page)

  await drawStroke(a, 300, 300)
  await expect.poll(async () => (await objects(b)).length).toBe(1)

  await b.getByTestId('tool-select').click()
  await b.keyboard.press('Control+a')
  await a.getByTestId('tool-select').click()
  await a.keyboard.press('Control+a')

  // Both act at once; the delete must win on both screens.
  await Promise.all([
    a.keyboard.press('Delete'),
    b.keyboard.press('ArrowRight'),
  ])

  await expect.poll(async () => (await objects(a)).length).toBe(0)
  await expect.poll(async () => (await objects(b)).length).toBe(0)
  await expectConverged(a, b)
  await contextB.close()
})

test('AT-05: simultaneous writes to one field converge', async ({ browser, page }) => {
  const { a, b, contextB } = await twoWindows(browser, page)

  await drawStroke(a, 300, 300)
  await expect.poll(async () => (await objects(b)).length).toBe(1)

  await a.getByTestId('tool-select').click()
  await b.getByTestId('tool-select').click()
  await a.keyboard.press('Control+a')
  await b.keyboard.press('Control+a')

  // Both nudge the same object within a few milliseconds. One of the two
  // values wins by seq; what matters is that BOTH clients pick the same one.
  await Promise.all([
    a.keyboard.press('ArrowRight'),
    b.keyboard.press('ArrowDown'),
  ])

  await expectConverged(a, b)
  await contextB.close()
})

/* ── AT-40, AT-41 — undo is per-user, and now testable ────────────────────── */

test('AT-40: undo does NOT revert the other person\'s work — R-UNDO-001', async ({
  browser,
  page,
}) => {
  const { a, b, contextB } = await twoWindows(browser, page)

  await drawStroke(a, 200, 250)
  await expect.poll(async () => (await objects(b)).length).toBe(1)
  await drawStroke(b, 500, 250)
  await expect.poll(async () => (await objects(a)).length).toBe(2)

  await a.getByTestId('tool-select').click()
  await a.keyboard.press('Control+z')

  /*
   * A's own stroke goes; B's stays. This is the whole reason `applyRemoteOp`
   * is a separate module that cannot import the history stack — if remote ops
   * reached A's undo stack, this keypress would delete B's work off B's
   * screen, and neither of them would understand why.
   */
  await expect.poll(async () => (await objects(a)).length).toBe(1)
  await expect.poll(async () => (await objects(b)).length).toBe(1)
  await expectConverged(a, b)
  await contextB.close()
})

test('AT-41: undoing a delete the other person already made is a no-op', async ({
  browser,
  page,
}) => {
  const { a, b, contextB } = await twoWindows(browser, page)

  await drawStroke(a, 300, 300)
  await expect.poll(async () => (await objects(b)).length).toBe(1)

  // B deletes it. A's undo stack still holds the create.
  await b.getByTestId('tool-select').click()
  await b.keyboard.press('Control+a')
  await b.keyboard.press('Delete')
  await expect.poll(async () => (await objects(a)).length).toBe(0)

  await a.getByTestId('tool-select').click()
  await a.keyboard.press('Control+z')

  // Undoing a create whose object is already gone must do nothing rather than
  // error or resurrect — R-UNDO-005's skip rule, over the wire.
  await expect.poll(async () => (await objects(a)).length).toBe(0)
  await expectConverged(a, b)
  await contextB.close()
})

/* ── Reconnect ────────────────────────────────────────────────────────────── */

test('work drawn while disconnected syncs when the socket returns', async ({
  browser,
  page,
}) => {
  const { a, b, contextB } = await twoWindows(browser, page)

  await a.context().setOffline(true)
  await drawStroke(a, 250, 250)
  await drawStroke(a, 450, 250)
  // Drawing stays instant with no network — the local-first write path.
  expect(await objects(a)).toHaveLength(2)

  await a.context().setOffline(false)
  await a.evaluate(() => window.dispatchEvent(new Event('online')))

  // The outbox flushes, the socket re-joins with its applied seq, and B
  // catches up.
  await expect.poll(async () => (await objects(b)).length, { timeout: 30_000 }).toBe(2)
  await expectConverged(a, b)
  await contextB.close()
})

/*
 * NOTE on the viewer case. `AT-20` over the socket — a viewer's op nacked with
 * FORBIDDEN and nothing written — is covered by the server's socket suite,
 * which can create a VIEWER membership directly. There is no way to invite one
 * from the browser until Phase 12 ships sharing, and inventing an endpoint so
 * a test can exercise a path the product does not have yet would be testing
 * the test.
 */

/* ── Presence, two contexts — AT-06, AT-07 ────────────────────────────────── */

const avatars = (page: Page) => page.getByTestId('avatar')

test('AT-06: B joins mid-session and sees the whole board and A live', async ({
  browser,
  page,
}) => {
  account ??= await register(page)
  await signIn(page, account.email)
  const boardId = await createBoard(page)

  // A works alone for a while first — this is the "mid-session" part.
  await page.goto(`/board/${boardId}?debug=1`)
  await surface(page)
  await drawStroke(page, 200, 220)
  await drawStroke(page, 380, 220)
  await drawStroke(page, 560, 220)

  const contextB = await browser.newContext()
  const b = await contextB.newPage()
  await signIn(b, account.email)
  await b.goto(`/board/${boardId}?debug=1`)
  await surface(b)

  // The complete board, not just what arrives live from here on.
  await expect.poll(async () => (await objects(b)).length).toBe(3)
  await expectConverged(page, b)

  // And A appears in B's header. A second tab of the SAME account still shows
  // as a separate session server-side; the avatar stack dedupes by user id,
  // so what B sees is one entry for A.
  await expect(avatars(b)).toHaveCount(1)

  // Live from here on, too.
  await drawStroke(page, 740, 220)
  await expect.poll(async () => (await objects(b)).length).toBe(4)

  await contextB.close()
})

test('AT-07: A closes the tab and disappears from B', async ({ browser, page }) => {
  account ??= await register(page)
  await signIn(page, account.email)
  const boardId = await createBoard(page)

  const contextB = await browser.newContext()
  const b = await contextB.newPage()
  await signIn(b, account.email)

  await page.goto(`/board/${boardId}?debug=1`)
  await b.goto(`/board/${boardId}?debug=1`)
  await surface(page)
  await surface(b)

  await expect(avatars(b)).toHaveCount(1)

  await page.close()

  /*
   * Five seconds is the budget. The socket `close` fires immediately on a
   * clean tab close, so this should be near-instant — the generous window is
   * for the half-open case the heartbeat catches, which is the one that
   * actually matters and the one a 60-second sweep would fail.
   */
  await expect(avatars(b)).toHaveCount(0, { timeout: 5_000 })

  await contextB.close()
})

test("a remote cursor appears in B when A moves, and carries A's name", async ({
  browser,
  page,
}) => {
  account ??= await register(page)
  await signIn(page, account.email)
  const boardId = await createBoard(page)

  const contextB = await browser.newContext()
  const b = await contextB.newPage()
  await signIn(b, account.email)

  await page.goto(`/board/${boardId}?debug=1`)
  await b.goto(`/board/${boardId}?debug=1`)
  await surface(page)
  await surface(b)

  await page.mouse.move(300, 300)
  for (let i = 0; i < 10; i++) await page.mouse.move(300 + i * 15, 300 + i * 10)

  // Read the store rather than the pixels: asserting on canvas output would
  // mean image comparison, which is slow and flaky, and the store is what the
  // renderer draws from anyway.
  await expect
    .poll(async () =>
      b.evaluate(
        () =>
          (
            window as unknown as { __coboardPresence: { allCursors: () => unknown[] } }
          ).__coboardPresence.allCursors().length,
      ),
    )
    .toBeGreaterThan(0)

  await contextB.close()
})

test('AT-08: five people draw at once, converge, and hold frame rate', async ({
  browser,
  page,
}) => {
  test.slow()
  account ??= await register(page)
  await signIn(page, account.email)
  const boardId = await createBoard(page)

  /*
   * Five participants. The plan asks for two minutes of simultaneous drawing;
   * this does a shorter, denser version — the failure modes it is looking for
   * (divergence, a seq gap, a frame-rate collapse from presence touching
   * layer 1) show up in seconds if they show up at all, and a two-minute e2e
   * on a shared runner buys flakiness rather than confidence.
   */
  const pages: Page[] = [page]
  const contexts: BrowserContext[] = []
  for (let i = 0; i < 4; i++) {
    const context = await browser.newContext()
    const p = await context.newPage()
    await signIn(p, account.email)
    contexts.push(context)
    pages.push(p)
  }

  await Promise.all(pages.map(p => p.goto(`/board/${boardId}?debug=1`)))
  await Promise.all(pages.map(p => surface(p)))

  // Everyone draws and moves a pointer at the same time.
  await Promise.all(
    pages.map(async (p, index) => {
      for (let i = 0; i < 3; i++) {
        await drawStroke(p, 150 + i * 90, 150 + index * 70)
        await p.mouse.move(400 + i * 30, 400 + index * 20)
      }
    }),
  )

  const expected = pages.length * 3
  for (const p of pages) {
    await expect.poll(async () => (await objects(p)).length, { timeout: 30_000 }).toBe(
      expected,
    )
  }

  // Convergence, pairwise against the first.
  for (const p of pages.slice(1)) await expectConverged(page, p, 30_000)

  /*
   * Frame rate, and the layer-1 claim under real multi-user load. The p95 is
   * printed rather than asserted tightly — a shared runner hosting five
   * Chromium contexts and a Node server is not where a 55 fps budget gets
   * judged — but a hard ceiling still catches a genuine collapse.
   */
  const m = await pages[1]!.evaluate(
    () =>
      (
        window as unknown as {
          __coboardMetrics: () => { p50: number; p95: number; objectPaints: number }
        }
      ).__coboardMetrics(),
  )
  console.log(
    `[perf] AT-08 five users — frame p50 ${m.p50.toFixed(1)}ms, p95 ${m.p95.toFixed(1)}ms`,
  )
  expect(m.p95).toBeLessThan(100)

  for (const context of contexts) await context.close()
})
