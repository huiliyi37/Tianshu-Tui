/**
 * Dream distillation — session-end knowledge extraction.
 *
 * Phase 1 uses template-based extraction (no LLM). Phase 2 will upgrade
 * to LLM-powered distillation via compactClient.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
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

const MAX_FILE_SIZE = 8000

function ensureDir(dir: string): void {
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
  }
}

/** Persist a distilled session entry to the project knowledge file. */
export function persistDream(cwd: string, input: DreamInput): void {
  const entry = distillSession(input)
  if (!entry) return

  const dir = join(cwd, '.rivet', 'knowledge')
  ensureDir(dir)
  const path = join(dir, 'project-memory.md')

  let existing = ''
  try {
    existing = readFileSync(path, 'utf-8')
  } catch {
    // file doesn't exist yet — start fresh
  }

  const combined = entry + '\n' + existing
  const trimmed = combined.length > MAX_FILE_SIZE
    ? combined.slice(0, MAX_FILE_SIZE)
    : combined

  writeFileSync(path, trimmed, 'utf-8')
}
