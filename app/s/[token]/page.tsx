import { FileText, MessageSquare, Sparkles } from 'lucide-react'
import type { Metadata } from 'next'
import { headers } from 'next/headers'
import { notFound } from 'next/navigation'

import Markdown from '@/components/markdown'
import type { SharedCitation } from '@/lib/contracts'
import { safeExternalUrl } from '@/lib/api-client'
import { clientIpFromHeaders } from '@/server/http/client-ip'
import { isAppError } from '@/server/http/errors'
import { RATE_LIMITS, enforceRateLimit } from '@/server/security/rate-limit'
import { getServices } from '@/server/services'
import { openShare } from '@/server/shares/service'

export const dynamic = 'force-dynamic'

// The token is in the URL: never send it on as a referrer, and keep shared pages out of search engines.
export const metadata: Metadata = {
  title: 'Shared from Corpus',
  robots: { index: false, follow: false },
  referrer: 'no-referrer',
}

function Citations({ citations }: { citations: SharedCitation[] }) {
  if (citations.length === 0) return null
  return (
    <ol className="mt-3 space-y-1.5 border-t border-border/50 pt-3 text-xs text-muted-foreground">
      {citations.map((citation) => {
        const link = safeExternalUrl(citation.source)
        return (
          <li key={citation.index} className="flex gap-2">
            <span className="font-mono text-primary">[{citation.index}]</span>
            <span className="min-w-0">
              {link ? (
                <a href={link} target="_blank" rel="noopener noreferrer nofollow" className="font-medium text-foreground/80 hover:underline">
                  {citation.title}
                </a>
              ) : (
                <span className="font-medium text-foreground/80">{citation.title}</span>
              )}
              {citation.excerpt && <span className="mt-0.5 line-clamp-2 block">{citation.excerpt}</span>}
            </span>
          </li>
        )
      })}
    </ol>
  )
}

/** Public, read-only view of a shared conversation or report (a snapshot; no session needed). */
export default async function SharedPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params
  const { repos } = getServices()
  try {
    // Same per-IP budget as the share API: tokens cannot be guessed, but views are counted.
    await enforceRateLimit(repos, `shared:ip:${clientIpFromHeaders(await headers())}`, RATE_LIMITS.sharedViews)
  } catch (error) {
    if (isAppError(error) && error.status === 429) return <p className="p-10 text-center text-sm text-muted-foreground">Too many requests. Try again in a minute.</p>
    throw error
  }
  const view = await openShare(repos, token)
  if (!view) notFound()

  const created = new Date(view.createdAt).toLocaleDateString('en', { year: 'numeric', month: 'long', day: 'numeric' })
  return (
    <div className="min-h-screen bg-background text-foreground">
      <header className="border-b border-border/60 bg-card/70 backdrop-blur-xl">
        <div className="mx-auto flex max-w-3xl items-center gap-3 px-4 py-4">
          <div className="flex size-8 items-center justify-center rounded-xl bg-brand-gradient shadow-md">
            <Sparkles className="size-4 text-white" />
          </div>
          <div className="min-w-0">
            <h1 className="truncate font-display text-base font-bold">{view.title}</h1>
            <p className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
              {view.kind === 'conversation' ? <MessageSquare className="size-3" /> : <FileText className="size-3" />}
              Shared {view.kind} · {view.workspaceName} · {created} · read-only
            </p>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-3xl px-4 py-8">
        {view.snapshot.kind === 'report' ? (
          <article className="panel p-6">
            <Markdown content={view.snapshot.content} />
          </article>
        ) : (
          <div className="space-y-6">
            {view.snapshot.messages.map((message, index) =>
              message.role === 'user' ? (
                <div key={index} className="flex justify-end">
                  <div className="max-w-[85%] rounded-2xl rounded-tr-md bg-primary/10 px-4 py-3 text-sm ring-1 ring-primary/20">{message.content}</div>
                </div>
              ) : (
                <div key={index} className="panel p-5">
                  <Markdown content={message.content} />
                  <Citations citations={message.citations} />
                </div>
              ),
            )}
          </div>
        )}
        <p className="mt-10 text-center text-[11px] text-muted-foreground">Answers were generated from the sharer&apos;s documents and may contain mistakes. Made with Corpus.</p>
      </main>
    </div>
  )
}
