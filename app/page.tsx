import { redirect } from 'next/navigation'

import { Workspace } from '@/components/workspace'
import { getUserFromCookies } from '@/server/auth/current-user'

export const dynamic = 'force-dynamic'

/** The session is checked on the server before any UI renders (the old page relied on a client-side modal). */
export default async function HomePage() {
  const user = await getUserFromCookies()
  if (!user) redirect('/login')
  return <Workspace user={user} />
}
