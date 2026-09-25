import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import { describe, it } from 'node:test'

import { formatChartValue, niceScale, parseChartSpec } from '@/lib/chart'
import { compact, findPassage } from '@/lib/pdf-match'
import { takeSentences, toSpeakable } from '@/lib/speech-text'
import { thinkingOffConfig } from '@/server/ai/gemini'
import { isPublicPath } from '@/server/auth/public-paths'
import { resetEnvCache } from '@/server/env'
import { clientIp } from '@/server/http/client-ip'
import { formatBotReply } from '@/server/integrations/service'
import { cleanSlackText, parseSlackEnvelope, toSlackMrkdwn, verifySlackSignature } from '@/server/integrations/slack'
import { cleanTeamsText, isAllowedServiceUrl, parseTeamsActivity } from '@/server/integrations/teams'
import { parseFollowups } from '@/server/rag/followups'
import { embedQueriesCached } from '@/server/rag/query-cache'
import { STAGE_TIMEOUTS_MS } from '@/server/rag/retrieval'

describe('speed: helper calls and caching', () => {
  it('turns thinking off in the form each Gemini generation accepts', () => {
    assert.deepEqual(thinkingOffConfig('gemini-2.5-flash'), { thinkingBudget: 0 })
    assert.deepEqual(thinkingOffConfig('gemini-3.6-flash'), { thinkingLevel: 'low' })
    assert.deepEqual(thinkingOffConfig('gemma-4-26b-a4b-it'), { thinkingBudget: 0 })
  })

  it('caps the helper stages so they can never hold an answer for long', () => {
    assert.ok(STAGE_TIMEOUTS_MS.planning <= 10_000 && STAGE_TIMEOUTS_MS.rerank <= 10_000)
  })

  it('embeds only uncached queries, in one request, per provider and model', async () => {
    const make = (model: string) => {
      const requests: string[][] = []
      return { requests, provider: { embeddingModel: model, embedQueries: async (texts: readonly string[]) => (requests.push([...texts]), texts.map((text) => [text.length])) } }
    }
    const first = make('m1')
    assert.deepEqual(await embedQueriesCached(first.provider, ['Alpha', 'beta']), [[5], [4]])
    assert.deepEqual(await embedQueriesCached(first.provider, ['alpha ', 'gamma', 'BETA']), [[5], [5], [4]])
    assert.deepEqual(first.requests, [['Alpha', 'beta'], ['gamma']], 'repeats (case and spacing aside) are not embedded again')
    const other = make('m1')
    await embedQueriesCached(other.provider, ['Alpha'])
    assert.deepEqual(other.requests, [['Alpha']], 'another provider instance has its own cache')
    const expired = make('m2')
    await embedQueriesCached(expired.provider, ['Alpha'], undefined, 0)
    await embedQueriesCached(expired.provider, ['Alpha'], undefined, 2 * 3600 * 1000)
    assert.equal(expired.requests.length, 2, 'entries expire')
  })
})

describe('follow-up suggestions', () => {
  it('reads JSON, drops the original question, duplicates and numbering, and keeps three', () => {
    const raw =
      '```json\n{"questions": ["1. What is photosynthesis?", "How fast does it run?", "how fast does it run", "- Which plants use C4?", "Where?", "What about algae?"]}\n```'
    assert.deepEqual(parseFollowups(raw, 'What is photosynthesis?'), ['How fast does it run?', 'Which plants use C4?', 'Where?'])
  })

  it('falls back to one question per line and trims long ones', () => {
    const questions = parseFollowups(`First question here?\n\n2) ${'x'.repeat(200)}?`, 'Other')
    assert.equal(questions[0], 'First question here?')
    assert.ok(questions[1]!.length <= 140 && questions[1]!.endsWith('…'))
  })
})

