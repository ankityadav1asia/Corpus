import type { ConnectorBrowseItem } from '@/lib/contracts'
import { ConnectorError, fetchJson, type Connector, type ConnectorContext, type SyncItem } from '@/server/connectors/types'

/**
 * Notion, through an internal integration token (Settings → Connections → Develop integrations;
 * then share pages with the integration). Pages are converted to Markdown; a database syncs every
 * page in it.
 */

const API = 'https://api.notion.com/v1'
const VERSION = '2022-06-28'
const MAX_BLOCKS = 2_500
const MAX_DEPTH = 4

interface RichText {
  plain_text?: string
  href?: string | null
}

interface NotionPage {
  object: 'page' | 'database'
  id: string
  url?: string
  last_edited_time?: string
  properties?: Record<string, { type?: string; title?: RichText[] }>
  title?: RichText[]
}

interface Block {
  id: string
  type: string
  has_children?: boolean
  [key: string]: unknown
}

function headers(context: ConnectorContext, json = false): Record<string, string> {
  if (!context.credentials.token) throw new ConnectorError('Notion needs to be reconnected.', 401, false, true)
  return { Authorization: `Bearer ${context.credentials.token}`, 'Notion-Version': VERSION, ...(json ? { 'Content-Type': 'application/json' } : {}) }
}

const text = (parts: RichText[] | undefined) => (parts ?? []).map((part) => part.plain_text ?? '').join('')

export function pageTitle(page: NotionPage): string {
  if (page.object === 'database') return text(page.title) || 'Untitled database'
  for (const property of Object.values(page.properties ?? {})) {
    if (property.type === 'title') return text(property.title) || 'Untitled'
  }
  return 'Untitled'
}

function richTextOf(block: Block): RichText[] {
  const body = block[block.type] as { rich_text?: RichText[] } | undefined
  return body?.rich_text ?? []
}

interface BlockParts {
  content: string
  indent: string
  body: Record<string, unknown> | undefined
}
type RenderBlock = (block: BlockParts) => string | null

const plainBlock: RenderBlock = ({ content, indent }) => (content ? `${indent}${content}` : null)

const linkBlock: RenderBlock = ({ content, indent, body }) => {
  const url = String(body?.url ?? '')
  return url ? `${indent}[${content || url}](${url})` : null
}

/** Markdown for the block types that carry text or structure; any other type keeps its plain text. */
const BLOCK_RENDERERS = new Map<string, RenderBlock>([
  ['paragraph', plainBlock],
  ['heading_1', ({ content }) => `# ${content}`],
  ['heading_2', ({ content }) => `## ${content}`],
  ['heading_3', ({ content }) => `### ${content}`],
  ['bulleted_list_item', ({ content, indent }) => `${indent}- ${content}`],
  ['numbered_list_item', ({ content, indent }) => `${indent}1. ${content}`],
  ['to_do', ({ content, indent, body }) => `${indent}- [${body?.checked ? 'x' : ' '}] ${content}`],
  ['toggle', ({ content, indent }) => `${indent}- ${content}`],
  ['quote', ({ content, indent }) => `${indent}> ${content}`],
  ['callout', ({ content, indent }) => `${indent}> ${content}`],
  ['code', ({ content, body }) => `\`\`\`${String(body?.language ?? '')}\n${content}\n\`\`\``],
  ['equation', ({ body }) => `$$${String(body?.expression ?? '')}$$`],
  ['divider', () => '---'],
  [
    'table_row',
    ({ body }) => {
      const cells = (body?.cells as RichText[][] | undefined) ?? []
      return `| ${cells.map((cell) => text(cell).replace(/\|/g, '\\|')).join(' | ')} |`
    },
  ],
  ['child_page', ({ body }) => `## ${String(body?.title ?? 'Sub-page')}`],
  ['child_database', ({ body }) => `## ${String(body?.title ?? 'Database')}`],
  ['bookmark', linkBlock],
  ['embed', linkBlock],
  ['link_preview', linkBlock],
])

/** Notion blocks → Markdown (the block types that carry text; embeds become links). */
export function blockToMarkdown(block: Block, indent: string): string | null {
  const render = BLOCK_RENDERERS.get(block.type) ?? plainBlock
  return render({ content: text(richTextOf(block)), indent, body: block[block.type] as Record<string, unknown> | undefined })
}

