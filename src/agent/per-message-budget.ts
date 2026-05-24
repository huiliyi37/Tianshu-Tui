import { perMessageToolResultBudget } from '../compact/constants.js'

const PROTECTED_TOOLS = new Set(['read_file'])

export interface BudgetEntry {
  toolUseId: string
  content: string
  toolName: string
}

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
