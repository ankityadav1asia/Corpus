import 'server-only'

import nodemailer from 'nodemailer'

import type { EmailConfig } from '@/server/env'

export interface EmailSender {
  sendOtp(to: string, code: string, ttlMinutes: number): Promise<void>
}

function otpHtml(code: string, ttlMinutes: number) {
  // `code` is always six digits, so there is nothing to escape.
  return `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#0b1120;padding:40px 24px;max-width:520px;margin:0 auto;border-radius:16px;color:#f8fafc">
  <h1 style="font-size:20px;font-weight:600;margin:0 0 24px;text-align:center">Your Corpus sign-in code</h1>
  <div style="background:#1e293b;border:1px solid #334155;border-radius:12px;padding:32px;text-align:center">
    <div style="font-size:40px;font-weight:800;letter-spacing:12px;color:#f59e0b;font-family:'Courier New',monospace">${code}</div>
    <p style="color:#94a3b8;font-size:12px;margin:16px 0 0">Expires in ${ttlMinutes} minutes.</p>
  </div>
  <p style="color:#64748b;font-size:12px;text-align:center;margin:24px 0 0">If you did not request this code you can ignore this email. Never share it with anyone.</p>
</div>`
}

export function createEmailSender(config: EmailConfig | null): EmailSender | null {
  if (!config) return null
  const subject = 'Your Corpus sign-in code'

  if (config.kind === 'resend') {
    return {
      async sendOtp(to, code, ttlMinutes) {
        const response = await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: { Authorization: `Bearer ${config.apiKey}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            from: config.from,
            to: [to],
            subject,
            html: otpHtml(code, ttlMinutes),
            text: `Your Corpus sign-in code is ${code}. It expires in ${ttlMinutes} minutes.`,
          }),
          signal: AbortSignal.timeout(10_000),
        })
        if (!response.ok) throw new Error(`Resend responded with HTTP ${response.status}`)
      },
    }
  }

  const transporter = nodemailer.createTransport({
    host: config.host,
    port: config.port,
    secure: config.port === 465,
    auth: { user: config.user, pass: config.pass },
  })
  return {
    async sendOtp(to, code, ttlMinutes) {
      await transporter.sendMail({
        from: config.from,
        to,
        subject,
        html: otpHtml(code, ttlMinutes),
        text: `Your Corpus sign-in code is ${code}. It expires in ${ttlMinutes} minutes.`,
      })
    },
  }
}
