import pino, { type Logger } from 'pino'

export type { Logger }

/**
 * The test tap. Under `NODE_ENV=test` the logger writes to this in-memory
 * stream instead of stdout, so a suite can assert on what was logged — an op
 * rejection must carry its code, board, actor and correlation id (TRD §15.4),
 * and "it logs" is not something a reviewer can check by eye.
 *
 * With nobody listening the write is a no-op, and the default test level is
 * `silent`, so suites that never capture pay nothing.
 */
export type LogLine = Record<string, unknown>
const taps = new Set<(line: LogLine) => void>()
const testStream = {
  write(chunk: string): void {
    if (taps.size === 0) return
    let line: LogLine
    try {
      line = JSON.parse(chunk) as LogLine
    } catch {
      return
    }
    for (const tap of taps) tap(line)
  },
}

/**
 * The application logger.
 *
 * `redact` is not decoration: an auth service logs request bodies and error
 * objects constantly, and without this a single `logger.error({ body }, …)`
 * writes a plaintext password to disk. Redacting centrally means no call site
 * has to remember.
 */
const options: pino.LoggerOptions = {
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
}

export const logger: Logger =
  process.env.NODE_ENV === 'test' ? pino(options, testStream) : pino(options)

/**
 * Capture log lines at `level` and above until `stop()` — tests only.
 *
 * Child loggers take their parent's level when they are created, so start the
 * capture BEFORE the request or socket whose lines you want: a session opened
 * while the root was `silent` stays silent.
 */
export function captureLogs(level: pino.Level = 'warn'): {
  lines: LogLine[]
  stop: () => void
} {
  const lines: LogLine[] = []
  const previous = logger.level
  const tap = (line: LogLine) => lines.push(line)
  logger.level = level
  taps.add(tap)
  return {
    lines,
    stop: () => {
      taps.delete(tap)
      logger.level = previous
    },
  }
}
