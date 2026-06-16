/**
 * Dream distillation — session-end knowledge extraction.
 *
 * Writes curated project memory to .rivet/knowledge/project-memory.md.
 * The write gate is intentionally high: Dream should preserve reusable judgment
 * signals (scout convergence, architecture invariants, selection rules,
 * conceptual reframes, reusable design patterns), not session telemetry.
 */

import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { writeFileAtomicSync } from '../fs-atomic.js'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
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

export type DreamCriterion =
  | 'convergence_insight'
  | 'architectural_invariant'
  | 'selection_rule'
  | 'conceptual_reframe'
  | 'reusable_design_pattern'

interface CuratedMemoryCandidate {
  criterion: DreamCriterion
  claim: string
}

const CRITERIA: Array<{ criterion: DreamCriterion; pattern: RegExp; prefix: RegExp }> = [
  {
    criterion: 'convergence_insight',
    pattern: /\b(convergence insight|core insight|key insight|scout convergence)\b|收敛洞察|核心洞察/i,
    prefix: /^\s*(?:convergence insight|core insight|key insight|scout convergence|收敛洞察|核心洞察)\s*[:：-]\s*/i,
  },
  {
    criterion: 'architectural_invariant',
    pattern: /\b(architectural invariant|architecture invariant|invariant)\b|架构不变量|架构约束/i,
    prefix: /^\s*(?:architectural invariant|architecture invariant|invariant|架构不变量|架构约束)\s*[:：-]\s*/i,
  },
  {
    criterion: 'selection_rule',
    pattern: /\b(selection rule|write gate|memory gate|routing rule|decision rule)\b|选择规则|写入门槛|记忆门槛/i,
    prefix: /^\s*(?:selection rule|write gate|memory gate|routing rule|decision rule|选择规则|写入门槛|记忆门槛)\s*[:：-]\s*/i,
  },
  {
    criterion: 'conceptual_reframe',
    pattern: /\b(conceptual reframe|reframe|reframing)\b|概念重构|重新定义/i,
    prefix: /^\s*(?:conceptual reframe|reframe|reframing|概念重构|重新定义)\s*[:：-]\s*/i,
  },
  {
    criterion: 'reusable_design_pattern',
    pattern: /\b(reusable design pattern|reusable pattern|design pattern)\b|可复用设计模式|可复用模式/i,
    prefix: /^\s*(?:reusable design pattern|reusable pattern|design pattern|可复用设计模式|可复用模式)\s*[:：-]\s*/i,
  },
]

const NAVIGATOR_PREFERENCE_RE = /\b(navigator preference|user preference)\b|领航星偏好|用户偏好/i
const MIN_CLAIM_LENGTH = 20

/**
 * Distill a session into a curated Markdown knowledge entry.
 *
 * A session is written only when at least one explicit decision matches the
 * curated memory criteria from docs/analysis/2026-05-27-project-memory-signal-vs-noise.md §6,
 * excluding Navigator preference by current product decision.
 */
export function distillSession(input: DreamInput): string | null {
  const candidates = extractCuratedMemoryCandidates(input.decisions)
  if (candidates.length === 0) return null

  const now = new Date().toISOString()
  const criteria = [...new Set(candidates.map(c => c.criterion))]
  const lines: string[] = []

  lines.push(`### ${now.slice(0, 10)} — Curated project memory`)
  lines.push(`<!-- dream-key: ${buildCandidateHash(candidates)} -->`)
  lines.push('')
  lines.push(`**Kind**: ${criteria.join(' / ')}`)
  lines.push('')
  lines.push('**Claims**:')
  for (const candidate of candidates) {
    lines.push(`- [${candidate.criterion}] ${candidate.claim}`)
  }
  lines.push('')
  lines.push('**Why it matters**:')
  lines.push('These claims matched the curated project-memory write gate: they are intended to improve future architectural judgment rather than replay session telemetry.')
  lines.push('')
  lines.push('**Evidence**:')
  lines.push(`- session: ${input.sessionId.slice(0, 8)}`)
  lines.push('- source: explicit session decisions')
  lines.push('')

  return lines.join('\n')
}

function extractCuratedMemoryCandidates(decisions: string[]): CuratedMemoryCandidate[] {
  const candidates: CuratedMemoryCandidate[] = []
  const seen = new Set<string>()

  for (const decision of decisions) {
    const raw = normalizeDecision(decision)
    if (!raw || NAVIGATOR_PREFERENCE_RE.test(raw)) continue

    for (const criterion of CRITERIA) {
      if (!criterion.pattern.test(raw)) continue
      const claim = raw.replace(criterion.prefix, '').trim()
      if (claim.length < MIN_CLAIM_LENGTH) continue
      const key = `${criterion.criterion}:${claim.toLowerCase()}`
      if (seen.has(key)) continue
      seen.add(key)
      candidates.push({ criterion: criterion.criterion, claim })
      break
    }
  }

  return candidates
}

function normalizeDecision(decision: string): string {
  return decision
    .replace(/^\s*[-*]\s*/, '')
    .replace(/^\s*Decision\s*:\s*/i, '')
    .replace(/\s+/g, ' ')
    .trim()
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

  const dedupKey = extractDreamKey(entry)
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

function removeMatchingEntry(content: string, dedupKey: string): string {
  const entries = content.split(/(?=^### )/m)
  return entries.filter(entry => extractDreamKey(entry) !== dedupKey).join('')
}

function extractDreamKey(entry: string): string | null {
  const match = entry.match(/<!--\s*dream-key:\s*([^\s]+)\s*-->/)
  return match?.[1] ?? null
}

function buildCandidateHash(candidates: CuratedMemoryCandidate[]): string {
  const source = candidates
    .map(c => `${c.criterion}:${c.claim.toLowerCase().replace(/\s+/g, ' ').trim()}`)
    .sort()
    .join('|')
  return simpleHash(source)
}

function simpleHash(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 12)
}

/**
 * Remove legacy noise entries from project-memory.md.
 *
 * Valid entries have a `dream-key` comment AND at least one claim matching
 * the curated criteria. Entries missing the dream-key or containing only
 * session telemetry (e.g., tool counts, file lists without insight) are
 * removed.
 */
export function cleanupProjectMemory(cwd: string): { removed: number; kept: number } {
  const path = join(cwd, '.rivet', 'knowledge', 'project-memory.md')
  let content: string
  try { content = readFileSync(path, 'utf-8') } catch { return { removed: 0, kept: 0 } }
  if (!content.trim()) return { removed: 0, kept: 0 }

  const entries = content.split(/(?=^### )/m).filter(e => e.trim())
  const valid = entries.filter(entry => {
    if (!extractDreamKey(entry)) return false
    return CRITERIA.some(c => c.pattern.test(entry))
  })

  const removed = entries.length - valid.length
  if (removed > 0) {
    const dir = join(cwd, '.rivet', 'knowledge')
    ensureDir(dir)
    writeFileAtomicSync(path, valid.join('') + '\n')
  }
  return { removed, kept: valid.length }
}
