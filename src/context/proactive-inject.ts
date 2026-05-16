import type { ContextAnchor } from './types.js'

interface ProactiveOptions {
  maxTokens?: number
}

export function buildProactiveContext(
  anchors: ContextAnchor[],
  _sessionMemoryEntries: { text: string }[],
  options?: ProactiveOptions,
): string {
  if (anchors.length === 0) return ''

  const maxTokens = options?.maxTokens ?? 5000
  const sorted = [...anchors].sort((a, b) => b.salience - a.salience)

  const lines: string[] = []
  let tokenCount = 0
  for (const anchor of sorted) {
    const lineTokens = Math.ceil(anchor.text.length / 4)
    if (tokenCount + lineTokens > maxTokens) break
    lines.push(`- [${anchor.kind}] ${anchor.text}`)
    tokenCount += lineTokens
  }

  if (lines.length === 0) return ''
  return `<active-constraints>\n${lines.join('\n')}\n</active-constraints>`
}
