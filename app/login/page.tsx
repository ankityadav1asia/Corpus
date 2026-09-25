import { redirect } from 'next/navigation'

import { LoginForm } from '@/components/login-form'
import { safeRedirectPath } from '@/lib/safe-redirect'
import { getUserFromCookies } from '@/server/auth/current-user'
import { getCoreEnv, getFeatureFlags, isProduction } from '@/server/env'

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
  return (
    <main className="flex min-h-screen items-center justify-center px-4">
      <LoginForm
        next={next}
        errorCode={errorCode}
        configError={configError}
        providers={{ google: features.google, github: features.github, email: features.emailOtp || !isProduction() }}
      />
    </main>
  )
}
