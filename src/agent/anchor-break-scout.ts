/**
 * Anchor-break scout (P2, real intervention — opt-in / default off).
 *
 * Where P1 (anchor-break-shadow.ts) observes "under-explored convergence" at
 * postSession, P2 acts predictively at preTurn: when a complex task is being
 * resolved without any breadth exploration and the agent is NOT stuck, it
 * dispatches a real read-only sub-agent scoped to an *orthogonal* star domain
 * (deep-brainstorm's "foreign-domain scout"). The scout's findings are then
 * injected back into the main context (cache-safe, via injectUserMessage) so
 * the model can break out of its anchor basin before committing.
 *
 * This module is pure decision/build/format/telemetry. The actual delegation
 * and injection live in the preTurn hook. Behaviour is gated behind an
 * explicit config flag (default off) — see anti-anchoring-config.ts.
 */

import type { DelegationRequest } from './coordinator.js'
import type { WorkerBudget } from './work-order.js'
import {
  COMPLEXITY_THRESHOLD as SHADOW_COMPLEXITY_THRESHOLD,
  hashObjective,
  type AnchorBreakShadowStore,
} from './anchor-break-shadow.js'

/** Default complexity peak above which a scout is worthwhile (aligned with P1). */
export const SCOUT_COMPLEXITY_THRESHOLD = SHADOW_COMPLEXITY_THRESHOLD
/** Default minimum turn before scouting — enough turns in to have committed to a path. */
export const SCOUT_MIN_TURN = 3
/** Read-only scout profile (matches delegate_task default). */
export const SCOUT_PROFILE = 'code_scout'

export interface ForeignScoutDecisionInput {
  /** Master gate — config flag. */
  enabled: boolean
  /** Peak/current sensorium complexity. */
  complexity: number
  /** Current session turn. */
  turn: number
  /** Whether any breadth tool has been used this session (anchor already broken). */
  seenBreadthTool: boolean
  /** Whether a scout has already been dispatched this session. */
  hasScouted: boolean
  /** Whether the agent is stuck (kick territory) — scouting defers to kick (re-anchor). */
  stuck: boolean
  /** Complexity gate. */
  complexityThreshold?: number
  /** Turn gate. */
  minTurn?: number
}

/**
 * Predictive trigger for an orthogonal-domain scout. Fires only on a complex,
 * fast-moving, anchor-bound, healthy (not stuck) task that hasn't scouted yet.
 */
export function shouldDispatchForeignScout(input: ForeignScoutDecisionInput): boolean {
  if (!input.enabled) return false
  if (input.hasScouted) return false
  if (input.stuck) return false
  if (input.seenBreadthTool) return false
  if (input.complexity < (input.complexityThreshold ?? SCOUT_COMPLEXITY_THRESHOLD)) return false
  if (input.turn < (input.minTurn ?? SCOUT_MIN_TURN)) return false
  return true
}

export interface BuildForeignScoutRequestInput {
  parentTurnId: string
  objective: string
  foreignDomainId: string
  /** Depth to assign the scout (parent depth + 1). Coordinator rejects >= MAX_DELEGATION_DEPTH. */
  delegationDepth: number
  sessionTurn?: number
  budget?: Partial<WorkerBudget>
}

/**
 * Build a read-only delegation request for an orthogonal-domain scout. The
 * `authority` field makes buildWorkerPrompt inject the foreign domain's
 * volatileBlock + systemPromptSuffix, so the scout literally reasons from that
 * domain's perspective.
 */
export function buildForeignScoutRequest(input: BuildForeignScoutRequestInput): DelegationRequest {
  return {
    parentTurnId: input.parentTurnId,
    objective:
      `从「${input.foreignDomainId}」星域的正交视角审视下面这个任务，带回主路径很可能忽略的角度、` +
      `邻接问题、反直觉的切入点或隐藏约束。不要复述显而易见的解法，只报告能拓宽思路的发现。\n\n任务：${input.objective}`,
    kind: 'doc_research',
    profile: SCOUT_PROFILE,
    authority: input.foreignDomainId,
    scope: {},
    delegationDepth: input.delegationDepth,
    ...(input.sessionTurn !== undefined ? { sessionTurn: input.sessionTurn } : {}),
    ...(input.budget ? { budget: input.budget } : {}),
  }
}

/**
 * Wrap scout findings for cache-safe injection. The caller passes this to
 * ctx.effects.injectUserMessage, which wraps it as a <system-reminder> and
 * appends at the tail (no prefix-cache break).
 */
export function formatScoutInjection(packet: string, foreignDomainId: string): string {
  return (
    `<外域-侦察 domain="${foreignDomainId}">\n${packet}\n` +
    `（破锚提示：以上是正交外域视角的侦察结果。定稿前评估是否有角度值得改变当前方案；` +
    `若无新意可忽略，不必为引用而引用。）\n</外域-侦察>`
  )
}

export interface ForeignScoutShadowEvent {
  schemaVersion: 1
  sessionId: string
  turn: number
  objectiveHash: string
  foreignDomainId: string
  dispatched: boolean
  packetChars: number
  reason: string
  timestamp: number
}

export interface BuildForeignScoutEventInput {
  sessionId: string
  turn: number
  objective: string
  foreignDomainId: string
  dispatched: boolean
  packetChars: number
  reason: string
  timestamp?: number
}

export function buildForeignScoutEvent(input: BuildForeignScoutEventInput): ForeignScoutShadowEvent {
  return {
    schemaVersion: 1,
    sessionId: input.sessionId,
    turn: input.turn,
    objectiveHash: hashObjective(input.objective),
    foreignDomainId: input.foreignDomainId,
    dispatched: input.dispatched,
    packetChars: input.packetChars,
    reason: input.reason,
    timestamp: input.timestamp ?? Date.now(),
  }
}

export function foreignScoutEventKind(
  event: Pick<ForeignScoutShadowEvent, 'sessionId' | 'turn' | 'timestamp'>,
): string {
  return `anchor_break_scout:${event.sessionId}:${event.turn}:${event.timestamp}`
}

export function persistForeignScoutEvent(
  store: AnchorBreakShadowStore | undefined | null,
  event: ForeignScoutShadowEvent,
): void {
  if (!store) return
  try {
    store.saveBanditState(foreignScoutEventKind(event), JSON.stringify(event))
  } catch {
    // Telemetry must never affect the turn.
  }
}
