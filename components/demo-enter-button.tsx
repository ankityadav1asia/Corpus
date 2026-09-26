'use client'

import { ArrowRight, Loader2 } from 'lucide-react'
import { useRouter } from 'next/navigation'
import { useState } from 'react'

import { Button } from '@/components/ui/button'
import { apiJson, errorMessage } from '@/lib/api-client'

/** Starts a guest session in the demo workspace and opens the app. */
export function DemoEnterButton({ label = 'Enter the live demo', className }: { label?: string; className?: string }) {
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function enter() {
    setBusy(true)
    setError(null)
    try {
      await apiJson('/api/auth/demo', { method: 'POST', workspaceId: null })
      router.replace('/')
      router.refresh()
    } catch (err) {
      setError(errorMessage(err))
      setBusy(false)
    }
  }

  return (
    <div className="flex flex-col items-center gap-2 sm:items-start">
      <Button type="button" size="lg" className={className} disabled={busy} onClick={() => void enter()}>
        {busy ? <Loader2 className="mr-2 size-4 animate-spin" /> : null}
        {label}
        {!busy && <ArrowRight className="ml-2 size-4" />}
      </Button>
      {error && (
        <p role="alert" className="max-w-sm text-center text-xs text-destructive sm:text-left">
          {error}
        </p>
      )}
    </div>
  )
}
