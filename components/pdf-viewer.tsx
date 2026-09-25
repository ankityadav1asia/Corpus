'use client'

import { AlertCircle, ChevronLeft, ChevronRight, Loader2, ZoomIn, ZoomOut } from 'lucide-react'
import type * as PdfJsModule from 'pdfjs-dist'
import { useCallback, useEffect, useRef, useState } from 'react'

import { apiFetch, errorMessage } from '@/lib/api-client'
import { findPassage, type PassageMatch } from '@/lib/pdf-match'
import { cn } from '@/lib/utils'

type PdfJs = typeof PdfJsModule
type PdfDocument = Awaited<ReturnType<PdfJs['getDocument']>['promise']>
type PdfPage = Awaited<ReturnType<PdfDocument['getPage']>>
type TextItem = { str: string; transform: number[]; width: number; height: number }

let pdfjsPromise: Promise<PdfJs> | null = null

/**
 * pdf.js is large: loaded only when a PDF is opened. It is served from public/ (copied from the
 * installed package by scripts/copy-pdf-worker.mjs) and imported outside the bundler, because
 * webpack's transform of the pdf.js build fails at runtime.
 */
const PDFJS_URL = '/pdf.min.mjs'

function loadPdfJs(): Promise<PdfJs> {
  pdfjsPromise ??= (import(/* webpackIgnore: true */ PDFJS_URL) as Promise<PdfJs>).then((pdfjs) => {
    pdfjs.GlobalWorkerOptions.workerSrc = '/pdf.worker.min.mjs'
    return pdfjs
  })
  pdfjsPromise.catch(() => {
    pdfjsPromise = null // allow a retry after a network error
  })
  return pdfjsPromise
}

const textItems = (content: { items: unknown[] }) => content.items.filter((item): item is TextItem => typeof (item as TextItem).str === 'string')

interface Highlight {
  left: number
  top: number
  width: number
  height: number
}

function PdfPageView({
  pdfjs,
  document,
  pageNumber,
  width,
  zoom,
  highlightItems,
  scrollIntoView,
}: {
  pdfjs: PdfJs
  document: PdfDocument
  pageNumber: number
  width: number
  zoom: number
  highlightItems: number[] | undefined
  scrollIntoView: boolean
}) {
  const containerRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [visible, setVisible] = useState(scrollIntoView)
  const [size, setSize] = useState<{ width: number; height: number } | null>(null)
  const [highlights, setHighlights] = useState<Highlight[]>([])

  // Render only pages near the viewport (long PDFs stay light).
  useEffect(() => {
    const element = containerRef.current
    if (!element) return
    const observer = new IntersectionObserver(([entry]) => entry?.isIntersecting && setVisible(true), { rootMargin: '600px 0px' })
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    if (!visible || width <= 0) return
    let cancelled = false
    let task: { cancel: () => void; promise: Promise<unknown> } | null = null
    void (async () => {
      const page: PdfPage = await document.getPage(pageNumber)
      if (cancelled) return
      const base = page.getViewport({ scale: 1 })
      const scale = (width / base.width) * zoom
      const viewport = page.getViewport({ scale })
      const ratio = window.devicePixelRatio || 1
      const canvas = canvasRef.current
      if (!canvas) return
      canvas.width = Math.floor(viewport.width * ratio)
      canvas.height = Math.floor(viewport.height * ratio)
      setSize({ width: viewport.width, height: viewport.height })
      const context = canvas.getContext('2d')
      if (!context) return
      context.setTransform(ratio, 0, 0, ratio, 0, 0)
      task = page.render({ canvas, canvasContext: context, viewport }) as unknown as { cancel: () => void; promise: Promise<unknown> }
      await task.promise.catch(() => undefined)
      if (cancelled || !highlightItems?.length) return setHighlights([])
      const items = textItems(await page.getTextContent())
      const boxes: Highlight[] = []
      for (const index of highlightItems) {
        const item = items[index]
        if (!item || !item.str.trim()) continue
        const tx = pdfjs.Util.transform(viewport.transform, item.transform)
        const height = Math.hypot(tx[2]!, tx[3]!)
        boxes.push({ left: tx[4]!, top: tx[5]! - height, width: item.width * scale, height: height * 1.15 })
      }
      if (!cancelled) setHighlights(boxes)
    })()
    return () => {
      cancelled = true
      task?.cancel()
    }
  }, [visible, width, zoom, document, pageNumber, pdfjs, highlightItems])

  useEffect(() => {
    if (scrollIntoView && size) containerRef.current?.scrollIntoView({ block: 'start', behavior: 'smooth' })
  }, [scrollIntoView, size])

  return (
    <div
      ref={containerRef}
      data-page={pageNumber}
      className="relative mx-auto overflow-hidden rounded-md bg-white shadow-md ring-1 ring-black/5"
      style={{ width: size?.width ?? width * zoom, height: size?.height ?? width * zoom * 1.3 }}
    >
      <canvas ref={canvasRef} className="block h-full w-full" />
      {highlights.map((box, index) => (
        <span
          key={index}
          aria-hidden
          className="pointer-events-none absolute rounded-sm bg-yellow-300/45 mix-blend-multiply"
          style={{ left: box.left, top: box.top, width: box.width, height: box.height }}
        />
      ))}
      <span className="absolute bottom-1 right-2 font-mono text-[10px] text-black/40">{pageNumber}</span>
    </div>
  )
}

