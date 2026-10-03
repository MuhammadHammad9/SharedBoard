import createDOMPurify from 'dompurify'
import { JSDOM } from 'jsdom'

/**
 * SVG sanitization — R-SEC-011, PRD §7.4, TRD §11.
 *
 * An SVG is a document, not a picture: it can carry `<script>`, `onload=`,
 * and references to other origins. Served from our bucket and opened directly,
 * it runs script on that origin. DOMPurify (as the TRD requires) with three
 * additions beyond its SVG profile:
 *
 *   - no `<style>` elements and no `<foreignObject>` — CSS can `@import` and
 *     `url()` other origins, and foreignObject embeds arbitrary HTML
 *   - every `href` / `xlink:href` must be a same-document fragment (`#id`)
 *   - no `style` attribute that reaches out with `url(...)` to anything but a
 *     fragment
 *
 * Returns null when nothing recognisable as an SVG survives.
 */

const window = new JSDOM('').window
const purify = createDOMPurify(window as unknown as Parameters<typeof createDOMPurify>[0])

const EXTERNAL_URL = /url\(\s*(['"]?)(?!#)/i

purify.addHook('uponSanitizeAttribute', (_node, data) => {
  const name = data.attrName.toLowerCase()
  const value = data.attrValue.trim()
  if ((name === 'href' || name === 'xlink:href') && !value.startsWith('#')) {
    data.keepAttr = false
  }
  if (name === 'style' && EXTERNAL_URL.test(value)) data.keepAttr = false
  if (name.startsWith('on')) data.keepAttr = false
})

export function sanitizeSvg(source: string): string | null {
  const clean = purify.sanitize(source, {
    USE_PROFILES: { svg: true, svgFilters: true },
    FORBID_TAGS: ['style', 'foreignObject', 'script'],
    // Whole document back, not a fragment, so the root <svg> survives intact.
    WHOLE_DOCUMENT: false,
  })
  return /<svg[\s>]/i.test(clean) ? clean : null
}
