import { LIMITS } from '@/lib/constants'
import type { ConnectorBrowseItem } from '@/lib/contracts'
import { importableFileName } from '@/server/connectors/files'
import { ConnectorError, fetchJson, request, type Connector, type ConnectorContext, type SyncItem } from '@/server/connectors/types'

/**
 * Google Drive (read-only OAuth scope). Google Docs / Sheets / Slides are exported as Markdown / CSV /
 * text; PDFs, text files, images, audio and video are downloaded and go through the normal upload
 * pipeline (so scans get OCR and recordings get transcribed). Folders sync recursively.
 */

const API = 'https://www.googleapis.com/drive/v3'
const TOKEN_URL = 'https://oauth2.googleapis.com/token'
const FOLDER = 'application/vnd.google-apps.folder'
const SHARED = 'shared-with-me'
const MAX_DEPTH = 4
const FIELDS = 'nextPageToken,files(id,name,mimeType,modifiedTime,size,webViewLink)'

const EXPORTS: Record<string, { mimeType: string; fallback?: string }> = {
  'application/vnd.google-apps.document': { mimeType: 'text/markdown', fallback: 'text/plain' },
  'application/vnd.google-apps.spreadsheet': { mimeType: 'text/csv' },
  'application/vnd.google-apps.presentation': { mimeType: 'text/plain' },
}

interface DriveFile {
  id: string
  name: string
  mimeType: string
  modifiedTime?: string
  size?: string
  webViewLink?: string
}

export interface GoogleClient {
  clientId: string
  clientSecret: string
}

/** A valid access token, refreshed (and saved) when it is about to expire. */
async function accessToken(context: ConnectorContext, client: GoogleClient): Promise<string> {
  const { accessToken: current, expiresAt, refreshToken } = context.credentials
  if (current && Number(expiresAt) > Date.now() + 60_000) return current
  if (!refreshToken) throw new ConnectorError('Google Drive needs to be reconnected.', 401, false, true)
  let response: Response
  try {
    response = await context.fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: client.clientId, client_secret: client.clientSecret, refresh_token: refreshToken, grant_type: 'refresh_token' }),
      signal: AbortSignal.timeout(15_000),
    })
  } catch {
    throw new ConnectorError('Google could not be reached', null, true)
  }
  if (!response.ok) {
    // invalid_grant: the user revoked access or the token expired.
    throw new ConnectorError('Google Drive access has expired or was revoked. Reconnect Google Drive.', response.status, response.status >= 500, response.status < 500)
  }
  const token = (await response.json()) as { access_token?: string; expires_in?: number }
  if (!token.access_token) throw new ConnectorError('Google returned no access token', null, true)
  const updated = { ...context.credentials, accessToken: token.access_token, expiresAt: String(Date.now() + (token.expires_in ?? 3600) * 1000) }
  await context.saveCredentials(updated)
  context.credentials = updated
  return token.access_token
}

function isImportable(file: DriveFile): boolean {
  if (file.mimeType === FOLDER || EXPORTS[file.mimeType]) return true
  if (file.size && Number(file.size) > LIMITS.fileBytes) return false
  return importableFileName(file.name, file.mimeType) !== null
}

function toItem(file: DriveFile): ConnectorBrowseItem {
  const folder = file.mimeType === FOLDER
  return {
    id: file.id,
    name: file.name,
    kind: folder ? 'folder' : 'file',
    container: folder,
    importable: isImportable(file),
    mimeType: file.mimeType,
    modifiedAt: file.modifiedTime ?? null,
    size: file.size ? Number(file.size) : null,
    url: file.webViewLink ?? null,
  }
}

const quote = (value: string) => `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`

