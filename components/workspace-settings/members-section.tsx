'use client'

import { Loader2, Mail, UserPlus, Users, X } from 'lucide-react'
import { useState, type FormEvent } from 'react'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select } from '@/components/ui/select'
import { useToast } from '@/components/ui/use-toast'
import { useMembers } from '@/hooks/use-api'
import { useBusyAction } from '@/hooks/use-busy-action'
import { apiJson } from '@/lib/api-client'
import { ROLES, type Role } from '@/lib/constants'
import type { SessionUser, WorkspaceInvite, WorkspaceMember, WorkspaceSummary } from '@/lib/contracts'
import { ROLE_DESCRIPTIONS, ROLE_LABELS } from '@/lib/roles'

import { Section } from './layout'

function RoleSelect({ label, value, disabled, onChange }: { label: string; value: Role; disabled?: boolean; onChange: (role: Role) => void }) {
  return (
    <Select aria-label={label} value={value} disabled={disabled} onChange={(event) => onChange(event.target.value as Role)}>
      {ROLES.map((role) => (
        <option key={role} value={role}>
          {ROLE_LABELS[role]}
        </option>
      ))}
    </Select>
  )
}

interface MemberRowProps {
  member: WorkspaceMember
  isYou: boolean
  /** Present for admins: change the role, or remove someone else. */
  manage: { busy: boolean; onRoleChange: (role: Role) => void; onRemove: (() => void) | null } | null
}

function MemberRow({ member, isYou, manage }: MemberRowProps) {
  return (
    <li className="flex items-center gap-2 rounded-lg border border-border/50 bg-secondary/20 px-2.5 py-2 text-xs">
      <div className="min-w-0 flex-1">
        <p className="truncate font-medium">
          {member.name ?? member.email}
          {isYou && <span className="ml-1 text-muted-foreground">(you)</span>}
        </p>
        {member.name && <p className="truncate font-mono text-[10px] text-muted-foreground">{member.email}</p>}
      </div>
      {manage ? (
        <div className="w-28">
          <RoleSelect label={`Role of ${member.email}`} value={member.role} disabled={manage.busy} onChange={manage.onRoleChange} />
        </div>
      ) : (
        <Badge variant="outline" className="font-mono text-[10px]">
          {ROLE_LABELS[member.role]}
        </Badge>
      )}
      {manage?.onRemove && (
        <button
          type="button"
          aria-label={`Remove ${member.email}`}
          onClick={manage.onRemove}
          className="rounded p-1 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
        >
          <X className="size-3.5" />
        </button>
      )}
    </li>
  )
}

function InviteForm({ workspaceId, onInvited }: { workspaceId: string; onInvited: () => Promise<unknown> }) {
  const { toast } = useToast()
  const { busy, run } = useBusyAction()
  const [email, setEmail] = useState('')
  const [role, setRole] = useState<Role>('viewer')

  function invite(event: FormEvent) {
    event.preventDefault()
    const address = email.trim()
    void run('invite', async () => {
      const result = await apiJson<{ status: 'added' | 'invited' }>(`/api/workspaces/${workspaceId}/members`, { method: 'POST', json: { email: address, role } })
      setEmail('')
      await onInvited()
      toast({
        description: result.status === 'added' ? `${address} was added as ${ROLE_LABELS[role]}.` : `Invitation saved — it is accepted automatically when ${address} signs in.`,
      })
    })
  }

  return (
    <form onSubmit={invite} className="space-y-2 rounded-xl border border-border/60 bg-secondary/20 p-3">
      <Label htmlFor="invite-email" className="flex items-center gap-1.5">
        <UserPlus className="size-3.5" /> Add someone by email
      </Label>
      <div className="flex gap-2">
        <Input
          id="invite-email"
          type="email"
          required
          placeholder="colleague@company.com"
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          className="h-9 text-xs"
        />
        <div className="w-28 shrink-0">
          <RoleSelect label="Role for the new member" value={role} onChange={setRole} />
        </div>
      </div>
      <p className="text-[11px] text-muted-foreground">{ROLE_DESCRIPTIONS[role]}. People without an account join when they first sign in.</p>
      <Button type="submit" size="sm" className="w-full" disabled={busy === 'invite' || !email.trim()}>
        {busy === 'invite' ? <Loader2 className="mr-2 size-3.5 animate-spin" /> : <Mail className="mr-2 size-3.5" />}
        Add or invite
      </Button>
    </form>
  )
}

function PendingInvites({ invites, onRevoke }: { invites: readonly WorkspaceInvite[]; onRevoke: (email: string) => void }) {
  return (
    <div className="space-y-1.5">
      <p className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">Pending invitations</p>
      {invites.map((pending) => (
        <div key={pending.email} className="flex items-center justify-between rounded-lg border border-dashed border-border/60 px-2.5 py-1.5 text-xs">
          <span className="truncate">
            {pending.email} <span className="text-muted-foreground">· {ROLE_LABELS[pending.role]}</span>
          </span>
          <button type="button" onClick={() => onRevoke(pending.email)} className="font-mono text-[10px] text-muted-foreground hover:text-destructive">
            Revoke
          </button>
        </div>
      ))}
    </div>
  )
}

/** Members and their roles; admins also invite, change roles, remove people and revoke invitations. */
export function MembersSection({ workspace, user, isAdmin, onChanged }: { workspace: WorkspaceSummary; user: SessionUser; isAdmin: boolean; onChanged: () => Promise<unknown> }) {
  const members = useMembers(workspace.isPersonal ? null : workspace.id)
  const { busy, run } = useBusyAction()
  const base = `/api/workspaces/${workspace.id}`
  const refresh = () => Promise.all([members.mutate(), onChanged()])

  const changeRole = (userId: string, role: Role) =>
    void run(`role:${userId}`, async () => {
      await apiJson(`${base}/members/${userId}`, { method: 'PATCH', json: { role } })
      await refresh()
    })

  const remove = (member: WorkspaceMember) => {
    if (!window.confirm(`Remove ${member.email} from “${workspace.name}”?`)) return
    void run(`remove:${member.userId}`, async () => {
      await apiJson(`${base}/members/${member.userId}`, { method: 'DELETE' })
      await refresh()
    })
  }

  const revokeInvite = (email: string) =>
    void run(`revoke:${email}`, async () => {
      await apiJson(`${base}/invites?email=${encodeURIComponent(email)}`, { method: 'DELETE' })
      await members.mutate()
    })

  const invites = members.data?.invites ?? []
  return (
    <Section
      title="Members"
      icon={<Users className="size-4 text-primary" />}
      description={
        workspace.isPersonal ? 'Your personal workspace is private. Create a team workspace to collaborate.' : 'Roles apply to every notebook unless a notebook overrides them.'
      }
    >
      {!workspace.isPersonal && (
        <>
          {members.isLoading ? (
            <Loader2 className="size-4 animate-spin text-primary" />
          ) : (
            <ul className="space-y-1.5">
              {(members.data?.members ?? []).map((member) => (
                <MemberRow
                  key={member.userId}
                  member={member}
                  isYou={member.userId === user.id}
                  manage={
                    isAdmin
                      ? {
                          busy: busy === `role:${member.userId}`,
                          onRoleChange: (role) => changeRole(member.userId, role),
                          onRemove: member.userId === user.id ? null : () => remove(member),
                        }
                      : null
                  }
                />
              ))}
            </ul>
          )}
          {isAdmin && <InviteForm workspaceId={workspace.id} onInvited={refresh} />}
          {isAdmin && invites.length > 0 && <PendingInvites invites={invites} onRevoke={revokeInvite} />}
        </>
      )}
    </Section>
  )
}
