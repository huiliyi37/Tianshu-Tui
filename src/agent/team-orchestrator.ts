import type { CoordinatorRun, DelegationRequest } from './coordinator.js'
import type { AggregationPolicy } from './work-order.js'
import { matchDomain } from './star-domain.js'
import { parseTeamTaskDrafts, parseTeamTasks, buildUnifiedTeamPlan, hasOverlappingFiles, type TeamTaskDraft, type TeamTask, type UnifiedTeamPlan } from './team-plan.js'
import { groupTeamTasks, type TeamWave } from './team-grouping.js'
import { buildTeamWaveTelemetry, type TeamWaveTelemetry } from './team-wave-telemetry.js'
import { createTeamSchedulerBandit, parallelismForTeamSchedulerArm, recommendTeamSchedulerArm, summarizeTeamSchedulerBandit, teamSchedulerArmForParallelism, type TeamSchedulerBanditState, type TeamSchedulerContext } from './team-scheduler-bandit.js'
import { applyTeamSchedulerInfluence, evaluateTeamSchedulerGate } from './team-scheduler-gate.js'
import { buildTeamSchedulerShadowEvent, type TeamSchedulerShadowEvent } from './team-scheduler-shadow.js'
import { buildGatedInfluenceAuditEvent, type GatedInfluenceAuditEvent } from './gated-influence-audit.js'
import { buildPlannerObjective, foldVerificationIntoTasks, mergePerspectivesByRole, normalizePerspective, parsePerspectiveResult, type MergedPlan, type TeamPerspectivePlan } from './team-perspectives.js'
import { detectOverlapWithoutOrder } from './unified-plan.js'
import { selectExpertSet } from './expert-router.js'
import { loadTeamPlanSkeleton, saveTeamPlanSkeleton, type TeamPlanCacheStore } from './team-plan-cache.js'

export interface TeamOrchestratorDeps {
  delegateBatch(
    requests: DelegationRequest[],
    policy?: AggregationPolicy,
    abortSignal?: AbortSignal,
    onProgress?: (completed: number, total: number) => void,
  ): Promise<CoordinatorRun>
  recordTeamWaveTelemetry?: (event: TeamWaveTelemetry) => void
  recordTeamSchedulerShadow?: (event: TeamSchedulerShadowEvent) => void
  recordGatedInfluenceAudit?: (event: GatedInfluenceAuditEvent) => void
  teamSchedulerState?: TeamSchedulerBanditState
  sessionId?: string
  /** Track 2: team max 计划骨架缓存 — 命中则跳过三视角 planner fanout。 */
  planCacheStore?: TeamPlanCacheStore
}

export interface TeamRunInput {
  mode: 'standard' | 'max'
  objective: string
  planMarkdown?: string
  /** Pre-parsed team tasks — skip Markdown parsing entirely.
   *  When provided, both planMarkdown and max planner fanout are bypassed.
   *  This is the bridge for plan_task → team_orchestrate integration. */
  tasks?: TeamTask[]
  maxParallel?: number
  parentTurnId?: string
  abortSignal?: AbortSignal
  /** Explicit opt-in. When false/omitted, scheduler suggestions are shadow-only. */
  teamSchedulerBanditEnabled?: boolean
  /** Dispatch this wave index (default 0). Main controller increments after
   *  integrating each wave's diffs to drive multi-wave execution. */
  fromWave?: number
  /** T9 P3: real-time worker activity upstream — injected into every
   *  dispatched DelegationRequest so the TeamPanel can show live progress. */
  onActivity?: DelegationRequest['onActivity']
  /** Fleet viz: invoked once the wave plan is computed but BEFORE workers are
   *  dispatched, so the UI can render the wave/task DAG (all waiting) up front
   *  and overlay running state from live worker activity. The summary carries
   *  waves+tasks but no `run`. */
  onPlanReady?: (summary: TeamRunSummary, fromWave: number) => void
  /** Results from the immediately prior wave. Used by dispatchWaveAt to
   *  block tasks whose dependencies failed. Undefined for wave 0. */
  priorResults?: import('../agent/work-order.js').WorkerResult[]
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
  /** Track 2: true when the max-mode planner fanout was skipped via plan cache. */
  planCacheHit?: boolean
  /** Council merge output (max mode, first wave only — absent on cache hits and
   *  standard mode). Surfaces the perspective work that would otherwise be lost:
   *  conflicts, risk ledger, deferred/rejected alternatives, and the orthogonal
   *  shards folded into the executable graph (augmented). Advisory only. */
  planMerge?: Pick<MergedPlan, 'conflicts' | 'risks' | 'deferred' | 'rejected' | 'augmented'>
  /** Non-blocking shard advisories on the merged task graph (max mode): shards
   *  that touch the same file without an explicit dependsOn ordering. */
  advisories?: string[]
}

