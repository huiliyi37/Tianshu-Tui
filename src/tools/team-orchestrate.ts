import { readFileSync } from 'node:fs'
import { z } from 'zod'
import type { CoordinatorRun, DelegationRequest } from '../agent/coordinator.js'
import { createCoordinatorReviewDeps } from '../agent/review-coordinator-deps.js'
import { isCrossModule, isFixContext, type ChangeSet } from '../agent/review-discipline.js'
import { routeReviewWorkflow } from '../agent/review-router.js'
import { runTeamSkeleton, type TeamRunSummary } from '../agent/team-orchestrator.js'
import { deserializeUnifiedPlan, unifiedPlanToTeamTasks, validateUnifiedPlan } from '../agent/unified-plan.js'
import { buildHistoricalTeamSchedulerState, type TeamSchedulerBanditState } from '../agent/team-scheduler-bandit.js'
import type { TeamSchedulerShadowEvent } from '../agent/team-scheduler-shadow.js'
import { persistGatedInfluenceAudit, type GatedInfluenceAuditEvent } from '../agent/gated-influence-audit.js'
import { buildTeamEpisodeFromStore, recordTeamEpisodeClosureFromStore } from '../agent/reward-loop.js'
import { formatTeamDelivery } from '../agent/team-episode.js'
import type { TeamWaveTelemetry } from '../agent/team-wave-telemetry.js'
import { buildTeamPanelModel, encodeTeamPanelModel } from '../tui/team-panel-model.js'
import type { AggregationPolicy } from '../agent/work-order.js'
import { validatePathSafe } from './path-validate.js'
import { createActivityStreamer, activityProgressLine } from './worker-activity-stream.js'
import type { WorkerActivityEvent } from '../agent/coordinator.js'
import type { Tool, ToolCallParams, ToolResult } from './types.js'

/** Coordinator surface the team tool needs. `delegateBatch` drives planner
 *  fanout + wave dispatch. `delegate` is optional until the review gate is
 *  enabled; Task-1 callers/tests may omit it. */
export interface TeamOrchestrateCoordinator {
  delegateBatch(
    requests: DelegationRequest[],
    policy?: AggregationPolicy,
    abortSignal?: AbortSignal,
    onProgress?: (completed: number, total: number) => void,
  ): Promise<CoordinatorRun>
  delegate?(request: DelegationRequest, abortSignal?: AbortSignal): Promise<CoordinatorRun>
  recordTeamWaveTelemetry?(event: TeamWaveTelemetry): void
  recordTeamWaveRewardClosure?(event: TeamWaveTelemetry): void
  recordTeamSchedulerShadow?(event: TeamSchedulerShadowEvent): void
  recordTeamSchedulerReward?(event: TeamWaveTelemetry): void
  recordGatedInfluenceAudit?(event: GatedInfluenceAuditEvent): void
  getTeamSchedulerState?: () => TeamSchedulerBanditState | undefined
  getTeamSchedulerRewardStore?: () => { saveBanditState?(kind: string, json: string): void; loadBanditStatesByPrefix?(prefix: string, limit?: number): Array<{ kind: string; json: string }> } | undefined

  isTeamSchedulerBanditEnabled?: () => boolean
  getSessionId?: () => string | undefined
}

function requireDelegate(coordinator: TeamOrchestrateCoordinator): Required<Pick<TeamOrchestrateCoordinator, 'delegate'>>['delegate'] {
  if (!coordinator.delegate) throw new Error('team_orchestrate review gate requires coordinator.delegate')
  return coordinator.delegate
}

const inputSchema = z.object({
  mode: z.enum(['standard', 'max']).default('standard'),
  objective: z.string().min(1),
  planPath: z.string().optional(),
  planMarkdown: z.string().optional(),
  /** UnifiedPlan JSON from plan_task output — bypasses Markdown parsing and max planner fanout. */
  planJson: z.string().optional(),
  maxParallel: z.number().int().min(1).max(5).optional(),
  fromWave: z.number().int().min(0).optional(),
})

export function formatTeamSummary(summary: TeamRunSummary, fromWave = 0): string {
  const lines: string[] = [
    `team ${summary.mode}: ${summary.dispatched} dispatched, ${summary.waves.length} waves, ${summary.blocked.length} blocked${summary.planCacheHit ? ' (plan cache hit — planner fanout skipped)' : ''}`,
  ]
  if (summary.waves.length > 0) {
    lines.push('Waves:')
    for (const w of summary.waves) lines.push(`  ${w.id} [${w.risk}] ${w.taskIds.join(', ')} — ${w.reason}`)
  }
  if (summary.blocked.length > 0) {
    lines.push('Blocked:')
    for (const b of summary.blocked) lines.push(`  - ${b}`)
  }
  const nextWave = fromWave + 1
  if (summary.waves.length > nextWave) {
    lines.push('', `To run the next wave after integrating this wave's diffs: call team_orchestrate again with fromWave: ${nextWave}.`)
  }
  lines.push('', summary.packet)
  return lines.join('\n')
}

