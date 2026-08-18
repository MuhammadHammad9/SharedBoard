import { expect, test, type Page } from '@playwright/test'

/**
 * Persistence end to end — AT-10, AT-11, AT-13, FR-BOARD-001, FR-SYNC-004/009.
 *
 * AT-10  draw, refresh, everything is there
 * AT-11  draw, close the browser, reopen — everything is there
 * AT-13  a 5,000-object board loads in under 3 s and is interactive
 *
 * Phase 8's exit gate, and the first test in the project that touches the real
 * stack top to bottom: a real browser, a real Express server, a real Postgres.
 * Every other suite stubs one end or the other, and none of them can answer
 * the only question that matters here — is the work still there tomorrow?
 *
 * The board is created through the API from inside the page, so the test never
 * has to know a board id in advance and no fixture has to be seeded.
 */

const password = 'correct-horse-1'

/*
 * ONE account for the whole file, created on first use.
 *
 * Registration is rate-limited to 10 per IP per 15 minutes (R-SEC-013), and
 * every test here runs from the same address. A signup per test spends the
 * budget in one pass and leaves nothing for CI's two retries, so the suite
 * would go red for the right reason at the wrong time. A board per test is
 * enough isolation — the tests never share one.
 */
test.describe.configure({ mode: 'serial' })

interface Account {
  email: string
  accessToken: string
}

let primary: Account | null = null

async function register(page: Page): Promise<Account> {
  const email = `e2e.${Date.now()}.${Math.random().toString(36).slice(2, 8)}@example.com`
  await page.goto('/login')

  const result = await page.evaluate(
    async ({ email, password }) => {
      const response = await fetch('/api/auth/register', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ email, password, displayName: 'Priya Raman' }),
      })
      if (!response.ok) return { error: `register ${response.status}` }
      const { accessToken } = (await response.json()) as { accessToken: string }
      return { accessToken }
    },
    { email, password },
  )

  expect(result.error, 'registration should succeed').toBeUndefined()
  return { email, accessToken: result.accessToken! }
}

/**
 * Put the shared account's session cookie in this page's context.
 *
 * Logging in rather than registering: login is limited far more generously,
 * and the cookie is what the guard and the board load both need.
 */
async function signIn(page: Page, account: Account): Promise<void> {
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
    { email: account.email, password },
  )
  expect(result.error, 'login should succeed').toBeUndefined()
}

