import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { visualizer } from 'rollup-plugin-visualizer'
import { resolve } from 'node:path'

export default defineConfig({
  plugins: [
    react(),
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
