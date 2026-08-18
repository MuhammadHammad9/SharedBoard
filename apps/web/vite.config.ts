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
        if (!file.startsWith(resolve(root, 'fixtures')) || !existsSync(file))
          return next()
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
    /*
     * Proxy the API through the dev server so the browser sees one origin.
     *
     * Same-origin in development is not a convenience: the refresh token is an
     * httpOnly SameSite=Lax cookie scoped to /api/auth, and a cross-origin
     * fetch to :3000 would need CORS credentials plus SameSite=None plus
     * Secure — a configuration that differs from production in exactly the
     * area most likely to break silently.
     */
    proxy: {
      '/api': {
        target: process.env.API_ORIGIN ?? 'http://localhost:3000',
        changeOrigin: false,
      },
    },
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
          /*
           * framer-motion is DELIBERATELY not assigned a manual chunk.
           *
           * Naming any chunk for it — even its own — makes Rollup treat it as
           * an eager part of the graph, and it lands in the initial download
           * for every page including the board. That silently undoes
           * R-SKILL-060 and conflict C-3: the library exists to animate the
           * dashboard grid and must arrive only when that grid does.
           *
           * Returning undefined leaves it to Rollup's automatic splitting,
           * which follows the dynamic `import()` in BoardGrid and emits it as
           * an async chunk. The measured cost of getting this wrong was
           * +58 KB gzipped on the initial bundle.
           */
          if (id.includes('framer-motion') || id.includes('motion-dom')) return undefined
          if (id.includes('react') || id.includes('scheduler')) return 'vendor-react'
          if (id.includes('zod')) return 'vendor-zod'
          return 'vendor'
        },
      },
    },
  },
})
