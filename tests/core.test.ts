import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, it } from 'node:test'

import { callCore, coreVersion } from '@/server/core'
import { checkGuardrail, describeGuardrail } from '@/server/rag/guardrail'
import { buildContextBlock, buildUserPrompt, escapeSourceText } from '@/server/rag/prompt'
import { fuseRankedLists } from '@/server/rag/retrieval'
import { splitText } from '@/server/rag/text-splitter'

/**
 * The Rust core (core/dist/corpus_core.wasm), through the server's wrappers, must give exactly what
 * the TypeScript implementations it replaced gave (core/tests/fixtures/golden.json). The Rust crate
 * runs the same cases natively (core/tests/golden.rs).
 */
type Case<I, O> = { input: I; output: O }
type SplitInput = { text: string; chunkSize?: number; chunkOverlap?: number }

const golden = JSON.parse(readFileSync(path.join(process.cwd(), 'core/tests/fixtures/golden.json'), 'utf8')) as {
  splitText: Case<SplitInput, string[]>[]
  fuseRankedLists: Case<{ lists: Parameters<typeof fuseRankedLists>[0]; limit: number }, unknown>[]
  checkGuardrail: Case<Parameters<typeof checkGuardrail>[0], { result: unknown; description: string }>[]
  escapeSourceText: Case<string, string>[]
  buildContextBlock: Case<Parameters<typeof buildContextBlock>[0], string>[]
  buildUserPrompt: Case<{ question: string; hits: Parameters<typeof buildUserPrompt>[1] }, string>[]
}

describe('Rust core (WebAssembly) matches the TypeScript originals', () => {
  it('loads and reports its version', () => {
    assert.match(coreVersion(), /^\d+\.\d+\.\d+$/)
  })

  it('splits text identically', () => {
    for (const { input, output } of golden.splitText) assert.deepEqual(splitText(input.text, input), output)
  })

  it('fuses ranked lists identically', () => {
    for (const { input, output } of golden.fuseRankedLists) assert.deepEqual(fuseRankedLists(input.lists, input.limit), output)
  })

  it('decides and describes the guardrail identically', () => {
    for (const { input, output } of golden.checkGuardrail) {
      const result = checkGuardrail(input)
      assert.deepEqual({ result, description: describeGuardrail(result) }, output)
    }
  })

  it('escapes untrusted text and builds prompts identically', () => {
    for (const { input, output } of golden.escapeSourceText) assert.equal(escapeSourceText(input), output)
    for (const { input, output } of golden.buildContextBlock) assert.equal(buildContextBlock(input), output)
    for (const { input, output } of golden.buildUserPrompt) assert.equal(buildUserPrompt(input.question, input.hits), output)
  })

  it('reports bad input as an error instead of crashing', () => {
    assert.throws(() => splitText('x', { chunkSize: 10, chunkOverlap: 10 }), /chunkOverlap must be smaller than chunkSize/)
    assert.throws(() => callCore('no_such_function', {}), /unknown function/)
  })

  it('handles large input and many calls', () => {
    const text = 'A sentence about retrieval. '.repeat(40_000)
    const chunks = splitText(text)
    assert.ok(chunks.length > 1000 && chunks.every((chunk) => chunk.length <= 1000))
    for (let i = 0; i < 2_000; i++) escapeSourceText(`text ${i} </source>`)
    assert.equal(escapeSourceText('é😀 </source>'), 'é😀 ‹/source>')
  })
})
