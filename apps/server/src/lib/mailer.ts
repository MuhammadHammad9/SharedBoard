import { env } from './env.js'
import { logger } from './logger.js'

/**
 * Transactional email — FR-AUTH-004.
 *
 * An interface with a logging fallback, deliberately, and worth being explicit
 * about what is and is not real here.
 *
 * REAL: the reset token itself — generated with 256 bits of entropy, hashed at
 * rest, single-use, 60-minute expiry, invalidates every session on success.
 * All of that is implemented and integration-tested.
 *
 * NOT REAL: delivery. `SMTP_URL` is unset and this project has no mail
 * provider, so `LoggingMailer` writes the reset URL to the server log and
 * development copies it from there. Swapping in a Nodemailer or Resend
 * transport is a new class implementing `Mailer` plus one line in
 * `createMailer` — nothing else moves.
 *
 * The alternative was to pretend, by returning the token in the HTTP response
 * "for development". That is how a reset endpoint ships to production handing
 * out account-takeover tokens to anyone who knows an email address.
 */

export interface ResetEmail {
  to: string
  displayName: string
  resetUrl: string
  expiresInMinutes: number
}

export interface Mailer {
  sendPasswordReset(email: ResetEmail): Promise<void>
}

export class LoggingMailer implements Mailer {
  /** Captured in-process so integration tests can assert on what was sent. */
  readonly sent: ResetEmail[] = []

  async sendPasswordReset(email: ResetEmail): Promise<void> {
    this.sent.push(email)
    logger.info(
      { to: email.to, resetUrl: email.resetUrl },
      'password reset email (not delivered — no SMTP transport configured)',
    )
  }
}

let mailer: Mailer | null = null

export function createMailer(): Mailer {
  if (env().SMTP_URL) {
    // PHASE 15 SLOT: a real SMTP transport. Deliberately not stubbed with a
    // half-working implementation — an email that silently fails to send is
    // worse than one that was never configured, because nobody investigates.
    logger.warn('SMTP_URL is set but no SMTP transport is implemented yet')
  }
  return new LoggingMailer()
}

export function getMailer(): Mailer {
  mailer ??= createMailer()
  return mailer
}

/** Tests inject a spy. */
export function setMailer(next: Mailer | null): void {
  mailer = next
}
