export interface TextChunk {
  text: string
  isLast: boolean
}

export function chunkText(text: string, maxChars = 2000): TextChunk[] {
  if (text.length <= maxChars) {
    return [{ text, isLast: true }]
  }
  const chunks: TextChunk[] = []
  let i = 0
  while (i < text.length) {
    let end = i + maxChars
    if (end < text.length) {
      // prefer breaking at newline
      const lastNewline = text.lastIndexOf('\n', end)
      if (lastNewline > i) {
        end = lastNewline + 1
      }
    }
    chunks.push({
      text: text.slice(i, end),
      isLast: end >= text.length,
    })
    i = end
  }
  return chunks
}

export function stripMarkdownForChat(text: string): string {
  // naive normalization: collapse multiple blank lines
  return text.replace(/\n{3,}/g, '\n\n').trim()
}

export function summarizeToolCalls(events: { tool?: string; target?: string; summary?: string }[]): string {
  if (events.length === 0) return ''
  return events
    .map(e => `• ${e.tool ?? 'tool'}${e.target ? `(${e.target})` : ''}${e.summary ? `: ${e.summary}` : ''}`)
    .join('\n')
}
