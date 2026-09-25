/**
 * Turning a Markdown answer into speech, sentence by sentence while it is still streaming, so voice
 * mode starts talking after the first sentence instead of after the whole answer.
 */

/** Markdown → plain spoken text: no citations, code, charts, links or formatting marks. */
export function toSpeakable(markdown: string): string {
  return (
    markdown
      // A chart is described, not read out as JSON.
      .replace(/```chart[\s\S]*?(```|$)/g, ' I added a chart on screen. ')
      .replace(/```[\s\S]*?(```|$)/g, ' ')
      .replace(/`([^`]*)`/g, '$1')
      .replace(/\s*\[(\d+(?:\s*,\s*\d+)*)\]/g, '')
      .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
      .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
      .replace(/https?:\/\/\S+/g, '')
      .replace(/^\s{0,3}#{1,6}\s+(.+)$/gm, '$1.')
      .replace(/^\s*[-*+•]\s+/gm, '')
      .replace(/^\s*\d+[.)]\s+/gm, '')
      .replace(/^\s*>\s?/gm, '')
      .replace(/^\s*\|?\s*:?-{3,}.*$/gm, '')
      .replace(/\|/g, ', ')
      .replace(/(\*\*|__|\*|_|~~)(?=\S)([\s\S]*?\S)\1/g, '$2')
      .replace(/[ \t]+/g, ' ')
      .replace(/\s*\n\s*/g, '\n')
      .trim()
  )
}

/**
 * Splits text that is still growing into complete sentences (safe to speak now) and the
 * unfinished rest. Line breaks also end a sentence (list items, headings).
 */
export function takeSentences(text: string): { sentences: string[]; rest: string } {
  const sentences: string[] = []
  const pattern = /[^.!?।\n]*(?:[.!?।]+(?=\s|$)|\n)/g
  let consumed = 0
  let match: RegExpExecArray | null
  while ((match = pattern.exec(text)) !== null) {
    if (match[0].length === 0) {
      pattern.lastIndex++
      continue
    }
    // A sentence ending exactly at the end of streamed text might continue ("3." → "3.5").
    if (match.index + match[0].length === text.length && !/\n$/.test(match[0])) break
    const sentence = match[0].trim()
    if (sentence.replace(/[.!?।\s]/g, '').length > 0) sentences.push(sentence)
    consumed = match.index + match[0].length
  }
  return { sentences, rest: text.slice(consumed) }
}
