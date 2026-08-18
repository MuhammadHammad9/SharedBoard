import 'dotenv/config'
import { createApp } from './http/app.js'
import { env } from './lib/env.js'
import { logger } from './lib/logger.js'

/**
 * Phase 7 server: REST auth.
 *
 * Boards CRUD arrives in Phase 8, and the WebSocket gateway in Phase 9 — per
 * TRD §16, not before Phases 2–8 are genuinely solid.
 */

const app = createApp()

// Only listen when run directly, so integration tests can build their own app
// with supertest and never bind a port.
if (env().NODE_ENV !== 'test') {
  app.listen(env().PORT, () => {
    logger.info({ port: env().PORT }, 'CoBoard server listening')
  })
}

export { app, createApp }
