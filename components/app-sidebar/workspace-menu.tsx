'use client'

import { Check, ChevronsUpDown, Plus, Settings } from 'lucide-react'

import { MenuItem, MenuSeparator, Popover } from '@/components/ui/popover'
import { useWorkspaceContext } from '@/components/workspace-provider'
import { workspaceName } from '@/lib/format'
import { ROLE_LABELS } from '@/lib/roles'

export function WorkspaceMenu({ onSelect, onCreate, onOpenSettings }: { onSelect: (id: string) => void; onCreate: () => void; onOpenSettings: () => void }) {
  const { workspaces, active } = useWorkspaceContext()
  const name = active ? workspaceName(active) : 'Loading…'
  const detail = active
    ? [active.isPersonal ? 'Private' : 'Team', ROLE_LABELS[active.role], active.memberCount > 1 ? `${active.memberCount} members` : null].filter(Boolean).join(' · ')
    : ''

  return (
    <Popover
      label={`Workspace: ${name}. Switch workspace`}
      align="start"
      width={256}
      triggerClassName="flex min-w-0 flex-1 items-center gap-2.5 rounded-xl p-1.5 text-left transition-colors hover:bg-secondary/70"
      trigger={
        <>
          <span aria-hidden className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-brand-gradient text-xs font-bold text-white shadow-sm">
            {name.slice(0, 1).toUpperCase()}
          </span>
          <span className="min-w-0 flex-1">
            <span className="block truncate text-[13px] font-semibold">{name}</span>
            <span className="block truncate text-[10px] text-muted-foreground">{detail}</span>
          </span>
          <ChevronsUpDown className="size-3.5 shrink-0 text-muted-foreground" />
        </>
      }
    >
      {(close) => (
        <>
          <p className="px-2.5 pb-1 pt-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Workspaces</p>
          <div className="max-h-64 overflow-y-auto">
            {workspaces.map((workspace) => (
              <MenuItem
                key={workspace.id}
                icon={workspace.id === active?.id ? <Check className="size-3.5 text-primary" /> : <span className="size-3.5" />}
                hint={ROLE_LABELS[workspace.role]}
                onSelect={() => {
                  close()
                  onSelect(workspace.id)
                }}
              >
                <span className="truncate">{workspaceName(workspace)}</span>
              </MenuItem>
            ))}
          </div>
          <MenuSeparator />
          <MenuItem
            icon={<Plus className="size-3.5" />}
            onSelect={() => {
              close()
              onCreate()
            }}
          >
            New team workspace
          </MenuItem>
          <MenuItem
            icon={<Settings className="size-3.5" />}
            disabled={!active}
            onSelect={() => {
              close()
              onOpenSettings()
            }}
          >
            Members & settings
          </MenuItem>
        </>
      )}
    </Popover>
  )
}
