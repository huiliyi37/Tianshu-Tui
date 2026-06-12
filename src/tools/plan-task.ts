import type { Tool, ToolCallParams } from './types.js'
import { decomposeObjective, renderTaskGraphSummary } from '../agent/task-planner.js'
import { executePlan } from '../agent/plan-executor.js'
import type { DelegationCoordinator } from '../agent/coordinator.js'

export function createPlanTaskTool(deps: {
  getCoordinator: () => DelegationCoordinator | null
  getSessionTurn?: () => number | undefined
}): Tool {
  return {
    definition: {
      name: 'plan_task',
      description: `Decompose a high-level objective into a TaskGraph DAG and optionally execute it wave-by-wave.

Use for multi-step work that benefits from structured planning (refactors, feature work, verification pipelines).
Set execute: true to run the plan through delegate_batch.`,
      input_schema: {
        type: 'object',
        properties: {
          objective: { type: 'string', description: 'High-level goal to decompose' },
          files: {
            type: 'array',
            items: { type: 'string' },
            description: 'Optional scope files',
          },
          execute: { type: 'boolean', description: 'Execute the plan after generation (default false)' },
        },
        required: ['objective'],
      },
    },

    async execute(params: ToolCallParams) {
      const objective = String(params.input.objective ?? '').trim()
      if (!objective) {
        return { content: 'Error: objective is required', isError: true }
      }

      const files = Array.isArray(params.input.files)
        ? (params.input.files as string[]).filter(f => typeof f === 'string')
        : undefined

      const graph = decomposeObjective({ objective, files })
      const summary = renderTaskGraphSummary(graph)

      if (params.input.execute !== true) {
        return { content: `${summary}\n\nSet execute: true to run this plan.` }
      }

      const coordinator = deps.getCoordinator()
      if (!coordinator) {
        return { content: `${summary}\n\nError: coordinator not available for execution`, isError: true }
      }

      const turn = deps.getSessionTurn?.() ?? 0
      const result = await executePlan(coordinator, graph, {
        parentTurnId: `plan:${params.toolUseId ?? Date.now()}`,
        sessionTurn: turn,
      })

      return { content: result.summary }
    },

    requiresApproval: () => true,
    isConcurrencySafe: () => false,
    isEnabled: () => true,
  }
}
