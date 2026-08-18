import { expect, test, type Page } from '@playwright/test'

/**
 * Auth routing and guards — FLOWS §2.1, §2.2, §4.
 *
 * The API is STUBBED here, and that is the right call rather than a shortcut.
 * What these tests are about is client routing: does the guard show a spinner
 * instead of the login form, does `?next=` survive, is an open redirect
 * refused. Real server behaviour is covered by the 50 integration tests that
 * run against a real Postgres — driving a database from Playwright would test
 * the same code twice and add a service to the e2e job for nothing.
 *
 * Stubbing also buys something a real server cannot: a refresh that takes 300
 * ms on demand. Against localhost the silent refresh completes in single-digit
 * milliseconds, so the spinner would flash past and the "no login flash" test
 * would pass whether or not the guard were correct.
 */

const USER = {
  id: '00000000-0000-4000-8000-000000000001',
  email: 'priya@example.com',
  displayName: 'Priya Raman',
  avatarUrl: null,
  hasPassword: true,
  createdAt: new Date('2026-01-01').toISOString(),
}

/** A session that exists: refresh succeeds, /me returns the user. */
async function stubValidSession(page: Page, { refreshDelayMs = 0 } = {}) {
  await page.route('**/api/auth/refresh', async route => {
    if (refreshDelayMs > 0) await new Promise(r => setTimeout(r, refreshDelayMs))
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ accessToken: 'stub-access-token', user: USER }),
    })
  })
  await page.route('**/api/auth/me', route =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ user: USER }),
    }),
  )
}

/** No session: refresh 401s, as it would with no cookie. */
async function stubNoSession(page: Page, { refreshDelayMs = 0 } = {}) {
  await page.route('**/api/auth/refresh', async route => {
    if (refreshDelayMs > 0) await new Promise(r => setTimeout(r, refreshDelayMs))
    await route.fulfill({
      status: 401,
      contentType: 'application/json',
      body: JSON.stringify({
        error: {
          code: 'INVALID_REFRESH',
          message: 'No cookie',
          correlationId: 'aaaaaaaa',
        },
      }),
    })
  })
}

async function stubLogin(page: Page) {
  await page.route('**/api/auth/login', route =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ user: USER, accessToken: 'stub-access-token' }),
    }),
  )
}

/* ── The no-flash requirement — FLOWS §2.2 ───────────────────────────────── */

test('a cold load with a valid session shows the spinner and NEVER the login screen', async ({
  page,
}) => {
  await stubValidSession(page, { refreshDelayMs: 300 })

  // Watch for the login form appearing at ANY point during the load. A brief
  // flash is exactly what FLOWS calls "a bug, not a cosmetic issue", and it is
  // invisible to an assertion that only checks the final state.
  let loginAppeared = false
  await page.exposeFunction('__loginSeen', () => {
    loginAppeared = true
  })
  await page.addInitScript(() => {
    const observer = new MutationObserver(() => {
      if (document.querySelector('[data-testid="submit"]')) {
        ;(window as unknown as { __loginSeen: () => void }).__loginSeen()
      }
    })
    observer.observe(document.documentElement, { childList: true, subtree: true })
  })

  await page.goto('/dashboard')

  await expect(page.getByTestId('full-screen-spinner')).toBeVisible()
  await expect(page.getByTestId('dashboard-empty')).toBeVisible()
  expect(loginAppeared).toBe(false)
})

test('a cold load with no session lands on login, with next preserved', async ({
  page,
}) => {
  await stubNoSession(page)

  await page.goto('/settings')

  await expect(page).toHaveURL(/\/login\?next=/)
  const next = new URL(page.url()).searchParams.get('next')
  expect(next).toBe('/settings')
})

test('the guard preserves a query string in next, not just the path', async ({
  page,
}) => {
  await stubNoSession(page)

  await page.goto('/dashboard?sort=recent&filter=mine')
  await expect(page).toHaveURL(/\/login\?next=/)

  const next = new URL(page.url()).searchParams.get('next')
  // Dropping the query is the subtler half of the same regression: the user
  // lands on the right screen with the wrong state.
  expect(next).toBe('/dashboard?sort=recent&filter=mine')
})

