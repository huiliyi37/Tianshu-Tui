/**
 * Whitespace-tolerant fallback matching for edit_file.
 *
 * The #1 reason an exact `old_string` replacement fails is whitespace drift:
 * the model reproduces a block with slightly different indentation, tabs vs
 * spaces, trailing spaces, or collapsed blank runs. Rather than bounce the edit
 * back (the Cursor "apply model" exists precisely to absorb this), we locate the
 * block by normalized comparison and splice the edit onto the file's ACTUAL
 * text — so the diff still lands without an extra model round-trip.
 *
 * Safety: we only return a match when the normalized block is UNIQUE. Ambiguity
 * (zero or multiple windows) returns null, and the caller falls back to the
 * existing diagnostic error — we never guess which of several locations to edit.
 */

export interface FuzzyMatch {
  /** Char offset (inclusive) where the matched block starts in `content`. */
  start: number
  /** Char offset (exclusive) where the matched block ends. */
  end: number
  /** The exact slice of `content` that was matched (preserves real whitespace). */
  matchedText: string
}

/** Collapse all runs of whitespace to a single space and trim — tolerates
 *  indentation, tab/space, trailing-space, and CRLF differences. */
function normalizeLine(line: string): string {
  return line.replace(/\s+/g, ' ').trim()
}

/**
 * Find a unique whitespace-insensitive match of `needle` within `content`.
 * Returns null when the block is absent or appears more than once.
 */
export function findFuzzyMatch(content: string, needle: string): FuzzyMatch | null {
  const needleLines = needle.split('\n')
  const normNeedle = needleLines.map(normalizeLine)
  // All-blank needle would match everywhere — refuse.
  if (normNeedle.every(l => l === '')) return null

  const contentLines = content.split('\n')
  const win = needleLines.length
  if (win === 0 || win > contentLines.length) return null

  const starts: number[] = []
  for (let i = 0; i + win <= contentLines.length; i++) {
    let ok = true
    for (let j = 0; j < win; j++) {
      if (normalizeLine(contentLines[i + j]!) !== normNeedle[j]) { ok = false; break }
    }
    if (ok) {
      starts.push(i)
      if (starts.length > 1) return null // ambiguous — bail
    }
  }
  if (starts.length !== 1) return null

  const startLine = starts[0]!
  let start = 0
  for (let i = 0; i < startLine; i++) start += contentLines[i]!.length + 1 // +1 for '\n'
  const matchedText = contentLines.slice(startLine, startLine + win).join('\n')
  return { start, end: start + matchedText.length, matchedText }
}

/** Apply a fuzzy match: splice `replacement` over the matched region. */
export function applyFuzzyReplacement(content: string, match: FuzzyMatch, replacement: string): string {
  return content.slice(0, match.start) + replacement + content.slice(match.end)
}