export function createGoogleDriveConnector(client: GoogleClient): Connector {
  async function listFiles(context: ConnectorContext, q: string, pageToken: string | null, pageSize = 100) {
    const url = new URL(`${API}/files`)
    url.searchParams.set('q', q)
    url.searchParams.set('fields', FIELDS)
    url.searchParams.set('pageSize', String(pageSize))
    url.searchParams.set('supportsAllDrives', 'true')
    url.searchParams.set('includeItemsFromAllDrives', 'true')
    url.searchParams.set('orderBy', 'folder,name')
    if (pageToken) url.searchParams.set('pageToken', pageToken)
    const token = await accessToken(context, client)
    return fetchJson<{ files?: DriveFile[]; nextPageToken?: string }>(context, 'Google Drive', url.toString(), { headers: { Authorization: `Bearer ${token}` } })
  }

  async function getFile(context: ConnectorContext, id: string): Promise<DriveFile> {
    const token = await accessToken(context, client)
    return fetchJson<DriveFile>(context, 'Google Drive', `${API}/files/${encodeURIComponent(id)}?fields=id,name,mimeType,modifiedTime,size,webViewLink&supportsAllDrives=true`, {
      headers: { Authorization: `Bearer ${token}` },
    })
  }

  const syncItem = (file: DriveFile): SyncItem => ({
    externalId: file.id,
    version: file.modifiedTime ?? null,
    title: file.name,
    url: file.webViewLink ?? null,
    meta: { mimeType: file.mimeType, size: file.size ?? '' },
  })

  return {
    id: 'google_drive',

    async browse(context, { parentId, query, cursor }) {
      let q: string
      if (query) q = `name contains ${quote(query)} and trashed = false`
      else if (parentId === SHARED) q = 'sharedWithMe = true and trashed = false'
      else q = `${quote(parentId ?? 'root')} in parents and trashed = false`
      const page = await listFiles(context, q, cursor)
      const items = (page.files ?? []).map(toItem)
      if (!parentId && !query && !cursor) {
        items.unshift({ id: SHARED, name: 'Shared with me', kind: 'folder', container: true, importable: false, mimeType: FOLDER, modifiedAt: null, size: null, url: null })
      }
      return { items, nextCursor: page.nextPageToken ?? null }
    },

    async list(context, source, limit) {
      if (source.kind === 'file') {
        const file = await getFile(context, source.externalId)
        return isImportable(file) && file.mimeType !== FOLDER ? [syncItem(file)] : []
      }
      const items: SyncItem[] = []
      const queue: Array<{ id: string; depth: number }> = [{ id: source.externalId, depth: 1 }]
      while (queue.length && items.length < limit) {
        const folder = queue.shift()!
        let pageToken: string | null = null
        do {
          const page = await listFiles(context, `${quote(folder.id)} in parents and trashed = false`, pageToken)
          for (const file of page.files ?? []) {
            if (file.mimeType === FOLDER) {
              if (folder.depth < MAX_DEPTH) queue.push({ id: file.id, depth: folder.depth + 1 })
            } else if (isImportable(file) && items.length < limit) {
              items.push(syncItem(file))
            }
          }
          pageToken = page.nextPageToken ?? null
        } while (pageToken && items.length < limit)
      }
      return items
    },

    async fetchItem(context, item) {
      const mimeType = item.meta?.mimeType ?? ''
      const token = await accessToken(context, client)
      const headers = { Authorization: `Bearer ${token}` }
      const exported = EXPORTS[mimeType]
      if (exported) {
        const exportUrl = (type: string) => `${API}/files/${encodeURIComponent(item.externalId)}/export?mimeType=${encodeURIComponent(type)}`
        let response: Response
        try {
          response = await request(context, 'Google Drive', exportUrl(exported.mimeType), { headers })
        } catch (error) {
          if (!exported.fallback || !(error instanceof ConnectorError) || error.status !== 400) throw error
          response = await request(context, 'Google Drive', exportUrl(exported.fallback), { headers })
        }
        return { type: 'text', title: item.title, text: await response.text(), url: item.url, version: item.version }
      }
      if (Number(item.meta?.size) > LIMITS.fileBytes) throw new ConnectorError(`"${item.title}" is larger than ${LIMITS.fileBytes / (1024 * 1024)} MB.`)
      const fileName = importableFileName(item.title, mimeType)
      if (!fileName) throw new ConnectorError(`"${item.title}" is not a supported file type.`)
      const response = await request(context, 'Google Drive', `${API}/files/${encodeURIComponent(item.externalId)}?alt=media&supportsAllDrives=true`, { headers })
      const data = new Uint8Array(await response.arrayBuffer())
      if (data.byteLength > LIMITS.fileBytes) throw new ConnectorError(`"${item.title}" is larger than ${LIMITS.fileBytes / (1024 * 1024)} MB.`)
      return { type: 'file', title: item.title, fileName, data, url: item.url, version: item.version }
    },
  }
}
