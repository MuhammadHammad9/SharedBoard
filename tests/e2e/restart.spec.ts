import { spawn, type ChildProcess } from 'node:child_process'
import { expect, test, type Page } from '@playwright/test'

/**
 * AT-12 for real, and TRD §13.3 item 9 — "Kill and restart the server
 * mid-session". Phase 15g.
 *
 * The rest of the suite cannot do this, because Playwright's web server owns
 * the API process. So this spec owns its OWN stack on spare ports: an API
 * server it can SIGKILL — no graceful shutdown, no close frames, exactly a
 * crash — and a Vite dev server proxying to it. The user keeps drawing
 * through the outage. Afterwards every stroke must exist exactly once, both
 * live and after a fresh load from the server.
 */

const API_PORT = 3110
const WEB_PORT = 5180
const WEB = `http://localhost:${WEB_PORT}`
const password = 'correct-horse-1'

function start(
  command: string,
  args: string[],
  env: Record<string, string>,
): ChildProcess {
  return spawn(command, args, {
    env: { ...process.env, ...env },
    stdio: 'ignore',
    // Its own process group, so a kill reaches the node process pnpm spawns
    // and not just the pnpm wrapper.
    detached: true,
  })
}

/** Kill the whole process group — pnpm, tsx and the server under it. */
function killTree(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.pid === undefined) return
  try {
    process.kill(-child.pid, signal)
  } catch {
    // already gone
  }
}

const startApi = () =>
  start('pnpm', ['--filter', '@coboard/server', 'exec', 'tsx', 'src/index.ts'], {
    PORT: String(API_PORT),
    CLIENT_ORIGIN: WEB,
    REGISTER_RATE_LIMIT: '1000',
  })

async function waitFor(url: string, timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    try {
      if ((await fetch(url)).ok) return
    } catch {
      // not up yet
    }
    if (Date.now() > deadline) throw new Error(`${url} never came up`)
    await new Promise(r => setTimeout(r, 500))
  }
}

async function waitDown(url: string): Promise<void> {
  for (let i = 0; i < 40; i++) {
    try {
      await fetch(url)
    } catch {
      return
    }
    await new Promise(r => setTimeout(r, 250))
  }
  throw new Error(`${url} is still answering`)
}

type Sync = { pending: number; connection: string; objects: number } | null
const sync = (page: Page) =>
  page.evaluate(
    () => (window as unknown as { __coboardSync?: () => Sync }).__coboardSync?.() ?? null,
  )

async function stroke(page: Page, n: number) {
  const box = (await page.getByTestId('canvas-surface').boundingBox())!
  const x = box.x + 260 + (n % 4) * 110
  const y = box.y + 220 + Math.floor(n / 4) * 100
  await page.mouse.move(x, y)
  await page.mouse.down()
  for (let i = 1; i <= 5; i++) await page.mouse.move(x + i * 12, y + i * 7)
  await page.mouse.up()
}

test('AT-12: the server is killed and restarted mid-session — nothing lost, nothing doubled', async ({
  page,
}) => {
  test.setTimeout(240_000)
  let api = startApi()
  const web = start(
    'pnpm',
    [
      '--filter',
      '@coboard/web',
      'exec',
      'vite',
      '--port',
      String(WEB_PORT),
      '--strictPort',
    ],
    { API_ORIGIN: `http://localhost:${API_PORT}` },
  )
  try {
    await waitFor(`http://localhost:${API_PORT}/health`)
    await waitFor(WEB)

    // An account and a board, through the real API.
    await page.goto(`${WEB}/login`)
    const boardId = await page.evaluate(async password => {
      const email = `restart.${Date.now()}@example.com`
      const reg = await fetch('/api/auth/register', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ email, password, displayName: 'Mei Chen' }),
      })
      const { accessToken } = (await reg.json()) as { accessToken: string }
      const created = await fetch('/api/boards', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${accessToken}`,
        },
        credentials: 'include',
        body: JSON.stringify({ name: 'Incident review' }),
      })
      return ((await created.json()) as { board: { id: string } }).board.id
    }, password)

    await page.goto(`${WEB}/board/${boardId}?debug=1`)
    await expect(page.getByTestId('canvas-surface')).toHaveAttribute('data-ready', 'true')
    await expect.poll(async () => (await sync(page))?.connection).toBe('connected')
    await page.getByTestId('tool-pen').click()

    // Three strokes while the server is up, all acknowledged.
    for (let i = 0; i < 3; i++) await stroke(page, i)
    await expect.poll(async () => (await sync(page))?.pending).toBe(0)

    // Crash it. No graceful shutdown, no close frames.
    killTree(api, 'SIGKILL')
    await waitDown(`http://localhost:${API_PORT}/health`)

    // Three more while it is down: they wait in the outbox.
    for (let i = 3; i < 6; i++) await stroke(page, i)
    expect((await sync(page))?.objects).toBe(6)

    // Back up on the same port. The client reconnects, replays and drains.
    api = startApi()
    await waitFor(`http://localhost:${API_PORT}/health`)
    await expect
      .poll(
        async () => {
          const s = await sync(page)
          return s ? `${s.connection}/${s.pending}` : null
        },
        { timeout: 90_000 },
      )
      .toBe('connected/0')
    expect((await sync(page))?.objects).toBe(6)

    // And the server has all six, exactly once: a fresh load from scratch.
    await page.reload()
    await expect(page.getByTestId('canvas-surface')).toHaveAttribute('data-ready', 'true')
    await expect.poll(async () => (await sync(page))?.objects).toBe(6)
  } finally {
    killTree(api, 'SIGKILL')
    killTree(web, 'SIGTERM')
  }
})
