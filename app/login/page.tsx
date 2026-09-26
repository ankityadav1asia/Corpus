import { PlayCircle } from 'lucide-react'
import Link from 'next/link'
import { redirect } from 'next/navigation'

import { AuthorCard } from '@/components/author-card'
import { LoginForm } from '@/components/login-form'
import { safeRedirectPath } from '@/lib/safe-redirect'
import { getUserFromCookies } from '@/server/auth/current-user'
import { getCoreEnv, getDemoConfig, getFeatureFlags, isProduction } from '@/server/env'

export const dynamic = 'force-dynamic'

type SearchParams = Promise<Record<string, string | string[] | undefined>>

/**
 * Server component: reads the query on the server (no useSearchParams, which broke
 * `next build`), sanitises `next` against open redirects, and only offers configured providers.
 */
export default async function LoginPage({ searchParams }: { searchParams: SearchParams }) {
  const params = await searchParams
  const next = safeRedirectPath(typeof params.next === 'string' ? params.next : null)
  const errorCode = typeof params.error === 'string' ? params.error : null

  let configError: string | null = null
  try {
    getCoreEnv()
  } catch (error) {
    configError = error instanceof Error ? error.message : 'Server is not configured.'
  }

  if (!configError && (await getUserFromCookies())) redirect(next)

  const features = getFeatureFlags()
  const oauth = features.google || features.github
  return (
    <main className="relative flex min-h-screen items-center justify-center px-4 py-20">
      {getDemoConfig() && (
        <Link
          href="/demo"
          className="absolute left-4 top-4 flex items-center gap-2 rounded-full border border-primary/40 bg-primary/10 px-4 py-2 text-sm font-medium text-foreground shadow-lg transition-colors hover:border-primary/70 hover:bg-primary/20 sm:left-6 sm:top-6"
        >
          <PlayCircle className="size-4 text-primary" />
          Try the live demo
          <span className="hidden text-muted-foreground sm:inline">· no account needed</span>
        </Link>
      )}
      <AuthorCard className="absolute right-4 top-4 sm:right-6 sm:top-6" />
      <LoginForm
        next={next}
        errorCode={errorCode}
        configError={configError}
        // Google / GitHub sign-in only; email codes remain a fallback where neither is configured (local development).
        providers={{ google: features.google, github: features.github, email: !oauth && (features.emailOtp || !isProduction()) }}
      />
    </main>
  )
}
