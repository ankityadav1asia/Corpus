/** "bytes=START-END" / "bytes=START-" / "bytes=-SUFFIX" → an inclusive byte range, or null when unusable. */
export function parseRange(header: string | null, size: number): { start: number; end: number } | null {
  const match = header ? /^bytes=(\d*)-(\d*)$/.exec(header.trim()) : null
  if (!match || (!match[1] && !match[2])) return null
  let start: number
  let end: number
  if (!match[1]) {
    const suffix = Number(match[2])
    start = Math.max(0, size - suffix)
    end = size - 1
  } else {
    start = Number(match[1])
    end = match[2] ? Math.min(Number(match[2]), size - 1) : size - 1
  }
  return start <= end && start < size ? { start, end } : null
}
