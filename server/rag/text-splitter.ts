import { callCore } from '@/server/core'

/**
 * Recursive character splitter (the algorithm of LangChain's RecursiveCharacterTextSplitter):
 * tries paragraph, line, sentence, word and finally character boundaries so chunks stay under
 * `chunkSize` while keeping `chunkOverlap` characters of context. Lengths are JavaScript string
 * lengths. Implemented in the Rust core (core/src/splitter.rs).
 */

export interface SplitOptions {
  chunkSize?: number
  chunkOverlap?: number
}

export function splitText(text: string, options: SplitOptions = {}): string[] {
  return callCore<string[]>('split_text', { text, chunkSize: options.chunkSize ?? 1000, chunkOverlap: options.chunkOverlap ?? 150 })
}
