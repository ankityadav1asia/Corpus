'use client'

import { Check, ChevronRight, Rocket, X } from 'lucide-react'
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
    <section aria-label="Getting started" className="w-full max-w-xl animate-fade-up rounded-2xl border border-border/70 bg-card/70 p-4 text-left backdrop-blur">
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-2.5">
          <div className="flex size-8 items-center justify-center rounded-xl bg-brand-gradient shadow-md">
            <Rocket className="size-4 text-white" />
          </div>
          <div>
            <p className="font-display text-sm font-semibold">Get started</p>
            <p className="text-[11px] text-muted-foreground">
              {completed} of {steps.length} done
            </p>
          </div>
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
              className={cn('group flex w-full items-center gap-3 rounded-xl px-2 py-2 text-left transition-colors', step.done ? 'opacity-60' : 'hover:bg-secondary/70')}
            >
              <span
                className={cn(
                  'flex size-5 shrink-0 items-center justify-center rounded-full border transition-all',
                  step.done ? 'border-transparent bg-success text-white' : 'border-border group-hover:border-primary',
                )}
              >
                {step.done && <Check className="size-3 animate-pop" />}
              </span>
              <span className="min-w-0 flex-1">
                <span className={cn('block text-xs font-medium', step.done && 'line-through')}>{step.label}</span>
                <span className="block text-[11px] text-muted-foreground">{step.description}</span>
              </span>
              {!step.done && <ChevronRight className="size-3.5 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5" />}
            </button>
          </li>
        ))}
      </ul>
    </section>
  )
}
