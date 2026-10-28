import { Github } from 'lucide-react'
import type { Metadata } from 'next'
import Link from 'next/link'

import { AuthorCard } from '@/components/author-card'
import { DemoEnterButton } from '@/components/demo-enter-button'
import { Button } from '@/components/ui/button'
import { Wordmark } from '@/components/wordmark'
import { getUserFromCookies } from '@/server/auth/current-user'
import { GUEST_LIFETIME_HOURS } from '@/server/auth/guest'
import { getDemoConfig } from '@/server/env'

export const dynamic = 'force-dynamic'

export const metadata: Metadata = {
  title: 'Corpus live demo',
  description: 'Try Corpus without an account: ask questions about sample documents and get answers with citations.',
}

const REPOSITORY = 'https://github.com/ankityadav1asia/Corpus'

const STEPS = [
  { title: 'Ask a question', text: 'Type a question about the sample notebooks. The answer streams in with numbered citations.' },
  { title: 'Open a citation', text: 'Click [1] to see the exact passage, highlighted in the original PDF or page.' },
  { title: 'Watch it research', text: 'Switch to Deep mode: the query planner rewrites the question before searching.' },
  { title: 'Ask something off-topic', text: 'The guardrail refuses instead of making an answer up.' },
  { title: 'Explore the studio', text: 'Open the reports made from the same sources: summaries, comparisons and slide outlines.' },
]

const FEATURES = [
  { title: 'Cited answers', text: 'Every answer comes only from your sources, with citations you can open.' },
  { title: 'Hybrid retrieval', text: 'pgvector similarity + PostgreSQL full-text, fused with RRF, then re-ranked.' },
  { title: 'Guardrail', text: 'Weak context gets a fixed "insufficient context" reply, never a guess.' },
  { title: 'Any source', text: 'PDFs, scans (OCR), images, audio and video transcripts, web pages, YouTube.' },
  { title: 'Studio', text: 'Executive summaries, comparison tables and slide outlines across documents.' },
  { title: 'Google Drive', text: 'Files and whole folders, kept in sync on a schedule.' },
  { title: 'Teams and sharing', text: 'Workspaces with roles, per-notebook access and share links.' },
  { title: 'Secure by design', text: 'Server-side sessions, CSP nonces, SSRF-safe fetching, encrypted tokens.' },
]

const STACK = [
  'Next.js 15',
  'React 19',
  'TypeScript',
  'PostgreSQL',
  'pgvector',
  'Neon',
  'Gemini / Gemma',
  'OpenAI-compatible models',
  'Tesseract OCR',
  'Vercel',
  'node:test + PGlite',
]

function Screenshot({ src, alt, width, height, priority = false }: { src: string; alt: string; width: number; height: number; priority?: boolean }) {
  return (
    // eslint-disable-next-line @next/next/no-img-element -- static WebP from public/, already sized
    <img
      src={src}
      alt={alt}
      width={width}
      height={height}
      loading={priority ? 'eager' : 'lazy'}
      fetchPriority={priority ? 'high' : 'auto'}
      className="h-auto w-full rounded-lg border border-border"
    />
  )
}

/**
 * Public page for visitors (recruiters, reviewers): what Corpus is, what to try, and a button that
 * starts a read-only guest session in the demo workspace (server/auth/demo.ts).
 */
