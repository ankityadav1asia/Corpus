import type { NextRequest } from 'next/server'

import { finishOAuth } from '@/server/auth/oauth-routes'

/** Registered redirect URI: /api/auth/oauth/callback?provider=google|github (unchanged). */
export const GET = (req: NextRequest) => finishOAuth(req)
