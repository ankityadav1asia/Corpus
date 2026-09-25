import type { ConnectorBrowseItem } from '@/lib/contracts'
import { ConnectorError, fetchJson, request, type Connector, type ConnectorContext, type SyncItem } from '@/server/connectors/types'

/**
 * GitHub repositories: documentation files (Markdown, text, reStructuredText, AsciiDoc) are synced,
 * optionally only under a folder. A personal access token is optional — without one, public
 * repositories work. The file list costs one API call; contents come from the raw-content host.
 */

const API = 'https://api.github.com'
const RAW = 'https://raw.githubusercontent.com'
export const DOC_EXTENSIONS = ['.md', '.mdx', '.markdown', '.txt', '.rst', '.adoc']
const MAX_FILE_BYTES = 1024 * 1024
const REPO = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/

function headers(context: ConnectorContext): Record<string, string> {
  const token = context.credentials.token
  return { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', ...(token ? { Authorization: `Bearer ${token}` } : {}) }
}

export function parseRepository(value: string): { owner: string; repo: string } {
  const trimmed = value
    .trim()
    .replace(/^https?:\/\/github\.com\//i, '')
    .replace(/\.git$/, '')
    .replace(/\/+$/, '')
  if (!REPO.test(trimmed)) throw new ConnectorError('Enter a repository as owner/name (for example vercel/next.js).')
  const [owner, repo] = trimmed.split('/') as [string, string]
  return { owner, repo }
}

const encodePath = (path: string) => path.split('/').map(encodeURIComponent).join('/')

interface Repo {
  full_name: string
  html_url: string
  default_branch: string
  pushed_at?: string
  private?: boolean
  description?: string | null
}

function repoItem(repo: Repo): ConnectorBrowseItem {
  return {
    id: repo.full_name,
    name: repo.full_name,
    kind: 'repository',
    container: false,
    importable: true,
    mimeType: null,
    modifiedAt: repo.pushed_at ?? null,
    size: null,
    url: repo.html_url,
  }
}

export function createGitHubConnector(): Connector {
  return {
    id: 'github',

    async browse(context, { query, cursor }) {
      if (query) {
        const { owner, repo } = parseRepository(query)
        const found = await fetchJson<Repo>(context, 'GitHub', `${API}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`, { headers: headers(context) })
        return { items: [repoItem(found)], nextCursor: null }
      }
      if (!context.credentials.token) return { items: [], nextCursor: null }
      const page = Number(cursor ?? '1')
      const repos = await fetchJson<Repo[]>(context, 'GitHub', `${API}/user/repos?per_page=100&sort=pushed&page=${page}`, { headers: headers(context) })
      return { items: repos.map(repoItem), nextCursor: repos.length === 100 ? String(page + 1) : null }
    },

    async list(context, source, limit) {
      const { owner, repo } = parseRepository(source.externalId)
      const base = `${API}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`
      const info = await fetchJson<Repo>(context, 'GitHub', base, { headers: headers(context) })
      const branch = info.default_branch
      const tree = await fetchJson<{ tree?: Array<{ path: string; type: string; sha: string; size?: number }>; truncated?: boolean }>(
        context,
        'GitHub',
        `${base}/git/trees/${encodeURIComponent(branch)}?recursive=1`,
        { headers: headers(context) },
      )
      const prefix = (source.options.path ?? '').replace(/^\/+|\/+$/g, '')
      return (tree.tree ?? [])
        .filter((entry) => entry.type === 'blob' && (entry.size ?? 0) <= MAX_FILE_BYTES)
        .filter((entry) => !prefix || entry.path === prefix || entry.path.startsWith(`${prefix}/`))
        .filter((entry) => DOC_EXTENSIONS.some((extension) => entry.path.toLowerCase().endsWith(extension)))
        .slice(0, limit)
        .map((entry): SyncItem => ({
          externalId: `${info.full_name}:${entry.path}`,
          version: entry.sha,
          title: `${repo}/${entry.path}`,
          url: `${info.html_url}/blob/${encodeURIComponent(branch)}/${encodePath(entry.path)}`,
          meta: { path: entry.path, branch, repository: info.full_name },
        }))
    },

    async fetchItem(context, item) {
      const { path, branch, repository } = item.meta ?? {}
      if (!path || !branch || !repository) throw new ConnectorError('Incomplete GitHub item')
      const { owner, repo } = parseRepository(repository)
      const url = `${RAW}/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/${encodeURIComponent(branch)}/${encodePath(path)}`
      const response = await request(context, 'GitHub', url, { headers: context.credentials.token ? { Authorization: `Bearer ${context.credentials.token}` } : {} })
      return { type: 'text', title: item.title, text: await response.text(), url: item.url, version: item.version }
    },
  }
}

/** Checks a token (or its absence) and names the connection. */
export async function describeGitHubToken(context: ConnectorContext): Promise<string> {
  if (!context.credentials.token) return 'Public repositories'
  const me = await fetchJson<{ login?: string }>(context, 'GitHub', `${API}/user`, { headers: headers(context) })
  return me.login ? `@${me.login}` : 'GitHub'
}
