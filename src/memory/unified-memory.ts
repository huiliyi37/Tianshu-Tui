/**
 * Unified Memory — single JSONL log for cross-session observations, claims, and rules.
 *
 * Replaces the fragmented ObservationStore + ClaimStore + ProjectMemory trifecta
 * with one append-only log. The ClaimStore retains its event-sourcing lifecycle
 * for session-scoped claims; this module covers the cross-session / auto-extracted
 * tier that feeds recall and prompt injection.
 *
 * Storage: ~/.rivet/memory/<project-hash>/memory.jsonl
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { memoryDir } from '../config/paths.js'

// ── Schema ─────────────────────────────────────────────────────────────────

export type MemoryKind =
  | 'fact'
  | 'decision'
  | 'constraint'
  | 'preference'
  | 'finding'
  | 'user_constraint'
  | 'user_preference'
  | 'file_observation'
  | 'verification_fact'
  | 'failure_pattern'
  | 'security_finding'
  | 'worker_finding'
  | 'project_rule'

export type MemorySource = 'auto' | 'manual' | 'claim' | 'verification'

export type MemoryStatus = 'observed' | 'claimed' | 'verified' | 'rejected' | 'expired'

export interface MemoryEntry {
  id: string
  text: string
  kind: MemoryKind
  confidence: number
  source: MemorySource
  status: MemoryStatus
  evidence?: string
  sessionId?: string
  tags: string[]
  ts: number
  /** Cross-session repeat count (>=3 triggers rule generation). */
  repeatCount: number
  /** Path to auto-generated rule file, if promoted. */
  promotedToRule?: string
  /** Extension: original claim ID if sourced from ClaimStore. */
  claimId?: string
  /** Extension: references to evidence files that still exist. */
  fileRefs?: string[]
}

// ── Helpers ────────────────────────────────────────────────────────────────

function projectHash(cwd: string): string {
  return createHash('sha256').update(cwd).digest('hex').slice(0, 12)
}

function projectMemoryDir(cwd: string): string {
  return memoryDir(projectHash(cwd))
}

function memoryPath(cwd: string): string {
  return join(projectMemoryDir(cwd), 'memory.jsonl')
}

