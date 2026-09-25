'use client'

import { Cpu, History, Link2, Loader2, LogOut, MessageSquareShare, Shield, Trash2 } from 'lucide-react'
import { useEffect, useState, type FormEvent } from 'react'

import { ActivityLog } from '@/components/activity-log'
import { IntegrationsPanel } from '@/components/integrations-panel'
import { ModelsStatusView } from '@/components/models-status'
import { PublicLinksPanel } from '@/components/public-links-panel'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Drawer } from '@/components/ui/drawer'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { useToast } from '@/components/ui/use-toast'
import { useWorkspaceContext } from '@/components/workspace-provider'
import { useWorkspaceDetail } from '@/hooks/use-api'
import { useBusyAction } from '@/hooks/use-busy-action'
import { apiJson, errorMessage } from '@/lib/api-client'
import { LIMITS } from '@/lib/constants'
import type { SessionUser, WorkspaceSummary } from '@/lib/contracts'
import { ROLE_LABELS } from '@/lib/roles'

import { Section } from './layout'
import { MembersSection } from './members-section'
import { RetrievalSection } from './retrieval-section'

interface WorkspaceSettingsProps {
  open: boolean
  onClose: () => void
  user: SessionUser
  /** Called after the active workspace was deleted or left. */
  onLeft: () => void
}

function GeneralSection({ workspaceId, savedName, isAdmin, onRenamed }: { workspaceId: string; savedName: string; isAdmin: boolean; onRenamed: () => Promise<unknown> }) {
  const { toast } = useToast()
  const { busy, run } = useBusyAction()
  const [name, setName] = useState(savedName)

  useEffect(() => {
    setName(savedName)
  }, [savedName])

  function rename(event: FormEvent) {
    event.preventDefault()
    if (!name.trim()) return
    void run('name', async () => {
      await apiJson(`/api/workspaces/${workspaceId}`, { method: 'PATCH', json: { name: name.trim() } })
      await onRenamed()
      toast({ description: 'Workspace renamed.' })
    })
  }

  return (
    <Section title="General" icon={<Shield className="size-4 text-primary" />}>
      <form onSubmit={rename} className="flex items-end gap-2">
        <div className="flex-1 space-y-1.5">
          <Label htmlFor="workspace-name">Name</Label>
          <Input id="workspace-name" value={name} maxLength={LIMITS.workspaceNameChars} disabled={!isAdmin} onChange={(event) => setName(event.target.value)} />
        </div>
        {isAdmin && (
          <Button type="submit" size="sm" disabled={busy === 'name' || !name.trim() || name.trim() === savedName}>
            Rename
          </Button>
        )}
      </form>
    </Section>
  )
}

/** Leaving (anyone) or deleting (admins) a team workspace. */
function LeaveOrDelete({ workspace, user, isAdmin, onGone }: { workspace: WorkspaceSummary; user: SessionUser; isAdmin: boolean; onGone: () => Promise<void> }) {
  const { toast } = useToast()
  const { busy, run } = useBusyAction()

  const leave = () => {
    if (!window.confirm(`Leave “${workspace.name}”? You will lose access to its notebooks.`)) return
    void run('leave', async () => {
      await apiJson(`/api/workspaces/${workspace.id}/members/${user.id}`, { method: 'DELETE' })
      await onGone()
    })
  }

  const destroy = () => {
    const typed = window.prompt(`This permanently deletes “${workspace.name}” with every notebook, source, chat and report in it. Type the workspace name to confirm.`)
    if (typed !== workspace.name) return
    void run('delete', async () => {
      await apiJson(`/api/workspaces/${workspace.id}`, { method: 'DELETE' })
      await onGone()
      toast({ description: 'Workspace deleted.' })
    })
  }

  return (
    <Section title="Leave or delete" icon={<Trash2 className="size-4 text-destructive" />}>
      <div className="flex flex-wrap gap-2">
        <Button type="button" variant="outline" size="sm" onClick={leave} disabled={busy === 'leave'}>
          <LogOut className="mr-2 size-3.5" />
          Leave workspace
        </Button>
        {isAdmin && (
          <Button type="button" variant="destructive" size="sm" onClick={destroy} disabled={busy === 'delete'}>
            <Trash2 className="mr-2 size-3.5" />
            Delete workspace
          </Button>
        )}
      </div>
    </Section>
  )
}

/** Sections only admins see: chat apps, public links and the activity log. */
function AdminSections({ workspaceId }: { workspaceId: string }) {
  return (
    <>
      <Section
        title="Chat apps"
        icon={<MessageSquareShare className="size-4 text-primary" />}
        description="Slack and Microsoft Teams bots that answer questions from this workspace, with citations."
      >
        <IntegrationsPanel workspaceId={workspaceId} />
      </Section>
      <Section title="Public links" icon={<Link2 className="size-4 text-primary" />} description="Read-only links to chats and reports that anyone with the link can open.">
        <PublicLinksPanel workspaceId={workspaceId} />
      </Section>
      <Section title="Activity" icon={<History className="size-4 text-primary" />} description="Recent changes to members, settings, notebooks and content.">
        <ActivityLog workspaceId={workspaceId} />
      </Section>
    </>
  )
}

/** Workspace administration: name, members and invitations, retrieval/guardrail/evaluation settings. */
export function WorkspaceSettingsDrawer({ open, onClose, user, onLeft }: WorkspaceSettingsProps) {
  const { active, refresh } = useWorkspaceContext()
  const detail = useWorkspaceDetail(open ? (active?.id ?? null) : null)
  const saved = detail.data?.workspace
  const isAdmin = active?.role === 'admin'

  async function gone() {
    onLeft()
    await refresh()
    onClose()
  }

  return (
    <Drawer
      open={open}
      onClose={onClose}
      title="Workspace settings"
      className="max-w-lg"
      description={
        active && (
          <span className="flex items-center gap-1.5">
            {active.name}
            <Badge variant="outline" className="px-1.5 py-0 font-mono text-[10px]">
              {ROLE_LABELS[active.role]}
            </Badge>
            {active.isPersonal && <span>· personal</span>}
          </span>
        )
      }
    >
      <div className="flex-1 overflow-y-auto">
        {!active || !saved ? (
          <div className="flex justify-center py-16">
            {detail.error ? <p className="text-sm text-destructive">{errorMessage(detail.error)}</p> : <Loader2 className="size-5 animate-spin text-primary" />}
          </div>
        ) : (
          <>
            <GeneralSection workspaceId={active.id} savedName={saved.name} isAdmin={isAdmin} onRenamed={() => Promise.all([refresh(), detail.mutate()])} />
            <MembersSection workspace={active} user={user} isAdmin={isAdmin} onChanged={refresh} />
            <RetrievalSection workspaceId={active.id} saved={saved.settings} isAdmin={isAdmin} onSaved={() => detail.mutate()} />
            <Section
              title="AI models"
              icon={<Cpu className="size-4 text-primary" />}
              description="Which models answer, search, read images, transcribe and speak — Gemini or open-source."
            >
              <ModelsStatusView workspaceId={active.id} isAdmin={isAdmin} />
            </Section>
            {isAdmin && <AdminSections workspaceId={active.id} />}
            {!active.isPersonal && <LeaveOrDelete workspace={active} user={user} isAdmin={isAdmin} onGone={gone} />}
          </>
        )}
      </div>
    </Drawer>
  )
}
