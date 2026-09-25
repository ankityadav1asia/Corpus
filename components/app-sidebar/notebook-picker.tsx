'use client'

import { BookOpen, MoreHorizontal, Pencil, Plus, Trash2, UserCog } from 'lucide-react'
import { useState } from 'react'

import { MenuItem, MenuSeparator, Popover } from '@/components/ui/popover'
import { Select } from '@/components/ui/select'
import { useWorkspaceContext } from '@/components/workspace-provider'
import { LIMITS } from '@/lib/constants'
import type { Collection } from '@/lib/contracts'
import { plural } from '@/lib/format'
import { atLeast } from '@/lib/roles'

import { InlineNameForm } from './parts'

export interface NotebookPickerProps {
  collections: Collection[]
  /** 'all' or a notebook id. */
  selected: string
  onSelect: (id: string) => void
  onCreate: (name: string) => Promise<boolean>
  onRename: (id: string, name: string) => Promise<boolean>
  onDelete: (id: string) => void
  onManageAccess: (id: string) => void
}

/** Chooses the notebook chat searches, with create / rename / access / delete where the role allows. */
export function NotebookPicker({ collections, selected, onSelect, onCreate, onRename, onDelete, onManageAccess }: NotebookPickerProps) {
  const { role, active } = useWorkspaceContext()
  const [editing, setEditing] = useState<{ kind: 'create' } | { kind: 'rename'; id: string } | null>(null)
  const current = collections.find((collection) => collection.id === selected)
  const canCreate = atLeast(role, 'editor')
  const manageable = current?.myRole === 'admin' ? current : null

  if (editing) {
    return (
      <InlineNameForm
        initial={editing.kind === 'rename' ? (current?.name ?? '') : ''}
        label={editing.kind === 'create' ? 'New notebook name' : 'Notebook name'}
        maxLength={LIMITS.collectionNameChars}
        onSave={(name) => (editing.kind === 'create' ? onCreate(name) : onRename(editing.id, name))}
        onCancel={() => setEditing(null)}
      />
    )
  }

  return (
    <div className="flex items-center gap-1">
      <div className="relative min-w-0 flex-1">
        <BookOpen aria-hidden className="pointer-events-none absolute left-2.5 top-1/2 z-10 size-3.5 -translate-y-1/2 text-muted-foreground" />
        <Select id="notebook-select" aria-label="Notebook" className="h-8 rounded-lg pl-8" value={selected} onChange={(event) => onSelect(event.target.value)}>
          <option value="all">All notebooks</option>
          {collections.map((collection) => (
            <option key={collection.id} value={collection.id}>
              {collection.name} · {plural(collection.documentCount, 'source')}
            </option>
          ))}
        </Select>
      </div>
      {(canCreate || manageable) && (
        <Popover
          label="Notebook actions"
          width={200}
          triggerClassName="flex size-8 shrink-0 items-center justify-center rounded-lg text-muted-foreground hover:bg-secondary hover:text-foreground"
          trigger={<MoreHorizontal className="size-4" />}
        >
          {(close) => {
            const run = (action: () => void) => () => {
              close()
              action()
            }
            return (
              <>
                {canCreate && (
                  <MenuItem icon={<Plus className="size-3.5" />} onSelect={run(() => setEditing({ kind: 'create' }))}>
                    New notebook
                  </MenuItem>
                )}
                {manageable && (
                  <>
                    <MenuItem icon={<Pencil className="size-3.5" />} onSelect={run(() => setEditing({ kind: 'rename', id: manageable.id }))}>
                      Rename notebook
                    </MenuItem>
                    {!active?.isPersonal && (
                      <MenuItem icon={<UserCog className="size-3.5" />} onSelect={run(() => onManageAccess(manageable.id))}>
                        Notebook access
                      </MenuItem>
                    )}
                    <MenuSeparator />
                    <MenuItem danger icon={<Trash2 className="size-3.5" />} onSelect={run(() => onDelete(manageable.id))}>
                      Delete notebook
                    </MenuItem>
                  </>
                )}
              </>
            )
          }}
        </Popover>
      )}
    </div>
  )
}
