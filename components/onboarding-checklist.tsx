'use client'

import { Check, ChevronRight, X } from 'lucide-react'
import { useEffect, useState } from 'react'

import { Progress } from '@/components/ui/feedback-primitives'
import { cn } from '@/lib/utils'

export interface OnboardingStep {
  id: string
  label: string
  description: string
  done: boolean
  action: () => void
}

const STORAGE_KEY = 'corpus.onboarding.dismissed'

/** Getting-started steps with progress; hides itself when done or dismissed (per browser). */
export function OnboardingChecklist({ steps }: { steps: OnboardingStep[] }) {
  const [dismissed, setDismissed] = useState(true)

  useEffect(() => {
    try {
      setDismissed(localStorage.getItem(STORAGE_KEY) === '1')
    } catch {
      setDismissed(false)
    }
  }, [])

  const completed = steps.filter((step) => step.done).length
  if (dismissed || completed === steps.length) return null

  function dismiss() {
    setDismissed(true)
    try {
      localStorage.setItem(STORAGE_KEY, '1')
    } catch {
      // not remembered
    }
  }

  return (
    <section aria-label="Getting started" className="w-full animate-fade-up rounded-lg border border-border bg-card p-4 text-left">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-sm font-medium">Get started</p>
          <p className="text-[13px] text-muted-foreground">
            <span className="measured text-cool">
              {completed} of {steps.length}
            </span>{' '}
            done
          </p>
        </div>
        <button type="button" aria-label="Dismiss getting started" onClick={dismiss} className="rounded-lg p-1 text-muted-foreground hover:bg-secondary hover:text-foreground">
          <X className="size-3.5" />
        </button>
      </div>
      <Progress value={completed / steps.length} className="mt-3" label="Getting started progress" />
      <ul className="mt-3 space-y-1">
        {steps.map((step) => (
          <li key={step.id}>
            <button
              type="button"
              onClick={step.action}
              disabled={step.done}
              className={cn(
                'group flex w-full items-center gap-3 rounded-md px-2 py-2 text-left transition-colors duration-micro',
                step.done ? 'opacity-60' : 'hover:bg-secondary',
              )}
            >
              <span
                className={cn(
                  'flex size-5 shrink-0 items-center justify-center rounded-full border transition-colors',
                  step.done ? 'border-ok bg-ok-soft text-ok' : 'border-input group-hover:border-signal',
                )}
              >
                {step.done && <Check className="size-3" />}
              </span>
              <span className="min-w-0 flex-1">
                <span className={cn('block text-xs font-medium', step.done && 'line-through')}>{step.label}</span>
                <span className="block text-[13px] text-muted-foreground">{step.description}</span>
              </span>
              {!step.done && <ChevronRight className="size-3.5 shrink-0 text-muted-foreground" />}
            </button>
          </li>
        ))}
      </ul>
    </section>
  )
}
