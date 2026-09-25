'use client'

import { CornerDownLeft, Search, type LucideIcon } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'

import { Dialog } from '@/components/ui/dialog'
import { Kbd } from '@/components/ui/feedback-primitives'
import { cn } from '@/lib/utils'

export interface Command {
  id: string
  label: string
  group: string
  icon: LucideIcon
  /** Extra words that should find this command. */
  keywords?: string
  hint?: string
  run: () => void
}

/** Every word of the query must appear in the label, group or keywords. */
export function filterCommands(commands: readonly Command[], query: string): Command[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean)
  if (words.length === 0) return [...commands]
  return commands.filter((command) => {
    const haystack = `${command.label} ${command.group} ${command.keywords ?? ''}`.toLowerCase()
    return words.every((word) => haystack.includes(word))
  })
}

interface CommandPaletteProps {
  open: boolean
  onClose: () => void
  commands: Command[]
}

/** ⌘K / Ctrl+K: search and run anything — navigation, actions, conversations, notebooks. */
export function CommandPalette({ open, onClose, commands }: CommandPaletteProps) {
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const listRef = useRef<HTMLDivElement>(null)
  const results = useMemo(() => filterCommands(commands, query).slice(0, 60), [commands, query])

  const groups = useMemo(() => {
    const order: string[] = []
    const byGroup = new Map<string, Array<{ command: Command; index: number }>>()
    results.forEach((command, index) => {
      if (!byGroup.has(command.group)) {
        byGroup.set(command.group, [])
        order.push(command.group)
      }
      byGroup.get(command.group)!.push({ command, index })
    })
    return order.map((group) => ({ group, items: byGroup.get(group)! }))
  }, [results])

  useEffect(() => {
    if (open) {
      setQuery('')
      setActive(0)
    }
  }, [open])

  useEffect(() => setActive(0), [query])

  useEffect(() => {
    listRef.current?.querySelector(`[data-index="${active}"]`)?.scrollIntoView({ block: 'nearest' })
  }, [active])

  function run(command: Command | undefined) {
    if (!command) return
    onClose()
    // Let the dialog close before the command opens something else.
    requestAnimationFrame(() => command.run())
  }

  return (
    <Dialog open={open} onClose={onClose} bare size="md" title="Command palette" className="overflow-hidden">
      <div className="flex items-center gap-3 border-b border-border/60 px-4">
        <Search className="size-4 shrink-0 text-muted-foreground" />
        <input
          autoFocus
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'ArrowDown') {
              event.preventDefault()
              setActive((value) => Math.min(value + 1, results.length - 1))
            } else if (event.key === 'ArrowUp') {
              event.preventDefault()
              setActive((value) => Math.max(value - 1, 0))
            } else if (event.key === 'Enter') {
              event.preventDefault()
              // Typed fast, Enter can arrive before the list re-renders: match what is in the box.
              const typed = event.currentTarget.value
              run(typed === query ? results[active] : filterCommands(commands, typed)[0])
            }
          }}
          placeholder="Search actions, conversations, notebooks…"
          aria-label="Search commands"
          className="h-14 w-full bg-transparent text-sm focus:outline-none"
        />
        <Kbd>Esc</Kbd>
      </div>
      <div ref={listRef} role="listbox" aria-label="Commands" className="max-h-[55vh] overflow-y-auto p-2">
        {results.length === 0 ? (
          <p className="px-3 py-10 text-center text-sm text-muted-foreground">No matches for “{query}”.</p>
        ) : (
          groups.map(({ group, items }) => (
            <div key={group} className="mb-1">
              <p className="px-3 pb-1 pt-2 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">{group}</p>
              {items.map(({ command, index }) => {
                const Icon = command.icon
                return (
                  <button
                    key={command.id}
                    type="button"
                    role="option"
                    aria-selected={index === active}
                    data-index={index}
                    onMouseMove={() => setActive(index)}
                    onClick={() => run(command)}
                    className={cn(
                      'flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left text-sm transition-colors',
                      index === active ? 'bg-primary/10 text-foreground' : 'text-foreground/85',
                    )}
                  >
                    <Icon className={cn('size-4 shrink-0', index === active ? 'text-primary' : 'text-muted-foreground')} />
                    <span className="min-w-0 flex-1 truncate">{command.label}</span>
                    {command.hint && <span className="shrink-0 text-[11px] text-muted-foreground">{command.hint}</span>}
                    {index === active && <CornerDownLeft className="size-3.5 shrink-0 text-primary" />}
                  </button>
                )
              })}
            </div>
          ))
        )}
      </div>
      <footer className="flex items-center gap-4 border-t border-border/60 px-4 py-2 text-[10px] text-muted-foreground">
        <span className="flex items-center gap-1">
          <Kbd>↑</Kbd>
          <Kbd>↓</Kbd> move
        </span>
        <span className="flex items-center gap-1">
          <Kbd>↵</Kbd> run
        </span>
      </footer>
    </Dialog>
  )
}
