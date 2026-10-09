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

const chromium = {
  ...devices['Desktop Chrome'],
  ...(chromiumExecutable
    ? { launchOptions: { executablePath: chromiumExecutable } }
    : {}),
}

/** Frame-rate, budget, soak and five-user specs: run alone, after the rest. */
const PERF_SPECS = [
  /canvas-performance\.spec\.ts/,
  /budgets\.spec\.ts/,
  /memory\.spec\.ts/,
  /realtime\.spec\.ts/,
  // Owns its own API and Vite processes on spare ports, and kills one.
  /restart\.spec\.ts/,
]

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
  /*
   * Stroke screenshots compare against ONE golden for every browser — no
   * {projectName} in the path — so Firefox and WebKit are judged against what
   * Chromium draws (TRD §13.3: "strokes must look identical").
   */
  snapshotPathTemplate: '{testDir}/__screenshots__/{testFilePath}/{arg}{ext}',
  projects: [
    {
      name: 'chromium',
      // The CPU-hungry specs run in `perf`, after this project and on one
      // worker. Run in parallel beside the 10,000-object stress board they
      // starved the timing-sensitive tests (Phase 15g, P15-9).
      testIgnore: PERF_SPECS,
      use: chromium,
    },
    {
      name: 'perf',
      testMatch: PERF_SPECS,
      use: chromium,
    },
    ...(process.env.E2E_CROSS_BROWSER
      ? [
          {
            name: 'firefox',
            testMatch: /cross-browser\.spec\.ts/,
            use: { ...devices['Desktop Firefox'] },
          },
          {
            name: 'webkit',
            testMatch: /cross-browser\.spec\.ts/,
            use: { ...devices['Desktop Safari'] },
          },
        ]
      : []),
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
          // Image uploads and thumbnails need storage (Phase 13, D13-3).
          command: 'pnpm --filter @coboard/server dev:s3',
          url: 'http://127.0.0.1:4569/',
          reuseExistingServer: !process.env.CI,
          timeout: 60_000,
        },
        {
          command: 'pnpm --filter @coboard/server dev',
          url: 'http://localhost:3000/health',
          reuseExistingServer: !process.env.CI,
          timeout: 60_000,
          // Each spec file registers its own account from 127.0.0.1; the
          // production limit of 10 per 15 min ran out mid-suite (Phase 15g).
          env: { REGISTER_RATE_LIMIT: '1000', REST_OPS_RATE_LIMIT: '100000' },
        },
        {
          command: 'pnpm --filter @coboard/web dev',
          url: 'http://localhost:5173',
          reuseExistingServer: !process.env.CI,
          timeout: 60_000,
        },
      ],
})