function isFileScopedPatcher(task: TeamTaskDraft): boolean {
  return task.profile === 'patcher' && task.files.length > 0
}

function buildExecutionObjective(task: TeamTaskDraft): string {
  if (task.profile !== 'patcher') return task.objective
  return `你是天梁执行者。只执行本 task，不扩展范围，不重写计划。\n\n${task.objective}`
}

function taskAuthority(task: TeamTaskDraft): string {
  if (task.profile === 'patcher') return 'tianliang'
  if (task.profile === 'reviewer' || task.profile === 'adversarial_verifier') return 'tianquan'
  return matchDomain(task.objective) ?? 'tianliang'
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
      authority: taskAuthority(task),
      riskTier: 'riskTier' in task ? (task as TeamTask).riskTier : undefined,
    }
  })
}

function waveToRequests(wave: TeamWave, taskMap: Map<string, TeamTask>, parentTurnId: string): DelegationRequest[] {
  return wave.taskIds
    .map(id => taskMap.get(id))
    .filter((t): t is TeamTask => Boolean(t))
    .map(task => {
      const stableId = `team:${task.id}`
      const deps = task.dependsOn.length > 0
        ? task.dependsOn.map(d => `team:${d}`)
        : undefined
      return {
        parentTurnId: `${parentTurnId}:${stableId}`,
        objective: buildExecutionObjective(task),
        kind: task.kind,
        profile: task.profile,
        scope: { files: task.files },
        dependencies: deps,
        authority: taskAuthority(task),
        riskTier: 'riskTier' in task ? (task as TeamTask).riskTier : undefined,
      }
    })
}

interface WaveDispatchContext {
  taskMap: Map<string, TeamTask>
  tasks: TeamTask[]
  planned: TeamTaskDraft[]
  input: TeamRunInput
  deps: TeamOrchestratorDeps
}

function taskFiles(task: TeamTask): string[] {
  return task.touchSet.length > 0 ? task.touchSet : task.files
}

/**
 * Extract the task ID from a work order ID.
 *
 * workOrderId format is `prefix:taskId` (e.g. `"team:T1"`). The task ID is the
 * last segment after `:`. If there is no colon, the whole string is returned
 * as-is (graceful fallback for edge-case formats).
 *
 * This replaces the inline `lastIndexOf(':')` extraction that was an implicit
 * contract — now the format is explicit and testable.
 */
export function extractTaskIdFromWorkOrderId(woId: string): string {
  return woId.includes(':') ? woId.slice(woId.lastIndexOf(':') + 1) : woId
}

