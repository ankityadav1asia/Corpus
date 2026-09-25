/**
 * Finds a cited passage inside a PDF's text items (as pdf.js returns them per page), so the viewer
 * can jump to that page and highlight the items. The passage text came from the same PDF, but
 * spacing, line breaks and hyphenation differ, so matching ignores everything except letters and
 * digits.
 */

export interface PageText {
  /** Text of each item on the page, in reading order. */
  items: readonly string[]
}

export interface PassageMatch {
  /** 0-based page index where the passage starts. */
  page: number
  /** Item indexes to highlight, per 0-based page index. */
  items: Map<number, number[]>
}

const normalizeChar = (ch: string) => ch.toLowerCase()
const KEEP = /[\p{L}\p{N}]/u

/** Letters and digits only, lower-cased. */
export function compact(text: string): string {
  let out = ''
  for (const ch of text) if (KEEP.test(ch)) out += normalizeChar(ch)
  return out
}

interface Flattened {
  text: string
  /** For each character of `text`: [page, item]. */
  owners: Array<[number, number]>
}

function flatten(pages: readonly PageText[]): Flattened {
  let text = ''
  const owners: Array<[number, number]> = []
  pages.forEach((page, p) =>
    page.items.forEach((item, i) => {
      for (const ch of item) {
        if (!KEEP.test(ch)) continue
        text += normalizeChar(ch)
        owners.push([p, i])
      }
    }),
  )
  return { text, owners }
}

function collect(flat: Flattened, start: number, end: number): PassageMatch {
  const items = new Map<number, number[]>()
  for (let k = start; k < end && k < flat.owners.length; k++) {
    const [page, item] = flat.owners[k]!
    const list = items.get(page) ?? []
    if (list[list.length - 1] !== item) list.push(item)
    items.set(page, list)
  }
  return { page: flat.owners[start]![0], items }
}

/**
 * Locates `passage` across the pages. Tries the whole passage, then its beginning, middle and end
 * (a chunk can straddle text the PDF lays out differently). Null when nothing matches.
 */
export function findPassage(pages: readonly PageText[], passage: string): PassageMatch | null {
  const needle = compact(passage)
  if (needle.length < 12) return null
  const flat = flatten(pages)
  if (!flat.text) return null

  const whole = flat.text.indexOf(needle)
  if (whole >= 0) return collect(flat, whole, whole + needle.length)

  const probe = Math.min(60, Math.floor(needle.length / 3))
  const anchors = [0, Math.floor((needle.length - probe) / 2), needle.length - probe]
  for (const offset of anchors) {
    const at = flat.text.indexOf(needle.slice(offset, offset + probe))
    if (at < 0) continue
    // Highlight the span the whole passage would cover, anchored where this piece was found.
    const start = Math.max(0, at - offset)
    return collect(flat, start, Math.min(flat.text.length, start + needle.length))
  }
  return null
}
