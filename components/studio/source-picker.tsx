'use client'

import { BookOpen, Check, FileText, Loader2 } from 'lucide-react'
import { useState } from 'react'

import { Select } from '@/components/ui/select'
import { useDocuments } from '@/hooks/use-api'
import { STUDIO_LIMITS } from '@/lib/constants'
import type { Collection } from '@/lib/contracts'
import { cn } from '@/lib/utils'

export interface SourceSelection {
  collectionIds: string[]
  documentIds: string[]
}

const toggle = (list: string[], id: string) => (list.includes(id) ? list.filter((item) => item !== id) : [...list, id])

/** Whole notebooks, or specific documents of one notebook, for studio outputs (audio, mind maps). */
export function SourcePicker({
  collections,
  value,
  onChange,
  disabled,
}: {
  collections: Collection[]
  value: SourceSelection
  onChange: (next: SourceSelection) => void
  disabled?: boolean
}) {
  const [mode, setMode] = useState<'notebooks' | 'documents'>(value.documentIds.length ? 'documents' : 'notebooks')
  const [from, setFrom] = useState(collections[0]?.id ?? '')
  const documents = useDocuments(mode === 'documents' ? from || null : null)
  const ready = (documents.data?.documents ?? []).filter((document) => document.status === 'ready')

  function switchMode(next: 'notebooks' | 'documents') {
    setMode(next)
    onChange(next === 'notebooks' ? { collectionIds: value.collectionIds, documentIds: [] } : { collectionIds: [], documentIds: value.documentIds })
  }

  return (
    <fieldset disabled={disabled} className="space-y-2">
      <legend className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Sources</legend>
      <div className="inline-flex rounded-xl border border-border/60 bg-card/50 p-0.5 text-[11px]">
        {(['notebooks', 'documents'] as const).map((option) => (
          <button
            key={option}
            type="button"
            onClick={() => switchMode(option)}
            aria-pressed={mode === option}
            className={cn(
              'rounded-lg px-3 py-1 font-medium transition-colors',
              mode === option ? 'bg-card text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground',
            )}
          >
            {option === 'notebooks' ? 'Whole notebooks' : 'Specific documents'}
          </button>
        ))}
      </div>

      {mode === 'notebooks' ? (
        <div className="flex flex-wrap gap-1.5">
          {collections.map((collection) => {
            const on = value.collectionIds.includes(collection.id)
            return (
              <button
                key={collection.id}
                type="button"
                aria-pressed={on}
                onClick={() => onChange({ collectionIds: toggle(value.collectionIds, collection.id), documentIds: [] })}
                className={cn(
                  'flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-[11px] transition-all',
                  on ? 'border-primary/60 bg-primary/10 text-foreground shadow-sm' : 'border-border/60 bg-card/40 text-muted-foreground hover:text-foreground',
                )}
              >
                {on ? <Check className="size-3 text-primary" /> : <BookOpen className="size-3" />}
                {collection.name}
                <span className="font-mono text-[10px] opacity-70">{collection.documentCount}</span>
              </button>
            )
          })}
          {collections.length === 0 && <p className="text-[11px] text-muted-foreground">Create a notebook and add sources first.</p>}
        </div>
      ) : (
        <div className="space-y-2">
          <Select aria-label="Notebook to pick documents from" value={from} onChange={(event) => setFrom(event.target.value)}>
            {collections.map((collection) => (
              <option key={collection.id} value={collection.id}>
                {collection.name}
              </option>
            ))}
          </Select>
          <div className="max-h-40 space-y-0.5 overflow-y-auto rounded-xl border border-border/60 bg-card/50 p-1.5">
            {documents.isLoading ? (
              <Loader2 className="m-2 size-4 animate-spin text-primary" />
            ) : ready.length === 0 ? (
              <p className="p-2 text-[11px] text-muted-foreground">No indexed documents in this notebook.</p>
            ) : (
              ready.map((document) => {
                const on = value.documentIds.includes(document.id)
                const full = !on && value.documentIds.length >= STUDIO_LIMITS.documentsPerItem
                return (
                  <label key={document.id} className={cn('flex items-center gap-2 rounded-lg px-2 py-1 text-xs hover:bg-secondary/50', full && 'opacity-50')}>
                    <input type="checkbox" checked={on} disabled={full} onChange={() => onChange({ collectionIds: [], documentIds: toggle(value.documentIds, document.id) })} />
                    <FileText className="size-3 shrink-0 text-muted-foreground" />
                    <span className="truncate" title={document.source}>
                      {document.title}
                    </span>
                  </label>
                )
              })
            )}
          </div>
          <p className="text-[10px] text-muted-foreground">
            {value.documentIds.length}/{STUDIO_LIMITS.documentsPerItem} documents selected
          </p>
        </div>
      )}
    </fieldset>
  )
}

export const hasSelection = (selection: SourceSelection) => selection.collectionIds.length + selection.documentIds.length > 0
