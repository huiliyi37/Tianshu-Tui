import type { CoordinatorRun, DelegationRequest } from './coordinator.js'
import type { AggregationPolicy } from './work-order.js'
import { parseTeamTaskDrafts, parseTeamTasks, buildUnifiedTeamPlan, hasOverlappingFiles, type TeamTaskDraft, type TeamTask, type UnifiedTeamPlan } from './team-plan.js'
import { groupTeamTasks, type TeamWave } from './team-grouping.js'
import { buildPlannerObjective, mergePerspectives, normalizePerspective, parsePerspectiveResult, type TeamPerspectivePlan } from './team-perspectives.js'

export interface TeamOrchestratorDeps {
  delegateBatch(
    requests: DelegationRequest[],
    policy?: AggregationPolicy,
    abortSignal?: AbortSignal,
    onProgress?: (completed: number, total: number) => void,
  ): Promise<CoordinatorRun>
}

export interface TeamRunInput {
  mode: 'standard' | 'max'
  objective: string
  planMarkdown?: string
  maxParallel?: number
  parentTurnId?: string
  abortSignal?: AbortSignal
}

export interface TeamRunSummary {
  mode: 'standard' | 'max'
  planned: TeamTaskDraft[]
  tasks: TeamTask[]
  waves: TeamWave[]
  dispatched: number
  blocked: string[]
  packet: string
  run?: CoordinatorRun
}

function isFileScopedPatcher(task: TeamTaskDraft): boolean {
  return task.profile === 'patcher' && task.files.length > 0
}

function buildExecutionObjective(task: TeamTaskDraft): string {
  if (task.profile !== 'patcher') return task.objective
  return `你是天梁执行者。只执行本 task，不扩展范围，不重写计划。\n\n${task.objective}`
}

export function selectDispatchableTeamTasks(tasks: TeamTaskDraft[], maxParallel = 3): { selected: TeamTaskDraft[]; blocked: string[] } {
  const selected: TeamTaskDraft[] = []
  const blocked: string[] = []
  const selectedPatchers: TeamTaskDraft[] = []

  for (const task of tasks) {
    if (selected.length >= maxParallel) {
      blocked.push(`${task.id}: deferred after maxParallel=${maxParallel}`)
      continue
    }

    if (task.profile === 'patcher' && task.files.length === 0) {
      blocked.push(`${task.id}: patcher task has no file scope`)
      continue
    }

    // Block patcher tasks whose file scope intersects an already-selected
    // patcher (any shared file, not just identical sets) — they must serialize
    // to avoid parallel writes to the same file.
    if (isFileScopedPatcher(task)) {
      const conflict = selectedPatchers.find(prev => hasOverlappingFiles(prev, task))
      if (conflict) {
        blocked.push(`${task.id}: overlapping patcher file scope with ${conflict.id}; serialize later`)
        continue
      }
      selectedPatchers.push(task)
    }

    selected.push(task)
  }

  return { selected, blocked }
}

export function teamTasksToDelegationRequests(tasks: TeamTaskDraft[], parentTurnId = 'team'): DelegationRequest[] {
  return tasks.map((task, index) => {
    const stableId = `team:${task.id || index}`
    // Propagate dependencies from enriched TeamTask if present
    let deps: string[] | undefined
    if ('dependsOn' in task && Array.isArray((task as any).dependsOn) && (task as any).dependsOn.length > 0) {
      deps = (task as any).dependsOn.map((d: string) => `team:${d}`)
    }
    return {
      parentTurnId: `${parentTurnId}:${stableId}`,
      objective: buildExecutionObjective(task),
      kind: task.kind,
      profile: task.profile,
      scope: { files: task.files },
      dependencies: deps,
    }
  })
}

/** Convert wave task IDs to DelegationRequests using enriched task map.
 *  Uses stable `team:${taskId}` as parentTurnId so WorkOrder.dependencies
 *  (which reference these same IDs) can be resolved by WorkOrderQueue. */
function waveToRequests(wave: TeamWave, taskMap: Map<string, TeamTask>, parentTurnId: string): DelegationRequest[] {
  return wave.taskIds
    .map(id => taskMap.get(id))
    .filter((t): t is TeamTask => Boolean(t))
    .map(task => {
      const stableId = `team:${task.id}`
      const deps = task.dependsOn.length > 0
        ? task.dependsOn.map(d => `team:${d}`)
        : undefined
      const req: DelegationRequest = {
        parentTurnId: `${parentTurnId}:${stableId}`,
        objective: buildExecutionObjective(task),
        kind: task.kind,
        profile: task.profile,
        scope: { files: task.files },
        dependencies: deps,
      }
      return req
    })
}

