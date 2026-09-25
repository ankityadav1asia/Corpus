'use client'

import { Eye, FileText, Loader2, MessageSquare, Trash2 } from 'lucide-react'
import { useState } from 'react'
import useSWR from 'swr'

import { useToast } from '@/components/ui/use-toast'
import { apiJson, errorMessage } from '@/lib/api-client'
import type { ShareLink } from '@/lib/contracts'
import { plural, timeAgo } from '@/lib/format'

/** Admins: every active public link of the workspace, with who made it and how often it was opened. */
export function PublicLinksPanel({ workspaceId }: { workspaceId: string }) {
  const { toast } = useToast()
  const links = useSWR(`/api/workspaces/${workspaceId}/shares`, (path: string) => apiJson<{ links: ShareLink[] }>(path, { workspaceId: null }))
  const [busy, setBusy] = useState<string | null>(null)

  async function revoke(link: ShareLink) {
    if (!window.confirm(`Turn off the public link to “${link.title}”? People who have it will no longer be able to open it.`)) return
    setBusy(link.id)
    try {
      await apiJson(`/api/shares/${link.id}`, { method: 'DELETE' })
      await links.mutate()
    } catch (error) {
      toast({ variant: 'destructive', description: errorMessage(error) })
    } finally {
      setBusy(null)
    }
  }

  if (links.isLoading) return <Loader2 className="size-4 animate-spin text-primary" />
  if (links.error) return <p className="text-xs text-destructive">{errorMessage(links.error)}</p>
  const list = links.data?.links ?? []
  if (list.length === 0) return <p className="text-xs text-muted-foreground">No public links. Editors can share a chat or a report as a read-only link.</p>

  return (
    <ul className="space-y-1.5">
      {list.map((link) => (
        <li key={link.id} className="flex items-center gap-2 rounded-lg border border-border/60 bg-secondary/20 px-3 py-2">
          {link.kind === 'conversation' ? <MessageSquare className="size-3.5 shrink-0 text-muted-foreground" /> : <FileText className="size-3.5 shrink-0 text-muted-foreground" />}
          <div className="min-w-0 flex-1">
            {link.url ? (
              <a href={link.url} target="_blank" rel="noopener noreferrer" className="block truncate text-xs font-medium hover:underline">
                {link.title}
              </a>
            ) : (
              <p className="truncate text-xs font-medium" title="The address can no longer be shown after a server key change; turn it off and share again.">
                {link.title}
              </p>
            )}
            <p className="flex items-center gap-1 truncate text-[10px] text-muted-foreground">
              <Eye className="size-3" /> {plural(link.viewCount, 'view')} · {link.createdByEmail ?? 'former member'} · {timeAgo(link.createdAt)}
            </p>
          </div>
          <button
            type="button"
            aria-label={`Turn off the link to ${link.title}`}
            disabled={busy === link.id}
            onClick={() => void revoke(link)}
            className="rounded-md p-1.5 text-muted-foreground hover:bg-destructive/10 hover:text-destructive disabled:opacity-40"
          >
            {busy === link.id ? <Loader2 className="size-3.5 animate-spin" /> : <Trash2 className="size-3.5" />}
          </button>
        </li>
      ))}
    </ul>
  )
}