export function createTeamOrchestrateTool(
  coordinator: TeamOrchestrateCoordinator,
  options?: { defaultMaxParallel?: number },
): Tool {
  return {
    definition: {
      name: 'team_orchestrate',
      description:
        'Run the deterministic team orchestrator: parse a plan (standard), group tasks into waves respecting file conflicts and dependencies, and dispatch the first ready wave of workers. Returns the wave schedule and dispatch summary. Does NOT auto-commit — the main controller integrates worker diffs.\n\nPass planJson (UnifiedPlan from plan_task) to skip Markdown/planner fanout and execute directly.',
      input_schema: {
        type: 'object',
        properties: {
          mode: { type: 'string', enum: ['standard', 'max'], description: 'standard: execute an existing plan. max: multi-perspective planning first.' },
          objective: { type: 'string', description: 'The mission statement.' },
          planPath: { type: 'string', description: 'Optional path to a Markdown plan inside the project (standard mode).' },
          planMarkdown: { type: 'string', description: 'Optional inline Markdown plan; takes precedence over planPath.' },
          planJson: { type: 'string', description: 'UnifiedPlan JSON from plan_task output. When provided, bypasses Markdown parsing and max planner fanout.' },
          maxParallel: { type: 'number', description: 'Max parallel workers per wave (1-5, default 3).' },
          fromWave: { type: 'number', description: 'Dispatch this zero-based wave index after integrating prior wave diffs.' },
        },
        required: ['objective'],
      },
    },
    async execute(params: ToolCallParams): Promise<ToolResult> {
      const parsed = inputSchema.safeParse(params.input)
      if (!parsed.success) return { content: `Invalid input: ${parsed.error.message}`, isError: true }
      const { mode, objective, planPath, planMarkdown, planJson, maxParallel, fromWave } = parsed.data

      // Pre-parsed tasks from plan_task UnifiedPlan JSON
      let tasks: ReturnType<typeof unifiedPlanToTeamTasks> | undefined
      if (planJson) {
        const plan = deserializeUnifiedPlan(planJson)
        if (!plan) return { content: 'team_orchestrate blocked: planJson is not a valid UnifiedPlan', isError: true }
        const validation = validateUnifiedPlan(plan)
        if (!validation.valid) {
          const errors = [...validation.errors, ...validation.nodeErrors.map(ne => `[${ne.nodeId}] ${ne.error}`)]
          return { content: `team_orchestrate blocked: plan validation failed:\n${errors.map(e => `  - ${e}`).join('\n')}`, isError: true }
        }
        tasks = unifiedPlanToTeamTasks(plan)
      }

      let markdown = planMarkdown
      if (!markdown && !tasks && planPath) {
        const safe = validatePathSafe(params.cwd, planPath)
        if (!safe.ok) return { content: `team_orchestrate blocked: ${safe.error}`, isError: true }
        try {
          markdown = readFileSync(safe.path, 'utf8')
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          return { content: `team_orchestrate blocked: cannot read planPath "${planPath}": ${msg}`, isError: true }
        }
      }

      // T9 P3 text stream + T4 structured per-worker updates (subagent panel).
      const textStreamer = params.onOutput ? createActivityStreamer(params.onOutput) : undefined
      const onActivity = (textStreamer || params.onWorkerActivity)
        ? (ev: WorkerActivityEvent) => {
            textStreamer?.(ev)
            params.onWorkerActivity?.({
              workOrderId: ev.workOrderId,
              parentToolId: params.toolUseId,
              profile: ev.profile,
              authority: ev.authority,
              status: 'running',
              progressLine: activityProgressLine(ev),
            })
          }
        : undefined

      let summary: TeamRunSummary
      let telemetryEvent: TeamWaveTelemetry | undefined
      try {
        summary = await runTeamSkeleton(
          {
            mode,
            objective,
            planMarkdown: markdown,
            tasks,
            maxParallel: maxParallel ?? options?.defaultMaxParallel,
            fromWave,
            parentTurnId: params.toolUseId,
            abortSignal: params.abortSignal,
            teamSchedulerBanditEnabled: coordinator.isTeamSchedulerBanditEnabled?.() === true,
            // T9 P3: live worker token/tool stream into the team tool card.
            onActivity,
            // Fleet viz: emit the wave/task DAG (all waiting) before dispatch so
            // the TUI shows the plan up front; the engine overlays running state
            // from live worker activity. Encoded as a dedicated stream chunk that
            // the engine intercepts (not accumulated → no double-decode at term).
            onPlanReady: params.onOutput
              ? (skeleton, wave) => {
                  params.onOutput!(`\n${encodeTeamPanelModel(buildTeamPanelModel(skeleton, wave))}\n`)
                }
              : undefined,
          },
          {
            delegateBatch: (requests, policy, abortSignal, onProgress) =>
              coordinator.delegateBatch(requests, policy, abortSignal, (completed, total) => {
                onProgress?.(completed, total)
                const done = Math.max(0, Math.min(completed, total))
                params.onOutput?.(`✦ team progress: ${done}/${total} workers done\n`)
              }),
            recordTeamWaveTelemetry: event => {
              telemetryEvent = event
              coordinator.recordTeamWaveTelemetry?.(event)
            },
            recordTeamSchedulerShadow: event => coordinator.recordTeamSchedulerShadow?.(event),
            recordGatedInfluenceAudit: event => {
              if (coordinator.recordGatedInfluenceAudit) {
                coordinator.recordGatedInfluenceAudit(event)
                return
              }
              const store = coordinator.getTeamSchedulerRewardStore?.()
              if (store?.saveBanditState) persistGatedInfluenceAudit({ saveBanditState: store.saveBanditState.bind(store) }, event)
            },
            teamSchedulerState: coordinator.getTeamSchedulerState?.() ?? buildHistoricalTeamSchedulerState(coordinator.getTeamSchedulerRewardStore?.()),
            sessionId: coordinator.getSessionId?.(),
            // Track 2: 计划骨架缓存与 reward 共用同一 append-only 存储。
            planCacheStore: coordinator.getTeamSchedulerRewardStore?.(),
          },
        )
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        return { content: `team_orchestrate failed: ${msg}`, isError: true }
      }

      // T4: terminal per-worker status for the subagent panel.
      if (params.onWorkerActivity && summary.run) {
        for (const r of summary.run.results) {
          params.onWorkerActivity({
            workOrderId: r.workOrderId,
            parentToolId: params.toolUseId,
            status: r.status,
            progressLine: r.summary.slice(0, 80),
          })
        }
      }

      let reviewNote = ''
      let deliverySynthesis = ''
      let reviewVerdict: string | undefined
      const effectiveFromWave = fromWave ?? 0
      const isLastWave = summary.waves.length > 0 && effectiveFromWave >= summary.waves.length - 1
      const changedFiles = summary.run
        ? [...new Set(summary.run.results.flatMap(result => result.changedFiles))]
        : []
      if (isLastWave && changedFiles.length > 0) {
        try {
          const delegate = requireDelegate(coordinator)
          const change: ChangeSet = {
            files: changedFiles,
            crossModule: isCrossModule(changedFiles),
            isFix: isFixContext(objective),
          }
          const reviewDeps = createCoordinatorReviewDeps(
            {
              delegate: (request, abortSignal) => delegate(request, abortSignal),
              delegateBatch: (requests, policy, abortSignal, onProgress) =>
                coordinator.delegateBatch(requests, policy, abortSignal, onProgress),
            },
            { reviewDepth: params.reviewDepth ?? 0, abortSignal: params.abortSignal, parentTurnId: `${params.toolUseId}:review` },
          )
          const outcome = await routeReviewWorkflow(change, reviewDeps, { maxRounds: 3 })
          reviewVerdict = outcome.verdict
          reviewNote = `\n\nReview gate [${outcome.tier}]: ${outcome.verdict}${outcome.evidence ? ` — ${outcome.evidence}` : ''}`
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          return { content: `team_orchestrate review gate failed: ${msg}`, isError: true }
        }
      }

      if (telemetryEvent) {
        const closedTelemetry = {
          ...telemetryEvent,
          outcome: {
            ...telemetryEvent.outcome,
            ...(reviewVerdict ? { reviewVerdict } : {}),
          },
        }
        try {
          coordinator.recordTeamWaveRewardClosure?.(closedTelemetry)
        } catch {
          // Reward closure must never affect team dispatch or review reporting.
        }
        try {
          coordinator.recordTeamSchedulerReward?.(closedTelemetry)
        } catch {
          // Scheduler reward must never affect team dispatch or review reporting.
        }
        // Track 2 episode 闭环：最后一波收尾时把本 objective 的全部 wave 片段
        // 聚合成 episode，落 episode 级 reward closure —— 这是晋升闸
        // (gated-influence-evaluation 的 reward_closure:team_episode: 前缀)
        // 一直在等的生产者。
        if (isLastWave) {
          try {
            recordTeamEpisodeClosureFromStore(coordinator.getTeamSchedulerRewardStore?.(), closedTelemetry)
          } catch {
            // Episode closure must never affect team dispatch or review reporting.
          }
          // 终局跨波交付综合（P2）：聚合全部 wave 片段成单一交付报告追加到返回。
          try {
            const episode = buildTeamEpisodeFromStore(coordinator.getTeamSchedulerRewardStore?.(), closedTelemetry)
            deliverySynthesis = `\n\n${formatTeamDelivery(episode)}`
          } catch {
            // Delivery synthesis is presentation-only; never block the wave result.
          }
        }
      }

      const panelModel = buildTeamPanelModel(summary, effectiveFromWave, reviewVerdict)
      return {
        content: formatTeamSummary(summary, effectiveFromWave) + reviewNote + deliverySynthesis,
        uiContent: encodeTeamPanelModel(panelModel),
        isError: false,
      }
    },
    requiresApproval: () => false,
    isConcurrencySafe: () => false,
    isEnabled: () => true,
    timeoutMs: () => 600_000,
  }
}
