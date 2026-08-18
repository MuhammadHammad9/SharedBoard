import pino from 'pino'

/**
 * The application logger.
 *
 * `redact` is not decoration: an auth service logs request bodies and error
 * objects constantly, and without this a single `logger.error({ body }, …)`
 * writes a plaintext password to disk. Redacting centrally means no call site
 * has to remember.
 */
export const logger = pino({
  level: process.env.LOG_LEVEL ?? (process.env.NODE_ENV === 'test' ? 'silent' : 'info'),
  redact: {
    paths: [
      'password',
      'newPassword',
      'currentPassword',
      '*.password',
      'req.body.password',
      'req.body.newPassword',
      'req.body.currentPassword',
      'req.headers.authorization',
      'req.headers.cookie',
      'token',
      'accessToken',
      'refreshToken',
    ],
    censor: '[redacted]',
  },
  transport:
    process.env.NODE_ENV === 'development'
      ? { target: 'pino-pretty', options: { colorize: true } }
      : undefined,
})
