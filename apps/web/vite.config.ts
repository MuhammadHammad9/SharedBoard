import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import { visualizer } from 'rollup-plugin-visualizer'
import { createReadStream, existsSync } from 'node:fs'
import { resolve } from 'node:path'

/**
 * Serve repo-root `fixtures/` over HTTP during development only.
 *
 * The 10,000-object stress board (PRD risk R-2, R-PERF-025) lives at the repo
 * root, outside this app's directory. Putting it in `public/` would copy 5.5 MB
 * into every production build and distort the bundle-size gate (C-4), so it is
 * streamed by dev middleware instead and never becomes a build input.
 */
function devFixtures(): Plugin {
  const root = resolve(__dirname, '../..')
  return {
    name: 'coboard-dev-fixtures',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (!req.url?.startsWith('/fixtures/')) return next()
        const file = resolve(root, '.' + req.url.split('?')[0])
        if (!file.startsWith(resolve(root, 'fixtures')) || !existsSync(file)) return next()
        res.setHeader('Content-Type', 'application/json')
        createReadStream(file).pipe(res)
      })
    },
  }
}

export default defineConfig({
  plugins: [
    react(),
    devFixtures(),
    // Emits bundle-report.json, consumed by scripts/check-bundle-size.ts (C-4).
    visualizer({
      filename: 'stats.html',
      gzipSize: true,
      template: 'treemap',
    }),
  ],
  resolve: {
    alias: {
      '@': resolve(__dirname, './src'),
    },
  },
  server: {
    port: 5173,
    strictPort: true,
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
    rollupOptions: {
      output: {
        // TRD §12.2: the landing and auth routes must not pull in the canvas
        // engine. Route-level lazy imports do most of this; these manual chunks
        // keep the vendor split stable so the size gate measures the same thing
        // build over build.
        manualChunks(id) {
          if (!id.includes('node_modules')) return undefined
          if (id.includes('react') || id.includes('scheduler')) return 'vendor-react'
          if (id.includes('zod')) return 'vendor-zod'
          return 'vendor'
        },
      },
    },
  },
})
