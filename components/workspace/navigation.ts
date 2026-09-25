import { BarChart2, FileBarChart, Headphones, Layers, MessageSquare, Network, Wand2 } from 'lucide-react'

import { WORKSPACE_TABS, type WorkspaceTab } from '@/lib/constants'

export type { WorkspaceTab }

export interface TabInfo {
  id: WorkspaceTab
  label: string
  /** Fits under an icon in the navigation rail. */
  short: string
  group: 'chat' | 'studio' | 'tools'
  icon: typeof MessageSquare
}

/** In navigation-rail order, which is also the order of the Alt+1…7 shortcuts. */
export const TABS: readonly TabInfo[] = [
  { id: 'chat', label: 'Chat', short: 'Chat', group: 'chat', icon: MessageSquare },
  { id: 'reports', label: 'Reports', short: 'Reports', group: 'studio', icon: FileBarChart },
  { id: 'audio', label: 'Audio overviews', short: 'Audio', group: 'studio', icon: Headphones },
  { id: 'mindmaps', label: 'Mind maps', short: 'Mind maps', group: 'studio', icon: Network },
  { id: 'images', label: 'Image studio', short: 'Images', group: 'studio', icon: Wand2 },
  { id: 'explorer', label: 'Chunk editor', short: 'Chunks', group: 'tools', icon: Layers },
  { id: 'analytics', label: 'Analytics & quality', short: 'Analytics', group: 'tools', icon: BarChart2 },
]

export const isTab = (value: string | null): value is WorkspaceTab => value !== null && (WORKSPACE_TABS as readonly string[]).includes(value)

export const tabLabel = (tab: WorkspaceTab): string => TABS.find((item) => item.id === tab)?.label ?? tab
