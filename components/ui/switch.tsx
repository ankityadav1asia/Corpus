'use client'

import { cn } from '@/lib/utils'

interface SwitchProps {
  checked: boolean
  onChange: (checked: boolean) => void
  label: string
  disabled?: boolean
}

/** Accessible on/off toggle (role="switch"); pair with a visible label via `label`. */
export function Switch({ checked, onChange, label, disabled }: SwitchProps) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cn(
        'relative h-5 w-9 shrink-0 rounded-full border transition-colors duration-micro disabled:cursor-not-allowed disabled:opacity-55',
        checked ? 'border-primary bg-primary' : 'border-input bg-paper-3',
      )}
    >
      <span
        className={cn(
          'absolute left-0.5 top-[1px] size-4 rounded-full transition-transform duration-short ease-out',
          checked ? 'translate-x-4 bg-primary-foreground' : 'translate-x-0 bg-muted-foreground',
        )}
      />
    </button>
  )
}