/**
 * The original PDF, rendered with pdf.js, opened at the cited passage with it highlighted.
 * The passage is located by its text (letters and digits only), so no page numbers need storing.
 */
export function PdfViewer({ documentId, passage }: { documentId: string; passage: string | null }) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const [state, setState] = useState<{ pdfjs: PdfJs; document: PdfDocument } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [match, setMatch] = useState<PassageMatch | null>(null)
  const [searched, setSearched] = useState(false)
  const [width, setWidth] = useState(0)
  const [zoom, setZoom] = useState(1)
  const [current, setCurrent] = useState(1)

  useEffect(() => {
    let cancelled = false
    let loaded: PdfDocument | null = null
    setState(null)
    setError(null)
    setMatch(null)
    setSearched(false)
    void (async () => {
      try {
        const [pdfjs, response] = await Promise.all([loadPdfJs(), apiFetch(`/api/corpus/documents/${documentId}/file`)])
        const data = new Uint8Array(await response.arrayBuffer())
        loaded = await pdfjs.getDocument({ data }).promise
        if (cancelled) return void loaded.destroy()
        setState({ pdfjs, document: loaded })
      } catch (reason) {
        if (!cancelled) setError(errorMessage(reason))
      }
    })()
    return () => {
      cancelled = true
      void loaded?.destroy()
    }
  }, [documentId])

  // Find the cited passage across the pages' text.
  useEffect(() => {
    if (!state) return
    if (!passage) return setSearched(true)
    let cancelled = false
    void (async () => {
      const pages = []
      for (let number = 1; number <= state.document.numPages; number++) {
        const page = await state.document.getPage(number)
        pages.push({ items: textItems(await page.getTextContent()).map((item) => item.str) })
        if (cancelled) return
      }
      const found = findPassage(pages, passage)
      if (!cancelled) {
        setMatch(found)
        setSearched(true)
        if (found) setCurrent(found.page + 1)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [state, passage])

  useEffect(() => {
    const element = scrollRef.current
    if (!element) return
    const observer = new ResizeObserver(([entry]) => setWidth(Math.max(200, Math.floor((entry?.contentRect.width ?? 0) - 32))))
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  const onScroll = useCallback(() => {
    const element = scrollRef.current
    if (!element) return
    const pages = element.querySelectorAll<HTMLElement>('[data-page]')
    const top = element.getBoundingClientRect().top + 80
    for (const page of pages) {
      const rect = page.getBoundingClientRect()
      if (rect.bottom > top) {
        setCurrent(Number(page.dataset.page))
        break
      }
    }
  }, [])

  function goTo(page: number) {
    scrollRef.current?.querySelector(`[data-page="${page}"]`)?.scrollIntoView({ block: 'start', behavior: 'smooth' })
  }

  const total = state?.document.numPages ?? 0
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center justify-between gap-2 border-b border-border/50 px-4 py-2 text-xs text-muted-foreground">
        <span className="flex items-center gap-1">
          <button type="button" aria-label="Previous page" disabled={current <= 1} onClick={() => goTo(current - 1)} className="rounded p-1 hover:bg-secondary disabled:opacity-30">
            <ChevronLeft className="size-3.5" />
          </button>
          <span className="font-mono">
            {total ? current : '–'} / {total || '–'}
          </span>
          <button
            type="button"
            aria-label="Next page"
            disabled={!total || current >= total}
            onClick={() => goTo(current + 1)}
            className="rounded p-1 hover:bg-secondary disabled:opacity-30"
          >
            <ChevronRight className="size-3.5" />
          </button>
        </span>
        <span className={cn('truncate', match ? 'text-primary' : '')}>
          {!passage ? '' : !searched ? 'Finding the cited passage…' : match ? `Cited passage on page ${match.page + 1}` : 'Cited passage not found in the PDF layout'}
        </span>
        <span className="flex items-center gap-1">
          <button type="button" aria-label="Zoom out" onClick={() => setZoom((value) => Math.max(0.6, +(value - 0.2).toFixed(1)))} className="rounded p-1 hover:bg-secondary">
            <ZoomOut className="size-3.5" />
          </button>
          <span className="w-9 text-center font-mono">{Math.round(zoom * 100)}%</span>
          <button type="button" aria-label="Zoom in" onClick={() => setZoom((value) => Math.min(2.4, +(value + 0.2).toFixed(1)))} className="rounded p-1 hover:bg-secondary">
            <ZoomIn className="size-3.5" />
          </button>
        </span>
      </div>
      <div ref={scrollRef} onScroll={onScroll} className="min-h-0 flex-1 overflow-auto bg-muted/40 p-4">
        {error ? (
          <p className="flex items-center justify-center gap-2 py-10 text-sm text-destructive">
            <AlertCircle className="size-4" /> {error}
          </p>
        ) : !state || (passage && !searched) ? (
          <div className="flex items-center justify-center gap-2 py-16 text-xs text-muted-foreground">
            <Loader2 className="size-4 animate-spin text-primary" /> {state ? 'Finding the cited passage…' : 'Opening the PDF…'}
          </div>
        ) : (
          <div className="space-y-4">
            {Array.from({ length: total }, (_, index) => (
              <PdfPageView
                key={index}
                pdfjs={state.pdfjs}
                document={state.document}
                pageNumber={index + 1}
                width={width}
                zoom={zoom}
                highlightItems={match?.items.get(index)}
                scrollIntoView={match?.page === index}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
