'use client'

import { AlertCircle, ArrowRight, CheckCircle2, Github, Loader2, Mail, ShieldCheck } from 'lucide-react'
import { useRouter } from 'next/navigation'
import { useState, type FormEvent } from 'react'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { apiJson, errorMessage } from '@/lib/api-client'

const ERROR_MESSAGES: Record<string, string> = {
  google_not_configured: 'Google sign-in is not configured on this server.',
  github_not_configured: 'GitHub sign-in is not configured on this server.',
  google_token_failed: 'Google sign-in failed. Please try again.',
  github_token_failed: 'GitHub sign-in failed. Please try again.',
  google_no_email: 'Your Google account has no verified email address.',
  github_no_email: 'Your GitHub account has no verified primary email address.',
  oauth_denied: 'Sign-in was cancelled.',
  missing_code: 'Sign-in was interrupted. Please try again.',
  state_missing: 'Your sign-in session expired. Please try again.',
  state_invalid: 'The sign-in request could not be verified. Please try again.',
  provider_error: 'The identity provider did not respond. Please try again.',
  not_allowed: 'This account is not allowed to sign in.',
  schema_missing: 'The database is not initialised yet. Run `npm run db:migrate` on the server.',
  app_url_missing: 'Google/GitHub sign-in needs APP_URL in the server .env when running in production (e.g. APP_URL=http://localhost:3000).',
  auth_failed: 'Sign-in failed. Please try again.',
  server_error: 'A server error occurred. Please try again later.',
}

export interface LoginFormProps {
  next: string
  errorCode: string | null
  configError: string | null
  providers: { google: boolean; github: boolean; email: boolean }
}

function GoogleIcon() {
  return (
    <svg className="size-4" viewBox="0 0 24 24" aria-hidden>
      <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" />
      <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" />
      <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.06H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.94l2.85-2.22.81-.63z" />
      <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.06l3.66 2.84c.87-2.6 3.3-4.52 6.16-4.52z" />
    </svg>
  )
}

