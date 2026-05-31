import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const MAX_RENDER_CHARS = 4_000 // ~1K tokens

interface MemoryEntry {
  id: string
  kind: string
  text: string
  confidence: number
  createdAt: number
  source: string
}

export interface ProjectMemoryBlock {
  content: string
  entryCount: number
}

export function loadProjectMemory(cwd: string): ProjectMemoryBlock {
  const path = join(cwd, '.rivet', 'knowledge', 'memory.jsonl')
  if (!existsSync(path)) return { content: '', entryCount: 0 }

  const entries: MemoryEntry[] = []
  try {
    const raw = readFileSync(path, 'utf-8')
    for (const line of raw.split('\n').filter(l => l.trim())) {
      try {
        const parsed = JSON.parse(line)
        if (parsed.id && parsed.text) entries.push(parsed)
      } catch { /* skip malformed */ }
    }
  } catch {
    return { content: '', entryCount: 0 }
  }

  if (entries.length === 0) return { content: '', entryCount: 0 }

  // Sort by confidence desc
  entries.sort((a, b) => b.confidence - a.confidence || b.createdAt - a.createdAt)

  let budget = MAX_RENDER_CHARS
  const rendered: string[] = []
  let used = 0

  for (const entry of entries) {
    const line = `  <m kind="${escapeXml(entry.kind)}" c="${entry.confidence.toFixed(2)}">${escapeXml(entry.text)}</m>`
    if (used + line.length > budget) break
    rendered.push(line)
    used += line.length
  }

  const content = `<project-memory entries="${rendered.length}">\n${rendered.join('\n')}\n</project-memory>`
  return { content, entryCount: rendered.length }
}

function escapeXml(s: string): string {
  return s
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
}
