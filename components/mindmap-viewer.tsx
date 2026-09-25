'use client'

import { ChevronsDownUp, ChevronsUpDown, Download, Maximize2, MessageSquareText, Minus, Plus } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'

import { Popover, MenuItem } from '@/components/ui/popover'
import { useTheme } from '@/hooks/use-theme'
import type { MindMapDetail, MindMapNode } from '@/lib/contracts'
import { downloadText, fileSlug } from '@/lib/download'
import { cn } from '@/lib/utils'

/**
 * Interactive mind map: a left-to-right tidy tree drawn in plain SVG (so it exports to SVG/PNG
 * without a canvas library). Branches get their own colour; nodes collapse and expand; the view
 * pans by dragging and zooms with the wheel or the buttons.
 */

const LINE_HEIGHT = 16
const PAD_X = 14
const PAD_Y = 10
const CHARS_PER_LINE = 26
const COLUMN_GAP = 64
const ROW_GAP = 12
const FONT = '600 12.5px Inter, ui-sans-serif, system-ui, sans-serif'
/** Hues for the main branches; every descendant uses its branch's hue. */
const HUES = [262, 199, 152, 32, 340, 185, 20, 90]

interface Laid {
  node: MindMapNode
  path: string[]
  x: number
  y: number
  width: number
  height: number
  hue: number | null
  lines: string[]
  hidden: number
  parent: Laid | null
}

function wrap(label: string): string[] {
  const words = label.split(/\s+/)
  const lines: string[] = []
  let current = ''
  for (const word of words) {
    if (current && (current + ' ' + word).length > CHARS_PER_LINE) {
      lines.push(current)
      current = word
    } else {
      current = current ? `${current} ${word}` : word
    }
  }
  if (current) lines.push(current)
  if (lines.length > 3) return [...lines.slice(0, 2), `${lines[2]!.slice(0, CHARS_PER_LINE - 1)}…`]
  return lines.map((line) => (line.length > CHARS_PER_LINE + 6 ? `${line.slice(0, CHARS_PER_LINE + 5)}…` : line))
}

function size(label: string, root: boolean) {
  const lines = wrap(label)
  const longest = Math.max(...lines.map((line) => line.length))
  return { lines, width: Math.min(260, Math.max(root ? 120 : 84, longest * 7.2 + PAD_X * 2)), height: lines.length * LINE_HEIGHT + PAD_Y * 2 }
}

const countAll = (node: MindMapNode): number => node.children.reduce((total, child) => total + 1 + countAll(child), 0)

/** Positions every visible node; collapsed subtrees are summarised by a "+n" badge. */
export function layoutMindMap(root: MindMapNode, collapsed: ReadonlySet<string>): Laid[] {
  const laid: Laid[] = []
  const columnWidths: number[] = []
  const visit = (node: MindMapNode, depth: number, acc: (depth: number, width: number) => void) => {
    const { width } = size(node.label, depth === 0)
    acc(depth, width)
    if (!collapsed.has(node.id)) node.children.forEach((child) => visit(child, depth + 1, acc))
  }
  visit(root, 0, (depth, width) => (columnWidths[depth] = Math.max(columnWidths[depth] ?? 0, width)))
  const columnX = columnWidths.map((_, depth) => columnWidths.slice(0, depth).reduce((sum, width) => sum + width + COLUMN_GAP, 0))

  const heights = new Map<string, number>()
  const measure = (node: MindMapNode, depth: number): number => {
    const own = size(node.label, depth === 0).height
    const kids = collapsed.has(node.id) ? [] : node.children
    const total = kids.length ? kids.reduce((sum, child) => sum + measure(child, depth + 1), 0) + ROW_GAP * (kids.length - 1) : 0
    const height = Math.max(own, total)
    heights.set(node.id, height)
    return height
  }
  measure(root, 0)

  const place = (node: MindMapNode, depth: number, top: number, hue: number | null, parent: Laid | null) => {
    const { lines, width, height } = size(node.label, depth === 0)
    const span = heights.get(node.id)!
    const entry: Laid = {
      node,
      path: [...(parent?.path ?? []), node.label],
      x: columnX[depth]!,
      y: top + span / 2 - height / 2,
      width,
      height,
      hue,
      lines,
      hidden: collapsed.has(node.id) ? countAll(node) : 0,
      parent,
    }
    laid.push(entry)
    if (collapsed.has(node.id)) return
    const kids = node.children
    const total = kids.reduce((sum, child) => sum + heights.get(child.id)!, 0) + ROW_GAP * Math.max(0, kids.length - 1)
    let cursor = top + (span - total) / 2
    kids.forEach((child, index) => {
      place(child, depth + 1, cursor, depth === 0 ? HUES[index % HUES.length]! : hue, entry)
      cursor += heights.get(child.id)! + ROW_GAP
    })
  }
  place(root, 0, 0, null, null)
  return laid
}

