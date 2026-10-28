'use client'

import { LogIn, ShieldAlert } from 'lucide-react'

import { Button } from '@/components/ui/button'

/**
 * Shown when an API call returns 401 mid-session (cookie expired or revoked).
 * Authentication itself is enforced on the server; this is only a UX affordance.
 */
export function SessionExpiredModal({ open }: { open: boolean }) {
  if (!open) return null
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-scrim/70 p-4" role="alertdialog" aria-modal="true" aria-labelledby="session-expired-title">
      <div className="w-full max-w-sm rounded-lg border border-rule-2 bg-card p-6">
        <div className="mb-3 flex size-10 items-center justify-center rounded-md border border-signal/40 bg-signal-soft">
          <ShieldAlert className="size-6 text-signal" />
        </div>
        <h2 id="session-expired-title" className="font-display text-lg font-medium">
          Your session has ended
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">Sign in again to keep working. Your notebooks and conversations are saved.</p>
        <Button className="mt-5 w-full" onClick={() => window.location.assign(`/login?next=${encodeURIComponent(window.location.pathname)}`)}>
          <LogIn className="mr-2 size-4" />
          Sign in again
        </Button>
      </div>
    </div>
  )
}
