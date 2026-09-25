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
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm"
      role="alertdialog"
      aria-modal="true"
      aria-labelledby="session-expired-title"
    >
      <div className="w-full max-w-sm rounded-2xl border border-border/80 bg-card p-6 text-center shadow-2xl">
        <div className="mx-auto mb-3 flex size-12 items-center justify-center rounded-2xl border border-amber-500/30 bg-amber-500/10">
          <ShieldAlert className="size-6 text-amber-500" />
        </div>
        <h2 id="session-expired-title" className="font-display text-lg font-semibold">
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
