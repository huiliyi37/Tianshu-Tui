const TRUNCATION_NOTE = '... (truncated, use offset/limit for more specific ranges)'

export function truncateContent(
  content: string,
  maxChars: number,
  keepHead: number,
  keepTail: number,
): string {
  if (content.length <= maxChars) return content

  const head = content.slice(0, keepHead)
  const tail = content.slice(-keepTail)
  return `${head}\n${TRUNCATION_NOTE}\n${tail}`
}
