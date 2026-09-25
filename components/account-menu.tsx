'use client'

import { ChevronsUpDown, Command, Keyboard, LogOut, MonitorX, Settings } from 'lucide-react'

import { ThemeToggle } from '@/components/theme-toggle'
import { Avatar } from '@/components/ui/feedback-primitives'
import { MenuItem, MenuSeparator, Popover } from '@/components/ui/popover'
import { isMac } from '@/hooks/use-hotkeys'
import type { SessionUser } from '@/lib/contracts'

interface AccountMenuProps {
  user: SessionUser
  onOpenPalette: () => void
  onOpenShortcuts: () => void
  onOpenSettings: () => void
  /** `everywhere` ends every session of this account (all browsers and devices). */
  onLogout: (options?: { everywhere?: boolean }) => void
  /** Avatar only (the navigation rail); the name and email move into the menu. */
  compact?: boolean
}

/** Avatar button with theme choice, shortcuts, workspace settings and sign-out. */
export function AccountMenu({ user, onOpenPalette, onOpenShortcuts, onOpenSettings, onLogout, compact = false }: AccountMenuProps) {
  const mod = isMac() ? '⌘' : 'Ctrl'
  const displayName = user.name ?? user.email.split('@')[0]
  return (
    <Popover
      label="Account menu"
      align="start"
      width={264}
      triggerClassName={
        compact
          ? 'flex size-10 items-center justify-center rounded-xl transition-colors hover:bg-secondary'
          : 'flex w-full items-center gap-2.5 rounded-xl p-1.5 text-left transition-colors hover:bg-secondary'
      }
      trigger={
        compact ? (
          <Avatar name={user.name} email={user.email} />
        ) : (
          <>
            <Avatar name={user.name} email={user.email} />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-xs font-semibold">{displayName}</span>
              <span className="block truncate text-[10px] text-muted-foreground">{user.email}</span>
            </span>
            <ChevronsUpDown className="size-3.5 shrink-0 text-muted-foreground" />
          </>
        )
      }
    >
      {(close) => (
        <div>
          {compact && (
            <>
              <div className="flex items-center gap-2.5 px-2.5 py-2">
                <Avatar name={user.name} email={user.email} />
                <span className="min-w-0">
                  <span className="block truncate text-xs font-semibold">{displayName}</span>
                  <span className="block truncate text-[10px] text-muted-foreground">{user.email}</span>
                </span>
              </div>
              <MenuSeparator />
            </>
          )}
          <div className="px-2.5 py-2">
            <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Appearance</p>
            <ThemeToggle className="mt-1.5" />
          </div>
          <MenuSeparator />
          <MenuItem
            icon={<Command className="size-3.5" />}
            hint={`${mod} K`}
            onSelect={() => {
              close()
              onOpenPalette()
            }}
          >
            Command palette
          </MenuItem>
          <MenuItem
            icon={<Keyboard className="size-3.5" />}
            hint="?"
            onSelect={() => {
              close()
              onOpenShortcuts()
            }}
          >
            Keyboard shortcuts
          </MenuItem>
          <MenuItem
            icon={<Settings className="size-3.5" />}
            onSelect={() => {
              close()
              onOpenSettings()
            }}
          >
            Workspace settings
          </MenuItem>
          <MenuSeparator />
          <MenuItem
            danger
            icon={<LogOut className="size-3.5" />}
            onSelect={() => {
              close()
              onLogout()
            }}
          >
            Sign out
          </MenuItem>
          <MenuItem
            danger
            icon={<MonitorX className="size-3.5" />}
            onSelect={() => {
              close()
              onLogout({ everywhere: true })
            }}
          >
            Sign out of all devices
          </MenuItem>
        </div>
      )}
    </Popover>
  )
}
