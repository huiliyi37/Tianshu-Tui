export type DocStatus = 'proposed' | 'accepted' | 'implemented' | 'verified' | 'blocked' | 'superseded'

const VALID_STATUSES = new Set<string>(['proposed', 'accepted', 'implemented', 'verified', 'blocked', 'superseded'])
const STATUS_LINE_RE = /^>\s*\*\*Status\*\*:\s*(.+)$/im

export function parseDocStatus(markdown: string): DocStatus[] {
  const match = markdown.match(STATUS_LINE_RE)
  if (!match?.[1]) return []
  return match[1]
    .split('/')
    .map(part => part.trim())
    .filter(Boolean) as DocStatus[]
}

export function validateDocStatus(statuses: readonly string[]): string[] {
  if (statuses.length === 0) return ['missing-status']
  const errors: string[] = []
  for (const status of statuses) {
    if (!VALID_STATUSES.has(status)) errors.push(`invalid-status:${status}`)
  }
  return errors
}
