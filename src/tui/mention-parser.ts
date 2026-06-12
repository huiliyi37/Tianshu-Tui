/**
 * @mention parser — extract @file:, @folder:, @symbol: references from user input.
 */

export interface MentionReference {
  type: 'file' | 'folder' | 'symbol' | 'codebase'
  value: string
  raw: string
}

const MENTION_RE = /@(file|folder|symbol|codebase):([^\s]+)/g

export function parseMentions(input: string): MentionReference[] {
  const refs: MentionReference[] = []
  for (const match of input.matchAll(MENTION_RE)) {
    const type = match[1] as MentionReference['type']
    const value = match[2]!.trim()
    refs.push({ type, value, raw: match[0]! })
  }
  return refs
}

export function stripMentions(input: string): string {
  return input.replace(MENTION_RE, '').replace(/\s+/g, ' ').trim()
}

export function renderMentionContext(refs: MentionReference[]): string | null {
  if (refs.length === 0) return null

  const lines = ['<mentions>']
  for (const ref of refs) {
    lines.push(`  <${ref.type} ref="${ref.value}" />`)
  }
  lines.push('</mentions>', '', 'Resolve these @mentions before proceeding. Use read_file/grep/semantic_search as needed.')
  return lines.join('\n')
}
