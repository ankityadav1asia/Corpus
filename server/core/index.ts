import 'server-only'

import { readFileSync } from 'node:fs'
import path from 'node:path'

/**
 * The Rust RAG core (core/, built to core/dist/corpus_core.wasm) loaded into this Node.js process.
 * Text splitting, rank fusion, the guardrail decision and prompt escaping run in Rust; callers use
 * the typed wrappers in server/rag/*, which keep their signatures.
 *
 * The module has one JSON entry point: write a request with `alloc`, call `invoke`, read the
 * response (pointer and length packed into one u64), free both with `dealloc`. It imports nothing,
 * and loading it takes a few milliseconds, so it is compiled synchronously on first use.
 */

interface CoreExports {
  memory: WebAssembly.Memory
  alloc(len: number): number
  dealloc(pointer: number, len: number): void
  invoke(pointer: number, len: number): bigint
}

/** Where the module is read from; next.config.mjs traces it into every API function. */
export const CORE_WASM_PATH = path.join(process.cwd(), 'core', 'dist', 'corpus_core.wasm')

let core: CoreExports | null = null

function load(): CoreExports {
  if (core) return core
  const compiled = new WebAssembly.Module(readFileSync(CORE_WASM_PATH))
  core = new WebAssembly.Instance(compiled, {}).exports as unknown as CoreExports
  return core
}

const encoder = new TextEncoder()
const decoder = new TextDecoder()

/** Calls a core function; errors the core reports (bad input) are thrown as Error. */
export function callCore<T>(fn: string, args: unknown): T {
  const exports = load()
  const request = encoder.encode(JSON.stringify({ fn, args }))
  const input = exports.alloc(request.length)
  new Uint8Array(exports.memory.buffer, input, request.length).set(request)
  let packed: bigint
  try {
    packed = exports.invoke(input, request.length)
  } finally {
    exports.dealloc(input, request.length)
  }
  const pointer = Number(packed >> 32n)
  const length = Number(packed & 0xffffffffn)
  // Copy out before freeing: the view points into the module's memory.
  const text = decoder.decode(new Uint8Array(exports.memory.buffer, pointer, length).slice())
  exports.dealloc(pointer, length)
  const response = JSON.parse(text) as { ok?: T; error?: string }
  if (typeof response.error === 'string') throw new Error(response.error)
  return response.ok as T
}

/** The core crate's version (core/Cargo.toml). */
export function coreVersion(): string {
  return callCore<string>('version', {})
}
