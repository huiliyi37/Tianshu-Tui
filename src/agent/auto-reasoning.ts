export type ReasoningEffort = 'off' | 'low' | 'medium' | 'high' | 'max'

const ARCHITECTURE_PATTERNS = /\b(design|architect|system|refactor.*across|migration|strategy|rewrite)\b/i
const COMPLEX_PATTERNS = /\b(refactor|debug.*multiple|fix.*across|implement.*feature|race.condition|memory.leak|caching.layer)\b/i
const SIMPLE_PATTERNS = /\b(what|explain|show|list|print|read|cat|describe)\b/i
const TRIVIAL_PATTERNS = /^\/(compact|clear|help|exit|model|theme|debug|verbose|sessions|resume|fork|rollback|undo|evidence|context|memory|mcp|scroll|cockpit|auto)/

const EFFORT_RANK: Record<ReasoningEffort, number> = { off: 0, low: 1, medium: 2, high: 3, max: 4 }

export function selectReasoningEffort(input: string, floor?: ReasoningEffort): ReasoningEffort {
  let effort: ReasoningEffort
  if (TRIVIAL_PATTERNS.test(input)) effort = 'off'
  else if (ARCHITECTURE_PATTERNS.test(input)) effort = 'max'
  else if (COMPLEX_PATTERNS.test(input)) effort = 'high'
  else if (SIMPLE_PATTERNS.test(input)) effort = 'low'
  else effort = 'medium'

  if (floor && EFFORT_RANK[effort] < EFFORT_RANK[floor]) return floor
  return effort
}