function buildSchedulerContext(wave: TeamWave, waves: TeamWave[], taskMap: Map<string, TeamTask>): TeamSchedulerContext {
  const waveTasks = wave.taskIds.map(id => taskMap.get(id)).filter((task): task is TeamTask => Boolean(task))
  const writeTasks = waveTasks.filter(task => !(task.profile === 'code_scout' || task.profile === 'doc_scout' || (task.profile === 'reviewer' && task.kind === 'review')))
  const readTasks = waveTasks.length - writeTasks.length
  const moduleRoots = new Set(waveTasks.flatMap(task => taskFiles(task).map(file => file.split('/').slice(0, 2).join('/'))).filter(Boolean))
  const highRiskCount = waveTasks.filter(task => task.riskTier === 'high').length
  const maxDeps = Math.max(0, ...waveTasks.map(task => task.dependsOn.length))
  return {
    taskCount: Math.min(1, waveTasks.length / 5),
    writeTaskCount: Math.min(1, writeTasks.length / 5),
    readTaskCount: Math.min(1, readTasks / 5),
    dependencyDepth: Math.min(1, maxDeps / Math.max(1, waves.length)),
    crossModuleScore: Math.min(1, Math.max(0, moduleRoots.size - 1) / 4),
    highRiskRatio: waveTasks.length > 0 ? highRiskCount / waveTasks.length : 0,
    historicalReward: 0,
    scopeLeakRate: 0,
  }
}

function resolveSchedulerState(deps: TeamOrchestratorDeps): TeamSchedulerBanditState {
  if (deps.teamSchedulerState) return deps.teamSchedulerState
  return summarizeTeamSchedulerBandit(createTeamSchedulerBandit())
}

function applySchedulerToWave(wave: TeamWave, waves: TeamWave[], ctx: WaveDispatchContext): { wave: TeamWave; blocked: string[] } {
  const ruleParallelism = Math.max(1, Math.min(wave.parallelLimit, wave.taskIds.length, 5))
  const bandit = createTeamSchedulerBandit()
  const schedulerContext = buildSchedulerContext(wave, waves, ctx.taskMap)
  const state = resolveSchedulerState(ctx.deps)
  const shadowRecommendation = recommendTeamSchedulerArm(bandit, schedulerContext)
  const bestObservedArm = Object.entries(state.arms)
    .filter(([, stat]) => stat.samples > 0)
    .sort((a, b) => b[1].averageReward - a[1].averageReward)[0]?.[0]
  const recommended = { ...shadowRecommendation, arm: (bestObservedArm ?? shadowRecommendation.arm) as typeof shadowRecommendation.arm }
  const candidateAvg = state.arms[recommended.arm]?.averageReward ?? 0
  const baselineAvg = state.arms[teamSchedulerArmForParallelism(ruleParallelism)]?.averageReward ?? 0
  const decision = evaluateTeamSchedulerGate({
    state,
    candidateArm: recommended.arm,
    ruleParallelism,
    ruleBaselineReward: baselineAvg,
    recentFalseGreenRate: 0,
    ruleAgreementRate: parallelismForTeamSchedulerArm(recommended.arm) <= ruleParallelism ? 1 : 0,
    hardGateSafe: wave.risk !== 'high' || parallelismForTeamSchedulerArm(recommended.arm) <= 1,
    featureFlagEnabled: ctx.input.teamSchedulerBanditEnabled === true,
  })
  const parallelLimit = applyTeamSchedulerInfluence(ruleParallelism, recommended.arm, decision)
  try {
    ctx.deps.recordTeamSchedulerShadow?.(buildTeamSchedulerShadowEvent({
      sessionId: ctx.deps.sessionId ?? 'unknown',
      objective: ctx.input.objective,
      waveId: wave.id,
      ruleParallelism,
      recommendedArm: recommended.arm,
      applied: decision.applied,
      gateOpen: decision.gateOpen,
      reason: `${decision.reason}; candidateAvg=${candidateAvg.toFixed(3)} baselineAvg=${baselineAvg.toFixed(3)}`,
    }))
  } catch {
    // Scheduler shadow must never affect dispatch.
  }
  try {
    ctx.deps.recordGatedInfluenceAudit?.(buildGatedInfluenceAuditEvent({
      source: 'team_scheduler_bandit',
      sessionId: ctx.deps.sessionId ?? 'unknown',
      targetId: wave.id,
      gateOpen: decision.gateOpen,
      applied: decision.applied,
      reason: decision.reason,
      evidenceWindow: {
        ...decision.evidenceWindow,
        candidateAverageReward: candidateAvg,
        baselineAverageReward: baselineAvg,
      },
      vetoSignals: decision.vetoSignals,
    }))
  } catch {
    // Audit telemetry must never affect dispatch.
  }

  if (parallelLimit >= wave.taskIds.length) return { wave: { ...wave, parallelLimit: ruleParallelism }, blocked: [] }
  const keptTaskIds = wave.taskIds.slice(0, parallelLimit)
  const deferredTaskIds = wave.taskIds.slice(parallelLimit)
  return {
    wave: { ...wave, taskIds: keptTaskIds, parallelLimit, reason: `${wave.reason}; scheduler ${decision.applied ? 'applied' : 'shadow'} ${recommended.arm}` },
    blocked: deferredTaskIds.map(id => `${id}: deferred by scheduler parallelLimit=${parallelLimit} within ${wave.id}`),
  }
}

