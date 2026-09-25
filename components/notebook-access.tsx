'use client'

import { Loader2 } from 'lucide-react'
import { useState } from 'react'

import { Badge } from '@/components/ui/badge'
import { Drawer } from '@/components/ui/drawer'
import { Select } from '@/components/ui/select'
import { useToast } from '@/components/ui/use-toast'
import { useCollectionRoles } from '@/hooks/use-api'
import { apiJson, errorMessage } from '@/lib/api-client'
import { ROLES, type Role } from '@/lib/constants'
import type { Collection } from '@/lib/contracts'
import { ROLE_LABELS } from '@/lib/roles'

interface NotebookAccessProps {
  collection: Collection | null
  onClose: () => void
  onChanged: () => void
}

/** Per-notebook role overrides (notebook Admin). Workspace admins always keep Admin access. */
export function NotebookAccessDrawer({ collection, onClose, onChanged }: NotebookAccessProps) {
  const { toast } = useToast()
  const roles = useCollectionRoles(collection?.id ?? null)
  const [saving, setSaving] = useState<string | null>(null)

  async function setOverride(userId: string, value: string) {
    if (!collection) return
    setSaving(userId)
    try {
      await apiJson(`/api/collections/${collection.id}/roles`, { method: 'PUT', json: { userId, role: value === 'inherit' ? null : (value as Role) } })
      await roles.mutate()
      onChanged()
    } catch (error) {
      toast({ variant: 'destructive', description: errorMessage(error) })
    } finally {
      setSaving(null)
    }
  }

  return (
    <Drawer
      open={collection !== null}
      onClose={onClose}
      title="Notebook access"
      description={collection ? `Who can do what in “${collection.name}”. Overrides replace the workspace role for this notebook only.` : undefined}
    >
      <div className="flex-1 overflow-y-auto p-4">
        {roles.isLoading ? (
          <div className="flex justify-center py-10">
            <Loader2 className="size-5 animate-spin text-primary" />
          </div>
        ) : roles.error ? (
          <p className="py-6 text-center text-xs text-destructive">{errorMessage(roles.error)}</p>
        ) : (
          <ul className="space-y-2">
            {(roles.data?.roles ?? []).map((entry) => (
              <li key={entry.userId} className="flex items-center gap-3 rounded-xl border border-border/50 bg-secondary/20 px-3 py-2.5 text-xs">
                <div className="min-w-0 flex-1">
                  <p className="truncate font-medium">{entry.name ?? entry.email}</p>
                  <p className="font-mono text-[10px] text-muted-foreground">
                    Workspace: {ROLE_LABELS[entry.workspaceRole]} · Here: <span className="text-foreground">{ROLE_LABELS[entry.effectiveRole]}</span>
                  </p>
                </div>
                {entry.workspaceRole === 'admin' ? (
                  <Badge variant="outline" className="font-mono text-[10px]">
                    Always admin
                  </Badge>
                ) : (
                  <div className="w-36">
                    <Select
                      aria-label={`Notebook role of ${entry.email}`}
                      value={entry.override ?? 'inherit'}
                      disabled={saving === entry.userId}
                      onChange={(event) => void setOverride(entry.userId, event.target.value)}
                    >
                      <option value="inherit">Workspace role</option>
                      {ROLES.map((role) => (
                        <option key={role} value={role}>
                          {ROLE_LABELS[role]}
                        </option>
                      ))}
                    </Select>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </Drawer>
  )
}
