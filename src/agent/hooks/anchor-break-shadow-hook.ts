import type { PostSessionRuntimeHook } from '../runtime-hooks.js'
import type { RetrospectInput } from '../retrospect.js'
import type { StarDomainRegistry } from '../star-domain-registry.js'
import { starDomainRegistry } from '../star-domain-registry.js'
import {
  type AnchorBreakShadowStore,
  buildAnchorBreakShadowEvent,
  deriveCandidateForeignDomains,
  persistAnchorBreakShadow,
  shouldShadowUnderExploredConvergence,
} from '../anchor-break-shadow.js'

export interface AnchorBreakShadowHookDeps {
  /** Telemetry sink (meridian DB). When absent the hook is a no-op. */
  store?: AnchorBreakShadowStore | null
  /** Session retrospect summary (sensorium entries + tool events). */
  buildRetrospectInput: () => RetrospectInput
  /** Current session id. */
  getSessionId: () => string | undefined
  /** Current task objective (for objective hash + foreign-domain derivation). */
  getObjective?: () => string | null
  /** Active star domain id, excluded from foreign-domain candidates. */
  getActiveDomainId?: () => string | null
  /** Domain registry for orthogonal-domain derivation. Defaults to the global singleton. */
  domainRegistry?: StarDomainRegistry
}

/**
 * postSession observer for "under-explored convergence" (P1, observe-only).
 *
 * Reads the session retrospect at convergence and, when a complex task was
 * resolved in very few turns without any breadth tool, records a shadow event
 * naming the orthogonal foreign domains a break-anchor scout could have
 * explored. It ONLY persists telemetry — it never touches ctx.effects, so it
 * is guaranteed to be zero-behavior-change.
 */
export function createAnchorBreakShadowHook(deps: AnchorBreakShadowHookDeps): PostSessionRuntimeHook {
  return {
    phase: 'postSession',
    name: 'anchor-break-shadow',
    run() {
      try {
        if (!deps.store) return
        const sessionId = deps.getSessionId()
        if (!sessionId) return

        const retrospect = deps.buildRetrospectInput()
        const entries = retrospect.sensoriumEntries
        if (entries.length === 0) return

        const complexityMax = entries.reduce((max, e) => (e.complexity > max ? e.complexity : max), 0)
        const turns = entries.length
        const toolNames = [...new Set(retrospect.toolEvents.map(e => e.name))]

        if (!shouldShadowUnderExploredConvergence({ complexityMax, turns, toolNames })) return

        const objective = deps.getObjective?.() ?? ''
        const candidateForeignDomains = deriveCandidateForeignDomains(
          deps.getActiveDomainId?.() ?? null,
          objective,
          deps.domainRegistry ?? starDomainRegistry,
        )

        const event = buildAnchorBreakShadowEvent({
          sessionId,
          objective,
          complexityMax,
          turns,
          toolNames,
          candidateForeignDomains,
        })

        persistAnchorBreakShadow(deps.store, event)
      } catch {
        // Shadow telemetry must never affect the session.
      }
    },
  }
}
