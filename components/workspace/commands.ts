import {
  BookOpen,
  Building2,
  Database,
  FileBarChart,
  Headphones,
  Keyboard,
  LogOut,
  MessageSquare,
  MessageSquarePlus,
  Monitor,
  Moon,
  Network,
  Pin,
  Plug,
  Settings,
  Sparkles,
  Sun,
  Wand2,
} from 'lucide-react'

import type { Command } from '@/components/command-palette'
import type { OnboardingStep } from '@/components/onboarding-checklist'
import type { ChatMode } from '@/lib/constants'
import type { Collection, ConversationSummary, WorkspaceSummary } from '@/lib/contracts'
import { plural, workspaceName } from '@/lib/format'
import type { ThemePreference } from '@/lib/theme'

import { TABS, type WorkspaceTab } from './navigation'

/** Everything the command palette offers (Ctrl/⌘ K): views, actions, recent chats, notebooks, workspaces. */
export function buildCommands(deps: {
  mode: ChatMode
  conversations: readonly ConversationSummary[]
  collections: readonly Collection[]
  workspaces: readonly WorkspaceSummary[]
  activeWorkspaceId: string | null
  showTab: (tab: WorkspaceTab) => void
  newChat: () => void
  openSources: (hubTab?: 'files' | 'apps') => void
  setMode: (mode: ChatMode) => void
  openSettings: () => void
  openConversation: (id: string) => void
  selectNotebook: (id: string) => void
  switchWorkspace: (id: string) => void
  setTheme: (theme: ThemePreference) => void
  openShortcuts: () => void
  signOut: () => void
}): Command[] {
  return [
    ...TABS.map(({ id, label, icon }, index) => ({ id: `tab:${id}`, label: `Go to ${label}`, group: 'Navigate', icon, hint: `Alt ${index + 1}`, run: () => deps.showTab(id) })),
    { id: 'new-chat', label: 'New chat', group: 'Actions', icon: MessageSquarePlus, run: deps.newChat },
    { id: 'add-sources', label: 'Add sources', group: 'Actions', icon: Database, keywords: 'upload file pdf docx url website youtube text ingest', run: () => deps.openSources() },
    {
      id: 'generate-image',
      label: 'Generate an image',
      group: 'Actions',
      icon: Wand2,
      keywords: 'picture infographic diagram visual illustration',
      run: () => deps.showTab('images'),
    },
    {
      id: 'audio-overview',
      label: 'Create an audio overview',
      group: 'Actions',
      icon: Headphones,
      keywords: 'podcast listen hosts conversation notebooklm',
      run: () => deps.showTab('audio'),
    },
    { id: 'mind-map', label: 'Build a mind map', group: 'Actions', icon: Network, keywords: 'topics map tree diagram overview', run: () => deps.showTab('mindmaps') },
    {
      id: 'connect-app',
      label: 'Connect an app',
      group: 'Actions',
      icon: Plug,
      keywords: 'google drive notion github website sync connector import',
      run: () => deps.openSources('apps'),
    },
    { id: 'new-report', label: 'Create a report', group: 'Actions', icon: FileBarChart, keywords: 'summary comparison slides outline', run: () => deps.showTab('reports') },
    {
      id: 'deep-mode',
      label: deps.mode === 'deep' ? 'Switch to standard mode' : 'Switch to deep mode',
      group: 'Actions',
      icon: Sparkles,
      keywords: 'multi-query hyde step-back research',
      run: () => deps.setMode(deps.mode === 'deep' ? 'standard' : 'deep'),
    },
    { id: 'settings', label: 'Workspace settings & members', group: 'Actions', icon: Settings, keywords: 'invite team roles guardrail activity', run: deps.openSettings },
    ...deps.conversations.slice(0, 30).map((conversation) => ({
      id: `conversation:${conversation.id}`,
      label: conversation.title,
      group: 'Conversations',
      icon: conversation.pinned ? Pin : MessageSquare,
      run: () => deps.openConversation(conversation.id),
    })),
    ...deps.collections.map((collection) => ({
      id: `notebook:${collection.id}`,
      label: collection.name,
      group: 'Notebooks',
      icon: BookOpen,
      hint: plural(collection.documentCount, 'source'),
      run: () => deps.selectNotebook(collection.id),
    })),
    ...deps.workspaces
      .filter((item) => item.id !== deps.activeWorkspaceId)
      .map((item) => ({ id: `workspace:${item.id}`, label: `Switch to ${workspaceName(item)}`, group: 'Workspaces', icon: Building2, run: () => deps.switchWorkspace(item.id) })),
    { id: 'theme-light', label: 'Light theme', group: 'Appearance', icon: Sun, run: () => deps.setTheme('light') },
    { id: 'theme-dark', label: 'Dark theme', group: 'Appearance', icon: Moon, run: () => deps.setTheme('dark') },
    { id: 'theme-system', label: 'Match system theme', group: 'Appearance', icon: Monitor, run: () => deps.setTheme('system') },
    { id: 'shortcuts', label: 'Keyboard shortcuts', group: 'Help', icon: Keyboard, hint: '?', run: deps.openShortcuts },
    { id: 'sign-out', label: 'Sign out', group: 'Account', icon: LogOut, run: deps.signOut },
  ]
}

/** The getting-started checklist on an empty chat. */
export function buildOnboardingSteps(deps: {
  hasDocuments: boolean
  hasConversations: boolean
  hasReports: boolean
  hasImages: boolean
  hasTeam: boolean
  openSources: () => void
  focusComposer: () => void
  showTab: (tab: WorkspaceTab) => void
  inviteTeam: () => void
}): OnboardingStep[] {
  return [
    { id: 'source', label: 'Add a source', description: 'A file up to 50 MB, a web page, a video, notes — or connect an app', done: deps.hasDocuments, action: deps.openSources },
    { id: 'ask', label: 'Ask a question', description: 'Answers cite the passages they come from', done: deps.hasConversations, action: deps.focusComposer },
    { id: 'report', label: 'Create a report', description: 'Executive summaries, comparisons and slide outlines', done: deps.hasReports, action: () => deps.showTab('reports') },
    { id: 'image', label: 'Generate an image', description: 'Infographics and diagrams grounded in your sources', done: deps.hasImages, action: () => deps.showTab('images') },
    { id: 'team', label: 'Invite your team', description: 'Share a workspace with Admin, Editor and Viewer roles', done: deps.hasTeam, action: deps.inviteTeam },
  ]
}
