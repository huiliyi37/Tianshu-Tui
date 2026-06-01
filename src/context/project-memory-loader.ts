import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const MAX_RENDER_CHARS = 2_000 // ~500 tokens for Tier 1 injection (conservative)

/** Kinds eligible for Tier 1 prompt injection (high-signal, low-noise). */
const TIER1_KINDS = new Set(['decision', 'project_rule', 'user_constraint'])
/** Minimum confidence for Tier 1 injection. */
const TIER1_MIN_CONFIDENCE = 0.9

interface MemoryEntry {
  id: string
  kind: string
  text: string
  confidence: number
  createdAt: number
  source: string
  tags?: string[]
}

export interface ProjectMemoryBlock {
  content: string
  entryCount: number
}

/** Read all entries from .rivet/knowledge/memory.jsonl */
function readMemoryEntries(cwd: string): MemoryEntry[] {
  const path = join(cwd, '.rivet', 'knowledge', 'memory.jsonl')
  if (!existsSync(path)) return []

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
    return []
  }
  return entries
}

/**
 * Load Tier 1 project memory for frozen volatile block injection.
 * Only includes high-confidence decisions, project rules, and user constraints.
 * Everything else is available via the recall tool (Tier 2).
 */
export function loadProjectMemory(cwd: string): ProjectMemoryBlock {
  const entries = readMemoryEntries(cwd)

  // Filter to Tier 1 only: high-signal kinds with high confidence
  const tier1 = entries
    .filter(e => TIER1_KINDS.has(e.kind) && e.confidence >= TIER1_MIN_CONFIDENCE && !isCommitFact(e))
    .sort((a, b) => b.confidence - a.confidence || b.createdAt - a.createdAt)

  if (tier1.length === 0) return { content: '', entryCount: 0 }

  let budget = MAX_RENDER_CHARS
  const rendered: string[] = []
  let used = 0

  for (const entry of tier1) {
    const line = `  <m kind="${escapeXml(entry.kind)}" c="${entry.confidence.toFixed(2)}">${escapeXml(entry.text)}</m>`
    if (used + line.length > budget) break
    rendered.push(line)
    used += line.length
  }

  const content = `<project-memory entries="${rendered.length}">\n${rendered.join('\n')}\n</project-memory>`
  return { content, entryCount: rendered.length }
}

/**
 * Load all project memory entries (Tier 1 + Tier 2) for recall tool search.
 * Returns raw entries sorted by confidence, without rendering or budget cap.
 */
export function loadAllProjectMemoryEntries(cwd: string): MemoryEntry[] {
  return readMemoryEntries(cwd)
    .sort((a, b) => b.confidence - a.confidence || b.createdAt - a.createdAt)
}

function isCommitFact(entry: MemoryEntry): boolean {
  return entry.tags?.includes('commit_fact') ?? false
}

function escapeXml(s: string): string {
  return s
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
}