export default async function DemoPage() {
  const demo = getDemoConfig()
  const user = await getUserFromCookies()

  return (
    <div className="min-h-screen">
      <header className="border-b border-border">
        <nav className="mx-auto flex max-w-6xl items-center justify-between px-4 py-3 sm:px-8">
          <Wordmark />
          <div className="flex items-center gap-2">
            <Button asChild variant="ghost" size="sm">
              <a href={REPOSITORY} target="_blank" rel="noreferrer">
                <Github className="mr-2 size-4" />
                GitHub
              </a>
            </Button>
            <Button asChild variant="outline" size="sm">
              <Link href={user && !user.guest ? '/' : '/login'}>{user && !user.guest ? 'Open the app' : 'Sign in'}</Link>
            </Button>
          </div>
        </nav>
      </header>

      <main className="mx-auto flex max-w-6xl flex-col gap-24 px-4 py-14 sm:px-8">
        <section className="grid items-center gap-10 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.15fr)]">
          <div className="flex flex-col items-start gap-6">
            <h1 className="max-w-[16ch] text-4xl font-medium leading-[1.05] tracking-tight sm:text-5xl">
              Ask your documents.
              <br />
              Get answers with citations.
            </h1>
            <p className="max-w-xl text-base leading-relaxed text-muted-foreground">
              Corpus is a team knowledge assistant built on retrieval-augmented generation. It turns files, scans, recordings, web pages and connected apps into notebooks, and
              answers questions only from them, with every claim linked to its source.
            </p>
            {demo ? (
              user?.guest ? (
                <Button asChild size="lg">
                  <Link href="/">Continue the demo</Link>
                </Button>
              ) : (
                <DemoEnterButton />
              )
            ) : (
              <p className="rounded-md border border-border bg-card px-4 py-3 text-sm text-muted-foreground">
                The live demo is closed right now. The code and screenshots are on GitHub.
              </p>
            )}
            <p className="text-[13px] text-muted-foreground">
              Live demo, no sign-up. A read-only workspace with sample notebooks; your questions are private and deleted after{' '}
              <span className="measured text-cool">{GUEST_LIFETIME_HOURS}</span> hours.
            </p>
          </div>
          <Screenshot src="/demo/chat.webp" alt="An answer with numbered citations, research steps and follow-up questions" width={1440} height={1400} priority />
        </section>

        <section className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_minmax(0,2fr)]">
          <h2 className="text-2xl font-medium tracking-tight">Try this in two minutes</h2>
          <ol className="m-0 list-none divide-y divide-border border-y border-border p-0">
            {STEPS.map((step, index) => (
              <li key={step.title} className="grid grid-cols-[2.5rem_minmax(0,1fr)] gap-x-4 py-4">
                <span className="measured text-lg text-cool">{String(index + 1).padStart(2, '0')}</span>
                <span>
                  <span className="block font-medium">{step.title}</span>
                  <span className="mt-1 block text-sm text-muted-foreground">{step.text}</span>
                </span>
              </li>
            ))}
          </ol>
        </section>

        <section className="flex flex-col gap-8">
          <h2 className="text-2xl font-medium tracking-tight">What it does</h2>
          <dl className="m-0 grid overflow-hidden rounded-lg border border-border bg-border [gap:1px] sm:grid-cols-2 lg:grid-cols-4">
            {FEATURES.map(({ title, text }) => (
              <div key={title} className="flex flex-col gap-1.5 bg-card p-5">
                <dt className="font-medium">{title}</dt>
                <dd className="m-0 text-sm text-muted-foreground">{text}</dd>
              </div>
            ))}
          </dl>
          <Screenshot src="/demo/sources.webp" alt="Sources drawer with indexing progress" width={1200} height={750} />
        </section>

        <section className="flex flex-col gap-8">
          <h2 className="text-2xl font-medium tracking-tight">Architecture</h2>
          <Screenshot
            src="/demo/architecture.webp"
            alt="Clients, the Next.js app on Vercel, and PostgreSQL with pgvector, AI models and external sources"
            width={1600}
            height={1252}
          />
          <ul aria-label="Built with" className="m-0 flex list-none flex-wrap gap-2 p-0">
            {STACK.map((item) => (
              <li key={item} className="rounded-sm border border-rule-2 px-2 py-1 text-[13px] text-ink-2">
                {item}
              </li>
            ))}
          </ul>
        </section>
      </main>

      <footer className="border-t border-border">
        <div className="mx-auto flex max-w-6xl flex-col items-start justify-between gap-4 px-4 py-8 text-sm text-muted-foreground sm:flex-row sm:items-center sm:px-8">
          <span>Built by Ankit Yadav</span>
          <div className="flex flex-wrap items-center gap-6">
            <a href={REPOSITORY} target="_blank" rel="noreferrer" className="flex items-center gap-2 transition-colors duration-micro hover:text-foreground">
              <Github className="size-4" />
              ankityadav1asia/Corpus
            </a>
            <AuthorCard />
          </div>
        </div>
      </footer>
    </div>
  )
}
