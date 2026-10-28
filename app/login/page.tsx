import { PlayCircle } from 'lucide-react'
import Link from 'next/link'
import { redirect } from 'next/navigation'

import { AnswerRecord } from '@/components/answer-record'
import { AuthorCard } from '@/components/author-card'
import { LoginForm } from '@/components/login-form'
import { Wordmark } from '@/components/wordmark'
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
    <div className="flex min-h-screen flex-col">
      <header className="flex items-center justify-between gap-4 border-b border-border px-4 py-3 sm:px-8">
        <Wordmark />
        <div className="flex items-center gap-4">
          {getDemoConfig() && (
            <Link
              href="/demo"
              className="flex h-8 items-center gap-2 rounded-md border border-rule-2 px-3 text-[13px] font-medium text-foreground transition-colors duration-micro hover:bg-secondary"
            >
              <PlayCircle className="size-4 text-muted-foreground" />
              Try the live demo
              <span className="hidden text-muted-foreground md:inline">(no account needed)</span>
            </Link>
          )}
          <AuthorCard />
        </div>
      </header>
      <main className="mx-auto grid w-full max-w-6xl flex-1 items-center gap-12 px-4 py-12 sm:px-8 lg:grid-cols-[minmax(0,26rem)_minmax(0,1fr)] lg:gap-16">
        <LoginForm
          next={next}
          errorCode={errorCode}
          configError={configError}
          // Google / GitHub sign-in only; email codes remain a fallback where neither is configured (local development).
          providers={{ google: features.google, github: features.github, email: !oauth && (features.emailOtp || !isProduction()) }}
        />
        <div className="hidden lg:block">
          <AnswerRecord />
        </div>
      </main>
    </div>
  )
}
