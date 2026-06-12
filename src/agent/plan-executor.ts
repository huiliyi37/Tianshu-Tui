/**
 * PlanExecutor — plan-then-execute loop with validation and refinement.
 *
 * **DEPRECATED**: Plan execution now flows through `runTeamSkeleton` in
 * `team-orchestrator.ts`. `plan_task` converts its TaskGraph to a UnifiedPlan
 * and dispatches via the same execution path as `team_orchestrate`.
 *
 * This file is retained as a compatibility re-export. New code should use
 * `runTeamSkeleton` from `team-orchestrator.ts`.
 *
 * Converts a TaskGraph into DelegationRequest batches (wave by wave),
 * executes via coordinator, and refines the plan when tasks fail.
 *
 * @deprecated Use `runTeamSkeleton` from `./team-orchestrator.js` instead.
 */

import type { DelegationCoordinator, DelegationRequest, CoordinatorRun } from './coordinator.js'
import { refinePlanAfterWave, groupIntoWaves, renderTaskGraphSummary } from './task-planner.js'
import type { TaskGraph, TaskGraphNode } from './task-graph.js'

export interface PlanExecuteOptions {
  parentTurnId: string
  sessionTurn?: number
  reviewDepth?: number
  maxWaves?: number
  abortSignal?: AbortSignal
}

export interface PlanExecuteResult {
  graph: TaskGraph
  wavesExecuted: number
  completedTaskIds: string[]
  failedTaskIds: string[]
  runs: CoordinatorRun[]
  summary: string
}

function nodeToRequest(node: TaskGraphNode, opts: PlanExecuteOptions): DelegationRequest {
  return {
    parentTurnId: `${opts.parentTurnId}:${node.id}`,
    objective: node.objective,
    kind: node.kind,
    profile: node.profile,
    scope: { files: node.files },
    reviewDepth: opts.reviewDepth,
    sessionTurn: opts.sessionTurn,
    dependencies: node.dependsOn,
    groupId: node.id,
    riskTier: node.riskTier,
  }
}

/**
 * Execute a TaskGraph wave-by-wave through the coordinator.
 * On failure, refines remaining plan and continues (plan-validate-refine loop).
 */
export async function executePlan(
  coordinator: DelegationCoordinator,
  initialGraph: TaskGraph,
  options: PlanExecuteOptions,
): Promise<PlanExecuteResult> {
  let graph = initialGraph
  const completedTaskIds: string[] = []
  const failedTaskIds: string[] = []
  const runs: CoordinatorRun[] = []
  let wavesExecuted = 0
  const maxWaves = options.maxWaves ?? 20

  while (wavesExecuted < maxWaves) {
    const waves = groupIntoWaves(graph)
    const pendingWave = waves.find(wave =>
      wave.some(id => !completedTaskIds.includes(id) && !failedTaskIds.includes(id)),
    )
    if (!pendingWave) break

    const pendingIds = pendingWave.filter(id => !completedTaskIds.includes(id) && !failedTaskIds.includes(id))
    const requests = pendingIds
      .map(id => graph.nodes.find((n: TaskGraphNode) => n.id === id)!)
      .filter(Boolean)
      .map(node => nodeToRequest(node, options))

    if (requests.length === 0) break

    const batchRun = await coordinator.delegateBatch(requests, 'primary_decides', options.abortSignal)
    runs.push(batchRun)
    wavesExecuted++

    for (const id of pendingIds) {
      const prefix = `${options.parentTurnId}:${id}`
      const matching = batchRun.results.find(r =>
        r.workOrderId.includes(prefix) || r.workOrderId.endsWith(`:${id}`),
      )
      if (matching && matching.status === 'passed') {
        completedTaskIds.push(id)
      } else {
        failedTaskIds.push(id)
      }
    }

    if (failedTaskIds.length > 0) {
      graph = refinePlanAfterWave(graph, completedTaskIds, failedTaskIds)
    }

    // Stop if all tasks in graph are accounted for
    const allDone = graph.nodes.every((n: TaskGraphNode) => completedTaskIds.includes(n.id) || failedTaskIds.includes(n.id))
    if (allDone) break
  }

  const summary = [
    renderTaskGraphSummary(graph),
    '',
    `Executed ${wavesExecuted} wave(s)`,
    `Completed: ${completedTaskIds.length}/${graph.nodes.length}`,
    failedTaskIds.length > 0 ? `Failed: ${failedTaskIds.join(', ')}` : 'All tasks passed',
  ].join('\n')

  return { graph, wavesExecuted, completedTaskIds, failedTaskIds, runs, summary }
}
