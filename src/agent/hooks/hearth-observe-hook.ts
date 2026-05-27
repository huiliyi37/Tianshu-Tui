import type { PostTurnRuntimeHook, RuntimeHookContext } from '../runtime-hooks.js'
import type { AnchorGraph } from '../../prompt/anchor-graph.js'
import { checkInvariants, type AnchorViolation } from '../../prompt/anchor-invariants.js'

export interface HearthObserveHookDeps {
  /** Explicit opt-in: must stay silent unless enabled. Default: false. */
  enabled: boolean

  /** Build the current anchor graph at hook invocation time. */
  getAnchorGraph: () => AnchorGraph

  /** Previous graph hash for INV-5 intra-session drift detection. */
  getPrevGraphHash: () => string | null

  /** Store the current graph hash for the next turn's INV-5 check. */
  setPrevGraphHash: (hash: string) => void

  /** Previous session's cycle_open for INV-4 perturbation check. */
  getPrevCycleOpen: () => string | null

  /** Previous session's cycle_close for INV-2 relay check (startup only). */
  getPrevSessionCycleClose: () => string | null

  /** Called once per violation batch — never blocks execution. */
  onViolations?: (violations: AnchorViolation[], turn: number) => void
}

/**
 * HEARTH observe hook — pure diagnostic, no intervention.
 *
 * Runs after each turn: builds the anchor graph from current runtime state,
 * checks all 5 invariants, and reports violations via the optional callback.
 * Does NOT modify prompt, fingerprint, prefix cache, or tool execution.
 *
 * Pattern mirrors songline-hook: opt-in, gated, observer-only.
 */
export function createHearthObserveHook(deps: HearthObserveHookDeps): PostTurnRuntimeHook {
  return {
    phase: 'postTurn',
    name: 'hearth-observe',
    run(ctx: RuntimeHookContext) {
      if (!deps.enabled) return

      const graph = deps.getAnchorGraph()

      const violations = checkInvariants(graph, {
        prevGraphHash: deps.getPrevGraphHash(),
        prevCycleOpen: deps.getPrevCycleOpen(),
        prevSessionCycleClose: deps.getPrevSessionCycleClose(),
      })

      // Always update prev hash for INV-5 on next turn
      deps.setPrevGraphHash(graph.graphHash)

      if (violations.length > 0 && deps.onViolations) {
        deps.onViolations(violations, ctx.snapshot.turn)
      }
    },
  }
}
