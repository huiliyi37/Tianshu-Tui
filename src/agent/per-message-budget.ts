import { perMessageToolResultBudget } from '../compact/constants.js'

const PROTECTED_TOOLS = new Set(['read_file'])

export interface BudgetEntry {
  toolUseId: string
  content: string
  toolName: string
}

/** Characters per token — matches model-read-cap.ts */
const CHARS_PER_TOKEN = 4

/** Fraction of context window allocated to ALL read_file results in one turn. */
const READ_BUDGET_FRACTION = 0.15

export function enforcePerMessageBudget(
  results: BudgetEntry[],
  budget: number = perMessageToolResultBudget(0),
): BudgetEntry[] {
  const total = results.reduce((sum, r) => sum + r.content.length, 0)
  if (total <= budget) return results

  const indexed = results.map((r, i) => ({ ...r, idx: i }))
  const evictable = indexed
    .filter(r => !PROTECTED_TOOLS.has(r.toolName))
    .sort((a, b) => b.content.length - a.content.length)

  const evictSet = new Set<number>()
  let remaining = total
  for (const candidate of evictable) {
    if (remaining <= budget) break
    evictSet.add(candidate.idx)
    remaining -= candidate.content.length
  }

  return results.map((r, i) => {
    if (!evictSet.has(i)) return r
    return {
      ...r,
      content: `[budget-evicted: ${r.content.length} chars from ${r.toolName}. Use read_file with offset/limit to retrieve.]`,
    }
  })
}

/**
 * Per-turn read budget: tracks cumulative read_file chars across a single turn.
 * When total exceeds `contextWindow * 0.15 * 4`, subsequent read_file results
 * are truncated to a compact summary to prevent context exhaustion from
 * reading too many files in one turn.
 *
 * Budget is 15% of the context window in tokens, converted to chars.
 * E.g. 200K window → 200_000 * 0.15 * 4 = 120_000 chars budget.
 */
export function enforceTurnReadBudget(
  results: BudgetEntry[],
  contextWindow: number,
): BudgetEntry[] {
  if (!contextWindow || contextWindow <= 0) return results
  const budget = contextWindow * READ_BUDGET_FRACTION * CHARS_PER_TOKEN
  let accumulated = 0

  return results.map(r => {
    if (r.toolName !== 'read_file') return r
    accumulated += r.content.length
    if (accumulated <= budget) return r

    // Over budget — truncate to a compact summary
    const lines = r.content.split('\n')
    if (lines.length <= 20) return r // already small

    const head = lines.slice(0, 10)
    const tail = lines.slice(-5)
    const omitted = lines.length - head.length - tail.length
    const summary = [
      ...head,
      `... ${omitted} lines omitted (turn read budget exceeded: ${Math.round(accumulated / 1000)}K/${Math.round(budget / 1000)}K chars). Use read_file with offset/limit for specific ranges. ...`,
      ...tail,
    ].join('\n')

    return { ...r, content: summary }
  })
}
