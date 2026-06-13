/**
 * Did-you-mean fuzzy matcher for unknown tool names.
 *
 * Pure module, no side effects, no I/O. Consumed by ToolRegistry.execute when
 * the LLM streams a tool_call for a name that is not registered. The returned
 * hint is appended to the thrown Error so the tool_result flowing back to the
 * model carries actionable feedback (similar to a compiler's
 * "did you mean X?" or HTTP 405's Allow header).
 *
 * Algorithm: classic Levenshtein distance with two-row DP. Distance is the
 * minimum number of single-character edits (insert/delete/substitute) to
 * turn one string into the other.
 *
 * History: session 6176a17f triggered `Unknown tool: task` because the LLM
 * hallucinated a Cursor/Claude-Code-style "Task + subagent_type" tool call
 * instead of Rivet's `delegate_task`. The bare error wasted one model turn;
 * this module turns the failure into a learnable signal.
 */

export interface DidYouMeanOptions {
  /** Max number of suggestions to return. Default 3. */
  topK?: number
  /** Max Levenshtein distance to consider. Default = max(2, floor(inputLen / 4)). */
  maxDistance?: number
}

/**
 * Edit distance between two strings. Two-row DP keeps memory bounded.
 * Case-sensitive — caller decides whether to lowercase first.
 */
export function levenshtein(a: string, b: string): number {
  if (a === b) return 0
  const aLen = a.length
  const bLen = b.length
  if (aLen === 0) return bLen
  if (bLen === 0) return aLen

  // Use two rows of length bLen+1. Swap references each iteration.
  let prev = new Array<number>(bLen + 1)
  let curr = new Array<number>(bLen + 1)
  for (let j = 0; j <= bLen; j++) prev[j] = j
  for (let i = 1; i <= aLen; i++) {
    curr[0] = i
    const aCharCode = a.charCodeAt(i - 1)
    for (let j = 1; j <= bLen; j++) {
      const cost = aCharCode === b.charCodeAt(j - 1) ? 0 : 1
      const insert = (curr[j - 1] ?? 0) + 1
      const del = (prev[j] ?? 0) + 1
      const sub = (prev[j - 1] ?? 0) + cost
      const m1 = insert < del ? insert : del
      curr[j] = m1 < sub ? m1 : sub
    }
    const tmp = prev
    prev = curr
    curr = tmp
  }
  return prev[bLen] ?? 0
}

/**
 * Rank candidate strings by Levenshtein distance to `input`. Returns up to
 * `topK` names with the smallest distance, in ascending order. Ties broken
 * alphabetically so the output is stable.
 *
 * Filters out candidates whose distance exceeds `maxDistance` to suppress
 * noise. Default threshold: at least 2, or 1 edit per 4 chars of input —
 * long inputs forgive more distance but stay bounded.
 */
export function didYouMean(
  input: string,
  candidates: readonly string[],
  options: DidYouMeanOptions = {},
): string[] {
  if (candidates.length === 0 || input.length === 0) return []
  const topK = options.topK ?? 3
  const inputLen = input.length
  const maxDistance =
    options.maxDistance ?? Math.max(2, Math.floor(inputLen / 4))

  // Primary pass: Levenshtein distance catches typos and transpositions
  // (e.g. "delegte_task", "read_fiel").
  const scored: Array<{ name: string; distance: number }> = []
  for (const candidate of candidates) {
    if (candidate.length === 0) continue
    const d = levenshtein(input, candidate)
    if (d <= maxDistance) scored.push({ name: candidate, distance: d })
  }
  if (scored.length > 0) {
    scored.sort((a, b) => a.distance - b.distance || a.name.localeCompare(b.name))
    return scored.slice(0, topK).map(s => s.name)
  }

  // Fallback: substring containment catches semantic-but-not-orthographic
  // mismatches (e.g. session 6176a17f: model called `task` wanting
  // `delegate_task`). Only used when Levenshtein finds nothing — keeps the
  // primary pass noise-free. Sort alphabetically for stable output.
  const substringHits: string[] = []
  for (const candidate of candidates) {
    if (candidate.length === 0) continue
    if (candidate.includes(input) || input.includes(candidate)) {
      substringHits.push(candidate)
    }
  }
  substringHits.sort((a, b) => a.localeCompare(b))
  return substringHits.slice(0, topK)
}

/**
 * Build a hint line to surface after an "Unknown tool" message. Designed to
 * be appended to the error text so the LLM can self-correct in the next turn.
 *
 * Format: "Did you mean: X, Y, Z? Available tools: a, b, c"
 * - "Did you mean" segment is omitted when no candidate is close enough.
 * - "Available tools" segment is always present (so the model has a positive
 *   anchor for the next call), but the list is unsorted-to-sorted for
 *   deterministic prefix-cache stability across sessions.
 */
export function didYouMeanHint(
  input: string,
  allToolNames: readonly string[],
): string {
  if (allToolNames.length === 0) {
    return 'No tools are registered.'
  }
  const suggestions = didYouMean(input, allToolNames)
  const parts: string[] = []
  if (suggestions.length > 0) {
    parts.push(`Did you mean: ${suggestions.join(', ')}?`)
  }
  const sorted = allToolNames.slice().sort()
  parts.push(`Available tools: ${sorted.join(', ')}`)
  return parts.join(' ')
}