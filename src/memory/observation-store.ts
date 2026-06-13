/**
 * Cross-session observation store — ~/.rivet/memory/<project-hash>/observations.jsonl
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { createHash } from 'node:crypto'
import { appendMemoryEntry } from './unified-memory.js'
import { migrateObservationsToUnified } from './unified-memory.js'

/** Track which cwds have had migration attempted (lazy, on first append). */
const _migrated = new Set<string>()

export interface Observation {
  id: string
  text: string
  kind: 'fact' | 'decision' | 'preference' | 'constraint'
  confidence: number
  source: 'auto' | 'user' | 'agent'
  tags: string[]
  ts: number
  sessionId?: string
}

function projectHash(cwd: string): string {
  return createHash('sha256').update(cwd).digest('hex').slice(0, 12)
}

function memoryDir(cwd: string): string {
  return join(homedir(), '.rivet', 'memory', projectHash(cwd))
}

function observationsPath(cwd: string): string {
  return join(memoryDir(cwd), 'observations.jsonl')
}

export function appendObservation(cwd: string, obs: Omit<Observation, 'id' | 'ts'> & { id?: string; ts?: number }): Observation {
  const dir = memoryDir(cwd)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })

  // Lazy auto-migrate old observations.jsonl → memory.jsonl on first write
  if (!_migrated.has(cwd)) {
    _migrated.add(cwd)
    try { migrateObservationsToUnified(cwd) } catch { /* migration failure is non-critical */ }
  }

  const record: Observation = {
    id: obs.id ?? `obs_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
    text: obs.text.slice(0, 500),
    kind: obs.kind,
    confidence: obs.confidence,
    source: obs.source,
    tags: obs.tags,
    ts: obs.ts ?? Date.now(),
    sessionId: obs.sessionId,
  }

  // Dual-write to unified memory log first (primary store), then legacy log.
  // If the legacy write fails, the unified entry is already persisted.
  appendMemoryEntry(cwd, {
    id: record.id,
    text: record.text,
    kind: record.kind,
    confidence: record.confidence,
    source: record.source === 'user' ? 'manual' : record.source === 'agent' ? 'manual' : record.source,
    status: 'observed',
    tags: [...record.tags, `obs-source:${record.source}`],
    sessionId: record.sessionId,
  })

  try {
    appendFileSync(observationsPath(cwd), JSON.stringify(record) + '\n', 'utf-8')
  } catch {
    // Legacy log write failure is non-critical — unified log already persisted
  }

  return record
}

export function readObservations(cwd: string): Observation[] {
  const path = observationsPath(cwd)
  if (!existsSync(path)) return []

  const results: Observation[] = []
  try {
    for (const line of readFileSync(path, 'utf-8').split('\n').filter(Boolean)) {
      try {
        results.push(JSON.parse(line) as Observation)
      } catch { /* skip malformed */ }
    }
  } catch {
    return []
  }
  return results
}

/** Keyword recall — score observations by term overlap with query. */
export function recallObservations(cwd: string, query: string, limit = 5): Observation[] {
  const terms = query.toLowerCase().split(/\W+/).filter(t => t.length >= 3)
  if (terms.length === 0) return []

  const scored = readObservations(cwd)
    .map(obs => {
      const text = obs.text.toLowerCase()
      const tagText = obs.tags.join(' ').toLowerCase()
      let score = 0
      for (const term of terms) {
        if (text.includes(term)) score += 2
        if (tagText.includes(term)) score += 1
      }
      score *= obs.confidence
      return { obs, score }
    })
    .filter(s => s.score > 0)
    .sort((a, b) => b.score - a.score || b.obs.ts - a.obs.ts)

  return scored.slice(0, limit).map(s => s.obs)
}

export function renderMemoryBlock(cwd: string, query: string, maxChars = 2000): string | null {
  const recalled = recallObservations(cwd, query, 8)
  if (recalled.length === 0) return null

  const lines = ['<cross-session-memory>']
  let budget = maxChars
  for (const obs of recalled) {
    const line = `  <obs kind="${obs.kind}" c="${obs.confidence.toFixed(2)}">${escapeXml(obs.text)}</obs>`
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

/** Count how many times an observation text (normalized) has appeared. */
export function countSimilarObservations(cwd: string, text: string): number {
  const normalized = text.trim().toLowerCase().slice(0, 200)
  return readObservations(cwd).filter(o => o.text.trim().toLowerCase().slice(0, 200) === normalized).length
}
