'use client'

import { useCallback, useState } from 'react'

import { useErrorToast } from '@/hooks/use-error-toast'

/**
 * Runs a request under a key (so its button can show progress and stay disabled) and shows a
 * failure as a toast. `busy` is the key of the request in flight, or null.
 */
export function useBusyAction() {
  const fail = useErrorToast()
  const [busy, setBusy] = useState<string | null>(null)

  const run = useCallback(
    async (key: string, action: () => Promise<void>) => {
      setBusy(key)
      try {
        await action()
      } catch (error) {
        fail(error)
      } finally {
        setBusy(null)
      }
    },
    [fail],
  )

  return { busy, run }
}
