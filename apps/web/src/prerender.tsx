import { renderToString } from 'react-dom/server'
import { StaticRouter } from 'react-router'
import Landing from './routes/Landing.js'

/**
 * Build-time render of S-01 — consumed by scripts/prerender.ts only, never
 * shipped to the browser.
 *
 * Why: PRD §7.1 budgets the landing LCP at ≤ 1.5 s on 4G. A client-rendered
 * page paints nothing until ~130 KB of JS has downloaded and run — measured at
 * ~2.1 s FCP on Lighthouse's slow-4G profile — so no amount of trimming gets a
 * pure SPA there. Static markup paints as soon as the HTML and CSS arrive, and
 * the SPA takes over when its JS lands (see main.tsx).
 */
export function render(): string {
  return renderToString(
    <StaticRouter location="/">
      <Landing />
    </StaticRouter>,
  )
}
