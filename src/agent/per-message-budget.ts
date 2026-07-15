import { perMessageToolResultBudget, getToolBudget } from '../compact/constants.js'
import { preserveRecoveryReference } from '../compact/recovery-ref.js'

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
      // W1-A2: eviction replaces the whole content — the trailing [artifact:ID]
      // recovery marker must survive so read_section can still recover it.
      content: preserveRecoveryReference(
        r.content,
        `[budget-evicted: ${r.content.length} chars from ${r.toolName}. Use read_file with offset/limit to retrieve.]`,
      ),
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

    // Tail-5 usually carries the trailing marker already; the helper is a
    // no-op then and only appends when the marker would otherwise be lost.
    return { ...r, content: preserveRecoveryReference(r.content, summary) }
  })
}

/**
 * Context-pressure truncation: when the overall context usage exceeds 70%,
 * truncate large read_file results to a head-only preview.
 *
 * This is the "last line of defense" — it fires in the tool-execution layer
 * after per-message and turn-read budgets, catching cases where the context
 * is already heavily loaded from conversation history rather than just this turn's reads.
 *
 * @param results Tool results for this batch
 * @param usageRatio estimatedTokens / contextWindow (0–1)
 * @returns Truncated results
 */
export function enforceContextPressureTruncation(
  results: BudgetEntry[],
  usageRatio: number,
): BudgetEntry[] {
  if (usageRatio <= 0.7) return results

  return results.map(r => {
    if (r.toolName !== 'read_file') return r
    if (r.content.length < 2000) return r // already small

    const lines = r.content.split('\n')
    if (lines.length <= 30) return r // already short

    const head = lines.slice(0, 30)
    const omitted = lines.length - 30
    const truncated = [
      ...head,
      `... ${omitted} lines omitted (context pressure: ${Math.round(usageRatio * 100)}% used). Use read_file with offset/limit for specific ranges. ...`,
    ].join('\n')

    // W1-A2: head-only preview drops the tail — restore the recovery marker.
    return { ...r, content: preserveRecoveryReference(r.content, truncated) }
  })
}

/**
 * Per-tool-type cumulative budget enforcement.
 *
 * Tracks cumulative output for each tool type within a turn. When cumulative
 * output exceeds `summarizeAfter`, subsequent results of that type are
 * truncated to a summary form.
 *
 * Also enforces perCall limits: individual results exceeding perCall are
 * truncated to head + tail.
 */
export function enforceToolTypeBudgets(
  results: BudgetEntry[],
  contextWindow: number,
): BudgetEntry[] {
  if (!contextWindow || contextWindow <= 0) return results

  const cumulative = new Map<string, number>()

  return results.map(r => {
    const budget = getToolBudget(r.toolName, contextWindow)
    const prevCum = cumulative.get(r.toolName) ?? 0
    const charLen = r.content.length
    const tokenEstimate = Math.ceil(charLen / CHARS_PER_TOKEN)

    let content = r.content

    if (tokenEstimate > budget.perCall) {
      const allowedChars = budget.perCall * CHARS_PER_TOKEN
      const lines = content.split('\n')
      if (lines.length > 20) {
        const headLines = Math.ceil(lines.length * 0.6)
        const tailLines = 5
        const head = lines.slice(0, headLines)
        const tail = lines.slice(-tailLines)
        const headContent = head.join('\n')
        const tailContent = tail.join('\n')
        if (headContent.length + tailContent.length + 200 < allowedChars) {
          content = headContent + `\n... ${lines.length - headLines - tailLines} lines omitted (per-call budget: ${budget.perCall} tokens) ...\n` + tailContent
        } else {
          content = content.slice(0, allowedChars) + `\n... [truncated: ${tokenEstimate} tokens → ${budget.perCall} token budget for ${r.toolName}]`
        }
      }
    }

    const newCum = prevCum + Math.ceil(content.length / CHARS_PER_TOKEN)
    cumulative.set(r.toolName, newCum)

    if (newCum > budget.summarizeAfter && prevCum >= budget.summarizeAfter) {
      const lines = content.split('\n')
      const lineCount = lines.length
      const preview = lines.slice(0, 5).join('\n')
      content = `[budget-summarized: ${r.toolName} cumulative ${newCum} tokens (limit: ${budget.summarizeAfter}), ${lineCount} lines]\n${preview}\n... [remaining ${Math.max(0, lineCount - 5)} lines omitted — cumulative budget exceeded]`
    }

    // W1-A2: covers both the per-call slice branch (head-only) and the
    // cumulative summary branch (head-5 preview) — either can drop the tail
    // where the recovery marker lives. No-op when content is unchanged or the
    // marker already survived (head+tail branch keeps tail-5).
    if (content !== r.content) {
      content = preserveRecoveryReference(r.content, content)
    }

    return { ...r, content }
  })
}
