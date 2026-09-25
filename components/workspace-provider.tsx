'use client'

import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react'
import useSWR from 'swr'

import { ApiError, setActiveWorkspaceId, swrFetcher } from '@/lib/api-client'
import type { Role } from '@/lib/constants'
import type { WorkspaceSummary } from '@/lib/contracts'

const STORAGE_KEY = 'corpus.workspace'

interface WorkspaceContextValue {
  workspaces: WorkspaceSummary[]
  /** The workspace every request is scoped to (null until the list has loaded). */
  active: WorkspaceSummary | null
  role: Role | null
  isLoading: boolean
  error: unknown
  select: (id: string) => void
  refresh: () => Promise<unknown>
}

const WorkspaceContext = createContext<WorkspaceContextValue | null>(null)

function readStoredId(): string | null {
  try {
    return window.localStorage.getItem(STORAGE_KEY)
  } catch {
    return null
  }
}

function storeId(id: string) {
  try {
    window.localStorage.setItem(STORAGE_KEY, id)
  } catch {
    // private mode / blocked storage: the choice just is not remembered
  }
}

/**
 * Holds the list of workspaces and the active one. The active id is mirrored into the API client
 * (X-Workspace-Id on every request) and into SWR keys, so switching refetches everything.
 */
export function WorkspaceProvider({ children }: { children: ReactNode }) {
  const list = useSWR<{ workspaces: WorkspaceSummary[] }>('/api/workspaces', swrFetcher, {
    shouldRetryOnError: (error: unknown) => !(error instanceof ApiError && error.status < 500),
  })
  const [chosenId, setChosenId] = useState<string | null>(() => (typeof window === 'undefined' ? null : readStoredId()))

  const workspaces = useMemo(() => list.data?.workspaces ?? [], [list.data])
  // Fall back to the personal workspace (listed first) when the remembered one is gone.
  const active = workspaces.find((workspace) => workspace.id === chosenId) ?? workspaces[0] ?? null
  setActiveWorkspaceId(active?.id ?? null)

  const select = useCallback((id: string) => {
    setActiveWorkspaceId(id)
    setChosenId(id)
    storeId(id)
  }, [])

  const value = useMemo<WorkspaceContextValue>(
    () => ({
      workspaces,
      active,
      role: active?.role ?? null,
      isLoading: list.isLoading,
      error: list.error,
      select,
      refresh: () => list.mutate(),
    }),
    [workspaces, active, list, select],
  )

  return <WorkspaceContext.Provider value={value}>{children}</WorkspaceContext.Provider>
}

export function useWorkspaceContext(): WorkspaceContextValue {
  const context = useContext(WorkspaceContext)
  if (!context) throw new Error('useWorkspaceContext must be used inside <WorkspaceProvider>')
  return context
}

export function useActiveWorkspaceId(): string | null {
  return useWorkspaceContext().active?.id ?? null
}