function generateId(): string {
  return `mem_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
}

// ── Write ──────────────────────────────────────────────────────────────────

/** Append a memory entry to the unified log. Deduplicates by normalized text. */
export function appendMemoryEntry(
  cwd: string,
  partial: Omit<MemoryEntry, 'id' | 'ts' | 'repeatCount'> & { id?: string; ts?: number },
): MemoryEntry {
  const dir = projectMemoryDir(cwd)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })

  // Count existing similar entries for repeatCount — streaming scan, no full parse.
  const normalized = partial.text.trim().toLowerCase().slice(0, 200)
  let repeatCount = 1
  const path = memoryPath(cwd)
  if (existsSync(path)) {
    try {
      for (const line of readFileSync(path, 'utf-8').split('\n')) {
        if (!line.trim()) continue
        // Fast substring match without full JSON parse
        if (line.toLowerCase().includes(normalized.slice(0, 50))) {
          repeatCount++
        }
      }
    } catch { /* count failure → use 1 */ }
  }

  const entry: MemoryEntry = {
    id: partial.id ?? generateId(),
    text: partial.text.slice(0, 500),
    kind: partial.kind,
    confidence: partial.confidence,
    source: partial.source,
    status: partial.status,
    evidence: partial.evidence,
    sessionId: partial.sessionId,
    tags: partial.tags,
    ts: partial.ts ?? Date.now(),
    repeatCount,
    promotedToRule: partial.promotedToRule,
    claimId: partial.claimId,
    fileRefs: partial.fileRefs,
  }

  appendFileSync(memoryPath(cwd), JSON.stringify(entry) + '\n', 'utf-8')
  return entry
}

// ── Read ───────────────────────────────────────────────────────────────────

/** Read all memory entries from the unified log. */
export function readMemoryEntries(cwd: string): MemoryEntry[] {
  const path = memoryPath(cwd)
  if (!existsSync(path)) return []

  const results: MemoryEntry[] = []
  try {
    for (const line of readFileSync(path, 'utf-8').split('\n').filter(Boolean)) {
      try {
        results.push(JSON.parse(line) as MemoryEntry)
      } catch { /* skip malformed */ }
    }
  } catch {
    return []
  }
  return results
}

// ── Recall ─────────────────────────────────────────────────────────────────

/** Keyword recall — score entries by term overlap with query. */
export function recallMemoryEntries(
  cwd: string,
  query: string,
  limit = 5,
  kindFilter?: MemoryKind | MemoryKind[],
): MemoryEntry[] {
  const terms = query.toLowerCase().split(/\W+/).filter(t => t.length >= 3)
  if (terms.length === 0) return []

  const kinds = kindFilter
    ? (Array.isArray(kindFilter) ? kindFilter : [kindFilter])
    : undefined

  const candidates = readMemoryEntries(cwd)
    .filter(e => !kinds || kinds.includes(e.kind))

  const scored = candidates
    .map(entry => {
      const text = entry.text.toLowerCase()
      const tagText = entry.tags.join(' ').toLowerCase()
      let score = 0
      for (const term of terms) {
        if (text.includes(term)) score += 2
        if (tagText.includes(term)) score += 1
      }
      score *= entry.confidence
      return { entry, score }
    })
    .filter(s => s.score > 0)
    .sort((a, b) => b.score - a.score || b.entry.ts - a.entry.ts)

  return scored.slice(0, limit).map(s => s.entry)
}

/** Render memory entries as XML block for prompt injection. */
export function renderMemoryBlock(cwd: string, query: string, maxChars = 2000): string | null {
  const recalled = recallMemoryEntries(cwd, query, 8)
  if (recalled.length === 0) return null

  const lines = ['<cross-session-memory>']
  let budget = maxChars
  for (const entry of recalled) {
    const line = `  <m kind="${escapeXml(entry.kind)}" c="${entry.confidence.toFixed(2)}">${escapeXml(entry.text)}</m>`
    if (line.length > budget) break
    lines.push(line)
    budget -= line.length
  }
  lines.push('</cross-session-memory>')
  return lines.join('\n')
}

function escapeXml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
}

/** Count how many times text (normalized) has appeared in memory. */
export function countSimilarMemoryEntries(cwd: string, text: string): number {
  const normalized = text.trim().toLowerCase().slice(0, 200)
  return readMemoryEntries(cwd).filter(e =>
    e.text.trim().toLowerCase().slice(0, 200) === normalized,
  ).length
}

// ── Migration ──────────────────────────────────────────────────────────────

/** Migrate old observations.jsonl to unified memory.jsonl. Idempotent — skips
 *  entries whose IDs already exist in the unified log. Safe to re-run after
 *  partial migration (crash recovery). */
export function migrateObservationsToUnified(cwd: string): number {
  const oldPath = join(projectMemoryDir(cwd), 'observations.jsonl')
  if (!existsSync(oldPath)) return 0

  // Load existing unified entries to skip already-migrated observations
  const existingIds = new Set(readMemoryEntries(cwd).map(e => e.id))

  let migrated = 0
  try {
    const raw = readFileSync(oldPath, 'utf-8')
    for (const line of raw.split('\n').filter(Boolean)) {
      try {
        const obs = JSON.parse(line)
        const id = obs.id ?? ''
        if (id && existingIds.has(id)) continue // already migrated, skip

        const entry: MemoryEntry = {
          id: id || generateId(),
          text: (obs.text ?? '').slice(0, 500),
          kind: obs.kind ?? 'fact',
          confidence: obs.confidence ?? 0.5,
          source: obs.source ?? 'auto',
          status: 'observed',
          tags: obs.tags ?? [],
          ts: obs.ts ?? Date.now(),
          repeatCount: 1,
          sessionId: obs.sessionId,
        }
        // Direct append — bypass appendMemoryEntry's repeatCount read-back
        const dir = projectMemoryDir(cwd)
        if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
        appendFileSync(memoryPath(cwd), JSON.stringify(entry) + '\n', 'utf-8')
        existingIds.add(entry.id)
        migrated++
      } catch { /* skip malformed */ }
    }
  } catch {
    return 0
  }

  return migrated
}
