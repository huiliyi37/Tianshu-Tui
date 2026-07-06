/**
 * Accessibility-tree diff for the post-action feedback loop.
 *
 * Line-multiset comparison, not positional: an unchanged UI walks to
 * byte-identical lines (deterministic order ⇒ same ref numbering), while any
 * real change surfaces as added/removed lines. A ref renumbering shift after
 * an insertion does inflate the diff (later lines change number), which is
 * acceptable — those lines genuinely need new refs to be clickable, and the
 * added lines carry exactly the NEW snapshot's refs the model should use.
 */

/** Max added/removed lines shown before truncating to a count. */
const MAX_DIFF_LINES = 8

export interface TreeDiff {
  changed: boolean
  summary: string
}

function multiset(lines: string[]): Map<string, number> {
  const m = new Map<string, number>()
  for (const line of lines) m.set(line, (m.get(line) ?? 0) + 1)
  return m
}

/** Lines of `after` not covered by `before` (multiset difference, in order). */
function difference(after: string[], before: Map<string, number>): string[] {
  const remaining = new Map(before)
  const out: string[] = []
  for (const line of after) {
    const n = remaining.get(line) ?? 0
    if (n > 0) remaining.set(line, n - 1)
    else out.push(line)
  }
  return out
}

function capped(prefix: string, lines: string[]): string[] {
  const shown = lines.slice(0, MAX_DIFF_LINES).map((l) => `${prefix} ${l.trim()}`)
  if (lines.length > MAX_DIFF_LINES) shown.push(`${prefix} … ${lines.length - MAX_DIFF_LINES} more`)
  return shown
}

/** Summarize how the tree changed after an action. Model-facing. */
export function diffTreeSummary(before: string, after: string): TreeDiff {
  if (before === after) return { changed: false, summary: 'UI unchanged after action.' }
  const beforeLines = before.split('\n')
  const afterLines = after.split('\n')
  const added = difference(afterLines, multiset(beforeLines))
  const removed = difference(beforeLines, multiset(afterLines))
  if (added.length === 0 && removed.length === 0) {
    // Same multiset, different order — structural reshuffle only.
    return { changed: true, summary: 'UI changed after action: elements reordered (re-snapshot for details).' }
  }
  const parts: string[] = [`UI changed after action (+${added.length}/-${removed.length} elements):`]
  parts.push(...capped('+', added))
  parts.push(...capped('-', removed))
  return { changed: true, summary: parts.join('\n') }
}
