import { expect, type Browser, type BrowserContext, type Page } from '@playwright/test'

/**
 * Two-window helpers for the Phase 11 suites — convergence and chaos.
 *
 * Every assertion that two clients agree goes through `expectSettled`, which
 * compares the FULL state hash from `?debug=1` (features/sync/stateHash.ts):
 * every field of every object, sorted, floats rounded. A count, or a hash of a
 * few fields, can agree while the documents differ.
 */

const password = 'correct-horse-1'

export async function register(page: Page): Promise<string> {
  const email = `p11.${Date.now()}.${Math.random().toString(36).slice(2, 8)}@example.com`
  await page.goto('/login')
  const status = await page.evaluate(
    async ({ email, password }) => {
      const r = await fetch('/api/auth/register', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ email, password, displayName: 'Priya Raman' }),
      })
      return r.status
    },
    { email, password },
  )
  expect(status, 'registration should succeed').toBeLessThan(300)
  return email
}

export async function signIn(page: Page, email: string): Promise<void> {
  await page.goto('/login')
  const status = await page.evaluate(
    async ({ email, password }) => {
      const r = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ email, password }),
      })
      return r.status
    },
    { email, password },
  )
  expect(status, 'login should succeed').toBeLessThan(300)
}

export async function createBoard(
  page: Page,
  name = 'Offsite planning',
): Promise<string> {
  const result = await page.evaluate(async name => {
    const refresh = await fetch('/api/auth/refresh', {
      method: 'POST',
      credentials: 'include',
    })
    const { accessToken } = (await refresh.json()) as { accessToken: string }
    const r = await fetch('/api/boards', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${accessToken}`,
      },
      credentials: 'include',
      body: JSON.stringify({ name }),
    })
    if (!r.ok) return { error: r.status }
    const { board } = (await r.json()) as { board: { id: string } }
    return { boardId: board.id }
  }, name)
  expect(result.error, 'board creation should succeed').toBeUndefined()
  return result.boardId!
}

export async function connected(page: Page): Promise<void> {
  await expect(page.getByTestId('canvas-surface')).toHaveAttribute('data-ready', 'true')
  await expect(page.getByTestId('connection-indicator')).toHaveAttribute(
    'data-state',
    'connected',
    { timeout: 20_000 },
  )
}

export interface Pair {
  a: Page
  b: Page
  boardId: string
  contextA: BrowserContext
  contextB: BrowserContext
}

/** Two contexts, one account, one fresh board, both connected. */
export async function twoWindows(browser: Browser, email: string): Promise<Pair> {
  const contextA = await browser.newContext()
  const contextB = await browser.newContext()
  const a = await contextA.newPage()
  const b = await contextB.newPage()
  await signIn(a, email)
  await signIn(b, email)
  const boardId = await createBoard(a)
  await a.goto(`/board/${boardId}?debug=1`)
  await b.goto(`/board/${boardId}?debug=1`)
  await connected(a)
  await connected(b)
  return { a, b, boardId, contextA, contextB }
}

export interface SyncReading {
  seq: number
  pending: number
  connection: string
  objects: number
  hash: string
}

export const reading = (page: Page): Promise<SyncReading | null> =>
  page.evaluate(
    () =>
      (
        window as unknown as { __coboardSync?: () => SyncReading | null }
      ).__coboardSync?.() ?? null,
  )

/**
 * Wait until both clients are connected, have nothing unsent, sit at the same
 * seq, and hold the same document. Both sides are read on every tick — see
 * realtime.spec.ts for why freezing one side gives false failures.
 */
export async function expectSettled(
  a: Page,
  b: Page,
  timeout = 30_000,
): Promise<SyncReading> {
  let last: SyncReading | null = null
  await expect
    .poll(
      async () => {
        const [ra, rb] = await Promise.all([reading(a), reading(b)])
        if (!ra || !rb) return 'no session'
        last = ra
        const quiet =
          ra.pending === 0 &&
          rb.pending === 0 &&
          ra.connection === 'connected' &&
          rb.connection === 'connected'
        if (!quiet) return `busy  A:${JSON.stringify(ra)}  B:${JSON.stringify(rb)}`
        if (ra.seq !== rb.seq) return `seq A:${ra.seq} B:${rb.seq}`
        return ra.hash === rb.hash
          ? 'converged'
          : `DIVERGED at seq ${ra.seq}  A:${ra.hash}/${ra.objects}  B:${rb.hash}/${rb.objects}`
      },
      { timeout, intervals: [100, 250, 500] },
    )
    .toBe('converged')
  return last!
}

/* ── Network faults ────────────────────────────────────────────────────────── */

/**
 * Take a context fully offline: the browser reports no network (so the
 * client goes OFFLINE rather than burning retries) and the open socket is cut
 * the way a dead link cuts it, with no close frame.
 */
export async function goOffline(context: BrowserContext, page: Page): Promise<void> {
  await context.setOffline(true)
  await page.evaluate(() =>
    (window as unknown as { __coboardNet: { drop(): void } }).__coboardNet.drop(),
  )
  await expect(page.getByTestId('connection-indicator')).toHaveAttribute(
    'data-state',
    /offline|reconnecting/,
  )
}

export async function goOnline(context: BrowserContext): Promise<void> {
  await context.setOffline(false)
}

/** Cut the socket without taking the network down — it reconnects by itself. */
export const dropSocket = (page: Page): Promise<void> =>
  page.evaluate(() =>
    (window as unknown as { __coboardNet: { drop(): void } }).__coboardNet.drop(),
  )

export async function drawStroke(page: Page, x: number, y: number): Promise<void> {
  await page.getByTestId('tool-pen').click()
  await page.mouse.move(x, y)
  await page.mouse.down()
  for (let i = 1; i <= 6; i++) await page.mouse.move(x + i * 10, y + i * 6)
  await page.mouse.up()
}

export const objectCount = async (page: Page): Promise<number> =>
  (await reading(page))?.objects ?? -1

/**
 * On a divergence, say WHERE: every object the two documents disagree on,
 * both versions, and that object's full op history from the server log. A
 * bare hash mismatch says only that something is wrong.
 */
export async function diagnose(a: Page, b: Page, boardId: string): Promise<string> {
  type Obj = Record<string, unknown> & { id: string }
  const read = (p: Page) =>
    p.evaluate(() =>
      (window as unknown as { __coboardObjects: () => Obj[] }).__coboardObjects(),
    )
  const [oa, ob] = await Promise.all([read(a), read(b)])
  const log = await a.evaluate(async boardId => {
    const refresh = await fetch('/api/auth/refresh', {
      method: 'POST',
      credentials: 'include',
    })
    const { accessToken } = (await refresh.json()) as { accessToken: string }
    const out: unknown[] = []
    let since = 0
    for (let i = 0; i < 50; i++) {
      const r = await fetch(`/api/boards/${boardId}/operations?sinceSeq=${since}`, {
        headers: { authorization: `Bearer ${accessToken}` },
      })
      const body = (await r.json()) as { ops: Array<{ seq: number }> }
      if (body.ops.length === 0) break
      out.push(...body.ops)
      since = body.ops[body.ops.length - 1]!.seq
    }
    return out as Array<{
      seq: number
      objectId: string
      type: string
      payload: unknown
      id: string
    }>
  }, boardId)

  const ma = new Map(oa.map(o => [o.id, o]))
  const mb = new Map(ob.map(o => [o.id, o]))
  const ids = new Set([...ma.keys(), ...mb.keys()])
  const lines: string[] = [`log length ${log.length}, last seq ${log.at(-1)?.seq}`]
  for (const id of ids) {
    const x = JSON.stringify(ma.get(id) ?? null)
    const y = JSON.stringify(mb.get(id) ?? null)
    if (x === y) continue
    lines.push(`\n=== ${id}\n A: ${x}\n B: ${y}`)
    for (const op of log.filter(o => o.objectId === id)) {
      lines.push(
        `   #${op.seq} ${op.type} ${op.id.slice(0, 8)} ${JSON.stringify(op.payload).slice(0, 160)}`,
      )
    }
  }
  return lines.join('\n')
}