/** The single sign-in UI (the old app had two diverging copies: a page and a modal). */
export function LoginForm({ next, errorCode, configError, providers }: LoginFormProps) {
  const router = useRouter()
  const [email, setEmail] = useState('')
  const [code, setCode] = useState('')
  const [step, setStep] = useState<'email' | 'code'>('email')
  const [busy, setBusy] = useState<'email' | 'code' | 'google' | 'github' | null>(null)
  const [error, setError] = useState<string | null>(configError ?? (errorCode ? (ERROR_MESSAGES[errorCode] ?? ERROR_MESSAGES.auth_failed!) : null))
  const [notice, setNotice] = useState<string | null>(null)

  function oauth(provider: 'google' | 'github') {
    setBusy(provider)
    window.location.assign(`/api/auth/oauth/${provider}?next=${encodeURIComponent(next)}`)
  }

  async function requestCode(event?: FormEvent) {
    event?.preventDefault()
    setBusy('email')
    setError(null)
    try {
      const result = await apiJson<{ message: string }>('/api/auth/otp/send', { method: 'POST', json: { email } })
      setNotice(result.message)
      setStep('code')
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setBusy(null)
    }
  }

  async function verify(event: FormEvent) {
    event.preventDefault()
    setBusy('code')
    setError(null)
    try {
      await apiJson('/api/auth/otp/verify', { method: 'POST', json: { email, code } })
      router.replace(next)
      router.refresh()
    } catch (err) {
      setError(errorMessage(err))
      setBusy(null)
    }
  }

  const anyOAuth = providers.google || providers.github

  return (
    <div className="w-full max-w-md rounded-2xl border border-border/80 bg-card/90 p-8 shadow-2xl backdrop-blur-xl animate-fade-up">
      <div className="mb-6 text-center">
        <div className="mx-auto flex size-14 items-center justify-center rounded-2xl border border-primary/30 bg-primary/10">
          <ShieldCheck className="size-7 text-primary" />
        </div>
        <h1 className="mt-5 font-display text-2xl font-semibold tracking-tight">Sign in to Corpus</h1>
        <p className="mt-1.5 text-xs text-muted-foreground">Your notebooks are private to your account.</p>
      </div>

      {error && (
        <div role="alert" className="mb-4 flex items-start gap-2 rounded-lg border border-destructive/50 bg-destructive/10 p-3 text-xs text-destructive">
          <AlertCircle className="mt-0.5 size-4 shrink-0" />
          {error}
        </div>
      )}

      {anyOAuth && (
        <div className="space-y-3">
          {providers.google && (
            <Button type="button" variant="outline" className="h-11 w-full gap-3" disabled={busy !== null} onClick={() => oauth('google')}>
              {busy === 'google' ? <Loader2 className="size-4 animate-spin" /> : <GoogleIcon />}
              Continue with Google
            </Button>
          )}
          {providers.github && (
            <Button type="button" variant="outline" className="h-11 w-full gap-3" disabled={busy !== null} onClick={() => oauth('github')}>
              {busy === 'github' ? <Loader2 className="size-4 animate-spin" /> : <Github className="size-4" />}
              Continue with GitHub
            </Button>
          )}
        </div>
      )}

      {anyOAuth && providers.email && (
        <div className="my-5 flex items-center gap-3 text-[11px] uppercase tracking-wider text-muted-foreground">
          <span className="h-px flex-1 bg-border" />
          or
          <span className="h-px flex-1 bg-border" />
        </div>
      )}

      {providers.email &&
        (step === 'email' ? (
          <form onSubmit={requestCode} className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="login-email">Email address</Label>
              <div className="relative">
                <Mail className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  id="login-email"
                  type="email"
                  autoComplete="email"
                  required
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                  placeholder="you@company.com"
                  className="pl-10"
                  disabled={busy !== null}
                />
              </div>
            </div>
            <Button type="submit" className="h-11 w-full" disabled={busy !== null || !email.trim()}>
              {busy === 'email' ? <Loader2 className="mr-2 size-4 animate-spin" /> : null}
              Email me a sign-in code
              {busy !== 'email' && <ArrowRight className="ml-2 size-4" />}
            </Button>
          </form>
        ) : (
          <form onSubmit={verify} className="space-y-4">
            {notice && (
              <p className="flex items-center justify-center gap-1.5 rounded-lg border border-emerald-500/30 bg-emerald-500/10 p-2.5 text-center text-xs text-emerald-500">
                <CheckCircle2 className="size-3.5" />
                {notice}
              </p>
            )}
            <div className="space-y-1.5">
              <Label htmlFor="login-code">6-digit code sent to {email}</Label>
              <Input
                id="login-code"
                inputMode="numeric"
                autoComplete="one-time-code"
                pattern="[0-9]{6}"
                maxLength={6}
                required
                value={code}
                onChange={(event) => setCode(event.target.value.replace(/\D/g, ''))}
                placeholder="123456"
                className="font-mono text-lg tracking-[0.5em]"
                disabled={busy !== null}
              />
            </div>
            <div className="flex gap-2">
              <Button
                type="button"
                variant="outline"
                className="h-11"
                disabled={busy !== null}
                onClick={() => {
                  setStep('email')
                  setCode('')
                  setError(null)
                }}
              >
                Change email
              </Button>
              <Button type="submit" className="h-11 flex-1" disabled={busy !== null || code.length !== 6}>
                {busy === 'code' ? <Loader2 className="size-4 animate-spin" /> : 'Verify & sign in'}
              </Button>
            </div>
            <button
              type="button"
              disabled={busy !== null}
              onClick={() => requestCode()}
              className="w-full text-center font-mono text-[11px] text-muted-foreground hover:text-foreground disabled:opacity-50"
            >
              Didn’t get it? Send a new code
            </button>
          </form>
        ))}

      {!anyOAuth && !providers.email && <p className="text-center text-sm text-muted-foreground">No sign-in method is configured on this server.</p>}
    </div>
  )
}
