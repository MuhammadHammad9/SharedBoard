import { z } from 'zod'

/**
 * Environment, validated once at startup — R-SEC-003 applied to configuration.
 *
 * A missing `JWT_ACCESS_SECRET` must fail at boot with a message naming the
 * variable, not at 3am on the first refresh with `secretOrPrivateKey must have
 * a value`. Same reasoning as validating a request body: reject at the
 * boundary, never coerce, and make the failure legible.
 */
const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().min(1),

  /*
   * The two secrets MUST differ. If they are the same string, an access token
   * verifies as a refresh token and vice versa — which turns a 15-minute
   * credential the client hands to every API call into a 30-day one.
   */
  JWT_ACCESS_SECRET: z.string().min(16),
  JWT_REFRESH_SECRET: z.string().min(16),

  CLIENT_ORIGIN: z.string().url().default('http://localhost:5173'),

  // FR-AUTH-003. Absent in development; the routes then report OAUTH_FAILED
  // rather than redirecting to a Google URL with an empty client_id.
  GOOGLE_CLIENT_ID: z.string().optional(),
  GOOGLE_CLIENT_SECRET: z.string().optional(),
  GOOGLE_REDIRECT_URI: z.string().url().optional(),

  // FR-AUTH-004. Absent in development; the Mailer falls back to logging.
  SMTP_URL: z.string().optional(),
})

export type Env = z.infer<typeof EnvSchema>

let cached: Env | null = null

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = EnvSchema.safeParse(source)
  if (!parsed.success) {
    const missing = parsed.error.issues.map(i => i.path.join('.')).join(', ')
    throw new Error(
      `Invalid environment. Check these variables against .env.example: ${missing}`,
    )
  }
  if (parsed.data.JWT_ACCESS_SECRET === parsed.data.JWT_REFRESH_SECRET) {
    throw new Error(
      'JWT_ACCESS_SECRET and JWT_REFRESH_SECRET must differ — an identical ' +
        'pair lets an access token be replayed as a refresh token.',
    )
  }
  return parsed.data
}

export function env(): Env {
  cached ??= loadEnv()
  return cached
}

/** Tests reset the cache after mutating process.env. */
export function resetEnvCache(): void {
  cached = null
}

export const googleConfigured = (): boolean =>
  Boolean(env().GOOGLE_CLIENT_ID && env().GOOGLE_CLIENT_SECRET)
