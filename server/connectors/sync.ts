import { z } from 'zod'

import { CONNECTOR_LABELS } from '@/lib/constants'
import { notify } from '@/server/activity'
import { can, effectiveCollectionRole } from '@/server/auth/permissions'
import type { ConnectorRegistry } from '@/server/connectors/registry'
import { ConnectorError, type Connector, type ConnectorContext, type FetchedItem, type SourceSpec, type SyncItem } from '@/server/connectors/types'
import { isAppError } from '@/server/http/errors'
import { readUpload } from '@/server/ingestion/extractors'
import { keepOriginalPdf, queueDocument, queueMedia } from '@/server/ingestion/ingest-service'
import { PermanentJobError } from '@/server/jobs/errors'
import { log } from '@/server/logger'
import type { Repositories } from '@/server/repositories'
import type { SourceRecord, SyncState } from '@/server/repositories/connectors'
import { openSecret, sealSecret, SecretUnreadableError } from '@/server/security/secrets'
import type { SecretKeys } from '@/server/security/keys'

/**
 * One sync of a connector source, the same for every provider:
 *   list   — everything in the source (bounded), stored as the sync state,
 *   import — each new or changed item is queued like an upload (text directly; files through the
 *            upload pipeline, so scans get OCR and recordings are transcribed); unchanged items are
 *            skipped by comparing versions,
 *   prune  — documents whose item disappeared upstream are removed.
 * Progress is saved after every item, so an interrupted sync resumes instead of starting over.
 */

export const syncPayload = z.object({ sourceId: z.guid() })

export const MAX_SYNC_ITEMS = 200

export interface SyncDeps {
  repos: Pick<Repositories, 'connectors' | 'documents' | 'media' | 'collections' | 'jobs' | 'notifications' | 'workspaces'>
  connectors: ConnectorRegistry
  /** AUTH_SECRET, for the encrypted credentials. */
  secret: SecretKeys
  fetch?: typeof fetch
}

/** Decrypted credentials of the source's connection, with a way to save refreshed ones. */
export async function openConnectionContext(deps: Pick<SyncDeps, 'repos' | 'secret' | 'fetch'>, workspaceId: string, connectionId: string | null): Promise<ConnectorContext> {
  const base = { fetch: deps.fetch ?? fetch }
  if (!connectionId) return { ...base, credentials: {}, saveCredentials: async () => {} }
  const connection = await deps.repos.connectors.getConnection(workspaceId, connectionId)
  if (!connection) throw new ConnectorError('The connected account was removed. Connect it again and re-add the source.', null, false, true)
  let credentials: Record<string, string>
  try {
    credentials = JSON.parse(await openSecret(connection.credentials, deps.secret)) as Record<string, string>
  } catch (error) {
    if (error instanceof SecretUnreadableError)
      throw new ConnectorError('The saved sign-in can no longer be read (the server secret changed). Reconnect the account.', null, false, true)
    throw error
  }
  return {
    ...base,
    credentials,
    saveCredentials: async (next) => deps.repos.connectors.updateCredentials(connection.id, await sealSecret(JSON.stringify(next), deps.secret)),
  }
}

/**
 * A source syncs with its adder's rights: they must still be a member allowed to use connectors
 * and to add sources to the notebook (roles and notebook overrides can change after it was added).
 */
async function adderMayStillIngest(repos: Pick<Repositories, 'workspaces' | 'collections'>, source: SourceRecord): Promise<boolean> {
  if (!source.createdBy) return false
  const membership = await repos.workspaces.membership(source.workspaceId, source.createdBy)
  if (!membership || !can(membership.role, 'connectors.use')) return false
  const collection = await repos.collections.get(source.workspaceId, source.collectionId, source.createdBy)
  return collection !== null && can(effectiveCollectionRole(membership.role, collection.override), 'collection.ingest')
}

function spec(source: SourceRecord): SourceSpec {
  return { externalId: source.externalId, kind: source.kind, name: source.name, options: source.options }
}

/** One sync in progress: the source, the adder whose rights it runs with, and how far it got. */
interface SyncRun {
  deps: SyncDeps
  source: SourceRecord
  adder: string
  connector: Connector
  context: ConnectorContext
  state: SyncState
}

