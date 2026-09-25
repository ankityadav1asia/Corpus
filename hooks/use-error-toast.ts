'use client'

import { useCallback } from 'react'

import { useToast } from '@/components/ui/use-toast'
import { errorMessage } from '@/lib/api-client'

/** Shows a failed request as a toast (the one error handler most actions share). */
export function useErrorToast(): (error: unknown) => void {
  const { toast } = useToast()
  return useCallback((error: unknown) => toast({ variant: 'destructive', description: errorMessage(error) }), [toast])
}
