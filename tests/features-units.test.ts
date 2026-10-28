import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { formatChartValue, niceScale, parseChartSpec } from '@/lib/chart'
import { compact, findPassage } from '@/lib/pdf-match'
import { thinkingOffConfig } from '@/server/ai/gemini'
import { isPublicPath } from '@/server/auth/public-paths'
import { resetEnvCache } from '@/server/env'
import { clientIp } from '@/server/http/client-ip'
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
  it('opens only share pages, one path segment each', () => {
    assert.equal(isPublicPath('/s/abcDEF123_-abcDEF123_-abcDEF123_-'), true)
    assert.equal(isPublicPath('/api/public/shares/abc'), true)
    assert.equal(isPublicPath('/api/integrations/slack/0b4e7f4e-6a55-4d38-9a2f-0f1b6c1d2e3f/events'), false, 'the Slack bot was removed')
    assert.equal(isPublicPath('/api/integrations/teams/0b4e7f4e-6a55-4d38-9a2f-0f1b6c1d2e3f/messages'), false, 'the Teams bot was removed')
    assert.equal(isPublicPath('/s/abc/../../api/conversations'), false)
    assert.equal(isPublicPath('/api/integrations/slack/0b4e7f4e-6a55-4d38-9a2f-0f1b6c1d2e3f/other'), false)
    assert.equal(isPublicPath('/api/shares'), false)
    assert.equal(isPublicPath('/s/'), false)
  })
})
