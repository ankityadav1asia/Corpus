'use client'

import { UploadCloud } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'

import { LIMITS } from '@/lib/constants'
import { formatBytes } from '@/lib/format'

const hasFiles = (event: DragEvent) => Array.from(event.dataTransfer?.types ?? []).includes('Files')

/**
 * Drop files anywhere in the app: a full-screen target appears while files are dragged over the
 * window. Drops inside elements that handle files themselves (the upload zone) are left alone.
 */
export function DropOverlay({ enabled, targetName, onDrop }: { enabled: boolean; targetName: string | null; onDrop: (files: FileList) => void }) {
  const [visible, setVisible] = useState(false)
  const depth = useRef(0)
  const onDropRef = useRef(onDrop)
  useEffect(() => {
    onDropRef.current = onDrop
  })

  useEffect(() => {
    if (!enabled) return
    const enter = (event: DragEvent) => {
      if (!hasFiles(event)) return
      depth.current++
      setVisible(true)
    }
    const leave = (event: DragEvent) => {
      if (!hasFiles(event)) return
      depth.current = Math.max(0, depth.current - 1)
      if (depth.current === 0) setVisible(false)
    }
    const over = (event: DragEvent) => {
      if (hasFiles(event)) event.preventDefault()
    }
    const drop = (event: DragEvent) => {
      depth.current = 0
      setVisible(false)
      if (!hasFiles(event) || event.defaultPrevented) return
      event.preventDefault()
      if (event.dataTransfer?.files.length) onDropRef.current(event.dataTransfer.files)
    }
    window.addEventListener('dragenter', enter)
    window.addEventListener('dragleave', leave)
    window.addEventListener('dragover', over)
    window.addEventListener('drop', drop)
    return () => {
      window.removeEventListener('dragenter', enter)
      window.removeEventListener('dragleave', leave)
      window.removeEventListener('dragover', over)
      window.removeEventListener('drop', drop)
    }
  }, [enabled])

  if (!visible) return null
  return (
    <div aria-hidden className="pointer-events-none fixed inset-0 z-[80] flex animate-fade-in items-center justify-center bg-background/70 p-6 backdrop-blur-md">
      <div className="flex w-full max-w-lg animate-scale-in flex-col items-center rounded-3xl border-2 border-dashed border-primary/60 bg-card/80 px-8 py-12 text-center shadow-2xl">
        <div className="mb-4 flex size-16 animate-float items-center justify-center rounded-2xl bg-brand-gradient shadow-lg">
          <UploadCloud className="size-8 text-white" />
        </div>
        <p className="font-display text-lg font-semibold">Drop to add sources</p>
        <p className="mt-1 text-sm text-muted-foreground">
          {targetName ? `Files go into “${targetName}”` : 'Choose a notebook you can edit first'} · up to {formatBytes(LIMITS.fileBytes)} each
        </p>
      </div>
    </div>
  )
}
