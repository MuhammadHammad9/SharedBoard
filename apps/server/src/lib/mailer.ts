import nodemailer, { type Transporter } from 'nodemailer'
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
 * DELIVERY: with `SMTP_URL` set, `SmtpMailer` sends through any SMTP relay
 * (SES, Postmark, Mailgun, a local Mailpit) via Nodemailer. Without it —
 * development and the test suite — `LoggingMailer` writes the URL to the
 * server log and development copies it from there. A production boot
 * without `SMTP_URL` logs an error, because nobody would get a reset email.
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

/** FR-SHARE-004: an invite to an address with no account yet. */
export interface InviteEmail {
  to: string
  inviterName: string
  boardName: string
  role: 'EDITOR' | 'VIEWER'
  /** Signup, then straight to the board — the invite is claimed at signup. */
  url: string
}

export interface Mailer {
  sendPasswordReset(email: ResetEmail): Promise<void>
  sendBoardInvite(email: InviteEmail): Promise<void>
}

export class LoggingMailer implements Mailer {
  /** Captured in-process so integration tests can assert on what was sent. */
  readonly sent: ResetEmail[] = []
  readonly invites: InviteEmail[] = []

  async sendPasswordReset(email: ResetEmail): Promise<void> {
    this.sent.push(email)
    logger.info(
      { to: email.to, resetUrl: email.resetUrl },
      'password reset email (not delivered — no SMTP transport configured)',
    )
  }

  async sendBoardInvite(email: InviteEmail): Promise<void> {
    this.invites.push(email)
    logger.info(
      { to: email.to, board: email.boardName, url: email.url },
      'board invite email (not delivered — no SMTP transport configured)',
    )
  }
}

/** Minimal HTML escaping for the one user-controlled value we interpolate. */
const escapeHtml = (value: string): string =>
  value.replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`)

/**
 * Real delivery — Phase 15 audit. Plain text first (it is what every client
 * renders and what spam filters trust), with a minimal HTML alternative. The
 * display names in these messages are user-chosen, so the HTML part escapes
 * them; nothing user-controlled ever reaches a header but the recipient.
 */
export class SmtpMailer implements Mailer {
  constructor(
    private readonly transport: Pick<Transporter, 'sendMail'>,
    private readonly from: string,
  ) {}

  async sendPasswordReset(email: ResetEmail): Promise<void> {
    const text =
      `Hi ${email.displayName},\n\n` +
      `Someone asked to reset the password for your CoBoard account. ` +
      `This link works once, for ${email.expiresInMinutes} minutes:\n\n` +
      `${email.resetUrl}\n\n` +
      `If it wasn't you, ignore this email — your password stays the same.`
    await this.transport.sendMail({
      from: this.from,
      to: email.to,
      subject: 'Reset your CoBoard password',
      text,
      html:
        `<p>Hi ${escapeHtml(email.displayName)},</p>` +
        `<p>Someone asked to reset the password for your CoBoard account. ` +
        `This link works once, for ${email.expiresInMinutes} minutes:</p>` +
        `<p><a href="${escapeHtml(email.resetUrl)}">Reset your password</a></p>` +
        `<p>If it wasn't you, ignore this email — your password stays the same.</p>`,
    })
    logger.info({ kind: 'password_reset' }, 'email sent')
  }

  async sendBoardInvite(email: InviteEmail): Promise<void> {
    const role = email.role === 'EDITOR' ? 'edit' : 'view'
    const text =
      `${email.inviterName} invited you to ${role} "${email.boardName}" on CoBoard.\n\n` +
      `Create your account to open it:\n\n${email.url}`
    await this.transport.sendMail({
      from: this.from,
      to: email.to,
      subject: `${email.inviterName} invited you to a CoBoard board`,
      text,
      html:
        `<p>${escapeHtml(email.inviterName)} invited you to ${role} ` +
        `<strong>${escapeHtml(email.boardName)}</strong> on CoBoard.</p>` +
        `<p><a href="${escapeHtml(email.url)}">Create your account to open it</a></p>`,
    })
    logger.info({ kind: 'board_invite' }, 'email sent')
  }
}

let mailer: Mailer | null = null

export function createMailer(): Mailer {
  const { SMTP_URL, MAIL_FROM, NODE_ENV } = env()
  if (SMTP_URL) return new SmtpMailer(nodemailer.createTransport(SMTP_URL), MAIL_FROM)
  if (NODE_ENV === 'production') {
    logger.error(
      'SMTP_URL is not set: password-reset and invite emails will NOT be delivered',
    )
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
