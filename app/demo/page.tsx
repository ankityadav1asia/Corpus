import { BookOpenCheck, Brain, FileSearch, Github, Layers, Lock, type LucideIcon, Network, ScanText, Share2, ShieldCheck, Sparkles, Workflow } from 'lucide-react'
import type { Metadata } from 'next'
import Link from 'next/link'

import { DemoEnterButton } from '@/components/demo-enter-button'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { getUserFromCookies } from '@/server/auth/current-user'
import { GUEST_LIFETIME_HOURS } from '@/server/auth/guest'
import { getDemoConfig } from '@/server/env'

export const dynamic = 'force-dynamic'

export const metadata: Metadata = {
  title: 'Corpus — live demo',
  description: 'Try Corpus without an account: ask questions about sample documents and get answers with citations.',
}

const REPOSITORY = 'https://github.com/ankityadav1asia/Corpus'

const STEPS = [
  { title: 'Ask a question', text: 'Type a question about the sample notebooks. The answer streams in with numbered citations.' },
  { title: 'Open a citation', text: 'Click [1] to see the exact passage, highlighted in the original PDF or page.' },
  { title: 'Watch it research', text: 'Switch to Deep mode: the query planner rewrites the question before searching.' },
  { title: 'Ask something off-topic', text: 'The guardrail refuses instead of making an answer up.' },
  { title: 'Explore the studio', text: 'Open the reports, mind maps and audio overviews made from the same sources.' },
]

const FEATURES: Array<{ icon: LucideIcon; title: string; text: string }> = [
  { icon: BookOpenCheck, title: 'Cited answers', text: 'Every answer comes only from your sources, with citations you can open.' },
  { icon: FileSearch, title: 'Hybrid retrieval', text: 'pgvector similarity + PostgreSQL full-text, fused with RRF, then re-ranked.' },
  { icon: ShieldCheck, title: 'Guardrail', text: 'Weak context gets a fixed "insufficient context" reply, never a guess.' },
  { icon: ScanText, title: 'Any source', text: 'PDFs, scans (OCR), images, audio and video transcripts, web pages, YouTube.' },
  { icon: Sparkles, title: 'Studio', text: 'Reports, slides, mind maps, two-host audio overviews and images.' },
  { icon: Workflow, title: 'Connected apps', text: 'Google Drive, Notion, GitHub and websites, synced on a schedule.' },
  { icon: Share2, title: 'Teams and sharing', text: 'Workspaces with roles, share links, Slack and Microsoft Teams bots.' },
  { icon: Lock, title: 'Secure by design', text: 'Server-side sessions, CSP nonces, SSRF-safe fetching, encrypted tokens.' },
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

function Screenshot({ src, alt, width, height }: { src: string; alt: string; width: number; height: number }) {
  // eslint-disable-next-line @next/next/no-img-element -- static WebP from public/, already sized
  return <img src={src} alt={alt} width={width} height={height} loading="lazy" className="h-auto w-full rounded-xl border border-border/80 shadow-2xl" />
}

/**
 * Public page for visitors (recruiters, reviewers): what Corpus is, what to try, and a button that
 * starts a read-only guest session in the demo workspace (server/auth/demo.ts).
 */
export default async function DemoPage() {
  const demo = getDemoConfig()
  const user = await getUserFromCookies()

  return (
    <main className="mx-auto flex min-h-screen max-w-6xl flex-col gap-20 px-5 py-8 sm:px-8">
      <nav className="flex items-center justify-between">
        <span className="flex items-center gap-2 font-display text-lg font-semibold">
          <Layers className="size-5 text-primary" />
          Corpus
        </span>
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

      <section className="grid items-center gap-10 lg:grid-cols-[1fr_1.1fr]">
        <div className="flex flex-col items-center gap-6 text-center sm:items-start sm:text-left">
          <Badge variant="outline" className="border-primary/40 text-primary">
            Live demo · no sign-up
          </Badge>
          <h1 className="font-display text-4xl font-semibold leading-tight tracking-tight sm:text-5xl">
            Ask your documents.
            <br />
            <span className="text-primary">Get answers with citations.</span>
          </h1>
          <p className="max-w-xl text-base text-muted-foreground">
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
            <p className="rounded-lg border border-border bg-card px-4 py-3 text-sm text-muted-foreground">
              The live demo is closed right now. The code and screenshots are on GitHub.
            </p>
          )}
          <p className="text-xs text-muted-foreground">Read-only workspace with sample notebooks. Your questions are private and deleted after {GUEST_LIFETIME_HOURS} hours.</p>
        </div>
        <Screenshot src="/demo/chat.webp" alt="An answer with numbered citations, research steps and follow-up questions" width={1440} height={1400} />
      </section>

      <section className="flex flex-col gap-6">
        <h2 className="font-display text-2xl font-semibold tracking-tight">Try this in two minutes</h2>
        <ol className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
          {STEPS.map((step, index) => (
            <li key={step.title} className="flex flex-col gap-2 rounded-xl border border-border/80 bg-card p-4">
              <span className="flex size-7 items-center justify-center rounded-full bg-primary/15 font-mono text-sm text-primary">{index + 1}</span>
              <span className="font-medium">{step.title}</span>
              <span className="text-sm text-muted-foreground">{step.text}</span>
            </li>
          ))}
        </ol>
      </section>

      <section className="flex flex-col gap-6">
        <h2 className="font-display text-2xl font-semibold tracking-tight">What it does</h2>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {FEATURES.map(({ icon: Icon, title, text }) => (
            <div key={title} className="flex flex-col gap-2 rounded-xl border border-border/80 bg-card p-5">
              <Icon className="size-5 text-primary" />
              <span className="font-medium">{title}</span>
              <span className="text-sm text-muted-foreground">{text}</span>
            </div>
          ))}
        </div>
        <div className="grid gap-4 md:grid-cols-2">
          <Screenshot src="/demo/sources.webp" alt="Sources drawer with indexing progress" width={1200} height={750} />
          <Screenshot src="/demo/mind-map.webp" alt="A mind map generated from the sources" width={1200} height={817} />
        </div>
      </section>

      <section className="flex flex-col gap-6">
        <div className="flex items-center gap-2">
          <Network className="size-5 text-primary" />
          <h2 className="font-display text-2xl font-semibold tracking-tight">Architecture</h2>
        </div>
        <Screenshot
          src="/demo/architecture.webp"
          alt="Clients, the Next.js app on Vercel, and PostgreSQL with pgvector, AI models and external sources"
          width={1600}
          height={1252}
        />
        <div className="flex flex-wrap gap-2">
          {STACK.map((item) => (
            <Badge key={item} variant="outline" className="font-mono text-xs">
              {item}
            </Badge>
          ))}
        </div>
      </section>

      <footer className="flex flex-col items-center justify-between gap-4 border-t border-border pb-4 pt-8 text-sm text-muted-foreground sm:flex-row">
        <span className="flex items-center gap-2">
          <Brain className="size-4 text-primary" />
          Built by Ankit Yadav
        </span>
        <a href={REPOSITORY} target="_blank" rel="noreferrer" className="flex items-center gap-2 hover:text-foreground">
          <Github className="size-4" />
          ankityadav1asia/Corpus
        </a>
      </footer>
    </main>
  )
}
