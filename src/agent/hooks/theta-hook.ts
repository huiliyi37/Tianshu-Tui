import type { PostToolRuntimeHook } from '../runtime-hooks.js'
import { advanceThetaCounter, completeTheta, tickTheta, getThetaPhase } from '../star-event.js'
import type { ThetaState, ThetaPhase } from '../star-event.js'

export interface ThetaRuntimeHookDeps {
  getThetaState: () => ThetaState
  setThetaState: (state: ThetaState) => void
}

/** Tools that modify source files — only these should trigger theta checks. */
const FILE_WRITING_TOOLS = new Set([
  'write_file',
  'edit_file',
  'hash_edit',
  'apply_patch',
])

export function createThetaRuntimeHook(deps: ThetaRuntimeHookDeps): PostToolRuntimeHook {
  return {
    phase: 'postTool',
    name: 'theta-runtime',
    run(ctx, tool) {
      // Only trigger theta checks when a file-writing tool was used.
      // Periodic (turn-based) tsc scans are removed — the agent already
      // runs tsc explicitly before commits, and background scanning
      // wastes CPU (especially with multiple parallel sessions).
      const toolName = tool.name
      if (!toolName || !FILE_WRITING_TOOLS.has(toolName)) return

      const sensorium = ctx.snapshot.sensorium
      const vigor = ctx.snapshot.vigor

      // Phase modulation: vigor and complexity control phase advance rate.
      // High vigor = preserve flow (slower phase). High complexity = need checks (faster phase).
      const phaseInput = (sensorium && vigor) ? {
        vigor: vigor.vigor,
        complexity: sensorium.complexity,
      } : undefined

      const advanced = advanceThetaCounter(deps.getThetaState(), phaseInput)
      deps.setThetaState(advanced)

      if (!sensorium || sensorium.complexity <= 0.5) return

      // Phase gate: theta checks only fire in retrieval phase
      // This prevents disrupting the agent during active encoding (flow state).
      if (!tickTheta(advanced, ctx.snapshot.turn)) return

      const phase: ThetaPhase = getThetaPhase(advanced)
      ctx.effects.requestThetaCheck(`theta-cycle:${phase}`)
      deps.setThetaState(completeTheta(advanced))
    },
  }
}
