import { resolve } from 'node:path'
import { config as loadDotenv } from 'dotenv'
import { createApp } from './http/app.js'
import { env } from './lib/env.js'
import { logger } from './lib/logger.js'

/**
 * Phase 8 server: REST auth, boards, the op log and snapshots.
 *
 * The WebSocket gateway arrives in Phase 9 — per TRD §16, not before Phases
 * 2-8 are genuinely solid. Ops persist over REST until then, through the same
 * `OpService` the gateway will call.
 */

/*
 * The repo keeps ONE `.env` at the root, and this process runs from
 * `apps/server`. Plain `dotenv/config` resolves against the cwd and would find
 * nothing, so the path is explicit.
 *
 * A missing file is not an error: in CI the variables come from the workflow's
 * `env:` block and there is no `.env` to read. `override: false` means a real
 * environment variable always wins over the file.
 */
loadDotenv({ path: resolve(import.meta.dirname, '../../../.env'), override: false })

const app = createApp()

// Only listen when run directly, so integration tests can build their own app
// with supertest and never bind a port.
if (env().NODE_ENV !== 'test') {
  app.listen(env().PORT, () => {
    logger.info({ port: env().PORT }, 'CoBoard server listening')
  })
}

export { app, createApp }
