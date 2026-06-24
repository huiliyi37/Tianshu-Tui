// Command palette model (Q4). `filterCommands` is a pure fuzzy filter so it can
// be unit-tested without React.

export interface Command {
  id: string
  label: string
  hint?: string
  run: () => void
}

/** Substring (preferred, earlier = higher) → subsequence fallback → -1 miss. */
export function fuzzyScore(text: string, query: string): number {
  if (!query) return 0
  const idx = text.indexOf(query)
  if (idx >= 0) return 1000 - idx
  let ti = 0
  let matched = 0
  for (const ch of query) {
    const found = text.indexOf(ch, ti)
    if (found < 0) return -1
    ti = found + 1
    matched += 1
  }
  return matched
}

export function filterCommands(items: Command[], query: string): Command[] {
  const q = query.trim().toLowerCase()
  if (!q) return items
  return items
    .map((c) => ({ c, score: fuzzyScore(`${c.label} ${c.hint ?? ''}`.toLowerCase(), q) }))
    .filter((x) => x.score >= 0)
    .sort((a, b) => b.score - a.score)
    .map((x) => x.c)
}
