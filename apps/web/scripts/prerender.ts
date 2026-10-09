/**
 * Post-build: prerender S-01 into dist/index.html — PRD §7.1 landing LCP.
 *
 * Emits two documents:
 *   dist/index.html  the landing page's markup inside #root — served for `/`
 *   dist/app.html    the untouched SPA shell — the fallback for every other route
 *
 * A host with per-path rules (infra/nginx/web.conf) serves each where it
 * belongs. A host that serves index.html for everything is covered too: a
 * one-line inline guard drops the prerendered markup before first paint on any
 * path but `/`. The sha256 of every inline script is written to
 * dist/csp-hashes.json so a CSP can allow them without 'unsafe-inline'.
 */
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { createServer } from 'vite'

const root = resolve(import.meta.dirname, '..')
const dist = resolve(root, 'dist')

const GUARD =
  "if(location.pathname!=='/'){var r=document.getElementById('root');r.innerHTML='';r.removeAttribute('data-prerendered')}"

const vite = await createServer({
  root,
  logLevel: 'error',
  server: { middlewareMode: true, hmr: false },
  appType: 'custom',
})
try {
  const { render } = (await vite.ssrLoadModule('/src/prerender.tsx')) as {
    render: () => string
  }
  const markup = render()
  const shell = readFileSync(resolve(dist, 'index.html'), 'utf8')
  if (!shell.includes('<div id="root"></div>'))
    throw new Error('no empty #root in dist/index.html')

  writeFileSync(resolve(dist, 'app.html'), shell)
  /*
   * The stylesheet, inlined for `/` only. On a slow link the render-blocking
   * CSS request shares bandwidth with ~130 KB of module JS that starts
   * downloading at the same moment, and that contention alone held FCP near
   * 1.9 s on Lighthouse's slow-4G profile. Inline, nothing render-blocking is
   * left behind the HTML. The other routes keep the cacheable file.
   */
  const cssLink = shell.match(/<link rel="stylesheet"[^>]*href="([^"]+\.css)"[^>]*>/)
  if (!cssLink) throw new Error('no stylesheet link in dist/index.html')
  const css = readFileSync(resolve(dist, `.${cssLink[1]}`), 'utf8')
  /*
   * App JS AFTER first paint, for `/` only. The prerendered page is complete
   * HTML whose links are real anchors, so nothing on it needs JavaScript to
   * work; the SPA takes over a moment later. Left as high-priority module
   * fetches in <head> (plus three modulepreloads), ~130 KB of JS competed
   * with the first paint for a slow link.
   */
  const entry = shell.match(/<script type="module" crossorigin src="([^"]+)"><\/script>/)
  if (!entry) throw new Error('no module entry in dist/index.html')
  const loader =
    "addEventListener('load',function(){var s=document.createElement('script');" +
    `s.type='module';s.crossOrigin='';s.src='${entry[1]}';document.head.appendChild(s)})`
  const inlined = shell
    .replace(cssLink[0], `<style>${css}</style>`)
    .replace(entry[0], `<script>${loader}</script>`)
    .replace(/\s*<link rel="modulepreload"[^>]*>/g, '')
  const landing = inlined.replace(
    '<div id="root"></div>',
    `<div id="root" data-prerendered>${markup}</div><script>${GUARD}</script>`,
  )
  writeFileSync(resolve(dist, 'index.html'), landing)

  const hashes = [
    ...landing.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g),
  ]
    .map(m => m[1]!)
    .filter(body => body.trim().length > 0)
    .map(body => `'sha256-${createHash('sha256').update(body).digest('base64')}'`)
  writeFileSync(
    resolve(dist, 'csp-hashes.json'),
    JSON.stringify({ 'script-src': [...new Set(hashes)] }, null, 2) + '\n',
  )
  console.log(
    `[prerender] S-01 → dist/index.html (${(markup.length / 1024).toFixed(1)} KB), shell → dist/app.html`,
  )
} finally {
  await vite.close()
}