async function dispatchWaveAt(
  waves: TeamWave[],
  waveIndex: number,
  ctx: WaveDispatchContext,
): Promise<TeamRunSummary> {
  const fromWave = Math.max(0, waveIndex)
  const { input, planned, tasks, taskMap, deps } = ctx
  if (waves.length === 0) {
    return { mode: input.mode, planned, tasks, waves: [], dispatched: 0, blocked: [], packet: 'team: no dispatchable waves.' }
  }
  if (fromWave >= waves.length) {
    return { mode: input.mode, planned, tasks, waves, dispatched: 0, blocked: [], packet: `team: all ${waves.length} waves dispatched.` }
  }

  const targetWave = waves[fromWave]!
  const scheduled = applySchedulerToWave(targetWave, waves, ctx)
  let dispatchWave = scheduled.wave
  const remainingBlocked = [
    ...scheduled.blocked,
    ...waves.slice(fromWave + 1).map(w => `${w.taskIds.join(', ')}: waiting for wave ${w.id} to complete`),
  ]

  // ── Cross-wave failure propagation ──────────────────────────────
  // Block tasks whose dependencies failed in a prior wave.
  const priorResults = input.priorResults
  const crossWaveBlocked: string[] = []
  if (priorResults && priorResults.length > 0) {
    const failedIds = new Set(
      priorResults
        .filter(r => r.status !== 'passed')
        .map(r => extractTaskIdFromWorkOrderId(r.workOrderId))
    )
    if (failedIds.size > 0) {
      // Return a new wave object with only non-blocked task IDs — never mutates
      // the original wave, guarding against future wave caching scenarios.
      const filteredTaskIds: string[] = []
      for (const taskId of dispatchWave.taskIds) {
        const task = taskMap.get(taskId)
        if (!task) { filteredTaskIds.push(taskId); continue }
        const failedDeps = (task.dependsOn ?? []).filter(depId => failedIds.has(depId))
        if (failedDeps.length > 0) {
          crossWaveBlocked.push(`${taskId}: blocked by prior wave failure (${failedDeps.join(', ')})`)
        } else {
          filteredTaskIds.push(taskId)
        }
      }
      dispatchWave = { ...dispatchWave, taskIds: filteredTaskIds }
    }
  }

  const requests = waveToRequests(dispatchWave, taskMap, input.parentTurnId ?? 'team')
  if (input.onActivity) for (const r of requests) r.onActivity = input.onActivity
  if (requests.length === 0) {
    return {
      mode: input.mode,
      planned,
      tasks,
      waves,
      dispatched: 0,
      blocked: [...remainingBlocked, ...crossWaveBlocked],
      packet: `team: wave ${targetWave.id} produced no dispatchable requests.`,
    }
  }

  // Fleet viz: surface the wave/task DAG before dispatch so the TUI can show
  // the plan (all waiting) immediately; running state is overlaid from live
  // worker activity. No `run` yet → all tasks render as waiting.
  if (input.onPlanReady) {
    input.onPlanReady({
      mode: input.mode,
      planned,
      tasks,
      waves,
      dispatched: requests.length,
      blocked: remainingBlocked,
      packet: `[wave ${fromWave + 1}/${waves.length}] dispatching ${requests.length} workers…`,
    }, fromWave)
  }

  const run = await deps.delegateBatch(requests, 'all_required', input.abortSignal)
  try {
    deps.recordTeamWaveTelemetry?.(buildTeamWaveTelemetry({
      sessionId: deps.sessionId ?? 'unknown',
      objective: input.objective,
      mode: input.mode,
      fromWave,
      wave: dispatchWave,
      waves,
      taskMap,
      run,
      dispatched: requests.length,
    }))
  } catch {
    // Telemetry must never affect dispatch.
  }
  return {
    mode: input.mode,
    planned,
    tasks,
    waves,
    dispatched: requests.length,
    blocked: [...remainingBlocked, ...crossWaveBlocked],
    packet: `[wave ${fromWave + 1}/${waves.length}] ${run.packet}`,
    run,
  }
}

