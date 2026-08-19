import { resolve } from 'node:path'
import { config as loadDotenv } from 'dotenv'
import { createApp } from './http/app.js'
import { env } from './lib/env.js'
import { logger } from './lib/logger.js'
import { attachGateway } from './ws/gateway.js'

/**
 * Phase 9 server: REST auth, boards, the op log, snapshots, and the WebSocket
 * gateway.
 *
 * The gateway and the REST op endpoint funnel into the SAME `OpService`, which
 * is the point of that service existing: TRD §5.4 fixes the order of
 * operations for appending an op, and two implementations of it is how a rule
 * gets enforced on one path and forgotten on the other.
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
  const server = app.listen(env().PORT, () => {
    logger.info({ port: env().PORT }, 'CoBoard server listening')
  })
  attachGateway(server, { fanout: true })
}

export { app, createApp }
