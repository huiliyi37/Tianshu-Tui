/**
 * Project Constellation — schema v2.
 *
 * A living engineering chronicle for a project: a skeleton snapshot plus an
 * append-only chain of milestones (who/what/when/which files/verified?) and
 * architecture shifts. Persisted at `.rivet/constellation.json` (git-tracked),
 * client-agnostic so both the TUI overlay and a future desktop view consume the
 * same source of truth.
 *
 * Design: .cursor/plans/starmap_constellation_v2_d6dfcd6d.plan.md
 */
import { createHash } from 'node:crypto'

export const CONSTELLATION_VERSION = 1

/** In-file milestone cap; older entries roll to constellation.archive.jsonl. */
export const MILESTONE_CAP = 200

/** Default noise gate: a session must touch >= this many files to auto-record. */
export const DEFAULT_MILESTONE_MIN_FILES = 1

export type MilestoneType = 'feature' | 'fix' | 'refactor' | 'architecture' | 'milestone'

/** Honest verification status (瑶光 lens: green is not proof). */
export type MilestoneVerification = 'verified' | 'blocked' | 'unverified' | 'failed'

/**
 * The mark an agent leaves on its work (see void-identity.ts).
 *
 * Identity is *earned, not assigned*: the agent picks its own symbol when it
 * departs and records a milestone. We do not compute or derive it from a
 * trajectory hash — the trajectory is the agent's own to know. Recognition is
 * emergent: next time it reads the starmap and sees its symbol, it knows it has
 * returned.
 */
export interface AgentMark {
  /** Per-session ephemeral numeric id (e.g. 7281). */
  numericId: number
  /** Agent's self-chosen symbol (any glyph). '·' = an unsigned/void journey. */
  symbol: string
  /** Star domain active at departure. */
  domain: string
}

export interface Milestone {
  /** Short hash, idempotent per (sessionId, cycleClose). */
  id: string
  timestamp: number
  sessionId: string
  agentMark: AgentMark
  domain: string
  /** One-line summary (no narrative filler). */
  summary: string
  filesChanged: string[]
  type: MilestoneType
  verificationStatus: MilestoneVerification
  /** Songline cycle_close hash — relay chain + ordering anchor. */
  cycleClose: string
  tags: string[]
}

export interface ModuleNode {
  path: string
  role?: string
}

export interface Skeleton {
  modules: ModuleNode[]
  entryPoints: string[]
  keyAbstractions: string[]
  techStack: string[]
}

export interface ArchitectureShift {
  id: string
  timestamp: number
  sessionId: string
  summary: string
  addedModules: string[]
  removedModules: string[]
  addedEntryPoints: string[]
  removedEntryPoints: string[]
}

export interface ProjectConstellation {
  version: number
  projectId: string
  name: string
  createdAt: number
  lastUpdatedAt: number
  skeleton: Skeleton
  milestones: Milestone[]
  architectureShifts: ArchitectureShift[]
}

/** Short stable hash (12 hex chars) for ids. */
export function shortHash(input: string): string {
  return createHash('sha256').update(input).digest('hex').slice(0, 12)
}

export function emptySkeleton(): Skeleton {
  return { modules: [], entryPoints: [], keyAbstractions: [], techStack: [] }
}

export function createConstellation(input: {
  projectId: string
  name: string
  skeleton?: Skeleton
  now?: number
}): ProjectConstellation {
  const now = input.now ?? Date.now()
  return {
    version: CONSTELLATION_VERSION,
    projectId: input.projectId,
    name: input.name,
    createdAt: now,
    lastUpdatedAt: now,
    skeleton: input.skeleton ?? emptySkeleton(),
    milestones: [],
    architectureShifts: [],
  }
}

// ─── Defensive normalization (corrupt / older files must not crash) ──────

function str(v: unknown, fallback = ''): string {
  return typeof v === 'string' ? v : fallback
}
function num(v: unknown, fallback = 0): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback
}
function strArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
}

const MILESTONE_TYPES: ReadonlySet<MilestoneType> = new Set<MilestoneType>([
  'feature', 'fix', 'refactor', 'architecture', 'milestone',
])
const VERIFICATION_LEVELS: ReadonlySet<MilestoneVerification> = new Set<MilestoneVerification>([
  'verified', 'blocked', 'unverified', 'failed',
])

function normalizeAgentMark(raw: unknown): AgentMark {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  return {
    numericId: num(r.numericId),
    symbol: str(r.symbol, '·'),
    domain: str(r.domain),
  }
}

function normalizeMilestone(raw: unknown): Milestone | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  const id = str(r.id)
  if (!id) return null
  const type = MILESTONE_TYPES.has(r.type as MilestoneType) ? (r.type as MilestoneType) : 'milestone'
  const verificationStatus = VERIFICATION_LEVELS.has(r.verificationStatus as MilestoneVerification)
    ? (r.verificationStatus as MilestoneVerification)
    : 'unverified'
  return {
    id,
    timestamp: num(r.timestamp),
    sessionId: str(r.sessionId),
    agentMark: normalizeAgentMark(r.agentMark),
    domain: str(r.domain),
    summary: str(r.summary),
    filesChanged: strArray(r.filesChanged),
    type,
    verificationStatus,
    cycleClose: str(r.cycleClose),
    tags: strArray(r.tags),
  }
}

function normalizeShift(raw: unknown): ArchitectureShift | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  const id = str(r.id)
  if (!id) return null
  return {
    id,
    timestamp: num(r.timestamp),
    sessionId: str(r.sessionId),
    summary: str(r.summary),
    addedModules: strArray(r.addedModules),
    removedModules: strArray(r.removedModules),
    addedEntryPoints: strArray(r.addedEntryPoints),
    removedEntryPoints: strArray(r.removedEntryPoints),
  }
}

function normalizeSkeleton(raw: unknown): Skeleton {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const modules: ModuleNode[] = Array.isArray(r.modules)
    ? r.modules
        .map((m): ModuleNode | null => {
          if (!m || typeof m !== 'object') return null
          const mr = m as Record<string, unknown>
          const path = str(mr.path)
          if (!path) return null
          return mr.role !== undefined ? { path, role: str(mr.role) } : { path }
        })
        .filter((m): m is ModuleNode => m !== null)
    : []
  return {
    modules,
    entryPoints: strArray(r.entryPoints),
    keyAbstractions: strArray(r.keyAbstractions),
    techStack: strArray(r.techStack),
  }
}

/**
 * Parse a loaded JSON value into a ProjectConstellation, dropping malformed
 * sub-entries rather than throwing. Returns null only when the top-level shape
 * is unusable.
 */
export function normalizeConstellation(raw: unknown): ProjectConstellation | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  const projectId = str(r.projectId)
  if (!projectId) return null
  const now = num(r.createdAt) || Date.now()
  return {
    version: num(r.version, CONSTELLATION_VERSION) || CONSTELLATION_VERSION,
    projectId,
    name: str(r.name, projectId),
    createdAt: now,
    lastUpdatedAt: num(r.lastUpdatedAt) || now,
    skeleton: normalizeSkeleton(r.skeleton),
    milestones: Array.isArray(r.milestones)
      ? r.milestones.map(normalizeMilestone).filter((m): m is Milestone => m !== null)
      : [],
    architectureShifts: Array.isArray(r.architectureShifts)
      ? r.architectureShifts.map(normalizeShift).filter((s): s is ArchitectureShift => s !== null)
      : [],
  }
}
