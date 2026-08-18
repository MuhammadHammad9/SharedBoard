import type { Page } from '@playwright/test'

/**
 * Session stubs for the canvas suites.
 *
 * From Phase 8 the board route is behind `RequireAuth` (FLOWS §2.1), so every
 * suite that opens a board needs a session. Stubbing the refresh endpoint is
 * the right level: what these suites test is the renderer, the interaction
 * machine and the history stack, none of which care whether the token came
 * from a real login. Driving a real signup before each canvas test would add
 * ~300 ms of bcrypt per case and make the canvas suite depend on a database.
 *
 * The board itself is a SCRATCH board — an id that is not a uuid, which the
 * client treats as a local-only document in development (see useBoardLoad).
 * No board fetch happens, so there is nothing else to stub.
 */

export const TEST_USER = {
  id: '00000000-0000-4000-8000-000000000001',
  email: 'priya@example.com',
  displayName: 'Priya Raman',
  avatarUrl: null,
  hasPassword: true,
  createdAt: '2026-01-01T00:00:00.000Z',
}

export async function stubSession(page: Page): Promise<void> {
  await page.route('**/api/auth/refresh', route =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ accessToken: 'stub-access-token', user: TEST_USER }),
    }),
  )
  await page.route('**/api/auth/me', route =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ user: TEST_USER }),
    }),
  )
}
