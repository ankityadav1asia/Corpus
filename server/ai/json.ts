/**
 * Reading JSON out of model replies. Models wrap JSON in code fences or prose, so every parser
 * takes the outermost object / array in the reply. One implementation for all of them.
 */

export type JsonShape = 'object' | 'array' | 'any'

const PATTERNS: Record<JsonShape, RegExp> = {
  object: /\{[\s\S]*\}/,
  array: /\[[\s\S]*\]/,
  any: /\{[\s\S]*\}|\[[\s\S]*\]/,
}

/** Removes a surrounding Markdown code fence (```json … ```). */
export function stripFences(raw: string): string {
  return raw
    .replace(/^\s*```[a-z]*\s*/i, '')
    .replace(/\s*```\s*$/, '')
    .trim()
}

/** The outermost JSON value of the given shape in a reply, or undefined when there is none or it does not parse. */
export function findJson(raw: string, shape: JsonShape = 'object'): unknown {
  const match = PATTERNS[shape].exec(raw)
  if (!match) return undefined
  try {
    return JSON.parse(match[0]) as unknown
  } catch {
    return undefined
  }
}

/** Like findJson, for parsers where a reply without JSON is a failure: throws a descriptive error instead. */
export function requireJson(raw: string, shape: Exclude<JsonShape, 'any'>, source: string): unknown {
  const match = PATTERNS[shape].exec(raw)
  if (!match) throw new Error(`${source} reply contains no JSON ${shape}`)
  return JSON.parse(match[0]) as unknown
}
