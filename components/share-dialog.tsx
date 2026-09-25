'use client'

import { Check, Copy, Eye, Link2, Loader2, Trash2 } from 'lucide-react'
import { useState } from 'react'
import useSWR from 'swr'

import { Button } from '@/components/ui/button'
import { Dialog } from '@/components/ui/dialog'
import { useToast } from '@/components/ui/use-toast'
import { useActiveWorkspaceId } from '@/components/workspace-provider'
import { apiJson, errorMessage } from '@/lib/api-client'
import type { ShareKind, ShareLink } from '@/lib/contracts'
import { timeAgo } from '@/lib/format'

interface ShareDialogProps {
  open: boolean
  onClose: () => void
  kind: ShareKind
  targetId: string | null
  title: string
  /** Editors and admins can create links; everyone can see and copy existing ones. */
  canShare: boolean
}

function CopyButton({ url }: { url: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      className="h-8 shrink-0 text-xs"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(url)
          setCopied(true)
          setTimeout(() => setCopied(false), 2000)
        } catch {
          window.prompt('Copy this link', url)
        }
      }}
    >
      {copied ? <Check className="mr-1.5 size-3.5" /> : <Copy className="mr-1.5 size-3.5" />}
      {copied ? 'Copied' : 'Copy'}
    </Button>
  )
}

/** Create, copy and turn off read-only public links to a conversation or report. */
export function ShareDialog({ open, onClose, kind, targetId, title, canShare }: ShareDialogProps) {
  const { toast } = useToast()
  const workspaceId = useActiveWorkspaceId()
  const key = open && targetId && workspaceId ? `/api/shares?kind=${kind}&id=${targetId}` : null
  const links = useSWR(key, (path: string) => apiJson<{ links: ShareLink[] }>(path))
  const [busy, setBusy] = useState<string | null>(null)

  async function create() {
    if (!targetId) return
    setBusy('create')
    try {
      const { link } = await apiJson<{ link: ShareLink }>('/api/shares', { method: 'POST', json: { kind, id: targetId } })
      await links.mutate()
      try {
        await navigator.clipboard.writeText(link.url ?? '')
        toast({ description: 'Link created and copied. Anyone with it can read this snapshot.' })
      } catch {
        toast({ description: 'Link created. Anyone with it can read this snapshot.' })
      }
    } catch (error) {
      toast({ variant: 'destructive', description: errorMessage(error) })
    } finally {
      setBusy(null)
    }
  }

  async function revoke(link: ShareLink) {
    if (!window.confirm('Turn this link off? People who have it will no longer be able to open it.')) return
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

  const list = links.data?.links ?? []
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={`Share ${kind === 'conversation' ? 'chat' : 'report'}`}
      description={`“${title}” — a read-only snapshot as it is now. Later changes are not shared.`}
    >
      <div className="space-y-4 p-5">
        {links.isLoading ? (
          <div className="flex justify-center py-4">
            <Loader2 className="size-5 animate-spin text-primary" />
          </div>
        ) : links.error ? (
          <p className="text-sm text-destructive">{errorMessage(links.error)}</p>
        ) : list.length === 0 ? (
          <p className="rounded-xl border border-dashed border-border/70 px-4 py-6 text-center text-xs text-muted-foreground">No public links yet.</p>
        ) : (
          <ul className="space-y-2">
            {list.map((link) => (
              <li key={link.id} className="rounded-xl border border-border/60 bg-secondary/20 p-3">
                <div className="flex items-center gap-2">
                  {link.url ? (
                    <>
                      <input
                        readOnly
                        value={link.url}
                        aria-label="Share link"
                        onFocus={(event) => event.target.select()}
                        className="h-8 min-w-0 flex-1 rounded-lg border border-border/60 bg-background px-2.5 font-mono text-[11px]"
                      />
                      <CopyButton url={link.url} />
                    </>
                  ) : (
                    <p className="min-w-0 flex-1 text-[11px] text-muted-foreground">This link can no longer be shown (the server key changed). Turn it off and create a new one.</p>
                  )}
                  <button
                    type="button"
                    aria-label="Turn this link off"
                    title="Turn this link off"
                    disabled={busy === link.id}
                    onClick={() => void revoke(link)}
                    className="flex size-8 shrink-0 items-center justify-center rounded-lg text-muted-foreground hover:bg-destructive/10 hover:text-destructive disabled:opacity-40"
                  >
                    {busy === link.id ? <Loader2 className="size-3.5 animate-spin" /> : <Trash2 className="size-3.5" />}
                  </button>
                </div>
                <p className="mt-1.5 flex items-center gap-1.5 text-[11px] text-muted-foreground">
                  <Eye className="size-3" /> {link.viewCount} view{link.viewCount === 1 ? '' : 's'}
                  {link.lastViewedAt && ` · last opened ${timeAgo(link.lastViewedAt)}`} · created {timeAgo(link.createdAt)}
                  {link.createdByEmail && ` by ${link.createdByEmail}`}
                </p>
              </li>
            ))}
          </ul>
        )}
        {canShare ? (
          <Button type="button" variant="brand" className="w-full" disabled={busy === 'create' || !targetId} onClick={() => void create()}>
            {busy === 'create' ? <Loader2 className="mr-2 size-4 animate-spin" /> : <Link2 className="mr-2 size-4" />}
            {list.length > 0 ? 'Create another link (new snapshot)' : 'Create public link'}
          </Button>
        ) : (
          <p className="text-center text-xs text-muted-foreground">You need Editor access to create public links.</p>
        )}
      </div>
    </Dialog>
  )
}
