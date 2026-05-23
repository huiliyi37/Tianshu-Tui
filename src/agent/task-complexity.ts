export type ComplexityLevel = 'low' | 'high'

export interface ComplexityInput {
  userMessage: string
  recentTools: string[]
  turnCount: number
}

const HIGH_KEYWORDS = /refactor|architect|debug|redesign|migrate|fix.*fail|multiple.*file/i
const WRITE_TOOLS = new Set(['edit_file', 'write_file', 'bash'])

export function classifyComplexity(input: ComplexityInput): ComplexityLevel {
  if (HIGH_KEYWORDS.test(input.userMessage)) return 'high'
  const writeCount = input.recentTools.filter(t => WRITE_TOOLS.has(t)).length
  if (writeCount >= 3 && input.turnCount >= 5) return 'high'
  return 'low'
}
