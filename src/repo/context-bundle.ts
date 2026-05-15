import type { SymbolEntry } from './symbol-index.js'

export interface ContextBundleInput {
  task: string
  likelyFiles: string[]
  relatedTests: string[]
  symbols: SymbolEntry[]
  risks: string[]
}

export function buildContextBundle(input: ContextBundleInput): string {
  const lines: string[] = []
  lines.push(`Task: ${input.task}`)
  lines.push('Likely files:')
  for (const file of input.likelyFiles) lines.push(`- ${file}`)
  lines.push('Related tests:')
  for (const test of input.relatedTests) lines.push(`- ${test}`)
  lines.push('Relevant symbols:')
  for (const symbol of input.symbols) {
    lines.push(`- ${symbol.name} (${symbol.kind}) ${symbol.file}:${symbol.line}`)
  }
  if (input.risks.length > 0) {
    lines.push('Risks:')
    for (const risk of input.risks) lines.push(`- ${risk}`)
  }
  return lines.join('\n')
}
