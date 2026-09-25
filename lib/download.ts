/** Saves generated text (chat exports, reports) as a local file. */
export function downloadText(filename: string, type: string, content: string) {
  const url = URL.createObjectURL(new Blob([content], { type }))
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  link.click()
  URL.revokeObjectURL(url)
}

/** A filesystem-safe name from a title, e.g. "Q3 plan: summary" → "q3-plan-summary". */
export function fileSlug(title: string): string {
  return (
    title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'report'
  )
}
