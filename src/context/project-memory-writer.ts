import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const MAX_ENTRIES = 200
const MAX_FILE_SIZE = 16_384 // 16KB

interface MemoryEntry {
  id: string
  kind: string
  text: string
  confidence: number
  createdAt: number
  source: string
}

export function appendProjectMemory(
  cwd: string,
  claim: { id: string; kind: string; text: string; confidence: number; createdAt: number; evidence?: Array<{ summary?: string }> },
): void {
  const dir = join(cwd, '.rivet', 'knowledge')
  mkdirSync(dir, { recursive: true })
  const path = join(dir, 'memory.jsonl')

  const entry: MemoryEntry = {
    id: claim.id,
    kind: claim.kind,
    text: claim.text,
    confidence: claim.confidence,
    createdAt: claim.createdAt,
    source: claim.evidence?.[0]?.summary ?? 'unknown',
  }

  appendFileSync(path, JSON.stringify(entry) + '\n', 'utf-8')
}

/**
 * Compact project memory: deduplicate by id and trim to MAX_ENTRIES
 * by confidence (desc). Returns number of entries removed.
 */
export function compactProjectMemory(cwd: string): number {
  const path = join(cwd, '.rivet', 'knowledge', 'memory.jsonl')
  if (!existsSync(path)) return 0

  const entries: MemoryEntry[] = []
  let fileSize = 0
  try {
    const raw = readFileSync(path, 'utf-8')
    fileSize = raw.length
    const lines = raw.split('\n').filter(l => l.trim())
    for (const line of lines) {
      try {
        const parsed = JSON.parse(line)
        if (parsed.id && parsed.text) entries.push(parsed)
      } catch { /* skip malformed lines */ }
    }
  } catch {
    return 0
  }

  // Deduplicate by id
  const seen = new Map<string, MemoryEntry>()
  for (const entry of entries) {
    seen.set(entry.id, entry)
  }

  // Sort by confidence desc, then createdAt desc
  const kept = [...seen.values()]
    .sort((a, b) => b.confidence - a.confidence || b.createdAt - a.createdAt)
    .slice(0, MAX_ENTRIES)

  // Write back only if changed
  if (kept.length < entries.length || fileSize > MAX_FILE_SIZE) {
    writeFileSync(path, kept.map(e => JSON.stringify(e)).join('\n') + '\n', 'utf-8')
    return entries.length - kept.length
  }

  return 0
}
