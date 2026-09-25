import { z } from 'zod'

import { idSchema, type ConnectorBrowseResult } from '@/lib/contracts'
import { connectorFor, ownConnection, withConnectorErrors } from '@/server/connectors/service'
import { parseWith } from '@/server/http/body'
import { json, workspaceRoute } from '@/server/http/route'
import { getServices } from '@/server/services'

const querySchema = z.object({
  parent: z.string().trim().max(500).nullable(),
  q: z.string().trim().max(200).nullable(),
  cursor: z.string().trim().max(2_000).nullable(),
})

/** Lists folders / pages / repositories of the caller's own connected account, for the import picker. */
export const GET = workspaceRoute<{ id: string }>(async ({ req, params, access }) => {
  const id = parseWith(idSchema, params.id)
  const search = req.nextUrl.searchParams
  const query = parseWith(querySchema, { parent: search.get('parent') || null, q: search.get('q') || null, cursor: search.get('cursor') || null })
  const services = getServices()
  const { connection, context } = await ownConnection(services, access, id)
  const connector = connectorFor(services, connection.provider)
  const result = await withConnectorErrors(() => connector.browse(context, { parentId: query.parent, query: query.q, cursor: query.cursor }))
  return json<ConnectorBrowseResult>(result)
})
