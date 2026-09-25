import type { NextRequest } from 'next/server'

import { startOAuth } from '@/server/auth/oauth-routes'

export const GET = (req: NextRequest) => startOAuth(req, 'google')
