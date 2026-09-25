import { idSchema } from '@/lib/contracts'
import { getSecretKeys } from '@/server/env'
import { parseWith, readBodyBytes } from '@/server/http/body'
import { Errors } from '@/server/http/errors'
import { json, publicRoute } from '@/server/http/route'
import { readCredentials } from '@/server/integrations/service'
import { parseSlackEnvelope, verifySlackSignature } from '@/server/integrations/slack'
import { queueBotQuestion } from '@/server/integrations/webhooks'
import { getServices } from '@/server/services'

/**
 * Slack Events API endpoint of one integration. Every request must carry a valid Slack signature
 * made with that integration's signing secret. Questions are acknowledged at once (Slack expects
 * a reply within 3 s) and answered by a background job that posts in the thread.
 */
export const POST = publicRoute<{ id: string }>(async ({ req, params }) => {
  const id = parseWith(idSchema, params.id)
  const body = new TextDecoder().decode(await readBodyBytes(req, 256 * 1024))
  const { repos } = getServices()
  const integration = await repos.integrations.byId(id)
  if (!integration || integration.provider !== 'slack') throw Errors.notFound('Integration')
  const credentials = await readCredentials(integration, getSecretKeys()).catch(() => null)
  if (!credentials || credentials.provider !== 'slack') throw Errors.notFound('Integration')
  const signed = verifySlackSignature({
    signingSecret: credentials.signingSecret,
    timestamp: req.headers.get('x-slack-request-timestamp'),
    signature: req.headers.get('x-slack-signature'),
    body,
  })
  if (!signed) throw Errors.unauthenticated()

  let payload: unknown
  try {
    payload = JSON.parse(body)
  } catch {
    throw Errors.badRequest('Expected a JSON body.')
  }
  const envelope = parseSlackEnvelope(payload)
  if (envelope.type === 'url_verification') return json({ challenge: envelope.challenge })
  // Slack retries when it did not get a quick 200; the first delivery is already being answered.
  if (envelope.type !== 'question' || req.headers.get('x-slack-retry-num')) return json({ ok: true })

  await queueBotQuestion(repos, {
    provider: 'slack',
    integrationId: integration.id,
    question: envelope.text.slice(0, 4_000),
    channel: envelope.channel,
    threadTs: envelope.threadTs,
  })
  return json({ ok: true })
})