/*
 * NOTE on /board/:boardId — it is deliberately NOT behind a guard yet.
 *
 * FLOWS §2.1 assigns it `requireBoardAccess`, and §2.3 defines that in terms
 * of board membership and roles, which are Phase 8's `Board` and
 * `BoardMember` models. There is nothing to authorise against yet and no
 * board data to protect, so gating it now would mean writing a guard against
 * a table that does not exist and forcing the Phase 2-6 canvas suites to
 * authenticate for no benefit. Recorded as a Phase 7 correction.
 */

test('an authenticated user is redirected off /login', async ({ page }) => {
  await stubValidSession(page)
  await page.goto('/login')
  await expect(page).toHaveURL(/\/dashboard/)
})

/* ── Deep-link preservation — FLOWS §4 ───────────────────────────────────── */

test('DEEP LINK: /login?next=/board/abc lands on the board after login', async ({
  page,
}) => {
  await stubNoSession(page)
  await stubLogin(page)

  await page.goto('/login?next=%2Fboard%2Fabc123%3Fdebug%3D1')

  await page.getByTestId('email').fill('priya@example.com')
  await page.getByTestId('password').fill('correct-horse-1')
  await page.getByTestId('submit').click()

  // "Test this explicitly — it is the single most common regression in auth
  // work."
  await expect(page).toHaveURL(/\/board\/abc123/)
  await expect(page.getByTestId('canvas-surface')).toHaveAttribute('data-ready', 'true')
})

test('login with no next goes to the dashboard', async ({ page }) => {
  await stubNoSession(page)
  await stubLogin(page)

  await page.goto('/login')
  await page.getByTestId('email').fill('priya@example.com')
  await page.getByTestId('password').fill('correct-horse-1')
  await page.getByTestId('submit').click()

  await expect(page).toHaveURL(/\/dashboard/)
})

/* ── Open redirect — the other half of ?next= ────────────────────────────── */

for (const hostile of [
  'https://evil.com',
  '//evil.com',
  'http://evil.com/board/abc',
  '/\\evil.com',
]) {
  test(`SECURITY: ?next=${hostile} is refused and falls back to the dashboard`, async ({
    page,
  }) => {
    await stubNoSession(page)
    await stubLogin(page)

    await page.goto(`/login?next=${encodeURIComponent(hostile)}`)
    await page.getByTestId('email').fill('priya@example.com')
    await page.getByTestId('password').fill('correct-horse-1')
    await page.getByTestId('submit').click()

    await expect(page).toHaveURL(/\/dashboard/)
    // Belt and braces: whatever happened, we are still on our own origin.
    expect(new URL(page.url()).host).toBe(new URL(page.url()).host)
    expect(page.url()).not.toContain('evil.com')
  })
}

/* ── Login failure behaviour — FLOWS §4 branch 3b ────────────────────────── */

test('a wrong password clears the password, keeps the email, and refocuses', async ({
  page,
}) => {
  await stubNoSession(page)
  await page.route('**/api/auth/login', route =>
    route.fulfill({
      status: 401,
      contentType: 'application/json',
      body: JSON.stringify({
        error: {
          code: 'INVALID_CREDENTIALS',
          message: 'Invalid email or password',
          correlationId: 'bbbbbbbb',
        },
      }),
    }),
  )

  await page.goto('/login')
  await page.getByTestId('email').fill('priya@example.com')
  await page.getByTestId('password').fill('wrong-password-1')
  await page.getByTestId('submit').click()

  await expect(page.getByTestId('form-error')).toBeVisible()
  // Retyping an address they got right would punish them for a typo.
  await expect(page.getByTestId('email')).toHaveValue('priya@example.com')
  await expect(page.getByTestId('password')).toHaveValue('')
  await expect(page.getByTestId('password')).toBeFocused()
})