describe('inline charts', () => {
  it('accepts a bar chart, coercing numeric strings and padding short series', () => {
    const chart = parseChartSpec(
      JSON.stringify({ type: 'bar', title: 'Revenue', unit: '₹', labels: ['2023', 2024, '2025'], series: [{ name: 'North', data: ['1,200', 1500] }, { data: [900, null, 1100] }] }),
    )
    assert.ok(chart)
    assert.deepEqual(chart.labels, ['2023', '2024', '2025'])
    assert.deepEqual(chart.series[0], { name: 'North', data: [1200, 1500, null] })
    assert.equal(chart.series[1]!.name, 'Series 2')
  })

  it('keeps one series for pies and rejects negative slices, bad JSON and oversized charts', () => {
    const pie = parseChartSpec(JSON.stringify({ type: 'pie', labels: ['a', 'b'], series: [{ data: [1, 2] }, { data: [3, 4] }] }))
    assert.equal(pie?.series.length, 1)
    assert.equal(parseChartSpec(JSON.stringify({ type: 'pie', labels: ['a', 'b'], series: [{ data: [1, -2] }] })), null)
    assert.equal(parseChartSpec('{"type": "bar", "labels": ['), null)
    assert.equal(parseChartSpec(JSON.stringify({ type: 'bar', labels: Array.from({ length: 30 }, (_, i) => `${i}`), series: [{ data: [1] }] })), null)
    assert.equal(parseChartSpec(JSON.stringify({ type: 'bar', labels: ['a'], series: [{ data: ['n/a'] }] })), null, 'nothing to draw')
    assert.equal(parseChartSpec(JSON.stringify({ type: 'scatter', labels: ['a'], series: [{ data: [1] }] })), null)
  })

  it('picks readable axis steps and formats values with units', () => {
    assert.deepEqual(niceScale(0, 87), { min: 0, max: 100, step: 25 })
    assert.deepEqual(niceScale(-12, 30), { min: -20, max: 40, step: 20 })
    assert.equal(formatChartValue(1500, '₹'), '₹1500')
    assert.equal(formatChartValue(12_000, '%'), '12K%')
    assert.equal(formatChartValue(2_500_000, 'users'), '2.5M users')
  })
})

