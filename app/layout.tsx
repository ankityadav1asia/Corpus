import type { Metadata } from 'next'
import { Atkinson_Hyperlegible_Mono, Host_Grotesk } from 'next/font/google'
import { headers } from 'next/headers'

import { Toaster } from '@/components/ui/toaster'
import { THEME_BOOTSTRAP_SCRIPT } from '@/lib/theme'
import { cn } from '@/lib/utils'

import './globals.css'

// Host Grotesk for what a person reads; Atkinson Hyperlegible Mono for what the system measured (app/tokens.css).
const fontSans = Host_Grotesk({ subsets: ['latin'], weight: ['400', '500'], variable: '--font-host-grotesk', display: 'swap' })
const fontMono = Atkinson_Hyperlegible_Mono({ subsets: ['latin'], weight: ['400', '500'], variable: '--font-atkinson-mono', display: 'swap' })

export const metadata: Metadata = {
  title: 'Corpus',
  description: 'Team knowledge workspaces: answers, reports, audio overviews and mind maps grounded in your files, pages and videos.',
}

export default async function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  // Per-request CSP nonce from middleware.ts; reading it also renders every page per request,
  // which a nonce-based policy requires.
  const nonce = (await headers()).get('x-nonce') ?? undefined
  return (
    <html lang="en" className={cn('dark', fontSans.variable, fontMono.variable)} suppressHydrationWarning>
      <head>
        {/* Static constant, no user data: sets the saved theme before first paint. */}
        <script nonce={nonce} dangerouslySetInnerHTML={{ __html: THEME_BOOTSTRAP_SCRIPT }} />
      </head>
      <body className="min-h-screen bg-background font-sans antialiased">
        {children}
        <Toaster />
      </body>
    </html>
  )
}
