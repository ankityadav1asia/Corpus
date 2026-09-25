import * as cheerio from 'cheerio'

import { htmlToDocument, truncateTitle } from '@/server/ingestion/text'
import { ConnectorError, type Connector, type ConnectorContext, type SyncItem } from '@/server/connectors/types'
import { parseFetchableUrl, safeFetchText, type FetchedPage } from '@/server/security/ssrf'

/**
 * Websites (documentation sites, help centres, blogs): pages under the start URL are read from the
 * sitemap when there is one, otherwise found by following links (same site, same path, 3 levels).
 * Every request goes through the SSRF-safe fetcher and robots.txt is respected. Change detection
 * uses a hash of the page text.
 */

const DEFAULT_PAGES = 25
const MAX_DEPTH = 3
const SKIP = /\.(pdf|png|jpe?g|gif|webp|svg|ico|zip|gz|tar|mp[34]|mov|avi|webm|woff2?|ttf|css|js|json|xml|rss)$/i

type FetchPage = (url: string, options?: { acceptContentTypes?: readonly string[] }) => Promise<FetchedPage>

/** "/docs/intro" → "/docs/": pages under the start page's folder. */
export function defaultPrefix(url: URL): string {
  return url.pathname.endsWith('/') ? url.pathname : url.pathname.slice(0, url.pathname.lastIndexOf('/') + 1) || '/'
}

export function normalizePageUrl(value: string, base?: string): URL | null {
  try {
    const url = new URL(value, base)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
    url.hash = ''
    return url
  } catch {
    return null
  }
}

/** Disallow rules for all agents (`User-agent: *`), from a robots.txt body. */
export function parseRobots(body: string): string[] {
  const rules: string[] = []
  let applies = false
  let sawRule = false
  for (const raw of body.split(/\r?\n/)) {
    const line = raw.replace(/#.*/, '').trim()
    const [field, ...rest] = line.split(':')
    const value = rest.join(':').trim()
    if (!field) continue
    const key = field.trim().toLowerCase()
    if (key === 'user-agent') {
      if (sawRule) {
        applies = false
        sawRule = false
      }
      if (value === '*') applies = true
    } else if (key === 'disallow' || key === 'allow') {
      sawRule = true
      if (applies && key === 'disallow' && value) rules.push(value)
    }
  }
  return rules
}

export function linksIn(html: string, pageUrl: string): string[] {
  const $ = cheerio.load(html)
  const links: string[] = []
  $('a[href]').each((_, element) => {
    const url = normalizePageUrl($(element).attr('href') ?? '', pageUrl)
    if (url) links.push(url.toString())
  })
  return links
}

async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return Buffer.from(digest).toString('hex').slice(0, 32)
}

export function createWebsiteConnector(options: { fetchPage?: FetchPage } = {}): Connector {
  const fetchPage: FetchPage = options.fetchPage ?? ((url, fetchOptions) => safeFetchText(url, fetchOptions))
  // Pages fetched while crawling are reused by fetchItem in the same sync run.
  const cache = new WeakMap<ConnectorContext, Map<string, FetchedPage>>()

  async function robots(origin: string): Promise<string[]> {
    try {
      return parseRobots((await fetchPage(`${origin}/robots.txt`, { acceptContentTypes: ['text/plain'] })).body)
    } catch {
      return []
    }
  }

  async function sitemap(origin: string): Promise<string[]> {
    try {
      const page = await fetchPage(`${origin}/sitemap.xml`, { acceptContentTypes: ['application/xml', 'text/xml'] })
      return [...page.body.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)].map((match) => match[1]!.replace(/&amp;/g, '&'))
    } catch {
      return []
    }
  }

  return {
    id: 'website',

    async browse() {
      throw new ConnectorError('Websites are added by URL.')
    },

    async list(context, source, limit) {
      const root = parseFetchableUrl(source.externalId)
      root.hash = ''
      const prefix = source.options.path?.startsWith('/') ? source.options.path : defaultPrefix(root)
      const maxPages = Math.min(source.options.maxPages ?? DEFAULT_PAGES, limit)
      const disallowed = await robots(root.origin)
      const allowed = (url: URL) =>
        url.origin === root.origin && url.pathname.startsWith(prefix) && !SKIP.test(url.pathname) && !disallowed.some((rule) => url.pathname.startsWith(rule))

      const pages = new Map<string, FetchedPage>()
      cache.set(context, pages)
      const found: string[] = [root.toString()]

      const fromSitemap = (await sitemap(root.origin))
        .map((value) => normalizePageUrl(value))
        .filter((url): url is URL => url !== null && allowed(url))
        .map((url) => url.toString())
      if (fromSitemap.length) {
        for (const url of fromSitemap) if (!found.includes(url) && found.length < maxPages) found.push(url)
      } else {
        const queue: Array<{ url: string; depth: number }> = [{ url: root.toString(), depth: 0 }]
        const seen = new Set(found)
        while (queue.length && pages.size < maxPages) {
          const next = queue.shift()!
          let page: FetchedPage
          try {
            page = await fetchPage(next.url)
          } catch {
            continue
          }
          pages.set(next.url, page)
          if (next.depth >= MAX_DEPTH || !page.contentType.includes('html')) continue
          for (const link of linksIn(page.body, page.url)) {
            const url = normalizePageUrl(link)
            if (!url || !allowed(url)) continue
            const key = url.toString()
            if (seen.has(key) || seen.size >= maxPages) continue
            seen.add(key)
            found.push(key)
            queue.push({ url: key, depth: next.depth + 1 })
          }
        }
      }
      return found.slice(0, maxPages).map((url): SyncItem => ({ externalId: url, version: null, title: truncateTitle(new URL(url).pathname || url), url }))
    },

    async fetchItem(context, item) {
      const page = cache.get(context)?.get(item.externalId) ?? (await fetchPage(item.externalId))
      const mime = page.contentType.split(';')[0]!.trim()
      const document = mime === 'text/plain' || mime === 'text/markdown' ? { title: item.title, text: page.body } : htmlToDocument(page.body, new URL(page.url).hostname)
      return { type: 'text', title: document.title || item.title, text: document.text, url: item.url, version: await sha256(document.text) }
    },
  }
}
