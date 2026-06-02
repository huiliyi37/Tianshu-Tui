import { createHash } from 'node:crypto'

export interface MistakeEntry {
  id: string
  timestamp: string
  error: string
  context: string
  resolution: string
  tags: string[]
}

type MistakeInput = Omit<MistakeEntry, 'id'>

function computeId(error: string, context: string): string {
  return createHash('sha256').update(`${error}|${context}`).digest('hex').slice(0, 12)
}

function tokenize(text: string): string[] {
  return text.toLowerCase().split(/[\s/\\.:,;()\[\]{}<>"'`]+/).filter(t => t.length > 2)
}

function overlapScore(queryTokens: string[], entryTokens: string[]): number {
  if (queryTokens.length === 0) return 0
  const entrySet = new Set(entryTokens)
  let matches = 0
  for (const t of queryTokens) {
    if (entrySet.has(t)) matches++
  }
  return matches / queryTokens.length
}

export class MistakeNotebook {
  private entries: Map<string, MistakeEntry> = new Map()
  /** Max entries before eviction. Oldest entries (by insertion order) are evicted first. */
  private readonly maxEntries: number
  /** Insertion-order tracking for LRU eviction */
  private insertOrder: string[] = []

  constructor(maxEntries = 50) {
    this.maxEntries = maxEntries
  }

  record(input: MistakeInput): MistakeEntry {
    const id = computeId(input.error, input.context)
    if (this.entries.has(id)) return this.entries.get(id)!
    const entry: MistakeEntry = { id, ...input }
    this.entries.set(id, entry)
    this.insertOrder.push(id)
    this.evict()
    return entry
  }

  private evict(): void {
    while (this.insertOrder.length > this.maxEntries) {
      const oldest = this.insertOrder.shift()
      if (oldest) this.entries.delete(oldest)
    }
  }

  query(error: string, context: string, maxResults = 3): MistakeEntry[] {
    const queryTokens = tokenize(`${error} ${context}`)
    const scored: { entry: MistakeEntry; score: number }[] = []

    for (const entry of this.entries.values()) {
      const entryTokens = tokenize(`${entry.error} ${entry.context} ${entry.tags.join(' ')}`)
      const score = overlapScore(queryTokens, entryTokens)
      if (score > 0.2) scored.push({ entry, score })
    }

    scored.sort((a, b) => b.score - a.score)
    return scored.slice(0, maxResults).map(s => s.entry)
  }

  size(): number {
    return this.entries.size
  }

  /** Export all entries for persistence */
  getAllEntries(): MistakeEntry[] {
    return [...this.entries.values()]
  }

  /** Import entries from external source (e.g., SQLite). Skips duplicates by id. */
  importEntries(entries: MistakeEntry[]): void {
    for (const entry of entries) {
      if (!this.entries.has(entry.id)) {
        this.entries.set(entry.id, entry)
      }
    }
  }

  static formatHints(entries: MistakeEntry[]): string {
    if (entries.length === 0) return ''
    const lines = ['<mistake-hints>']
    for (const e of entries) {
      lines.push(`Previously encountered: ${e.error}`)
      lines.push(`Resolution: ${e.resolution}`)
      lines.push('')
    }
    lines.push('</mistake-hints>')
    return lines.join('\n')
  }
}
