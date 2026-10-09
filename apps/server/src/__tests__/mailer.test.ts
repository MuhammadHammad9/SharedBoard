import { createServer, type Server, type Socket } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import nodemailer from 'nodemailer'
import { SmtpMailer } from '../lib/mailer.js'

/**
 * FR-AUTH-004 / FR-SHARE-004 delivery. The composition is checked against a
 * stub transport; the wire path against a minimal in-process SMTP server, so
 * `SMTP_URL` → Nodemailer → an SMTP conversation is exercised for real.
 */

const reset = {
  to: 'priya@example.com',
  displayName: 'Priya <script>',
  resetUrl: 'https://coboard.example.com/reset-password?token=abc',
  expiresInMinutes: 60,
}

describe('SmtpMailer', () => {
  it('composes the reset email, escaping the user-chosen name in HTML', async () => {
    const sent: Record<string, string>[] = []
    const mailer = new SmtpMailer(
      { sendMail: async (m: Record<string, string>) => void sent.push(m) } as never,
      'CoBoard <no-reply@coboard.example.com>',
    )
    await mailer.sendPasswordReset(reset)
    const [mail] = sent
    expect(mail).toMatchObject({
      from: 'CoBoard <no-reply@coboard.example.com>',
      to: 'priya@example.com',
      subject: 'Reset your CoBoard password',
    })
    expect(mail!.text).toContain(reset.resetUrl)
    expect(mail!.text).toContain('60 minutes')
    expect(mail!.html).toContain('Priya &#60;script&#62;')
    expect(mail!.html).not.toContain('<script>')
  })

  it('composes the invite email', async () => {
    const sent: Record<string, string>[] = []
    const mailer = new SmtpMailer(
      { sendMail: async (m: Record<string, string>) => void sent.push(m) } as never,
      'CoBoard <no-reply@coboard.example.com>',
    )
    await mailer.sendBoardInvite({
      to: 'marcus@example.com',
      inviterName: 'Priya Raman',
      boardName: 'Q3 Retro',
      role: 'VIEWER',
      url: 'https://coboard.example.com/signup?invite=1',
    })
    expect(sent[0]!.subject).toBe('Priya Raman invited you to a CoBoard board')
    expect(sent[0]!.text).toContain('view "Q3 Retro"')
    expect(sent[0]!.text).toContain('https://coboard.example.com/signup?invite=1')
  })

  it('composes the verification email, escaping the name — D-22', async () => {
    const sent: Record<string, string>[] = []
    const mailer = new SmtpMailer(
      { sendMail: async (m: Record<string, string>) => void sent.push(m) } as never,
      'CoBoard <no-reply@coboard.example.com>',
    )
    await mailer.sendEmailVerification({
      to: 'sam@example.com',
      displayName: 'Sam <b>',
      verifyUrl: 'https://coboard.example.com/verify-email?token=abc',
      expiresInHours: 24,
    })
    expect(sent[0]).toMatchObject({
      to: 'sam@example.com',
      subject: 'Confirm your CoBoard email address',
    })
    expect(sent[0]!.text).toContain('https://coboard.example.com/verify-email?token=abc')
    expect(sent[0]!.text).toContain('24 hours')
    expect(sent[0]!.html).toContain('Sam &#60;b&#62;')
  })

  describe('over a real SMTP conversation', () => {
    let server: Server | null = null
    afterEach(() => server?.close())

    it('delivers through SMTP_URL', async () => {
      const received: string[] = []
      server = createServer((socket: Socket) => {
        let inData = false
        let buffer = ''
        socket.write('220 test ESMTP\r\n')
        socket.on('data', chunk => {
          buffer += chunk.toString()
          let i
          while ((i = buffer.indexOf('\r\n')) >= 0) {
            const line = buffer.slice(0, i)
            buffer = buffer.slice(i + 2)
            if (inData) {
              if (line === '.') {
                inData = false
                socket.write('250 queued\r\n')
              } else received.push(line)
              continue
            }
            const cmd = line.slice(0, 4).toUpperCase()
            if (cmd === 'EHLO' || cmd === 'HELO') socket.write('250 test\r\n')
            else if (cmd === 'DATA') {
              inData = true
              socket.write('354 go\r\n')
            } else if (cmd === 'QUIT') socket.end('221 bye\r\n')
            else socket.write('250 ok\r\n')
          }
        })
      })
      await new Promise<void>(r => server!.listen(0, '127.0.0.1', r))
      const port = (server.address() as { port: number }).port

      const mailer = new SmtpMailer(
        nodemailer.createTransport(`smtp://127.0.0.1:${port}?ignoreTLS=true`),
        'CoBoard <no-reply@coboard.example.com>',
      )
      await mailer.sendPasswordReset(reset)

      // The body is quoted-printable: undo soft breaks and =XX escapes.
      const message = received
        .join('\n')
        .replace(/=\n/g, '')
        .replace(/=([0-9A-F]{2})/g, (_, hex: string) =>
          String.fromCharCode(parseInt(hex, 16)),
        )
      expect(message).toContain('To: priya@example.com')
      expect(message).toContain('Subject: Reset your CoBoard password')
      expect(message).toContain('reset-password?token=abc')
    })
  })
})
