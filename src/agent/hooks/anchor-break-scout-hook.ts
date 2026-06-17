import type { PreTurnRuntimeHook } from '../runtime-hooks.js'
import type { DelegationCoordinator } from '../coordinator.js'
import type { DoomLoopLevel } from '../trace-store.js'
import type { StarDomainRegistry } from '../star-domain-registry.js'
import { starDomainRegistry } from '../star-domain-registry.js'
import { shouldKick } from '../dissipative-kick.js'
import {
  BREADTH_TOOLS,
  type AnchorBreakShadowStore,
  deriveCandidateForeignDomains,
} from '../anchor-break-shadow.js'
import {
  buildForeignScoutEvent,
  buildForeignScoutRequest,
  formatScoutInjection,
  persistForeignScoutEvent,
  shouldDispatchForeignScout,
} from '../anchor-break-scout.js'

export interface AnchorBreakScoutConfig {
  enabled: boolean
  complexityThreshold: number
  minTurn: number
  scoutBudgetMs: number
  scoutMaxTokens: number
}

export interface AnchorBreakScoutHookDeps {
  config: AnchorBreakScoutConfig
  getCoordinator: () => DelegationCoordinator | null
  getSessionId: () => string | undefined
  getObjective: () => string | null
  getActiveDomainId?: () => string | null
  domainRegistry?: StarDomainRegistry
  getDoomLoopLevel?: () => DoomLoopLevel
  /** Parent delegation depth (0 = main loop). Scout runs at depth + 1. */
  getDelegationDepth?: () => number
  getAbortSignal?: () => AbortSignal | undefined
  /** Telemetry sink (meridian DB). Optional. */
  store?: AnchorBreakShadowStore | null
}

/**
 * preTurn observer + intervention for "premature anchoring" (P2, opt-in).
 *
 * On a complex, anchor-bound, healthy task it dispatches one orthogonal-domain
 * read-only scout and injects its findings (cache-safe) before the model
 * commits. Once per session. Never fires when disabled, stuck, already
 * explored, or already scouted. All failures are swallowed so the scout can
 * never break the main turn.
 */
export function createAnchorBreakScoutHook(deps: AnchorBreakScoutHookDeps): PreTurnRuntimeHook {
  let seenBreadthTool = false
  let hasScouted = false

  return {
    phase: 'preTurn',
    name: 'anchor-break-scout',
    async run(ctx) {
      try {
        if (!deps.config.enabled) return

        // Accumulate breadth-tool usage across the session.
        if (!seenBreadthTool) {
          for (const entry of ctx.snapshot.recentToolHistory) {
            if (BREADTH_TOOLS.has(entry.tool)) {
              seenBreadthTool = true
              break
            }
          }
        }

        const sensorium = ctx.snapshot.sensorium
        if (!sensorium) return

        const stuck =
          shouldKick(sensorium) || deps.getDoomLoopLevel?.() === 'blocked'

        if (
          !shouldDispatchForeignScout({
            enabled: deps.config.enabled,
            complexity: sensorium.complexity,
            turn: ctx.snapshot.turn,
            seenBreadthTool,
            hasScouted,
            stuck,
            complexityThreshold: deps.config.complexityThreshold,
            minTurn: deps.config.minTurn,
          })
        ) {
          return
        }

        const coordinator = deps.getCoordinator()
        if (!coordinator) return

        const sessionId = deps.getSessionId()
        if (!sessionId) return

        const objective = deps.getObjective() ?? ''
        if (!objective.trim()) return

        const registry = deps.domainRegistry ?? starDomainRegistry
        const candidates = deriveCandidateForeignDomains(
          deps.getActiveDomainId?.() ?? null,
          objective,
          registry,
        )
        const foreignDomainId = candidates[0]
        if (!foreignDomainId) return

        // Mark before awaiting so an in-flight scout can't be double-dispatched
        // by a subsequent turn.
        hasScouted = true

        const parentDepth = deps.getDelegationDepth?.() ?? 0
        const request = buildForeignScoutRequest({
          parentTurnId: `anchor-break-scout:${sessionId}:${ctx.snapshot.turn}`,
          objective,
          foreignDomainId,
          delegationDepth: parentDepth + 1,
          sessionTurn: ctx.snapshot.turn,
          budget: {
            maxTurns: 3,
            maxTokens: deps.config.scoutMaxTokens,
            timeoutMs: deps.config.scoutBudgetMs,
            maxRetries: 0,
          },
        })

        const run = await coordinator.delegate(request, deps.getAbortSignal?.())

        const packet = run.status === 'completed' ? run.packet : ''
        const dispatched = packet.trim().length > 0
        if (dispatched) {
          ctx.effects.injectUserMessage(formatScoutInjection(packet, foreignDomainId))
        }

        persistForeignScoutEvent(
          deps.store,
          buildForeignScoutEvent({
            sessionId,
            turn: ctx.snapshot.turn,
            objective,
            foreignDomainId,
            dispatched,
            packetChars: packet.length,
            reason: dispatched
              ? 'foreign-domain scout injected'
              : `scout produced no packet (status=${run.status})`,
          }),
        )
      } catch {
        // Scout intervention must never break the main turn.
      }
    },
  }
}
