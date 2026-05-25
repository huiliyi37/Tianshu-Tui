/**
 * Dream distillation — session-end knowledge extraction.
 *
 * Writes to .rivet/knowledge/project-memory.md — the single source that
 * volatile.ts reads and injects into the system prompt.  This closes the
 * memory loop: session ends → distill → knowledge file → next session's prompt.
 */

import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { writeFileAtomicSync } from '../fs-atomic.js'
import { join } from 'node:path'
import type { VerificationMetadata } from '../tools/types.js'

export interface TrajectoryEntry {
  tool: string
  target: string
  status: 'success' | 'failed' | 'running'
  error?: string
}

export interface DreamInput {
  filesModified: string[]
  filesRead: string[]
  verifications: VerificationMetadata[]
  decisions: string[]
  trajectoryEntries: TrajectoryEntry[]
  sessionId: string
}

const MAX_FILES = 8

/**
 * Distill a session into a Markdown knowledge entry.
 *
 * Returns null when no meaningful work was done (no files modified).
 * Phase 1: template-based, no LLM. Phase 2 upgrades to LLM distillation.
 */
export function distillSession(input: DreamInput): string | null {
  if (input.filesModified.length === 0) return null

  const now = new Date().toISOString()
  const lines: string[] = []

  lines.push(`### ${now.slice(0, 10)} — session ${input.sessionId.slice(0, 8)}`)
  lines.push('')

  // Files modified
  const modified = truncateList(input.filesModified, MAX_FILES)
  lines.push(`**Modified** (${input.filesModified.length}): ${modified}`)

  // Files read (only if any)
  if (input.filesRead.length > 0) {
    const read = truncateList(input.filesRead, MAX_FILES)
    lines.push(`**Read** (${input.filesRead.length}): ${read}`)
  }

  // Verification
  if (input.verifications.length > 0) {
    const v = input.verifications[input.verifications.length - 1]!
    if (v.status === 'passed') {
      lines.push(`**Tests**: ✅ ${v.passed} passed, ${v.failed} failed (${v.command})`)
    } else if (v.status === 'failed') {
      lines.push(`**Tests**: ❌ ${v.passed} passed, ${v.failed} failed (${v.command})`)
    } else if (v.status === 'blocked') {
      lines.push(`**Tests**: ⛔ blocked (${v.command})`)
    }
  } else if (input.filesModified.length > 0) {
    lines.push('**Tests**: ⚠️ unverified')
  }

  // Trajectory summary
  if (input.trajectoryEntries.length > 0) {
    const tools = countTools(input.trajectoryEntries)
    const toolSummary = Object.entries(tools)
      .sort((a, b) => b[1] - a[1])
      .map(([tool, count]) => `${tool}×${count}`)
      .join(', ')
    lines.push(`**Tools used**: ${toolSummary}`)
  }

  // Decisions
  if (input.decisions.length > 0) {
    for (const d of input.decisions) {
      lines.push(`- Decision: ${d}`)
    }
  }

  lines.push('')
  return lines.join('\n')
}

function truncateList(items: string[], max: number): string {
  if (items.length <= max) return items.join(', ')
  const shown = items.slice(0, max).join(', ')
  const remaining = items.length - max
  return `${shown} +${remaining} more`
}

function countTools(entries: TrajectoryEntry[]): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const e of entries) {
    counts[e.tool] = (counts[e.tool] ?? 0) + 1
  }
  return counts
}

function ensureDir(dir: string): void {
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
  }
}

const MAX_FILE_SIZE = 8192

/** Persist a distilled session entry to the project knowledge file. */
export function persistDream(cwd: string, input: DreamInput): void {
  const entry = distillSession(input)
  if (!entry) return

  const dir = join(cwd, '.rivet', 'knowledge')
  ensureDir(dir)
  const path = join(dir, 'project-memory.md')

  let existing = ''
  try { existing = readFileSync(path, 'utf-8') } catch { /* first write */ }

  // Deduplicate: same day + same files → keep latest only
  const dedupKey = buildDedupKey(input)
  const deduped = dedupKey ? removeMatchingEntry(existing, dedupKey) : existing

  const combined = entry + '\n' + deduped
  const trimmed = trimToEntryBoundary(combined, MAX_FILE_SIZE)
  writeFileAtomicSync(path, trimmed)
}

/** Trim from the tail, but only at `### ` entry boundaries — never mid-entry. */
function trimToEntryBoundary(content: string, maxSize: number): string {
  if (content.length <= maxSize) return content
  // Remove oldest entries (at the end) until we fit
  const entries = content.split(/(?=^### )/m).filter(e => e.trim())
  while (entries.length > 1 && entries.join('').length > maxSize) {
    entries.pop() // oldest is at the end (new entries are prepended)
  }
  return entries.join('') + '\n'
}

function buildDedupKey(input: DreamInput): string | null {
  if (input.filesModified.length === 0) return null
  const date = new Date().toISOString().slice(0, 10)
  const files = [...input.filesModified].sort().join(',')
  return `${date}:${files}`
}

function removeMatchingEntry(content: string, dedupKey: string): string {
  const date = dedupKey.split(':')[0]!
  const files = dedupKey.split(':').slice(1).join(':')
  const entries = content.split(/(?=^### )/m)
  return entries.filter(entry => {
    if (!entry.startsWith('### ' + date)) return true
    // Check if same files
    const modifiedMatch = entry.match(/\*\*Modified\*\*[^:]*:\s*(.+)/)
    if (!modifiedMatch) return true
    const entryFiles = modifiedMatch[1]!.replace(/\s*\+\d+ more$/, '').split(', ').sort().join(',')
    return entryFiles !== files
  }).join('')
}