function bounds(laid: readonly Laid[]) {
  const minX = Math.min(...laid.map((item) => item.x))
  const minY = Math.min(...laid.map((item) => item.y))
  const maxX = Math.max(...laid.map((item) => item.x + item.width))
  const maxY = Math.max(...laid.map((item) => item.y + item.height))
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY }
}

function outline(node: MindMapNode, depth = 0): string {
  const line = `${'  '.repeat(depth)}- **${node.label}**${node.summary ? ` — ${node.summary}` : ''}`
  return [line, ...node.children.map((child) => outline(child, depth + 1))].join('\n')
}

function collectIds(node: MindMapNode, depth: number, keepDepth: number, into: Set<string>) {
  if (depth >= keepDepth && node.children.length) into.add(node.id)
  node.children.forEach((child) => collectIds(child, depth + 1, keepDepth, into))
  return into
}

interface Palette {
  canvas: string
  text: string
  muted: string
  edge: string
  isDark: boolean
}

function usePalette(): Palette {
  const { resolved } = useTheme()
  return resolved === 'dark'
    ? { canvas: '#0b0b12', text: '#f4f4f8', muted: '#9a9ab0', edge: '#3a3a4a', isDark: true }
    : { canvas: '#fbfbfe', text: '#1b1b28', muted: '#6b6b80', edge: '#c9c9d6', isDark: false }
}

function nodeColors(hue: number | null, palette: Palette, selected: boolean) {
  if (hue === null) return { fill: 'url(#mm-root)', stroke: 'none', text: '#ffffff' }
  const light = palette.isDark ? 22 : 95
  return {
    fill: `hsl(${hue} 70% ${light}%)`,
    stroke: `hsl(${hue} 75% ${palette.isDark ? 62 : 48}%)`,
    text: palette.isDark ? `hsl(${hue} 60% 92%)` : `hsl(${hue} 60% 22%)`,
    width: selected ? 2.5 : 1.25,
  }
}

interface MindMapViewerProps {
  map: MindMapDetail & { root: MindMapNode }
  onAsk: (question: string) => void
  onOpenSource: (documentId: string) => void
}

