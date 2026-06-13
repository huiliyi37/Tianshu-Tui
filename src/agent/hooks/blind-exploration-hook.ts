import type { PreTurnRuntimeHook, RuntimeHookContext } from '../runtime-hooks.js'

export interface BlindExplorationHookOpts {
  /** Which turns to activate blind exploration (default: [1]) */
  activeTurns?: number[]
}

/**
 * Blind Exploration Hook — injects a "seedFree" exploration directive
 * on configured turns, encouraging the model to explore broadly before
 * anchoring on the user's first framing.
 *
 * Maps to: Rebook's seedFree pipeline step / CTM's decoupled internal ticks /
 * COCONUT's latent-space multi-path exploration / Pause tokens' extra compute.
 */
export function createBlindExplorationHook(opts: BlindExplorationHookOpts = {}): PreTurnRuntimeHook {
  const activeTurns = new Set(opts.activeTurns ?? [1])

  return {
    phase: 'preTurn',
    name: 'blind-exploration',
    run(ctx: RuntimeHookContext) {
      if (!activeTurns.has(ctx.snapshot.turn)) return

      ctx.effects.injectUserMessage(
        '<破军-探索 type="blind-exploration">Before committing to an approach: ' +
        'explore the problem space broadly. Consider alternative framings, ' +
        'adjacent problems, and non-obvious angles. ' +
        'Do not fixate on the most obvious interpretation of the request.</破军-探索>',
      )
    },
  }
}
