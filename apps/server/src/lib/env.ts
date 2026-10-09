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
  // The From header for transactional email. Set it to an address your SMTP
  // provider is authorized to send for (SPF/DKIM), or mail lands in spam.
  MAIL_FROM: z.string().min(3).default('CoBoard <no-reply@coboard.local>'),

  // FR-CANVAS-010 / FR-BOARD-003 — S3-compatible object storage (TRD §4.4).
  // Absent → uploads answer 503 rather than issuing a URL to nowhere.
  S3_ENDPOINT: z.string().url().optional(),
  S3_REGION: z.string().min(1).default('us-east-1'),
  S3_BUCKET: z.string().min(1).default('coboard'),
  S3_ACCESS_KEY: z.string().optional(),
  S3_SECRET_KEY: z.string().optional(),
  // Where objects are READ from, if not `${S3_ENDPOINT}/${S3_BUCKET}` — a CDN.
  S3_PUBLIC_URL: z.string().url().optional(),

  /*
   * Phase 15e — the bearer token Prometheus presents to `GET /metrics`.
   * Set: the endpoint requires `Authorization: Bearer <token>`. Unset: open in
   * development and test, and DISABLED in production, because the metrics name
   * routes, error rates and pool sizes — a reconnaissance map nobody should get
   * for free. 16 characters minimum, like the JWT secrets.
   */
  METRICS_TOKEN: z.string().min(16).optional(),

  /*
   * R-SEC-013: registrations per IP per 15 minutes. 10 is the rule. The e2e
   * suite registers an account per spec file from one address and would
   * exhaust it mid-run, so its servers raise this — never production, which
   * refuses any value above 10 at boot (see loadEnv).
   */
  REGISTER_RATE_LIMIT: z.coerce.number().int().positive().default(10),

  /*
   * R-SEC-013 on the REST op path (finding 4): ops per second per identity,
   * the same budget a socket session gets. The e2e suite seeds 5,000-object
   * boards through this endpoint in back-to-back 200-op batches and raises it
   * for that; production refuses any value above the default at boot.
   */
  REST_OPS_RATE_LIMIT: z.coerce.number().int().positive().default(100),
})

export type Env = z.infer<typeof EnvSchema>

let cached: Env | null = null

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  // `.env.example` lists optional keys with empty values (`S3_ENDPOINT=`).
  // An empty string means "not set", not "an invalid URL".
  const present = Object.fromEntries(
    Object.entries(source).filter(([, value]) => value !== ''),
  )
  const parsed = EnvSchema.safeParse(present)
  if (!parsed.success) {
    const missing = parsed.error.issues.map(i => i.path.join('.')).join(', ')
    throw new Error(
      `Invalid environment. Check these variables against .env.example: ${missing}`,
    )
  }
  if (parsed.data.NODE_ENV === 'production' && parsed.data.REGISTER_RATE_LIMIT > 10) {
    throw new Error(
      'REGISTER_RATE_LIMIT may not exceed 10 in production (R-SEC-013); ' +
        'raised limits exist for the e2e suite only.',
    )
  }
  if (parsed.data.NODE_ENV === 'production' && parsed.data.REST_OPS_RATE_LIMIT > 100) {
    throw new Error(
      'REST_OPS_RATE_LIMIT may not exceed 100 in production (R-SEC-013); ' +
        'raised limits exist for the e2e suite only.',
    )
  }
  /*
   * Finding 15: without SMTP, the mailer falls back to LOGGING every email —
   * password-reset and verification links included. In development that is
   * how the link is found; in production it writes account-takeover tokens to
   * the log pipeline and delivers nothing. So production does not boot.
   */
  if (parsed.data.NODE_ENV === 'production' && !parsed.data.SMTP_URL) {
    throw new Error(
      'SMTP_URL must be set in production: without it password-reset and ' +
        'verification emails are written to the log instead of delivered.',
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

export const storageConfigured = (): boolean =>
  Boolean(env().S3_ENDPOINT && env().S3_ACCESS_KEY && env().S3_SECRET_KEY)

export const googleConfigured = (): boolean =>
  Boolean(env().GOOGLE_CLIENT_ID && env().GOOGLE_CLIENT_SECRET)
