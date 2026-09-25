/**
 * Recursive character splitter (same algorithm as LangChain's RecursiveCharacterTextSplitter,
 * without pulling in LangChain). Tries paragraph, line, sentence, word and finally character
 * boundaries so chunks stay under `chunkSize` while keeping `chunkOverlap` characters of context.
 */

export interface SplitOptions {
  chunkSize?: number
  chunkOverlap?: number
  separators?: readonly string[]
}

const DEFAULT_SEPARATORS = ['\n\n', '\n', '. ', ' ', '']

export function splitText(text: string, options: SplitOptions = {}): string[] {
  const chunkSize = options.chunkSize ?? 1000
  const chunkOverlap = options.chunkOverlap ?? 150
  if (chunkOverlap >= chunkSize) throw new Error('chunkOverlap must be smaller than chunkSize')
  const separators = options.separators ?? DEFAULT_SEPARATORS
  return recursiveSplit(text, separators, chunkSize, chunkOverlap)
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\/-]/g, '\\$&')
}

/** Keeps the separator at the start of the following piece, so no text is lost. */
function splitKeepingSeparator(text: string, separator: string): string[] {
  if (separator === '') return Array.from(text)
  return text.split(new RegExp(`(?=${escapeRegExp(separator)})`)).filter((piece) => piece !== '')
}

function recursiveSplit(text: string, separators: readonly string[], chunkSize: number, chunkOverlap: number): string[] {
  let separator = separators[separators.length - 1] ?? ''
  let remaining: readonly string[] = []
  for (let i = 0; i < separators.length; i++) {
    const candidate = separators[i]!
    if (candidate === '') {
      separator = candidate
      break
    }
    if (text.includes(candidate)) {
      separator = candidate
      remaining = separators.slice(i + 1)
      break
    }
  }

  const chunks: string[] = []
  let pending: string[] = []
  for (const piece of splitKeepingSeparator(text, separator)) {
    if (piece.length < chunkSize) {
      pending.push(piece)
      continue
    }
    if (pending.length) {
      chunks.push(...mergePieces(pending, chunkSize, chunkOverlap))
      pending = []
    }
    if (remaining.length === 0) chunks.push(piece.trim())
    else chunks.push(...recursiveSplit(piece, remaining, chunkSize, chunkOverlap))
  }
  if (pending.length) chunks.push(...mergePieces(pending, chunkSize, chunkOverlap))
  return chunks.filter((chunk) => chunk.length > 0)
}

/** Greedily packs small pieces into chunks, carrying the tail of the previous chunk as overlap. */
function mergePieces(pieces: readonly string[], chunkSize: number, chunkOverlap: number): string[] {
  const chunks: string[] = []
  const window: string[] = []
  let total = 0
  for (const piece of pieces) {
    if (total + piece.length > chunkSize && window.length > 0) {
      const chunk = window.join('').trim()
      if (chunk) chunks.push(chunk)
      while (total > chunkOverlap || (total + piece.length > chunkSize && total > 0)) {
        total -= window.shift()!.length
      }
    }
    window.push(piece)
    total += piece.length
  }
  const last = window.join('').trim()
  if (last) chunks.push(last)
  return chunks
}