/** Queues one fetched item like an upload; the previous version is replaced once the new one is ready. */
async function importItem({ deps, source, adder }: SyncRun, item: SyncItem, fetched: FetchedItem) {
  const base = {
    workspaceId: source.workspaceId,
    collectionId: source.collectionId,
    createdBy: adder,
    sourceType: source.provider,
    // A stable identity per item: new versions replace older ones with the same source.
    source: fetched.url ?? item.url ?? `${source.provider}:${item.externalId}`,
    title: fetched.title || item.title,
    replaceExisting: true,
    connectorSourceId: source.id,
    externalId: item.externalId,
    externalVersion: fetched.version ?? item.version,
  }
  if (fetched.type === 'text') {
    await queueDocument(deps.repos, { ...base, text: fetched.text })
    return
  }
  const content = await readUpload(new File([Buffer.from(fetched.data)], fetched.fileName))
  const document =
    content.type === 'text'
      ? await queueDocument(deps.repos, { ...base, text: content.document.text, byteSize: fetched.data.byteLength })
      : await queueMedia(
          deps.repos,
          { ...base, byteSize: fetched.data.byteLength },
          { kind: content.kind, mimeType: content.mimeType, fileName: fetched.fileName, data: content.data, pageCount: content.pageCount, pages: content.pages },
        )
  await keepOriginalPdf(deps.repos, document.id, fetched.fileName, fetched.data)
}

function failureSummary(state: SyncState): string | null {
  if (state.failed === 0) return null
  const shown = state.errors.slice(0, 3).join(' · ')
  return `${state.failed} item${state.failed === 1 ? '' : 's'} could not be imported${shown ? `: ${shown}` : ''}`
}

async function stopWithError(deps: SyncDeps, source: SourceRecord, message: string, connectionBroken: boolean): Promise<never> {
  if (connectionBroken && source.connectionId) await deps.repos.connectors.setConnectionStatus(source.connectionId, 'error', message)
  await deps.repos.connectors.finishSync(source.id, { status: 'error', itemCount: source.syncState?.items.length ?? 0, error: message })
  if (source.createdBy) {
    await notify(deps.repos, {
      userId: source.createdBy,
      workspaceId: source.workspaceId,
      kind: 'sync_failed',
      title: `Sync failed: ${source.name}`,
      body: message,
      link: { tab: 'sources' },
    })
  }
  throw new PermanentJobError(message)
}

/** The connector and the adder whose rights the sync runs with, or why it cannot run now. */
async function prepare(deps: SyncDeps, source: SourceRecord): Promise<{ connector: Connector; adder: string } | { blocked: string }> {
  const connector = deps.connectors.get(source.provider)
  if (!connector) return { blocked: deps.connectors.unavailableReason(source.provider) ?? `${CONNECTOR_LABELS[source.provider]} is not available on this server.` }
  if (!source.createdBy) return { blocked: 'The member who added this source is no longer in the workspace. Add it again.' }
  if (!(await adderMayStillIngest(deps.repos, source))) {
    return { blocked: 'The member who added this source can no longer add sources to this notebook. An editor must add it again.' }
  }
  return { connector, adder: source.createdBy }
}

/** First run of a sync: lists everything in the source (bounded) and saves it as the sync state. */
async function listItems(deps: SyncDeps, source: SourceRecord, connector: Connector, context: ConnectorContext): Promise<SyncState> {
  await deps.repos.connectors.setSourceStatus(source.id, 'syncing', `Looking for items in ${CONNECTOR_LABELS[source.provider]}`)
  const state: SyncState = { items: await connector.list(context, spec(source), MAX_SYNC_ITEMS), index: 0, changed: 0, failed: 0, errors: [] }
  await deps.repos.connectors.saveSyncState(source.id, state)
  return state
}

