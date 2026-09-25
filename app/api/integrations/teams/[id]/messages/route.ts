import { idSchema } from '@/lib/contracts'
import { getSecretKeys } from '@/server/env'
import { parseWith, readBodyBytes } from '@/server/http/body'
import { Errors } from '@/server/http/errors'
import { json, publicRoute } from '@/server/http/route'
import { readCredentials } from '@/server/integrations/service'
import { isAllowedServiceUrl, parseTeamsActivity } from '@/server/integrations/teams'
import { queueBotQuestion, teamsVerifier } from '@/server/integrations/webhooks'
import { getServices } from '@/server/services'

/**
 * Bot Framework messaging endpoint of one Teams integration. The request's JWT must be signed by
 * the Bot Framework for this bot's App ID and the activity's service URL. Messages are acknowledged
 * at once and answered by a background job (a "typing…" indicator shows meanwhile).
 */
export const POST = publicRoute<{ id: string }>(async ({ req, params }) => {
  const id = parseWith(idSchema, params.id)
  const body = new TextDecoder().decode(await readBodyBytes(req, 256 * 1024))
  const services = getServices()
  const integration = await services.repos.integrations.byId(id)
  if (!integration || integration.provider !== 'teams') throw Errors.notFound('Integration')
  const credentials = await readCredentials(integration, getSecretKeys()).catch(() => null)
  if (!credentials || credentials.provider !== 'teams') throw Errors.notFound('Integration')

  let payload: unknown
  try {
    payload = JSON.parse(body)
  } catch {
    throw Errors.badRequest('Expected a JSON body.')
  }
  const raw = payload as { serviceUrl?: unknown; channelId?: unknown }
  const serviceUrl = typeof raw.serviceUrl === 'string' ? raw.serviceUrl : ''
  const channelId = typeof raw.channelId === 'string' ? raw.channelId : ''
  const verify = teamsVerifier(services.fetch?.() ?? fetch)
  const valid = serviceUrl !== '' && (await verify({ authorization: req.headers.get('authorization'), appId: credentials.appId, serviceUrl, channelId }).catch(() => false))
  if (!valid) throw Errors.unauthenticated()

  const activity = parseTeamsActivity(payload)
  if (!activity) return json({ ok: true })
  if (!isAllowedServiceUrl(activity.serviceUrl)) throw Errors.badRequest('Unexpected service URL.')

  await queueBotQuestion(services.repos, {
    provider: 'teams',
    integrationId: integration.id,
    question: activity.text.slice(0, 4_000),
    serviceUrl: activity.serviceUrl,
    conversationId: activity.conversationId,
    activityId: activity.id,
  })
  return json({ ok: true })
})
