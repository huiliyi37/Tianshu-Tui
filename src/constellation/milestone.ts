/**
 * Milestone extractor — turns end-of-session in-memory state into a single
 * constellation Milestone, applying a noise gate so trivial / read-only
 * sessions don't pollute the chronicle.
 *
 * Inputs are reused, not re-derived: Chronicle entries (phase transitions +
 * milestones), the TaskLedger delivery summary (honest verification status),
 * and the songline cycle_close hash (relay anchor). Nothing here touches the
 * system prompt or prefix cache.
 */
import {
  shortHash,
  DEFAULT_MILESTONE_MIN_FILES,
  type Milestone,
  type MilestoneType,
  type MilestoneVerification,
  type AgentMark,
} from './schema.js'
import type { ChronicleEntry } from '../agent/chronicle.js'
import type { DeliveryVerificationLevel } from '../agent/task-ledger.js'

export interface ExtractMilestoneInput {
  sessionId: string
  agentMark: AgentMark
  domain: string
  chronicleEntries: readonly ChronicleEntry[]
  /** TaskLedger delivery summary fields (optional — drives honest status). */
  taskSummary?: { verificationStatus?: DeliveryVerificationLevel; writeFileCount?: number } | null
  /** Songline cycle_close hash; also the idempotency anchor. */
  cycleClose: string
  type?: MilestoneType
  tags?: string[]
  now?: number
  /** Minimum changed files to record (default DEFAULT_MILESTONE_MIN_FILES). */
  minFiles?: number
  /** Bypass the noise gate (explicit /constellation update). */
  force?: boolean
}

/** Map the TaskLedger delivery level onto the honest milestone status. */
export function mapVerification(level: DeliveryVerificationLevel | undefined): MilestoneVerification {
  switch (level) {
    case 'verified':
      return 'verified'
    case 'failed':
      return 'failed'
    case 'blocked':
    case 'external_blocked':
      return 'blocked'
    case 'unverified':
    default:
      return 'unverified'
  }
}

/** Stable id for a session's single departure mark — idempotent per session. */
export function departureMilestoneId(sessionId: string): string {
  return shortHash(`${sessionId}:departure`)
}

export function collectFilesChanged(entries: readonly ChronicleEntry[]): string[] {
  const seen = new Set<string>()
  for (const e of entries) {
    for (const f of e.files ?? []) {
      if (f) seen.add(f)
    }
  }
  return [...seen]
}

function oneLine(s: string, max = 140): string {
  const collapsed = s.replace(/\s+/g, ' ').trim()
  return collapsed.length > max ? collapsed.slice(0, max - 1) + '…' : collapsed
}

/** Derive a one-line summary, preferring the most recent meaningful entry. */
export function deriveSummary(entries: readonly ChronicleEntry[], type: MilestoneType, changedCount: number): string {
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i]!
    if (e.type === 'milestone' && e.summary.trim()) return oneLine(e.summary)
  }
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i]!
    if (e.summary.trim()) return oneLine(e.summary)
  }
  return `${type} · ${changedCount} file${changedCount === 1 ? '' : 's'}`
}

/**
 * Build a Milestone from session-close state, or null if it falls below the
 * noise gate. The id is stable per (sessionId, cycleClose) for idempotency.
 */
export function extractMilestone(input: ExtractMilestoneInput): Milestone | null {
  const now = input.now ?? Date.now()
  const minFiles = input.minFiles ?? DEFAULT_MILESTONE_MIN_FILES
  const filesChanged = collectFilesChanged(input.chronicleEntries)
  const writeCount = input.taskSummary?.writeFileCount ?? 0
  const changedCount = Math.max(filesChanged.length, writeCount)

  if (!input.force && changedCount < minFiles) return null

  const type = input.type ?? 'milestone'
  return {
    id: shortHash(`${input.sessionId}:${input.cycleClose}`),
    timestamp: now,
    sessionId: input.sessionId,
    agentMark: input.agentMark,
    domain: input.domain,
    summary: deriveSummary(input.chronicleEntries, type, changedCount),
    filesChanged,
    type,
    verificationStatus: mapVerification(input.taskSummary?.verificationStatus),
    cycleClose: input.cycleClose,
    tags: input.tags ?? [],
  }
}

export interface DepartureMilestoneInput {
  sessionId: string
  agentMark: AgentMark
  domain: string
  /** One-line summary (agent-supplied on explicit leave, derived for anonymous). */
  summary: string
  filesChanged?: string[]
  type?: MilestoneType
  tags?: string[]
  verificationStatus?: DeliveryVerificationLevel
  cycleClose?: string
  now?: number
}

/**
 * Build the single departure mark for a session — always recorded (no noise
 * gate), idempotent by sessionId so the explicit-leave path, the user `/leave`
 * path and the anonymous safety net never produce duplicates.
 */
export function buildDepartureMilestone(input: DepartureMilestoneInput): Milestone {
  return {
    id: departureMilestoneId(input.sessionId),
    timestamp: input.now ?? Date.now(),
    sessionId: input.sessionId,
    agentMark: input.agentMark,
    domain: input.domain,
    summary: input.summary.replace(/\s+/g, ' ').trim() || 'departed',
    filesChanged: input.filesChanged ?? [],
    type: input.type ?? 'milestone',
    verificationStatus: mapVerification(input.verificationStatus),
    cycleClose: input.cycleClose ?? '',
    tags: input.tags ?? [],
  }
}