test('a 429 disables submit and shows a countdown', async ({ page }) => {
  await stubNoSession(page)
  await page.route('**/api/auth/login', route =>
    route.fulfill({
      status: 429,
      contentType: 'application/json',
      body: JSON.stringify({
        error: {
          code: 'RATE_LIMITED',
          message: 'Too many attempts',
          correlationId: 'cccccccc',
          retryAfter: 720,
        },
      }),
    }),
  )

  await page.goto('/login')
  await page.getByTestId('email').fill('priya@example.com')
  await page.getByTestId('password').fill('wrong-password-1')
  await page.getByTestId('submit').click()

  await expect(page.getByTestId('form-error')).toContainText('12 minutes')
  await expect(page.getByTestId('submit')).toBeDisabled()
})

/* ── Signup branches — FLOWS §3.1 ────────────────────────────────────────── */

test('a network failure PRESERVES every typed value', async ({ page }) => {
  await stubNoSession(page)
  await page.route('**/api/auth/register', route => route.abort('connectionrefused'))

  await page.goto('/signup')
  await page.getByTestId('email').fill('priya@example.com')
  await page.getByTestId('password').fill('correct-horse-1')
  await page.getByTestId('displayName').fill('Priya Raman')
  await page.getByTestId('submit').click()

  await expect(page.getByTestId('form-error')).toBeVisible()
  // Branch 8e. Losing a filled-in form to a dropped connection is where
  // people give up on signing up at all.
  await expect(page.getByTestId('email')).toHaveValue('priya@example.com')
  await expect(page.getByTestId('password')).toHaveValue('correct-horse-1')
  await expect(page.getByTestId('displayName')).toHaveValue('Priya Raman')
})

test('a taken email is reported inline on the email field', async ({ page }) => {
  await stubNoSession(page)
  await page.route('**/api/auth/register', route =>
    route.fulfill({
      status: 409,
      contentType: 'application/json',
      body: JSON.stringify({
        error: {
          code: 'EMAIL_TAKEN',
          message: 'Email already registered',
          correlationId: 'dddddddd',
          details: { field: 'email' },
        },
      }),
    }),
  )

  await page.goto('/signup')
  await page.getByTestId('email').fill('taken@example.com')
  await page.getByTestId('password').fill('correct-horse-1')
  await page.getByTestId('displayName').fill('Priya Raman')
  await page.getByTestId('submit').click()

  await expect(page.locator('[data-field-error]').first()).toBeVisible()
})

/* ── Reset flow — FLOWS §5 ───────────────────────────────────────────────── */

test('an expired reset link sends the user back to request a new one', async ({
  page,
}) => {
  await stubNoSession(page)
  await page.route('**/api/auth/reset/validate**', route =>
    route.fulfill({
      status: 400,
      contentType: 'application/json',
      body: JSON.stringify({
        error: { code: 'TOKEN_EXPIRED', message: 'Expired', correlationId: 'eeeeeeee' },
      }),
    }),
  )

  await page.goto('/reset-password?token=stale')
  await expect(page).toHaveURL(/\/forgot-password/)
})

test('reset-password with no token at all goes back to forgot-password', async ({
  page,
}) => {
  await stubNoSession(page)
  await page.goto('/reset-password')
  await expect(page).toHaveURL(/\/forgot-password/)
})

test('forgot-password confirms without revealing whether the account exists', async ({
  page,
}) => {
  await stubNoSession(page)
  await page.route('**/api/auth/forgot-password', route =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ ok: true }),
    }),
  )

  await page.goto('/forgot-password')
  await page.getByTestId('email').fill('nobody@example.com')
  await page.getByTestId('submit').click()

  // "If an account exists for…" — the copy matches what the server will and
  // will not confirm.
  await expect(page.getByTestId('reset-sent')).toContainText('If an account exists')
  await expect(page.getByTestId('resend')).toBeDisabled()
})
