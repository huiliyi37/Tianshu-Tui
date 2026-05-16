export type ReasoningEffort = 'off' | 'low' | 'medium' | 'high' | 'max'

const ARCHITECTURE_PATTERNS = /\b(design|architect|system|refactor.*across|migration|strategy|rewrite)\b/i
const COMPLEX_PATTERNS = /\b(refactor|debug.*multiple|fix.*across|implement.*feature|race.condition|memory.leak|caching.layer)\b/i
const SIMPLE_PATTERNS = /\b(what|explain|show|list|print|read|cat|describe)\b/i
const TRIVIAL_PATTERNS = /^\/(compact|clear|help|exit|model|theme|debug|verbose|sessions|resume|fork|rollback|undo|evidence|context|memory|mcp|scroll|cockpit|auto)/

export function selectReasoningEffort(input: string): ReasoningEffort {
  if (TRIVIAL_PATTERNS.test(input)) return 'off'
  if (ARCHITECTURE_PATTERNS.test(input)) return 'max'
  if (COMPLEX_PATTERNS.test(input)) return 'high'
  if (SIMPLE_PATTERNS.test(input)) return 'low'
  return 'medium'
}