export function createNotionConnector(): Connector {
  async function children(context: ConnectorContext, blockId: string, depth: number, budget: { blocks: number }, lines: string[]) {
    let cursor: string | null = null
    do {
      const url: string = `${API}/blocks/${encodeURIComponent(blockId)}/children?page_size=100${cursor ? `&start_cursor=${encodeURIComponent(cursor)}` : ''}`
      const page: { results?: Block[]; has_more?: boolean; next_cursor?: string | null } = await fetchJson(context, 'Notion', url, { headers: headers(context) })
      let tableHeaderDone = false
      for (const block of page.results ?? []) {
        if (budget.blocks-- <= 0) return
        const line = blockToMarkdown(block, '  '.repeat(Math.max(0, depth - 1)))
        if (line) lines.push(line)
        if (block.type === 'table_row' && !tableHeaderDone) {
          const cells = ((block.table_row as { cells?: unknown[] } | undefined)?.cells ?? []).length
          lines.push(`| ${Array.from({ length: cells }, () => '---').join(' | ')} |`)
          tableHeaderDone = true
        }
        // Sub-pages sync as their own items when inside a database; here only their title is kept.
        if (block.has_children && depth < MAX_DEPTH && block.type !== 'child_page' && block.type !== 'child_database') {
          await children(context, block.id, depth + 1, budget, lines)
        }
      }
      cursor = page.has_more ? (page.next_cursor ?? null) : null
    } while (cursor && budget.blocks > 0)
  }

  const syncItem = (page: NotionPage): SyncItem => ({ externalId: page.id, version: page.last_edited_time ?? null, title: pageTitle(page), url: page.url ?? null })

  return {
    id: 'notion',

    async browse(context, { query, cursor }) {
      const body: Record<string, unknown> = { page_size: 50, sort: { direction: 'descending', timestamp: 'last_edited_time' } }
      if (query) body.query = query
      if (cursor) body.start_cursor = cursor
      const result = await fetchJson<{ results?: NotionPage[]; has_more?: boolean; next_cursor?: string | null }>(context, 'Notion', `${API}/search`, {
        method: 'POST',
        headers: headers(context, true),
        body: JSON.stringify(body),
      })
      const items: ConnectorBrowseItem[] = (result.results ?? []).map((page) => ({
        id: page.id,
        name: pageTitle(page),
        kind: page.object === 'database' ? 'database' : 'page',
        container: false,
        importable: true,
        mimeType: null,
        modifiedAt: page.last_edited_time ?? null,
        size: null,
        url: page.url ?? null,
      }))
      return { items, nextCursor: result.has_more ? (result.next_cursor ?? null) : null }
    },

    async list(context, source, limit) {
      if (source.kind === 'page') {
        const page = await fetchJson<NotionPage>(context, 'Notion', `${API}/pages/${encodeURIComponent(source.externalId)}`, { headers: headers(context) })
        return [syncItem(page)]
      }
      const items: SyncItem[] = []
      let cursor: string | null = null
      do {
        const result: { results?: NotionPage[]; has_more?: boolean; next_cursor?: string | null } = await fetchJson(
          context,
          'Notion',
          `${API}/databases/${encodeURIComponent(source.externalId)}/query`,
          { method: 'POST', headers: headers(context, true), body: JSON.stringify({ page_size: 100, ...(cursor ? { start_cursor: cursor } : {}) }) },
        )
        for (const page of result.results ?? []) if (items.length < limit) items.push(syncItem(page))
        cursor = result.has_more ? (result.next_cursor ?? null) : null
      } while (cursor && items.length < limit)
      return items
    },

    async fetchItem(context, item) {
      const lines: string[] = [`# ${item.title}`]
      await children(context, item.externalId, 1, { blocks: MAX_BLOCKS }, lines)
      return { type: 'text', title: item.title, text: lines.join('\n\n'), url: item.url, version: item.version }
    },
  }
}

/** Checks a token and names the connection after the integration's workspace. */
export async function describeNotionToken(context: ConnectorContext): Promise<string> {
  const me = await fetchJson<{ name?: string; bot?: { workspace_name?: string } }>(context, 'Notion', `${API}/users/me`, { headers: headers(context) })
  return me.bot?.workspace_name || me.name || 'Notion'
}
