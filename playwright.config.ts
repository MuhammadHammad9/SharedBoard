import { defineConfig, devices } from '@playwright/test'

/**
 * Playwright — configured from Phase 1 because the convergence harness in
 * Phase 11 needs TWO browser contexts, and that shapes the config.
 *
 * TRD §13.2: "drive two browser contexts through 200 random operations, then
 * assert that the hashes match. This one test will catch more real bugs than
 * any other you write on this project."
 *
 * Browser resolution: CI installs browsers normally. Sandboxes that ship a
 * preinstalled Chromium whose build number does not match this @playwright/test
 * version can point at it instead, without a download:
 *
 *   PLAYWRIGHT_CHROMIUM_EXECUTABLE=/opt/pw-browsers/chromium pnpm test:e2e
 *
 * The path is never hardcoded here — that would break every other machine.
 */
const chromiumExecutable = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: process.env.CI ? [['github'], ['html', { open: 'never' }]] : [['list']],
  use: {
    baseURL: process.env.E2E_BASE_URL ?? 'http://localhost:5173',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        ...(chromiumExecutable
          ? { launchOptions: { executablePath: chromiumExecutable } }
          : {}),
      },
    },
  ],
  /*
   * TWO servers from Phase 8: Vite proxies /api to the API server, and the
   * persistence suite needs a real one behind it.
   *
   * The canvas suites do not — they run on a scratch board and stub auth — so
   * the API server starting is not a new dependency for them, only a new
   * process. Phase 8's own suite is the one that requires Postgres and Redis,
   * and it skips itself when they are absent rather than failing (see
   * tests/e2e/board-persistence.spec.ts).
   */
  webServer: process.env.E2E_NO_SERVER
    ? undefined
    : [
        {
          command: 'pnpm --filter @coboard/server dev',
          url: 'http://localhost:3000/health',
          reuseExistingServer: !process.env.CI,
          timeout: 60_000,
        },
        {
          command: 'pnpm --filter @coboard/web dev',
          url: 'http://localhost:5173',
          reuseExistingServer: !process.env.CI,
          timeout: 60_000,
        },
      ],
})
