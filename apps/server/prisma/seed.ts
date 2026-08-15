/**
 * Database seed.
 *
 * Phase 1: a stub. The 10,000-object stress board required by PRD risk R-2 is
 * committed as a FIXTURE at `fixtures/stress-board.json` (see
 * scripts/generate-stress-board.ts), because the Board and Operation models do
 * not exist until Phase 8.
 *
 * Phase 8 replaces this stub with a seed that loads the fixture into the
 * database, and adds realistic board and member names per R-UI-060 (no
 * "Test Board 1", no "John Doe" — the Jane Doe effect).
 */

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const FIXTURE = resolve(import.meta.dirname, '../../../fixtures/stress-board.json')

async function main() {
  const fixture = JSON.parse(readFileSync(FIXTURE, 'utf8')) as { objects: unknown[] }

  console.log(`[seed] stress-board fixture present: ${fixture.objects.length} objects`)
  console.log('[seed] no models to seed yet — Board/Operation land in Phase 8')
}

main().catch(err => {
  console.error('[seed] failed:', err)
  process.exit(1)
})
