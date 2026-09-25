'use client'

import { Dialog } from '@/components/ui/dialog'
import { Kbd } from '@/components/ui/feedback-primitives'
import { isMac } from '@/hooks/use-hotkeys'

export function ShortcutsDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const mod = isMac() ? '⌘' : 'Ctrl'
  const rows: Array<[string, string[]]> = [
    ['Command palette', [mod, 'K']],
    ['Focus the question box', [mod, '/']],
    ['Show or hide the chat history', [mod, 'B']],
    ['Go to Chat · Reports · Audio · Mind maps · Images · Chunks · Analytics', ['Alt', '1 – 7']],
    ['Send the question', ['Enter']],
    ['New line in the question', ['Shift', 'Enter']],
    ['Close a panel or dialog', ['Esc']],
    ['This list', ['?']],
  ]
  return (
    <Dialog open={open} onClose={onClose} title="Keyboard shortcuts" size="sm">
      <ul className="divide-y divide-border/50 px-5 py-2">
        {rows.map(([label, keys]) => (
          <li key={label} className="flex items-center justify-between gap-4 py-2.5 text-xs">
            <span>{label}</span>
            <span className="flex shrink-0 items-center gap-1">
              {keys.map((key) => (
                <Kbd key={key}>{key}</Kbd>
              ))}
            </span>
          </li>
        ))}
      </ul>
    </Dialog>
  )
}
