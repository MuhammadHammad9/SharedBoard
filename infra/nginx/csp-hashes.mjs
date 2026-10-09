// Emits an nginx `set` directive holding the CSP hash of every inline
// <script> in the built index.html, so the policy can stay `script-src 'self'`
// without 'unsafe-inline'. Run at image build time (apps/web/Dockerfile): the
// hashes then always match the HTML actually shipped, and editing index.html
// cannot silently break the page.
//
// Usage: node csp-hashes.mjs <dist/index.html> > csp-hashes.conf
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'

const html = readFileSync(process.argv[2], 'utf8')
const hashes = []
for (const [, attrs, body] of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)) {
  if (/\bsrc\s*=/.test(attrs)) continue
  hashes.push(`'sha256-${createHash('sha256').update(body, 'utf8').digest('base64')}'`)
}
process.stdout.write(`set $csp_script_hashes "${hashes.join(' ')}";\n`)
