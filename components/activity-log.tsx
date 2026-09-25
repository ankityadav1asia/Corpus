'use client'

import { History, Loader2 } from 'lucide-react'

import { useAudit } from '@/hooks/use-api'
import { errorMessage } from '@/lib/api-client'
import type { AuditEvent } from '@/lib/contracts'
import { timeAgo } from '@/lib/format'

const text = (value: unknown) => (value === undefined || value === null ? '' : String(value))

/** Human wording for audit events (unknown actions fall back to their code). */
export function describeAuditEvent(event: AuditEvent): string {
  const d = event.details
  switch (event.action) {
    case 'source.added':
      return `added the source “${text(d.title)}”`
    case 'document.deleted':
      return `deleted “${text(d.title)}”`
    case 'document.retried':
      return `retried indexing “${text(d.title)}”`
    case 'chunk.edited':
      return `edited a passage in “${text(d.document)}”`
    case 'chunk.added':
      return `added a passage to “${text(d.document)}”`
    case 'chunk.deleted':
      return 'deleted a passage'
    case 'notebook.created':
      return `created the notebook “${text(d.name)}”`
    case 'notebook.renamed':
      return `renamed the notebook “${text(d.from)}” to “${text(d.to)}”`
    case 'notebook.deleted':
      return `deleted the notebook “${text(d.name)}”`
    case 'notebook.cleared':
      return `removed ${text(d.documents)} sources from “${text(d.name)}”`
    case 'notebook.access_changed':
      return `set someone's access to “${text(d.notebook)}” to ${text(d.role)}`
    case 'workspace.created':
      return 'created the workspace'
    case 'workspace.renamed':
      return `renamed the workspace to “${text(d.name)}”`
    case 'workspace.settings_changed':
      return 'changed the retrieval and quality settings'
    case 'member.added':
      return `added ${text(d.email)} as ${text(d.role)}`
    case 'member.invited':
      return `invited ${text(d.email)} as ${text(d.role)}`
    case 'member.role_changed':
      return `changed a member's role to ${text(d.role)}`
    case 'member.removed':
      return 'removed a member'
    case 'member.left':
      return 'left the workspace'
    case 'invite.revoked':
      return `revoked the invitation for ${text(d.email)}`
    case 'report.created':
      return `created the report “${text(d.title)}”`
    case 'report.deleted':
      return `deleted the report “${text(d.title)}”`
    case 'image.created':
      return `requested an image (${text(d.style)})`
    case 'image.deleted':
      return 'deleted an image'
    case 'benchmark.started':
      return `started a benchmark run (${text(d.questions)} questions)`
    default:
      return event.action
  }
}

/** Who changed what in the workspace, newest first (admins only). */
export function ActivityLog({ workspaceId }: { workspaceId: string | null }) {
  const audit = useAudit(workspaceId)
  const events = audit.data?.events ?? []
  if (audit.isLoading) return <Loader2 className="size-4 animate-spin text-primary" />
  if (audit.error) return <p className="text-xs text-destructive">{errorMessage(audit.error)}</p>
  if (events.length === 0) {
    return (
      <p className="flex items-center gap-2 text-xs text-muted-foreground">
        <History className="size-3.5" /> Nothing recorded yet.
      </p>
    )
  }
  return (
    <ol className="relative max-h-80 space-y-3 overflow-y-auto border-l border-border/70 pl-4">
      {events.map((event) => (
        <li key={event.id} className="relative text-xs">
          <span aria-hidden className="absolute -left-[21px] top-1 size-2.5 rounded-full border-2 border-card bg-primary" />
          <p>
            <span className="font-medium">{event.actorEmail ?? 'Someone'}</span> <span className="text-muted-foreground">{describeAuditEvent(event)}</span>
          </p>
          <p className="text-[10px] text-muted-foreground">{timeAgo(event.createdAt)}</p>
        </li>
      ))}
    </ol>
  )
}
