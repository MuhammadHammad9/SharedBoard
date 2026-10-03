import { expect, test, type Browser, type Page } from '@playwright/test'
import {
  connected,
  createBoard,
  drawStroke,
  reading,
  register,
  signIn,
} from './support/realtime.js'

/**
 * Sharing, guests and permissions — Phase 12's exit gate.
 *
 *   A guest joins via a link and is drawing in under 10 seconds.
 *   AT-20 … AT-24 pass (AT-20/24 at the server too; AT-21 in board-persistence).
 *   A viewer cannot mutate the board.
 *   Revocation and deletion eject connected users with the correct screens.
 *
 * Real stack throughout: two or three browser contexts, the real server,
 * the real socket.
 */

test.describe.configure({ mode: 'serial' })
test.setTimeout(90_000)

let ownerEmail: string | null = null
let editorEmail: string | null = null

/** Call the API as whoever `page` is signed in as. */
async function apiAs<T>(
  page: Page,
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  const result = await page.evaluate(
    async ({ method, path, body }) => {
      const refresh = await fetch('/api/auth/refresh', {
        method: 'POST',
        credentials: 'include',
      })
      const { accessToken } = (await refresh.json()) as { accessToken: string }
      const r = await fetch(`/api${path}`, {
        method,
        headers: {
          authorization: `Bearer ${accessToken}`,
          ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        },
        credentials: 'include',
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      })
      return { status: r.status, body: r.status === 204 ? null : await r.json() }
    },
    { method, path, body },
  )
  expect(result.status, `${method} ${path}`).toBeLessThan(300)
  return result.body as T
}

async function ownerWithBoard(browser: Browser, role: 'EDITOR' | 'VIEWER' = 'EDITOR') {
  const context = await browser.newContext()
  const owner = await context.newPage()
  ownerEmail ??= await register(owner)
  await signIn(owner, ownerEmail)
  const boardId = await createBoard(owner, 'Q3 Retrospective')
  const { link } = await apiAs<{ link: { token: string } }>(
    owner,
    'PUT',
    `/boards/${boardId}/share-link`,
    { role },
  )
  await owner.goto(`/board/${boardId}?debug=1`)
  await connected(owner)
  return { owner, context, boardId, token: link.token }
}

async function joinAsGuest(browser: Browser, token: string, name = 'Marcus') {
  const context = await browser.newContext()
  const page = await context.newPage()
  await page.goto(`/join/${token}`)
  await page.getByTestId('join-name').fill(name)
  await page.getByTestId('join-name').press('Enter')
  await expect(page.getByTestId('canvas-surface')).toHaveAttribute('data-ready', 'true')
  return { page, context }
}

test('a guest joins through a link and is drawing in under 10 seconds', async ({
  browser,
}) => {
  const { owner, context, token } = await ownerWithBoard(browser)

  const guestContext = await browser.newContext()
  const guest = await guestContext.newPage()
  const started = Date.now()
  await guest.goto(`/join/${token}`)
  // The card: board name, owner, an auto-focused name field.
  await expect(guest.getByTestId('join-board-name')).toHaveText('Q3 Retrospective')
  await expect(guest.getByTestId('join-name')).toBeFocused()
  await guest.keyboard.type('Marcus')
  await guest.keyboard.press('Enter')
  await connected(guest)
  await drawStroke(guest, 300, 300)
  await expect.poll(async () => (await reading(owner))?.objects).toBe(1)
  const elapsed = Date.now() - started
  console.log(
    `[sharing] click to first stroke seen by the owner — ${elapsed} ms (target < 10 s)`,
  )
  expect(elapsed).toBeLessThan(10_000)

  // Back does not return to the join screen (FLOWS §7.1 step 7, replace).
  expect(guest.url()).toContain('/board/')
  await expect(guest.getByText("You're in as Marcus")).toBeVisible()
  await expect(guest.getByTestId('guest-bar')).toBeVisible()

  await guestContext.close()
  await context.close()
})

test('a returning guest skips S-11 and sees the "Not you?" chip', async ({ browser }) => {
  const { context, token } = await ownerWithBoard(browser)
  const { page: guest, context: guestContext } = await joinAsGuest(browser, token)

  const again = await guestContext.newPage()
  await again.goto(`/join/${token}`)
  await expect(again.getByTestId('canvas-surface')).toHaveAttribute('data-ready', 'true')
  await expect(again.getByTestId('returning-guest-chip')).toContainText(
    'Joined as Marcus',
  )
  await expect(again.getByTestId('join-name')).toHaveCount(0)

  await guest.close()
  await guestContext.close()
  await context.close()
})