export async function runTeamSkeleton(input: TeamRunInput, deps: TeamOrchestratorDeps): Promise<TeamRunSummary> {
  const maxParallel = Math.max(1, Math.min(input.maxParallel ?? 3, 5))

  // ── Fast path: pre-parsed tasks (plan_task → team_orchestrate bridge) ──
  if (input.tasks && input.tasks.length > 0) {
    const enrichedTasks = input.tasks
    const waves = groupTeamTasks(enrichedTasks)
    const taskMap = new Map(enrichedTasks.map(t => [t.id, t]))

    if (waves.length === 0) {
      return {
        mode: 'standard',
        planned: [],
        tasks: enrichedTasks,
        waves: [],
        dispatched: 0,
        blocked: ['pre-parsed tasks produced no dispatchable waves'],
        packet: 'team: pre-parsed tasks — no waves to dispatch.',
      }
    }

    return dispatchWaveAt(waves, input.fromWave ?? 0, {
      taskMap,
      tasks: enrichedTasks,
      planned: [],
      input,
      deps,
    })
  }

  const drafts = input.mode === 'standard' && input.planMarkdown
    ? parseTeamTaskDrafts(input.planMarkdown)
    : []
  const enrichedTasks = input.planMarkdown ? parseTeamTasks(input.planMarkdown) : []

  if (input.mode === 'max') {
    // Track 2 plan cache: a fresh skeleton for the same/similar objective
    // skips the 3-perspective planner fanout entirely. This also keeps wave
    // indices stable when the main controller re-enters per fromWave.
    const cached = loadTeamPlanSkeleton(deps.planCacheStore, input.objective, 'max')
    let mergedTasks: TeamTask[]
    let plannerRun: CoordinatorRun | undefined
    let planMerge: TeamRunSummary['planMerge']
    if (cached) {
      mergedTasks = cached.tasks
    } else {
      // Dynamic council: route the mission to a complementary expert set
      // (base + constraint + challenger + any matched specialist) instead of a
      // hardcoded trio. Planners use the dedicated `perspective_planner`
      // profile (read-only, NOT tierLock:'cheap') so the planning model routes
      // via workers.routing.planning and defaults to the strong tier — base
      // planner output is the executable shard graph, so planning quality
      // directly drives parallel-shard quality.
      const perspectives = selectExpertSet(input.objective)
      const plannerRequests: DelegationRequest[] = perspectives.map(perspective => ({
        parentTurnId: `team:planner-${perspective}`,
        objective: buildPlannerObjective(perspective, input.objective),
        kind: 'plan',
        profile: 'perspective_planner',
        scope: {},
        authority: perspective,
        onActivity: input.onActivity,
      }))
      plannerRun = await deps.delegateBatch(plannerRequests, 'all_required', input.abortSignal)

      const planFor = (perspective: string): TeamPerspectivePlan => {
        const result = plannerRun!.results.find(r => r.workOrderId.includes(`planner-${perspective}`))
        return result ? parsePerspectiveResult(perspective, result) : normalizePerspective(perspective, {})
      }
      const merged = mergePerspectivesByRole(perspectives.map(planFor))
      // Fold constraint-perspective verification gates into their tasks so the
      // review focusHint (which reads TeamTask.verification) sees them on every
      // wave, including waves resumed from the cached skeleton.
      mergedTasks = foldVerificationIntoTasks(merged.tasks, merged.verification)
      // Surface the council work that would otherwise be discarded — including
      // the orthogonal shards augment folded into the executable graph.
      planMerge = { conflicts: merged.conflicts, risks: merged.risks, deferred: merged.deferred, rejected: merged.rejected, augmented: merged.augmented }
      if (mergedTasks.length > 0) {
        saveTeamPlanSkeleton(deps.planCacheStore, { objective: input.objective, mode: 'max', tasks: mergedTasks })
      }
    }
    // Non-blocking advisory on the final merged graph (covers cached + fresh):
    // shards touching the same file without an explicit dependsOn ordering.
    const advisories = detectOverlapWithoutOrder(mergedTasks)
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
        ...(plannerRun ? { run: plannerRun } : {}),
        ...(cached ? { planCacheHit: true } : {}),
        ...(planMerge ? { planMerge } : {}),
        ...(advisories.length > 0 ? { advisories } : {}),
      }
    }

    const summary = await dispatchWaveAt(waves, input.fromWave ?? 0, {
      taskMap,
      tasks: mergedTasks,
      planned: [],
      input,
      deps,
    })
    return {
      ...summary,
      ...(cached ? { planCacheHit: true } : {}),
      ...(planMerge ? { planMerge } : {}),
      ...(advisories.length > 0 ? { advisories } : {}),
    }
  }

  const waves = groupTeamTasks(enrichedTasks)
  const taskMap = new Map(enrichedTasks.map(t => [t.id, t]))

  if (waves.length === 0) {
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
    if (input.onActivity) for (const r of requests) r.onActivity = input.onActivity
    const run = await deps.delegateBatch(requests, 'all_required', input.abortSignal)
    try {
      deps.recordTeamWaveTelemetry?.(buildTeamWaveTelemetry({
        sessionId: deps.sessionId ?? 'unknown',
        objective: input.objective,
        mode: input.mode,
        fromWave: input.fromWave ?? 0,
        wave: { id: `legacy-W${(input.fromWave ?? 0) + 1}`, taskIds: selected.map(task => task.id), reason: 'legacy unstructured plan dispatch', parallelLimit: maxParallel, risk: 'medium' },
        waves: [{ id: `legacy-W${(input.fromWave ?? 0) + 1}`, taskIds: selected.map(task => task.id), reason: 'legacy unstructured plan dispatch', parallelLimit: maxParallel, risk: 'medium' }],
        taskMap: new Map(selected.map(task => [task.id, {
          ...task,
          dependsOn: [],
          riskTier: 'medium' as const,
          touchSet: [...task.files],
          groupId: undefined,
          routeHint: undefined,
        }])),
        run,
        dispatched: requests.length,
      }))
    } catch {
      // Telemetry must never affect dispatch.
    }

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

  return dispatchWaveAt(waves, input.fromWave ?? 0, {
    taskMap,
    tasks: enrichedTasks,
    planned: drafts,
    input,
    deps,
  })
}

export { buildUnifiedTeamPlan }
export type { UnifiedTeamPlan, TeamWave }