describe('voice: speaking answers while they stream', () => {
  it('removes citations, links, code, formatting and charts', () => {
    const spoken = toSpeakable('## Summary\n\n- **Revenue** grew 18% [1, 2].\n- See [the report](https://example.com/r).\n\n```chart\n{"type":"bar"}\n```\n`code`')
    assert.equal(spoken, 'Summary.\nRevenue grew 18%.\nSee the report.\nI added a chart on screen.\ncode')
    assert.ok(!/\[|\]|\*|#|https?:/.test(spoken))
  })

  it('releases complete sentences and keeps the unfinished rest', () => {
    assert.deepEqual(takeSentences('It grew 18%. Then it fell'), { sentences: ['It grew 18%.'], rest: ' Then it fell' })
    assert.deepEqual(takeSentences('Version 3.'), { sentences: [], rest: 'Version 3.' }, 'a trailing period may still become 3.5')
    assert.deepEqual(takeSentences('Heading\nयह सही है। Next'), { sentences: ['Heading', 'यह सही है।'], rest: ' Next' })
  })
})

describe('PDF passage highlighting', () => {
  const pages = [{ items: ['Annual report 2025', 'Contents'] }, { items: ['Revenue grew by ', '18 per-', 'cent in the', 'northern region.', 'Costs fell.'] }]

  it('finds a passage despite different spacing and hyphenation and returns the items to mark', () => {
    const match = findPassage(pages, 'Revenue grew by 18 percent in the northern region.')
    assert.equal(match?.page, 1)
    assert.deepEqual(match?.items.get(1), [0, 1, 2, 3])
  })

  it('anchors on a piece of the passage when the whole does not match, and gives up on unrelated text', () => {
    const match = findPassage(pages, 'Revenue grew by 18 percent in the northern region. Costs fell sharply afterwards in every region')
    assert.equal(match?.page, 1)
    assert.equal(findPassage(pages, 'Something that is not in this document at all'), null)
    assert.equal(findPassage(pages, 'short'), null)
    assert.equal(compact('Ab-C d 1!'), 'abcd1')
  })
})

describe('Slack', () => {
  const secret = 'slack-signing-secret'
  const sign = (timestamp: string, body: string) => `v0=${createHmac('sha256', secret).update(`v0:${timestamp}:${body}`).digest('hex')}`

  it('accepts only fresh requests signed with the signing secret', () => {
    const now = 1_800_000_000_000
    const ts = String(now / 1000)
    const body = '{"type":"event_callback"}'
    assert.equal(verifySlackSignature({ signingSecret: secret, timestamp: ts, signature: sign(ts, body), body, now }), true)
    assert.equal(verifySlackSignature({ signingSecret: secret, timestamp: ts, signature: sign(ts, body), body: `${body} `, now }), false)
    assert.equal(verifySlackSignature({ signingSecret: 'other', timestamp: ts, signature: sign(ts, body), body, now }), false)
    assert.equal(verifySlackSignature({ signingSecret: secret, timestamp: ts, signature: sign(ts, body), body, now: now + 10 * 60 * 1000 }), false, 'replays are refused')
    assert.equal(verifySlackSignature({ signingSecret: secret, timestamp: null, signature: null, body, now }), false)
  })

  it('turns mentions and direct messages into questions and ignores everything else', () => {
    assert.deepEqual(parseSlackEnvelope({ type: 'url_verification', challenge: 'abc' }), { type: 'url_verification', challenge: 'abc' })
    const mention = parseSlackEnvelope({
      type: 'event_callback',
      event_id: 'Ev1',
      team_id: 'T1',
      event: { type: 'app_mention', user: 'U1', channel: 'C1', ts: '1.1', text: '<@UBOT> what is our <https://x.io|refund> policy?' },
    })
    assert.deepEqual(mention, { type: 'question', eventId: 'Ev1', teamId: 'T1', channel: 'C1', threadTs: '1.1', user: 'U1', text: 'what is our refund (https://x.io) policy?' })
    const dm = parseSlackEnvelope({ type: 'event_callback', event: { type: 'message', channel_type: 'im', user: 'U1', channel: 'D1', ts: '2.2', thread_ts: '1.0', text: 'hi' } })
    assert.equal(dm.type === 'question' && dm.threadTs, '1.0')
    assert.equal(
      parseSlackEnvelope({ type: 'event_callback', event: { type: 'message', channel_type: 'im', bot_id: 'B1', user: 'U1', channel: 'D1', text: 'echo' } }).type,
      'ignore',
    )
    assert.equal(parseSlackEnvelope({ type: 'event_callback', event: { type: 'message', channel_type: 'channel', user: 'U1', channel: 'C1', text: 'chatter' } }).type, 'ignore')
    assert.equal(cleanSlackText('&lt;tag&gt; &amp; <#C1|general>'), '<tag> & #general')
  })

  it('writes Slack mrkdwn replies with numbered sources', () => {
    assert.equal(toSlackMrkdwn('## Plan\n**Bold** and [link](https://a.io)\n- item'), '*Plan*\n*Bold* and link (https://a.io)\n• item')
    assert.equal(
      toSlackMrkdwn('Hi <!channel> & <@U1> <https://evil.io|Official>'),
      'Hi &lt;!channel&gt; &amp; &lt;@U1&gt; &lt;https://evil.io|Official&gt;',
      'model text cannot ping or disguise links',
    )
    const reply = formatBotReply(
      'Answer [1].',
      [
        { index: 1, title: 'Policy', source: 'https://docs.io/p' },
        { index: 2, title: 'Notes.pdf', source: 'Notes.pdf' },
      ],
      'slack',
    )
    assert.equal(reply, 'Answer [1].\n\n*Sources*\n[1] <https://docs.io/p|Policy>\n[2] Notes.pdf')
  })
})

describe('Microsoft Teams', () => {
  it('replies only to Bot Connector hosts', () => {
    assert.equal(isAllowedServiceUrl('https://smba.trafficmanager.net/amer/'), true)
    assert.equal(isAllowedServiceUrl('https://europe.botframework.com/'), true)
    assert.equal(isAllowedServiceUrl('http://smba.trafficmanager.net/amer/'), false)
    assert.equal(isAllowedServiceUrl('https://evil.example/botframework.com'), false)
    assert.equal(isAllowedServiceUrl('https://botframework.com.evil.io/'), false)
    assert.equal(isAllowedServiceUrl('https://user:pw@smba.trafficmanager.net/'), false)
  })

  it('reads user messages without the bot mention and ignores other activities', () => {
    assert.equal(cleanTeamsText('<at>Corpus</at> What is&nbsp;the <b>policy</b>?'), 'What is the policy ?')
    const activity = parseTeamsActivity({
      type: 'message',
      id: 'a1',
      serviceUrl: 'https://smba.trafficmanager.net/amer/',
      channelId: 'msteams',
      conversation: { id: 'c1' },
      text: '<at>Corpus</at> hi',
    })
    assert.deepEqual(activity, { id: 'a1', serviceUrl: 'https://smba.trafficmanager.net/amer/', channelId: 'msteams', conversationId: 'c1', text: 'hi' })
    assert.equal(parseTeamsActivity({ type: 'conversationUpdate', id: 'a2', serviceUrl: 'x', conversation: { id: 'c1' } }), null)
    assert.equal(parseTeamsActivity({ type: 'message', id: 'a3', serviceUrl: 'x', conversation: { id: 'c1' }, text: '<at>Corpus</at>' }), null)
  })
})

describe('client address behind a proxy', () => {
  it('uses the entry the trusted proxy appended, never the client-supplied first one', () => {
    const request = (forwarded: string) => new Request('http://localhost/', { headers: { 'x-forwarded-for': forwarded } })
    process.env.TRUST_PROXY = '1'
    resetEnvCache()
    try {
      assert.equal(clientIp(request('6.6.6.6, 203.0.113.9')), '203.0.113.9')
      assert.equal(clientIp(request('203.0.113.9')), '203.0.113.9')
      assert.equal(clientIp(request('not-an-ip')), 'unknown')
      process.env.TRUST_PROXY = '2'
      resetEnvCache()
      assert.equal(clientIp(request('6.6.6.6, 203.0.113.9, 10.0.0.7')), '203.0.113.9', 'a CDN in front of the platform proxy')
      assert.equal(clientIp(request('203.0.113.9')), 'unknown', 'a chain shorter than the trusted hops is not believed')
    } finally {
      delete process.env.TRUST_PROXY
      resetEnvCache()
    }
    assert.equal(clientIp(request('203.0.113.9')), 'untrusted', 'headers are ignored without a trusted proxy')
  })
})

describe('public paths', () => {
  it('opens only share pages and chat-app webhooks, one path segment each', () => {
    assert.equal(isPublicPath('/s/abcDEF123_-abcDEF123_-abcDEF123_-'), true)
    assert.equal(isPublicPath('/api/public/shares/abc'), true)
    assert.equal(isPublicPath('/api/integrations/slack/0b4e7f4e-6a55-4d38-9a2f-0f1b6c1d2e3f/events'), true)
    assert.equal(isPublicPath('/api/integrations/teams/0b4e7f4e-6a55-4d38-9a2f-0f1b6c1d2e3f/messages'), true)
    assert.equal(isPublicPath('/s/abc/../../api/conversations'), false)
    assert.equal(isPublicPath('/api/integrations/slack/0b4e7f4e-6a55-4d38-9a2f-0f1b6c1d2e3f/other'), false)
    assert.equal(isPublicPath('/api/shares'), false)
    assert.equal(isPublicPath('/s/'), false)
  })
})