/** Fetches and imports one item unless its version is unchanged; unreadable items are counted and skipped. */
async function importIfChanged(run: SyncRun, item: SyncItem, previous: { version: string | null; status: string } | undefined) {
  const unchanged = (version: string | null) => previous !== undefined && previous.status !== 'failed' && version !== null && previous.version === version
  if (unchanged(item.version)) return
  try {
    const fetched = await run.connector.fetchItem(run.context, item, spec(run.source))
    if (unchanged(fetched.version)) return
    await importItem(run, item, fetched)
    run.state.changed++
  } catch (error) {
    // Unreadable or unsupported items are skipped (and reported); access and outages stop the sync.
    if (isAppError(error) || (error instanceof ConnectorError && !error.auth && !error.retryable)) {
      run.state.failed++
      if (run.state.errors.length < 5) run.state.errors.push(`${item.title}: ${error.message}`)
      return
    }
    throw error
  }
}

/** Imports the listed items from where the last run stopped; 'more' when the deadline is reached. */
async function importItems(run: SyncRun, deadline: number): Promise<'done' | 'more'> {
  const { deps, source, state } = run
  const existing = new Map((await deps.repos.connectors.syncedDocuments(source.id)).map((document) => [document.externalId, document]))
  for (; state.index < state.items.length; state.index++) {
    if (Date.now() > deadline) {
      await deps.repos.connectors.saveSyncState(source.id, state)
      return 'more'
    }
    const item = state.items[state.index]!
    await deps.repos.connectors.setSourceStatus(source.id, 'syncing', `Syncing ${state.index + 1} of ${state.items.length}`)
    await importIfChanged(run, item, existing.get(item.externalId))
  }
  return 'done'
}

/** Prunes documents whose item disappeared upstream, records the outcome and tells the adder what changed. */
async function finishRun({ deps, source, adder, state }: SyncRun) {
  const removed = await deps.repos.connectors.deleteMissingDocuments(
    source.id,
    state.items.map((item) => item.externalId),
  )
  const allFailed = state.items.length > 0 && state.failed === state.items.length
  await deps.repos.connectors.finishSync(source.id, { status: allFailed ? 'error' : 'idle', itemCount: state.items.length, error: failureSummary(state) })
  log.info('Connector synced', { sourceId: source.id, provider: source.provider, items: state.items.length, changed: state.changed, failed: state.failed, removed })
  if (state.changed === 0 && state.failed === 0 && removed === 0) return
  const parts = [
    state.changed ? `${state.changed} added or updated` : null,
    removed ? `${removed} removed` : null,
    state.failed ? `${state.failed} could not be imported` : null,
  ].filter(Boolean)
  await notify(deps.repos, {
    userId: adder,
    workspaceId: source.workspaceId,
    kind: allFailed ? 'sync_failed' : 'sync_done',
    title: `${CONNECTOR_LABELS[source.provider]} synced: ${source.name}`,
    body: `${parts.join(', ')}.`,
    link: { tab: 'sources' },
  })
}

export async function syncConnectorSource(deps: SyncDeps, sourceId: string, deadline: number): Promise<'done' | 'more' | 'missing'> {
  const source = await deps.repos.connectors.sourceForSync(sourceId)
  if (!source) return 'missing'
  const ready = await prepare(deps, source)
  if ('blocked' in ready) return stopWithError(deps, source, ready.blocked, false)

  let state = source.syncState
  try {
    const context = await openConnectionContext(deps, source.workspaceId, source.connectionId)
    state ??= await listItems(deps, source, ready.connector, context)
    const run: SyncRun = { deps, source, ...ready, context, state }
    if ((await importItems(run, deadline)) === 'more') return 'more'
    await finishRun(run)
    return 'done'
  } catch (error) {
    if (state) await deps.repos.connectors.saveSyncState(source.id, state)
    if (error instanceof ConnectorError && (error.auth || !error.retryable)) return stopWithError(deps, source, error.message, error.auth)
    throw error
  }
}

/** Queues the scheduled syncs that are due (called whenever the job queue is processed). */
export async function queueDueSyncs(repos: Pick<Repositories, 'connectors' | 'jobs'>, maxAttempts: number): Promise<number> {
  const due = await repos.connectors.claimDueSources(10)
  for (const sourceId of due) await repos.jobs.enqueue('sync_connector', { sourceId }, { maxAttempts })
  return due.length
}
