import type { CoordinatorRun, DelegationRequest } from './coordinator.js'
import type { AggregationPolicy } from './work-order.js'
import { parseTeamTaskDrafts, hasOverlappingFiles, type TeamTaskDraft } from './team-plan.js'

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
  return tasks.map((task, index) => ({
    parentTurnId: `${parentTurnId}:${task.id || index}`,
    objective: buildExecutionObjective(task),
    kind: task.kind,
    profile: task.profile,
    scope: { files: task.files },
  }))
}

export async function runTeamSkeleton(input: TeamRunInput, deps: TeamOrchestratorDeps): Promise<TeamRunSummary> {
  const maxParallel = Math.max(1, Math.min(input.maxParallel ?? 3, 5))
  const planned = input.mode === 'standard' && input.planMarkdown
    ? parseTeamTaskDrafts(input.planMarkdown)
    : []

  if (input.mode === 'max') {
    return {
      mode: input.mode,
      planned,
      dispatched: 0,
      blocked: ['max mode skeleton stops after planning brief; planner-worker fanout is a later phase'],
      packet: 'team max skeleton: planning-first mode is not auto-dispatching execution workers yet.',
    }
  }

  const { selected, blocked } = selectDispatchableTeamTasks(planned, maxParallel)
  if (selected.length === 0) {
    return {
      mode: input.mode,
      planned,
      dispatched: 0,
      blocked,
      packet: blocked.length > 0 ? `team skeleton blocked:\n${blocked.join('\n')}` : 'team skeleton: no task drafts found to dispatch.',
    }
  }

  const requests = teamTasksToDelegationRequests(selected, input.parentTurnId ?? 'team')
  const run = await deps.delegateBatch(requests, 'all_required', input.abortSignal)

  return {
    mode: input.mode,
    planned,
    dispatched: requests.length,
    blocked,
    packet: run.packet,
    run,
  }
}
