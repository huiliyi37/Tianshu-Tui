import type { PreTurnRuntimeHook, RuntimeHookContext } from '../runtime-hooks.js'
import { AnchorVault, type SealedAnchor } from '../anchor-vault.js'
import { MCTSPlanner, type MCTSPlanResult, type MCTSPlannerOpts } from '../mcts-planner.js'

export interface MCTSPlanningHookOpts {
  /** The explore function — calls a lightweight LLM with a divergent prompt */
  explore: MCTSPlannerOpts['explore']
  /** Number of branches to explore (default: 3) */
  branches?: number
  /** Which turn to activate MCTS planning (default: 1) */
  planningTurn?: number
  /** Getter for the user's original message (task anchor) */
  getUserMessage: () => string | null
  /** Callback to receive the planning result */
  onResult?: (result: MCTSPlanResult) => void
}

/**
 * MCTS Planning Hook — on the configured turn, explores multiple candidate
 * approaches via lightweight model, filters junk, injects all surviving
 * seeds as inspiration for the main model.
 */
export function createMCTSPlanningHook(opts: MCTSPlanningHookOpts): PreTurnRuntimeHook {
  const vault = new AnchorVault()
  const planner = new MCTSPlanner({
    explore: opts.explore,
    branches: opts.branches ?? 3,
  })
  const planningTurn = opts.planningTurn ?? 1
  let sealed: SealedAnchor | null = null
  let hasRun = false

  return {
    phase: 'preTurn',
    name: 'mcts-planning',
    async run(ctx: RuntimeHookContext) {
      if (hasRun || ctx.snapshot.turn !== planningTurn) return
      hasRun = true

      const userMsg = opts.getUserMessage()
      if (!userMsg) return
      sealed = vault.seal(userMsg)

      const result = await planner.plan(sealed.original, sealed.phrases)
      opts.onResult?.(result)

      if (result.allJunk) {
        ctx.effects.injectUserMessage(
          '[mcts-seeds] WARNING: All explored paths are pure echo of the task wording. ' +
          'Consider reframing at a higher level of abstraction.',
        )
      } else {
        const seedList = result.seeds
          .map((s, i) => `- Seed ${i + 1}: ${s.text}`)
          .join('\n')
        ctx.effects.injectUserMessage(
          `[mcts-seeds] 以下是从不同角度生成的探索路径，供参考：\n${seedList}`,
        )
      }
    },
  }
}
