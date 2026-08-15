import { defineConfig } from 'vitest/config'
import { resolve } from 'node:path'

export default defineConfig({
  resolve: {
    alias: {
      '@coboard/shared': resolve(__dirname, 'packages/shared/src/index.ts'),
    },
  },
  test: {
    globals: true,
    environment: 'node',
    include: ['**/*.{test,spec}.{ts,tsx}'],
    exclude: ['**/node_modules/**', '**/dist/**', 'tests/e2e/**'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      // TRD §13.1 target: 80% of lib, geometry, history, sync. Those modules
      // arrive in later phases; thresholds are enabled when they exist.
      include: ['packages/shared/src/**', 'apps/*/src/**', 'scripts/**'],
    },
  },
})
