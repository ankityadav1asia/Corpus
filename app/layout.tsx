import type { Metadata } from 'next'
import { DM_Sans, JetBrains_Mono, Plus_Jakarta_Sans } from 'next/font/google'
import { headers } from 'next/headers'

import { Toaster } from '@/components/ui/toaster'
import { THEME_BOOTSTRAP_SCRIPT } from '@/lib/theme'
import { cn } from '@/lib/utils'

import './globals.css'

const fontSans = DM_Sans({ subsets: ['latin'], variable: '--font-sans' })
const fontDisplay = Plus_Jakarta_Sans({ subsets: ['latin'], variable: '--font-display' })
const fontMono = JetBrains_Mono({ subsets: ['latin'], variable: '--font-mono' })

export const metadata: Metadata = {
  title: 'Corpus — Ask your documents',
  description: 'Team knowledge workspaces: answers, reports and images grounded in your files, pages and videos.',
}

export default async function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  // Per-request CSP nonce from middleware.ts; reading it also renders every page per request,
  // which a nonce-based policy requires.
  const nonce = (await headers()).get('x-nonce') ?? undefined
  return (
    <html lang="en" className="dark" suppressHydrationWarning>
      <head>
        {/* Static constant, no user data: sets the saved theme before first paint. */}
        <script nonce={nonce} dangerouslySetInnerHTML={{ __html: THEME_BOOTSTRAP_SCRIPT }} />
      </head>
      <body className={cn('min-h-screen bg-background font-sans antialiased', fontSans.variable, fontDisplay.variable, fontMono.variable)}>
        <div className="grain pointer-events-none fixed inset-0" aria-hidden />
        {children}
        <Toaster />
      </body>
    </html>
  )
}
