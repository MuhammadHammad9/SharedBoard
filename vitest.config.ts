import { defineConfig } from 'vitest/config'
import { resolve } from 'node:path'

const alias = {
  '@coboard/shared': resolve(__dirname, 'packages/shared/src/index.ts'),
}

const INTEGRATION = '**/*.integration.test.ts'

/**
 * Two projects, split on one axis: does the file share a database?
 *
 * Unit and component files are pure and run in parallel. Integration files run
 * against the SAME Postgres and the SAME Redis, and each one truncates the
 * tables it owns between cases. Run in parallel they would delete each other's
 * rows mid-test, producing failures that depend on thread scheduling and
 * disappear when you re-run them — the worst possible kind.
 *
 * The integration project runs in ONE forked process (`singleFork`), which
 * serialises its files while the unit project keeps its full parallelism.
 * `fileParallelism: false` looks like the obvious knob and is not: Vitest 3
 * honours it only at the root, where it would serialise all 24 unit files too
 * and roughly double the suite's wall time.
 */
export default defineConfig({
  resolve: { alias },
  test: {
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      // TRD §13.1 target: 80% of lib, geometry, history, sync.
      include: ['packages/shared/src/**', 'apps/*/src/**', 'scripts/**'],
    },
    projects: [
      {
        resolve: { alias },
        test: {
          name: 'unit',
          globals: true,
          environment: 'node',
          setupFiles: ['./vitest.setup.ts'],
          include: ['**/*.{test,spec}.{ts,tsx}'],
          exclude: ['**/node_modules/**', '**/dist/**', 'tests/e2e/**', INTEGRATION],
        },
      },
      {
        resolve: { alias },
        test: {
          name: 'integration',
          globals: true,
          environment: 'node',
          setupFiles: ['./vitest.setup.ts'],
          include: [INTEGRATION],
          exclude: ['**/node_modules/**', '**/dist/**'],
          pool: 'forks',
          poolOptions: { forks: { singleFork: true } },
        },
      },
    ],
  },
})
