'use client'

import { Monitor, Moon, Sun } from 'lucide-react'

import { useTheme } from '@/hooks/use-theme'
import type { ThemePreference } from '@/lib/theme'
import { cn } from '@/lib/utils'

const OPTIONS: Array<{ value: ThemePreference; label: string; icon: typeof Sun }> = [
  { value: 'light', label: 'Light', icon: Sun },
  { value: 'dark', label: 'Dark', icon: Moon },
  { value: 'system', label: 'System', icon: Monitor },
]

/** Segmented Light / Dark / System switch. */
export function ThemeToggle({ className }: { className?: string }) {
  const { preference, setTheme } = useTheme()
  return (
    <div role="radiogroup" aria-label="Theme" className={cn('flex rounded-xl border border-border/70 bg-muted/40 p-0.5', className)}>
      {OPTIONS.map(({ value, label, icon: Icon }) => (
        <button
          key={value}
          type="button"
          role="radio"
          aria-checked={preference === value}
          title={label}
          onClick={() => setTheme(value)}
          className={cn(
            'flex flex-1 items-center justify-center gap-1.5 rounded-lg px-2 py-1 text-[11px] font-medium transition-all',
            preference === value ? 'bg-card text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground',
          )}
        >
          <Icon className="size-3.5" />
          <span>{label}</span>
        </button>
      ))}
    </div>
  )
}
