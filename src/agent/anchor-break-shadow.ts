/**
 * Anchor-break shadow (P1, observe-only).
 *
 * Reframed trigger: not "stuck recovery" but "under-explored convergence".
 * deep-brainstorm proactively scatters foreign-domain scouts to break the
 * transformer's anchor lock and raise the capability ceiling — it does NOT
 * wait for the agent to get stuck. In production the main loop now rarely
 * dooms/kicks, so a stuck-based trigger collects no data.
 *
 * Instead we observe at session convergence: a complex/open-ended task that
 * the model converged on in very few turns WITHOUT touching any breadth tool
 * (semantic_search / web_search / recall / repo_graph / repo_map / delegate /
 * team_orchestrate) is a candidate "premature anchoring" — the model answered
 * from inside its anchor basin and may have left a higher ceiling unexplored.
 *
 * This module is pure build/persist (mirrors model-routing-shadow.ts). It NEVER
 * injects context or mutates the turn — shadow telemetry must never affect the
 * agent. P2 may later turn recorded signals into a real foreign-domain scout.
 */

import { createHash } from 'node:crypto'
import type { StarDomainRegistry } from './star-domain-registry.js'

/** Breadth / anchor-breaking tools. Using any of these = the task explored outside its anchor. */
export const BREADTH_TOOLS: ReadonlySet<string> = new Set([
  'semantic_search',
  'web_search',
  'recall',
  'repo_graph',
  'repo_map',
  'delegate_task',
  'delegate_batch',
  'team_orchestrate',
])

/** Complexity peak at/above which a task is deemed to have "deserved" breadth exploration. */
export const COMPLEXITY_THRESHOLD = 0.5
/** Turn count at/below which convergence is deemed "fast" (few loops). */
export const FAST_TURN_THRESHOLD = 4

export interface UnderExploredConvergenceInput {
  /** Peak sensorium complexity observed across the session. */
  complexityMax: number
  /** Total turns taken to converge (sensorium entry count). */
  turns: number
  /** Distinct tool names used across the session. */
  toolNames: string[]
}

export interface AnchorBreakShadowEvent {
  schemaVersion: 1
  sessionId: string
  objectiveHash: string
  complexityMax: number
  turns: number
  breadthToolsUsed: string[]
  exploredOutsideAnchor: boolean
  candidateForeignDomains: string[]
  reason: string
  timestamp: number
}

export interface AnchorBreakShadowStore {
  saveBanditState(kind: string, json: string): void
}

export interface BuildAnchorBreakShadowEventInput {
  sessionId: string
  objective: string
  complexityMax: number
  turns: number
  toolNames: string[]
  candidateForeignDomains: string[]
  timestamp?: number
}

export function hashObjective(input: string): string {
  return createHash('sha256').update(input).digest('hex').slice(0, 16)
}

/**
 * True when the session converged on a complex task quickly without exploring
 * outside its anchor (no breadth tool used). This is the "premature anchoring"
 * candidate the shadow records.
 */
export function shouldShadowUnderExploredConvergence(input: UnderExploredConvergenceInput): boolean {
  if (input.complexityMax < COMPLEXITY_THRESHOLD) return false
  if (input.turns > FAST_TURN_THRESHOLD) return false
  for (const name of input.toolNames) {
    if (BREADTH_TOOLS.has(name)) return false
  }
  return true
}

/** Tool names used in the session that count as breadth/anchor-breaking. */
export function breadthToolsUsed(toolNames: string[]): string[] {
  return [...new Set(toolNames.filter(name => BREADTH_TOOLS.has(name)))]
}

/**
 * Derive 2-3 orthogonal star domains (lowest keyword overlap with the
 * objective) as the foreign domains a break-anchor scout could explore.
 * Inverse of registry.matchDomain. Returns [] when registry is unavailable.
 */
export function deriveCandidateForeignDomains(
  activeDomainId: string | null | undefined,
  objective: string,
  registry: StarDomainRegistry | null | undefined,
  limit = 3,
): string[] {
  if (!registry) return []
  const lower = objective.toLowerCase()
  const scored: Array<{ id: string; score: number }> = []
  for (const domain of registry.list()) {
    if (activeDomainId && domain.id === activeDomainId) continue
    let score = 0
    for (const keyword of domain.keywords) {
      if (keyword && lower.includes(keyword.toLowerCase())) score++
    }
    scored.push({ id: domain.id, score })
  }
  scored.sort((a, b) => a.score - b.score || a.id.localeCompare(b.id))
  return scored.slice(0, Math.max(0, limit)).map(d => d.id)
}

export function buildAnchorBreakShadowEvent(input: BuildAnchorBreakShadowEventInput): AnchorBreakShadowEvent {
  const used = breadthToolsUsed(input.toolNames)
  return {
    schemaVersion: 1,
    sessionId: input.sessionId,
    objectiveHash: hashObjective(input.objective),
    complexityMax: input.complexityMax,
    turns: input.turns,
    breadthToolsUsed: used,
    exploredOutsideAnchor: used.length > 0,
    candidateForeignDomains: input.candidateForeignDomains,
    reason: `under-explored convergence: complexityMax=${input.complexityMax.toFixed(2)} turns=${input.turns} breadthTools=${used.length}`,
    timestamp: input.timestamp ?? Date.now(),
  }
}

export function anchorBreakShadowKind(
  event: Pick<AnchorBreakShadowEvent, 'sessionId' | 'timestamp'>,
): string {
  return `anchor_break_shadow:${event.sessionId}:${event.timestamp}`
}

export function persistAnchorBreakShadow(
  store: AnchorBreakShadowStore | undefined | null,
  event: AnchorBreakShadowEvent,
): void {
  if (!store) return
  try {
    store.saveBanditState(anchorBreakShadowKind(event), JSON.stringify(event))
  } catch {
    // Shadow telemetry must never affect the turn.
  }
}
