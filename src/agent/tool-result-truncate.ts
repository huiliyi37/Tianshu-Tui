import { estimateOaiMessageTokens } from '../compact/micro.js'

export function truncateToolResult(content: string, maxTokens: number): string {
  if (!content) return content
  const tokens = estimateOaiMessageTokens({ role: 'user', content })
  if (tokens <= maxTokens) return content

  const ratio = maxTokens / tokens
  const maxChars = Math.max(0, Math.floor(content.length * ratio))
  const headChars = Math.floor(maxChars * 0.6)
  const tailChars = Math.floor(maxChars * 0.3)
  if (headChars + tailChars >= content.length) return content

  const head = content.slice(0, headChars)
  const tail = content.slice(-tailChars)
  const removed = content.length - headChars - tailChars
  return `${head}\n\n...[truncated ${removed} chars]...\n\n${tail}\n\n[WARNING: this result was truncated. Do not draw architectural conclusions or infer API existence from partial output.]`
}
