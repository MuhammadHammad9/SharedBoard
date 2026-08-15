import 'dotenv/config'
import express, { type Express } from 'express'
import pino from 'pino'
import { CLOSE_CODES, MAX_OBJECTS_PER_BOARD, ZOOM_MAX } from '@coboard/shared'

/**
 * Phase 1 server.
 *
 * A health endpoint and nothing else. Its job is to prove the workspace wiring:
 * the server imports @coboard/shared exactly as the client does (R-ARCH-007),
 * so a protocol change cannot drift between the two sides.
 *
 * REST routes arrive in Phase 7 (auth) and Phase 8 (boards). The WebSocket
 * gateway arrives in Phase 9 — and per TRD §16, not before Phases 2-8 are
 * genuinely solid.
 */

const logger = pino({
  transport:
    process.env.NODE_ENV === 'production'
      ? undefined
      : { target: 'pino-pretty', options: { colorize: true } },
})

const app: Express = express()
app.use(express.json({ limit: '1mb' }))

app.get('/health', (_req, res) => {
  res.json({
    status: 'ok',
    phase: 1,
    // Proves the shared package resolved on the server side.
    shared: {
      maxObjectsPerBoard: MAX_OBJECTS_PER_BOARD,
      zoomMax: ZOOM_MAX,
      closeCodeUnauthorized: CLOSE_CODES.UNAUTHORIZED,
    },
  })
})

const port = Number(process.env.PORT ?? 3000)

// Only listen when run directly, so tests can import the app.
if (process.env.NODE_ENV !== 'test') {
  app.listen(port, () => {
    logger.info({ port }, 'CoBoard server listening')
  })
}

export { app }