export async function runTeamSkeleton(input: TeamRunInput, deps: TeamOrchestratorDeps): Promise<TeamRunSummary> {
  const maxParallel = Math.max(1, Math.min(input.maxParallel ?? 3, 5))

  // Parse plan if available
  const drafts = input.mode === 'standard' && input.planMarkdown
    ? parseTeamTaskDrafts(input.planMarkdown)
    : []
  const enrichedTasks = input.planMarkdown ? parseTeamTasks(input.planMarkdown) : []

  // max mode: fan out 3 perspective planners, merge deterministically, then
  // group + dispatch the first wave like standard mode.
  if (input.mode === 'max') {
    const perspectives = ['tianquan', 'tianfu', 'tianxuan'] as const
    const plannerRequests: DelegationRequest[] = perspectives.map(perspective => ({
      parentTurnId: `team:planner-${perspective}`,
      objective: buildPlannerObjective(perspective, input.objective),
      kind: 'plan',
      profile: 'reviewer',
      scope: {},
    }))
    const plannerRun = await deps.delegateBatch(plannerRequests, 'all_required', input.abortSignal)

    const planFor = (perspective: TeamPerspectivePlan['perspective']): TeamPerspectivePlan => {
      const result = plannerRun.results.find(r => r.workOrderId.includes(`planner-${perspective}`))
      return result ? parsePerspectiveResult(perspective, result) : normalizePerspective(perspective, {})
    }
    const merged = mergePerspectives(planFor('tianquan'), planFor('tianfu'), planFor('tianxuan'))
    const mergedTasks = merged.tasks
    const waves = groupTeamTasks(mergedTasks)
    const taskMap = new Map(mergedTasks.map(t => [t.id, t]))

    if (waves.length === 0) {
      return {
        mode: input.mode,
        planned: [],
        tasks: mergedTasks,
        waves: [],
        dispatched: 0,
        blocked: ['max planning produced no dispatchable tasks'],
        packet: 'team max: planners returned no tasks to dispatch.',
        run: plannerRun,
      }
    }

    const firstWave = waves[0]!
    const remainingBlocked = waves.slice(1).map(w =>
      `${w.taskIds.join(', ')}: waiting for wave ${w.id} to complete`
    )
    const requests = waveToRequests(firstWave, taskMap, input.parentTurnId ?? 'team')
    if (requests.length === 0) {
      return {
        mode: input.mode,
        planned: [],
        tasks: mergedTasks,
        waves,
        dispatched: 0,
        blocked: remainingBlocked,
        packet: 'team max: first wave produced no dispatchable requests.',
        run: plannerRun,
      }
    }

    const run = await deps.delegateBatch(requests, 'all_required', input.abortSignal)
    return {
      mode: input.mode,
      planned: [],
      tasks: mergedTasks,
      waves,
      dispatched: requests.length,
      blocked: remainingBlocked,
      packet: run.packet,
      run,
    }
  }

  // Group tasks into waves
  const waves = groupTeamTasks(enrichedTasks)
  const taskMap = new Map(enrichedTasks.map(t => [t.id, t]))

  // Dispatch first wave only (subsequent waves need prior wave results)
  if (waves.length === 0) {
    // Fallback to legacy behavior for unstructured plans
    const { selected, blocked } = selectDispatchableTeamTasks(drafts, maxParallel)
    if (selected.length === 0) {
      return {
        mode: input.mode,
        planned: drafts,
        tasks: enrichedTasks,
        waves: [],
        dispatched: 0,
        blocked,
        packet: blocked.length > 0 ? `team skeleton blocked:\n${blocked.join('\n')}` : 'team skeleton: no task drafts found to dispatch.',
      }
    }

    const requests = teamTasksToDelegationRequests(selected, input.parentTurnId ?? 'team')
    const run = await deps.delegateBatch(requests, 'all_required', input.abortSignal)

    return {
      mode: input.mode,
      planned: drafts,
      tasks: enrichedTasks,
      waves: [],
      dispatched: requests.length,
      blocked,
      packet: run.packet,
      run,
    }
  }

  // Wave-based dispatch: dispatch first wave
  const firstWave = waves[0]!
  const remainingBlocked = waves.slice(1).map(w =>
    `${w.taskIds.join(', ')}: waiting for wave ${w.id} to complete`
  )

  const requests = waveToRequests(firstWave, taskMap, input.parentTurnId ?? 'team')
  if (requests.length === 0) {
    return {
      mode: input.mode,
      planned: drafts,
      tasks: enrichedTasks,
      waves,
      dispatched: 0,
      blocked: remainingBlocked,
      packet: 'team skeleton: first wave produced no dispatchable requests.',
    }
  }

  const run = await deps.delegateBatch(requests, 'all_required', input.abortSignal)

  return {
    mode: input.mode,
    planned: drafts,
    tasks: enrichedTasks,
    waves,
    dispatched: requests.length,
    blocked: remainingBlocked,
    packet: run.packet,
    run,
  }
}

/** Re-export buildUnifiedTeamPlan for convenience. */
export { buildUnifiedTeamPlan }
export type { UnifiedTeamPlan, TeamWave }
