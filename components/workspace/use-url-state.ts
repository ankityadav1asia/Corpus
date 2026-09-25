'use client'

import { useEffect, useRef } from 'react'

import { useWorkspaceContext } from '@/components/workspace-provider'

import { isTab, type WorkspaceTab } from './navigation'

/**
 * URL state (?w=<workspace>&tab=<tab>&c=<conversation>): restored once when the workspaces are
 * known, then kept in sync, so a view survives reloads and can be bookmarked or shared.
 */
export function useUrlState(input: {
  tab: WorkspaceTab
  setTab: (tab: WorkspaceTab) => void
  conversationId: string | null
  openConversation: (id: string) => Promise<void>
  /** Notebooks of the active workspace are loaded (a conversation opens with its notebook). */
  collectionsLoaded: boolean
  /** Back from Google Drive's consent screen: `connected`, `denied` or an error code. */
  onDriveReturn: (result: string) => void
}) {
  const workspace = useWorkspaceContext()
  const { tab, setTab, conversationId, openConversation, collectionsLoaded, onDriveReturn } = input
  const activeId = workspace.active?.id ?? null
  const restored = useRef(false)
  const pendingConversation = useRef<{ id: string; workspaceId: string | null } | null>(null)

  useEffect(() => {
    if (restored.current || workspace.workspaces.length === 0) return
    restored.current = true
    const params = new URLSearchParams(window.location.search)
    const wanted = params.get('w')
    const known = wanted !== null && workspace.workspaces.some((item) => item.id === wanted)
    if (known && wanted !== workspace.active?.id) workspace.select(wanted)
    const wantedTab = params.get('tab')
    if (isTab(wantedTab)) setTab(wantedTab)
    const wantedConversation = params.get('c')
    if (wantedConversation) pendingConversation.current = { id: wantedConversation, workspaceId: known ? wanted : null }
    const connector = params.get('connector')
    if (connector?.startsWith('google_drive:')) onDriveReturn(connector.slice('google_drive:'.length))
  }, [workspace, setTab, onDriveReturn])

  useEffect(() => {
    const pending = pendingConversation.current
    if (!pending || !collectionsLoaded || (pending.workspaceId && pending.workspaceId !== activeId)) return
    pendingConversation.current = null
    void openConversation(pending.id)
  }, [activeId, collectionsLoaded, openConversation])

  useEffect(() => {
    if (!restored.current || !activeId) return
    const params = new URLSearchParams({ w: activeId })
    if (tab !== 'chat') params.set('tab', tab)
    else if (conversationId) params.set('c', conversationId)
    const next = `${window.location.pathname}?${params.toString()}`
    // null state: Next.js keeps its router in sync with the new URL.
    if (next !== `${window.location.pathname}${window.location.search}`) window.history.replaceState(null, '', next)
  }, [activeId, tab, conversationId])
}
