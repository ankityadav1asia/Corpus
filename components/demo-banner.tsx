'use client'

import { Eye, Github, LogOut } from 'lucide-react'

import { apiJson } from '@/lib/api-client'

/** Shown to demo visitors: what the demo allows, and a way out. */
export function DemoBanner() {
  async function leave() {
    await apiJson('/api/auth', { method: 'DELETE', workspaceId: null }).catch(() => undefined)
    window.location.assign('/demo')
  }

  return (
    <div className="flex flex-wrap items-center justify-center gap-x-4 gap-y-1 border-b border-primary/30 bg-primary/10 px-4 py-2 text-xs">
      <span className="flex items-center gap-2">
        <Eye className="size-3.5 shrink-0 text-primary" />
        <span>
          <span className="font-medium">Read-only demo.</span>{' '}
          <span className="text-muted-foreground">Ask questions and open citations; uploads, studio jobs and settings are off. Your chats are deleted after a day.</span>
        </span>
      </span>
      <span className="flex items-center gap-3">
        <a href="https://github.com/ankityadav1asia/Corpus" target="_blank" rel="noreferrer" className="flex items-center gap-1 text-primary hover:underline">
          <Github className="size-3.5" />
          Code
        </a>
        <button type="button" onClick={() => void leave()} className="flex items-center gap-1 text-muted-foreground hover:text-foreground">
          <LogOut className="size-3.5" />
          Leave demo
        </button>
      </span>
    </div>
  )
}
