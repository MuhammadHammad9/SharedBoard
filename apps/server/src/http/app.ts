import cookieParser from 'cookie-parser'
import cors from 'cors'
import express, { type Express } from 'express'
import { CLOSE_CODES, MAX_OBJECTS_PER_BOARD, ZOOM_MAX } from '@coboard/shared'
import { env } from '../lib/env.js'
import { createAuthRouter } from './routes/auth.js'
import { createBoardsRouter } from './routes/boards.js'
import { errorHandler, notFoundHandler } from './middleware/errorHandler.js'

/**
 * The Express application, built by a factory rather than created at import.
 *
 * A factory is what lets an integration test build an app after setting up its
 * environment, and build a second one without the first's state. It is also
 * what keeps `index.ts` free to decide whether to listen.
 */
export function createApp(): Express {
  const app = express()

  /*
   * `trust proxy` matters for correctness, not tidiness: without it `req.ip`
   * behind a load balancer is the balancer's address, so the per-IP rate limit
   * would count every user in the world as the same client and lock everyone
   * out at attempt 21.
   *
   * 1 = trust exactly one hop. Trusting all hops would let a client forge
   * X-Forwarded-For and rotate its way around the limit.
   */
  app.set('trust proxy', 1)

  /*
   * CORS with an explicit allow-list — R-SEC-014, no wildcards.
   *
   * `credentials: true` is required for the refresh cookie to travel at all,
   * and the spec forbids pairing that with `origin: '*'` — browsers reject the
   * combination outright, which is the standard doing us a favour.
   */
  app.use(
    cors({
      origin: env().CLIENT_ORIGIN,
      credentials: true,
    }),
  )

  // 1 MB: enough for any auth or board payload, small enough that a hostile
  // body cannot exhaust memory before Zod ever sees it.
  app.use(express.json({ limit: '1mb' }))
  app.use(cookieParser())

  app.get('/health', (_req, res) => {
    res.json({
      status: 'ok',
      phase: 8,
      // Proves the shared package resolved on the server side (R-ARCH-007).
      shared: {
        maxObjectsPerBoard: MAX_OBJECTS_PER_BOARD,
        zoomMax: ZOOM_MAX,
        closeCodeUnauthorized: CLOSE_CODES.UNAUTHORIZED,
      },
    })
  })

  app.use('/api/auth', createAuthRouter())
  app.use('/api/boards', createBoardsRouter())

  // Order matters: 404 for unmatched routes, then the error handler last, so
  // everything thrown anywhere above lands in one envelope (TRD §4).
  app.use(notFoundHandler)
  app.use(errorHandler)

  return app
}