test('AT-20: a viewer gets the View only badge, and drawing changes nothing', async ({
  browser,
}) => {
  const { owner, context, token } = await ownerWithBoard(browser, 'VIEWER')
  const { page: viewer, context: viewerContext } = await joinAsGuest(
    browser,
    token,
    'Dana',
  )
  await connected(viewer)

  await expect(viewer.getByTestId('view-only-badge')).toBeVisible()
  await expect(viewer.getByTestId('toolbar')).toHaveCount(0)
  // A drag pans instead; keyboard tool switches are ignored.
  await viewer.keyboard.press('p')
  await viewer.mouse.move(300, 300)
  await viewer.mouse.down()
  await viewer.mouse.move(380, 340)
  await viewer.mouse.up()
  await viewer.waitForTimeout(500)
  expect((await reading(viewer))?.objects).toBe(0)
  expect((await reading(owner))?.objects).toBe(0)

  await viewerContext.close()
  await context.close()
})

test('a role change to viewer disables the toolbar live, without ejecting', async ({
  browser,
}) => {
  const { owner, context, boardId } = await ownerWithBoard(browser)
  const editorContext = await browser.newContext()
  const editor = await editorContext.newPage()
  editorEmail ??= await register(editor)
  await apiAs(owner, 'POST', `/boards/${boardId}/members`, {
    emails: [editorEmail],
    role: 'EDITOR',
  })
  await signIn(editor, editorEmail)
  await editor.goto(`/board/${boardId}?debug=1`)
  await connected(editor)
  await expect(editor.getByTestId('toolbar')).toBeVisible()

  // Through the real share modal.
  await owner.getByTestId('share-button').click()
  const row = owner.getByTestId('member-row').filter({ hasText: editorEmail })
  await row.getByTestId('member-role').selectOption('VIEWER')

  await expect(editor.getByTestId('view-only-badge')).toBeVisible({ timeout: 10_000 })
  await expect(editor.getByText("You're now a viewer on this board.")).toBeVisible()
  // Not ejected.
  await expect(editor.getByTestId('connection-indicator')).toHaveAttribute(
    'data-state',
    'connected',
  )

  await editorContext.close()
  await context.close()
})

test('AT-22: the owner turns the link off while a guest is drawing — ejected within 10 s', async ({
  browser,
}) => {
  const { owner, context, boardId } = await ownerWithBoard(browser)
  const token = (
    await apiAs<{ link: { token: string } }>(
      owner,
      'GET',
      `/boards/${boardId}/share-link`,
    )
  ).link.token
  const { page: guest, context: guestContext } = await joinAsGuest(browser, token)
  await connected(guest)
  await drawStroke(guest, 250, 250)

  const started = Date.now()
  await apiAs(owner, 'DELETE', `/boards/${boardId}/share-link`)
  await expect(guest.getByTestId('board-access-removed')).toBeVisible({ timeout: 10_000 })
  expect(Date.now() - started).toBeLessThan(10_000)
  // R-SEC-018 holds on the ejection screen too.
  expect(await guest.getByTestId('board-access-removed').textContent()).not.toContain(
    'Q3 Retrospective',
  )

  await guestContext.close()
  await context.close()
})

test('AT-23: the owner deletes the board with 3 people connected — all see S-19', async ({
  browser,
}) => {
  const { owner, context, boardId, token } = await ownerWithBoard(browser)
  const a = await joinAsGuest(browser, token, 'Marcus')
  const b = await joinAsGuest(browser, token, 'Dana')
  await connected(a.page)
  await connected(b.page)

  // Deleted by the owner — whose own open board tab must show S-19 too.
  await apiAs(owner, 'DELETE', `/boards/${boardId}`)

  for (const page of [owner, a.page, b.page]) {
    await expect(page.getByTestId('board-deleted-live')).toBeVisible({ timeout: 10_000 })
  }

  await a.context.close()
  await b.context.close()
  await context.close()
})

test('guest → account: sign up in a new tab, and nothing on the canvas is lost', async ({
  browser,
}) => {
  const { owner, context, token } = await ownerWithBoard(browser)
  const { page: guest, context: guestContext } = await joinAsGuest(browser, token)
  await connected(guest)
  await drawStroke(guest, 220, 220)
  await drawStroke(guest, 420, 220)
  await expect.poll(async () => (await reading(owner))?.objects).toBe(2)

  const [signup] = await Promise.all([
    guestContext.waitForEvent('page'),
    guest.getByTestId('guest-signup').click(),
  ])
  await signup.waitForLoadState()
  expect(signup.url()).toContain('from=guest')
  await signup.getByTestId('email').fill(`convert.${Date.now()}@example.com`)
  await signup.getByTestId('password').fill('correct-horse-1')
  await signup.getByTestId('displayName').fill('Marcus Lee')
  await signup.getByTestId('submit').click()

  // The board tab upgrades in place.
  await expect(guest.getByTestId('guest-bar')).toHaveCount(0, { timeout: 15_000 })
  await connected(guest)
  expect((await reading(guest))?.objects).toBe(2)
  // And as an editor of the board, it can keep drawing.
  await drawStroke(guest, 320, 380)
  await expect.poll(async () => (await reading(owner))?.objects).toBe(3)

  await guestContext.close()
  await context.close()
})
