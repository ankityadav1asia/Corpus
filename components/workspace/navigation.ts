import { BarChart2, FileBarChart, Layers, MessageSquare } from 'lucide-react'

import { WORKSPACE_TABS, type WorkspaceTab } from '@/lib/constants'

export type { WorkspaceTab }

export interface TabInfo {
  id: WorkspaceTab
  label: string
  /** Fits under an icon in the navigation rail. */
  short: string
  group: 'chat' | 'studio' | 'tools'
  icon: typeof MessageSquare
  /** Shown to workspace admins only. */
  adminOnly?: boolean
}

/** In navigation-rail order, which is also the order of the Alt+1… shortcuts. */
export const TABS: readonly TabInfo[] = [
  { id: 'chat', label: 'Chat', short: 'Chat', group: 'chat', icon: MessageSquare },
  { id: 'reports', label: 'Reports', short: 'Reports', group: 'studio', icon: FileBarChart },
  { id: 'explorer', label: 'Chunk editor', short: 'Chunks', group: 'tools', icon: Layers, adminOnly: true },
  { id: 'analytics', label: 'Analytics & quality', short: 'Analytics', group: 'tools', icon: BarChart2 },
]

/** The tabs a member sees: the chunk editor is a tool for workspace admins. */
export const tabsFor = (isAdmin: boolean): readonly TabInfo[] => TABS.filter((item) => isAdmin || !item.adminOnly)

export const isTab = (value: string | null): value is WorkspaceTab => value !== null && (WORKSPACE_TABS as readonly string[]).includes(value)

export const tabLabel = (tab: WorkspaceTab): string => TABS.find((item) => item.id === tab)?.label ?? tab
