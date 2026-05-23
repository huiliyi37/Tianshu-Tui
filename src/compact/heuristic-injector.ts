/**
 * Heuristic injector — selects and formats top-K rules for injection into volatile context.
 */
import type { HeuristicRule } from './heuristic-store.js'

/**
 * Format rules for injection into the system prompt's volatile block.
 * Returns a compact text block or empty string if no rules available.
 */
export function formatHeuristicsForInjection(rules: HeuristicRule[]): string {
  if (rules.length === 0) return ''

  const lines = rules.map(r => {
    let line = `• ${r.pattern}`
    if (r.antiPattern) line += ` (avoid: ${r.antiPattern})`
    return line
  })

  return `<learned-heuristics>\n${lines.join('\n')}\n</learned-heuristics>`
}
