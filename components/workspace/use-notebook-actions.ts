'use client'

import { useErrorToast } from '@/hooks/use-error-toast'
import { apiJson } from '@/lib/api-client'
import type { Collection } from '@/lib/contracts'

/** Creating, renaming and deleting notebooks from the sidebar. */
export function useNotebookActions(deps: {
  collections: readonly Collection[]
  refreshCollections: () => Promise<unknown>
  /** After any change that affects counts (documents, passages). */
  refreshCorpus: () => void
  select: (id: string) => void
}) {
  const { collections, refreshCollections, refreshCorpus, select } = deps
  const fail = useErrorToast()

  async function create(name: string): Promise<boolean> {
    try {
      const { collection } = await apiJson<{ collection: Collection }>('/api/collections', { method: 'POST', json: { name } })
      await refreshCollections()
      select(collection.id)
      return true
    } catch (error) {
      fail(error)
      return false
    }
  }

  async function rename(id: string, name: string): Promise<boolean> {
    try {
      await apiJson(`/api/collections/${id}`, { method: 'PATCH', json: { name } })
      await refreshCollections()
      return true
    } catch (error) {
      fail(error)
      return false
    }
  }

  async function remove(id: string) {
    const collection = collections.find((c) => c.id === id)
    if (!collection || !window.confirm(`Delete “${collection.name}” and all ${collection.documentCount} of its sources? Conversations are kept.`)) return
    try {
      await apiJson(`/api/collections/${id}`, { method: 'DELETE' })
      select('all')
      refreshCorpus()
    } catch (error) {
      fail(error)
    }
  }

  return { create, rename, remove }
}