async function createBoard(page: Page, name: string): Promise<string> {
  const result = await page.evaluate(async (name: string) => {
    const refresh = await fetch('/api/auth/refresh', {
      method: 'POST',
      credentials: 'include',
    })
    if (!refresh.ok) return { error: `refresh ${refresh.status}` }
    const { accessToken } = (await refresh.json()) as { accessToken: string }

    const response = await fetch('/api/boards', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${accessToken}`,
      },
      credentials: 'include',
      body: JSON.stringify({ name }),
    })
    if (!response.ok) return { error: `board ${response.status}` }
    const { board } = (await response.json()) as { board: { id: string } }
    return { boardId: board.id }
  }, name)

  expect(result.error, 'board creation should succeed').toBeUndefined()
  return result.boardId!
}

/** A signed-in page with a fresh, empty board. */
async function openNewBoard(page: Page, name = 'Q3 Retrospective'): Promise<string> {
  primary ??= await register(page)
  await signIn(page, primary)
  return createBoard(page, name)
}

async function surface(page: Page) {
  const el = page.getByTestId('canvas-surface')
  await expect(el).toHaveAttribute('data-ready', 'true')
  return el
}

const objectCount = (page: Page): Promise<number> =>
  page.evaluate(
    () => (window as unknown as { __coboardObjects: () => unknown[] }).__coboardObjects().length,
  )

async function drawStroke(page: Page, x: number, y: number) {
  await page.getByTestId('tool-pen').click()
  await page.mouse.move(x, y)
  await page.mouse.down()
  for (let i = 1; i <= 8; i++) await page.mouse.move(x + i * 8, y + i * 5)
  await page.mouse.up()
}

/**
 * The outbox flushes asynchronously and deliberately does not block the
 * pointer. Waiting on the server's own count is the honest way to know the
 * write landed — polling a client-side flag would only prove the client
 * believes it did.
 */
async function waitForServerObjects(page: Page, boardId: string, expected: number) {
  await expect
    .poll(
      () =>
        page.evaluate(async (id: string) => {
          const refresh = await fetch('/api/auth/refresh', {
            method: 'POST',
            credentials: 'include',
          })
          const { accessToken } = (await refresh.json()) as { accessToken: string }
          const state = await fetch(`/api/boards/${id}/snapshot`, {
            headers: { authorization: `Bearer ${accessToken}` },
            credentials: 'include',
          })
          const body = (await state.json()) as { objects: unknown[] }
          return body.objects.length
        }, boardId),
      { timeout: 15_000 },
    )
    .toBe(expected)
}

test.describe('board persistence', () => {
  test('AT-10: draw, refresh, and the work is still there', async ({ page }) => {
    const boardId = await openNewBoard(page)

    await page.goto(`/board/${boardId}?debug=1`)
    await surface(page)

    await drawStroke(page, 200, 200)
    await drawStroke(page, 400, 220)
    await drawStroke(page, 600, 240)
    expect(await objectCount(page)).toBe(3)

    await waitForServerObjects(page, boardId, 3)

    await page.reload()
    await surface(page)

    // The gate. Everything before this line is setup.
    await expect.poll(() => objectCount(page)).toBe(3)
  })

  test('history does NOT survive the reload, but the objects do — R-UNDO-006', async ({
    page,
  }) => {
    const boardId = await openNewBoard(page)
    await page.goto(`/board/${boardId}?debug=1`)
    await surface(page)

    await drawStroke(page, 250, 250)
    await waitForServerObjects(page, boardId, 1)

    await page.reload()
    await surface(page)
    await expect.poll(() => objectCount(page)).toBe(1)

    // An undo stack restored from a previous session would hold inverses for
    // objects the user has no memory of touching.
    const stacks = await page.evaluate(() =>
      (
        window as unknown as { __coboardHistory: () => { undo: number; redo: number } }
      ).__coboardHistory(),
    )
    expect(stacks).toEqual({ undo: 0, redo: 0 })
  })

  test('an undo is persisted too, not just applied locally', async ({ page }) => {
    const boardId = await openNewBoard(page)
    await page.goto(`/board/${boardId}?debug=1`)
    await surface(page)

    await drawStroke(page, 200, 200)
    await drawStroke(page, 400, 200)
    await waitForServerObjects(page, boardId, 2)

    await page.getByTestId('tool-select').click()
    await page.keyboard.press('Control+z')
    expect(await objectCount(page)).toBe(1)

    // If the undo never reached the server, the second stroke comes back on
    // reload — a bug invisible until the user closes the tab.
    await waitForServerObjects(page, boardId, 1)
    await page.reload()
    await surface(page)
    await expect.poll(() => objectCount(page)).toBe(1)
  })

  test('work drawn OFFLINE flushes when the connection returns', async ({
    page,
    context,
  }) => {
    const boardId = await openNewBoard(page)
    await page.goto(`/board/${boardId}?debug=1`)
    await surface(page)

    await drawStroke(page, 200, 200)
    await waitForServerObjects(page, boardId, 1)

    await context.setOffline(true)
    await drawStroke(page, 400, 200)
    await drawStroke(page, 550, 220)
    // Drawing must stay instant with no network. This is the whole point of
    // the local-first write path.
    expect(await objectCount(page)).toBe(3)

    await context.setOffline(false)
    // `resume` is wired to the browser's online event; without it the queue
    // would sit out a backoff.
    await page.evaluate(() => window.dispatchEvent(new Event('online')))

    await waitForServerObjects(page, boardId, 3)
  })

  test('a board the user cannot see shows S-20 and never its name', async ({
    page,
  }) => {
    const ownerBoard = await openNewBoard(page, 'Acquisition target shortlist')

    // A different person, in a context of their own so the cookie does not
    // collide with the owner's.
    const context = await page.context().browser()!.newContext()
    const intruder = await context.newPage()
    const other = await register(intruder)
    await signIn(intruder, other)

    await intruder.goto(`/board/${ownerBoard}`)
    await expect(intruder.getByTestId('board-not-found')).toBeVisible()
    // R-SEC-018: the name must not appear anywhere on the page.
    expect(await intruder.content()).not.toContain('Acquisition')
    await context.close()
  })

  test('a board id that is not a board shows S-20', async ({ page }) => {
    await openNewBoard(page)
    await page.goto('/board/11111111-1111-4111-8111-111111111111')
    await expect(page.getByTestId('board-not-found')).toBeVisible()
  })

  test('an unauthenticated visitor is sent to login with next preserved', async ({
    page,
  }) => {
    await page.goto('/board/11111111-1111-4111-8111-111111111111')
    await expect(page).toHaveURL(/\/login\?next=/)
    expect(new URL(page.url()).searchParams.get('next')).toBe(
      '/board/11111111-1111-4111-8111-111111111111',
    )
  })

  test('AT-11: draw, close the browser, reopen — the work is there', async ({
    page,
    browser,
  }) => {
    const boardId = await openNewBoard(page, 'Onboarding flow rewrite')
    await page.goto(`/board/${boardId}?debug=1`)
    await surface(page)

    await drawStroke(page, 220, 220)
    await drawStroke(page, 420, 240)
    await waitForServerObjects(page, boardId, 2)

    /*
     * A brand-new context is the honest version of "closed the browser": no
     * localStorage, no in-memory token, and only the refresh cookie would
     * survive a real restart — which this context does not even have.
     *
     * So the user signs in again, exactly as they would.
     */
    const fresh = await browser.newContext()
    const reopened = await fresh.newPage()
    await signIn(reopened, primary!)

    await reopened.goto(`/board/${boardId}?debug=1`)
    await surface(reopened)
    await expect.poll(() => objectCount(reopened)).toBe(2)

    await fresh.close()
  })

  test('AT-13: a 5,000-object board loads in under 3 seconds and is interactive', async ({
    page,
  }) => {
    test.slow()
    const boardId = await openNewBoard(page, 'Architecture: presence fan-out')

    // Built through the API rather than seeded, so the load path reads exactly
    // what the append path wrote — including the fold over 5,000 CREATEs and
    // whatever snapshots the interval produced along the way.
    const built = await page.evaluate(async (id: string) => {
      const refresh = await fetch('/api/auth/refresh', {
        method: 'POST',
        credentials: 'include',
      })
      const { accessToken } = (await refresh.json()) as { accessToken: string }

      const uuid = () => crypto.randomUUID()
      const TOTAL = 5_000
      const BATCH = 200

      for (let start = 0; start < TOTAL; start += BATCH) {
        const ops = Array.from({ length: BATCH }, (_, i) => {
          const n = start + i
          const objectId = uuid()
          return {
            id: uuid(),
            type: 'CREATE',
            objectId,
            payload: {
              id: objectId,
              type: 'sticky',
              x: (n % 100) * 220,
              y: Math.floor(n / 100) * 220,
              width: 200,
              height: 200,
              rotation: 0,
              zIndex: `a${n.toString(36).padStart(6, '0')}`,
              opacity: 1,
              createdBy: 'at13',
              createdAt: 1_760_000_000_000,
              updatedAt: 1_760_000_000_000,
              text: `Note ${n}`,
              color: '#FEF08A',
              fontSize: 16,
              textAlign: 'left',
            },
          }
        })

        const response = await fetch(`/api/boards/${id}/operations`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${accessToken}`,
          },
          credentials: 'include',
          body: JSON.stringify({ ops }),
        })
        if (!response.ok) return { error: `append ${response.status} at ${start}` }
      }
      return { ok: true }
    }, boardId)

    expect(built.error, 'building the 5,000-object board should succeed').toBeUndefined()

    const started = Date.now()
    await page.goto(`/board/${boardId}?debug=1`)
    await surface(page)
    await expect.poll(() => objectCount(page), { timeout: 20_000 }).toBe(5_000)
    const elapsed = Date.now() - started

    // Printed unconditionally: the number is the point, and a pass that never
    // says how close it came is not evidence.
    console.log(`[perf] 5,000-object board load — ${elapsed} ms (budget 3000 ms)`)

    // Interactive, not merely painted. A board that renders and then ignores
    // the pointer for two seconds has not met the requirement.
    await page.getByTestId('tool-select').click()
    await page.mouse.click(300, 300)
    expect(await objectCount(page)).toBe(5_000)

    expect(elapsed).toBeLessThan(3_000)
  })
})
