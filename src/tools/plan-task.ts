import type { Tool, ToolCallParams } from './types.js'
import { decomposeObjective, renderTaskGraphSummary } from '../agent/task-planner.js'
import { taskGraphToUnifiedPlan, unifiedPlanToTeamTasks, serializeUnifiedPlan, renderUnifiedPlanSummary, validateUnifiedPlan } from '../agent/unified-plan.js'
import { runTeamSkeleton } from '../agent/team-orchestrator.js'
import type { DelegationCoordinator } from '../agent/coordinator.js'
import type { TeamOrchestratorDeps, TeamRunInput } from '../agent/team-orchestrator.js'

export function createPlanTaskTool(deps: {
  getCoordinator: () => DelegationCoordinator | null
  getSessionTurn?: () => number | undefined
  getSessionId?: () => string | undefined
  /** Optional: pass through telemetry hooks from bootstrap. */
  recordTeamWaveTelemetry?: TeamOrchestratorDeps['recordTeamWaveTelemetry']
  recordTeamSchedulerShadow?: TeamOrchestratorDeps['recordTeamSchedulerShadow']
}): Tool {
  return {
    definition: {
      name: 'plan_task',
      description: `Decompose a high-level objective into a TaskGraph DAG and optionally execute it wave-by-wave.

Use for multi-step work that benefits from structured planning (refactors, feature work, verification pipelines).
Set execute: true to run the plan through the team orchestrator (same execution path as team_orchestrate).

Output is a UnifiedPlan JSON — pass it to team_orchestrate's planJson parameter for multi-wave continuation.`,
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

      // Step 1: decompose into TaskGraph
      const graph = decomposeObjective({ objective, files })

      // Step 2: convert to UnifiedPlan
      const plan = taskGraphToUnifiedPlan(graph)

      // Step 3: validate
      const validation = validateUnifiedPlan(plan)
      if (!validation.valid) {
        const errors = [...validation.errors, ...validation.nodeErrors.map(ne => `[${ne.nodeId}] ${ne.error}`)]
        return {
          content: `Plan validation failed:\n${errors.map(e => `  - ${e}`).join('\n')}\n\n${renderTaskGraphSummary(graph)}`,
          isError: true,
        }
      }

      if (params.input.execute !== true) {
        // Return JSON + human-readable summary
        const json = serializeUnifiedPlan(plan)
        return {
          content: `${renderUnifiedPlanSummary(plan)}\n\n---\n## UnifiedPlan JSON (pass to team_orchestrate as planJson)\n\`\`\`json\n${json}\n\`\`\``,
        }
      }

      // Step 4: execute via team orchestrator
      const coordinator = deps.getCoordinator()
      if (!coordinator) {
        return {
          content: `${renderUnifiedPlanSummary(plan)}\n\nError: coordinator not available for execution`,
          isError: true,
        }
      }

      const tasks = unifiedPlanToTeamTasks(plan)
      const input: TeamRunInput = {
        mode: 'standard',
        objective,
        tasks,
        maxParallel: 3,
        parentTurnId: `plan:${params.toolUseId ?? Date.now()}`,
        abortSignal: params.abortSignal,
      }

      const orchestratorDeps: TeamOrchestratorDeps = {
        delegateBatch: (requests, policy, abortSignal, onProgress) =>
          coordinator.delegateBatch(requests, policy, abortSignal, onProgress),
        recordTeamWaveTelemetry: deps.recordTeamWaveTelemetry,
        recordTeamSchedulerShadow: deps.recordTeamSchedulerShadow,
        sessionId: deps.getSessionId?.(),
      }

      try {
        const summary = await runTeamSkeleton(input, orchestratorDeps)
        return { content: `${renderUnifiedPlanSummary(plan)}\n\n${summary.packet}` }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        return { content: `${renderUnifiedPlanSummary(plan)}\n\nExecution failed: ${msg}`, isError: true }
      }
    },

    requiresApproval: () => true,
    isConcurrencySafe: () => false,
    isEnabled: () => true,
  }
}
