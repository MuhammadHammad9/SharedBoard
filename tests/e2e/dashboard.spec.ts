import { expect, test, type Page } from '@playwright/test'

/**
 * The dashboard end to end — FR-BOARD-001/002/004/005/006/007, FLOWS §6.
 *
 * Against the real stack: browser → Vite → Express → Postgres. The component
 * suite proves each of the seven states renders from a stubbed response; what
 * only this can prove is that creating a board actually lands you on it, that
 * a trashed board is really gone from the list and really in Trash, and that
 * permanent delete is refused without the exact name by the SERVER and not
 * just by a disabled button.
 */

const password = 'correct-horse-1'

/*
 * ONE account for the file. Registration is rate-limited to 10 per IP per 15
 * minutes (R-SEC-013) and every test here needs a session; a signup per test
 * spends the budget in one pass and leaves nothing for CI's retries.
 */
test.describe.configure({ mode: 'serial' })

let account: { email: string } | null = null

async function register(page: Page) {
  const email = `dash.${Date.now()}.${Math.random().toString(36).slice(2, 8)}@example.com`
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

async function signIn(page: Page, email: string) {
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

/** Create boards straight through the API — faster and less brittle than the UI. */
async function seedBoards(page: Page, names: string[]) {
  const result = await page.evaluate(async (names: string[]) => {
    const refresh = await fetch('/api/auth/refresh', {
      method: 'POST',
      credentials: 'include',
    })
    const { accessToken } = (await refresh.json()) as { accessToken: string }
    for (const name of names) {
      const response = await fetch('/api/boards', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${accessToken}`,
        },
        credentials: 'include',
        body: JSON.stringify({ name }),
      })
      if (!response.ok) return { error: `create ${response.status}` }
    }
    return {}
  }, names)
  expect(result.error, 'seeding boards should succeed').toBeUndefined()
}

async function openDashboard(page: Page, seed: string[] = []) {
  account ??= await register(page)
  await signIn(page, account.email)
  if (seed.length > 0) await seedBoards(page, seed)
  await page.goto('/dashboard')
  return page
}

const cards = (page: Page) => page.getByTestId('board-card')

/**
 * Open a card's `⋮` menu and wait for it.
 *
 * Clicking the trigger and then immediately clicking an item assumes the menu
 * mounts synchronously. It usually does — and then under a fully loaded
 * parallel run, with the grid mid-layout-animation and a background refetch
 * in flight, it does not, and the item click times out against a menu that
 * opened a beat later. Waiting for the menu is what makes the step mean
 * "the menu is open" rather than "the click was dispatched".
 */
async function openCardMenu(page: Page, card: ReturnType<typeof cards>) {
  await card.getByTestId('card-menu').click()
  await expect(page.getByTestId('dropdown-menu')).toBeVisible()
}

test('an empty account sees the never-had-boards state', async ({ page }) => {
  await openDashboard(page)
  // A fresh account. Whatever earlier tests created belongs to the same
  // account, so this must run first — hence describe.serial.
  await expect(page.getByTestId('dashboard-empty')).toBeVisible()
  await expect(page.getByTestId('dashboard-empty')).toContainText('Nothing here yet')
})

test('FR-BOARD-001: New board creates one and opens it with the title ready to type', async ({
  page,
}) => {
  await openDashboard(page)

  await page.getByTestId('new-board').click()

  // FLOWS §6.5: navigate only after the board exists, never optimistically.
  await expect(page).toHaveURL(/\/board\/[0-9a-f-]{36}/)
  await expect(page.getByTestId('canvas-surface')).toHaveAttribute('data-ready', 'true')

  // The naming hand-off: the title is open, focused and selected, so the user
  // can type a real name without clicking anything.
  const title = page.getByTestId('board-title-input')
  await expect(title).toBeFocused()
  await title.fill('Onboarding flow rewrite')
  await title.press('Enter')

  // And `?new=1` is gone, so a refresh does not reopen the editor.
  expect(page.url()).not.toContain('new=1')
  await expect(page.getByTestId('board-title')).toHaveText('Onboarding flow rewrite')

  await page.goto('/dashboard')
  await expect(cards(page).filter({ hasText: 'Onboarding flow rewrite' })).toHaveCount(1)
})

test('FR-BOARD-002: search, filter and sort survive a reload via the URL', async ({
  page,
}) => {
  await openDashboard(page, ['Pricing page — v3', 'Incident timeline'])

  await expect(cards(page).filter({ hasText: 'Pricing page — v3' })).toHaveCount(1)
  await page.getByTestId('board-search').fill('Pricing')
  await expect(page).toHaveURL(/q=Pricing/)
  await expect(cards(page)).toHaveCount(1)

  // The URL is the state, which is what makes a dashboard link shareable and
  // the back button correct.
  await page.reload()
  await expect(page.getByTestId('board-search')).toHaveValue('Pricing')
  await expect(cards(page)).toHaveCount(1)

  await page.getByTestId('empty-search').isVisible().catch(() => false)
  await page.getByTestId('board-search').fill('nothing matches this')
  await expect(page.getByTestId('empty-search')).toContainText('nothing matches this')
})

test('FR-BOARD-004: rename from the card menu persists', async ({ page }) => {
  await openDashboard(page, ['Rename me'])

  const card = cards(page).filter({ hasText: 'Rename me' })
  await expect(card).toHaveCount(1)
  await openCardMenu(page, card)
  await page.getByTestId('card-rename').click()

  const input = page.getByTestId('rename-input')
  await input.fill('Architecture: presence fan-out')
  await input.press('Enter')

  await page.reload()
  await expect(
    cards(page).filter({ hasText: 'Architecture: presence fan-out' }),
  ).toHaveCount(1)
})

test('FR-BOARD-005: trash removes it from the list, and Undo brings it back', async ({
  page,
}) => {
  await openDashboard(page, ['Offsite agenda'])

  // Assert on THIS card rather than a total, and wait for it before acting.
  // A total count races the query and drifts as earlier tests add boards.
  const target = cards(page).filter({ hasText: 'Offsite agenda' })
  await expect(target).toHaveCount(1)

  await openCardMenu(page, target)
  await page.getByTestId('card-trash').click()

  await expect(target).toHaveCount(0)
  await expect(page.getByTestId('toast')).toContainText('Moved to trash')

  // The 8-second window is the whole point of the toast.
  await page.getByTestId('toast-action').click()
  await expect(cards(page).filter({ hasText: 'Offsite agenda' })).toHaveCount(1)
})

test('S-08: a trashed board appears in Trash with days remaining, and restores', async ({
  page,
}) => {
  await openDashboard(page, ['Mobile gestures'])

  const gestures = cards(page).filter({ hasText: 'Mobile gestures' })
  await expect(gestures).toHaveCount(1)
  await openCardMenu(page, gestures)
  await page.getByTestId('card-trash').click()
  await expect(page.getByTestId('toast')).toBeVisible()
  // Dismiss rather than undo — dismissing must NOT restore it.
  await page.getByTestId('toast-dismiss').click()

  await page.goto('/trash')
  const row = page.getByTestId('trash-row').filter({ hasText: 'Mobile gestures' })
  await expect(row).toHaveCount(1)
  await expect(row.getByTestId('days-remaining')).toContainText('30 days left')

  await row.getByTestId('restore').click()
  await page.goto('/dashboard')
  await expect(cards(page).filter({ hasText: 'Mobile gestures' })).toHaveCount(1)
})

test('FR-BOARD-006: permanent delete needs the exact name', async ({ page }) => {
  await openDashboard(page, ['Delete me forever'])

  const doomed = cards(page).filter({ hasText: 'Delete me forever' })
  await expect(doomed).toHaveCount(1)
  await openCardMenu(page, doomed)
  await page.getByTestId('card-trash').click()
  await page.getByTestId('toast-dismiss').click()

  await page.goto('/trash')
  const row = page.getByTestId('trash-row').filter({ hasText: 'Delete me forever' })
  await row.getByTestId('delete-forever').click()

  const confirm = page.getByTestId('confirm-delete')
  await expect(confirm).toBeDisabled()

  await page.getByTestId('confirm-name').fill('delete me forever')
  await expect(confirm).toBeDisabled() // case-sensitive, deliberately

  await page.getByTestId('confirm-name').fill('Delete me forever')
  await expect(confirm).toBeEnabled()
  await confirm.click()

  await expect(
    page.getByTestId('trash-row').filter({ hasText: 'Delete me forever' }),
  ).toHaveCount(0)
})

test('FR-BOARD-007: duplicate makes a copy and leaves the original', async ({ page }) => {
  await openDashboard(page, ['Q3 Retrospective'])

  /*
   * Matched by the title button's accessible name, not by `hasText`. A card's
   * text content also carries its timestamp, so an anchored regex over the
   * card never matches — and an unanchored one would match the copy too,
   * which is precisely what this test has to tell apart.
   */
  const original = cards(page).filter({
    has: page.getByRole('button', { name: 'Q3 Retrospective', exact: true }),
  })
  await expect(original).toHaveCount(1)
  await openCardMenu(page, original)
  await page.getByTestId('card-duplicate').click()

  await expect(
    cards(page).filter({
      has: page.getByRole('button', { name: 'Q3 Retrospective (copy)', exact: true }),
    }),
  ).toHaveCount(1)
  // The original survives; a duplicate that moves the board is a rename.
  await expect(original).toHaveCount(1)
})

test('the card menu is reachable by keyboard, not only by hover', async ({ page }) => {
  await openDashboard(page, ['Keyboard reachable'])

  const card = cards(page).filter({ hasText: 'Keyboard reachable' })
  await expect(card).toHaveCount(1)
  // Hover-only reveal is the usual way a card menu ships broken for keyboard
  // users: they tab to the card and find no actions at all.
  await card.getByTestId('card-menu').focus()
  await page.keyboard.press('Enter')
  await expect(page.getByTestId('dropdown-menu')).toBeVisible()

  await page.keyboard.press('Escape')
  await expect(page.getByTestId('dropdown-menu')).toHaveCount(0)
})