export function MindMapViewer({ map, onAsk, onOpenSource }: MindMapViewerProps) {
  const palette = usePalette()
  const root = map.root
  const [collapsed, setCollapsed] = useState<Set<string>>(() => collectIds(root, 0, 2, new Set()))
  const [selectedId, setSelectedId] = useState<string>(root.id)
  const [view, setView] = useState({ x: 40, y: 40, k: 1 })
  const container = useRef<HTMLDivElement>(null)
  const svg = useRef<SVGSVGElement>(null)
  const drag = useRef<{ x: number; y: number; startX: number; startY: number } | null>(null)

  const laid = useMemo(() => layoutMindMap(root, collapsed), [root, collapsed])
  const box = useMemo(() => bounds(laid), [laid])
  const selected = laid.find((item) => item.node.id === selectedId) ?? laid[0]!

  const fit = useCallback(() => {
    const element = container.current
    if (!element) return
    const { width, height } = element.getBoundingClientRect()
    const k = Math.min(1.4, Math.max(0.3, Math.min((width - 60) / box.width, (height - 60) / box.height)))
    setView({ k, x: (width - box.width * k) / 2 - box.x * k, y: (height - box.height * k) / 2 - box.y * k })
  }, [box])

  // Keep the whole map in view (first render, resizes, expanding/collapsing) until the member pans
  // or zooms themselves; "Fit to screen" hands control back.
  const interacted = useRef(false)
  useEffect(() => {
    const element = container.current
    if (!element) return
    const observer = new ResizeObserver(() => {
      if (!interacted.current) fit()
    })
    observer.observe(element)
    return () => observer.disconnect()
  }, [fit])

  function refit() {
    interacted.current = false
    fit()
  }

  function zoom(factor: number, around?: { x: number; y: number }) {
    const element = container.current
    if (!element) return
    interacted.current = true
    const rect = element.getBoundingClientRect()
    const cx = around ? around.x - rect.left : rect.width / 2
    const cy = around ? around.y - rect.top : rect.height / 2
    setView((current) => {
      const k = Math.min(2.5, Math.max(0.25, current.k * factor))
      return { k, x: cx - ((cx - current.x) * k) / current.k, y: cy - ((cy - current.y) * k) / current.k }
    })
  }

  useEffect(() => {
    const element = container.current
    if (!element) return
    const onWheel = (event: WheelEvent) => {
      event.preventDefault()
      zoom(event.deltaY < 0 ? 1.1 : 1 / 1.1, { x: event.clientX, y: event.clientY })
    }
    element.addEventListener('wheel', onWheel, { passive: false })
    return () => element.removeEventListener('wheel', onWheel)
  })

  function onPointerDown(event: ReactPointerEvent) {
    if ((event.target as Element).closest('[data-node]')) return
    drag.current = { x: view.x, y: view.y, startX: event.clientX, startY: event.clientY }
    interacted.current = true
    ;(event.currentTarget as Element).setPointerCapture(event.pointerId)
  }
  function onPointerMove(event: ReactPointerEvent) {
    const state = drag.current
    if (!state) return
    setView((current) => ({ ...current, x: state.x + event.clientX - state.startX, y: state.y + event.clientY - state.startY }))
  }
  const onPointerUp = () => (drag.current = null)

  function toggle(item: Laid) {
    setSelectedId(item.node.id)
    if (!item.node.children.length) return
    setCollapsed((current) => {
      const next = new Set(current)
      if (next.has(item.node.id)) next.delete(item.node.id)
      else next.add(item.node.id)
      return next
    })
  }

  /** The drawing without pan/zoom, cropped to the content, with its own background. */
  function standaloneSvg(): { markup: string; width: number; height: number } {
    const clone = svg.current!.cloneNode(true) as SVGSVGElement
    const pad = 32
    const width = Math.ceil(box.width + pad * 2)
    const height = Math.ceil(box.height + pad * 2)
    clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg')
    clone.setAttribute('width', String(width))
    clone.setAttribute('height', String(height))
    clone.setAttribute('viewBox', `${box.x - pad} ${box.y - pad} ${width} ${height}`)
    clone.querySelector('[data-viewport]')?.removeAttribute('transform')
    const background = document.createElementNS('http://www.w3.org/2000/svg', 'rect')
    background.setAttribute('x', String(box.x - pad))
    background.setAttribute('y', String(box.y - pad))
    background.setAttribute('width', String(width))
    background.setAttribute('height', String(height))
    background.setAttribute('fill', palette.canvas)
    clone.insertBefore(background, clone.querySelector('[data-viewport]'))
    return { markup: new XMLSerializer().serializeToString(clone), width, height }
  }

  function exportPng() {
    const { markup, width, height } = standaloneSvg()
    const image = new Image()
    image.onload = () => {
      const canvas = document.createElement('canvas')
      canvas.width = width * 2
      canvas.height = height * 2
      const context = canvas.getContext('2d')!
      context.scale(2, 2)
      context.drawImage(image, 0, 0)
      canvas.toBlob((blob) => {
        if (!blob) return
        const url = URL.createObjectURL(blob)
        const link = document.createElement('a')
        link.href = url
        link.download = `${fileSlug(map.title)}.png`
        link.click()
        setTimeout(() => URL.revokeObjectURL(url), 1000)
      }, 'image/png')
    }
    image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(markup)}`
  }

  const edges = laid.filter((item) => item.parent)
  const selectedSources = (selected.node.sources ?? []).map((index) => map.sources[index - 1]).filter(Boolean)

  return (
    <div className="grid h-full min-h-[480px] gap-3 lg:grid-cols-[minmax(0,1fr)_260px]">
      <div className="relative min-h-[420px] overflow-hidden rounded-2xl border border-border/60" style={{ background: palette.canvas }}>
        <div className="absolute left-3 top-3 z-10 flex items-center gap-1 rounded-xl border border-border/60 bg-card/90 p-1 shadow-sm backdrop-blur">
          <ToolButton label="Zoom in" onClick={() => zoom(1.2)}>
            <Plus className="size-3.5" />
          </ToolButton>
          <ToolButton label="Zoom out" onClick={() => zoom(1 / 1.2)}>
            <Minus className="size-3.5" />
          </ToolButton>
          <ToolButton label="Fit to screen" onClick={refit}>
            <Maximize2 className="size-3.5" />
          </ToolButton>
          <span className="mx-0.5 h-4 w-px bg-border" />
          <ToolButton label="Expand all" onClick={() => setCollapsed(new Set())}>
            <ChevronsUpDown className="size-3.5" />
          </ToolButton>
          <ToolButton label="Collapse to main topics" onClick={() => setCollapsed(collectIds(root, 0, 1, new Set()))}>
            <ChevronsDownUp className="size-3.5" />
          </ToolButton>
          <span className="mx-0.5 h-4 w-px bg-border" />
          <Popover
            label="Export mind map"
            trigger={<Download className="size-3.5" />}
            triggerClassName="rounded-lg p-1.5 text-muted-foreground hover:bg-secondary hover:text-foreground"
            width={200}
          >
            {(close) => (
              <>
                <MenuItem
                  onSelect={() => {
                    exportPng()
                    close()
                  }}
                >
                  PNG image
                </MenuItem>
                <MenuItem
                  onSelect={() => {
                    downloadText(`${fileSlug(map.title)}.svg`, 'image/svg+xml', standaloneSvg().markup)
                    close()
                  }}
                >
                  SVG vector
                </MenuItem>
                <MenuItem
                  onSelect={() => {
                    downloadText(`${fileSlug(map.title)}.md`, 'text/markdown', `# ${map.title}\n\n${outline(root)}\n`)
                    close()
                  }}
                >
                  Markdown outline
                </MenuItem>
                <MenuItem
                  onSelect={() => {
                    downloadText(`${fileSlug(map.title)}.json`, 'application/json', JSON.stringify({ title: map.title, root, sources: map.sources }, null, 2))
                    close()
                  }}
                >
                  JSON
                </MenuItem>
              </>
            )}
          </Popover>
        </div>
        <div
          ref={container}
          className={cn('h-full w-full touch-none select-none', drag.current ? 'cursor-grabbing' : 'cursor-grab')}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerLeave={onPointerUp}
        >
          <svg ref={svg} className="h-full w-full" role="img" aria-label={`Mind map: ${map.title}`}>
            <defs>
              <linearGradient id="mm-root" x1="0" y1="0" x2="1" y2="1">
                <stop offset="0%" stopColor="#8b5cf6" />
                <stop offset="55%" stopColor="#d946ef" />
                <stop offset="100%" stopColor="#0ea5e9" />
              </linearGradient>
            </defs>
            <g data-viewport transform={`translate(${view.x} ${view.y}) scale(${view.k})`}>
              {edges.map((item) => {
                const parent = item.parent!
                const x1 = parent.x + parent.width
                const y1 = parent.y + parent.height / 2
                const x2 = item.x
                const y2 = item.y + item.height / 2
                const mid = (x1 + x2) / 2
                return (
                  <path
                    key={`edge-${item.node.id}`}
                    d={`M ${x1} ${y1} C ${mid} ${y1}, ${mid} ${y2}, ${x2} ${y2}`}
                    fill="none"
                    stroke={item.hue === null ? palette.edge : `hsl(${item.hue} 70% ${palette.isDark ? 55 : 60}%)`}
                    strokeWidth={parent.parent ? 1.5 : 2.25}
                    strokeOpacity={0.85}
                  />
                )
              })}
              {laid.map((item) => {
                const isRoot = !item.parent
                const colors = nodeColors(item.hue, palette, item.node.id === selectedId)
                return (
                  <g
                    key={item.node.id}
                    data-node
                    role="button"
                    tabIndex={0}
                    aria-label={`${item.node.label}${item.node.children.length ? (item.hidden ? ', collapsed' : ', expanded') : ''}`}
                    onClick={() => toggle(item)}
                    onKeyDown={(event) => (event.key === 'Enter' || event.key === ' ') && toggle(item)}
                    className="cursor-pointer outline-none"
                  >
                    <rect
                      x={item.x}
                      y={item.y}
                      width={item.width}
                      height={item.height}
                      rx={isRoot ? 16 : 12}
                      fill={colors.fill}
                      stroke={item.node.id === selectedId && isRoot ? palette.text : colors.stroke}
                      strokeWidth={'width' in colors ? colors.width : item.node.id === selectedId ? 2 : 0}
                    />
                    {item.lines.map((line, index) => (
                      <text
                        key={index}
                        x={item.x + item.width / 2}
                        y={item.y + PAD_Y + LINE_HEIGHT * index + 12}
                        textAnchor="middle"
                        style={{ font: isRoot ? FONT.replace('12.5px', '14px') : FONT }}
                        fill={colors.text}
                      >
                        {line}
                      </text>
                    ))}
                    {item.node.children.length > 0 && (
                      <g>
                        <circle
                          cx={item.x + item.width}
                          cy={item.y + item.height / 2}
                          r={9}
                          fill={palette.canvas}
                          stroke={item.hue === null ? palette.edge : `hsl(${item.hue} 70% 55%)`}
                          strokeWidth={1.25}
                        />
                        <text
                          x={item.x + item.width}
                          y={item.y + item.height / 2 + 3.5}
                          textAnchor="middle"
                          style={{ font: '700 9.5px Inter, ui-sans-serif, system-ui, sans-serif' }}
                          fill={palette.muted}
                        >
                          {item.hidden ? `+${item.hidden}` : '−'}
                        </text>
                      </g>
                    )}
                  </g>
                )
              })}
            </g>
          </svg>
        </div>
        <p className="pointer-events-none absolute bottom-2 right-3 text-[10px] text-muted-foreground">Drag to move · scroll to zoom · click a topic to open it</p>
      </div>

      <aside className="panel flex min-h-0 flex-col gap-3 overflow-y-auto p-4">
        <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">{selected.path.slice(0, -1).join(' › ') || 'Main topic'}</p>
        <h4 className="font-display text-base font-semibold leading-snug">{selected.node.label}</h4>
        {selected.node.summary ? (
          <p className="text-xs leading-relaxed text-foreground/85">{selected.node.summary}</p>
        ) : (
          <p className="text-xs text-muted-foreground">No summary for this topic.</p>
        )}
        {selectedSources.length > 0 && (
          <div className="space-y-1">
            <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">From</p>
            {selectedSources.map((source) => (
              <button
                key={source!.documentId}
                type="button"
                onClick={() => onOpenSource(source!.documentId)}
                className="block w-full truncate rounded-lg px-2 py-1 text-left text-xs text-primary hover:bg-primary/10"
                title={source!.source}
              >
                {source!.title}
              </button>
            ))}
          </div>
        )}
        <button
          type="button"
          onClick={() => onAsk(`Explain "${selected.path.join(' › ')}" in detail using my sources.`)}
          className="mt-auto flex items-center justify-center gap-2 rounded-xl bg-brand-gradient px-3 py-2 text-xs font-semibold text-white shadow-md transition-transform hover:scale-[1.02] active:scale-95"
        >
          <MessageSquareText className="size-3.5" /> Ask about this in chat
        </button>
      </aside>
    </div>
  )
}

function ToolButton({ label, onClick, children }: { label: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      className="rounded-lg p-1.5 text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
    >
      {children}
    </button>
  )
}
